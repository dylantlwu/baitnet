#!/usr/bin/env bash
# BaitNet testnet deployment + smoke test (D19).
#
# Run this YOURSELF (it creates accounts through the official faucet and handles
# private keys). Keys land only in ~/.near-credentials/testnet (legacy keychain)
# and in /Users/.../BaiNet/.env.testnet (gitignored via `.env.*`). Nothing is
# written into the repo except that ignored file.
#
# Usage:  bash contracts/scripts/deploy-testnet.sh [owner-account-id]
#         (default owner: baitnet-<4 random hex>.testnet)
set -euo pipefail

[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"
command -v near >/dev/null || { echo "near-cli-rs not found"; exit 1; }

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
NET=testnet
CREDS="$HOME/.near-credentials/$NET"
OWNER="${1:-baitnet-$(openssl rand -hex 2).$NET}"
REGISTRY="registry.$OWNER"
VAULT="vault.$OWNER"
REPORTER="reporter.$OWNER"
AGENT="agent.$OWNER"
RESP1="responder1.$OWNER"
RESP2="responder2.$OWNER"
SCAM="baitnet-smoke-scam.$NET"          # flagged in the smoke test; never receives money
EVIDENCE_HASH="$(printf 'baitnet testnet smoke evidence' | shasum -a 256 | cut -d' ' -f1)"
REASON_HASH="$(printf 'baitnet testnet smoke revoke' | shasum -a 256 | cut -d' ' -f1)"
PER_TX="200000000000000000000000"        # 0.2 NEAR
DAILY="500000000000000000000000"         # 0.5 NEAR

SIGN=(network-config "$NET" sign-with-legacy-keychain send)
step() { printf '\n==> %s\n' "$*"; }
call() { # call <signer> <contract> <method> <json> [deposit] [gas]
  near contract call-function as-transaction "$2" "$3" json-args "$4" \
    prepaid-gas "${6:-100 Tgas}" attached-deposit "${5:-0 NEAR}" sign-as "$1" "${SIGN[@]}"
}
view() { near contract call-function as-read-only "$1" "$2" json-args "$3" network-config "$NET" now 2>/dev/null; }

step "Owner $OWNER via faucet"
near account create-account sponsor-by-faucet-service "$OWNER" \
  autogenerate-new-keypair save-to-legacy-keychain network-config "$NET" create
sleep 3

for spec in "$REGISTRY:3" "$VAULT:2.5" "$REPORTER:0.5" "$AGENT:0.5" "$RESP1:0.3" "$RESP2:0.3"; do
  acc="${spec%%:*}"; bal="${spec##*:}"
  step "Sub-account $acc ($bal NEAR)"
  near account create-account fund-myself "$acc" "$bal NEAR" \
    autogenerate-new-keypair save-to-legacy-keychain sign-as "$OWNER" "${SIGN[@]}"
done

step "Deploy registry"
near contract deploy "$REGISTRY" use-file "$ROOT/contracts/registry/res/registry.wasm" \
  with-init-call new json-args "{\"owner\":\"$OWNER\"}" prepaid-gas '30 Tgas' attached-deposit '0 NEAR' "${SIGN[@]}"

step "Deploy vault"
near contract deploy "$VAULT" use-file "$ROOT/contracts/vault/res/vault.wasm" \
  with-init-call new json-args "{\"owner\":\"$OWNER\",\"agent\":\"$AGENT\",\"registry\":\"$REGISTRY\",\"per_tx_limit\":\"$PER_TX\",\"daily_limit\":\"$DAILY\"}" \
  prepaid-gas '30 Tgas' attached-deposit '0 NEAR' "${SIGN[@]}"

step "Configure"
call "$OWNER" "$REGISTRY" add_reporter "{\"id\":\"$REPORTER\"}"
call "$OWNER" "$VAULT" deposit '{}' '1 NEAR' '30 Tgas'
call "$RESP1" "$REGISTRY" register_responder '{"name":"DemoWallet"}' '0.01 NEAR' '30 Tgas'
call "$RESP2" "$REGISTRY" register_responder '{"name":"DemoExchange"}' '0.01 NEAR' '30 Tgas'

step "Agent: function-call key (vault.pay only), then drop the full-access key"
FULL_PK="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["public_key"])' "$CREDS/$AGENT.json")"
cp "$CREDS/$AGENT.json" "$CREDS/$AGENT.full-access.bak.json"   # local backup, removed below once the swap works
near account add-key "$AGENT" grant-function-call-access --allowance '0.25 NEAR' \
  --contract-account-id "$VAULT" --function-names pay \
  autogenerate-new-keypair save-to-legacy-keychain "${SIGN[@]}"
FC_FILE="$(ls -t "$CREDS/$AGENT"/*.json | head -1)"
FC_PK="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["public_key"])' "$FC_FILE")"
[ "$FC_PK" != "$FULL_PK" ] || { echo "could not locate new fc key"; exit 1; }
near account delete-keys "$AGENT" public-keys "$FULL_PK" "${SIGN[@]}"
cp "$FC_FILE" "$CREDS/$AGENT.json"
rm -f "$CREDS/$AGENT.full-access.bak.json"
chmod 600 "$CREDS/$AGENT.json"
near account list-keys "$AGENT" network-config "$NET" now

step "Smoke: report -> check"
call "$REPORTER" "$REGISTRY" report \
  "{\"address\":\"$SCAM\",\"chain\":\"near\",\"evidence_hash\":\"$EVIDENCE_HASH\",\"level\":\"L1\",\"category\":\"investment\"}" '0 NEAR' '30 Tgas'
CHECK="$(view "$REGISTRY" check "{\"chain\":\"near\",\"address\":\"$SCAM\"}")"
echo "$CHECK"
ALERT_ID="$(printf '%s' "$CHECK" | python3 -c 'import json,sys;d=json.load(sys.stdin);assert d and d["status"]=="Active";print(d["id"])')"

step "Smoke: pay flagged address (must fail with PAY_BLOCKED)"
if OUT="$(call "$AGENT" "$VAULT" pay "{\"to\":\"$SCAM\",\"amount\":\"10000000000000000000000\"}" 2>&1)"; then
  echo "$OUT"; echo "FAIL: pay to flagged address succeeded"; exit 1
fi
echo "$OUT" | grep -q PAY_BLOCKED || { echo "$OUT"; echo "FAIL: no PAY_BLOCKED"; exit 1; }
echo "OK: blocked"

step "Smoke: pay clean address ($RESP1)"
call "$AGENT" "$VAULT" pay "{\"to\":\"$RESP1\",\"amount\":\"10000000000000000000000\"}"

step "Smoke: revoke test alert"
call "$OWNER" "$REGISTRY" set_status "{\"alert_id\":$ALERT_ID,\"status\":\"Revoked\",\"reason_hash\":\"$REASON_HASH\"}" '0 NEAR' '30 Tgas'
[ "$(view "$REGISTRY" check "{\"chain\":\"near\",\"address\":\"$SCAM\"}" | tr -d '[:space:]')" = "null" ] && echo "OK: check -> null"
view "$REGISTRY" stats '{}'
view "$VAULT" get_config '{}'

step "Write $ROOT/.env.testnet (gitignored)"
key() { python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["private_key"])' "$CREDS/$1.json"; }
umask 077
cat > "$ROOT/.env.testnet" <<EOF
BAITNET_MODE=testnet
NEAR_RPC_URL=https://rpc.testnet.near.org
REGISTRY_CONTRACT_ID=$REGISTRY
VAULT_CONTRACT_ID=$VAULT
OWNER_ACCOUNT_ID=$OWNER
OWNER_PRIVATE_KEY=$(key "$OWNER")
REPORTER_ACCOUNT_ID=$REPORTER
REPORTER_PRIVATE_KEY=$(key "$REPORTER")
AGENT_ACCOUNT_ID=$AGENT
AGENT_PRIVATE_KEY=$(key "$AGENT")
RESPONDER1_ACCOUNT_ID=$RESP1
RESPONDER1_PRIVATE_KEY=$(key "$RESP1")
RESPONDER1_NAME=DemoWallet
RESPONDER2_ACCOUNT_ID=$RESP2
RESPONDER2_PRIVATE_KEY=$(key "$RESP2")
RESPONDER2_NAME=DemoExchange
EOF
(cd "$ROOT" && git check-ignore -q .env.testnet 2>/dev/null && echo ".env.testnet is gitignored") || true

cat <<EOF

Done.
  owner     $OWNER
  registry  https://testnet.nearblocks.io/address/$REGISTRY
  vault     https://testnet.nearblocks.io/address/$VAULT
Next:  cp .env .env.bak 2>/dev/null; cp .env.testnet .env && pnpm demo:testnet --ci; mv .env.bak .env 2>/dev/null || rm .env
EOF
