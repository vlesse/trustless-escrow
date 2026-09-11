// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title Clones
/// @notice EIP-1167 最小代理。每笔交易部署一个独立托管实例，
///         部署成本约 ~41k gas，而非完整合约的数十万 gas。
/// @dev 这段汇编是 EIP-1167 的标准实现（与 OpenZeppelin Clones 等价）。
///      此处内联而非引入依赖，是为了让整个协议可以在不拉取任何外部包的情况下
///      被独立审计与复现编译。
library Clones {
    error CloneFailed();

    function clone(address implementation) internal returns (address instance) {
        assembly {
            let ptr := mload(0x40)
            mstore(ptr, 0x3d602d80600a3d3981f3363d3d373d3d3d363d73000000000000000000000000)
            mstore(add(ptr, 0x14), shl(0x60, implementation))
            mstore(add(ptr, 0x28), 0x5af43d82803e903d91602b57fd5bf30000000000000000000000000000000000)
            instance := create(0, ptr, 0x37)
        }
        if (instance == address(0)) revert CloneFailed();
    }
}
