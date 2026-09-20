/**
 * 把链上真实读到的接线和 deployments-*.json 对一遍。
 *
 *   npx hardhat run scripts/verify-deployment.cjs --network bscTestnet
 *
 * 为什么必须做：部署脚本打印的是它「以为」自己写进去的值。
 * 构造参数填错位置、nonce 预测偏掉、setCost 被后一笔覆盖 ——
 * 这些在部署日志里全都长得一模一样，只有回读才分得出来。
 *
 * 用 getContractAt 拿 ABI，这样接口一改本脚本就跟着改，
 * 不会像手写 ABI 那样悄悄读到 0。
 */
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

let bad = 0;
const row = (label, got, want) => {
  const ok = want === undefined || String(got).toLowerCase() === String(want).toLowerCase();
  if (!ok) bad++;
  console.log("  " + label.padEnd(18) + String(got).padEnd(44) + (want === undefined ? "" : ok ? "✓" : "✗ 应为 " + want));
};

async function main() {
  const net = (await ethers.provider.getNetwork()).name;
  const file = path.join(__dirname, "..", `deployments-${process.env.HARDHAT_NETWORK || net}.json`);
  const D = JSON.parse(fs.readFileSync(file, "utf8"));
  const dec = 18;
  const f18 = (x) => ethers.formatUnits(x, dec) + " USDT";

  const token = await ethers.getContractAt("MockTokenD", D.settlementToken);
  const factory = await ethers.getContractAt("EscrowFactory", D.escrowFactory);
  const vault = await ethers.getContractAt("FeeVault", D.feeVault);
  const opt = await ethers.getContractAt("OptimisticArbitrator", D.optimisticArbitrator);
  const jury = await ethers.getContractAt("StakedJury", D.stakedJury);

  console.log("结算币 " + D.settlementToken);
  row("symbol", await token.symbol(), "USDT");
  row("decimals", await token.decimals(), String(dec));

  console.log("\nEscrowFactory " + D.escrowFactory);
  row("implementation", await factory.implementation(), D.escrowImpl);
  row("defaultArbitrator", await factory.defaultArbitrator(), D.optimisticArbitrator);
  row("defaultFeeVault", await factory.defaultFeeVault(), D.feeVault);
  row("defaultFeeBps", await factory.defaultFeeBps(), String(D.feeBps));
  row("admin", await factory.admin(), D.deployer);

  console.log("\nFeeVault " + D.feeVault);
  row("beneficiary", await vault.beneficiary(), D.feeBeneficiary);

  console.log("\nOptimisticArbitrator " + D.optimisticArbitrator);
  row("registry(=工厂)", await opt.registry(), D.escrowFactory);
  row("finalArbitrator", await opt.finalArbitrator(), D.stakedJury);
  row("proposer", await opt.proposer(), D.proposer);
  row("costOf", f18(await opt.costOf(D.settlementToken)));
  row("bondOf", f18(await opt.bondOf(D.settlementToken)));

  console.log("\nStakedJury " + D.stakedJury);
  row("stakeToken", await jury.stakeToken(), D.settlementToken);
  row("jurySize", await jury.jurySize(), String(D.jurySize));
  row("minStake", f18(await jury.minStake()));
  row("stakePerVote", f18(await jury.stakePerVote()));
  row("costOf", f18(await jury.costOf(D.settlementToken)));
  row("admin", await jury.admin(), D.deployer);

  // 乐观层必须付得起陪审团 —— 付不起的话争议升级会在受理那一步直接 revert，
  // 而那时候钱已经锁在托管合约里了。
  const oc = await opt.costOf(D.settlementToken), jc = await jury.costOf(D.settlementToken);
  console.log("");
  if (oc >= jc) console.log("  乐观层服务费 " + f18(oc) + " ≥ 陪审团服务费 " + f18(jc) + " ✓ 升级付得起");
  else { bad++; console.log("  ✗ 乐观层服务费 " + f18(oc) + " < 陪审团 " + f18(jc) + "，争议无法升级"); }

  console.log("");
  if (bad) { console.log(bad + " 项对不上"); process.exit(1); }
  console.log("全部一致。");
}

main().catch((e) => { console.error(e); process.exit(1); });
