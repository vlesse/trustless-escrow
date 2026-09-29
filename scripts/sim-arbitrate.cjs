/**
 * 扮演仲裁层里的两个角色，配合真人当事人一步一步推进争议。
 *
 *   DEAL=0x... STEP=propose RULING=1 npx hardhat run scripts/sim-arbitrate.cjs --network bscTestnet
 *   DEAL=0x... STEP=challenge          npx hardhat run scripts/sim-arbitrate.cjs --network bscTestnet
 *
 * propose   用提案人钱包给出初步裁决（代替 AI 提案人服务 —— 服务器上没配 AI 密钥，
 *           这里测的是链上流程通不通，不是 AI 判得准不准）。RULING：1 买家胜，2 卖家胜。
 * challenge 用挑战人钱包（第三方）挑战，把案子升级到陪审团，并写 .sim-dispute.json
 *           给后面的陪审员投票脚本接力。
 *
 * sim-dispute.cjs 把这些步骤一口气做完；那适合纯脚本回归，不适合真人参与 ——
 * 真人需要在每一步之后看到推送、有机会做自己的操作。
 */
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { read, confirm } = require("./lib/rpc.cjs");

const ROOT = path.join(__dirname, "..");
const D = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments-bscTestnet.json"), "utf8"));
const W = JSON.parse(fs.readFileSync(path.join(ROOT, ".testnet-wallets.json"), "utf8"));
const OUT = path.join(ROOT, ".sim-dispute.json");
const STATUS = ["None", "Open(等提案)", "Proposed(挑战期)", "Escalated(陪审团)", "Executed"];

/*
 * 必须用 escrow 用户跑，不能用 root。
 *
 * 这个脚本写的状态文件（投票 salt、案件号）后面几天由定时任务接力读取，
 * 而定时任务跑在 escrow 用户下。用 root 跑，文件就归 root、权限 600 ——
 * 三天后揭示时读不到 salt，三席全被当成弃权、质押罚没，案子拖到超时以
 * 「不判输赢」收场。实测差点就这样：投完票才发现文件是 root 的。
 */
function refuseRoot() {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    console.error("不要用 root 跑这个脚本。请用：sudo -u escrow npx hardhat run ...");
    console.error("（它写的状态文件要给 escrow 用户下的定时任务读，root 写的读不到）");
    process.exit(1);
  }
}

async function main() {
  refuseRoot();
  const dealAddr = process.env.DEAL;
  if (!dealAddr || !ethers.isAddress(dealAddr)) throw new Error("DEAL 缺失或不是合法地址");
  const step = process.env.STEP;

  const p = ethers.provider;
  const deal = await ethers.getContractAt("Escrow", dealAddr);
  const opt = await ethers.getContractAt("OptimisticArbitrator", D.optimisticArbitrator);
  const token = await ethers.getContractAt("MockTokenD", D.settlementToken);
  const f = (x) => ethers.formatUnits(x, 18);

  const arb = await read("读仲裁层", () => deal.arbitrator());
  if (arb.toLowerCase() !== D.optimisticArbitrator.toLowerCase()) throw new Error(`这笔交易的仲裁层是 ${arb}，不是当前部署的那个`);
  const id = await read("读争议号", () => deal.disputeID());
  const show = async (label, blockTag) => {
    const d = await read("读争议", () => opt.disputes(id, blockTag ? { blockTag } : {}));
    console.log(`${label}  争议 ${id}  状态=${STATUS[Number(d.status)]}  提案=${d.proposedRuling}`);
    return d;
  };
  const before = await show("之前");

  if (step === "propose") {
    const ruling = Number(process.env.RULING);
    if (![1, 2].includes(ruling)) throw new Error("RULING 只能是 1（买家胜）或 2（卖家胜）");
    if (Number(before.status) !== 1) throw new Error("现在不是等提案的状态");
    const w = new ethers.Wallet(W.proposer.privateKey, p);
    const bond = await read("读保证金", () => opt.bondOf(D.settlementToken));
    const allow = await read("读授权", () => token.allowance(w.address, D.optimisticArbitrator));
    if (allow < bond) {
      const rc = await confirm(p, await token.connect(w).approve(D.optimisticArbitrator, bond));
      console.log("  approve " + f(bond) + "  " + rc.gasUsed + " gas");
    }
    const rc = await confirm(p, await opt.connect(w).propose(id, ruling));
    console.log(`  propose ruling=${ruling}  ${rc.gasUsed} gas  ${rc.hash}`);
    await show("之后", rc.blockNumber);
  } else if (step === "challenge") {
    if (Number(before.status) !== 2) throw new Error("现在不在挑战期");
    if (fs.existsSync(OUT)) throw new Error(`${OUT} 已存在 —— 先确认是不是另一个还在跑的案子，再手工改名`);
    const w = new ethers.Wallet(W.challenger.privateKey, p);
    const bond = before.bond;
    const allow = await read("读授权", () => token.allowance(w.address, D.optimisticArbitrator));
    if (allow < bond) {
      const rc = await confirm(p, await token.connect(w).approve(D.optimisticArbitrator, bond));
      console.log("  approve " + f(bond) + "  " + rc.gasUsed + " gas");
    }
    const rc = await confirm(p, await opt.connect(w).challenge(id));
    const ev = rc.logs.map((l) => { try { return opt.interface.parseLog(l); } catch { return null; } })
      .find((x) => x && x.name === "Challenged");
    const caseID = ev.args.finalDisputeID;
    console.log(`  challenge  ${rc.gasUsed} gas  ${rc.hash}`);
    console.log(`  陪审团案件号 ${caseID}`);

    // 先写状态再做别的：后面几天的投票、揭示都靠这个文件接力
    fs.writeFileSync(OUT, JSON.stringify({
      createdAt: new Date().toISOString(),
      deal: dealAddr,
      optimisticDisputeID: id.toString(),
      juryCaseID: caseID.toString(),
      proposedRuling: Number(before.proposedRuling),
      challengeBlock: rc.blockNumber,
      jurors: ["juror1", "juror2", "juror3", "juror4", "juror5"].map((r) => W[r].address),
    }, null, 2));
    console.log("  状态已写入 " + path.basename(OUT));
    await show("之后", rc.blockNumber);
  } else {
    throw new Error("STEP 只能是 propose 或 challenge");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
