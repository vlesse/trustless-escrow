# GLM 分叉说明（2026-09-22）

这是从 `D:\projects\trustless-escrow`（Claude 写的人人担保）分叉出来的版本。
正本没动，后续改动只写在这里。

GitHub 上的 `vlesse/trustless-escrow` 仍指向 Claude 那份；本分叉把那个 remote
改名叫 `upstream`，避免一不小心 push 回去。

## 分叉时 Claude 正本的状态

- 仓库名 `trustless-escrow`，对外「人人担保」。非托管点对点担保：钱锁在每笔
  交易独立的 `Escrow` 克隆里。
- 测试网 BSC 97，工厂 `0x395633EA01Da1903ED9a03e5BcF656De2Fa46D0a`，
  结算币是自己发的假 USDT，费率 1%。
- Happy path（开单 → 双方入金 → 标记交付 → 确认收货）是通的。
- Telegram 机器人不持有私钥；签名在用户钱包里完成。

## GLM 这次改了什么

合约：

- 陪审团 `createDispute` 加来源限制（只认工厂登记的托管，或一次性登记的乐观层）。
  以前任何人都能开假案锁真陪审员再罚没。
- 乐观层 `rule` / `execute`：托管已经走了 45 天拆分时，回调失败仍结算保证金。
- 仲裁成本为 0 时不能激活，否则争议入口被关、兜底永不开火。
- 交付期过后不能再 `markDelivered`，避免抢跑买家的未交付退款。

链下：

- 官网补上 `chain-config.js`，修好 `disputes` ABI 字段顺序。
- 提案人按 ethers v6 解结构体（不再多剥一层 `.d`），争议扫描不再从创世块拉日志。
- Keeper 日志按片扫，扫描失败不再把整轮仲裁推进一起停掉。
- 机器人可预填测试网结算币，开单时拦「保证金 < 仲裁成本」。
- README / 机器人 / 签名页：逾期未标记交付是无过错退款，不罚没。

验证：合约 172 项全绿；官网 8、机器人 185、keeper 43、提案人 34。

## 测试网重部署（2026-09-22）

BSC 97，结算币仍用原来的假 USDT（mint 无权限）。工厂换成新的：

| 合约 | 地址 |
|---|---|
| EscrowFactory | `0xA93471BAd98174F2c39A6821bbD8121BF23804bA` |
| OptimisticArbitrator | `0xe4F1f7b0A9b84D8EA3199cb38b1a481E8bd20643` |
| StakedJury | `0x91C4329297247cAe4fB21a7ffc98Ce0473aA1DE2` |
| FeeVault | `0x373d502DF1bB17fed126454cf81f900D5bEdC2e7` |
| Escrow 实现 | `0x216969bb8e2F4C63b80c9A5b2540E66C5EB1F962` |
| IdentityBond | `0xc3b151A08397117Aa18fB75CFeEc8Af92EaEb2a5` |
| Reputation | `0x7C435FD02C514D34d5fbBF2770B853b72DEd9D73` |
| 结算币 | `0x5F9AfA3adD925df4e8653C2e9Fc6D757272d72A9` |

链上核对 `verify-deployment.cjs` 全绿。陪审员 3 人已各质押 1000。VPS `escrow`（35.229.212.60）上 bot / keeper / 官网 / 签名页已切到新地址。

Claude 正本那套旧合约还在链上，只是线上服务不再指向它。

## 还没做

- 合约补丁要重新部署才会上测试网。正本那套地址还是 Claude 的旧字节码。
- 争议之后机器人只有「提交证据」，没有挑战 / 陪审投票 / 上诉按钮。
- 管理员换一个「先看区块哈希再给随机数」的源，仍可以偏向陪审员；
  `setFinalArbitrator` 没有 7 天时间锁。
- USDT 若把买家拉黑，整笔 `_payout` 会永久卡死（含卖家的钱）。

## 目录

- 正本（Claude）：`D:\projects\trustless-escrow`
- 本分叉（GLM）：`D:\projects\ZAI\12\trustless-escrow`
