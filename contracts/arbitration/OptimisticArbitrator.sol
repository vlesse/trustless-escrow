// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IEscrowArbitrator, IEscrowArbitrable} from "../interfaces/IEscrowArbitrator.sol";
import {SafeTransfer} from "../lib/SafeTransfer.sol";

interface IEscrowView {
    function token() external view returns (address);
}

interface IDealRegistry {
    function isDeal(address) external view returns (bool);
}

/// @title OptimisticArbitrator
/// @notice 两级「乐观仲裁」：AI 预审出默认裁决，可被任何人质押挑战，
///         挑战则升级到终局仲裁方（人类质押陪审团 / Kleros adapter）。
///
/// 这一层的存在，是为了解决「自动化机器人判案」的根本缺陷：
/// 机器人本身是单点，谁控制它谁就控制所有资金流向。
///
/// 本合约的做法是把机器人降级为「提案人」而非「法官」：
///
///   - proposer（AI）只能提出一个默认裁决，并且必须为此质押保证金；
///   - 在 CHALLENGE_WINDOW 内，任何人（不限于当事双方）都可以质押等额保证金挑战；
///   - 无人挑战 → 默认裁决生效（95% 的明显案件走这条路，快且几乎零成本）；
///   - 被挑战 → 案件升级到 finalArbitrator，机器人的意见不再有任何效力；
///   - 错的一方（无论是机器人还是挑战者）保证金被罚没给对方。
///
/// 由此，机器人作恶或犯错的成本是真金白银，而且它的错误结论
/// 可以被任何一个旁观者用保证金推翻 —— 它不再是单点。
///
/// 另外注意 createDispute 的准入限制：只有注册表（工厂）认可的托管实例
/// 才能发起争议，否则任意合约都能把裁决回调投递到任意地址。
contract OptimisticArbitrator is IEscrowArbitrator, IEscrowArbitrable {
    using SafeTransfer for address;

    /// @notice 挑战窗口。窗口越长越安全（给旁观者时间发现错判），
    ///         但会拖慢正常结算。48 小时是速度与安全的折中。
    uint64 public constant CHALLENGE_WINDOW = 48 hours;

    /// @notice 提案窗口。AI 在争议发起后必须在此时限内出具默认裁决，
    ///         逾期则任何人可直接把案件升级到终局仲裁，不会卡死。
    uint64 public constant PROPOSAL_WINDOW = 72 hours;

    enum Status {
        None,
        Open,       // 已受理，等待 AI 提案
        Proposed,   // 已有默认裁决，挑战窗口计时中
        Escalated,  // 已被挑战，等待终局仲裁
        Executed    // 终态
    }

    struct Dispute {
        address arbitrable;   // 发起争议的托管合约，裁决只会回调此地址
        address token;        // 该笔交易的结算币种
        Status status;
        uint8 proposedRuling;
        uint64 proposedAt;
        uint64 createdAt;
        address challenger;
        uint256 bond;         // 单边保证金金额（提案人与挑战者各质押这么多）
        uint256 finalCost;    // 受理时快照的终局仲裁成本，防止中途被抬价
    }

    /// @notice 交易实例注册表（EscrowFactory），用于校验争议来源合法。
    IDealRegistry public immutable registry;

    /// @notice 终局仲裁方。被挑战的案件升级到这里，其裁决为最终裁决。
    address public finalArbitrator;

    /// @notice AI 提案人地址（链下机器人的签名地址）。
    address public proposer;

    address public admin;

    /// @notice 仲裁服务费，按币种计价。由托管合约在裁决时支付（来自败诉方保证金）。
    mapping(address => uint256) public costOf;

    /// @notice 挑战保证金，按币种计价。必须 >= 终局仲裁成本，否则升级时无力支付。
    mapping(address => uint256) public bondOf;

    /// @notice 按币种统计的「在途保证金」总额。
    /// @dev 用于把仲裁服务费收入与用户质押的保证金严格隔离。
    ///      没有这本账，sweep() 就能把在途保证金一并卷走 ——
    ///      那等于在仲裁层重新开了一个后门，与整个协议的前提矛盾。
    mapping(address => uint256) public lockedBonds;

    mapping(uint256 => Dispute) public disputes;
    uint256 public nextDisputeID = 1;

    /// @notice 终局仲裁方的 disputeID → 本合约的 disputeID
    mapping(uint256 => uint256) public finalToLocal;

    event DisputeCreated(uint256 indexed id, address indexed arbitrable, address token, uint256 bond);
    event RulingProposed(uint256 indexed id, uint8 ruling, address indexed proposer);
    event Challenged(uint256 indexed id, address indexed challenger, uint256 finalDisputeID);
    event Executed(uint256 indexed id, uint8 ruling, bool wasChallenged);
    event BondSettled(uint256 indexed id, address indexed winner, uint256 amount);
    event FeesSwept(address indexed token, address indexed to, uint256 amount);
    event AdminTransferred(address indexed from, address indexed to);

    error NotAdmin();
    error NotProposer();
    error NotRegisteredDeal();
    error NotFinalArbitrator();
    error BadStatus();
    error WindowClosed();
    error WindowOpen();
    error BadRuling();
    error CostNotConfigured();
    error CostBelowFinalCost();
    error ZeroAddress();
    error NothingToSweep();
    error Reentrancy();

    /// @dev 本合约同时保管提案人与挑战者的保证金，币种由每笔交易决定。
    ///      带转账回调的代币能在转账中途重新进入本合约，所以必须有锁。
    bool private _entered;

    modifier nonReentrant() {
        if (_entered) revert Reentrancy();
        _entered = true;
        _;
        _entered = false;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(address _registry, address _finalArbitrator, address _proposer, address _admin) {
        if (_registry == address(0) || _finalArbitrator == address(0)) revert ZeroAddress();
        if (_proposer == address(0) || _admin == address(0)) revert ZeroAddress();
        registry = IDealRegistry(_registry);
        finalArbitrator = _finalArbitrator;
        proposer = _proposer;
        admin = _admin;
    }

    // -------------------------------------------------- IEscrowArbitrator

    /// @inheritdoc IEscrowArbitrator
    function arbitrationCost(address token, bytes calldata) external view returns (uint256) {
        return costOf[token];
    }

    /// @inheritdoc IEscrowArbitrator
    /// @dev 准入校验：调用方必须是工厂登记过的托管实例。
    ///      否则任何人都能部署一个假 arbitrable 来消耗提案人资源，
    ///      或诱导裁决回调打到非预期的合约上。
    function createDispute(uint256 choices, bytes calldata) external nonReentrant returns (uint256 id) {
        if (!registry.isDeal(msg.sender)) revert NotRegisteredDeal();
        if (choices != 2) revert BadRuling();

        address token = IEscrowView(msg.sender).token();
        uint256 cost = costOf[token];
        if (cost == 0) revert CostNotConfigured();

        // 终局仲裁方的报酬来自本层收取的仲裁服务费，而不是挑战保证金 ——
        // 否则 escalateUnproposed 路径（无人质押）下陪审员就是白干活。
        // 因此本层的服务费必须覆盖终局成本。
        uint256 finalCost = IEscrowArbitrator(finalArbitrator).arbitrationCost(token, "");
        if (cost < finalCost) revert CostBelowFinalCost();

        id = nextDisputeID++;
        disputes[id] = Dispute({
            arbitrable: msg.sender,
            token: token,
            status: Status.Open,
            proposedRuling: 0,
            proposedAt: 0,
            createdAt: uint64(block.timestamp),
            challenger: address(0),
            bond: bondOf[token],
            finalCost: finalCost
        });

        emit DisputeCreated(id, msg.sender, token, bondOf[token]);
    }

    /// @inheritdoc IEscrowArbitrator
    function currentRuling(uint256 id) external view returns (uint256) {
        Dispute storage d = disputes[id];
        return d.status == Status.Proposed || d.status == Status.Executed ? d.proposedRuling : 0;
    }

    // -------------------------------------------------------------- 提案

    /// @notice AI 提交默认裁决，并质押保证金。
    /// @dev 保证金让机器人对自己的结论有实际风险敞口。
    function propose(uint256 id, uint8 ruling) external nonReentrant {
        if (msg.sender != proposer) revert NotProposer();
        Dispute storage d = disputes[id];
        if (d.status != Status.Open) revert BadStatus();
        if (block.timestamp > uint256(d.createdAt) + PROPOSAL_WINDOW) revert WindowClosed();
        if (ruling > 2) revert BadRuling();

        d.status = Status.Proposed;
        d.proposedRuling = ruling;
        d.proposedAt = uint64(block.timestamp);

        lockedBonds[d.token] += d.bond;
        d.token.safeTransferFrom(msg.sender, address(this), d.bond);
        emit RulingProposed(id, ruling, msg.sender);
    }

    /// @notice 挑战默认裁决，质押等额保证金，案件升级到终局仲裁。
    /// @dev 刻意不限制调用者身份 —— 任何旁观者都可以推翻一个明显的错判并获利。
    ///      这是让机器人「不成为单点」的关键：纠错权是开放的。
    function challenge(uint256 id) external nonReentrant {
        Dispute storage d = disputes[id];
        if (d.status != Status.Proposed) revert BadStatus();
        if (block.timestamp > uint256(d.proposedAt) + CHALLENGE_WINDOW) revert WindowClosed();

        d.status = Status.Escalated;
        d.challenger = msg.sender;
        lockedBonds[d.token] += d.bond;
        d.token.safeTransferFrom(msg.sender, address(this), d.bond);

        uint256 finalID = IEscrowArbitrator(finalArbitrator).createDispute(2, abi.encode(d.token));
        finalToLocal[finalID] = id;

        emit Challenged(id, msg.sender, finalID);
    }

    /// @notice 挑战窗口届满无人挑战，默认裁决生效。任何人可触发。
    function execute(uint256 id) external nonReentrant {
        Dispute storage d = disputes[id];
        if (d.status != Status.Proposed) revert BadStatus();
        if (block.timestamp <= uint256(d.proposedAt) + CHALLENGE_WINDOW) revert WindowOpen();

        d.status = Status.Executed;
        uint8 ruling = d.proposedRuling;

        // 提案人保证金原额退回。
        lockedBonds[d.token] -= d.bond;
        d.token.safeTransfer(proposer, d.bond);
        emit BondSettled(id, proposer, d.bond);

        IEscrowArbitrable(d.arbitrable).rule(id, ruling);
        emit Executed(id, ruling, false);
    }

    /// @notice AI 超时未提案，任何人可直接把案件升级到终局仲裁。
    /// @dev 防止机器人下线导致案件卡死。此路径无人质押保证金，
    ///      终局仲裁成本由托管合约的 lockedArbCost 覆盖。
    function escalateUnproposed(uint256 id) external nonReentrant {
        Dispute storage d = disputes[id];
        if (d.status != Status.Open) revert BadStatus();
        if (block.timestamp <= uint256(d.createdAt) + PROPOSAL_WINDOW) revert WindowOpen();

        d.status = Status.Escalated;
        uint256 finalID = IEscrowArbitrator(finalArbitrator).createDispute(2, abi.encode(d.token));
        finalToLocal[finalID] = id;
        emit Challenged(id, address(0), finalID);
    }

    // ---------------------------------------------------- 终局裁决回调

    /// @inheritdoc IEscrowArbitrable
    /// @notice 终局仲裁方投递最终裁决。此处结算挑战保证金，并把裁决透传给托管合约。
    function rule(uint256 finalDisputeID, uint256 ruling) external nonReentrant {
        if (msg.sender != finalArbitrator) revert NotFinalArbitrator();

        uint256 id = finalToLocal[finalDisputeID];
        Dispute storage d = disputes[id];
        if (d.status != Status.Escalated) revert BadStatus();
        if (ruling > 2) revert BadRuling();

        d.status = Status.Executed;

        // 顺序不能颠倒：先让托管合约结算，这一步会把本层的仲裁服务费转入本合约，
        // 终局仲裁方的报酬正是从这笔服务费里支付。
        IEscrowArbitrable(d.arbitrable).rule(id, ruling);

        // 结算挑战保证金：终局裁决与 AI 提案不一致 → 挑战者赢；一致 → 提案人赢。
        // 双份保证金全额归胜方，不再被终局仲裁成本侵蚀 ——
        // 挑战者的收益不应取决于陪审团收费多少。
        // escalateUnproposed 路径无人质押，跳过本段。
        if (d.challenger != address(0)) {
            uint256 pool = d.bond * 2;
            lockedBonds[d.token] -= pool;
            address winner = (ruling != d.proposedRuling) ? d.challenger : proposer;
            d.token.safeTransfer(winner, pool);
            emit BondSettled(id, winner, pool);
        }

        // 支付终局仲裁方。以受理时快照的成本为准（防止中途抬价），
        // 并以「可动用余额」为硬上限 —— 无论如何都不会动到在途保证金。
        uint256 due = d.finalCost;
        uint256 free = _freeBalance(d.token);
        if (due > free) due = free;
        if (due > 0) d.token.safeTransfer(finalArbitrator, due);

        emit Executed(id, uint8(ruling), true);
    }

    // -------------------------------------------------------------- 配置

    function setCost(address token, uint256 cost, uint256 bond) external onlyAdmin {
        costOf[token] = cost;
        bondOf[token] = bond;
    }

    function setProposer(address p) external onlyAdmin {
        if (p == address(0)) revert ZeroAddress();
        proposer = p;
    }

    function setFinalArbitrator(address a) external onlyAdmin {
        if (a == address(0)) revert ZeroAddress();
        finalArbitrator = a;
    }

    /// @notice 转移管理员。转给 address(0) 即永久放弃配置权。
    function transferAdmin(address a) external onlyAdmin {
        emit AdminTransferred(admin, a);
        admin = a;
    }

    /// @notice 归集仲裁服务费收入。
    /// @dev 只能归集「余额 - 在途保证金」的部分，由合约强制，而非靠运营者自觉。
    ///      即便 admin 私钥泄露，在途的提案人/挑战者保证金也拿不走。
    function sweep(address token, address to) external onlyAdmin nonReentrant returns (uint256 amount) {
        if (to == address(0)) revert ZeroAddress();
        amount = _freeBalance(token);
        if (amount == 0) revert NothingToSweep();
        token.safeTransfer(to, amount);
        emit FeesSwept(token, to, amount);
    }

    /// @notice 当前可归集的仲裁服务费（已扣除在途保证金）。
    function sweepable(address token) external view returns (uint256) {
        return _freeBalance(token);
    }

    /// @dev 可动用余额 = 合约余额 − 在途保证金。
    ///      所有对外支付都必须走这个上限，在途保证金在任何路径下都不可被动用。
    function _freeBalance(address token) private view returns (uint256) {
        uint256 bal = SafeTransfer.balanceOf(token, address(this));
        uint256 locked = lockedBonds[token];
        return bal > locked ? bal - locked : 0;
    }
}
