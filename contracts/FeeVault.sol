// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {SafeTransfer} from "./lib/SafeTransfer.sol";

/// @title FeeVault
/// @notice 协议手续费的唯一归集地址。
///
/// 设计目标是让「创造者收入」这件事完全可审计，任何人无需信任运营者即可核对：
///
///   1. beneficiary 是 immutable —— 部署后永远无法更改。运营者不能在积累一段时间后
///      把收款地址悄悄改到别处，也不能被私钥泄露者改走。
///   2. 没有任何提取到「其它地址」的函数。金库里的钱只有一个出口：beneficiary。
///      连部署者本人也无法把资金转去第三个地址。
///   3. 每一笔流入（FeeReceived）与流出（Swept）都有事件，且 totalReceived /
///      totalSwept 按币种链上累计，可被区块浏览器与任何独立索引器直接核对。
///   4. sweep() 是 permissionless 的 —— 任何人都可以触发归集，
///      运营者无法通过「不归集」来制造不透明的账目滞留。
///
/// beneficiary 通常是一个冷钱包。冷钱包本身不会暴露持有者身份，
/// 但它收到的每一分钱都是公开可查的 —— 这正是「收入透明」与「身份隐私」
/// 可以同时成立的原因：审计的是资金流，不是人。
contract FeeVault {
    using SafeTransfer for address;

    /// @notice 唯一且永久的受益地址。
    address public immutable beneficiary;

    /// @notice 按币种累计的历史总流入（由 recordFee 记账）。
    mapping(address => uint256) public totalReceived;

    /// @notice 按币种累计的历史总归集。
    mapping(address => uint256) public totalSwept;

    event FeeReceived(address indexed token, address indexed from, uint256 amount);
    event Swept(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error NothingToSweep();

    constructor(address _beneficiary) {
        if (_beneficiary == address(0)) revert ZeroAddress();
        beneficiary = _beneficiary;
    }

    /// @notice 可选的记账钩子。托管合约用 ERC20 直接转账进本合约，
    ///         无法触发回调，因此链下索引器应以 Escrow 的 Settled 事件为准；
    ///         本函数供未来的主动记账场景使用，不影响资金安全。
    function recordFee(address token, uint256 amount) external {
        totalReceived[token] += amount;
        emit FeeReceived(token, msg.sender, amount);
    }

    /// @notice 把本金库中某币种的全部余额归集到 beneficiary。
    /// @dev 无权限控制是刻意的：任何人都可以推动归集，
    ///      运营者无法靠拖延归集来模糊账目。
    function sweep(address token) external returns (uint256 amount) {
        amount = SafeTransfer.balanceOf(token, address(this));
        if (amount == 0) revert NothingToSweep();
        totalSwept[token] += amount;
        token.safeTransfer(beneficiary, amount);
        emit Swept(token, beneficiary, amount);
    }

    /// @notice 当前待归集余额。
    function pending(address token) external view returns (uint256) {
        return SafeTransfer.balanceOf(token, address(this));
    }
}
