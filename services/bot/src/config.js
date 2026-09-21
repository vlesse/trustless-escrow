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

/// 可选地址。留空则对应功能关闭 —— 但填错必须立刻报错，
/// 而不是悄悄当成「没配置」跑下去：那会让用户看到一个空的信誉页，
/// 误以为对方真的没有记录。
function optAddr(name) {
  const v = process.env[name];
  if (!v) return "";
  if (!ethers.isAddress(v)) throw new Error(`环境变量 ${name} 不是合法地址: ${v}`);
  return v;
}

export const config = {
  botToken: req("TELEGRAM_BOT_TOKEN"),

  rpcUrl: req("RPC_URL"),
  chainId: num("CHAIN_ID", 97),
  escrowFactory: addr("ESCROW_FACTORY"),

  /// 签名页地址。机器人把构造好的交易请求编码进链接，
  /// 用户在自己的钱包里完成签名 —— 机器人全程不接触私钥。
  signingPageUrl: process.env.SIGNING_PAGE_URL ?? "",

  /// 公示站地址。机器人会让用户拿链上读到的仲裁层地址和这里公示的那份比对。
  /// 不配则只给区块浏览器链接 —— 那仍然能看，只是少了一个独立的参照物。
  siteUrl: (process.env.PUBLIC_SITE_URL ?? "").replace(/\/$/, ""),

  /// 区块浏览器，用于生成可点击的地址/交易链接
  explorerUrl: (process.env.EXPLORER_URL ?? "https://testnet.bscscan.com").replace(/\/$/, ""),

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

  /// 信誉层。两个地址都填上才启用 —— 只有一个的话展示会误导：
  /// 「押金 0」在没接押金合约时和真的没押金长得一模一样。
  reputation: optAddr("REPUTATION"),
  identityBond: optAddr("IDENTITY_BOND"),

  /// 商家额度池（可选）。不配置则整个额度功能静默关闭，担保交易不受影响。
  merchantBond: optAddr("MERCHANT_BOND"),

  /// 陪审团合约（可选）。配了才做抽选风险预警。
  stakedJury: optAddr("STAKED_JURY"),

  /// 抽选风险预警的广播目标（Telegram 频道或群的 chat id）。
  ///
  /// 刻意做成**公开广播**而不是私发给运营方：纠错手段本来就是开放的
  /// （任何人都可以自费上诉），缺的只是有人注意到。如果告警的终点是
  /// 「运营者看到之后人工介入」，那就等于把整个项目花力气干掉的那个
  /// 单点又请回来了。不配置则不广播。
  alertChatId: process.env.ALERT_CHAT_ID ?? "",

  stateFile: process.env.STATE_FILE ?? "./.bot-state.json",
};

export function describeConfig() {
  return [
    `  链 ID:      ${config.chainId}`,
    `  RPC:        ${config.rpcUrl}`,
    `  工厂:       ${config.escrowFactory}`,
    `  签名页:     ${config.signingPageUrl || "(未配置，将只输出原始 calldata)"}`,
    `  限流:       ${config.rateLimitPerMin} 条/分钟/用户`,
    `  信誉层:     ${config.reputation && config.identityBond ? `${config.reputation} / ${config.identityBond}` : "(未配置，已关闭)"}`,
  ].join("\n");
}
