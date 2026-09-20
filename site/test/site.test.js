import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 官网的静态一致性。
 *
 * 这页没有构建步骤、没有类型检查、没有框架 —— 写错一个 id 或漏一条译文，
 * 浏览器只会安静地少显示一块东西。而这页存在的全部意义就是「数字可核对」，
 * 少显示一块比报错更糟。
 *
 * 所以在没有运行时的地方，用静态比对补上：HTML 里出现的每个 i18n 键必须
 * 有英文，app.js 查的每个 id 必须在 HTML 里存在，公示的合约地址必须和
 * deployments 文件一致。
 */
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

const html = read("index.html");
const app = read("app.js");
const chain = read("chain.js");

function loadEN() {
  const w = {};
  new Function("window", read("i18n.js"))(w);
  return w.SITE_EN;
}
function loadChainConfig() {
  const w = {};
  new Function("window", read("chain-config.js"))(w);
  return w.SITE_CHAIN;
}

describe("官网", () => {
  test("每个中文文案都有对应的英文", () => {
    const EN = loadEN();
    const keys = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(keys.length > 40, "键少得不正常，选择器可能失效了");
    const missing = keys.filter((k) => !(k in EN));
    assert.deepEqual(missing, [], "这些键没有英文");
  });

  test("英文表里没有对不上任何元素的孤儿条目", () => {
    const EN = loadEN();
    const keys = new Set([...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]));
    const orphans = Object.keys(EN).filter((k) => !keys.has(k));
    assert.deepEqual(orphans, [], "这些译文没有元素在用，多半是 HTML 改过了");
  });

  test("app.js 查的每个 id 都存在于 HTML", () => {
    const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
    const used = new Set([...app.matchAll(/(?:\$\("#|getElementById\(")([\w-]+)/g)].map((m) => m[1]));
    const bad = [...used].filter((i) => !ids.has(i));
    assert.deepEqual(bad, [], "这些 id 在 HTML 里不存在");
  });

  test("公示的合约地址和 deployments 文件一致", () => {
    const C = loadChainConfig();
    const D = JSON.parse(fs.readFileSync(path.join(ROOT, "..", "deployments-bscTestnet.json"), "utf8"));
    for (const k of ["escrowFactory", "feeVault", "stakedJury", "optimisticArbitrator",
                     "escrowImpl", "settlementToken", "feeBeneficiary", "identityBond", "reputation"]) {
      assert.equal(C[k], D[k], k + " 和实际部署的对不上；重跑 scripts/site-config.cjs");
    }
    assert.equal(C.chainId, D.chainId);
    assert.equal(C.feeBps, D.feeBps);
  });

  test("不读 totalReceived —— 那个计数器永远是 0，而且谁都能往里加数", () => {
    // 托管合约用 ERC20 直接转账付手续费，触发不了回调，recordFee 没人调；
    // 而 recordFee 无权限不校验。拿它当「协议收入」公示就是公示一个假数。
    // 只看代码，不看注释 —— chain.js 里本来就有一段解释「为什么不读它」。
    const code = chain.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!/totalReceived/.test(code),
      "chain.js 又去读 totalReceived 了；累计收入应当是 totalSwept + pending");
    assert.ok(/totalSwept/.test(code) && /pending/.test(code));
  });

  test("外部脚本一律本地化，不从 CDN 拉", () => {
    const srcs = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(srcs.length > 0);
    for (const s of srcs) {
      assert.ok(!/^https?:|^\/\//.test(s),
        `${s} 是外链。一个职责是「让你核对」的页面，不该把自己的完整性交给第三方脚本`);
    }
  });
});
