/// 争议进行到哪一步了。
///
/// 提起争议之后到最终裁决之间，最长要走一个多星期：AI 初步裁决 → 有人挑战 →
/// 陪审团抽选、投票、公开、上诉期。原来这段时间里机器人一条消息都不发 ——
/// 用户提完争议就只能干等，不知道进行到哪了、对自己有利还是不利、还能做什么。
///
/// 这里**读链上状态，不读日志**：陪审团的案件挂在乐观层名下，不在交易名下，
/// 靠日志把它们串起来要跨三个合约追事件，而公共节点的日志只留几个小时。
/// 状态随时读都在。

import { ethers } from "ethers";

export const OPT_ABI = [
  "function disputes(uint256 id) view returns (tuple(address arbitrable, address token, uint8 status, uint8 proposedRuling, uint64 proposedAt, uint64 createdAt, address challenger, uint256 bond, uint256 finalCost, uint256 value, address dealBuyer, address dealSeller))",
  "function finalArbitrator() view returns (address)",
  "function finalToLocal(uint256) view returns (uint256)",
  "function CHALLENGE_WINDOW() view returns (uint64)",
];

export const JURY_ABI = [
  "function cases(uint256 id) view returns (tuple(address arbitrable, address feeToken, uint8 phase, uint8 ruling, uint64 drawBlock, uint64 commitDeadline, uint64 revealDeadline, uint64 appealDeadline, uint64 roundStartedAt, uint64 createdAt, uint64 rngRequestedAt, address rngSource, address dealBuyer, address dealSeller, uint256 value, uint256 baseCost))",
  "function nextCaseID() view returns (uint256)",
  "function appealTotal(uint256 id) view returns (uint256)",
];

const ESCROW_DISPUTE_ABI = ["function disputeID() view returns (uint256)"];

export const OptStatus = { None: 0, Open: 1, Proposed: 2, Escalated: 3, Executed: 4 };
export const JuryPhase = { None: 0, Pending: 1, Commit: 2, Reveal: 3, Appealable: 4, Executed: 5 };

/// 裁决对谁有利。1 = 买家，2 = 卖家，0 = 不判输赢。
export const favors = (ruling) => (Number(ruling) === 1 ? "buyer" : Number(ruling) === 2 ? "seller" : null);
export const rulingText = (ruling) =>
  Number(ruling) === 1 ? "买家胜" : Number(ruling) === 2 ? "卖家胜" : "不判输赢，按规则拆分";

/// 陪审团案件号 → 乐观层争议号的对应关系只存在于「陪审团 → 乐观层」一个方向。
/// 反过来找要扫一遍；找到就记住，它不会再变。
const caseCache = new Map();

async function findJuryCase(opt, jury, optAddr, optId) {
  const key = `${optAddr.toLowerCase()}:${optId}`;
  if (caseCache.has(key)) return caseCache.get(key);
  const next = Number(await jury.nextCaseID());
  for (let c = next - 1; c >= 1; c--) {
    if (Number(await opt.finalToLocal(c)) !== Number(optId)) continue;
    const kase = await jury.cases(c);
    if (kase.arbitrable.toLowerCase() !== optAddr.toLowerCase()) continue;
    caseCache.set(key, c);
    return c;
  }
  return null;
}

/// 读一笔争议中交易的仲裁快照。只在 state = Disputed 时调用。
export async function loadArbitration(deal, provider) {
  const optAddr = deal.arbitrator;
  const opt = new ethers.Contract(optAddr, OPT_ABI, provider);
  const optId = await new ethers.Contract(deal.address, ESCROW_DISPUTE_ABI, provider).disputeID();
  const [d, window] = await Promise.all([opt.disputes(optId), opt.CHALLENGE_WINDOW()]);

  const snap = {
    optAddr, optId: Number(optId),
    status: Number(d.status),
    proposedRuling: Number(d.proposedRuling),
    proposedAt: Number(d.proposedAt),
    challengeDeadline: Number(d.proposedAt) + Number(window),
    bond: d.bond, token: d.token,
  };

  if (snap.status === OptStatus.Escalated) {
    const juryAddr = await opt.finalArbitrator();
    const jury = new ethers.Contract(juryAddr, JURY_ABI, provider);
    const caseId = await findJuryCase(opt, jury, optAddr, snap.optId);
    if (caseId) {
      const c = await jury.cases(caseId);
      Object.assign(snap, {
        juryAddr, caseId,
        phase: Number(c.phase),
        juryRuling: Number(c.ruling),
        commitDeadline: Number(c.commitDeadline),
        revealDeadline: Number(c.revealDeadline),
        appealDeadline: Number(c.appealDeadline),
      });
      if (snap.phase === JuryPhase.Appealable) snap.appealTotal = await jury.appealTotal(caseId);
    }
  }
  return snap;
}

/**
 * 现在处在哪个阶段。返回的 key 用来去重：同一阶段只通知一次，
 * 进入新阶段（包括上诉后的新一轮）就是新 key。
 * 返回 null 表示这个阶段不用单独通知（比如刚受理：「你已提起争议」已经说过了）。
 */
export function arbitrationStage(snap) {
  if (!snap) return null;
  switch (snap.status) {
    case OptStatus.Proposed:
      return { key: `proposed:${snap.proposedAt}`, kind: "proposed" };
    case OptStatus.Escalated:
      if (snap.phase === undefined || snap.phase === JuryPhase.Pending) return { key: "jury-pending", kind: "jury-pending" };
      if (snap.phase === JuryPhase.Commit) return { key: `commit:${snap.commitDeadline}`, kind: "commit" };
      if (snap.phase === JuryPhase.Reveal) return { key: `reveal:${snap.revealDeadline}`, kind: "reveal" };
      if (snap.phase === JuryPhase.Appealable) return { key: `appeal:${snap.appealDeadline}`, kind: "appealable" };
      return null;   // 已执行：交易合约那边会发 Ruled / Settled
    default:
      return null;
  }
}

/// 当前这个角色能不能挑战 / 上诉。只给**结果对他不利**的那一方按钮 ——
/// 对赢的一方显示「挑战」，他点下去是在花钱反对自己。
export function arbitrationActions(snap, role, now = Math.floor(Date.now() / 1000)) {
  const out = [];
  if (!snap || !role) return out;
  if (snap.status === OptStatus.Proposed && now <= snap.challengeDeadline
      && favors(snap.proposedRuling) !== role) {
    out.push({ id: "challenge", label: "不同意，发起挑战" });
  }
  if (snap.phase === JuryPhase.Appealable && now <= snap.appealDeadline
      && favors(snap.juryRuling) !== role && snap.appealTotal > 0n) {
    out.push({ id: "appeal", label: "不同意，提起上诉" });
  }
  return out;
}

/**
 * 「争议进度」：现在在哪一步、什么时候截止、接下来还有什么。给 /deal 用。
 *
 * 原来争议期间 /deal 只显示「争议中」三个字。真实用户在投票阶段去找
 * 「上诉」按钮 —— 找不到，也没有任何地方告诉他那个按钮要到出结果之后、
 * 而且只在结果对他不利时才会出现。流程这么长，每一步都得说清「接下来是什么」。
 *
 * @param fmt  截止时间 → 文字（调用方决定格式，这里不碰时区）
 * @returns {{now: string, next: string[]} | null}  纯文本，调用方负责转义
 */
export function arbitrationProgress(snap, role, fmt) {
  if (!snap) return null;
  const mine = (ruling) => {
    if (!role) return "";
    return favors(ruling) === role ? "，对你有利" : "，对你不利";
  };
  const good = (ruling) => role && favors(ruling) === role;
  const JURY_STEPS = "陪审团投票 3 天 → 公开选票 2 天 → 出结果 → 上诉期 2 天";

  switch (snap.status) {
    case OptStatus.Open:
      return {
        now: "等 AI 给出初步裁决",
        next: ["AI 给出结果后，有 48 小时挑战期",
               "没人挑战：按 AI 的结果分钱",
               `有人挑战：交给陪审团（${JURY_STEPS}）`],
      };
    case OptStatus.Proposed:
      return {
        now: `AI 初步裁决：${rulingText(snap.proposedRuling)}${mine(snap.proposedRuling)}。挑战截止：${fmt(snap.challengeDeadline)}`,
        next: good(snap.proposedRuling)
          ? ["截止前没人挑战，就按这个结果分钱", `有人挑战的话，交给陪审团（${JURY_STEPS}）`]
          : ["不同意的话，截止前点下面的「不同意，发起挑战」", "截止前没人挑战，就按这个结果分钱"],
      };
    case OptStatus.Escalated: {
      const appealHint = role ? "结果对你不利的话，那时这里会出现「不同意，提起上诉」按钮" : null;
      if (snap.phase === undefined || snap.phase === JuryPhase.Pending) {
        return { now: "有人不同意 AI 的裁决，交给陪审团了，正在抽选陪审员", next: [JURY_STEPS] };
      }
      if (snap.phase === JuryPhase.Commit) {
        return {
          now: `陪审团投票中。投票截止：${fmt(snap.commitDeadline)}`,
          next: ["公开选票（2 天）", "出结果，进入上诉期（2 天）", appealHint,
                 "上诉期过了没人上诉，钱自动按结果分配"].filter(Boolean),
        };
      }
      if (snap.phase === JuryPhase.Reveal) {
        return {
          now: `投票结束，正在公开选票。公开截止：${fmt(snap.revealDeadline)}`,
          next: ["出结果，进入上诉期（2 天）", appealHint, "上诉期过了没人上诉，钱自动按结果分配"].filter(Boolean),
        };
      }
      if (snap.phase === JuryPhase.Appealable) {
        return {
          now: `陪审团结果：${rulingText(snap.juryRuling)}${mine(snap.juryRuling)}。上诉截止：${fmt(snap.appealDeadline)}`,
          next: good(snap.juryRuling) || !role
            ? ["截止前没人上诉，钱自动按这个结果分配"]
            : ["不同意的话，截止前点下面的「不同意，提起上诉」", "截止前没人上诉，钱自动按这个结果分配"],
        };
      }
      return null;
    }
    default:
      return null;
  }
}
