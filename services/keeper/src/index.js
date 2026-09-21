/// keeper：推动协议里那些「任何人都可以做、但没人会主动做」的步骤。
///
/// 为什么需要它：陪审团流程有四步是无需许可的（抽签、开揭示、计票、结案），
/// 乐观层还有两步。**无需许可不等于会有人做。** 没有 keeper，争议会一直卡着，
/// 直到十天的兜底超时触发，然后以拒裁收场 —— 该赢的人拿不到该拿的。
///
/// 它的钥匙偷走一文不值：能做的每一件事，合约上任何人都能做。
import fs from "node:fs";
import { ethers } from "ethers";
import { pathToFileURL } from "node:url";
import { config, describeConfig } from "./config.js";
import * as chain from "./chain.js";
import * as tasks from "./tasks.js";

const log = (...a) => console.log(new Date().toISOString(), ...a);

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(config.stateFile, "utf8"));
  } catch {
    return { fromBlock: 0, deals: {}, attempts: {} };
  }
}
function saveState(s) {
  fs.writeFileSync(config.stateFile, JSON.stringify(s, null, 2));
}

/// 发一笔推进交易。
///
/// **revert 不一定是失败。** 这些方法本来就是开放给所有人的，被当事人、
/// 陪审员或另一个 keeper 抢先推掉是完全正常的结果 —— 那正是无需许可的意义。
/// 所以先用 staticCall 试一次：跑不通就当作「现在轮不到我」安静跳过，
/// 只有真的发出去又失败了才计入重试次数。
async function push(contract, key, task, state) {
  if (tasks.shouldSkip(state.attempts[key], config.maxAttempts)) return "skipped";

  try {
    await contract[task.method].staticCall(...task.args);
  } catch (e) {
    // 条件还没到、或者已经被别人做了。不计失败，不刷日志。
    return "not-due";
  }

  if (config.dryRun) {
    log(`[干跑] 本该推 ${task.method}(${task.args.join(",")}) —— ${task.why}`);
    return "dry";
  }

  try {
    const tx = await contract[task.method](...task.args, { gasLimit: config.maxGasPerTx });
    const rc = await tx.wait();
    log(`✓ ${task.method}(${task.args.join(",")}) —— ${task.why}　gas=${rc.gasUsed}`);
    delete state.attempts[key];
    return "sent";
  } catch (e) {
    const a = (state.attempts[key] ??= { attempts: 0 });
    a.attempts += 1;
    a.lastError = String(e.message ?? e).slice(0, 200);
    log(`✗ ${task.method}(${task.args.join(",")}) 第 ${a.attempts} 次失败: ${a.lastError}`);
    return "failed";
  }
}

async function collectJury(clients, ctx) {
  if (!clients.jury) return [];
  const out = [];
  const next = Number(await clients.jury.nextCaseID());
  const totalStake = await clients.jury.totalStake();
  for (let id = 1; id < next; id++) {
    const c = await chain.readJuryCase(clients.jury, id);
    const t = tasks.juryTask({ ...c, totalStake }, ctx);
    if (t) out.push({ contract: clients.jury, key: `jury:${id}:${t.method}`, task: t });
  }
  return out;
}

async function collectOptimistic(clients, ctx) {
  if (!clients.optimistic) return [];
  const out = [];
  const next = Number(await clients.optimistic.nextDisputeID());
  for (let id = 1; id < next; id++) {
    const d = await chain.readDispute(clients.optimistic, id);
    const t = tasks.optimisticTask(d, ctx);
    if (t) out.push({ contract: clients.optimistic, key: `opt:${id}:${t.method}`, task: t });
  }
  return out;
}

async function collectDeals(clients, state, ctx, toBlock) {
  const from = Math.max(state.fromBlock, toBlock - config.lookbackBlocks);
  const events = await clients.factory.queryFilter(clients.factory.filters.DealCreated(), from, toBlock);
  for (const ev of events) state.deals[ev.args.deal] = true;

  const out = [];
  for (const address of Object.keys(state.deals)) {
    const deal = await chain.readDeal(clients.provider, address, clients.reputation);

    const settle = tasks.escrowTask(deal, ctx);
    if (settle) {
      const e = new ethers.Contract(address, chain.ESCROW_ABI, clients.wallet);
      out.push({ contract: e, key: `deal:${address}:settle`, task: settle });
    }

    if (clients.reputation) {
      const rec = tasks.reputationTask(deal);
      if (rec) out.push({ contract: clients.reputation, key: `rep:${address}`, task: rec });
    }

    // 已终局且记录写过的，从跟踪列表里摘掉，别让状态文件无限增长
    const done = deal.state === tasks.State.Resolved || deal.state === tasks.State.Cancelled;
    if (done && deal.recorded) delete state.deals[address];
  }
  return out;
}

export async function tick(clients, state) {
  /*
   * 一次取回块高和时间戳，而不是先 getBlockNumber 再 getBlock(那个号)。
   *
   * 公共 RPC 后面是一组节点。先问「现在第几块」拿到的是 A 节点的答案，
   * 再去取那一块可能落到还没同步到的 B 节点上，返回 null ——
   * 然后 block.timestamp 直接抛，整轮推进全部作废。实测发生过。
   *
   * 问 "latest" 只有一次往返：号和时间戳必然来自同一个块，也就不存在
   * 「问到的块自己不认识」这回事。拿不到就跳过这一轮，下一轮再说。
   */
  const block = await clients.provider.getBlock("latest");
  if (!block) {
    log("RPC 暂时取不到最新区块，跳过本轮");
    return;
  }
  const blockNumber = block.number;
  const ctx = { now: block.timestamp, blockNumber };

  const all = [
    ...(await collectJury(clients, ctx)),
    ...(await collectOptimistic(clients, ctx)),
    ...(await collectDeals(clients, state, ctx, blockNumber)),
  ];

  const ordered = tasks.prioritize(all.map((x) => x.task))
    .map((t) => all.find((x) => x.task === t));

  let sent = 0;
  for (const item of ordered) {
    if (sent >= config.maxTxPerTick) {
      log(`本轮已达上限 ${config.maxTxPerTick} 笔，其余留到下一轮`);
      break;
    }
    const r = await push(item.contract, item.key, item.task, state);
    if (r === "sent" || r === "dry") sent += 1;
  }

  state.fromBlock = blockNumber;
  saveState(state);
  return sent;
}

async function main() {
  console.log(describeConfig());
  const clients = chain.makeClients();
  log("keeper 地址:", clients.wallet.address);

  const problems = await chain.verifyConstants(clients, tasks);
  if (problems.length > 0) {
    // 不一致会让 keeper 推早（白白 revert）或推晚（资金多压几天），两种都不报错。
    console.error("窗口常量与链上不一致，请先对齐再启动：\n  " + problems.join("\n  "));
    process.exit(1);
  }

  const state = loadState();
  const once = process.argv.includes("--once");

  const run = async () => {
    try {
      const n = await tick(clients, state);
      if (n > 0) log(`本轮推进 ${n} 笔`);
    } catch (e) {
      console.error("轮询失败:", e.message);
    }
  };

  await run();
  if (once) return;
  setInterval(run, config.pollIntervalMs);
  log(`已启动，每 ${config.pollIntervalMs / 1000} 秒扫描一次`);
}

/*
 * 只在被直接运行时才启动主循环。
 *
 * 不加这个判断，任何 import 这个模块的测试都会把 keeper 真跑起来 ——
 * 连着 RPC、开着定时器，测试进程永远不退出。想给 tick 补一条测试时
 * 正好撞上了。
 */
const runDirectly = process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (runDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
