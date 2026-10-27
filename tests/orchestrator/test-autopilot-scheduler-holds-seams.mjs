// tests/orchestrator/test-autopilot-scheduler-holds-seams.mjs
//
// ADR-0068 Decision 2 (impl-hold) — the driver's seams the whole-change
// critique found: a hold set between the decision and the admission (at the
// creation's check, or after the lane was created) stops that lane only, and
// the wave goes on with the others; a created lane a hold then stops is kept,
// never removed; a lane held back by an open operation says which and how the
// owner clears it; a rejected release whose park the records cannot take
// never keeps the run from ending; a held lane whose kept park goes is not
// picked up; and a lane the relaunch passed by whose hold ends keeps the park
// that still stands.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { COMMIT, setup, stepsOf } from './fixtures/autopilot-lanes-run.mjs';
import {
  BASIS, bounded, H, held, laneEvents, OL, OPS, P, parkRecord, pause, release, RL, until,
} from './fixtures/autopilot-holds-run.mjs';

const scenario = () => ({ A: { next: [COMMIT], file: 'a.txt' }, B: { next: [COMMIT], file: 'b.txt' } });
// A hold of `id`, written as the owner's command writes it, in one
// synchronous write (from inside the driver's own synchronous check).
const holdNow = (t, id) => {
  const holdId = P.newRecordId();
  H.writeWhole(H.recordPath(t.work, t.fx.macroId, 'holds', id), {
    schema: 'agentic-hold-1', hold_id: holdId, subtask_id: id, branch: `feat/${id.toLowerCase()}`, lane: null, child: null,
    state: 'held', set_by: 'owner', set_at: new Date().toISOString(),
  });
  return holdId;
};
// The driver's laneBusy seam: nothing is open, and the `n`th look at `id`
// (1: the admission's first; 2: the creation's, after its marker) sets a hold.
const holdAtLook = (t, id, n) => {
  let looks = 0;
  return (sid) => {
    if (sid === id && (looks += 1) === n) holdNow(t, id);
    return false;
  };
};
const subtaskSteps = (t, id) => stepsOf(t.latest()).filter((s) => s[3] === id);

describe('a hold set between the decision and the admission (ADR-0068 Decision 2, item 3)', () => {
  it('set before the creation: no lane is created for it, and the wave goes on with the other lane', async () => {
    const t = await setup({ scenario: scenario() });
    try {
      strictEqual(await bounded(t, {}, { laneBusy: holdAtLook(t, 'A', 1) }), 2, t.lines.join('\n'));
      deepStrictEqual(subtaskSteps(t, 'A'), [], 'A never stepped');
      ok(subtaskSteps(t, 'B').some((s) => s[2] === 'commit'), `B went on: ${JSON.stringify(stepsOf(t.latest()))}\n${t.lines.join('\n')}`);
      ok(!existsSync(t.lane('A')), 'no lane was created for the held subtask');
    } finally {
      t.fx.cleanup();
    }
  });

  it('set after the lane was created: the step is not spawned, and the lane, unused, is kept for the owner', async () => {
    const t = await setup({ scenario: scenario() });
    try {
      strictEqual(await bounded(t, {}, { laneBusy: holdAtLook(t, 'A', 2) }), 2, t.lines.join('\n'));
      deepStrictEqual(subtaskSteps(t, 'A'), [], 'A never stepped');
      ok(existsSync(t.lane('A')), "the held subtask's lane is never removed");
      ok(t.lines.some((l) => /lane A/.test(l) && /created/.test(l)), t.lines.join('\n'));
      ok(subtaskSteps(t, 'B').some((s) => s[2] === 'commit'), `B went on: ${JSON.stringify(stepsOf(t.latest()))}`);
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('what the driver waits on is named (ADR-0068 Decision 1, item 6)', () => {
  it('a lane held back by an open persona operation names it, and the command that clears it', async () => {
    const t = await setup({ scenario: { ...scenario(), actions: { 2: ['mark-start:b-started'] } } });
    try {
      const M = t.fx.macroId;
      const op = 'op-20261026T000000Z-0000abce';
      H.publishOpRecord(t.work, M, 'A', { operation_id: op, kind: 'verb' });
      const push = t.lines.push.bind(t.lines);
      t.lines.push = (line) => {
        if (/lane B/.test(line) && existsSync(join(t.dir, 'b-started'))) {
          try { H.removeOpRecord(t.work, M, 'A', op); } catch { /* gone */ }
        }
        return push(line);
      };
      strictEqual(await bounded(t, {}, { quietMs: 1 }), 2, t.lines.join('\n'));
      const line = t.lines.find((l) => /lane A: waits: /.test(l));
      ok(line, t.lines.join('\n'));
      ok(line.includes(op) && line.includes(`agentic-autopilot writer-clear A --macro ${M} --operation ${op}`), line);
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('releases and parks at the run\'s edges (ADR-0068 Decision 2, items 7 and 11)', () => {
  it('a rejected release whose park the records cannot take is parked once, and the run still ends', async () => {
    const t = await setup({ scenario: scenario() });
    try {
      const M = t.fx.macroId;
      const h = await held(t);
      await release(t, h, async () => BASIS);
      const rel = H.readRecord(t.work, M, 'releases', 'A');
      H.writeWhole(rel.path, { ...rel.record, state: 'rejected', compared_at: new Date().toISOString() });
      // A park file no write can replace: a directory with something in it.
      const park = H.recordPath(t.work, M, 'parks', 'A');
      mkdirSync(join(park, 'x'), { recursive: true });
      strictEqual(await bounded(t, {}, {}, 60_000), 2, t.lines.join('\n'));
      deepStrictEqual(subtaskSteps(t, 'A'), [], 'the rejected lane never stepped');
      ok(t.lines.some((l) => /lane A: its park could not be kept/.test(l)), t.lines.join('\n'));
    } finally {
      t.fx.cleanup();
    }
  });

  it("a held lane's kept park that goes while the run lives does not pick the lane up", async () => {
    const t = await setup({ scenario: { ...scenario(), actions: { 1: ['mark-start:b-started', 'wait:park-gone'] } } });
    try {
      const M = t.fx.macroId;
      await held(t);
      const rec = parkRecord(t);
      ok((await P.writePark(t.work, M, rec, { expect: null })).ok);
      const running = bounded(t, {}, { wakeIntervalMs: 100, quietMs: 1 });
      ok(await until(() => existsSync(join(t.dir, 'b-started'))), 'B started');
      rmSync(P.parkPath(t.work, M, 'A'));
      // A few ticks see the park gone before B's step ends.
      await pause(600);
      writeFileSync(join(t.dir, 'park-gone'), '1');
      strictEqual(await running, 2, t.lines.join('\n'));
      ok(!t.lines.some((l) => /lane A: picked up again/.test(l)), t.lines.join('\n'));
      deepStrictEqual(laneEvents(t, t.latest()).filter((e) => e.subtask_id === 'A' && e.event === 'resumed'), []);
      deepStrictEqual(subtaskSteps(t, 'A'), []);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a lane the relaunch passed by whose hold ends keeps the park that still stands: it is not stepped', async () => {
    // Run 1: A's step runs, a hold is set during it, the run hands the lane
    // over (fenced); A's lane is a real worktree.
    const t = await setup({ scenario: { ...scenario(), actions: { 1: ['mark-start:a-started', 'wait:hold-set'] } } });
    try {
      const M = t.fx.macroId;
      const running = bounded(t);
      ok(await until(() => existsSync(join(t.dir, 'a-started'))), 'A started');
      const h = await OPS.setHold({ mainRoot: t.work, macroId: M, subtaskId: 'A', branch: 'feat/a', lane: t.lane('A'), child: null });
      writeFileSync(join(t.dir, 'hold-set'), '1');
      strictEqual(await running, 2, t.lines.join('\n'));
      strictEqual(H.holdStateOf(t.work, M, 'A').state, 'held');
      // A park of the lane's own, kept: nothing the hold's end resolves.
      const rec = parkRecord(t, { reason: 'worker-failed', detail: 'the worker failed', lane_path: t.lane('A') });
      ok((await P.writePark(t.work, M, rec, { expect: null })).ok);
      t.lines.length = 0;
      // Run 2: the hold ends without a release once reconciliation passed
      // the lane by (as a retirement ends it).
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
      deepStrictEqual(subtaskSteps(t, 'A'), [], `A's park stands: ${JSON.stringify(stepsOf(t.latest()))}`);
      strictEqual(P.readPark(t.work, M, 'A').record?.record_id, rec.record_id, 'the park is kept');
    } finally {
      t.fx.cleanup();
    }
  });
});

describe("a held lane's kept park is the owner's, not a lane mid-resolution (N7)", () => {
  it('the person working in it never keeps the run from ending: its changes reset no quiet clock', async () => {
    const { execFileSync } = await import('node:child_process');
    const t = await setup({ scenario: { ...scenario(), actions: { 2: ['mark:b-done'] } } });
    try {
      const M = t.fx.macroId;
      await held(t);
      ok((await P.writePark(t.work, M, parkRecord(t), { expect: null })).ok);
      const git = (...a) => execFileSync('git', ['-C', t.work, ...a], { env: t.fx.env, encoding: 'utf8' }).trim();
      // The person's work: once B's last step ran, A's branch moves to a new
      // commit every 150 ms (the lane's digest reads its tip), for up to 45 s
      // or until the run ends; a run that waited on it would end only after
      // the 45 s. Each tip is new: tips that came back to one already seen
      // would let a quiet clock read the same digest twice and end the run
      // (the alternation of two tips aliased with the quiet period).
      let done = false;
      let deadline = false;
      const churn = (async () => {
        while (!done && !existsSync(join(t.dir, 'b-done'))) await pause(50);
        const stop = Date.now() + 45_000;
        for (let i = 0; !done; i += 1) {
          if (Date.now() >= stop) { deadline = true; break; }
          git('branch', '-f', 'feat/a', git('commit-tree', 'HEAD^{tree}', '-m', `churn ${i}`));
          await pause(150);
        }
      })();
      const code = await bounded(t, {}, { quietMs: 1500, wakeIntervalMs: 100 }, 100_000);
      done = true;
      await churn;
      strictEqual(code, 2, t.lines.join('\n'));
      strictEqual(deadline, false, `the run ended while the person still worked in the held lane\n${t.lines.join('\n')}`);
      deepStrictEqual(subtaskSteps(t, 'A'), []);
    } finally {
      t.fx.cleanup();
    }
  });

  it("the run's end never takes a held lane's fingerprint (no look inside the owner's lane)", async () => {
    const t = await setup({ scenario: scenario() });
    try {
      const M = t.fx.macroId;
      await held(t);
      // A kept park whose fingerprint would read as changed, were it looked at.
      ok((await P.writePark(t.work, M, parkRecord(t, { fingerprint: 'stale', release_only: false }), { expect: null })).ok);
      let looks = 0;
      const code = await bounded(t, {}, {
        quietMs: 1,
        observeAsync: async (a, o) => {
          // A lane with no worktree is looked at through the driver's checkout, without a fetch.
          if (a.repoRoot === t.work && a.fetch === false) looks += 1;
          return OL.observeInChild(a, o);
        },
      });
      strictEqual(code, 2, t.lines.join('\n'));
      strictEqual(looks, 0, t.lines.join('\n'));
    } finally {
      t.fx.cleanup();
    }
  });
});
