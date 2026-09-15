const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const U = (n) => BigInt(Math.round(n * 1e6));

const PRICE = U(1000);
const BOND = U(1000);
const FEE_BPS = 50n;
const FEE = (PRICE * FEE_BPS) / 10000n;
const ARB_COST = U(20);
const DELIVERY_WINDOW = 3 * 24 * 3600;
const INSPECTION_WINDOW = 2 * 24 * 3600;

const Outcome = {
  None: 0n, CancelledUnfunded: 1n, NonDelivery: 2n, Completed: 3n,
  DisputeBuyer: 4n, DisputeSeller: 5n, DisputeSplit: 6n, DisputeStale: 7n,
};

const DAY = 24 * 3600;

describe("信誉层", function () {
  let owner, buyer, seller, other, outsider;
  let token, impl, factory, vault, arb, rep, bondC;

  beforeEach(async function () {
    [owner, buyer, seller, other, outsider] = await ethers.getSigners();

    token = await (await ethers.getContractFactory("MockERC20")).deploy();
    vault = await (await ethers.getContractFactory("FeeVault")).deploy(owner.address);
    impl = await (await ethers.getContractFactory("Escrow")).deploy();
    arb = await (await ethers.getContractFactory("DirectArbitrator")).deploy();
    await arb.setCost(ARB_COST);

    factory = await (await ethers.getContractFactory("EscrowFactory")).deploy(
      await impl.getAddress(), await arb.getAddress(), await vault.getAddress(), FEE_BPS, owner.address
    );
    rep = await (await ethers.getContractFactory("Reputation")).deploy(await factory.getAddress());
    bondC = await (await ethers.getContractFactory("IdentityBond")).deploy(await token.getAddress());

    for (const s of [buyer, seller, other, outsider]) await token.mint(s.address, U(100000));
  });

  async function createDeal(b = buyer, s = seller) {
    const tx = await factory.connect(s).createDeal(
      await token.getAddress(), b.address, s.address,
      PRICE, BOND, BOND, DELIVERY_WINDOW, INSPECTION_WINDOW,
      ethers.keccak256(ethers.toUtf8Bytes("条款"))
    );
    const rc = await tx.wait();
    const ev = rc.logs.find((l) => l.fragment?.name === "DealCreated");
    return ethers.getContractAt("Escrow", ev.args.deal);
  }

  async function fundedDeal(b = buyer, s = seller) {
    const deal = await createDeal(b, s);
    const addr = await deal.getAddress();
    await token.connect(s).approve(addr, BOND);
    await deal.connect(s).depositSeller();
    await token.connect(b).approve(addr, PRICE + BOND);
    await deal.connect(b).depositBuyer();
    return deal;
  }

  const stats = async (who) => rep.statsOf(who, await token.getAddress());

  // ------------------------------------------------------------------ 终局原因

  describe("终局原因写入链上状态", function () {
    // State 只说明「结束了」。Cancelled 既可能是无人过错的退出，也可能是
    // 卖家逾期未交付 —— 此前这个区别只存在于事件日志里，合约读不到。

    it("正常完成 → Completed", async function () {
      const deal = await fundedDeal();
      await deal.connect(seller).markDelivered("ipfs://x");
      await deal.connect(buyer).confirmReceipt();
      expect(await deal.outcome()).to.equal(Outcome.Completed);
    });

    it("未入金退出 → CancelledUnfunded", async function () {
      const deal = await createDeal();
      await deal.connect(buyer).cancelUnfunded();
      expect(await deal.outcome()).to.equal(Outcome.CancelledUnfunded);
    });

    it("卖家逾期未交付 → NonDelivery（与上一条同为 Cancelled，含义相反）", async function () {
      const deal = await fundedDeal();
      await time.increase(DELIVERY_WINDOW + 1);
      await deal.connect(buyer).claimNonDelivery();
      expect(await deal.state()).to.equal(6n); // 同样是 Cancelled
      expect(await deal.outcome()).to.equal(Outcome.NonDelivery);
    });

    it("裁决结果分别落成 DisputeBuyer / DisputeSeller / DisputeSplit", async function () {
      for (const [ruling, expected] of [[1n, Outcome.DisputeBuyer], [2n, Outcome.DisputeSeller], [0n, Outcome.DisputeSplit]]) {
        const deal = await fundedDeal();
        await deal.connect(seller).markDelivered("ipfs://x");
        await deal.connect(buyer).raiseDispute("ipfs://e");
        await arb.giveRuling(await deal.getAddress(), await deal.disputeID(), ruling);
        expect(await deal.outcome()).to.equal(expected);
      }
    });

    it("仲裁方失联超时 → DisputeStale（过错在仲裁层，不在双方）", async function () {
      const deal = await fundedDeal();
      await deal.connect(seller).markDelivered("ipfs://x");
      await deal.connect(buyer).raiseDispute("ipfs://e");
      await time.increase(45 * DAY + 1);
      await deal.resolveStaleDispute();
      expect(await deal.outcome()).to.equal(Outcome.DisputeStale);
    });
  });

  // ------------------------------------------------------------------ 记录

  describe("记录", function () {
    it("正常完成：双方各记一笔，成交额与手续费同时入账", async function () {
      const deal = await fundedDeal();
      await deal.connect(seller).markDelivered("ipfs://x");
      await deal.connect(buyer).confirmReceipt();
      await rep.record(await deal.getAddress());

      for (const p of [buyer, seller]) {
        const [r, volume, feesBurned] = await stats(p.address);
        expect(r.completed).to.equal(1n);
        expect(r.counterparties).to.equal(1n);
        expect(volume).to.equal(PRICE);
        expect(feesBurned).to.equal(FEE);
      }
    });

    it("卖家败诉：卖家记败诉、买家记胜诉，且不计成交额", async function () {
      const deal = await fundedDeal();
      await deal.connect(seller).markDelivered("ipfs://x");
      await deal.connect(buyer).raiseDispute("ipfs://e");
      await arb.giveRuling(await deal.getAddress(), await deal.disputeID(), 1n);
      await rep.record(await deal.getAddress());

      const [rs, volS] = await stats(seller.address);
      const [rb] = await stats(buyer.address);
      expect(rs.disputesLost).to.equal(1n);
      expect(rb.disputesWon).to.equal(1n);
      expect(rs.completed).to.equal(0n);
      expect(volS).to.equal(0n); // 没成交，不能算业绩
    });

    it("买家恶意申诉败诉：对称地记在买家头上", async function () {
      const deal = await fundedDeal();
      await deal.connect(seller).markDelivered("ipfs://x");
      await deal.connect(buyer).raiseDispute("ipfs://e");
      await arb.giveRuling(await deal.getAddress(), await deal.disputeID(), 2n);
      await rep.record(await deal.getAddress());

      const [rb] = await stats(buyer.address);
      const [rs, volS, feeS] = await stats(seller.address);
      expect(rb.disputesLost).to.equal(1n);
      expect(rs.disputesWon).to.equal(1n);
      // 这条路径货款真的付了、手续费真的收了，所以算成交额
      expect(volS).to.equal(PRICE);
      expect(feeS).to.equal(FEE);
    });

    it("拒裁与仲裁方超时都记为「未认定过错」，不算在任何一方头上", async function () {
      const deal = await fundedDeal();
      await deal.connect(seller).markDelivered("ipfs://x");
      await deal.connect(buyer).raiseDispute("ipfs://e");
      await arb.giveRuling(await deal.getAddress(), await deal.disputeID(), 0n);
      await rep.record(await deal.getAddress());

      for (const p of [buyer, seller]) {
        const [r] = await stats(p.address);
        expect(r.disputesInconclusive).to.equal(1n);
        expect(r.disputesLost).to.equal(0n);
        expect(r.disputesWon).to.equal(0n);
      }
    });

    it("卖家逾期未交付只记卖家，买家不受牵连", async function () {
      const deal = await fundedDeal();
      await time.increase(DELIVERY_WINDOW + 1);
      await deal.connect(buyer).claimNonDelivery();
      await rep.record(await deal.getAddress());

      const [rs] = await stats(seller.address);
      const [rb] = await stats(buyer.address);
      expect(rs.nonDelivery).to.equal(1n);
      expect(rb.nonDelivery).to.equal(0n);
      expect(rb.disputesLost).to.equal(0n);
    });
  });

  // ------------------------------------------------------------------ 抗伪造

  describe("抗伪造", function () {
    it("拒绝非本工厂创建的合约 —— 否则自己部署一个填满完美数据即可", async function () {
      const fake = await (await ethers.getContractFactory("Escrow")).deploy();
      await expect(rep.record(await fake.getAddress())).to.be.revertedWithCustomError(rep, "NotADeal");
    });

    it("未结束的交易不能记录", async function () {
      const deal = await fundedDeal();
      await expect(rep.record(await deal.getAddress())).to.be.revertedWithCustomError(rep, "NotSettled");
    });

    it("双方都没入金就退出的交易不计入 —— 它的创建成本接近零", async function () {
      const deal = await createDeal();
      await deal.connect(buyer).cancelUnfunded();
      await expect(rep.record(await deal.getAddress())).to.be.revertedWithCustomError(rep, "NothingHappened");
    });

    it("同一笔交易无法重复记录", async function () {
      const deal = await fundedDeal();
      await deal.connect(buyer).confirmReceipt();
      await rep.record(await deal.getAddress());
      await expect(rep.record(await deal.getAddress())).to.be.revertedWithCustomError(rep, "AlreadyRecorded");
    });

    it("对手方按「不同地址」去重：自己跟自己刷，笔数涨而对手方数不涨", async function () {
      for (let i = 0; i < 3; i++) {
        const deal = await fundedDeal(buyer, seller);
        await deal.connect(buyer).confirmReceipt();
        await rep.record(await deal.getAddress());
      }
      const [r] = await stats(seller.address);
      expect(r.completed).to.equal(3n);
      expect(r.counterparties).to.equal(1n); // 三笔，一个对手方 —— 刷单的形状

      const deal = await fundedDeal(other, seller);
      await deal.connect(other).confirmReceipt();
      await rep.record(await deal.getAddress());
      expect((await stats(seller.address))[0].counterparties).to.equal(2n);
    });

    it("刷出来的记录必然烧掉等额手续费 —— 伪造成本有硬下界", async function () {
      for (let i = 0; i < 3; i++) {
        const deal = await fundedDeal(buyer, seller);
        await deal.connect(buyer).confirmReceipt();
        await rep.record(await deal.getAddress());
      }
      const [, , feesBurned] = await stats(seller.address);
      expect(feesBurned).to.equal(FEE * 3n);
      // 手续费进的是不可变金库，刷单者拿不回来
      expect(await token.balanceOf(await vault.getAddress())).to.equal(FEE * 3n);
    });
  });

  // ------------------------------------------------------------------ 无许可

  describe("记录无法被压制", function () {
    it("与交易无关的第三方也能推送记录 —— 骗子无法靠拒绝调用来隐藏败诉", async function () {
      const deal = await fundedDeal();
      await deal.connect(seller).markDelivered("ipfs://x");
      await deal.connect(buyer).raiseDispute("ipfs://e");
      await arb.giveRuling(await deal.getAddress(), await deal.disputeID(), 1n);

      await rep.connect(outsider).record(await deal.getAddress());
      expect((await stats(seller.address))[0].disputesLost).to.equal(1n);
    });

    it("合约没有任何删除或修改记录的入口", async function () {
      const names = rep.interface.fragments
        .filter((f) => f.type === "function" && f.stateMutability !== "view")
        .map((f) => f.name);
      expect(names.sort()).to.deep.equal(["record", "recordMany"]);
    });

    it("批量记录时，夹在中间的失败项不会拖垮其余的", async function () {
      const done = [];
      for (let i = 0; i < 2; i++) {
        const deal = await fundedDeal();
        await deal.connect(buyer).confirmReceipt();
        done.push(await deal.getAddress());
      }
      const pending = await fundedDeal(); // 未结束，单独调用会 revert
      await rep.recordMany([done[0], await pending.getAddress(), done[1]]);
      expect((await stats(buyer.address))[0].completed).to.equal(2n);
    });
  });

  // ------------------------------------------------------------------ 身份押金

  describe("身份押金", function () {
    const AMT = U(500);

    async function bondUp(who = seller, amt = AMT) {
      await token.connect(who).approve(await bondC.getAddress(), amt);
      await bondC.connect(who).bond(amt);
    }

    it("押入后开始计龄", async function () {
      await bondUp();
      await time.increase(30 * DAY);
      const age = await bondC.ageOf(seller.address);
      expect(age).to.be.greaterThanOrEqual(30n * 24n * 3600n);
      expect(await bondC.committedOf(seller.address)).to.equal(AMT);
    });

    it("加仓不重置年龄，但会留下加仓时间", async function () {
      await bondUp();
      await time.increase(60 * DAY);
      await bondUp(seller, U(100));
      const [amount, bondedAt, toppedUpAt] = await bondC.bondOf(seller.address);
      expect(amount).to.equal(AMT + U(100));
      expect(await bondC.ageOf(seller.address)).to.be.greaterThanOrEqual(60n * 24n * 3600n);
      expect(toppedUpAt).to.be.greaterThan(bondedAt); // 「刚堆高的押金」是可见的
    });

    it("申请解押后立即不再计入承诺金额，哪怕钱还在合约里", async function () {
      await bondUp();
      await bondC.connect(seller).requestUnbond();
      expect(await bondC.committedOf(seller.address)).to.equal(0n);
      const [amount] = await bondC.bondOf(seller.address);
      expect(amount).to.equal(AMT); // 钱确实还在
    });

    it("公示期未满不能提取", async function () {
      await bondUp();
      await bondC.connect(seller).requestUnbond();
      await time.increase(13 * DAY);
      await expect(bondC.connect(seller).withdraw()).to.be.revertedWithCustomError(bondC, "TooEarly");
      await time.increase(2 * DAY);
      await bondC.connect(seller).withdraw();
    });

    it("提取后身份销毁，重新押入年龄从头开始", async function () {
      await bondUp();
      await time.increase(200 * DAY);
      await bondC.connect(seller).requestUnbond();
      await time.increase(15 * DAY);
      await bondC.connect(seller).withdraw();
      expect(await bondC.ageOf(seller.address)).to.equal(0n);

      await bondUp();
      expect(await bondC.ageOf(seller.address)).to.be.lessThan(60n);
    });

    it("撤销解押保留年龄，但申请次数被永久计数", async function () {
      await bondUp();
      await time.increase(100 * DAY);
      await bondC.connect(seller).requestUnbond();
      await bondC.connect(seller).cancelUnbond();

      expect(await bondC.committedOf(seller.address)).to.equal(AMT);
      expect(await bondC.ageOf(seller.address)).to.be.greaterThanOrEqual(100n * 24n * 3600n);
      const [, , , , requests] = await bondC.bondOf(seller.address);
      expect(requests).to.equal(1n); // 反复申请退出的模式对手方看得见
    });

    it("不支持部分解押 —— 否则能保留年龄同时把押金抽空", async function () {
      const names = bondC.interface.fragments.filter((f) => f.type === "function").map((f) => f.name);
      expect(names).to.not.include("partialUnbond");
      // withdraw 无参数：只能整笔
      expect(bondC.interface.getFunction("withdraw").inputs.length).to.equal(0);
    });

    it("公示期内不能加仓：公示的数字必须与实际敞口一致", async function () {
      await bondUp();
      await bondC.connect(seller).requestUnbond();
      await token.connect(seller).approve(await bondC.getAddress(), U(100));
      await expect(bondC.connect(seller).bond(U(100))).to.be.revertedWithCustomError(bondC, "Unbonding");
    });

    it("没有任何人能罚没或提走别人的押金 —— 包括部署者", async function () {
      await bondUp();
      const names = bondC.interface.fragments
        .filter((f) => f.type === "function" && f.stateMutability !== "view")
        .map((f) => f.name);
      expect(names.sort()).to.deep.equal(["bond", "cancelUnbond", "requestUnbond", "withdraw"]);

      // 部署者对这笔钱没有任何入口：他自己没押金，withdraw 直接 revert
      await expect(bondC.connect(owner).withdraw()).to.be.revertedWithCustomError(bondC, "NotUnbonding");
      expect(await token.balanceOf(await bondC.getAddress())).to.equal(AMT);
    });
  });
});
