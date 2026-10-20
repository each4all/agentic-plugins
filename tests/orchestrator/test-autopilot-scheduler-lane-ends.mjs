// tests/orchestrator/test-autopilot-scheduler-lane-ends.mjs
//
// ADR-0068 Decision 1 — how a run with lanes ends beside its parked lanes,
// end to end with no model (fixtures/autopilot-lanes-run.mjs).
//
// This file: the run-wide causes still drain the run beside a parked lane
// (version drift, an exhausted budget), and a baseline fetch failing inside a
// lane's creation drains and keeps no park; a driver killed between a failed
// step's end and its verdict leaves a relaunch that parks the lane instead of
// dispatching it; the end's last pass picks up a lane whose record changed
// with no wake-up; a release as the run ends is not lost. The approval and
// the interrupt are in test-autopilot-scheduler.mjs.

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AP, COMMIT, CRITIQUE, markOn, setup, stepsOf } from './fixtures/autopilot-lanes-run.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const CHILD = resolve(REPO_ROOT, 'tests/orchestrator/fixtures/autopilot-lanes-child.mjs');
const PK = await import(resolve(AP, 'parks.mjs'));
const RT = await import(resolve(AP, 'roots.mjs'));
const OL = await import(resolve(AP, 'offloop.mjs'));
const W = await import(resolve(AP, 'worker.mjs'));
const GATE = 'scope-routing';

describe('run-wide causes still drain beside a parked lane', () => {
  for (const [cause, opts, deps] of [
    ['version-drift', {}, (t) => ({
      resolveRoots: async (o) => {
        const r = await RT.resolveRoots(o);
        return existsSync(join(t.dir, 'drift')) ? { ...r, versions: { ...r.versions, engineer: '99.0.0' } } : r;
      },
    })],
    ['budget', { maxSteps: 2 }, () => ({})],
    // A gate on the macro itself. A macro gate is valid only on a plan pending
    // approval again (orchestrator state.mjs), so it drains as the approval
    // that no longer holds. Written by hand as B's dispatch is settled,
    // before the next decision's look.
    ['plan-unapproved', {}, (t) => {
      const push = t.lines.push.bind(t.lines);
      let gated = false;
      t.lines.push = (line) => {
        if (!gated && /^ {4}\[2\] lane B exit=/.test(line)) {
          gated = true;
          const text = readFileSync(t.fx.macroPath, 'utf8');
          if (!/^plan_approval_status: "approved"$/m.test(text)) throw new Error('the fixture\'s macro is not approved as this case expects');
          writeFileSync(t.fx.macroPath, text.replace(/^plan_approval_status: "approved"$/m, 'plan_approval_status: "pending"')
            .replace(/^plan_approval_(approved_at|plan_hash): .*\n/gm, '')
            .replace(/^---\n/, `---\nawaiting_owner_gate: "plan-conflict"\nawaiting_owner_pointer: "${t.fx.macroId}.md#macro-plan"\nawaiting_owner_since: "${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}"\n`));
        }
        return push(line);
      };
      return {};
    }],
  ]) {
    it(`${cause}: the run drains whatever is parked; the drain is the reason, the park is listed beside it and kept`, async () => {
      // A's dispatch stops on a gate (A parks); B's dispatch is the run's
      // second step, which ends once A is parked, and after which the cause holds.
      const t = await setup({ scenario: { A: { next: [COMMIT] }, B: { next: [COMMIT], file: 'b.txt' }, actions: { 1: `gate:${GATE}`, 2: ['stop-wait:a-parked', 'mark:drift'] } } });
      markOn(t, /^■ lane A: awaiting-owner/, 'a-parked');
      try {
        strictEqual(await t.run(opts, { wakeIntervalMs: 300, ...deps(t) }), 2, t.lines.join('\n'));
        const r = t.latest();
        deepStrictEqual(stepsOf(r).map((x) => [x[1], x[2], x[4]]).sort(), [['A', 'dispatch', 'ok'], ['B', 'dispatch', 'ok']], 'B\'s commit never started');
        strictEqual(r.halt.reason, cause);
        if (cause === 'plan-unapproved') match(r.halt.detail, /pending approval \(plan-conflict\)/);
        deepStrictEqual(r.halt.also.filter((x) => x.parked).map((x) => [x.subtask_id, x.reason]), [['A', `awaiting-owner:${GATE}`]]);
        strictEqual(PK.readPark(t.work, t.fx.macroId, 'A').record?.state, 'parked', 'a drain keeps the park');
      } finally {
        t.fx.cleanup();
      }
    });
  }

  it('a baseline fetch failing inside a lane\'s creation drains the run and keeps no park', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT] }, B: { next: [COMMIT] } } });
    let broken = false;
    // The baseline goes away between the reconciliation and A's creation.
    const offLoop = (task, args, o) => {
      if (task === 'createLane' && !broken) {
        broken = true;
        t.git(t.work, 'remote', 'set-url', 'origin', join(t.dir, 'no-such-origin'));
        t.git(t.work, 'update-ref', '-d', 'refs/remotes/origin/main');
      }
      return OL.offLoop(task, args, o);
    };
    try {
      strictEqual(await t.run({}, { offLoop }), 2, t.lines.join('\n'));
      ok(broken);
      const r = t.latest();
      deepStrictEqual(r.steps, []);
      strictEqual(r.halt.reason, 'owner-choice');
      match(r.halt.detail, /no refs\/remotes\/origin\/main to cut or check a lane against/);
      ok(!t.lines.some((l) => /other lanes continue/.test(l)), 'not a park of A');
      deepStrictEqual(PK.readParks(t.work, t.fx.macroId).records, [], 'no park is kept, nor its creation\'s marker');
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('a worker group that outlived SIGKILL drains the run, whatever its look', () => {
  it('a lingering group whose lane look fails drains the run instead of parking its lane', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT] }, B: { next: [COMMIT], file: 'b.txt' }, actions: { 2: 'stop-wait:a-ended' } } });
    markOn(t, /^ {4}\[1\] lane A exit=/, 'a-ended');
    // A's worker leaves its group behind (the teardown's answer), and every
    // look of A's lane after its creation fails.
    const startWorker = (o) => W.startWorker(/^\/orchestrator:next A /.test(o.prompt) ? { ...o, terminateGroup: async () => 'lingering' } : o);
    let aLooks = 0;
    const observeAsync = async (a, o) => {
      if (a.repoRoot === t.lane('A') && (aLooks += 1) > 1) return { lookError: 'injected: the look failed' };
      return OL.observeInChild(a, o);
    };
    try {
      strictEqual(await t.run({}, { startWorker, observeAsync }), 2, t.lines.join('\n'));
      const r = t.latest();
      strictEqual(r.steps.find((x) => x.seq === 1)?.group_teardown, 'lingering');
      deepStrictEqual([r.halt.reason, r.halt.subtask_id ?? null], ['worker-failed', 'A']);
      match(r.halt.detail, /still there after SIGKILL/);
      ok(!t.lines.some((l) => /other lanes continue/.test(l)), 'no lane parked');
      deepStrictEqual(PK.readParks(t.work, t.fx.macroId).records, [], 'nothing kept');
      ok(!stepsOf(r).some((x) => x[1] === 'B' && x[2] === 'commit'), 'nothing new started beside the group');
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('a park is never lost to a crash', () => {
  it('a driver killed between a failed step\'s end and its verdict leaves a relaunch that parks the lane instead of dispatching it', async () => {
    // A's dispatch writes nothing, then kills its driver before reporting.
    const t = await setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [COMMIT] }, actions: { 1: ['noop', 'kill-driver'] } } });
    try {
      const driver = spawn(process.execPath, [CHILD, t.work, t.fx.macroId], { env: t.env, stdio: 'ignore' });
      const ended = await new Promise((r) => { driver.on('exit', (code, signal) => r(signal ?? code)); });
      strictEqual(ended, 'SIGKILL');
      const dead = t.latest();
      deepStrictEqual(dead.steps.map((x) => [x.seq, x.kind, x.outcome ?? null]), [[1, 'dispatch', null]], 'the step has no verdict');
      const marker = PK.readPark(t.work, t.fx.macroId, 'A').record;
      deepStrictEqual([marker?.state, marker?.seq, marker?.run_id], ['in-flight', 1, dead.run.run_id]);
      // The relaunch judges the marker from the dead run's ledger.
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(r.steps, [], 'A is not dispatched again on its unchanged record');
      deepStrictEqual([r.halt.reason, r.halt.subtask_id], ['owner-choice', 'A']);
      match(r.halt.detail, new RegExp(`step 1 of run ${dead.run.run_id} \\(dispatch\\) ended with no verdict`));
      strictEqual(PK.readPark(t.work, t.fx.macroId, 'A').record?.state, 'parked');
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('a park is never lost to a crash, nor ended by a look that could not be read', () => {
  it('a driver killed during a later step of a lane that already exists leaves a relaunch that parks the lane instead of stepping it again', async () => {
    const t = await setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [CRITIQUE, COMMIT], file: true }, actions: { 2: ['noop', 'kill-driver'] } } });
    try {
      const driver = spawn(process.execPath, [CHILD, t.work, t.fx.macroId], { env: t.env, stdio: 'ignore' });
      strictEqual(await new Promise((r) => { driver.on('exit', (code, signal) => r(signal ?? code)); }), 'SIGKILL');
      const dead = t.latest();
      deepStrictEqual(dead.steps.map((x) => [x.seq, x.kind, x.outcome ?? null]), [[1, 'dispatch', 'ok'], [2, 'verb', null]]);
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(r.steps, [], 'the critique is not run again on the unchanged record');
      match(r.halt.detail, new RegExp(`step 2 of run ${dead.run.run_id} \\(verb\\) ended with no verdict`));
    } finally {
      t.fx.cleanup();
    }
  });

  it('a relaunch whose look of a parked lane cannot read the macro keeps the park: no step is retried on its unchanged record', async () => {
    let attempts = 0;
    const failing = (o) => {
      if (/^\/orchestrator:next A /.test(o.prompt)) { attempts += 1; throw new Error('injected: the worker could not start'); }
      return W.startWorker(o);
    };
    const t = await setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [COMMIT] } } });
    try {
      strictEqual(await t.run({}, { startWorker: failing }), 2, t.lines.join('\n'));
      strictEqual(attempts, 1);
      let broken = false;
      const observeAsync = async (a, o) => {
        const v = await OL.observeInChild(a, o);
        if (broken || a.repoRoot !== t.lane('A')) return v;
        broken = true;
        return { ...v, macro: null, macroLookupError: 'simulated: the macro could not be read', children: {} };
      };
      strictEqual(await t.run({}, { startWorker: failing, observeAsync }), 2, t.lines.join('\n'));
      ok(broken, 'the relaunch looked at the parked lane');
      deepStrictEqual([attempts, t.latest().halt.reason], [1, 'worker-failed']);
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('when the run ends', () => {
  it('a park whose cause lies outside its record waits for a release only: the run ends beside it, its looks failing', async () => {
    const t = await setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [COMMIT], file: true }, actions: { 1: 'mark:break' } } });
    // Every look of A's lane fails once its step has run: the park's
    // fingerprint cannot be read, so only a release resumes it.
    const observeAsync = async (a, o) => (existsSync(join(t.dir, 'break')) && a.repoRoot === t.lane('A')
      ? { ...(await OL.observeInChild(a, o)), lookError: 'injected', macro: null, children: {} }
      : OL.observeInChild(a, o));
    // A run that would never end is stopped, and its halt says so.
    const guard = setTimeout(() => t.signals.emit('SIGINT'), 45_000);
    try {
      const t0 = Date.now();
      strictEqual(await t.run({}, { observeAsync }), 2, t.lines.join('\n'));
      clearTimeout(guard);
      ok(Date.now() - t0 < 45_000, `the run ended by itself (${Date.now() - t0} ms)`);
      const r = t.latest();
      deepStrictEqual([r.halt.reason, r.halt.subtask_id], ['owner-choice', 'A']);
      strictEqual(PK.readPark(t.work, t.fx.macroId, 'A').record?.release_only, true);
    } finally {
      clearTimeout(guard);
      t.fx.cleanup();
    }
  });

  it('a parked lane whose record changed, but whose looks now fail, is not asked again at every tick: the run ends', async () => {
    const t = await setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [COMMIT], file: true }, actions: { 1: `gate:${GATE}` } } });
    let broken = false;
    // Once A is parked on its gate: its record changes, and every look of its
    // lane fails from then on.
    const push = t.lines.push.bind(t.lines);
    t.lines.push = (line) => {
      if (!broken && line.startsWith('■ lane A: ')) {
        broken = true;
        const p = readFileSync(join(t.dir, 'child-A.path'), 'utf8');
        writeFileSync(p, `${readFileSync(p, 'utf8')}\n`);
      }
      return push(line);
    };
    const observeAsync = async (a, o) => (broken && a.repoRoot === t.lane('A')
      ? { ...(await OL.observeInChild(a, o)), lookError: 'injected' }
      : OL.observeInChild(a, o));
    // A run that would never end is stopped, and its halt says so.
    const guard = setTimeout(() => t.signals.emit('SIGINT'), 45_000);
    try {
      const t0 = Date.now();
      strictEqual(await t.run({}, { observeAsync }), 2, t.lines.join('\n'));
      clearTimeout(guard);
      ok(broken);
      ok(Date.now() - t0 < 45_000, `the run ended by itself (${Date.now() - t0} ms)`);
      const r = t.latest();
      deepStrictEqual([r.halt.reason, r.halt.subtask_id], [`awaiting-owner:${GATE}`, 'A']);
      deepStrictEqual(r.steps.length, 1);
    } finally {
      clearTimeout(guard);
      t.fx.cleanup();
    }
  });

  it('the end\'s last pass picks up a parked lane whose record changed with no wake-up', async () => {
    // A's dispatch stops on a gate (A parks); the owner clears it while B's
    // dispatch runs, and no tick fires during the run to see it.
    const t = await setup({
      scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT], file: 'b.txt' }, actions: { 1: `gate:${GATE}`, 2: ['mark-start:b-started', 'wait:cleared'] } },
    });
    const owner = (async () => {
      for (let i = 0; i < 1200; i += 1) {
        if (existsSync(join(t.dir, 'b-started')) && t.lines.some((l) => l.startsWith('■ lane A: '))) {
          const workflowPath = readFileSync(join(t.dir, 'child-A.path'), 'utf8');
          await t.fx.eng.clearAwaitingOwner({ workflowPath, host: 'claude', gate: GATE, nextStep: COMMIT, nextAction: 'Commit the change', resolution: 'the owner chose to commit', env: t.fx.env });
          writeFileSync(join(t.dir, 'cleared'), '1');
          return true;
        }
        await new Promise((r) => { setTimeout(r, 50); });
      }
      return false;
    })();
    try {
      strictEqual(await t.run({}, { wakeIntervalMs: 3_600_000, quietMs: 200 }), 2, t.lines.join('\n'));
      ok(await owner);
      const r = t.latest();
      const a = stepsOf(r).filter((x) => x[1] === 'A').map((x) => [x[2], x[4]]);
      deepStrictEqual(a, [['dispatch', 'ok'], ['commit', 'ok']]);
      // No tick fired, so only the end's last pass could pick it up.
      ok(t.lines.some((l) => /^ {2}lane A: picked up again \(its record changed\)/.test(l)), t.lines.join('\n'));
      strictEqual(r.halt.reason, 'awaiting-landing');
    } finally {
      t.fx.cleanup();
    }
  });

  it('a serial run does not start beside a kept park; a park of a subtask the plan does not hold does not count', async () => {
    const t = await setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [COMMIT] } } });
    try {
      const rec = { schema: PK.PARK_SCHEMA, record_id: PK.newRecordId(), macro_id: t.fx.macroId, subtask_id: 'A', state: 'parked', reason: 'worker-failed', detail: 'the worker could not start', run_id: 'autopilot-20261001T000000Z-123456' };
      ok((await PK.writePark(t.work, t.fx.macroId, rec)).ok);
      strictEqual(await t.run({ lanes: 1 }), 1, t.lines.join('\n'));
      ok(t.lines.some((l) => /keeps 1 parked lane \(A: worker-failed .*a serial run does not start beside a kept park\. Release each \(.*release A --macro /.test(l)), t.lines.join('\n'));
      ok((await PK.writePark(t.work, t.fx.macroId, { ...rec, subtask_id: 'Z', record_id: PK.newRecordId() })).ok);
      ok((await PK.deletePark(t.work, t.fx.macroId, 'A', { event: 'released' })).ok);
      t.lines.length = 0;
      strictEqual(await t.run({ lanes: 1, maxSteps: 1 }), 2, t.lines.join('\n'));
      ok(!t.lines.some((l) => /kept park/.test(l)), 'a park of a subtask the plan does not hold retires');
    } finally {
      t.fx.cleanup();
    }
  });

  it('a release as the run ends is not lost: the ending run never recreates the park, and the next run judges the lane afresh', async () => {
    const t = await setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [COMMIT] }, actions: { 1: `gate:${GATE}` } } });
    const push = t.lines.push.bind(t.lines);
    let released = false;
    t.lines.push = (line) => {
      // The owner's release, after the run's last consumption, before its
      // end: what it leaves on disk, at once (a line is printed synchronously).
      if (/^■ halted: /.test(line) && !released && PK.readPark(t.work, t.fx.macroId, 'A').state === 'ok') {
        rmSync(PK.parkPath(t.work, t.fx.macroId, 'A'));
        released = true;
      }
      return push(line);
    };
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      ok(released);
      deepStrictEqual(PK.readPark(t.work, t.fx.macroId, 'A'), { state: 'absent' }, 'not recreated');
      t.lines.length = 0;
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      ok(t.lines.some((l) => l.startsWith(`■ lane A: awaiting-owner:${GATE} — `)), t.lines.join('\n'));
      ok(!t.lines.some((l) => /kept since run/.test(l)), 'judged afresh, not from a kept park');
      strictEqual(PK.readPark(t.work, t.fx.macroId, 'A').record?.state, 'parked');
    } finally {
      t.fx.cleanup();
    }
  });
});
