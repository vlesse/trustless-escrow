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

export async function readJuryCase(jury, id) {
  const c = (await jury.cases(id)).c;
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

export async function readDispute(optimistic, id) {
  const d = (await optimistic.disputes(id)).d;
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
export async function verifyConstants({ jury, optimistic }, expected) {
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
  return problems;
}
