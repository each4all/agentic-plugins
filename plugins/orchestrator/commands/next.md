---
description: Dispatch the next ready subtask into the engineer plugin (same-host) — ADR-0019 §1+§3 dispatch + parent-linkage
argument-hint: [<subtask-id>] [--workflow=<macro-id>]
---

# Orchestrator · Next

$ARGUMENTS

Dispatch one orchestrator macro subtask into the engineer plugin's command runbook, recording the immutable parent linkage (`AGENTIC_PARENT_WORKFLOW` + `AGENTIC_ORIGINATING_SUBTASK`) so the engineer can note its terminal commit on the macro and bind ownership (Phase 7 and the Stop hook, ADR-0019 §4 as changed by ADR-0062). The subtask completes when `/orchestrator:done` records the merge. This is the **same-host default**; cross-host (`--peer`) remains trigger-deferred PR-F scope.

Maintain one progress entry per phase across the five phases below and advance its status as you go — use the host's task-tracking tools when the session exposes them, and keep an inline checklist when it does not. Each phase is a discrete bash snippet — execute them in order and **abort on any non-zero exit** unless the snippet's commentary explicitly handles the failure.

Plugin root: each shell block below opens by setting `$CLAUDE_PLUGIN_ROOT` —
from `AGENTIC_ORCHESTRATOR_ROOT` when that is set, else from the plugin path
Claude Code writes into this command when it loads it, else from the newest
version in the plugin cache. Keep that opening line when you run a block: a
shell variable does not outlive a Bash call.

**Argument parsing**: extract from `$ARGUMENTS`:
- `EXPLICIT_SUBTASK_ID` ← the leading positional token (e.g., `PR1`), or empty if absent.
- `EXPLICIT_WORKFLOW_ID` ← value of `--workflow=<id>` flag, or empty if absent.

**Critical rules** (ADR-0019 §1):
- Do NOT invoke the engineer skill directly (`core/skills/<verb>/SKILL.md`) — bypasses Phase 0 bootstrap and drops the parent linkage the engineer terminal note needs.
- Do NOT call `engineer state.mjs create` directly — bypasses the engineer command's runbook semantics.
- All AGENTIC_* env exports + the engineer command's Phase 0+ snippets MUST run in the **same shell session** (a single Bash tool call). The Bash tool spawns a fresh process per call, so split execution drops the env exports — emit the prelude exports inline at the top of each engineer Phase 0 bash block, OR run the entire engineer Phase 0+verb as one consolidated Bash tool invocation. The CLAUDE_PLUGIN_ROOT rebind also lives in the same block; argv positions use `$ENGINEER_PLUGIN_ROOT` directly (not the rebound `$CLAUDE_PLUGIN_ROOT`).
- Branch precondition order is fixed: clean-check → resolve `subtasks[i].branch` → ownership-check → switch → invoke. Any reordering breaks the §1 invariants.

---

## Phase 0 — Workflow continuity (resolve the macro plan)

ADR-0019 §1 lines 187-213 — orchestrator workflows span multiple branches (macro + N subtask branches). Resolution order: `--workflow=<id>` override → `find-active` on current branch → `find-macro` branch-agnostic scan.

```bash
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
REPO_ROOT="$(git rev-parse --show-toplevel)"
GIT_BRANCH="$(git branch --show-current)"
if [ -z "$GIT_BRANCH" ]; then
  echo "✗ Detached HEAD detected — orchestrator workflows are anchored to a branch (ADR-0018 §sub-2)." >&2
  echo "  Switch to the macro branch first: git switch <branch>" >&2
  exit 1
fi
MACRO_PATH=""
if [ -n "${EXPLICIT_WORKFLOW_ID:-}" ]; then
  # Reject path-component overrides — `--workflow=../archive/<id>` would
  # otherwise let the macro path escape `workflows/` and target archived
  # or unrelated files (Codex P2 finding; mirrors PR-C's path-traversal
  # guard in parent-writeback.mjs).
  case "$EXPLICIT_WORKFLOW_ID" in
    # No NUL case: a shell variable cannot hold NUL, and bash expands $'\0'
    # to an empty string, which made the pattern match every id.
    */*|*\\*|..|.*)
      echo "✗ --workflow=$EXPLICIT_WORKFLOW_ID invalid — must be a basename-shaped workflow id (no '/', '\\\\', '..', or leading '.')." >&2
      exit 1;;
  esac
  CANONICAL_MACRO_PATH="$REPO_ROOT/.agentic-plugins/state/orchestrator/workflows/${EXPLICIT_WORKFLOW_ID}.md"
  LEGACY_MACRO_PATH="$REPO_ROOT/.claude/agentic-orchestrator/workflows/${EXPLICIT_WORKFLOW_ID}.md"
  if [ -f "$CANONICAL_MACRO_PATH" ]; then
    MACRO_PATH="$CANONICAL_MACRO_PATH"
  elif [ -f "$LEGACY_MACRO_PATH" ]; then
    MACRO_PATH="$LEGACY_MACRO_PATH"
  else
    echo "✗ --workflow=$EXPLICIT_WORKFLOW_ID not found in canonical or legacy workflow homes." >&2
    echo "  Use \`gh pr list\` or run /orchestrator:plan to start a new macro." >&2
    exit 1
  fi
else
  MACRO_PATH="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
    find-active --repo-root "$REPO_ROOT")"
  RC=$?
  if [ "$RC" -ne 0 ]; then
    exit "$RC"
  fi
  if [ -z "$MACRO_PATH" ]; then
    MACRO_PATH="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
      find-macro --repo-root "$REPO_ROOT" --subtask-branch "$GIT_BRANCH")"
    RC=$?
    if [ "$RC" -ne 0 ]; then
      # find-macro exits 1 + ambiguous diagnostic when two macros
      # reference the same subtask branch (ADR-0019 §1 fail-closed).
      exit "$RC"
    fi
  fi
fi
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
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
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
        # Dispatch guard (not a verb completion) — names the single honest
        # recovery for this state per session-handoff.md § Active Next-Action
        # Proposal meta/guard exception: the macro is ready to close.
        echo "✓ All subtasks reached a terminal status — nothing to dispatch. The macro is ready to close via /orchestrator:finalize (terminal close), or the auto-archive Stop hook once terminal_marker is set." >&2
        exit 1;;
      in_progress_or_blocked)
        # ADR-0062 §Decision 5 — print the facts next-ready computed from the
        # plan, not a guess from the status. An in_progress subtask whose
        # engineer workflow has committed stays in_progress until it lands.
        echo "✗ No subtask is ready to dispatch. Open subtasks:" >&2
        echo "$NEXT_OUT" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d);for(const r of o.readiness||[]){let why;if(r.status==="in_progress")why="in progress; once its pull request has merged, record it with /orchestrator:done "+r.id;else if(r.stale_blocked)why="marked blocked, but every predecessor is completed (written before the shared unblock pass); repair: state.mjs subtask-update --subtask-id="+r.id+" --status=pending";else if(r.waiting_on.length>0)why="waiting on "+r.waiting_on.join(", ");else why=r.status;process.stderr.write("  - "+r.id+": "+why+"\n")}})'
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
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# ADR-0062 §Decision 5 — the dependency facts come from the state CLI, which
# parses the plan properly; they hold for an explicitly chosen subtask even
# when another one is ready.
READINESS="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
  subtask-readiness --workflow-path "$MACRO_PATH" --subtask-id "$SUBTASK_ID")" || exit 1
WAITING_ON="$(echo "$READINESS" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(JSON.parse(d).waiting_on.join(", ")))')"
STALE_BLOCKED="$(echo "$READINESS" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>process.stdout.write(String(JSON.parse(d).stale_blocked)))')"
case "$SUBTASK_STATUS" in
  completed) echo "✗ Subtask $SUBTASK_ID already completed; nothing to dispatch." >&2; exit 1;;
  deferred|abandoned) echo "✗ Subtask $SUBTASK_ID is terminal-partial ($SUBTASK_STATUS) — set by /orchestrator:finalize or /abort. Cannot re-dispatch." >&2; exit 1;;
  in_progress) ;;  # idempotent re-attach path handled in Phase 2 ownership check
  pending)
    # Dispatching before every predecessor has landed would start this work
    # on a base that lacks it.
    if [ -n "$WAITING_ON" ]; then
      echo "✗ Subtask $SUBTASK_ID is pending but waits on: $WAITING_ON." >&2
      echo "  Record each predecessor with /orchestrator:done <id> once its pull request has merged, or pick a different subtask." >&2
      exit 1
    fi
    ;;
  blocked)
    if [ "$STALE_BLOCKED" = "true" ]; then
      echo "✗ Subtask $SUBTASK_ID is marked blocked, but every predecessor is completed — the file was written before the shared unblock pass (ADR-0062 §Decision 5)." >&2
      echo "  Repair: node \"$CLAUDE_PLUGIN_ROOT/scripts/state.mjs\" subtask-update --workflow-path \"$MACRO_PATH\" --host <host> --subtask-id $SUBTASK_ID --status=pending, then rerun /orchestrator:next." >&2
    else
      echo "✗ Subtask $SUBTASK_ID is blocked — it waits on: $WAITING_ON." >&2
    fi
    exit 1;;
esac
```

Then apply the plan-approval gate (ADR-0063 D4 rule 3, owner decision D3).
`state.mjs approval-gate` decides from the approval facts `next-ready` reports
(`{status, hash_ok}`), so this runbook never compares plan hashes itself. It
runs for an explicit id as well as for the automatic pick, because
`subtask-readiness` reports no approval. It is given the subtask as selected
above, because that — not the plan the gate reads — is what Phases 4 and 5
dispatch.

- **Autopilot** (`AGENTIC_AUTOPILOT` names a run): a plan that is not approved
  at its current hash — pending approval, changed since it was approved, or
  never approved — is refused with `✗ plan-unapproved` and a pointer to where
  the owner acts, exit 1. Stop there: only the owner approves
  (`/orchestrator:approve`). So is a selected subtask that differs from the
  approved plan's entry (the plan changed after the selection); rerun
  `/orchestrator:next`.
- **Interactive:** never refused. A plan pending approval or changed since it
  was approved gets one warning line, and dispatch continues. A macro planned
  before schema 1.2 has no approval keys and dispatches as before, with no line.

```bash
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# The gate prints its warning or refusal on stderr; the JSON verdict it
# prints on stdout is for scripts, not for this runbook.
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" approval-gate \
  --workflow-path "$MACRO_PATH" --host claude \
  --subtask-json "$SUBTASK_JSON" >/dev/null || exit 1
```

---

## Phase 2 — Branch precondition (ADR-0019 §1 lines 122-185, fixed order)

```bash
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
# Step 1: clean-worktree check — BEFORE any git switch.
if [ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=normal)" ]; then
  echo "✗ Working tree not clean — commit, stash, or revert before /orchestrator:next dispatches." >&2
  echo "  (engineer's Phase 0 status_digest capture is meaningful only on a clean tree.)" >&2
  exit 1
fi

# Step 2: resolve engineer plugin root via discover-engineer CLI.
ENGINEER_PLUGIN_ROOT="$(node "$CLAUDE_PLUGIN_ROOT/scripts/discover-engineer.mjs" discover)"  # stderr kept: a cross-host fallback is reported there (ADR-0061)
if [ -z "$ENGINEER_PLUGIN_ROOT" ]; then
  echo "✗ engineer plugin not found (env AGENTIC_ENGINEER_ROOT, Claude cache, Codex cache, sibling fallback all missed)." >&2
  echo "  Install engineer or set AGENTIC_ENGINEER_ROOT=<path> before /orchestrator:next dispatch." >&2
  exit 1
fi

# Step 3: ownership check on the subtask branch — re-attach / mismatch / no-active.
# stderr is left alone, not redirected, so engineer's per-branch
# single-active invariant violations (multiple workflow files on the branch,
# corrupt file) reach the output rather than being swallowed (Codex P2 finding).
EXISTING_ENG_PATH="$(node "$ENGINEER_PLUGIN_ROOT/scripts/state.mjs" \
  find-active --repo-root "$REPO_ROOT" --branch "$SUBTASK_BRANCH")"
RC=$?
if [ "$RC" -ne 0 ]; then
  exit "$RC"
fi

# Recorded engineer_workflow_id missing from active workflows (Codex P2
# finding): if the subtask already references an engineer workflow id
# but find-active returns nothing on this branch, the previously
# recorded child was archived (or moved/deleted). Creating a new
# bootstrap would land an unrelated id, and Phase 5's writeback would
# reject it as ownership mismatch — leaving the user on the subtask
# branch with a stray active engineer workflow. Fail early instead.
if [ -n "$SUBTASK_EXISTING_ENG_WF_ID" ] && [ -z "$EXISTING_ENG_PATH" ]; then
  echo "✗ Subtask $SUBTASK_ID references engineer_workflow_id=$SUBTASK_EXISTING_ENG_WF_ID but no active engineer workflow exists on branch '$SUBTASK_BRANCH'." >&2
  echo "  The recorded child has usually finished its commit and been archived; the subtask stays in_progress until the work lands (ADR-0062)." >&2
  echo "    1. Once its pull request has merged, record it with /orchestrator:done $SUBTASK_ID." >&2
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
# A new branch starts from the integration branch (the macro's baseline
# branch) as the remote last reported it, never from the checked-out HEAD:
# after a squash or rebase merge, the previous subtask's branch is not part
# of the integration branch, and a successor built on it would carry
# obsolete history (ADR-0062 §Decision 2).
# --- ADR-0062 branch-base step (extracted by tests) ---
INTEGRATION_BRANCH="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" read --workflow-path "$MACRO_PATH" \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).git_baseline.branch||"")}catch{}})')"
if [ -z "$INTEGRATION_BRANCH" ]; then
  echo "✗ The macro records no git_baseline.branch; cannot tell which branch subtasks start from." >&2
  exit 1
fi
if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$SUBTASK_BRANCH"; then
  git -C "$REPO_ROOT" switch "$SUBTASK_BRANCH" || exit $?
elif git -C "$REPO_ROOT" remote get-url origin >/dev/null 2>&1; then
  if ! git -C "$REPO_ROOT" fetch --quiet origin "$INTEGRATION_BRANCH"; then
    echo "⚠ git fetch origin $INTEGRATION_BRANCH failed; branching from the last fetched origin/$INTEGRATION_BRANCH." >&2
  fi
  if ! git -C "$REPO_ROOT" show-ref --verify --quiet "refs/remotes/origin/$INTEGRATION_BRANCH"; then
    echo "✗ refs/remotes/origin/$INTEGRATION_BRANCH does not exist; cannot start $SUBTASK_BRANCH from the integration branch." >&2
    exit 1
  fi
  git -C "$REPO_ROOT" switch --no-track -c "$SUBTASK_BRANCH" "refs/remotes/origin/$INTEGRATION_BRANCH" || exit $?
  echo "→ Created $SUBTASK_BRANCH from origin/$INTEGRATION_BRANCH at $(git -C "$REPO_ROOT" rev-parse --short HEAD)." >&2
else
  # A repository without an origin remote has only the local branch.
  git -C "$REPO_ROOT" switch -c "$SUBTASK_BRANCH" "refs/heads/$INTEGRATION_BRANCH" || exit $?
  echo "→ Created $SUBTASK_BRANCH from local $INTEGRATION_BRANCH (no origin remote)." >&2
fi
# --- end ADR-0062 branch-base step ---
```

---

## Phase 3 — Engineer plugin minimum-version preflight

```bash
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
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
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
case "$CLAUDE_PLUGIN_ROOT" in
  *"/.codex/"*) DETECTED_HOST="codex" ;;
  *"/.claude/"*) DETECTED_HOST="claude" ;;
  *) DETECTED_HOST="${AGENTIC_HOST:-claude}" ;;
esac
```

Then drive the engineer command's runbook from a single Bash tool call. **Save the orchestrator's plugin root BEFORE rebinding** — Phase 5's `subtask-update` writeback is an orchestrator CLI that MUST be invoked through the orchestrator's `state.mjs`, not engineer's:

```bash
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
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
# the engineer command's argument placeholder is replaced by env vars in
# the dispatched path because the host fills that placeholder from what the
# user typed, not from the caller's environment. (This comment does not
# spell the placeholder: Claude would substitute it here too.)
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

When the Phase 1 approval gate printed its warning line, repeat that line
under the report. A refused dispatch (`✗ plan-unapproved`) reports the gate's
two lines and nothing was dispatched.

ARCHIVE TIMING — in that auto-promoted case the macro is terminal without any
`set-terminal` call of its own: the Phase 5 `subtask-update` auto-terminal pass
sets the marker. On Claude the Stop hook fires at **every turn end**, so the
macro archive gates are **evaluated** at the end of **this** turn, not at session
close, and the file moves then if they all pass. To hold it open, run the full
`state.mjs set-terminal` form (`--workflow-path`, `--host`, `--terminal-phase`
are all required) with `--terminal-marker false` before that Stop fires. On Codex
the Stop hook runs only once the operator has trusted the plugin hooks
(`/hooks`), so the evaluation waits for that. Full contract:
`core/skills/_shared/references/session-handoff.md` § Archive timing.

Then emit an **Active Next-Action Proposal** instead of a fixed next command, per
`core/skills/_shared/references/session-handoff.md § Active Next-Action Proposal`
(canonical: `entry-routing-contract.md § Active Next-Action Proposal` in the
engineer plugin) — the canonical six-field template (runtime
completion-output contract):

```
- selected_next:         <macro action | owner decision>
- rejected_alternatives: <1-2 alternatives, each + one-line why-not>
- rationale:             <why best — 본질/근본 (essence/foundation) + Standards/Root-Cause gate>
- evidence_pointers:     <macro plan / subtask states / phase notes — pointers only>
- confidence:            <HIGH | MEDIUM | LOW>
- next_command:          <exact next step: /orchestrator:<command> … — or the wait / owner-decision action>
```

Derive from the post-dispatch macro state: when more
subtasks are ready, `selected_next` is typically another `/orchestrator:next`
after the current subtask commits; when all subtasks reach terminal status, it is
`/orchestrator:finalize` (or the auto-archive once macro `terminal_marker` is
set); when the dispatched engineer workflow is still in flight, it is waiting on
that subtask's commit. Reason from the state rather than a hardcoded literal.

Append the runtime completion footer after the dispatch summary. Use the
runtime footer helper when available, or render the same fields manually:
context state, completion state plus state-derived next action, workflow
id/path, artifact pointers, recommended next work, and next-session
action/command or prompt pointer. The footer is advisory
and pointer-only; do not mutate host session context or paste raw peer /
consensus output into the main session.

Before rendering the footer, surface the ADR-0031 session-level
continue-vs-fresh preflight per
`core/skills/_shared/references/session-handoff.md`: compute the orchestrator macro
projection (resolved across branches via find-active then find-macro) and pass
it to the runtime footer/check (`--workflow-projection-file`) so the footer
carries the continue-vs-fresh decision. On detached HEAD, report "no active
branch context" — do not auto-recommend a fresh session.
