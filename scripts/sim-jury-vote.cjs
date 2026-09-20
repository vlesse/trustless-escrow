/**
 * 陪审员投票。这一步只有陪审员自己能做 —— keeper 做的是无需许可的推进，
 * 投票不是。
 *
 *   npx hardhat run scripts/sim-jury-vote.cjs --network bscTestnet          # 提交承诺
 *   PHASE=reveal npx hardhat run scripts/sim-jury-vote.cjs --network bscTestnet   # 揭示
 *
 * 承诺是 keccak256(ruling, salt, juror)。**salt 丢了就永远揭示不了**，
 * 那一席会被当作弃权并罚没质押。所以这里第一件事就是把 salt 落盘，
 * 而且是在发交易之前落 —— 先发后存的话，交易成功而进程崩掉就等于钱没了。
 *
 * 本场景里三个陪审员都投 2（判卖家胜），而 AI 提案是 1（退款买家）。
 * 故意让它们相反：这样才会走到「挑战者赢、提案人保证金被罚没」那条路径，
 * 也就是整个乐观层敢于让 AI 当默认裁决者的全部依据所在。
 */
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { read, confirm } = require("./lib/rpc.cjs");

const ROOT = path.join(__dirname, "..");
const D = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments-bscTestnet.json"), "utf8"));
const W = JSON.parse(fs.readFileSync(path.join(ROOT, ".testnet-wallets.json"), "utf8"));
const STATE = path.join(ROOT, ".sim-dispute.json");
const SALTS = path.join(ROOT, ".sim-jury-salts.json");

const JUROR_RULING = 2;   // 2 = 判卖家胜；AI 提的是 1
const PHASE_NAME = ["None", "Pending", "Commit", "Reveal", "Appealable", "Executed"];

const commitment = (ruling, salt, juror) =>
  ethers.solidityPackedKeccak256(["uint8", "bytes32", "address"], [ruling, salt, juror]);

async function main() {
  const provider = ethers.provider;
  const st = JSON.parse(fs.readFileSync(STATE, "utf8"));
  const caseID = BigInt(st.juryCaseID);
  const jury = await ethers.getContractAt("StakedJury", D.stakedJury);

  const byAddr = Object.fromEntries(Object.entries(W).map(([r, w]) => [w.address.toLowerCase(), r]));
  const c = await read("读案件", () => jury.cases(caseID));
  const phase = Number(c.phase);
  console.log("案件 " + caseID + "  阶段 " + PHASE_NAME[phase] + "(" + phase + ")");

  const n = Number(await read("读席位数", () => jury.voteCount(caseID)));
  const slots = [];
  for (let i = 0; i < n; i++) slots.push(await read("读席位", () => jury.votes(caseID, i)));

  const want = process.env.PHASE === "reveal" ? 3 : 2;   // Reveal : Commit
  if (phase !== want) {
    console.log("\n当前阶段不对。" + (want === 2
      ? "还没抽签，或者已经过了投票期。"
      : "揭示期还没开始 —— 要等 keeper 调 startReveal（投票期满 3 天之后）。"));
    console.log("投票截止 " + new Date(Number(c.commitDeadline) * 1000).toISOString());
    console.log("揭示截止 " + (Number(c.revealDeadline)
      ? new Date(Number(c.revealDeadline) * 1000).toISOString() : "（尚未开始）"));
    process.exit(1);
  }

  const salts = fs.existsSync(SALTS) ? JSON.parse(fs.readFileSync(SALTS, "utf8")) : {};
  const step = async (label, build) => {
    const rc = await confirm(provider, await build());
    console.log("  " + label.padEnd(28) + rc.gasUsed.toString().padStart(8) + " gas");
  };

  for (let i = 0; i < n; i++) {
    const v = slots[i];
    const role = byAddr[v.juror.toLowerCase()];
    if (!role) throw new Error("席位 " + i + " 是陌生地址 " + v.juror + "，不在钱包文件里");
    const w = new ethers.Wallet(W[role].privateKey, provider);
    const key = caseID + ":" + i;

    if (want === 2) {
      if (v.commitment !== ethers.ZeroHash) { console.log("  slot " + i + " " + role + " 已提交，跳过"); continue; }
      // 先存 salt 再发交易：反过来的话，交易成功而进程崩掉，
      // 这一席就永远揭示不了，质押直接被罚没。
      if (!salts[key]) {
        salts[key] = ethers.hexlify(ethers.randomBytes(32));
        fs.writeFileSync(SALTS, JSON.stringify(salts, null, 2), { mode: 0o600 });
      }
      await step("slot " + i + " " + role + " commitVote",
        () => jury.connect(w).commitVote(caseID, i, commitment(JUROR_RULING, salts[key], v.juror)));
    } else {
      if (v.revealed) { console.log("  slot " + i + " " + role + " 已揭示，跳过"); continue; }
      const salt = salts[key];
      if (!salt) throw new Error("slot " + i + " 的 salt 丢了，这一席揭示不了了");
      await step("slot " + i + " " + role + " revealVote",
        () => jury.connect(w).revealVote(caseID, i, JUROR_RULING, salt));
    }
  }

  const after = await read("重读案件", () => jury.cases(caseID));
  console.log("\n阶段 " + PHASE_NAME[Number(after.phase)]);
  if (want === 2) {
    console.log("投票截止 " + new Date(Number(after.commitDeadline) * 1000).toISOString());
    console.log("到点后 keeper 会自动调 startReveal，然后回来跑：");
    console.log("  PHASE=reveal npx hardhat run scripts/sim-jury-vote.cjs --network bscTestnet");
  } else {
    console.log("揭示截止 " + new Date(Number(after.revealDeadline) * 1000).toISOString());
    console.log("之后 keeper 会调 tallyRound，再等 2 天上诉期，最后 finalize。");
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
