// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IRandomnessSource} from "../interfaces/IRandomnessSource.sol";

/// @dev Chainlink VRF v2.5 协调器接口。
///
/// 按本仓库的一贯做法内联声明，而不是引入 npm 包 —— 合约层零外部依赖是
/// 可审计性的前提：读这份代码的人不需要再去核对某个包的版本里到底是什么。
interface IVRFCoordinatorV2Plus {
    struct RandomWordsRequest {
        bytes32 keyHash;
        uint256 subId;
        uint16 requestConfirmations;
        uint32 callbackGasLimit;
        uint32 numWords;
        bytes extraArgs;
    }

    function requestRandomWords(RandomWordsRequest calldata req) external returns (uint256 requestId);
}

/// @title ChainlinkVRFSource
/// @notice `StakedJury` 的 Chainlink VRF v2.5 适配器。
///
/// ## 它做什么
///
/// 把陪审团的「我要一个随机数」翻译成 Chainlink 的订阅式请求，
/// 并把回调结果存下来供陪审团读取。
///
/// ## 它刻意不做什么
///
///   - **没有任何人能修改已经产生的结果。** 允许覆写等于允许在看到抽选
///     结果之后重摇，那比没有随机数更糟。写入只发生一次，由协调器回调触发。
///   - **没有 owner / admin。** keyHash、订阅号、回调参数全部在构造时固定。
///     需要更换就部署一份新的，然后让陪审团指向它 —— 而这只影响未来的案件。
///   - **不主动持有资金。** LINK 由 Chainlink 的订阅账户支付，本合约不碰。
///
/// ## 谁能请求
///
/// 只有构造时指定的 `consumer`（即陪审团合约）。开放给任何人调用，
/// 等于开放一个把订阅余额烧光的入口 —— 余额烧光后随机数请求全部失败，
/// 陪审团会降级回纯 blockhash。这是一个成本极低的降级攻击。
///
/// ## 订阅停摆时会发生什么
///
/// 请求失败 → 陪审团捕获后降级为纯 blockhash（争议照常受理）；
/// 请求成功但回调迟迟不来 → 陪审团等满 `RANDOMNESS_TIMEOUT` 后同样降级。
/// **任何一种情况下资金都不会卡住**，这是接入外部预言机的前提条件。
contract ChainlinkVRFSource is IRandomnessSource {
    IVRFCoordinatorV2Plus public immutable coordinator;

    /// @notice 唯一有权发起请求的地址（陪审团合约）。
    address public immutable consumer;

    bytes32 public immutable keyHash;
    uint256 public immutable subId;
    uint16 public immutable requestConfirmations;
    uint32 public immutable callbackGasLimit;

    /// @notice v2.5 的扩展参数（付费方式等）。
    /// @dev 由部署方按 Chainlink 官方文档填入，而不是在这里硬编码一个魔数 ——
    ///      硬编码的话，读代码的人无从判断它对不对，而填错会让请求全部失败。
    bytes public extraArgs;

    struct Result {
        bool requested;
        bool ready;
        uint256 value;
    }

    mapping(bytes32 => Result) private _results;
    mapping(uint256 => bytes32) public keyOfRequest;

    event Requested(bytes32 indexed key, uint256 indexed requestId);
    event Fulfilled(bytes32 indexed key, uint256 indexed requestId);

    error NotConsumer();
    error NotCoordinator();
    error AlreadyRequested();
    error UnknownRequest();
    error NoWords();
    error ZeroAddress();

    constructor(
        address _coordinator,
        address _consumer,
        bytes32 _keyHash,
        uint256 _subId,
        uint16 _requestConfirmations,
        uint32 _callbackGasLimit,
        bytes memory _extraArgs
    ) {
        if (_coordinator == address(0) || _consumer == address(0)) revert ZeroAddress();
        coordinator = IVRFCoordinatorV2Plus(_coordinator);
        consumer = _consumer;
        keyHash = _keyHash;
        subId = _subId;
        requestConfirmations = _requestConfirmations;
        callbackGasLimit = _callbackGasLimit;
        extraArgs = _extraArgs;
    }

    /// @inheritdoc IRandomnessSource
    function requestRandomness(bytes32 key) external returns (uint256 requestId) {
        if (msg.sender != consumer) revert NotConsumer();
        if (_results[key].requested) revert AlreadyRequested();

        _results[key].requested = true;

        requestId = coordinator.requestRandomWords(
            IVRFCoordinatorV2Plus.RandomWordsRequest({
                keyHash: keyHash,
                subId: subId,
                requestConfirmations: requestConfirmations,
                callbackGasLimit: callbackGasLimit,
                numWords: 1,
                extraArgs: extraArgs
            })
        );

        keyOfRequest[requestId] = key;
        emit Requested(key, requestId);
    }

    /// @notice Chainlink 协调器的回调入口。
    /// @dev 只认协调器。任何人都能调的话，随机数就是随便填的了。
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata randomWords) external {
        if (msg.sender != address(coordinator)) revert NotCoordinator();

        bytes32 key = keyOfRequest[requestId];
        if (key == bytes32(0)) revert UnknownRequest();
        if (randomWords.length == 0) revert NoWords();

        Result storage r = _results[key];
        // 已就绪就直接返回而不是 revert：回调重放不应当让协调器那边报错，
        // 但更不能覆盖已有的值。
        if (r.ready) return;

        r.ready = true;
        r.value = randomWords[0];
        emit Fulfilled(key, requestId);
    }

    /// @inheritdoc IRandomnessSource
    function randomnessOf(bytes32 key) external view returns (bool ready, uint256 value) {
        Result memory r = _results[key];
        return (r.ready, r.value);
    }

    function isRequested(bytes32 key) external view returns (bool) {
        return _results[key].requested;
    }
}
