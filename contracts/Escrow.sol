// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IEscrowArbitrator, IEscrowArbitrable} from "./interfaces/IEscrowArbitrator.sol";
import {SafeTransfer} from "./lib/SafeTransfer.sol";

/// @title Escrow
/// @notice 单笔交易的非托管资金托管状态机。由 EscrowFactory 以 EIP-1167 克隆部署，
///         每笔交易一个独立实例。
///
/// 本合约刻意不具备以下能力，且永远不会具备（这是整个协议的全部意义）：
///   - 没有 owner / admin / governance 角色
///   - 没有 pause / freeze / emergencyWithdraw
///   - 不可升级（无 proxy admin，克隆的实现地址在工厂里是 immutable）
///   - 平台方地址只能收取上限封顶的手续费，且只能在交易正常完成时收取；
///     争议、取消、超时等任何非正常路径，平台方一分钱都拿不到
///
/// 资金在任何时刻只可能流向：买家、卖家、仲裁方（仅争议成本）、手续费金库。
/// 不存在第五个出口。
contract Escrow is IEscrowArbitrable {
    using SafeTransfer for address;

    // ---------------------------------------------------------------- 常量

    /// @notice 手续费硬上限 1%。写死在实现合约里，工厂无法突破。
    uint16 public constant MAX_FEE_BPS = 100;

    /// @notice 仲裁方失联保护：争议提起后超过此时限仍无裁决，
    ///         任何人可触发中性拆分，资金不会永久锁死。
    ///
    /// @dev 这个数字必须**大于整条仲裁链路走满所有窗口的最坏耗时**，
    ///      否则一个正常推进、只是走到了第三轮上诉的案件会被这里提前打断，
    ///      改判平局 —— 兜底机制把正常流程打死，比没有兜底更糟。
    ///      最坏耗时 = 乐观层提案 72h + 挑战 48h
    ///              + 陪审团 3 轮 x（提交 3d + 揭示 2d）+ 2 个上诉窗口 x 2d
    ///              + 最后一轮彻底卡死时的 ROUND_TIMEOUT 10d。
    ///      45 天在此之上留了余量。缩短任何一个窗口之前，先重算这条式子。
    uint64 public constant DISPUTE_TIMEOUT = 45 days;

    uint256 private constant RULING_REFUSED = 0;
    uint256 private constant RULING_BUYER = 1;
    uint256 private constant RULING_SELLER = 2;

    // ---------------------------------------------------------------- 类型

    enum State {
        None,       // 未初始化
        Open,       // 已创建，等待双方入金（任一方可无损退出）
        Funded,     // 双方资金已锁定，交付计时中
        Delivered,  // 卖家已标记交付，验收计时中
        Disputed,   // 争议中，等待裁决
        Resolved,   // 终态：已结算
        Cancelled   // 终态：未成交，原路退回
    }

    /// @notice 终局原因。
    ///
    /// State 只说明「结束了」，说不清「为什么结束」：Cancelled 既可能是双方
    /// 都还没入金时的无损退出，也可能是卖家逾期未交付被买家取回 —— 这两件事
    /// 对卖家的含义天差地别。Resolved 同理，正常收货与仲裁败诉都是 Resolved。
    ///
    /// 这个区别此前只存在于事件日志里。日志无法被其它合约读取，也就意味着
    /// 任何链上的声誉/统计层都无从判断一笔交易到底是怎么结束的。
    ///
    /// @dev 与 state / buyerFunded / sellerFunded / 三个 deadline 打包在同一个
    ///      存储槽内（27 + 1 = 28 字节），而终态写入必定与 `state` 的写入同处
    ///      一笔交易，因此这个字段的成本实际为零。
    enum Outcome {
        None,               // 未结束
        CancelledUnfunded,  // 未完全入金时退出 —— 无人有过错
        NonDelivery,        // 卖家逾期未标记交付，买家取回
        Completed,          // 正常完成（确认收货 / 验收期届满）
        DisputeBuyer,       // 争议：买家胜（卖家保证金被罚没）
        DisputeSeller,      // 争议：卖家胜（买家保证金被罚没）
        DisputeSplit,       // 争议：拒裁，中性拆分 —— 未认定任何一方有过错
        DisputeStale        // 争议：仲裁方失联超时 —— 过错在仲裁层，不在双方
    }

    // ------------------------------------------------------------ 交易条款
    // 全部在 initialize 时一次性写入，此后永不可变。
    // 尤其注意 arbitrator / feeBps / feeVault 是逐笔快照的：
    // 工厂事后更换默认仲裁人或费率，不影响任何已存在的交易。

    address public token;
    address public buyer;
    address public seller;
    address public feeVault;
    address public arbitrator;

    uint256 public price;
    uint256 public buyerBond;
    uint256 public sellerBond;

    uint64 public deliveryWindow;
    uint64 public inspectionWindow;
    uint16 public feeBps;

    /// @notice 链下条款全文的哈希（商品描述、交付定义、验收标准）。
    ///         争议时这是仲裁方判断「约定是什么」的唯一权威依据。
    bytes32 public termsHash;

    // ---------------------------------------------------------------- 状态

    State public state;
    Outcome public outcome;
    bool public buyerFunded;
    bool public sellerFunded;

    uint64 public deliveryDeadline;
    uint64 public inspectionDeadline;
    uint64 public disputeRaisedAt;

    /// @notice 在资金锁定那一刻快照的仲裁成本。
    /// @dev 锁定而非争议时实时读取，是为了防止仲裁方在交易进行中抬高报价，
    ///      吞掉双方的保证金。双方保证金在入金时即被校验 >= 此值。
    uint256 public lockedArbCost;

    uint256 public disputeID;
    bool private _entered;

    // ---------------------------------------------------------------- 事件

    event Initialized(
        address indexed buyer,
        address indexed seller,
        address token,
        uint256 price,
        uint256 buyerBond,
        uint256 sellerBond,
        uint16 feeBps,
        address arbitrator,
        bytes32 termsHash
    );
    event Deposited(address indexed party, uint256 amount);
    event Activated(uint64 deliveryDeadline, uint256 lockedArbCost);
    event DeliveryMarked(address indexed seller, string evidenceURI, uint64 inspectionDeadline);
    event DisputeRaised(address indexed by, uint256 indexed disputeID, string evidenceURI);
    event Evidence(address indexed by, string evidenceURI);
    event Ruled(uint256 indexed disputeID, uint256 ruling);
    event Settled(State finalState, uint256 toBuyer, uint256 toSeller, uint256 toArbitrator, uint256 fee);

    // ---------------------------------------------------------------- 错误

    error AlreadyInitialized();
    error BadState();
    error NotParty();
    error NotArbitrator();
    error TooEarly();
    error FeeTooHigh();
    error BondBelowArbitrationCost();
    error ZeroAddress();
    error Reentrancy();
    error AlreadyFunded();
    error UnknownDispute();

    // -------------------------------------------------------------- 修饰符

    modifier nonReentrant() {
        if (_entered) revert Reentrancy();
        _entered = true;
        _;
        _entered = false;
    }

    // ------------------------------------------------------------- 初始化

    struct Terms {
        address token;
        address buyer;
        address seller;
        address feeVault;
        address arbitrator;
        uint256 price;
        uint256 buyerBond;
        uint256 sellerBond;
        uint64 deliveryWindow;
        uint64 inspectionWindow;
        uint16 feeBps;
        bytes32 termsHash;
    }

    /// @notice 由工厂在克隆后立即调用，仅能成功一次。
    function initialize(Terms calldata t) external {
        if (state != State.None) revert AlreadyInitialized();
        if (t.token == address(0) || t.buyer == address(0) || t.seller == address(0)) revert ZeroAddress();
        if (t.arbitrator == address(0) || t.feeVault == address(0)) revert ZeroAddress();
        if (t.feeBps > MAX_FEE_BPS) revert FeeTooHigh();

        token = t.token;
        buyer = t.buyer;
        seller = t.seller;
        feeVault = t.feeVault;
        arbitrator = t.arbitrator;
        price = t.price;
        buyerBond = t.buyerBond;
        sellerBond = t.sellerBond;
        deliveryWindow = t.deliveryWindow;
        inspectionWindow = t.inspectionWindow;
        feeBps = t.feeBps;
        termsHash = t.termsHash;

        state = State.Open;

        emit Initialized(
            t.buyer, t.seller, t.token, t.price, t.buyerBond, t.sellerBond, t.feeBps, t.arbitrator, t.termsHash
        );
    }

    // ---------------------------------------------------------------- 入金
    // 关键反 DoS 属性：在双方都主动入金之前，没有任何一方的资金被锁定。
    // 单方无法通过「关联对方地址」来冻结对方的钱 —— 这是原始构想里的一个
    // 免费敲诈攻击面，此处从机制上消除。

    function depositSeller() external nonReentrant {
        if (state != State.Open) revert BadState();
        if (msg.sender != seller) revert NotParty();
        if (sellerFunded) revert AlreadyFunded();
        sellerFunded = true;
        token.safeTransferFrom(msg.sender, address(this), sellerBond);
        emit Deposited(msg.sender, sellerBond);
        _tryActivate();
    }

    function depositBuyer() external nonReentrant {
        if (state != State.Open) revert BadState();
        if (msg.sender != buyer) revert NotParty();
        if (buyerFunded) revert AlreadyFunded();
        buyerFunded = true;
        token.safeTransferFrom(msg.sender, address(this), price + buyerBond);
        emit Deposited(msg.sender, price + buyerBond);
        _tryActivate();
    }

    function _tryActivate() private {
        if (!(buyerFunded && sellerFunded)) return;

        uint256 cost = IEscrowArbitrator(arbitrator).arbitrationCost(token, "");
        // 双方保证金都必须能覆盖仲裁成本，否则败诉方无力承担裁决费用，
        // 结算数学会下溢。这个校验放在此处（而非 initialize），
        // 是因为它必须与「成本快照」在同一时刻发生。
        if (buyerBond < cost || sellerBond < cost) revert BondBelowArbitrationCost();

        lockedArbCost = cost;
        state = State.Funded;
        deliveryDeadline = uint64(block.timestamp) + deliveryWindow;
        emit Activated(deliveryDeadline, cost);
    }

    /// @notice 未完全入金前，任一方可随时取消，已入金部分原路退回。
    function cancelUnfunded() external nonReentrant {
        if (state != State.Open) revert BadState();
        if (msg.sender != buyer && msg.sender != seller) revert NotParty();
        state = State.Cancelled;
        outcome = Outcome.CancelledUnfunded;

        uint256 toBuyer = buyerFunded ? price + buyerBond : 0;
        uint256 toSeller = sellerFunded ? sellerBond : 0;
        _payout(toBuyer, toSeller, 0, 0);
    }

    // ---------------------------------------------------------------- 履约

    function markDelivered(string calldata evidenceURI) external {
        if (state != State.Funded) revert BadState();
        if (msg.sender != seller) revert NotParty();
        state = State.Delivered;
        inspectionDeadline = uint64(block.timestamp) + inspectionWindow;
        emit DeliveryMarked(msg.sender, evidenceURI, inspectionDeadline);
    }

    /// @notice 买家确认收货。Funded 或 Delivered 状态均可，买家随时可以主动放行。
    function confirmReceipt() external nonReentrant {
        if (state != State.Funded && state != State.Delivered) revert BadState();
        if (msg.sender != buyer) revert NotParty();
        _settleToSeller();
    }

    /// @notice 验收期届满且买家无异议，任何人可推动结算给卖家。
    function settleAfterInspection() external nonReentrant {
        if (state != State.Delivered) revert BadState();
        if (block.timestamp < inspectionDeadline) revert TooEarly();
        _settleToSeller();
    }

    /// @notice 交付期届满卖家仍未标记交付，买家取回全款与自己的保证金。
    /// @dev 无过错取消：卖家保证金原额退回，平台不收费。
    ///      「未标记交付」是一个无歧义的客观事实，不需要仲裁介入；
    ///      若买家认为还存在额外损失，应改走 raiseDispute。
    function claimNonDelivery() external nonReentrant {
        if (state != State.Funded) revert BadState();
        if (msg.sender != buyer) revert NotParty();
        if (block.timestamp < deliveryDeadline) revert TooEarly();
        state = State.Cancelled;
        outcome = Outcome.NonDelivery;
        _payout(price + buyerBond, sellerBond, 0, 0);
    }

    // ---------------------------------------------------------------- 争议

    /// @notice 提起争议。买家可在验收期内提起；卖家可在交付期届满后提起
    ///         （用于对抗即将发生的 claimNonDelivery，例如已实际交付但未能及时标记）。
    function raiseDispute(string calldata evidenceURI) external nonReentrant {
        bool buyerMayDispute = state == State.Delivered && block.timestamp < inspectionDeadline && msg.sender == buyer;
        bool sellerMayDispute = state == State.Funded && block.timestamp >= deliveryDeadline && msg.sender == seller;
        if (!buyerMayDispute && !sellerMayDispute) revert BadState();

        state = State.Disputed;
        disputeRaisedAt = uint64(block.timestamp);
        disputeID = IEscrowArbitrator(arbitrator).createDispute(2, "");
        emit DisputeRaised(msg.sender, disputeID, evidenceURI);
    }

    /// @notice 争议期内双方可持续提交证据。仅记录事件，由链下索引与仲裁方读取。
    function submitEvidence(string calldata evidenceURI) external {
        if (state != State.Disputed) revert BadState();
        if (msg.sender != buyer && msg.sender != seller) revert NotParty();
        emit Evidence(msg.sender, evidenceURI);
    }

    /// @inheritdoc IEscrowArbitrable
    function rule(uint256 _disputeID, uint256 _ruling) external nonReentrant {
        if (msg.sender != arbitrator) revert NotArbitrator();
        if (state != State.Disputed) revert BadState();
        if (_disputeID != disputeID) revert UnknownDispute();

        emit Ruled(_disputeID, _ruling);

        uint256 cost = lockedArbCost;
        uint256 fee_ = (price * feeBps) / 10_000;

        state = State.Resolved;

        if (_ruling == RULING_BUYER) {
            // 卖家违约：卖家保证金先支付仲裁成本，余额罚没给买家。
            // 卖家作恶的成本因此为「全部保证金」，而不是原始构想里的零成本。
            outcome = Outcome.DisputeBuyer;
            _payout(price + buyerBond + (sellerBond - cost), 0, cost, 0);
        } else if (_ruling == RULING_SELLER) {
            // 买家恶意申诉：买家保证金先支付仲裁成本，余额罚没给卖家。
            // 对称设计 —— 否则「谎称未收到货」会变成一个免费的攻击面。
            outcome = Outcome.DisputeSeller;
            _payout(0, price - fee_ + sellerBond + (buyerBond - cost), cost, fee_);
        } else {
            // 拒裁 / 平局：中性拆分，仲裁成本双方均摊，平台不收费。
            outcome = Outcome.DisputeSplit;
            _payout(price + buyerBond - cost / 2, sellerBond - (cost - cost / 2), cost, 0);
        }
    }

    /// @notice 仲裁方失联保护。争议提起满 DISPUTE_TIMEOUT 仍无裁决，
    ///         任何人可触发中性拆分，且不向失职的仲裁方支付任何成本。
    ///         资金不会因为仲裁层故障而永久锁死。
    function resolveStaleDispute() external nonReentrant {
        if (state != State.Disputed) revert BadState();
        if (block.timestamp < uint256(disputeRaisedAt) + DISPUTE_TIMEOUT) revert TooEarly();
        state = State.Resolved;
        outcome = Outcome.DisputeStale;
        _payout(price + buyerBond, sellerBond, 0, 0);
    }

    // ---------------------------------------------------------------- 内部

    function _settleToSeller() private {
        uint256 fee_ = (price * feeBps) / 10_000;
        state = State.Resolved;
        outcome = Outcome.Completed;
        _payout(buyerBond, price - fee_ + sellerBond, 0, fee_);
    }

    /// @dev 唯一的出金函数。状态已在调用前置为终态，转账在最后发生
    ///      （checks-effects-interactions），叠加 nonReentrant 双重保险。
    function _payout(uint256 toBuyer, uint256 toSeller, uint256 toArbitrator, uint256 fee_) private {
        address t = token;
        if (toBuyer > 0) t.safeTransfer(buyer, toBuyer);
        if (toSeller > 0) t.safeTransfer(seller, toSeller);
        if (toArbitrator > 0) t.safeTransfer(arbitrator, toArbitrator);
        if (fee_ > 0) t.safeTransfer(feeVault, fee_);
        emit Settled(state, toBuyer, toSeller, toArbitrator, fee_);
    }

    // ---------------------------------------------------------------- 只读

    /// @notice 供前端与审计者一次性读取全部状态。
    function summary()
        external
        view
        returns (State s, uint256 locked, uint64 dDeadline, uint64 iDeadline, bool bFunded, bool sFunded)
    {
        return (
            state,
            SafeTransfer.balanceOf(token, address(this)),
            deliveryDeadline,
            inspectionDeadline,
            buyerFunded,
            sellerFunded
        );
    }
}
