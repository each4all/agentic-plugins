---
description: Draft the design artifact — user flows, wireframe specs, CTA copy, IA, component specs — annotated with accessibility + consistency criteria. Designer's composition verb
argument-hint: --profile=spec|flow|wireframe | (or natural-language composition target)
---

# Designer · Compose

$ARGUMENTS

Use `TaskCreate` and `TaskUpdate` to track progress. The peer ensemble
runs automatically (Plan-verify point type) — never ask the user whether to
invoke the peer, and never direct them to run companion CLIs manually. When
the companions plugin or peer CLI is unavailable, the ensemble degrades
silently to local-only.

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

- Empty `$ACTIVE` → bootstrap with verb=compose:

  ```bash
  GIT_BRANCH="$(git branch --show-current)"
  GIT_HEAD="$(git rev-parse HEAD)"
  STATUS_DIGEST="$(git status --porcelain=v1 -z | shasum -a 256 | cut -d' ' -f1)"
  ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" create \
    --repo-root "$REPO_ROOT" \
    --verb compose --host "${AGENTIC_HOST:-claude}" --persona designer \
    --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
    --status-digest "$STATUS_DIGEST" \
    --profile "${AGENTIC_PROFILE:-<profile from \$ARGUMENTS or 'spec'>}" \
    --original-request "${AGENTIC_TOPIC:-<one-line genericized composition target>}" \
    --current-phase phase-0-bootstrap \
    --next-action "Run compose skill")"
  ```

- Non-empty `$ACTIVE` → append-on-resume:

  ```bash
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --verb compose \
    --profile "<profile or empty>" \
    --phase-label "Phase 0: Resume into compose" \
    --phase-note "Resumed from prior verb. Profile=<...>." \
    --current-phase phase-0-resume \
    --next-action "Run compose skill" --event resumed
  ```

---

## Phase 1 — Execute compose

Follow the compose skill's command-invoked mode at
`$CLAUDE_PLUGIN_ROOT/skills/compose/SKILL.md`. Profiles (the design-artifact
shapes):

- `spec` (default) — a **design spec** for the surface: information
  architecture, primary user flow, wireframe structure (text-level layout +
  content blocks), key component specs, and CTA/microcopy — every element
  annotated with accessibility + consistency acceptance criteria.
- `flow` — a **user-flow spec**: the task flow with entry points, branches,
  and the full state set per screen (default / loading / empty / error /
  success), plus the IA it traverses.
- `wireframe` — a **wireframe spec**: per-screen low-fidelity layout in
  text (regions, hierarchy, content blocks, primary/secondary actions, CTA
  copy) — code-first structure, NOT pixel mockups or generated imagery.

Profile selection: `--profile=<name>` on the command, else inferred from the
user's intent. Missing profile → `spec`. Unknown profile → fallback to
`spec` with a one-line warning.

Compose consumes upstream output — a confirmed UX problem model from
`/designer:frame` and (when 2+ directions existed) a chosen direction from
`/designer:decide`. If either is missing, suggest running the upstream verb
first rather than composing on incomplete inputs. The L4 design archetype
(general default; ui / flow / cta / content) flows through the Design Task
Profile per `skills/investigate/SKILL.md` § Design Task Profile (the shared
`skills/_shared/references/orchestration.md` reference), not a
per-call flag.

**Quality is annotated in (ADR-0042 SD4)**: every composed element carries
its accessibility (candidate WCAG A/AA checks) + consistency (design-system
component/token/pattern reuse) acceptance criteria — the criteria
`designer:critique` (PR5A) later holds the rendered UI to. Generated imagery
is an `image:compose` artifact handoff, never drawn here (see
`skills/_shared/references/orchestration.md` § image L2 composition boundary).

### Privacy gate (before any external call)

PRIVACY GATE: proprietary UI, unreleased features/flows, customer data
visible in screenshots, and secret-bearing frontend code pass an explicit
privacy gate before BOTH web search AND peer-host dispatch. Genericize
before the peer prompt; the pre-genericization value MUST never leave the
local host. **Screenshots are sensitive by default** and are never sent to
the peer as bytes (the peer path is code/text-based; vision critique is a
same-host `designer:critique` capability landing at PR5A). See
`skills/investigate/references/design-brief-spec.md` § Privacy Gate.

### Ensemble dispatch (Plan-verify point type)

Build the Plan-verify prompt (the peer receives the genericized draft spec
and returns gaps: missing states, unhandled edge cases, untested
accessibility criteria, design-system inconsistencies, responsive/RTL gaps,
ambiguous CTA copy), write it to a tempfile, and dispatch in background. The
prompt template + synthesis contract land in
`skills/_shared/references/ensemble-protocol.md` §Plan-verify; the
dispatch shape mirrors the reference-scan dispatch in
`skills/investigate/references/design-brief-ensemble.md`:

```bash
PROMPT_FILE="$(mktemp -t designer-compose-prompt.XXXXXX).xml"
# ADR-0017 §sub-decision 4 — stable run-id BEFORE dispatch.
RUN_ID="plan-verify-$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%06x' $((RANDOM*RANDOM & 0xffffff)))"
# ... LLM writes the Plan-verify XML prompt to $PROMPT_FILE (privacy gate
#     must have passed; genericize the draft spec, no screenshot bytes) ...
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" run \
  --repo-root "$REPO_ROOT" --kind ensemble \
  --peer codex --prompt-file "$PROMPT_FILE" --output-format json \
  --workflow-path "$ACTIVE" --phase compose \
  --host "${AGENTIC_HOST:-claude}" --cwd "$REPO_ROOT" \
  --ensemble-type plan-verify --run-id "$RUN_ID" \
  > "$PROMPT_FILE.run.json" 2> "$PROMPT_FILE.err" &
```

Use `run_in_background: true` on the Bash tool. The Independence-Rule
exception applies (per the engineer Plan-verify precedent): the peer DOES
receive the draft spec as input — its job is to find gaps in that specific
spec. Synthesize per AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT; gaps
(missing states, untested accessibility criteria) from the peer go directly
into the spec's revision.

Graceful degradation: companion missing or exit code 3
(`peer_cli_not_found` / `peer_unauthenticated` / `peer_invocation_error`)
→ proceed local-only and record "### Ensemble degraded:" in the body.

---

## Phase 2 — State finalize

```bash
NOTE="### Ensemble launched: compose at <iso-utc>

### Ensemble synthesis: compose (profile=<spec|flow|wireframe>) verdict=<agreed|concerns|conflict>

<AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown>

### Artifact

<the design artifact: IA / flow (with per-screen state set) / wireframe
 structure / component specs / CTA copy — every element annotated with its
 accessibility + consistency acceptance criteria, [to be validated] markers
 on unvalidated assumptions>

### Active next-action proposal

- selected_next:         <verb | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — how the artifact honors the confirmed frame + chosen direction, plus its accessibility + consistency acceptance criteria>
- evidence_pointers:     <spec sections / flow states / brief path — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /designer:<verb> … or \$designer:<verb> for a verb>
"

node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase-label "Phase 1: Compose (synthesized)" \
  --phase-note "$NOTE" \
  --current-phase phase-2-presented \
  --next-action "Critique the composed design spec (and the rendered screen once built)" \
  --event updated

# ADR-0017 §sub-decision 4 — atomic three-step ensemble-results commit.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ensemble-commit \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase compose --ensemble-type plan-verify --run-id "$RUN_ID" \
  --verdict "$VERDICT" --summary "$SUMMARY" \
  --completed-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ADR-0017 §sub-decision 5 — atomic terminal write.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" set-terminal \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --terminal-phase summary-complete \
  --terminal-marker true \
  --next-action "Critique the composed design spec (and the rendered screen once built)" \
  --event updated
```

---

## Multi-axis lens at a 2+-branch point (ADR-0029 §2)

If composing surfaces a **genuine 2+-branch decision point** — two viable
layout structures, two flow shapes, two component approaches — surface a
**compact multi-axis lens** across the decisive design axes (사용성 Usability
+ the archetype axis) + the accessibility gate, instead of a flat list,
reading `skills/decide/references/decision-axes.yml` (the
`scripts/decide-registry.mjs resolve --size=minor` resolver gives the
compact rendering of `balanced`). Bounded: only at a genuine 2+-branch
point, never the full matrix for a trivial reversible step. A weightier fork
should route to `/designer:decide` rather than be settled inline.

---

## Completion

Output the artifact (spec / flow / wireframe) and one of:

- `✓ Design spec complete.` + path/anchor to the artifact.
- `✓ Compose paused (gaps surfaced).` — when the peer flagged significant
  gaps, missing states, or untested accessibility criteria that warrant user
  input before proceeding.

Then emit an **Active Next-Action Proposal** (the inline shape in
`skills/compose/SKILL.md` § Completion): typical `selected_next` is
`/designer:critique` to evaluate the spec (and, once built, the rendered
screen) — or `/designer:decide` if composing surfaced an undecided fork. Do
not end with a hardcoded "next: X".

designer is incubating (ADR-0042 `Proposed`) — the full surface (the six verbs,
the `/designer:start` lifecycle macro, and the `resume` / `checkpoint` /
`peer-now` meta skills) is installed as of PR6, so every `next_command` is
runnable. The persona flips to `Accepted` after the PR7 real-topic dogfood; the
SD3 axes and SD4 lenses stay PROVISIONAL until then. The composed spec is the durable
handoff. See `skills/compose/SKILL.md` § Completion.

Always include the workflow path:

```
Workflow: <absolute path to workflow .md file>
```

designer surfaces the inline next-action proposal + the workflow path
above; the deeper runtime-completion-footer / ADR-0031 session-handoff seam
integration that the engineer plugin carries is not part of designer's
surface (future work if demand arrives).
