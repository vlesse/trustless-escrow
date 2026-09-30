/// 卖家自己运行的自动发货程序。
///
///   每一轮：① 发货  ② 同步库存  ③ 补押金。顺序不能换 —— 见 logic.js 的 stockPlan。
///
/// 这个程序跑在**卖家自己的机器上**，用**卖家自己的钱包**。平台不经手、也看不到卡密：
/// 卡密文件在卖家机器上，加密用的是买家的公钥，链上只有密文。
///
/// 钱包安全：这把私钥就是收货款的钱包，热放在机器上。它碰不到任何买家的钱
/// （买家的钱锁在每一单自己的合约里），但卖家的收入会进这个钱包 ——
/// 建议定期转到冷钱包，这里只留补押金用的零钱。
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { ethers } from "ethers";
import { parseCodes, assignedCodes, pickCode, remaining, stockPlan, topUpAmount, shouldDeliver } from "./logic.js";

const require = createRequire(import.meta.url);
// 加解密只写一份，签名页（买家取货）和这里（卖家加密）共用
const { seal } = require("../../signing-page/pickup.js");

const STORE_ABI = [
  "function factory() view returns (address)",
  "function token() view returns (address)",
  "function balanceOf(address) view returns (uint256)",
  "function listingsOf(address, uint256) view returns (uint256)",
  "function listingsOfLength(address) view returns (uint256)",
  "function listings(uint256) view returns (tuple(address seller, bool active, uint32 stock, uint32 sold, uint64 deliveryWindow, uint64 inspectionWindow, uint256 price, uint256 buyerBond, uint256 sellerBond, bytes32 termsHash, string terms))",
  "function listingOf(address) view returns (uint256)",
  "function pickupKeyOf(address) view returns (bytes)",
  "function updateListing(uint256 id, bool active, uint32 stock)",
  "function deposit(uint256 amount)",
];
const FACTORY_ABI = [
  "function dealsOf(address, uint256) view returns (address)",
  "function dealsOfLength(address) view returns (uint256)",
];
const DEAL_ABI = [
  "function seller() view returns (address)",
  "function state() view returns (uint8)",
  "function deliveryDeadline() view returns (uint64)",
  "function deliverSealed(bytes goods)",
];
const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

export function loadConfig(env = process.env) {
  const need = (k) => { if (!env[k]) throw new Error(`缺少环境变量 ${k}`); return env[k]; };
  return {
    rpcUrl: need("RPC_URL"),
    privateKey: need("SELLER_PRIVATE_KEY"),
    store: need("MERCHANT_BOND"),
    codesDir: env.CODES_DIR || "./codes",
    stateFile: env.STATE_FILE || "./.merchant-state.json",
    pollMs: Number(env.POLL_MS || 20_000),
    // 押金账户保持够接几单。0 = 不自动补
    topUpOrders: Number(env.TOPUP_ORDERS ?? 3),
  };
}

const log = (...a) => console.log(new Date().toISOString(), ...a);

function loadState(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return { assigned: {} }; }
}
/// 先写临时文件再改名：写到一半被杀，也不会留下一个损坏的状态文件 ——
/// 状态文件坏了，就不知道哪些卡密已经分出去了。
function saveState(file, state) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readCodes(dir, listingId) {
  const f = path.join(dir, `${listingId}.txt`);
  if (!fs.existsSync(f)) return null;
  const { codes, duplicates } = parseCodes(fs.readFileSync(f, "utf8"));
  if (duplicates.length) log(`⚠️ 商品 ${listingId} 的卡密文件里有重复，重复的只会发一次：${duplicates.length} 张`);
  return codes;
}

export async function tick(cfg, { provider, wallet, store, factory, token, state }) {
  const me = wallet.address;
  const now = (await provider.getBlock("latest")).timestamp;

  // 我的商品和各自的卡密
  const n = Number(await store.listingsOfLength(me));
  const listings = new Map();
  for (let i = 0; i < n; i++) {
    const id = await store.listingsOf(me, i);
    listings.set(id.toString(), { id, l: await store.listings(id), codes: readCodes(cfg.codesDir, id) });
  }

  // ① 发货
  const dn = Number(await factory.dealsOfLength(me));
  for (let i = 0; i < dn; i++) {
    const addr = (await factory.dealsOf(me, i)).toLowerCase();
    if (state.assigned[addr]?.delivered || state.done?.[addr]) continue;
    const deal = new ethers.Contract(addr, DEAL_ABI, wallet);
    if ((await deal.seller()).toLowerCase() !== me.toLowerCase()) continue;   // 这一单我是买家

    const st = Number(await deal.state());
    if (st >= 3) {
      // 已经交付或结束：可能是上一轮发出去了但没来得及记下来，补记
      if (state.assigned[addr]) state.assigned[addr].delivered = true;
      else (state.done ??= {})[addr] = true;
      saveState(cfg.stateFile, state);
      continue;
    }
    const listingId = await store.listingOf(addr);
    const item = listings.get(listingId.toString());
    const decision = shouldDeliver({
      state: st, deliveryDeadline: await deal.deliveryDeadline(), now,
      listingId, pickupKey: await store.pickupKeyOf(addr), hasCodes: Boolean(item?.codes),
    });
    if (!decision.go) {
      if (decision.why === "no-pickup-key" || decision.why === "deadline-passed" || decision.why === "no-codes-file") {
        if (!state.warned?.[addr + decision.why]) {
          log(`⚠️ ${addr} 不能自动发货：${{
            "no-pickup-key": "买家没留取货钥匙，需要你手动发货",
            "deadline-passed": "已经过了交付期，合约不再接受发货（买家可以取回全款）",
            "no-codes-file": `没有卡密文件 ${path.join(cfg.codesDir, listingId + ".txt")}`,
          }[decision.why]}`);
          (state.warned ??= {})[addr + decision.why] = true;
          saveState(cfg.stateFile, state);
        }
      }
      continue;
    }

    const code = pickCode(state, addr, item.codes);
    if (!code) { log(`⚠️ 商品 ${listingId} 卡密发完了，订单 ${addr} 暂时发不了货。补卡密后会自动发。`); continue; }

    // 先记账，再发交易
    state.assigned[addr] = { listing: listingId.toString(), code, delivered: false };
    saveState(cfg.stateFile, state);

    const goods = await seal(await store.pickupKeyOf(addr), code);
    const tx = await deal.deliverSealed(goods);
    const rc = await tx.wait();
    if (rc.status !== 1) { log(`✗ ${addr} 发货交易失败，下一轮用同一张卡密重试`); continue; }
    state.assigned[addr].delivered = true;
    state.assigned[addr].tx = tx.hash;
    saveState(cfg.stateFile, state);
    log(`✓ 已发货 ${addr}（商品 ${listingId}）tx=${tx.hash}`);
  }

  // ② 同步库存（必须在发货之后）
  for (const { id, l, codes } of listings.values()) {
    if (!codes) continue;
    const left = remaining(state, id, codes);
    const want = stockPlan(l.stock, left);
    if (want === null) continue;
    const rc = await (await store.connect(wallet).updateListing(id, l.active, want)).wait();
    if (rc.status === 1) log(`库存 商品 ${id}：${l.stock} → ${want}`);
    if (left < 5) log(`⚠️ 商品 ${id} 只剩 ${left} 张卡密了`);
  }

  // ③ 补押金
  const active = [...listings.values()].filter((x) => x.l.active);
  const bond = active.reduce((m, x) => (x.l.sellerBond > m ? x.l.sellerBond : m), 0n);
  const amount = topUpAmount({
    poolBalance: await store.balanceOf(me), walletBalance: await token.balanceOf(me),
    bondPerOrder: bond, targetOrders: cfg.topUpOrders,
  });
  if (amount > 0n) {
    const storeAddr = await store.getAddress();
    if ((await token.allowance(me, storeAddr)) < amount) await (await token.approve(storeAddr, amount)).wait();
    await (await store.connect(wallet).deposit(amount)).wait();
    log(`押金账户补了 ${ethers.formatUnits(amount, await token.decimals())}`);
  }
}

export async function connect(cfg) {
  /*
   * 一轮里可能连发好几笔交易（发货、改库存、授权、补押金）。
   *
   * 本地端到端测试实测：发完货紧接着补押金，第二笔报「nonce 已被使用」——
   * ethers 默认把查询结果缓存一小会儿，第二笔读到了旧的 nonce。公共节点
   * 后面是一组机器，写完再读还可能读到没同步的那台，只会更糟。
   * 所以：关掉缓存，并用 NonceManager 在本地自己数 nonce（出错时重置，
   * 免得一个数错了一直错下去）。
   */
  const provider = new ethers.JsonRpcProvider(cfg.rpcUrl, undefined, { cacheTimeout: -1 });
  const wallet = new ethers.NonceManager(new ethers.Wallet(cfg.privateKey, provider));
  wallet.address = await wallet.getAddress();
  const store = new ethers.Contract(cfg.store, STORE_ABI, wallet);
  const factory = new ethers.Contract(await store.factory(), FACTORY_ABI, provider);
  const token = new ethers.Contract(await store.token(), ERC20_ABI, wallet);
  return { provider, wallet, store, factory, token };
}

async function main() {
  const cfg = loadConfig();
  const c = await connect(cfg);
  const state = loadState(cfg.stateFile);
  state.assigned ??= {};
  log(`自动发货程序启动。卖家 ${c.wallet.address}，卡密目录 ${path.resolve(cfg.codesDir)}，每 ${cfg.pollMs / 1000} 秒一轮`);
  log(`已分出去的卡密 ${assignedCodes(state).size} 张`);
  for (;;) {
    try {
      await tick(cfg, { ...c, state });
    } catch (e) {
      log("本轮出错，下一轮继续：", e.shortMessage || e.message);
      c.wallet.reset();   // 下一轮从链上重新读 nonce
    }
    await new Promise((r) => setTimeout(r, cfg.pollMs));
  }
}

// 只有直接运行时才启动循环；被测试 import 时不启动（keeper 那边踩过这个坑）
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
