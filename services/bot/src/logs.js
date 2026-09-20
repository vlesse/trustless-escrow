import { ethers } from "ethers";

/**
 * 分片读日志。
 *
 * 公共 RPC 对 eth_getLogs 的区块跨度有硬上限（BSC 上是 50000），超了直接报错。
 * 这件事在本地链上不存在，所以很容易写出一个「跨度随停机时长增长」的扫描，
 * 而它会在停机之后才第一次失败 —— 恰好是最需要它工作的时刻。
 *
 * 更隐蔽的是：主循环里游标只在整个 tick 成功后才推进。一旦跨度超限，
 * 每一轮都抛在同一个地方，游标永远停在原处 —— 不是「慢慢追上来」，
 * 是永久卡死，而且只在日志里留一行。
 *
 * 所以这里不只是切片，还要让调用方能**逐片推进游标**：
 * 中途失败时，已经扫完的部分不该白扫。
 */

/// 单次 eth_getLogs 的最大区块跨度。默认取得比 BSC 的 50000 保守，
/// 因为换一家 RPC 上限可能更低，而超限的表现是整条链路静默失效。
export const DEFAULT_MAX_RANGE = Number(process.env.LOG_RANGE_MAX ?? 20000);

/** [from, to] 切成若干个闭区间，每个跨度不超过 maxRange。 */
export function ranges(from, to, maxRange = DEFAULT_MAX_RANGE) {
  const out = [];
  if (to < from) return out;
  const span = Math.max(1, maxRange);
  for (let a = from; a <= to; a += span) out.push([a, Math.min(a + span - 1, to)]);
  return out;
}

/**
 * 按片取日志。每取完一片调一次 onChunk(logs, hi)，让调用方能落地进度。
 * 任何一片失败都直接抛 —— 调用方已经拿到前面若干片，知道该从哪继续。
 */
async function forEachChunk({ provider, filter, fromBlock, toBlock, maxRange }, onChunk) {
  for (const [lo, hi] of ranges(fromBlock, toBlock, maxRange)) {
    const logs = await provider.getLogs({ ...filter, fromBlock: lo, toBlock: hi });
    await onChunk(logs, hi);
  }
}

/** 一次性取回全部日志。只在跨度可控时用（比如按时间窗算出来的回溯）。 */
export async function getLogs({ provider, filter, fromBlock, toBlock, maxRange }) {
  const all = [];
  await forEachChunk({ provider, filter, fromBlock, toBlock, maxRange },
    (logs) => { all.push(...logs); });
  return all;
}

/**
 * 估算出块间隔（秒）。
 *
 * 「回溯三天」这种需求必须换算成区块数才能查日志，而换算系数在不同链上
 * 差两个数量级：以太坊 12 秒、BSC 0.45 秒。写死一个区块数，
 * 在慢链上会多扫很多，在快链上覆盖的时间远比预期短 —— 后者不会报错，
 * 只会让检测悄悄漏掉大部分该看的历史。
 *
 * 估不出来时返回 null，由调用方决定降级方式，而不是在这里编一个数。
 */
export async function blockTimeSeconds(provider) {
  try {
    const head = await provider.getBlockNumber();
    const span = Math.min(1000, head);
    if (span < 10) return null;
    const [a, b] = await Promise.all([provider.getBlock(head - span), provider.getBlock(head)]);
    const dt = (Number(b.timestamp) - Number(a.timestamp)) / span;
    return dt > 0 ? dt : null;
  } catch {
    return null;
  }
}

export { ethers };
