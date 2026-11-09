#!/usr/bin/env bash
# Build both contracts and refresh the committed wasm in */res/.
set -euo pipefail
cd "$(dirname "$0")"
[ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"
for c in registry vault; do
  (cd "$c" && cargo near build non-reproducible-wasm)
  cp "target/near/baitnet_${c}/baitnet_${c}.wasm" "$c/res/${c}.wasm"
  chmod 644 "$c/res/${c}.wasm"
done
ls -l registry/res/registry.wasm vault/res/vault.wasm
shasum -a 256 registry/res/registry.wasm vault/res/vault.wasm
