// tests/orchestrator/test-autopilot-scheduler-releases-wake.mjs
//
// ADR-0068 Decision 1, items 6 and 7, and Decision 2 (impl-hold, Task 9) —
// what wakes a live run, and what the run does before it ends: a hold record
// or a release wakes it, the driver's own records and the holds lock do not; a
// pending handoff, and a comparison refused or failed, are tried again at each
// tick; a handoff the holds lock blocks never stops the other lanes; a release
// recorded during the turn's last look, or the run's last reconsideration, is
// compared before the run ends.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COMMIT, setup, stepsOf } from './fixtures/autopilot-lanes-run.mjs';
import {
  BASIS, basisSeam, H, held, OL, OPS, P, parkRecord, pause, release, releaseOf, RL, scenario, until,
} from './fixtures/autopilot-holds-run.mjs';

describe('what wakes a live run, and what it compares before it ends (ADR-0068 Decision 1, items 6 and 7)', () => {
  it('a release recorded after the run\'s last look of the turn is compared before the run ends, and its lane steps', async () => {
    // B dispatches and commits; the release lands during the look that
    // follows B's commit, after that turn's comparison.
    const t = await setup({ scenario: { ...scenario(), actions: { 2: ['mark:b-done'] } } });
    try {
      const h = await held(t);
      let released = false;
      const code = await t.run({}, {
        releaseBasis: basisSeam(BASIS).fn,
        observeAsync: async (a, o) => {
          const v = await OL.observeInChild(a, o);
          if (!released && a.repoRoot === t.work && existsSync(join(t.dir, 'b-done'))) {
            released = true;
            await release(t, h, async () => BASIS);
          }
          return v;
        },
      });
      strictEqual(code, 2, t.lines.join('\n'));
      ok(released, 'the release was recorded during the run');
      strictEqual(releaseOf(t).state, 'consumed');
      ok(stepsOf(t.latest()).some((s) => s[3] === 'A' && s[2] === 'dispatch'), `A stepped in the same run: ${JSON.stringify(stepsOf(t.latest()))}\n${t.lines.join('\n')}`);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a release recorded during the run\'s last reconsideration is compared before the run ends', async () => {
    const t = await setup({ subtasks: [{ id: 'A' }, { id: 'B' }, { id: 'C' }], scenario: { ...scenario(), actions: { 2: ['mark:b-done'] } } });
    try {
      const M = t.fx.macroId;
      const h = await held(t);
      // A kept park the hold keeps as it is, never looked at again while the
      // lane is held (N7); and C's, the owner's choice, which the run's end
      // looks at again.
      const kept = parkRecord(t, { fingerprint: 'stale', release_only: false });
      strictEqual((await P.writePark(t.work, M, kept)).ok, true);
      strictEqual((await P.writePark(t.work, M, parkRecord(t, { subtask_id: 'C', branch: 'feat/c' }))).ok, true);
      let released = false;
      // After B's commit the run settles B (a look of its lane), takes the
      // turn's global look (with a fetch), finds nothing to step, and makes
      // its last reconsideration, whose look of C, a lane with no worktree, is
      // the driver's checkout without a fetch. The release lands in that
      // look, never in a reconsideration a turn makes before its comparison.
      let stage = 0;
      const code = await t.run({}, {
        releaseBasis: basisSeam(BASIS).fn,
        observeAsync: async (a, o) => {
          const v = await OL.observeInChild(a, o);
          if (!existsSync(join(t.dir, 'b-done'))) return v;
          if (stage === 0 && a.repoRoot !== t.work) stage = 1;
          else if (stage === 1 && a.repoRoot === t.work && a.fetch !== false) stage = 2;
          else if (stage === 2 && !released && a.repoRoot === t.work && a.fetch === false) {
            released = true;
            await release(t, h, async () => BASIS);
          }
          return v;
        },
      });
      strictEqual(code, 2, t.lines.join('\n'));
      ok(released, 'the release was recorded during the run');
      strictEqual(releaseOf(t).state, 'consumed', t.lines.join('\n'));
      ok(stepsOf(t.latest()).some((s) => s[3] === 'A' && s[2] === 'dispatch'), `A stepped in the same run: ${JSON.stringify(stepsOf(t.latest()))}\n${t.lines.join('\n')}`);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a release while another lane\'s step runs wakes the run, which compares it and steps the lane before that step ends', async () => {
    // B (seq 1) waits until A's step has started: only a wake-up that is no
    // step's end can start A.
    const t = await setup({ scenario: { ...scenario(), actions: { 1: ['mark-start:b-started', 'wait:a-started'], 2: ['mark-start:a-started'] } } });
    try {
      const h = await held(t);
      const running = t.run({}, { releaseBasis: basisSeam(BASIS).fn });
      for (let i = 0; i < 600 && !existsSync(join(t.dir, 'b-started')); i += 1) await pause(50);
      ok(existsSync(join(t.dir, 'b-started')), 'B started');
      await release(t, h, async () => BASIS);
      strictEqual(await running, 2, t.lines.join('\n'));
      ok(!existsSync(join(t.dir, 'a-started.timeout')), 'A started while B\'s step ran');
      strictEqual(releaseOf(t).state, 'consumed');
      const steps = stepsOf(t.latest());
      deepStrictEqual(steps.slice(0, 2).map((s) => [s[3], s[2]]), [['B', 'dispatch'], ['A', 'dispatch']], JSON.stringify(steps));
    } finally {
      t.fx.cleanup();
    }
  });

  it('a hold set while every lane runs quietly is seen at the next tick, not at a step\'s end', async () => {
    // Two lanes run, C waits for room; both steps wait until C is announced
    // held, which only a wake-up that is no step's end can bring.
    const t = await setup({
      subtasks: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
      scenario: { ...scenario(), C: { next: [COMMIT], file: 'c.txt' }, actions: { 1: ['wait:hold-seen'], 2: ['mark-start:b-started', 'wait:hold-seen'] } },
    });
    try {
      t.lines.push = ((push) => (line) => {
        if (/lane C: held \(hold /.test(line)) writeFileSync(join(t.dir, 'hold-seen'), '1');
        return push(line);
      })(t.lines.push.bind(t.lines));
      const running = t.run();
      for (let i = 0; i < 600 && !existsSync(join(t.dir, 'b-started')); i += 1) await pause(50);
      ok(existsSync(join(t.dir, 'b-started')), 'both lanes run');
      await OPS.setHold({ mainRoot: t.work, macroId: t.fx.macroId, subtaskId: 'C', branch: 'feat/c', lane: null, child: null });
      strictEqual(await running, 2, t.lines.join('\n'));
      ok(!existsSync(join(t.dir, 'hold-seen.timeout')), t.lines.join('\n'));
      deepStrictEqual(stepsOf(t.latest()).filter((s) => s[3] === 'C'), [], 'C never stepped');
    } finally {
      t.fx.cleanup();
    }
  });

  it('a pending handoff is tried again at each tick: one an open operation blocked completes once it closes, at no step\'s end', async () => {
    const t = await setup({
      subtasks: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
      scenario: { ...scenario(), C: { next: [COMMIT], file: 'c.txt' }, actions: { 1: ['wait:hold-seen'], 2: ['mark-start:b-started', 'wait:hold-seen'] } },
    });
    try {
      const M = t.fx.macroId;
      const op = 'op-20261026T000000Z-0000c0de';
      H.publishOpRecord(t.work, M, 'C', { operation_id: op, kind: 'verb' });
      let blocked = false;
      t.lines.push = ((push) => (line) => {
        // The operation closes once the run has found it blocking: what
        // unblocks the handoff touches no hold record.
        if (/lane C: hold \w+ waits for its handoff: .*persona operation is open/.test(line)) {
          blocked = true;
          H.removeOpRecord(t.work, M, 'C', op);
        }
        if (/lane C: held \(hold /.test(line)) writeFileSync(join(t.dir, 'hold-seen'), '1');
        return push(line);
      })(t.lines.push.bind(t.lines));
      const running = t.run();
      for (let i = 0; i < 600 && !existsSync(join(t.dir, 'b-started')); i += 1) await pause(50);
      ok(existsSync(join(t.dir, 'b-started')), 'both lanes run');
      await OPS.setHold({ mainRoot: t.work, macroId: M, subtaskId: 'C', branch: 'feat/c', lane: null, child: null });
      strictEqual(await running, 2, t.lines.join('\n'));
      ok(blocked, 'the handoff waited for the operation first');
      ok(!existsSync(join(t.dir, 'hold-seen.timeout')), t.lines.join('\n'));
    } finally {
      t.fx.cleanup();
    }
  });

  it('a comparison an open operation refused is tried again at each tick: the lane steps once it closes, at no step\'s end', async () => {
    const t = await setup({ scenario: { ...scenario(), actions: { 1: ['mark-start:b-started', 'wait:a-started'], 2: ['mark-start:a-started'] } } });
    try {
      const M = t.fx.macroId;
      const h = await held(t);
      await release(t, h, async () => BASIS);
      const op = 'op-20261026T000000Z-0000f00d';
      H.publishOpRecord(t.work, M, 'A', { operation_id: op, kind: 'verb' });
      let refused = false;
      t.lines.push = ((push) => (line) => {
        // The operation closes once B runs and the comparison was refused.
        if (/lane A: its release waits to be compared: .*persona operation is open/.test(line)) refused = true;
        if (refused && existsSync(join(t.dir, 'b-started'))) {
          try { H.removeOpRecord(t.work, M, 'A', op); } catch { /* gone */ }
        }
        return push(line);
      })(t.lines.push.bind(t.lines));
      const running = t.run({}, { releaseBasis: basisSeam(BASIS).fn });
      for (let i = 0; i < 600 && !existsSync(join(t.dir, 'b-started')); i += 1) await pause(50);
      ok(existsSync(join(t.dir, 'b-started')), 'B started');
      // A line after B started, so the hook above closes the operation.
      t.lines.push('test: B started');
      strictEqual(await running, 2, t.lines.join('\n'));
      ok(refused, 'the comparison was refused first');
      ok(!existsSync(join(t.dir, 'a-started.timeout')), `A stepped while B's step ran\n${t.lines.join('\n')}`);
      strictEqual(releaseOf(t).state, 'consumed');
    } finally {
      t.fx.cleanup();
    }
  });

  it('a comparison whose basis could not be taken does not stop the run, and is tried again at each tick', async () => {
    const t = await setup({ scenario: { ...scenario(), actions: { 1: ['mark-start:b-started', 'wait:a-started'], 2: ['mark-start:a-started'] } } });
    try {
      const h = await held(t);
      await release(t, h, async () => BASIS);
      // The basis fails until B runs: only a tick can try it again then.
      const seam = basisSeam(() => {
        if (!existsSync(join(t.dir, 'b-started'))) throw new Error('the basis task timed out');
        return BASIS;
      });
      strictEqual(await t.run({}, { releaseBasis: seam.fn }), 2, t.lines.join('\n'));
      ok(t.lines.some((l) => /lane A: its release could not be compared or settled \(the basis task timed out\)/.test(l)), t.lines.join('\n'));
      ok(!existsSync(join(t.dir, 'a-started.timeout')), `A stepped while B's step ran\n${t.lines.join('\n')}`);
      strictEqual(releaseOf(t).state, 'consumed');
    } finally {
      t.fx.cleanup();
    }
  });

  it('a handoff the holds lock keeps from running stays pending, and the other lanes\' steps go on', async () => {
    const t = await setup({
      subtasks: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
      scenario: { ...scenario(), C: { next: [COMMIT], file: 'c.txt' }, actions: { 1: ['mark-start:a-started', 'wait:go'], 2: ['mark-start:b-started', 'wait:go'] } },
    });
    const M = t.fx.macroId;
    const op = 'op-20261026T000000Z-0000c1c1';
    let lock = null;
    let wait = null;
    try {
      const running = t.run();
      ok(await until(() => existsSync(join(t.dir, 'b-started'))), 'both lanes run');
      H.publishOpRecord(t.work, M, 'C', { operation_id: op, kind: 'verb' });
      await OPS.setHold({ mainRoot: t.work, macroId: M, subtaskId: 'C', branch: 'feat/c', lane: null, child: null });
      ok(await until(() => t.lines.some((l) => /lane C: hold \w+ waits for its handoff: .*persona operation is open/.test(l))), t.lines.join('\n'));
      // Another owner command holds the holds lock past the run's wait.
      wait = H.setHoldsLockWaitMs(0);
      lock = await RL.acquireLock(H.holdsLockPath(t.work, M), { record: { kind: 'holds', run_id: 'another owner command' } });
      ok(await until(() => t.lines.some((l) => /lane C: hold \w+ waits for its handoff: the handoff could not run/.test(l))), t.lines.join('\n'));
      lock.release();
      lock = null;
      H.setHoldsLockWaitMs(wait);
      wait = null;
      H.removeOpRecord(t.work, M, 'C', op);
      ok(await until(() => t.lines.some((l) => /lane C: held \(hold /.test(l))), t.lines.join('\n'));
      writeFileSync(join(t.dir, 'go'), '1');
      strictEqual(await running, 2, t.lines.join('\n'));
      const steps = stepsOf(t.latest());
      deepStrictEqual(steps.filter((s) => s[4] === 'error'), [], JSON.stringify(steps));
      ok(steps.some((s) => s[3] === 'A' && s[2] === 'commit') && steps.some((s) => s[3] === 'B' && s[2] === 'commit'), JSON.stringify(steps));
    } finally {
      lock?.release();
      if (wait !== null) H.setHoldsLockWaitMs(wait);
      writeFileSync(join(t.dir, 'go'), '1');
      t.fx.cleanup();
    }
  });

  it('the driver\'s own records and the holds lock wake nothing; the owner\'s record does', async () => {
    const t = await setup({ scenario: { ...scenario(), actions: { 1: ['mark-start:b-started', 'wait:go'] } } });
    try {
      const M = t.fx.macroId;
      await held(t);
      const looks = [];
      const running = t.run({}, {
        releaseBasis: basisSeam(BASIS).fn,
        observeAsync: (a, o) => {
          if (a.repoRoot === t.work) looks.push(Date.now());
          return OL.observeInChild(a, o);
        },
      });
      for (let i = 0; i < 600 && !existsSync(join(t.dir, 'b-started')); i += 1) await pause(50);
      ok(existsSync(join(t.dir, 'b-started')), 'B started');
      await pause(400);
      const from = Date.now();
      // What the driver and the commands write as bookkeeping: the handoff
      // record, the events, the exclusion records, the holds lock.
      const ho = H.readRecord(t.work, M, 'handoffs', 'A');
      H.writeWhole(ho.path, { ...ho.record });
      H.appendHoldEvent(t.work, M, { event: 'test' });
      H.publishOpRecord(t.work, M, 'B', { operation_id: 'op-20261026T000000Z-0000beef', kind: 'compare', persona: 'orchestrator' });
      H.removeOpRecord(t.work, M, 'B', 'op-20261026T000000Z-0000beef');
      mkdirSync(H.holdsLockPath(t.work, M), { recursive: true });
      rmSync(H.holdsLockPath(t.work, M), { recursive: true, force: true });
      await pause(1200);
      strictEqual(looks.filter((x) => x >= from).length, 0, 'no look woken by bookkeeping');
      // The owner's record, rewritten: a wake-up, and a look.
      const own = H.readOwnerHold(t.work, M, 'A');
      H.writeWhole(own.path, { ...own.record });
      for (let i = 0; i < 60 && looks.filter((x) => x >= from).length === 0; i += 1) await pause(50);
      ok(looks.filter((x) => x >= from).length > 0, 'the owner\'s record woke the run');
      writeFileSync(join(t.dir, 'go'), '1');
      strictEqual(await running, 2, t.lines.join('\n'));
    } finally {
      t.fx.cleanup();
    }
  });
});
