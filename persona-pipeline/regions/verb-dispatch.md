The prompt reaches the runner as a file the block never builds: it carries the
artifact and the peer's instructions, and in shell source a quote, `$`,
backtick or line of them would be read as code (ADR-0059, amendment of
2026-10-10). Before the block:

1. Create a private directory for it, and note the path it prints:

   ```bash
   mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"
   ```

2. With your file-writing tool, not the shell, create `prompt.xml` in that
   directory holding the prompt (where this runbook has a privacy gate above,
   it must have passed, and the prompt carries only genericized text).
   Nothing deletes it.

3. When this ensemble is a review (`plan-verify`, `review`,
   `adversarial-scan`, `refine-verify`), with your file-writing tool create
   `subject.json` in that directory: what you put in the reviewer's subject,
   `{"shown": [...], "covered": [...]}`, each a list of repository-relative
   paths (ADR-0069 Decision 1, item 6). `shown` is every path the prompt shows;
   `covered`, those it shows at the content the working tree holds now. A
   critique of the pending change covers its staged and unstaged hunks' paths
   and the untracked files it embeds; one of the entire branch shows the
   committed `HEAD`, so a path also dirty in the checkout is in `shown` only; a
   refine-verify shows its patch's paths; a scoped pass, its passages' paths,
   a deleted passage's included; an adversarial scan, the files it collected in
   scope; a plan held outside the tree, none, so both lists are empty. A review
   with no such file is unbound, and vouches for nothing it saw.

Then run the block with `TEXT_DIR` set to that directory; a prompt left
unwritten stops it before the dispatch. Keep the directory: the runner writes
its result there, `prompt.xml.run.json`, and the finalize block reads the run's
id from that file (its `DISPATCH_DIR`), never from this block's shell.

```bash
TEXT_DIR='<directory from step 1>'
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
ENSEMBLE_TYPE={{ensemble_type}}
# A fresh shell: the workflow is found again here, never carried from an
# earlier block.
PERSONA={{name}}
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch; nothing was dispatched." >&2; exit 1; }
# The prompt the agent wrote with its file tool: the runner reads it, so no
# line of it is shell source. A prompt left unwritten stops the block here.
PROMPT_FILE="$TEXT_DIR/prompt.xml"
grep -q '[^[:space:]]' "$PROMPT_FILE" 2>/dev/null || { echo "✗ prompt.xml in TEXT_DIR ($TEXT_DIR) is missing or blank; write it with the file tool first. Nothing was dispatched." >&2; exit 1; }
# ADR-0017 §sub-decision 4 — stable run-id BEFORE dispatch, allocated by the
# runner (C119, C26): no shell arithmetic or hand-written date makes it. An
# allocation that prints nothing stops the block too.
RUN_ID="$(node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" new-run-id --prefix "$ENSEMBLE_TYPE")" || RUN_ID=''
[ -n "$RUN_ID" ] || { echo "✗ peer-runner.mjs new-run-id allocated no run id for $ENSEMBLE_TYPE (its error, if any, is above); nothing was dispatched." >&2; exit 1; }
# The dispatch's own record of the run it launches and the workflow it found,
# written before the launch: the finalize settles that run from it when the
# runner ends without writing its result (R4 F1).
node -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({run_id:process.argv[2],workflow_path:process.argv[3]})+"\n")' "$PROMPT_FILE.dispatch.json" "$RUN_ID" "$ACTIVE" \
  || { echo "✗ Could not record the dispatch in TEXT_DIR ($TEXT_DIR); nothing was dispatched." >&2; exit 1; }
# ADR-0069 Decision 1, item 6 — the subject the agent wrote, for a review. A
# peer-runner older than this runbook takes no such flag, so it is passed only
# when it names it. The positional parameters, since the block runs in any
# POSIX shell, which has no arrays.
set --
if [ -f "$TEXT_DIR/subject.json" ] && grep -q -e "'--subject-file'" "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" 2>/dev/null; then
  set -- --subject-file "$TEXT_DIR/subject.json"
fi
# Run this block as a host background task (on Claude, the Bash tool's
# run_in_background), never with a trailing `&`: the host tracks the runner
# and notifies you when it exits, where a shell `&` would detach it from both.
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" run \
  --repo-root "$REPO_ROOT" --kind ensemble \
  --peer codex --prompt-file "$PROMPT_FILE" --output-format json \
  --workflow-path "$ACTIVE" --phase {{verb}} \
  --host "${AGENTIC_HOST:-claude}" --cwd "$REPO_ROOT" \
  --ensemble-type "$ENSEMBLE_TYPE" --run-id "$RUN_ID" \
  "$@" \
  > "$PROMPT_FILE.run.json" 2> "$PROMPT_FILE.err"
```
