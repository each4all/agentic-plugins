---
description: Turn business evidence into a structured opportunity model — customer problem, value hypothesis, business-model sketch, validation criteria, key risks
argument-hint: (natural-language framing trigger or business-brief summary)
---

# Founder · Frame

$ARGUMENTS

Use `TaskCreate` to register each phase and `TaskUpdate` to advance
status. The peer ensemble runs automatically (Frame point type) — never
ask the user whether to invoke the peer, and never direct them to run
companion CLIs manually. When the companions plugin or peer CLI is
unavailable, the ensemble degrades silently to local-only.

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
# ADR-0036 SD5 — founder requires a git workspace (recommended: a
# per-venture content repository). If git rev-parse fails, refuse with
# manual-init guidance (git init, or cd into your venture content repo).
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

- Empty `$ACTIVE` → bootstrap a new workflow with verb=frame:

  ```bash
  GIT_BRANCH="$(git branch --show-current)"
  GIT_HEAD="$(git rev-parse HEAD)"
  STATUS_DIGEST="$(git status --porcelain=v1 -z | shasum -a 256 | cut -d' ' -f1)"
  ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" create \
    --repo-root "$REPO_ROOT" \
    --verb frame --host "${AGENTIC_HOST:-claude}" --persona founder \
    --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
    --status-digest "$STATUS_DIGEST" \
    --original-request "${AGENTIC_TOPIC:-<one-line genericized business topic>}" \
    --current-phase phase-0-bootstrap \
    --next-action "Run frame skill")"
  ```

- Non-empty `$ACTIVE` → append-on-resume:

  ```bash
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --verb frame \
    --phase-label "Phase 0: Resume into frame" \
    --phase-note "Resumed from prior verb." \
    --current-phase phase-0-resume \
    --next-action "Run frame skill" --event resumed
  ```

`state.mjs` enforces the directory-level lock + per-file lock with
ownership token + stale window per ADR-0011 §3, and writes only persona
`founder` (canonical-home guard).

---

## Phase 1 — Execute frame

Follow the frame skill's command-invoked mode at
`$CLAUDE_PLUGIN_ROOT/skills/frame/SKILL.md`. The skill articulates the
business opportunity model: problem/opportunity, customer + job-to-be-done,
value hypothesis, business-model sketch, constraints, validation criteria,
key risks, out-of-scope items.

Frame is single-mode (no `--profile` argument). Business context flows
through the Business Task Profile per
`skills/_shared/references/orchestration.md`.

### Privacy gate (before any external call)

PRIVACY GATE: proprietary venture concepts, interview/customer data, and
unpublished business material pass an explicit gate before BOTH web
search AND peer-host dispatch. Genericize before the peer prompt; the
pre-genericization value MUST never leave the local host. See
`skills/investigate/references/business-brief-spec.md` § Privacy Gate.

### Ensemble dispatch (Frame point type)

Build the Frame prompt and write it to a tempfile, then dispatch in the
background. The prompt template + synthesis contract live in
`skills/_shared/references/ensemble-protocol.md` §Frame:

```xml
<task>
Independently build a business opportunity model from the evidence below.
Do not see the local host's model — produce a fresh, independent one.

Genericized business evidence: {genericized brief findings / topic}
Jurisdiction(s): {market geographies, or "unspecified"}
</task>

<structured_output_contract>
Return one opportunity model with these fields:
1. Problem / Opportunity (1-2 sentences)
2. Customer + Job-to-be-Done
3. Value hypothesis (the wedge / unfair-advantage thesis)
4. Business-model sketch (revenue model + rough unit-economics direction)
5. Constraints (regulatory / capital / time / capability / market-timing)
6. Validation criteria (measurable evidence that would confirm or refute)
7. Key risks (market / competitive / regulatory / unit-economics / safety / execution) + early-detection signal
8. Out of scope
Mark uncertain fields [to be validated] rather than guessing.
</structured_output_contract>

<privacy_contract>
The evidence has been pre-genericized. Do not fabricate or echo
proprietary identifiers, company names, or customer names, and do not
de-anonymize a genericized concept to a specific named company/product.
</privacy_contract>
```

Then write that prompt to a tempfile and dispatch:

```bash
PROMPT_FILE="$(mktemp -t founder-frame-prompt.XXXXXX).xml"
# ADR-0017 §sub-decision 4 — stable run-id BEFORE dispatch.
RUN_ID="frame-$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%06x' $((RANDOM*RANDOM & 0xffffff)))"
# ... LLM writes the Frame XML prompt to $PROMPT_FILE (privacy gate must have passed) ...
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" run \
  --repo-root "$REPO_ROOT" --kind ensemble \
  --peer codex --prompt-file "$PROMPT_FILE" --output-format json \
  --workflow-path "$ACTIVE" --phase frame \
  --host "${AGENTIC_HOST:-claude}" --cwd "$REPO_ROOT" \
  --ensemble-type frame --run-id "$RUN_ID" \
  > "$PROMPT_FILE.run.json" 2> "$PROMPT_FILE.err" &
```

Use `run_in_background: true` on the Bash tool. `peer-runner.mjs run`
records the matching `pending_ensemble` row before spawning the companion
and writes raw peer output under the hidden peer-run ledger. Synthesize
per the AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT base categories.

Graceful degradation: companion missing or exit code 3
(`peer_cli_not_found` / `peer_unauthenticated` / `peer_invocation_error`)
→ proceed local-only and record "### Ensemble degraded:" in the body.

(founder's `skills/_shared/references/ensemble-protocol.md` §Frame carries
the formal prompt template + synthesis contract; the Frame dispatch shape
above mirrors the research-scan dispatch in
`skills/investigate/references/business-brief-ensemble.md`.)

---

## Phase 2 — State finalize

```bash
NOTE="### Ensemble launched: frame at <iso-utc>

### Ensemble synthesis: frame verdict=<agreed|concerns|conflict>

<AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown>

### Opportunity model

Problem / Opportunity: ...
Customer + Job-to-be-Done: ...
Value hypothesis: ...
Business-model sketch: ...
Constraints: ...
Validation criteria: ...
Key risks: ...
Out of scope: ...

### Active next-action proposal

- selected_next:         <verb | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + evidence-quality gate>
- evidence_pointers:     <opportunity-model fields / brief path — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /founder:<verb> … or \$founder:<verb> for a verb>
"

node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase-label "Phase 1: Frame (synthesized)" \
  --phase-note "$NOTE" \
  --current-phase phase-2-presented \
  --next-action "Decide on a business direction given this frame" \
  --event updated

# ADR-0017 §sub-decision 4 — atomic three-step ensemble-results commit.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ensemble-commit \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase frame --ensemble-type frame --run-id "$RUN_ID" \
  --verdict "$VERDICT" --summary "$SUMMARY" \
  --completed-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ADR-0017 §sub-decision 5 — atomic terminal write.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" set-terminal \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --terminal-phase summary-complete \
  --terminal-marker true \
  --next-action "Decide on a business direction given this frame" \
  --event updated
```

---

## Multi-axis lens at a 2+-branch point (ADR-0029 §2)

If executing this verb surfaces a **genuine 2+-branch decision point** —
two viable opportunity framings, or two candidate customer segments —
surface a **compact multi-axis lens** across the decisive business axes
(시장성 market-attractiveness / 단위경제 unit-economics, per ADR-0036 SD3)
+ size-appropriate supporting axes, instead of a flat list. Resolve the
sized axis set from founder's decision registry
(`skills/decide/references/decision-axes.yml`), or read the decisive axes
inline as above when the resolver is not reachable. Bounded: only at a
genuine 2+-branch point.

---

## Completion

Output the synthesized opportunity model and one of:

- `✓ Frame complete.` — typical case.
- `✓ Frame complete (ambiguous boundary).` — when CONFLICT appeared in
  the problem/opportunity or customer-segment between local and peer.
  Surface the ambiguity and pause for reconciliation before downstream
  verbs.

Then emit an **Active Next-Action Proposal** (the inline shape shown in
`skills/frame/SKILL.md` § Completion): typical `selected_next` candidates
are `/founder:decide` when 2+ directions need comparison (name the size
`--size=minor|standard|major`), or `/founder:compose` when the direction
is already obvious. Do not end with a hardcoded "next: X".

Always include the workflow path:

```
Workflow: <absolute path to workflow .md file>
```

founder surfaces the inline next-action proposal + the workflow path
above; the deeper runtime-completion-footer / ADR-0031 session-handoff
seam integration that the engineer plugin carries is not part of
founder's surface (future work if demand arrives).
