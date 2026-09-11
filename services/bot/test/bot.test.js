import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";

process.env.TELEGRAM_BOT_TOKEN ??= "test:token";
process.env.RPC_URL ??= "http://127.0.0.1:8545";
process.env.ESCROW_FACTORY ??= "0x0000000000000000000000000000000000000001";
process.env.CHAIN_ID ??= "42161";

const { scanForSecrets, SecretKind } = await import("../src/secrets.js");
const { buildChallenge, newNonce, verifyBinding } = await import("../src/wallet.js");
const { availableActions, State } = await import("../src/deals.js");
const { validateStep } = await import("../src/commands.js");
const { buildTx, buildDepositFlow, ESCROW_ABI, FACTORY_ABI } = await import("../src/txlink.js");
const { esc } = await import("../src/telegram.js");

// ============================================================ 密钥粘贴防护

describe("私钥 / 助记词粘贴防护", () => {
  test("识别裸私钥（带 0x 与不带）", () => {
    const key = "0x" + "a3".repeat(32);
    assert.equal(scanForSecrets(key)?.kind, SecretKind.PRIVATE_KEY);
    assert.equal(scanForSecrets(key.slice(2))?.kind, SecretKind.PRIVATE_KEY);
    assert.equal(
      scanForSecrets(`我的私钥是 ${key} 帮我操作一下`)?.kind,
      SecretKind.PRIVATE_KEY
    );
  });

  test("识别 12 词与 24 词助记词", () => {
    const m12 = "legal winner thank year wave sausage worth useful legal winner thank yellow";
    const m24 = m12 + " " + m12;
    assert.equal(scanForSecrets(m12)?.kind, SecretKind.MNEMONIC);
    assert.equal(scanForSecrets(m24)?.kind, SecretKind.MNEMONIC);
  });

  test("助记词检测优先于私钥检测（更严重）", () => {
    const both = "legal winner thank year wave sausage worth useful legal winner thank yellow 0x" + "bb".repeat(32);
    assert.equal(scanForSecrets(both)?.kind, SecretKind.MNEMONIC);
  });

  test("正常消息不误报", () => {
    const benign = [
      "/bind",
      "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
      "货已经发出了，请查收",
      "The item was shipped yesterday via DHL",
      "same",
      "ipfs://QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
    ];
    for (const b of benign) {
      assert.equal(scanForSecrets(b), null, `不应误报: ${b}`);
    }
  });

  test("提交证据的上下文里，64 位十六进制视为交易哈希不告警", () => {
    const txHash = "0x" + "7f".repeat(32);
    assert.notEqual(scanForSecrets(txHash), null, "默认上下文应告警");
    assert.equal(
      scanForSecrets(txHash, { expectTxHash: true }),
      null,
      "证据上下文里是合理的交易哈希，不应打扰用户"
    );
  });

  test("助记词检测在证据上下文里依然生效", () => {
    const m12 = "legal winner thank year wave sausage worth useful legal winner thank yellow";
    assert.equal(
      scanForSecrets(m12, { expectTxHash: true })?.kind,
      SecretKind.MNEMONIC,
      "助记词在任何上下文里都不该被放过"
    );
  });
});

// ================================================================ 钱包绑定

describe("钱包绑定签名校验", () => {
  const wallet = ethers.Wallet.createRandom();
  const userId = 123456789;

  test("正确签名可通过并恢复出地址", async () => {
    const nonce = newNonce();
    const issuedAt = Date.now();
    const sig = await wallet.signMessage(buildChallenge(userId, nonce, issuedAt));

    const r = verifyBinding({ telegramUserId: userId, nonce, issuedAt, signature: sig });
    assert.equal(r.ok, true);
    assert.equal(r.address, wallet.address);
  });

  test("别人的签名无法冒用（挑战里绑定了 Telegram 用户 ID）", async () => {
    const nonce = newNonce();
    const issuedAt = Date.now();
    // 攻击者拿到了受害者为「用户 A」签的那段文字的签名
    const sig = await wallet.signMessage(buildChallenge(userId, nonce, issuedAt));

    // 试图用它绑定到「用户 B」名下
    const r = verifyBinding({ telegramUserId: 987654321, nonce, issuedAt, signature: sig });
    assert.notEqual(r.address, wallet.address, "换了用户 ID 就该恢复出别的地址");
  });

  test("换了 nonce 的签名不通过（防重放）", async () => {
    const issuedAt = Date.now();
    const sig = await wallet.signMessage(buildChallenge(userId, newNonce(), issuedAt));
    const r = verifyBinding({
      telegramUserId: userId, nonce: newNonce(), issuedAt, signature: sig,
      claimedAddress: wallet.address,
    });
    assert.equal(r.ok, false);
  });

  test("过期的挑战被拒绝", async () => {
    const nonce = newNonce();
    const issuedAt = Date.now() - 11 * 60 * 1000;
    const sig = await wallet.signMessage(buildChallenge(userId, nonce, issuedAt));
    const r = verifyBinding({ telegramUserId: userId, nonce, issuedAt, signature: sig });
    assert.equal(r.ok, false);
    assert.match(r.reason, /过期/);
  });

  test("挑战文本明确声明不是交易", () => {
    const text = buildChallenge(userId, "abc", Date.now());
    assert.match(text, /这不是一笔交易/);
    assert.match(text, /不会转移任何资产/);
  });

  test("垃圾签名不会抛异常，只返回失败", () => {
    const r = verifyBinding({
      telegramUserId: userId, nonce: "x", issuedAt: Date.now(), signature: "不是签名",
    });
    assert.equal(r.ok, false);
  });
});

// ========================================================== 操作可用性状态机

describe("操作可用性（合约状态机的镜像）", () => {
  const base = {
    buyer: "0x1111111111111111111111111111111111111111",
    seller: "0x2222222222222222222222222222222222222222",
    buyerFunded: false, sellerFunded: false,
    deliveryDeadline: 2_000_000_000,
    inspectionDeadline: 2_000_100_000,
  };
  const NOW = 1_900_000_000;
  const ids = (deal, role, now = NOW) => availableActions(deal, role, now).map((a) => a.id);

  test("待入金：各自只看到自己那一侧的入金", () => {
    const d = { ...base, state: State.Open };
    assert.deepEqual(ids(d, "buyer").sort(), ["cancel", "deposit"]);
    assert.deepEqual(ids(d, "seller").sort(), ["cancel", "deposit"]);
  });

  test("已入金的一方不再看到入金按钮", () => {
    const d = { ...base, state: State.Open, buyerFunded: true };
    assert.deepEqual(ids(d, "buyer"), ["cancel"]);
    assert.ok(ids(d, "seller").includes("deposit"));
  });

  test("已锁定：卖家可标记交付，买家可提前放款", () => {
    const d = { ...base, state: State.Funded, buyerFunded: true, sellerFunded: true };
    assert.deepEqual(ids(d, "seller"), ["delivered"]);
    assert.deepEqual(ids(d, "buyer"), ["confirm"]);
  });

  test("交付期过后：买家可索赔，卖家可提争议对抗", () => {
    const d = { ...base, state: State.Funded, buyerFunded: true, sellerFunded: true };
    const after = d.deliveryDeadline + 1;
    assert.ok(ids(d, "buyer", after).includes("nondelivery"));
    assert.ok(ids(d, "seller", after).includes("dispute"));
  });

  test("验收期内：只有买家能操作", () => {
    const d = { ...base, state: State.Delivered, buyerFunded: true, sellerFunded: true };
    assert.deepEqual(ids(d, "buyer").sort(), ["confirm", "dispute"]);
    assert.deepEqual(ids(d, "seller"), [], "卖家在验收期内无事可做，等待即可");
  });

  test("验收期过后：任何一方都能推动结算", () => {
    const d = { ...base, state: State.Delivered, buyerFunded: true, sellerFunded: true };
    const after = d.inspectionDeadline + 1;
    assert.deepEqual(ids(d, "buyer", after), ["settle"]);
    assert.deepEqual(ids(d, "seller", after), ["settle"]);
  });

  test("争议中：双方都只能补充证据", () => {
    const d = { ...base, state: State.Disputed };
    assert.deepEqual(ids(d, "buyer"), ["evidence"]);
    assert.deepEqual(ids(d, "seller"), ["evidence"]);
  });

  test("终态无可用操作", () => {
    for (const s of [State.Resolved, State.Cancelled]) {
      assert.deepEqual(ids({ ...base, state: s }, "buyer"), []);
    }
  });

  test("无关第三方在任何状态下都看不到操作", () => {
    for (const s of Object.values(State)) {
      assert.deepEqual(availableActions({ ...base, state: s }, null, NOW), []);
    }
  });
});

// ============================================================== 输入校验

describe("创建交易的输入校验", () => {
  test("地址必须合法", () => {
    const d = {};
    assert.ok(validateStep("counterparty", "not-an-address", d));
    assert.equal(validateStep("counterparty", "0x70997970c51812dc3a010c7d01b50e0d17dc79c8", d), null);
    assert.equal(d.counterparty, "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", "应规范化为校验和地址");
  });

  test("金额必须是正数", () => {
    const d = {};
    assert.ok(validateStep("price", "0", d));
    assert.ok(validateStep("price", "-5", d));
    assert.ok(validateStep("price", "abc", d));
    assert.equal(validateStep("price", "1000.5", d), null);
  });

  test("保证金可用 same 跟随货款", () => {
    const d = { priceRaw: "1000" };
    assert.equal(validateStep("bond", "same", d), null);
    assert.equal(d.bondRaw, "1000");
  });

  test("时限必须是合理范围内的整数小时", () => {
    const d = {};
    assert.ok(validateStep("deliveryHours", "0", d));
    assert.ok(validateStep("deliveryHours", "2.5", d));
    assert.ok(validateStep("deliveryHours", "99999", d));
    assert.equal(validateStep("deliveryHours", "72", d), null);
    assert.equal(d.deliveryHours, 72);
  });

  test("条款过短被拒绝 —— 争议时仲裁方只看这段文字", () => {
    const d = {};
    assert.ok(validateStep("terms", "发货", d));
    assert.equal(
      validateStep("terms", "商品：数字激活码一枚。交付：24 小时内发送至买家邮箱。验收：可正常激活。", d),
      null
    );
  });
});

// ================================================== ABI 与真实合约的一致性

describe("calldata 与真实合约一致", () => {
  const artifactsDir = path.resolve(process.cwd(), "../../artifacts/contracts");

  function selectorsOf(artifactPath) {
    const json = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    const iface = new ethers.Interface(json.abi);
    const out = new Map();
    iface.forEachFunction((f) => out.set(f.selector, f.format("sighash")));
    return out;
  }

  test("机器人手写的 Escrow ABI 与编译产物选择器一致", { skip: !fs.existsSync(artifactsDir) }, () => {
    const real = selectorsOf(path.join(artifactsDir, "Escrow.sol", "Escrow.json"));
    const mine = new ethers.Interface(ESCROW_ABI);
    mine.forEachFunction((f) => {
      assert.ok(
        real.has(f.selector),
        `Escrow 上不存在 ${f.format("sighash")}（选择器 ${f.selector}）—— 机器人会让用户签出一笔调不通的交易`
      );
    });
  });

  test("机器人手写的 Factory ABI 与编译产物选择器一致", { skip: !fs.existsSync(artifactsDir) }, () => {
    const real = selectorsOf(path.join(artifactsDir, "EscrowFactory.sol", "EscrowFactory.json"));
    const mine = new ethers.Interface(FACTORY_ABI);
    mine.forEachFunction((f) => {
      assert.ok(real.has(f.selector), `EscrowFactory 上不存在 ${f.format("sighash")}`);
    });
  });

  test("编码出的 calldata 可被原样解码回参数", () => {
    const uri = "ipfs://QmTest";
    const tx = buildTx("escrow", "0x3333333333333333333333333333333333333333",
      "raiseDispute", [uri], "提起争议");
    const decoded = new ethers.Interface(ESCROW_ABI).decodeFunctionData("raiseDispute", tx.data);
    assert.equal(decoded[0], uri);
    assert.equal(tx.value, "0", "本协议的所有调用都不附带原生币");
  });

  test("入金是两步且顺序为先授权后入金", () => {
    const token = "0x4444444444444444444444444444444444444444";
    const escrow = "0x5555555555555555555555555555555555555555";
    const txs = buildDepositFlow({ token, escrow, amount: 1000n, role: "buyer" });

    assert.equal(txs.length, 2);
    assert.equal(txs[0].to, ethers.getAddress(token), "第一步应打给代币合约");
    assert.equal(txs[1].to, ethers.getAddress(escrow), "第二步才打给托管合约");

    const approve = new ethers.Interface(["function approve(address,uint256)"])
      .decodeFunctionData("approve", txs[0].data);
    assert.equal(approve[0], ethers.getAddress(escrow));
    assert.equal(approve[1], 1000n, "授权额度只给本次所需，不做无限授权");
  });
});

// ============================================================ 消息格式

describe("MarkdownV2 转义", () => {
  test("地址里的特殊字符被转义（漏一个整条消息就发不出去）", () => {
    assert.equal(esc("a-b.c_d"), "a\\-b\\.c\\_d");
  });

  test("金额里的小数点和负号被转义", () => {
    assert.equal(esc("1000.50"), "1000\\.50");
    assert.equal(esc("-5"), "\\-5");
  });

  test("反斜杠本身被转义", () => {
    assert.equal(esc("a\\b"), "a\\\\b");
  });
});

// ====================================================== 事件通知

const { describeEvent, describeDeadline } = await import("../src/watcher.js");

/// MarkdownV2 校验：正文里除了作为语法的 * 和 `，其余特殊字符都必须转义。
/// 漏一个 Telegram 会直接拒收整条消息 —— 不是显示错乱，是用户什么都收不到。
function assertValidMarkdownV2(text, label) {
  let inCode = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") { i++; continue; }      // 已转义，跳过下一个字符
    if (c === "`") { inCode = !inCode; continue; }
    if (inCode) continue;                    // 代码块内十六进制地址天然安全
    if (c === "*") continue;                 // 有意的加粗标记
    if ("_[]()~>#+-=|{}.!".includes(c)) {
      assert.fail(
        `${label}: 第 ${i} 位的 "${c}" 未转义，Telegram 会拒收整条消息\n  …${text.slice(Math.max(0, i - 30), i + 30)}…`
      );
    }
  }
  assert.equal(inCode, false, `${label}: 代码块未闭合`);
}

describe("事件通知", () => {
  const deal = {
    address: "0x24B3c7704709ed1491473F30393FFc93cFB0FC34",
    buyer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    seller: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    buyerFunded: true, sellerFunded: true,
    deliveryDeadline: 2_000_000_000, inspectionDeadline: 2_000_100_000,
  };
  const info = { decimals: 6, symbol: "USDT", address: deal.buyer };

  const CASES = [
    ["Deposited", { party: deal.buyer, amount: 2_000_000_000n }],
    ["Activated", { deliveryDeadline: 2_000_000_000n, lockedArbCost: 100_000_000n }],
    ["DeliveryMarked", { seller: deal.seller, evidenceURI: "ipfs://x", inspectionDeadline: 2_000_100_000n }],
    ["DisputeRaised", { by: deal.buyer, disputeID: 1n, evidenceURI: "ipfs://y" }],
    ["Ruled", { disputeID: 1n, ruling: 0n }],
    ["Ruled", { disputeID: 1n, ruling: 1n }],
    ["Settled", { finalState: 5n, toBuyer: 0n, toSeller: 2_995_000_000n, toArbitrator: 0n, fee: 5_000_000n }],
  ];

  for (const [name, args] of CASES) {
    test(`${name} 生成的消息是合法 MarkdownV2`, () => {
      const msgs = describeEvent(name, args, deal, info);
      assert.ok(msgs.length > 0, "应当产生至少一条通知");
      for (const m of msgs) assertValidMarkdownV2(m.text, `${name}/${m.to}`);
    });
  }

  test("到期提醒的两种文案都是合法 MarkdownV2", () => {
    for (const kind of ["delivery", "inspection"]) {
      for (const remaining of [86_400, 21_600, 3_600, 90_000]) {
        const m = describeDeadline(deal, kind, remaining);
        assertValidMarkdownV2(m.text, `${kind}/${remaining}`);
      }
    }
  });

  test("通知只发给需要知道的那一方", () => {
    // 买家入金 → 只通知卖家，不给买家发「你自己入金了」
    const dep = describeEvent("Deposited", { party: deal.buyer, amount: 1n }, deal, info);
    assert.deepEqual(dep.map((m) => m.to), ["seller"]);

    // 卖家标记交付 → 只通知买家（要开始验收的是他）
    const dm = describeEvent("DeliveryMarked",
      { seller: deal.seller, evidenceURI: "", inspectionDeadline: 2_000_100_000n }, deal, info);
    assert.deepEqual(dm.map((m) => m.to), ["buyer"]);

    // 买家提争议 → 只通知卖家
    const dr = describeEvent("DisputeRaised", { by: deal.buyer, disputeID: 1n, evidenceURI: "" }, deal, info);
    assert.deepEqual(dr.map((m) => m.to), ["seller"]);
  });

  test("到期提醒只发给「不作为会吃亏」的那一方", () => {
    // 交付期：卖家不动作会被买家取回全款
    assert.equal(describeDeadline(deal, "delivery", 3600).to, "seller");
    // 验收期：买家不动作货款自动放给卖家
    assert.equal(describeDeadline(deal, "inspection", 3600).to, "buyer");
  });

  test("验收期提醒必须说清「逾期会自动放款」", () => {
    const m = describeDeadline(deal, "inspection", 3600);
    assert.match(m.text, /自动放给卖家/, "用户需要知道不作为的后果，否则提醒没有意义");
    assert.match(m.text, /不可撤销/);
  });

  test("结算通知分别告知各方实收金额", () => {
    const msgs = describeEvent("Settled",
      { finalState: 5n, toBuyer: 1_000_000n, toSeller: 2_000_000n, toArbitrator: 0n, fee: 0n }, deal, info);
    const buyer = msgs.find((m) => m.to === "buyer");
    const seller = msgs.find((m) => m.to === "seller");
    // 金额在消息里是 MarkdownV2 转义后的形式：1\.0 而非 1.0
    assert.match(buyer.text, /1\\.0 USDT/);
    assert.match(seller.text, /2\\.0 USDT/);
  });
});
