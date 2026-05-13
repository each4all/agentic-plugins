// plugins/engineer/scripts/peer-runner.mjs unit tests (ADR-0023 PR-B/PR-C).
//
// Covers the engineer peer-runner primitive without invoking real peer CLIs:
// tests build a fake companions discovery root and fake companion script, then
// exercise ledger creation, status, cancellation, sweep reconciliation, and
// bounded retention under a temp repo root.
//
// Run via `node --test tests/engineer/test-peer-runner.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual, rejects } from 'node:assert/strict';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const PEER_RUNNER_PATH = resolve(REPO_ROOT, 'plugins/engineer/scripts/peer-runner.mjs');
const STATE_PATH = resolve(REPO_ROOT, 'plugins/engineer/scripts/state.mjs');

const {
  HANDLE_SCHEMA_VERSION,
  peerRunPaths,
  readHandle,
  writeHandle,
  runPeer,
  statusPeerRun,
  cancelPeerRun,
  sweepPeerRuns,
} = await import(PEER_RUNNER_PATH);
const { createWorkflow, readWorkflow } = await import(STATE_PATH);

async function withTmpRepo(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'engineer-peer-runner-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function exists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeFakeCompanions(root) {
  const companionsRoot = join(root, 'fake-companions');
  await mkdir(companionsRoot, { recursive: true });
  await writeFile(join(companionsRoot, 'discover-peer.mjs'), `
export async function discoverPeerCompanion({ peer } = {}) {
  if (peer !== 'claude' && peer !== 'codex') {
    return { ok: false, reason: 'bad peer' };
  }
  return { ok: true, path: new URL('./' + peer + '-companion.mjs', import.meta.url).pathname };
}
`, 'utf8');

  const companion = `#!/usr/bin/env node
const mode = process.env.FAKE_COMPANION_MODE || 'json-success';
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const args = process.argv.slice(2);
const get = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};
if (args[0] !== 'task') {
  process.stderr.write('bad subcommand\\\\n');
  process.exit(2);
}
const outputFormat = get('--output-format') || 'json';
const promptFile = get('--prompt-file');
if (promptFile) {
  await import('node:fs/promises').then(({ readFile }) => readFile(promptFile, 'utf8'));
}
if (mode === 'stream-text') {
  process.stdout.write('alpha\\\\n');
  process.stderr.write('warn-a\\\\n');
  await delay(250);
  process.stdout.write('omega\\\\n');
  process.stderr.write('warn-b\\\\n');
  process.exit(0);
}
if (mode === 'ignore-term') {
  process.on('SIGTERM', () => {
    process.stderr.write('term ignored\\\\n');
  });
  process.stdout.write('started\\\\n');
  setInterval(() => {}, 1000);
  await delay(60_000);
  process.exit(0);
}
if (outputFormat === 'json') {
  process.stdout.write(JSON.stringify({
    status: 'success',
    peer_host: 'claude',
    peer_model: null,
    stdout: 'fake ok',
    exit_code: 0
  }));
} else {
  process.stdout.write('fake ok\\\\n');
}
process.exit(0);
`;
  for (const peer of ['claude', 'codex']) {
    const path = join(companionsRoot, `${peer}-companion.mjs`);
    await writeFile(path, companion, 'utf8');
    await chmod(path, 0o755);
  }
  return companionsRoot;
}

function fakeEnv(companionsRoot, extra = {}) {
  return {
    ...process.env,
    AGENTIC_COMPANIONS_ROOT: companionsRoot,
    ...extra,
  };
}

async function waitFor(predicate, { timeoutMs = 15000, intervalMs = 25, message = 'condition' } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeoutMs) {
    last = await predicate();
    if (last) return last;
    await new Promise((resolveP) => setTimeout(resolveP, intervalMs));
  }
  throw new Error(`timed out waiting for ${message}; last=${JSON.stringify(last)}`);
}

function baseHandle(repoRoot, runId, overrides = {}) {
  const at = overrides.updated_at ?? new Date().toISOString();
  return {
    schema_version: HANDLE_SCHEMA_VERSION,
    run_id: runId,
    plugin: 'engineer',
    kind: 'manual',
    workflow_path: null,
    phase: null,
    ensemble_type: null,
    host: 'codex',
    peer_host: 'claude',
    model: null,
    effort: null,
    cwd: repoRoot,
    output_format: 'json',
    status: 'queued',
    pid: null,
    pgid: null,
    process_fingerprint: { kind: 'none' },
    started_at: at,
    updated_at: at,
    completed_at: null,
    last_output_at: null,
    stdout_bytes: 0,
    stderr_bytes: 0,
    exit_code: null,
    error_kind: null,
    prompt_retained: false,
    ...overrides,
  };
}

async function writeHandleFixture(repoRoot, runId, overrides = {}, opts = {}) {
  const paths = peerRunPaths(repoRoot, runId, opts);
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  await writeFile(paths.stdout, '', { mode: 0o600 });
  await writeFile(paths.stderr, '', { mode: 0o600 });
  await writeHandle(paths.handle, baseHandle(repoRoot, runId, overrides));
  return paths;
}

describe('peer-runner.mjs — run ledger and handle schema', () => {
  it('run creates hidden ledger files, handle schema 1.0, and final envelope', async () => {
    await withTmpRepo(async (repoRoot) => {
      const companionsRoot = await writeFakeCompanions(repoRoot);
      const { filePath: workflowPath } = await createWorkflow({
        repoRoot,
        verb: 'compose',
        originalRequest: 'peer-runner pending test',
        gitBaseline: {
          branch: 'main',
          head: 'abc123',
          status_digest: '',
        },
        host: 'codex',
        currentPhase: 'phase-test',
        nextAction: 'test peer-runner',
      });

      const result = await runPeer({
        repoRoot,
        runId: 'plan-verify-test',
        kind: 'ensemble',
        workflowPath,
        phase: 'compose',
        ensembleType: 'plan-verify',
        host: 'codex',
        peer: 'claude',
        promptText: '<task>hello</task>',
        outputFormat: 'json',
        cwd: repoRoot,
        env: fakeEnv(companionsRoot),
      });

      strictEqual(result.ok, true);
      strictEqual(result.run_id, 'plan-verify-test');
      strictEqual(result.status, 'completed');

      const paths = peerRunPaths(repoRoot, 'plan-verify-test');
      const handle = await readHandle(paths.handle);
      strictEqual(handle.schema_version, HANDLE_SCHEMA_VERSION);
      strictEqual(handle.kind, 'ensemble');
      strictEqual(handle.workflow_path, workflowPath);
      strictEqual(handle.phase, 'compose');
      strictEqual(handle.ensemble_type, 'plan-verify');
      strictEqual(handle.status, 'completed');
      strictEqual(handle.prompt_retained, false);
      strictEqual(await exists(paths.prompt), false, 'prompt.xml should be opt-in debug data');

      const envelope = await readJson(paths.envelope);
      strictEqual(envelope.status, 'success');
      strictEqual(envelope.stdout, 'fake ok');

      const { frontmatter } = await readWorkflow(workflowPath);
      deepStrictEqual(frontmatter.pending_ensemble, [{
        phase: 'compose',
        ensemble_type: 'plan-verify',
        run_id: 'plan-verify-test',
        started_at: handle.started_at,
      }]);

      const dirMode = (await stat(paths.dir)).mode & 0o777;
      const handleMode = (await stat(paths.handle)).mode & 0o777;
      strictEqual(dirMode, 0o700);
      strictEqual(handleMode, 0o600);
    });
  });

  it('run can retain prompt.xml only when explicitly requested', async () => {
    await withTmpRepo(async (repoRoot) => {
      const companionsRoot = await writeFakeCompanions(repoRoot);
      await runPeer({
        repoRoot,
        runId: 'retain-prompt-test',
        kind: 'manual',
        peer: 'claude',
        promptText: '<task>retain me</task>',
        outputFormat: 'json',
        cwd: repoRoot,
        retainPrompt: true,
        env: fakeEnv(companionsRoot),
      });

      const paths = peerRunPaths(repoRoot, 'retain-prompt-test');
      strictEqual(await readFile(paths.prompt, 'utf8'), '<task>retain me</task>');
      const handle = await readHandle(paths.handle);
      strictEqual(handle.prompt_retained, true);
    });
  });

  it('run keeps peer-run ledgers in the legacy home while legacy state exists', async () => {
    await withTmpRepo(async (repoRoot) => {
      const companionsRoot = await writeFakeCompanions(repoRoot);
      const legacyWorkflowDir = join(repoRoot, '.claude', 'agentic-engineer', 'workflows');
      await mkdir(legacyWorkflowDir, { recursive: true });
      await writeFile(join(legacyWorkflowDir, 'wf.md'), 'legacy workflow marker\n', 'utf8');

      await runPeer({
        repoRoot,
        runId: 'legacy-ledger',
        kind: 'manual',
        peer: 'claude',
        promptText: '<task>legacy</task>',
        outputFormat: 'json',
        cwd: repoRoot,
        env: fakeEnv(companionsRoot),
      });

      const legacyPaths = peerRunPaths(repoRoot, 'legacy-ledger', { home: 'legacy' });
      const canonicalPaths = peerRunPaths(repoRoot, 'legacy-ledger');
      strictEqual(await exists(legacyPaths.handle), true);
      strictEqual(await exists(canonicalPaths.handle), false);

      const status = await statusPeerRun({ repoRoot, runId: 'legacy-ledger' });
      strictEqual(status.paths.handle, legacyPaths.handle);
      strictEqual(status.handle.status, 'completed');
    });
  });

  it('run refuses to create peer-run state when canonical and legacy homes both contain state', async () => {
    await withTmpRepo(async (repoRoot) => {
      const companionsRoot = await writeFakeCompanions(repoRoot);
      await mkdir(join(repoRoot, '.agentic-plugins', 'state', 'engineer', 'workflows'), {
        recursive: true,
      });
      await writeFile(
        join(repoRoot, '.agentic-plugins', 'state', 'engineer', 'workflows', 'canonical.md'),
        'canonical marker\n',
        'utf8',
      );
      await mkdir(join(repoRoot, '.claude', 'agentic-engineer', 'peer-runs', 'legacy-run'), {
        recursive: true,
      });

      await rejects(
        runPeer({
          repoRoot,
          runId: 'blocked-ledger',
          kind: 'manual',
          peer: 'claude',
          promptText: '<task>blocked</task>',
          outputFormat: 'json',
          cwd: repoRoot,
          env: fakeEnv(companionsRoot),
        }),
        /Workflow storage migration blocked/,
      );
    });
  });
});

describe('peer-runner.mjs — status and output byte tracking', () => {
  it('updates stdout/stderr byte counts while a run is active', async () => {
    await withTmpRepo(async (repoRoot) => {
      const companionsRoot = await writeFakeCompanions(repoRoot);
      const child = spawn(process.execPath, [
        PEER_RUNNER_PATH,
        'run',
        '--repo-root', repoRoot,
        '--run-id', 'stream-run',
        '--kind', 'manual',
        '--peer', 'claude',
        '--prompt-text', '<task>stream</task>',
        '--output-format', 'text',
        '--cwd', repoRoot,
      ], {
        env: fakeEnv(companionsRoot, { FAKE_COMPANION_MODE: 'stream-text' }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const paths = peerRunPaths(repoRoot, 'stream-run');
      await waitFor(async () => {
        if (!(await exists(paths.handle))) return false;
        const handle = await readHandle(paths.handle);
        return handle.status === 'running' && handle.stdout_bytes > 0 && handle.stderr_bytes > 0;
      }, { message: 'active run with output byte counts' });

      const mid = await statusPeerRun({ repoRoot, runId: 'stream-run' });
      strictEqual(mid.live, true);
      ok(mid.handle.stdout_bytes >= Buffer.byteLength('alpha\n'));
      ok(mid.handle.stderr_bytes >= Buffer.byteLength('warn-a\n'));
      ok(mid.handle.last_output_at, 'last_output_at should be set after data');

      const close = await new Promise((resolveP) => {
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c) => { stdout += c; });
        child.stderr.on('data', (c) => { stderr += c; });
        child.on('close', (code) => resolveP({ code, stdout, stderr }));
      });
      strictEqual(close.code, 0, `stderr: ${close.stderr}`);

      const final = await readHandle(paths.handle);
      strictEqual(final.status, 'completed');
      strictEqual(final.stdout_bytes, Buffer.byteLength(await readFile(paths.stdout)));
      strictEqual(final.stderr_bytes, Buffer.byteLength(await readFile(paths.stderr)));
      ok((await readFile(paths.stdout, 'utf8')).includes('omega'));
    });
  });
});

describe('peer-runner.mjs — cancel', () => {
  it('cancel sends TERM then KILL after grace and marks the handle cancelled', async () => {
    await withTmpRepo(async (repoRoot) => {
      const companionsRoot = await writeFakeCompanions(repoRoot);
      const child = spawn(process.execPath, [
        PEER_RUNNER_PATH,
        'run',
        '--repo-root', repoRoot,
        '--run-id', 'cancel-run',
        '--kind', 'manual',
        '--peer', 'claude',
        '--prompt-text', '<task>cancel</task>',
        '--output-format', 'text',
        '--cwd', repoRoot,
      ], {
        env: fakeEnv(companionsRoot, { FAKE_COMPANION_MODE: 'ignore-term' }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const closePromise = new Promise((resolveP) => {
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c) => { stdout += c; });
        child.stderr.on('data', (c) => { stderr += c; });
        child.on('close', (code) => resolveP({ code, stdout, stderr }));
      });

      const paths = peerRunPaths(repoRoot, 'cancel-run');
      await waitFor(async () => {
        if (!(await exists(paths.handle))) return false;
        const handle = await readHandle(paths.handle);
        return handle.status === 'running' && handle.stdout_bytes > 0;
      }, { message: 'running cancellable peer run' });

      const cancelled = await cancelPeerRun({ repoRoot, runId: 'cancel-run', graceMs: 50 });
      if (!cancelled.ok) {
        const h = await readHandle(paths.handle);
        if (h.pgid) {
          try { process.kill(-h.pgid, 'SIGKILL'); } catch {}
        } else if (h.pid) {
          try { process.kill(h.pid, 'SIGKILL'); } catch {}
        }
      }
      strictEqual(cancelled.ok, true);
      strictEqual(cancelled.status, 'cancelled');

      const close = await closePromise;
      strictEqual(close.code, 1, 'peer-runner CLI returns non-zero for cancelled run result');

      const handle = await readHandle(paths.handle);
      strictEqual(handle.status, 'cancelled');
      strictEqual(handle.error_kind, 'cancelled');
      strictEqual(handle.pid, null);
      strictEqual(handle.pgid, null);
    });
  });

  it('PID fingerprint mismatch fails closed with unsupported_unverifiable', async () => {
    await withTmpRepo(async (repoRoot) => {
      await writeHandleFixture(repoRoot, 'fingerprint-mismatch', {
        status: 'running',
        pid: process.pid,
        pgid: null,
        process_fingerprint: {
          kind: process.platform === 'linux' ? 'linux_proc_starttime' : 'macos_lstart_command',
          starttime: 'definitely-not-this-process',
          lstart: 'definitely not this process',
          command: 'not-this-command',
        },
      });

      const result = await cancelPeerRun({
        repoRoot,
        runId: 'fingerprint-mismatch',
        graceMs: 10,
      });
      strictEqual(result.ok, false);
      strictEqual(result.reason, 'unsupported_unverifiable');

      const handle = await readHandle(peerRunPaths(repoRoot, 'fingerprint-mismatch').handle);
      strictEqual(handle.status, 'running');
    });
  });

  it('cancel-after-exit is idempotent and preserves completed result', async () => {
    await withTmpRepo(async (repoRoot) => {
      const companionsRoot = await writeFakeCompanions(repoRoot);
      await runPeer({
        repoRoot,
        runId: 'already-complete',
        kind: 'manual',
        peer: 'claude',
        promptText: '<task>done</task>',
        outputFormat: 'json',
        cwd: repoRoot,
        env: fakeEnv(companionsRoot),
      });

      const result = await cancelPeerRun({ repoRoot, runId: 'already-complete', graceMs: 10 });
      strictEqual(result.ok, true);
      strictEqual(result.reason, 'already_terminal');

      const handle = await readHandle(peerRunPaths(repoRoot, 'already-complete').handle);
      strictEqual(handle.status, 'completed');
      strictEqual(handle.error_kind, null);
    });
  });
});

describe('peer-runner.mjs — sweep and retention', () => {
  it('sweep lets envelope.json win over stale running status and surfaces completed_uncommitted', async () => {
    await withTmpRepo(async (repoRoot) => {
      const workflowPath = join(repoRoot, '.claude/agentic-engineer/workflows/wf.md');
      await mkdir(resolve(workflowPath, '..'), { recursive: true });
      await writeFile(workflowPath, [
        '---',
        'pending_ensemble:',
        '  - phase: compose',
        '    ensemble_type: plan-verify',
        '    run_id: envelope-wins',
        '---',
        '',
      ].join('\n'), 'utf8');

      const paths = await writeHandleFixture(repoRoot, 'envelope-wins', {
        status: 'running',
        pid: 99999999,
        workflow_path: workflowPath,
      });
      await writeFile(paths.envelope, JSON.stringify({
        status: 'success',
        peer_host: 'claude',
        peer_model: null,
        stdout: 'done',
        exit_code: 0,
      }), { mode: 0o600 });

      const report = await sweepPeerRuns({ repoRoot, staleGraceMs: 60_000 });
      deepStrictEqual(report.reconciled, [
        { run_id: 'envelope-wins', from: 'running', to: 'completed' },
      ]);

      const handle = await readHandle(paths.handle);
      strictEqual(handle.status, 'completed');

      const status = await statusPeerRun({ repoRoot, runId: 'envelope-wins' });
      strictEqual(status.derived_status, 'completed_uncommitted');

      const workflowText = await readFile(workflowPath, 'utf8');
      ok(workflowText.includes('run_id: envelope-wins'), 'sweep must not pop pending_ensemble');
    });
  });

  it('sweep marks no-envelope dead process as orphaned after stale grace', async () => {
    await withTmpRepo(async (repoRoot) => {
      const old = new Date(Date.now() - 10_000).toISOString();
      const paths = await writeHandleFixture(repoRoot, 'orphan-me', {
        status: 'running',
        pid: 99999999,
        updated_at: old,
        started_at: old,
      });

      const report = await sweepPeerRuns({ repoRoot, staleGraceMs: 0 });
      deepStrictEqual(report.reconciled, [
        { run_id: 'orphan-me', from: 'running', to: 'orphaned' },
      ]);

      const handle = await readHandle(paths.handle);
      strictEqual(handle.status, 'orphaned');
      strictEqual(handle.error_kind, 'orphaned');
    });
  });

  it('sweep treats PID fingerprint mismatch as not live', async () => {
    await withTmpRepo(async (repoRoot) => {
      const old = new Date(Date.now() - 10_000).toISOString();
      const paths = await writeHandleFixture(repoRoot, 'reused-pid', {
        status: 'running',
        pid: process.pid,
        updated_at: old,
        started_at: old,
        process_fingerprint: {
          kind: 'macos_lstart_command',
          lstart: 'Mon Jan  1 00:00:00 2001',
          command: 'definitely-not-this-process',
        },
      });

      const report = await sweepPeerRuns({ repoRoot, staleGraceMs: 0 });
      deepStrictEqual(report.reconciled, [
        { run_id: 'reused-pid', from: 'running', to: 'orphaned' },
      ]);

      const handle = await readHandle(paths.handle);
      strictEqual(handle.status, 'orphaned');
    });
  });

  it('retention prunes terminal runs by TTL and cap while preserving non-terminal runs', async () => {
    await withTmpRepo(async (repoRoot) => {
      const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      const mid = new Date(Date.now() - 1000).toISOString();
      const newest = new Date().toISOString();

      const oldPaths = await writeHandleFixture(repoRoot, 'old-terminal', {
        status: 'completed',
        completed_at: old,
        updated_at: old,
        exit_code: 0,
      });
      const midPaths = await writeHandleFixture(repoRoot, 'mid-terminal', {
        status: 'completed',
        completed_at: mid,
        updated_at: mid,
        exit_code: 0,
      });
      const newestPaths = await writeHandleFixture(repoRoot, 'newest-terminal', {
        status: 'completed',
        completed_at: newest,
        updated_at: newest,
        exit_code: 0,
      });
      const runningPaths = await writeHandleFixture(repoRoot, 'running-preserved', {
        status: 'running',
        updated_at: old,
        pid: process.pid,
        process_fingerprint: { kind: 'none' },
      });

      const report = await sweepPeerRuns({
        repoRoot,
        applyRetention: true,
        staleGraceMs: 60_000,
        retentionTtlDays: 1,
        retentionCap: 1,
      });

      const prunedIds = report.pruned.map((p) => p.run_id).sort();
      deepStrictEqual(prunedIds, ['mid-terminal', 'old-terminal']);
      strictEqual(await exists(oldPaths.dir), false);
      strictEqual(await exists(midPaths.dir), false);
      strictEqual(await exists(newestPaths.dir), true);
      strictEqual(await exists(runningPaths.dir), true);
    });
  });

  it('peer-now managed runs remain excluded from ensemble_results/frontmatter', async () => {
    await withTmpRepo(async (repoRoot) => {
      const companionsRoot = await writeFakeCompanions(repoRoot);
      const workflowPath = join(repoRoot, '.claude/agentic-engineer/workflows/wf.md');
      await mkdir(resolve(workflowPath, '..'), { recursive: true });
      const before = [
        '---',
        'schema_version: "1.1"',
        'ensemble_results: []',
        '---',
        'body',
        '',
      ].join('\n');
      await writeFile(workflowPath, before, 'utf8');

      await runPeer({
        repoRoot,
        runId: 'peer-now-side-channel',
        kind: 'peer-now',
        workflowPath,
        peer: 'claude',
        promptText: 'verbatim',
        outputFormat: 'text',
        cwd: repoRoot,
        env: fakeEnv(companionsRoot),
      });

      strictEqual(await readFile(workflowPath, 'utf8'), before);
      const handle = await readHandle(
        peerRunPaths(repoRoot, 'peer-now-side-channel', { home: 'legacy' }).handle,
      );
      strictEqual(handle.kind, 'peer-now');
      strictEqual(handle.status, 'completed');
    });
  });
});

describe('peer-runner.mjs — CLI misuse', () => {
  it('kind=ensemble requires workflow-path, phase, ensemble-type, and run-id', () => {
    const cp = spawnSync(process.execPath, [
      PEER_RUNNER_PATH,
      'run',
      '--kind', 'ensemble',
      '--peer', 'claude',
      '--prompt-text', 'x',
    ], { encoding: 'utf8' });

    strictEqual(cp.status, 2);
    ok(/run-id is required/.test(cp.stderr), cp.stderr);
  });
});
