/**
 * 收款地址体检：校验和是否正确、两条链上有没有钱 / 有没有动过。
 *
 *   node scripts/check-addr.cjs 0x....
 *
 * 为什么要做：提币地址填错一个字符，钱就永久没了——没有客服、没有撤回。
 * EIP-55 的大小写本身就是校验位，先过这一关。
 */
const { ethers } = require("ethers");

const NETS = [
  ["BSC 主网",   "https://bsc-dataseed.bnbchain.org",      "BNB",  "https://bscscan.com/address/"],
  ["BSC 测试网", "https://bsc-testnet-rpc.publicnode.com", "tBNB", "https://testnet.bscscan.com/address/"],
];

async function main() {
  const input = process.argv[2];
  if (!input) throw new Error("用法: node scripts/check-addr.cjs 0x...");

  let addr;
  try {
    addr = ethers.getAddress(input);           // 会同时校验长度和 EIP-55 校验和
  } catch (e) {
    console.log("✗ 地址不合法：" + e.shortMessage || e.message);
    process.exit(1);
  }
  console.log("地址        " + addr);
  console.log("校验和      ✓ 通过（EIP-55），且 " + (addr === input ? "与你给的完全一致" : "大小写被规范化了"));
  console.log("");

  for (const [name, url, sym, scan] of NETS) {
    try {
      const p = new ethers.JsonRpcProvider(url);
      const [bal, n, code] = await Promise.all([
        p.getBalance(addr), p.getTransactionCount(addr), p.getCode(addr),
      ]);
      console.log(name.padEnd(12) + ethers.formatEther(bal).padStart(12) + " " + sym +
        "   交易 " + n + " 笔   " + (code === "0x" ? "普通地址" : "合约地址(!)"));
      console.log("            " + scan + addr);
    } catch (e) {
      console.log(name.padEnd(12) + "查询失败：" + (e.shortMessage || e.message));
    }
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
