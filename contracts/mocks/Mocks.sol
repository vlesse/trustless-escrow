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

// ============================================================ 随机数来源

interface IVRFConsumerMock {
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external;
}

/// @notice 假的 Chainlink 协调器。请求只记账，由测试手动触发回调 ——
///         真实环境里回调是异步的，同步 mock 会掩盖「请求已发出但还没回来」
///         这个最需要被测试的中间状态。
contract MockVRFCoordinator {
    uint256 public nextRequestId = 1;
    mapping(uint256 => address) public callerOf;
    bool public failRequests;

    function setFailRequests(bool v) external {
        failRequests = v;
    }

    struct RandomWordsRequest {
        bytes32 keyHash;
        uint256 subId;
        uint16 requestConfirmations;
        uint32 callbackGasLimit;
        uint32 numWords;
        bytes extraArgs;
    }

    function requestRandomWords(RandomWordsRequest calldata) external returns (uint256 id) {
        require(!failRequests, "subscription underfunded");
        id = nextRequestId++;
        callerOf[id] = msg.sender;
    }

    function fulfill(uint256 requestId, uint256 word) external {
        uint256[] memory words = new uint256[](1);
        words[0] = word;
        IVRFConsumerMock(callerOf[requestId]).rawFulfillRandomWords(requestId, words);
    }
}

/// @notice 恶意来源：随时可以返回攻击者指定的「随机数」。
///         用来验证「混合而不是替换」—— 即便这里完全可控，
///         攻击者仍无法单独决定抽选结果。
contract EvilRandomnessSource {
    uint256 public value;
    bool public ready;

    function set(uint256 v) external {
        value = v;
        ready = true;
    }

    function requestRandomness(bytes32) external pure returns (uint256) {
        return 1;
    }

    function randomnessOf(bytes32) external view returns (bool, uint256) {
        return (ready, value);
    }
}

/// @notice 坏掉的来源：请求与查询都 revert。
contract RevertingRandomnessSource {
    function requestRandomness(bytes32) external pure returns (uint256) {
        revert("nope");
    }

    function randomnessOf(bytes32) external pure returns (bool, uint256) {
        revert("nope");
    }
}

/// @notice 烧 gas 的来源：验证限 gas 调用确实能兜住，
///         而不是被它拖着一起 out-of-gas。
contract GasBurningRandomnessSource {
    uint256 private sink;

    function requestRandomness(bytes32) external returns (uint256) {
        while (true) sink++;
        return 0;
    }

    function randomnessOf(bytes32) external view returns (bool, uint256) {
        uint256 x = sink;
        while (true) x = uint256(keccak256(abi.encode(x)));
        return (false, 0);
    }
}

/// @notice 请求成功、查询时烧光 gas 的来源。
///
/// 比 GasBurningRandomnessSource 更刁钻：案件已经把它快照进去了，退不掉，
/// 只能靠调用方的限 gas + 超时兜底。这是「案件绑定了一个坏来源」的最坏情况。
contract LazyGasBurningRandomnessSource {
    uint256 private sink;

    function requestRandomness(bytes32) external pure returns (uint256) {
        return 1;
    }

    function randomnessOf(bytes32) external view returns (bool, uint256) {
        uint256 x = sink;
        while (true) x = uint256(keccak256(abi.encode(x)));
        return (false, 0);
    }
}
