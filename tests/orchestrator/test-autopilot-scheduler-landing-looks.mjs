// tests/orchestrator/test-autopilot-scheduler-landing-looks.mjs
//
// ADR-0067 Decision 6 — the scheduler of a run with lanes
// (plugins/orchestrator/adapters/claude/autopilot/scheduler.mjs) end to end,
// with no model: the fake `claude` hands each step to the scripted worker
// (fixtures/autopilot-scripted-worker.mjs), which does what the runbook would
// through this checkout's real state APIs and CLIs, in the lane the driver
// gave it. The repository is a clone with a bare origin and a fake `gh`;
// shared creation is on in it, so the macro and every child live in its
// default state root, and each lane is a real git worktree beside it.
//
// This file: landing reports with lanes, the looks that feed the run's list.
// The scheduler tests are split across test-autopilot-scheduler*.mjs so
// node --test runs them in parallel; each file sets up its own repositories.

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, rejects, strictEqual } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { ORCH } from './fixtures/autopilot-repo.mjs';
import {
  AP, bySubtask, COMMIT, CRITIQUE, hour, L, LN, markOn, OPEN, ROOTS, setup, stepsOf,
} from './fixtures/autopilot-lanes-run.mjs';

const SR = await import(resolve(AP, '../../../scripts/lib/state-root.mjs'));
const RT = await import(resolve(AP, 'roots.mjs'));
const { observeInChild } = await import(resolve(AP, 'offloop.mjs'));
const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });
const until = async (file) => { for (let i = 0; i < 600 && !existsSync(file); i += 1) await pause(50); };
// ADR-0068 Decision 1: a lane halt parks its lane and drains nothing, so the
// drain these tests need is a run-wide one: version drift, seen once a step
// has written <dir>/drift.
const driftOn = (t) => ({
  resolveRoots: async (o) => {
    const r = await RT.resolveRoots(o);
    return existsSync(join(t.dir, 'drift')) ? { ...r, versions: { ...r.versions, engineer: '99.0.0' } } : r;
  },
});

// ADR-0067 Decision 7, docket C128 and C123 — the landing report of a run
// with lanes.
describe('landing reports with lanes', () => {
  it('a commit made while the run drains is reported ready by a last look that fetches, before the run ends', async () => {
    // A's dispatch brings version drift once B's commit has started, which
    // drains the run; B's commit goes on once the drain has begun. A lane's
    // look after its step does not fetch, so only a later look reports B ready.
    const t = await setup({
      scenario: {
        A: { next: [COMMIT] }, B: { next: [COMMIT], file: 'b.txt' },
        actions: { 1: ['wait:b-committing', 'mark:drift'], 3: ['mark-start:b-committing', 'wait:drained'] },
      },
    });
    markOn(t, /^■ version-drift/, 'drained');
    try {
      strictEqual(await t.run({}, driftOn(t)), 2, t.lines.join('\n'));
      ok(!existsSync(join(t.dir, 'drained.timeout')) && !existsSync(join(t.dir, 'b-committing.timeout')), t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(stepsOf(r).map((x) => [x[0], x[1], x[2], x[4]]), [[1, 'A', 'dispatch', 'ok'], [2, 'B', 'dispatch', 'ok'], [3, 'B', 'commit', 'ok']]);
      strictEqual(r.halt.reason, 'version-drift');
      const base = t.git(t.work, 'rev-parse', 'refs/remotes/origin/main');
      deepStrictEqual(r.landing.map((x) => [x.subtask_id, x.after_seq, x.sync.state, x.sync.base_commit]), [['B', 3, 'ready', base]]);
      const drained = t.lines.findIndex((l) => /draining: 1 step\(s\) in flight/.test(l));
      const reported = t.lines.findIndex((l) => l.startsWith('◆ landing-ready: B on feat/b at '));
      ok(drained >= 0 && reported > drained, t.lines.join('\n'));
      // The lane report lists B waiting, as the last look found it.
      deepStrictEqual([bySubtask(r).B.waiting?.commit, bySubtask(r).B.waiting?.sync?.state], [t.git(t.work, 'rev-parse', 'refs/heads/feat/b'), 'ready']);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a commit made while the run drains is still listed, unknown, when the drain\'s last look fails', async () => {
    // As above, but every look after the drain begins fails except B's own
    // look after its commit, in its lane.
    const t = await setup({
      scenario: {
        A: { next: [COMMIT] }, B: { next: [COMMIT], file: 'b.txt' },
        actions: { 1: ['wait:b-committing', 'mark:drift'], 3: ['mark-start:b-committing', 'wait:drained'] },
      },
    });
    markOn(t, /^■ version-drift/, 'drained');
    const { failedView } = await import(resolve(AP, 'offloop.mjs'));
    const observeAsync = async (a, o) => {
      if (existsSync(join(t.dir, 'drained')) && a.repoRoot !== t.lane('B')) return failedView(a.repoRoot, 'simulated: the look failed');
      return observeInChild(a, o);
    };
    try {
      strictEqual(await t.run({}, { observeAsync, ...driftOn(t) }), 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(stepsOf(r).map((x) => [x[0], x[1], x[2], x[4]]), [[1, 'A', 'dispatch', 'ok'], [2, 'B', 'dispatch', 'ok'], [3, 'B', 'commit', 'ok']]);
      const b = bySubtask(r).B.waiting;
      ok(b, `lane B is listed waiting: ${JSON.stringify(bySubtask(r).B)}`);
      deepStrictEqual([b.branch, b.commit, b.sync?.state, b.sync?.detail], ['feat/b', t.git(t.work, 'rev-parse', 'refs/heads/feat/b'), 'unknown', "the run's last look failed (simulated: the look failed)"]);
      deepStrictEqual(r.landing, [], 'B was never reported ready: its own look did not fetch, and the last one failed');
    } finally {
      t.fx.cleanup();
    }
  });

  // Run 1 halts awaiting-landing with A and B ready. The relaunch's looks are
  // doctored: `startup` the driver's own (synchronous) looks before the
  // scheduler, `first` the first look of the scheduler's loop; every look
  // after that fails. Whatever the run knew of A and B, and no later look
  // confirmed, stands as unknown at the end.
  const refused = { ok: false, reason: 'gh_unavailable', detail: 'simulated: gh is unavailable' };
  const relaunchFailing = async ({ startup = (v) => v, first, deps = () => ({}) }) => {
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT], file: 'b.txt' } } });
    strictEqual(await t.run(), 2, t.lines.join('\n'));
    deepStrictEqual(t.latest().halt.waiting.map((w) => [w.subtaskId, w.sync.state]), [['A', 'ready'], ['B', 'ready']]);
    const { failedView } = await import(resolve(AP, 'offloop.mjs'));
    const { observe } = await import(resolve(AP, 'observe.mjs'));
    let looks = 0;
    const observeAsync = async (a, o) => {
      looks += 1;
      if (looks > 1) return failedView(a.repoRoot, 'simulated: the look failed');
      return first(await observeInChild(a, o), t);
    };
    let code;
    try {
      code = await t.run({}, { observe: (a) => startup(observe(a)), observeAsync, ...deps(t) });
    } catch (e) {
      code = e;
    }
    return { t, code, r: t.latest() };
  };
  const bothUnknown = (r) => {
    deepStrictEqual(['A', 'B'].map((id) => [bySubtask(r)[id].waiting?.sync?.state, bySubtask(r)[id].waiting?.sync?.detail]), [
      ['unknown', "the run's last look failed (simulated: the look failed)"], ['unknown', "the run's last look failed (simulated: the look failed)"],
    ], JSON.stringify(bySubtask(r)));
  };

  it('a lane reported ready keeps its place, unknown, through a look whose landing check refuses and a last look that fails', async () => {
    // Known from the start; the loop's first look finds gh unavailable for
    // both, which halts them.
    const { t, code, r } = await relaunchFailing({ first: (v) => ({ ...v, landing: { ...v.landing, A: refused, B: refused } }) });
    try {
      strictEqual(code, 2, t.lines.join('\n'));
      strictEqual(r.halt.reason, 'owner-choice', r.halt.detail);
      match(r.halt.detail, /gh_unavailable/);
      bothUnknown(r);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a lane a look reports waiting joins the run\'s list before that look halts the run', async () => {
    // Unknown at the start (its landing check refused there); the loop's
    // first look finds both waiting, and cannot read the macro's readiness,
    // which halts the run before any lane is scheduled.
    const { t, code, r } = await relaunchFailing({
      startup: (v) => ({ ...v, landing: { ...v.landing, A: refused, B: refused } }),
      first: (v) => ({ ...v, readyError: 'simulated: next-ready failed' }),
    });
    try {
      strictEqual(code, 2, t.lines.join('\n'));
      strictEqual(r.halt.reason, 'owner-choice', r.halt.detail);
      match(r.halt.detail, /next-ready failed: simulated/);
      bothUnknown(r);
    } finally {
      t.fx.cleanup();
    }
  });

  it('the scheduler takes the driver\'s list: a lane only the look before the locks could read stays listed, unknown', async () => {
    // Run 1 halts awaiting-landing with A and B ready. In the relaunch only
    // the driver's first look (before the locks) reads A's engineer workflow;
    // every later look finds it unreadable.
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT], file: 'b.txt' } } });
    const { observe } = await import(resolve(AP, 'observe.mjs'));
    const unreadable = (v) => ({ ...v, children: { ...v.children, A: { location: 'error', detail: 'simulated: unreadable' } } });
    let looks = 0;
    const look = (a) => {
      looks += 1;
      const v = observe(a);
      return looks === 1 ? v : unreadable(v);
    };
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      deepStrictEqual(t.latest().halt.waiting.map((w) => [w.subtaskId, w.sync.state]), [['A', 'ready'], ['B', 'ready']]);
      t.lines.length = 0;
      strictEqual(await t.run({}, { observe: look }), 2, t.lines.join('\n'));
      ok(looks > 2, t.lines.join('\n'));
      const r = t.latest();
      const a = bySubtask(r).A?.waiting;
      deepStrictEqual([a?.branch, a?.sync?.state], ['feat/a', 'unknown'], JSON.stringify(bySubtask(r)));
      match(a.sync.detail, /subtask A's engineer workflow could not be read \(simulated: unreadable\)/);
    } finally {
      t.fx.cleanup();
    }
  });

  // Unknown at the start (their landing checks refused there), so the run's
  // list starts empty; the loop's first look then finds both waiting, and is
  // cut off before it feeds the list.
  const cutOff = (why) => [['unknown', why], ['unknown', why]];
  const states = (r) => ['A', 'B'].map((id) => [bySubtask(r)[id]?.waiting?.sync?.state, bySubtask(r)[id]?.waiting?.sync?.detail]);

  it('an interrupt that cuts off a look of the loop still lists what that look found waiting, unknown', async () => {
    const { t, code, r } = await relaunchFailing({
      startup: (v) => ({ ...v, landing: { ...v.landing, A: refused, B: refused } }),
      first: (v, tt) => { tt.signals.emit('SIGINT'); return v; },
    });
    try {
      strictEqual(code, 2, t.lines.join('\n'));
      strictEqual(r.halt.reason, 'interrupted', r.halt.detail);
      deepStrictEqual(states(r), cutOff('the run ended before its last look (the owner interrupted the run)'), JSON.stringify(bySubtask(r)));
    } finally {
      t.fx.cleanup();
    }
  });

  it('a look a later look replaces still lists what it found waiting: a retry that fails after an interrupt keeps it, unknown', async () => {
    // The loop's first look found both waiting but could not list the
    // claims, so it is taken again; the owner interrupted meanwhile, and the
    // retry fails.
    const { t, code, r } = await relaunchFailing({
      startup: (v) => ({ ...v, landing: { ...v.landing, A: refused, B: refused } }),
      first: (v, tt) => { tt.signals.emit('SIGINT'); return { ...v, claimsError: 'simulated: a claim moved' }; },
    });
    try {
      strictEqual(code, 2, t.lines.join('\n'));
      strictEqual(r.halt.reason, 'interrupted', r.halt.detail);
      deepStrictEqual(states(r), cutOff('the run ended before its last look (the owner interrupted the run)'), JSON.stringify(bySubtask(r)));
    } finally {
      t.fx.cleanup();
    }
  });

  it('an error before the run\'s first look of its own still lists what the first report found, unknown', async () => {
    // Run 1 halts awaiting-landing with A and B ready; the relaunch fails as
    // it prints its first line with lanes.
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT], file: 'b.txt' } } });
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      const push = t.lines.push.bind(t.lines);
      t.lines.push = (l) => {
        if (/^ {2}lanes: up to /.test(l)) throw new Error('simulated: the terminal went away');
        return push(l);
      };
      await rejects(t.run(), /simulated: the terminal went away/);
      const r = t.latest();
      strictEqual(r.run.status, 'error');
      deepStrictEqual(states(r), cutOff('the run ended before its last look (the run stopped on an error: simulated: the terminal went away)'), JSON.stringify(bySubtask(r)));
    } finally {
      t.fx.cleanup();
    }
  });

  it('an error that cuts off a look of the loop before its report still lists what that look found waiting, unknown', async () => {
    const { offLoop: defaultOffLoop } = await import(resolve(AP, 'offloop.mjs'));
    const { t, code, r } = await relaunchFailing({
      startup: (v) => ({ ...v, landing: { ...v.landing, A: refused, B: refused } }),
      first: (v) => v,
      deps: () => ({
        offLoop: (task, args, o) => (task === 'reportLanding' ? Promise.reject(new Error('simulated: the report threw')) : defaultOffLoop(task, args, o)),
      }),
    });
    try {
      match(String(code?.message), /simulated: the report threw/);
      strictEqual(r.run.status, 'error');
      deepStrictEqual(states(r), cutOff('the run ended before its last look (the run stopped on an error: simulated: the report threw)'), JSON.stringify(bySubtask(r)));
    } finally {
      t.fx.cleanup();
    }
  });

  it('an error after the halt was recorded leaves no readiness standing in it', async () => {
    // Run 1 halts awaiting-landing with A and B ready, and fails as it prints
    // the halt, after halt.json was written.
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT], file: 'b.txt' } } });
    const push = t.lines.push.bind(t.lines);
    t.lines.push = (l) => {
      if (/^■ halted: awaiting-landing/.test(l)) throw new Error('simulated: the terminal went away');
      return push(l);
    };
    try {
      await rejects(t.run(), /simulated: the terminal went away/);
      const r = t.latest();
      strictEqual(r.run.status, 'error');
      const why = 'the run ended before its last look (the run stopped on an error: simulated: the terminal went away)';
      deepStrictEqual(r.halt.waiting.map((w) => [w.subtaskId, w.sync.state, w.sync.detail]), [['A', 'unknown', why], ['B', 'unknown', why]]);
      deepStrictEqual(r.halt.lanes.map((l) => [l.subtask_id, l.waiting?.sync?.state]), [['A', 'unknown'], ['B', 'unknown']]);
      deepStrictEqual(states(r), cutOff(why));
    } finally {
      t.fx.cleanup();
    }
  });
});
