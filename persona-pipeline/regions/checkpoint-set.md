The summary reaches `state.mjs` as a file, never in the block: it is the text
the user typed, and in shell source a quote, `$` or backtick of it would be
read as code (ADR-0059, amendment of 2026-10-10). Before the block:

1. Create a private directory for it, and note the path it prints:

   ```bash
   mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"
   ```

2. With your file-writing tool, not the shell, create `summary.txt` in that
   directory holding the summary from Phase 0, ending with one newline.
   Nothing deletes it.

Then run the block with `TEXT_DIR` set to that directory; a summary left
unwritten stops it before the write.

```bash
TEXT_DIR='<directory from step 1>'
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# The summary the agent wrote with its file tool: state.mjs reads it itself.
grep -q '[^[:space:]]' "$TEXT_DIR/summary.txt" 2>/dev/null || { echo "✗ summary.txt in TEXT_DIR ($TEXT_DIR) is missing or blank; write it with the file tool first. Nothing was written." >&2; exit 1; }
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" checkpoint-set \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --summary-file "$TEXT_DIR/summary.txt"
```
