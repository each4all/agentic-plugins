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
3. **Terminal markers (parent lock re-acquired → released)**: set the macro's `terminal_marker: true` + `current_phase: 'finalized'`. The next host Stop event evaluates A1-A4 (all now passing) and auto-archives the macro file.

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
  MACRO_PATH="$REPO_ROOT/.claude/agentic-orchestrator/workflows/${EXPLICIT_WORKFLOW_ID}.md"
  if [ ! -f "$MACRO_PATH" ]; then
    echo "✗ --workflow=$EXPLICIT_WORKFLOW_ID not found at $MACRO_PATH." >&2
    exit 1
  fi
else
  MACRO_PATH="$(node "$ORCH_PLUGIN_ROOT/scripts/state.mjs" \
    find-active --repo-root "$REPO_ROOT" 2>"$FIND_ERR")"
  RC=$?
  if [ "$RC" -ne 0 ]; then
    cat "$FIND_ERR" >&2; exit "$RC"
  fi
  if [ -z "$MACRO_PATH" ]; then
    MACRO_PATH="$(node "$ORCH_PLUGIN_ROOT/scripts/state.mjs" \
      find-macro --repo-root "$REPO_ROOT" --subtask-branch "$GIT_BRANCH" 2>"$FIND_ERR")"
    RC=$?
    if [ "$RC" -ne 0 ]; then
      cat "$FIND_ERR" >&2; exit "$RC"
    fi
  fi
fi
if [ -z "$MACRO_PATH" ]; then
  echo "✗ No macro workflow references branch '$GIT_BRANCH'. Use --workflow=<id> to specify." >&2
  exit 1
fi
MACRO_ID="$(basename "$MACRO_PATH" .md)"
echo "→ Finalizing macro: $MACRO_ID"
```

---

## Phase 1 — Step 1: bulk subtask status transition (deferred)

```bash
node "$ORCH_PLUGIN_ROOT/scripts/state.mjs" \
  bulk-subtask-status \
  --workflow-path "$MACRO_PATH" \
  --host claude \
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

ENG_WORKFLOW_DIR="$REPO_ROOT/.claude/agentic-engineer/workflows"
if [ -d "$ENG_WORKFLOW_DIR" ]; then
  # Enumerate engineer workflow files. For each, read frontmatter via
  # state.mjs read and check parent_workflow. Use a small Node shim to
  # parse the frontmatter robustly (engineer state.mjs read prints JSON).
  env MACRO_ID="$MACRO_ID" REPO_ROOT="$REPO_ROOT" ENG_WORKFLOW_DIR="$ENG_WORKFLOW_DIR" \
    ENGINEER_PLUGIN_ROOT="$ENGINEER_PLUGIN_ROOT" \
    node -e '
      const fs = require("fs/promises");
      const path = require("path");
      const { execFile } = require("child_process");
      const { promisify } = require("util");
      const execFileAsync = promisify(execFile);
      const { MACRO_ID, REPO_ROOT, ENG_WORKFLOW_DIR, ENGINEER_PLUGIN_ROOT } = process.env;
      const ENG_STATE = path.join(ENGINEER_PLUGIN_ROOT, "scripts/state.mjs");
      (async () => {
        let entries;
        try { entries = await fs.readdir(ENG_WORKFLOW_DIR); }
        catch (err) { if (err.code === "ENOENT") return; throw err; }
        const ID_RE = /^[a-z]+-[0-9]{8}T[0-9]{6}Z-[0-9a-f]+\.md$/;
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
                "--host", "claude",
                "--repo-root", REPO_ROOT,
                "--head-sha", branchHead,
                "--head-subject", branchSubject,
              ],
              { encoding: "utf8" },
            );
            envelope = JSON.parse(r.stdout.trim());
          } catch (err) {
            process.stderr.write(`  ! engineer stop-archive failed for ${name}: ${err.message}\n`);
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

        async function detachArchive(childPath) {
          try {
            const r = await execFileAsync(
              process.execPath,
              [
                ENG_STATE, "detach-archive",
                "--workflow-path", childPath,
                "--host", "claude",
                "--repo-root", REPO_ROOT,
              ],
              { encoding: "utf8" },
            );
            const env = JSON.parse(r.stdout.trim());
            if (env.detached) {
              process.stdout.write(`  ✓ mid-flight child detached: ${path.basename(childPath)} → ${env.to}\n`);
            } else {
              process.stderr.write(`  ! detach-archive no-op for ${path.basename(childPath)}: ${env.reason}\n`);
            }
          } catch (err) {
            process.stderr.write(`  ! detach-archive threw for ${path.basename(childPath)}: ${err.message}\n`);
          }
        }
      })().catch((err) => { process.stderr.write(`  ! finalize step 2 error: ${err.message}\n`); process.exit(1); });
    '
fi
```

---

## Phase 3 — Step 3: terminal markers (parent lock re-acquired)

```bash
node "$ORCH_PLUGIN_ROOT/scripts/state.mjs" \
  set-terminal \
  --workflow-path "$MACRO_PATH" \
  --host claude \
  --terminal-phase finalized \
  --terminal-marker true \
  --next-action archive
echo "✓ macro $MACRO_ID marked terminal (current_phase=finalized, terminal_marker=true)."
echo "  Next Stop event will evaluate A1-A4 and auto-archive the macro file."
```

---

## Phase 4 (Codex only) — manual stop helper

When running on Codex (no host Stop event), the auto-archive evaluation must be invoked manually. The Claude side fires its Stop hook automatically.

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

The macro workflow file is moved to `archive/` on the next host Stop event by `runMacroStopArchiveAll`. Re-running `/orchestrator:finalize` after step 3 is a no-op (subtasks already deferred, terminal_marker already set).
