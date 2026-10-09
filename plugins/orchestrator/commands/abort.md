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

Plugin root: each shell block below opens by setting `$CLAUDE_PLUGIN_ROOT` —
from `AGENTIC_ORCHESTRATOR_ROOT` when that is set, else from the plugin path
Claude Code writes into this command when it loads it, else from the newest
version in the plugin cache. Keep that opening line when you run a block: a
shell variable does not outlive a Bash call. The engineer plugin root is
resolved separately, by `discover-engineer.mjs`.

**Argument parsing**: extract from `$ARGUMENTS`:
- `EXPLICIT_WORKFLOW_ID` ← value of `--workflow=<id>` flag, or empty if absent.

**P1-i defense**: every engineer-side CLI invocation MUST use `$ENGINEER_PLUGIN_ROOT` in `argv[1]` (NOT the rebound `$CLAUDE_PLUGIN_ROOT`).

**Run Phases 0–3 in one Bash invocation.** Each Bash tool call is a fresh shell, so what Phase 0 sets — `ORCH_PLUGIN_ROOT`, `MACRO_PATH`, `MACRO_ID`, `DETECTED_HOST` — does not survive into a later call. Each later block stops with a message when Phase 0 has not run in its shell.

---

## Phase 0 — Resolve the macro plan

```bash
CLAUDE_PLUGIN_ROOT="${AGENTIC_ORCHESTRATOR_ROOT:-${CLAUDE_PLUGIN_ROOT}}"
[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT="$(find ~/.claude/plugins/cache/agentic-plugins/orchestrator -mindepth 1 -maxdepth 1 -type d 2>/dev/null | grep -E '/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(\+[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$' | sort -V | tail -1)"
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

MACRO_PATH=""
if [ -n "${EXPLICIT_WORKFLOW_ID:-}" ]; then
  case "$EXPLICIT_WORKFLOW_ID" in
    # No NUL case: a shell variable cannot hold NUL, and bash expands $'\0'
    # to an empty string, which made the pattern match every id.
    */*|*\\*|..|.*)
      echo "✗ --workflow=$EXPLICIT_WORKFLOW_ID invalid — must be a basename-shaped workflow id." >&2
      exit 1;;
  esac
  # ADR-0067 Decision 4, item 2 — the macro file in the orchestrator workflow
  # homes of this checkout's read set, the default state root's first. Two
  # files holding the id are an error, named on stderr, never a choice.
  if ! MACRO_PATH="$(node "$ORCH_PLUGIN_ROOT/scripts/state.mjs" \
    resolve-workflow --repo-root "$REPO_ROOT" --workflow-id "$EXPLICIT_WORKFLOW_ID")"; then
    echo "✗ --workflow=$EXPLICIT_WORKFLOW_ID names no single macro file in the orchestrator workflow homes of this checkout's read set (the reason is above)." >&2
    exit 1
  fi
else
  # stderr is not redirected: find-active and find-macro write to it only
  # when they fail, so the error is already on screen. `|| { RC=$?; … }`
  # keeps the failing status and holds under `set -e` (Codex P3 finding);
  # an `if ! cmd; then RC=$?` branch reads the negation's status, which is
  # always 0, so that form exited 0 on a failure.
  MACRO_PATH="$(node "$ORCH_PLUGIN_ROOT/scripts/state.mjs" \
      find-active --repo-root "$REPO_ROOT")" || { RC=$?; exit "$RC"; }
  if [ -z "$MACRO_PATH" ]; then
    MACRO_PATH="$(node "$ORCH_PLUGIN_ROOT/scripts/state.mjs" \
        find-macro --repo-root "$REPO_ROOT" --subtask-branch "$GIT_BRANCH")" || { RC=$?; exit "$RC"; }
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
: "${MACRO_PATH:?Phase 0 did not run in this shell — run Phases 0–3 in one Bash invocation}"
# ADR-0067 Decision 4, item 5 — join the macro's run lock before the first
# write: an autopilot run or another session holding it refuses here, naming
# the holder, and nothing is written. The trap releases the admission on every
# exit from here, after Phase 3's last write included.
ADMISSION="$(node "$ORCH_PLUGIN_ROOT/scripts/state.mjs" admission join \
  --macro "$MACRO_ID" --checkout "$REPO_ROOT" --command abort \
  --host "$DETECTED_HOST" --session-id "${CLAUDE_CODE_SESSION_ID:-}")" || exit 1
release_admission() {
  node "$ORCH_PLUGIN_ROOT/scripts/state.mjs" admission release \
    --macro "$MACRO_ID" --checkout "$REPO_ROOT" --admission "$ADMISSION"
}
trap 'release_admission' EXIT
node "$ORCH_PLUGIN_ROOT/scripts/state.mjs" \
  bulk-subtask-status \
  --workflow-path "$MACRO_PATH" \
  --host "$DETECTED_HOST" \
  --from-statuses pending,blocked,in_progress \
  --to-status abandoned || exit $?
```

Parent per-file lock released after this returns.

---

## Phase 2 — Step 2: active-children detach pass (NO parent lock)

Identical to `/orchestrator:finalize` step 2. Engineer children get routed to `stop-archive` (terminal) or `detach-archive` (mid-flight, deleted branch, or gate-not-met).

```bash
: "${MACRO_PATH:?Phase 0 did not run in this shell — run Phases 0–3 in one Bash invocation}"
ENGINEER_PLUGIN_ROOT="$(node "$ORCH_PLUGIN_ROOT/scripts/discover-engineer.mjs" discover)"  # stderr kept: a cross-host fallback is reported there (ADR-0061)
if [ -z "$ENGINEER_PLUGIN_ROOT" ]; then
  echo "✗ engineer plugin not found — cannot detach children." >&2
  exit 1
fi
# lifecycle: only detach-archive / stop-archive are needed here (ADR-0062 §Decision 6).
node "$ORCH_PLUGIN_ROOT/scripts/discover-engineer.mjs" preflight --root "$ENGINEER_PLUGIN_ROOT" --purpose lifecycle || exit 1

# Child-archive failure gate (Codex P2 finding) — same pattern as
# /orchestrator:finalize. The shim exits non-zero when any child failed.
STEP2_RC=0
# ADR-0067 Decision 1(b) — a child may be held by the default state root, this
# checkout, or another worktree's own home: scan the repository-wide set
# scan-roots prints (the read set, then every other worktree), each file once.
# scan-roots fails rather than leave a worktree out, and so does this step.
SCAN_ROOTS="$(node "$ORCH_PLUGIN_ROOT/scripts/state.mjs" scan-roots --repo-root "$REPO_ROOT")" || {
  echo "✗ Could not list the repository's worktrees to scan for children of $MACRO_ID (see the error above); refusing to close the macro over a child left unseen." >&2
  exit 1
}
  env MACRO_ID="$MACRO_ID" REPO_ROOT="$REPO_ROOT" \
    SCAN_ROOTS="$SCAN_ROOTS" \
    ENGINEER_PLUGIN_ROOT="$ENGINEER_PLUGIN_ROOT" \
    DETECTED_HOST="$DETECTED_HOST" \
    node -e '
      const fs = require("fs/promises");
      const path = require("path");
      const { execFile } = require("child_process");
      const { promisify } = require("util");
      const execFileAsync = promisify(execFile);
      const { MACRO_ID, REPO_ROOT, SCAN_ROOTS, ENGINEER_PLUGIN_ROOT, DETECTED_HOST } = process.env;
      const ENG_STATE = path.join(ENGINEER_PLUGIN_ROOT, "scripts/state.mjs");
      let failures = 0;
      (async () => {
        const ID_RE = /^[a-z]+-[0-9]{8}T[0-9]{6}Z-[0-9a-f]+\.md$/;
        const ENG_WORKFLOW_DIRS = JSON.parse(SCAN_ROOTS).flatMap((root) => [
          path.join(root, ".agentic-plugins", "state", "engineer", "workflows"),
          path.join(root, ".claude", "agentic-engineer", "workflows"),
        ]);
        // One file reached through two roots (a linked home) is one child,
        // worked on by its physical path.
        const seen = new Set();
        for (const ENG_WORKFLOW_DIR of ENG_WORKFLOW_DIRS) {
          let entries;
          try { entries = await fs.readdir(ENG_WORKFLOW_DIR); }
          catch (err) { if (err.code === "ENOENT") continue; throw err; }
          for (const name of entries) {
            if (!ID_RE.test(name)) continue;
            let childPath;
            try { childPath = await fs.realpath(path.join(ENG_WORKFLOW_DIR, name)); }
            catch (err) { if (err.code === "ENOENT") continue; throw err; }
            if (seen.has(childPath)) continue;
            seen.add(childPath);
            let text;
            // Only a file gone since the listing is no child: one that cannot
            // be read may belong to this macro, so it counts as a failure.
            try { text = await fs.readFile(childPath, "utf8"); }
            catch (err) {
              if (err.code === "ENOENT") continue;
              process.stderr.write(`  ! cannot read ${childPath}: ${err.code || err.message}\n`);
              failures += 1;
              continue;
            }
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
              // A child of this macro that cannot be read cannot be archived
              // either; counting it keeps step 3 from closing the macro over it.
              process.stderr.write(`  ! failed to read ${name}: ${err.message}\n`);
              failures += 1;
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
        .finally(() => {
          // The tally leaves as the exit status, so the outer shell refuses
          // step 3 on any failure — including a shim that never reached here.
          if (failures > 0) {
            process.stderr.write(`✗ ${failures} engineer child(ren) failed to archive in abort step 2.\n`);
            process.exitCode = 3;
          }
        });
    ' || STEP2_RC=$?

# Codex P2 finding (Phase 6 resolve): refuse to mark macro terminal when
# any child failed to archive — A4 would keep failing forever otherwise.
if [ "$STEP2_RC" -ne 0 ]; then
  echo "✗ Step 2 did not archive every engineer child (exit $STEP2_RC; see above) — refusing to set macro terminal markers." >&2
  echo "  Reconcile manually and re-run /orchestrator:abort." >&2
  exit 1
fi
```

---

## Phase 3 — Step 3: terminal markers (parent lock re-acquired)

```bash
: "${MACRO_PATH:?Phase 0 did not run in this shell — run Phases 0–3 in one Bash invocation}"
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
  --terminal-phase aborted \
  --terminal-marker true \
  --next-action archive || exit $?
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

`/orchestrator:abort` completes when all non-terminal subtasks are `abandoned`, every engineer child workflow is archived (terminal via stop-archive, mid-flight via detach-archive), and the macro carries `terminal_marker: true` + `current_phase: 'aborted'`. The macro workflow file is moved to `archive/` on the next host Stop event — on Claude, the end of this turn.

The runtime completion footer is **code-emitted** on this command's terminal
path (ADR-0039): the `state.mjs set-terminal` write above fires the ADR-0031
macro session-handoff sidecar, which shells out to the runtime `footer.mjs` and
prints the rendered footer — context state, completion state + state-derived
next action, workflow id/path, artifact pointers, recommended next work, and the
continue-vs-fresh session-handoff — on that command's **stderr**. Do **not**
hand-compose a second footer here; surface the one the terminal write already
emitted. The footer is advisory + pointer-only and fail-closed (a missing/too-old
runtime emits nothing, and the SessionStart backstop still re-surfaces the
handoff); it never mutates host session context. An aborted macro normally
projects `archive_gate=ready_to_archive` once every macro gate passes (e.g. all
children archived); the footer reports whatever gate it computes — never archive
from it. This terminal footer renders from the macro's PATH (via
`computeOrchestratorProjectionForPath`), so — unlike the branch-resolved
`/plan`/`/next` preflight — it does not depend on the current branch and emits
even on detached HEAD.
