#!/usr/bin/env bash
# Move BaitNet's local secrets into 1Password and replace them with op:// references.
#
# Run this YOURSELF after installing the 1Password app + CLI and signing in:
#   bash scripts/op-import.sh            # dry run: shows what would happen, changes nothing
#   bash scripts/op-import.sh --apply    # imports, verifies every value, then rewrites the files
#
# What it does with --apply:
#   .env           secrets -> item "baitnet-local"    (file rewritten with op:// references)
#   .env.testnet   secrets -> item "baitnet-testnet"  (file rewritten with op:// references)
#   .env.railway   secrets -> item "baitnet-railway"  (file deleted: the live copy is in Railway Variables)
#   ~/.near-credentials/testnet/*.json -> Document items "near-testnet-<file>" (originals left in place)
# Secrets = keys whose name contains KEY, SECRET, TOKEN, PASSWORD or JWT. Everything else stays as is.
# A file is only rewritten after every value has been read back from 1Password and compared.
# Values are never printed.
#
# Afterwards run commands through 1Password, e.g.:
#   op run --env-file=.env -- pnpm demo:live
set -euo pipefail

VAULT="${OP_VAULT:-BaitNet}"
APPLY=0; [ "${1:-}" = "--apply" ] && APPLY=1
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

say() { printf '%s\n' "$*"; }
die() { printf 'op-import: %s\n' "$*" >&2; exit 1; }
is_secret() { [[ "$1" =~ (KEY|SECRET|TOKEN|PASSWORD|JWT) ]]; }

command -v op >/dev/null || die "没有找到 op 命令。先装 1Password CLI：https://developer.1password.com/docs/cli/get-started/"
op whoami >/dev/null 2>&1 || die "op 还没登录。打开 1Password App → 设置 → 开发者 → 勾选「与 1Password CLI 集成」，然后再运行一次（会弹 Touch ID）。"

if ! op vault get "$VAULT" >/dev/null 2>&1; then
  if [ $APPLY = 1 ]; then op vault create "$VAULT" >/dev/null && say "已创建保险库 $VAULT"; else say "[dry-run] 会创建保险库 $VAULT"; fi
fi

# import <file> <item-title> <mode: rewrite|delete>
import_env() {
  local file="$1" item="$2" mode="$3"
  [ -f "$file" ] || { say "跳过 $file（不存在）"; return; }
  local names=() vals=() line k v
  while IFS= read -r line || [ -n "$line" ]; do
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    [[ "$line" =~ ^(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    k="${BASH_REMATCH[2]}"; v="${BASH_REMATCH[3]}"
    v="${v%\"}"; v="${v#\"}"; v="${v%\'}"; v="${v#\'}"
    [ -n "$v" ] || continue
    [[ "$v" == op://* ]] && continue          # already a reference
    is_secret "$k" || continue
    names+=("$k"); vals+=("$v")
  done < "$file"
  if [ ${#names[@]} -eq 0 ]; then say "$file：没有需要导入的明文密钥"; return; fi
  say "$file → 1Password「$VAULT/$item」：${names[*]}"
  [ $APPLY = 1 ] || return 0

  local args=() i
  if op item get "$item" --vault "$VAULT" >/dev/null 2>&1; then
    # re-run after a partial failure: only continue if 1Password already holds exactly these values
    for i in "${!names[@]}"; do
      [ "$(op read "op://$VAULT/$item/${names[$i]}" 2>/dev/null)" = "${vals[$i]}" ] || die "1Password 里已有「$item」但内容不同。为避免覆盖，请先在 1Password 里确认/改名后再运行。"
    done
    say "  「$item」已存在且内容一致，不重复创建"
  else
    for i in "${!names[@]}"; do args+=("${names[$i]}[password]=${vals[$i]}"); done
    op item create --vault "$VAULT" --category "API Credential" --title "$item" "${args[@]}" >/dev/null
  fi

  # verify every value before touching the file
  for i in "${!names[@]}"; do
    [ "$(op read "op://$VAULT/$item/${names[$i]}")" = "${vals[$i]}" ] || die "校验失败：$item/${names[$i]}，文件没有改动"
  done
  say "  ✓ ${#names[@]} 项已写入并逐项校验"

  if [ "$mode" = delete ]; then
    rm -f "$file" && say "  ✓ 已删除 $file（线上副本在 Railway Variables，备份在 1Password）"
    return
  fi
  local tmp; tmp="$(mktemp "$file.XXXX")"; chmod 600 "$tmp"
  trap 'rm -f "$tmp"' EXIT
  while IFS= read -r line || [ -n "$line" ]; do
    k=""
    [[ "$line" =~ ^(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)= ]] && k="${BASH_REMATCH[2]}"
    if [ -n "$k" ] && [[ " ${names[*]} " == *" $k "* ]]; then
      printf '%s=op://%s/%s/%s\n' "$k" "$VAULT" "$item" "$k"
    else
      printf '%s\n' "$line"
    fi
  done < "$file" > "$tmp"
  mv "$tmp" "$file"; trap - EXIT
  say "  ✓ $file 里的密钥已换成 op:// 引用"
}

import_env .env baitnet-local rewrite
import_env .env.testnet baitnet-testnet rewrite
import_env .env.railway baitnet-railway delete

CREDS="$HOME/.near-credentials/testnet"
if compgen -G "$CREDS/*.json" >/dev/null || compgen -G "$CREDS/*/*.json" >/dev/null; then
  while IFS= read -r f; do
    rel="${f#"$CREDS"/}"; title="near-testnet-${rel//\//-}"
    if [ $APPLY = 1 ]; then
      if op document get "$title" --vault "$VAULT" >/dev/null 2>&1; then say "  已存在 $title，跳过"
      else op document create "$f" --vault "$VAULT" --title "$title" >/dev/null && say "  ✓ $title"; fi
    else say "[dry-run] 会备份 $f → 文档「$title」"; fi
  done < <(find "$CREDS" -name '*.json' -type f | sort)
fi

if [ $APPLY = 1 ]; then
  say ""
  say "完成。以后这样运行（会弹 Touch ID）："
  say "  op run --env-file=.env -- pnpm demo:live"
  say "  op run --env-file=.env --env-file=.env.testnet -- pnpm demo:testnet"
  say "~/.near-credentials/testnet 里的原文件还在（near 命令要用）；确认 1Password 里有备份后可以自行处理。"
else
  say ""
  say "以上是演练，什么都没改。确认无误后运行：bash scripts/op-import.sh --apply"
fi
