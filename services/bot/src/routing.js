/**
 * 一条消息该怎么处理：执行、劝去私聊、还是干脆不理。
 *
 * 抽成纯函数是因为这几条判断错一个，后果都不是报错而是别的东西：
 *   群里不该回的回了 → 机器人对每条闲聊都回一句「发送 /help」，群直接没法用；
 *   群里不该收流程输入却收了 → 用户的一句闲聊变成了交易条款；
 *   私聊里误判成群 → 整个产品不能用。
 * 这三件事都只能靠测试钉住，因为它们在开发者自己试的时候都不会发生。
 */

/**
 * 只能在私聊里用的命令。
 *
 * 三个理由，从轻到重：
 *
 * 1. 这些命令会打出地址、余额、交易列表。在群里等于替用户公开持仓。
 * 2. 绑定和开单是**多步流程**，中途每一条普通发言都会被当成流程输入。
 * 3. 在群里完成绑定，等于当众把一个 Telegram 账号和一个链上地址钉死在一起。
 *    这条关联一旦公开就收不回来了。
 *
 * /deal 和 /rep 留在群里：查一笔公开交易、查一个对手方的公开记录，
 * 本来就是买卖双方该当着面一起看的东西。
 */
export const PRIVATE_ONLY = new Set([
  "/bind", "/whoami", "/new", "/deals",
  "/bond", "/unbond", "/record", "/quota", "/unquota",
]);

/**
 * @returns {{action:"command",command:string,args:string[]}
 *          |{action:"private-only",command:string}
 *          |{action:"flow"}
 *          |{action:"hint"}
 *          |{action:"ignore"}}
 */
export function route({ chatType, text, hasFlow }) {
  const isPrivate = chatType === "private";

  if (text.startsWith("/")) {
    const [raw, ...args] = text.split(/\s+/);
    const command = raw.split("@")[0];          // 群里会带 @botname
    if (!isPrivate && PRIVATE_ONLY.has(command)) return { action: "private-only", command };
    return { action: "command", command, args };
  }

  // 流程输入只在私聊里收。群里的普通发言是聊天，不是在回答机器人的问题。
  if (isPrivate && hasFlow) return { action: "flow" };

  // 群里的普通消息一律不回：机器人在群里是为了广播和查询，不是参与聊天。
  if (!isPrivate) return { action: "ignore" };

  return { action: "hint" };
}
