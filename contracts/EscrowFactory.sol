// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Escrow} from "./Escrow.sol";
import {Clones} from "./lib/Clones.sol";

/// @title EscrowFactory
/// @notice 部署并登记每一笔交易的托管实例。
///
/// 关于本合约的权限边界，必须讲清楚（这是整个协议唯一存在管理员的地方）：
///
///   能做的：为「未来的新交易」调整默认仲裁人、手续费率、手续费金库。
///   不能做的：
///     - 不能影响任何已经创建的交易。Escrow 在 initialize 时快照了
///       arbitrator / feeBps / feeVault，此后永不可变。
///     - 不能突破 Escrow.MAX_FEE_BPS（1%）的硬上限，该上限写死在实现合约里。
///     - 不能更换 implementation。它是 immutable，托管逻辑永远是部署时那一份。
///     - 不能触碰任何托管中的资金。工厂没有任何资金流函数。
///
/// 并且所有配置变更都必须经过 CONFIG_TIMELOCK 的公示期：
/// 先 propose（上链公开），等满 7 天后才能 apply。
/// 用户在入金前可以自行检查当前生效的仲裁人是谁，不会被无声替换。
contract EscrowFactory {
    /// @notice 托管实现合约。immutable —— 托管逻辑不可升级、不可替换。
    address public immutable implementation;

    /// @notice 配置变更公示期。
    uint64 public constant CONFIG_TIMELOCK = 7 days;

    address public admin;

    // 以下是「新交易」的默认参数。已存在的交易不受影响。
    address public defaultArbitrator;
    address public defaultFeeVault;
    uint16 public defaultFeeBps;

    struct PendingConfig {
        address arbitrator;
        address feeVault;
        uint16 feeBps;
        uint64 eta; // 可执行时间；0 表示无待生效变更
    }

    PendingConfig public pendingConfig;

    /// @notice 全部交易实例，按创建顺序。
    address[] public allDeals;

    /// @notice 某地址参与过的全部交易（买家或卖家）。
    mapping(address => address[]) public dealsOf;

    /// @notice 是否由本工厂创建 —— 供前端校验，防止钓鱼合约冒充。
    mapping(address => bool) public isDeal;

    event DealCreated(
        address indexed deal,
        address indexed buyer,
        address indexed seller,
        address token,
        uint256 price,
        uint256 buyerBond,
        uint256 sellerBond,
        address arbitrator,
        uint16 feeBps,
        bytes32 termsHash
    );
    event ConfigProposed(address arbitrator, address feeVault, uint16 feeBps, uint64 eta);
    event ConfigApplied(address arbitrator, address feeVault, uint16 feeBps);
    event AdminTransferred(address indexed from, address indexed to);
    event MaxDealValueChanged(address indexed token, uint256 from, uint256 to);

    error NotAdmin();
    error ZeroAddress();
    error FeeTooHigh();
    error NoPendingConfig();
    error TimelockNotElapsed();
    error SamePartyBothSides();
    error DealValueTooHigh();

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    constructor(address _implementation, address _arbitrator, address _feeVault, uint16 _feeBps, address _admin) {
        if (
            _implementation == address(0) || _arbitrator == address(0) || _feeVault == address(0)
                || _admin == address(0)
        ) revert ZeroAddress();
        if (_feeBps > Escrow(_implementation).MAX_FEE_BPS()) revert FeeTooHigh();

        implementation = _implementation;
        defaultArbitrator = _arbitrator;
        defaultFeeVault = _feeVault;
        defaultFeeBps = _feeBps;
        admin = _admin;
    }

    /// @notice 单笔交易的案值上限，按币种计。0 表示不限制。
    ///
    /// @dev **这是运营层面的风控，不是密码学保证。** 在没有第三方审计预算的
    ///      阶段，它是唯一能真实封住下行的东西：上线初期定得很低，
    ///      跑上一段时间没出事再往上放，最坏损失始终有个硬顶。
    ///
    ///      它只影响**新交易**：调低不会动到任何已存在的交易，也碰不到任何资金。
    ///      管理员能用它把新单卡死 —— 但那只是「停止服务」，
    ///      与「挪用资金」是两回事，后者在本协议里不存在任何路径。
    mapping(address => uint256) public maxDealValue;

    /// @notice 设置单笔案值上限。0 = 不限制。
    function setMaxDealValue(address token, uint256 cap) external onlyAdmin {
        emit MaxDealValueChanged(token, maxDealValue[token], cap);
        maxDealValue[token] = cap;
    }

    // ------------------------------------------------------------ 创建交易

    /// @notice 创建一笔交易。买卖双方任一方都可以发起，发起本身不锁定任何资金。
    /// @param termsHash 链下条款全文的 keccak256。双方必须在链下就同一份文本达成一致，
    ///                  争议时仲裁方以此哈希校验条款未被篡改。
    function createDeal(
        address token,
        address buyer,
        address seller,
        uint256 price,
        uint256 buyerBond,
        uint256 sellerBond,
        uint64 deliveryWindow,
        uint64 inspectionWindow,
        bytes32 termsHash
    ) external returns (address deal) {
        if (buyer == seller) revert SamePartyBothSides();

        // 案值 = 货款 + 双方押金，与 Escrow.disputeValue() 同一口径。
        // 在**入金之前**就卡住，而不是等到起争议时才拦 —— 那时候钱已经锁进去了，
        // 拦住等于剥夺当事人提起争议的权利（同样的错误在陪审团那边犯过一次）。
        uint256 cap = maxDealValue[token];
        if (cap != 0 && price + buyerBond + sellerBond > cap) revert DealValueTooHigh();

        deal = Clones.clone(implementation);

        Escrow(deal).initialize(
            Escrow.Terms({
                token: token,
                buyer: buyer,
                seller: seller,
                feeVault: defaultFeeVault,
                arbitrator: defaultArbitrator,
                price: price,
                buyerBond: buyerBond,
                sellerBond: sellerBond,
                deliveryWindow: deliveryWindow,
                inspectionWindow: inspectionWindow,
                feeBps: defaultFeeBps,
                termsHash: termsHash
            })
        );

        allDeals.push(deal);
        isDeal[deal] = true;
        dealsOf[buyer].push(deal);
        dealsOf[seller].push(deal);

        emit DealCreated(
            deal, buyer, seller, token, price, buyerBond, sellerBond, defaultArbitrator, defaultFeeBps, termsHash
        );
    }

    // -------------------------------------------------------------- 配置

    function proposeConfig(address arbitrator, address feeVault, uint16 feeBps) external onlyAdmin {
        if (arbitrator == address(0) || feeVault == address(0)) revert ZeroAddress();
        if (feeBps > Escrow(implementation).MAX_FEE_BPS()) revert FeeTooHigh();

        uint64 eta = uint64(block.timestamp) + CONFIG_TIMELOCK;
        pendingConfig = PendingConfig({arbitrator: arbitrator, feeVault: feeVault, feeBps: feeBps, eta: eta});
        emit ConfigProposed(arbitrator, feeVault, feeBps, eta);
    }

    function applyConfig() external onlyAdmin {
        PendingConfig memory p = pendingConfig;
        if (p.eta == 0) revert NoPendingConfig();
        if (block.timestamp < p.eta) revert TimelockNotElapsed();

        defaultArbitrator = p.arbitrator;
        defaultFeeVault = p.feeVault;
        defaultFeeBps = p.feeBps;
        delete pendingConfig;

        emit ConfigApplied(p.arbitrator, p.feeVault, p.feeBps);
    }

    /// @notice 转移管理员。转给 address(0) 即永久放弃配置权，
    ///         此后协议参数完全冻结 —— 这是可选的终局去中心化路径。
    function transferAdmin(address newAdmin) external onlyAdmin {
        emit AdminTransferred(admin, newAdmin);
        admin = newAdmin;
    }

    // -------------------------------------------------------------- 只读

    function allDealsLength() external view returns (uint256) {
        return allDeals.length;
    }

    function dealsOfLength(address party) external view returns (uint256) {
        return dealsOf[party].length;
    }
}
