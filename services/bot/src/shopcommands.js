/// /shop：卖家的店铺。看商品、上架、上下架、拿购买链接。
///
/// 上架的问法按「什么都不懂的人」设计：只问商品名称、价格、库存、发货时限、
/// 验收时限，能点按钮的都给按钮；两份押金按规则算好默认值；条款默认用点卡模板。
/// 最后把所有数字和条款全文摆出来确认，再去签名。
import { ethers } from "ethers";
import { config } from "./config.js";
import { esc, sendMessage, keyboard, btn, urlBtn } from "./telegram.js";
import * as session from "./session.js";
import { makeProvider, fmtAmount, tokenInfo } from "./deals.js";
import { sendTxs } from "./commands.js";
import { buildTx } from "./txlink.js";
import { loadArbitration } from "./arbitration.js";
import * as shop from "./shop.js";

const provider = makeProvider();

const unavailable = (chatId) => sendMessage(chatId, esc("本机器人还没接入店铺功能。"));
const needBind = (chatId) => sendMessage(chatId, esc("请先 /bind 绑定你的钱包地址。"));

// ------------------------------------------------------------------ 看店铺

export async function cmdShop(chatId, userId) {
  if (!shop.enabled()) return unavailable(chatId);
  const u = session.user(userId);
  if (!u.address) return needBind(chatId);

  const s = await shop.loadShop(u.address, provider);
  const cap = shop.capacity(s.balance, s.listings);
  const lines = ["*我的店铺*", ""];
  lines.push(esc(`押金账户：${fmtAmount(s.balance, s.info)}`) +
    (cap.orders !== null ? esc(`，还能同时接 ${cap.orders} 单`) : ""));
  if (cap.orders !== null && cap.orders === 0n) {
    lines.push(`*${esc("⚠️ 押金不够接新单了，买家现在下不了单。发 /quota 金额 存押金，比如 /quota 500")}*`);
  }
  lines.push("");
  if (s.listings.length === 0) {
    lines.push(esc("还没有商品。点下面的「上架新商品」。"));
  }
  const rows = [];
  for (const { id, l } of s.listings) {
    lines.push(shop.listingLine(id, l, s.info), "");
    const link = shop.buyLink(id);
    const row = [];
    if (link) row.push(urlBtn(`#${id} 购买链接`, link));
    row.push(btn(l.active ? `#${id} 下架` : `#${id} 上架`, `shoptog:${id}`));
    rows.push(row);
  }
  lines.push(esc("把「购买链接」发给买家就行：买家打开网页就能下单，不用 Telegram。"));
  lines.push(esc("自动发货：在你自己的电脑上运行发货程序（services/merchant），卡密会自动加密发给买家。"));
  rows.push([btn("➕ 上架新商品", "shopnew")]);
  await sendMessage(chatId, lines.join("\n"), keyboard(rows));
}

/// 上架 / 下架。库存交给发货程序同步，这里只切换在售状态。
export async function toggleListing(chatId, userId, idStr) {
  if (!shop.enabled() || !/^\d+$/.test(idStr ?? "")) return;
  const u = session.user(userId);
  if (!u.address) return needBind(chatId);
  const got = await shop.loadListing(BigInt(idStr), provider);
  if (!got || got.l.seller.toLowerCase() !== u.address.toLowerCase()) {
    return sendMessage(chatId, esc("这不是你的商品。"));
  }
  const on = !got.l.active;
  await sendMessage(chatId, esc(on ? `重新上架 #${idStr}。签名后买家就能下单了。` : `下架 #${idStr}。签名后买家就下不了单了（已经下的单不受影响）。`));
  await sendTxs(chatId, [buildTx("merchantBond", config.merchantBond, "updateListing",
    [BigInt(idStr), on, got.l.stock], on ? "上架商品" : "下架商品")]);
}

// ------------------------------------------------------------------ 上架新商品

const STEPS = ["name", "price", "stock", "dw", "iw", "terms"];

const PROMPT = {
  name: () => ["*上架新商品 · 1/6*", "", esc("商品叫什么？比如：王者荣耀 100 元点卡")],
  price: () => ["*2/6*", "", esc("卖多少钱？发一个数字，比如 100（单位 USDT）")],
  stock: () => ["*3/6*", "", esc("有几张？发一个数字，比如 50。"),
    esc("用了自动发货程序的话，它会按卡密文件里的张数自动调整，这里先填个大概。")],
  dw: () => ["*4/6*", "", esc("下单后多久内发货？超时不发，买家可以拿回全部的钱。"),
    esc("用自动发货程序的话，1 小时就够。也可以发一个小时数。")],
  iw: () => ["*5/6*", "", esc("发货后给买家多久验收？这段时间里买家发现卡密有问题可以提争议；时间到了没问题，货款自动付给你。")],
  terms: () => ["*6/6*", "", esc("条款：写清楚卖的是什么、怎样算交付、怎样算验收。吵架时仲裁只看它。"),
    esc("点卡、激活码直接用模板就行。要自己写的话，点「我自己写」。")],
};

const KEYS = {
  dw: [[btn("1 小时", "list:dw:1"), btn("6 小时", "list:dw:6"), btn("24 小时", "list:dw:24")]],
  iw: [[btn("12 小时", "list:iw:12"), btn("24 小时", "list:iw:24"), btn("48 小时", "list:iw:48")]],
  terms: [[btn("用点卡 / 激活码模板", "list:terms:tpl")], [btn("我自己写", "list:terms:own")]],
};

async function ask(chatId, key) {
  await sendMessage(chatId, PROMPT[key]().join("\n"), KEYS[key] ? keyboard(KEYS[key]) : {});
}

export async function startListing(chatId, userId) {
  if (!shop.enabled()) return unavailable(chatId);
  const u = session.user(userId);
  if (!u.address) return needBind(chatId);
  session.setFlow(userId, "list", { step: 0 });
  await ask(chatId, "name");
}

/// 校验一步的输入。返回 [值, 错误]
export function parseStep(key, text, decimals = 18) {
  const t = String(text ?? "").trim();
  switch (key) {
    case "name":
      if (!t) return [null, "请发商品名称。"];
      if ([...t].length > 40) return [null, "名称太长了，40 个字以内。"];
      if (/[\r\n]/.test(t)) return [null, "名称只能一行。"];
      return [t, null];
    case "price": {
      const n = t.replace(/[,，\s]/g, "").replace(/(USDT|U)$/i, "");
      if (!/^\d+(\.\d+)?$/.test(n)) return [null, "请发一个数字，比如 100。"];
      const v = ethers.parseUnits(n, decimals);
      return v > 0n ? [v, null] : [null, "价格要大于 0。"];
    }
    case "stock": {
      if (!/^\d+$/.test(t)) return [null, "请发一个整数，比如 50。"];
      const v = Number(t);
      return v >= 1 && v <= 1_000_000 ? [v, null] : [null, "库存要在 1 到 1000000 之间。"];
    }
    case "dw":
    case "iw": {
      if (!/^\d+$/.test(t)) return [null, "请点上面的按钮，或者发一个小时数，比如 24。"];
      const v = Number(t);
      return v >= 1 && v <= 24 * 30 ? [v, null] : [null, "要在 1 到 720 小时之间。"];
    }
    case "ownterms": {
      if ([...t].length < 10) return [null, "条款太短了，写清楚商品、交付、验收三件事。"];
      if (new TextEncoder().encode(t).length > 3900) return [null, "条款太长了，1300 个汉字以内。"];
      return [/^商品[:：]/.test(t) ? t : `商品：${t}`, null];
    }
    default:
      return [null, "未知步骤"];
  }
}

async function accept(chatId, userId, key, value) {
  const u = session.user(userId);
  const d = u.draft;
  d[key] = typeof value === "bigint" ? value.toString() : value;
  d.step = STEPS.indexOf(key) + 1;
  session.save();
  if (d.step < STEPS.length) return ask(chatId, STEPS[d.step]);
}

export async function handleListInput(chatId, userId, text) {
  const u = session.user(userId);
  const d = u.draft;
  if (d.awaitingOwnTerms) {
    const [v, err] = parseStep("ownterms", text);
    if (err) return sendMessage(chatId, esc(err));
    d.terms = v;
    delete d.awaitingOwnTerms;
    return preview(chatId, userId);
  }
  const key = STEPS[d.step];
  if (key === "terms") return ask(chatId, "terms");     // 这一步要点按钮
  const [v, err] = parseStep(key, text);
  if (err) return sendMessage(chatId, esc(err), KEYS[key] ? keyboard(KEYS[key]) : {});
  return accept(chatId, userId, key, v);
}

/// 按钮：list:dw:24 / list:iw:48 / list:terms:tpl|own
export async function listingButton(chatId, userId, key, val) {
  const u = session.user(userId);
  if (u.flow !== "list") return sendMessage(chatId, esc("这个按钮已经失效了。发 /shop 重新开始。"));
  const d = u.draft;
  if ((key === "dw" || key === "iw") && STEPS[d.step] === key) {
    const [v, err] = parseStep(key, val);
    if (err) return;
    return accept(chatId, userId, key, v);
  }
  if (key === "terms" && STEPS[d.step] === "terms") {
    if (val === "tpl") {
      d.terms = shop.cardTerms(d.name, d.dw);
      return preview(chatId, userId);
    }
    d.awaitingOwnTerms = true;
    session.save();
    return sendMessage(chatId, [
      esc("把条款发过来，一条消息。可以照这个改："),
      "",
      esc(shop.cardTerms(d.name, d.dw)),
    ].join("\n"));
  }
}

async function preview(chatId, userId) {
  const u = session.user(userId);
  const d = u.draft;
  const store = new ethers.Contract(config.merchantBond, shop.STORE_ABI, provider);
  const token = await store.token();
  const info = await tokenInfo(token, provider);
  const arb = await loadArbitration(token, config.escrowFactory, provider);
  const price = BigInt(d.price);
  const { sellerBond, buyerBond } = shop.defaultBonds(price, arb.cost ?? 0n);

  session.clearFlow(userId);
  await sendMessage(chatId, [
    "*确认上架*",
    "",
    esc(`商品：${d.name}`),
    esc(`价格：${fmtAmount(price, info)}`),
    esc(`库存：${d.stock}`),
    esc(`发货期限：下单后 ${d.dw} 小时内`),
    esc(`验收期限：发货后 ${d.iw} 小时`),
    "",
    "*押金（按规则算好的）*",
    esc(`你的押金：${fmtAmount(sellerBond, info)}（每一单锁一份，从押金账户里扣，交易结束退回）`),
    esc(`买家押金：${fmtAmount(buyerBond, info)}（防恶意申诉，交易结束退回买家）`),
    ...(arb.cost ? [esc(`两份押金都不能低于仲裁费 ${fmtAmount(arb.cost, info)}。`)] : []),
    esc(`买家下单一共付：${fmtAmount(price + buyerBond, info)}`),
    "",
    "*条款原文（会原样写上链，之后不能改）*",
    esc(d.terms),
    "",
    `*${esc("⚠️ 上架后价格、押金、条款都不能改，只能下架再重新上架。没问题就签名。")}*`,
  ].join("\n"));
  await sendTxs(chatId, [buildTx("merchantBond", config.merchantBond, "list", [
    price, buyerBond, sellerBond, BigInt(d.dw) * 3600n, BigInt(d.iw) * 3600n, d.terms, d.stock,
  ], "上架商品")]);
}

// ------------------------------------------------------------------ 买家点购买深链

export async function showListingForBuyer(chatId, id) {
  if (!shop.enabled()) return unavailable(chatId);
  const got = await shop.loadListing(id, provider);
  if (!got) return sendMessage(chatId, esc("没有这个商品。请向卖家确认链接。"));
  const card = shop.listingCard(id, got.l, got.info, got.poolBalance);
  const link = shop.buyLink(id);
  const rows = !card.blocked && link ? [[urlBtn("🛒 去下单（网页里完成）", link)]] : [];
  await sendMessage(chatId, card.text, rows.length ? keyboard(rows) : {});
  if (!card.blocked) {
    await sendMessage(chatId, esc("下单后想在这里收到发货通知，先发 /bind 绑定你付钱的那个钱包。"));
  }
}
