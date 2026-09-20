/**
 * 在测试网上发一个冒充 USDT 的结算币。
 *
 *   npx hardhat run scripts/testnet-token.cjs --network bscTestnet
 *
 * 精度写死 18，因为 BSC 上的稳定币全是 18 位 —— 和以太坊/TRON 的 6 位不同。
 * 这一点必须在测试网就踩准：部署脚本会从链上读 decimals()，
 * 如果测试用的假币精度和目标主网不一致，所有金额参数都会验错。
 *
 * mint 是无权限的，谁都能给自己造钱。测试网这样才方便，主网绝不可以。
 */
const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  const bal = await ethers.provider.getBalance(deployer.address);
  console.log("部署者:", deployer.address, "余额", ethers.formatEther(bal), "BNB");
  if (bal === 0n) throw new Error("部署者没有余额，先打水");

  const t = await (await ethers.getContractFactory("MockTokenD")).deploy("Tether USD", "USDT", 18);
  await t.waitForDeployment();
  const addr = await t.getAddress();

  console.log("");
  console.log("结算币(测试用) ", addr);
  console.log("  name/symbol   ", await t.name(), "/", await t.symbol());
  console.log("  decimals      ", await t.decimals());
  console.log("");
  console.log("把这行填进 .env：");
  console.log("  SETTLEMENT_TOKEN=" + addr);
}

main().catch((e) => { console.error(e); process.exit(1); });
