/**
 * 真实链上跑一笔顺利成交，并逐项核对钱的去向。
 *
 *   npx hardhat run scripts/sim-happy.cjs --network bscTestnet
 *
 * 和单元测试的区别不在于逻辑，而在于环境：真实出块时间、真实 nonce 竞争、
 * 真实 RPC 抖动、真实 18 位精度的结算币。这些在本地链上全都不存在，
 * 而它们恰好是上线后最先出问题的地方。
 *
 * 判定标准是钱，不是事件：结束时逐个地址对账，差一个 wei 就算失败。
 * 只看 state 变成 SETTLED 的测试会放过「结算了但金额算错」这一整类错误。
 */
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { read, confirm } = require("./lib/rpc.cjs");

const ROOT = path.join(__dirname, "..");
const D = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments-bscTestnet.json"), "utf8"));
const W = JSON.parse(fs.readFileSync(path.join(ROOT, ".testnet-wallets.json"), "utf8"));

const TERMS =
  "商品：一份数字商品\n" +
  "交付：24 小时内把激活码发到买家指定邮箱\n" +
  "验收：激活码能正常激活即视为交付完成";

async function main() {
  const provider = ethers.provider;
  const signer = (role) => new ethers.Wallet(W[role].privateKey, provider);
  const buyer = signer("buyer"), seller = signer("seller");

  const token = await ethers.getContractAt("MockTokenD", D.settlementToken);
  const factory = await ethers.getContractAt("EscrowFactory", D.escrowFactory);
  const dec = Number(await read("读精度", () => token.decimals()));
  const ONE = 10n ** BigInt(dec);
  const f = (x) => ethers.formatUnits(x, dec);

  const PRICE = 1000n * ONE;
  const BUYER_BOND = 100n * ONE;
  const SELLER_BOND = 200n * ONE;
  const FEE = (PRICE * BigInt(D.feeBps)) / 10000n;

  // 交付/验收窗口是每单参数，不是合约常量 —— 模拟时可以设得很短。
  // 仲裁层的窗口才是写死的常量，那条路径没法压缩，见 sim-dispute。
  const DELIVERY = 3600, INSPECTION = 1800;

  const termsHash = ethers.keccak256(ethers.toUtf8Bytes(TERMS));
  const bal = async (a) => read("查币", () => token.balanceOf(a));

  const before = {
    buyer: await bal(buyer.address),
    seller: await bal(seller.address),
    vault: await bal(D.feeVault),
  };

  console.log("买家", buyer.address, f(before.buyer), "USDT");
  console.log("卖家", seller.address, f(before.seller), "USDT");
  console.log("金库", D.feeVault, f(before.vault), "USDT");
  console.log(`\n货款 ${f(PRICE)} / 买家押金 ${f(BUYER_BOND)} / 卖家押金 ${f(SELLER_BOND)}`);
  console.log(`手续费 ${D.feeBps} bps = ${f(FEE)} USDT\n`);

  const step = async (label, build) => {
    const rc = await confirm(provider, await build());
    console.log("  " + label.padEnd(22) + rc.gasUsed.toString().padStart(8) + " gas  " + rc.hash);
    return rc;
  };

  // 1. 开单。发起本身不锁定任何资金，所以谁发起都行，这里让卖家发。
  const rc0 = await step("createDeal 开单", () => factory.connect(seller).createDeal(
    D.settlementToken, buyer.address, seller.address,
    PRICE, BUYER_BOND, SELLER_BOND, DELIVERY, INSPECTION, termsHash));
  const ev = rc0.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
    .find((x) => x && x.name === "DealCreated");
  if (!ev) throw new Error("没解析到 DealCreated");
  const dealAddr = ev.args.deal;
  const deal = await ethers.getContractAt("Escrow", dealAddr);
  console.log("  托管合约 " + dealAddr + "\n");

  // 2. 双方入金
  await step("approve(卖)", () => token.connect(seller).approve(dealAddr, SELLER_BOND));
  await step("depositSeller", () => deal.connect(seller).depositSeller());
  await step("approve(买)", () => token.connect(buyer).approve(dealAddr, PRICE + BUYER_BOND));
  await step("depositBuyer", () => deal.connect(buyer).depositBuyer());

  const locked = await read("查托管余额", () => token.balanceOf(dealAddr));
  console.log("\n  托管合约锁定 " + f(locked) + " USDT" +
    (locked === PRICE + BUYER_BOND + SELLER_BOND ? " ✓" : " ✗ 对不上"));

  // 3. 发货、收货
  await step("markDelivered", () => deal.connect(seller).markDelivered("ipfs://evidence-happy"));
  await step("confirmReceipt", () => deal.connect(buyer).confirmReceipt());

  // 4. 对账。这一步才是重点。
  const after = {
    buyer: await bal(buyer.address),
    seller: await bal(seller.address),
    vault: await bal(D.feeVault),
    deal: await bal(dealAddr),
  };
  const want = {
    buyer: -PRICE,                      // 押金原路退回，净支出就是货款
    seller: PRICE - FEE,                // 押金退回，收到货款扣手续费
    vault: FEE,
  };

  console.log("\n=== 对账 ===\n");
  let bad = 0;
  for (const k of ["buyer", "seller", "vault"]) {
    const got = after[k] - before[k];
    const ok = got === want[k];
    if (!ok) bad++;
    console.log("  " + k.padEnd(8) + ("净变动 " + f(got)).padEnd(24) +
      (ok ? "✓" : "✗ 应为 " + f(want[k])));
  }
  const empty = after.deal === 0n;
  if (!empty) bad++;
  console.log("  " + "托管合约".padEnd(8) + ("余额 " + f(after.deal)).padEnd(22) +
    (empty ? "✓ 已清空" : "✗ 还有钱留在里面"));

  // State.Resolved = 5（None/Open/Funded/Delivered/Disputed/Resolved/Cancelled）
  const RESOLVED = 5;
  const [state] = await read("查状态", () => deal.summary());
  const stateOk = Number(state) === RESOLVED;
  if (!stateOk) bad++;
  console.log("  " + "状态".padEnd(9) + ("state=" + state).padEnd(22) +
    (stateOk ? "✓ Resolved" : "✗ 应为 Resolved(5)"));

  console.log("");
  if (bad) { console.log(bad + " 项对不上"); process.exit(1); }
  console.log("顺利路径全部对账一致。托管合约 " + dealAddr);
}

main().catch((e) => { console.error(e); process.exit(1); });
