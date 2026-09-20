/// 「该推哪一步」的全部判断逻辑，纯函数。
///
/// 拆出来是为了能在不连链的前提下测：这些条件写错不会报错，
/// 只会让 keeper 安静地什么都不做，或者对着一个永远失败的调用死磕。
/// 两种都没有运行时信号。

export const Phase = { None: 0, Pending: 1, Commit: 2, Reveal: 3, Appealable: 4, Executed: 5 };
export const Status = { None: 0, Open: 1, Proposed: 2, Escalated: 3, Executed: 4 };
export const State = { None: 0, Open: 1, Funded: 2, Delivered: 3, Disputed: 4, Resolved: 5, Cancelled: 6 };
export const Outcome = {
  None: 0, CancelledUnfunded: 1, NonDelivery: 2, Completed: 3,
  DisputeBuyer: 4, DisputeSeller: 5, DisputeSplit: 6, DisputeStale: 7,
};

/// 合约里的窗口常量。keeper 只读不改，写死在这里的风险是合约改了这边没跟上，
/// 所以 test/abi.test.js 会拿编译产物逐个核对。
export const ROUND_TIMEOUT = 10 * 24 * 3600;
export const PROPOSAL_WINDOW = 72 * 3600;
export const CHALLENGE_WINDOW = 48 * 3600;

/// 陪审团案件当下该推的那一步。没有就返回 null。
///
/// 顺序很重要：能走正常流程就绝不走兜底。`timeoutCase` 会让案件以拒裁结束，
/// 那是把一个本来能判出输赢的案子改成中性拆分 —— 只在正常路径确实走不动时才用。
export function juryTask(c, { now, blockNumber }) {
  if (c.phase === Phase.None || c.phase === Phase.Executed) return null;

  if (c.phase === Phase.Pending && blockNumber > c.drawBlock && c.totalStake > 0n) {
    return { method: "drawJurors", args: [c.id], why: "已过抽选区块" };
  }
  if (c.phase === Phase.Commit && now > c.commitDeadline) {
    return { method: "startReveal", args: [c.id], why: "提交窗口已满" };
  }
  if (c.phase === Phase.Reveal && now > c.revealDeadline) {
    return { method: "tallyRound", args: [c.id], why: "揭示窗口已满" };
  }
  if (c.phase === Phase.Appealable && now > c.appealDeadline) {
    return { method: "finalize", args: [c.id], why: "上诉窗口已满，无人上诉" };
  }
  // 正常路径都走不动，且这一轮已经卡了太久 —— 兜底，让资金不至于一直压着
  if (now >= c.roundStartedAt + ROUND_TIMEOUT) {
    return { method: "timeoutCase", args: [c.id], why: "本轮超时，兜底结案" };
  }
  return null;
}

/// 乐观层争议当下该推的那一步。
export function optimisticTask(d, { now }) {
  if (d.status === Status.None || d.status === Status.Executed) return null;

  if (d.status === Status.Open && now > d.createdAt + PROPOSAL_WINDOW) {
    return { method: "escalateUnproposed", args: [d.id], why: "AI 超时未提案，直接升级" };
  }
  if (d.status === Status.Proposed && now > d.proposedAt + CHALLENGE_WINDOW) {
    return { method: "execute", args: [d.id], why: "挑战窗口已满，默认裁决生效" };
  }
  // Escalated 阶段在等终局仲裁方，那边由 juryTask 推，这里没有可做的
  return null;
}

/// 托管合约当下该推的那一步。
export function escrowTask(deal, { now }) {
  if (deal.state === State.Delivered && now >= deal.inspectionDeadline) {
    return { method: "settleAfterInspection", args: [], why: "验收期届满且无异议" };
  }
  return null;
}

/// 这笔交易该不该写进信誉记录。
///
/// 记录是无需许可的，但同样没人会主动去写。不写的后果很具体：
/// 骗子的败诉记录不会出现在任何地方，而他下一个受害者正指望着那条记录。
export function reputationTask(deal) {
  const terminal = deal.state === State.Resolved || deal.state === State.Cancelled;
  if (!terminal) return null;
  if (deal.recorded) return null;
  // 这两种合约本身就拒绝记录：没结束的、以及双方都没入金就散了的
  if (deal.outcome === Outcome.None || deal.outcome === Outcome.CancelledUnfunded) return null;
  return { method: "record", args: [deal.address], why: "交易已终局，沉淀公开记录" };
}

/// 失败过太多次的目标要放弃。
///
/// 对着一个永远会 revert 的调用无限重试，只会把 gas 烧光并且淹没日志。
/// 但**被别人抢先推掉不算失败** —— 那正是无需许可的意义所在，
/// 调用方要能分清这两件事，见 index.js 里对 revert 的处理。
export function shouldSkip(record, maxAttempts) {
  return Boolean(record) && record.attempts >= maxAttempts;
}

/// 把待办排成执行顺序：先兜底类（资金压着最久的），再常规。
/// 一轮里能发的交易数有上限，排序决定了上限用在哪儿。
export function prioritize(tasks) {
  const weight = (t) =>
    t.method === "timeoutCase" ? 0
      : t.method === "finalize" || t.method === "execute" ? 1
        : t.method === "record" ? 3
          : 2;
  return [...tasks].sort((a, b) => weight(a) - weight(b));
}
