// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IEscrowArbitrator, IEscrowArbitrable} from "../interfaces/IEscrowArbitrator.sol";
import {SafeTransfer} from "../lib/SafeTransfer.sol";

/// @title StakedJury
/// @notice 终局仲裁方：质押陪审团 + commit-reveal 投票。
///
/// 这是整个协议里唯一真正做「判断」的地方。链上合约无法验证链下履约
/// （oracle problem）—— 一个数字商品到底交付了没有，链本身永远不知道。
/// 所以最终必须有人做判断。本合约能做的是把这个判断权分散给一群
/// 有真金白银抵押的陌生人，并让说谎在经济上不划算。
///
/// 三个关键机制：
///
/// 1. **按质押量加权抽选**（Fenwick 树实现）。
///    如果等概率抽选，把 10 份质押拆成 10 个账号就能拿到 10 倍中选概率 ——
///    这是对陪审团的女巫攻击。加权抽选让「影响力」与「抵押的钱」严格挂钩，
///    拆号不产生任何收益。
///
/// 2. **commit-reveal 两阶段投票**。
///    如果直接明文投票，后投的人能看到先投的结果，会产生跟风（bandwagon），
///    投票不再独立，多数决的纠错能力失效；也让贿选变得可验证因而更容易。
///    先提交哈希承诺、后统一揭示，投票在揭示前互相不可见。
///
/// 3. **与多数一致者获得奖励，不一致者与不揭示者被罚没**。
///    这是 Schelling point 博弈：当你不知道别人会怎么投，
///    最优策略是投「你认为大多数诚实人会认为正确的那个答案」。
///    在证据清晰时，这个点就是真相。
///
/// 已知局限（不藏着，使用前请自行评估）：
///   - 随机数用 blockhash，出块者有有限的操纵能力。高价值争议应换 VRF。
///   - 本版本裁决即终局，无上诉轮。上层 OptimisticArbitrator 已提供一级
///     （AI → 陪审团）的挑战机制，但陪审团本身的错判无法再被推翻。
///   - Schelling point 在证据模糊或存在大额贿赂时会失效，这是该类机制的固有边界。
contract StakedJury is IEscrowArbitrator {
    using SafeTransfer for address;

    // ---------------------------------------------------------------- 参数

    /// @notice 陪审员质押的币种。
    address public immutable stakeToken;

    /// @notice 每个案件抽选的投票席位数。奇数以避免平票。
    uint256 public immutable jurySize;

    /// @notice 成为陪审员的最低质押额。
    uint256 public immutable minStake;

    /// @notice 每个投票席位锁定（也即错判时罚没）的质押额。
    uint256 public immutable stakePerVote;

    /// @notice 争议创建后延迟多少个区块才能抽选。
    /// @dev 必须 > 0：若用当前区块的哈希做种子，发起者可以预知结果并择时发起。
    uint64 public constant DRAW_DELAY = 10;

    uint64 public constant COMMIT_WINDOW = 3 days;
    uint64 public constant REVEAL_WINDOW = 2 days;

    /// @notice 案件彻底卡死（陪审员不足、无人揭示）的兜底时限。
    uint64 public constant CASE_TIMEOUT = 14 days;

    // ---------------------------------------------------------- 陪审员池

    address[] public jurors;
    /// @notice 1-indexed；0 表示尚未进入陪审员池。
    mapping(address => uint256) public jurorId;
    mapping(address => uint256) public stakeOf;
    /// @notice 正在服务中被锁定的质押，不可提取。
    mapping(address => uint256) public lockedOf;

    /// @dev Fenwick 树（树状数组），支持按质押量加权抽选与更新。
    ///
    ///      容量固定而非随陪审员数量增长，这一点至关重要：
    ///      Fenwick 节点 i 覆盖区间 (i - lowbit(i), i]。若树的上界随人数增长，
    ///      早期写入的 delta 不会传播到「当时还不存在、后来才出现」的祖先节点，
    ///      前缀和就此永久错乱，抽选会取到越界或错误的陪审员。
    ///      用 mapping 存储时未触碰的槽位不产生任何成本，所以直接把容量固定在上界。
    uint256 private constant TREE_CAPACITY = 1 << 16; // 65536 名陪审员

    mapping(uint256 => uint256) private _tree;
    uint256 public totalStake;

    // -------------------------------------------------------------- 案件

    enum Phase {
        None,
        Pending,   // 等待抽选
        Commit,    // 提交承诺
        Reveal,    // 揭示
        Executed   // 终态
    }

    struct Vote {
        address juror;
        bytes32 commitment;
        uint8 ruling;
        bool revealed;
        bool settled;
    }

    struct Case {
        address arbitrable;
        address feeToken;      // 该笔交易的结算币种，仲裁费以此计价
        Phase phase;
        uint8 ruling;
        uint64 drawBlock;
        uint64 commitDeadline;
        uint64 revealDeadline;
        uint64 createdAt;
        uint256 rewardPool;    // 仲裁服务费 + 罚没所得，分给与多数一致者
        uint256 coherentCount; // 与终局裁决一致且已揭示的席位数
    }

    mapping(uint256 => Case) public cases;
    mapping(uint256 => Vote[]) public votes;
    uint256 public nextCaseID = 1;

    /// @notice 仲裁服务费，按币种计价。
    mapping(address => uint256) public costOf;

    address public admin;

    // -------------------------------------------------------------- 事件

    event Staked(address indexed juror, uint256 amount, uint256 total);
    event Unstaked(address indexed juror, uint256 amount, uint256 remaining);
    event CaseCreated(uint256 indexed id, address indexed arbitrable, uint64 drawBlock);
    event JurorsDrawn(uint256 indexed id, address[] drawn, uint64 commitDeadline);
    event VoteCommitted(uint256 indexed id, uint256 indexed slot, address indexed juror);
    event VoteRevealed(uint256 indexed id, uint256 indexed slot, address indexed juror, uint8 ruling);
    event CaseExecuted(uint256 indexed id, uint8 ruling, uint256 rewardPool, uint256 coherent);
    event JurorSlashed(uint256 indexed id, address indexed juror, uint256 amount, string reason);
    event RewardClaimed(uint256 indexed id, uint256 indexed slot, address indexed juror, uint256 amount);
    event DrawRescheduled(uint256 indexed id, uint64 newDrawBlock);

    // -------------------------------------------------------------- 错误

    error NotAdmin();
    error BadPhase();
    error TooEarly();
    error TooLate();
    error InsufficientStake();
    error StakeLocked();
    error NotJuror();
    error NotYourSlot();
    error AlreadyCommitted();
    error AlreadyRevealed();
    error BadReveal();
    error BadRuling();
    error EmptyJuryPool();
    error CostNotConfigured();
    error SeedUnavailable();
    error NothingToClaim();
    error ZeroAddress();
    error TreeCorrupted();
    error JuryPoolFull();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(address _stakeToken, uint256 _jurySize, uint256 _minStake, uint256 _stakePerVote, address _admin) {
        if (_stakeToken == address(0) || _admin == address(0)) revert ZeroAddress();
        if (_jurySize == 0 || _jurySize % 2 == 0) revert BadRuling(); // 必须为奇数，避免平票
        if (_minStake < _stakePerVote) revert InsufficientStake();

        stakeToken = _stakeToken;
        jurySize = _jurySize;
        minStake = _minStake;
        stakePerVote = _stakePerVote;
        admin = _admin;
    }

    // ============================================================ 质押管理

    function stake(uint256 amount) external {
        stakeToken.safeTransferFrom(msg.sender, address(this), amount);

        uint256 id = jurorId[msg.sender];
        if (id == 0) {
            jurors.push(msg.sender);
            id = jurors.length; // 1-indexed
            jurorId[msg.sender] = id;
            if (id > TREE_CAPACITY) revert JuryPoolFull();
        }

        stakeOf[msg.sender] += amount;
        if (stakeOf[msg.sender] < minStake) revert InsufficientStake();

        totalStake += amount;
        _treeAdd(id, amount);
        emit Staked(msg.sender, amount, stakeOf[msg.sender]);
    }

    /// @notice 提取质押。服务中被锁定的部分不可提取。
    function unstake(uint256 amount) external {
        uint256 id = jurorId[msg.sender];
        if (id == 0) revert NotJuror();

        uint256 available = stakeOf[msg.sender] - lockedOf[msg.sender];
        if (amount > available) revert StakeLocked();

        uint256 remaining = stakeOf[msg.sender] - amount;
        // 要么留足最低质押继续当陪审员，要么全部退出
        if (remaining != 0 && remaining < minStake) revert InsufficientStake();

        stakeOf[msg.sender] = remaining;
        totalStake -= amount;
        _treeSub(id, amount);

        stakeToken.safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, amount, remaining);
    }

    // ==================================================== IEscrowArbitrator

    /// @inheritdoc IEscrowArbitrator
    function arbitrationCost(address token, bytes calldata) external view returns (uint256) {
        return costOf[token];
    }

    /// @inheritdoc IEscrowArbitrator
    /// @dev 结算币种的获取方式有两条路径：
    ///      - 上层是 OptimisticArbitrator：币种是逐笔的，通过 extraData 传入；
    ///      - 上层直接是 Escrow（不经乐观层）：extraData 为空，回退到读取 msg.sender.token()。
    ///      两种接法都要支持，否则本合约只能挂在某一种上层下面。
    function createDispute(uint256 choices, bytes calldata extraData) external returns (uint256 id) {
        if (choices != 2) revert BadRuling();
        if (totalStake == 0) revert EmptyJuryPool();

        address feeToken =
            extraData.length >= 32 ? abi.decode(extraData, (address)) : IFeeToken(msg.sender).token();
        if (feeToken == address(0)) revert ZeroAddress();
        if (costOf[feeToken] == 0) revert CostNotConfigured();

        id = nextCaseID++;
        cases[id] = Case({
            arbitrable: msg.sender,
            feeToken: feeToken,
            phase: Phase.Pending,
            ruling: 0,
            drawBlock: uint64(block.number) + DRAW_DELAY,
            commitDeadline: 0,
            revealDeadline: 0,
            createdAt: uint64(block.timestamp),
            rewardPool: 0,
            coherentCount: 0
        });

        emit CaseCreated(id, msg.sender, cases[id].drawBlock);
    }

    /// @inheritdoc IEscrowArbitrator
    function currentRuling(uint256 id) external view returns (uint256) {
        return cases[id].ruling;
    }

    // ============================================================== 抽选

    /// @notice 抽选陪审员。任何人可触发。
    /// @dev 种子取自 drawBlock 的区块哈希 —— 该区块在争议创建时尚未产生，
    ///      因此发起者无法预知会抽到谁。
    function drawJurors(uint256 id) external {
        Case storage c = cases[id];
        if (c.phase != Phase.Pending) revert BadPhase();
        if (block.number <= c.drawBlock) revert TooEarly();

        bytes32 seed = blockhash(c.drawBlock);
        if (seed == bytes32(0)) {
            // blockhash 只能回溯 256 个区块。超期则重新安排抽选区块，
            // 而不是让案件永久卡死。
            c.drawBlock = uint64(block.number) + DRAW_DELAY;
            emit DrawRescheduled(id, c.drawBlock);
            return;
        }

        address[] memory drawn = new address[](jurySize);
        for (uint256 i = 0; i < jurySize; i++) {
            uint256 r = uint256(keccak256(abi.encodePacked(seed, id, i))) % totalStake;
            uint256 idx = _findByWeight(r);
            address juror = jurors[idx - 1];

            drawn[i] = juror;
            votes[id].push(Vote({juror: juror, commitment: bytes32(0), ruling: 0, revealed: false, settled: false}));

            // 锁定该席位对应的质押。可重复抽中同一人（放回抽样），
            // 每中一次就多锁一份、多一票、也多一份罚没风险。
            lockedOf[juror] += stakePerVote;
        }

        c.phase = Phase.Commit;
        c.commitDeadline = uint64(block.timestamp) + COMMIT_WINDOW;
        emit JurorsDrawn(id, drawn, c.commitDeadline);
    }

    // ============================================================== 投票

    /// @notice 提交投票承诺。
    /// @param commitment keccak256(abi.encodePacked(ruling, salt, msg.sender))
    ///        必须包含 salt，否则只有两个可能取值的承诺可被暴力枚举出来；
    ///        必须包含地址，否则可以直接抄别人的承诺。
    function commitVote(uint256 id, uint256 slot, bytes32 commitment) external {
        Case storage c = cases[id];
        if (c.phase != Phase.Commit) revert BadPhase();
        if (block.timestamp > c.commitDeadline) revert TooLate();

        Vote storage v = votes[id][slot];
        if (v.juror != msg.sender) revert NotYourSlot();
        if (v.commitment != bytes32(0)) revert AlreadyCommitted();

        v.commitment = commitment;
        emit VoteCommitted(id, slot, msg.sender);
    }

    /// @notice 提交承诺阶段结束，进入揭示阶段。任何人可推动。
    function startReveal(uint256 id) external {
        Case storage c = cases[id];
        if (c.phase != Phase.Commit) revert BadPhase();
        if (block.timestamp <= c.commitDeadline) revert TooEarly();

        c.phase = Phase.Reveal;
        c.revealDeadline = uint64(block.timestamp) + REVEAL_WINDOW;
    }

    /// @notice 揭示投票。
    function revealVote(uint256 id, uint256 slot, uint8 ruling, bytes32 salt) external {
        Case storage c = cases[id];
        if (c.phase != Phase.Reveal) revert BadPhase();
        if (block.timestamp > c.revealDeadline) revert TooLate();
        if (ruling == 0 || ruling > 2) revert BadRuling();

        Vote storage v = votes[id][slot];
        if (v.juror != msg.sender) revert NotYourSlot();
        if (v.revealed) revert AlreadyRevealed();
        if (keccak256(abi.encodePacked(ruling, salt, msg.sender)) != v.commitment) revert BadReveal();

        v.revealed = true;
        v.ruling = ruling;
        emit VoteRevealed(id, slot, msg.sender, ruling);
    }

    // ============================================================== 结案

    /// @notice 统计投票、罚没失职者、并把终局裁决投递给上层。任何人可推动。
    function executeCase(uint256 id) external {
        Case storage c = cases[id];
        if (c.phase != Phase.Reveal) revert BadPhase();
        if (block.timestamp <= c.revealDeadline) revert TooEarly();

        uint256 n = votes[id].length;
        uint256 for1;
        uint256 for2;

        // 先罚没：未揭示者（含从未提交承诺者）一律罚没。
        // 不揭示是对 commit-reveal 最直接的攻击方式 —— 看到风向不对就装死。
        // 必须有成本，否则陪审员会只在有利时才揭示。
        uint256 slashed;
        for (uint256 i = 0; i < n; i++) {
            Vote storage v = votes[id][i];
            if (!v.revealed) {
                slashed += _slash(id, v.juror, "NO_REVEAL");
                v.settled = true;
            } else if (v.ruling == 1) {
                for1++;
            } else {
                for2++;
            }
        }

        uint8 ruling;
        if (for1 == 0 && for2 == 0) {
            ruling = 0; // 无人揭示 → 拒裁，上层做中性拆分
        } else {
            ruling = for1 > for2 ? 1 : 2;
        }

        // 再罚没与多数不一致者
        uint256 coherent;
        if (ruling != 0) {
            for (uint256 i = 0; i < n; i++) {
                Vote storage v = votes[id][i];
                if (!v.revealed) continue;
                if (v.ruling == ruling) {
                    coherent++;
                } else {
                    slashed += _slash(id, v.juror, "INCOHERENT");
                    v.settled = true;
                }
            }
        }

        c.phase = Phase.Executed;
        c.ruling = ruling;
        c.coherentCount = coherent;

        // 投递裁决。上层会在此调用中把仲裁服务费转入本合约，
        // 所以要在调用后再快照余额变化。
        uint256 balBefore = SafeTransfer.balanceOf(c.feeToken, address(this));
        IEscrowArbitrable(c.arbitrable).rule(id, ruling);
        uint256 feeReceived = SafeTransfer.balanceOf(c.feeToken, address(this)) - balBefore;

        c.rewardPool = feeReceived;

        // 罚没所得留在本合约的质押池里，按 stakeToken 计价；
        // 服务费按 feeToken 计价。两者币种可能不同，故分开结算：
        // 服务费按席位平分给一致者（claimReward），
        // 罚没所得则直接补进一致者的质押。
        if (coherent > 0 && slashed > 0) {
            uint256 share = slashed / coherent;
            for (uint256 i = 0; i < n; i++) {
                Vote storage v = votes[id][i];
                if (v.revealed && v.ruling == ruling) {
                    stakeOf[v.juror] += share;
                    totalStake += share;
                    _treeAdd(jurorId[v.juror], share);
                }
            }
        }

        emit CaseExecuted(id, ruling, feeReceived, coherent);
    }

    /// @notice 领取仲裁服务费分成。与多数一致的席位可领。
    function claimReward(uint256 id, uint256 slot) external {
        Case storage c = cases[id];
        if (c.phase != Phase.Executed) revert BadPhase();

        Vote storage v = votes[id][slot];
        if (v.juror != msg.sender) revert NotYourSlot();
        if (v.settled) revert NothingToClaim();
        if (!v.revealed || v.ruling != c.ruling || c.coherentCount == 0) revert NothingToClaim();

        v.settled = true;
        _unlock(msg.sender);

        uint256 amount = c.rewardPool / c.coherentCount;
        if (amount > 0) c.feeToken.safeTransfer(msg.sender, amount);
        emit RewardClaimed(id, slot, msg.sender, amount);
    }

    /// @notice 案件彻底卡死的兜底：陪审员池为空导致长期无法抽选等。
    ///         超过 CASE_TIMEOUT 后任何人可触发拒裁，让上层把资金中性退回。
    function timeoutCase(uint256 id) external {
        Case storage c = cases[id];
        if (c.phase == Phase.None || c.phase == Phase.Executed) revert BadPhase();
        if (block.timestamp < uint256(c.createdAt) + CASE_TIMEOUT) revert TooEarly();

        // 解锁所有席位的质押，不做罚没 —— 卡死不是陪审员的过错
        uint256 n = votes[id].length;
        for (uint256 i = 0; i < n; i++) {
            Vote storage v = votes[id][i];
            if (!v.settled) {
                v.settled = true;
                _unlock(v.juror);
            }
        }

        c.phase = Phase.Executed;
        c.ruling = 0;
        IEscrowArbitrable(c.arbitrable).rule(id, 0);
        emit CaseExecuted(id, 0, 0, 0);
    }

    // ============================================================== 内部

    function _slash(uint256 id, address juror, string memory reason) private returns (uint256 amount) {
        amount = stakePerVote;
        if (stakeOf[juror] < amount) amount = stakeOf[juror];

        stakeOf[juror] -= amount;
        totalStake -= amount;
        _treeSub(jurorId[juror], amount);
        _unlock(juror);

        emit JurorSlashed(id, juror, amount, reason);
    }

    function _unlock(address juror) private {
        uint256 locked = lockedOf[juror];
        lockedOf[juror] = locked >= stakePerVote ? locked - stakePerVote : 0;
    }

    // --------------------------------------------- Fenwick 树（加权抽选）

    function _treeAdd(uint256 i, uint256 delta) private {
        for (; i <= TREE_CAPACITY; i += i & (~i + 1)) {
            _tree[i] += delta;
        }
    }

    function _treeSub(uint256 i, uint256 delta) private {
        for (; i <= TREE_CAPACITY; i += i & (~i + 1)) {
            _tree[i] -= delta;
        }
    }

    /// @dev 找到最小的 idx，使得 [1..idx] 的质押前缀和 > target。
    ///      即按质押量加权的随机抽选：质押越多，覆盖的区间越宽，中选概率越高。
    function _findByWeight(uint256 target) private view returns (uint256 idx) {
        uint256 pos = 0;
        for (uint256 pw = TREE_CAPACITY; pw > 0; pw >>= 1) {
            uint256 next = pos + pw;
            if (next <= TREE_CAPACITY && _tree[next] <= target) {
                pos = next;
                target -= _tree[next];
            }
        }
        idx = pos + 1;
        // 调用方保证 target < totalStake，正常情况下结果必然落在有效范围内。
        // 这里仍然显式校验：宁可响亮地失败，也不要静默地抽到错误的陪审员。
        if (idx == 0 || idx > jurors.length) revert TreeCorrupted();
    }

    // ============================================================== 配置

    function setCost(address token, uint256 cost) external onlyAdmin {
        costOf[token] = cost;
    }

    function transferAdmin(address a) external onlyAdmin {
        admin = a;
    }

    // ============================================================== 只读

    function jurorCount() external view returns (uint256) {
        return jurors.length;
    }

    function voteCount(uint256 id) external view returns (uint256) {
        return votes[id].length;
    }

    /// @notice 前端用：计算投票承诺。salt 必须由陪审员自行保管到揭示阶段。
    function computeCommitment(uint8 ruling, bytes32 salt, address juror) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(ruling, salt, juror));
    }
}

interface IFeeToken {
    function token() external view returns (address);
}
