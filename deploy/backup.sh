#!/usr/bin/env bash
# BaitNet daily backup (installed as /usr/local/bin/baitnet-backup, run by cron as `baitnet`).
#   - every *.sqlite in $BAITNET_DATA_DIR (training.sqlite, the auth DB, …) via `VACUUM INTO`
#     → a consistent single-file copy, safe while the server is running (WAL included)
#   - tar.gz of evidence/ (encrypted originals + .key if the key is file-based), arena/, eval/,
#     training-export/, conversations/
#   - keeps 14 days (BAITNET_BACKUP_DAYS)
# Output: $BAITNET_DATA_DIR/backups/daily/<YYYY-MM-DD_HHMM>/
set -euo pipefail
DATA="${BAITNET_DATA_DIR:-/var/lib/baitnet}"
DAYS="${BAITNET_BACKUP_DAYS:-14}"
ROOT="$DATA/backups/daily"
DEST="$ROOT/$(date +%Y-%m-%d_%H%M)"
umask 077
mkdir -p "$DEST"

shopt -s nullglob
n=0
for db in "$DATA"/*.sqlite; do
  name="$(basename "$db")"
  sqlite3 "$db" ".timeout 10000" "VACUUM INTO '$DEST/$name'"
  # sanity: the copy must open and pass a quick integrity check
  [[ "$(sqlite3 "$DEST/$name" 'PRAGMA quick_check;')" == "ok" ]] || { echo "integrity check failed: $DEST/$name" >&2; exit 1; }
  n=$((n + 1))
done

dirs=()
for d in evidence arena eval training-export conversations; do [[ -e "$DATA/$d" ]] && dirs+=("$d"); done
if ((${#dirs[@]})); then tar -C "$DATA" -czf "$DEST/files.tar.gz" "${dirs[@]}"; fi

# retention
find "$ROOT" -mindepth 1 -maxdepth 1 -type d -mtime +"$DAYS" -exec rm -rf {} +
echo "$(date -Is) backup ok: $DEST ($n sqlite, ${#dirs[@]} dirs, $(du -sh "$DEST" | cut -f1))"
