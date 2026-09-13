#!/usr/bin/env bash
# 部署本插件到 DSH profile 并验证注册结果。
#
# 用法：
#   pnpm run deploy                       # 部署到默认 profile（web）
#   DSH_PROFILE=<name> pnpm run deploy    # 用环境变量指定 profile
#   pnpm run deploy -- <name>             # 用位置参数指定 profile
#
# 等价于之前的四步：build -> dsh plugin add -> dump-config 验证。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROFILE="${DSH_PROFILE:-${1:-web}}"
PLUGIN_ID="obsidian-plugin"

cd "$ROOT"

echo "==> build (tsc -> lib/)"
pnpm run build

echo "==> install obsidian skill (symlink into ~/.dsh/skills)"
bash "$ROOT/scripts/install-skill.sh"

# 清理历史包名（rename 前），避免与新名重复 link；不存在则忽略。
dsh plugin --profile "$PROFILE" remove "@dsh-obsidian/tool" >/dev/null 2>&1 || true
dsh plugin --profile "$PROFILE" remove "dsh-obsidian-plugin" >/dev/null 2>&1 || true

echo "==> register checkout into profile '$PROFILE'"
dsh plugin --profile "$PROFILE" add "$ROOT"

echo "==> verify: dump-config should contain '$PLUGIN_ID'"
if dsh --profile "$PROFILE" --dump-config | grep -q "$PLUGIN_ID"; then
  echo "deploy: OK — '$PLUGIN_ID' registered in profile '$PROFILE'"
else
  echo "deploy: FAIL — '$PLUGIN_ID' not found in profile '$PROFILE' config" >&2
  exit 1
fi

echo
echo "next: dsh --profile $PROFILE   # 重启后模型工具集多出 3 个 obsidian_* 工具"
