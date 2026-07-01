---
description: Gather evidence, scan codebases, diagnose root causes, produce cited briefs — the engineer persona's evidence-gathering verb
argument-hint: --profile=analysis|root-cause|cited-brief | (or natural-language scope or topic)
---

# Engineer · Investigate

$ARGUMENTS

Use `TaskCreate` to register each phase and `TaskUpdate` to advance
status. The peer ensemble runs automatically per
`skills/_shared/references/ensemble-protocol.md` — never ask the user
whether to invoke the peer, and never direct them to run companion
CLIs manually. When the companions plugin or peer CLI is unavailable,
the ensemble degrades silently to local-only.

The plugin root in shell snippets below is `$CLAUDE_PLUGIN_ROOT`
(set by Claude Code for plugin slash commands). If unset for any
reason, fall back to
`$(find ~/.claude/plugins/cache/agentic-plugins/engineer -maxdepth 1 -mindepth 1 -type d | sort -V | tail -1)`.

---

## Phase 0 — Workflow continuity (per ADR-0011 §5)

Determine workflow state via the host-shared canonical I/O module:

1. **Find active workflow**:

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

   - Empty `$ACTIVE` → no active workflow on this branch → bootstrap a new one (Step 2).
   - Non-empty path → active workflow on this branch → append-on-resume (Step 3).
   - `find-active` exits 1 on per-branch duplicate (corruption / external mutation); the snippet surfaces the diagnostic and aborts.

2. **Bootstrap** (no active workflow):

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
     --verb investigate --host "${AGENTIC_HOST:-claude}" \
     --git-baseline-branch "$GIT_BRANCH" \
     --git-baseline-head "$GIT_HEAD" \
     --status-digest "$STATUS_DIGEST" \
     --persona engineer \
     --profile "${AGENTIC_PROFILE:-<profile from $ARGUMENTS — analysis|root-cause|cited-brief; default 'analysis'>}" \
     --original-request "${AGENTIC_TOPIC:-<one-line scrubbed user request>}" \
     --current-phase phase-0-bootstrap \
     --next-action "Run investigate skill" \
     "${PARENT_ARGS[@]}")"
   ```

   `state.mjs create` enforces the directory-level lock + single-active
   invariant per ADR-0011 §3 — writes `.creation-lock`, atomically
   creates the workflow file, releases on completion.

3. **Append-on-resume** (active workflow exists):

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
     --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
     --verb investigate \
     --profile "<profile or empty>" \
     --phase-label "Phase 0: Resume into investigate" \
     --phase-note "Resumed from prior verb. Profile=<...>." \
     --current-phase phase-0-resume \
     --next-action "Run investigate skill" \
     --event resumed
   ```

   `state.mjs append` enforces the per-file lock with ownership token +
   stale detection per ADR-0011 §3.

---

## Phase 1 — Execute investigate

Follow the investigate skill's "When invoked by command" mode at
`$CLAUDE_PLUGIN_ROOT/skills/investigate/SKILL.md`. The skill performs:

- **Step 1**: Build the Task Profile (persona=engineer, profile, scope,
  layers, risks, complexity, ensemble affinity per
  `skills/_shared/references/orchestration.md`).
- **Step 2**: Spawn local agents in parallel (analysis profile →
  architecture-mapper / flow-tracer / dependency-analyzer; root-cause
  profile → hypothesis-tracer / regression-hunter / state-analyzer —
  selected by scope per `skills/_shared/references/agent-taxonomy.md`;
  cited-brief profile → no subagent spawning, the orchestrator runs
  WebSearch + WebFetch directly per-sub-question per the SKILL Step
  3'').
- **Step 3**: Dispatch the peer ensemble — Investigate or Explore
  point type per `skills/_shared/references/ensemble-protocol.md` for
  analysis/root-cause profiles, OR research-scan point type per
  `skills/investigate/references/cited-brief-ensemble.md` for the
  cited-brief profile — via
  `$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs run`. The peer runs in
  the background; the orchestrator continues its own analysis (or
  per-sub-question web search for cited-brief) in parallel.
- **Step 4**: Collect both sources, classify findings per the
  AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT base categories. For
  cited-brief, apply the bidirectional Independence Rule (Path A
  locally verify and cite, Path B move to Open Questions) and remap
  citation numbers to local capture order per
  `skills/investigate/references/cited-brief-ensemble.md`.
- **Step 5**: Present synthesized result per
  `skills/_shared/references/presentation-protocol.md`. For
  cited-brief, run the Audit Checklist
  (`skills/investigate/references/cited-brief-spec.md`) and save the
  brief per `skills/investigate/references/output-file-rules.md`
  (per-topic directory under the resolved output root, fixed filename
  `research_brief.md`).

### Ensemble dispatch — concrete invocation

Build the prompt with `buildEnsemblePrompt` (or assemble the XML
directly per `companions/contract.md` §3) and spawn the peer in the
background:

```bash
PROMPT_FILE="$(mktemp -t engineer-investigate-prompt.XXXXXX).xml"
# ADR-0017 §sub-decision 4 — stable run-id BEFORE dispatch.
# `$ENSEMBLE_TYPE` is `investigate` for analysis profile, `root-cause`
# for the root-cause profile, `cited-brief` for cited-brief (set in
# Phase 1 from the resolved profile).
RUN_ID="${ENSEMBLE_TYPE:-investigate}-$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%06x' $((RANDOM*RANDOM & 0xffffff)))"
# ... LLM writes the XML prompt to $PROMPT_FILE ...
# Then dispatch in background through the managed peer-runner:
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" run \
  --repo-root "$REPO_ROOT" --kind ensemble \
  --peer codex --prompt-file "$PROMPT_FILE" --output-format json \
  --workflow-path "$ACTIVE" --phase investigate \
  --host "${AGENTIC_HOST:-claude}" --cwd "$REPO_ROOT" \
  --ensemble-type "${ENSEMBLE_TYPE:-investigate}" --run-id "$RUN_ID" \
  > "$PROMPT_FILE.run.json" 2> "$PROMPT_FILE.err" &
```

For the **cited-brief** profile, the XML prompt additionally carries
the `<citation_contract>` and `<privacy_contract>` blocks defined in
`skills/investigate/references/cited-brief-ensemble.md` § Prompt
Construction. The same `peer-runner.mjs run` path is used;
`--prompt-file` keeps user-controlled material (topic, sub-questions)
out of shell parsing and process argv per `companions/contract.md`
§ 2.2.

The peer-runner records the matching `pending_ensemble` row before
spawning the companion, writes raw stdout/stderr under the hidden
peer-run ledger, and emits a small JSON result to
`$PROMPT_FILE.run.json` with `envelope_path`, `stdout_path`,
`stderr_path`, and `handle_path`.

(Use `run_in_background: true` on the Bash tool; collect output once
the orchestrator's local analysis completes.)

When the companion is missing or returns exit code 3
(`peer_cli_not_found` / `peer_unauthenticated` /
`peer_invocation_error`), record the failure in the workflow body
under "### Ensemble degraded:" and proceed with local-only synthesis
per the protocol's *Failure Handling*.

---

## Phase 2 — State finalize

After Phase 1 returns synthesized findings, append a phase note that
captures (a) the synthesis verdict, (b) ensemble launch + result
markers per `ensemble-protocol.md` § State Bookkeeping (Stage 2), and
(c) the active next-action proposal (per
`skills/_shared/references/entry-routing-contract.md`
§ Active Next-Action Proposal, not a fixed next-verb literal). For the
cited-brief profile, also
include the saved brief's absolute path under a `### Brief saved`
heading so future workflow consumers can locate the artifact (the
brief itself stays orthogonal to the workflow body — referenced by
path only, never inlined). Workflow phase notes MAY carry
source-of-discovery labels (`[Both]` / `[Local]` / `[Peer]`); the
saved brief artifact MUST NOT, per
`skills/investigate/references/cited-brief-spec.md` § Ensemble Label
Policy.

```bash
NOTE="### Ensemble launched: investigate at <iso-utc>

### Ensemble synthesis: investigate verdict=<agreed|concerns|conflict>

<AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown>

### Findings

<top findings with file paths and line numbers>

### Active next-action proposal

(per skills/_shared/references/entry-routing-contract.md
 § Active Next-Action Proposal — derived from these findings, not a fixed table)
- selected_next:         <verb | commit | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + Standards/Root-Cause gate>
- evidence_pointers:     <phase notes / files / artifacts — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /engineer:<verb> … or \$engineer:<verb> for a verb; the commit / owner-decision action otherwise>
"

# ADR-0029 §1 — set --next-action (both writes below) to the compact form
# of the proposal above (selected_next + one-line why + next_command) so the
# durable state and the state-derived completion footer agree with the Active
# Next-Action Proposal. The value shown is the typical-case default; override
# it when the verb's result selects a different next step (e.g. commit).
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase-label "Phase 1: Investigate (synthesized)" \
  --phase-note "$NOTE" \
  --current-phase phase-2-presented \
  --next-action "<one-sentence imperative for next verb>" \
  --event updated

# ADR-0017 §sub-decision 4 — atomic three-step ensemble-results commit.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ensemble-commit \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase investigate --ensemble-type "${ENSEMBLE_TYPE:-investigate}" --run-id "$RUN_ID" \
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
  --next-action "<one-sentence imperative for next verb>" \
  --event updated
```

---

## Multi-axis lens at a 2+-branch point (ADR-0029 §2)

If executing this verb surfaces a **genuine 2+-branch decision point**
— two viable root-cause hypotheses, or two competing readings of the
same evidence, or a non-neutral `selected_next` with 2+ candidates in
the proposal below — surface a **compact multi-axis lens** comparing
the branches across the resolved decisive axes (본질/근본
essence/foundation) + supporting axes, instead of a flat list. Resolve
the sized axis set from the shared
`$CLAUDE_PLUGIN_ROOT/scripts/decide-registry.mjs resolve --size=<minor|standard|major>`
resolver — the single axis source of truth, not a hand-authored list —
per `skills/_shared/references/entry-routing-contract.md`
§ "Surfacing the multi-axis lens from a non-decide verb".

Bounded: only at a genuine 2+-branch point (not every invocation),
default `--size=minor` (compact 4-axis), escalating only for weightier
branches — never the full 9-axis matrix for a trivial reversible step.
The full mechanism + the Codex-unreachable fallback (ADR-0013) live in
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

For every successful completion (the `✓` cases), emit an **Active
Next-Action Proposal** instead of a fixed next verb, per
`skills/_shared/references/entry-routing-contract.md`
§ Active Next-Action Proposal: **selected_next**, **rejected_alternatives**
(1-2 + why-not), **rationale** (decisive axes 본질/근본 essence/foundation +
the Standards/Root-Cause gate), **evidence_pointers** (pointers only),
**confidence** (HIGH/MEDIUM/LOW), and **next_command** (the `/engineer:<verb> …` / `$engineer:<verb>` mention
for a verb, or the concrete action for `commit` / `owner decision`). Typical `selected_next` candidates for investigate:
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

The runtime completion footer is **code-emitted** on this verb's terminal path
(ADR-0039): `state.mjs set-terminal` fires the ADR-0031 session-handoff sidecar,
which shells out to the runtime `footer.mjs` and prints the rendered footer —
context state, completion state + state-derived next action, workflow id/path,
artifact pointers, recommended next work, and the continue-vs-fresh
session-handoff — on that command's **stderr**. Do **not** hand-compose a second
footer here; surface the one the terminal command already emitted. The footer is
advisory + pointer-only and fail-closed (a missing/too-old runtime emits
nothing, and the SessionStart backstop still re-surfaces the handoff); it never
mutates host session context. On detached HEAD the sidecar reports "no active
branch context" and does not auto-recommend a fresh session.
