/**
 * 集成验证：信誉层 against 真实链。
 *
 * 单测验证的是纯函数（缺口怎么算、告警怎么报、排版合不合法）。
 * 这个脚本验证的是另外一半：机器人手写的 ABI 能不能真的从链上读出正确的数字。
 * 这两半都对了，展示出来的信誉才是真的 —— 读错一个字段，界面看起来完全正常，
 * 但用户会拿着一份错误的记录去决定要不要把钱交出去。
 *
 * 前置：
 *   npx hardhat node                                              (根目录)
 *   npx hardhat run scripts/setup-dispute.cjs --network localhost (根目录)
 * 然后：
 *   node test/reputation-integration.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";

const root = path.resolve(process.cwd(), "../..");
const net = JSON.parse(fs.readFileSync(path.join(root, ".localnet.json"), "utf8"));

process.env.TELEGRAM_BOT_TOKEN = "test:token";
process.env.RPC_URL = net.rpcUrl;
process.env.ESCROW_FACTORY = net.escrowFactory;
process.env.CHAIN_ID = "31337";
process.env.REPUTATION = net.reputation;
process.env.IDENTITY_BOND = net.identityBond;

const rep = await import("../src/reputation.js");
const { tokenInfo } = await import("../src/deals.js");

// cacheTimeout: -1 关闭 ethers 的 RPC 响应缓存 ——
// 默认缓存会让连续发交易时 getTransactionCount 取到旧值，导致 nonce 撞车。
const provider = new ethers.JsonRpcProvider(net.rpcUrl, undefined, { cacheTimeout: -1 });

const KEYS = {
  buyer: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  seller: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
  other: "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
};
const w = Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [k, new ethers.Wallet(v, provider)]));

// 卖家每次用一个全新地址。
// 身份押金一旦进入撤押公示期就无法再加仓（这是刻意的：公示的数字必须与
// 实际敞口一致），所以复用固定地址会让脚本第二次运行必然失败。
// 用新地址还有一个好处：验证的是「一个真正的新身份」从零开始的完整路径。
w.seller = ethers.Wallet.createRandom().connect(provider);
await (await w.buyer.sendTransaction({ to: w.seller.address, value: ethers.parseEther("1") })).wait();

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? "✔" : "✘"} ${msg}`);
  if (!cond) failures++;
};

const U = (n) => BigInt(n) * 1_000_000n;

const FACTORY_ABI = [
  "function createDeal(address token,address buyer,address seller,uint256 price,uint256 buyerBond,uint256 sellerBond,uint64 deliveryWindow,uint64 inspectionWindow,bytes32 termsHash) returns (address)",
  "event DealCreated(address indexed deal, address indexed buyer, address indexed seller, address token, uint256 price, uint256 buyerBond, uint256 sellerBond, address arbitrator, uint16 feeBps, bytes32 termsHash)",
];
const ESCROW_ABI = ["function depositBuyer()", "function depositSeller()", "function confirmReceipt()"];
const ERC20_ABI = [
  "function approve(address,uint256) returns (bool)",
  "function mint(address,uint256)",
  "function balanceOf(address) view returns (uint256)",
];
const REP_WRITE_ABI = ["function record(address)"];
const BOND_WRITE_ABI = ["function bond(uint256)", "function requestUnbond()"];

const factory = new ethers.Contract(net.escrowFactory, FACTORY_ABI, w.seller);

for (const p of [w.buyer, w.seller, w.other]) {
  await (await new ethers.Contract(net.token, ERC20_ABI, p).mint(p.address, U(100000))).wait();
}

async function completedDeal(buyer, seller) {
  const rc = await (await new ethers.Contract(net.escrowFactory, FACTORY_ABI, seller).createDeal(
    net.token, buyer.address, seller.address,
    U(1000), U(1000), U(1000), 3 * 24 * 3600, 2 * 24 * 3600,
    ethers.keccak256(ethers.toUtf8Bytes("集成测试条款"))
  )).wait();
  const addr = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
    .find((p) => p?.name === "DealCreated").args.deal;

  await (await new ethers.Contract(net.token, ERC20_ABI, seller).approve(addr, U(1000))).wait();
  await (await new ethers.Contract(addr, ESCROW_ABI, seller).depositSeller()).wait();
  await (await new ethers.Contract(net.token, ERC20_ABI, buyer).approve(addr, U(2000))).wait();
  await (await new ethers.Contract(addr, ESCROW_ABI, buyer).depositBuyer()).wait();
  await (await new ethers.Contract(addr, ESCROW_ABI, buyer).confirmReceipt()).wait();
  return addr;
}

// ---- 1. 跑三笔成交：两笔与同一个买家，一笔与另一个买家 ----
console.log("制造交易记录…");
const deals = [
  await completedDeal(w.buyer, w.seller),
  await completedDeal(w.buyer, w.seller),
  await completedDeal(w.other, w.seller),
];

// ---- 2. 由一个与交易无关的第三方推送记录 ----
// 这一点很重要：如果只有当事人能推，骗子就能靠不调用来隐藏自己的记录。
const repWrite = new ethers.Contract(net.reputation, REP_WRITE_ABI, w.other);
for (const d of deals) await (await repWrite.record(d)).wait();
console.log(`已由第三方 ${w.other.address.slice(0, 10)}… 推送 ${deals.length} 条记录\n`);

// ---- 3. 卖家押入身份押金 ----
await (await new ethers.Contract(net.token, ERC20_ABI, w.seller).approve(net.identityBond, U(500))).wait();
await (await new ethers.Contract(net.identityBond, BOND_WRITE_ABI, w.seller).bond(U(500))).wait();

// ---- 4. 通过机器人自己的代码读回来 ----
const token = await rep.settlementToken(provider);
const info = await tokenInfo(token, provider);
const p = await rep.loadProfile(w.seller.address, token, provider);

console.log("从链上读回的卖家档案：");
console.log(`  成交 ${p.completed} 笔 · 对手方 ${p.counterparties} 个`);
console.log(`  成交额 ${ethers.formatUnits(p.volume, info.decimals)} ${info.symbol}`);
console.log(`  烧掉手续费 ${ethers.formatUnits(p.feesBurned, info.decimals)} ${info.symbol}`);
console.log(`  押金 ${ethers.formatUnits(p.committed, info.decimals)} ${info.symbol} · 年龄 ${rep.fmtAge(p.ageSec)}\n`);

console.log("=== 验证 ===");
check(token.toLowerCase() === net.token.toLowerCase(), "结算币种取自押金合约的 immutable token()");
check(p.completed === 3, `三笔成交都被记下（实际 ${p.completed}）`);
check(p.counterparties === 2, `三笔只有两个不同对手方（实际 ${p.counterparties}）—— 刷单的形状看得见`);
check(p.volume === U(3000), `累计成交额 3000（实际 ${ethers.formatUnits(p.volume, 6)}）`);
check(p.feesBurned > 0n, "手续费被计入「伪造这份记录的最低成本」");
check(p.committed === U(500), `承诺押金 500（实际 ${ethers.formatUnits(p.committed, 6)}）`);
check(p.ageSec >= 0 && p.bondedAt > 0, "身份年龄已开始计算");

// ---- 5. 风险评估：同一个对手方，两种参数，结论必须相反 ----
console.log("\n=== 风险评估 ===");
const weak = rep.assess({ price: U(10000), counterpartyBond: U(100), profile: p });
const strong = rep.assess({ price: U(1000), counterpartyBond: U(1000), profile: p });

console.log(`  货款 10000 / 对方保证金 100  → ${weak.level}（缺口 ${ethers.formatUnits(weak.gap, 6)}）`);
console.log(`  货款 1000  / 对方保证金 1000 → ${strong.level}`);

check(weak.level === "exposed", "大额 + 低保证金：红色，押金 500 盖不住 9900 的缺口");
check(strong.level === "covered", "保证金不低于货款：绿色，与对方是谁无关");
check(
  strong.gap === 0n,
  "绿色时缺口为 0 —— 用户不需要去判断一个陌生人可不可信"
);

// ---- 6. 真实数字渲染出的消息必须是合法 MarkdownV2 ----
const text = rep.renderAssessment({ profile: p, assessment: weak, info, roleLabel: "卖家" });
let inCode = false, bad = null;
for (let i = 0; i < text.length; i++) {
  const c = text[i];
  if (c === "\\") { i++; continue; }
  if (c === "`") { inCode = !inCode; continue; }
  if (inCode || c === "*") continue;
  if ("_[]()~>#+-=|{}.!".includes(c)) { bad = `第 ${i} 位 "${c}"`; break; }
}
check(bad === null, `真实链上数字渲染出的消息是合法 MarkdownV2${bad ? `（${bad}）` : ""}`);
check(inCode === false, "代码块闭合");

console.log("\n渲染结果：\n");
console.log(text.split("\n").map((l) => "  " + l).join("\n"));

// ---- 7. 幂等 ----
let dup = false;
try { await (await repWrite.record(deals[0])).wait(); } catch { dup = true; }
check(dup, "同一笔交易无法重复记录");

// ---- 8. 撤押公示立刻让「承诺押金」归零 ----
await (await new ethers.Contract(net.identityBond, BOND_WRITE_ABI, w.seller).requestUnbond()).wait();
const after = await rep.loadProfile(w.seller.address, token, provider);
check(after.committed === 0n, "申请撤押后，承诺押金立刻按 0 计（钱还在，但不能依赖）");
check(after.bondAmount === U(500), "但余额本身仍然如实显示");
check(
  rep.flags(after).some((f) => f.level === "danger" && f.text.includes("撤回")),
  "撤押状态被标成红色告警"
);

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
