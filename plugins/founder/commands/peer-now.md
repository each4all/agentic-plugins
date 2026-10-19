---
description: Ad-hoc cross-host business consultation — dispatch a verbatim (genericized) prompt to claude or codex outside a verb's ensemble flow
argument-hint: --peer <claude|codex> (--prompt-text "..." | --prompt-file <path>)
---

# Founder · Peer-now

$ARGUMENTS

`/founder:peer-now` is a meta command per ADR-0022 (meta-skill category,
adopted for founder per ADR-0036 SD2): a side-channel wrapper over
`peer-runner.mjs run --kind peer-now` that fires a verbatim prompt at the
cross-host peer companion (`claude` or `codex`) without opening a full
verb-skill ensemble. It does NOT advance any workflow phase and is excluded
from `ensemble_results` by design.

**Cognitive runbook + the Host-availability matrix live in
`${CLAUDE_PLUGIN_ROOT}/core/skills/peer-now/SKILL.md`** per ADR-0022. This command
file owns the Claude-host bash below.

<!-- pipeline:begin plugin-root -->
Plugin root: each shell block below opens by setting `$CLAUDE_PLUGIN_ROOT` —
from `AGENTIC_FOUNDER_ROOT` when that is set, else from the plugin path
Claude Code writes into this command when it loads it, else from the newest
version in the plugin cache. Keep those opening lines when you run a block: a
shell variable does not outlive a Bash call.
<!-- pipeline:end plugin-root -->

---

## Privacy gate (before any dispatch)

PRIVACY GATE: proprietary venture concepts, interview/customer data, and
unpublished business material pass an explicit gate before BOTH web search
AND peer-host dispatch. peer-now sends a **verbatim** prompt to the peer
host — genericize it first (no proprietary venture concept, customer /
interview identities, unpublished product or pricing names, internal
financials, or pasted internal documents); the pre-genericization value MUST
never leave the local host. The gate is bidirectional (Claude→Codex and
Codex→Claude alike). If the prompt cannot be genericized without losing the
question, confirm with the user or decline and answer locally. See
`core/skills/investigate/references/business-brief-spec.md` § Privacy Gate.

---

## Phase 0 — Argument parsing

Parse `$ARGUMENTS`:

- `--peer <claude|codex>` — REQUIRED. On Claude side `claude` is forbidden
  (no self-dispatch).
- `--prompt-text "..."` OR `--prompt-file <path>` — REQUIRED, exactly one.
  Either form is
  forwarded as `prompt.xml`, a file Phase 1 writes with the file-writing
  tool: neither the text nor the path is put on a command line.

Reject with a one-line usage hint and stop on: `--peer` missing / invalid /
self; neither or both prompt flags; an unreadable `--prompt-file`. Then run
the privacy gate above before dispatching.

---

## Phase 1 — Dispatch verbatim with operational tracking

<!-- pipeline:begin peer-now-dispatch -->
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

```bash
TEXT_DIR='<directory from step 1>'
PEER='<claude|codex, from --peer>'
ROOT_OVERRIDE="$(printenv 'AGENTIC_FOUNDER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'founder' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
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
# The runner's exit status is this block's own (R4 J3): a failed consultation
# stops here, where the agent sees it, and the [Peer] note step refuses it too.
[ "$RUN_RC" -eq 0 ] || { echo "✗ peer-now run $RUN_ID failed (exit $RUN_RC${ERROR_KIND:+, $ERROR_KIND}); $RUN_ERR${STDERR_PATH:+ and $STDERR_PATH} say why. No note is appended for it." >&2; exit "$RUN_RC"; }
```
<!-- pipeline:end peer-now-dispatch -->

The dispatch is **synchronous** — `peer-runner.mjs run` blocks until the
peer responds, and the response is read from `$STDOUT_PATH` immediately
after. Do NOT background the Bash call: peer-now is a side-channel that
returns the raw answer now (unlike the verb-skill ensembles, which background
the peer so local analysis proceeds in parallel). Exit codes (per
`companions/contract.md` §5.1): 0 success; 1 `peer_run_error`; 2
`companion_misuse`; 3 peer CLI infrastructure failure. On `RUN_RC != 0`,
surface the first `$RUN_ERR` line + exit code + run id; do not append a note.

---

## Phase 2 — Optional `[Peer]` label injection

<!-- pipeline:begin peer-now-locate -->
```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_FOUNDER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'founder' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT" 2>/tmp/'founder'-peer-now-find.err)"
FIND_RC=$?
```
<!-- pipeline:end peer-now-locate -->

- **Empty** → standalone: print the response from `$STDOUT_PATH`; no state
  mutation.
- **Single path** → append a `[Peer]` note (cap the excerpt at `head -c 4000
  "$STDOUT_PATH"`, include `run_id`), no phase mutation, with the block below.
- **Per-branch duplicate error** → reject with a hint pointing at
  `/founder:resume`.

<!-- pipeline:begin peer-now-note -->
Run it with `DISPATCH_DIR` set to the directory the dispatch ran with (Phase
1's step 1): in a fresh shell, it reads the run from the result the runner
wrote there, `prompt.xml.run.json`, and from the run's handle, and finds the
workflow again, carrying nothing from Phase 1.

```bash
DISPATCH_DIR='<the directory the dispatch ran with>'
ROOT_OVERRIDE="$(printenv 'AGENTIC_FOUNDER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'founder' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PERSONA='founder'
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch; nothing was written." >&2; exit 1; }
# One field of a JSON file, a non-empty string; anything else fails.
FIELD='let r;try{r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))}catch{process.exit(1)}const v=r&&r[process.argv[2]];if(typeof v!=="string"||v==="")process.exit(1);process.stdout.write(v)'
RUN_JSON="$DISPATCH_DIR/prompt.xml.run.json"
# Only a consultation that succeeded gets a note: the runner's own result says
# so (ok true), read here, never the dispatch shell's exit status (R4 J3).
FAILED="$(node -e 'let r;try{r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))}catch{process.exit(1)}if(r===null||typeof r!=="object")process.exit(1);if(r.ok===true)process.exit(0);process.stdout.write(String(r.error_kind||r.status||"not ok"));process.exit(2)' "$RUN_JSON")"
case $? in
  0) ;;
  2) echo "✗ The run in DISPATCH_DIR ($DISPATCH_DIR) did not succeed ($FAILED; prompt.xml.err there says why); no note is appended for a failed consultation." >&2; exit 1 ;;
  *) echo "✗ The run's result in DISPATCH_DIR ($DISPATCH_DIR) is missing or unreadable; nothing was written." >&2; exit 1 ;;
esac
RUN_ID="$(node -e "$FIELD" "$RUN_JSON" run_id)" \
  && HANDLE_PATH="$(node -e "$FIELD" "$RUN_JSON" handle_path)" \
  && STDOUT_PATH="$(node -e "$FIELD" "$RUN_JSON" stdout_path)" \
  && PEER="$(node -e "$FIELD" "$HANDLE_PATH" peer_host)" \
  || { echo "✗ The run's result in DISPATCH_DIR ($DISPATCH_DIR), or its handle, is missing or unreadable; nothing was written." >&2; exit 1; }
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase-label "[Peer] $PEER consultation" \
  --phase-note "peer: $PEER
run_id: $RUN_ID
handle: $HANDLE_PATH
prompt-mode: verbatim

### Response

$(head -c 4000 "$STDOUT_PATH")" \
  --event updated
```
<!-- pipeline:end peer-now-note -->

---

## Completion

- `✓ Peer consultation recorded under [Peer] <peer> consultation in <path> (run_id=<id>).` (+ response).
- `✓ Peer consultation completed (standalone, run_id=<id>).` (+ response).
- `✗ Peer dispatch failed (run_id=<id>, exit <RC>): <first stderr line>.`
- `✗ Privacy gate not cleared — prompt not dispatched.`
- `✗ <usage hint>` — Phase 0 rejected.

The peer response is printed verbatim — no synthesis or `AGREED / PEER-ONLY
/ CONFLICT` structuring (that is a verb-level concern).
