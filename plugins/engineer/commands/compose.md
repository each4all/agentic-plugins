---
description: Produce the artifact — plan, code, brief, interface, prompt, spec — engineer's composition verb
argument-hint: --profile=plan|code | (or natural-language composition target)
---

# Engineer · Compose

$ARGUMENTS

Maintain one progress entry per phase and advance its status as you go — use the host's task-tracking tools when the session exposes them, and keep an inline checklist when it does not. The peer ensemble
runs automatically per
`core/skills/_shared/references/ensemble-protocol.md` (Plan-verify point
type — applies to both `plan` and `code` profiles per the section's
generalized intro). Never ask the user whether to invoke the peer.
When the companions plugin or peer CLI is unavailable, the ensemble
degrades silently to local-only.

<!-- pipeline:begin plugin-root -->
Plugin root: each shell block below opens by setting `$CLAUDE_PLUGIN_ROOT` —
from `AGENTIC_ENGINEER_ROOT` when that is set, else from the plugin path
Claude Code writes into this command when it loads it, else from the newest
version in the plugin cache. Keep those opening lines when you run a block: a
shell variable does not outlive a Bash call.
<!-- pipeline:end plugin-root -->

The orchestrator's autopilot driver reads this runbook to check that the
installed engineer honors `AGENTIC_ENGINEER_ROOT`: it looks for the
`${AGENTIC_ENGINEER_ROOT:-…}` spelling the blocks used before they were
generated, which now read the variable with `printenv`. Keep this sentence
while any orchestrator release an owner may still run, or roll back to,
probes for that spelling: first ship a probe that accepts the generated
form, then drop the sentence.

---

## Phase 0 — Workflow continuity (per ADR-0011 §5)

<!-- pipeline:begin compose-phase-0 -->
```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PERSONA='engineer'
REPO_ROOT="$(git rev-parse --show-toplevel)"
GIT_BRANCH="$(git branch --show-current)"
# ADR-0018 §sub-2 — the persona's workflows are anchored to a branch.
if [ -z "$GIT_BRANCH" ]; then
  echo "✗ Detached HEAD detected — ${PERSONA} workflows are anchored to a branch (ADR-0018 §sub-2)." >&2
  echo "  Switch to a branch first: git switch <branch>" >&2
  exit 1
fi
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
  find-active --repo-root "$REPO_ROOT")"
FIND_RC=$?
if [ "$FIND_RC" -ne 0 ]; then
  echo "✗ find-active failed (exit $FIND_RC); its error is above." >&2
  exit "$FIND_RC"
fi
# ADR-0063 D4 — prints nothing in interactive mode. Under an autopilot run it
# prints the rules this command then follows
# (core/skills/_shared/references/autopilot-mode.md), and refuses when an owner
# gate is set on the workflow; interactively it prints a pending gate for the
# user. It runs before any write, so a refusal leaves the workflow as it was.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" autopilot-preflight \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" || exit $?
```
<!-- pipeline:end compose-phase-0 -->

Empty `$ACTIVE` → bootstrap with verb=compose:

<!-- pipeline:begin compose-bootstrap -->
In the block, replace the profile placeholder with the profile the arguments
name; `AGENTIC_PROFILE` takes its place when it is set.

The request reaches `state.mjs` as a file, never in the block: in shell
source a quote, `$`, backtick or line break of it would be read as code
(ADR-0059, amendment of 2026-10-10). Before the block:

1. Create a private directory for it, and note the path it prints:

   ```bash
   mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"
   ```

2. With your file-writing tool, not the shell, create `request.txt` in that
   directory holding a one-line scrubbed user request, ending with one newline.
   Nothing deletes it.

Then run the block with `TEXT_DIR` set to that directory; a request file left
unwritten stops it before any write. When `AGENTIC_TOPIC` is set (a dispatched
run), the block writes it to a file of its own and records that instead, and
steps 1–2 are not needed.

The block prints `OP_DIR=<path>`, this command's operation directory: when
the workflow is a macro's child, its write opens the command's persona
operation there (ADR-0068 Decision 2, item 7). Keep the path for the finalize
block's `OP_DIR`.

```bash
TEXT_DIR='<directory from step 1>'
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
VERB='compose'
DEFAULT_PROFILE='plan'
# A fresh shell: nothing is carried from the Phase 0 block.
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
GIT_BRANCH="$(git branch --show-current)"
GIT_HEAD="$(git rev-parse HEAD)"
STATUS_DIGEST="$(git status --porcelain=v1 -z --untracked-files=normal | shasum -a 256 | cut -d' ' -f1)"
# ADR-0019 §1+§3 — when /orchestrator:next dispatches this command,
# it sets AGENTIC_PARENT_WORKFLOW + AGENTIC_ORIGINATING_SUBTASK so
# the create-time bootstrap records the immutable parent linkage.
# Both must be set together (or both absent for direct invocation).
# ADR-0067 Decision 3 — it also sets AGENTIC_PARENT_WORKFLOW_PATH, the
# macro file's absolute path, recorded beside them; an older orchestrator
# sets none. The path is valid only with both ids.
# ADR-0067 Decision 4, item 5 — and AGENTIC_DISPATCH_SELECTION, the selection
# its Phase 1 made (JSON: subtask, branch, verb, profile, topic), recorded
# beside them for every later binding to compare; also valid only with both.
PARENT_ARGS=()
if [ -n "${AGENTIC_PARENT_WORKFLOW:-}" ] || [ -n "${AGENTIC_ORIGINATING_SUBTASK:-}" ]; then
  if [ -z "${AGENTIC_PARENT_WORKFLOW:-}" ] || [ -z "${AGENTIC_ORIGINATING_SUBTASK:-}" ]; then
    echo "✗ AGENTIC_PARENT_WORKFLOW and AGENTIC_ORIGINATING_SUBTASK must be set together (ADR-0019 §3 immutable parent-child linkage). This usually indicates a dispatcher bug — /orchestrator:next must export both env vars or neither. If you set them manually, set both or neither." >&2
    exit 1
  fi
  PARENT_ARGS=(--parent-workflow "$AGENTIC_PARENT_WORKFLOW" --originating-subtask "$AGENTIC_ORIGINATING_SUBTASK")
  if [ -n "${AGENTIC_PARENT_WORKFLOW_PATH:-}" ]; then
    PARENT_ARGS+=(--parent-workflow-path "$AGENTIC_PARENT_WORKFLOW_PATH")
  fi
  if [ -n "${AGENTIC_DISPATCH_SELECTION:-}" ]; then
    PARENT_ARGS+=(--dispatch-selection "$AGENTIC_DISPATCH_SELECTION")
  fi
elif [ -n "${AGENTIC_PARENT_WORKFLOW_PATH:-}" ]; then
  echo "✗ AGENTIC_PARENT_WORKFLOW_PATH is set without AGENTIC_PARENT_WORKFLOW and AGENTIC_ORIGINATING_SUBTASK (ADR-0067 Decision 3: the macro path is valid only with both ids). This usually indicates a dispatcher bug, or a variable left over from another session; unset it, or set all three." >&2
  exit 1
elif [ -n "${AGENTIC_DISPATCH_SELECTION:-}" ]; then
  echo "✗ AGENTIC_DISPATCH_SELECTION is set without AGENTIC_PARENT_WORKFLOW and AGENTIC_ORIGINATING_SUBTASK (ADR-0067 Decision 4, item 5: the dispatch selection is valid only with both ids). This usually indicates a dispatcher bug, or a variable left over from another session; unset it, or set all three." >&2
  exit 1
fi
# The request, as a file (ADR-0059, amendment of 2026-10-10): the one the
# agent wrote, or the AGENTIC_TOPIC a dispatcher exports, which is program data
# the block writes to a private directory of its own, so no text flag is
# inline and a dispatched run needs no file of the agent's.
REQUEST_FILE="$TEXT_DIR/request.txt"
if [ -n "${AGENTIC_TOPIC:-}" ]; then
  REQUEST_FILE="$(mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX")/topic.txt" || exit 1
  printf '%s\n' "$AGENTIC_TOPIC" > "$REQUEST_FILE" || exit 1
fi
grep -q '[^[:space:]]' "$REQUEST_FILE" 2>/dev/null || { echo "✗ request.txt in TEXT_DIR ($TEXT_DIR) is missing or blank; write it with the file tool first. Nothing was written." >&2; exit 1; }
# ADR-0068 Decision 2, item 7 — this command's operation directory: the
# create opens the command's persona operation there when it creates a
# macro's child, and the finalize block's last write closes it.
OP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agentic-op.XXXXXX")" || exit 1
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" create \
  --repo-root "$REPO_ROOT" \
  --verb 'compose' --host "${AGENTIC_HOST:-claude}" --persona 'engineer' \
  --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
  --status-digest "$STATUS_DIGEST" \
  --profile "${AGENTIC_PROFILE:-<profile from the arguments above — default ${DEFAULT_PROFILE}>}" \
  --original-request-file "$REQUEST_FILE" \
  --current-phase phase-0-bootstrap \
  --next-action "Run ${VERB} skill" \
  --operation-dir "$OP_DIR" \
  "${PARENT_ARGS[@]}")" || exit $?
echo "OP_DIR=$OP_DIR"
```
<!-- pipeline:end compose-bootstrap -->

Non-empty `$ACTIVE` → append-on-resume:

<!-- pipeline:begin compose-resume -->
The block prints `OP_DIR=<path>`, this command's operation directory: when
the workflow is a macro's child, its write opens the command's persona
operation there (ADR-0068 Decision 2, item 7). Keep the path for the finalize
block's `OP_DIR`.

After the append, the block prints the results of the checks a verification
step ran for this workflow (ADR-0068 Decision 5), and nothing when it holds no
request: the latest batch, each check's outcome, whether it is evidence (it
ran to its end on an unchanged tree) and whether it applies to the tree now,
its failing tests and its log. Read them before you act: a failing test named
there is the evidence to work from, and a check with no evidence (a timeout,
one cut short or never reached) says nothing about the code. A read that fails
prints a warning and the verb goes on without them.

```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# A fresh shell: the workflow is found again here, never carried from an
# earlier block.
PERSONA='engineer'
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch." >&2; exit 1; }
VERB='compose'
# ADR-0068 Decision 2, item 7 — this command's operation directory: this
# first write opens the command's persona operation there when the workflow
# is a macro's child, and the finalize block's last write closes it.
OP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agentic-op.XXXXXX")" || exit 1
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --verb 'compose' \
  --operation-dir "$OP_DIR" --open-operation verb \
  --profile "<profile or empty>" \
  --phase-label "Phase 0: Resume into ${VERB}" \
  --phase-note "Resumed from prior verb. Profile=<...>." \
  --current-phase phase-0-resume \
  --clear-next-step true \
  --next-action "Run ${VERB} skill" --event resumed || exit $?
echo "OP_DIR=$OP_DIR"
# ADR-0068 Decision 5 — the results a verification step recorded, read
# against the tree as it is now; nothing when the workflow holds no request.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" verify-results \
  --workflow-path "$ACTIVE" --current-tree true --format text \
  || echo "⚠ The verification results could not be read (the error is above); ${VERB} goes on without them." >&2
```
<!-- pipeline:end compose-resume -->

---

## Phase 1 — Execute compose

Follow the compose skill's command-invoked mode at
`${CLAUDE_PLUGIN_ROOT}/core/skills/compose/SKILL.md`. Profiles:

- `plan` (default) — produce a TDD task list with dependencies and
  success criteria.
- `code` — write the actual implementation files; run the quick tests
  in the step, and the long ones as § Long checks below says.

Profile selection: `--profile=<name>` on the command, else inferred
from the user's intent. Missing profile → `plan`. Unknown profile →
fallback to `plan` with one-line warning.

Core principle: a plan precedes code. Code without a confirmed plan
is speculation; code with a plan is verifiable task-by-task.

For `code` profile in command-mode (an active workflow on this branch),
the skill's **Layer 2 commit-manifest recording** step requires
`state.mjs record-composed-file --workflow-path <the active workflow>
--path <p> --op create|edit` after each Write/Edit on a tracked path; its
snippet finds the workflow itself in each shell. See
`core/skills/compose/SKILL.md` § Layer 2 commit-manifest recording for the
full pattern (ADR-0028 §Layer-2).

<!-- pipeline:begin compose-long-checks -->
### Long checks (ADR-0068 Decision 5)

Sort the checks a change needs by the work they are expected to take:

- **Quick:** a few test files the change touches, expected to finish within
  minutes. Run them in the step, as always, and get them green first.
- **Long:** the whole test suite, a broad `npm test` (a directory, a glob,
  many files), any test file known to run long, and every mutation run
  (`npm run mutate`, and `npm run mutate:static` over every spec).

Where a long check runs depends on the session:

- **Under an autopilot run that offers verification** (Phase 0's preflight
  banner ends `This run offers verification`): run no long check in the
  step, and never wait for the heavy-work lock there — a wait on a lock is
  quiet and idle, which the driver judges stalled. Hand the long checks to the driver instead, with the finalize's
  verify form (`verify-request.json`): it runs them with no LLM after the step
  ends, and the step that follows reads their results, which Phase 0 prints.
  Failing tests named there are the evidence to work from; a check that ended
  with no evidence (a timeout, one cut short or never reached) says nothing
  about the code. Recording the same checks again on an unchanged tree, after
  they passed or one failed, halts the lane `no-progress`: change the code
  first (the owner reruns a flaky check with `--next verify`).
- **Under an autopilot run that does not offer it** (the banner ends `This
  run does not offer verification`): in the step, as before.
- **Interactively:** run a long check under the repository's heavy-work lock,
  so it does not run beside another session's heavy work:
  `agentic-autopilot heavy -- <command>` (or `node <orchestrator plugin
  root>/adapters/claude/autopilot/cli.mjs heavy -- <command>`). A command that
  takes the lock itself, as the mutation harness does (`locks_itself` in
  `.agentic-plugins/verify-checks.json`), runs directly: the wrapper refuses
  it. With no orchestrator installed, run the check directly.
<!-- pipeline:end compose-long-checks -->

### Ensemble dispatch (Plan-verify point type)

Build the Plan-verify prompt per
`core/skills/_shared/references/ensemble-protocol.md` § Plan-verify (compose
phase), reusing the same template for the `code` profile with the diff or
the list of written files in place of the draft plan:

Run this block **as a host background task** — on Claude, the Bash tool's
`run_in_background` — never with a trailing `&`: the host then tracks the
task and notifies you when the runner exits (ADR-0063 D5; a shell `&` would
detach the runner where neither you nor an autopilot host can wait for it).

<!-- pipeline:begin compose-dispatch -->
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

Then run the block with `TEXT_DIR` set to that directory; a prompt left
unwritten stops it before the dispatch. Keep the directory: the runner writes
its result there, `prompt.xml.run.json`, and the finalize block reads the run's
id from that file (its `DISPATCH_DIR`), never from this block's shell.

```bash
TEXT_DIR='<directory from step 1>'
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
ENSEMBLE_TYPE='plan-verify'
# A fresh shell: the workflow is found again here, never carried from an
# earlier block.
PERSONA='engineer'
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
# Run this block as a host background task (on Claude, the Bash tool's
# run_in_background), never with a trailing `&`: the host tracks the runner
# and notifies you when it exits, where a shell `&` would detach it from both.
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" run \
  --repo-root "$REPO_ROOT" --kind ensemble \
  --peer codex --prompt-file "$PROMPT_FILE" --output-format json \
  --workflow-path "$ACTIVE" --phase 'compose' \
  --host "${AGENTIC_HOST:-claude}" --cwd "$REPO_ROOT" \
  --ensemble-type "$ENSEMBLE_TYPE" --run-id "$RUN_ID" \
  > "$PROMPT_FILE.run.json" 2> "$PROMPT_FILE.err"
```
<!-- pipeline:end compose-dispatch -->

The four bookkeeping flags (`--workflow-path`, `--phase`,
`--ensemble-type`, `--run-id`) cause `peer-runner.mjs run` to record a
`pending_ensemble` entry under the workflow file's per-file lock BEFORE
spawning the companion (ADR-0017 §sub-decision 4). The runner writes
raw peer output under the hidden peer-run ledger and emits a small JSON
result to `$PROMPT_FILE.run.json` with `envelope_path`, `stdout_path`,
`stderr_path`, and `handle_path`. After synthesis, Phase 2 settles the
attempt with `peer-runner.mjs settle` and the same run id: it reads the
run ledger and, for a completed run, atomically pops the pending entry,
appends the synthesis verdict to `ensemble_results` and prunes to the
retention cap; a run that failed records verdict `failed` (ADR-0066 D2).

Independence exception (per ensemble-protocol.md § Independence
Rule): the peer DOES receive the orchestrator's draft plan as input
for this point type — its job is to find gaps in that specific plan.

Synthesize per AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT
categories. Gaps and ordering issues from the peer go directly into
the artifact's revision.

---

## Phase 2 — State finalize

<!-- pipeline:begin compose-finalize -->
The phase note this step records — fill in every `<…>`. When no run launched
(the verb ran local-only, so no dispatch ran; a run whose
companion is missing did launch, and settles `failed`), its first heading reads
`### Ensemble skipped: compose (local-only)` instead, and the synthesis
is local-only:

```markdown
### Ensemble launched: compose at <iso-utc>

### Ensemble synthesis: compose (profile=<profile>) verdict=<agreed|concerns|conflict>

<AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown>

### Artifact

<plan: TDD task list, dependencies, success criteria
 OR code: list of changed files with one-line summary each>

### Active next-action proposal

(per `core/skills/_shared/references/entry-routing-contract.md` § Active Next-Action Proposal — derived from this artifact, not a fixed table)
- selected_next:         <verb | commit | done | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + Standards/Root-Cause gate>
- evidence_pointers:     <phase notes / files / artifacts — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /engineer:<verb> … or $engineer:<verb> for a verb; /engineer:commit for commit or done; the owner-decision action otherwise>
```

The note, and the two texts the block records with it, reach the scripts as
files, never in the block: in shell source a quote, `$`, backtick or line of
them would be read as code (ADR-0059, amendment of 2026-10-10). Before the
block:

1. Create a private directory for them, and note the path it prints:

   ```bash
   mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"
   ```

2. With your file-writing tool, not the shell, create in that directory
   `note.md`, the phase note above filled in; `summary.txt`, a one-line
   résumé of its breakdown; and `next-action.txt`, the next action the
   `append` and the last write record: the compact form of the proposal
   (selected_next + one-line why + next_command). The typical-case default
   is

   ```text
   Critique the composed artifact
   ```

   Write another when the verb's result selects a different next step, and
   for an owner gate below `Owner: ` and the judgment in a few words. Each
   file holds its text as written and ends with one newline, which the
   scripts remove; nothing deletes the files.

Then run the block with `TEXT_DIR` set to that directory, `DISPATCH_DIR` to the
directory the dispatch block ran with, `VERDICT` to the synthesis's verdict,
and `CONFIDENCE` to the proposal's confidence (`HIGH`, `MEDIUM` or `LOW`). The block reads the run's id from the result the runner wrote there,
`prompt.xml.run.json`, never from a value carried from the dispatch's shell. A
runner that ended without writing its result (killed, or stopped by an error
after it launched the run) leaves that file empty: the block then takes the run
from `prompt.xml.dispatch.json`, which the dispatch block wrote there before
the launch, naming the run and the workflow. A run whose handle or record names
another workflow than the one the block finds, a handle that cannot be read
as that run's (one gone is left to the dispatch's record), or a directory
with no result, or one naming no well-formed run id, stops the block before
any write; settle, its first write, refuses a run of another phase. A
well-formed run id is one the runner accepts: letters, digits, `.`, `_`, `:`
and `-`, with no `..`, so a run the runner launched can always be finalized.

When no run launched (the verb ran local-only, or the dispatch's
`prompt.xml.err` says why), leave `DISPATCH_DIR` empty: that is the empty id,
"no run launched", and settle refuses it while the workflow holds a run of
this phase it would hide. When a run launched but its dispatch's directory is
gone (a later session, or a system that cleared its temporary files), set
`DISPATCH_DIR` to the run's own ledger directory, the one holding the
`envelope.json` the synthesis read
(`.agentic-plugins/state/engineer/peer-runs/<run id>`): the block reads the
run from its `handle.json` and checks it as it checks a dispatch's, the
workflow here and the phase in settle, so the run settled is always the one
the synthesis read, never one chosen from the workflow's pending entries. With
neither directory left, nothing binds the run to the synthesis: the block
cannot settle it, and settle does by hand (`peer-runner.mjs settle --run-id`).

Whatever run the block settles, the empty id included, it keeps in its text
directory as `finalize-run.json` before settle. Every value the last write
takes is checked before settle too (`CONFIDENCE` here), so a step that fails
after it fails on the workflow's own state, and its message says what. Run
again with the same `TEXT_DIR` after a later step failed, it settles that same
run again, which records nothing more; a phase note the failed run already
appended (the failure came at the last write) is appended a second time. A kept run that differs from the one this run of the
block names stops it before any write: each finalize takes a fresh text
directory, and a record left by another stays its own. The empty id binds
too: after settle refuses it (a run of this phase is pending), collect that
run, synthesize it, and finalize it from a fresh text directory. A file left
unwritten, blank, or not UTF-8 text stops it too.

`peer-runner.mjs settle` decides from the run ledger what the workflow
records, not from these values alone: a run that never launched records
nothing; a run that launched and failed, was cancelled or was abandoned
records verdict `failed` with the ledger's `error_kind`; a run that completed
records the synthesis verdict, or `degraded` when its answer was empty or
unreadable. An answer that parses to nothing usable, only structural
shell, reads to `settle` like any other, so set `VERDICT` to `degraded` then.
It runs before the block writes anything, so its refusal leaves the workflow
as it was: while a run is still live, or its handle was last updated less than
the stale grace (a minute) ago (collect it, or wait, and run the block again); for a run of
another workflow or phase; or when an empty id would hide an attempt the
ledger holds for this phase (collect that run and synthesize it, then set
`DISPATCH_DIR` to its directory, or to its ledger directory when that is
gone). Once
it has recorded a run, running the block again records nothing more for it.

The last write, `finish-verb`, records the proposal's next step in closed-enum
form: `--next-step-kind` `verb` (with `--next-step-verb`), `commit`
(`/engineer:commit` commits the change, or closes the workflow when there is
none) or `done`, each closing the workflow `summary-complete`.
Under an autopilot run it records the next step only and leaves the terminal
marker for `/engineer:commit`, the only command that closes a workflow
there (`core/skills/_shared/references/autopilot-mode.md`).
End instead with an owner gate when the owner must judge, with the judgment
under the gate's heading in the note:

- `scope-routing` (heading `### Routing recommendation`, anchor
  `routing-recommendation`): the request does not belong in this verb or
  workflow; the owner picks the route, then clears the gate.
- `pr-handling` (heading `### Outward action needed`, anchor `pr-handling`):
  under an autopilot run, the task itself needs a push, a pull request or
  another outward action; interactively the user acts instead.

The owner-decision form below records the gate with the next step in one
write and leaves the workflow open, not terminal, until the owner resolves it.

Set `OP_DIR` to the operation directory the Phase 0 bootstrap or resume block
printed (`OP_DIR=<path>`), or leave it empty when it printed none: the last
write, `finish-verb` (or, where this block has one, the write that keeps the
workflow open), closes there the persona operation Phase 0 opened when the
workflow is a macro's child (ADR-0068 Decision 2, item 7). A value left
unfilled stops the block before any write.

**The verify form** (ADR-0068 Decision 5). Under an autopilot run that offers
verification (Phase 0's preflight banner says so: `This run offers
verification`), the long checks this verb's change
needs are not run in its step: the driver runs them, with no LLM, after the
step ends (§ Long checks in `/engineer:compose`, `/engineer:refine` and
`/engineer:critique` says which are long).
To hand them over, write `verify-request.json` in the text directory with your
file-writing tool before the block; the block then ends with the next step
`verify` and the request, in place of the verb form. The request is JSON: an
ordered list of `checks`, each a `kind` the repository declares
(`.agentic-plugins/verify-checks.json` at the run's baseline) with its `args`
as data (the files of the tested tree a check names, a mutation spec and its
case ids); `on_pass`, the next step once every check passed on the unchanged
tree (`verb` with its `verb`, `commit` or `done`, and its confidence); and
`confidence`, which is the proposal's and `CONFIDENCE`'s. For example:

```json
{
  "checks": [
    { "kind": "test", "args": { "files": ["tests/persona-pipeline/test-verify-record.mjs"] } },
    { "kind": "mutate", "args": { "spec": "scripts/mutation-specs/verify-runbooks.mjs", "ids": ["K1", "F1"] } }
  ],
  "on_pass": { "kind": "verb", "verb": "critique", "confidence": "HIGH" },
  "confidence": "HIGH"
}
```

Then `next-action.txt` names the verification (for example `Verify: the
changed tests and the mutation cases, then critique`). When every check
passed, the driver dispatches `on_pass`; otherwise it resumes this verb, whose
Phase 0 prints the results. The block checks the request before its first
write with the last write's own checks (`state.mjs verify-request-check`), so
a request it would refuse (a run that offers no verification, a kind not
declared, a path not in the tree, a confidence that is not `CONFIDENCE`)
stops it with nothing written: fix the request, or remove the file to end
with the verb form. A conflict takes no request, and neither does any other
owner gate: a step that ends on its owner's judgment writes no
`verify-request.json`, since the driver would otherwise run the checks and
then `on_pass` past the judgment. Set `OWNER_GATE` in the block to the gate
whenever the step ends on one: the last write is then the owner-decision
form, which records that gate with the anchor the gate list above names, in
place of the verb or verify form. A gate this verb does not end on with it, a
request beside it, and a note that holds the heading of `recurring-finding`,
`scope-routing` or `pr-handling` while `OWNER_GATE` is empty each stop the
block before any write. Once every other check has passed, just before
settle, the block keeps the form it took in the text directory
(`finalize-verify.json`: the request's sha256, or none), so a run those checks
stop keeps none and may add a request: run again with the same `TEXT_DIR`
after a write, it takes the same form and the same request, and a request
added, removed or changed since stops it before any write. With no `verify-request.json`, the block ends with the verb form as
always.

```bash
TEXT_DIR='<directory from step 1>'
DISPATCH_DIR='<the directory the dispatch block ran with; empty when no run launched; the run ledger directory when a run launched and that directory is gone>'
VERDICT='<the synthesis verdict>'
CONFIDENCE='<HIGH|MEDIUM|LOW>'
OP_DIR='<the operation directory the Phase 0 block printed as OP_DIR; empty when it printed none>'
# The owner gate this step ends on, when it ends on one; empty otherwise.
# Naming it selects the last write's owner-decision form, which records it.
OWNER_GATE=''
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# A fresh shell: the workflow and the run are found again here, never carried
# from an earlier block. The run ledger lives under the repository root, where
# the dispatch put it.
PERSONA='engineer'
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
[ -n "$ACTIVE" ] || { echo "✗ No active ${PERSONA} workflow on this branch; nothing was written." >&2; exit 1; }
case "$OP_DIR" in
  *'<'*) echo "✗ OP_DIR is not set to the operation directory Phase 0 printed (empty when it printed none); nothing was written." >&2; exit 1 ;;
esac
case "$VERDICT" in
  ''|*'<'*) echo "✗ VERDICT is not set to the synthesis verdict; nothing was written." >&2; exit 1 ;;
esac
# The last write's confidence, checked here with the other values it takes, so
# a value it would refuse stops the block before settle, its first write.
case "$CONFIDENCE" in
  HIGH|MEDIUM|LOW) ;;
  *) echo "✗ CONFIDENCE is not HIGH, MEDIUM or LOW, the proposal's confidence the last write records; nothing was written." >&2; exit 1 ;;
esac
# The owner gate selects the last write's owner-decision form, with the anchor
# the gate list names; a gate this verb does not end on with it stops the block
# here, before settle, its first write. A note holding a gate's heading names
# a gate too: with OWNER_GATE empty the verb form would close the step past
# the owner's judgment, so it stops the block as well. A heading indented by up
# to three spaces, or with more than one space or a tab after its ###, is still
# one (CommonMark); one quoted in a fenced example
# matches too, a limit that fails closed (the block stops, nothing written).
OWNER_GATE_ANCHOR=''
case "$OWNER_GATE" in
  '') ;;
  scope-routing) OWNER_GATE_ANCHOR=routing-recommendation ;;
  pr-handling) OWNER_GATE_ANCHOR=pr-handling ;;
  recurring-finding) [ 'compose' != refine ] || OWNER_GATE_ANCHOR=recurring-finding ;;
  decide-conflict) [ 'compose' != decide ] || OWNER_GATE_ANCHOR=ensemble-synthesis ;;
esac
[ -z "$OWNER_GATE" ] || [ -n "$OWNER_GATE_ANCHOR" ] \
  || { echo "✗ OWNER_GATE is $OWNER_GATE, which is not a gate this verb ends on with the owner-decision form (the gate list above names them); nothing was written." >&2; exit 1; }
[ -n "$OWNER_GATE" ] || ! grep -Eq '^ {0,3}###[[:blank:]]+(Recurring finding|Routing recommendation|Outward action needed)([[:space:]]|$)' "$TEXT_DIR/note.md" 2>/dev/null \
  || { echo "✗ note.md in TEXT_DIR ($TEXT_DIR) records an owner gate (its heading), but OWNER_GATE is empty: set OWNER_GATE to that gate, and the last write records it. Nothing was written." >&2; exit 1; }
# The run's id, from the result the runner wrote beside the dispatch's prompt,
# or, when DISPATCH_DIR is the run's own ledger directory (no result there,
# its handle.json instead), from that handle, the directory naming the run. An empty
# DISPATCH_DIR (exit 5) is the empty id, no run launched; nothing else stands
# for a run, and none is chosen from the workflow's pending entries. A result
# that is missing or names no well-formed run id (the runner's rule: letters,
# digits, ".", "_", ":" and "-", with no "..", so every run it launched can be
# finalized) stops it, as does a
# run whose handle names another workflow than the one found above (exit 2)
# or cannot be read as the run's (exit 3): nothing is written to a workflow
# the run is not for; settle, the first write, judges the phase. Exit 4 leaves the run to the
# dispatch's own record: a result left empty, or a run whose handle is gone
# (its id printed).
RUN_ID="$(node -e 'const [d,w]=process.argv.slice(1);if(d==="")process.exit(5);const fs=require("fs"),p=require("path");const good=(v)=>typeof v==="string"&&/^[A-Za-z0-9._:-]+$/.test(v)&&!v.includes("..");const same=(a,b)=>{try{return fs.realpathSync(a)===fs.realpathSync(b)}catch{return p.resolve(a)===p.resolve(b)}};const bound=(h,id)=>{if(h===null||typeof h!=="object"||h.run_id!==id)process.exit(3);if(typeof h.workflow_path!=="string"||!same(h.workflow_path,w))process.exit(2);process.stdout.write(id);process.exit(0)};let t,r,h;try{t=fs.readFileSync(p.join(d,"prompt.xml.run.json"),"utf8")}catch(e){if(!(e&&e.code==="ENOENT"))process.exit(1);try{h=fs.readFileSync(p.join(d,"handle.json"),"utf8")}catch(e){process.exit(e&&(e.code==="ENOENT"||e.code==="ENOTDIR")?1:3)}const id=p.basename(p.resolve(d));if(!good(id))process.exit(1);try{h=JSON.parse(h)}catch{process.exit(3)}bound(h,id)}if(t.trim()==="")process.exit(4);try{r=JSON.parse(t)}catch{process.exit(1)}const id=r&&r.run_id;if(!good(id))process.exit(1);try{h=fs.readFileSync(r.handle_path,"utf8")}catch(e){if(e&&e.code==="ENOENT"){process.stdout.write(id);process.exit(4)}process.exit(3)}try{h=JSON.parse(h)}catch{process.exit(3)}bound(h,id)' "$DISPATCH_DIR" "$ACTIVE")"
RUN_READ=$?
if [ "$RUN_READ" -eq 2 ]; then
  echo "✗ The run in DISPATCH_DIR ($DISPATCH_DIR) is not one of $ACTIVE: its handle names another workflow, or none (a peer-now or manual run, dispatched for no workflow); nothing was written. Finalize on the branch whose workflow the dispatch ran for; a run dispatched for no workflow is not this finalize's to settle." >&2
  exit 1
elif [ "$RUN_READ" -eq 3 ]; then
  echo "✗ The handle of the run in DISPATCH_DIR ($DISPATCH_DIR) cannot be read as that run's, so the run cannot be bound to $ACTIVE; nothing was written." >&2
  exit 1
elif [ "$RUN_READ" -eq 4 ]; then
  # The dispatch recorded, before the launch, the run it launches and the
  # workflow it found (prompt.xml.dispatch.json): that run is the one to
  # settle, for the workflow found above only. A run the result names, its
  # handle gone, must be that same run.
  RUN_ID="$(node -e 'const [d,w,named]=process.argv.slice(1);const fs=require("fs"),p=require("path");const same=(a,b)=>{try{return fs.realpathSync(a)===fs.realpathSync(b)}catch{return p.resolve(a)===p.resolve(b)}};let m;try{m=JSON.parse(fs.readFileSync(p.join(d,"prompt.xml.dispatch.json"),"utf8"))}catch{process.exit(1)}const id=m&&m.run_id;if(typeof id!=="string"||!/^[A-Za-z0-9._:-]+$/.test(id)||id.includes("..")||(named!==""&&named!==id))process.exit(1);if(typeof m.workflow_path!=="string"||!same(m.workflow_path,w))process.exit(2);process.stdout.write(id)' "$DISPATCH_DIR" "$ACTIVE" "$RUN_ID")"
  case $? in
    0) ;;
    2) echo "✗ The run in DISPATCH_DIR ($DISPATCH_DIR) was dispatched for another workflow than $ACTIVE; nothing was written. Finalize on the branch whose workflow the dispatch ran for." >&2; exit 1 ;;
    *) echo "✗ The runner left no usable result in DISPATCH_DIR ($DISPATCH_DIR), and prompt.xml.dispatch.json there is missing, malformed or names another run; nothing was written. When the run launched, set DISPATCH_DIR to its ledger directory, the one holding the envelope.json the synthesis read, and run this block again; with no ledger directory either, settle the run by hand (peer-runner.mjs settle --run-id), then run this block with DISPATCH_DIR empty from a fresh TEXT_DIR. When the runner refused before any ledger (prompt.xml.err says why), no run launched: leave DISPATCH_DIR empty." >&2; exit 1 ;;
  esac
elif [ "$RUN_READ" -eq 5 ]; then
  # No run launched: the empty id (the read printed nothing), which settle
  # accepts only when no attempt of this phase is open. It never stands for a
  # run whose directory is gone.
  :
elif [ "$RUN_READ" -ne 0 ]; then
  echo "✗ prompt.xml.run.json in DISPATCH_DIR ($DISPATCH_DIR) is missing or names no well-formed run id, and DISPATCH_DIR is no run ledger directory; nothing was written. Set DISPATCH_DIR to the directory the dispatch block ran with; leave it empty when no run launched (prompt.xml.err there says why), or, when a run launched and that directory is gone, set it to the run's ledger directory, the one holding the envelope.json the synthesis read." >&2
  exit 1
fi
# The run this block settles is kept in TEXT_DIR (finalize-run.json) before
# settle; the empty id is kept too. Run again after a later step failed, the
# block settles the same run: a run kept that differs from the one named now,
# the empty id included (exit 3), stops it, as does a record that is
# malformed or names another workflow or phase (exit 7).
KEPT_ID="$(node -e 'const [rec,id,w,ph]=process.argv.slice(1);const fs=require("fs"),p=require("path");const good=(v)=>typeof v==="string"&&(v===""||/^[A-Za-z0-9._:-]+$/.test(v)&&!v.includes(".."));const same=(a,b)=>{try{return fs.realpathSync(a)===fs.realpathSync(b)}catch{return p.resolve(a)===p.resolve(b)}};let m,has=true;try{m=JSON.parse(fs.readFileSync(rec,"utf8"))}catch(e){if(!(e&&e.code==="ENOENT"))process.exit(7);has=false}if(has&&(!m||!good(m.run_id)||m.phase!==ph||typeof m.workflow_path!=="string"||!same(m.workflow_path,w)))process.exit(7);if(has&&m.run_id!==id){process.stdout.write(m.run_id);process.exit(3)}if(!has){try{fs.writeFileSync(rec,JSON.stringify({run_id:id,workflow_path:w,phase:ph})+"\n")}catch{process.exit(8)}}process.stdout.write(id);process.exit(0)' "$TEXT_DIR/finalize-run.json" "$RUN_ID" "$ACTIVE" 'compose')"
case $? in
  0) ;;
  3) echo "✗ finalize-run.json in TEXT_DIR ($TEXT_DIR), left by an earlier run of this block, keeps run '$KEPT_ID', not '$RUN_ID'; nothing was written. Use a fresh TEXT_DIR for each finalize." >&2; exit 1 ;;
  7) echo "✗ finalize-run.json in TEXT_DIR ($TEXT_DIR), left by an earlier run of this block, is malformed or names another workflow or phase than this one of $ACTIVE; nothing was written. Use a fresh TEXT_DIR for each finalize." >&2; exit 1 ;;
  8) echo "✗ Could not keep the run in TEXT_DIR ($TEXT_DIR) as finalize-run.json; nothing was written." >&2; exit 1 ;;
  *) echo "✗ Could not check finalize-run.json in TEXT_DIR ($TEXT_DIR); nothing was written." >&2; exit 1 ;;
esac
# ADR-0068 Decision 5 — the verify form: a request the agent wrote in
# TEXT_DIR (verify-request.json) makes the last write record it with the next
# step verify, in place of the verb form. It is checked here with the last
# write's own checks (verify-request-check; the run settle pops first is not
# counted), before settle, the first write, so a request the last write would
# refuse stops the block with nothing written; a conflict takes none, nor
# does an owner gate (OWNER_GATE, which a note holding a gate's heading has
# already required above), and an entry the check cannot read (a dangling
# link) refuses too. The form is kept just before settle (below).
VERIFY_FILE="$TEXT_DIR/verify-request.json"
VERIFY_FORM=''
if [ -e "$VERIFY_FILE" ] || [ -L "$VERIFY_FILE" ]; then
  VERIFY_FORM=verify
  [ "$VERDICT" != conflict ] || { echo "✗ verify-request.json is in TEXT_DIR ($TEXT_DIR), but VERDICT is conflict: a conflict ends on its gate and takes no request. Remove the file; nothing was written." >&2; exit 1; }
  [ -z "$OWNER_GATE" ] || { echo "✗ verify-request.json is in TEXT_DIR ($TEXT_DIR), but OWNER_GATE is $OWNER_GATE: a step that ends on its owner's judgment takes no request, or the driver would run on past it. Remove the file, and the owner-decision form records the gate; nothing was written." >&2; exit 1; }
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" verify-request-check \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
    --request-file "$VERIFY_FILE" --next-step-confidence "$CONFIDENCE" \
    --settling-run-id "$RUN_ID" > /dev/null \
    || { echo "✗ The last write would refuse verify-request.json in TEXT_DIR ($TEXT_DIR), for the reason above; nothing was written. Fix the request, or remove it to end with the verb form, and run this block again." >&2; exit 1; }
fi
# The texts the agent wrote with its file tool (ADR-0059, amendment of
# 2026-10-10): each script reads its file itself, so no line of the note is
# shell source. The append reads the note only after settle has written,
# so each file is first held to every reader's rule: strict UTF-8, no NUL
# byte, and text left once blanks are trimmed (settle's rule). A file a
# script would refuse stops the block before any write.
for TEXT_FILE in note.md summary.txt next-action.txt; do
  node -e 'let t;try{t=new TextDecoder("utf-8",{fatal:true}).decode(require("fs").readFileSync(process.argv[1]))}catch{process.exit(1)}process.exit(t.includes("\0")||t.trim()===""?1:0)' "$TEXT_DIR/$TEXT_FILE" || { echo "✗ $TEXT_FILE in TEXT_DIR ($TEXT_DIR) is missing, blank or not UTF-8 text; write it with the file tool first. Nothing was written." >&2; exit 1; }
done
# The verify form, kept in TEXT_DIR (finalize-verify.json: the request's
# sha256, or null for the verb form) at the first run, after every check
# above, so a run they stop keeps no form and runs again with a request added:
# run again after a write, the block takes the same form and the same request,
# and a request added, removed or changed since (exit 3) stops it before any
# write.
node -e 'const [rec,f]=process.argv.slice(1);const fs=require("fs");let now=null;try{now=require("crypto").createHash("sha256").update(fs.readFileSync(f)).digest("hex")}catch(e){if(!(e&&e.code==="ENOENT"))process.exit(1)}let m;try{m=JSON.parse(fs.readFileSync(rec,"utf8"))}catch(e){if(!(e&&e.code==="ENOENT"))process.exit(7);try{fs.writeFileSync(rec,JSON.stringify({request_sha256:now})+"\n")}catch{process.exit(8)}process.exit(0)}if(m===null||typeof m!=="object"||!(m.request_sha256===null||typeof m.request_sha256==="string"&&/^[0-9a-f]{64}$/.test(m.request_sha256)))process.exit(7);process.exit(m.request_sha256===now?0:3)' "$TEXT_DIR/finalize-verify.json" "$VERIFY_FILE"
case $? in
  0) ;;
  3) echo "✗ finalize-verify.json in TEXT_DIR ($TEXT_DIR), left by an earlier run of this block, keeps another form than verify-request.json there gives now (the request was added, removed or changed since); nothing was written. Put the request back as it was, or finalize from a fresh TEXT_DIR." >&2; exit 1 ;;
  7) echo "✗ finalize-verify.json in TEXT_DIR ($TEXT_DIR) is malformed; nothing was written. Use a fresh TEXT_DIR for each finalize." >&2; exit 1 ;;
  *) echo "✗ Could not read verify-request.json, or keep the form as finalize-verify.json, in TEXT_DIR ($TEXT_DIR); nothing was written." >&2; exit 1 ;;
esac

# ADR-0066 PC2b — settle the ensemble attempt from its ledger (never launched,
# launched and failed, completed). It is the first write and the one judge of
# the run: a refusal (a run still live, of another workflow or phase, or an
# attempt an empty id would hide) stops the block before any write, so the
# workflow never records a note for an attempt left unsettled; once it has
# recorded the run, running the block again records nothing more for it.
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" settle \
  --repo-root "$REPO_ROOT" --workflow-path "$ACTIVE" \
  --host "${AGENTIC_HOST:-claude}" --phase 'compose' --run-id "$RUN_ID" \
  --verdict "$VERDICT" --summary-file "$TEXT_DIR/summary.txt" || exit $?

node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase-label 'Phase 1: Compose (synthesized)' \
  --phase-note-file "$TEXT_DIR/note.md" \
  --current-phase phase-2-presented \
  --next-action-file "$TEXT_DIR/next-action.txt" \
  --event updated || exit $?

# The owner-decision form when OWNER_GATE names a gate; otherwise, ADR-0068
# Decision 5, the verb form unless a request was checked above, and the
# verify form after the last else.
if [ -n "$OWNER_GATE" ]; then
  # The gate and the next step owner-decision in one write: the workflow
  # stays open until the owner resolves the gate.
  # A limit (ADR-0068 VR6): interactively, with another owner gate already
  # pending, this write refuses after settle and the note, so a rerun appends
  # the note again; an autopilot run's preflight refuses a pending gate first.
  # ARCHIVE TIMING — with an owner gate this write is never terminal, so the
  # Stop hook, which fires at EVERY turn end on Claude, leaves the workflow
  # active (it refuses to archive while a gate is pending); the
  # `--terminal-marker false` escape is not needed. On Codex the Stop hook runs
  # only once the plugin hooks are trusted (`/hooks`).
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" finish-verb \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
    --operation-dir "$OP_DIR" \
    --next-action-file "$TEXT_DIR/next-action.txt" \
    --next-step-kind owner-decision --next-step-confidence "$CONFIDENCE" \
    --owner-gate "$OWNER_GATE" --owner-gate-anchor "$OWNER_GATE_ANCHOR" || exit $?
elif [ -z "$VERIFY_FORM" ]; then
# ADR-0029 §1 / completion-output contract §2 — next-action.txt, which the
# append above and this terminal write record, holds the COMPACT form of the
# proposal above (selected_next + one-line why + next_command) so the
# durable state and the code-emitted completion footer agree with the
# Active Next-Action Proposal. Step 2 shows the typical-case default; write
# another, and change the --next-step-* flags, when the verb's result
# selects a different next step (e.g. commit).
# ADR-0063 D3 — finish-verb is the verb's last write: the ADR-0017
# §sub-decision 5 atomic terminal write (summary-complete + terminal marker)
# with the next step, interactively. Under an autopilot run (ADR-0066
# Decision 3: AGENTIC_AUTOPILOT names a run, on Claude) it writes the next step
# only and leaves the terminal marker for the commit command, which alone
# closes a workflow there.
# ARCHIVE TIMING — on Claude the Stop hook fires at EVERY turn end, so the
# archive gates are evaluated at the end of THIS turn, not at session close;
# if a gate fails the workflow stays marked and a later Stop re-evaluates it.
# Clearing the marker with `--terminal-marker false` works only before that
# Stop fires, needs set-terminal's full flag set (--workflow-path, --host,
# --terminal-phase), and does not restore the previous phase or next_action.
# On Codex the Stop hook runs only once the operator has trusted the plugin
# hooks (`/hooks`), so evaluation waits for that. Full contract:
# core/skills/_shared/references/session-handoff.md § Archive timing.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" finish-verb \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --operation-dir "$OP_DIR" \
  --next-action-file "$TEXT_DIR/next-action.txt" \
  --next-step-kind verb --next-step-verb 'critique' \
  --next-step-confidence "$CONFIDENCE" || exit $?
else
  # The verify form: the request and the next step verify in one write; the
  # driver runs the checks, then dispatches the request's on_pass, or resumes
  # this verb with the results.
  # ARCHIVE TIMING — this write is never terminal (an autopilot run only, and
  # it turns the marker off), so the Stop hook, which fires at EVERY turn end
  # on Claude, leaves the workflow active; the `--terminal-marker false`
  # escape is not needed. On Codex no run offers verification.
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" finish-verb \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
    --operation-dir "$OP_DIR" \
    --next-action-file "$TEXT_DIR/next-action.txt" \
    --next-step-kind verify --next-step-confidence "$CONFIDENCE" \
    --verify-request-file "$VERIFY_FILE" || exit $?
fi
```
<!-- pipeline:end compose-finalize -->

---

## Autopilot mode (ADR-0063, Claude only)

When Phase 0's preflight printed the autopilot banner, this command follows
`${CLAUDE_PLUGIN_ROOT}/core/skills/_shared/references/autopilot-mode.md`
(the preflight prints nothing interactively, and none of this applies then):

- **Ceremony gates auto-pass.** No presentation-mode prompt (present in
  batch); proceed with the recommended option instead of asking
  "Recommended: X. Proceed?".
- **Never run `git commit`.** Set `--next-step-kind commit` when the artifact
  is ready; `/engineer:commit` commits it. (The driver also denies `git
  commit` on this step.)
- **The last write is Phase 2's `finish-verb`**, which records the next step
  and leaves the terminal marker unset: under autopilot only
  `/engineer:commit` closes a workflow, and `set-terminal --terminal-marker
  true` is refused.
- **Owner judgments.** Stop with the gate that names the judgment and do not
  decide it yourself: `scope-routing` when the request does not belong in this
  verb or workflow (recorded in either mode), `pr-handling` when the task
  itself needs a push, a pull request or another outward action (autopilot
  only; interactively the user acts). Record the gate by setting `OWNER_GATE` in Phase 2's finalize block, whose
  last write is then the owner-decision form, after a phase note under the
  heading the gate table names (`autopilot-mode.md` § Owner gates).
- **Long checks.** In a run that offers verification, run only the quick
  checks in the step and hand the long ones (the whole suite, a broad
  `npm test`, a mutation run) to the driver with Phase 2's verify form;
  never wait for the heavy-work lock (`autopilot-mode.md` § Verification).
- **Peers.** Collect the ensemble as `ensemble-protocol.md` § Step 2 says:
  wait for the background notification; never sleep-poll. A step report
  taken while you wait is provisional: when the notification re-invokes you,
  finish the verb through `finish-verb`, then report again
  (`autopilot-mode.md` § Peer ensembles).

---

## Multi-axis lens at a 2+-branch point (ADR-0029 §2)

If executing this verb surfaces a **genuine 2+-branch decision point**
— two viable implementation designs, or two artifact structures, or a
non-neutral `selected_next` with 2+ candidates in the proposal below —
surface a **compact multi-axis lens** comparing the branches across the
resolved decisive axes (본질/근본 essence/foundation) + supporting axes,
instead of a flat list. Resolve the sized axis set from the shared
`${CLAUDE_PLUGIN_ROOT}/scripts/decide-registry.mjs resolve --size=<minor|standard|major>`
resolver — the single axis source of truth, not a hand-authored list —
per `core/skills/_shared/references/entry-routing-contract.md`
§ "Surfacing the multi-axis lens from a non-decide verb".

Bounded: only at a genuine 2+-branch point (not every invocation),
default `--size=minor` (compact 4-axis), escalating only for weightier
branches — never the full 9-axis matrix for a trivial reversible step.
The full mechanism + the Codex path-resolution fallback live in
the contract subsection cited above.

---

## Completion

Output the artifact (plan or change set) and one of:

- `✓ Plan complete.` + path/anchor to the artifact.
- `✓ Code change complete.` + summary of edited files.
- `✓ Compose paused (gaps surfaced).` — when peer flagged
  significant gaps or ordering issues that warrant user input
  before proceeding.

Then emit the **Active Next-Action Proposal** the phase note above carries
(per `core/skills/_shared/references/entry-routing-contract.md`
§ Active Next-Action Proposal), instead of a fixed next verb.

Typical `selected_next` candidates for compose:
`/engineer:critique` to review the artifact — or, for a completed `plan`
profile, `/engineer:compose --profile=code` to implement it; the routing
table is the fallback only when evidence is genuinely neutral — do not end
with a hardcoded "next: X". When `selected_next` is `engineer:decide`, also
name the decision size (`--size=minor|standard|major`) per the contract.

Always include the workflow path.

<!-- pipeline:begin compose-completion-footer -->
The runtime completion footer is **code-emitted** on this verb's terminal
path (ADR-0039): the terminal write (`state.mjs finish-verb`, which takes
`set-terminal`'s path) fires the ADR-0031 session-handoff sidecar, which
shells out to the runtime `footer.mjs` and prints the rendered footer —
context state, completion state
(`blocked`, with the commit as its unblocking action, when only the commit
remains) + state-derived next action,
workflow id/path, artifact pointers, recommended next work, and the
continue-vs-fresh session-handoff — on that command's **stderr**.
Do **not** hand-compose a second footer; surface the one the terminal
command already emitted. The footer is advisory + pointer-only and
fail-closed (a missing/too-old runtime emits nothing, and the SessionStart
backstop still re-surfaces the handoff); it never mutates host session
context. On a detached HEAD the branch-based preflight reports "no active
branch context" and never recommends a fresh session (ADR-0018 §sub-2); the
path-targeted terminal sidecar renders the footer as on a branch, its
continue-vs-fresh advice included.
Under an autopilot run `finish-verb` makes no terminal write, so no footer is
printed: the driver is the handoff.
Wiring details:
`core/skills/_shared/references/session-handoff.md`.
<!-- pipeline:end compose-completion-footer -->
