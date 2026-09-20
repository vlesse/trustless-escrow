/**
 * 渲染。两件事：语言切换，以及把链上读到的数字填进去。
 *
 * 取数失败时**显示失败**，不显示 0。一个讲透明的页面，
 * 把「读不到」渲染成「0」是所有谎言里最省事的那一种。
 */
(function () {
  const C = window.SITE_CHAIN;
  const $ = (s) => document.querySelector(s);

  // ---------------- 语言 ----------------
  const zh = new Map();
  document.querySelectorAll("[data-i18n]").forEach((el) => zh.set(el, el.innerHTML));

  function apply(lang) {
    const en = lang === "en";
    document.documentElement.lang = en ? "en" : "zh-CN";
    for (const [el, src] of zh) {
      const k = el.dataset.i18n;
      el.innerHTML = en ? (window.SITE_EN[k] ?? src) : src;
    }
    $("#lang").textContent = en ? "中文" : "EN";
    try { localStorage.setItem("lang", lang); } catch {}
    if (state) paint(state);          // 数字里有「笔」「个」这种量词，要跟着换
  }
  let cur = "zh";
  try { cur = localStorage.getItem("lang") || "zh"; } catch {}
  $("#lang").addEventListener("click", () => { cur = cur === "en" ? "zh" : "en"; apply(cur); });

  // ---------------- 合约地址表 ----------------
  const ROWS = [
    ["EscrowFactory", "escrowFactory", "开单入口", "Deal factory"],
    ["Escrow", "escrowImpl", "托管逻辑（被克隆的模板，immutable）", "Escrow logic (cloned template, immutable)"],
    ["FeeVault", "feeVault", "手续费金库", "Fee vault"],
    ["OptimisticArbitrator", "optimisticArbitrator", "乐观仲裁层", "Optimistic arbitration layer"],
    ["StakedJury", "stakedJury", "质押陪审团", "Staked jury"],
    ["IdentityBond", "identityBond", "身份押金", "Identity bond"],
    ["Reputation", "reputation", "公开记录", "Public record"],
    ["USDT", "settlementToken", "结算币（测试网上是我们发的假币）", "Settlement token (a mock on testnet)"],
  ];
  function paintAddrs() {
    const en = cur === "en";
    $("#addr-rows").innerHTML = ROWS.filter(([, k]) => C[k]).map(([name, k, cn, enn]) =>
      `<tr><td>${name}<br><span style="font-size:12px">${en ? enn : cn}</span></td>` +
      `<td><a href="${C.explorer}/address/${C[k]}" target="_blank" rel="noopener">${C[k]}</a></td></tr>`
    ).join("");
  }

  // ---------------- 数字 ----------------
  let state = null;

  const fmt = (v, dec, digits = 2) => {
    const s = ethers.formatUnits(v, dec);
    const n = Number(s);
    if (!isFinite(n)) return s;
    return n.toLocaleString(cur === "en" ? "en-US" : "zh-CN",
      { minimumFractionDigits: digits, maximumFractionDigits: digits });
  };

  function paint(d) {
    const en = cur === "en";
    const unit = (n, cn, e) => n.toLocaleString() + " " + (en ? e : cn);

    $("#n-deals").textContent = unit(d.deals, "笔", d.deals === 1 ? "deal" : "deals");
    $("#n-locked").textContent = fmt(d.locked, d.decimals) + " " + d.symbol;
    $("#n-disputes").textContent = d.disputes + " / " + d.challenged;
    $("#n-jurors").textContent = d.jurorCount + " / " + fmt(d.totalStake, d.decimals, 0) + " " + d.symbol;

    $("#n-fee-total").textContent = fmt(d.feeTotal, d.decimals) + " " + d.symbol;
    $("#n-fee-swept").textContent = fmt(d.feeSwept, d.decimals) + " " + d.symbol;
    $("#n-fee-pending").textContent = fmt(d.feePending, d.decimals) + " " + d.symbol;

    const a = $("#bene-link");
    a.textContent = d.beneficiary;
    a.href = C.explorer + "/address/" + d.beneficiary;

    $("#stamp").textContent = (en ? "Read from chain at " : "读取于 ") +
      new Date().toLocaleString(en ? "en-US" : "zh-CN") +
      " · " + C.chainName + (en ? " · fee " : " · 费率 ") + (C.feeBps / 100) + "%";
    paintAddrs();
  }

  function fail(msg) {
    const en = cur === "en";
    for (const id of ["n-deals", "n-locked", "n-disputes", "n-jurors",
                      "n-fee-total", "n-fee-swept", "n-fee-pending"]) {
      const el = document.getElementById(id);
      // 读不到就说读不到。渲染成 0 是最省事的那种谎。
      el.textContent = en ? "unavailable" : "读取失败";
      el.style.color = "var(--dim)";
      el.style.fontSize = "15px";
    }
    $("#stamp").textContent = (en ? "Could not reach the RPC node: " : "连不上 RPC 节点：") + msg +
      (en ? " — the contract addresses below are still valid; check them on the explorer."
          : " —— 下面的合约地址仍然有效，可以直接去区块浏览器核对。");
  }

  apply(cur);
  paintAddrs();
  window.SITE_CHAIN_LOAD()
    .then((d) => { state = d; paint(d); })
    .catch((e) => fail(e.shortMessage || e.message));
})();
