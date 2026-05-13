---
description: Dispatch the next ready subtask into the engineer plugin (same-host) — ADR-0019 §1+§3 dispatch + parent-linkage
argument-hint: [<subtask-id>] [--workflow=<macro-id>]
---

# Orchestrator · Next

$ARGUMENTS

Dispatch one orchestrator macro subtask into the engineer plugin's command runbook, recording the immutable parent linkage (`AGENTIC_PARENT_WORKFLOW` + `AGENTIC_ORIGINATING_SUBTASK`) so engineer's terminal commit auto-writes back via `runStopArchive` per ADR-0019 §4. This is the **same-host default**; cross-host (`--peer`) remains trigger-deferred PR-F scope.

Use `TaskCreate` / `TaskUpdate` to track progress across the five phases below. Each phase is a discrete bash snippet — execute them in order and **abort on any non-zero exit** unless the snippet's commentary explicitly handles the failure.

Plugin root: `$CLAUDE_PLUGIN_ROOT` is the orchestrator plugin's resolved root for this command. Fallback when unset: `$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -maxdepth 3 -name plugin.json | xargs -I{} dirname {} | xargs -I{} dirname {} | sort -V | tail -1)`.

**Argument parsing**: extract from `$ARGUMENTS`:
- `EXPLICIT_SUBTASK_ID` ← the leading positional token (e.g., `PR1`), or empty if absent.
- `EXPLICIT_WORKFLOW_ID` ← value of `--workflow=<id>` flag, or empty if absent.

**Critical rules** (ADR-0019 §1):
- Do NOT invoke the engineer skill directly (`skills/<verb>/SKILL.md`) — bypasses Phase 0 bootstrap and breaks §4 auto-writeback.
- Do NOT call `engineer state.mjs create` directly — bypasses the engineer command's runbook semantics.
- All AGENTIC_* env exports + the engineer command's Phase 0+ snippets MUST run in the **same shell session** (a single Bash tool call). The Bash tool spawns a fresh process per call, so split execution drops the env exports — emit the prelude exports inline at the top of each engineer Phase 0 bash block, OR run the entire engineer Phase 0+verb as one consolidated Bash tool invocation. The CLAUDE_PLUGIN_ROOT rebind also lives in the same block; argv positions use `$ENGINEER_PLUGIN_ROOT` directly (not the rebound `$CLAUDE_PLUGIN_ROOT`).
- Branch precondition order is fixed: clean-check → resolve `subtasks[i].branch` → ownership-check → switch → invoke. Any reordering breaks the §1 invariants.

---

## Phase 0 — Workflow continuity (resolve the macro plan)

ADR-0019 §1 lines 187-213 — orchestrator workflows span multiple branches (macro + N subtask branches). Resolution order: `--workflow=<id>` override → `find-active` on current branch → `find-macro` branch-agnostic scan.

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
GIT_BRANCH="$(git branch --show-current)"
if [ -z "$GIT_BRANCH" ]; then
  echo "✗ Detached HEAD detected — orchestrator workflows are anchored to a branch (ADR-0018 §sub-2)." >&2
  echo "  Switch to the macro branch first: git switch <branch>" >&2
  exit 1
fi
FIND_ERR="${TMPDIR:-/tmp}/orchestrator-next-find-$$.err"
MACRO_PATH=""
if [ -n "${EXPLICIT_WORKFLOW_ID:-}" ]; then
  # Reject path-component overrides — `--workflow=../archive/<id>` would
  # otherwise let the macro path escape `workflows/` and target archived
  # or unrelated files (Codex P2 finding; mirrors PR-C's path-traversal
  # guard in parent-writeback.mjs).
  case "$EXPLICIT_WORKFLOW_ID" in
    */*|*\\*|..|.*|*$'\0'*)
      echo "✗ --workflow=$EXPLICIT_WORKFLOW_ID invalid — must be a basename-shaped workflow id (no '/', '\\\\', '..', leading '.', or NUL)." >&2
      rm -f "$FIND_ERR"
      exit 1;;
  esac
  MACRO_PATH="$REPO_ROOT/.claude/agentic-orchestrator/workflows/${EXPLICIT_WORKFLOW_ID}.md"
  if [ ! -f "$MACRO_PATH" ]; then
    echo "✗ --workflow=$EXPLICIT_WORKFLOW_ID not found at $MACRO_PATH." >&2
    echo "  Use \`gh pr list\` or run /orchestrator:plan to start a new macro." >&2
    rm -f "$FIND_ERR"
    exit 1
  fi
else
  MACRO_PATH="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
    find-active --repo-root "$REPO_ROOT" 2>"$FIND_ERR")"
  RC=$?
  if [ "$RC" -ne 0 ]; then
    cat "$FIND_ERR" >&2
    rm -f "$FIND_ERR"
    exit "$RC"
  fi
  if [ -z "$MACRO_PATH" ]; then
    MACRO_PATH="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
      find-macro --repo-root "$REPO_ROOT" --subtask-branch "$GIT_BRANCH" 2>"$FIND_ERR")"
    RC=$?
    if [ "$RC" -ne 0 ]; then
      # find-macro exits 1 + ambiguous diagnostic when two macros
      # reference the same subtask branch (ADR-0019 §1 fail-closed).
      cat "$FIND_ERR" >&2
      rm -f "$FIND_ERR"
      exit "$RC"
    fi
  fi
fi
rm -f "$FIND_ERR"
if [ -z "$MACRO_PATH" ]; then
  echo "✗ No macro workflow references branch '$GIT_BRANCH'." >&2
  echo "  Use --workflow=<id> to specify, or run /orchestrator:plan to start one." >&2
  exit 1
fi
MACRO_ID="$(basename "$MACRO_PATH" .md)"
```

---

## Phase 1 — Subtask selection (deterministic — Codex P2 policy)

Three outcomes — explicit id, automatic first-ready, or actionable diagnostic:

```bash
SUBTASK_JSON=""
if [ -n "${EXPLICIT_SUBTASK_ID:-}" ]; then
  # Explicit id — read that subtask. PR-C0's absorbing-completed
  # / terminal-partial preconditions reject downgrades downstream;
  # the runbook only validates the id resolves cleanly here.
  SUBTASK_JSON="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
    read-subtask --workflow-path "$MACRO_PATH" --subtask-id "$EXPLICIT_SUBTASK_ID")"
  if [ $? -ne 0 ]; then exit 1; fi
else
  # Automatic — first subtask with status=pending AND every blocked_by
  # predecessor status=completed. next-ready emits a structured JSON
  # diagnostic for the no-candidate cases so we can pick the right
  # recovery message.
  NEXT_OUT="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
    next-ready --workflow-path "$MACRO_PATH")"
  if [ $? -ne 0 ]; then exit 1; fi
  READY="$(echo "$NEXT_OUT" | node -e 'process.stdin.on("data", d => { try { const o = JSON.parse(d.toString()); if (o.ready) process.stdout.write(JSON.stringify(o.ready)); } catch {} })')"
  if [ -z "$READY" ]; then
    REASON="$(echo "$NEXT_OUT" | node -e 'process.stdin.on("data", d => { try { const o = JSON.parse(d.toString()); process.stdout.write(o.reason || "unknown"); } catch {} })')"
    case "$REASON" in
      empty_plan)
        echo "✗ Macro plan has no subtasks. Run /orchestrator:plan to add some." >&2
        exit 1;;
      all_terminal)
        echo "✓ All subtasks reached a terminal status — run /orchestrator:finalize to close the macro or wait for the auto-archive Stop hook." >&2
        exit 1;;
      in_progress_or_blocked)
        echo "✗ No subtask is ready to dispatch — at least one is in_progress (waiting for completion) or blocked (waiting on a predecessor)." >&2
        echo "  If a subtask completed externally, use /orchestrator:done <subtask-id> --commit=<sha> to record it." >&2
        echo "  Diagnostic JSON: $NEXT_OUT" >&2
        exit 1;;
      *)
        echo "✗ Unexpected next-ready reason: $REASON" >&2
        exit 1;;
    esac
  fi
  SUBTASK_JSON="$READY"
fi
SUBTASK_ID="$(echo "$SUBTASK_JSON" | node -e 'process.stdin.on("data", d => { try { process.stdout.write(JSON.parse(d.toString()).id || ""); } catch {} })')"
SUBTASK_VERB="$(echo "$SUBTASK_JSON" | node -e 'process.stdin.on("data", d => { try { process.stdout.write(JSON.parse(d.toString()).verb || ""); } catch {} })')"
SUBTASK_BRANCH="$(echo "$SUBTASK_JSON" | node -e 'process.stdin.on("data", d => { try { process.stdout.write(JSON.parse(d.toString()).branch || ""); } catch {} })')"
SUBTASK_PROFILE="$(echo "$SUBTASK_JSON" | node -e 'process.stdin.on("data", d => { try { process.stdout.write(JSON.parse(d.toString()).profile || ""); } catch {} })')"
SUBTASK_TOPIC="$(echo "$SUBTASK_JSON" | node -e 'process.stdin.on("data", d => { try { process.stdout.write(JSON.parse(d.toString()).topic || ""); } catch {} })')"
SUBTASK_STATUS="$(echo "$SUBTASK_JSON" | node -e 'process.stdin.on("data", d => { try { process.stdout.write(JSON.parse(d.toString()).status || ""); } catch {} })')"
SUBTASK_EXISTING_ENG_WF_ID="$(echo "$SUBTASK_JSON" | node -e 'process.stdin.on("data", d => { try { process.stdout.write(JSON.parse(d.toString()).engineer_workflow_id || ""); } catch {} })')"
```

Validate the resolved subtask is dispatch-ready (mirrors `next-ready`'s gate so explicit-id selection cannot bypass dependency ordering — Codex P2 finding):

```bash
case "$SUBTASK_STATUS" in
  completed) echo "✗ Subtask $SUBTASK_ID already completed; nothing to dispatch." >&2; exit 1;;
  deferred|abandoned) echo "✗ Subtask $SUBTASK_ID is terminal-partial ($SUBTASK_STATUS) — set by /orchestrator:finalize or /abort. Cannot re-dispatch." >&2; exit 1;;
  in_progress) ;;  # idempotent re-attach path handled in Phase 2 ownership check
  pending)
    # Verify all blocked_by predecessors are completed. Engineer-side
    # dispatch on a blocked subtask would corrupt macro ordering by
    # forcing it to in_progress before its predecessors land.
    NOT_READY="$(echo "$SUBTASK_JSON" | env MACRO_PATH="$MACRO_PATH" node -e '
      const fs = require("fs");
      process.stdin.on("data", async d => {
        try {
          const subtask = JSON.parse(d.toString());
          const deps = Array.isArray(subtask.blocked_by) ? subtask.blocked_by : [];
          if (deps.length === 0) { process.stdout.write(""); return; }
          // Walk the full plan to confirm each predecessor is completed.
          const text = fs.readFileSync(process.env.MACRO_PATH, "utf8");
          const fmMatch = text.match(/^---\n([\s\S]*?)\n---/);
          if (!fmMatch) { process.stdout.write("frontmatter-parse-failed"); return; }
          // Extract subtask ids with status=completed via a tiny scanner.
          const completed = new Set();
          let inSubtasks = false; let current = null;
          for (const line of fmMatch[1].split("\n")) {
            if (line.match(/^plan:/)) { inSubtasks = false; continue; }
            if (line.match(/^  subtasks:/)) { inSubtasks = true; continue; }
            if (!inSubtasks) continue;
            const idM = line.match(/^    - id: "?(.+?)"?$/);
            if (idM) { current = idM[1]; continue; }
            const stM = line.match(/^      status: "?(.+?)"?$/);
            if (stM && stM[1] === "completed") completed.add(current);
          }
          const missing = deps.filter(d => !completed.has(d));
          if (missing.length === 0) { process.stdout.write(""); return; }
          process.stdout.write("waiting-on:" + missing.join(","));
        } catch (e) { process.stdout.write("parse-failed:" + e.message); }
      });
    ')"
    if [ -n "$NOT_READY" ]; then
      echo "✗ Subtask $SUBTASK_ID is pending but not ready: $NOT_READY." >&2
      echo "  Complete the predecessor subtask(s) first (use /orchestrator:done <id> when finished) or pick a different subtask." >&2
      exit 1
    fi
    ;;
  blocked)
    echo "✗ Subtask $SUBTASK_ID is blocked — its blocked_by predecessors have not completed. Drive the predecessors first." >&2
    exit 1;;
esac
```

---

## Phase 2 — Branch precondition (ADR-0019 §1 lines 122-185, fixed order)

```bash
# Step 1: clean-worktree check — BEFORE any git switch.
if [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ]; then
  echo "✗ Working tree not clean — commit, stash, or revert before /orchestrator:next dispatches." >&2
  echo "  (engineer's Phase 0 status_digest capture is meaningful only on a clean tree.)" >&2
  exit 1
fi

# Step 2: resolve engineer plugin root via discover-engineer CLI.
ENGINEER_PLUGIN_ROOT="$(node "$CLAUDE_PLUGIN_ROOT/scripts/discover-engineer.mjs" discover 2>/dev/null)"
if [ -z "$ENGINEER_PLUGIN_ROOT" ]; then
  echo "✗ engineer plugin not found (env AGENTIC_ENGINEER_ROOT, Claude cache, Codex cache, sibling fallback all missed)." >&2
  echo "  Install engineer or set AGENTIC_ENGINEER_ROOT=<path> before /orchestrator:next dispatch." >&2
  exit 1
fi

# Step 3: ownership check on the subtask branch — re-attach / mismatch / no-active.
# Capture stderr so engineer's per-branch single-active invariant
# violations (multiple workflow files on the branch, corrupt file) are
# surfaced rather than swallowed (Codex P2 finding).
OWN_ERR="${TMPDIR:-/tmp}/orchestrator-next-own-$$.err"
EXISTING_ENG_PATH="$(node "$ENGINEER_PLUGIN_ROOT/scripts/state.mjs" \
  find-active --repo-root "$REPO_ROOT" --branch "$SUBTASK_BRANCH" 2>"$OWN_ERR")"
RC=$?
if [ "$RC" -ne 0 ]; then
  cat "$OWN_ERR" >&2
  rm -f "$OWN_ERR"
  exit "$RC"
fi
rm -f "$OWN_ERR"

# Recorded engineer_workflow_id missing from active workflows (Codex P2
# finding): if the subtask already references an engineer workflow id
# but find-active returns nothing on this branch, the previously
# recorded child was archived (or moved/deleted). Creating a new
# bootstrap would land an unrelated id, and Phase 5's writeback would
# reject it as ownership mismatch — leaving the user on the subtask
# branch with a stray active engineer workflow. Fail early instead.
if [ -n "$SUBTASK_EXISTING_ENG_WF_ID" ] && [ -z "$EXISTING_ENG_PATH" ]; then
  echo "✗ Subtask $SUBTASK_ID references engineer_workflow_id=$SUBTASK_EXISTING_ENG_WF_ID but no active engineer workflow exists on branch '$SUBTASK_BRANCH'." >&2
  echo "  The recorded child workflow may have been archived or deleted. Reconcile manually:" >&2
  echo "    1. If the child completed externally, use /orchestrator:done $SUBTASK_ID --commit=<sha>." >&2
  echo "    2. If you want to dispatch a fresh attempt, clear the engineer_workflow_id field by re-running /orchestrator:plan (full re-plan)." >&2
  exit 1
fi
RE_ATTACH=0
if [ -n "$EXISTING_ENG_PATH" ]; then
  EXISTING_ENG_PARENT="$(node "$ENGINEER_PLUGIN_ROOT/scripts/state.mjs" read \
    --workflow-path "$EXISTING_ENG_PATH" | node -e 'process.stdin.on("data", d => { try { const o = JSON.parse(d.toString()); process.stdout.write(o.parent_workflow || ""); } catch {} })')"
  EXISTING_ENG_SUBTASK="$(node "$ENGINEER_PLUGIN_ROOT/scripts/state.mjs" read \
    --workflow-path "$EXISTING_ENG_PATH" | node -e 'process.stdin.on("data", d => { try { const o = JSON.parse(d.toString()); process.stdout.write(o.originating_subtask || ""); } catch {} })')"
  if [ "$EXISTING_ENG_PARENT" = "$MACRO_ID" ] && [ "$EXISTING_ENG_SUBTASK" = "$SUBTASK_ID" ]; then
    RE_ATTACH=1
    echo "→ Idempotent re-attach: engineer workflow $(basename "$EXISTING_ENG_PATH" .md) already owns this subtask. Proceeding with switch + resume." >&2
  else
    echo "✗ engineer workflow already active on branch '$SUBTASK_BRANCH' with a different parent linkage." >&2
    echo "  Existing: parent_workflow=$EXISTING_ENG_PARENT, originating_subtask=$EXISTING_ENG_SUBTASK" >&2
    echo "  Requested: parent_workflow=$MACRO_ID, originating_subtask=$SUBTASK_ID" >&2
    echo "  Either archive the unrelated workflow ($EXISTING_ENG_PATH) or pick a different subtask branch in the macro plan." >&2
    exit 1
  fi
fi

# Step 4: switch. The user lands on $SUBTASK_BRANCH whether or not
# we re-attached — engineer's resume keys on `git branch --show-current`.
if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$SUBTASK_BRANCH"; then
  git -C "$REPO_ROOT" switch "$SUBTASK_BRANCH" || exit $?
else
  git -C "$REPO_ROOT" switch -c "$SUBTASK_BRANCH" || exit $?
fi
```

---

## Phase 3 — Engineer plugin minimum-version preflight

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/discover-engineer.mjs" preflight \
  --root "$ENGINEER_PLUGIN_ROOT" || {
  echo "✗ engineer install at $ENGINEER_PLUGIN_ROOT does not satisfy ADR-0019 PR-A minimum (preflight failed; see preceding diagnostic for cause)." >&2
  exit 1
}
```

The `preflight` subcommand prints the precise reason on its own stderr — surface it as-is.

---

## Phase 4 — Invoke engineer command (single-shell-session contract)

ADR-0019 §1 lines 252-287 — every emitted engineer snippet runs in a subshell with rebound `CLAUDE_PLUGIN_ROOT` and uses `$ENGINEER_PLUGIN_ROOT` directly in argv. Because the Bash tool spawns a fresh process per invocation, the exports MUST live in the **same bash block** as the engineer command's Phase 0 snippets — emit them as the prelude of a single combined Bash tool call.

**Host auto-detection** (Codex P2 finding): infer the host from `$CLAUDE_PLUGIN_ROOT` path shape (Claude cache lives under `~/.claude/`; Codex cache lives under `~/.codex/`). Direct-checkout development falls back to `claude` (override via `AGENTIC_HOST=codex` env if needed):

```bash
case "$CLAUDE_PLUGIN_ROOT" in
  *"/.codex/"*) DETECTED_HOST="codex" ;;
  *"/.claude/"*) DETECTED_HOST="claude" ;;
  *) DETECTED_HOST="${AGENTIC_HOST:-claude}" ;;
esac
```

Then drive the engineer command's runbook from a single Bash tool call. **Save the orchestrator's plugin root BEFORE rebinding** — Phase 5's `subtask-update` writeback is an orchestrator CLI that MUST be invoked through the orchestrator's `state.mjs`, not engineer's:

```bash
ORCH_PLUGIN_ROOT="$CLAUDE_PLUGIN_ROOT"          # save before rebind — Phase 5 needs this

export CLAUDE_PLUGIN_ROOT="$ENGINEER_PLUGIN_ROOT"
export AGENTIC_PARENT_WORKFLOW="$MACRO_ID"
export AGENTIC_ORIGINATING_SUBTASK="$SUBTASK_ID"
export AGENTIC_HOST="$DETECTED_HOST"

# Forward subtask profile/topic to the engineer command via env vars
# (orchestrator-defined contract). engineer's Phase 0 boilerplate reads
# AGENTIC_PROFILE and AGENTIC_TOPIC alongside the three parent-linkage
# vars and forwards them as --profile / --original-request flags to
# state.mjs create. This is the orchestrator-driven equivalent of the
# user typing `--profile=<X>` / a topic argument at the command line —
# the engineer command's `$ARGUMENTS` is replaced by env vars in the
# dispatched path because `$ARGUMENTS` is a magic slash-command variable
# that the host fills from user input, not from caller environment.
export AGENTIC_PROFILE="${SUBTASK_PROFILE:-}"
export AGENTIC_TOPIC="${SUBTASK_TOPIC:-}"

# Follow $ENGINEER_PLUGIN_ROOT/commands/$SUBTASK_VERB.md as if the user
# typed `/engineer:$SUBTASK_VERB`. The engineer command's Phase 0
# boilerplate reads all five AGENTIC_* env vars above and forwards
# them to state.mjs create (parent linkage + host + profile + topic).
```

**Important**: the LLM following this runbook MUST read engineer's command markdown and execute its bash snippets in the same Bash tool invocation as the exports above, OR re-emit the AGENTIC_* exports at the top of each engineer Phase 0 bash block. The simplest and most robust shape is a single Bash tool call that begins with the exports and proceeds through engineer's Phase 0+verb body inline.

---

## Phase 5 — Post-create writeback (engineer_workflow_id + status=in_progress)

After engineer's Phase 0 creates the workflow file and the verb skill begins, capture the engineer workflow id and write it back to the macro plan so `/orchestrator:done` and `find-active` can locate the child. **Critical**: use `$ORCH_PLUGIN_ROOT` (saved in Phase 4) — `$CLAUDE_PLUGIN_ROOT` is currently rebound to the engineer plugin root and would route `subtask-update` to the wrong state.mjs:

```bash
ACTIVE_PATH="$(node "$ENGINEER_PLUGIN_ROOT/scripts/state.mjs" \
  find-active --repo-root "$REPO_ROOT" --branch "$SUBTASK_BRANCH" 2>/dev/null)"
if [ -z "$ACTIVE_PATH" ]; then
  echo "✗ engineer command terminated but no active workflow on $SUBTASK_BRANCH — bootstrap may have failed (check engineer's preceding diagnostics)." >&2
  exit 1
fi
ENGINEER_WF_ID="$(basename "$ACTIVE_PATH" .md)"

node "$ORCH_PLUGIN_ROOT/scripts/state.mjs" subtask-update \
  --workflow-path="$MACRO_PATH" \
  --host="$DETECTED_HOST" \
  --subtask-id="$SUBTASK_ID" \
  --status=in_progress \
  --engineer-workflow-id="$ENGINEER_WF_ID" \
  --event=updated
```

Surface the orchestrator JSON envelope. PR-C0 handles single-writer ownership rejection, absorbing-completed precondition, and unblock/auto-terminal passes — surface its stderr verbatim on any non-zero exit.

If the envelope reports `skipped: true` (deferred / abandoned absorbing-terminal state), report it and stop — `/orchestrator:next` should NOT advance a subtask the user has already terminated via `/finalize` / `/abort`.

---

## Completion

Report one of:

- `✓ Subtask <id> dispatched. engineer_workflow_id=<id> on branch <branch>.` (happy path, status=in_progress recorded.)
- `✓ Subtask <id> already in_progress — re-attached to existing engineer workflow <id>.` (idempotent re-attach.)
- `✓ Subtask <id> auto-promoted: engineer Stop hook had already completed it; macro now terminal_marker=true.` (rare race; PR-C0 auto-terminal pass fired.)

When more subtasks remain ready, recommend the user follow up with `/orchestrator:next` after the current subtask commits. When all subtasks reach terminal status, recommend `/orchestrator:finalize` or expect the auto-archive once macro `terminal_marker` is set.

Append the runtime completion footer after the dispatch summary. Use the
runtime footer helper when available, or render the same fields manually:
context state, workflow id/path, artifact pointers, recommended next work,
and next-session action/command or prompt pointer. The footer is advisory
and pointer-only; do not mutate host session context or paste raw peer /
consensus output into the main session.
