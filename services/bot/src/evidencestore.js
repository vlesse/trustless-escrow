/// 证据文件的落盘与读取。
///
/// **防刷的关键不在这里的限额，而在于根本没有上传入口。** 服务器不开放任何
/// 公开的上传接口：图片只能通过 Telegram 发给机器人，由机器人自己去 Telegram
/// 下载。而机器人只在「提交证据」流程里收图 —— 进入这个流程要求你是某笔
/// 验收中/争议中交易的买方或卖方。一个脚本想刷爆硬盘，得先真金白银开单、入金。
///
/// 在这之上再加几道限额，挡住「一个真实用户手滑」或「一个真实用户故意」：
///   单张 10MB、每次提交 10 张、每人每天 60 张、整个存储上限（默认 2GB）。
///
/// 文件名 = 内容的 SHA-256。同一张图发一百次只存一份；任何人拿到文件都能
/// 自己算哈希，核对它和链上记录的是不是同一份。

import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import * as session from "./session.js";
import { sha256Hex, sniffImage } from "./evidence.js";
import { getFile, downloadFile } from "./telegram.js";

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const DAILY_IMAGES = 60;

export const enabled = () => Boolean(config.evidenceDir && config.evidenceBaseUrl);
export const bundleBase = () => config.evidenceBaseUrl.replace(/\/$/, "");
export const bundleUrl = (sha) => `${bundleBase()}/${sha}.json`;
export const fileUrl = (sha, ext) => `${bundleBase()}/${sha}.${ext}`;
/// 给人看的页面：会自己核对哈希，并把文字和图片摆出来。
export const viewerUrl = (sha) => `${config.signingPageUrl.replace(/\/$/, "")}/evidence.html#${sha}`;

function dirBytes() {
  let total = 0;
  for (const f of fs.readdirSync(config.evidenceDir)) {
    try { total += fs.statSync(path.join(config.evidenceDir, f)).size; } catch { /* 并发删掉了 */ }
  }
  return total;
}

/// 先写临时文件再改名：进程在写到一半时被杀，也不会留下半截文件顶着一个正确的哈希名。
function writeOnce(name, buf) {
  const final = path.join(config.evidenceDir, name);
  if (fs.existsSync(final)) return;
  const tmp = final + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, buf, { mode: 0o644 });
  fs.renameSync(tmp, final);
}

function takeDailySlot(userId) {
  const u = session.user(userId);
  const today = new Date().toISOString().slice(0, 10);
  if (u.evImg?.day !== today) u.evImg = { day: today, n: 0 };
  if (u.evImg.n >= DAILY_IMAGES) return false;
  u.evImg.n++;
  session.save();
  return true;
}

/**
 * 从 Telegram 下载一张图并存下来。
 * @returns {Promise<{ok: true, item: object} | {ok: false, reason: string}>}
 */
export async function saveTelegramImage(userId, { fileId, fileSize }) {
  if (!enabled()) return { ok: false, reason: "store-off" };
  if (fileSize && fileSize > MAX_FILE_BYTES) return { ok: false, reason: "image-too-big" };
  if (dirBytes() + (fileSize || MAX_FILE_BYTES) > config.evidenceMaxBytes) return { ok: false, reason: "store-full" };
  if (!takeDailySlot(userId)) return { ok: false, reason: "daily-limit" };

  let buf;
  try {
    const f = await getFile(fileId);
    if (f.file_size && f.file_size > MAX_FILE_BYTES) return { ok: false, reason: "image-too-big" };
    buf = await downloadFile(f.file_path, MAX_FILE_BYTES);
  } catch (e) {
    console.error("下载证据图片失败:", e.message);
    return { ok: false, reason: e.code === "TOO_BIG" ? "image-too-big" : "download-failed" };
  }

  const ext = sniffImage(buf);
  if (!ext) return { ok: false, reason: "not-image" };
  const sha256 = sha256Hex(buf);
  writeOnce(`${sha256}.${ext}`, buf);
  return { ok: true, item: { type: "image", sha256, ext, bytes: buf.length } };
}

export function saveBundle({ json, sha256 }) {
  writeOnce(`${sha256}.json`, Buffer.from(json, "utf8"));
  return bundleUrl(sha256);
}

/// 读回一个证据包，并**重算哈希**核对。对不上就当不存在 —— 宁可说「看不到」，
/// 也不能把一份被改过的内容当成链上那份展示给人。
export function readBundle(sha256) {
  if (!enabled() || !/^[0-9a-f]{64}$/.test(sha256)) return null;
  try {
    const buf = fs.readFileSync(path.join(config.evidenceDir, `${sha256}.json`));
    if (sha256Hex(buf) !== sha256) return null;
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return null;
  }
}
