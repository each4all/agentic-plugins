// ADR-0039 — orchestrator completion-footer activation tests.
//
// Proves the macro terminal path now CODE-SYNTHESIZES the runtime footer on top
// of the ADR-0031 macro projection, honoring the binding constraints:
//   - stderr / file only, NEVER stdout (the completion scripts' stdout is a
//     load-bearing machine channel: set-terminal = path-only)
//   - projection → footer completion flags render CONCRETE elements 2/3/4
//   - fail-closed silent on a missing/too-old runtime or broken projection
//     (macro completion still lands; no footer; no throw)
//   - at most once per terminal transition (the Stop-hook backstop does not
//     double-render what the primary already rendered)
//   - SessionStart reconciliation suppresses the false "missed-footer" nudge
//
// Mirrors tests/engineer/test-footer-activation.mjs, adapted for the orchestrator
// macro fixture (createWorkflow verb=plan + setPlan). Host-free + deterministic:
// throwaway macros in throwaway state homes; the runtime is pinned to the repo's
// own plugins/runtime via AGENTIC_RUNTIME_ROOT for the "should render" paths so
// discovery never depends on the host's plugin cache. Run via
// `node --test tests/orchestrator/test-footer-activation.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, match, doesNotReject } from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  emitTerminalHandoffSidecar,
  pendingHandoffReinjectionLine,
  footerMarkerFile,
} from '../../plugins/orchestrator/scripts/session-handoff.mjs';
import { createWorkflow, setPlan } from '../../plugins/orchestrator/scripts/state.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const STATE = resolve(REPO_ROOT, 'plugins/orchestrator/scripts/state.mjs');
const RUNTIME_ROOT = resolve(REPO_ROOT, 'plugins/runtime'); // pin discovery deterministically
const FOOTER_HEADER = 'Runtime completion footer (advisory)';
const PENDING_MARKER = '[orchestrator-handoff-pending]';
const PROJECTION_REL = '.agentic-plugins/state/orchestrator/last-session-handoff.json';

const MIN_BASELINE = (branch = 'main') => ({
  branch,
  head: '0000000000000000000000000000000000000000',
  status_digest: '',
});

const SUBTASK = (id, overrides = {}) => ({
  id,
  verb: 'compose',
  branch: `feat/${id.toLowerCase()}`,
  blocked_by: [],
  status: 'pending',
  ...overrides,
});

// Build a macro fixture in the canonical home: create (verb=plan → macro id)
// then optionally set plan.subtasks[]. Returns the macro workflow path.
async function bootstrapMacro(repoRoot, { branch = 'main', subtasks = [], nextAction = 'Dispatch the first ready subtask' } = {}) {
  const { filePath } = await createWorkflow({
    repoRoot,
    verb: 'plan',
    host: 'claude',
    gitBaseline: MIN_BASELINE(branch),
    currentPhase: 'phase-2-presented',
    nextAction,
    originalRequest: 'orchestrator footer-activation fixture',
  });
  if (subtasks.length > 0) {
    await setPlan({ workflowPath: filePath, host: 'claude', subtasks });
  }
  return filePath;
}

// Run the CLI set-terminal (the REAL /finalize + /abort primary path) with the
// runtime pinned so the footer render is deterministic across hosts.
function cliSetTerminal(root, macroPath, nextAction, { runtimeRoot = RUNTIME_ROOT } = {}) {
  return spawnSync(
    'node',
    [
      STATE, 'set-terminal', '--workflow-path', macroPath, '--host', 'claude',
      '--terminal-phase', 'finalized', '--terminal-marker', 'true',
      '--next-action', nextAction, '--event', 'updated',
    ],
    { encoding: 'utf8', cwd: root, env: { ...process.env, AGENTIC_RUNTIME_ROOT: runtimeRoot } },
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

// Pin AGENTIC_RUNTIME_ROOT around an async fn (the env-override rung takes ladder
// precedence, so the render is deterministic regardless of the host cache).
async function withRuntime(runtimeRoot, fn) {
  const saved = process.env.AGENTIC_RUNTIME_ROOT;
  process.env.AGENTIC_RUNTIME_ROOT = runtimeRoot;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.AGENTIC_RUNTIME_ROOT;
    else process.env.AGENTIC_RUNTIME_ROOT = saved;
  }
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

// The PER-WORKFLOW footer marker for the macro whose projection currently
// occupies `projectionFile` (reads the projection for its workflow_id). The
// marker is keyed by workflow_id so two terminal macros sharing the canonical
// slot do not clobber each other's rendered state (ADR-0039 / Codex Plan-verify).
async function markerFor(projectionFile) {
  const projection = JSON.parse(await readFile(projectionFile, 'utf8'));
  return footerMarkerFile(projectionFile, projection.workflow_id);
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

describe('orchestrator completion-footer activation (ADR-0039)', () => {
  it('CLI set-terminal renders the footer on STDERR, never stdout (machine channel intact)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-footer-stderr-'));
    const macroPath = await bootstrapMacro(root, { subtasks: [SUBTASK('T1')] });
    const res = cliSetTerminal(root, macroPath, 'Archive the finalized macro');

    strictEqual(res.status, 0, `set-terminal exited non-zero: ${res.stderr}`);
    // stdout stays byte-for-byte path-only — the footer must not leak to it.
    strictEqual(res.stdout, `${macroPath}\n`, 'stdout must remain path-only');
    ok(!res.stdout.includes(FOOTER_HEADER), 'footer must NOT appear on stdout');
    ok(res.stderr.includes(FOOTER_HEADER), 'footer header must appear on stderr');
  });

  it('promotes elements 2/3/4/7 to CONCRETE (completion state + recommended next work + continue-vs-fresh)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-footer-elements-'));
    const macroPath = await bootstrapMacro(root, { subtasks: [SUBTASK('T1')], nextAction: 'Dispatch the first ready subtask' });
    const projectionFile = join(root, 'proj.json');
    // Direct emit on a non-terminal macro (archive_gate=not_terminal) renders a
    // clean session_handoff; the sidecar composes the footer regardless of the
    // macro's terminal state (it computes the projection from current frontmatter).
    const { value, stderr } = await withRuntime(RUNTIME_ROOT, () => captureStderr(() =>
      emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: macroPath, projectionFile, host: 'claude' })));

    strictEqual(value.emitted, true, stderr);
    strictEqual(value.footerRendered, true, 'the footer must render for a valid macro projection');
    // element 3/4: the concrete next action flows into recommended-next-work.
    ok(
      stderr.includes('recommended next work: Dispatch the first ready subtask'),
      `recommended next work must be concrete; got:\n${stderr}`,
    );
    // completion state is one of the mapped values (never the generic default).
    match(stderr, /completion state: (next-work-available|blocked)/);
    // element 7/8: the continue-vs-fresh session handoff renders.
    ok(stderr.includes('session handoff (continue-vs-fresh)'), 'session handoff must render');
    // host localization (claude) — the macro routing is /orchestrator:resume.
    match(stderr, /\/(orchestrator|runtime):/);
  });

  it('is idempotent: the Stop-hook backstop does NOT re-render what the primary rendered', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-footer-idem-'));
    const macroPath = await bootstrapMacro(root, { subtasks: [SUBTASK('T1')] });
    const projectionFile = join(root, PROJECTION_REL);

    // PRIMARY (marker absent → renders + writes marker).
    const primary = await withRuntime(RUNTIME_ROOT, () => captureStderr(() =>
      emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: macroPath, projectionFile, host: 'claude' })));
    strictEqual(primary.value.emitted, true);
    strictEqual(primary.value.footerRendered, true, 'primary must render the footer');
    ok(primary.stderr.includes(FOOTER_HEADER), 'primary emits the footer to stderr');
    const markerFile = await markerFor(projectionFile);
    ok(await exists(markerFile), 'primary writes the per-workflow idempotency marker');

    // BACKSTOP (marker present → must NOT re-render).
    const backstop = await withRuntime(RUNTIME_ROOT, () => captureStderr(() =>
      emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: macroPath, projectionFile, host: 'claude' })));
    strictEqual(backstop.value.emitted, true);
    strictEqual(backstop.value.footerRendered, true, 'reports rendered (idempotent), from the marker');
    ok(!backstop.stderr.includes(FOOTER_HEADER), 'backstop must NOT emit a second footer');
  });

  it('fail-closed on a MISSING/too-old runtime: no footer, still emitted, no throw', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-footer-noruntime-'));
    const macroPath = await bootstrapMacro(root, { subtasks: [SUBTASK('T1')] });
    const projectionFile = join(root, 'proj.json');

    // Point AGENTIC_RUNTIME_ROOT at an absolute path with no scripts/footer.mjs
    // → discovery fail-closes → no footer.
    const { value, stderr } = await withRuntime(join(root, 'no-such-runtime'), () => captureStderr(() =>
      emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: macroPath, projectionFile, host: 'claude' })));
    strictEqual(value.emitted, true, 'projection still written (guaranteed channel)');
    strictEqual(value.footerRendered, false, 'no footer when runtime is missing');
    ok(!stderr.includes(FOOTER_HEADER), 'no footer text on a fail-closed render');
    ok(await exists(projectionFile), 'the projection file is still written');
  });

  it('fail-closed on a broken projection: no footer, no file, no throw', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-footer-brokenproj-'));
    const projectionFile = join(root, 'proj.json');
    // workflowPath does not resolve → non-ok projection status.
    const { value, stderr } = await withRuntime(RUNTIME_ROOT, () => captureStderr(() =>
      emitTerminalHandoffSidecar({
        repoRoot: root, workflowPath: join(root, 'nope.md'), projectionFile, host: 'claude',
      })));
    strictEqual(value.emitted, false);
    ok(!stderr.includes(FOOTER_HEADER), 'no footer when the projection is not ok');
    strictEqual(await exists(projectionFile), false, 'no projection file on a non-ok status');
    await doesNotReject(() =>
      emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: join(root, 'nope.md'), projectionFile }));
  });

  it('SessionStart reconciliation: a rendered footer suppresses the nudge; a missed footer keeps it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-footer-reconcile-'));
    const macroPath = await bootstrapMacro(root, { subtasks: [SUBTASK('T1')] });
    const projectionFile = join(root, PROJECTION_REL);

    // Rendered: primary emits + marks → pending line is suppressed (null).
    await withRuntime(RUNTIME_ROOT, () =>
      emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: macroPath, projectionFile, host: 'claude' }));
    const afterRender = await pendingHandoffReinjectionLine(root);
    ok(afterRender, 'a pending handoff exists');
    strictEqual(afterRender.line, null, 'a rendered footer suppresses the missed-footer nudge');
    strictEqual(afterRender.footerRendered, true);

    // Missed: no marker (fresh projection, runtime forced missing) → nudge stays.
    const root2 = await mkdtemp(join(tmpdir(), 'orch-footer-reconcile-missed-'));
    const macroPath2 = await bootstrapMacro(root2, { subtasks: [SUBTASK('T1')] });
    const projectionFile2 = join(root2, PROJECTION_REL);
    await withRuntime(join(root2, 'no-such-runtime'), () =>
      emitTerminalHandoffSidecar({ repoRoot: root2, workflowPath: macroPath2, projectionFile: projectionFile2, host: 'claude' }));
    const afterMiss = await pendingHandoffReinjectionLine(root2);
    ok(afterMiss, 'a pending handoff exists');
    ok(afterMiss.line && afterMiss.line.includes(PENDING_MARKER), 'a missed footer keeps the nudge');
  });

  it('fail-closed on a DEGRADED render (footer.mjs reports projection_error): no mark, nudge fires (Codex Plan-verify BLOCKER 1)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-footer-degraded-'));
    const macroPath = await bootstrapMacro(root, { subtasks: [SUBTASK('T1')] });
    const projectionFile = join(root, PROJECTION_REL);
    // Point discovery at a stub runtime whose footer.mjs exits 0 but reports a
    // projection_error (no session_handoff) — the JSON validation must reject it.
    const stub = await writeStubRuntime(await mkdtemp(join(tmpdir(), 'orch-stub-rt-')), DEGRADED_FOOTER);
    const { value, stderr } = await withRuntime(stub, () => captureStderr(() =>
      emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: macroPath, projectionFile, host: 'claude' })));
    strictEqual(value.emitted, true, 'projection still written');
    strictEqual(value.footerRendered, false, 'a projection_error render must NOT count as rendered');
    ok(!stderr.includes(FOOTER_HEADER), 'the degraded footer text must not be emitted');
    strictEqual(await exists(await markerFor(projectionFile)), false, 'no marker (claim released) on a degraded render');
    // The nudge must still fire (the footer was NOT delivered).
    const pending = await pendingHandoffReinjectionLine(root);
    ok(pending && pending.line && pending.line.includes(PENDING_MARKER),
      'a degraded render keeps the SessionStart nudge as a backstop');
  });

  it("a 'claimed' (in-progress/crashed) marker does not suppress the nudge — only 'rendered' does (Codex Plan-verify BLOCKER 2)", async () => {
    const root = await mkdtemp(join(tmpdir(), 'orch-footer-claimed-'));
    const macroPath = await bootstrapMacro(root, { subtasks: [SUBTASK('T1')] });
    const projectionFile = join(root, PROJECTION_REL);
    // Emit a projection (no runtime → no render, no marker), then simulate a
    // crashed/in-progress claim by writing a 'claimed' marker (at the PER-WORKFLOW
    // path the reconciliation reads) for this workflow.
    await withRuntime(join(root, 'no-such-runtime'), () =>
      emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: macroPath, projectionFile, host: 'claude' }));
    const projection = JSON.parse(await readFile(projectionFile, 'utf8'));
    const markerFile = footerMarkerFile(projectionFile, projection.workflow_id);
    await writeFile(markerFile, `${JSON.stringify({ workflow_id: projection.workflow_id, status: 'claimed', at: '2026-01-01T00:00:00Z' })}\n`, 'utf8');
    const pending = await pendingHandoffReinjectionLine(root);
    ok(pending && pending.line && pending.line.includes(PENDING_MARKER),
      "a bare 'claimed' marker must NOT suppress the nudge");
  });

  it('multi-macro: each terminal macro renders once even sharing the canonical slot (Codex Plan-verify MAJOR)', async () => {
    // Two terminal macros A and B share the SINGLE canonical last-session-handoff
    // slot (the orchestrator Stop backstop scans BOTH). Per-workflow markers must
    // keep each idempotent: emit A, then B, then A again (a Stop re-scan). A must
    // NOT re-render — a slot-keyed marker would let B clobber A's rendered state
    // and re-render A's footer on the next scan.
    const root = await mkdtemp(join(tmpdir(), 'orch-footer-multimacro-'));
    const macroA = await bootstrapMacro(root, { branch: 'macro/a', subtasks: [SUBTASK('A1')] });
    const macroB = await bootstrapMacro(root, { branch: 'macro/b', subtasks: [SUBTASK('B1')] });
    const projectionFile = join(root, PROJECTION_REL); // the shared canonical slot

    const emit = (macroPath) => withRuntime(RUNTIME_ROOT, () => captureStderr(() =>
      emitTerminalHandoffSidecar({ repoRoot: root, workflowPath: macroPath, projectionFile, host: 'claude' })));

    const a1 = await emit(macroA);
    strictEqual(a1.value.footerRendered, true, 'A renders first');
    ok(a1.stderr.includes(FOOTER_HEADER), 'A emits its footer');

    const b1 = await emit(macroB);
    strictEqual(b1.value.footerRendered, true, 'B renders under its own per-workflow marker');
    ok(b1.stderr.includes(FOOTER_HEADER), 'B emits its footer');

    // Re-scan A (the Stop backstop re-encountering A while B last wrote the slot).
    const a2 = await emit(macroA);
    strictEqual(a2.value.footerRendered, true, 'A reports rendered (idempotent, from its own marker)');
    ok(!a2.stderr.includes(FOOTER_HEADER), "A must NOT re-render — B did not clobber A's marker");
  });

  it('CLI subtask-update auto-terminal fires the footer to STDERR while stdout stays the JSON envelope (/done surface)', async () => {
    // Completing the LAST subtask auto-terminalizes the macro → fires the sidecar
    // → footer on stderr. stdout must remain the machine-readable JSON envelope,
    // never the footer (subtask-update's stdout contract is load-bearing).
    const root = await mkdtemp(join(tmpdir(), 'orch-footer-subtask-'));
    const macroPath = await bootstrapMacro(root, { subtasks: [SUBTASK('T1')] });
    const res = spawnSync(
      'node',
      [
        STATE, 'subtask-update', '--workflow-path', macroPath, '--host', 'claude',
        '--subtask-id', 'T1', '--status', 'completed',
        '--engineer-workflow-id', 'eng-t1', '--commit', 'a'.repeat(40),
      ],
      { encoding: 'utf8', cwd: root, env: { ...process.env, AGENTIC_RUNTIME_ROOT: RUNTIME_ROOT } },
    );
    strictEqual(res.status, 0, `subtask-update exited non-zero: ${res.stderr}`);
    const envelope = JSON.parse(res.stdout); // stdout parses as the JSON envelope, footer-free
    strictEqual(envelope.autoTerminal, true, 'completing the last subtask auto-terminalizes the macro');
    ok(!res.stdout.includes(FOOTER_HEADER), 'footer must NOT appear on the stdout JSON envelope channel');
    ok(res.stderr.includes(FOOTER_HEADER), 'the auto-terminal footer must render on stderr');
  });
});
