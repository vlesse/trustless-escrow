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

export const IDENTITY_BOND_ABI = [
  "function bond(uint256 amount)",
  "function requestUnbond()",
  "function cancelUnbond()",
  "function withdraw()",
];

export const REPUTATION_ABI = ["function record(address deal)"];

export const MERCHANT_BOND_ABI = [
  "function deposit(uint256 amount)",
  "function withdraw(uint256 amount)",
  "function fundDeal(address deal)",
];

const ifaces = {
  factory: new ethers.Interface(FACTORY_ABI),
  escrow: new ethers.Interface(ESCROW_ABI),
  erc20: new ethers.Interface(ERC20_ABI),
  identityBond: new ethers.Interface(IDENTITY_BOND_ABI),
  reputation: new ethers.Interface(REPUTATION_ABI),
  merchantBond: new ethers.Interface(MERCHANT_BOND_ABI),
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
    // 方法名留着给展示层用：同一个 label 在不同语境下要配不同的解释，
    // 而 kind 只说得出「这是个 ERC20 调用」，说不出「这是授权还是转账」。
    method,
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

/**
 * 消息签名页链接（绑定钱包用）。
 *
 * 原来只告诉用户「用 MetaMask 的 personal_sign」—— 而 MetaMask 插件**没有**
 * 给普通用户签任意消息的入口。这等于让绑定这一步对绝大多数人直接作废。
 *
 * 用 JSON 而不是直接把文本塞进 URL：绑定文本里有换行和中文，
 * 各家客户端对 URL 里这些字符的处理不一致，差一个字节签出来的就是另一个签名。
 */
export function toMessageLink(text) {
  if (!config.signingPageUrl) return null;
  const payload = Buffer.from(JSON.stringify({ text }), "utf8").toString("base64url");
  return `${config.signingPageUrl}#msg=${payload}`;
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

/// 存额度同样是两笔：先授权，再存入。
export function buildQuotaDeposit(token, pool, amount) {
  return [
    buildApprove(token, pool, amount),
    buildTx("merchantBond", pool, "deposit", [amount], "存入额度"),
  ];
}

export const buildQuotaWithdraw = (pool, amount) =>
  buildTx("merchantBond", pool, "withdraw", [amount], "取回额度");

/// 用额度支付某笔交易的卖家保证金。
/// 这是额度池存在的意义：它替代了「授权 + 入金」那两笔，只剩一笔。
export const buildFundDeal = (pool, deal) =>
  buildTx("merchantBond", pool, "fundDeal", [deal], "用额度支付保证金");

export function buildCreateDeal(params) {
  return buildTx("factory", config.escrowFactory, "createDeal", [
    params.token, params.buyer, params.seller,
    params.price, params.buyerBond, params.sellerBond,
    params.deliveryWindow, params.inspectionWindow, params.termsHash,
  ], "创建交易");
}

export const buildAction = (escrow, method, args, label) =>
  buildTx("escrow", escrow, method, args, label);

/// 押入身份押金：同样是先授权再押入，与交易入金一致。
export function buildBondFlow(token, amount) {
  return [
    buildApprove(token, config.identityBond, amount),
    buildTx("identityBond", config.identityBond, "bond", [amount], "押入身份押金"),
  ];
}

export const buildBondAction = (method, label) =>
  buildTx("identityBond", config.identityBond, method, [], label);

/// 把一笔已结束交易的结果推上链。任何人都能调用 ——
/// 所以受害者可以自己推送关于骗子的败诉记录，骗子无法压制。
export const buildRecord = (deal) =>
  buildTx("reputation", config.reputation, "record", [deal], "记录交易结果");
