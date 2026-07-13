// ADR-0039 — engineer completion-footer activation tests.
//
// Proves the terminal path now CODE-SYNTHESIZES the runtime footer on top of the
// ADR-0031 projection, honoring the binding constraints:
//   - stderr / file only, NEVER stdout (the completion scripts' stdout is a
//     load-bearing machine channel)
//   - projection → footer completion flags render CONCRETE elements 2/3/4
//   - fail-closed silent on a missing/too-old runtime or broken projection
//     (workflow still completes; no footer; no throw)
//   - at most once per terminal transition (the Stop-hook backstop does not
//     double-render what the primary already rendered)
//   - SessionStart reconciliation suppresses the false "missed-footer" nudge
//
// Host-free + deterministic: throwaway git repos; the runtime is pinned to the
// repo's own plugins/runtime via AGENTIC_RUNTIME_ROOT so discovery never depends
// on the host's plugin cache. Run via
// `node --test tests/engineer/test-footer-activation.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, match, doesNotReject } from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  emitTerminalHandoffSidecar,
  mapCompletionFlags,
  pendingHandoffReinjectionLine,
} from '../../plugins/engineer/scripts/session-handoff.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const STATE = resolve(REPO_ROOT, 'plugins/engineer/scripts/state.mjs');
const RUNTIME_ROOT = resolve(REPO_ROOT, 'plugins/runtime'); // pin discovery deterministically
const FOOTER_HEADER = 'Runtime completion footer (advisory)';
const BASELINE_HEAD = '1111111111111111111111111111111111111111';

function initRepo(root) {
  execFileSync('git', ['init', '-q', '-b', 'feat/x'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'footer-e2e'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'footer-e2e@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'baseline', '--no-verify'], { cwd: root });
}

function createWorkflow(root, branch = 'feat/x') {
  return execFileSync(
    'node',
    [
      STATE, 'create', '--repo-root', root,
      '--verb', 'compose', '--host', 'claude', '--persona', 'engineer',
      '--git-baseline-branch', branch, '--git-baseline-head', BASELINE_HEAD,
      '--status-digest', 'deadbeef',
      '--profile', 'backend', '--original-request', 'footer activation test',
      '--current-phase', 'phase-0-bootstrap', '--next-action', 'Run compose skill',
    ],
    { encoding: 'utf8' },
  ).trim();
}

// Run the CLI set-terminal (the REAL primary path) with the runtime pinned.
function cliSetTerminal(root, workflowPath, nextAction) {
  return spawnSync(
    'node',
    [
      STATE, 'set-terminal', '--workflow-path', workflowPath, '--host', 'claude',
      '--terminal-phase', 'summary-complete', '--terminal-marker', 'true',
      '--next-action', nextAction, '--event', 'updated',
    ],
    { encoding: 'utf8', cwd: root, env: { ...process.env, AGENTIC_RUNTIME_ROOT: RUNTIME_ROOT } },
  );
}

// Capture process.stderr.write around an async fn (the direct-call channel).
async function captureStderr(fn) {
  const chunks = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (s) => { chunks.push(String(s)); return true; };
  try {
    const value = await fn();
    return { value, stderr: chunks.join('') };
  } finally {
    process.stderr.write = orig;
  }
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

// Build a STUB runtime whose footer.mjs emits a chosen body — used to force the
// degraded (projection_error) path deterministically, since the real footer.mjs
// accepts the valid projection the sidecar writes.
async function writeStubRuntime(root, footerMjs, { version = '0.70.0' } = {}) {
  await mkdir(join(root, '.claude-plugin'), { recursive: true });
  await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'runtime', version }));
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'scripts', 'footer.mjs'), footerMjs);
  return root;
}

// A stub footer that ALWAYS reports a rejected projection (projection_error set,
// no session_handoff) but still exits 0 — the exact footer.mjs degraded shape.
const DEGRADED_FOOTER = `#!/usr/bin/env node
const argv = process.argv.slice(2);
if (argv.includes('json')) {
  process.stdout.write(JSON.stringify({ command: 'render', projection_error: 'stub: projection rejected' }));
} else {
  process.stdout.write('Runtime completion footer (advisory)\\nworkflow projection rejected (degraded to context-state only): stub\\n');
}
process.exit(0);
`;

describe('engineer completion-footer activation (ADR-0039)', () => {
  it('CLI set-terminal renders the footer on STDERR, never stdout (machine channel intact)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'footer-stderr-'));
    initRepo(root);
    const wf = createWorkflow(root);
    const res = cliSetTerminal(root, wf, 'Critique the composed artifact');

    strictEqual(res.status, 0, `set-terminal exited non-zero: ${res.stderr}`);
    // stdout stays byte-for-byte path-only — the footer must not leak to it.
    strictEqual(res.stdout, `${wf}\n`, 'stdout must remain path-only');
    ok(!res.stdout.includes(FOOTER_HEADER), 'footer must NOT appear on stdout');
    ok(res.stderr.includes(FOOTER_HEADER), 'footer header must appear on stderr');
  });

  it('promotes elements 2/3/4/7 to CONCRETE (completion state + recommended next work + continue-vs-fresh)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'footer-elements-'));
    initRepo(root);
    const wf = createWorkflow(root);
    const res = cliSetTerminal(root, wf, 'Critique the composed artifact');

    strictEqual(res.status, 0, res.stderr);
    // element 3/4: the concrete next action flows into recommended-next-work.
    ok(
      res.stderr.includes('recommended next work: Critique the composed artifact'),
      `recommended next work must be concrete; got:\n${res.stderr}`,
    );
    // completion state is one of the mapped values (never the generic default).
    match(res.stderr, /completion state: (next-work-available|blocked)/);
    // element 7/8: the continue-vs-fresh session handoff renders.
    ok(res.stderr.includes('session handoff (continue-vs-fresh)'), 'session handoff must render');
    // host localization (claude) — commands are /-prefixed.
    match(res.stderr, /\/(engineer|runtime):/);
  });

  it('is idempotent: the Stop-hook backstop does NOT re-render what the primary rendered', async () => {
    const root = await mkdtemp(join(tmpdir(), 'footer-idem-'));
    initRepo(root);
    const wf = createWorkflow(root);
    const projectionFile = join(root, '.agentic-plugins/state/engineer/last-session-handoff.json');
    const markerFile = `${projectionFile}.footer-rendered`;

    // PRIMARY (marker absent → renders + writes marker).
    const primary = await captureStderr(() =>
      emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: wf, projectionFile, host: 'claude' }));
    // (set-terminal was not run, so the workflow is not terminal → projection
    // still valid; the sidecar computes + renders regardless of terminal state.)
    strictEqual(primary.value.emitted, true);
    strictEqual(primary.value.footerRendered, true, 'primary must render the footer');
    ok(primary.stderr.includes(FOOTER_HEADER), 'primary emits the footer to stderr');
    ok(await exists(markerFile), 'primary writes the idempotency marker');

    // BACKSTOP (marker present → must NOT re-render).
    const backstop = await captureStderr(() =>
      emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: wf, projectionFile, host: 'claude' }));
    strictEqual(backstop.value.emitted, true);
    strictEqual(backstop.value.footerRendered, true, 'reports rendered (idempotent), from the marker');
    ok(!backstop.stderr.includes(FOOTER_HEADER), 'backstop must NOT emit a second footer');
  });

  it('fail-closed on a MISSING/too-old runtime: no footer, still emitted, no throw', async () => {
    const root = await mkdtemp(join(tmpdir(), 'footer-noruntime-'));
    initRepo(root);
    const wf = createWorkflow(root);
    const projectionFile = join(root, 'proj.json');

    // Point AGENTIC_RUNTIME_ROOT at an absolute path with no scripts/footer.mjs
    // → discovery fail-closes → no footer. Restore env afterwards.
    const saved = process.env.AGENTIC_RUNTIME_ROOT;
    process.env.AGENTIC_RUNTIME_ROOT = join(root, 'no-such-runtime');
    try {
      const { value, stderr } = await captureStderr(() =>
        emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: wf, projectionFile, host: 'claude' }));
      strictEqual(value.emitted, true, 'projection still written (guaranteed channel)');
      strictEqual(value.footerRendered, false, 'no footer when runtime is missing');
      ok(!stderr.includes(FOOTER_HEADER), 'no footer text on a fail-closed render');
      ok(await exists(projectionFile), 'the projection file is still written');
    } finally {
      if (saved === undefined) delete process.env.AGENTIC_RUNTIME_ROOT;
      else process.env.AGENTIC_RUNTIME_ROOT = saved;
    }
  });

  it('fail-closed on a broken projection: no footer, no file, no throw', async () => {
    const root = await mkdtemp(join(tmpdir(), 'footer-brokenproj-'));
    const projectionFile = join(root, 'proj.json');
    // workflowPath does not resolve → non-ok projection status.
    const { value, stderr } = await captureStderr(() =>
      emitTerminalHandoffSidecar({
        repoRoot: root, workflowPath: join(root, 'nope.md'), projectionFile, host: 'claude',
      }));
    strictEqual(value.emitted, false);
    ok(!stderr.includes(FOOTER_HEADER), 'no footer when the projection is not ok');
    strictEqual(await exists(projectionFile), false, 'no projection file on a non-ok status');
    await doesNotReject(() =>
      emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: join(root, 'nope.md'), projectionFile }));
  });

  it('SessionStart reconciliation: a rendered footer suppresses the nudge; a missed footer keeps it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'footer-reconcile-'));
    initRepo(root);
    const wf = createWorkflow(root);
    const projectionFile = join(root, '.agentic-plugins/state/engineer/last-session-handoff.json');

    // Rendered: primary emits + marks → pending line is suppressed (null).
    await emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: wf, projectionFile, host: 'claude' });
    const afterRender = await pendingHandoffReinjectionLine(root);
    ok(afterRender, 'a pending handoff exists');
    strictEqual(afterRender.line, null, 'a rendered footer suppresses the missed-footer nudge');
    strictEqual(afterRender.footerRendered, true);

    // Missed: no marker (fresh projection, runtime forced missing) → nudge stays.
    const root2 = await mkdtemp(join(tmpdir(), 'footer-reconcile-missed-'));
    initRepo(root2);
    const wf2 = createWorkflow(root2);
    const projectionFile2 = join(root2, '.agentic-plugins/state/engineer/last-session-handoff.json');
    const saved = process.env.AGENTIC_RUNTIME_ROOT;
    process.env.AGENTIC_RUNTIME_ROOT = join(root2, 'no-such-runtime');
    try {
      await emitTerminalHandoffSidecar({ repoRoot: root2, workflowPath: wf2, projectionFile: projectionFile2, host: 'claude' });
    } finally {
      if (saved === undefined) delete process.env.AGENTIC_RUNTIME_ROOT;
      else process.env.AGENTIC_RUNTIME_ROOT = saved;
    }
    const afterMiss = await pendingHandoffReinjectionLine(root2);
    ok(afterMiss, 'a pending handoff exists');
    ok(afterMiss.line && afterMiss.line.includes('[engineer-handoff-pending]'), 'a missed footer keeps the nudge');
  });

  it('fail-closed on a DEGRADED render (footer.mjs reports projection_error): no mark, nudge fires (Codex Plan-verify BLOCKER 1)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'footer-degraded-'));
    initRepo(root);
    const wf = createWorkflow(root);
    const projectionFile = join(root, '.agentic-plugins/state/engineer/last-session-handoff.json');
    const markerFile = `${projectionFile}.footer-rendered`;
    // Point discovery at a stub runtime whose footer.mjs exits 0 but reports a
    // projection_error (no session_handoff) — the JSON validation must reject it.
    const stub = await writeStubRuntime(await mkdtemp(join(tmpdir(), 'stub-rt-')), DEGRADED_FOOTER);
    const saved = process.env.AGENTIC_RUNTIME_ROOT;
    process.env.AGENTIC_RUNTIME_ROOT = stub;
    try {
      const { value, stderr } = await captureStderr(() =>
        emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: wf, projectionFile, host: 'claude' }));
      strictEqual(value.emitted, true, 'projection still written');
      strictEqual(value.footerRendered, false, 'a projection_error render must NOT count as rendered');
      ok(!stderr.includes(FOOTER_HEADER), 'the degraded footer text must not be emitted');
      strictEqual(await exists(markerFile), false, 'no marker (claim released) on a degraded render');
    } finally {
      if (saved === undefined) delete process.env.AGENTIC_RUNTIME_ROOT;
      else process.env.AGENTIC_RUNTIME_ROOT = saved;
    }
    // The nudge must still fire (the footer was NOT delivered).
    const pending = await pendingHandoffReinjectionLine(root);
    ok(pending && pending.line && pending.line.includes('[engineer-handoff-pending]'),
      'a degraded render keeps the SessionStart nudge as a backstop');
  });

  // S9 completion-output contract — the sidecar's completion flags must meet
  // the minimum-content floor: the reason names the current phase and, when
  // blocked, the SPECIFIC failed gates; blocked completions also pass a
  // gate-specific unblocking --completion-next-action.
  describe('completion-flag minimum content (completion-output contract)', () => {
    const projection = {
      workflow_kind: 'engineer',
      workflow_id: 'compose-20260712T000000Z-abc123',
      workflow_path: '.agentic-plugins/state/engineer/workflows/compose-20260712T000000Z-abc123.md',
      phase: 'summary-complete',
      next_action: 'Critique the composed artifact',
      archive_gate: 'ready_to_archive',
      routing_recommendation: '/engineer:resume',
    };

    it('names the phase on every archive-gate state', () => {
      const ready = mapCompletionFlags({ ...projection, archive_gate: 'ready_to_archive' });
      ok(ready.reason.includes('at phase summary-complete'), ready.reason);
      strictEqual(ready.state, 'next-work-available');
      strictEqual(ready.completionNextAction, undefined, 'no unblocking action when not blocked');

      const notTerminal = mapCompletionFlags({ ...projection, archive_gate: 'not_terminal' }, ['terminal_marker']);
      ok(notTerminal.reason.includes('at phase summary-complete'), notTerminal.reason);
      strictEqual(notTerminal.completionNextAction, undefined);
    });

    it('names the specific failed gates and derives the unblocking action when blocked', () => {
      const flags = mapCompletionFlags(
        { ...projection, archive_gate: 'blocked' },
        ['head_moved', 'no_active_children'],
      );
      strictEqual(flags.state, 'blocked');
      ok(flags.reason.includes('archive gate(s) unmet: head_moved, no_active_children'), flags.reason);
      ok(flags.completionNextAction.includes('Commit the completed work so HEAD moves'), flags.completionNextAction);
      ok(flags.completionNextAction.includes('Settle or archive the active child workflows'), flags.completionNextAction);
      ok(!/[\r\n]/.test(flags.reason), 'reason must stay single-line');
      ok(!/[\r\n]/.test(flags.completionNextAction), 'next action must stay single-line');
    });

    it('always passes an explicit unblocking action when blocked — unknown gates get the sidecar fallback', () => {
      // Empty verdict (hand-invoked) and a future gate token both fall back to
      // a sidecar-authored instruction: the runtime's no-input default would
      // render with a generic-fallback marker (contract §3.2 marker-free floor).
      const empty = mapCompletionFlags({ ...projection, archive_gate: 'blocked' }, []);
      ok(empty.reason.includes('archive gate(s) unmet: unknown'), empty.reason);
      strictEqual(
        empty.completionNextAction,
        'Resolve the unmet archive gate(s): unknown (see the workflow phase notes).',
      );

      const future = mapCompletionFlags({ ...projection, archive_gate: 'blocked' }, ['future_gate']);
      strictEqual(
        future.completionNextAction,
        'Resolve the unmet archive gate(s): future_gate (see the workflow phase notes).',
      );
    });

    it('E2E: a blocked terminal (HEAD unmoved) renders gate names and stays generic-marker-free', async () => {
      const root = await mkdtemp(join(tmpdir(), 'footer-blocked-'));
      initRepo(root);
      // Baseline the workflow at the REAL current HEAD so the head_moved gate
      // fails at set-terminal time (no commit in between) → archive_gate=blocked.
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
      const wf = execFileSync(
        'node',
        [
          STATE, 'create', '--repo-root', root,
          '--verb', 'compose', '--host', 'claude', '--persona', 'engineer',
          '--git-baseline-branch', 'feat/x', '--git-baseline-head', head,
          '--status-digest', 'deadbeef',
          '--profile', 'backend', '--original-request', 'blocked footer test',
          '--current-phase', 'phase-0-bootstrap', '--next-action', 'Run compose skill',
        ],
        { encoding: 'utf8' },
      ).trim();
      const res = cliSetTerminal(root, wf, 'Critique the composed artifact');

      strictEqual(res.status, 0, res.stderr);
      ok(res.stderr.includes('completion state: blocked'), res.stderr);
      ok(
        res.stderr.includes('archive gate(s) unmet: head_moved'),
        `reason must name the failed gate; got:\n${res.stderr}`,
      );
      ok(
        res.stderr.includes('completion next action: Commit the completed work so HEAD moves'),
        `unblocking action must render; got:\n${res.stderr}`,
      );
      // The sidecar passes every completion flag explicitly — a persona terminal
      // footer must never surface a runtime generic-fallback marker.
      ok(!res.stderr.includes('[generic fallback]'), 'sidecar footers must be generic-marker-free');
    });

    it('E2E: the archive-ready terminal reason names the terminal phase', async () => {
      const root = await mkdtemp(join(tmpdir(), 'footer-ready-'));
      initRepo(root);
      const wf = createWorkflow(root);
      const res = cliSetTerminal(root, wf, 'Critique the composed artifact');
      strictEqual(res.status, 0, res.stderr);
      ok(
        res.stderr.includes('completion reason: Workflow at phase summary-complete is terminal and archive-ready'),
        `reason must name the phase; got:\n${res.stderr}`,
      );
      ok(!res.stderr.includes('[generic fallback]'), 'sidecar footers must be generic-marker-free');
    });
  });

  it("a 'claimed' (in-progress/crashed) marker does not suppress the nudge — only 'rendered' does (Codex Plan-verify BLOCKER 2)", async () => {
    const root = await mkdtemp(join(tmpdir(), 'footer-claimed-'));
    initRepo(root);
    const wf = createWorkflow(root);
    const projectionFile = join(root, '.agentic-plugins/state/engineer/last-session-handoff.json');
    const markerFile = `${projectionFile}.footer-rendered`;
    // Emit a projection (no runtime → no render, no marker), then simulate a
    // crashed/in-progress claim by writing a 'claimed' marker for this workflow.
    const saved = process.env.AGENTIC_RUNTIME_ROOT;
    process.env.AGENTIC_RUNTIME_ROOT = join(root, 'no-such-runtime');
    try {
      await emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: wf, projectionFile, host: 'claude' });
    } finally {
      if (saved === undefined) delete process.env.AGENTIC_RUNTIME_ROOT;
      else process.env.AGENTIC_RUNTIME_ROOT = saved;
    }
    const projection = JSON.parse(await readFile(projectionFile, 'utf8'));
    await writeFile(markerFile, `${JSON.stringify({ workflow_id: projection.workflow_id, status: 'claimed', at: '2026-01-01T00:00:00Z' })}\n`, 'utf8');
    const pending = await pendingHandoffReinjectionLine(root);
    ok(pending && pending.line && pending.line.includes('[engineer-handoff-pending]'),
      "a bare 'claimed' marker must NOT suppress the nudge");
  });
});
