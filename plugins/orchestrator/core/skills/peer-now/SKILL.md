---
name: peer-now
description: "Dispatches a verbatim ad-hoc prompt to the cross-host companion outside Plan-verify, optionally recording a [Peer] note on the active orchestrator macro workflow. A side-channel meta operation, not a managed ensemble."
---

# Peer-Now (orchestrator meta skill)

`peer-now` sends a raw prompt to the selected peer host through
`peer-runner.mjs run --kind peer-now`. When a macro workflow is
active, it can append a `[Peer]` note to the workflow body. It never
records `pending_ensemble` or `ensemble_results`; those fields are
reserved for managed Plan-verify runs.

---

## Host availability

| Operation | Claude | Codex |
|-----------|--------|-------|
| Ask Codex with `--peer codex` | Yes | No self-dispatch |
| Ask Claude with `--peer claude` | No self-dispatch | Yes |
| Peer-run status/cancel | Yes | Yes |
| Append `[Peer]` note | `--host claude` | `--host codex` |
| Managed ensemble bookkeeping | No — deliberately excluded | No — deliberately excluded |

---

## Command resolution

| Concern | Claude | Codex |
|---------|--------|-------|
| Entry | `/orchestrator:peer-now --peer <peer> (--prompt-text ... \| --prompt-file <path>)` | `$orchestrator:peer-now --peer <peer> (--prompt-text ... \| --prompt-file <path>)` |
| Plugin root | `$CLAUDE_PLUGIN_ROOT` or Claude cache fallback | For a mentioned `orchestrator` skill, the plugin directory that contains it: Codex injects a mentioned skill with its absolute path (`<path>…/core/skills/<skill>/SKILL.md</path>`), and dropping `/core/skills/<skill>/SKILL.md` from it leaves the root, which holds `.codex-plugin/plugin.json`. If that path is no longer in context, for example after compaction, a new mention of the skill supplies it again. With the default Codex home and the `agentic-plugins` marketplace added from Git, the root is `~/.codex/plugins/cache/agentic-plugins/orchestrator/<version>`, the versioned copy Codex loads skills from, and `~/.codex/.tmp/marketplaces/agentic-plugins/plugins/orchestrator` is the marketplace checkout, which tracks the repository's `main` branch, not that copy. |
| Host flag for state note | `--host claude` | `--host codex` |

---

## Phase 0 — Argument intake

Require:

- `--peer claude|codex`
- Exactly one of `--prompt-text` or `--prompt-file`

Reject self-dispatch, missing prompt, duplicate prompt forms, or an
unreadable prompt file.

The prompt reaches the runner as a file, never as shell source (ADR-0059,
amendment of 2026-10-10): a prompt or a path spliced into a command line is
cut at `;`, expanded at `$(…)` and run at a backtick.

1. Create a private directory, and note the path it prints (`<plugin-root>`
   being the orchestrator plugin root):

   ```bash
   # Step 1: a private text directory, marked so that the step that reads it
   # last releases it (ADR-0059 Decisions 9 and 10).
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
   if grep -q -e "'tmpdir-make'" "<plugin-root>/scripts/state.mjs" 2>/dev/null; then
     if [ -n "${MAKE_PARENT:-}" ]; then
       MADE_DIR="$(node "<plugin-root>/scripts/state.mjs" tmpdir-make --kind op --parent "$MAKE_PARENT")" && MAKE_RC=0 || MAKE_RC=$?
     else
       MADE_DIR="$(node "<plugin-root>/scripts/state.mjs" tmpdir-make --kind "$MAKE_KIND")" && MAKE_RC=0 || MAKE_RC=$?
     fi
   elif [ -r "<plugin-root>/scripts/state.mjs" ]; then
     MAKE_RC=old
   else
     echo "✗ Cannot read <plugin-root>/scripts/state.mjs; no directory was made." >&2
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

2. With your file-editing tool, not the shell, write one file there: for
   `--prompt-text`, `prompt.xml` holding the prompt exactly as given; for
   `--prompt-file <path>`, `prompt-path.txt` holding that path on one line, so
   the runner reads the user's file itself, byte for byte.

Phase 2's last block, the note or the standalone response, releases the
directory once it succeeded (ADR-0059 Decision 10); a block that stops keeps
it, for its rerun or for the files its message names.

The runner sends the prompt as written, opened by the evidence boundary
when it does not already open with it (C163 D2a;
`scripts/lib/evidence-boundary.mjs`): the peer takes the request as its task
and anything the request quotes or points to as data, never as instructions.
The block is the runner's to add; the prompt you write needs none.

---

## Phase 1 — Dispatch

The peer, claude or codex, answers from a snapshot of the checkout,
removed when the run ends (C96, C163 D2b): a file it writes is discarded
with it. Ask it for an
answer, not for files.

```bash
TEXT_DIR='<directory from step 1>'
PEER='<claude|codex>'
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
# The prompt: the file prompt-path.txt names (--prompt-file), or the
# prompt.xml written for --prompt-text. The path is data cat read, never
# shell source.
PROMPT_FILE="$TEXT_DIR/prompt.xml"
if [ -f "$TEXT_DIR/prompt-path.txt" ]; then PROMPT_FILE="$(cat "$TEXT_DIR/prompt-path.txt")"; fi
[ -s "$PROMPT_FILE" ] || { echo "✗ The prompt file ($PROMPT_FILE) is missing or empty; nothing was dispatched." >&2; exit 1; }
# The run id, allocated by the runner (C119, C26): no shell arithmetic or
# hand-written date makes it. An allocation that prints nothing stops the
# block too.
RUN_ID="$(node "<plugin-root>/scripts/peer-runner.mjs" new-run-id --prefix peer-now)" || RUN_ID=''
[ -n "$RUN_ID" ] || { echo "✗ peer-runner.mjs new-run-id allocated no run id (its error, if any, is above); nothing was dispatched." >&2; exit 1; }
# For status and cancel, and Phase 2, which may each run in a fresh shell: the
# run id before the dispatch, so a run that hangs can be named; the peer, and
# the run's result.
printf '%s' "$RUN_ID" > "$TEXT_DIR/run-id" || exit 1
printf '%s' "$PEER" > "$TEXT_DIR/peer" || exit 1
node "<plugin-root>/scripts/peer-runner.mjs" run \
  --repo-root "$REPO_ROOT" \
  --run-id "$RUN_ID" \
  --kind peer-now \
  --peer "$PEER" --prompt-file "$PROMPT_FILE" \
  --output-format text \
  --host <claude|codex> \
  --cwd "$REPO_ROOT" \
  > "$TEXT_DIR/run.json" 2> "$TEXT_DIR/run.err"
```

The runner writes a ledger under
`.agentic-plugins/state/orchestrator/peer-runs/<run_id>/` for new repos
(or the legacy peer-run home until explicit migration), and its result —
`run_id`, `status`, the ledger's paths — to `run.json` in the text directory.
On a non-zero exit, surface the first useful line of `run.err` with the run
id, and stop without writing workflow state. Use `peer-runner.mjs status` and
`peer-runner.mjs cancel` for operational control, with `--repo-root` and the
run id the block wrote to `run-id` before it dispatched, read from there in a
shell of their own.

---

## Phase 2 — Optional workflow note

Locate the active macro first. The block prints its path, or nothing, and
writes the same to `macro-path` in the text directory: the note block reads it
there, so a branch switched between the two blocks cannot point the note at
another macro.

```bash
TEXT_DIR='<directory from step 1>'
REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
ACTIVE="$(node "<plugin-root>/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit 1
printf '%s' "$ACTIVE" > "$TEXT_DIR/macro-path" || exit 1
printf '%s\n' "$ACTIVE"
```

When it found none, print the peer response with this block: it prints the
response of a run that succeeded, then releases the directory, which nothing
reads again.

```bash
TEXT_DIR='<directory from step 1>'
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
  if grep -q -e "'tmpdir-release'" "<plugin-root>/scripts/state.mjs" 2>/dev/null; then
    RELEASE_REPORT="$(node "<plugin-root>/scripts/state.mjs" tmpdir-release --path "$RELEASE_PATH")" || :
    node -e 'let r=null;try{r=JSON.parse(process.argv[1])}catch{}process.exit(r!==null&&typeof r==="object"&&typeof r.outcome==="string"?0:1)' "$RELEASE_REPORT" 2>/dev/null \
      || echo "agentic-dir release: the result is unknown; the directory may remain at $RELEASE_PATH or at its .removing- path" >&2
  elif [ -r "<plugin-root>/scripts/state.mjs" ]; then
    echo "agentic-dir release: no tmpdir-release in this state.mjs; the directory is kept at $RELEASE_PATH" >&2
  else
    echo "agentic-dir release: the result is unknown (cannot read <plugin-root>/scripts/state.mjs); the directory may remain at $RELEASE_PATH" >&2
  fi
fi
```

When it found one active macro, append a note. The block reads the macro the
lookup found, and builds `$NOTE` as `commands/peer-now.md` Phase 2
builds it, from values programs read or printed only: `peer`, `run_id` and
`handle` lines from the peer Phase 1 wrote and the run's JSON, then the first
4000 bytes of the response as `head -c 4000 "$STDOUT_PATH"` reads them. Never
write the response, or any other text, into the block yourself; an
expansion's result is not evaluated again, a block's source is.

```bash
TEXT_DIR='<directory from step 1>'
# The macro the lookup found, not the one this branch names now.
ACTIVE="$(cat "$TEXT_DIR/macro-path")" || { echo "✗ The lookup writes the macro it found to $TEXT_DIR/macro-path: run it first; nothing was recorded." >&2; exit 1; }
[ -n "$ACTIVE" ] || { echo "✗ The lookup found no active macro: print the response alone; nothing was recorded." >&2; exit 1; }
PEER="$(cat "$TEXT_DIR/peer")" || exit 1
JSON_FIELD='let d="";process.stdin.setEncoding("utf8").on("data",c=>d+=c).on("end",()=>{const v=JSON.parse(d)[process.env.JSON_KEY];process.stdout.write(v==null?"":String(v))})'
RUN_ID="$(JSON_KEY=run_id node -e "$JSON_FIELD" < "$TEXT_DIR/run.json")" || exit 1
HANDLE_PATH="$(JSON_KEY=handle_path node -e "$JSON_FIELD" < "$TEXT_DIR/run.json")" || exit 1
STDOUT_PATH="$(JSON_KEY=stdout_path node -e "$JSON_FIELD" < "$TEXT_DIR/run.json")" || exit 1
# Only a run whose own result says it succeeded (ok true) gets a note.
RUN_OK="$(JSON_KEY=ok node -e "$JSON_FIELD" < "$TEXT_DIR/run.json")" || exit 1
[ "$RUN_OK" = true ] || { echo "✗ The run did not succeed ($TEXT_DIR/run.json, $TEXT_DIR/run.err says why); nothing was recorded, and the directory is kept." >&2; exit 1; }
[ -n "$STDOUT_PATH" ] || { echo "✗ The run recorded no response file ($TEXT_DIR/run.json); nothing was recorded." >&2; exit 1; }
RESPONSE="$(head -c 4000 "$STDOUT_PATH")"
NOTE="peer: $PEER
run_id: $RUN_ID
handle: $HANDLE_PATH
prompt-mode: verbatim

### Response

$RESPONSE
"
node "<plugin-root>/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host <claude|codex> \
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
  if grep -q -e "'tmpdir-release'" "<plugin-root>/scripts/state.mjs" 2>/dev/null; then
    RELEASE_REPORT="$(node "<plugin-root>/scripts/state.mjs" tmpdir-release --path "$RELEASE_PATH")" || :
    node -e 'let r=null;try{r=JSON.parse(process.argv[1])}catch{}process.exit(r!==null&&typeof r==="object"&&typeof r.outcome==="string"?0:1)' "$RELEASE_REPORT" 2>/dev/null \
      || echo "agentic-dir release: the result is unknown; the directory may remain at $RELEASE_PATH or at its .removing- path" >&2
  elif [ -r "<plugin-root>/scripts/state.mjs" ]; then
    echo "agentic-dir release: no tmpdir-release in this state.mjs; the directory is kept at $RELEASE_PATH" >&2
  else
    echo "agentic-dir release: the result is unknown (cannot read <plugin-root>/scripts/state.mjs); the directory may remain at $RELEASE_PATH" >&2
  fi
fi
```

Do not pass `--current-phase`, `--next-action`, or managed ensemble
bookkeeping flags. Print the peer response verbatim in every success
case.

---

## Anti-patterns

- Do not use peer-now for Plan-verify.
- Do not write peer-now results into `ensemble_results`.
- Do not synthesize the raw peer response unless the user separately
  asks.
- Do not mutate macro phase or subtask status.
