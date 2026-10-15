// tests/orchestrator/test-autopilot-scheduler-serial.mjs
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
// This file: the throttle, landing order and the serial driver.
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
