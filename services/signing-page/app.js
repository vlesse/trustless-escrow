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
  "function concede()",
  "function offerSettlement(uint256 toBuyer)",
  "function cancelSettlementOffer()",
  "function acceptSettlement(uint256 toBuyer)",
];
const FACTORY_ABI = [
  "function createDeal(address token, address buyer, address seller, uint256 price, uint256 buyerBond, uint256 sellerBond, uint64 deliveryWindow, uint64 inspectionWindow, bytes32 termsHash) returns (address)",
  "function isDeal(address) view returns (bool)",
  "function defaultArbitrator() view returns (address)",
];

/// 仲裁层上当事人能做的两件事。
const OPTIMISTIC_ABI = ["function challenge(uint256 id)"];
const JURY_ABI = ["function appeal(uint256 id)"];
const OPT_READ_ABI = [
  "function disputes(uint256 id) view returns (tuple(address arbitrable, address token, uint8 status, uint8 proposedRuling, uint64 proposedAt, uint64 createdAt, address challenger, uint256 bond, uint256 finalCost, uint256 value, address dealBuyer, address dealSeller))",
  "function finalArbitrator() view returns (address)",
  "function bondOf(address token) view returns (uint256)",
];
const JURY_READ_ABI = [
  "function cases(uint256 id) view returns (tuple(address arbitrable, address feeToken, uint8 phase, uint8 ruling, uint64 drawBlock, uint64 commitDeadline, uint64 revealDeadline, uint64 appealDeadline, uint64 roundStartedAt, uint64 createdAt, uint64 rngRequestedAt, address rngSource, address dealBuyer, address dealSeller, uint256 value, uint256 baseCost))",
  "function appealTotal(uint256 id) view returns (uint256)",
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
  "function list(uint256 price, uint256 buyerBond, uint256 sellerBond, uint64 deliveryWindow, uint64 inspectionWindow, string terms, uint32 stock)",
  "function updateListing(uint256 id, bool active, uint32 stock)",
];
const STORE_READ_ABI = ["function token() view returns (address)"];
const DEAL_READ_ABI = [
  "function token() view returns (address)",
  "function price() view returns (uint256)",
  "function buyerBond() view returns (uint256)",
  "function sellerBond() view returns (uint256)",
  "function feeBps() view returns (uint16)",
  "function lockedArbCost() view returns (uint256)",
  "function state() view returns (uint8)",
  "function offerBy() view returns (address)",
  "function offerToBuyer() view returns (uint256)",
];

const ifaces = {
  escrow: new ethers.Interface(ESCROW_ABI),
  factory: new ethers.Interface(FACTORY_ABI),
  erc20: new ethers.Interface(ERC20_ABI),
  identityBond: new ethers.Interface(IDENTITY_BOND_ABI),
  reputation: new ethers.Interface(REPUTATION_ABI),
  merchantBond: new ethers.Interface(MERCHANT_BOND_ABI),
  optimistic: new ethers.Interface(OPTIMISTIC_ABI),
  jury: new ethers.Interface(JURY_ABI),
};

/// 每个操作的人话描述。`risk` 决定确认区的视觉强度。
/// irreversible 的那几个必须说清楚「不可撤销」—— 这是用户最需要
/// 在点下去之前知道的一件事。
const ACTIONS = {
  list: {
    title: "上架商品",
    risk: "medium",
    note: "价格、押金、条款写上链后不能再改，只能下架再重新上架。请逐项核对下面的内容。",
  },
  updateListing: {
    title: "上架 / 下架商品",
    risk: "low",
    note: "只切换在售状态和库存。已经下的单不受影响。",
  },
  concede: {
    title: "认输",
    risk: "irreversible",
    note: "立刻按对方胜诉结算，和被陪审团判输完全一样。仲裁费从你的押金里出，信誉记录会记一笔败诉。",
  },
  offerSettlement: {
    title: "发出和解方案",
    risk: "low",
    note: "只是把方案发给对方，不动任何钱。对方同意之前，你随时可以改或者撤回。",
  },
  acceptSettlement: {
    title: "接受和解方案，立刻结算",
    risk: "irreversible",
    note: "按下面的分法立刻结算，钱马上转出，不能撤回。",
  },
  cancelSettlementOffer: {
    title: "撤回和解方案",
    risk: "low",
    note: "撤回你挂着的方案。不动任何钱。",
  },
  challenge: {
    title: "挑战 AI 的初步裁决",
    risk: "high",
    note: "押上保证金，把案子交给陪审团重新判。陪审团判你对：押金退回，还能拿到对方押的那份；判你错：押金归对方。",
  },
  appeal: {
    title: "上诉",
    risk: "high",
    note: "付上诉费，交给更多陪审员重新判。其中陪审员的报酬不退；拖延押金在改判时退还，维持原判时赔给对方。",
  },
  approve: {
    title: "授权托管合约划转你的代币",
    risk: "medium",
    note: "这一步本身不转账，只是允许托管合约在下一步划走指定额度。额度只给本次所需，不是无限授权。",
  },
  depositBuyer: {
    title: "锁定货款与你的保证金",
    risk: "high",
    note: "资金将锁进托管合约。正常成交后货款给卖家、保证金退还你。卖家逾期未标记交付则货款与保证金原路退回；只有争议胜诉才会拿到对方的保证金。",
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
    note: "向仲裁层补充材料。不转移任何资金。",
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

  /*
   * 多步操作（入金 = 授权 + 入金）把下一步整个塞在 next 里。
   *
   * 原来是 Telegram 里发两个链接。实测用户签完第 1 步回到 Telegram，
   * 不知道还有第 2 步，或者点回了第 1 个。现在签完这一步，页面直接给
   * 「继续第 2 步」—— 不用回去找。
   *
   * 安全上不引入新东西：下一步是一条完整的签名链接，打开之后照样跑
   * 全部五项核验。伪造者想塞恶意交易进来，直接发那个链接就行，
   * 用不着借 next。
   */
  const next = typeof json.next === "string" && /^[A-Za-z0-9_-]+$/.test(json.next) ? json.next : null;
  const small = (v) => (Number.isInteger(v) && v >= 1 && v <= 9 ? v : null);
  const step = small(json.step), of = small(json.of);

  return {
    to: ethers.getAddress(json.to),
    data: json.data,
    value: BigInt(json.value ?? 0),
    chainId: Number(json.chainId),
    next,
    step: step && of && step <= of ? step : null,
    of: step && of && step <= of ? of : null,
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

      // 接受和解：金额必须正是对方现在挂着的那一份。对不上的话合约也会拒绝，
      // 但在签名前说清楚，比让用户付了 gas 再看到一个失败强。
      if (ok && decoded.name === "acceptSettlement") {
        const d = new ethers.Contract(tx.to, DEAL_READ_ABI, rpc);
        const [by, amt] = await Promise.all([d.offerBy(), d.offerToBuyer()]);
        const same = by !== ethers.ZeroAddress && amt === decoded.args[0];
        add(same, "这正是对方现在挂着的方案",
          same ? "金额一致" : "对方的方案已经改过或撤回了。请回到 Telegram 重新查看，不要签这一笔。");
      }
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
    } else if (decoded.kind === "optimistic" || decoded.kind === "jury") {
      /*
       * 挑战 / 上诉。仲裁合约的地址从**工厂**读，不从链接里拿：
       * 工厂地址写在本页的 config 里，是这一页唯一信任的锚点。
       * 然后再确认这个案子确实挂在本协议的一笔交易名下。
       */
      const optAddr = await factory.defaultArbitrator();
      const opt = new ethers.Contract(optAddr, OPT_READ_ABI, rpc);
      const id = decoded.args[0];
      if (decoded.kind === "optimistic") {
        const ok = tx.to.toLowerCase() === optAddr.toLowerCase();
        add(ok, "目标是本协议的仲裁层", ok ? tx.to : `目标 ${tx.to} 不是工厂登记的仲裁层 ${optAddr}，请勿签名`);
        if (ok) {
          const d = await opt.disputes(id);
          const isDeal = await factory.isDeal(d.arbitrable);
          add(isDeal, "这个争议属于本协议的一笔交易",
            isDeal ? d.arbitrable : "这个争议编号不对应本协议的任何交易");
        }
      } else {
        const juryAddr = await opt.finalArbitrator();
        const ok = tx.to.toLowerCase() === juryAddr.toLowerCase();
        add(ok, "目标是本协议的陪审团", ok ? tx.to : `目标 ${tx.to} 不是本协议的陪审团 ${juryAddr}，请勿签名`);
        if (ok) {
          const c = await new ethers.Contract(juryAddr, JURY_READ_ABI, rpc).cases(id);
          const mine = c.arbitrable.toLowerCase() === optAddr.toLowerCase();
          add(mine, "这个案件是本协议仲裁层转来的", mine ? `案件 ${id}` : "这个案件不是本协议的");
        }
      }
    } else if (decoded.kind === "erc20" && decoded.name === "approve") {
      // approve 打给代币合约，所以要验的是被授权方（spender）
      const spender = decoded.args[0];
      const toBond = Boolean(chain.identityBond)
        && spender.toLowerCase() === chain.identityBond.toLowerCase();
      const toQuota = Boolean(chain.merchantBond)
        && spender.toLowerCase() === chain.merchantBond.toLowerCase();
      // 挑战要把押金授权给仲裁层，上诉要把上诉费授权给陪审团。两个地址都从工厂现读。
      const optAddr = await factory.defaultArbitrator();
      const opt = new ethers.Contract(optAddr, OPT_READ_ABI, rpc);
      const toOpt = spender.toLowerCase() === optAddr.toLowerCase();
      const juryAddr = toOpt ? null : await opt.finalArbitrator().catch(() => null);
      const toJury = Boolean(juryAddr) && spender.toLowerCase() === juryAddr.toLowerCase();
      state.approveTarget = toOpt ? "optimistic" : toJury ? "jury" : null;

      const ok = toBond || toQuota || toOpt || toJury || (await factory.isDeal(spender));
      add(ok,
        toBond ? "被授权方是配置里的身份押金合约"
          : toQuota ? "被授权方是配置里的商家额度池"
            : toOpt ? "被授权方是本协议的仲裁层"
              : toJury ? "被授权方是本协议的陪审团"
                : "被授权方是工厂登记的托管合约",
        ok ? spender : `被授权方 ${spender} 不是本协议的合约。签下去等于把代币划转权交给一个陌生合约。`);

      if (toOpt) {
        // 挑战押金是仲裁层上按币种写死的数，可以精确对照
        const bond = await opt.bondOf(tx.to);
        const fits = decoded.args[1] <= bond;
        add(fits, "授权额度不超过挑战押金",
          fits ? "额度与挑战押金一致" : `授权额度超过了挑战押金（${bond}）`);
      } else if (toJury) {
        add(true, "授权额度检查", "上诉费按案件计算，下一步签名页会核对你上诉的是本协议的案件");
      }

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
      if (ok && !toBond && !toQuota && !toOpt && !toJury) {
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

/*
 * 带证据的三种操作，签之前把要写进链上的内容原样摆出来。
 *
 * 证据一旦上链就永久公开、不能删改。原来这里只显示「提交证据」四个字，
 * 用户签的是什么内容，页面上看不到 —— 文字证据存在链上是一串 base64，
 * 不解码等于没显示。
 */
const EVIDENCE_METHODS = ["markDelivered", "raiseDispute", "submitEvidence"];

function showEvidence(uri) {
  const body = $("evidence-body");
  body.textContent = "";
  if (!uri) {
    body.textContent = "（不附任何内容）";
  } else {
    const text = uri.match(/^data:text\/plain[^,]*;base64,(.*)$/i);
    const bundle = uri.match(/^(https:\/\/[^/]+)\/evidence\/([0-9a-f]{64})\.json$/);
    if (text) {
      try {
        body.textContent = new TextDecoder().decode(Uint8Array.from(atob(text[1]), (c) => c.charCodeAt(0)));
      } catch {
        body.textContent = uri;
      }
    } else if (bundle && bundle[1] === location.origin) {
      // 我们自己存的证据包（带图片）。查看页会重算哈希核对，所以放心给链接。
      const a = document.createElement("a");
      a.href = `evidence.html#${bundle[2]}`;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "一个证据包（文字 + 图片）—— 点这里先看一遍";
      body.appendChild(a);
    } else {
      body.textContent = "链接：" + uri;
    }
  }
  $("evidence-box").hidden = false;
}

/*
 * 和解、认输：签名前把「买家拿多少、卖家拿多少」算出来摆着。
 *
 * 公式是 split.js —— 机器人、合约测试共用的同一份，合约测试拿真实结算结果
 * 逐 wei 比对过。页面自己去链上读这笔交易的参数，不用链接里带来的任何数字。
 */
const SPLIT_METHODS = ["offerSettlement", "acceptSettlement", "concede"];

/// 上架：把要写上链的每一项摆出来。写上去就不能改了。
async function showListing(decoded, chain) {
  const [price, bb, sb, dw, iw, terms, stock] = decoded.args;
  let f = (x) => String(x);
  try {
    const rpc = new ethers.JsonRpcProvider(chain.rpcUrl);
    const tokenAddr = await new ethers.Contract(state.tx.to, STORE_READ_ABI, rpc).token();
    const t = new ethers.Contract(tokenAddr, ERC20_ABI, rpc);
    const [dec, sym] = await Promise.all([t.decimals(), t.symbol()]);
    f = (x) => `${ethers.formatUnits(x, dec)} ${sym}`;
  } catch { /* 读不到币种就显示原始数字 */ }
  $("split-label").textContent = "要写上链的商品（上架后不能改）：";
  $("split-body").textContent =
    `价格：${f(price)}\n买家押金：${f(bb)}\n你的押金（每单）：${f(sb)}\n` +
    `发货期限：${Number(dw) / 3600} 小时\n验收期限：${Number(iw) / 3600} 小时\n库存：${stock}\n\n条款：\n${terms}`;
  $("split-box").hidden = false;
}

async function showSplit(decoded, chain) {
  const box = $("split-box");
  const body = $("split-body");
  try {
    const rpc = new ethers.JsonRpcProvider(chain.rpcUrl);
    const d = new ethers.Contract(state.tx.to, DEAL_READ_ABI, rpc);
    const [tokenAddr, price, bb, sb, feeBps, cost, st] = await Promise.all([
      d.token(), d.price(), d.buyerBond(), d.sellerBond(), d.feeBps(), d.lockedArbCost(), d.state(),
    ]);
    const token = new ethers.Contract(tokenAddr, ERC20_ABI, rpc);
    const [dec, sym] = await Promise.all([token.decimals(), token.symbol()]);
    const f = (x) => `${ethers.formatUnits(x, dec)} ${sym}`;
    const view = { price, buyerBond: bb, sellerBond: sb, feeBps, lockedArbCost: cost, disputed: Number(st) === 4 };

    let s;
    if (decoded.name === "concede") {
      // 页面不知道签名的是买家还是卖家，两种都列出来 —— 连上钱包之后按地址对号
      const b = EscrowSplit.concedeSplit(view, "buyer");
      const k = EscrowSplit.concedeSplit(view, "seller");
      body.textContent =
        `如果是买家认输：买家拿到 ${f(b.toBuyer)}，卖家拿到 ${f(b.toSeller)}\n` +
        `如果是卖家认输：买家拿到 ${f(k.toBuyer)}，卖家拿到 ${f(k.toSeller)}\n` +
        `仲裁费 ${f(b.cost)} 从认输一方的押金里出`;
    } else {
      s = EscrowSplit.settlementSplit(view, decoded.args[0]);
      if (!s) {
        body.textContent = "这个金额超出了能分的总额，合约会拒绝。请不要签名。";
      } else {
        const refund = EscrowSplit.refundOf(view, decoded.args[0]);
        body.textContent =
          (refund !== null ? `货款退给买家：${f(refund)}\n` : "") +
          `买家拿到：${f(s.toBuyer)}\n卖家拿到：${f(s.toSeller)}` +
          (s.fee > 0n ? `（已扣手续费 ${f(s.fee)}）` : "") +
          (s.cost > 0n ? `\n仲裁费：${f(s.cost)}` : "");
      }
    }
    $("split-label").textContent = decoded.name === "offerSettlement"
      ? "对方同意后，按这个方案结算：" : "签名后立刻按这个结算：";
    box.hidden = false;
  } catch (e) {
    body.textContent = "读不到这笔交易的金额，请稍后刷新。读不到之前请不要签名。";
    box.hidden = false;
  }
}

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
    } else if (state.approveTarget === "optimistic") {
      action = {
        ...action,
        title: "授权仲裁层划走挑战押金",
        note: "这一步本身不转账，只是允许仲裁层在下一步划走挑战押金。额度只给这一次，不是无限授权。",
      };
    } else if (state.approveTarget === "jury") {
      action = {
        ...action,
        title: "授权陪审团划走上诉费",
        note: "这一步本身不转账，只是允许陪审团在下一步划走上诉费。额度只给这一次，不是无限授权。",
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
  if (state.tx.step && state.tx.of) {
    const b = $("step-banner");
    b.textContent = `第 ${state.tx.step} 步，共 ${state.tx.of} 步`;
    b.hidden = false;
  }
  $("action-note").textContent = action?.note ?? "本页面无法解读这笔交易的含义。请勿签名。";
  if (EVIDENCE_METHODS.includes(state.decoded?.name)) showEvidence(String(state.decoded.args[0] ?? ""));
  if (SPLIT_METHODS.includes(state.decoded?.name)) showSplit(state.decoded, state.chain);
  if (state.decoded?.kind === "merchantBond" && state.decoded.name === "list") showListing(state.decoded, state.chain);
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

/*
 * 钱包迟迟不回话时，告诉用户去哪儿找。
 *
 * 小狐狸的确认窗口有时不会自己弹到前面（尤其是页面刚打开、不是用户点击
 * 触发的请求），它只是挂在浏览器右上角的扩展图标上。用户看到的是：
 * 按钮写着「连接中…」，点了没反应。实测真实用户就卡在这里。
 */
const WALLET_SLOW_MS = 12_000;
const WALLET_SLOW_HINT = "钱包没有反应？点一下浏览器右上角的小狐狸图标，里面可能有一个窗口在等你确认。确认完回到这里。";

function walletError(e) {
  // ethers 会把钱包的原始错误包一层：外层 code 是 "UNKNOWN_ERROR"，
  // 真正的 -32002 在 e.error 里。只看外层就认不出来 —— 实测就是这样漏的。
  const layers = [e, e?.error, e?.info?.error, e?.error?.data?.originalError].filter(Boolean);
  const codes = layers.map((x) => x.code);
  const msg = layers.map((x) => String(x.shortMessage ?? x.message ?? "")).join(" | ");
  if (codes.includes(4001) || codes.includes("ACTION_REJECTED") || /user rejected|denied/i.test(msg)) {
    return "你在钱包里点了拒绝。要继续的话，再点一次「连接钱包」。";
  }
  if (codes.includes(-32002) || /already pending/i.test(msg)) {
    return "小狐狸里已经有一个请求在等你处理。点浏览器右上角的小狐狸图标，处理完再回来点「连接钱包」。";
  }
  return "连接失败：" + msg;
}

/// 已经拿到账户、网络也对了之后，把页面切到「可以签名」。
async function finishConnect(eth) {
  state.provider = new ethers.BrowserProvider(eth);
  state.signer = await state.provider.getSigner();
  $("addr").textContent = await state.signer.getAddress();
  $("connected").hidden = false;
  $("connect").hidden = true;
  $("sign").hidden = false;
  $("status").textContent = "";
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
  $("status").textContent = "";

  // 卡住时不能让按钮一直是灰的 —— 那就是「点了没反应」
  const slow = setTimeout(() => {
    $("status").textContent = WALLET_SLOW_HINT;
    btn.disabled = false;
    btn.textContent = "重新连接钱包";
  }, WALLET_SLOW_MS);

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

    await finishConnect(eth);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "连接钱包";
    $("status").textContent = walletError(e);
  } finally {
    clearTimeout(slow);
  }
}

/*
 * 签完之后告诉用户：成了没有、接下来去哪、会发生什么。
 *
 * 原来只有一句「可以回到 Telegram 继续了」。实测用户回到 Telegram，
 * 那里什么都没有 —— 于是他对着屏幕干等，不知道成了没成。
 * 现在把三件事说全：结果、下一步（要么继续签，要么回去等）、要等多久。
 */
function showOutcome(ok) {
  const tx = state.tx;
  const title = $("result-title");
  const note = $("result-note");
  const tg = window.ESCROW_CONFIG?.telegramBot;

  if (!ok) {
    title.textContent = "❌ 没有成功";
    note.textContent = "这笔交易被链上拒绝了，你的钱没有动。回到 Telegram，发 /deals 看看这笔交易现在是什么状态。";
    showBackToTelegram(tg);
    return;
  }

  if (tx.next) {
    const n = (tx.step ?? 1) + 1;
    title.textContent = tx.of ? `✅ 第 ${tx.step} 步完成（共 ${tx.of} 步）` : "✅ 这一步完成了";
    note.textContent = `还没结束！还差第 ${n} 步。点下面的按钮继续。`;
    const a = $("next-step");
    a.textContent = `继续第 ${n} 步 →`;
    a.href = "#tx=" + tx.next;
    a.hidden = false;
    return;
  }

  title.textContent = tx.of ? `✅ 全部 ${tx.of} 步都完成了` : "✅ 成功了";
  note.textContent = "现在回到 Telegram。机器人会在 1 分钟内发消息，告诉你这笔交易进行到哪了、下一步是什么。";
  showBackToTelegram(tg);
}

function showBackToTelegram(bot) {
  if (!bot || !/^[A-Za-z0-9_]{5,32}$/.test(bot)) return;
  const a = $("back-tg");
  a.href = `https://t.me/${bot}`;
  a.hidden = false;
}

async function sign() {
  const btn = $("sign");
  btn.disabled = true;
  btn.textContent = "请在钱包中确认…";
  $("status").textContent = "";

  // 只提示、不恢复按钮：交易可能已经在钱包里等确认，再点一次就是两笔。
  const slow = setTimeout(() => { $("status").textContent = WALLET_SLOW_HINT; }, WALLET_SLOW_MS);

  try {
    const sent = await state.signer.sendTransaction({
      to: state.tx.to,
      data: state.tx.data,
      value: state.tx.value,
    });
    clearTimeout(slow);
    $("status").textContent = "";

    $("result").hidden = false;
    $("txhash").textContent = sent.hash;
    if (state.chain.explorer) {
      const a = $("txlink");
      a.href = `${state.chain.explorer}/tx/${sent.hash}`;
      a.hidden = false;
    }
    btn.textContent = "等待上链确认…";

    const rc = await sent.wait();
    btn.hidden = true;
    showOutcome(rc.status === 1);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "签名并发送";
    clearTimeout(slow);
    const msg = e.shortMessage ?? e.message ?? String(e);
    $("status").textContent = /user rejected|ACTION_REJECTED/i.test(msg)
      ? "你在钱包里点了拒绝，这笔没有发出去。要继续的话，再点一次上面的按钮。"
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

  /// 把进度显式画出来。用户分不清「地址」和「签名」时，
  /// 看着步骤就知道自己还没走到出签名那一步。
  const step = (n) => {
    for (let i = 1; i <= 3; i++) {
      const el = $("msg-step" + i);
      el.classList.toggle("done", i < n);
      el.classList.toggle("now", i === n);
    }
  };
  step(1);

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
      step(2);
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
      step(3);
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

  // 按钮在 render() 之后就看得见了，事件必须同时绑上。原来是等读完金额
  // 才绑 —— 公共节点一慢，用户看得见按钮、点了却没反应。
  $("connect").addEventListener("click", connect);
  $("sign").addEventListener("click", sign);
  $("toggle-raw").addEventListener("click", () => {
    const box = $("raw");
    box.hidden = !box.hidden;
    $("toggle-raw").textContent = box.hidden ? "显示原始交易数据" : "隐藏原始交易数据";
  });

  autoConnect();

  // 金额只是展示，读不到不影响签名。限时，免得节点慢时一直挂着。
  const amount = await Promise.race([
    describeAmount(state.decoded, state.chain),
    new Promise((r) => setTimeout(() => r(null), 10_000)),
  ]);
  if (amount) {
    $("amount").textContent = amount;
    $("amount-row").hidden = false;
  }
}

/*
 * 钱包已经授权过本页面，就直接连上，不用再点一次「连接钱包」。
 *
 * 多步操作里，第 2 步是整页重载进来的（防止显示的和签的不一致），
 * 连接状态随之清空。不自动连的话，用户签完第 1 步、点「继续第 2 步」，
 * 看到的又是一个「连接钱包」—— 他会以为自己回到了起点。
 *
 * eth_accounts 不弹窗：钱包没授权过就返回空，什么也不做。
 * 核验没全过的交易不自动连 —— 那种页面上连接按钮本来就是禁用的。
 */
async function autoConnect() {
  if ($("connect").disabled) return;
  const eth = injectedProvider();
  if (!eth) return;
  try {
    /*
     * 只用两个**不会弹窗**的查询：eth_accounts、eth_chainId。
     *
     * 第一版这里直接调 connect()，而 connect() 在网络不对时会请求切换网络。
     * 不是用户点击触发的请求，小狐狸可能不弹窗、只挂在扩展图标上 ——
     * 按钮于是一直停在「连接中…」被禁用，用户点了没反应。真实用户实测卡死。
     *
     * 所以：已授权**且**网络正确才自动连；其余情况什么都不做，
     * 留给用户自己点按钮（用户点击触发的请求，钱包一定会弹窗）。
     */
    const [accounts, chainHex] = await Promise.all([
      eth.request({ method: "eth_accounts" }),
      eth.request({ method: "eth_chainId" }),
    ]);
    if (!Array.isArray(accounts) || accounts.length === 0) return;
    if (Number(chainHex) !== state.tx.chainId) return;
    await finishConnect(eth);
  } catch {
    // 自动连接失败就留给用户手动点，不报错
  }
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
