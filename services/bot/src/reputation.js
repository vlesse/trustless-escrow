import { ethers } from "ethers";
import { config } from "./config.js";
import { fmtAmount } from "./deals.js";
import { esc } from "./telegram.js";

/// 信誉层的读取与解读。
///
/// 合约只沉淀事实，**打分的政策留在这一层** —— 因为骗子的手法会变，
/// 而合约不会变。这里的每一条判断规则都应当是随时可以改的。
///
/// 展示原则：不给星级。
///
/// 星级会让人把「4.8 星」当成一个可以直接相信的结论，但它压缩掉了唯一
/// 重要的信息 —— 具体到这一笔交易，对方骗你能赚多少、要付出什么。
/// 同样的「4.8 星」，在 100 块的交易和 10 万块的交易里含义完全不同。
///
/// 所以这里输出的是一个**针对当前这笔交易**的缺口计算，
/// 而不是一个对方随身携带的分数。

const REPUTATION_ABI = [
  "function statsOf(address,address) view returns (tuple(uint32 completed,uint32 counterparties,uint32 disputesWon,uint32 disputesLost,uint32 disputesInconclusive,uint32 nonDelivery,uint64 lastRecordedAt) record_, uint256 volume, uint256 feesBurned)",
  "function record(address)",
];

const IDENTITY_BOND_ABI = [
  "function bondOf(address) view returns (uint256 amount,uint64 bondedAt,uint64 toppedUpAt,uint64 unbondableAt,uint32 unbondRequests)",
  "function ageOf(address) view returns (uint64)",
  "function committedOf(address) view returns (uint256)",
  "function token() view returns (address)",
  "function bond(uint256)",
  "function requestUnbond()",
  "function withdraw()",
];

/// 暴露给测试：这两份手写 ABI 必须与编译产物的选择器逐个对得上，
/// 否则读出来的是错误的数字，而界面看起来一切正常。
export const READ_ABIS = { Reputation: REPUTATION_ABI, IdentityBond: IDENTITY_BOND_ABI };

export const enabled = () => Boolean(config.reputation && config.identityBond);

/// 协议的结算币种。
///
/// 取自 IdentityBond 的 immutable `token()`，而不是随便找一笔交易去猜：
/// 信誉统计必须分币种（1000 USDT 和 1000 个垃圾币不能加在一起），
/// 而押金合约的币种是部署时写死、任何人都改不了的那一个。
let _token = null;
export async function settlementToken(provider) {
  if (_token) return _token;
  const idb = new ethers.Contract(config.identityBond, IDENTITY_BOND_ABI, provider);
  _token = await idb.token();
  return _token;
}

export async function loadProfile(address, token, provider) {
  if (!enabled()) return null;

  const rep = new ethers.Contract(config.reputation, REPUTATION_ABI, provider);
  const idb = new ethers.Contract(config.identityBond, IDENTITY_BOND_ABI, provider);

  const [stats, bond, age, committed] = await Promise.all([
    rep.statsOf(address, token),
    idb.bondOf(address),
    idb.ageOf(address),
    idb.committedOf(address),
  ]);

  const r = stats.record_;
  return {
    address: ethers.getAddress(address),
    completed: Number(r.completed),
    counterparties: Number(r.counterparties),
    disputesWon: Number(r.disputesWon),
    disputesLost: Number(r.disputesLost),
    disputesInconclusive: Number(r.disputesInconclusive),
    nonDelivery: Number(r.nonDelivery),
    volume: stats.volume,
    feesBurned: stats.feesBurned,
    bondAmount: bond.amount,
    bondedAt: Number(bond.bondedAt),
    toppedUpAt: Number(bond.toppedUpAt),
    unbondableAt: Number(bond.unbondableAt),
    unbondRequests: Number(bond.unbondRequests),
    ageSec: Number(age),
    // 已申请解押的押金一律按 0 算：它公示期一到就会被取走，
    // 而你的交易可能还没结束。不能依赖的钱不算数。
    committed: committed,
  };
}

// ------------------------------------------------------------------ 风险评估

/**
 * 针对**这一笔具体交易**算缺口。
 *
 * 核心问题不是「对方信誉好不好」，而是：
 *   对方骗成这一笔能净赚多少？ = 他能拿走的 − 他会被罚没的
 *
 * 如果这个数 ≤ 0，托管机制本身就已经把事情解决了 —— 作恶不划算，
 * 无论对方是谁、有没有记录。这是**最强的那种保障**，因为它不依赖
 * 任何人的判断，也不依赖仲裁层判得对不对。
 *
 * 只有在这个数 > 0 时，才轮到信誉说话：那个缺口需要由「他若跑路会
 * 失去的东西」来覆盖。而那些东西（押金、年龄、历史）都是软的 ——
 * 它们只是让作恶更贵，并不能保证不发生。
 *
 * 所以这个函数最有价值的输出，是它经常会告诉用户：
 * **别指望信誉，去把对方的保证金提到货款以上。**
 *
 * @param {object} a
 * @param {bigint} a.price            货款
 * @param {bigint} a.counterpartyBond 对方在这笔交易里的保证金（会被罚没的那部分）
 * @param {object|null} a.profile     对方的信誉档案
 */
export function assess({ price, counterpartyBond, profile }) {
  const gap = price - counterpartyBond;

  if (gap <= 0n) {
    return {
      level: "covered",
      gap: 0n,
      covered: 0n,
      reason: "对方保证金不低于货款，骗你这一笔的罚没大于收益，机制本身已经挡住了。",
    };
  }

  // 缺口只能由「他不愿失去的东西」来覆盖。
  // 只算身份押金：它是唯一一个金额确定、且他必须等 14 天公示才能取走的数字。
  // 历史笔数和年龄换算不成钱，只作为定性参考。
  const covered = profile ? profile.committed : 0n;

  if (covered >= gap) {
    return { level: "partly", gap, covered, reason: "缺口小于对方的身份押金，跑路对他不划算，但这依赖他在乎这个身份。" };
  }
  return { level: "exposed", gap, covered, reason: "缺口没有被覆盖：骗成这一笔的收益，大于他会损失的一切。" };
}

/// 定性告警。每一条都对应一个具体的、见过的手法。
export function flags(profile, now = Math.floor(Date.now() / 1000)) {
  const out = [];
  if (!profile) return [{ level: "warn", text: "对方没有任何链上记录。这不代表他是骗子，但也没有任何东西可以佐证他不是。" }];

  if (profile.completed === 0 && profile.ageSec === 0) {
    out.push({ level: "warn", text: "全新身份：既无成交记录，也没有押金。创建这样一个地址的成本是零。" });
  }

  // 刷单最典型的形状：笔数不少，但来来回回就那么几个对手方
  if (profile.completed >= 5 && profile.counterparties <= 2) {
    out.push({
      level: "warn",
      text: `${profile.completed} 笔成交只涉及 ${profile.counterparties} 个对手方 —— 这是自己跟自己刷的形状。`,
    });
  }

  if (profile.disputesLost > 0) {
    out.push({ level: "danger", text: `有 ${profile.disputesLost} 次被仲裁判定败诉，保证金被罚没过。` });
  }
  if (profile.nonDelivery > 0) {
    out.push({ level: "danger", text: `有 ${profile.nonDelivery} 次收了单却逾期未交付。` });
  }

  if (profile.unbondableAt > 0) {
    out.push({
      level: "danger",
      text: "对方正在申请撤回身份押金 —— 公示期一到押金就会被取走，现在看到的余额不能依赖。",
    });
  } else if (profile.unbondRequests >= 2) {
    out.push({ level: "warn", text: `历史上发起过 ${profile.unbondRequests} 次撤押申请又撤销，这个模式值得留意。` });
  }

  // 长年龄 + 刚堆高的押金：年龄是真的，但那笔钱是三天前才进来的
  if (profile.ageSec > 90 * 86400 && profile.toppedUpAt > 0 && now - profile.toppedUpAt < 7 * 86400) {
    out.push({ level: "warn", text: "身份年龄很长，但押金是最近一周才加上去的 —— 金额和年龄未必是一回事。" });
  }

  return out;
}

// ------------------------------------------------------------------ 排版

export const fmtAge = (sec) => {
  if (sec <= 0) return "无";
  const d = Math.floor(sec / 86400);
  if (d >= 365) return `${Math.floor(d / 365)} 年 ${d % 365} 天`;
  if (d >= 1) return `${d} 天`;
  return `${Math.floor(sec / 3600)} 小时`;
};

/// 年龄的展示。
///
/// 不能直接用 fmtAge(ageSec)：合约的 ageOf() 在「没有押金」和「押金是这一秒
/// 刚押的」两种情况下都返回 0。直接渲染会出现「年龄 无 / 押金 500」这种
/// 自相矛盾的一行，读起来像是这个人根本没押金。
export const ageLabel = (p) => {
  if (!p || (p.bondAmount === 0n && p.committed === 0n)) return "无";
  return p.ageSec < 3600 ? "不到 1 小时" : fmtAge(p.ageSec);
};

/// 所有动态内容都必须过 esc()。金额与年龄里含有 `.` `-`，
/// 漏一个 Telegram 会直接拒收整条消息（不是显示错乱，是根本发不出去）。
const amt = (raw, info) => esc(fmtAmount(raw, info));

const ICON = { covered: "🟢", partly: "🟡", exposed: "🔴" };

/**
 * 把档案 + 评估排成一段消息。返回 MarkdownV2 字符串。
 */
export function renderAssessment({ profile, assessment, info, roleLabel }) {
  const lines = [`*${esc(roleLabel)}信誉*`];

  if (!profile) {
    lines.push(esc("信誉层未启用或读取失败 —— 请自行谨慎评估对方。"));
    return lines.join("\n");
  }

  const total = profile.completed + profile.disputesWon;
  lines.push(
    `成交 ${total} 笔 · 对手方 ${profile.counterparties} 个 · 身份年龄 ${esc(ageLabel(profile))}`,
    `身份押金 ${amt(profile.committed, info)}${profile.unbondableAt > 0 ? esc("（撤回公示中）") : ""}`,
  );
  if (profile.disputesLost || profile.nonDelivery || profile.disputesInconclusive) {
    lines.push(
      `败诉 ${profile.disputesLost} · 未交付 ${profile.nonDelivery} · 未认定过错 ${profile.disputesInconclusive}`
    );
  }
  if (profile.feesBurned > 0n) {
    lines.push(esc("伪造这份记录至少要烧掉的手续费: ") + amt(profile.feesBurned, info));
  }

  lines.push("", `${ICON[assessment.level]} ${esc(assessment.reason)}`);

  if (assessment.level !== "covered") {
    lines.push(
      esc("机制缺口 ") + `*${amt(assessment.gap, info)}*` + esc("（货款 − 对方保证金）") +
      esc("，身份押金可覆盖 ") + amt(assessment.covered, info)
    );
  }
  if (assessment.level === "exposed") {
    // 最有用的一句话：别去赌信誉，去改参数。
    lines.push("", esc("👉 最稳妥的做法不是相信对方，而是把对方的保证金提到不低于货款 —— 那样作恶在数学上就不划算了。"));
  }

  const fl = flags(profile);
  if (fl.length) {
    lines.push("", ...fl.map((f) => `${f.level === "danger" ? "🔴" : "⚠️"} ${esc(f.text)}`));
  }

  return lines.join("\n");
}
