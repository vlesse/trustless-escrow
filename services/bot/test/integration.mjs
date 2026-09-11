/**
 * 集成验证：机器人的读链路径 against 真实部署的合约。
 *
 * 单测覆盖的是纯函数（状态机、校验、编码）。这个脚本验证的是
 * 「真的能从链上读出正确的交易状态，并据此给出正确的可用操作」——
 * 前端把不可用的操作显示成可点，用户会白白付 gas 换 revert。
 *
 * 前置：
 *   npx hardhat node                                              (根目录)
 *   npx hardhat run scripts/setup-dispute.cjs --network localhost (根目录)
 * 然后：
 *   node test/integration.mjs
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

const { makeProvider, loadDeal, listDeals, roleOf, availableActions, tokenInfo, fmtAmount, factoryAt, STATE_NAME, State } =
  await import("../src/deals.js");
const { buildDepositFlow, buildAction } = await import("../src/txlink.js");

const provider = makeProvider();

let failures = 0;
const check = (cond, msg) => {
  console.log(`${cond ? "✔" : "✘"} ${msg}`);
  if (!cond) failures++;
};

const deal = await loadDeal(net.deal, provider);
const info = await tokenInfo(deal.token, provider);

console.log("=== 从链上读到的交易 ===");
console.log("地址:", deal.address);
console.log("状态:", STATE_NAME[deal.state]);
console.log("货款:", fmtAmount(deal.price, info));
console.log("买家保证金:", fmtAmount(deal.buyerBond, info), deal.buyerFunded ? "已入金" : "未入金");
console.log("卖家保证金:", fmtAmount(deal.sellerBond, info), deal.sellerFunded ? "已入金" : "未入金");
console.log("仲裁层:", deal.arbitrator);

console.log("\n=== 验证 ===");
check(deal.state === State.Disputed, `状态正确读出为「争议中」（实际 ${STATE_NAME[deal.state]}）`);
check(deal.buyerFunded && deal.sellerFunded, "双方入金标志正确");
check(info.symbol === "mUSD" && info.decimals === 6, `代币元数据正确读出（${info.symbol}/${info.decimals}）`);
check(
  deal.arbitrator.toLowerCase() === net.optimisticArbitrator.toLowerCase(),
  "交易快照的仲裁层地址与部署一致"
);
check(
  deal.termsHash.toLowerCase() === net.termsHash.toLowerCase(),
  "条款哈希与创建时一致"
);

// 角色识别
check(roleOf(deal, deal.buyer) === "buyer", "买家地址被识别为 buyer");
check(roleOf(deal, deal.seller) === "seller", "卖家地址被识别为 seller");
check(roleOf(deal, ethers.ZeroAddress) === null, "无关地址被识别为第三方");

// 争议中的可用操作
const buyerActs = availableActions(deal, "buyer").map((a) => a.id);
const sellerActs = availableActions(deal, "seller").map((a) => a.id);
check(
  buyerActs.length === 1 && buyerActs[0] === "evidence",
  `争议中买家只能补充证据（实际 ${JSON.stringify(buyerActs)}）`
);
check(
  sellerActs.length === 1 && sellerActs[0] === "evidence",
  `争议中卖家只能补充证据（实际 ${JSON.stringify(sellerActs)}）`
);
check(
  availableActions(deal, null).length === 0,
  "第三方在争议中无任何可用操作"
);

// 工厂登记校验 —— 防钓鱼合约
const f = factoryAt(provider);
check(await f.isDeal(deal.address), "工厂确认这是它创建的实例");
check(!(await f.isDeal(net.token)), "非托管合约地址被工厂否认（钓鱼防护生效）");

// 交易列表
const buyerDeals = await listDeals(deal.buyer, provider);
check(
  buyerDeals.some((a) => a.toLowerCase() === deal.address.toLowerCase()),
  "该交易出现在买家的列表里"
);

// 生成的 calldata 必须能被真实合约接受（用 staticCall 打一次真链）
const escrowIface = new ethers.Interface([
  "function submitEvidence(string evidenceURI)",
  "function confirmReceipt()",
]);
const tx = buildAction(deal.address, "submitEvidence", ["ipfs://QmProbe"], "提交证据");
try {
  await provider.call({ to: tx.to, data: tx.data, from: deal.buyer });
  check(true, "生成的 submitEvidence calldata 被真实合约接受（staticCall 通过）");
} catch (e) {
  check(false, `生成的 calldata 被合约拒绝: ${e.shortMessage ?? e.message}`);
}

// 反向验证：当前状态下不该可用的操作，合约确实会拒绝
const bad = buildAction(deal.address, "confirmReceipt", [], "确认收货");
try {
  await provider.call({ to: bad.to, data: bad.data, from: deal.buyer });
  check(false, "confirmReceipt 在争议状态下竟然没被拒绝 —— 状态机与合约不一致");
} catch {
  check(true, "争议状态下 confirmReceipt 被合约拒绝，与机器人隐藏该操作的判断一致");
}

// 入金流程的两笔交易指向正确
const flow = buildDepositFlow({
  token: deal.token, escrow: deal.address, amount: deal.price + deal.buyerBond, role: "buyer",
});
check(flow.length === 2, "入金拆成授权 + 入金两笔");
check(flow[0].to.toLowerCase() === deal.token.toLowerCase(), "第一笔打给代币合约");
check(flow[1].to.toLowerCase() === deal.address.toLowerCase(), "第二笔打给托管合约");

console.log(failures === 0 ? "\n全部通过" : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
