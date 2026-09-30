const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, mine } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * 认输与和解。
 *
 * 仲裁最快两天，走到陪审团至少一周，钱在这段时间里谁都动不了。原来双方
 * 就算已经谈妥、或者一方自知理亏，也只能干等仲裁走完。这两条出口要保证三件事：
 *   1. 钱算得对：认输和被判输一分不差；和解的手续费按卖家实际拿到的货款收
 *   2. 不能被利用：抢跑改价、自己接受自己的提议、争议前的提议带进争议
 *   3. 仲裁层照常走完，**没有任何人的钱被锁住**（提案人、挑战人、陪审员）
 */

const U = (n) => BigInt(Math.round(n * 1e6));
const PRICE = U(1000);
const BOND = U(1000);
const TOTAL = PRICE + BOND + BOND;
const FEE_BPS = 50n;
const FEE = (PRICE * FEE_BPS) / 10000n;
const DELIVERY = 3 * 24 * 3600;
const INSPECTION = 2 * 24 * 3600;
const TERMS = ethers.keccak256(ethers.toUtf8Bytes("terms"));

const Outcome = { DisputeBuyer: 4n, DisputeSeller: 5n, Agreed: 8n };
const State = { Funded: 2n, Delivered: 3n, Disputed: 4n, Resolved: 5n };

// ======================================================================
// 一、钱怎么分：用最简单的仲裁替身，只看托管合约自己的账
// ======================================================================

describe("认输与和解：资金分配", function () {
  const ARB_COST = U(20);
  let buyer, seller, outsider, token, factory, vault, arb;

  beforeEach(async function () {
    let owner, feeBene;
    [owner, buyer, seller, feeBene, outsider] = await ethers.getSigners();
    token = await (await ethers.getContractFactory("MockERC20")).deploy();
    vault = await (await ethers.getContractFactory("FeeVault")).deploy(feeBene.address);
    const impl = await (await ethers.getContractFactory("Escrow")).deploy();
    arb = await (await ethers.getContractFactory("DirectArbitrator")).deploy();
    await arb.setCost(ARB_COST);
    factory = await (await ethers.getContractFactory("EscrowFactory")).deploy(
      await impl.getAddress(), await arb.getAddress(), await vault.getAddress(), FEE_BPS, owner.address);
    for (const s of [buyer, seller]) await token.mint(s.address, U(100000));
  });

  async function funded() {
    const rc = await (await factory.connect(seller).createDeal(await token.getAddress(),
      buyer.address, seller.address, PRICE, BOND, BOND, DELIVERY, INSPECTION, TERMS)).wait();
    const deal = await ethers.getContractAt("Escrow", rc.logs.find((l) => l.fragment?.name === "DealCreated").args.deal);
    await token.connect(seller).approve(await deal.getAddress(), BOND);
    await deal.connect(seller).depositSeller();
    await token.connect(buyer).approve(await deal.getAddress(), PRICE + BOND);
    await deal.connect(buyer).depositBuyer();
    return deal;
  }
  async function delivered() {
    const d = await funded();
    await d.connect(seller).markDelivered("x");
    return d;
  }
  async function disputed() {
    const d = await delivered();
    await d.connect(buyer).raiseDispute("x");
    return d;
  }

  /// 执行 fn，返回各方净变动，并断言托管合约清零、总数守恒
  async function deltas(deal, fn) {
    const who = { buyer: buyer.address, seller: seller.address, vault: await vault.getAddress(), arb: await arb.getAddress() };
    const bal = async () => Object.fromEntries(await Promise.all(
      Object.entries(who).map(async ([k, a]) => [k, await token.balanceOf(a)])));
    const b0 = await bal();
    await fn();
    const b1 = await bal();
    const d = Object.fromEntries(Object.keys(who).map((k) => [k, b1[k] - b0[k]]));
    expect(await token.balanceOf(await deal.getAddress())).to.equal(0n, "托管合约必须清零");
    expect(d.buyer + d.seller + d.vault + d.arb).to.equal(TOTAL, "钱一个 wei 都不能多也不能少");
    return d;
  }

  // ------------------------------------------------------------ 认输

  describe("认输", function () {
    it("认输和被判输一分不差 —— 否则会有人专挑划算的那条路走", async function () {
      for (const [loser, ruling] of [["seller", 1n], ["buyer", 2n]]) {
        const ruled = await disputed();
        const rid = await ruled.disputeID();
        const byRuling = await deltas(ruled, () => arb.giveRuling(ruled, rid, ruling));
        const conceded = await disputed();
        const signer = loser === "buyer" ? buyer : seller;
        const byConcede = await deltas(conceded, () => conceded.connect(signer).concede());
        expect(byConcede).to.deep.equal(byRuling, `${loser} 认输应当等同于被判 ${ruling}`);
        expect(await conceded.outcome()).to.equal(await ruled.outcome(), "信誉层看到的结局也必须一样");
      }
    });

    it("卖家认输：买家拿回全部 + 卖家押金扣掉仲裁费，平台不收费", async function () {
      const deal = await disputed();
      const d = await deltas(deal, () => deal.connect(seller).concede());
      expect(d).to.deep.equal({ buyer: TOTAL - ARB_COST, seller: 0n, vault: 0n, arb: ARB_COST });
      expect(await deal.outcome()).to.equal(Outcome.DisputeBuyer);
    });

    it("只有争议中、只有当事人能认输", async function () {
      const d = await delivered();
      await expect(d.connect(seller).concede()).to.be.revertedWithCustomError(d, "BadState");
      await d.connect(buyer).raiseDispute("x");
      await expect(d.connect(outsider).concede()).to.be.revertedWithCustomError(d, "NotParty");
    });

    it("认输之后仲裁层再来裁决会失败（仲裁层必须自己接住，见下面的全链路测试）", async function () {
      const d = await disputed();
      await d.connect(seller).concede();
      await expect(arb.giveRuling(d, await d.disputeID(), 2n)).to.be.revertedWithCustomError(d, "BadState");
    });
  });

  // ------------------------------------------------------------ 和解

  describe("和解", function () {
    it("验收中和解：按约定分，不付仲裁费，结局记为 Agreed", async function () {
      const deal = await delivered();
      const toBuyer = BOND + U(300);                       // 退买家押金 + 300 货款
      await deal.connect(seller).offerSettlement(toBuyer);
      const d = await deltas(deal, () => deal.connect(buyer).acceptSettlement(toBuyer));
      const sellerGross = TOTAL - toBuyer;                  // 卖家押金 + 700 货款
      const fee = (U(700) * FEE_BPS) / 10000n;              // 只对实际拿到的 700 收
      expect(d).to.deep.equal({ buyer: toBuyer, seller: sellerGross - fee, vault: fee, arb: 0n });
      expect(await deal.state()).to.equal(State.Resolved);
      expect(await deal.outcome()).to.equal(Outcome.Agreed);
    });

    it("手续费按卖家实际拿到的货款收：全额退款不收，全额成交与正常成交一样", async function () {
      // 卖家只拿回自己的押金 = 全额退款
      let deal = await delivered();
      await deal.connect(seller).offerSettlement(PRICE + BOND);
      let d = await deltas(deal, () => deal.connect(buyer).acceptSettlement(PRICE + BOND));
      expect(d.vault).to.equal(0n, "退款不收手续费");
      expect(d.seller).to.equal(BOND);

      // 买家只拿回押金 = 卖家全额成交
      deal = await delivered();
      await deal.connect(buyer).offerSettlement(BOND);
      d = await deltas(deal, () => deal.connect(seller).acceptSettlement(BOND));
      expect(d.vault).to.equal(FEE, "和正常成交收得一样多，不能多也不能少");

      // 买家一分不拿（卖家连对方押金也拿走）：手续费封顶在货款那一份
      deal = await delivered();
      await deal.connect(buyer).offerSettlement(0n);
      d = await deltas(deal, () => deal.connect(seller).acceptSettlement(0n));
      expect(d.vault).to.equal(FEE, "平台不能从纠纷里比正常成交赚得更多");
    });

    it("争议中和解：先留出仲裁费，再按约定分", async function () {
      const deal = await disputed();
      await expect(deal.connect(buyer).offerSettlement(TOTAL - ARB_COST + 1n))
        .to.be.revertedWithCustomError(deal, "AmountTooLarge");
      const toBuyer = (TOTAL - ARB_COST) / 2n;
      await deal.connect(buyer).offerSettlement(toBuyer);
      const d = await deltas(deal, () => deal.connect(seller).acceptSettlement(toBuyer));
      expect(d.arb).to.equal(ARB_COST, "争议中和解照付仲裁费");
      expect(d.buyer).to.equal(toBuyer);
    });

    it("交付前也能和解（比如卖家发现货发不出来，主动退款）", async function () {
      const deal = await funded();
      await deal.connect(seller).offerSettlement(PRICE + BOND);
      const d = await deltas(deal, () => deal.connect(buyer).acceptSettlement(PRICE + BOND));
      expect(d).to.deep.equal({ buyer: PRICE + BOND, seller: BOND, vault: 0n, arb: 0n });
    });

    /*
     * 抢跑：接受交易进了内存池，提议方抢先把提议改成对自己更有利的数。
     * 接受时必须带上金额 —— 改过的提议对不上，接受直接失败。
     */
    it("接受时金额必须一字不差：提议被抢先改掉，接受就失败", async function () {
      const deal = await delivered();
      await deal.connect(seller).offerSettlement(U(1500));
      await deal.connect(seller).offerSettlement(U(1100));      // 抢在买家接受前改价
      await expect(deal.connect(buyer).acceptSettlement(U(1500)))
        .to.be.revertedWithCustomError(deal, "NoMatchingOffer");
      expect(await deal.state()).to.equal(State.Delivered, "什么都没发生");
    });

    it("不能接受自己的提议；局外人不能提也不能接", async function () {
      const deal = await delivered();
      await deal.connect(seller).offerSettlement(U(1500));
      await expect(deal.connect(seller).acceptSettlement(U(1500))).to.be.revertedWithCustomError(deal, "NoMatchingOffer");
      await expect(deal.connect(outsider).acceptSettlement(U(1500))).to.be.revertedWithCustomError(deal, "NotParty");
      await expect(deal.connect(outsider).offerSettlement(1n)).to.be.revertedWithCustomError(deal, "NotParty");
    });

    it("对方可以还价：新提议覆盖旧的，原提议方接受还价", async function () {
      const deal = await delivered();
      await deal.connect(seller).offerSettlement(U(1200));
      await deal.connect(buyer).offerSettlement(U(1600));        // 买家还价
      expect(await deal.offerBy()).to.equal(buyer.address);
      await deltas(deal, () => deal.connect(seller).acceptSettlement(U(1600)));
    });

    it("撤回：只有提议人能撤，撤回后无法接受", async function () {
      const deal = await delivered();
      await deal.connect(seller).offerSettlement(U(1500));
      await expect(deal.connect(buyer).cancelSettlementOffer()).to.be.revertedWithCustomError(deal, "NotParty");
      await deal.connect(seller).cancelSettlementOffer();
      await expect(deal.connect(buyer).acceptSettlement(U(1500))).to.be.revertedWithCustomError(deal, "NoMatchingOffer");
    });

    /*
     * 争议前谈的分法是按「不付仲裁费」算的。争议一开，可分配的钱少了一份仲裁费，
     * 旧提议原样留着，接受方就会拿到一个对方从没同意过的结果。
     */
    it("起争议时作废之前的提议", async function () {
      const deal = await delivered();
      await deal.connect(seller).offerSettlement(U(1500));
      await deal.connect(buyer).raiseDispute("x");
      expect(await deal.offerBy()).to.equal(ethers.ZeroAddress);
      await expect(deal.connect(buyer).acceptSettlement(U(1500))).to.be.revertedWithCustomError(deal, "NoMatchingOffer");
    });

    it("交易以别的方式结束后，挂着的提议被清掉，也无法再接受", async function () {
      const deal = await delivered();
      await deal.connect(seller).offerSettlement(U(1500));
      await deal.connect(buyer).confirmReceipt();
      expect(await deal.offerBy()).to.equal(ethers.ZeroAddress, "前端不能看到一份已经失效的「待接受」");
      await expect(deal.connect(buyer).acceptSettlement(U(1500))).to.be.revertedWithCustomError(deal, "BadState");
    });

    it("还没双方入金时不能谈（那时任一方本来就能无损取消）", async function () {
      const rc = await (await factory.connect(seller).createDeal(await token.getAddress(),
        buyer.address, seller.address, PRICE, BOND, BOND, DELIVERY, INSPECTION, TERMS)).wait();
      const deal = await ethers.getContractAt("Escrow", rc.logs.find((l) => l.fragment?.name === "DealCreated").args.deal);
      await expect(deal.connect(seller).offerSettlement(1n)).to.be.revertedWithCustomError(deal, "BadState");
    });
  });
});

// ======================================================================
// 二、仲裁层照常走完，谁的钱都没被锁住：真实的乐观层 + 陪审团
// ======================================================================

describe("认输与和解：仲裁层照常走完，没有钱被锁住", function () {
  const OPT_COST = U(100), JURY_COST = U(60), CHAL_BOND = U(50);
  const MIN_STAKE = U(1000), STAKE_PER_VOTE = U(100);
  const SALT = ethers.id("settle-salt");
  const commitment = (r, s, j) => ethers.solidityPackedKeccak256(["uint8", "bytes32", "address"], [r, s, j]);

  let owner, buyer, seller, proposer, challenger, j1, j2, j3;
  let token, factory, optimistic, jury, reputation;

  beforeEach(async function () {
    let feeBene;
    [owner, buyer, seller, feeBene, proposer, challenger, j1, j2, j3] = await ethers.getSigners();
    token = await (await ethers.getContractFactory("MockERC20")).deploy();
    const vault = await (await ethers.getContractFactory("FeeVault")).deploy(feeBene.address);
    const impl = await (await ethers.getContractFactory("Escrow")).deploy();
    jury = await (await ethers.getContractFactory("StakedJury")).deploy(
      await token.getAddress(), 3n, MIN_STAKE, STAKE_PER_VOTE, owner.address);
    await jury.setCost(await token.getAddress(), JURY_COST);
    const nonce = await ethers.provider.getTransactionCount(owner.address);
    const predicted = ethers.getCreateAddress({ from: owner.address, nonce: nonce + 1 });
    factory = await (await ethers.getContractFactory("EscrowFactory")).deploy(
      await impl.getAddress(), predicted, await vault.getAddress(), FEE_BPS, owner.address);
    optimistic = await (await ethers.getContractFactory("OptimisticArbitrator")).deploy(
      await factory.getAddress(), await jury.getAddress(), proposer.address, owner.address);
    await jury.setFactory(await factory.getAddress());
    await jury.setUpstream(await optimistic.getAddress());
    await optimistic.setCost(await token.getAddress(), OPT_COST, CHAL_BOND);
    reputation = await (await ethers.getContractFactory("Reputation")).deploy(await factory.getAddress());

    for (const s of [buyer, seller, proposer, challenger, j1, j2, j3]) {
      await token.mint(s.address, U(100000));
      await token.connect(s).approve(await optimistic.getAddress(), U(100000));
      await token.connect(s).approve(await jury.getAddress(), U(100000));
    }
    for (const j of [j1, j2, j3]) await jury.connect(j).stake(MIN_STAKE);
  });

  async function disputedDeal() {
    const rc = await (await factory.connect(seller).createDeal(await token.getAddress(),
      buyer.address, seller.address, PRICE, BOND, BOND, DELIVERY, INSPECTION, TERMS)).wait();
    const deal = await ethers.getContractAt("Escrow", rc.logs.find((l) => l.fragment?.name === "DealCreated").args.deal);
    await token.connect(seller).approve(await deal.getAddress(), BOND);
    await deal.connect(seller).depositSeller();
    await token.connect(buyer).approve(await deal.getAddress(), PRICE + BOND);
    await deal.connect(buyer).depositBuyer();
    await deal.connect(seller).markDelivered("x");
    await deal.connect(buyer).raiseDispute("x");
    return deal;
  }

  it("AI 提案之后卖家认输：挑战期满照常执行，提案人押金原额退回", async function () {
    const deal = await disputedDeal();
    const id = await deal.disputeID();
    await optimistic.connect(proposer).propose(id, 1);
    const p0 = await token.balanceOf(proposer.address);

    await deal.connect(seller).concede();
    expect(await token.balanceOf(await deal.getAddress())).to.equal(0n);

    await time.increase(48 * 3600 + 1);
    await optimistic.execute(id);   // 回调托管合约会失败，但必须被接住
    expect(await token.balanceOf(proposer.address) - p0).to.equal(CHAL_BOND, "提案人押金必须退回");
    expect(await optimistic.lockedBonds(await token.getAddress())).to.equal(0n, "乐观层不能留下在途押金");
  });

  it("陪审团投票期间双方和解：陪审团照常走完，质押全部解锁、报酬照发、押金照结", async function () {
    const deal = await disputedDeal();
    const id = await deal.disputeID();
    await optimistic.connect(proposer).propose(id, 1);
    await optimistic.connect(challenger).challenge(id);
    await mine(11);
    await jury.drawJurors(1n);
    const n = Number(await jury.voteCount(1n));
    const slots = [];
    for (let i = 0; i < n; i++) slots.push((await jury.votes(1n, i)).juror);
    const signerOf = (a) => [j1, j2, j3].find((s) => s.address === a);
    for (let i = 0; i < n; i++) await jury.connect(signerOf(slots[i])).commitVote(1n, i, commitment(2, SALT, slots[i]));

    // —— 投票期间，双方谈妥：各拿一半（扣掉仲裁费之后）
    const half = (TOTAL - OPT_COST) / 2n;
    await deal.connect(buyer).offerSettlement(half);
    await deal.connect(seller).acceptSettlement(half);
    expect(await deal.state()).to.equal(State.Resolved);
    expect(await token.balanceOf(await deal.getAddress())).to.equal(0n);

    // —— 陪审团照常走完
    await time.increase(3 * 24 * 3600 + 1);
    await jury.startReveal(1n);
    for (let i = 0; i < n; i++) await jury.connect(signerOf(slots[i])).revealVote(1n, i, 2, SALT);
    await time.increase(2 * 24 * 3600 + 1);
    await jury.tallyRound(1n);
    await time.increase(2 * 24 * 3600 + 1);
    const c0 = await token.balanceOf(challenger.address);
    await jury.finalize(1n);   // 一路回调到托管合约会失败，必须被接住

    for (const j of [j1, j2, j3]) {
      expect(await jury.lockedOf(j.address)).to.equal(0n, "陪审员质押必须全部解锁");
    }
    expect(await token.balanceOf(challenger.address) - c0).to.equal(CHAL_BOND * 2n, "挑战押金照常按裁决结算");
    expect(await optimistic.lockedBonds(await token.getAddress())).to.equal(0n);
    // 陪审员报酬照发：领得出来
    const s = signerOf(slots[0]);
    const b = await token.balanceOf(s.address);
    await jury.connect(s).claimReward(1n, 0);
    expect(await token.balanceOf(s.address)).to.be.greaterThan(b, "陪审员干了活就要拿到报酬");
  });

  it("信誉层：认输记为败诉，和解单独计数、不算争议", async function () {
    const a = await disputedDeal();
    await a.connect(seller).concede();
    await reputation.record(await a.getAddress());
    expect((await reputation.recordOf(seller.address)).disputesLost).to.equal(1n, "认输就是承认自己错了");

    const b = await disputedDeal();
    await b.connect(buyer).offerSettlement(U(100));
    await b.connect(seller).acceptSettlement(U(100));
    await reputation.record(await b.getAddress());
    expect(await reputation.settledByAgreementOf(buyer.address)).to.equal(1n);
    expect(await reputation.settledByAgreementOf(seller.address)).to.equal(1n);
    expect((await reputation.recordOf(buyer.address)).disputesInconclusive).to.equal(0n, "和解不能记成「未定责争议」");
  });
});

// ======================================================================
// 三、用户签名前看到的数字 == 链上实际分出去的数字
// ======================================================================

/*
 * 机器人和签名页在签名前告诉用户「你拿多少、对方拿多少」，用的是
 * services/signing-page/split.js。这里拿真实合约的结算结果逐个比对 ——
 * 公式有一个 wei 对不上，用户签下的就是一个他没看到过的结果。
 */
describe("签名前展示的分钱结果与链上一致", function () {
  const split = require("../services/signing-page/split.js");
  const ARB_COST = U(20) + 1n;   // 奇数，专门测仲裁费两边各半时的取整
  let buyer, seller, token, factory, arb;

  beforeEach(async function () {
    let owner, feeBene;
    [owner, buyer, seller, feeBene] = await ethers.getSigners();
    token = await (await ethers.getContractFactory("MockERC20")).deploy();
    const vault = await (await ethers.getContractFactory("FeeVault")).deploy(feeBene.address);
    const impl = await (await ethers.getContractFactory("Escrow")).deploy();
    arb = await (await ethers.getContractFactory("DirectArbitrator")).deploy();
    await arb.setCost(ARB_COST);
    factory = await (await ethers.getContractFactory("EscrowFactory")).deploy(
      await impl.getAddress(), await arb.getAddress(), await vault.getAddress(), FEE_BPS, owner.address);
    for (const s of [buyer, seller]) await token.mint(s.address, U(1000000));
  });

  async function deal(price, bond, disputed) {
    const rc = await (await factory.connect(seller).createDeal(await token.getAddress(),
      buyer.address, seller.address, price, bond, bond, DELIVERY, INSPECTION, TERMS)).wait();
    const d = await ethers.getContractAt("Escrow", rc.logs.find((l) => l.fragment?.name === "DealCreated").args.deal);
    await token.connect(seller).approve(await d.getAddress(), bond);
    await d.connect(seller).depositSeller();
    await token.connect(buyer).approve(await d.getAddress(), price + bond);
    await d.connect(buyer).depositBuyer();
    await d.connect(seller).markDelivered("x");
    if (disputed) await d.connect(buyer).raiseDispute("x");
    const view = { price, buyerBond: bond, sellerBond: bond, feeBps: FEE_BPS,
      lockedArbCost: await d.lockedArbCost(), disputed };
    return { d, view };
  }

  async function paid(d, fn) {
    const rc = await (await fn()).wait();
    const ev = rc.logs.map((l) => { try { return d.interface.parseLog(l); } catch { return null; } })
      .find((x) => x && x.name === "Settled");
    return { toBuyer: ev.args.toBuyer, toSeller: ev.args.toSeller, fee: ev.args.fee, cost: ev.args.toArbitrator };
  }

  it("和解：各种金额、争议前后，展示的数与实际结算完全一致", async function () {
    let seed = 12345;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    for (let k = 0; k < 16; k++) {
      const price = U(10 + Math.floor(rand() * 5000)) + BigInt(Math.floor(rand() * 999));
      const bond = U(ARB_COST_UNITS()) + BigInt(Math.floor(rand() * 999));
      const disputed = k % 2 === 1;
      const { d, view } = await deal(price, bond, disputed);
      // 按「退多少货款」出价（机器人的问法），也覆盖边界：全退、不退
      const refund = k % 4 === 0 ? price : k % 4 === 2 ? 0n : (price * BigInt(Math.floor(rand() * 1000))) / 1000n;
      const toBuyer = split.toBuyerForRefund(view, refund);
      const want = split.settlementSplit(view, toBuyer);
      expect(split.refundOf(view, toBuyer)).to.equal(refund, "退款金额要能原样还原");
      await d.connect(buyer).offerSettlement(toBuyer);
      const got = await paid(d, () => d.connect(seller).acceptSettlement(toBuyer));
      expect(got).to.deep.equal({ toBuyer: want.toBuyer, toSeller: want.toSeller, fee: want.fee, cost: want.cost },
        `第 ${k} 笔（${disputed ? "争议中" : "验收中"}，退款 ${refund}）`);
    }
    function ARB_COST_UNITS() { return 25; }   // 押金至少要盖住仲裁费
  });

  it("认输：展示的数与实际结算完全一致", async function () {
    for (const who of ["buyer", "seller"]) {
      const { d, view } = await deal(U(777) + 3n, U(333) + 7n, true);
      const want = split.concedeSplit(view, who);
      const got = await paid(d, () => d.connect(who === "buyer" ? buyer : seller).concede());
      expect(got).to.deep.equal({ toBuyer: want.toBuyer, toSeller: want.toSeller, fee: want.fee, cost: want.cost }, who);
    }
  });

  it("超出可分配总额的金额：展示层也拒绝，与合约一致", async function () {
    const { d, view } = await deal(U(100), U(100), true);
    const pool = view.price + view.buyerBond + view.sellerBond - view.lockedArbCost;
    expect(split.settlementSplit(view, pool + 1n)).to.equal(null);
    await expect(d.connect(buyer).offerSettlement(pool + 1n)).to.be.revertedWithCustomError(d, "AmountTooLarge");
  });
});
