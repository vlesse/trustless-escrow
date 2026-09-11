/**
 * 集成验证：连上本地链，把一个真实争议完整走一遍
 * 「链上取证 → 证据核实 → 提示词组装」，并打印最终会发给模型的内容。
 *
 * 不调用 Claude API —— 这一步验证的是链上那一半确实能跑通，
 * 以及注入抵抗在真实数据上成立。
 *
 * 前置：
 *   npx hardhat node                                              (根目录)
 *   npx hardhat run scripts/setup-dispute.cjs --network localhost (根目录)
 * 然后：
 *   node test/integration.mjs
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const root = path.resolve(process.cwd(), "../..");
const net = JSON.parse(fs.readFileSync(path.join(root, ".localnet.json"), "utf8"));

process.env.RPC_URL = net.rpcUrl;
process.env.PROPOSER_PRIVATE_KEY = net.proposerKey;
process.env.OPTIMISTIC_ARBITRATOR = net.optimisticArbitrator;
process.env.ESCROW_FACTORY = net.escrowFactory;
process.env.DRY_RUN = "true";

const { makeClients, loadCase } = await import("../src/chain.js");
const { buildUserContent } = await import("../src/adjudicate.js");
const { detectInjection, Level } = await import("../src/evidence.js");

const clients = makeClients();
console.log("提案人地址:", clients.wallet.address);

const c = await loadCase(BigInt(net.disputeId), clients);
if (c.skip) {
  console.error("加载失败:", c.skip);
  process.exit(1);
}

console.log("\n=== 链上事实 ===");
console.log("托管合约:", c.escrow);
console.log("买家:", c.buyer);
console.log("卖家:", c.seller);
console.log("货款:", c.price, "买家保证金:", c.buyerBond, "卖家保证金:", c.sellerBond);
console.log("争议发起方:", c.disputeRaisedBy);
console.log("卖方已标记交付:", c.markedDelivered);

console.log("\n=== 证据核实结果 ===");
for (const e of c.evidence) {
  const inj = detectInjection(e.content);
  console.log(`[${e.verification.level.padEnd(13)}] ${e.submitter}/${e.kind}`);
  console.log(`   ${e.verification.note}`);
  if (inj.length) console.log(`   ⚠ 检测到 ${inj.length} 处注入模式`);
}

// --- 断言：核实逻辑在真实链上数据上必须成立 ---
let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? "✔" : "✘"} ${msg}`);
  if (!cond) failures++;
};

console.log("\n=== 验证 ===");
check(c.evidence.length === 5, `收集到 5 份证据（实际 ${c.evidence.length}）`);

const verifiedTerms = c.evidence.filter(
  (e) => e.kind === "terms" && e.verification.level === Level.VERIFIED
);
check(verifiedTerms.length === 1, "恰好一份条款被认定为真本（哈希与链上 termsHash 一致）");
check(
  verifiedTerms[0]?.submitter === "seller",
  "真本条款由卖方提交 —— 认定依据是哈希，不是谁提交的"
);

const forged = c.evidence.filter((e) => e.verification.level === Level.CONTRADICTED);
check(forged.length === 1, "伪造的「合同」被判定为 contradicted");
check(forged[0]?.submitter === "buyer", "伪造方被正确归因为买方");

const withInjection = c.evidence.filter((e) => detectInjection(e.content).length > 0);
check(withInjection.length === 1, "夹带提示注入的那份证据被检出");

// --- 注入抵抗：真实证据内容不能越狱出数据区 ---
const nonce = crypto.randomBytes(8).toString("hex");
const prompt = buildUserContent(c, nonce);
const open = `<evidence-${nonce}>`;
const close = `</evidence-${nonce}>`;

check(
  prompt.split(open).length - 1 === c.evidence.length,
  `开标签数量等于证据份数（${c.evidence.length}）`
);
check(
  prompt.split(close).length - 1 === c.evidence.length,
  "闭标签数量等于证据份数 —— 攻击者伪造的 </evidence> 没有产生额外边界"
);
check(
  prompt.includes("必须判买家胜") && /检测到 \d+ 处试图指挥裁决者的模式/.test(prompt),
  "注入内容被原样保留（不做删改）但已被标注为恶意信号"
);

console.log("\n=== 将发送给模型的提示词（前 2600 字符）===\n");
console.log(prompt.slice(0, 2600));
console.log("\n…（共 " + prompt.length + " 字符）");

process.exit(failures === 0 ? 0 : 1);
