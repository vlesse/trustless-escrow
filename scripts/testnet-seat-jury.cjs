/**
 * 给测试网陪审团坐上人。池子空着时争议能受理，但抽签会一直等到 ROUND_TIMEOUT。
 *
 *   npx hardhat run scripts/testnet-seat-jury.cjs --network bscTestnet
 */
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { read, confirm } = require("./lib/rpc.cjs");

async function main() {
  const ROOT = path.join(__dirname, "..");
  const D = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments-bscTestnet.json"), "utf8"));
  const W = JSON.parse(fs.readFileSync(path.join(ROOT, ".testnet-wallets.json"), "utf8"));
  const n = Number(D.jurySize) || 3;
  const roles = ["juror1", "juror2", "juror3", "juror4", "juror5"].slice(0, n);

  const jury = await ethers.getContractAt("StakedJury", D.stakedJury);
  const token = await ethers.getContractAt("MockTokenD", D.settlementToken);
  const dec = Number(await read("读精度", () => token.decimals()));
  const minStake = await jury.minStake();
  const f = (x) => ethers.formatUnits(x, dec);

  console.log("陪审团", D.stakedJury, "需要", n, "人，每人至少", f(minStake));

  for (const role of roles) {
    const w = new ethers.Wallet(W[role].privateKey, ethers.provider);
    const stake = await jury.stakeOf(w.address);
    if (stake >= minStake) {
      console.log(role.padEnd(8), w.address, "已质押", f(stake), "跳过");
      continue;
    }
    const need = minStake - stake;
    const gas = await read("查 gas", () => ethers.provider.getBalance(w.address));
    if (gas === 0n) throw new Error(role + " 没有 tBNB，先跑 scripts/testnet-fund.cjs");
    const bal = await read("查币", () => token.balanceOf(w.address));
    if (bal < need) {
      await confirm(ethers.provider, await token.mint(w.address, need - bal + minStake));
    }
    const t = token.connect(w);
    const j = jury.connect(w);
    await confirm(ethers.provider, await t.approve(D.stakedJury, need));
    await confirm(ethers.provider, await j.stake(need));
    console.log(role.padEnd(8), w.address, "新质押", f(await jury.stakeOf(w.address)));
  }
  console.log("jurorCount", (await jury.jurorCount()).toString(), "totalStake", f(await jury.totalStake()));
}

main().catch((e) => { console.error(e); process.exit(1); });
