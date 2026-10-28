// tests/orchestrator/test-autopilot-events-lanes.mjs
//
// ADR-0068 Decision 4 — what a run with lanes publishes in its event file
// (scheduler.mjs over the driver's writer), end to end with no model
// (fixtures/autopilot-lanes-run.mjs). A lane's park and its resumption, a
// hold handed over, a release compared (consumed, rejected, or consumed by a
// comparison whose park's end failed), a commit reported, a step that failed,
// and each way the run ends (a drain, every lane left waiting, a refused
// forced step, an interrupt): each event once, beside its record, with its
// kind's fields only, and nothing after the run's `run-ended`.
// Each `lane-resumed` cause from the path that resumes the lane (a code each
// caller names, never read from the lanes.jsonl wording); the step-failed of a
// step the run's error meets while it is settled; and a driver whose stdout
// and stderr are a closed pipe, which runs to its end and exits with its
// run-ended's code.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { AP, COMMIT, markOn, setup, stepsOf } from './fixtures/autopilot-lanes-run.mjs';
import { BASIS, basisSeam, bounded, H, held, OPS, P, parkRecord, release, releaseOf, RL, scenario } from './fixtures/autopilot-holds-run.mjs';

const E = await import(resolve(AP, 'events.mjs'));
const LR = await import(resolve(AP, 'landing-ready.mjs'));
const L = await import(resolve(AP, 'ledger.mjs'));
const RT = await import(resolve(AP, 'roots.mjs'));
const { observeInChild } = await import(resolve(AP, 'offloop.mjs'));
const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });
const GATE = 'scope-routing';
const HEAD = ['schema', 'run_id', 'seq', 'at', 'kind', 'macro_id', 'subtask_id'];
const KEYS = {
  'run-started': [...HEAD, 'lanes', 'detector', 'run_dir', 'pointer'],
  halt: [...HEAD, 'reason', 'step', 'pointer', 'step_record'],
  'lane-parked': [...HEAD, 'reason', 'step', 'kept', 'pointer'],
  'lane-resumed': [...HEAD, 'cause', 'pointer'],
  'lane-held': [...HEAD, 'hold_id', 'pointer'],
  'lane-released': [...HEAD, 'hold_id', 'release_id', 'verdict', 'pointer'],
  'step-failed': [...HEAD, 'step', 'reason', 'abort', 'pointer'],
  'commit-finished': [...HEAD, 'step', 'commit', 'readiness', 'pointer'],
  'run-ended': [...HEAD, 'status', 'reason', 'exit', 'pointer', 'cleanup', 'terminal'],
};

// The run's lines: each with exactly its kind's keys, its seq rising from 1,
// pointing at a file that exists; run-started first, run-ended last and once.
function linesOf(t, r) {
  const file = E.eventsPath({ mainRoot: t.work, macroId: t.fx.macroId, checkout: t.work });
  const all = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const mine = all.filter((e) => e.run_id === r.run.run_id);
  mine.forEach((e, i) => {
    deepStrictEqual(Object.keys(e), KEYS[e.kind], e.kind);
    strictEqual(e.seq, i + 1);
    // A kept park ends when its lane is picked up again: it existed then.
    const ended = e.kind === 'lane-parked' && mine.slice(i).some((x) => x.kind === 'lane-resumed' && x.subtask_id === e.subtask_id);
    if (!ended) ok(existsSync(e.pointer), `${e.kind} points at ${e.pointer}, which exists`);
  });
  strictEqual(mine[0].kind, 'run-started');
  deepStrictEqual([mine[0].lanes, mine[0].run_dir], [2, r.dir]);
  strictEqual(mine.at(-1).kind, 'run-ended', 'nothing after the run\'s run-ended');
  strictEqual(mine.filter((e) => e.kind === 'run-ended').length, 1);
  return mine;
}
// What run.json held as each halt line was written: [reason, status, the
// recorded halt's reason], read at the write itself (the writer's seam).
function haltWatch() {
  const seen = [];
  const eventsWriteSync = (fd, buf, off, len) => {
    for (const raw of buf.toString('utf8', off, off + len).split('\n')) {
      let e = null;
      try { e = JSON.parse(raw); } catch { /* a lead newline */ }
      if (e?.kind !== 'halt') continue;
      const run = JSON.parse(readFileSync(e.pointer, 'utf8'));
      seen.push([e.reason, run.status, run.halt?.reason ?? null]);
    }
    return writeSync(fd, buf, off, len);
  };
  return { seen, deps: { eventsWriteSync } };
}
const kinds = (ls, id) => ls.filter((e) => id === undefined || e.subtask_id === id).map((e) => e.kind);
// The halts the run published, and how it ended.
const ending = (ls) => [ls.filter((e) => e.kind === 'halt').map((e) => [e.reason, e.subtask_id]), [ls.at(-1).status, ls.at(-1).reason, ls.at(-1).exit]];

async function clearGate(t, id) {
  const workflowPath = readFileSync(join(t.dir, `child-${id}.path`), 'utf8');
  await t.fx.eng.clearAwaitingOwner({
    workflowPath, host: 'claude', gate: GATE, nextStep: COMMIT, nextAction: 'Commit the change', resolution: 'the owner chose to commit', env: t.fx.env,
  });
}

describe('a lane\'s park and its pickup (ADR-0068 Decision 4, item 3)', () => {
  it('a gate parks its lane (kept, pointing at the park) and every lane left waiting ends the run with its halt', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT] }, B: { next: [COMMIT], file: 'b.txt' }, actions: { 1: `gate:${GATE}` } } });
    const w = haltWatch();
    try {
      strictEqual(await t.run({}, w.deps), 2, t.lines.join('\n'));
      const r = t.latest();
      const ls = linesOf(t, r);
      const parked = ls.filter((e) => e.kind === 'lane-parked');
      deepStrictEqual(parked.map((e) => [e.subtask_id, e.reason, e.kept, e.pointer]), [['A', `awaiting-owner:${GATE}`, true, P.parkPath(t.work, t.fx.macroId, 'A')]]);
      deepStrictEqual(ending(ls), [[[`awaiting-owner:${GATE}`, 'A']], ['halted', `awaiting-owner:${GATE}`, 2]]);
      // The halt that ends the run is published once run.json records it.
      deepStrictEqual(w.seen, [[`awaiting-owner:${GATE}`, 'halted', `awaiting-owner:${GATE}`]]);
      strictEqual(ls.at(-1).pointer, join(r.dir, 'halt.json'));
      // B's commit, once, its readiness the report's.
      const commits = ls.filter((e) => e.kind === 'commit-finished');
      deepStrictEqual(commits.map((e) => [e.subtask_id, e.step, e.commit]), [['B', 3, t.git(t.work, 'rev-parse', 'refs/heads/feat/b')]]);
      ok([join(r.dir, 'landing.jsonl'), LR.landingLogPath(t.work, t.fx.macroId)].includes(commits[0].pointer), commits[0].pointer);
      ok(!readFileSync(E.eventsPath({ mainRoot: t.work, macroId: t.fx.macroId, checkout: t.work }), 'utf8').includes(r.halt.detail), 'no halt detail');
    } finally {
      t.fx.cleanup();
    }
  });

  it('a record write of the run\'s end that throws: the error path publishes the recorded halt, then run-ended error', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT] }, B: { next: [COMMIT], file: 'b.txt' }, actions: { 1: `gate:${GATE}` } } });
    // halt.json is a directory once the run holds its locks: finish's writeHalt throws.
    const out = t.lines.push.bind(t.lines);
    t.lines.push = (l) => {
      if (/^ {2}events /.test(l)) mkdirSync(join(t.work, '.agentic-plugins/runs/autopilot', L.listRuns(t.work).at(-1), 'halt.json'), { recursive: true });
      return out(l);
    };
    try {
      await rejects(t.run(), /halt\.json|EISDIR|ENOTEMPTY|EEXIST/);
      const r = t.latest();
      const ls = linesOf(t, r);
      deepStrictEqual(ending(ls), [[[`awaiting-owner:${GATE}`, 'A']], ['error', `awaiting-owner:${GATE}`, 1]]);
      deepStrictEqual([r.run.status, r.run.halt?.reason], ['error', `awaiting-owner:${GATE}`]);
      strictEqual(ls.at(-1).pointer, join(r.dir, 'run.json'));
    } finally {
      t.fx.cleanup();
    }
  });

  it('the parked lane picked up once its gate is cleared: lane-resumed, cause record-changed, after its lane-parked', async () => {
    const t = await setup({
      scenario: {
        A: { next: [COMMIT], file: true }, B: { next: [COMMIT], file: 'b.txt' },
        actions: { 1: `gate:${GATE}`, 2: ['mark-start:b-started', 'wait:a-resumed'], 3: 'mark-start:a-resumed' },
      },
    });
    const owner = (async () => {
      for (let i = 0; i < 1200; i += 1) {
        if (existsSync(join(t.dir, 'b-started')) && t.lines.some((l) => l.startsWith('■ lane A: '))) { await clearGate(t, 'A'); return true; }
        await pause(50);
      }
      return false;
    })();
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      ok(await owner);
      const ls = linesOf(t, t.latest());
      deepStrictEqual(kinds(ls, 'A').filter((k) => k.startsWith('lane-')), ['lane-parked', 'lane-resumed']);
      strictEqual(ls.find((e) => e.kind === 'lane-resumed').cause, 'record-changed');
      deepStrictEqual(ls.filter((e) => e.kind === 'commit-finished').map((e) => e.subtask_id).sort(), ['A', 'B']);
      deepStrictEqual(ending(ls), [[['awaiting-landing', null]], ['halted', 'awaiting-landing', 2]]);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a step that fails in a lane: its step-failed, then its lane\'s park at the same step', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT], file: 'a.txt' }, B: { next: [COMMIT], file: 'b.txt' }, actions: { 3: 'report-failed' } } });
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      const r = t.latest();
      const ls = linesOf(t, r);
      const failed = r.steps.find((s) => s.seq === 3);
      const f = ls.filter((e) => e.kind === 'step-failed');
      deepStrictEqual(f.map((e) => [e.subtask_id, e.step, e.reason, e.abort, e.pointer]), [[failed.subtask_id, 3, failed.outcome, null, join(r.dir, 'steps.jsonl')]]);
      const p = ls.filter((e) => e.kind === 'lane-parked');
      deepStrictEqual(p.map((e) => [e.subtask_id, e.reason, e.step]), [[failed.subtask_id, failed.outcome, 3]]);
      ok(ls.indexOf(f[0]) < ls.indexOf(p[0]));
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('holds and releases (ADR-0068 Decision 4, item 3)', () => {
  it('a hold handed over: lane-held once, with its hold id', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT] }, B: { next: [COMMIT], file: 'b.txt' } } });
    try {
      const h = await OPS.setHold({ mainRoot: t.work, macroId: t.fx.macroId, subtaskId: 'A', branch: 'feat/a', lane: null, child: null });
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      const ls = linesOf(t, t.latest());
      deepStrictEqual(ls.filter((e) => e.kind === 'lane-held').map((e) => [e.subtask_id, e.hold_id, e.pointer]), [['A', h.hold_id, join(t.latest().dir, 'lanes.jsonl')]]);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a release consumed: lane-released once, and a relaunch writes no second', async () => {
    const t = await setup({ scenario: scenario() });
    try {
      const h = await held(t);
      await release(t, h, async () => BASIS);
      strictEqual(await t.run({}, { releaseBasis: basisSeam(BASIS).fn }), 2, t.lines.join('\n'));
      const ls = linesOf(t, t.latest());
      deepStrictEqual(ls.filter((e) => e.kind === 'lane-released').map((e) => [e.subtask_id, e.hold_id, e.release_id, e.verdict]), [['A', h.hold_id, releaseOf(t).release_id, 'consumed']]);
      await t.run({}, { releaseBasis: basisSeam(BASIS).fn });
      deepStrictEqual(linesOf(t, t.latest()).filter((e) => e.kind === 'lane-released'), []);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a release rejected: lane-released rejected, then the lane\'s park, owner-choice', async () => {
    const t = await setup({ scenario: scenario() });
    try {
      const h = await held(t);
      await release(t, h, async () => BASIS);
      strictEqual(await t.run({}, { releaseBasis: basisSeam({ ...BASIS, tree_digest: 'edited after the release' }).fn }), 2, t.lines.join('\n'));
      const ls = linesOf(t, t.latest());
      deepStrictEqual(kinds(ls, 'A').filter((k) => k.startsWith('lane-')), ['lane-released', 'lane-parked']);
      deepStrictEqual(ls.filter((e) => e.kind === 'lane-released').map((e) => [e.verdict, e.release_id]), [['rejected', releaseOf(t).release_id]]);
      deepStrictEqual(ls.filter((e) => e.kind === 'lane-parked').map((e) => [e.reason, e.kept]), [['owner-choice', true]]);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a comparison whose park\'s end failed after it recorded consumed: the run that finishes it publishes the one lane-released', async () => {
    const t = await setup({ scenario: scenario() });
    try {
      const M = t.fx.macroId;
      const h = await held(t);
      const kept = parkRecord(t);
      strictEqual((await P.writePark(t.work, M, kept)).ok, true);
      await release(t, h, async () => BASIS);
      const rel = H.readRecord(t.work, M, 'releases', 'A');
      H.writeWhole(rel.path, { ...rel.record, state: 'consumed', compared_at: new Date().toISOString() });
      strictEqual(await t.run({}, { releaseBasis: basisSeam(BASIS).fn }), 2, t.lines.join('\n'));
      const ls = linesOf(t, t.latest());
      deepStrictEqual(ls.filter((e) => e.kind === 'lane-released').map((e) => [e.subtask_id, e.verdict, e.release_id]), [['A', 'consumed', releaseOf(t).release_id]]);
      // Its pointer holds the line this run recorded for it.
      const lanes = readFileSync(join(t.latest().dir, 'lanes.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      deepStrictEqual(lanes.filter((x) => x.event === 'released').map((x) => [x.release_id, x.verdict, x.recovered]), [[releaseOf(t).release_id, 'consumed', true]]);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a forced step refused on a held lane ends the run with its halt', async () => {
    const t = await setup({ scenario: scenario() });
    try {
      await held(t);
      const w = haltWatch();
      strictEqual(await t.run({ forcedPairs: [{ lane: 'A', step: { kind: 'dispatch', subtaskId: 'A' } }] }, w.deps), 2, t.lines.join('\n'));
      const ls = linesOf(t, t.latest());
      deepStrictEqual(ending(ls), [[['owner-choice', 'A']], ['halted', 'owner-choice', 2]]);
      deepStrictEqual(w.seen, [['owner-choice', 'halted', 'owner-choice']]);
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('a run-wide halt (ADR-0068 Decision 4, item 3)', () => {
  it('a drain publishes its halt as it is met, pointing at run.json, and the run\'s end does not publish it again', async () => {
    const t = await setup({
      scenario: {
        A: { next: [COMMIT] }, B: { next: [COMMIT], file: 'b.txt' },
        actions: { 1: ['wait:b-committing', 'mark:drift'], 3: ['mark-start:b-committing', 'wait:drained'] },
      },
    });
    markOn(t, /^■ version-drift/, 'drained');
    const resolveRoots = async (o) => {
      const r = await RT.resolveRoots(o);
      return existsSync(join(t.dir, 'drift')) ? { ...r, versions: { ...r.versions, engineer: '99.0.0' } } : r;
    };
    const w = haltWatch();
    try {
      strictEqual(await t.run({}, { resolveRoots, ...w.deps }), 2, t.lines.join('\n'));
      const r = t.latest();
      const ls = linesOf(t, r);
      deepStrictEqual(ending(ls), [[['version-drift', null]], ['halted', 'version-drift', 2]]);
      // A drain's halt: once run.json records the run draining.
      deepStrictEqual(w.seen, [['version-drift', 'draining', null]]);
      const halt = ls.find((e) => e.kind === 'halt');
      deepStrictEqual([halt.pointer, halt.step, halt.step_record], [join(r.dir, 'run.json'), null, null]);
      // Published while B's commit still ran: before that step's commit-finished.
      ok(ls.indexOf(halt) < ls.findIndex((e) => e.kind === 'commit-finished' && e.subtask_id === 'B'), JSON.stringify(ls.map((e) => e.kind)));
      deepStrictEqual(stepsOf(r).map((x) => [x[1], x[2]]), [['A', 'dispatch'], ['B', 'dispatch'], ['B', 'commit']]);
    } finally {
      t.fx.cleanup();
    }
  });

  it('an interrupt ends the run with the interrupted halt, the step in flight\'s step-failed first', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT] }, B: { next: [COMMIT], file: 'b.txt' }, actions: { 1: 'sleep', 2: 'sleep' } } });
    try {
      const running = t.run();
      for (let i = 0; i < 400 && !t.lines.some((l) => /^\[2\] /.test(l)); i += 1) await pause(50);
      await pause(300);
      t.signals.emit('SIGTERM');
      strictEqual(await running, 2, t.lines.join('\n'));
      const ls = linesOf(t, t.latest());
      deepStrictEqual(ls.filter((e) => e.kind === 'step-failed').map((e) => [e.step, e.reason, e.abort]).sort(), [[1, 'interrupted', 'interrupted'], [2, 'interrupted', 'interrupted']]);
      // One interrupt, one halt: published by the first lane's step it stopped.
      const [halts, end] = ending(ls);
      deepStrictEqual([halts.map((h) => h[0]), end], [['interrupted'], ['halted', 'interrupted', 2]]);
    } finally {
      t.fx.cleanup();
    }
  });
});

const causes = (ls, id) => ls.filter((e) => e.kind === 'lane-resumed' && e.subtask_id === id).map((e) => e.cause);

// Run 1: A's step runs, the hold is set during it, and the run hands the
// lane over (as test-autopilot-lanes-holds.mjs sets it up).
async function heldLane() {
  const t = await setup({
    scenario: { A: { next: [COMMIT], file: 'a.txt' }, B: { next: [COMMIT], file: 'b.txt' }, actions: { 1: ['mark-start:a-started', 'wait:hold-set'] } },
  });
  const running = t.run();
  for (let i = 0; i < 600 && !existsSync(join(t.dir, 'a-started')); i += 1) await pause(50);
  ok(existsSync(join(t.dir, 'a-started')), 'A started');
  const h = await OPS.setHold({ mainRoot: t.work, macroId: t.fx.macroId, subtaskId: 'A', branch: 'feat/a', lane: t.lane('A'), child: null });
  writeFileSync(join(t.dir, 'hold-set'), '1');
  strictEqual(await running, 2, t.lines.join('\n'));
  strictEqual(H.holdStateOf(t.work, t.fx.macroId, 'A').state, 'held');
  t.lines.length = 0;
  return { t, h };
}

describe('a lane-resumed line\'s cause (ADR-0068 Decision 4, item 3)', () => {
  it('a lane the relaunch passed by, given back once its release is consumed: cause release', async () => {
    const { t, h } = await heldLane();
    try {
      await release(t, h, async () => BASIS);
      // The comparison at the run's start fails; the tick's retry consumes it.
      let n = 0;
      const seam = basisSeam(() => { n += 1; if (n === 1) throw new Error('the basis failed'); return BASIS; });
      strictEqual(await bounded(t, {}, { releaseBasis: seam.fn }), 2, t.lines.join('\n'));
      strictEqual(releaseOf(t).state, 'consumed', t.lines.join('\n'));
      deepStrictEqual(causes(linesOf(t, t.latest()), 'A'), ['release']);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a lane the relaunch passed by whose hold ended without a release: cause hold-ended', async () => {
    const { t, h } = await heldLane();
    try {
      const M = t.fx.macroId;
      // The hold ends (as a retirement ends it) once the relaunch has passed
      // the lane by.
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
      deepStrictEqual(causes(linesOf(t, t.latest()), 'A'), ['hold-ended']);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a kept park the owner releases while the run lives: lane-resumed, cause release', async () => {
    const t = await setup({
      scenario: {
        A: { next: [COMMIT], file: true }, B: { next: [COMMIT], file: 'b.txt' },
        actions: { 1: `gate:${GATE}`, 2: ['mark-start:b-started', 'wait:a-released'] },
      },
    });
    // The owner's release, as `agentic-autopilot release A` ends the park.
    const owner = (async () => {
      for (let i = 0; i < 1200; i += 1) {
        if (existsSync(join(t.dir, 'b-started')) && t.lines.some((l) => l.startsWith('■ lane A: '))) {
          const cur = P.readPark(t.work, t.fx.macroId, 'A');
          const r = await P.deletePark(t.work, t.fx.macroId, 'A', { expect: cur.record.record_id, event: 'released', fields: { by: 'owner', live_run: null } });
          writeFileSync(join(t.dir, 'a-released'), '1');
          return r.ok;
        }
        await pause(50);
      }
      return false;
    })();
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      ok(await owner);
      const ls = linesOf(t, t.latest());
      deepStrictEqual(causes(ls, 'A')[0], 'release');
    } finally {
      t.fx.cleanup();
    }
  });

  it('a forced step on a lane its park keeps: lane-resumed, cause forced', async () => {
    const LOW = { kind: 'verb', verb: 'critique', confidence: 'LOW' };
    const t = await setup({
      scenario: { A: { next: [LOW, COMMIT], file: true }, B: { next: [LOW, COMMIT], file: 'b.txt' }, actions: { 1: 'wait:b-started', 2: 'mark-start:b-started' } },
    });
    try {
      // Run 1 parks both lanes (a LOW-confidence critique each); run 2 forces A's.
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      strictEqual(await t.run({ forcedPairs: [{ lane: 'A', step: { kind: 'verb', verb: 'critique' } }] }), 2, t.lines.join('\n'));
      const ls = linesOf(t, t.latest());
      deepStrictEqual([causes(ls, 'A'), causes(ls, 'B')], [['forced'], []]);
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('a run with lanes\' end, whatever its output and its errors meet (ADR-0068 Decision 4)', () => {
  it('a step the run\'s error meets while it is settled: its step-failed, error, beside the step in flight\'s', async () => {
    // Step 1 (lane A) ends once step 2 (lane B) runs, which sleeps.
    const t = await setup({
      scenario: { A: { next: [COMMIT], file: 'a.txt' }, B: { next: [COMMIT], file: 'b.txt' }, actions: { 1: ['wait:b-started', 'mark:first-done'], 2: ['mark-start:b-started', 'sleep'] } },
    });
    // The look after step 1, in lane A, throws: the step is out of the steps
    // in flight and its finished line is not written yet.
    let thrown = false;
    const observeAsync = async (a, o) => {
      if (!thrown && a.repoRoot.endsWith(`/${t.fx.macroId}/A`) && existsSync(join(t.dir, 'first-done'))) {
        thrown = true;
        throw new Error('simulated: the look after a lane step threw');
      }
      return observeInChild(a, o);
    };
    try {
      await rejects(t.run({}, { observeAsync }), /simulated: the look after a lane step threw/);
      ok(thrown);
      const r = t.latest();
      const ls = linesOf(t, r);
      deepStrictEqual(ls.filter((e) => e.kind === 'step-failed').map((e) => [e.step, e.reason, e.abort]).sort(), [[1, 'error', null], [2, 'error', 'interrupted']]);
      ok(!r.steps.some((s) => s.seq === 1 && s.event === 'finished'), 'step 1 has no finished line: the error met it while it was settled');
      deepStrictEqual([ls.at(-1).status, ls.at(-1).exit], ['error', 1]);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a driver whose stdout and stderr are a closed pipe runs to its end: its exit is its run-ended\'s, and run-ended is on file', { skip: process.platform === 'win32' ? 'no EPIPE on a closed pipe' : false }, async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT] }, B: { next: [COMMIT], file: 'b.txt' } } });
    try {
      // The driver in a process of its own, printing through the CLI's own
      // printers to pipes whose reader is gone before its first line: every
      // write fails, reported later as an 'error' event on the stream.
      const child = 'const [drv, cli, repo, opts] = process.argv.slice(1); const { startRun, DEFAULTS } = await import(drv); const { printerOf } = await import(cli);'
        + ' process.exitCode = await startRun({ repoRoot: repo, options: { ...DEFAULTS, ...JSON.parse(opts) }, env: process.env,'
        + ' out: printerOf(process.stdout), err: printerOf(process.stderr), deps: { wakeIntervalMs: 300 } });';
      const opts = { models: 'owner-default', model: null, effort: null, macro: t.fx.macroId, forced: null, forcedText: null, forcedPairs: null, notifyLocal: false, lanes: 2 };
      const p = spawn(process.execPath, ['--input-type=module', '-e', child, resolve(AP, 'driver.mjs'), resolve(AP, 'cli.mjs'), t.work, JSON.stringify(opts)], { env: t.env, stdio: ['ignore', 'pipe', 'pipe'] });
      p.stdout.destroy();
      p.stderr.destroy();
      const killer = setTimeout(() => p.kill('SIGKILL'), 240_000);
      const [code, signal] = await new Promise((r) => { p.on('exit', (c, s) => r([c, s])); });
      clearTimeout(killer);
      const r = t.latest();
      const ls = linesOf(t, r);
      deepStrictEqual([ls.at(-1).kind, ls.at(-1).status, ls.at(-1).exit], ['run-ended', 'halted', 2]);
      deepStrictEqual([signal, code], [null, ls.at(-1).exit]);
      strictEqual(r.run.status, 'halted');
    } finally {
      t.fx.cleanup();
    }
  });
});
