// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {SafeTransfer} from "../lib/SafeTransfer.sol";

/// @title IdentityBond
/// @notice 把一个匿名地址变成「有成本的身份」。
///
/// ## 它解决的问题
///
/// 声誉只有在「换一个新身份是有代价的」时才有意义。匿名地址的创建成本是零，
/// 所以一个骗子可以骗完就换号，声誉记录永远追不上人 —— 这是一切匿名信誉系统
/// 的根本困难，不是实现细节。
///
/// 交易保证金解决不了这个问题：它每笔交易结束后就退回了，摊到长期几乎为零。
///
/// ## 它到底提供了什么（以及没提供什么）
///
/// **它不是罚金。** 本合约没有任何罚没功能，也没有任何人能罚没 —— 见下方
/// 「不可能做到的事」。单笔交易中作恶的即时代价，来自托管合约里会被罚没的
/// 交易保证金，不在这里。
///
/// 它买的是**年龄**：一笔被持续锁定的资金，加上一个强制的、公开的退出延迟。
/// 钱可以瞬间凑齐，年龄不行 —— 这是整个机制唯一真正稀缺的属性。一个刚创建的
/// 身份，无论押金多高，都无法伪装成一个两年前就在这里的身份。
///
/// 所以对手方应当这样读这个数字：不是「他押了多少钱」，而是
/// **「他为了骗我这一笔，要放弃一个建了多久的身份」**。
///
/// ## 本合约不可能做到的事
///
/// 这一层如果能被人掏空，整个项目就白做了 —— 一个存着所有诚实用户押金的
/// 合约，是比任何单笔交易都肥的猎物。所以：
///
///   - 没有 owner / admin / governance
///   - 没有罚没、没有暂停、没有紧急提取
///   - 没有升级路径
///   - 押金的唯一出口是 `withdraw()`，且只能由押金所有者本人在延迟期满后调用
///
/// 换句话说：**本合约的部署者对这些资金没有任何权力，密钥泄露也拿不走。**
///
/// ## 为什么不做罚没
///
/// 任何罚没都需要一个「谁来判定」的权威，而引入权威就等于引入了可以被收买、
/// 被胁迫、或者自己作恶的一方 —— 那正是本协议存在的理由。
/// 判定已经由仲裁层做了，罚没也已经由托管合约执行了（败诉方的交易保证金）。
/// 在此之上再罚一次身份押金是重复惩罚，还会制造出「故意挑起争议来销毁
/// 对手身份」的攻击面。
///
/// 败诉的后果记录在 `Reputation` 里，公开、永久、不可删除。那是声誉层的惩罚，
/// 不是资金层的。
contract IdentityBond {
    using SafeTransfer for address;

    /// @notice 押金币种。immutable —— 无法被换成一个任意铸造的代币。
    address public immutable token;

    /// @notice 退出延迟。申请解押后必须公示满此时长才能提取。
    ///
    /// @dev 这个延迟是整个机制的关键，不是摆设：没有它，押金可以在作恶的
    ///      同一个区块里被抽走，对手方看到的余额就是假的。有了它，
    ///      「正在退出」这件事会在对手方入金之前就公开可见。
    uint64 public constant UNBOND_DELAY = 14 days;

    struct Bond {
        uint256 amount;
        /// @notice 首次押入的时间。这是「身份年龄」的来源。
        uint64 bondedAt;
        /// @notice 最近一次加仓时间。用于识别「刚临时堆高的押金」。
        uint64 toppedUpAt;
        /// @notice 可提取时间；0 表示未申请解押。
        uint64 unbondableAt;
        /// @notice 历史上发起过多少次解押申请（含已撤销的）。
        uint32 unbondRequests;
    }

    mapping(address => Bond) private _bonds;

    event Bonded(address indexed who, uint256 amount, uint256 total);
    event UnbondRequested(address indexed who, uint256 amount, uint64 unbondableAt);
    event UnbondCancelled(address indexed who, uint256 amount);
    event Withdrawn(address indexed who, uint256 amount);

    error ZeroAmount();
    error NoBond();
    error Unbonding();
    error NotUnbonding();
    error TooEarly();
    error ZeroAddress();
    error Reentrancy();

    bool private _entered;

    modifier nonReentrant() {
        if (_entered) revert Reentrancy();
        _entered = true;
        _;
        _entered = false;
    }

    constructor(address _token) {
        if (_token == address(0)) revert ZeroAddress();
        token = _token;
    }

    // ---------------------------------------------------------------- 押入

    /// @notice 押入或加仓。
    ///
    /// @dev 加仓**不重置** `bondedAt`。诚实用户随生意做大而提高押金是好事，
    ///      不该因此损失已经积累的年龄。代价是「两年前押 1 块、今天堆到 5 万」
    ///      这种情况需要能被看见 —— 所以记录 `toppedUpAt`，由对手方自行判断。
    function bond(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        Bond storage b = _bonds[msg.sender];

        // 解押公示期内不允许加仓：否则「申请退出 → 加仓」会让公示中的数字
        // 与实际可动用的资金脱节，公示本身就失去意义。要加仓请先撤销解押。
        if (b.unbondableAt != 0) revert Unbonding();

        if (b.bondedAt == 0) b.bondedAt = uint64(block.timestamp);
        b.toppedUpAt = uint64(block.timestamp);
        b.amount += amount;

        token.safeTransferFrom(msg.sender, address(this), amount);
        emit Bonded(msg.sender, amount, b.amount);
    }

    // ---------------------------------------------------------------- 退出

    /// @notice 申请解押。整笔，不支持部分。
    ///
    /// @dev 刻意不做部分解押。如果可以只取走一部分，一个身份就能在保留
    ///      「两年年龄」的同时把实际押金抽到接近零 —— 年龄和金额会被拆开
    ///      利用，对手方看到的组合是假的。
    ///      所以：押金只能增加或清零。降低敞口 == 销毁这个身份。
    function requestUnbond() external {
        Bond storage b = _bonds[msg.sender];
        if (b.amount == 0) revert NoBond();
        if (b.unbondableAt != 0) revert Unbonding();

        b.unbondableAt = uint64(block.timestamp) + UNBOND_DELAY;
        b.unbondRequests += 1;
        emit UnbondRequested(msg.sender, b.amount, b.unbondableAt);
    }

    /// @notice 撤销解押申请。
    ///
    /// @dev 撤销**不重置**年龄 —— 一个临时需要流动性又改主意的诚实用户，
    ///      不应当因此损失多年的记录。但撤销**会被计数**（`unbondRequests`），
    ///      因为「反复申请退出又撤回」本身就是一个值得对手方知道的模式。
    ///      把判断权交给对手方，而不是替他决定。
    function cancelUnbond() external {
        Bond storage b = _bonds[msg.sender];
        if (b.unbondableAt == 0) revert NotUnbonding();
        b.unbondableAt = 0;
        emit UnbondCancelled(msg.sender, b.amount);
    }

    /// @notice 提取。公示期满后，只有本人能调用。这是本合约唯一的出金路径。
    function withdraw() external nonReentrant {
        Bond storage b = _bonds[msg.sender];
        if (b.unbondableAt == 0) revert NotUnbonding();
        if (block.timestamp < b.unbondableAt) revert TooEarly();

        uint256 amount = b.amount;
        // 清空而非保留年龄：押金归零即身份销毁，重新押入就是一个新身份，
        // 年龄从头开始。否则「退出 → 骗一票 → 用旧年龄重新进场」是免费的。
        delete _bonds[msg.sender];

        token.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    // ---------------------------------------------------------------- 只读

    function bondOf(address who)
        external
        view
        returns (uint256 amount, uint64 bondedAt, uint64 toppedUpAt, uint64 unbondableAt, uint32 unbondRequests)
    {
        Bond memory b = _bonds[who];
        return (b.amount, b.bondedAt, b.toppedUpAt, b.unbondableAt, b.unbondRequests);
    }

    /// @notice 身份年龄（秒）。押金为零时返回 0 —— 没有押金就没有身份。
    function ageOf(address who) external view returns (uint64) {
        Bond memory b = _bonds[who];
        if (b.amount == 0 || b.bondedAt == 0) return 0;
        return uint64(block.timestamp) - b.bondedAt;
    }

    /// @notice 此刻「实际处于承诺状态」的押金。
    ///
    /// @dev 已申请解押的押金一律按 0 计。它虽然还在合约里，但对手方无法依赖它 ——
    ///      公示期一到就会被取走，而对手方的交易可能还没结束。
    ///      前端必须用这个数字，而不是 `amount`。
    function committedOf(address who) external view returns (uint256) {
        Bond memory b = _bonds[who];
        return b.unbondableAt == 0 ? b.amount : 0;
    }
}
