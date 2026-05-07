---
description: Compare 2+ approaches under constraints, recommend a direction with rationale — engineer's decision verb
argument-hint: (decision question or list of options)
---

# Engineer · Decide

$ARGUMENTS

Use `TaskCreate` and `TaskUpdate` to track progress. The peer ensemble
runs automatically per
`skills/_shared/references/ensemble-protocol.md` (Brainstorm point
type) — never ask the user whether to invoke the peer. When the
companions plugin or peer CLI is unavailable, the ensemble degrades
silently to local-only.

Plugin root: `$CLAUDE_PLUGIN_ROOT` (fallback as in
commands/investigate.md).

---

## Phase 0 — Workflow continuity (per ADR-0011 §5)

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
  find-active --repo-root "$REPO_ROOT")"
```

- Empty → bootstrap with verb=decide:

  ```bash
  GIT_BRANCH="$(git branch --show-current)"
  GIT_HEAD="$(git rev-parse HEAD)"
  STATUS_DIGEST="$(git status --porcelain=v1 -z | shasum -a 256 | cut -d' ' -f1)"
  ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" create \
    --repo-root "$REPO_ROOT" \
    --verb decide --host claude --persona engineer \
    --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
    --status-digest "$STATUS_DIGEST" \
    --original-request "<one-line scrubbed user request>" \
    --current-phase phase-0-bootstrap \
    --next-action "Run decide skill")"
  ```

- Non-empty → append-on-resume:

  ```bash
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
    --workflow-path "$ACTIVE" --host claude --verb decide \
    --phase-label "Phase 0: Resume into decide" \
    --phase-note "Resumed from prior verb." \
    --current-phase phase-0-resume \
    --next-action "Run decide skill" --event resumed
  ```

---

## Phase 1 — Execute decide

Follow the decide skill's command-invoked mode at
`$CLAUDE_PLUGIN_ROOT/skills/decide/SKILL.md`. The skill performs
2+ option generation, evidence-based comparison across multiple
axes (tradeoffs, risks, scope, fit-with-frame), and recommends a
direction with explicit rationale. The user makes the final call.

Decide is single-mode (no `--profile` argument). Sub-discipline
context flows through the orchestrator-level Task Profile.

### Ensemble dispatch (Brainstorm point type)

Build the Brainstorm prompt per
`skills/_shared/references/ensemble-protocol.md` § Brainstorm and
dispatch in background:

```bash
PROMPT_FILE="$(mktemp -t engineer-decide-prompt.XXXXXX).xml"
# ... LLM writes the Brainstorm XML prompt to $PROMPT_FILE ...
node "$CLAUDE_PLUGIN_ROOT/scripts/dispatch-peer.mjs" \
  --peer codex --prompt-file "$PROMPT_FILE" --output-format json \
  > "$PROMPT_FILE.out" 2> "$PROMPT_FILE.err" &
```

Synthesize: merge orchestrator + peer option sets. PEER-ONLY
approaches → add. AGREED → elevate confidence. CONFLICT → present
both with evidence and ask the user.

---

## Phase 2 — State finalize

```bash
NOTE="### Ensemble launched: decide at <iso-utc>

### Ensemble synthesis: decide verdict=<agreed|concerns|conflict>

<AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown>

### Options compared

<table or list of options with tradeoffs>

### Recommendation

<chosen direction + rationale + risks>

### Recommended next verb

/engineer:compose
"

node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host claude \
  --phase-label "Phase 1: Decide (synthesized)" \
  --phase-note "$NOTE" \
  --current-phase phase-2-presented \
  --next-action "Compose the artifact for the chosen direction" \
  --event updated

# ADR-0017 §sub-decision 5 — atomic terminal write. Bumps current_phase
# into the auto-archive whitelist + sets terminal_marker=true so the
# Stop hook can archive once the user commits and closes the session
# (HEAD-moved gate enforces real progress before archive triggers).
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" set-terminal \
  --workflow-path "$ACTIVE" --host claude \
  --terminal-phase summary-complete \
  --terminal-marker true \
  --next-action "Compose the artifact for the chosen direction" \
  --event updated
```

---

## Completion

Output the comparison and one of:

- `✓ Decision recommended.` + chosen direction. Recommend
  `/engineer:compose` to produce the artifact (plan or code).
- `✓ Decision pending user input.` — when CONFLICT remained in the
  recommendation. Surface both options with evidence; pause until
  the user selects.

Always include the workflow path.
