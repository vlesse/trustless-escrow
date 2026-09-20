/**
 * 给一组角色钱包打 gas 和测试币。
 *
 *   SETTLEMENT_TOKEN=0x... npx hardhat run scripts/testnet-fund.cjs --network bscTestnet
 *
 * 可重复执行：已经够数的地址会跳过，不会重复打。
 * 这一点很重要 —— 排查问题时往往要反复跑，每跑一次就多花一次水
 * 的脚本会逼你去省着用，而省着用是模拟真实场景最不该有的约束。
 *
 * beneficiary 故意不给 gas：它是模拟冷钱包，只出现在 FeeVault 的构造参数里，
 * 全程不签任何交易。给它打钱反而会掩盖「这把私钥其实从没被用过」这个事实。
 */
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

const GAS_EACH = ethers.parseEther(process.env.GAS_EACH || "0.005");
const MINT_EACH = 1_000_000n;              // 个代币，按链上精度换算
const NO_GAS = new Set(["deployer", "beneficiary"]);

async function main() {
  const file = path.join(__dirname, "..", ".testnet-wallets.json");
  if (!fs.existsSync(file)) throw new Error("找不到 " + file + "，先跑 scripts/testnet-wallets.cjs");
  const wallets = JSON.parse(fs.readFileSync(file, "utf8"));

  const tokenAddr = process.env.SETTLEMENT_TOKEN;
  if (!tokenAddr || !ethers.isAddress(tokenAddr)) throw new Error("SETTLEMENT_TOKEN 缺失或不合法");
  const token = await ethers.getContractAt("MockTokenD", tokenAddr);
  const decimals = Number(await token.decimals());
  const mintAmt = MINT_EACH * 10n ** BigInt(decimals);

  const [deployer] = await ethers.getSigners();
  if (deployer.address.toLowerCase() !== wallets.deployer.address.toLowerCase()) {
    throw new Error(
      `当前签名者 ${deployer.address} 不是钱包文件里的 deployer ${wallets.deployer.address}；` +
      "DEPLOYER_PRIVATE_KEY 配错了");
  }

  console.log("结算币", tokenAddr, `(${decimals} 位)`);
  console.log("出资方", deployer.address,
    ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "BNB\n");

  for (const [role, w] of Object.entries(wallets)) {
    const line = role.padEnd(12) + w.address + "  ";
    const parts = [];

    if (!NO_GAS.has(role)) {
      const bal = await ethers.provider.getBalance(w.address);
      if (bal >= GAS_EACH) {
        parts.push("gas 已有 " + ethers.formatEther(bal));
      } else {
        const need = GAS_EACH - bal;
        await (await deployer.sendTransaction({ to: w.address, value: need })).wait();
        parts.push("补 gas " + ethers.formatEther(need));
      }
    } else {
      parts.push("不给 gas");
    }

    if (role !== "beneficiary") {
      const tb = await token.balanceOf(w.address);
      if (tb >= mintAmt) {
        parts.push("币已有 " + ethers.formatUnits(tb, decimals));
      } else {
        // mint 无权限，直接给目标地址造，不用先给自己再转
        await (await token.mint(w.address, mintAmt - tb)).wait();
        parts.push("铸币 " + ethers.formatUnits(mintAmt - tb, decimals));
      }
    } else {
      parts.push("不给币");
    }

    console.log(line + parts.join("，"));
  }

  console.log("\n出资方余额",
    ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "BNB");
}

main().catch((e) => { console.error(e); process.exit(1); });
