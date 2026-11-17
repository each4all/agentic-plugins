// ADR-0067 Decision 4, item 5 (SR, U7c): /orchestrator:next's admission in
// the run locks, through the runbook's own blocks — Phase 3b (join, read
// again, switch), Phase 4's prelude (check) and Phase 5 (check, writeback,
// release) — and the Codex mirror's, with the real orchestrator and engineer
// scripts.
//
// The branches and refusals, each once, in bash (the standard test shape):
// each run is one block, or the few blocks a branch needs, in a fresh shell
// given only the text directory. What only the block's text decides, and no
// run needs to show (the fields the re-read compares, the expectations the
// writeback passes), is checked here with no process. Each runbook path's
// happy path, end to end in every shell it may run in, is in
// test-admission-runbooks-e2e.mjs (the large tier); finalize, abort and
// resume's archive are in test-admission-close-runbooks.mjs; the rules
// subtask-update applies, in process, in test-subtask-provenance.mjs, and
// the flags its CLI forwards in test-subtask-update-expect-cli.mjs.

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, rejects, strictEqual } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileTmpDirs } from '../_tmp.mjs';
import {
  CODEX_PRELUDE, CODEX_REREAD, CODEX_SWITCH, CODEX_TEXT_BLOCKS, ENGINEER_ROOT, JOIN_AND_SWITCH, NEXT_BLOCKS, ORCH_ROOT, ORCH_STATE, RUN, SECRET, SH, WRITEBACK,
  cleanEnv, codexBlock, git, locks, nextFixture, q, setPlan, withTextDir, withTyped,
} from './_admission-runbooks-fixture.mjs';

const makeDir = fileTmpDirs();
const shell = SH;

// What the blocks' text decides, with no process: the runs below exercise one
// field of each kind; these hold the rest of the list.
describe("/orchestrator:next's re-read and writeback name every dispatch field (static)", () => {
  // The re-read after the join compares every field Phase 1's selection
  // carries (U7d, M6), on both hosts.
  it('the switching block on both hosts compares the status, owner, branch, verb, profile and topic after the join', () => {
    const fields = 'for(const k of ["status","engineer_workflow_id","branch","verb","profile","topic"])';
    for (const [where, block, after] of [['next.md Phase 3b', JOIN_AND_SWITCH, 'admission join'], ['the Codex switching block', codexBlock(CODEX_SWITCH), 'NOW_SUBTASK="$(node']]) {
      const at = block.indexOf(fields);
      ok(at >= 0, `${where} compares every dispatch field`);
      ok(block.indexOf(after) >= 0 && block.indexOf(after) < at, `${where}: the comparison comes after ${after}`);
    }
  });
  // The writeback expects every field the child was dispatched for (F2), on
  // both hosts, and the dispatch the child records (ADR-0067 Decision 4,
  // item 5).
  it('the writeback on both hosts expects the dispatched branch, verb, profile and topic, and the dispatch the child records', () => {
    for (const [where, block, event] of [['next.md Phase 5', WRITEBACK, '--event=updated'], ['the Codex Phase 4', codexBlock('--status in_progress'), '--event updated']]) {
      ok(block.includes('  --expect-branch="$SUBTASK_BRANCH" --expect-verb="$SUBTASK_VERB" \\\n'), `${where}: branch and verb`);
      ok(block.includes('  --expect-profile="$SUBTASK_PROFILE" --expect-topic="$SUBTASK_TOPIC" \\\n'), `${where}: profile and topic`);
      ok(block.includes(`  --expect-dispatch="$CHILD_DISPATCH" \\\n  ${event}`), `${where}: the child's dispatch`);
      // Each value it expects is the one Phase 1's selection carries, read
      // once from the text directory's subtask.json, never from the macro as
      // it is now nor set otherwise (the plan-verify of W7-admission).
      for (const [name, key] of [['SUBTASK_BRANCH', 'branch'], ['SUBTASK_VERB', 'verb'], ['SUBTASK_PROFILE', 'profile'], ['SUBTASK_TOPIC', 'topic']]) {
        const sets = block.split('\n').filter((l) => new RegExp(`(^|[\\s;])${name}=`).test(l));
        deepStrictEqual(sets, [`${name}="$(JSON_KEY=${key} node -e "$JSON_FIELD" < "$TEXT_DIR/subtask.json")" || exit 1`], `${where}: ${name} is read from the selection, once`);
      }
    }
  });
});

describe('/orchestrator:next joins the run locks before it switches (ADR-0067 Decision 4, item 5)', () => {
  const f = nextFixture(makeDir);

  it(`${shell}: joins both locks, switches, and holds the admission until Phase 5, which writes the subtask back and releases it`, async () => {
    const joined = f.joinAndSwitch(shell);
    strictEqual(joined.status, 0, joined.stderr);
    const id = joined.vars.ADMISSION;
    match(id, /^[0-9a-f]{32}$/);
    strictEqual(f.branch(), 'feat/t1');
    deepStrictEqual(f.sessionEntries(f.laneLock), [`s-${id}.json`], "the lane's worktree lock");
    deepStrictEqual(f.sessionEntries(f.macroLock), [`s-${id}.json`], 'and the macro lock, under the main checkout');
    const pre = f.prelude(shell, id);
    strictEqual(pre.status, 0, pre.stderr);
    strictEqual(pre.vars.EXPORTED, f.macroId, 'the prelude went on to the exports');
    const child = f.engineerChild();
    const wrote = f.writeback(shell, id);
    strictEqual(wrote.status, 0, wrote.stderr);
    const t1 = await f.subtask();
    deepStrictEqual([t1.status, t1.engineer_workflow_id], ['in_progress', f.idOf(child)]);
    deepStrictEqual(f.held(), [], 'released after the writeback');
  });

  it(`${shell}: contention — another session's /orchestrator:next is refused, naming the holder; nothing is switched or left behind`, async () => {
    const first = f.joinAndSwitch(shell);
    strictEqual(first.status, 0, first.stderr);
    git(f.lane, 'switch', '-q', 'feat/x');
    // Same lane, another macro: the worktree lock. The main checkout, the
    // same macro: the macro lock.
    for (const over of [{ macroPath: join(dirname(f.macroPath), 'macro-plan-20261008T000000Z-ad0002.md') }, { repoRoot: f.main }]) {
      const second = f.joinAndSwitch(shell, over);
      strictEqual(second.status, 1, second.stdout);
      match(second.stderr, /an interactive session holds .*\/orchestrator:next, checkout .*lane, host claude, .*admission [0-9a-f]{32}/);
      strictEqual(second.vars.ADMISSION, undefined, 'the block stopped at the join');
    }
    strictEqual(f.branch(), 'feat/x', 'nothing was switched');
    deepStrictEqual(f.held(), [`s-${first.vars.ADMISSION}.json`, `s-${first.vars.ADMISSION}.json`], "the first session's entries kept, no other");
  });

  it(`${shell}: an interrupted command — its entries outlive it and block a run, until the release command its refusal names removes them`, async () => {
    const dead = f.joinAndSwitch(shell);
    strictEqual(dead.status, 0, dead.stderr);
    // The session dies before Phase 5.
    await rejects(f.holdAsRun(), (err) => err instanceof locks.LockHeldError && /an interactive session holds/.test(err.message));
    const refused = f.joinAndSwitch(shell, { repoRoot: f.main });
    const release = refused.stderr.match(/state\.mjs admission release [^\n]*?--admission [0-9a-f]{32}/)?.[0];
    ok(release, refused.stderr);
    const r = spawnSync(shell, ['-c', `node ${q(ORCH_STATE)} ${release.slice('state.mjs '.length)}`], { encoding: 'utf8', env: cleanEnv() });
    strictEqual(r.status, 0, r.stderr);
    deepStrictEqual(f.held(), []);
    const run = await f.holdAsRun();
    for (const h of run) h.release();
  });

  it(`${shell}: a released admission is seen by check — the prelude stops before the exports, and Phase 5 writes nothing`, async () => {
    const joined = f.joinAndSwitch(shell);
    strictEqual(joined.status, 0, joined.stderr);
    const id = joined.vars.ADMISSION;
    f.release(id);
    const pre = f.prelude(shell, id);
    strictEqual(pre.status, 1, pre.stdout);
    match(pre.stderr, /is gone from .*Stop before acting/);
    strictEqual(pre.vars.EXPORTED, undefined, 'no export ran');
    strictEqual(CODEX_PRELUDE.length, 1, 'one Codex prelude');
    const codex = f.prelude(shell, id, {}, CODEX_PRELUDE[0]);
    strictEqual(codex.status, 1, codex.stdout);
    strictEqual(codex.vars.EXPORTED, undefined, 'the Codex prelude stops too');
    f.engineerChild();
    const wrote = f.writeback(shell, id);
    strictEqual(wrote.status, 1, wrote.stdout);
    match(wrote.stderr, /is gone from .*Stop before acting/, "Phase 5's own check refused");
    strictEqual((await f.subtask()).status, 'pending', 'the macro was not written');
    deepStrictEqual(f.held(), []);
  });

  // A fresh Bash call keeps nothing Phase 4 set, and the shell of Phase 4's
  // engineer call has the engineer's root in CLAUDE_PLUGIN_ROOT: Phase 5 sets
  // the orchestrator's root and the host itself, or its check and release
  // fail and the admission stays in both locks.
  it(`${shell}: Phase 5 sets its own plugin root and host — run as Claude Code loads it, beside the engineer's root, it writes back and releases both locks`, async () => {
    const joined = f.joinAndSwitch(shell);
    strictEqual(joined.status, 0, joined.stderr);
    const id = joined.vars.ADMISSION;
    deepStrictEqual(f.held(), [`s-${id}.json`, `s-${id}.json`], 'held in both locks');
    const child = f.engineerChild();
    // Claude Code writes the plugin path into the braced variable when it
    // loads the command; nothing else names the orchestrator's root here.
    const loaded = WRITEBACK.replaceAll('${CLAUDE_PLUGIN_ROOT}', ORCH_ROOT);
    const wrote = f.writeback(shell, id, { AGENTIC_ORCHESTRATOR_ROOT: '', CLAUDE_PLUGIN_ROOT: ENGINEER_ROOT }, loaded);
    strictEqual(wrote.status, 0, wrote.stderr);
    const t1 = await f.subtask();
    deepStrictEqual([t1.status, t1.engineer_workflow_id], ['in_progress', f.idOf(child)]);
    deepStrictEqual(f.held(), [], 'released from both locks');
  });

  // The Codex mirror's Phase 4 finds the engineer workflow itself, so it
  // runs in a fresh shell call too.
  it(`${shell}: the Codex Phase 4 block, in a fresh shell call, finds the engineer workflow, writes it back and releases`, async () => {
    const id = f.joinCli('codex');
    git(f.lane, 'switch', '-q', 'feat/t1');
    const child = f.engineerChild();
    const wrote = f.writeback(shell, id, {}, codexBlock('--status in_progress'));
    strictEqual(wrote.status, 0, wrote.stderr);
    const t1 = await f.subtask();
    deepStrictEqual([t1.status, t1.engineer_workflow_id], ['in_progress', f.idOf(child)]);
    deepStrictEqual(f.held(), [], 'released from both locks');
  });

  it(`${shell}: Phase 5's no-active-workflow exit releases the admission`, () => {
    const joined = f.joinAndSwitch(shell);
    strictEqual(joined.status, 0, joined.stderr);
    const wrote = f.writeback(shell, joined.vars.ADMISSION);
    strictEqual(wrote.status, 1);
    match(wrote.stderr, /no active workflow on feat\/t1/);
    deepStrictEqual(f.held(), []);
  });

  it(`${shell}: what a run's step could change before the join is read again after it; a change, or a failed switch, releases and switches nothing`, () => {
    // The tree dirtied after Phase 2's clean check.
    writeFileSync(join(f.lane, 'stray.txt'), 'x\n');
    try {
      const dirty = f.joinAndSwitch(shell);
      strictEqual(dirty.status, 1, dirty.stdout);
      match(dirty.stderr, /working tree changed after Phase 2's clean check/);
    } finally {
      rmSync(join(f.lane, 'stray.txt'));
    }
    strictEqual(f.branch(), 'feat/x');
    deepStrictEqual(f.held(), [], 'released on that exit');
    // The subtask branch's engineer workflow Phase 2 saw, gone since.
    const engineerDir = join(f.lane, '.agentic-plugins/state/engineer/workflows');
    mkdirSync(engineerDir, { recursive: true });
    const changed = f.joinAndSwitch(shell, { engineerWorkflow: join(engineerDir, 'compose-20261008T000000Z-000001.md') });
    strictEqual(changed.status, 1, changed.stdout);
    match(changed.stderr, /engineer workflow on 'feat\/t1' changed after Phase 2's ownership check/);
    deepStrictEqual(f.held(), []);
    // A switch that fails: the subtask branch is checked out in the main
    // checkout, so git refuses it in the lane.
    git(f.main, 'switch', '-q', 'feat/t1');
    try {
      const failed = f.joinAndSwitch(shell);
      ok(failed.status !== 0 && failed.vars.ADMISSION === undefined, `git's own status, before the end: ${failed.status} ${failed.stdout}`);
      match(failed.stderr, /'feat\/t1' is already (used by worktree|checked out) at/);
    } finally {
      git(f.main, 'switch', '-q', 'main');
    }
    strictEqual(f.branch(), 'feat/x');
    deepStrictEqual(f.held(), []);
  });

  // U7d — the U7c review's item 3: the selected subtask, read again after
  // the join, before the switch, on both hosts. The run's step lands while
  // `admission join` runs (the shim root), so only a read after the join
  // sees it: a read moved before the join passes the stale selection.
  it(`${shell}: a subtask a run's step completes during the join is read again after it; nothing is switched or dispatched`, async () => {
    // A second subtask keeps the macro open once T1 completes.
    const plan = [f.T1(), { id: 'T2', verb: 'compose', branch: 'feat/t2', blocked_by: ['T1'], status: 'blocked' }];
    await f.freshMacro(plan);
    const step = () => ({ AGENTIC_ORCHESTRATOR_ROOT: f.shim, DURING_JOIN: JSON.stringify(['subtask-update', '--workflow-path', f.macroPath, '--host', 'claude', '--subtask-id', 'T1', '--status', 'completed', '--engineer-workflow-id', 'compose-20261008T000000Z-0d0001', '--event', 'updated']) });
    const claude = f.joinAndSwitch(shell, {}, step());
    strictEqual(claude.status, 1, claude.stdout);
    match(claude.stderr, /Subtask T1 changed after Phase 1's selection \(status was "pending", now "completed"; engineer_workflow_id was "", now "compose-20261008T000000Z-0d0001"\)/);
    strictEqual(f.branch(), 'feat/x');
    deepStrictEqual(f.held(), [], 'released on that exit');
    // The Codex mirror, on a macro of its own: its join block, during which
    // the step lands, then its switching block.
    await f.freshMacro(plan);
    strictEqual(CODEX_REREAD.length, 1, 'one Codex block reads the subtask again');
    const joined = f.codexJoin(shell, {}, step(), f.shim);
    strictEqual(joined.status, 0, joined.stderr);
    strictEqual((await f.subtask()).status, 'completed', 'the step landed during the Codex join');
    const codex = f.codexSwitch(shell, joined.vars.ADMISSION);
    strictEqual(codex.status, 1, codex.stdout);
    match(codex.stderr, /Subtask T1 changed after its selection \(status was "pending", now "completed"; engineer_workflow_id was "", now "compose-20261008T000000Z-0d0001"\)/);
    strictEqual(codex.vars.PASSED, undefined);
    deepStrictEqual(f.held(), [], 'the Codex block released too');
    strictEqual(f.branch(), 'feat/x', 'the Codex block switched nothing');
    // Control: as selected, the Codex block switches and keeps the admission.
    const held2 = f.joinCli('codex');
    const control = f.codexSwitch(shell, held2, { subtask: f.T1({ status: 'completed', engineer_workflow_id: 'compose-20261008T000000Z-0d0001' }) });
    strictEqual(control.status, 0, control.stderr);
    strictEqual(control.vars.PASSED, '1');
    strictEqual(f.branch(), 'feat/t1', 'switched');
    deepStrictEqual(f.held(), [`s-${held2}.json`, `s-${held2}.json`], 'the admission kept for Phase 4');
    f.release(held2);
  });

  // A plan revision (/orchestrator:plan in another session) lands while
  // `admission join` runs: the shim root's state.mjs revises T1 during the
  // join, then hands every call to the real one. Only a read after the join
  // sees it; Phase 1's values are what the agent carries. The branch and the
  // topic, one of each kind of field; the static test above holds the rest of
  // the list the comparison reads.
  it(`${shell}: a plan revision during the join that changes the subtask's branch, verb, profile or topic is read after it; nothing is switched (both hosts)`, async () => {
    const original = f.T1();
    const revisions = [['branch', 'feat/t1b', 'feat/t1'], ['topic', 'a revised topic', '']];
    for (const [field, now, was] of revisions) {
      const env = { AGENTIC_ORCHESTRATOR_ROOT: f.shim, REVISE_MACRO: f.macroPath, REVISE_T1: JSON.stringify({ [field]: now }) };
      const changed = new RegExp(`\\(${field} was ${JSON.stringify(was)}, now ${JSON.stringify(now)}\\)`);
      await setPlan({ workflowPath: f.macroPath, host: 'claude', subtasks: [original] });
      const claude = f.joinAndSwitch(shell, {}, env);
      strictEqual(claude.status, 1, `${field}: ${claude.stdout}${claude.stderr}`);
      match(claude.stderr, new RegExp(`Subtask T1 changed after Phase 1's selection ${changed.source}`));
      strictEqual((await f.subtask())[field], now, `${field}: the revision landed during the join`);
      strictEqual(f.branch(), 'feat/x', `${field}: nothing was switched`);
      deepStrictEqual(f.held(), [], `${field}: released on that exit`);
      // The Codex mirror: its join block, then its switching block.
      await setPlan({ workflowPath: f.macroPath, host: 'claude', subtasks: [original] });
      const joined = f.codexJoin(shell, {}, env, f.shim);
      strictEqual(joined.status, 0, joined.stderr);
      match(joined.vars.ADMISSION, /^[0-9a-f]{32}$/);
      const codex = f.codexSwitch(shell, joined.vars.ADMISSION, {}, {}, f.shim);
      strictEqual(codex.status, 1, `${field}: ${codex.stdout}${codex.stderr}`);
      match(codex.stderr, new RegExp(`Subtask T1 changed after its selection ${changed.source}`));
      strictEqual(codex.vars.PASSED, undefined);
      strictEqual(f.branch(), 'feat/x', `${field}: the Codex block switched nothing`);
      deepStrictEqual(f.held(), [], `${field}: the Codex block released`);
    }
    // Control: through the same shim, no revision — both hosts' blocks
    // switch. The topic ends in a newline, which the selection Phase 1 wrote
    // keeps as the plan holds it.
    await setPlan({ workflowPath: f.macroPath, host: 'claude', subtasks: [{ ...original, topic: 'line one\nline two\n' }] });
    const asRead = { subtask: f.T1({ topic: 'line one\nline two\n' }) };
    const control = f.joinAndSwitch(shell, asRead, { AGENTIC_ORCHESTRATOR_ROOT: f.shim });
    strictEqual(control.status, 0, control.stderr);
    strictEqual(f.branch(), 'feat/t1');
    f.release(control.vars.ADMISSION);
    git(f.lane, 'switch', '-q', 'feat/x');
    const joined = f.codexJoin(shell, asRead, { AGENTIC_ORCHESTRATOR_ROOT: f.shim }, f.shim);
    strictEqual(joined.status, 0, joined.stderr);
    const codex = f.codexSwitch(shell, joined.vars.ADMISSION, asRead, {}, f.shim);
    strictEqual(codex.status, 0, codex.stderr);
    strictEqual(f.branch(), 'feat/t1');
    f.release(joined.vars.ADMISSION);
  });

  // The SR refine's Refine-verify, F1: a plan revision during the join gives
  // the pending subtask a predecessor not yet completed, every field the
  // re-read compares unchanged. Phase 1's dependency gate is judged again.
  it(`${shell}: a plan revision during the join that makes the subtask wait on a predecessor is judged after it; nothing is switched (both hosts)`, async () => {
    const t1 = f.T1();
    const revised = (t2Status) => JSON.stringify([{ ...t1, blocked_by: ['T2'] }, { id: 'T2', verb: 'compose', branch: 'feat/t2', blocked_by: [], status: t2Status }]);
    const env = { AGENTIC_ORCHESTRATOR_ROOT: f.shim, REVISE_MACRO: f.macroPath, REVISE_PLAN: revised('pending') };
    const claude = f.joinAndSwitch(shell, {}, env);
    strictEqual(claude.status, 1, `${claude.stdout}${claude.stderr}`);
    match(claude.stderr, /Subtask T1 now waits on: T2 \(the plan changed after Phase 1's selection\); nothing was switched/);
    deepStrictEqual((await f.subtask()).blocked_by, ['T2'], 'the revision landed during the join');
    strictEqual(f.branch(), 'feat/x', 'nothing was switched');
    deepStrictEqual(f.held(), [], 'released on that exit');
    // The Codex mirror: its join block, then its switching block.
    await setPlan({ workflowPath: f.macroPath, host: 'claude', subtasks: [t1] });
    const joined = f.codexJoin(shell, {}, env, f.shim);
    strictEqual(joined.status, 0, joined.stderr);
    const codex = f.codexSwitch(shell, joined.vars.ADMISSION, {}, {}, f.shim);
    strictEqual(codex.status, 1, `${codex.stdout}${codex.stderr}`);
    match(codex.stderr, /Subtask T1 now waits on: T2 \(the plan changed after its selection\); nothing was switched/);
    strictEqual(codex.vars.PASSED, undefined);
    strictEqual(f.branch(), 'feat/x', 'the Codex block switched nothing');
    deepStrictEqual(f.held(), [], 'the Codex block released');
    // Control: the same revision with T2 completed leaves T1 ready. The gate
    // judges readiness, not a changed blocked_by: both hosts switch.
    await setPlan({ workflowPath: f.macroPath, host: 'claude', subtasks: [t1] });
    const ready = { ...env, REVISE_PLAN: revised('completed') };
    const control = f.joinAndSwitch(shell, {}, ready);
    strictEqual(control.status, 0, control.stderr);
    strictEqual(f.branch(), 'feat/t1');
    f.release(control.vars.ADMISSION);
    git(f.lane, 'switch', '-q', 'feat/x');
    const codexJoined = f.codexJoin(shell, {}, ready, f.shim);
    strictEqual(codexJoined.status, 0, codexJoined.stderr);
    const codexControl = f.codexSwitch(shell, codexJoined.vars.ADMISSION, {}, {}, f.shim);
    strictEqual(codexControl.status, 0, codexControl.stderr);
    strictEqual(f.branch(), 'feat/t1');
    f.release(codexJoined.vars.ADMISSION);
  });

  // The SR refine's Refine-verify, F2: another session's /orchestrator:plan
  // lands between Phase 3b and Phase 5 (two Bash calls). The child was
  // dispatched for the subtask as Phase 1 read it; the writeback must not
  // bind it to the revised subtask. The verb and the topic, one field of
  // each line the writeback passes; the static test above holds all four.
  it(`${shell}: a plan revision after the switch that changes the subtask's branch, verb, profile or topic refuses the writeback; the child stays unrecorded and the admission is released (both hosts)`, async () => {
    const original = f.T1();
    const revisions = [['verb', 'refine', 'compose'], ['topic', 'a revised topic', '']];
    const blocks = [['claude', WRITEBACK], ['codex', codexBlock('--status in_progress')]];
    git(f.lane, 'switch', '-q', 'feat/t1');
    const childId = f.idOf(f.engineerChild());
    for (const [field, now, was] of revisions) {
      for (const [host, block] of blocks) {
        await setPlan({ workflowPath: f.macroPath, host: 'claude', subtasks: [original] });
        const id = f.joinCli(host);
        await setPlan({ workflowPath: f.macroPath, host: 'claude', subtasks: [{ ...original, [field]: now }] });
        const wrote = f.writeback(shell, id, {}, block);
        strictEqual(wrote.status, 1, `${host}, ${field}: ${wrote.stdout}`);
        ok(wrote.stderr.includes(`subtask "T1" ${field} is ${JSON.stringify(now)}, not the expected ${JSON.stringify(was)}`), `${host}, ${field}: ${wrote.stderr}`);
        const t1 = await f.subtask();
        deepStrictEqual([t1.status, t1.engineer_workflow_id, t1[field]], ['pending', undefined, now], `${host}, ${field}: the child is not bound to the revised subtask`);
        deepStrictEqual(f.held(), [], `${host}, ${field}: released`);
      }
    }
    // Control: no revision. The plan's topic ends in a newline, which the
    // block's command substitution drops from what it reads, and it has no
    // profile: both writebacks bind the child.
    for (const [host, block] of blocks) {
      await setPlan({ workflowPath: f.macroPath, host: 'claude', subtasks: [{ ...original, topic: 'line one\nline two\n' }] });
      const id = f.joinCli(host);
      const wrote = f.writeback(shell, id, {}, block, { subtask: f.T1({ topic: 'line one\nline two\n' }) });
      strictEqual(wrote.status, 0, `${host}: ${wrote.stderr}`);
      const t1 = await f.subtask();
      deepStrictEqual([t1.status, t1.engineer_workflow_id], ['in_progress', childId], `${host}: bound`);
      deepStrictEqual(f.held(), [], `${host}: released`);
    }
  });

  // ADR-0067 Decision 4, item 5 — a child re-attached from an earlier
  // dispatch (its writeback was refused, or never ran) while the plan was
  // revised since: Phase 1 read the revised subtask, so its own values match,
  // but the child was dispatched for the subtask as it was. Contract: Phase
  // 5 passes the dispatch the child records, and the write is refused. One
  // field: the comparison of each is subtask-update's, tested in process
  // (test-plan-rebind.mjs); the block's part is to pass the record.
  it(`${shell}: a re-attached child whose recorded dispatch the revised subtask no longer matches is not bound, though Phase 1's values match (both hosts)`, async () => {
    const original = f.T1();
    const [field, now, was] = ['topic', 'a revised topic', ''];
    const blocks = [['claude', WRITEBACK], ['codex', codexBlock('--status in_progress')]];
    git(f.lane, 'switch', '-q', 'feat/t1');
    const childId = f.idOf(f.engineerChild({ subtask: 'T1', branch: 'feat/t1', verb: 'compose', profile: '', topic: '' }));
    for (const [host, block] of blocks) {
      await setPlan({ workflowPath: f.macroPath, host: 'claude', subtasks: [{ ...original, [field]: now }] });
      const id = f.joinCli(host);
      const wrote = f.writeback(shell, id, {}, block, { subtask: f.T1({ [field]: now }) });
      strictEqual(wrote.status, 1, `${host}, ${field}: ${wrote.stdout}`);
      ok(wrote.stderr.includes(`(dispatch-changed): ${field} is ${JSON.stringify(now)}; the child was dispatched for ${JSON.stringify(was)}`), `${host}, ${field}: ${wrote.stderr}`);
      const t1 = await f.subtask();
      deepStrictEqual([t1.status, t1.engineer_workflow_id], ['pending', undefined], `${host}, ${field}: not bound`);
      deepStrictEqual(f.held(), [], `${host}, ${field}: released`);
    }
    // Control: the subtask as the child records it binds on both hosts.
    for (const [host, block] of blocks) {
      await setPlan({ workflowPath: f.macroPath, host: 'claude', subtasks: [original] });
      const wrote = f.writeback(shell, f.joinCli(host), {}, block);
      strictEqual(wrote.status, 0, `${host}: ${wrote.stderr}`);
      deepStrictEqual([(await f.subtask()).status, (await f.subtask()).engineer_workflow_id], ['in_progress', childId], `${host}: bound`);
      deepStrictEqual(f.held(), [], `${host}: released`);
    }
  });

  it(`${shell}: a worker of the run holding both locks passes with an empty id, and switches; another session is refused`, async () => {
    const run = await f.holdAsRun();
    try {
      const worker = { AGENTIC_AUTOPILOT: RUN, AGENTIC_AUTOPILOT_TOKEN: SECRET };
      const joined = f.joinAndSwitch(shell, {}, worker);
      strictEqual(joined.status, 0, joined.stderr);
      strictEqual(joined.vars.ADMISSION, '', 'an empty admission id');
      strictEqual(f.branch(), 'feat/t1');
      deepStrictEqual(f.held(), [], 'no entry');
      strictEqual(f.prelude(shell, '', worker).status, 0, "the worker's check passes");
      git(f.lane, 'switch', '-q', 'feat/x');
      const other = f.joinAndSwitch(shell);
      strictEqual(other.status, 1, other.stdout);
      match(other.stderr, new RegExp(`another autopilot run holds .*${RUN}`));
      strictEqual(f.branch(), 'feat/x');
    } finally {
      for (const h of run) h.release();
    }
  });

  // Docket C110: a reader's status is its own, apart from its parser's. Each
  // read the switching blocks make, answering valid JSON and then failing,
  // stops the block before the switch; piped into its parser, the read's
  // status was lost and the block switched on what it printed.
  it(`${shell}: a read that prints its answer and then fails stops the switching block, on both hosts; nothing is switched and the admission is released`, () => {
    for (const failing of ['read-subtask', 'subtask-readiness', 'read']) {
      const env = { AGENTIC_ORCHESTRATOR_ROOT: f.shim, FAIL_AFTER: failing };
      const claude = f.joinAndSwitch(shell, {}, env);
      strictEqual(claude.status, 1, `${failing}: ${claude.stdout}${claude.stderr}`);
      strictEqual(f.branch(), 'feat/x', `${failing}: nothing was switched`);
      deepStrictEqual(f.held(), [], `${failing}: released`);
      const codex = f.codexSwitch(shell, f.joinCli('codex'), {}, { FAIL_AFTER: failing }, f.shim);
      strictEqual(codex.status, 1, `${failing} (Codex): ${codex.stdout}${codex.stderr}`);
      strictEqual(codex.vars.PASSED, undefined);
      strictEqual(f.branch(), 'feat/x', `${failing} (Codex): nothing was switched`);
      deepStrictEqual(f.held(), [], `${failing} (Codex): released`);
    }
    // Control: the same shim, with no read failing, switches.
    const control = f.joinAndSwitch(shell, {}, { AGENTIC_ORCHESTRATOR_ROOT: f.shim });
    strictEqual(control.status, 0, control.stderr);
    strictEqual(f.branch(), 'feat/t1');
    f.release(control.vars.ADMISSION);
  });

  // Docket C68: a JSON answer that does not parse stops Phase 1 with the
  // parser's error, rather than reading as no subtask ("Unexpected next-ready
  // reason: unknown") or as empty fields; nothing is selected.
  it('a next-ready answer that does not parse stops the selection, loudly, and selects nothing', () => {
    const [phase0, selection] = NEXT_BLOCKS;
    const bad = join(f.dir, 'bad-root');
    mkdirSync(join(bad, 'scripts'), { recursive: true });
    writeFileSync(join(bad, 'scripts', 'state.mjs'), [
      "import { spawnSync } from 'node:child_process';",
      'const args = process.argv.slice(2);',
      `if (args[0] === 'next-ready') { process.stdout.write('{"ready": {"id": "T1", "topic": "cut'); process.exit(0); }`,
      `const r = spawnSync(process.execPath, [${JSON.stringify(ORCH_STATE)}, ...args], { stdio: 'inherit' });`,
      'process.exit(r.status ?? 1);',
    ].join('\n'));
    const textDir = mkdtempSync(join(f.dir, 'agentic-text.'));
    strictEqual(f.run(shell, withTyped(withTextDir(phase0, textDir), `--workflow=${f.macroId}`)).status, 0);
    const r = f.run(shell, withTextDir(selection, textDir), { AGENTIC_ORCHESTRATOR_ROOT: bad });
    strictEqual(r.status, 1, r.stdout);
    match(r.stderr, /SyntaxError/, "the parser's error is shown");
    ok(!existsSync(join(textDir, 'subtask.json')), 'nothing was selected');
  });

  // C134(a), on both hosts: the subtask id the args file names is the one
  // selected, with two ready, not next-ready's first; and once the arguments
  // are kept, a new args file naming others is refused, never left unread.
  it('the args file selects the subtask it names, on both hosts, and a new args file naming other arguments than the kept ones is refused', async () => {
    await f.freshMacro([f.T1(), { id: 'T2', verb: 'compose', branch: 'feat/t2', blocked_by: [], status: 'pending' }]);
    const [phase0, selection] = NEXT_BLOCKS;
    const [codexPhase1] = CODEX_TEXT_BLOCKS;
    ok(codexPhase1.includes('command-args'), "the Codex skill's first block parses the args file");
    const selected = (textDir) => JSON.parse(readFileSync(join(textDir, 'subtask.json'), 'utf8')).id;
    const hosts = {
      claude: (textDir, text) => {
        const zero = f.run(shell, withTextDir(text === undefined ? phase0 : withTyped(phase0, text), textDir));
        return zero.status === 0 ? f.run(shell, withTextDir(selection, textDir)) : zero;
      },
      codex: (textDir, text) => f.run(shell, withTextDir(text === undefined ? codexPhase1 : withTyped(codexPhase1, text), textDir)),
    };
    for (const [host, select] of Object.entries(hosts)) {
      // Control: no subtask id, so next-ready's first.
      const auto = mkdtempSync(join(f.dir, 'agentic-text.'));
      const first = select(auto, `--workflow=${f.macroId}`);
      strictEqual(first.status, 0, `${host}: ${first.stderr}`);
      strictEqual(selected(auto), 'T1', `${host}: next-ready picks T1`);

      const textDir = mkdtempSync(join(f.dir, 'agentic-text.'));
      const named = select(textDir, `T2 --workflow=${f.macroId}`);
      strictEqual(named.status, 0, `${host}: ${named.stderr}`);
      strictEqual(selected(textDir), 'T2', `${host}: the named subtask`);
      const kept = readFileSync(join(textDir, 'arguments.json'), 'utf8');
      const keptSelection = readFileSync(join(textDir, 'subtask.json'), 'utf8');

      const other = select(textDir, `--workflow=${f.macroId}`);
      strictEqual(other.status, 1, `${host}: ${other.stdout}`);
      match(other.stderr, /names other arguments than the ones kept/, host);
      strictEqual(readFileSync(join(textDir, 'arguments.json'), 'utf8'), kept, `${host}: the kept arguments stay`);
      strictEqual(readFileSync(join(textDir, 'subtask.json'), 'utf8'), keptSelection, `${host}: nothing was selected`);
      // The same arguments again, and no new args file, both run on the kept ones.
      for (const text of [`T2 --workflow=${f.macroId}`, undefined]) {
        const again = select(textDir, text);
        strictEqual(again.status, 0, `${host} (${text ?? 'no args file'}): ${again.stderr}`);
        strictEqual(selected(textDir), 'T2', `${host} (${text ?? 'no args file'})`);
      }
    }
  });
});
