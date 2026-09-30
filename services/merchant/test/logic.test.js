import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseCodes, assignedCodes, pickCode, remaining, stockPlan, topUpAmount, shouldDeliver } from "../src/logic.js";

describe("卡密文件", () => {
  test("一行一张，空行和注释跳过，重复的只算一次并报出来", () => {
    const { codes, duplicates } = parseCodes("# 第一批\nAAA-1\n\n  BBB-2  \nAAA-1\r\nCCC-3\n");
    assert.deepEqual(codes, ["AAA-1", "BBB-2", "CCC-3"]);
    assert.deepEqual(duplicates, ["AAA-1"], "同一张卡密卖给两个人是最直接的事故");
  });
});

/*
 * 同一张卡密永远不能发给第二个人，同一单也不能发两张。
 * 做法是先记账再发交易 —— 所以「分过的卡密」不管发没发成功都不能再给别人。
 */
describe("分卡密", () => {
  const codes = ["A", "B", "C"];

  test("新订单拿第一张还没分出去的", () => {
    const state = { assigned: { "0xaaa": { code: "A" } } };
    assert.equal(pickCode(state, "0xBBB", codes), "B");
  });

  test("分过卡密的订单重试时还用同一张 —— 程序崩了重启不会一单发两张", () => {
    const state = { assigned: { "0xbbb": { code: "C" } } };
    assert.equal(pickCode(state, "0xBBB", codes), "C", "地址大小写不同也要认出是同一单");
  });

  test("分出去但还没发成功的，也不能给别人", () => {
    const state = { assigned: { "0xaaa": { code: "A", delivered: false } } };
    assert.ok(!["A"].includes(pickCode(state, "0xccc", codes)));
    assert.deepEqual([...assignedCodes(state)], ["A"]);
  });

  test("卡密发完了返回 null（不能拿空字符串去加密发货）", () => {
    const state = { assigned: { a: { code: "A" }, b: { code: "B" }, c: { code: "C" } } };
    assert.equal(pickCode(state, "0xnew", codes), null);
  });

  test("剩余张数 = 文件里的 − 已分出去的", () => {
    assert.equal(remaining({ assigned: { x: { code: "B" } } }, 1, codes), 2);
  });
});

describe("库存与押金", () => {
  test("链上库存和剩余卡密一致就不动；不一致就改成剩余数", () => {
    assert.equal(stockPlan(3n, 3), null);
    assert.equal(stockPlan(5n, 3), 3, "卡密少了，链上要跟着少，否则会卖出发不了货的单");
    assert.equal(stockPlan(0n, 10), 10, "补了卡密，自动重新开卖");
  });

  test("押金补到够接 N 单为止；钱包里钱不够就能补多少补多少；不透支", () => {
    const B = 50n;
    assert.equal(topUpAmount({ poolBalance: 150n, walletBalance: 999n, bondPerOrder: B, targetOrders: 3 }), 0n);
    assert.equal(topUpAmount({ poolBalance: 50n, walletBalance: 999n, bondPerOrder: B, targetOrders: 3 }), 100n);
    assert.equal(topUpAmount({ poolBalance: 0n, walletBalance: 70n, bondPerOrder: B, targetOrders: 3 }), 70n);
    assert.equal(topUpAmount({ poolBalance: 0n, walletBalance: 0n, bondPerOrder: B, targetOrders: 3 }), 0n);
    assert.equal(topUpAmount({ poolBalance: 0n, walletBalance: 99n, bondPerOrder: B, targetOrders: 0 }), 0n, "设成 0 就是不自动补");
  });
});

describe("该不该发货", () => {
  const ok = { state: 2, deliveryDeadline: 2000, now: 1000, listingId: 1n, pickupKey: "0x02ab", hasCodes: true };
  test("条件都满足才发", () => assert.equal(shouldDeliver(ok).go, true));
  test("每一种不发的理由都说得出来", () => {
    assert.equal(shouldDeliver({ ...ok, state: 1 }).why, "not-funded");
    assert.equal(shouldDeliver({ ...ok, state: 3 }).why, "delivered-or-later");
    assert.equal(shouldDeliver({ ...ok, listingId: 0n }).why, "not-from-store");
    assert.equal(shouldDeliver({ ...ok, pickupKey: "0x" }).why, "no-pickup-key");
    assert.equal(shouldDeliver({ ...ok, now: 2000 }).why, "deadline-passed", "过了交付期合约不收，发了只会白付 gas");
    assert.equal(shouldDeliver({ ...ok, hasCodes: false }).why, "no-codes-file");
  });
});
