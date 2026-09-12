import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";

process.env.TELEGRAM_BOT_TOKEN ??= "test:token";
process.env.RPC_URL ??= "http://127.0.0.1:8545";
process.env.ESCROW_FACTORY ??= "0x0000000000000000000000000000000000000001";
process.env.CHAIN_ID ??= "42161";
process.env.REPUTATION ??= "0x0000000000000000000000000000000000000002";
process.env.IDENTITY_BOND ??= "0x0000000000000000000000000000000000000003";

const rep = await import("../src/reputation.js");
const { IDENTITY_BOND_ABI, REPUTATION_ABI } = await import("../src/txlink.js");

const U = (n) => BigInt(Math.round(n * 1e6));
const INFO = { address: "0x0", decimals: 6, symbol: "mUSD" };

const profile = (over = {}) => ({
  address: "0x24B3c7704709ed1491473F30393FFc93cFB0FC34",
  completed: 0, counterparties: 0, disputesWon: 0, disputesLost: 0,
  disputesInconclusive: 0, nonDelivery: 0,
  volume: 0n, feesBurned: 0n,
  bondAmount: 0n, bondedAt: 0, toppedUpAt: 0, unbondableAt: 0, unbondRequests: 0,
  ageSec: 0, committed: 0n,
  ...over,
});

// ============================================================ 风险计算

describe("针对具体交易的风险计算", () => {
  // 这里检验的不是「分数算得准不准」，而是结论有没有指向正确的行动。
  // 一个把用户导向「相信一个陌生人」的评估，比没有评估更危险。

  test("保证金不低于货款时，机制本身已经挡住了，与信誉无关", () => {
    const a = rep.assess({ price: U(1000), counterpartyBond: U(1000), profile: null });
    assert.equal(a.level, "covered");
    assert.equal(a.gap, 0n);
    // 关键：对手方毫无记录也仍然是 covered —— 因为这个结论不依赖对方是谁
    const b = rep.assess({ price: U(1000), counterpartyBond: U(2000), profile: profile() });
    assert.equal(b.level, "covered");
  });

  test("缺口 = 货款 − 对方保证金", () => {
    const a = rep.assess({ price: U(1000), counterpartyBond: U(300), profile: null });
    assert.equal(a.gap, U(700));
  });

  test("身份押金盖得住缺口时降为黄色，盖不住时是红色", () => {
    const gap = { price: U(1000), counterpartyBond: U(300) }; // 缺口 700
    assert.equal(rep.assess({ ...gap, profile: profile({ committed: U(800) }) }).level, "partly");
    assert.equal(rep.assess({ ...gap, profile: profile({ committed: U(600) }) }).level, "exposed");
  });

  test("正在撤回中的押金不算数 —— 公示期一到就会被取走", () => {
    // committed 由合约的 committedOf() 给出，撤回中恒为 0；
    // 这里验证评估用的是 committed 而不是 bondAmount
    const p = profile({ bondAmount: U(5000), committed: 0n, unbondableAt: 999 });
    const a = rep.assess({ price: U(1000), counterpartyBond: U(300), profile: p });
    assert.equal(a.level, "exposed");
    assert.equal(a.covered, 0n);
  });

  test("没有信誉数据时按最坏情况算，不按「无消息即好消息」", () => {
    const a = rep.assess({ price: U(1000), counterpartyBond: U(0), profile: null });
    assert.equal(a.level, "exposed");
    assert.equal(a.covered, 0n);
  });
});

// ============================================================ 告警

describe("告警识别的是具体手法", () => {
  test("笔数多但对手方极少 —— 自己跟自己刷的形状", () => {
    const f = rep.flags(profile({ completed: 12, counterparties: 2, ageSec: 100 * 86400 }));
    assert.ok(f.some((x) => x.text.includes("自己跟自己刷")));
  });

  test("对手方足够分散就不该报刷单", () => {
    const f = rep.flags(profile({ completed: 12, counterparties: 9, ageSec: 100 * 86400 }));
    assert.ok(!f.some((x) => x.text.includes("自己跟自己刷")));
  });

  test("败诉与未交付是红色，不是黄色", () => {
    for (const over of [{ disputesLost: 1 }, { nonDelivery: 1 }]) {
      const f = rep.flags(profile(over));
      assert.ok(f.some((x) => x.level === "danger"), JSON.stringify(over));
    }
  });

  test("未认定过错的争议不算污点", () => {
    const f = rep.flags(profile({ disputesInconclusive: 3, completed: 8, counterparties: 8, ageSec: 100 * 86400 }));
    assert.equal(f.filter((x) => x.level === "danger").length, 0);
  });

  test("正在撤押是红色告警 —— 现在看到的押金不能依赖", () => {
    const f = rep.flags(profile({ committed: 0n, bondAmount: U(5000), unbondableAt: 1, ageSec: 100 * 86400, completed: 3 }));
    assert.ok(f.some((x) => x.level === "danger" && x.text.includes("撤回")));
  });

  test("老身份 + 刚堆高的押金会被点出来", () => {
    const now = 1_800_000_000;
    const f = rep.flags(
      profile({ ageSec: 400 * 86400, toppedUpAt: now - 2 * 86400, committed: U(50000), completed: 3, counterparties: 3 }),
      now
    );
    assert.ok(f.some((x) => x.text.includes("最近一周才加上去")));
  });

  test("全新身份会被明确说成「零成本」，而不是含糊带过", () => {
    const f = rep.flags(profile());
    assert.ok(f.some((x) => x.text.includes("成本是零")));
  });

  test("没有档案时，措辞不能暗示对方可信", () => {
    const f = rep.flags(null);
    assert.equal(f.length, 1);
    assert.ok(f[0].text.includes("没有任何东西可以佐证"));
  });
});

// ============================================================ 排版

/// 与 bot.test.js 中同一份校验。金额、年龄里天然含有 `.` `-`，
/// 漏一个 Telegram 会直接拒收整条消息 —— 用户什么都收不到。
function assertValidMarkdownV2(text, label) {
  let inCode = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") { i++; continue; }
    if (c === "`") { inCode = !inCode; continue; }
    if (inCode) continue;
    if (c === "*") continue;
    if ("_[]()~>#+-=|{}.!".includes(c)) {
      assert.fail(
        `${label}: 第 ${i} 位的 "${c}" 未转义，Telegram 会拒收整条消息\n  …${text.slice(Math.max(0, i - 30), i + 30)}…`
      );
    }
  }
  assert.equal(inCode, false, `${label}: 代码块未闭合`);
}

describe("信誉排版", () => {
  const cases = [
    ["全新身份", profile(), U(1000), U(0)],
    ["有记录有押金", profile({ completed: 12, counterparties: 9, ageSec: 400 * 86400, committed: U(5000), volume: U(120000), feesBurned: U(600.5) }), U(1000), U(300)],
    ["有污点", profile({ completed: 3, counterparties: 3, disputesLost: 2, nonDelivery: 1, disputesInconclusive: 1, ageSec: 40 * 86400, committed: U(100.25) }), U(1000), U(300)],
    ["撤押中", profile({ completed: 5, counterparties: 5, bondAmount: U(900), committed: 0n, unbondableAt: 1_800_000_000, ageSec: 200 * 86400 }), U(1000), U(1500)],
  ];

  for (const [name, p, price, bond] of cases) {
    test(`「${name}」渲染出的是合法 MarkdownV2`, () => {
      const assessment = rep.assess({ price, counterpartyBond: bond, profile: p });
      const text = rep.renderAssessment({ profile: p, assessment, info: INFO, roleLabel: "卖家" });
      assertValidMarkdownV2(text, name);
    });
  }

  test("档案为空时也必须是合法 MarkdownV2", () => {
    const assessment = rep.assess({ price: U(1000), counterpartyBond: U(0), profile: null });
    assertValidMarkdownV2(
      rep.renderAssessment({ profile: null, assessment, info: INFO, roleLabel: "买家" }),
      "空档案"
    );
  });

  test("红色评估必须给出可操作的出路，而不只是吓唬人", () => {
    const assessment = rep.assess({ price: U(1000), counterpartyBond: U(0), profile: profile() });
    const text = rep.renderAssessment({ profile: profile(), assessment, info: INFO, roleLabel: "卖家" });
    // 正确的建议是改参数，不是「小心一点」
    assert.ok(text.includes("保证金提到不低于货款"));
  });

  test("绿色评估不能出现「机制缺口」这种让人困惑的字样", () => {
    const assessment = rep.assess({ price: U(1000), counterpartyBond: U(1000), profile: profile() });
    const text = rep.renderAssessment({ profile: profile(), assessment, info: INFO, roleLabel: "卖家" });
    assert.ok(!text.includes("机制缺口"));
  });

  test("刚押入的身份不能显示成「年龄 无」—— 那和「没有押金」长得一样", () => {
    // 合约的 ageOf() 在「没押金」和「这一秒刚押的」两种情况下都返回 0，
    // 直接渲染会出现「年龄 无 / 押金 500」这种自相矛盾的一行
    const fresh = profile({ bondAmount: U(500), committed: U(500), ageSec: 0, bondedAt: 1 });
    assert.equal(rep.ageLabel(fresh), "不到 1 小时");
    assert.equal(rep.ageLabel(profile()), "无");
    assert.equal(rep.ageLabel(profile({ bondAmount: U(500), committed: U(500), ageSec: 86400 * 3 })), "3 天");
  });

  test("年龄格式覆盖小时 / 天 / 年", () => {
    assert.equal(rep.fmtAge(0), "无");
    assert.equal(rep.fmtAge(3600 * 5), "5 小时");
    assert.equal(rep.fmtAge(86400 * 3), "3 天");
    assert.ok(rep.fmtAge(86400 * 400).startsWith("1 年"));
  });
});

// ============================================================ ABI 一致性

describe("calldata 与真实合约一致", () => {
  const artifactsDir = path.resolve(process.cwd(), "../../artifacts/contracts");

  function selectorsOf(artifactPath) {
    const json = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    const iface = new ethers.Interface(json.abi);
    const out = new Map();
    iface.forEachFunction((f) => out.set(f.selector, f.format("sighash")));
    return out;
  }

  // 这里错了，用户会在自己的钱包里签出一笔调不通、或者干错事的交易，
  // 而机器人完全看不见。押金合约尤其不能出错 —— 那是真金白银。
  const pairs = [
    ["IdentityBond", "reputation/IdentityBond.sol/IdentityBond.json", () => IDENTITY_BOND_ABI],
    ["Reputation", "reputation/Reputation.sol/Reputation.json", () => REPUTATION_ABI],
  ];

  for (const [name, rel, abi] of pairs) {
    const p = path.join(artifactsDir, rel);
    test(`机器人手写的 ${name} ABI 与编译产物选择器一致`, { skip: !fs.existsSync(p) }, () => {
      const real = selectorsOf(p);
      new ethers.Interface(abi()).forEachFunction((f) => {
        assert.ok(real.has(f.selector), `${name} 上不存在 ${f.format("sighash")}（选择器 ${f.selector}）`);
      });
    });
  }

  test("只读用的 ABI 也要对得上，否则会展示出错误的信誉数据", { skip: !fs.existsSync(artifactsDir) }, () => {
    for (const [name, rel] of [
      ["Reputation", "reputation/Reputation.sol/Reputation.json"],
      ["IdentityBond", "reputation/IdentityBond.sol/IdentityBond.json"],
    ]) {
      const p = path.join(artifactsDir, rel);
      if (!fs.existsSync(p)) continue;
      const real = selectorsOf(p);
      for (const sig of rep.READ_ABIS[name]) {
        const f = ethers.FunctionFragment.from(sig);
        assert.ok(real.has(f.selector), `${name} 上不存在只读方法 ${f.format("sighash")}`);
      }
    }
  });
});
