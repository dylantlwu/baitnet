#!/usr/bin/env bash
# Deploy this working copy to the server — no GitHub needed.
#
#   deploy/push.sh root@1.2.3.4            # deploy
#   deploy/push.sh root@1.2.3.4 --rollback # switch back to the previous release
#   deploy/push.sh root@1.2.3.4 --dry-run  # show what would be uploaded
#   BAITNET_DEPLOY_HOST=root@1.2.3.4 deploy/push.sh
#
# Steps:
#   1. local checks: secret scan, no ignored source files, lockfile present
#   2. upload (tar over ssh) exactly the files git would commit (`git ls-files -co --exclude-standard`,
#      so .env / data/ / node_modules never leave this machine) into a NEW release dir /opt/baitnet/releases/<ts>
#   3. on the server, as user baitnet: pnpm install --frozen-lockfile, build the web app
#   4. switch /opt/baitnet/app → new release, restart baitnet.service, wait for /health
#   5. if the health check fails: switch back to the previous release automatically
# Keeps the last 5 releases. Requires: ssh key login to the server, setup-server.sh already run.
set -euo pipefail
cd "$(dirname "$0")/.."

HOST="${BAITNET_DEPLOY_HOST:-}"
MODE=deploy
for a in "$@"; do
  case "$a" in
    --rollback) MODE=rollback ;;
    --dry-run) MODE=dry ;;
    -h | --help) sed -n '2,18p' "$0"; exit 0 ;;
    -*) echo "unknown option $a"; exit 1 ;;
    *) HOST="$a" ;;
  esac
done
[[ -n "$HOST" ]] || { echo "用法：$0 user@server [--rollback|--dry-run]"; exit 1; }

APP=/opt/baitnet
SSH=(ssh -o ConnectTimeout=15 -o ServerAliveInterval=20 "$HOST")
say() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }

remote() { "${SSH[@]}" "bash -s -- $*"; }

if [[ "$MODE" == rollback ]]; then
  say "回滚到上一个版本"
  remote <<'R'
set -euo pipefail
cd /opt/baitnet
cur="$(readlink -f app)"
prev="$(ls -1dt releases/* | grep -vxF "${cur#/opt/baitnet/}" | head -1)"
[[ -n "$prev" ]] || { echo "没有可回滚的旧版本"; exit 1; }
ln -sfn "/opt/baitnet/$prev" app.tmp && mv -Tf app.tmp app
systemctl restart baitnet
sleep 3; systemctl is-active baitnet && echo "已回滚到 $prev"
R
  exit 0
fi

say "本地检查"
command -v git >/dev/null || { echo "需要 git（只用来列文件，不需要 GitHub）"; exit 1; }
[[ -d .git ]] || { echo "这里不是 git 仓库：先 git init（不需要远程仓库）"; exit 1; }
[[ -f pnpm-lock.yaml ]] || { echo "缺 pnpm-lock.yaml"; exit 1; }
bash scripts/check-secrets.sh --all
bash scripts/check-ignored-sources.sh
LIST="$(mktemp)"
trap 'rm -f "$LIST"' EXIT
git ls-files -z -co --exclude-standard >"$LIST"
echo "  $(tr -cd '\0' <"$LIST" | wc -c | tr -d ' ') 个文件"

REL="$(date -u +%Y%m%d-%H%M%S)"
if [[ "$MODE" == dry ]]; then
  tr '\0' '\n' <"$LIST"
  exit 0
fi

say "上传到 $HOST:$APP/releases/$REL"
# A tar stream of exactly the listed files into an empty release dir: nothing stale survives,
# works with macOS bsdtar / openrsync and GNU tar on the server, and needs no GitHub.
for i in 1 2 3; do
  if COPYFILE_DISABLE=1 tar --null -T "$LIST" --no-xattrs -czf - | "${SSH[@]}" \
    "set -e; rm -rf $APP/releases/$REL; mkdir -p $APP/releases/$REL; tar --warning=no-unknown-keyword -xzf - -C $APP/releases/$REL"; then
    break
  fi
  [[ $i == 3 ]] && { echo "上传失败"; exit 1; }
  echo "上传失败（第 $i 次），10s 后重试…"; sleep 10
done

say "服务器上安装、构建、切换、重启"
remote "$REL" <<'R'
set -euo pipefail
REL="$1"; APP=/opt/baitnet; DIR="$APP/releases/$REL"
chown -R baitnet:baitnet "$DIR"
as_app() { sudo -u baitnet -H env PATH="/usr/local/bin:/usr/bin:/bin" CI=1 "$@"; }
cd "$DIR"
for i in 1 2 3; do as_app pnpm install --frozen-lockfile --reporter=append-only && break; [[ $i == 3 ]] && exit 1; sleep 10; done
as_app pnpm --filter @baitnet/web run build
test -f apps/web/dist/index.html || { echo "web build 没有产出 apps/web/dist/index.html"; exit 1; }

prev="$(readlink -f "$APP/app" 2>/dev/null || true)"
ln -sfn "$DIR" "$APP/app.tmp" && mv -Tf "$APP/app.tmp" "$APP/app"
systemctl restart baitnet
port="$(grep -E '^PORT=' /etc/baitnet/env | cut -d= -f2)"; port="${port:-8787}"
for i in $(seq 1 30); do
  if curl -fsS --max-time 3 "http://127.0.0.1:$port/health" >/dev/null 2>&1; then
    echo "✓ /health ok（${i}s）  当前版本 $REL"
    # keep the newest 5 releases
    ls -1dt "$APP"/releases/* | tail -n +6 | xargs -r rm -rf
    exit 0
  fi
  sleep 1
done
echo "✗ 新版本 30s 内没有通过 /health，自动回滚。最近日志："
journalctl -u baitnet -n 40 --no-pager || true
if [[ -n "$prev" && -d "$prev" ]]; then
  ln -sfn "$prev" "$APP/app.tmp" && mv -Tf "$APP/app.tmp" "$APP/app"
  systemctl restart baitnet
  echo "已回滚到 $(basename "$prev")"
fi
exit 1
R

URL="$("${SSH[@]}" "grep -E '^BAITNET_PUBLIC_URL=' /etc/baitnet/env | cut -d= -f2" || true)"
say "完成  ${URL:-}"
