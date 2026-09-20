/**
 * 单笔交易的真实 gas 画像。
 *
 *   npx hardhat run scripts/gas-profile.cjs
 *
 * 为什么要有这个：选哪条链上线，取决于「一笔交易的 gas 成本」和
 * 「1% 手续费」的比值。这个比值决定了最小可做的订单金额 ——
 * gas 比手续费还贵的话，小额订单在经济上就是不成立的，
 * 而小额恰恰是担保交易最常见的形态。
 */
const { ethers } = require("hardhat");
const U = (n) => BigInt(Math.round(n * 1e6));
const PRICE = U(1000), BOND = U(1000), FEE_BPS = 100n;

const rows = [];
async function g(label, who, promise) {
  const rc = await (await promise).wait();
  rows.push({ label, who, gas: rc.gasUsed });
  return rc;
}

async function main() {
  const [owner, buyer, seller, ben, proposer] = await ethers.getSigners();
  const token = await (await ethers.getContractFactory("MockUSDT")).deploy();
  const vault = await (await ethers.getContractFactory("FeeVault")).deploy(ben.address);
  const impl = await (await ethers.getContractFactory("Escrow")).deploy();
  const arb = await (await ethers.getContractFactory("DirectArbitrator")).deploy();
  await arb.setCost(0);
  const factory = await (await ethers.getContractFactory("EscrowFactory")).deploy(
    await impl.getAddress(), await arb.getAddress(), await vault.getAddress(), FEE_BPS, owner.address);
  for (const s of [buyer, seller]) await token.mint(s.address, U(1000000));

  const th = ethers.keccak256(ethers.toUtf8Bytes("terms"));
  const rc = await g("createDeal 开单", "卖家", factory.connect(seller).createDeal(
    await token.getAddress(), buyer.address, seller.address,
    PRICE, BOND, BOND, 3*24*3600, 2*24*3600, th));
  const dealAddr = rc.logs.find(l => l.fragment?.name === "DealCreated").args.deal;
  const deal = await ethers.getContractAt("Escrow", dealAddr);

  await g("approve 授权", "卖家", token.connect(seller).approve(dealAddr, BOND));
  await g("depositSeller 卖家入押金", "卖家", deal.connect(seller).depositSeller());
  await g("approve 授权", "买家", token.connect(buyer).approve(dealAddr, PRICE + BOND));
  await g("depositBuyer 买家入货款", "买家", deal.connect(buyer).depositBuyer());
  await g("markDelivered 标记发货", "卖家", deal.connect(seller).markDelivered("ipfs://x"));
  await g("confirmReceipt 确认收货", "买家", deal.connect(buyer).confirmReceipt());

  console.log("\n=== 顺利路径：一笔交易的全部链上动作 ===\n");
  let total = 0n, byWho = {};
  for (const r of rows) {
    total += r.gas;
    byWho[r.who] = (byWho[r.who] ?? 0n) + r.gas;
    console.log("  " + r.label.padEnd(26) + r.who.padEnd(6) + String(r.gas).padStart(9) + " gas");
  }
  console.log("\n  合计 " + total + " gas   (" + Object.entries(byWho).map(([k,v]) => k+" "+v).join(" / ") + ")");

  const fee = (PRICE * FEE_BPS) / 10000n;
  console.log("\n=== 换算成钱：1000 USDT 的单，1% 手续费 = " + ethers.formatUnits(fee, 6) + " USDT ===\n");
  // gasPrice 单位 gwei，币价单位 USD
  const CHAINS = [
    ["Arbitrum One",  0.01,  3000],
    ["Base",          0.005, 3000],
    ["Polygon PoS",   30,    0.35],
    ["BNB Chain",     0.1,   900],
    ["以太坊主网",     8,     3000],
  ];
  for (const [name, gwei, price] of CHAINS) {
    const usd = Number(total) * gwei * 1e-9 * price;
    console.log("  " + name.padEnd(14) + "$" + usd.toFixed(4).padStart(9) +
      "   占手续费 " + (usd / Number(ethers.formatUnits(fee,6)) * 100).toFixed(2) + "%" +
      "   gas 等于手续费时的订单额 $" + (usd * 100).toFixed(2));
  }
}
main().catch(e => { console.error(e); process.exit(1); });
