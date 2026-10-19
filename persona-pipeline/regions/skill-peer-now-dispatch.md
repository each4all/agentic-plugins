`peer-runner.mjs` supervises the companion process and writes a hidden
repo-local ledger under `.agentic-plugins/state/{{persona}}/peer-runs/<run_id>/`.
{{#capability legacy_homes}}
A repository still on the legacy home keeps it under
`.claude/agentic-{{persona}}/peer-runs/<run_id>/` until explicit migration.
{{/capability}}
With `--kind peer-now`, it does NOT touch `pending_ensemble` or
`ensemble_results` — it just tracks the side-channel process and surfaces
the response path. Use `--output-format text` so the raw companion stdout
stays verbatim in `stdout.log`.

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
dispatch. Keep the directory: the runner writes its result there,
`prompt.xml.run.json`, and its stderr, `prompt.xml.err`; the `[Peer]` note
step reads the run from the result.

```bash
TEXT_DIR='<directory from step 1>'
PEER='<claude|codex, from --peer>'
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
HOST="${AGENTIC_HOST:-claude}"  # Codex-side command-invoked mode uses codex.
# The run id, allocated by the runner (C119, C26): no shell arithmetic or
# hand-written date makes it. An allocation that prints nothing stops the
# block too.
RUN_ID="$(node "<plugin-root>/scripts/peer-runner.mjs" new-run-id --prefix peer-now)" || RUN_ID=''
[ -n "$RUN_ID" ] || { echo "✗ peer-runner.mjs new-run-id allocated no run id (its error, if any, is above); nothing was dispatched." >&2; exit 1; }
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

node "<plugin-root>/scripts/peer-runner.mjs" run \
  --repo-root "$REPO_ROOT" --run-id "$RUN_ID" --kind peer-now \
  --peer "$PEER" --prompt-file "$PROMPT_FILE" --output-format text \
  --host "$HOST" --cwd "$REPO_ROOT" \
  > "$RUN_JSON" 2> "$RUN_ERR"
RUN_RC=$?

STDOUT_PATH="$(node -e 'try{process.stdout.write((JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).stdout_path)||"")}catch{}' "$RUN_JSON")"
STDERR_PATH="$(node -e 'try{process.stdout.write((JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).stderr_path)||"")}catch{}' "$RUN_JSON")"
HANDLE_PATH="$(node -e 'try{process.stdout.write((JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).handle_path)||"")}catch{}' "$RUN_JSON")"
ERROR_KIND="$(node -e 'try{process.stdout.write((JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).error_kind)||"")}catch{}' "$RUN_JSON")"
# The runner's exit status is this block's own (R4 J3): a failed consultation
# stops here, where the agent sees it, and the [Peer] note step refuses it too.
[ "$RUN_RC" -eq 0 ] || { echo "✗ peer-now run $RUN_ID failed (exit $RUN_RC${ERROR_KIND:+, $ERROR_KIND}); $RUN_ERR${STDERR_PATH:+ and $STDERR_PATH} say why. No note is appended for it." >&2; exit "$RUN_RC"; }
```

Exit-code semantics (per `companions/contract.md` §5.1): 0 success (response
in `$STDOUT_PATH`); 1 `peer_run_error`; 2 `companion_misuse` (bad CLI args,
this command's bug); 3 peer CLI infrastructure failure (companion not
found). On `RUN_RC != 0`, surface the first line from `$RUN_ERR`, then
`$STDERR_PATH`, then `$ERROR_KIND` as fallback, plus exit code + run id; stop without appending a phase note and
exit non-zero.

The run can be inspected / cancelled from another local session (pass the
repository root: the runner reads the ledger under it, not under the working
directory): `peer-runner.mjs status --repo-root "$REPO_ROOT" --run-id <id>
--json` / `peer-runner.mjs cancel --repo-root "$REPO_ROOT" --run-id <id>`.
