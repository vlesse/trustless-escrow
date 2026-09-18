import { config, describeConfig } from "./config.js";
import { updates, sendMessage, answerCallback, setMyCommands, getMe, esc } from "./telegram.js";
import * as session from "./session.js";
import { scanForSecrets, secretWarning } from "./secrets.js";
import * as cmd from "./commands.js";
import * as repcmd from "./repcommands.js";
import * as quotacmd from "./quotacommands.js";
import { start as startWatcher } from "./watcher.js";

/// 日志只打用户 ID 和命令名。**永远不打消息内容** ——
/// 用户可能在任意一条消息里粘贴私钥或助记词。
const log = (...a) => console.log(new Date().toISOString(), ...a);

async function onMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text ?? "";

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

  if (text.startsWith("/")) {
    const [raw, ...args] = text.split(/\s+/);
    const command = raw.split("@")[0];
    log(`user=${userId} cmd=${command}`);

    switch (command) {
      case "/start": return cmd.cmdStart(chatId);
      case "/help": return cmd.cmdHelp(chatId);
      case "/bind": return cmd.cmdBind(chatId, userId);
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

  if (cmd.hasFlow(userId)) {
    log(`user=${userId} flow-input`);
    return cmd.handleFlowInput(chatId, userId, text);
  }

  await sendMessage(chatId, esc("发送 /help 查看可用命令。"));
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
  for await (const u of updates()) {
    try {
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
