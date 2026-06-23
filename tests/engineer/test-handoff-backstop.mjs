// ADR-0031 hook backstop (engineer-hook-backstop) tests.
//
// The primary activation sidecar (#428) fires the session-handoff projection
// from the must-run terminal mutation. This OPTIONAL secondary backstop rides
// the existing engineer Stop / SessionStart hooks to narrow the residual gap:
//   - SessionStart LATE re-surfaces a PENDING projection the primary sidecar
//     wrote (in case the completion footer that renders continue-vs-fresh was
//     missed), then CONSUMES the one-shot file so the nudge fires once.
//   - Stop (re)fires the sidecar for a terminal workflow before archiving, so
//     the guaranteed channel is populated even when the primary emit was missed
//     or failed transiently.
//
// Host-free + deterministic. Mirrors tests/engineer/test-session-start.mjs
// (spawn the hook with a stdin payload) + test-handoff-sidecar.mjs. Run via
// `node --test tests/engineer/test-handoff-backstop.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, doesNotReject } from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, stat, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const SESSION_START = resolve(REPO_ROOT, 'plugins/engineer/adapters/claude/hooks/session-start.mjs');
const CODEX_SESSION_START = resolve(REPO_ROOT, 'plugins/engineer/adapters/codex/hooks/session-start.mjs');
const STOP = resolve(REPO_ROOT, 'plugins/engineer/adapters/claude/hooks/stop.mjs');
const CODEX_STOP = resolve(REPO_ROOT, 'plugins/engineer/adapters/codex/hooks/stop.mjs');
const STATE = resolve(REPO_ROOT, 'plugins/engineer/scripts/state.mjs');
const { createWorkflow, setTerminal } = await import(STATE);
const {
  readPendingHandoff,
  pendingHandoffReinjectionLine,
  consumePendingHandoff,
} = await import(resolve(REPO_ROOT, 'plugins/engineer/scripts/session-handoff.mjs'));

const PROJECTION_REL = '.agentic-plugins/state/engineer/last-session-handoff.json';
const LEGACY_PROJECTION_REL = '.claude/agentic-engineer/last-session-handoff.json';
const PENDING_MARK = 'engineer-handoff-pending';
const MIN_BASELINE = {
  branch: 'test',
  head: '0000000000000000000000000000000000000000',
  status_digest: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
};

const SAMPLE = {
  workflow_kind: 'engineer',
  workflow_id: 'refine-20260101T000000Z-abc123',
  workflow_path: '.agentic-plugins/state/engineer/workflows/refine-20260101T000000Z-abc123.md',
  phase: 'summary-complete',
  next_action: 'IMPERATIVE INJECTION ATTEMPT — DO NOT SHOW',
  archive_gate: 'ready_to_archive',
  routing_recommendation: '/engineer:resume',
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
  const dir = await mkdtemp(join(tmpdir(), 'engineer-handoff-backstop-'));
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

function runHook(payload, script = SESSION_START) {
  return new Promise((resolveP, reject) => {
    // Spawn with cwd = payload.cwd so BOTH the Claude hooks (which read
    // payload.cwd) and the Codex Stop hook (which reads process.cwd()) resolve
    // the same temp repo.
    const child = spawn('node', [script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: payload.cwd || process.cwd(),
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

describe('engineer hook handoff backstop — helpers (ADR-0031)', () => {
  it('readPendingHandoff is fail-closed (null) with no file, and reads a valid projection', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eng-backstop-read-'));
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
    const dir = await mkdtemp(join(tmpdir(), 'eng-backstop-line-'));
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
      strictEqual(summary.routing_recommendation, '/engineer:resume');
      ok(/runtime:context check/.test(summary.render), 'carries the continue-vs-fresh render pointer');
      ok(summary.note && /treat as data/i.test(summary.note), 'data-not-instructions note present');
      // next_action is the imperative-injection vector — it must NOT appear.
      ok(!('next_action' in summary), 'next_action key excluded');
      ok(!out.line.includes('IMPERATIVE INJECTION'), 'next_action value not leaked');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('consumePendingHandoff removes the one-shot file and is non-fatal when absent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eng-backstop-consume-'));
    try {
      const target = await writeProjection(dir);
      await consumePendingHandoff(target);
      strictEqual(await exists(target), false, 'file consumed');
      await doesNotReject(() => consumePendingHandoff(target), 'absent file → no throw');
      await doesNotReject(() => consumePendingHandoff(undefined), 'undefined → no throw');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('engineer SessionStart handoff backstop (ADR-0031)', () => {
  it('re-injects + consumes a pending handoff even with NO active workflow (claude)', async () => {
    await withTmpRepo(async (dir) => {
      const target = await writeProjection(dir);
      const r = await runHook({ cwd: dir }, SESSION_START);
      strictEqual(r.code, 0);
      ok(r.stdout.includes(`[${PENDING_MARK}]`), `re-injection missing: ${r.stdout}`);
      ok(r.stdout.includes(SAMPLE.workflow_id), 'projection workflow_id surfaced');
      ok(!r.stdout.includes('[engineer-active-metadata]'), 'no active-metadata when no active workflow');
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

  it('re-injects + consumes a LEGACY-home pending handoff (home-aware backstop)', async () => {
    await withTmpRepo(async (dir) => {
      // The primary sidecar writes the one-shot file under the terminalized
      // workflow's home; a legacy (pre-ADR-0025) workflow's projection lives
      // under the legacy root. The backstop must read + consume it there too,
      // not only under the canonical root (Codex Plan-verify finding).
      const target = await writeProjection(dir, SAMPLE, LEGACY_PROJECTION_REL);
      const r = await runHook({ cwd: dir }, SESSION_START);
      strictEqual(r.code, 0);
      ok(r.stdout.includes(`[${PENDING_MARK}]`), `legacy re-injection missing: ${r.stdout}`);
      strictEqual(await exists(target), false, 'legacy one-shot file consumed');
    });
  });

  it('no pending handoff → no [engineer-handoff-pending] line (clean no-op)', async () => {
    await withTmpRepo(async (dir) => {
      const r = await runHook({ cwd: dir }, SESSION_START);
      strictEqual(r.code, 0);
      ok(!r.stdout.includes(`[${PENDING_MARK}]`), 'no re-injection without a pending file');
    });
  });
});

describe('engineer Stop handoff backstop (ADR-0031)', () => {
  it('fires the sidecar for a terminal workflow when the primary emit was missed', async () => {
    await withTmpRepo(async (dir) => {
      const wf = await createWorkflow({
        repoRoot: dir,
        verb: 'compose',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'stop backstop terminal',
        currentPhase: 'phase-2-presented',
        nextAction: 'Critique the composed artifact',
      });
      // setTerminal with the default emitHandoff=false → the PRIMARY sidecar is
      // deliberately NOT fired, simulating a missed primary emit.
      await setTerminal({
        workflowPath: typeof wf === 'string' ? wf : wf.filePath,
        host: 'claude',
        terminalPhase: 'summary-complete',
        terminalMarker: true,
        nextAction: 'Critique the composed artifact',
      });
      const target = join(dir, PROJECTION_REL);
      strictEqual(await exists(target), false, 'primary emit was missed (no projection yet)');

      const r = await runHook({ cwd: dir }, STOP);
      strictEqual(r.code, 0, `stop exited non-zero: ${r.stderr}`);
      ok(await exists(target), 'the Stop backstop (re)fired the sidecar for the terminal workflow');
      const projection = JSON.parse(await readFile(target, 'utf8'));
      strictEqual(projection.workflow_kind, 'engineer');
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
        nextAction: 'Critique the composed artifact',
      });
      await setTerminal({
        workflowPath: typeof wf === 'string' ? wf : wf.filePath,
        host: 'codex',
        terminalPhase: 'summary-complete',
        terminalMarker: true,
        nextAction: 'Critique the composed artifact',
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
