/// 私钥 / 助记词粘贴防护。
///
/// 这不是一个理论上的边缘情况：用户往支付机器人里粘贴私钥和助记词是
/// 真实且高频的事故。很多人分不清「地址」和「私钥」，也有人被
/// 冒充客服的骗子引导着粘贴助记词。
///
/// 本机器人的设计前提是**永不接触私钥** —— 代码里根本不存在
/// 接收、存储或使用私钥的路径，用户全程在自己钱包里签名。
/// 但"我们不要"不等于"用户不会发"，所以必须主动识别并告警。
///
/// 处理原则：
///   1. 检测到就立即告警，并明确告知该密钥已应视为泄露
///   2. **绝不把内容写进日志、状态文件或任何持久化存储**
///   3. 宁可误报也不漏报 —— 误报的代价是一条多余提示，
///      漏报的代价是用户的全部资产

export const SecretKind = {
  PRIVATE_KEY: "private_key",
  MNEMONIC: "mnemonic",
};

/// 64 位十六进制。注意这与交易哈希的形状完全相同，无法从字面区分，
/// 所以调用方要通过 expectTxHash 告知当前上下文是否合理地期待一个交易哈希。
const HEX64 = /(?:^|[^0-9a-fA-Fx])(0x)?([0-9a-fA-F]{64})(?![0-9a-fA-F])/;

/// 助记词的结构特征：一长串短的纯小写单词。
/// 不内置 BIP-39 全词表 —— 词表会带来漏报（其它语言的词表、
/// 拼写变体），而结构特征本身已经足够：正常聊天不会出现
/// 连续 12 个以上的纯小写短单词。
function detectMnemonic(text) {
  const words = text.toLowerCase().match(/\b[a-z]{3,8}\b/g);
  if (!words || words.length < 12) return false;

  // 找最长的连续片段：原文里这些词必须是紧挨着的，
  // 中间夹着标点或长单词就不算
  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
  let run = 0;
  let best = 0;
  for (const t of tokens) {
    if (/^[a-z]{3,8}$/.test(t)) {
      run++;
      best = Math.max(best, run);
    } else {
      run = 0;
    }
  }
  // BIP-39 的合法长度是 12/15/18/21/24，用 12 作为下限
  return best >= 12;
}

/**
 * 扫描用户消息中的敏感内容。
 *
 * @param {string} text 用户消息原文
 * @param {{expectTxHash?: boolean}} ctx 当前上下文是否合理地期待交易哈希
 *        （例如提交证据时）。为 true 时不对 64 位十六进制告警。
 * @returns {{kind: string}|null}
 */
export function scanForSecrets(text, ctx = {}) {
  if (!text) return null;

  if (detectMnemonic(text)) return { kind: SecretKind.MNEMONIC };

  if (!ctx.expectTxHash && HEX64.test(text)) {
    return { kind: SecretKind.PRIVATE_KEY };
  }

  return null;
}

/// 告警文案。刻意写得直接且给出可操作的下一步 ——
/// 这种时刻用户往往已经慌了，需要的是明确指令而不是安慰。
export function secretWarning(kind) {
  if (kind === SecretKind.MNEMONIC) {
    return [
      "🚨 *检测到助记词*",
      "",
      "你刚才发送的内容看起来是钱包助记词。",
      "",
      "*请立刻做这两件事：*",
      "1\\. 用助记词在一个新钱包里恢复，把全部资产转到一个**全新创建**的钱包",
      "2\\. 删除你刚才那条消息",
      "",
      "这个助记词从现在起必须视为已泄露。Telegram 的聊天记录会留在服务器上，" +
        "本机器人不会存储它，但你无法确认还有谁看到了。",
      "",
      "本机器人**永远不需要**你的助记词或私钥。所有签名都在你自己的钱包里完成。",
    ].join("\n");
  }
  return [
    "🚨 *检测到疑似私钥*",
    "",
    "你刚才发送的内容包含一串 64 位十六进制字符，这是私钥的典型形状。",
    "",
    "*如果那确实是私钥：* 立刻把该地址下的全部资产转移到新钱包，并删除刚才那条消息。" +
      "它从现在起必须视为已泄露。",
    "",
    "*如果那只是一个交易哈希：* 忽略本提示。提交证据时请用 /evidence 命令，" +
      "那个上下文里不会再触发此告警。",
    "",
    "本机器人**永远不需要**你的私钥。绑定钱包只需要**地址**，签名在你自己的钱包里完成。",
  ].join("\n");
}
