// tests/orchestrator/test-engineer-terminal.mjs
//
// ADR-0062 §Decision 2 — what the engineer tells the macro when its
// workflow reaches its terminal commit. It no longer completes the subtask
// (the branch commit is not what lands); `subtask-engineer-terminal` binds
// the owner, keeps the subtask open, and leaves one note per engineer
// workflow and branch commit. The engineer's Phase 7 and its Stop hook both
// call it, so a second call must be a no-op.

import { describe, it } from 'node:test';
import { strictEqual, ok, rejects } from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const STATE_MJS = resolve(REPO_ROOT, 'plugins/orchestrator/scripts/state.mjs');
const {
  createWorkflow, readWorkflow, setPlan, updateSubtask, bulkSubtaskStatus, recordEngineerTerminal,
} = await import(STATE_MJS);

async function withMacro(subtasks, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-engineer-terminal-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    const { filePath } = await createWorkflow({
      repoRoot: dir, verb: 'plan', host: 'claude',
      gitBaseline: { branch: 'main', head: '0'.repeat(40), status_digest: '' },
      originalRequest: 'engineer terminal fixture',
    });
    await setPlan({ workflowPath: filePath, host: 'claude', subtasks });
    return await fn(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const st = (id, extra = {}) => ({
  id, verb: 'compose', branch: `feat/${id.toLowerCase()}`, blocked_by: [], status: 'pending', ...extra,
});

const call = (filePath, extra = {}) => recordEngineerTerminal({
  workflowPath: filePath, host: 'claude', subtaskId: 'A',
  engineerWorkflowId: 'eng-A', branchCommit: 'b1', ...extra,
});

describe('recordEngineerTerminal (ADR-0062 §Decision 2)', () => {
  it('keeps the subtask open, records no commit, and notes the branch commit once', async () => {
    await withMacro([st('A', { status: 'in_progress' }), st('B', { blocked_by: ['A'], status: 'blocked' })], async (filePath) => {
      await updateSubtask({ workflowPath: filePath, subtaskId: 'A', host: 'claude', engineerWorkflowId: 'eng-A' });
      const r = await call(filePath);
      strictEqual(r.noted, true);
      const { frontmatter, body } = await readWorkflow(filePath);
      const [a, b] = frontmatter.plan.subtasks;
      strictEqual(a.status, 'in_progress');
      strictEqual('commit' in a, false);
      strictEqual('closed_at' in a, false);
      strictEqual(b.status, 'blocked', 'the successor stays blocked until A lands');
      ok(body.includes('### engineer terminal: "A" @ eng-A b1'), body);
      ok(body.includes('/orchestrator:done A'), body);
      ok(frontmatter.next_action.includes('/orchestrator:done A'), frontmatter.next_action);

      const before = await readFile(filePath, 'utf8');
      const again = await call(filePath);
      strictEqual(again.noop, true);
      strictEqual(await readFile(filePath, 'utf8'), before);
    });
  });

  it('recording the landing replaces the /orchestrator:done pointer with the next step', async () => {
    await withMacro([
      st('A', { status: 'in_progress', engineer_workflow_id: 'eng-A' }),
      st('B', { blocked_by: ['A'], status: 'blocked' }),
      st('C', { status: 'in_progress', engineer_workflow_id: 'eng-C' }),
    ], async (filePath) => {
      await call(filePath);
      ok((await readWorkflow(filePath)).frontmatter.next_action.includes('/orchestrator:done A'));
      await updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude', engineerWorkflowId: 'eng-A',
        status: 'completed', commit: 'm1',
      });
      let { frontmatter } = await readWorkflow(filePath);
      ok(frontmatter.next_action.includes('dispatch B with /orchestrator:next'), frontmatter.next_action);
      ok(!frontmatter.next_action.includes('/orchestrator:done A'), frontmatter.next_action);
      await updateSubtask({ workflowPath: filePath, subtaskId: 'B', host: 'codex', status: 'in_progress', engineerWorkflowId: 'eng-B' });
      await updateSubtask({
        workflowPath: filePath, subtaskId: 'B', host: 'codex', engineerWorkflowId: 'eng-B',
        status: 'completed', commit: 'm2',
      });
      ({ frontmatter } = await readWorkflow(filePath));
      ok(frontmatter.next_action.includes('record C with $orchestrator:done'), frontmatter.next_action);
    });
  });

  it('notes a new branch commit from the same owner (an amend) without recording it', async () => {
    await withMacro([st('A', { status: 'in_progress', engineer_workflow_id: 'eng-A' })], async (filePath) => {
      await call(filePath);
      await call(filePath, { branchCommit: 'b2' });
      const { frontmatter, body } = await readWorkflow(filePath);
      ok(body.includes('@ eng-A b1') && body.includes('@ eng-A b2'), body);
      strictEqual('commit' in frontmatter.plan.subtasks[0], false);
    });
  });

  it('binds an unrecorded owner and moves a pending subtask to in_progress', async () => {
    await withMacro([st('A')], async (filePath) => {
      const r = await call(filePath);
      strictEqual(r.boundOwner, true);
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.plan.subtasks[0].engineer_workflow_id, 'eng-A');
      strictEqual(frontmatter.plan.subtasks[0].status, 'in_progress');
    });
  });

  it('refuses a different owner and writes nothing', async () => {
    await withMacro([st('A', { status: 'in_progress', engineer_workflow_id: 'eng-other' })], async (filePath) => {
      const before = await readFile(filePath, 'utf8');
      await rejects(() => call(filePath), /engineer_workflow_id mismatch/);
      strictEqual(await readFile(filePath, 'utf8'), before);
    });
  });

  for (const status of ['completed', 'deferred', 'abandoned', 'blocked']) {
    it(`skips a ${status} subtask and writes nothing`, async () => {
      await withMacro([st('A', { status: 'in_progress', engineer_workflow_id: 'eng-A' }), st('Z')], async (filePath) => {
        if (status === 'completed') {
          await updateSubtask({ workflowPath: filePath, subtaskId: 'A', host: 'claude', engineerWorkflowId: 'eng-A', status: 'completed', commit: 'c1' });
        } else if (status === 'blocked') {
          const { writeFile } = await import('node:fs/promises');
          const text = await readFile(filePath, 'utf8');
          await writeFile(filePath, text.replace('status: "in_progress"', 'status: "blocked"'));
        } else {
          await bulkSubtaskStatus({ workflowPath: filePath, host: 'claude', fromStatuses: ['in_progress', 'pending'], toStatus: status });
        }
        const before = await readFile(filePath, 'utf8');
        const r = await call(filePath);
        strictEqual(r.skipped, true);
        ok(r.skipReason.includes(status), r.skipReason);
        strictEqual(await readFile(filePath, 'utf8'), before);
      });
    });
  }

  it('fails on an unknown subtask', async () => {
    await withMacro([st('A')], async (filePath) => {
      await rejects(() => call(filePath, { subtaskId: 'Q' }), /"Q" not found/);
    });
  });

  // ADR-0067 Decision 3. Contract: the engineer's writeback passes the macro
  // id it resolved the path for (--expect-workflow-id); the read under the
  // lock is the one the write is made from, so a file that holds another
  // macro by then must get nothing.
  it('refuses a file whose workflow_id is not the expected one, on the locked read, and writes nothing (CLI too)', async () => {
    await withMacro([st('A', { status: 'in_progress', engineer_workflow_id: 'eng-A' })], async (filePath) => {
      const before = await readFile(filePath, 'utf8');
      await rejects(() => call(filePath, { expectWorkflowId: 'macro-other' }), /holds macro "macro-plan-[^"]+", not "macro-other"; nothing was written/);
      strictEqual(await readFile(filePath, 'utf8'), before);
      const cli = spawnSync(process.execPath, [
        STATE_MJS, 'subtask-engineer-terminal', `--workflow-path=${filePath}`, '--host=claude',
        '--subtask-id=A', '--engineer-workflow-id=eng-A', '--branch-commit=b1', '--expect-workflow-id=macro-other',
      ], { encoding: 'utf8' });
      strictEqual(cli.status, 1, cli.stdout);
      strictEqual(await readFile(filePath, 'utf8'), before);
      const id = filePath.split('/').pop().replace(/\.md$/, '');
      strictEqual((await call(filePath, { expectWorkflowId: id })).noted, true, 'the expected id passes');
    });
  });

  it('CLI: JSON envelope; a Codex caller gets the Codex command form', async () => {
    await withMacro([st('A', { status: 'in_progress', engineer_workflow_id: 'eng-A' })], async (filePath) => {
      const out = execFileSync(process.execPath, [
        STATE_MJS, 'subtask-engineer-terminal', `--workflow-path=${filePath}`, '--host=codex',
        '--subtask-id=A', '--engineer-workflow-id=eng-A', '--branch-commit=b1',
      ], { encoding: 'utf8' });
      const envelope = JSON.parse(out.trim());
      strictEqual(envelope.noted, true);
      strictEqual(envelope.subtask.status, 'in_progress');
      const { frontmatter } = await readWorkflow(filePath);
      ok(frontmatter.next_action.includes('$orchestrator:done A'), frontmatter.next_action);

      const mismatch = spawnSync(process.execPath, [
        STATE_MJS, 'subtask-engineer-terminal', `--workflow-path=${filePath}`, '--host=codex',
        '--subtask-id=A', '--engineer-workflow-id=eng-B', '--branch-commit=b1',
      ], { encoding: 'utf8' });
      strictEqual(mismatch.status, 1);
    });
  });
});

// ADR-0067 Decision 4, item 5 — the dispatch a child records (the engineer's
// `dispatch-selection`). Contract: every writer that binds a child to a
// subtask, or moves a subtask on its behalf, compares it on the read under the
// macro's lock, and a subtask that a plan revision changed since the dispatch
// gets nothing; the root of the M6 / F2 / N1 class.
describe('the dispatch a child records, compared by every binding (ADR-0067 Decision 4, item 5)', () => {
  const macroIdOf = (filePath) => filePath.split('/').pop().replace(/\.md$/, '');
  const dispatched = (filePath, over = {}) => ({
    macro: macroIdOf(filePath), subtask: 'A', branch: 'feat/a', verb: 'compose', profile: '', topic: 'the topic\n', ...over,
  });
  const revisions = [
    ['branch', { branch: 'feat/a2' }],
    ['verb', { verb: 'frame' }],
    ['profile', { profile: 'backend' }],
    ['topic', { topic: 'another topic' }],
  ];

  for (const [field, change] of revisions) {
    it(`recordEngineerTerminal: a ${field} revised since the dispatch binds nothing, moves nothing and notes nothing`, async () => {
      await withMacro([st('A', { topic: 'the topic' }), st('Z')], async (filePath) => {
        await setPlan({ workflowPath: filePath, host: 'claude', subtasks: [st('A', { topic: 'the topic', ...change }), st('Z')] });
        const before = await readFile(filePath, 'utf8');
        await rejects(() => call(filePath, { expectDispatch: dispatched(filePath) }), new RegExp(`\\(dispatch-changed\\): ${field} is `));
        strictEqual(await readFile(filePath, 'utf8'), before);
      });
    });
  }

  it('recordEngineerTerminal: the dispatch as recorded binds the child; trailing newlines and an absent profile compare equal', async () => {
    await withMacro([st('A', { topic: 'the topic' })], async (filePath) => {
      const r = await call(filePath, { expectDispatch: dispatched(filePath) });
      strictEqual(r.boundOwner, true);
      const [a] = (await readWorkflow(filePath)).frontmatter.plan.subtasks;
      strictEqual(a.engineer_workflow_id, 'eng-A');
      strictEqual(a.status, 'in_progress');
    });
  });

  it('recordEngineerTerminal: a child already bound is refused too once its subtask is revised', async () => {
    await withMacro([st('A', { status: 'in_progress', engineer_workflow_id: 'eng-A', topic: 'the topic' })], async (filePath) => {
      await setPlan({ workflowPath: filePath, host: 'claude', subtasks: [st('A', { status: 'in_progress', engineer_workflow_id: 'eng-A', branch: 'feat/a2', topic: 'the topic' })] });
      const before = await readFile(filePath, 'utf8');
      await rejects(() => call(filePath, { expectDispatch: dispatched(filePath) }), /\(dispatch-changed\): branch is "feat\/a2"/);
      strictEqual(await readFile(filePath, 'utf8'), before);
    });
  });

  it('recordEngineerTerminal: a child dispatched for another macro or subtask is refused; a child recorded before the record is judged by its branch', async () => {
    await withMacro([st('A', { topic: 'the topic' })], async (filePath) => {
      const before = await readFile(filePath, 'utf8');
      await rejects(() => call(filePath, { expectDispatch: dispatched(filePath, { macro: 'macro-other' }) }), /dispatched by macro "macro-other"/);
      await rejects(() => call(filePath, { expectDispatch: dispatched(filePath, { subtask: 'Z' }) }), /dispatched for subtask "Z"/);
      await rejects(() => call(filePath, { expectDispatch: { macro: macroIdOf(filePath), subtask: 'A', branch: 'main' } }), /branch is "feat\/a"; the child was dispatched for "main"/);
      strictEqual(await readFile(filePath, 'utf8'), before);
      strictEqual((await call(filePath, { expectDispatch: { macro: macroIdOf(filePath), subtask: 'A', branch: 'feat/a' } })).boundOwner, true);
    });
  });

  it('CLI: --expect-dispatch on subtask-engineer-terminal and subtask-update; malformed JSON and unknown keys are refused before any read', async () => {
    await withMacro([st('A', { topic: 'the topic' })], async (filePath) => {
      const before = await readFile(filePath, 'utf8');
      const cli = (args) => spawnSync(process.execPath, [STATE_MJS, ...args], { encoding: 'utf8' });
      const terminal = (json) => cli(['subtask-engineer-terminal', `--workflow-path=${filePath}`, '--host=codex',
        '--subtask-id=A', '--engineer-workflow-id=eng-A', '--branch-commit=b1', `--expect-dispatch=${json}`]);
      for (const bad of ['{not json', JSON.stringify({ ...dispatched(filePath), extra: 'x' }), JSON.stringify({ subtask: 'A', branch: 'feat/a' })]) {
        const r = terminal(bad);
        strictEqual(r.status, 1, r.stderr);
        ok(/expectDispatch/.test(r.stderr), r.stderr);
      }
      const revised = cli(['subtask-update', `--workflow-path=${filePath}`, '--host=claude', '--subtask-id=A',
        '--status=in_progress', '--engineer-workflow-id=eng-A', `--expect-dispatch=${JSON.stringify(dispatched(filePath, { verb: 'frame' }))}`]);
      strictEqual(revised.status, 1, revised.stdout);
      ok(/\(dispatch-changed\): verb is "compose"; the child was dispatched for "frame"/.test(revised.stderr), revised.stderr);
      strictEqual(await readFile(filePath, 'utf8'), before);
      const ok1 = terminal(JSON.stringify(dispatched(filePath)));
      strictEqual(ok1.status, 0, ok1.stderr);
      strictEqual(JSON.parse(ok1.stdout).boundOwner, true);
    });
  });

  for (const [field, change] of revisions) {
    it(`updateSubtask: a ${field} revised since the dispatch refuses the binding write, whatever the other expectations say`, async () => {
      await withMacro([st('A', { topic: 'the topic', ...change })], async (filePath) => {
        const before = await readFile(filePath, 'utf8');
        await rejects(() => updateSubtask({
          workflowPath: filePath, subtaskId: 'A', host: 'claude', status: 'in_progress', engineerWorkflowId: 'eng-A',
          // Phase 1 read the revised subtask (a re-attach): its own
          // expectations hold, the child's dispatch does not.
          expectBranch: change.branch ?? 'feat/a',
          expectDispatch: dispatched(filePath),
        }), /\(dispatch-changed\)/);
        strictEqual(await readFile(filePath, 'utf8'), before);
      });
    });
  }
});
