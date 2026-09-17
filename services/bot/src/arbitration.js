/// 仲裁层的经济边界，展示给用户看。
///
/// 这一层回答两个问题，它们性质完全不同：
///
///   1. **这单能不能开？** 工厂上有一个运营方设的单笔案值上限。超了就开不出来，
///      这是硬闸。机器人必须在用户签名**之前**拦住，否则他会在自己钱包里
///      撞上一个看不懂的 revert。
///
///   2. **真闹到仲裁，机制扛得住吗？** 陪审团抗贿赂的能力来自「买通过半席位
///      要赔多少」，那是一组固定参数；案值却是浮动的。两者差距太大时，
///      这层保护就单薄了。合约不拿它拦人，但用户有权在入金前看到这个数。
import { ethers } from "ethers";
import { fmtAmount } from "./deals.js";
import { esc } from "./telegram.js";

export const FACTORY_READ_ABI = [
  "function maxDealValue(address token) view returns (uint256)",
  "function defaultArbitrator() view returns (address)",
];
export const OPTIMISTIC_READ_ABI = ["function finalArbitrator() view returns (address)"];
export const JURY_READ_ABI = ["function juryCoverage() view returns (uint256)"];

export const READ_ABIS = {
  EscrowFactory: FACTORY_READ_ABI,
  OptimisticArbitrator: OPTIMISTIC_READ_ABI,
  StakedJury: JURY_READ_ABI,
};

/// 案值 = 货款 + 双方押金。与合约里 Escrow.disputeValue() 同一口径 ——
/// 裁决无论判成哪一种，都是在这三笔之间重新分配。
export const dealValue = ({ price, buyerBond, sellerBond }) =>
  BigInt(price) + BigInt(buyerBond) + BigInt(sellerBond);

/// 硬闸：超了就根本开不出单。cap 为 0 表示没设上限。
export function capVerdict({ value, cap }) {
  if (!cap || cap === 0n) return { ok: true };
  if (value <= cap) return { ok: true };
  return { ok: false, over: value - cap };
}

/// 软提示：陪审团的经济承载力。coverage 取不到时返回 null —— 不知道就别报警，
/// 一个没有依据的警告只会训练用户忽略所有警告。
export function coverageVerdict({ value, coverage }) {
  if (coverage === null || coverage === undefined) return null;
  if (coverage === 0n) return null;
  if (value <= coverage) return { level: "ok", coverage, value };
  return { level: "thin", coverage, value, ratio: value / coverage };
}

/// 读链。每一段都是尽力而为：仲裁方可能根本不是本项目的陪审团
/// （接口留了 Kleros adapter 的口子），读不到就返回 null，不要让
/// 一个可选的提示把开单流程整个打掉。
export async function loadArbitration(token, factoryAddr, provider) {
  const out = { cap: null, coverage: null };
  try {
    const f = new ethers.Contract(factoryAddr, FACTORY_READ_ABI, provider);
    out.cap = await f.maxDealValue(token);
    const arb = await f.defaultArbitrator();
    let jury = arb;
    try {
      jury = await new ethers.Contract(arb, OPTIMISTIC_READ_ABI, provider).finalArbitrator();
    } catch {
      // 仲裁方直接就是终局方，没有乐观层这一跳
    }
    out.coverage = await new ethers.Contract(jury, JURY_READ_ABI, provider).juryCoverage();
  } catch {
    // 读不到就当没有，调用方按 null 处理
  }
  return out;
}

const amt = (raw, info) => esc(fmtAmount(raw, info));

/// 渲染成若干行 MarkdownV2。返回空数组表示没什么要说的。
export function renderArbitrationNotes({ value, cap, coverage, info }) {
  const lines = [`案值: ${amt(value, info)}　${esc("(货款 + 双方押金，争议时可被裁决改变归属的总额)")}`];

  const cov = coverageVerdict({ value, coverage });
  if (cov && cov.level === "thin") {
    lines.push(
      "",
      `⚠️ *这笔金额超出了陪审团的经济承载力*`,
      esc(`买通过半陪审员至少要覆盖 ${fmtAmount(coverage, info)}，而裁决能挪动 ${fmtAmount(value, info)}。`),
      esc("投票是先交哈希后统一揭晓，所以贿赂无法强制执行（收了钱照样可以诚实投票），"),
      esc("实际没有这个比例看起来那么脆。但差距越大，这层保护越单薄。"),
      esc("要更稳的话：把金额拆小，或者只和保证金不低于货款的对手方交易。"),
    );
  }
  return lines;
}

/// 超限时给用户的话。要说清楚三件事：为什么开不出来、上限是多少、怎么办。
export function renderCapRejection({ value, cap, info }) {
  return [
    "*这单开不出来：超过了当前的单笔上限*",
    "",
    `本单案值: ${amt(value, info)}`,
    `当前上限: ${amt(cap, info)}`,
    "",
    esc("上限是运营方设的风控，在合约没有经过第三方审计之前定得比较保守，"),
    esc("目的是把最坏损失封住。它拦在入金之前，所以你的钱一分都没动。"),
    "",
    esc("把货款或保证金调小到案值不超过上限即可。案值 = 货款 + 双方押金。"),
  ];
}
