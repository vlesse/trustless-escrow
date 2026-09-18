import { ethers } from "ethers";
import { config } from "./config.js";
import * as session from "./session.js";
import { makeProvider, loadDeal, tokenInfo, fmtAmount, STATE_NAME, State } from "./deals.js";
import * as juryalert from "./juryalert.js";
import { esc } from "./telegram.js";

/// 链上事件推送。
///
/// 两类通知，性质完全不同：
///
/// 1. **事件通知** —— 对方入金了、卖家发货了、裁决下来了。
///    纯粹是体验问题，没有它用户得自己反复 /deals 查。
///
/// 2. **到期提醒** —— 验收期还剩 6 小时。
///    这个不是锦上添花：验收期届满买家还没动作，货款就自动放给卖家了。
///    一个不知道这件事的买家会因为「没看手机」而实际损失。
///    所以到期提醒是在防止用户因不知情而受损，优先级高于事件通知。

const FACTORY_EVENTS = [
  "event DealCreated(address indexed deal, address indexed buyer, address indexed seller, address token, uint256 price, uint256 buyerBond, uint256 sellerBond, address arbitrator, uint16 feeBps, bytes32 termsHash)",
];

const ESCROW_EVENTS = [
  "event Deposited(address indexed party, uint256 amount)",
  "event Activated(uint64 deliveryDeadline, uint256 lockedArbCost)",
  "event DeliveryMarked(address indexed seller, string evidenceURI, uint64 inspectionDeadline)",
  "event DisputeRaised(address indexed by, uint256 indexed disputeID, string evidenceURI)",
  "event Ruled(uint256 indexed disputeID, uint256 ruling)",
  "event Settled(uint8 finalState, uint256 toBuyer, uint256 toSeller, uint256 toArbitrator, uint256 fee)",
];

const escrowIface = new ethers.Interface(ESCROW_EVENTS);
const factoryIface = new ethers.Interface(FACTORY_EVENTS);

/// 等待确认数再推送。
///
/// 通知的内容是「钱到账了」这类不可撤回的判断。链重组后一条已推送的
/// 「对方已入金」会变成假消息，而用户可能已经据此发了货。
/// 宁可慢几十秒，也不推可能被回滚的事实。
const CONFIRMATIONS = config.confirmations;

/// 到期提醒的档位（秒）。每档每笔交易只提醒一次。
const REMIND_AT = [24 * 3600, 6 * 3600, 3600];

const provider = makeProvider();

function fmtRemaining(sec) {
  if (sec <= 0) return "已到期";
  const h = Math.floor(sec / 3600);
  if (h >= 24) return `${Math.floor(h / 24)} 天 ${h % 24} 小时`;
  if (h >= 1) return `${h} 小时 ${Math.floor((sec % 3600) / 60)} 分钟`;
  return `${Math.floor(sec / 60)} 分钟`;
}

const short = (a) => `${a.slice(0, 8)}…${a.slice(-6)}`;

/// 所有插入消息正文的动态内容都必须过这一层。
///
/// 消息用 MarkdownV2 发送，而金额（1000.0）、ISO 时间戳（2026-09-14T08:08:58.000Z）
/// 里天然含有 `.` `-` `(` `)` 这些必须转义的字符。漏一个，Telegram 会直接
/// 拒收整条消息 —— 不是显示错乱，是**根本发不出去**，用户什么都收不到。
/// 地址放在 `` ` `` 代码块里，代码块内只需转义反引号与反斜杠，十六进制地址天然安全。
const amt = (raw, info) => esc(fmtAmount(raw, info));
const ts = (sec) => esc(new Date(Number(sec) * 1000).toISOString());

/// 把一条事件翻译成「发给谁、说什么」。
/// 返回 [{to: "buyer"|"seller"|"both", text}]，由调用方解析成实际的 Telegram 用户。
export function describeEvent(name, args, deal, info) {
  const tag = `\`${short(deal.address)}\``;

  switch (name) {
    case "Deposited": {
      const who = args.party.toLowerCase() === deal.buyer.toLowerCase() ? "buyer" : "seller";
      const other = who === "buyer" ? "seller" : "buyer";
      return [{
        to: other,
        text: `💰 ${tag}\n对方已入金 ${amt(args.amount, info)}。\n` +
          (deal.buyerFunded && deal.sellerFunded ? "双方资金均已锁定。" : "等待你入金后交易才会锁定。"),
      }];
    }

    case "Activated": {
      const when = ts(args.deliveryDeadline);
      return [
        { to: "seller", text: `🔒 ${tag}\n双方资金已锁定，请在 ${when} 前完成交付并标记。\n逾期买家可单方面取回全款。` },
        { to: "buyer", text: `🔒 ${tag}\n双方资金已锁定，等待卖家交付（截止 ${when}）。` },
      ];
    }

    case "DeliveryMarked": {
      const when = ts(args.inspectionDeadline);
      return [{
        to: "buyer",
        text: `📦 ${tag}\n卖家已标记交付，验收期至 ${when}。\n\n` +
          `*逾期未操作，货款将自动放给卖家。* 请及时确认收货或提起争议。`,
      }];
    }

    case "DisputeRaised": {
      const who = args.by.toLowerCase() === deal.buyer.toLowerCase() ? "buyer" : "seller";
      const other = who === "buyer" ? "seller" : "buyer";
      return [{
        to: other,
        text: `⚖️ ${tag}\n对方提起了争议。\n\n请尽快提交证据——仲裁层只看提交上来的材料。\n` +
          `条款原文哈希对得上的那份才会被认定为真本，请提交你保存的原文。`,
      }];
    }

    case "Ruled": {
      const r = Number(args.ruling);
      const outcome = r === 1 ? "买家胜" : r === 2 ? "卖家胜" : esc("拒裁（中性拆分）");
      return [{ to: "both", text: `⚖️ ${tag}\n裁决已下达：*${outcome}*` }];
    }

    case "Settled": {
      const st = Number(args.finalState);
      return [
        { to: "buyer", text: `✅ ${tag}\n交易已结束（${STATE_NAME[st]}）。\n你收到 ${amt(args.toBuyer, info)}。` },
        { to: "seller", text: `✅ ${tag}\n交易已结束（${STATE_NAME[st]}）。\n你收到 ${amt(args.toSeller, info)}。` },
      ];
    }

    default:
      return [];
  }
}

/// 到期提醒。只对「不作为会造成损失」的那一方发。
export function describeDeadline(deal, kind, remaining) {
  const tag = `\`${short(deal.address)}\``;
  const left = esc(fmtRemaining(remaining));

  if (kind === "delivery") {
    return {
      to: "seller",
      text: `⏰ ${tag}\n交付期还剩 *${left}*。\n\n` +
        `逾期未标记交付，买家可单方面取回全部货款与保证金。`,
    };
  }
  return {
    to: "buyer",
    text: `⏰ ${tag}\n验收期还剩 *${left}*。\n\n` +
      `*逾期未操作，货款将自动放给卖家，且不可撤销。*\n` +
      `请确认收货，或在此之前提起争议。`,
  };
}

// ------------------------------------------------------------------ 主循环

/// 发现与已绑定用户相关的交易。
async function discoverDeals(fromBlock, toBlock, tracked) {
  const logs = await provider.getLogs({
    address: config.escrowFactory,
    topics: [factoryIface.getEvent("DealCreated").topicHash],
    fromBlock, toBlock,
  });

  for (const log of logs) {
    const p = factoryIface.parseLog(log);
    if (!p) continue;
    const parties = [p.args.buyer, p.args.seller];
    // 只跟踪至少有一方绑定了 Telegram 的交易 —— 其余的推给谁都没有
    if (parties.some((a) => session.findUsersByAddress(a).length > 0)) {
      tracked.add(ethers.getAddress(p.args.deal));
    }
  }
}

async function pushTo(notify, deal, target, text) {
  const addrs = target === "both" ? [deal.buyer, deal.seller]
    : target === "buyer" ? [deal.buyer] : [deal.seller];

  for (const a of addrs) {
    for (const chatId of session.findUsersByAddress(a)) {
      await notify(chatId, text).catch((e) => console.error("推送失败:", e.message));
    }
  }
}

async function processEvents(notify, tracked, fromBlock, toBlock) {
  if (tracked.size === 0) return;

  const logs = await provider.getLogs({
    address: [...tracked],
    fromBlock, toBlock,
  });

  for (const log of logs) {
    let parsed;
    try {
      parsed = escrowIface.parseLog(log);
    } catch {
      continue;
    }
    if (!parsed) continue;

    // 去重键用 txHash + logIndex：同一条日志无论被扫到几次都只推一次
    const key = `ev:${log.transactionHash}:${log.index}`;
    if (session.alreadyNotified(key)) continue;

    try {
      const deal = await loadDeal(log.address, provider);
      const info = await tokenInfo(deal.token, provider);
      for (const m of describeEvent(parsed.name, parsed.args, deal, info)) {
        await pushTo(notify, deal, m.to, m.text);
      }
    } catch (e) {
      console.error(`处理事件失败 ${log.transactionHash}:`, e.message);
    }
  }
}

async function checkDeadlines(notify, tracked) {
  const now = Math.floor(Date.now() / 1000);

  for (const addr of tracked) {
    let deal;
    try {
      deal = await loadDeal(addr, provider);
    } catch {
      continue;
    }

    let kind = null;
    let deadline = 0;
    if (deal.state === State.Funded) {
      kind = "delivery";
      deadline = deal.deliveryDeadline;
    } else if (deal.state === State.Delivered) {
      kind = "inspection";
      deadline = deal.inspectionDeadline;
    }
    if (!kind || deadline <= now) continue;

    const remaining = deadline - now;
    // 找到当前落在哪一档，每档每笔交易只提醒一次
    const threshold = REMIND_AT.find((t) => remaining <= t);
    if (threshold === undefined) continue;

    const key = `dl:${addr}:${kind}:${threshold}`;
    if (session.alreadyNotified(key)) continue;

    const m = describeDeadline(deal, kind, remaining);
    await pushTo(notify, deal, m.to, m.text);
  }
}

/// 扫描本轮新出现的抽选结果，把可疑的公开播出去。
///
/// 只有同时配了陪审团地址和广播频道才会跑。任何一步失败都只记一行日志 ——
/// 这是一个附加的观测功能，不该有能力把交易提醒的主循环拖垮。
async function scanDraws(notify, fromBlock, toBlock) {
  if (!config.stakedJury || !config.alertChatId) return;

  try {
    const jury = new ethers.Contract(config.stakedJury, juryalert.JURY_ALERT_ABI, provider);
    const drawnEvents = await jury.queryFilter(jury.filters.JurorsDrawn(), fromBlock, toBlock);
    if (drawnEvents.length === 0) return;

    // 案值只在 CaseCreated 里，抽选事件本身没有。往回捞一段拿到它。
    const created = await jury.queryFilter(
      jury.filters.CaseCreated(), Math.max(0, fromBlock - 200000), toBlock
    );
    const valueOf = new Map(created.map((e) => [e.args.id.toString(), e.args.value]));
    const now = Math.floor(Date.now() / 1000);

    for (const ev of drawnEvents) {
      const id = ev.args.id.toString();
      const key = `draw:${config.stakedJury}:${id}:${ev.args.round}`;
      if (session.alreadyNotified(key)) continue;

      const data = await juryalert.collectDraw({
        jury: config.stakedJury,
        id, round: Number(ev.args.round),
        drawn: [...ev.args.drawn],
        value: valueOf.get(id) ?? 0n,
        provider, now,
      });
      const assessment = juryalert.assessDraw(data);
      const text = juryalert.renderAlert({
        id, round: Number(ev.args.round), assessment,
        value: data.value, coverage: data.coverage, info: null,
      });
      if (text) await notify(config.alertChatId, text).catch((e) => console.error("广播失败:", e.message));
    }
  } catch (e) {
    console.error("抽选预警扫描失败:", e.message);
  }
}

/**
 * 启动监听。
 * @param {(chatId: string, text: string) => Promise<any>} notify 发消息的函数
 */
export async function start(notify) {
  const tracked = new Set();
  let last = Number(process.env.WATCH_FROM_BLOCK ?? 0);

  const tick = async () => {
    try {
      const head = await provider.getBlockNumber();
      const safe = head - CONFIRMATIONS;
      if (safe <= last) return;

      await discoverDeals(last + 1, safe, tracked);
      await processEvents(notify, tracked, last + 1, safe);
      await checkDeadlines(notify, tracked);
      await scanDraws(notify, last + 1, safe);

      last = safe;
    } catch (e) {
      console.error("监听轮询失败:", e.message);
    }
  };

  await tick();
  setInterval(tick, config.watchIntervalMs);
  console.log(`事件监听已启动（确认数 ${CONFIRMATIONS}，跟踪 ${tracked.size} 笔交易）`);
}
