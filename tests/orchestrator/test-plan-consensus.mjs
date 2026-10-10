// tests/orchestrator/test-plan-consensus.mjs
//
// ADR-0067 Decision 8 — the macro's consensus task file (plugins/orchestrator/
// scripts/state.mjs) and /orchestrator:plan's conflict branch
// (commands/plan.md, Phase 2):
//   - plan-set --verdict conflict --run-id records the run with plan-conflict
//     in the plan's write; a run id needs that verdict; an empty one is none;
//   - consensus-task writes <home>/consensus/<macro-id>.<run-id>.md only for a
//     run committed with the verdict conflict, and prints the bounded round;
//   - the proposal is current only with the gate, its run id, the recorded
//     conflict and the file;
//   - a re-plan retires every task file of the macro before it writes; the
//     owner's clear and a re-set of the gate retire the file of the run;
//   - the run id is serialized last, and an orphan left by a pre-CP script
//     still reads;
//   - a writer whose lock was reclaimed publishes and retires nothing;
//   - plan.md's blocks, run: a conflict passes the run id to plan-set and
//     writes the task file from the file the agent wrote the contested items
//     to, after the ensemble commit; another verdict writes none. The blocks
//     read every other text they record from the text directory too (ADR-0059,
//     amendment of 2026-10-10), and no SUMMARY from the environment.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual, rejects } from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const ORCH_ROOT = resolve(REPO_ROOT, 'plugins/orchestrator');
const STATE = resolve(ORCH_ROOT, 'scripts/state.mjs');
const {
  createWorkflow, setPlan, setAwaitingOwner, clearAwaitingOwner, commitEnsemble, readWorkflow,
  writeConsensusTask, writeConsensusTaskUnderLock, retireConsensusTask, consensusProposal,
} = await import(STATE);

const SHELLS = ['bash', 'zsh'].filter((sh) => spawnSync(sh, ['-c', 'true']).status === 0);
const RUN = 'macro-plan-20261001T000000Z-0ff1ce';
const SUBTASKS = [{ id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'pending' }];
// The suite may run inside an autopilot worker (docket C88): no AGENTIC_*
// variable of the worker reaches a child.
const env = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_')));
const cli = (args) => spawnSync(process.execPath, [STATE, ...args], { encoding: 'utf8', env: env() });

async function withMacro(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-plan-consensus-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', dir]);
    const { filePath, frontmatter } = await createWorkflow({
      repoRoot: dir, verb: 'plan', host: 'claude',
      gitBaseline: { branch: 'main', head: '0'.repeat(40), status_digest: '' },
      originalRequest: 'plan consensus fixture',
    });
    return await fn({ dir, macro: filePath, id: frontmatter.workflow_id });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
const task = (dir, id, runId, suffix = '') => join(dir, '.agentic-plugins/state/orchestrator/consensus', `${id}.${runId}${suffix}.md`);
const conflictPlan = (macro, runId = RUN) => setPlan({ workflowPath: macro, host: 'claude', subtasks: SUBTASKS, verdict: 'conflict', runId });
const commit = (macro, runId, verdict) => commitEnsemble({ workflowPath: macro, run_id: runId, phase: 'plan', ensemble_type: 'plan-verify', verdict, summary: 's' });

describe('the macro\'s consensus task file (ADR-0067 Decision 8)', () => {
  it('plan-set records the run with plan-conflict; a run id needs the verdict conflict; an empty one is none', () => withMacro(async ({ macro }) => {
    await conflictPlan(macro);
    let { frontmatter } = await readWorkflow(macro);
    deepStrictEqual([frontmatter.awaiting_owner_gate, frontmatter.awaiting_owner_run_id], ['plan-conflict', RUN]);
    const keys = (await readFile(macro, 'utf8')).split('\n---\n')[0].split('\n').filter((l) => /^[a-z_]+:/.test(l)).map((l) => l.split(':')[0]);
    strictEqual(keys.at(-1), 'awaiting_owner_run_id', 'the run id is the last key');
    await rejects(setPlan({ workflowPath: macro, host: 'claude', subtasks: SUBTASKS, verdict: 'concerns', runId: RUN }), /a run id goes with the verdict conflict/);
    await rejects(conflictPlan(macro, 'a.b'), /is not a run id/);
    const subtasks = join(macro, '..', 'subtasks.json');
    await writeFile(subtasks, JSON.stringify(SUBTASKS));
    const r = cli(['plan-set', '--workflow-path', macro, '--host', 'claude', '--subtasks-json-file', subtasks, '--verdict', 'concerns', '--run-id', '']);
    strictEqual(r.status, 0, r.stderr);
    ({ frontmatter } = await readWorkflow(macro));
    deepStrictEqual([frontmatter.awaiting_owner_gate, frontmatter.awaiting_owner_run_id], ['plan-approval', undefined]);
  }));

  it('consensus-task writes the file only for a committed conflict and prints the round; the proposal is then current', () => withMacro(async ({ dir, macro, id }) => {
    await conflictPlan(macro);
    let r = cli(['consensus-task', '--workflow-path', macro, '--run-id', RUN, '--text', 'C1']);
    strictEqual(r.status, 1);
    ok(/has no ensemble result/.test(r.stderr), r.stderr);
    ok(/has no ensemble result on this macro/.test((await consensusProposal({ workflowPath: macro })).reason), 'no proposal before the commit');
    await commit(macro, RUN, 'conflict');
    r = cli(['consensus-task', '--workflow-path', macro, '--run-id', RUN, '--text', 'C1: split A?\n']);
    strictEqual(r.status, 0, r.stderr);
    strictEqual(r.stdout, `/runtime:consensus plan --task-file ${task(dir, id, RUN)} --peers claude,codex --max-rounds 2\n`);
    strictEqual(await readFile(task(dir, id, RUN), 'utf8'), 'C1: split A?\n');
    const p = await consensusProposal({ workflowPath: macro });
    deepStrictEqual([p.current, p.pointer], [true, `.agentic-plugins/state/orchestrator/consensus/${id}.${RUN}.md`]);
    await commit(macro, 'macro-plan-20261001T000000Z-000002', 'pass');
    r = cli(['consensus-task', '--workflow-path', macro, '--run-id', 'macro-plan-20261001T000000Z-000002', '--text', 'x']);
    ok(/recorded with verdict "pass", not conflict/.test(r.stderr), r.stderr);
  }));

  it('a re-plan retires every task file before it writes; the next conflict\'s file is the only current one', () => withMacro(async ({ dir, macro, id }) => {
    await conflictPlan(macro);
    await commit(macro, RUN, 'conflict');
    await writeConsensusTask({ workflowPath: macro, runId: RUN, text: 'C1' });
    const next = 'macro-plan-20261001T000000Z-000003';
    const re = await conflictPlan(macro, next);
    deepStrictEqual(re.retiredConsensus, [task(dir, id, RUN, '.resolved')]);
    ok(!existsSync(task(dir, id, RUN)), 'the previous plan\'s file is retired');
    const p = await consensusProposal({ workflowPath: macro });
    strictEqual(p.current, false, 'the new run has no file yet');
    await commit(macro, next, 'conflict');
    await writeConsensusTask({ workflowPath: macro, runId: next, text: 'C2' });
    strictEqual((await consensusProposal({ workflowPath: macro })).run_id, next);
    // A re-plan with no conflict leaves no proposal.
    await setPlan({ workflowPath: macro, host: 'claude', subtasks: SUBTASKS, verdict: 'pass' });
    deepStrictEqual((await readdir(join(dir, '.agentic-plugins/state/orchestrator/consensus'))).sort(), [`${id}.${next}.resolved.md`, `${id}.${RUN}.resolved.md`]);
  }));

  it('the owner\'s clear and a re-set of the gate retire the file of the run', () => withMacro(async ({ dir, macro, id }) => {
    await conflictPlan(macro);
    await commit(macro, RUN, 'conflict');
    await writeConsensusTask({ workflowPath: macro, runId: RUN, text: 'C1' });
    const cleared = await clearAwaitingOwner({ workflowPath: macro, host: 'claude', gate: 'plan-conflict', env: env() });
    deepStrictEqual([cleared.frontmatter.awaiting_owner_gate, cleared.frontmatter.awaiting_owner_run_id, cleared.retired.retired], ['plan-approval', undefined, task(dir, id, RUN, '.resolved')]);
    ok((await readFile(macro, 'utf8')).includes(`, run ${RUN}). The plan is still pending approval`), 'the resolved note names the run');
    // A conflict recorded again, then plan-conflict set over itself by hand.
    const again = 'macro-plan-20261001T000000Z-000004';
    await conflictPlan(macro, again);
    await commit(macro, again, 'conflict');
    await writeConsensusTask({ workflowPath: macro, runId: again, text: 'C3' });
    const pointer = `.agentic-plugins/state/orchestrator/workflows/${id}.md#ensemble-synthesis`;
    const reset = await setAwaitingOwner({ workflowPath: macro, host: 'claude', gate: 'plan-conflict', pointer });
    deepStrictEqual([reset.frontmatter.awaiting_owner_run_id, reset.retired.retired], [undefined, task(dir, id, again, '.resolved')]);
  }));

  it('a writer whose lock was reclaimed neither publishes nor retires a task file; the consensus directory is private', () => withMacro(async ({ dir, macro, id }) => {
    await conflictPlan(macro);
    await commit(macro, RUN, 'conflict');
    const consensusDir = join(dir, '.agentic-plugins/state/orchestrator/consensus');
    // Another writer reclaimed the macro's lock as stale while this one held it.
    const lockPath = `${macro}.lock`;
    const lost = { lockPath, token: 'this-writer' };
    await writeFile(lockPath, 'the-new-owner');
    await rejects(writeConsensusTaskUnderLock({ workflowPath: macro, runId: RUN, text: 'C1' }, lost), /ownership mismatch/);
    deepStrictEqual(await readdir(consensusDir), [], 'nothing published, and no temporary file left');
    strictEqual((await stat(consensusDir)).mode & 0o777, 0o700);
    await rm(lockPath);
    await writeConsensusTask({ workflowPath: macro, runId: RUN, text: 'C1' });
    await writeFile(lockPath, 'the-new-owner');
    const r = await retireConsensusTask(macro, id, RUN, lost);
    strictEqual(r.retired, null);
    ok(/another writer reclaimed the lock on the macro/.test(r.warning), r.warning);
    ok(existsSync(task(dir, id, RUN)), 'the new owner\'s file stays where it is');
    await rm(lockPath);
  }));

  it('an orphan run id left by a pre-CP script reads, is never current, and goes with the next gate write', () => withMacro(async ({ macro }) => {
    await setPlan({ workflowPath: macro, host: 'claude', subtasks: SUBTASKS, verdict: 'pass' });
    await commit(macro, RUN, 'conflict');
    const text = await readFile(macro, 'utf8');
    const [head, ...rest] = text.split('\n---\n');
    await writeFile(macro, [`${head}\nawaiting_owner_run_id: "${RUN}"`, ...rest].join('\n---\n'));
    strictEqual((await readWorkflow(macro)).frontmatter.awaiting_owner_run_id, RUN, 'the file reads');
    strictEqual((await consensusProposal({ workflowPath: macro })).current, false, 'plan-approval is not plan-conflict');
    await setPlan({ workflowPath: macro, host: 'claude', subtasks: SUBTASKS, verdict: 'concerns' });
    strictEqual((await readWorkflow(macro)).frontmatter.awaiting_owner_run_id, undefined);
  }));
});

// commands/plan.md Phase 2, run as the agent runs it.
async function planPhase2Blocks() {
  const text = await readFile(resolve(ORCH_ROOT, 'commands/plan.md'), 'utf8');
  const from = text.indexOf('## Phase 2 — State finalize');
  ok(from >= 0, 'plan.md carries Phase 2');
  const blocks = [...text.slice(from).matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
  // Each block by what it runs, not by its place: Phase 2 also carries WP's
  // lane-advice block between the two writes.
  const one = (what, token) => {
    const found = blocks.filter((b) => b.includes(token));
    strictEqual(found.length, 1, `Phase 2 has one ${what} block`);
    return found[0];
  };
  return [one('plan-set', 'state.mjs" plan-set'), one('note + ensemble', 'state.mjs" ensemble-commit')];
}

// Every block that reads a text file opens with the line that names the text
// directory (commands/plan.md, before Phase 0); the test puts its own there,
// as the agent puts the one mktemp printed.
const TEXT_DIR_LINE = "TEXT_DIR='<directory from step 1>'";
function withTextDir(block, textDir) {
  ok(block.startsWith(`${TEXT_DIR_LINE}\n`), 'the block opens with its text directory');
  return block.replace(TEXT_DIR_LINE, () => `TEXT_DIR='${textDir}'`);
}

for (const shell of SHELLS) {
  describe(`/orchestrator:plan conflict branch, run (${shell}) (ADR-0067 Decision 8)`, () => {
    // The agent writes each file before the block that reads it; so does
    // this. SUMMARY in the environment is not the summary: the block reads
    // summary.txt.
    const runBlock = async (dir, block, extra, files = {}) => {
      const textDir = join(dir, 'texts');
      await mkdir(textDir, { recursive: true });
      for (const [name, content] of Object.entries(files)) await writeFile(join(textDir, name), content);
      const e = { ...env(), AGENTIC_ORCHESTRATOR_ROOT: ORCH_ROOT, TMPDIR: dir, SUMMARY: 'SUMMARY from the environment', ...extra };
      delete e.CLAUDE_PLUGIN_ROOT;
      return spawnSync(shell, ['-c', withTextDir(block, textDir)], { cwd: dir, encoding: 'utf8', env: e });
    };
    const PLAN_FILES = { 'subtasks.json': JSON.stringify(SUBTASKS), 'decision.txt': 'Split A\n', 'architecture.txt': 'One lane\n' };
    const NOTE_FILES = { 'note.md': 'The note\n', 'summary.txt': 'The summary\n' };
    it('a conflict passes the run id to plan-set, then writes the task file after the ensemble commit; another verdict writes none', () => withMacro(async ({ dir, macro, id }) => {
      const [planSet, finalize] = await planPhase2Blocks();
      let r = await runBlock(dir, planSet, { ACTIVE: macro, VERDICT: 'conflict', RUN_ID: RUN }, PLAN_FILES);
      strictEqual(r.status, 0, r.stderr);
      strictEqual((await readWorkflow(macro)).frontmatter.awaiting_owner_run_id, RUN);
      // The contested items come from the peer's positions: the agent writes
      // them to a file, and no line of them, a delimiter-like one included, is
      // ever shell source.
      ok(!/<<\s*'?CONTESTED|<the contested items/.test(finalize), 'the block holds no contested items of its own');
      const contested = '--force C1: split A or not; "quoted" $(touch pwned)\nCONTESTED_ITEMS\ntouch pwned2\n';
      const itemsFile = join(dir, 'items.md');
      await writeFile(itemsFile, contested);
      r = await runBlock(dir, finalize, { ACTIVE: macro, VERDICT: 'conflict', RUN_ID: RUN, CONTESTED_FILE: itemsFile }, NOTE_FILES);
      strictEqual(r.status, 0, r.stderr);
      strictEqual(await readFile(task(dir, id, RUN), 'utf8'), contested, 'the contested items, unread by the shell');
      ok(!existsSync(join(dir, 'pwned')) && !existsSync(join(dir, 'pwned2')), 'no line of them ran');
      ok(r.stderr.includes(`→ Proposed, for the owner to run before deciding: /runtime:consensus plan --task-file ${task(dir, id, RUN)} --peers claude,codex --max-rounds 2`), r.stderr);
      strictEqual((await consensusProposal({ workflowPath: macro })).current, true);
      strictEqual((await readWorkflow(macro)).frontmatter.ensemble_results.at(-1).summary, 'The summary', 'the summary is the file\'s, not the environment\'s');
      // A re-plan with concerns: no run id, no task file, the old one retired.
      r = await runBlock(dir, planSet, { ACTIVE: macro, VERDICT: 'concerns', RUN_ID: 'macro-plan-20261001T000000Z-000005' }, PLAN_FILES);
      strictEqual(r.status, 0, r.stderr);
      r = await runBlock(dir, finalize, { ACTIVE: macro, VERDICT: 'concerns', RUN_ID: 'macro-plan-20261001T000000Z-000005' }, NOTE_FILES);
      strictEqual(r.status, 0, r.stderr);
      deepStrictEqual((await readdir(join(dir, '.agentic-plugins/state/orchestrator/consensus'))).sort(), [`${id}.${RUN}.resolved.md`]);
      ok(!r.stderr.includes('runtime:consensus'), r.stderr);
    }));

    it('an empty set of contested items writes no task file and fails the block', () => withMacro(async ({ dir, macro }) => {
      const [, finalize] = await planPhase2Blocks();
      await conflictPlan(macro);
      const itemsFile = join(dir, 'items.md');
      await writeFile(itemsFile, '\n');
      let r = await runBlock(dir, finalize, { ACTIVE: macro, VERDICT: 'conflict', RUN_ID: RUN, CONTESTED_FILE: itemsFile }, NOTE_FILES);
      strictEqual(r.status, 1);
      ok(/the contested items are empty/.test(r.stderr), r.stderr);
      r = await runBlock(dir, finalize, { ACTIVE: macro, VERDICT: 'conflict', RUN_ID: RUN }, NOTE_FILES);
      strictEqual(r.status, 1);
      ok(r.stderr.includes('✗ CONTESTED_FILE names no file of contested items; no task file was written.'), r.stderr);
      ok(!existsSync(join(dir, '.agentic-plugins/state/orchestrator/consensus')), 'no task file');
    }));
  });
}
