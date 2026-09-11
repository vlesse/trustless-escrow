// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IEscrowArbitrator, IEscrowArbitrable} from "../interfaces/IEscrowArbitrator.sol";

/// @notice 标准 ERC20，transfer 返回 bool。
contract MockERC20 {
    string public name = "Mock USD";
    string public symbol = "mUSD";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a;
        return true;
    }

    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
        return true;
    }

    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[t] += a;
        return true;
    }
}

/// @notice USDT 风格的非标准 ERC20：transfer / transferFrom 不返回任何值。
/// @dev 这是主网与 TRON 上真实 USDT 的行为。用 IERC20 接口直接调用会 revert。
///      本 mock 的存在就是为了确保 SafeTransfer 真的能处理它 ——
///      这是最容易在测试网通过、上主网炸掉的一类 bug。
contract MockUSDT {
    string public name = "Tether USD";
    string public symbol = "USDT";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amt) external {
        balanceOf[to] += amt;
    }

    function approve(address s, uint256 a) external {
        allowance[msg.sender][s] = a;
    }

    function transfer(address to, uint256 a) external {
        balanceOf[msg.sender] -= a;
        balanceOf[to] += a;
    }

    function transferFrom(address f, address t, uint256 a) external {
        allowance[f][msg.sender] -= a;
        balanceOf[f] -= a;
        balanceOf[t] += a;
    }
}

/// @notice 可由测试直接驱动的终局仲裁方，代表「人类质押陪审团 / Kleros adapter」。
contract MockFinalArbitrator is IEscrowArbitrator {
    uint256 public nextID = 1;
    uint256 public cost;
    mapping(uint256 => address) public arbitrableOf;
    mapping(uint256 => uint256) public rulingOf;

    function setCost(uint256 c) external {
        cost = c;
    }

    function arbitrationCost(address, bytes calldata) external view returns (uint256) {
        return cost;
    }

    function createDispute(uint256, bytes calldata) external returns (uint256 id) {
        id = nextID++;
        arbitrableOf[id] = msg.sender;
    }

    function currentRuling(uint256 id) external view returns (uint256) {
        return rulingOf[id];
    }

    /// @notice 测试驱动：投递终局裁决。
    function giveRuling(uint256 id, uint256 ruling) external {
        rulingOf[id] = ruling;
        IEscrowArbitrable(arbitrableOf[id]).rule(id, ruling);
    }
}

/// @notice 直连式仲裁方：不走乐观层，测试直接对托管合约下裁决。
///         用于单独验证 Escrow 的结算数学。
contract DirectArbitrator is IEscrowArbitrator {
    uint256 public nextID = 1;
    uint256 public cost;
    mapping(uint256 => address) public arbitrableOf;

    function setCost(uint256 c) external {
        cost = c;
    }

    function arbitrationCost(address, bytes calldata) external view returns (uint256) {
        return cost;
    }

    function createDispute(uint256, bytes calldata) external returns (uint256 id) {
        id = nextID++;
        arbitrableOf[id] = msg.sender;
    }

    function currentRuling(uint256) external pure returns (uint256) {
        return 0;
    }

    function giveRuling(address arbitrable, uint256 id, uint256 ruling) external {
        IEscrowArbitrable(arbitrable).rule(id, ruling);
    }
}
