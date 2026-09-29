#!/bin/bash
# 每天备份「只存在于这台机器上」的东西。
#
# 代码在 GitHub 上，不用备。真正丢不起的是这几样：
#   .testnet-wallets.json   全部角色私钥
#   services/*/.env         机器人 token、各服务私钥、合约地址
#   .bot-state.json         Telegram 账号 ↔ 钱包地址的绑定关系
#   .sim-jury-salts.json    陪审员投票的 salt —— 丢了那几席就永远揭示不了，质押被罚没
#   deployments-*.json      哪套合约在服务
#   evidence-store/         争议证据（图片、证据包）—— 增量同步，见下文
#
# 另外一律先 git status 一遍：未提交的改动是最容易整个消失的东西，
# 09-29 那次检查发现一整周的漏洞修复只存在于这台机器上，就是这么来的。
set -u
DIR=/srv/escrow-backups
KEEP=30
cd /srv/escrow || exit 1
mkdir -p "$DIR"
STAMP=$(date +%Y%m%d-%H%M)

# 未提交的改动单独存一份 patch，比压在归档里更容易发现
sudo -u escrow git status --porcelain > "$DIR/uncommitted-$STAMP.txt" 2>&1
if [ -s "$DIR/uncommitted-$STAMP.txt" ]; then
  sudo -u escrow git diff HEAD > "$DIR/uncommitted-$STAMP.patch" 2>&1
  echo "注意：有未提交的改动，已另存 patch"
  cat "$DIR/uncommitted-$STAMP.txt"
else
  rm -f "$DIR/uncommitted-$STAMP.txt"
fi

tar czf "$DIR/secrets-$STAMP.tar.gz" \
  --ignore-failed-read \
  .testnet-wallets.json \
  .sim-*.json \
  deployments-*.json \
  services/*/.env services/*/.*-state.json 2>/dev/null
chmod 600 "$DIR"/secrets-*.tar.gz

# 证据图片与证据包：只同步新增的文件，不做全量归档。
# 文件名就是内容的 SHA-256，写进去就不会再变，所以「没有的才拷」就是完整的增量；
# 每天全量打包的话，2GB 上限 × 30 份会把这台 48G 的盘撑爆。
# 源目录里的文件被删了，这里也不跟着删 —— 备份的意义就是删了还在。
if [ -d evidence-store ]; then
  mkdir -p "$DIR/evidence-store"
  cp -an evidence-store/. "$DIR/evidence-store/"
  echo "证据文件 $(ls "$DIR/evidence-store" | wc -l) 个，$(du -sh "$DIR/evidence-store" | cut -f1)"
fi

# 只留最近 KEEP 份
ls -1t "$DIR"/secrets-*.tar.gz 2>/dev/null | tail -n +$((KEEP+1)) | xargs -r rm -f
ls -1t "$DIR"/uncommitted-*.patch 2>/dev/null | tail -n +$((KEEP+1)) | xargs -r rm -f

echo "$(date -Is) 备份完成 $(du -h "$DIR/secrets-$STAMP.tar.gz" | cut -f1)"
