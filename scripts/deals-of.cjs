/**
 * 列出某个地址参与过的全部托管合约，以及每一笔的当前状态。
 *
 *   PARTY=0x... npx hardhat run scripts/deals-of.cjs --network bscTestnet
 *
 * 用工厂的 dealsOf 反查，**不读日志**。日志在公共 RPC 上只保留约 5 万个
 * 区块 —— BSC 上是六个多小时，隔夜再查就什么都没有了。dealsOf 是合约存储，
 * 只要链还在就查得到。机器人当初「重启后忘记全部交易」就是踩的这个坑。
 *
 * 不传 PARTY 就只打印本地测试钱包的地址（只有地址，不碰私钥），
 * 用来确认哪个角色对应哪个地址。
 */
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { read } = require("./lib/rpc.cjs");

const ROOT = path.join(__dirname, "..");
const D = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments-bscTestnet.json"), "utf8"));
const STATE = ["None", "Open", "Funded", "Delivered", "Disputed", "Resolved", "Cancelled"];

const until = (deadline, now) => {
  if (!deadline) return "—";
  const d = Number(deadline) - now;
  if (d <= 0) return "已过期 " + Math.floor(-d / 60) + " 分钟";
  if (d < 3600) return "还剩 " + Math.floor(d / 60) + " 分钟";
  if (d < 86400) return "还剩 " + (d / 3600).toFixed(1) + " 小时";
  return "还剩 " + (d / 86400).toFixed(1) + " 天";
};

async function main() {
  const W = JSON.parse(fs.readFileSync(path.join(ROOT, ".testnet-wallets.json"), "utf8"));
  console.log("本地测试钱包：");
  for (const [role, w] of Object.entries(W)) {
    const addr = w.address ?? new ethers.Wallet(w.privateKey).address;
    console.log("  " + role.padEnd(12) + addr);
  }
  console.log();

  const party = process.env.PARTY;
  if (!party) return;
  if (!ethers.isAddress(party)) throw new Error("PARTY 不是合法地址");

  const factory = await ethers.getContractAt("EscrowFactory", D.escrowFactory);
  const token = await ethers.getContractAt("MockTokenD", D.settlementToken);
  const dec = Number(await read("读精度", () => token.decimals()));
  const f = (x) => ethers.formatUnits(x, dec);

  const n = Number(await read("读笔数", () => factory.dealsOfLength(party)));
  console.log(`工厂 ${D.escrowFactory}`);
  console.log(`${party} 共 ${n} 笔\n`);

  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < n; i++) {
    const addr = await read("读地址", () => factory.dealsOf(party, i));
    const deal = await ethers.getContractAt("Escrow", addr);
    const s = await read("读摘要", () => deal.summary());
    // 角色从合约里读，不靠 PARTY 参数猜 —— 同一个地址完全可能
    // 在这笔里是买家、在下一笔里是卖家。
    const buyer = await read("读买家", () => deal.buyer());
    const seller = await read("读卖家", () => deal.seller());
    const mine = buyer.toLowerCase() === party.toLowerCase() ? "买家" : "卖家";

    console.log(`[${i}] ${addr}`);
    console.log(`    状态 ${STATE[Number(s.s)]}   你是${mine}   锁定 ${f(s.locked)} USDT`);
    console.log(`    买家已入金 ${s.bFunded ? "是" : "否"}   卖家已入金 ${s.sFunded ? "是" : "否"}`);
    console.log(`    买家 ${buyer}`);
    console.log(`    卖家 ${seller}`);
    console.log(`    交付期 ${until(s.dDeadline, now)}   验收期 ${until(s.iDeadline, now)}`);
    console.log();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
