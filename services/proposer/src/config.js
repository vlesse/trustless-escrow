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

const bool = (name, dflt) => (process.env[name] ?? String(dflt)).toLowerCase() === "true";
const num = (name, dflt) => Number(process.env[name] ?? dflt);

export const config = {
  rpcUrl: req("RPC_URL"),
  privateKey: req("PROPOSER_PRIVATE_KEY"),

  optimisticArbitrator: addr("OPTIMISTIC_ARBITRATOR"),
  escrowFactory: addr("ESCROW_FACTORY"),

  /// 干跑模式：只计算裁决并打印，不上链、不质押。
  /// 默认开启 —— 让运营者先观察若干真实案件的判断质量，
  /// 再决定是否让它拿钱去下注。这是个有真金白银后果的服务，
  /// 默认值应当是「不花钱」。
  dryRun: bool("DRY_RUN", true),

  /// 置信度门槛。低于此值不提案，让案件自然超时升级到陪审团。
  ///
  /// 「不确定时弃权」是本服务最重要的行为约束。一个总是给出裁决的 AI
  /// 比一个会弃权的 AI 更危险：它会在证据不足时也硬判，
  /// 而每一次硬判都是一次可能的错误结算。
  /// 提案人有保证金在里面，弃权在经济上也是理性的。
  minConfidence: num("MIN_CONFIDENCE", 0.8),

  /// 轮询间隔（毫秒）。事件订阅之外的兜底扫描。
  pollIntervalMs: num("POLL_INTERVAL_MS", 30_000),

  /// 单份证据的最大下载字节数，防止被超大文件拖死。
  maxEvidenceBytes: num("MAX_EVIDENCE_BYTES", 256 * 1024),

  /// 单个案件最多处理多少份证据。
  maxEvidenceItems: num("MAX_EVIDENCE_ITEMS", 20),

  /// 证据抓取超时（毫秒）。
  fetchTimeoutMs: num("FETCH_TIMEOUT_MS", 10_000),

  ipfsGateway: process.env.IPFS_GATEWAY ?? "https://ipfs.io/ipfs/",

  model: process.env.CLAUDE_MODEL ?? "claude-opus-5",

  /// 已处理案件的状态文件，防止重启后重复提案。
  stateFile: process.env.STATE_FILE ?? "./.proposer-state.json",
};

export function describeConfig() {
  return [
    `  RPC:            ${config.rpcUrl}`,
    `  仲裁层:         ${config.optimisticArbitrator}`,
    `  工厂:           ${config.escrowFactory}`,
    `  模型:           ${config.model}`,
    `  置信度门槛:     ${config.minConfidence}`,
    `  干跑模式:       ${config.dryRun ? "是（不会上链）" : "否（会真实质押并提交）"}`,
  ].join("\n");
}
