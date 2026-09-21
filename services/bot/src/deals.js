import { ethers } from "ethers";
import { config } from "./config.js";

export const State = {
  None: 0, Open: 1, Funded: 2, Delivered: 3, Disputed: 4, Resolved: 5, Cancelled: 6,
};

export const STATE_NAME = {
  0: "未初始化", 1: "待入金", 2: "已锁定·待交付", 3: "已交付·验收中",
  4: "争议中", 5: "已结算", 6: "已取消",
};

const ESCROW_READ_ABI = [
  "function token() view returns (address)",
  "function buyer() view returns (address)",
  "function seller() view returns (address)",
  "function price() view returns (uint256)",
  "function buyerBond() view returns (uint256)",
  "function sellerBond() view returns (uint256)",
  "function feeBps() view returns (uint16)",
  "function arbitrator() view returns (address)",
  "function termsHash() view returns (bytes32)",
  "function state() view returns (uint8)",
  "function buyerFunded() view returns (bool)",
  "function sellerFunded() view returns (bool)",
  "function deliveryDeadline() view returns (uint64)",
  "function inspectionDeadline() view returns (uint64)",
];

const FACTORY_READ_ABI = [
  "function dealsOf(address, uint256) view returns (address)",
  "function dealsOfLength(address) view returns (uint256)",
  "function isDeal(address) view returns (bool)",
  "function defaultArbitrator() view returns (address)",
];

const ERC20_READ_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function allowance(address,address) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];

export function makeProvider() {
  return new ethers.JsonRpcProvider(config.rpcUrl);
}

export const factoryAt = (provider) =>
  new ethers.Contract(config.escrowFactory, FACTORY_READ_ABI, provider);

export const escrowAt = (addr, provider) =>
  new ethers.Contract(addr, ESCROW_READ_ABI, provider);

const tokenCache = new Map();
export async function tokenInfo(addr, provider) {
  const key = addr.toLowerCase();
  if (tokenCache.has(key)) return tokenCache.get(key);
  const t = new ethers.Contract(addr, ERC20_READ_ABI, provider);
  const [decimals, symbol] = await Promise.all([
    t.decimals().catch(() => 18),
    t.symbol().catch(() => "TOKEN"),
  ]);
  const info = { address: addr, decimals: Number(decimals), symbol };
  tokenCache.set(key, info);
  return info;
}

export async function loadDeal(addr, provider) {
  const e = escrowAt(addr, provider);
  const [
    token, buyer, seller, price, buyerBond, sellerBond, feeBps, arbitrator,
    termsHash, state, buyerFunded, sellerFunded, deliveryDeadline, inspectionDeadline,
  ] = await Promise.all([
    e.token(), e.buyer(), e.seller(), e.price(), e.buyerBond(), e.sellerBond(),
    e.feeBps(), e.arbitrator(), e.termsHash(), e.state(), e.buyerFunded(),
    e.sellerFunded(), e.deliveryDeadline(), e.inspectionDeadline(),
  ]);

  return {
    address: ethers.getAddress(addr),
    token, buyer, seller,
    price, buyerBond, sellerBond,
    feeBps: Number(feeBps),
    arbitrator, termsHash,
    state: Number(state),
    buyerFunded, sellerFunded,
    deliveryDeadline: Number(deliveryDeadline),
    inspectionDeadline: Number(inspectionDeadline),
  };
}

export async function listDeals(address, provider, limit = 10) {
  const f = factoryAt(provider);
  const n = Number(await f.dealsOfLength(address));
  const out = [];
  for (let i = n - 1; i >= 0 && out.length < limit; i--) {
    out.push(await f.dealsOf(address, i));
  }
  return out;
}

export const roleOf = (deal, address) => {
  const a = address.toLowerCase();
  if (a === deal.buyer.toLowerCase()) return "buyer";
  if (a === deal.seller.toLowerCase()) return "seller";
  return null;
};

/**
 * 当前状态下该角色能做什么。
 *
 * 这份逻辑是合约状态机的镜像。做成纯函数是为了能独立测试 ——
 * 前端把不可用的操作显示成可点，用户会白白付一笔 gas 换一个 revert；
 * 把可用的操作藏起来，用户会以为自己的钱卡住了。两种都很伤。
 */
export function availableActions(deal, role, now = Math.floor(Date.now() / 1000)) {
  const acts = [];
  if (!role) return acts;

  const add = (id, label, hint) => acts.push({ id, label, hint });

  switch (deal.state) {
    case State.Open:
      if (role === "buyer" && !deal.buyerFunded) add("deposit", "入金（货款 + 保证金）");
      if (role === "seller" && !deal.sellerFunded) add("deposit", "入金（保证金）");
      add("cancel", "取消交易", "双方都完成入金前，任一方可无损退出");
      break;

    case State.Funded:
      if (role === "seller") {
        add("delivered", "标记已交付");
        if (now >= deal.deliveryDeadline) {
          add("dispute", "提起争议", "交付期已过，可对抗买家的未交付索赔");
        }
      }
      if (role === "buyer") {
        add("confirm", "确认收货并放款", "你可以随时主动放款");
        if (now >= deal.deliveryDeadline) {
          add("nondelivery", "索取退款", "卖家逾期未标记交付，可取回全款与保证金");
        }
      }
      break;

    case State.Delivered:
      if (now < deal.inspectionDeadline) {
        if (role === "buyer") {
          add("confirm", "确认收货并放款");
          add("dispute", "提起争议", `验收期${untilText(deal.inspectionDeadline, now)}。提起争议会停表`);
        }
      } else {
        add("settle", "结算给卖家", "验收期已过且无异议，任何人可推动");
      }
      break;

    case State.Disputed:
      add("evidence", "提交证据", "争议期内可持续补充");
      break;

    default:
      break;
  }
  return acts;
}

/// 金额格式化。永远带上符号和精度，不做四舍五入丢精度的显示 ——
/// 用户是按这个数字决定要不要点确认的。
export function fmtAmount(raw, info) {
  return `${ethers.formatUnits(raw, info.decimals)} ${info.symbol}`;
}

export const explorerAddr = (a) => `${config.explorerUrl}/address/${a}`;
export const explorerTx = (h) => `${config.explorerUrl}/tx/${h}`;

/// 条款哈希。链上只存哈希，原文由双方各自保管。
/// 争议时提交原文，哈希对得上才被仲裁层认定为真本。
export const hashTerms = (text) => ethers.keccak256(ethers.toUtf8Bytes(text));

/**
 * 截止时间一律显示成「还剩多久」，而不是绝对时刻。
 *
 * 机器人不知道每个用户在哪个时区，于是原来一律输出 UTC 的 ISO 时间串。
 * 一个中国用户看到 `2026-09-21T06:30:26.000Z`，要在脑子里加八小时才知道
 * 是下午两点半 —— 而他真正关心的问题从来都是「我还有多久」。
 *
 * 相对时间没有时区问题，也不需要换算。绝对时刻放在括号里备查。
 */
export function untilText(deadlineSec, now = Math.floor(Date.now() / 1000)) {
  const left = Number(deadlineSec) - now;
  if (left <= 0) return "已截止";
  const d = Math.floor(left / 86400);
  const h = Math.floor((left % 86400) / 3600);
  const m = Math.floor((left % 3600) / 60);
  if (d > 0) return `还剩 ${d} 天 ${h} 小时`;
  if (h > 0) return `还剩 ${h} 小时 ${m} 分`;
  return `还剩 ${m} 分钟`;
}

/// UTC 时刻，放在相对时间后面备查。写明 UTC，免得被当成本地时间。
export const utcText = (sec) =>
  new Date(Number(sec) * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
