/* global ethers */

/**
 * 签名页。
 *
 * 唯一职责：把机器人编码好的交易，翻译成用户看得懂的一句话，
 * 验证它确实指向本协议的合约，然后交给用户自己的钱包去签。
 *
 * 三条不能妥协的原则：
 *
 * 1. **交易内容走 URL fragment（#），不走 query（?）。**
 *    fragment 不会发给服务器，也不进 access log。
 *    页面是静态的，托管方看不到任何人在签什么。
 *
 * 2. **解不出来就不放行。** 一个只会说「请签名」的签名页，
 *    是在训练用户盲签。用户越习惯看不懂就点确认，
 *    越容易在真正的钓鱼弹窗上点确认。所以这里宁可不可用。
 *
 * 3. **目标合约必须经工厂验证。** 任何人都能伪造一个签名链接。
 *    页面会独立查链确认 `to` 是工厂登记过的托管实例
 *    （approve 则确认 spender 是），验不过就拒绝。
 */

const $ = (id) => document.getElementById(id);

const ESCROW_ABI = [
  "function depositBuyer()",
  "function depositSeller()",
  "function cancelUnfunded()",
  "function markDelivered(string evidenceURI)",
  "function confirmReceipt()",
  "function settleAfterInspection()",
  "function claimNonDelivery()",
  "function raiseDispute(string evidenceURI)",
  "function submitEvidence(string evidenceURI)",
];
const FACTORY_ABI = [
  "function createDeal(address token, address buyer, address seller, uint256 price, uint256 buyerBond, uint256 sellerBond, uint64 deliveryWindow, uint64 inspectionWindow, bytes32 termsHash) returns (address)",
  "function isDeal(address) view returns (bool)",
];
const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];
const IDENTITY_BOND_ABI = [
  "function bond(uint256 amount)",
  "function requestUnbond()",
  "function cancelUnbond()",
  "function withdraw()",
];
const REPUTATION_ABI = ["function record(address deal)"];

const MERCHANT_BOND_ABI = [
  "function deposit(uint256 amount)",
  "function withdraw(uint256 amount)",
  "function fundDeal(address deal)",
];
const DEAL_READ_ABI = [
  "function token() view returns (address)",
  "function price() view returns (uint256)",
  "function buyerBond() view returns (uint256)",
  "function sellerBond() view returns (uint256)",
];

const ifaces = {
  escrow: new ethers.Interface(ESCROW_ABI),
  factory: new ethers.Interface(FACTORY_ABI),
  erc20: new ethers.Interface(ERC20_ABI),
  identityBond: new ethers.Interface(IDENTITY_BOND_ABI),
  reputation: new ethers.Interface(REPUTATION_ABI),
  merchantBond: new ethers.Interface(MERCHANT_BOND_ABI),
};

/// 每个操作的人话描述。`risk` 决定确认区的视觉强度。
/// irreversible 的那几个必须说清楚「不可撤销」—— 这是用户最需要
/// 在点下去之前知道的一件事。
const ACTIONS = {
  approve: {
    title: "授权托管合约划转你的代币",
    risk: "medium",
    note: "这一步本身不转账，只是允许托管合约在下一步划走指定额度。额度只给本次所需，不是无限授权。",
  },
  depositBuyer: {
    title: "锁定货款与你的保证金",
    risk: "high",
    note: "资金将锁进托管合约。正常成交后货款给卖家、保证金退还你；若卖家违约，你可取回全部并获得对方的保证金。",
  },
  depositSeller: {
    title: "锁定你的保证金",
    risk: "high",
    note: "保证金是你对履约的担保。正常成交后原额退还；若被裁定违约，将被罚没给买家。",
  },
  cancelUnfunded: {
    title: "取消这笔尚未锁定的交易",
    risk: "low",
    note: "双方都完成入金前，任一方可无损退出。已入金的部分会原路退回。",
  },
  markDelivered: {
    title: "标记已交付，开始验收期",
    risk: "medium",
    note: "买家将在验收期内确认收货或提起争议。验收期满无异议，货款自动放给你。",
  },
  confirmReceipt: {
    title: "确认收货并放款给卖家",
    risk: "irreversible",
    note: "货款立即放给卖家，此操作不可撤销。请确认已收到货并验收无误。",
  },
  settleAfterInspection: {
    title: "结算给卖家（验收期已满）",
    risk: "medium",
    note: "验收期届满且买家无异议，任何人都可以推动这笔结算。",
  },
  claimNonDelivery: {
    title: "索取退款（卖家逾期未交付）",
    risk: "medium",
    note: "取回你的全部货款与保证金，卖家保证金原额退还。这是无过错取消，平台不收费。",
  },
  raiseDispute: {
    title: "提起争议",
    risk: "high",
    note: "争议由仲裁层裁决，败诉方的保证金将被罚没给对方。恶意申诉同样会被罚没——这不是一个免费选项。",
  },
  submitEvidence: {
    title: "提交证据",
    risk: "low",
    note: "向仲裁层补充材料。只记录证据链接，不转移任何资金。",
  },
  createDeal: {
    title: "创建一笔担保交易",
    risk: "low",
    note: "仅创建合约实例，本步骤不锁定任何资金。双方各自入金后交易才正式生效。",
  },

  bond: {
    title: "押入身份押金",
    risk: "medium",
    note: "锁定一笔资金作为身份成本。没有任何人能罚没它，撤回需公示 14 天且只能整笔撤回。",
  },
  requestUnbond: {
    title: "申请撤回身份押金",
    risk: "medium",
    note: "公示 14 天后可提取。签下这一笔之后，对手方看到的「承诺押金」会立刻变成 0。",
  },
  cancelUnbond: {
    title: "撤销撤回申请",
    risk: "low",
    note: "押金恢复承诺状态，身份年龄保留。撤销次数会被永久记录。",
  },
  withdraw: {
    title: "提取身份押金",
    risk: "irreversible",
    note: "提取后身份年龄归零。历史成交记录不会跟到新的押金上 —— 这等于销毁当前身份。",
  },
  record: {
    title: "记录一笔交易的结果",
    risk: "low",
    note: "把一笔已结束交易的结果沉淀成双方的公开记录。不转移任何资金，记录写入后无法删除。",
  },

  deposit: {
    title: "存入商家额度",
    risk: "medium",
    note: "预存一笔钱，之后每开一单直接从这里扣保证金，省掉每次授权。这笔钱还没有承担任何义务，随时可以全额取回。",
  },
  fundDeal: {
    title: "用额度支付这笔交易的保证金",
    risk: "high",
    note: "从你的额度里扣一笔，直接进这笔交易的托管合约。和自己入金完全等价 —— 正常成交后原额退回你的钱包（不是退回额度池）。",
  },
};

/// `withdraw` 在身份押金和商家额度池上是同名的两个方法，含义天差地别：
/// 一个会让身份年龄归零，一个只是取回还没用掉的预付款。
/// 只按方法名查表会让用户看到完全错误的说明，所以这里必须按目标地址分流。
const WITHDRAW_BY_TARGET = {
  merchantBond: {
    title: "取回商家额度",
    risk: "low",
    note: "取回还没用掉的预付款。不影响任何已经入金的交易 —— 那些钱早就在各自的托管合约里了。",
  },
};

const state = {
  tx: null,
  decoded: null,
  checks: [],
  chain: null,
  provider: null,
  signer: null,
};

// ---------------------------------------------------------------- 解析

function parseFragment() {
  const m = location.hash.match(/[#&]tx=([A-Za-z0-9_-]+)/);
  if (!m) throw new Error("链接里没有交易内容。请回到 Telegram 重新点击签名链接。");

  let json;
  try {
    const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
    json = JSON.parse(atob(b64));
  } catch {
    throw new Error("链接内容已损坏，无法解析。请回到 Telegram 重新获取。");
  }

  for (const k of ["to", "data", "chainId"]) {
    if (json[k] === undefined) throw new Error(`链接缺少必要字段 ${k}`);
  }
  if (!ethers.isAddress(json.to)) throw new Error("目标地址格式不合法");
  if (!/^0x[0-9a-fA-F]*$/.test(json.data)) throw new Error("calldata 格式不合法");

  return {
    to: ethers.getAddress(json.to),
    data: json.data,
    value: BigInt(json.value ?? 0),
    chainId: Number(json.chainId),
  };
}

/// 尝试用三套 ABI 解码。解不出来返回 null —— 调用方必须据此拒绝放行。
function decodeCalldata(data) {
  for (const [kind, iface] of Object.entries(ifaces)) {
    try {
      const parsed = iface.parseTransaction({ data });
      if (parsed) return { kind, name: parsed.name, args: parsed.args, signature: parsed.signature };
    } catch {
      /* 换下一套 */
    }
  }
  return null;
}

// ---------------------------------------------------------------- 校验

async function runChecks(tx, decoded, chain) {
  const checks = [];
  const add = (ok, label, detail) => checks.push({ ok, label, detail });

  // 本协议的所有调用都不附带原生币。附带了就是有人在改造这笔交易。
  add(tx.value === 0n, "不附带 ETH", tx.value === 0n ? "本协议的所有操作都不需要发送原生币" : `这笔交易试图发送 ${ethers.formatEther(tx.value)} ETH —— 本协议从不需要这样做`);

  add(Boolean(decoded), "calldata 可解码",
    decoded ? `${decoded.signature}` : "无法用本协议的任何 ABI 解出这笔调用的含义");

  if (!decoded) return checks;

  const rpc = new ethers.JsonRpcProvider(chain.rpcUrl);
  const factory = new ethers.Contract(chain.factory, FACTORY_ABI, rpc);

  try {
    if (decoded.kind === "factory") {
      const ok = tx.to.toLowerCase() === chain.factory.toLowerCase();
      add(ok, "目标是官方工厂合约",
        ok ? tx.to : `目标 ${tx.to} 不是配置里的工厂地址 ${chain.factory}`);
    } else if (decoded.kind === "escrow") {
      const ok = await factory.isDeal(tx.to);
      add(ok, "目标是工厂登记的托管合约",
        ok ? "已在链上验证" : "这个地址不是本协议工厂创建的。可能是钓鱼合约，请勿签名。");
    } else if (decoded.kind === "identityBond") {
      // 押金合约地址只能来自本地 config，不能来自 URL 里的那笔交易本身 ——
      // 否则「验证」等于拿攻击者给的答案去对攻击者出的题。
      const configured = (chain.identityBond || "").toLowerCase();
      const ok = Boolean(configured) && tx.to.toLowerCase() === configured;
      add(ok, "目标是配置里的身份押金合约",
        ok ? tx.to
          : configured
            ? `目标 ${tx.to} 不是配置的身份押金合约 ${chain.identityBond}`
            : "本页未配置身份押金合约地址，无法验证目标，拒绝放行");
    } else if (decoded.kind === "merchantBond") {
      const configured = (chain.merchantBond || "").toLowerCase();
      const ok = Boolean(configured) && tx.to.toLowerCase() === configured;
      add(ok, "目标是配置里的商家额度池",
        ok ? tx.to
          : configured
            ? `目标 ${tx.to} 不是配置的商家额度池 ${chain.merchantBond}`
            : "本页未配置商家额度池地址，无法验证目标，拒绝放行");

      // fundDeal 的参数是一笔交易，同样要验它确实是工厂发出来的
      if (ok && decoded.name === "fundDeal") {
        const target = decoded.args[0];
        const isDeal = await factory.isDeal(target);
        add(isDeal, "要支付的那笔交易是工厂登记的托管合约",
          isDeal ? target : `${target} 不是本协议工厂创建的交易，请勿签名`);
      }
    } else if (decoded.kind === "reputation") {
      const configured = (chain.reputation || "").toLowerCase();
      const ok = Boolean(configured) && tx.to.toLowerCase() === configured;
      add(ok, "目标是配置里的信誉合约",
        ok ? tx.to
          : configured
            ? `目标 ${tx.to} 不是配置的信誉合约 ${chain.reputation}`
            : "本页未配置信誉合约地址，无法验证目标，拒绝放行");
    } else if (decoded.kind === "erc20" && decoded.name === "approve") {
      // approve 打给代币合约，所以要验的是被授权方（spender）
      const spender = decoded.args[0];
      const toBond = Boolean(chain.identityBond)
        && spender.toLowerCase() === chain.identityBond.toLowerCase();
      const toQuota = Boolean(chain.merchantBond)
        && spender.toLowerCase() === chain.merchantBond.toLowerCase();
      const ok = toBond || toQuota || (await factory.isDeal(spender));
      add(ok,
        toBond ? "被授权方是配置里的身份押金合约"
          : toQuota ? "被授权方是配置里的商家额度池"
            : "被授权方是工厂登记的托管合约",
        ok ? spender : `被授权方 ${spender} 不是本协议的合约。签下去等于把代币划转权交给一个陌生合约。`);

      // 无限授权在本协议里永远没有必要：每一步需要多少就授权多少。
      // 出现无限额度，说明这笔交易不是本机器人构造的。
      const MAX = (1n << 256n) - 1n;
      const finite = decoded.args[1] < MAX;
      add(finite, "不是无限授权",
        finite ? "额度有限" : "这是一笔无限授权 —— 本协议的任何步骤都不需要它，请勿签名");

      if (toBond || toQuota) {
        // 押入/预存金额由用户自己决定，没有可对照的链上数字，检查到此为止
        add(true, "授权额度检查",
          toBond ? "身份押金金额由你自行决定，页面不做额度上限判断"
            : "预存额度金额由你自行决定，页面不做额度上限判断");
      }

      // 授权额度不应超过该笔交易实际需要的金额
      if (ok && !toBond && !toQuota) {
        try {
          const deal = new ethers.Contract(spender, DEAL_READ_ABI, rpc);
          const [price, bb, sb] = await Promise.all([deal.price(), deal.buyerBond(), deal.sellerBond()]);
          const amount = decoded.args[1];
          const need = amount === sb ? sb : price + bb;
          const sane = amount <= (price + bb > sb ? price + bb : sb);
          add(sane, "授权额度不超过交易所需",
            sane ? "额度与该笔交易的入金金额一致" : `授权额度 ${amount} 超过了这笔交易可能需要的最大金额`);
          void need;
        } catch {
          add(true, "授权额度检查", "无法读取交易金额，跳过该项");
        }
      }
    }
  } catch (e) {
    add(false, "链上验证", `无法连接 RPC 完成验证：${e.message}`);
  }

  return checks;
}

// ---------------------------------------------------------------- 渲染

function riskClass(risk) {
  return { low: "risk-low", medium: "risk-medium", high: "risk-high", irreversible: "risk-irreversible" }[risk] ?? "risk-medium";
}

async function describeAmount(decoded, chain) {
  if (!decoded) return null;
  const rpc = new ethers.JsonRpcProvider(chain.rpcUrl);

  try {
    if (decoded.kind === "erc20" && decoded.name === "approve") {
      const token = new ethers.Contract(state.tx.to, ERC20_ABI, rpc);
      const [dec, sym] = await Promise.all([token.decimals(), token.symbol()]);
      return `${ethers.formatUnits(decoded.args[1], dec)} ${sym}`;
    }
    if (decoded.kind === "escrow" && (decoded.name === "depositBuyer" || decoded.name === "depositSeller")) {
      const deal = new ethers.Contract(state.tx.to, DEAL_READ_ABI, rpc);
      const [tokenAddr, price, bb, sb] = await Promise.all([
        deal.token(), deal.price(), deal.buyerBond(), deal.sellerBond(),
      ]);
      const token = new ethers.Contract(tokenAddr, ERC20_ABI, rpc);
      const [dec, sym] = await Promise.all([token.decimals(), token.symbol()]);
      const amt = decoded.name === "depositBuyer" ? price + bb : sb;
      return `${ethers.formatUnits(amt, dec)} ${sym}`;
    }
  } catch {
    return null;
  }
  return null;
}

function render() {
  const { tx, decoded, checks, chain } = state;
  let action = decoded ? ACTIONS[decoded.name] : null;

  // 同名方法必须按真实目标分流。`withdraw` 在身份押金合约上会让身份年龄归零，
  // 在商家额度池上只是取回一笔还没用掉的预付款 —— 两者显示同一段说明，
  // 用户会照着完全错误的描述点确认。
  if (decoded && decoded.name === "withdraw" && decoded.kind === "merchantBond") {
    action = WITHDRAW_BY_TARGET.merchantBond;
  }

  // approve 有三个可能的被授权方（托管合约 / 身份押金合约 / 商家额度池）。
  // 标题必须说的是这一笔真实的对象 —— 标题写「托管合约」而下面的核验行
  // 写「身份押金合约」，用户就得自己去判断哪个才算数，这正是签名页要消灭的事。
  if (action && decoded.name === "approve") {
    const spender = decoded.args[0].toLowerCase();
    if (chain.identityBond && spender === chain.identityBond.toLowerCase()) {
      action = {
        ...action,
        title: "授权身份押金合约划转你的代币",
        note: "这一步本身不转账，只是允许身份押金合约在下一步划走指定额度。额度只给本次所需，不是无限授权。",
      };
    } else if (chain.merchantBond && spender === chain.merchantBond.toLowerCase()) {
      action = {
        ...action,
        title: "授权商家额度池划转你的代币",
        note: "这一步本身不转账，只是允许额度池在下一步划走你要预存的金额。额度只给本次所需，不是无限授权。",
      };
    }
  }
  const allOk = checks.every((c) => c.ok);

  $("loading").hidden = true;
  $("main").hidden = false;

  $("action-title").textContent = action?.title ?? "无法识别的操作";
  $("action-note").textContent = action?.note ?? "本页面无法解读这笔交易的含义。请勿签名。";
  $("action-card").className = "card " + riskClass(action?.risk ?? "high");

  if (action?.risk === "irreversible") {
    $("irreversible").hidden = false;
  }

  $("chain-name").textContent = chain?.name ?? `链 ID ${tx.chainId}`;
  $("tx-to").textContent = tx.to;
  $("tx-data").textContent = tx.data;
  $("tx-value").textContent = tx.value === 0n ? "0（不发送原生币）" : ethers.formatEther(tx.value) + " ETH";
  $("tx-sig").textContent = decoded?.signature ?? "无法解码";

  const list = $("checks");
  list.innerHTML = "";
  for (const c of checks) {
    const li = document.createElement("li");
    li.className = c.ok ? "ok" : "bad";
    li.innerHTML = `<span class="mark">${c.ok ? "✓" : "✗"}</span><span><b></b><br><small></small></span>`;
    li.querySelector("b").textContent = c.label;
    li.querySelector("small").textContent = c.detail;
    list.appendChild(li);
  }

  if (!allOk) {
    $("blocked").hidden = false;
    $("connect").disabled = true;
    $("connect").textContent = "已阻止签名";
  }
}

function showError(msg) {
  $("loading").hidden = true;
  $("fatal").hidden = false;
  $("fatal-msg").textContent = msg;
}

// ---------------------------------------------------------------- 钱包

function injectedProvider() {
  if (typeof window.ethereum === "undefined") return null;
  return window.ethereum;
}

async function connect() {
  const eth = injectedProvider();
  if (!eth) {
    alert("没有检测到钱包。请在钱包内置浏览器里打开本页面，或安装浏览器钱包扩展。\n\n也可以复制下方的合约地址与 calldata，在任意钱包里手工发起这笔交易。");
    return;
  }

  const btn = $("connect");
  btn.disabled = true;
  btn.textContent = "连接中…";

  try {
    const bp = new ethers.BrowserProvider(eth);
    await bp.send("eth_requestAccounts", []);

    const net = await bp.getNetwork();
    if (Number(net.chainId) !== state.tx.chainId) {
      btn.textContent = "切换网络…";
      const hex = "0x" + state.tx.chainId.toString(16);
      try {
        await bp.send("wallet_switchEthereumChain", [{ chainId: hex }]);
      } catch (e) {
        // 4902 = 钱包里没有这条链
        if (e?.error?.code === 4902 || e?.code === 4902) {
          await bp.send("wallet_addEthereumChain", [{
            chainId: hex,
            chainName: state.chain.name,
            rpcUrls: [state.chain.rpcUrl],
            nativeCurrency: state.chain.nativeCurrency,
            blockExplorerUrls: state.chain.explorer ? [state.chain.explorer] : [],
          }]);
        } else {
          throw e;
        }
      }
    }

    state.provider = new ethers.BrowserProvider(eth);
    state.signer = await state.provider.getSigner();

    $("addr").textContent = await state.signer.getAddress();
    $("connected").hidden = false;
    btn.hidden = true;
    $("sign").hidden = false;
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "连接钱包";
    $("status").textContent = "连接失败：" + (e.shortMessage ?? e.message);
  }
}

async function sign() {
  const btn = $("sign");
  btn.disabled = true;
  btn.textContent = "请在钱包中确认…";
  $("status").textContent = "";

  try {
    const sent = await state.signer.sendTransaction({
      to: state.tx.to,
      data: state.tx.data,
      value: state.tx.value,
    });

    $("result").hidden = false;
    $("txhash").textContent = sent.hash;
    if (state.chain.explorer) {
      const a = $("txlink");
      a.href = `${state.chain.explorer}/tx/${sent.hash}`;
      a.hidden = false;
    }
    btn.textContent = "等待上链确认…";

    const rc = await sent.wait();
    btn.textContent = rc.status === 1 ? "✓ 已完成" : "交易失败";
    $("result-note").textContent = rc.status === 1
      ? "可以回到 Telegram 继续了。"
      : "交易被链上拒绝。请回到 Telegram 重新查看交易状态。";
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "签名并发送";
    const msg = e.shortMessage ?? e.message ?? String(e);
    $("status").textContent = /user rejected|ACTION_REJECTED/i.test(msg)
      ? "你取消了签名。"
      : "失败：" + msg;
  }
}

// ---------------------------------------------------------------- 启动


// ===================================================================== 消息签名
//
// 绑定钱包需要用户对一段文字做 personal_sign。MetaMask 插件**没有**给普通
// 用户签任意消息的入口 —— 让用户自己去找「personal_sign」等于让这条流程作废。
//
// 但做一个「签任意东西」的页面是危险的：personal_sign 一段 32 字节的十六进制，
// 签出来的东西可以当作另一条链上的交易签名用。一个能被任意 URL 驱动去签任意
// 内容的页面，本身就是一件钓鱼工具。
//
// 所以这里只接受本协议的绑定文本：必须以固定前缀开头，且必须是人能读懂的文字。
// 其它一律拒绝，包括看起来很像的。

const BIND_PREFIX = "人人担保 钱包绑定";

/// #msg=<base64url({text})>，没有就返回 null（说明是交易模式）
function parseMessageFragment() {
  const m = location.hash.match(/[#&]msg=([A-Za-z0-9_-]+)/);
  if (!m) return null;

  let json;
  try {
    const b64 = m[1].replace(/-/g, "+").replace(/_/g, "/");
    json = JSON.parse(decodeURIComponent(escape(atob(b64))));
  } catch {
    throw new Error("链接内容已损坏，无法解析。请回到 Telegram 重新获取。");
  }

  const text = json.text;
  if (typeof text !== "string" || text.length === 0) throw new Error("链接里没有待签名的内容。");
  if (text.length > 2000) throw new Error("待签名内容过长，已拒绝。");

  // 唯一的放行条件。不做「像不像」的判断 —— 判断得越聪明，被绕过的方式越多。
  if (!text.startsWith(BIND_PREFIX)) {
    throw new Error(
      "本页面只用于签署本协议的钱包绑定文本，不是一个通用的签名工具。" +
      "你打开的链接要求签署别的内容，已拒绝。" +
      "如果这个链接不是机器人给你的，请不要再打开它。"
    );
  }
  // 控制字符会让展示出来的内容和实际签的不一致 —— 用户看到的必须就是签的。
  if (/[\u0000-\u0008\u000B-\u001F\u007F]/.test(text)) {
    throw new Error("待签名内容里有不可见字符，已拒绝签名。");
  }
  return { text };
}

async function runMessageMode(msg) {
  $("loading").hidden = true;
  $("msgmain").hidden = false;
  $("msg-text").textContent = msg.text;

  let signer = null;

  $("msg-connect").addEventListener("click", async () => {
    try {
      const eth = injectedProvider();
      if (!eth) throw new Error("没有检测到钱包。请在 MetaMask 等钱包的内置浏览器里打开本页面。");
      const provider = new ethers.BrowserProvider(eth);
      await provider.send("eth_requestAccounts", []);
      signer = await provider.getSigner();
      $("msg-addr").textContent = await signer.getAddress();
      $("msg-connected").hidden = false;
      $("msg-connect").hidden = true;
      $("msg-sign").hidden = false;
      $("msg-status").textContent = "";
    } catch (e) {
      $("msg-status").textContent = e.shortMessage || e.message;
    }
  });

  $("msg-sign").addEventListener("click", async () => {
    try {
      $("msg-status").textContent = "请在钱包里确认…";
      // signMessage 走的就是 personal_sign，钱包会原样展示这段文字
      const sig = await signer.signMessage(msg.text);
      $("msg-sig").textContent = sig;
      $("msg-result").hidden = false;
      $("msg-sign").hidden = true;
      $("msg-status").textContent = "";
    } catch (e) {
      $("msg-status").textContent = e.shortMessage || e.message;
    }
  });

  $("msg-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("msg-sig").textContent);
      $("msg-copy").textContent = "已复制";
      setTimeout(() => { $("msg-copy").textContent = "复制签名"; }, 1500);
    } catch {
      // 剪贴板在非 HTTPS 或权限受限时会失败。签名本来就显示在页面上，手动选中即可。
      $("msg-copy").textContent = "复制失败，请手动选中上面那串";
    }
  });
}

async function main() {
  // 消息签名和交易签名是两条完全独立的路径，共用一个页面但不共用任何状态。
  try {
    const msg = parseMessageFragment();
    if (msg) return runMessageMode(msg);
  } catch (e) {
    return showError(e.message);
  }

  try {
    state.tx = parseFragment();
  } catch (e) {
    return showError(e.message);
  }

  state.chain = window.ESCROW_CONFIG?.chains?.[state.tx.chainId];
  if (!state.chain) {
    return showError(`本页面未配置链 ID ${state.tx.chainId}。请联系服务提供方。`);
  }
  if (!ethers.isAddress(state.chain.factory) || state.chain.factory === ethers.ZeroAddress) {
    return showError("本页面尚未配置工厂合约地址，无法验证交易目标的真伪，因此拒绝签名。");
  }

  state.decoded = decodeCalldata(state.tx.data);
  state.checks = await runChecks(state.tx, state.decoded, state.chain);

  render();

  const amount = await describeAmount(state.decoded, state.chain);
  if (amount) {
    $("amount").textContent = amount;
    $("amount-row").hidden = false;
  }

  $("connect").addEventListener("click", connect);
  $("sign").addEventListener("click", sign);
  $("toggle-raw").addEventListener("click", () => {
    const box = $("raw");
    box.hidden = !box.hidden;
    $("toggle-raw").textContent = box.hidden ? "显示原始交易数据" : "隐藏原始交易数据";
  });
}

/// 只改 URL 的 # 片段不会触发页面重载。
///
/// 如果不管这件事，用户从 Telegram 点开第二个签名链接时，
/// 页面会继续显示**上一笔**交易的描述与核验结果，而 URL 里已经是新交易了 ——
/// 他看到的和他即将签的不是同一个东西。这是能直接导致资金损失的错位。
///
/// 用整页重载而不是重新跑一遍 main()：签名器、连接状态、已通过的核验
/// 全都是上一笔交易的上下文，任何残留都可能造成新的错位。
window.addEventListener("hashchange", () => location.reload());

main();
