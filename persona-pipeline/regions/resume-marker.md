The marker's note reaches `state.mjs` as a file, never in the block: the drift
summary is text you write, and in shell source a quote, `$` or backtick of it
would be read as code (ADR-0059, amendment of 2026-10-10). Before the block:

1. Create a private directory for it, and note the path it prints:

   ```bash
   mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"
   ```

2. With your file-writing tool, not the shell, create `note.md` in that
   directory, filled in and ending with one newline:

   ```text
   Re-entered via /{{persona}}:resume; drift=<clean|dirty>. <one-paragraph diff summary, or 'no changes since baseline'>
   ```

Then run the block with `TEXT_DIR` set to that directory. Over an invalid
baseline it appends nothing, and needs no file; otherwise a note left
unwritten stops it before the write. Nothing deletes the file.

```bash
TEXT_DIR='<directory from step 1>'
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# host_history fidelity (ADR-0017 §sub-decision-1): no marker over a baseline
# whose commit object is not available. Re-read here: shell variables from
# Phase 2 do not survive across Bash calls.
BASE_HEAD_CHECK="$(node -e 'try{const b=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).git_baseline||{};process.stdout.write(String(b.head??""))}catch{}' /tmp/{{name}}-resume-read.json)"
if [ -z "$BASE_HEAD_CHECK" ] || ! git cat-file -e "$BASE_HEAD_CHECK^{commit}" 2>/dev/null; then
  echo "Phase 2b: resume marker NOT appended (invalid baseline; ADR-0017 §sub-decision-1 host_history fidelity)."
else
  # The note the agent wrote with its file tool: state.mjs reads it itself.
  grep -q '[^[:space:]]' "$TEXT_DIR/note.md" 2>/dev/null || { echo "✗ note.md in TEXT_DIR ($TEXT_DIR) is missing or blank; write it with the file tool first. Nothing was written." >&2; exit 1; }
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
    --phase-label "Resume" --phase-note-file "$TEXT_DIR/note.md" \
    --event resumed
fi
```
