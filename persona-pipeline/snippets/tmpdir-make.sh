# ADR-0059 Decision 9: make and mark the directory MAKE_KIND names (text or
# op; MAKE_PARENT, when set, for an op nested in it); its path is MADE_DIR.
# The fallbacks of Decision 10, item 4 make it the old way: an older
# state.mjs, lacking tmpdir-make, and a platform where the make is unsupported
# with mktemp -d, a nested op in a parent made the old way with mkdir. A fallback's path is
# checked for what a single-quoted shell literal cannot carry, as the make
# checks its own. Each status is read in a condition, so errexit changes
# nothing here.
MADE_DIR=''
if grep -q -e "'tmpdir-make'" "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" 2>/dev/null; then
  if [ -n "${MAKE_PARENT:-}" ]; then
    MADE_DIR="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" tmpdir-make --kind op --parent "$MAKE_PARENT")" && MAKE_RC=0 || MAKE_RC=$?
  else
    MADE_DIR="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" tmpdir-make --kind "$MAKE_KIND")" && MAKE_RC=0 || MAKE_RC=$?
  fi
elif [ -r "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ]; then
  MAKE_RC=old
else
  echo "✗ Cannot read $CLAUDE_PLUGIN_ROOT/scripts/state.mjs; no directory was made." >&2
  exit 1
fi
case "$MAKE_RC" in
  0) ;;
  3|4|old)
    if [ -n "${MAKE_PARENT:-}" ]; then
      MADE_DIR="$MAKE_PARENT/op"
      mkdir -m 700 "$MADE_DIR" || { echo "✗ $MADE_DIR already holds an operation directory, or cannot be made: run from a fresh directory. No directory was made." >&2; exit 1; }
    else
      MADE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agentic-$MAKE_KIND.XXXXXX")" || exit 1
      [ "$MAKE_RC" != 3 ] || echo "agentic-dir make: unsupported on this platform; $MADE_DIR was made with mktemp -d and will not be released" >&2
    fi
    node -e 'process.exit(/[\x00-\x1f\x7f\x27]/.test(process.argv[1])?1:0)' "$MADE_DIR" \
      || { echo "✗ The directory made holds a quote or a control character, which a single-quoted shell literal cannot carry; set TMPDIR to a path without one." >&2; exit 1; }
    ;;
  5) echo "✗ TMPDIR (${TMPDIR:-/tmp}) holds a quote or a control character, which a single-quoted shell literal cannot carry; set TMPDIR to a path without one. No directory was made." >&2; exit 1 ;;
  *) exit 1 ;;
esac
[ -n "$MADE_DIR" ] || { echo "✗ The make printed no directory; nothing can be written." >&2; exit 1; }
