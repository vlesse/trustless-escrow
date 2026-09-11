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
    42161: {
      name: "Arbitrum One",
      rpcUrl: "https://arb1.arbitrum.io/rpc",
      explorer: "https://arbiscan.io",
      factory: "0x0000000000000000000000000000000000000000",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    },
    31337: {
      name: "本地测试链",
      rpcUrl: "http://127.0.0.1:8545",
      explorer: "",
      factory: "0x0000000000000000000000000000000000000000",
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    },
  },
};
