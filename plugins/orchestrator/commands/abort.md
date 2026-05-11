---
description: Abandon a macro plan with remaining subtasks marked as not-done — ADR-0019 §5 abort ritual
argument-hint: [--workflow=<macro-id>]
---

# Orchestrator · Abort

$ARGUMENTS

Explicitly abandon a macro plan when work cannot continue. Same three-step ritual as `/orchestrator:finalize` (ADR-0019 §5), with two differences:

| Step | Finalize | Abort |
|---|---|---|
| 1 | subtasks → `deferred` | subtasks → `abandoned` |
| 3 | `current_phase: 'finalized'` | `current_phase: 'aborted'` |

The semantic distinction: **deferred** means "could be revisited" (future plan revision may pick these up); **abandoned** means "intentionally not done" (definitive close).

Step 2 (active-children detach pass) is identical to finalize — the engineer parent-writeback's absorbing-precondition treats `deferred` and `abandoned` the same way, so any concurrent engineer Stop hook firing during step 2 skips its writeback regardless of which terminal-partial label step 1 assigned.

Plugin root: `$CLAUDE_PLUGIN_ROOT` is the orchestrator plugin's resolved root. Engineer plugin root resolved separately via `discover-engineer.mjs`.

**Argument parsing**: extract from `$ARGUMENTS`:
- `EXPLICIT_WORKFLOW_ID` ← value of `--workflow=<id>` flag, or empty if absent.

**P1-i defense**: every engineer-side CLI invocation MUST use `$ENGINEER_PLUGIN_ROOT` in `argv[1]` (NOT the rebound `$CLAUDE_PLUGIN_ROOT`).

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

FIND_ERR="${TMPDIR:-/tmp}/orchestrator-abort-find-$$.err"
trap 'rm -f "$FIND_ERR"' EXIT
MACRO_PATH=""
if [ -n "${EXPLICIT_WORKFLOW_ID:-}" ]; then
  case "$EXPLICIT_WORKFLOW_ID" in
    */*|*\\*|..|.*|*$'\0'*)
      echo "✗ --workflow=$EXPLICIT_WORKFLOW_ID invalid — must be a basename-shaped workflow id." >&2
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
  echo "✗ No macro workflow references branch '$GIT_BRANCH'. Use --workflow=<id>." >&2
  exit 1
fi
MACRO_ID="$(basename "$MACRO_PATH" .md)"
echo "→ Aborting macro: $MACRO_ID"
```

---

## Phase 1 — Step 1: bulk subtask status transition (abandoned)

```bash
node "$ORCH_PLUGIN_ROOT/scripts/state.mjs" \
  bulk-subtask-status \
  --workflow-path "$MACRO_PATH" \
  --host claude \
  --from-statuses pending,blocked,in_progress \
  --to-status abandoned
```

Parent per-file lock released after this returns.

---

## Phase 2 — Step 2: active-children detach pass (NO parent lock)

Identical to `/orchestrator:finalize` step 2. Engineer children get routed to `stop-archive` (terminal) or `detach-archive` (mid-flight, deleted branch, or gate-not-met).

```bash
ENGINEER_PLUGIN_ROOT="$(node "$ORCH_PLUGIN_ROOT/scripts/discover-engineer.mjs" discover 2>/dev/null)"
if [ -z "$ENGINEER_PLUGIN_ROOT" ]; then
  echo "✗ engineer plugin not found — cannot detach children." >&2
  exit 1
fi
node "$ORCH_PLUGIN_ROOT/scripts/discover-engineer.mjs" preflight --root "$ENGINEER_PLUGIN_ROOT" || exit 1

ENG_WORKFLOW_DIR="$REPO_ROOT/.claude/agentic-engineer/workflows"
if [ -d "$ENG_WORKFLOW_DIR" ]; then
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
          let text;
          try { text = await fs.readFile(childPath, "utf8"); } catch { continue; }
          const fmM = text.match(/^---\n([\s\S]*?)\n---/);
          if (!fmM) continue;
          const parentM = fmM[1].match(/^parent_workflow:\s*(?:"([^"]+)"|'"'"'([^'"'"']+)'"'"'|(\S+))\s*$/m);
          if (!parentM) continue;
          if ((parentM[1] ?? parentM[2] ?? parentM[3]) !== MACRO_ID) continue;

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
            await detachArchive(childPath); continue;
          }

          let branchHead = "", branchSubject = "";
          try {
            const r = await execFileAsync("git", ["-C", REPO_ROOT, "rev-parse", "--verify", `refs/heads/${branch}`], { encoding: "utf8" });
            branchHead = r.stdout.trim();
            const s = await execFileAsync("git", ["-C", REPO_ROOT, "log", "-1", "--pretty=%s", branchHead], { encoding: "utf8" });
            branchSubject = s.stdout.trim();
          } catch {
            await detachArchive(childPath); continue;
          }

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
          } else {
            process.stdout.write(`  · child ${name} not archivable (${envelope.reason}) → detach-archive\n`);
            await detachArchive(childPath);
          }
        }
        async function detachArchive(childPath) {
          try {
            const r = await execFileAsync(
              process.execPath,
              [ENG_STATE, "detach-archive", "--workflow-path", childPath, "--host", "claude", "--repo-root", REPO_ROOT],
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
      })().catch((err) => { process.stderr.write(`  ! abort step 2 error: ${err.message}\n`); process.exit(1); });
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
  --terminal-phase aborted \
  --terminal-marker true \
  --next-action archive
echo "✓ macro $MACRO_ID marked terminal (current_phase=aborted, terminal_marker=true)."
echo "  Next Stop event will evaluate A1-A4 and auto-archive the macro file."
```

---

## Phase 4 (Codex only) — manual stop helper

```bash
# Codex parity step — uncomment when running on Codex
# node "$ORCH_PLUGIN_ROOT/adapters/codex/hooks/stop.mjs"
```

---

## Summary

`/orchestrator:abort` completes when all non-terminal subtasks are `abandoned`, every engineer child workflow is archived (terminal via stop-archive, mid-flight via detach-archive), and the macro carries `terminal_marker: true` + `current_phase: 'aborted'`. The macro workflow file is moved to `archive/` on the next host Stop event.
