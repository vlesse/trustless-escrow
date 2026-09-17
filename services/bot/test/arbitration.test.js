import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";

process.env.TELEGRAM_BOT_TOKEN ??= "test:token";
process.env.RPC_URL ??= "http://127.0.0.1:8545";
process.env.ESCROW_FACTORY ??= "0x0000000000000000000000000000000000000001";
process.env.CHAIN_ID ??= "42161";

const arb = await import("../src/arbitration.js");

const U = (n) => BigInt(Math.round(n * 1e6));
const INFO = { address: "0x0", decimals: 6, symbol: "mUSD" };

// ============================================================ 案值

describe("案值口径必须与合约一致", () => {
  test("案值 = 货款 + 双方押金", () => {
    assert.equal(arb.dealValue({ price: U(1000), buyerBond: U(300), sellerBond: U(400) }), U(1700));
  });
});

// ============================================================ 硬闸

describe("单笔上限是硬闸，必须在签名之前拦住", () => {
  test("没设上限就不拦", () => {
    assert.equal(arb.capVerdict({ value: U(999999), cap: 0n }).ok, true);
    assert.equal(arb.capVerdict({ value: U(999999), cap: null }).ok, true);
  });

  test("正好卡在线上是允许的", () => {
    assert.equal(arb.capVerdict({ value: U(3000), cap: U(3000) }).ok, true);
  });

  test("超一点点也要拦 —— 拦不住的话用户会在自己钱包里撞 revert", () => {
    const v = arb.capVerdict({ value: U(3000) + 1n, cap: U(3000) });
    assert.equal(v.ok, false);
    assert.equal(v.over, 1n);
  });

  test("拒绝的话要说清楚：为什么、上限多少、怎么办", () => {
    const text = arb.renderCapRejection({ value: U(5000), cap: U(3000), info: INFO }).join("\n");
    assert.ok(text.includes("3000"), "要写出上限具体是多少");
    assert.ok(text.includes("5000"), "要写出这单是多少");
    assert.ok(text.includes("你的钱一分都没动") || text.includes("钱一分都没动"), "要安抚：钱没动");
    assert.ok(text.includes("调小"), "要给出可操作的出路，而不只是拒绝");
  });
});

// ============================================================ 软提示

describe("承载力提示：不知道就别报警", () => {
  test("读不到承载力时不出警告 —— 没有依据的警告只会训练用户忽略所有警告", () => {
    assert.equal(arb.coverageVerdict({ value: U(9999), coverage: null }), null);
    assert.equal(arb.coverageVerdict({ value: U(9999), coverage: undefined }), null);
    assert.equal(arb.coverageVerdict({ value: U(9999), coverage: 0n }), null);
  });

  test("案值没超过承载力就不警告", () => {
    assert.equal(arb.coverageVerdict({ value: U(200), coverage: U(200) }).level, "ok");
  });

  test("案值超过承载力才警告", () => {
    assert.equal(arb.coverageVerdict({ value: U(201), coverage: U(200) }).level, "thin");
  });

  test("警告里必须同时给出两个数，否则用户无从判断严重程度", () => {
    const text = arb
      .renderArbitrationNotes({ value: U(3000), cap: 0n, coverage: U(200), info: INFO })
      .join("\n");
    assert.ok(text.includes("200"), "买通成本");
    assert.ok(text.includes("3000"), "案值");
  });

  test("不能只吓唬人：要说明 commit-reveal 让贿赂无法强制执行", () => {
    // 只报数字不给限定条件，是在夸大风险；夸大的警告和没有警告一样没用。
    const text = arb
      .renderArbitrationNotes({ value: U(3000), cap: 0n, coverage: U(200), info: INFO })
      .join("\n");
    assert.ok(text.includes("无法强制执行") || text.includes("收了钱照样"), "要给出限定条件");
    assert.ok(text.includes("拆小") || text.includes("保证金不低于货款"), "要给出出路");
  });

  test("承载力够用时，只报案值，不啰嗦", () => {
    const lines = arb.renderArbitrationNotes({ value: U(100), cap: 0n, coverage: U(200), info: INFO });
    assert.equal(lines.length, 1);
    assert.ok(lines[0].includes("案值"));
  });
});

// ============================================================ 排版

/// 与 bot.test.js 同一份校验。金额里天然含有 `.`，漏一个转义
/// Telegram 会拒收整条消息 —— 用户什么都收不到。
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

describe("排版", () => {
  const cases = [
    ["承载力充足", { value: U(100.5), cap: 0n, coverage: U(200), info: INFO }],
    ["承载力不足", { value: U(3000.25), cap: U(5000), coverage: U(200), info: INFO }],
    ["承载力未知", { value: U(3000), cap: 0n, coverage: null, info: INFO }],
  ];
  for (const [name, args] of cases) {
    test(`「${name}」渲染出的是合法 MarkdownV2`, () => {
      assertValidMarkdownV2(arb.renderArbitrationNotes(args).join("\n"), name);
    });
  }

  test("超限拒绝的消息也必须是合法 MarkdownV2", () => {
    assertValidMarkdownV2(
      arb.renderCapRejection({ value: U(5000.75), cap: U(3000.5), info: INFO }).join("\n"),
      "超限"
    );
  });
});

// ============================================================ ABI 一致性

describe("只读 ABI 与编译产物一致", () => {
  const dir = path.resolve(process.cwd(), "../../artifacts/contracts");
  const PAIRS = [
    ["EscrowFactory", "EscrowFactory.sol/EscrowFactory.json"],
    ["OptimisticArbitrator", "arbitration/OptimisticArbitrator.sol/OptimisticArbitrator.json"],
    ["StakedJury", "arbitration/StakedJury.sol/StakedJury.json"],
  ];

  for (const [name, rel] of PAIRS) {
    const p = path.join(dir, rel);
    test(`${name} 上确实存在这些只读方法`, { skip: !fs.existsSync(p) }, () => {
      const real = new Set();
      new ethers.Interface(JSON.parse(fs.readFileSync(p, "utf8")).abi)
        .forEachFunction((f) => real.add(f.selector));
      for (const sig of arb.READ_ABIS[name]) {
        const f = ethers.FunctionFragment.from(sig);
        assert.ok(real.has(f.selector), `${name} 上不存在 ${f.format("sighash")}`);
      }
    });
  }
});
