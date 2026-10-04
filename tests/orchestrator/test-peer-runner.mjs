// plugins/orchestrator/scripts/peer-runner.mjs unit tests (ADR-0023 PR-D).
//
// Covers the orchestrator peer-runner primitive without invoking real peer CLIs:
// tests build a fake companions discovery root and fake companion script, then
// exercise ledger creation, status, cancellation, sweep reconciliation, and
// bounded retention under a temp repo root.
//
// Run via `node --test tests/orchestrator/test-peer-runner.mjs`.

import { describe, it } from 'node:test';
import { EventEmitter } from 'node:events';
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
const PEER_RUNNER_PATH = resolve(REPO_ROOT, 'plugins/orchestrator/scripts/peer-runner.mjs');
const STATE_PATH = resolve(REPO_ROOT, 'plugins/orchestrator/scripts/state.mjs');

const {
  HANDLE_SCHEMA_VERSION,
  peerRunPaths,
  readHandle,
  writeHandle,
  runPeer,
  statusPeerRun,
  cancelPeerRun,
  sweepPeerRuns,
  fingerprintForPid,
} = await import(PEER_RUNNER_PATH);
const { createWorkflow, readWorkflow } = await import(STATE_PATH);

async function withTmpRepo(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-peer-runner-test-'));
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

async function writeUnavailableCompanions(root) {
  const companionsRoot = join(root, 'unavailable-companions');
  await mkdir(companionsRoot, { recursive: true });
  await writeFile(join(companionsRoot, 'discover-peer.mjs'), `
export async function discoverPeerCompanion() {
  return { ok: false, reason: 'peer missing' };
}
`, 'utf8');
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
    plugin: 'orchestrator',
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
        verb: 'plan',
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
        phase: 'plan',
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
      strictEqual(handle.phase, 'plan');
      strictEqual(handle.ensemble_type, 'plan-verify');
      strictEqual(handle.status, 'completed');
      strictEqual(handle.prompt_retained, false);
      strictEqual(await exists(paths.prompt), false, 'prompt.xml should be opt-in debug data');
      // ADR-0061 §Decision 4 — the ledger records where the companion came from.
      strictEqual(handle.companion.source, 'env');
      strictEqual(handle.companion.caller_host, 'checkout');
      strictEqual(handle.companion.cross_host_fallback, false);
      strictEqual(/[\\/]fake-companions[\\/](claude|codex)-companion\.mjs$/.test(handle.companion.path), true, handle.companion.path);

      const envelope = await readJson(paths.envelope);
      strictEqual(envelope.status, 'success');
      strictEqual(envelope.stdout, 'fake ok');

      const { frontmatter } = await readWorkflow(workflowPath);
      deepStrictEqual(frontmatter.pending_ensemble, [{
        phase: 'plan',
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

  it('missing companion returns peer_cli_not_found without ledger or pending row', async () => {
    await withTmpRepo(async (repoRoot) => {
      const companionsRoot = await writeUnavailableCompanions(repoRoot);
      const { filePath: workflowPath } = await createWorkflow({
        repoRoot,
        verb: 'plan',
        originalRequest: 'missing companion test',
        gitBaseline: {
          branch: 'main',
          head: 'abc123',
          status_digest: '',
        },
        host: 'codex',
        currentPhase: 'phase-test',
        nextAction: 'test missing companion',
      });

      const result = await runPeer({
        repoRoot,
        runId: 'missing-companion',
        kind: 'ensemble',
        workflowPath,
        phase: 'plan',
        ensembleType: 'plan-verify',
        host: 'codex',
        peer: 'claude',
        promptText: '<task>hello</task>',
        outputFormat: 'json',
        cwd: repoRoot,
        env: fakeEnv(companionsRoot),
      });

      strictEqual(result.ok, false);
      strictEqual(result.kind, 'peer_cli_not_found');
      strictEqual(result.handle_path, null);
      strictEqual(await exists(peerRunPaths(repoRoot, 'missing-companion').dir), false);

      const { frontmatter } = await readWorkflow(workflowPath);
      deepStrictEqual(frontmatter.pending_ensemble ?? [], []);
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
      const legacyWorkflowDir = join(repoRoot, '.claude', 'agentic-orchestrator', 'workflows');
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
      await mkdir(join(repoRoot, '.agentic-plugins', 'state', 'orchestrator', 'workflows'), {
        recursive: true,
      });
      await writeFile(
        join(repoRoot, '.agentic-plugins', 'state', 'orchestrator', 'workflows', 'canonical.md'),
        'canonical marker\n',
        'utf8',
      );
      await mkdir(join(repoRoot, '.claude', 'agentic-orchestrator', 'peer-runs', 'legacy-run'), {
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

describe('peer-runner.mjs — spawn-synchronous lifecycle registration (2026-07-11 CI hang regression)', () => {
  // Root cause of the intermittent 30-minute CI hang: runPeer used to await
  // fingerprintForPid() and updateHandle() between spawn() and its listener
  // registrations. A fast-exiting companion (~30ms) emitted 'exit'/'close'
  // (and its only stdout chunk) into zero listeners during that window, the
  // late once('close') then never settled, and node:test's keep-alive held
  // the file process forever. The invariant below is deterministic in both
  // directions: 'spawn' is emitted from a later tick than spawn() itself, so
  // synchronous registration always wins and await-deferred registration
  // always loses — no load or timing dependence.
  it('attaches data/error/close observers before the companion emits spawn', async () => {
    await withTmpRepo(async (repoRoot) => {
      const companionsRoot = await writeFakeCompanions(repoRoot);
      const observed = [];
      const origEmit = EventEmitter.prototype.emit;
      EventEmitter.prototype.emit = function patchedEmit(ev, ...rest) {
        if (
          ev === 'spawn'
          && this?.constructor?.name === 'ChildProcess'
          && this.spawnargs?.some?.((a) => String(a).includes('-companion.mjs'))
        ) {
          observed.push({
            close: this.listenerCount('close'),
            error: this.listenerCount('error'),
            stdoutData: this.stdout?.listenerCount?.('data') ?? 0,
            stderrData: this.stderr?.listenerCount?.('data') ?? 0,
          });
        }
        return origEmit.apply(this, arguments);
      };
      try {
        const result = await runPeer({
          repoRoot,
          runId: 'sync-registration',
          kind: 'manual',
          peer: 'claude',
          promptText: '<task>sync</task>',
          outputFormat: 'json',
          cwd: repoRoot,
          env: fakeEnv(companionsRoot),
        });
        strictEqual(result.status, 'completed');
      } finally {
        EventEmitter.prototype.emit = origEmit;
      }
      strictEqual(observed.length, 1, 'exactly one companion spawn must be observed');
      ok(observed[0].close >= 1,
        `a close observer must already exist when spawn is emitted (got ${observed[0].close})`);
      ok(observed[0].error >= 1,
        `an error observer must already exist when spawn is emitted (got ${observed[0].error})`);
      ok(observed[0].stdoutData >= 1,
        `a stdout data collector must already exist when spawn is emitted (got ${observed[0].stdoutData})`);
      ok(observed[0].stderrData >= 1,
        `a stderr data collector must already exist when spawn is emitted (got ${observed[0].stderrData})`);
    });
  });

  it('preserves the full output of an immediately-exiting companion', async () => {
    await withTmpRepo(async (repoRoot) => {
      const companionsRoot = await writeFakeCompanions(repoRoot);
      const result = await runPeer({
        repoRoot,
        runId: 'exact-output',
        kind: 'manual',
        peer: 'claude',
        promptText: '<task>exact</task>',
        outputFormat: 'json',
        cwd: repoRoot,
        env: fakeEnv(companionsRoot),
      });
      strictEqual(result.status, 'completed');

      const paths = peerRunPaths(repoRoot, 'exact-output');
      const expectedStdout = JSON.stringify({
        status: 'success',
        peer_host: 'claude',
        peer_model: null,
        stdout: 'fake ok',
        exit_code: 0,
      });
      strictEqual(await readFile(paths.stdout, 'utf8'), expectedStdout,
        'the ledger stdout log must retain the exact companion output');
      strictEqual(await readFile(paths.stderr, 'utf8'), '',
        'the ledger stderr log must be empty for a silent companion');
      const handle = await readHandle(paths.handle);
      strictEqual(handle.stdout_bytes, Buffer.byteLength(expectedStdout));
      strictEqual(handle.stderr_bytes, 0);
      const envelope = await readJson(paths.envelope);
      strictEqual(envelope.stdout, 'fake ok');
    });
  });

  it('finalizes a terminal ledger when the spawn itself fails (no node on PATH)', async () => {
    await withTmpRepo(async (repoRoot) => {
      const companionsRoot = await writeFakeCompanions(repoRoot);
      // PATH must point at a real but EMPTY directory: merely omitting it
      // lets execvp fall back to the confstr default (/bin:/usr/bin), so the
      // spawn would succeed on any machine with a system node there.
      const emptyBin = join(repoRoot, 'empty-bin');
      await mkdir(emptyBin, { recursive: true });
      const rejections = [];
      const onRejection = (err) => rejections.push(err);
      process.on('unhandledRejection', onRejection);
      try {
        const result = await runPeer({
          repoRoot,
          runId: 'spawn-error',
          kind: 'manual',
          peer: 'claude',
          promptText: '<task>fail</task>',
          outputFormat: 'json',
          cwd: repoRoot,
          // spawn('node', …) cannot resolve the executable, so the child
          // emits 'error' (ENOENT) and then 'close' without 'spawn'.
          env: {
            PATH: emptyBin,
            AGENTIC_COMPANIONS_ROOT: companionsRoot,
          },
        });
        strictEqual(result.ok, false);
        strictEqual(result.status, 'failed');
        strictEqual(result.error_kind, 'ENOENT');

        const paths = peerRunPaths(repoRoot, 'spawn-error');
        const handle = await readHandle(paths.handle);
        strictEqual(handle.status, 'failed');
        strictEqual(handle.error_kind, 'ENOENT');
        strictEqual(handle.pid, null, 'a never-spawned child must not leave a recorded pid');
        strictEqual(handle.pgid, null);
        ok(handle.completed_at, 'the failed run must be terminal');
        strictEqual(handle.exit_code, null);
        strictEqual(await exists(paths.envelope), false, 'no envelope for a failed spawn');
        // Both ledger streams must be finalized (created then closed) — a
        // leaked stream here would re-orphan the event loop.
        strictEqual(await readFile(paths.stdout, 'utf8'), '');
        strictEqual(await readFile(paths.stderr, 'utf8'), '');
      } finally {
        process.removeListener('unhandledRejection', onRejection);
      }
      deepStrictEqual(rejections, [], 'a failed spawn must not surface unhandled rejections');
    });
  });

  it('finalizes as failed when a ledger stream errors instead of reporting completed', async () => {
    await withTmpRepo(async (repoRoot) => {
      const companionsRoot = await writeFakeCompanions(repoRoot);
      // Deterministically break the stdout ledger stream: destroy it with an
      // injected error the moment it opens. The run's companion still
      // succeeds, but a run whose ledger log was never persisted must NOT
      // report completed (its byte counters would point at a missing file).
      const origEmit = EventEmitter.prototype.emit;
      EventEmitter.prototype.emit = function patchedEmit(ev, ...rest) {
        if (
          ev === 'open'
          && this?.constructor?.name === 'WriteStream'
          && String(this.path ?? '').replaceAll('\\', '/').endsWith(`${'ledger-stream-error'}/stdout.log`)
        ) {
          queueMicrotask(() => {
            this.destroy(Object.assign(new Error('injected ledger failure'), { code: 'EIO' }));
          });
        }
        return origEmit.apply(this, arguments);
      };
      try {
        const result = await runPeer({
          repoRoot,
          runId: 'ledger-stream-error',
          kind: 'manual',
          peer: 'claude',
          promptText: '<task>ledger</task>',
          outputFormat: 'json',
          cwd: repoRoot,
          env: fakeEnv(companionsRoot),
        });
        strictEqual(result.ok, false, 'a run with an unpersisted ledger must not be ok');
        strictEqual(result.status, 'failed');
        strictEqual(result.error_kind, 'EIO');
      } finally {
        EventEmitter.prototype.emit = origEmit;
      }
      const handle = await readHandle(peerRunPaths(repoRoot, 'ledger-stream-error').handle);
      strictEqual(handle.status, 'failed');
      strictEqual(handle.error_kind, 'EIO');
      ok(handle.completed_at, 'the failed run must still be terminal');
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
      // Same lost-close class as the runPeer fix: the observers must exist
      // before the awaits below, or a child that finishes during the polling
      // window emits 'close' (and its output) into nothing and this test
      // hangs the whole file.
      const closePromise = new Promise((resolveP) => {
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (c) => { stdout += c; });
        child.stderr.on('data', (c) => { stderr += c; });
        child.on('close', (code) => resolveP({ code, stdout, stderr }));
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

      const close = await closePromise;
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
  it('cancel terminates verified processes and fails closed when process identity is unverifiable', async () => {
    await withTmpRepo(async (repoRoot) => {
      const readyFile = join(repoRoot, 'cancel-run.ready');
      const detached = process.platform !== 'win32';
      const child = spawn(process.execPath, ['-e', `
const { writeFileSync } = require('node:fs');
process.on('SIGTERM', () => {});
writeFileSync(process.env.FAKE_READY_FILE, 'ready\\n');
setInterval(() => {}, 1000);
`], {
        env: { ...process.env, FAKE_READY_FILE: readyFile },
        detached,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      const closePromise = new Promise((resolveP) => child.on('close', (code, signal) => resolveP({ code, signal })));

      try {
        await waitFor(() => exists(readyFile), { message: 'running cancellable peer process' });
        const processFingerprint = await fingerprintForPid(child.pid);
        await writeHandleFixture(repoRoot, 'cancel-run', {
          status: 'running',
          pid: child.pid,
          pgid: detached ? child.pid : null,
          process_fingerprint: processFingerprint,
        });

        const cancelled = await cancelPeerRun({ repoRoot, runId: 'cancel-run', graceMs: 50 });
        if (processFingerprint.kind === 'none') {
          strictEqual(cancelled.ok, false);
          strictEqual(cancelled.reason, 'unsupported_unverifiable');
          const handle = await readHandle(peerRunPaths(repoRoot, 'cancel-run').handle);
          strictEqual(handle.status, 'running');
          return;
        }
        strictEqual(cancelled.ok, true);
        strictEqual(cancelled.status, 'cancelled');

        await closePromise;
        const handle = await readHandle(peerRunPaths(repoRoot, 'cancel-run').handle);
        strictEqual(handle.status, 'cancelled');
        strictEqual(handle.error_kind, 'cancelled');
        strictEqual(handle.pid, null);
        strictEqual(handle.pgid, null);
      } finally {
        if (detached && child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch {}
        } else if (child.pid) {
          try { process.kill(child.pid, 'SIGKILL'); } catch {}
        }
      }
    });
  });

  it('cancel finalizes a run that exits on SIGTERM, without escalating to SIGKILL', async () => {
    await withTmpRepo(async (repoRoot) => {
      const readyFile = join(repoRoot, 'cancel-term.ready');
      const detached = process.platform !== 'win32';
      const child = spawn(process.execPath, ['-e', `
const { writeFileSync } = require('node:fs');
writeFileSync(process.env.FAKE_READY_FILE, 'ready\\n');
setInterval(() => {}, 1000);
`], {
        env: { ...process.env, FAKE_READY_FILE: readyFile },
        detached,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      const closePromise = new Promise((resolveP) => child.on('close', (code, signal) => resolveP({ code, signal })));

      try {
        await waitFor(() => exists(readyFile), { message: 'running cancellable peer process' });
        const processFingerprint = await fingerprintForPid(child.pid);
        await writeHandleFixture(repoRoot, 'cancel-term', {
          status: 'running',
          pid: child.pid,
          pgid: detached ? child.pid : null,
          process_fingerprint: processFingerprint,
        });

        const cancelled = await cancelPeerRun({ repoRoot, runId: 'cancel-term', graceMs: 5000 });
        if (processFingerprint.kind === 'none') {
          // Unverifiable platform: the test above pins the fail-closed path.
          strictEqual(cancelled.ok, false);
          return;
        }
        strictEqual(cancelled.ok, true);
        strictEqual(cancelled.status, 'cancelled');

        const { signal } = await closePromise;
        strictEqual(signal, 'SIGTERM', 'the run exits on SIGTERM; cancel must not escalate to SIGKILL');
        const handle = await readHandle(peerRunPaths(repoRoot, 'cancel-term').handle);
        strictEqual(handle.status, 'cancelled');
        strictEqual(handle.error_kind, 'cancelled');
        strictEqual(handle.pid, null);
        strictEqual(handle.pgid, null);
      } finally {
        if (detached && child.pid) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch {}
        } else if (child.pid) {
          try { process.kill(child.pid, 'SIGKILL'); } catch {}
        }
        await closePromise;
      }
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
      const workflowPath = join(repoRoot, '.claude/agentic-orchestrator/workflows/wf.md');
      await mkdir(resolve(workflowPath, '..'), { recursive: true });
      await writeFile(workflowPath, [
        '---',
        'pending_ensemble:',
        '  - phase: plan',
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

  it('sweep fails a run whose envelope.json does not parse (envelope_parse_error)', async () => {
    await withTmpRepo(async (repoRoot) => {
      const paths = await writeHandleFixture(repoRoot, 'corrupt-envelope', {
        status: 'running',
        pid: 99999999,
      });
      await writeFile(paths.envelope, 'not-json{', { mode: 0o600 });

      const report = await sweepPeerRuns({ repoRoot, staleGraceMs: 60_000 });
      deepStrictEqual(report.reconciled, [
        { run_id: 'corrupt-envelope', from: 'running', to: 'failed' },
      ]);

      const handle = await readHandle(paths.handle);
      strictEqual(handle.status, 'failed');
      strictEqual(handle.error_kind, 'envelope_parse_error');
      ok(handle.completed_at, 'the reconciled failure records completed_at');
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

  it('a sweep PREVIEW states what --apply would delete, and deletes nothing', async () => {
    // The defect: the whole retention block sat inside `if (applyRetention)`,
    // so a preview reported `pruned: []` and read as "nothing would be
    // deleted" while the very next `--apply` deleted runs. A preview that
    // understates a destructive action is worse than no preview.
    await withTmpRepo(async (repoRoot) => {
      const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      const newest = new Date().toISOString();
      const oldPaths = await writeHandleFixture(repoRoot, 'preview-old', {
        status: 'completed', completed_at: old, updated_at: old, exit_code: 0,
      });
      await writeHandleFixture(repoRoot, 'preview-newest', {
        status: 'completed', completed_at: newest, updated_at: newest, exit_code: 0,
      });

      const opts = { repoRoot, staleGraceMs: 60_000, retentionTtlDays: 1, retentionCap: 1 };
      const preview = await sweepPeerRuns({ ...opts, applyRetention: false });

      deepStrictEqual(preview.planned_prunes.map((p) => p.run_id), ['preview-old'],
        'the preview NAMES what apply would delete');
      deepStrictEqual(preview.pruned, [], 'and deletes nothing itself');
      strictEqual(preview.retention_applied, false, 'and says the retention half did not run');
      strictEqual(await exists(oldPaths.dir), true, 'the run is still on disk after a preview');

      // The two halves must agree: same predicate, same set.
      const applied = await sweepPeerRuns({ ...opts, applyRetention: true });
      strictEqual(applied.retention_applied, true);
      deepStrictEqual(
        applied.pruned.map((p) => p.run_id).sort(),
        preview.planned_prunes.map((p) => p.run_id).sort(),
        'apply deletes exactly what the preview planned — drift between them is the bug',
      );
      strictEqual(await exists(oldPaths.dir), false);
    });
  });

  it('a run whose updated_at does not parse is neither ranked nor deleted, and is NAMED', async () => {
    // A destructive default must not act on data it cannot evaluate. Silently
    // carrying undateable runs would also make the cap stop meaning anything,
    // so they are reported rather than merely skipped.
    await withTmpRepo(async (repoRoot) => {
      const newest = new Date().toISOString();
      const badPaths = await writeHandleFixture(repoRoot, 'undateable-run', {
        status: 'completed', completed_at: newest, updated_at: 'not-a-timestamp', exit_code: 0,
      });
      await writeHandleFixture(repoRoot, 'dateable-run', {
        status: 'completed', completed_at: newest, updated_at: newest, exit_code: 0,
      });

      const report = await sweepPeerRuns({
        repoRoot, applyRetention: true, staleGraceMs: 60_000, retentionTtlDays: 1, retentionCap: 0,
      });

      deepStrictEqual(report.undateable.map((u) => u.run_id), ['undateable-run']);
      ok(!report.pruned.some((p) => p.run_id === 'undateable-run'), 'it is never deleted');
      ok(!report.planned_prunes.some((p) => p.run_id === 'undateable-run'), 'and never planned for deletion');
      strictEqual(await exists(badPaths.dir), true, 'the payload survives');
    });
  });

  it('a cap tie keeps the lexicographically smallest run id', async () => {
    // Sorting on updated_at alone leaves ties to sort stability over readdir
    // order, so two runs sharing a timestamp can land on opposite sides of the
    // cap once that order changes — which it does on any directory that has
    // seen deletions, and on filesystems that return hash order rather than
    // alphabetical.
    //
    // HONEST LIMIT, measured rather than assumed: a mutation removing the
    // `run_id` tiebreaker SURVIVES this test on macOS/APFS, because readdir
    // there returns entries alphabetically and V8's sort is stable, so the
    // tiebreaker's answer and the incidental one coincide. It is kept because
    // it is correct and free, and this case pins the CONTRACT (which run
    // survives) rather than the mechanism. On a hash-order filesystem — ext4,
    // i.e. CI — removing it does change the outcome, and this assertion is
    // what would catch it there.
    await withTmpRepo(async (repoRoot) => {
      const same = new Date().toISOString();
      for (const id of ['tie-c', 'tie-a', 'tie-b']) {
        await writeHandleFixture(repoRoot, id, {
          status: 'completed', completed_at: same, updated_at: same, exit_code: 0,
        });
      }
      const report = await sweepPeerRuns({
        repoRoot, applyRetention: false, staleGraceMs: 60_000, retentionTtlDays: 365, retentionCap: 1,
      });
      deepStrictEqual(report.planned_prunes.map((p) => p.run_id).sort(), ['tie-b', 'tie-c'],
        'the tie keeps tie-a — the smallest id — and plans the other two');
    });
  });

  it('a run id recreated as a NEW running run is not deleted under the old run\'s verdict', async () => {
    // Computing the whole plan first is what makes the preview honest, and it
    // also widens the window between deciding to delete and deleting. A run id
    // is reusable once its directory is gone, so without a re-read the
    // replacement is destroyed under the old run's TTL verdict — live data, on
    // an operation the operator approved for something else entirely.
    await withTmpRepo(async (repoRoot) => {
      const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
      const paths = await writeHandleFixture(repoRoot, 'reused-id', {
        status: 'completed', completed_at: old, updated_at: old, exit_code: 0,
      });
      const opts = { repoRoot, staleGraceMs: 60_000, retentionTtlDays: 1, retentionCap: 0 };
      const preview = await sweepPeerRuns({ ...opts, applyRetention: false });
      deepStrictEqual(preview.planned_prunes.map((p) => p.run_id), ['reused-id']);

      // The window: the id is recycled by a new, LIVE run before apply lands.
      await writeHandleFixture(repoRoot, 'reused-id', {
        status: 'running', updated_at: new Date().toISOString(), pid: process.pid,
        process_fingerprint: { kind: 'none' },
      });

      const applied = await sweepPeerRuns({ ...opts, applyRetention: true });
      deepStrictEqual(applied.pruned, [], 'the live replacement is NOT deleted');
      strictEqual(await exists(paths.dir), true, 'the replacement payload survives');
      // MEASURED, and it corrects what this test first asserted: the protection
      // here comes from the apply pass RE-SCANNING (the replacement is
      // `running`, so it never enters `terminal` and is never planned), not
      // from the pre-delete re-verify — `prune_skipped` is empty. The re-verify
      // guards the strictly narrower window INSIDE one invocation, between the
      // scan and the deletion loop, which computing the whole plan up front is
      // what opened. Reaching that window from a test needs the scan paused
      // mid-flight (the Refine-verify peer used a FIFO); it is not covered
      // here, and saying so is better than an assertion that passes for the
      // wrong reason.
      deepStrictEqual(applied.prune_skipped, [], 'the re-scan handled it before the re-verify had to');
    });
  });

  it('the sweep report pins its full shape, not just the run ids', async () => {
    // Projecting ids let three mutations through: reporting every prune reason
    // as `ttl`, nulling every undateable `updated_at`, and printing `{}` from
    // the CLI. The operator reads the objects, so the test asserts the objects.
    await withTmpRepo(async (repoRoot) => {
      const now = new Date();
      const old = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
      const recent = new Date(now.getTime() - 1000).toISOString();
      await writeHandleFixture(repoRoot, 'by-ttl', {
        status: 'completed', completed_at: old, updated_at: old, exit_code: 0,
      });
      await writeHandleFixture(repoRoot, 'by-cap-a', {
        status: 'completed', completed_at: recent, updated_at: recent, exit_code: 0,
      });
      await writeHandleFixture(repoRoot, 'by-cap-b', {
        status: 'completed', completed_at: recent, updated_at: recent, exit_code: 0,
      });
      await writeHandleFixture(repoRoot, 'undateable-x', {
        status: 'completed', completed_at: recent, updated_at: 'not-a-timestamp', exit_code: 0,
      });

      const report = await sweepPeerRuns({
        repoRoot, applyRetention: false, staleGraceMs: 60_000, retentionTtlDays: 1, retentionCap: 1,
      });
      // `ttl` and `cap` must be distinguishable — they are different operator facts.
      const byId = new Map(report.planned_prunes.map((p) => [p.run_id, p.reason]));
      strictEqual(byId.get('by-ttl'), 'ttl', 'an expired run is reported as ttl');
      strictEqual(byId.get('by-cap-b'), 'cap', 'an over-cap run is reported as cap, not ttl');
      // The undateable entry carries the offending VALUE, not a null placeholder.
      deepStrictEqual(report.undateable, [{ run_id: 'undateable-x', updated_at: 'not-a-timestamp' }]);
      deepStrictEqual(report.prune_skipped, []);
    });
  });

  it('manual managed runs remain excluded from ensemble_results/frontmatter', async () => {
    await withTmpRepo(async (repoRoot) => {
      const companionsRoot = await writeFakeCompanions(repoRoot);
      const workflowPath = join(repoRoot, '.claude/agentic-orchestrator/workflows/wf.md');
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
        runId: 'manual-side-channel',
        kind: 'manual',
        workflowPath,
        peer: 'claude',
        promptText: 'verbatim',
        outputFormat: 'text',
        cwd: repoRoot,
        env: fakeEnv(companionsRoot),
      });

      strictEqual(await readFile(workflowPath, 'utf8'), before);
      const handle = await readHandle(
        peerRunPaths(repoRoot, 'manual-side-channel', { home: 'legacy' }).handle,
      );
      strictEqual(handle.kind, 'manual');
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
