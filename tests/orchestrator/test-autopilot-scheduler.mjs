// tests/orchestrator/test-autopilot-scheduler.mjs
//
// ADR-0067 Decision 6 — the scheduler of a run with lanes
// (plugins/orchestrator/adapters/claude/autopilot/scheduler.mjs) end to end,
// with no model: the fake `claude` hands each step to the scripted worker
// (fixtures/autopilot-scripted-worker.mjs), which does what the runbook would
// through this checkout's real state APIs and CLIs, in the lane the driver
// gave it. The repository is a clone with a bare origin and a fake `gh`;
// shared creation is on in it, so the macro and every child live in its
// default state root, and each lane is a real git worktree beside it.

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

describe('two lanes', () => {
  it('progress independently, each in its own worktree, and halt awaiting-landing together; the relaunch lands both, removes the lanes and finalizes', async () => {
    // A's dispatch ends only once B's has started: the two run at once.
    const t = await setup({
      scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT], file: 'b.txt' }, actions: { 1: 'wait:b-started', 2: 'mark-start:b-started' } },
    });
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      ok(!existsSync(join(t.dir, 'b-started.timeout')), 'B started while A ran');
      let r = t.latest();
      const steps = stepsOf(r);
      deepStrictEqual(steps.filter((s) => s[1] === 'A').map((s) => [s[2], s[4]]), [['dispatch', 'ok'], ['commit', 'ok']], t.lines.join('\n'));
      deepStrictEqual(steps.filter((s) => s[1] === 'B').map((s) => [s[2], s[4]]), [['dispatch', 'ok'], ['commit', 'ok']]);
      strictEqual(steps.length, 4);
      // Each lane step ran in its lane, never in the driver's checkout.
      for (const s of r.steps) strictEqual(s.cwd, t.lane(s.lane));
      strictEqual(r.halt.reason, 'awaiting-landing');
      deepStrictEqual(r.halt.waiting.map((w) => w.subtaskId).sort(), ['A', 'B']);
      deepStrictEqual(Object.keys(bySubtask(r)).sort(), ['A', 'B']);
      deepStrictEqual(r.halt.lanes.map((l) => l.subtask_id), ['A', 'B'], 'halt.json has one entry per lane');
      match(r.halt.resume.at(-1), new RegExp(`start --execute --macro ${t.fx.macroId} --lanes 2`));
      for (const id of ['A', 'B']) {
        const w = LN.listWorktrees(t.work).find((x) => x.path === t.lane(id));
        ok(w?.locked && w.lockReason === LN.lockReason(t.fx.macroId, id), `lane ${id} is locked with the run's reason`);
        strictEqual(t.git(t.lane(id), 'log', '-1', '--format=%s').length > 0, true);
      }
      strictEqual(t.git(t.work, 'branch', '--show-current'), 'main', 'the driver\'s checkout never switches');
      // Each commit reported once, ready: a lane's look does not fetch, and
      // the run's next look, which does, published it.
      const base = t.git(t.work, 'rev-parse', 'refs/remotes/origin/main');
      deepStrictEqual(r.landing.map((x) => [x.subtask_id, x.sync.state, x.sync.base_commit]).sort(), [['A', 'ready', base], ['B', 'ready', base]]);
      deepStrictEqual(['A', 'B'].map((id) => bySubtask(r)[id].waiting?.sync?.state), ['ready', 'ready'], 'the lane report carries the freshness');
      deepStrictEqual(r.halt.waiting.map((w) => w.sync.state), ['ready', 'ready'], 'and so does the halt');
      deepStrictEqual(L.readLockEntries(L.macroLockPath(t.work, t.fx.macroId)), [], 'the macro lock is released');
      deepStrictEqual(L.readLockEntries(L.worktreeLockPath(t.lane('A'))), [], 'each lane lock is released');
      deepStrictEqual(L.listOpenRuns(t.work), []);
      for (const seq of [1, 2, 3, 4]) {
        deepStrictEqual(JSON.parse(readFileSync(join(t.dir, `ledger-${seq}.json`), 'utf8')), { recorded: true, registered: true },
          `step ${seq} was on record, and its worker on the lock of its lane, before it got its prompt`);
      }

      // The owner lands both.
      t.fx.setPrs([t.fx.land('A', 'feat/a', { number: 7 }), t.fx.land('B', 'feat/b', { number: 8 })]);
      strictEqual(await t.run(), 0, t.lines.join('\n'));
      r = t.latest();
      // done runs in the driver's checkout, one at a time; the last one
      // auto-terminalizes the macro, and its worker's Stop archives it.
      deepStrictEqual(stepsOf(r).map((s) => [s[1], s[2], s[3], s[4]]), [[null, 'done', 'A', 'ok'], [null, 'done', 'B', 'ok']]);
      for (const s of r.steps) strictEqual(s.cwd, t.work);
      ok(!existsSync(t.lane('A')) && !existsSync(t.lane('B')), 'a lane is removed once its subtask is done');
      strictEqual(r.run.status, 'completed');
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('drain (W2)', () => {
  it('a halt in one lane drains the run: the other lane\'s step in flight runs to its end and is recorded, nothing new starts, every lane is reported once', async () => {
    // A's dispatch changes nothing (no-progress… here a dispatch that left
    // its subtask pending), once B's has started; B's goes on only once the
    // run has started draining.
    const t = await setup({
      scenario: {
        A: { next: [COMMIT] }, B: { next: [COMMIT], file: 'b.txt' },
        actions: { 1: ['wait:b-started', 'noop'], 2: ['mark-start:b-started', 'wait:drained'] },
      },
    });
    markOn(t, /^■ lane A: owner-choice/, 'drained');
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      ok(!existsSync(join(t.dir, 'drained.timeout')), 'B was still running when the drain began');
      const r = t.latest();
      deepStrictEqual(stepsOf(r).map((x) => [x[1], x[2], x[4]]).sort(), [['A', 'dispatch', 'owner-choice'], ['B', 'dispatch', 'ok']]);
      strictEqual(r.halt.reason, 'owner-choice');
      strictEqual(r.halt.subtask_id, 'A');
      ok(t.lines.some((l) => /draining: 1 step\(s\) in flight/.test(l)), t.lines.join('\n'));
      const lanes = bySubtask(r);
      strictEqual(lanes.A.halt.reason, 'owner-choice');
      deepStrictEqual([lanes.B.last_step.kind, lanes.B.last_step.outcome, lanes.B.halt], ['dispatch', 'ok', null]);
      deepStrictEqual(r.halt.lanes.map((l) => l.subtask_id), ['A', 'B']);
      strictEqual(t.lines.filter((l) => /^ {2}lane B /.test(l)).length, 1, 'each lane is reported once');
      ok(existsSync(t.lane('A')) && existsSync(t.lane('B')), 'a drain keeps the lanes');
      strictEqual(r.run.status, 'halted');
    } finally {
      t.fx.cleanup();
    }
  });

  it('simultaneous halts: both lanes are recorded, the first is the run\'s reason and the other is kept beside it', async () => {
    const t = await setup({
      scenario: {
        A: { next: [COMMIT] }, B: { next: [COMMIT] },
        actions: { 1: ['wait:b-started', 'noop', 'mark:a-ended'], 2: ['mark-start:b-started', 'wait:a-ended', 'noop'] },
      },
    });
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(stepsOf(r).map((x) => [x[1], x[4]]).sort(), [['A', 'owner-choice'], ['B', 'owner-choice']]);
      const lanes = bySubtask(r);
      ok(lanes.A.halt && lanes.B.halt, 'each lane records its own halt');
      strictEqual(r.halt.also.length, 1);
      deepStrictEqual([r.halt.subtask_id, r.halt.also[0].subtask_id].sort(), ['A', 'B']);
    } finally {
      t.fx.cleanup();
    }
  });

  it('SIGTERM during a drain aborts the step still in flight (interrupted) instead of waiting for it, and keeps the lanes', async () => {
    const t = await setup({
      scenario: { A: { next: [COMMIT] }, B: { next: [COMMIT] }, actions: { 1: ['wait:b-started', 'noop'], 2: ['mark-start:b-started', 'wait:never'] } },
    });
    const push = t.lines.push.bind(t.lines);
    t.lines.push = (line) => {
      if (/^■ lane A: owner-choice/.test(line)) setTimeout(() => t.signals.emit('SIGTERM'), 50);
      return push(line);
    };
    try {
      const startedAt = Date.now();
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      ok(Date.now() - startedAt < 55_000, 'the run did not wait out the step in flight');
      const r = t.latest();
      const b = r.steps.find((x) => x.lane === 'B');
      deepStrictEqual([b.aborted, b.outcome], ['interrupted', 'interrupted']);
      strictEqual(r.halt.reason, 'interrupted');
      match(r.halt.detail, /while it drained after owner-choice/);
      ok(existsSync(t.lane('A')) && existsSync(t.lane('B')));
      deepStrictEqual(L.readLockEntries(L.macroLockPath(t.work, t.fx.macroId)), [], 'every group is empty, so the locks are released');
      deepStrictEqual(L.listOpenRuns(t.work), []);
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('budgets are reserved', () => {
  it('a second lane whose start only other steps\' reservations block waits for them to settle, then runs; the run is not exhausted', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT], file: 'b.txt' } } });
    try {
      strictEqual(await t.run({ maxCostUsd: 25.3, stepBudgetUsd: 25 }), 2, t.lines.join('\n'));
      const r = t.latest();
      strictEqual(r.halt.reason, 'awaiting-landing', 'the run was never exhausted: each step spent $0.01');
      const [first, ...rest] = r.steps;
      strictEqual(first.step_budget_usd, 25, 'the first step reserved the per-step cap');
      for (const x of rest) {
        const before = r.steps.filter((y) => y.seq < x.seq);
        ok(before.every((y) => Date.parse(y.ended_at) <= Date.parse(x.started_at)), `step ${x.seq} started only once every earlier reservation had settled`);
      }
      ok(r.run.cost_usd <= 25.3);
      deepStrictEqual(r.run.accounted_seqs.slice().sort((x, y) => x - y), r.steps.map((x) => x.seq));
    } finally {
      t.fx.cleanup();
    }
  });

  it('a step cap held by a step in flight makes the next lane wait; once that step is taken, the cap is exhausted and the run halts budget', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT] }, B: { next: [COMMIT] } } });
    try {
      strictEqual(await t.run({ maxSteps: 1 }), 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(stepsOf(r).map((x) => [x[1], x[2]]), [['A', 'dispatch']]);
      strictEqual(r.halt.reason, 'budget');
      match(r.halt.detail, /step cap \(1\)/);
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('throttle', () => {
  it('a five-hour window at 0.85 or more starts no new lane, while the started lane keeps stepping; with nothing to refresh it the run waits for the reset an hour off — no run deadline halts it — until SIGTERM', async () => {
    const throttled = { ...OPEN(), unifiedWindows: { five_hour: { utilization: 0.9, resetsAt: hour() }, seven_day: { utilization: 0.4, resetsAt: hour() + 86400 } } };
    const t = await setup({ scenario: { A: { next: [CRITIQUE, COMMIT], file: true }, B: { next: [COMMIT] } }, rateLimit: throttled });
    const push = t.lines.push.bind(t.lines);
    t.lines.push = (line) => {
      if (/waiting for the reset at /.test(line)) setTimeout(() => t.signals.emit('SIGTERM'), 50);
      return push(line);
    };
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(stepsOf(r).map((x) => [x[1], x[2]]), [['A', 'dispatch'], ['A', 'verb'], ['A', 'commit']], 'B never started');
      ok(t.lines.some((l) => /throttled \(five-hour utilization 0\.9 \(limit 0\.85\)\) with nothing running; waiting for the reset at /.test(l)), t.lines.join('\n'));
      strictEqual(r.halt.reason, 'interrupted', 'the wait ended only at the signal');
      strictEqual(r.run.rate_limit.five_hour.utilization, 0.9);
      ok(!existsSync(t.lane('B')), 'a throttled run creates no lane');
    } finally {
      t.fx.cleanup();
    }
  });

  it('throttled with nothing running waits for the reset, then starts the new lane', async () => {
    // Far enough off that A's two steps end before it: B then waits with
    // nothing in flight.
    const soon = Math.floor(Date.now() / 1000) + 30;
    const throttled = { ...OPEN(), unifiedWindows: { five_hour: { utilization: 0.95, resetsAt: soon }, seven_day: { utilization: 0.4, resetsAt: hour() + 86400 } } };
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT], file: 'b.txt' } }, rateLimit: throttled });
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      const r = t.latest();
      const b = r.steps.find((x) => x.lane === 'B');
      ok(b, t.lines.join('\n'));
      ok(Date.parse(b.started_at) >= soon * 1000, 'B started after the reset');
      // When A's steps ended before the reset (they take seconds), nothing
      // ran while B was throttled, and the run waited for the reset.
      const aEnded = Math.max(...r.steps.filter((x) => x.lane === 'A').map((x) => Date.parse(x.ended_at)));
      if (aEnded < soon * 1000) ok(t.lines.some((l) => /waiting for the reset/.test(l)), t.lines.join('\n'));
      strictEqual(r.halt.reason, 'awaiting-landing');
    } finally {
      t.fx.cleanup();
    }
  });

  it('before the first rate-limit event a new lane starts only while no worker is in flight', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT], file: 'b.txt' } }, rateLimit: null });
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      const r = t.latest();
      const b = r.steps.find((x) => x.lane === 'B' && x.kind === 'dispatch');
      const a = r.steps.filter((x) => x.lane === 'A');
      ok(a.length > 0 && b, t.lines.join('\n'));
      ok(r.steps.filter((x) => x.seq < b.seq).every((x) => Date.parse(x.ended_at) <= Date.parse(b.started_at)), 'B started with nothing in flight');
      strictEqual(r.run.rate_limit.state, 'unknown');
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('landing order and the serial driver', () => {
  it('a successor waits for its predecessor\'s landing; a serial run refuses beside the waiting lane; after the merge the successor gets a lane cut from the new baseline', async () => {
    const t = await setup({ subtasks: [{ id: 'A' }, { id: 'B', blocked_by: ['A'] }], scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT], file: 'b.txt' } } });
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      let r = t.latest();
      deepStrictEqual(stepsOf(r).map((x) => [x[1], x[2]]), [['A', 'dispatch'], ['A', 'commit']]);
      strictEqual(r.halt.reason, 'awaiting-landing');
      ok(!existsSync(t.lane('B')));

      t.lines.length = 0;
      strictEqual(await t.run({ lanes: 1 }), 1, 'a serial run refuses while a lane holds unfinished work');
      ok(t.lines.some((l) => l.includes(`--macro ${t.fx.macroId} --lanes 2`)), t.lines.join('\n'));

      const pr = t.fx.land('A', 'feat/a');
      t.fx.setPrs([pr]);
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      r = t.latest();
      deepStrictEqual(stepsOf(r).map((x) => [x[1], x[2], x[3]]), [[null, 'done', 'A'], ['B', 'dispatch', 'B'], ['B', 'commit', 'B']]);
      ok(!existsSync(t.lane('A')), 'A\'s lane went once A was done');
      strictEqual(t.git(t.lane('B'), 'merge-base', '--is-ancestor', pr.mergeCommit.oid, 'HEAD'), '', 'B was cut from the baseline that carries A');
    } finally {
      t.fx.cleanup();
    }
  });

  it('--lanes 1 is the serial driver: one subtask at a time, in the driven checkout, no lane', async () => {
    const t = await setup({ subtasks: [{ id: 'A' }, { id: 'B', blocked_by: ['A'] }], scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT] } } });
    try {
      strictEqual(await t.run({ lanes: 1 }), 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(r.steps.map((x) => [x.kind, x.subtask_id, x.outcome, x.lane]), [['dispatch', 'A', 'ok', undefined], ['commit', 'A', 'ok', undefined]]);
      strictEqual(r.halt.reason, 'awaiting-landing');
      strictEqual(r.run.lanes, undefined);
      strictEqual(r.halt.lanes, undefined);
      ok(!existsSync(t.lane('A')));
      strictEqual(t.git(t.work, 'branch', '--show-current'), 'feat/a', 'the serial driver works in its own checkout');
    } finally {
      t.fx.cleanup();
    }
  });

  it('a serial run\'s halt for another reason lists the branch that waits to land, with its freshness (C128)', async () => {
    // A commits and waits; B, which does not depend on it, is dispatched and
    // makes no progress, which halts the run owner-choice.
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT] }, actions: { 3: 'noop' } } });
    try {
      strictEqual(await t.run({ lanes: 1 }), 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(r.steps.map((x) => [x.kind, x.subtask_id, x.outcome]), [['dispatch', 'A', 'ok'], ['commit', 'A', 'ok'], ['dispatch', 'B', 'owner-choice']]);
      strictEqual(r.halt.reason, 'owner-choice', r.halt.detail);
      deepStrictEqual(r.halt.waiting?.map((w) => [w.subtaskId, w.branch, w.commit, w.sync?.state]), [['A', 'feat/a', t.git(t.work, 'rev-parse', 'refs/heads/feat/a'), 'ready']], JSON.stringify(r.halt));
      ok(t.lines.some((l) => /^ {2}· A on feat\/a /.test(l)), t.lines.join('\n'));
    } finally {
      t.fx.cleanup();
    }
  });

  it('a serial run that halts before its first report (the macro lock is held) still lists the branch its first look found waiting, unknown (C128)', async () => {
    const t = await setup({ subtasks: [{ id: 'A' }, { id: 'B', blocked_by: ['A'] }], scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT] } } });
    let held = null;
    try {
      strictEqual(await t.run({ lanes: 1 }), 2, t.lines.join('\n'));
      strictEqual(t.latest().halt.reason, 'awaiting-landing');
      held = await L.acquireLock(L.macroLockPath(t.work, t.fx.macroId), { record: { run_id: 'autopilot-20261001T000000Z-eeeeee' } });
      t.lines.length = 0;
      strictEqual(await t.run({ lanes: 1 }), 2, t.lines.join('\n'));
      const r = t.latest();
      strictEqual(r.halt.reason, 'owner-choice', r.halt.detail);
      deepStrictEqual(r.halt.waiting?.map((w) => [w.subtaskId, w.branch, w.sync?.state, w.sync?.detail]), [['A', 'feat/a', 'unknown', 'no report was made for the look that found it']], JSON.stringify(r.halt));
      ok(t.lines.some((l) => /^ {2}· A on feat\/a /.test(l)), t.lines.join('\n'));
    } finally {
      held?.release();
      t.fx.cleanup();
    }
  });

  // C128 — every look of a serial run feeds its list as it returns, and its
  // `finish` builds every halt's list from it.
  it('a serial look a retry replaces still lists what it found waiting: the retry fails, and the halt lists the branch unknown (C128)', async () => {
    // The look after A's commit finds A waiting but cannot list the claims,
    // so it is taken again; the retry fails.
    const t = await setup({ subtasks: [{ id: 'A' }, { id: 'B', blocked_by: ['A'] }], scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT] } } });
    const { observe } = await import(resolve(AP, 'observe.mjs'));
    const { failedView } = await import(resolve(AP, 'offloop.mjs'));
    let stage = 0;
    const look = (a) => {
      if (stage === 1) {
        stage = 2;
        return failedView(a.repoRoot, 'simulated: the look failed');
      }
      const v = observe(a);
      if (stage === 0 && v.children?.A?.location === 'archived') {
        stage = 1;
        return { ...v, claimsError: 'simulated: a claim moved' };
      }
      return v;
    };
    try {
      strictEqual(await t.run({ lanes: 1 }, { observe: look }), 2, t.lines.join('\n'));
      strictEqual(stage, 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(r.steps.map((x) => [x.kind, x.subtask_id]), [['dispatch', 'A'], ['commit', 'A']]);
      deepStrictEqual(r.halt.waiting?.map((w) => [w.subtaskId, w.branch, w.sync?.state, w.sync?.detail]), [['A', 'feat/a', 'unknown', "the run's last look failed (simulated: the look failed)"]], JSON.stringify(r.halt));
      ok(t.lines.some((l) => /^ {2}· A on feat\/a /.test(l)), t.lines.join('\n'));
    } finally {
      t.fx.cleanup();
    }
  });

  it('a serial run the owner interrupts before its next step confirms nothing its halt lists (C128)', async () => {
    // A commits and is reported ready; as the run checks its roots before
    // B's dispatch, the owner interrupts it.
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT] } } });
    let interrupted = false;
    const resolveRoots = async (a) => {
      const roots = await RT.resolveRoots(a);
      if (!interrupted && t.lines.some((l) => l.startsWith('◆ landing-ready: A on feat/a '))) {
        interrupted = true;
        t.signals.emit('SIGINT');
      }
      return roots;
    };
    try {
      strictEqual(await t.run({ lanes: 1 }, { resolveRoots }), 2, t.lines.join('\n'));
      ok(interrupted, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(r.steps.map((x) => [x.kind, x.subtask_id, x.outcome]), [['dispatch', 'A', 'ok'], ['commit', 'A', 'ok']]);
      strictEqual(r.halt.reason, 'interrupted');
      deepStrictEqual(r.landing.map((x) => [x.subtask_id, x.sync.state]), [['A', 'ready']], 'the report said ready before the interrupt');
      deepStrictEqual(r.halt.waiting?.map((w) => [w.subtaskId, w.sync?.state, w.sync?.detail]), [['A', 'unknown', 'the run ended before its last look (the owner interrupted the run)']], JSON.stringify(r.halt));
    } finally {
      t.fx.cleanup();
    }
  });

  it('a serial run that stops on an error before any halt records what waited, unknown, and status shows it (C128)', async () => {
    // A commits and is reported ready; the roots check before B's dispatch throws.
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT] } } });
    const resolveRoots = async (a) => {
      if (t.lines.some((l) => l.startsWith('◆ landing-ready: A on feat/a '))) throw new Error('simulated: the roots check threw');
      return RT.resolveRoots(a);
    };
    try {
      await rejects(t.run({ lanes: 1 }, { resolveRoots }), /simulated: the roots check threw/);
      const r = t.latest();
      strictEqual(r.run.status, 'error');
      strictEqual(r.halt ?? null, null);
      deepStrictEqual(r.landing.map((x) => [x.subtask_id, x.sync.state]), [['A', 'ready']], 'the report said ready before the error');
      const why = 'the run ended before its last look (the run stopped on an error: simulated: the roots check threw)';
      deepStrictEqual(r.run.waiting?.map((w) => [w.subtaskId, w.sync?.state, w.sync?.detail]), [['A', 'unknown', why]], JSON.stringify(r.run));
      const C = await import(resolve(AP, 'cli.mjs'));
      const said = [];
      strictEqual(await C.main(['status', '--repo', t.work], { env: t.env, out: (s) => said.push(s), err: (s) => said.push(`ERR ${s}`) }), 0, said.join('\n'));
      ok(said.some((l) => l === `    · A on feat/a: landing-unknown (${why})`), said.join('\n'));
    } finally {
      t.fx.cleanup();
    }
  });
});

// ADR-0067 Decision 7, docket C128 and C123 — the landing report of a run
// with lanes.
describe('landing reports with lanes', () => {
  it('a commit made while the run drains is reported ready by a last look that fetches, before the run ends', async () => {
    // A's dispatch makes no progress once B's commit has started, which
    // drains the run; B's commit goes on once the drain has begun. A lane's
    // look after its step does not fetch, so only a later look reports B ready.
    const t = await setup({
      scenario: {
        A: { next: [COMMIT] }, B: { next: [COMMIT], file: 'b.txt' },
        actions: { 1: ['wait:b-committing', 'noop'], 3: ['mark-start:b-committing', 'wait:drained'] },
      },
    });
    markOn(t, /^■ lane A: owner-choice/, 'drained');
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      ok(!existsSync(join(t.dir, 'drained.timeout')) && !existsSync(join(t.dir, 'b-committing.timeout')), t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(stepsOf(r).map((x) => [x[0], x[1], x[2], x[4]]), [[1, 'A', 'dispatch', 'owner-choice'], [2, 'B', 'dispatch', 'ok'], [3, 'B', 'commit', 'ok']]);
      strictEqual(r.halt.reason, 'owner-choice');
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
        actions: { 1: ['wait:b-committing', 'noop'], 3: ['mark-start:b-committing', 'wait:drained'] },
      },
    });
    markOn(t, /^■ lane A: owner-choice/, 'drained');
    const { failedView } = await import(resolve(AP, 'offloop.mjs'));
    const observeAsync = async (a, o) => {
      if (existsSync(join(t.dir, 'drained')) && a.repoRoot !== t.lane('B')) return failedView(a.repoRoot, 'simulated: the look failed');
      return observeInChild(a, o);
    };
    try {
      strictEqual(await t.run({}, { observeAsync }), 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(stepsOf(r).map((x) => [x[0], x[1], x[2], x[4]]), [[1, 'A', 'dispatch', 'owner-choice'], [2, 'B', 'dispatch', 'ok'], [3, 'B', 'commit', 'ok']]);
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

  // A reported ready, then B's dispatch makes no progress, which drains the
  // run; the drain's last look fails, or the owner interrupts it.
  const lastLook = async (mode) => {
    const t = await setup({
      scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT] }, actions: { 2: ['wait:a-reported', 'noop'] } },
    });
    markOn(t, /^◆ landing-ready: A on feat\/a /, 'a-reported');
    markOn(t, /^■ lane B: owner-choice/, 'drained');
    const { failedView } = await import(resolve(AP, 'offloop.mjs'));
    const observeAsync = async (a, o) => {
      if (existsSync(join(t.dir, 'drained'))) {
        if (mode === 'fail') return failedView(a.repoRoot, 'simulated: the look failed');
        if (mode === 'macro') {
          // The look runs, but cannot read the macro: it lists nothing waiting.
          return { ...(await observeInChild(a, o)), macro: null, macroLookupError: 'simulated: the macro could not be read', children: {}, landing: {} };
        }
        t.signals.emit('SIGINT');
      }
      return observeInChild(a, o);
    };
    const code = await t.run({}, { observeAsync });
    return { t, code, r: t.latest() };
  };
  const statusText = async (t) => {
    const C = await import(resolve(AP, 'cli.mjs'));
    const said = [];
    strictEqual(await C.main(['status', '--repo', t.work], { env: t.env, out: (s) => said.push(s), err: (s) => said.push(`ERR ${s}`) }), 0, said.join('\n'));
    return said.join('\n');
  };

  it('a drain whose last look fails leaves no freshness standing: a lane reported ready is unknown', async () => {
    const { t, code, r } = await lastLook('fail');
    try {
      strictEqual(code, 2, t.lines.join('\n'));
      ok(!existsSync(join(t.dir, 'a-reported.timeout')), t.lines.join('\n'));
      strictEqual(r.halt.reason, 'owner-choice');
      strictEqual(r.halt.waiting, null, 'a halt for another reason lists no waiting branch');
      deepStrictEqual(r.landing.map((x) => [x.subtask_id, x.sync.state]), [['A', 'ready']]);
      const a = bySubtask(r).A.waiting;
      deepStrictEqual([a.sync.state, a.sync.detail], ['unknown', "the run's last look failed (simulated: the look failed)"]);
      ok(t.lines.some((l) => /waiting to land: feat\/a .* · freshness unknown$/.test(l)), t.lines.join('\n'));
      // The logs keep what was observed (a failed look observes nothing);
      // status shows the lane as the run left it, after the earlier record.
      const { landingLogPath, readLandingLog } = await import(resolve(AP, 'landing-ready.mjs'));
      deepStrictEqual(readLandingLog(landingLogPath(t.work, t.fx.macroId)).map((x) => [x.subtask_id, x.sync.state]), [['A', 'ready']]);
      const said = await statusText(t);
      match(said, /◆ landing-ready after \[\d+\]: A on feat\/a /);
      match(said, /\n {2}lane A · [^\n]* · landing-unknown \(the run's last look failed \(simulated: the look failed\)\)/);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a drain whose last look cannot read the macro keeps each waiting lane, unknown, instead of dropping it', async () => {
    const { t, code, r } = await lastLook('macro');
    try {
      strictEqual(code, 2, t.lines.join('\n'));
      strictEqual(r.halt.reason, 'owner-choice');
      const a = bySubtask(r).A.waiting;
      ok(a, `lane A is still listed waiting: ${JSON.stringify(bySubtask(r).A)}`);
      deepStrictEqual([a.branch, a.sync.state, a.sync.detail], ['feat/a', 'unknown', "the run's last look failed (the macro could not be read: simulated: the macro could not be read)"]);
      deepStrictEqual(r.halt.lanes.find((l) => l.subtask_id === 'A')?.waiting?.sync?.state, 'unknown', 'halt.json carries it too');
      match(await statusText(t), /\n {2}lane A · [^\n]* · landing-unknown \(the run's last look failed \(the macro could not be read/);
    } finally {
      t.fx.cleanup();
    }
  });

  it('an interrupt during the drain\'s last look ends the run interrupted, and confirms nothing: a lane reported ready is unknown', async () => {
    const { t, code, r } = await lastLook('interrupt');
    try {
      strictEqual(code, 2, t.lines.join('\n'));
      strictEqual(r.halt.reason, 'interrupted', t.lines.join('\n'));
      ok(/while it drained after owner-choice/.test(r.halt.detail), r.halt.detail);
      deepStrictEqual(r.landing.map((x) => [x.subtask_id, x.sync.state]), [['A', 'ready']]);
      const unlooked = "the run ended before its last look (the owner interrupted the run)";
      deepStrictEqual([bySubtask(r).A.waiting?.sync?.state, bySubtask(r).A.waiting?.sync?.detail], ['unknown', unlooked], JSON.stringify(bySubtask(r).A));
      deepStrictEqual(r.halt.lanes.find((l) => l.subtask_id === 'A')?.waiting?.sync?.state, 'unknown', 'halt.json carries it too');
      ok(t.lines.some((l) => /waiting to land: feat\/a .* · freshness unknown$/.test(l)), t.lines.join('\n'));
      match(await statusText(t), /\n {2}lane A · [^\n]* · landing-unknown \(the run ended before its last look/);
    } finally {
      t.fx.cleanup();
    }
  });

  // C128 — every end of a run reconciles the run's list with the latest
  // observation it holds before its report is built.
  it('an interrupt while a step settles: the lane it committed is listed unknown, and a lane that landed meanwhile is not listed', async () => {
    // A commits and is reported ready; B's dispatch starts then. As B's
    // commit settles, A lands and the owner interrupts the run: the settling
    // look is the run's last.
    const t = await setup({
      scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT], file: 'b.txt' }, actions: { 2: ['wait:a-reported'] } },
    });
    markOn(t, /^◆ landing-ready: A on feat\/a /, 'a-reported');
    let interrupted = false;
    const observeAsync = async (a, o) => {
      const v = await observeInChild(a, o);
      if (interrupted || a.repoRoot !== t.lane('B') || v.children?.B?.location !== 'archived') return v;
      interrupted = true;
      t.fx.setPrs([t.fx.land('A', 'feat/a', { number: 7 })]);
      t.signals.emit('SIGINT');
      return observeInChild(a, o);
    };
    try {
      strictEqual(await t.run({}, { observeAsync }), 2, t.lines.join('\n'));
      ok(interrupted && !existsSync(join(t.dir, 'a-reported.timeout')), t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(stepsOf(r).map((x) => [x[1], x[2], x[4]]), [['A', 'dispatch', 'ok'], ['B', 'dispatch', 'ok'], ['A', 'commit', 'ok'], ['B', 'commit', 'interrupted']]);
      strictEqual(r.halt.reason, 'interrupted');
      deepStrictEqual(r.landing.map((x) => [x.subtask_id, x.sync.state]), [['A', 'ready']], 'B was never reported: the run was interrupted first');
      strictEqual(bySubtask(r).A.waiting, undefined, `A landed: ${JSON.stringify(bySubtask(r).A)}`);
      const b = bySubtask(r).B.waiting;
      deepStrictEqual([b?.branch, b?.sync?.state, b?.sync?.detail], ['feat/b', 'unknown', 'the run ended before its last look (the owner interrupted the run)'], JSON.stringify(bySubtask(r).B));
    } finally {
      t.fx.cleanup();
    }
  });

  it('a run that stops on an error confirms nothing it lists', async () => {
    // Run 1 halts awaiting-landing with A and B ready; the relaunch's first
    // look throws.
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT], file: 'b.txt' } } });
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      deepStrictEqual(t.latest().halt.waiting.map((w) => [w.subtaskId, w.sync.state]), [['A', 'ready'], ['B', 'ready']]);
      const observeAsync = async () => { throw new Error('simulated: the look threw'); };
      await rejects(t.run({}, { observeAsync }), /simulated: the look threw/);
      const r = t.latest();
      strictEqual(r.run.status, 'error');
      const why = 'the run ended before its last look (the run stopped on an error: simulated: the look threw)';
      deepStrictEqual(['A', 'B'].map((id) => [bySubtask(r)[id]?.waiting?.sync?.state, bySubtask(r)[id]?.waiting?.sync?.detail]), [['unknown', why], ['unknown', why]], JSON.stringify(bySubtask(r)));
    } finally {
      t.fx.cleanup();
    }
  });

  it('the look a run\'s end takes for its proposals feeds its list: a lane that landed before it is not listed', async () => {
    // A commits and is reported ready; B's dispatch then ends on its conflict
    // gate, which drains the run. A lands just before the end's own look.
    const t = await setup({
      scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT] }, actions: { 2: ['wait:a-reported', 'conflict-gate'] } },
    });
    markOn(t, /^◆ landing-ready: A on feat\/a /, 'a-reported');
    let landed = false;
    const observeAsync = async (a, o) => {
      // The only look without a fetch in the driver's checkout is the end's.
      if (!landed && a.repoRoot === t.work && a.fetch === false) {
        landed = true;
        t.fx.setPrs([t.fx.land('A', 'feat/a', { number: 7 })]);
      }
      return observeInChild(a, o);
    };
    try {
      strictEqual(await t.run({}, { observeAsync }), 2, t.lines.join('\n'));
      ok(landed && !existsSync(join(t.dir, 'a-reported.timeout')), t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual([r.halt.reason, r.halt.subtask_id, r.halt.proposals.map((p) => p.subtask_id)], ['awaiting-owner:peer-conflict', 'B', ['B']]);
      deepStrictEqual(r.landing.map((x) => [x.subtask_id, x.sync.state]), [['A', 'ready']]);
      strictEqual(bySubtask(r).A.waiting, undefined, `A landed: ${JSON.stringify(bySubtask(r).A)}`);
      strictEqual(r.halt.lanes.find((l) => l.subtask_id === 'A')?.waiting, undefined);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a failed look feeds the run\'s list too: when the end\'s own look fails, a lane reported ready is unknown', async () => {
    // As above, but the end's own look fails instead.
    const t = await setup({
      scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT] }, actions: { 2: ['wait:a-reported', 'conflict-gate'] } },
    });
    markOn(t, /^◆ landing-ready: A on feat\/a /, 'a-reported');
    const { failedView } = await import(resolve(AP, 'offloop.mjs'));
    let failed = false;
    const observeAsync = async (a, o) => {
      if (!failed && a.repoRoot === t.work && a.fetch === false) {
        failed = true;
        return failedView(a.repoRoot, 'simulated: the look failed');
      }
      return observeInChild(a, o);
    };
    try {
      strictEqual(await t.run({}, { observeAsync }), 2, t.lines.join('\n'));
      ok(failed && !existsSync(join(t.dir, 'a-reported.timeout')), t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual([r.halt.reason, r.halt.subtask_id], ['awaiting-owner:peer-conflict', 'B']);
      deepStrictEqual(r.landing.map((x) => [x.subtask_id, x.sync.state]), [['A', 'ready']]);
      const a = bySubtask(r).A.waiting;
      deepStrictEqual([a?.sync?.state, a?.sync?.detail], ['unknown', "the run's last look failed (simulated: the look failed)"], JSON.stringify(bySubtask(r).A));
    } finally {
      t.fx.cleanup();
    }
  });

  // A commits and is reported ready while B's dispatch ends on its conflict
  // gate, whose proposal B's lane keeps; the owner clears the gate before the
  // next look, so B goes on to commit, and the run halts awaiting-landing with
  // nothing left to start. The end's own look (for the proposal) is where A
  // lands, or where the owner interrupts the run.
  const idleEnd = async (mode) => {
    const t = await setup({
      scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT], file: 'b.txt' }, actions: { 2: ['wait:a-reported', 'conflict-gate'] } },
    });
    markOn(t, /^◆ landing-ready: A on feat\/a /, 'a-reported');
    const ENG = await import(join(ROOTS.engineer, 'scripts', 'state.mjs'));
    let cleared = false;
    let ended = false;
    const observeAsync = async (a, o) => {
      if (!ended && a.repoRoot === t.work && a.fetch === false) {
        ended = true;
        if (mode === 'land') t.fx.setPrs([t.fx.land('A', 'feat/a', { number: 7 })]);
        else t.signals.emit('SIGINT');
      }
      const v = await observeInChild(a, o);
      if (!cleared && a.repoRoot === t.lane('B') && v.children?.B?.awaiting_owner?.gate === 'peer-conflict') {
        cleared = true;
        await ENG.clearAwaitingOwner({
          workflowPath: v.children.B.path, host: 'claude', gate: 'peer-conflict', nextStep: COMMIT,
          nextAction: 'Commit', resolution: 'simulated: the owner decided', env: {},
        });
      }
      return v;
    };
    const code = await t.run({}, { observeAsync });
    ok(cleared && ended && !existsSync(join(t.dir, 'a-reported.timeout')), t.lines.join('\n'));
    return { t, code, r: t.latest() };
  };

  // The end's look does not fetch, so the B it keeps was judged ready against
  // the tip before A landed: it is unknown, never ready (C128, the
  // A-lands-then-B sequence).
  it('an awaiting-landing halt lists what the run\'s list holds as it ends: a lane that landed during the end\'s own look is not listed, and the other keeps no ready', async () => {
    const { t, code, r } = await idleEnd('land');
    try {
      strictEqual(code, 2, t.lines.join('\n'));
      deepStrictEqual(stepsOf(r).map((x) => [x[1], x[2], x[4]]), [['A', 'dispatch', 'ok'], ['B', 'dispatch', 'ok'], ['A', 'commit', 'ok'], ['B', 'commit', 'ok']]);
      strictEqual(r.halt.reason, 'awaiting-landing', r.halt.detail);
      const why = 'subtask A landed after the look that judged it ready, and this look did not fetch';
      deepStrictEqual(r.halt.waiting?.map((w) => [w.subtaskId, w.sync?.state, w.sync?.detail]), [['B', 'unknown', why]], JSON.stringify(r.halt.waiting));
      deepStrictEqual(bySubtask(r).B.waiting?.sync?.state, 'unknown', JSON.stringify(bySubtask(r).B));
      strictEqual(bySubtask(r).A.waiting, undefined, `A landed: ${JSON.stringify(bySubtask(r).A)}`);
      ok(!t.lines.some((l) => /^ {2}· A on feat\/a /.test(l)), t.lines.join('\n'));
      ok(t.lines.some((l) => /^ {2}· B on feat\/b /.test(l)), t.lines.join('\n'));
    } finally {
      t.fx.cleanup();
    }
  });

  it('an awaiting-landing halt the owner interrupts as the run ends confirms nothing it lists', async () => {
    const { t, code, r } = await idleEnd('interrupt');
    try {
      strictEqual(code, 2, t.lines.join('\n'));
      strictEqual(r.halt.reason, 'awaiting-landing', r.halt.detail);
      const why = 'the run ended before its last look (the owner interrupted the run)';
      deepStrictEqual(r.halt.waiting?.map((w) => [w.subtaskId, w.sync?.state, w.sync?.detail]), [['A', 'unknown', why], ['B', 'unknown', why]], JSON.stringify(r.halt.waiting));
      deepStrictEqual(['A', 'B'].map((id) => bySubtask(r)[id]?.waiting?.sync?.state), ['unknown', 'unknown']);
    } finally {
      t.fx.cleanup();
    }
  });

  it('the end\'s own look, which has no report, never restores a readiness a later look took away', async () => {
    // As above, but A does not land: the drain's last look fails, and the
    // end's look succeeds without a fetch or a report of its own.
    const t = await setup({
      scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT] }, actions: { 2: ['wait:a-reported', 'conflict-gate'] } },
    });
    markOn(t, /^◆ landing-ready: A on feat\/a /, 'a-reported');
    markOn(t, /^■ lane B: awaiting-owner:peer-conflict/, 'drained');
    const { failedView } = await import(resolve(AP, 'offloop.mjs'));
    let endLooks = 0;
    const observeAsync = async (a, o) => {
      if (existsSync(join(t.dir, 'drained')) && a.repoRoot === t.work) {
        if (a.fetch !== false) return failedView(a.repoRoot, 'simulated: the look failed');
        endLooks += 1;
      }
      return observeInChild(a, o);
    };
    try {
      strictEqual(await t.run({}, { observeAsync }), 2, t.lines.join('\n'));
      strictEqual(endLooks, 1, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(r.landing.map((x) => [x.subtask_id, x.sync.state]), [['A', 'ready']]);
      const a = bySubtask(r).A.waiting;
      deepStrictEqual([a?.sync?.state, a?.sync?.detail], ['unknown', "the run's last look failed (simulated: the look failed)"], JSON.stringify(bySubtask(r).A));
    } finally {
      t.fx.cleanup();
    }
  });

  it('a log that cannot be read or written is reported once across the run\'s looks, its off-loop reports included', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT], file: 'b.txt' } } });
    try {
      const { landingLogPath } = await import(resolve(AP, 'landing-ready.mjs'));
      mkdirSync(landingLogPath(t.work, t.fx.macroId), { recursive: true });
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      const r = t.latest();
      strictEqual(r.halt.reason, 'awaiting-landing');
      deepStrictEqual(r.landing, []);
      strictEqual(t.lines.filter((l) => l.startsWith('⚠ landing-ready')).length, 1, t.lines.join('\n'));
      // The report stood: the halt lists what it found.
      deepStrictEqual(r.halt.waiting.map((w) => w.sync.state), ['ready', 'ready']);
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('forced resume', () => {
  it('with two active children --next needs --lane; --lane A --next replaces only A\'s judgment halt, and runs first', async () => {
    const LOW = { kind: 'verb', verb: 'critique', confidence: 'LOW' };
    const t = await setup({
      scenario: { A: { next: [LOW, COMMIT], file: true }, B: { next: [COMMIT, COMMIT], file: 'b.txt' }, actions: { 1: 'wait:b-started', 2: 'mark-start:b-started' } },
    });
    try {
      // Run 1: A's dispatch asks for a LOW-confidence critique: the run drains.
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      strictEqual(t.latest().halt.reason, 'low-confidence');
      // Two active children: --next without --lane is refused.
      strictEqual(await t.run({ forcedPairs: [{ lane: null, step: { kind: 'verb', verb: 'critique' } }] }), 2);
      match(t.latest().halt.detail, /name the lane with --lane/);
      strictEqual(t.latest().steps.length, 0);
      // --lane A: A's forced critique starts first; B commits; both wait to land.
      strictEqual(await t.run({ forcedPairs: [{ lane: 'A', step: { kind: 'verb', verb: 'critique' } }] }), 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual([r.steps[0].lane, r.steps[0].kind, r.steps[0].forced], ['A', 'verb', true]);
      deepStrictEqual(r.steps.map((x) => [x.lane, x.kind]).sort(), [['A', 'commit'], ['A', 'verb'], ['B', 'commit']]);
      strictEqual(r.halt.reason, 'awaiting-landing');
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('preview --lanes 2', () => {
  it('shows the reconciliation plan and the first wave, with the lane each step runs in; it spawns and creates nothing', async () => {
    const t = await setup({ scenario: {} });
    const C = await import(resolve(AP, 'cli.mjs'));
    try {
      const out = [];
      const code = await C.main(['preview', '--lanes', '2', '--macro', t.fx.macroId, '--repo', t.work], { env: t.env, out: (x) => out.push(x), err: (x) => out.push(`ERR ${x}`) });
      strictEqual(code, 0, out.join('\n'));
      const text = out.join('\n');
      match(text, /lanes \(--lanes 2\):/);
      match(text, new RegExp(`A: /orchestrator:next A --workflow=${t.fx.macroId} · in ${t.lane('A')} \\(a new lane\\)`));
      match(text, /B: \/orchestrator:next B .*\(a new lane\) · starts once the first worker's rate-limit event opens the throttle/);
      match(text, new RegExp(`start --execute --macro ${t.fx.macroId} --lanes 2`));
      ok(!existsSync(t.lane('A')) && !existsSync(join(t.dir, 'claude.log')), 'nothing was created or spawned');
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('start conditions with lanes', () => {
  it('the capability floor runs state-root in the pinned engineer and orchestrator, and finds the PL and RR tokens', async () => {
    const t = await setup({ scenario: {} });
    const bare = mkdtempSync(join(tmpdir(), 'lanes-floor-'));
    try {
      deepStrictEqual(RT.lanesCapabilityProblems(ROOTS, t.work, { env: t.env }), []);
      mkdirSync(join(bare, 'scripts', 'lib'), { recursive: true });
      writeFileSync(join(bare, 'scripts', 'state.mjs'), 'process.exit(2)\n');
      writeFileSync(join(bare, 'scripts', 'lib', 'entry-brief-readers.mjs'), '// no read set\n');
      const problems = RT.lanesCapabilityProblems({ orchestrator: ORCH, engineer: bare, runtime: bare }, t.work, { env: t.env });
      deepStrictEqual(problems.map((p) => /state-root --repo-root|--parent-workflow-path|shared state root/.exec(p)?.[0]),
        ['state-root --repo-root', '--parent-workflow-path', 'shared state root']);
    } finally {
      rmSync(bare, { recursive: true, force: true });
      t.fx.cleanup();
    }
  });

  it('a run with lanes refuses to start, and records no run, while shared creation is off', async () => {
    const t = await setup({ scenario: {} });
    try {
      SR.disableSharedCreation({ checkout: t.work });
      strictEqual(await t.run(), 1, t.lines.join('\n'));
      ok(t.lines.some((l) => /ERR .*lanes need shared creation on/.test(l)), t.lines.join('\n'));
      deepStrictEqual(L.listRuns(t.work), []);
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('what changes while a step is admitted', () => {
  it('a step that ended while another lane\'s admission awaited is settled first: its halt drains the run, and the other lane\'s step never spawns', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT] }, B: { next: [COMMIT] }, actions: { 1: ['noop', 'mark:a-ended'] } } });
    let held = false;
    try {
      const code = await t.run({}, {
        // B's lane is looked at only once A's step has ended.
        observeAsync: async (a, o) => {
          if (a.repoRoot === t.lane('B') && !held) {
            held = true;
            await until(join(t.dir, 'a-ended'));
            await pause(3000);
          }
          return observeInChild(a, o);
        },
      });
      strictEqual(code, 2, t.lines.join('\n'));
      ok(held, 'B was admitted while A ran');
      const r = t.latest();
      deepStrictEqual(stepsOf(r).map((x) => [x[1], x[2], x[4]]), [['A', 'dispatch', 'owner-choice']], 'B never spawned');
      strictEqual(r.halt.subtask_id, 'A');
      // Decision 5: the drain leaves no lane without its step.
      ok(!existsSync(t.lane('B')), 'B\'s lane, created for a step that never spawned, is removed');
      strictEqual(bySubtask(r).B.state, 'removed (no step used it)');
    } finally {
      t.fx.cleanup();
    }
  });

  it('a look that fails after a step halts the run unverified, and keeps the run\'s open-run record for the next run\'s cleanup', async () => {
    const t = await setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [COMMIT], file: true }, actions: { 1: 'mark:break' } } });
    try {
      const code = await t.run({}, {
        observeAsync: async (a, o) => (existsSync(join(t.dir, 'break')) && a.repoRoot === t.lane('A')
          ? { ...(await observeInChild(a, o)), lookError: 'injected', macro: null, children: {} }
          : observeInChild(a, o)),
      });
      strictEqual(code, 2, t.lines.join('\n'));
      const r = t.latest();
      strictEqual(r.halt.reason, 'owner-choice');
      match(r.halt.detail, /after step 1 failed \(injected\); the step's result could not be verified/);
      deepStrictEqual(L.listOpenRuns(t.work).map((x) => x.runId), [r.run.run_id], 'the record is kept');
      deepStrictEqual(L.readLockEntries(L.macroLockPath(t.work, t.fx.macroId)), [], 'the locks are released all the same');
    } finally {
      t.fx.cleanup();
    }
  });

  // C92: a step that succeeded, judged from a look that could not read what
  // verifyStep compares, halts on that read — not on a postcondition that
  // read nothing — and, its peers unaccounted for, keeps the open-run record.
  for (const [what, inject, re] of [
    ['the macro', (v) => ({ ...v, macro: null, macroLookupError: 'injected' }), /the look after the step could not read the macro \(injected\)/],
    ['its readiness', (v) => ({ ...v, ready: null, readyError: 'injected' }), /the look after the step could not read the macro's readiness \(injected\)/],
    ['the step\'s own child', (v) => ({ ...v, children: { ...v.children, A: { location: 'error', detail: 'injected' } } }), /the look after the step could not read subtask A's engineer workflow \(injected\)/],
  ]) {
    it(`a step that succeeded, judged from a look that could not read ${what}, halts on that read and keeps the run's open-run record`, async () => {
      const t = await setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [COMMIT], file: true }, actions: { 1: 'mark:break' } } });
      try {
        const code = await t.run({}, {
          observeAsync: async (a, o) => {
            const v = await observeInChild(a, o);
            return existsSync(join(t.dir, 'break')) && a.repoRoot === t.lane('A') ? inject(v) : v;
          },
        });
        strictEqual(code, 2, t.lines.join('\n'));
        const r = t.latest();
        deepStrictEqual(stepsOf(r).map((x) => [x[1], x[2], x[4]]), [['A', 'dispatch', 'owner-choice']]);
        strictEqual(r.steps[0].peers_unaccounted, true, 'the finished line tells the cleanup to search this step');
        match(r.halt.detail, re);
        ok(!/left subtask A/.test(r.halt.detail), r.halt.detail);
        deepStrictEqual(L.listOpenRuns(t.work).map((x) => x.runId), [r.run.run_id], 'the record is kept');
        deepStrictEqual(L.readLockEntries(L.macroLockPath(t.work, t.fx.macroId)), [], 'the locks are released all the same');
      } finally {
        t.fx.cleanup();
      }
    });
  }

  it('a prepared lane\'s dispatch is checked against the baseline as it is when the step is admitted', async () => {
    const t = await setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [COMMIT], file: true } } });
    try {
      // A prepared lane: cut at the baseline, its subtask still pending.
      const made = LN.createLane({ home: t.home, checkout: t.work, macroId: t.fx.macroId, subtask: { id: 'A', branch: 'feat/a', status: 'pending' }, view: { macro: { fm: { plan: { subtasks: [{ id: 'A', branch: 'feat/a', status: 'pending' }] } } }, children: {}, claims: [] }, baseline: 'main', env: t.fx.env });
      ok(made.ok, JSON.stringify(made.halt));
      let moved = false;
      const code = await t.run({}, {
        observeAsync: async (a, o) => {
          // The baseline moves after the reconciliation judged the lane.
          if (a.repoRoot === t.lane('A') && !moved) {
            moved = true;
            const other = join(t.dir, 'other');
            execFileSync('git', ['clone', '-q', t.fx.origin, other], { env: t.fx.env });
            writeFileSync(join(other, 'moved.txt'), 'moved\n');
            t.git(other, 'add', 'moved.txt');
            t.git(other, 'commit', '-q', '-m', 'feat: moved');
            t.git(other, 'push', '-q', 'origin', 'HEAD:main');
          }
          return observeInChild(a, o);
        },
      });
      strictEqual(code, 2, t.lines.join('\n'));
      ok(moved);
      const r = t.latest();
      strictEqual(r.steps.length, 0, 'no dispatch into a lane cut from an old baseline');
      match(r.halt.detail, /the baseline moved since the lane was cut/);
    } finally {
      t.fx.cleanup();
    }
  });
});
