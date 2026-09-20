/// 陪审团抽选的风险预警。
///
/// ## 预警的收件人不是运营方
///
/// 这一点决定了整个模块的形态。如果告警的终点是「运营者看到之后人工介入」，
/// 那就等于把整个项目花力气干掉的那个单点又请回来了。
///
/// 纠错手段本来就是开放的 —— 任何人都可以自费上诉。缺的只是**有人注意到**。
/// 所以告警是**公开广播**：把可疑的抽选结果连同数字一起摆出来，
/// 让愿意上诉的人自己判断。运营方在这里没有任何特权。
///
/// ## 最强的信号是纯算术，而且它不该等到出事才报
///
/// 「买通过半席位的成本」对着「案值」一比就知道这个案子会不会被买。
/// 这一条已经前置成硬约束了（工厂的单笔案值上限 + 下单时的提示），
/// 这里是第二道：前置那道只看下单那一刻，而质押池是会变的。
import { ethers } from "ethers";
import { fmtAmount } from "./deals.js";
import { esc } from "./telegram.js";
import { getLogs, blockTimeSeconds, DEFAULT_MAX_RANGE } from "./logs.js";

export const JURY_ALERT_ABI = [
  "event CaseCreated(uint256 indexed id, address indexed arbitrable, uint64 drawBlock, uint256 value)",
  "event JurorsDrawn(uint256 indexed id, uint256 indexed round, address[] drawn, uint64 commitDeadline)",
  "event Staked(address indexed juror, uint256 amount, uint256 total)",
  "function cases(uint256 id) view returns (tuple(address arbitrable,address feeToken,uint8 phase,uint8 ruling,uint64 drawBlock,uint64 commitDeadline,uint64 revealDeadline,uint64 appealDeadline,uint64 roundStartedAt,uint64 createdAt,uint64 rngRequestedAt,address rngSource,address dealBuyer,address dealSeller,uint256 value,uint256 baseCost))",
  "function juryCoverage() view returns (uint256)",
  "function totalStake() view returns (uint256)",
  "function stakeOf(address who) view returns (uint256)",
];

/// 抽签前多久的新质押算「为这个案子而来」。
export const FRESH_STAKE_WINDOW = 3 * 24 * 3600;

/// 回溯新质押时最多切几片。BSC 上三天约 57.6 万个区块，按每片 20000 算是 29 片；
/// 留 40 片的余量，再长就只查一部分并在告警里说明，而不是默默少报。
export const MAX_FRESH_LOOKBACK_CHUNKS = 40;

/// 抽中席位的质押占全池比例超过这个数，就意味着买通他们几乎等于买通全池。
export const CONCENTRATION_THRESHOLD = 0.5;

/// 评估一次抽选。纯函数 —— 链上读什么、怎么读，不该和「怎么判断」混在一起。
///
/// @param drawn         抽中的席位（同一个地址可能出现多次，放回抽样）
/// @param stakeByJuror  { 地址: 质押量 }
/// @param freshStakers  抽签前不久才押进来的地址集合
export function assessDraw({ value, coverage, drawn, stakeByJuror, totalStake, freshStakers }) {
  const flags = [];
  const seats = drawn.length;
  const unique = [...new Set(drawn)];

  if (coverage > 0n && value > coverage) {
    flags.push({
      level: "danger",
      key: "value_over_coverage",
      text: `案值 ${value} 超过买通过半席位的成本 ${coverage} —— 买裁决比认输划算`,
    });
  }

  // 一个人占了过半席位：不需要「买通一群人」，买一个就够了。
  for (const a of unique) {
    const mine = drawn.filter((x) => x === a).length;
    if (seats > 0 && mine * 2 > seats) {
      flags.push({
        level: "danger",
        key: "single_juror_majority",
        text: `${a} 一个人占了 ${mine}/${seats} 个席位，买通他一个就能定这个案子`,
      });
    }
  }

  // 抽中的人手里握着全池的大头：抽选的分散性名存实亡。
  if (totalStake > 0n) {
    let held = 0n;
    for (const a of unique) held += stakeByJuror[a] ?? 0n;
    const ratio = Number((held * 10000n) / totalStake) / 10000;
    if (ratio >= CONCENTRATION_THRESHOLD) {
      flags.push({
        level: "warn",
        key: "concentration",
        text: `抽中的 ${unique.length} 个地址握着全池 ${(ratio * 100).toFixed(1)}% 的质押`,
      });
    }
  }

  // 有人在这个案子出现前不久才押进来 —— 这是「为某个案子而来」最典型的形状。
  const fresh = unique.filter((a) => freshStakers?.has?.(a));
  if (fresh.length > 0) {
    flags.push({
      level: "warn",
      key: "fresh_stake",
      text: `${fresh.length} 名抽中的陪审员是最近才押进来的`,
    });
  }

  const level = flags.some((f) => f.level === "danger") ? "danger"
    : flags.length > 0 ? "warn" : "ok";
  return { level, flags };
}

/// 渲染成一条公开广播。
///
/// 措辞上刻意不下结论：这些是**形状**，不是证据。说「此案已被操纵」会
/// 制造恐慌并让告警失去可信度；说清楚数字、让人自己判断，才用得住。
export function renderAlert({ id, round, assessment, value, coverage, info, explorerUrl }) {
  if (assessment.level === "ok") return null;

  const amt = (raw) => esc(info ? fmtAmount(raw, info) : String(raw));
  const head = assessment.level === "danger" ? "🔴 抽选结果值得复核" : "🟡 抽选结果有几处异常";

  const lines = [
    `*${head}*`,
    "",
    `案件 \`${id}\`　第 ${round + 1} 轮`,
    `案值 ${amt(value)}　买通过半席位的成本 ${amt(coverage)}`,
    "",
  ];
  for (const f of assessment.flags) {
    lines.push(`${f.level === "danger" ? "•" : "◦"} ${esc(f.text)}`);
  }
  lines.push(
    "",
    esc("这些是形状，不是证据。贴出来是因为纠错权对所有人开放 —— "),
    esc("裁决出来之后有 48 小时的上诉窗口，任何人都可以自费把它升到更大的一轮。"),
  );
  if (explorerUrl) lines.push("", esc(explorerUrl));
  return lines.join("\n");
}

/// 从链上把一次抽选所需的数据凑齐。
export async function collectDraw({ jury, id, round, drawn, value, provider, now }) {
  const c = new ethers.Contract(jury, JURY_ALERT_ABI, provider);
  const [coverage, totalStake] = await Promise.all([c.juryCoverage(), c.totalStake()]);

  const unique = [...new Set(drawn)];
  const stakeByJuror = {};
  for (const a of unique) stakeByJuror[a] = await c.stakeOf(a);

  // 抽签前不久押进来的地址。窗口内的 Staked 事件足够定位，
  // 不需要逐个回溯每个人的全部历史。
  const freshStakers = new Set();
  let freshWindowPartial = false;
  try {
    const latest = await provider.getBlockNumber();

    /*
     * 「三天内押进来的」要换算成区块数才能查日志，而换算系数在不同链上差
     * 两个数量级：以太坊 12 秒一块，BSC 0.45 秒一块。
     *
     * 原来这里写死回溯 50000 个区块。在 BSC 上那只有六个多小时 ——
     * 名义上查三天，实际上漏掉其中 92%，而且不会报任何错。
     * 这和固定 200000 那处是同一类错误：把区块数当成了时间单位。
     */
    const dt = (await blockTimeSeconds(provider)) ?? 12;
    const want = Math.ceil(FRESH_STAKE_WINDOW / dt);
    const cap = MAX_FRESH_LOOKBACK_CHUNKS * DEFAULT_MAX_RANGE;
    const span = Math.min(want, cap);
    freshWindowPartial = span < want;

    const iface = new ethers.Interface(JURY_ALERT_ABI);
    const logs = await getLogs({
      provider,
      filter: { address: jury, topics: [iface.getEvent("Staked").topicHash] },
      fromBlock: Math.max(0, latest - span),
      toBlock: latest,
    });
    for (const log of logs) {
      const ev = iface.parseLog(log);
      if (!ev || !unique.includes(ev.args.juror)) continue;
      const blk = await provider.getBlock(log.blockNumber);
      if (now - blk.timestamp <= FRESH_STAKE_WINDOW) freshStakers.add(ev.args.juror);
    }
  } catch {
    // 拿不到历史就不报这一条，而不是把整条告警丢掉。
    // 但「没查到」和「查不了」不是一回事，下面用 freshWindowPartial 区分。
    freshWindowPartial = true;
  }

  return { value, coverage, drawn, stakeByJuror, totalStake, freshStakers, freshWindowPartial };
}
