---
description: Manually record subtask completion — idempotent backup for engineer Stop hook auto-writeback (ADR-0019 §4)
argument-hint: <subtask-id> [--commit=<sha>] [--workflow=<macro-id>]
---

# Orchestrator · Done

$ARGUMENTS

Mark a macro subtask as `completed` with its terminal commit SHA. This is the **manual backup path** for ADR-0019 §4 auto-writeback — the engineer Stop hook normally writes the completion back via `parent-writeback.mjs` after `runStopArchive`, so `/orchestrator:done` is only needed when:

- the engineer session crashed before reaching its terminal commit (Stop hook never fired);
- the user wants to explicitly confirm a manual commit landed on the subtask branch;
- a future cross-host dispatch (`--peer`, PR-F scope) bypassed the local host's Stop event.

The orchestrator `subtask-update` CLI enforces single-writer ownership and absorbing-completed semantics — re-running `/done` after auto-writeback is a no-op except for a brief informational diagnostic.

Plugin root: `$CLAUDE_PLUGIN_ROOT` is the orchestrator plugin's resolved root.

**Argument parsing**: extract from `$ARGUMENTS`:
- `EXPLICIT_SUBTASK_ID` ← the leading positional token (required for `/done`).
- `EXPLICIT_COMMIT` ← value of `--commit=<sha>` flag, or empty if absent.
- `EXPLICIT_WORKFLOW_ID` ← value of `--workflow=<id>` flag, or empty if absent.

**Critical rules** (ADR-0019 §4):
- The commit SHA is the **tip of the subtask branch**, NOT `git rev-parse HEAD` — `/done` can be invoked from any branch.
- A completion writeback MUST supply the matching `engineer_workflow_id`. When the subtask's `engineer_workflow_id` is already recorded (the usual case after a previous `/next`), use it; on mismatch the API rejects with single-writer ownership diagnostic.
- `updateSubtask` treats `--status=completed`, `--commit`, `--closed-at` **and `--pr-url`** alike as completion fields: each requires `--engineer-workflow-id`, and `subtask-update` throws without it. `/done` itself never forwards `--pr-url` (it parses only subtask / commit / workflow), so this matters when attaching a PR URL later through a direct `state.mjs subtask-update` call — a metadata-only update that `completed`, absorbing for *status*, still allows.
- The fallback scan (when `engineer_workflow_id` is unset on the subtask) MUST require BOTH `parent_workflow == <macro id>` AND `originating_subtask == <subtask id>`. Single-key scans risk mismatching when two macro plans both label a subtask the same id.

---

## Phase 0 — Resolve the macro plan

```bash
REPO_ROOT="$(git rev-parse --show-toplevel)"
GIT_BRANCH="$(git branch --show-current)"
if [ -z "$GIT_BRANCH" ]; then
  echo "✗ Detached HEAD — orchestrator workflows are branch-anchored. Switch to any tracked branch first." >&2
  exit 1
fi

if [ -z "${EXPLICIT_SUBTASK_ID:-}" ]; then
  echo "✗ /orchestrator:done requires a <subtask-id> argument." >&2
  exit 1
fi

FIND_ERR="${TMPDIR:-/tmp}/orchestrator-done-find-$$.err"
MACRO_PATH=""
if [ -n "${EXPLICIT_WORKFLOW_ID:-}" ]; then
  # Reject path-component overrides — `--workflow=../archive/<id>` would
  # otherwise let the macro path escape `workflows/`.
  case "$EXPLICIT_WORKFLOW_ID" in
    */*|*\\*|..|.*|*$'\0'*)
      echo "✗ --workflow=$EXPLICIT_WORKFLOW_ID invalid — must be a basename-shaped workflow id (no '/', '\\\\', '..', leading '.', or NUL)." >&2
      rm -f "$FIND_ERR"
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
    rm -f "$FIND_ERR"
    exit 1
  fi
else
  MACRO_PATH="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
    find-active --repo-root "$REPO_ROOT" 2>"$FIND_ERR")"
  RC=$?
  if [ "$RC" -ne 0 ]; then
    cat "$FIND_ERR" >&2; rm -f "$FIND_ERR"; exit "$RC"
  fi
  if [ -z "$MACRO_PATH" ]; then
    MACRO_PATH="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
      find-macro --repo-root "$REPO_ROOT" --subtask-branch "$GIT_BRANCH" 2>"$FIND_ERR")"
    RC=$?
    if [ "$RC" -ne 0 ]; then
      cat "$FIND_ERR" >&2; rm -f "$FIND_ERR"; exit "$RC"
    fi
  fi
fi
rm -f "$FIND_ERR"
if [ -z "$MACRO_PATH" ]; then
  echo "✗ No macro workflow references branch '$GIT_BRANCH'. Use --workflow=<id>." >&2
  exit 1
fi
MACRO_ID="$(basename "$MACRO_PATH" .md)"
```

---

## Phase 1 — Read the subtask + resolve engineer_workflow_id

```bash
SUBTASK_JSON="$(node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" \
  read-subtask --workflow-path "$MACRO_PATH" --subtask-id "$EXPLICIT_SUBTASK_ID")" || exit 1

SUBTASK_ID="$EXPLICIT_SUBTASK_ID"
SUBTASK_BRANCH="$(echo "$SUBTASK_JSON" | node -e 'process.stdin.on("data", d => { try { process.stdout.write(JSON.parse(d.toString()).branch || ""); } catch {} })')"
SUBTASK_STATUS="$(echo "$SUBTASK_JSON" | node -e 'process.stdin.on("data", d => { try { process.stdout.write(JSON.parse(d.toString()).status || ""); } catch {} })')"
EXISTING_ENG_WF_ID="$(echo "$SUBTASK_JSON" | node -e 'process.stdin.on("data", d => { try { process.stdout.write(JSON.parse(d.toString()).engineer_workflow_id || ""); } catch {} })')"
EXISTING_COMMIT="$(echo "$SUBTASK_JSON" | node -e 'process.stdin.on("data", d => { try { process.stdout.write(JSON.parse(d.toString()).commit || ""); } catch {} })')"
EXISTING_CLOSED_AT="$(echo "$SUBTASK_JSON" | node -e 'process.stdin.on("data", d => { try { process.stdout.write(JSON.parse(d.toString()).closed_at || ""); } catch {} })')"
```

**No-op check** (ADR-0019 §4 idempotency):

```bash
if [ "$SUBTASK_STATUS" = "completed" ]; then
  echo "✓ Subtask $SUBTASK_ID already completed at $EXISTING_CLOSED_AT with commit $EXISTING_COMMIT. /orchestrator:done is a no-op." >&2
  exit 0
fi
if [ "$SUBTASK_STATUS" = "deferred" ] || [ "$SUBTASK_STATUS" = "abandoned" ]; then
  echo "✗ Subtask $SUBTASK_ID already terminal as $SUBTASK_STATUS — refusing to override. Terminal-partial states are absorbing per ADR-0019 §4 (set by /orchestrator:finalize or /abort)." >&2
  exit 1
fi
```

**Engineer workflow id resolution**:

- If `EXISTING_ENG_WF_ID` is set → use it (the normal path after `/next` recorded it).
- Else → fallback scan engineer's `workflows/` for a file whose frontmatter has `parent_workflow == $MACRO_ID` AND `originating_subtask == $SUBTASK_ID`. **Both** match required (ADR-0019 §4):

```bash
if [ -z "$EXISTING_ENG_WF_ID" ]; then
  ENGINEER_PLUGIN_ROOT="$(node "$CLAUDE_PLUGIN_ROOT/scripts/discover-engineer.mjs" discover 2>/dev/null)"
  if [ -z "$ENGINEER_PLUGIN_ROOT" ]; then
    echo "✗ engineer plugin not found — cannot fallback-scan for engineer_workflow_id. Install engineer or set AGENTIC_ENGINEER_ROOT=<path>." >&2
    exit 1
  fi
  # Use env var passing (not single-quote interpolation) so subtask
  # ids / macro ids containing quotes do not break the shim.
  ACTIVE_PATH="$(
    env MACRO_ID="$MACRO_ID" SUBTASK_ID="$SUBTASK_ID" REPO_ROOT="$REPO_ROOT" \
      node -e '
        const fs = require("fs/promises");
        const path = require("path");
        const { MACRO_ID, SUBTASK_ID, REPO_ROOT } = process.env;
        (async () => {
          const dirs = [
            path.join(REPO_ROOT, ".agentic-plugins", "state", "engineer", "workflows"),
            path.join(REPO_ROOT, ".claude", "agentic-engineer", "workflows"),
          ];
          for (const dir of dirs) {
            let entries = [];
            try { entries = await fs.readdir(dir); } catch { continue; }
            for (const f of entries) {
              if (!f.endsWith(".md")) continue;
              let text;
              try { text = await fs.readFile(path.join(dir, f), "utf8"); } catch { continue; }
              // Match frontmatter quoted-scalar style as orchestrator emits it.
              const parentLine = `parent_workflow: "${MACRO_ID}"`;
              const subtaskLine = `originating_subtask: "${SUBTASK_ID}"`;
              if (text.includes(parentLine) && text.includes(subtaskLine)) {
                process.stdout.write(path.join(dir, f));
                return;
              }
            }
          }
        })();
      '
  )"
  if [ -z "$ACTIVE_PATH" ]; then
    echo "✗ No engineer workflow found with parent_workflow=$MACRO_ID AND originating_subtask=$SUBTASK_ID." >&2
    echo "  This subtask was likely never dispatched via /orchestrator:next — run /orchestrator:next $SUBTASK_ID first." >&2
    echo "  If a manual completion needs reconciling without a child workflow, raise a follow-up ADR for that scenario." >&2
    exit 1
  fi
  EXISTING_ENG_WF_ID="$(basename "$ACTIVE_PATH" .md)"
fi
```

---

## Phase 2 — Resolve commit SHA

```bash
if [ -n "${EXPLICIT_COMMIT:-}" ]; then
  if ! git -C "$REPO_ROOT" cat-file -e "${EXPLICIT_COMMIT}^{commit}" 2>/dev/null; then
    echo "✗ --commit=$EXPLICIT_COMMIT does not resolve to a commit in $REPO_ROOT." >&2
    exit 1
  fi
  # Peel annotated tags to their target commit (Codex P3 finding). Plain
  # `git rev-parse "$EXPLICIT_COMMIT"` would return the tag object SHA
  # when EXPLICIT_COMMIT is an annotated tag — we want the commit SHA.
  COMMIT_SHA="$(git -C "$REPO_ROOT" rev-parse "${EXPLICIT_COMMIT}^{commit}")"
else
  if ! git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$SUBTASK_BRANCH"; then
    echo "✗ subtask branch '$SUBTASK_BRANCH' does not exist in $REPO_ROOT. Pass --commit=<sha> explicitly." >&2
    exit 1
  fi
  # Resolve through `refs/heads/` explicitly (Codex P2 finding): when a
  # tag and the branch share the same shorthand name, `git rev-parse
  # <name>` would prefer the tag per Git's disambiguation rules even
  # though the branch existence check above already passed.
  COMMIT_SHA="$(git -C "$REPO_ROOT" rev-parse "refs/heads/$SUBTASK_BRANCH")"
fi
CLOSED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Host auto-detection (Codex P2) — mirror /orchestrator:next.
case "$CLAUDE_PLUGIN_ROOT" in
  *"/.codex/"*) DETECTED_HOST="codex" ;;
  *"/.claude/"*) DETECTED_HOST="claude" ;;
  *) DETECTED_HOST="${AGENTIC_HOST:-claude}" ;;
esac
```

---

## Phase 3 — Atomic orchestrator subtask-update

```bash
node "$CLAUDE_PLUGIN_ROOT/scripts/state.mjs" subtask-update \
  --workflow-path="$MACRO_PATH" \
  --host="$DETECTED_HOST" \
  --subtask-id="$SUBTASK_ID" \
  --status=completed \
  --engineer-workflow-id="$EXISTING_ENG_WF_ID" \
  --commit="$COMMIT_SHA" \
  --closed-at="$CLOSED_AT" \
  --event=updated
```

PR-C0's `updateSubtask` handles single-writer ownership, absorbing-completed precondition, unblock pass, and auto-terminal pass atomically — surface its JSON envelope back to the user.

---

## Completion

Report one of:

- `✓ Subtask <id> recorded completed. commit=<sha> closed_at=<iso>. Auto-terminal=<true|false>.`
- `✓ Subtask <id> auto-promoted: macro terminal_marker=true.` (terminal close — the code-emitted footer below surfaces the state-derived next action.)
- `✓ /orchestrator:done was a no-op — subtask <id> was already completed at <closed_at> with commit <sha>.`
- `✗ Ownership conflict — engineer_workflow_id mismatch (existing=<X>, supplied=<Y>). Archive the stale engineer workflow or use --workflow=<correct-macro-id> if the wrong macro was selected.`

When subtasks remain (no auto-terminal), `/orchestrator:done` is a
**forward-decision** surface — emit an **Active Next-Action Proposal** instead of
a fixed next command, per
`skills/_shared/references/session-handoff.md § Active Next-Action Proposal`
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

Derive from the post-completion macro state: typically
`/orchestrator:next` when this completion unblocked a subtask, or
`/orchestrator:finalize` when only intentionally-deferred work remains. When this
`/done` instead auto-terminalized the macro (its final subtask), it is a terminal
close: the code-emitted footer below surfaces the state-derived next action and
no hand-authored proposal is added.

The runtime completion footer is **code-emitted** on this command's terminal
path (ADR-0039): when this `/done` lands the macro's FINAL subtask, the
`state.mjs subtask-update` auto-terminal pass fires the ADR-0031 macro
session-handoff sidecar, which shells out to the runtime `footer.mjs` and prints
the rendered footer — context state, completion state + state-derived next
action, workflow id/path, artifact pointers, recommended next work, and the
continue-vs-fresh session-handoff — on this command's **stderr**. Do **not**
hand-compose a second footer in that case; surface the one the terminal write
already emitted. The footer is advisory + pointer-only and fail-closed (a
missing/too-old runtime emits nothing, and the SessionStart backstop still
re-surfaces the handoff); it never mutates host session context. When subtasks
remain (no auto-terminal), the macro stays active and no terminal footer is
emitted; report the completion/no-op summary above.

ARCHIVE TIMING — that auto-terminal promotion sets the macro `terminal_marker`,
and on Claude the Stop hook fires at **every turn end**, so the macro archive
gates are **evaluated** at the end of **this** turn, not at session close. They
often do not all pass here: `/done` is the backup for a child whose own Stop
never fired, and that child usually stays active, so the no-active-children gate
fails and the macro simply stays marked for a later Stop. Where they do pass, the
macro file moves this turn. To hold it open, run the full `state.mjs set-terminal`
form (`--workflow-path`, `--host`, `--terminal-phase` are all required) with
`--terminal-marker false` before that Stop fires — that clears only the marker
and does not reopen the subtask. Once the file has moved, recovery is a fresh
`/orchestrator:plan`; an archived macro is outside `find-active`. On Codex the
Stop hook runs only once the operator has trusted the plugin hooks (`/hooks`), so
the evaluation waits for that.

Independently of the footer, a real completed subtask (not a no-op) typically
leaves an open PR on its branch — surface that PR follow-up to the user if it has
not already been handled. (The `subtask-update` envelope carries `workflowPath`,
`updatedSubtask`, and `autoTerminal`; orchestrator does not compute a PR-readiness
recommendation, so do not gate on one.)
