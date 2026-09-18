/// 商家额度池的读取与展示。
///
/// 额度池**不是**共享抵押 —— 每笔交易的卖家保证金仍然进到它自己那个托管
/// 合约里。池子只是个预付账户，省掉每单都要 approve 的那一步，
/// 并且让「我还接得动几单」变成一个链上可读的数。
///
/// 没配置 MERCHANT_BOND 时整个模块只回一句「未接入」，交易功能不受影响。
import { ethers } from "ethers";
import { config } from "./config.js";
import { fmtAmount, tokenInfo } from "./deals.js";
import { esc } from "./telegram.js";

export const MERCHANT_BOND_READ_ABI = [
  "function token() view returns (address)",
  "function balanceOf(address merchant) view returns (uint256)",
  "function ordersLeft(address merchant, uint256 bond) view returns (uint256)",
];
export const FACTORY_QUOTA_ABI = ["function merchantBond() view returns (address)"];
export const ESCROW_QUOTA_ABI = [
  "function bondPayer() view returns (address)",
  "function sellerBond() view returns (uint256)",
  "function seller() view returns (address)",
];

export const READ_ABIS = {
  MerchantBond: MERCHANT_BOND_READ_ABI,
  EscrowFactory: FACTORY_QUOTA_ABI,
  Escrow: ESCROW_QUOTA_ABI,
};

export const enabled = () => Boolean(config.merchantBond);

/// 读商家的额度。
///
/// 币种取自池子自己的 `token()`，而不是信任配置 —— 配错了会让用户
/// 授权错的代币，那笔钱就真的出去了。让合约自证是唯一可靠的做法。
export async function loadQuota(merchant, provider) {
  const pool = new ethers.Contract(config.merchantBond, MERCHANT_BOND_READ_ABI, provider);
  const token = await pool.token();
  const [balance, info] = await Promise.all([
    pool.balanceOf(merchant),
    tokenInfo(token, provider),
  ]);
  return { pool: config.merchantBond, token, balance, info };
}

/// 校验配置里的池子确实是工厂认可的那一个。
///
/// 配错的后果很难自己看出来：存进去的钱取得回来，但每一次 fundDeal 都会失败，
/// 因为托管合约只认创建时写死的那个代付方地址。与其让用户先存钱再撞墙，
/// 不如一开始就说清楚。
export async function poolMatchesFactory(provider) {
  try {
    const f = new ethers.Contract(config.escrowFactory, FACTORY_QUOTA_ABI, provider);
    const onChain = await f.merchantBond();
    return onChain.toLowerCase() === config.merchantBond.toLowerCase();
  } catch {
    return false;
  }
}

/// 这笔交易能不能走额度池付款。
export function fundability({ bondPayer, sellerBond, balance }) {
  if (!enabled()) return { ok: false, why: "disabled" };
  if (!bondPayer || bondPayer === ethers.ZeroAddress) return { ok: false, why: "not_enabled_on_deal" };
  if (bondPayer.toLowerCase() !== config.merchantBond.toLowerCase()) {
    return { ok: false, why: "other_pool" };
  }
  if (balance < sellerBond) return { ok: false, why: "insufficient", short: sellerBond - balance };
  return { ok: true };
}

const amt = (raw, info) => esc(fmtAmount(raw, info));

export function renderQuota({ balance, info, bond = 0n }) {
  const lines = [
    "*商家额度*",
    "",
    `可用额度: *${amt(balance, info)}*`,
  ];
  if (bond > 0n) {
    const left = balance / bond;
    lines.push(
      `按每单保证金 ${amt(bond, info)} 算，还接得动 *${left}* 单`,
    );
  }
  lines.push(
    "",
    esc("额度是你自己预存的钱，随时可以全额取回 —— 它还没有承担任何义务。"),
    esc("每开一单从这里扣掉一笔保证金，直接进那笔交易自己的托管合约。"),
    esc("结算后保证金回的是你的钱包，不是这个池子，所以要记得回来补。"),
  );
  return lines.join("\n");
}

/// 额度不足时说人话：差多少、会怎样、怎么办。
export function renderShort({ short, info }) {
  return [
    "*额度不足，这一单付不了保证金*",
    "",
    `还差: *${amt(short, info)}*`,
    "",
    esc("先补额度再来付这一单。也可以直接用钱包给托管合约入金 —— "),
    esc("额度池只是省一笔交易，不是必经之路。"),
  ].join("\n");
}
