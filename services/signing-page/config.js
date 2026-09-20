/**
 * 部署方需要编辑的唯一文件。
 *
 * 这里的 factory 地址是安全校验的锚点：页面会用它验证
 * 「这笔交易的目标真的是本协议的托管合约」。填错或留空，
 * 页面会拒绝签名而不是放行 —— 宁可不可用，也不能让用户
 * 在一个未经验证的合约上点确认。
 */
window.ESCROW_CONFIG = {
  chains: {
    97: {
      name: "BNB Smart Chain Testnet",
      rpcUrl: "https://bsc-testnet-rpc.publicnode.com",
      explorer: "https://testnet.bscscan.com",
      factory: "0x0000000000000000000000000000000000000000",
      // 信誉层（可选）。留空则页面拒绝为身份押金相关调用放行 ——
      // 无法验证目标地址时，不放行才是正确的默认。
      identityBond: "",
      reputation: "",
      // 商家额度池（可选）。留空则页面拒绝为额度相关调用放行。
      merchantBond: "",
      nativeCurrency: { name: "BNB", symbol: "tBNB", decimals: 18 },
    },
    56: {
      name: "BNB Smart Chain",
      rpcUrl: "https://bsc-dataseed.bnbchain.org",
      explorer: "https://bscscan.com",
      factory: "0x0000000000000000000000000000000000000000",
      identityBond: "",
      reputation: "",
      merchantBond: "",
      nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    },
    31337: {
      name: "本地测试链",
      rpcUrl: "http://127.0.0.1:8545",
      explorer: "",
      factory: "0x0000000000000000000000000000000000000000",
      // 信誉层（可选）。留空则页面拒绝为身份押金相关调用放行 ——
      // 无法验证目标地址时，不放行才是正确的默认。
      identityBond: "",
      reputation: "",
      // 商家额度池（可选）。留空则页面拒绝为额度相关调用放行。
      merchantBond: "",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    },
  },
};
