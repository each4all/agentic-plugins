---
description: Produce the business planning artifact — venture plan, lean canvas, or validation plan — founder's composition verb (기획구상)
argument-hint: --profile=plan|canvas|validation-plan | (or natural-language planning target)
---

# Founder · Compose

$ARGUMENTS

Maintain one progress entry per phase and advance its status as you go — use the host's task-tracking tools when the session exposes them, and keep an inline checklist when it does not. The peer ensemble
runs automatically (Plan-verify point type) — never ask the user whether
to invoke the peer, and never direct them to run companion CLIs manually.
When the companions plugin or peer CLI is unavailable, the ensemble
degrades silently to local-only.

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

- Empty `$ACTIVE` → bootstrap with verb=compose:

  ```bash
  GIT_BRANCH="$(git branch --show-current)"
  GIT_HEAD="$(git rev-parse HEAD)"
  STATUS_DIGEST="$(git status --porcelain=v1 -z --untracked-files=normal | shasum -a 256 | cut -d' ' -f1)"
  ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" create \
    --repo-root "$REPO_ROOT" \
    --verb compose --host "${AGENTIC_HOST:-claude}" --persona founder \
    --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
    --status-digest "$STATUS_DIGEST" \
    --profile "${AGENTIC_PROFILE:-<profile from \$ARGUMENTS or 'plan'>}" \
    --original-request "${AGENTIC_TOPIC:-<one-line genericized planning target>}" \
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
`$CLAUDE_PLUGIN_ROOT/skills/compose/SKILL.md`. Profiles (the 기획 산출물
shapes):

- `plan` (default) — a structured **venture plan**: problem/opportunity,
  customer + JTBD, value proposition, market, business model, unit
  economics, go-to-market, milestones, key risks + mitigations, and the
  validation backlog.
- `canvas` — a one-page **lean / business-model canvas** (9 boxes).
- `validation-plan` — a **validation / experiment plan**: riskiest
  assumptions → cheapest tests → success criteria → decision rule.

Profile selection: `--profile=<name>` on the command, else inferred from
the user's intent. Missing profile → `plan`. Unknown profile → fallback to
`plan` with a one-line warning.

Compose is the planning composition (기획구상). It consumes upstream output
— a confirmed opportunity model from `/founder:frame` and (when 2+
directions existed) a chosen direction from `/founder:decide`. If either is
missing, suggest running the upstream verb first rather than composing on
incomplete inputs. The L4 business-model archetype (general default;
b2b-saas / consumer-app / commerce / content with demand) flows through the
Business Task Profile per `skills/_shared/references/orchestration.md`, not
a per-call flag.

### Privacy gate (before any external call)

PRIVACY GATE: proprietary venture concepts, interview/customer data, and
unpublished business material pass an explicit gate before BOTH web
search AND peer-host dispatch. Genericize before the peer prompt; the
pre-genericization value MUST never leave the local host. See
`skills/investigate/references/business-brief-spec.md` § Privacy Gate.

### Ensemble dispatch (Plan-verify point type)

Build the Plan-verify prompt (the peer receives the genericized draft plan
and returns gaps, sequencing issues, missing risks/assumptions, and
unit-economics holes), write it to a tempfile, and dispatch in background.
The prompt template + synthesis contract live in
`skills/_shared/references/ensemble-protocol.md` §Plan-verify:

```bash
PROMPT_FILE="$(mktemp -t founder-compose-prompt.XXXXXX).xml"
# ADR-0017 §sub-decision 4 — stable run-id BEFORE dispatch.
RUN_ID="plan-verify-$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%06x' $((RANDOM*RANDOM & 0xffffff)))"
# ... LLM writes the Plan-verify XML prompt to $PROMPT_FILE (privacy gate
#     must have passed; genericize the draft plan before the peer sees it) ...
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
receive the draft plan as input — its job is to find gaps in that specific
plan. Synthesize per AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT; gaps and
sequencing issues from the peer go directly into the plan's revision.

Graceful degradation: companion missing or exit code 3
(`peer_cli_not_found` / `peer_unauthenticated` / `peer_invocation_error`)
→ proceed local-only and record "### Ensemble degraded:" in the body.

---

## Phase 2 — State finalize

```bash
NOTE="### Ensemble launched: compose at <iso-utc>

### Ensemble synthesis: compose (profile=<plan|canvas|validation-plan>) verdict=<agreed|concerns|conflict>

<AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown>

### Artifact

<the planning artifact: venture plan sections / lean canvas boxes /
 validation-plan experiments — with [to be validated] markers on
 unverified assumptions>

### Active next-action proposal

- selected_next:         <verb | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + evidence-quality gate>
- evidence_pointers:     <plan sections / brief path — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /founder:<verb> … or \$founder:<verb> for a verb>
"

node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase-label "Phase 1: Compose (synthesized)" \
  --phase-note "$NOTE" \
  --current-phase phase-2-presented \
  --next-action "Critique the composed planning artifact" \
  --event updated

# ADR-0017 §sub-decision 4 — atomic three-step ensemble-results commit.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ensemble-commit \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase compose --ensemble-type plan-verify --run-id "$RUN_ID" \
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
# ARCHIVE TIMING — on Claude the Stop hook fires at EVERY turn end, so the
# archive gates are evaluated at the end of THIS turn, not at session close;
# if a gate fails the workflow stays marked and a later Stop re-evaluates it.
# Clearing the marker with `--terminal-marker false` works only before that
# Stop fires, needs set-terminal's full flag set (--workflow-path, --host,
# --terminal-phase), and does not restore the previous phase or next_action.
# On Codex the Stop hook runs only once the operator has trusted the plugin
# hooks (`/hooks`), so evaluation waits for that. Full contract:
# skills/_shared/references/session-handoff.md § Archive timing.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" set-terminal \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --terminal-phase summary-complete \
  --terminal-marker true \
  --next-action "Critique the composed planning artifact" \
  --event updated
```

---

## Multi-axis lens at a 2+-branch point (ADR-0029 §2)

If composing surfaces a **genuine 2+-branch decision point** — two viable
plan structures, two go-to-market wedges, two pricing models — surface a
**compact multi-axis lens** across the decisive business axes (시장성 /
단위경제) + the gates, instead of a flat list, reading
`skills/decide/references/decision-axes.yml` (the founder registry; the
`scripts/decide-registry.mjs resolve --size=minor` resolver gives the
compact 4-axis set). Bounded: only at a genuine 2+-branch point, never the
full matrix for a trivial reversible step. A weightier fork should route to
`/founder:decide` rather than be settled inline.

---

## Completion

Output the artifact (plan / canvas / validation-plan) and one of:

- `✓ Plan complete.` + path/anchor to the artifact.
- `✓ Compose paused (gaps surfaced).` — when the peer flagged significant
  gaps, missing risks, or unit-economics holes that warrant user input
  before proceeding.

Then emit an **Active Next-Action Proposal** (the inline shape in
`skills/compose/SKILL.md` § Completion): typical `selected_next` is
`/founder:critique` to review the artifact — or `/founder:decide` if
composing surfaced an undecided fork. Do not end with a hardcoded
"next: X".

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
