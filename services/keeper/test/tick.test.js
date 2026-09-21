import { test, describe } from "node:test";
import assert from "node:assert/strict";

/**
 * 一轮推进的入口。
 *
 * 公共 RPC 后面是一组节点：先问「现在第几块」拿到 A 的答案，再去取那一块
 * 可能落到还没同步的 B 上，返回 null。原来的代码紧接着读 block.timestamp，
 * 直接抛，整轮推进作废。线上实际发生过两次。
 *
 * 这一类「两次调用之间节点不一致」的错，今天在四个地方各踩了一次：
 * 铸币后读余额、发货后读状态、机器人监听、以及这里。所以它值一条测试。
 */
process.env.RPC_URL ??= "http://127.0.0.1:8545";
process.env.KEEPER_PRIVATE_KEY ??= "0x" + "11".repeat(32);
process.env.ESCROW_FACTORY ??= "0x0000000000000000000000000000000000000001";
process.env.DRY_RUN = "true";

const { tick } = await import("../src/index.js");

/// 只实现 tick 会用到的那几个方法
function clientsWith(block) {
  return {
    provider: {
      getBlock: async (tag) => (tag === "latest" ? block : block),
      getBlockNumber: async () => {
        throw new Error("不该再用 getBlockNumber —— 号和时间戳必须来自同一次调用");
      },
      getLogs: async () => [],
    },
    wallet: { address: "0x" + "22".repeat(20) },
    // 工厂至少要能被查日志；其余几层不配就是「不推那一层」，本来就允许为 null
    factory: { queryFilter: async () => [], filters: { DealCreated: () => ({}) } },
    optimistic: null, jury: null, reputation: null,
  };
}

describe("一轮推进", () => {
  test("节点暂时取不到区块时跳过本轮，而不是整轮抛掉", async () => {
    const n = await tick(clientsWith(null), { deals: {} });
    assert.equal(n, undefined, "应当安静返回，不抛异常");
  });

  test("不再分两次问块高和时间戳", async () => {
    // getBlockNumber 一旦被调用，上面那个假 provider 就会抛
    await tick(clientsWith({ number: 1000, timestamp: 1_800_000_000 }), { deals: {} });
  });
});
