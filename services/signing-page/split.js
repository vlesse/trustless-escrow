/*
 * 和解与认输的分钱公式。**只写这一份**，三处共用：
 *   · 签名页（浏览器里直接加载）
 *   · 机器人（Node 里 require 进去）
 *   · 合约测试（拿真实合约的结算结果逐个比对，见 test/settlement.test.js）
 *
 * 为什么非得共用：用户签名之前看到的「你拿多少、对方拿多少」，必须和链上
 * 实际分出去的一个 wei 都不差。前端自己再写一遍公式，迟早会和合约对不上 ——
 * 对不上的时候，用户签下的就是一个他没看到过的结果。
 *
 * 公式与 contracts/Escrow.sol 的 acceptSettlement / _applyRuling 逐行对应。
 * 全部用 BigInt，不碰浮点数。
 */
(function (root) {
  "use strict";

  const RULING_BUYER = 1n;
  const RULING_SELLER = 2n;

  /// 和解：买家拿 toBuyer，其余归卖家；卖家那份按「实际从买家拿到的货款」收手续费。
  /// deal: { price, buyerBond, sellerBond, feeBps, lockedArbCost, disputed }
  /// 返回 null 表示这个金额超出可分配的总额（合约会拒绝）。
  function settlementSplit(deal, toBuyer) {
    const price = BigInt(deal.price), bb = BigInt(deal.buyerBond), sb = BigInt(deal.sellerBond);
    const cost = deal.disputed ? BigInt(deal.lockedArbCost) : 0n;
    const pool = price + bb + sb - cost;
    toBuyer = BigInt(toBuyer);
    if (toBuyer < 0n || toBuyer > pool) return null;
    const sellerGross = pool - toBuyer;
    let gain = sellerGross > sb ? sellerGross - sb : 0n;
    if (gain > price) gain = price;
    const fee = (gain * BigInt(deal.feeBps)) / 10000n;
    return { pool, cost, toBuyer, toSeller: sellerGross - fee, fee };
  }

  /// 「货款退给买家多少」→ 合约要的 toBuyer。
  /// 押金各自退回；争议中的仲裁费两边各出一半（奇数时卖家多出 1 wei，与合约的平局拆分同一口径）。
  function toBuyerForRefund(deal, refund) {
    const cost = deal.disputed ? BigInt(deal.lockedArbCost) : 0n;
    return BigInt(deal.buyerBond) - cost / 2n + BigInt(refund);
  }

  /// 反过来：一个 toBuyer 对应「退了多少货款」。不在 0 ~ 货款之间时返回 null
  /// （说明对方的方案不是按「押金各自退回」的思路提的，那就只展示两边各拿多少）。
  function refundOf(deal, toBuyer) {
    const cost = deal.disputed ? BigInt(deal.lockedArbCost) : 0n;
    const r = BigInt(toBuyer) - BigInt(deal.buyerBond) + cost / 2n;
    return r >= 0n && r <= BigInt(deal.price) ? r : null;
  }

  /// 认输：与被仲裁判输一分不差。who = "buyer" | "seller"（认输的那一方）。
  function concedeSplit(deal, who) {
    const price = BigInt(deal.price), bb = BigInt(deal.buyerBond), sb = BigInt(deal.sellerBond);
    const cost = BigInt(deal.lockedArbCost);
    const fullFee = (price * BigInt(deal.feeBps)) / 10000n;
    const ruling = who === "buyer" ? RULING_SELLER : RULING_BUYER;
    if (ruling === RULING_BUYER) {
      return { toBuyer: price + bb + (sb - cost), toSeller: 0n, cost, fee: 0n };
    }
    return { toBuyer: 0n, toSeller: price - fullFee + sb + (bb - cost), cost, fee: fullFee };
  }

  const api = { settlementSplit, toBuyerForRefund, refundOf, concedeSplit };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.EscrowSplit = api;
})(typeof self !== "undefined" ? self : this);
