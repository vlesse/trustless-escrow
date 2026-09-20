import { test, describe } from "node:test";
import assert from "node:assert/strict";

const t = await import("../src/tasks.js");

const P = t.Phase, S = t.Status, E = t.State, O = t.Outcome;
const NOW = 1_800_000_000;
const ctx = (over = {}) => ({ now: NOW, blockNumber: 1000, ...over });

// ============================================================ 陪审团

describe("陪审团：该推哪一步", () => {
  const base = {
    id: 1, phase: P.Pending, drawBlock: 900, commitDeadline: 0, revealDeadline: 0,
    appealDeadline: 0, roundStartedAt: NOW - 100, totalStake: 1000n,
  };

  test("已过抽选区块 → 抽签", () => {
    assert.equal(t.juryTask(base, ctx()).method, "drawJurors");
  });

  test("还没到抽选区块 → 什么都不做", () => {
    assert.equal(t.juryTask({ ...base, drawBlock: 1000 }, ctx()), null);
  });

  test("池子为空时不推抽签 —— 推了也只会 revert", () => {
    assert.equal(t.juryTask({ ...base, totalStake: 0n }, ctx()), null);
  });

  test("提交/揭示/上诉三个窗口满了各推各的", () => {
    const cases = [
      [{ phase: P.Commit, commitDeadline: NOW - 1 }, "startReveal"],
      [{ phase: P.Reveal, revealDeadline: NOW - 1 }, "tallyRound"],
      [{ phase: P.Appealable, appealDeadline: NOW - 1 }, "finalize"],
    ];
    for (const [over, method] of cases) {
      assert.equal(t.juryTask({ ...base, ...over }, ctx()).method, method, method);
    }
  });

  test("窗口还没满就不推", () => {
    assert.equal(t.juryTask({ ...base, phase: P.Commit, commitDeadline: NOW + 1 }, ctx()), null);
  });

  test("终态不再推任何东西", () => {
    for (const phase of [P.None, P.Executed]) {
      assert.equal(t.juryTask({ ...base, phase }, ctx()), null);
    }
  });

  test("能走正常流程时绝不走兜底 —— 兜底会把能判输赢的案子改成平局", () => {
    // 抽签可行 + 本轮也超时了：必须选抽签。
    // 选 timeoutCase 等于主动把一个本来能判出结果的案子变成中性拆分。
    const stuck = { ...base, roundStartedAt: NOW - t.ROUND_TIMEOUT - 1 };
    assert.equal(t.juryTask(stuck, ctx()).method, "drawJurors");
  });

  test("正常流程确实走不动 + 本轮超时 → 兜底结案", () => {
    const stuck = { ...base, totalStake: 0n, roundStartedAt: NOW - t.ROUND_TIMEOUT - 1 };
    assert.equal(t.juryTask(stuck, ctx()).method, "timeoutCase");
  });

  test("走不动但还没到超时 → 继续等，不要提前兜底", () => {
    const waiting = { ...base, totalStake: 0n, roundStartedAt: NOW - 100 };
    assert.equal(t.juryTask(waiting, ctx()), null);
  });
});

// ============================================================ 乐观层

describe("乐观层：该推哪一步", () => {
  const base = { id: 1, status: S.Open, createdAt: NOW - 100, proposedAt: 0 };

  test("AI 超时未提案 → 直接升级，机器人掉线不该卡死任何交易", () => {
    const late = { ...base, createdAt: NOW - t.PROPOSAL_WINDOW - 1 };
    assert.equal(t.optimisticTask(late, ctx()).method, "escalateUnproposed");
  });

  test("提案窗口内 → 等着", () => {
    assert.equal(t.optimisticTask(base, ctx()), null);
  });

  test("挑战窗口满且无人挑战 → 默认裁决生效", () => {
    const d = { ...base, status: S.Proposed, proposedAt: NOW - t.CHALLENGE_WINDOW - 1 };
    assert.equal(t.optimisticTask(d, ctx()).method, "execute");
  });

  test("已升级到终局仲裁 → 这边没有可做的，由陪审团那边推", () => {
    assert.equal(t.optimisticTask({ ...base, status: S.Escalated }, ctx()), null);
  });
});

// ============================================================ 托管与信誉

describe("托管合约与信誉记录", () => {
  test("验收期届满且无异议 → 结算给卖家", () => {
    const d = { state: E.Delivered, inspectionDeadline: NOW - 1 };
    assert.equal(t.escrowTask(d, ctx()).method, "settleAfterInspection");
  });

  test("验收期内不推 —— 买家还有权提争议", () => {
    assert.equal(t.escrowTask({ state: E.Delivered, inspectionDeadline: NOW + 1 }, ctx()), null);
  });

  test("终局交易写进信誉记录", () => {
    const d = { address: "0xD", state: E.Resolved, outcome: O.DisputeBuyer, recorded: false };
    assert.equal(t.reputationTask(d).method, "record");
  });

  test("已经记过的不重复写", () => {
    const d = { address: "0xD", state: E.Resolved, outcome: O.DisputeBuyer, recorded: true };
    assert.equal(t.reputationTask(d), null);
  });

  test("没结束的、以及双方都没入金就散了的，合约本身就拒绝记录", () => {
    assert.equal(t.reputationTask({ state: E.Funded, outcome: O.None, recorded: false }), null);
    assert.equal(
      t.reputationTask({ state: E.Cancelled, outcome: O.CancelledUnfunded, recorded: false }),
      null
    );
  });
});

// ============================================================ 排序与放弃

describe("排序与放弃", () => {
  test("兜底和结案排在前面 —— 一轮的交易数有上限，先用在压钱最久的上面", () => {
    const list = [
      { method: "record" }, { method: "drawJurors" },
      { method: "finalize" }, { method: "timeoutCase" },
    ];
    assert.deepEqual(
      t.prioritize(list).map((x) => x.method),
      ["timeoutCase", "finalize", "drawJurors", "record"]
    );
  });

  test("失败够多次就放弃 —— 不对着永远 revert 的调用无限烧 gas", () => {
    assert.equal(t.shouldSkip({ attempts: 5 }, 5), true);
    assert.equal(t.shouldSkip({ attempts: 4 }, 5), false);
    assert.equal(t.shouldSkip(undefined, 5), false, "没记录过的不该被跳过");
  });
});
