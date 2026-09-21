/**
 * 用测试钱包扮演卖家，配合真人买家走完流程。
 *
 *   DEAL=0x... STEP=deposit npx hardhat run scripts/sim-seller.cjs --network bscTestnet
 *   DEAL=0x... STEP=deliver npx hardhat run scripts/sim-seller.cjs --network bscTestnet
 *
 * 每一步先读链上状态再决定做什么，做完再回读确认 —— 公共 RPC 后面是一组
 * 节点，回执查得到不代表下一个请求落到的那台也同步到了那个高度。
 */
const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");
const { read, confirm } = require("./lib/rpc.cjs");

const ROOT = path.join(__dirname, "..");
const D = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments-bscTestnet.json"), "utf8"));
const W = JSON.parse(fs.readFileSync(path.join(ROOT, ".testnet-wallets.json"), "utf8"));
const STATE = ["None", "Open", "Funded", "Delivered", "Disputed", "Resolved", "Cancelled"];

async function main() {
  const addr = process.env.DEAL;
  if (!addr || !ethers.isAddress(addr)) throw new Error("DEAL 缺失或不是合法地址");
  const step = process.env.STEP || "deposit";

  const seller = new ethers.Wallet(W.seller.privateKey, ethers.provider);
  const deal = await ethers.getContractAt("Escrow", addr);
  const token = await ethers.getContractAt("MockTokenD", D.settlementToken);
  const dec = Number(await read("读精度", () => token.decimals()));
  const f = (x) => ethers.formatUnits(x, dec);

  const show = async (label) => {
    const s = await read("读状态", () => deal.summary());
    console.log(`${label}  状态=${STATE[Number(s.s)]}  锁定=${f(s.locked)}  买=${s.bFunded}  卖=${s.sFunded}`);
    return s;
  };

  console.log("卖家 " + seller.address);
  const before = await show("之前");

  if (step === "deposit") {
    if (before.sFunded) return console.log("卖家已入金，无需重复。");
    const bond = await read("读押金", () => deal.sellerBond());
    const allow = await read("读授权", () => token.allowance(seller.address, addr));
    if (allow < bond) {
      const rc = await confirm(ethers.provider, await token.connect(seller).approve(addr, bond));
      console.log("  approve   " + rc.gasUsed + " gas  " + rc.hash);
    }
    const rc = await confirm(ethers.provider, await deal.connect(seller).depositSeller());
    console.log("  入押金 " + f(bond) + "  " + rc.gasUsed + " gas  " + rc.hash);
  } else if (step === "deliver") {
    if (Number(before.s) !== 2) throw new Error("现在不是 Funded 状态，发不了货");
    const rc = await confirm(ethers.provider,
      await deal.connect(seller).markDelivered("data:text/plain;base64," +
        Buffer.from("激活码 TEST-1234-ABCD-5678 已于交付期内发送至买家指定邮箱。", "utf8").toString("base64")));
    console.log("  标记发货  " + rc.gasUsed + " gas  " + rc.hash);
  } else {
    throw new Error("STEP 只能是 deposit 或 deliver");
  }

  await show("之后");
}

main().catch((e) => { console.error(e); process.exit(1); });
