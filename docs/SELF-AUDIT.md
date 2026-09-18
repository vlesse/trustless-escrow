# 自审记录 · 2026-09-16，2026-09-19 更新

**这不是第三方审计,不能替代第三方审计。** 这是一轮自己做的静态分析 + 人工分拣,
目的是在花钱找人之前把机器能发现的东西先清掉,并把分拣结论留成记录 ——
没有记录的自审等于没审:下一个人无从判断哪些是「看过了没问题」,哪些是「压根没看」。

## 怎么复现

```bash
pip install slither-analyzer               # 0.11.6
npx hardhat compile
slither . --hardhat-ignore-compile         # 读 slither.config.json
```

> **`--hardhat-ignore-compile` 不是可选的。** 不加它，Slither 会先跑
> `npx hardhat clean --global` —— 那不只是删掉本项目的 `artifacts/`，
> 它会把**全局的 solc 编译器缓存一起删掉**。在下载 solc 受限的网络环境里，
> 这一下就让整个项目编译不动了（本项目踩过一次，靠手工把 solc 二进制
> 塞回 `%LOCALAPPDATA%\hardhat-nodejs\Cache\compilers-v2\windows-amd64\`
> 才恢复，那个目录还需要配套的 `list.json`）。
>
> 附带的坏处更隐蔽：产物被删之后，机器人与提案人里那几项「手写 ABI 对照
> 编译产物」的测试会**静默跳过**而不是失败，跑出来仍然是全绿。
> 所以跑完 Slither 一定要确认 `skipped` 是 0。

范围:`contracts/` 下除 `mocks/` 外全部。2026-09-19 重扫时已增至 **1900 行左右**
(新增 `MerchantBond`、`KlerosAdapter`,以及上诉轮、案值透传、拖延押金带来的增量),
Slither 结果 27 条,新增的几条都落在既有口径里 ——
`setMerchantBond` / `setUpstream` / `transferAdmin` 的零地址检查是刻意留的
(0 = 关闭 / 放弃权限),`safeApprove` 的低阶调用是整个 SafeTransfer 库为兼容 USDT 的做法。

| 分层 | 合约 | 有效代码行 |
|---|---|---|
| A 持有交易双方本金 | Escrow · EscrowFactory · FeeVault · SafeTransfer · Clones | 441 |
| B 持有参与者保证金/质押 | OptimisticArbitrator · StakedJury | 739 |
| C 不持有或几乎不持有资金 | Reputation · IdentityBond · ChainlinkVRFSource | 276 |

## 结果

首轮 107 条,其中 12 条落在 `mocks/`(测试专用,不上链)。真实合约 95 条,逐条分拣如下。

### 真实问题(已修)

#### M-1 `StakedJury.appeal()` 违反 CEI,可被带回调的代币重入,一次烧光剩余上诉轮

原实现先 `safeTransferFrom` 收上诉费,再 push 新一轮、再改 `phase`。收钱那一刻:

- `phase` 还是 `Appealable` —— 阶段检查会通过
- `rounds.length` 还没变 —— `ri >= MAX_ROUNDS` 检查也会通过

于是带转账回调的代币可以在转账中途重新进入 `appeal()`,两次调用各 push 一轮。
`MAX_ROUNDS = 3`,**一次操作就把剩余上诉轮全部耗尽,对方从此再也上诉不了**。
更糟的是多出来的那一轮没有陪审员,结案时 `_settlePools` 会把它的报酬池
原额退还给发起人 —— 攻击者的净成本接近于零,只有 gas。

**可达性:** 需要管理员给一个带转账回调的币种配过仲裁费
(`costOf[token] == 0` 会让争议创建不出来,相当于一道隐式白名单)。
所以在只配了主流稳定币的部署里打不到。但 **「安全性依赖于管理员永远不配错币种」
是一条没有写下来的前提**,合约层必须自己挡住,而不是指望配置纪律。

**修复:** 改为先写完全部状态再收钱(checks-effects-interactions);
重入进来会撞上 `phase == Pending` 直接 revert。另加 `nonReentrant` 作为第二道保险。

**回归测试:** `test/reentrancy.test.js`。把修复撤回后该用例会红
(`reentrySucceeded` 变成 `true`),已实际验证过 —— 不会失败的回归测试没有价值。

> 写这条测试时踩了一个坑,值得记下来:第一版让恶意代币回调**代币自己**,
> 结果重入是因为「代币没有余额和授权」而失败的,不是因为防护生效 ——
> **测试在有漏洞的代码上照样是绿的**。真实攻击者是一个持币且已授权的合约,
> ERC777 的 `tokensToSend` 回调的正是付款方本人。改对之后测试才开始有意义。

#### M-2 `StakedJury` 与 `OptimisticArbitrator` 完全没有重入锁

`Escrow` 和 `IdentityBond` 一直都有,这两个仲裁合约没有。它们同样保管
任意 ERC20(提案人保证金、挑战保证金、陪审员质押、仲裁费),不一致本身就是隐患 ——
读代码的人会默认全仓都有。

**修复:** 补上与 `Escrow` 同一份实现的 `nonReentrant`,覆盖每一个会动钱的外部入口。

#### L-1 `transferAdmin` 不发事件

`EscrowFactory` 发,`StakedJury` 与 `OptimisticArbitrator` 不发。
这个项目的卖点就是链上可核对,管理员换人却在链上没有痕迹,说不过去。

**修复:** 两处都补 `AdminTransferred` 事件。

#### L-2 `Escrow.RULING_REFUSED` 是死代码

**修复:** 删除。0 的含义在 `IEscrowArbitrator` 里有定义。

### 误报 / 已知并已缓解(不改)

| 检测项 | 条数 | 判断 |
|---|---|---|
| `weak-prng` | 1 | **已知,且是整个 VRF 工作要解决的问题。** 种子是 `keccak256(区块哈希, VRF 输出, 案件ID)`,Slither 只看到取模。取模偏差在 `totalStake << 2^256` 时可忽略 |
| `reentrancy-no-eth` | 5 | Slither 不认识自定义的 `nonReentrant` 修饰符。`Escrow` 的两处本来就有锁且已按 CEI 先写 `buyerFunded/sellerFunded`;`StakedJury` 的三处现在也有锁 |
| `incorrect-equality` | 3 | 全部是拿字段与字面量 `0` 比较来表示「未设置」。这个检测器针对的是拿余额做 `==`,不适用 |
| `uninitialized-local` | 4 | Solidity 的值类型局部变量默认为 0,是惯用写法。该检测器真正针对的是未初始化的 storage 指针 |
| `timestamp` | 23 | 本协议的期限机制天生建立在 `block.timestamp` 上(交付期、验收期、挑战窗口、上诉窗口)。矿工可操纵的秒级偏移相对于以天计的窗口不构成风险 |
| `calls-loop` | 1 | `Reputation.recordMany` 的循环外部调用是刻意的,每笔各自 try/catch,数组长度由调用者自己承担 gas |
| `return-bomb` | 1 | `_requestRandomness` 写的是 `(bool ok,)`,返回数据不会被拷贝。**但 `_readRandomness` 会 decode `bytes memory`**,恶意来源返回超大数据会抬高 `drawJurors` 的 gas —— 已限 gas 200k,影响可控,记录在案 |
| `missing-zero-check` on `transferAdmin` | 3 | 转给 `address(0)` 是**刻意保留的终局去中心化路径**,README 有写 |
| 其余 informational | 余下 | 命名、字面量位数、mock 未继承接口等,不影响安全 |

`slither.config.json` 里排除的检测器就是上表中判定为不适用的那几项。
**排除是有代价的:未来真出现同类问题也会被一起藏掉**,重大改动后建议临时删掉
`detectors_to_exclude` 跑一次全量。

## 2026-09-19 补:不变量测试,以及它抓到的第一个东西

`test/invariants.test.js`。在此之前全部用例都是手写的确定性场景 ——
我想到什么就测什么,测不出「我没想到的那条路径」。改成随机走:
随机挑一个当下合法的动作,走一步,然后把八条必须永远成立的全部重验一遍。
种子固定,失败可复现(不可复现的随机测试报出来的错没人能查,等于没有)。

八条不变量:资金守恒、终态余额归零、未终态余额等于入金记录、手续费规则、
`totalStake` 等于 `stakeOf` 之和(专盯 Fenwick 树 —— 它错了不会报错,
只会静默地抽到错误的陪审员)、锁定不超过本金、陪审团余额覆盖全部质押、
额度池余额等于账面额度。

**它第一轮就红了,而抓到的是文档不是代码。**

README 的对抗表里写着「在争议交易上收费 | 争议、取消、超时路径的手续费恒为 0
(有测试覆盖)」。而卖家胜诉那一支是**照收全额手续费**的 —— 那笔交易确实完成了,
是买家恶意申诉,收费是对的。

各条路径本来都有断言(卖家胜那条就写着 `vault == FEE`),所以并不是没测,
而是**没有任何一处把规则本身写下来**,于是文档跑偏了也没人发现。
这类缺陷比漏测更隐蔽:测试全绿,而对外的承诺是假的 —— 偏偏假在
那张「运营者不能做什么」的表里,那是整份 README 里最不该出错的地方。

已修:规则本身有了唯一落点(`test/escrow.test.js` 逐个终局比对),
README 那一行照实改写。

## Slither 找不到的东西(这才是这个项目真正的风险)

静态分析认的是模式:重入、溢出、权限、未检查返回值。它**完全看不懂博弈**。
这个协议最可能出事的地方恰恰在那里:

- 陪审团的 Schelling point 在证据模糊或有人肯出大钱买票时会不会塌
- 上诉轮能不能被拿来当纯拖延工具(已知会,见 README「你仍然需要信任的部分」)
- 双押金的参数区间:什么情况下「骗一笔」的收益仍然大于损失
- 冷启动阶段陪审员池为空时,整个仲裁层是否可用

**找付费审计时必须专门要求评估这一层**,否则买到的是一份「没有重入漏洞」的报告,
而真正的失效会发生在别处。

## 给下一位审计者的材料

- **威胁模型与信任边界:** README「信任模型」一节,逐条列了运营者能做什么、不能做什么
- **设计取舍与被否掉的方案:** 各合约顶部的注释,尤其 `StakedJury.sol`
  (陪审团、随机数、上诉轮三块的完整推理,包括为什么没选另一种做法)
- **时间预算约束:** `Escrow.sol` 的 `DISPUTE_TIMEOUT` 注释里有一条算式,
  改任何一个窗口常量前必须重算
- **测试:** `npx hardhat test`,122 项,覆盖 6 条结算路径的精确金额与资金守恒、
  每一层的兜底路径、以及本次自审发现的重入问题

### 还没做、建议补的

- ~~**不变量测试**~~ —— 2026-09-19 已做,见上。没有引入 Foundry:
  这些不变量在 JS 侧全都观测得到,带种子的随机动作序列足够,
  也不必为此给项目加一条新的工具链。
- **部署后在区块浏览器验证源码。** 不验证就没有人能核对线上跑的是什么,
  「全程透明」也就无从谈起。
- **单笔金额上限 + 分阶段放开。** 在没有第三方审计预算的前提下,
  这是最有效的下行控制:把最坏损失硬性封顶,让代码在真实流量里慢慢过火。
