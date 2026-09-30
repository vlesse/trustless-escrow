/// 店铺：读链上商品、算默认押金、生成条款模板、渲染消息。
///
/// 纯函数与读链分开：「显示什么、默认值怎么算」都可测，读链只是把数喂进来。
import { ethers } from "ethers";
import { config } from "./config.js";
import { fmtAmount, tokenInfo } from "./deals.js";
import { esc } from "./telegram.js";

export const STORE_ABI = [
  "function token() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function listingsOf(address, uint256) view returns (uint256)",
  "function listingsOfLength(address) view returns (uint256)",
  "function listings(uint256) view returns (tuple(address seller, bool active, uint32 stock, uint32 sold, uint64 deliveryWindow, uint64 inspectionWindow, uint256 price, uint256 buyerBond, uint256 sellerBond, bytes32 termsHash, string terms))",
  "function listingOf(address) view returns (uint256)",
];

export const enabled = () => Boolean(config.merchantBond);

/// 条款第一行「商品：xxx」就是商品名。下单页、机器人、推送都这么取。
export function titleOf(terms, id) {
  const first = String(terms).split("\n")[0].replace(/^商品[:：]\s*/, "").trim();
  return first || `商品 #${id}`;
}

/// 下单页链接。买家不用 Telegram 也能买，所以这是卖家要到处贴的那个链接。
export function buyLink(id) {
  if (!config.signingPageUrl) return null;
  return `${config.signingPageUrl.replace(/\/$/, "")}/buy.html#id=${id}&chain=${config.chainId}`;
}

/// 取货页链接。
export function pickupLink(deal) {
  if (!config.signingPageUrl) return null;
  return `${config.signingPageUrl.replace(/\/$/, "")}/pickup.html#deal=${deal}&chain=${config.chainId}`;
}

/// Telegram 里的购买深链：t.me/机器人?start=buy_12
export function parseBuyPayload(payload) {
  const m = /^buy_(\d{1,9})$/.exec(String(payload ?? ""));
  return m ? BigInt(m[1]) : null;
}

/**
 * 默认押金。两份都不能低于仲裁费 —— 否则交易根本激活不了（合约拦截），
 * 押金低于仲裁费还意味着输的一方付不起裁决费用。
 *
 *   卖家押金 = 货款（卖家违约的代价是全部押金，押金等于货款时买家最稳）
 *   买家押金 = 货款的 10%（防恶意申诉，又不至于把买家吓跑）
 * 两者都取「这个数」和「仲裁费」里大的那个。
 */
export function defaultBonds(price, arbCost) {
  const cost = BigInt(arbCost ?? 0n);
  const max = (a, b) => (a > b ? a : b);
  return { sellerBond: max(BigInt(price), cost), buyerBond: max(BigInt(price) / 10n, cost) };
}

/// 点卡 / 激活码的条款模板。写成「能查证的事实」—— 仲裁只能判这种。
export function cardTerms(name, deliveryHours) {
  return [
    `商品：${name}`,
    `交付：下单后 ${deliveryHours} 小时内自动发卡密（加密写在链上，只有买家能解开）`,
    "验收：卡密能在官方渠道成功充值 / 激活，即算通过",
    "例外：卡密显示已被使用、无效或面值不符，买家可提起争议",
  ].join("\n");
}

/// 一件商品的一行摘要（MarkdownV2）
export function listingLine(id, l, info) {
  const status = !l.active ? "已下架" : l.stock === 0n || l.stock === 0 ? "卖完了" : "在售";
  return `*\\#${id} ${esc(titleOf(l.terms, id))}*\n` +
    esc(`${fmtAmount(l.price, info)} · 库存 ${l.stock} · 已卖 ${l.sold} · ${status}`);
}

/// 押金账户：还能同时接几单（按最贵那件在售商品的卖家押金算）
export function capacity(balance, listings) {
  const active = listings.filter((x) => x.l.active);
  const bond = active.reduce((m, x) => (x.l.sellerBond > m ? x.l.sellerBond : m), 0n);
  return { bond, orders: bond > 0n ? BigInt(balance) / bond : null };
}

/// 给买家看的商品卡片（Telegram 里点购买深链时）
export function listingCard(id, l, info, poolBalance) {
  const pay = l.price + l.buyerBond;
  const h = (s) => `${Number(s) / 3600} 小时`;
  const lines = [
    `🛒 *${esc(titleOf(l.terms, id))}*`,
    "",
    `你要付：*${esc(fmtAmount(pay, info))}*`,
    esc(`= 货款 ${fmtAmount(l.price, info)} + 你的押金 ${fmtAmount(l.buyerBond, info)}（交易正常结束后押金退回）`),
    "",
    esc(`卖家押金 ${fmtAmount(l.sellerBond, info)} 和你的钱一起锁进这一单。卖家下单后 ${h(l.deliveryWindow)}内不发货，你拿回全部的钱。`),
    esc(`发货后你有 ${h(l.inspectionWindow)}验收，不操作的话货款自动付给卖家。`),
    "",
    "*条款原文（链上）*",
    esc(l.terms),
  ];
  const blocked = !l.active ? "这个商品已下架。"
    : (l.stock === 0n || l.stock === 0) ? "这个商品卖完了。"
      : BigInt(poolBalance) < l.sellerBond ? "卖家押金账户余额不够，暂时接不了新单。" : null;
  if (blocked) lines.push("", `*${esc(`⚠️ ${blocked}`)}*`);
  return { text: lines.join("\n"), blocked };
}

// ------------------------------------------------------------------ 读链

export async function loadShop(seller, provider) {
  const store = new ethers.Contract(config.merchantBond, STORE_ABI, provider);
  const [n, balance, token] = await Promise.all([
    store.listingsOfLength(seller), store.balanceOf(seller), store.token(),
  ]);
  const listings = [];
  for (let i = 0; i < Number(n); i++) {
    const id = await store.listingsOf(seller, i);
    listings.push({ id, l: await store.listings(id) });
  }
  return { listings, balance, info: await tokenInfo(token, provider), token };
}

export async function loadListing(id, provider) {
  const store = new ethers.Contract(config.merchantBond, STORE_ABI, provider);
  const l = await store.listings(id);
  if (l.seller === ethers.ZeroAddress) return null;
  const [info, poolBalance] = await Promise.all([tokenInfo(await store.token(), provider), store.balanceOf(l.seller)]);
  return { l, info, poolBalance };
}

