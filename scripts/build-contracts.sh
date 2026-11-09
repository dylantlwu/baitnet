#!/usr/bin/env bash
# Rebuild the prebuilt contract wasm that the demo deploys (`pnpm contracts:build`).
# Only needed when you change contracts/. Judges use the committed res/*.wasm.
# Requires: Rust (rustup) + cargo-near  (cargo install --locked cargo-near)
set -euo pipefail
cd "$(dirname "$0")/../contracts"
[[ -f "$HOME/.cargo/env" ]] && source "$HOME/.cargo/env"
command -v cargo-near >/dev/null || { echo "需要 cargo-near：cargo install --locked cargo-near"; exit 1; }
for c in registry vault; do
  [[ -f "$c/src/lib.rs" ]] || continue
  echo "▶ building $c"
  (cd "$c" && cargo near build non-reproducible-wasm --no-abi --out-dir res)
  # cargo-near names the file after the crate (baitnet_<c>.wasm); the demo expects res/<c>.wasm
  if [[ -f "$c/res/baitnet_$c.wasm" ]]; then mv -f "$c/res/baitnet_$c.wasm" "$c/res/$c.wasm"; fi
  ls -la "$c/res/"
done
