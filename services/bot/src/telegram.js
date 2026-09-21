import { config } from "./config.js";

const API = `https://api.telegram.org/bot${config.botToken}`;

async function call(method, params = {}) {
  const res = await fetch(`${API}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`Telegram ${method} 失败: ${json.description}`);
  return json.result;
}

/// Telegram 的 MarkdownV2 要求转义一大批字符，漏一个整条消息就发不出去。
/// 地址、金额里天然含有 `-`、`.`、`_`，所以这个函数必须用在每一段动态内容上。
export function esc(text) {
  return String(text).replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => "\\" + c);
}

/**
 * 发消息。MarkdownV2 解析失败时降级为纯文本重发一次。
 *
 * MarkdownV2 里 `.` `-` `(` 这些字符必须转义，漏一个 Telegram 就**整条拒收**。
 * 表现是用户看到一句「出错了，请稍后重试」，而真正的内容一个字都没到 ——
 * 一个排版问题吃掉了全部信息。实测 /deal 就因为「手续费: 1.00%」里那个
 * 小数点整条发不出去。
 *
 * 转义写漏在所难免（它散落在几十处字符串拼接里）。但一个排版 bug 不该让
 * 用户收不到「你的钱已经锁定」这种消息。所以解析失败时去掉 parse_mode
 * 重发：排版是丑的，内容是全的。
 *
 * 同时把它记成 error 而不是默默降级 —— 降级是止血，不是修好。
 */
export async function sendMessage(chatId, text, extra = {}) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "MarkdownV2",
    link_preview_options: { is_disabled: true },
    ...extra,
  };
  try {
    return await call("sendMessage", payload);
  } catch (e) {
    if (!/can't parse entities/i.test(e.message)) throw e;
    console.error("MarkdownV2 转义有误，已降级为纯文本发送（这是 bug，要修）:", e.message);
    const { parse_mode, ...plain } = payload;
    return call("sendMessage", { ...plain, text: unesc(text) });
  }
}

/// 降级时把转义反斜杠去掉，否则纯文本里会满屏 \. \- 更难读
export function unesc(text) {
  return String(text).replace(/\\([_*\[\]()~`>#+\-=|{}.!\\])/g, "$1");
}

export const answerCallback = (id, text, alert = false) =>
  call("answerCallbackQuery", { callback_query_id: id, text, show_alert: alert });

export const deleteMessage = (chatId, messageId) =>
  call("deleteMessage", { chat_id: chatId, message_id: messageId }).catch(() => {});

export const setMyCommands = (commands) => call("setMyCommands", { commands });

export const getMe = () => call("getMe");

/// 行内键盘。每行一组按钮。
export const keyboard = (rows) => ({
  reply_markup: { inline_keyboard: rows },
});

export const btn = (text, data) => ({ text, callback_data: data });
export const urlBtn = (text, url) => ({ text, url });

/// 长轮询。返回一个异步迭代器，逐条吐出 update。
export async function* updates() {
  let offset = 0;
  for (;;) {
    let batch;
    try {
      batch = await call("getUpdates", {
        offset,
        timeout: config.pollTimeoutSec,
        // my_chat_member：机器人被拉进/踢出某个群时的通知。
        // 要它是为了在被加进群的那一刻就把 chat_id 记进日志 ——
        // 私有群的 id 无法从邀请链接反查，而临时停机去 getUpdates 捞一次
        // 每换一次群就要重来一遍。
        allowed_updates: ["message", "callback_query", "my_chat_member"],
      });
    } catch (e) {
      console.error("拉取更新失败，5 秒后重试:", e.message);
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    for (const u of batch) {
      offset = u.update_id + 1;
      yield u;
    }
  }
}
