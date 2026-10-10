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

---

## Phase 0 — Workflow continuity (per ADR-0011 §5 + ADR-0018 §sub-2)

```bash
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
```

- Empty → bootstrap with verb=plan:

  ```bash
  CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
  [ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
  GIT_HEAD="$(git rev-parse HEAD)"
  STATUS_DIGEST="$(git status --porcelain=v1 -z --untracked-files=normal | shasum -a 256 | cut -d' ' -f1)"
  ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" create \
    --repo-root "$REPO_ROOT" \
    --verb plan --host claude \
    --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
    --status-digest "$STATUS_DIGEST" \
    --original-request "<one-line scrubbed user feature description>" \
    --current-phase phase-0-bootstrap \
    --next-action "Run plan skill")"
  ```

- Non-empty → append-on-resume. `--require-open` makes the append itself
  refuse a macro whose `terminal_marker` is set, under the same lock as the
  write (ADR-0062 §Decision 4): this append and the Phase 2 append both
  rewrite `current_phase`, which would leave the marker set with a phase the
  archive gate rejects. A separate check before the append would race a
  `/orchestrator:finalize` in another session. On refusal, stop: archive the
  macro with `/orchestrator:resume archive` and plan the new work afresh.

  ```bash
  CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
  [ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
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

### Ensemble dispatch (Plan-verify point type)

Build the Plan-verify prompt per `${CLAUDE_PLUGIN_ROOT}/core/skills/_shared/references/ensemble-protocol.md` § Plan-verify. The peer receives the orchestrator's draft plan as `<inputs><input name="feature_description">…</input><input name="draft_plan">…</input></inputs>` (Independence Rule exception per protocol). The `<grounding_rules>` section MUST include the schema 1.1 constraints so peer-emitted plan revisions don't bypass validation: every subtask requires `verb` (canonical 6-verb whitelist: investigate / frame / decide / compose / critique / refine) AND `branch` (git ref-format), plus `id` (unique) / `blocked_by` (array of existing ids forming a DAG — self-reference, mutual `A<->B`, and longer cycles are rejected) / `status` (`pending|blocked|in_progress|completed|deferred|abandoned`) per ADR-0019 §2.

```bash
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PROMPT_FILE="$(mktemp -t orchestrator-plan-prompt.XXXXXX).xml"
# Generate a stable run-id BEFORE dispatch so the pending entry, the
# peer's eventual result, and the ensemble-commit call all share the
# same key.
RUN_ID="macro-plan-$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%06x' $((RANDOM*RANDOM & 0xffffff)))"
# ... LLM writes the Plan-verify XML prompt to $PROMPT_FILE ...
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" run \
  --repo-root "$REPO_ROOT" --kind ensemble \
  --peer codex --prompt-file "$PROMPT_FILE" --output-format json \
  --workflow-path "$ACTIVE" --phase plan \
  --ensemble-type plan-verify --run-id "$RUN_ID" \
  --host "${AGENTIC_HOST:-claude}" --cwd "$REPO_ROOT" \
  > "$PROMPT_FILE.run.json" 2> "$PROMPT_FILE.err" &
```

The four bookkeeping flags (`--workflow-path`, `--phase`, `--ensemble-type`, `--run-id`) cause `peer-runner.mjs run` to:

1. Resolve the companion script (`peer codex`) via `companions/discover-peer.mjs`.
2. **If companion missing** → return `peer_cli_not_found`, create no peer-run ledger, and record NO `pending_ensemble` entry (orchestrator-specific graceful-degradation order). Caller proceeds with a LOCAL-ONLY plan.
3. **If companion present** → create `.agentic-plugins/state/orchestrator/peer-runs/<run_id>/` for new repos (or the legacy peer-run home until explicit migration), record a `pending_ensemble` entry under the workflow file's per-file lock, then spawn the companion.
4. Tee stdout/stderr to bounded ledger files, write the final JSON envelope to `envelope.json`, and print machine-readable run metadata to `$PROMPT_FILE.run.json`.

After synthesis, Phase 2 invokes `state.mjs ensemble-commit` with the same `--run-id` to atomically pop the pending entry (no-op if companion was missing), append the result to `ensemble_results`, and prune to the retention cap.

Synthesize per AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT categories (host-agnostic per orchestrator ensemble-protocol). Gaps and ordering issues from the peer go directly into the plan revision; CONFLICT items surface for user decision.

---

## Phase 2 — State finalize (setPlan + ensemble-commit)

Materialize the synthesized subtasks into a JSON file and call `plan-set`:

```bash
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
SUBTASKS_JSON="$(mktemp -t orchestrator-subtasks.XXXXXX).json"
# ... LLM writes the synthesized subtasks array (top-level JSON array
# of subtask objects matching the ADR-0018 §sub-1 schema) to $SUBTASKS_JSON ...

# ADR-0067 Decision 8 — a conflict records the Plan-verify run with its gate,
# plan-conflict, in the plan's own write; any other verdict records none.
PLAN_RUN_ID=''
if [ "$VERDICT" = conflict ]; then PLAN_RUN_ID="${RUN_ID:-}"; fi
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" plan-set \
  --workflow-path "$ACTIVE" --host claude \
  --subtasks-json-file "$SUBTASKS_JSON" \
  --decision "<one-line decision rationale>" \
  --architecture "<one-line architecture summary>" \
  --verdict "$VERDICT" --run-id "$PLAN_RUN_ID" \
  --event updated
```

`$VERDICT` is the synthesized Plan-verify verdict (`pass`, `concerns` or
`conflict`), the same value the ensemble commit below records, and `$RUN_ID`
the run id the dispatch generated. A LOCAL-ONLY
plan (no peer) still has one: the local synthesis's own `pass` or
`concerns`. `plan-set` refuses an empty or unknown verdict. On `conflict` the
gate records `$RUN_ID` (ADR-0067 Decision 8), and before the write every
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
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" lane-advice \
  --workflow-path "$ACTIVE" --repo-root "$REPO_ROOT" --format line
```

Then record the phase note + ensemble result:

```bash
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
NOTE="### Ensemble launched: plan at <iso-utc>

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
- next_command:          <exact next step: /orchestrator:next … (dispatch first ready subtask) or \$orchestrator:next on Codex; the finalize / owner-decision action otherwise>
<the - lane_advice: line lane-advice printed above, verbatim, or nothing when it printed none>
"

node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host claude \
  --phase-label "Phase 1: Plan (synthesized)" \
  --phase-note "$NOTE" \
  --current-phase phase-2-presented \
  --next-action "Await the owner's approval of the macro plan (/orchestrator:approve); then /orchestrator:next dispatches the first ready subtask" \
  --event updated --require-open || exit 1

# Atomic three-step ensemble-results commit (pop pending → append result
# → prune). $VERDICT is one of pass | concerns | conflict; $SUMMARY is a
# one-line résumé of the AGREED/LOCAL-ONLY/PEER-ONLY/CONFLICT breakdown
# (~200 chars).
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ensemble-commit \
  --workflow-path "$ACTIVE" \
  --run-id "$RUN_ID" \
  --phase plan --ensemble-type plan-verify \
  --verdict "$VERDICT" --summary "$SUMMARY" \
  --completed-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" || exit 1

# ADR-0067 Decision 8 — a conflict: the contested items become the macro's
# consensus task file, now that the ensemble commit recorded the run; the
# command prints the bounded round the proposal selects. Nothing runs it.
if [ "$VERDICT" = conflict ]; then
  # The contested items, from the file CONTESTED_FILE names, written with the
  # file tool: the shell never reads them, so no line of them runs as a
  # command. consensus-task refuses an empty file.
  [ -n "${CONTESTED_FILE:-}" ] || { echo "✗ CONTESTED_FILE names no file of contested items; no task file was written." >&2; exit 1; }
  PROPOSED="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" consensus-task \
    --workflow-path "$ACTIVE" --host claude --run-id "$RUN_ID" \
    --text-file "$CONTESTED_FILE")" || exit $?
  echo "→ Proposed, for the owner to run before deciding: $PROPOSED" >&2
fi
```

On a `conflict`, before the block, write the contested items with the file
tool to a new file and set `CONTESTED_FILE` to its path: each CONFLICT item,
both positions and their evidence, prepared as the Plan-verify prompt was,
since the consensus peers read the file. They come from the peer's positions,
so never put them in the block, where the shell would read a line of them as
a command. `consensus-task` refuses unless the ensemble commit recorded the run
with the verdict `conflict`, and refuses empty text.

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
