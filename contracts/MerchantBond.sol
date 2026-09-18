// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {SafeTransfer} from "./lib/SafeTransfer.sol";

interface IDealRegistry {
    function isDeal(address) external view returns (bool);
}

interface IEscrowSellerSide {
    function seller() external view returns (address);
    function token() external view returns (address);
    function sellerBond() external view returns (uint256);
    function depositSeller() external;
}

/// @title MerchantBond
/// @notice 商家的预付额度池：把保证金一次性存进来，之后每开一单直接从里面扣。
///
/// ## 它解决的是什么，不解决什么
///
/// **不解决**「同时接了很多单会不会资不抵债」。那件事在本协议里已经由
/// **逐笔独立的保证金**解决了：每笔交易的卖家保证金存在它自己那个托管合约里，
/// 一笔出事不波及别笔。商家能同时接多少单，本来就被他的资金量卡着 ——
/// 在这之上再锁一笔共享的钱，不增加任何保障，只是把同一笔钱数了两遍。
///
/// 这里要说清楚一件容易想歪的事：**共享池反而更弱**。如果 N 笔订单共用
/// 一笔押金，「同时骗光所有在途订单」就成了最优策略 —— 骗 N 笔收益是 N 倍，
/// 损失还是那一笔押金，N 越大越划算。所以本合约刻意**不做**共享抵押，
/// 它只是个预付账户，钱最终还是逐笔进到各自的柜子里。
///
/// **解决**三件很实在的事：
///   1. 商家开一单从两笔交易（approve + depositSeller）降到一笔；
///   2. 额度是链上可读的，买家在下单之前就能看到「这商家还接得动几单」；
///   3. 余额不足就开不了单，而不是等到入金那一步才失败。
///
/// ## 它不持有任何别人的钱
///
/// 池子里只有商家自己存进来的余额，随时可以全额取回。合约没有 owner，
/// 没有暂停开关，也没有任何把 A 的余额动给 B 的路径。
/// 结算时保证金回的是**商家的钱包**（托管合约只认交易里写死的 seller），
/// 不是回到池子 —— 所以补额度是一个需要商家主动做的动作，这是刻意的：
/// 让「我现在还能接多少单」始终是他自己明确知道的一个数。
contract MerchantBond {
    using SafeTransfer for address;

    /// @notice 本池子的币种。一个池子只服务一种币，避免记账混淆。
    address public immutable token;

    /// @notice 交易注册表（工厂），用于校验目标确实是本协议发出的交易。
    IDealRegistry public immutable factory;

    /// @notice 商家的可用额度。
    mapping(address => uint256) public balanceOf;

    event Deposited(address indexed merchant, uint256 amount, uint256 balance);
    event Withdrawn(address indexed merchant, uint256 amount, uint256 balance);
    event DealFunded(address indexed merchant, address indexed deal, uint256 amount, uint256 balance);

    error ZeroAddress();
    error NotADeal();
    error NotSeller();
    error WrongToken();
    error InsufficientBalance();
    error Reentrancy();

    bool private _entered;

    modifier nonReentrant() {
        if (_entered) revert Reentrancy();
        _entered = true;
        _;
        _entered = false;
    }

    constructor(address _token, address _factory) {
        if (_token == address(0) || _factory == address(0)) revert ZeroAddress();
        token = _token;
        factory = IDealRegistry(_factory);
    }

    /// @notice 存入额度。
    function deposit(uint256 amount) external nonReentrant {
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 bal = balanceOf[msg.sender] + amount;
        balanceOf[msg.sender] = bal;
        emit Deposited(msg.sender, amount, bal);
    }

    /// @notice 取回额度。随时可全额取回，没有任何锁定期 ——
    ///         池子里的钱还没有承担任何义务，承担义务的是已经进到柜子里的那些。
    function withdraw(uint256 amount) external nonReentrant {
        uint256 bal = balanceOf[msg.sender];
        if (amount > bal) revert InsufficientBalance();
        bal -= amount;
        balanceOf[msg.sender] = bal;
        token.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount, bal);
    }

    /// @notice 用额度支付某笔交易的卖家保证金。
    ///
    /// @dev **只认卖家本人的指令。** 本合约在托管合约那边被登记为「代付方」，
    ///      有权代卖家入金；如果这里放开给任何人调用，别人就能拿商家的额度
    ///      把他塞进一笔他没同意的交易 —— 钱是商家的，信誉记录也是商家的。
    ///      所以代付权限在托管合约那侧收紧到一个地址，再由这里收紧到本人。
    function fundDeal(address deal) external nonReentrant {
        if (!factory.isDeal(deal)) revert NotADeal();

        IEscrowSellerSide e = IEscrowSellerSide(deal);
        if (e.seller() != msg.sender) revert NotSeller();
        if (e.token() != token) revert WrongToken();

        uint256 amount = e.sellerBond();
        uint256 bal = balanceOf[msg.sender];
        if (bal < amount) revert InsufficientBalance();
        balanceOf[msg.sender] = bal - amount;

        // 授权后立刻被托管合约全额取走，所以调用结束时额度必然回到 0 ——
        // 这正是 safeApprove 要求调用方保证的前提（见该函数的注释）。
        token.safeApprove(deal, amount);
        e.depositSeller();

        emit DealFunded(msg.sender, deal, amount, bal - amount);
    }

    /// @notice 还能支付多少笔 `bond` 这么大的保证金。前端用来显示「还接得动几单」。
    function ordersLeft(address merchant, uint256 bond) external view returns (uint256) {
        if (bond == 0) return type(uint256).max;
        return balanceOf[merchant] / bond;
    }
}
