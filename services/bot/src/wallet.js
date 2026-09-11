import { ethers } from "ethers";

/// 钱包绑定。
///
/// 绑定只需要**地址**，不需要也永远不会索取私钥。
/// 但光有地址不够 —— 如果任何人都能声称自己是某个地址，
/// 就可以绑定别人的地址来窥探其全部交易，甚至冒充对方接收通知。
/// 所以必须证明对该地址的控制权：机器人出一个带随机 nonce 的挑战文本，
/// 用户在自己钱包里对它签名，机器人用 ecrecover 验证。
///
/// 这是标准的 "Sign-In with Ethereum" 思路，全程离线、零 gas、
/// 且签名内容本身不构成任何授权（不是交易，无法被重放去动钱）。

const CHALLENGE_TTL_MS = 10 * 60 * 1000; // 10 分钟

/// 挑战文本刻意写成人类可读的形式，让用户在钱包弹窗里能看懂自己在签什么。
/// 明确声明「这不是一笔交易」，是为了对抗那种诱导用户盲签的攻击习惯 ——
/// 用户越习惯于看不懂就签，越容易在真正危险的弹窗上点确认。
export function buildChallenge(telegramUserId, nonce, issuedAt = Date.now()) {
  return [
    "Trustless Escrow 钱包绑定",
    "",
    `Telegram 用户: ${telegramUserId}`,
    `随机串: ${nonce}`,
    `时间: ${new Date(issuedAt).toISOString()}`,
    "",
    "签名此消息以证明你控制该地址。",
    "这不是一笔交易，不会转移任何资产，也不授予任何权限。",
  ].join("\n");
}

export function newNonce() {
  return ethers.hexlify(ethers.randomBytes(16)).slice(2);
}

/**
 * 校验用户提交的签名。
 *
 * @returns {{ok: true, address: string} | {ok: false, reason: string}}
 */
export function verifyBinding({ telegramUserId, nonce, issuedAt, signature, claimedAddress }) {
  if (!nonce || !issuedAt) return { ok: false, reason: "没有待验证的绑定挑战，请先发 /bind" };

  if (Date.now() - issuedAt > CHALLENGE_TTL_MS) {
    return { ok: false, reason: "挑战已过期（超过 10 分钟），请重新发起 /bind" };
  }

  const message = buildChallenge(telegramUserId, nonce, issuedAt);

  let recovered;
  try {
    recovered = ethers.verifyMessage(message, signature.trim());
  } catch {
    return { ok: false, reason: "签名格式无法解析，请确认复制完整（0x 开头，132 个字符）" };
  }

  // 挑战文本里绑定了 telegramUserId 与一次性 nonce，
  // 所以签名无法被挪用到别的用户或别的绑定请求上。
  if (claimedAddress && recovered.toLowerCase() !== claimedAddress.toLowerCase()) {
    return { ok: false, reason: `签名恢复出的地址是 ${recovered}，与你声称的地址不一致` };
  }

  return { ok: true, address: ethers.getAddress(recovered) };
}
