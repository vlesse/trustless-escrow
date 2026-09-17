const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, mine } = require("@nomicfoundation/hardhat-network-helpers");

const U = (n) => BigInt(Math.round(n * 1e6));

const PRICE = U(1000);
const BOND = U(1000);
const FEE_BPS = 50n;
const FEE = (PRICE * FEE_BPS) / 10000n;

const OPT_COST = U(100);   // 乐观层服务费（托管合约支付给它）
const JURY_COST = U(60);   // 陪审团服务费（乐观层支付给它），必须 <= OPT_COST
const CHAL_BOND = U(50);

const JURY_SIZE = 3n;
const MIN_STAKE = U(1000);
const STAKE_PER_VOTE = U(100);

const commitment = (ruling, salt, juror) =>
  ethers.solidityPackedKeccak256(["uint8", "bytes32", "address"], [ruling, salt, juror]);
const SALT = ethers.id("e2e-salt");
const APPEAL_WINDOW = 2 * 24 * 3600;

/// 全链路：Escrow → OptimisticArbitrator → StakedJury
/// 前面的测试分别用 mock 验证过各层，这里验证三层真实串联时
/// 裁决能一路传导回托管合约，且每一层的钱都对得上。
describe("全链路集成", function () {
  let owner, buyer, seller, feeBene, proposer, challenger, j1, j2, j3, outsider;
  let token, factory, vault, optimistic, jury;

  beforeEach(async function () {
    [owner, buyer, seller, feeBene, proposer, challenger, j1, j2, j3, outsider] = await ethers.getSigners();

    token = await (await ethers.getContractFactory("MockERC20")).deploy();
    vault = await (await ethers.getContractFactory("FeeVault")).deploy(feeBene.address);
    const impl = await (await ethers.getContractFactory("Escrow")).deploy();

    jury = await (await ethers.getContractFactory("StakedJury")).deploy(
      await token.getAddress(), JURY_SIZE, MIN_STAKE, STAKE_PER_VOTE, owner.address
    );
    await jury.setCost(await token.getAddress(), JURY_COST);

    // 用 nonce 预测乐观层地址，让工厂一开始就指向它 ——
    // 与 scripts/deploy.cjs 的做法一致，避免创世时绕过时间锁
    const nonce = await ethers.provider.getTransactionCount(owner.address);
    const predicted = ethers.getCreateAddress({ from: owner.address, nonce: nonce + 1 });

    factory = await (await ethers.getContractFactory("EscrowFactory")).deploy(
      await impl.getAddress(), predicted, await vault.getAddress(), FEE_BPS, owner.address
    );
    optimistic = await (await ethers.getContractFactory("OptimisticArbitrator")).deploy(
      await factory.getAddress(), await jury.getAddress(), proposer.address, owner.address
    );
    expect(await optimistic.getAddress()).to.equal(predicted, "地址预测应命中");

    await optimistic.setCost(await token.getAddress(), OPT_COST, CHAL_BOND);

    for (const s of [buyer, seller, proposer, challenger, j1, j2, j3]) {
      await token.mint(s.address, U(100000));
      await token.connect(s).approve(await optimistic.getAddress(), U(100000));
      await token.connect(s).approve(await jury.getAddress(), U(100000));
    }
    for (const j of [j1, j2, j3]) await jury.connect(j).stake(MIN_STAKE);
  });

  const signerOf = (addr) => [j1, j2, j3].find((s) => s.address === addr);

  it("AI 误判 → 被挑战 → 陪审团推翻 → 裁决一路传导回托管合约", async function () {
    // --- 1. 建单并双方入金 ---
    const rc = await (await factory.connect(seller).createDeal(
      await token.getAddress(), buyer.address, seller.address,
      PRICE, BOND, BOND, 3 * 24 * 3600, 2 * 24 * 3600, ethers.keccak256(ethers.toUtf8Bytes("terms"))
    )).wait();
    const deal = await ethers.getContractAt("Escrow", rc.logs.find((l) => l.fragment?.name === "DealCreated").args.deal);

    await token.connect(seller).approve(await deal.getAddress(), BOND);
    await deal.connect(seller).depositSeller();
    await token.connect(buyer).approve(await deal.getAddress(), PRICE + BOND);
    await deal.connect(buyer).depositBuyer();
    expect(await deal.lockedArbCost()).to.equal(OPT_COST);

    // --- 2. 交付、买家提起争议 ---
    await deal.connect(seller).markDelivered("ipfs://delivery");
    await deal.connect(buyer).raiseDispute("ipfs://buyer-claims-nondelivery");
    const optID = await deal.disputeID();

    // --- 3. AI 误判为买家胜 ---
    await optimistic.connect(proposer).propose(optID, 1);

    // --- 4. 旁观者质押挑战，案件升级到陪审团 ---
    await optimistic.connect(challenger).challenge(optID);
    const juryCaseID = 1n; // 陪审团的第一个案件

    // --- 5. 抽选、提交、揭示：陪审团认定卖家胜 ---
    await mine(11);
    await jury.drawJurors(juryCaseID);
    const n = Number(await jury.voteCount(juryCaseID));
    const slots = [];
    for (let i = 0; i < n; i++) slots.push((await jury.votes(juryCaseID, i)).juror);

    for (let i = 0; i < n; i++) {
      await jury.connect(signerOf(slots[i])).commitVote(juryCaseID, i, commitment(2, SALT, slots[i]));
    }
    await time.increase(3 * 24 * 3600 + 1);
    await jury.startReveal(juryCaseID);
    for (let i = 0; i < n; i++) {
      await jury.connect(signerOf(slots[i])).revealVote(juryCaseID, i, 2, SALT);
    }
    await time.increase(2 * 24 * 3600 + 1);

    // --- 6. 结案，裁决一路传导：陪审团 → 乐观层 → 托管合约 ---
    const before = {
      buyer: await token.balanceOf(buyer.address),
      seller: await token.balanceOf(seller.address),
      vault: await token.balanceOf(await vault.getAddress()),
      challenger: await token.balanceOf(challenger.address),
      jury: await token.balanceOf(await jury.getAddress()),
      optimistic: await token.balanceOf(await optimistic.getAddress()),
    };

    // 经乐观层上来的案子，案值必须一路透传到终局仲裁方
    expect((await jury.cases(juryCaseID)).value).to.equal(
      PRICE + BOND + BOND, "案值要穿过乐观层传到陪审团"
    );

    await jury.connect(outsider).tallyRound(juryCaseID);
    await time.increase(APPEAL_WINDOW + 1); // 无人上诉，裁决才落地
    await jury.connect(outsider).finalize(juryCaseID);

    // 托管合约：按「卖家胜」结算，买家保证金被罚没给卖家
    expect(await deal.state()).to.equal(5n, "应进入 Resolved");
    expect(await token.balanceOf(await deal.getAddress())).to.equal(0n, "托管合约应清零");

    expect(await token.balanceOf(seller.address) - before.seller)
      .to.equal(PRICE - FEE + BOND + (BOND - OPT_COST), "卖家应获赔并吃掉买家保证金");
    expect(await token.balanceOf(buyer.address) - before.buyer)
      .to.equal(0n, "恶意申诉的买家应颗粒无收");
    expect(await token.balanceOf(await vault.getAddress()) - before.vault)
      .to.equal(FEE, "平台按正常成交收费");

    // 乐观层：挑战者推翻了 AI，拿走双份保证金；乐观层净收 OPT_COST - JURY_COST
    expect(await token.balanceOf(challenger.address) - before.challenger)
      .to.equal(CHAL_BOND * 2n, "挑战成功应获得双份保证金");
    expect(await token.balanceOf(await optimistic.getAddress()) - before.optimistic)
      .to.equal(OPT_COST - JURY_COST - CHAL_BOND * 2n, "乐观层应留下服务费差额，并已释放保证金");
    expect(await optimistic.lockedBonds(await token.getAddress())).to.equal(0n, "在途保证金应清零");

    // 陪审团：收到服务费
    expect(await token.balanceOf(await jury.getAddress()) - before.jury)
      .to.equal(JURY_COST, "陪审团应收到服务费");
    const c = await jury.cases(juryCaseID);
    expect(c.ruling).to.equal(2n);
    expect((await jury.rounds(juryCaseID, 0)).rewardPool).to.equal(JURY_COST);

    // 陪审员按席位平分
    for (let i = 0; i < n; i++) {
      const s = signerOf(slots[i]);
      const b = await token.balanceOf(s.address);
      await jury.connect(s).claimReward(juryCaseID, i);
      expect(await token.balanceOf(s.address) - b).to.equal(JURY_COST / BigInt(n));
    }
  });

  it("AI 判对且无人挑战：走快速路径，不惊动陪审团", async function () {
    const rc = await (await factory.connect(seller).createDeal(
      await token.getAddress(), buyer.address, seller.address,
      PRICE, BOND, BOND, 3 * 24 * 3600, 2 * 24 * 3600, ethers.ZeroHash
    )).wait();
    const deal = await ethers.getContractAt("Escrow", rc.logs.find((l) => l.fragment?.name === "DealCreated").args.deal);

    await token.connect(seller).approve(await deal.getAddress(), BOND);
    await deal.connect(seller).depositSeller();
    await token.connect(buyer).approve(await deal.getAddress(), PRICE + BOND);
    await deal.connect(buyer).depositBuyer();
    await deal.connect(seller).markDelivered("ipfs://x");
    await deal.connect(buyer).raiseDispute("ipfs://x");

    const optID = await deal.disputeID();
    await optimistic.connect(proposer).propose(optID, 1); // AI: 买家胜

    await time.increase(48 * 3600 + 1);
    const buyerBefore = await token.balanceOf(buyer.address);
    await optimistic.connect(outsider).execute(optID);

    expect(await token.balanceOf(buyer.address) - buyerBefore).to.equal(PRICE + BOND + BOND - OPT_COST);
    expect(await deal.state()).to.equal(5n);
    expect(await jury.nextCaseID()).to.equal(1n, "陪审团不应被惊动");
  });

  it("配置不一致会被拦住：乐观层服务费低于陪审团成本时无法受理争议", async function () {
    await optimistic.setCost(await token.getAddress(), JURY_COST - 1n, CHAL_BOND);

    const rc = await (await factory.connect(seller).createDeal(
      await token.getAddress(), buyer.address, seller.address,
      PRICE, BOND, BOND, 3 * 24 * 3600, 2 * 24 * 3600, ethers.ZeroHash
    )).wait();
    const deal = await ethers.getContractAt("Escrow", rc.logs.find((l) => l.fragment?.name === "DealCreated").args.deal);

    await token.connect(seller).approve(await deal.getAddress(), BOND);
    await deal.connect(seller).depositSeller();
    await token.connect(buyer).approve(await deal.getAddress(), PRICE + BOND);
    await deal.connect(buyer).depositBuyer();
    await deal.connect(seller).markDelivered("ipfs://x");

    await expect(deal.connect(buyer).raiseDispute("ipfs://x"))
      .to.be.revertedWithCustomError(optimistic, "CostBelowFinalCost");
  });
});
