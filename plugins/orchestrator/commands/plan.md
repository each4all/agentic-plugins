---
description: Macro plan + Plan-verify Codex peer ensemble — produce plan.subtasks[] for a multi-deliverable feature
argument-hint: <feature description>
---

# Orchestrator · Plan

$ARGUMENTS

Use `TaskCreate` and `TaskUpdate` to track progress. The peer ensemble runs automatically per `skills/_shared/references/ensemble-protocol.md` (Plan-verify point type). Never ask the user whether to invoke the peer. When the companions plugin or peer CLI is unavailable, the ensemble degrades silently to a LOCAL-ONLY plan (`peer-runner.mjs run` returns `peer_cli_not_found` with no peer-run ledger or orphan-pending entry — orchestrator-specific graceful degradation contract).

Plugin root: `$CLAUDE_PLUGIN_ROOT` is the orchestrator plugin's resolved root. Fallback: discover via `find ~/.claude/plugins/cache/agentic-plugins/orchestrator -maxdepth 3 -name plugin.json` SemVer walk if `$CLAUDE_PLUGIN_ROOT` is unset.

---

## Phase 0 — Workflow continuity (per ADR-0011 §5 + ADR-0018 §sub-2)

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
GIT_BRANCH="$(git branch --show-current)"
# ADR-0018 §sub-2 — orchestrator workflows are anchored to a branch;
# detached HEAD has no branch context to anchor to.
if [ -z "$GIT_BRANCH" ]; then
  echo "✗ Detached HEAD detected — orchestrator workflows are anchored to a branch (ADR-0018 §sub-2)." >&2
  echo "  Switch to a branch first: git switch <branch>" >&2
  exit 1
fi
FIND_ERR="${TMPDIR:-/tmp}/orchestrator-find-active-$$.err"
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
  find-active --repo-root "$REPO_ROOT" 2>"$FIND_ERR")"
FIND_RC=$?
if [ "$FIND_RC" -ne 0 ]; then
  echo "✗ find-active failed (exit $FIND_RC):" >&2
  cat "$FIND_ERR" >&2
  rm -f "$FIND_ERR"
  exit "$FIND_RC"
fi
rm -f "$FIND_ERR"
```

- Empty → bootstrap with verb=plan:

  ```bash
  GIT_HEAD="$(git rev-parse HEAD)"
  STATUS_DIGEST="$(git status --porcelain=v1 -z | shasum -a 256 | cut -d' ' -f1)"
  ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" create \
    --repo-root "$REPO_ROOT" \
    --verb plan --host claude \
    --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
    --status-digest "$STATUS_DIGEST" \
    --original-request "<one-line scrubbed user feature description>" \
    --current-phase phase-0-bootstrap \
    --next-action "Run plan skill")"
  ```

- Non-empty → append-on-resume:

  ```bash
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
    --workflow-path "$ACTIVE" --host claude \
    --phase-label "Phase 0: Resume macro plan" \
    --phase-note "Resumed prior orchestrator plan workflow." \
    --current-phase phase-0-resume \
    --next-action "Run plan skill" --event resumed
  ```

`createWorkflowUnderLock` rejects same-branch duplicates per ADR-0018 §sub-2 — concurrent `/orchestrator:plan` invocations on the same branch race the directory lock, and the loser sees a clear error message pointing at the existing workflow.

---

## Phase 1 — Execute plan skill (decompose + dependency graph)

Follow the plan skill's command-invoked mode at `$CLAUDE_PLUGIN_ROOT/skills/plan/SKILL.md`. Produce a draft `plan.subtasks[]` per ADR-0018 §sub-decision-1 + ADR-0019 §2 schema (1.1):

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

Validation runs at the `state.mjs plan-set` boundary (id non-empty + unique, blocked_by → existing id only, no self-cycle, status enum, verb in canonical 6-verb whitelist, branch passes git ref-format gate per ADR-0019 §1: no spaces, no leading `.`, no `..`, no `~ ^ : ? * [ \\`, no trailing `/` or `.lock`, branches unique across subtasks, no parent/child path-prefix relationship between any two subtask branches — e.g., `feat/api` and `feat/api/db` cannot coexist; pick siblings like `feat/api/db` + `feat/api/auth` instead).

### Ensemble dispatch (Plan-verify point type)

Build the Plan-verify prompt per `$CLAUDE_PLUGIN_ROOT/skills/_shared/references/ensemble-protocol.md` § Plan-verify. The peer receives the orchestrator's draft plan as `<inputs><input name="feature_description">…</input><input name="draft_plan">…</input></inputs>` (Independence Rule exception per protocol). The `<grounding_rules>` section MUST include the schema 1.1 constraints so peer-emitted plan revisions don't bypass validation: every subtask requires `verb` (canonical 6-verb whitelist: investigate / frame / decide / compose / critique / refine) AND `branch` (git ref-format), plus `id` (unique) / `blocked_by` (array) / `status` (`pending|blocked|in_progress|completed|deferred|abandoned`) per ADR-0019 §2.

```bash
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
3. **If companion present** → create `.claude/agentic-orchestrator/peer-runs/<run_id>/`, record a `pending_ensemble` entry under the workflow file's per-file lock, then spawn the companion.
4. Tee stdout/stderr to bounded ledger files, write the final JSON envelope to `envelope.json`, and print machine-readable run metadata to `$PROMPT_FILE.run.json`.

After synthesis, Phase 2 invokes `state.mjs ensemble-commit` with the same `--run-id` to atomically pop the pending entry (no-op if companion was missing), append the result to `ensemble_results`, and prune to the retention cap.

Synthesize per AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT categories (host-agnostic per orchestrator ensemble-protocol). Gaps and ordering issues from the peer go directly into the plan revision; CONFLICT items surface for user decision.

---

## Phase 2 — State finalize (setPlan + ensemble-commit)

Materialize the synthesized subtasks into a JSON file and call `plan-set`:

```bash
SUBTASKS_JSON="$(mktemp -t orchestrator-subtasks.XXXXXX).json"
# ... LLM writes the synthesized subtasks array (top-level JSON array
# of subtask objects matching the ADR-0018 §sub-1 schema) to $SUBTASKS_JSON ...

node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" plan-set \
  --workflow-path "$ACTIVE" --host claude \
  --subtasks-json-file "$SUBTASKS_JSON" \
  --decision "<one-line decision rationale>" \
  --architecture "<one-line architecture summary>" \
  --event updated
```

Then record the phase note + ensemble result:

```bash
NOTE="### Ensemble launched: plan at <iso-utc>

### Ensemble synthesis: plan-verify verdict=<pass|concerns|conflict>

<AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown>

### Macro plan

<subtasks summary: ids + labels + dependency graph>

### Recommended next step

Invoke `/orchestrator:next` to dispatch the first subtask with
status=pending and empty blocked_by into engineer (ADR-0019 §1
same-host dispatch). A subtask becomes unblocked when all its
blocked_by predecessors reach status=completed; drive subtasks in
dependency order.
"

node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host claude \
  --phase-label "Phase 1: Plan (synthesized)" \
  --phase-note "$NOTE" \
  --current-phase phase-2-presented \
  --next-action "Await user approval of macro plan" \
  --event updated

# Atomic three-step ensemble-results commit (pop pending → append result
# → prune). $VERDICT is one of pass | concerns | conflict; $SUMMARY is a
# one-line résumé of the AGREED/LOCAL-ONLY/PEER-ONLY/CONFLICT breakdown
# (~200 chars).
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ensemble-commit \
  --workflow-path "$ACTIVE" \
  --run-id "$RUN_ID" \
  --phase plan --ensemble-type plan-verify \
  --verdict "$VERDICT" --summary "$SUMMARY" \
  --completed-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
```

**Note on auto-archive**: orchestrator MVP's Stop hook is **snapshot-only**. There is no `set-terminal` call here — the macro-phase A1–A4 auto-archive gate is deferred to a follow-up PR alongside `/orchestrator:done`. Until that PR lands, manual archive is by file-move once the macro plan is fully consumed.

**Note on empty subtasks[]**: a plan with zero subtasks (a deliberate "no work needed" terminal plan) is valid. `plan-set` accepts an empty list; the workflow stays open for a future `/orchestrator:plan` revision.

---

## Completion

After user approval of the synthesized plan, output the macro plan and one of:

- `✓ Plan complete.` + path to the workflow file. Recommend invoking `/orchestrator:next` to dispatch the first unblocked subtask (lowest-id entry with `status=pending` and empty `blocked_by`) into engineer. A subtask becomes unblocked when all its `blocked_by` predecessors reach `status=completed` — drive subtasks in dependency order.
- `✓ Plan complete (LOCAL-ONLY).` + note that Codex peer was unavailable; recommend re-running once `/codex:setup` is configured. Same `/orchestrator:next` driving guidance applies.
- `✓ Plan paused (CONFLICT items surfaced).` — when synthesizer flagged disagreements that warrant user input before subtasks land.

Always include the workflow path.
