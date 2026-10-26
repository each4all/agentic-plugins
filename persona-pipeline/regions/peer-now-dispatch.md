A codex peer answers from a snapshot of the checkout, removed when the
run ends (C96): a file it writes is discarded with it. Ask it for an
answer, not for files.

The prompt reaches the runner as a file you write, never in the block: in
shell source a quote, `$`, backtick or line of it would be read as code, and
so would a `--prompt-file` path (ADR-0059, amendment of 2026-10-10). Before
the block:

1. Create a private directory for it, and note the path it prints:

   ```bash
   mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"
   ```

2. With your file-writing tool, not the shell, write the prompt there as
   `prompt.xml`: the `--prompt-text`, or the text of the `--prompt-file`,
   which you read with your file-reading tool. Write it as given, or as the
   privacy gate leaves it where the runbook has one. Nothing deletes it.

Then run the block with `TEXT_DIR` set to that directory and `PEER` to the
`--peer` value. A `prompt.xml` that is missing or blank stops it before the
dispatch. Keep the directory: the block writes the run id there before it
dispatches, `prompt.xml.run-id`, and the runner its result,
`prompt.xml.run.json`, and its stderr, `prompt.xml.err`; the `[Peer]` note
step reads the run from the result.
{{#capability dispatch_target}}
The block also keeps there the workflow the consultation is for,
`prompt.xml.workflow` (empty for none), to which alone the note step appends,
and, on a macro's child, the consultation's operation directory, `op`
(ADR-0068 Decision 2, item 7). A directory that holds `op` already dispatched
a consultation: the block refuses it, so take a fresh one for each.
{{/capability}}

```bash
TEXT_DIR='<directory from step 1>'
PEER='<claude|codex, from --peer>'
ROOT_OVERRIDE="$(printenv {{root_env}} || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/{{name}} -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
# The run id, allocated by the runner (C119, C26): no shell arithmetic or
# hand-written date makes it. An allocation that prints nothing stops the
# block too.
RUN_ID="$(node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" new-run-id --prefix peer-now)" || RUN_ID=''
[ -n "$RUN_ID" ] || { echo "✗ peer-runner.mjs new-run-id allocated no run id (its error, if any, is above); nothing was dispatched." >&2; exit 1; }
# The run id beside the prompt, before the dispatch: a status or cancel of a
# run that hangs reads it there, in a shell of its own.
printf '%s' "$RUN_ID" > "$TEXT_DIR/prompt.xml.run-id" || { echo "✗ Could not record the run id in TEXT_DIR ($TEXT_DIR); nothing was dispatched." >&2; exit 1; }
# The runner's result and its stderr go beside the prompt: the [Peer] note
# step reads the run from there, never from this block's shell.
RUN_JSON="$TEXT_DIR/prompt.xml.run.json"
RUN_ERR="$TEXT_DIR/prompt.xml.err"
echo "peer-now run_id=$RUN_ID" >&2
# The prompt is the file the agent wrote with its file tool (ADR-0059,
# amendment of 2026-10-10), a --prompt-text or a --prompt-file's text: no
# line or path of it is shell source. The runner reads it.
PROMPT_FILE="$TEXT_DIR/prompt.xml"
grep -q '[^[:space:]]' "$PROMPT_FILE" 2>/dev/null || { echo "✗ prompt.xml in TEXT_DIR ($TEXT_DIR) is missing or blank; write it with the file tool first. Nothing was dispatched." >&2; exit 1; }
{{#capability dispatch_target}}
# ADR-0068 Decision 2, item 7 — a consultation on a macro's child is a persona
# operation (kind peer), registered before the launch: its run names no
# workflow, so the lane sees it only so. It opens in its operation directory,
# op beside the prompt, with a write of the entry alone; a refusal (another
# operation open in the lane, holds that cannot be read) stops the launch, and
# the [Peer] note step, or a failure below, ends it. Scripts that do not know
# holds (no hold-capability) open none.
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" \
  || { echo "✗ find-active failed (its error is above); resolve it with the resume command first. Nothing was dispatched." >&2; exit 1; }
# The workflow this consultation is for: the note step appends to it alone.
printf '%s\n' "$ACTIVE" > "$TEXT_DIR/prompt.xml.workflow" || { echo "✗ Could not record the consultation's workflow in TEXT_DIR ($TEXT_DIR); nothing was dispatched." >&2; exit 1; }
OP_DIR=''
if [ -n "$ACTIVE" ] && node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" hold-capability >/dev/null 2>&1; then
  OP_DIR="$TEXT_DIR/op"
  # A fresh directory for each consultation: run again from this one, the
  # block would launch a second run under the first one's operation.
  mkdir -m 700 "$OP_DIR" || { echo "✗ TEXT_DIR ($TEXT_DIR) already holds a consultation's operation directory, or op cannot be made there: dispatch each consultation from a fresh directory. Nothing was dispatched." >&2; exit 1; }
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" operation \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
    --operation-dir "$OP_DIR" --open-operation peer >/dev/null \
    || { echo "✗ The consultation's operation could not open on $ACTIVE (the reason is above); nothing was dispatched." >&2; exit 1; }
fi
{{/capability}}
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" run \
  --repo-root "$REPO_ROOT" --run-id "$RUN_ID" --kind peer-now \
  --peer "$PEER" --prompt-file "$PROMPT_FILE" --output-format text \
  --host "${AGENTIC_HOST:-claude}" --cwd "$REPO_ROOT" \
  > "$RUN_JSON" 2> "$RUN_ERR"
RUN_RC=$?
STDOUT_PATH="$(node -e 'try{process.stdout.write((JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).stdout_path)||"")}catch{}' "$RUN_JSON")"
STDERR_PATH="$(node -e 'try{process.stdout.write((JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).stderr_path)||"")}catch{}' "$RUN_JSON")"
HANDLE_PATH="$(node -e 'try{process.stdout.write((JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).handle_path)||"")}catch{}' "$RUN_JSON")"
ERROR_KIND="$(node -e 'try{process.stdout.write((JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).error_kind)||"")}catch{}' "$RUN_JSON")"
{{#capability dispatch_target}}
# A failed consultation gets no note, so its operation ends here, once the
# runner's own result says the run ended. A runner that left no result (it was
# killed, and its peer may still run) leaves the operation open for the owner.
RUN_STATUS="$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).status||""))}catch{}' "$RUN_JSON")"
if [ "$RUN_RC" -ne 0 ] && [ -n "$OP_DIR" ]; then
  case "$RUN_STATUS" in
    failed|cancelled|orphaned)
      node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" operation \
        --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
        --operation-dir "$OP_DIR" --close-operation true \
        || { echo "✗ The consultation's operation on $ACTIVE could not end (the reason is above); it stays open until the owner clears it." >&2; } ;;
    *) echo "✗ peer-now run $RUN_ID left no ended result, so its operation on $ACTIVE stays open: once the run is over (peer-runner.mjs status), the owner clears it." >&2 ;;
  esac
fi
{{/capability}}
# The runner's exit status is this block's own (R4 J3): a failed consultation
# stops here, where the agent sees it, and the [Peer] note step refuses it too.
[ "$RUN_RC" -eq 0 ] || { echo "✗ peer-now run $RUN_ID failed (exit $RUN_RC${ERROR_KIND:+, $ERROR_KIND}); $RUN_ERR${STDERR_PATH:+ and $STDERR_PATH} say why. No note is appended for it." >&2; exit "$RUN_RC"; }
```
