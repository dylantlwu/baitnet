#!/usr/bin/env bash
# Install the pre-commit secret scan into this clone (`pnpm hooks:install`).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
hook=.git/hooks/pre-commit
cat > "$hook" <<'HOOK'
#!/usr/bin/env bash
exec bash scripts/check-secrets.sh
HOOK
chmod +x "$hook"
echo "✓ 已安装 pre-commit 钩子（$hook → scripts/check-secrets.sh）"
