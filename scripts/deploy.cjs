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
 * 环境变量：
 *   FEE_BENEFICIARY   手续费最终收款地址（冷钱包）；immutable，部署后无法更改
 *   PROPOSER          AI 提案人地址
 *   FINAL_ARBITRATOR  终局仲裁方地址（质押陪审团 / Kleros adapter）
 *   FEE_BPS           手续费，基点，上限 100（=1%）
 */
const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  const feeBeneficiary = process.env.FEE_BENEFICIARY;
  const proposer = process.env.PROPOSER;
  const finalArbitrator = process.env.FINAL_ARBITRATOR;
  const feeBps = Number(process.env.FEE_BPS ?? 50);

  for (const [k, v] of Object.entries({ FEE_BENEFICIARY: feeBeneficiary, PROPOSER: proposer, FINAL_ARBITRATOR: finalArbitrator })) {
    if (!v || !ethers.isAddress(v)) throw new Error(`环境变量 ${k} 缺失或不是合法地址`);
  }

  console.log("部署者:", deployer.address);
  console.log("手续费受益地址(immutable):", feeBeneficiary);
  console.log("费率:", feeBps, "bps\n");

  // 1. 托管实现合约（immutable，逻辑永不可升级）
  const impl = await (await ethers.getContractFactory("Escrow")).deploy();
  await impl.waitForDeployment();
  console.log("Escrow 实现       ", await impl.getAddress());

  // 2. 手续费金库（受益地址 immutable）
  const vault = await (await ethers.getContractFactory("FeeVault")).deploy(feeBeneficiary);
  await vault.waitForDeployment();
  console.log("FeeVault          ", await vault.getAddress());

  // 3. 预测 OptimisticArbitrator 的地址：它将是本账户的下下笔部署
  //    （nonce+1 是工厂，nonce+2 才是仲裁层）
  const nonce = await ethers.provider.getTransactionCount(deployer.address);
  const predictedArbitrator = ethers.getCreateAddress({ from: deployer.address, nonce: nonce + 1 });
  console.log("预测仲裁层地址     ", predictedArbitrator);

  // 4. 工厂（nonce）
  const factory = await (await ethers.getContractFactory("EscrowFactory")).deploy(
    await impl.getAddress(), predictedArbitrator, await vault.getAddress(), feeBps, deployer.address
  );
  await factory.waitForDeployment();
  console.log("EscrowFactory     ", await factory.getAddress());

  // 5. 仲裁层（nonce+1）
  const optimistic = await (await ethers.getContractFactory("OptimisticArbitrator")).deploy(
    await factory.getAddress(), finalArbitrator, proposer, deployer.address
  );
  await optimistic.waitForDeployment();
  const actual = await optimistic.getAddress();
  console.log("OptimisticArbitrator", actual);

  if (actual.toLowerCase() !== predictedArbitrator.toLowerCase()) {
    throw new Error("地址预测失败 —— 部署中途 nonce 被占用，请重新部署");
  }

  console.log("\n后续必须手工完成：");
  console.log("  1. optimistic.setCost(<USDT地址>, <仲裁服务费>, <挑战保证金>)");
  console.log("     注意：挑战保证金必须 >= 终局仲裁方的成本，否则 createDispute 会 revert");
  console.log("  2. 在区块浏览器上验证全部合约源码（透明度的前提）");
  console.log("  3. 确认 FeeVault.beneficiary 指向正确的冷钱包 —— 此项永久不可更改");
  console.log("  4. 考虑在协议稳定后 factory.transferAdmin(address(0))，永久冻结参数");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
