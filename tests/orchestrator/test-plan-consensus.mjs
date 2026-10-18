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
import { existsSync, realpathSync } from 'node:fs';
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
  appendPhase, approvePlan, withFileLock, setMacroTerminal,
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
// The verdict, which each block holds in its own line: it runs in a fresh
// shell, so no VERDICT of an earlier block reaches it (docket C75).
const VERDICT_LINE = "VERDICT='<pass|concerns|conflict>'";
function withTextDir(block, textDir, verdict) {
  ok(block.startsWith(`${TEXT_DIR_LINE}\n`), 'the block opens with its text directory');
  ok(block.includes(VERDICT_LINE), 'the block holds its VERDICT line');
  return block.replace(TEXT_DIR_LINE, () => `TEXT_DIR='${textDir}'`).replace(VERDICT_LINE, () => `VERDICT='${verdict}'`);
}

for (const shell of SHELLS) {
  describe(`/orchestrator:plan conflict branch, run (${shell}) (ADR-0067 Decision 8)`, () => {
    // The agent writes each file before the block that reads it, and the
    // dispatch wrote the run id; so does this. The contested items go to
    // contested.md, and Phase 0 wrote the macro's path, as create and
    // find-active print it, to macro-path. Nothing else reaches the block from
    // the environment: SUMMARY there is not the summary, and VERDICT, RUN_ID and
    // ACTIVE there are not read.
    const runBlock = async (dir, block, { VERDICT, RUN_ID, CONTESTED_FILE, MACRO }, files = {}) => {
      const textDir = join(dir, 'texts');
      await mkdir(textDir, { recursive: true });
      await rm(join(textDir, 'contested.md'), { force: true });
      for (const [name, content] of Object.entries({ ...files, 'run-id': RUN_ID, 'run-macro': realpathSync(MACRO), 'macro-path': realpathSync(MACRO) })) await writeFile(join(textDir, name), content);
      if (CONTESTED_FILE) await writeFile(join(textDir, 'contested.md'), await readFile(CONTESTED_FILE));
      const e = { ...env(), AGENTIC_ORCHESTRATOR_ROOT: ORCH_ROOT, TMPDIR: dir, SUMMARY: 'SUMMARY from the environment', VERDICT: 'pass', RUN_ID: 'from the environment', ACTIVE: join(dir, 'not-the-macro.md') };
      delete e.CLAUDE_PLUGIN_ROOT;
      return spawnSync(shell, ['-c', withTextDir(block, textDir, VERDICT)], { cwd: dir, encoding: 'utf8', env: e });
    };
    const PLAN_FILES = { 'subtasks.json': JSON.stringify(SUBTASKS), 'decision.txt': 'Split A\n', 'architecture.txt': 'One lane\n' };
    const NOTE_FILES = { 'note.md': 'The note\n', 'summary.txt': 'The summary\n' };
    it('a conflict passes the run id to plan-set, then writes the task file after the ensemble commit; another verdict writes none', () => withMacro(async ({ dir, macro, id }) => {
      const [planSet, finalize] = await planPhase2Blocks();
      let r = await runBlock(dir, planSet, { VERDICT: 'conflict', RUN_ID: RUN, MACRO: macro }, PLAN_FILES);
      strictEqual(r.status, 0, r.stderr);
      strictEqual((await readWorkflow(macro)).frontmatter.awaiting_owner_run_id, RUN);
      // The contested items come from the peer's positions: the agent writes
      // them to a file, and no line of them, a delimiter-like one included, is
      // ever shell source.
      ok(!/<<\s*'?CONTESTED|<the contested items/.test(finalize), 'the block holds no contested items of its own');
      const contested = '--force C1: split A or not; "quoted" $(touch pwned)\nCONTESTED_ITEMS\ntouch pwned2\n';
      const itemsFile = join(dir, 'items.md');
      await writeFile(itemsFile, contested);
      r = await runBlock(dir, finalize, { VERDICT: 'conflict', RUN_ID: RUN, CONTESTED_FILE: itemsFile, MACRO: macro }, NOTE_FILES);
      strictEqual(r.status, 0, r.stderr);
      strictEqual(await readFile(task(dir, id, RUN), 'utf8'), contested, 'the contested items, unread by the shell');
      ok(!existsSync(join(dir, 'pwned')) && !existsSync(join(dir, 'pwned2')), 'no line of them ran');
      // The block takes the macro from macro-path, which names it by its real path.
      ok(r.stderr.includes(`→ Proposed, for the owner to run before deciding: /runtime:consensus plan --task-file ${task(realpathSync(dir), id, RUN)} --peers claude,codex --max-rounds 2`), r.stderr);
      strictEqual((await consensusProposal({ workflowPath: macro })).current, true);
      strictEqual((await readWorkflow(macro)).frontmatter.ensemble_results.at(-1).summary, 'The summary', 'the summary is the file\'s, not the environment\'s');
      // A re-plan with concerns: no run id, no task file, the old one retired.
      r = await runBlock(dir, planSet, { VERDICT: 'concerns', RUN_ID: 'macro-plan-20261001T000000Z-000005', MACRO: macro }, PLAN_FILES);
      strictEqual(r.status, 0, r.stderr);
      r = await runBlock(dir, finalize, { VERDICT: 'concerns', RUN_ID: 'macro-plan-20261001T000000Z-000005', MACRO: macro }, { ...NOTE_FILES, 'note.md': 'The re-plan note\n' });
      strictEqual(r.status, 0, r.stderr);
      deepStrictEqual((await readdir(join(dir, '.agentic-plugins/state/orchestrator/consensus'))).sort(), [`${id}.${RUN}.resolved.md`]);
      ok(!r.stderr.includes('runtime:consensus'), r.stderr);
      // The re-plan's note is recorded after the first (Critique F1).
      const { body } = await readWorkflow(macro);
      ok(body.indexOf('### Phase 1: Plan (synthesized)\n\nThe note\n') !== -1 && body.indexOf('### Phase 1: Plan (synthesized)\n\nThe note\n') < body.indexOf('### Phase 1: Plan (synthesized)\n\nThe re-plan note\n'), body);
    }));

    // C132: the contested items are checked with the other inputs, before
    // any write, so a conflict without them records neither the note nor the
    // ensemble result.
    it('an empty or missing set of contested items fails the block before any write', () => withMacro(async ({ dir, macro }) => {
      const [, finalize] = await planPhase2Blocks();
      await conflictPlan(macro);
      const before = await readFile(macro, 'utf8');
      const itemsFile = join(dir, 'items.md');
      await writeFile(itemsFile, '\n');
      let r = await runBlock(dir, finalize, { VERDICT: 'conflict', RUN_ID: RUN, CONTESTED_FILE: itemsFile, MACRO: macro }, NOTE_FILES);
      strictEqual(r.status, 1);
      ok(/contested\.md is missing or blank: .*nothing was written\./.test(r.stderr), r.stderr);
      r = await runBlock(dir, finalize, { VERDICT: 'conflict', RUN_ID: RUN, MACRO: macro }, NOTE_FILES);
      strictEqual(r.status, 1);
      ok(/contested\.md is missing or blank: .*nothing was written\./.test(r.stderr), r.stderr);
      strictEqual(await readFile(macro, 'utf8'), before, 'nothing was written');
      ok(!existsSync(join(dir, '.agentic-plugins/state/orchestrator/consensus')), 'no task file');
    }));
  });
}

// C132 — the plan finalize's machine records: the run whose phase note an
// `append --run-id` wrote (phase_note_run_ids) and the run whose plan-conflict
// gate the owner cleared (plan_conflict_cleared_run_id). A rerun decides from
// them, never from note prose.
describe('C132: the plan finalize\'s machine records', () => {
  const R2 = 'macro-plan-20261001T000000Z-000002';
  const keyed = (macro, runId, note = 'synthesis') => appendPhase({
    workflowPath: macro, host: 'claude', phaseLabel: 'Phase 1: Plan (synthesized)', phaseNote: note,
    currentPhase: 'phase-2-presented', event: 'updated', requireOpen: true, runId,
  });
  const records = async (macro) => {
    const { frontmatter } = await readWorkflow(macro);
    return [frontmatter.phase_note_run_ids, frontmatter.plan_conflict_cleared_run_id];
  };

  it('an older macro without the records reads as none, in the API and in read\'s JSON', () => withMacro(async ({ macro }) => {
    deepStrictEqual(await records(macro), [undefined, undefined]);
    const r = cli(['read', '--workflow-path', macro]);
    strictEqual(r.status, 0, r.stderr);
    const json = JSON.parse(r.stdout);
    ok(!('phase_note_run_ids' in json) && !('plan_conflict_cleared_run_id' in json), r.stdout);
    ok(!/phase_note_run_ids|plan_conflict_cleared_run_id/.test(await readFile(macro, 'utf8')), 'no key is written until a record is');
  }));

  it('an append keyed by a run records it; the same run again writes nothing; another run appends and is added', () => withMacro(async ({ macro }) => {
    const first = await keyed(macro, RUN);
    strictEqual(first.skipped, false);
    deepStrictEqual(await records(macro), [RUN, undefined]);
    const once = await readFile(macro, 'utf8');
    strictEqual(once.split('Phase 1: Plan (synthesized)').length - 1, 1);
    const again = await keyed(macro, RUN, 'a different body, same run');
    strictEqual(again.skipped, true);
    strictEqual(await readFile(macro, 'utf8'), once, 'nothing was written: not the note, the phase, updated_at or host_history');
    const r = cli(['append', '--workflow-path', macro, '--host', 'claude', '--phase-label', 'Phase 1: Plan (synthesized)', '--phase-note', 'x', '--run-id', RUN, '--require-open']);
    strictEqual(r.status, 0, r.stderr);
    strictEqual(r.stdout, `${macro}\n`);
    ok(/already recorded \(phase_note_run_ids\); nothing written/.test(r.stderr), r.stderr);
    strictEqual(await readFile(macro, 'utf8'), once, 'the CLI writes nothing either');
    await keyed(macro, R2);
    deepStrictEqual(await records(macro), [`${RUN} ${R2}`, undefined]);
    strictEqual((await readFile(macro, 'utf8')).split('Phase 1: Plan (synthesized)').length - 1, 2, 'the second run has its own note');
    await appendPhase({ workflowPath: macro, host: 'claude', phaseLabel: 'Unkeyed', phaseNote: 'u', event: 'updated' });
    await appendPhase({ workflowPath: macro, host: 'claude', phaseLabel: 'Unkeyed', phaseNote: 'u', event: 'updated' });
    strictEqual((await readFile(macro, 'utf8')).split('### Unkeyed').length - 1, 2, 'an unkeyed append appends as before');
    deepStrictEqual(await records(macro), [`${RUN} ${R2}`, undefined], 'and leaves the record alone');
  }));

  it('a keyed append is decided and recorded under the macro lock', () => withMacro(async ({ macro }) => {
    const before = await readFile(macro, 'utf8');
    let pending;
    let during;
    await withFileLock(macro, async () => {
      pending = keyed(macro, RUN);
      pending.catch(() => {});
      await new Promise((r) => setTimeout(r, 400));
      during = await readFile(macro, 'utf8');
    });
    strictEqual((await pending).skipped, false);
    strictEqual(during, before, 'the append waited for the lock');
    deepStrictEqual(await records(macro), [RUN, undefined]);
    // Two keyed appends of one run racing: one note.
    const [a, b] = await Promise.all([keyed(macro, R2), keyed(macro, R2)]);
    deepStrictEqual([a.skipped, b.skipped].sort(), [false, true]);
    strictEqual((await readFile(macro, 'utf8')).split('Phase 1: Plan (synthesized)').length - 1, 2);
  }));

  it('a run id that is not one, an empty one, and a terminal macro are refused with the file unchanged', () => withMacro(async ({ macro }) => {
    const before = await readFile(macro, 'utf8');
    for (const bad of ['', 'a.b', 'run\r', '-x', 'x'.repeat(129)]) {
      await rejects(keyed(macro, bad), /--run-id must be a run id/, JSON.stringify(bad));
      const r = cli(['append', '--workflow-path', macro, '--host', 'claude', '--phase-note', 'n', `--run-id=${bad}`]);
      strictEqual(r.status, 1, `${JSON.stringify(bad)}: ${r.stderr}`);
    }
    strictEqual(await readFile(macro, 'utf8'), before);
    for (const value of ['a.b', '', 'a  b', 'a b a', ' a', Array.from({ length: 65 }, (_, i) => `r${i}`).join(' ')]) {
      await writeFile(macro, before.replace(/^(workflow_id: .*)$/m, `$1\nphase_note_run_ids: ${JSON.stringify(value)}`));
      await rejects(readWorkflow(macro), /phase_note_run_ids must list 1 to 64 distinct run ids/, JSON.stringify(value));
    }
    await writeFile(macro, before.replace(/^(workflow_id: .*)$/m, `$1\nplan_conflict_cleared_run_id: "../x"`));
    await rejects(readWorkflow(macro), /plan_conflict_cleared_run_id must be a run id/);
    // A terminal macro is refused before the record is looked at, for its own run too.
    await writeFile(macro, before);
    await keyed(macro, RUN);
    await setMacroTerminal({ workflowPath: macro, host: 'claude', terminalPhase: 'aborted' });
    const terminal = await readFile(macro, 'utf8');
    for (const run of [RUN, R2]) await rejects(keyed(macro, run), /terminal macro is not revised/);
    strictEqual(await readFile(macro, 'utf8'), terminal);
  }));

  it('every run keeps its own record: A, B, then A again appends nothing, after a commit or a failure before it', () => withMacro(async ({ macro }) => {
    // append(A) → commit(A) → append(B) → commit(B) → append(A)
    await keyed(macro, RUN);
    await commit(macro, RUN, 'pass');
    await keyed(macro, R2);
    await commit(macro, R2, 'pass');
    strictEqual((await keyed(macro, RUN)).skipped, true);
    // append(A3) → a failure before its commit → append(B4) → retry(A3)
    const A3 = 'macro-plan-20261001T000000Z-000003';
    const B4 = 'macro-plan-20261001T000000Z-000004';
    await keyed(macro, A3);
    await keyed(macro, B4);
    const before = await readFile(macro, 'utf8');
    strictEqual((await keyed(macro, A3)).skipped, true);
    strictEqual(await readFile(macro, 'utf8'), before);
    strictEqual(before.split('Phase 1: Plan (synthesized)').length - 1, 4, 'one note per run');
    deepStrictEqual(await records(macro), [`${RUN} ${R2} ${A3} ${B4}`, undefined]);
  }));

  it('a keyed append needs a note; the list keeps the latest 64 runs', () => withMacro(async ({ macro }) => {
    const before = await readFile(macro, 'utf8');
    for (const note of [null, '', '  \n']) {
      await rejects(keyed(macro, RUN, note), /--run-id records a phase note, so it needs --phase-note/, JSON.stringify(note));
    }
    const r = cli(['append', '--workflow-path', macro, '--host', 'claude', '--phase-label', 'L', '--run-id', RUN]);
    strictEqual(r.status, 1, r.stderr);
    strictEqual(await readFile(macro, 'utf8'), before, 'a refused append records nothing');
    const runs = Array.from({ length: 66 }, (_, i) => `macro-plan-20261001T000000Z-${String(i).padStart(6, '0')}`);
    for (const run of runs) await keyed(macro, run, 'n');
    const [list] = await records(macro);
    deepStrictEqual(list.split(' '), runs.slice(2));
    strictEqual((await keyed(macro, runs[0], 'n')).skipped, false, 'an evicted run appends again: the stated limit');
  }));

  it('consensus-task refuses a run whose plan-conflict gate the owner cleared, under the lock', () => withMacro(async ({ dir, macro, id }) => {
    await conflictPlan(macro);
    await commit(macro, RUN, 'conflict');
    await clearAwaitingOwner({ workflowPath: macro, host: 'claude', gate: 'plan-conflict', env: env() });
    const before = await readFile(macro, 'utf8');
    await rejects(writeConsensusTask({ workflowPath: macro, runId: RUN, text: 'C1' }), /the owner cleared the plan-conflict gate of run .*no consensus round/);
    const r = cli(['consensus-task', '--workflow-path', macro, '--run-id', RUN, '--text', 'C1']);
    strictEqual(r.status, 1);
    strictEqual(r.stdout, '');
    ok(!existsSync(task(dir, id, RUN)), 'no task file');
    strictEqual(await readFile(macro, 'utf8'), before);
  }));

  it('the owner\'s clear records the run of the gate it cleared, and every later write keeps it', () => withMacro(async ({ macro }) => {
    await conflictPlan(macro);
    await keyed(macro, RUN);
    await clearAwaitingOwner({ workflowPath: macro, host: 'claude', gate: 'plan-conflict', env: env() });
    let { frontmatter } = await readWorkflow(macro);
    deepStrictEqual([frontmatter.awaiting_owner_gate, frontmatter.awaiting_owner_run_id, frontmatter.plan_conflict_cleared_run_id], ['plan-approval', undefined, RUN]);
    // Later writes: a commit of the result, a keyed and an unkeyed append, a
    // re-plan with another run's conflict, its clear-less approval path, a
    // re-plan that passes, the approval.
    await commit(macro, RUN, 'conflict');
    await keyed(macro, RUN);
    await appendPhase({ workflowPath: macro, host: 'claude', phaseNote: 'later', event: 'updated' });
    await conflictPlan(macro, R2);
    deepStrictEqual(await records(macro), [RUN, RUN], 'a new conflict gate leaves the earlier clear recorded');
    await setPlan({ workflowPath: macro, host: 'claude', subtasks: SUBTASKS, verdict: 'pass' });
    await approvePlan({ workflowPath: macro, host: 'claude', env: env() });
    ({ frontmatter } = await readWorkflow(macro));
    deepStrictEqual([frontmatter.plan_approval_status, frontmatter.plan_conflict_cleared_run_id], ['approved', RUN]);
    const r = cli(['read', '--workflow-path', macro]);
    strictEqual(JSON.parse(r.stdout).plan_conflict_cleared_run_id, RUN, 'read prints it');
  }));

  it('only the next clear of a run\'s gate replaces the record; a gate raised by hand, with no run, leaves it', () => withMacro(async ({ macro }) => {
    await conflictPlan(macro);
    await clearAwaitingOwner({ workflowPath: macro, host: 'claude', gate: 'plan-conflict', env: env() });
    await setAwaitingOwner({ workflowPath: macro, host: 'claude', gate: 'plan-conflict', pointer: 'x/y.md#ensemble-synthesis' });
    await clearAwaitingOwner({ workflowPath: macro, host: 'claude', gate: 'plan-conflict', env: env() });
    deepStrictEqual(await records(macro), [undefined, RUN]);
    await conflictPlan(macro, R2);
    const r = cli(['awaiting-owner-clear', '--workflow-path', macro, '--host', 'claude', '--gate', 'plan-conflict']);
    strictEqual(r.status, 0, r.stderr);
    deepStrictEqual(await records(macro), [undefined, R2]);
  }));
});
