import fs from "node:fs";
import { config } from "./config.js";

/// 每用户会话状态。
///
/// 刻意只存最小必要信息：绑定的地址、进行中的向导步骤、条款草稿。
/// **绝不存储消息原文** —— 用户可能在任意一条消息里粘贴私钥或助记词，
/// 一旦落盘，这个状态文件就成了一个高价值攻击目标。
/// 同理，日志里也只打 Telegram 用户 ID 和命令名，不打内容。

let state = { users: {}, notified: {}, watchCursor: 0 };

export function load() {
  try {
    state = JSON.parse(fs.readFileSync(config.stateFile, "utf8"));
    state.users ??= {};
    state.notified ??= {};
    state.watchCursor ??= 0;
  } catch {
    state = { users: {}, notified: {}, watchCursor: 0 };
  }
  return state;
}

let saveTimer = null;
export function save() {
  // 合并短时间内的多次写入，避免每条消息都落一次盘
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.writeFileSync(config.stateFile, JSON.stringify(state, null, 2));
    } catch (e) {
      console.error("状态保存失败:", e.message);
    }
  }, 500);
}

export function user(id) {
  const key = String(id);
  state.users[key] ??= { address: null, flow: null, draft: {}, rate: [] };
  return state.users[key];
}

export function setFlow(id, flow, draft = {}) {
  const u = user(id);
  u.flow = flow;
  u.draft = draft;
  save();
  return u;
}

export function clearFlow(id) {
  const u = user(id);
  u.flow = null;
  u.draft = {};
  save();
}

/// 滑动窗口限流。
/// 机器人每条消息都可能触发若干次 RPC 调用和链上读取，
/// 不限流的话单个用户就能把 RPC 配额打光，让所有人都用不了。
export function rateLimit(id) {
  const u = user(id);
  const now = Date.now();
  u.rate = (u.rate ?? []).filter((t) => now - t < 60_000);
  if (u.rate.length >= config.rateLimitPerMin) return false;
  u.rate.push(now);
  save();
  return true;
}

/// 通知去重：同一笔交易的同一个状态变化只推送一次。
/// 兜底扫描会反复看到同样的链上状态，没有这个就会疯狂重复推送。
export function alreadyNotified(key) {
  if (state.notified[key]) return true;
  state.notified[key] = Date.now();
  save();
  return false;
}

/// 谁绑定了这个地址 —— 用于把链上事件推送给对应的 Telegram 用户
export function findUsersByAddress(address) {
  const a = address.toLowerCase();
  return Object.entries(state.users)
    .filter(([, u]) => u.address && u.address.toLowerCase() === a)
    .map(([id]) => id);
}

export const allUsers = () => state.users;

/**
 * 事件监听扫到哪个区块了。
 *
 * 必须落盘。不落盘的话每次重启都从 WATCH_FROM_BLOCK 重扫，而公共节点
 * 只保留最近约 5 万个区块的日志（BSC 上不到 7 小时）—— 重启一次就永远
 * 卡在一个已经被裁剪掉的位置上，每轮都在同一处失败。
 */
export const watchCursor = () => state.watchCursor || 0;
export function setWatchCursor(n) {
  if (n > (state.watchCursor || 0)) {
    state.watchCursor = n;
    save();
  }
}
