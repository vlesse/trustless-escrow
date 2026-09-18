// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IEscrowArbitrator, IEscrowArbitrable} from "../interfaces/IEscrowArbitrator.sol";
import {SafeTransfer} from "../lib/SafeTransfer.sol";

/// @dev ERC-792 的仲裁方接口，按本仓库惯例内联声明而不是引包。
///      只声明本适配器真正会用到的那几个方法。
interface IKlerosArbitrator {
    function createDispute(uint256 choices, bytes calldata extraData)
        external
        payable
        returns (uint256 disputeID);

    function arbitrationCost(bytes calldata extraData) external view returns (uint256);
}

interface IDealRegistry {
    function isDeal(address) external view returns (bool);
}

/// @title KlerosAdapter
/// @notice 把 Kleros（ERC-792，以 ETH 计价）接成本协议的终局仲裁方（以 ERC20 计价）。
///
/// ## 为什么需要一个适配器而不是直接接
///
/// 两边的计价币种不同。本协议的所有资金流都在稳定币里，仲裁成本也必须以
/// 稳定币计价 —— 用 ETH 计价会给交易双方引入一个与这笔买卖毫无关系的价格风险：
/// 下单时说好的仲裁成本，到争议那天可能翻倍。
///
/// 所以本合约做两件事：对上以 ERC20 报价并收费，对下用自己的 ETH 余额
/// 替你付给 Kleros。中间的汇率风险由运营方承担，而不是由当事人承担。
///
/// ## ETH 用完了会怎样
///
/// **这是本合约唯一的活性风险，所以刻意做成任何人都能解除。**
/// 余额不够时 `createDispute` 会 revert，而它是被 `Escrow.raiseDispute()`
/// 调用的 —— 也就是说当事人会连争议都提不起来。这个错误本协议犯过两次
/// （陪审员池为空、案值上限拦在争议环节），不能再犯第三次。
///
/// 对策：`receive()` 对所有人开放，`ethShortfall()` 把还差多少直接读出来。
/// 想提争议的人自己补上这点 ETH 就能继续，不必等运营方。
///
/// ## 它不持有任何托管资金
///
/// 合约里只有两样东西：运营方充进来的 ETH，以及裁决落地后从托管合约
/// 收到的 ERC20 仲裁费。托管中的货款与保证金全程不经过这里。
contract KlerosAdapter is IEscrowArbitrator, IEscrowArbitrable {
    using SafeTransfer for address;

    IKlerosArbitrator public immutable kleros;

    /// @notice 交易注册表（工厂）。直接挂在托管合约下时用它校验来源。
    IDealRegistry public immutable registry;

    /// @notice Kleros 的子法庭与陪审员数量等参数，部署时按 Kleros 文档填入。
    /// @dev 不在合约里硬编码：读代码的人无从核对一串魔数对不对，而填错
    ///      会让每一次 createDispute 都失败。
    bytes public klerosExtraData;

    /// @notice 上层仲裁层（乐观层）。经它升级上来的争议由它发起。
    address public upstream;

    address public admin;

    /// @notice 对上的报价，按币种计价（ERC20）。
    mapping(address => uint256) public costOf;

    /// @notice Kleros 的 disputeID 直接当作本合约的 ID —— 同一个 Kleros
    ///         实例上 ID 唯一，不需要再维护一层映射。
    mapping(uint256 => address) public arbitrableOf;
    mapping(uint256 => uint8) public rulingOf;
    mapping(uint256 => bool) public ruled;

    event DisputeForwarded(uint256 indexed disputeID, address indexed arbitrable, uint256 ethPaid);
    event RulingReceived(uint256 indexed disputeID, uint8 ruling, bool delivered);
    event ToppedUp(address indexed from, uint256 amount);
    event UpstreamChanged(address indexed from, address indexed to);
    event AdminTransferred(address indexed from, address indexed to);
    event FeesSwept(address indexed token, address indexed to, uint256 amount);

    error NotAdmin();
    error NotKleros();
    error NotAllowedCaller();
    error BadRuling();
    error CostNotConfigured();
    error InsufficientEth();
    error AlreadyRuled();
    error ZeroAddress();
    error NothingToSweep();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(address _kleros, address _registry, bytes memory _extraData, address _admin) {
        if (_kleros == address(0) || _registry == address(0) || _admin == address(0)) revert ZeroAddress();
        kleros = IKlerosArbitrator(_kleros);
        registry = IDealRegistry(_registry);
        klerosExtraData = _extraData;
        admin = _admin;
    }

    /// @notice 任何人都可以充值。见合约顶部关于活性的说明。
    receive() external payable {
        emit ToppedUp(msg.sender, msg.value);
    }

    // -------------------------------------------------- IEscrowArbitrator

    /// @inheritdoc IEscrowArbitrator
    function arbitrationCost(address token, bytes calldata) external view returns (uint256) {
        return costOf[token];
    }

    /// @notice 当前 Kleros 那边要的 ETH，以及本合约还差多少。
    function klerosCostWei() public view returns (uint256) {
        return kleros.arbitrationCost(klerosExtraData);
    }

    function ethShortfall() external view returns (uint256) {
        uint256 need = klerosCostWei();
        uint256 have = address(this).balance;
        return need > have ? need - have : 0;
    }

    /// @inheritdoc IEscrowArbitrator
    /// @dev 准入限制是必须的，而且与陪审团那边的理由不同：那边一次争议只消耗
    ///      发起方自己的钱，这边每一次都要掏本合约的 ETH。不限制来源，
    ///      任何人都能靠反复发起争议把余额抽干，代价只有 gas。
    function createDispute(uint256 choices, bytes calldata) external returns (uint256 disputeID) {
        if (choices != 2) revert BadRuling();
        if (msg.sender != upstream && !registry.isDeal(msg.sender)) revert NotAllowedCaller();

        address token = IEscrowToken(msg.sender).token();
        if (costOf[token] == 0) revert CostNotConfigured();

        uint256 need = klerosCostWei();
        if (address(this).balance < need) revert InsufficientEth();

        disputeID = kleros.createDispute{value: need}(2, klerosExtraData);
        arbitrableOf[disputeID] = msg.sender;
        emit DisputeForwarded(disputeID, msg.sender, need);
    }

    /// @inheritdoc IEscrowArbitrator
    function currentRuling(uint256 disputeID) external view returns (uint256) {
        return rulingOf[disputeID];
    }

    // ------------------------------------------------------ ERC-792 回调

    /// @inheritdoc IEscrowArbitrable
    /// @notice Kleros 投递裁决。ERC-792 的 ruling 语义与本协议一致：
    ///         0 = 拒裁，1 = 买家胜，2 = 卖家胜。
    ///
    /// @dev 投递给上层用 try/catch 兜住，与陪审团那边同一个理由：
    ///      托管合约在 `resolveStaleDispute` 之后不再接受裁决，
    ///      不兜住的话 Kleros 那边会一直投递失败，这笔争议在它的账上永远不结。
    function rule(uint256 disputeID, uint256 ruling) external {
        if (msg.sender != address(kleros)) revert NotKleros();
        if (ruled[disputeID]) revert AlreadyRuled();
        if (ruling > 2) revert BadRuling();

        address arbitrable = arbitrableOf[disputeID];
        if (arbitrable == address(0)) revert NotAllowedCaller();

        ruled[disputeID] = true;
        rulingOf[disputeID] = uint8(ruling);

        bool delivered;
        try IEscrowArbitrable(arbitrable).rule(disputeID, ruling) {
            delivered = true;
        } catch {
            delivered = false;
        }
        emit RulingReceived(disputeID, uint8(ruling), delivered);
    }

    // -------------------------------------------------------------- 配置

    function setCost(address token, uint256 cost) external onlyAdmin {
        costOf[token] = cost;
    }

    function setUpstream(address a) external onlyAdmin {
        emit UpstreamChanged(upstream, a);
        upstream = a;
    }

    function transferAdmin(address a) external onlyAdmin {
        emit AdminTransferred(admin, a);
        admin = a;
    }

    /// @notice 归集收到的 ERC20 仲裁费。
    /// @dev 本合约不持有任何托管资金，所以这里没有「在途保证金」要隔离 ——
    ///      余额里全部都是已结案交易付过来的服务费。
    function sweep(address token, address to) external onlyAdmin returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        amount = SafeTransfer.balanceOf(token, address(this));
        if (amount == 0) revert NothingToSweep();
        token.safeTransfer(to, amount);
        emit FeesSwept(token, to, amount);
    }
}

interface IEscrowToken {
    function token() external view returns (address);
}
