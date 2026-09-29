import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseEvidenceInput, describeEvidence, MAX_TEXT, TEXT_PREFIX } from "../src/evidence.js";

/**
 * 证据输入。
 *
 * 原来只收 https:// / ipfs:// 链接。真实用户的第一反应是「不能是聊天记录、
 * 截图吗？」—— 普通人手里有的是一段话、一张图，不是一个链接。
 *
 * 更要命的是图片：发一张截图过来，Telegram 给机器人的文字部分是空的，
 * 而空字符串被当成「不附证据」放行。用户以为交了截图，链上什么都没有。
 */
describe("证据输入", () => {
  test("发图片不能被当成「不附证据」", () => {
    const r = parseEvidenceInput("", { hasMedia: true });
    assert.equal(r.ok, false, "图片消息必须被拦下，不能变成一笔空证据");
    assert.equal(r.reason, "media");
    // 带图注也一样：图注不是用户想交的那张图
    assert.equal(parseEvidenceInput("看这张图", { hasMedia: true }).ok, false);
  });

  test("空消息不放行", () => {
    assert.equal(parseEvidenceInput("").ok, false);
    assert.equal(parseEvidenceInput("   ").ok, false);
  });

  test("文字直接写进链上，读回来是原文", () => {
    const say = "卖家 9月29日 22:10 发来的激活码，提示「已被使用」，无法激活。";
    const r = parseEvidenceInput(say);
    assert.equal(r.ok, true);
    assert.equal(r.kind, "text");
    assert.ok(r.uri.startsWith(TEXT_PREFIX));
    assert.equal(describeEvidence(r.uri).body, say);
  });

  test("链接照收，原样上链", () => {
    for (const l of ["https://example.com/a.png", "http://x.y/z", "ipfs://bafyabc"]) {
      const r = parseEvidenceInput(l);
      assert.deepEqual([r.ok, r.kind, r.uri], [true, "link", l]);
    }
    // 链接后面跟了话，就是一段文字，不是链接 —— 不能把整句话当 URL 上链
    assert.equal(parseEvidenceInput("https://example.com 这是截图").kind, "text");
  });

  test("skip 只在允许跳过的那两步有效", () => {
    assert.deepEqual(parseEvidenceInput("skip"), { ok: true, uri: "", kind: "none" });
    // 「提交证据」本身就是来交东西的，skip 就当一个词
    assert.equal(parseEvidenceInput("skip", { allowSkip: false }).kind, "text");
  });

  test("太长的文字拒绝，按字数算不按字节", () => {
    assert.equal(parseEvidenceInput("字".repeat(MAX_TEXT)).ok, true, "1000 个汉字是 3000 字节，但只算 1000 个字");
    const r = parseEvidenceInput("字".repeat(MAX_TEXT + 1));
    assert.deepEqual([r.ok, r.reason], [false, "too-long"]);
  });

  test("链上读回来的各种样子都认得", () => {
    assert.equal(describeEvidence("").kind, "none");
    // 卖家脚本一直用的是不带 charset 的写法，也要能解
    const legacy = "data:text/plain;base64," + Buffer.from("激活码已发送", "utf8").toString("base64");
    assert.deepEqual(describeEvidence(legacy), { kind: "text", body: "激活码已发送" });
    assert.equal(describeEvidence("https://renrenyings.net/").kind, "link");
  });
});
