import { config, describeConfig } from "./config.js";
import { updates, sendMessage, answerCallback, setMyCommands, getMe, esc } from "./telegram.js";
import * as session from "./session.js";
import { scanForSecrets, secretWarning } from "./secrets.js";
import * as cmd from "./commands.js";
import * as repcmd from "./repcommands.js";
import * as quotacmd from "./quotacommands.js";
import { start as startWatcher } from "./watcher.js";
import { route } from "./routing.js";

/// 日志只打用户 ID 和命令名。**永远不打消息内容** ——
/// 用户可能在任意一条消息里粘贴私钥或助记词。
const log = (...a) => console.log(new Date().toISOString(), ...a);

/// 机器人自己的用户名，用来生成「来私聊」的深链。main() 里填。
let botUsername = "";


async function onMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text ?? "";
  const isPrivate = msg.chat.type === "private";

  if (!session.rateLimit(userId)) {
    await sendMessage(chatId, esc("操作太频繁了，请稍后再试。"));
    return;
  }

  // 私钥/助记词防护要放在一切处理之前。
  // 即便用户正处在某个流程中间，也必须先拦下来告警 ——
  // 这条消息的内容绝不进入任何后续处理或存储。
  const secret = scanForSecrets(text, { expectTxHash: cmd.flowExpectsTxHash(userId) });
  if (secret) {
    log(`user=${userId} 检测到疑似密钥泄露 kind=${secret.kind}`);
    await sendMessage(chatId, secretWarning(secret.kind));
    return;
  }

  const r = route({ chatType: msg.chat.type, text, hasFlow: cmd.hasFlow(userId) });

  if (r.action === "ignore") return;

  if (r.action === "private-only") {
    const deep = botUsername ? `https://t.me/${botUsername}?start=1` : null;
    log(`user=${userId} cmd=${r.command} 群里拒绝`);
    return sendMessage(chatId, [
      esc(`${r.command} 只能在私聊里用。`),
      "",
      esc("它会打出你的地址和交易，在群里等于替你公开持仓；而且绑定和开单是多步流程，"),
      esc("群里的每一条发言都会被当成流程输入。"),
      deep ? `\n[👉 点这里私聊我](${deep})` : "",
    ].join("\n"));
  }

  if (r.action === "flow") {
    log(`user=${userId} flow-input`);
    return cmd.handleFlowInput(chatId, userId, text);
  }

  if (r.action === "hint") {
    return sendMessage(chatId, esc("发送 /help 查看可用命令。"));
  }

  const { command, args } = r;
  log(`user=${userId} cmd=${command} private=${isPrivate}`);

  switch (command) {
    case "/start": return cmd.cmdStart(chatId);
    case "/help": return cmd.cmdHelp(chatId);
    case "/bind": return cmd.cmdBind(chatId, userId, args[0] ?? "");
    case "/whoami": return cmd.cmdWhoami(chatId, userId);
    case "/new": return cmd.cmdNew(chatId, userId);
    case "/deals": return cmd.cmdDeals(chatId, userId);
    case "/deal": return cmd.cmdDeal(chatId, userId, args[0] ?? "");
    case "/rep": return repcmd.cmdRep(chatId, userId, args[0] ?? "");
    case "/bond": return repcmd.cmdBond(chatId, userId, args[0] ?? "");
    case "/unbond": return repcmd.cmdUnbond(chatId, userId);
    case "/record": return repcmd.cmdRecord(chatId, userId, args[0] ?? "");
    case "/quota": return quotacmd.cmdQuota(chatId, userId, args[0] ?? "", args[1] ?? "");
    case "/unquota": return quotacmd.cmdUnquota(chatId, userId, args[0] ?? "");
    case "/cancel":
      session.clearFlow(userId);
      return sendMessage(chatId, esc("已退出当前流程。"));
    default:
      return sendMessage(chatId, esc("未知命令。/help 查看全部命令。"));
  }
}

async function onCallback(q) {
  const chatId = q.message.chat.id;
  const userId = q.from.id;
  const data = q.data ?? "";

  if (!session.rateLimit(userId)) {
    await answerCallback(q.id, "操作太频繁，请稍后再试", true);
    return;
  }

  log(`user=${userId} callback=${data.split(":").slice(0, 2).join(":")}`);
  await answerCallback(q.id, "");

  const [kind, a, b] = data.split(":");
  if (kind === "new" && a === "role") {
    return cmd.handleFlowInput(chatId, userId, b);
  }
  if (kind === "deal") {
    return cmd.cmdDeal(chatId, userId, a);
  }
  if (kind === "act") {
    return cmd.runAction(chatId, userId, a, b);
  }
}

async function main() {
  console.log("Trustless Escrow · Telegram 前端");
  console.log(describeConfig());
  console.log();

  session.load();

  const me = await getMe();
  botUsername = me.username;
  log(`已连接 @${me.username}`);

  await setMyCommands([
    { command: "bind", description: "绑定钱包地址" },
    { command: "new", description: "发起担保交易" },
    { command: "deals", description: "我的交易" },
    { command: "deal", description: "查看某笔交易" },
    { command: "rep", description: "查看信誉记录" },
    { command: "bond", description: "身份押金" },
    { command: "whoami", description: "当前绑定的地址" },
    { command: "cancel", description: "退出当前流程" },
    { command: "help", description: "使用说明" },
  ]);

  // 事件推送与消息处理互不阻塞：监听出问题不应当让机器人整个失灵
  startWatcher((chatId, text) => sendMessage(chatId, text)).catch((e) =>
    log(`事件监听启动失败（机器人其余功能不受影响）: ${e.message}`)
  );

  log("开始接收消息");
  /*
   * 群/频道的 chat_id 记一行日志。
   *
   * 私有群的 id 没法从邀请链接反查，而 getUpdates 又和机器人自己的长轮询
   * 互斥（并发会被 Telegram 用 409 顶掉）。结果是：要配一个广播群，
   * 就得先把机器人停掉去捞一次 id —— 这件事每换一次群都要重来一遍。
   *
   * 记一行就解决了。每个群只记一次，不会刷屏。
   */
  const seenChats = new Set();
  const noteChat = (chat) => {
    if (!chat || chat.type === "private" || seenChats.has(chat.id)) return;
    seenChats.add(chat.id);
    log(`收到来自${chat.type === "channel" ? "频道" : "群"}「${chat.title ?? "?"}」的消息，` +
      `chat_id=${chat.id}${chat.username ? " (@" + chat.username + ")" : ""}` +
      ` —— 要让它接收抽选预警广播，把这个值填进 ALERT_CHAT_ID`);
  };

  for await (const u of updates()) {
    try {
      noteChat(u.message?.chat ?? u.my_chat_member?.chat ?? u.channel_post?.chat);
      if (u.message) await onMessage(u.message);
      else if (u.callback_query) await onCallback(u.callback_query);
    } catch (e) {
      // 不要把异常细节回显给用户 —— 可能含有地址、内部路径等信息
      log(`处理更新失败: ${e.message}`);
      const chatId = u.message?.chat.id ?? u.callback_query?.message.chat.id;
      if (chatId) {
        await sendMessage(chatId, esc("出错了，请稍后重试。如果反复出现，请用 /cancel 重置当前流程。")).catch(() => {});
      }
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
