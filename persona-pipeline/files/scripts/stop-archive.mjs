// scripts/stop-archive.mjs
//
// ADR-0017 §sub-decision 5 — Stop hook auto-archive orchestration, one copy
// for every persona that enrolls it (generated from persona-pipeline/,
// ADR-0066). dispatch_target (ADR-0066 Decision 3) decides the parent step:
// on, an archived workflow's terminal commit is noted on its orchestrator
// parent (ADR-0019 §4 as changed by ADR-0062), the dispatch_target module
// parent-writeback.mjs imported only then; off, there is no parent step and
// the parent-linkage keys stay opaque data.
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
// The five hard gates (terminal_marker, terminal phase whitelist,
// HEAD-moved, no active children, no pending owner gate) are AND-combined. The conventional
// commit subject is a soft gate — failing it produces a stderr warning
// but does NOT block the archive (ADR-0017 §sub-5: "still allow archive
// but emit a warning to stderr").
//
// Every path evaluates the gates twice: on its own read, to decide, and again
// on the bytes archiveWorkflow reads under the workflow's file lock (its
// `recheck`), so a gate written in between — an owner gate above all — keeps
// the workflow live (PC2b review).

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
import { CONVENTIONAL_COMMIT_RE } from './validate-commit.mjs';
import { capabilityOn, personaName } from './lib/persona.mjs';
import { readFrontmatterText, runInCommandDirectory, worktreeBranches } from './lib/state-root.mjs';
import { readFile } from 'node:fs/promises';

/**
 * Evaluate the five hard gates + the conventional-commit warning gate.
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

  // Gate 4 — no active children (transitive: a workflow with active
  // child workflows is not archivable).
  if (!noActiveChildrenCheck(frontmatter)) {
    gateFailures.push('no_active_children');
  }

  // Gate 5 (ADR-0063 D6, ADR-0066 PC2b) — no owner gate pending. A workflow
  // waiting on its owner is not done, whatever its marker says; archiving it
  // would bury the gate where no resolving surface looks.
  if (frontmatter?.awaiting_owner_gate !== undefined) {
    gateFailures.push('awaiting_owner');
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
 * @param {Function} [args.archive]            — archiveWorkflow; a test passes a
 *   wrapper to write between the gates' read and the archive's lock
 * @returns {Promise<{archived: boolean, reason?: string, gateFailures?: string[], to?: string}>}
 */
// ADR-0067 Decision 1(a) — the writes act in the checkout `repoRoot` names,
// whatever the process's working directory (a hook acts on its payload's).
export async function runStopArchive(args) {
  return args?.repoRoot ? runInCommandDirectory(args.repoRoot, () => runStopArchiveInCheckout(args)) : runStopArchiveInCheckout(args);
}

async function runStopArchiveInCheckout({
  workflowPath,
  host,
  repoRoot,
  statusDigest = '',
  headSha = null,
  headSubject = null,
  stderr = process.stderr,
  archive = archiveWorkflow,
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
    stderr.write(`${personaName()}/stop-archive: snapshot failed: ${err.message}\n`);
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
      `${personaName()}/stop-archive: failed to read ${workflowPath}: ${err.message}\n`,
    );
    return { archived: false, reason: 'read-failed' };
  }

  // Step 3 — evaluate gates.
  const verdict = evaluateStopArchive({ frontmatter, headSha, headSubject });

  for (const w of verdict.warnings) {
    stderr.write(`${personaName()}/stop-archive: warning: ${w}\n`);
  }

  if (!verdict.shouldArchive) {
    return {
      archived: false,
      reason: 'gate-not-met',
      gateFailures: verdict.gateFailures,
    };
  }

  // Step 4 — archive, the gates re-evaluated on the locked read. Failure here
  // is logged but does not throw past the caller — host stop lifecycle must
  // not be blocked.
  let archiveResult;
  try {
    archiveResult = await archive({
      workflowPath,
      host,
      repoRoot,
      recheck: (locked) => evaluateStopArchive({ frontmatter: locked, headSha, headSubject }).gateFailures,
    });
    if (!archiveResult.archived) {
      return {
        archived: false,
        reason: archiveResult.reason ?? 'archive-no-op',
        ...(archiveResult.gateFailures ? { gateFailures: archiveResult.gateFailures } : {}),
      };
    }
  } catch (err) {
    stderr.write(`${personaName()}/stop-archive: archive failed: ${err.message}\n`);
    return { archived: false, reason: 'archive-threw' };
  }

  // Step 5 — parent writeback (ADR-0019 §4, as changed by ADR-0062), only
  // with dispatch_target on. Off, the archive completes the stop lifecycle
  // with no cross-plugin side effect: the persona is no dispatch target
  // (ADR-0066 Decision 3).
  if (capabilityOn('dispatch_target')) {
    await noteTerminalOnParent({ frontmatter, commit: headSha, host, repoRoot, stderr });
  }

  return { archived: true, to: archiveResult.to };
}

/**
 * Note an archived workflow's terminal commit on its orchestrator parent, when
 * it has one (ADR-0019 §4, as changed by ADR-0062). dispatch_target only: the
 * caller checks the capability, and parent-writeback.mjs is imported here, so
 * a persona without the module never reaches it.
 *
 * Call only after the archive succeeded: the workflow's locks are released by
 * then (archiveWorkflow's withDirectoryLock + withFileLock callbacks both
 * exited), so §6 lock-order (child release → parent acquire) is naturally
 * satisfied. Best-effort: a failure is reported via stderr but does NOT
 * invalidate the archive, and the subtask is completed by /orchestrator:done
 * after the merge either way.
 */
async function noteTerminalOnParent({ frontmatter, commit, host, repoRoot, stderr }) {
  // ADR-0063 — a no-changes close made no commit: HEAD is not its commit, and
  // /orchestrator:done --no-commit records it instead.
  if (frontmatter.current_phase === 'close-complete') return;
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
    const { writebackParent, dispatchExpectation } = await import('./parent-writeback.mjs');
    await writebackParent({
      repoRoot,
      parentWorkflowId: frontmatter.parent_workflow,
      // ADR-0067 Decision 3 — tried first; absent on an older child.
      parentWorkflowPath: frontmatter.parent_workflow_path,
      originatingSubtaskId: frontmatter.originating_subtask,
      engineerWorkflowId: frontmatter.workflow_id,
      commit,
      host,
      // ADR-0067 Decision 4, item 5 — the subtask is bound to this workflow
      // only while it is the one it was dispatched for.
      expectDispatch: dispatchExpectation(frontmatter),
      stderr,
    });
  } catch (err) {
    // writebackParent itself never throws past its contract, but defend
    // against unexpected programmer errors (e.g., bad arg shape) so the stop
    // lifecycle still completes cleanly. Surface the parent/subtask ids so the
    // user has the concrete handles for manual reconciliation via
    // /orchestrator:done.
    stderr.write(
      `${personaName()}/stop-archive: parent-writeback threw unexpectedly for ` +
      `parent=${frontmatter.parent_workflow} subtask=${frontmatter.originating_subtask}: ` +
      `${err.message}\n`,
    );
  }
}

/**
 * Branch-agnostic sweep — archive terminal workflows of this persona whose branch is
 * not checked out: those whose branch was DELETED (ADR-0031) and those whose
 * branch still exists elsewhere (ADR-0017 sub-decision 5, amended 2026-09-28).
 *
 * Why: the per-branch Stop hook archives only the active workflow on the
 * current branch (`findActiveWorkflow` → `runStopArchive`). A terminal_marker'd
 * workflow whose `git_baseline.branch` is not checked out when a Stop fires —
 * deleted after its merge, or left behind by a switch in the same turn — would
 * otherwise stay "active" until someone returned to or deleted its branch.
 * For a dispatch_target persona it also keeps an orchestrator macro's A4
 * (no_active_engineer_children) gate from waiting on a child nobody archives;
 * it mirrors orchestrator's branch-agnostic `runMacroStopArchiveAll`.
 *
 * Criterion, per `branchRefState` of the workflow's baseline branch:
 *   - every case requires `terminal_marker === true` AND `current_phase` ∈
 *     TERMINAL_PHASES — the work is done (set-terminal ran) — and no owner
 *     gate pending (ADR-0063 D6);
 *   - the checked-out branch is skipped: the per-branch path owns it, and
 *     snapshots it and fires the handoff backstop first. When git cannot say
 *     which branch is checked out (`checkedOutBranch` → `'unknown'`), every
 *     kept branch is left alone, since any of them could be that one; a
 *     confirmed detached HEAD owns no branch;
 *   - `'present'` (kept, not checked out): the Stop gates are evaluated
 *     against that branch's own tip (`branchTip`), as a Stop on that branch
 *     would. HEAD belongs to another branch and is never used. Because nobody
 *     is on the branch to see it, the tip must also descend from the baseline
 *     (`descendsFrom`): a branch reset below its baseline or rebased onto
 *     unrelated history is left alone. A gate that fails writes nothing — no
 *     snapshot — so a workflow that cannot pass does not grow on every Stop;
 *     a tip that does not resolve to a commit is left alone;
 *   - `'absent'` (deleted): archived with no head_moved gate (a deleted
 *     branch has no tip to judge; mirror of the macro's branch-gone logic);
 *   - `'unknown'` (probe failure): left alone — a transient git error must
 *     never falsely archive a live workflow.
 *
 * Best-effort and non-throwing per ADR-0011 §4 — a single corrupt/unreadable
 * file is skipped with a warning, never blocking the rest of the sweep or the
 * host Stop lifecycle.
 *
 * @returns {Promise<Array<{workflowPath: string, archived: boolean, to?: string, reason?: string, gateFailures?: string[]}>>}
 *   one entry per workflow the sweep acted on (archived or attempted).
 */
// ADR-0067 Decision 1(a) — the writes act in the checkout `repoRoot` names,
// whatever the process's working directory (a hook acts on its payload's).
export async function runStopArchiveOrphanSweep(args) {
  return args?.repoRoot ? runInCommandDirectory(args.repoRoot, () => runStopArchiveOrphanSweepInCheckout(args)) : runStopArchiveOrphanSweepInCheckout(args);
}

async function runStopArchiveOrphanSweepInCheckout({ repoRoot, host, stderr = process.stderr, archive = archiveWorkflow }) {
  let files;
  try {
    files = await listWorkflowFilesAllHomes(repoRoot);
  } catch (err) {
    stderr.write(`${personaName()}/stop-archive: orphan-sweep list failed: ${err.message}\n`);
    return [];
  }
  const checkout = checkedOutBranch(repoRoot);
  // ADR-0067 Decision 1(b): the list now spans the read set, so a branch
  // checked out in ANY worktree is left to that worktree's own Stop, the only
  // one that sees its working tree. When git cannot list the worktrees, every
  // kept branch is left alone, as when this checkout's branch is unknown.
  const elsewhere = worktreeBranches(repoRoot);
  const results = [];
  for (const workflowPath of files) {
    let frontmatter;
    try {
      // The frontmatter only, from a regular file opened without blocking: a
      // FIFO in a home is skipped, never waited on (ADR-0067 Decision 4, item 1).
      const text = readFrontmatterText(workflowPath);
      if (text === null) throw new Error('not a regular file');
      ({ frontmatter } = parseWorkflowFile(text));
    } catch (err) {
      // Corrupt/unreadable workflow — skip (fail-open, ADR-0011 §4). One bad
      // file must not block sweeping the rest.
      stderr.write(`${personaName()}/stop-archive: orphan-sweep skip ${workflowPath}: ${err.message}\n`);
      continue;
    }
    if (sweepGateFailures(frontmatter).length > 0) continue;
    const branch = frontmatter?.git_baseline?.branch;
    if (typeof branch !== 'string' || branch.length === 0) continue;
    if (checkout.state === 'branch' && branch === checkout.branch) continue; // the per-branch path owns it
    if (elsewhere.branches.has(branch)) continue; // another worktree's Stop owns it
    const refState = branchRefState(repoRoot, branch);
    if (refState === 'present') {
      if (checkout.state === 'unknown' || !elsewhere.ok) continue; // any kept branch could be a checked-out one
      const result = await archiveOnKeptBranch({ workflowPath, frontmatter, branch, host, repoRoot, stderr, archive });
      if (result) results.push(result);
      continue;
    }
    if (refState !== 'absent') continue; // unknown → leave
    // Parent-linked orphan (dispatch_target on): archiving it is exactly the
    // cleanup the macro's A4 (no_active_engineer_children) gate waits for, and
    // A3 (all_subtasks_terminal) still guards the macro against false
    // completion. The deferred parent writeback cannot be replayed here (a
    // deleted branch has no recoverable terminal commit, and writebackParent
    // requires one), so the rare "committed but writeback missed" case is
    // surfaced for manual reconciliation rather than silently dropped. With
    // dispatch_target off these workflows carry no parent linkage.
    if (capabilityOn('dispatch_target')
        && typeof frontmatter.parent_workflow === 'string' && frontmatter.parent_workflow.length > 0) {
      stderr.write(
        `${personaName()}/stop-archive: archiving parent-linked orphan ${workflowPath} ` +
        `(parent=${frontmatter.parent_workflow}, subtask=${frontmatter.originating_subtask ?? '?'}); ` +
        `if its work landed, confirm the macro subtask is completed via ` +
        `/orchestrator:done — the macro's all_subtasks_terminal gate keeps it live until then.\n`,
      );
    }
    try {
      const archiveResult = await archive({ workflowPath, host, repoRoot, recheck: sweepGateFailures });
      results.push({
        workflowPath,
        archived: archiveResult.archived === true,
        to: archiveResult.to,
        reason: archiveResult.reason,
        ...(archiveResult.gateFailures ? { gateFailures: archiveResult.gateFailures } : {}),
      });
    } catch (err) {
      stderr.write(`${personaName()}/stop-archive: orphan-sweep archive failed for ${workflowPath}: ${err.message}\n`);
      results.push({ workflowPath, archived: false, reason: 'archive-threw' });
    }
  }
  return results;
}

/**
 * The gates every sweep path holds, whatever its branch: the work is done (the
 * terminal marker, a terminal phase) and no owner gate is pending — ADR-0063
 * D6's gate 5, which holds even once the branch is gone. Checked on the
 * sweep's read and again on the archive's locked read.
 */
function sweepGateFailures(frontmatter) {
  const failures = [];
  if (!terminalMarkerCheck(frontmatter)) failures.push('terminal_marker');
  if (!terminalPhaseCheck(frontmatter?.current_phase)) failures.push('terminal_phase');
  if (frontmatter?.awaiting_owner_gate !== undefined) failures.push('awaiting_owner');
  return failures;
}

/**
 * Judge a terminal workflow whose branch still exists but is not checked out
 * against that branch's tip, and archive it when every gate passes. Returns
 * `null` when it is left alone (nothing was written).
 */
async function archiveOnKeptBranch({ workflowPath, frontmatter, branch, host, repoRoot, stderr, archive }) {
  const tip = branchTip(repoRoot, branch);
  if (!tip) return null;
  const verdict = evaluateStopArchive({ frontmatter, headSha: tip.sha, headSubject: tip.subject });
  if (!verdict.shouldArchive) return null;
  // Nobody is on this branch to see the archive, so a tip that merely differs
  // from the baseline is not enough: it must have moved forward from it.
  if (!descendsFrom(repoRoot, frontmatter?.git_baseline?.head, tip.sha)) return null;
  for (const w of verdict.warnings) {
    stderr.write(`${personaName()}/stop-archive: warning: ${w}\n`);
  }
  try {
    const archiveResult = await archive({
      workflowPath,
      host,
      repoRoot,
      recheck: (locked) => evaluateStopArchive({ frontmatter: locked, headSha: tip.sha, headSubject: tip.subject }).gateFailures,
    });
    // The parent note carries the kept branch's own tip (dispatch_target on).
    if (archiveResult.archived === true && capabilityOn('dispatch_target')) {
      await noteTerminalOnParent({ frontmatter, commit: tip.sha, host, repoRoot, stderr });
    }
    return {
      workflowPath,
      archived: archiveResult.archived === true,
      to: archiveResult.to,
      reason: archiveResult.reason,
      ...(archiveResult.gateFailures ? { gateFailures: archiveResult.gateFailures } : {}),
    };
  } catch (err) {
    stderr.write(`${personaName()}/stop-archive: orphan-sweep archive failed for ${workflowPath}: ${err.message}\n`);
    return { workflowPath, archived: false, reason: 'archive-threw' };
  }
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
