const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, mine } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * 不变量测试（带状态的随机序列）。
 *
 * 到 2026-09-18 为止，全部 149 项都是手写的确定性用例：我想到了什么就测什么。
 * 这类测试测不出「我没想到的那条路径」，而资金合约最怕的恰恰是那个。
 *
 * 这里换一种思路：随便走。随机挑一个当下合法的动作，走一步，
 * 然后把**必须永远成立的那几条**全部重新验一遍。走得够多，
 * 就会撞进手写用例覆盖不到的状态组合里。
 *
 * 种子是固定的，所以任何一次失败都可复现 —— 随机测试如果不可复现，
 * 报出来的错没人能查，等于没有。
 */

const U = (n) => BigInt(Math.round(n * 1e6));
const FEE_BPS = 50n;

const JURY_SIZE = 3n;
const MIN_STAKE = U(2000);
const STAKE_PER_VOTE = U(100);
const ARB_COST = U(60);

const DRAW_DELAY = 10;
const COMMIT_WINDOW = 3 * 24 * 3600;
const REVEAL_WINDOW = 2 * 24 * 3600;
const APPEAL_WINDOW = 2 * 24 * 3600;
const DELIVERY = 3 * 24 * 3600;
const INSPECTION = 2 * 24 * 3600;

const State = { None: 0n, Open: 1n, Funded: 2n, Delivered: 3n, Disputed: 4n, Resolved: 5n, Cancelled: 6n };
const SALT = ethers.id("invariant-salt");
const commitment = (r, s, j) =>
  ethers.solidityPackedKeccak256(["uint8", "bytes32", "address"], [r, s, j]);

/// xorshift32。要的不是密码学强度，是**可复现**。
function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 0x100000000;
  };
}

describe("不变量（随机动作序列）", function () {
  this.timeout(180000);

  let owner, feeBene, parties, jurors;
  let token, vault, impl, jury, factory, pool;
  let watched;  // 所有持币地址，用于资金守恒

  async function deployAll() {
    const s = await ethers.getSigners();
    owner = s[0];
    feeBene = s[1];
    parties = s.slice(2, 6);
    jurors = s.slice(6, 12);

    token = await (await ethers.getContractFactory("MockERC20")).deploy();
    vault = await (await ethers.getContractFactory("FeeVault")).deploy(feeBene.address);
    impl = await (await ethers.getContractFactory("Escrow")).deploy();
    jury = await (await ethers.getContractFactory("StakedJury")).deploy(
      await token.getAddress(), JURY_SIZE, MIN_STAKE, STAKE_PER_VOTE, owner.address
    );
    await jury.setCost(await token.getAddress(), ARB_COST);
    factory = await (await ethers.getContractFactory("EscrowFactory")).deploy(
      await impl.getAddress(), await jury.getAddress(), await vault.getAddress(), FEE_BPS, owner.address
    );
    // 陪审团只受理工厂登记过的托管实例（以及乐观层）发起的案件。
    // 不登记的话任何人都能开假案，抽选时锁住真陪审员，再在揭示期结束后
    // 立刻计票，把不知情而没揭示的人当装死罚没。
    await jury.setFactory(await factory.getAddress());
    pool = await (await ethers.getContractFactory("MerchantBond")).deploy(
      await token.getAddress(), await factory.getAddress()
    );
    await factory.setMerchantBond(await pool.getAddress());

    for (const p of [...parties, ...jurors]) {
      await token.mint(p.address, U(50000));
      await token.connect(p).approve(await pool.getAddress(), U(1000000));
      await token.connect(p).approve(await jury.getAddress(), U(1000000));
    }
    for (const j of jurors) await jury.connect(j).stake(MIN_STAKE);

    watched = [
      ...parties.map((p) => p.address), ...jurors.map((j) => j.address),
      feeBene.address, await vault.getAddress(), await jury.getAddress(),
      await pool.getAddress(),
    ];
  }

  async function totalSupplyHeld(deals) {
    let sum = 0n;
    for (const a of watched) sum += await token.balanceOf(a);
    for (const d of deals) sum += await token.balanceOf(d.address);
    return sum;
  }

  /// 每走一步都要重新成立的那几条。任何一条挂掉，前面那一步就是罪魁。
  async function checkInvariants(deals, totalBefore, ctx) {
    const at = (msg) => `${ctx}：${msg}`;

    // 1. 资金守恒。除了铸币，代币不会凭空出现或消失。
    expect(await totalSupplyHeld(deals)).to.equal(totalBefore, at("代币总量发生了变化"));

    for (const d of deals) {
      const e = d.contract;
      const st = await e.state();
      const bal = await token.balanceOf(d.address);

      // 2. 终态的托管合约余额必须归零 —— 一分钱都不许留在里面。
      if (st === State.Resolved || st === State.Cancelled) {
        expect(bal).to.equal(0n, at(`${d.address} 已终态但余额是 ${bal}`));
      } else {
        // 3. 未终态时，余额恰好等于已入金的部分。
        let expected = 0n;
        if (await e.buyerFunded()) expected += d.price + d.buyerBond;
        if (await e.sellerFunded()) expected += d.sellerBond;
        expect(bal).to.equal(expected, at(`${d.address} 余额与入金记录对不上`));
      }

      // 4. 手续费**当且仅当卖家真的拿到了货款**时产生，且恰好是货款的 feeBps。
      //
      //    这一条是随机序列跑出来的：原本按 README 的说法写成「争议路径恒为 0」，
      //    结果第一轮就红了 —— 卖家胜诉那一支是照收手续费的。查下来行为是对的
      //    （卖家胜诉意味着交易确实完成了，买家是恶意申诉），错的是文档，
      //    而且那句话还标着「有测试覆盖」，实际上并没有这个测试。
      //
      //    收费的只有两种终局：Completed(3) 与 DisputeSeller(5)。
      //    和解（Agreed = 8）按卖家实际从买家那里拿到的货款比例收，
      //    应收数额在 agree() 里独立算好了。
      const outcome = await e.outcome();
      if (st === State.Resolved || st === State.Cancelled) {
        const chargeable = outcome === 3n || outcome === 5n;
        const expectedFee = outcome === 8n ? d.agreedFee
          : chargeable ? (d.price * FEE_BPS) / 10000n : 0n;
        expect(d.feeSeen).to.equal(
          expectedFee,
          at(`${d.address} 终局 ${outcome} 的手续费应为 ${expectedFee}`)
        );
      }
    }

    // 5. 陪审团：totalStake 必须等于所有人质押之和。
    //    这一条专门盯 Fenwick 树 —— 它错了不会报错，只会让抽选取到错误的人。
    let sumStake = 0n;
    for (const j of jurors) {
      const st = await jury.stakeOf(j.address);
      sumStake += st;
      // 6. 锁定的质押不可能超过本金，否则解锁时会下溢。
      expect(await jury.lockedOf(j.address)).to.be.lte(st, at(`${j.address} 锁定超过本金`));
    }
    expect(await jury.totalStake()).to.equal(sumStake, at("totalStake 与 stakeOf 之和不一致"));

    // 7. 陪审团合约的余额必须覆盖所有人的质押 —— 覆盖不住就意味着有人取不回本金。
    expect(await token.balanceOf(await jury.getAddress())).to.be.gte(
      sumStake, at("陪审团余额不足以兑付全部质押")
    );

    // 8. 额度池的余额必须覆盖所有商家的额度。
    let sumQuota = 0n;
    for (const p of parties) sumQuota += await pool.balanceOf(p.address);
    expect(await token.balanceOf(await pool.getAddress())).to.equal(
      sumQuota, at("额度池余额与账面额度不一致")
    );
  }

  async function createDeal(buyer, seller, price, bond) {
    const rc = await (await factory.connect(buyer).createDeal(
      await token.getAddress(), buyer.address, seller.address,
      price, bond, bond, DELIVERY, INSPECTION, ethers.ZeroHash
    )).wait();
    const address = rc.logs.find((l) => l.fragment?.name === "DealCreated").args.deal;
    return {
      address, buyer, seller, price, buyerBond: bond, sellerBond: bond,
      contract: await ethers.getContractAt("Escrow", address),
      feeSeen: 0n,
    };
  }

  /// 一笔交易上当前合法的动作。守卫写错会让随机序列一直撞 revert，
  /// 看起来在跑，其实什么都没测到 —— 所以每一步都断言它真的成功了。
  async function legalActions(d) {
    const e = d.contract;
    const st = await e.state();
    const now = await time.latest();
    const acts = [];

    if (st === State.Open) {
      if (!(await e.buyerFunded())) acts.push("depositBuyer");
      if (!(await e.sellerFunded())) acts.push("depositSeller", "fundViaPool");
      acts.push("cancel");
    } else if (st === State.Funded) {
      acts.push("agree");
      // 交付期过后不能再标记交付（防卖家抢跑买家的退款交易）。这条守卫原来没写，
      // 20 条路径一直没抽到这个组合；路径加到 60 条才撞上 —— 测试比合约晚了一版。
      if (now < Number(await e.deliveryDeadline())) acts.push("markDelivered");
      else acts.push("claimNonDelivery", "sellerDispute");
    } else if (st === State.Delivered) {
      acts.push("agree");
      if (now < Number(await e.inspectionDeadline())) {
        acts.push("confirmReceipt", "buyerDispute", "buyerDisputeConcede", "buyerDisputeAgree");
      } else acts.push("settleAfterInspection");
    }
    return acts;
  }

  /// 把一笔争议从头跑到底：抽选 → 投票 → 结轮 → 结案。
  /// 投票结果随机，所以罚没、分成、拒裁、上诉窗口都会被走到。
  async function resolveDispute(d, rand) {
    const id = Number(await d.contract.disputeID());
    await mine(DRAW_DELAY + 1);
    await jury.drawJurors(id);

    const n = Number(await jury.voteCount(id));
    const votes = [];
    for (let i = 0; i < n; i++) {
      const juror = (await jury.votes(id, i)).juror;
      // 1/6 的概率装死不揭示，专门去走罚没那条路
      const r = rand() < 1 / 6 ? null : (rand() < 0.5 ? 1 : 2);
      votes.push({ i, juror, r });
      if (r !== null) {
        await jury.connect(jurors.find((j) => j.address === juror))
          .commitVote(id, i, commitment(r, SALT, juror));
      }
    }
    await time.increase(COMMIT_WINDOW + 1);
    await jury.startReveal(id);
    for (const v of votes) {
      if (v.r === null) continue;
      await jury.connect(jurors.find((j) => j.address === v.juror)).revealVote(id, v.i, v.r, SALT);
    }
    await time.increase(REVEAL_WINDOW + 1);
    await jury.tallyRound(id);

    // 还没终局就走完上诉窗口。这里刻意不上诉 —— 上诉路径由 appeal.test.js
    // 专门覆盖，这里要的是让每一笔争议都能收口，好继续验资金守恒。
    if ((await jury.cases(id)).phase === 4n) {
      await time.increase(APPEAL_WINDOW + 1);
      await jury.finalize(id);
    }
  }

  /// 随机一方提议、另一方接受。应收手续费在这里**用另一种写法独立算一遍**，
  /// 不照抄合约里的公式 —— 照抄的话，公式错了两边一起错，测试照样绿。
  async function agree(d, rand) {
    const e = d.contract;
    const disputed = (await e.state()) === State.Disputed;
    const pool = d.price + d.buyerBond + d.sellerBond - (disputed ? ARB_COST : 0n);
    const toBuyer = (pool * BigInt(Math.floor(rand() * 1001))) / 1000n;   // 0% ~ 100%
    const [from, to] = rand() < 0.5 ? [d.buyer, d.seller] : [d.seller, d.buyer];
    await e.connect(from).offerSettlement(toBuyer);
    await e.connect(to).acceptSettlement(toBuyer);

    // 卖家从买家那里实际拿到的钱 = 他那份减去他自己押进来的押金；按货款封顶
    const sellerShare = pool - toBuyer;
    let paidByBuyer = sellerShare - d.sellerBond;
    if (paidByBuyer < 0n) paidByBuyer = 0n;
    if (paidByBuyer > d.price) paidByBuyer = d.price;
    d.agreedFee = (paidByBuyer * FEE_BPS) / 10000n;
  }

  async function step(d, act, rand) {
    const e = d.contract;
    switch (act) {
      case "depositBuyer":
        await token.connect(d.buyer).approve(d.address, d.price + d.buyerBond);
        await e.connect(d.buyer).depositBuyer();
        return;
      case "depositSeller":
        await token.connect(d.seller).approve(d.address, d.sellerBond);
        await e.connect(d.seller).depositSeller();
        return;
      case "fundViaPool": {
        const bal = await pool.balanceOf(d.seller.address);
        if (bal < d.sellerBond) {
          await pool.connect(d.seller).deposit(d.sellerBond * 2n);
        }
        await pool.connect(d.seller).fundDeal(d.address);
        return;
      }
      case "cancel":
        await e.connect(rand() < 0.5 ? d.buyer : d.seller).cancelUnfunded();
        return;
      case "markDelivered":
        await e.connect(d.seller).markDelivered("ipfs://x");
        return;
      case "confirmReceipt":
        await e.connect(d.buyer).confirmReceipt();
        return;
      case "settleAfterInspection":
        await e.connect(d.buyer).settleAfterInspection();
        return;
      case "claimNonDelivery":
        await e.connect(d.buyer).claimNonDelivery();
        return;
      case "buyerDispute":
        await e.connect(d.buyer).raiseDispute("ipfs://e");
        await resolveDispute(d, rand);
        return;
      case "sellerDispute":
        await e.connect(d.seller).raiseDispute("ipfs://e");
        await resolveDispute(d, rand);
        return;
      case "agree":
        await agree(d, rand);
        return;
      // 起争议后一方认输 / 双方和解，然后**陪审团照常走完**。
      // 交易这时已经结束，陪审团最后回调会失败 —— 要看的就是它有没有把
      // 陪审员的质押、报酬处理干净（不变量 5~7 每一步都在盯）。
      case "buyerDisputeConcede":
        await e.connect(d.buyer).raiseDispute("ipfs://e");
        await e.connect(rand() < 0.5 ? d.buyer : d.seller).concede();
        await resolveDispute(d, rand);
        return;
      case "buyerDisputeAgree":
        await e.connect(d.buyer).raiseDispute("ipfs://e");
        await agree(d, rand);
        await resolveDispute(d, rand);
        return;
      default:
        throw new Error(`未知动作 ${act}`);
    }
  }

  /// 走一步，并把这一步产生的手续费记到这笔交易头上。
  /// 金库余额是所有交易共用的，只有「这一步动的是谁」才能正确归集。
  async function doStep(d, act, rand) {
    const before = await token.balanceOf(await vault.getAddress());
    await step(d, act, rand);
    d.feeSeen += (await token.balanceOf(await vault.getAddress())) - before;
  }

  /// 单笔场景：随机走到底，每一步之后验一遍全部不变量。
  async function scenario(seed) {
    const rand = rng(seed);
    const ctx = `种子 ${seed}`;

    const buyer = parties[Math.floor(rand() * parties.length)];
    let seller = parties[Math.floor(rand() * parties.length)];
    if (seller.address === buyer.address) seller = parties[(parties.indexOf(buyer) + 1) % parties.length];

    const price = U(100 + Math.floor(rand() * 900));
    const bond = U(100 + Math.floor(rand() * 900));
    const d = await createDeal(buyer, seller, price, bond);
    const deals = [d];

    const total = await totalSupplyHeld(deals);
    await checkInvariants(deals, total, `${ctx} 起始`);

    for (let s = 0; s < 8; s++) {
      const acts = await legalActions(d);
      if (acts.length === 0) break;

      let act = acts[Math.floor(rand() * acts.length)];
      // 偶尔把时间推过交付期，好让超时分支也被走到
      if (rand() < 0.25) {
        await time.increase(DELIVERY + INSPECTION + 1);
        const again = await legalActions(d);
        if (again.length === 0) break;
        act = again[Math.floor(rand() * again.length)];
      }

      await doStep(d, act, rand);
      await checkInvariants(deals, total, `${ctx} 第 ${s + 1} 步（${act}）`);
    }
    return d;
  }

  // 60 条：加了认输/和解三种动作之后，20 条路径里「争议中和解」只被抽到过 1 次 ——
  // 通过的意思是「没跑到」还是「跑到了没问题」，分不清。
  it("随机走 60 条路径，每一步之后八条不变量全部成立", async function () {
    await deployAll();
    for (let k = 0; k < 60; k++) {
      await scenario(0x5eed0000 + k * 7919);
    }
  });

  /*
   * 争议中途认输 / 和解，是最容易出事的组合：交易已经结束，陪审团还要把流程
   * 走完，最后回调托管合约会失败。随机序列里这条路径很难被抽到（60 条里只有
   * 一两次），所以这里每条都强制走到争议，再随机认输或随机金额和解。
   */
  it("争议中认输或和解：20 条随机路径，陪审团照常走完，不变量全部成立", async function () {
    await deployAll();
    for (let k = 0; k < 20; k++) {
      const rand = rng(0xc0de0000 + k * 104729);
      const buyer = parties[k % parties.length];
      const seller = parties[(k + 1) % parties.length];
      const d = await createDeal(buyer, seller, U(100 + Math.floor(rand() * 900)), U(100 + Math.floor(rand() * 900)));
      const deals = [d];
      const total = await totalSupplyHeld(deals);
      for (const act of ["depositBuyer", "depositSeller", "markDelivered",
                         rand() < 0.5 ? "buyerDisputeConcede" : "buyerDisputeAgree"]) {
        await doStep(d, act, rand);
        await checkInvariants(deals, total, `争议出口 #${k}（${act}）`);
      }
      expect(await d.contract.state()).to.equal(State.Resolved);
    }
  });

  it("多笔交易并行时，资金守恒与各自的余额记账同时成立", async function () {
    await deployAll();
    const deals = [];
    for (let i = 0; i < 4; i++) {
      deals.push(await createDeal(
        parties[i % parties.length],
        parties[(i + 1) % parties.length],
        U(200 + i * 100), U(150 + i * 50)
      ));
    }
    const total = await totalSupplyHeld(deals);
    const rand = rng(0xc0ffee);

    for (let s = 0; s < 24; s++) {
      const d = deals[Math.floor(rand() * deals.length)];
      const acts = await legalActions(d);
      if (acts.length === 0) continue;
      await doStep(d, acts[Math.floor(rand() * acts.length)], rand);
      await checkInvariants(deals, total, `并行第 ${s + 1} 步`);
    }
  });
});
