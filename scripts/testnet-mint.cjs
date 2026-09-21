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

  console.log("结算币 " + tokenAddr + `（${dec} 位）`);
  console.log("收款   " + to);
  console.log("  之前 " + ethers.formatUnits(before, dec));
  console.log("  之后 " + ethers.formatUnits(await read("查余额", () => t.balanceOf(to)), dec));
  console.log("  tx   " + rc.hash);
}

main().catch((e) => { console.error(e); process.exit(1); });
