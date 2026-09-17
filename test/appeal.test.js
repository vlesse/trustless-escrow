const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, mine } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * 上诉轮。
 *
 * 这一层要回答的问题是：陪审团自己判错了怎么办。
 * 在它之前，陪审团一裁终局 —— Schelling point 在证据模糊或有大额贿赂时
 * 会失效，而失效的代价全部由被误判的一方承担，没有任何补救路径。
 *
 * 所以这里检验的重点不是「上诉能不能跑通」，而是几条口径有没有被真正实现：
 *   1. 裁决在上诉窗口结束之前**不能**投递给托管合约（否则上诉就是空话）；
 *   2. 每一轮**独立结算** —— 初审的多数派不会被上诉轮追溯罚没；
 *   3. 上诉费只养活它自己那一轮，不向任何一方追加账单；
 *   4. 上层投递失败不能把陪审员的质押永久锁死。
 */

const U = (n) => BigInt(Math.round(n * 1e6));

const PRICE = U(1000);
const BOND = U(1000);
const FEE_BPS = 50n;

const JURY_SIZE = 3n;
const MIN_STAKE = U(2000);
const STAKE_PER_VOTE = U(100);
const ARB_COST = U(60); // 可被 JURY_SIZE 整除，便于核对每席分成

const DRAW_DELAY = 10;
const COMMIT_WINDOW = 3 * 24 * 3600;
const REVEAL_WINDOW = 2 * 24 * 3600;
const APPEAL_WINDOW = 2 * 24 * 3600;
const ROUND_TIMEOUT = 10 * 24 * 3600;
const DISPUTE_TIMEOUT = 45 * 24 * 3600;

// 案值 = 货款 + 双方押金 = 3000；拖延押金 = 2%
const CASE_VALUE = PRICE + BOND + BOND;
const DELAY_BOND = (CASE_VALUE * 200n) / 10000n;

const Phase = { None: 0n, Pending: 1n, Commit: 2n, Reveal: 3n, Appealable: 4n, Executed: 5n };

const commitment = (ruling, salt, juror) =>
  ethers.solidityPackedKeccak256(["uint8", "bytes32", "address"], [ruling, salt, juror]);

const SALT = ethers.id("appeal-salt");

describe("陪审团上诉轮", function () {
  let owner, buyer, seller, feeBene, outsider, jurorSigners;
  let token, factory, vault, jury;

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    [owner, buyer, seller, feeBene, outsider] = signers;
    jurorSigners = signers.slice(5, 13); // 8 名陪审员

    token = await (await ethers.getContractFactory("MockERC20")).deploy();
    vault = await (await ethers.getContractFactory("FeeVault")).deploy(feeBene.address);
    const impl = await (await ethers.getContractFactory("Escrow")).deploy();

    jury = await (await ethers.getContractFactory("StakedJury")).deploy(
      await token.getAddress(), JURY_SIZE, MIN_STAKE, STAKE_PER_VOTE, owner.address
    );
    await jury.setCost(await token.getAddress(), ARB_COST);

    factory = await (await ethers.getContractFactory("EscrowFactory")).deploy(
      await impl.getAddress(), await jury.getAddress(), await vault.getAddress(), FEE_BPS, owner.address
    );

    for (const s of [buyer, seller, outsider, ...jurorSigners]) {
      await token.mint(s.address, U(100000));
      await token.connect(s).approve(await jury.getAddress(), U(100000));
    }
    for (const j of jurorSigners) await jury.connect(j).stake(MIN_STAKE);
  });

  const signerOf = (addr) => jurorSigners.find((s) => s.address === addr);

  async function disputedDeal() {
    const rc = await (await factory.connect(seller).createDeal(
      await token.getAddress(), buyer.address, seller.address,
      PRICE, BOND, BOND, 3 * 24 * 3600, 2 * 24 * 3600, ethers.ZeroHash
    )).wait();
    const deal = await ethers.getContractAt(
      "Escrow", rc.logs.find((l) => l.fragment?.name === "DealCreated").args.deal
    );

    await token.connect(seller).approve(await deal.getAddress(), BOND);
    await deal.connect(seller).depositSeller();
    await token.connect(buyer).approve(await deal.getAddress(), PRICE + BOND);
    await deal.connect(buyer).depositBuyer();
    await deal.connect(seller).markDelivered("ipfs://proof");
    await deal.connect(buyer).raiseDispute("ipfs://evidence");
    return { deal, id: Number(await deal.disputeID()) };
  }

  /// 抽选当前轮，返回 [起始 slot, 该轮所有 slot 的陪审员地址]
  async function draw(id) {
    const before = Number(await jury.voteCount(id));
    await mine(DRAW_DELAY + 1);
    await jury.drawJurors(id);
    const after = Number(await jury.voteCount(id));
    const slots = [];
    for (let i = before; i < after; i++) slots.push((await jury.votes(id, i)).juror);
    return { start: before, slots };
  }

  /// 跑完当前轮：抽选 → 按 rulingFor(i) 投票 → 结轮。
  /// rulingFor 返回 null 表示该席位装死不揭示。
  async function runRound(id, rulingFor) {
    const { start, slots } = await draw(id);
    const decided = slots.map((_, i) => rulingFor(i));

    for (let i = 0; i < slots.length; i++) {
      if (decided[i] === null) continue;
      await jury.connect(signerOf(slots[i])).commitVote(id, start + i, commitment(decided[i], SALT, slots[i]));
    }
    await time.increase(COMMIT_WINDOW + 1);
    await jury.startReveal(id);
    for (let i = 0; i < slots.length; i++) {
      if (decided[i] === null) continue;
      await jury.connect(signerOf(slots[i])).revealVote(id, start + i, decided[i], SALT);
    }
    await time.increase(REVEAL_WINDOW + 1);
    await jury.connect(outsider).tallyRound(id);
    return { start, slots, decided };
  }

  const allVoting = (r) => () => r;

  // ==================================================== 裁决不再立刻落地

  describe("上诉窗口", function () {
    it("结轮后裁决不投递给托管合约 —— 否则「可以上诉」就是空话", async function () {
      const { deal, id } = await disputedDeal();
      await runRound(id, allVoting(1));

      expect((await jury.cases(id)).phase).to.equal(Phase.Appealable);
      expect(await deal.state()).to.equal(4n, "托管合约应仍停留在 Disputed");
      expect(await token.balanceOf(await deal.getAddress()))
        .to.equal(PRICE + BOND + BOND, "钱一分都不应该动");
    });

    it("窗口未结束不能结案，窗口结束后不能再上诉", async function () {
      const { id } = await disputedDeal();
      await runRound(id, allVoting(1));

      await expect(jury.finalize(id)).to.be.revertedWithCustomError(jury, "TooEarly");

      await time.increase(APPEAL_WINDOW + 1);
      await token.connect(buyer).approve(await jury.getAddress(), U(100000));
      await expect(jury.connect(buyer).appeal(id)).to.be.revertedWithCustomError(jury, "TooLate");
    });

    it("无人上诉：窗口届满后任何人可推动结案，裁决按第一轮落地", async function () {
      const { deal, id } = await disputedDeal();
      await runRound(id, allVoting(1));

      const buyerBefore = await token.balanceOf(buyer.address);
      await time.increase(APPEAL_WINDOW + 1);
      await expect(jury.connect(outsider).finalize(id))
        .to.emit(jury, "CaseFinalized").withArgs(id, 1, 1, true);

      expect(await token.balanceOf(buyer.address) - buyerBefore).to.equal(PRICE + BOND + BOND - ARB_COST);
      expect(await deal.state()).to.equal(5n);
    });
  });

  // ============================================================ 上诉本身

  describe("提起上诉", function () {
    it("上诉费按席位等价计算，每个陪审员的报酬与第一轮一致", async function () {
      const { id } = await disputedDeal();
      await runRound(id, allVoting(1));

      // 第二轮 7 席：60 * 7 / 3 = 140
      expect(await jury.appealCost(id)).to.equal(U(140));

      await token.connect(buyer).approve(await jury.getAddress(), U(100000));
      await expect(jury.connect(buyer).appeal(id))
        .to.emit(jury, "Appealed").withArgs(id, 1, buyer.address, U(140), 7);

      const r1 = await jury.rounds(id, 1);
      expect(r1.size).to.equal(7n, "席位数翻倍加一，仍为奇数");
      expect(r1.rewardPool).to.equal(U(140), "上诉费直接成为本轮报酬池");
      expect(r1.appellant).to.equal(buyer.address);
      expect(U(140) / 7n).to.equal(ARB_COST / JURY_SIZE, "每席报酬与第一轮相同");

      expect((await jury.cases(id)).phase).to.equal(Phase.Pending, "回到待抽选");
    });

    it("上诉轮可以推翻初审，托管合约按上诉轮的结论结算", async function () {
      const { deal, id } = await disputedDeal();
      await runRound(id, allVoting(1)); // 初审：买家胜

      await token.connect(seller).approve(await jury.getAddress(), U(100000));
      await jury.connect(seller).appeal(id);
      await runRound(id, allVoting(2)); // 上诉轮：卖家胜

      const sellerBefore = await token.balanceOf(seller.address);
      await time.increase(APPEAL_WINDOW + 1);
      await expect(jury.finalize(id))
        .to.emit(jury, "DelayBondSettled")
        .withArgs(id, 1, seller.address, DELAY_BOND, true);

      expect((await jury.cases(id)).ruling).to.equal(2n, "终局裁决取最后一轮");
      const fee = (PRICE * FEE_BPS) / 10000n;
      // 上诉对了，拖延押金原额退回 —— 纠错本身不该收费，否则没人愿意纠错
      expect(await token.balanceOf(seller.address) - sellerBefore)
        .to.equal(PRICE - fee + BOND + (BOND - ARB_COST) + DELAY_BOND, "应按卖家胜结算，并退还拖延押金");
      expect(await deal.state()).to.equal(5n);
    });

    it("轮数有上限：最后一轮结轮即结案，不再开上诉窗口", async function () {
      const { id } = await disputedDeal();
      await runRound(id, allVoting(1));

      for (const who of [buyer, seller]) {
        await token.connect(who).approve(await jury.getAddress(), U(100000));
        await jury.connect(who).appeal(id);
        await runRound(id, allVoting(1));
      }

      expect(await jury.roundCount(id)).to.equal(3n);
      expect((await jury.cases(id)).phase).to.equal(Phase.Executed, "第三轮结轮即终局");
      expect(await jury.appealCost(id)).to.equal(0n, "已无下一轮可上诉");
      await expect(jury.connect(buyer).appeal(id)).to.be.revertedWithCustomError(jury, "BadPhase");
    });
  });

  // ==================================================== 拖延押金

  describe("上诉治不了拖延，所以另收一笔押金", function () {
    // 上诉费本身是付给陪审员的工钱，惩罚不了拖延 —— 那笔钱进的是陪审员口袋，
    // 被多锁一个轮次的那一方一分钱补偿都没有。败诉方即使明知自己会再输一次，
    // 也可以靠上诉把对方的钱多压七天。所以另收一笔按案值计的押金：
    // 推翻原判就退还，维持原判就赔给被拖住的那一方。

    it("发起上诉要付的总额 = 陪审员报酬 + 拖延押金", async function () {
      const { id } = await disputedDeal();
      await runRound(id, allVoting(1));

      expect(await jury.appealCost(id)).to.equal(U(140), "陪审员报酬按席位算");
      expect(await jury.appealDelayBond(id)).to.equal(DELAY_BOND, "拖延押金按案值算");
      expect(await jury.appealTotal(id)).to.equal(U(140) + DELAY_BOND);
    });

    it("拖延押金随案值走，与陪审团开几个人无关", async function () {
      // 它补偿的是「对方的钱被多锁了一个轮次」，那个损失取决于压了多少钱。
      const small = await (await ethers.getContractFactory("EscrowFactory")).deploy(
        await (await ethers.getContractFactory("Escrow")).deploy().then((x) => x.getAddress()),
        await jury.getAddress(), await vault.getAddress(), FEE_BPS, owner.address
      );
      const rc = await (await small.connect(seller).createDeal(
        await token.getAddress(), buyer.address, seller.address,
        U(100), U(100), U(100), 3 * 24 * 3600, 2 * 24 * 3600, ethers.ZeroHash
      )).wait();
      const deal = await ethers.getContractAt(
        "Escrow", rc.logs.find((l) => l.fragment?.name === "DealCreated").args.deal
      );
      await token.connect(seller).approve(await deal.getAddress(), U(100));
      await deal.connect(seller).depositSeller();
      await token.connect(buyer).approve(await deal.getAddress(), U(200));
      await deal.connect(buyer).depositBuyer();
      await deal.connect(seller).markDelivered("ipfs://x");
      await deal.connect(buyer).raiseDispute("ipfs://e");
      const id = Number(await deal.disputeID());

      await runRound(id, allVoting(1));
      expect(await jury.appealCost(id)).to.equal(U(140), "陪审员报酬没变");
      expect(await jury.appealDelayBond(id)).to.equal(U(6), "案值 300 的 2%");
    });

    it("败诉方明知会输还上诉：原判被维持，押金赔给被他拖住的那一方", async function () {
      const { id } = await disputedDeal();
      await runRound(id, allVoting(1)); // 初审：买家胜

      const sellerBefore = await token.balanceOf(seller.address);
      await jury.connect(seller).appeal(id);
      const spent = sellerBefore - (await token.balanceOf(seller.address));
      expect(spent).to.equal(U(140) + DELAY_BOND, "上诉当场付清两笔");

      await runRound(id, allVoting(1)); // 上诉轮：还是买家胜

      const buyerBefore = await token.balanceOf(buyer.address);
      await time.increase(APPEAL_WINDOW + 1);
      await expect(jury.finalize(id))
        .to.emit(jury, "DelayBondSettled")
        .withArgs(id, 1, buyer.address, DELAY_BOND, false);

      expect(await token.balanceOf(buyer.address) - buyerBefore).to.equal(
        PRICE + BOND + BOND - ARB_COST + DELAY_BOND,
        "被多锁一个轮次的一方，除了本来该得的，还拿到拖延补偿"
      );
    });

    it("第三方替人上诉、上诉又没成，押金同样赔给胜诉方而不是退给他", async function () {
      const { id } = await disputedDeal();
      await runRound(id, allVoting(1));

      await jury.connect(outsider).appeal(id);
      await runRound(id, allVoting(1)); // 维持原判

      await time.increase(APPEAL_WINDOW + 1);
      await expect(jury.finalize(id))
        .to.emit(jury, "DelayBondSettled")
        .withArgs(id, 1, buyer.address, DELAY_BOND, false);
    });

    it("终局是拒裁时退还上诉人 —— 没有「被拖延的赢家」可赔", async function () {
      const { id } = await disputedDeal();

      // 初审无人揭示 → 本轮无结论
      await draw(id);
      await time.increase(COMMIT_WINDOW + 1);
      await jury.startReveal(id);
      await time.increase(REVEAL_WINDOW + 1);
      await jury.tallyRound(id);

      const before = await token.balanceOf(outsider.address);
      await jury.connect(outsider).appeal(id);

      // 上诉轮同样无人揭示 → 终局拒裁
      await draw(id);
      await time.increase(COMMIT_WINDOW + 1);
      await jury.startReveal(id);
      await time.increase(REVEAL_WINDOW + 1);
      await jury.tallyRound(id);

      await time.increase(APPEAL_WINDOW + 1);
      await expect(jury.finalize(id))
        .to.emit(jury, "DelayBondSettled")
        .withArgs(id, 1, outsider.address, DELAY_BOND, false);

      expect((await jury.cases(id)).ruling).to.equal(0n);
      expect(await token.balanceOf(outsider.address)).to.equal(before, "两笔钱都退回");
    });
  });

  // ==================================================== 每一轮独立结算

  describe("每一轮只对自己那一轮负责", function () {
    it("初审多数派被上诉推翻，质押不会被追溯罚没，报酬照领", async function () {
      const { id } = await disputedDeal();

      // 初审 2:1 判买家胜，第 2 席是少数派
      const r0 = await runRound(id, (i) => (i === 2 ? 2 : 1));
      expect((await jury.rounds(id, 0)).ruling).to.equal(1n);

      const afterRound0 = {};
      for (const a of new Set(r0.slots)) afterRound0[a] = await jury.stakeOf(a);

      await token.connect(seller).approve(await jury.getAddress(), U(100000));
      await jury.connect(seller).appeal(id);
      await runRound(id, allVoting(2)); // 上诉轮反过来判卖家胜

      await time.increase(APPEAL_WINDOW + 1);
      await jury.finalize(id);
      expect((await jury.cases(id)).ruling).to.equal(2n);

      // 关键断言：终局判了 2，但初审投 1 的那些席位一分钱都没有被追溯扣掉。
      // 若改成「按终局裁决统一重算」，有钱的攻击者只要买通最后一轮，
      // 就能把前面每一轮诚实陪审员的质押全部罚没 —— 成本封顶，损害无上限。
      for (const [addr, before] of Object.entries(afterRound0)) {
        expect(await jury.stakeOf(addr)).to.equal(before, `${addr} 的质押不应被上诉轮改动`);
      }

      // 初审的多数派仍然可以领取初审那一轮的报酬
      for (let i = 0; i < r0.slots.length; i++) {
        if (r0.decided[i] !== 1) continue;
        const s = signerOf(r0.slots[i]);
        const before = await token.balanceOf(s.address);
        await jury.connect(s).claimReward(id, r0.start + i);
        expect(await token.balanceOf(s.address) - before).to.equal(ARB_COST / 2n, "初审 2 席平分服务费");
      }
    });

    it("上诉轮的少数派按上诉轮的多数决被罚没", async function () {
      const { id } = await disputedDeal();
      await runRound(id, allVoting(1));

      await token.connect(seller).approve(await jury.getAddress(), U(100000));
      await jury.connect(seller).appeal(id);

      const { start, slots } = await draw(id);
      const decided = slots.map((_, i) => (i === 0 ? 1 : 2)); // 6:1 判卖家胜
      for (let i = 0; i < slots.length; i++) {
        await jury.connect(signerOf(slots[i])).commitVote(id, start + i, commitment(decided[i], SALT, slots[i]));
      }
      await time.increase(COMMIT_WINDOW + 1);
      await jury.startReveal(id);
      for (let i = 0; i < slots.length; i++) {
        await jury.connect(signerOf(slots[i])).revealVote(id, start + i, decided[i], SALT);
      }
      await time.increase(REVEAL_WINDOW + 1);

      await expect(jury.tallyRound(id))
        .to.emit(jury, "JurorSlashed").withArgs(id, slots[0], STAKE_PER_VOTE, "INCOHERENT");
      expect((await jury.rounds(id, 1)).coherentCount).to.equal(6n);
    });

    it("上诉轮全员装死：上诉费退还给发起人，而不是变成死钱", async function () {
      const { id } = await disputedDeal();
      await runRound(id, allVoting(1));

      // 发起人取一个与这笔交易无关的第三方：终局为拒裁时买卖双方都会
      // 收到中性拆分的退款，那会盖住「退费」本身。
      const paid = await token.balanceOf(outsider.address);
      await jury.connect(outsider).appeal(id);

      // 上诉轮抽了人，但没有任何人揭示
      await draw(id);
      await time.increase(COMMIT_WINDOW + 1);
      await jury.startReveal(id);
      await time.increase(REVEAL_WINDOW + 1);
      await jury.tallyRound(id); // 第二轮，之后还能再上诉 → 进入 Appealable

      const buyerBefore = await token.balanceOf(buyer.address);
      await time.increase(APPEAL_WINDOW + 1);
      const tx = jury.finalize(id);
      await expect(tx).to.emit(jury, "AppealFeeRefunded").withArgs(id, 1, outsider.address, U(140));
      await expect(tx).to.emit(jury, "DelayBondSettled")
        .withArgs(id, 1, buyer.address, DELAY_BOND, false);

      // 陪审员一个都没出工，那笔工钱退还；但拖延押金不退 ——
      // 他确实把买家的钱又多锁了一个轮次，这笔要赔。
      expect(paid - (await token.balanceOf(outsider.address)))
        .to.equal(DELAY_BOND, "只损失拖延押金，陪审费原额退回");
      expect(await token.balanceOf(buyer.address) - buyerBefore)
        .to.equal(PRICE + BOND + BOND - ARB_COST + DELAY_BOND, "被拖延的一方拿到补偿");
    });
  });

  // ==================================================== 跨轮的隔离

  describe("轮与轮之间必须隔离", function () {
    it("初审遗留的空白席位无法在上诉轮的窗口里被激活", async function () {
      const { id } = await disputedDeal();

      // 初审第 2 席从头到尾没提交
      const r0 = await runRound(id, (i) => (i === 2 ? null : 1));

      await token.connect(seller).approve(await jury.getAddress(), U(100000));
      await jury.connect(seller).appeal(id);
      await draw(id); // 上诉轮进入 Commit

      const stale = signerOf(r0.slots[2]);
      await expect(
        jury.connect(stale).commitVote(id, r0.start + 2, commitment(1, SALT, r0.slots[2]))
      ).to.be.revertedWithCustomError(jury, "NotYourSlot");
    });

    it("上诉轮的随机数请求键带轮次，不复用初审已经公开的那个", async function () {
      const source = await (await ethers.getContractFactory("MockRandomnessSource")).deploy();
      await jury.setRandomnessSource(await source.getAddress());

      const { id } = await disputedDeal();
      const key0 = ethers.solidityPackedKeccak256(
        ["address", "uint256", "uint256"], [await jury.getAddress(), id, 0]
      );
      const key1 = ethers.solidityPackedKeccak256(
        ["address", "uint256", "uint256"], [await jury.getAddress(), id, 1]
      );
      expect(await source.isRequested(key0)).to.equal(true);
      expect(await source.isRequested(key1)).to.equal(false, "上诉轮的键此时还不该存在");

      await source.fulfill(key0, 12345);
      await runRound(id, allVoting(1));

      await token.connect(seller).approve(await jury.getAddress(), U(100000));
      await jury.connect(seller).appeal(id);
      expect(await source.isRequested(key1)).to.equal(true, "上诉轮应请求一个新的随机数");
    });
  });

  // ==================================================== 沉默上诉这条攻击路

  describe("沉默的上诉轮不能变成免费的平局", function () {
    it("上诉轮全员装死时，退回上一轮的裁决，而不是改判中性拆分", async function () {
      const { deal, id } = await disputedDeal();
      await runRound(id, allVoting(1)); // 初审：买家胜

      // 眼看要输的卖家上诉，然后让那一轮集体沉默。
      // 如果终局取「最后一轮的 ruling」，这里会得到 0 → 中性拆分，
      // 一场必输就被买成了五五开 —— 而买通一群人「不投票」
      // 比买通他们「改投」便宜得多。
      await token.connect(seller).approve(await jury.getAddress(), U(100000));
      await jury.connect(seller).appeal(id);
      await draw(id);
      await time.increase(COMMIT_WINDOW + 1);
      await jury.startReveal(id);
      await time.increase(REVEAL_WINDOW + 1);
      await jury.tallyRound(id);
      expect((await jury.rounds(id, 1)).ruling).to.equal(0n, "第二轮确实没有结论");

      const buyerBefore = await token.balanceOf(buyer.address);
      await time.increase(APPEAL_WINDOW + 1);
      await jury.finalize(id);

      expect((await jury.cases(id)).ruling).to.equal(1n, "应退回初审的裁决");
      // 沉默不但换不来平局，拖延押金还要赔给被拖住的买家
      expect(await token.balanceOf(buyer.address) - buyerBefore)
        .to.equal(PRICE + BOND + BOND - ARB_COST + DELAY_BOND, "仍按买家胜结算，并拿到拖延补偿");
      expect(await deal.state()).to.equal(5n);
    });

    it("上诉费按受理时的价钱换算，管理员中途调价不影响进行中的案件", async function () {
      const { id } = await disputedDeal();
      await runRound(id, allVoting(1));

      // 管理员把第一轮价钱抬高 10 倍。若上诉费现取 costOf，
      // 这就是一个开关：看到不想被推翻的裁决，把上诉调到当事人付不起为止。
      await jury.setCost(await token.getAddress(), ARB_COST * 10n);
      expect(await jury.appealCost(id)).to.equal(U(140), "仍按受理时的价钱");

      await token.connect(seller).approve(await jury.getAddress(), U(100000));
      await jury.connect(seller).appeal(id);
      expect((await jury.rounds(id, 1)).rewardPool).to.equal(U(140));
    });

    it("陪审员池被罚没清空后仍然可以上诉 —— 等有人来质押再抽签", async function () {
      // 需要一个「一次罚没就能清空」的陪审团：最低质押 = 每席罚没额，且只有一名陪审员。
      // 这不是人为构造的死角 —— 集体装死正是会把小池子直接罚到 0 的那种情形。
      const tiny = await (await ethers.getContractFactory("StakedJury")).deploy(
        await token.getAddress(), JURY_SIZE, STAKE_PER_VOTE, STAKE_PER_VOTE, owner.address
      );
      await tiny.setCost(await token.getAddress(), ARB_COST);
      const impl = await (await ethers.getContractFactory("Escrow")).deploy();
      const f2 = await (await ethers.getContractFactory("EscrowFactory")).deploy(
        await impl.getAddress(), await tiny.getAddress(), await vault.getAddress(), FEE_BPS, owner.address
      );
      const j0 = jurorSigners[0];
      await token.connect(j0).approve(await tiny.getAddress(), U(100000));
      await tiny.connect(j0).stake(STAKE_PER_VOTE);

      const rc = await (await f2.connect(seller).createDeal(
        await token.getAddress(), buyer.address, seller.address,
        PRICE, BOND, BOND, 3 * 24 * 3600, 2 * 24 * 3600, ethers.ZeroHash
      )).wait();
      const deal = await ethers.getContractAt(
        "Escrow", rc.logs.find((l) => l.fragment?.name === "DealCreated").args.deal
      );
      await token.connect(seller).approve(await deal.getAddress(), BOND);
      await deal.connect(seller).depositSeller();
      await token.connect(buyer).approve(await deal.getAddress(), PRICE + BOND);
      await deal.connect(buyer).depositBuyer();
      await deal.connect(seller).markDelivered("ipfs://proof");
      await deal.connect(buyer).raiseDispute("ipfs://evidence");
      const id = Number(await deal.disputeID());

      // 三席全归同一个人，集体装死 → 质押被罚光
      await mine(DRAW_DELAY + 1);
      await tiny.drawJurors(id);
      await time.increase(COMMIT_WINDOW + 1);
      await tiny.startReveal(id);
      await time.increase(REVEAL_WINDOW + 1);
      await tiny.tallyRound(id);
      expect(await tiny.totalStake()).to.equal(0n, "池子已被罚空");

      // 池子空了不该剥夺上诉权 —— 和「池子空了不该剥夺争议权」同一个道理。
      // 上诉照常受理，只是抽不了签，要等人来。
      await token.connect(seller).approve(await tiny.getAddress(), U(100000));
      await tiny.connect(seller).appeal(id);
      expect(await tiny.roundCount(id)).to.equal(2n);

      await mine(DRAW_DELAY + 1);
      await expect(tiny.drawJurors(id)).to.be.revertedWithCustomError(tiny, "EmptyJuryPool");

      // 新人进场，上诉轮就开得起来了
      for (const j of jurorSigners.slice(1, 4)) {
        await token.connect(j).approve(await tiny.getAddress(), U(100000));
        await tiny.connect(j).stake(STAKE_PER_VOTE);
      }
      await mine(DRAW_DELAY + 1);
      await tiny.drawJurors(id);
      expect((await tiny.cases(id)).phase).to.equal(Phase.Commit, "上诉轮正常开庭");
    });
  });

  // ==================================================== 兜底与失败路径

  describe("上层失败不能把陪审员拖下水", function () {
    it("陪审员的本金不依赖他记得领报酬 —— 结案即解锁", async function () {
      const { id } = await disputedDeal();
      const r0 = await runRound(id, allVoting(1));
      await time.increase(APPEAL_WINDOW + 1);
      await jury.finalize(id);

      // 一分钱报酬都没领，质押就必须已经解锁。
      // 把解锁绑在领钱上，等于让一个忘了领、或者私钥丢了的陪审员
      // 拿一笔几十块的服务费换掉全部本金。
      for (const addr of new Set(r0.slots)) {
        expect(await jury.lockedOf(addr)).to.equal(0n);
        await jury.connect(signerOf(addr)).unstake(await jury.stakeOf(addr));
      }
    });

    it("托管合约已经自行超时结算，结案仍然成功，质押照常解锁", async function () {
      const { deal, id } = await disputedDeal();
      const r0 = await runRound(id, allVoting(1));

      // 拖到托管合约的仲裁方失联保护触发，双方自行中性拆分
      await time.increase(DISPUTE_TIMEOUT + 1);
      await deal.connect(outsider).resolveStaleDispute();
      expect(await deal.state()).to.equal(5n);

      // 此时再投递裁决，托管合约必然 revert。
      // 如果不兜住，_finalize 会整体回滚，案件永远停在非终态，
      // 所有被抽中的陪审员的质押就此永久锁死。
      await expect(jury.connect(outsider).finalize(id))
        .to.emit(jury, "RulingDeliveryFailed").withArgs(id, await deal.getAddress());

      expect((await jury.cases(id)).phase).to.equal(Phase.Executed);
      for (const addr of new Set(r0.slots)) {
        expect(await jury.lockedOf(addr)).to.equal(0n, `${addr} 的质押应已解锁`);
        // 能全额退出，才算真的没被锁死
        await jury.connect(signerOf(addr)).unstake(await jury.stakeOf(addr));
      }
    });

    it("上诉窗口里没人推进时，按已经产生的裁决兜底结案，而不是改判平局", async function () {
      const { deal, id } = await disputedDeal();
      await runRound(id, allVoting(1));

      const buyerBefore = await token.balanceOf(buyer.address);
      await time.increase(ROUND_TIMEOUT + 1);
      await jury.connect(outsider).timeoutCase(id);

      expect((await jury.cases(id)).ruling).to.equal(1n, "已有的裁决不该被丢掉");
      expect(await token.balanceOf(buyer.address) - buyerBefore)
        .to.equal(PRICE + BOND + BOND - ARB_COST, "按买家胜结算，而不是中性拆分");
      expect(await deal.state()).to.equal(5n);
    });

    it("第一轮无人揭示时服务费不会变成死钱，会滚进下一个案件", async function () {
      const { id } = await disputedDeal();
      await draw(id);
      await time.increase(COMMIT_WINDOW + 1);
      await jury.startReveal(id);
      await time.increase(REVEAL_WINDOW + 1);
      await jury.tallyRound(id);

      await time.increase(APPEAL_WINDOW + 1);
      await expect(jury.finalize(id))
        .to.emit(jury, "FeesRecycled").withArgs(id, await token.getAddress(), ARB_COST);
      expect(await jury.recycled(await token.getAddress())).to.equal(ARB_COST);

      // 下一个案件的第一轮把这笔钱一起发掉
      const next = await disputedDeal();
      const r = await runRound(next.id, allVoting(1));
      await time.increase(APPEAL_WINDOW + 1);
      await jury.finalize(next.id);

      expect(await jury.recycled(await token.getAddress())).to.equal(0n, "回收池应被清空");
      expect((await jury.rounds(next.id, 0)).rewardPool)
        .to.equal(ARB_COST * 2n, "下一案的第一轮多分到了这笔无主报酬");
      expect(r.slots.length).to.equal(3);
    });
  });
});
