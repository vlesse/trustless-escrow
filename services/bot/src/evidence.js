/// 证据：用户发来的东西 → 写进链上的那一串，以及反过来。
///
/// 合约里证据字段就是一个字符串，本来什么都能放。原来机器人只收
/// https:// 和 ipfs:// 开头的链接 —— 可普通用户手里有的是一段话、一张截图，
/// 不是一个链接。实测用户第一反应就是「不能是聊天记录、截图吗？」
///
/// 现在是一个「证据篮」：点一次「提交证据」，文字、链接、图片想发几条发几条，
/// 最后点「全部提交」只签一次。
///   · 全是文字/链接 → 合在一起直接写进链上（data: 格式，合约本来就支持）
///   · 带图片 → 图片和文字一起打成一个证据包存在我们服务器上，链上记包的地址。
///     **文件名就是内容的 SHA-256**：谁改了一个字节，文件名就对不上，
///     任何人都能自己算一遍来核对 —— 和 IPFS 同一个道理，只是不用另起一套网络。
///
/// 这里只放纯函数（可测）；读写磁盘、下载 Telegram 文件在 evidencestore.js。

import { createHash } from "node:crypto";

export const TEXT_PREFIX = "data:text/plain;charset=utf-8;base64,";

/// 单条文字上限。1000 个汉字约 3KB、不到 5 万 gas，在 BSC 上可以忽略。
export const MAX_TEXT = 1000;
/// 一次提交最多几条、几张图。再多就分几次交 —— 仲裁的人也看不过来。
export const MAX_ITEMS = 20;
export const MAX_IMAGES = 10;
/// 纯文字合并后直接上链的上限（字节）。超过就改走证据包，免得一笔交易塞太大。
export const MAX_ONCHAIN_BYTES = 6000;

const LINK = /^(https?|ipfs):\/\/\S+$/i;

/**
 * 解析一条文字消息。图片走另一条路（要下载），不在这里。
 * @returns {{ok: true, item?: object, skip?: true} | {ok: false, reason: string}}
 */
export function parseEvidenceInput(text, { hasMedia = false, allowSkip = true } = {}) {
  // 这里拿到带媒体的消息，说明是图片以外的东西（视频、语音、贴纸……）
  if (hasMedia) return { ok: false, reason: "media" };

  const v = String(text ?? "").trim();
  if (!v) return { ok: false, reason: "empty" };
  if (allowSkip && /^skip$/i.test(v)) return { ok: true, skip: true };
  if (LINK.test(v)) return { ok: true, item: { type: "link", url: v } };
  if ([...v].length > MAX_TEXT) return { ok: false, reason: "too-long" };
  return { ok: true, item: { type: "text", text: v } };
}

/// 篮子里还能不能再放。
export function canAdd(items, type) {
  if (items.length >= MAX_ITEMS) return { ok: false, reason: "too-many" };
  if (type === "image" && items.filter((i) => i.type === "image").length >= MAX_IMAGES) {
    return { ok: false, reason: "too-many-images" };
  }
  return { ok: true };
}

/// 纯文字/链接合成一段给人读的文字。
export function itemsToText(items) {
  if (items.length === 1) return items[0].type === "link" ? items[0].url : items[0].text;
  return items.map((it, i) => `【${i + 1}】${it.type === "link" ? "链接：" + it.url : it.text}`).join("\n");
}

/**
 * 篮子 → 上链的方式。
 * @returns {{kind: "text", uri: string} | {kind: "bundle"}}
 */
export function planSubmission(items) {
  if (items.length === 0) return { kind: "text", uri: "" };
  if (!items.some((i) => i.type === "image")) {
    const uri = TEXT_PREFIX + Buffer.from(itemsToText(items), "utf8").toString("base64");
    if (Buffer.byteLength(uri) <= MAX_ONCHAIN_BYTES) return { kind: "text", uri };
  }
  return { kind: "bundle" };
}

/**
 * 证据包。字段顺序固定、不含任何本地路径 —— 同样的内容永远算出同一个哈希。
 * 图片只记哈希和扩展名，不记 URL：换域名不影响包本身的有效性。
 */
export function buildBundle({ deal, by, method, items, createdAt }) {
  const doc = {
    v: 1,
    deal, by, method,
    createdAt,
    items: items.map((it) => it.type === "image"
      ? { type: "image", sha256: it.sha256, ext: it.ext, bytes: it.bytes }
      : it.type === "link" ? { type: "link", url: it.url } : { type: "text", text: it.text }),
  };
  const json = JSON.stringify(doc, null, 1);
  return { json, sha256: sha256Hex(Buffer.from(json, "utf8")) };
}

export const sha256Hex = (buf) => createHash("sha256").update(buf).digest("hex");

/// 按文件头认图片格式，不信 Telegram 给的 MIME，也不信文件名。
/// 只收三种静态图片 —— 我们的服务器绝不能变成替人托管任意文件的地方。
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  return null;
}

/// 链上那一串 → 给人看的样子。bundleBase 是我们存证据包的地址前缀。
export function describeEvidence(uri, { bundleBase = "" } = {}) {
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
  if (bundleBase) {
    const b = s.match(/^(.*)\/([0-9a-f]{64})\.json$/);
    if (b && b[1] === bundleBase.replace(/\/$/, "")) return { kind: "bundle", body: s, sha256: b[2] };
  }
  return { kind: "link", body: s };
}

/// 篮子里现在有什么，一句话。
export function summarizeItems(items) {
  const n = (t) => items.filter((i) => i.type === t).length;
  const parts = [];
  if (n("text")) parts.push(`文字 ${n("text")} 段`);
  if (n("link")) parts.push(`链接 ${n("link")} 个`);
  if (n("image")) parts.push(`图片 ${n("image")} 张`);
  return parts.join("、") || "还没有内容";
}

/// 拒绝时说什么。每一种都要告诉用户「那我该怎么办」。
export const REJECT_TEXT = {
  media: "这种消息收不了。只能发：文字、链接、图片（截图、照片都行）。\n视频、语音、文件请先传到网盘，把链接发给我。",
  empty: "没收到内容。请发一段文字、一个链接，或者一张图片。",
  "too-long": `这一段太长了，最多 ${MAX_TEXT} 个字。可以拆成几段分开发。`,
  "too-many": `一次最多 ${MAX_ITEMS} 条。先点「全部提交」把这些交上去，再点「提交证据」接着交。`,
  "too-many-images": `一次最多 ${MAX_IMAGES} 张图。先点「全部提交」把这些交上去，再点「提交证据」接着交。`,
  "image-too-big": "这张图太大了（超过 10MB）。请截图后再发，或者压缩一下。",
  "not-image": "这个文件不是图片。只能收 JPG、PNG、WEBP 图片。",
  "daily-limit": "你今天发的图片太多了，明天再来。文字和链接不受影响。",
  "store-full": "服务器的证据存储暂时满了，图片现在收不了。文字和链接照常可以发。我们会尽快处理。",
  "download-failed": "这张图没收到，请再发一次。",
  "store-off": "图片功能暂时没开。请用文字把截图里的内容写下来发给我，或者把截图传到网盘、发链接。",
};

/// 放在每个「请提交证据」提示里的那段话。
export const EVIDENCE_HOWTO =
  "可以发：\n" +
  "· 文字（什么时间、发生了什么、对方怎么说的）\n" +
  "· 图片（聊天截图、付款截图、物流截图，直接在这里发）\n" +
  "· 链接\n" +
  "想发几条发几条，发完点「全部提交」，只需要签名 1 次。\n\n" +
  "⚠️ 交上去的内容会公开给仲裁的人看，并且永久保存、不能删改。不要发密码、身份证、银行卡号。";
