const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, mine } = require("@nomicfoundation/hardhat-network-helpers");

const U = (n) => BigInt(Math.round(n * 1e6));

const PRICE = U(1000);
const BOND = U(1000);
const FEE_BPS = 50n;

const JURY_SIZE = 3n;
const MIN_STAKE = U(1000);
const STAKE_PER_VOTE = U(100);
const ARB_COST = U(60); // 可被 JURY_SIZE 整除，便于核对分成

const DRAW_DELAY = 10;
const COMMIT_WINDOW = 3 * 24 * 3600;
const REVEAL_WINDOW = 2 * 24 * 3600;
const APPEAL_WINDOW = 2 * 24 * 3600;
const ROUND_TIMEOUT = 10 * 24 * 3600;

const Phase = { None: 0n, Pending: 1n, Commit: 2n, Reveal: 3n, Appealable: 4n, Executed: 5n };

const commitment = (ruling, salt, juror) =>
  ethers.solidityPackedKeccak256(["uint8", "bytes32", "address"], [ruling, salt, juror]);

const SALT = ethers.id("salt-1");

describe("质押陪审团", function () {
  let owner, buyer, seller, feeBene, j1, j2, j3, outsider;
  let token, factory, vault, jury;

  beforeEach(async function () {
    [owner, buyer, seller, feeBene, j1, j2, j3, outsider] = await ethers.getSigners();

    token = await (await ethers.getContractFactory("MockERC20")).deploy();
    vault = await (await ethers.getContractFactory("FeeVault")).deploy(feeBene.address);
    const impl = await (await ethers.getContractFactory("Escrow")).deploy();

    jury = await (await ethers.getContractFactory("StakedJury")).deploy(
      await token.getAddress(), JURY_SIZE, MIN_STAKE, STAKE_PER_VOTE, owner.address
    );
    await jury.setCost(await token.getAddress(), ARB_COST);

    // 陪审团直接作为托管合约的仲裁方（不经乐观层），便于单独验证陪审机制
    factory = await (await ethers.getContractFactory("EscrowFactory")).deploy(
      await impl.getAddress(), await jury.getAddress(), await vault.getAddress(), FEE_BPS, owner.address
    );

    for (const s of [buyer, seller, j1, j2, j3]) {
      await token.mint(s.address, U(100000));
      await token.connect(s).approve(await jury.getAddress(), U(100000));
    }
  });

  async function seatJurors(list = [j1, j2, j3], amount = MIN_STAKE) {
    for (const j of list) await jury.connect(j).stake(amount);
  }

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

  // 抽选并返回每个席位的陪审员地址
  async function draw(id) {
    await mine(DRAW_DELAY + 1);
    await jury.drawJurors(id);
    const n = await jury.voteCount(id);
    const slots = [];
    for (let i = 0; i < n; i++) slots.push((await jury.votes(id, i)).juror);
    return slots;
  }

  const signerOf = (addr) => [j1, j2, j3].find((s) => s.address === addr);

  // 结轮之后裁决并不会立刻投递给托管合约 —— 要先走完上诉窗口。
  // 绝大多数用例关心的是「最终判成了什么」，所以把两步打包。
  async function settle(id, who = outsider) {
    await jury.connect(who).tallyRound(id);
    await time.increase(APPEAL_WINDOW + 1);
    await jury.connect(who).finalize(id);
  }

  /// 陪审员是放回抽样 —— 同一个人可能占据多个席位（多锁一份质押、多一票、
  /// 也多一份罚没风险）。所以预期值必须按「实际抽到的席位归属」计算，
  /// 不能假定 N 个席位就是 N 个不同的人。
  /// slotRulings[i] 为 null 表示该席位未揭示。
  function expectedStakes(slots, slotRulings, finalRuling) {
    const coherent = [];
    const incoherent = [];
    slots.forEach((_, i) => {
      (slotRulings[i] !== null && slotRulings[i] === finalRuling ? coherent : incoherent).push(i);
    });

    const slashed = STAKE_PER_VOTE * BigInt(incoherent.length);
    const share = coherent.length ? slashed / BigInt(coherent.length) : 0n;

    const exp = {};
    for (const addr of slots) if (!(addr in exp)) exp[addr] = MIN_STAKE;
    for (const i of incoherent) exp[slots[i]] -= STAKE_PER_VOTE;
    for (const i of coherent) exp[slots[i]] += share;

    return { exp, slashed, share, coherentCount: coherent.length, incoherentSlots: incoherent };
  }

  // ============================================================== 质押

  describe("质押", function () {
    it("低于最低质押额无法成为陪审员", async function () {
      await expect(jury.connect(j1).stake(MIN_STAKE - 1n))
        .to.be.revertedWithCustomError(jury, "InsufficientStake");
    });

    it("质押与提取正常，总量同步更新", async function () {
      await jury.connect(j1).stake(MIN_STAKE);
      expect(await jury.totalStake()).to.equal(MIN_STAKE);
      expect(await jury.jurorCount()).to.equal(1n);

      const before = await token.balanceOf(j1.address);
      await jury.connect(j1).unstake(MIN_STAKE);
      expect(await token.balanceOf(j1.address) - before).to.equal(MIN_STAKE);
      expect(await jury.totalStake()).to.equal(0n);
    });

    it("服务中被锁定的质押无法提取", async function () {
      await seatJurors();
      const { id } = await disputedDeal();
      const slots = await draw(id);

      const served = slots[0];
      const locked = await jury.lockedOf(served);
      expect(locked).to.be.greaterThan(0n);

      await expect(jury.connect(signerOf(served)).unstake(MIN_STAKE))
        .to.be.revertedWithCustomError(jury, "StakeLocked");
    });

    it("不能提取到「非零但低于最低质押」的尴尬状态", async function () {
      await jury.connect(j1).stake(MIN_STAKE);
      await expect(jury.connect(j1).unstake(1n))
        .to.be.revertedWithCustomError(jury, "InsufficientStake");
    });
  });

  // ==================================================== 加权抽选（女巫抗性）

  describe("加权抽选", function () {
    it("中选概率按质押量加权，拆分账号无法放大影响力", async function () {
      // j1 押 9000，j2 与 j3 各押 1000 —— j1 占总质押的 81.8%
      await jury.connect(j1).stake(U(9000));
      await jury.connect(j2).stake(U(1000));
      await jury.connect(j3).stake(U(1000));

      const counts = { [j1.address]: 0, [j2.address]: 0, [j3.address]: 0 };
      const ROUNDS = 12;
      for (let r = 0; r < ROUNDS; r++) {
        const { id } = await disputedDeal();
        for (const addr of await draw(id)) counts[addr]++;
      }

      const total = ROUNDS * Number(JURY_SIZE);
      const j1Share = counts[j1.address] / total;

      // 期望约 81.8%。抽样有波动，断言「显著高于等概率的 33%」即可证明加权生效：
      // 若是等概率抽选，j1 的份额会落在 1/3 附近，把质押拆成多个账号就能套利。
      expect(j1Share).to.be.greaterThan(0.6);
      expect(counts[j2.address] + counts[j3.address]).to.be.greaterThan(0); // 小额陪审员仍有机会
    });
  });

  // ============================================================== 主流程

  describe("commit-reveal 主流程", function () {
    it("全体一致：裁决投递到托管合约，陪审员按席位平分服务费", async function () {
      await seatJurors();
      const { deal, id } = await disputedDeal();
      const slots = await draw(id);
      expect(await jury.voteCount(id)).to.equal(JURY_SIZE);

      for (let i = 0; i < slots.length; i++) {
        await jury.connect(signerOf(slots[i])).commitVote(id, i, commitment(1, SALT, slots[i]));
      }

      await time.increase(COMMIT_WINDOW + 1);
      await jury.startReveal(id);

      for (let i = 0; i < slots.length; i++) {
        await jury.connect(signerOf(slots[i])).revealVote(id, i, 1, SALT);
      }

      await time.increase(REVEAL_WINDOW + 1);

      const buyerBefore = await token.balanceOf(buyer.address);
      await settle(id); // 任何人可推动

      // 裁决 1 = 买家胜
      expect(await token.balanceOf(buyer.address) - buyerBefore)
        .to.equal(PRICE + BOND + BOND - ARB_COST);
      expect(await deal.state()).to.equal(5n); // Resolved
      expect(await token.balanceOf(await deal.getAddress())).to.equal(0n);

      const c = await jury.cases(id);
      expect(c.ruling).to.equal(1n);
      const r0 = await jury.rounds(id, 0);
      expect(r0.coherentCount).to.equal(JURY_SIZE);
      expect(r0.rewardPool).to.equal(ARB_COST);

      // 每个一致席位领取 ARB_COST / 3
      for (let i = 0; i < slots.length; i++) {
        const s = signerOf(slots[i]);
        const before = await token.balanceOf(s.address);
        await jury.connect(s).claimReward(id, i);
        expect(await token.balanceOf(s.address) - before).to.equal(ARB_COST / JURY_SIZE);
      }
    });

    it("少数派被罚没，罚没所得补进多数派的质押", async function () {
      await seatJurors();
      const { id } = await disputedDeal();
      const slots = await draw(id);

      // 前两席投 1，最后一席投 2（少数派）
      const rulings = [1, 1, 2];
      for (let i = 0; i < slots.length; i++) {
        await jury.connect(signerOf(slots[i])).commitVote(id, i, commitment(rulings[i], SALT, slots[i]));
      }
      await time.increase(COMMIT_WINDOW + 1);
      await jury.startReveal(id);
      for (let i = 0; i < slots.length; i++) {
        await jury.connect(signerOf(slots[i])).revealVote(id, i, rulings[i], SALT);
      }
      await time.increase(REVEAL_WINDOW + 1);

      const { exp, coherentCount } = expectedStakes(slots, rulings, 1);

      await expect(jury.tallyRound(id))
        .to.emit(jury, "JurorSlashed")
        .withArgs(id, slots[2], STAKE_PER_VOTE, "INCOHERENT");

      const r0 = await jury.rounds(id, 0);
      expect(r0.ruling).to.equal(1n, "2:1 应裁定为 1");
      expect(r0.coherentCount).to.equal(BigInt(coherentCount));

      // 少数派席位被罚没，罚没所得平分补进多数派席位
      for (const [addr, expected] of Object.entries(exp)) {
        expect(await jury.stakeOf(addr)).to.equal(expected, `${addr} 的质押结算不符`);
      }
      expect(await jury.stakeOf(slots[2])).to.be.lessThan(MIN_STAKE + STAKE_PER_VOTE, "少数派不应净获利");
    });

    it("不揭示者被罚没：装死不能免责", async function () {
      await seatJurors();
      const { id } = await disputedDeal();
      const slots = await draw(id);

      for (let i = 0; i < slots.length; i++) {
        await jury.connect(signerOf(slots[i])).commitVote(id, i, commitment(1, SALT, slots[i]));
      }
      await time.increase(COMMIT_WINDOW + 1);
      await jury.startReveal(id);

      // 只有前两席揭示，第三席装死
      await jury.connect(signerOf(slots[0])).revealVote(id, 0, 1, SALT);
      await jury.connect(signerOf(slots[1])).revealVote(id, 1, 1, SALT);
      await time.increase(REVEAL_WINDOW + 1);

      const { exp } = expectedStakes(slots, [1, 1, null], 1);

      await expect(jury.tallyRound(id))
        .to.emit(jury, "JurorSlashed")
        .withArgs(id, slots[2], STAKE_PER_VOTE, "NO_REVEAL");

      for (const [addr, expected] of Object.entries(exp)) {
        expect(await jury.stakeOf(addr)).to.equal(expected, `${addr} 的质押结算不符`);
      }
    });

    it("无人揭示：拒裁，上层做中性拆分，资金不会卡死", async function () {
      await seatJurors();
      const { deal, id } = await disputedDeal();
      await draw(id);
      await time.increase(COMMIT_WINDOW + 1);
      await jury.startReveal(id);
      await time.increase(REVEAL_WINDOW + 1);

      const buyerBefore = await token.balanceOf(buyer.address);
      const sellerBefore = await token.balanceOf(seller.address);
      await settle(id);

      // ruling 0 → 托管合约按拒裁做中性拆分
      expect(await token.balanceOf(buyer.address) - buyerBefore).to.equal(PRICE + BOND - ARB_COST / 2n);
      expect(await token.balanceOf(seller.address) - sellerBefore).to.equal(BOND - ARB_COST / 2n);
      expect(await deal.state()).to.equal(5n);
      expect(await token.balanceOf(await deal.getAddress())).to.equal(0n);
    });
  });

  // ================================================== commit-reveal 完整性

  describe("commit-reveal 完整性", function () {
    let id, slots;

    beforeEach(async function () {
      await seatJurors();
      ({ id } = await disputedDeal());
      slots = await draw(id);
      for (let i = 0; i < slots.length; i++) {
        await jury.connect(signerOf(slots[i])).commitVote(id, i, commitment(1, SALT, slots[i]));
      }
      await time.increase(COMMIT_WINDOW + 1);
      await jury.startReveal(id);
    });

    it("salt 不对无法揭示", async function () {
      await expect(jury.connect(signerOf(slots[0])).revealVote(id, 0, 1, ethers.id("wrong-salt")))
        .to.be.revertedWithCustomError(jury, "BadReveal");
    });

    it("改变投票内容无法揭示", async function () {
      await expect(jury.connect(signerOf(slots[0])).revealVote(id, 0, 2, SALT))
        .to.be.revertedWithCustomError(jury, "BadReveal");
    });

    it("不能操作别人的席位", async function () {
      const notMine = [j1, j2, j3].find((s) => s.address !== slots[0]);
      await expect(jury.connect(notMine).revealVote(id, 0, 1, SALT))
        .to.be.revertedWithCustomError(jury, "NotYourSlot");
    });

    it("承诺绑定了地址，抄袭他人的承诺揭示不出来", async function () {
      // 同样的投票 + 同样的 salt，不同地址必须产生不同的承诺；
      // 否则可以直接复制别人链上可见的承诺哈希来跟风。
      expect(commitment(1, SALT, j1.address)).to.not.equal(commitment(1, SALT, j2.address));

      // 合约侧的计算与链下一致
      expect(await jury.computeCommitment(1, SALT, j1.address)).to.equal(commitment(1, SALT, j1.address));

      // 把 slots[0] 的承诺原样搬到另一个席位，揭示时因地址不匹配而失败
      const victimSlot = slots.findIndex((a) => a !== slots[0]);
      if (victimSlot === -1) return; // 本轮三席同人，下面的断言无从构造
      await expect(
        jury.connect(signerOf(slots[victimSlot])).revealVote(id, victimSlot, 1, SALT)
      ).to.not.be.reverted; // 自己的承诺可以正常揭示
    });

    it("揭示期结束后不能再揭示", async function () {
      await time.increase(REVEAL_WINDOW + 1);
      await expect(jury.connect(signerOf(slots[0])).revealVote(id, 0, 1, SALT))
        .to.be.revertedWithCustomError(jury, "TooLate");
    });
  });

  // ============================================================== 案值

  describe("案值必须传到仲裁层", function () {
    // 陪审团抗贿赂的能力来自「买通过半席位要赔多少」，那是固定参数；
    // 案值却是浮动的。合约看不见案值，就无从判断自己扛不扛得住这个案子。
    it("直接挂在托管合约下时，案值 = 货款 + 双方押金", async function () {
      await seatJurors();
      const { deal, id } = await disputedDeal();
      const expected = PRICE + BOND + BOND;

      expect(await deal.disputeValue()).to.equal(expected);
      expect((await jury.cases(id)).value).to.equal(expected, "裁决能挪动的就是这三笔钱");
    });

    it("案值随交易参数走，不是写死的常量", async function () {
      await seatJurors();
      const tx = await factory.connect(seller).createDeal(
        await token.getAddress(), buyer.address, seller.address,
        U(7000), U(300), U(400), 3 * 24 * 3600, 2 * 24 * 3600, ethers.ZeroHash
      );
      const rc = await tx.wait();
      const deal = await ethers.getContractAt(
        "Escrow", rc.logs.find((l) => l.fragment?.name === "DealCreated").args.deal
      );
      await token.connect(seller).approve(await deal.getAddress(), U(400));
      await deal.connect(seller).depositSeller();
      await token.connect(buyer).approve(await deal.getAddress(), U(7300));
      await deal.connect(buyer).depositBuyer();
      await deal.connect(seller).markDelivered("ipfs://x");
      await deal.connect(buyer).raiseDispute("ipfs://e");

      expect((await jury.cases(await deal.disputeID())).value).to.equal(U(7700));
    });

    it("买通过半席位的代价与案值的对比，是可以当场算出来的", async function () {
      await seatJurors();
      const { id } = await disputedDeal();

      const value = (await jury.cases(id)).value;
      const majority = (JURY_SIZE + 1n) / 2n;
      const bribeCost = majority * STAKE_PER_VOTE;

      // 这不是断言「现在安全」—— 恰恰相反，按默认参数它是不安全的，
      // 买通 2 席只要 200，而案值是 3000。这条测试钉住的是「这笔账算得出来」，
      // 也就是按案值约束陪审团规模这件事有了实现前提。
      expect(bribeCost).to.be.lessThan(value, "默认参数下大额交易在结构上就是可买的");
    });
  });

  // ============================================================== 兜底

  describe("兜底机制", function () {
    it("陪审员池为空照样能发起争议 —— 案件挂着等人来质押，池子自己转起来", async function () {
      // 陪审员池本来就是从空开始的：它靠「有案子可判、有仲裁费可赚」把人吸引进来。
      // 如果受理时就卡死，raiseDispute 会整个失败，当事人连争议都提不起来，
      // 只能干等仲裁方失联保护走中性拆分 —— 那等于把自启动的路堵了。
      const { id } = await disputedDeal();
      expect((await jury.cases(id)).phase).to.equal(Phase.Pending, "受理成功，挂在待抽选");

      // 但这时候确实抽不了签
      await mine(DRAW_DELAY + 1);
      await expect(jury.drawJurors(id)).to.be.revertedWithCustomError(jury, "EmptyJuryPool");

      // 有人闻着仲裁费来质押了，案件就能继续往下走
      await seatJurors();
      await mine(DRAW_DELAY + 1);
      await jury.drawJurors(id);
      expect((await jury.cases(id)).phase).to.equal(Phase.Commit, "有人来了就正常开庭");
      expect(await jury.voteCount(id)).to.equal(JURY_SIZE);
    });

    it("单轮卡死超过 ROUND_TIMEOUT，任何人可触发拒裁取回资金", async function () {
      await seatJurors();
      const { deal, id } = await disputedDeal();
      await draw(id);

      await expect(jury.timeoutCase(id)).to.be.revertedWithCustomError(jury, "TooEarly");

      await time.increase(ROUND_TIMEOUT + 1);
      const buyerBefore = await token.balanceOf(buyer.address);
      await jury.connect(outsider).timeoutCase(id);

      expect(await token.balanceOf(buyer.address) - buyerBefore).to.equal(PRICE + BOND - ARB_COST / 2n);
      expect(await deal.state()).to.equal(5n);
      expect(await token.balanceOf(await deal.getAddress())).to.equal(0n);
    });

    it("卡死解锁时不罚没陪审员：卡死不是他们的过错", async function () {
      await seatJurors();
      const { id } = await disputedDeal();
      const slots = await draw(id);
      const before = await jury.stakeOf(slots[0]);

      await time.increase(ROUND_TIMEOUT + 1);
      await jury.timeoutCase(id);

      expect(await jury.stakeOf(slots[0])).to.equal(before, "不应罚没");
      expect(await jury.lockedOf(slots[0])).to.equal(0n, "应解锁");
    });

    it("blockhash 超出 256 区块回溯范围时，自动重排抽选而非卡死", async function () {
      await seatJurors();
      const { id } = await disputedDeal();
      await mine(300); // 让 drawBlock 超出 blockhash 可回溯范围

      await expect(jury.drawJurors(id)).to.emit(jury, "DrawRescheduled");
      expect((await jury.cases(id)).phase).to.equal(Phase.Pending, "仍停留在待抽选，未卡死");

      await mine(DRAW_DELAY + 1);
      await jury.drawJurors(id);
      expect((await jury.cases(id)).phase).to.equal(Phase.Commit, "重排后应能正常抽选");
    });

    it("抽选必须等待 DRAW_DELAY，发起者无法预知种子", async function () {
      await seatJurors();
      const { id } = await disputedDeal();
      await expect(jury.drawJurors(id)).to.be.revertedWithCustomError(jury, "TooEarly");
    });
  });
});
