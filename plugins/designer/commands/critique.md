---
description: Review a design spec or a rendered screen across the usability / accessibility / conversion / consistency lenses, with accessibility as a veto gate — designer's critique verb
argument-hint: --profile=usability|a11y|conversion|consistency | (default = all four active lenses)
---

# Designer · Critique

$ARGUMENTS

Maintain one progress entry per phase and advance its status as you go — use the host's task-tracking tools when the session exposes them, and keep an inline checklist when it does not. The peer ensemble runs
automatically (Review point type) — never ask the user whether to invoke the
peer, and never direct them to run companion CLIs manually. When the companions
plugin or peer CLI is unavailable, the ensemble degrades silently to local-only.

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

- Empty `$ACTIVE` → bootstrap with verb=critique:

  ```bash
  GIT_BRANCH="$(git branch --show-current)"
  GIT_HEAD="$(git rev-parse HEAD)"
  STATUS_DIGEST="$(git status --porcelain=v1 -z | shasum -a 256 | cut -d' ' -f1)"
  ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" create \
    --repo-root "$REPO_ROOT" \
    --verb critique --host "${AGENTIC_HOST:-claude}" --persona designer \
    --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
    --status-digest "$STATUS_DIGEST" \
    --profile "${AGENTIC_PROFILE:-<lens from \$ARGUMENTS; default = all four active lenses>}" \
    --original-request "${AGENTIC_TOPIC:-<one-line genericized critique target>}" \
    --current-phase phase-0-bootstrap \
    --next-action "Run critique skill")"
  ```

- Non-empty `$ACTIVE` → append-on-resume:

  ```bash
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --verb critique \
    --profile "<profile or empty>" \
    --phase-label "Phase 0: Resume into critique" \
    --phase-note "Resumed from prior verb. Profile=<...>." \
    --current-phase phase-0-resume \
    --next-action "Run critique skill" --event resumed
  ```

---

## Phase 1 — Execute critique

Follow the critique skill's command-invoked mode at
`$CLAUDE_PLUGIN_ROOT/skills/critique/SKILL.md`. The lenses (each holds the
artifact to `skills/critique/references/quality-criteria.md`):

- `usability` — Nielsen's 10 usability heuristics.
- `a11y` — WCAG 2.1/2.2 A/AA **candidate** checks (the `a11y` flag is an alias
  for the `accessibility` axis; the veto gate).
- `conversion` — CTA clarity, value legibility, funnel friction, honest persuasion.
- `consistency` — design-system + platform + internal-pattern conformance.

Profile selection: `--profile=<lens>` focuses one lens; missing profile runs
**all four active lenses**. An unknown profile, or one of the three
defined-but-inactive lenses (`desirability` / `content-clarity` / `feasibility`),
falls back to the full active set with a one-line warning. The accessibility gate
is evaluated even under a narrowed profile.

**Dual input (ADR-0042 SD4)**: critique accepts a **pre-code** design spec
(text; e.g. a `/designer:compose` artifact) and/or a **post-code** rendered
screen (a screenshot) + the frontend code that produced it. Vision is
**host-direct**: on the active host the model reads the screenshot directly
(Claude natively; Codex CLI via `codex exec --image <file>`), so a screenshot
critique run **on the active host is cross-host symmetric** — vision-grounded
critique is a **same-host** capability. Read the frontend source so
accessibility / consistency findings are grounded in markup, not only pixels.

Findings are severity-rated **CRITICAL / MAJOR / MINOR / SUGGESTION**; an
unmitigated accessibility veto gate FAIL is CRITICAL by definition. The gate is
candidate-level only (ADR-0042 Non-Goal 6): focus order, keyboard traversal, and
screen-reader behavior need runtime testing and are reported as unverified, not
certified.

### Privacy gate (before any external call)

PRIVACY GATE: proprietary UI, unreleased features/flows, customer data visible
in screenshots, and secret-bearing frontend code pass an explicit privacy gate
before BOTH web search AND peer-host dispatch. Genericize before the peer prompt;
the pre-genericization value MUST never leave the local host. **Screenshots are
sensitive by default** and are never sent to the peer as inline image bytes — the
peer path is code/text-based, or a **verified-local absolute file path** the peer
reads on its own host (the `plugins/image` critique-dispatch precedent);
`codex-companion` has no `--image` flag, so vision-grounded critique stays
same-host. When confidentiality is unclear, ask the user, or run local-only. See
`skills/investigate/references/design-brief-spec.md` § Privacy Gate.

### Ensemble dispatch (Review point type)

Build the Review prompt (the peer receives the genericized artifact — spec text
and/or frontend code, or a verified-local screenshot path, **never image bytes**
— and returns an independent code/text critique across the lenses: usability
signals, candidate a11y from markup, conversion/funnel logic, design-system
consistency), write it to a tempfile, and dispatch in the background. The prompt
template + synthesis contract land in
`skills/_shared/references/ensemble-protocol.md` § Review; the dispatch
shape mirrors the reference-scan dispatch in
`skills/investigate/references/design-brief-ensemble.md`:

```bash
PROMPT_FILE="$(mktemp -t designer-critique-prompt.XXXXXX).xml"
# ADR-0017 §sub-decision 4 — stable run-id BEFORE dispatch.
RUN_ID="review-$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%06x' $((RANDOM*RANDOM & 0xffffff)))"
# ... LLM writes the Review XML prompt to $PROMPT_FILE (privacy gate must have
#     passed; genericize the artifact; NO screenshot bytes — send code/text or a
#     verified-local absolute file path only) ...
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" run \
  --repo-root "$REPO_ROOT" --kind ensemble \
  --peer codex --prompt-file "$PROMPT_FILE" --output-format json \
  --workflow-path "$ACTIVE" --phase critique \
  --host "${AGENTIC_HOST:-claude}" --cwd "$REPO_ROOT" \
  --ensemble-type review --run-id "$RUN_ID" \
  > "$PROMPT_FILE.run.json" 2> "$PROMPT_FILE.err" &
```

Use `run_in_background: true` on the Bash tool. Note the dispatch above never
passes `--image` — the peer path has no image channel. The peer supplies the
code/text perspective; by default it receives no screenshot, so vision-grounded
findings (contrast as-rendered, visual hierarchy, spacing) are the same-host
model's responsibility, and no inline image bytes ever reach the peer. Synthesize
per AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT; an unmitigated accessibility gate
FAIL is CRITICAL regardless of which side found it.

Graceful degradation: companion missing or exit code 3
(`peer_cli_not_found` / `peer_unauthenticated` / `peer_invocation_error`)
→ proceed local-only and record "### Ensemble degraded:" in the body.

---

## Phase 2 — State finalize

```bash
NOTE="### Ensemble launched: critique (profile=<lens|all>) at <iso-utc>

### Ensemble synthesis: critique verdict=<agreed|concerns|conflict>

<AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown>

### Review report

Gate verdict: 접근성 Accessibility [PASS/CONDITIONAL/FAIL] (candidate-level; focus-order / keyboard / screen-reader unverified — runtime)

<severity-grouped findings: CRITICAL / MAJOR / MINOR / SUGGESTION, each
 [element/region] [lens] — [finding + failure signal + criteria ref]; plus Looks Strong>

### Active next-action proposal

- selected_next:         <verb | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — the decisive findings + the accessibility gate verdict>
- evidence_pointers:     <finding sections / criteria refs / artifact path — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /designer:<verb> … or \$designer:<verb> for a verb>
"

# ADR-0029 §1 — the workflow next-action mirrors the COMPACT form of the Active
# Next-Action Proposal above (selected_next + one-line why + next_command), NOT a
# fixed verb. `/designer:refine` is installed and runnable, but it is not the
# automatic next step: when the critique is clean (no CRITICAL/MAJOR + the gate
# is not FAIL) the next action is "commit / proceed", not refine. Derive it from
# the actual result rather than hard-coding a refine handoff.
NEXT_ACTION="<compact selected_next + why + next_command — e.g. 'Address CRITICAL/MAJOR findings (/designer:refine)' OR 'No blocking findings, gate not FAIL (PASS or CONDITIONAL with named preconditions) — proceed to commit'>"

node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase-label "Phase 1: Critique (synthesized)" \
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
    --phase critique --ensemble-type review --run-id "$RUN_ID" \
    --verdict "$VERDICT" --summary "$SUMMARY" \
    --completed-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi

# ADR-0029 §1 / completion-output contract §2 — $NEXT_ACTION above is already
# the COMPACT proposal form (selected_next + one-line why + next_command); the
# durable state and the code-emitted completion footer surface it verbatim as
# "recommended next work".
# ADR-0017 §sub-decision 5 — atomic terminal write.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" set-terminal \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --terminal-phase summary-complete \
  --terminal-marker true \
  --next-action "$NEXT_ACTION" \
  --event updated
```

---

## Multi-axis lens at a 2+-branch point (ADR-0029 §2)

If a critique surfaces a **genuine 2+-branch decision point** — two viable
remediation directions, or two defensible severity reads of the same finding —
surface a **compact multi-axis lens** across the decisive design axes (사용성
Usability + the archetype axis) + the accessibility gate, reading
`skills/decide/references/decision-axes.yml` (the
`scripts/decide-registry.mjs resolve --size=minor` resolver gives the compact
rendering of `balanced`). Bounded: only at a genuine 2+-branch point, never the
full matrix for a trivial reversible fix. A weightier fork routes to
`/designer:decide`.

---

## Completion

Output the severity-grouped report (leading with the gate verdict) and one of:

- `✓ Critique complete.` + count by severity.
- `✓ Critique complete (no significant findings).` — when no CRITICAL or MAJOR
  surfaced and the accessibility gate is not FAIL (`PASS`, or `CONDITIONAL` with
  its remediations named); the design is in good shape.

Then emit an **Active Next-Action Proposal** (the inline shape in
`skills/critique/SKILL.md` § Completion): typical `selected_next` is
`/designer:refine` to address the selected findings (CRITICAL + MAJOR by default;
the user picks which MINOR / SUGGESTION to include) — or `/designer:decide` when
a finding opens a genuine 2+-direction fork, or `/designer:investigate` when a
load-bearing accessibility / convention claim needs evidence. Do not end with a
hardcoded "next: X".

ADR-0042 is `Accepted` — the full designer surface (the six verbs, the
`/designer:start` lifecycle macro, and the `resume` / `checkpoint` /
`peer-now` meta skills) ships, so every `next_command` is runnable. The critique report is the durable
handoff. See `skills/critique/SKILL.md` § Completion.

Always include the workflow path:

```
Workflow: <absolute path to workflow .md file>
```

The runtime completion footer is **code-emitted** on this verb's terminal
path (ADR-0039, enabled for designer by ADR-0043 S4): `state.mjs
set-terminal` fires the ADR-0031 session-handoff sidecar, which shells out
to the runtime `footer.mjs` and prints the rendered footer — context
state, completion state (designer's manually-published mapping surfaces
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
