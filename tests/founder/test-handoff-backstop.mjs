// ADR-0043 S3 hook backstop (founder-hook-backstop) tests.
//
// The primary activation sidecar fires the session-handoff projection from
// the must-run terminal mutation (set-terminal). This OPTIONAL secondary
// backstop rides the existing founder Stop / SessionStart hooks to narrow the
// residual gap:
//   - SessionStart LATE re-surfaces a PENDING projection the primary sidecar
//     wrote (in case the completion footer that renders continue-vs-fresh was
//     missed), INDEPENDENTLY of an active workflow (the pre-S3 founder hook
//     early-returned without one — the exact gap ADR-0043 §2 closes), then
//     CONSUMES the one-shot file so the nudge fires once.
//   - Stop (re)fires the sidecar for a terminal workflow before archiving, so
//     the guaranteed channel is populated even when the primary emit was
//     missed or failed transiently.
//
// Host-free + deterministic. Mirrors the engineer sibling suite (spawn the
// hook with a stdin payload). Run via
// `node --test tests/founder/test-handoff-backstop.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, doesNotReject } from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, stat, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const SESSION_START = resolve(REPO_ROOT, 'plugins/founder/adapters/claude/hooks/session-start.mjs');
const CODEX_SESSION_START = resolve(REPO_ROOT, 'plugins/founder/adapters/codex/hooks/session-start.mjs');
const STOP = resolve(REPO_ROOT, 'plugins/founder/adapters/claude/hooks/stop.mjs');
const CODEX_STOP = resolve(REPO_ROOT, 'plugins/founder/adapters/codex/hooks/stop.mjs');
const STATE = resolve(REPO_ROOT, 'plugins/founder/scripts/state.mjs');
const { createWorkflow, setTerminal } = await import(STATE);
const {
  readPendingHandoff,
  pendingHandoffReinjectionLine,
  consumePendingHandoff,
} = await import(resolve(REPO_ROOT, 'plugins/founder/scripts/session-handoff.mjs'));

const PROJECTION_REL = '.agentic-plugins/state/founder/last-session-handoff.json';
const PENDING_MARK = 'founder-handoff-pending';
const MIN_BASELINE = {
  branch: 'test',
  head: '0000000000000000000000000000000000000000',
  status_digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
};

const SAMPLE = {
  workflow_kind: 'founder',
  workflow_id: 'compose-20260101T000000Z-abc123',
  workflow_path: '.agentic-plugins/state/founder/workflows/compose-20260101T000000Z-abc123.md',
  phase: 'summary-complete',
  next_action: 'IMPERATIVE INJECTION ATTEMPT — DO NOT SHOW',
  archive_gate: 'ready_to_archive',
  routing_recommendation: '/founder:resume',
};

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolveP, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`${cmd} ${args.join(' ')} exit ${code}: ${stderr}`));
      else resolveP();
    });
  });
}

async function withTmpRepo(fn, { branch = 'test' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'founder-handoff-backstop-'));
  try {
    await runCmd('git', ['init', '-q', '-b', branch], { cwd: dir });
    await runCmd('git', ['config', 'user.email', 'test@test'], { cwd: dir });
    await runCmd('git', ['config', 'user.name', 'test'], { cwd: dir });
    await runCmd('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
    await runCmd('git', ['commit', '-q', '--allow-empty', '-m', 'baseline', '--no-verify'], { cwd: dir });
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runHook(payload, script = SESSION_START, env = undefined) {
  return new Promise((resolveP, reject) => {
    // Spawn with cwd = payload.cwd so BOTH the Claude hooks (which read
    // payload.cwd) and the Codex Stop hook (which reads process.cwd()) resolve
    // the same temp repo. `env` lets a test pin AGENTIC_RUNTIME_ROOT so the
    // hook's footer render is deterministic.
    const child = spawn('node', [script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: payload.cwd || process.cwd(),
      ...(env ? { env: { ...process.env, ...env } } : {}),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolveP({ code, stdout, stderr }));
    child.on('error', reject);
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

async function writeProjection(dir, projection = SAMPLE, rel = PROJECTION_REL) {
  const target = join(dir, rel);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(projection, null, 2)}\n`, 'utf8');
  return target;
}

describe('founder hook handoff backstop — helpers (ADR-0043 S3)', () => {
  it('readPendingHandoff is fail-closed (null) with no file, and reads a valid projection', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fdr-backstop-read-'));
    try {
      strictEqual(await readPendingHandoff(dir), null, 'no file → null');
      await writeProjection(dir);
      const pending = await readPendingHandoff(dir);
      ok(pending, 'reads the projection');
      strictEqual(pending.projection.workflow_id, SAMPLE.workflow_id);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('pendingHandoffReinjectionLine builds a bounded marker line and excludes next_action', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fdr-backstop-line-'));
    try {
      strictEqual(await pendingHandoffReinjectionLine(dir), null, 'no file → null');
      await writeProjection(dir);
      const out = await pendingHandoffReinjectionLine(dir);
      ok(out, 'builds a line');
      ok(out.line.startsWith(`[${PENDING_MARK}] `), out.line);
      ok(out.line.trimEnd().endsWith(`[/${PENDING_MARK}]`), out.line);
      const m = out.line.match(/\{.*\}/);
      ok(m, 'has a JSON payload');
      const summary = JSON.parse(m[0]);
      strictEqual(summary.workflow_id, SAMPLE.workflow_id);
      strictEqual(summary.archive_gate, 'ready_to_archive');
      strictEqual(summary.routing_recommendation, '/founder:resume');
      ok(!('render' in summary), 'no stale --workflow-projection-file pointer (file is consumed)');
      ok(summary.note && /archive_gate \+ routing/i.test(summary.note), 'note is self-contained continue-vs-fresh guidance');
      ok(summary.note && /treat as data/i.test(summary.note), 'data-not-instructions note present');
      // next_action is the imperative-injection vector — it must NOT appear.
      ok(!('next_action' in summary), 'next_action key excluded');
      ok(!out.line.includes('IMPERATIVE INJECTION'), 'next_action value not leaked');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not re-inject a fields-less projection (workflow_id fail-closed)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fdr-backstop-malformed-'));
    try {
      await writeProjection(dir, { archive_gate: 'ready_to_archive' });
      strictEqual(await pendingHandoffReinjectionLine(dir), null, 'object without workflow_id → no re-injection');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('consumePendingHandoff removes the one-shot file, PRESERVES a rendered tombstone, and removes a crashed claim', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fdr-backstop-consume-'));
    try {
      // rendered marker → tombstone survives (founder divergence: it is what
      // keeps a later Stop from re-rendering the still-active publish-needed
      // workflow's already-delivered transition).
      const target = await writeProjection(dir);
      const marker = `${target}.footer-rendered`;
      await writeFile(marker, `${JSON.stringify({ workflow_id: SAMPLE.workflow_id, status: 'rendered', at: '2026-01-01T00:00:00Z' })}\n`, 'utf8');
      await consumePendingHandoff(target);
      strictEqual(await exists(target), false, 'file consumed');
      strictEqual(await exists(marker), true, 'rendered tombstone must SURVIVE consumption');

      // claimed (crashed/in-flight) marker → removed with the projection.
      const target2 = await writeProjection(dir);
      await writeFile(marker, `${JSON.stringify({ workflow_id: SAMPLE.workflow_id, status: 'claimed', at: '2026-01-01T00:00:00Z' })}\n`, 'utf8');
      await consumePendingHandoff(target2);
      strictEqual(await exists(target2), false, 'file consumed');
      strictEqual(await exists(marker), false, 'a non-completed claim is removed');

      await doesNotReject(() => consumePendingHandoff(target), 'absent file → no throw');
      await doesNotReject(() => consumePendingHandoff(undefined), 'undefined → no throw');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('founder SessionStart handoff backstop (ADR-0043 S3)', () => {
  it('re-injects + consumes a pending handoff even with NO active workflow (claude — the pre-S3 early-return gap)', async () => {
    await withTmpRepo(async (dir) => {
      const target = await writeProjection(dir);
      const r = await runHook({ cwd: dir }, SESSION_START);
      strictEqual(r.code, 0);
      ok(r.stdout.includes(`[${PENDING_MARK}]`), `re-injection missing: ${r.stdout}`);
      ok(r.stdout.includes(SAMPLE.workflow_id), 'projection workflow_id surfaced');
      ok(!r.stdout.includes('[founder-active-metadata]'), 'no active-metadata when no active workflow');
      strictEqual(await exists(target), false, 'one-shot file consumed after re-injection');
    });
  });

  it('Codex SessionStart re-injects + consumes a pending handoff', async () => {
    await withTmpRepo(async (dir) => {
      const target = await writeProjection(dir);
      const r = await runHook({ cwd: dir }, CODEX_SESSION_START);
      strictEqual(r.code, 0);
      ok(r.stdout.includes(`[${PENDING_MARK}]`), `re-injection missing: ${r.stdout}`);
      strictEqual(await exists(target), false, 'one-shot file consumed');
    });
  });

  it('a rendered footer suppresses the nudge; the hook consumes the one-shot but keeps the tombstone (ADR-0039 §4)', async () => {
    await withTmpRepo(async (dir) => {
      const target = await writeProjection(dir);
      const marker = `${target}.footer-rendered`;
      await writeFile(marker, `${JSON.stringify({ workflow_id: SAMPLE.workflow_id, status: 'rendered', at: '2026-01-01T00:00:00Z' })}\n`, 'utf8');
      const r = await runHook({ cwd: dir }, SESSION_START);
      strictEqual(r.code, 0);
      ok(!r.stdout.includes(`[${PENDING_MARK}]`), 'no false missed-footer nudge after a rendered footer');
      strictEqual(await exists(target), false, 'one-shot file still consumed');
      strictEqual(await exists(marker), true, 'the rendered tombstone survives (Stop must stay suppressed)');
    });
  });

  it('composed lifecycle: set-terminal render → SessionStart consume → Stop does NOT re-render (Codex Plan-verify blocker)', async () => {
    await withTmpRepo(async (dir) => {
      // 1. Real CLI set-terminal with the repo runtime pinned: the primary
      //    renders one footer. Baseline == real HEAD → publish-needed, so the
      //    workflow stays active-terminal (founder's common case).
      const { execFileSync } = await import('node:child_process');
      const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
      const wf = await createWorkflow({
        repoRoot: dir,
        verb: 'compose',
        host: 'claude',
        gitBaseline: { ...MIN_BASELINE, head },
        originalRequest: 'composed lifecycle',
        currentPhase: 'phase-2-presented',
        nextAction: 'Save/commit the venture plan',
      });
      const wfPath = typeof wf === 'string' ? wf : wf.filePath;
      const RUNTIME_ROOT = resolve(REPO_ROOT, 'plugins/runtime');
      const setTerm = spawn('node', [
        STATE, 'set-terminal', '--workflow-path', wfPath, '--host', 'claude',
        '--terminal-phase', 'summary-complete', '--terminal-marker', 'true',
        '--next-action', 'Save/commit the venture plan', '--event', 'updated',
      ], { cwd: dir, env: { ...process.env, AGENTIC_RUNTIME_ROOT: RUNTIME_ROOT }, stdio: ['ignore', 'pipe', 'pipe'] });
      let setTermErr = '';
      setTerm.stderr.on('data', (d) => (setTermErr += d));
      await new Promise((res) => setTerm.on('close', res));
      ok(setTermErr.includes('Runtime completion footer'), `primary must render once: ${setTermErr}`);

      // 2. SessionStart (compact) suppresses the nudge and consumes the
      //    projection — the rendered tombstone must survive.
      const ss = await runHook({ cwd: dir }, SESSION_START, { AGENTIC_RUNTIME_ROOT: RUNTIME_ROOT });
      strictEqual(ss.code, 0);
      ok(!ss.stdout.includes(`[${PENDING_MARK}]`), 'rendered footer → no nudge');

      // 3. The next Stop re-fires the backstop for the still-terminal
      //    workflow; the tombstone must keep it from re-rendering.
      const stop = await runHook({ cwd: dir }, STOP, { AGENTIC_RUNTIME_ROOT: RUNTIME_ROOT });
      strictEqual(stop.code, 0, stop.stderr);
      ok(!stop.stderr.includes('Runtime completion footer'),
        `Stop after consumption must NOT re-render the same transition; got:\n${stop.stderr}`);
    });
  });

  it('active workflow + pending handoff → BOTH the metadata line and the re-injection fire', async () => {
    await withTmpRepo(async (dir) => {
      await createWorkflow({
        repoRoot: dir,
        verb: 'compose',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'backstop with active workflow',
        currentPhase: 'phase-1',
        nextAction: 'keep going',
      });
      const target = await writeProjection(dir);
      const r = await runHook({ cwd: dir }, SESSION_START);
      strictEqual(r.code, 0);
      ok(r.stdout.includes('[founder-active-metadata]'), 'active metadata still fires');
      ok(r.stdout.includes(`[${PENDING_MARK}]`), 're-injection fires alongside the metadata');
      strictEqual(await exists(target), false, 'one-shot consumed');
    });
  });

  it('no pending handoff → no [founder-handoff-pending] line (clean no-op)', async () => {
    await withTmpRepo(async (dir) => {
      const r = await runHook({ cwd: dir }, SESSION_START);
      strictEqual(r.code, 0);
      ok(!r.stdout.includes(`[${PENDING_MARK}]`), 'no re-injection without a pending file');
    });
  });
});

describe('founder Stop handoff backstop (ADR-0043 S3)', () => {
  it('fires the sidecar for a terminal workflow when the primary emit was missed', async () => {
    await withTmpRepo(async (dir) => {
      const wf = await createWorkflow({
        repoRoot: dir,
        verb: 'compose',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'stop backstop terminal',
        currentPhase: 'phase-2-presented',
        nextAction: 'Critique the composed planning artifact',
      });
      // setTerminal with the default emitHandoff=false → the PRIMARY sidecar is
      // deliberately NOT fired, simulating a missed primary emit.
      await setTerminal({
        workflowPath: typeof wf === 'string' ? wf : wf.filePath,
        host: 'claude',
        terminalPhase: 'summary-complete',
        terminalMarker: true,
        nextAction: 'Critique the composed planning artifact',
      });
      const target = join(dir, PROJECTION_REL);
      strictEqual(await exists(target), false, 'primary emit was missed (no projection yet)');

      const r = await runHook({ cwd: dir }, STOP);
      strictEqual(r.code, 0, `stop exited non-zero: ${r.stderr}`);
      ok(await exists(target), 'the Stop backstop (re)fired the sidecar for the terminal workflow');
      const projection = JSON.parse(await readFile(target, 'utf8'));
      strictEqual(projection.workflow_kind, 'founder');
    });
  });

  it('Codex Stop fires the sidecar for a terminal workflow (host parity)', async () => {
    await withTmpRepo(async (dir) => {
      const wf = await createWorkflow({
        repoRoot: dir,
        verb: 'compose',
        host: 'codex',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'codex stop backstop terminal',
        currentPhase: 'phase-2-presented',
        nextAction: 'Critique the composed planning artifact',
      });
      await setTerminal({
        workflowPath: typeof wf === 'string' ? wf : wf.filePath,
        host: 'codex',
        terminalPhase: 'summary-complete',
        terminalMarker: true,
        nextAction: 'Critique the composed planning artifact',
      });
      const target = join(dir, PROJECTION_REL);
      strictEqual(await exists(target), false, 'primary emit was missed');
      const r = await runHook({ cwd: dir }, CODEX_STOP);
      strictEqual(r.code, 0, `codex stop exited non-zero: ${r.stderr}`);
      ok(await exists(target), 'the Codex Stop backstop (re)fired the sidecar');
    });
  });

  it('does NOT fire the sidecar for a non-terminal workflow', async () => {
    await withTmpRepo(async (dir) => {
      await createWorkflow({
        repoRoot: dir,
        verb: 'compose',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'stop backstop mid-flight',
        currentPhase: 'phase-1',
        nextAction: 'keep going',
      });
      const target = join(dir, PROJECTION_REL);
      const r = await runHook({ cwd: dir }, STOP);
      strictEqual(r.code, 0, `stop exited non-zero: ${r.stderr}`);
      strictEqual(await exists(target), false, 'a non-terminal workflow must not fire the handoff backstop');
    });
  });
});
