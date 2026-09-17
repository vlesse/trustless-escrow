import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";

/**
 * 手写 ABI 与编译产物的一致性。
 *
 * 由 2026-09-17 的一次改动暴露出来：往 `DisputeCreated` 里加了一个字段之后，
 * 提案人手写的那份 ABI 还是旧签名。事件的 topic0 是签名的哈希，签名一变，
 * **过滤器就再也匹配不上任何日志 —— 不报错，只是从此收不到争议**。
 * 这类失效没有任何运行时信号，只能靠对照编译产物来发现。
 */

const artifactsDir = path.resolve(process.cwd(), "../../artifacts/contracts");

const PAIRS = [
  ["OptimisticArbitrator", "arbitration/OptimisticArbitrator.sol/OptimisticArbitrator.json", "ARBITRATOR_ABI"],
  ["Escrow", "Escrow.sol/Escrow.json", "ESCROW_ABI"],
];

function realInterface(rel) {
  const p = path.join(artifactsDir, rel);
  if (!fs.existsSync(p)) return null;
  return new ethers.Interface(JSON.parse(fs.readFileSync(p, "utf8")).abi);
}

// chain.js 没有导出 ABI 常量，直接读源码里的字符串字面量 ——
// 这样测试盯的就是真正被用到的那几行，而不是另抄一份。
const src = fs.readFileSync(path.resolve(process.cwd(), "src/chain.js"), "utf8");
function abiOf(name) {
  // 刻意不用正则划边界：这份文件经历过一次「反斜杠被吃掉一层」，
  // 正则被啃坏之后三个用例一起变红，排查了半天。indexOf 没有这个风险。
  const head = "const " + name + " = [";
  const a = src.indexOf(head);
  assert.ok(a >= 0, "没在 chain.js 里找到 " + name);
  const b = src.indexOf("];", a);
  const body = src.slice(a + head.length, b);
  return [...body.matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

describe("提案人手写的 ABI 与合约一致", () => {
  for (const [name, rel, constName] of PAIRS) {
    const real = realInterface(rel);

    test(`${name}：事件签名逐条对得上`, { skip: !real }, () => {
      const known = new Set();
      real.forEachEvent((e) => known.add(e.topicHash));
      for (const sig of abiOf(constName)) {
        if (!sig.startsWith("event ")) continue;
        const frag = ethers.EventFragment.from(sig);
        assert.ok(
          known.has(frag.topicHash),
          `${name} 上不存在事件 ${frag.format("sighash")}\n  topic0=${frag.topicHash}\n  签名对不上就收不到任何日志，而且不会报错`
        );
      }
    });

    test(`${name}：函数选择器逐条对得上`, { skip: !real }, () => {
      const known = new Set();
      real.forEachFunction((f) => known.add(f.selector));
      for (const sig of abiOf(constName)) {
        if (!sig.startsWith("function ")) continue;
        const frag = ethers.FunctionFragment.from(sig);
        assert.ok(known.has(frag.selector), `${name} 上不存在 ${frag.format("sighash")}`);
      }
    });

    test(`${name}：只读方法的返回字段数量也要对`, { skip: !real }, () => {
      for (const sig of abiOf(constName)) {
        if (!sig.startsWith("function ")) continue;
        const mine = ethers.FunctionFragment.from(sig);
        if (mine.outputs.length === 0) continue;
        let theirs = null;
        real.forEachFunction((f) => { if (f.selector === mine.selector) theirs = f; });
        if (!theirs) continue;
        assert.equal(
          mine.outputs.length, theirs.outputs.length,
          `${mine.name} 的返回字段数量不符：手写 ${mine.outputs.length}，实际 ${theirs.outputs.length}\n` +
          `  少写一个字段不会报错，只会悄悄读不到它`
        );
      }
    });
  }
});
