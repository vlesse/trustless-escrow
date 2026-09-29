/// 证据：用户发来的东西 → 写进链上的那一串，以及反过来。
///
/// 合约里证据字段就是一个字符串，本来什么都能放。原来机器人只收
/// https:// 和 ipfs:// 开头的链接 —— 可普通用户手里有的是一段话、一张截图，
/// 不是一个链接。实测用户第一反应就是「不能是聊天记录、截图吗？」
///
/// 现在：
///   · 链接照收
///   · 文字直接写进链上（data: 格式，合约本来就支持，卖家标记交付时一直这么用）
///   · 图片/文件**明确拒绝并说明**。原来发一张图过来，机器人收到的文字是空的，
///     而空字符串被当成「不附证据」放行 —— 用户以为交了截图，链上什么都没有。

export const TEXT_PREFIX = "data:text/plain;charset=utf-8;base64,";

/// 文字证据上限。链上每个字节都要 gas，但 1000 个汉字约 3KB、不到 5 万 gas，
/// 在 BSC 上可以忽略；再长就该放进文件、交链接了。
export const MAX_TEXT = 1000;

const LINK = /^(https?|ipfs):\/\/\S+$/i;

/**
 * @returns {{ok: true, uri: string, kind: "none"|"link"|"text"} | {ok: false, reason: "media"|"empty"|"too-long"}}
 */
export function parseEvidenceInput(text, { hasMedia = false, allowSkip = true } = {}) {
  // 带图片/文件的消息，文字部分是空的或只是图注。绝不能当「不附证据」处理。
  if (hasMedia) return { ok: false, reason: "media" };

  const v = String(text ?? "").trim();
  if (!v) return { ok: false, reason: "empty" };
  if (allowSkip && /^skip$/i.test(v)) return { ok: true, uri: "", kind: "none" };
  if (LINK.test(v)) return { ok: true, uri: v, kind: "link" };
  if ([...v].length > MAX_TEXT) return { ok: false, reason: "too-long" };
  return { ok: true, uri: TEXT_PREFIX + Buffer.from(v, "utf8").toString("base64"), kind: "text" };
}

/// 链上那一串 → 给人看的样子。
export function describeEvidence(uri) {
  const s = String(uri ?? "");
  if (!s) return { kind: "none", body: "" };
  const m = s.match(/^data:text\/plain[^,]*;base64,(.*)$/i);
  if (m) {
    try {
      return { kind: "text", body: Buffer.from(m[1], "base64").toString("utf8") };
    } catch {
      return { kind: "link", body: s };
    }
  }
  return { kind: "link", body: s };
}

/// 拒绝时说什么。每一种都要告诉用户「那我该怎么办」。
export const REJECT_TEXT = {
  media: "截图、图片、文件现在还不能直接交。\n\n" +
    "你可以：\n" +
    "· 把截图里的关键内容用文字写下来发给我（比如「卖家 9月29日 22:10 发来的激活码提示已被使用」）\n" +
    "· 或者把截图传到网盘/图床，把链接发给我",
  empty: "没收到内容。请直接发一段文字说明，或者粘贴一个链接。",
  "too-long": `太长了，最多 ${MAX_TEXT} 个字。请精简一下，或者把长内容放进文件、发链接。`,
};

/// 放在每个「请提交证据」提示后面的那段话。
export const EVIDENCE_HOWTO =
  "直接发一段文字说明就行（比如：什么时间、发生了什么、对方怎么说的），也可以粘贴一个链接。\n" +
  "⚠️ 提交的内容会永久公开记在链上，不能删除、不能修改。不要写密码、身份证号、银行卡号。";
