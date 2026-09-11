const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const U = (n) => BigInt(Math.round(n * 1e6));

const PRICE = U(1000);
const BOND = U(1000);
const FEE_BPS = 50n;
const ARB_COST = U(20);      // 乐观层收取的仲裁服务费
const CHAL_BOND = U(50);     // 提案人 / 挑战者各自质押
const FINAL_COST = U(30);    // 终局仲裁方的成本

const CHALLENGE_WINDOW = 48 * 3600;
const PROPOSAL_WINDOW = 72 * 3600;

const RULING_BUYER = 1;
const RULING_SELLER = 2;

describe("两级乐观仲裁", function () {
  let owner, buyer, seller, feeBene, proposer, challenger, outsider;
  let token, factory, vault, optimistic, finalArb;

  beforeEach(async function () {
    [owner, buyer, seller, feeBene, proposer, challenger, outsider] = await ethers.getSigners();

    token = await (await ethers.getContractFactory("MockERC20")).deploy();
    vault = await (await ethers.getContractFactory("FeeVault")).deploy(feeBene.address);
    const impl = await (await ethers.getContractFactory("Escrow")).deploy();
    finalArb = await (await ethers.getContractFactory("MockFinalArbitrator")).deploy();
    await finalArb.setCost(FINAL_COST);

    // 先用占位仲裁人部署工厂，再把真正的乐观仲裁层指回工厂（循环依赖）
    factory = await (await ethers.getContractFactory("EscrowFactory")).deploy(
      await impl.getAddress(), await finalArb.getAddress(), await vault.getAddress(), FEE_BPS, owner.address
    );

    optimistic = await (await ethers.getContractFactory("OptimisticArbitrator")).deploy(
      await factory.getAddress(), await finalArb.getAddress(), proposer.address, owner.address
    );
    await optimistic.setCost(await token.getAddress(), ARB_COST, CHAL_BOND);

    await factory.proposeConfig(await optimistic.getAddress(), await vault.getAddress(), FEE_BPS);
    await time.increase(7 * 24 * 3600 + 1);
    await factory.applyConfig();

    for (const s of [buyer, seller, proposer, challenger]) await token.mint(s.address, U(100000));
    for (const s of [proposer, challenger]) {
      await token.connect(s).approve(await optimistic.getAddress(), U(100000));
    }
  });

  // 建一笔已进入争议状态的交易
  async function disputedDeal() {
    const tx = await factory.connect(seller).createDeal(
      await token.getAddress(), buyer.address, seller.address,
      PRICE, BOND, BOND, 3 * 24 * 3600, 2 * 24 * 3600, ethers.ZeroHash
    );
    const rc = await tx.wait();
    const deal = await ethers.getContractAt("Escrow", rc.logs.find((l) => l.fragment?.name === "DealCreated").args.deal);

    await token.connect(seller).approve(await deal.getAddress(), BOND);
    await deal.connect(seller).depositSeller();
    await token.connect(buyer).approve(await deal.getAddress(), PRICE + BOND);
    await deal.connect(buyer).depositBuyer();
    await deal.connect(seller).markDelivered("ipfs://proof");
    await deal.connect(buyer).raiseDispute("ipfs://evidence");
    return { deal, id: await deal.disputeID() };
  }

  it("无人挑战：默认裁决生效，提案人保证金原额退回", async function () {
    const { deal, id } = await disputedDeal();
    await optimistic.connect(proposer).propose(id, RULING_BUYER);

    await expect(optimistic.execute(id)).to.be.revertedWithCustomError(optimistic, "WindowOpen");

    await time.increase(CHALLENGE_WINDOW + 1);
    const pBefore = await token.balanceOf(proposer.address);
    const buyerBefore = await token.balanceOf(buyer.address);

    await optimistic.connect(outsider).execute(id); // 任何人可推动

    expect(await token.balanceOf(proposer.address) - pBefore).to.equal(CHAL_BOND, "提案人保证金应退回");
    expect(await token.balanceOf(buyer.address) - buyerBefore)
      .to.equal(PRICE + BOND + BOND - ARB_COST, "买家应按裁决获赔");
    expect(await deal.state()).to.equal(5n); // Resolved
    expect(await token.balanceOf(await deal.getAddress())).to.equal(0n);
  });

  it("挑战成功：终局裁决推翻 AI，挑战者拿走双份保证金", async function () {
    const { deal, id } = await disputedDeal();
    await optimistic.connect(proposer).propose(id, RULING_BUYER); // AI 认为买家胜

    await optimistic.connect(challenger).challenge(id);
    const cBefore = await token.balanceOf(challenger.address);
    const sellerBefore = await token.balanceOf(seller.address);

    // 终局仲裁推翻：实际是卖家胜
    await finalArb.giveRuling(1, RULING_SELLER);

    const award = CHAL_BOND * 2n - FINAL_COST;
    expect(await token.balanceOf(challenger.address) - cBefore)
      .to.equal(award, "挑战者应获得扣除终局成本后的全部保证金");
    expect(await token.balanceOf(seller.address) - sellerBefore)
      .to.equal(PRICE - (PRICE * FEE_BPS) / 10000n + BOND + BOND - ARB_COST, "卖家应按终局裁决获赔");
    expect(await token.balanceOf(await deal.getAddress())).to.equal(0n);
  });

  it("挑战失败：AI 的结论被终局确认，提案人吃掉挑战者的保证金", async function () {
    const { id } = await disputedDeal();
    await optimistic.connect(proposer).propose(id, RULING_BUYER);
    await optimistic.connect(challenger).challenge(id);

    const pBefore = await token.balanceOf(proposer.address);
    await finalArb.giveRuling(1, RULING_BUYER); // 与 AI 一致

    expect(await token.balanceOf(proposer.address) - pBefore).to.equal(CHAL_BOND * 2n - FINAL_COST);
  });

  it("挑战窗口关闭后无法再挑战", async function () {
    const { id } = await disputedDeal();
    await optimistic.connect(proposer).propose(id, RULING_BUYER);
    await time.increase(CHALLENGE_WINDOW + 1);
    await expect(optimistic.connect(challenger).challenge(id))
      .to.be.revertedWithCustomError(optimistic, "WindowClosed");
  });

  it("AI 下线：超时未提案，任何人可直接升级到终局仲裁", async function () {
    const { deal, id } = await disputedDeal();

    await expect(optimistic.connect(outsider).escalateUnproposed(id))
      .to.be.revertedWithCustomError(optimistic, "WindowOpen");

    await time.increase(PROPOSAL_WINDOW + 1);
    await optimistic.connect(outsider).escalateUnproposed(id);

    const buyerBefore = await token.balanceOf(buyer.address);
    await finalArb.giveRuling(1, RULING_BUYER);

    expect(await token.balanceOf(buyer.address) - buyerBefore).to.equal(PRICE + BOND + BOND - ARB_COST);
    expect(await deal.state()).to.equal(5n);
  });

  it("只有指定的提案人能出具默认裁决", async function () {
    const { id } = await disputedDeal();
    await expect(optimistic.connect(outsider).propose(id, RULING_BUYER))
      .to.be.revertedWithCustomError(optimistic, "NotProposer");
  });

  it("未登记的合约无法发起争议", async function () {
    const fake = await (await ethers.getContractFactory("MockFinalArbitrator")).deploy();
    await expect(optimistic.connect(outsider).createDispute(2, "0x"))
      .to.be.revertedWithCustomError(optimistic, "NotRegisteredDeal");
  });

  it("归集手续费时动不了在途保证金", async function () {
    const { id } = await disputedDeal();
    await optimistic.connect(proposer).propose(id, RULING_BUYER);
    await optimistic.connect(challenger).challenge(id);

    const locked = CHAL_BOND * 2n;
    expect(await optimistic.lockedBonds(await token.getAddress())).to.equal(locked);

    // 模拟一笔已赚到的仲裁服务费进账
    await token.mint(await optimistic.getAddress(), ARB_COST);

    expect(await optimistic.sweepable(await token.getAddress()))
      .to.equal(ARB_COST, "可归集额应只有服务费，不含在途保证金");

    const before = await token.balanceOf(owner.address);
    await optimistic.sweep(await token.getAddress(), owner.address);
    expect(await token.balanceOf(owner.address) - before).to.equal(ARB_COST);

    // 保证金仍在合约里，终局结算照常进行
    expect(await token.balanceOf(await optimistic.getAddress())).to.equal(locked);
    const cBefore = await token.balanceOf(challenger.address);
    await finalArb.giveRuling(1, RULING_SELLER);
    expect(await token.balanceOf(challenger.address) - cBefore).to.equal(locked - FINAL_COST);
  });

  it("重复归集会因无可归集余额而失败", async function () {
    await expect(optimistic.sweep(await token.getAddress(), owner.address))
      .to.be.revertedWithCustomError(optimistic, "NothingToSweep");
  });
});
