---
description: Apply feedback, repair defects, iterate after critique — engineer's refinement verb
argument-hint: (fix description, finding reference, or critique scope)
---

# Engineer · Refine

$ARGUMENTS

Maintain one progress entry per phase and advance its status as you go — use the host's task-tracking tools when the session exposes them, and keep an inline checklist when it does not. The peer ensemble
runs automatically per
`core/skills/_shared/references/ensemble-protocol.md` (Refine-verify point
type) — never ask the user whether to invoke the peer. When the
companions plugin or peer CLI is unavailable, the ensemble degrades
silently to local-only.

Plugin root: each shell block below opens by setting `$CLAUDE_PLUGIN_ROOT` —
from `AGENTIC_ENGINEER_ROOT` when that is set, else from the plugin path
Claude Code writes into this command when it loads it, else from the newest
version in the plugin cache. Keep that opening line when you run a block: a
shell variable does not outlive a Bash call.

Core principle: do not modify code until the root cause is confirmed.
When refining a bug fix, the upstream contract is investigate
(root-cause profile) → decide (if 2+ fix approaches) → refine.
Skipping investigate paper-fixes symptoms.

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

- Empty → bootstrap with verb=refine:

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
    --verb refine --host "${AGENTIC_HOST:-claude}" --persona engineer \
    --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
    --status-digest "$STATUS_DIGEST" \
    --original-request "${AGENTIC_TOPIC:-<one-line scrubbed user request>}" \
    --current-phase phase-0-bootstrap \
    --next-action "Run refine skill" \
    "${PARENT_ARGS[@]}")"
  ```

- Non-empty → append-on-resume:

  ```bash
  CLAUDE_PLUGIN_ROOT="${AGENTIC_ENGINEER_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
  [ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/engineer -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --verb refine \
    --phase-label "Phase 0: Resume into refine" \
    --phase-note "Resumed from prior verb." \
    --current-phase phase-0-resume \
    --clear-next-step true \
    --next-action "Run refine skill" --event resumed || exit $?
  ```

---

## Phase 1 — Execute refine

Follow the refine skill's command-invoked mode at
`${CLAUDE_PLUGIN_ROOT}/core/skills/refine/SKILL.md`. The skill applies the
fix, runs verification (tests / lint / type-check / smoke), and
confirms the change addresses the root cause without regressions.

Refine is single-mode (no `--profile` argument). Sub-discipline
context flows through the orchestrator-level Task Profile.

In command-mode (`$ACTIVE` bound), the skill's **Layer 2
commit-manifest recording** step requires
`state.mjs record-refine-file --workflow-path "$ACTIVE" --path <p>
--op edit|create` after each Write/Edit on a tracked path. See
`core/skills/refine/SKILL.md` § Layer 2 commit-manifest recording for the
full pattern (ADR-0028 §Layer-2).

### Ensemble dispatch (Refine-verify point type)

Build the Refine-verify prompt per
`core/skills/_shared/references/ensemble-protocol.md` § Refine-verify.
The peer independently verifies that the fix addresses the symptom,
checks for over-fitting, and probes for regressions.

Run this block **as a host background task** — on Claude, the Bash tool's
`run_in_background` — never with a trailing `&`: the host then tracks the
task and notifies you when the runner exits (ADR-0063 D5; a shell `&` would
detach the runner where neither you nor an autopilot host can wait for it).

```bash
CLAUDE_PLUGIN_ROOT="${AGENTIC_ENGINEER_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/engineer -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
PROMPT_FILE="$(mktemp -t engineer-refine-prompt.XXXXXX).xml"
# ADR-0017 §sub-decision 4 — stable run-id BEFORE dispatch.
RUN_ID="refine-verify-$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%06x' $((RANDOM*RANDOM & 0xffffff)))"
# ... LLM writes the Refine-verify XML prompt to $PROMPT_FILE ...
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" run \
  --repo-root "$REPO_ROOT" --kind ensemble \
  --peer codex --prompt-file "$PROMPT_FILE" --output-format json \
  --workflow-path "$ACTIVE" --phase refine \
  --host "${AGENTIC_HOST:-claude}" --cwd "$REPO_ROOT" \
  --ensemble-type refine-verify --run-id "$RUN_ID" \
  > "$PROMPT_FILE.run.json" 2> "$PROMPT_FILE.err"
```

`peer-runner.mjs run` records the matching `pending_ensemble` row
before spawning the companion and writes raw peer output under the
hidden peer-run ledger; the background command's stdout is the small
runner JSON result (`envelope_path`, `stdout_path`, `stderr_path`,
`handle_path`). Synthesize per AGREED / LOCAL-ONLY / PEER-ONLY /
CONFLICT. Peer-flagged regressions or over-fitting concerns block
completion until addressed.

---

## Phase 2 — State finalize

```bash
CLAUDE_PLUGIN_ROOT="${AGENTIC_ENGINEER_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/engineer -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
NOTE="### Ensemble launched: refine at <iso-utc>

### Ensemble synthesis: refine verdict=<agreed|concerns|conflict>

<AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown>

### Changes applied

<list of edited files with one-line summary; test/lint/type-check status>

### Verification

<test results, regression checks, root-cause confirmation>

### Active next-action proposal

(per core/skills/_shared/references/entry-routing-contract.md
 § Active Next-Action Proposal — derived from this refinement, not a fixed table)
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
  --phase-label "Phase 1: Refine (synthesized)" \
  --phase-note "$NOTE" \
  --current-phase phase-2-presented \
  --next-action "Critique to verify, or investigate deeper if root cause is uncertain" \
  --event updated || exit $?

# ADR-0017 §sub-decision 4 — atomic three-step ensemble-results commit.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ensemble-commit \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase refine --ensemble-type refine-verify --run-id "$RUN_ID" \
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
  --next-action "Critique to verify, or investigate deeper if root cause is uncertain" \
  --next-step-kind verb --next-step-verb critique \
  --next-step-confidence "<HIGH|MEDIUM|LOW>"
# When a finding that an earlier refine pass on this workflow already
# addressed survives verification again, fixing it again is not this verb's
# call (ADR-0063 D4): first append a "Recurring finding" phase note naming it,
# then end instead with the owner's decision. This records the
# recurring-finding gate with the next step in one write, in either mode, and
# leaves the workflow open until the owner decides (Owner decision below):
# node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" finish-verb \
#   --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
#   --next-action "Owner: fix the recurring finding now or defer it" \
#   --next-step-kind owner-decision --next-step-confidence "<HIGH|MEDIUM|LOW>" \
#   --owner-gate recurring-finding --owner-gate-anchor recurring-finding
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
- **A recurring finding is the owner's.** When a finding that an earlier refine
  pass on this workflow already addressed survives verification again, stop:
  end with the owner-decision variant of `finish-verb` shown in Phase 2, which
  records the `recurring-finding` gate.
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
  wait for the background notification; never sleep-poll. A step report
  taken while you wait is provisional: when the notification re-invokes you,
  finish the verb through `finish-verb`, then report again
  (`autopilot-mode.md` § Peer ensembles).

---

## Owner decision (recurring-finding)

The `recurring-finding` gate is resolved by the owner's decision (ADR-0063
Q2): in this session right after the refine stopped on it, or later, when
Phase 0's preflight reports it pending. Present the finding recorded at the
gate's pointer — the latest `Recurring finding` note — and ask: fix it now,
or defer it. The clear records the owner's decision (`--resolution`) and the
next step it implies in one write, so the next step never becomes runnable
without the decision, and a failure never leaves the gate's `owner-decision`
behind.

- **Fix now** → clear the gate with this refine as the next step, then run
  the phases above on that finding, as usual:

  ```bash
  CLAUDE_PLUGIN_ROOT="${AGENTIC_ENGINEER_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
  [ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/engineer -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
  REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
  ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
  [ -n "$ACTIVE" ] || { echo "✗ No active engineer workflow on this branch." >&2; exit 1; }
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" awaiting-owner-clear \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --gate recurring-finding \
    --resolution "Owner decision: fix <the finding> now" \
    --next-step-kind verb --next-step-verb refine --next-step-confidence HIGH
  ```

- **Defer** → clear the gate with the deferral and `commit` (or the next step
  the owner picks) as the next step, then end the verb:

  ```bash
  CLAUDE_PLUGIN_ROOT="${AGENTIC_ENGINEER_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
  [ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/engineer -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
  REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
  ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" find-active --repo-root "$REPO_ROOT")" || exit $?
  [ -n "$ACTIVE" ] || { echo "✗ No active engineer workflow on this branch." >&2; exit 1; }
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" awaiting-owner-clear \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --gate recurring-finding \
    --resolution "Owner decision: defer <the finding> — <the owner's reason, and where it is tracked>" \
    --next-step-kind commit --next-step-confidence HIGH || exit $?
  # ARCHIVE TIMING — this finish-verb is a terminal write interactively: on
  # Claude the Stop hook fires at EVERY turn end, so the archive gates are
  # evaluated at the end of THIS turn (they pass once HEAD has moved). Clearing
  # the marker with `--terminal-marker false` works only before that Stop fires
  # and needs set-terminal's full flag set. On Codex the Stop hook runs only
  # once the operator has trusted the plugin hooks (`/hooks`). Full contract:
  # core/skills/_shared/references/session-handoff.md § Archive timing.
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" finish-verb \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
    --next-action "Commit the refined change; the recurring finding is deferred" \
    --next-step-kind commit --next-step-confidence HIGH
  ```

`awaiting-owner-clear` records `### Owner gate resolved: recurring-finding at
<iso>` with the pointer it cleared, and refuses under an autopilot run.

---

## Multi-axis lens at a 2+-branch point (ADR-0029 §2)

If executing this verb surfaces a **genuine 2+-branch decision point**
— two viable fix strategies, or two refactor paths, or a non-neutral
`selected_next` with 2+ candidates in the proposal below — surface a
**compact multi-axis lens** comparing the branches across the resolved
decisive axes (본질/근본 essence/foundation) + supporting axes, instead
of a flat list. Resolve the sized axis set from the shared
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

Output the change summary and one of:

- `✓ Refinement complete.` + edited files + verification status.
- `✓ Refinement blocked (peer flagged regression).` — when CONFLICT
  or significant peer concerns surfaced. Surface the issues; pause
  for user direction before retrying.
- `✓ Refinement complete (deeper root cause suspected).` — the fix did
  not hold or the symptom recurred.

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

Typical `selected_next` candidates for refine:
`/engineer:critique` to confirm with another review pass, or `commit` when
the change is small and verified — or `/engineer:investigate
--profile=root-cause` when a deeper root cause is suspected. The routing
table is the fallback only when evidence is genuinely neutral — do not end
with a hardcoded "next: X". When `selected_next` is `engineer:decide`, also
name the decision size (`--size=minor|standard|major`) per the contract.
The `blocked` case pauses for user direction before any forward proposal.

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
