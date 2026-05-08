// plugins/engineer — checkpoint integration tests (ADR-0017 §sub-decision 2).
//
// Validation contract per ADR-0017 §sub-decision 2: cover set, read, and
// SessionStart re-injection of summary. Unit-level setCheckpoint behavior
// (latest_checkpoint shape, host_history append, schema preservation,
// boolean/required-field strictness) lives in tests/engineer/test-state.mjs;
// this file exercises:
//   - the `checkpoint-set` CLI subcommand spawned as a child process
//     (the same surface /engineer:checkpoint Phase 2 invokes)
//   - SessionStart hook stdout — `checkpoint_summary` + `checkpoint_at`
//     re-injection contract
//
// Run via `node --test tests/engineer/test-checkpoint.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const STATE_PATH = resolve(REPO_ROOT, 'plugins/engineer/scripts/state.mjs');
const SESSION_START = resolve(
  REPO_ROOT,
  'plugins/engineer/adapters/claude/hooks/session-start.mjs',
);
const { createWorkflow, listWorkflowFiles, readWorkflow } = await import(
  STATE_PATH
);

const MIN_BASELINE = {
  branch: 'test',
  head: '0'.repeat(40),
  status_digest:
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
};

async function withTmpRepo(fn, { branch = 'test' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'engineer-checkpoint-test-'));
  try {
    // -b <branch> ensures `git branch --show-current` returns the
    // expected name for ADR-0018 §sub-2 branch-keyed lookup.
    await runCmd('git', ['init', '-q', '-b', branch], { cwd: dir });
    await runCmd('git', ['config', 'user.email', 'test@test'], { cwd: dir });
    await runCmd('git', ['config', 'user.name', 'test'], { cwd: dir });
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolveP, reject) => {
    const child = spawn(cmd, args, {
      ...opts,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${cmd} ${args.join(' ')} exit ${code}: ${stderr}`));
      } else resolveP();
    });
  });
}

function runState(args) {
  return new Promise((resolveP) => {
    const child = spawn('node', [STATE_PATH, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolveP({ code, stdout, stderr }));
  });
}

function runHook(payload) {
  return new Promise((resolveP, reject) => {
    const child = spawn('node', [SESSION_START], {
      stdio: ['pipe', 'pipe', 'pipe'],
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

function parseSummary(stdout) {
  const m = stdout.match(/\{.*\}/);
  if (!m) throw new Error(`no JSON payload in stdout: ${stdout}`);
  return JSON.parse(m[0]);
}

describe('checkpoint — checkpoint-set CLI subcommand', () => {
  it('sets latest_checkpoint and appends host_history "checkpointed"', async () => {
    await withTmpRepo(async (dir) => {
      await createWorkflow({
        repoRoot: dir,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'r',
      });
      const [path] = await listWorkflowFiles(dir);

      const r = await runState([
        'checkpoint-set',
        '--workflow-path',
        path,
        '--host',
        'claude',
        '--summary',
        'PR3 work in progress',
      ]);
      strictEqual(r.code, 0, `stderr=${r.stderr}`);
      strictEqual(r.stdout.trim(), path);

      const { frontmatter } = await readWorkflow(path);
      strictEqual(frontmatter.latest_checkpoint.summary, 'PR3 work in progress');
      strictEqual(typeof frontmatter.latest_checkpoint.at, 'string');
      ok(/^\d{4}-\d{2}-\d{2}T/.test(frontmatter.latest_checkpoint.at));
      const last = frontmatter.host_history.at(-1);
      strictEqual(last.event, 'checkpointed');
      strictEqual(last.host, 'claude');
    });
  });

  it('rejects empty --summary', async () => {
    await withTmpRepo(async (dir) => {
      await createWorkflow({
        repoRoot: dir,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'r',
      });
      const [path] = await listWorkflowFiles(dir);

      const r = await runState([
        'checkpoint-set',
        '--workflow-path',
        path,
        '--host',
        'claude',
        '--summary',
        '',
      ]);
      ok(
        r.code !== 0,
        `expected non-zero exit on empty summary; stdout=${r.stdout} stderr=${r.stderr}`,
      );
    });
  });

  it('overwrites prior latest_checkpoint (most-recent wins) and appends each event', async () => {
    await withTmpRepo(async (dir) => {
      await createWorkflow({
        repoRoot: dir,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'r',
      });
      const [path] = await listWorkflowFiles(dir);

      const r1 = await runState([
        'checkpoint-set',
        '--workflow-path',
        path,
        '--host',
        'claude',
        '--summary',
        'first',
      ]);
      strictEqual(r1.code, 0);

      const r2 = await runState([
        'checkpoint-set',
        '--workflow-path',
        path,
        '--host',
        'claude',
        '--summary',
        'second',
      ]);
      strictEqual(r2.code, 0);

      const { frontmatter } = await readWorkflow(path);
      strictEqual(frontmatter.latest_checkpoint.summary, 'second');
      const checkpointed = frontmatter.host_history.filter(
        (h) => h.event === 'checkpointed',
      );
      strictEqual(checkpointed.length, 2);
    });
  });
});

describe('checkpoint — SessionStart re-injection (ADR-0017 sub-2 contract)', () => {
  it('payload omits checkpoint_summary + checkpoint_at when no checkpoint set', async () => {
    await withTmpRepo(async (dir) => {
      await createWorkflow({
        repoRoot: dir,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'r',
      });

      const r = await runHook({ cwd: dir });
      strictEqual(r.code, 0);
      const summary = parseSummary(r.stdout);
      strictEqual(
        'checkpoint_summary' in summary,
        false,
        'checkpoint_summary should be omitted, not empty-string',
      );
      strictEqual('checkpoint_at' in summary, false);
    });
  });

  it('payload re-injects checkpoint_summary + ISO-8601 checkpoint_at after checkpoint-set', async () => {
    await withTmpRepo(async (dir) => {
      await createWorkflow({
        repoRoot: dir,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'r',
      });
      const [path] = await listWorkflowFiles(dir);
      await runState([
        'checkpoint-set',
        '--workflow-path',
        path,
        '--host',
        'claude',
        '--summary',
        'PR3 done; PR4 next',
      ]);

      const r = await runHook({ cwd: dir });
      strictEqual(r.code, 0);
      const summary = parseSummary(r.stdout);
      strictEqual(summary.checkpoint_summary, 'PR3 done; PR4 next');
      ok(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(summary.checkpoint_at),
        `checkpoint_at not ISO-8601 prefix: ${summary.checkpoint_at}`,
      );
    });
  });

  it('long checkpoint_summary truncated to 256 chars in SessionStart payload (disk record uncapped)', async () => {
    await withTmpRepo(async (dir) => {
      await createWorkflow({
        repoRoot: dir,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'r',
      });
      const [path] = await listWorkflowFiles(dir);
      const long = 'x'.repeat(500);
      await runState([
        'checkpoint-set',
        '--workflow-path',
        path,
        '--host',
        'claude',
        '--summary',
        long,
      ]);

      const { frontmatter } = await readWorkflow(path);
      strictEqual(frontmatter.latest_checkpoint.summary.length, 500);

      const r = await runHook({ cwd: dir });
      const summary = parseSummary(r.stdout);
      strictEqual(summary.checkpoint_summary.length, 256);
    });
  });
});
