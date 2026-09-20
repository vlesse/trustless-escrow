import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";

/**
 * keeper 手写的 ABI 与窗口常量，必须和合约对得上。
 *
 * 这两类东西错了都**没有运行时信号**：
 *   - 签名对不上 → 调用直接失败，keeper 安静地什么都不推，争议一直卡着；
 *   - 窗口常量对不上 → 推早了白白 revert，推晚了资金多压好几天。
 * 所以拿编译产物和合约源码逐个核对。
 */

// chain.js 会拉起 config.js，而 config 在导入时就校验环境变量
process.env.RPC_URL ??= "http://127.0.0.1:8545";
process.env.KEEPER_PRIVATE_KEY ??= "0x" + "11".repeat(32);
process.env.ESCROW_FACTORY ??= "0x0000000000000000000000000000000000000001";

const c = await import("../src/chain.js");
const t = await import("../src/tasks.js");

const artifacts = path.resolve(process.cwd(), "../../artifacts/contracts");
const contracts = path.resolve(process.cwd(), "../../contracts");

function iface(rel) {
  const p = path.join(artifacts, rel);
  if (!fs.existsSync(p)) return null;
  return new ethers.Interface(JSON.parse(fs.readFileSync(p, "utf8")).abi);
}

const PAIRS = [
  ["EscrowFactory", "EscrowFactory.sol/EscrowFactory.json", () => c.FACTORY_ABI],
  ["Escrow", "Escrow.sol/Escrow.json", () => c.ESCROW_ABI],
  ["OptimisticArbitrator", "arbitration/OptimisticArbitrator.sol/OptimisticArbitrator.json", () => c.OPTIMISTIC_ABI],
  ["StakedJury", "arbitration/StakedJury.sol/StakedJury.json", () => c.JURY_ABI],
  ["Reputation", "reputation/Reputation.sol/Reputation.json", () => c.REPUTATION_ABI],
];

describe("手写 ABI 与编译产物一致", () => {
  for (const [name, rel, abi] of PAIRS) {
    const real = iface(rel);

    test(`${name}：事件与函数都真的存在`, { skip: !real }, () => {
      const topics = new Set();
      real.forEachEvent((e) => topics.add(e.topicHash));
      const selectors = new Set();
      real.forEachFunction((f) => selectors.add(f.selector));

      for (const sig of abi()) {
        if (sig.startsWith("event ")) {
          const f = ethers.EventFragment.from(sig);
          assert.ok(topics.has(f.topicHash), `${name} 上不存在事件 ${f.format("sighash")}`);
        } else {
          const f = ethers.FunctionFragment.from(sig);
          assert.ok(selectors.has(f.selector), `${name} 上不存在 ${f.format("sighash")}`);
        }
      }
    });

    test(`${name}：只读方法的返回结构也要对`, { skip: !real }, () => {
      for (const sig of abi()) {
        if (!sig.startsWith("function ")) continue;
        const mine = ethers.FunctionFragment.from(sig);
        if (mine.outputs.length === 0) continue;
        let theirs = null;
        real.forEachFunction((f) => { if (f.selector === mine.selector) theirs = f; });
        if (!theirs) continue;
        assert.equal(
          mine.outputs.length, theirs.outputs.length,
          `${mine.name} 返回字段数量不符：手写 ${mine.outputs.length}，实际 ${theirs.outputs.length}`
        );
        // 结构体返回值：字段数量也要一致，少一个会让后面的字段整体错位
        if (mine.outputs[0].components) {
          assert.equal(
            mine.outputs[0].components.length,
            theirs.outputs[0].components?.length,
            `${mine.name} 的结构体字段数量不符 —— 少写一个会让后续字段全部错位，而且不报错`
          );
        }
      }
    });
  }
});

describe("窗口常量与合约源码一致", () => {
  // `10 days` / `72 hours` 这类字面量转成秒
  const UNITS = { seconds: 1, minutes: 60, hours: 3600, days: 86400, weeks: 604800 };
  // 不用正则划边界：这份仓库的编辑管道吃过一层反斜杠，正则被啃坏之后
  // 三条断言一起变红，而且看起来像是常量真的对不上。indexOf 没有这个风险。
  function constantOf(file, name) {
    const src = fs.readFileSync(path.join(contracts, file), "utf8");
    const head = "constant " + name;
    const a = src.indexOf(head);
    if (a < 0) return null;
    const eq = src.indexOf("=", a);
    const semi = src.indexOf(";", eq);
    if (eq < 0 || semi < 0) return null;
    const body = src.slice(eq + 1, semi).trim().split(/\s+/);
    const n = Number(body[0].split("_").join(""));
    if (!Number.isFinite(n)) return null;
    const unit = body[1];
    return unit && UNITS[unit] ? n * UNITS[unit] : n;
  }

  const CHECKS = [
    ["ROUND_TIMEOUT", "arbitration/StakedJury.sol", () => t.ROUND_TIMEOUT],
    ["PROPOSAL_WINDOW", "arbitration/OptimisticArbitrator.sol", () => t.PROPOSAL_WINDOW],
    ["CHALLENGE_WINDOW", "arbitration/OptimisticArbitrator.sol", () => t.CHALLENGE_WINDOW],
  ];

  for (const [name, file, mine] of CHECKS) {
    const exists = fs.existsSync(path.join(contracts, file));
    test(`${name} 对得上`, { skip: !exists }, () => {
      const onChain = constantOf(file, name);
      assert.ok(onChain !== null, `没在 ${file} 里找到常量 ${name}`);
      assert.equal(
        mine(), onChain,
        `${name} 不一致：keeper=${mine()} 合约=${onChain}。` +
        `推早了会白白 revert，推晚了资金要多压 ${Math.abs(mine() - onChain) / 86400} 天`
      );
    });
  }
});
