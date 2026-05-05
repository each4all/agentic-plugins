---
description: Apply feedback, repair defects, iterate after critique — engineer's refinement verb
argument-hint: (fix description, finding reference, or critique scope)
---

# Engineer · Refine

$ARGUMENTS

Use `TaskCreate` and `TaskUpdate` to track progress. The peer ensemble
runs automatically per
`skills/_shared/references/ensemble-protocol.md` (Refine-verify point
type) — never ask the user whether to invoke the peer. When the
companions plugin or peer CLI is unavailable, the ensemble degrades
silently to local-only.

Plugin root: `$CLAUDE_PLUGIN_ROOT` (fallback as in
commands/investigate.md).

Core principle: do not modify code until the root cause is confirmed.
When refining a bug fix, the upstream contract is investigate
(root-cause profile) → decide (if 2+ fix approaches) → refine.
Skipping investigate paper-fixes symptoms.

---

## Phase 0 — Workflow continuity (per ADR-0011 §5)

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
  find-active --repo-root "$REPO_ROOT")"
```

- Empty → bootstrap with verb=refine:

  ```bash
  GIT_BRANCH="$(git branch --show-current)"
  GIT_HEAD="$(git rev-parse HEAD)"
  STATUS_DIGEST="$(git status --porcelain=v1 -z | shasum -a 256 | cut -d' ' -f1)"
  ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" create \
    --repo-root "$REPO_ROOT" \
    --verb refine --host claude --persona engineer \
    --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
    --status-digest "$STATUS_DIGEST" \
    --original-request "<one-line scrubbed user request>" \
    --current-phase phase-0-bootstrap \
    --next-action "Run refine skill")"
  ```

- Non-empty → append-on-resume:

  ```bash
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
    --workflow-path "$ACTIVE" --host claude --verb refine \
    --phase-label "Phase 0: Resume into refine" \
    --phase-note "Resumed from prior verb." \
    --current-phase phase-0-resume \
    --next-action "Run refine skill" --event resumed
  ```

---

## Phase 1 — Execute refine

Follow the refine skill's command-invoked mode at
`$CLAUDE_PLUGIN_ROOT/skills/refine/SKILL.md`. The skill applies the
fix, runs verification (tests / lint / type-check / smoke), and
confirms the change addresses the root cause without regressions.

Refine is single-mode (no `--profile` argument). Sub-discipline
context flows through the orchestrator-level Task Profile.

### Ensemble dispatch (Refine-verify point type)

Build the Refine-verify prompt per
`skills/_shared/references/ensemble-protocol.md` § Refine-verify.
The peer independently verifies that the fix addresses the symptom,
checks for over-fitting, and probes for regressions.

```bash
PROMPT_FILE="$(mktemp -t engineer-refine-prompt.XXXXXX).xml"
# ... LLM writes the Refine-verify XML prompt to $PROMPT_FILE ...
node "$CLAUDE_PLUGIN_ROOT/scripts/dispatch-peer.mjs" \
  --peer codex --prompt-file "$PROMPT_FILE" --output-format json \
  > "$PROMPT_FILE.out" 2> "$PROMPT_FILE.err" &
```

Synthesize per AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT. Peer-flagged
regressions or over-fitting concerns block completion until addressed.

---

## Phase 2 — State finalize

```bash
NOTE="### Ensemble launched: refine at <iso-utc>

### Ensemble synthesis: refine verdict=<agreed|concerns|conflict>

<AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown>

### Changes applied

<list of edited files with one-line summary; test/lint/type-check status>

### Verification

<test results, regression checks, root-cause confirmation>

### Recommended next verb

/engineer:critique  (to verify with another review pass)
  OR /engineer:investigate  (if root cause turned out to be deeper)
"

node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host claude \
  --phase-label "Phase 1: Refine (synthesized)" \
  --phase-note "$NOTE" \
  --current-phase phase-2-presented \
  --next-action "Critique to verify, or investigate deeper if root cause is uncertain" \
  --event updated
```

---

## Completion

Output the change summary and one of:

- `✓ Refinement complete.` + edited files + verification status.
  Recommend `/engineer:critique` to confirm with another review
  pass, or commit if the change is small and verified.
- `✓ Refinement blocked (peer flagged regression).` — when CONFLICT
  or significant peer concerns surfaced. Surface the issues; pause
  for user direction before retrying.
- `✓ Refinement complete (deeper root cause suspected).` —
  recommend `/engineer:investigate --profile=root-cause` to dig
  further before iterating again.

Always include the workflow path.
