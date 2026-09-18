/// /quota 相关命令。
///
/// 单独成一个模块，与信誉层同一个理由：额度池是可选的，
/// 没接入时这里只回一句话，主流程的代码里不该散落 if (配置了吗)。
import { ethers } from "ethers";
import { esc, sendMessage } from "./telegram.js";
import * as session from "./session.js";
import { makeProvider, fmtAmount } from "./deals.js";
import { sendTxs } from "./commands.js";
import { buildQuotaDeposit, buildQuotaWithdraw } from "./txlink.js";
import * as quota from "./quota.js";

const provider = makeProvider();

const unavailable = (chatId) =>
  sendMessage(chatId, esc("本机器人未接入商家额度池。担保交易功能不受影响，卖家照常用钱包入金。"));

const needBind = (chatId) =>
  sendMessage(chatId, esc("请先 /bind 绑定你的钱包地址。"));

/// /quota            查看额度
/// /quota 500        存入 500
/// /quota 500 3      存入 500，并按每单保证金 3 换算还能接几单
export async function cmdQuota(chatId, userId, arg, bondArg) {
  if (!quota.enabled()) return unavailable(chatId);
  const u = session.user(userId);
  if (!u.address) return needBind(chatId);

  const q = await quota.loadQuota(u.address, provider);

  if (!arg) {
    let bond = 0n;
    if (bondArg) {
      try { bond = ethers.parseUnits(bondArg, q.info.decimals); } catch { bond = 0n; }
    }
    await sendMessage(chatId, quota.renderQuota({ balance: q.balance, info: q.info, bond }));

    if (!(await quota.poolMatchesFactory(provider))) {
      await sendMessage(chatId, [
        "⚠️ *这个额度池没有被工厂认可*",
        "",
        esc("存进去的钱取得回来，但每一次用额度付款都会失败 —— "),
        esc("托管合约只认创建交易时写死的那个代付方地址。"),
        esc("这是部署配置的问题，请联系运营方，在修好之前不要往里存钱。"),
      ].join("\n"));
    }
    return;
  }

  let amount;
  try {
    amount = ethers.parseUnits(arg, q.info.decimals);
  } catch {
    return sendMessage(chatId, esc("金额格式不对。用法：/quota 500"));
  }
  if (amount <= 0n) return sendMessage(chatId, esc("金额必须大于 0。"));

  await sendMessage(chatId,
    `即将存入额度 *${esc(fmtAmount(amount, q.info))}*\n\n` +
    esc("需要两笔交易：先授权额度池划转，再存入。存进去的钱随时可以全额取回。"));
  await sendTxs(chatId, buildQuotaDeposit(q.token, q.pool, amount));
}

/// /unquota 200      取回 200
export async function cmdUnquota(chatId, userId, arg) {
  if (!quota.enabled()) return unavailable(chatId);
  const u = session.user(userId);
  if (!u.address) return needBind(chatId);

  const q = await quota.loadQuota(u.address, provider);
  if (q.balance === 0n) return sendMessage(chatId, esc("你在额度池里没有余额。"));

  let amount = q.balance;
  if (arg) {
    try {
      amount = ethers.parseUnits(arg, q.info.decimals);
    } catch {
      return sendMessage(chatId, esc("金额格式不对。用法：/unquota 200，或 /unquota 取回全部。"));
    }
  }
  if (amount <= 0n || amount > q.balance) {
    return sendMessage(chatId,
      esc(`可取回的额度是 ${fmtAmount(q.balance, q.info)}，请填一个不超过它的金额。`));
  }

  await sendMessage(chatId,
    `即将取回 *${esc(fmtAmount(amount, q.info))}*\n\n` +
    esc("额度取回后不影响任何已经入金的交易 —— 那些钱早就在各自的托管合约里了。"));
  await sendTxs(chatId, [buildQuotaWithdraw(q.pool, amount)]);
}

/// 给买家看的：这个商家还接得动几单。
export async function merchantCapacity(sellerAddr, bond, provider_ = provider) {
  if (!quota.enabled()) return null;
  try {
    const q = await quota.loadQuota(sellerAddr, provider_);
    if (q.balance === 0n) return null;
    return { balance: q.balance, info: q.info, left: bond > 0n ? q.balance / bond : null };
  } catch {
    return null;
  }
}

/// 卖家在某笔交易上能不能走额度付款。
export async function dealFundability(dealAddr, userAddr) {
  if (!quota.enabled()) return { ok: false, why: "disabled" };
  try {
    const e = new ethers.Contract(dealAddr, quota.ESCROW_QUOTA_ABI, provider);
    const [bondPayer, sellerBond] = await Promise.all([e.bondPayer(), e.sellerBond()]);
    const q = await quota.loadQuota(userAddr, provider);
    return { ...quota.fundability({ bondPayer, sellerBond, balance: q.balance }), info: q.info, pool: q.pool };
  } catch {
    return { ok: false, why: "error" };
  }
}
