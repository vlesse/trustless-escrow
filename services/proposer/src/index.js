import fs from "node:fs";
import { config, describeConfig } from "./config.js";
import { makeClients, loadCase, submitProposal, assertIsProposer, Status } from "./chain.js";
import { adjudicate } from "./adjudicate.js";

const ONCE = process.argv.includes("--once");

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(config.stateFile, "utf8"));
  } catch {
    return { processed: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(config.stateFile, JSON.stringify(state, null, 2));
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

/// 处理单个争议。
async function handleDispute(id, clients, state) {
  const key = String(id);
  if (state.processed[key]) return;

  log(`[争议 ${id}] 开始处理`);

  const c = await loadCase(id, clients);
  if (c.skip) {
    log(`[争议 ${id}] 跳过：${c.skip}`);
    state.processed[key] = { skipped: c.skip, at: Date.now() };
    saveState(state);
    return;
  }

  // 超过提案窗口就别浪费 gas 了，合约会以 WindowClosed 拒绝
  const windowSec = Number(await clients.arbitrator.PROPOSAL_WINDOW());
  const age = Math.floor(Date.now() / 1000) - c.createdAt;
  if (age > windowSec) {
    log(`[争议 ${id}] 跳过：已超过提案窗口（${age}s > ${windowSec}s），案件将升级到陪审团`);
    state.processed[key] = { skipped: "提案窗口已关闭", at: Date.now() };
    saveState(state);
    return;
  }

  log(`[争议 ${id}] 托管合约 ${c.escrow}，收集到 ${c.evidence.length} 份证据`);
  for (const e of c.evidence) {
    log(`  - ${e.submitter}/${e.kind} [${e.verification.level}] ${e.verification.note}`);
  }

  if (c.evidence.length === 0) {
    log(`[争议 ${id}] 弃权：没有任何证据，无从判断`);
    state.processed[key] = { abstained: "无证据", at: Date.now() };
    saveState(state);
    return;
  }

  const { ruling, verdict, usage } = await adjudicate(c);

  log(`[争议 ${id}] 裁决=${verdict.ruling} 置信度=${verdict.confidence.toFixed(2)}`);
  log(`[争议 ${id}] 理由：${verdict.reasoning}`);
  if (verdict.decisive_evidence.length) {
    log(`[争议 ${id}] 决定性证据：${verdict.decisive_evidence.join("; ")}`);
  }
  if (verdict.injection_attempt_by !== "none") {
    log(`[争议 ${id}] ⚠ 检测到提示注入企图，来自：${verdict.injection_attempt_by}`);
  }
  if (verdict.unresolved_questions.length) {
    log(`[争议 ${id}] 未决问题：${verdict.unresolved_questions.join("; ")}`);
  }
  log(`[争议 ${id}] token 用量：输入 ${usage.input_tokens}（缓存命中 ${usage.cache_read_input_tokens ?? 0}），输出 ${usage.output_tokens}`);

  if (ruling === null) {
    const why = verdict.ruling === "inconclusive"
      ? "证据不足以定论"
      : `置信度 ${verdict.confidence.toFixed(2)} 低于门槛 ${config.minConfidence}`;
    log(`[争议 ${id}] 弃权（${why}）—— 案件将超时升级到人类陪审团`);
    state.processed[key] = { abstained: why, verdict, at: Date.now() };
    saveState(state);
    return;
  }

  if (config.dryRun) {
    log(`[争议 ${id}] 干跑模式：本应提交 ruling=${ruling}（${ruling === 1 ? "买家胜" : "卖家胜"}），未上链`);
    // 干跑不写入 processed，这样切到正式模式后还会重新处理
    return;
  }

  const result = await submitProposal(id, ruling, c.token, clients);
  log(`[争议 ${id}] 已提交 ruling=${ruling}，质押 ${result.bond}，tx=${result.hash}`);
  state.processed[key] = { ruling, verdict, tx: result.hash, at: Date.now() };
  saveState(state);
}

/// 扫描历史上所有尚未处理的 Open 状态争议。
/// 事件订阅会漏掉服务停机期间发生的争议，这个扫描是兜底。
async function scanPending(clients, state) {
  const { arbitrator } = clients;
  const events = await arbitrator.queryFilter(arbitrator.filters.DisputeCreated(), 0, "latest");
  for (const ev of events) {
    const id = ev.args.id;
    if (state.processed[String(id)]) continue;
    try {
      await handleDispute(id, clients, state);
    } catch (e) {
      log(`[争议 ${id}] 处理失败：${e.message}`);
    }
  }
}

async function main() {
  console.log("AI 提案人服务");
  console.log(describeConfig());
  console.log();

  const clients = makeClients();
  log(`提案人地址 ${clients.wallet.address}`);

  if (!config.dryRun) {
    await assertIsProposer(clients);
    log("已确认本钱包是合约认可的提案人");
  } else {
    log("干跑模式：只计算裁决并打印，不会上链、不会质押");
  }

  const state = loadState();

  await scanPending(clients, state);
  if (ONCE) {
    log("单次扫描完成，退出");
    return;
  }

  clients.arbitrator.on(clients.arbitrator.filters.DisputeCreated(), async (id) => {
    log(`收到新争议事件 ${id}`);
    try {
      await handleDispute(id, clients, state);
    } catch (e) {
      log(`[争议 ${id}] 处理失败：${e.message}`);
    }
  });
  log("已订阅 DisputeCreated 事件");

  setInterval(async () => {
    try {
      await scanPending(clients, state);
    } catch (e) {
      log(`兜底扫描失败：${e.message}`);
    }
  }, config.pollIntervalMs);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
