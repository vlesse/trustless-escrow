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

export const sendMessage = (chatId, text, extra = {}) =>
  call("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "MarkdownV2",
    link_preview_options: { is_disabled: true },
    ...extra,
  });

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
        allowed_updates: ["message", "callback_query"],
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
