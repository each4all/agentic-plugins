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
//
// This file: two lanes, a lane halt that parks its lane, the drain, budgets, forced resume, preview, start
// conditions and admission.
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
const PK = await import(resolve(AP, 'parks.mjs'));
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

describe('a lane halt parks its lane (ADR-0068 Decision 1)', () => {
  it('a halt in one lane parks that lane only: the other lane\'s step in flight runs to its end and the lane goes on, nothing new starts in the parked lane, every lane is reported once', async () => {
    // A's dispatch changes nothing (a dispatch that left its subtask
    // pending), once B's has started; B's goes on only once A is parked.
    const t = await setup({
      scenario: {
        A: { next: [COMMIT] }, B: { next: [COMMIT], file: 'b.txt' },
        actions: { 1: ['wait:b-started', 'noop'], 2: ['mark-start:b-started', 'wait:parked'] },
      },
    });
    markOn(t, /^■ lane A: owner-choice/, 'parked');
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      ok(!existsSync(join(t.dir, 'parked.timeout')), 'B was still running when A parked');
      const r = t.latest();
      deepStrictEqual(stepsOf(r).map((x) => [x[1], x[2], x[4]]).sort(), [['A', 'dispatch', 'owner-choice'], ['B', 'commit', 'ok'], ['B', 'dispatch', 'ok']]);
      ok(!t.lines.some((l) => /draining/.test(l)), 'a lane halt drains nothing');
      ok(t.lines.some((l) => /^ {2}other lanes continue/.test(l)), t.lines.join('\n'));
      // The run ends when every remaining lane waits: A parked, B waiting to
      // land; the first lane still parked is the reason.
      deepStrictEqual([r.halt.reason, r.halt.subtask_id], ['owner-choice', 'A']);
      match(r.halt.resolution.release, new RegExp(`release A --macro ${t.fx.macroId}`));
      const lanes = bySubtask(r);
      deepStrictEqual([lanes.A.state, lanes.A.park.reason], ['parked', 'owner-choice']);
      deepStrictEqual([lanes.B.state, lanes.B.last_step.kind, lanes.B.last_step.outcome, lanes.B.halt], ['waiting-to-land', 'commit', 'ok', null]);
      deepStrictEqual(r.halt.lanes.map((l) => l.subtask_id), ['A', 'B']);
      strictEqual(t.lines.filter((l) => /^ {2}lane B /.test(l)).length, 1, 'each lane is reported once');
      ok(existsSync(t.lane('A')) && existsSync(t.lane('B')), 'the run keeps the lanes');
      // The park is kept in the macro's records, with the lane's fingerprint.
      const kept = PK.readPark(t.work, t.fx.macroId, 'A');
      deepStrictEqual([kept.state, kept.record.state, kept.record.reason, kept.record.form], ['ok', 'parked', 'owner-choice', 'lane']);
      deepStrictEqual(PK.readPark(t.work, t.fx.macroId, 'B'), { state: 'absent' }, 'B\'s step markers were settled');
      strictEqual(r.run.status, 'halted');
    } finally {
      t.fx.cleanup();
    }
  });

  it('simultaneous halts: both lanes park, the first in plan order is the run\'s reason and the other is kept beside it', async () => {
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
      ok(lanes.A.park && lanes.B.park, 'each lane keeps its own park');
      deepStrictEqual([r.halt.subtask_id, r.halt.also.map((x) => [x.subtask_id, x.parked])], ['A', [['B', true]]]);
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('drain (W2)', () => {
  it('a run-wide halt drains the run: a plan change revokes the approval while the other lane\'s step is in flight, which runs to its end and is recorded; nothing new starts', async () => {
    // B's dispatch edits the plan (the approval no longer holds) while A's
    // runs; A's goes on only once the run drains.
    const t = await setup({
      scenario: {
        A: { next: [COMMIT], file: true }, B: { next: [COMMIT], file: 'b.txt' },
        actions: { 1: ['mark-start:a-started', 'wait:drained'], 2: ['wait:a-started', 'edit-plan'] },
      },
    });
    markOn(t, /^■ plan-unapproved/, 'drained');
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      ok(!existsSync(join(t.dir, 'drained.timeout')), 'A was still running when the drain began');
      const r = t.latest();
      deepStrictEqual(stepsOf(r).map((x) => [x[1], x[2], x[4]]).sort(), [['A', 'dispatch', 'ok'], ['B', 'dispatch', 'ok']], 'nothing new started');
      strictEqual(r.halt.reason, 'plan-unapproved');
      ok(t.lines.some((l) => /draining: 1 step\(s\) in flight/.test(l)), t.lines.join('\n'));
      deepStrictEqual(r.halt.lanes.map((l) => [l.subtask_id, l.state]), [['A', 'active'], ['B', 'active']]);
      deepStrictEqual(PK.readParks(t.work, t.fx.macroId).records, [], 'a drain keeps no park');
      ok(existsSync(t.lane('A')) && existsSync(t.lane('B')), 'a drain keeps the lanes');
      strictEqual(r.run.status, 'halted');
    } finally {
      t.fx.cleanup();
    }
  });

  it('SIGTERM during a drain aborts the step still in flight (interrupted) instead of waiting for it, and keeps the lanes', async () => {
    const t = await setup({
      scenario: { A: { next: [COMMIT] }, B: { next: [COMMIT] }, actions: { 1: ['mark-start:a-started', 'wait:never'], 2: ['wait:a-started', 'edit-plan'] } },
    });
    const push = t.lines.push.bind(t.lines);
    t.lines.push = (line) => {
      if (/^■ plan-unapproved/.test(line)) setTimeout(() => t.signals.emit('SIGTERM'), 50);
      return push(line);
    };
    try {
      const startedAt = Date.now();
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      ok(Date.now() - startedAt < 55_000, 'the run did not wait out the step in flight');
      const r = t.latest();
      const a = r.steps.find((x) => x.lane === 'A');
      deepStrictEqual([a.aborted, a.outcome], ['interrupted', 'interrupted']);
      strictEqual(r.halt.reason, 'interrupted');
      match(r.halt.detail, /while it drained after plan-unapproved/);
      deepStrictEqual(PK.readParks(t.work, t.fx.macroId).records, [], 'an interrupt parks nothing');
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

describe('forced resume', () => {
  it('with two active children --next needs --lane; --lane A --next ends only A\'s kept park and runs first; B\'s persisting judgment halt keeps B parked', async () => {
    const LOW = { kind: 'verb', verb: 'critique', confidence: 'LOW' };
    const t = await setup({
      scenario: { A: { next: [LOW, COMMIT], file: true }, B: { next: [LOW, COMMIT], file: 'b.txt' }, actions: { 1: 'wait:b-started', 2: 'mark-start:b-started' } },
    });
    try {
      // Run 1: each dispatch asks for a LOW-confidence critique: both lanes park.
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      deepStrictEqual([t.latest().halt.reason, t.latest().halt.subtask_id, t.latest().halt.also.map((x) => x.subtask_id)], ['low-confidence', 'A', ['B']]);
      // Two active children: --next without --lane is refused.
      strictEqual(await t.run({ forcedPairs: [{ lane: null, step: { kind: 'verb', verb: 'critique' } }] }), 2);
      match(t.latest().halt.detail, /name the lane with --lane/);
      strictEqual(t.latest().steps.length, 0);
      // --lane A: A's kept park ends and its forced critique starts first; B
      // stays parked on its unchanged record (ADR-0068 Decision 1, item 8).
      strictEqual(await t.run({ forcedPairs: [{ lane: 'A', step: { kind: 'verb', verb: 'critique' } }] }), 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual([r.steps[0].lane, r.steps[0].kind, r.steps[0].forced], ['A', 'verb', true]);
      deepStrictEqual(r.steps.map((x) => [x.lane, x.kind]), [['A', 'verb'], ['A', 'commit']]);
      deepStrictEqual([r.halt.reason, r.halt.subtask_id], ['low-confidence', 'B']);
      ok(t.lines.some((l) => /^■ lane B: low-confidence — .*\(kept since run /.test(l)), t.lines.join('\n'));
      strictEqual(bySubtask(r).A.state, 'waiting-to-land');
      deepStrictEqual(PK.readPark(t.work, t.fx.macroId, 'A'), { state: 'absent' });
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
  it('a step that ended while another lane\'s admission awaited is settled first: its halt parks its lane before the other lane\'s step spawns', async () => {
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
      deepStrictEqual(stepsOf(r).map((x) => [x[1], x[2], x[4]]).slice(0, 2), [['A', 'dispatch', 'owner-choice'], ['B', 'dispatch', 'ok']]);
      strictEqual(r.halt.subtask_id, 'A');
      const parkedAt = t.lines.findIndex((l) => /^■ lane A: owner-choice/.test(l));
      const bAt = t.lines.findIndex((l) => /^\[2\] lane B: /.test(l));
      ok(parkedAt !== -1 && bAt > parkedAt, `A was settled and parked before B's step spawned:\n${t.lines.join('\n')}`);
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
