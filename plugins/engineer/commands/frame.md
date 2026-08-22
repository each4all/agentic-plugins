---
description: Turn evidence into a structured problem model — goals, constraints, audience, success criteria, risks
argument-hint: (natural-language framing trigger or evidence summary)
---

# Engineer · Frame

$ARGUMENTS

Maintain one progress entry per phase and advance its status as you go
— use the host's task-tracking tools when the session exposes them,
and keep an inline checklist when it does not. The peer ensemble runs automatically per
`skills/_shared/references/ensemble-protocol.md` (Frame point type) —
never ask the user whether to invoke the peer, and never direct them
to run companion CLIs manually. When the companions plugin or peer
CLI is unavailable, the ensemble degrades silently to local-only.

Plugin root: `$CLAUDE_PLUGIN_ROOT` (set by Claude Code for plugin
slash commands). If unset, fall back to
`$(find ~/.claude/plugins/cache/agentic-plugins/engineer -maxdepth 1 -mindepth 1 -type d | sort -V | tail -1)`.

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

- Empty `$ACTIVE` → bootstrap a new workflow with verb=frame:

  ```bash
  GIT_BRANCH="$(git branch --show-current)"
  GIT_HEAD="$(git rev-parse HEAD)"
  STATUS_DIGEST="$(git status --porcelain=v1 -z --untracked-files=normal | shasum -a 256 | cut -d' ' -f1)"
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
    --verb frame --host "${AGENTIC_HOST:-claude}" --persona engineer \
    --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
    --status-digest "$STATUS_DIGEST" \
    --original-request "${AGENTIC_TOPIC:-<one-line scrubbed user request>}" \
    --current-phase phase-0-bootstrap \
    --next-action "Run frame skill" \
    "${PARENT_ARGS[@]}")"
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
ownership token + 60s stale window per ADR-0011 §3.

---

## Phase 1 — Execute frame

Follow the frame skill's command-invoked mode at
`$CLAUDE_PLUGIN_ROOT/skills/frame/SKILL.md`. The skill articulates:
problem statement, goals, audience, constraints, success criteria,
risks, out-of-scope items.

Frame is single-mode (no `--profile` argument). Sub-discipline context
flows through the orchestrator-level Task Profile per
`skills/_shared/references/orchestration.md`.

### Ensemble dispatch (Frame point type)

Build the prompt per `skills/_shared/references/ensemble-protocol.md`
§ Frame, write it to a tempfile, and dispatch in background:

```bash
PROMPT_FILE="$(mktemp -t engineer-frame-prompt.XXXXXX).xml"
# ADR-0017 §sub-decision 4 — stable run-id BEFORE dispatch.
RUN_ID="frame-$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%06x' $((RANDOM*RANDOM & 0xffffff)))"
# ... LLM writes the Frame XML prompt to $PROMPT_FILE ...
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" run \
  --repo-root "$REPO_ROOT" --kind ensemble \
  --peer codex --prompt-file "$PROMPT_FILE" --output-format json \
  --workflow-path "$ACTIVE" --phase frame \
  --host "${AGENTIC_HOST:-claude}" --cwd "$REPO_ROOT" \
  --ensemble-type frame --run-id "$RUN_ID" \
  > "$PROMPT_FILE.run.json" 2> "$PROMPT_FILE.err" &
```

Use `run_in_background: true` on the Bash tool. `peer-runner.mjs run`
records the matching `pending_ensemble` row before spawning the
companion and writes raw peer output under the hidden peer-run ledger;
the background command's stdout is the small runner JSON result
(`envelope_path`, `stdout_path`, `stderr_path`, `handle_path`).
Synthesize per the AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT base
categories.

Graceful degradation: companion missing or exit code 3
(`peer_cli_not_found` / `peer_unauthenticated` / `peer_invocation_error`)
→ proceed local-only and record "### Ensemble degraded:" in the body.

---

## Phase 2 — State finalize

```bash
NOTE="### Ensemble launched: frame at <iso-utc>

### Ensemble synthesis: frame verdict=<agreed|concerns|conflict>

<AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown>

### Frame model

Problem statement: ...
Goals: ...
Audience: ...
Constraints: ...
Success criteria: ...
Risks: ...
Out of scope: ...

### Active next-action proposal

(per skills/_shared/references/entry-routing-contract.md
 § Active Next-Action Proposal — derived from this frame, not a fixed table)
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
  --phase-label "Phase 1: Frame (synthesized)" \
  --phase-note "$NOTE" \
  --current-phase phase-2-presented \
  --next-action "Decide on a direction given this frame" \
  --event updated

# ADR-0017 §sub-decision 4 — atomic three-step ensemble-results commit.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ensemble-commit \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase frame --ensemble-type frame --run-id "$RUN_ID" \
  --verdict "$VERDICT" --summary "$SUMMARY" \
  --completed-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ADR-0017 §sub-decision 5 — atomic terminal write. Bumps current_phase
# into the auto-archive whitelist + sets terminal_marker=true so the
# Stop hook can archive (the HEAD-moved gate still enforces real
# progress before the archive triggers).
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
  --next-action "Decide on a direction given this frame" \
  --event updated
```

---

## Multi-axis lens at a 2+-branch point (ADR-0029 §2)

If executing this verb surfaces a **genuine 2+-branch decision point**
— two viable problem framings, or two candidate scope boundaries, or a
non-neutral `selected_next` with 2+ candidates in the proposal below —
surface a **compact multi-axis lens** comparing the branches across the
resolved decisive axes (본질/근본 essence/foundation) + supporting axes,
instead of a flat list. Resolve the sized axis set from the shared
`$CLAUDE_PLUGIN_ROOT/scripts/decide-registry.mjs resolve --size=<minor|standard|major>`
resolver — the single axis source of truth, not a hand-authored list —
per `skills/_shared/references/entry-routing-contract.md`
§ "Surfacing the multi-axis lens from a non-decide verb".

Bounded: only at a genuine 2+-branch point (not every invocation),
default `--size=minor` (compact 4-axis), escalating only for weightier
branches — never the full 9-axis matrix for a trivial reversible step.
The full mechanism + the Codex path-resolution fallback live in
the contract subsection cited above.

---

## Completion

Output the synthesized problem model and one of:

- `✓ Frame complete.` — typical case.
- `✓ Frame complete (ambiguous boundary).` — when CONFLICT appeared
  in the problem statement / scope between local and peer.
  Surface the ambiguity to the user and pause for reconciliation
  before downstream verbs.

Then emit an **Active Next-Action Proposal** instead of a fixed next
verb, per `skills/_shared/references/entry-routing-contract.md`
§ Active Next-Action Proposal — the canonical six-field template
(runtime completion-output contract):

```
- selected_next:         <verb | commit | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + Standards/Root-Cause gate>
- evidence_pointers:     <phase notes / files / artifacts — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /engineer:<verb> … or $engineer:<verb> for a verb; the commit / owner-decision action otherwise>
```

Typical `selected_next` candidates for frame:
`/engineer:decide` when 2+ approaches need comparison, or
`/engineer:compose` when the direction is already obvious; the routing
table is the fallback only when evidence is genuinely neutral — do not end
with a hardcoded "next: X". When `selected_next` is `engineer:decide`, also
name the decision size (`--size=minor|standard|major`) per the contract.

Always include the workflow path:

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
