/*
 * 取货钥匙：卡密的加密与解密。**只写这一份**，签名页（买家下单、取货）、
 * 卖家的自动发货程序、测试三处共用。
 *
 * ## 钥匙从哪来
 *
 * 买家用自己的钱包对一句固定的话签名，签名结果算哈希，就是取货私钥。
 * 同一个钱包对同一句话，每次签出来都一样（钱包按 RFC 6979 签名），所以：
 *   · 不用保存任何东西 —— 钱包在，钥匙就在
 *   · 换台电脑、清了浏览器，重新签一次就能取
 * 下单时只把公钥记上链；私钥只在买家浏览器里出现，用完即丢。
 *
 * 风险要说清楚：谁拿到这句话的签名，谁就能解开这个钱包收到的所有卡密。
 * 所以这句话里写明了「只在这个网站上签」，签名页也只在自己的页面里签它、
 * 从不把签名发给任何人。
 *
 * ## 加密格式（ECIES）
 *
 *   [1 字节 版本=1][33 字节 临时公钥][12 字节 IV][密文 + 16 字节 GCM 标签]
 *
 * 卖家每次用一把新的临时私钥和买家公钥做 ECDH，取共享点的 x 坐标做 SHA-256
 * 当 AES-256-GCM 的密钥。GCM 自带完整性校验：密文被改过一个字节，解密直接失败，
 * 不会解出一段看似正常的错误卡密。
 *
 * 争议时卖家可以公开这一单的临时私钥，任何人都能解开核对「当时交的到底是什么」。
 */
(function (root) {
  "use strict";

  const E = typeof module !== "undefined" && module.exports ? require("ethers") : root.ethers;
  const subtle = (typeof globalThis !== "undefined" && globalThis.crypto && globalThis.crypto.subtle) || null;
  const VERSION = 1;
  const N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");

  /// 买家要签的那句话。改一个字，所有旧订单的卡密都解不开了 —— 永远不要改。
  function pickupMessage(address) {
    return "人人担保 取货钥匙\n\n" +
      `钱包：${E.getAddress(address)}\n\n` +
      "这把钥匙用来解开卖家加密发给你的卡密。\n" +
      "只在 db.renrenyings.net 上签。别的网站让你签这句话，就是想偷你的卡密。";
  }

  /// 签名 → 取货私钥（SigningKey）。哈希落在曲线阶之外的概率可以忽略，但仍然处理掉。
  function keyFromSignature(signature) {
    let h = E.keccak256(signature);
    while (BigInt(h) === 0n || BigInt(h) >= N) h = E.keccak256(h);
    return new E.SigningKey(h);
  }

  async function aesKey(sharedPointHex, usage) {
    // computeSharedSecret 返回未压缩点 0x04||x||y，取 x
    const x = E.getBytes(sharedPointHex).slice(1, 33);
    const k = E.getBytes(E.sha256(x));
    return subtle.importKey("raw", k, { name: "AES-GCM" }, false, [usage]);
  }

  /// 卖家用：用买家的取货公钥（33 字节压缩格式）加密一段文字。返回 0x 开头的十六进制。
  async function seal(buyerPubKey, plaintext, ephemeral) {
    const eph = ephemeral || new E.SigningKey(E.hexlify(E.randomBytes(32)));
    const iv = E.randomBytes(12);
    const key = await aesKey(eph.computeSharedSecret(buyerPubKey), "encrypt");
    const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv }, key, E.toUtf8Bytes(plaintext)));
    return E.concat([new Uint8Array([VERSION]), eph.compressedPublicKey, iv, ct]);
  }

  /// 买家用：取货私钥 + 链上的密文 → 原文。钥匙不对或密文被改过都会抛错。
  async function open(signingKey, sealedHex) {
    const b = E.getBytes(sealedHex);
    if (b.length < 1 + 33 + 12 + 16 || b[0] !== VERSION) throw new Error("格式不认识");
    const ephPub = E.hexlify(b.slice(1, 34));
    const iv = b.slice(34, 46);
    const ct = b.slice(46);
    const key = await aesKey(signingKey.computeSharedSecret(ephPub), "decrypt");
    const pt = await subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
    return E.toUtf8String(new Uint8Array(pt));
  }

  const api = { pickupMessage, keyFromSignature, seal, open, VERSION };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.EscrowPickup = api;
})(typeof self !== "undefined" ? self : this);
