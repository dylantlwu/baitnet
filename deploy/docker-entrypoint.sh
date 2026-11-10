#!/bin/sh
# BaitNet container entrypoint (Dockerfile / Railway). Installed as /usr/local/bin/baitnet.
#
#   baitnet start                              # default: write runtime.json from env, then run the server
#   baitnet invite --name Dylan --role reviewer  # first reviewer invite (same as `pnpm invite`)
#   baitnet invite --list | --revoke <code|id>
#   baitnet backup                             # snapshot data dir → $BAITNET_DATA_DIR/backups/manual/*.tar.gz
#   baitnet restore <backup.tar.gz>            # stage a backup; it is applied on the NEXT start (restart the service)
#   baitnet <any command>                      # run it as the app user in /app
#
# Started as root only so it can fix ownership of the mounted volume (Railway mounts volumes
# root-owned); every command then runs as the unprivileged `node` user (uid 1000) via gosu.
# That also keeps files created from `railway ssh` (which is root) owned by the app user.
set -eu

APP_DIR="${BAITNET_APP_DIR:-/app}" # override only for testing outside the image
DATA="${BAITNET_DATA_DIR:-/data}"
export BAITNET_DATA_DIR="$DATA"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA"
  chown -R node:node "$DATA"
  exec gosu node "$0" "$@"
fi

cd "$APP_DIR"
TSX="$APP_DIR/node_modules/tsx/dist/cli.mjs"
cmd="${1:-start}"
[ $# -gt 0 ] && shift

# A staged restore (baitnet restore) is swapped in here, before the server opens any database.
# The current files are moved aside to backups/pre-restore-<ts>/, never deleted.
apply_restore() {
  pending="$DATA/restore-pending"
  [ -d "$pending" ] || return 0
  aside="$DATA/backups/pre-restore-$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$aside"
  for f in "$pending"/* ; do
    [ -e "$f" ] || continue
    name=$(basename "$f")
    for cur in "$DATA/$name" "$DATA/$name-wal" "$DATA/$name-shm"; do
      if [ -e "$cur" ]; then mv "$cur" "$aside/"; fi
    done
    mv "$f" "$DATA/$name"
  done
  rmdir "$pending"
  echo "restore applied (previous files kept in $aside)" >&2
}

case "$cmd" in
  start)
    apply_restore
    # Like systemd ExecStartPre=-…: missing testnet values must not block the start
    # (the server then falls back to the in-memory registry and says so in /health).
    node "$TSX" scripts/write-runtime.ts || echo "write-runtime failed — starting without testnet runtime.json" >&2
    cd "$APP_DIR/apps/server"
    exec node "$TSX" src/main.ts
    ;;
  invite) exec node "$TSX" scripts/invite.ts "$@" ;;
  backup) exec node "$TSX" scripts/backup-data.ts "$@" ;;
  restore)
    src="${1:?usage: baitnet restore <backup.tar.gz>}"
    [ -f "$src" ] || { echo "no such file: $src" >&2; exit 1; }
    rm -rf "$DATA/restore-pending" "$DATA/restore-pending.tmp"
    mkdir -p "$DATA/restore-pending.tmp"
    tar -xzf "$src" -C "$DATA/restore-pending.tmp"
    mv "$DATA/restore-pending.tmp" "$DATA/restore-pending"
    echo "staged: $(ls "$DATA/restore-pending" | tr '\n' ' ')"
    echo "now restart the service (Railway: Deployments -> ... -> Restart); it is applied before the server starts."
    ;;
  *) exec "$cmd" "$@" ;;
esac
