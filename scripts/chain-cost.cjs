/**
 * 选链用的成本画像：量出链上动作的真实 gas，再按各条链的现价折成美元。
 *
 *   npx hardhat run scripts/chain-cost.cjs
 *
 * 为什么要量而不是拍脑袋：担保交易的手续费按成交额的百分比收，
 * 而 gas 按计算量收。两者一除就得到「gas 吃光全部手续费的订单额」——
 * 低于这个数的单子在经济上不成立。担保交易最常见的恰恰是小额单，
 * 所以这个下界直接决定产品能不能做。
 *
 * TRON 的能量单价和单笔上限从链上实时取（getchainparameters），
 * 币价从 CoinGecko 取。取不到时退回写死的兜底值，并在末行注明。
 */
const { ethers } = require("hardhat");
const { time, mine } = require("@nomicfoundation/hardhat-network-helpers");

const U = (n) => BigInt(Math.round(n * 1e6));
const PRICE = U(1000), BOND = U(1000), FEE_BPS = 100n;
const OPT_COST = U(100), JURY_COST = U(60), CHAL_BOND = U(50);
const MIN_STAKE = U(1000), STAKE_PER_VOTE = U(100), JURY_SIZE = 3n;
const SALT = ethers.id("cost-salt");
const commitment = (r, s, j) =>
  ethers.solidityPackedKeccak256(["uint8", "bytes32", "address"], [r, s, j]);

async function fetchJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  return r.json();
}

async function live() {
  const out = {
    trxSun: 100, maxFeeLimitTrx: 15000,
    px: { tron: 0.34, ethereum: 2600, binancecoin: 750 },
    ok: true,
  };
  try {
    const cp = await fetchJson("https://api.trongrid.io/wallet/getchainparameters");
    const m = Object.fromEntries(cp.chainParameter.map((p) => [p.key, p.value]));
    out.trxSun = Number(m.getEnergyFee);
    out.maxFeeLimitTrx = Number(m.getMaxFeeLimit) / 1e6;
  } catch { out.ok = false; }
  try {
    const d = await fetchJson(
      "https://api.coingecko.com/api/v3/simple/price?ids=tron,ethereum,binancecoin&vs_currencies=usd");
    out.px = { tron: d.tron.usd, ethereum: d.ethereum.usd, binancecoin: d.binancecoin.usd };
  } catch { out.ok = false; }
  return out;
}

async function main() {
  const L = await live();
  const [owner, buyer, seller, ben, proposer, challenger, j1, j2, j3, outsider] =
    await ethers.getSigners();

  const deployGas = [];
  const dep = async (n, ...a) => {
    const d = await (await ethers.getContractFactory(n)).deploy(...a);
    deployGas.push([n, (await d.deploymentTransaction().wait()).gasUsed]);
    return d;
  };

  const token = await dep("MockUSDT");
  const impl = await dep("Escrow");
  const vault = await dep("FeeVault", ben.address);
  const jury = await dep("StakedJury",
    await token.getAddress(), JURY_SIZE, MIN_STAKE, STAKE_PER_VOTE, owner.address);
  const nonce = await ethers.provider.getTransactionCount(owner.address);
  const predicted = ethers.getCreateAddress({ from: owner.address, nonce: nonce + 1 });
  const factory = await dep("EscrowFactory",
    await impl.getAddress(), predicted, await vault.getAddress(), FEE_BPS, owner.address);
  const opt = await dep("OptimisticArbitrator",
    await factory.getAddress(), await jury.getAddress(), proposer.address, owner.address);
  await dep("IdentityBond", await token.getAddress());
  await dep("Reputation", await factory.getAddress());
  await dep("MerchantBond", await token.getAddress(), await factory.getAddress());

  await (await jury.setCost(await token.getAddress(), JURY_COST)).wait();
  await (await opt.setCost(await token.getAddress(), OPT_COST, CHAL_BOND)).wait();
  for (const s of [buyer, seller, proposer, challenger, j1, j2, j3]) {
    await token.mint(s.address, U(1000000));
    await token.connect(s).approve(await opt.getAddress(), U(1000000));
    await token.connect(s).approve(await jury.getAddress(), U(1000000));
  }
  for (const j of [j1, j2, j3]) await jury.connect(j).stake(MIN_STAKE);

  const rec = async (bucket, label, tx) => {
    const rc = await (await tx).wait();
    bucket.push([label, rc.gasUsed]);
    return rc;
  };
  const th = ethers.keccak256(ethers.toUtf8Bytes("terms"));
  const newDeal = async () => {
    const rc = await (await factory.connect(seller).createDeal(
      await token.getAddress(), buyer.address, seller.address,
      PRICE, BOND, BOND, 3 * 86400, 2 * 86400, th)).wait();
    const a = rc.logs.find((l) => l.fragment?.name === "DealCreated").args.deal;
    return [await ethers.getContractAt("Escrow", a), a, rc.gasUsed];
  };

  // ---------- 顺利路径 ----------
  const happy = [];
  let [deal, dealAddr, g0] = await newDeal();
  happy.push(["createDeal 开单", g0]);
  await rec(happy, "approve 授权(卖)", token.connect(seller).approve(dealAddr, BOND));
  await rec(happy, "depositSeller 入押金", deal.connect(seller).depositSeller());
  await rec(happy, "approve 授权(买)", token.connect(buyer).approve(dealAddr, PRICE + BOND));
  await rec(happy, "depositBuyer 入货款", deal.connect(buyer).depositBuyer());
  await rec(happy, "markDelivered 发货", deal.connect(seller).markDelivered("ipfs://x"));
  await rec(happy, "confirmReceipt 收货", deal.connect(buyer).confirmReceipt());

  // ---------- 争议路径：顺利路径之外额外烧掉的 ----------
  const dispute = [];
  [deal, dealAddr] = await newDeal();
  await (await token.connect(seller).approve(dealAddr, BOND)).wait();
  await (await deal.connect(seller).depositSeller()).wait();
  await (await token.connect(buyer).approve(dealAddr, PRICE + BOND)).wait();
  await (await deal.connect(buyer).depositBuyer()).wait();
  await (await deal.connect(seller).markDelivered("ipfs://x")).wait();

  await rec(dispute, "raiseDispute 提起争议", deal.connect(buyer).raiseDispute("ipfs://claim"));
  const optID = await deal.disputeID();
  await rec(dispute, "propose AI 出提案", opt.connect(proposer).propose(optID, 1));
  await rec(dispute, "challenge 质押挑战", opt.connect(challenger).challenge(optID));
  await mine(11);
  await rec(dispute, "drawJurors 抽陪审员", jury.drawJurors(1n));

  const n = Number(await jury.voteCount(1n));
  const slots = [];
  for (let i = 0; i < n; i++) slots.push((await jury.votes(1n, i)).juror);
  const signerOf = (a) => [j1, j2, j3].find((s) => s.address === a);

  for (let i = 0; i < n; i++)
    await rec(dispute, "commitVote 投票 x" + n,
      jury.connect(signerOf(slots[i])).commitVote(1n, i, commitment(2, SALT, slots[i])));
  await time.increase(3 * 86400 + 1);
  await rec(dispute, "startReveal 开揭示", jury.startReveal(1n));
  for (let i = 0; i < n; i++)
    await rec(dispute, "revealVote 揭示 x" + n,
      jury.connect(signerOf(slots[i])).revealVote(1n, i, 2, SALT));
  await time.increase(2 * 86400 + 1);
  await rec(dispute, "tallyRound 计票", jury.connect(outsider).tallyRound(1n));
  await time.increase(2 * 86400 + 1);
  await rec(dispute, "finalize 结案传导", jury.connect(outsider).finalize(1n));

  // ---------- 汇总 ----------
  const sum = (a) => a.reduce((t, [, g]) => t + g, 0n);
  const show = (title, rows) => {
    console.log("");
    console.log("=== " + title + " ===");
    console.log("");
    const seen = new Map();
    for (const [l, g] of rows) seen.set(l, (seen.get(l) ?? 0n) + g);
    for (const [l, g] of seen) console.log("  " + l.padEnd(26) + String(g).padStart(9) + " gas");
    console.log("  " + "".padEnd(26, "-") + "---------");
    console.log("  " + "合计".padEnd(25) + String(sum(rows)).padStart(9) + " gas");
  };
  show("部署（一次性）", deployGas);
  show("顺利路径（每笔交易）", happy);
  show("争议路径（顺利路径之外额外产生）", dispute);

  const DEPLOY = sum(deployGas), HAPPY = sum(happy), DISPUTE = sum(dispute);
  const fee = Number(ethers.formatUnits((PRICE * FEE_BPS) / 10000n, 6));

  // 统一折成「每 gas 多少美元」。TRON 的能量与 EVM gas 大体一一对应。
  const evm = (gwei, usd) => gwei * 1e-9 * usd;
  const chains = [
    ["TRON (TRC20)", (L.trxSun / 1e6) * L.px.tron, "能量 " + L.trxSun + " sun/单位，烧 TRX"],
    ["以太坊主网", evm(8, L.px.ethereum), "8 gwei"],
    ["BNB Chain", evm(0.1, L.px.binancecoin), "0.1 gwei"],
    ["Arbitrum One", evm(0.01, L.px.ethereum), "0.01 gwei，不含 L1 数据费（偏低）"],
    ["Base", evm(0.005, L.px.ethereum), "0.005 gwei，同上"],
    ["Polygon PoS", evm(30, 0.35), "30 gwei，POL"],
  ];

  console.log("");
  console.log("=== 折成钱（1000 USDT 的单，1% 手续费 = " + fee.toFixed(2) + " USDT）===");
  console.log("");
  console.log("  " + "链".padEnd(15) + "部署一次".padStart(12) + "每笔交易".padStart(12) +
    "每场争议".padStart(12) + "   吃光手续费的订单额");
  for (const [name, perGas, note] of chains) {
    const d = Number(DEPLOY) * perGas;
    const h = Number(HAPPY) * perGas;
    const x = Number(DISPUTE) * perGas;
    console.log("  " + name.padEnd(15) +
      ("$" + d.toFixed(2)).padStart(12) +
      ("$" + h.toFixed(4)).padStart(12) +
      ("$" + x.toFixed(4)).padStart(12) +
      "   $" + (h * 100).toFixed(0).padStart(6) + "   " + note);
  }

  const juryTrx = Number(deployGas.find((r) => r[0] === "StakedJury")[1]) * L.trxSun / 1e6;
  console.log("");
  console.log("  TRON 单笔手续费上限 " + L.maxFeeLimitTrx + " TRX；" +
    "最大的一次部署 StakedJury 要 " + juryTrx.toFixed(0) + " TRX —— " +
    (juryTrx < L.maxFeeLimitTrx ? "在上限内，部署得下" : "超过上限，部署不了"));
  console.log("  行情：TRX $" + L.px.tron + " / ETH $" + L.px.ethereum + " / BNB $" + L.px.binancecoin +
    (L.ok ? "（实时）" : "（取数失败，用的兜底值）"));
}

main().catch((e) => { console.error(e); process.exit(1); });
