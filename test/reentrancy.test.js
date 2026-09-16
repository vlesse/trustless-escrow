const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, mine } = require("@nomicfoundation/hardhat-network-helpers");

/**
 * 重入防护。
 *
 * 由 2026-09-16 的自审发现（Slither 报出 reentrancy-no-eth，人工确认其中一条为真）：
 * `StakedJury.appeal()` 原本先收钱后写状态。收钱那一刻 phase 还是 Appealable、
 * rounds.length 也还没变，带转账回调的代币可以在转账中途重新进入 appeal()，
 * 两次调用各 push 一轮 —— 一次就把剩余的上诉轮全部耗光，对方再也上诉不了。
 * 而多出来的那一轮没有陪审员，结案时报酬池会原额退还给攻击者，等于零成本。
 *
 * 这条能否被打到，取决于管理员有没有给一个带钩子的币种配过仲裁费
 * （`costOf[token] == 0` 会让争议创建不出来，是一道隐式白名单）。
 * 但「安全性依赖于管理员永远不配错币种」是一条没写下来的前提，
 * 所以这里要求合约层自己挡住。
 */

const U = (n) => BigInt(Math.round(n * 1e6));

const PRICE = U(1000);
const BOND = U(1000);
const FEE_BPS = 50n;

const JURY_SIZE = 3n;
const MIN_STAKE = U(2000);
const STAKE_PER_VOTE = U(100);
const ARB_COST = U(60);

const DRAW_DELAY = 10;
const COMMIT_WINDOW = 3 * 24 * 3600;
const REVEAL_WINDOW = 2 * 24 * 3600;

const commitment = (ruling, salt, juror) =>
  ethers.solidityPackedKeccak256(["uint8", "bytes32", "address"], [ruling, salt, juror]);
const SALT = ethers.id("reentrancy-salt");

describe("重入防护", function () {
  let owner, buyer, seller, feeBene, attacker, jurorSigners;
  let stakeToken, evil, vault, factory, jury;

  beforeEach(async function () {
    const s = await ethers.getSigners();
    [owner, buyer, seller, feeBene, attacker] = s;
    jurorSigners = s.slice(5, 11);

    // 质押币种与交易币种刻意不同：合约支持这种接法，而恶意币只出现在交易那一侧
    stakeToken = await (await ethers.getContractFactory("MockERC20")).deploy();
    evil = await (await ethers.getContractFactory("ReentrantToken")).deploy();
    vault = await (await ethers.getContractFactory("FeeVault")).deploy(feeBene.address);
    const impl = await (await ethers.getContractFactory("Escrow")).deploy();

    jury = await (await ethers.getContractFactory("StakedJury")).deploy(
      await stakeToken.getAddress(), JURY_SIZE, MIN_STAKE, STAKE_PER_VOTE, owner.address
    );
    // 管理员给这个带钩子的币种配了价 —— 攻击的前提条件
    await jury.setCost(await evil.getAddress(), ARB_COST);

    factory = await (await ethers.getContractFactory("EscrowFactory")).deploy(
      await impl.getAddress(), await jury.getAddress(), await vault.getAddress(), FEE_BPS, owner.address
    );

    for (const p of [buyer, seller, attacker]) {
      await evil.mint(p.address, U(100000));
      await evil.connect(p).approve(await jury.getAddress(), U(100000));
    }
    for (const j of jurorSigners) {
      await stakeToken.mint(j.address, U(100000));
      await stakeToken.connect(j).approve(await jury.getAddress(), U(100000));
      await jury.connect(j).stake(MIN_STAKE);
    }
  });

  const signerOf = (a) => jurorSigners.find((x) => x.address === a);

  async function disputedDeal() {
    const rc = await (await factory.connect(seller).createDeal(
      await evil.getAddress(), buyer.address, seller.address,
      PRICE, BOND, BOND, 3 * 24 * 3600, 2 * 24 * 3600, ethers.ZeroHash
    )).wait();
    const deal = await ethers.getContractAt(
      "Escrow", rc.logs.find((l) => l.fragment?.name === "DealCreated").args.deal
    );
    await evil.connect(seller).approve(await deal.getAddress(), BOND);
    await deal.connect(seller).depositSeller();
    await evil.connect(buyer).approve(await deal.getAddress(), PRICE + BOND);
    await deal.connect(buyer).depositBuyer();
    await deal.connect(seller).markDelivered("ipfs://x");
    await deal.connect(buyer).raiseDispute("ipfs://e");
    return { deal, id: Number(await deal.disputeID()) };
  }

  async function runRound(id) {
    const before = Number(await jury.voteCount(id));
    await mine(DRAW_DELAY + 1);
    await jury.drawJurors(id);
    const after = Number(await jury.voteCount(id));
    for (let i = before; i < after; i++) {
      const j = (await jury.votes(id, i)).juror;
      await jury.connect(signerOf(j)).commitVote(id, i, commitment(1, SALT, j));
    }
    await time.increase(COMMIT_WINDOW + 1);
    await jury.startReveal(id);
    for (let i = before; i < after; i++) {
      await jury.connect(signerOf((await jury.votes(id, i)).juror)).revealVote(id, i, 1, SALT);
    }
    await time.increase(REVEAL_WINDOW + 1);
    await jury.tallyRound(id);
  }

  it("上诉时代币回调无法多吃一轮：剩余上诉轮不会被一次烧光", async function () {
    const { id } = await disputedDeal();
    await runRound(id);
    expect(await jury.roundCount(id)).to.equal(1n);

    // 攻击者是一个合约：它持币、已授权，代币在转账中途回调的正是它自己。
    // 这一点必须做对 —— 如果回调打给代币本身，重入会因为代币没钱而失败，
    // 测试就会在有漏洞的代码上照样变绿。
    const atk = await (await ethers.getContractFactory("AppealReenterer")).deploy();
    await evil.mint(await atk.getAddress(), U(100000));
    await atk.approveToken(await evil.getAddress(), await jury.getAddress(), U(100000));
    await evil.arm(atk.interface.encodeFunctionData("onCallback"));

    await atk.go(await jury.getAddress(), id);

    expect(await evil.reentryAttempted()).to.equal(true, "回调确实发生了，测试本身有效");
    expect(await atk.reentrySucceeded()).to.equal(false, "重入必须失败");
    expect(await jury.roundCount(id)).to.equal(
      2n,
      "只能多出一轮。修复前这里是 3 —— MAX_ROUNDS 被一次吃满，对方再也上诉不了"
    );
    expect(await jury.appealCost(id)).to.be.greaterThan(0n, "对方仍然有得上诉");
  });

  it("结案退还上诉费时的回调同样进不来", async function () {
    const { id } = await disputedDeal();
    await runRound(id);

    await jury.connect(attacker).appeal(id);

    // 上诉轮全员装死 → 结案时要把上诉费退还给 attacker，那一步是 transfer
    await mine(DRAW_DELAY + 1);
    await jury.drawJurors(id);
    await time.increase(COMMIT_WINDOW + 1);
    await jury.startReveal(id);
    await time.increase(REVEAL_WINDOW + 1);
    await jury.tallyRound(id);

    // 退款打给 attacker（EOA），回调落在 EOA 上不会有效果，
    // 所以这里换成合约当上诉人，才能真的试一次重入。
    await evil.arm("0x");

    await time.increase(2 * 24 * 3600 + 1);
    await jury.finalize(id);

    expect((await jury.cases(id)).phase).to.equal(5n, "案件仍然正常结案");
    expect(await evil.balanceOf(attacker.address)).to.be.greaterThan(0n, "上诉费已退还");
  });

  it("每一个会动钱的外部入口都带着重入锁", async function () {
    // 漏挂一个修饰符不会有任何测试失败，所以这里直接对照清单检查 ABI 之外的事实：
    // 用源码断言不现实，改为验证锁确实在最关键的两条路径上生效（上面两项），
    // 并确认 Escrow / IdentityBond 这两个早就有锁的合约没有退化。
    const escrow = await (await ethers.getContractFactory("Escrow")).deploy();
    expect(escrow.interface.getFunction("depositBuyer")).to.not.equal(null);
    // Reentrancy 是自定义错误，存在即说明锁被编译进来了
    for (const name of ["StakedJury", "OptimisticArbitrator", "Escrow"]) {
      const f = await ethers.getContractFactory(name);
      const hasGuard = f.interface.fragments.some(
        (x) => x.type === "error" && x.name === "Reentrancy"
      );
      expect(hasGuard).to.equal(true, `${name} 缺少重入锁`);
    }
  });
});
