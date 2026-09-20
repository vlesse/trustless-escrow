/**
 * 生成测试网要用的一组钱包。
 *
 *   node scripts/testnet-wallets.cjs
 *
 * 这些是**一次性测试网钥匙**，不承载任何真实价值，所以可以由脚本生成、
 * 明文落盘。主网的钥匙绝不能这么来 —— 那几把必须你自己在离线环境里生成。
 *
 * 输出文件 .testnet-wallets.json 已在 .gitignore 里，权限 600。
 * 终端只打印地址，私钥不回显 —— 免得被复制进聊天记录或日志。
 */
const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

// 角色和它们各自要做的事。风险等级不同的钥匙不共用，测试网也照这个分，
// 因为上线时的运维脚本是从这里长出去的。
const ROLES = {
  deployer:  "部署者兼管理员。唯一需要你手工打水的地址，其余的由它分发。",
  proposer:  "AI 提案人。要 gas，还要 MockUSDT 做质押。",
  keeper:    "推进器。只要 gas。",
  beneficiary: "手续费受益地址（模拟冷钱包）。immutable，只用地址，永不动用私钥。",
  buyer:     "模拟买家",
  seller:    "模拟卖家",
  juror1:    "模拟陪审员 1",
  juror2:    "模拟陪审员 2",
  juror3:    "模拟陪审员 3",
  juror4:    "模拟陪审员 4",
  juror5:    "模拟陪审员 5",
  challenger: "模拟挑战者（用来测乐观层被挑战后升级到陪审团那条路）",
};

const out = path.join(__dirname, "..", ".testnet-wallets.json");
if (fs.existsSync(out)) {
  console.error("已存在 " + out + "，不覆盖。");
  console.error("要重新生成请先手工删除 —— 覆盖等于把已经打过水的地址丢掉。");
  process.exit(1);
}

const wallets = {};
for (const [role, note] of Object.entries(ROLES)) {
  const w = ethers.Wallet.createRandom();
  wallets[role] = { address: w.address, privateKey: w.privateKey, note };
}

fs.writeFileSync(out, JSON.stringify(wallets, null, 2), { mode: 0o600 });
fs.chmodSync(out, 0o600);

console.log("已写入 " + out + " (600)\n");
for (const [role, w] of Object.entries(wallets)) {
  console.log(role.padEnd(12), w.address, " ", w.note);
}
console.log("\n只需要给 deployer 打测试网 ETH，其余地址由它分发。");
