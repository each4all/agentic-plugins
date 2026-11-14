// ADR-0068 Decision 2, item 5 (impl-hold Task 11): /orchestrator:next never
// dispatches a held subtask by hand. Its hold gate (Phase 1, Phase 3 with the
// engineer's capability, Phase 3b under the holds lock, Phase 4 beside the
// mark) and the dispatch's mark (N4), which the real engineer bootstrap
// continues under AGENTIC_OPERATION_ID, so a hold set during the dispatch
// waits for it; every exit after the mark's publication withdraws a mark no
// child carries.
//
// The standard test shape (AGENTS.md § Build / test / CI, test-addition
// criteria): the gate's and the mark's rules in process, through the
// functions state.mjs calls (lib/hold-ops.mjs); the branches of the CLI's own
// dispatcher (state.mjs hold-gate and dispatch-mark-check) as focused CLI
// calls; the runbook's refusals and exits as runs of its own blocks
// (commands/next.md and the Codex mirror) in one shell. The happy path end to
// end, in every shell, is test-next-holds-e2e.mjs, in the large tier; the
// blocks' CLI calls are checked statically by
// tests/plugin-shape/test-runbook-cli-contracts.mjs.

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileTmpDirs } from '../_tmp.mjs';
import {
  BLOCKS, ENGINEER_ROOT, ENG_STATE, SHELLS, cleanEnv, git, holds, nextHoldsFixture, ops, withTextDir,
} from './_next-holds-fixture.mjs';

const makeDir = fileTmpDirs();

describe('/orchestrator:next and holds (ADR-0068 Decision 2, item 5)', () => {
  const f = nextHoldsFixture(makeDir);
  const lib = () => ({ mainRoot: f.main, macroId: f.macroId, subtaskId: 'T1', branch: 'feat/t1', stateRoots: [f.main, f.lane] });
  /** What hold-gate judges, through the function it calls. */
  const gate = (extra = {}) => ops.handDispatchRefusal({ ...lib(), ...extra });

  describe('the dispatch gate, in the library (hold-gate, dispatch-mark-check)', () => {
    it('a macro whose holds are off: nothing new — no refusal, no output, no holds directory', () => {
      deepStrictEqual(gate(), { active: false, why: null });
      strictEqual(existsSync(holds.holdsDir(f.main, f.macroId)), false);
    });

    it('refuses a pending and a held hold, naming the release; another subtask\'s hold does not refuse', async () => {
      f.activate();
      deepStrictEqual(gate(), { active: true, why: null }, 'on, with no hold');
      const other = await ops.setHold({ mainRoot: f.main, macroId: f.macroId, subtaskId: 'T2', branch: 'feat/t2' });
      ok(other.hold_id);
      deepStrictEqual(gate(), { active: true, why: null }, "another subtask's hold");
      const h = await f.hold();
      match(gate().why, new RegExp(`^subtask T1 is held \\(hold ${h.hold_id}, its handoff pending\\); the owner gives it back with agentic-autopilot release T1 --macro ${f.macroId} --hold ${h.hold_id}$`));
      strictEqual((await f.handoff()).state, 'held');
      match(gate().why, new RegExp(`^subtask T1 is held \\(hold ${h.hold_id}\\); the owner gives it back`));
    });

    it('refuses a hold record that cannot be read, a release not compared yet, a rejected release, and an unreadable marker', async () => {
      f.activate();
      mkdirSync(join(holds.holdsDir(f.main, f.macroId), 'holds'), { recursive: true });
      writeFileSync(holds.recordPath(f.main, f.macroId, 'holds', 'T1'), '{');
      const unreadable = gate();
      strictEqual(unreadable.active, true);
      match(unreadable.why, /hold records cannot be read .*--discard-unreadable keeps a copy/);
      const h = await f.hold().catch(() => null);
      strictEqual(h, null, 'setHold refuses over the unreadable record');
      rmSync(holds.recordPath(f.main, f.macroId, 'holds', 'T1'));
      const held = await f.hold();
      strictEqual((await f.handoff()).state, 'held');
      const basis = { fingerprint_version: 1, fingerprint: 'f', tree_digest: 't', content_digest: 'c', child: null };
      await ops.releaseHold({ ...lib(), holdId: held.hold_id, basisOf: async () => basis });
      const notCompared = gate();
      strictEqual(notCompared.active, true);
      match(notCompared.why, /release \(hold [0-9a-f]+\) is not compared yet; a run compares the release before it steps the lane, and dispatches the subtask once it is ready: launch \/orchestrator:autopilot/);
      const cmp = await ops.compareRelease({ ...lib(), basisOf: async () => ({ ...basis, tree_digest: 'moved' }) });
      strictEqual(cmp.verdict, 'rejected');
      const rejected = gate();
      strictEqual(rejected.active, true);
      match(rejected.why, /was rejected: the lane changed after its release; hold it and release it again/);
      writeFileSync(holds.protocolPath(f.main, f.macroId), '{');
      const r = gate();
      strictEqual(r.active, true);
      match(r.why, /the holds directory of .* cannot be read .* so whether subtask T1 is held cannot be told/);
    });

    it('refuses an open persona operation in the lane, naming writer-clear; a cleared one does not refuse', () => {
      f.activate();
      const id = 'op-20261026T000000Z-0badc0de';
      holds.publishOpRecord(f.main, f.macroId, 'T1', { operation_id: id, kind: 'verb', subtask_id: 'T1' });
      match(gate().why, new RegExp(`a persona operation is open in subtask T1's lane: ${id} \\(verb\\).*agentic-autopilot writer-clear T1 --macro ${f.macroId} --operation <id>`));
      strictEqual(gate({ ownOperationId: id }).why, null, "the dispatch's own mark is not another operation");
      holds.clearOperation(f.main, f.macroId, 'T1', id, { by: 'test' });
      deepStrictEqual(gate(), { active: true, why: null });
    });

    it('an operation begun before the holds turned on (an entry on the child, no record) refuses the gate, naming it and its kind', () => {
      git(f.lane, 'switch', '-q', 'feat/t1');
      const child = f.bootstrap(null);
      strictEqual(child.status, 0, child.stderr);
      git(f.lane, 'switch', '-q', 'feat/x');
      deepStrictEqual(f.entriesOf(child.path).map((o) => o.ext), [false]);
      f.activate();
      const id = f.entriesOf(child.path)[0].id;
      match(gate().why, new RegExp(`a persona operation is open in subtask T1's lane: ${id} \\(verb\\)`));
    });

    it("a mark that cannot be read is no mark: the check's mark problem names it, rather than leaving the engineer's bootstrap a record it refuses", async () => {
      f.activate();
      const m = await ops.publishDispatchMark(lib());
      strictEqual(ops.markProblem({ ...lib(), operationId: m.operationId }), null, 'the mark as published');
      writeFileSync(join(holds.opsDir(f.main, f.macroId, 'T1'), `${m.operationId}.json`), '{');
      match(ops.markProblem({ ...lib(), operationId: m.operationId }), /^the dispatch's mark .* cannot be read/);
    });

    it('the dispatch has handed the lane over once a linked child carries the mark, and only then', async () => {
      f.activate();
      const m = await ops.publishDispatchMark(lib());
      strictEqual(ops.dispatchHandedOver({ ...lib(), operationId: m.operationId }), false, 'no child yet');
      git(f.lane, 'switch', '-q', 'feat/t1');
      const child = f.bootstrap(m.operationId);
      strictEqual(child.status, 0, child.stderr);
      strictEqual(ops.dispatchHandedOver({ ...lib(), operationId: m.operationId }), true);
    });
  });

  describe('the mark, in the library', () => {
    it('a macro whose holds are off: the mark makes no holds directory', async () => {
      const r = await ops.publishDispatchMark(lib());
      deepStrictEqual(r, { active: false, operationId: null });
      strictEqual(existsSync(holds.holdsDir(f.main, f.macroId)), false);
    });

    it('an operation published between the mark and its second look withdraws the mark and refuses', async () => {
      f.activate();
      const rival = 'op-20261026T000000Z-0000beef';
      await ops.publishDispatchMark({ ...lib(), hooks: { afterPublish: () => holds.publishOpRecord(f.main, f.macroId, 'T1', { operation_id: rival, kind: 'checkpoint', subtask_id: 'T1' }) } })
        .then(() => ok(false, 'refused'), (err) => match(err.message, new RegExp(`${rival} \\(checkpoint\\)`)));
      deepStrictEqual(f.records(), [`${rival}.json`], 'the mark is withdrawn, the rival left');
    });

    it('a mark an archived child carries is not withdrawn', async () => {
      f.activate();
      const m = await ops.publishDispatchMark(lib());
      const archive = join(f.lane, '.agentic-plugins/state/engineer/archive');
      mkdirSync(archive, { recursive: true });
      const doc = JSON.stringify(JSON.stringify({ v: 1, ops: [{ id: m.operationId, kind: 'verb', opened_at: '2026-10-26T00:00:00Z', ext: true }] }));
      writeFileSync(join(archive, 'compose-20261026T000000Z-aaaaaa.md'), [
        '---', 'workflow_id: "compose-20261026T000000Z-aaaaaa"', `parent_workflow: "${f.macroId}"`, 'originating_subtask: "T1"',
        'git_baseline:', '  branch: "feat/t1"', `persona_operations: ${doc}`, '---', '', 'body', '',
      ].join('\n'));
      deepStrictEqual(await ops.withdrawDispatchMark({ ...lib(), operationId: m.operationId }), { state: 'carried' });
      deepStrictEqual(f.records(), [`${m.operationId}.json`]);
    });
  });

  describe("the CLI's own branches (state.mjs hold-gate, dispatch-mark-publish, dispatch-mark-check)", () => {
    const markDir = () => mkdtempSync(join(f.dir, 'mark-'));
    const publish = (d, ...extra) => f.orchCli('dispatch-mark-publish', '--mark-file', join(d, 'dispatch-mark.json'), ...extra);
    const check = (d) => f.orchCli('dispatch-mark-check', '--mark-file', join(d, 'dispatch-mark.json'), '--engineer-root', ENGINEER_ROOT);
    const passed = (d) => existsSync(join(d, 'dispatch-mark.json.checked'));

    it('a macro whose holds are off: hold-gate prints nothing and asks no engineer, the one not hold-aware included', () => {
      const r = f.gateCli('--engineer-root', f.fakeEngineer);
      deepStrictEqual([r.status, r.stdout, r.stderr], [0, '', '']);
      strictEqual(existsSync(holds.holdsDir(f.main, f.macroId)), false);
    });

    it("the check refuses a mark whose operation record cannot be read, naming it: the dispatch's own mark is no pass", () => {
      f.activate();
      const d = markDir();
      strictEqual(publish(d).status, 0);
      writeFileSync(join(holds.opsDir(f.main, f.macroId, 'T1'), `${f.mark(d).operation_id}.json`), '{');
      const r = check(d);
      strictEqual(r.status, 1);
      match(r.stderr, /the dispatch's mark .* cannot be read/);
      strictEqual(passed(d), false);
    });

    it('with the holds on, refuses an engineer that is not hold-aware (Phase 3); the real one passes', () => {
      f.activate();
      const r = f.gateCli('--engineer-root', f.fakeEngineer);
      strictEqual(r.status, 1);
      match(r.stderr, /the holds of .* are on, and the engineer at .*old-engineer is not hold-aware .*install the engineer release with hold-persona-1/);
      strictEqual(f.gateCli('--engineer-root', ENGINEER_ROOT).status, 0);
    });

    it('holds turned on after Phase 3b judged them off: the check refuses, since no mark is there for a hold to wait for', () => {
      const d = markDir();
      strictEqual(publish(d).status, 0);
      deepStrictEqual(f.mark(d), { active: false, operation_id: null, reattach: false });
      deepStrictEqual(f.records(), [], 'nothing new while the holds are off');
      f.activate();
      const r = check(d);
      strictEqual(r.status, 1);
      match(r.stderr, /turned on after the dispatch judged them off/);
      strictEqual(passed(d), false);
    });

    it('a re-attach whose holds were off at the switch is judged by the gate once they turned on: a hold refuses it', async () => {
      const d = markDir();
      strictEqual(publish(d, '--reattach', 'true').status, 0);
      deepStrictEqual(f.mark(d), { active: false, operation_id: null, reattach: true });
      f.activate();
      await f.hold();
      const r = check(d);
      strictEqual(r.status, 1);
      match(r.stderr, /subtask T1 is held/);
      strictEqual(passed(d), false);
    });

    it('a dispatch whose holds were off at the switch passes the prelude again (its check) once its engineer holds the lane, though they turned on since', () => {
      const d = markDir();
      strictEqual(publish(d).status, 0);
      const first = check(d);
      strictEqual(first.status, 0, first.stderr);
      ok(passed(d), 'the first check passed');
      git(f.lane, 'switch', '-q', 'feat/t1');
      const child = f.bootstrap(null);
      strictEqual(child.status, 0, child.stderr);
      f.activate();
      const again = check(d);
      strictEqual(again.status, 0, again.stderr);
      ok(passed(d));
    });

    it('a later prelude that refuses removes the earlier pass (its check)', async () => {
      f.activate();
      const d = markDir();
      strictEqual(publish(d).status, 0);
      strictEqual(check(d).status, 0);
      ok(passed(d), 'the first check passed');
      await f.hold();
      strictEqual(check(d).status, 1, 'no engineer holds the lane: the hold refuses');
      strictEqual(passed(d), false);
    });

    it('a check that fails on an error (a mark file that cannot be read) takes its earlier pass away', () => {
      f.activate();
      const d = markDir();
      strictEqual(publish(d).status, 0);
      strictEqual(check(d).status, 0);
      ok(passed(d));
      writeFileSync(join(d, 'dispatch-mark.json'), '{');
      const r = check(d);
      ok(r.status !== 0, 'the check fails');
      match(r.stderr, /dispatch mark file .* cannot be read/);
      strictEqual(passed(d), false);
    });

    it('a check that fails in its discovery (the repository\'s worktrees cannot be listed) takes its earlier pass away first', { skip: process.getuid?.() === 0 && 'root reads a directory without its permission' }, () => {
      f.activate();
      const d = markDir();
      strictEqual(publish(d).status, 0);
      strictEqual(check(d).status, 0);
      ok(passed(d), 'the first check passed');
      const worktrees = join(f.main, '.git', 'worktrees');
      chmodSync(worktrees, 0o111);
      let r;
      try {
        r = check(d);
      } finally {
        chmodSync(worktrees, 0o755);
      }
      ok(r.status !== 0, `the check fails on the worktree list: ${r.stderr}`);
      strictEqual(passed(d), false, 'no earlier pass survives the failed check');
    });
  });

  // The runbook's refusals and exits, in one shell: the blocks' shell
  // portability is the end-to-end run's (every shell) and
  // test-runbook-shell-portability.mjs's.
  const shell = SHELLS[0];
  describe(`the runbook's blocks (${shell})`, () => {
    it("Phase 1's hold gate and Phase 3's capability check refuse, before anything is switched or written", async () => {
      f.activate();
      await f.hold();
      for (const block of [BLOCKS.PHASE1_GATE, BLOCKS.PHASE3]) {
        const r = f.run(shell, withTextDir(block, f.carried()));
        strictEqual(r.status, 1, r.stdout);
        match(r.stderr, /Subtask T1 is not dispatched by hand: subtask T1 is held/);
      }
      strictEqual(f.branch(), 'feat/x');
      deepStrictEqual(f.records(), []);
    });

    it('an exit before the engineer took the mark over withdraws it: a failed switch, and a Phase 5 with no child', async () => {
      f.activate();
      // The switch fails: the subtask's branch is checked out elsewhere.
      git(f.main, 'worktree', 'add', '-q', join(f.dir, 'other'), 'feat/t1');
      let textDir = f.carried();
      const failed = f.run(shell, withTextDir(BLOCKS.JOIN_AND_SWITCH, textDir));
      strictEqual(failed.status === 0, false, 'the switch failed');
      match(f.mark(textDir).operation_id, holds.OPERATION_ID_RE, 'a mark was published before the switch');
      deepStrictEqual(f.records(), [], 'and withdrawn by the exit');
      git(f.main, 'worktree', 'remove', '--force', join(f.dir, 'other'));
      // The engineer never created its child: Phase 5's exit withdraws it.
      textDir = f.carried();
      strictEqual(f.run(shell, withTextDir(BLOCKS.JOIN_AND_SWITCH, textDir)).status, 0);
      strictEqual(f.records().length, 1);
      const wrote = f.run(shell, withTextDir(BLOCKS.WRITEBACK, textDir));
      strictEqual(wrote.status, 1);
      match(wrote.stderr, /withdrew the dispatch mark/);
      deepStrictEqual(f.records(), []);
      strictEqual((await f.subtask()).status, 'pending', 'nothing was recorded in progress');
    });

    it('a hold set before Phase 3b refuses it under the holds lock; nothing is switched, published or held', async () => {
      f.activate();
      await f.hold();
      const textDir = f.carried();
      const r = f.run(shell, withTextDir(BLOCKS.JOIN_AND_SWITCH, textDir));
      strictEqual(r.status, 1);
      match(r.stderr, /Subtask T1 is not dispatched by hand: subtask T1 is held/);
      strictEqual(f.branch(), 'feat/x');
      deepStrictEqual(f.records(), []);
      strictEqual(existsSync(join(textDir, 'dispatch-mark.json')), false);
    });

    it('the prelude run again before a later engineer block passes once the engineer holds the lane, though a hold is set since; the hold is handed over after the verb', async () => {
      f.activate();
      const textDir = f.carried();
      strictEqual(f.run(shell, withTextDir(BLOCKS.JOIN_AND_SWITCH, textDir)).status, 0);
      const pre = f.run(shell, `${withTextDir(BLOCKS.PRELUDE, textDir)}\necho "OPID=\${AGENTIC_OPERATION_ID:-}"`);
      strictEqual(pre.status, 0, pre.stderr);
      // A hold set between the check and the engineer's first write waits.
      await f.hold();
      const child = f.bootstrap(pre.vars.OPID);
      strictEqual(child.status, 0, child.stderr);
      strictEqual((await f.handoff()).state, 'pending', 'the engineer holds the lane: the hold waits');
      const again = f.run(shell, `${withTextDir(BLOCKS.PRELUDE, textDir)}\necho "OPID=\${AGENTIC_OPERATION_ID:-}"`);
      strictEqual(again.status, 0, again.stderr);
      strictEqual(again.vars.OPID, pre.vars.OPID, 'the same id, for the same operation');
      strictEqual(f.finishVerb(child.path, child.opDir).status, 0);
      // The hold, set with no lane, takes the worktree its branch is in at
      // the handoff: the dispatching session's admission holds that lane
      // until Phase 5 releases it.
      strictEqual((await f.handoff()).state, 'pending', "the dispatch's session still holds the lane");
      const wrote = f.run(shell, withTextDir(BLOCKS.WRITEBACK, textDir));
      strictEqual(wrote.status, 0, wrote.stderr);
      strictEqual((await f.handoff()).state, 'held', 'handed over once the verb and its dispatch ended');
      strictEqual(holds.readOwnerHold(f.main, f.macroId, 'T1').record.lane, realpathSync(f.lane));
    });

    it('a dispatch whose check before the engineer refused is not recorded in progress, though a linked child is on the branch', async () => {
      f.activate();
      const first = f.endedChild();
      const textDir = f.carried({ engineerWorkflow: first.path });
      strictEqual(f.run(shell, withTextDir(BLOCKS.JOIN_AND_SWITCH, textDir)).status, 0);
      await f.hold();
      strictEqual(f.run(shell, withTextDir(BLOCKS.PRELUDE, textDir)).status, 1, 'the check refuses the held subtask');
      const wrote = f.run(shell, withTextDir(BLOCKS.WRITEBACK, textDir));
      strictEqual(wrote.status, 1);
      match(wrote.stderr, /did not pass for this dispatch; subtask T1 is not recorded in progress/);
      strictEqual((await f.subtask()).status, 'pending');
    });

    it('holds turned on after Phase 3 passed an engineer that is not hold-aware: the check before the engineer refuses it', () => {
      const textDir = f.carried({ engineerRoot: f.fakeEngineer });
      // Phase 3's check, the holds off: the old engineer passes.
      strictEqual(f.gateCli('--engineer-root', f.fakeEngineer).status, 0, 'off, Phase 3 lets the old engineer pass');
      f.activate();
      strictEqual(f.run(shell, withTextDir(BLOCKS.JOIN_AND_SWITCH, textDir)).status, 0);
      const pre = f.run(shell, withTextDir(BLOCKS.PRELUDE, textDir));
      strictEqual(pre.status, 1);
      match(pre.stderr, /old-engineer is not hold-aware/);
    });

    it('a re-attach publishes no mark, and its engineer resume opens its own operation', () => {
      f.activate();
      const first = f.endedChild();
      const textDir = f.carried({ subtask: f.T1(), engineerWorkflow: first.path });
      const joined = f.run(shell, withTextDir(BLOCKS.JOIN_AND_SWITCH, textDir));
      strictEqual(joined.status, 0, joined.stderr);
      deepStrictEqual(f.mark(textDir), { active: true, operation_id: null, reattach: true });
      deepStrictEqual(f.records(), []);
      const pre = f.run(shell, `${withTextDir(BLOCKS.PRELUDE, textDir)}\necho "OPID=\${AGENTIC_OPERATION_ID-unset}"`, { AGENTIC_OPERATION_ID: 'op-20261026T000000Z-00000000' });
      strictEqual(pre.status, 0, pre.stderr);
      strictEqual(pre.vars.OPID, 'unset', 'no id is exported, and a stale one is dropped');
      const resumed = spawnSync(process.execPath, [
        ENG_STATE, 'append', '--workflow-path', first.path, '--host', 'claude', '--verb', 'compose',
        '--operation-dir', mkdtempSync(join(f.dir, 'op-')), '--open-operation', 'verb', '--phase-label', 'resume', '--phase-note', 'x',
        '--current-phase', 'phase-0-resume', '--next-action', 'x', '--event', 'resumed',
      ], { encoding: 'utf8', env: cleanEnv(), cwd: f.lane });
      strictEqual(resumed.status, 0, resumed.stderr);
      // The prelude again, before the engineer's next block: its operation is the engineer's.
      const again = f.run(shell, withTextDir(BLOCKS.PRELUDE, textDir));
      strictEqual(again.status, 0, again.stderr);
    });

    it('a dispatch whose mark file is gone is not recorded in progress (N9)', async () => {
      const textDir = f.carried();
      strictEqual(f.run(shell, withTextDir(BLOCKS.JOIN_AND_SWITCH, textDir)).status, 0);
      strictEqual(f.run(shell, withTextDir(BLOCKS.PRELUDE, textDir)).status, 0);
      strictEqual(f.bootstrap(null).status, 0);
      rmSync(join(textDir, 'dispatch-mark.json'));
      const wrote = f.run(shell, withTextDir(BLOCKS.WRITEBACK, textDir));
      strictEqual(wrote.status, 1);
      match(wrote.stderr, /dispatch-mark\.json is missing, so no check before the engineer passed/);
      strictEqual((await f.subtask()).status, 'pending');
    });

    it('the Codex mirror: its Phase 1 gate refuses a held subtask; its switch publishes the mark, its prelude exports it, its writeback withdraws one no child carries', async () => {
      f.activate();
      await f.hold();
      let r = f.run(shell, withTextDir(BLOCKS.CODEX_GATE, f.carried()));
      strictEqual(r.status, 1);
      match(r.stderr, /subtask T1 is held/);
      rmSync(holds.recordPath(f.main, f.macroId, 'holds', 'T1'));
      const textDir = f.carried();
      r = f.run(shell, withTextDir(BLOCKS.CODEX_JOIN, textDir));
      strictEqual(r.status, 0, r.stderr);
      r = f.run(shell, withTextDir(BLOCKS.CODEX_SWITCH, textDir));
      strictEqual(r.status, 0, r.stderr);
      const m = f.mark(textDir);
      deepStrictEqual(f.records(), [`${m.operation_id}.json`]);
      r = f.run(shell, `${withTextDir(BLOCKS.CODEX_PRELUDE, textDir)}\necho "OPID=\${AGENTIC_OPERATION_ID:-}"`);
      strictEqual(r.status, 0, r.stderr);
      strictEqual(r.vars.OPID, m.operation_id);
      r = f.run(shell, withTextDir(BLOCKS.CODEX_WRITEBACK, textDir));
      strictEqual(r.status, 1, 'no child: the writeback stops');
      deepStrictEqual(f.records(), [], 'and its exit withdraws the mark');
    });
  });
});
