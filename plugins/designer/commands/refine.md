---
description: Apply critique findings or feedback to a design spec or the frontend code + rendered screen, verify it reconciles, then re-critique to convergence — designer's refinement verb
argument-hint: (no profile — refine is single-mode; describe what to apply)
---

# Designer · Refine

$ARGUMENTS

Use `TaskCreate` and `TaskUpdate` to track progress. The peer ensemble runs
automatically (Refine-verify point type) — never ask the user whether to invoke
the peer, and never direct them to run companion CLIs manually. When the
companions plugin or peer CLI is unavailable, the ensemble degrades silently to
local-only.

Plugin root: `$CLAUDE_PLUGIN_ROOT` (set by Claude Code for plugin slash
commands). If unset, fall back to
`$(find ~/.claude/plugins/cache/agentic-plugins/designer -maxdepth 1 -mindepth 1 -type d | sort -V | tail -1)`.

> **designer is not an orchestrator dispatch target** (ADR-0042 Non-Goal
> 2): this command does NOT read `AGENTIC_PARENT_WORKFLOW` /
> `AGENTIC_ORIGINATING_SUBTASK`, and designer `state.mjs create` does not
> accept parent-linkage flags. designer workflows are user-invoked and
> branch-anchored only.

---

## Phase 0 — Workflow continuity (per ADR-0011 §5)

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
GIT_BRANCH="$(git branch --show-current)"
# ADR-0018 §sub-2 — designer workflows are anchored to a branch.
if [ -z "$GIT_BRANCH" ]; then
  echo "✗ Detached HEAD detected — designer workflows are anchored to a branch (ADR-0018 §sub-2)." >&2
  echo "  Switch to a branch first: git switch <branch>" >&2
  exit 1
fi
FIND_ERR="${TMPDIR:-/tmp}/designer-find-active-$$.err"
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

- Empty `$ACTIVE` → bootstrap with verb=refine (single-mode — **no `--profile`**):

  ```bash
  GIT_BRANCH="$(git branch --show-current)"
  GIT_HEAD="$(git rev-parse HEAD)"
  STATUS_DIGEST="$(git status --porcelain=v1 -z | shasum -a 256 | cut -d' ' -f1)"
  ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" create \
    --repo-root "$REPO_ROOT" \
    --verb refine --host "${AGENTIC_HOST:-claude}" --persona designer \
    --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
    --status-digest "$STATUS_DIGEST" \
    --original-request "${AGENTIC_TOPIC:-<one-line genericized refine target>}" \
    --current-phase phase-0-bootstrap \
    --next-action "Run refine skill")"
  ```

- Non-empty `$ACTIVE` → append-on-resume (refine is single-mode — no `--profile`):

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
`$CLAUDE_PLUGIN_ROOT/skills/refine/SKILL.md`. Refine is **single-mode** (no
`--profile` argument). The L4 design archetype flows through the Design Task
Profile per `skills/investigate/SKILL.md` § Design Task Profile (the shared
`skills/_shared/references/orchestration.md` reference).

Refine applies critique findings or feedback to the design artifact — a pre-code
design spec (user flow, wireframe spec, CTA copy, IA, component spec) OR a
post-code surface (the frontend code + the rendered screen) — and verifies the
revision holds together. The upstream contract is: `critique` (or `investigate`
for a load-bearing evidence gap) → `decide` (if 2+ viable remediation directions)
→ `refine`. When the remediation involves 2+ viable directions, route through
`/designer:decide` rather than choosing silently.

**Verify means the design still reconciles, not "run tests"**: confirm the
revised elements still carry their accessibility + consistency acceptance
criteria, the revised flow still honors the frame's measurable UX success
metrics, still-unvalidated assumptions keep their `[to be validated]` markers,
and — the load-bearing design gate — the change did **not** open a new
accessibility barrier. A revision that clears a usability/conversion problem by
introducing a candidate WCAG A/AA barrier has moved the veto gate, not cleared
it. The candidate-only accessibility boundary holds (ADR-0042 Non-Goal 6): focus
order, keyboard traversal, and screen-reader behavior need runtime testing and
are reported as unverified, not certified.

**The convergence loop (ADR-0042 SD4)**: critique → refine → re-critique until
findings converge. After applying the revision + the Refine-verify ensemble,
re-critique the revised artifact (for a post-code change, re-render + re-read the
screen host-direct — same-host vision). Loop until no new CRITICAL / MAJOR and the
accessibility gate passes.

### Privacy gate (before any external call)

PRIVACY GATE: proprietary UI, unreleased features/flows, customer data visible
in screenshots, and secret-bearing frontend code pass an explicit privacy gate
before BOTH web search AND peer-host dispatch. Genericize the revision before the
peer prompt; the pre-genericization value MUST never leave the local host.
**Screenshots are sensitive by default** and are never sent to the peer as inline
image bytes — the peer path is code/text-based, or a **verified-local absolute
file path** the peer reads on its own host (the `plugins/image` critique-dispatch
precedent); `codex-companion` has no `--image` flag, so vision-grounded
re-critique stays same-host. When confidentiality is unclear, ask the user, or run
local-only. See `skills/investigate/references/design-brief-spec.md` § Privacy Gate.

### Ensemble dispatch (Refine-verify point type)

Build the Refine-verify prompt (the peer receives the **genericized** before→after
of the changed elements — spec text and/or frontend code, or a verified-local
screenshot path, **never image bytes** — and verifies the revision resolves the
finding without introducing a new inconsistency or a new accessibility barrier),
write it to a tempfile, and dispatch in the background. The privacy gate must have
passed first. The prompt template + synthesis contract land in
`skills/_shared/references/ensemble-protocol.md` § Refine-verify; the
dispatch shape mirrors the reference-scan dispatch in
`skills/investigate/references/design-brief-ensemble.md`:

```bash
PROMPT_FILE="$(mktemp -t designer-refine-prompt.XXXXXX).xml"
# ADR-0017 §sub-decision 4 — stable run-id BEFORE dispatch.
RUN_ID="refine-verify-$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%06x' $((RANDOM*RANDOM & 0xffffff)))"
# ... LLM writes the Refine-verify XML prompt to $PROMPT_FILE (privacy gate must
#     have passed; genericize the before→after; NO screenshot bytes — send
#     code/text or a verified-local absolute file path only) ...
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" run \
  --repo-root "$REPO_ROOT" --kind ensemble \
  --peer codex --prompt-file "$PROMPT_FILE" --output-format json \
  --workflow-path "$ACTIVE" --phase refine \
  --host "${AGENTIC_HOST:-claude}" --cwd "$REPO_ROOT" \
  --ensemble-type refine-verify --run-id "$RUN_ID" \
  > "$PROMPT_FILE.run.json" 2> "$PROMPT_FILE.err" &
```

Use `run_in_background: true` on the Bash tool. Note the dispatch above never
passes `--image` — the peer path has no image channel. The peer supplies the
code/text verification (does the revision resolve the finding, does any element
now contradict the change, did the change open a new candidate a11y barrier); the
vision-grounded re-critique of the re-rendered screen is the same-host model's
responsibility, and no inline image bytes ever reach the peer. Synthesize per
AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT. A peer-flagged regression (a new
inconsistency or a new accessibility barrier) pauses the refine for user
direction. Loop apply → verify → re-critique until findings converge.

**Bounded convergence (no unbounded loop).** Run at most a bounded number of
apply → verify → re-critique passes (default 2, hard cap 3). If findings still do
not converge — each pass exposes a fresh CRITICAL / MAJOR, or the peer keeps
flagging a regression — STOP looping: set `CONVERGED=no`, PAUSE, and route to the
owner (a genuine 2+-direction remediation fork → `/designer:decide`; a
load-bearing unverified claim → `/designer:investigate`; otherwise present the
residual findings for an owner decision). Do not loop indefinitely.

**Post-code re-render is host-provided, not designer-run.** designer does not run
the frontend build. The vision re-critique of a post-code change reads the
re-rendered screen the user / frontend engineer supplies after rebuilding. If that
screen is unavailable, or the edit broke the render, the vision-grounded
re-critique CANNOT run: report the peer code/text verification only, flag the
visual re-critique **UNVERIFIED**, set `CONVERGED=no`, and do NOT claim full
convergence — a code/text-only pass is not a substitute for the visual re-critique
on a post-code change.

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
- Verified: <downstream elements reconcile; accessibility gate exposure
  unchanged; measurable success metrics intact; [to be validated] markers intact>
- Render status (post-code only): <re-rendered screen read host-direct | re-render unavailable / broke — vision re-critique UNVERIFIED | N/A (pre-code)>
- Re-critique: <converged — no new CRITICAL/MAJOR + accessibility gate PASS | NOT converged — new findings / regression / vision UNVERIFIED>
- Convergence: <CONVERGED | PAUSED — bounded passes exhausted / regression / render unavailable → routed to owner decision | /designer:decide | /designer:investigate>
- Deferred: <items not addressed and why>

### Active next-action proposal

- selected_next:         <verb | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — the design reconciles + the accessibility gate verdict>
- evidence_pointers:     <revised elements / criteria refs / artifact path — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /designer:<verb> … or \$designer:<verb> for a verb>
"

# ADR-0029 §1 — the workflow next-action mirrors the COMPACT form of the Active
# Next-Action Proposal above (selected_next + one-line why + next_command), NOT a
# fixed verb. The convergence handoff is a re-critique: when refine converged, the
# typical next action is "/designer:critique to confirm" OR "proceed / commit"
# when the change was small and reconciles. Derive it from the actual result.
NEXT_ACTION="<compact selected_next + why + next_command — e.g. 'Re-critique the revised artifact to confirm convergence (/designer:critique)' OR 'Converged, gate PASS — proceed / commit'>"

node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase-label "Phase 1: Refine (synthesized)" \
  --phase-note "$NOTE" \
  --current-phase phase-2-presented \
  --next-action "$NEXT_ACTION" \
  --event updated

# ADR-0017 §sub-decision 4 — atomic three-step ensemble-results commit.
# GUARD: only record an ensemble result when the peer actually launched. If the
# privacy gate forced local-only, or the companion was unavailable (graceful
# degradation), the ensemble did NOT run — $RUN_ID / $VERDICT / $SUMMARY are
# unset, so skip ensemble-commit and rely on the body note ("### Ensemble
# degraded:" or "### Ensemble skipped (local-only, privacy):") instead. Recording
# a blank result would fabricate a peer run that never happened.
if [ -n "${RUN_ID:-}" ] && [ -n "${VERDICT:-}" ]; then
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ensemble-commit \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
    --phase refine --ensemble-type refine-verify --run-id "$RUN_ID" \
    --verdict "$VERDICT" --summary "$SUMMARY" \
    --completed-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi

# ADR-0017 §sub-decision 5 — atomic terminal write. CONVERGENCE GUARD: mark the
# workflow terminal ONLY when the refine actually CONVERGED — the re-critique is
# clean (no new CRITICAL/MAJOR, accessibility gate PASS), no peer-flagged
# regression, and (post-code) the vision re-critique ran or is explicitly N/A. A
# PAUSED / non-converged refine (a new inconsistency, a new accessibility barrier,
# a bounded-pass exhaustion, or a re-render that could not be re-critiqued) leaves
# the workflow ACTIVE so the Stop hook cannot auto-archive an unresolved session.
# The user resolves the flagged item, then re-runs /designer:refine or routes to
# /designer:decide.
#
# FAIL-CLOSED: the default is `no`. Shell state does not survive across Bash tool
# invocations, so a lost CONVERGED must read as "convergence not established",
# never as success — `state.mjs set-terminal` also defaults `--terminal-marker`
# to true, so nothing downstream would catch a fail-open default. Assign it
# explicitly IN THIS BLOCK from the re-critique verdict.
CONVERGED="<yes|no — from the re-critique verdict; unset means no>"
if [ "${CONVERGED:-no}" = "yes" ]; then
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" set-terminal \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
    --terminal-phase summary-complete \
    --terminal-marker true \
    --next-action "$NEXT_ACTION" \
    --event updated
else
  echo "→ Refine PAUSED (non-convergence / regression / vision re-critique unavailable) — workflow left ACTIVE, NOT marked terminal. Resolve the flagged item, then re-run /designer:refine or route to /designer:decide." >&2
fi
```

---

## Multi-axis lens at a 2+-branch point (ADR-0029 §2)

If refine surfaces a **genuine 2+-branch decision point** — two viable
remediation directions, or two ways to close the same gap — surface a **compact
multi-axis lens** across the decisive design axes (사용성 Usability + the archetype
axis) + the accessibility gate, reading `skills/decide/references/decision-axes.yml`
(the `scripts/decide-registry.mjs resolve --size=minor` resolver gives the compact
rendering of `balanced`). Bounded: only at a genuine 2+-branch point, never the
full matrix for a trivial reversible fix. A weightier fork routes to
`/designer:decide`.

---

## Completion

Output the refinement summary (applied / verified / re-critique / deferred) and
one of:

- `✓ Refinement complete.` + the artifact revised and reconciled (re-critique
  converged, accessibility gate PASS).
- `✓ Refine paused.` — when the peer or the consistency re-critique surfaced a new
  inconsistency or a new accessibility barrier, the bounded passes were exhausted
  without convergence, or a post-code re-render could not be re-critiqued. The
  workflow is left ACTIVE (not marked terminal); resolve the flagged item, then
  re-run `/designer:refine` or route to `/designer:decide`.

Then emit an **Active Next-Action Proposal** (the inline shape in
`skills/refine/SKILL.md` § Completion): typical `selected_next` is
`/designer:critique` to re-critique the revised artifact and confirm convergence
— or "the design is sound, proceed" when the change was small and reconciles. Do
not end with a hardcoded "next: X".

designer is incubating (ADR-0042 `Proposed`) — the full surface (the six verbs,
the `/designer:start` lifecycle macro, and the `resume` / `checkpoint` /
`peer-now` meta skills) is installed as of PR6, so every `next_command` is
runnable. The persona flips to `Accepted` after the PR7 real-topic dogfood; the
SD3 axes and SD4 lenses stay PROVISIONAL until then. The refinement summary is the durable
handoff. See `skills/refine/SKILL.md` § Completion.

Always include the workflow path:

```
Workflow: <absolute path to workflow .md file>
```

designer surfaces the inline next-action proposal + the workflow path above; the
deeper runtime-completion-footer / ADR-0031 session-handoff seam integration that
the engineer plugin carries is not part of designer's surface (future work if
demand arrives).
