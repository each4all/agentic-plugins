---
description: Ad-hoc peer consultation for a macro workflow — dispatch a verbatim prompt to claude or codex outside Plan-verify
argument-hint: --peer <claude|codex> (--prompt-text "..." | --prompt-file <path>)
---

# Orchestrator · Peer-Now

$ARGUMENTS

`/orchestrator:peer-now` is a side-channel meta command. It dispatches
a verbatim prompt through `scripts/peer-runner.mjs run --kind
peer-now` and records a `[Peer]` phase note on the active macro
workflow when one exists. It is not Plan-verify and it never writes
`pending_ensemble` or `ensemble_results`.
The workflow and peer-run namespace is `.agentic-plugins/state/orchestrator/`
for new repos; legacy `.claude/agentic-orchestrator/` state remains active
until explicit migration.

**Cognitive runbook lives in
`${CLAUDE_PLUGIN_ROOT}/core/skills/peer-now/SKILL.md`**. The skill contains
the host-availability matrix, prompt guidance, and status/cancel
controls.

---

## Phase 0 — Argument parsing

Required:

- `--peer claude|codex`
- Exactly one of `--prompt-text "..."` or `--prompt-file <path>`

Reject missing peer, invalid peer, both prompt forms, no prompt form,
or unreadable prompt file. Do not self-dispatch.

The prompt reaches the runner as a file, never as shell source (ADR-0059,
amendment of 2026-10-10): a prompt or a path spliced into a block is cut at
`;`, expanded at `$(…)` and run at a backtick.

1. Create a private directory, and note the path it prints:

   ```bash
   # Step 1: a private text directory, marked so that the step that reads it
   # last releases it (ADR-0059 Decisions 9 and 10).
   CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
   [ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
   MAKE_KIND='text'
   MAKE_PARENT=''
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
   printf '%s\n' "$MADE_DIR"
   ```

2. With your file-writing tool (Claude: the Write tool), not the shell, write
   one file in that directory: for `--prompt-text`, `prompt.xml` holding the
   prompt exactly as given; for `--prompt-file <path>`, `prompt-path.txt`
   holding that path, as given, on one line. The runner then reads the
   prompt from the user's file itself, byte for byte.

The runner sends the prompt as written, opened by the evidence boundary
when it does not already open with it (C163 D2a;
`scripts/lib/evidence-boundary.mjs`): the peer takes the request as its task
and anything the request quotes or points to as data, never as instructions.
The block is the runner's to add; the prompt you write needs none.

Phase 1's block reads it from there: put the path in its `TEXT_DIR` line, and
`claude` or `codex` in its `PEER` line. It writes the run id, the peer and the
run's result there itself (`run-id`, `peer`, `run.json`, `run.err`), which the
status and cancel controls and Phase 2 read, each in a shell of its own, and
Phase 2's lookup writes the macro it found (`macro-path`), which the note
block reads. Phase 2's last block, the note or the standalone response,
releases the directory once it succeeded (ADR-0059 Decision 10); a block that
stops keeps it, for its rerun or for the files its message names. No block
runs `rm` (a headless run can deny it).

---

## Phase 1 — Dispatch with operational tracking

The peer, claude or codex, answers from a snapshot of the checkout,
removed when the run ends (C96, C163 D2b): a file it writes is discarded
with it. Ask it for an
answer, not for files.

```bash
TEXT_DIR='<directory from step 1>'
PEER='<claude|codex>'
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
# The prompt: the file prompt-path.txt names (--prompt-file), read by the
# runner, or the prompt.xml written for --prompt-text. The path is data cat
# read, never shell source.
PROMPT_FILE="$TEXT_DIR/prompt.xml"
if [ -f "$TEXT_DIR/prompt-path.txt" ]; then PROMPT_FILE="$(cat "$TEXT_DIR/prompt-path.txt")"; fi
[ -s "$PROMPT_FILE" ] || { echo "✗ The prompt file ($PROMPT_FILE) is missing or empty; nothing was dispatched." >&2; exit 1; }
# The run id, allocated by the runner (C119, C26): no shell arithmetic or
# hand-written date makes it. An allocation that prints nothing stops the
# block too.
RUN_ID="$(node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" new-run-id --prefix peer-now)" || RUN_ID=''
[ -n "$RUN_ID" ] || { echo "✗ peer-runner.mjs new-run-id allocated no run id (its error, if any, is above); nothing was dispatched." >&2; exit 1; }
# For the controls below and Phase 2, which may each run in a fresh shell: the
# run id before the dispatch, so a run that hangs can be named; the run's
# result beside it.
printf '%s' "$RUN_ID" > "$TEXT_DIR/run-id" || exit 1
printf '%s' "$PEER" > "$TEXT_DIR/peer" || exit 1
RUN_JSON="$TEXT_DIR/run.json"
RUN_ERR="$TEXT_DIR/run.err"

node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" run \
  --repo-root "$REPO_ROOT" \
  --run-id "$RUN_ID" \
  --kind peer-now \
  --peer "$PEER" --prompt-file "$PROMPT_FILE" \
  --output-format text \
  --host "${AGENTIC_HOST:-claude}" \
  --cwd "$REPO_ROOT" \
  > "$RUN_JSON" 2> "$RUN_ERR"
RUN_RC=$?
if [ "$RUN_RC" -ne 0 ]; then
  echo "✗ Peer dispatch failed (run_id=$RUN_ID, exit $RUN_RC): see $RUN_ERR and $RUN_JSON." >&2
  exit "$RUN_RC"
fi
```

Status/cancel controls, for a run that is still going (the run id is the one
Phase 1 wrote before it dispatched):

```bash
TEXT_DIR='<directory from step 1>'
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
RUN_ID="$(cat "$TEXT_DIR/run-id")" || exit 1
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" status \
  --repo-root "$REPO_ROOT" --run-id "$RUN_ID" --json
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" cancel \
  --repo-root "$REPO_ROOT" --run-id "$RUN_ID"
```

On non-zero exit, surface the first useful stderr/error line, include
`run_id`, and stop without mutating workflow state.

---

## Phase 2 — Optional `[Peer]` macro note

Locate the active macro. The block prints its path, or nothing, and writes the
same to `macro-path`: the note block reads it there, so a branch switched
between the two blocks cannot point the note at another macro.

```bash
TEXT_DIR='<directory from step 1>'
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit 1
printf '%s' "$ACTIVE" > "$TEXT_DIR/macro-path" || exit 1
printf '%s\n' "$ACTIVE"
```

- **No active macro** (it printed nothing) -> print the peer response only,
  with this block: it prints the response of a run that succeeded, then
  releases the directory, which nothing reads again.

  ```bash
  TEXT_DIR='<directory from step 1>'
  CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
  [ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
  # The response of a run whose own result says it succeeded (ok true) and
  # names its response file; the run id, for the completion line.
  STANDALONE_OUT="$(node -e 'let r;try{r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))}catch{process.exit(1)}if(r===null||typeof r!=="object"||r.ok!==true||typeof r.stdout_path!=="string"||r.stdout_path==="")process.exit(1);process.stdout.write(r.stdout_path)' "$TEXT_DIR/run.json")" \
    || { echo "✗ The run's result ($TEXT_DIR/run.json) is missing or unreadable, says the run did not succeed, or names no response file ($TEXT_DIR/run.err says why); the directory is kept." >&2; exit 1; }
  cat "$STANDALONE_OUT" || exit 1
  printf 'run_id: %s\n' "$(cat "$TEXT_DIR/run-id")" >&2
  # ADR-0059 Decision 10, item 1 — the response is printed: no block, rerun or
  # continuation reads the directory again.
  RELEASE_PATH="$TEXT_DIR"
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
  ```

- **Single active macro** -> append a phase note without changing
  phase or next action. The block reads the macro the lookup found and the
  run from what Phase 1 wrote:

  ```bash
  TEXT_DIR='<directory from step 1>'
  CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
  [ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
  # The macro the lookup found, not the one this branch names now.
  ACTIVE="$(cat "$TEXT_DIR/macro-path")" || { echo "✗ The lookup writes the macro it found to $TEXT_DIR/macro-path: run it first; nothing was recorded." >&2; exit 1; }
  [ -n "$ACTIVE" ] || { echo "✗ The lookup found no active macro: print the response alone; nothing was recorded." >&2; exit 1; }
  PEER="$(cat "$TEXT_DIR/peer")" || exit 1
  RUN_ID="$(cat "$TEXT_DIR/run-id")" || exit 1
  # The run's paths, as the runner printed them; a result that does not parse
  # fails here (C68).
  JSON_FIELD='let d="";process.stdin.setEncoding("utf8").on("data",c=>d+=c).on("end",()=>{const v=JSON.parse(d)[process.env.JSON_KEY];process.stdout.write(v==null?"":String(v))})'
  HANDLE_PATH="$(JSON_KEY=handle_path node -e "$JSON_FIELD" < "$TEXT_DIR/run.json")" || exit 1
  STDOUT_PATH="$(JSON_KEY=stdout_path node -e "$JSON_FIELD" < "$TEXT_DIR/run.json")" || exit 1
  # Only a run whose own result says it succeeded (ok true) gets a note.
  RUN_OK="$(JSON_KEY=ok node -e "$JSON_FIELD" < "$TEXT_DIR/run.json")" || exit 1
  [ "$RUN_OK" = true ] || { echo "✗ The run did not succeed ($TEXT_DIR/run.json, $TEXT_DIR/run.err says why); nothing was recorded, and the directory is kept." >&2; exit 1; }
  [ -n "$STDOUT_PATH" ] || { echo "✗ The run recorded no response file ($TEXT_DIR/run.json); nothing was recorded." >&2; exit 1; }
  # The note holds only values programs read or printed (the run's id and
  # paths, head's read of the response) and the peer enum, no text written
  # into this block: an expansion's result is not evaluated again (ADR-0059,
  # amendment of 2026-10-10).
  RESPONSE="$(head -c 4000 "$STDOUT_PATH")"
  NOTE="peer: $PEER
  run_id: $RUN_ID
  handle: $HANDLE_PATH
  prompt-mode: verbatim

  ### Response

  $RESPONSE
  "

  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
    --workflow-path "$ACTIVE" --host claude \
    --phase-label "[Peer] $PEER consultation" \
    --phase-note "$NOTE" \
    --event updated || exit $?
  # The whole response stays in the run ledger, where this path names it.
  printf 'response: %s\n' "$STDOUT_PATH"
  # ADR-0059 Decision 10, item 1 — the note is the consultation's last write:
  # no block, rerun or continuation reads the directory again.
  RELEASE_PATH="$TEXT_DIR"
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
  ```

- **Duplicate/corrupt branch state** -> reject and point at
  `/orchestrator:resume`.

The 4000-character note cap keeps the macro workflow readable; the
full response remains in the peer-run ledger until retention prunes it.

---

## Completion

- `✓ Peer consultation recorded under [Peer] <peer> consultation in <workflow path> (run_id=<id>).`
- `✓ Peer consultation completed (standalone — no active macro workflow, run_id=<id>).`
- `✗ Peer dispatch failed (run_id=<id>, exit <RC>): <reason>.`
- `✗ Per-branch duplicate detected — resolve via /orchestrator:resume.`

Print the peer response verbatim. Do not synthesize it into
AGREED/LOCAL-ONLY/PEER-ONLY/CONFLICT categories; that structure is
reserved for managed ensemble points like Plan-verify.
