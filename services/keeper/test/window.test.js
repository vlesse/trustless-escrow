import { test, describe } from "node:test";
import assert from "node:assert/strict";

/**
 * 抽选窗口够不够轮询一次。
 *
 * drawJurors 要读 blockhash(drawBlock)，而 blockhash 只能回溯 256 个区块。
 * 这个窗口的长度完全由链的出块速度决定，而出块速度在不同链上差两个数量级。
 *
 * 这件事没有任何运行时信号：窗口过期时合约会兜底重排（不死锁），
 * keeper 这边看到的只是「条件还没到」。案子就这么一路耗到 ROUND_TIMEOUT，
 * 最后以拒裁收场，而日志里一条错误都没有。所以只能在启动时算出来。
 */

process.env.RPC_URL ??= "http://127.0.0.1:8545";
process.env.KEEPER_PRIVATE_KEY ??= "0x" + "11".repeat(32);
process.env.ESCROW_FACTORY ??= "0x0000000000000000000000000000000000000001";

const { verifyConstants } = await import("../src/chain.js");
const { config } = await import("../src/config.js");
const tasks = await import("../src/tasks.js");

/// 出块间隔为 blockTimeSec 的假链
function fakeProvider(blockTimeSec, head = 1_000_000) {
  return {
    getBlockNumber: async () => head,
    getBlock: async (n) => ({ timestamp: Math.round(n * blockTimeSec) }),
  };
}
const fakeJury = { ROUND_TIMEOUT: async () => BigInt(tasks.ROUND_TIMEOUT) };

async function check(blockTimeSec, pollMs, provider = fakeProvider(blockTimeSec)) {
  const saved = config.pollIntervalMs;
  config.pollIntervalMs = pollMs;
  try {
    return await verifyConstants({ jury: fakeJury, optimistic: null, provider }, tasks);
  } finally {
    config.pollIntervalMs = saved;
  }
}

describe("抽选窗口与轮询间隔", () => {
  test("BSC 的 0.45s 出块配 60s 轮询：窗口只有 115s，必须拦下", async () => {
    const problems = await check(0.45, 60_000);
    assert.equal(problems.length, 1, "应当报出问题");
    assert.match(problems[0], /轮询间隔/);
    assert.match(problems[0], /115/, "应当把算出来的窗口长度说清楚");
  });

  test("同样的链，降到 20s 就够了", async () => {
    assert.deepEqual(await check(0.45, 20_000), []);
  });

  test("以太坊 12s 出块时窗口 51 分钟，60s 轮询毫无压力", async () => {
    assert.deepEqual(await check(12, 60_000), []);
  });

  test("Arbitrum 的 0.25s 出块只剩 66s 窗口，连 30s 轮询都不够", async () => {
    const problems = await check(0.25, 30_000);
    assert.equal(problems.length, 1);
  });

  test("估不出出块速度时跳过本项，而不是编一个数", async () => {
    // 新链还没出够块
    assert.deepEqual(await check(0.45, 60_000, fakeProvider(0.45, 5)), []);
    // RPC 抽风
    const broken = { getBlockNumber: async () => { throw new Error("boom"); } };
    assert.deepEqual(await check(0.45, 60_000, broken), []);
  });

  test("时间戳倒流或不动时也跳过，不能算出负窗口", async () => {
    const frozen = { getBlockNumber: async () => 1_000_000, getBlock: async () => ({ timestamp: 42 }) };
    assert.deepEqual(await check(0, 60_000, frozen), []);
  });
});
