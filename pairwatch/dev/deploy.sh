#!/usr/bin/env bash
# Copy the mod into a running session's mods folder, so that session hot-reloads it.
#   dev/deploy.sh <session-id>        (the id of the Claude Code session to load it in)
# The copy goes to <config>/dev-mods/<session-id>/<plugin name>, where <config> is CLAUDE_CONFIG_DIR
# or ~/.claude and the plugin name is plugin.json's. The first copy into a session's mods folder makes
# Claude Code ask the person, once, "Enable hot reloading for this session?". Later copies reload
# when that session's turn ends.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# The plugin's folder.
MOD="$ROOT/pairwatch"
SID=${1:-}
case $SID in
  '' | */* | .*)
    echo "usage: dev/deploy.sh <session-id>" >&2
    exit 2
    ;;
esac
command -v rsync >/dev/null 2>&1 || { echo "deploy: rsync is not on PATH" >&2; exit 1; }

# The folder is named after the plugin.
NAME=$(node -e 'const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(typeof j.name === "string" ? j.name : "")' "$MOD/.claude-plugin/plugin.json" 2>/dev/null || true)
[ -n "$NAME" ] || NAME=$(basename "$MOD")
case $NAME in
  */* | .*)
    echo "deploy: plugin.json names the plugin '$NAME', which is no folder name" >&2
    exit 1
    ;;
esac

MODS="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/dev-mods/$SID"
DEST="$MODS/$NAME"
mkdir -p "$DEST"
# The engine lays its declarations and a tsconfig.json in the copy: kept, never deleted.
rsync -a --delete --exclude '.claude-plugin/types/' --exclude 'tsconfig.json' "$MOD/" "$DEST/"
echo "deployed $NAME -> $DEST"

# A copy under the plugin's former name would go on loading beside this one.
for old in tutor; do
  if [ "$old" != "$NAME" ] && [ -d "$MODS/$old" ]; then
    echo "deploy: $MODS/$old still holds the mod under its former name, so that session loads both. Remove it: rm -rf '$MODS/$old'" >&2
  fi
done
