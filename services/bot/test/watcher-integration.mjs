/**
 * 集成验证：监听器 against 真实链上的完整交易生命周期。
 *
 * 单测验证的是「消息文案正确且是合法 MarkdownV2」。这个脚本验证的是
 * 「真的能从链上捞到事件，并推给正确的人」—— 通知推错人比不推更糟，
 * 因为它会泄露交易对手的动向。
 *
 * 前置：
 *   npx hardhat node                                              (根目录)
 *   npx hardhat run scripts/setup-dispute.cjs --network localhost (根目录，为了拿到工厂地址)
 * 然后：
 *   node test/watcher-integration.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";

const root = path.resolve(process.cwd(), "../..");
const net = JSON.parse(fs.readFileSync(path.join(root, ".localnet.json"), "utf8"));

const STATE_FILE = path.join(process.cwd(), ".watcher-test-state.json");
try { fs.unlinkSync(STATE_FILE); } catch {}

process.env.TELEGRAM_BOT_TOKEN = "test:token";
process.env.RPC_URL = net.rpcUrl;
process.env.ESCROW_FACTORY = net.escrowFactory;
process.env.CHAIN_ID = "31337";
process.env.CONFIRMATIONS = "0";          // 本地链不会重组，测试里不等确认
process.env.WATCH_INTERVAL_MS = "999999"; // 手动驱动，不让它自己轮询
process.env.STATE_FILE = STATE_FILE;

const session = await import("../src/session.js");
const { describeEvent, describeDeadline } = await import("../src/watcher.js");

// hardhat 默认账户
const KEYS = {
  deployer: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  buyer: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  seller: "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
};

// cacheTimeout: -1 关闭 ethers 的 RPC 响应缓存。
// 默认缓存会让连续发交易时 getTransactionCount 取到旧值，导致 nonce 撞车 ——
// 这是本地快速连发交易的测试脚本才会遇到的问题，生产代码不受影响。
const provider = new ethers.JsonRpcProvider(net.rpcUrl, undefined, { cacheTimeout: -1 });
const w = Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [k, new ethers.Wallet(v, provider)]));

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? "✔" : "✘"} ${msg}`);
  if (!cond) failures++;
};

// ---- 1. 造一笔新交易并让双方入金 ----
const FACTORY_ABI = [
  "function createDeal(address token,address buyer,address seller,uint256 price,uint256 buyerBond,uint256 sellerBond,uint64 deliveryWindow,uint64 inspectionWindow,bytes32 termsHash) returns (address)",
  "event DealCreated(address indexed deal, address indexed buyer, address indexed seller, address token, uint256 price, uint256 buyerBond, uint256 sellerBond, address arbitrator, uint16 feeBps, bytes32 termsHash)",
];
const ESCROW_ABI = [
  "function depositBuyer()", "function depositSeller()",
  "function markDelivered(string)", "function confirmReceipt()",
];
const ERC20_ABI = ["function approve(address,uint256) returns (bool)", "function mint(address,uint256)"];

const U = (n) => BigInt(n) * 1_000_000n;
const factory = new ethers.Contract(net.escrowFactory, FACTORY_ABI, w.seller);
// 各自 mint 各自的：MockERC20 的 mint 无权限控制，
// 这样能绕开 deployer 账户 —— 它刚被部署脚本用过，nonce 容易撞。
for (const p of [w.buyer, w.seller]) {
  const t = new ethers.Contract(net.token, ERC20_ABI, p);
  await (await t.mint(p.address, U(100000))).wait();
}

const rc = await (await factory.createDeal(
  net.token, w.buyer.address, w.seller.address,
  U(1000), U(1000), U(1000), 3 * 24 * 3600, 2 * 24 * 3600,
  ethers.keccak256(ethers.toUtf8Bytes("生命周期测试条款"))
)).wait();
const dealAddr = rc.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
  .find((p) => p?.name === "DealCreated").args.deal;
console.log("新交易:", dealAddr, "\n");

// ---- 2. 把两个假的 Telegram 用户绑到买卖双方 ----
session.load();
session.user("1001").address = w.buyer.address;
session.user("2002").address = w.seller.address;
session.save();

// ---- 3. 用捕获函数代替真实 Telegram，驱动完整生命周期 ----
const sent = [];
const notify = async (chatId, text) => { sent.push({ chatId: String(chatId), text }); };

// 直接复用监听器内部的发现/处理逻辑：重新 import 一份并手动跑 tick
// （start() 会 setInterval，测试里不需要）
const watcherSrc = await import("../src/watcher.js");

async function tick(fromBlock, toBlock) {
  // watcher.js 没有导出内部函数，这里用 start() 的等价流程：
  // 由于 WATCH_INTERVAL_MS 极大，start() 只会立刻跑一次 tick 然后挂起
  void fromBlock; void toBlock;
}

// 用 start() 跑第一次（它内部会 await 一次 tick）
process.env.WATCH_FROM_BLOCK = "0";
await watcherSrc.start(notify);

const escrowBuyer = new ethers.Contract(dealAddr, ESCROW_ABI, w.buyer);
const escrowSeller = new ethers.Contract(dealAddr, ESCROW_ABI, w.seller);
const tokenBuyer = new ethers.Contract(net.token, ERC20_ABI, w.buyer);
const tokenSeller = new ethers.Contract(net.token, ERC20_ABI, w.seller);

await (await tokenSeller.approve(dealAddr, U(1000))).wait();
await (await escrowSeller.depositSeller()).wait();
await (await tokenBuyer.approve(dealAddr, U(2000))).wait();
await (await escrowBuyer.depositBuyer()).wait();
await (await escrowSeller.markDelivered("ipfs://proof")).wait();
await (await escrowBuyer.confirmReceipt()).wait();

// 再跑一轮监听，把上面这些事件全部捞出来
sent.length = 0;
await watcherSrc.start(notify);
await new Promise((r) => setTimeout(r, 500));

console.log(`\n捕获到 ${sent.length} 条通知：\n`);
for (const m of sent) {
  console.log(`  → 用户 ${m.chatId}: ${m.text.split("\n").slice(0, 2).join(" | ").slice(0, 88)}`);
}

// ---- 4. 断言 ----
console.log("\n=== 验证 ===");
const toBuyer = sent.filter((m) => m.chatId === "1001");
const toSeller = sent.filter((m) => m.chatId === "2002");

check(sent.length > 0, `监听器确实从链上捞到了事件（${sent.length} 条）`);
check(toBuyer.length > 0 && toSeller.length > 0, "买卖双方都收到了通知");

// 卖家入金 → 只有买家被通知；买家入金 → 只有卖家被通知
const depositToBuyer = toBuyer.filter((m) => m.text.includes("对方已入金"));
const depositToSeller = toSeller.filter((m) => m.text.includes("对方已入金"));
check(depositToBuyer.length === 1, `买家收到 1 条「对方已入金」（实际 ${depositToBuyer.length}）`);
check(depositToSeller.length === 1, `卖家收到 1 条「对方已入金」（实际 ${depositToSeller.length}）`);
check(
  !sent.some((m) => m.text.includes("对方已入金") && m.text.includes("你自己")),
  "没有人收到「你自己入金了」这种废话通知"
);

// 交付通知只给买家 —— 要开始验收的是他
const delivered = sent.filter((m) => m.text.includes("卖家已标记交付"));
check(delivered.length === 1 && delivered[0].chatId === "1001",
  "「卖家已标记交付」只发给买家");
check(delivered[0]?.text.includes("自动放给卖家"),
  "交付通知里说清了「逾期未操作货款自动放给卖家」");

// 结算通知双方都有，且金额各自不同
const settledB = toBuyer.find((m) => m.text.includes("交易已结束"));
const settledS = toSeller.find((m) => m.text.includes("交易已结束"));
check(Boolean(settledB) && Boolean(settledS), "双方都收到结算通知");
check(
  settledB && settledS && settledB.text !== settledS.text,
  "两方的结算通知内容不同（各自实收金额不同）"
);

// 幂等：再跑一轮不应重复推送
sent.length = 0;
await watcherSrc.start(notify);
await new Promise((r) => setTimeout(r, 500));
check(sent.length === 0, `重复扫描不产生重复通知（实际 ${sent.length} 条）`);

try { fs.unlinkSync(STATE_FILE); } catch {}
console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
