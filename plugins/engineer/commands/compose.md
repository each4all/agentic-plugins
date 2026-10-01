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

Plugin root: each shell block below opens by setting `$CLAUDE_PLUGIN_ROOT` —
from `AGENTIC_ENGINEER_ROOT` when that is set, else from the plugin path
Claude Code writes into this command when it loads it, else from the newest
version in the plugin cache. Keep that opening line when you run a block: a
shell variable does not outlive a Bash call.

---

## Phase 0 — Workflow continuity (per ADR-0011 §5)

```bash
CLAUDE_PLUGIN_ROOT="${AGENTIC_ENGINEER_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/engineer -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel)"
GIT_BRANCH="$(git branch --show-current)"
# ADR-0018 §sub-2 — engineer workflows are anchored to a branch;
# detached HEAD has no branch context to anchor to.
if [ -z "$GIT_BRANCH" ]; then
  echo "✗ Detached HEAD detected — engineer workflows are anchored to a branch (ADR-0018 §sub-2)." >&2
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

- Empty → bootstrap with verb=compose:

  ```bash
  CLAUDE_PLUGIN_ROOT="${AGENTIC_ENGINEER_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
  [ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/engineer -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
  GIT_BRANCH="$(git branch --show-current)"
  GIT_HEAD="$(git rev-parse HEAD)"
  STATUS_DIGEST="$(git status --porcelain=v1 -z --untracked-files=normal | shasum -a 256 | cut -d' ' -f1)"
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
  CLAUDE_PLUGIN_ROOT="${AGENTIC_ENGINEER_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
  [ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/engineer -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --verb compose \
    --profile "<profile or empty>" \
    --phase-label "Phase 0: Resume into compose" \
    --phase-note "Resumed from prior verb. Profile=<...>." \
    --current-phase phase-0-resume \
    --clear-next-step true \
    --next-action "Run compose skill" --event resumed || exit $?
  ```

---

## Phase 1 — Execute compose

Follow the compose skill's command-invoked mode at
`${CLAUDE_PLUGIN_ROOT}/core/skills/compose/SKILL.md`. Profiles:

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
`core/skills/compose/SKILL.md` § Layer 2 commit-manifest recording for the
full pattern (ADR-0028 §Layer-2).

### Ensemble dispatch (Plan-verify point type)

Build the Plan-verify prompt per
`core/skills/_shared/references/ensemble-protocol.md` § Plan-verify
(reuse the same template for `code` profile, substituting the draft
plan with the diff or list of written files):

Run this block **as a host background task** — on Claude, the Bash tool's
`run_in_background` — never with a trailing `&`: the host then tracks the
task and notifies you when the runner exits (ADR-0063 D5; a shell `&` would
detach the runner where neither you nor an autopilot host can wait for it).

```bash
CLAUDE_PLUGIN_ROOT="${AGENTIC_ENGINEER_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/engineer -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
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
  > "$PROMPT_FILE.run.json" 2> "$PROMPT_FILE.err"
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
CLAUDE_PLUGIN_ROOT="${AGENTIC_ENGINEER_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/engineer -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
NOTE="### Ensemble launched: compose at <iso-utc>

### Ensemble synthesis: compose (profile=<plan|code>) verdict=<...>

<AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown>

### Artifact

<plan: TDD task list, dependencies, success criteria
 OR code: list of changed files with one-line summary each>

### Active next-action proposal

(per core/skills/_shared/references/entry-routing-contract.md
 § Active Next-Action Proposal — derived from this artifact, not a fixed table)
- selected_next:         <verb | commit | owner decision | done>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + Standards/Root-Cause gate>
- evidence_pointers:     <phase notes / files / artifacts — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /engineer:<verb> … or \$engineer:<verb> for a verb; /engineer:commit for commit or done; the owner-decision action otherwise>
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
  --event updated || exit $?

# ADR-0017 §sub-decision 4 — atomic three-step ensemble-results commit
# (pop pending → append result → prune). $VERDICT is the synthesizer's
# agree|modify|conflict verdict; $SUMMARY is a one-line résumé of the
# AGREED/LOCAL-ONLY/PEER-ONLY/CONFLICT breakdown (~200 chars).
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ensemble-commit \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase compose --ensemble-type plan-verify --run-id "$RUN_ID" \
  --verdict "$VERDICT" --summary "$SUMMARY" \
  --completed-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" || exit $?

# ADR-0063 D3 — the verb's last write, `finish-verb`. Interactive: the
# ADR-0017 §sub-decision 5 atomic terminal write — current_phase
# summary-complete (in the auto-archive whitelist) + terminal_marker=true, so
# the Stop hook can archive once HEAD has moved — plus the next step. Under an
# autopilot run: the next step only; the terminal marker is left for
# /engineer:commit. The --next-step-* flags are the closed-enum form of the
# proposal's selected_next and confidence
# (core/skills/_shared/references/autopilot-mode.md § next_step): kind
# verb|commit|owner-decision|done, and --next-step-verb only with kind verb.
# The values shown are the typical case; set them from the proposal above.
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
  --next-action "Critique the composed artifact" \
  --next-step-kind verb --next-step-verb critique \
  --next-step-confidence "<HIGH|MEDIUM|LOW>"
```

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
  only; interactively the user acts). Record the gate with Phase 2's
  `finish-verb --next-step-kind owner-decision --owner-gate <gate>
  --owner-gate-anchor <anchor>` after a phase note under the heading the gate
  table names (`autopilot-mode.md` § Owner gates).
- **Peers.** Collect the ensemble as `ensemble-protocol.md` § Step 2 says:
  wait for the background notification; never sleep-poll.

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

Then emit an **Active Next-Action Proposal** instead of a fixed next
verb, per `core/skills/_shared/references/entry-routing-contract.md`
§ Active Next-Action Proposal — the canonical six-field template
(runtime completion-output contract):

```
- selected_next:         <verb | commit | owner decision | done>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + Standards/Root-Cause gate>
- evidence_pointers:     <phase notes / files / artifacts — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /engineer:<verb> … or $engineer:<verb> for a verb; /engineer:commit for commit or done; the owner-decision action otherwise>
```

Typical `selected_next` candidates for compose:
`/engineer:critique` to review the artifact — or, for a completed `plan`
profile, `/engineer:compose --profile=code` to implement it; the routing
table is the fallback only when evidence is genuinely neutral — do not end
with a hardcoded "next: X". When `selected_next` is `engineer:decide`, also
name the decision size (`--size=minor|standard|major`) per the contract.

Always include the workflow path.

The runtime completion footer is **code-emitted** on this verb's terminal path
(ADR-0039): the terminal write `state.mjs finish-verb` makes in interactive
mode fires the ADR-0031 session-handoff sidecar,
which shells out to the runtime `footer.mjs` and prints the rendered footer —
context state, completion state + state-derived next action, workflow id/path,
artifact pointers, recommended next work, and the continue-vs-fresh
session-handoff — on that command's **stderr**. Do **not** hand-compose a second
footer here; surface the one the terminal command already emitted. The footer is
advisory + pointer-only and fail-closed (a missing/too-old runtime emits
nothing, and the SessionStart backstop still re-surfaces the handoff); it never
mutates host session context. On detached HEAD the sidecar reports "no active
branch context" and does not auto-recommend a fresh session. Under an
autopilot run `finish-verb` makes no terminal write, so no footer is printed:
the driver is the handoff.
