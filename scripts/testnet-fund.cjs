/**
 * 给一组角色钱包打 gas 和测试币。
 *
 *   SETTLEMENT_TOKEN=0x... npx hardhat run scripts/testnet-fund.cjs --network bscTestnet
 *
 * 可重复执行：每个地址都是「补到目标值」，已经够数的跳过。
 * 这一点不只是省水 —— 公共 RPC 在连发二十几笔时几乎一定会断一次，
 * 而「补到目标值」让中断后重跑等于接着跑。
 *
 * 断线处理分两种，不能混：
 *   读操作（查余额、查回执）失败可以随便重试，重试不改变链上状态。
 *   发交易失败不能盲目重试 —— 交易可能已经广播，重发就是又花一次。
 * 所以这里发完只按哈希等回执，绝不重发；真正的兜底是外层重跑时的余额复查。
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
const PASSES = 4;                          // 外层最多重跑几轮

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 网络抖动，还是合约真的拒绝了？后者重试多少次都一样。 */
function transient(e) {
  const code = e.code || e.cause?.code || "";
  if (["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT", "TIMEOUT", "SERVER_ERROR",
       "NETWORK_ERROR", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ENOTFOUND"].includes(code)) return true;
  return /timeout|socket|fetch failed|ECONNRESET|502|503|504/i.test(e.message || "");
}

/** 只用来包读操作 —— 重试它们没有副作用。 */
async function read(label, fn, tries = 5) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); } catch (e) {
      if (!transient(e)) throw e;
      last = e;
      const ms = 800 * 2 ** (i - 1);
      console.log(`    ${label} 第 ${i} 次失败(${e.code || "timeout"})，${ms / 1000}s 后重试`);
      await sleep(ms);
    }
  }
  throw last;
}

/**
 * 发出去之后只按哈希轮询回执，永远不重发。
 *
 * 不用 waitForTransaction：hardhat 包装过的 provider 没实现它。
 * 而且自己轮询反而更贴合这里的需求 —— 每次查询都是独立的读操作，
 * 单次超时不影响下一次，也不会把「还没打包」和「RPC 断了」混为一谈。
 */
async function confirm(tx) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const rc = await read("查回执", () => ethers.provider.getTransactionReceipt(tx.hash));
    if (rc) {
      if (rc.status !== 1) throw new Error("交易 " + tx.hash + " 被回滚");
      return rc;
    }
    await sleep(1200);
  }
  throw Object.assign(new Error("回执 " + tx.hash + " 两分钟没出"), { code: "TIMEOUT" });
}

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
            await confirm(await deployer.sendTransaction({ to: w.address, value: need }));
            parts.push("补 gas " + ethers.formatEther(need));
          }
        } else parts.push("不给 gas");

        if (role !== "beneficiary") {
          const tb = await read("查币", () => token.balanceOf(w.address));
          if (tb >= mintAmt) parts.push("币 " + ethers.formatUnits(tb, decimals));
          else {
            // mint 无权限，直接给目标地址造，不用先给自己再转
            await confirm(await token.mint(w.address, mintAmt - tb));
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
