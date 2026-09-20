import { ethers } from "ethers";

function req(name) {
  const v = process.env[name];
  if (!v) throw new Error(`缺少环境变量 ${name}`);
  return v;
}
function addr(name) {
  const v = req(name);
  if (!ethers.isAddress(v)) throw new Error(`环境变量 ${name} 不是合法地址: ${v}`);
  return v;
}
function optAddr(name) {
  const v = process.env[name];
  if (!v) return "";
  if (!ethers.isAddress(v)) throw new Error(`环境变量 ${name} 不是合法地址: ${v}`);
  return v;
}
const bool = (name, dflt) => (process.env[name] ?? String(dflt)).toLowerCase() === "true";
const num = (name, dflt) => Number(process.env[name] ?? dflt);

export const config = {
  rpcUrl: req("RPC_URL"),

  /// 推进用的私钥。
  ///
  /// @dev **这把钥匙偷走一文不值。** 它能做的每一件事都是合约上任何人
  ///      都能做的：抽签、开揭示、计票、结案。它碰不到任何人的资金，
  ///      也不持有任何管理员权限。所以它可以放在服务器上热着用 ——
  ///      这和提案人的钥匙（要质押、会被罚没）、管理员的钥匙
  ///      （能停新单）是三种完全不同的东西，不要共用。
  privateKey: req("KEEPER_PRIVATE_KEY"),

  escrowFactory: addr("ESCROW_FACTORY"),
  optimisticArbitrator: optAddr("OPTIMISTIC_ARBITRATOR"),
  stakedJury: optAddr("STAKED_JURY"),
  reputation: optAddr("REPUTATION"),

  /// 干跑：只算出该推什么并打印，不发交易。与提案人同一个默认值 ——
  /// 会花钱的服务，默认值应当是「不花钱」。
  dryRun: bool("DRY_RUN", true),

  /// 轮询间隔。**这个值和链的出块速度绑死**，不是随便调的性能参数：
  /// drawJurors 依赖 blockhash(drawBlock)，而 blockhash 只能回溯 256 个区块，
  /// 在 BSC（约 0.45s 出块）上这个窗口只有 115 秒。间隔太长会让抽选
  /// 反复过期重排，一路耗到 ROUND_TIMEOUT 以拒裁收场，且全程不报错。
  /// 启动时 verifyConstants 会按实际出块速度核一遍。
  pollIntervalMs: num("POLL_INTERVAL_MS", 20_000),

  /// 单笔交易的 gas 上限。推进类调用的成本是可预期的，
  /// 远超这个数说明链上状态和预期不符，宁可不发也不要盲目烧钱。
  maxGasPerTx: num("MAX_GAS_PER_TX", 2_000_000),

  /// 一轮最多发多少笔。防止某次异常导致一口气打出几百笔交易。
  maxTxPerTick: num("MAX_TX_PER_TICK", 20),

  /// 连续失败多少次之后放弃这个目标，避免对着一个永远失败的调用无限重试。
  maxAttempts: num("MAX_ATTEMPTS", 5),

  /// 扫描新案件时往回追多少个区块。
  lookbackBlocks: num("LOOKBACK_BLOCKS", 50_000),

  stateFile: process.env.STATE_FILE ?? "./.keeper-state.json",
};

export function describeConfig() {
  return [
    "keeper 配置:",
    `  RPC:        ${config.rpcUrl}`,
    `  工厂:       ${config.escrowFactory}`,
    `  乐观层:     ${config.optimisticArbitrator || "(未配置，跳过)"}`,
    `  陪审团:     ${config.stakedJury || "(未配置，跳过)"}`,
    `  信誉层:     ${config.reputation || "(未配置，跳过)"}`,
    `  干跑:       ${config.dryRun ? "是（不发交易）" : "否（会真的上链）"}`,
    `  轮询间隔:   ${config.pollIntervalMs} ms`,
  ].join("\n");
}
