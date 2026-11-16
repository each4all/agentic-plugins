// tests/orchestrator/test-done-state.mjs
//
// ADR-0062, ADR-0067 Decision 4, item 5 — the rules /orchestrator:done's
// write depends on, in process, through the functions its CLI calls: the
// owner and active-child scans (subtaskClaims, ownerDispatch, which the
// owner-dispatch and active-child subcommands print), done's argument
// grammar (parseCommandArguments, which command-args prints) and the write's
// own refusals (updateSubtask, which subtask-update runs). The runbooks'
// shell decisions are in test-done-runbook.mjs, and their happy path in
// test-done-runbook-e2e.mjs.

import { describe, it } from 'node:test';
import { deepStrictEqual, rejects, strictEqual, throws } from 'node:assert/strict';
import { mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir } from '../_tmp.mjs';
import { isSessionVariable } from '../../scripts/lib/session-env.mjs';

// The fixtures' writes follow no inherited agentic session (tests/_hermetic-env.mjs).
for (const name of Object.keys(process.env)) if (isSessionVariable(name)) delete process.env[name];

const ORCH_ROOT = resolve(fileURLToPath(import.meta.url), '../../../plugins/orchestrator');
const { createWorkflow, setPlan, updateSubtask, subtaskClaims, ownerDispatch } = await import(resolve(ORCH_ROOT, 'scripts/state.mjs'));
const { parseCommandArguments } = await import(resolve(ORCH_ROOT, 'scripts/lib/command-args.mjs'));

const ENGINEER_ID = 'compose-20260927T100000Z-abcdef';
const GIT_ENV = { ...process.env, GIT_CONFIG_NOSYSTEM: '1' };

/**
 * A repository holding a macro whose subtask `id` (branch feat/a) blocks B,
 * and the engineer child `ENGINEER_ID` claiming it, archived; `dispatch`
 * adds the dispatch record the child keeps (ADR-0067 Decision 4, item 5).
 */
async function fixture(t, { id = 'A', topic, dispatch = null } = {}) {
  const work = tmpDir(t, 'orchestrator-done-state-');
  execFileSync('git', ['init', '-q', '-b', 'main', work], { env: GIT_ENV });
  const { filePath: macroPath } = await createWorkflow({
    repoRoot: work, verb: 'plan', host: 'claude',
    gitBaseline: { branch: 'main', head: '0'.repeat(40), status_digest: '' },
    originalRequest: 'done state fixture',
  });
  const plan = (over = {}) => setPlan({
    workflowPath: macroPath, host: 'claude',
    subtasks: [
      { id, verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'in_progress', ...(topic ? { topic } : {}), ...over },
      { id: 'B', verb: 'compose', branch: 'feat/b', blocked_by: [id], status: 'blocked' },
    ],
  });
  await plan();
  const macroId = macroPath.split('/').pop().replace(/\.md$/, '');
  const engDir = join(work, '.agentic-plugins', 'state', 'engineer');
  mkdirSync(join(engDir, 'workflows'), { recursive: true });
  mkdirSync(join(engDir, 'archive'), { recursive: true });
  const child = (home) => join(engDir, home, `${ENGINEER_ID}.md`);
  writeFileSync(child('archive'), [
    '---', 'schema: "1.3"', `workflow_id: "${ENGINEER_ID}"`,
    'git_baseline:', '  branch: "feat/a"', `  head: "${'0'.repeat(40)}"`, '  status_digest: ""',
    `parent_workflow: "${macroId}"`, `originating_subtask: ${JSON.stringify(id)}`,
    ...(dispatch ? Object.entries(dispatch).map(([k, v]) => `dispatched_${k}: ${JSON.stringify(v)}`) : []),
    '---', '', '# child', '',
  ].join('\n'));
  return { work, macroPath, macroId, engDir, child, plan };
}

describe('/orchestrator:done — the owner scans (ownerDispatch, subtaskClaims)', () => {
  // ADR-0067 Decision 4, item 5 — done completes the subtask in its recorded
  // owner's name, so the dispatch that owner records is compared whole: a plan
  // revised since in any field of it, the topic included, refuses the write.
  it('a recorded owner is not bound to a subtask revised since its dispatch: the dispatch it records is read whole and compared (ownerDispatch, updateSubtask)', async (t) => {
    const dispatch = { branch: 'feat/a', verb: 'compose', profile: '', topic: 'the topic' };
    const { work, macroPath, macroId, plan } = await fixture(t, { topic: 'the topic', dispatch });
    const found = ownerDispatch({ repoRoot: work, macroId, subtaskId: 'A', owner: ENGINEER_ID });
    strictEqual(found.status, 'found');
    deepStrictEqual(found.claim.dispatch, { macro: macroId, subtask: 'A', ...dispatch });
    await plan({ topic: 'a revised topic', engineer_workflow_id: ENGINEER_ID });
    const before = readFileSync(macroPath, 'utf8');
    const write = { workflowPath: macroPath, subtaskId: 'A', host: 'claude', engineerWorkflowId: ENGINEER_ID, status: 'completed', closedAt: '2026-10-09T00:00:00Z', expectBranch: 'feat/a', reason: 'investigation only' };
    await rejects(updateSubtask({ ...write, expectDispatch: found.claim.dispatch }),
      /\(dispatch-changed\): topic is "a revised topic"; the child was dispatched for "the topic"/);
    strictEqual(readFileSync(macroPath, 'utf8'), before, 'nothing was written');
    // Control: the plan revised back, the same dispatch binds and completes.
    await plan({ engineer_workflow_id: ENGINEER_ID });
    await updateSubtask({ ...write, expectDispatch: found.claim.dispatch });
  });

  // R3 — the scans parse frontmatter values: a subtask id holding a quote is
  // written with a JSON escape, which matching the serialized text never found.
  it('a subtask id holding a quote: the owner and active-child scans find its claimant by its value', async (t) => {
    const id = 'A"1';
    const { work, macroId, child } = await fixture(t, { id });
    strictEqual(readFileSync(child('archive'), 'utf8').includes('originating_subtask: "A\\"1"'), true, 'the id is written with a JSON escape');
    const sole = ownerDispatch({ repoRoot: work, macroId, subtaskId: id });
    deepStrictEqual([sole.status, sole.claim?.id], ['found', ENGINEER_ID]);
    deepStrictEqual(ownerDispatch({ repoRoot: work, macroId, subtaskId: id, owner: ENGINEER_ID }).status, 'found');
    deepStrictEqual([...subtaskClaims({ repoRoot: work, macroId, subtaskId: id, activeOnly: true }).claims.keys()], [], 'an archived child is no active one');
    renameSync(child('archive'), child('workflows'));
    deepStrictEqual([...subtaskClaims({ repoRoot: work, macroId, subtaskId: id, activeOnly: true }).claims.keys()], [ENGINEER_ID]);
  });

  // A recorded owner whose file claims another subtask is not "gone": only a
  // missing owner may be waived (owner-dispatch's exit 3), so this one is
  // reported apart from it.
  it('a recorded owner whose file claims another subtask is found elsewhere, not missing', async (t) => {
    const { work, macroId, child } = await fixture(t);
    writeFileSync(child('archive'), readFileSync(child('archive'), 'utf8').replace('originating_subtask: "A"', 'originating_subtask: "B"'));
    const found = ownerDispatch({ repoRoot: work, macroId, subtaskId: 'A', owner: ENGINEER_ID });
    deepStrictEqual([found.status, found.files?.map((f) => f.values.originating_subtask)], ['elsewhere', ['B']]);
    rmSync(child('archive'));
    strictEqual(ownerDispatch({ repoRoot: work, macroId, subtaskId: 'A', owner: ENGINEER_ID }).status, 'owner-missing');
  });

  // A topic holding U+2028, a line terminator to a regular expression but not
  // to the engineer's line-per-key frontmatter, is read whole.
  it('a recorded dispatch whose topic holds U+2028 is read whole', async (t) => {
    const topic = 'one two';
    const { work, macroId } = await fixture(t, { topic, dispatch: { branch: 'feat/a', verb: 'compose', profile: '', topic } });
    strictEqual(ownerDispatch({ repoRoot: work, macroId, subtaskId: 'A' }).claim.dispatch.topic, topic);
  });

  // A scan that cannot read a workflow home or file must refuse, not read the
  // failure as "no child" or "no other claimant" (C3 review, G3): the owner
  // scan (owner-dispatch) and the active-child scan (done --no-commit) alike.
  // The faults are ones root cannot bypass.
  for (const [what, fault] of [
    ['a workflow name that is a directory', ({ engDir }) => mkdirSync(join(engDir, 'workflows', 'compose-20260927T110000Z-bbbbbb.md'))],
    ['a workflow name that is a link loop', ({ engDir }) => symlinkSync('compose-20260927T110000Z-bbbbbb.md', join(engDir, 'workflows', 'compose-20260927T110000Z-bbbbbb.md'))],
    ['a workflow home that cannot be listed', ({ work }) => {
      mkdirSync(join(work, '.claude', 'agentic-engineer'), { recursive: true });
      writeFileSync(join(work, '.claude', 'agentic-engineer', 'workflows'), 'not a directory\n');
    }],
  ]) {
    it(`the scans refuse, rather than guess, on ${what}`, async (t) => {
      const f = await fixture(t);
      // Control: before the fault, each scan reads.
      strictEqual(ownerDispatch({ repoRoot: f.work, macroId: f.macroId, subtaskId: 'A', owner: ENGINEER_ID }).status, 'found');
      strictEqual(subtaskClaims({ repoRoot: f.work, macroId: f.macroId, subtaskId: 'A', activeOnly: true }).claims.size, 0);
      fault(f);
      throws(() => ownerDispatch({ repoRoot: f.work, macroId: f.macroId, subtaskId: 'A' }));
      throws(() => ownerDispatch({ repoRoot: f.work, macroId: f.macroId, subtaskId: 'A', owner: ENGINEER_ID }));
      throws(() => subtaskClaims({ repoRoot: f.work, macroId: f.macroId, subtaskId: 'A', activeOnly: true }));
    });
  }
});

describe('/orchestrator:done — the argument grammar (parseCommandArguments)', () => {
  it('--no-commit excludes --commit, --pr, --correct and --accept-landed-change (parseCommandArguments)', () => {
    for (const flag of ['--commit=0123abc', '--pr=7', '--correct', '--accept-landed-change']) {
      const name = flag.replace(/=.*/, '');
      throws(() => parseCommandArguments('done', `A --no-commit ${flag} investigation only`), new RegExp(`--no-commit excludes ${name}`));
    }
    // Control: --no-commit alone, with its reason, parses.
    const fields = parseCommandArguments('done', 'A --no-commit investigation only');
    deepStrictEqual([fields.subtask_id, fields.no_commit, fields.reason], ['A', true, 'investigation only']);
  });
});

describe('/orchestrator:done — the write\'s own refusals (updateSubtask)', () => {
  it('the waiver needs a reason, names an owner, and excludes a dispatch to compare (updateSubtask)', async (t) => {
    const { macroPath } = await fixture(t);
    const base = { workflowPath: macroPath, subtaskId: 'A', host: 'claude', engineerWorkflowId: ENGINEER_ID, status: 'completed', closedAt: '2026-10-09T00:00:00Z', waiveDispatch: true };
    const before = readFileSync(macroPath, 'utf8');
    await rejects(updateSubtask(base), /--waive-dispatch requires a non-empty reason/);
    await rejects(updateSubtask({ ...base, reason: 'gone', engineerWorkflowId: undefined }), /--waive-dispatch names no owner/);
    await rejects(updateSubtask({ ...base, reason: 'gone', expectDispatch: { macro: 'm', subtask: 'A', branch: 'feat/a' } }), /not both/);
    strictEqual(readFileSync(macroPath, 'utf8'), before);
  });

  // R1 — a completion not compared with its owner's dispatch (the recorded
  // owner's file is gone) records the waiver and the reason in the macro.
  it('a waived completion records the waiver and its reason in the macro (updateSubtask)', async (t) => {
    const { macroPath, child } = await fixture(t);
    await updateSubtask({ workflowPath: macroPath, subtaskId: 'A', host: 'claude', engineerWorkflowId: ENGINEER_ID });
    rmSync(child('archive'));
    const reason = 'the lane that held the child was removed';
    await updateSubtask({ workflowPath: macroPath, subtaskId: 'A', host: 'claude', engineerWorkflowId: ENGINEER_ID, status: 'completed', closedAt: '2026-10-09T00:00:00Z', expectBranch: 'feat/a', waiveDispatch: true, reason });
    const text = readFileSync(macroPath, 'utf8');
    strictEqual(text.includes(`Dispatch not compared (--waive-dispatch): the dispatch recorded by "${ENGINEER_ID}" could not be read`), true, text);
    strictEqual(text.includes(`Reason: ${reason}`), true, text);
  });

  // ADR-0063 Q2, ADR-0069 Decision 3 — the owner's overrides are refused at the
  // write under an autopilot run, each on its own, before anything is written;
  // with no run named, the acceptance still needs its reason and its commit.
  it('the owner\'s overrides are refused under an autopilot run, and the acceptance needs a reason and a commit (updateSubtask)', async (t) => {
    const { macroPath } = await fixture(t);
    const before = readFileSync(macroPath, 'utf8');
    const run = { AGENTIC_AUTOPILOT: 'autopilot-20261108T000000Z-abcdef' };
    const base = { workflowPath: macroPath, subtaskId: 'A', host: 'claude', engineerWorkflowId: ENGINEER_ID, status: 'completed', commit: 'c'.repeat(40), closedAt: '2026-10-09T00:00:00Z', reason: 'a worker wrote this' };
    for (const [opt, flag] of [['waiveDispatch', '--waive-dispatch'], ['waiveTold', '--waive-told'], ['acceptLandedChange', '--accept-landed-change']]) {
      await rejects(updateSubtask({ ...base, [opt]: true, env: run }), new RegExp(`${flag} refused under autopilot`));
    }
    await rejects(updateSubtask({ ...base, acceptLandedChange: true, reason: undefined, env: {} }), /--accept-landed-change requires a non-empty reason/);
    await rejects(updateSubtask({ ...base, acceptLandedChange: true, commit: undefined, env: {} }), /--accept-landed-change applies only to a completion with its landed commit/);
    strictEqual(readFileSync(macroPath, 'utf8'), before);
  });
});
