/**
 * 群成员真人验证。
 *
 * TG 群里广告号进来就会发广告。进群默认禁言，点一下按钮（或先去私聊 /start）
 * 再永久放开。点按钮证明的是「这个客户端能点 UI」，拦不住所有假人，
 * 但能挡住绝大多数不会点按钮的广播号。
 *
 * 验证通过之前不在群里 @ 他做介绍 —— 否则广告号也白嫖曝光。
 */
import { config } from "./config.js";
import {
  sendMessage, answerCallback, deleteMessage, keyboard, btn, urlBtn, esc,
  restrictChatMember, getChatMember,
} from "./telegram.js";
import * as session from "./session.js";

export const MUTED = {
  can_send_messages: false,
  can_send_audios: false,
  can_send_documents: false,
  can_send_photos: false,
  can_send_videos: false,
  can_send_video_notes: false,
  can_send_voice_notes: false,
  can_send_polls: false,
  can_send_other_messages: false,
  can_add_web_page_previews: false,
  can_change_info: false,
  can_invite_users: false,
  can_pin_messages: false,
};

export const OPEN = {
  can_send_messages: true,
  can_send_audios: true,
  can_send_documents: true,
  can_send_photos: true,
  can_send_videos: true,
  can_send_video_notes: true,
  can_send_voice_notes: true,
  can_send_polls: true,
  can_send_other_messages: true,
  can_add_web_page_previews: true,
  can_change_info: false,
  can_invite_users: true,
  can_pin_messages: false,
};

let botUsername = "";
export function setBotUsername(name) {
  botUsername = name || "";
}

export function displayName(user) {
  const n = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return n || "新成员";
}

/// MarkdownV2 文本提及。没有用户名的人也能点到。
export function mentionMd(user) {
  return `[${esc(displayName(user))}](tg://user?id=${user.id})`;
}

function isStaff(member) {
  return member && (member.status === "creator" || member.status === "administrator");
}

function introKeyboard() {
  const rows = [];
  if (botUsername) rows.push([urlBtn("👉 私聊我，开始绑定 / 开单", `https://t.me/${botUsername}?start=1`)]);
  if (config.siteUrl) rows.push([urlBtn("查看公示站", config.siteUrl)]);
  return rows.length ? keyboard(rows) : {};
}

export async function cmdGroupWelcome(chatId, user) {
  await sendMessage(chatId, [
    `${mentionMd(user)} ` + esc("验证过了，欢迎。"),
    "",
    esc("钱锁在链上合约里，运营方拿不走。开单、绑定钱包、看自己的交易，请点下面私聊我。"),
    esc("群里做这些等于公开你的地址。"),
    "",
    esc("群里可以直接用："),
    esc("/deal <合约地址>  当面核对一笔交易"),
    esc("/rep <地址>       看公开信誉"),
    esc("/help             完整说明"),
  ].join("\n"), introKeyboard());
}

export async function handleJoin(msg) {
  const chatId = msg.chat.id;
  const members = msg.new_chat_members ?? [];
  for (const m of members) {
    try {
      await admitOrChallenge(chatId, m);
    } catch (e) {
      console.error("进群验证失败 user=" + m.id + ":", e.message);
    }
  }
}

export async function admitOrChallenge(chatId, user) {
  if (user.is_bot) return;

  const member = await getChatMember(chatId, user.id).catch(() => null);
  if (isStaff(member)) {
    await cmdGroupWelcome(chatId, user);
    return;
  }
  if (session.isVerified(user.id)) {
    await restrictChatMember(chatId, user.id, OPEN).catch(() => {});
    await cmdGroupWelcome(chatId, user);
    return;
  }

  try {
    await restrictChatMember(chatId, user.id, MUTED);
  } catch (e) {
    console.error("无法禁言 user=" + user.id + "（需要「限制成员」权限）: " + e.message);
  }

  const deep = botUsername ? `https://t.me/${botUsername}?start=1` : "";
  const rows = [[btn("我是真人，点这里发言", `verify:${user.id}`)]];
  if (deep) rows.push([urlBtn("或私聊机器人完成验证", deep)]);

  const sent = await sendMessage(chatId, [
    `${mentionMd(user)} ` + esc("先点下面证明你是真人，通过后才能在群里发言。"),
    esc("广告号请回。点按钮大约两秒；私聊 /start 也能解禁。"),
  ].join("\n"), keyboard(rows));
  if (sent?.message_id) session.setPendingGate(chatId, user.id, sent.message_id);
}

export async function onVerifyCallback(q) {
  const chatId = q.message.chat.id;
  const clicker = q.from.id;
  const target = Number((q.data ?? "").split(":")[1]);
  if (!target || clicker !== target) {
    await answerCallback(q.id, "这是别人的验证，点你自己那条。", true);
    return;
  }

  try {
    await restrictChatMember(chatId, clicker, OPEN);
  } catch (e) {
    await answerCallback(q.id, "解禁失败，请群管理看一下机器人是否有「限制成员」权限。", true);
    console.error("解禁失败 user=" + clicker + ":", e.message);
    return;
  }
  session.markVerified(clicker);
  session.clearPendingGate(chatId, clicker);
  await answerCallback(q.id, "已通过，可以发言了");
  await deleteMessage(chatId, q.message.message_id);
  await cmdGroupWelcome(chatId, q.from);
}

/// 私聊 /start 作为退路：进群没点到按钮、又找到了官方机器人，也算过关。
export async function liftOnPrivateStart(userId, user) {
  const chatId = config.groupChatId;
  session.markVerified(userId);
  if (!chatId) return;

  const member = await getChatMember(chatId, userId).catch(() => null);
  if (!member || member.status === "left" || member.status === "kicked") return;

  const muted = member.status === "restricted" && member.can_send_messages === false;
  if (muted) {
    await restrictChatMember(chatId, userId, OPEN).catch((e) => {
      console.error("私聊解禁失败 user=" + userId + ":", e.message);
    });
  }
  if (muted) {
    const pending = session.pendingGate(chatId, userId);
    if (pending?.messageId) await deleteMessage(chatId, pending.messageId);
    session.clearPendingGate(chatId, userId);
    await cmdGroupWelcome(chatId, user);
  }
}
