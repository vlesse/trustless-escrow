const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, mine } = require("@nomicfoundation/hardhat-network-helpers");

const U = (n) => BigInt(Math.round(n * 1e6));

const JURY_SIZE = 5n;
const MIN_STAKE = U(1000);
const STAKE_PER_VOTE = U(100);
const JURY_COST = U(60);
const DRAW_DELAY = 10;
const RANDOMNESS_TIMEOUT = 2 * 3600;

const Phase = { None: 0n, Pending: 1n, Commit: 2n, Reveal: 3n, Executed: 4n };

describe("陪审团抽选的随机数", function () {
  let owner, arbitrable, jurorSigners;
  let token, jury, coordinator, source;

  beforeEach(async function () {
    const signers = await ethers.getSigners();
    [owner, arbitrable] = signers;
    jurorSigners = signers.slice(2, 12);

    token = await (await ethers.getContractFactory("MockERC20")).deploy();
    jury = await (await ethers.getContractFactory("StakedJury")).deploy(
      await token.getAddress(), JURY_SIZE, MIN_STAKE, STAKE_PER_VOTE, owner.address
    );
    await jury.setCost(await token.getAddress(), JURY_COST);

    for (const j of jurorSigners) {
      await token.mint(j.address, U(100000));
      await token.connect(j).approve(await jury.getAddress(), U(100000));
      await jury.connect(j).stake(U(5000));
    }
    // 仲裁费由上层支付：这里让 arbitrable 预先备好
    await token.mint(arbitrable.address, U(100000));
    await token.connect(arbitrable).approve(await jury.getAddress(), U(100000));

    coordinator = await (await ethers.getContractFactory("MockVRFCoordinator")).deploy();
  });

  async function deploySource() {
    return (await ethers.getContractFactory("ChainlinkVRFSource")).deploy(
      await coordinator.getAddress(),
      await jury.getAddress(),
      ethers.keccak256(ethers.toUtf8Bytes("keyhash")),
      1n,      // subId
      3,       // confirmations
      500000,  // callbackGasLimit
      "0x1234" // extraArgs：由部署方按 Chainlink 文档填，不在合约里硬编码魔数
    );
  }

  const extraData = async () =>
    ethers.AbiCoder.defaultAbiCoder().encode(["address"], [await token.getAddress()]);

  async function newCase() {
    const tx = await jury.connect(arbitrable).createDispute(2, await extraData());
    await tx.wait();
    return Number(await jury.nextCaseID()) - 1;
  }

  const drawn = async (id) => {
    const n = Number(JURY_SIZE);
    const out = [];
    for (let i = 0; i < n; i++) out.push((await jury.votes(id, i)).juror);
    return out;
  };

  // ------------------------------------------------------------ 不配置来源

  describe("未配置随机数来源", function () {
    it("退化为纯 blockhash，行为与接入前完全一致", async function () {
      const id = await newCase();
      const c = await jury.cases(id);
      expect(c.rngSource).to.equal(ethers.ZeroAddress);
      expect(c.rngRequestedAt).to.equal(0n);

      await mine(DRAW_DELAY + 1);
      await jury.drawJurors(id);
      expect((await jury.cases(id)).phase).to.equal(Phase.Commit);
    });
  });

  // ------------------------------------------------------------ 正常路径

  describe("接入 VRF 后的正常路径", function () {
    beforeEach(async function () {
      source = await deploySource();
      await jury.setRandomnessSource(await source.getAddress());
    });

    it("创建争议时即发出请求，并把来源逐案快照", async function () {
      const id = await newCase();
      const c = await jury.cases(id);
      expect(c.rngSource).to.equal(await source.getAddress());
      expect(c.rngRequestedAt).to.be.greaterThan(0n);
      expect(await source.isRequested(
        ethers.solidityPackedKeccak256(["address", "uint256", "uint256"], [await jury.getAddress(), id, 0])
      )).to.equal(true);
    });

    it("VRF 未返回且未超时，不允许抢跑降级", async function () {
      const id = await newCase();
      await mine(DRAW_DELAY + 1);
      // 抢在 VRF 返回前调用 —— 否则任何人都能把随机性白白降级回 blockhash
      await expect(jury.drawJurors(id)).to.be.revertedWithCustomError(jury, "RandomnessPending");
    });

    it("VRF 返回后可以正常抽选", async function () {
      const id = await newCase();
      await coordinator.fulfill(1, 123456789n);
      await mine(DRAW_DELAY + 1);
      await jury.drawJurors(id);
      expect((await jury.cases(id)).phase).to.equal(Phase.Commit);
      expect((await drawn(id)).length).to.equal(Number(JURY_SIZE));
    });

    it("不同的 VRF 值抽出不同的陪审团 —— 随机数确实进了种子", async function () {
      const results = [];
      for (const word of [1n, 2n ** 200n, 7777777n]) {
        const id = await newCase();
        await coordinator.fulfill(Number(id), word);
        await mine(DRAW_DELAY + 1);
        await jury.drawJurors(id);
        results.push((await drawn(id)).join(","));
      }
      // 三次抽选的区块哈希各不相同，但关键是 VRF 值参与了种子；
      // 至少不能三次完全一样
      expect(new Set(results).size).to.be.greaterThan(1);
    });

    it("案件快照了来源：事后更换全局来源不影响进行中的案件", async function () {
      const id = await newCase();
      const other = await deploySource();
      await jury.setRandomnessSource(await other.getAddress());

      const c = await jury.cases(id);
      expect(c.rngSource).to.equal(await source.getAddress());
      // 仍然读的是旧来源 —— 新来源没有这个 key 的结果
      await mine(DRAW_DELAY + 1);
      await expect(jury.drawJurors(id)).to.be.revertedWithCustomError(jury, "RandomnessPending");
      await coordinator.fulfill(1, 42n);
      await jury.drawJurors(id);
      expect((await jury.cases(id)).phase).to.equal(Phase.Commit);
    });
  });

  // ------------------------------------------------------------ 兜底

  describe("预言机出问题时资金绝不能卡住", function () {
    it("订阅没钱导致请求失败 —— 争议照常受理，降级为纯 blockhash", async function () {
      source = await deploySource();
      await jury.setRandomnessSource(await source.getAddress());
      await coordinator.setFailRequests(true);

      await expect(jury.connect(arbitrable).createDispute(2, await extraData()))
        .to.emit(jury, "RandomnessRequestFailed");

      const id = Number(await jury.nextCaseID()) - 1;
      expect((await jury.cases(id)).rngSource).to.equal(ethers.ZeroAddress);

      await mine(DRAW_DELAY + 1);
      await jury.drawJurors(id);
      expect((await jury.cases(id)).phase).to.equal(Phase.Commit);
    });

    it("请求成功但回调迟迟不来：超时后退回 blockhash", async function () {
      source = await deploySource();
      await jury.setRandomnessSource(await source.getAddress());
      const id = await newCase();

      await mine(DRAW_DELAY + 1);
      await expect(jury.drawJurors(id)).to.be.revertedWithCustomError(jury, "RandomnessPending");

      await time.increase(RANDOMNESS_TIMEOUT + 1);
      await expect(jury.drawJurors(id)).to.emit(jury, "RandomnessTimedOut");
      expect((await jury.cases(id)).phase).to.equal(Phase.Commit);
    });

    it("来源合约整个 revert —— 创建与抽选都不受阻", async function () {
      const bad = await (await ethers.getContractFactory("RevertingRandomnessSource")).deploy();
      await jury.setRandomnessSource(await bad.getAddress());

      await expect(jury.connect(arbitrable).createDispute(2, await extraData()))
        .to.emit(jury, "RandomnessRequestFailed");
      const id = Number(await jury.nextCaseID()) - 1;

      await mine(DRAW_DELAY + 1);
      await jury.drawJurors(id);
      expect((await jury.cases(id)).phase).to.equal(Phase.Commit);
    });

    it("来源合约烧光 gas —— 限 gas 调用兜住，不会把争议创建也拖垮", async function () {
      const bad = await (await ethers.getContractFactory("GasBurningRandomnessSource")).deploy();
      await jury.setRandomnessSource(await bad.getAddress());

      // 请求会耗尽给它的 200k 后失败，但 createDispute 本身必须成功
      await expect(jury.connect(arbitrable).createDispute(2, await extraData()))
        .to.emit(jury, "RandomnessRequestFailed");
      const id = Number(await jury.nextCaseID()) - 1;
      expect((await jury.cases(id)).rngSource).to.equal(ethers.ZeroAddress);

      await mine(DRAW_DELAY + 1);
      await jury.drawJurors(id);
      expect((await jury.cases(id)).phase).to.equal(Phase.Commit);
    });

    it("查询阶段烧 gas 的来源：当作未就绪，超时后照常抽选", async function () {
      // 请求成功、查询时烧光 gas —— 比上一条更刁钻：
      // 案件已经把它快照进去了，退不掉，只能靠限 gas + 超时兜底
      const bad = await (await ethers.getContractFactory("LazyGasBurningRandomnessSource")).deploy();
      await jury.setRandomnessSource(await bad.getAddress());
      const id = await newCase();
      expect((await jury.cases(id)).rngSource).to.equal(await bad.getAddress());

      // 等待窗口内它仍然只是「未就绪」，不会把调用者一起拖进 out-of-gas
      await mine(DRAW_DELAY + 1);
      await expect(jury.drawJurors(id)).to.be.revertedWithCustomError(jury, "RandomnessPending");

      await mine(DRAW_DELAY + 1);
      await time.increase(RANDOMNESS_TIMEOUT + 1);
      await jury.drawJurors(id);
      expect((await jury.cases(id)).phase).to.equal(Phase.Commit);
    });
  });

  // ------------------------------------------------------------ 混合 vs 替换

  describe("混合而不是替换", function () {
    it("完全可控的恶意来源，也无法单独决定抽选结果", async function () {
      const evil = await (await ethers.getContractFactory("EvilRandomnessSource")).deploy();
      await jury.setRandomnessSource(await evil.getAddress());

      // 攻击者把「随机数」钉死成同一个值，两次抽选的区块哈希不同，
      // 抽出来的陪审团就不同 —— 说明他并没有拿到指定陪审员的能力
      const seen = new Set();
      for (let k = 0; k < 3; k++) {
        const id = await newCase();
        await evil.set(999n);
        await mine(DRAW_DELAY + 1);
        await jury.drawJurors(id);
        seen.add((await drawn(id)).join(","));
      }
      expect(seen.size).to.be.greaterThan(1);
    });

    it("种子公式被逐一钉住：链下按 keccak(区块哈希, 随机数, 案件ID) 重算，结果必须一致", async function () {
      // 这条是「混合」这个说法的真正证据。上一条只证明区块哈希有影响，
      // 而把 rng 从种子里删掉，上一条照样会通过 —— 这条不会。
      const evil = await (await ethers.getContractFactory("EvilRandomnessSource")).deploy();
      await jury.setRandomnessSource(await evil.getAddress());

      const RNG = 0x1234_5678_9abc_def0n;
      const id = await newCase();
      await evil.set(RNG);
      await mine(DRAW_DELAY + 1);

      const c = await jury.cases(id);
      const bh = (await ethers.provider.getBlock(Number(c.drawBlock))).hash;
      await jury.drawJurors(id);

      // 链下重放合约的抽选算法
      const n = Number(await jury.jurorCount());
      const stakes = [];
      for (let i = 0; i < n; i++) stakes.push(await jury.stakeOf(await jury.jurors(i)));
      const totalStake = await jury.totalStake();

      const seed = ethers.solidityPackedKeccak256(["bytes32", "uint256", "uint256"], [bh, RNG, id]);
      const pick = (target) => {
        let acc = 0n;
        for (let i = 0; i < stakes.length; i++) {
          acc += stakes[i];
          if (acc > target) return i;
        }
        throw new Error("超出总质押");
      };

      const expected = [];
      for (let i = 0; i < Number(JURY_SIZE); i++) {
        const r = BigInt(
          ethers.solidityPackedKeccak256(["bytes32", "uint256", "uint256"], [seed, id, i])
        ) % totalStake;
        expected.push(await jury.jurors(pick(r)));
      }

      expect(await drawn(id)).to.deep.equal(expected);

      // 反证：换一个 rng 重算，得到的不是同一批人 ——
      // 说明 rng 不是被算进去又恰好不影响结果
      const other = ethers.solidityPackedKeccak256(["bytes32", "uint256", "uint256"], [bh, RNG + 1n, id]);
      const alt = [];
      for (let i = 0; i < Number(JURY_SIZE); i++) {
        const r = BigInt(
          ethers.solidityPackedKeccak256(["bytes32", "uint256", "uint256"], [other, id, i])
        ) % totalStake;
        alt.push(await jury.jurors(pick(r)));
      }
      expect(alt.join(",")).to.not.equal(expected.join(","));
    });
  });

  // ------------------------------------------------------------ 适配器本身

  describe("VRF 适配器", function () {
    beforeEach(async function () {
      source = await deploySource();
      await jury.setRandomnessSource(await source.getAddress());
    });

    it("只有陪审团能发起请求 —— 否则任何人都能烧光订阅余额", async function () {
      await expect(source.connect(owner).requestRandomness(ethers.ZeroHash))
        .to.be.revertedWithCustomError(source, "NotConsumer");
    });

    it("只有协调器能回调 —— 否则随机数就是随便填的", async function () {
      await newCase();
      await expect(source.connect(owner).rawFulfillRandomWords(1, [123n]))
        .to.be.revertedWithCustomError(source, "NotCoordinator");
    });

    it("结果一旦产生就不可更改 —— 重摇比没有随机数更糟", async function () {
      const id = await newCase();
      const key = ethers.solidityPackedKeccak256(["address", "uint256", "uint256"], [await jury.getAddress(), id, 0]);

      await coordinator.fulfill(1, 111n);
      expect((await source.randomnessOf(key))[1]).to.equal(111n);

      await coordinator.fulfill(1, 222n); // 重放回调
      expect((await source.randomnessOf(key))[1]).to.equal(111n);
    });

    it("未知的 requestId 无法写入", async function () {
      await expect(coordinator.fulfill(999, 1n)).to.be.reverted;
    });

    it("适配器没有任何管理员函数", async function () {
      const names = source.interface.fragments
        .filter((f) => f.type === "function" && f.stateMutability !== "view" && f.stateMutability !== "pure")
        .map((f) => f.name)
        .sort();
      expect(names).to.deep.equal(["rawFulfillRandomWords", "requestRandomness"]);
    });

    it("请求键绑定了陪审团地址，另一个实例无法冒领", async function () {
      const id = await newCase();
      const key = ethers.solidityPackedKeccak256(["address", "uint256", "uint256"], [await jury.getAddress(), id, 0]);
      const foreign = ethers.solidityPackedKeccak256(["address", "uint256", "uint256"], [owner.address, id, 0]);
      expect(await source.isRequested(key)).to.equal(true);
      expect(await source.isRequested(foreign)).to.equal(false);
    });
  });

  // ------------------------------------------------------------ 管理员权限

  describe("管理员权限边界", function () {
    it("非管理员不能更换来源", async function () {
      await expect(jury.connect(arbitrable).setRandomnessSource(arbitrable.address))
        .to.be.revertedWithCustomError(jury, "NotAdmin");
    });

    it("更换来源只影响未来的案件", async function () {
      source = await deploySource();
      await jury.setRandomnessSource(await source.getAddress());
      const before = await newCase();

      await jury.setRandomnessSource(ethers.ZeroAddress);
      const after = await newCase();

      expect((await jury.cases(before)).rngSource).to.equal(await source.getAddress());
      expect((await jury.cases(after)).rngSource).to.equal(ethers.ZeroAddress);
    });

    it("可以设回 0 关闭外部随机数", async function () {
      source = await deploySource();
      await jury.setRandomnessSource(await source.getAddress());
      await expect(jury.setRandomnessSource(ethers.ZeroAddress))
        .to.emit(jury, "RandomnessSourceChanged")
        .withArgs(await source.getAddress(), ethers.ZeroAddress);
      expect(await jury.randomnessSource()).to.equal(ethers.ZeroAddress);
    });
  });
});
