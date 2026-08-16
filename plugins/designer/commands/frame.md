---
description: Turn design/UX evidence into a structured UX problem model — user problem, job-to-be-done, goals, measurable UX success metrics, constraints, key risks
argument-hint: (natural-language framing trigger or design-brief summary)
---

# Designer · Frame

$ARGUMENTS

Maintain one progress entry per phase and advance its status as you go
— use the host's task-tracking tools when the session exposes them,
and keep an inline checklist when it does not. The peer ensemble runs automatically (Frame point type) — never
ask the user whether to invoke the peer, and never direct them to run
companion CLIs manually. When the companions plugin or peer CLI is
unavailable, the ensemble degrades silently to local-only.

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
# ADR-0042 — designer anchors to the frontend/design project git
# repository. If git rev-parse fails, refuse with manual-init guidance
# (git init, or cd into your frontend/design project repo).
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

- Empty `$ACTIVE` → bootstrap a new workflow with verb=frame:

  ```bash
  GIT_BRANCH="$(git branch --show-current)"
  GIT_HEAD="$(git rev-parse HEAD)"
  STATUS_DIGEST="$(git status --porcelain=v1 -z | shasum -a 256 | cut -d' ' -f1)"
  ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" create \
    --repo-root "$REPO_ROOT" \
    --verb frame --host "${AGENTIC_HOST:-claude}" --persona designer \
    --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
    --status-digest "$STATUS_DIGEST" \
    --original-request "${AGENTIC_TOPIC:-<one-line genericized design/UX topic>}" \
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
`designer` (canonical-home guard).

---

## Phase 1 — Execute frame

Follow the frame skill's command-invoked mode at
`$CLAUDE_PLUGIN_ROOT/skills/frame/SKILL.md`. The skill articulates the UX
problem model: user problem/opportunity, users + job-to-be-done, design
goals, MEASURABLE UX success metrics, constraints, key risks,
out-of-scope items.

Frame is single-mode (no `--profile` argument). Design context flows
through the Design Task Profile (canonically defined in the shared
`skills/_shared/references/orchestration.md` reference, restated inline in
the investigate skill).

### Privacy gate (before any external call)

PRIVACY GATE: proprietary UI, unreleased features/flows, customer data
visible in screenshots, and secret-bearing frontend code pass an explicit
privacy gate before BOTH web search AND peer-host dispatch. Genericize
before the peer prompt; the pre-genericization value MUST never leave the
local host. **Screenshots are sensitive by default** and are never sent to
the peer as bytes (the peer path is code/text-based; vision critique is a
same-host `designer:critique` capability). See
`skills/investigate/references/design-brief-spec.md` § Privacy Gate.

### Ensemble dispatch (Frame point type)

Build the Frame prompt and write it to a tempfile, then dispatch in the
background. The prompt template + synthesis contract live in
`skills/frame/SKILL.md` § Step 3 (and
`skills/_shared/references/ensemble-protocol.md` §Frame):

```bash
PROMPT_FILE="$(mktemp -t designer-frame-prompt.XXXXXX).xml"
# ADR-0017 §sub-decision 4 — stable run-id BEFORE dispatch.
RUN_ID="frame-$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%06x' $((RANDOM*RANDOM & 0xffffff)))"
# ... LLM writes the Frame XML prompt to $PROMPT_FILE (privacy gate must have passed; no screenshot bytes) ...
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
and writes raw peer output under the hidden peer-run ledger. Synthesize per
the AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT base categories.

Graceful degradation: companion missing or exit code 3
(`peer_cli_not_found` / `peer_unauthenticated` / `peer_invocation_error`)
→ proceed local-only and record "### Ensemble degraded:" in the body.

---

## Phase 2 — State finalize

```bash
NOTE="### Ensemble launched: frame at <iso-utc>

### Ensemble synthesis: frame verdict=<agreed|concerns|conflict>

<AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown>

### UX problem model

UX Problem / Opportunity: ...
Users + Job-to-be-Done: ...
Goals: ...
Measurable UX success metrics: ...
Constraints: ...
Key risks: ...
Out of scope: ...

### Active next-action proposal

- selected_next:         <verb | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + evidence-quality gate>
- evidence_pointers:     <UX-problem-model fields / brief path — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /designer:<verb> … or \$designer:<verb> for a verb>
"

node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase-label "Phase 1: Frame (synthesized)" \
  --phase-note "$NOTE" \
  --current-phase phase-2-presented \
  --next-action "Decide on a design direction given this frame (/designer:decide)" \
  --event updated

# ADR-0017 §sub-decision 4 — atomic three-step ensemble-results commit.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ensemble-commit \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase frame --ensemble-type frame --run-id "$RUN_ID" \
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
  --next-action "Decide on a design direction given this frame (/designer:decide)" \
  --event updated
```

---

## Multi-axis lens at a 2+-branch point (ADR-0029 §2)

If executing this verb surfaces a **genuine 2+-branch decision point** —
two viable UX problem framings, or two candidate user segments / primary
jobs — surface a **compact multi-axis lens** across the decisive design
axes (usability 사용성 + the context lens the question turns on, with
accessibility 접근성 as the veto gate, per ADR-0042 SD3) +
size-appropriate supporting axes, instead of a flat list. The designer
decision registry (`skills/decide/references/decision-axes.yml`) is the
axis source of truth; when it is unreachable, read the decisive axes
inline as above. Bounded: only at a genuine 2+-branch point.

---

## Completion

Output the synthesized UX problem model and one of:

- `✓ Frame complete.` — typical case.
- `✓ Frame complete (ambiguous boundary).` — when CONFLICT appeared in the
  UX problem or user-segment between local and peer. Surface the ambiguity
  and pause for reconciliation before downstream verbs.

Then emit an **Active Next-Action Proposal** (the inline shape shown in
`skills/frame/SKILL.md` § Completion): typical `selected_next` candidates
are `/designer:decide` when 2+ directions need comparison (name the size
`--size=minor|standard|major`), or `/designer:compose` when the direction
is already obvious. Do not end with a hardcoded "next: X".

ADR-0042 is `Accepted` — the full designer surface (the six verbs, the
`/designer:start` lifecycle macro, and the `resume` / `checkpoint` /
`peer-now` meta skills) ships, so every `next_command` is runnable. The UX problem model is the durable
handoff. See `skills/frame/SKILL.md` § Completion.

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
