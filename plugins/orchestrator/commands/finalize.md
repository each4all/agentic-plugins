---
description: Terminate a macro plan with remaining subtasks intentionally deferred — ADR-0019 §5 finalize ritual
argument-hint: [--workflow=<macro-id>]
---

# Orchestrator · Finalize

$ARGUMENTS

Explicitly close a macro plan when some subtasks were not completed but are intentionally deferred to a future revision. The §5 finalize ritual is **three-step** with separate parent-lock acquisitions and a child-detach pass in between:

1. **Subtask status transition (parent lock acquired → released)**: every `pending` / `blocked` / `in_progress` subtask atomically transitions to `deferred`. The parent lock must be released BEFORE step 2 — if held during the child-detach pass, a child engineer Stop hook firing concurrently would deadlock on the same parent lock during its writeback (ADR-0019 §6 lock-order).
2. **Active-children detach pass (NO parent lock held)**: scan engineer's `workflows/` for files whose frontmatter has `parent_workflow == <this macro id>`. For each:
   - **Terminal child** (commit landed on its branch): invoke engineer's `stop-archive` CLI with the child's branch HEAD probed via `git rev-parse refs/heads/<baseline_branch>`. If gates pass, engineer archives the child + writes back (writeback sees the subtask as `deferred` from step 1 and skips per the §4 absorbing precondition).
   - **Mid-flight child** (no terminal commit yet, OR engineer's `stop-archive` returned `gate-not-met head_moved` after probe, OR the branch was deleted): invoke engineer's `detach-archive` CLI which atomically writes `parent_detached: true` + `terminal_marker: false` then archives. No parent writeback fires.
3. **Terminal markers (parent lock re-acquired → released)**: set the macro's `terminal_marker: true` + `current_phase: 'finalized'`. The next host Stop event evaluates A1-A4 (all now passing) and auto-archives the macro file — on Claude that is the end of the turn in which step 3 ran, not session close; on Codex it waits until the operator has trusted the plugin hooks (`/hooks`).

Plugin root: `$CLAUDE_PLUGIN_ROOT` is the orchestrator plugin's resolved root. Engineer plugin root resolved separately via `discover-engineer.mjs`.

**Argument parsing**: extract from `$ARGUMENTS`:
- `EXPLICIT_WORKFLOW_ID` ← value of `--workflow=<id>` flag, or empty if absent. When supplied, `/finalize` operates on that macro directly (skipping branch-based auto-resolution); useful when the user is on a subtask branch after `/next`.

**P1-i defense (PR-D Codex review)**: every engineer-side CLI invocation MUST use `$ENGINEER_PLUGIN_ROOT` in `argv[1]` (NOT the rebound `$CLAUDE_PLUGIN_ROOT`). Argv expansion happens before inline env assignment.

---

## Phase 0 — Resolve the macro plan

```bash
set -e
REPO_ROOT="$(git rev-parse --show-toplevel)"
GIT_BRANCH="$(git branch --show-current)"
if [ -z "$GIT_BRANCH" ]; then
  echo "✗ Detached HEAD — orchestrator macros are branch-anchored." >&2
  exit 1
fi

ORCH_PLUGIN_ROOT="$CLAUDE_PLUGIN_ROOT"

# Host auto-detection (Codex P2 finding — same shape as /next, /done).
# `set -e` would normally abort on `case` `*)` matches that depend on
# unset $AGENTIC_HOST; the parameter substitution `${AGENTIC_HOST:-claude}`
# resolves to 'claude' rather than tripping nounset.
case "$CLAUDE_PLUGIN_ROOT" in
  *"/.codex/"*) DETECTED_HOST="codex" ;;
  *"/.claude/"*) DETECTED_HOST="claude" ;;
  *) DETECTED_HOST="${AGENTIC_HOST:-claude}" ;;
esac

FIND_ERR="${TMPDIR:-/tmp}/orchestrator-finalize-find-$$.err"
trap 'rm -f "$FIND_ERR"' EXIT
MACRO_PATH=""
if [ -n "${EXPLICIT_WORKFLOW_ID:-}" ]; then
  # Reject path-component overrides (ADR-0019 §1 path-safety invariant).
  case "$EXPLICIT_WORKFLOW_ID" in
    */*|*\\*|..|.*|*$'\0'*)
      echo "✗ --workflow=$EXPLICIT_WORKFLOW_ID invalid — must be a basename-shaped workflow id (no '/', '\\\\', '..', leading '.', or NUL)." >&2
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
    exit 1
  fi
else
  # Codex P3 finding: `set -e` + `MACRO_PATH="$(...)"` would exit
  # immediately on non-zero, skipping the `RC=$?`/`cat $FIND_ERR` block
  # entirely and the `trap` would scrub the stderr. The `if !` form
  # gates `set -e` so the diagnostic block runs on failure.
  if ! MACRO_PATH="$(node "$ORCH_PLUGIN_ROOT/scripts/state.mjs" \
      find-active --repo-root "$REPO_ROOT" 2>"$FIND_ERR")"; then
    RC=$?
    cat "$FIND_ERR" >&2
    exit "$RC"
  fi
  if [ -z "$MACRO_PATH" ]; then
    if ! MACRO_PATH="$(node "$ORCH_PLUGIN_ROOT/scripts/state.mjs" \
        find-macro --repo-root "$REPO_ROOT" --subtask-branch "$GIT_BRANCH" 2>"$FIND_ERR")"; then
      RC=$?
      cat "$FIND_ERR" >&2
      exit "$RC"
    fi
  fi
fi
if [ -z "$MACRO_PATH" ]; then
  echo "✗ No macro workflow references branch '$GIT_BRANCH'. Use --workflow=<id> to specify." >&2
  exit 1
fi
MACRO_ID="$(basename "$MACRO_PATH" .md)"
echo "→ Finalizing macro: $MACRO_ID (host=$DETECTED_HOST)"
```

---

## Phase 1 — Step 1: bulk subtask status transition (deferred)

```bash
node "$ORCH_PLUGIN_ROOT/scripts/state.mjs" \
  bulk-subtask-status \
  --workflow-path "$MACRO_PATH" \
  --host "$DETECTED_HOST" \
  --from-statuses pending,blocked,in_progress \
  --to-status deferred
```

After this returns, the parent per-file lock is released. The macro now has all non-terminal subtasks marked `deferred`. Any concurrent engineer Stop hook that fires during step 2 will see the deferred status and skip per the §4 absorbing precondition.

---

## Phase 2 — Step 2: active-children detach pass (NO parent lock)

Resolve the engineer plugin root + scan engineer workflows for children referencing this macro id. For each child:

```bash
ENGINEER_PLUGIN_ROOT="$(node "$ORCH_PLUGIN_ROOT/scripts/discover-engineer.mjs" discover 2>/dev/null)"
if [ -z "$ENGINEER_PLUGIN_ROOT" ]; then
  echo "✗ engineer plugin not found — cannot detach children. Install engineer or set AGENTIC_ENGINEER_ROOT=<path>." >&2
  exit 1
fi
node "$ORCH_PLUGIN_ROOT/scripts/discover-engineer.mjs" preflight --root "$ENGINEER_PLUGIN_ROOT" || exit 1

# Child-archive failure counter (Codex P2 finding). The Node shim
# writes the failure tally to this file; on >0 we abort BEFORE step 3
# rather than mark the macro terminal while children are still live.
FAILURES_FILE="${TMPDIR:-/tmp}/orchestrator-finalize-failures-$$.cnt"
trap 'rm -f "$FIND_ERR" "$FAILURES_FILE"' EXIT
CANONICAL_ENG_WORKFLOW_DIR="$REPO_ROOT/.agentic-plugins/state/engineer/workflows"
LEGACY_ENG_WORKFLOW_DIR="$REPO_ROOT/.claude/agentic-engineer/workflows"
if [ -d "$CANONICAL_ENG_WORKFLOW_DIR" ] || [ -d "$LEGACY_ENG_WORKFLOW_DIR" ]; then
  # Enumerate engineer workflow files. For each, read frontmatter via
  # state.mjs read and check parent_workflow. Use a small Node shim to
  # parse the frontmatter robustly (engineer state.mjs read prints JSON).
  env MACRO_ID="$MACRO_ID" REPO_ROOT="$REPO_ROOT" \
    ENG_WORKFLOW_DIRS="$CANONICAL_ENG_WORKFLOW_DIR:$LEGACY_ENG_WORKFLOW_DIR" \
    ENGINEER_PLUGIN_ROOT="$ENGINEER_PLUGIN_ROOT" \
    DETECTED_HOST="$DETECTED_HOST" \
    FAILURES_FILE="$FAILURES_FILE" \
    node -e '
      const fs = require("fs/promises");
      const path = require("path");
      const { execFile } = require("child_process");
      const { promisify } = require("util");
      const execFileAsync = promisify(execFile);
      const { MACRO_ID, REPO_ROOT, ENG_WORKFLOW_DIRS, ENGINEER_PLUGIN_ROOT, DETECTED_HOST, FAILURES_FILE } = process.env;
      const ENG_STATE = path.join(ENGINEER_PLUGIN_ROOT, "scripts/state.mjs");
      let failures = 0;
      (async () => {
        const ID_RE = /^[a-z]+-[0-9]{8}T[0-9]{6}Z-[0-9a-f]+\.md$/;
        for (const ENG_WORKFLOW_DIR of String(ENG_WORKFLOW_DIRS || "").split(path.delimiter).filter(Boolean)) {
          let entries;
          try { entries = await fs.readdir(ENG_WORKFLOW_DIR); }
          catch (err) { if (err.code === "ENOENT") continue; throw err; }
          for (const name of entries) {
            if (!ID_RE.test(name)) continue;
            const childPath = path.join(ENG_WORKFLOW_DIR, name);
          // Quick frontmatter parent_workflow check via regex (no
          // cross-plugin import per ADR-0010 §5).
          let text;
          try { text = await fs.readFile(childPath, "utf8"); } catch { continue; }
          // CRLF tolerance — engineer files written by a Windows tool
          // would carry \r\n; defend so a CRLF-saved child is correctly
          // routed (Phase 5 review).
          const fmM = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
          if (!fmM) continue;
          const parentM = fmM[1].match(/^parent_workflow:\s*(?:"([^"]+)"|'"'"'([^'"'"']+)'"'"'|(\S+))\s*\r?$/m);
          if (!parentM) continue;
          const parentValue = parentM[1] ?? parentM[2] ?? parentM[3];
          if (parentValue !== MACRO_ID) continue;

          // Found a child of this macro. Read full frontmatter for
          // baseline branch via engineer state.mjs read CLI.
          let frontmatter;
          try {
            const { stdout } = await execFileAsync(
              process.execPath,
              [ENG_STATE, "read", "--workflow-path", childPath],
              { encoding: "utf8" },
            );
            frontmatter = JSON.parse(stdout);
          } catch (err) {
            process.stderr.write(`  ! failed to read ${name}: ${err.message}\n`);
            continue;
          }
          const branch = frontmatter?.git_baseline?.branch;
          if (typeof branch !== "string" || branch.length === 0) {
            process.stderr.write(`  ! child ${name} has no git_baseline.branch — falling back to detach-archive\n`);
            await detachArchive(childPath);
            continue;
          }

          // Probe the child branchs HEAD via git rev-parse.
          // A null/empty result (deleted branch) routes to detach-archive
          // per ADR-0019 D-epsilon′ to preserve gate semantics.
          let branchHead = "";
          let branchSubject = "";
          try {
            const r = await execFileAsync(
              "git", ["-C", REPO_ROOT, "rev-parse", "--verify", `refs/heads/${branch}`],
              { encoding: "utf8" },
            );
            branchHead = r.stdout.trim();
            const s = await execFileAsync(
              "git", ["-C", REPO_ROOT, "log", "-1", "--pretty=%s", branchHead],
              { encoding: "utf8" },
            );
            branchSubject = s.stdout.trim();
          } catch {
            // branch deleted or unreachable — treat as mid-flight detach
            process.stderr.write(`  ! child ${name} branch ${branch} unresolved — routing to detach-archive\n`);
            await detachArchive(childPath);
            continue;
          }

          // Terminal-child path: invoke engineer stop-archive with
          // explicit --head-sha so A3 head_moved evaluates against the
          // childs own branch HEAD (cross-branch invocation).
          let envelope;
          try {
            const r = await execFileAsync(
              process.execPath,
              [
                ENG_STATE, "stop-archive",
                "--workflow-path", childPath,
                "--host", DETECTED_HOST,
                "--repo-root", REPO_ROOT,
                "--head-sha", branchHead,
                "--head-subject", branchSubject,
              ],
              { encoding: "utf8" },
            );
            envelope = JSON.parse(r.stdout.trim());
          } catch (err) {
            process.stderr.write(`  ! engineer stop-archive failed for ${name}: ${err.message}\n`);
            failures += 1;
            continue;
          }

          if (envelope.archived) {
            process.stdout.write(`  ✓ terminal child archived: ${name} → ${envelope.to}\n`);
            continue;
          }
          // gate-not-met → if head_moved failed, the child is actually
          // mid-flight (branch never advanced); fallback to detach-archive.
          // Other gate failures (terminal_marker / terminal_phase / no
          // active children) also mean the child is not in a clean
          // archivable state; detach-archive is safe.
          process.stdout.write(`  · child ${name} not archivable (${envelope.reason}: ${(envelope.gateFailures || []).join(",")}) → detach-archive\n`);
          await detachArchive(childPath);
          }
        }

        async function detachArchive(childPath) {
          try {
            const r = await execFileAsync(
              process.execPath,
              [
                ENG_STATE, "detach-archive",
                "--workflow-path", childPath,
                "--host", DETECTED_HOST,
                "--repo-root", REPO_ROOT,
              ],
              { encoding: "utf8" },
            );
            const env = JSON.parse(r.stdout.trim());
            if (env.detached) {
              process.stdout.write(`  ✓ mid-flight child detached: ${path.basename(childPath)} → ${env.to}\n`);
            } else {
              process.stderr.write(`  ! detach-archive no-op for ${path.basename(childPath)}: ${env.reason}\n`);
              failures += 1;
            }
          } catch (err) {
            process.stderr.write(`  ! detach-archive threw for ${path.basename(childPath)}: ${err.message}\n`);
            failures += 1;
          }
        }
      })()
        .catch((err) => { process.stderr.write(`  ! finalize step 2 error: ${err.message}\n`); failures += 1; })
        .finally(async () => {
          // Persist tally so the outer shell can decide whether to abort
          // before step 3 (Codex P2 finding).
          await fs.writeFile(FAILURES_FILE, String(failures));
        });
    '
fi

# Codex P2 finding (Phase 6 resolve): refuse to mark the macro terminal
# while any child failed to archive. The child remains in an engineer
# workflow home, so without this gate the macro's A4 keeps failing on
# every Stop while the command falsely reports the macro as finalized.
# Re-run /orchestrator:finalize after manually reconciling the offending
# child.
if [ -f "$FAILURES_FILE" ]; then
  FINALIZE_FAILURES="$(cat "$FAILURES_FILE")"
  if [ "${FINALIZE_FAILURES:-0}" -gt 0 ]; then
    echo "✗ $FINALIZE_FAILURES engineer child(ren) failed to archive in step 2 — refusing to set macro terminal markers." >&2
    echo "  Reconcile manually (inspect the engineer workflow file(s), fix the underlying issue, re-run /orchestrator:finalize)." >&2
    exit 1
  fi
fi
```

---

## Phase 3 — Step 3: terminal markers (parent lock re-acquired)

```bash
# ARCHIVE TIMING — on Claude the Stop hook fires at EVERY turn end, so the
# macro archive gates are evaluated at the end of THIS turn, not at session
# close; if a gate fails (a subtask still non-terminal, an engineer child
# still active) the macro stays marked and a later Stop re-evaluates it.
# Clearing the marker with `--terminal-marker false` works only before that
# Stop fires, needs set-terminal's full flag set (--workflow-path, --host,
# --terminal-phase), and does not reopen the subtasks /finalize or /abort
# already closed. Once archived the macro is outside find-active, so recovery
# is a fresh /orchestrator:plan. On Codex the Stop hook runs only once the
# operator has trusted the plugin hooks (`/hooks`), so evaluation waits.
node "$ORCH_PLUGIN_ROOT/scripts/state.mjs" \
  set-terminal \
  --workflow-path "$MACRO_PATH" \
  --host "$DETECTED_HOST" \
  --terminal-phase finalized \
  --terminal-marker true \
  --next-action archive
echo "✓ macro $MACRO_ID marked terminal (current_phase=finalized, terminal_marker=true)."
echo "  Next Stop event will evaluate A1-A4 and auto-archive the macro file."
```

---

## Phase 4 (Codex only) — manual stop helper

Codex does declare a Stop hook (`adapters/codex/hooks/hooks.json`), but it runs automatically only once the packaged hook has passed Codex `/hooks` review and trust in the active session. Until then no auto-archive evaluation happens on Codex at all, so invoke it manually with the helper below — and note that the macro therefore stays un-evaluated, and its marker still clearable, across turns rather than for the single turn Claude gives you. The Claude side fires its Stop hook automatically at every turn end.

```bash
# Codex parity step — uncomment when running on Codex
# node "$ORCH_PLUGIN_ROOT/adapters/codex/hooks/stop.mjs"
```

---

## Summary

`/orchestrator:finalize` completes when:

1. All non-terminal subtasks → `deferred` (atomic).
2. Every engineer child workflow with `parent_workflow == <macro id>` is archived (via `stop-archive` on the child's branch HEAD or `detach-archive` for mid-flight).
3. Macro `terminal_marker: true` + `current_phase: 'finalized'`.

The macro workflow file is moved to `archive/` on the next host Stop event by `runMacroStopArchiveAll` — on Claude, the end of this turn. Re-running `/orchestrator:finalize` after step 3 is a no-op (subtasks already deferred, terminal_marker already set).

The runtime completion footer is **code-emitted** on this command's terminal
path (ADR-0039): the `state.mjs set-terminal` write above fires the ADR-0031
macro session-handoff sidecar, which shells out to the runtime `footer.mjs` and
prints the rendered footer — context state, completion state + state-derived
next action, workflow id/path, artifact pointers, recommended next work, and the
continue-vs-fresh session-handoff — on that command's **stderr**. Do **not**
hand-compose a second footer here; surface the one the terminal write already
emitted. The footer is advisory + pointer-only and fail-closed (a missing/too-old
runtime emits nothing, and the SessionStart backstop still re-surfaces the
handoff); it never mutates host session context. A finalized macro normally
projects `archive_gate=ready_to_archive` once every macro gate passes (e.g. all
children archived); the footer reports whatever gate it computes — never archive
from it. This terminal footer renders from the macro's PATH (via
`computeOrchestratorProjectionForPath`), so — unlike the branch-resolved
`/plan`/`/next` preflight — it does not depend on the current branch and emits
even on detached HEAD.
