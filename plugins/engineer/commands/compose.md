---
description: Produce the artifact — plan, code, brief, interface, prompt, spec — engineer's composition verb
argument-hint: --profile=plan|code | (or natural-language composition target)
---

# Engineer · Compose

$ARGUMENTS

Use `TaskCreate` and `TaskUpdate` to track progress. The peer ensemble
runs automatically per
`skills/_shared/references/ensemble-protocol.md` (Plan-verify point
type — applies to both `plan` and `code` profiles per the section's
generalized intro). Never ask the user whether to invoke the peer.
When the companions plugin or peer CLI is unavailable, the ensemble
degrades silently to local-only.

Plugin root: `$CLAUDE_PLUGIN_ROOT` (fallback as in
commands/investigate.md).

---

## Phase 0 — Workflow continuity (per ADR-0011 §5)

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
  find-active --repo-root "$REPO_ROOT")"
```

- Empty → bootstrap with verb=compose:

  ```bash
  GIT_BRANCH="$(git branch --show-current)"
  GIT_HEAD="$(git rev-parse HEAD)"
  STATUS_DIGEST="$(git status --porcelain=v1 -z | shasum -a 256 | cut -d' ' -f1)"
  ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" create \
    --repo-root "$REPO_ROOT" \
    --verb compose --host claude --persona engineer \
    --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
    --status-digest "$STATUS_DIGEST" \
    --profile "<profile from \$ARGUMENTS or 'plan'>" \
    --original-request "<one-line scrubbed user request>" \
    --current-phase phase-0-bootstrap \
    --next-action "Run compose skill")"
  ```

- Non-empty → append-on-resume:

  ```bash
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
    --workflow-path "$ACTIVE" --host claude --verb compose \
    --profile "<profile or empty>" \
    --phase-label "Phase 0: Resume into compose" \
    --phase-note "Resumed from prior verb. Profile=<...>." \
    --current-phase phase-0-resume \
    --next-action "Run compose skill" --event resumed
  ```

---

## Phase 1 — Execute compose

Follow the compose skill's command-invoked mode at
`$CLAUDE_PLUGIN_ROOT/skills/compose/SKILL.md`. Profiles:

- `plan` (default) — produce a TDD task list with dependencies and
  success criteria.
- `code` — write the actual implementation files; run tests where
  applicable.

Profile selection: `--profile=<name>` on the command, else inferred
from the user's intent. Missing profile → `plan`. Unknown profile →
fallback to `plan` with one-line warning.

Core principle: a plan precedes code. Code without a confirmed plan
is speculation; code with a plan is verifiable task-by-task.

### Ensemble dispatch (Plan-verify point type)

Build the Plan-verify prompt per
`skills/_shared/references/ensemble-protocol.md` § Plan-verify
(reuse the same template for `code` profile, substituting the draft
plan with the diff or list of written files):

```bash
PROMPT_FILE="$(mktemp -t engineer-compose-prompt.XXXXXX).xml"
# ... LLM writes the Plan-verify XML prompt to $PROMPT_FILE ...
node "$CLAUDE_PLUGIN_ROOT/scripts/dispatch-peer.mjs" \
  --peer codex --prompt-file "$PROMPT_FILE" --output-format json \
  > "$PROMPT_FILE.out" 2> "$PROMPT_FILE.err" &
```

Independence exception (per ensemble-protocol.md § Independence
Rule): the peer DOES receive the orchestrator's draft plan as input
for this point type — its job is to find gaps in that specific plan.

Synthesize per AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT
categories. Gaps and ordering issues from the peer go directly into
the artifact's revision.

---

## Phase 2 — State finalize

```bash
NOTE="### Ensemble launched: compose at <iso-utc>

### Ensemble synthesis: compose (profile=<plan|code>) verdict=<...>

<AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown>

### Artifact

<plan: TDD task list, dependencies, success criteria
 OR code: list of changed files with one-line summary each>

### Recommended next verb

/engineer:critique
"

node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host claude \
  --phase-label "Phase 1: Compose (synthesized)" \
  --phase-note "$NOTE" \
  --current-phase phase-2-presented \
  --next-action "Critique the composed artifact" \
  --event updated

# ADR-0017 §sub-decision 5 — atomic terminal write. Bumps current_phase
# into the auto-archive whitelist + sets terminal_marker=true so the
# Stop hook can archive once the user commits and closes the session
# (HEAD-moved gate enforces real progress before archive triggers).
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" set-terminal \
  --workflow-path "$ACTIVE" --host claude \
  --terminal-phase summary-complete \
  --terminal-marker true \
  --next-action "Critique the composed artifact" \
  --event updated
```

---

## Completion

Output the artifact (plan or change set) and one of:

- `✓ Plan complete.` + path/anchor to the artifact, recommend
  `/engineer:critique` for review or `/engineer:compose --profile=code`
  to implement.
- `✓ Code change complete.` + summary of edited files, recommend
  `/engineer:critique` for review.
- `✓ Compose paused (gaps surfaced).` — when peer flagged
  significant gaps or ordering issues that warrant user input
  before proceeding.

Always include the workflow path.
