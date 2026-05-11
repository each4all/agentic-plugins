// plugins/orchestrator/scripts/stop-archive.mjs
//
// ADR-0019 §5 — macro auto-archive A1-A4 (orchestrator-side). Mirror of
// `plugins/engineer/scripts/stop-archive.mjs` with these intentional
// divergences:
//
//   - Terminal phase whitelist is `MACRO_TERMINAL_PHASES`
//     (commit-complete / finalized / aborted), NOT engineer's
//     (commit-complete / summary-complete / fix-complete).
//
//   - A3 gate is `all_subtasks_terminal` (every entry in
//     `plan.subtasks[]` has `status` in {completed, deferred, abandoned}),
//     NOT engineer's `head_moved`. Macro plans span multiple branches,
//     so HEAD comparison is meaningless — the operative completion
//     signal is "every subtask reached a terminal state".
//
//   - A4 gate is `no_active_engineer_children` (no non-archived engineer
//     workflow file references this orchestrator's id via
//     `parent_workflow`), NOT engineer's `child_completions` shape
//     check. Macro plans operate cross-plugin — engineer workflows live
//     under `.claude/agentic-engineer/workflows/` and the gate counts
//     references via the orchestrator-local scan helper
//     `noActiveEngineerChildrenScan`.
//
//   - No parent writeback path. Macros are root workflows in the
//     ADR-0019 scope — they have no orchestrator parent of their own.
//
//   - Branch-agnostic iteration via `runMacroStopArchiveAll`. Engineer's
//     hook entry point uses `findActiveWorkflow(repoRoot)` (branch-keyed,
//     ADR-0018 §sub-2 per-branch single-active). Orchestrator's hook
//     iterates ALL macros under `workflows/` because each macro spans
//     parent branch + N subtask branches; the Stop event that finalizes
//     the last subtask fires on a subtask branch where branch-keyed
//     lookup would miss the parent macro.
//
// Two surfaces:
//   - evaluateMacroStopArchive() — pure; given frontmatter + scan
//     results + optional head subject, returns a verdict object.
//   - runMacroStopArchive() — composite; reads the workflow, computes
//     scan results, runs evaluation, performs snapshot + archive side
//     effects, emits soft warnings. Error paths return
//     `{archived: false, reason: ...}` instead of throwing — hook
//     absence is non-fatal per ADR-0011 §4.
//   - runMacroStopArchiveAll() — iterate every macro under
//     `workflows/`, call runMacroStopArchive on each. Returns an array
//     of per-macro results.

import {
  allSubtasksTerminalCheck,
  archiveWorkflow,
  listAllMacros,
  macroTerminalPhaseCheck,
  noActiveEngineerChildrenScan,
  parseWorkflowFile,
  snapshot,
  terminalMarkerCheck,
} from './state.mjs';
import { readFile } from 'node:fs/promises';

/**
 * ADR-0019 §5 macro A1-A4 gate evaluator. Pure: takes everything as
 * input, returns a verdict object. The soft conventional-commit subject
 * gate emits a warning but does NOT block the archive (engineer parity).
 *
 * @param {object}  args
 * @param {object}  args.frontmatter — parsed macro workflow frontmatter
 * @param {number}  args.noActiveEngineerChildren — count from
 *   `noActiveEngineerChildrenScan(repoRoot, macroId)`. Zero means A4 passes.
 * @param {?string} [args.headSubject] — current HEAD commit subject, for
 *   the soft conventional-commit warning. Null/undefined skips the warning.
 * @returns {{shouldArchive: boolean, gateFailures: string[], warnings: string[]}}
 */
export function evaluateMacroStopArchive({
  frontmatter,
  noActiveEngineerChildren,
  headSubject = null,
}) {
  const gateFailures = [];
  const warnings = [];

  // A1 — terminal_marker REQUIRED (false-positive defense).
  if (!terminalMarkerCheck(frontmatter)) {
    gateFailures.push('terminal_marker');
  }

  // A2 — macro terminal-phase whitelist.
  if (!macroTerminalPhaseCheck(frontmatter?.current_phase)) {
    gateFailures.push('macro_terminal_phase');
  }

  // A3 — replaces engineer's head_moved. Every subtask must be terminal.
  if (!allSubtasksTerminalCheck(frontmatter)) {
    gateFailures.push('all_subtasks_terminal');
  }

  // A4 — engineer workflows directory scan, NOT engineer's
  // child_completions array. Caller is responsible for invoking the
  // async scan helper before this pure evaluator.
  if (typeof noActiveEngineerChildren !== 'number' || noActiveEngineerChildren > 0) {
    gateFailures.push('no_active_engineer_children');
  }

  // Soft gate — Conventional commit subject. Always evaluated, never
  // adds to gateFailures (engineer parity).
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
 * Composite: snapshot → read → scan → evaluate → archive on pass.
 *
 * Snapshot side effect is preserved even when gates fail (ADR-0011 §4
 * Stop hook contract: last_snapshot + host_history must always be
 * written). Error paths return non-throwing `{archived: false, reason}`.
 *
 * Branch-agnostic: no findActiveWorkflow call. The caller (either
 * `runMacroStopArchiveAll` or an external invocation from the runbook)
 * supplies the explicit workflow path.
 *
 * @param {object}   args
 * @param {string}   args.workflowPath
 * @param {string}   args.host                 — 'claude' | 'codex'
 * @param {string}   args.repoRoot
 * @param {string}   [args.statusDigest]
 * @param {?string}  [args.headSubject]
 * @param {NodeJS.WriteStream|{write:(s:string)=>void}} [args.stderr]
 * @returns {Promise<{archived: boolean, reason?: string, gateFailures?: string[], to?: string}>}
 */
export async function runMacroStopArchive({
  workflowPath,
  host,
  repoRoot,
  statusDigest = '',
  headSubject = null,
  stderr = process.stderr,
}) {
  // Step 1 — snapshot. Preserves last_snapshot + host_history record
  // even when gates do not pass (engineer parity).
  try {
    await snapshot({
      workflowPath,
      host,
      trigger: 'stop',
      statusDigest,
    });
  } catch (err) {
    stderr.write(`orchestrator/stop-archive: snapshot failed: ${err.message}\n`);
    // Continue — snapshot failure must not block archive evaluation.
  }

  // Step 2 — read frontmatter. Re-read post-snapshot so the gates see
  // the on-disk state archive will operate on.
  let frontmatter;
  try {
    const text = await readFile(workflowPath, 'utf8');
    ({ frontmatter } = parseWorkflowFile(text));
  } catch (err) {
    stderr.write(
      `orchestrator/stop-archive: failed to read ${workflowPath}: ${err.message}\n`,
    );
    return { archived: false, reason: 'read-failed' };
  }

  // Step 3 — compute scan results. A4 requires the engineer workflows
  // directory scan; do it now so the pure evaluator stays synchronous.
  let noActiveEngineerChildren = 0;
  const macroId = frontmatter?.workflow_id;
  if (typeof macroId === 'string' && macroId.length > 0) {
    try {
      noActiveEngineerChildren = await noActiveEngineerChildrenScan(repoRoot, macroId);
    } catch (err) {
      // Scan errors split by category:
      //
      // - ENOENT on the engineer workflows directory is the "engineer
      //   not installed / no live workflows" case. `noActiveEngineerChildrenScan`
      //   itself returns 0 for that path without throwing, so we never
      //   reach this catch via that branch.
      // - Any other error (EACCES, EPERM, EIO, etc.) reaching this catch
      //   indicates we could NOT confirm the absence of live engineer
      //   children. Fail-CLOSED in that case: setting a non-zero
      //   sentinel (we use 1) makes the A4 gate fail and keeps the
      //   workflow file in `workflows/` for the next Stop event, when
      //   the filesystem state may have recovered. The cost of an extra
      //   Stop cycle is far less than the cost of archiving a macro
      //   whose children are still active. This is the trade-off Phase
      //   5 review flagged (Phase 6 resolve).
      stderr.write(
        `orchestrator/stop-archive: noActiveEngineerChildrenScan failed for ${macroId}: ${err.message} (fail-closed; macro remains live until next Stop)\n`,
      );
      noActiveEngineerChildren = 1;
    }
  }

  // Step 4 — evaluate gates.
  const verdict = evaluateMacroStopArchive({
    frontmatter,
    noActiveEngineerChildren,
    headSubject,
  });
  for (const w of verdict.warnings) {
    stderr.write(`orchestrator/stop-archive: warning: ${w}\n`);
  }
  if (!verdict.shouldArchive) {
    return {
      archived: false,
      reason: 'gate-not-met',
      gateFailures: verdict.gateFailures,
    };
  }

  // Step 5 — archive. Failure here is logged but does not throw past
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
    stderr.write(`orchestrator/stop-archive: archive failed: ${err.message}\n`);
    return { archived: false, reason: 'archive-threw' };
  }

  return { archived: true, to: archiveResult.to };
}

/**
 * Iterate every non-archived macro under `workflows/`, invoke
 * `runMacroStopArchive` on each. Returns an array of per-macro results
 * (same envelope shape, indexed by listAllMacros order).
 *
 * This is the entry point the orchestrator Claude Stop hook calls. It
 * also serves as the manual helper invocation surface for Codex (where
 * the host has no Stop event — the runbook tails or the user invoke
 * the Codex stop hook manually).
 *
 * Concurrent macro creation during iteration: the readdir snapshot is
 * taken at iteration start; a macro created mid-iteration appears on
 * the next runMacroStopArchiveAll call (ADR-0019 §5 D-δ: per-file lock
 * for each macro evaluation; no dir-wide lock).
 *
 * @param {object}   args
 * @param {string}   args.repoRoot
 * @param {string}   args.host
 * @param {?string}  [args.headSubject]
 * @param {string}   [args.statusDigest]
 * @param {NodeJS.WriteStream|{write:(s:string)=>void}} [args.stderr]
 * @returns {Promise<Array<{workflowPath: string, archived: boolean, reason?: string, gateFailures?: string[], to?: string}>>}
 */
export async function runMacroStopArchiveAll({
  repoRoot,
  host,
  headSubject = null,
  statusDigest = '',
  stderr = process.stderr,
}) {
  let macros;
  try {
    macros = await listAllMacros(repoRoot);
  } catch (err) {
    stderr.write(`orchestrator/stop-archive: listAllMacros failed: ${err.message}\n`);
    return [];
  }
  const results = [];
  for (const workflowPath of macros) {
    const result = await runMacroStopArchive({
      workflowPath,
      host,
      repoRoot,
      statusDigest,
      headSubject,
      stderr,
    });
    results.push({ workflowPath, ...result });
  }
  return results;
}

// Inline copy of the conventional-commit pattern used in the engineer
// adapter's _shared.mjs helper. Duplicated here so
// `evaluateMacroStopArchive` is pure (no transitive dependency on the
// Claude adapter helpers). AGENTS.md's Conventional Commits subset is
// the single canonical source of truth both copies implement.
const CONVENTIONAL_COMMIT_RE =
  /^(feat|fix|docs|ci|refactor|chore|test)(\([^)]+\))?:/;

function isConventionalCommitSubjectInline(subject) {
  if (typeof subject !== 'string' || subject.length === 0) return false;
  return CONVENTIONAL_COMMIT_RE.test(subject);
}

function truncate(text, max) {
  if (typeof text !== 'string') return '';
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
