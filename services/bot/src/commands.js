import { ethers } from "ethers";
import { config } from "./config.js";
import { esc, sendMessage, keyboard, btn, urlBtn } from "./telegram.js";
import * as session from "./session.js";
import * as rep from "./reputation.js";
import { buildChallenge, newNonce, verifyBinding, CHALLENGE_TTL_MIN } from "./wallet.js";
import {
  makeProvider, loadDeal, listDeals, roleOf, availableActions,
  tokenInfo, fmtAmount, explorerAddr, hashTerms, STATE_NAME, State, factoryAt,
} from "./deals.js";
import {
  buildCreateDeal, buildDepositFlow, buildAction, toSigningLink, toMessageLink, toEip681, buildFundDeal,
} from "./txlink.js";
import {
  dealValue, capVerdict, loadArbitration, renderArbitrationNotes, renderCapRejection,
} from "./arbitration.js";
import * as quota from "./quota.js";
import * as quotacmd from "./quotacommands.js";

const provider = makeProvider();

/**
 * 每一步在干什么，用一句人话说明。
 *
 * 「授权」尤其需要：它不转账，只是允许托管合约在下一步划走固定额度。
 * 不解释的话，用户会以为自己已经付过一次钱，然后对第二步「入金」感到困惑。
 */
const TX_NOTE = {
  approve: "这一步不转账。它只是允许下面那个托管合约划走固定额度的代币；" +
    "额度只给这一笔所需，不是无限授权。钱要到下一步才真正锁进合约。",
  depositBuyer: "这一步真正把钱锁进托管合约。锁进去之后就只能按合约规则流转，" +
    "任何人都无法挪用，包括运营方。",
  depositSeller: "这一步真正把保证金锁进托管合约。",
};

/// 把一个交易请求渲染成可签名的三种形式。
///
/// 三种都给，是因为用户的资金不应当依赖任何一个环节存活：
/// 签名页可能挂、机器人可能被封，但只要用户手里有 to + calldata，
/// 任何钱包都能完成这笔操作。
///
/// 但顺序要摆对。原来第一眼看到的是 calldata —— 那是给「机器人没了还要
/// 自己动手」准备的兜底路径，对第一次用的人毫无意义。实测用户连着问了两次
/// 「在哪里授权」，因为消息里根本没有一句话说该点按钮。
/// 现在：先说这步干什么，再说点下面的按钮，calldata 退到最后。
export function renderTx(tx, idx = null, total = null) {
  const step = idx !== null ? `*第 ${idx}/${total} 步 · ${esc(tx.label)}*` : `*${esc(tx.label)}*`;
  const link = toSigningLink(tx);
  const note = TX_NOTE[tx.method];

  const lines = [step, ""];
  if (note) lines.push(esc(note), "");
  lines.push(link
    ? esc("👇 点下面的按钮，在你自己的钱包里签名。")
    : esc("把下面的 calldata 粘进任何钱包发送即可。"));
  lines.push(
    "",
    `合约: \`${esc(tx.to)}\``,
    `链 ID: ${esc(tx.chainId)}`,
    "",
    esc("calldata（签名页打不开时，可手工粘进任何钱包）:"),
    `\`${esc(tx.data)}\``,
  );

  const rows = [];
  if (link) rows.push([urlBtn(`✍️ 签名：${tx.label}`, link)]);
  return { text: lines.join("\n"), extra: rows.length ? keyboard(rows) : {} };
}

export async function sendTxs(chatId, txs) {
  for (let i = 0; i < txs.length; i++) {
    const { text, extra } = renderTx(txs[i], i + 1, txs.length);
    await sendMessage(chatId, text, extra);
  }
  if (txs.length > 1) {
    await sendMessage(chatId, esc("⚠️ 上面几步必须按顺序完成，先授权再入金。"));
  }
}

// ------------------------------------------------------------------ 基础命令

export async function cmdStart(chatId) {
  await sendMessage(chatId, [
    "*人人担保*",
    "",
    esc("非托管的点对点担保交易。资金锁在每笔交易独立的智能合约里。"),
    "",
    "*这个机器人不持有你的任何东西*",
    esc("· 它永远不会索取私钥或助记词"),
    esc("· 它没有能力动用你的资金——所有交易都由你在自己的钱包里签名"),
    esc("· 即使它被关停或封禁，你的资金仍可通过任何钱包直接与合约交互取回"),
    "",
    "开始使用：",
    esc("/bind  绑定你的钱包地址（只需要地址，不需要私钥）"),
    esc("/new   发起一笔担保交易"),
    esc("/deals 查看我的交易"),
    esc("/help  完整说明"),
  ].join("\n"));
}

export async function cmdHelp(chatId) {
  await sendMessage(chatId, [
    "*命令*",
    esc("/bind    绑定钱包（签一条消息证明你控制该地址，不是交易、零 gas）"),
    esc("/whoami  查看当前绑定的地址"),
    esc("/new     发起担保交易"),
    esc("/deals   我的交易列表"),
    esc("/deal <合约地址>  查看某笔交易详情与可用操作"),
    esc("/rep [地址]  查看信誉记录（不填则看自己）"),
    esc("/bond <金额>  押入身份押金 · /unbond 申请撤回 · /record <合约> 记录结果"),
    esc("/cancel  退出当前流程"),
    "",
    "*资金流向*",
    esc("买家锁入「货款 + 保证金」，卖家锁入「保证金」。"),
    esc("正常成交：货款给卖家，双方保证金各自退回。"),
    esc("争议：由仲裁层裁决，违约方的保证金罚没给对方。"),
    "",
    "*为什么要交保证金*",
    esc("没有罚没，作恶的成本就是零，骗子可以无限次尝试。"),
    esc("买卖双方对称：卖家不发货罚没，买家谎称没收到同样罚没。"),
    "",
    "*条款很重要*",
    esc("发起交易时填写的条款原文，其哈希会写上链。争议时只有哈希对得上的那份"),
    esc("才会被仲裁层认定为真本。请自行保存好原文。"),
    "",
    "*关于信誉*",
    esc("信誉只在「对方保证金低于货款」时才需要。保证金不低于货款时，"),
    esc("骗你这一笔的罚没大于收益 —— 那时你不需要相信任何人。"),
    esc("身份押金不是罚金，没有任何人能罚没它。它买的是年龄：钱能瞬间凑齐，年龄不能。"),
    "",
    "*商家额度是什么*",
    esc("同时接很多单的卖家，每单都要先授权再入金，两笔交易。把钱预存进额度池之后"),
    esc("每单只要一笔。它不是共享抵押 —— 每笔交易的保证金照样进各自的托管合约，"),
    esc("一笔出事不波及别笔。池子里的钱随时可以全额取回。"),
  ].join("\n"));
}

export async function cmdWhoami(chatId, userId) {
  const u = session.user(userId);
  if (!u.address) {
    await sendMessage(chatId, esc("尚未绑定钱包。发送 /bind 开始。"));
    return;
  }
  await sendMessage(chatId,
    `已绑定：\`${esc(u.address)}\`\n[在区块浏览器查看](${explorerAddr(u.address)})`);
}

// ------------------------------------------------------------------ 钱包绑定

export async function cmdBind(chatId, userId, arg = "") {
  /*
   * 地址不用填，填了也不会被采纳。
   *
   * 绑定的依据是签名 —— 地址是从签名里**恢复**出来的，不是用户声明的。
   * 这不是省事：让用户报一个地址、再拿另一把钥匙去签，两者可以不是同一个，
   * 那样的「绑定」什么也没证明。
   *
   * 但默默忽略参数比不支持更糟：用户打了地址，看到一模一样的回复，
   * 会以为自己填错了而反复重来（实测就发生了）。所以明说一句。
   */
  if (arg) {
    await sendMessage(chatId, [
      esc("不用填地址 —— 地址是从你的签名里算出来的，不是你报给我的。"),
      esc("（你报一个地址、却用另一把钥匙签名，这样的「绑定」什么也证明不了。）"),
      "",
      esc("下面这段就是要签的内容："),
    ].join("\n"));
  }
  const nonce = newNonce();
  const issuedAt = Date.now();
  session.setFlow(userId, "bind", { nonce, issuedAt });

  const challenge = buildChallenge(userId, nonce, issuedAt);
  // 原来只写「用 MetaMask 的 personal_sign」—— 而 MetaMask 插件根本没有
  // 给普通用户签任意消息的入口，这一步对绝大多数人是走不通的。
  // 配了签名页就直接给链接；没配才退回到让用户自己想办法。
  const link = toMessageLink(challenge);
  await sendMessage(chatId, [
    "*绑定钱包*",
    "",
    esc("绑定只需要地址，不需要私钥。请在你的钱包里对下面这段文字签名："),
    "",
    `\`\`\`\n${challenge}\n\`\`\``,
    "",
    esc("这不是一笔交易，不转移资产、不授予权限、不消耗 gas。"),
    "",
    ...(link
      ? [
          `[👉 点这里用钱包签名](${link})`,
          esc("手机上请用钱包 App 的内置浏览器打开；电脑上用装了 MetaMask 的浏览器。"),
          esc("签完页面会给出一串 0x 开头的签名，复制回来发给我。"),
        ]
      : [
          esc("签名方式：多数钱包在「设置 → 签名消息」里。"),
          esc("然后把得到的签名（0x 开头）直接发给我。"),
        ]),
    "",
    esc(`${CHALLENGE_TTL_MIN} 分钟内有效。/cancel 退出。`),
  ].join("\n"));
}

async function handleBindSignature(chatId, userId, text) {
  const u = session.user(userId);
  const r = verifyBinding({
    telegramUserId: userId,
    nonce: u.draft.nonce,
    issuedAt: u.draft.issuedAt,
    signature: text,
  });

  if (!r.ok) {
    await sendMessage(chatId, esc(`绑定失败：${r.reason}`));
    return;
  }

  u.address = r.address;
  session.clearFlow(userId);
  await sendMessage(chatId, [
    "✅ *绑定成功*",
    "",
    `地址：\`${esc(r.address)}\``,
    "",
    esc("现在可以用 /new 发起交易，或 /deals 查看已有交易。"),
  ].join("\n"));
}

// ------------------------------------------------------------------ 创建交易

const NEW_STEPS = [
  { key: "role", prompt: "你在这笔交易里是**买家**还是**卖家**？", buttons: [[btn("我是买家", "new:role:buyer"), btn("我是卖家", "new:role:seller")]] },
  { key: "counterparty", prompt: "对方的钱包地址？" },
  { key: "token", prompt: "结算币种的合约地址？（USDT / USDC 的合约地址）" },
  { key: "price", prompt: "货款金额？（按代币单位填，例如 `1000` 表示 1000 USDT）" },
  { key: "bond", prompt: "保证金金额？双方各出这么多。\n\n建议与货款等额——保证金越低，作恶成本越低。直接发 `same` 表示与货款相同。" },
  { key: "deliveryHours", prompt: "交付期限？（小时，例如 `72`）" },
  { key: "inspectionHours", prompt: "验收期限？（小时，例如 `48`）\n\n买家在此期间内可确认收货或提起争议；超时未操作则自动放款给卖家。" },
  { key: "terms", prompt: "交易条款原文。写清楚：商品是什么、怎样算交付完成、怎样算验收通过。\n\n争议时仲裁方就看这段文字。写得越具体，越不容易扯皮。" },
];

export async function cmdNew(chatId, userId) {
  const u = session.user(userId);
  if (!u.address) {
    await sendMessage(chatId, esc("请先 /bind 绑定钱包。"));
    return;
  }
  session.setFlow(userId, "new", { step: 0 });
  await promptStep(chatId, userId);
}

async function promptStep(chatId, userId) {
  const u = session.user(userId);
  const step = NEW_STEPS[u.draft.step];
  if (!step) return finalizeNew(chatId, userId);

  const n = u.draft.step + 1;
  await sendMessage(
    chatId,
    `*${n}/${NEW_STEPS.length}*\n\n${esc(step.prompt).replace(/\\\*\\\*(.+?)\\\*\\\*/g, "*$1*").replace(/\\`(.+?)\\`/g, "`$1`")}`,
    step.buttons ? keyboard(step.buttons) : {}
  );
}

/// 校验并记录一步的输入。返回错误消息，或 null 表示通过。
export function validateStep(key, raw, draft) {
  const v = raw.trim();
  switch (key) {
    case "role":
      if (v !== "buyer" && v !== "seller") return "请点上面的按钮选择";
      draft.role = v;
      return null;
    case "counterparty":
      if (!ethers.isAddress(v)) return "这不是一个合法的以太坊地址";
      draft.counterparty = ethers.getAddress(v);
      return null;
    case "token":
      if (!ethers.isAddress(v)) return "这不是一个合法的合约地址";
      draft.token = ethers.getAddress(v);
      return null;
    case "price": {
      if (!/^\d+(\.\d+)?$/.test(v) || Number(v) <= 0) return "请填一个正数，例如 1000";
      draft.priceRaw = v;
      return null;
    }
    case "bond": {
      if (v.toLowerCase() === "same") { draft.bondRaw = draft.priceRaw; return null; }
      if (!/^\d+(\.\d+)?$/.test(v) || Number(v) <= 0) return "请填一个正数，或发 same 表示与货款相同";
      draft.bondRaw = v;
      return null;
    }
    case "deliveryHours":
    case "inspectionHours": {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 24 * 90) return "请填 1 到 2160 之间的整数小时";
      draft[key] = n;
      return null;
    }
    case "terms":
      if (v.length < 20) return "条款太短了。争议时仲裁方只看这段文字，请写清楚商品、交付标准、验收标准";
      if (v.length > 8000) return "条款过长（超过 8000 字符）";
      draft.terms = v;
      return null;
    default:
      return "未知步骤";
  }
}

async function handleNewInput(chatId, userId, text) {
  const u = session.user(userId);
  const step = NEW_STEPS[u.draft.step];
  if (!step) return;

  const err = validateStep(step.key, text, u.draft);
  if (err) {
    await sendMessage(chatId, esc(`⚠️ ${err}`));
    return;
  }
  u.draft.step++;
  session.save();
  await promptStep(chatId, userId);
}

async function finalizeNew(chatId, userId) {
  const u = session.user(userId);
  const d = u.draft;

  const info = await tokenInfo(d.token, provider);
  const price = ethers.parseUnits(d.priceRaw, info.decimals);
  const bond = ethers.parseUnits(d.bondRaw, info.decimals);

  const buyer = d.role === "buyer" ? u.address : d.counterparty;
  const seller = d.role === "seller" ? u.address : d.counterparty;
  const termsHash = hashTerms(d.terms);

  // 单笔案值上限是工厂上的硬闸。必须在这里拦住 —— 否则用户会在自己钱包里
  // 撞上一个看不懂的 revert，钱没损失，但他不知道发生了什么。
  const value = dealValue({ price, buyerBond: bond, sellerBond: bond });
  const arb = await loadArbitration(d.token, config.escrowFactory, provider);
  const cap = capVerdict({ value, cap: arb.cap });
  if (!cap.ok) {
    await sendMessage(chatId, renderCapRejection({ value, cap: arb.cap, info }).join("\n"));
    session.clearFlow(userId);
    return;
  }

  const tx = buildCreateDeal({
    token: d.token, buyer, seller,
    price, buyerBond: bond, sellerBond: bond,
    deliveryWindow: d.deliveryHours * 3600,
    inspectionWindow: d.inspectionHours * 3600,
    termsHash,
  });

  await sendMessage(chatId, [
    "*确认交易条件*",
    "",
    `买家: \`${esc(buyer)}\``,
    `卖家: \`${esc(seller)}\``,
    `货款: ${esc(fmtAmount(price, info))}`,
    `保证金: ${esc(fmtAmount(bond, info))} \\(双方各出\\)`,
    `交付期: ${d.deliveryHours} 小时`,
    `验收期: ${d.inspectionHours} 小时`,
    `条款哈希: \`${esc(termsHash)}\``,
    "",
    ...renderArbitrationNotes({ value, cap: arb.cap, coverage: arb.coverage, info }),
    "",
    "*请自行保存条款原文*",
    esc("链上只存哈希。争议时你需要提交原文，哈希对得上才会被认定为真本。"),
    esc("原文丢了，你就无法证明当初约定了什么。"),
  ].join("\n"));

  await sendMessage(chatId, `\`\`\`\n${d.terms}\n\`\`\``);
  await sendTxs(chatId, [tx]);
  await sendMessage(chatId, esc("交易创建后，双方各自入金才会正式锁定。在此之前任一方都可无损取消。"));

  session.clearFlow(userId);
}

// ------------------------------------------------------------------ 交易查询

export async function cmdDeals(chatId, userId) {
  const u = session.user(userId);
  if (!u.address) {
    await sendMessage(chatId, esc("请先 /bind 绑定钱包。"));
    return;
  }

  const addrs = await listDeals(u.address, provider);
  if (addrs.length === 0) {
    await sendMessage(chatId, esc("你还没有任何交易。用 /new 发起一笔。"));
    return;
  }

  const lines = ["*我的交易*", ""];
  const rows = [];
  for (const a of addrs) {
    const deal = await loadDeal(a, provider);
    const info = await tokenInfo(deal.token, provider);
    const role = roleOf(deal, u.address);
    lines.push(
      `\`${esc(a)}\`\n  ${esc(STATE_NAME[deal.state])} · ${esc(fmtAmount(deal.price, info))} · 你是${role === "buyer" ? "买家" : "卖家"}`
    );
    rows.push([btn(`${STATE_NAME[deal.state]} · ${a.slice(0, 10)}…`, `deal:${a}`)]);
  }
  await sendMessage(chatId, lines.join("\n"), keyboard(rows));
}

/**
 * 交易详情的固定部分。
 *
 * 抽成纯函数是为了能被转义检查真正盖到。原来它写在 cmdDeal 里面 ——
 * 那是个要连链的 async 函数，测不了，于是「手续费: 1.00%」漏转义一路活到
 * 线上，Telegram 整条拒收，用户只看到「出错了」。
 *
 * 写一条「复现当初那一行」的测试是不够的：那测的是复制品，真货改坏了
 * 照样绿。能被测到，本身就是这个函数存在的理由。
 */
export function renderDealHeader({ deal, info, role, factoryArbitrator = null }) {
  const lines = [
    `*交易* \`${esc(deal.address)}\``,
    "",
    `状态: *${esc(STATE_NAME[deal.state])}*`,
    `货款: ${esc(fmtAmount(deal.price, info))}`,
    `买家保证金: ${esc(fmtAmount(deal.buyerBond, info))}${deal.buyerFunded ? " ✅已入金" : " ⏳未入金"}`,
    `卖家保证金: ${esc(fmtAmount(deal.sellerBond, info))}${deal.sellerFunded ? " ✅已入金" : " ⏳未入金"}`,
    // 不能省 esc：这里会输出 1.00%，而 MarkdownV2 里小数点必须转义。
    `手续费: ${esc((deal.feeBps / 100).toFixed(2))}%`,
    `你的角色: ${role ? (role === "buyer" ? "买家" : "卖家") : "无关第三方"}`,
  ];

  if (deal.state === State.Funded) {
    lines.push(`交付截止: ${esc(new Date(deal.deliveryDeadline * 1000).toISOString())}`);
  } else if (deal.state === State.Delivered) {
    lines.push(`验收截止: ${esc(new Date(deal.inspectionDeadline * 1000).toISOString())}`);
  }

  /*
   * 仲裁层地址。
   *
   * 原来这里写的是「入金前请自行核对这个仲裁层地址是不是你认可的那个」。
   * 实测第一个真实用户的反应是：「我从哪里去核对？这是个什么玩意？」
   *
   * 他是对的。让人核对却不给参照物，等于没说；而这种话说多了，
   * 用户学会的是「看不懂就跳过」—— 恰好是钓鱼最需要的那个习惯。
   *
   * 所以这里直接把比对做完：和工厂当前的默认仲裁层比。不一致不代表
   * 一定有鬼（管理员换过、这笔单是换之前开的，也会不一致），但值得停下来问。
   * 同时给出区块浏览器和公示站两个链接 —— 结论是我给的，
   * 而验证结论的手段不能只在我手里。
   */
  lines.push("", `仲裁层: \`${esc(deal.arbitrator)}\``);
  lines.push(esc("争议发生时，由它来裁决这笔钱归谁。"));

  if (factoryArbitrator) {
    const same = factoryArbitrator.toLowerCase() === deal.arbitrator.toLowerCase();
    lines.push(same
      ? esc("✅ 与本协议工厂当前的默认仲裁层一致。")
      : esc("⚠️ 与工厂当前的默认仲裁层不一致。这不必然有问题（可能这笔单开在更换之前），") +
        "\n" + esc("但入金前值得先问清楚。"));
  }

  const links = [`[在区块浏览器查看](${explorerAddr(deal.arbitrator)})`];
  if (config.siteUrl) links.push(`[对照官网公示](${config.siteUrl}#contracts)`);
  lines.push(links.join(esc(" · ")));
  return lines;
}

export async function cmdDeal(chatId, userId, addr) {
  const u = session.user(userId);
  if (!ethers.isAddress(addr)) {
    await sendMessage(chatId, esc("用法：/deal <托管合约地址>"));
    return;
  }

  // 只认工厂登记过的实例 —— 防止有人发一个长得一样的钓鱼合约地址
  const isReal = await import("./deals.js").then((m) => m.factoryAt(provider).isDeal(addr));
  if (!isReal) {
    await sendMessage(chatId, esc("⚠️ 这个地址不是本协议工厂创建的托管合约。可能是钓鱼，请勿向它转账。"));
    return;
  }

  const deal = await loadDeal(addr, provider);
  const info = await tokenInfo(deal.token, provider);
  const role = u.address ? roleOf(deal, u.address) : null;
  const acts = availableActions(deal, role);

  // 工厂当前的默认仲裁层，用来替用户做那次比对。读不到就退回只给链接 ——
  // 少一条结论总比给一条错结论好。
  const factoryArbitrator = await factoryAt(provider).defaultArbitrator().catch(() => null);
  const lines = renderDealHeader({ deal, info, role, factoryArbitrator });

  // 对手方信誉。只在「还有得选」的时候才真正有用 ——
  // 钱一旦锁进去，再好看的评估也改变不了什么，所以入金前这段放在最显眼处。
  if (role && rep.enabled()) {
    const counterparty = role === "buyer" ? deal.seller : deal.buyer;
    const theirBond = role === "buyer" ? deal.sellerBond : deal.buyerBond;
    try {
      const profile = await rep.loadProfile(counterparty, deal.token, provider);
      const assessment = rep.assess({ price: deal.price, counterpartyBond: theirBond, profile });
      lines.push("", rep.renderAssessment({
        profile, assessment, info,
        roleLabel: role === "buyer" ? "卖家" : "买家",
      }));
      if (deal.state === State.Open) {
        lines.push("", esc("以上是入金前唯一还能反悔的时机。资金一旦锁定，就只能走流程了。"));
      }
    } catch (e) {
      // 信誉是参考信息，读不到不应当让整个交易详情页打不开
      lines.push("", esc("（信誉数据读取失败，请自行谨慎评估对方）"));
    }
  }

  const rows = acts.map((a) => [btn(a.label, `act:${a.id}:${deal.address}`)]);
  rows.push([urlBtn("区块浏览器", explorerAddr(deal.address))]);

  const hints = acts.filter((a) => a.hint).map((a) => `· ${esc(a.label)}：${esc(a.hint)}`);
  if (hints.length) lines.push("", ...hints);

  await sendMessage(chatId, lines.join("\n"), keyboard(rows));
}

// ------------------------------------------------------------------ 执行操作

export async function runAction(chatId, userId, actionId, dealAddr) {
  const u = session.user(userId);
  if (!u.address) {
    await sendMessage(chatId, esc("请先 /bind 绑定钱包。"));
    return;
  }

  const deal = await loadDeal(dealAddr, provider);
  const info = await tokenInfo(deal.token, provider);
  const role = roleOf(deal, u.address);
  const allowed = availableActions(deal, role).map((a) => a.id);

  if (!allowed.includes(actionId)) {
    await sendMessage(chatId, esc("这个操作在当前状态下不可用。可能交易状态已经变了，请重新 /deal 查看。"));
    return;
  }

  switch (actionId) {
    case "deposit": {
      const amount = role === "buyer" ? deal.price + deal.buyerBond : deal.sellerBond;

      // 卖家如果有额度，一笔就够了：额度池替他把保证金付进这笔交易的托管合约。
      // 额度不够时不要卡住他 —— 告诉他差多少，然后照常给出两笔的老路。
      if (role === "seller") {
        const f = await quotacmd.dealFundability(deal.address, u.address);
        if (f.ok) {
          await sendMessage(chatId,
            `即将用额度支付保证金 *${esc(fmtAmount(amount, info))}*\n\n` +
            esc("只需一笔交易。钱从你的额度里扣，直接进这笔交易的托管合约。"));
          await sendTxs(chatId, [buildFundDeal(f.pool, deal.address)]);
          return;
        }
        if (f.why === "insufficient") {
          await sendMessage(chatId, quota.renderShort({ short: f.short, info: f.info }));
        }
      }

      await sendMessage(chatId,
        `即将锁定 *${esc(fmtAmount(amount, info))}*\n\n` +
        esc("需要两笔交易：先授权托管合约划转，再入金。"));
      await sendTxs(chatId, buildDepositFlow({
        token: deal.token, escrow: deal.address, amount, role,
      }));
      return;
    }
    case "cancel":
      await sendTxs(chatId, [buildAction(deal.address, "cancelUnfunded", [], "取消交易")]);
      return;
    case "confirm":
      await sendMessage(chatId, esc("确认收货后货款立即放给卖家，且不可撤销。确定收到货并验收无误再操作。"));
      await sendTxs(chatId, [buildAction(deal.address, "confirmReceipt", [], "确认收货并放款")]);
      return;
    case "settle":
      await sendTxs(chatId, [buildAction(deal.address, "settleAfterInspection", [], "结算给卖家")]);
      return;
    case "nondelivery":
      await sendTxs(chatId, [buildAction(deal.address, "claimNonDelivery", [], "索取退款")]);
      return;
    case "delivered":
      session.setFlow(userId, "evidence", { deal: deal.address, method: "markDelivered" });
      await sendMessage(chatId, esc("请提供交付凭证的链接（ipfs:// 或 https://）。没有就发 skip。"));
      return;
    case "dispute":
      session.setFlow(userId, "evidence", { deal: deal.address, method: "raiseDispute" });
      await sendMessage(chatId, [
        esc("提起争议前请想清楚："),
        esc("· 争议由仲裁层裁决，败诉方的保证金会被罚没给对方"),
        esc("· 恶意申诉同样会被罚没，这不是一个免费的选项"),
        "",
        esc("请提供证据链接（ipfs:// 或 https://）。没有就发 skip。"),
      ].join("\n"));
      return;
    case "evidence":
      session.setFlow(userId, "evidence", { deal: deal.address, method: "submitEvidence" });
      await sendMessage(chatId, esc("请提供证据链接（ipfs:// 或 https://）。"));
      return;
    default:
      await sendMessage(chatId, esc("未知操作"));
  }
}

async function handleEvidenceInput(chatId, userId, text) {
  const u = session.user(userId);
  const { deal, method } = u.draft;
  const v = text.trim();
  const uri = v.toLowerCase() === "skip" ? "" : v;

  if (uri && !/^(ipfs|https?):\/\//i.test(uri)) {
    await sendMessage(chatId, esc("请提供 ipfs:// 或 https:// 开头的链接，或发 skip 跳过。"));
    return;
  }

  const labels = {
    markDelivered: "标记已交付",
    raiseDispute: "提起争议",
    submitEvidence: "提交证据",
  };
  await sendTxs(chatId, [buildAction(deal, method, [uri], labels[method])]);
  session.clearFlow(userId);
}

// ------------------------------------------------------------------ 流程分发

export async function handleFlowInput(chatId, userId, text) {
  const u = session.user(userId);
  switch (u.flow) {
    case "bind": return handleBindSignature(chatId, userId, text);
    case "new": return handleNewInput(chatId, userId, text);
    case "evidence": return handleEvidenceInput(chatId, userId, text);
    default: return false;
  }
}

export const hasFlow = (userId) => Boolean(session.user(userId).flow);

/// 提交证据的上下文里，64 位十六进制大概率是交易哈希而不是私钥
export const flowExpectsTxHash = (userId) => session.user(userId).flow === "evidence";
