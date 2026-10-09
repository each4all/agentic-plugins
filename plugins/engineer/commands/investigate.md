---
description: Gather evidence, scan codebases, diagnose root causes, produce cited briefs — the engineer persona's evidence-gathering verb
argument-hint: --profile=analysis|root-cause|cited-brief | (or natural-language scope or topic)
---

# Engineer · Investigate

$ARGUMENTS

Maintain one progress entry per phase and advance its status as you go
— use the host's task-tracking tools when the session exposes them,
and keep an inline checklist when it does not. The peer ensemble runs automatically per
`core/skills/_shared/references/ensemble-protocol.md` — never ask the user
whether to invoke the peer, and never direct them to run companion
CLIs manually. When the companions plugin or peer CLI is unavailable,
the ensemble degrades silently to local-only.

<!-- pipeline:begin plugin-root -->
Plugin root: each shell block below opens by setting `$CLAUDE_PLUGIN_ROOT` —
from `AGENTIC_ENGINEER_ROOT` when that is set, else from the plugin path
Claude Code writes into this command when it loads it, else from the newest
version in the plugin cache. Keep those opening lines when you run a block: a
shell variable does not outlive a Bash call.
<!-- pipeline:end plugin-root -->

---

## Phase 0 — Workflow continuity (per ADR-0011 §5)

Determine workflow state via the host-shared canonical I/O module:

<!-- pipeline:begin investigate-phase-0 -->
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
<!-- pipeline:end investigate-phase-0 -->

`find-active` exits 1 on a per-branch duplicate (corruption / external
mutation); the block surfaces the diagnostic and aborts.

Empty `$ACTIVE` → bootstrap a new workflow with verb=investigate (profile `analysis`, `root-cause` or `cited-brief`):

<!-- pipeline:begin investigate-bootstrap -->
In the block, replace the profile placeholder with the profile the arguments
name, and `<the original request described above>` with a
one-line scrubbed user request; `AGENTIC_PROFILE` and `AGENTIC_TOPIC` take their
places when they are set.

```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
VERB='investigate'
DEFAULT_PROFILE='analysis'
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
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" create \
  --repo-root "$REPO_ROOT" \
  --verb 'investigate' --host "${AGENTIC_HOST:-claude}" --persona 'engineer' \
  --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
  --status-digest "$STATUS_DIGEST" \
  --profile "${AGENTIC_PROFILE:-<profile from the arguments above — default ${DEFAULT_PROFILE}>}" \
  --original-request "${AGENTIC_TOPIC:-<the original request described above>}" \
  --current-phase phase-0-bootstrap \
  --next-action "Run ${VERB} skill" \
  "${PARENT_ARGS[@]}")" || exit $?
```
<!-- pipeline:end investigate-bootstrap -->

`state.mjs create` enforces the directory-level lock + single-active
invariant per ADR-0011 §3 — writes `.creation-lock`, atomically
creates the workflow file, releases on completion.

Non-empty `$ACTIVE` → append-on-resume:

<!-- pipeline:begin investigate-resume -->
```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
VERB='investigate'
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --verb 'investigate' \
  --profile "<profile or empty>" \
  --phase-label "Phase 0: Resume into ${VERB}" \
  --phase-note "Resumed from prior verb. Profile=<...>." \
  --current-phase phase-0-resume \
  --clear-next-step true \
  --next-action "Run ${VERB} skill" --event resumed || exit $?
```
<!-- pipeline:end investigate-resume -->

`state.mjs append` enforces the per-file lock with ownership token +
stale detection per ADR-0011 §3.

---

## Phase 1 — Execute investigate

Follow the investigate skill's "When invoked by command" mode at
`${CLAUDE_PLUGIN_ROOT}/core/skills/investigate/SKILL.md`. The skill performs:

- **Step 1**: Build the Task Profile (persona=engineer, profile, scope,
  layers, risks, complexity, ensemble affinity per
  `core/skills/_shared/references/orchestration.md`).
- **Step 2**: Spawn local agents in parallel (analysis profile →
  architecture-mapper / flow-tracer / dependency-analyzer; root-cause
  profile → hypothesis-tracer / regression-hunter / state-analyzer —
  selected by scope per `core/skills/_shared/references/agent-taxonomy.md`;
  cited-brief profile → no subagent spawning, the orchestrator runs
  WebSearch + WebFetch directly per-sub-question per the SKILL Step
  3'').
- **Step 3**: Dispatch the peer ensemble — Investigate or Explore
  point type per `core/skills/_shared/references/ensemble-protocol.md` for
  analysis/root-cause profiles, OR research-scan point type per
  `core/skills/investigate/references/cited-brief-ensemble.md` for the
  cited-brief profile — via
  `${CLAUDE_PLUGIN_ROOT}/scripts/peer-runner.mjs run`. The peer runs in
  the background; the orchestrator continues its own analysis (or
  per-sub-question web search for cited-brief) in parallel.
- **Step 4**: Collect both sources, classify findings per the
  AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT base categories. For
  cited-brief, apply the bidirectional Independence Rule (Path A
  locally verify and cite, Path B move to Open Questions) and remap
  citation numbers to local capture order per
  `core/skills/investigate/references/cited-brief-ensemble.md`.
- **Step 5**: Present synthesized result per
  `core/skills/_shared/references/presentation-protocol.md`. For
  cited-brief, run the Audit Checklist
  (`core/skills/investigate/references/cited-brief-spec.md`) and save the
  brief per `core/skills/investigate/references/output-file-rules.md`
  (per-topic directory under the resolved output root, fixed filename
  `research_brief.md`).

Profile selection: `--profile=<name>` on the command, else inferred from the
request. Missing profile → `analysis`. Unknown profile → fallback to
`analysis` with a one-line warning.

### Ensemble dispatch — concrete invocation

Build the prompt with `buildEnsemblePrompt` (or assemble the XML
directly per `companions/contract.md` §3) and spawn the peer in the
background.

The block dispatches `investigate`, the analysis profile's ensemble type: for
`--profile=root-cause`, set `ENSEMBLE_TYPE='root-cause'` in it before running
it, and build the prompt from § Investigate; for `--profile=cited-brief`, set
`ENSEMBLE_TYPE='cited-brief'` in it before running it, and build the prompt
from `core/skills/investigate/references/cited-brief-ensemble.md` § Prompt
Construction.

Run this block **as a host background task** — on Claude, the Bash tool's
`run_in_background` — never with a trailing `&`: the host then tracks the
task and notifies you when the runner exits (ADR-0063 D5; a shell `&` would
detach the runner where neither you nor an autopilot host can wait for it).

<!-- pipeline:begin investigate-dispatch -->
```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
ENSEMBLE_TYPE='investigate'
PROMPT_FILE="$(mktemp -t 'engineer'-'investigate'-prompt.XXXXXX).xml"
# ADR-0017 §sub-decision 4 — stable run-id BEFORE dispatch.
RUN_ID="${ENSEMBLE_TYPE}-$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%06x' $((RANDOM*RANDOM & 0xffffff)))"
# ... LLM writes the prompt to $PROMPT_FILE (where this runbook has a privacy
#     gate above, it must have passed, and the prompt carries only genericized
#     text) ...
# Run this block as a host background task (on Claude, the Bash tool's
# run_in_background), never with a trailing `&`: the host tracks the runner
# and notifies you when it exits, where a shell `&` would detach it from both.
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" run \
  --repo-root "$REPO_ROOT" --kind ensemble \
  --peer codex --prompt-file "$PROMPT_FILE" --output-format json \
  --workflow-path "$ACTIVE" --phase 'investigate' \
  --host "${AGENTIC_HOST:-claude}" --cwd "$REPO_ROOT" \
  --ensemble-type "$ENSEMBLE_TYPE" --run-id "$RUN_ID" \
  > "$PROMPT_FILE.run.json" 2> "$PROMPT_FILE.err"
```
<!-- pipeline:end investigate-dispatch -->

For the **cited-brief** profile, the XML prompt additionally carries
the `<citation_contract>` and `<privacy_contract>` blocks defined in
`core/skills/investigate/references/cited-brief-ensemble.md` § Prompt
Construction. The same `peer-runner.mjs run` path is used;
`--prompt-file` keeps user-controlled material (topic, sub-questions)
out of shell parsing and process argv per `companions/contract.md`
§ 2.2.

The peer-runner records the matching `pending_ensemble` row before
spawning the companion, writes raw stdout/stderr under the hidden
peer-run ledger, and emits a small JSON result to
`$PROMPT_FILE.run.json` with `envelope_path`, `stdout_path`,
`stderr_path`, and `handle_path`. Collect that output once the
orchestrator's local analysis completes.

When the companion is missing or returns exit code 3
(`peer_cli_not_found` / `peer_unauthenticated` /
`peer_invocation_error`), record the failure in the workflow body
under "### Ensemble degraded:" and proceed with local-only synthesis
per the protocol's *Failure Handling*.

---

## Phase 2 — State finalize

After Phase 1 returns synthesized findings, record the phase note below. For
the cited-brief profile, its `### Brief saved` section names the saved brief's
absolute path so future workflow consumers can locate the artifact (the brief
itself stays orthogonal to the workflow body — referenced by path only, never
inlined); for the analysis and root-cause profiles, drop that section. Workflow
phase notes MAY carry source-of-discovery labels (`[Both]` / `[Local]` /
`[Peer]`); the saved brief artifact MUST NOT, per
`core/skills/investigate/references/cited-brief-spec.md` § Ensemble Label
Policy.

<!-- pipeline:begin investigate-finalize -->
The phase note this step records — fill in every `<…>`. When no run launched
(the verb ran local-only, so no dispatch ran; a run whose
companion is missing did launch, and settles `failed`), its first heading reads
`### Ensemble skipped: investigate (profile=<profile>) (local-only)` instead, and the synthesis
is local-only:

```markdown
### Ensemble launched: investigate (profile=<profile>) at <iso-utc>

### Ensemble synthesis: investigate (profile=<profile>) verdict=<agreed|concerns|conflict>

<AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown>

### Findings

<top findings with file paths and line numbers>

### Brief saved

<cited-brief profile only: absolute path to research_brief.md; drop this section for analysis and root-cause>

### Active next-action proposal

(per `core/skills/_shared/references/entry-routing-contract.md` § Active Next-Action Proposal — derived from this artifact, not a fixed table)
- selected_next:         <verb | commit | done | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + Standards/Root-Cause gate>
- evidence_pointers:     <phase notes / files / artifacts — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /engineer:<verb> … or $engineer:<verb> for a verb; /engineer:commit for commit or done; the owner-decision action otherwise>
```

Then run the block with the filled-in note in place of its placeholder line,
between the two `PHASE_NOTE` lines. The quoted heredoc hands the note to
`state.mjs` as written: no quote, `$`, backtick or backslash in it is read by
the shell. The first line that reads `PHASE_NOTE` alone ends the note, and
the shell runs every line after it as a command, so when the note itself holds
such a line, replace both `PHASE_NOTE` delimiters with a word no line of the
note consists of.

Set `RUN_ID` to the run id the dispatch generated, empty when no run launched,
and `VERDICT` and `SUMMARY` to the synthesis's verdict and a one-line résumé
of its breakdown. `peer-runner.mjs settle` decides from the run ledger what the
workflow records, not from these values alone: a run that never launched
records nothing; a run that launched and failed, was cancelled or was
abandoned records verdict `failed` with the ledger's `error_kind`; a run that
completed records the synthesis verdict, or `degraded` when its answer was
empty or unreadable. An answer that parses to nothing usable, only structural
shell, reads to `settle` like any other, so set `VERDICT` to `degraded` then.
It refuses, and the block stops before the last write, while a run is still
live (collect it first) or when an empty `RUN_ID` would hide a run that
launched (set it to that run's id).

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

```bash
ROOT_OVERRIDE="$(printenv 'AGENTIC_ENGINEER_ROOT' || true)"
CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/'engineer' -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# The run ledger lives under the repository root, where the dispatch put it.
REPO_ROOT="$(git rev-parse --show-toplevel)" || exit 1
# Where read takes no -d (dash) it assigns nothing, so clear NOTE first: a
# value the shell inherited must not stand in for the note.
unset NOTE
IFS= read -r -d '' NOTE <<'PHASE_NOTE' || true
<the phase note above, filled in>
PHASE_NOTE
# A shell whose read has no -d (dash) reads nothing: stop before any write.
[ -n "$NOTE" ] || { echo "✗ No phase note was read; nothing was written." >&2; exit 1; }

node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase-label 'Phase 1: Investigate (synthesized)' \
  --phase-note "$NOTE" \
  --current-phase phase-2-presented \
  --next-action '<one-sentence imperative for next verb>' \
  --event updated || exit $?

# ADR-0066 PC2b — settle the ensemble attempt from its ledger (never launched,
# launched and failed, completed); a refusal stops the block before the last
# write, so the workflow never closes with an attempt left unsettled.
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" settle \
  --repo-root "$REPO_ROOT" --workflow-path "$ACTIVE" \
  --host "${AGENTIC_HOST:-claude}" --phase 'investigate' --run-id "$RUN_ID" \
  --verdict "$VERDICT" --summary "$SUMMARY" || exit $?

# ADR-0029 §1 / completion-output contract §2 — set --next-action (the
# append above and this terminal write) to the COMPACT form of the
# proposal above (selected_next + one-line why + next_command) so the
# durable state and the code-emitted completion footer agree with the
# Active Next-Action Proposal. The value shown is the typical-case
# default; override it, and the --next-step-* flags, when the verb's result
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
  --next-action '<one-sentence imperative for next verb>' \
  --next-step-kind verb --next-step-verb 'frame' \
  --next-step-confidence "<HIGH|MEDIUM|LOW>" || exit $?
# The owner-decision form, for an owner gate named above this block: it
# records the gate with the next step in one write, and the workflow stays
# open until the owner resolves the gate.
# node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" finish-verb \
#   --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
#   --next-action '<Owner: the judgment, in a few words>' \
#   --next-step-kind owner-decision --next-step-confidence "<HIGH|MEDIUM|LOW>" \
#   --owner-gate '<gate>' --owner-gate-anchor '<anchor>' || exit $?
```
<!-- pipeline:end investigate-finalize -->

---

## Autopilot mode (ADR-0063, Claude only)

When Phase 0's preflight printed the autopilot banner, this command follows
`${CLAUDE_PLUGIN_ROOT}/core/skills/_shared/references/autopilot-mode.md`
(the preflight prints nothing interactively, and none of this applies then):

- **Ceremony gates auto-pass.** No presentation-mode prompt (present in
  batch); proceed with the recommended option instead of asking
  "Recommended: X. Proceed?".
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

## Multi-axis lens at a 2+-branch point (ADR-0029 §2)

If executing this verb surfaces a **genuine 2+-branch decision point**
— two viable root-cause hypotheses, or two competing readings of the
same evidence, or a non-neutral `selected_next` with 2+ candidates in
the proposal below — surface a **compact multi-axis lens** comparing
the branches across the resolved decisive axes (본질/근본
essence/foundation) + supporting axes, instead of a flat list. Resolve
the sized axis set from the shared
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

Output the synthesized findings and one of:

- `✓ Investigation complete.` — typical case.
- `✓ Investigation complete (full strike).` — when all local
  hypotheses AND the peer ensemble's diagnosis were refuted under the
  `root-cause` profile. Surface the user-facing prompt for additional
  context per the SKILL's *Full strike rule* — do NOT speculate on a
  cause not grounded in observable evidence.
- `✓ Cited brief saved.` — `cited-brief` profile, audit passed, file
  written to `<resolved-root>/YYYY-MM-DD_<topic-slug>/research_brief.md`.
  Show the saved path, sub-question coverage, source-tier breakdown,
  overall confidence, and any degraded-ensemble note.
- `✗ Cited brief aborted at save.` — `cited-brief` profile, the user
  declined at the existing-directory gate or final review. No file
  written; the synthesized brief is shown inline only.
- `✗ Cited brief aborted at scoping.` — `cited-brief` profile, the
  user declined the topic, sub-questions, or privacy gate before
  dispatch. No web search / peer dispatch ran.

For every successful completion (the `✓` cases), emit
the **Active Next-Action Proposal** the phase note above carries (per
`core/skills/_shared/references/entry-routing-contract.md`
§ Active Next-Action Proposal), instead of a fixed next verb.

Typical `selected_next` candidates for investigate:
for the analysis/root-cause profiles, `/engineer:decide` (2+ approaches),
`/engineer:refine` (an obvious fix), or `/engineer:frame` (reformulate);
for the `cited-brief` profile, `/engineer:frame` (scope a decision from
the brief), `/engineer:decide` (choose between surveyed approaches), or
`/engineer:compose` (draft from it). The routing table is the fallback
only when evidence is genuinely neutral — do not end with a hardcoded
"next: X". When `selected_next` is `engineer:decide`, also name the
decision size (`--size=minor|standard|major`) per the contract. The two
`✗` aborted cases have no forward result, so they skip the proposal.

Always include the workflow path so the user can inspect or resume:

```
Workflow: <absolute path to workflow .md file>
```

<!-- pipeline:begin investigate-completion-footer -->
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
<!-- pipeline:end investigate-completion-footer -->
