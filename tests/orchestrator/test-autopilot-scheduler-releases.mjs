// tests/orchestrator/test-autopilot-scheduler-releases.mjs
//
// ADR-0068 Decision 2, item 7 (impl-hold, Task 9) — the driver's one
// comparison of a release before its lane steps: a release whose lane is
// unchanged is consumed, once, and the lane is stepped from the record; a lane
// that changed after its release is rejected for good (it parks owner-choice,
// is not compared again when the tree is put back, refuses a forced --next,
// and a run rebuilds its park when the park went); a forced --next on a
// released lane runs once it is compared; a new hold keeps an older
// uncompared release out of the comparison; a held lane's kept park is kept
// as it is. Recovery: test-autopilot-scheduler-releases-recovery.mjs; wake-ups:
// test-autopilot-scheduler-releases-wake.mjs.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { ROOTS, setup, stepsOf } from './fixtures/autopilot-lanes-run.mjs';
import {
  BASIS, basisSeam, bounded, H, held, laneEvents, OL, P, parkRecord, release, releaseOf, scenario,
} from './fixtures/autopilot-holds-run.mjs';

describe('the driver compares a release once before its lane steps (ADR-0068 Decision 2, item 7)', () => {
  it('an unchanged lane\'s release is consumed (real basis, off the loop): the lane is stepped, and a later run never compares it again', async () => {
    const t = await setup({ scenario: scenario() });
    try {
      const M = t.fx.macroId;
      const h = await held(t);
      // The basis as the driver's off-loop task takes it.
      const basisOf = (a) => OL.TASKS.releaseBasis({ ...a, mainRoot: t.work, macroId: M, subtaskId: 'A', roots: ROOTS }, t.env);
      await release(t, h, basisOf);
      strictEqual(H.holdStateOf(t.work, M, 'A').state, 'released-uncompared');
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      const r = t.latest();
      const rel = releaseOf(t);
      strictEqual(rel.state, 'consumed', t.lines.join('\n'));
      strictEqual(rel.park_ended, true);
      ok(stepsOf(r).some((s) => s[3] === 'A' && s[2] === 'dispatch'), `A stepped after its consumption: ${JSON.stringify(stepsOf(r))}`);
      deepStrictEqual(laneEvents(t, r).filter((e) => e.event === 'released').map((e) => [e.subtask_id, e.verdict]), [['A', 'consumed']]);
      // A relaunch: the lane's later progress is never compared with it.
      const comparedAt = rel.compared_at;
      const seam = basisSeam(BASIS);
      await t.run({}, { releaseBasis: seam.fn });
      strictEqual(seam.calls.length, 0, 'a consumed release is not compared again');
      strictEqual(releaseOf(t).compared_at, comparedAt);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a lane changed after its release is rejected: it parks owner-choice, is never stepped, and the other lane goes on', async () => {
    const t = await setup({ scenario: scenario() });
    try {
      const M = t.fx.macroId;
      const h = await held(t);
      await release(t, h, async () => BASIS);
      const seam = basisSeam({ ...BASIS, tree_digest: 'edited after the release' });
      strictEqual(await t.run({}, { releaseBasis: seam.fn }), 2, t.lines.join('\n'));
      deepStrictEqual(seam.calls, ['A'], 'compared once');
      const r = t.latest();
      strictEqual(releaseOf(t).state, 'rejected');
      deepStrictEqual(stepsOf(r).filter((s) => s[3] === 'A'), [], 'A never stepped');
      ok(stepsOf(r).some((s) => s[3] === 'B' && s[2] === 'commit'), 'B went on');
      const park = P.readPark(t.work, M, 'A');
      strictEqual(park.state, 'ok');
      strictEqual(park.record.reason, 'owner-choice');
      strictEqual(park.record.rejected_release, releaseOf(t).release_id);
      ok(/changed after its release/.test(park.record.detail));
      ok(/hold the lane and release it again: agentic-autopilot hold A/.test(park.record.resolution.change), JSON.stringify(park.record.resolution));
      deepStrictEqual(laneEvents(t, r).filter((e) => e.event === 'released').map((e) => [e.subtask_id, e.verdict]), [['A', 'rejected']]);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a rejected release is not compared again once the tree is put back, its park is rebuilt when it went, and a forced --next on it is refused', async () => {
    const t = await setup({ scenario: scenario() });
    try {
      const M = t.fx.macroId;
      const h = await held(t);
      await release(t, h, async () => BASIS);
      strictEqual(await t.run({}, { releaseBasis: basisSeam({ ...BASIS, content_digest: 'changed' }).fn }), 2, t.lines.join('\n'));
      strictEqual(releaseOf(t).state, 'rejected');
      // The tree put back: the basis is equal again. Never compared.
      const back = basisSeam(BASIS);
      strictEqual(await t.run({}, { releaseBasis: back.fn }), 2, t.lines.join('\n'));
      strictEqual(back.calls.length, 0);
      strictEqual(releaseOf(t).state, 'rejected');
      deepStrictEqual(stepsOf(t.latest()).filter((s) => s[3] === 'A'), []);
      // The park gone: the rejection alone keeps the lane, and the run parks it again.
      const first = P.readPark(t.work, M, 'A').record.record_id;
      await P.deletePark(t.work, M, 'A', { expect: first, event: 'test' });
      strictEqual(await t.run({}, { releaseBasis: back.fn }), 2, t.lines.join('\n'));
      deepStrictEqual(stepsOf(t.latest()).filter((s) => s[3] === 'A'), []);
      const again = P.readPark(t.work, M, 'A');
      strictEqual(again.state, 'ok');
      strictEqual(again.record.rejected_release, releaseOf(t).release_id);
      ok(again.record.record_id !== first, 'rebuilt');
      // A forced --next on the lane: refused, nothing starts, the park stays.
      // Bounded: a forced step on a lane its park keeps would wait forever.
      t.lines.length = 0;
      const code = await bounded(t, { forcedPairs: [{ lane: 'A', step: { kind: 'dispatch', subtaskId: 'A' } }] }, { releaseBasis: back.fn });
      strictEqual(code, 2, t.lines.join('\n'));
      deepStrictEqual(stepsOf(t.latest()).filter((s) => s[3] === 'A'), []);
      ok(t.lines.some((l) => /--next does not apply: .*rejected.*hold and release it again/.test(l)), t.lines.join('\n'));
      strictEqual(P.readPark(t.work, M, 'A').record.record_id, again.record.record_id);
      strictEqual(back.calls.length, 0);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a new hold keeps an older uncompared release out of the comparison while it holds the lane', async () => {
    const t = await setup({ scenario: scenario() });
    try {
      const M = t.fx.macroId;
      const h = await held(t);
      await release(t, h, async () => BASIS);
      const older = releaseOf(t);
      await held(t);
      strictEqual(releaseOf(t).release_id, older.release_id, 'the uncompared release is kept');
      const seam = basisSeam(BASIS);
      strictEqual(await t.run({}, { releaseBasis: seam.fn }), 2, t.lines.join('\n'));
      strictEqual(seam.calls.length, 0);
      strictEqual(releaseOf(t).state, 'uncompared');
      strictEqual(H.holdStateOf(t.work, M, 'A').state, 'held');
      deepStrictEqual(stepsOf(t.latest()).filter((s) => s[3] === 'A'), []);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a forced --next on a released lane runs once its release is compared, at the run\'s start', async () => {
    const t = await setup({ scenario: scenario() });
    try {
      const h = await held(t);
      await release(t, h, async () => BASIS);
      const code = await t.run({ forcedPairs: [{ lane: 'A', step: { kind: 'dispatch', subtaskId: 'A' } }] }, { releaseBasis: basisSeam(BASIS).fn });
      strictEqual(code, 2, t.lines.join('\n'));
      strictEqual(releaseOf(t).state, 'consumed');
      ok(stepsOf(t.latest()).some((s) => s[3] === 'A' && s[2] === 'dispatch'), t.lines.join('\n'));
      ok(!t.lines.some((l) => /--next does not apply/.test(l)), t.lines.join('\n'));
    } finally {
      t.fx.cleanup();
    }
  });

  it('a held lane\'s kept park is kept as it is while held, never compared, however its record changed', async () => {
    const t = await setup({ scenario: scenario() });
    try {
      const M = t.fx.macroId;
      await held(t);
      // A park taken before the hold, at a fingerprint the lane no longer has.
      const kept = parkRecord(t, { fingerprint: 'stale', release_only: false });
      strictEqual((await P.writePark(t.work, M, kept)).ok, true);
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      strictEqual(P.readPark(t.work, M, 'A').record?.record_id, kept.record_id, t.lines.join('\n'));
      deepStrictEqual(stepsOf(t.latest()).filter((s) => s[3] === 'A'), []);
    } finally {
      t.fx.cleanup();
    }
  });
});
