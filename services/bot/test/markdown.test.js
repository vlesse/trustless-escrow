import { test, describe } from "node:test";
import assert from "node:assert/strict";

/**
 * MarkdownV2 转义。
 *
 * 这是这个机器人最容易犯、后果又最不成比例的错：漏转义一个 `.`，
 * Telegram **整条拒收**，用户只看到一句「出错了，请稍后重试」，
 * 真正的内容一个字都收不到。一个排版问题吃掉了全部信息。
 *
 * 实测 /deal 就因为「手续费: 1.00%」里那个小数点整条发不出去。
 * 靠人眼审是审不出来的 —— 它本来就是这么进来的。
 */
process.env.TELEGRAM_BOT_TOKEN ??= "test:token";
process.env.RPC_URL ??= "http://127.0.0.1:8545";
process.env.ESCROW_FACTORY ??= "0x0000000000000000000000000000000000000001";

const { esc, unesc } = await import("../src/telegram.js");

/**
 * 扫一段 MarkdownV2，找出**正文里**没转义的保留字符。
 *
 * 只看正文：代码块、行内代码、链接的 URL 部分里 Telegram 不做实体解析，
 * 那些地方不转义是对的。把它们一并报出来会让这条检查天天误报，
 * 而天天误报的检查等于没有检查。
 */
export function unescapedReserved(md) {
  const RESERVED = new Set("_*[]()~`>#+-=|{}.!".split(""));
  const bad = [];
  let i = 0;
  while (i < md.length) {
    // ``` 代码块
    if (md.startsWith("```", i)) {
      const end = md.indexOf("```", i + 3);
      i = end === -1 ? md.length : end + 3;
      continue;
    }
    // ` 行内代码
    if (md[i] === "`") {
      const end = md.indexOf("`", i + 1);
      i = end === -1 ? md.length : end + 1;
      continue;
    }
    // [文字](URL) —— URL 部分不解析
    if (md[i] === "[") {
      const close = md.indexOf("](", i);
      if (close !== -1) {
        const end = md.indexOf(")", close + 2);
        if (end !== -1) {
          bad.push(...unescapedReserved(md.slice(i + 1, close)));
          i = end + 1;
          continue;
        }
      }
    }
    if (md[i] === "\\") { i += 2; continue; }          // 已转义
    if (md[i] === "*" || md[i] === "_") { i += 1; continue; }  // 粗体/斜体标记
    if (RESERVED.has(md[i])) bad.push({ ch: md[i], at: i, near: md.slice(Math.max(0, i - 18), i + 6) });
    i += 1;
  }
  return bad;
}

describe("MarkdownV2 转义", () => {
  test("esc 覆盖 Telegram 声明的全部保留字符", () => {
    for (const c of "_*[]()~`>#+-=|{}.!\\") {
      assert.equal(esc(c), "\\" + c, `${c} 没被转义`);
    }
  });

  test("转义后再反转义能还原 —— 降级成纯文本时要靠它", () => {
    for (const raw of ["手续费: 1.00% (含税)", "a-b_c*d", "100.0 USDT", "[x](y)", "纯中文没有特殊字符"]) {
      assert.equal(unesc(esc(raw)), raw, JSON.stringify(raw));
    }
  });

  test("检查器认得出正文里漏掉的转义", () => {
    assert.equal(unescapedReserved("手续费: 1.00%").length, 1, "小数点该被抓出来");
    assert.equal(unescapedReserved("手续费: " + esc("1.00") + "%").length, 0);
  });

  test("检查器不误报代码块、行内代码和链接 URL", () => {
    assert.deepEqual(unescapedReserved("```\n随机串: a.b-c\n```"), []);
    assert.deepEqual(unescapedReserved("`0x1234.5678`"), []);
    assert.deepEqual(unescapedReserved("[点这里](https://a.b/c?d=e-f)"), []);
  });

  test("检查器抓得住「手续费: 1.00%」这种写法", () => {
    const feeBps = 100;
    assert.ok(unescapedReserved(`手续费: ${(feeBps / 100).toFixed(2)}%`).length > 0);
    assert.deepEqual(unescapedReserved(`手续费: ${esc((feeBps / 100).toFixed(2))}%`), []);
  });
});

// ---------------------------------------------------------------------------

const ethers = (await import("ethers")).ethers;
const arb = await import("../src/arbitration.js");
const quota = await import("../src/quota.js");
const ja = await import("../src/juryalert.js");
const watcher = await import("../src/watcher.js");

const INFO = { address: "0x0", decimals: 18, symbol: "USDT" };
const U = (n) => ethers.parseUnits(String(n), 18);
const A = "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa";

/**
 * 真实渲染出来的消息里不能有漏转义。
 *
 * 前面那几条测的是工具本身；这几条测的是实际会发给用户的字符串。
 * 金额一律用带小数的值 —— 整数看不出问题，而线上的金额几乎总是带小数的。
 */
describe("真实消息的转义", () => {
  // 这些渲染函数有的返回字符串、有的返回行数组，统一成字符串再检查 ——
  // 第一版忘了 join，报出来的是 md.startsWith is not a function，
  // 一个测试自身的错误被误读成产品有 bug，白查一轮。
  const clean = (label, md) => {
    const text = Array.isArray(md) ? md.join("\n") : String(md);
    const bad = unescapedReserved(text);
    assert.deepEqual(bad, [],
      `${label} 有漏转义：` + bad.map((b) => `「${b.ch}」在 …${b.near}…`).join("；"));
  };

  test("仲裁承载力提示", () => {
    clean("renderArbitrationNotes",
      arb.renderArbitrationNotes({ value: U("300.5"), cap: U("200.25"), coverage: U("200.25"), info: INFO }).join("\n"));
  });

  test("超出上限的拒绝", () => {
    clean("renderCapRejection",
      arb.renderCapRejection({ value: U("300.5"), cap: U("100.75"), info: INFO }));
  });

  test("额度展示", () => {
    clean("renderQuota", quota.renderQuota({ balance: U("1234.56"), info: INFO, bond: U("100.5") }));
    clean("renderShort", quota.renderShort({ short: U("0.75"), info: INFO }));
  });

  test("抽选预警", () => {
    const data = {
      value: U("1000.5"), coverage: U("300.25"), drawn: [A],
      stakeByJuror: { [A]: U("100.5") }, totalStake: U("500.75"), freshStakers: new Set(),
    };
    const md = ja.renderAlert({
      id: "1", round: 0, assessment: ja.assessDraw(data),
      value: data.value, coverage: data.coverage, info: INFO,
    });
    if (md) clean("renderAlert", md);
  });

  test("链上事件推送", () => {
    const deal = {
      address: A, buyer: A, seller: A, token: A,
      price: U("100.5"), buyerBond: U("100.5"), sellerBond: U("100.5"),
      state: 2, feeBps: 100,
      deliveryDeadline: 1800000000, inspectionDeadline: 1800003600,
    };
    for (const [name, args] of [
      ["Deposited", { party: A, amount: U("200.5") }],
      ["DeliveryMarked", { seller: A, evidenceURI: "ipfs://x", inspectionDeadline: 1800003600 }],
      ["Settled", { finalState: 3, toBuyer: U("0.5"), toSeller: U("199.5"), toArbitrator: 0n, fee: U("1.005") }],
    ]) {
      const m = watcher.describeEvent(name, args, deal, INFO);
      if (m?.text) clean("describeEvent:" + name, m.text);
    }
  });
});

// ---------------------------------------------------------------------------

const cmds = await import("../src/commands.js");

/**
 * /deal 的详情头。
 *
 * 这是真正出过事的那段：漏转义一个小数点，Telegram 整条拒收，
 * 用户只看到「出错了」。前面那条测的是同样写法的复制品 —— 复制品绿着，
 * 真货照样能坏。所以这里直接渲染**线上在用的那个函数**。
 */
describe("/deal 详情头", () => {
  const DEAL = {
    address: A, buyer: A, seller: A, token: A, arbitrator: A,
    price: U("100.5"), buyerBond: U("100.5"), sellerBond: U("100.5"),
    buyerFunded: false, sellerFunded: true,
    feeBps: 100,                       // → 1.00%，正是当初漏掉的那个点
    deliveryDeadline: 1800000000, inspectionDeadline: 1800003600,
  };

  for (const [name, state] of [["Open", 1], ["Funded", 2], ["Delivered", 3], ["Resolved", 5]]) {
    test(`${name} 状态下没有漏转义`, () => {
      for (const role of ["buyer", "seller", null]) {
        const md = cmds.renderDealHeader({ deal: { ...DEAL, state }, info: INFO, role }).join("\n");
        const bad = unescapedReserved(md);
        assert.deepEqual(bad, [],
          `role=${role} 有漏转义：` + bad.map((b) => `「${b.ch}」在 …${b.near}…`).join("；"));
      }
    });
  }

  test("费率真的被渲染出来了 —— 别让检查通过只是因为那行没了", () => {
    const md = cmds.renderDealHeader({ deal: DEAL, info: INFO, role: "buyer" }).join("\n");
    assert.match(md, /手续费/);
    assert.match(md, /1\\?\.00%/);
  });
});
