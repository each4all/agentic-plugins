// ADR-0031 — persona session-handoff projection tests, one suite for every
// persona the pipeline generates scripts/session-handoff.mjs into (ADR-0066
// Decision 5).
//
// Verifies that each persona computes its OWN bounded projection (fail-closed).
//
// Runtime-seam status: ADR-0043 S2 widened plugins/runtime's
// normalizeProjection enum to all four personas, so persona projections are
// seam-accepted on a current runtime; the personas' sidecar/footer plumbing
// landed with ADR-0043 S3/S4 (its suites are test-handoff-sidecar /
// test-footer-activation / test-handoff-backstop). These tests assert each
// persona's OWN projection shape, not the runtime round-trip.
//
// Run via `node --test tests/persona-pipeline/test-session-handoff.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { personasFor, personaInfo } from './_personas.mjs';

const BASELINE_HEAD = '1111111111111111111111111111111111111111';
const MOVED_HEAD = '2222222222222222222222222222222222222222';

for (const persona of personasFor('scripts/session-handoff.mjs')) {
  const P = personaInfo(persona);
  const STATE = P.path('scripts/state.mjs');
  const RESUME = `${P.commandPrefix}resume`;
  const {
    computeProjection,
    computeProjectionForPath,
    mapArchiveGate,
    parseArgs,
  } = await import(pathToFileURL(P.path('scripts/session-handoff.mjs')).href);

  function createWorkflow(repoRoot, branch) {
    return execFileSync(
      'node',
      [
        STATE, 'create',
        '--repo-root', repoRoot,
        '--verb', 'compose', '--host', 'claude', '--persona', persona,
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
      {
        encoding: 'utf8',
        // The CLI set-terminal now fires the ADR-0043 S3/S4 sidecar (footer
        // included). These tests assert PROJECTION logic only — pin discovery
        // at a nonexistent root so the render fail-closes identically on every
        // machine (a host plugin cache must not make this suite env-dependent).
        env: { ...process.env, AGENTIC_RUNTIME_ROOT: join(tmpdir(), 'no-such-runtime') },
      },
    );
  }

  describe(`${persona}: session handoff projection (ADR-0031)`, () => {
    it('maps the pure evaluateStopArchive verdict to a generic archive_gate', () => {
      strictEqual(mapArchiveGate({ shouldArchive: true, gateFailures: [] }), 'ready_to_archive');
      strictEqual(mapArchiveGate({ shouldArchive: false, gateFailures: ['terminal_marker', 'head_moved'] }), 'not_terminal');
      strictEqual(mapArchiveGate({ shouldArchive: false, gateFailures: ['head_moved'] }), 'blocked');
      strictEqual(mapArchiveGate({ shouldArchive: false, gateFailures: ['no_active_children'] }), 'blocked');
    });

    it('reports no active branch context on detached HEAD and does not auto-fresh', async () => {
      const root = await mkdtemp(join(tmpdir(), `${persona}-handoff-detached-`));
      const result = await computeProjection({ repoRoot: root, branch: null });
      strictEqual(result.status, 'no_active_branch_context');
      strictEqual(result.projection, null);
    });

    it('reports no active workflow when the branch has none', async () => {
      const root = await mkdtemp(join(tmpdir(), `${persona}-handoff-none-`));
      const result = await computeProjection({ repoRoot: root, branch: 'feat/x' });
      strictEqual(result.status, 'no_active_workflow');
      strictEqual(result.projection, null);
    });

    it('computes a complete bounded projection for an active workflow (not_terminal)', async () => {
      const root = await mkdtemp(join(tmpdir(), `${persona}-handoff-ok-`));
      createWorkflow(root, 'feat/x');
      const result = await computeProjection({
        repoRoot: root, branch: 'feat/x',
        headSha: MOVED_HEAD, headSubject: 'feat: x', routing: RESUME,
      });
      strictEqual(result.status, 'ok');
      strictEqual(result.projection.workflow_kind, persona);
      strictEqual(result.projection.phase, 'phase-0-bootstrap');
      strictEqual(result.projection.next_action, 'Run compose skill');
      strictEqual(result.projection.archive_gate, 'not_terminal'); // no terminal_marker yet
      strictEqual(result.projection.routing_recommendation, RESUME);
      ok(result.projection.workflow_path.startsWith('.agentic-plugins/'));
      for (const field of ['workflow_id', 'workflow_path', 'phase', 'next_action', 'routing_recommendation']) {
        ok(result.projection[field] && result.projection[field].length > 0, `${field} must be non-empty`);
      }
    });

    it('derives ready_to_archive vs blocked from the real terminal gate (head moved or not)', async () => {
      const root = await mkdtemp(join(tmpdir(), `${persona}-handoff-terminal-`));
      const path = createWorkflow(root, 'feat/y');
      setTerminal(path);
      const ready = await computeProjection({
        repoRoot: root, branch: 'feat/y', headSha: MOVED_HEAD, headSubject: 'feat: y',
      });
      strictEqual(ready.projection.archive_gate, 'ready_to_archive');
      const blocked = await computeProjection({
        repoRoot: root, branch: 'feat/y', headSha: BASELINE_HEAD, headSubject: 'feat: y',
      });
      strictEqual(blocked.projection.archive_gate, 'blocked'); // terminal-marked but HEAD did not move
    });

    it('emits the persona projection shape (seam-accepted since the ADR-0043 S2 enum expansion)', async () => {
      const root = await mkdtemp(join(tmpdir(), `${persona}-handoff-xcheck-`));
      createWorkflow(root, 'feat/z');
      const { projection } = await computeProjection({
        repoRoot: root, branch: 'feat/z', headSha: MOVED_HEAD, headSubject: 'feat: z',
      });
      ok(projection);
      strictEqual(projection.workflow_kind, persona,
        `${persona} must identify its own workflow_kind — the runtime seam models it since the ADR-0043 S2 enum expansion`);
      strictEqual(projection.archive_gate, 'not_terminal');
      // Today's literal identity: the canonical home is .agentic-plugins/state/<name>.
      ok(projection.workflow_path.includes(`${P.workflowDirRel}/`),
        `repo-relative pointer must use the ${persona} canonical home: ${projection.workflow_path}`);
    });

    it('treats whitespace-only routing as absent and falls back to the default', async () => {
      const root = await mkdtemp(join(tmpdir(), `${persona}-handoff-ws-`));
      createWorkflow(root, 'feat/ws');
      const result = await computeProjection({
        repoRoot: root, branch: 'feat/ws', headSha: MOVED_HEAD, headSubject: 'feat: ws', routing: '   ',
      });
      strictEqual(result.projection.routing_recommendation, RESUME);
    });

    it('always returns a routing recommendation, even with no projection (ADR-0031 input (c))', async () => {
      const root = await mkdtemp(join(tmpdir(), `${persona}-handoff-routing-`));
      const none = await computeProjection({ repoRoot: root, branch: 'feat/none', routing: '/orchestrator:next' });
      strictEqual(none.status, 'no_active_workflow');
      strictEqual(none.projection, null);
      strictEqual(none.routing, '/orchestrator:next'); // available standalone for the seam
      const detached = await computeProjection({ repoRoot: root, branch: null });
      strictEqual(detached.status, 'no_active_branch_context');
      strictEqual(detached.routing, RESUME);
    });

    it('maps a terminal workflow to blocked when the git HEAD cannot be probed (null head)', async () => {
      const root = await mkdtemp(join(tmpdir(), `${persona}-handoff-nullprobe-`));
      const path = createWorkflow(root, 'feat/np');
      setTerminal(path);
      // headSha omitted -> probeHead runs against a non-git temp dir -> null sha ->
      // head_moved gate fails (never a false ready) -> blocked.
      const result = await computeProjection({ repoRoot: root, branch: 'feat/np' });
      strictEqual(result.projection.archive_gate, 'blocked');
    });

    it('parses CLI args', () => {
      const options = parseArgs(['project', '--repo-root', '/r', '--branch', 'b', '--routing', RESUME]);
      strictEqual(options.command, 'project');
      strictEqual(options.repoRoot, '/r');
      strictEqual(options.branch, 'b');
      strictEqual(options.routing, RESUME);
    });

    // ADR-0043 S3/S4 — the path-targeted variant the activation sidecar uses,
    // and the gate_failures return channel the completion-flag mapping consumes.
    describe('computeProjectionForPath (ADR-0043 §2 path-targeted baseline)', () => {
      it('projects the exact workflow at the given path', async () => {
        const root = await mkdtemp(join(tmpdir(), `${persona}-forpath-ok-`));
        const pathA = createWorkflow(root, 'feat/a');
        createWorkflow(root, 'feat/b');
        const result = await computeProjectionForPath({
          repoRoot: root, workflowPath: pathA, headSha: MOVED_HEAD, headSubject: 'feat: a',
        });
        strictEqual(result.status, 'ok');
        strictEqual(result.projection.workflow_kind, persona);
        ok(pathA.endsWith(`${result.projection.workflow_id}.md`), 'projects the path-targeted workflow');
      });

      it('is fail-closed on a missing path and reports no_active_workflow on an empty one', async () => {
        const root = await mkdtemp(join(tmpdir(), `${persona}-forpath-none-`));
        const missing = await computeProjectionForPath({
          repoRoot: root, workflowPath: join(root, 'nope.md'),
        });
        strictEqual(missing.status, 'fail_closed');
        strictEqual(missing.projection, null);
        const empty = await computeProjectionForPath({ repoRoot: root });
        strictEqual(empty.status, 'no_active_workflow');
        strictEqual(empty.routing, RESUME, 'routing survives with no projection');
      });

      it('threads gate_failures on the return value, never inside the bounded projection', async () => {
        const root = await mkdtemp(join(tmpdir(), `${persona}-forpath-gates-`));
        const path = createWorkflow(root, 'feat/g');
        setTerminal(path);
        // Terminal-marked + HEAD unmoved → blocked with head_moved as the only
        // failed gate — the evidence the publish-needed mapping keys on.
        const blocked = await computeProjectionForPath({
          repoRoot: root, workflowPath: path, headSha: BASELINE_HEAD, headSubject: 'feat: g',
        });
        strictEqual(blocked.projection.archive_gate, 'blocked');
        strictEqual(JSON.stringify(blocked.gate_failures), JSON.stringify(['head_moved']));
        ok(!('gate_failures' in blocked.projection),
          'the frozen 8-field projection schema must not carry gate_failures');
        const ready = await computeProjectionForPath({
          repoRoot: root, workflowPath: path, headSha: MOVED_HEAD, headSubject: 'feat: g',
        });
        strictEqual(ready.projection.archive_gate, 'ready_to_archive');
        strictEqual(ready.gate_failures.length, 0);
      });
    });
  });
}
