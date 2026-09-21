require("@nomicfoundation/hardhat-chai-matchers");
require("@nomicfoundation/hardhat-ethers");

/**
 * 部署私钥从环境变量读，不落盘、不进仓库（.env 已在 .gitignore 里）。
 *
 * 缺失时返回空数组而不是抛错：本地 `npx hardhat test` 用的是内置账户，
 * 不该因为没配部署私钥就跑不起来。真要往外部网络发交易时，
 * ethers 会在那一刻报「没有 signer」——该失败的地方失败，别的地方别挡路。
 */
function accounts(name) {
  const k = process.env[name];
  if (!k) return [];
  return [k.startsWith("0x") ? k : `0x${k}`];
}

/**
 * 目标链是 BNB Chain。
 *
 * 选它的过程可以用 scripts/chain-cost.cjs 复现：按「买卖双方各自的 gas
 * + 1% 手续费」占单额的比例算，BSC 几乎没有最小单额下限，
 * 而 TRON 要 $1500 起、以太坊主网更高。用户群手里是 TRC20 的 USDT，
 * TRON 那条腿以后再补，专门承大单。
 *
 * 测试网必须和目标主网同一条：gas 模型、区块时间、重组行为都不一样，
 * 换条链测出来的成本和时序不能外推到上线后。
 *
 * @type import('hardhat/config').HardhatUserConfig
 */
module.exports = {
  solidity: {
    version: "0.8.26",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  paths: { sources: "./contracts", tests: "./test", cache: "./cache", artifacts: "./artifacts" },
  networks: {
    bscTestnet: {
      // publicnode 读很稳，但发交易时反复吃 UND_ERR_HEADERS_TIMEOUT；
      // 官方 dataseed 在同一台机器上没这个问题。真断了用 BSC_TESTNET_RPC_URL 换。
      url: process.env.BSC_TESTNET_RPC_URL || "https://data-seed-prebsc-1-s1.bnbchain.org:8545",
      chainId: 97,
      accounts: accounts("DEPLOYER_PRIVATE_KEY"),
      // 宁可快点失败再重试，也不要挂在那里等一个不会来的响应
      timeout: 60_000,
    },
    bsc: {
      url: process.env.BSC_RPC_URL || "https://bsc-dataseed.bnbchain.org",
      chainId: 56,
      accounts: accounts("DEPLOYER_PRIVATE_KEY"),
    },
  },
};
