// ADR-0031 — orchestrator session-handoff projection tests.
//
// Verifies that orchestrator computes its OWN bounded MACRO projection
// (fail-closed) and that the result satisfies the runtime seam's bounded schema
// (the cross-plugin contract). Mirrors tests/engineer/test-session-handoff.mjs
// with the macro-specific divergences: cross-branch resolution (find-active then
// find-macro), the pure evaluateMacroStopArchive gate set, the empty-macro
// guard, and HEAD-independent archive readiness.
//
// Run via `node --test tests/orchestrator/test-session-handoff.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  computeOrchestratorProjection,
  mapArchiveGate,
  parseArgs,
} from '../../plugins/orchestrator/scripts/session-handoff.mjs';
import {
  createWorkflow,
  setPlan,
  setMacroTerminal,
} from '../../plugins/orchestrator/scripts/state.mjs';
import { normalizeProjection } from '../../plugins/runtime/scripts/context.mjs';

// Write a live engineer child workflow referencing a macro (A4 gate input).
// Mirrors the inline helper in test-stop-archive.mjs; the legacy engineer home
// is one of the two dirs noActiveEngineerChildrenScan walks.
async function writeEngineerChild(repoRoot, name, parentMacroId) {
  const dir = join(repoRoot, '.claude/agentic-engineer/workflows');
  await mkdir(dir, { recursive: true });
  const lines = [
    '---',
    'schema: "1.1"',
    `workflow_id: ${JSON.stringify(name.replace(/\.md$/, ''))}`,
    `parent_workflow: ${JSON.stringify(parentMacroId)}`,
    'originating_subtask: "T1"',
    '---',
    '# engineer child fixture',
    '',
  ];
  await writeFile(join(dir, name), lines.join('\n'));
}

// Relocate a macro file (created in the canonical home by createWorkflow) into
// the LEGACY orchestrator workflow home, so both-homes resolution can be tested.
async function relocateMacroToLegacy(repoRoot, canonicalPath) {
  const legacyDir = join(repoRoot, '.claude/agentic-orchestrator/workflows');
  await mkdir(legacyDir, { recursive: true });
  const dest = join(legacyDir, canonicalPath.split('/').pop());
  await rename(canonicalPath, dest);
  return dest;
}

const MIN_BASELINE = (branch = 'main') => ({
  branch,
  head: '0000000000000000000000000000000000000000',
  status_digest: '',
});

// Build a macro fixture: create (verb=plan → macro id), optionally set the
// plan.subtasks[], optionally mark terminal. Returns the macro workflow path.
async function bootstrapMacro(repoRoot, { branch = 'main', subtasks = [], terminal = null } = {}) {
  const { filePath } = await createWorkflow({
    repoRoot,
    verb: 'plan',
    host: 'claude',
    gitBaseline: MIN_BASELINE(branch),
    currentPhase: 'phase-2-presented',
    nextAction: 'Dispatch the first ready subtask',
    originalRequest: 'session-handoff macro fixture',
  });
  if (subtasks.length > 0) {
    await setPlan({ workflowPath: filePath, host: 'claude', subtasks });
  }
  if (terminal) {
    await setMacroTerminal({
      workflowPath: filePath,
      host: 'claude',
      terminalPhase: terminal.phase,
      terminalMarker: terminal.marker !== false,
    });
  }
  return filePath;
}

function macroIdFromPath(path) {
  return path.split('/').pop().replace(/\.md$/, '');
}

const SUBTASK = (over = {}) => ({
  id: 'T1', verb: 'compose', branch: 'feat/t1', blocked_by: [], status: 'completed', ...over,
});

describe('orchestrator session handoff projection (ADR-0031)', () => {
  it('maps the pure evaluateMacroStopArchive verdict to a generic archive_gate', () => {
    strictEqual(mapArchiveGate({ shouldArchive: true, gateFailures: [] }), 'ready_to_archive');
    // terminal_marker unmet (work in progress) → not_terminal, even alongside others.
    strictEqual(
      mapArchiveGate({ shouldArchive: false, gateFailures: ['terminal_marker', 'all_subtasks_terminal'] }),
      'not_terminal',
    );
    // terminal-marked but another macro gate unmet → blocked.
    strictEqual(mapArchiveGate({ shouldArchive: false, gateFailures: ['all_subtasks_terminal'] }), 'blocked');
    strictEqual(mapArchiveGate({ shouldArchive: false, gateFailures: ['macro_terminal_phase'] }), 'blocked');
    strictEqual(mapArchiveGate({ shouldArchive: false, gateFailures: ['no_active_engineer_children'] }), 'blocked');
  });

  it('reports no active branch context on detached HEAD and does not auto-fresh', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-handoff-detached-'));
    try {
      const result = await computeOrchestratorProjection({ repoRoot: root, branch: null });
      strictEqual(result.status, 'no_active_branch_context');
      strictEqual(result.projection, null);
      strictEqual(result.routing, '/orchestrator:resume'); // default still present
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports no active workflow when the branch has no macro', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-handoff-none-'));
    try {
      const result = await computeOrchestratorProjection({ repoRoot: root, branch: 'feat/x' });
      strictEqual(result.status, 'no_active_workflow');
      strictEqual(result.projection, null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('computes a complete bounded macro projection for an in-progress macro (not_terminal)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-handoff-ok-'));
    try {
      await bootstrapMacro(root, { branch: 'main', subtasks: [SUBTASK({ status: 'pending' })] });
      const result = await computeOrchestratorProjection({
        repoRoot: root, branch: 'main', routing: '/orchestrator:next',
      });
      strictEqual(result.status, 'ok');
      strictEqual(result.projection.workflow_kind, 'orchestrator');
      strictEqual(result.projection.phase, 'phase-2-presented');
      strictEqual(result.projection.archive_gate, 'not_terminal'); // no terminal_marker yet
      strictEqual(result.projection.routing_recommendation, '/orchestrator:next');
      ok(result.projection.workflow_id.startsWith('macro-plan-'));
      ok(result.projection.workflow_path.startsWith('.agentic-plugins/'));
      for (const field of ['workflow_id', 'workflow_path', 'phase', 'next_action', 'routing_recommendation']) {
        ok(result.projection[field] && result.projection[field].length > 0, `${field} must be non-empty`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves the macro from a SUBTASK branch via find-macro (not find-active)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-handoff-findmacro-'));
    try {
      // Macro anchored to main, with a subtask on feat/sub1. Projecting from
      // feat/sub1 must resolve via find-macro — find-active keys on the macro's
      // own branch (main) and would miss it (next.md:30).
      const path = await bootstrapMacro(root, {
        branch: 'main',
        subtasks: [SUBTASK({ id: 'sub1', branch: 'feat/sub1', status: 'pending' })],
      });
      const result = await computeOrchestratorProjection({ repoRoot: root, branch: 'feat/sub1' });
      strictEqual(result.status, 'ok');
      strictEqual(result.projection.workflow_id, macroIdFromPath(path));
      strictEqual(result.projection.workflow_kind, 'orchestrator');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('derives ready_to_archive when every macro gate passes (terminal + all subtasks terminal + no children)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-handoff-ready-'));
    try {
      await bootstrapMacro(root, {
        branch: 'main',
        subtasks: [SUBTASK({ status: 'completed' })],
        terminal: { phase: 'finalized' },
      });
      const result = await computeOrchestratorProjection({ repoRoot: root, branch: 'main' });
      strictEqual(result.projection.archive_gate, 'ready_to_archive');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('derives blocked when terminal-marked but a subtask is still pending (all_subtasks_terminal fails)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-handoff-blocked-'));
    try {
      await bootstrapMacro(root, {
        branch: 'main',
        subtasks: [SUBTASK({ id: 'a', status: 'completed' }), SUBTASK({ id: 'b', branch: 'feat/b', status: 'pending' })],
        terminal: { phase: 'finalized' },
      });
      const result = await computeOrchestratorProjection({ repoRoot: root, branch: 'main' });
      strictEqual(result.projection.archive_gate, 'blocked'); // terminal-marked, but not all subtasks terminal
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('derives blocked when an active engineer child still references the macro (A4 gate)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-handoff-a4-'));
    try {
      const path = await bootstrapMacro(root, {
        branch: 'main',
        subtasks: [SUBTASK({ status: 'completed' })],
        terminal: { phase: 'finalized' },
      });
      // A live engineer child workflow referencing this macro → A4 fails.
      await writeEngineerChild(root, 'compose-20260604T000000Z-abcdef.md', macroIdFromPath(path));
      const result = await computeOrchestratorProjection({ repoRoot: root, branch: 'main' });
      strictEqual(result.projection.archive_gate, 'blocked');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('empty-macro guard: a zero-subtask, non-terminal macro is not_terminal, never ready_to_archive', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-handoff-empty-'));
    try {
      // No subtasks → all_subtasks_terminal is vacuously true (state.mjs:3137).
      // The projection must NOT report ready_to_archive on that predicate alone:
      // terminal_marker (A1) is unmet → not_terminal.
      await bootstrapMacro(root, { branch: 'main', subtasks: [] });
      const result = await computeOrchestratorProjection({ repoRoot: root, branch: 'main' });
      strictEqual(result.projection.archive_gate, 'not_terminal');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fail-closed: one subtask branch matching 2 macros emits no projection (routing kept)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-handoff-ambig-'));
    try {
      // Two active macros both referencing feat/dup as a subtask branch, neither
      // anchored to it. From feat/dup, find-active misses and find-macro throws
      // (ADR-0019 §1 fail-closed uniqueness) → status=fail_closed, no projection,
      // but routing is still available standalone for the seam.
      await bootstrapMacro(root, { branch: 'main', subtasks: [SUBTASK({ id: 'a', branch: 'feat/dup', status: 'pending' })] });
      await bootstrapMacro(root, { branch: 'develop', subtasks: [SUBTASK({ id: 'b', branch: 'feat/dup', status: 'pending' })] });
      const result = await computeOrchestratorProjection({ repoRoot: root, branch: 'feat/dup', routing: '/orchestrator:resume' });
      strictEqual(result.status, 'fail_closed');
      strictEqual(result.projection, null);
      ok(result.error); // ambiguity reason surfaced
      strictEqual(result.routing, '/orchestrator:resume');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('resolves a LEGACY-home macro from its subtask branch (both-homes scan)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-handoff-legacy-'));
    try {
      // A macro that lives only in the legacy home must still be found by its
      // subtask branch — find-macro scans both homes (P1-a hardening).
      const canonical = await bootstrapMacro(root, {
        branch: 'main',
        subtasks: [SUBTASK({ id: 'L1', branch: 'feat/legacy', status: 'pending' })],
      });
      const legacyPath = await relocateMacroToLegacy(root, canonical);
      const result = await computeOrchestratorProjection({ repoRoot: root, branch: 'feat/legacy' });
      strictEqual(result.status, 'ok');
      strictEqual(result.projection.workflow_id, macroIdFromPath(legacyPath));
      ok(result.projection.workflow_path.includes('.claude/agentic-orchestrator'));
      strictEqual(normalizeProjection(result.projection).error, null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fail-closed ACROSS homes: a subtask branch in both a canonical AND a legacy macro', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-handoff-xhome-'));
    try {
      // canonical macro referencing feat/dup + a legacy macro ALSO referencing
      // feat/dup. A single-home scan would silently pick canonical; the
      // both-homes scan finds 2 and throws → fail_closed (P1-a).
      await bootstrapMacro(root, { branch: 'main', subtasks: [SUBTASK({ id: 'a', branch: 'feat/dup', status: 'pending' })] });
      const second = await bootstrapMacro(root, { branch: 'develop', subtasks: [SUBTASK({ id: 'b', branch: 'feat/dup', status: 'pending' })] });
      await relocateMacroToLegacy(root, second);
      const result = await computeOrchestratorProjection({ repoRoot: root, branch: 'feat/dup' });
      strictEqual(result.status, 'fail_closed');
      strictEqual(result.projection, null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fail-closed on a branch collision: one branch is a macro anchor AND another macro subtask', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-handoff-collide-'));
    try {
      // macro-A anchored to feat/collide; macro-B (on main) has a SUBTASK on
      // feat/collide. From feat/collide, find-active=macro-A and
      // find-macro=macro-B differ → fail_closed instead of silently preferring
      // the own-branch macro (P2 compute-both).
      await bootstrapMacro(root, { branch: 'feat/collide', subtasks: [SUBTASK({ id: 'x', branch: 'feat/x', status: 'pending' })] });
      await bootstrapMacro(root, { branch: 'main', subtasks: [SUBTASK({ id: 'y', branch: 'feat/collide', status: 'pending' })] });
      const result = await computeOrchestratorProjection({ repoRoot: root, branch: 'feat/collide' });
      strictEqual(result.status, 'fail_closed');
      strictEqual(result.projection, null);
      ok(result.error);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('produces a projection the runtime seam accepts unchanged (cross-plugin contract)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-handoff-xcheck-'));
    try {
      await bootstrapMacro(root, { branch: 'main', subtasks: [SUBTASK({ status: 'pending' })] });
      const { projection } = await computeOrchestratorProjection({ repoRoot: root, branch: 'main' });
      const { projection: normalized, error } = normalizeProjection(projection);
      strictEqual(error, null);
      ok(normalized);
      strictEqual(normalized.workflow_kind, 'orchestrator');
      strictEqual(normalized.archive_gate, 'not_terminal');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('treats whitespace-only routing as absent and falls back to the default (seam-accepted)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-handoff-ws-'));
    try {
      await bootstrapMacro(root, { branch: 'main', subtasks: [SUBTASK({ status: 'pending' })] });
      const result = await computeOrchestratorProjection({ repoRoot: root, branch: 'main', routing: '   ' });
      strictEqual(result.projection.routing_recommendation, '/orchestrator:resume');
      strictEqual(normalizeProjection(result.projection).error, null); // not rejected by the seam
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('always returns a routing recommendation, even with no projection (ADR-0031 input (c))', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-handoff-routing-'));
    try {
      const none = await computeOrchestratorProjection({ repoRoot: root, branch: 'feat/none', routing: '/orchestrator:plan' });
      strictEqual(none.status, 'no_active_workflow');
      strictEqual(none.projection, null);
      strictEqual(none.routing, '/orchestrator:plan'); // available standalone for the seam
      const detached = await computeOrchestratorProjection({ repoRoot: root, branch: null });
      strictEqual(detached.status, 'no_active_branch_context');
      strictEqual(detached.routing, '/orchestrator:resume');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('parses CLI args', () => {
    const options = parseArgs(['project', '--repo-root', '/r', '--branch', 'b', '--routing', '/orchestrator:resume']);
    strictEqual(options.command, 'project');
    strictEqual(options.repoRoot, '/r');
    strictEqual(options.branch, 'b');
    strictEqual(options.routing, '/orchestrator:resume');
  });
});
