// tests/orchestrator/test-subtask-provenance.mjs
//
// ADR-0062 §Decision 3 — a recorded subtask value is not replaced
// silently. Covers docket C14: a same-owner writeback used to merge
// `{...current, ...payload}` over a completed record, so a late Stop-hook
// writeback replaced `commit` / `closed_at` (subtask C58: the Stop hook
// replaced the P10 branch commit with the amended tip).

import { describe, it } from 'node:test';
import { strictEqual, ok, rejects, deepStrictEqual } from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const STATE_MJS = resolve(REPO_ROOT, 'plugins/orchestrator/scripts/state.mjs');

const {
  createWorkflow,
  readWorkflow,
  setPlan,
  updateSubtask,
  archiveWorkflow,
} = await import(STATE_MJS);

async function withTmpRepo(name, fn) {
  const dir = await mkdtemp(join(tmpdir(), `orchestrator-provenance-${name}-`));
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test.local'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '--allow-empty', '-m', 'initial', '--no-gpg-sign'], { cwd: dir, stdio: 'ignore' });
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const BASELINE = {
  branch: 'main',
  head: '0000000000000000000000000000000000000000',
  status_digest: '',
};

async function setupPlan(repoRoot, subtasks) {
  const { filePath } = await createWorkflow({
    repoRoot, verb: 'plan', host: 'claude',
    gitBaseline: BASELINE, originalRequest: 'provenance fixture',
  });
  await setPlan({ workflowPath: filePath, host: 'claude', subtasks });
  return filePath;
}

// A completed subtask owned by eng-X, recorded with commit `aaa` + a PR.
async function setupCompleted(root) {
  const filePath = await setupPlan(root, [
    { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'in_progress' },
  ]);
  await updateSubtask({
    workflowPath: filePath, subtaskId: 'A', host: 'claude',
    engineerWorkflowId: 'eng-X', status: 'completed', commit: 'aaa',
    prUrl: 'https://github.com/example/repo/pull/1',
    closedAt: '2026-09-27T10:00:00Z',
  });
  return filePath;
}

describe('updateSubtask — recorded values are not replaced silently (ADR-0062 §3, C14)', () => {
  it('refuses a late same-owner writeback that carries a different commit, and keeps the record', async () => {
    await withTmpRepo('late-writeback', async (root) => {
      const filePath = await setupCompleted(root);
      await rejects(() => updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        engineerWorkflowId: 'eng-X', status: 'completed', commit: 'bbb',
        closedAt: '2026-09-27T10:02:54Z',
      }), /already records commit "aaa".*--correct/s);
      const { frontmatter } = await readWorkflow(filePath);
      const a = frontmatter.plan.subtasks[0];
      strictEqual(a.commit, 'aaa');
      strictEqual(a.closed_at, '2026-09-27T10:00:00Z');
    });
  });

  it('refuses a different pr_url once one is recorded', async () => {
    await withTmpRepo('pr-url-conflict', async (root) => {
      const filePath = await setupCompleted(root);
      await rejects(() => updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        engineerWorkflowId: 'eng-X',
        prUrl: 'https://github.com/example/repo/pull/2',
      }), /already records pr_url/);
    });
  });

  it('refuses to replace a commit recorded on a subtask that is not completed', async () => {
    await withTmpRepo('in-progress-commit', async (root) => {
      const filePath = await setupPlan(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'in_progress' },
      ]);
      await updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        engineerWorkflowId: 'eng-X', commit: 'aaa',
      });
      await rejects(() => updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        engineerWorkflowId: 'eng-X', commit: 'bbb',
      }), /already records commit "aaa"/);
    });
  });

  it('a re-run that carries the recorded values is a no-op: nothing is written', async () => {
    await withTmpRepo('noop', async (root) => {
      const filePath = await setupCompleted(root);
      const before = await readFile(filePath, 'utf8');
      const r = await updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        engineerWorkflowId: 'eng-X', status: 'completed', commit: 'aaa',
        prUrl: 'https://github.com/example/repo/pull/1',
        // A re-run always carries a fresh timestamp; the recorded one stays.
        closedAt: '2026-09-27T11:00:00Z',
      });
      strictEqual(r.skipped, true);
      strictEqual(r.noop, true);
      strictEqual(r.autoTerminal, false);
      strictEqual(r.updatedSubtask.closed_at, '2026-09-27T10:00:00Z');
      strictEqual(await readFile(filePath, 'utf8'), before);
    });
  });

  it('fills a value that was never recorded (later pr_url attachment)', async () => {
    await withTmpRepo('fill', async (root) => {
      const filePath = await setupPlan(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'in_progress' },
      ]);
      await updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        engineerWorkflowId: 'eng-X', status: 'completed', commit: 'aaa',
        closedAt: '2026-09-27T10:00:00Z',
      });
      const r = await updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        engineerWorkflowId: 'eng-X', commit: 'aaa',
        prUrl: 'https://github.com/example/repo/pull/1',
      });
      strictEqual(r.skipped, undefined);
      strictEqual(r.updatedSubtask.pr_url, 'https://github.com/example/repo/pull/1');
      strictEqual(r.updatedSubtask.commit, 'aaa');
    });
  });

  it('a correction needs a reason', async () => {
    await withTmpRepo('correct-no-reason', async (root) => {
      const filePath = await setupCompleted(root);
      await rejects(() => updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        engineerWorkflowId: 'eng-X', commit: 'bbb', correct: true,
      }), /--correct requires a non-empty reason/);
      await rejects(() => updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        engineerWorkflowId: 'eng-X', commit: 'bbb', correct: true, reason: '   ',
      }), /--correct requires a non-empty reason/);
    });
  });

  it('a correction replaces the value and records old, new and reason in the body', async () => {
    await withTmpRepo('correct', async (root) => {
      const filePath = await setupCompleted(root);
      const r = await updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        engineerWorkflowId: 'eng-X', commit: 'ccc', closedAt: '2026-09-27T12:00:00Z',
        correct: true, reason: 'the squash commit is ccc',
      });
      strictEqual(r.updatedSubtask.commit, 'ccc');
      strictEqual(r.updatedSubtask.closed_at, '2026-09-27T12:00:00Z');
      const { body } = await readWorkflow(filePath);
      ok(body.includes('Correction'), body);
      ok(body.includes('commit: "aaa" -> "ccc"'), body);
      ok(body.includes('closed_at: "2026-09-27T10:00:00Z" -> "2026-09-27T12:00:00Z"'), body);
      ok(body.includes('Reason: the squash commit is ccc'), body);
    });
  });

  it('a reason without --correct is noted with the write', async () => {
    await withTmpRepo('reason-note', async (root) => {
      const filePath = await setupPlan(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'in_progress' },
      ]);
      await updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        engineerWorkflowId: 'eng-X', status: 'completed',
        closedAt: '2026-09-27T10:00:00Z', reason: 'investigation only; no code change',
      });
      const { body } = await readWorkflow(filePath);
      ok(body.includes('Reason: investigation only; no code change'), body);
    });
  });

  it('refuses the write when the subtask branch no longer matches --expect-branch', async () => {
    await withTmpRepo('expect-branch', async (root) => {
      const filePath = await setupPlan(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a2', blocked_by: [], status: 'in_progress' },
      ]);
      await rejects(() => updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        engineerWorkflowId: 'eng-X', status: 'completed', commit: 'aaa',
        expectBranch: 'feat/a',
      }), /branch is "feat\/a2", not the expected "feat\/a"/);
      const r = await updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        engineerWorkflowId: 'eng-X', status: 'completed', commit: 'aaa',
        expectBranch: 'feat/a2',
      });
      strictEqual(r.updatedSubtask.status, 'completed');
    });
  });

  // ADR-0067 Decision 4, item 5 — /orchestrator:next's writeback binds the
  // child only to the subtask it dispatched.
  it('refuses the write when the subtask verb, profile or topic no longer matches the expectation; an empty one expects none', async () => {
    await withTmpRepo('expect-fields', async (root) => {
      const filePath = await setupPlan(root, [
        { id: 'A', verb: 'refine', branch: 'feat/a', blocked_by: [], status: 'pending', topic: 'line one\nline two\n' },
      ]);
      const write = (expect) => updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        engineerWorkflowId: 'eng-X', status: 'in_progress', ...expect,
      });
      await rejects(() => write({ expectVerb: 'compose' }), /verb is "refine", not the expected "compose"; the plan changed after the caller read the subtask/);
      await rejects(() => write({ expectProfile: 'plan' }), /profile is "", not the expected "plan"/);
      await rejects(() => write({ expectTopic: 'line one' }), /topic is "line one\\nline two", not the expected "line one"/);
      await rejects(() => write({ expectVerb: '' }), /expectVerb must be a non-empty string/);
      strictEqual((await readWorkflow(filePath)).frontmatter.plan.subtasks[0].status, 'pending', 'nothing was written');
      // As dispatched: the topic as a command substitution leaves it, no profile.
      const r = await write({ expectBranch: 'feat/a', expectVerb: 'refine', expectProfile: '', expectTopic: 'line one\nline two' });
      deepStrictEqual([r.updatedSubtask.status, r.updatedSubtask.engineer_workflow_id], ['in_progress', 'eng-X']);
      // A trailing newline on the expected side is not compared either.
      const again = await write({ expectTopic: 'line one\nline two\n' });
      strictEqual(again.updatedSubtask.engineer_workflow_id, 'eng-X');
    });
  });

  it('CLI: a conflict exits non-zero; --correct with --reason-file writes the correction', async () => {
    await withTmpRepo('cli', async (root) => {
      const filePath = await setupCompleted(root);
      const base = [
        STATE_MJS, 'subtask-update', `--workflow-path=${filePath}`, '--host=claude',
        '--subtask-id=A', '--engineer-workflow-id=eng-X', '--commit=ddd',
      ];
      const refused = spawnSync(process.execPath, base, { encoding: 'utf8' });
      strictEqual(refused.status, 1, refused.stdout);
      ok(/already records commit "aaa"/.test(refused.stderr), refused.stderr);

      const reasonFile = join(root, 'reason.txt');
      await writeFile(reasonFile, 'landed as ddd; "quoted" $(not run)\n');
      const corrected = spawnSync(process.execPath, [
        ...base, '--correct', `--reason-file=${reasonFile}`,
      ], { encoding: 'utf8' });
      strictEqual(corrected.status, 0, corrected.stderr);
      const envelope = JSON.parse(corrected.stdout.trim());
      strictEqual(envelope.updatedSubtask.commit, 'ddd');
      const { body } = await readWorkflow(filePath);
      ok(body.includes('Reason: landed as ddd; "quoted" $(not run)'), body);
    });
  });

  // ADR-0063 S0 — /orchestrator:done pipes its note in rather than writing a
  // temporary file it would then have to remove.
  it('CLI: --reason-file - reads the reason from standard input', async () => {
    await withTmpRepo('cli-stdin', async (root) => {
      const filePath = await setupCompleted(root);
      const corrected = spawnSync(process.execPath, [
        STATE_MJS, 'subtask-update', `--workflow-path=${filePath}`, '--host=claude',
        '--subtask-id=A', '--engineer-workflow-id=eng-X', '--commit=ddd', '--correct', '--reason-file=-',
      ], { encoding: 'utf8', input: 'first line\nsecond; "quoted" $(not run)\n' });
      strictEqual(corrected.status, 0, corrected.stderr);
      strictEqual(JSON.parse(corrected.stdout.trim()).updatedSubtask.commit, 'ddd');
      const { body } = await readWorkflow(filePath);
      ok(body.includes('first line\nsecond; "quoted" $(not run)'), body);
    });
  });

  it('refuses any write, a correction included, to an archived macro (ADR-0062 §Decision 7)', async () => {
    await withTmpRepo('archived', async (root) => {
      const filePath = await setupCompleted(root);
      const { to } = await archiveWorkflow({ workflowPath: filePath, host: 'claude', repoRoot: root });
      const before = await readFile(to, 'utf8');
      await rejects(() => updateSubtask({
        workflowPath: to, subtaskId: 'A', host: 'claude', engineerWorkflowId: 'eng-X',
        commit: 'ccc', correct: true, reason: 'rewrite history',
      }), /archived macros are frozen records/);
      await rejects(() => setPlan({ workflowPath: to, host: 'claude', subtasks: [] }), /archived macro/);
      strictEqual(await readFile(to, 'utf8'), before);
    });
  });

  it('CLI: a no-op reports noop in the envelope', async () => {
    await withTmpRepo('cli-noop', async (root) => {
      const filePath = await setupCompleted(root);
      const out = execFileSync(process.execPath, [
        STATE_MJS, 'subtask-update', `--workflow-path=${filePath}`, '--host=claude',
        '--subtask-id=A', '--engineer-workflow-id=eng-X', '--status=completed', '--commit=aaa',
      ], { encoding: 'utf8' });
      const envelope = JSON.parse(out.trim());
      strictEqual(envelope.noop, true);
      strictEqual(envelope.skipped, true);
      deepStrictEqual(envelope.updatedSubtask.commit, 'aaa');
    });
  });
});
