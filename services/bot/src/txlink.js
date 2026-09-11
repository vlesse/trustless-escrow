import { ethers } from "ethers";
import { config } from "./config.js";

/// 交易签名链接生成。
///
/// 这是「机器人不接触私钥」这一属性的落地方式：
/// 机器人只负责把调用编码成 calldata，用户拿着它在自己的钱包里签名并广播。
/// 机器人没有、也无法获得任何签名能力。
///
/// 提供三种交付方式，按钱包支持度从好到差排列，同时全给出来，
/// 用户用哪个都行：
///   1. 签名页链接（配置了 SIGNING_PAGE_URL 时）—— 体验最好
///   2. EIP-681 URI —— 部分钱包可直接唤起
///   3. 原始 to + calldata —— 任何钱包都能手工粘贴，永远可用
///
/// 第 3 条是刻意保留的：它让整套东西在签名页挂掉、
/// 甚至在机器人被封禁时仍然可用。用户的资金不应当依赖本机器人存活。

export const FACTORY_ABI = [
  "function createDeal(address token, address buyer, address seller, uint256 price, uint256 buyerBond, uint256 sellerBond, uint64 deliveryWindow, uint64 inspectionWindow, bytes32 termsHash) returns (address)",
];

export const ESCROW_ABI = [
  "function depositBuyer()",
  "function depositSeller()",
  "function cancelUnfunded()",
  "function markDelivered(string evidenceURI)",
  "function confirmReceipt()",
  "function settleAfterInspection()",
  "function claimNonDelivery()",
  "function raiseDispute(string evidenceURI)",
  "function submitEvidence(string evidenceURI)",
];

export const ERC20_ABI = ["function approve(address spender, uint256 amount) returns (bool)"];

const ifaces = {
  factory: new ethers.Interface(FACTORY_ABI),
  escrow: new ethers.Interface(ESCROW_ABI),
  erc20: new ethers.Interface(ERC20_ABI),
};

/**
 * 构造一个交易请求。不签名、不广播，只是编码。
 * @returns {{to: string, data: string, value: string, chainId: number, label: string}}
 */
export function buildTx(kind, to, method, args, label) {
  const iface = ifaces[kind];
  if (!iface) throw new Error(`未知的合约类型: ${kind}`);
  return {
    to: ethers.getAddress(to),
    data: iface.encodeFunctionData(method, args),
    value: "0",
    chainId: config.chainId,
    label,
  };
}

/// 签名页链接。参数用 base64url 编码，避免在 URL 里出现需要转义的字符。
export function toSigningLink(tx) {
  if (!config.signingPageUrl) return null;
  const payload = Buffer.from(
    JSON.stringify({ to: tx.to, data: tx.data, value: tx.value, chainId: tx.chainId })
  ).toString("base64url");
  return `${config.signingPageUrl}#tx=${payload}`;
}

/// EIP-681。对于带 calldata 的合约调用，规范支持有限，
/// 这里用 functionName + 参数的形式，钱包支持度参差，所以只作为备选之一。
export function toEip681(tx) {
  return `ethereum:${tx.to}@${tx.chainId}?value=0&data=${tx.data}`;
}

/// ERC20 授权。额度只给本次所需，不做无限授权 ——
/// 无限授权把用户余额长期暴露给一个合约，而托管合约每笔只需要固定金额。
export function buildApprove(token, spender, amount) {
  return buildTx("erc20", token, "approve", [spender, amount], `授权 ${spender.slice(0, 10)}… 划转代币`);
}

/// 入金需要两笔交易：先授权，再入金。顺序不能反。
export function buildDepositFlow({ token, escrow, amount, role }) {
  return [
    buildApprove(token, escrow, amount),
    buildTx("escrow", escrow, role === "buyer" ? "depositBuyer" : "depositSeller", [],
      role === "buyer" ? "买家入金（货款 + 保证金）" : "卖家入金（保证金）"),
  ];
}

export function buildCreateDeal(params) {
  return buildTx("factory", config.escrowFactory, "createDeal", [
    params.token, params.buyer, params.seller,
    params.price, params.buyerBond, params.sellerBond,
    params.deliveryWindow, params.inspectionWindow, params.termsHash,
  ], "创建交易");
}

export const buildAction = (escrow, method, args, label) =>
  buildTx("escrow", escrow, method, args, label);
