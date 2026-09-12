#!/usr/bin/env bash
# Symlink the gapmiss skill (git submodule) into a DSH skill discovery root.
#
# Usage:
#   bash scripts/install-skill.sh                 # -> ~/.dsh/skills/obsidian (global)
#   bash scripts/install-skill.sh .dsh/skills     # -> project-local root, creates <dir>/obsidian
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/third_party/obsidian-plugin-skill/.agents/skills/obsidian"
DEST="${1:-$HOME/.dsh/skills/obsidian}"

if [ ! -f "$SRC/SKILL.md" ]; then
  echo "error: submodule not checked out — run: git submodule update --init" >&2
  exit 1
fi

# If DEST ends with a discovered root (has no SKILL.md of its own), append /obsidian.
if [ ! -f "$DEST/SKILL.md" ] && [ -d "$DEST" ]; then
  DEST="$DEST/obsidian"
fi

mkdir -p "$(dirname "$DEST")"
ln -sfn "$SRC" "$DEST"
echo "linked skill: $SRC -> $DEST"
