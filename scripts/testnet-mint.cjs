/**
 * 给某个地址铸测试用的结算币。
 *
 *   MINT_TO=0x... MINT_AMOUNT=100000 npx hardhat run scripts/testnet-mint.cjs --network bscTestnet
 *
 * MINT_AMOUNT 按**整数个代币**填，脚本按链上实际 decimals 换算 ——
 * 让人手填最小单位是在 BSC 上自找麻烦：这里的稳定币是 18 位，
 * 而以太坊/TRON 上是 6 位，照着别处的习惯抄一次就差一百万倍。
 *
 * 只对测试网上那个 mint 无权限的假币有效。真实的 USDT 不能这么来。
 */
const { ethers } = require("hardhat");
const { read, confirm } = require("./lib/rpc.cjs");

async function main() {
  const to = process.env.MINT_TO;
  if (!to || !ethers.isAddress(to)) throw new Error("MINT_TO 缺失或不是合法地址");

  const tokenAddr = process.env.SETTLEMENT_TOKEN;
  if (!tokenAddr || !ethers.isAddress(tokenAddr)) throw new Error("SETTLEMENT_TOKEN 缺失或不合法");

  const whole = BigInt(process.env.MINT_AMOUNT || "100000");
  if (whole <= 0n) throw new Error("MINT_AMOUNT 必须为正");

  const t = await ethers.getContractAt("MockTokenD", tokenAddr);
  const dec = Number(await read("读精度", () => t.decimals()));
  const amt = whole * 10n ** BigInt(dec);

  const before = await read("查余额", () => t.balanceOf(to));
  const rc = await confirm(ethers.provider, await t.mint(to, amt));

  /*
   * 铸完立刻查余额，必须**指定区块号**。
   *
   * 公共 RPC 后面是一组节点。回执已经能查到，不代表下一个请求落到的那台
   * 也同步到了那个高度 —— 实测就读回了铸币之前的旧值。
   * 一个以为没成功的人会再铸一次，于是多出一百万个代币，而链上一切正常。
   */
  const after = await read("查余额", () => t.balanceOf(to, { blockTag: rc.blockNumber }));
  if (after - before !== amt) {
    throw new Error(
      `对不上：铸了 ${ethers.formatUnits(amt, dec)}，但区块 ${rc.blockNumber} 上余额只增加了 ` +
      `${ethers.formatUnits(after - before, dec)}。别重试，先查 tx ${rc.hash}`);
  }

  console.log("结算币 " + tokenAddr + `（${dec} 位）`);
  console.log("收款   " + to);
  console.log("  之前 " + ethers.formatUnits(before, dec));
  console.log("  之后 " + ethers.formatUnits(after, dec) + "（按区块 " + rc.blockNumber + " 读）");
  console.log("  tx   " + rc.hash);
}

main().catch((e) => { console.error(e); process.exit(1); });
