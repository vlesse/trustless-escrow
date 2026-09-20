/**
 * 在公共 RPC 上跑长脚本的最低限度韧性。
 *
 * 实测：连发二十几笔交易时，公共节点几乎一定会断一次
 * （UND_ERR_HEADERS_TIMEOUT）。脚本因此中断，而链上已经做了一半。
 *
 * 重试必须分清两类操作，混着做会多花钱：
 *   读（查余额、查回执）重试没有副作用；
 *   发交易不能盲目重试 —— 交易可能已经广播，重发就是又发一笔。
 * 所以这里只提供「读重试」和「按哈希等回执」，不提供「发交易重试」。
 * 发交易的幂等性必须由调用方用业务语义保证（比如「补到目标值」而不是「发一笔」）。
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 网络抖动，还是合约真的拒绝了？后者重试多少次都一样。 */
function transient(e) {
  const code = e.code || e.cause?.code || "";
  if (["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT", "TIMEOUT", "SERVER_ERROR",
       "NETWORK_ERROR", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND"].includes(code)) return true;
  return /timeout|socket|fetch failed|ECONNRESET|502|503|504/i.test(e.message || "");
}

/** 只用来包读操作。指数退避，只对网络类错误重试。 */
async function read(label, fn, tries = 5) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); } catch (e) {
      if (!transient(e)) throw e;
      last = e;
      const ms = 800 * 2 ** (i - 1);
      console.log(`    ${label} 第 ${i} 次失败(${e.code || "timeout"})，${ms / 1000}s 后重试`);
      await sleep(ms);
    }
  }
  throw last;
}

/**
 * 发出去之后只按哈希轮询回执，永远不重发。
 *
 * 不用 waitForTransaction：hardhat 包装过的 provider 没实现它。
 * 自己轮询反而更贴合需求 —— 每次查询都是独立的读操作，单次超时不影响
 * 下一次，也不会把「还没打包」和「RPC 断了」混为一谈。
 */
async function confirm(provider, tx, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rc = await read("查回执", () => provider.getTransactionReceipt(tx.hash));
    if (rc) {
      if (rc.status !== 1) throw new Error("交易 " + tx.hash + " 被回滚");
      return rc;
    }
    await sleep(1200);
  }
  throw Object.assign(new Error("回执 " + tx.hash + " 超时未出"), { code: "TIMEOUT" });
}

module.exports = { sleep, transient, read, confirm };
