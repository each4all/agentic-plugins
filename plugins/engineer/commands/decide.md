---
description: Compare 2+ approaches under constraints, recommend a direction with rationale — engineer's decision verb
argument-hint: "[--size=<minor|standard|major>] [--preset=<id>] [--weights=<spec>] [--] <decision question or list of options>"
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

- Empty → bootstrap with verb=decide:

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
    --verb decide --host "${AGENTIC_HOST:-claude}" --persona engineer \
    --git-baseline-branch "$GIT_BRANCH" --git-baseline-head "$GIT_HEAD" \
    --status-digest "$STATUS_DIGEST" \
    --original-request "${AGENTIC_TOPIC:-<one-line scrubbed user request>}" \
    --current-phase phase-0-bootstrap \
    --next-action "Run decide skill" \
    "${PARENT_ARGS[@]}")"
  ```

- Non-empty → append-on-resume:

  ```bash
  node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
    --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" --verb decide \
    --phase-label "Phase 0: Resume into decide" \
    --phase-note "Resumed from prior verb." \
    --current-phase phase-0-resume \
    --next-action "Run decide skill" --event resumed
  ```

---

## Phase 0.5 — Resolve decision axes from the registry (ADR-0027 §5.6)

Parse `$ARGUMENTS` into flags + body and resolve the preset from
`skills/decide/references/decision-axes.yml`. The resulting
`ResolvedDecisionContext` JSON is stashed at
`$AGENTIC_DECIDE_CONTEXT_FILE` for the skill body to consume.

The CLI reuses `scripts/lib/decide-args.mjs` internally so the same
§2.3 flag grammar applies: unknown flags or invalid `--size=<tier>`
values produce a parser error and exit 2 (we halt). Body tokens go
after a `--` separator and are threaded into `context.body` per §5.6.

```bash
AGENTIC_DECIDE_CONTEXT_FILE="$(mktemp -t engineer-decide-context.XXXXXX).json"
DECIDE_RESOLVE_ERR="$(mktemp -t engineer-decide-resolve.XXXXXX).err"
export AGENTIC_DECIDE_CONTEXT_FILE

# `$ARGUMENTS` is the verbatim user input from the slash command.
# We expand it unquoted so the shell word-tokenizes flags / body
# tokens for the CLI; quoted body words in the user's input are
# preserved by shell quoting rules. `set -f` disables pathname
# expansion (globbing) during the expansion so body tokens like
# `*.md` reach the CLI literally instead of being expanded against
# the cwd — restore globbing immediately after.
set -f
node "$CLAUDE_PLUGIN_ROOT/scripts/decide-registry.mjs" resolve $ARGUMENTS \
  > "$AGENTIC_DECIDE_CONTEXT_FILE" 2>"$DECIDE_RESOLVE_ERR"
RESOLVE_RC=$?
set +f

# Surface warnings + diagnostics on stderr for the LLM and user.
[ -s "$DECIDE_RESOLVE_ERR" ] && cat "$DECIDE_RESOLVE_ERR" >&2
rm -f "$DECIDE_RESOLVE_ERR"

if [ "$RESOLVE_RC" -eq 2 ]; then
  # Parser error per §2.3(3-4) — halt before the skill body runs so
  # the user can fix the invocation. The diagnostic lines above
  # already identified the offending flag.
  echo "✗ decide-registry rejected the argument list — fix the invocation and rerun." >&2
  rm -f "$AGENTIC_DECIDE_CONTEXT_FILE"
  exit 1
elif [ "$RESOLVE_RC" -ne 0 ]; then
  echo "✗ decide-registry failed with exit $RESOLVE_RC; see diagnostics above." >&2
  exit 1
fi
```

The skill body reads `$AGENTIC_DECIDE_CONTEXT_FILE` to obtain:

- `axes[]` — ordered axis descriptors (id, en/ko labels, question, role) for the resolved preset
- `preset_id` — the active preset id (default | nine-axis | compact | …)
- `size` / `size_explicit` — the resolved ritual tier (minor | standard | major)
  populated from `--size=<tier>` per ADR-0027 §1.5(2). When `--size` was not
  passed, `size` defaults to `"standard"` and `size_explicit` is `false`. The
  ritual mapping (per-option output depth, comparison-table density,
  recommendation rigor) is documented in `skills/decide/SKILL.md` inside the
  four `@decide:*` marker regions.
- `weights` — reserved slot populated by PR4 once it lands

If the file is missing or the JSON is unparseable, fall back to the
in-code default preset (5-axis essence + foundation + standards +
best-practice + practical-fit) — the registry is a graceful-degradation
artifact per ADR-0027 §1.6.

---

## Phase 1 — Execute decide

Follow the decide skill's command-invoked mode at
`$CLAUDE_PLUGIN_ROOT/skills/decide/SKILL.md`. The skill performs
2+ option generation, evidence-based comparison across **the axes
resolved from `$AGENTIC_DECIDE_CONTEXT_FILE`** (tradeoffs, risks,
scope, fit-with-frame), and recommends a direction with explicit
rationale. The user makes the final call.

Decide is single-mode (no `--profile` argument). Sub-discipline
context flows through the orchestrator-level Task Profile.

### Ensemble dispatch (Brainstorm point type)

Build the Brainstorm prompt per
`skills/_shared/references/ensemble-protocol.md` § Brainstorm and
dispatch in background:

```bash
PROMPT_FILE="$(mktemp -t engineer-decide-prompt.XXXXXX).xml"
# ADR-0017 §sub-decision 4 — stable run-id BEFORE dispatch.
RUN_ID="brainstorm-$(date -u +%Y%m%dT%H%M%SZ)-$(printf '%06x' $((RANDOM*RANDOM & 0xffffff)))"
# ... LLM writes the Brainstorm XML prompt to $PROMPT_FILE ...
node "$CLAUDE_PLUGIN_ROOT/scripts/peer-runner.mjs" run \
  --repo-root "$REPO_ROOT" --kind ensemble \
  --peer codex --prompt-file "$PROMPT_FILE" --output-format json \
  --workflow-path "$ACTIVE" --phase decide \
  --host "${AGENTIC_HOST:-claude}" --cwd "$REPO_ROOT" \
  --ensemble-type brainstorm --run-id "$RUN_ID" \
  > "$PROMPT_FILE.run.json" 2> "$PROMPT_FILE.err" &
```

The peer-runner records the matching `pending_ensemble` row before
spawning the companion and writes raw peer output under the hidden
peer-run ledger; the background command's stdout is the small runner
JSON result (`envelope_path`, `stdout_path`, `stderr_path`,
`handle_path`). Synthesize: merge orchestrator + peer option sets.
PEER-ONLY approaches → add. AGREED → elevate confidence. CONFLICT →
present both with evidence and ask the user.

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
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase-label "Phase 1: Decide (synthesized)" \
  --phase-note "$NOTE" \
  --current-phase phase-2-presented \
  --next-action "Compose the artifact for the chosen direction" \
  --event updated

# ADR-0017 §sub-decision 4 — atomic three-step ensemble-results commit.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" ensemble-commit \
  --workflow-path "$ACTIVE" --host "${AGENTIC_HOST:-claude}" \
  --phase decide --ensemble-type brainstorm --run-id "$RUN_ID" \
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

Append the runtime completion footer after the workflow path. Use the
runtime footer helper when available, or render the same fields manually:
context state, completion state plus state-derived next action, workflow
id/path, artifact pointers, recommended next work, and next-session
action/command or prompt pointer. The footer is advisory
and pointer-only; do not mutate host session context or paste raw peer /
consensus output into the main session.
