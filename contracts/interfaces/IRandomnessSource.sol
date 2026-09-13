// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IRandomnessSource
/// @notice 可插拔的随机数来源。
///
/// ## 为什么要做成接口而不是直接接死 Chainlink
///
/// 接死一家预言机等于给协议引入一个新的单点：它停服、它涨价、它所在的链
/// 不支持它，抽选就没法做了。而抽选没法做 = 争议没法受理 = 资金卡住。
///
/// ## 实现方必须满足的两条
///
/// 1. `randomnessOf` 必须是纯只读，且**在结果产生前后都不能 revert**。
///    调用方会用限制 gas 的 staticcall 调它，任何异常都会被当作「尚未就绪」。
/// 2. 结果一旦产生就**不可更改**。允许覆写等于允许来源方在看到抽选结果后
///    重摇 —— 那比没有随机数更糟。
///
/// ## 调用方必须假设它是恶意的
///
/// 随机数来源是管理员可配置的，因此它天然是一个「管理员可能作恶」的入口。
/// `StakedJury` 的对策是**混合而不是替换**：最终种子由本来源的输出与
/// 区块哈希一起哈希得到。所以即便这里返回的是攻击者指定的数字，
/// 他仍需同时操纵区块哈希才能左右抽选 —— 安全性不会低于完全不用本接口时。
interface IRandomnessSource {
    /// @notice 为 `key` 请求一个随机数。
    /// @dev 失败请直接 revert，调用方会捕获并降级，不会因此阻断争议创建。
    function requestRandomness(bytes32 key) external returns (uint256 requestId);

    /// @notice 查询结果。
    /// @return ready 是否已就绪；false 时 `value` 无意义
    /// @return value 随机数
    function randomnessOf(bytes32 key) external view returns (bool ready, uint256 value);
}
