#!/bin/sh
# Deploys new commits on origin/main: fast-forward, install, test, restart. Run hourly by
# rounak-mcp-update.timer. Rolls back if tests fail. Skips when the checkout is in use for
# development (not on main, or uncommitted changes), so it never touches your work.
set -eu
cd "$(dirname "$0")/.."

if [ "$(git symbolic-ref --short HEAD)" != main ] || [ -n "$(git status --porcelain)" ]; then
  echo "update: checkout is not a clean main; skipping"
  exit 0
fi

git fetch -q origin main
old=$(git rev-parse HEAD)
new=$(git rev-parse origin/main)
[ "$old" = "$new" ] && exit 0

echo "update: $old -> $new"
git merge -q --ff-only origin/main
if ! { npm ci --ignore-scripts --no-audit --no-fund && npm test; }; then
  echo "update: install or tests failed; rolling back to $old" >&2
  git reset -q --hard "$old"
  npm ci --ignore-scripts --no-audit --no-fund
  exit 1
fi
systemctl --user restart rounak-mcp
echo "update: deployed $new"
