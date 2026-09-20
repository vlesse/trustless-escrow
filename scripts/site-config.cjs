/**
 * 从 deployments-*.json 生成网站要用的链配置。
 *
 *   node scripts/site-config.cjs bscTestnet
 *
 * 不手抄地址：官网上公示的合约地址和实际部署的必须是同一份，
 * 抄错一个字符，整页数字就是另一套合约的，而页面不会有任何异常。
 * 重新部署后重跑这个脚本，别改 site/chain-config.js。
 */
const fs = require("fs");
const path = require("path");

const net = process.argv[2] || "bscTestnet";
const ROOT = path.join(__dirname, "..");
const D = JSON.parse(fs.readFileSync(path.join(ROOT, `deployments-${net}.json`), "utf8"));

const EXPLORER = { 97: "https://testnet.bscscan.com", 56: "https://bscscan.com" }[D.chainId];
const RPC = { 97: "https://bsc-testnet-rpc.publicnode.com", 56: "https://bsc-dataseed.bnbchain.org" }[D.chainId];
if (!EXPLORER || !RPC) throw new Error("不认识的链 " + D.chainId + "，先在本脚本里补上它的浏览器和 RPC");

const out = `// 由 scripts/site-config.cjs 从 deployments-${net}.json 生成，不要手改。
// 重新部署后重跑：node scripts/site-config.cjs ${net}
window.SITE_CHAIN = ${JSON.stringify({
  chainId: D.chainId,
  chainName: D.chainId === 97 ? "BNB Smart Chain Testnet" : "BNB Smart Chain",
  isTestnet: D.chainId !== 56,
  rpcUrl: RPC,
  explorer: EXPLORER,
  feeBps: D.feeBps,
  jurySize: D.jurySize,
  settlementToken: D.settlementToken,
  feeBeneficiary: D.feeBeneficiary,
  escrowFactory: D.escrowFactory,
  feeVault: D.feeVault,
  optimisticArbitrator: D.optimisticArbitrator,
  stakedJury: D.stakedJury,
  escrowImpl: D.escrowImpl,
  identityBond: D.identityBond,
  reputation: D.reputation,
}, null, 2)};
`;
const dest = path.join(ROOT, "site", "chain-config.js");
fs.writeFileSync(dest, out);
console.log("已写入 " + path.relative(ROOT, dest) + "（链 " + D.chainId + "，工厂 " + D.escrowFactory + "）");
