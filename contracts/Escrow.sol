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
        DisputeStale,       // 争议：仲裁方失联超时 —— 过错在仲裁层，不在双方
        Agreed              // 双方协商一致，按约定的分法结算 —— 不认定过错
        // 注意：一方「认输」不单列，记为 DisputeBuyer / DisputeSeller。
        // 认输就是承认自己错了，和被判输是同一个事实，不能让它比被判输更体面，
        // 否则「眼看要输就抢先认输」会成为洗白败诉记录的办法。
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

    /// @notice 唯一被允许代卖家支付保证金的地址，创建时写死，此后不可更改。
    ///
    /// @dev 为什么不干脆放开「谁都可以代付」：代付会让第三方把一个卖家
    ///      硬塞进一笔他没同意的交易里。钱不是他出的，判输了他也不亏，
    ///      但**信誉层会记下一笔未交付**。花点钱给竞争对手刷差评，
    ///      这条路必须堵死。所以代付方是逐笔写死的一个地址，
    ///      而那个地址（商家额度池）自己只认卖家本人的指令。
    address public bondPayer;

    /// @notice 唯一被允许代买家付款的地址，创建时写死。0 表示只有买家本人能付。
    ///
    /// @dev 店铺模式要「买家点一下就下单」：开单和付款必须在同一笔交易里完成，
    ///      而那时托管合约还不存在，买家没法事先授权给它。所以由店铺（商家账户合约）
    ///      先从买家那里收钱、再代他入金。
    ///
    ///      和 bondPayer 一样只能**往里付**，拿不走任何东西：退款、结算永远只付给
    ///      交易里写死的 buyer。也和 bondPayer 一样不能随便设 —— 否则第三方可以替
    ///      一个毫不知情的地址开单付款，再用卖家一方的争议给他刷出一条败诉记录。
    ///      所以工厂只允许商家账户合约设置它，而那个合约只替**亲自调用下单的人**付款。
    address public buyerPayer;

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

    /// @notice 当前挂着的和解提议：谁提的，以及提议里买家拿多少（其余归卖家）。
    /// @dev 只存一份。任一方再提一次就覆盖；对方只能接受「此刻挂着的这一份」，
    ///      而且接受时必须把金额原样带上 —— 见 acceptSettlement。
    address public offerBy;
    uint256 public offerToBuyer;

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
    event Conceded(address indexed by);
    event SettlementOffered(address indexed by, uint256 toBuyer);
    event SettlementOfferCleared(address indexed by);

    // ---------------------------------------------------------------- 错误

    error AlreadyInitialized();
    error BadState();
    error NotParty();
    error NotArbitrator();
    error TooEarly();
    error TooLate();
    error FeeTooHigh();
    error BondBelowArbitrationCost();
    error ArbitrationUnconfigured();
    error ZeroAddress();
    error Reentrancy();
    error AlreadyFunded();
    error UnknownDispute();
    error NoMatchingOffer();
    error AmountTooLarge();

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
        address bondPayer;
        address buyerPayer;
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
        bondPayer = t.bondPayer;
        buyerPayer = t.buyerPayer;
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

    /// @dev 卖家本人，或创建时指定的代付方（商家额度池）。两者之外一律拒绝。
    function depositSeller() external nonReentrant {
        if (state != State.Open) revert BadState();
        if (msg.sender != seller && msg.sender != bondPayer) revert NotParty();
        if (sellerFunded) revert AlreadyFunded();
        sellerFunded = true;
        token.safeTransferFrom(msg.sender, address(this), sellerBond);
        emit Deposited(msg.sender, sellerBond);
        _tryActivate();
    }

    /// @dev 买家本人，或创建时指定的代付方（店铺）。两者之外一律拒绝。
    function depositBuyer() external nonReentrant {
        if (state != State.Open) revert BadState();
        if (msg.sender != buyer && msg.sender != buyerPayer) revert NotParty();
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
        //
        // cost == 0 不能当成「免费仲裁」。乐观层 / 陪审团在 costOf[token]==0
        // 时会拒绝 createDispute，那时交易已经锁在 Funded/Delivered，
        // 买家既提不了争议，45 天兜底也永远不会开火，只剩把货款给卖家。
        if (cost == 0) revert ArbitrationUnconfigured();
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
        // 交付期过后只能走 raiseDispute 对抗 claimNonDelivery。
        // 若此处仍放行，恶意卖家可以盯着买家的退款交易抢先标记，
        // 把「无过错全额退款」改成强制争议，甚至在 inspectionWindow==0
        // 时同一区块内直接 settleAfterInspection 放款。
        if (block.timestamp >= deliveryDeadline) revert TooLate();
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
    ///      「未标记交付」是一个无歧义的客观事实，不需要仲裁介入。
    ///
    ///      注意买家**没有**别的选择：raiseDispute 要求状态为 Delivered，
    ///      而这里状态是 Funded，买家调它会 revert。也就是说本协议不处理
    ///      「因未交付而产生的额外损失」，只负责把钱原样退回。
    ///      （此处原先的注释写着「应改走 raiseDispute」—— 那条路不存在。）
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
        // 争议一开，可分配的钱就少了一份仲裁费。争议前谈的分法是按「不付仲裁费」
        // 算的，原样留着会让接受的一方拿到一个对方从没同意过的数字。作废，重谈。
        _clearOffer();
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
        _applyRuling(_ruling);
    }

    // ------------------------------------------------------------ 认输与和解
    //
    // 仲裁最快两天，走到陪审团至少一周。钱在这段时间里谁都动不了 —— 对大额交易，
    // 这比仲裁结果本身还伤人。而现实里大多数纠纷最后是谈出来的，或者一方自知理亏。
    // 原来的合约里这两条路都不存在：双方就算已经谈妥，也只能干等仲裁走完。
    //
    // 两条出口都**照付仲裁费**（争议中的话）。托管合约不知道仲裁层已经做了多少事，
    // 而仲裁层一旦受理就会把流程走完（陪审员照样投票、照样要拿报酬）。
    // 仲裁层回调 rule() 时这里已是终态，会 revert —— 乐观层、Kleros 适配器都已经
    // 用 try/catch 接住，押金照常按裁决结算，不会有任何一方的钱被锁死。
    // 省下的是时间，不是仲裁费。要不付仲裁费，就在起争议之前谈好。

    /// @notice 认输：按对方胜诉结算，与被仲裁判输完全相同。
    /// @dev 只会损害调用者自己，所以不需要任何对方同意、也不需要等待。
    function concede() external nonReentrant {
        if (state != State.Disputed) revert BadState();
        if (msg.sender != buyer && msg.sender != seller) revert NotParty();
        emit Conceded(msg.sender);
        _applyRuling(msg.sender == buyer ? RULING_SELLER : RULING_BUYER);
    }

    /// @notice 提出一个和解分法：买家拿 toBuyer，其余归卖家（卖家那份按比例扣手续费）。
    /// @dev 交付前、验收中、争议中都可以谈。再提一次会覆盖上一份。
    function offerSettlement(uint256 toBuyer) external {
        if (state != State.Funded && state != State.Delivered && state != State.Disputed) revert BadState();
        if (msg.sender != buyer && msg.sender != seller) revert NotParty();
        if (toBuyer > _distributable()) revert AmountTooLarge();
        offerBy = msg.sender;
        offerToBuyer = toBuyer;
        emit SettlementOffered(msg.sender, toBuyer);
    }

    /// @notice 撤回自己挂着的提议。
    function cancelSettlementOffer() external {
        if (offerBy == address(0) || msg.sender != offerBy) revert NotParty();
        _clearOffer();
    }

    /// @notice 接受对方的提议，立即结算。
    /// @param toBuyer 必须与对方挂着的那份**一字不差**。
    /// @dev 让接受方把金额原样带上，是为了防一种抢跑：提议方看到接受交易进了内存池，
    ///      抢先把提议改成对自己更有利的数字。带上金额之后，改过的提议对不上，
    ///      接受交易直接失败 —— 签名的人签下的永远是他看到的那个数。
    function acceptSettlement(uint256 toBuyer) external nonReentrant {
        if (state != State.Funded && state != State.Delivered && state != State.Disputed) revert BadState();
        if (msg.sender != buyer && msg.sender != seller) revert NotParty();
        address by = offerBy;
        if (by == address(0) || by == msg.sender || toBuyer != offerToBuyer) revert NoMatchingOffer();

        uint256 pool = _distributable();
        uint256 cost = state == State.Disputed ? lockedArbCost : 0;
        uint256 toSellerGross = pool - toBuyer;
        uint256 fee_ = _agreedFee(toSellerGross);

        offerBy = address(0);
        offerToBuyer = 0;
        state = State.Resolved;
        outcome = Outcome.Agreed;
        _payout(toBuyer, toSellerGross - fee_, cost, fee_);
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

    /// @dev 一次裁决（或认输）的资金分配。认输与被判输走的是同一段代码 ——
    ///      两条路径算出来的钱只要有一个 wei 不同，就会有人专挑划算的那条走。
    function _applyRuling(uint256 _ruling) private {
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

    /// @dev 和解时双方能分的总额。争议中要先留出仲裁费。
    function _distributable() private view returns (uint256) {
        uint256 total = price + buyerBond + sellerBond;
        return state == State.Disputed ? total - lockedArbCost : total;
    }

    /// @dev 和解的手续费：只对卖家「押金以外、实际从买家那里拿到的钱」收，最多收到货款那么多。
    ///
    ///      口径与整个协议一致：手续费当且仅当卖家真的拿到货款时产生，而且按拿到多少算。
    ///      - 卖家只拿回自己的押金（等于全额退款）→ 不收
    ///      - 卖家拿到全部货款 → 与正常成交收得一样多
    ///      不能干脆不收：大额交易的 1% 可能远高于仲裁费，那样「先起争议再和解」
    ///      就成了逃手续费的办法。也不能多收：平台不能从纠纷里比正常成交赚得更多。
    function _agreedFee(uint256 toSellerGross) private view returns (uint256) {
        uint256 gain = toSellerGross > sellerBond ? toSellerGross - sellerBond : 0;
        if (gain > price) gain = price;
        return (gain * feeBps) / 10_000;
    }

    function _clearOffer() private {
        address by = offerBy;
        if (by == address(0)) return;
        offerBy = address(0);
        offerToBuyer = 0;
        emit SettlementOfferCleared(by);
    }

    function _settleToSeller() private {
        uint256 fee_ = (price * feeBps) / 10_000;
        state = State.Resolved;
        outcome = Outcome.Completed;
        _payout(buyerBond, price - fee_ + sellerBond, 0, fee_);
    }

    /// @dev 唯一的出金函数。状态已在调用前置为终态，转账在最后发生
    ///      （checks-effects-interactions），叠加 nonReentrant 双重保险。
    function _payout(uint256 toBuyer, uint256 toSeller, uint256 toArbitrator, uint256 fee_) private {
        // 所有终态都从这里出去，所以在这里清掉没用上的和解提议 ——
        // 交易都结束了还挂着一份「待接受」，前端会把它当真。
        _clearOffer();
        address t = token;
        if (toBuyer > 0) t.safeTransfer(buyer, toBuyer);
        if (toSeller > 0) t.safeTransfer(seller, toSeller);
        if (toArbitrator > 0) t.safeTransfer(arbitrator, toArbitrator);
        if (fee_ > 0) t.safeTransfer(feeVault, fee_);
        emit Settled(state, toBuyer, toSeller, toArbitrator, fee_);
    }

    // ---------------------------------------------------------------- 只读

    /// @notice 本笔交易中「可以被裁决改变归属」的总额。
    ///
    /// @dev 三笔钱：货款、买家押金、卖家押金。裁决无论判成哪一种，
    ///      都是在这三笔之间重新分配，所以这就是一个被买通的裁决
    ///      最多能挪动的金额。仲裁层拿它来判断自己扛不扛得住这个案子。
    function disputeValue() public view returns (uint256) {
        return price + buyerBond + sellerBond;
    }

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
