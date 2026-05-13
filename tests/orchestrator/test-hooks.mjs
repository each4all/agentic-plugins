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
      strictEqual('checkpoint_summary' in payload, false);
      strictEqual('checkpoint_at' in payload, false);
      ok(typeof payload.workflow_id === 'string' && payload.workflow_id.startsWith('macro-plan-'));
      ok(typeof payload.workflow_path === 'string' && payload.workflow_path.includes('state/orchestrator'));
      ok(/data, not instructions/.test(payload.note));
    });
  });

  it('re-injects latest_checkpoint summary and caps display length', async () => {
    await withTmpRepo('ss-checkpoint', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE(), originalRequest: 'feat',
      });
      const { setCheckpoint, readWorkflow: readWorkflowLocal } = await import(STATE_MJS);
      const long = 'x'.repeat(500);
      await setCheckpoint({
        workflowPath: filePath,
        host: 'codex',
        summary: long,
      });
      const { frontmatter } = await readWorkflowLocal(filePath);
      strictEqual(frontmatter.latest_checkpoint.summary.length, 500);

      const r = await runHook(join(HOOKS_CLAUDE, 'session-start.mjs'), { repoRoot: root });
      strictEqual(r.code, 0);
      const m = r.stdout.match(
        /^\[orchestrator-active-metadata\] (\{.*\}) \[\/orchestrator-active-metadata\]$/m,
      );
      ok(m, 'stdout has marker pair with JSON payload');
      const payload = JSON.parse(m[1]);
      strictEqual(payload.checkpoint_summary.length, 256);
      ok(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(payload.checkpoint_at),
        `checkpoint_at not ISO-8601 prefix: ${payload.checkpoint_at}`,
      );
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
      const dir = join(root, '.agentic-plugins/state/orchestrator/workflows');
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
// stop.mjs (Claude) — snapshot + macro auto-archive (ADR-0019 PR-E §5)

describe('Claude stop.mjs — snapshot + macro auto-archive', () => {
  it('writes last_snapshot trigger=stop for every macro, regardless of gate verdict', async () => {
    await withTmpRepo('stop-claude-snapshot', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE(), originalRequest: 'feat',
      });
      const r = await runHook(join(HOOKS_CLAUDE, 'stop.mjs'), { repoRoot: root });
      strictEqual(r.code, 0);
      // Snapshot recorded — runMacroStopArchive snapshots before evaluation.
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.last_snapshot.trigger, 'stop');
      ok(frontmatter.host_history.some((e) => e.host === 'claude' && e.event === 'snapshot'));
    });
  });

  it('archives the macro when all gates pass (terminal_marker + macro phase + all subtasks terminal + no engineer children)', async () => {
    await withTmpRepo('stop-claude-archive', async (root) => {
      // Setup macro in finalized state via direct frontmatter manipulation
      // (the runbook commands ship in T9/T10; tests exercise the hook
      // directly here).
      const { filePath } = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE(), originalRequest: 'feat',
      });
      // Import setMacroTerminal + setPlan to bring the macro to a
      // terminal state with no live engineer children.
      const { setMacroTerminal, setPlan } = await import(STATE_MJS);
      await setPlan({
        workflowPath: filePath,
        host: 'claude',
        subtasks: [
          { id: 'T1', verb: 'compose', branch: 'feat/t1', blocked_by: [], status: 'completed' },
        ],
      });
      await setMacroTerminal({
        workflowPath: filePath,
        host: 'claude',
        terminalPhase: 'finalized',
        terminalMarker: true,
      });
      const r = await runHook(join(HOOKS_CLAUDE, 'stop.mjs'), { repoRoot: root });
      strictEqual(r.code, 0, `stderr: ${r.stderr}`);
      // Workflow file has moved to archive/
      const live = await readdir(join(root, '.agentic-plugins/state/orchestrator/workflows'))
        .then((es) => es.filter((e) => e.endsWith('.md')));
      strictEqual(live.length, 0, 'workflow file should have been archived');
      const archived = await readdir(join(root, '.agentic-plugins/state/orchestrator/archive'))
        .then((es) => es.filter((e) => e.endsWith('.md')));
      strictEqual(archived.length, 1, 'archive should contain the macro file');
    });
  });

  it('does NOT archive when an engineer child references this macro (A4 blocks)', async () => {
    await withTmpRepo('stop-claude-blocked-by-child', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE(), originalRequest: 'feat',
      });
      const { setMacroTerminal, setPlan } = await import(STATE_MJS);
      await setPlan({
        workflowPath: filePath,
        host: 'claude',
        subtasks: [
          { id: 'T1', verb: 'compose', branch: 'feat/t1', blocked_by: [], status: 'completed' },
        ],
      });
      await setMacroTerminal({
        workflowPath: filePath,
        host: 'claude',
        terminalPhase: 'finalized',
        terminalMarker: true,
      });
      // Place an engineer child referencing this macro id
      const macroId = filePath.split('/').pop().replace(/\.md$/, '');
      const engDir = join(root, '.agentic-plugins/state/engineer/workflows');
      await execFileSync('mkdir', ['-p', engDir]);
      await writeFile(
        join(engDir, 'compose-20260511T010000Z-aaaaaa.md'),
        [
          '---',
          'schema: "1.1"',
          'workflow_id: "compose-20260511T010000Z-aaaaaa"',
          `parent_workflow: ${JSON.stringify(macroId)}`,
          'originating_subtask: "T1"',
          '---',
          '# engineer child',
          '',
        ].join('\n'),
      );
      const r = await runHook(join(HOOKS_CLAUDE, 'stop.mjs'), { repoRoot: root });
      strictEqual(r.code, 0);
      // Workflow still live (engineer child blocks A4)
      const live = await readdir(join(root, '.agentic-plugins/state/orchestrator/workflows'))
        .then((es) => es.filter((e) => e.endsWith('.md')));
      strictEqual(live.length, 1);
    });
  });

  it('does NOT archive when terminal_marker is false (A1 blocks)', async () => {
    await withTmpRepo('stop-claude-no-terminal-marker', async (root) => {
      await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE(), originalRequest: 'feat',
      });
      // No setMacroTerminal call — terminal_marker absent.
      const r = await runHook(join(HOOKS_CLAUDE, 'stop.mjs'), { repoRoot: root });
      strictEqual(r.code, 0);
      const live = await readdir(join(root, '.agentic-plugins/state/orchestrator/workflows'))
        .then((es) => es.filter((e) => e.endsWith('.md')));
      strictEqual(live.length, 1, 'workflow remains live without terminal_marker');
    });
  });

  it('graceful no-op when no macros exist (empty workflows/)', async () => {
    await withTmpRepo('stop-claude-empty', async (root) => {
      const r = await runHook(join(HOOKS_CLAUDE, 'stop.mjs'), { repoRoot: root });
      strictEqual(r.code, 0);
    });
  });
});

// ---------------------------------------------------------------------------
// stop.mjs (Codex) — manual helper, snapshot + macro auto-archive parity

describe('Codex stop.mjs — manual helper with macro auto-archive parity', () => {
  async function runCodexStop(root) {
    return new Promise((resolveP, rejectP) => {
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
  }

  it('writes last_snapshot trigger=stop with host=codex', async () => {
    await withTmpRepo('stop-codex-snapshot', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'codex',
        gitBaseline: MIN_BASELINE(), originalRequest: 'feat',
      });
      const r = await runCodexStop(root);
      strictEqual(r.code, 0);
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.last_snapshot.trigger, 'stop');
      ok(frontmatter.host_history.some((e) => e.host === 'codex' && e.event === 'snapshot'));
    });
  });

  it('archives the macro when all gates pass (Codex parity)', async () => {
    await withTmpRepo('stop-codex-archive', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'codex',
        gitBaseline: MIN_BASELINE(), originalRequest: 'feat',
      });
      const { setMacroTerminal, setPlan } = await import(STATE_MJS);
      await setPlan({
        workflowPath: filePath,
        host: 'codex',
        subtasks: [
          { id: 'T1', verb: 'compose', branch: 'feat/t1', blocked_by: [], status: 'abandoned' },
        ],
      });
      await setMacroTerminal({
        workflowPath: filePath,
        host: 'codex',
        terminalPhase: 'aborted',
        terminalMarker: true,
      });
      const r = await runCodexStop(root);
      strictEqual(r.code, 0, `stderr: ${r.stderr}`);
      const live = await readdir(join(root, '.agentic-plugins/state/orchestrator/workflows'))
        .then((es) => es.filter((e) => e.endsWith('.md')));
      strictEqual(live.length, 0, 'workflow archived under Codex helper too');
    });
  });
});
