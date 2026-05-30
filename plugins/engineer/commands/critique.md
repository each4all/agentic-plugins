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

- Empty → bootstrap with verb=critique:

  ```bash
  GIT_BRANCH="$(git branch --show-current)"
  GIT_HEAD="$(git rev-parse HEAD)"
  STATUS_DIGEST="$(git status --porcelain=v1 -z | shasum -a 256 | cut -d' ' -f1)"
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
    --verb critique --host "${AGENTIC_HOST:-claude}" --persona engineer \
    --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
    --status-digest "$STATUS_DIGEST" \
    --profile "${AGENTIC_PROFILE:-<profile from \$ARGUMENTS, e.g., full-codebase, full-codebase:security>}" \
    --original-request "${AGENTIC_TOPIC:-<one-line scrubbed user request>}" \
    --current-phase phase-0-bootstrap \
    --next-action "Run critique skill" \
    "${PARENT_ARGS[@]}")"
  ```

- Non-empty → append-on-resume:

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
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" run \
  --repo-root "$REPO_ROOT" --kind ensemble \
  --peer codex --prompt-file "$PROMPT_FILE" --output-format json \
  --workflow-path "$ACTIVE" --phase critique \
  --host "${AGENTIC_HOST:-claude}" --cwd "$REPO_ROOT" \
  --ensemble-type "${ENSEMBLE_TYPE:-review}" --run-id "$RUN_ID" \
  > "$PROMPT_FILE.run.json" 2> "$PROMPT_FILE.err" &
```

Local agents (orchestrator side): default profile spawns review-style
agents (correctness, conventions, simplicity, security, etc.) per
`skills/_shared/references/agent-taxonomy.md`. `full-codebase` spawns
adversarial-mindset agents.

`peer-runner.mjs run` records the matching `pending_ensemble` row
before spawning the companion and writes raw peer output under the
hidden peer-run ledger; the background command's stdout is the small
runner JSON result (`envelope_path`, `stdout_path`, `stderr_path`,
`handle_path`). Synthesize per AGREED / LOCAL-ONLY / PEER-ONLY /
CONFLICT. Findings get severity ratings (CRITICAL / MAJOR / MINOR /
SUGGESTION) per the critique SKILL's contract.

---

## Phase 2 — State finalize

```bash
NOTE="### Ensemble launched: critique (profile=<...>) at <iso-utc>

### Ensemble synthesis: critique verdict=<agreed|concerns|conflict>

<AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown>

### Findings

<severity-grouped findings: CRITICAL / MAJOR / MINOR / SUGGESTION>

### Active next-action proposal

(per skills/_shared/references/entry-routing-contract.md
 § Active Next-Action Proposal — derived from these findings, not a fixed table)
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
  --phase-label "Phase 1: Critique (synthesized)" \
  --phase-note "$NOTE" \
  --current-phase phase-2-presented \
  --next-action "Refine to address findings" \
  --event updated

# ADR-0017 §sub-decision 4 — atomic three-step ensemble-results commit.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ensemble-commit \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase critique --ensemble-type "${ENSEMBLE_TYPE:-review}" --run-id "$RUN_ID" \
  --verdict "$VERDICT" --summary "$SUMMARY" \
  --completed-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ADR-0017 §sub-decision 5 — atomic terminal write. Bumps current_phase
# into the auto-archive whitelist + sets terminal_marker=true so the
# Stop hook can archive once the user commits and closes the session
# (HEAD-moved gate enforces real progress before archive triggers).
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" set-terminal \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --terminal-phase summary-complete \
  --terminal-marker true \
  --next-action "Refine to address findings" \
  --event updated
```

---

## Completion

Output the severity-grouped findings and one of:

- `✓ Critique complete.` + count by severity.
- `✓ Critique complete (no significant findings).` — when no
  CRITICAL or MAJOR surfaced. The artifact is in good shape.

Then emit an **Active Next-Action Proposal** instead of a fixed next
verb, per `skills/_shared/references/entry-routing-contract.md`
§ Active Next-Action Proposal: **selected_next**, **rejected_alternatives**
(1-2 + why-not), **rationale** (decisive axes 본질/근본 essence/foundation +
the Standards/Root-Cause gate), **evidence_pointers** (pointers only),
**confidence** (HIGH/MEDIUM/LOW), and **next_command** (the `/engineer:<verb> …` / `$engineer:<verb>` mention
for a verb, or the concrete action for `commit` / `owner decision`). Typical `selected_next` candidates for critique:
`/engineer:refine` to address selected findings (typically CRITICAL +
MAJOR; the user picks which MINOR / SUGGESTION items to include) — or
`commit` when no significant findings surfaced and the artifact is in good
shape. The routing table is the fallback only when evidence is genuinely
neutral — do not end with a hardcoded "next: X". When `selected_next` is
`engineer:decide`, also name the decision size
(`--size=minor|standard|major`) per the contract.

Always include the workflow path.

Append the runtime completion footer after the workflow path. Use the
runtime footer helper when available, or render the same fields manually:
context state, completion state plus state-derived next action, workflow
id/path, artifact pointers, recommended next work, and next-session
action/command or prompt pointer. The footer is advisory
and pointer-only; do not mutate host session context or paste raw peer /
consensus output into the main session.
