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
/// 连续失败多少次就退出重启。5 秒一次，12 次约一分钟 ——
/// 短暂网络抖动挺得过去，真正坏死的连接状态一分钟内就会被换掉。
const MAX_CONSECUTIVE_FAILS = Number(process.env.MAX_POLL_FAILS ?? 12);

export async function* updates() {
  let offset = 0;
  let fails = 0;
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
      fails++;
      console.error(`拉取更新失败（连续第 ${fails} 次），5 秒后重试:`, e.message);

      /*
       * 连续失败够多次就退出，让 systemd 重启一个全新进程。
       *
       * 原来是无限重试。实测机器人卡在这里连续失败 165 次、整整五天收不到
       * 任何消息，而 systemd 一直显示 active —— 因为进程从来没死过，
       * Restart=always 也就从来没机会生效。服务「活着」而产品是死的。
       *
       * 根因在进程内部：同一时刻新起一个 node 进程 fetch 立刻成功，
       * 老进程却怎么也好不了（这台机器 IPv6 不通，undici 的连接池大概率
       * 把连接钉死在了 v6 上）。这类状态只有换进程能清掉，重试多少次都没用。
       *
       * 退出不是放弃：退出才是唯一能自愈的动作。
       */
      if (fails >= MAX_CONSECUTIVE_FAILS) {
        console.error(
          `连续 ${fails} 次拉取失败，退出让 systemd 重启 —— ` +
          "进程内的连接状态坏掉之后，重试多少次都不会好，换个进程才会。");
        process.exit(1);
      }
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    fails = 0;
    for (const u of batch) {
      offset = u.update_id + 1;
      yield u;
    }
  }
}
