/**
 * 在真实链上把一笔交易推进到「争议已升级到陪审团」。
 *
 *   npx hardhat run scripts/sim-dispute.cjs --network bscTestnet
 *
 * 之后的每一步都要等真实时间，没法快进：
 *   抽选   需再出 10 个区块（约 5 秒），由 keeper 触发
 *   投票   COMMIT_WINDOW 3 天
 *   揭示   REVEAL_WINDOW 2 天
 *   上诉   APPEAL_WINDOW 2 天
 * 所以这个脚本只负责把局面摆好，剩下的交给 keeper 和 sim-jury-vote。
 *
 * 状态写进 .sim-dispute.json，后续脚本据此接力 —— 把中间状态记在文件里
 * 而不是让人抄地址，是因为这条流程要跨越好几天、好几次登录。
 */
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { read, confirm } = require("./lib/rpc.cjs");

const ROOT = path.join(__dirname, "..");
const D = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments-bscTestnet.json"), "utf8"));
const W = JSON.parse(fs.readFileSync(path.join(ROOT, ".testnet-wallets.json"), "utf8"));
const OUT = path.join(ROOT, ".sim-dispute.json");

const TERMS =
  "商品：一份数字商品\n" +
  "交付：24 小时内把激活码发到买家指定邮箱\n" +
  "验收：激活码能正常激活即视为交付完成";

const BUYER_CLAIM = "data:text/plain;base64," + Buffer.from(
  "卖家发来的激活码提示「已被使用」，无法激活。已附激活失败截图与时间戳。", "utf8").toString("base64");

async function main() {
  // 重跑会在链上再造一个并行的案子。那不是「重试」，那是多了一个
  // 同样在走 9 天流程的案件，观察 keeper 时根本分不清是哪一个。
  if (fs.existsSync(OUT)) {
    console.error("已存在 " + OUT + "，说明这个场景已经在链上跑着了。");
    console.error("要开一个新的，先手工改名保存旧的。");
    process.exit(1);
  }

  const provider = ethers.provider;
  const S = (role) => new ethers.Wallet(W[role].privateKey, provider);

  const token = await ethers.getContractAt("MockTokenD", D.settlementToken);
  const factory = await ethers.getContractAt("EscrowFactory", D.escrowFactory);
  const opt = await ethers.getContractAt("OptimisticArbitrator", D.optimisticArbitrator);
  const jury = await ethers.getContractAt("StakedJury", D.stakedJury);

  const dec = Number(await read("读精度", () => token.decimals()));
  const ONE = 10n ** BigInt(dec);
  const f = (x) => ethers.formatUnits(x, dec);

  const step = async (label, build) => {
    const rc = await confirm(provider, await build());
    console.log("  " + label.padEnd(26) + rc.gasUsed.toString().padStart(8) + " gas");
    return rc;
  };

  // ---------- 1. 陪审员池 ----------
  // 池子必须在挑战发生之前就有人，否则抽选无人可抽。
  // 五个人抽三席，让抽选真的有选择余地 —— 池子恰好等于席位数时，
  // 抽选算法的任何偏差都测不出来。
  const STAKE = 5000n * ONE;
  console.log("陪审员质押（最低 " + f(await read("读门槛", () => jury.minStake())) + " USDT）");
  for (const r of ["juror1", "juror2", "juror3", "juror4", "juror5"]) {
    const w = S(r);
    const have = await read("查质押", () => jury.stakeOf(w.address));
    if (have >= STAKE) { console.log("  " + r.padEnd(26) + "已有 " + f(have) + " USDT"); continue; }
    const need = STAKE - have;
    await step(r + " approve", () => token.connect(w).approve(D.stakedJury, need));
    await step(r + " stake " + f(need), () => jury.connect(w).stake(need));
  }
  console.log("  池内总质押 " + f(await read("查总量", () => jury.totalStake())) + " USDT\n");

  // ---------- 2. 一笔正常开始、最后闹翻的交易 ----------
  const buyer = S("buyer"), seller = S("seller");
  const PRICE = 1000n * ONE, BUYER_BOND = 100n * ONE, SELLER_BOND = 200n * ONE;
  const termsHash = ethers.keccak256(ethers.toUtf8Bytes(TERMS));

  console.log("开单并双方入金");
  const rc0 = await step("createDeal", () => factory.connect(seller).createDeal(
    D.settlementToken, buyer.address, seller.address,
    PRICE, BUYER_BOND, SELLER_BOND, 3600, 86400, termsHash));
  const dealAddr = rc0.logs.map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
    .find((x) => x && x.name === "DealCreated").args.deal;
  const deal = await ethers.getContractAt("Escrow", dealAddr);
  console.log("  托管合约 " + dealAddr);

  await step("approve(卖)", () => token.connect(seller).approve(dealAddr, SELLER_BOND));
  await step("depositSeller", () => deal.connect(seller).depositSeller());
  await step("approve(买)", () => token.connect(buyer).approve(dealAddr, PRICE + BUYER_BOND));
  await step("depositBuyer", () => deal.connect(buyer).depositBuyer());
  await step("markDelivered", () => deal.connect(seller).markDelivered("ipfs://code-sent"));

  // ---------- 3. 买家起争议 ----------
  console.log("\n买家提起争议");
  await step("raiseDispute", () => deal.connect(buyer).raiseDispute(BUYER_CLAIM));
  const optID = await read("读争议号", () => deal.disputeID());
  console.log("  乐观层争议号 " + optID);

  // ---------- 4. AI 提案（带保证金） ----------
  // 这里用脚本代替提案人服务，目的是把局面推到陪审团那一段。
  // 提案人服务本身的验证要另外做 —— 那考的是「它读得懂证据吗」，
  // 而这里考的是「链上这条升级路径通不通」。
  const proposer = S("proposer");
  const bond = await read("读保证金", () => opt.bondOf(D.settlementToken));
  console.log("\nAI 提案（保证金 " + f(bond) + " USDT，裁决 = 退款给买家）");
  await step("approve(提案人)", () => token.connect(proposer).approve(D.optimisticArbitrator, bond));
  await step("propose ruling=1", () => opt.connect(proposer).propose(optID, 1));

  // ---------- 5. 挑战，升级到陪审团 ----------
  // challenge 刻意不限制调用者身份：纠错权对所有人开放，
  // 这正是机器人不构成单点的原因。
  const challenger = S("challenger");
  console.log("\n旁观者挑战（等额保证金），案件升级");
  await step("approve(挑战者)", () => token.connect(challenger).approve(D.optimisticArbitrator, bond));
  const rcC = await step("challenge", () => opt.connect(challenger).challenge(optID));
  const chEv = rcC.logs.map((l) => { try { return opt.interface.parseLog(l); } catch { return null; } })
    .find((x) => x && x.name === "Challenged");
  const caseID = chEv.args.finalDisputeID;

  const head = await read("读块高", () => provider.getBlockNumber());
  const state = {
    createdAt: new Date().toISOString(),
    deal: dealAddr,
    optimisticDisputeID: optID.toString(),
    juryCaseID: caseID.toString(),
    proposedRuling: 1,
    challengeBlock: head,
    jurors: ["juror1", "juror2", "juror3", "juror4", "juror5"].map((r) => W[r].address),
  };
  fs.writeFileSync(OUT, JSON.stringify(state, null, 2));

  console.log("\n=== 局面已摆好 ===\n");
  console.log("  托管合约      " + dealAddr);
  console.log("  陪审团案件号   " + caseID);
  console.log("  当前块高      " + head);
  console.log("  状态已写入 " + path.basename(OUT));
  console.log("\n接下来（都要等真实时间，没法快进）：");
  console.log("  1. 再出 10 个区块后，keeper 调 drawJurors 抽签（本链约 5 秒）");
  console.log("  2. 抽中的陪审员在 3 天内 commitVote —— 跑 scripts/sim-jury-vote.cjs");
  console.log("  3. keeper 调 startReveal，陪审员 2 天内 revealVote");
  console.log("  4. keeper 调 tallyRound，再等 2 天上诉期");
  console.log("  5. keeper 调 finalize，裁决传导回托管合约");
  console.log("\n  keeper 现在是 DRY_RUN=true，只会打印不会发交易。");
  console.log("  确认它算的都对之后再把 DRY_RUN 改成 false。");
}

main().catch((e) => { console.error(e); process.exit(1); });
