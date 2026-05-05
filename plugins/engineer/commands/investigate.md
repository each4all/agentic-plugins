---
description: Gather evidence, scan codebases, diagnose root causes — the engineer persona's evidence-gathering verb
argument-hint: --profile=analysis|root-cause | (or natural-language scope)
---

# Engineer · Investigate

$ARGUMENTS

Use `TaskCreate` to register each phase and `TaskUpdate` to advance
status. The peer ensemble runs automatically per
`skills/_shared/references/ensemble-protocol.md` — never ask the user
whether to invoke the peer, and never direct them to run companion
CLIs manually. When the companions plugin or peer CLI is unavailable,
the ensemble degrades silently to local-only.

The plugin root in shell snippets below is `$CLAUDE_PLUGIN_ROOT`
(set by Claude Code for plugin slash commands). If unset for any
reason, fall back to
`$(find ~/.claude/plugins/cache/agentic-plugins/engineer -maxdepth 1 -mindepth 1 -type d | sort -V | tail -1)`.

---

## Phase 0 — Workflow continuity (per ADR-0011 §5)

Determine workflow state via the host-shared canonical I/O module:

1. **Find active workflow**:

   ```bash
   REPO_ROOT="$(git rev-parse --show-toplevel)"
   ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
     find-active --repo-root "$REPO_ROOT")"
   ```

   - Empty `$ACTIVE` → no active workflow → bootstrap a new one (Step 2).
   - Non-empty path → active workflow → append-on-resume (Step 3).

2. **Bootstrap** (no active workflow):

   ```bash
   GIT_BRANCH="$(git branch --show-current)"
   GIT_HEAD="$(git rev-parse HEAD)"
   STATUS_DIGEST="$(git status --porcelain=v1 -z | shasum -a 256 | cut -d' ' -f1)"
   ACTIVE="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" create \
     --repo-root "$REPO_ROOT" \
     --verb investigate --host claude \
     --git-baseline-branch "$GIT_BRANCH" \
     --git-baseline-head "$GIT_HEAD" \
     --status-digest "$STATUS_DIGEST" \
     --persona engineer \
     --profile "<profile from $ARGUMENTS or 'analysis'>" \
     --original-request "<one-line scrubbed user request>" \
     --current-phase phase-0-bootstrap \
     --next-action "Run investigate skill")"
   ```

   `state.mjs create` enforces the directory-level lock + single-active
   invariant per ADR-0011 §3 — writes `.creation-lock`, atomically
   creates the workflow file, releases on completion.

3. **Append-on-resume** (active workflow exists):

   ```bash
   node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
     --workflow-path "$ACTIVE" --host claude \
     --verb investigate \
     --profile "<profile or empty>" \
     --phase-label "Phase 0: Resume into investigate" \
     --phase-note "Resumed from prior verb. Profile=<...>." \
     --current-phase phase-0-resume \
     --next-action "Run investigate skill" \
     --event resumed
   ```

   `state.mjs append` enforces the per-file lock with ownership token +
   stale detection per ADR-0011 §3.

---

## Phase 1 — Execute investigate

Follow the investigate skill's "When invoked by command" mode at
`$CLAUDE_PLUGIN_ROOT/skills/investigate/SKILL.md`. The skill performs:

- **Step 1**: Build the Task Profile (persona=engineer, profile, scope,
  layers, risks, complexity, ensemble affinity per
  `skills/_shared/references/orchestration.md`).
- **Step 2**: Spawn local agents in parallel (analysis profile →
  architecture-mapper / flow-tracer / dependency-analyzer; root-cause
  profile → hypothesis-tracer / regression-hunter / state-analyzer —
  selected by scope per `skills/_shared/references/agent-taxonomy.md`).
- **Step 3**: Dispatch the peer ensemble (Investigate or Explore point
  type per `skills/_shared/references/ensemble-protocol.md`) via
  `$CLAUDE_PLUGIN_ROOT/scripts/dispatch-peer.mjs`. The peer runs in
  the background; the orchestrator continues its own analysis in
  parallel.
- **Step 4**: Collect both sources, classify findings per the
  AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT base categories.
- **Step 5**: Present synthesized result per
  `skills/_shared/references/presentation-protocol.md`.

### Ensemble dispatch — concrete invocation

Build the prompt with `buildEnsemblePrompt` (or assemble the XML
directly per `companions/contract.md` §3) and spawn the peer in the
background:

```bash
PROMPT_FILE="$(mktemp -t engineer-investigate-prompt.XXXXXX).xml"
# ... LLM writes the XML prompt to $PROMPT_FILE ...
# Then dispatch in background:
node "$CLAUDE_PLUGIN_ROOT/scripts/dispatch-peer.mjs" \
  --peer codex --prompt-file "$PROMPT_FILE" --output-format json \
  > "$PROMPT_FILE.out" 2> "$PROMPT_FILE.err" &
```

(Use `run_in_background: true` on the Bash tool; collect output once
the orchestrator's local analysis completes.)

When the companion is missing or returns exit code 3
(`peer_cli_not_found` / `peer_unauthenticated` /
`peer_invocation_error`), record the failure in the workflow body
under "### Ensemble degraded:" and proceed with local-only synthesis
per the protocol's *Failure Handling*.

---

## Phase 2 — State finalize

After Phase 1 returns synthesized findings, append a phase note that
captures (a) the synthesis verdict, (b) ensemble launch + result
markers per `ensemble-protocol.md` § State Bookkeeping (Stage 2), and
(c) the recommended next verb:

```bash
NOTE="### Ensemble launched: investigate at <iso-utc>

### Ensemble synthesis: investigate verdict=<agreed|concerns|conflict>

<AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown>

### Findings

<top findings with file paths and line numbers>

### Recommended next verb

/engineer:<decide|frame|refine>
"

node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" append \
  --workflow-path "$ACTIVE" --host claude \
  --phase-label "Phase 1: Investigate (synthesized)" \
  --phase-note "$NOTE" \
  --current-phase phase-2-presented \
  --next-action "<one-sentence imperative for next verb>" \
  --event updated
```

---

## Completion

Output the synthesized findings and one of:

- `✓ Investigation complete.` — typical case. State the recommended
  next verb (most often `/engineer:decide` for 2+ approaches,
  `/engineer:refine` for an obvious fix, or `/engineer:frame` to
  reformulate the question).
- `✓ Investigation complete (full strike).` — when all local
  hypotheses AND the peer ensemble's diagnosis were refuted under the
  `root-cause` profile. Surface the user-facing prompt for additional
  context per the SKILL's *Full strike rule* — do NOT speculate on a
  cause not grounded in observable evidence.

Always include the workflow path so the user can inspect or resume:

```
Workflow: <absolute path to workflow .md file>
```
