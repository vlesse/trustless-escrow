// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title IEscrowArbitrator
/// @notice ERC-792 形状的仲裁接口，但费用以 ERC20 计价（而非 ETH），
///         因为本协议的所有资金流都在稳定币里，用 ETH 计价会给双方引入
///         一个与交易无关的价格风险。
///         若要接入 Kleros（ERC-792 / ETH 计价），写一个 adapter 合约实现本接口即可，
///         核心托管合约无需改动。
interface IEscrowArbitrator {
    /// @notice 本次仲裁的成本，以 `token` 计价。由败诉方的保证金支付。
    function arbitrationCost(address token, bytes calldata extraData) external view returns (uint256);

    /// @notice 由 Arbitrable（托管合约）发起争议。
    /// @dev 实现方必须记录 msg.sender 作为该争议的回调地址，
    ///      裁决时只能回调该地址，防止把裁决投递到任意合约。
    /// @param choices 可选裁决数量（本协议固定为 2：1=买家胜，2=卖家胜；0 保留为拒裁/平局）
    /// @return disputeID 仲裁方内部的争议 ID
    function createDispute(uint256 choices, bytes calldata extraData) external returns (uint256 disputeID);

    /// @notice 当前裁决（未决时返回 0）
    function currentRuling(uint256 disputeID) external view returns (uint256);
}

/// @title IEscrowTerms
/// @notice 仲裁方读取被仲裁交易的经济参数。
///
/// @dev 为什么仲裁层必须看得到案值：仲裁方抗贿赂的能力来自陪审员会被罚没的钱，
///      那是一组固定参数；而案值是浮动的。两者不挂钩，就意味着
///      **案值一旦超过「买通过半席位的成本」，买通裁决在结构上就是划算的** ——
///      那不是「可能被贿赂」，是「算出来就该被贿赂」。
///      所以仲裁方必须能读到这个数，才谈得上按它调整规模、定价，或者干脆拒绝受理。
interface IEscrowTerms {
    /// @notice 结算币种。
    function token() external view returns (address);

    /// @notice 本笔交易中「可以被裁决改变归属」的总额。
    function disputeValue() external view returns (uint256);

    /// @notice 交易双方。仲裁层需要知道「被拖延的是谁」，才谈得上补偿他。
    function buyer() external view returns (address);
    function seller() external view returns (address);
}

/// @title IEscrowArbitrable
/// @notice 能被裁决的合约（即托管合约）实现的接口。
interface IEscrowArbitrable {
    /// @notice 仲裁方回调，投递终局裁决。
    /// @param ruling 0 = 拒裁/平局, 1 = 买家胜, 2 = 卖家胜
    function rule(uint256 disputeID, uint256 ruling) external;
}
