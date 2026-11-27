The id reaches `state.mjs` as a file, never in the block: typed into shell
source, a quote, `$` or backquote in it would be read as code (ADR-0059,
C134(a)). Before the block:

1. Create a private directory for it, and note the path it prints:

   ```bash
   # Step 1: a private text directory, marked so that the step that reads it
   # last releases it (ADR-0059 Decisions 9 and 10).
   ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
   CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
   [ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
   MAKE_KIND='text'
   MAKE_PARENT=''
   {{> tmpdir-make}}
   printf '%s\n' "$MADE_DIR"
   ```

2. With your file-writing tool, not the shell, create
   `workflow-id.txt` in that directory holding the id exactly as typed,
   ending with one newline.

Then run the block with that directory in its `TEXT_DIR` line;
`resolve-workflow` reads the id from the file itself, and refuses a missing
or empty file, or one holding more than the id, before it looks. Once it
prints the workflow, it releases the directory (ADR-0059 Decision 10): the
printed path is all a later step reads. A refusal keeps it for the rerun.

```bash
TEXT_DIR='<directory from step 1>'
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
if ! WORKFLOW="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
    resolve-workflow --repo-root "$REPO_ROOT" --workflow-id-file "$TEXT_DIR/workflow-id.txt")"; then
  echo "✗ The id in $TEXT_DIR/workflow-id.txt names no single workflow file in the workflow homes of this checkout's read set (the reason is above); nothing archived." >&2
  exit 1
fi
printf 'WORKFLOW=%s\n' "$WORKFLOW"
# ADR-0059 Decision 10, item 1 — the id is resolved and printed: no block,
# rerun or continuation reads the directory again.
RELEASE_PATH="$TEXT_DIR"
{{> tmpdir-release}}
```
