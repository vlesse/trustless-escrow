#!/usr/bin/env bash
#
# 测试环境初始化。反复跑安全：每一步都先检查再做。
#
#   用法：ssh <host> 'bash -s' < infra/provision.sh
#
# 这台机器上跑：机器人、keeper、提案人、签名页。
# 不跑链节点 —— 用公共测试网 RPC，只出不进。
set -euo pipefail

say() { echo; echo "==> $*"; }

say "时区设为 Asia/Shanghai（日志时间和你对得上）"
timedatectl set-timezone Asia/Shanghai || true

say "交换分区"
# e2-medium 只有 4G 内存，solc 编译那十几个合约瞬时能吃到 1.5G。
# 平时用不上 swap，但编译撞顶的时候它是 OOM 和编译成功的差别。
if swapon --show | grep -q .; then
  echo "已有 swap，跳过"
else
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -qF '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  # 有 swap 不等于该用 swap：降低 swappiness，让它只在真撞顶时介入。
  sysctl -w vm.swappiness=10
  grep -qF 'vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf
fi
free -m | head -3

say "基础软件包"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates gnupg build-essential ufw jq >/dev/null
echo "git $(git --version | cut -d' ' -f3)"

say "Node.js 22 LTS"
if command -v node >/dev/null && node -v | grep -q '^v22'; then
  echo "已装 $(node -v)，跳过"
else
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key |
    gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg --yes
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main" \
    > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs >/dev/null
fi
echo "node $(node -v) / npm $(npm -v)"

say "跑服务的非特权用户 escrow"
# 服务不用 root 跑。这些进程要处理来自陌生人的输入（Telegram 消息、
# IPFS 上的证据文件），万一被打穿，炸掉的应该是一个没有权限的用户。
id -u escrow >/dev/null 2>&1 || useradd -m -s /bin/bash escrow
install -d -o escrow -g escrow /srv/escrow
echo "home=$(getent passwd escrow | cut -d: -f6)  workdir=/srv/escrow"

say "完成"
