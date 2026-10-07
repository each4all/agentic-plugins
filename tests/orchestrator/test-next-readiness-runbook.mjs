// tests/orchestrator/test-next-readiness-runbook.mjs
//
// ADR-0062 §Decision 5 (docket C22) — the explicit-id checks of
// /orchestrator:next, run as written: the bash block that validates the
// chosen subtask in commands/next.md, against real macro files. It used to
// say "blocked — its predecessors have not completed" from the status alone,
// which was false for a subtask whose predecessors had all completed.

import { describe, it } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const ORCH_ROOT = resolve(REPO_ROOT, 'plugins/orchestrator');
const { createWorkflow, setPlan, updateSubtask, parseWorkflowFile, assembleWorkflowFile } =
  await import(resolve(ORCH_ROOT, 'scripts/state.mjs'));

async function validationBlock() {
  const text = await readFile(resolve(ORCH_ROOT, 'commands/next.md'), 'utf8');
  // Contract: the tests below run the bash block after this step title — a renamed
  // step must fail here, not run some other block.
  const from = text.indexOf('Validate the resolved subtask is dispatch-ready');
  ok(from >= 0, 'next.md carries the validation step');
  const m = /```bash\n([\s\S]*?)```/.exec(text.slice(from));
  ok(m, 'the validation step has a bash block');
  return m[1];
}

async function withMacro(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-next-readiness-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    const { filePath } = await createWorkflow({
      repoRoot: dir, verb: 'plan', host: 'claude',
      gitBaseline: { branch: 'main', head: '0'.repeat(40), status_digest: '' },
      originalRequest: 'next readiness fixture',
    });
    await setPlan({
      workflowPath: filePath, host: 'claude',
      subtasks: [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'in_progress' },
        { id: 'B', verb: 'compose', branch: 'feat/b', blocked_by: ['A'], status: 'blocked' },
      ],
    });
    return await fn(filePath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function check(macroPath, subtaskId, status) {
  const script = await validationBlock();
  return spawnSync('bash', ['-c', `${script}\necho READY`], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLAUDE_PLUGIN_ROOT: ORCH_ROOT, MACRO_PATH: macroPath,
      SUBTASK_ID: subtaskId, SUBTASK_STATUS: status,
    },
  });
}

describe('/orchestrator:next explicit-id validation (ADR-0062 §Decision 5)', () => {
  it('names the predecessor a blocked subtask waits on', async () => {
    await withMacro(async (macroPath) => {
      const r = await check(macroPath, 'B', 'blocked');
      strictEqual(r.status, 1);
      ok(/B is blocked — it waits on: A\./.test(r.stderr), r.stderr);
    });
  });

  it('reports a blocked status with nothing left to wait on as stale, with its repair', async () => {
    await withMacro(async (macroPath) => {
      await updateSubtask({
        workflowPath: macroPath, subtaskId: 'A', host: 'claude',
        engineerWorkflowId: 'eng-A', status: 'completed', commit: 'c1',
      });
      // A file written before the shared unblock pass: B stayed blocked.
      const { frontmatter, body } = parseWorkflowFile(await readFile(macroPath, 'utf8'));
      frontmatter.plan.subtasks[1].status = 'blocked';
      await writeFile(macroPath, assembleWorkflowFile(frontmatter, body));
      const r = await check(macroPath, 'B', 'blocked');
      strictEqual(r.status, 1);
      ok(/every predecessor is completed/.test(r.stderr), r.stderr);
      ok(/--subtask-id B --status=pending/.test(r.stderr), r.stderr);
      ok(!/waits on/.test(r.stderr), r.stderr);
    });
  });

  it('refuses a pending subtask that still waits, and passes one that does not', async () => {
    await withMacro(async (macroPath) => {
      const waiting = await check(macroPath, 'B', 'pending');
      strictEqual(waiting.status, 1);
      ok(/B is pending but waits on: A\./.test(waiting.stderr), waiting.stderr);
      await updateSubtask({
        workflowPath: macroPath, subtaskId: 'A', host: 'claude',
        engineerWorkflowId: 'eng-A', status: 'completed', commit: 'c1',
      });
      const ready = await check(macroPath, 'B', 'pending');
      strictEqual(ready.status, 0, ready.stderr);
      ok(ready.stdout.includes('READY'));
    });
  });
});
