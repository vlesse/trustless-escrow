import { ethers } from "ethers";
import { config } from "./config.js";
import { buildEvidenceItem } from "./evidence.js";

/// 这份 ABI 是手写的。事件签名一旦与链上不一致，topic 就对不上，
/// **提案人会静默地再也收不到任何争议** —— 不报错，只是不干活了。
/// test/abi.test.js 拿编译产物逐条对照，别把它删了。
const ARBITRATOR_ABI = [
  "event DisputeCreated(uint256 indexed id, address indexed arbitrable, address token, uint256 bond, uint256 value)",
  "event RulingProposed(uint256 indexed id, uint8 ruling, address indexed proposer)",
  "function disputes(uint256) view returns (address arbitrable, address token, uint8 status, uint8 proposedRuling, uint64 proposedAt, uint64 createdAt, address challenger, uint256 bond, uint256 finalCost, uint256 value)",
  "function propose(uint256 id, uint8 ruling)",
  "function bondOf(address token) view returns (uint256)",
  "function proposer() view returns (address)",
  "function PROPOSAL_WINDOW() view returns (uint64)",
];

const ESCROW_ABI = [
  "event DeliveryMarked(address indexed seller, string evidenceURI, uint64 inspectionDeadline)",
  "event DisputeRaised(address indexed by, uint256 indexed disputeID, string evidenceURI)",
  "event Evidence(address indexed by, string evidenceURI)",
  "function token() view returns (address)",
  "function buyer() view returns (address)",
  "function seller() view returns (address)",
  "function price() view returns (uint256)",
  "function buyerBond() view returns (uint256)",
  "function sellerBond() view returns (uint256)",
  "function termsHash() view returns (bytes32)",
  "function state() view returns (uint8)",
  "function deliveryDeadline() view returns (uint64)",
  "function inspectionDeadline() view returns (uint64)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

/// 乐观层的 Status 枚举
export const Status = { None: 0, Open: 1, Proposed: 2, Escalated: 3, Executed: 4 };

export function makeClients() {
  const provider = new ethers.JsonRpcProvider(config.rpcUrl);
  const wallet = new ethers.Wallet(config.privateKey, provider);
  const arbitrator = new ethers.Contract(config.optimisticArbitrator, ARBITRATOR_ABI, wallet);
  return { provider, wallet, arbitrator };
}

/// 汇总一个争议所需的全部链上事实与证据。
export async function loadCase(id, { provider, arbitrator }) {
  const d = await arbitrator.disputes(id);
  if (d.status !== BigInt(Status.Open) && Number(d.status) !== Status.Open) {
    return { id, status: Number(d.status), skip: `状态为 ${Number(d.status)}，非待提案` };
  }

  const escrow = new ethers.Contract(d.arbitrable, ESCROW_ABI, provider);
  const [token, buyer, seller, price, buyerBond, sellerBond, termsHash, state, deliveryDeadline, inspectionDeadline] =
    await Promise.all([
      escrow.token(), escrow.buyer(), escrow.seller(), escrow.price(),
      escrow.buyerBond(), escrow.sellerBond(), escrow.termsHash(), escrow.state(),
      escrow.deliveryDeadline(), escrow.inspectionDeadline(),
    ]);

  const roleOf = (a) => {
    const x = a.toLowerCase();
    if (x === buyer.toLowerCase()) return "buyer";
    if (x === seller.toLowerCase()) return "seller";
    return "unknown";
  };

  // 拉取该托管合约的全部证据类事件
  const logs = await provider.getLogs({
    address: d.arbitrable,
    fromBlock: 0,
    toBlock: "latest",
  });
  const iface = new ethers.Interface(ESCROW_ABI);

  const raw = [];
  let disputeRaisedBy = "unknown";
  let markedDelivered = false;

  for (const log of logs) {
    let parsed;
    try {
      parsed = iface.parseLog(log);
    } catch {
      continue;
    }
    if (!parsed) continue;

    const block = await provider.getBlock(log.blockNumber);
    const ts = block?.timestamp;

    if (parsed.name === "DeliveryMarked") {
      markedDelivered = true;
      raw.push({ uri: parsed.args.evidenceURI, submitter: "seller", kind: "delivery_proof", submittedAt: ts });
    } else if (parsed.name === "DisputeRaised") {
      disputeRaisedBy = roleOf(parsed.args.by);
      raw.push({ uri: parsed.args.evidenceURI, submitter: disputeRaisedBy, kind: "dispute_statement", submittedAt: ts });
    } else if (parsed.name === "Evidence") {
      raw.push({ uri: parsed.args.evidenceURI, submitter: roleOf(parsed.args.by), kind: "evidence", submittedAt: ts });
    }
  }

  const selected = raw.filter((r) => r.uri && r.uri.length > 0).slice(0, config.maxEvidenceItems);
  const ctx = { provider, termsHash };
  const evidence = [];
  for (const r of selected) {
    evidence.push(await buildEvidenceItem(r, ctx));
  }

  return {
    id,
    escrow: d.arbitrable,
    token,
    bond: d.bond,
    createdAt: Number(d.createdAt),
    buyer, seller,
    price: price.toString(),
    buyerBond: buyerBond.toString(),
    sellerBond: sellerBond.toString(),
    termsHash,
    state: Number(state),
    markedDelivered,
    deliveryDeadline: Number(deliveryDeadline),
    inspectionDeadline: Number(inspectionDeadline),
    disputeRaisedBy,
    evidence,
  };
}

/// 确保对仲裁层的授权足够质押一次保证金。
async function ensureAllowance(tokenAddr, amount, { wallet }) {
  const token = new ethers.Contract(tokenAddr, ERC20_ABI, wallet);
  const current = await token.allowance(wallet.address, config.optimisticArbitrator);
  if (current >= amount) return;

  // 只授权本次所需额度的若干倍，不做无限授权 ——
  // 提案人私钥是热钱包，必然长期在线，无限授权会把整个余额暴露给
  // 一个被攻破的仲裁层合约。
  const target = amount * 10n;
  const tx = await token.approve(config.optimisticArbitrator, target);
  await tx.wait();
}

/// 提交默认裁决并质押保证金。
export async function submitProposal(id, ruling, tokenAddr, { wallet, arbitrator }) {
  const bond = await arbitrator.bondOf(tokenAddr);
  const token = new ethers.Contract(tokenAddr, ERC20_ABI, wallet);
  const balance = await token.balanceOf(wallet.address);

  if (balance < bond) {
    throw new Error(
      `提案人余额不足：需要 ${bond} 才能质押，当前只有 ${balance}。` +
      `保证金是这个服务对自己判断负责的方式，不能跳过。`
    );
  }

  await ensureAllowance(tokenAddr, bond, { wallet });

  // 先静态调用一次，把会 revert 的情况在花 gas 之前挡掉
  await arbitrator.propose.staticCall(id, ruling);

  const tx = await arbitrator.propose(id, ruling);
  const receipt = await tx.wait();
  return { hash: tx.hash, blockNumber: receipt.blockNumber, bond: bond.toString() };
}

/// 校验配置的钱包确实是合约认可的提案人，否则每次提交都会 revert。
export async function assertIsProposer({ wallet, arbitrator }) {
  const onchain = await arbitrator.proposer();
  if (onchain.toLowerCase() !== wallet.address.toLowerCase()) {
    throw new Error(
      `配置的钱包 ${wallet.address} 不是合约认可的提案人（链上是 ${onchain}）。` +
      `提交会被 NotProposer 拒绝。`
    );
  }
}
