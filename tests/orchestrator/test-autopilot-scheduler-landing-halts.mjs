// tests/orchestrator/test-autopilot-scheduler-landing-halts.mjs
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
// This file: landing reports with lanes, the awaiting-landing halt and its end's own look.
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
// ADR-0068 Decision 1: a lane halt parks its lane and drains nothing, so the
// drain a test here needs is a run-wide one: version drift, seen once a step
// has written <dir>/drift.
const driftOn = (t) => ({
  resolveRoots: async (o) => {
    const r = await RT.resolveRoots(o);
    return existsSync(join(t.dir, 'drift')) ? { ...r, versions: { ...r.versions, engineer: '99.0.0' } } : r;
  },
});
const { observeInChild } = await import(resolve(AP, 'offloop.mjs'));
const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });
const until = async (file) => { for (let i = 0; i < 600 && !existsSync(file); i += 1) await pause(50); };

// ADR-0067 Decision 7, docket C128 and C123 — the landing report of a run
// with lanes.
describe('landing reports with lanes', () => {
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
      scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT] }, actions: { 2: ['wait:a-reported', 'conflict-gate', 'mark:drift'] } },
    });
    markOn(t, /^◆ landing-ready: A on feat\/a /, 'a-reported');
    markOn(t, /^■ version-drift/, 'drained');
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
      strictEqual(await t.run({}, { observeAsync, ...driftOn(t) }), 2, t.lines.join('\n'));
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
