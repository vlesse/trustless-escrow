/// 和解 / 认输的分钱公式。实现在 signing-page/split.js —— 只写那一份，
/// 签名页、机器人、合约测试共用，合约测试拿真实结算结果逐 wei 比对。
/// 这里只是把它接进 ESM。
import { createRequire } from "node:module";
import { State, fmtAmount } from "./deals.js";
import { esc } from "./telegram.js";

const require = createRequire(import.meta.url);
export const { settlementSplit, toBuyerForRefund, refundOf, concedeSplit } =
  require("../../signing-page/split.js");

/// 从一笔交易取出公式要的那几个数
export const splitView = (deal) => ({
  price: deal.price, buyerBond: deal.buyerBond, sellerBond: deal.sellerBond,
  feeBps: deal.feeBps, lockedArbCost: deal.lockedArbCost ?? 0n,
  disputed: deal.state === State.Disputed,
});

/// 一个分钱方案，按收件人的视角说「你 / 对方」各拿多少（MarkdownV2）。
/// /deal、和解确认、推送都用这一份 —— 同一个方案在两处显示得不一样，用户会怀疑哪边是真的。
export function splitLines(s, role, info) {
  const me = role === "buyer" ? "买家" : "卖家";
  const other = role === "buyer" ? "卖家" : "买家";
  const mine = role === "buyer" ? s.toBuyer : s.toSeller;
  const theirs = role === "buyer" ? s.toSeller : s.toBuyer;
  const lines = [
    `你（${me}）拿到：*${esc(fmtAmount(mine, info))}*`,
    `对方（${other}）拿到：*${esc(fmtAmount(theirs, info))}*`,
  ];
  const extra = [];
  if (s.fee > 0n) extra.push(`手续费 ${fmtAmount(s.fee, info)}（从卖家那份里扣）`);
  if (s.cost > 0n) extra.push(`仲裁费 ${fmtAmount(s.cost, info)}`);
  if (extra.length) lines.push(esc(`另外：${extra.join("，")}`));
  return lines;
}
