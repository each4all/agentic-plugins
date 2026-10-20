// tests/orchestrator/test-autopilot-scheduler-lane-gate.mjs
//
// ADR-0068 Decision 1 — an owner gate stops only its lane, end to end with no
// model (fixtures/autopilot-lanes-run.mjs: the fake claude, the scripted
// worker doing each step through the real state CLIs, real git worktrees).
//
// This file: a lane's gate parks that lane while the other completes; the
// parked lane picked up again, while the other lane is mid-step, once the owner
// clears its gate; a worker that could not spawn parks its lane and is never
// retried on its unchanged record, in this run or the next, until the owner
// releases it; a creation refused before any worker starts parks that lane
// while the other starts; no worker spawns into a lane with a persona
// operation open; what changes while a step's marker waits for the park
// records' lock (an interrupt, a write, a worker that ended) is asked again,
// and the run returns only once its queued park changes are done. The run's ends — drains, a crash, the end's last pass, a
// release as it ends — are in test-autopilot-scheduler-lane-ends.mjs.

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { AP, bySubtask, COMMIT, markOn, setup, stepsOf } from './fixtures/autopilot-lanes-run.mjs';

const PK = await import(resolve(AP, 'parks.mjs'));
const W = await import(resolve(AP, 'worker.mjs'));
const OL = await import(resolve(AP, 'offloop.mjs'));
const C = await import(resolve(AP, 'cli.mjs'));
const RL = await import(resolve(AP, '../../../scripts/lib/run-locks.mjs'));
const ENG = resolve(AP, '../../../../engineer');
const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });
const GATE = 'scope-routing';

// The owner resolves A's gate as decide's selection does: the clear and the
// next step in one write.
async function clearGate(t, id, nextStep = COMMIT) {
  const workflowPath = readFileSync(join(t.dir, `child-${id}.path`), 'utf8');
  await t.fx.eng.clearAwaitingOwner({
    workflowPath, host: 'claude', gate: GATE, nextStep, nextAction: 'Commit the change', resolution: 'the owner chose to commit', env: t.fx.env,
  });
}

const events = (r, id) => (r.lanes ?? []).filter((e) => e.subtask_id === id && (e.event === 'parked' || e.event === 'resumed')).map((e) => e.event);

describe('an owner gate stops only its lane', () => {
  it('a lane\'s gate parks that lane while the other completes; the run ends once every remaining lane waits, the gate first, the waiting lane listed', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT] }, B: { next: [COMMIT], file: 'b.txt' }, actions: { 1: `gate:${GATE}` } } });
    try {
      strictEqual(await t.run({}, { wakeIntervalMs: 300 }), 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(stepsOf(r).map((x) => [x[1], x[2], x[4]]).sort(), [['A', 'dispatch', 'ok'], ['B', 'commit', 'ok'], ['B', 'dispatch', 'ok']]);
      ok(t.lines.some((l) => l.startsWith(`■ lane A: awaiting-owner:${GATE} — `)), t.lines.join('\n'));
      ok(!t.lines.some((l) => /draining/.test(l)), 'a lane gate drains nothing');
      deepStrictEqual([r.halt.reason, r.halt.subtask_id], [`awaiting-owner:${GATE}`, 'A']);
      ok(r.halt.pointer, 'the gate\'s pointer');
      match(r.halt.resolution.release, /release A --macro /);
      deepStrictEqual(r.halt.lanes.map((l) => [l.subtask_id, l.state]), [['A', 'parked'], ['B', 'waiting-to-land']]);
      ok(t.lines.some((l) => /^ {6}parked since .*: awaiting-owner:scope-routing/.test(l)), 'the report shows the park');
      deepStrictEqual(events(r, 'A'), ['parked']);
      const kept = PK.readPark(t.work, t.fx.macroId, 'A');
      deepStrictEqual([kept.record?.state, kept.record?.reason], ['parked', `awaiting-owner:${GATE}`]);
    } finally {
      t.fx.cleanup();
    }
  });

  it('the parked lane is picked up again, while the other lane is mid-step, once the owner clears its gate', async () => {
    // B's dispatch goes on only once A's next step has started.
    const t = await setup({
      scenario: {
        A: { next: [COMMIT], file: true }, B: { next: [COMMIT], file: 'b.txt' },
        actions: { 1: `gate:${GATE}`, 2: ['mark-start:b-started', 'wait:a-resumed'], 3: 'mark-start:a-resumed' },
      },
    });
    // The owner, once A is parked and B runs.
    const owner = (async () => {
      for (let i = 0; i < 1200; i += 1) {
        if (existsSync(join(t.dir, 'b-started')) && t.lines.some((l) => l.startsWith('■ lane A: '))) {
          await clearGate(t, 'A');
          return true;
        }
        await pause(50);
      }
      return false;
    })();
    try {
      strictEqual(await t.run({}, { wakeIntervalMs: 300 }), 2, t.lines.join('\n'));
      ok(await owner, 'the owner cleared A\'s gate while B ran');
      ok(!existsSync(join(t.dir, 'a-resumed.timeout')), 'A stepped again while B was still in its step');
      const r = t.latest();
      deepStrictEqual(stepsOf(r).map((x) => [x[0], x[1], x[2], x[4]]), [[1, 'A', 'dispatch', 'ok'], [2, 'B', 'dispatch', 'ok'], [3, 'A', 'commit', 'ok'], [4, 'B', 'commit', 'ok']]);
      const [b2, a3] = [r.steps.find((x) => x.seq === 2), r.steps.find((x) => x.seq === 3)];
      ok(Date.parse(a3.started_at) < Date.parse(b2.ended_at), 'A\'s commit started before B\'s dispatch ended');
      ok(t.lines.some((l) => /^ {2}lane A: picked up again \(its record changed\)/.test(l)), t.lines.join('\n'));
      deepStrictEqual(events(r, 'A'), ['parked', 'resumed']);
      strictEqual(r.halt.reason, 'awaiting-landing');
      deepStrictEqual(PK.readParks(t.work, t.fx.macroId).records, [], 'the kept park ended');
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('a park is taken from the facts its halt was decided from', () => {
  it('a gate the owner clears while the park is recorded picks the lane up: the clear is never folded into the park', async () => {
    const t = await setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [COMMIT], file: true }, actions: { 1: `gate:${GATE}` } } });
    let cleared = false;
    // The park's own look of A's lane comes after the step's settlement.
    const observeAsync = async (a, o) => {
      if (!cleared && a.repoRoot === t.lane('A') && t.lines.some((l) => /^ {4}\[1\] lane A exit=/.test(l))) {
        cleared = true;
        await clearGate(t, 'A');
      }
      return OL.observeInChild(a, o);
    };
    try {
      strictEqual(await t.run({}, { observeAsync }), 2, t.lines.join('\n'));
      ok(cleared);
      const r = t.latest();
      deepStrictEqual(stepsOf(r).map((x) => [x[1], x[2], x[4]]), [['A', 'dispatch', 'ok'], ['A', 'commit', 'ok']]);
      strictEqual(r.halt.reason, 'awaiting-landing');
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('a failure that wrote nothing is never retried on an unchanged record', () => {
  it('a worker that could not spawn parks its lane, is not retried in this run or the next, and is dispatched once the owner releases it', async () => {
    let attempts = 0;
    const failing = (o) => {
      if (/^\/orchestrator:next A /.test(o.prompt)) {
        attempts += 1;
        throw new Error('injected: the worker could not start');
      }
      return W.startWorker(o);
    };
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT], file: 'b.txt' } } });
    try {
      strictEqual(await t.run({}, { startWorker: failing }), 2, t.lines.join('\n'));
      let r = t.latest();
      deepStrictEqual(stepsOf(r).map((x) => [x[1], x[2], x[4]]).sort(), [['A', 'dispatch', 'worker-failed'], ['B', 'commit', 'ok'], ['B', 'dispatch', 'ok']]);
      deepStrictEqual([r.halt.reason, r.halt.subtask_id, attempts], ['worker-failed', 'A', 1]);
      // The relaunch parks A again at once, on its unchanged record.
      strictEqual(await t.run({}, { startWorker: failing }), 2, t.lines.join('\n'));
      r = t.latest();
      deepStrictEqual([r.steps.length, attempts], [0, 1], 'no second attempt');
      deepStrictEqual([r.halt.reason, r.halt.subtask_id], ['worker-failed', 'A']);
      ok(t.lines.some((l) => /^■ lane A: worker-failed — .*\(kept since run /.test(l)), t.lines.join('\n'));
      // The owner's bare release; the next run dispatches A.
      const out = [];
      strictEqual(await C.main(['release', 'A', '--macro', t.fx.macroId, '--repo', t.work], { env: t.env, out: (x) => out.push(x), err: (x) => out.push(`ERR ${x}`) }), 0, out.join('\n'));
      match(out.join('\n'), /released subtask A's lane .*it was parked: worker-failed/);
      deepStrictEqual(PK.readPark(t.work, t.fx.macroId, 'A'), { state: 'absent' });
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      r = t.latest();
      deepStrictEqual(stepsOf(r).map((x) => [x[1], x[2], x[4]]), [['A', 'dispatch', 'ok'], ['A', 'commit', 'ok']]);
      strictEqual(r.halt.reason, 'awaiting-landing');
    } finally {
      t.fx.cleanup();
    }
  });

  it('a bare release while the run lives wakes it: the lane is picked up while the other lane is mid-step', async () => {
    let attempts = 0;
    const failsOnce = (o) => {
      if (/^\/orchestrator:next A /.test(o.prompt) && (attempts += 1) === 1) throw new Error('injected: the worker could not start');
      return W.startWorker(o);
    };
    // B's dispatch goes on only once A's second dispatch has started.
    const t = await setup({
      scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT], file: 'b.txt' }, actions: { 2: ['mark-start:b-started', 'wait:a-again'], 3: 'mark-start:a-again' } },
    });
    const owner = (async () => {
      for (let i = 0; i < 1200; i += 1) {
        if (existsSync(join(t.dir, 'b-started')) && t.lines.some((l) => l.startsWith('■ lane A: worker-failed'))) {
          return C.main(['release', 'A', '--macro', t.fx.macroId, '--repo', t.work], { env: t.env, out: () => {}, err: () => {} });
        }
        await pause(50);
      }
      return null;
    })();
    try {
      strictEqual(await t.run({}, { startWorker: failsOnce }), 2, t.lines.join('\n'));
      strictEqual(await owner, 0, 'the owner released A while the run lived');
      ok(!existsSync(join(t.dir, 'a-again.timeout')), 'A was dispatched again while B was still in its step');
      const r = t.latest();
      deepStrictEqual(stepsOf(r).filter((x) => x[1] === 'A').map((x) => [x[0], x[2], x[4]]).slice(0, 2), [[1, 'dispatch', 'worker-failed'], [3, 'dispatch', 'ok']]);
      ok(t.lines.some((l) => /^ {2}lane A: picked up again \(released\)/.test(l)), t.lines.join('\n'));
      strictEqual(r.halt.reason, 'awaiting-landing');
    } finally {
      t.fx.cleanup();
    }
  });

  it('a creation refused before any worker starts parks that lane, waiting for the owner\'s release, and the other lane still starts', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT] }, B: { next: [COMMIT], file: 'b.txt' } } });
    const elsewhere = join(t.dir, 'elsewhere');
    let checkedOut = false;
    // A's branch is checked out in another worktree just before its lane is created.
    const offLoop = (task, args, o) => {
      if (task === 'createLane' && args.subtask?.id === 'A' && !checkedOut) {
        checkedOut = true;
        t.git(t.work, 'worktree', 'add', '-q', '-b', 'feat/a', elsewhere, 'refs/remotes/origin/main');
      }
      return OL.offLoop(task, args, o);
    };
    try {
      strictEqual(await t.run({}, { offLoop }), 2, t.lines.join('\n'));
      ok(checkedOut);
      const r = t.latest();
      deepStrictEqual(stepsOf(r).map((x) => [x[1], x[2], x[4]]), [['B', 'dispatch', 'ok'], ['B', 'commit', 'ok']]);
      deepStrictEqual([r.halt.reason, r.halt.subtask_id], ['owner-choice', 'A']);
      match(r.halt.detail, /checked out in .*elsewhere/);
      strictEqual(r.halt.resolution.change, null, 'its cause lies outside its record: only a release resumes it');
      const kept = PK.readPark(t.work, t.fx.macroId, 'A').record;
      deepStrictEqual([kept.state, kept.release_only, kept.form], ['parked', true, 'no-worktree']);
      strictEqual(bySubtask(r).A.state, 'parked');
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('no worker spawns into a lane with a persona operation open', () => {
  it('a lane laneBusy holds is neither created nor stepped until its operation closes; the other lane goes first', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT], file: 'b.txt' }, actions: { 1: 'mark:b-dispatched' } } });
    const laneBusy = (id) => id === 'A' && !existsSync(join(t.dir, 'b-dispatched'));
    try {
      strictEqual(await t.run({}, { wakeIntervalMs: 300, laneBusy }), 2, t.lines.join('\n'));
      const r = t.latest();
      const first = r.steps.find((x) => x.seq === 1);
      const a = r.steps.find((x) => x.lane === 'A');
      deepStrictEqual([first.lane, first.kind], ['B', 'dispatch']);
      const closed = Math.floor(statSync(join(t.dir, 'b-dispatched')).mtimeMs);
      ok(Date.parse(a.started_at) >= closed, 'A started only once its operation closed');
      const created = r.lanes.filter((e) => e.event === 'created' && e.subtask_id === 'A').map((e) => Date.parse(e.at));
      ok(created.length > 0 && created.every((at) => at >= closed - 1), `no lane was created for A while it was busy: ${JSON.stringify(created)} vs ${closed}`);
      strictEqual(r.halt.reason, 'awaiting-landing');
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('a parked lane is woken for every change after the facts of its park', () => {
  it('a gate cleared between the decision\'s look and the park\'s own look wakes the lane while the other lane is mid-step', async () => {
    const t = await setup({
      scenario: {
        A: { next: [COMMIT], file: true }, B: { next: [COMMIT], file: 'b.txt' },
        actions: { 1: `gate:${GATE}`, 2: ['mark-start:b-started', 'wait:a-resumed'], 3: 'mark-start:a-resumed' },
      },
    });
    let cleared = false;
    // The park's own look of A's lane is the first after A's step settled.
    const observeAsync = async (a, o) => {
      if (!cleared && a.repoRoot === t.lane('A') && t.lines.some((l) => /^ {4}\[1\] lane A exit=/.test(l))) {
        cleared = true;
        await clearGate(t, 'A');
      }
      return OL.observeInChild(a, o);
    };
    try {
      strictEqual(await t.run({}, { observeAsync, wakeIntervalMs: 300 }), 2, t.lines.join('\n'));
      ok(cleared);
      ok(t.lines.some((l) => l.startsWith('■ lane A: ')), 'A parked on its gate as it was decided');
      ok(!existsSync(join(t.dir, 'a-resumed.timeout')), 'A stepped again while B was still in its step');
      const r = t.latest();
      const [b2, a3] = [r.steps.find((x) => x.seq === 2), r.steps.find((x) => x.lane === 'A' && x.kind === 'commit')];
      ok(a3 && Date.parse(a3.started_at) < Date.parse(b2.ended_at), 'A\'s commit started before B\'s dispatch ended');
      deepStrictEqual(events(r, 'A'), ['parked', 'resumed']);
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('a parked lane is woken for a change made while it is judged', () => {
  it('a gate cleared after the judging look read the lane, while a tick reads its digest, wakes the lane at a later tick', async () => {
    const t = await setup({
      scenario: {
        A: { next: [COMMIT], file: true }, B: { next: [COMMIT], file: 'b.txt' },
        actions: { 1: `gate:${GATE}`, 2: ['mark-start:b-started', 'wait:a-resumed'], 3: 'mark-start:a-resumed' },
      },
    });
    let cleared = false;
    // The first look of A's lane after its park is the one that judges it
    // again: it reads the lane, then the owner clears the gate, and a tick
    // reads the new digest before that look returns.
    const observeAsync = async (a, o) => {
      if (!cleared && a.repoRoot === t.lane('A') && t.lines.some((l) => l.startsWith('■ lane A: '))) {
        cleared = true;
        const v = await OL.observeInChild(a, o);
        await clearGate(t, 'A');
        await pause(900);
        return v;
      }
      return OL.observeInChild(a, o);
    };
    try {
      // A quiet period longer than the judging look's wait: the tick that
      // read the new digest during it does not make the lane a candidate
      // before the look's judgment is recorded.
      strictEqual(await t.run({}, { observeAsync, wakeIntervalMs: 300, quietMs: 2000 }), 2, t.lines.join('\n'));
      ok(cleared);
      ok(!existsSync(join(t.dir, 'a-resumed.timeout')), 'A stepped again while B was still in its step');
      const r = t.latest();
      deepStrictEqual(events(r, 'A'), ['parked', 'resumed']);
      strictEqual(r.steps.filter((x) => x.lane === 'A' && x.kind === 'commit').length, 1);
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('a lane picked up again is reconciled first', () => {
  it('a lane the run holds, whose ownership lock the owner removed while it was parked, is not stepped there', async () => {
    const t = await setup({
      scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT], file: 'b.txt' }, actions: { 1: `gate:${GATE}`, 2: ['mark-start:b-started', 'wait:a-picked'] } },
    });
    markOn(t, /^ {2}lane A: picked up again/, 'a-picked');
    const owner = (async () => {
      for (let i = 0; i < 1200; i += 1) {
        if (existsSync(join(t.dir, 'b-started')) && t.lines.some((l) => l.startsWith('■ lane A: '))) {
          t.git(t.work, 'worktree', 'unlock', t.lane('A'));
          await clearGate(t, 'A');
          return true;
        }
        await pause(50);
      }
      return false;
    })();
    try {
      strictEqual(await t.run({}, { wakeIntervalMs: 300 }), 2, t.lines.join('\n'));
      ok(await owner);
      ok(!existsSync(join(t.dir, 'a-picked.timeout')), 'A was picked up while B ran');
      const r = t.latest();
      deepStrictEqual(stepsOf(r).filter((x) => x[1] === 'A').map((x) => [x[2], x[4]]), [['dispatch', 'ok']], 'A\'s commit never ran in a lane that is not provably the run\'s');
      // Its rows, judged again: the worktree at its path is no longer
      // provably the run's lane, so its branch is held elsewhere.
      deepStrictEqual(events(r, 'A'), ['parked', 'resumed', 'parked']);
      deepStrictEqual([r.halt.reason, r.halt.subtask_id], ['owner-choice', 'A']);
      match(r.halt.detail, /checked out in .*not one of this run's lanes/);
      strictEqual(PK.readPark(t.work, t.fx.macroId, 'A').record?.release_only, true);
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('no worker spawns into a lane whose engineer record another hand is writing', () => {
  it('a write to the lane\'s record during its admission holds the spawn until the quiet period has passed since', async () => {
    const t = await setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [COMMIT], file: true }, actions: { 1: `gate:${GATE}` } } });
    let touchedAt = null;
    const childPath = () => readFileSync(join(t.dir, `child-${'A'}.path`), 'utf8');
    // The owner's finish-verb, seconds after the clear: here, while the
    // admission of A's next step looks at its lane.
    const observeAsync = async (a, o) => {
      if (touchedAt === null && a.repoRoot === t.lane('A') && t.lines.some((l) => /^ {2}lane A: picked up again/.test(l))) {
        // After the look returns: the write is the last thing before the
        // admission's checks.
        const v = await OL.observeInChild(a, o);
        const now = new Date();
        utimesSync(childPath(), now, now);
        touchedAt = now.getTime();
        return v;
      }
      return OL.observeInChild(a, o);
    };
    const owner = (async () => {
      for (let i = 0; i < 1200; i += 1) {
        if (t.lines.some((l) => l.startsWith('■ lane A: '))) { await clearGate(t, 'A'); return true; }
        await pause(50);
      }
      return false;
    })();
    try {
      strictEqual(await t.run({}, { observeAsync, wakeIntervalMs: 300, quietMs: 3000 }), 2, t.lines.join('\n'));
      ok(await owner);
      ok(touchedAt !== null, 'the record was written during the admission');
      const r = t.latest();
      const a = r.steps.find((x) => x.kind === 'commit');
      ok(a, 'A stepped once its record was quiet');
      ok(Date.parse(a.started_at) >= touchedAt + 2900, `A's commit started ${Date.parse(a.started_at) - touchedAt} ms after the write, not a whole quiet period`);
      strictEqual(r.halt.reason, 'awaiting-landing');
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('what changes while a step\'s marker waits for the park records\' lock is asked again', () => {
  const lockOf = (t) => join(PK.parksDir(t.work, t.fx.macroId), '.lock');

  it('an interrupt while a lane\'s creation marker waits for its lock creates no lane', async () => {
    const t = await setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [COMMIT], file: true } } });
    let held = null;
    let asked = false;
    // Asked right before the creation's marker: the owner holds the park
    // records' lock then, and interrupts the run while the marker waits.
    const laneBusy = (id) => {
      if (id === 'A' && !asked) {
        asked = true;
        held = RL.acquireLock(lockOf(t), { record: { run_id: 'the owner' } });
        setTimeout(() => t.signals.emit('SIGINT'), 300);
        setTimeout(async () => (await held).release(), 900);
      }
      return false;
    };
    mkdirSync(PK.parksDir(t.work, t.fx.macroId), { recursive: true });
    try {
      strictEqual(await t.run({}, { laneBusy }), 2, t.lines.join('\n'));
      ok(asked);
      const r = t.latest();
      strictEqual(r.halt.reason, 'interrupted');
      deepStrictEqual(r.steps, []);
      strictEqual(existsSync(t.lane('A')), false, 'no lane was created');
      ok(!r.lanes.some((e) => e.event === 'created'), JSON.stringify(r.lanes));
      deepStrictEqual(PK.readParks(t.work, t.fx.macroId).records, [], 'the marker was settled');
    } finally {
      t.fx.cleanup();
    }
  });

  it('a write to the lane\'s record while the step\'s marker waits for its lock holds the spawn until the quiet period has passed since', async () => {
    const t = await setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [COMMIT], file: true }, actions: { 1: `gate:${GATE}` } } });
    let touchedAt = null;
    let holding = false;
    const childPath = () => readFileSync(join(t.dir, 'child-A.path'), 'utf8');
    // A's next admission, once A was picked up again: after its look the
    // owner holds the park records' lock, writes A's record while the
    // step's marker waits, then lets go.
    const observeAsync = async (a, o) => {
      const v = await OL.observeInChild(a, o);
      if (!holding && a.repoRoot === t.lane('A') && t.lines.some((l) => /^ {2}lane A: picked up again/.test(l))) {
        holding = true;
        const held = await RL.acquireLock(lockOf(t), { record: { run_id: 'the owner' } });
        setTimeout(() => {
          const now = new Date();
          utimesSync(childPath(), now, now);
          touchedAt = now.getTime();
          setTimeout(() => held.release(), 100);
        }, 400);
      }
      return v;
    };
    const owner = (async () => {
      for (let i = 0; i < 1200; i += 1) {
        if (t.lines.some((l) => l.startsWith('■ lane A: '))) { await clearGate(t, 'A'); return true; }
        await pause(50);
      }
      return false;
    })();
    try {
      strictEqual(await t.run({}, { observeAsync, wakeIntervalMs: 300, quietMs: 3000 }), 2, t.lines.join('\n'));
      ok(await owner);
      ok(touchedAt !== null, 'the record was written while the marker waited');
      const a = t.latest().steps.find((x) => x.kind === 'commit');
      ok(a, 'A stepped once its record was quiet');
      ok(Date.parse(a.started_at) >= touchedAt + 2900, `A's commit started ${Date.parse(a.started_at) - touchedAt} ms after the write, not a whole quiet period`);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a worker group that outlived SIGKILL, ending while another step\'s marker waits for its lock, lets nothing start beside it', async () => {
    // A's dispatch is step 1; B's, step 2, waits for `go`, writes nothing and
    // leaves its group behind. A's dispatch ends only once B's has started, so
    // B's is step 2 and is running when A's commit is admitted: a lane created
    // after that admission would wait for the lock the owner holds below.
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT], file: 'b.txt' }, actions: { 1: ['stop-wait:bstarted'], 2: ['mark-start:bstarted', 'wait:go', 'noop'] } } });
    let bStarted = false;
    let bEnded = false;
    let startedBeforeHold = null;
    let releasedAfterB = null;
    const startWorker = (o) => {
      if (!/^\/orchestrator:next B /.test(o.prompt)) return W.startWorker(o);
      bStarted = true;
      const h = W.startWorker({ ...o, terminateGroup: async () => 'lingering' });
      h.done.then(() => { bEnded = true; });
      return h;
    };
    // A's commit admission (laneBusy's fourth question of A: its dispatch,
    // which created the lane, asked three times): the owner holds the park records' lock, B is let go, and the
    // lock goes only once B's worker has ended, while A's marker waits for it.
    let asked = 0;
    const laneBusy = (id) => {
      if (id === 'A' && (asked += 1) === 4) {
        startedBeforeHold = bStarted;
        const held = RL.acquireLock(lockOf(t), { record: { run_id: 'the owner' } });
        writeFileSync(join(t.dir, 'go'), '1');
        (async () => {
          const l = await held;
          for (let i = 0; i < 600 && !bEnded; i += 1) await pause(50);
          await pause(150);
          releasedAfterB = bEnded;
          l.release();
        })();
      }
      return false;
    };
    mkdirSync(PK.parksDir(t.work, t.fx.macroId), { recursive: true });
    // A's marker waits for the lock as long as the owner may hold it (up to
    // 30 s for B to end on a slow machine), not the run's 5 s.
    const wait = PK.setLockWaitMs(60_000);
    try {
      strictEqual(await t.run({}, { startWorker, laneBusy }), 2, t.lines.join('\n'));
      strictEqual(asked >= 4, true, 'A\'s commit was admitted');
      strictEqual(startedBeforeHold, true, 'B\'s worker had started when the owner took the lock');
      strictEqual(releasedAfterB, true, 'B\'s worker ended while A\'s marker waited');
      const r = t.latest();
      strictEqual(r.steps.find((x) => x.seq === 2)?.group_teardown, 'lingering');
      strictEqual(r.halt.reason, 'worker-failed');
      deepStrictEqual(stepsOf(r).filter((x) => x[2] === 'commit'), [], 'no worker started beside the group');
    } finally {
      PK.setLockWaitMs(wait);
      t.fx.cleanup();
    }
  });

  it('a tick while a busy refusal settles its marker does not lose the lane\'s retry: the step runs once the lane is quiet', async () => {
    const t = await setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [COMMIT], file: true } } });
    // The fingerprint the owner's lock entry carries, taken beforehand, so
    // the owner takes the lock at once, before the run's settlement asks.
    const self = await RL.processFingerprint(process.pid);
    // laneBusy's fifth question of A, the last before its commit's spawn
    // (its dispatch, which created the lane, asked three times, the commit
    // once before): busy, and the owner
    // then holds the park records' lock for 900 ms, so the refusal's marker
    // settlement waits through several ticks.
    let asked = 0;
    let heldAt = null;
    const laneBusy = (id) => {
      if (id !== 'A' || (asked += 1) !== 5) return false;
      RL.acquireLock(lockOf(t), { record: { run_id: 'the owner' }, selfFingerprint: self }).then((l) => {
        heldAt = Date.now();
        setTimeout(() => l.release(), 900);
      });
      return true;
    };
    mkdirSync(PK.parksDir(t.work, t.fx.macroId), { recursive: true });
    try {
      strictEqual(await t.run({}, { laneBusy, wakeIntervalMs: 100 }), 2, t.lines.join('\n'));
      ok(heldAt !== null && asked > 5, `the lane was asked again (${asked})`);
      const r = t.latest();
      deepStrictEqual(stepsOf(r).map((x) => [x[2], x[4]]), [['dispatch', 'ok'], ['commit', 'ok']], t.lines.join('\n'));
      strictEqual(r.halt.reason, 'awaiting-landing');
    } finally {
      t.fx.cleanup();
    }
  });

  it('a write to the lane\'s record while its creation\'s marker waits for its lock holds the creation until the quiet period has passed since', async () => {
    // A is in progress with no lane (dispatched by hand, its branch cut), its
    // next step the commit: the commit's admission creates the lane.
    const t = await setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [COMMIT], file: true } } });
    const a = await t.fx.dispatch('A', { checkout: false });
    t.git(t.work, 'branch', '--no-track', 'feat/a', 'refs/remotes/origin/main');
    await t.fx.finish(a.path, COMMIT);
    let touchedAt = null;
    let holding = false;
    // After the run's first decision look: the owner holds the park records'
    // lock, writes A's record while the creation's marker waits, then lets go.
    const push = t.lines.push.bind(t.lines);
    let started = false;
    t.lines.push = (line) => { if (/^ {2}lanes: up to /.test(line)) started = true; return push(line); };
    const observeAsync = async (o1, o2) => {
      const v = await OL.observeInChild(o1, o2);
      if (started && !holding && o1.repoRoot === t.work) {
        holding = true;
        const held = await RL.acquireLock(lockOf(t), { record: { run_id: 'the owner' } });
        setTimeout(() => {
          const now = new Date();
          utimesSync(a.path, now, now);
          touchedAt = now.getTime();
          setTimeout(() => held.release(), 100);
        }, 400);
      }
      return v;
    };
    mkdirSync(PK.parksDir(t.work, t.fx.macroId), { recursive: true });
    try {
      strictEqual(await t.run({}, { observeAsync, wakeIntervalMs: 300, quietMs: 3000 }), 2, t.lines.join('\n'));
      ok(touchedAt !== null, 'the record was written while the marker waited');
      const r = t.latest();
      const created = r.lanes.find((e) => e.event === 'created' && e.subtask_id === 'A');
      ok(created, JSON.stringify(r.lanes));
      ok(Date.parse(created.at) >= touchedAt + 2900, `A's lane was created ${Date.parse(created.at) - touchedAt} ms after the write, not a whole quiet period`);
      // Its step then ran there (what the scripted commit makes of a child
      // written by hand is not this test's).
      deepStrictEqual(stepsOf(r).map((x) => [x[1], x[2]]), [['A', 'commit']]);
    } finally {
      t.fx.cleanup();
    }
  });

  it('the run returns only once the park changes it queued are done: an interrupted step\'s marker is gone when it returns', async () => {
    const t = await setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [COMMIT], file: true }, actions: { 1: ['mark-start:a-started', 'wait:never'] } } });
    // Once A's worker has ended, the owner holds the park records' lock for
    // 3 s: the settlement of A's marker, which the interrupt's drain queues
    // and does not await, waits for it.
    let releasedAt = null;
    const startWorker = (o) => {
      const h = W.startWorker(o);
      h.done.then(async () => {
        const l = await RL.acquireLock(lockOf(t), { record: { run_id: 'the owner' } });
        setTimeout(() => { releasedAt = Date.now(); l.release(); }, 3000);
      });
      return h;
    };
    const owner = (async () => {
      for (let i = 0; i < 1200 && !existsSync(join(t.dir, 'a-started')); i += 1) await pause(50);
      t.signals.emit('SIGINT');
    })();
    mkdirSync(PK.parksDir(t.work, t.fx.macroId), { recursive: true });
    try {
      strictEqual(await t.run({}, { startWorker }), 2, t.lines.join('\n'));
      const returnedAt = Date.now();
      await owner;
      deepStrictEqual(PK.readParks(t.work, t.fx.macroId).records, [], 'the marker was settled before the run returned');
      ok(releasedAt !== null && returnedAt >= releasedAt, 'the run waited for the owner\'s lock');
      strictEqual(t.latest().halt.reason, 'interrupted');
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('a relaunch\'s kept park is judged from facts read after its digest', () => {
  it('a relaunch\'s kept park of a lane with no worktree wakes for a change after the facts it was judged from, while the other lane is mid-step', async () => {
    // A is in progress on its gate with no lane (dispatched by hand); B is pending.
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT], file: 'b.txt' } } });
    const a = await t.fx.dispatch('A', { checkout: false });
    // Its branch, as the dispatch cut it, checked out nowhere: the lane the
    // relaunch creates for its commit checks it out.
    t.git(t.work, 'branch', '--no-track', 'feat/a', 'refs/remotes/origin/main');
    await t.fx.eng.finishVerb({
      workflowPath: a.path, host: 'claude', nextAction: 'Owner decision', nextStep: { kind: 'owner-decision', confidence: 'HIGH' },
      ownerGate: { gate: GATE, anchor: 'routing-recommendation' }, env: { AGENTIC_AUTOPILOT: 'autopilot-20261001T000000Z-abcdef' },
    });
    try {
      // Run 1: A parks with no worktree; B is dispatched, and the budget ends the run.
      strictEqual(await t.run({ maxSteps: 1 }, { wakeIntervalMs: 300 }), 2, t.lines.join('\n'));
      const kept = PK.readPark(t.work, t.fx.macroId, 'A').record;
      deepStrictEqual([kept?.state, kept?.form], ['parked', 'no-worktree']);
      // Run 2: B's commit waits for A's step. The owner clears A's gate after
      // the run's first look and before its kept parks are read.
      writeFileSync(t.scen, JSON.stringify({ seqFromArgv: true, A: { next: [COMMIT], file: true }, B: { next: [COMMIT], file: 'b.txt' }, actions: { 1: ['mark-start:b-started', 'wait:a-resumed'], 2: 'mark-start:a-resumed' } }));
      const push = t.lines.push.bind(t.lines);
      let cleared = false;
      t.lines.push = (line) => {
        if (!cleared && /^ {2}lanes: up to /.test(line)) {
          cleared = true;
          execFileSync(process.execPath, [join(ENG, 'scripts', 'state.mjs'), 'awaiting-owner-clear', '--workflow-path', a.path, '--host', 'claude', '--gate', GATE,
            '--next-step-kind', 'commit', '--next-step-confidence', 'HIGH', '--resolution', 'the owner chose to commit'], { env: t.fx.env, encoding: 'utf8' });
        }
        return push(line);
      };
      t.lines.length = 0;
      strictEqual(await t.run({}, { wakeIntervalMs: 300 }), 2, t.lines.join('\n'));
      ok(cleared);
      ok(!existsSync(join(t.dir, 'a-resumed.timeout')), 'A stepped while B was still in its step');
      const r = t.latest();
      deepStrictEqual(stepsOf(r).map((x) => [x[1], x[2]]), [['B', 'commit'], ['A', 'commit']]);
    } finally {
      t.fx.cleanup();
    }
  });
});
