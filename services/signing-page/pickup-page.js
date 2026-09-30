/*
 * 取货页：db.renrenyings.net/pickup.html#deal=交易合约地址
 *
 * 从交易合约的状态里读密文（不是日志 —— 日志几个小时就没了），买家签名推出
 * 取货钥匙，在浏览器里解开。钥匙、签名、卡密都不离开这台电脑。
 */
(async function () {
  "use strict";
  const S = window.Shop;
  const E = window.ethers;
  const P = window.EscrowPickup;
  const $ = S.$;
  const fatal = (msg) => { $("fatal").textContent = msg; $("fatal").hidden = false; };
  const STATE = ["", "等双方入金", "等卖家发货", "卖家已发货，验收中", "争议中", "已结束", "已取消"];

  const ctx = S.chainFromHash();
  if (ctx.error) return fatal(ctx.error);
  const addr = S.params().get("deal");
  if (!addr || !E.isAddress(addr)) return fatal("链接里没有交易地址。请用下单成功后给你的那个取货链接。");

  let deal, st, buyer, sealed, tok, iDeadline, dDeadline;
  try {
    const factory = new E.Contract(ctx.chain.factory, S.FACTORY_ABI, ctx.rpc);
    if (!(await factory.isDeal(addr))) return fatal("这个地址不是本协议的交易。可能是伪造的链接，请不要在这里签名。");
    deal = new E.Contract(addr, S.DEAL_ABI, ctx.rpc);
    let price;
    [st, buyer, sealed, price, iDeadline, dDeadline] = await Promise.all([
      deal.state(), deal.buyer(), deal.sealedGoods(), deal.price(), deal.inspectionDeadline(), deal.deliveryDeadline(),
    ]);
    st = Number(st);
    tok = await S.tokenInfo(await deal.token(), ctx.rpc);
    $("price").textContent = tok.fmt(price);
  } catch (e) {
    return fatal("读不到这一单的信息，请稍后刷新。");
  }
  $("state").textContent = STATE[st] || "未知";
  $("deal").textContent = addr;
  $("body").hidden = false;

  const notice = (msg, bad) => { $("notice").textContent = msg; $("notice").className = bad ? "banner bad" : "banner"; $("notice").hidden = false; };
  if (sealed === "0x") {
    $("open-box").hidden = true;
    return notice(st === 2
      ? `卖家还没发货。发货截止：${S.due(dDeadline)}。到期没发货，你可以在 Telegram 里点「索取退款」拿回全部的钱。`
      : "这一单没有加密交付的货物。");
  }
  if (st === 3) notice(`验收截止：${S.due(iDeadline)}。到时间你不操作，货款会自动付给卖家。先取出卡密试一下能不能用。`);

  $("go").addEventListener("click", async () => {
    const btn = $("go"), status = $("status");
    btn.disabled = true;
    status.textContent = "";
    try {
      btn.textContent = "连接钱包中…";
      const w = await S.connect(ctx, status);
      if (w.address.toLowerCase() !== buyer.toLowerCase()) {
        throw new Error(`这一单是另一个钱包买的（${buyer.slice(0, 8)}…${buyer.slice(-6)}）。请在小狐狸里切换到下单的那个钱包，再点一次。`);
      }
      btn.textContent = "请在钱包里签名…";
      const key = await S.pickupKey(w.signer, w.address, status, false);
      let code;
      try {
        code = await P.open(key, sealed);
      } catch {
        throw new Error("解不开。这说明卖家没有用你的取货钥匙加密 —— 这是卖家的问题。请在验收截止前回到 Telegram 提起争议，把这句话写进证据。");
      }
      $("code").textContent = code;
      $("open-box").hidden = true;
      $("got").hidden = false;

      const after = $("after");
      if (st === 3) {
        const iface = new E.Interface(S.DEAL_ABI);
        const a = document.createElement("a");
        a.className = "btn ok";
        a.href = S.signingLink(ctx, addr, iface, "confirmReceipt", []);
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = "卡密能用，确认收货（货款付给卖家）";
        const p = document.createElement("p");
        p.className = "sub";
        p.textContent = `卡密有问题？别点确认。回到 Telegram，在验收截止前点「提起争议」。验收截止：${S.due(iDeadline)}`;
        after.append(a, p);
      }
    } catch (e) {
      status.textContent = S.walletError(e);
      btn.disabled = false;
      btn.textContent = "再试一次";
    }
  });

  $("copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("code").textContent);
      $("copy").textContent = "已复制";
    } catch {
      $("copy").textContent = "复制失败，请长按卡密手动复制";
    }
  });
})();
