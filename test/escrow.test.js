const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

// 金额口径：6 位小数（USDT / USDC）
const U = (n) => BigInt(Math.round(n * 1e6));

const PRICE = U(1000);
const BUYER_BOND = U(1000);
const SELLER_BOND = U(1000);
const FEE_BPS = 50n; // 0.5%
const ARB_COST = U(20);
const FEE = (PRICE * FEE_BPS) / 10000n; // = 5 USDT

const DELIVERY_WINDOW = 3 * 24 * 3600;
const INSPECTION_WINDOW = 2 * 24 * 3600;

const State = {
  None: 0n, Open: 1n, Funded: 2n, Delivered: 3n, Disputed: 4n, Resolved: 5n, Cancelled: 6n,
};

// 一笔交易进入合约的总额，也是结算后必须原额流出的总额
const TOTAL_IN = PRICE + BUYER_BOND + SELLER_BOND;

describe("托管协议", function () {
  let owner, buyer, seller, feeBeneficiary, proposer, challenger, outsider;
  let token, impl, factory, vault, arb;

  async function deployStack(tokenKind = "MockERC20") {
    [owner, buyer, seller, feeBeneficiary, proposer, challenger, outsider] = await ethers.getSigners();

    token = await (await ethers.getContractFactory(tokenKind)).deploy();
    vault = await (await ethers.getContractFactory("FeeVault")).deploy(feeBeneficiary.address);
    impl = await (await ethers.getContractFactory("Escrow")).deploy();
    arb = await (await ethers.getContractFactory("DirectArbitrator")).deploy();
    await arb.setCost(ARB_COST);

    factory = await (await ethers.getContractFactory("EscrowFactory")).deploy(
      await impl.getAddress(), await arb.getAddress(), await vault.getAddress(), FEE_BPS, owner.address
    );

    for (const s of [buyer, seller, proposer, challenger]) {
      await token.mint(s.address, U(100000));
    }
  }

  // 创建并完成双方入金，返回已激活的托管实例
  async function fundedDeal() {
    const termsHash = ethers.keccak256(ethers.toUtf8Bytes("商品：X；交付：Y；验收：Z"));
    const tx = await factory.connect(seller).createDeal(
      await token.getAddress(), buyer.address, seller.address,
      PRICE, BUYER_BOND, SELLER_BOND, DELIVERY_WINDOW, INSPECTION_WINDOW, termsHash
    );
    const rc = await tx.wait();
    const ev = rc.logs.find((l) => l.fragment?.name === "DealCreated");
    const deal = await ethers.getContractAt("Escrow", ev.args.deal);

    await token.connect(seller).approve(await deal.getAddress(), SELLER_BOND);
    await deal.connect(seller).depositSeller();
    await token.connect(buyer).approve(await deal.getAddress(), PRICE + BUYER_BOND);
    await deal.connect(buyer).depositBuyer();
    return deal;
  }

  // 断言资金守恒：合约清零，且各方净变动之和等于总入金
  async function assertConservation(deal, deltas) {
    expect(await token.balanceOf(await deal.getAddress())).to.equal(0n, "托管合约应清零");
    const sum = Object.values(deltas).reduce((a, b) => a + b, 0n);
    expect(sum).to.equal(TOTAL_IN, "各方净变动之和应等于总入金");
  }

  async function balances() {
    return {
      buyer: await token.balanceOf(buyer.address),
      seller: await token.balanceOf(seller.address),
      vault: await token.balanceOf(await vault.getAddress()),
      arb: await token.balanceOf(await arb.getAddress()),
    };
  }

  function diff(before, after) {
    return {
      buyer: after.buyer - before.buyer,
      seller: after.seller - before.seller,
      vault: after.vault - before.vault,
      arb: after.arb - before.arb,
    };
  }

  // ================================================================ 结算数学

  describe("结算数学与资金守恒", function () {
    beforeEach(async () => await deployStack());

    it("正常成交：买家确认收货", async function () {
      const deal = await fundedDeal();
      await deal.connect(seller).markDelivered("ipfs://delivery-proof");

      const b0 = await balances();
      await deal.connect(buyer).confirmReceipt();
      const d = diff(b0, await balances());

      expect(d.seller).to.equal(PRICE - FEE + SELLER_BOND);
      expect(d.buyer).to.equal(BUYER_BOND);
      expect(d.vault).to.equal(FEE);
      expect(d.arb).to.equal(0n);
      expect(await deal.state()).to.equal(State.Resolved);
      await assertConservation(deal, d);
    });

    it("正常成交：验收期届满自动放行，任何人可推动", async function () {
      const deal = await fundedDeal();
      await deal.connect(seller).markDelivered("ipfs://proof");
      await time.increase(INSPECTION_WINDOW + 1);

      const b0 = await balances();
      await deal.connect(outsider).settleAfterInspection(); // 无关第三方即可推动
      const d = diff(b0, await balances());

      expect(d.seller).to.equal(PRICE - FEE + SELLER_BOND);
      expect(d.buyer).to.equal(BUYER_BOND);
      expect(d.vault).to.equal(FEE);
      await assertConservation(deal, d);
    });

    it("卖家逾期未交付：无过错退回，平台不收费", async function () {
      const deal = await fundedDeal();
      await time.increase(DELIVERY_WINDOW + 1);

      const b0 = await balances();
      await deal.connect(buyer).claimNonDelivery();
      const d = diff(b0, await balances());

      expect(d.buyer).to.equal(PRICE + BUYER_BOND);
      expect(d.seller).to.equal(SELLER_BOND);
      expect(d.vault).to.equal(0n, "未成交的交易平台不应收费");
      expect(await deal.state()).to.equal(State.Cancelled);
      await assertConservation(deal, d);
    });

    it("争议裁定买家胜：卖家保证金被罚没，作恶成本不为零", async function () {
      const deal = await fundedDeal();
      await deal.connect(seller).markDelivered("ipfs://proof");
      await deal.connect(buyer).raiseDispute("ipfs://buyer-evidence");

      const b0 = await balances();
      await arb.giveRuling(await deal.getAddress(), await deal.disputeID(), 1);
      const d = diff(b0, await balances());

      expect(d.buyer).to.equal(PRICE + BUYER_BOND + SELLER_BOND - ARB_COST);
      expect(d.seller).to.equal(0n, "违约卖家应颗粒无收");
      expect(d.arb).to.equal(ARB_COST);
      expect(d.vault).to.equal(0n);
      await assertConservation(deal, d);
    });

    it("争议裁定卖家胜：买家恶意申诉同样被罚没", async function () {
      const deal = await fundedDeal();
      await deal.connect(seller).markDelivered("ipfs://proof");
      await deal.connect(buyer).raiseDispute("ipfs://frivolous-claim");

      const b0 = await balances();
      await arb.giveRuling(await deal.getAddress(), await deal.disputeID(), 2);
      const d = diff(b0, await balances());

      expect(d.seller).to.equal(PRICE - FEE + SELLER_BOND + BUYER_BOND - ARB_COST);
      expect(d.buyer).to.equal(0n, "恶意申诉的买家应颗粒无收");
      expect(d.arb).to.equal(ARB_COST);
      expect(d.vault).to.equal(FEE);
      await assertConservation(deal, d);
    });

    it("拒裁/平局：中性拆分，仲裁成本均摊，平台不收费", async function () {
      const deal = await fundedDeal();
      await deal.connect(seller).markDelivered("ipfs://proof");
      await deal.connect(buyer).raiseDispute("ipfs://evidence");

      const b0 = await balances();
      await arb.giveRuling(await deal.getAddress(), await deal.disputeID(), 0);
      const d = diff(b0, await balances());

      expect(d.buyer).to.equal(PRICE + BUYER_BOND - ARB_COST / 2n);
      expect(d.seller).to.equal(SELLER_BOND - (ARB_COST - ARB_COST / 2n));
      expect(d.arb).to.equal(ARB_COST);
      expect(d.vault).to.equal(0n);
      await assertConservation(deal, d);
    });
  });

  // ============================================================ 安全属性

  describe("安全属性", function () {
    beforeEach(async () => await deployStack());

    it("单方无法冻结对方资金：入金前任一方可无损退出", async function () {
      const termsHash = ethers.ZeroHash;
      const tx = await factory.connect(buyer).createDeal(
        await token.getAddress(), buyer.address, seller.address,
        PRICE, BUYER_BOND, SELLER_BOND, DELIVERY_WINDOW, INSPECTION_WINDOW, termsHash
      );
      const rc = await tx.wait();
      const deal = await ethers.getContractAt("Escrow", rc.logs.find((l) => l.fragment?.name === "DealCreated").args.deal);

      // 买家单方入金，卖家从未参与
      await token.connect(buyer).approve(await deal.getAddress(), PRICE + BUYER_BOND);
      await deal.connect(buyer).depositBuyer();
      expect(await deal.state()).to.equal(State.Open, "单方入金不应激活交易");

      const before = await token.balanceOf(buyer.address);
      await deal.connect(buyer).cancelUnfunded();
      expect(await token.balanceOf(buyer.address) - before).to.equal(PRICE + BUYER_BOND, "应全额取回");
      expect(await token.balanceOf(await deal.getAddress())).to.equal(0n);
    });

    it("手续费硬上限：超过 MAX_FEE_BPS 的实例无法初始化", async function () {
      const bad = await (await ethers.getContractFactory("Escrow")).deploy();
      await expect(bad.initialize({
        token: await token.getAddress(), buyer: buyer.address, seller: seller.address,
        feeVault: await vault.getAddress(), arbitrator: await arb.getAddress(),
        price: PRICE, buyerBond: BUYER_BOND, sellerBond: SELLER_BOND,
        deliveryWindow: DELIVERY_WINDOW, inspectionWindow: INSPECTION_WINDOW,
        feeBps: 101, termsHash: ethers.ZeroHash,
      })).to.be.revertedWithCustomError(bad, "FeeTooHigh");
    });

    it("只有仲裁方能下裁决", async function () {
      const deal = await fundedDeal();
      await deal.connect(seller).markDelivered("x");
      await deal.connect(buyer).raiseDispute("x");
      await expect(deal.connect(owner).rule(await deal.disputeID(), 1))
        .to.be.revertedWithCustomError(deal, "NotArbitrator");
      await expect(deal.connect(buyer).rule(await deal.disputeID(), 1))
        .to.be.revertedWithCustomError(deal, "NotArbitrator");
    });

    it("裁决必须匹配本笔争议 ID", async function () {
      const deal = await fundedDeal();
      await deal.connect(seller).markDelivered("x");
      await deal.connect(buyer).raiseDispute("x");
      const wrongID = (await deal.disputeID()) + 999n;
      await expect(arb.giveRuling(await deal.getAddress(), wrongID, 1))
        .to.be.revertedWithCustomError(deal, "UnknownDispute");
    });

    it("非当事人无法操作交易", async function () {
      const deal = await fundedDeal();
      await expect(deal.connect(outsider).markDelivered("x")).to.be.revertedWithCustomError(deal, "NotParty");
      await expect(deal.connect(outsider).confirmReceipt()).to.be.revertedWithCustomError(deal, "NotParty");
      await expect(deal.connect(seller).confirmReceipt()).to.be.revertedWithCustomError(deal, "NotParty");
    });

    it("仲裁方失联：30 天后任何人可解锁资金，且失职方拿不到费用", async function () {
      const deal = await fundedDeal();
      await deal.connect(seller).markDelivered("x");
      await deal.connect(buyer).raiseDispute("x");

      await expect(deal.connect(outsider).resolveStaleDispute())
        .to.be.revertedWithCustomError(deal, "TooEarly");

      await time.increase(45 * 24 * 3600 + 1);
      const b0 = await balances();
      await deal.connect(outsider).resolveStaleDispute();
      const d = diff(b0, await balances());

      expect(d.buyer).to.equal(PRICE + BUYER_BOND);
      expect(d.seller).to.equal(SELLER_BOND);
      expect(d.arb).to.equal(0n, "失职的仲裁方不应获得报酬");
      await assertConservation(deal, d);
    });

    it("保证金不足以覆盖仲裁成本时，交易无法激活", async function () {
      await arb.setCost(U(2000)); // 高于保证金
      const tx = await factory.connect(seller).createDeal(
        await token.getAddress(), buyer.address, seller.address,
        PRICE, BUYER_BOND, SELLER_BOND, DELIVERY_WINDOW, INSPECTION_WINDOW, ethers.ZeroHash
      );
      const rc = await tx.wait();
      const deal = await ethers.getContractAt("Escrow", rc.logs.find((l) => l.fragment?.name === "DealCreated").args.deal);

      await token.connect(seller).approve(await deal.getAddress(), SELLER_BOND);
      await deal.connect(seller).depositSeller();
      await token.connect(buyer).approve(await deal.getAddress(), PRICE + BUYER_BOND);
      await expect(deal.connect(buyer).depositBuyer())
        .to.be.revertedWithCustomError(deal, "BondBelowArbitrationCost");
    });

    it("仲裁成本在锁定时快照：仲裁方事后抬价无法侵蚀保证金", async function () {
      const deal = await fundedDeal();
      expect(await deal.lockedArbCost()).to.equal(ARB_COST);

      await arb.setCost(U(999)); // 交易进行中大幅抬价

      await deal.connect(seller).markDelivered("x");
      await deal.connect(buyer).raiseDispute("x");
      const b0 = await balances();
      await arb.giveRuling(await deal.getAddress(), await deal.disputeID(), 1);
      const d = diff(b0, await balances());

      expect(d.arb).to.equal(ARB_COST, "应按锁定时的成本结算，而非抬价后的");
      await assertConservation(deal, d);
    });
  });

  // ================================================== 非标准 ERC20（USDT）

  describe("USDT 兼容性", function () {
    beforeEach(async () => await deployStack("MockUSDT"));

    it("transfer 不返回值的非标代币可完整跑通全流程", async function () {
      const deal = await fundedDeal();
      await deal.connect(seller).markDelivered("x");

      const b0 = await balances();
      await deal.connect(buyer).confirmReceipt();
      const d = diff(b0, await balances());

      expect(d.seller).to.equal(PRICE - FEE + SELLER_BOND);
      expect(d.buyer).to.equal(BUYER_BOND);
      expect(d.vault).to.equal(FEE);
      await assertConservation(deal, d);
    });
  });

  // ================================================================= 工厂

  describe("工厂配置时间锁", function () {
    beforeEach(async () => await deployStack());

    it("配置变更必须经过 7 天公示期", async function () {
      const newVault = await (await ethers.getContractFactory("FeeVault")).deploy(outsider.address);
      await factory.proposeConfig(await arb.getAddress(), await newVault.getAddress(), 100);

      await expect(factory.applyConfig()).to.be.revertedWithCustomError(factory, "TimelockNotElapsed");

      await time.increase(7 * 24 * 3600 + 1);
      await factory.applyConfig();
      expect(await factory.defaultFeeVault()).to.equal(await newVault.getAddress());
      expect(await factory.defaultFeeBps()).to.equal(100n);
    });

    it("配置变更不影响已存在的交易（逐笔快照）", async function () {
      const deal = await fundedDeal();
      const originalVault = await deal.feeVault();
      const originalFee = await deal.feeBps();

      const newVault = await (await ethers.getContractFactory("FeeVault")).deploy(outsider.address);
      await factory.proposeConfig(await arb.getAddress(), await newVault.getAddress(), 100);
      await time.increase(7 * 24 * 3600 + 1);
      await factory.applyConfig();

      expect(await deal.feeVault()).to.equal(originalVault, "已存在的交易参数不可被事后更改");
      expect(await deal.feeBps()).to.equal(originalFee);

      // 并且实际结算仍按原费率走向原金库
      await deal.connect(seller).markDelivered("x");
      const b0 = await balances();
      await deal.connect(buyer).confirmReceipt();
      expect((await balances()).vault - b0.vault).to.equal(FEE);
      expect(await token.balanceOf(await newVault.getAddress())).to.equal(0n);
    });

    it("费率上限对工厂同样有效", async function () {
      await expect(factory.proposeConfig(await arb.getAddress(), await vault.getAddress(), 101))
        .to.be.revertedWithCustomError(factory, "FeeTooHigh");
    });

    it("非管理员无法变更配置", async function () {
      await expect(factory.connect(outsider).proposeConfig(await arb.getAddress(), await vault.getAddress(), 10))
        .to.be.revertedWithCustomError(factory, "NotAdmin");
    });
  });

  // ========================================================= 手续费金库

  describe("手续费金库透明度", function () {
    beforeEach(async () => await deployStack());

    it("受益地址不可更改，且归集是无权限的", async function () {
      const deal = await fundedDeal();
      await deal.connect(seller).markDelivered("x");
      await deal.connect(buyer).confirmReceipt();

      expect(await vault.pending(await token.getAddress())).to.equal(FEE);

      // 任意路人都能推动归集 —— 运营者无法靠拖延制造账目滞留
      const before = await token.balanceOf(feeBeneficiary.address);
      await vault.connect(outsider).sweep(await token.getAddress());
      expect(await token.balanceOf(feeBeneficiary.address) - before).to.equal(FEE);
      expect(await vault.totalSwept(await token.getAddress())).to.equal(FEE);

      // 金库没有任何改向函数
      expect(vault.interface.fragments.some((f) => /setBeneficiary|withdrawTo|rescue/i.test(f.name ?? ""))).to.equal(false);
    });
  });
});
