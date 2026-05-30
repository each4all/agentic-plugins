---
description: Produce the artifact — plan, code, brief, interface, prompt, spec — engineer's composition verb
argument-hint: --profile=plan|code | (or natural-language composition target)
---

# Engineer · Compose

$ARGUMENTS

Use `TaskCreate` and `TaskUpdate` to track progress. The peer ensemble
runs automatically per
`skills/_shared/references/ensemble-protocol.md` (Plan-verify point
type — applies to both `plan` and `code` profiles per the section's
generalized intro). Never ask the user whether to invoke the peer.
When the companions plugin or peer CLI is unavailable, the ensemble
degrades silently to local-only.

Plugin root: `$CLAUDE_PLUGIN_ROOT` (fallback as in
commands/investigate.md).

---

## Phase 0 — Workflow continuity (per ADR-0011 §5)

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
GIT_BRANCH="$(git branch --show-current)"
# ADR-0018 §sub-2 — engineer workflows are anchored to a branch;
# detached HEAD has no branch context to anchor to.
if [ -z "$GIT_BRANCH" ]; then
  echo "✗ Detached HEAD detected — engineer workflows are anchored to a branch (ADR-0018 §sub-2)." >&2
  echo "  Switch to a branch first: git switch <branch>" >&2
  exit 1
fi
FIND_ERR="${TMPDIR:-/tmp}/engineer-find-active-$$.err"
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

- Empty → bootstrap with verb=compose:

  ```bash
  GIT_BRANCH="$(git branch --show-current)"
  GIT_HEAD="$(git rev-parse HEAD)"
  STATUS_DIGEST="$(git status --porcelain=v1 -z | shasum -a 256 | cut -d' ' -f1)"
  # ADR-0019 §1+§3 — when /orchestrator:next dispatches this command,
  # it sets AGENTIC_PARENT_WORKFLOW + AGENTIC_ORIGINATING_SUBTASK so
  # the create-time bootstrap records the immutable parent linkage.
  # Both must be set together (or both absent for direct invocation).
  PARENT_ARGS=()
  if [ -n "${AGENTIC_PARENT_WORKFLOW:-}" ] || [ -n "${AGENTIC_ORIGINATING_SUBTASK:-}" ]; then
    if [ -z "${AGENTIC_PARENT_WORKFLOW:-}" ] || [ -z "${AGENTIC_ORIGINATING_SUBTASK:-}" ]; then
      echo "✗ AGENTIC_PARENT_WORKFLOW and AGENTIC_ORIGINATING_SUBTASK must be set together (ADR-0019 §3 immutable parent-child linkage). This usually indicates a dispatcher bug — /orchestrator:next must export both env vars or neither. If you set them manually, set both or neither." >&2
      exit 1
    fi
    PARENT_ARGS=(--parent-workflow "$AGENTIC_PARENT_WORKFLOW" --originating-subtask "$AGENTIC_ORIGINATING_SUBTASK")
  fi
  ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" create \
    --repo-root "$REPO_ROOT" \
    --verb compose --host "${AGENTIC_HOST:-claude}" --persona engineer \
    --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
    --status-digest "$STATUS_DIGEST" \
    --profile "${AGENTIC_PROFILE:-<profile from \$ARGUMENTS or 'plan'>}" \
    --original-request "${AGENTIC_TOPIC:-<one-line scrubbed user request>}" \
    --current-phase phase-0-bootstrap \
    --next-action "Run compose skill" \
    "${PARENT_ARGS[@]}")"
  ```

- Non-empty → append-on-resume:

  ```bash
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --verb compose \
    --profile "<profile or empty>" \
    --phase-label "Phase 0: Resume into compose" \
    --phase-note "Resumed from prior verb. Profile=<...>." \
    --current-phase phase-0-resume \
    --next-action "Run compose skill" --event resumed
  ```

---

## Phase 1 — Execute compose

Follow the compose skill's command-invoked mode at
`$CLAUDE_PLUGIN_ROOT/skills/compose/SKILL.md`. Profiles:

- `plan` (default) — produce a TDD task list with dependencies and
  success criteria.
- `code` — write the actual implementation files; run tests where
  applicable.

Profile selection: `--profile=<name>` on the command, else inferred
from the user's intent. Missing profile → `plan`. Unknown profile →
fallback to `plan` with one-line warning.

Core principle: a plan precedes code. Code without a confirmed plan
is speculation; code with a plan is verifiable task-by-task.

For `code` profile in command-mode (`$ACTIVE` bound), the skill's
**Layer 2 commit-manifest recording** step requires
`state.mjs record-composed-file --workflow-path "$ACTIVE" --path <p>
--op create|edit` after each Write/Edit on a tracked path. See
`skills/compose/SKILL.md` § Layer 2 commit-manifest recording for the
full pattern (ADR-0028 §Layer-2).

### Ensemble dispatch (Plan-verify point type)

Build the Plan-verify prompt per
`skills/_shared/references/ensemble-protocol.md` § Plan-verify
(reuse the same template for `code` profile, substituting the draft
plan with the diff or list of written files):

```bash
PROMPT_FILE="$(mktemp -t engineer-compose-prompt.XXXXXX).xml"
# ADR-0017 §sub-decision 4 — generate a stable run-id BEFORE dispatch
# so the pending entry, the peer's eventual result, and the
# ensemble-commit call all share the same key.
RUN_ID="plan-verify-$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%06x' $((RANDOM*RANDOM & 0xffffff)))"
# ... LLM writes the Plan-verify XML prompt to $PROMPT_FILE ...
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" run \
  --repo-root "$REPO_ROOT" --kind ensemble \
  --peer codex --prompt-file "$PROMPT_FILE" --output-format json \
  --workflow-path "$ACTIVE" --phase compose \
  --host "${AGENTIC_HOST:-claude}" --cwd "$REPO_ROOT" \
  --ensemble-type plan-verify --run-id "$RUN_ID" \
  > "$PROMPT_FILE.run.json" 2> "$PROMPT_FILE.err" &
```

The four bookkeeping flags (`--workflow-path`, `--phase`,
`--ensemble-type`, `--run-id`) cause `peer-runner.mjs run` to record a
`pending_ensemble` entry under the workflow file's per-file lock BEFORE
spawning the companion (ADR-0017 §sub-decision 4). The runner writes
raw peer output under the hidden peer-run ledger and emits a small JSON
result to `$PROMPT_FILE.run.json` with `envelope_path`, `stdout_path`,
`stderr_path`, and `handle_path`. After synthesis, Phase 2 invokes
`state.mjs ensemble-commit` with the same `--run-id` to atomically pop
the pending entry, append the result to `ensemble_results`, and prune
to the retention cap.

Independence exception (per ensemble-protocol.md § Independence
Rule): the peer DOES receive the orchestrator's draft plan as input
for this point type — its job is to find gaps in that specific plan.

Synthesize per AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT
categories. Gaps and ordering issues from the peer go directly into
the artifact's revision.

---

## Phase 2 — State finalize

```bash
NOTE="### Ensemble launched: compose at <iso-utc>

### Ensemble synthesis: compose (profile=<plan|code>) verdict=<...>

<AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown>

### Artifact

<plan: TDD task list, dependencies, success criteria
 OR code: list of changed files with one-line summary each>

### Active next-action proposal

(per skills/_shared/references/entry-routing-contract.md
 § Active Next-Action Proposal — derived from this artifact, not a fixed table)
- selected_next:         <verb | commit | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + Standards/Root-Cause gate>
- evidence_pointers:     <phase notes / files / artifacts — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact /engineer:<verb> … or \$engineer:<verb>>
"

# ADR-0029 §1 — set --next-action (both writes below) to the compact form
# of the proposal above (selected_next + one-line why + next_command) so the
# durable state and the state-derived completion footer agree with the Active
# Next-Action Proposal. The value shown is the typical-case default; override
# it when the verb's result selects a different next step (e.g. commit).
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase-label "Phase 1: Compose (synthesized)" \
  --phase-note "$NOTE" \
  --current-phase phase-2-presented \
  --next-action "Critique the composed artifact" \
  --event updated

# ADR-0017 §sub-decision 4 — atomic three-step ensemble-results commit
# (pop pending → append result → prune). $VERDICT is the synthesizer's
# agree|modify|conflict verdict; $SUMMARY is a one-line résumé of the
# AGREED/LOCAL-ONLY/PEER-ONLY/CONFLICT breakdown (~200 chars).
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ensemble-commit \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase compose --ensemble-type plan-verify --run-id "$RUN_ID" \
  --verdict "$VERDICT" --summary "$SUMMARY" \
  --completed-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ADR-0017 §sub-decision 5 — atomic terminal write. Bumps current_phase
# into the auto-archive whitelist + sets terminal_marker=true so the
# Stop hook can archive once the user commits and closes the session
# (HEAD-moved gate enforces real progress before archive triggers).
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" set-terminal \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --terminal-phase summary-complete \
  --terminal-marker true \
  --next-action "Critique the composed artifact" \
  --event updated
```

---

## Completion

Output the artifact (plan or change set) and one of:

- `✓ Plan complete.` + path/anchor to the artifact.
- `✓ Code change complete.` + summary of edited files.
- `✓ Compose paused (gaps surfaced).` — when peer flagged
  significant gaps or ordering issues that warrant user input
  before proceeding.

Then emit an **Active Next-Action Proposal** instead of a fixed next
verb, per `skills/_shared/references/entry-routing-contract.md`
§ Active Next-Action Proposal: **selected_next**, **rejected_alternatives**
(1-2 + why-not), **rationale** (decisive axes 본질/근본 essence/foundation +
the Standards/Root-Cause gate), **evidence_pointers** (pointers only),
**confidence** (HIGH/MEDIUM/LOW), and **next_command** (`/engineer:<verb> …`
or `$engineer:<verb>`). Typical `selected_next` candidates for compose:
`/engineer:critique` to review the artifact — or, for a completed `plan`
profile, `/engineer:compose --profile=code` to implement it; the routing
table is the fallback only when evidence is genuinely neutral — do not end
with a hardcoded "next: X". When `selected_next` is `engineer:decide`, also
name the decision size (`--size=minor|standard|major`) per the contract.

Always include the workflow path.

Append the runtime completion footer after the workflow path. Use the
runtime footer helper when available, or render the same fields manually:
context state, completion state plus state-derived next action, workflow
id/path, artifact pointers, recommended next work, and next-session
action/command or prompt pointer. The footer is advisory
and pointer-only; do not mutate host session context or paste raw peer /
consensus output into the main session.
