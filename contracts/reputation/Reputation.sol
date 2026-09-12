// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Escrow} from "../Escrow.sol";

interface IEscrowFactoryView {
    function isDeal(address) external view returns (bool);
}

/// @title Reputation
/// @notice 每个地址的公开履约记录。只记事实，不打分。
///
/// ## 三个决定了整体形态的性质
///
/// **一、它是托管层的只读旁观者。**
/// 本合约不会被 `Escrow` 调用，`Escrow` 也完全不知道它存在。记录是**拉取式**的：
/// 交易结束后，任何人调用 `record(deal)`，本合约自己去读那笔交易的终局状态。
///
/// 这个方向很重要。反过来做（结算时由 Escrow 推送）意味着在持有资金的合约的
/// 结算路径上插入一个外部调用 —— 一旦这个调用 revert 或耗尽 gas，结算就会失败，
/// 用户的钱被锁死在里面。**一个统计功能永远不值得换来这种风险。**
/// 现在的形态下，本合约就算写错、被攻击、或者根本没人调用，
/// 托管层的资金安全一点也不受影响。
///
/// **二、它不持有任何资金。** 没有 `transfer`，没有 `payable`，没有余额。
/// 没有钱可偷，因此也不需要为它设计任何应急退出。
///
/// **三、记录是无许可的，因此无法被压制。**
/// 谁都可以推送一笔已结束交易的记录 —— 尤其是受害者可以推送关于骗子的那一条。
/// 骗子没有任何办法阻止自己的败诉记录上链：他不能拒绝调用，
/// 因为调用不需要他；他也不能删除，因为本合约没有删除功能。
///
/// ## 关于「打分」
///
/// 本合约刻意不输出任何评分、星级或等级。评分是**政策**，而政策会随着
/// 骗子的手法演化而需要修改 —— 把政策写进一个永不可变的合约是自找麻烦。
/// 这里只沉淀不可篡改的原始事实，怎么解读交给上层，上层可以随时换掉。
///
/// ## 声誉与隐私是互斥的，所以它必须是自愿的
///
/// 有声誉就意味着你所有的交易都被链接到同一个地址上，可以被任何人聚合分析。
/// 这和匿名是直接冲突的，不存在两全的办法。
/// 解决方式是**让用户自己选**：不想留记录就每次换地址，代价是对手方凭什么信你。
/// 协议不强制任何一边，也不因为你没有记录就拒绝你交易。
contract Reputation {
    /// @notice 交易真实性的唯一判据。immutable。
    /// @dev 不校验来源的话，任何人都能部署一个假的「托管合约」，
    ///      把自己的字段填成完美记录然后推上来。
    IEscrowFactoryView public immutable factory;

    struct Record {
        /// @notice 正常完成的笔数（确认收货 / 验收期届满）。
        uint32 completed;
        /// @notice 打过交道的**不同**对手方数量。
        /// @dev 这是识别刷单最有用的一个数：笔数 40、对手方 2，
        ///      说明这是两个地址在自己跟自己刷。
        uint32 counterparties;
        /// @notice 争议中被判获胜的笔数。
        uint32 disputesWon;
        /// @notice 争议中被判败诉的笔数 —— 保证金被罚没过。
        uint32 disputesLost;
        /// @notice 进过争议但未认定任何一方有过错（拒裁拆分 / 仲裁方超时失联）。
        uint32 disputesInconclusive;
        /// @notice 作为卖家逾期未交付、被买家取回的笔数。
        uint32 nonDelivery;
        /// @notice 最近一次被记录的时间。
        /// @dev 是**记录时间**不是成交时间 —— 记录是任何人事后推的，可能滞后。
        ///      要判断身份新旧请用 IdentityBond.ageOf()，那个是精确的。
        uint64 lastRecordedAt;
    }

    mapping(address => Record) private _records;

    /// @notice 累计成交额，按币种分开。
    /// @dev 不同币种不可加总，所以不做求和。
    mapping(address => mapping(address => uint256)) public volumeOf;

    /// @notice 该地址参与过的交易累计烧掉的手续费，按币种分开。
    ///
    /// @dev 注意口径：是「这些交易一共付了多少手续费给金库」，不是
    ///      「这个地址自己掏了多少」。手续费从卖家的货款里扣，但刷单的两个
    ///      地址通常是同一个人，分摊给谁没有意义。
    ///
    ///      它的用途只有一个：**伪造这份记录至少要花多少钱**。
    ///      手续费进的是不可变的金库，任何人烧的都是真钱，刷单者也不例外。
    ///      所以这个数字是对手方能拿到的、唯一一个有硬下界的成本量。
    mapping(address => mapping(address => uint256)) public feesBurnedOf;

    /// @notice 是否已经和某人打过交道 —— 用于对手方去重。
    mapping(address => mapping(address => bool)) public hasDealtWith;

    /// @notice 已记录的交易，保证幂等。
    mapping(address => bool) public recorded;

    event Recorded(
        address indexed deal, address indexed buyer, address indexed seller, Escrow.Outcome outcome, uint256 price
    );

    error NotADeal();
    error AlreadyRecorded();
    error NotSettled();
    error NothingHappened();
    error ZeroAddress();

    constructor(address _factory) {
        if (_factory == address(0)) revert ZeroAddress();
        factory = IEscrowFactoryView(_factory);
    }

    // ---------------------------------------------------------------- 写入

    /// @notice 把一笔已结束交易的结果沉淀成双方的记录。任何人都可以调用。
    function record(address deal) public {
        if (!factory.isDeal(deal)) revert NotADeal();
        if (recorded[deal]) revert AlreadyRecorded();

        Escrow e = Escrow(deal);
        Escrow.Outcome o = e.outcome();

        if (o == Escrow.Outcome.None) revert NotSettled();
        // 双方都还没入金就退出的交易不记录：它的创建成本接近零，
        // 记下来只会变成一个可以免费刷「交易笔数」的入口。
        if (o == Escrow.Outcome.CancelledUnfunded) revert NothingHappened();

        recorded[deal] = true;

        address buyer = e.buyer();
        address seller = e.seller();
        address token = e.token();
        uint256 price = e.price();

        Record storage rb = _records[buyer];
        Record storage rs = _records[seller];

        if (!hasDealtWith[buyer][seller]) {
            hasDealtWith[buyer][seller] = true;
            rb.counterparties += 1;
        }
        if (!hasDealtWith[seller][buyer]) {
            hasDealtWith[seller][buyer] = true;
            rs.counterparties += 1;
        }

        if (o == Escrow.Outcome.Completed) {
            rb.completed += 1;
            rs.completed += 1;
            _credit(buyer, seller, token, price, e.feeBps());
        } else if (o == Escrow.Outcome.NonDelivery) {
            // 卖家逾期未标记交付。这是一个无歧义的客观事实，不需要仲裁认定 ——
            // 对买家来说没有损失（原路退回），但对卖家来说是一次未履约。
            rs.nonDelivery += 1;
        } else if (o == Escrow.Outcome.DisputeBuyer) {
            rb.disputesWon += 1;
            rs.disputesLost += 1;
        } else if (o == Escrow.Outcome.DisputeSeller) {
            rs.disputesWon += 1;
            rb.disputesLost += 1;
            // 卖家胜诉这条路径是真的结算了的：货款照付、手续费照收。
            _credit(buyer, seller, token, price, e.feeBps());
        } else {
            // DisputeSplit（拒裁）与 DisputeStale（仲裁方失联超时）。
            // 两者都没有认定过错方，不能算在任何一方头上。
            rb.disputesInconclusive += 1;
            rs.disputesInconclusive += 1;
        }

        rb.lastRecordedAt = uint64(block.timestamp);
        rs.lastRecordedAt = uint64(block.timestamp);

        emit Recorded(deal, buyer, seller, o, price);
    }

    /// @notice 批量记录。单笔失败不会拖垮整批 —— 其中夹着一笔已记录或未结算的，
    ///         不应当让其余的都白跑一趟。
    function recordMany(address[] calldata deals) external {
        for (uint256 i = 0; i < deals.length; i++) {
            try this.record(deals[i]) {} catch {}
        }
    }

    function _credit(address buyer, address seller, address token, uint256 price, uint16 feeBps) private {
        // 与 Escrow 的算法保持一致（price * feeBps / 10_000）。
        uint256 fee = (price * feeBps) / 10_000;
        volumeOf[buyer][token] += price;
        volumeOf[seller][token] += price;
        feesBurnedOf[buyer][token] += fee;
        feesBurnedOf[seller][token] += fee;
    }

    // ---------------------------------------------------------------- 只读

    function recordOf(address who) external view returns (Record memory) {
        return _records[who];
    }

    /// @notice 一次性读完上层需要的全部原始数字。
    /// @dev 前端逐个 getter 读要发七八个 RPC 请求，而这些数字必须一起看才有意义。
    function statsOf(address who, address token)
        external
        view
        returns (Record memory record_, uint256 volume, uint256 feesBurned)
    {
        return (_records[who], volumeOf[who][token], feesBurnedOf[who][token]);
    }
}
