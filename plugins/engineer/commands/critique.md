---
description: Evaluate an existing artifact from multiple independent perspectives — engineer's review/audit verb
argument-hint: --profile=full-codebase[:security|performance|code-quality|debt|full] | (default = recent diff)
---

# Engineer · Critique

$ARGUMENTS

Use `TaskCreate` and `TaskUpdate` to track progress. The peer ensemble
runs automatically per
`skills/_shared/references/ensemble-protocol.md` — Review point type
for the default profile, Adversarial-scan for the `full-codebase`
profile. Never ask the user whether to invoke the peer.

Plugin root: `$CLAUDE_PLUGIN_ROOT` (fallback as in
commands/investigate.md).

A verb-level sugar alias `/engineer:audit` exists per ADR-0010 §3,
expanding to `/engineer:critique --profile=full-codebase`. The
canonical command is `/engineer:critique`.

---

## Phase 0 — Workflow continuity (per ADR-0011 §5)

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
  find-active --repo-root "$REPO_ROOT")"
```

- Empty → bootstrap with verb=critique:

  ```bash
  GIT_BRANCH="$(git branch --show-current)"
  GIT_HEAD="$(git rev-parse HEAD)"
  STATUS_DIGEST="$(git status --porcelain=v1 -z | shasum -a 256 | cut -d' ' -f1)"
  ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" create \
    --repo-root "$REPO_ROOT" \
    --verb critique --host claude --persona engineer \
    --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
    --status-digest "$STATUS_DIGEST" \
    --profile "<profile from \$ARGUMENTS, e.g., full-codebase, full-codebase:security>" \
    --original-request "<one-line scrubbed user request>" \
    --current-phase phase-0-bootstrap \
    --next-action "Run critique skill")"
  ```

- Non-empty → append-on-resume:

  ```bash
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
    --workflow-path "$ACTIVE" --host claude --verb critique \
    --profile "<profile or empty>" \
    --phase-label "Phase 0: Resume into critique" \
    --phase-note "Resumed from prior verb. Profile=<...>." \
    --current-phase phase-0-resume \
    --next-action "Run critique skill" --event resumed
  ```

---

## Phase 1 — Execute critique

Follow the critique skill's command-invoked mode at
`$CLAUDE_PLUGIN_ROOT/skills/critique/SKILL.md`. Profiles:

- (default) — standard parallel review of a recent change set
  (working tree or specific commit).
- `full-codebase` — adversarial audit of an entire area or codebase,
  with optional sub-focus (`security`, `performance`,
  `code-quality`, `debt`, `full`).

Profile selection: `--profile=<name>[:<sub-profile>]` on the command,
else inferred. Missing profile → default (recent diff). Unknown
profile → fallback to default with one-line warning.

### Ensemble dispatch — Review (default) or Adversarial-scan (full-codebase)

Build the prompt per the matching ensemble-protocol section:
- default profile → `skills/_shared/references/ensemble-protocol.md`
  § Review
- `full-codebase` → § Adversarial-scan (with the sub-focus narrowing)

```bash
PROMPT_FILE="$(mktemp -t engineer-critique-prompt.XXXXXX).xml"
# ADR-0017 §sub-decision 4 — stable run-id BEFORE dispatch.
# `$ENSEMBLE_TYPE` is `review` for the default critique profile and
# `adversarial-scan` for `--profile=full-codebase` (set in Phase 1).
RUN_ID="${ENSEMBLE_TYPE:-review}-$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%06x' $((RANDOM*RANDOM & 0xffffff)))"
# ... LLM writes the matching XML prompt to $PROMPT_FILE ...
node "$CLAUDE_PLUGIN_ROOT/scripts/dispatch-peer.mjs" \
  --peer codex --prompt-file "$PROMPT_FILE" --output-format json \
  --workflow-path "$ACTIVE" --phase critique \
  --ensemble-type "${ENSEMBLE_TYPE:-review}" --run-id "$RUN_ID" \
  > "$PROMPT_FILE.out" 2> "$PROMPT_FILE.err" &
```

Local agents (orchestrator side): default profile spawns review-style
agents (correctness, conventions, simplicity, security, etc.) per
`skills/_shared/references/agent-taxonomy.md`. `full-codebase` spawns
adversarial-mindset agents.

Synthesize per AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT. Findings
get severity ratings (CRITICAL / MAJOR / MINOR / SUGGESTION) per the
critique SKILL's contract.

---

## Phase 2 — State finalize

```bash
NOTE="### Ensemble launched: critique (profile=<...>) at <iso-utc>

### Ensemble synthesis: critique verdict=<agreed|concerns|conflict>

<AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown>

### Findings

<severity-grouped findings: CRITICAL / MAJOR / MINOR / SUGGESTION>

### Recommended next verb

/engineer:refine   (to address findings, typically CRITICAL + MAJOR)
"

node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host claude \
  --phase-label "Phase 1: Critique (synthesized)" \
  --phase-note "$NOTE" \
  --current-phase phase-2-presented \
  --next-action "Refine to address findings" \
  --event updated

# ADR-0017 §sub-decision 4 — atomic three-step ensemble-results commit.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ensemble-commit \
  --workflow-path "$ACTIVE" --host claude \
  --phase critique --ensemble-type "${ENSEMBLE_TYPE:-review}" --run-id "$RUN_ID" \
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
  --next-action "Refine to address findings" \
  --event updated
```

---

## Completion

Output the severity-grouped findings and one of:

- `✓ Critique complete.` + count by severity. Recommend
  `/engineer:refine` to address selected findings (typically
  CRITICAL + MAJOR scope; user picks which MINOR / SUGGESTION
  items to include).
- `✓ Critique complete (no significant findings).` — when no
  CRITICAL or MAJOR surfaced. The artifact is in good shape; no
  refine needed.

Always include the workflow path.
