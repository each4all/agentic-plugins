// plugins/engineer/scripts/stop-archive.mjs
//
// ADR-0017 §sub-decision 5 — Stop hook auto-archive orchestration.
// Host-shared (Claude Stop, trusted Codex Stop, and Codex fallback Stop
// invocations all call this).
//
// Two surfaces:
//   - evaluateStopArchive() — pure; given frontmatter + git probe values,
//     returns a verdict. Unit-testable.
//   - runStopArchive() — composite; reads the workflow, runs the
//     evaluation, performs snapshot + archive side effects, emits the
//     conventional-commit warning when applicable. Hook absence is
//     non-fatal: every error path returns `{archived: false, reason: ...}`
//     instead of throwing past the caller.
//
// The four hard gates (terminal_marker, terminal phase whitelist,
// HEAD-moved, no active children) are AND-combined. The conventional
// commit subject is a soft gate — failing it produces a stderr warning
// but does NOT block the archive (ADR-0017 §sub-5: "still allow archive
// but emit a warning to stderr").

import {
  archiveWorkflow,
  branchRefState,
  listWorkflowFilesAllHomes,
  noActiveChildrenCheck,
  parseWorkflowFile,
  snapshot,
  terminalMarkerCheck,
  terminalPhaseCheck,
} from './state.mjs';
import { writebackParent } from './parent-writeback.mjs';
import { CONVENTIONAL_COMMIT_RE } from './validate-commit.mjs';
import { readFile } from 'node:fs/promises';

/**
 * Evaluate the four hard gates + the conventional-commit warning gate.
 * Pure: takes everything as input, returns a verdict object.
 *
 * @param {object}  args
 * @param {object}  args.frontmatter  — parsed workflow frontmatter
 * @param {?string} args.headSha      — current `git rev-parse HEAD` (null on probe failure)
 * @param {?string} args.headSubject  — current HEAD commit subject (null on probe failure)
 * @returns {{
 *   shouldArchive: boolean,
 *   gateFailures: string[],
 *   warnings: string[],
 * }}
 */
export function evaluateStopArchive({ frontmatter, headSha, headSubject }) {
  const gateFailures = [];
  const warnings = [];

  // Gate 1 — terminal_marker REQUIRED (false-positive defense).
  if (!terminalMarkerCheck(frontmatter)) {
    gateFailures.push('terminal_marker');
  }

  // Gate 2 — terminal phase whitelist.
  if (!terminalPhaseCheck(frontmatter?.current_phase)) {
    gateFailures.push('terminal_phase');
  }

  // Gate 3 — HEAD-moved verification. Probe failure (null) is treated
  // as "did not move" so a missing git binary cannot accidentally
  // archive a workflow.
  const baselineHead = frontmatter?.git_baseline?.head;
  if (
    !headSha ||
    !baselineHead ||
    typeof baselineHead !== 'string' ||
    headSha === baselineHead
  ) {
    gateFailures.push('head_moved');
  }

  // Gate 4 — no active children (omcc-dev A4 transitive).
  if (!noActiveChildrenCheck(frontmatter)) {
    gateFailures.push('no_active_children');
  }

  // Soft gate — Conventional commit subject. Always evaluated, never
  // adds to gateFailures.
  if (headSubject && !isConventionalCommitSubjectInline(headSubject)) {
    warnings.push(
      `conventional_commit:non_conventional_subject:${truncate(headSubject, 80)}`,
    );
  }

  return {
    shouldArchive: gateFailures.length === 0,
    gateFailures,
    warnings,
  };
}

/**
 * Read the workflow file, snapshot it, evaluate the gates, archive on
 * pass. Emits warnings to `stderr` argument (or process.stderr by
 * default) so callers can capture for tests.
 *
 * @param {object}   args
 * @param {string}   args.workflowPath
 * @param {string}   args.host                 — 'claude' | 'codex'
 * @param {string}   args.repoRoot
 * @param {string}   [args.statusDigest]
 * @param {?string}  [args.headSha]
 * @param {?string}  [args.headSubject]
 * @param {NodeJS.WriteStream} [args.stderr]
 * @returns {Promise<{archived: boolean, reason?: string, gateFailures?: string[], to?: string}>}
 */
export async function runStopArchive({
  workflowPath,
  host,
  repoRoot,
  statusDigest = '',
  headSha = null,
  headSubject = null,
  stderr = process.stderr,
}) {
  // Step 1 — snapshot. Mirrors the legacy stop.mjs behaviour so the
  // last_snapshot + host_history record is written even if the gates
  // do not pass.
  try {
    await snapshot({
      workflowPath,
      host,
      trigger: 'stop',
      statusDigest,
    });
  } catch (err) {
    stderr.write(`engineer/stop-archive: snapshot failed: ${err.message}\n`);
    // Continue — snapshot failure should not block archive evaluation,
    // since archive runs under its own lock and reads bytes fresh.
  }

  // Step 2 — read frontmatter. Re-read the file post-snapshot so the
  // gates see the same on-disk state archive will operate on.
  let frontmatter;
  try {
    const text = await readFile(workflowPath, 'utf8');
    ({ frontmatter } = parseWorkflowFile(text));
  } catch (err) {
    stderr.write(
      `engineer/stop-archive: failed to read ${workflowPath}: ${err.message}\n`,
    );
    return { archived: false, reason: 'read-failed' };
  }

  // Step 3 — evaluate gates.
  const verdict = evaluateStopArchive({ frontmatter, headSha, headSubject });

  for (const w of verdict.warnings) {
    stderr.write(`engineer/stop-archive: warning: ${w}\n`);
  }

  if (!verdict.shouldArchive) {
    return {
      archived: false,
      reason: 'gate-not-met',
      gateFailures: verdict.gateFailures,
    };
  }

  // Step 4 — archive. Failure here is logged but does not throw past
  // the caller — host stop lifecycle must not be blocked.
  let archiveResult;
  try {
    archiveResult = await archiveWorkflow({
      workflowPath,
      host,
      repoRoot,
    });
    if (!archiveResult.archived) {
      return {
        archived: false,
        reason: archiveResult.reason ?? 'archive-no-op',
      };
    }
  } catch (err) {
    stderr.write(`engineer/stop-archive: archive failed: ${err.message}\n`);
    return { archived: false, reason: 'archive-threw' };
  }

  // Step 5 — ADR-0019 §4 parent writeback. Engineer-side locks are
  // already released here (archiveWorkflow's withDirectoryLock +
  // withFileLock callbacks both exited before this point), so §6
  // lock-order (child release → parent acquire) is naturally satisfied.
  // The writeback is best-effort: any failure is reported via stderr
  // but does NOT invalidate the archive that already succeeded —
  // manual reconciliation is available through /orchestrator:done
  // (ADR-0019 §4 backup path, PR-D scope).
  if (typeof frontmatter.parent_workflow === 'string'
      && typeof frontmatter.originating_subtask === 'string'
      && typeof frontmatter.workflow_id === 'string'
      && typeof headSha === 'string'
      && headSha.length > 0) {
    // ADR-0028 §P10 (PR3 M3) — write-ahead marker is an INFORMATIONAL
    // signal, not a hard skip. PR3 Codex peer review M3-race: if Phase 7
    // crashed BETWEEN marker set and writeback completion, an
    // unconditional skip here would orphan the subtask. The
    // subtask-update CLI's `if_match` ownership check is the actual
    // correctness backstop (idempotent: already-completed → no-op,
    // still-open → completes). We log the marker for observability but
    // always call writebackParent — the cost is one redundant CLI spawn
    // on the happy path, the benefit is closing the crash-window orphan.
    if (typeof frontmatter.parent_writeback_at === 'string'
        && frontmatter.parent_writeback_at.length > 0) {
      stderr.write(
        `engineer/stop-archive: parent_writeback_at marker present ` +
        `(${frontmatter.parent_writeback_at}); proceeding with deferred ` +
        `writeback anyway (subtask-update if_match is idempotent — ` +
        `already-completed becomes a no-op).\n`,
      );
    }
    const closedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    try {
      await writebackParent({
        repoRoot,
        parentWorkflowId: frontmatter.parent_workflow,
        originatingSubtaskId: frontmatter.originating_subtask,
        engineerWorkflowId: frontmatter.workflow_id,
        commit: headSha,
        closedAt,
        host,
        stderr,
      });
    } catch (err) {
      // writebackParent itself never throws past its contract, but
      // defend against unexpected programmer errors (e.g., bad arg
      // shape) so the stop lifecycle still completes cleanly. Surface
      // the parent/subtask ids so the user has the concrete handles
      // needed for manual reconciliation via /orchestrator:done.
      stderr.write(
        `engineer/stop-archive: parent-writeback threw unexpectedly for ` +
        `parent=${frontmatter.parent_workflow} subtask=${frontmatter.originating_subtask}: ` +
        `${err.message}\n`,
      );
    }
  }

  return { archived: true, to: archiveResult.to };
}

/**
 * ADR-0031 branch-agnostic orphan sweep — archive terminal engineer workflows
 * whose baseline branch was DELETED.
 *
 * Why: the per-branch Stop hook archives only the active workflow on the
 * current branch (`findActiveWorkflow` → `runStopArchive`). A terminal_marker'd
 * workflow whose `git_baseline.branch` was deleted (the common case after a
 * subtask feature branch merges and is pruned) can NEVER be re-found by branch,
 * so it leaks as a permanently-"active" workflow — and transitively blocks an
 * orchestrator macro's A4 `no_active_engineer_children` gate. This sweep is the
 * engineer mirror of orchestrator's branch-agnostic `runMacroStopArchiveAll`.
 *
 * Orphan criterion (intentionally narrow + safe):
 *   1. `terminal_marker === true` AND `current_phase` ∈ TERMINAL_PHASES — the
 *      work is done (set-terminal ran).
 *   2. the baseline branch is CONFIRMED absent (`branchRefState === 'absent'`).
 *      A still-present branch is left alone (it archives normally via
 *      `runStopArchive`'s head_moved gate when the user is next on it, so the
 *      per-branch single-active "switch-back to resume" semantics are
 *      preserved). A probe failure (`'unknown'`) is also left alone — a
 *      transient git error must never falsely archive a live workflow.
 *
 * HEAD-independent: a deleted branch's baseline HEAD is meaningless, so there is
 * no head_moved gate here (mirror of the macro's branch-gone logic). Best-effort
 * and non-throwing per ADR-0011 §4 — a single corrupt/unreadable file is skipped
 * with a warning, never blocking the rest of the sweep or the host Stop
 * lifecycle.
 *
 * @returns {Promise<Array<{workflowPath: string, archived: boolean, to?: string, reason?: string}>>}
 *   one entry per workflow the sweep acted on (archived or attempted).
 */
export async function runStopArchiveOrphanSweep({ repoRoot, host, stderr = process.stderr }) {
  let files;
  try {
    files = await listWorkflowFilesAllHomes(repoRoot);
  } catch (err) {
    stderr.write(`engineer/stop-archive: orphan-sweep list failed: ${err.message}\n`);
    return [];
  }
  const results = [];
  for (const workflowPath of files) {
    let frontmatter;
    try {
      const text = await readFile(workflowPath, 'utf8');
      ({ frontmatter } = parseWorkflowFile(text));
    } catch (err) {
      // Corrupt/unreadable workflow — skip (fail-open, ADR-0011 §4). One bad
      // file must not block sweeping the rest.
      stderr.write(`engineer/stop-archive: orphan-sweep skip ${workflowPath}: ${err.message}\n`);
      continue;
    }
    if (!terminalMarkerCheck(frontmatter)) continue;
    if (!terminalPhaseCheck(frontmatter?.current_phase)) continue;
    const branch = frontmatter?.git_baseline?.branch;
    if (typeof branch !== 'string' || branch.length === 0) continue;
    if (branchRefState(repoRoot, branch) !== 'absent') continue; // present | unknown → leave
    // Parent-linked orphan: archiving it is exactly the cleanup the macro's A4
    // (no_active_engineer_children) gate waits for — A4 wants the children
    // ARCHIVED, and a branch-deleted child can never archive via the branch-keyed
    // hook. The macro stays guarded against false completion by A3
    // (all_subtasks_terminal): an unreconciled subtask keeps the macro live even
    // after A4 clears. The deferred parent writeback cannot be replayed here (a
    // deleted branch has no recoverable terminal commit and writebackParent
    // requires one), so surface the rare "committed but writeback missed" case
    // for manual reconciliation rather than silently dropping it. (Codex review P1.)
    if (typeof frontmatter.parent_workflow === 'string' && frontmatter.parent_workflow.length > 0) {
      stderr.write(
        `engineer/stop-archive: archiving parent-linked orphan ${workflowPath} ` +
        `(parent=${frontmatter.parent_workflow}, subtask=${frontmatter.originating_subtask ?? '?'}); ` +
        `if its work landed, confirm the macro subtask is completed via ` +
        `/orchestrator:done — the macro's all_subtasks_terminal gate keeps it live until then.\n`,
      );
    }
    try {
      const archiveResult = await archiveWorkflow({ workflowPath, host, repoRoot });
      results.push({
        workflowPath,
        archived: archiveResult.archived === true,
        to: archiveResult.to,
        reason: archiveResult.reason,
      });
    } catch (err) {
      stderr.write(`engineer/stop-archive: orphan-sweep archive failed for ${workflowPath}: ${err.message}\n`);
      results.push({ workflowPath, archived: false, reason: 'archive-threw' });
    }
  }
  return results;
}

function isConventionalCommitSubjectInline(subject) {
  if (typeof subject !== 'string' || subject.length === 0) return false;
  return CONVENTIONAL_COMMIT_RE.test(subject);
}

function truncate(text, max) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
