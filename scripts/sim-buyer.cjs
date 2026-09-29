/**
 * 用测试钱包扮演买家，配合真人卖家走完流程。sim-seller.cjs 的镜像。
 *
 *   DEAL=0x... STEP=deposit npx hardhat run scripts/sim-buyer.cjs --network bscTestnet
 *   DEAL=0x... STEP=confirm npx hardhat run scripts/sim-buyer.cjs --network bscTestnet
 *
 * 之前买家一直由真人（项目方本人）扮演，所以这个脚本不存在。角色对调之后
 * 才发现少了一半 —— 卖家侧的产品路径从来没有被真人走过。
 *
 * 每一步先读链上状态再决定做什么，做完再回读确认：公共 RPC 后面是一组节点，
 * 回执查得到不代表下一个请求落到的那台也同步到了那个高度。
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

  const buyer = new ethers.Wallet(W.buyer.privateKey, ethers.provider);
  const deal = await ethers.getContractAt("Escrow", addr);
  const token = await ethers.getContractAt("MockTokenD", D.settlementToken);
  const dec = Number(await read("读精度", () => token.decimals()));
  const f = (x) => ethers.formatUnits(x, dec);

  // blockTag 可选。发完交易之后的那次读必须钉在回执区块上 —— 实测不钉的话
  // 对账全对、紧接着这一行却打出「状态=Delivered 锁定=1500」，读到的是
  // 一台还没同步的节点。一行假的状态输出比没有输出更坏。
  const show = async (label, blockTag) => {
    const s = await read("读状态", () => deal.summary(blockTag ? { blockTag } : {}));
    console.log(`${label}  状态=${STATE[Number(s.s)]}  锁定=${f(s.locked)}  买=${s.bFunded}  卖=${s.sFunded}`);
    return s;
  };

  console.log("买家 " + buyer.address);
  const onChainBuyer = await read("读买家", () => deal.buyer());
  if (onChainBuyer.toLowerCase() !== buyer.address.toLowerCase()) {
    throw new Error(`这笔单的买家是 ${onChainBuyer}，不是我。别动。`);
  }
  const before = await show("之前");

  if (step === "deposit") {
    if (before.bFunded) return console.log("买家已入金，无需重复。");

    const [price, bond] = await Promise.all([
      read("读货款", () => deal.price()),
      read("读押金", () => deal.buyerBond()),
    ]);
    const need = price + bond;
    const bal = await read("查余额", () => token.balanceOf(buyer.address));
    console.log(`  需要 ${f(need)} = 货款 ${f(price)} + 押金 ${f(bond)}，我有 ${f(bal)}`);
    if (bal < need) throw new Error(`余额不够，差 ${f(need - bal)}`);

    /*
     * 激活前置条件在这里先 staticCall 一次。
     *
     * depositBuyer 是第二笔入金，它会触发 _tryActivate：仲裁成本为 0 会
     * revert ArbitrationUnconfigured，保证金盖不住成本会 revert
     * BondBelowArbitrationCost。这两个 revert 都发生在**买家**这一笔上，
     * 但根因是开单参数 —— 真人用户看到的是自己钱包里一个看不懂的失败。
     * 先干跑一次，把错误名字打出来，省得又去链上翻回执。
     */
    const allow = await read("读授权", () => token.allowance(buyer.address, addr));
    if (allow < need) {
      const rc = await confirm(ethers.provider, await token.connect(buyer).approve(addr, need));
      console.log("  approve   " + rc.gasUsed + " gas  " + rc.hash);
    }
    try {
      await deal.connect(buyer).depositBuyer.staticCall();
    } catch (e) {
      throw new Error("入金会失败：" + (e.shortMessage || e.message) +
        "\n（这是开单参数的问题，不是买家的问题 —— 卖家可以 cancelUnfunded 取回押金重开）");
    }
    const rc = await confirm(ethers.provider, await deal.connect(buyer).depositBuyer());
    console.log("  入金 " + f(need) + "  " + rc.gasUsed + " gas  " + rc.hash);
    await show("之后", rc.blockNumber);
    return;
  } else if (step === "confirm") {
    // Funded(2) 或 Delivered(3) 都可以确认收货 —— 买家随时有权主动放行。
    if (![2, 3].includes(Number(before.s))) throw new Error("现在这个状态确认不了收货");

    /*
     * 对账，不看事件。只看 state 变成 Resolved 的测试会放过「结算了但金额算错」。
     *
     * 前后余额都钉在具体区块上读：公共 RPC 后面是一组节点，不钉块号的话
     * 「之后」那次可能落到一台还没同步到回执高度的节点上，读出来的是旧值。
     */
    const [price, bBond, sBond, feeBps, seller] = await Promise.all([
      read("读货款", () => deal.price()),
      read("读买家押金", () => deal.buyerBond()),
      read("读卖家押金", () => deal.sellerBond()),
      read("读费率", () => deal.feeBps()),
      read("读卖家", () => deal.seller()),
    ]);
    const vault = D.feeVault;
    const who = { buyer: buyer.address, seller, vault, deal: addr };
    const snap = async (blockTag) => {
      const out = {};
      for (const [k, a] of Object.entries(who)) {
        out[k] = await read("查余额", () => token.balanceOf(a, { blockTag }));
      }
      return out;
    };

    const pre = await read("读块高", () => ethers.provider.getBlockNumber());
    const b0 = await snap(pre);
    const rc = await confirm(ethers.provider, await deal.connect(buyer).confirmReceipt());
    console.log("  确认收货  " + rc.gasUsed + " gas  " + rc.hash);
    const b1 = await snap(rc.blockNumber);

    const fee = (price * BigInt(feeBps)) / 10000n;
    const want = {
      seller: price - fee + sBond,       // 货款扣手续费，外加自己的押金原路退回
      buyer: bBond,                      // 只拿回押金；货款早在入金时就出去了
      vault: fee,
      deal: -(price + bBond + sBond),    // 必须清空，一个 wei 都不能留
    };

    console.log("\n=== 对账 ===");
    let bad = 0;
    for (const k of Object.keys(want)) {
      const got = b1[k] - b0[k];
      const ok = got === want[k];
      if (!ok) bad++;
      console.log("  " + k.padEnd(7) + ("净变动 " + f(got)).padEnd(22) +
        (ok ? "✓" : "✗ 应为 " + f(want[k])));
    }
    if (b1.deal !== 0n) { bad++; console.log("  托管合约还剩 " + f(b1.deal) + " ✗"); }
    if (bad) { await show("之后", rc.blockNumber); throw new Error(bad + " 项对不上"); }
    console.log("  全部一致。手续费 " + f(fee) + "（" + Number(feeBps) / 100 + "%）进了金库。");
    await show("之后", rc.blockNumber);
    return;
  } else {
    throw new Error("STEP 只能是 deposit 或 confirm");
  }

  await show("之后");
}

main().catch((e) => { console.error(e); process.exit(1); });
