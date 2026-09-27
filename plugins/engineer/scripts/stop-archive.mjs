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
  branchTip,
  checkedOutBranch,
  descendsFrom,
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

  // Step 5 — parent writeback (ADR-0019 §4, as changed by ADR-0062).
  await noteTerminalOnParent({ frontmatter, commit: headSha, host, repoRoot, stderr });

  return { archived: true, to: archiveResult.to };
}

/**
 * Note an archived workflow's terminal commit on its orchestrator parent, when
 * it has one (ADR-0019 §4, as changed by ADR-0062).
 *
 * Call only after the archive succeeded: engineer-side locks are released by
 * then (archiveWorkflow's withDirectoryLock + withFileLock callbacks both
 * exited), so §6 lock-order (child release → parent acquire) is naturally
 * satisfied. Best-effort: a failure is reported via stderr but does NOT
 * invalidate the archive, and the subtask is completed by /orchestrator:done
 * after the merge either way.
 */
async function noteTerminalOnParent({ frontmatter, commit, host, repoRoot, stderr }) {
  if (typeof frontmatter.parent_workflow !== 'string'
      || typeof frontmatter.originating_subtask !== 'string'
      || typeof frontmatter.workflow_id !== 'string'
      || typeof commit !== 'string'
      || commit.length === 0) {
    return;
  }
  // ADR-0062 §Decision 2 — the writeback notes the terminal commit on the
  // macro; it does not complete the subtask. Phase 7's P10 has usually
  // sent the same note already (its `parent_writeback_at` marker says it
  // tried); calling again is safe because the orchestrator writes nothing
  // when the note is already there, and it covers a crash between P10's
  // marker and its write.
  try {
    await writebackParent({
      repoRoot,
      parentWorkflowId: frontmatter.parent_workflow,
      originatingSubtaskId: frontmatter.originating_subtask,
      engineerWorkflowId: frontmatter.workflow_id,
      commit,
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

/**
 * Branch-agnostic sweep — archive terminal engineer workflows whose branch is
 * not checked out: those whose branch was DELETED (ADR-0031) and those whose
 * branch still exists elsewhere (ADR-0017 sub-decision 5, amended 2026-09-28).
 *
 * Why: the per-branch Stop hook archives only the active workflow on the
 * current branch (`findActiveWorkflow` → `runStopArchive`). A terminal_marker'd
 * workflow whose `git_baseline.branch` is not checked out when a Stop fires —
 * deleted after its merge, or left behind by a switch in the same turn (commit,
 * merge, /orchestrator:done, then /orchestrator:next) — would otherwise stay
 * "active" until someone returned to or deleted its branch, and transitively
 * block an orchestrator macro's A4 `no_active_engineer_children` gate. This
 * sweep is the engineer mirror of orchestrator's branch-agnostic
 * `runMacroStopArchiveAll`.
 *
 * Criterion, per `branchRefState` of the workflow's baseline branch:
 *   - every case requires `terminal_marker === true` AND `current_phase` ∈
 *     TERMINAL_PHASES — the work is done (set-terminal ran);
 *   - the checked-out branch is skipped: the per-branch path owns it, and
 *     snapshots it and fires the handoff backstop first. When git cannot say
 *     which branch is checked out (`checkedOutBranch` → `'unknown'`), every
 *     kept branch is left alone, since any of them could be that one; a
 *     confirmed detached HEAD owns no branch;
 *   - `'present'` (kept, not checked out): the four Stop gates are evaluated
 *     against that branch's own tip (`branchTip`), as a Stop on that branch
 *     would, and the parent note carries that tip. HEAD belongs to another
 *     branch and is never used. Because nobody is on the branch to see it, the
 *     tip must also descend from the baseline (`descendsFrom`): a branch reset
 *     below its baseline or rebased onto unrelated history is left alone. A
 *     gate that fails writes nothing — no snapshot — so a workflow that cannot
 *     pass does not grow on every Stop; a tip that does not resolve to a
 *     commit is left alone;
 *   - `'absent'` (deleted): archived with no head_moved gate (a deleted
 *     branch has no tip to judge; mirror of the macro's branch-gone logic)
 *     and no parent note — a parent-linked one is reported for
 *     reconciliation instead;
 *   - `'unknown'` (probe failure): left alone — a transient git error must
 *     never falsely archive a live workflow.
 *
 * Best-effort and non-throwing per ADR-0011 §4 — a single corrupt/unreadable
 * file is skipped with a warning, never blocking the rest of the sweep or the
 * host Stop lifecycle.
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
  const checkout = checkedOutBranch(repoRoot);
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
    if (checkout.state === 'branch' && branch === checkout.branch) continue; // the per-branch path owns it
    const refState = branchRefState(repoRoot, branch);
    if (refState === 'present') {
      if (checkout.state === 'unknown') continue; // any kept branch could be the checked-out one
      const result = await archiveOnKeptBranch({ workflowPath, frontmatter, branch, host, repoRoot, stderr });
      if (result) results.push(result);
      continue;
    }
    if (refState !== 'absent') continue; // unknown → leave
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

/**
 * Judge a terminal workflow whose branch still exists but is not checked out
 * against that branch's tip, and archive it when every gate passes. Returns
 * `null` when it is left alone (nothing was written).
 */
async function archiveOnKeptBranch({ workflowPath, frontmatter, branch, host, repoRoot, stderr }) {
  const tip = branchTip(repoRoot, branch);
  if (!tip) return null;
  const verdict = evaluateStopArchive({ frontmatter, headSha: tip.sha, headSubject: tip.subject });
  if (!verdict.shouldArchive) return null;
  // Nobody is on this branch to see the archive, so a tip that merely differs
  // from the baseline is not enough: it must have moved forward from it.
  if (!descendsFrom(repoRoot, frontmatter?.git_baseline?.head, tip.sha)) return null;
  for (const w of verdict.warnings) {
    stderr.write(`engineer/stop-archive: warning: ${w}\n`);
  }
  let archiveResult;
  try {
    archiveResult = await archiveWorkflow({ workflowPath, host, repoRoot });
  } catch (err) {
    stderr.write(`engineer/stop-archive: orphan-sweep archive failed for ${workflowPath}: ${err.message}\n`);
    return { workflowPath, archived: false, reason: 'archive-threw' };
  }
  if (archiveResult.archived === true) {
    await noteTerminalOnParent({ frontmatter, commit: tip.sha, host, repoRoot, stderr });
  }
  return {
    workflowPath,
    archived: archiveResult.archived === true,
    to: archiveResult.to,
    reason: archiveResult.reason,
  };
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
