/**
 * 部署脚本。
 *
 * 这里要处理一个真实的循环依赖：
 *   EscrowFactory 构造时需要 arbitrator 地址；
 *   OptimisticArbitrator 构造时需要 factory 地址（用于校验争议来源合法）。
 *
 * 解法不是「先用占位地址、上线后再改」—— 那会逼迫首次配置绕过 7 天时间锁，
 * 等于在创世时刻给自己开了一个后门。
 * 这里用 nonce 预测 OptimisticArbitrator 的部署地址，在工厂构造时就填对，
 * 时间锁的保证从第一个区块起就完整成立。
 *
 * 用法：
 *   npx hardhat run scripts/deploy.cjs --network <net>
 *
 * 必填环境变量：
 *   FEE_BENEFICIARY   手续费最终收款地址（冷钱包）；immutable，部署后无法更改
 *   PROPOSER          AI 提案人地址
 *   SETTLEMENT_TOKEN  结算币种（USDT / USDC）地址
 *
 * 选填：
 *   FEE_BPS           协议手续费，基点，上限 100（=1%），默认 50
 *   JURY_SIZE         陪审团席位数，必须为奇数，默认 5
 *   MIN_STAKE         陪审员最低质押（最小单位），默认 1000e6
 *   STAKE_PER_VOTE    每席位锁定/罚没额（最小单位），默认 100e6
 *   OPT_COST          乐观层仲裁服务费，默认 100e6
 *   JURY_COST         陪审团服务费，默认 60e6（必须 <= OPT_COST）
 *   CHALLENGE_BOND    挑战保证金，默认 50e6
 *   FINAL_ARBITRATOR  若已有终局仲裁方则填入，跳过部署 StakedJury
 *   SKIP_REPUTATION   设为 1 则不部署信誉层（信誉层可选，托管功能不依赖它）
 *
 * 陪审团随机数（可选，全部留空则用纯 blockhash）：
 *   VRF_COORDINATOR   Chainlink VRF v2.5 协调器地址
 *   VRF_KEY_HASH      gas lane 的 keyHash
 *   VRF_SUB_ID        订阅号
 *   VRF_EXTRA_ARGS    v2.5 扩展参数（付费方式），按 Chainlink 官方文档填
 *   VRF_CONFIRMATIONS 请求确认数，默认 3
 *   VRF_CALLBACK_GAS  回调 gas 上限，默认 500000
 */
const { ethers } = require("hardhat");

function req(name) {
  const v = process.env[name];
  if (!v || !ethers.isAddress(v)) throw new Error(`环境变量 ${name} 缺失或不是合法地址`);
  return v;
}
const num = (name, dflt) => BigInt(process.env[name] ?? dflt);

async function main() {
  const [deployer] = await ethers.getSigners();

  const feeBeneficiary = req("FEE_BENEFICIARY");
  const proposer = req("PROPOSER");
  const settlementToken = req("SETTLEMENT_TOKEN");

  const feeBps = Number(process.env.FEE_BPS ?? 50);
  const jurySize = num("JURY_SIZE", 5);
  const minStake = num("MIN_STAKE", 1000_000000n);
  const stakePerVote = num("STAKE_PER_VOTE", 100_000000n);
  const optCost = num("OPT_COST", 100_000000n);
  const juryCost = num("JURY_COST", 60_000000n);
  const challengeBond = num("CHALLENGE_BOND", 50_000000n);

  if (juryCost > optCost) throw new Error("JURY_COST 必须 <= OPT_COST，否则乐观层无力支付陪审团");

  console.log("部署者:", deployer.address);
  console.log("手续费受益地址(immutable):", feeBeneficiary);
  console.log("结算币种:", settlementToken);
  console.log("费率:", feeBps, "bps\n");

  // 1. 托管实现合约（immutable，逻辑永不可升级）
  const impl = await (await ethers.getContractFactory("Escrow")).deploy();
  await impl.waitForDeployment();
  console.log("Escrow 实现          ", await impl.getAddress());

  // 2. 手续费金库（受益地址 immutable）
  const vault = await (await ethers.getContractFactory("FeeVault")).deploy(feeBeneficiary);
  await vault.waitForDeployment();
  console.log("FeeVault             ", await vault.getAddress());

  // 3. 终局仲裁方：质押陪审团
  let finalArbitrator = process.env.FINAL_ARBITRATOR;
  let jury = null;
  if (finalArbitrator) {
    if (!ethers.isAddress(finalArbitrator)) throw new Error("FINAL_ARBITRATOR 不是合法地址");
    console.log("StakedJury            (沿用既有)", finalArbitrator);
  } else {
    jury = await (await ethers.getContractFactory("StakedJury")).deploy(
      settlementToken, jurySize, minStake, stakePerVote, deployer.address
    );
    await jury.waitForDeployment();
    finalArbitrator = await jury.getAddress();
    console.log("StakedJury           ", finalArbitrator);
  }

  // 4. 预测 OptimisticArbitrator 的地址：它将是本账户的下下笔部署
  const nonce = await ethers.provider.getTransactionCount(deployer.address);
  const predicted = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 1 });
  console.log("预测仲裁层地址        ", predicted);

  // 5. 工厂（nonce）
  const factory = await (await ethers.getContractFactory("EscrowFactory")).deploy(
    await impl.getAddress(), predicted, await vault.getAddress(), feeBps, deployer.address
  );
  await factory.waitForDeployment();
  console.log("EscrowFactory        ", await factory.getAddress());

  // 6. 仲裁层（nonce+1）
  const optimistic = await (await ethers.getContractFactory("OptimisticArbitrator")).deploy(
    await factory.getAddress(), finalArbitrator, proposer, deployer.address
  );
  await optimistic.waitForDeployment();
  const actual = await optimistic.getAddress();
  console.log("OptimisticArbitrator ", actual);

  if (actual.toLowerCase() !== predicted.toLowerCase()) {
    throw new Error("地址预测失败 —— 部署中途 nonce 被占用，请重新部署");
  }

  // 7. 费率配置。两层的费用必须满足 OPT_COST >= JURY_COST，
  //    否则乐观层在升级争议时付不起陪审团的报酬（合约会在受理时拦住）。
  if (jury) {
    await (await jury.setCost(settlementToken, juryCost)).wait();
    console.log("\n已配置 StakedJury.costOf =", juryCost.toString());
  }
  await (await optimistic.setCost(settlementToken, optCost, challengeBond)).wait();
  console.log("已配置 OptimisticArbitrator.costOf =", optCost.toString(), " bond =", challengeBond.toString());

  // 8. 陪审团随机数来源（可选）。
  //    只在本脚本自己部署了陪审团时才接 —— 沿用既有陪审团时我们未必是它的
  //    管理员，setRandomnessSource 会失败。
  if (process.env.VRF_COORDINATOR) {
    if (!jury) {
      console.log("");
      console.log("跳过 VRF：本次沿用了既有的 StakedJury，请由其管理员自行配置");
    } else {
      const src = await (await ethers.getContractFactory("ChainlinkVRFSource")).deploy(
        req("VRF_COORDINATOR"),
        finalArbitrator,
        process.env.VRF_KEY_HASH,
        BigInt(process.env.VRF_SUB_ID ?? 0),
        Number(process.env.VRF_CONFIRMATIONS ?? 3),
        Number(process.env.VRF_CALLBACK_GAS ?? 500000),
        process.env.VRF_EXTRA_ARGS ?? "0x"
      );
      await src.waitForDeployment();
      await (await jury.setRandomnessSource(await src.getAddress())).wait();
      console.log("ChainlinkVRFSource   ", await src.getAddress());
      console.log("  ↑ 记得把这个地址加进 Chainlink 订阅的 consumer 列表，并充值 LINK");
      console.log("  ↑ 订阅没钱时随机数请求会失败，协议自动降级为纯 blockhash，资金不会卡住");
    }
  }

  // 9. 信誉层。刻意放在最后，且完全独立：
  //    它是托管层的只读旁观者 —— 不被 Escrow 调用，也不持有任何资金。
  //    部署失败、写错、甚至根本不部署，托管层的资金安全都不受影响。
  if (process.env.SKIP_REPUTATION !== "1") {
    const bond = await (await ethers.getContractFactory("IdentityBond")).deploy(settlementToken);
    await bond.waitForDeployment();
    console.log("IdentityBond         ", await bond.getAddress());

    const reputation = await (await ethers.getContractFactory("Reputation")).deploy(
      await factory.getAddress()
    );
    await reputation.waitForDeployment();
    console.log("Reputation           ", await reputation.getAddress());
  }

  // 商家额度池（可选，MERCHANT_BOND=1 启用）。商家把保证金预存进去，
  // 之后每开一单一次调用直接扣，省掉每笔都要 approve 的那一步。
  // 它**不做共享抵押** —— 钱最终还是逐笔进到各自的托管合约里，一笔出事不波及别笔。
  if (process.env.MERCHANT_BOND === '1') {
    const pool = await (await ethers.getContractFactory('MerchantBond')).deploy(
      settlementToken, await factory.getAddress()
    );
    await pool.waitForDeployment();
    const poolAddr = await pool.getAddress();
    console.log('MerchantBond         ', poolAddr);
    await (await factory.setMerchantBond(poolAddr)).wait();
    console.log('已配置 factory.merchantBond');
  }

  console.log("\n后续必须手工完成：");
  console.log("  1. 在区块浏览器上验证全部合约源码（透明度的前提）");
  console.log("  2. 确认 FeeVault.beneficiary 指向正确的冷钱包 —— 此项永久不可更改");
  console.log("  3. 招募陪审员质押：陪审员池为空时争议无法受理");
  console.log("  4. 考虑在协议稳定后 factory.transferAdmin(address(0))，永久冻结参数");
  console.log("  5. 把 IdentityBond / Reputation 地址填进机器人的 IDENTITY_BOND / REPUTATION，");
  console.log("     以及签名页 config.js 的 identityBond / reputation —— 无法验证的目标签名页会拒绝放行");
  console.log("  6. 若接了 VRF：把 ChainlinkVRFSource 加为订阅 consumer 并充值，否则会一直降级");
  console.log('  7. 上线初期设一个保守的 factory.setMaxDealValue(token, cap)，');
  console.log('     跑稳一段时间再往上放 —— 没有审计预算时这是唯一能真实封住下行的东西');
  console.log('  8. 想接抽选风险预警：把陪审团地址填进机器人的 STAKED_JURY，');
  console.log('     并把 ALERT_CHAT_ID 指向一个公开频道 —— 私发给运营方等于把单点请回来');
  console.log('  9. 承载真实资金前必须完成第三方安全审计');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
