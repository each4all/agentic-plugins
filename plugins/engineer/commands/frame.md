---
description: Turn evidence into a structured problem model — goals, constraints, audience, success criteria, risks
argument-hint: (natural-language framing trigger or evidence summary)
---

# Engineer · Frame

$ARGUMENTS

Use `TaskCreate` to register each phase and `TaskUpdate` to advance
status. The peer ensemble runs automatically per
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
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
  find-active --repo-root "$REPO_ROOT")"
```

- Empty `$ACTIVE` → bootstrap a new workflow with verb=frame:

  ```bash
  GIT_BRANCH="$(git branch --show-current)"
  GIT_HEAD="$(git rev-parse HEAD)"
  STATUS_DIGEST="$(git status --porcelain=v1 -z | shasum -a 256 | cut -d' ' -f1)"
  ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" create \
    --repo-root "$REPO_ROOT" \
    --verb frame --host claude --persona engineer \
    --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
    --status-digest "$STATUS_DIGEST" \
    --original-request "<one-line scrubbed user request>" \
    --current-phase phase-0-bootstrap \
    --next-action "Run frame skill")"
  ```

- Non-empty `$ACTIVE` → append-on-resume:

  ```bash
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
    --workflow-path "$ACTIVE" --host claude --verb frame \
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
node "$CLAUDE_PLUGIN_ROOT/scripts/dispatch-peer.mjs" \
  --peer codex --prompt-file "$PROMPT_FILE" --output-format json \
  --workflow-path "$ACTIVE" --phase frame \
  --ensemble-type frame --run-id "$RUN_ID" \
  > "$PROMPT_FILE.out" 2> "$PROMPT_FILE.err" &
```

Use `run_in_background: true` on the Bash tool. Synthesize per the
AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT base categories.

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

### Recommended next verb

/engineer:decide
"

node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host claude \
  --phase-label "Phase 1: Frame (synthesized)" \
  --phase-note "$NOTE" \
  --current-phase phase-2-presented \
  --next-action "Decide on a direction given this frame" \
  --event updated

# ADR-0017 §sub-decision 4 — atomic three-step ensemble-results commit.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ensemble-commit \
  --workflow-path "$ACTIVE" --host claude \
  --phase frame --ensemble-type frame --run-id "$RUN_ID" \
  --verdict "$VERDICT" --summary "$SUMMARY" \
  --completed-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ADR-0017 §sub-decision 5 — atomic terminal write. Bumps current_phase
# into the auto-archive whitelist + sets terminal_marker=true so the
# Stop hook can archive once the user commits and closes the session
# (HEAD-moved gate enforces real progress before archive triggers).
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" set-terminal \
  --workflow-path "$ACTIVE" --host claude \
  --terminal-phase summary-complete \
  --terminal-marker true \
  --next-action "Decide on a direction given this frame" \
  --event updated
```

---

## Completion

Output the synthesized problem model and one of:

- `✓ Frame complete.` — typical case. Recommend
  `/engineer:decide` (if 2+ approaches need comparison) or
  `/engineer:compose` (if direction is already obvious).
- `✓ Frame complete (ambiguous boundary).` — when CONFLICT appeared
  in the problem statement / scope between local and peer.
  Surface the ambiguity to the user and pause for reconciliation
  before downstream verbs.

Always include the workflow path:

```
Workflow: <absolute path to workflow .md file>
```
