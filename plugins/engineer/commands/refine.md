---
description: Apply feedback, repair defects, iterate after critique — engineer's refinement verb
argument-hint: (fix description, finding reference, or critique scope)
---

# Engineer · Refine

$ARGUMENTS

Use `TaskCreate` and `TaskUpdate` to track progress. The peer ensemble
runs automatically per
`skills/_shared/references/ensemble-protocol.md` (Refine-verify point
type) — never ask the user whether to invoke the peer. When the
companions plugin or peer CLI is unavailable, the ensemble degrades
silently to local-only.

Plugin root: `$CLAUDE_PLUGIN_ROOT` (fallback as in
commands/investigate.md).

Core principle: do not modify code until the root cause is confirmed.
When refining a bug fix, the upstream contract is investigate
(root-cause profile) → decide (if 2+ fix approaches) → refine.
Skipping investigate paper-fixes symptoms.

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

- Empty → bootstrap with verb=refine:

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
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --verb refine \
    --phase-label "Phase 0: Resume into refine" \
    --phase-note "Resumed from prior verb." \
    --current-phase phase-0-resume \
    --next-action "Run refine skill" --event resumed
  ```

---

## Phase 1 — Execute refine

Follow the refine skill's command-invoked mode at
`$CLAUDE_PLUGIN_ROOT/skills/refine/SKILL.md`. The skill applies the
fix, runs verification (tests / lint / type-check / smoke), and
confirms the change addresses the root cause without regressions.

Refine is single-mode (no `--profile` argument). Sub-discipline
context flows through the orchestrator-level Task Profile.

In command-mode (`$ACTIVE` bound), the skill's **Layer 2
commit-manifest recording** step requires
`state.mjs record-refine-file --workflow-path "$ACTIVE" --path <p>
--op edit|create` after each Write/Edit on a tracked path. See
`skills/refine/SKILL.md` § Layer 2 commit-manifest recording for the
full pattern (ADR-0028 §Layer-2).

### Ensemble dispatch (Refine-verify point type)

Build the Refine-verify prompt per
`skills/_shared/references/ensemble-protocol.md` § Refine-verify.
The peer independently verifies that the fix addresses the symptom,
checks for over-fitting, and probes for regressions.

```bash
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
  > "$PROMPT_FILE.run.json" 2> "$PROMPT_FILE.err" &
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
NOTE="### Ensemble launched: refine at <iso-utc>

### Ensemble synthesis: refine verdict=<agreed|concerns|conflict>

<AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown>

### Changes applied

<list of edited files with one-line summary; test/lint/type-check status>

### Verification

<test results, regression checks, root-cause confirmation>

### Active next-action proposal

(per skills/_shared/references/entry-routing-contract.md
 § Active Next-Action Proposal — derived from this refinement, not a fixed table)
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
  --phase-label "Phase 1: Refine (synthesized)" \
  --phase-note "$NOTE" \
  --current-phase phase-2-presented \
  --next-action "Critique to verify, or investigate deeper if root cause is uncertain" \
  --event updated

# ADR-0017 §sub-decision 4 — atomic three-step ensemble-results commit.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ensemble-commit \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase refine --ensemble-type refine-verify --run-id "$RUN_ID" \
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
  --next-action "Critique to verify, or investigate deeper if root cause is uncertain" \
  --event updated
```

---

## Multi-axis lens at a 2+-branch point (ADR-0029 §2)

If executing this verb surfaces a **genuine 2+-branch decision point**
— two viable fix strategies, or two refactor paths, or a non-neutral
`selected_next` with 2+ candidates in the proposal below — surface a
**compact multi-axis lens** comparing the branches across the resolved
decisive axes (본질/근본 essence/foundation) + supporting axes, instead
of a flat list. Resolve the sized axis set from the shared
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

Output the change summary and one of:

- `✓ Refinement complete.` + edited files + verification status.
- `✓ Refinement blocked (peer flagged regression).` — when CONFLICT
  or significant peer concerns surfaced. Surface the issues; pause
  for user direction before retrying.
- `✓ Refinement complete (deeper root cause suspected).` — the fix did
  not hold or the symptom recurred.

Then emit an **Active Next-Action Proposal** instead of a fixed next
verb, per `skills/_shared/references/entry-routing-contract.md`
§ Active Next-Action Proposal: **selected_next**, **rejected_alternatives**
(1-2 + why-not), **rationale** (decisive axes 본질/근본 essence/foundation +
the Standards/Root-Cause gate), **evidence_pointers** (pointers only),
**confidence** (HIGH/MEDIUM/LOW), and **next_command** (the `/engineer:<verb> …` / `$engineer:<verb>` mention
for a verb, or the concrete action for `commit` / `owner decision`). Typical `selected_next` candidates for refine:
`/engineer:critique` to confirm with another review pass, or `commit` when
the change is small and verified — or `/engineer:investigate
--profile=root-cause` when a deeper root cause is suspected. The routing
table is the fallback only when evidence is genuinely neutral — do not end
with a hardcoded "next: X". When `selected_next` is `engineer:decide`, also
name the decision size (`--size=minor|standard|major`) per the contract.
The `blocked` case pauses for user direction before any forward proposal.

Always include the workflow path.

Append the runtime completion footer after the workflow path. Use the
runtime footer helper when available, or render the same fields manually:
context state, completion state plus state-derived next action, workflow
id/path, artifact pointers, recommended next work, and next-session
action/command or prompt pointer. The footer is advisory
and pointer-only; do not mutate host session context or paste raw peer /
consensus output into the main session.

Before rendering the footer, surface the ADR-0031 session-level
continue-vs-fresh preflight per
`skills/_shared/references/session-handoff.md`: compute the engineer workflow
projection and pass it to the runtime footer/check
(`--workflow-projection-file`) so the footer carries the continue-vs-fresh
decision. On detached HEAD, report "no active branch context" — do not
auto-recommend a fresh session.
