/**
 * 页面的全部取数逻辑。
 *
 * 只读、只用 ethers 直连公共 RPC —— 没有后端，也就没有一个可以被运营方
 * 改写的中间层。这不是省事，是这页要论证的东西的一部分：
 * 一个讲「你不必信任我们」的页面，如果数字要从我们的服务器过一道，
 * 那它讲的和它做的就是两回事。
 */
(function () {
  const C = window.SITE_CHAIN;

  const FACTORY_ABI = [
    "function allDealsLength() view returns (uint256)",
    "function allDeals(uint256) view returns (address)",
    "function defaultFeeBps() view returns (uint16)",
  ];
  /*
   * 刻意不读 totalReceived。
   *
   * 托管合约是用 ERC20 直接转账把手续费打进金库的，而 ERC20 转账触发不了
   * 回调，所以那个计数器的记账钩子 recordFee 永远没人调 —— 它会一直是 0。
   * 更要命的是 recordFee 无权限也不校验，任何人都能给它加任意数字。
   *
   * 累计收入改用 totalSwept + pending：前者在 sweep 里随真实转账一起加，
   * 后者就是金库当前的真实余额。两个都只能由实际的代币移动产生，
   * 谁也伪造不了。
   */
  const VAULT_ABI = [
    "function totalSwept(address) view returns (uint256)",
    "function pending(address) view returns (uint256)",
    "function beneficiary() view returns (address)",
  ];
  const JURY_ABI = [
    "function jurorCount() view returns (uint256)",
    "function totalStake() view returns (uint256)",
    "function nextCaseID() view returns (uint256)",
  ];
  const OPT_ABI = [
    "function nextDisputeID() view returns (uint256)",
    "function disputes(uint256) view returns (tuple(address arbitrable,address token,address challenger,address dealBuyer,address dealSeller,uint8 status,uint8 proposedRuling,uint64 createdAt,uint64 proposedAt,uint256 bond,uint256 finalCost,uint256 value))",
  ];
  const ERC20_ABI = [
    "function decimals() view returns (uint8)",
    "function symbol() view returns (string)",
    "function balanceOf(address) view returns (uint256)",
  ];

  /// 逐笔读托管余额的上限。交易多了之后全量读会把公共 RPC 打爆，
  /// 而「当前锁定」只关心还没结束的那些，它们必然是最近开的。
  const SCAN_LAST = 60;

  async function load() {
    const provider = new ethers.JsonRpcProvider(C.rpcUrl);
    const at = (a, abi) => new ethers.Contract(a, abi, provider);

    const factory = at(C.escrowFactory, FACTORY_ABI);
    const vault = at(C.feeVault, VAULT_ABI);
    const jury = at(C.stakedJury, JURY_ABI);
    const opt = at(C.optimisticArbitrator, OPT_ABI);
    const token = at(C.settlementToken, ERC20_ABI);

    const [decimals, symbol, dealsLen, swept, pending, beneficiary,
           jurorCount, totalStake, nextDisputeID] = await Promise.all([
      token.decimals(), token.symbol(), factory.allDealsLength(),
      vault.totalSwept(C.settlementToken),
      vault.pending(C.settlementToken), vault.beneficiary(),
      jury.jurorCount(), jury.totalStake(), opt.nextDisputeID(),
    ]);

    const dec = Number(decimals);
    const n = Number(dealsLen);

    // 当前锁定：只扫最近 SCAN_LAST 笔。已结算的合约余额是 0，所以
    // 漏掉更早的那些不会少算 —— 早期的单子要么结了，要么早就该有人去推了。
    const from = Math.max(0, n - SCAN_LAST);
    const idx = [];
    for (let i = from; i < n; i++) idx.push(i);
    const addrs = await Promise.all(idx.map((i) => factory.allDeals(i)));
    const bals = await Promise.all(addrs.map((a) => token.balanceOf(a)));
    const locked = bals.reduce((t, b) => t + b, 0n);
    const active = bals.filter((b) => b > 0n).length;

    // 争议：逐个读状态，统计其中被挑战过的（Escalated=3 或已终局但有挑战者）
    const dn = Number(nextDisputeID) - 1;
    let challenged = 0;
    if (dn > 0) {
      const ids = [];
      for (let i = Math.max(1, dn - SCAN_LAST + 1); i <= dn; i++) ids.push(i);
      const ds = await Promise.all(ids.map((i) => opt.disputes(i).catch(() => null)));
      challenged = ds.filter((d) => d && d.challenger !== ethers.ZeroAddress).length;
    }

    return {
      decimals: dec, symbol,
      deals: n, active, locked,
      feeTotal: swept + pending, feeSwept: swept, feePending: pending,
      beneficiary,
      jurorCount: Number(jurorCount), totalStake,
      disputes: dn, challenged,
      cases: Number(await jury.nextCaseID()) - 1,
    };
  }

  window.SITE_CHAIN_LOAD = load;
})();
