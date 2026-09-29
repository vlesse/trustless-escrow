process.env.TELEGRAM_BOT_TOKEN ??= "test:token";
process.env.RPC_URL ??= "http://127.0.0.1:8545";
process.env.ESCROW_FACTORY ??= "0x0000000000000000000000000000000000000001";

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import {
  OPT_ABI, JURY_ABI, OptStatus, JuryPhase, arbitrationStage, arbitrationActions, favors,
} from "../src/disputestatus.js";

/**
 * 争议进度。提起争议到最终裁决最长一个多星期，原来这段时间机器人一句话不说。
 */

describe("手写的结构体与编译产物逐字段一致", () => {
  /*
   * 只比函数选择器是不够的：选择器只看参数，不看返回值。
   * 返回的结构体里字段顺序写错一位，读出来的「投票截止」就是别的字段 ——
   * 不报错，只是推送里的时间是错的。所以这里逐个字段比名字和类型。
   */
  const dir = path.resolve(process.cwd(), "../../artifacts/contracts/arbitration");
  const PAIRS = [
    ["OptimisticArbitrator", OPT_ABI],
    ["StakedJury", JURY_ABI],
  ];
  for (const [name, abi] of PAIRS) {
    const p = path.join(dir, `${name}.sol/${name}.json`);
    test(name, () => {
      assert.ok(fs.existsSync(p), `缺编译产物 ${p}，先 npx hardhat compile`);
      const real = new ethers.Interface(JSON.parse(fs.readFileSync(p, "utf8")).abi);
      const shape = (params) => params.map((o) => o.baseType === "tuple"
        ? `tuple(${o.components.map((c) => `${c.type} ${c.name}`).join(", ")})`
        : o.type);
      for (const sig of abi) {
        const mine = ethers.FunctionFragment.from(sig);
        const theirs = real.getFunction(mine.selector);
        assert.ok(theirs, `${name} 上不存在 ${mine.format("sighash")}`);
        assert.deepEqual(shape(mine.outputs), shape(theirs.outputs), `${name}.${mine.name} 的返回值对不上`);
      }
    });
  }
});

describe("现在处在哪个阶段", () => {
  const base = { status: OptStatus.Proposed, proposedAt: 1000, challengeDeadline: 1000 + 48 * 3600, proposedRuling: 1 };

  test("刚受理不单独通知（「你已提起争议」已经说过了）；执行完交给交易合约的事件", () => {
    assert.equal(arbitrationStage({ status: OptStatus.Open }), null);
    assert.equal(arbitrationStage({ status: OptStatus.Executed }), null);
    assert.equal(arbitrationStage({ status: OptStatus.Escalated, phase: JuryPhase.Executed }), null);
    assert.equal(arbitrationStage(null), null);
  });

  test("每个阶段一个独立的 key；上诉开新一轮时 key 也要变", () => {
    const keys = [
      arbitrationStage(base),
      arbitrationStage({ status: OptStatus.Escalated }),
      arbitrationStage({ status: OptStatus.Escalated, phase: JuryPhase.Pending }),
      arbitrationStage({ status: OptStatus.Escalated, phase: JuryPhase.Commit, commitDeadline: 5 }),
      arbitrationStage({ status: OptStatus.Escalated, phase: JuryPhase.Reveal, revealDeadline: 6 }),
      arbitrationStage({ status: OptStatus.Escalated, phase: JuryPhase.Appealable, appealDeadline: 7 }),
      // 上诉之后第二轮投票：截止时间不同，必须能再通知一次
      arbitrationStage({ status: OptStatus.Escalated, phase: JuryPhase.Commit, commitDeadline: 99 }),
    ].map((s) => s.key);
    assert.equal(keys[1], keys[2], "还没开案和等抽选对用户是同一件事");
    assert.equal(new Set(keys).size, keys.length - 1);
  });
});

describe("挑战、上诉按钮只给结果对他不利的一方", () => {
  const proposed = { status: OptStatus.Proposed, proposedRuling: 1, challengeDeadline: 2000 };

  test("AI 判买家胜：卖家有挑战按钮，买家没有", () => {
    assert.deepEqual(arbitrationActions(proposed, "seller", 1000).map((a) => a.id), ["challenge"]);
    assert.deepEqual(arbitrationActions(proposed, "buyer", 1000), [], "赢的一方点挑战等于花钱反对自己");
  });

  test("挑战期过了按钮就没了", () => {
    assert.deepEqual(arbitrationActions(proposed, "seller", 2001), []);
  });

  test("陪审团结果出来：输的一方有上诉按钮；上诉不了（费用 0 = 已到最后一轮）就不给", () => {
    const app = { status: OptStatus.Escalated, phase: JuryPhase.Appealable, juryRuling: 2, appealDeadline: 2000, appealTotal: 5n };
    assert.deepEqual(arbitrationActions(app, "buyer", 1000).map((a) => a.id), ["appeal"]);
    assert.deepEqual(arbitrationActions(app, "seller", 1000), []);
    assert.deepEqual(arbitrationActions({ ...app, appealTotal: 0n }, "buyer", 1000), []);
  });

  test("不判输赢（0）时双方都算「不利」", () => {
    assert.equal(favors(0), null);
    const p0 = { ...proposed, proposedRuling: 0 };
    assert.equal(arbitrationActions(p0, "buyer", 1000).length, 1);
    assert.equal(arbitrationActions(p0, "seller", 1000).length, 1);
  });
});

describe("/deal 里的争议进度", async () => {
  const { arbitrationProgress } = await import("../src/disputestatus.js");
  const fmt = (s) => `T${s}`;

  /*
   * 真实用户在投票阶段去找「上诉」按钮，找不到。按钮确实不该有 ——
   * 要到出结果之后、而且结果对他不利才出现。但没有任何地方告诉他这件事。
   */
  test("投票阶段要说清：现在在投票、截止什么时候、上诉按钮什么时候出现", () => {
    const p = arbitrationProgress({ status: OptStatus.Escalated, phase: JuryPhase.Commit, commitDeadline: 9 }, "buyer", fmt);
    assert.match(p.now, /投票中/);
    assert.match(p.now, /T9/);
    const next = p.next.join("\n");
    assert.match(next, /公开选票/);
    assert.match(next, /上诉期/);
    assert.match(next, /不利.*「不同意，提起上诉」按钮/);
  });

  test("结果出来后，对谁有利说清楚；按钮文字和真实按钮一致", () => {
    const snap = { status: OptStatus.Escalated, phase: JuryPhase.Appealable, juryRuling: 2, appealDeadline: 7 };
    const lose = arbitrationProgress(snap, "buyer", fmt);
    const win = arbitrationProgress(snap, "seller", fmt);
    assert.match(lose.now, /对你不利/);
    assert.match(win.now, /对你有利/);
    const btn = arbitrationActions({ ...snap, appealTotal: 1n }, "buyer", 0)[0].label;
    assert.ok(lose.next.some((s) => s.includes(`「${btn}」`)), "说的按钮名字必须和真实按钮一模一样");
    assert.ok(!win.next.some((s) => s.includes(btn)), "赢的一方不该被提示去上诉");
  });

  test("AI 裁决阶段：输的一方被指到挑战按钮，名字对得上", () => {
    const snap = { status: OptStatus.Proposed, proposedRuling: 1, challengeDeadline: 5 };
    const btn = arbitrationActions(snap, "seller", 0)[0].label;
    assert.ok(arbitrationProgress(snap, "seller", fmt).next.some((s) => s.includes(`「${btn}」`)));
  });

  test("第三方（不是买卖双方）看不到「对你有利/不利」", () => {
    const p = arbitrationProgress({ status: OptStatus.Proposed, proposedRuling: 1, challengeDeadline: 5 }, null, fmt);
    assert.doesNotMatch(p.now, /对你/);
  });

  test("每个阶段都有「现在」和「接下来」，读不到快照时返回 null", () => {
    for (const s of [
      { status: OptStatus.Open },
      { status: OptStatus.Proposed, proposedRuling: 1, challengeDeadline: 1 },
      { status: OptStatus.Escalated },
      { status: OptStatus.Escalated, phase: JuryPhase.Commit, commitDeadline: 1 },
      { status: OptStatus.Escalated, phase: JuryPhase.Reveal, revealDeadline: 1 },
      { status: OptStatus.Escalated, phase: JuryPhase.Appealable, juryRuling: 1, appealDeadline: 1 },
    ]) {
      const p = arbitrationProgress(s, "buyer", fmt);
      assert.ok(p.now && p.next.length > 0, JSON.stringify(s));
    }
    assert.equal(arbitrationProgress(null, "buyer", fmt), null);
  });
});
