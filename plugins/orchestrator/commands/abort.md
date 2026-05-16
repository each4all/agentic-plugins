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

# Host auto-detection (Codex P2 finding — mirror /next, /done, /finalize).
case "$CLAUDE_PLUGIN_ROOT" in
  *"/.codex/"*) DETECTED_HOST="codex" ;;
  *"/.claude/"*) DETECTED_HOST="claude" ;;
  *) DETECTED_HOST="${AGENTIC_HOST:-claude}" ;;
esac

FIND_ERR="${TMPDIR:-/tmp}/orchestrator-abort-find-$$.err"
trap 'rm -f "$FIND_ERR"' EXIT
MACRO_PATH=""
if [ -n "${EXPLICIT_WORKFLOW_ID:-}" ]; then
  case "$EXPLICIT_WORKFLOW_ID" in
    */*|*\\*|..|.*|*$'\0'*)
      echo "✗ --workflow=$EXPLICIT_WORKFLOW_ID invalid — must be a basename-shaped workflow id." >&2
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
  # immediately on non-zero, skipping the `RC=$?`/`cat $FIND_ERR` block.
  # `if !` gates `set -e` so the diagnostic block runs on failure.
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
  echo "✗ No macro workflow references branch '$GIT_BRANCH'. Use --workflow=<id>." >&2
  exit 1
fi
MACRO_ID="$(basename "$MACRO_PATH" .md)"
echo "→ Aborting macro: $MACRO_ID (host=$DETECTED_HOST)"
```

---

## Phase 1 — Step 1: bulk subtask status transition (abandoned)

```bash
node "$ORCH_PLUGIN_ROOT/scripts/state.mjs" \
  bulk-subtask-status \
  --workflow-path "$MACRO_PATH" \
  --host "$DETECTED_HOST" \
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

# Child-archive failure counter (Codex P2 finding) — same pattern as
# /orchestrator:finalize.
FAILURES_FILE="${TMPDIR:-/tmp}/orchestrator-abort-failures-$$.cnt"
trap 'rm -f "$FIND_ERR" "$FAILURES_FILE"' EXIT
CANONICAL_ENG_WORKFLOW_DIR="$REPO_ROOT/.agentic-plugins/state/engineer/workflows"
LEGACY_ENG_WORKFLOW_DIR="$REPO_ROOT/.claude/agentic-engineer/workflows"
if [ -d "$CANONICAL_ENG_WORKFLOW_DIR" ] || [ -d "$LEGACY_ENG_WORKFLOW_DIR" ]; then
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
            let text;
            try { text = await fs.readFile(childPath, "utf8"); } catch { continue; }
            // CRLF tolerance — engineer files written by a Windows tool
            // would carry \r\n; defend so a CRLF-saved child is correctly
            // routed (Phase 5 review).
            const fmM = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
            if (!fmM) continue;
            const parentM = fmM[1].match(/^parent_workflow:\s*(?:"([^"]+)"|'"'"'([^'"'"']+)'"'"'|(\S+))\s*\r?$/m);
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
            } else {
              process.stdout.write(`  · child ${name} not archivable (${envelope.reason}) → detach-archive\n`);
              await detachArchive(childPath);
            }
          }
        }
        async function detachArchive(childPath) {
          try {
            const r = await execFileAsync(
              process.execPath,
              [ENG_STATE, "detach-archive", "--workflow-path", childPath, "--host", DETECTED_HOST, "--repo-root", REPO_ROOT],
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
        .catch((err) => { process.stderr.write(`  ! abort step 2 error: ${err.message}\n`); failures += 1; })
        .finally(async () => { await fs.writeFile(FAILURES_FILE, String(failures)); });
    '
fi

# Codex P2 finding (Phase 6 resolve): refuse to mark macro terminal when
# any child failed to archive — A4 would keep failing forever otherwise.
if [ -f "$FAILURES_FILE" ]; then
  ABORT_FAILURES="$(cat "$FAILURES_FILE")"
  if [ "${ABORT_FAILURES:-0}" -gt 0 ]; then
    echo "✗ $ABORT_FAILURES engineer child(ren) failed to archive in step 2 — refusing to set macro terminal markers." >&2
    echo "  Reconcile manually and re-run /orchestrator:abort." >&2
    exit 1
  fi
fi
```

---

## Phase 3 — Step 3: terminal markers (parent lock re-acquired)

```bash
node "$ORCH_PLUGIN_ROOT/scripts/state.mjs" \
  set-terminal \
  --workflow-path "$MACRO_PATH" \
  --host "$DETECTED_HOST" \
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

Append the runtime completion footer after the abort summary. Use the
runtime footer helper when available, or render the same fields manually:
context state, completion state plus state-derived next action, workflow
id/path, artifact pointers, recommended next work, and next-session
action/command or prompt pointer. The footer is advisory
and pointer-only; do not mutate host session context or paste raw peer /
consensus output into the main session.
