#!/usr/bin/env bash
# Fail if any source file under apps/ packages/ contracts/ scripts/ is git-ignored.
# Guards against over-broad .gitignore rules (e.g. `data/` once swallowed apps/web/src/data/).
# Run: pnpm check-ignored   (also in CI)
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

# Ignored files (tracked or not) in the source trees, minus build/dependency output.
bad=$(git ls-files -z --others --ignored --exclude-standard -- apps packages contracts scripts \
  | tr '\0' '\n' \
  | grep -Ev '(^|/)(node_modules|dist|target|coverage|\.vite|\.turbo)/' \
  | grep -E '\.(ts|tsx|mts|cts|js|mjs|cjs|rs|json|toml|css|html|sh)$|^contracts/[^/]+/res/[^/]+\.wasm$' \
  || true)

if [[ -n "$bad" ]]; then
  echo "✗ 这些源文件被 .gitignore 忽略了，clone 下来会缺文件："
  printf '%s\n' "$bad" | sed 's/^/    /'
  echo
  echo "查是哪条规则：git check-ignore -v <path>。规则请写成以 / 开头的根目录路径（如 /data/）。"
  exit 1
fi
echo "✓ apps/ packages/ contracts/ scripts/ 下没有被忽略的源文件"
