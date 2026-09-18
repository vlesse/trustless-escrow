// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title SafeTransfer
/// @notice 处理非标准 ERC20。USDT（以太坊主网与 TRON 上）的 transfer/transferFrom
///         不返回 bool，直接用 IERC20 接口调用会因 ABI 解码失败而 revert。
///         这里用低阶 call，并接受「无返回值」与「返回 true」两种情况。
library SafeTransfer {
    error TransferFailed();
    error TransferFromFailed();
    error ApproveFailed();

    function safeTransfer(address token, address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(0xa9059cbb, to, amount)); // transfer(address,uint256)
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function safeTransferFrom(address token, address from, address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(0x23b872dd, from, to, amount)); // transferFrom(address,address,uint256)
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFromFailed();
    }

    /// @dev 调用方必须保证调用时当前额度为 0。USDT 这类代币在额度非 0 时
    ///      再次 approve 会直接 revert，本库不替调用方做归零 ——
    ///      需要归零的场景应该显式写出来，而不是藏在这里。
    function safeApprove(address token, address spender, uint256 amount) internal {
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(0x095ea7b3, spender, amount)); // approve(address,uint256)
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert ApproveFailed();
    }

    function balanceOf(address token, address who) internal view returns (uint256) {
        (bool ok, bytes memory data) =
            token.staticcall(abi.encodeWithSelector(0x70a08231, who)); // balanceOf(address)
        if (!ok || data.length < 32) return 0;
        return abi.decode(data, (uint256));
    }
}
