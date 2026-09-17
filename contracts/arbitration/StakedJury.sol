// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IEscrowArbitrator, IEscrowArbitrable, IEscrowTerms} from "../interfaces/IEscrowArbitrator.sol";
import {SafeTransfer} from "../lib/SafeTransfer.sol";
import {IRandomnessSource} from "../interfaces/IRandomnessSource.sol";

/// @title StakedJury
/// @notice 终局仲裁方：质押陪审团 + commit-reveal 投票 + 可上诉。
///
/// 这是整个协议里唯一真正做「判断」的地方。链上合约无法验证链下履约
/// （oracle problem）—— 一个数字商品到底交付了没有，链本身永远不知道。
/// 所以最终必须有人做判断。本合约能做的是把这个判断权分散给一群
/// 有真金白银抵押的陌生人，并让说谎在经济上不划算。
///
/// 五个关键机制：
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
/// 4. **可插拔的随机数来源，且与区块哈希混合而不是替换**。
///    详见 `drawJurors` 的注释 —— 那里解释了为什么「混合」这个选择
///    比「替换」重要得多。
///
/// 5. **上诉轮**。一轮陪审团出了裁决之后，裁决不会立刻投递给托管合约，
///    而是先开一个上诉窗口。任何人都可以自费把案件升到一轮**更大**的陪审团。
///    详见 `appeal` 的注释。
///
/// 已知局限（不藏着，使用前请自行评估）：
///   - 未配置随机数来源时退化为纯 blockhash，出块者有有限的操纵能力。
///     配置之后这个能力被压缩到「必须持续审查 VRF 回调直到超时」，
///     但没有被完全消除。
///   - 上诉轮能纠正陪审团的错判，但纠正不了**拖延**：败诉方即使明知
///     自己会再输一次，也可以靠上诉把对方的钱多锁一个轮次。
///     他为此付了全额费用，但那笔钱进了陪审员口袋，不是对方的补偿。
///   - Schelling point 在证据模糊或存在大额贿赂时会失效，这是该类机制的固有边界。
///     上诉把「买通一个陪审团」的成本抬高到「买通一个更大的陪审团」，
///     但上限仍然是钱。
contract StakedJury is IEscrowArbitrator {
    using SafeTransfer for address;

    // ---------------------------------------------------------------- 参数

    /// @notice 陪审员质押的币种。
    address public immutable stakeToken;

    /// @notice 第一轮抽选的投票席位数。奇数以避免平票。
    uint256 public immutable jurySize;

    /// @notice 成为陪审员的最低质押额。
    uint256 public immutable minStake;

    /// @notice 每个投票席位锁定（也即错判时罚没）的质押额。
    uint256 public immutable stakePerVote;

    /// @notice 争议创建后延迟多少个区块才能抽选。
    /// @dev 必须 > 0：若用当前区块的哈希做种子，发起者可以预知结果并择时发起。
    uint64 public constant DRAW_DELAY = 10;

    /// @notice 随机数来源的等待时限。超过此时限仍未返回，允许仅用区块哈希抽选。
    ///
    /// @dev 这个回退不是可选项，是必须的：没有它，一个停服的预言机就能让
    ///      所有争议永久卡在待抽选状态，资金跟着卡住。
    ///      代价是「持续审查 VRF 回调 2 小时」可以把随机性降级回纯 blockhash ——
    ///      也就是降回本合约不接任何预言机时的水平，**不会更差**。
    uint64 public constant RANDOMNESS_TIMEOUT = 2 hours;

    /// @notice 调用随机数来源时的 gas 上限。
    /// @dev 来源合约是管理员可配置的，因此必须当作恶意的来处理：
    ///      不限 gas 的话，一个故意烧光 gas 的来源可以让争议根本创建不出来。
    uint256 private constant RANDOMNESS_GAS = 200_000;

    uint64 public constant COMMIT_WINDOW = 3 days;
    uint64 public constant REVEAL_WINDOW = 2 days;

    /// @notice 一轮裁决出来之后、投递给托管合约之前的上诉窗口。
    /// @dev 不能太短（对方要有时间发现错判并凑钱），也不能太长
    ///      （每一轮都要占掉托管合约 DISPUTE_TIMEOUT 预算里的一段）。
    uint64 public constant APPEAL_WINDOW = 2 days;

    /// @notice 包含第一轮在内的最大轮数。3 = 初审 + 两次上诉。
    ///
    /// @dev 上限不是拍脑袋定的，是被托管合约的 `DISPUTE_TIMEOUT` 约束死的：
    ///      每一轮要占 COMMIT_WINDOW + REVEAL_WINDOW，每个上诉窗口再占 APPEAL_WINDOW，
    ///      再加上乐观层的提案窗口与挑战窗口。轮数再多，整条链路就会超出
    ///      托管合约的仲裁方失联保护时限，反而触发中性拆分 —— 那等于
    ///      上诉把案件拖成了平局，比不能上诉更糟。
    uint256 public constant MAX_ROUNDS = 3;

    /// @notice 单轮彻底卡死（陪审员不足、无人揭示）的兜底时限，**按轮计算**。
    /// @dev 必须按轮而不是按案：上诉会合法地把案件拉长到数周，
    ///      按案计时会让一个正常推进的上诉轮被兜底逻辑打断。
    uint64 public constant ROUND_TIMEOUT = 10 days;

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
        Pending,     // 等待抽选
        Commit,      // 提交承诺
        Reveal,      // 揭示
        Appealable,  // 本轮已出裁决，上诉窗口计时中
        Executed     // 终态
    }

    struct Vote {
        address juror;
        uint8 ruling;
        bool revealed;
        bool settled;
        /// @notice 本席位属于第几轮（0-indexed）。
        uint8 round;
        bytes32 commitment;
    }

    /// @notice 一轮陪审。
    /// @dev 每一轮**独立结算**：本轮席位的对错只与本轮多数决比对，
    ///      与上诉轮的结论无关。理由见 `tallyRound` 的注释。
    struct Round {
        uint8 ruling;         // 本轮多数裁决；0 = 无人揭示
        uint32 voteStart;     // 本轮席位在 votes[id] 中的起始下标
        uint32 size;          // 本轮席位数
        address appellant;    // 发起本轮上诉的人；第一轮为 0
        uint256 coherentCount;
        uint256 rewardPool;   // 本轮报酬，以 feeToken 计价
    }

    struct Case {
        address arbitrable;
        address feeToken;      // 该笔交易的结算币种，仲裁费以此计价
        Phase phase;
        uint8 ruling;          // 终局裁决（= 最后一轮的裁决）
        uint64 drawBlock;      // 当前轮的抽选区块
        uint64 commitDeadline; // 当前轮
        uint64 revealDeadline; // 当前轮
        uint64 appealDeadline;
        uint64 roundStartedAt; // 当前轮起始时间，ROUND_TIMEOUT 以此计算
        uint64 createdAt;
        /// @notice 当前轮的随机数请求时间；0 表示本轮未使用外部随机数来源。
        uint64 rngRequestedAt;
        /// @notice 当前轮使用的随机数来源，开轮时快照。
        /// @dev 逐轮快照与本协议其它地方同理：管理员事后更换来源，
        ///      不影响任何已经开始的轮次。否则「看到一个不想输的案子再换来源」
        ///      就成了一个现成的攻击路径。
        address rngSource;
        /// @notice 受理时快照的案值 —— 一个被买通的裁决最多能挪动多少钱。
        /// @dev 陪审团抗贿赂的能力来自「过半席位会被罚没的总额」，那是固定参数；
        ///      案值却是浮动的。两者不挂钩，案值一旦超过买通成本，
        ///      买裁决在结构上就是划算的。存下来是为了让上层能算这笔账。
        uint256 value;
        /// @notice 受理时快照的第一轮价钱，上诉费按它换算。
        /// @dev 不能现取 `costOf` —— 那等于给管理员一个开关：
        ///      看到一个不想被推翻的裁决，把价钱调高到当事人付不起就行了。
        uint256 baseCost;
    }

    /// @dev 私有 + 显式 getter，而不是 public 自动 getter：
    ///      Case 的字段超过十来个之后，自动 getter 要在栈上摊开全部返回值，
    ///      会直接撞上 EVM 的栈深度上限编译不过。返回 memory 结构体没有这个问题，
    ///      而且调用方拿到的仍然是带字段名的对象。
    mapping(uint256 => Case) private _cases;

    function cases(uint256 id) external view returns (Case memory) {
        return _cases[id];
    }
    mapping(uint256 => Round[]) public rounds;
    /// @notice 全案席位，按轮次先后平铺。slot 在一个案件内全局唯一。
    mapping(uint256 => Vote[]) public votes;
    uint256 public nextCaseID = 1;

    /// @notice 仲裁服务费，按币种计价。这是**第一轮**的价钱。
    mapping(address => uint256) public costOf;

    /// @notice 无人有资格领取、已回收待分配的报酬，按币种计价。
    /// @dev 见 `_settlePools`。这笔钱会并入下一个结案案件第一轮的报酬池，
    ///      既不停在合约里变成死钱，也不需要为它给管理员开一个提款口 ——
    ///      给这份合约引入一个能动用用户资金的角色，与整个协议的前提矛盾。
    mapping(address => uint256) public recycled;

    /// @notice 新轮次默认使用的随机数来源。0 表示不使用（纯 blockhash）。
    /// @dev 只影响**未来**开的轮次。已开始的轮次用的是自己快照的那一个。
    address public randomnessSource;

    address public admin;

    // -------------------------------------------------------------- 事件

    event Staked(address indexed juror, uint256 amount, uint256 total);
    event Unstaked(address indexed juror, uint256 amount, uint256 remaining);
    event CaseCreated(uint256 indexed id, address indexed arbitrable, uint64 drawBlock, uint256 value);
    event JurorsDrawn(uint256 indexed id, uint256 indexed round, address[] drawn, uint64 commitDeadline);
    event VoteCommitted(uint256 indexed id, uint256 indexed slot, address indexed juror);
    event VoteRevealed(uint256 indexed id, uint256 indexed slot, address indexed juror, uint8 ruling);
    event RoundTallied(uint256 indexed id, uint256 indexed round, uint8 ruling, uint256 coherent);
    event AppealWindowOpened(uint256 indexed id, uint256 indexed round, uint8 ruling, uint64 deadline, uint256 cost);
    event Appealed(uint256 indexed id, uint256 indexed round, address indexed appellant, uint256 cost, uint256 size);
    event CaseFinalized(uint256 indexed id, uint8 ruling, uint256 roundsUsed, bool delivered);
    /// @notice 裁决投递失败。案件照常结案、质押照常解锁，但本案拿不到服务费。
    event RulingDeliveryFailed(uint256 indexed id, address indexed arbitrable);
    event AppealFeeRefunded(uint256 indexed id, uint256 indexed round, address indexed to, uint256 amount);
    event FeesRecycled(uint256 indexed id, address indexed token, uint256 amount);
    event JurorSlashed(uint256 indexed id, address indexed juror, uint256 amount, string reason);
    event RewardClaimed(uint256 indexed id, uint256 indexed slot, address indexed juror, uint256 amount);
    event DrawRescheduled(uint256 indexed id, uint64 newDrawBlock);
    event RandomnessSourceChanged(address indexed from, address indexed to);
    event AdminTransferred(address indexed from, address indexed to);
    event RandomnessRequested(uint256 indexed id, uint256 indexed round, address indexed source);
    /// @notice 请求随机数失败。本轮降级为纯 blockhash 抽选，但争议照常受理。
    event RandomnessRequestFailed(uint256 indexed id, uint256 indexed round, address indexed source);
    /// @notice 等待超时，本轮放弃外部随机数，仅用区块哈希抽选。
    event RandomnessTimedOut(uint256 indexed id, uint256 indexed round, address indexed source);

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
    error RandomnessPending();
    error NothingToClaim();
    error NoMoreAppeals();
    error ZeroAddress();
    error TreeCorrupted();
    error JuryPoolFull();
    error Reentrancy();

    /// @dev 与 `Escrow` 同一份实现。本合约会把任意 ERC20 转进转出
    ///      （币种由每笔交易决定，只要管理员给它配过价），而带转账回调的代币
    ///      能在转账中途重新进入本合约。见 `appeal` 的注释。
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

    function stake(uint256 amount) external nonReentrant {
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
    function unstake(uint256 amount) external nonReentrant {
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
    /// @dev 报价只包含第一轮。上诉轮由发起上诉的人另行自费，
    ///      不向托管合约、也不向任何一方追加收费 ——
    ///      否则「对方上诉」就会变成一笔你自己无法拒绝的账单。
    function arbitrationCost(address token, bytes calldata) external view returns (uint256) {
        return costOf[token];
    }

    /// @inheritdoc IEscrowArbitrator
    /// @dev 结算币种的获取方式有两条路径：
    ///      - 上层是 OptimisticArbitrator：币种是逐笔的，通过 extraData 传入；
    ///      - 上层直接是 Escrow（不经乐观层）：extraData 为空，回退到读取 msg.sender.token()。
    ///      两种接法都要支持，否则本合约只能挂在某一种上层下面。
    /// @dev **受理争议不要求陪审员池非空。**
    ///
    ///      早期版本在这里卡了一道 `totalStake == 0` 就 revert 的门槛。
    ///      那是错的：它会让 `Escrow.raiseDispute()` 整个失败，于是
    ///      **池子空的时候当事人连争议都提不起来**，只能干等仲裁方失联保护
    ///      走中性拆分。而陪审员池本来就是从空开始的 —— 它靠「有案子可判、
    ///      有仲裁费可赚」把人吸引进来。受理时就拦死，等于把自启动的路堵了。
    ///
    ///      正确的做法是让案件挂在待抽选，`drawJurors` 那一步才要求池子非空；
    ///      迟迟凑不齐人由 `ROUND_TIMEOUT` 兜底，资金照样不会锁死。
    function createDispute(uint256 choices, bytes calldata extraData) external nonReentrant returns (uint256 id) {
        if (choices != 2) revert BadRuling();

        (address feeToken, uint256 value) = _terms(extraData);
        if (feeToken == address(0)) revert ZeroAddress();
        if (costOf[feeToken] == 0) revert CostNotConfigured();

        id = nextCaseID++;
        _openCase(id, feeToken, value);

        rounds[id].push(
            Round({
                ruling: 0,
                voteStart: 0,
                size: uint32(jurySize),
                appellant: address(0),
                coherentCount: 0,
                rewardPool: 0
            })
        );

        _requestRandomness(id, 0);
        emit CaseCreated(id, msg.sender, _cases[id].drawBlock, value);
    }

    /// @dev 取本案的币种与案值。两条接法都要支持：
    ///        - 上层是 OptimisticArbitrator：它在自己受理时已经快照过，直接透传；
    ///        - 上层直接是 Escrow：extraData 为空，回头读它自己。
    ///
    ///      刻意不给「取不到案值就当 0」留后路 —— 那会让后续所有按案值做的
    ///      保护静默失效，而且没有任何人会发现。取不到就响亮地失败。
    function _terms(bytes calldata extraData) private view returns (address feeToken, uint256 value) {
        if (extraData.length >= 64) {
            (feeToken, value) = abi.decode(extraData, (address, uint256));
        } else {
            feeToken = IEscrowTerms(msg.sender).token();
            value = IEscrowTerms(msg.sender).disputeValue();
        }
    }

    /// @dev 逐字段写入而不是构造整个结构体字面量：字段变多之后
    ///      `createDispute` 的局部变量会撞上 EVM 的栈深度上限。
    ///      `id` 来自自增计数器，槽位必然是全新的，所以为 0 的字段不必显式写。
    function _openCase(uint256 id, address feeToken, uint256 value) private {
        Case storage c = _cases[id];
        c.arbitrable = msg.sender;
        c.feeToken = feeToken;
        c.phase = Phase.Pending;
        c.drawBlock = uint64(block.number) + DRAW_DELAY;
        c.roundStartedAt = uint64(block.timestamp);
        c.createdAt = uint64(block.timestamp);
        c.value = value;
        c.baseCost = costOf[feeToken];
    }

    /// @inheritdoc IEscrowArbitrator
    function currentRuling(uint256 id) external view returns (uint256) {
        return _cases[id].ruling;
    }

    // ============================================================== 随机数

    /// @dev 请求键绑定本合约地址、案件 ID 与轮次：同一个来源可以同时服务
    ///      多个陪审团实例与多个轮次，键不冲突，也无法被另一个实例冒领。
    ///      **必须带上轮次** —— 否则上诉轮会复用初审轮已经公开的随机数，
    ///      重抽的结果在开轮那一刻就已经是已知的。
    function _rngKey(uint256 id, uint256 round) private view returns (bytes32) {
        return keccak256(abi.encodePacked(address(this), id, round));
    }

    /// @dev 为某一轮请求随机数。失败绝不能阻断案件推进 ——
    ///      那等于让一个坏掉的预言机剥夺当事人提起争议或上诉的权利。
    ///      失败就降级为纯 blockhash，并留下事件。
    function _requestRandomness(uint256 id, uint256 round) private {
        address src = randomnessSource;
        if (src == address(0)) return;

        (bool ok,) = src.call{gas: RANDOMNESS_GAS}(
            abi.encodeCall(IRandomnessSource.requestRandomness, (_rngKey(id, round)))
        );
        if (ok) {
            _cases[id].rngSource = src;
            _cases[id].rngRequestedAt = uint64(block.timestamp);
            emit RandomnessRequested(id, round, src);
        } else {
            emit RandomnessRequestFailed(id, round, src);
        }
    }

    /// @dev 限 gas 的只读调用。来源合约按「可能是恶意的」处理：
    ///      revert、烧 gas、返回畸形数据，一律当作「尚未就绪」，
    ///      绝不让它把抽选卡死。
    function _readRandomness(address src, bytes32 key) private view returns (bool, uint256) {
        (bool ok, bytes memory data) = src.staticcall{gas: RANDOMNESS_GAS}(
            abi.encodeCall(IRandomnessSource.randomnessOf, (key))
        );
        if (!ok || data.length < 64) return (false, 0);
        (bool ready, uint256 value) = abi.decode(data, (bool, uint256));
        return (ready, value);
    }

    // ============================================================== 抽选

    /// @notice 抽选本轮陪审员。任何人可触发。
    ///
    /// @dev 种子 = keccak256(区块哈希, 外部随机数, 案件 ID)。
    ///
    /// **为什么是混合而不是替换。** 外部随机数来源由管理员配置，
    /// 如果直接拿它当种子，管理员就获得了一项本协议其它任何地方都不存在的权力：
    /// 装一个自己写的「随机数」合约，从而**指定陪审员**。那比 blockhash 糟得多。
    ///
    /// 混合之后，最坏情况有了下界：
    ///   - 来源作恶（返回攻击者指定的数字）→ 他还得同时操纵区块哈希；
    ///   - 来源停摆或被审查 → 超时后退回纯 blockhash；
    ///   - 来源诚实 → 出块者即便操纵区块哈希也无法预知 VRF 的输出。
    /// 三种情况都不比「完全不接预言机」更差，而正常情况明显更好。
    ///
    /// **顺序不构成新的攻击面。** VRF 先于 drawBlock 返回时，该区块的出块者
    /// 知道 VRF 值并可尝试研磨区块哈希 —— 这正是今天的水平。VRF 后返回时，
    /// 预言机知道区块哈希，但 Chainlink VRF 的输出是可验证的：
    /// 它只能扣住不发（→ 超时 → 退回 blockhash），不能挑一个自己想要的值。
    function drawJurors(uint256 id) external nonReentrant {
        Case storage c = _cases[id];
        if (c.phase != Phase.Pending) revert BadPhase();
        if (block.number <= c.drawBlock) revert TooEarly();
        // 池子为空不是「拒绝受理」的理由，只是「现在还抽不了」。
        // 见 createDispute 的注释。超期由 ROUND_TIMEOUT 兜底。
        if (totalStake == 0) revert EmptyJuryPool();

        bytes32 bh = blockhash(c.drawBlock);
        if (bh == bytes32(0)) {
            // blockhash 只能回溯 256 个区块。超期则重新安排抽选区块，
            // 而不是让案件永久卡死。
            c.drawBlock = uint64(block.number) + DRAW_DELAY;
            emit DrawRescheduled(id, c.drawBlock);
            return;
        }

        uint256 ri = rounds[id].length - 1;

        uint256 rng = 0;
        if (c.rngSource != address(0)) {
            (bool ready, uint256 value) = _readRandomness(c.rngSource, _rngKey(id, ri));
            if (ready) {
                rng = value;
            } else if (block.timestamp < uint256(c.rngRequestedAt) + RANDOMNESS_TIMEOUT) {
                // 还在等待窗口内。不允许抢跑降级 —— 否则任何人都能通过
                // 抢在 VRF 返回之前调用本函数，把随机性白白降级回 blockhash。
                revert RandomnessPending();
            } else {
                emit RandomnessTimedOut(id, ri, c.rngSource);
            }
        }

        bytes32 seed = keccak256(abi.encodePacked(bh, rng, id));

        uint256 size = rounds[id][ri].size;
        address[] memory drawn = new address[](size);
        for (uint256 i = 0; i < size; i++) {
            uint256 r = uint256(keccak256(abi.encodePacked(seed, id, i))) % totalStake;
            uint256 idx = _findByWeight(r);
            address juror = jurors[idx - 1];

            drawn[i] = juror;
            votes[id].push(
                Vote({
                    juror: juror,
                    ruling: 0,
                    revealed: false,
                    settled: false,
                    round: uint8(ri),
                    commitment: bytes32(0)
                })
            );

            // 锁定该席位对应的质押。可重复抽中同一人（放回抽样），
            // 每中一次就多锁一份、多一票、也多一份罚没风险。
            lockedOf[juror] += stakePerVote;
        }

        c.phase = Phase.Commit;
        c.commitDeadline = uint64(block.timestamp) + COMMIT_WINDOW;
        emit JurorsDrawn(id, ri, drawn, c.commitDeadline);
    }

    // ============================================================== 投票

    /// @notice 提交投票承诺。
    /// @param commitment keccak256(abi.encodePacked(ruling, salt, msg.sender))
    ///        必须包含 salt，否则只有两个可能取值的承诺可被暴力枚举出来；
    ///        必须包含地址，否则可以直接抄别人的承诺。
    function commitVote(uint256 id, uint256 slot, bytes32 commitment) external {
        Case storage c = _cases[id];
        if (c.phase != Phase.Commit) revert BadPhase();
        if (block.timestamp > c.commitDeadline) revert TooLate();

        Vote storage v = votes[id][slot];
        // 必须校验轮次：席位是跨轮平铺的，不带这个判断，上一轮遗留的空白席位
        // 会在下一轮的窗口里被重新激活。
        if (v.juror != msg.sender || v.round != rounds[id].length - 1) revert NotYourSlot();
        if (v.commitment != bytes32(0)) revert AlreadyCommitted();

        v.commitment = commitment;
        emit VoteCommitted(id, slot, msg.sender);
    }

    /// @notice 提交承诺阶段结束，进入揭示阶段。任何人可推动。
    function startReveal(uint256 id) external {
        Case storage c = _cases[id];
        if (c.phase != Phase.Commit) revert BadPhase();
        if (block.timestamp <= c.commitDeadline) revert TooEarly();

        c.phase = Phase.Reveal;
        c.revealDeadline = uint64(block.timestamp) + REVEAL_WINDOW;
    }

    /// @notice 揭示投票。
    function revealVote(uint256 id, uint256 slot, uint8 ruling, bytes32 salt) external {
        Case storage c = _cases[id];
        if (c.phase != Phase.Reveal) revert BadPhase();
        if (block.timestamp > c.revealDeadline) revert TooLate();
        if (ruling == 0 || ruling > 2) revert BadRuling();

        Vote storage v = votes[id][slot];
        if (v.juror != msg.sender || v.round != rounds[id].length - 1) revert NotYourSlot();
        if (v.revealed) revert AlreadyRevealed();
        if (keccak256(abi.encodePacked(ruling, salt, msg.sender)) != v.commitment) revert BadReveal();

        v.revealed = true;
        v.ruling = ruling;
        emit VoteRevealed(id, slot, msg.sender, ruling);
    }

    // ============================================================== 结轮

    /// @notice 统计本轮投票、罚没本轮失职者，并开启上诉窗口。任何人可推动。
    ///         已经是最后一轮时直接结案。
    ///
    /// @dev **为什么每一轮独立结算，而不是全部按终局裁决重算。**
    ///
    /// 另一种常见做法是：等案件终局之后，回过头把所有轮次的席位统一
    /// 按终局裁决判定对错。它的好处是「真相只有一个」，听起来更自洽。
    /// 但它打开了一个很难堵的攻击：一个有钱的攻击者只要**逐级上诉到最后一轮
    /// 并买通那一轮**，就能追溯地罚没前面每一轮所有诚实陪审员的质押。
    /// 他的成本被上诉费封顶，诚实陪审员的损失却没有上限。
    ///
    /// 本合约的选择是：**每一轮只对自己那一轮负责。** 一个陪审员承担的风险，
    /// 只来自他实际参与、并且能自己判断的那一场博弈。代价是：初审被推翻时，
    /// 初审的多数派仍然拿到了报酬 —— 这在账面上不好看，但上诉制度的前提
    /// 本来就是「前一轮**可能**是错的」，付钱给初审并不等于宣布初审是对的。
    function tallyRound(uint256 id) external nonReentrant {
        Case storage c = _cases[id];
        if (c.phase != Phase.Reveal) revert BadPhase();
        if (block.timestamp <= c.revealDeadline) revert TooEarly();

        uint256 ri = rounds[id].length - 1;
        uint8 ruling = _tally(id, ri);

        if (ri + 1 < MAX_ROUNDS) {
            c.phase = Phase.Appealable;
            c.appealDeadline = uint64(block.timestamp) + APPEAL_WINDOW;
            emit AppealWindowOpened(id, ri, ruling, c.appealDeadline, appealCost(id));
        } else {
            _finalize(id, _lastRuling(id));
        }
    }

    /// @dev 本轮的计票与罚没。拆成独立函数不只是为了好看 ——
    ///      合在一起局部变量会超出 EVM 的栈深度。
    function _tally(uint256 id, uint256 ri) private returns (uint8 ruling) {
        Round storage r = rounds[id][ri];
        uint256 start = r.voteStart;
        uint256 end = start + r.size;

        uint256 for1;
        uint256 for2;
        uint256 slashed;

        // 先罚没：未揭示者（含从未提交承诺者）一律罚没。
        // 不揭示是对 commit-reveal 最直接的攻击方式 —— 看到风向不对就装死。
        // 必须有成本，否则陪审员会只在有利时才揭示。
        for (uint256 i = start; i < end; i++) {
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

        if (for1 == 0 && for2 == 0) {
            ruling = 0; // 本轮无人揭示 → 本轮无结论
        } else {
            ruling = for1 > for2 ? 1 : 2;
        }

        // 再罚没与本轮多数不一致者
        uint256 coherent;
        if (ruling != 0) {
            for (uint256 i = start; i < end; i++) {
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

        r.ruling = ruling;
        r.coherentCount = coherent;

        // 罚没所得留在本合约的质押池里，按 stakeToken 计价；
        // 服务费按 feeToken 计价。两者币种可能不同，故分开结算：
        // 服务费按席位平分给一致者（claimReward），
        // 罚没所得则直接补进一致者的质押。
        if (coherent > 0 && slashed > 0) {
            uint256 share = slashed / coherent;
            for (uint256 i = start; i < end; i++) {
                Vote storage v = votes[id][i];
                if (v.revealed && v.ruling == ruling) {
                    stakeOf[v.juror] += share;
                    totalStake += share;
                    _treeAdd(jurorId[v.juror], share);
                }
            }
        }

        emit RoundTallied(id, ri, ruling, coherent);
    }

    // ============================================================== 上诉

    /// @notice 下一轮上诉的价钱，以 feeToken 计价。不可上诉时返回 0。
    /// @dev 按席位等价计费：每个陪审员拿到的报酬与第一轮一致。
    ///      所以价钱随陪审团规模一起涨，而不是随「这笔货值多少钱」涨 ——
    ///      后者会让小额交易的当事人上诉不起，而陪审员的工作量并没有变化。
    function appealCost(uint256 id) public view returns (uint256) {
        uint256 n = rounds[id].length;
        if (n == 0 || n >= MAX_ROUNDS) return 0;
        return (_cases[id].baseCost * _nextSize(rounds[id][n - 1].size)) / jurySize;
    }

    /// @dev 下一轮席位数：翻倍加一。保持奇数（避免平票），
    ///      并让「买通多数」的成本随轮次指数上升。
    function _nextSize(uint256 size) private pure returns (uint256) {
        return size * 2 + 1;
    }

    /// @notice 对上一轮的裁决提起上诉：自费重开一轮**更大**的陪审团。
    ///
    /// @dev **为什么需要上诉。** 单轮陪审团的 Schelling point 在证据模糊、
    /// 或者有人肯出钱买票时会失效。没有上诉，这种失效就是终局的，
    /// 而且失效的代价全部由被误判的一方承担。
    ///
    /// **为什么不限制发起人。** 与乐观层的 `challenge` 同理：纠错权是开放的。
    /// 只要有人愿意自掏腰包说「这判错了」，就应该允许他把案子交给更多人看。
    /// 但也要说实话：第三方上诉**没有金钱回报**，赢了只是没输钱。
    /// 现实中发起上诉的基本只会是败诉方本人 —— 对他来说回报是整笔货款。
    ///
    /// **为什么重抽而不是「换一批人」。** 上一轮的陪审员没有被排除在外，
    /// 仍然按质押加权参与抽选。把他们排除掉听起来更公平，实际上
    /// 会给攻击者一个廉价的操控手柄：先让自己的地址中选并故意乱投，
    /// 就能把他们从后续更大的一轮里踢出去。
    ///
    /// **为什么上诉不是免费的重摇。** 每一轮的陪审团都比上一轮大一倍多。
    /// 如果上一轮是对的，更大的一轮只会更对 —— 重摇并不提高翻盘概率，
    /// 却要付出成倍的费用。只有当上一轮确实处在边缘，上诉才划算。
    function appeal(uint256 id) external nonReentrant {
        Case storage c = _cases[id];
        if (c.phase != Phase.Appealable) revert BadPhase();
        if (block.timestamp > c.appealDeadline) revert TooLate();

        uint256 ri = rounds[id].length;
        if (ri >= MAX_ROUNDS) revert NoMoreAppeals();

        uint256 size = _nextSize(rounds[id][ri - 1].size);
        uint256 cost = appealCost(id);

        // 上诉费当场付清，直接成为新一轮的报酬池。
        // 不做「赢了退还」：陪审员的工作是实打实发生的，而退款意味着
        // 这笔工钱最终得由别人出 —— 那个别人只能是对方当事人或协议本身。
        //
        // **先写完全部状态，最后才收钱**（checks-effects-interactions）。
        // 顺序反过来会开一个真实的口子：收钱那一刻 `phase` 还是 Appealable、
        // `rounds.length` 也还没变，带转账回调的代币可以在转账中途重新进入本函数，
        // 两次调用各 push 一轮 —— 一次就把剩余的上诉轮全部耗光，
        // **对方从此再也上诉不了**。而多出来的那一轮没有陪审员，
        // 结案时它的报酬池还会原额退还给攻击者，等于零成本。
        // 现在重入进来会撞上 `phase == Pending` 直接 revert，nonReentrant 是第二道保险。
        rounds[id].push(
            Round({
                ruling: 0,
                voteStart: uint32(votes[id].length),
                size: uint32(size),
                appellant: msg.sender,
                coherentCount: 0,
                rewardPool: cost
            })
        );

        c.phase = Phase.Pending;
        c.drawBlock = uint64(block.number) + DRAW_DELAY;
        c.commitDeadline = 0;
        c.revealDeadline = 0;
        c.appealDeadline = 0;
        c.roundStartedAt = uint64(block.timestamp);
        c.rngSource = address(0);
        c.rngRequestedAt = 0;

        c.feeToken.safeTransferFrom(msg.sender, address(this), cost);

        _requestRandomness(id, ri);
        emit Appealed(id, ri, msg.sender, cost, size);
    }

    /// @notice 上诉窗口届满无人上诉，裁决成为终局裁决。任何人可推动。
    function finalize(uint256 id) external nonReentrant {
        Case storage c = _cases[id];
        if (c.phase != Phase.Appealable) revert BadPhase();
        if (block.timestamp <= c.appealDeadline) revert TooEarly();
        _finalize(id, _lastRuling(id));
    }

    /// @dev 终局裁决取**最后一个真正出了结论的轮次**，而不是简单地取最后一轮。
    ///
    ///      上诉轮全员装死时它的 ruling 是 0。如果直接拿这个 0 当终局，
    ///      托管合约会做中性拆分 —— 于是就有了一条现成的攻击：
    ///      **眼看要输的人先上诉，再让那一轮集体沉默**，
    ///      把一场必输变成五五开。买通一群人「不投票」比买通他们「改投」便宜得多。
    ///
    ///      退回上一轮已经产生的裁决，这条路就不通了：沉默的上诉轮
    ///      唯一的效果是白花一次时间，裁决一个字都没变。
    function _lastRuling(uint256 id) private view returns (uint8) {
        uint256 n = rounds[id].length;
        for (uint256 i = n; i > 0; i--) {
            uint8 r = rounds[id][i - 1].ruling;
            if (r != 0) return r;
        }
        return 0;
    }

    // ============================================================== 结案

    /// @notice 单轮彻底卡死的兜底：陪审员池为空导致长期无法抽选等。
    ///         超过 ROUND_TIMEOUT 后任何人可触发，让资金不至于永久锁死。
    function timeoutCase(uint256 id) external nonReentrant {
        Case storage c = _cases[id];
        if (c.phase == Phase.None || c.phase == Phase.Executed) revert BadPhase();
        if (block.timestamp < uint256(c.roundStartedAt) + ROUND_TIMEOUT) revert TooEarly();

        // 已经出过裁决、只是没人来推进的，按那个裁决结案。
        // 把一个已经产生的裁决丢掉、改判平局，比拖延更糟。
        _finalize(id, _lastRuling(id));
    }

    /// @dev 结案：解锁尚未结算的席位、投递终局裁决、分配各轮报酬。
    function _finalize(uint256 id, uint8 ruling) private {
        Case storage c = _cases[id];
        c.phase = Phase.Executed;
        c.ruling = ruling;

        // 解锁**每一个**尚未结算的席位，不做罚没。
        //
        // 这里刻意不把解锁和领报酬绑在一起：如果一致者的质押要等他自己
        // 来领钱才解锁，那么一个忘了领、或者私钥丢了的陪审员，本金就永远
        // 取不回来 —— 一笔几十块的服务费，不该以锁死本金为代价。
        // 罚没掉的席位在 `_slash` 里已经解锁过，这里按 settled 跳过。
        //
        // `settled` 在这之后只表示「钱已结清」，不再表示「质押已解锁」。
        uint256 n = votes[id].length;
        for (uint256 i = 0; i < n; i++) {
            Vote storage v = votes[id][i];
            if (!v.settled) _unlock(v.juror);
        }

        // 投递裁决。上层会在此调用中把仲裁服务费转入本合约，
        // 所以要在调用后再快照余额变化。
        uint256 balBefore = SafeTransfer.balanceOf(c.feeToken, address(this));
        bool delivered = _deliverRuling(id, c.arbitrable, ruling);
        uint256 feeReceived = SafeTransfer.balanceOf(c.feeToken, address(this)) - balBefore;

        // 第一轮的报酬来自上层的仲裁服务费；上诉轮的报酬在开轮时就已由
        // 发起人付清。顺带把此前回收的无主报酬并进来。
        uint256 carry = recycled[c.feeToken];
        if (carry > 0) recycled[c.feeToken] = 0;
        rounds[id][0].rewardPool += feeReceived + carry;

        _settlePools(id);
        emit CaseFinalized(id, ruling, rounds[id].length, delivered);
    }

    /// @dev 处理「整整一轮没有任何人有资格领报酬」的情况（全员未揭示）。
    ///
    ///      这笔钱不能停在合约里变成永远取不出的死钱，也不该为它给管理员
    ///      开一个提款口 —— 那等于在本合约里引入一个能动用用户资金的角色。
    ///
    ///      - 上诉轮：退还给发起上诉的人。他付钱买的是一轮陪审，而那一轮没开成。
    ///      - 第一轮：顺延给真正做出终局裁决的那一轮。
    ///      - 都不成立：并入 `recycled`，由下一个结案的案件发给它的第一轮陪审员。
    function _settlePools(uint256 id) private {
        Case storage c = _cases[id];
        uint256 n = rounds[id].length;
        Round storage last = rounds[id][n - 1];

        for (uint256 i = 0; i < n; i++) {
            Round storage r = rounds[id][i];
            if (r.coherentCount != 0 || r.rewardPool == 0) continue;

            uint256 amount = r.rewardPool;
            r.rewardPool = 0;

            if (r.appellant != address(0)) {
                c.feeToken.safeTransfer(r.appellant, amount);
                emit AppealFeeRefunded(id, i, r.appellant, amount);
            } else if (i != n - 1 && last.coherentCount > 0) {
                last.rewardPool += amount;
            } else {
                recycled[c.feeToken] += amount;
                emit FeesRecycled(id, c.feeToken, amount);
            }
        }
    }

    /// @dev 投递裁决，但**不允许上层的失败把本合约拖下水**。
    ///
    ///      上层合约有自己的状态机：托管合约在 `resolveStaleDispute`
    ///      触发之后就不再接受裁决，`rule` 会 revert。如果这里不兜住，
    ///      整个 `_finalize` 会一起回滚，案件永远停在非终态，
    ///      **所有被抽中的陪审员的质押就此永久锁死**。
    ///
    ///      投递失败的代价被限制在「本案拿不到服务费」，
    ///      而不是「陪审员的本金取不回来」。
    function _deliverRuling(uint256 id, address arbitrable, uint8 ruling) private returns (bool) {
        try IEscrowArbitrable(arbitrable).rule(id, ruling) {
            return true;
        } catch {
            emit RulingDeliveryFailed(id, arbitrable);
            return false;
        }
    }

    /// @notice 领取本席位那一轮的报酬分成。与该轮多数一致的席位可领。
    function claimReward(uint256 id, uint256 slot) external nonReentrant {
        Case storage c = _cases[id];
        if (c.phase != Phase.Executed) revert BadPhase();

        Vote storage v = votes[id][slot];
        if (v.juror != msg.sender) revert NotYourSlot();
        if (v.settled) revert NothingToClaim();

        Round storage r = rounds[id][v.round];
        if (!v.revealed || r.ruling == 0 || v.ruling != r.ruling || r.coherentCount == 0) revert NothingToClaim();

        // 质押已经在 `_finalize` 里解锁过了，这里只结钱。
        v.settled = true;

        uint256 amount = r.rewardPool / r.coherentCount;
        if (amount > 0) c.feeToken.safeTransfer(msg.sender, amount);
        emit RewardClaimed(id, slot, msg.sender, amount);
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

    /// @notice 配置新轮次默认使用的随机数来源。0 表示不使用。
    ///
    /// @dev 只影响**未来**开的轮次 —— 已开始的轮次用的是自己快照的那一个，
    ///      所以管理员没法在看到一个不想输的案子之后再去换来源。
    ///
    ///      这仍然是一项需要被监督的权力：装一个自己控制的「随机数」合约，
    ///      就能对未来抽选施加影响。合约层的对策是把它的输出与区块哈希
    ///      混合（见 drawJurors），所以这项权力的上限被压到了
    ///      「和出块者研磨区块哈希差不多」，而不是「指定陪审员」。
    function setRandomnessSource(address src) external onlyAdmin {
        emit RandomnessSourceChanged(randomnessSource, src);
        randomnessSource = src;
    }

    function setCost(address token, uint256 cost) external onlyAdmin {
        costOf[token] = cost;
    }

    /// @notice 转移管理员。转给 address(0) 即永久放弃配置权，
    ///         此后仲裁费与随机数来源都冻结 —— 与工厂同一条终局去中心化路径。
    function transferAdmin(address a) external onlyAdmin {
        emit AdminTransferred(admin, a);
        admin = a;
    }

    // ============================================================== 只读

    function jurorCount() external view returns (uint256) {
        return jurors.length;
    }

    function voteCount(uint256 id) external view returns (uint256) {
        return votes[id].length;
    }

    function roundCount(uint256 id) external view returns (uint256) {
        return rounds[id].length;
    }

    /// @notice 前端用：计算投票承诺。salt 必须由陪审员自行保管到揭示阶段。
    function computeCommitment(uint8 ruling, bytes32 salt, address juror) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(ruling, salt, juror));
    }
}

