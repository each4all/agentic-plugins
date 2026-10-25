// ADR-0068 Decision 8, item 4 — a run tells a child the owner's instruction
// change its approval did not finish telling, before the child's next step and
// never mid-step (adapters/claude/autopilot/rebind-boundary.mjs), in a serial
// run and in a run with lanes; and a lane parked before the approval is
// reconsidered (policy.mjs laneFingerprint). The runs use the scripted worker
// (fixtures/autopilot-scripted-worker.mjs) with `recordDispatch`, so each child
// records its dispatch as /orchestrator:next does.

import { describe, it } from 'node:test';
import { deepStrictEqual, notStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { AP, bySubtask, CRITIQUE, setup, stepsOf } from './fixtures/autopilot-lanes-run.mjs';
import { ENG } from './fixtures/autopilot-repo.mjs';
import { macroLockPath, readLockEntries } from '../../plugins/orchestrator/scripts/lib/run-locks.mjs';

const { observe: realObserve } = await import(resolve(AP, 'observe.mjs'));
const P = await import(resolve(AP, 'policy.mjs'));
const RB = await import(resolve(AP, 'rebind-boundary.mjs'));
const { readOpenRun } = await import(resolve(AP, 'ledger.mjs'));
const H = 'claude';

// The active child of a subtask, from the shared state root.
function childOf(t, id) {
  const dir = join(t.work, '.agentic-plugins/state/engineer/workflows');
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.md'))) {
    const text = readFileSync(join(dir, name), 'utf8');
    if (text.includes(`originating_subtask: "${id}"`)) return { path: join(dir, name), text };
  }
  return null;
}

async function reviseAndApprove(t, id, topic, { engineerRoot } = {}) {
  const m = await t.fx.readMacro();
  await t.fx.orch.setPlan({ workflowPath: t.fx.macroPath, host: H, subtasks: m.plan.subtasks.map((s) => (s.id === id ? { ...s, topic } : s)) });
  const { digest } = t.fx.orch.planRebindView({ workflowPath: t.fx.macroPath, repoRoot: t.work });
  return t.fx.orch.approvePlan({ workflowPath: t.fx.macroPath, host: H, env: {}, expectRebind: digest, repoRoot: t.work, engineerRoot });
}

const pendingOf = async (t) => JSON.parse((await t.fx.readMacro()).plan_rebindings).pending;

// A boundary delivery that records, once the run has taken its writer onto
// its locks (`hold`), whether the macro lock names that writer: the run's own
// wiring of `hold`, which keeps a delivery's writer on the run's locks.
function heldDelivery(t, seen) {
  return async (a) => {
    if (typeof a.hold !== 'function') {
      seen.push('no hold');
      return RB.deliverAtBoundary(a);
    }
    const hold = async (w) => {
      const held = await a.hold(w);
      seen.push(readLockEntries(macroLockPath(t.work, t.fx.macroId)).some((e) => e.holder?.worker?.pid === w.pid));
      return held;
    };
    return RB.deliverAtBoundary({ ...a, hold });
  };
}

describe('ADR-0068 Decision 8, item 4 — a serial run tells the child at its boundary', () => {
  it('an unfinished return to the dispatched words is told before the next step, and the step\'s baseline includes it', async () => {
    const t = await setup({ scenario: { recordDispatch: true, A: { next: [CRITIQUE, CRITIQUE, CRITIQUE] } }, subtasks: [{ id: 'A' }] });
    try {
      await t.run({ lanes: 1, maxSteps: 1 });
      deepStrictEqual(t.latest().steps.map((s) => s.kind), ['dispatch']);
      // A to B, told by the approval; back to A, its note left pending.
      await reviseAndApprove(t, 'A', 'B words', { engineerRoot: ENG });
      const r = await reviseAndApprove(t, 'A', 'do A');
      strictEqual(r.rebindings, 0, 'a return to the dispatch rebinds nothing');
      strictEqual((await pendingOf(t)).length, 1, '...but the return is still told');

      const events = [];
      const held = [];
      const deliver = heldDelivery(t, held);
      const deps = {
        deliverRebindings: async (a) => { events.push('deliver'); return deliver(a); },
        observe: (a) => { const v = realObserve(a); events.push(P.fingerprint(v)); return v; },
      };
      await t.run({ lanes: 1, maxSteps: 1 }, deps);
      const run = t.latest();
      deepStrictEqual(run.steps.map((s) => [s.kind, s.subtask_id]), [['verb', 'A']], t.lines.join('\n'));
      ok(t.lines.some((l) => /told subtask A's child the owner's instruction change before its next step/.test(l)));
      deepStrictEqual(await pendingOf(t), []);
      const text = childOf(t, 'A').text;
      const note = text.lastIndexOf('### Owner instruction change (');
      const step = text.lastIndexOf('### Phase 0: Resume into critique');
      ok(note > 0 && step > note, 'the note precedes the step that follows it');
      // The step was decided again from a look taken after the note.
      const after = events.slice(events.indexOf('deliver') + 1);
      strictEqual(run.steps[0].fingerprint_before, after[0]);
      deepStrictEqual(held, [true], 'the delivery\'s writer was not on the run\'s macro lock');
    } finally {
      t.fx.cleanup();
    }
  });

  it('a note that cannot be told halts the run before the step; a stop during the delivery spawns nothing', async () => {
    const t = await setup({ scenario: { recordDispatch: true, A: { next: [CRITIQUE, CRITIQUE] } }, subtasks: [{ id: 'A' }] });
    try {
      await t.run({ lanes: 1, maxSteps: 1 });
      await reviseAndApprove(t, 'A', 'B words');
      await t.run({ lanes: 1, maxSteps: 1 }, { deliverRebindings: async () => ({ ok: false, detail: 'the note could not be told (test)' }) });
      let run = t.latest();
      deepStrictEqual(run.steps, []);
      deepStrictEqual([run.halt.reason, run.halt.detail], ['owner-choice', 'the note could not be told (test)']);
      await t.run({ lanes: 1, maxSteps: 1 }, { deliverRebindings: async (a) => { t.signals.emit('SIGINT'); return RB.deliverAtBoundary(a); } });
      run = t.latest();
      deepStrictEqual(run.steps, []);
      strictEqual(run.halt.reason, 'interrupted');
    } finally {
      t.fx.cleanup();
    }
  });

  it('a delivery whose group outlived SIGKILL halts the run, which keeps its locks', async () => {
    const t = await setup({ scenario: { recordDispatch: true, A: { next: [CRITIQUE] } }, subtasks: [{ id: 'A' }] });
    try {
      await t.run({ lanes: 1, maxSteps: 1 });
      await reviseAndApprove(t, 'A', 'B words');
      await t.run({ lanes: 1, maxSteps: 1 }, {
        deliverRebindings: async (a) => { a.onLingering(); return { ok: false, lingering: true, detail: 'a process outlived SIGKILL (test)' }; },
      });
      const run = t.latest();
      deepStrictEqual(run.steps, []);
      deepStrictEqual([run.halt.reason, run.halt.detail], ['worker-failed', 'a process outlived SIGKILL (test)']);
      ok(readOpenRun(t.work, run.run.run_id), 'a run whose delivery group lingers keeps its open-run record');
      strictEqual(readLockEntries(macroLockPath(t.work, t.fx.macroId)).length, 1, 'the macro lock keeps the run\'s entry');
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('ADR-0068 Decision 8, item 4 — a run with lanes tells the child at its lane\'s boundary', () => {
  it('the idle lane\'s child is told before its step while the other lane runs; a failure parks that lane only', async () => {
    // Run 1 dispatches both lanes: A's dispatch ends only once B's is marked.
    const t = await setup({
      scenario: {
        recordDispatch: true, actions: { 1: 'stop-wait:b-dispatched', 2: 'mark:b-dispatched' },
        A: { next: [CRITIQUE, CRITIQUE, CRITIQUE] }, B: { next: [CRITIQUE, CRITIQUE, CRITIQUE] },
      },
    });
    try {
      await t.run({ maxSteps: 2 });
      deepStrictEqual(stepsOf(t.latest()).map((s) => [s[2], s[3]]).sort(), [['dispatch', 'A'], ['dispatch', 'B']]);
      await reviseAndApprove(t, 'A', 'B words');
      strictEqual((await pendingOf(t)).length, 1);

      // The note is written only once the lane is free of a persona
      // operation: a lane laneBusy holds back is not written to.
      const seen = [];
      let first = true;
      const laneBusy = (id) => {
        if (id !== 'A') return false;
        const busy = first;
        first = false;
        seen.push(['busy', busy]);
        return busy;
      };
      const held = [];
      const deliver = heldDelivery(t, held);
      const deliverRebindings = async (a) => { seen.push(['deliver', a.subtaskId]); return deliver(a); };
      await t.run({ maxSteps: 3 }, { laneBusy, deliverRebindings });
      deepStrictEqual(seen.slice(0, 3), [['busy', true], ['busy', false], ['deliver', 'A']]);
      const run = t.latest();
      ok(stepsOf(run).some((s) => s[2] === 'verb' && s[3] === 'A'), t.lines.join('\n'));
      ok(t.lines.some((l) => /lane A: told its child the owner's instruction change before its next step/.test(l)));
      deepStrictEqual(await pendingOf(t), []);
      const text = childOf(t, 'A').text;
      ok(text.lastIndexOf('### Phase 0: Resume into critique') > text.indexOf('### Owner instruction change ('));
      ok(!childOf(t, 'B').text.includes('Owner instruction change'));
      deepStrictEqual(held, [true], 'the lane\'s delivery writer was not on the run\'s macro lock');

      await reviseAndApprove(t, 'A', 'C words');
      await t.run({ maxSteps: 1 }, { deliverRebindings: async () => ({ ok: false, detail: 'the note could not be told (test)' }) });
      const third = t.latest();
      deepStrictEqual(stepsOf(third).map((s) => [s[2], s[3]]), [['verb', 'B']], t.lines.join('\n'));
      strictEqual(bySubtask(third).A?.state, 'parked');
    } finally {
      t.fx.cleanup();
    }
  });

  it('a lane\'s delivery whose group outlived SIGKILL drains the run instead of parking the lane', async () => {
    const t = await setup({
      scenario: {
        recordDispatch: true, actions: { 1: 'stop-wait:b-dispatched', 2: 'mark:b-dispatched' },
        A: { next: [CRITIQUE, CRITIQUE] }, B: { next: [CRITIQUE, CRITIQUE] },
      },
    });
    try {
      await t.run({ maxSteps: 2 });
      await reviseAndApprove(t, 'A', 'B words');
      await t.run({ maxSteps: 2 }, {
        deliverRebindings: async (a) => { a.onLingering(); return { ok: false, lingering: true, detail: 'a process outlived SIGKILL (test)' }; },
      });
      const run = t.latest();
      strictEqual(run.halt?.reason, 'worker-failed', t.lines.join('\n'));
      ok(readOpenRun(t.work, run.run.run_id), 'a run whose delivery group lingers keeps its open-run record');
      ok(bySubtask(run).A?.state !== 'parked', 'the lane was parked, and the run went on beside a writer it could not end');
    } finally {
      t.fx.cleanup();
    }
  });
});

// A child last told other words with no note pending, then named its owner
// through done's binding line (which accepts no work, so is not vouched): an
// archived earlier attempt; X dispatched under "do A" and told "B words"; the
// owner cleared and A revised back and approved while two files claim it, so
// no note can tell X. With `bindOwner: false` the binding line is left out:
// A records no owner, and the run selects X, the active child on its branch.
// `last` is the words A is revised to last ("do A", X's dispatch, unless
// given), or the fields to revise. Returns X's id and path, and the revise
// helper.
async function toldOtherWords(t, lanes, { bindOwner = true, last = 'do A' } = {}) {
  await t.run({ lanes, maxSteps: 1 });
  const revise = async (topic, clearOwner = false) => {
    const m = await t.fx.readMacro();
    await t.fx.orch.setPlan({
      workflowPath: t.fx.macroPath, host: H,
      subtasks: m.plan.subtasks.map((s) => {
        if (s.id !== 'A') return s;
        const next = { ...s, ...(typeof topic === 'string' ? { topic } : topic) };
        if (clearOwner) delete next.engineer_workflow_id;
        return next;
      }),
    });
  };
  const original = await t.fx.subtask('A');
  await t.fx.commitAndArchive(join(t.work, '.agentic-plugins/state/engineer/workflows', `${original.engineer_workflow_id}.md`), { phase: 'close-complete' });
  await revise('do A', true);
  await approveAsItStands(t);
  const { filePath } = await t.fx.eng.createWorkflow({
    repoRoot: t.work, verb: original.verb, host: H, profile: original.profile, originalRequest: original.topic,
    gitBaseline: { branch: original.branch, head: t.fx.git('rev-parse', 'HEAD'), status_digest: '' },
    currentPhase: 'phase-0-bootstrap', nextAction: 'Run the verb', parentWorkflow: t.fx.macroId, originatingSubtask: 'A',
    dispatchSelection: { subtask: 'A', branch: original.branch, verb: original.verb, profile: original.profile, topic: original.topic },
  });
  const id = (await t.fx.eng.readWorkflow(filePath)).frontmatter.workflow_id;
  await t.fx.orch.updateSubtask({ workflowPath: t.fx.macroPath, host: H, subtaskId: 'A', status: 'in_progress', engineerWorkflowId: id });
  await t.fx.finish(filePath, CRITIQUE);
  await revise('B words');
  await approveAsItStands(t);
  await revise(last, true);
  await approveAsItStands(t);
  const rec = JSON.parse((await t.fx.readMacro()).plan_rebindings);
  deepStrictEqual([rec.pending, rec.told[id]?.topic], [[], 'B words'], 'X answers to "B words", and no note can tell it');
  if (!bindOwner) {
    strictEqual((await t.fx.subtask('A')).engineer_workflow_id, undefined, 'A records no owner');
    return { id, path: filePath, revise };
  }
  const dispatch = t.fx.orch.ownerDispatch({ repoRoot: t.work, macroId: t.fx.macroId, subtaskId: 'A', owner: id }).claim.dispatch;
  await t.fx.orch.updateSubtask({ workflowPath: t.fx.macroPath, host: H, subtaskId: 'A', engineerWorkflowId: id, expectDispatch: dispatch });
  return { id, path: filePath };
}

function approveAsItStands(t) {
  return t.fx.orch.approvePlan({
    workflowPath: t.fx.macroPath, host: H, env: {}, engineerRoot: ENG,
    expectRebind: t.fx.orch.planRebindView({ workflowPath: t.fx.macroPath }).digest,
  });
}

const OTHER_WORDS = /^subtask A's child is not stepped under words its last note contradicts: \S+ was last told other words for subtask A .*approve the plan as it stands \(\/orchestrator:approve\), which tells it the subtask's words/;

describe('ADR-0068 Decision 8, item 4 — the run\'s boundary asks the binding writes\' told check', () => {
  for (const lanes of [1, 2]) {
    it(`a child last told other words is not stepped (${lanes === 1 ? 'serial' : 'lanes'}); approving the plan as it stands tells it, and the next run steps it`, async () => {
      const t = await setup({ scenario: { recordDispatch: true, A: { next: [CRITIQUE, CRITIQUE, CRITIQUE, CRITIQUE] } }, subtasks: [{ id: 'A' }] });
      try {
        const x = await toldOtherWords(t, lanes);
        const before = readFileSync(x.path, 'utf8');
        await t.run({ lanes, maxSteps: 1 });
        let run = t.latest();
        deepStrictEqual(run.steps, [], t.lines.join('\n'));
        strictEqual(run.halt?.reason, 'owner-choice');
        ok(OTHER_WORDS.test(run.halt.detail), run.halt.detail);
        ok(!run.halt.detail.includes('records no owner'), 'a recorded owner is told by the approval, with no owner\'s record first');
        if (lanes > 1) strictEqual(run.halt.subtask_id, 'A');
        strictEqual(readFileSync(x.path, 'utf8'), before, 'nothing was written to the child');

        // The way out the detail names: the approval tells X the words.
        await approveAsItStands(t);
        strictEqual(JSON.parse((await t.fx.readMacro()).plan_rebindings).told[x.id]?.topic, 'do A');
        await t.run({ lanes, maxSteps: 1 });
        run = t.latest();
        deepStrictEqual(run.steps.map((s) => [s.kind, s.subtask_id]), [['verb', 'A']], t.lines.join('\n'));
      } finally {
        t.fx.cleanup();
      }
    });
  }

  // The same sequence without the binding line: A records no owner, and the
  // check is asked of the child the step would run, the one the look selected.
  for (const lanes of [1, 2]) {
    it(`an ownerless subtask's selected child last told other words is not stepped (${lanes === 1 ? 'serial' : 'lanes'}); recording it the owner and approving tells it, and the next run steps it`, async () => {
      const t = await setup({ scenario: { recordDispatch: true, A: { next: [CRITIQUE, CRITIQUE, CRITIQUE, CRITIQUE] } }, subtasks: [{ id: 'A' }] });
      try {
        const x = await toldOtherWords(t, lanes, { bindOwner: false });
        const before = readFileSync(x.path, 'utf8');
        const looks = [];
        await t.run({ lanes, maxSteps: 1 }, { observe: (a) => { const v = realObserve(a); looks.push(v.children?.A?.workflow_id); return v; } });
        let run = t.latest();
        ok(looks.includes(x.id), 'the look selected X for A');
        deepStrictEqual(run.steps, [], t.lines.join('\n'));
        strictEqual(run.halt?.reason, 'owner-choice');
        ok(OTHER_WORDS.test(run.halt.detail) && run.halt.detail.includes(x.id), run.halt.detail);
        // Two workflows claim A, so no approval tells X until it is the owner.
        ok(new RegExp(`; subtask A records no owner and .*${x.id}.* all claim it, so an approval tells ${x.id} nothing until it is recorded the owner: record it first \\(subtask-update --expect-dispatch`).test(run.halt.detail), run.halt.detail);
        if (lanes > 1) strictEqual(run.halt.subtask_id, 'A');
        strictEqual(readFileSync(x.path, 'utf8'), before, 'nothing was written to the child');
        await approveAsItStands(t);
        strictEqual(JSON.parse((await t.fx.readMacro()).plan_rebindings).told[x.id]?.topic, 'B words', 'an approval alone tells X nothing');
        // The binding writes give the same answer: X's own terminal writeback.
        const dispatch0 = t.fx.orch.ownerDispatch({ repoRoot: t.work, macroId: t.fx.macroId, subtaskId: 'A', owner: x.id }).claim.dispatch;
        await rejects(
          t.fx.orch.recordEngineerTerminal({ workflowPath: t.fx.macroPath, host: H, subtaskId: 'A', engineerWorkflowId: x.id, branchCommit: 'abc1234', expectDispatch: dispatch0 }),
          (err) => err.message.includes(run.halt.detail.slice(run.halt.detail.indexOf(`${x.id} was last told`), run.halt.detail.lastIndexOf(' (the binding writes'))),
        );

        // The way out the detail names: X recorded the owner, then approved.
        const dispatch = t.fx.orch.ownerDispatch({ repoRoot: t.work, macroId: t.fx.macroId, subtaskId: 'A', owner: x.id }).claim.dispatch;
        await t.fx.orch.updateSubtask({ workflowPath: t.fx.macroPath, host: H, subtaskId: 'A', engineerWorkflowId: x.id, expectDispatch: dispatch });
        await approveAsItStands(t);
        strictEqual(JSON.parse((await t.fx.readMacro()).plan_rebindings).told[x.id]?.topic, 'do A');
        await t.run({ lanes, maxSteps: 1 });
        run = t.latest();
        deepStrictEqual(run.steps.map((s) => [s.kind, s.subtask_id]), [['verb', 'A']], t.lines.join('\n'));
      } finally {
        t.fx.cleanup();
      }
    });
  }

  // The same ownerless X, A revised last to third words, "C words": recording X
  // the owner compares its dispatch ("do A") and is refused, so the way out
  // restores the dispatch's words around that record.
  it('an ownerless subtask revised to words its selected child was never dispatched for names the way out that restores them around the owner\'s record', async () => {
    const t = await setup({ scenario: { recordDispatch: true, A: { next: [CRITIQUE, CRITIQUE, CRITIQUE, CRITIQUE] } }, subtasks: [{ id: 'A' }] });
    try {
      const x = await toldOtherWords(t, 1, { bindOwner: false, last: 'C words' });
      await t.run({ lanes: 1, maxSteps: 1 });
      let run = t.latest();
      deepStrictEqual(run.steps, [], t.lines.join('\n'));
      strictEqual(run.halt?.reason, 'owner-choice');
      ok(OTHER_WORDS.test(run.halt.detail) && run.halt.detail.includes(x.id), run.halt.detail);
      ok(run.halt.detail.includes(
        `so an approval tells ${x.id} nothing until it is recorded the owner: its record is refused while the subtask's topic differs from ` +
          `${x.id}'s dispatch, so revise the plan back to what ${x.id} was dispatched for, record it the owner (subtask-update --expect-dispatch`,
      ), run.halt.detail);
      ok(!run.halt.detail.includes('record it first'), run.halt.detail);

      // The advice the dispatch's words would not need is refused here.
      const dispatch = t.fx.orch.ownerDispatch({ repoRoot: t.work, macroId: t.fx.macroId, subtaskId: 'A', owner: x.id }).claim.dispatch;
      const record = () => t.fx.orch.updateSubtask({ workflowPath: t.fx.macroPath, host: H, subtaskId: 'A', engineerWorkflowId: x.id, expectDispatch: dispatch });
      await rejects(record, /dispatch-changed/);

      // The way out the detail names: back to "do A", record X, "C words" again, approve.
      await x.revise('do A');
      await record();
      await x.revise('C words');
      await approveAsItStands(t);
      strictEqual(JSON.parse((await t.fx.readMacro()).plan_rebindings).told[x.id]?.topic, 'C words');
      await t.run({ lanes: 1, maxSteps: 1 });
      run = t.latest();
      deepStrictEqual(run.steps.map((s) => [s.kind, s.subtask_id]), [['verb', 'A']], t.lines.join('\n'));
    } finally {
      t.fx.cleanup();
    }
  });

  // The same, A's verb changed too: no approval rebinds a changed verb, so the
  // way out keeps the dispatched verb after the record (or redispatches).
  it('an ownerless subtask whose verb changed too names a way out that keeps the dispatched verb', async () => {
    const t = await setup({ scenario: { recordDispatch: true, A: { next: [CRITIQUE, CRITIQUE, CRITIQUE, CRITIQUE] } }, subtasks: [{ id: 'A' }] });
    try {
      const verb = (await t.fx.subtask('A')).verb;
      const other = verb === 'refine' ? 'compose' : 'refine';
      const x = await toldOtherWords(t, 1, { bindOwner: false, last: { topic: 'C words', verb: other } });
      await t.run({ lanes: 1, maxSteps: 1 });
      let run = t.latest();
      deepStrictEqual(run.steps, [], t.lines.join('\n'));
      strictEqual(run.halt?.reason, 'owner-choice');
      ok(run.halt.detail.includes(
        `its record is refused while the subtask's verb and topic differ from ${x.id}'s dispatch, and no approval rebinds a changed verb: ` +
          `revise the plan back to what ${x.id} was dispatched for, record it the owner (subtask-update --expect-dispatch`,
      ), run.halt.detail);
      ok(run.halt.detail.includes(`then approve with its verb as dispatched; or archive ${x.id} and dispatch the subtask again`), run.halt.detail);
      ok(!run.halt.detail.includes('revise the plan again'), run.halt.detail);

      // The way out the detail names: back to the dispatch, record X, then
      // new words under the dispatched verb, approved.
      const dispatch = t.fx.orch.ownerDispatch({ repoRoot: t.work, macroId: t.fx.macroId, subtaskId: 'A', owner: x.id }).claim.dispatch;
      await x.revise({ topic: 'do A', verb });
      await t.fx.orch.updateSubtask({ workflowPath: t.fx.macroPath, host: H, subtaskId: 'A', engineerWorkflowId: x.id, expectDispatch: dispatch });
      await x.revise('C words');
      await approveAsItStands(t);
      strictEqual(JSON.parse((await t.fx.readMacro()).plan_rebindings).told[x.id]?.topic, 'C words');
      await t.run({ lanes: 1, maxSteps: 1 });
      run = t.latest();
      deepStrictEqual(run.steps.map((s) => [s.kind, s.subtask_id]), [['verb', 'A']], t.lines.join('\n'));
    } finally {
      t.fx.cleanup();
    }
  });

  // The same ownerless X, its record edited by hand (no approval reaches it
  // while two workflows claim A) to say it was told A's words.
  async function toldTheseWords(t, lanes) {
    const x = await toldOtherWords(t, lanes, { bindOwner: false });
    const editRecord = (edit) => {
      const parsed = t.fx.orch.parseWorkflowFile(readFileSync(t.fx.macroPath, 'utf8'));
      const r = JSON.parse(parsed.frontmatter.plan_rebindings);
      edit(r);
      parsed.frontmatter.plan_rebindings = JSON.stringify(r);
      writeFileSync(t.fx.macroPath, t.fx.orch.assembleWorkflowFile(parsed.frontmatter, parsed.body));
    };
    editRecord((r) => { r.told[x.id] = { ...r.told[x.id], topic: 'do A' }; });
    return { ...x, editRecord };
  }

  for (const lanes of [1, 2]) {
    it(`an ownerless subtask's selected child the check accepts is stepped (${lanes === 1 ? 'serial' : 'lanes'})`, async () => {
      const t = await setup({ scenario: { recordDispatch: true, A: { next: [CRITIQUE, CRITIQUE, CRITIQUE, CRITIQUE] } }, subtasks: [{ id: 'A' }] });
      try {
        await toldTheseWords(t, lanes);
        strictEqual((await t.fx.subtask('A')).engineer_workflow_id, undefined);
        await t.run({ lanes, maxSteps: 1 });
        deepStrictEqual(t.latest().steps.map((s) => [s.kind, s.subtask_id]), [['verb', 'A']], t.lines.join('\n'));
      } finally {
        t.fx.cleanup();
      }
    });
  }

  // The serial run's second ask, after a delivery: the note told, the child it
  // selected is asked again. The delivery here tells X other words than A's.
  it('a serial run asks the selected child again after a delivery, and halts when the check now refuses it', async () => {
    const t = await setup({ scenario: { recordDispatch: true, A: { next: [CRITIQUE, CRITIQUE, CRITIQUE, CRITIQUE] } }, subtasks: [{ id: 'A' }] });
    try {
      const x = await toldTheseWords(t, 1);
      const { editRecord } = x;
      const told = JSON.parse((await t.fx.readMacro()).plan_rebindings).told[x.id];
      const words = { profile: told.profile, topic: told.topic };
      editRecord((r) => { r.pending = [{ delivery_id: `d-${'3'.repeat(16)}`, child: x.id, subtask: 'A', from: words, to: words }]; });
      let calls = 0;
      const deliverRebindings = async (a) => {
        calls += 1;
        strictEqual(a.due, 'pending');
        editRecord((r) => { r.pending = []; r.told[x.id] = { ...r.told[x.id], topic: 'C words' }; });
        return { ok: true, results: [] };
      };
      await t.run({ lanes: 1, maxSteps: 1 }, { deliverRebindings });
      const run = t.latest();
      strictEqual(calls, 1);
      deepStrictEqual(run.steps, [], t.lines.join('\n'));
      strictEqual(run.halt?.reason, 'owner-choice');
      ok(/^subtask A's note was told, but its child is still refused: \S+ was last told other words for subtask A /.test(run.halt.detail), run.halt.detail);
    } finally {
      t.fx.cleanup();
    }
  });

  // A child whose dispatch recorded no topic (a release before the dispatch
  // record): revising the plan back to the words it was told needs no
  // rebinding and no note, so the record changes nothing; the lane parked on
  // the check is reconsidered by the subtask's words in its fingerprint.
  it('a lane parked on the told check is picked up again when the plan is revised back to the words its child was told', async () => {
    const t = await setup({ scenario: { recordDispatch: true, A: { next: [CRITIQUE, CRITIQUE, CRITIQUE, CRITIQUE] } }, subtasks: [{ id: 'A' }] });
    try {
      await t.run({ lanes: 2, maxSteps: 1 });
      const revise = async (topic, clearOwner = false) => {
        const m = await t.fx.readMacro();
        await t.fx.orch.setPlan({
          workflowPath: t.fx.macroPath, host: H,
          subtasks: m.plan.subtasks.map((s) => {
            if (s.id !== 'A') return s;
            const next = { ...s, topic };
            if (clearOwner) delete next.engineer_workflow_id;
            return next;
          }),
        });
      };
      const original = await t.fx.subtask('A');
      await t.fx.commitAndArchive(join(t.work, '.agentic-plugins/state/engineer/workflows', `${original.engineer_workflow_id}.md`), { phase: 'close-complete' });
      await revise('do A', true);
      await approveAsItStands(t);
      const { filePath } = await t.fx.eng.createWorkflow({
        repoRoot: t.work, verb: original.verb, host: H, profile: original.profile, originalRequest: original.topic,
        gitBaseline: { branch: original.branch, head: t.fx.git('rev-parse', 'HEAD'), status_digest: '' },
        currentPhase: 'phase-0-bootstrap', nextAction: 'Run the verb', parentWorkflow: t.fx.macroId, originatingSubtask: 'A',
      });
      const id = (await t.fx.eng.readWorkflow(filePath)).frontmatter.workflow_id;
      await t.fx.orch.updateSubtask({ workflowPath: t.fx.macroPath, host: H, subtaskId: 'A', status: 'in_progress', engineerWorkflowId: id });
      await t.fx.finish(filePath, CRITIQUE);
      // "B words" restated to X in full by the approval that replaces an
      // unreadable record; then A revised back while two files claim it.
      await revise('B words');
      const broken = t.fx.orch.parseWorkflowFile(readFileSync(t.fx.macroPath, 'utf8'));
      broken.frontmatter.plan_rebindings = '{unreadable';
      writeFileSync(t.fx.macroPath, t.fx.orch.assembleWorkflowFile(broken.frontmatter, broken.body));
      await approveAsItStands(t);
      await revise('do A', true);
      await approveAsItStands(t);
      strictEqual(JSON.parse((await t.fx.readMacro()).plan_rebindings).told[id]?.topic, 'B words');
      const dispatch = t.fx.orch.ownerDispatch({ repoRoot: t.work, macroId: t.fx.macroId, subtaskId: 'A', owner: id }).claim.dispatch;
      await t.fx.orch.updateSubtask({ workflowPath: t.fx.macroPath, host: H, subtaskId: 'A', engineerWorkflowId: id, expectDispatch: dispatch });
      await t.run({ lanes: 2, maxSteps: 1 });
      strictEqual(bySubtask(t.latest()).A?.state, 'parked', t.lines.join('\n'));

      // The way out that needs no note: the words X was told.
      const unstamped = async () => { const r = JSON.parse((await t.fx.readMacro()).plan_rebindings); delete r.approval; return r; };
      const recordBefore = await unstamped();
      await revise('B words');
      await approveAsItStands(t);
      deepStrictEqual(await unstamped(), recordBefore, 'the record changes nothing but its approval stamp, which the lane facts leave out');
      strictEqual(RB.rebindDue(await t.fx.readMacro(), 'A', { macroPath: t.fx.macroPath }), null);
      await t.run({ lanes: 2, maxSteps: 1 });
      deepStrictEqual(t.latest().steps.map((s) => [s.kind, s.subtask_id]), [['verb', 'A']], t.lines.join('\n'));
    } finally {
      t.fx.cleanup();
    }
  });

  // A delivery that reports its notes told while the macro still holds one:
  // the step is held, never told again in a loop. The delivery fails on its
  // third call, so a run without the guard ends there, not at a timeout.
  for (const lanes of [1, 2]) {
    it(`a note reported told that the macro still holds stops the step (${lanes === 1 ? 'serial' : 'lanes'}), not a second delivery`, async () => {
      const t = await setup({ scenario: { recordDispatch: true, A: { next: [CRITIQUE, CRITIQUE] } }, subtasks: [{ id: 'A' }] });
      try {
        await t.run({ lanes, maxSteps: 1 });
        await reviseAndApprove(t, 'A', 'B words');
        strictEqual((await pendingOf(t)).length, 1);
        let calls = 0;
        const deliverRebindings = async () => (++calls > 2 ? { ok: false, detail: 'delivered again (test)' } : { ok: true, results: [] });
        await t.run({ lanes, maxSteps: 1 }, { deliverRebindings });
        const run = t.latest();
        deepStrictEqual(run.steps, [], t.lines.join('\n'));
        strictEqual(calls, 1, 'the note was delivered again');
        strictEqual(run.halt?.reason, 'owner-choice');
        ok(/^subtask A's note was told, but the macro still holds it pending; run state\.mjs rebind-deliver for it, then relaunch$/.test(run.halt.detail), run.halt.detail);
        if (lanes > 1) strictEqual(bySubtask(run).A?.state, 'parked');
      } finally {
        t.fx.cleanup();
      }
    });
  }

  // A hold that changes kind while the note is told (here the record becomes
  // unreadable): the step is held with that hold's own way out, not "run
  // rebind-deliver", which tells nothing more.
  for (const lanes of [1, 2]) {
    it(`a hold that changed kind during the delivery names its own way out (${lanes === 1 ? 'serial' : 'lanes'})`, async () => {
      const t = await setup({ scenario: { recordDispatch: true, A: { next: [CRITIQUE, CRITIQUE] } }, subtasks: [{ id: 'A' }] });
      try {
        await t.run({ lanes, maxSteps: 1 });
        await reviseAndApprove(t, 'A', 'B words');
        strictEqual((await pendingOf(t)).length, 1);
        let calls = 0;
        const deliverRebindings = async () => {
          if (++calls > 1) return { ok: false, detail: 'delivered again (test)' };
          const parsed = t.fx.orch.parseWorkflowFile(readFileSync(t.fx.macroPath, 'utf8'));
          parsed.frontmatter.plan_rebindings = '{unreadable';
          writeFileSync(t.fx.macroPath, t.fx.orch.assembleWorkflowFile(parsed.frontmatter, parsed.body));
          return { ok: true, results: [] };
        };
        await t.run({ lanes, maxSteps: 1 }, { deliverRebindings });
        const run = t.latest();
        deepStrictEqual(run.steps, [], t.lines.join('\n'));
        strictEqual(calls, 1);
        strictEqual(run.halt?.reason, 'owner-choice');
        ok(/^subtask A's note was told, but the macro's record of rebindings \(plan_rebindings\) cannot be read, so subtask A's child cannot be told what the owner approved; approve the plan again \(\/orchestrator:approve --workflow=/.test(run.halt.detail), run.halt.detail);
      } finally {
        t.fx.cleanup();
      }
    });
  }

  it('rebindDue: a child last told other words is refused with the check\'s why; one told these words, or with no record, is not held', async () => {
    const told = (topic) => JSON.stringify({
      v: 1, approval: { id: 'a'.repeat(32), at: '2026-10-20T00:00:00Z', hash: 'b'.repeat(64) }, rebindings: [], carried: [], pending: [],
      told: { c: { subtask: 'A', delivery_id: `d-${'2'.repeat(16)}`, at: '2026-10-20T00:00:00Z', profile: '', topic } },
    });
    const fm = (raw, extra = {}) => ({
      plan: { subtasks: [{ id: 'A', status: 'in_progress', engineer_workflow_id: 'c', profile: '', topic: 'do A', ...extra }] },
      plan_rebindings: raw,
    });
    const at = { macroPath: '/nowhere/m.md' };
    strictEqual(RB.rebindDue(fm(told('do A')), 'A', at), null, 'told the subtask\'s words');
    // With no record the check is asked too (more than one file bearing the
    // child refuses it whatever the record holds): it needs the path alike.
    strictEqual(RB.rebindDue(fm(undefined), 'A', at), null, 'no record');
    const r = RB.rebindDue(fm(told('B words')), 'A', at);
    strictEqual(r?.due, 'refused');
    ok(/^c was last told other words for subtask A \(delivery d-2{16}\) than the subtask's now; approve the plan as it stands/.test(r.why), r.why);
    // The check needs the macro's path, where the writes read the child's
    // start: a caller that leaves it out is refused, never answered.
    throws(() => RB.rebindDue(fm(told('do A')), 'A'), /the macro's path is required/);
    // Asked of a subtask in progress, of its recorded owner, or, with none,
    // of the child the look selected; with neither, nothing is asked.
    strictEqual(RB.rebindDue(fm(told('B words'), { engineer_workflow_id: undefined }), 'A'), null);
    strictEqual(RB.rebindDue(fm(told('B words'), { status: 'pending' }), 'A', { ...at, selected: 'c' }), null);
    strictEqual(RB.rebindDue(fm(told('B words'), { engineer_workflow_id: undefined }), 'A', { ...at, selected: 'c' })?.due, 'refused');
    strictEqual(RB.rebindDue(fm(told('do A'), { engineer_workflow_id: undefined }), 'A', { ...at, selected: 'c' }), null);
    // A recorded owner takes precedence over the selected child, either way.
    const two = (c, z) => JSON.stringify({
      ...JSON.parse(told(c)),
      told: { c: JSON.parse(told(c)).told.c, z: { ...JSON.parse(told(z)).told.c, delivery_id: `d-${'4'.repeat(16)}` } },
    });
    strictEqual(RB.rebindDue(fm(two('do A', 'B words')), 'A', { ...at, selected: 'z' }), null, 'the owner c is asked, not z');
    strictEqual(RB.rebindDue(fm(two('B words', 'do A')), 'A', { ...at, selected: 'z' })?.due, 'refused', 'the owner c is asked, not z');
    // A refused step tells nothing: its detail is the check's why, and no
    // writer is spawned (roots are not even given).
    const held = await RB.deliverAtBoundary({ macroPath: '/x/m.md', subtaskId: 'A', due: 'refused', why: r.why });
    strictEqual(held.ok, false);
    ok(held.detail.includes(r.why) && OTHER_WORDS.test(held.detail), held.detail);
  });
});

describe('ADR-0068 Decision 8 — a lane parked before the approval is reconsidered', () => {
  it('the lane fingerprint takes the record\'s facts only for the subtask it names', () => {
    const view = (fm) => ({ git: { branch: 'feat/a', head: 'h', porcelain: '' }, children: {}, macro: { fm } });
    const plan = { subtasks: [{ id: 'A', status: 'in_progress' }, { id: 'B', status: 'in_progress' }] };
    const record = (subtask) => JSON.stringify({
      v: 1, approval: { id: 'a'.repeat(32), at: '2026-10-20T00:00:00Z', hash: 'b'.repeat(64) },
      rebindings: [{ subtask, child: 'compose-x', child_state: 'active', from_digest: 'c'.repeat(64), to_digest: 'd'.repeat(64), fields: ['topic'] }],
      carried: [], told: {}, pending: [],
    });
    const before = view({ plan });
    const after = view({ plan, plan_rebindings: record('A') });
    const keptA = { fingerprint_version: P.PARK_FINGERPRINT_VERSION, form: 'lane', fingerprint: P.parkFingerprint(before, 'A', { form: 'lane' }) };
    const keptB = { fingerprint_version: P.PARK_FINGERPRINT_VERSION, form: 'lane', fingerprint: P.parkFingerprint(before, 'B', { form: 'lane' }) };
    strictEqual(P.compareKept(keptA, { form: 'lane', fingerprint: P.parkFingerprint(after, 'A', { form: 'lane' }) }), 'changed');
    strictEqual(P.compareKept(keptB, { form: 'lane', fingerprint: P.parkFingerprint(after, 'B', { form: 'lane' }) }), 'unchanged');
    strictEqual(P.laneFingerprint(view({ plan, plan_rebindings: '{unreadable' }), 'A'), P.laneFingerprint(before, 'A'));
    // The subtask's words, which the told check compares, count in a park's
    // fingerprint where the record names the subtask, and only there; a step's
    // progress (laneFingerprint) leaves them out, as a plan revision is none.
    const revised = { subtasks: [{ id: 'A', status: 'in_progress', topic: 'B words' }, { id: 'B', status: 'in_progress', topic: 'B words' }] };
    const park = (v, id) => P.parkFingerprint(v, id, { form: 'lane' });
    strictEqual(P.compareKept(keptA, { form: 'lane', fingerprint: park(view({ plan: revised, plan_rebindings: record('A') }), 'A') }), 'changed');
    strictEqual(park(view({ plan: revised, plan_rebindings: record('A') }), 'B'), park(view({ plan, plan_rebindings: record('A') }), 'B'));
    notStrictEqual(park(view({ plan: revised, plan_rebindings: record('A') }), 'A'), park(after, 'A'));
    strictEqual(P.laneFingerprint(view({ plan: revised, plan_rebindings: record('A') }), 'A'), P.laneFingerprint(after, 'A'));
    strictEqual(P.laneFingerprint(view({ plan, plan_rebindings: record('B') }), 'A', { words: true }), P.laneFingerprint(before, 'A'), 'the record names A nowhere, yet words were hashed');
    // A park kept by the release before, which did not read the record, is not compared.
    strictEqual(P.compareKept({ ...keptA, fingerprint_version: 2 }, { form: 'lane', fingerprint: P.parkFingerprint(before, 'A', { form: 'lane' }) }), 'incomparable');
    // An approval of another subtask restamps the record and leaves A's lane as it was.
    const restamped = JSON.parse(record('A'));
    restamped.approval = { id: 'e'.repeat(32), at: '2026-10-21T00:00:00Z', hash: 'f'.repeat(64) };
    strictEqual(P.laneFingerprint(view({ plan, plan_rebindings: JSON.stringify(restamped) }), 'A'), P.laneFingerprint(after, 'A'));
    // A subtask named unknown, then no longer: its lane is reconsidered.
    const unknownA = JSON.stringify({ ...JSON.parse(record('B')), unknown: ['A'] });
    strictEqual(P.compareKept(
      { fingerprint_version: P.PARK_FINGERPRINT_VERSION, form: 'lane', fingerprint: P.parkFingerprint(view({ plan, plan_rebindings: unknownA }), 'A', { form: 'lane' }) },
      { form: 'lane', fingerprint: P.parkFingerprint(view({ plan, plan_rebindings: record('B') }), 'A', { form: 'lane' }) },
    ), 'changed');
  });

  it('rebindDue: pending for the subtask named, unreadable only for one in progress', () => {
    const fm = (raw, status = 'in_progress') => ({ plan: { subtasks: [{ id: 'A', status }] }, plan_rebindings: raw });
    strictEqual(RB.rebindDue(fm(undefined), 'A'), null);
    deepStrictEqual(RB.rebindDue(fm('{x'), 'A'), { due: 'unreadable' });
    strictEqual(RB.rebindDue(fm('{x', 'completed'), 'A'), null);
    const rec = (subtask) => JSON.stringify({
      v: 1, approval: { id: 'a'.repeat(32), at: 't', hash: 'b'.repeat(64) }, rebindings: [], carried: [], told: {},
      pending: [{ delivery_id: `d-${'1'.repeat(16)}`, child: 'c', subtask, from: { profile: '', topic: 'x' }, to: { profile: '', topic: 'y' } }],
    });
    deepStrictEqual(RB.rebindDue(fm(rec('A')), 'A'), { due: 'pending' });
    strictEqual(RB.rebindDue(fm(rec('B')), 'A'), null);
    // Named unknown with no note pending: held until an approval restates it.
    const unknown = (status) => fm(JSON.stringify({ ...JSON.parse(rec('B')), unknown: ['A'] }), status);
    deepStrictEqual(RB.rebindDue(unknown(), 'A'), { due: 'unknown' });
    strictEqual(RB.rebindDue(unknown('completed'), 'A'), null);
  });
});
