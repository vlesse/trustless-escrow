#!/bin/bash
# 定时试一次揭示。阶段不对就退出，不算错误 —— 大部分时候都是阶段不对。
#
# 揭示窗口只有 2 天，错过这一席就被当作弃权并罚没质押。人不可能守在那里，
# 所以这一步必须自动化。脚本本身幂等：已揭示的席位会跳过。
cd /srv/escrow || exit 0
set -a; . ./.env; set +a
PHASE=reveal npx hardhat run scripts/sim-jury-vote.cjs --network bscTestnet
exit 0
