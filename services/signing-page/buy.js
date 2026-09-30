/*
 * 下单页：db.renrenyings.net/buy.html#id=商品编号
 *
 * 卖家把这个链接贴到哪里都行，买家不用 Telegram 也能买。
 * 页面从链上读商品和条款全文；链接里只有编号，任何金额都不信链接。
 */
(async function () {
  "use strict";
  const S = window.Shop;
  const E = window.ethers;
  const $ = S.$;
  const fatal = (msg) => { $("fatal").textContent = msg; $("fatal").hidden = false; $("title").textContent = "打不开这个商品"; };
  const step = (n) => {
    for (let i = 1; i <= 4; i++) $("s" + i).className = i < n ? "done" : i === n ? "now" : "";
  };

  const ctx = S.chainFromHash();
  if (ctx.error) return fatal(ctx.error);
  if (!ctx.hasStore) return fatal("本页面还没配置店铺合约。");
  const id = S.params().get("id");
  if (!/^\d+$/.test(id || "")) return fatal("链接里没有商品编号。请向卖家要完整的购买链接。");

  let store, l, tok, poolBal;
  try {
    store = await S.trustedStore(ctx);
    l = await store.listings(id);
    if (l.seller === E.ZeroAddress) return fatal("没有这个商品。请向卖家确认链接。");
    tok = await S.tokenInfo(await store.token(), ctx.rpc);
    poolBal = await store.balanceOf(l.seller);
  } catch (e) {
    return fatal(e.message || "读不到商品信息，请稍后刷新。");
  }

  const pay = l.price + l.buyerBond;
  const title = l.terms.split("\n")[0].replace(/^商品[:：]\s*/, "") || `商品 #${id}`;
  document.title = `${title} · 人人担保`;
  $("title").textContent = title;
  $("pay").textContent = tok.fmt(pay);
  $("pay-detail").textContent = `= 货款 ${tok.fmt(l.price)} + 你的押金 ${tok.fmt(l.buyerBond)}（交易正常结束后押金原路退回）`;
  $("sb").textContent = tok.fmt(l.sellerBond);
  $("dw").textContent = `下单后 ${S.hours(l.deliveryWindow)}内`;
  $("iw").textContent = `卖家发货后 ${S.hours(l.inspectionWindow)}`;
  $("stock").textContent = `${l.stock} 份`;
  $("seller").textContent = l.seller;
  $("terms").textContent = l.terms;
  $("guarantee").textContent =
    `卖家的 ${tok.fmt(l.sellerBond)} 押金会和你的钱一起锁进这一单。卖家到期不发货，你拿回全部货款和押金；` +
    `卡密有问题可以提起争议。验收期内你不操作，货款会自动付给卖家。`;

  const blockers = [];
  if (!l.active) blockers.push("这个商品已下架。");
  else if (l.stock === 0n) blockers.push("这个商品卖完了。");
  else if (poolBal < l.sellerBond) blockers.push("卖家的押金账户余额不够，暂时接不了新单。请联系卖家。");
  if (blockers.length) {
    $("notice").textContent = blockers.join(" ");
    $("notice").className = "banner bad";
    $("notice").hidden = false;
    $("go").disabled = true;
    $("go").textContent = "现在不能下单";
  }
  $("body").hidden = false;
  step(1);

  $("go").addEventListener("click", async () => {
    const btn = $("go"), status = $("status");
    btn.disabled = true;
    status.textContent = "";
    try {
      step(1);
      btn.textContent = "连接钱包中…";
      const w = await S.connect(ctx, status);
      if (w.address.toLowerCase() === l.seller.toLowerCase()) throw new Error("不能买自己上架的商品。");

      const token = new E.Contract(await store.token(), S.ERC20_ABI, w.signer);
      const have = await token.balanceOf(w.address);
      if (have < pay) throw new Error(`钱包里的 ${tok.sym} 不够：要 ${tok.fmt(pay)}，你有 ${tok.fmt(have)}。`);

      step(2);
      btn.textContent = "请在钱包里签名（共 2 次）…";
      const key = await S.pickupKey(w.signer, w.address, status, true);

      step(3);
      const storeW = store.connect(w.signer);
      const allowance = await token.allowance(w.address, await store.getAddress());
      if (allowance < pay) {
        btn.textContent = "请在钱包里确认授权…";
        const tx = await S.withHint(token.approve(await store.getAddress(), pay), status);
        btn.textContent = "授权上链中…";
        await tx.wait();
      }

      step(4);
      btn.textContent = "请在钱包里确认下单…";
      const tx = await S.withHint(storeW.buy(id, key.compressedPublicKey), status);
      btn.textContent = "下单上链中…（通常几秒钟）";
      const rc = await tx.wait();
      if (rc.status !== 1) throw new Error("下单被链上拒绝了，你的钱没有动。可能刚好卖完或下架了，请刷新看看。");
      const ev = rc.logs.map((x) => { try { return store.interface.parseLog(x); } catch { return null; } })
        .find((x) => x && x.name === "Purchased");
      const deal = ev.args.deal;

      step(5);
      status.textContent = "";
      btn.hidden = true;
      $("pickup").href = `pickup.html#deal=${deal}&chain=${ctx.chainId}`;
      $("deal").textContent = `这一单的合约：${deal}`;
      const bot = window.ESCROW_CONFIG?.telegramBot;
      if (bot && /^[A-Za-z0-9_]{5,32}$/.test(bot)) {
        $("tg").href = `https://t.me/${bot}`;
        $("tg").hidden = false;
      }
      $("done").hidden = false;
      $("done").scrollIntoView({ behavior: "smooth" });
    } catch (e) {
      status.textContent = S.walletError(e);
      btn.disabled = false;
      btn.textContent = "再试一次";
    }
  });
})();
