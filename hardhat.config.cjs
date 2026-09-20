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

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.26",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  paths: { sources: "./contracts", tests: "./test", cache: "./cache", artifacts: "./artifacts" },
  networks: {
    // 测试网必须和目标主网同一条链：gas 模型、区块时间、L1 数据费、重组行为
    // 都不一样，换一条链测出来的数字不能外推到上线后的成本和时序。
    arbitrumSepolia: {
      url: process.env.ARBITRUM_SEPOLIA_RPC_URL || "https://sepolia-rollup.arbitrum.io/rpc",
      chainId: 421614,
      accounts: accounts("DEPLOYER_PRIVATE_KEY"),
    },
    arbitrumOne: {
      url: process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc",
      chainId: 42161,
      accounts: accounts("DEPLOYER_PRIVATE_KEY"),
    },
  },
};
