// ADR-0031 — designer session-handoff projection tests (ADR-0042 PR2).
//
// Verifies that designer computes its OWN bounded projection (fail-closed).
//
// Runtime-seam status: ADR-0043 S2 widened plugins/runtime's
// normalizeProjection enum to all four personas, so designer projections
// are seam-accepted on a current runtime; designer's own sidecar/footer
// plumbing lands separately (ADR-0043 S4 — the ADR-0016 cross-package
// rule keeps runtime and designer changes in separate PRs). These tests
// assert designer's OWN projection shape, not the runtime round-trip.
//
// Run via `node --test tests/designer/test-session-handoff.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  computeDesignerProjection,
  mapArchiveGate,
  parseArgs,
} from '../../plugins/designer/scripts/session-handoff.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const STATE = resolve(REPO_ROOT, 'plugins/designer/scripts/state.mjs');
const BASELINE_HEAD = '1111111111111111111111111111111111111111';
const MOVED_HEAD = '2222222222222222222222222222222222222222';

function createWorkflow(repoRoot, branch) {
  return execFileSync(
    'node',
    [
      STATE, 'create',
      '--repo-root', repoRoot,
      '--verb', 'compose', '--host', 'claude', '--persona', 'designer',
      '--git-baseline-branch', branch, '--git-baseline-head', BASELINE_HEAD,
      '--status-digest', 'deadbeef',
      '--profile', 'code', '--original-request', 'session-handoff test',
      '--current-phase', 'phase-0-bootstrap', '--next-action', 'Run compose skill',
    ],
    { encoding: 'utf8' },
  ).trim();
}

function setTerminal(workflowPath) {
  execFileSync(
    'node',
    [
      STATE, 'set-terminal',
      '--workflow-path', workflowPath, '--host', 'claude',
      '--terminal-phase', 'summary-complete', '--terminal-marker', 'true',
      '--next-action', 'Critique the composed artifact', '--event', 'updated',
    ],
    { encoding: 'utf8' },
  );
}

describe('designer session handoff projection (ADR-0031)', () => {
  it('maps the pure evaluateStopArchive verdict to a generic archive_gate', () => {
    strictEqual(mapArchiveGate({ shouldArchive: true, gateFailures: [] }), 'ready_to_archive');
    strictEqual(mapArchiveGate({ shouldArchive: false, gateFailures: ['terminal_marker', 'head_moved'] }), 'not_terminal');
    strictEqual(mapArchiveGate({ shouldArchive: false, gateFailures: ['head_moved'] }), 'blocked');
    strictEqual(mapArchiveGate({ shouldArchive: false, gateFailures: ['no_active_children'] }), 'blocked');
  });

  it('reports no active branch context on detached HEAD and does not auto-fresh', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eng-handoff-detached-'));
    const result = await computeDesignerProjection({ repoRoot: root, branch: null });
    strictEqual(result.status, 'no_active_branch_context');
    strictEqual(result.projection, null);
  });

  it('reports no active workflow when the branch has none', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eng-handoff-none-'));
    const result = await computeDesignerProjection({ repoRoot: root, branch: 'feat/x' });
    strictEqual(result.status, 'no_active_workflow');
    strictEqual(result.projection, null);
  });

  it('computes a complete bounded projection for an active workflow (not_terminal)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eng-handoff-ok-'));
    createWorkflow(root, 'feat/x');
    const result = await computeDesignerProjection({
      repoRoot: root, branch: 'feat/x',
      headSha: MOVED_HEAD, headSubject: 'feat: x', routing: '/designer:resume',
    });
    strictEqual(result.status, 'ok');
    strictEqual(result.projection.workflow_kind, 'designer');
    strictEqual(result.projection.phase, 'phase-0-bootstrap');
    strictEqual(result.projection.next_action, 'Run compose skill');
    strictEqual(result.projection.archive_gate, 'not_terminal'); // no terminal_marker yet
    strictEqual(result.projection.routing_recommendation, '/designer:resume');
    ok(result.projection.workflow_path.startsWith('.agentic-plugins/'));
    for (const field of ['workflow_id', 'workflow_path', 'phase', 'next_action', 'routing_recommendation']) {
      ok(result.projection[field] && result.projection[field].length > 0, `${field} must be non-empty`);
    }
  });

  it('derives ready_to_archive vs blocked from the real terminal gate (head moved or not)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eng-handoff-terminal-'));
    const path = createWorkflow(root, 'feat/y');
    setTerminal(path);
    const ready = await computeDesignerProjection({
      repoRoot: root, branch: 'feat/y', headSha: MOVED_HEAD, headSubject: 'feat: y',
    });
    strictEqual(ready.projection.archive_gate, 'ready_to_archive');
    const blocked = await computeDesignerProjection({
      repoRoot: root, branch: 'feat/y', headSha: BASELINE_HEAD, headSubject: 'feat: y',
    });
    strictEqual(blocked.projection.archive_gate, 'blocked'); // terminal-marked but HEAD did not move
  });

  it('emits the designer projection shape (runtime-seam acceptance deferred to a runtime PR)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsg-handoff-xcheck-'));
    createWorkflow(root, 'feat/z');
    const { projection } = await computeDesignerProjection({
      repoRoot: root, branch: 'feat/z', headSha: MOVED_HEAD, headSubject: 'feat: z',
    });
    ok(projection);
    strictEqual(projection.workflow_kind, 'designer',
      'designer must identify its own workflow_kind — the runtime seam enum extension is a deferred runtime PR');
    strictEqual(projection.archive_gate, 'not_terminal');
    ok(projection.workflow_path.includes('.agentic-plugins/state/designer/workflows/'),
      `repo-relative pointer must use the designer canonical home: ${projection.workflow_path}`);
  });

  it('treats whitespace-only routing as absent and falls back to the default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsg-handoff-ws-'));
    createWorkflow(root, 'feat/ws');
    const result = await computeDesignerProjection({
      repoRoot: root, branch: 'feat/ws', headSha: MOVED_HEAD, headSubject: 'feat: ws', routing: '   ',
    });
    strictEqual(result.projection.routing_recommendation, '/designer:resume');
  });

  it('always returns a routing recommendation, even with no projection (ADR-0031 input (c))', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eng-handoff-routing-'));
    const none = await computeDesignerProjection({ repoRoot: root, branch: 'feat/none', routing: '/orchestrator:next' });
    strictEqual(none.status, 'no_active_workflow');
    strictEqual(none.projection, null);
    strictEqual(none.routing, '/orchestrator:next'); // available standalone for the seam
    const detached = await computeDesignerProjection({ repoRoot: root, branch: null });
    strictEqual(detached.status, 'no_active_branch_context');
    strictEqual(detached.routing, '/designer:resume');
  });

  it('maps a terminal workflow to blocked when the git HEAD cannot be probed (null head)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'eng-handoff-nullprobe-'));
    const path = createWorkflow(root, 'feat/np');
    setTerminal(path);
    // headSha omitted -> probeHead runs against a non-git temp dir -> null sha ->
    // head_moved gate fails (never a false ready) -> blocked.
    const result = await computeDesignerProjection({ repoRoot: root, branch: 'feat/np' });
    strictEqual(result.projection.archive_gate, 'blocked');
  });

  it('parses CLI args', () => {
    const options = parseArgs(['project', '--repo-root', '/r', '--branch', 'b', '--routing', '/designer:resume']);
    strictEqual(options.command, 'project');
    strictEqual(options.repoRoot, '/r');
    strictEqual(options.branch, 'b');
    strictEqual(options.routing, '/designer:resume');
  });
});
