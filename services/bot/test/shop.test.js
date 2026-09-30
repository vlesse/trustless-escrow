process.env.TELEGRAM_BOT_TOKEN ??= "test:token";
process.env.RPC_URL ??= "http://127.0.0.1:8545";
process.env.ESCROW_FACTORY ??= "0x0000000000000000000000000000000000000001";
process.env.CHAIN_ID ??= "97";
process.env.SIGNING_PAGE_URL ??= "https://db.example/";

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";

const shop = await import("../src/shop.js");
const { parseStep } = await import("../src/shopcommands.js");
const { describeEvent, shouldAnnounceCreated } = await import("../src/watcher.js");

const U = (n) => ethers.parseUnits(String(n), 18);
const INFO = { decimals: 18, symbol: "USDT" };

describe("链接", () => {
  test("购买深链只认 buy_数字", () => {
    assert.equal(shop.parseBuyPayload("buy_12"), 12n);
    for (const bad of ["buy_", "buy_x", "12", "", undefined, "buy_1234567890"]) {
      assert.equal(shop.parseBuyPayload(bad), null, String(bad));
    }
  });
  test("下单页、取货页链接带链编号，签名页地址末尾的斜杠不会变成双斜杠", () => {
    assert.equal(shop.buyLink(7n), "https://db.example/buy.html#id=7&chain=97");
    assert.equal(shop.pickupLink("0xAbC"), "https://db.example/pickup.html#deal=0xAbC&chain=97");
  });
});

describe("默认押金与条款", () => {
  test("两份押金都不能低于仲裁费（否则交易激活不了）", () => {
    assert.deepEqual(shop.defaultBonds(U(100), U(100)), { sellerBond: U(100), buyerBond: U(100) });
    assert.deepEqual(shop.defaultBonds(U(1000), U(10)), { sellerBond: U(1000), buyerBond: U(100) });
    assert.deepEqual(shop.defaultBonds(U(5), U(10)), { sellerBond: U(10), buyerBond: U(10) });
  });
  test("点卡模板第一行就是商品名，下单页、推送都从这里取名字", () => {
    const t = shop.cardTerms("王者荣耀 100 元点卡", 1);
    assert.equal(shop.titleOf(t, 1), "王者荣耀 100 元点卡");
    assert.match(t, /交付/); assert.match(t, /验收/); assert.match(t, /例外/);
  });
});

describe("上架输入校验", () => {
  test("名称：一行、40 字以内", () => {
    assert.deepEqual(parseStep("name", " 点卡 "), ["点卡", null]);
    assert.ok(parseStep("name", "")[1]);
    assert.ok(parseStep("name", "字".repeat(41))[1]);
    assert.ok(parseStep("name", "两\n行")[1]);
  });
  test("价格：数字，可以带 USDT、逗号", () => {
    assert.deepEqual(parseStep("price", "1,000 USDT"), [U(1000), null]);
    assert.ok(parseStep("price", "abc")[1]);
    assert.ok(parseStep("price", "0")[1]);
  });
  test("库存、时限：整数，范围合理", () => {
    assert.deepEqual(parseStep("stock", "50"), [50, null]);
    assert.ok(parseStep("stock", "0")[1]);
    assert.ok(parseStep("stock", "1.5")[1]);
    assert.deepEqual(parseStep("dw", "24"), [24, null]);
    assert.ok(parseStep("iw", "1000")[1]);
  });
  test("自己写的条款：没写「商品：」开头就补上，保证能取到商品名", () => {
    assert.equal(parseStep("ownterms", "月卡一张，发邮箱，能用就算")[0], "商品：月卡一张，发邮箱，能用就算");
    assert.ok(parseStep("ownterms", "太短")[1]);
  });
});

describe("商品卡片", () => {
  const l = { seller: "0x" + "1".repeat(40), active: true, stock: 3n, sold: 0n, deliveryWindow: 3600n,
    inspectionWindow: 86400n, price: U(100), buyerBond: U(20), sellerBond: U(50), terms: shop.cardTerms("点卡", 1) };

  test("正常在售：没有阻止提示，付款金额 = 货款 + 买家押金", () => {
    const c = shop.listingCard(1n, l, INFO, U(150));
    assert.equal(c.blocked, null);
    assert.ok(c.text.includes("120\\.0 USDT"));
  });
  test("下架 / 卖完 / 卖家押金不够：都要明说，而且不给下单按钮", () => {
    assert.match(shop.listingCard(1n, { ...l, active: false }, INFO, U(150)).blocked, /下架/);
    assert.match(shop.listingCard(1n, { ...l, stock: 0n }, INFO, U(150)).blocked, /卖完/);
    assert.match(shop.listingCard(1n, l, INFO, U(49)).blocked, /押金/);
  });
  test("还能接几单按最贵那件在售商品的押金算；下架的不算", () => {
    const cap = shop.capacity(U(150), [{ l }, { l: { ...l, active: false, sellerBond: U(1000) } }]);
    assert.deepEqual(cap, { bond: U(50), orders: 3n });
  });
});

describe("店铺订单的推送", () => {
  const deal = { address: "0x24B3c7704709ed1491473F30393FFc93cFB0FC34",
    buyer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8", seller: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    state: 3, feeBps: 100, price: U(100), buyerBond: U(20), sellerBond: U(50) };

  /*
   * 店铺下单是开单和双方入金一步完成的。这时发「交易已创建，请入金」是错的。
   */
  test("交易一出生就已生效（店铺下单），不发「请入金」", () => {
    assert.equal(shouldAnnounceCreated({ state: 1 }), true);
    assert.equal(shouldAnnounceCreated({ state: 2 }), false);
  });

  test("加密发货：买家那条带「取卡密」按钮直达取货页；卖家那条没有", () => {
    const msgs = describeEvent("DeliveryMarked", { seller: deal.seller, evidenceURI: "sealed", inspectionDeadline: 2_000_000_000n }, deal, INFO);
    const b = msgs.find((m) => m.to === "buyer"), s = msgs.find((m) => m.to === "seller");
    assert.equal(b.buttons[0][0].url, `https://db.example/pickup.html#deal=${deal.address}&chain=97`);
    assert.equal(s.buttons, undefined);
    assert.match(b.text, /卖家已发货/);
    assert.doesNotMatch(b.text, /sealed/, "不能把内部标记 sealed 当成凭证链接展示给用户");
  });
});

describe("手写的店铺合约结构体与编译产物逐字段一致", () => {
  test("MerchantBond", () => {
    const p = path.resolve(process.cwd(), "../../artifacts/contracts/MerchantBond.sol/MerchantBond.json");
    assert.ok(fs.existsSync(p), `缺编译产物 ${p}`);
    const real = new ethers.Interface(JSON.parse(fs.readFileSync(p, "utf8")).abi);
    const shape = (ps) => ps.map((o) => o.baseType === "tuple"
      ? `tuple(${o.components.map((c) => `${c.type} ${c.name}`).join(", ")})` : o.type);
    for (const sig of shop.STORE_ABI) {
      const mine = ethers.FunctionFragment.from(sig);
      const theirs = real.getFunction(mine.selector);
      assert.ok(theirs, `MerchantBond 上不存在 ${mine.format("sighash")}`);
      assert.deepEqual(shape(mine.outputs), shape(theirs.outputs), `${mine.name} 的返回值对不上`);
    }
  });
});
