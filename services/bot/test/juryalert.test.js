import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";

process.env.TELEGRAM_BOT_TOKEN ??= "test:token";
process.env.RPC_URL ??= "http://127.0.0.1:8545";
process.env.ESCROW_FACTORY ??= "0x0000000000000000000000000000000000000001";
process.env.CHAIN_ID ??= "42161";

const ja = await import("../src/juryalert.js");

const U = (n) => BigInt(Math.round(n * 1e6));
const INFO = { address: "0x0", decimals: 6, symbol: "mUSD" };
const A = "0xaaaAAaAaAAaaaAaAaAAAaaAAAaAaAaAAAAAaAAaa";
const B = "0xBbBbBBBbbBBBbbBBbbbBBbBBbBbbBbBbBBbBbBBB";
const C = "0xcccCCccCCCcCCCCcCCCcCcCccCcCCCCcccccccCC";

const base = {
  value: U(1000),
  coverage: U(5000),
  drawn: [A, B, C],
  stakeByJuror: { [A]: U(1000), [B]: U(1000), [C]: U(1000) },
  totalStake: U(100000),
  freshStakers: new Set(),
};

describe("抽选风险的判断口径", () => {
  test("一切正常时不报 —— 乱报的告警会训练所有人忽略告警", () => {
    const r = ja.assessDraw(base);
    assert.equal(r.level, "ok");
    assert.equal(r.flags.length, 0);
  });

  test("案值超过买通成本是红色 —— 这不是「可能」，是算出来就划算", () => {
    const r = ja.assessDraw({ ...base, value: U(6000) });
    assert.equal(r.level, "danger");
    assert.ok(r.flags.some((f) => f.key === "value_over_coverage"));
  });

  test("正好等于承载力不报 —— 边界上还没有翻过去", () => {
    assert.equal(ja.assessDraw({ ...base, value: U(5000) }).level, "ok");
  });

  test("一个人占了过半席位是红色：买一个就够了，不需要买一群", () => {
    // 放回抽样，质押多的人本来就可能连中。机制没坏，但这一次的抽选结果
    // 让「分散给一群人」这条前提名存实亡。
    const r = ja.assessDraw({ ...base, drawn: [A, A, B] });
    assert.equal(r.level, "danger");
    const f = r.flags.find((x) => x.key === "single_juror_majority");
    assert.ok(f && f.text.includes("2/3"));
  });

  test("刚好一半席位不算过半（偶数席位时）", () => {
    const r = ja.assessDraw({ ...base, drawn: [A, A, B, B] });
    assert.ok(!r.flags.some((x) => x.key === "single_juror_majority"));
  });

  test("抽中的人握着全池大头是黄色", () => {
    const r = ja.assessDraw({
      ...base,
      stakeByJuror: { [A]: U(30000), [B]: U(20000), [C]: U(1000) },
      totalStake: U(100000),
    });
    assert.equal(r.level, "warn");
    const f = r.flags.find((x) => x.key === "concentration");
    assert.ok(f && f.text.includes("51.0%"));
  });

  test("有人是最近才押进来的 —— 为某个案子而来最典型的形状", () => {
    const r = ja.assessDraw({ ...base, freshStakers: new Set([B]) });
    assert.ok(r.flags.some((x) => x.key === "fresh_stake"));
  });

  test("拿不到质押数据时不误报集中度", () => {
    const r = ja.assessDraw({ ...base, stakeByJuror: {}, totalStake: 0n });
    assert.ok(!r.flags.some((x) => x.key === "concentration"));
  });

  test("承载力读不到时不报案值那一条", () => {
    const r = ja.assessDraw({ ...base, value: U(999999), coverage: 0n });
    assert.ok(!r.flags.some((x) => x.key === "value_over_coverage"));
  });
});

// ============================================================ 广播措辞

function assertValidMarkdownV2(text, label) {
  let inCode = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") { i++; continue; }
    if (c === "`") { inCode = !inCode; continue; }
    if (inCode || c === "*") continue;
    if ("_[]()~>#+-=|{}.!".includes(c)) {
      assert.fail(`${label}: 第 ${i} 位的 "${c}" 未转义\n  …${text.slice(Math.max(0, i - 40), i + 40)}…`);
    }
  }
  assert.equal(inCode, false, `${label}: 代码块未闭合`);
}

describe("广播措辞", () => {
  const mk = (over = {}) =>
    ja.renderAlert({
      id: 7, round: 0, info: INFO, value: U(6000.5), coverage: U(5000.25),
      assessment: ja.assessDraw({ ...base, value: U(6000), ...over }),
    });

  test("正常抽选不广播 —— 没事也发，等于把告警变成背景噪音", () => {
    assert.equal(
      ja.renderAlert({ id: 1, round: 0, assessment: ja.assessDraw(base), value: 0n, coverage: 0n }),
      null
    );
  });

  test("必须同时给出案值和买通成本，否则读的人无从判断严重程度", () => {
    const t = mk();
    assert.ok(t.includes("6000"));
    assert.ok(t.includes("5000"));
  });

  test("不能下结论 —— 说「已被操纵」会制造恐慌并让告警失去可信度", () => {
    const t = mk();
    assert.ok(t.includes("形状，不是证据"), "要讲清楚这是形状不是结论");
    assert.ok(!t.includes("已被操纵") && !t.includes("确认"), "不该出现断言性措辞");
  });

  test("必须写出可操作的下一步：谁都可以上诉", () => {
    // 这条告警的全部意义就是叫醒一个愿意上诉的人。
    // 不写这句，读到的人不知道自己能做什么，广播就白发了。
    const t = mk();
    assert.ok(t.includes("上诉"));
    assert.ok(t.includes("48 小时") || t.includes("窗口"));
  });

  test("红黄两种都要是合法 MarkdownV2", () => {
    assertValidMarkdownV2(mk(), "红");
    const warn = ja.renderAlert({
      id: 9, round: 1, info: INFO, value: U(100.5), coverage: U(5000.25),
      assessment: ja.assessDraw({ ...base, freshStakers: new Set([B]) }),
    });
    assertValidMarkdownV2(warn, "黄");
  });
});

// ============================================================ ABI 一致性

describe("ABI 与合约一致", () => {
  const p = path.resolve(
    process.cwd(), "../../artifacts/contracts/arbitration/StakedJury.sol/StakedJury.json"
  );
  test("事件与只读方法都真的存在", { skip: !fs.existsSync(p) }, () => {
    const real = new ethers.Interface(JSON.parse(fs.readFileSync(p, "utf8")).abi);
    const topics = new Set();
    real.forEachEvent((e) => topics.add(e.topicHash));
    const selectors = new Set();
    real.forEachFunction((f) => selectors.add(f.selector));

    for (const sig of ja.JURY_ALERT_ABI) {
      if (sig.startsWith("event ")) {
        const f = ethers.EventFragment.from(sig);
        assert.ok(topics.has(f.topicHash), `陪审团上不存在事件 ${f.format("sighash")}`);
      } else {
        const f = ethers.FunctionFragment.from(sig);
        assert.ok(selectors.has(f.selector), `陪审团上不存在 ${f.format("sighash")}`);
      }
    }
  });
});
