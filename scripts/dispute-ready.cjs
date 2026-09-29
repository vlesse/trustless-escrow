/**
 * 争议流程开跑之前的只读体检。不发任何交易。
 *
 *   npx hardhat run scripts/dispute-ready.cjs --network bscTestnet
 *
 * 争议一旦开始就要跑 7 天，中途发现陪审员池是空的、提案人没钱付保证金、
 * 或者 keeper 在干跑，这 7 天就白等了。所以先把每一个前提查一遍。
 *
 * gas 门槛 0.001 tBNB：BSC 测试网 0.1 gwei，一笔 30 万 gas 的交易约 0.00003，
 * 0.001 够发三十来笔。门槛定太高只会制造假警报。
 */
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { read } = require("./lib/rpc.cjs");

const ROOT = path.join(__dirname, "..");
const D = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments-bscTestnet.json"), "utf8"));
const W = JSON.parse(fs.readFileSync(path.join(ROOT, ".testnet-wallets.json"), "utf8"));

async function main() {
  const p = ethers.provider;
  const token = await ethers.getContractAt("MockTokenD", D.settlementToken);
  const opt = await ethers.getContractAt("OptimisticArbitrator", D.optimisticArbitrator);
  const jury = await ethers.getContractAt("StakedJury", D.stakedJury);
  const dec = Number(await read("精度", () => token.decimals()));
  const f = (x) => Number(ethers.formatUnits(x, dec)).toLocaleString("en-US");
  const bnb = (x) => Number(ethers.formatEther(x)).toFixed(4);
  let bad = 0;
  const check = (ok, msg) => { if (!ok) bad++; console.log((ok ? "  ✓ " : "  ✗ ") + msg); };

  console.log("仲裁层");
  const bond = await read("提案保证金", () => opt.bondOf(D.settlementToken));
  const optCost = await read("乐观层成本", () => opt.arbitrationCost(D.settlementToken, "0x"));
  const juryCost = await read("陪审团成本", () => jury.arbitrationCost(D.settlementToken, "0x"));
  check(bond > 0n, `提案/挑战保证金 ${f(bond)} USDT`);
  check(optCost > 0n, `乐观层仲裁成本 ${f(optCost)} USDT（从败诉方押金里扣）`);
  console.log(`    陪审团成本 ${f(juryCost)} USDT`);
  const wired = [await read("finalArbitrator", () => opt.finalArbitrator()),
                 await read("jury.upstream", () => jury.upstream())];
  check(wired[0].toLowerCase() === D.stakedJury.toLowerCase(), "乐观层 → 陪审团 已接上");
  check(wired[1].toLowerCase() === D.optimisticArbitrator.toLowerCase(), "陪审团只受理乐观层转来的案子");

  console.log("\n陪审员池");
  const [size, minStake, total] = await Promise.all([
    read("席位", () => jury.jurySize()), read("门槛", () => jury.minStake()), read("总质押", () => jury.totalStake()),
  ]);
  console.log(`    每轮 ${size} 席，最低质押 ${f(minStake)} USDT，池内总质押 ${f(total)} USDT`);
  let seated = 0;
  for (const r of ["juror1", "juror2", "juror3", "juror4", "juror5"]) {
    const a = W[r].address ?? new ethers.Wallet(W[r].privateKey).address;
    const [st, g] = await Promise.all([read("质押", () => jury.stakeOf(a)), read("gas", () => p.getBalance(a))]);
    if (st >= minStake) seated++;
    console.log(`    ${r}  质押 ${f(st).padStart(7)}  gas ${bnb(g)} tBNB`);
  }
  check(seated >= Number(size), `够资格的陪审员 ${seated} 人（至少要 ${size}）`);

  console.log("\n角色钱包");
  for (const r of ["seller", "buyer", "proposer", "challenger", "keeper"]) {
    const a = W[r].address ?? new ethers.Wallet(W[r].privateKey).address;
    const [u, g] = await Promise.all([read("余额", () => token.balanceOf(a)), read("gas", () => p.getBalance(a))]);
    const needU = ["proposer", "challenger"].includes(r) ? bond : r === "seller" ? 1000n * 10n ** BigInt(dec) : 0n;
    check(u >= needU && g >= ethers.parseEther("0.001"), `${r.padEnd(10)} ${f(u).padStart(10)} USDT   ${bnb(g)} tBNB   ${a}`);
  }

  console.log(bad ? `\n${bad} 项不满足` : "\n全部就绪");
  if (bad) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
