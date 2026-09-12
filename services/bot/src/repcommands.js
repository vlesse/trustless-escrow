import { ethers } from "ethers";
import { esc, sendMessage } from "./telegram.js";
import * as session from "./session.js";
import * as rep from "./reputation.js";
import { makeProvider, tokenInfo, fmtAmount } from "./deals.js";
import { buildBondFlow, buildBondAction, buildRecord } from "./txlink.js";
import { sendTxs } from "./commands.js";

/// 信誉层的命令。与交易命令分开成一个模块，是因为信誉是**可选层**：
/// 没接信誉合约时整个模块只会回一句「未接入」，交易功能完全不受影响。

const provider = makeProvider();

function unavailable(chatId) {
  return sendMessage(chatId, esc("本机器人未接入信誉层。担保交易功能不受影响。"));
}

async function ctx() {
  const token = await rep.settlementToken(provider);
  return { token, info: await tokenInfo(token, provider) };
}

// ------------------------------------------------------------------ /rep

export async function cmdRep(chatId, userId, arg) {
  if (!rep.enabled()) return unavailable(chatId);

  const target = arg || session.user(userId).address;
  if (!target) {
    await sendMessage(chatId, esc("用法：/rep <地址>，或先 /bind 绑定自己的地址。"));
    return;
  }
  if (!ethers.isAddress(target)) {
    await sendMessage(chatId, esc("这不是一个合法的地址。"));
    return;
  }

  const { token, info } = await ctx();
  const p = await rep.loadProfile(target, token, provider);

  const lines = [
    `*信誉记录* \`${esc(ethers.getAddress(target))}\``,
    "",
    `成交 ${p.completed + p.disputesWon} 笔 · 对手方 ${p.counterparties} 个`,
    `身份年龄 ${esc(rep.ageLabel(p))} · 押金 ${esc(fmtAmount(p.committed, info))}`,
    `败诉 ${p.disputesLost} · 未交付 ${p.nonDelivery} · 未认定过错 ${p.disputesInconclusive}`,
    `累计成交额 ${esc(fmtAmount(p.volume, info))}`,
  ];

  const fl = rep.flags(p);
  if (fl.length) lines.push("", ...fl.map((f) => `${f.level === "danger" ? "🔴" : "⚠️"} ${esc(f.text)}`));

  lines.push(
    "",
    esc("这里只有事实，没有评分 —— 评分会随骗术演化而过时，所以判断留给你自己。"),
    esc("要评估一笔具体交易的风险，用 /deal <合约地址>：那里会算出对方骗你能净赚多少。"),
  );

  await sendMessage(chatId, lines.join("\n"));
}

// ------------------------------------------------------------------ /bond

export async function cmdBond(chatId, userId, arg) {
  if (!rep.enabled()) return unavailable(chatId);

  const u = session.user(userId);
  if (!u.address) {
    await sendMessage(chatId, esc("请先 /bind 绑定钱包。"));
    return;
  }

  const { token, info } = await ctx();

  if (!arg) {
    const p = await rep.loadProfile(u.address, token, provider);
    await sendMessage(chatId, [
      "*你的身份押金*",
      `金额 ${esc(fmtAmount(p.bondAmount, info))} · 年龄 ${esc(rep.ageLabel(p))}`,
      p.unbondableAt > 0
        ? esc(`⚠️ 撤回公示中，可提取时间 ${new Date(p.unbondableAt * 1000).toISOString()}`)
        : esc("状态：正常承诺中"),
      "",
      esc("用法：/bond <金额>，例如 /bond 500"),
      "",
      "*它不是罚金*",
      esc("没有任何人能罚没这笔钱 —— 合约里根本没有罚没功能，部署者也拿不走。"),
      esc("单笔交易作恶的代价来自托管合约里会被罚没的交易保证金，不是这里。"),
      "",
      "*它买的是年龄*",
      esc("钱可以瞬间凑齐，年龄不行。一个刚建的地址无论押多少，都装不出两年前就在这里。"),
      esc("撤回需公示 14 天，且只能整笔撤回 —— 部分撤回会让「年龄」和「金额」被拆开利用。"),
    ].join("\n"));
    return;
  }

  if (!/^\d+(\.\d+)?$/.test(arg)) {
    await sendMessage(chatId, esc("金额格式不对。例如：/bond 500"));
    return;
  }
  let amount;
  try {
    amount = ethers.parseUnits(arg, info.decimals);
  } catch {
    await sendMessage(chatId, esc("金额精度超过该币种支持的小数位。"));
    return;
  }
  if (amount === 0n) {
    await sendMessage(chatId, esc("金额必须大于 0。"));
    return;
  }

  await sendTxs(chatId, buildBondFlow(token, amount));
}

// ------------------------------------------------------------------ /unbond

export async function cmdUnbond(chatId, userId) {
  if (!rep.enabled()) return unavailable(chatId);

  const u = session.user(userId);
  if (!u.address) {
    await sendMessage(chatId, esc("请先 /bind 绑定钱包。"));
    return;
  }

  const { token } = await ctx();
  const p = await rep.loadProfile(u.address, token, provider);

  if (p.bondAmount === 0n) {
    await sendMessage(chatId, esc("你没有身份押金。"));
    return;
  }

  if (p.unbondableAt === 0) {
    // 三条后果都必须说在签名之前。用户点下去之后，第 2 条会立刻生效。
    await sendMessage(chatId, [
      "*申请撤回身份押金*",
      "",
      esc("请先看清楚三件事："),
      esc("1. 需公示 14 天才能提取，期间任何人都看得到你正在撤回；"),
      esc("2. 公示一开始，对手方看到的「承诺押金」立刻变成 0 —— 谈判中的交易会受影响；"),
      esc("3. 提取后年龄归零。重新押入等于一个全新的身份，历史成交不会跟过来。"),
      "",
      esc("反悔可以用 /unbond 撤销，年龄会保留，但撤销次数会被永久记录。"),
    ].join("\n"));
    await sendTxs(chatId, [buildBondAction("requestUnbond", "申请撤回身份押金")]);
    return;
  }

  if (Math.floor(Date.now() / 1000) >= p.unbondableAt) {
    await sendMessage(chatId, esc("公示期已满。提取后身份年龄归零。"));
    await sendTxs(chatId, [buildBondAction("withdraw", "提取身份押金")]);
    return;
  }

  await sendMessage(
    chatId,
    esc(`公示期未满，可提取时间 ${new Date(p.unbondableAt * 1000).toISOString()}。若要反悔，用下面这笔撤销：`)
  );
  await sendTxs(chatId, [buildBondAction("cancelUnbond", "撤销撤回申请（保留年龄）")]);
}

// ------------------------------------------------------------------ /record

export async function cmdRecord(chatId, userId, addr) {
  if (!rep.enabled()) return unavailable(chatId);
  if (!ethers.isAddress(addr)) {
    await sendMessage(chatId, esc("用法：/record <托管合约地址>，把一笔已结束交易的结果沉淀成双方的公开记录。"));
    return;
  }
  await sendMessage(
    chatId,
    esc("任何人都可以推送记录，包括受害者推送关于骗子的败诉记录 —— 对方没有办法阻止，也没有办法删除。")
  );
  await sendTxs(chatId, [buildRecord(ethers.getAddress(addr))]);
}
