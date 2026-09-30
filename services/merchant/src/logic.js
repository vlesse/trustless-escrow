/// 自动发货程序里所有「决定做什么」的部分。纯函数，不碰链、不碰磁盘，可测。
///
/// 最要紧的一条：**同一张卡密永远不能发给第二个人，同一单也不能发两张。**
/// 做法是「先记账、再发交易」：每一单分到哪张卡密，在发交易之前就写进状态文件。
/// 程序在发交易的中途崩了，重启后看到这一单已经分过卡密，就用同一张重试 ——
/// 链上那笔要么没成（重发同一张），要么已经成了（交易合约已是「已交付」，跳过）。

/// 卡密文件：一行一张。空行、# 开头的注释跳过。重复的只算一次并报出来 ——
/// 同一张卡密卖给两个人，是最直接的事故。
export function parseCodes(text) {
  const seen = new Set();
  const codes = [];
  const duplicates = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (seen.has(line)) { duplicates.push(line); continue; }
    seen.add(line);
    codes.push(line);
  }
  return { codes, duplicates };
}

/// 已经分出去的卡密（不管发没发成功，分了就不能再给别人）
export function assignedCodes(state) {
  return new Set(Object.values(state.assigned || {}).map((a) => a.code));
}

/// 给一单挑卡密：这一单分过就还用那一张；没分过就取第一张还没分出去的。
/// 返回 null 表示没货了。
export function pickCode(state, deal, codes) {
  const prev = state.assigned?.[deal.toLowerCase()];
  if (prev) return prev.code;
  const used = assignedCodes(state);
  return codes.find((c) => !used.has(c)) ?? null;
}

/// 这个商品还剩几张没分出去
export function remaining(state, listingId, codes) {
  const used = assignedCodes(state);
  return codes.filter((c) => !used.has(c)).length;
}

/// 链上库存要不要改、改成多少。null 表示不用动。
///
/// 链上库存在买家下单那一刻就减了一，而卡密要等本程序发货时才分出去。
/// 所以每一轮必须**先发货、再同步库存** —— 反过来的话，一张已经卖掉还没分配的
/// 卡密会被算成「还在」，把库存调回去，多卖出一单（那一单最后只能退款）。
export function stockPlan(onchainStock, left) {
  const want = Math.min(left, 0xffffffff);
  return Number(onchainStock) === want ? null : want;
}

/// 押金账户要补多少。目标：够接 targetOrders 单最贵的那种押金。
/// 只从钱包里现有的钱补，不透支；钱包里的钱是卖家的收入，补多少由他设的目标决定。
export function topUpAmount({ poolBalance, walletBalance, bondPerOrder, targetOrders }) {
  if (!bondPerOrder || targetOrders <= 0) return 0n;
  const target = BigInt(bondPerOrder) * BigInt(targetOrders);
  if (BigInt(poolBalance) >= target) return 0n;
  const need = target - BigInt(poolBalance);
  const have = BigInt(walletBalance);
  return need < have ? need : have;
}

/// 这一单现在该不该发货。只看链上事实，每条不发货的理由都要说得出来。
export function shouldDeliver({ state, deliveryDeadline, now, listingId, pickupKey, hasCodes }) {
  if (state !== 2) return { go: false, why: state >= 3 ? "delivered-or-later" : "not-funded" };
  if (!listingId || listingId === 0n || listingId === 0) return { go: false, why: "not-from-store" };
  if (!pickupKey || pickupKey === "0x") return { go: false, why: "no-pickup-key" };
  if (Number(deliveryDeadline) <= now) return { go: false, why: "deadline-passed" };
  if (!hasCodes) return { go: false, why: "no-codes-file" };
  return { go: true };
}
