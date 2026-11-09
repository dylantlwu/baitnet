#!/usr/bin/env bash
# Copy the server's daily backups to this machine (incremental; run whenever you like).
#   deploy/pull-backups.sh root@1.2.3.4            → ./backups/<host>/daily/…
#   deploy/pull-backups.sh root@1.2.3.4 ~/BaitNetBackups
# Uses your SSH key; nothing is deleted locally (old local copies are yours to keep).
set -euo pipefail
HOST="${1:-${BAITNET_DEPLOY_HOST:-}}"
[[ -n "$HOST" ]] || { echo "用法：$0 user@server [本地目录]"; exit 1; }
DEST="${2:-$(cd "$(dirname "$0")/.." && pwd)/backups/${HOST#*@}}"
mkdir -p "$DEST"
chmod 700 "$DEST"
for i in 1 2 3; do
  rsync -az --partial -e "ssh -o ConnectTimeout=15" "$HOST:/var/lib/baitnet/backups/daily" "$DEST/" && break
  echo "rsync 失败（第 $i 次），10s 后重试…"; sleep 10
  [[ $i == 3 ]] && exit 1
done
echo "✓ 备份已拉到 $DEST/daily"
ls -1 "$DEST/daily" | tail -5
