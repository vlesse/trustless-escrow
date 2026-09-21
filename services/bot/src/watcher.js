import { ethers } from "ethers";
import { config } from "./config.js";
import * as session from "./session.js";
import { makeProvider, loadDeal, listDeals, tokenInfo, fmtAmount, STATE_NAME, State } from "./deals.js";
import * as juryalert from "./juryalert.js";
import { esc } from "./telegram.js";
import { ranges, getLogs as getLogsChunked, isPruned } from "./logs.js";

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
const juryIface = new ethers.Interface(juryalert.JURY_ALERT_ABI);

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
async function discoverDeals(notify, fromBlock, toBlock, tracked) {
  const logs = await getLogsChunked({
    provider,
    filter: {
      address: config.escrowFactory,
      topics: [factoryIface.getEvent("DealCreated").topicHash],
    },
    fromBlock, toBlock,
  });

  for (const log of logs) {
    const p = factoryIface.parseLog(log);
    if (!p) continue;
    const parties = [p.args.buyer, p.args.seller];
    // 只跟踪至少有一方绑定了 Telegram 的交易 —— 其余的推给谁都没有
    if (!parties.some((a) => session.findUsersByAddress(a).length > 0)) continue;

    const deal = ethers.getAddress(p.args.deal);
    tracked.add(deal);

    /*
     * 开单也要通知。
     *
     * 原来只在入金之后才说话，于是签完「创建交易」的那一刻什么都没有 ——
     * 而那恰恰是用户最不确定的时刻：签名到底成没成？实测第一个真实用户
     * 就卡在这里问「机器人也没说我签没签」。
     *
     * 更实际的问题是拿不到合约地址：地址只在事件里，用户手上只有一个
     * 交易哈希，而下一步 /deal 要的是地址。不给地址等于让他自己去区块
     * 浏览器里翻日志。
     */
    const key = `deal-created:${deal}`;
    if (session.alreadyNotified(key)) continue;

    const info = await tokenInfo(p.args.token, provider).catch(() => null);
    const amt = (v) => (info ? fmtAmount(v, info) : v.toString());
    const text = [
      "🆕 *交易已创建*",
      "",
      `合约: \`${esc(deal)}\``,
      `货款: ${esc(amt(p.args.price))}`,
      `保证金: 买 ${esc(amt(p.args.buyerBond))} / 卖 ${esc(amt(p.args.sellerBond))}`,
      "",
      esc("现在还没有锁定任何资金，双方各自入金后才正式生效。在此之前任一方都可无损取消。"),
      "",
      esc("下一步：发送下面这条命令取入金交易"),
      `\`/deal ${esc(deal)}\``,
    ].join("\n");

    for (const a of parties) {
      for (const chatId of session.findUsersByAddress(a)) {
        await notify(chatId, text).catch((e) => console.error("开单通知失败:", e.message));
      }
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

  const logs = await getLogsChunked({
    provider,
    filter: { address: [...tracked] },
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
    const drawnLogs = await getLogsChunked({
      provider,
      filter: { address: config.stakedJury, topics: [juryIface.getEvent("JurorsDrawn").topicHash] },
      fromBlock, toBlock,
    });
    const drawnEvents = drawnLogs.map((l) => juryIface.parseLog(l)).filter(Boolean);
    if (drawnEvents.length === 0) return;

    // 案值直接从合约读，不再回捞 CaseCreated 日志。
    // 原来那段固定回溯 200000 个区块，而公共 RPC 的单次上限是 50000 ——
    // 它从来就没成功过，整个预警功能一直是静默失效的。
    // 一次 cases(id) 调用既没有跨度限制，拿到的也是当前值而不是创建时的快照。
    const now = Math.floor(Date.now() / 1000);

    for (const ev of drawnEvents) {
      const id = ev.args.id.toString();
      const key = `draw:${config.stakedJury}:${id}:${ev.args.round}`;
      if (session.alreadyNotified(key)) continue;

      const value = await jury.cases(ev.args.id).then((c) => c.value).catch(() => 0n);
      const data = await juryalert.collectDraw({
        jury: config.stakedJury,
        id, round: Number(ev.args.round),
        drawn: [...ev.args.drawn],
        value,
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
/**
 * 公共节点保留多久的日志。
 *
 * 实测 BSC 测试网约 5 万块，按 0.45 秒出块算不到 7 小时。超出这个范围的
 * 请求不是「慢」，是**再也拿不到**。所以启动时游标落在更早的位置，必须
 * 直接跳到能拿得到的地方并明说跳过了多少 —— 假装能补上，结果是每一轮都
 * 在同一处失败，一条通知也发不出去。
 *
 * 由此得出一条必须写进说明的性质：**通知是尽力而为的，不是保证。**
 * 停机超过这个窗口就会漏事件。资金状态的权威来源是 /deal，它直接读合约
 * 当前状态，不依赖任何日志。
 */
const MAX_LOOKBACK = Number(process.env.MAX_LOOKBACK_BLOCKS ?? 45000);

/**
 * 从链上重建要跟踪的交易集合。
 *
 * 原来 tracked 只靠扫 DealCreated 日志来填。日志会被节点裁剪，游标也会
 * 往前走 —— 一旦越过某笔单的开单区块，机器人就**永远再也发现不了它**，
 * 于是那笔单后续的入金、发货、裁决全都不推送。实测重启之后
 * 「跟踪 0 笔交易」，用户签完入金在 Telegram 上一点反应都没有。
 *
 * 工厂的 dealsOf 是链上状态，不是日志：它不会被裁剪，也不受游标影响。
 * 拿它当权威来源，日志只用来发现「刚刚新开的那些」。
 *
 * 终态的单子不再跟踪 —— 它们不会再有事件，留着只会让 getLogs 的地址
 * 列表无限膨胀。
 */
async function seedTracked(tracked) {
  const seen = new Set();
  for (const addr of session.boundAddresses()) {
    if (seen.has(addr.toLowerCase())) continue;
    seen.add(addr.toLowerCase());
    try {
      for (const a of await listDeals(addr, provider, 50)) {
        const deal = await loadDeal(a, provider).catch(() => null);
        if (!deal) continue;
        if (deal.state === State.Resolved || deal.state === State.Cancelled) continue;
        tracked.add(ethers.getAddress(a));
      }
    } catch (e) {
      console.error("重建跟踪集失败:", addr, e.message);
    }
  }
}

/// 每隔多少轮重建一次。新绑定的用户、以及游标已经越过的旧单，
/// 都靠这次重建被捡回来。
const RESEED_EVERY = 10;

export async function start(notify) {
  const tracked = new Set();
  let ticks = 0;

  // 游标落盘。不落盘的话每次重启都回到 WATCH_FROM_BLOCK，
  // 而那个位置迟早会被节点裁剪掉，于是重启一次就永久卡死。
  let last = Math.max(session.watchCursor(), Number(process.env.WATCH_FROM_BLOCK ?? 0));

  const tick = async () => {
    try {
      if (ticks++ % RESEED_EVERY === 0) await seedTracked(tracked);
      const head = await provider.getBlockNumber();
      const safe = head - CONFIRMATIONS;

      // 落后太多就跳到节点还留着的位置，并把跳过了多少说清楚
      const floor = safe - MAX_LOOKBACK;
      if (last < floor) {
        // 首次启动（游标为 0）和「停机太久导致漏事件」是两件事。
        // 前者本来就没有历史要补，说成「丢了一万六千小时」只会让运维虚惊一场。
        if (last === 0) {
          console.log(`首次启动，从节点还留着的最早位置 ${floor} 开始扫描。`);
        } else {
          console.warn(
            `监听游标 ${last} 已超出节点保留范围，跳到 ${floor}；` +
            `其间 ${floor - last} 个区块的事件拿不到了（约 ${((floor - last) * 0.45 / 3600).toFixed(1)} 小时）。` +
            `受影响的用户可以用 /deal <合约地址> 直接读当前状态。`);
        }
        last = floor;
        session.setWatchCursor(last);
      }
      if (safe <= last) return;

      /*
       * 游标必须**逐片**推进，不能等整段扫完再一次性推进。
       *
       * 单次 eth_getLogs 有区块跨度上限，所以一段长区间本来就要切片扫。
       * 若失败时游标退回起点，那么停机超过一个切片宽度之后，每一轮都会
       * 从同一个位置重新开始、在同一个地方失败 —— 不是「慢慢追上来」，
       * 是永久卡死，而且只在日志里留一行。
       *
       * 一片扫完就推进一片，最坏情况只是重扫最后那一片；而事件推送本来
       * 就按 txHash+logIndex 去重，重扫不会重复打扰用户。
       */
      for (const [lo, hi] of ranges(last + 1, safe)) {
        try {
          await discoverDeals(notify, lo, hi, tracked);
          await processEvents(notify, tracked, lo, hi);
          await scanDraws(notify, lo, hi);
        } catch (e) {
          // 历史被裁剪和网络抖动要分开：前者重试一万次也是同样的错。
          if (!isPruned(e)) throw e;
          console.warn(`区块 ${lo}-${hi} 的日志已被节点裁剪，跳过。`);
        }
        last = hi;
        session.setWatchCursor(last);
      }
      await checkDeadlines(notify, tracked);
    } catch (e) {
      console.error("监听轮询失败:", e.message, "（游标停在", last, "，下一轮从这里继续）");
    }
  };

  await tick();
  setInterval(tick, config.watchIntervalMs);
  console.log(`事件监听已启动（确认数 ${CONFIRMATIONS}，游标 ${last}，跟踪 ${tracked.size} 笔交易）`);
}
