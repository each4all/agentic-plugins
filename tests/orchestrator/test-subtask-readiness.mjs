// tests/orchestrator/test-subtask-readiness.mjs
//
// Docket C22 follow-through (ADR-0062 §Decision 5): /orchestrator:next used
// to build its "blocked" diagnosis from the status alone, so a subtask whose
// predecessors had all completed was reported as waiting on them. The facts
// now come from the plan: `subtask-readiness` answers for one subtask (the
// explicit-id path), and `next-ready` carries the same facts when nothing is
// dispatchable.

import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual, ok } from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const STATE_MJS = resolve(REPO_ROOT, 'plugins/orchestrator/scripts/state.mjs');

const {
  createWorkflow,
  setPlan,
  updateSubtask,
  parseWorkflowFile,
  assembleWorkflowFile,
} = await import(STATE_MJS);

async function withTmpRepo(name, fn) {
  const dir = await mkdtemp(join(tmpdir(), `orchestrator-readiness-${name}-`));
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const st = (id, extra = {}) => ({
  id, verb: 'compose', branch: `feat/${id.toLowerCase()}`, blocked_by: [], status: 'pending', ...extra,
});

async function newMacro(repoRoot, subtasks) {
  const { filePath } = await createWorkflow({
    repoRoot, verb: 'plan', host: 'claude',
    gitBaseline: { branch: 'main', head: '0'.repeat(40), status_digest: '' },
    originalRequest: 'readiness fixture',
  });
  await setPlan({ workflowPath: filePath, host: 'claude', subtasks });
  return filePath;
}

// Rewrite statuses directly, as a file written before the shared unblock
// pass would hold them.
async function forceStatus(filePath, statuses) {
  const { frontmatter, body } = parseWorkflowFile(await readFile(filePath, 'utf8'));
  for (const s of frontmatter.plan.subtasks) {
    if (s.id in statuses) s.status = statuses[s.id];
  }
  await writeFile(filePath, assembleWorkflowFile(frontmatter, body));
}

function cli(args) {
  const r = spawnSync(process.execPath, [STATE_MJS, ...args], { encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr, json: r.stdout.trim() ? JSON.parse(r.stdout) : null };
}

describe('subtask-readiness', () => {
  it('reports a blocked subtask whose predecessors all completed as stale, not waiting', async () => {
    await withTmpRepo('stale', async (root) => {
      const filePath = await newMacro(root, [
        st('A', { status: 'in_progress' }), st('B', { blocked_by: ['A'], status: 'blocked' }),
      ]);
      await updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        engineerWorkflowId: 'eng-A', status: 'completed', commit: 'aaa',
      });
      await forceStatus(filePath, { B: 'blocked' });
      const r = cli(['subtask-readiness', `--workflow-path=${filePath}`, '--subtask-id=B']);
      strictEqual(r.status, 0, r.stderr);
      deepStrictEqual(r.json, {
        id: 'B', status: 'blocked', blocked_by: ['A'], waiting_on: [], stale_blocked: true, ready: false,
      });
    });
  });

  it('names the predecessors a pending or blocked subtask still waits on', async () => {
    await withTmpRepo('waiting', async (root) => {
      const filePath = await newMacro(root, [
        st('A', { status: 'in_progress' }), st('C'),
        st('B', { blocked_by: ['A', 'C'], status: 'blocked' }),
      ]);
      const r = cli(['subtask-readiness', `--workflow-path=${filePath}`, '--subtask-id=B']);
      deepStrictEqual(r.json.waiting_on, ['A', 'C']);
      strictEqual(r.json.stale_blocked, false);
      await forceStatus(filePath, { B: 'pending' });
      const p = cli(['subtask-readiness', `--workflow-path=${filePath}`, '--subtask-id=B']);
      strictEqual(p.json.ready, false);
      deepStrictEqual(p.json.waiting_on, ['A', 'C']);
    });
  });

  it('answers for the chosen subtask even when another one is ready', async () => {
    await withTmpRepo('explicit', async (root) => {
      const filePath = await newMacro(root, [
        st('A', { status: 'in_progress' }), st('R'), st('B', { blocked_by: ['A'], status: 'blocked' }),
      ]);
      const r = cli(['subtask-readiness', `--workflow-path=${filePath}`, '--subtask-id=B']);
      deepStrictEqual(r.json.waiting_on, ['A']);
      const ready = cli(['subtask-readiness', `--workflow-path=${filePath}`, '--subtask-id=R']);
      strictEqual(ready.json.ready, true);
    });
  });

  it('fails on an unknown subtask id', async () => {
    await withTmpRepo('unknown', async (root) => {
      const filePath = await newMacro(root, [st('A')]);
      const r = cli(['subtask-readiness', `--workflow-path=${filePath}`, '--subtask-id=Z']);
      strictEqual(r.status, 1);
      ok(/"Z" not found/.test(r.stderr), r.stderr);
    });
  });

  it('next-ready carries the readiness of every open subtask when nothing is dispatchable', async () => {
    await withTmpRepo('next-ready', async (root) => {
      const filePath = await newMacro(root, [
        st('A', { status: 'in_progress' }), st('B', { blocked_by: ['A'], status: 'blocked' }),
      ]);
      const r = cli(['next-ready', `--workflow-path=${filePath}`]);
      strictEqual(r.json.reason, 'in_progress_or_blocked');
      deepStrictEqual(r.json.readiness.map((x) => [x.id, x.status, x.waiting_on]), [
        ['A', 'in_progress', []],
        ['B', 'blocked', ['A']],
      ]);
    });
  });
});
