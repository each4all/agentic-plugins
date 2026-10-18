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

Then run the block with `TEXT_DIR` set to that directory and `READ_DIR` to the
one Phase 2's read used: it reads the baseline from the `read.json` there.
Over an invalid baseline it appends nothing, and needs no note; otherwise a
note left unwritten stops it before the write. A `read.json` missing or
unreadable, or the read of another workflow than the one the block finds,
stops it too: run Phase 2 again. Nothing deletes the files.

```bash
TEXT_DIR='<directory from step 1>'
READ_DIR='<the directory Phase 2 read into>'
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# A fresh shell: the workflow is found again here, never carried from an
# earlier block.
PERSONA={{name}}
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch." >&2; exit 1; }
# host_history fidelity (ADR-0017 §sub-decision-1): no marker over a baseline
# whose commit object is not available. Re-read here, from this resume's own
# read.json: shell variables from Phase 2 do not survive across Bash calls. A
# read of another workflow than the one found above (the branch or its
# workflow changed since) stops the block: its baseline is not this one's.
BASE_HEAD_CHECK="$(node -e 'let r;try{r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))}catch{process.exit(1)}if(r===null||r.workflow_id!==require("path").basename(process.argv[2],".md"))process.exit(1);process.stdout.write(String((r.git_baseline||{}).head??""))' "$READ_DIR/read.json" "$ACTIVE")" \
  || { echo "✗ read.json in READ_DIR ($READ_DIR) is missing, unreadable or the read of another workflow than $ACTIVE; run Phase 2's read again. Nothing was written." >&2; exit 1; }
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
