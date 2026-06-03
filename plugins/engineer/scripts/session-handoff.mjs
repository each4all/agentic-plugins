#!/usr/bin/env node

// ADR-0031 — engineer session-handoff projection.
//
// Engineer (L3) computes its OWN bounded workflow projection from its own
// state and passes it INTO the runtime (L1) seam (`runtime:context check
// --workflow-projection-file` / `runtime footer --workflow-projection-file`).
// runtime never shell-reads engineer state; the dependency direction stays
// L3 -> L1 (ADR-0010), matching the projection (inversion-of-control) model.
//
// The projection is computed fail-closed: a corrupt / ambiguous (canonical +
// legacy split) state yields NO projection (the seam degrades to context-risk
// only), never a half-trusted one. archive_gate is collapsed from the PURE
// `evaluateStopArchive` verdict — never the side-effecting `runStopArchive`
// runner — so computing the projection has no side effects.

import { execFileSync } from 'node:child_process';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  currentGitBranch,
  findActiveWorkflowByBranch,
  readWorkflow,
} from './state.mjs';
import { evaluateStopArchive } from './stop-archive.mjs';

// Default routing recommendation for an active engineer workflow: resume it.
const DEFAULT_ROUTING = '/engineer:resume';

/**
 * Collapse the pure `evaluateStopArchive` verdict ({shouldArchive,
 * gateFailures}) to the runtime seam's generic archive_gate (ADR-0031):
 *   - ready_to_archive : every hard gate passes
 *   - not_terminal     : the terminal_marker gate is unmet (work in progress)
 *   - blocked          : terminal-marked but another gate (head_moved /
 *                        no_active_children / terminal_phase) is still unmet,
 *                        or the gate could not be computed (null git probe).
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

// Probe HEAD sha + subject. A null probe (missing git / detached) is passed
// through to evaluateStopArchive, which treats it as "did not move" — so a
// probe failure can never produce a false ready_to_archive.
function probeHead(repoRoot) {
  let sha = null;
  let subject = null;
  try {
    sha = execFileSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() || null;
  } catch {
    return { sha: null, subject: null };
  }
  try {
    subject = execFileSync('git', ['-C', repoRoot, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim() || null;
  } catch {
    subject = null;
  }
  return { sha, subject };
}

/**
 * Compute the engineer bounded workflow projection for a branch.
 *
 * @returns {Promise<{projection: object|null, status: string, error?: string}>}
 *   status is one of: ok | no_active_branch_context | no_active_workflow |
 *   fail_closed. The projection is non-null only for `ok`.
 */
export async function computeEngineerProjection({
  repoRoot,
  branch,
  routing,
  headSha,
  headSubject,
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
  // auto-recommend a fresh session (ADR-0018 §sub-2; start.md detached-HEAD rule).
  if (!branch) {
    return { projection: null, status: 'no_active_branch_context', routing: resolvedRouting };
  }
  let activePath;
  try {
    // Throws on a canonical + legacy split (fail-closed, ADR-0031).
    activePath = await findActiveWorkflowByBranch(repoRoot, branch);
  } catch (error) {
    return { projection: null, status: 'fail_closed', error: error.message, routing: resolvedRouting };
  }
  if (!activePath) {
    return { projection: null, status: 'no_active_workflow', routing: resolvedRouting };
  }
  let parsed;
  try {
    parsed = await readWorkflow(activePath);
  } catch (error) {
    return { projection: null, status: 'fail_closed', error: error.message, routing: resolvedRouting };
  }
  const frontmatter = parsed.frontmatter ?? parsed;
  // The runtime seam requires every non-checkpoint projection field non-empty.
  // If a required engineer field is somehow absent, emit NO projection
  // (fail-closed) rather than one the seam would reject + report.
  for (const field of ['workflow_id', 'current_phase', 'next_action']) {
    const value = frontmatter[field];
    if (typeof value !== 'string' || value.trim() === '') {
      return {
        projection: null,
        status: 'fail_closed',
        error: `engineer workflow missing required field: ${field}`,
        routing: resolvedRouting,
      };
    }
  }
  const probe = headSha === undefined
    ? probeHead(repoRoot)
    : { sha: headSha, subject: headSubject ?? null };
  const verdict = evaluateStopArchive({
    frontmatter,
    headSha: probe.sha,
    headSubject: probe.subject,
  });
  const projection = {
    workflow_kind: 'engineer',
    workflow_id: frontmatter.workflow_id,
    workflow_path: repoRelativePointer(repoRoot, activePath),
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
  return `engineer session-handoff (ADR-0031)

Usage:
  session-handoff.mjs project [--repo-root <path>] [--branch <branch>] [--routing <route>]

Computes the engineer bounded workflow projection (workflow_kind/id/path, phase,
next_action, checkpoint, archive_gate, routing_recommendation) for the active
workflow on the branch, fail-closed, and prints { projection, status } JSON.
Pass the projection to the runtime seam:
  node session-handoff.mjs project --repo-root . > /tmp/proj.json   # then read .projection
  runtime:context check --risk <green|yellow|red> --workflow-projection-file <file>
This script only READS engineer state; it never archives or mutates anything.`;
}

export async function runSessionHandoff(options = {}) {
  if (options.help) return { help: true, text: helpText() };
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const branch = options.branch ?? currentGitBranch(repoRoot);
  return computeEngineerProjection({ repoRoot, branch, routing: options.routing });
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
