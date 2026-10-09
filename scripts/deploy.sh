#!/usr/bin/env bash
# 部署本插件到 DSH profile 并验证注册结果。
#
# 用法：
#   pnpm run deploy                       # 部署到默认 profile（web）
#   DSH_PROFILE=<name> pnpm run deploy    # 用环境变量指定 profile
#   pnpm run deploy -- <name>             # 用位置参数指定 profile
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${DSH_PROFILE:-${1:-web}}"
PLUGIN_ID="obsidian-plugin"

cd "$ROOT"

echo "==> build (tsc -> lib/)"
pnpm run build

echo "==> register checkout into profile '$PROFILE'"
dsh plugin --profile "$PROFILE" add "$ROOT"

echo "==> verify: '$PLUGIN_ID' is composed AND not skipped"
# The check lives in its own script so it can be unit-tested: a plain
# `grep obsidian-plugin` reported success for a plugin the runtime was skipping,
# because the incompatibility message contains the package name.
dsh --profile "$PROFILE" --dump-config 2>&1 | node "$ROOT/scripts/verify-composed.mjs" "$PLUGIN_ID" "@leelee592/dsh-obsidian-plugin"
echo
echo "next: dsh --profile $PROFILE   # 重启后模型工具集多出 11 个 obsidian_plugin_* 工具"
