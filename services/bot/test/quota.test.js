import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";

process.env.TELEGRAM_BOT_TOKEN ??= "test:token";
process.env.RPC_URL ??= "http://127.0.0.1:8545";
process.env.ESCROW_FACTORY ??= "0x0000000000000000000000000000000000000001";
process.env.CHAIN_ID ??= "42161";
process.env.MERCHANT_BOND ??= "0x00000000000000000000000000000000000000AA";

const quota = await import("../src/quota.js");
const { MERCHANT_BOND_ABI, buildQuotaDeposit, buildQuotaWithdraw, buildFundDeal } =
  await import("../src/txlink.js");

const U = (n) => BigInt(Math.round(n * 1e6));
const INFO = { address: "0x0", decimals: 6, symbol: "mUSD" };
const POOL = "0x00000000000000000000000000000000000000AA";
const OTHER = "0x00000000000000000000000000000000000000BB";
const DEAL = "0x24B3c7704709ed1491473F30393FFc93cFB0FC34";
const TOKEN = "0x1111111111111111111111111111111111111111";

// ============================================================ 能不能走额度

describe("这笔单能不能用额度付", () => {
  const base = { bondPayer: POOL, sellerBond: U(200), balance: U(1000) };

  test("代付方是本池子且余额够 —— 可以", () => {
    assert.equal(quota.fundability(base).ok, true);
  });

  test("交易没开启代付（bondPayer 为 0）—— 照常自己入金，不是错误", () => {
    const v = quota.fundability({ ...base, bondPayer: ethers.ZeroAddress });
    assert.equal(v.ok, false);
    assert.equal(v.why, "not_enabled_on_deal");
  });

  test("代付方是另一个池子 —— 拒绝，不能拿这个池子的钱去付", () => {
    const v = quota.fundability({ ...base, bondPayer: OTHER });
    assert.equal(v.ok, false);
    assert.equal(v.why, "other_pool");
  });

  test("余额不足时要算出差多少，而不是只说一句不行", () => {
    const v = quota.fundability({ ...base, balance: U(50) });
    assert.equal(v.ok, false);
    assert.equal(v.why, "insufficient");
    assert.equal(v.short, U(150));
  });

  test("正好够也算够", () => {
    assert.equal(quota.fundability({ ...base, balance: U(200) }).ok, true);
  });
});

// ============================================================ 排版

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

describe("额度展示", () => {
  test("不给每单保证金时只报余额", () => {
    const t = quota.renderQuota({ balance: U(1000.5), info: INFO });
    assert.ok(t.includes("1000"));
    assert.ok(!t.includes("还接得动"));
  });

  test("给了每单保证金就算出还能接几单", () => {
    const t = quota.renderQuota({ balance: U(1000), info: INFO, bond: U(300) });
    assert.ok(t.includes("*3* 单"), "1000 / 300 向下取整是 3");
  });

  test("必须说清楚结算后钱回的是钱包不是池子", () => {
    // 不说这句，商家会以为额度会自己回血，然后在某一单上突然付不出保证金。
    const t = quota.renderQuota({ balance: U(1000), info: INFO });
    assert.ok(t.includes("回的是你的钱包") || t.includes("不是这个池子"));
  });

  test("额度不足要给出出路，而不是把人堵死", () => {
    const t = quota.renderShort({ short: U(150.25), info: INFO });
    assert.ok(t.includes("150"), "要写出还差多少");
    assert.ok(t.includes("不是必经之路") || t.includes("直接用钱包"), "额度池只是省事，不该变成门槛");
  });

  for (const [name, text] of [
    ["余额", () => quota.renderQuota({ balance: U(1000.5), info: INFO, bond: U(300.25) })],
    ["不足", () => quota.renderShort({ short: U(150.25), info: INFO })],
  ]) {
    test(`「${name}」渲染出的是合法 MarkdownV2`, () => assertValidMarkdownV2(text(), name));
  }
});

// ============================================================ calldata

describe("生成的交易", () => {
  test("存额度是两笔：先授权额度池，再存入", () => {
    const txs = buildQuotaDeposit(TOKEN, POOL, U(500));
    assert.equal(txs.length, 2);
    assert.equal(txs[0].to.toLowerCase(), TOKEN.toLowerCase());
    assert.equal(txs[1].to.toLowerCase(), POOL.toLowerCase());

    const [spender, amount] = new ethers.Interface([
      "function approve(address,uint256)",
    ]).decodeFunctionData("approve", txs[0].data);
    assert.equal(spender.toLowerCase(), POOL.toLowerCase(), "授权的是池子，不是别的");
    assert.equal(amount, U(500), "授权额度只给本次所需");
  });

  test("用额度付款只有一笔 —— 这正是额度池存在的意义", () => {
    const tx = buildFundDeal(POOL, DEAL);
    assert.equal(tx.to.toLowerCase(), POOL.toLowerCase());
    const [deal] = new ethers.Interface(MERCHANT_BOND_ABI)
      .decodeFunctionData("fundDeal", tx.data);
    assert.equal(deal.toLowerCase(), DEAL.toLowerCase());
  });

  test("取回额度打给池子，金额如实", () => {
    const tx = buildQuotaWithdraw(POOL, U(200));
    const [amount] = new ethers.Interface(MERCHANT_BOND_ABI)
      .decodeFunctionData("withdraw", tx.data);
    assert.equal(amount, U(200));
  });
});

// ============================================================ ABI 一致性

describe("ABI 与编译产物一致", () => {
  const p = path.resolve(process.cwd(), "../../artifacts/contracts/MerchantBond.sol/MerchantBond.json");
  const real = () => {
    const iface = new ethers.Interface(JSON.parse(fs.readFileSync(p, "utf8")).abi);
    const out = new Set();
    iface.forEachFunction((f) => out.add(f.selector));
    return out;
  };

  test("写 calldata 用的 ABI 对得上", { skip: !fs.existsSync(p) }, () => {
    const known = real();
    new ethers.Interface(MERCHANT_BOND_ABI).forEachFunction((f) => {
      assert.ok(known.has(f.selector), `MerchantBond 上不存在 ${f.format("sighash")}`);
    });
  });

  test("只读用的 ABI 也对得上", { skip: !fs.existsSync(p) }, () => {
    const known = real();
    for (const sig of quota.READ_ABIS.MerchantBond) {
      const f = ethers.FunctionFragment.from(sig);
      assert.ok(known.has(f.selector), `MerchantBond 上不存在 ${f.format("sighash")}`);
    }
  });

  test("withdraw 在两个合约上同名但不同义 —— 签名页必须按目标分流", () => {
    // 身份押金的 withdraw() 会让身份年龄归零；额度池的 withdraw(uint256)
    // 只是取回预付款。选择器不同，但签名页按方法名查说明文案，
    // 不分流就会给用户看一段完全错误的描述。
    const bondW = ethers.FunctionFragment.from("function withdraw()");
    const quotaW = ethers.FunctionFragment.from("function withdraw(uint256)");
    assert.notEqual(bondW.selector, quotaW.selector);

    const app = fs.readFileSync(
      path.resolve(process.cwd(), "../signing-page/app.js"), "utf8"
    );
    assert.ok(app.includes("WITHDRAW_BY_TARGET"), "签名页缺少按目标分流的 withdraw 文案");
    assert.ok(
      app.includes('decoded.kind === "merchantBond"'),
      "签名页必须按目标合约区分，而不是只看方法名"
    );
  });
});
