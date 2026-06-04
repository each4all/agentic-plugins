#!/usr/bin/env node

// ADR-0031 — orchestrator session-handoff projection (macro mirror of
// `plugins/engineer/scripts/session-handoff.mjs`).
//
// Orchestrator (L2) computes its OWN bounded macro projection from its own
// state and passes it INTO the runtime (L1) seam (`runtime:context check
// --workflow-projection-file` / `runtime footer --workflow-projection-file`).
// runtime never shell-reads orchestrator state; the dependency direction stays
// L2 -> L1 (ADR-0010), matching the projection (inversion-of-control) model.
//
// Intentional divergences from the engineer projection:
//
//   - Macro resolution spans branches. A macro is anchored to its
//     `git_baseline.branch`, but its subtasks live on N other branches, so the
//     resolver tries `findActiveWorkflowByBranch` (the user is on the macro's
//     own / parent branch) THEN `findMacroBySubtaskBranch` (the user switched
//     to a subtask branch, where find-active keys on the macro's own branch and
//     would miss the parent — next.md:30, "never find-active on a subtask
//     branch"). Engineer keys purely on the per-branch active workflow.
//
//   - archive_gate is collapsed from the PURE `evaluateMacroStopArchive`
//     verdict (A1 terminal_marker / A2 macro_terminal_phase / A3
//     all_subtasks_terminal / A4 no_active_engineer_children) — never the
//     side-effecting `runMacroStopArchive` runner. The A4 gate needs an async
//     child scan, computed fail-closed (a non-ENOENT scan error sets a
//     non-zero sentinel so the gate fails) before the synchronous evaluator.
//
//   - Empty-macro guard: ready_to_archive requires the FULL verdict, never the
//     vacuously-true `all_subtasks_terminal` predicate alone — A1 terminal_marker
//     + A2 macro_terminal_phase must also pass (state.mjs:3137 documents the
//     vacuous-true edge for a zero-subtask plan). Collapsing the whole verdict
//     implements the guard for free.
//
//   - The macro projection does NOT probe git HEAD. Macro archive readiness is
//     HEAD-independent (a macro spans branches; HEAD comparison is meaningless
//     — the operative completion signal is all-subtasks-terminal, per the
//     stop-archive.mjs header). `evaluateMacroStopArchive`'s only HEAD input is
//     the soft conventional-commit warning, which the bounded projection never
//     carries, so headSubject is passed null.

import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  currentGitBranch,
  findActiveWorkflowByBranch,
  findMacroBySubtaskBranch,
  noActiveEngineerChildrenScan,
  readWorkflow,
} from './state.mjs';
import { evaluateMacroStopArchive } from './stop-archive.mjs';

// Default routing recommendation for an active macro workflow: resume it.
const DEFAULT_ROUTING = '/orchestrator:resume';

/**
 * Collapse the pure `evaluateMacroStopArchive` verdict ({shouldArchive,
 * gateFailures}) to the runtime seam's generic archive_gate (ADR-0031):
 *   - ready_to_archive : every macro gate (A1-A4) passes.
 *   - not_terminal     : the terminal_marker gate (A1) is unmet — the macro has
 *                        not been marked terminal yet (subtasks still landing).
 *   - blocked          : terminal-marked but another gate (macro_terminal_phase /
 *                        all_subtasks_terminal / no_active_engineer_children) is
 *                        still unmet, or the child scan could not be computed
 *                        (fail-closed sentinel) — archivable soon, awaiting the
 *                        finalize/abort phase, a subtask, or live children.
 */
export function mapArchiveGate(verdict) {
  if (verdict.shouldArchive) return 'ready_to_archive';
  if (verdict.gateFailures.includes('terminal_marker')) return 'not_terminal';
  return 'blocked';
}

function repoRelativePointer(repoRoot, target) {
  const rel = relative(repoRoot, target);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : target;
}

/**
 * Compute the orchestrator bounded macro projection for a branch.
 *
 * @returns {Promise<{projection: object|null, status: string, routing: string, error?: string}>}
 *   status is one of: ok | no_active_branch_context | no_active_workflow |
 *   fail_closed. The projection is non-null only for `ok`.
 */
export async function computeOrchestratorProjection({
  repoRoot,
  branch,
  routing,
  headSubject = null,
} = {}) {
  // Routing is ALWAYS available (ADR-0031 input (c)): a non-empty caller value,
  // else the default resume route. A whitespace-only value is treated as absent
  // so the runtime seam (which trims required strings) never rejects it. It is
  // returned in EVERY branch so the caller can pass it standalone when there is
  // no projection.
  const resolvedRouting = typeof routing === 'string' && routing.trim()
    ? routing.trim()
    : DEFAULT_ROUTING;
  // Detached HEAD / no branch — report 'no active branch context' and do NOT
  // auto-recommend a fresh session (ADR-0018 §sub-2; the contract's detached-
  // HEAD non-firing rule).
  if (!branch) {
    return { projection: null, status: 'no_active_branch_context', routing: resolvedRouting };
  }
  let macroPath;
  try {
    // Macro resolution spans branches (mirrors /orchestrator:next Phase 0):
    //   - find-active — the macro anchored to its git_baseline.branch (the
    //     user is on the macro's own / parent branch).
    //   - find-macro — branch-agnostic scan for the macro referencing the
    //     current branch as a subtask branch (the user switched to a subtask
    //     branch; find-active alone would miss the parent — next.md:30).
    // BOTH lookups are computed (not short-circuited) so a branch collision —
    // the same branch being one macro's anchor AND another macro's subtask
    // branch — surfaces as fail_closed instead of silently preferring the
    // own-branch macro. Each lookup is itself fail-closed across both workflow
    // homes (throws on a canonical+legacy split, a branch matching 2+ macros,
    // or a corrupt workflow file) -> status=fail_closed below.
    const onOwnBranch = await findActiveWorkflowByBranch(repoRoot, branch);
    const asSubtaskBranch = await findMacroBySubtaskBranch(repoRoot, branch);
    if (onOwnBranch && asSubtaskBranch && onOwnBranch !== asSubtaskBranch) {
      return {
        projection: null,
        status: 'fail_closed',
        error:
          `branch ${JSON.stringify(branch)} resolves to two different macros ` +
          `(${onOwnBranch} as its own branch, ${asSubtaskBranch} as a subtask branch); ` +
          `disambiguate before relying on the session handoff`,
        routing: resolvedRouting,
      };
    }
    macroPath = onOwnBranch ?? asSubtaskBranch;
  } catch (error) {
    return { projection: null, status: 'fail_closed', error: error.message, routing: resolvedRouting };
  }
  if (!macroPath) {
    return { projection: null, status: 'no_active_workflow', routing: resolvedRouting };
  }
  let parsed;
  try {
    parsed = await readWorkflow(macroPath);
  } catch (error) {
    return { projection: null, status: 'fail_closed', error: error.message, routing: resolvedRouting };
  }
  const frontmatter = parsed.frontmatter ?? parsed;
  // The runtime seam requires every non-checkpoint projection string non-empty.
  // If a required macro field is somehow absent, emit NO projection
  // (fail-closed) rather than one the seam would reject + report.
  for (const field of ['workflow_id', 'current_phase', 'next_action']) {
    const value = frontmatter[field];
    if (typeof value !== 'string' || value.trim() === '') {
      return {
        projection: null,
        status: 'fail_closed',
        error: `orchestrator macro missing required field: ${field}`,
        routing: resolvedRouting,
      };
    }
  }
  // A4 gate input — count live engineer children. Fail-closed at the SCAN
  // level: if the whole scan throws (e.g. EACCES on the children dir) the
  // sentinel below makes A4 fail, so archive_gate is never a false
  // ready_to_archive while children may still be live (mirrors
  // runMacroStopArchive Step 3). ENOENT (engineer not installed / no live
  // workflows) cleanly counts 0.
  //
  // Boundary (deliberate, matches the runner): an INDIVIDUAL unreadable or
  // malformed child file is fail-OPEN — `noActiveEngineerChildrenScan` skips it
  // and does NOT throw (ADR-0011 §4: a corrupt child must not block macro
  // archive). The projection therefore reports the SAME archive_gate the Stop
  // runner would act on; making the report stricter than the runner it
  // describes would surface "blocked" while the runner actually archives. The
  // conservative sentinel is for whole-scan failure, not per-file corruption.
  let noActiveEngineerChildren;
  try {
    noActiveEngineerChildren = await noActiveEngineerChildrenScan(
      repoRoot,
      frontmatter.workflow_id,
    );
  } catch {
    noActiveEngineerChildren = 1;
  }
  const verdict = evaluateMacroStopArchive({
    frontmatter,
    noActiveEngineerChildren,
    headSubject, // null by default — see header: macro readiness is HEAD-independent.
  });
  const projection = {
    workflow_kind: 'orchestrator',
    workflow_id: frontmatter.workflow_id,
    workflow_path: repoRelativePointer(repoRoot, macroPath),
    phase: frontmatter.current_phase,
    next_action: frontmatter.next_action,
    archive_gate: mapArchiveGate(verdict),
    routing_recommendation: resolvedRouting,
  };
  const checkpoint = frontmatter.latest_checkpoint?.summary;
  if (checkpoint) projection.checkpoint = checkpoint;
  return { projection, status: 'ok', routing: resolvedRouting };
}

export function parseArgs(argv) {
  const options = {};
  const args = [...argv];
  // optional leading subcommand
  if (args[0] && !args[0].startsWith('-')) options.command = args.shift();
  while (args.length > 0) {
    const arg = args.shift();
    switch (arg) {
      case '--repo-root':
        options.repoRoot = requireValue(args, arg);
        break;
      case '--branch':
        options.branch = requireValue(args, arg);
        break;
      case '--routing':
        options.routing = requireValue(args, arg);
        break;
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function requireValue(args, flag) {
  if (args.length === 0 || args[0].startsWith('-')) {
    throw new Error(`${flag} requires a value`);
  }
  return args.shift();
}

function helpText() {
  return `orchestrator session-handoff (ADR-0031)

Usage:
  session-handoff.mjs project [--repo-root <path>] [--branch <branch>] [--routing <route>]

Computes the orchestrator bounded macro projection (workflow_kind/id/path,
phase, next_action, checkpoint, archive_gate, routing_recommendation) for the
active macro on the branch, fail-closed, and prints { projection, status }
JSON. The macro is resolved across branches (find-active on the macro's own
branch, then find-macro on a subtask branch). Pass the projection to the
runtime seam:
  node session-handoff.mjs project --repo-root . > /tmp/proj.json   # then read .projection
  runtime:context check --risk <green|yellow|red> --workflow-projection-file <file>
This script only READS orchestrator state; it never archives or mutates anything.`;
}

export async function runSessionHandoff(options = {}) {
  if (options.help) return { help: true, text: helpText() };
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const branch = options.branch ?? currentGitBranch(repoRoot);
  return computeOrchestratorProjection({ repoRoot, branch, routing: options.routing });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // Async IIFE wrapper (project convention) — avoids the unsettled top-level
  // await deadlock when state.mjs's dynamic imports run during module load.
  (async () => {
    try {
      const options = parseArgs(process.argv.slice(2));
      const result = await runSessionHandoff(options);
      if (result.help) {
        process.stdout.write(`${result.text}\n`);
        return;
      }
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) {
      process.stderr.write(`✗ ${error.message}\n`);
      process.exit(1);
    }
  })();
}
