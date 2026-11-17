// ADR-0067 Decision 4, item 5 (the SR refine's Refine-verify, F2): the
// subtask-update CLI forwards each --expect-* flag /orchestrator:next's
// writeback passes (commands/next.md Phase 5, the Codex Phase 4) to
// updateSubtask, so the write is refused when the subtask's field no longer
// matches the dispatched one.
//
// A branch of the CLI's own dispatcher, so a CLI call for each flag (the
// standard test shape); the comparison itself is updateSubtask's, tested in
// process in test-subtask-provenance.mjs, and the runbooks' passing of the
// flags in test-admission-runbooks.mjs.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpDir } from '../_tmp.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const ORCH_STATE = join(REPO_ROOT, 'plugins/orchestrator/scripts/state.mjs');
const { createWorkflow, readWorkflow, setPlan } = await import(pathToFileURL(ORCH_STATE).href);
// The operator's agentic session stays out (C88).
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && !k.startsWith('GIT_')));

/** A macro in a new repository, planned with subtask A as the writeback finds it. */
async function macro(t) {
  const root = tmpDir(t, 'subtask-update-expect-');
  execFileSync('git', ['init', '-q', '-b', 'main', root], { stdio: 'ignore', env });
  const { filePath } = await createWorkflow({
    repoRoot: root, verb: 'plan', host: 'claude',
    gitBaseline: { branch: 'main', head: '0000000000000000000000000000000000000000', status_digest: '' },
    originalRequest: 'subtask-update expect fixture',
  });
  await setPlan({ workflowPath: filePath, host: 'claude', subtasks: [{ id: 'A', verb: 'refine', branch: 'feat/a', blocked_by: [], status: 'pending', profile: 'backend', topic: 'the topic' }] });
  return filePath;
}
const update = (filePath, ...flags) => spawnSync(process.execPath, [
  ORCH_STATE, 'subtask-update', `--workflow-path=${filePath}`, '--host=claude', '--subtask-id=A',
  '--status=in_progress', '--engineer-workflow-id=eng-X', ...flags, '--event=updated',
], { encoding: 'utf8', env });

describe('subtask-update forwards each --expect-* flag the writeback passes (ADR-0067 Decision 4, item 5)', () => {
  for (const [flag, field, now] of [['expect-verb', 'verb', 'refine'], ['expect-profile', 'profile', 'backend'], ['expect-topic', 'topic', 'the topic']]) {
    it(`CLI: --${flag} that the subtask's ${field} no longer matches refuses the write; nothing is written`, async (t) => {
      const filePath = await macro(t);
      const r = update(filePath, `--${flag}=dispatched`);
      strictEqual(r.status, 1, r.stdout);
      ok(r.stderr.includes(`subtask "A" ${field} is ${JSON.stringify(now)}, not the expected "dispatched"`), r.stderr);
      const a = (await readWorkflow(filePath)).frontmatter.plan.subtasks[0];
      deepStrictEqual([a.status, a.engineer_workflow_id], ['pending', undefined]);
      // Control: the field as dispatched binds the child.
      const bound = update(filePath, `--${flag}=${now}`);
      strictEqual(bound.status, 0, bound.stderr);
      strictEqual((await readWorkflow(filePath)).frontmatter.plan.subtasks[0].engineer_workflow_id, 'eng-X');
    });
  }
});
