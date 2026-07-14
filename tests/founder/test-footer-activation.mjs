// ADR-0043 S3 — founder completion-footer activation tests.
//
// Proves the founder terminal path CODE-SYNTHESIZES the runtime footer on top
// of the ADR-0031 projection, honoring the binding constraints:
//   - stderr / file only, NEVER stdout (the completion scripts' stdout is a
//     load-bearing machine channel)
//   - projection → footer completion flags render CONCRETE elements 2/3/4,
//     mapped from founder's OWN manually-published terminal semantics
//     (completion-output contract §2: only-head_moved-unmet → publish-needed)
//   - fail-closed silent on a missing/too-old runtime or broken projection
//     (workflow still completes; no footer; no throw)
//   - at most once per terminal transition (the Stop-hook backstop does not
//     double-render what the primary already rendered); the marker contract
//     (`<projection>.footer-rendered`, {workflow_id, status}) is pinned here
//   - SessionStart reconciliation suppresses the false "missed-footer" nudge
//
// Host-free + deterministic: throwaway git repos; the runtime is pinned to the
// repo's own plugins/runtime via AGENTIC_RUNTIME_ROOT so discovery never depends
// on the host's plugin cache. Run via
// `node --test tests/founder/test-footer-activation.mjs`.

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
} from '../../plugins/founder/scripts/session-handoff.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const STATE = resolve(REPO_ROOT, 'plugins/founder/scripts/state.mjs');
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

function createWorkflow(root, { branch = 'feat/x', baselineHead = BASELINE_HEAD } = {}) {
  return execFileSync(
    'node',
    [
      STATE, 'create', '--repo-root', root,
      '--verb', 'compose', '--host', 'claude', '--persona', 'founder',
      '--git-baseline-branch', branch, '--git-baseline-head', baselineHead,
      '--status-digest', 'deadbeef',
      '--profile', 'plan', '--original-request', 'footer activation test',
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
async function writeStubRuntime(root, footerMjs, { version = '0.80.0' } = {}) {
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

describe('founder completion-footer activation (ADR-0043 S3)', () => {
  it('CLI set-terminal renders the footer on STDERR, never stdout (machine channel intact)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ffooter-stderr-'));
    initRepo(root);
    const wf = createWorkflow(root);
    const res = cliSetTerminal(root, wf, 'Critique the composed planning artifact');

    strictEqual(res.status, 0, `set-terminal exited non-zero: ${res.stderr}`);
    // stdout stays byte-for-byte path-only — the footer must not leak to it.
    strictEqual(res.stdout, `${wf}\n`, 'stdout must remain path-only');
    ok(!res.stdout.includes(FOOTER_HEADER), 'footer must NOT appear on stdout');
    ok(res.stderr.includes(FOOTER_HEADER), 'footer header must appear on stderr');
  });

  it('promotes elements 2/3/4/7 to CONCRETE (completion state + recommended next work + continue-vs-fresh)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ffooter-elements-'));
    initRepo(root);
    const wf = createWorkflow(root);
    const res = cliSetTerminal(root, wf, 'Critique the composed planning artifact');

    strictEqual(res.status, 0, res.stderr);
    // element 3/4: the concrete next action flows into recommended-next-work.
    ok(
      res.stderr.includes('recommended next work: Critique the composed planning artifact'),
      `recommended next work must be concrete; got:\n${res.stderr}`,
    );
    // completion state is one of founder's mapped values (never the generic
    // default) — publish-needed is founder's manually-published mapping.
    match(res.stderr, /completion state: (next-work-available|publish-needed|blocked)/);
    // element 7/8: the continue-vs-fresh session handoff renders.
    ok(res.stderr.includes('session handoff (continue-vs-fresh)'), 'session handoff must render');
    // host localization (claude) — commands are /-prefixed.
    match(res.stderr, /\/(founder|runtime):/);
  });

  it('is idempotent: the Stop-hook backstop does NOT re-render what the primary rendered', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ffooter-idem-'));
    initRepo(root);
    const wf = createWorkflow(root);
    const projectionFile = join(root, '.agentic-plugins/state/founder/last-session-handoff.json');
    const markerFile = `${projectionFile}.footer-rendered`;

    // PRIMARY (marker absent → renders + writes marker).
    const primary = await captureStderr(() =>
      emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: wf, projectionFile, host: 'claude' }));
    strictEqual(primary.value.emitted, true);
    strictEqual(primary.value.footerRendered, true, 'primary must render the footer');
    ok(primary.stderr.includes(FOOTER_HEADER), 'primary emits the footer to stderr');
    ok(await exists(markerFile), 'primary writes the idempotency marker');
    // MARKER CONTRACT pin (ADR-0043 §2 documented cross-package contract):
    // sibling `<projection>.footer-rendered`, JSON {workflow_id, status:'rendered'}.
    const marker = JSON.parse(await readFile(markerFile, 'utf8'));
    const projection = JSON.parse(await readFile(projectionFile, 'utf8'));
    strictEqual(marker.workflow_id, projection.workflow_id, 'marker keys on the terminalized workflow_id');
    strictEqual(marker.status, 'rendered', "a completed render upgrades the marker to 'rendered'");
    // The attention sensor's transition anchor is load-bearing on this field
    // (ADR-0043 §3): the render moment must be a parseable ISO-8601 UTC stamp.
    ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(marker.at),
      `marker.at must be ISO-8601 UTC; got: ${marker.at}`);

    // BACKSTOP (marker present → must NOT re-render).
    const backstop = await captureStderr(() =>
      emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: wf, projectionFile, host: 'claude' }));
    strictEqual(backstop.value.emitted, true);
    strictEqual(backstop.value.footerRendered, true, 'reports rendered (idempotent), from the marker');
    ok(!backstop.stderr.includes(FOOTER_HEADER), 'backstop must NOT emit a second footer');
  });

  it('fail-closed on a MISSING/too-old runtime: no footer, still emitted, no throw', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ffooter-noruntime-'));
    initRepo(root);
    const wf = createWorkflow(root);
    const projectionFile = join(root, 'proj.json');

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
    const root = await mkdtemp(join(tmpdir(), 'ffooter-brokenproj-'));
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
    const root = await mkdtemp(join(tmpdir(), 'ffooter-reconcile-'));
    initRepo(root);
    const wf = createWorkflow(root);
    const projectionFile = join(root, '.agentic-plugins/state/founder/last-session-handoff.json');

    // Rendered: primary emits + marks → pending line is suppressed (null).
    await emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: wf, projectionFile, host: 'claude' });
    const afterRender = await pendingHandoffReinjectionLine(root);
    ok(afterRender, 'a pending handoff exists');
    strictEqual(afterRender.line, null, 'a rendered footer suppresses the missed-footer nudge');
    strictEqual(afterRender.footerRendered, true);

    // Missed: no marker (fresh projection, runtime forced missing) → nudge stays.
    const root2 = await mkdtemp(join(tmpdir(), 'ffooter-reconcile-missed-'));
    initRepo(root2);
    const wf2 = createWorkflow(root2);
    const projectionFile2 = join(root2, '.agentic-plugins/state/founder/last-session-handoff.json');
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
    ok(afterMiss.line && afterMiss.line.includes('[founder-handoff-pending]'), 'a missed footer keeps the nudge');
  });

  it('fail-closed on a DEGRADED render (footer.mjs reports projection_error): no mark, nudge fires', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ffooter-degraded-'));
    initRepo(root);
    const wf = createWorkflow(root);
    const projectionFile = join(root, '.agentic-plugins/state/founder/last-session-handoff.json');
    const markerFile = `${projectionFile}.footer-rendered`;
    // Point discovery at a stub runtime whose footer.mjs exits 0 but reports a
    // projection_error (no session_handoff) — the JSON validation must reject it.
    const stub = await writeStubRuntime(await mkdtemp(join(tmpdir(), 'fstub-rt-')), DEGRADED_FOOTER);
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
    ok(pending && pending.line && pending.line.includes('[founder-handoff-pending]'),
      'a degraded render keeps the SessionStart nudge as a backstop');
  });

  // Completion-output contract §2 — founder is a manually-published lifecycle:
  // the sidecar maps completion flags from founder's OWN terminal semantics
  // (only-head_moved-unmet → publish-needed), names the phase + failed gates,
  // and always passes the explicit next action on publish-needed/blocked.
  describe('completion-flag minimum content (manually-published mapping)', () => {
    const projection = {
      workflow_kind: 'founder',
      workflow_id: 'compose-20260713T000000Z-abc123',
      workflow_path: '.agentic-plugins/state/founder/workflows/compose-20260713T000000Z-abc123.md',
      phase: 'summary-complete',
      next_action: 'Save/commit the venture plan',
      archive_gate: 'ready_to_archive',
      routing_recommendation: '/founder:resume',
    };

    it('maps only-head_moved-unmet to publish-needed with the owner-publish next action', () => {
      const flags = mapCompletionFlags({ ...projection, archive_gate: 'blocked' }, ['head_moved']);
      strictEqual(flags.state, 'publish-needed');
      ok(flags.reason.includes('terminal phase summary-complete'), flags.reason);
      ok(flags.reason.includes('head_moved'), 'the reason names the single unmet gate token');
      ok(flags.reason.includes('git probe'), 'the reason must not overclaim a single cause (fail-closed collapse)');
      ok(flags.completionNextAction.includes('Save/commit the business deliverable'), flags.completionNextAction);
      ok(!/[\r\n]/.test(flags.reason), 'reason must stay single-line');
      ok(!/[\r\n]/.test(flags.completionNextAction), 'next action must stay single-line');
    });

    it('head_moved mixed with another gate stays blocked (genuinely blocking evidence)', () => {
      const flags = mapCompletionFlags(
        { ...projection, archive_gate: 'blocked' },
        ['head_moved', 'no_active_children'],
      );
      strictEqual(flags.state, 'blocked');
      ok(flags.reason.includes('archive gate(s) unmet: head_moved, no_active_children'), flags.reason);
      ok(flags.completionNextAction.includes('Save/commit the business deliverable'), flags.completionNextAction);
      ok(flags.completionNextAction.includes('child-completion entries'), flags.completionNextAction);
    });

    it('a non-head_moved gate alone is blocked, never publish-needed', () => {
      const flags = mapCompletionFlags({ ...projection, archive_gate: 'blocked' }, ['terminal_phase']);
      strictEqual(flags.state, 'blocked');
      ok(flags.completionNextAction.includes('archive-whitelisted terminal phase'), flags.completionNextAction);
    });

    it('names the phase on the non-blocked archive-gate states (no unblocking action)', () => {
      const ready = mapCompletionFlags({ ...projection, archive_gate: 'ready_to_archive' });
      ok(ready.reason.includes('at phase summary-complete'), ready.reason);
      strictEqual(ready.state, 'next-work-available');
      strictEqual(ready.completionNextAction, undefined, 'no unblocking action when not blocked');

      const notTerminal = mapCompletionFlags({ ...projection, archive_gate: 'not_terminal' }, ['terminal_marker']);
      ok(notTerminal.reason.includes('at phase summary-complete'), notTerminal.reason);
      strictEqual(notTerminal.state, 'next-work-available');
      strictEqual(notTerminal.completionNextAction, undefined);
    });

    it('always passes an explicit unblocking action when blocked — unknown gates get the sidecar fallback', () => {
      const empty = mapCompletionFlags({ ...projection, archive_gate: 'blocked' }, []);
      strictEqual(empty.state, 'blocked', 'no gate evidence → conservative blocked, never publish-needed');
      ok(empty.reason.includes('archive gate(s) unmet: unknown'), empty.reason);
      strictEqual(
        empty.completionNextAction,
        'Resolve the unmet archive gate(s): unknown (see the workflow phase notes).',
      );

      const future = mapCompletionFlags({ ...projection, archive_gate: 'blocked' }, ['future_gate']);
      strictEqual(future.state, 'blocked');
      strictEqual(
        future.completionNextAction,
        'Resolve the unmet archive gate(s): future_gate (see the workflow phase notes).',
      );
    });

    it('a known gate MIXED with an unknown one keeps both: specific action + fallback naming the unknown (Codex Plan-verify)', () => {
      const mixed = mapCompletionFlags(
        { ...projection, archive_gate: 'blocked' },
        ['head_moved', 'future_gate'],
      );
      strictEqual(mixed.state, 'blocked');
      ok(mixed.reason.includes('head_moved, future_gate'), mixed.reason);
      ok(mixed.completionNextAction.includes('Save/commit the business deliverable'),
        'the known token keeps its specific action');
      ok(mixed.completionNextAction.includes('Resolve the unmet archive gate(s): future_gate'),
        `the unknown token must not ride silently beside a known one; got: ${mixed.completionNextAction}`);
    });

    it('single-lines multi-line projection values — a multi-line next_action must not kill the footer render (Codex Plan-verify)', () => {
      const flags = mapCompletionFlags({
        ...projection,
        next_action: 'Save/commit the venture plan\nthen start the next deliverable',
        phase: 'summary-complete\r\nextra',
        archive_gate: 'ready_to_archive',
      });
      ok(!/[\r\n]/.test(flags.recommendedNextWork), flags.recommendedNextWork);
      ok(!/[\r\n]/.test(flags.reason), flags.reason);
      strictEqual(flags.recommendedNextWork, 'Save/commit the venture plan then start the next deliverable');
    });

    it('E2E: an unmoved-HEAD terminal renders publish-needed and stays generic-marker-free', async () => {
      const root = await mkdtemp(join(tmpdir(), 'ffooter-publish-'));
      initRepo(root);
      // Baseline the workflow at the REAL current HEAD so head_moved is the
      // ONLY unmet gate at set-terminal time — founder's common "deliverable
      // ready, owner has not saved/committed yet" terminal.
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
      const wf = createWorkflow(root, { baselineHead: head });
      const res = cliSetTerminal(root, wf, 'Save/commit the venture plan');

      strictEqual(res.status, 0, res.stderr);
      ok(res.stderr.includes('completion state: publish-needed'), res.stderr);
      ok(
        res.stderr.includes('the only unmet archive gate is head_moved'),
        `reason must name the single failed gate; got:\n${res.stderr}`,
      );
      ok(
        res.stderr.includes('completion next action: Save/commit the business deliverable'),
        `owner-publish action must render; got:\n${res.stderr}`,
      );
      // The sidecar passes every completion flag explicitly — a persona terminal
      // footer must never surface a runtime generic-fallback marker (§3.2).
      ok(!res.stderr.includes('[generic fallback]'), 'sidecar footers must be generic-marker-free');
    });

    it('E2E: a moved-HEAD terminal renders next-work-available and names the phase', async () => {
      const root = await mkdtemp(join(tmpdir(), 'ffooter-ready-'));
      initRepo(root);
      const wf = createWorkflow(root); // baseline 1111… ≠ real HEAD → head_moved passes
      const res = cliSetTerminal(root, wf, 'Critique the composed planning artifact');
      strictEqual(res.status, 0, res.stderr);
      ok(res.stderr.includes('completion state: next-work-available'), res.stderr);
      ok(
        res.stderr.includes('completion reason: Workflow at phase summary-complete is terminal and archive-ready'),
        `reason must name the phase; got:\n${res.stderr}`,
      );
      ok(!res.stderr.includes('[generic fallback]'), 'sidecar footers must be generic-marker-free');
    });
  });

  it('a PRIMARY re-terminalization re-renders over its own rendered tombstone; a backstop does not', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ffooter-reterm-'));
    initRepo(root);
    const wf = createWorkflow(root);
    const projectionFile = join(root, '.agentic-plugins/state/founder/last-session-handoff.json');

    // First transition (primary) renders and leaves a rendered marker.
    const first = await captureStderr(() =>
      emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: wf, projectionFile, host: 'claude', origin: 'primary' }));
    strictEqual(first.value.footerRendered, true);
    ok(first.stderr.includes(FOOTER_HEADER), 'first primary render fires');

    // A backstop emit over the tombstone must NOT re-render…
    const backstop = await captureStderr(() =>
      emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: wf, projectionFile, host: 'claude' }));
    strictEqual(backstop.value.footerRendered, true, 'reports rendered from the tombstone');
    ok(!backstop.stderr.includes(FOOTER_HEADER), 'backstop stays tombstone-suppressed');

    // …but a NEW primary transition (re-terminalization) renders again.
    const second = await captureStderr(() =>
      emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: wf, projectionFile, host: 'claude', origin: 'primary' }));
    strictEqual(second.value.footerRendered, true);
    ok(second.stderr.includes(FOOTER_HEADER), 'a primary re-terminalization renders over the tombstone');
  });

  it("a 'claimed' (in-progress/crashed) marker does not suppress the nudge — only 'rendered' does", async () => {
    const root = await mkdtemp(join(tmpdir(), 'ffooter-claimed-'));
    initRepo(root);
    const wf = createWorkflow(root);
    const projectionFile = join(root, '.agentic-plugins/state/founder/last-session-handoff.json');
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
    ok(pending && pending.line && pending.line.includes('[founder-handoff-pending]'),
      "a bare 'claimed' marker must NOT suppress the nudge");
  });
});
