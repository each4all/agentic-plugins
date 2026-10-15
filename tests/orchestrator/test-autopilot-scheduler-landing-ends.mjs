// tests/orchestrator/test-autopilot-scheduler-landing-ends.mjs
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
// This file: landing reports with lanes, the drain's last look and every end of a run.
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

// ADR-0067 Decision 7, docket C128 and C123 — the landing report of a run
// with lanes.
describe('landing reports with lanes', () => {
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
});
