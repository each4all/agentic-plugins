---
description: Macro plan + Plan-verify Codex peer ensemble — produce plan.subtasks[] for a multi-deliverable feature
argument-hint: <feature description>
---

# Orchestrator · Plan

$ARGUMENTS

Maintain one progress entry per phase and advance its status as you go — use the host's task-tracking tools when the session exposes them, and keep an inline checklist when it does not. The peer ensemble runs automatically per `core/skills/_shared/references/ensemble-protocol.md` (Plan-verify point type). Never ask the user whether to invoke the peer. When the companions plugin or peer CLI is unavailable, the ensemble degrades silently to a LOCAL-ONLY plan (`peer-runner.mjs run` returns `peer_cli_not_found` with no peer-run ledger or orphan-pending entry — orchestrator-specific graceful degradation contract).

Plugin root: each shell block below opens by setting `$CLAUDE_PLUGIN_ROOT` —
from `AGENTIC_ORCHESTRATOR_ROOT` when that is set, else from the plugin path
Claude Code writes into this command when it loads it, else from the newest
version in the plugin cache. Keep that opening line when you run a block: a
shell variable does not outlive a Bash call.

No block relies on a variable an earlier block set, since each may run in a
fresh shell: a block reads the macro's path from the file Phase 0 wrote to the
text directory (never finding it again, so a branch switched meanwhile cannot
point it at another macro), reads the Plan-verify run id from the file the
dispatch wrote there, and takes the verdict from its own `VERDICT` line.

Text you write reaches the CLIs as files, never as shell source (ADR-0059,
amendment of 2026-10-10): a backtick or `$(…)` in a block's source runs as a
command, and the Plan-verify note and summary carry the peer's sentences.
Before Phase 0:

1. Create a private directory for the files, and note the path it prints:

   ```bash
   mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"
   ```

2. Before a block that names a file in that directory, write the file with
   your file-writing tool (Claude: the Write tool), not the shell: the text as
   it is to be recorded, ending with one newline. Each such block opens with
   `TEXT_DIR='<directory from step 1>'`; put the path there.

The files are `request.txt` (Phase 0), `prompt.xml` (Phase 1),
`subtasks.json`, `decision.txt` and `architecture.txt` (Phase 2's plan write),
and `note.md`, `summary.txt` and, on a conflict, `contested.md` (Phase 2's note
and ensemble commit). The CLIs read them themselves. `state.mjs` removes the
final newline of `request.txt`, `decision.txt`, `architecture.txt`, `note.md`
and `summary.txt`, keeps everything else as written, and refuses an empty or
missing file before it writes anything. `consensus-task` trims `contested.md`
at both ends and masks what looks like a secret before it writes the task
file, and refuses one with nothing left. Two files the blocks write there
themselves: Phase 0's first block writes `macro-path`, the macro every later
block writes to (empty when it finds none, and the bootstrap then writes the
macro it creates), and Phase 1's dispatch writes `run-id`, the Plan-verify run id Phase 2
reads, and `run-macro`, the macro it dispatched that run for. The dispatch
empties `run-id` before anything else, so a run of an earlier dispatch is never
taken for its own, and Phase 2 records a run only for the macro `run-macro`
names. Nothing deletes
them: a headless run can deny `rm`, and the directory is under `$TMPDIR`.

---

## Phase 0 — Workflow continuity (per ADR-0011 §5 + ADR-0018 §sub-2)

```bash
TEXT_DIR='<directory from step 1>'
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel)"
GIT_BRANCH="$(git branch --show-current)"
# ADR-0018 §sub-2 — orchestrator workflows are anchored to a branch;
# detached HEAD has no branch context to anchor to.
if [ -z "$GIT_BRANCH" ]; then
  echo "✗ Detached HEAD detected — orchestrator workflows are anchored to a branch (ADR-0018 §sub-2)." >&2
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
# The one selection: the macro every later block writes to, or nothing (the
# bootstrap then writes the one it creates). No later block finds it again.
printf '%s' "$ACTIVE" > "$TEXT_DIR/macro-path" || exit 1
# What the next step branches on: the active macro's path, or nothing.
printf 'ACTIVE=%s\n' "$ACTIVE"
```

The block prints `ACTIVE=` followed by the active macro's path, or by nothing
when no macro is active on this branch, and writes the same path (or nothing)
to `macro-path`: the bootstrap and resume blocks read it there, so a branch
switched between this block and the next cannot resume another macro.

- Empty → bootstrap with verb=plan. First write `request.txt`: the user's
  feature description on one line, scrubbed of secrets.

  ```bash
  TEXT_DIR='<directory from step 1>'
  CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
  [ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
  REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
  # Phase 0 found no macro: a path in macro-path is one to resume instead.
  FOUND="$(cat "$TEXT_DIR/macro-path")" || { echo "✗ Phase 0 writes what it found to $TEXT_DIR/macro-path: run it first; nothing was written." >&2; exit 1; }
  [ -z "$FOUND" ] || { echo "✗ Phase 0 found the active macro $FOUND: run the resume block instead; nothing was written." >&2; exit 1; }
  GIT_BRANCH="$(git branch --show-current)"
  [ -n "$GIT_BRANCH" ] || { echo "✗ Detached HEAD detected — orchestrator workflows are anchored to a branch (ADR-0018 §sub-2)." >&2; exit 1; }
  GIT_HEAD="$(git rev-parse HEAD)"
  STATUS_DIGEST="$(git status --porcelain=v1 -z --untracked-files=normal | shasum -a 256 | cut -d' ' -f1)"
  ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" create \
    --repo-root "$REPO_ROOT" \
    --verb plan --host claude \
    --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
    --status-digest "$STATUS_DIGEST" \
    --original-request-file "$TEXT_DIR/request.txt" \
    --current-phase phase-0-bootstrap \
    --next-action "Run plan skill")" || exit 1
  # The macro every later block writes to.
  printf '%s' "$ACTIVE" > "$TEXT_DIR/macro-path" || exit 1
  ```

- Non-empty → append-on-resume. `--require-open` makes the append itself
  refuse a macro whose `terminal_marker` is set, under the same lock as the
  write (ADR-0062 §Decision 4): this append and the Phase 2 append both
  rewrite `current_phase`, which would leave the marker set with a phase the
  archive gate rejects. A separate check before the append would race a
  `/orchestrator:finalize` in another session. On refusal, stop: archive the
  macro with `/orchestrator:resume archive` and plan the new work afresh.

  ```bash
  TEXT_DIR='<directory from step 1>'
  CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
  [ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
  # The macro Phase 0 found, not the one this branch names now.
  ACTIVE="$(cat "$TEXT_DIR/macro-path")" || { echo "✗ Phase 0 writes what it found to $TEXT_DIR/macro-path: run it first; nothing was written." >&2; exit 1; }
  [ -n "$ACTIVE" ] || { echo "✗ Phase 0 found no orchestrator macro on this branch; bootstrap one instead." >&2; exit 1; }
  [ -f "$ACTIVE" ] || { echo "✗ $TEXT_DIR/macro-path names no macro file (\"$ACTIVE\"); nothing was written." >&2; exit 1; }
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
    --workflow-path "$ACTIVE" --host claude \
    --phase-label "Phase 0: Resume macro plan" \
    --phase-note "Resumed prior orchestrator plan workflow." \
    --current-phase phase-0-resume \
    --next-action "Run plan skill" --event resumed --require-open || exit 1
  ```

`createWorkflowUnderLock` rejects same-branch duplicates per ADR-0018 §sub-2 — concurrent `/orchestrator:plan` invocations on the same branch race the directory lock, and the loser sees a clear error message pointing at the existing workflow.

---

## Phase 1 — Execute plan skill (decompose + dependency graph)

Follow the plan skill's command-invoked mode at `${CLAUDE_PLUGIN_ROOT}/core/skills/plan/SKILL.md`. Produce a draft `plan.subtasks[]` per ADR-0018 §sub-decision-1 + ADR-0019 §2 schema (1.1):

```yaml
- id: <unique short token (e.g. PR1, schema-reader)>
  verb: <canonical 6-verb: investigate | frame | decide | compose | critique | refine>   # REQUIRED in 1.1
  branch: <git branch name; must pass git ref-format>                                     # REQUIRED in 1.1
  label: <short human-readable label>                                                     # optional
  profile: <sub-discipline name passed to engineer, e.g., backend / architecture>         # optional
  topic: <one-line objective; passed as engineer's original_request>                      # optional
  blocked_by: [<predecessor ids>]   # empty list when no dependencies
  status: pending | blocked          # initial: pending if blocked_by==[], else blocked
  # engineer_workflow_id / commit / pr_url / closed_at omitted at plan-time
  # — populated by /orchestrator:next + /orchestrator:done (ADR-0019 PR-D)
```

Validation runs at the `state.mjs plan-set` boundary (id non-empty + unique, blocked_by → existing id only and acyclic — self-reference, mutual `A<->B`, and longer cycles are all rejected with the cycle members named, because a subtask on a cycle can never become ready and `/orchestrator:next` would otherwise wait forever; the same validator runs on every read, so a cyclic plan that is already on disk fails closed with repair guidance instead of deadlocking dispatch — status enum, verb in canonical 6-verb whitelist, branch passes git ref-format gate per ADR-0019 §1: no spaces, no leading `.`, no `..`, no `~ ^ : ? * [ \\`, no trailing `/` or `.lock`, branches unique across subtasks, no parent/child path-prefix relationship between any two subtask branches — e.g., `feat/api` and `feat/api/db` cannot coexist; pick siblings like `feat/api/db` + `feat/api/auth` instead).

A document subtask (an ADR or other prose deliverable) whose topic would settle more than two decisions is proposed as chained slices of one or two decisions each, per the plan skill's Step 2 (C120): advice, not a `plan-set` rule.

### Ensemble dispatch (Plan-verify point type)

Build the Plan-verify prompt per `${CLAUDE_PLUGIN_ROOT}/core/skills/_shared/references/ensemble-protocol.md` § Plan-verify. The peer receives the orchestrator's draft plan as `<inputs><input name="feature_description">…</input><input name="draft_plan">…</input></inputs>` (Independence Rule exception per protocol). The `<grounding_rules>` section MUST include the schema 1.1 constraints so peer-emitted plan revisions don't bypass validation: every subtask requires `verb` (canonical 6-verb whitelist: investigate / frame / decide / compose / critique / refine) AND `branch` (git ref-format), plus `id` (unique) / `blocked_by` (array of existing ids forming a DAG — self-reference, mutual `A<->B`, and longer cycles are rejected) / `status` (`pending|blocked|in_progress|completed|deferred|abandoned`) per ADR-0019 §2.

Write the prompt to `prompt.xml` in the text directory, then run the block
**as a host background task** — on Claude, the Bash tool's
`run_in_background` — never with a trailing `&`: the host then tracks the
runner and notifies you when it exits, where a shell `&` would detach it from
both you and an autopilot host, and lose the run id with its shell (ADR-0063
D5). The block writes the run id to the text directory before it dispatches,
so a later block, and a `status` or `cancel` of a run that hangs, read it
there; it empties it first, so a dispatch that stops at a check leaves no run
id of an earlier one for Phase 2 to record:

```bash
TEXT_DIR='<directory from step 1>'
# A run id an earlier dispatch left is not this one's.
: > "$TEXT_DIR/run-id" || exit 1
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
# The macro Phase 0 found, not the one this branch names now.
ACTIVE="$(cat "$TEXT_DIR/macro-path")" || { echo "✗ Phase 0 writes the macro's path to $TEXT_DIR/macro-path: run it first; nothing was dispatched." >&2; exit 1; }
[ -f "$ACTIVE" ] || { echo "✗ $TEXT_DIR/macro-path names no macro file (\"$ACTIVE\"); nothing was dispatched." >&2; exit 1; }
PROMPT_FILE="$TEXT_DIR/prompt.xml"
[ -s "$PROMPT_FILE" ] || { echo "✗ $PROMPT_FILE is missing or empty: write the Plan-verify prompt there with your file-writing tool first; nothing was dispatched." >&2; exit 1; }
# Generate a stable run-id BEFORE dispatch so the pending entry, the
# peer's eventual result, and the ensemble-commit call all share the
# same key.
RUN_ID="macro-plan-$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%06x' $((RANDOM*RANDOM & 0xffffff)))"
# The macro this run is for, then its id: Phase 2 records it for that macro only.
printf '%s' "$ACTIVE" > "$TEXT_DIR/run-macro" || exit 1
printf '%s' "$RUN_ID" > "$TEXT_DIR/run-id" || exit 1
# In the foreground of this block, which the host runs in the background.
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" run \
  --repo-root "$REPO_ROOT" --kind ensemble \
  --peer codex --prompt-file "$PROMPT_FILE" --output-format json \
  --workflow-path "$ACTIVE" --phase plan \
  --ensemble-type plan-verify --run-id "$RUN_ID" \
  --host "${AGENTIC_HOST:-claude}" --cwd "$REPO_ROOT" \
  > "$PROMPT_FILE.run.json" 2> "$PROMPT_FILE.err"
```

Wait for the task's notification before Phase 2; never sleep-poll.

The four bookkeeping flags (`--workflow-path`, `--phase`, `--ensemble-type`, `--run-id`) cause `peer-runner.mjs run` to:

1. Resolve the companion script (`peer codex`) via `companions/discover-peer.mjs`.
2. **If companion missing** → return `peer_cli_not_found`, create no peer-run ledger, and record NO `pending_ensemble` entry (orchestrator-specific graceful-degradation order). Caller proceeds with a LOCAL-ONLY plan.
3. **If companion present** → create `.agentic-plugins/state/orchestrator/peer-runs/<run_id>/` for new repos (or the legacy peer-run home until explicit migration), record a `pending_ensemble` entry under the workflow file's per-file lock, then, for a codex peer, make a snapshot of HEAD plus the working tree and the index in a temporary worktree (C96), and spawn the companion there, its `--cwd` and the prompt's absolute checkout paths pointing into the snapshot. A snapshot that cannot be made ends the run `failed` with `error_kind: snapshot_failed`, its pending entry recorded and no companion run. The snapshot is removed when the run ends, whatever its end.
4. Tee stdout/stderr to bounded ledger files, write the final JSON envelope to `envelope.json`, and print machine-readable run metadata to `$PROMPT_FILE.run.json`.

After synthesis, Phase 2 invokes `state.mjs ensemble-commit` with the same `--run-id` to atomically pop the pending entry (no-op if companion was missing), append the result to `ensemble_results`, and prune to the retention cap.

Synthesize per AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT categories (host-agnostic per orchestrator ensemble-protocol). Gaps and ordering issues from the peer go directly into the plan revision; CONFLICT items surface for user decision.

---

## Phase 2 — State finalize (setPlan + ensemble-commit)

Write three files in the text directory: `subtasks.json`, the synthesized
subtasks as a top-level JSON array of subtask objects matching the ADR-0018
§sub-1 schema; `decision.txt`, the decision rationale on one line; and
`architecture.txt`, the architecture summary on one line. Then call
`plan-set`:

```bash
TEXT_DIR='<directory from step 1>'
VERDICT='<pass|concerns|conflict>'
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(cat "$TEXT_DIR/macro-path")" || { echo "✗ Phase 0 writes the macro's path to $TEXT_DIR/macro-path: run it first; nothing was written." >&2; exit 1; }
[ -f "$ACTIVE" ] || { echo "✗ $TEXT_DIR/macro-path names no macro file (\"$ACTIVE\"); nothing was written." >&2; exit 1; }
# ADR-0067 Decision 8 — a conflict records the Plan-verify run with its gate,
# plan-conflict, in the plan's own write; any other verdict records none. The
# run id is the one Phase 1's dispatch wrote, for this macro.
PLAN_RUN_ID=''
if [ "$VERDICT" = conflict ]; then
  PLAN_RUN_ID="$(cat "$TEXT_DIR/run-id")" || exit 1
  [ -n "$PLAN_RUN_ID" ] || { echo "✗ $TEXT_DIR/run-id is empty: a conflict records the Plan-verify run; nothing was written." >&2; exit 1; }
  RUN_MACRO="$(cat "$TEXT_DIR/run-macro")" || { echo "✗ Phase 1's dispatch writes the macro of its run to $TEXT_DIR/run-macro; nothing was written." >&2; exit 1; }
  [ "$RUN_MACRO" = "$ACTIVE" ] || { echo "✗ Run $PLAN_RUN_ID was dispatched for $RUN_MACRO, not for $ACTIVE: dispatch a Plan-verify run for this macro; nothing was written." >&2; exit 1; }
fi
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" plan-set \
  --workflow-path "$ACTIVE" --host claude \
  --subtasks-json-file "$TEXT_DIR/subtasks.json" \
  --decision-file "$TEXT_DIR/decision.txt" \
  --architecture-file "$TEXT_DIR/architecture.txt" \
  --verdict "$VERDICT" --run-id "$PLAN_RUN_ID" \
  --event updated
```

Put the synthesized Plan-verify verdict (`pass`, `concerns` or `conflict`) in
the block's `VERDICT` line, the same value the ensemble commit below records;
the run id is the one the dispatch generated and wrote to `run-id`. A
LOCAL-ONLY plan (no peer) still has both: the local synthesis's own `pass` or
`concerns`, and the id of the dispatch that found no peer. `plan-set` refuses
an empty or unknown verdict. On `conflict` the
gate records the run id (ADR-0067 Decision 8), and before the write every
consensus task file the macro still has is retired: a re-plan never leaves the
previous plan's proposal current. `plan-set`
also returns the plan to **pending approval** under the same lock (ADR-0063
D6): `plan_approval_status=pending`, with `awaiting_owner_gate=plan-conflict`
when the verdict is `conflict` and `plan-approval` otherwise, pointing at the
macro file. Setting the gate in the write that stores the plan means a disputed
plan is never approvable, not even for a moment. Any plan write revokes an
earlier approval. The owner approves the plan with `/orchestrator:approve`,
which binds the approval to the plan's hash. Under ADR-0063's autopilot,
`/orchestrator:next` dispatches only an approved plan whose hash still
matches (`plan-unapproved` otherwise).

Then compute the lane advice (ADR-0067 Decision 8, item 2) from the plan just
stored. It prints one `- lane_advice:` line when running two subtasks at a time
would shorten the plan, and nothing otherwise; the line goes after the six
fields of the proposal, in the phase note below and in the Completion proposal.
It is display only: nothing stores it, and no machine reads it.

```bash
TEXT_DIR='<directory from step 1>'
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(cat "$TEXT_DIR/macro-path")" || { echo "✗ Phase 0 writes the macro's path to $TEXT_DIR/macro-path: run it first." >&2; exit 1; }
[ -f "$ACTIVE" ] || { echo "✗ $TEXT_DIR/macro-path names no macro file (\"$ACTIVE\")." >&2; exit 1; }
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" lane-advice \
  --workflow-path "$ACTIVE" --repo-root "$REPO_ROOT" --format line
```

Then record the phase note + ensemble result. Write two files in the text
directory. `note.md` is the phase note, every `<…>` filled in:

```markdown
### Ensemble launched: plan at <iso-utc>

### Ensemble synthesis: plan-verify verdict=<pass|concerns|conflict>

<AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown>

### Macro plan

<subtasks summary: ids + labels + dependency graph>

### Active next-action proposal

(per core/skills/_shared/references/session-handoff.md § Active Next-Action Proposal,
 canonical entry-routing-contract.md § Active Next-Action Proposal in engineer —
 derived from the macro state, not a fixed table)
- selected_next:         <a macro command (/orchestrator:next when a subtask is ready; /orchestrator:finalize or /orchestrator:abort when closing), commit, or owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + Standards/Root-Cause gate>
- evidence_pointers:     <subtask table / phase notes / artifacts — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /orchestrator:next … (dispatch first ready subtask) or $orchestrator:next on Codex; the finalize / owner-decision action otherwise>
<the - lane_advice: line lane-advice printed above, verbatim, or nothing when it printed none>
```

`summary.txt` is a one-line résumé of the AGREED / LOCAL-ONLY / PEER-ONLY /
CONFLICT breakdown (about 200 characters), the summary the ensemble result
records. On a `conflict`, also write `contested.md`: each CONFLICT item, both
positions and their evidence, prepared as the Plan-verify prompt was, since the
consensus peers read the file. They come from the peer's positions, so never
put them in the block, where the shell would read a line of them as a command.

Put the synthesized verdict (`pass`, `concerns` or `conflict`) in the block's
`VERDICT` line, as in the `plan-set` block. When the run launched and did not
complete (`status` in `$TEXT_DIR/prompt.xml.run.json` is `failed`,
`cancelled` or `orphaned`, whatever its `error_kind`, `snapshot_failed`
included), the plan is LOCAL-ONLY: `VERDICT` stays the local synthesis's,
which `plan-set` recorded, and the ensemble result records the run as failed:
also set the block's `ENSEMBLE_VERDICT` line to `failed` and name the
`error_kind` in `summary.txt`. A run that found no peer (`peer_cli_not_found`)
never launched: leave `ENSEMBLE_VERDICT` empty.

The block checks every input before it writes anything (C132): the two
verdicts, the run id the dispatch wrote (in the form `peer-runner.mjs`
dispatches, and on a conflict in the narrower form the gate and the task
file's name take) and the macro it wrote with it, which must be the one Phase
0 found, `note.md` and `summary.txt` as `state.mjs`'s own reader
reads them, and on a conflict `contested.md` as `consensus-task` reads it.
It reads the macro too, and holds the verdicts to what its frontmatter records
for the run: a terminal macro is refused; so is a verdict other than
`conflict` while the `plan-conflict` gate `plan-set` bound to this run id is
set, and a verdict other than the one a result already recorded for the run
carries. A wrong `VERDICT` line is then fixed and the block rerun (or
`plan-set` rerun with the verdict it should have had), never recorded:
`ensemble-commit` keeps the first result for a run, so a wrong one would stay.
A refusal there writes nothing. A block that stops at one of the writes that
follow is rerun as it is, after the cause is fixed: `ensemble-commit` keeps
the result it already recorded for the run id, and `consensus-task` writes
the same task file again while the run's `plan-conflict` gate is set (once the
owner has cleared it, no round is proposed). The append is not skipped on a
rerun, so a block that stopped past it records the note a second time. That
is accepted until the macro keeps a machine record of the run's note: the
note's text cannot tell the run's own note from a copy another note quotes.

```bash
TEXT_DIR='<directory from step 1>'
VERDICT='<pass|concerns|conflict>'
# The verdict the ensemble result records: VERDICT's when this stays empty,
# failed for a run that launched and did not complete.
ENSEMBLE_VERDICT=''
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
ACTIVE="$(cat "$TEXT_DIR/macro-path")" || { echo "✗ Phase 0 writes the macro's path to $TEXT_DIR/macro-path: run it first; nothing was written." >&2; exit 1; }
[ -f "$ACTIVE" ] || { echo "✗ $TEXT_DIR/macro-path names no macro file (\"$ACTIVE\"); nothing was written." >&2; exit 1; }
# Every input, before any write (C132).
case "$VERDICT" in
  pass|concerns|conflict) ;;
  *) echo "✗ VERDICT is \"$VERDICT\", not pass, concerns or conflict; nothing was written." >&2; exit 1;;
esac
case "${ENSEMBLE_VERDICT:-$VERDICT}" in
  "$VERDICT") ;;
  failed)
    if [ "$VERDICT" = conflict ]; then
      echo "✗ A run that did not complete gave no peer positions to conflict with: the plan's verdict is the local synthesis's; nothing was written." >&2
      exit 1
    fi;;
  *) echo "✗ ENSEMBLE_VERDICT is \"$ENSEMBLE_VERDICT\": leave it empty, or set it to failed; nothing was written." >&2; exit 1;;
esac
RUN_ID="$(cat "$TEXT_DIR/run-id")" || { echo "✗ Phase 1's dispatch writes the run id to $TEXT_DIR/run-id; nothing was written." >&2; exit 1; }
[ -n "$RUN_ID" ] || { echo "✗ $TEXT_DIR/run-id is empty; nothing was written." >&2; exit 1; }
RUN_MACRO="$(cat "$TEXT_DIR/run-macro")" || { echo "✗ Phase 1's dispatch writes the macro of its run to $TEXT_DIR/run-macro; nothing was written." >&2; exit 1; }
[ "$RUN_MACRO" = "$ACTIVE" ] || { echo "✗ Run $RUN_ID was dispatched for $RUN_MACRO, not for $ACTIVE: dispatch a Plan-verify run for this macro; nothing was written." >&2; exit 1; }
# A run id the dispatch could not have used (peer-runner's form, opening with
# a letter or digit so no command reads it as an option), or on a
# conflict one consensus-task and plan-set would refuse (their narrower form),
# is refused here, before the note and the result are written.
STATE_MJS="$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" node --input-type=module -e 'const { pathToFileURL } = await import("node:url"); const { isSafeConsensusRunId } = await import(pathToFileURL(process.env.STATE_MJS).href); const [id, verdict] = process.argv.slice(1); process.exitCode = (verdict === "conflict" ? isSafeConsensusRunId(id) : /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(id) && !id.includes("..")) ? 0 : 1' -- "$RUN_ID" "$VERDICT" \
  || { echo "✗ $TEXT_DIR/run-id holds \"$RUN_ID\", not a run id the verdict $VERDICT can record; nothing was written." >&2; exit 1; }
# Both text files, read by state.mjs's own reader. (The path to state.mjs goes
# by the environment: as the first argument it would make the import run
# state.mjs as a command.)
STATE_MJS="$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" node --input-type=module -e 'const { pathToFileURL } = await import("node:url"); const { readTextArgumentFile } = await import(pathToFileURL(process.env.STATE_MJS).href); const pairs = process.argv.slice(1); try { for (let i = 0; i < pairs.length; i += 2) readTextArgumentFile(pairs[i + 1], pairs[i]); } catch (err) { process.stderr.write(`✗ ${err.message}: write it with your file-writing tool first; nothing was written.\n`); process.exitCode = 1; }' \
  -- --phase-note-file "$TEXT_DIR/note.md" --summary-file "$TEXT_DIR/summary.txt" || exit 1
# On a conflict, the contested items, as consensus-task reads them: text left
# once trimmed. The shell never reads them, so no line of them runs.
CONTESTED_FILE="$TEXT_DIR/contested.md"
if [ "$VERDICT" = conflict ]; then
  node -e 'let t;try{t=require("fs").readFileSync(process.argv[1],"utf8")}catch{process.exit(1)}process.exit(t.trim()===""?1:0)' "$CONTESTED_FILE" \
    || { echo "✗ $CONTESTED_FILE is missing or blank: write the contested items there with your file-writing tool first; nothing was written." >&2; exit 1; }
fi
# The macro, read before any write: a terminal macro takes no note or result,
# and the verdict is held to what the macro's frontmatter records for the run.
# A non-conflict verdict over the plan-conflict gate plan-set bound to the run
# is refused, and so is a verdict other than the one a result already recorded
# for the run carries (ensemble-commit keeps the first). The read is checked
# apart from the parser (C110). It prints gated while the plan-conflict gate
# names this run, and open otherwise.
MACRO_JSON="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" read --workflow-path "$ACTIVE")" || { echo "✗ Could not read $ACTIVE; nothing was written." >&2; exit 1; }
RUN_GATE="$(printf '%s' "$MACRO_JSON" | node -e 'let d="";process.stdin.setEncoding("utf8").on("data",c=>d+=c).on("end",()=>{const [file,id,verdict,recorded]=process.argv.slice(1);const m=JSON.parse(d);const stop=(why)=>{process.stderr.write(`✗ ${why}; nothing was written.\n`);process.exit(1)};if(m.terminal_marker===true)stop(`${file} is terminal: a terminal macro is not revised (ADR-0062 §Decision 4)`);const gated=m.awaiting_owner_gate==="plan-conflict"&&m.awaiting_owner_run_id===id;if(verdict!=="conflict"&&gated)stop(`plan-set recorded the plan-conflict gate for run ${id}, but VERDICT is ${verdict}: run the plan-set block with the verdict ${verdict} first`);const prior=(Array.isArray(m.ensemble_results)?m.ensemble_results:[]).find((e)=>e&&e.run_id===id);if(prior&&prior.verdict!==recorded)stop(`the ensemble result of run ${id} is already recorded with the verdict ${prior.verdict}, not ${recorded}, and a recorded result is kept: dispatch a new Plan-verify run for another verdict`);process.stdout.write(gated?"gated":"open")})' -- "$ACTIVE" "$RUN_ID" "$VERDICT" "${ENSEMBLE_VERDICT:-$VERDICT}")" || exit 1

# The note is appended each time the block runs, so a rerun after a failure
# past this append records it a second time (C132). Accepted until the macro
# keeps a machine record of the run's note: telling the run's own note from a
# copy some note quotes is not done from the note's text.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host claude \
  --phase-label "Phase 1: Plan (synthesized)" \
  --phase-note-file "$TEXT_DIR/note.md" \
  --current-phase phase-2-presented \
  --next-action "Await the owner's approval of the macro plan (/orchestrator:approve); then /orchestrator:next dispatches the first ready subtask" \
  --event updated --require-open || exit 1

# Atomic three-step ensemble-results commit (pop pending → append result
# → prune). A result already recorded for the run id is kept.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ensemble-commit \
  --workflow-path "$ACTIVE" \
  --run-id "$RUN_ID" \
  --phase plan --ensemble-type plan-verify \
  --verdict "${ENSEMBLE_VERDICT:-$VERDICT}" --summary-file "$TEXT_DIR/summary.txt" \
  --completed-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" || exit 1

# ADR-0067 Decision 8 — a conflict: the contested items become the macro's
# consensus task file, now that the ensemble commit recorded the run; the
# command prints the bounded round the proposal selects. Nothing runs it. The
# round is proposed only while the plan-conflict gate names the run: once the
# owner has cleared the gate, there is no conflict left to put to a round.
if [ "$VERDICT" = conflict ]; then
  if [ "$RUN_GATE" = gated ]; then
    PROPOSED="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" consensus-task \
      --workflow-path "$ACTIVE" --host claude --run-id "$RUN_ID" \
      --text-file "$CONTESTED_FILE")" || exit $?
    echo "→ Proposed, for the owner to run before deciding: $PROPOSED" >&2
  else
    echo "→ No plan-conflict gate names run $RUN_ID (the owner has cleared it, or plan-set recorded another verdict): no consensus round is proposed." >&2
  fi
fi
```

`consensus-task` refuses unless the ensemble commit recorded the run with the
verdict `conflict`.

**Note on auto-archive**: `/orchestrator:plan` does not set terminal markers. Macro auto-archive A1-A4 runs from the Stop hook/manual Codex helper after later lifecycle commands (`/orchestrator:done`, `/orchestrator:finalize`, or `/orchestrator:abort`) make the macro terminal.

**Note on empty subtasks[]**: a plan with zero subtasks (a deliberate "no work needed" terminal plan) is valid. `plan-set` accepts an empty list; the workflow stays open for a future `/orchestrator:plan` revision.

---

## Completion

After user approval of the synthesized plan, output the macro plan and one of:

- `✓ Plan complete.` + path to the workflow file.
- `✓ Plan complete (LOCAL-ONLY).` + note that Codex peer was unavailable; recommend re-running once `/codex:setup` is configured.
- `✓ Plan paused (CONFLICT items surfaced).` — when synthesizer flagged disagreements that warrant user input before subtasks land. The macro is at `awaiting_owner_gate=plan-conflict`, with the Plan-verify run id and its consensus task file: a bounded consensus round is proposed first (the command the Phase 2 block printed), then the owner revises the plan (`/orchestrator:plan`), or decides the conflict, clears the gate with `state.mjs awaiting-owner-clear --gate plan-conflict`, and approves.

Every completed plan is **pending approval** until the owner runs `/orchestrator:approve`.

Always include the workflow path.

Then emit an **Active Next-Action Proposal** instead of a fixed next command, per
`core/skills/_shared/references/session-handoff.md § Active Next-Action Proposal`
(canonical: `entry-routing-contract.md § Active Next-Action Proposal` in the
engineer plugin) — the canonical six-field template (runtime
completion-output contract):

```
- selected_next:         <macro action | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + Standards/Root-Cause gate>
- evidence_pointers:     <macro plan / subtask states / phase notes — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /orchestrator:<command> … — or the wait / owner-decision action>
```

For a freshly written plan the typical `selected_next` is the owner's approval,
`/orchestrator:approve` — under ADR-0063's autopilot `/orchestrator:next`
dispatches only an approved plan (D6), while an interactive
`/orchestrator:next` does not require it and only warns about a plan pending
approval —
and for an approved plan it is
`/orchestrator:next` to dispatch the first unblocked subtask (lowest-id entry with
`status=pending` and empty `blocked_by`; a subtask unblocks when all its
`blocked_by` predecessors reach `status=completed` — drive in dependency order) —
but a zero-subtask plan or a surfaced CONFLICT routes to the honest next step (an
owner decision on the conflict, or closing the empty plan), never a hardcoded
literal.

Plan's single proposal takes the first that applies (ADR-0067 Decision 8,
item 2): conflict resolution, then approval. A plan pending approval selects
`/orchestrator:approve`, rejecting `/orchestrator:next` (an autopilot dispatches
only an approved plan, and an interactive one only warns); a plan whose approval
still holds selects `/orchestrator:next`. The `- lane_advice:` line, when
`lane-advice` printed one, follows the six fields of either: it names the
subtasks that could run side by side and the
`/orchestrator:autopilot start --execute --macro <id> --lanes 2` that would run
them so, or says the state-root cutover comes first. It never replaces the
selection.

**The conflict branch (ADR-0067 Decision 8).** A Plan-verify verdict of
`conflict` takes precedence over approval: `selected_next` is the owner's
decision after a bounded consensus round; `next_command` is the command the
Phase 2 block printed, `/runtime:consensus plan --task-file <the absolute
path of the macro's task file> --peers claude,codex --max-rounds 2` (the
phase note spells the file from the state root,
`.agentic-plugins/state/orchestrator/consensus/<macro-id>.<run-id>.md`); and
`rejected_alternatives` include "the owner decides now", with the reason for
this case. The proposal is display only: the owner runs the round, then
revises the plan or clears `plan-conflict` and approves. Clearing the gate,
or a re-plan, retires the task file. Under autopilot the driver halts
`plan-unapproved` and its report carries the same command.

Append the runtime completion footer after the workflow path. Use the
runtime footer helper when available, or render the same fields manually:
context state, completion state plus state-derived next action, workflow
id/path, artifact pointers, recommended next work, and next-session
action/command or prompt pointer. The footer is advisory
and pointer-only; do not mutate host session context or paste raw peer /
consensus output into the main session.

Before rendering the footer, surface the ADR-0031 session-level
continue-vs-fresh preflight per
`core/skills/_shared/references/session-handoff.md`: compute the orchestrator macro
projection (resolved across branches via find-active then find-macro) and pass
it to the runtime footer/check (`--workflow-projection-file`) so the footer
carries the continue-vs-fresh decision. On detached HEAD, report "no active
branch context" — do not auto-recommend a fresh session.
