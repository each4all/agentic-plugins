// tests/orchestrator/test-autopilot-scheduler-releases-recovery.mjs
//
// ADR-0068 Decision 2, item 7, and implementation note I3 (impl-hold, Task 9)
// — what a crash or a lock leaves of a release, and how the run finishes it: a
// consumption stopped before its kept park's end is finished by the park the
// release recorded, never a newer one, and past the exclusion record of its
// dead driver; a release stopped before its fence went leaves no fence; a
// rejected lane held and released again in one run is consumed and stepped.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { setup, stepsOf } from './fixtures/autopilot-lanes-run.mjs';
import {
  BASIS, basisSeam, bounded, H, held, OPS, P, parkRecord, pause, release, releaseOf, RL, scenario, until,
} from './fixtures/autopilot-holds-run.mjs';

describe('what a stopped release leaves, finished by the run (ADR-0068 Decision 2, item 7; I3)', () => {
  it('a consumption stopped before its kept park\'s end is finished by the park the release recorded, and the lane steps', async () => {
    const t = await setup({ scenario: scenario() });
    try {
      const M = t.fx.macroId;
      const h = await held(t);
      const kept = parkRecord(t);
      strictEqual((await P.writePark(t.work, M, kept)).ok, true);
      await release(t, h, async () => BASIS);
      strictEqual(releaseOf(t).park_record_id, kept.record_id);
      // The crash: consumed written, the park's end pending.
      const rel = H.readRecord(t.work, M, 'releases', 'A');
      H.writeWhole(rel.path, { ...rel.record, state: 'consumed', compared_at: new Date().toISOString() });
      const seam = basisSeam(BASIS);
      strictEqual(await t.run({}, { releaseBasis: seam.fn }), 2, t.lines.join('\n'));
      strictEqual(seam.calls.length, 0, 'finished, not compared again');
      strictEqual(releaseOf(t).park_ended, true);
      strictEqual(P.readPark(t.work, M, 'A').state, 'absent', 'the recorded park ended');
      ok(stepsOf(t.latest()).some((s) => s[3] === 'A' && s[2] === 'dispatch'), JSON.stringify(stepsOf(t.latest())));
    } finally {
      t.fx.cleanup();
    }
  });

  it('a consumption whose recorded park was replaced by a newer one leaves the newer park standing', async () => {
    const t = await setup({ scenario: scenario() });
    try {
      const M = t.fx.macroId;
      const h = await held(t);
      const kept = parkRecord(t);
      strictEqual((await P.writePark(t.work, M, kept)).ok, true);
      await release(t, h, async () => BASIS);
      const newer = parkRecord(t, { detail: 'a newer park' });
      strictEqual((await P.writePark(t.work, M, newer, { expect: kept.record_id })).ok, true);
      strictEqual(await t.run({}, { releaseBasis: basisSeam(BASIS).fn }), 2, t.lines.join('\n'));
      strictEqual(releaseOf(t).state, 'consumed');
      strictEqual(releaseOf(t).park_ended, true);
      strictEqual(P.readPark(t.work, M, 'A').record?.record_id, newer.record_id, 'the newer park stands');
      deepStrictEqual(stepsOf(t.latest()).filter((s) => s[3] === 'A'), [], 'the lane waits on the newer park');
    } finally {
      t.fx.cleanup();
    }
  });

  it('a consumption a crash stopped is finished past the exclusion record its dead driver left: the record is swept, the lane stepped', async () => {
    const t = await setup({ scenario: scenario() });
    try {
      const M = t.fx.macroId;
      const h = await held(t);
      await release(t, h, async () => BASIS);
      const rel = H.readRecord(t.work, M, 'releases', 'A');
      H.writeWhole(rel.path, { ...rel.record, state: 'consumed', compared_at: new Date().toISOString() });
      // The comparison's exclusion record, its process gone.
      const dead = spawnSync(process.execPath, ['-e', '']).pid;
      H.publishOpRecord(t.work, M, 'A', {
        operation_id: 'op-20261026T000000Z-0000dead', kind: 'compare', subtask_id: 'A', workflow_id: null, persona: 'orchestrator',
        host: null, opened_at: '2026-10-26T00:00:00Z', pid: dead, fingerprint: { kind: 'test', value: 'gone' },
      });
      strictEqual(H.openOperations({ mainRoot: t.work, macroId: M, subtaskId: 'A', childPath: null }).open.length, 1);
      // Bounded: a lane the dead record kept busy would wait forever.
      strictEqual(await bounded(t, {}, { releaseBasis: basisSeam(BASIS).fn }), 2, t.lines.join('\n'));
      deepStrictEqual(H.readOps(t.work, M, 'A').ops, [], 'the dead exclusion record is swept');
      strictEqual(releaseOf(t).park_ended, true);
      ok(stepsOf(t.latest()).some((s) => s[3] === 'A' && s[2] === 'dispatch'), t.lines.join('\n'));
    } finally {
      t.fx.cleanup();
    }
  });

  it('a release a crash stopped before its fence went leaves no fence once the run compares it', async () => {
    const t = await setup({ scenario: scenario() });
    try {
      const M = t.fx.macroId;
      const laneDir = join(t.dir, 'held-lane');
      mkdirSync(laneDir);
      const h = await held(t, 'A', { lane: laneDir });
      strictEqual(RL.fenceState(laneDir, h.hold_id), 'present');
      await release(t, h, async () => BASIS);
      // The crash: the owner record released, the fence still there (I3).
      RL.writeFence({ laneRoot: laneDir, holdId: h.hold_id, subtaskId: 'A', macroId: M });
      strictEqual(RL.fenceState(laneDir, h.hold_id), 'present');
      strictEqual(await t.run({}, { releaseBasis: basisSeam(BASIS).fn }), 2, t.lines.join('\n'));
      strictEqual(releaseOf(t).state, 'consumed');
      strictEqual(RL.fenceState(laneDir, h.hold_id), 'absent', 'the leftover fence is removed');
    } finally {
      t.fx.cleanup();
    }
  });

  it('a rejected lane held and released again in the same run is consumed and stepped, its rejection\'s park ended', async () => {
    // B (seq 1) waits until A's step has started; A's release is rejected at
    // the run's start, and the second one is consumed while B's step runs.
    const t = await setup({ scenario: { ...scenario(), actions: { 1: ['mark-start:b-started', 'wait:a-started'], 2: ['mark-start:a-started'] } } });
    try {
      const M = t.fx.macroId;
      const h = await held(t);
      await release(t, h, async () => BASIS);
      let calls = 0;
      const seam = basisSeam(() => { calls += 1; return calls === 1 ? { ...BASIS, tree_digest: 'edited' } : BASIS; });
      const running = t.run({}, { releaseBasis: seam.fn });
      for (let i = 0; i < 600 && !existsSync(join(t.dir, 'b-started')); i += 1) await pause(50);
      ok(existsSync(join(t.dir, 'b-started')), 'B started');
      strictEqual(releaseOf(t).state, 'rejected');
      const rejectionPark = P.readPark(t.work, M, 'A').record.record_id;
      const h2 = await OPS.setHold({ mainRoot: t.work, macroId: M, subtaskId: 'A', branch: 'feat/a', lane: null, child: null });
      for (let i = 0; i < 200 && H.holdStateOf(t.work, M, 'A').state !== 'held'; i += 1) await pause(50);
      strictEqual(H.holdStateOf(t.work, M, 'A').state, 'held', 'the live run handed the lane over');
      await release(t, h2, async () => BASIS);
      strictEqual(releaseOf(t).park_record_id, rejectionPark);
      strictEqual(await running, 2, t.lines.join('\n'));
      ok(!existsSync(join(t.dir, 'a-started.timeout')), `A stepped while B's step ran\n${t.lines.join('\n')}`);
      strictEqual(releaseOf(t).state, 'consumed');
      ok(P.readPark(t.work, M, 'A').record?.record_id !== rejectionPark, 'the rejection\'s park ended');
      ok(t.lines.some((l) => /lane A: picked up again \(its release was consumed\)/.test(l)), t.lines.join('\n'));
    } finally {
      t.fx.cleanup();
    }
  });
});
