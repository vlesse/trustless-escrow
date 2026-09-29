import { ethers } from "ethers";
import { config } from "./config.js";
import * as session from "./session.js";
import { makeProvider, loadDeal, listDeals, availableActions, tokenInfo, tokenAllowance, fmtAmount, State, untilText } from "./deals.js";
import * as juryalert from "./juryalert.js";
import { esc, keyboard, btn } from "./telegram.js";
import { ranges, getLogs as getLogsChunked, isPruned } from "./logs.js";
import { describeEvidence } from "./evidence.js";

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
  // 原来漏了这一个。用户提交证据、签完，机器人一声不吭 —— 实测他以为没成功，
  // 又交了一遍，链上于是有了两份一样的证据、多付一次 gas。
  "event Evidence(address indexed by, string evidenceURI)",
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

/**
 * 当前剩余时间落在哪一档，没有就返回 null。
 *
 * **比窗口本身还长的档次要丢掉。** 交付期设成 4 小时的时候，「还剩 24 小时」
 * 这一档在交易生效的同一秒就已经满足 —— 用户刚收到「资金已锁定，请在
 * 4 小时内交付」，紧接着又来一条「交付期还剩 3 小时 59 分」。
 *
 * 这不只是啰嗦。到期提醒的优先级本来高于事件通知，因为不知情会真的亏钱；
 * 开头先发一条废话，训练出来的是「这类消息可以不看」，而真正救命的是
 * 最后那条「还剩 1 小时」。
 *
 * 做成纯函数是为了这条规则能被测试真正盖到 —— 它原来写在一个要连链的
 * 循环里面，改坏了不会有任何东西变红。
 */
export function dueBucket({ remaining, window, buckets = REMIND_AT }) {
  if (remaining <= 0) return null;

  /*
   * 必须取**还够得着的最小**那一档，不是第一个匹配上的。
   *
   * 原来写的是 REMIND_AT.find(t => remaining <= t)，而 REMIND_AT 是降序的
   * [24h, 6h, 1h] —— 于是只要剩余时间不超过 24 小时，第一个就命中 24h 档，
   * 永远命中它。每档只提醒一次，所以结果是：**6 小时和 1 小时这两档从来
   * 没有发出去过**，每笔单每种期限总共只响一声，而且响在最早、最不要紧的
   * 那个时刻。越接近截止越该催，实际却是越接近越安静。
   */
  const t = [...buckets].sort((a, b) => a - b).find((b) => remaining <= b);
  if (t === undefined) return null;
  if (window && t >= window) return null;
  return t;
}

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

/**
 * 截止时间：还剩多久 + 北京时间。
 *
 * 原来后面跟的是 UTC。这个机器人的用户几乎都在东八区，看到 UTC 要自己
 * 加八小时 —— 而这正是会算错、然后错过截止的那一步。
 */
export function cnTime(sec) {
  const d = new Date((Number(sec) + 8 * 3600) * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `北京时间 ${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
const when = (sec) => esc(`${untilText(sec)}（${cnTime(sec)} 截止）`);

/**
 * 进度条。五个阶段，走到哪一眼看得见。
 *
 * 用户从来不关心「状态 = Funded」，他关心的是「到哪一步了、还有几步」。
 */
const STAGES = ["开单", "入金", "交付", "验收", "放款"];
export function progressLine(state) {
  if (state === State.Cancelled) return "❎ 交易已取消";
  if (state === State.Disputed) return "✅开单 → ✅入金 → ✅交付 → ⚖️争议中 → ⬜放款";
  // 当前正在进行的是第几个阶段（从 0 数）
  const now = { [State.Open]: 1, [State.Funded]: 2, [State.Delivered]: 3, [State.Resolved]: 5 }[state] ?? 0;
  return STAGES.map((s, i) => (i < now ? "✅" : i === now ? "👉" : "⬜") + s).join(" → ");
}

/**
 * 所有推送都用同一个格式。
 *
 *   标题：刚刚发生了什么
 *   进度：到哪一步了
 *   你要做的：一句话。什么都不用做，也要明说「什么都不用做」
 *   补充：不做会怎样 / 可以随时怎样
 *
 * 为什么「什么都不用做」也要写出来：实测用户签完「标记已交付」回到
 * Telegram，什么消息都没有，只能干瞪眼。没有消息不等于「你不用做什么」，
 * 用户读到的是「是不是出错了」。
 *
 * title / youDo 传纯文本，在这里转义；lines / notes 传已经转义好的行。
 */
export function card({ icon, title, deal, lines = [], youDo, notes = [] }) {
  return [
    `${icon} *${esc(title)}*`,
    `交易 \`${short(deal.address)}\``,
    "",
    esc(`进度：${progressLine(deal.state)}`),
    ...(lines.length ? ["", ...lines] : []),
    "",
    `👉 *你要做的：*${esc(youDo)}`,
    ...(notes.length ? ["", ...notes] : []),
  ].join("\n");
}

/**
 * 把证据内容摆出来给人看。
 *
 * 文字证据是 data: 格式存在链上的，原样显示是一长串 base64，等于没显示。
 * 解码成原文；链接照原样放在代码块里（不做成可点的链接 —— 内容是对方写的，
 * 可能是钓鱼网址）。太长就截断，全文在区块浏览器里。
 */
const EVIDENCE_SHOW_MAX = 300;
export function evidenceLines(uri, label, fromOther = false) {
  const e = describeEvidence(uri);
  if (e.kind === "none") return [esc(`${label}：（没有附）`)];
  const cut = (t) => ([...t].length > EVIDENCE_SHOW_MAX ? [...t].slice(0, EVIDENCE_SHOW_MAX).join("") + "……" : t);
  if (e.kind === "text") return [esc(`${label}：「${cut(e.body)}」`)];
  const warn = fromOther ? "，是对方给的，打开前确认是正常网址" : "";
  return [esc(`${label}（链接${warn}）：`), `\`${esc(cut(e.body))}\``];
}

/// 结算明细。只在能确定拆分方式的时候拆（正常成交）—— 仲裁的分法
/// 很多，猜错一个数比不拆更糟。
function settleBreakdown(role, args, deal, info) {
  const got = role === "buyer" ? args.toBuyer : args.toSeller;
  const fee = BigInt(args.fee ?? 0n);
  if (role === "seller" && got === deal.price - fee + deal.sellerBond && got > 0n) {
    return [
      esc(`= 货款 ${fmtAmount(deal.price - fee, info)}（${fmtAmount(deal.price, info)} 扣掉 ${deal.feeBps / 100}% 手续费 ${fmtAmount(fee, info)}）`),
      esc(`+ 你的押金退回 ${fmtAmount(deal.sellerBond, info)}`),
    ];
  }
  if (role === "buyer" && got === deal.buyerBond && got > 0n) {
    return [esc("= 你的押金原路退回（货款已经付给卖家了）")];
  }
  return [];
}

/// 把一条事件翻译成「发给谁、说什么」。
/// 返回 [{to: "buyer"|"seller", text}]。**每个事件双方都要收到** ——
/// 做了操作的那一方需要回执，另一方需要知道轮到自己了。
export function describeEvent(name, args, deal, info) {
  const both = (make) => ["buyer", "seller"].map((r) => ({ to: r, text: make(r) }));

  switch (name) {
    case "Deposited": {
      // 双方都入金时不在这里说，交给紧随其后的 Activated —— 否则第二个入金的
      // 人会在同一秒收到「你的钱存进去了」和「交易生效了」两条。
      if (deal.buyerFunded && deal.sellerFunded) return [];
      const who = args.party.toLowerCase() === deal.buyer.toLowerCase() ? "buyer" : "seller";
      const other = who === "buyer" ? "seller" : "buyer";
      return [
        {
          to: who,
          text: card({
            icon: "✅", title: "你的钱已经存进去了", deal,
            lines: [esc(`你存入了 ${fmtAmount(args.amount, info)}，现在锁在这笔交易的合约里。`)],
            youDo: "等对方入金。现在什么都不用做，对方入金后我会通知你。",
            notes: [esc("对方一直不入金也没关系：交易生效之前，你随时可以点「取消交易」，钱原路退回你的钱包，一分不少。")],
          }),
        },
        {
          to: other,
          text: card({
            icon: "💰", title: "对方已经入金了", deal,
            lines: [esc(`对方存入了 ${fmtAmount(args.amount, info)}。`)],
            youDo: "轮到你入金了。点下面的「入金」按钮。",
            notes: [esc("你入金之后，交易正式生效。")],
          }),
        },
      ];
    }

    case "Activated":
      return both((r) => card({
        icon: "🔒", title: "双方都入金了，交易正式生效", deal,
        youDo: r === "seller"
          ? "把货交给买家，然后点下面的「标记已交付」。"
          : "等卖家发货。现在什么都不用做。",
        notes: r === "seller"
          ? [`⏰ 交付截止：${when(args.deliveryDeadline)}`,
             esc("⚠️ 超过这个时间还没点「标记已交付」，买家可以把钱全部拿回去。")]
          : [`⏰ 卖家交付截止：${when(args.deliveryDeadline)}`,
             esc("卖家超时没交付，你可以把钱全部拿回来。"),
             esc("如果已经收到货、确认没问题，也可以随时直接点「确认收货」。")],
      }));

    case "DeliveryMarked":
      return both((r) => card({
        icon: "📦",
        title: r === "seller" ? "你已标记交付" : "卖家说已经交付了",
        deal,
        lines: evidenceLines(args.evidenceURI, r === "seller" ? "你附的交付凭证" : "卖家附的交付凭证", r !== "seller"),
        youDo: r === "seller"
          ? "等买家验收。现在什么都不用做。"
          : "去检查你收到的东西。\n· 没问题 → 点「确认收货」，钱打给卖家\n· 有问题 → 点「提起争议」",
        notes: r === "seller"
          ? [`⏰ 验收截止：${when(args.inspectionDeadline)}`,
             esc("买家在截止前确认收货，或者到时间没有任何操作，钱都会打给你。")]
          : [`⏰ 验收截止：${when(args.inspectionDeadline)}`,
             `*${esc("⚠️ 到时间你不操作，钱会自动打给卖家，不能撤回。")}*`],
      }));

    case "DisputeRaised": {
      const raiser = args.by.toLowerCase() === deal.buyer.toLowerCase() ? "buyer" : "seller";
      return both((r) => card({
        icon: "⚖️",
        title: r === raiser ? "你已提起争议" : "对方提起了争议",
        deal,
        lines: evidenceLines(args.evidenceURI, r === raiser ? "你附的理由" : "对方附的理由", r !== raiser),
        youDo: "点下面的「提交证据」，用文字写清楚发生了什么：什么时间、对方说了什么、付款和物流记录。也可以发链接。",
        notes: [
          esc("仲裁只看双方交上去的材料。你不交，就只能按对方的材料判。"),
          esc("钱会一直锁在合约里，直到出结果。这期间谁都动不了，包括平台。"),
        ],
      }));
    }

    case "Evidence": {
      const by = args.by.toLowerCase() === deal.buyer.toLowerCase() ? "buyer" : "seller";
      return both((r) => card({
        icon: r === by ? "✅" : "📎",
        title: r === by ? "你的证据已提交" : "对方提交了新证据",
        deal,
        lines: evidenceLines(args.evidenceURI, r === by ? "你提交的内容" : "对方提交的内容", r !== by),
        youDo: r === by
          ? "等仲裁结果。还有要补充的，随时可以再点「提交证据」。"
          : "看看对方说的对不对。有反驳的材料，点下面的「提交证据」交上去。",
        notes: [esc("证据已经永久记在链上，谁都不能删除或修改。")],
      }));
    }

    case "Ruled": {
      const rr = Number(args.ruling);
      const outcome = rr === 1 ? "买家胜" : rr === 2 ? "卖家胜" : "不判输赢，双方按规则拆分";
      return both(() => card({
        icon: "⚖️", title: `仲裁结果：${outcome}`, deal,
        youDo: "什么都不用做。钱会按结果自动分配，到账后我会再通知你。",
      }));
    }

    case "Settled": {
      const cancelled = Number(args.finalState) === State.Cancelled;
      return both((r) => {
        const got = r === "buyer" ? args.toBuyer : args.toSeller;
        return card({
          icon: cancelled ? "❎" : "✅",
          title: cancelled ? "交易已取消，钱已退回" : "交易完成",
          deal,
          lines: got > 0n
            ? [`你收到了 *${amt(got, info)}*`, ...settleBreakdown(r, args, deal, info)]
            : [esc("这笔交易你这边没有收到钱。")],
          youDo: "什么都不用做了。钱已经到你钱包里了，这笔交易到此结束。",
        });
      });
    }

    default:
      return [];
  }
}

/// 到期提醒。只对「不作为会造成损失」的那一方发。
export function describeDeadline(deal, kind, remaining) {
  const left = fmtRemaining(remaining);
  if (kind === "delivery") {
    return {
      to: "seller",
      text: card({
        icon: "⏰", title: `交付期只剩 ${left} 了`, deal,
        youDo: "把货交给买家，然后点下面的「标记已交付」。",
        notes: [esc("⚠️ 超时还没点，买家可以把钱全部拿回去。")],
      }),
    };
  }
  return {
    to: "buyer",
    text: card({
      icon: "⏰", title: `验收期只剩 ${left} 了`, deal,
      youDo: "检查你收到的东西：没问题点「确认收货」，有问题点「提起争议」。",
      notes: [`*${esc("⚠️ 到时间你不操作，钱会自动打给卖家，不能撤回。")}*`],
    }),
  };
}

/// 开单通知。双方各自要存多少不一样，所以按角色分开说。
export function describeCreated(deal, info) {
  return ["buyer", "seller"].map((r) => {
    const need = r === "buyer" ? deal.price + deal.buyerBond : deal.sellerBond;
    const why = r === "buyer"
      ? `货款 ${fmtAmount(deal.price, info)} + 押金 ${fmtAmount(deal.buyerBond, info)}`
      : `押金 ${fmtAmount(deal.sellerBond, info)}`;
    return {
      to: r,
      text: card({
        icon: "🆕", title: "交易已创建", deal,
        lines: [
          esc(`你在这笔交易里是${r === "buyer" ? "买家" : "卖家"}。`),
          esc(`你要存入：${fmtAmount(need, info)}（${why}）`),
        ],
        youDo: "点下面的「入金」按钮。",
        notes: [esc("现在还没有锁定任何钱。双方都入金后交易才生效；在那之前，任何一方都可以取消，不损失任何东西。")],
      }),
    };
  });
}

/**
 * 只签了「授权」、没签「入金」。
 *
 * 入金要签两笔。第一笔「授权」不转账，只是允许合约下一步把钱划走 ——
 * 但对不懂的人来说，签了一笔、钱包里弹过窗，就等于「付过了」。
 * 他会以为自己入金了，然后等对方，而对方看到的是他一直没入金。
 */
export function approvedOnly({ funded, allowance, need }) {
  return !funded && BigInt(need) > 0n && BigInt(allowance) >= BigInt(need);
}

export function describeApprovedOnly(deal, role, info) {
  const need = role === "buyer" ? deal.price + deal.buyerBond : deal.sellerBond;
  return {
    to: role,
    text: card({
      icon: "⚠️", title: "你还差一步，钱还没存进去", deal,
      lines: [
        esc("你签了第 1 步「授权」，但还没签第 2 步「入金」。"),
        esc(`授权不会转账。你的 ${fmtAmount(need, info)} 现在还在你自己的钱包里，对方看到的是你还没入金。`),
      ],
      youDo: "点下面的「入金」按钮，这次只需要签 1 步。",
    }),
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

    // 按角色分开说（双方要存的钱不一样），并且直接带上「入金」按钮 ——
    // 原来只给一条 /deal 命令，用户得先复制命令、再点按钮，多一步就多一个人卡住。
    try {
      const d = await loadDeal(deal, provider);
      const info = await tokenInfo(d.token, provider);
      for (const m of describeCreated(d, info)) {
        const full = `\n\n合约地址（发给对方核对用）：\n\`${esc(deal)}\``;
        await pushTo(notify, d, m.to, m.text + full);
      }
    } catch (e) {
      console.error("开单通知失败:", e.message);
    }
  }
}

/**
 * 推送时把「现在能做什么」一并给出去。
 *
 * 原来只发文字：「请及时确认收货」——然后用户得自己记住合约地址，
 * 再打一遍 /deal 才找得到按钮。实测这是同一类问题的第三次：
 * 消息说了该做什么，却不给做的地方。
 *
 * 验收期这种带倒计时的通知尤其不能这样：错过截止时间的代价是钱，
 * 而多一步「回想合约地址」就够让人拖到明天。
 */
async function pushTo(notify, deal, target, text) {
  const addrs = target === "both" ? [deal.buyer, deal.seller]
    : target === "buyer" ? [deal.buyer] : [deal.seller];

  for (const a of addrs) {
    // 按钮按收件人的角色算 —— 同一条通知对买卖双方能做的事不一样
    const role = a.toLowerCase() === deal.buyer.toLowerCase() ? "buyer" : "seller";
    const rows = availableActions(deal, role)
      .map((act) => [btn(act.label, `act:${act.id}:${deal.address}`)]);
    rows.push([btn("查看这笔交易", `deal:${deal.address}`)]);

    for (const chatId of session.findUsersByAddress(a)) {
      await notify(chatId, text, keyboard(rows))
        .catch((e) => console.error("推送失败:", e.message));
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

/**
 * 一方入金、另一方迟迟不动的提醒。
 *
 * 「待入金」状态**链上没有任何期限** —— 它可以无限期挂着。设计上是对的：
 * 没有任何一方的钱被强制锁死，谁都可以随时无损退出。但产品上有个洞：
 * 先入金的那个人钱已经进去了，界面上什么也不会再发生，他只能对着
 * Telegram 干等，而且未必知道自己随时能取回。
 *
 * 链上没有「他是什么时候入金的」这个时刻，所以拿机器人第一次看见这个
 * 状态的时间来计时。这个时间偏晚（机器人可能停过机），偏晚是安全的方向：
 * 宁可晚提醒，不要在人家刚签完的那一分钟就催。
 */
const STALL_AFTER = [6 * 3600, 3 * 86400];

/// 等了这么久，落在哪一档？没到点返回 null。倒序找，取最大的那一档。
export function stallBucket({ waited, buckets = STALL_AFTER }) {
  const t = [...buckets].sort((a, b) => b - a).find((b) => waited >= b);
  return t === undefined ? null : t;
}

/// 只有一方入金时说什么。都没入金（没人的钱在里面）或都入了（已经生效）
/// 都返回 null —— 后者尤其重要：那时候已经退不出去了，还说「可以取消」是误导。
export function describeStalled(deal, waited) {
  if (deal.buyerFunded === deal.sellerFunded) return null;
  return {
    to: deal.buyerFunded ? "buyer" : "seller",
    text: card({
      icon: "⏳", title: "对方一直没有入金", deal,
      lines: [esc(`你已经入金 ${fmtRemaining(waited)}了，对方还没入金，这笔交易还没有生效。`)],
      youDo: "你可以继续等，也可以点「取消交易」把钱拿回来。",
      notes: [esc("取消不收任何费用，钱原路退回你的钱包。继续等也没有损失，这个状态没有截止时间。")],
    }),
  };
}

/**
 * 签完授权多久还没入金，才算「停在半路」。
 *
 * 不能一看到就提醒：正常人签完第 1 步，页面会直接带他签第 2 步，前后
 * 也就几十秒。这时候催他，等于在他正要做的时候说「你怎么还没做」。
 */
const APPROVE_GRACE_SEC = 3 * 60;

async function remindApprovedOnly(notify, deal, now) {
  for (const role of ["buyer", "seller"]) {
    const funded = role === "buyer" ? deal.buyerFunded : deal.sellerFunded;
    if (funded) continue;
    const owner = role === "buyer" ? deal.buyer : deal.seller;
    const need = role === "buyer" ? deal.price + deal.buyerBond : deal.sellerBond;

    // 每笔交易是一个新合约地址，所以对这个地址的授权额度一定是为这笔签的，
    // 不会被「以前给别的合约的无限授权」误判。
    const allowance = await tokenAllowance(deal.token, owner, deal.address, provider).catch(() => 0n);
    if (!approvedOnly({ funded, allowance, need })) continue;

    const seenKey = `approved-seen:${deal.address}:${role}`;
    session.alreadyNotified(seenKey);
    const since = session.notifiedAt(seenKey);
    if (!since || now - Math.floor(since / 1000) < APPROVE_GRACE_SEC) continue;
    if (session.alreadyNotified(`approved-only:${deal.address}:${role}`)) continue;

    const info = await tokenInfo(deal.token, provider);
    const m = describeApprovedOnly(deal, role, info);
    await pushTo(notify, deal, m.to, m.text);
  }
}

async function remindStalled(notify, deal, now) {
  const m = describeStalled(deal, 0);
  if (!m) return;

  // 第一次看见就把时刻记下来，之后靠它计时
  const seenKey = `stall-seen:${deal.address}`;
  session.alreadyNotified(seenKey);
  const since = session.notifiedAt(seenKey);
  if (!since) return;

  const waited = now - Math.floor(since / 1000);
  const threshold = stallBucket({ waited });
  if (threshold === null) return;
  if (session.alreadyNotified(`stall:${deal.address}:${threshold}`)) return;

  const msg = describeStalled(deal, waited);
  await pushTo(notify, deal, msg.to, msg.text);
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

    // 只有一方入金、卡在「待入金」的单子，另有一套提醒逻辑
    if (deal.state === State.Open) {
      await remindApprovedOnly(notify, deal, now);
      await remindStalled(notify, deal, now);
      continue;
    }

    let kind = null;
    let deadline = 0;
    let window = 0;
    if (deal.state === State.Funded) {
      kind = "delivery";
      deadline = deal.deliveryDeadline;
      window = deal.deliveryWindow;
    } else if (deal.state === State.Delivered) {
      kind = "inspection";
      deadline = deal.inspectionDeadline;
      window = deal.inspectionWindow;
    }
    if (!kind || deadline <= now) continue;

    const remaining = deadline - now;
    const threshold = dueBucket({ remaining, window });
    if (threshold === null) continue;

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
