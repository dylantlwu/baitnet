#!/usr/bin/env bash
# Lightweight secret scanner (pre-commit hook + `pnpm check-secrets`).
#   scripts/check-secrets.sh            scan files staged for commit (pre-commit)
#   scripts/check-secrets.sh --all      scan every tracked + untracked-not-ignored file
# CI additionally runs gitleaks over the full git history (.github/workflows/ci.yml).
# False positive? Add `secret-scan:allow` on that line, or a path to .secretsignore.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

mode="${1:-staged}"
if [[ "$mode" == "--all" ]]; then
  files=$(git ls-files -co --exclude-standard)
else
  files=$(git diff --cached --name-only --diff-filter=ACMR)
fi
[[ -z "$files" ]] && exit 0

# Files that must never be committed, whatever their content.
is_blocked() {
  case "$1" in
    .env.example | */.env.example) return 1 ;;
    .env | .env.* | */.env | */.env.*) return 0 ;;
    data/* | .near-credentials/* | */.near-credentials/* | *.pem | *id_rsa | *id_ed25519) return 0 ;;
  esac
  return 1
}

patterns=(
  'ed25519:[1-9A-HJ-NP-Za-km-z]{80,}'                 # NEAR private key (secret part is ~88 chars; public keys are ~44)
  'secp256k1:[1-9A-HJ-NP-Za-km-z]{90,}'
  'sk-ant-[A-Za-z0-9_-]{20,}'                        # Anthropic
  'sk-(proj-)?[A-Za-z0-9_-]{32,}'                    # OpenAI-style (NEAR AI Cloud keys use this shape)
  'eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}'  # JWT (Intents Explorer)
  'gh[pousr]_[A-Za-z0-9]{36,}'                       # GitHub token
  'AKIA[0-9A-Z]{16}'                                 # AWS access key
  '-----BEGIN [A-Z ]*PRIVATE KEY-----'
  '"private_key"[[:space:]]*:[[:space:]]*"ed25519:'  # near-cli credential JSON
  '^[[:space:]]*(export[[:space:]]+)?(NEARAI_API_KEY|ANTHROPIC_API_KEY|INTENTS_EXPLORER_JWT|EVIDENCE_KEY|BAITNET_EVIDENCE_KEY|[A-Z0-9_]*PRIVATE_KEY)=["'"'"']?[A-Za-z0-9:_+/=.-]{16,}'
)
regex=$(IFS='|'; echo "${patterns[*]}")

ignore_file=.secretsignore
status=0
while IFS= read -r f; do
  [[ -f "$f" ]] || continue
  if is_blocked "$f"; then
    echo "✗ 不能提交的文件: $f"; status=1; continue
  fi
  [[ -f "$ignore_file" ]] && grep -qxF "$f" "$ignore_file" && continue
  # skip binaries (wasm, images)
  if file --mime "$f" 2>/dev/null | grep -q 'charset=binary'; then continue; fi
  if [[ "$mode" == "--all" ]]; then content=$(cat "$f"); else content=$(git show ":$f" 2>/dev/null || true); fi
  hits=$(printf '%s\n' "$content" | grep -nE -- "$regex" | grep -v 'secret-scan:allow' || true)
  if [[ -n "$hits" ]]; then
    echo "✗ 疑似密钥: $f"
    printf '%s\n' "$hits" | cut -c1-160 | sed 's/^/    /'
    status=1
  fi
done <<< "$files"

if [[ $status -ne 0 ]]; then
  echo
  echo "提交被阻止：上面的内容看起来像密钥/私钥。密钥只放 .env（已被 gitignore）。"
  echo "确认是误报：在该行加 'secret-scan:allow'，或把路径写进 .secretsignore。"
fi
exit $status
