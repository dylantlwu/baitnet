#!/usr/bin/env bash
# BaitNet health check (installed as /usr/local/bin/baitnet-healthcheck; cron every 5 min as root).
#   baitnet-healthcheck            print status, exit 0/1
#   baitnet-healthcheck --quiet    only log problems; restart the service after 2 failures in a row
# Checks: the service is active, GET http://127.0.0.1:$PORT/health answers ok, disk has > 1 GB free.
set -uo pipefail
QUIET=0; [[ "${1:-}" == "--quiet" ]] && QUIET=1
PORT="$(grep -E '^PORT=' /etc/baitnet/env 2>/dev/null | cut -d= -f2)"; PORT="${PORT:-8787}"
DATA="$(grep -E '^BAITNET_DATA_DIR=' /etc/baitnet/env 2>/dev/null | cut -d= -f2)"; DATA="${DATA:-/var/lib/baitnet}"
STATE=/run/baitnet-health.fails
problems=()

systemctl is-active --quiet baitnet || problems+=("service baitnet not active")
body="$(curl -fsS --max-time 5 "http://127.0.0.1:$PORT/health" 2>&1)" || problems+=("GET /health failed: $body")
[[ ${#problems[@]} -eq 0 && "$body" != *'"ok":true'* ]] && problems+=("/health not ok: $body")
free_kb="$(df -Pk "$DATA" | awk 'NR==2{print $4}')"
((free_kb < 1048576)) && problems+=("low disk: $((free_kb / 1024)) MB free on $DATA")

if ((${#problems[@]} == 0)); then
  rm -f "$STATE"
  ((QUIET)) || echo "ok  $body"
  exit 0
fi

fails=$(($(cat "$STATE" 2>/dev/null || echo 0) + 1))
echo "$fails" >"$STATE"
msg="baitnet health FAILED ($fails in a row): ${problems[*]}"
logger -t baitnet-health "$msg"
((QUIET)) || echo "$msg"
if ((fails >= 2)) && [[ "${problems[*]}" != *"low disk"* ]]; then
  logger -t baitnet-health "restarting baitnet.service"
  systemctl restart baitnet
  echo 0 >"$STATE"
fi
exit 1
