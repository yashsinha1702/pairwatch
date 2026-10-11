#!/usr/bin/env bash
# Checks for the Pairwatch mod.
#   dev/check.sh              all of them: tsc, validate, kit tests, node specs
#   dev/check.sh tsc|validate|test|spec|all
#
# Env (each optional; the script prints what it picked):
#   TYPES       the plugin API's declarations (claude-code.d.ts) to type-check against. Default: the
#               copy Claude Code lays in <plugin>/.claude-plugin/types/ while it loads the plugin from
#               its folder (claude --plugin-dir), else the newest copy the plugin-authoring skill left
#               in Claude Code's temp folder.
#   CLAUDE_BIN  the claude that validates and runs the kit tests. Default: `claude` on PATH when it is
#               at or above the declarations' version, else the VS Code extension's binary of that
#               version (or a newer one).
# Needs: TypeScript from `npm ci` in dev/ (tsc), and Node 22.18 or newer, which runs the .ts specs.
set -uo pipefail
DEV=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$DEV/.." && pwd)
# The plugin's folder.
MOD="$ROOT/pairwatch"
# Mods arrived in Claude Code 2.1.287: the lowest claude worth using when no declarations name one.
MIN_CLAUDE=2.1.287

say() { echo "check: $*"; }
fail() { echo "check: $*" >&2; return 1; }

# Is the dotted version $1 at or above $2? Both are digits and dots only.
version_ge() {
  local IFS=.
  local -a a b
  a=($1)
  b=($2)
  local i x y n=${#a[@]}
  [ "${#b[@]}" -gt "$n" ] && n=${#b[@]}
  for ((i = 0; i < n; i++)); do
    x=${a[i]:-0}
    y=${b[i]:-0}
    if ((10#$x > 10#$y)); then return 0; fi
    if ((10#$x < 10#$y)); then return 1; fi
  done
  return 0
}
is_version() { case ${1:-} in '' | *[!0-9.]* | .* | *.) return 1 ;; *) return 0 ;; esac; }
# The first dotted version on stdin's first line.
first_version() { head -1 | grep -oE '[0-9]+(\.[0-9]+)+' | head -1; }

# ---------------------------------------------------------------- the API declarations

TYPES_VERSION=''
TYPES_FROM=''
# Sets TYPES and TYPES_VERSION ('' when the file names no version); quiet, returns 1 when none is found.
find_types() {
  [ -n "$TYPES_FROM" ] && return 0
  if [ -n "${TYPES:-}" ]; then
    [ -f "$TYPES" ] || return 1
    TYPES_FROM='from $TYPES'
  elif [ -f "$MOD/.claude-plugin/types/claude-code/index.d.ts" ]; then
    TYPES="$MOD/.claude-plugin/types/claude-code/index.d.ts"
    TYPES_FROM='laid beside the plugin'
  else
    # The plugin-authoring skill's copy:
    #   <temp>/claude-<uid>/bundled-skills/<version>/<hash>/plugin-authoring/types/claude-code.d.ts
    # where <temp> is CLAUDE_CODE_TMPDIR, else the system's (TMPDIR, else /tmp). The newest version wins.
    local uid dir f v best='' bestv=''
    uid=$(id -u)
    for dir in "${CLAUDE_CODE_TMPDIR:-}" "${TMPDIR:-}" /tmp; do
      [ -n "$dir" ] || continue
      for f in "${dir%/}/claude-$uid"/bundled-skills/*/*/plugin-authoring/types/claude-code.d.ts; do
        [ -f "$f" ] || continue
        v=$(first_version <"$f")
        is_version "$v" || continue
        if [ -z "$bestv" ] || ! version_ge "$bestv" "$v"; then
          best=$f
          bestv=$v
        fi
      done
    done
    [ -n "$best" ] || return 1
    TYPES=$best
    TYPES_FROM="the plugin-authoring skill's copy"
  fi
  TYPES_VERSION=$(first_version <"$TYPES")
  is_version "$TYPES_VERSION" || TYPES_VERSION=''
  say "types   Claude Code ${TYPES_VERSION:-(version not stated)}, $TYPES_FROM: $TYPES"
}

types_missing() {
  if [ -n "${TYPES:-}" ] && [ ! -f "$TYPES" ]; then
    fail "TYPES=$TYPES is not a file"
  else
    fail "no API declarations (claude-code.d.ts) found. Set TYPES to one, or run 'claude --plugin-dir ./$(basename "$MOD")' in $ROOT once, so Claude Code lays them in $(basename "$MOD")/.claude-plugin/types/ (or load the plugin-authoring skill once)."
  fi
}

# ---------------------------------------------------------------- the claude binary

CLAUDE_VERSION=''
# Sets CLAUDE_BIN and CLAUDE_VERSION, printing what it picked, or says why nothing fits and returns 1.
find_claude() {
  [ -n "$CLAUDE_VERSION" ] && return 0
  local floor=$MIN_CLAUDE why='the first Claude Code with mods'
  if ! find_types; then
    [ -z "${TYPES:-}" ] || { types_missing; return 1; }
    say "types   none found, so any claude at or above $MIN_CLAUDE will do"
  elif [ -n "$TYPES_VERSION" ]; then
    floor=$TYPES_VERSION
    why="the version of the API declarations"
  fi
  local c v
  if [ -n "${CLAUDE_BIN:-}" ]; then
    case $CLAUDE_BIN in */*) ;; *) CLAUDE_BIN=$(command -v "$CLAUDE_BIN" 2>/dev/null || echo "$CLAUDE_BIN") ;; esac
    [ -f "$CLAUDE_BIN" ] && [ -x "$CLAUDE_BIN" ] || { fail "CLAUDE_BIN=$CLAUDE_BIN is not an executable file"; return 1; }
    v=$("$CLAUDE_BIN" --version 2>/dev/null | first_version)
    CLAUDE_VERSION=${v:-unknown}
    say "claude  $CLAUDE_VERSION, from \$CLAUDE_BIN: $CLAUDE_BIN"
    return 0
  fi
  local seen=''
  c=$(command -v claude 2>/dev/null || true)
  if [ -n "$c" ]; then
    v=$("$c" --version 2>/dev/null | first_version)
    if is_version "$v" && version_ge "$v" "$floor"; then
      CLAUDE_BIN=$c
      CLAUDE_VERSION=$v
      say "claude  $v, on PATH: $c"
      return 0
    fi
    seen="The claude on PATH is ${v:-of unknown version} ($c). "
  fi
  # VS Code's extension carries its own binary:
  #   <extensions>/anthropic.claude-code-<version>[-<platform>]/resources/native-binary/claude
  # The one of the floor's exact version first, else the newest above it.
  local root f name best='' bestv=''
  for root in "$HOME/.vscode-server/extensions" "$HOME/.vscode/extensions" \
    "$HOME/.vscode-server-insiders/extensions" "$HOME/.vscode-insiders/extensions" \
    "$HOME/.cursor-server/extensions" "$HOME/.cursor/extensions"; do
    for f in "$root"/anthropic.claude-code-*/resources/native-binary/claude; do
      [ -f "$f" ] && [ -x "$f" ] || continue
      name=${f#"$root"/anthropic.claude-code-}
      v=${name%%[-/]*}
      is_version "$v" && version_ge "$v" "$floor" || continue
      if [ "$v" = "$floor" ]; then
        best=$f
        bestv=$v
        break 2
      fi
      if [ -z "$bestv" ] || ! version_ge "$bestv" "$v"; then
        best=$f
        bestv=$v
      fi
    done
  done
  if [ -n "$best" ]; then
    CLAUDE_BIN=$best
    CLAUDE_VERSION=$bestv
    say "claude  $bestv, the VS Code extension's: $best"
    return 0
  fi
  fail "no claude at or above $floor ($why) was found. ${seen}Set CLAUDE_BIN to a newer claude, or TYPES to the declarations of the one you have."
}

# ---------------------------------------------------------------- the checks

run_tsc() {
  echo "== tsc"
  find_types || { types_missing; return 1; }
  local tsc="$DEV/node_modules/.bin/tsc"
  [ -x "$tsc" ] || { fail "TypeScript is not installed: run (cd dev && npm ci)"; return 1; }
  # A throwaway tsconfig: its include names absolute paths, which have no place in the repo.
  local tmp rc
  tmp=${TMPDIR:-/tmp}
  tmp=$(mktemp -d "${tmp%/}/pairwatch-tsc.XXXXXX") || { fail "could not make a temp folder"; return 1; }
  TSC_TMP=$tmp
  cat >"$tmp/tsconfig.json" <<EOF
{
  "compilerOptions": {
    "target": "es2023", "lib": ["es2023"], "types": [],
    "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noUncheckedIndexedAccess": true,
    "noEmit": true, "skipLibCheck": true, "allowImportingTsExtensions": true,
    "jsx": "react", "jsxFactory": "h", "jsxFragmentFactory": "Fragment"
  },
  "include": ["$TYPES", "$MOD/hooks", "$MOD/types", "$MOD/tests"]
}
EOF
  "$tsc" -p "$tmp/tsconfig.json"
  rc=$?
  rm -rf "$tmp"
  TSC_TMP=''
  return $rc
}

run_validate() {
  echo "== claude plugin validate"
  find_claude || return 1
  local rc=0
  "$CLAUDE_BIN" plugin validate "$MOD" || rc=1
  # The marketplace this repository is, strictly: an entry that disagrees with plugin.json fails.
  if [ -f "$ROOT/.claude-plugin/marketplace.json" ]; then
    "$CLAUDE_BIN" plugin validate --strict "$ROOT" || rc=1
  fi
  return $rc
}

run_test() {
  echo "== claude plugin test"
  if ! ls "$MOD"/tests/*.test.ts* >/dev/null 2>&1; then
    echo "(no kit tests yet)"
    return 0
  fi
  find_claude || return 1
  # Kit tests run only where installed plugins' hooks modules load (see the README's Requirements).
  (cd "$MOD" && "$CLAUDE_BIN" plugin test "$MOD")
}

run_spec() {
  echo "== node specs"
  local f
  local -a specs=()
  for f in "$DEV"/spec/*.spec.ts "$DEV"/spec/*.spec.mjs; do
    [ -f "$f" ] && specs+=("$f")
  done
  if [ "${#specs[@]}" -eq 0 ]; then
    echo "(no specs yet)"
    return 0
  fi
  command -v node >/dev/null 2>&1 || { fail "node is not on PATH; the specs need Node 22.18 or newer"; return 1; }
  if ! node -e 'process.exit(process.features && process.features.typescript ? 0 : 1)' 2>/dev/null; then
    fail "Node $(node --version 2>/dev/null) cannot run the .ts specs: they need Node 22.18 or newer"
    return 1
  fi
  say "node    $(node --version)"
  node --test --test-reporter=dot "${specs[@]}"
}

# run_tsc's throwaway folder, removed even when the run is cut short
TSC_TMP=''
trap '[ -z "$TSC_TMP" ] || rm -rf "$TSC_TMP"' EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

say "plugin  $MOD"
status=0
case "${1:-all}" in
  tsc) run_tsc || status=1 ;;
  validate) run_validate || status=1 ;;
  test) run_test || status=1 ;;
  spec) run_spec || status=1 ;;
  all)
    run_tsc || status=1
    run_validate || status=1
    run_test || status=1
    run_spec || status=1
    ;;
  *)
    echo "usage: dev/check.sh [tsc|validate|test|spec|all]" >&2
    exit 2
    ;;
esac
[ $status -eq 0 ] && echo "== OK" || echo "== FAILED"
exit $status
