---
description: Apply critique findings or feedback to a business artifact — revise the venture plan, brief, or canvas, then verify it still reconciles. Founder's refinement verb
argument-hint: (no profile — refine is single-mode; describe what to apply)
---

# Founder · Refine

$ARGUMENTS

Use `TaskCreate` and `TaskUpdate` to track progress. The peer ensemble
runs automatically (Refine-verify point type) — never ask the user
whether to invoke the peer, and never direct them to run companion CLIs
manually. When the companions plugin or peer CLI is unavailable, the
ensemble degrades silently to local-only.

Plugin root: `$CLAUDE_PLUGIN_ROOT` (set by Claude Code for plugin slash
commands). If unset, fall back to
`$(find ~/.claude/plugins/cache/agentic-plugins/founder -maxdepth 1 -mindepth 1 -type d | sort -V | tail -1)`.

> **founder is not an orchestrator dispatch target** (ADR-0036 Non-Goal
> 3): this command does NOT read `AGENTIC_PARENT_WORKFLOW` /
> `AGENTIC_ORIGINATING_SUBTASK`, and founder `state.mjs create` does not
> accept parent-linkage flags. founder workflows are user-invoked and
> branch-anchored only.

---

## Phase 0 — Workflow continuity (per ADR-0011 §5)

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
GIT_BRANCH="$(git branch --show-current)"
# ADR-0018 §sub-2 — founder workflows are anchored to a branch.
if [ -z "$GIT_BRANCH" ]; then
  echo "✗ Detached HEAD detected — founder workflows are anchored to a branch (ADR-0018 §sub-2)." >&2
  echo "  Switch to a branch first: git switch <branch>" >&2
  exit 1
fi
FIND_ERR="${TMPDIR:-/tmp}/founder-find-active-$$.err"
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

- Empty `$ACTIVE` → bootstrap with verb=refine:

  ```bash
  GIT_BRANCH="$(git branch --show-current)"
  GIT_HEAD="$(git rev-parse HEAD)"
  STATUS_DIGEST="$(git status --porcelain=v1 -z | shasum -a 256 | cut -d' ' -f1)"
  ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" create \
    --repo-root "$REPO_ROOT" \
    --verb refine --host "${AGENTIC_HOST:-claude}" --persona founder \
    --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
    --status-digest "$STATUS_DIGEST" \
    --original-request "${AGENTIC_TOPIC:-<one-line genericized refine target>}" \
    --current-phase phase-0-bootstrap \
    --next-action "Run refine skill")"
  ```

- Non-empty `$ACTIVE` → append-on-resume:

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
`$CLAUDE_PLUGIN_ROOT/skills/refine/SKILL.md`. Refine is single-mode (no
`--profile` argument). Business context flows through the Business Task
Profile per `skills/_shared/references/orchestration.md`.

Refine applies critique findings or feedback to the business artifact and
verifies the revision holds together. The upstream contract is:
`critique` (or `investigate --profile=root-cause` for an
underperformance) → `decide` (if 2+ viable remediation directions) →
`refine`. **Verify means internal consistency, not "run tests"**: confirm
the revised sections still reconcile (unit-economics ↔ go-to-market ↔
pricing ↔ milestones), confirm the change did not open a new veto-gate
exposure (규제노출 / 안전리스크), and confirm still-unverified numbers keep
their `[to be validated]` markers. When the remediation involves 2+
viable directions, route through `/founder:decide` rather than choosing
silently.

### Privacy gate (before any external call)

PRIVACY GATE: proprietary venture concepts, interview/customer data, and
unpublished business material pass an explicit gate before BOTH web
search AND peer-host dispatch. Genericize the revision before the peer
prompt; the pre-genericization value MUST never leave the local host. See
`skills/investigate/references/business-brief-spec.md` § Privacy Gate.

### Ensemble dispatch (Refine-verify point type)

Build the Refine-verify prompt per
`skills/_shared/references/ensemble-protocol.md` §Refine-verify (the peer
receives the **genericized** before→after of the changed sections and
verifies the revision resolves the finding without introducing a new
inconsistency or a new gate exposure), write it to a tempfile, and
dispatch in the background. The privacy gate must have passed first.

```bash
PROMPT_FILE="$(mktemp -t founder-refine-prompt.XXXXXX).xml"
# ADR-0017 §sub-decision 4 — stable run-id BEFORE dispatch.
RUN_ID="refine-verify-$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%06x' $((RANDOM*RANDOM & 0xffffff)))"
# ... LLM writes the Refine-verify XML prompt to $PROMPT_FILE
#     (privacy gate must have passed; genericize the revision first) ...
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" run \
  --repo-root "$REPO_ROOT" --kind ensemble \
  --peer codex --prompt-file "$PROMPT_FILE" --output-format json \
  --workflow-path "$ACTIVE" --phase refine \
  --host "${AGENTIC_HOST:-claude}" --cwd "$REPO_ROOT" \
  --ensemble-type refine-verify --run-id "$RUN_ID" \
  > "$PROMPT_FILE.run.json" 2> "$PROMPT_FILE.err" &
```

Use `run_in_background: true` on the Bash tool. `peer-runner.mjs run`
records the matching `pending_ensemble` row before spawning the companion
and writes raw peer output under the hidden peer-run ledger. Synthesize
per AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT. A peer-flagged regression
(new inconsistency / new gate exposure) pauses the refine for user
direction.

Graceful degradation: companion missing or exit code 3
(`peer_cli_not_found` / `peer_unauthenticated` / `peer_invocation_error`)
→ proceed local-only and record "### Ensemble degraded:" in the body.

---

## Phase 2 — State finalize

```bash
NOTE="### Ensemble launched: refine at <iso-utc>

### Ensemble synthesis: refine verdict=<resolved|concerns|regression|conflict>

<AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown>

### Refinement summary

- Applied: <N findings / 1 revision>
- Verified: <downstream sections reconcile; gate exposure unchanged;
  [to be validated] markers intact>
- Deferred: <items not addressed and why>

### Active next-action proposal

- selected_next:         <verb | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + consistency/gate check>
- evidence_pointers:     <revised sections / artifact path — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /founder:<verb> … or \$founder:<verb> for a verb>
"

node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase-label "Phase 1: Refine (synthesized)" \
  --phase-note "$NOTE" \
  --current-phase phase-2-presented \
  --next-action "Re-critique the revised artifact" \
  --event updated

# ADR-0017 §sub-decision 4 — atomic three-step ensemble-results commit.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ensemble-commit \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase refine --ensemble-type refine-verify --run-id "$RUN_ID" \
  --verdict "$VERDICT" --summary "$SUMMARY" \
  --completed-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ADR-0029 §1 / completion-output contract §2 — set --next-action (the
# append above and this terminal write) to the COMPACT form of the
# proposal above (selected_next + one-line why + next_command) so the
# durable state and the code-emitted completion footer agree with the
# Active Next-Action Proposal. The value shown is the typical-case
# default; override it when the verb's result selects a different next
# step (e.g. the owner publish/commit step).
# ADR-0017 §sub-decision 5 — atomic terminal write.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" set-terminal \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --terminal-phase summary-complete \
  --terminal-marker true \
  --next-action "Re-critique the revised artifact" \
  --event updated
```

---

## Multi-axis lens at a 2+-branch point (ADR-0029 §2)

If refine surfaces a **genuine 2+-branch decision point** — two viable
remediation directions, or two ways to close the same gap — surface a
**compact multi-axis lens** across the decisive business axes (시장성 /
단위경제) + the veto gates, instead of a flat list, reading
`skills/decide/references/decision-axes.yml` (the
`scripts/decide-registry.mjs resolve --size=minor` compact 4-axis set).
Bounded: only at a genuine 2+-branch point, never the full matrix for a
trivial reversible step. A weightier fork should route to
`/founder:decide`.

---

## Completion

Output the refinement summary (applied / verified / deferred) and one of:

- `✓ Refinement complete.` + the artifact revised and reconciled.
- `✓ Refine paused (regression flagged).` — when the peer or the
  consistency check surfaced a new inconsistency or gate exposure that
  warrants user input before proceeding.

Then emit an **Active Next-Action Proposal** (the inline shape in
`skills/refine/SKILL.md` § Completion): typical `selected_next` is
`/founder:critique` to confirm the revision with another review pass — or
"the plan is sound, proceed" when the change was small and reconciles. Do
not end with a hardcoded "next: X".

Always include the workflow path:

```
Workflow: <absolute path to workflow .md file>
```

The runtime completion footer is **code-emitted** on this verb's terminal
path (ADR-0039, enabled for founder by ADR-0043 S3): `state.mjs
set-terminal` fires the ADR-0031 session-handoff sidecar, which shells out
to the runtime `footer.mjs` and prints the rendered footer — context
state, completion state (founder's manually-published mapping surfaces
`publish-needed` when only the owner's save/commit remains) + state-derived
next action, workflow id/path, artifact pointers, recommended next work,
and the continue-vs-fresh session-handoff — on that command's **stderr**.
Do **not** hand-compose a second footer; surface the one the terminal
command already emitted. The footer is advisory + pointer-only and
fail-closed (a missing/too-old runtime emits nothing, and the SessionStart
backstop still re-surfaces the handoff); it never mutates host session
context. Detached HEAD never auto-recommends a fresh session (ADR-0018
§sub-2; the branch-based preflight is what reports "no active branch
context" — the path-targeted terminal sidecar still renders normally).
Wiring details:
`skills/_shared/references/session-handoff.md`.
