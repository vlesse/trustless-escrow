/*
 * 证据查看页。
 *
 * 证据包存在我们自己的服务器上，链上只记它的地址，而**文件名就是内容的
 * SHA-256**。所以这个页面做的第一件事不是显示，是核对：自己重算一遍哈希，
 * 对上了才说「和链上记录一致」。每张图片也一样单独核对。
 *
 * 这样服务器（包括运营方）改了证据里的任何一个字节，这里都会显示出来 ——
 * 证据的可信度不建立在「相信服务器」上。服务器唯一能做的坏事是把文件删掉，
 * 那样这个页面会明说「找不到」，而不是假装一切正常。
 *
 * 所有内容一律 textContent 放进页面，不当 HTML 解释 —— 证据是当事人写的，
 * 当事人之一可能正想在这里塞脚本。
 */

// 只改 # 后面的编号不会重新加载页面。不处理的话，同一个标签页里点开第二份
// 证据，看到的仍是第一份的「✅ 一致」—— 实测踩到了。整页重载，不留任何旧状态。
window.addEventListener("hashchange", () => location.reload());

(async function () {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };
  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const sha256 = async (buf) => hex(await crypto.subtle.digest("SHA-256", buf));

  const verdict = (ok, text) => {
    $("verdict").textContent = text;
    $("verdict").className = "verdict " + (ok ? "ok" : "bad");
  };

  const id = (location.hash.match(/^#([0-9a-f]{64})$/) || [])[1];
  if (!id) return verdict(false, "链接不完整：缺少证据编号。请回到 Telegram 重新点开。");

  let buf;
  try {
    const res = await fetch(`evidence/${id}.json`, { cache: "no-store" });
    if (!res.ok) return verdict(false, "找不到这份证据（服务器上没有这个文件）。");
    buf = await res.arrayBuffer();
  } catch (e) {
    return verdict(false, "读取失败，请检查网络后刷新。");
  }

  const actual = await sha256(buf);
  if (actual !== id) {
    verdict(false, "❌ 内容和链上记录不一致 —— 这份文件被改动过，不能作为证据。");
    $("how").textContent = `应为 ${id}，实际算出 ${actual}`;
    return;
  }
  verdict(true, "✅ 内容和链上记录一致，没有被改动过");
  $("how").textContent = "本页面自己重新算了一遍内容的 SHA-256，和链上记录的编号完全相同。";

  let doc;
  try {
    doc = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    return verdict(false, "文件格式无法识别。");
  }

  const METHOD = { markDelivered: "卖家标记交付时附的凭证", raiseDispute: "提起争议时附的理由", submitEvidence: "提交的证据" };
  const kv = $("kv");
  for (const [k, v] of [
    ["类型", METHOD[doc.method] ?? String(doc.method)],
    ["交易", String(doc.deal)],
    ["提交人", String(doc.by)],
    ["整理时间", new Date(doc.createdAt).toLocaleString("zh-CN", { hour12: false })],
  ]) {
    kv.appendChild(el("dt", "", k));
    kv.appendChild(el("dd", "", v));
  }
  $("meta").hidden = false;

  const box = $("items");
  (doc.items || []).forEach((it, i) => {
    const card = el("div", "card");
    card.appendChild(el("p", "n", `第 ${i + 1} 条 · ${{ text: "文字", link: "链接", image: "图片" }[it.type] ?? "未知"}`));

    if (it.type === "text") {
      card.appendChild(el("p", "text", String(it.text)));
    } else if (it.type === "link") {
      const a = el("a", "link", String(it.url));
      // 只放行 http(s)，别的协议（javascript: 之类）一律只显示不给点
      if (/^https?:\/\//i.test(it.url)) {
        a.href = it.url;
        a.target = "_blank";
        a.rel = "noopener noreferrer nofollow";
      }
      card.appendChild(a);
      card.appendChild(el("p", "warn", "这是当事人给的链接，打开前确认是正常网址。"));
    } else if (it.type === "image" && /^[0-9a-f]{64}$/.test(it.sha256) && /^(jpg|png|webp)$/.test(it.ext)) {
      const src = `evidence/${it.sha256}.${it.ext}`;
      const check = el("p", "imgcheck", "正在核对这张图……");
      card.appendChild(check);
      fetch(src, { cache: "no-store" })
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error("missing"))))
        .then(async (b) => {
          const h = await sha256(b);
          if (h !== it.sha256) {
            check.textContent = "❌ 这张图被改动过，不显示。";
            check.className = "imgcheck bad";
            return;
          }
          const img = el("img");
          img.alt = `证据图片 ${i + 1}`;
          img.src = URL.createObjectURL(new Blob([b]));
          card.insertBefore(img, check);
          check.textContent = "✅ 图片和提交时的一致";
          check.className = "imgcheck ok";
        })
        .catch(() => {
          check.textContent = "找不到这张图（服务器上没有这个文件）。";
          check.className = "imgcheck bad";
        });
    }
    box.appendChild(card);
  });
})();
