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

const num = (name, dflt) => Number(process.env[name] ?? dflt);

export const config = {
  botToken: req("TELEGRAM_BOT_TOKEN"),

  rpcUrl: req("RPC_URL"),
  chainId: num("CHAIN_ID", 42161),
  escrowFactory: addr("ESCROW_FACTORY"),

  /// 签名页地址。机器人把构造好的交易请求编码进链接，
  /// 用户在自己的钱包里完成签名 —— 机器人全程不接触私钥。
  signingPageUrl: process.env.SIGNING_PAGE_URL ?? "",

  /// 区块浏览器，用于生成可点击的地址/交易链接
  explorerUrl: (process.env.EXPLORER_URL ?? "https://arbiscan.io").replace(/\/$/, ""),

  /// 单用户每分钟最多处理多少条消息。
  /// 机器人会替用户读链、算哈希，无限制会被轻易打爆。
  rateLimitPerMin: num("RATE_LIMIT_PER_MIN", 20),

  /// 长轮询超时（秒）
  pollTimeoutSec: num("POLL_TIMEOUT_SEC", 30),

  /// 链上事件的轮询间隔（毫秒）
  watchIntervalMs: num("WATCH_INTERVAL_MS", 30_000),

  /// 推送前等待的确认数。通知内容是「钱到账了」这类不可撤回的判断，
  /// 重组后已推送的消息会变成假消息，而用户可能已经据此发了货。
  confirmations: num("CONFIRMATIONS", 5),

  stateFile: process.env.STATE_FILE ?? "./.bot-state.json",
};

export function describeConfig() {
  return [
    `  链 ID:      ${config.chainId}`,
    `  RPC:        ${config.rpcUrl}`,
    `  工厂:       ${config.escrowFactory}`,
    `  签名页:     ${config.signingPageUrl || "(未配置，将只输出原始 calldata)"}`,
    `  限流:       ${config.rateLimitPerMin} 条/分钟/用户`,
  ].join("\n");
}
