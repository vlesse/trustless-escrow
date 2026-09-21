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
// 配上签名页：线上就是配着的，不配走的是「没有按钮」那条兜底分支，
// 测出来的东西和用户实际看到的不是同一个。
process.env.SIGNING_PAGE_URL ??= "https://example.test";

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

/**
 * 仲裁层那一段。
 *
 * 原来写的是「请自行核对」，而用户没有任何参照物。真实反应是
 * 「我从哪里去核对？这是个什么玩意？」——让人核对却不给参照物等于没说，
 * 而这种话说多了，用户学会的是「看不懂就跳过」，恰好是钓鱼最需要的习惯。
 */
describe("仲裁层提示", () => {
  const BASE = {
    address: A, buyer: A, seller: A, token: A,
    arbitrator: "0x001871B4163D5e9f2CB728717f7bB60135650236",
    price: U("100.5"), buyerBond: U("100.5"), sellerBond: U("100.5"),
    buyerFunded: false, sellerFunded: false, state: 1, feeBps: 100,
    deliveryDeadline: 1800000000, inspectionDeadline: 1800003600,
  };
  const render = (factoryArbitrator) =>
    cmds.renderDealHeader({ deal: BASE, info: INFO, role: "buyer", factoryArbitrator }).join("\n");

  test("说清楚它是干什么的，而不是只丢一个地址", () => {
    assert.match(render(null), /裁决/, "得说明它在争议时决定钱归谁");
    assert.doesNotMatch(render(null), /自行核对/, "别再让用户去核对一个他没有参照物的东西");
  });

  test("和工厂默认一致时直接给结论", () => {
    assert.match(render(BASE.arbitrator), /一致/);
    assert.doesNotMatch(render(BASE.arbitrator), /不一致/);
  });

  test("不一致时提示，但不武断说成有鬼", () => {
    const md = render("0x0000000000000000000000000000000000000009");
    assert.match(md, /不一致/);
    assert.match(md, /不必然有问题/, "换过仲裁层也会不一致，不该吓唬用户");
  });

  test("结论之外还要给能自己验的手段", () => {
    const md = render(BASE.arbitrator);
    assert.match(md, /区块浏览器/, "结论是机器人给的，验证手段不能只在机器人手里");
  });

  test("读不到工厂默认时不给结论，只给链接", () => {
    const md = render(null);
    assert.doesNotMatch(md, /一致/, "读不到就别猜——少一条结论好过给一条错结论");
    assert.match(md, /区块浏览器/);
  });

  test("这一段本身没有漏转义", () => {
    for (const fa of [null, BASE.arbitrator, "0x0000000000000000000000000000000000000009"]) {
      const bad = unescapedReserved(render(fa));
      assert.deepEqual(bad, [], bad.map((b) => `「${b.ch}」在 …${b.near}…`).join("；"));
    }
  });
});

const txlink = await import("../src/txlink.js");

/**
 * 待签交易的消息。
 *
 * 实测用户连着问了两次「在哪里授权」。原因不是按钮没有，是消息把 calldata
 * 摆在最显眼处，却没有一句话说该点按钮 —— calldata 是给「机器人没了还要
 * 自己动手」准备的兜底路径，对第一次用的人毫无意义。
 */
describe("待签交易消息", () => {
  const txs = txlink.buildDepositFlow({
    token: A, escrow: "0x70D66C478F8c73f7eD6F67bB0b0357Fe917a635D",
    amount: U("200.5"), role: "buyer",
  });

  test("先说这步在干什么，再叫人点按钮", () => {
    const { text } = cmds.renderTx(txs[0], 1, 2);
    assert.match(text, /不转账/, "授权最容易被误解成「已经付过一次钱」");
    assert.match(text, /点下面的按钮/, "没有这句话，用户不知道该点哪里");
    const posNote = text.indexOf("不转账");
    const posData = text.indexOf("calldata");
    assert.ok(posNote < posData, "解释必须排在 calldata 前面");
  });

  test("入金那步说清楚钱真的锁进去了", () => {
    const { text } = cmds.renderTx(txs[1], 2, 2);
    assert.match(text, /真正把钱锁进/);
    assert.match(text, /无法挪用/);
  });

  test("calldata 仍然保留 —— 它是机器人挂掉之后的唯一出路", () => {
    for (const tx of txs) {
      const { text } = cmds.renderTx(tx, 1, 2);
      assert.match(text, new RegExp(tx.data.slice(2, 12)), "calldata 不能省");
    }
  });

  test("按钮跟着消息一起发出去", () => {
    const { extra } = cmds.renderTx(txs[0], 1, 2);
    const btns = JSON.stringify(extra);
    assert.match(btns, /签名/, "没有按钮的话，那句「点下面的按钮」就成了假话");
  });

  test("没有漏转义", () => {
    for (const tx of txs) {
      const bad = unescapedReserved(cmds.renderTx(tx, 1, 2).text);
      assert.deepEqual(bad, [], bad.map((b) => `「${b.ch}」在 …${b.near}…`).join("；"));
    }
  });
});
