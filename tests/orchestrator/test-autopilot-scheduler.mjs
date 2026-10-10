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
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
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
      strictEqual(r.landing.length, 2, 'each commit reported landing-ready');
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
  it('a five-hour window at 0.85 or more starts no new lane, while the started lane keeps stepping; with nothing to refresh it and a reset after the deadline, the run halts budget', async () => {
    const throttled = { ...OPEN(), unifiedWindows: { five_hour: { utilization: 0.9, resetsAt: hour() }, seven_day: { utilization: 0.4, resetsAt: hour() + 86400 } } };
    const t = await setup({ scenario: { A: { next: [CRITIQUE, COMMIT], file: true }, B: { next: [COMMIT] } }, rateLimit: throttled });
    try {
      strictEqual(await t.run({ maxTimeSec: 600 }), 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(stepsOf(r).map((x) => [x[1], x[2]]), [['A', 'dispatch'], ['A', 'verb'], ['A', 'commit']], 'B never started');
      strictEqual(r.halt.reason, 'budget');
      match(r.halt.detail, /five-hour rate-limit window .* after the run's deadline/);
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
