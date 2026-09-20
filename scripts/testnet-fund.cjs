/**
 * 给一组角色钱包打 gas 和测试币。
 *
 *   SETTLEMENT_TOKEN=0x... npx hardhat run scripts/testnet-fund.cjs --network bscTestnet
 *
 * 可重复执行：每个地址都是「补到目标值」，已经够数的跳过。
 * 这一点不只是省水 —— 公共 RPC 在连发二十几笔时几乎一定会断一次，
 * 而「补到目标值」让中断后重跑等于接着跑。
 *
 * 断线韧性见 lib/rpc.cjs：读操作重试、发交易绝不重发。
 * 这里的兜底是外层重跑时的余额复查 —— 之所以成立，是因为每一步都是
 * 「补到目标值」而不是「发一笔」。
 *
 * beneficiary 故意不给 gas：它是模拟冷钱包，只出现在 FeeVault 的构造参数里，
 * 全程不签任何交易。给它打钱反而会掩盖「这把私钥其实从没被用过」这个事实。
 */
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { sleep, transient, read, confirm: confirmTx } = require("./lib/rpc.cjs");

const GAS_EACH = ethers.parseEther(process.env.GAS_EACH || "0.005");
const MINT_EACH = 1_000_000n;              // 个代币，按链上精度换算
const NO_GAS = new Set(["deployer", "beneficiary"]);
const PASSES = 4;                          // 外层最多重跑几轮

async function main() {
  const file = path.join(__dirname, "..", ".testnet-wallets.json");
  if (!fs.existsSync(file)) throw new Error("找不到 " + file + "，先跑 scripts/testnet-wallets.cjs");
  const wallets = JSON.parse(fs.readFileSync(file, "utf8"));

  const tokenAddr = process.env.SETTLEMENT_TOKEN;
  if (!tokenAddr || !ethers.isAddress(tokenAddr)) throw new Error("SETTLEMENT_TOKEN 缺失或不合法");
  const token = await ethers.getContractAt("MockTokenD", tokenAddr);
  const decimals = Number(await read("读精度", () => token.decimals()));
  const mintAmt = MINT_EACH * 10n ** BigInt(decimals);

  const [deployer] = await ethers.getSigners();
  if (deployer.address.toLowerCase() !== wallets.deployer.address.toLowerCase()) {
    throw new Error(
      `当前签名者 ${deployer.address} 不是钱包文件里的 deployer ${wallets.deployer.address}；` +
      "DEPLOYER_PRIVATE_KEY 配错了");
  }

  console.log("结算币", tokenAddr, `(${decimals} 位)`);
  console.log("出资方", deployer.address, "\n");

  for (let pass = 1; pass <= PASSES; pass++) {
    if (pass > 1) console.log(`\n--- 第 ${pass} 轮：只处理上一轮没做完的 ---`);
    let pending = 0;

    for (const [role, w] of Object.entries(wallets)) {
      const parts = [];
      try {
        if (!NO_GAS.has(role)) {
          const bal = await read("查 gas", () => ethers.provider.getBalance(w.address));
          if (bal >= GAS_EACH) parts.push("gas " + ethers.formatEther(bal));
          else {
            const need = GAS_EACH - bal;
            await confirmTx(ethers.provider, await deployer.sendTransaction({ to: w.address, value: need }));
            parts.push("补 gas " + ethers.formatEther(need));
          }
        } else parts.push("不给 gas");

        if (role !== "beneficiary") {
          const tb = await read("查币", () => token.balanceOf(w.address));
          if (tb >= mintAmt) parts.push("币 " + ethers.formatUnits(tb, decimals));
          else {
            // mint 无权限，直接给目标地址造，不用先给自己再转
            await confirmTx(ethers.provider, await token.mint(w.address, mintAmt - tb));
            parts.push("铸币 " + ethers.formatUnits(mintAmt - tb, decimals));
          }
        } else parts.push("不给币");

        console.log(role.padEnd(12) + w.address + "  " + parts.join("，"));
      } catch (e) {
        if (!transient(e)) throw e;
        pending++;
        console.log(role.padEnd(12) + w.address + "  ✗ " + (e.code || e.shortMessage || "网络中断") + "，留到下一轮");
      }
    }

    if (pending === 0) {
      console.log("\n全部到位。出资方余额",
        ethers.formatEther(await read("查余额", () => ethers.provider.getBalance(deployer.address))), "BNB");
      return;
    }
    await sleep(3000);
  }

  throw new Error(`跑了 ${PASSES} 轮仍有地址没补齐，八成是 RPC 一直不通；换个 BSC_TESTNET_RPC_URL 再跑`);
}

main().catch((e) => { console.error(e); process.exit(1); });
