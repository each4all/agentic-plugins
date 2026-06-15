---
description: Evaluate a business artifact — venture plan, brief, canvas, strategy — across market/unit-economics/gates, or red-team a venture (pre-mortem). Founder's critique verb
argument-hint: --profile=red-team | (default reviews the artifact on hand)
---

# Founder · Critique

$ARGUMENTS

Use `TaskCreate` and `TaskUpdate` to track progress. The peer ensemble
runs automatically (Review point for default, Adversarial-scan point for
`red-team`) — never ask the user whether to invoke the peer, and never
direct them to run companion CLIs manually. When the companions plugin or
peer CLI is unavailable, the ensemble degrades silently to local-only.

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

- Empty `$ACTIVE` → bootstrap with verb=critique:

  ```bash
  GIT_BRANCH="$(git branch --show-current)"
  GIT_HEAD="$(git rev-parse HEAD)"
  STATUS_DIGEST="$(git status --porcelain=v1 -z | shasum -a 256 | cut -d' ' -f1)"
  ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" create \
    --repo-root "$REPO_ROOT" \
    --verb critique --host "${AGENTIC_HOST:-claude}" --persona founder \
    --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
    --status-digest "$STATUS_DIGEST" \
    --profile "${AGENTIC_PROFILE:-<default or red-team from \$ARGUMENTS>}" \
    --original-request "${AGENTIC_TOPIC:-<one-line genericized review target>}" \
    --current-phase phase-0-bootstrap \
    --next-action "Run critique skill")"
  ```

- Non-empty `$ACTIVE` → append-on-resume:

  ```bash
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --verb critique \
    --profile "<default|red-team or empty>" \
    --phase-label "Phase 0: Resume into critique" \
    --phase-note "Resumed from prior verb. Profile=<...>." \
    --current-phase phase-0-resume \
    --next-action "Run critique skill" --event resumed
  ```

---

## Phase 1 — Execute critique

Follow the critique skill's command-invoked mode at
`$CLAUDE_PLUGIN_ROOT/skills/critique/SKILL.md`. Profiles:

- (default) — multi-perspective review of a specific business artifact
  (the venture plan / brief / canvas / strategy on hand) across
  market-attractiveness, unit-economics, willingness-to-pay,
  competitive-intensity, the regulatory + safety veto gates, execution,
  and evidence quality.
- `red-team` — adversarial **pre-mortem** of an entire venture/strategy,
  with a Risk-class sub-focus (market / unit-economics / competitive /
  regulatory / execution / full).

Profile selection: `--profile=<name>` on the command, else inferred from
the user's intent. Missing profile → default. Unknown profile → fallback
to default with a one-line warning.

Validity is the orchestrator's judgment — judge each finding yourself,
drop the invalid ones, surface valid ones by severity. An unmitigated
veto gate (규제노출 / 안전리스크) is CRITICAL by definition. Do NOT fix here —
critique produces findings; `/founder:refine` applies the changes.

### Privacy gate (before any external call)

PRIVACY GATE: proprietary venture concepts, interview/customer data, and
unpublished business material pass an explicit gate before BOTH web
search AND peer-host dispatch. Genericize the artifact before the peer
prompt; the pre-genericization value MUST never leave the local host. See
`skills/investigate/references/business-brief-spec.md` § Privacy Gate.

### Ensemble dispatch (Review point for default; Adversarial-scan point for red-team)

Build the peer prompt per `skills/_shared/references/ensemble-protocol.md`
(§Review for the default profile, §Adversarial-scan + the Risk-class
sub-focus text for `red-team`), write it to a tempfile, and dispatch in
the background. The peer receives the **genericized** artifact (default)
or venture scope (red-team) and returns findings; the privacy gate must
have passed first.

```bash
PROMPT_FILE="$(mktemp -t founder-critique-prompt.XXXXXX).xml"
# ADR-0017 §sub-decision 4 — stable run-id BEFORE dispatch.
# Resolve ENSEMBLE_TYPE from the Phase 1 profile BEFORE building the prompt:
#   default profile    → review            (use the §Review template)
#   --profile=red-team → adversarial-scan  (use the §Adversarial-scan template)
# A red-team run MUST set adversarial-scan — do not leave it at the review default.
ENSEMBLE_TYPE="review"   # ← CHANGE to "adversarial-scan" for --profile=red-team
RUN_ID="${ENSEMBLE_TYPE}-$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%06x' $((RANDOM*RANDOM & 0xffffff)))"
# ... LLM writes the Review / Adversarial-scan XML prompt to $PROMPT_FILE
#     (privacy gate must have passed; genericize the artifact first) ...
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" run \
  --repo-root "$REPO_ROOT" --kind ensemble \
  --peer codex --prompt-file "$PROMPT_FILE" --output-format json \
  --workflow-path "$ACTIVE" --phase critique \
  --host "${AGENTIC_HOST:-claude}" --cwd "$REPO_ROOT" \
  --ensemble-type "$ENSEMBLE_TYPE" --run-id "$RUN_ID" \
  > "$PROMPT_FILE.run.json" 2> "$PROMPT_FILE.err" &
```

Use `run_in_background: true` on the Bash tool. `peer-runner.mjs run`
records the matching `pending_ensemble` row before spawning the companion
and writes raw peer output under the hidden peer-run ledger. Synthesize
per AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT; deduplicate by
section/claim and take the higher severity on a duplicate.

Graceful degradation: companion missing or exit code 3
(`peer_cli_not_found` / `peer_unauthenticated` / `peer_invocation_error`)
→ proceed local-only and record "### Ensemble degraded:" in the body.

---

## Phase 2 — State finalize

```bash
NOTE="### Ensemble launched: critique (\$ENSEMBLE_TYPE) at <iso-utc>

### Ensemble synthesis: critique (profile=<default|red-team>) verdict=<sound|concerns|veto|conflict>

<AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown>

### Review report

Gate verdict: 규제노출 <PASS|COND|FAIL> · 안전리스크 <PASS|COND|FAIL>
<CRITICAL / MAJOR / MINOR / SUGGESTION findings by section/claim;
 'Looks Strong' observations at the end>

### Active next-action proposal

- selected_next:         <verb | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + the gate verdict>
- evidence_pointers:     <finding sections / artifact path — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /founder:<verb> … or \$founder:<verb> for a verb>
"

node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase-label "Phase 1: Critique (synthesized)" \
  --phase-note "$NOTE" \
  --current-phase phase-2-presented \
  --next-action "Refine the artifact to address the findings" \
  --event updated

# ADR-0017 §sub-decision 4 — atomic three-step ensemble-results commit.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ensemble-commit \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase critique --ensemble-type "$ENSEMBLE_TYPE" --run-id "$RUN_ID" \
  --verdict "$VERDICT" --summary "$SUMMARY" \
  --completed-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ADR-0017 §sub-decision 5 — atomic terminal write.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" set-terminal \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --terminal-phase summary-complete \
  --terminal-marker true \
  --next-action "Refine the artifact to address the findings" \
  --event updated
```

---

## Multi-axis lens at a 2+-branch point (ADR-0029 §2)

If critique surfaces a **genuine 2+-branch decision point** — two viable
remediation directions, or two severity reads of the same finding —
surface a **compact multi-axis lens** across the decisive business axes
(시장성 / 단위경제) + the veto gates, instead of a flat list, reading
`skills/decide/references/decision-axes.yml` (the
`scripts/decide-registry.mjs resolve --size=minor` compact 4-axis set).
Bounded: only at a genuine 2+-branch point, never the full matrix for a
trivial reversible step. A weightier fork should route to
`/founder:decide`.

---

## Completion

Output the review report (summary + gate verdict + findings by severity)
and one of:

- `✓ Critique complete.` + the artifact reviewed.
- `✓ Critique paused (veto-grade finding).` — when an unmitigated
  regulatory / safety gate or a fatal flaw warrants user input before
  proceeding.

Then emit an **Active Next-Action Proposal** (the inline shape in
`skills/critique/SKILL.md` § Completion): typical `selected_next` is
`/founder:refine` to address selected findings — or `/founder:decide`
when a finding opens a genuine fork, or `/founder:investigate` when a
finding rests on a load-bearing claim that needs evidence. Do not end
with a hardcoded "next: X".

Always include the workflow path:

```
Workflow: <absolute path to workflow .md file>
```

The runtime completion footer + ADR-0031 session-level continue-vs-fresh
preflight land with founder's meta skills (ADR-0036 PR6); until then,
state the workflow path and the next-action proposal above.
