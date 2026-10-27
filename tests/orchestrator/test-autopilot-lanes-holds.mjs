// tests/orchestrator/test-autopilot-lanes-holds.mjs
//
// ADR-0068 Decision 2, items 4 and 11 (impl-hold, Task 10) — a relaunch with
// a held lane, and a run's end: reconciliation passes the owner's lane by (no
// row acts on it: no adoption, no lock, no park, no halt), the run whose lanes
// left are all held ends with each lane's release in its report and in
// halt.json (lane state `held`); a lane whose release could not be compared at
// the start is passed by, then reconciled and stepped once its comparison
// consumes it; a hold set as the run ends, while its lock entries were still
// there, is handed over once they are gone.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import cp from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { COMMIT, LN, setup, stepsOf } from './fixtures/autopilot-lanes-run.mjs';
import {
  BASIS, basisSeam, bounded, H, held, laneEvents, OL, OPS, P, pause, release, releaseOf, RL,
} from './fixtures/autopilot-holds-run.mjs';

// Run 1: A's step runs, the hold is set during it, the run hands the lane
// over (fenced); B, when the macro has it, commits. A's lane is a real
// worktree, its child in progress.
async function heldLane(subtasks = [{ id: 'A' }, { id: 'B' }]) {
  const t = await setup({
    subtasks,
    scenario: { A: { next: [COMMIT], file: 'a.txt' }, B: { next: [COMMIT], file: 'b.txt' }, actions: { 1: ['mark-start:a-started', 'wait:hold-set'] } },
  });
  const running = t.run();
  for (let i = 0; i < 600 && !existsSync(join(t.dir, 'a-started')); i += 1) await pause(50);
  ok(existsSync(join(t.dir, 'a-started')), 'A started');
  const h = await OPS.setHold({ mainRoot: t.work, macroId: t.fx.macroId, subtaskId: 'A', branch: 'feat/a', lane: t.lane('A'), child: null });
  writeFileSync(join(t.dir, 'hold-set'), '1');
  strictEqual(await running, 2, t.lines.join('\n'));
  strictEqual(H.holdStateOf(t.work, t.fx.macroId, 'A').state, 'held');
  strictEqual(RL.fenceState(t.lane('A'), h.hold_id), 'present');
  t.lines.length = 0;
  return { t, h };
}
const eventsOf = (t, r, id) => laneEvents(t, r).filter((e) => e.subtask_id === id).map((e) => e.event);

describe('a relaunch with a held lane, and the run\'s end (ADR-0068 Decision 2, items 4 and 11)', () => {
  it('a relaunch passes a held lane by: no row acts on it, and the run ends with its release in the report and in halt.json', async () => {
    const { t, h } = await heldLane([{ id: 'A' }]);
    try {
      const M = t.fx.macroId;
      strictEqual(await bounded(t), 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(stepsOf(r).filter((s) => s[3] === 'A'), [], 'A never stepped');
      // `held`: the run's announcement of the hold it found acked.
      deepStrictEqual(eventsOf(t, r, 'A').filter((e) => e !== 'held'), ['passed-by'], 'no row acted on A');
      strictEqual(P.readPark(t.work, M, 'A').state, 'absent', 'a held lane is no park');
      strictEqual(RL.fenceState(t.lane('A'), h.hold_id), 'present', 'the fence stands');
      deepStrictEqual((await RL.laneLockRivals(t.lane('A'), { holdId: h.hold_id })).map((e) => e.file), [], 'the run took no lock in the held lane');
      const cmd = `agentic-autopilot release A --macro ${M} --hold ${h.hold_id}`;
      const entry = r.halt.lanes.find((l) => l.subtask_id === 'A');
      strictEqual(entry?.state, 'held', JSON.stringify(r.halt.lanes));
      strictEqual(entry.held.release, cmd);
      // The only lane left is held: the run ends on it, naming its release.
      strictEqual(r.halt.subtask_id, 'A', JSON.stringify(r.halt));
      ok(/every lane left waits on the owner: subtask A is held/.test(r.halt.detail), r.halt.detail);
      ok(r.halt.detail.includes(cmd), r.halt.detail);
      ok(t.lines.some((l) => l.trim() === `give it back: ${cmd}`), t.lines.join('\n'));
      ok(t.lines.some((l) => /passed by the lane .* of subtask A: subtask A is held/.test(l)), t.lines.join('\n'));
    } finally {
      t.fx.cleanup();
    }
  });

  it('a held lane with no identity gets none from the relaunch\'s pre-pass', async () => {
    const { t } = await heldLane([{ id: 'A' }]);
    try {
      const idFile = LN.laneIdentityPath(t.lane('A'));
      ok(existsSync(idFile), idFile);
      rmSync(idFile);
      strictEqual(await bounded(t), 2, t.lines.join('\n'));
      ok(!existsSync(idFile), 'no lane id written in a held lane');
      deepStrictEqual(eventsOf(t, t.latest(), 'A').filter((e) => e !== 'held'), ['passed-by']);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a held lane whose worktree is gone, git still registering it, is no halt', async () => {
    const { t, h } = await heldLane([{ id: 'A' }]);
    try {
      rmSync(t.lane('A'), { recursive: true, force: true });
      strictEqual(await bounded(t), 2, t.lines.join('\n'));
      const r = t.latest();
      ok(/every lane left waits on the owner: subtask A is held/.test(r.halt.detail), JSON.stringify(r.halt));
      ok(!JSON.stringify(r.halt).includes('is gone, but git still registers it'), JSON.stringify(r.halt));
      strictEqual(P.readPark(t.work, t.fx.macroId, 'A').state, 'absent');
      strictEqual(H.holdStateOf(t.work, t.fx.macroId, 'A').state, 'held', h.hold_id);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a held lane beside one waiting to land is listed in the halt\'s also, with its release', async () => {
    const { t, h } = await heldLane();
    try {
      strictEqual(await bounded(t), 2, t.lines.join('\n'));
      const r = t.latest();
      strictEqual(r.halt.reason, 'awaiting-landing', JSON.stringify(r.halt));
      const cmd = `agentic-autopilot release A --macro ${t.fx.macroId} --hold ${h.hold_id}`;
      deepStrictEqual((r.halt.also ?? []).filter((x) => x.held).map((x) => [x.subtask_id, x.release]), [['A', cmd]], JSON.stringify(r.halt.also));
      strictEqual(r.halt.lanes.find((l) => l.subtask_id === 'A')?.state, 'held');
    } finally {
      t.fx.cleanup();
    }
  });

  it('a lane whose release could not be compared at the start is passed by, then reconciled and stepped once its comparison consumes it', async () => {
    const { t, h } = await heldLane();
    try {
      await release(t, h, async () => BASIS);
      strictEqual(releaseOf(t).state, 'uncompared');
      // The first comparison, at the run's start, cannot take its basis; the
      // tick's retry can.
      let n = 0;
      const seam = basisSeam(() => { n += 1; if (n === 1) throw new Error('the basis failed'); return BASIS; });
      strictEqual(await bounded(t, {}, { releaseBasis: seam.fn }), 2, t.lines.join('\n'));
      ok(seam.calls.length >= 2, `compared again: ${seam.calls.length}`);
      strictEqual(releaseOf(t).state, 'consumed', t.lines.join('\n'));
      const r = t.latest();
      const ev = eventsOf(t, r, 'A');
      strictEqual(ev[0], 'passed-by', JSON.stringify(ev));
      ok(ev.indexOf('resumed') > 0 && ev.slice(ev.indexOf('resumed')).some((e) => e === 'adopted' || e === 'reconciled'), `reconciled after it was given back: ${JSON.stringify(ev)}`);
      ok(stepsOf(r).some((s) => s[3] === 'A' && s[2] === 'commit'), `A stepped: ${JSON.stringify(stepsOf(r))}\n${t.lines.join('\n')}`);
      ok(!(r.halt?.lanes ?? []).some((l) => l.state === 'held'), 'nothing held at the end');
      strictEqual(RL.fenceState(t.lane('A'), h.hold_id), 'absent');
    } finally {
      t.fx.cleanup();
    }
  });

  it('a lane the relaunch passed by whose hold ended without a release is reconciled and stepped', async () => {
    const { t, h } = await heldLane();
    try {
      const M = t.fx.macroId;
      // The hold ends (as a retirement ends it: its records and its fence go)
      // once reconciliation has passed the lane by.
      let ended = false;
      const push = t.lines.push.bind(t.lines);
      t.lines.push = (line) => {
        if (!ended && /passed by the lane .* of subtask A/.test(line)) {
          ended = true;
          rmSync(H.recordPath(t.work, M, 'holds', 'A'));
          rmSync(H.recordPath(t.work, M, 'handoffs', 'A'), { force: true });
          RL.removeFence(t.lane('A'), h.hold_id);
        }
        return push(line);
      };
      strictEqual(await bounded(t), 2, t.lines.join('\n'));
      ok(ended, t.lines.join('\n'));
      const r = t.latest();
      const ev = eventsOf(t, r, 'A');
      ok(ev.indexOf('resumed') > ev.indexOf('passed-by') && ev.slice(ev.indexOf('resumed')).some((e) => e === 'adopted' || e === 'reconciled'), `reconciled once its hold ended: ${JSON.stringify(ev)}`);
      ok(stepsOf(r).some((s) => s[3] === 'A' && s[2] === 'commit'), `A stepped: ${JSON.stringify(stepsOf(r))}\n${t.lines.join('\n')}`);
    } finally {
      t.fx.cleanup();
    }
  });

  // A hold of `id` on its real lane, written as the owner's command writes
  // it, in one synchronous write: the run is still live, its entries there.
  const holdNow = (t, id) => {
    const holdId = P.newRecordId();
    H.writeWhole(H.recordPath(t.work, t.fx.macroId, 'holds', id), {
      schema: 'agentic-hold-1', hold_id: holdId, subtask_id: id, branch: `feat/${id.toLowerCase()}`, lane: t.lane(id), child: null,
      state: 'held', set_by: 'owner', set_at: new Date().toISOString(),
    });
    return holdId;
  };
  // Handed over, fenced, with no live run and no entry of the run left.
  async function handedOver(t, id, holdId) {
    const M = t.fx.macroId;
    strictEqual(H.holdStateOf(t.work, M, id).state, 'held', t.lines.join('\n'));
    strictEqual(H.readRecord(t.work, M, 'handoffs', id).record?.hold_id, holdId);
    strictEqual(RL.fenceState(t.lane(id), holdId), 'present', 'fenced');
    deepStrictEqual((await RL.laneLockRivals(t.lane(id), { holdId })).map((e) => e.file), [], 'no entry of the run left in the lane');
    strictEqual((await H.liveRuns(t.work, M)).live, false, 'no live run');
  }

  it('a hold set as the run ends, while its lock entries are still there, is handed over once they are gone', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT], file: 'a.txt' }, B: { next: [COMMIT], file: 'b.txt' } } });
    try {
      // The hold lands as the run prints its report, after its last handoffs
      // and before its locks go: a command then sees a live run, and leaves
      // the handoff to it.
      let holdId = null;
      const push = t.lines.push.bind(t.lines);
      t.lines.push = (line) => {
        if (holdId === null && /^ {2}lane B · /.test(line)) holdId = holdNow(t, 'B');
        return push(line);
      };
      strictEqual(await bounded(t), 2, t.lines.join('\n'));
      ok(holdId, `the hold was set during the report:\n${t.lines.join('\n')}`);
      await handedOver(t, 'B', holdId);
    } finally {
      t.fx.cleanup();
    }
  });

  it('an interrupted run hands over a hold set as it ends, once its entries are gone', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT], file: 'a.txt' }, B: { next: [COMMIT], file: 'b.txt' }, actions: { 1: ['mark-start:s1', 'wait:never'] } } });
    try {
      let holdId = null;
      const push = t.lines.push.bind(t.lines);
      t.lines.push = (line) => {
        if (holdId === null && /^ {2}lane A · /.test(line)) holdId = holdNow(t, 'A');
        return push(line);
      };
      const running = bounded(t);
      for (let i = 0; i < 600 && !existsSync(join(t.dir, 's1')); i += 1) await pause(50);
      ok(existsSync(join(t.dir, 's1')), 'the first step started');
      t.signals.emit('SIGINT');
      strictEqual(await running, 2, t.lines.join('\n'));
      strictEqual(t.latest().halt?.reason, 'interrupted', JSON.stringify(t.latest().halt));
      ok(holdId, t.lines.join('\n'));
      await handedOver(t, 'A', holdId);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a run that stops on an error hands over a hold set before it stopped, once its entries are gone', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT], file: 'a.txt' }, B: { next: [COMMIT], file: 'b.txt' } } });
    try {
      let holdId = null;
      // The first look of A's lane after its step: the hold lands, then the
      // look fails and the run stops on the error, its entries still there.
      const observeAsync = async (a, o) => {
        if (holdId === null && a.repoRoot !== t.work && existsSync(t.lane('A')) && a.repoRoot.endsWith('/A')) {
          holdId = holdNow(t, 'A');
          throw new Error('the look broke (test)');
        }
        return OL.observeInChild(a, o);
      };
      let err = null;
      try { await bounded(t, {}, { observeAsync }); } catch (e) { err = e; }
      ok(err && /the look broke/.test(err.message), `the run stopped on the error: ${err?.message}\n${t.lines.join('\n')}`);
      ok(holdId, t.lines.join('\n'));
      await handedOver(t, 'A', holdId);
    } finally {
      t.fx.cleanup();
    }
  });

  // Two unlocked lanes of the macro, A and B, each with an open removal
  // intent (row 9); A dirty, so its removal check fails and it is locked
  // again; B clean, so a row would remove it.
  async function unlockedLanes() {
    const t = await setup({ scenario: {} });
    const M = t.fx.macroId;
    for (const id of ['A', 'B']) {
      const p = t.lane(id);
      const branch = `feat/${id.toLowerCase()}`;
      t.git(t.work, 'worktree', 'add', '-q', '--lock', '--reason', LN.lockReason(M, id), '--no-track', '-b', branch, p, 'refs/remotes/origin/main');
      const ident = LN.writeLaneIdentity(p, { macroId: M, subtaskId: id, branch });
      LN.appendIntent(t.work, M, { event: 'intent', path: p, lane_id: ident.lane_id, subtask_id: id });
      t.git(t.work, 'worktree', 'unlock', p);
    }
    writeFileSync(join(t.lane('A'), 'dirty.txt'), 'keep A');
    return t;
  }
  // reconcileLanes with the run's gate, recording each git command it runs
  // in B's lane.
  async function reconcileWatchingB(t, hooks = {}) {
    const M = t.fx.macroId;
    const calls = [];
    const original = cp.spawnSync;
    cp.spawnSync = (cmd, args, opts) => {
      if (cmd === 'git' && args[1] === t.lane('B')) calls.push(args.slice(2));
      return original(cmd, args, opts);
    };
    syncBuiltinESMExports();
    try {
      const rec = await LN.reconcileLanes({
        home: t.home, checkout: t.work, macroId: M, view: { macro: { fm: await t.fx.readMacro() }, children: {}, claims: [] }, baseline: 'main', env: t.env,
        passBy: (id) => OPS.holdGate({ mainRoot: t.work, macroId: M, subtaskId: id }), hooks,
      });
      return { rec, calls };
    } finally {
      cp.spawnSync = original;
      syncBuiltinESMExports();
    }
  }
  const setB = (t) => OPS.setHold({ mainRoot: t.work, macroId: t.fx.macroId, subtaskId: 'B', branch: 'feat/b', lane: t.lane('B'), child: null });

  it('an unlocked held lane with an open removal intent gets no removal check and is not removed', async () => {
    const t = await unlockedLanes();
    try {
      await setB(t);
      const index = join(LN.laneGitDir(t.lane('B')), 'index');
      const before = createHash('sha256').update(readFileSync(index)).digest('hex');
      // A stat change git would refresh into the index if it ran there.
      utimesSync(join(t.lane('B'), '.gitignore'), new Date(Date.now() + 2000), new Date(Date.now() + 2000));
      const { rec, calls } = await reconcileWatchingB(t);
      ok(existsSync(t.lane('B')), 'B stands');
      deepStrictEqual(calls, [], 'no git command ran in the held lane');
      strictEqual(createHash('sha256').update(readFileSync(index)).digest('hex'), before, "the held lane's index is untouched");
      deepStrictEqual(rec.passedBy.map((p) => p.subtaskId), ['B']);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a hold set while reconciliation runs stops every later action on its lane', async () => {
    const t = await unlockedLanes();
    try {
      // B's hold lands while A's row 9 locks A again, before B's row acts.
      const { rec } = await reconcileWatchingB(t, { beforeRelock: async (p) => { if (p === t.lane('A')) await setB(t); } });
      ok(existsSync(t.lane('B')), `B stands: ${JSON.stringify(rec.reports)}`);
      strictEqual(H.holdStateOf(t.work, t.fx.macroId, 'B').state, 'pending');
      deepStrictEqual(rec.passedBy.map((p) => p.subtaskId), ['B']);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a lane given back and held again before its rows are judged is reconciled once its second release is consumed', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT], file: 'a.txt' }, B: { next: [COMMIT], file: 'b.txt' } } });
    try {
      const M = t.fx.macroId;
      const fm = await t.fx.readMacro();
      const made = LN.createLane({ home: t.home, checkout: t.work, macroId: M, subtask: fm.plan.subtasks[0], view: { macro: { fm }, children: {}, claims: [] }, baseline: 'main', env: t.env });
      ok(made.ok, JSON.stringify(made));
      const h = await held(t, 'A', { lane: t.lane('A') });
      await release(t, h, async () => BASIS);
      // The first comparison fails, so the relaunch passes A by; the retry
      // consumes it, and a new hold lands as that consumption is announced.
      let h2 = null;
      let released2 = false;
      let n = 0;
      const push = t.lines.push.bind(t.lines);
      t.lines.push = (line) => {
        if (!h2 && /^ {2}lane A: its release .* is consumed:/.test(line)) {
          h2 = { schema: 'agentic-hold-1', hold_id: P.newRecordId(), subtask_id: 'A', branch: 'feat/a', lane: t.lane('A'), child: null, state: 'held', set_by: 'owner', set_at: new Date().toISOString() };
          H.writeWhole(H.recordPath(t.work, M, 'holds', 'A'), h2);
        }
        return push(line);
      };
      const code = await bounded(t, {}, {
        releaseBasis: async () => { n += 1; if (n === 1) throw new Error('the first comparison cannot run'); return BASIS; },
        observeAsync: async (a, o) => {
          if (h2 && !released2 && H.holdStateOf(t.work, M, 'A').state === 'held') {
            released2 = true;
            await release(t, h2, async () => BASIS);
          }
          return OL.observeInChild(a, o);
        },
      });
      strictEqual(code, 2, t.lines.join('\n'));
      ok(h2 && released2, t.lines.join('\n'));
      strictEqual(releaseOf(t).state, 'consumed');
      const r = t.latest();
      ok(stepsOf(r).some((x) => x[3] === 'A' && x[2] === 'dispatch'), `A stepped: ${JSON.stringify(eventsOf(t, r, 'A'))}\n${t.lines.join('\n')}`);
    } finally {
      t.fx.cleanup();
    }
  });
});
