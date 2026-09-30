/*
 * 下单页、取货页共用的部分。
 *
 * 信任锚只有一个：config.js 里写死的工厂地址。店铺合约地址也来自 config，
 * 但页面仍要从链上核对「这个店铺挂在我们信任的工厂下面」—— 两个地址对不上
 * 就拒绝继续，不能让一份被改过的配置把买家的钱引到别处去。
 * 链接（# 后面）只带商品编号或交易地址，不带任何金额 —— 金额一律从链上读。
 */
(function (root) {
  "use strict";
  const E = root.ethers;

  const STORE_ABI = [
    "function factory() view returns (address)",
    "function token() view returns (address)",
    "function balanceOf(address) view returns (uint256)",
    "function listings(uint256) view returns (tuple(address seller, bool active, uint32 stock, uint32 sold, uint64 deliveryWindow, uint64 inspectionWindow, uint256 price, uint256 buyerBond, uint256 sellerBond, bytes32 termsHash, string terms))",
    "function buy(uint256 id, bytes pickupKey) returns (address)",
    "event Purchased(uint256 indexed id, address indexed deal, address indexed buyer, address seller)",
  ];
  const ERC20_ABI = [
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "function allowance(address,address) view returns (uint256)",
    "function balanceOf(address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
  ];
  const FACTORY_ABI = ["function isDeal(address) view returns (bool)"];
  const DEAL_ABI = [
    "function token() view returns (address)",
    "function buyer() view returns (address)",
    "function seller() view returns (address)",
    "function state() view returns (uint8)",
    "function price() view returns (uint256)",
    "function deliveryDeadline() view returns (uint64)",
    "function inspectionDeadline() view returns (uint64)",
    "function sealedGoods() view returns (bytes)",
    "function confirmReceipt()",
  ];

  const $ = (id) => document.getElementById(id);

  function params() {
    return new URLSearchParams(location.hash.slice(1));
  }

  /// 读配置、连只读节点。返回 null 表示配置不全（页面据此显示错误）。
  function chainFromHash() {
    const cfg = root.ESCROW_CONFIG || {};
    const chainId = Number(params().get("chain") || cfg.defaultChain || 97);
    const chain = cfg.chains && cfg.chains[chainId];
    if (!chain) return { error: `本页面没有配置链 ${chainId}。` };
    const zero = (a) => !a || !E.isAddress(a) || a === E.ZeroAddress;
    if (zero(chain.factory)) return { error: "本页面还没配置工厂合约地址，无法核对真伪，拒绝继续。" };
    const rpc = new E.JsonRpcProvider(chain.rpcUrl, chainId, { staticNetwork: true });
    return { chainId, chain, rpc, hasStore: !zero(chain.merchantBond) };
  }

  /// 店铺合约必须挂在 config 里那个工厂下面，否则拒绝。
  async function trustedStore(ctx) {
    const store = new E.Contract(ctx.chain.merchantBond, STORE_ABI, ctx.rpc);
    const f = await store.factory();
    if (f.toLowerCase() !== ctx.chain.factory.toLowerCase()) {
      throw new Error("店铺合约和本页面信任的工厂对不上，可能是伪造的配置。已拒绝继续。");
    }
    return store;
  }

  async function tokenInfo(addr, rpc) {
    const t = new E.Contract(addr, ERC20_ABI, rpc);
    const [dec, sym] = await Promise.all([t.decimals(), t.symbol()]);
    return { dec: Number(dec), sym, fmt: (x) => `${E.formatUnits(x, dec)} ${sym}` };
  }

  const hours = (sec) => {
    const h = Number(sec) / 3600;
    return h >= 48 && h % 24 === 0 ? `${h / 24} 天` : `${h} 小时`;
  };

  /// 截止时间：还剩多久 + 北京时间（和机器人推送同一个写法）
  function due(sec) {
    const left = Number(sec) - Math.floor(Date.now() / 1000);
    const d = new Date((Number(sec) + 8 * 3600) * 1000);
    const p = (n) => String(n).padStart(2, "0");
    const bj = `北京时间 ${d.getUTCMonth() + 1}月${d.getUTCDate()}日 ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
    if (left <= 0) return `已截止（${bj}）`;
    const h = Math.floor(left / 3600), m = Math.floor((left % 3600) / 60);
    return `还剩 ${h >= 24 ? `${Math.floor(h / 24)} 天 ${h % 24} 小时` : `${h} 小时 ${m} 分`}（${bj}）`;
  }

  /*
   * 连钱包。和签名页一样的教训：小狐狸的确认窗口有时不会自己弹到前面，
   * 只挂在右上角的图标上，用户看到的是「点了没反应」。等 12 秒没回话就提示去哪儿找。
   */
  const SLOW_HINT = "钱包没有反应？点一下浏览器右上角的小狐狸图标，里面可能有一个窗口在等你确认。";

  async function withHint(promise, statusEl) {
    const t = setTimeout(() => { statusEl.textContent = SLOW_HINT; }, 12_000);
    try { return await promise; } finally { clearTimeout(t); }
  }

  async function connect(ctx, statusEl) {
    if (!root.ethereum) throw new Error("没有检测到钱包。请在装了小狐狸（MetaMask）的浏览器里打开，或者在钱包 App 的内置浏览器里打开。");
    const bp = new E.BrowserProvider(root.ethereum);
    await withHint(bp.send("eth_requestAccounts", []), statusEl);
    const net = await bp.getNetwork();
    if (Number(net.chainId) !== ctx.chainId) {
      const hex = "0x" + ctx.chainId.toString(16);
      try {
        await withHint(bp.send("wallet_switchEthereumChain", [{ chainId: hex }]), statusEl);
      } catch (e) {
        if ((e?.error?.code ?? e?.code) !== 4902) throw e;
        await withHint(bp.send("wallet_addEthereumChain", [{
          chainId: hex, chainName: ctx.chain.name, rpcUrls: [ctx.chain.rpcUrl],
          nativeCurrency: ctx.chain.nativeCurrency,
          blockExplorerUrls: ctx.chain.explorer ? [ctx.chain.explorer] : [],
        }]), statusEl);
      }
    }
    const provider = new E.BrowserProvider(root.ethereum);
    const signer = await provider.getSigner();
    return { provider, signer, address: await signer.getAddress() };
  }

  /// 钱包报错 → 人话
  function walletError(e) {
    const layers = [e, e?.error, e?.info?.error].filter(Boolean);
    const codes = layers.map((x) => x.code);
    const msg = layers.map((x) => String(x.shortMessage ?? x.message ?? "")).join(" | ");
    if (codes.includes(4001) || codes.includes("ACTION_REJECTED") || /user rejected|denied/i.test(msg)) {
      return "你在钱包里点了拒绝。要继续的话，再点一次按钮。";
    }
    if (codes.includes(-32002) || /already pending/i.test(msg)) {
      return "小狐狸里已经有一个请求在等你处理。点右上角的小狐狸图标处理完，再点一次按钮。";
    }
    return e?.message && !/0x[0-9a-f]{20,}/i.test(e.message) ? e.message : "出错了：" + (e?.shortMessage ?? msg);
  }

  /// 签名页链接（和机器人生成的是同一个格式），用来把「确认收货」交给签名页走全部核验。
  function signingLink(ctx, to, iface, method, args) {
    const json = JSON.stringify({ to, data: iface.encodeFunctionData(method, args), value: "0", chainId: ctx.chainId });
    const b64 = btoa(unescape(encodeURIComponent(json))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `index.html#tx=${b64}`;
  }

  /// 取货钥匙：签两次确认钱包是确定性签名，不是的话钥匙没法重现，必须拦下来。
  async function pickupKey(signer, address, statusEl, twice) {
    const P = root.EscrowPickup;
    const msg = P.pickupMessage(address);
    const a = await withHint(signer.signMessage(msg), statusEl);
    if (twice) {
      const b = await withHint(signer.signMessage(msg), statusEl);
      if (a !== b) {
        throw new Error("你的钱包每次签出来的结果都不一样，取货钥匙没法重现 —— 这样下单后你会取不到卡密。请换 MetaMask（小狐狸）下单。");
      }
    }
    return P.keyFromSignature(a);
  }

  root.Shop = {
    $, params, chainFromHash, trustedStore, tokenInfo, hours, due, connect, walletError,
    signingLink, pickupKey, withHint, STORE_ABI, ERC20_ABI, FACTORY_ABI, DEAL_ABI,
  };
  // 只改 # 不会重新加载页面：同一个标签页换一个商品/交易，必须整页重来，不留旧状态
  root.addEventListener("hashchange", () => location.reload());
})(typeof self !== "undefined" ? self : this);
