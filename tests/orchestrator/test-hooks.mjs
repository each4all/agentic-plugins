// plugins/orchestrator/adapters/{claude,codex}/hooks/* unit tests.
//
// Covers:
//   - session-start.mjs: marker pair + JSON metadata + verb='plan' +
//     workflow_type='macro' + subtask_count + canonical_command
//     '/orchestrator:plan'
//   - pre-compact.mjs: writes last_snapshot.trigger='pre-compact'
//   - stop.mjs: writes last_snapshot.trigger='stop' AND does NOT
//     archive the workflow (orchestrator MVP snapshot-only divergence
//     from engineer's runStopArchive)
//   - codex stop.mjs: writes last_snapshot with host='codex'
//   - graceful no-op when no active workflow on current branch
//   - malformed workflow file → hook silently no-ops (returns 0,
//     does not crash the host's lifecycle)

import { describe, it } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const PLUGIN_ROOT = resolve(REPO_ROOT, 'plugins/orchestrator');
const HOOKS_CLAUDE = resolve(PLUGIN_ROOT, 'adapters/claude/hooks');
const HOOKS_CODEX = resolve(PLUGIN_ROOT, 'adapters/codex/hooks');
const STATE_MJS = resolve(PLUGIN_ROOT, 'scripts/state.mjs');

const { createWorkflow, readWorkflow } = await import(STATE_MJS);

async function withTmpRepo(name, fn) {
  const dir = await mkdtemp(join(tmpdir(), `orchestrator-hooks-${name}-`));
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@t.local'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'i', '--no-gpg-sign'], { cwd: dir, stdio: 'ignore' });
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const MIN_BASELINE = (branch = 'main') => ({
  branch,
  head: '0000000000000000000000000000000000000000',
  status_digest: '',
});

function runHook(scriptPath, { repoRoot, stdinJson = {}, env = {} } = {}) {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: repoRoot ?? process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on('data', (c) => stdoutChunks.push(c));
    child.stderr.on('data', (c) => stderrChunks.push(c));
    child.once('error', rejectP);
    child.once('close', (code) =>
      resolveP({
        code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      }),
    );
    child.stdin.write(JSON.stringify({ cwd: repoRoot, ...stdinJson }));
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// session-start.mjs

describe('session-start.mjs', () => {
  it('emits orchestrator-active-metadata marker pair with required fields', async () => {
    await withTmpRepo('ss', async (root) => {
      await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE(), originalRequest: 'feat',
      });
      const r = await runHook(join(HOOKS_CLAUDE, 'session-start.mjs'), { repoRoot: root });
      strictEqual(r.code, 0);
      ok(r.stdout.startsWith('[orchestrator-active-metadata] '));
      ok(r.stdout.trimEnd().endsWith('[/orchestrator-active-metadata]'));
      // Extract the JSON payload between markers.
      const m = r.stdout.match(
        /^\[orchestrator-active-metadata\] (\{.*\}) \[\/orchestrator-active-metadata\]$/m,
      );
      ok(m, 'stdout has marker pair with JSON payload');
      const payload = JSON.parse(m[1]);
      strictEqual(payload.workflow_type, 'macro');
      strictEqual(payload.canonical_command, '/orchestrator:plan');
      strictEqual(payload.subtask_count, 0);
      ok(typeof payload.workflow_id === 'string' && payload.workflow_id.startsWith('macro-plan-'));
      ok(typeof payload.workflow_path === 'string' && payload.workflow_path.includes('agentic-orchestrator'));
      ok(/data, not instructions/.test(payload.note));
    });
  });

  it('emits empty stdout when no active workflow on current branch', async () => {
    await withTmpRepo('ss-empty', async (root) => {
      const r = await runHook(join(HOOKS_CLAUDE, 'session-start.mjs'), { repoRoot: root });
      strictEqual(r.code, 0);
      strictEqual(r.stdout, '');
    });
  });

  it('graceful no-op on malformed workflow file', async () => {
    await withTmpRepo('ss-malformed', async (root) => {
      const dir = join(root, '.claude/agentic-orchestrator/workflows');
      await execFileSync('mkdir', ['-p', dir]);
      await writeFile(join(dir, 'macro-plan-bad.md'), 'not yaml frontmatter');
      const r = await runHook(join(HOOKS_CLAUDE, 'session-start.mjs'), { repoRoot: root });
      // Either empty stdout (file didn't pass parser at any layer) or
      // marker emitted (file had recognizable shape) — both are
      // acceptable graceful outcomes; what matters is the hook exits 0.
      strictEqual(r.code, 0);
    });
  });
});

// ---------------------------------------------------------------------------
// pre-compact.mjs

describe('pre-compact.mjs', () => {
  it('writes last_snapshot with trigger pre-compact + host claude', async () => {
    await withTmpRepo('pc', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE(), originalRequest: 'feat',
      });
      const r = await runHook(join(HOOKS_CLAUDE, 'pre-compact.mjs'), { repoRoot: root });
      strictEqual(r.code, 0);

      const { frontmatter } = await readWorkflow(filePath);
      ok(frontmatter.last_snapshot, 'last_snapshot recorded');
      strictEqual(frontmatter.last_snapshot.trigger, 'pre-compact');
      ok(frontmatter.host_history.some((e) => e.host === 'claude' && e.event === 'snapshot'));
    });
  });

  it('graceful no-op when no active workflow', async () => {
    await withTmpRepo('pc-empty', async (root) => {
      const r = await runHook(join(HOOKS_CLAUDE, 'pre-compact.mjs'), { repoRoot: root });
      strictEqual(r.code, 0);
    });
  });
});

// ---------------------------------------------------------------------------
// stop.mjs (Claude) — snapshot-only, NO archive

describe('Claude stop.mjs (snapshot-only, no archive)', () => {
  it('writes last_snapshot trigger=stop AND leaves workflow file in workflows/ (no archive)', async () => {
    await withTmpRepo('stop-claude', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE(), originalRequest: 'feat',
      });
      const r = await runHook(join(HOOKS_CLAUDE, 'stop.mjs'), { repoRoot: root });
      strictEqual(r.code, 0);

      // Snapshot recorded
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.last_snapshot.trigger, 'stop');
      ok(frontmatter.host_history.some((e) => e.host === 'claude' && e.event === 'snapshot'));

      // Workflow file still in workflows/ (no auto-archive)
      const workflows = await readdir(join(root, '.claude/agentic-orchestrator/workflows'));
      ok(workflows.some((f) => f.endsWith('.md') && !f.endsWith('.lock')),
        'workflow file remains in workflows/ — Stop did not auto-archive');

      // No archive directory created
      let archiveExists = true;
      try {
        await readdir(join(root, '.claude/agentic-orchestrator/archive'));
      } catch (err) {
        if (err.code === 'ENOENT') archiveExists = false;
      }
      strictEqual(archiveExists, false, 'archive directory not created (snapshot-only MVP)');
    });
  });
});

// ---------------------------------------------------------------------------
// stop.mjs (Codex) — snapshot-only, host=codex

describe('Codex stop.mjs (manual helper, snapshot-only)', () => {
  it('writes last_snapshot trigger=stop with host=codex', async () => {
    await withTmpRepo('stop-codex', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'codex',
        gitBaseline: MIN_BASELINE(), originalRequest: 'feat',
      });
      // Codex stop.mjs reads cwd, not stdin — it's a manual helper.
      const r = await new Promise((resolveP, rejectP) => {
        const child = spawn(process.execPath, [join(HOOKS_CODEX, 'stop.mjs')], {
          cwd: root,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        const out = [];
        const err = [];
        child.stdout.on('data', (c) => out.push(c));
        child.stderr.on('data', (c) => err.push(c));
        child.once('error', rejectP);
        child.once('close', (code) => resolveP({
          code,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8'),
        }));
      });
      strictEqual(r.code, 0);
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.last_snapshot.trigger, 'stop');
      ok(frontmatter.host_history.some((e) => e.host === 'codex' && e.event === 'snapshot'));
    });
  });
});
