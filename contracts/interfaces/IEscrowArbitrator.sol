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

/// @title IEscrowArbitrable
/// @notice 能被裁决的合约（即托管合约）实现的接口。
interface IEscrowArbitrable {
    /// @notice 仲裁方回调，投递终局裁决。
    /// @param ruling 0 = 拒裁/平局, 1 = 买家胜, 2 = 卖家胜
    function rule(uint256 disputeID, uint256 ruling) external;
}
