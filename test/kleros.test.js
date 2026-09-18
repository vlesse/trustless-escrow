const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * Kleros（ERC-792）适配器。
 *
 * 两边计价币种不同：本协议全程用稳定币，Kleros 用 ETH。适配器对上以 ERC20
 * 报价收费，对下用自己的 ETH 余额替你付 —— 汇率风险落在运营方身上，
 * 而不是落在当事人身上（下单时说好的仲裁成本，不该到争议那天翻倍）。
 *
 * 这里最要紧的一条是活性：ETH 用完时当事人**不能**因此连争议都提不起来。
 * 同类错误这个项目犯过两次（陪审员池为空、案值上限拦在争议环节），
 * 所以这次一开始就把「任何人都能解除」做进去。
 */

const U = (n) => BigInt(Math.round(n * 1e6));
const E = (n) => ethers.parseEther(String(n));

const PRICE = U(1000);
const BOND = U(1000);
const FEE_BPS = 50n;
const ARB_COST = U(60);
const KLEROS_COST = E(0.01);

describe("Kleros 适配器", function () {
  let owner, buyer, seller, feeBene, outsider;
  let token, vault, impl, factory, kleros, adapter;

  beforeEach(async function () {
    [owner, buyer, seller, feeBene, outsider] = await ethers.getSigners();

    token = await (await ethers.getContractFactory("MockERC20")).deploy();
    vault = await (await ethers.getContractFactory("FeeVault")).deploy(feeBene.address);
    impl = await (await ethers.getContractFactory("Escrow")).deploy();
    kleros = await (await ethers.getContractFactory("MockKlerosArbitrator")).deploy(KLEROS_COST);

    // 工厂与适配器互相引用。工厂的仲裁人走 7 天时间锁，没法先占位再改，
    // 所以用 nonce 预测填对地址 —— 与部署脚本同一个做法。
    const nonce = await ethers.provider.getTransactionCount(owner.address);
    const predicted = ethers.getCreateAddress({ from: owner.address, nonce: nonce + 1 });

    factory = await (await ethers.getContractFactory("EscrowFactory")).deploy(
      await impl.getAddress(), predicted, await vault.getAddress(), FEE_BPS, owner.address
    );
    adapter = await (await ethers.getContractFactory("KlerosAdapter")).deploy(
      await kleros.getAddress(), await factory.getAddress(), "0x1234", owner.address
    );
    expect(await adapter.getAddress()).to.equal(predicted, "nonce 预测失败，后面的用例都不成立");

    await adapter.setCost(await token.getAddress(), ARB_COST);
    for (const s of [buyer, seller]) await token.mint(s.address, U(100000));
  });

  const fund = async (wei) =>
    owner.sendTransaction({ to: await adapter.getAddress(), value: wei });

  async function openDeal(t = null) {
    const tokenAddr = t ?? (await token.getAddress());
    const rc = await (await factory.connect(seller).createDeal(
      tokenAddr, buyer.address, seller.address,
      PRICE, BOND, BOND, 3 * 24 * 3600, 2 * 24 * 3600, ethers.ZeroHash
    )).wait();
    return ethers.getContractAt(
      "Escrow", rc.logs.find((l) => l.fragment?.name === "DealCreated").args.deal
    );
  }

  async function deliveredDeal() {
    const deal = await openDeal();
    await token.connect(seller).approve(await deal.getAddress(), BOND);
    await deal.connect(seller).depositSeller();
    await token.connect(buyer).approve(await deal.getAddress(), PRICE + BOND);
    await deal.connect(buyer).depositBuyer();
    await deal.connect(seller).markDelivered("ipfs://x");
    return deal;
  }

  async function disputedDeal() {
    const deal = await deliveredDeal();
    await deal.connect(buyer).raiseDispute("ipfs://e");
    return deal;
  }

  describe("对上以稳定币报价，对下用 ETH 付", function () {
    it("报价与 ETH 价格无关 —— 当事人不承担汇率风险", async function () {
      expect(await adapter.arbitrationCost(await token.getAddress(), "0x")).to.equal(ARB_COST);
      await kleros.setCost(E(10)); // Kleros 那边涨到 1000 倍
      expect(await adapter.arbitrationCost(await token.getAddress(), "0x"))
        .to.equal(ARB_COST, "对上的报价不跟着动");
    });

    it("发起争议时按 Kleros 当时的价钱付 ETH", async function () {
      await fund(E(1));
      const before = await ethers.provider.getBalance(await kleros.getAddress());
      await disputedDeal();
      expect(await ethers.provider.getBalance(await kleros.getAddress()) - before)
        .to.equal(KLEROS_COST);
    });

    it("没配报价的币种一律拒绝，而不是白白烧掉 ETH", async function () {
      await fund(E(1));
      const t2 = await (await ethers.getContractFactory("MockERC20")).deploy();
      for (const a of [seller, buyer]) await t2.mint(a.address, U(10000));
      const deal = await openDeal(await t2.getAddress());
      await t2.connect(seller).approve(await deal.getAddress(), BOND);
      await deal.connect(seller).depositSeller();
      await t2.connect(buyer).approve(await deal.getAddress(), PRICE + BOND);
      await deal.connect(buyer).depositBuyer();
      await deal.connect(seller).markDelivered("ipfs://x");

      // 拦在提起争议这一步（入金时只读报价、不发起争议，所以那时候不会失败）。
      // 这条边界值得留意：币种没配报价，双方是可以正常入金并完成交易的，
      // 只有真要打官司时才会卡住。
      const ethBefore = await ethers.provider.getBalance(await adapter.getAddress());
      await expect(deal.connect(buyer).raiseDispute("ipfs://e"))
        .to.be.revertedWithCustomError(adapter, "CostNotConfigured");
      expect(await ethers.provider.getBalance(await adapter.getAddress()))
        .to.equal(ethBefore, "失败的请求不该花掉任何 ETH");
    });
  });

  describe("ETH 用完了，任何人都能解除", function () {
    it("余额不足时确实提不起争议，补上 ETH 就能继续 —— 不必等运营方", async function () {
      await fund(E(1));
      const deal = await deliveredDeal();

      await kleros.setCost(E(100)); // 远超适配器余额
      await expect(deal.connect(buyer).raiseDispute("ipfs://e"))
        .to.be.revertedWithCustomError(adapter, "InsufficientEth");

      // 还差多少是直接读得出来的
      expect(await adapter.ethShortfall()).to.equal(E(100) - E(1));

      // 想提争议的人自己补上就行
      await outsider.sendTransaction({ to: await adapter.getAddress(), value: E(99) });
      expect(await adapter.ethShortfall()).to.equal(0n);
      await deal.connect(buyer).raiseDispute("ipfs://e");
      expect(await deal.state()).to.equal(4n, "争议已受理");
    });

    it("余额充足时 ethShortfall 是 0", async function () {
      await fund(E(1));
      expect(await adapter.ethShortfall()).to.equal(0n);
    });
  });

  describe("准入：不限制来源等于把 ETH 余额开放给所有人抽干", function () {
    it("既不是工厂登记的交易、也不是上层，一律拒绝", async function () {
      await fund(E(1));
      await expect(adapter.connect(outsider).createDispute(2, "0x"))
        .to.be.revertedWithCustomError(adapter, "NotAllowedCaller");
    });

    it("只接受两选项的争议", async function () {
      await fund(E(1));
      await adapter.setUpstream(outsider.address);
      await expect(adapter.connect(outsider).createDispute(3, "0x"))
        .to.be.revertedWithCustomError(adapter, "BadRuling");
    });
  });

  describe("裁决回传", function () {
    it("买家胜：一路传导回托管合约", async function () {
      await fund(E(1));
      const deal = await disputedDeal();
      const id = await deal.disputeID();
      const b0 = await token.balanceOf(buyer.address);
      await kleros.giveRuling(id, 1);
      expect(await deal.state()).to.equal(5n);
      expect(await adapter.currentRuling(id)).to.equal(1n);
      expect(await token.balanceOf(buyer.address) - b0).to.equal(PRICE + BOND + BOND - ARB_COST);
    });

    it("卖家胜：按正常成交结算，平台照常收费", async function () {
      await fund(E(1));
      const deal = await disputedDeal();
      const s0 = await token.balanceOf(seller.address);
      await kleros.giveRuling(await deal.disputeID(), 2);
      expect(await token.balanceOf(seller.address) - s0)
        .to.equal(PRICE - (PRICE * FEE_BPS) / 10000n + BOND + BOND - ARB_COST);
    });

    it("拒裁：中性拆分，平台不收费", async function () {
      await fund(E(1));
      const deal = await disputedDeal();
      const b0 = await token.balanceOf(buyer.address);
      const v0 = await token.balanceOf(await vault.getAddress());
      await kleros.giveRuling(await deal.disputeID(), 0);
      expect(await token.balanceOf(buyer.address) - b0).to.equal(PRICE + BOND - ARB_COST / 2n);
      expect(await token.balanceOf(await vault.getAddress()) - v0).to.equal(0n);
    });

    it("只认 Kleros 的回调 —— 谁都能投递就等于谁都能判", async function () {
      await fund(E(1));
      const deal = await disputedDeal();
      await expect(adapter.connect(outsider).rule(await deal.disputeID(), 1))
        .to.be.revertedWithCustomError(adapter, "NotKleros");
    });

    it("同一笔争议不能投递两次", async function () {
      await fund(E(1));
      const deal = await disputedDeal();
      const id = await deal.disputeID();
      await kleros.giveRuling(id, 1);
      await expect(kleros.giveRuling(id, 2)).to.be.revertedWithCustomError(adapter, "AlreadyRuled");
    });

    it("上层已自行超时结算时，投递失败不会把这笔争议永远挂在 Kleros 账上", async function () {
      await fund(E(1));
      const deal = await disputedDeal();
      const id = await deal.disputeID();

      await time.increase(45 * 24 * 3600 + 1);
      await deal.connect(outsider).resolveStaleDispute();

      // 托管合约此时已经不接受裁决了。不兜住的话 Kleros 那边会一直投递失败。
      await expect(kleros.giveRuling(id, 1))
        .to.emit(adapter, "RulingReceived").withArgs(id, 1, false);
      expect(await adapter.currentRuling(id)).to.equal(1n, "本地仍然记下了裁决");
    });
  });

  describe("归集", function () {
    it("只归集 ERC20 服务费；本合约不持有任何托管资金", async function () {
      await fund(E(1));
      const deal = await disputedDeal();
      await kleros.giveRuling(await deal.disputeID(), 1);

      const t = await token.getAddress();
      expect(await token.balanceOf(await adapter.getAddress())).to.equal(ARB_COST);

      const before = await token.balanceOf(owner.address);
      await adapter.sweep(t, owner.address);
      expect(await token.balanceOf(owner.address) - before).to.equal(ARB_COST);
      await expect(adapter.sweep(t, owner.address))
        .to.be.revertedWithCustomError(adapter, "NothingToSweep");
    });

    it("只有管理员能归集与改配置", async function () {
      await expect(adapter.connect(outsider).sweep(await token.getAddress(), outsider.address))
        .to.be.revertedWithCustomError(adapter, "NotAdmin");
      await expect(adapter.connect(outsider).setCost(await token.getAddress(), 1n))
        .to.be.revertedWithCustomError(adapter, "NotAdmin");
      await expect(adapter.connect(outsider).setUpstream(outsider.address))
        .to.be.revertedWithCustomError(adapter, "NotAdmin");
    });
  });
});
