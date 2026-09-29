import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  parseEvidenceInput, describeEvidence, canAdd, planSubmission, buildBundle, sniffImage,
  summarizeItems, itemsToText, sha256Hex, MAX_TEXT, MAX_ITEMS, MAX_IMAGES, TEXT_PREFIX,
} from "../src/evidence.js";

/**
 * 证据篮。
 *
 * 原来只收 https:// / ipfs:// 链接，而且一条一签。真实用户的两个问题：
 * 「不能是聊天记录、截图吗？」「整理证据不可能几十秒就完，能不能多次发？」
 *
 * 更要命的是图片：发一张截图过来，Telegram 给机器人的文字部分是空的，
 * 而空字符串被当成「不附证据」放行。用户以为交了截图，链上什么都没有。
 */
describe("证据输入", () => {
  test("非图片的媒体不能被当成「不附证据」", () => {
    const r = parseEvidenceInput("", { hasMedia: true });
    assert.deepEqual([r.ok, r.reason], [false, "media"]);
  });

  test("空消息不放行", () => {
    assert.equal(parseEvidenceInput("").ok, false);
    assert.equal(parseEvidenceInput("   ").ok, false);
  });

  test("文字、链接各成一条", () => {
    assert.deepEqual(parseEvidenceInput(" 激活码无法使用 ").item, { type: "text", text: "激活码无法使用" });
    for (const l of ["https://example.com/a.png", "http://x.y/z", "ipfs://bafyabc"]) {
      assert.deepEqual(parseEvidenceInput(l).item, { type: "link", url: l });
    }
    // 链接后面跟了话，就是一段文字 —— 不能把整句话当 URL
    assert.equal(parseEvidenceInput("https://example.com 这是截图").item.type, "text");
  });

  test("skip 只在允许跳过时有效", () => {
    assert.equal(parseEvidenceInput("skip").skip, true);
    assert.equal(parseEvidenceInput("skip", { allowSkip: false }).item.type, "text");
  });

  test("太长的文字拒绝，按字数算不按字节", () => {
    assert.equal(parseEvidenceInput("字".repeat(MAX_TEXT)).ok, true, "1000 个汉字是 3000 字节，但只算 1000 个字");
    assert.equal(parseEvidenceInput("字".repeat(MAX_TEXT + 1)).reason, "too-long");
  });
});

describe("证据篮与上链方式", () => {
  const T = (text) => ({ type: "text", text });
  const IMG = { type: "image", sha256: "a".repeat(64), ext: "jpg", bytes: 1234 };

  test("篮子有上限，图片单独有上限", () => {
    assert.equal(canAdd(Array(MAX_ITEMS).fill(T("x")), "text").reason, "too-many");
    assert.equal(canAdd(Array(MAX_IMAGES).fill(IMG), "image").reason, "too-many-images");
    assert.equal(canAdd(Array(MAX_IMAGES).fill(IMG), "text").ok, true, "图满了还能加文字");
  });

  test("只有文字和链接：合在一起直接上链，读回来是原文", () => {
    const items = [T("22:10 卖家发来激活码"), { type: "link", url: "https://x.y/1" }, T("提示已被使用")];
    const p = planSubmission(items);
    assert.equal(p.kind, "text");
    assert.ok(p.uri.startsWith(TEXT_PREFIX));
    const back = describeEvidence(p.uri).body;
    assert.equal(back, itemsToText(items));
    assert.match(back, /【1】22:10 卖家发来激活码\n【2】链接：https:\/\/x\.y\/1\n【3】提示已被使用/);
  });

  test("有图片就走证据包；文字太多也走证据包，不硬塞进一笔交易", () => {
    assert.equal(planSubmission([T("看图"), IMG]).kind, "bundle");
    assert.equal(planSubmission(Array(5).fill(T("字".repeat(MAX_TEXT)))).kind, "bundle");
  });

  test("证据包：同样内容永远同一个哈希，改一个字就变", () => {
    const meta = { deal: "0xD", by: "0xB", method: "submitEvidence", createdAt: "2026-09-30T00:00:00.000Z" };
    const a = buildBundle({ ...meta, items: [T("看图"), IMG] });
    const b = buildBundle({ ...meta, items: [T("看图"), IMG] });
    const c = buildBundle({ ...meta, items: [T("看图!"), IMG] });
    assert.equal(a.sha256, b.sha256);
    assert.notEqual(a.sha256, c.sha256);
    assert.equal(a.sha256, sha256Hex(Buffer.from(a.json, "utf8")), "哈希就是文件内容的哈希，任何人都能自己算");
    assert.doesNotMatch(a.json, /\/srv|\\\\|evidence-store/, "包里不能带服务器本地路径");
  });

  test("认得出证据包地址，别家长得像的不算", () => {
    const base = "https://db.renrenyings.net/evidence";
    const sha = "b".repeat(64);
    assert.deepEqual(describeEvidence(`${base}/${sha}.json`, { bundleBase: base }),
      { kind: "bundle", body: `${base}/${sha}.json`, sha256: sha });
    assert.equal(describeEvidence(`https://evil.example/evidence/${sha}.json`, { bundleBase: base }).kind, "link");
  });

  test("篮子一句话概括", () => {
    assert.equal(summarizeItems([T("a"), T("b"), IMG]), "文字 2 段、图片 1 张");
    assert.equal(summarizeItems([]), "还没有内容");
  });
});

describe("图片格式", () => {
  /// 按文件头认，不信 Telegram 给的类型也不信文件名 ——
  /// 服务器绝不能变成替人托管任意文件的地方。
  test("只认 JPG / PNG / WEBP 的文件头", () => {
    const pad = Buffer.alloc(16);
    assert.equal(sniffImage(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), pad])), "jpg");
    assert.equal(sniffImage(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pad])), "png");
    assert.equal(sniffImage(Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), pad])), "webp");
    assert.equal(sniffImage(Buffer.from("<html><script>alert(1)</script></html>")), null, "HTML 冒充图片");
    assert.equal(sniffImage(Buffer.concat([Buffer.from("%PDF-1.7"), pad])), null);
    assert.equal(sniffImage(Buffer.from([0xff, 0xd8])), null, "太短");
  });
});

test("链上读回来的各种样子都认得", () => {
  assert.equal(describeEvidence("").kind, "none");
  // 卖家脚本一直用的是不带 charset 的写法，也要能解
  const legacy = "data:text/plain;base64," + Buffer.from("激活码已发送", "utf8").toString("base64");
  assert.deepEqual(describeEvidence(legacy), { kind: "text", body: "激活码已发送" });
  assert.equal(describeEvidence("https://renrenyings.net/").kind, "link");
});
