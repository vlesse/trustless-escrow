const { expect } = require("chai");
const { ethers } = require("hardhat");

/**
 * 单笔案值上限。
 *
 * 在没有第三方审计预算的阶段，这是唯一能真实封住下行的东西：上线初期定得很低，
 * 跑一段时间没出事再往上放，最坏损失始终有个硬顶。
 *
 * 它是运营层面的风控，不是密码学保证，所以这里要钉住的是它的**边界**：
 * 只影响新交易、碰不到任何资金、调低不能干扰任何已经存在的交易。
 */

const U = (n) => BigInt(Math.round(n * 1e6));
const FEE_BPS = 50n;

describe("单笔案值上限", function () {
  let owner, buyer, seller, feeBene, outsider;
  let token, other, vault, jury, factory;

  beforeEach(async function () {
    [owner, buyer, seller, feeBene, outsider] = await ethers.getSigners();

    token = await (await ethers.getContractFactory("MockERC20")).deploy();
    other = await (await ethers.getContractFactory("MockERC20")).deploy();
    vault = await (await ethers.getContractFactory("FeeVault")).deploy(feeBene.address);
    const impl = await (await ethers.getContractFactory("Escrow")).deploy();

    jury = await (await ethers.getContractFactory("StakedJury")).deploy(
      await token.getAddress(), 3n, U(2000), U(100), owner.address
    );
    await jury.setCost(await token.getAddress(), U(60));
    await jury.setCost(await other.getAddress(), U(60));

    factory = await (await ethers.getContractFactory("EscrowFactory")).deploy(
      await impl.getAddress(), await jury.getAddress(), await vault.getAddress(), FEE_BPS, owner.address
    );

    for (const s of [buyer, seller]) {
      for (const t of [token, other]) {
        await t.mint(s.address, U(1000000));
      }
    }
  });

  const create = (t, price, bBond, sBond) =>
    factory.connect(seller).createDeal(
      t, buyer.address, seller.address, price, bBond, sBond,
      3 * 24 * 3600, 2 * 24 * 3600, ethers.ZeroHash
    );

  async function dealAt(rc) {
    return ethers.getContractAt(
      "Escrow", (await rc.wait()).logs.find((l) => l.fragment?.name === "DealCreated").args.deal
    );
  }

  it("默认不限制 —— 不配置就不改变任何现有行为", async function () {
    expect(await factory.maxDealValue(await token.getAddress())).to.equal(0n);
    await create(await token.getAddress(), U(100000), U(100000), U(100000));
  });

  it("超过上限的交易在**入金之前**就开不出来", async function () {
    // 拦在创建这一步，而不是等起争议时才拦 —— 那时候钱已经锁进去了，
    // 拦住等于剥夺当事人提起争议的权利。
    await factory.setMaxDealValue(await token.getAddress(), U(3000));

    await expect(create(await token.getAddress(), U(1000), U(1000), U(1001)))
      .to.be.revertedWithCustomError(factory, "DealValueTooHigh");

    // 正好卡在线上是允许的
    await create(await token.getAddress(), U(1000), U(1000), U(1000));
  });

  it("上限按币种独立配置", async function () {
    await factory.setMaxDealValue(await token.getAddress(), U(300));
    await create(await other.getAddress(), U(1000), U(1000), U(1000));
    await expect(create(await token.getAddress(), U(1000), U(1000), U(1000)))
      .to.be.revertedWithCustomError(factory, "DealValueTooHigh");
  });

  it("事后调低上限，动不了任何已经存在的交易", async function () {
    // 这条是这项管理员权限能被接受的前提：它只挡新单，
    // 碰不到已入金的钱，也不影响已有交易走完全流程。
    const deal = await dealAt(await create(await token.getAddress(), U(1000), U(1000), U(1000)));

    await factory.setMaxDealValue(await token.getAddress(), 1n); // 几乎卡死

    await token.connect(seller).approve(await deal.getAddress(), U(1000));
    await deal.connect(seller).depositSeller();
    await token.connect(buyer).approve(await deal.getAddress(), U(2000));
    await deal.connect(buyer).depositBuyer();
    await deal.connect(seller).markDelivered("ipfs://x");

    const before = await token.balanceOf(seller.address);
    await deal.connect(buyer).confirmReceipt();

    const fee = (U(1000) * FEE_BPS) / 10000n;
    expect(await token.balanceOf(seller.address) - before).to.equal(U(1000) - fee + U(1000));
    expect(await token.balanceOf(await deal.getAddress())).to.equal(0n, "照常清零");
  });

  it("只有管理员能改，且每次都留痕", async function () {
    await expect(factory.connect(outsider).setMaxDealValue(await token.getAddress(), U(1)))
      .to.be.revertedWithCustomError(factory, "NotAdmin");

    await expect(factory.setMaxDealValue(await token.getAddress(), U(500)))
      .to.emit(factory, "MaxDealValueChanged")
      .withArgs(await token.getAddress(), 0n, U(500));
  });

  it("陪审团的承载力是可以当场算出来的，拿它对着案值看", async function () {
    // 买通过半席位至少要覆盖：过半席位数 × 每席罚没额。
    // 合约不拿它拦人 —— commit-reveal 让贿赂无法执行（收了钱照样可以诚实投票），
    // 真实安全倍数比这个下界高得多，但高多少没人知道。
    // 所以它只作为一个摆出来给人看的数，硬闸开在工厂那一侧。
    expect(await jury.juryCoverage()).to.equal(2n * U(100), "3 席里过半是 2 席");

    const coverage = await jury.juryCoverage();
    await factory.setMaxDealValue(await token.getAddress(), coverage);
    await expect(create(await token.getAddress(), U(150), U(30), U(30)))
      .to.be.revertedWithCustomError(factory, "DealValueTooHigh");
    await create(await token.getAddress(), U(100), U(50), U(50)); // 正好 200
  });
});
