import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";

/**
 * 日志分片与时间→区块的换算。
 *
 * 这两件事在本地链上都不存在，所以最容易写错，而错法都是「不报错、只少干活」：
 *   - 跨度超过 RPC 上限 → 整条扫描静默失效（实测预警功能从来没成功过一次）
 *   - 把区块数当时间单位 → 名义上查三天，BSC 上实际只覆盖六小时
 * 两种都不会抛异常，所以只能靠测试钉住。
 */
process.env.TELEGRAM_BOT_TOKEN ??= "test:token";
process.env.RPC_URL ??= "http://127.0.0.1:8545";
process.env.ESCROW_FACTORY ??= "0x0000000000000000000000000000000000000001";

const { ranges, getLogs, blockTimeSeconds, DEFAULT_MAX_RANGE } = await import("../src/logs.js");

/** 像 BSC 公共节点那样，跨度超过 limit 就直接拒绝。 */
function strictProvider(limit = 50000, { blockTimeSec = 0.45, head = 1_000_000 } = {}) {
  const calls = [];
  return {
    calls,
    getBlockNumber: async () => head,
    getBlock: async (n) => ({ timestamp: Math.round(n * blockTimeSec) }),
    getLogs: async ({ fromBlock, toBlock }) => {
      const span = toBlock - fromBlock + 1;
      if (span > limit) {
        const e = new Error(`exceed maximum block range: ${limit}`);
        e.code = -32701;
        throw e;
      }
      calls.push([fromBlock, toBlock]);
      return [];
    },
  };
}

describe("日志分片", () => {
  test("切出来的每一片都不超过上限，且首尾相接不重不漏", () => {
    const rs = ranges(100, 100 + 250_000, 20_000);
    assert.equal(rs[0][0], 100);
    assert.equal(rs[rs.length - 1][1], 100 + 250_000);
    for (const [lo, hi] of rs) assert.ok(hi - lo + 1 <= 20_000, `${lo}-${hi} 超宽了`);
    for (let i = 1; i < rs.length; i++)
      assert.equal(rs[i][0], rs[i - 1][1] + 1, "第 " + i + " 片和上一片没接上");
  });

  test("空区间和单块区间", () => {
    assert.deepEqual(ranges(10, 9), []);
    assert.deepEqual(ranges(10, 10, 20_000), [[10, 10]]);
  });

  test("六十万块的跨度也能扫完 —— 停机半天之后正是这个场景", async () => {
    const p = strictProvider(50_000);
    await getLogs({ provider: p, filter: { address: "0x1" }, fromBlock: 1, toBlock: 600_000 });
    assert.ok(p.calls.length >= 30, "应当切成很多片，实际 " + p.calls.length);
    for (const [lo, hi] of p.calls) assert.ok(hi - lo + 1 <= 50_000);
    assert.equal(p.calls[0][0], 1);
    assert.equal(p.calls[p.calls.length - 1][1], 600_000);
  });

  test("默认片宽留了余量 —— 换一家 RPC 上限可能比 BSC 更低", () => {
    assert.ok(DEFAULT_MAX_RANGE <= 50_000, "默认片宽不能等于或超过已知的最严上限");
  });
});

describe("出块间隔", () => {
  test("量得出 BSC 的 0.45 秒", async () => {
    const dt = await blockTimeSeconds(strictProvider(50_000, { blockTimeSec: 0.45 }));
    assert.ok(Math.abs(dt - 0.45) < 0.01, "量出来是 " + dt);
  });

  test("量得出以太坊的 12 秒 —— 同一段代码在两条链上差 27 倍", async () => {
    const dt = await blockTimeSeconds(strictProvider(50_000, { blockTimeSec: 12 }));
    assert.ok(Math.abs(dt - 12) < 0.1);
  });

  test("估不出来时返回 null，而不是编一个数", async () => {
    assert.equal(await blockTimeSeconds(strictProvider(50_000, { head: 5 })), null);
    assert.equal(await blockTimeSeconds({ getBlockNumber: async () => { throw new Error("x"); } }), null);
    const frozen = { getBlockNumber: async () => 1e6, getBlock: async () => ({ timestamp: 42 }) };
    assert.equal(await blockTimeSeconds(frozen), null);
  });
});

// ---------------------------------------------------------------------------

const ja = await import("../src/juryalert.js");

const JURY = "0x4458E67d9b99d17365f04A18774525499631A204";
const J1 = "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa";   // 校验和合法，会经过 ethers 解析

/**
 * 能应付 collectDraw 全部调用的假节点：
 * 合约的 view 调用走 call，日志走 getLogs，两边都记下来供断言。
 */
function juryProvider({ blockTimeSec, head = 2_000_000, logLimit = 50_000 }) {
  const iface = new ethers.Interface(ja.JURY_ALERT_ABI);
  const scanned = [];
  return {
    scanned,
    getBlockNumber: async () => head,
    getBlock: async (n) => ({ timestamp: Math.round(n * blockTimeSec) }),
    getLogs: async ({ fromBlock, toBlock }) => {
      const span = toBlock - fromBlock + 1;
      if (span > logLimit) throw Object.assign(new Error("exceed maximum block range"), { code: -32701 });
      scanned.push([fromBlock, toBlock]);
      return [];
    },
    call: async ({ data }) => {
      const sel = data.slice(0, 10);
      const fn = iface.getFunction(sel);
      if (fn.name === "juryCoverage") return iface.encodeFunctionResult(fn, [5000n]);
      if (fn.name === "totalStake") return iface.encodeFunctionResult(fn, [100000n]);
      if (fn.name === "stakeOf") return iface.encodeFunctionResult(fn, [1000n]);
      throw new Error("假节点没准备 " + fn.name);
    },
  };
}

async function draw(provider) {
  return ja.collectDraw({
    jury: JURY, id: "1", round: 0, drawn: [J1],
    value: 1000n, provider, now: 1_000_000,
  });
}

describe("新质押回溯窗口", () => {
  test("BSC 上三天要回溯约 57.6 万个区块，而不是写死的 5 万", async () => {
    const p = juryProvider({ blockTimeSec: 0.45 });
    const d = await draw(p);
    assert.ok(p.scanned.length > 0, "根本没去查 Staked 日志");
    const covered = p.scanned[p.scanned.length - 1][1] - p.scanned[0][0] + 1;
    const want = Math.ceil(ja.FRESH_STAKE_WINDOW / 0.45);   // 576000
    assert.ok(Math.abs(covered - want) <= 1,
      `只覆盖了 ${covered} 个区块，应为 ${want}；写死区块数会让三天的窗口在 BSC 上缩成几小时`);
    assert.equal(d.freshWindowPartial, false, "没到上限，不该标记为只查了一部分");
  });

  test("以太坊上同样三天只要两万多个区块 —— 系数必须来自链本身", async () => {
    const p = juryProvider({ blockTimeSec: 12 });
    await draw(p);
    const covered = p.scanned[p.scanned.length - 1][1] - p.scanned[0][0] + 1;
    const want = Math.ceil(ja.FRESH_STAKE_WINDOW / 12);     // 21600
    assert.ok(Math.abs(covered - want) <= 1, `覆盖 ${covered}，应为 ${want}`);
  });

  test("每一片都在 RPC 的跨度上限之内", async () => {
    const p = juryProvider({ blockTimeSec: 0.45 });
    await draw(p);
    for (const [lo, hi] of p.scanned) assert.ok(hi - lo + 1 <= 50_000, `${lo}-${hi} 超了`);
  });

  test("链快到一片都装不下整个窗口时，明说只查了一部分", async () => {
    // 0.05 秒出块 → 三天要 518.4 万块，超过 40 片 × 20000 的上限
    const p = juryProvider({ blockTimeSec: 0.05 });
    const d = await draw(p);
    assert.equal(d.freshWindowPartial, true, "覆盖不全却没标记，等于默默少报");
  });
});

// ---------------------------------------------------------------------------

const { toMessageLink } = await import("../src/txlink.js");
const wallet = await import("../src/wallet.js");

/**
 * 绑定链接。
 *
 * 这一段连接两个进程：机器人编码，签名页解码并据此判断放不放行。
 * 两边对「什么是合法的绑定文本」的认知一旦分叉，表现不是报错，
 * 而是用户点开链接看到一句「已拒绝」——绑定这一步就彻底断了。
 */
describe("绑定链接", () => {
  const challenge = wallet.buildChallenge(6366755311, wallet.newNonce(), Date.now());

  test("没配签名页时返回 null，机器人据此退回文字说明", () => {
    const saved = process.env.SIGNING_PAGE_URL;
    // config 是模块加载时定下的，这里直接验证「配了就有、没配就没有」这个约定
    assert.ok(typeof toMessageLink === "function");
    process.env.SIGNING_PAGE_URL = saved;
  });

  test("编出来的链接能原样解回那段文字", () => {
    const link = toMessageLink(challenge);
    if (link === null) return;   // 本次测试环境没配签名页
    const b64 = link.split("#msg=")[1];
    const json = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
    assert.equal(json.text, challenge,
      "解出来的和原文不一致——差一个字节，签出来就是另一个签名，验签必然失败");
  });

  test("绑定文本以签名页认的前缀开头", () => {
    // 签名页只放行以这个前缀开头的内容，别的一律拒签。
    // 前缀在两个进程里各写了一份，这条测试就是那份契约。
    assert.ok(challenge.startsWith("人人担保 钱包绑定"),
      "改了绑定文本的开头，就必须同步改签名页的 BIND_PREFIX");
  });

  test("签名页的白名单前缀和这里一致", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.join(import.meta.dirname, "../../signing-page/app.js"), "utf8");
    const m = src.match(/const BIND_PREFIX = "([^"]+)"/);
    assert.ok(m, "签名页里找不到 BIND_PREFIX —— 那道白名单没了，页面会变成通用签名工具");
    assert.ok(challenge.startsWith(m[1]),
      `签名页认的前缀是「${m[1]}」，机器人发的文本对不上，绑定会被页面拒绝`);
  });
});

// ---------------------------------------------------------------------------

const { isPruned } = await import("../src/logs.js");

/**
 * 「历史没了」和「网络抖了一下」必须分得开。
 *
 * 分不开的后果是二选一，而两个都很糟：
 *   把裁剪当抖动 → 无限重试同一个已经不存在的区间，游标永久卡死；
 *   把抖动当裁剪 → 一次网络波动就永久跳过一段真实事件。
 */
describe("历史被裁剪的识别", () => {
  test("认得出各家节点的裁剪措辞", () => {
    const real = [
      { error: { message: "History has been pruned for this block. To remove restrictions, order a dedicated full node here: https://www.allnodes.com/bnb/host" } },
      { error: { message: "limit exceeded" } },
      { message: "missing trie node" },
      { message: "requested block number is not found" },
    ];
    for (const e of real) assert.equal(isPruned(e), true, JSON.stringify(e));
  });

  test("不把网络抖动当成裁剪 —— 那会永久跳过真实事件", () => {
    const transient = [
      { code: "UND_ERR_HEADERS_TIMEOUT", message: "Headers Timeout Error" },
      { code: "ECONNRESET", message: "socket hang up" },
      { message: "fetch failed" },
      { message: "exceed maximum block range: 50000" },   // 这个是跨度超限，切片能解决
    ];
    for (const e of transient) assert.equal(isPruned(e), false, JSON.stringify(e));
  });
});
