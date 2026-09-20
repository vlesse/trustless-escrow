/// 链上读写。只读取状态、只调用无需许可的方法，不碰任何人的资金。
import { ethers } from "ethers";
import { config } from "./config.js";

export const FACTORY_ABI = [
  "event DealCreated(address indexed deal, address indexed buyer, address indexed seller, address token, uint256 price, uint256 buyerBond, uint256 sellerBond, address arbitrator, uint16 feeBps, bytes32 termsHash)",
  "function isDeal(address) view returns (bool)",
];

export const ESCROW_ABI = [
  "function state() view returns (uint8)",
  "function outcome() view returns (uint8)",
  "function inspectionDeadline() view returns (uint64)",
  "function settleAfterInspection()",
];

export const OPTIMISTIC_ABI = [
  "event DisputeCreated(uint256 indexed id, address indexed arbitrable, address token, uint256 bond, uint256 value)",
  "function disputes(uint256) view returns (tuple(address arbitrable, address token, uint8 status, uint8 proposedRuling, uint64 proposedAt, uint64 createdAt, address challenger, uint256 bond, uint256 finalCost, uint256 value, address dealBuyer, address dealSeller) d)",
  "function nextDisputeID() view returns (uint256)",
  "function execute(uint256 id)",
  "function escalateUnproposed(uint256 id)",
  "function PROPOSAL_WINDOW() view returns (uint64)",
  "function CHALLENGE_WINDOW() view returns (uint64)",
];

export const JURY_ABI = [
  "event CaseCreated(uint256 indexed id, address indexed arbitrable, uint64 drawBlock, uint256 value)",
  "function cases(uint256 id) view returns (tuple(address arbitrable, address feeToken, uint8 phase, uint8 ruling, uint64 drawBlock, uint64 commitDeadline, uint64 revealDeadline, uint64 appealDeadline, uint64 roundStartedAt, uint64 createdAt, uint64 rngRequestedAt, address rngSource, address dealBuyer, address dealSeller, uint256 value, uint256 baseCost) c)",
  "function nextCaseID() view returns (uint256)",
  "function totalStake() view returns (uint256)",
  "function drawJurors(uint256 id)",
  "function startReveal(uint256 id)",
  "function tallyRound(uint256 id)",
  "function finalize(uint256 id)",
  "function timeoutCase(uint256 id)",
  "function ROUND_TIMEOUT() view returns (uint64)",
];

export const REPUTATION_ABI = [
  "function recorded(address deal) view returns (bool)",
  "function record(address deal)",
];

export function makeClients() {
  const provider = new ethers.JsonRpcProvider(config.rpcUrl, undefined, { cacheTimeout: -1 });
  const wallet = new ethers.Wallet(config.privateKey, provider);
  const at = (addr, abi) => (addr ? new ethers.Contract(addr, abi, wallet) : null);
  return {
    provider,
    wallet,
    factory: at(config.escrowFactory, FACTORY_ABI),
    optimistic: at(config.optimisticArbitrator, OPTIMISTIC_ABI),
    jury: at(config.stakedJury, JURY_ABI),
    reputation: at(config.reputation, REPUTATION_ABI),
  };
}

/**
 * 读一个案件。
 *
 * ethers v6 对**单返回值**的函数直接返回那个值，不会再包一层。
 * ABI 里给返回值起了名字（`... c`）也不改变这一点 —— 写成 `(...).c`
 * 拿到的永远是 undefined，而 undefined.phase 要等到真的连上链才炸。
 */
export async function readJuryCase(jury, id) {
  const c = await jury.cases(id);
  return {
    id,
    phase: Number(c.phase),
    drawBlock: Number(c.drawBlock),
    commitDeadline: Number(c.commitDeadline),
    revealDeadline: Number(c.revealDeadline),
    appealDeadline: Number(c.appealDeadline),
    roundStartedAt: Number(c.roundStartedAt),
  };
}

/// 同上：单返回值不包一层。
export async function readDispute(optimistic, id) {
  const d = await optimistic.disputes(id);
  return {
    id,
    status: Number(d.status),
    createdAt: Number(d.createdAt),
    proposedAt: Number(d.proposedAt),
  };
}

export async function readDeal(provider, address, reputation) {
  const e = new ethers.Contract(address, ESCROW_ABI, provider);
  const [state, outcome, inspectionDeadline] = await Promise.all([
    e.state(), e.outcome(), e.inspectionDeadline(),
  ]);
  const recorded = reputation ? await reputation.recorded(address) : true;
  return {
    address,
    state: Number(state),
    outcome: Number(outcome),
    inspectionDeadline: Number(inspectionDeadline),
    recorded,
  };
}

/// 合约里的窗口常量与 tasks.js 里写死的那几个必须一致。
/// 不一致的后果是 keeper 推早了（白白 revert）或推晚了（资金多压几天），
/// 两种都不报错，所以启动时主动核对一次。
export async function verifyConstants({ jury, optimistic, provider }, expected) {
  const problems = [];
  if (jury) {
    const v = Number(await jury.ROUND_TIMEOUT());
    if (v !== expected.ROUND_TIMEOUT) problems.push(`ROUND_TIMEOUT 链上=${v} 本地=${expected.ROUND_TIMEOUT}`);
  }
  if (optimistic) {
    const p = Number(await optimistic.PROPOSAL_WINDOW());
    const c = Number(await optimistic.CHALLENGE_WINDOW());
    if (p !== expected.PROPOSAL_WINDOW) problems.push(`PROPOSAL_WINDOW 链上=${p} 本地=${expected.PROPOSAL_WINDOW}`);
    if (c !== expected.CHALLENGE_WINDOW) problems.push(`CHALLENGE_WINDOW 链上=${c} 本地=${expected.CHALLENGE_WINDOW}`);
  }

  // 抽选窗口够不够我们轮询一次。
  //
  // drawJurors 要读 blockhash(drawBlock)，而 blockhash 只能回溯 256 个区块。
  // 这个窗口有多长完全取决于链的出块速度：以太坊 12 秒出块时有 51 分钟，
  // BSC 0.45 秒出块时只剩 115 秒，Arbitrum 0.25 秒时只剩 66 秒。
  //
  // 轮询间隔一旦接近窗口长度，抽选就会反复过期、反复重排，一路耗到
  // ROUND_TIMEOUT 以拒裁收场 —— **而且全程不报任何错**：链上有兜底重排，
  // keeper 那边每次都是「条件没到」。所以只能在启动时算一次。
  if (jury && provider && config.pollIntervalMs) {
    const window = await blockhashWindowSeconds(provider);
    if (window !== null) {
      const poll = config.pollIntervalMs / 1000;
      // 留三倍余量：轮询可能正好卡在窗口刚开的前一刻，再加上 RPC 抖动和重试。
      if (poll * 3 > window) {
        problems.push(
          `轮询间隔 ${poll}s 相对抽选窗口 ${window.toFixed(0)}s 太长` +
          `（本链约 ${(window / 256).toFixed(3)}s 出块，256 块就过期）。` +
          `把 POLL_INTERVAL_MS 降到 ${Math.floor((window / 3) * 1000 / 1000) * 1000} 以下。`
        );
      }
    }
  }
  return problems;
}

/// 按最近的出块速度估算 blockhash 的有效窗口（秒）。取不到时返回 null，
/// 让调用方跳过这项检查而不是编一个数出来。
async function blockhashWindowSeconds(provider) {
  try {
    const head = await provider.getBlockNumber();
    const span = Math.min(1000, head);
    if (span < 10) return null; // 新链还没出够块，估不准
    const [a, b] = await Promise.all([provider.getBlock(head - span), provider.getBlock(head)]);
    const dt = (Number(b.timestamp) - Number(a.timestamp)) / span;
    if (!(dt > 0)) return null;
    return 256 * dt;
  } catch {
    return null;
  }
}
