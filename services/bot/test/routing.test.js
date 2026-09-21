import { test, describe } from "node:test";
import assert from "node:assert/strict";

/**
 * 群聊与私聊的分流。
 *
 * 这几条判断错一个，后果都不是报错，而是别的东西：
 *   群里不该回的回了 → 机器人对每条闲聊都回「发送 /help」，群直接没法用；
 *   群里不该收流程输入却收了 → 用户的一句闲聊变成了交易条款；
 *   私聊里误判成群 → 整个产品不能用。
 * 三件事在开发者自己私聊试用时一件都不会发生，所以只能靠测试钉住。
 */
const { route, PRIVATE_ONLY } = await import("../src/routing.js");

const priv = (text, hasFlow = false) => route({ chatType: "private", text, hasFlow });
const grp = (text, hasFlow = false) => route({ chatType: "supergroup", text, hasFlow });

describe("群聊分流", () => {
  test("群里的普通聊天一律不回 —— 否则机器人会刷屏到群不能用", () => {
    assert.equal(grp("今天天气不错").action, "ignore");
    assert.equal(grp("").action, "ignore");
    assert.equal(grp("0x1234").action, "ignore");
  });

  test("就算这个人正在走流程，群里的发言也不当成流程输入", () => {
    // 否则用户在群里聊一句天，就成了他那笔交易的条款
    assert.equal(grp("一共一千块", true).action, "ignore");
    assert.equal(priv("一共一千块", true).action, "flow");
  });

  test("涉及个人资料的命令在群里被挡下，并指向私聊", () => {
    for (const c of PRIVATE_ONLY) {
      const r = grp(c);
      assert.equal(r.action, "private-only", c + " 不该在群里执行");
      assert.equal(r.command, c);
    }
  });

  test("带 @机器人后缀也要认出来 —— 群里 Telegram 会自动加上", () => {
    assert.equal(grp("/bind@Renrendb_bot").action, "private-only");
    assert.equal(grp("/deal@Renrendb_bot 0xabc").action, "command");
  });

  test("查公开信息的命令留在群里 —— 买卖双方本来就该当面一起看", () => {
    assert.equal(grp("/deal 0xabc").action, "command");
    assert.equal(grp("/rep 0xabc").action, "command");
    assert.equal(grp("/help").action, "command");
    assert.equal(grp("/start").action, "command");
  });

  test("私聊里什么都能用", () => {
    for (const c of PRIVATE_ONLY) assert.equal(priv(c).action, "command", c);
  });

  test("参数照常解析", () => {
    const r = priv("/deal 0xabc def");
    assert.deepEqual(r.args, ["0xabc", "def"]);
    assert.equal(r.command, "/deal");
  });

  test("私聊里没有流程时提示帮助", () => {
    assert.equal(priv("随便说点什么").action, "hint");
  });

  test("绑定必须在私聊 —— 群里绑定等于当众把账号和地址钉在一起", () => {
    assert.ok(PRIVATE_ONLY.has("/bind"));
    assert.equal(grp("/bind").action, "private-only");
  });
});
