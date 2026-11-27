# ADR-0059 Decision 10, item 4: release RELEASE_PATH (nothing when it is
# empty), cleanup only. On standard error the CLI's own line, or one of these
# when its result cannot be read; the block's standard output and exit status
# stay what its own work set, errexit or not.
if [ -n "${RELEASE_PATH:-}" ]; then
  if grep -q -e "'tmpdir-release'" "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" 2>/dev/null; then
    RELEASE_REPORT="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" tmpdir-release --path "$RELEASE_PATH")" || :
    node -e 'let r=null;try{r=JSON.parse(process.argv[1])}catch{}process.exit(r!==null&&typeof r==="object"&&typeof r.outcome==="string"?0:1)' "$RELEASE_REPORT" 2>/dev/null \
      || echo "agentic-dir release: the result is unknown; the directory may remain at $RELEASE_PATH or at its .removing- path" >&2
  elif [ -r "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ]; then
    echo "agentic-dir release: no tmpdir-release in this state.mjs; the directory is kept at $RELEASE_PATH" >&2
  else
    echo "agentic-dir release: the result is unknown (cannot read $CLAUDE_PLUGIN_ROOT/scripts/state.mjs); the directory may remain at $RELEASE_PATH" >&2
  fi
fi
