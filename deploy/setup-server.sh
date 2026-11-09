#!/usr/bin/env bash
# BaitNet — one-time setup of a fresh Ubuntu 22.04 / 24.04 server (run as root).
#
#   sudo bash setup-server.sh                       # HTTPS on <public-ip>.sslip.io
#   sudo bash setup-server.sh --domain baitnet.example.com --email you@example.com
#   sudo bash setup-server.sh --basic-auth team    # extra site-wide password (asks for it)
#
# --basic-auth: a shared username/password in front of the WHOLE site (browser pop-up), as a
# safety net while invite-code login (BAITNET_AUTH=on) is not active in the server yet.
# Idempotent: safe to run again (e.g. to switch from sslip.io to a real domain).
# What it does:
#   - installs Node.js 22 (latest 22.x ≥ 22.22.2, checksum-verified, /opt/node), pnpm (npm -g),
#     Caddy (official apt repo), sqlite3, rsync, ufw
#   - system user `baitnet`; app in /opt/baitnet (releases/ + app → current), data in /var/lib/baitnet
#   - /etc/baitnet/env (mode 600) from env.production.example, with generated secrets
#   - systemd unit baitnet.service (start on boot, restart on crash)
#   - Caddy: HTTPS (Let's Encrypt), reverse proxy to 127.0.0.1:8787, SSE unbuffered
#   - daily backup cron (VACUUM INTO, 14 days), 5-minute health check
#   - firewall: only 22, 80, 443 open
# It does NOT deploy code — run deploy/push.sh from your machine afterwards.
set -euo pipefail

DOMAIN=""
EMAIL=""
BASIC_USER=""
NODE_MAJOR=22
NODE_MIN="22.22.2"
PNPM_VERSION="10.34.9"
APP_USER=baitnet
APP_HOME=/opt/baitnet
DATA_DIR=/var/lib/baitnet
ENV_DIR=/etc/baitnet
ENV_FILE=$ENV_DIR/env
PORT=8787
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() { sed -n '2,20p' "$0"; exit "${1:-0}"; }
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) DOMAIN="${2:-}"; shift 2 ;;
    --email) EMAIL="${2:-}"; shift 2 ;;
    --basic-auth) BASIC_USER="${2:-}"; shift 2 ;;
    -h | --help) usage 0 ;;
    *) echo "unknown option: $1"; usage 1 ;;
  esac
done

log() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die() { printf '  \033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "请用 root 运行：sudo bash $0"
. /etc/os-release
[[ "${ID:-}" == "ubuntu" ]] || warn "只在 Ubuntu 22.04/24.04 上测试过（当前：${PRETTY_NAME:-unknown}）"

retry() { # retry <n> <cmd...>
  local n=$1 i; shift
  for ((i = 1; i <= n; i++)); do
    "$@" && return 0
    warn "失败（第 $i/$n 次）：$*"
    sleep $((i * 3))
  done
  return 1
}

version_ge() { # version_ge 22.22.3 22.22.2
  [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" == "$2" ]]
}

# ---------------------------------------------------------------- packages
log "系统软件包"
export DEBIAN_FRONTEND=noninteractive
retry 3 apt-get update -q
retry 3 apt-get install -yq curl ca-certificates gnupg rsync sqlite3 ufw xz-utils cron debian-keyring debian-archive-keyring apt-transport-https
ok "curl rsync sqlite3 ufw cron"

# ---------------------------------------------------------------- node
log "Node.js ${NODE_MAJOR}.x (≥ ${NODE_MIN})"
case "$(uname -m)" in
  x86_64) NARCH=x64 ;;
  aarch64 | arm64) NARCH=arm64 ;;
  *) die "不支持的 CPU 架构 $(uname -m)" ;;
esac
current=""
command -v node >/dev/null && current="$(node -v | sed 's/^v//')"
if [[ -n "$current" ]] && version_ge "$current" "$NODE_MIN" && [[ "${current%%.*}" == "$NODE_MAJOR" ]]; then
  ok "已安装 node v$current"
else
  tmp="$(mktemp -d)"
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  retry 4 curl -fsSL "$base/SHASUMS256.txt" -o "$tmp/SHASUMS256.txt"
  tarball="$(grep -oE "node-v[0-9.]+-linux-${NARCH}\.tar\.xz" "$tmp/SHASUMS256.txt" | head -1)"
  [[ -n "$tarball" ]] || die "在 $base 找不到 linux-${NARCH} 的 Node 包"
  ver="$(echo "$tarball" | sed -E 's/^node-v([0-9.]+)-.*/\1/')"
  version_ge "$ver" "$NODE_MIN" || die "nodejs.org 上最新的 22.x 是 $ver，低于 $NODE_MIN"
  retry 4 curl -fSL --retry 3 -C - "$base/$tarball" -o "$tmp/$tarball"
  (cd "$tmp" && grep " $tarball\$" SHASUMS256.txt | sha256sum -c -) || die "Node 安装包校验失败"
  rm -rf /opt/node.new && mkdir -p /opt/node.new
  tar -xJf "$tmp/$tarball" -C /opt/node.new --strip-components=1
  rm -rf /opt/node && mv /opt/node.new /opt/node
  for b in node npm npx corepack; do ln -sfn "/opt/node/bin/$b" "/usr/local/bin/$b"; done
  rm -rf "$tmp"
  ok "node $(node -v) → /opt/node"
fi

log "pnpm ${PNPM_VERSION}"
if [[ "$(pnpm -v 2>/dev/null || true)" != "$PNPM_VERSION" ]]; then
  retry 3 npm install -g --no-fund --no-audit "pnpm@${PNPM_VERSION}" >/dev/null
  [[ -e /usr/local/bin/pnpm ]] || ln -sfn "$(npm prefix -g)/bin/pnpm" /usr/local/bin/pnpm
fi
ok "pnpm $(pnpm -v)"

# ---------------------------------------------------------------- caddy
log "Caddy"
if ! command -v caddy >/dev/null; then
  retry 4 bash -c 'curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg'
  retry 4 bash -c 'curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list'
  chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
  retry 3 apt-get update -q
  retry 3 apt-get install -yq caddy
fi
ok "$(caddy version | head -1)"

# ---------------------------------------------------------------- user + dirs
log "用户与目录"
id "$APP_USER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "$APP_HOME" --shell /usr/sbin/nologin "$APP_USER"
mkdir -p "$APP_HOME/releases" "$DATA_DIR/backups" "$ENV_DIR"
chown -R "$APP_USER:$APP_USER" "$APP_HOME" "$DATA_DIR"
chmod 750 "$DATA_DIR"
ok "$APP_USER  代码 $APP_HOME  数据 $DATA_DIR"

# ---------------------------------------------------------------- public URL
log "域名与 HTTPS"
if [[ -z "$DOMAIN" ]]; then
  ip="$(curl -fsS4 --max-time 8 https://api.ipify.org || curl -fsS4 --max-time 8 https://ifconfig.me || true)"
  [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || ip="$(hostname -I | awk '{print $1}')"
  [[ -n "$ip" ]] || die "拿不到公网 IP，请用 --domain 指定域名"
  DOMAIN="${ip//./-}.sslip.io"
  warn "没有提供域名，使用 $DOMAIN（sslip.io 把这个名字解析到 $ip，Caddy 会为它自动申请证书）"
fi
PUBLIC_URL="https://$DOMAIN"
ok "$PUBLIC_URL"

# ---------------------------------------------------------------- env file
log "环境变量 $ENV_FILE"
if [[ ! -f "$ENV_FILE" ]]; then
  [[ -f "$HERE/env.production.example" ]] || die "找不到 $HERE/env.production.example（把整个 deploy/ 目录传到服务器）"
  install -m 600 -o root -g root "$HERE/env.production.example" "$ENV_FILE"
  ok "已从模板创建（请填写 key 和测试网账户）"
fi
set_env() { # set_env KEY VALUE  (replace or append)
  if grep -qE "^$1=" "$ENV_FILE"; then sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"; else echo "$1=$2" >>"$ENV_FILE"; fi
}
get_env() { grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2-; }
set_env BAITNET_PUBLIC_URL "$PUBLIC_URL"
set_env BAITNET_CORS_ORIGINS "$PUBLIC_URL"
set_env BAITNET_DATA_DIR "$DATA_DIR"
set_env PORT "$PORT"
[[ -n "$(get_env BAITNET_SESSION_SECRET)" ]] || set_env BAITNET_SESSION_SECRET "$(openssl rand -hex 32)"
[[ -n "$(get_env BAITNET_EVIDENCE_KEY)" ]] || set_env BAITNET_EVIDENCE_KEY "$(openssl rand -hex 32)"
chmod 600 "$ENV_FILE" && chown root:root "$ENV_FILE"
ok "BAITNET_PUBLIC_URL=$PUBLIC_URL；会话密钥和证据密钥已生成（只在这台机器上）"

# ---------------------------------------------------------------- systemd
log "systemd 服务 baitnet.service"
cat >/etc/systemd/system/baitnet.service <<UNIT
[Unit]
Description=BaitNet server (API + dashboard, single port)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
EnvironmentFile=$ENV_FILE
WorkingDirectory=$APP_HOME/app/apps/server
# Write runtime.json (chain config) from $ENV_FILE. "-" = do not block start if testnet values are missing.
ExecStartPre=-/usr/bin/env node $APP_HOME/app/node_modules/tsx/dist/cli.mjs $APP_HOME/app/scripts/write-runtime.ts
ExecStart=/usr/bin/env node $APP_HOME/app/node_modules/tsx/dist/cli.mjs src/main.ts
Restart=always
RestartSec=3
# give SSE clients a moment, then stop
TimeoutStopSec=15
KillMode=mixed
# hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LimitNOFILE=65536

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable baitnet.service >/dev/null
ok "已启用（开机自启、崩溃 3 秒后重启）；第一次 push.sh 之后才会真正启动"

# ---------------------------------------------------------------- caddy config
log "Caddy 反向代理"
BASIC_BLOCK=""
if [[ -n "$BASIC_USER" ]]; then
  if [[ -z "${BASIC_PASS:-}" ]]; then
    read -r -s -p "  为 $BASIC_USER 设置全站密码: " BASIC_PASS; echo
  fi
  [[ ${#BASIC_PASS} -ge 10 ]] || die "全站密码至少 10 位"
  hash="$(caddy hash-password --plaintext "$BASIC_PASS")"
  BASIC_BLOCK="$(printf '\tbasic_auth {\n\t\t%s %s\n\t}\n' "$BASIC_USER" "$hash")"
  unset BASIC_PASS
  ok "全站密码已启用（用户名 $BASIC_USER）"
fi
{
  # Global options only when an e-mail for Let's Encrypt notices was given.
  if [[ -n "$EMAIL" ]]; then printf '{\n\temail %s\n}\n\n' "$EMAIL"; fi
  cat <<CADDY
$DOMAIN {
$BASIC_BLOCK
	# SSE streams: no compression, flush every event immediately, no read timeout.
	@sse path /events /arena/sessions/*/events
	handle @sse {
		reverse_proxy 127.0.0.1:$PORT {
			flush_interval -1
			transport http {
				read_timeout 0
			}
		}
	}

	handle {
		encode zstd gzip
		reverse_proxy 127.0.0.1:$PORT {
			flush_interval -1
		}
	}

	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		Referrer-Policy strict-origin-when-cross-origin
		-Server
	}

	log {
		output file /var/log/caddy/baitnet.log {
			roll_size 20MiB
			roll_keep 5
		}
	}
}
CADDY
} >/etc/caddy/Caddyfile
mkdir -p /var/log/caddy && chown caddy:caddy /var/log/caddy 2>/dev/null || true
caddy fmt --overwrite /etc/caddy/Caddyfile >/dev/null 2>&1 || true
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null || die "Caddyfile 校验失败：caddy validate --config /etc/caddy/Caddyfile"
systemctl enable caddy >/dev/null
systemctl reload caddy 2>/dev/null || systemctl restart caddy
ok "$DOMAIN → 127.0.0.1:$PORT（证书在第一次访问时自动申请；云厂商的安全组要放行 80/443）"

# ---------------------------------------------------------------- backups + health
log "每日备份与健康检查"
install -m 755 "$HERE/backup.sh" /usr/local/bin/baitnet-backup
install -m 755 "$HERE/healthcheck.sh" /usr/local/bin/baitnet-healthcheck
cat >/usr/local/bin/baitnet-invite <<'INV'
#!/usr/bin/env bash
# sudo baitnet-invite --name 张三 --role expert|reviewer   (also --list, --revoke <code|id>)
set -euo pipefail
set -a; . /etc/baitnet/env; set +a
cd /opt/baitnet/app
exec sudo -u baitnet -E env PATH="/usr/local/bin:/usr/bin:/bin" node node_modules/tsx/dist/cli.mjs scripts/invite.ts "$@"
INV
chmod 755 /usr/local/bin/baitnet-invite
cat >/etc/cron.d/baitnet <<CRON
# BaitNet: daily backup 03:30 (server time), health check every 5 minutes
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
30 3 * * * $APP_USER BAITNET_DATA_DIR=$DATA_DIR /usr/local/bin/baitnet-backup >>$DATA_DIR/backups/backup.log 2>&1
*/5 * * * * root /usr/local/bin/baitnet-healthcheck --quiet
CRON
chmod 644 /etc/cron.d/baitnet
systemctl enable --now cron >/dev/null 2>&1 || true
ok "备份 → $DATA_DIR/backups/daily/（保留 14 天）；健康检查失败时自动重启服务并写入 journal"

# ---------------------------------------------------------------- firewall
log "防火墙（只开 22、80、443）"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null # HTTP/3
ufw --force enable >/dev/null
ok "$(ufw status | head -1)"

log "完成"
cat <<DONE
  下一步：
  1. 编辑密钥与测试网账户：  sudo nano $ENV_FILE
  2. 在你自己的电脑上部署：   deploy/push.sh root@<服务器IP>
  3. 第一个 reviewer 邀请：   sudo baitnet-invite --name Dylan --role reviewer
  4. 打开：                  $PUBLIC_URL
  日志：journalctl -u baitnet -f      Caddy：journalctl -u caddy -f
DONE
