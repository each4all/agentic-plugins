// tests/orchestrator/test-autopilot-lanes-supervision.mjs
//
// ADR-0067 Decision 6 — what a run with lanes does while steps are in flight
// (plugins/orchestrator/adapters/claude/autopilot/scheduler.mjs), end to end
// with the fake claude (fixtures/autopilot-lanes-run.mjs): two workers' budget
// reservations and the throttle beside a started lane; what changes while a
// lane is admitted; a lane-layer failure is that lane's, never the run's; the
// loop keeps serving its workers while lane work runs in a child
// (offloop.mjs); and a driver step's transient states are not halts.

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { AP, bySubtask, COMMIT, hour, L, LN, markOn, OPEN, setup, stepsOf } from './fixtures/autopilot-lanes-run.mjs';

const { startWorker: realStartWorker } = await import(resolve(AP, 'worker.mjs'));
const { observeInChild, offLoop } = await import(resolve(AP, 'offloop.mjs'));
const { ownChildOnly, peersUnlisted } = await import(resolve(AP, 'scheduler.mjs'));
const { newPendingRuns } = await import(resolve(AP, 'driver.mjs'));
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
async function appears(file, ms = 60_000) {
  for (let i = 0; i < ms / 50 && !existsSync(file); i += 1) await new Promise((r) => { setTimeout(r, 50); });
  return existsSync(file);
}
// A checkout whose fetch blocks: git runs the ssh command through sh, which
// records its pid and sleeps a minute.
function blockingFetch(t) {
  const repo = join(t.dir, 'blocking');
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'ssh://lanes.invalid/x']);
  const pidFile = join(t.dir, 'transport.pid');
  return { repo, pidFile, env: { ...t.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: `echo $$ > '${pidFile}'; sleep 60; :` }, pid: () => Number(readFileSync(pidFile, 'utf8')) };
}
// The run's first off-loop look blocks in that fetch, under the look's own
// name, locks and stop; `then` runs once it blocks.
const blockFirstLook = (b, then) => {
  let blocked = false;
  return (task, args, o) => {
    if (task !== 'observe' || blocked) return offLoop(task, args, o);
    blocked = true;
    appears(b.pidFile).then((found) => { if (found) then(); });
    return offLoop('fetchBaseline', { checkout: b.repo, baseline: 'main' }, { ...o, cwd: b.repo, env: b.env });
  };
};
const THROTTLED = () => ({ ...OPEN(), unifiedWindows: { five_hour: { utilization: 0.9, resetsAt: hour() }, seven_day: { utilization: 0.4, resetsAt: hour() + 86400 } } });
// While B's lane is looked at, the clock passes the five-hour reset: the
// part expires, and the rate limit is unknown with A in flight.
const expireOnB = (t, clock) => async (a, o) => {
  if (a.repoRoot === t.lane('B') && clock.offset === 0) clock.offset = 2 * 3600 * 1000;
  return observeInChild(a, o);
};
const HELD = /no five-hour utilization is known\); a new lane waits for the first event of the worker in flight/;
// The injected answer of one off-loop task.
const failing = (name, error, when = () => true) => (task, args, o) => (task === name && when(args) ? Promise.resolve({ error }) : offLoop(task, args, o));

describe('two workers in flight', () => {
  it('two steps in flight hold two reservations: the second lane\'s worker may spend only what the first one\'s reservation leaves of the run cap', async () => {
    // A's dispatch ends only once B's has started: both reservations are open at once.
    const t = await setup({
      scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT], file: 'b.txt' }, actions: { 1: 'wait:b-started', 2: 'mark-start:b-started' } },
    });
    try {
      strictEqual(await t.run({ maxCostUsd: 30, stepBudgetUsd: 25 }), 2, t.lines.join('\n'));
      ok(!existsSync(join(t.dir, 'b-started.timeout')), 'B started while A ran');
      const r = t.latest();
      const [a, b] = r.steps;
      deepStrictEqual([a.lane, a.step_budget_usd, b.lane, b.step_budget_usd], ['A', 25, 'B', 5], 'min(per-step cap, run cap − spent − reserved)');
      const argvOf = (cwd) => readFileSync(join(t.dir, 'claude.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((x) => x.cwd === cwd)?.argv ?? [];
      const budgetArg = (argv) => argv[argv.indexOf('--max-budget-usd') + 1];
      deepStrictEqual([budgetArg(argvOf(t.lane('A'))), budgetArg(argvOf(t.lane('B')))], ['25', '5'], 'each worker got its own reservation');
      strictEqual(r.halt.reason, 'awaiting-landing');
    } finally {
      t.fx.cleanup();
    }
  });

  it('a forced new lane that is throttled waits while a started lane has a runnable step: that lane steps, and the run halts budget only once nothing can refresh the throttle', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT] } }, rateLimit: THROTTLED() });
    try {
      const code = await t.run({
        maxTimeSec: 600,
        forcedPairs: [{ lane: 'A', step: { kind: 'dispatch', subtaskId: 'A' } }, { lane: 'B', step: { kind: 'dispatch', subtaskId: 'B' } }],
      });
      strictEqual(code, 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(stepsOf(r).map((x) => [x[1], x[2], x[4]]), [['A', 'dispatch', 'ok'], ['A', 'commit', 'ok']], 'A\'s commit ran before the forced B halted the run');
      strictEqual(r.halt.reason, 'budget');
      match(r.halt.detail, /five-hour rate-limit window .* after the run's deadline/);
      ok(!existsSync(t.lane('B')), 'a throttled run creates no lane');
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('what changes while a lane is admitted', () => {
  it('a five-hour part that expires while a new lane is admitted leaves the rate limit unknown: the lane waits for the worker in flight, then starts once nothing runs', async () => {
    // A's dispatch ends only once B has been held back at its spawn.
    const t = await setup({
      scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT], file: 'b.txt' }, actions: { 1: 'wait:b-held' } },
    });
    markOn(t, HELD, 'b-held');
    const clock = { offset: 0 };
    try {
      const code = await t.run({}, { now: () => Date.now() + clock.offset, observeAsync: expireOnB(t, clock) });
      strictEqual(code, 2, t.lines.join('\n'));
      ok(clock.offset > 0, 'B was admitted while A ran');
      ok(!existsSync(join(t.dir, 'b-held.timeout')), 'B was held back at its spawn while A ran');
      const r = t.latest();
      const b = r.steps.find((x) => x.lane === 'B' && x.kind === 'dispatch');
      ok(b, t.lines.join('\n'));
      ok(r.steps.filter((x) => x.seq < b.seq).every((x) => Date.parse(x.ended_at) <= Date.parse(b.started_at)), 'B started with nothing in flight');
      deepStrictEqual(stepsOf(r).map((x) => [x[1], x[2]]).sort(), [['A', 'commit'], ['A', 'dispatch'], ['B', 'commit'], ['B', 'dispatch']]);
      strictEqual(r.halt.reason, 'awaiting-landing');
      // Decision 5: the lane B's held admission created goes at once, and
      // B's later admission creates it again, on the branch the first cut.
      const bLanes = t.lines.filter((l) => /^ {2}lane B: (created|removed)/.test(l));
      strictEqual(bLanes.length, 3, t.lines.join('\n'));
      match(bLanes[0], /lane B: created .* \(new-branch\)$/);
      match(bLanes[1], /lane B: removed .*: no step of this run used it$/);
      match(bLanes[2], /lane B: created .* \(existing-branch\)$/);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a lane created in this run whose first step yielded is removed at once; its branch, cut from the baseline as it was, halts the lane\'s next creation once the baseline moved (row 12)', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT], file: 'b.txt' }, actions: { 1: 'wait:b-held' } } });
    // Once B is held back at its spawn, the baseline moves; then A goes on.
    const push = t.lines.push.bind(t.lines);
    t.lines.push = (line) => {
      if (HELD.test(line) && !existsSync(join(t.dir, 'b-held'))) {
        const other = join(t.dir, 'other');
        execFileSync('git', ['clone', '-q', t.fx.origin, other], { env: t.fx.env });
        writeFileSync(join(other, 'moved.txt'), 'moved\n');
        t.git(other, 'add', 'moved.txt');
        t.git(other, 'commit', '-q', '-m', 'feat: moved');
        t.git(other, 'push', '-q', 'origin', 'HEAD:main');
        writeFileSync(join(t.dir, 'b-held'), '1');
      }
      return push(line);
    };
    const clock = { offset: 0 };
    try {
      const code = await t.run({}, { now: () => Date.now() + clock.offset, observeAsync: expireOnB(t, clock) });
      strictEqual(code, 2, t.lines.join('\n'));
      ok(existsSync(join(t.dir, 'b-held')) && !existsSync(join(t.dir, 'b-held.timeout')), 'B was held back while A ran');
      const r = t.latest();
      ok(!r.steps.some((x) => x.lane === 'B'), 'no dispatch from an old baseline');
      strictEqual(r.halt.subtask_id, 'B');
      match(r.halt.detail, /subtask B's branch feat\/b exists at [0-9a-f]{12}, which is not refs\/remotes\/origin\/main/);
      ok(!existsSync(t.lane('B')), 'the unused lane was removed');
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('a lane-layer failure is the lane\'s', () => {
  it('a lane whose creation fails is that lane\'s halt: the run drains, and the other lane\'s step in flight runs to its end, never aborted', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT] }, actions: { 1: 'wait:b-failed' } } });
    markOn(t, /^■ lane B: owner-choice — subtask B's lane could not be created/, 'b-failed');
    try {
      const code = await t.run({}, {
        offLoop: failing('createLane', 'injected: git worktree list failed', (args) => args.subtask?.id === 'B'),
      });
      strictEqual(code, 2, t.lines.join('\n'));
      ok(!existsSync(join(t.dir, 'b-failed.timeout')), 'A was in flight when B\'s creation failed');
      const r = t.latest();
      deepStrictEqual(r.steps.map((x) => [x.lane, x.kind, x.aborted, x.outcome]), [['A', 'dispatch', null, 'ok']]);
      strictEqual(r.halt.subtask_id, 'B');
      match(r.halt.detail, /lane could not be created: injected/);
      strictEqual(bySubtask(r).B.state, 'creation failed');
      deepStrictEqual(L.listOpenRuns(t.work), []);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a lane whose removal fails after its done is kept, and the run goes on to complete', async () => {
    const t = await setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [COMMIT], file: true } } });
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      t.fx.setPrs([t.fx.land('A', 'feat/a', { number: 7 })]);
      strictEqual(await t.run({}, { offLoop: failing('removeLane', 'injected: git worktree list failed') }), 0, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(r.steps.map((x) => [x.kind, x.outcome]), [['done', 'ok']]);
      match(bySubtask(r).A.state, /^kept/);
      match(bySubtask(r).A.removal, /its removal failed \(injected: git worktree list failed\)/);
      ok(existsSync(t.lane('A')), 'the lane is kept');
      strictEqual(r.run.status, 'completed');
    } finally {
      t.fx.cleanup();
    }
  });

  it('a pending peer run the run could not cancel after a failed step keeps the run\'s open-run record, for the next run\'s cleanup', async () => {
    const t = await setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [COMMIT] }, actions: { 1: 'pending-sleep' } } });
    try {
      const code = await t.run({ stepTimeoutSec: 8 }, { offLoop: failing('cancelPeerRuns', 'injected: the cancel task could not start') });
      strictEqual(code, 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(r.steps.map((x) => [x.kind, x.aborted, x.outcome]), [['dispatch', 'timeout', 'worker-failed']]);
      match(r.halt.detail, /could not cancel the step's pending peer run\(s\) plan-verify-20261001T000000Z-feed01, so the run keeps its open-run record/);
      ok(!/; cancelled the step's pending/.test(r.halt.detail), r.halt.detail);
      deepStrictEqual(L.listOpenRuns(t.work).map((x) => x.runId), [r.run.run_id]);
    } finally {
      t.fx.cleanup();
    }
  });

  it('after a failed step, a look that cannot read the macro cannot list the step\'s peers: the run keeps its open-run record, and the halt says why', async () => {
    const t = await setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [COMMIT] }, actions: { 1: 'pending-sleep' } } });
    try {
      // Once the step has recorded its peer, every look at A's lane reads no macro.
      const code = await t.run({ stepTimeoutSec: 8 }, {
        observeAsync: async (a, o) => {
          const v = await observeInChild(a, o);
          return existsSync(join(t.dir, 'pending-ready')) && a.repoRoot === t.lane('A')
            ? { ...v, macro: null, children: {}, claims: [], macroLookupError: 'injected: the macro moved' }
            : v;
        },
      });
      strictEqual(code, 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(r.steps.map((x) => [x.kind, x.aborted]), [['dispatch', 'timeout']]);
      match(r.halt.detail, /the step's pending peer runs could not be listed \(the macro could not be read: injected: the macro moved\), so the run keeps its open-run record/);
      deepStrictEqual(L.listOpenRuns(t.work).map((x) => x.runId), [r.run.run_id]);
    } finally {
      t.fx.cleanup();
    }
  });

  it('peersUnlisted: a step\'s peers cannot be listed from a look that did not read the macro, the claims or the subtask\'s child', () => {
    const whole = { lookError: null, macroLookupError: null, claimsError: null, children: { A: { location: 'active' } } };
    strictEqual(peersUnlisted(whole, 'A'), null);
    strictEqual(peersUnlisted({ ...whole, macroLookupError: 'x' }, null), null, 'a step with no subtask has no peers to list');
    match(peersUnlisted({ ...whole, macroLookupError: 'gone' }, 'A'), /^the macro could not be read: gone$/);
    match(peersUnlisted({ ...whole, claimsError: 'EACCES' }, 'A'), /claim the macro could not be listed: EACCES/);
    match(peersUnlisted({ ...whole, children: { A: { location: 'error', detail: 'unreadable' } } }, 'A'), /subtask A's engineer workflow could not be read: unreadable/);
    match(peersUnlisted({ ...whole, children: { A: { location: 'ambiguous', detail: 'two files' } } }, 'A'), /could not be read: two files/);
    match(peersUnlisted({ ...whole, children: { A: { location: 'missing', workflow_id: 'compose-x' } } }, 'A'), /could not be read: compose-x is in no home the run reads/);
    match(peersUnlisted({ ...whole, children: { A: { location: 'linkage-mismatch', detail: 'workflow_id=b, recorded a' } } }, 'A'), /the workflow read for it is not the child it records \(workflow_id=b, recorded a\)/);
    match(peersUnlisted({ ...whole, children: { A: { location: 'a state not yet named' } } }, 'A'), /could not be read: a state not yet named/, 'an unknown state is unlisted');
    for (const location of ['active', 'archived', 'unrecorded']) strictEqual(peersUnlisted({ ...whole, children: { A: { location } } }, 'A'), null, location);
    strictEqual(peersUnlisted({ ...whole, children: { B: { location: 'error' } } }, 'A'), null, 'another subtask\'s child is not this step\'s');
  });

  it('ownChildOnly: a workflow read in place of the subtask\'s child is no source of the step\'s peer cancellations; the claims still are', () => {
    const before = { children: {}, claims: [] };
    const claim = { originating_subtask: 'A', pending_runs: ['plan-verify-claimed'] };
    const mislinked = { children: { A: { location: 'linkage-mismatch', pending_runs: ['plan-verify-foreign'] } }, claims: [claim] };
    deepStrictEqual(newPendingRuns(ownChildOnly(before, 'A'), ownChildOnly(mislinked, 'A'), 'A'), ['plan-verify-claimed']);
    const own = { children: { A: { location: 'active', pending_runs: ['plan-verify-own'] } }, claims: [] };
    deepStrictEqual(newPendingRuns(ownChildOnly(before, 'A'), ownChildOnly(own, 'A'), 'A'), ['plan-verify-own'], 'the child read as itself is');
    strictEqual(ownChildOnly(own, 'A'), own);
  });
});

describe('an interrupt, and the driver\'s exit, with a task in flight', () => {
  it('SIGTERM with a look in flight stops the look at once: the run ends interrupted without waiting on the look\'s network, and the look\'s group was on the macro lock until it was empty', async () => {
    const t = await setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [COMMIT] } } });
    const b = blockingFetch(t);
    const macroLock = L.macroLockPath(t.work, t.fx.macroId);
    let held = null;
    let heldHere = null;
    let sentAt = null;
    try {
      const code = await t.run({}, {
        offLoop: blockFirstLook(b, () => {
          held = L.readLockEntries(macroLock).map((e) => e.holder?.worker?.task ?? null);
          heldHere = L.readLockEntries(L.worktreeLockPath(t.work)).map((e) => e.holder?.worker?.task ?? null);
          sentAt = Date.now();
          t.signals.emit('SIGTERM');
        }),
      });
      const took = Date.now() - sentAt;
      strictEqual(code, 2, t.lines.join('\n'));
      const r = t.latest();
      strictEqual(r.halt.reason, 'interrupted');
      deepStrictEqual(r.steps, []);
      ok(took < 10_000, `the run ended ${took} ms after SIGTERM; the look's transport sleeps 60 s`);
      ok(held?.includes('fetchBaseline'), `the look's group was on the macro lock: ${JSON.stringify(held)}`);
      ok(heldHere?.includes('fetchBaseline'), `the look's group was on the lock of the checkout it looked at: ${JSON.stringify(heldHere)}`);
      ok(!alive(b.pid()), 'the look\'s transport is gone');
      deepStrictEqual(L.readLockEntries(macroLock), []);
    } finally {
      t.fx.cleanup();
    }
  });

  it('SIGHUP with a lane\'s creation under way lets the creation finish, then ends the run interrupted: the lane is kept whole, nothing is removed, and no step starts in it', async () => {
    const t = await setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [COMMIT] } } });
    // git worktree add runs post-checkout, which for A marks its start, then takes 3 s.
    mkdirSync(join(t.work, '.git', 'hooks'), { recursive: true });
    const hook = join(t.work, '.git', 'hooks', 'post-checkout');
    writeFileSync(hook, `#!/bin/sh\ncase "$PWD" in */A) : > '${join(t.dir, 'a-creating')}'; sleep 3;; esac\nexit 0\n`);
    chmodSync(hook, 0o755);
    appears(join(t.dir, 'a-creating')).then((found) => { if (found) t.signals.emit('SIGHUP'); });
    try {
      const code = await t.run();
      strictEqual(code, 2, t.lines.join('\n'));
      const r = t.latest();
      strictEqual(r.halt.reason, 'interrupted');
      deepStrictEqual(r.steps, [], 'no step starts after the interrupt');
      strictEqual(LN.readLaneIdentity(t.lane('A')).state, 'ok', 'the creation finished: the lane has its identity');
      strictEqual(bySubtask(r).A.state, 'created');
      ok(!t.lines.some((l) => /lane A: removed/.test(l)), 'no removal starts after the interrupt');
    } finally {
      t.fx.cleanup();
    }
  });

  it('the driver\'s exit with a task in flight empties the task\'s group before the process goes', async () => {
    const t = await setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [COMMIT] } } });
    const b = blockingFetch(t);
    let goneAtExit = null;
    try {
      const code = await t.run({}, {
        offLoop: blockFirstLook(b, () => {
          // The process exiting without the run unwinding (a crash): the handler runs, synchronously.
          t.signals.emit('exit', 1);
          goneAtExit = !alive(b.pid());
          // This test's process goes on: end the run.
          t.signals.emit('SIGTERM');
        }),
      });
      strictEqual(code, 2, t.lines.join('\n'));
      strictEqual(goneAtExit, true, 'the look\'s group was emptied by the exit');
    } finally {
      t.fx.cleanup();
    }
  });

  it('the driver\'s exit targets a worker still in flight, and neither the exit nor an interrupt signals one whose group its host has emptied and the loop has not yet settled', async () => {
    // A waits until B's lane is looked at; that look holds the loop until A
    // has ended. The exit (its target list only) is asked once on each side,
    // then the run is interrupted.
    const t = await setup({ scenario: { A: { next: [COMMIT] }, B: { next: [COMMIT] }, actions: { 1: ['wait:b-looking', 'noop'] } } });
    const pids = {};
    const aborted = [];
    let aDone = false;
    const asked = [];
    try {
      const code = await t.run({}, {
        startWorker: (o) => {
          const w = realStartWorker(o);
          pids[o.seq] = w.pid;
          const abort = w.abort;
          w.abort = (...a) => { aborted.push(o.seq); return abort(...a); };
          if (o.seq === 1) w.done.then(() => { aDone = true; });
          return w;
        },
        terminateGroupsSync: (groups) => { asked.push([...groups]); },
        observeAsync: async (a, o) => {
          if (a.repoRoot === t.lane('B') && asked.length === 0) {
            t.signals.emit('exit', 1);
            writeFileSync(join(t.dir, 'b-looking'), '1');
            for (let i = 0; i < 1200 && !aDone; i += 1) await new Promise((r) => { setTimeout(r, 50); });
            t.signals.emit('exit', 1);
            t.signals.emit('SIGTERM');
          }
          return observeInChild(a, o);
        },
      });
      strictEqual(code, 2, t.lines.join('\n'));
      strictEqual(t.latest().halt.reason, 'interrupted');
      strictEqual(asked.length, 2, t.lines.join('\n'));
      ok(asked[0].includes(pids[1]), `A, in flight, is a target: ${JSON.stringify(asked[0])} (A is ${pids[1]})`);
      ok(aDone, 'A ended while the loop was held');
      ok(!asked[1].includes(pids[1]), `A, its group emptied and not yet settled, is no target: ${JSON.stringify(asked[1])}`);
      deepStrictEqual(aborted, [], 'the interrupt aborted no worker whose group was emptied');
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('the loop keeps serving its workers', () => {
  it('a lane\'s creation runs off the loop: a worker in flight is still served while it runs, its end seen at once rather than when the creation ends', async () => {
    // A ends once B's creation has begun; git worktree add runs post-checkout,
    // which for B marks its start, then takes 12 s.
    const t = await setup({ scenario: { A: { next: [COMMIT] }, B: { next: [COMMIT] }, actions: { 1: ['wait:b-creating', 'noop'] } } });
    mkdirSync(join(t.work, '.git', 'hooks'), { recursive: true });
    const hook = join(t.work, '.git', 'hooks', 'post-checkout');
    writeFileSync(hook, `#!/bin/sh\ncase "$PWD" in */B) : > '${join(t.dir, 'b-creating')}'; sleep 12;; esac\nexit 0\n`);
    chmodSync(hook, 0o755);
    let aEnded = null;
    try {
      const code = await t.run({}, {
        startWorker: (o) => {
          const w = realStartWorker(o);
          if (o.seq === 1) w.done.then(() => { aEnded = Date.now(); });
          return w;
        },
      });
      strictEqual(code, 2, t.lines.join('\n'));
      ok(!existsSync(join(t.dir, 'b-creating.timeout')), 'A ended only once B\'s creation had begun');
      const began = statSync(join(t.dir, 'b-creating')).mtimeMs;
      ok(aEnded - began < 6000, `A's end was seen ${aEnded - began} ms after B's 12 s creation began`);
      ok(t.lines.some((l) => /lane B: created/.test(l)), t.lines.join('\n'));
      deepStrictEqual(stepsOf(t.latest()).map((x) => [x[1], x[2]]), [['A', 'dispatch']]);
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('a driver step in flight', () => {
  // Run 1 commits A, the owner lands it, and the relaunch's done (step 1)
  // records A completed, which marks the macro terminal; a rate-limit event
  // then wakes the run, which looks while the done waits, before its Stop
  // hook archives the macro, for the file <dir>/looked.
  async function lastDone(t, observeAsync) {
    strictEqual(await t.run(), 2, t.lines.join('\n'));
    strictEqual(t.latest().halt.reason, 'awaiting-landing');
    t.fx.setPrs([t.fx.land('A', 'feat/a', { number: 7 })]);
    writeFileSync(t.scen, JSON.stringify({ seqFromArgv: true, A: { next: [COMMIT], file: true }, actions: { 1: 'stop-wait:looked' }, events: { 1: [THROTTLED()] } }));
    return t.run({}, { observeAsync });
  }
  const marked = (v) => v.macro?.fm?.terminal_marker === true && !v.macro.archived;

  it('the macro\'s terminal marker the last done writes, seen by a look while that done runs, is not a halt: the done archives the macro and the run completes', async () => {
    const t = await setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [COMMIT], file: true } } });
    try {
      const code = await lastDone(t, async (a, o) => {
        const v = await observeInChild(a, o);
        if (marked(v)) writeFileSync(join(t.dir, 'looked'), '1');
        return v;
      });
      strictEqual(code, 0, t.lines.join('\n'));
      ok(!existsSync(join(t.dir, 'looked.timeout')), 'the run looked while the done ran, the macro marked terminal and not yet archived');
      const r = t.latest();
      deepStrictEqual(r.steps.map((x) => [x.kind, x.subtask_id, x.outcome]), [['done', 'A', 'ok']]);
      strictEqual(r.run.status, 'completed');
    } finally {
      t.fx.cleanup();
    }
  });

  it('a macro lookup that fails while the last done runs (its Stop hook moves the macro to the archive) is not a halt: the run judges once the done has ended', async () => {
    const t = await setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [COMMIT], file: true } } });
    let injected = false;
    try {
      const code = await lastDone(t, async (a, o) => {
        const v = await observeInChild(a, o);
        if (!injected && marked(v)) {
          injected = true;
          writeFileSync(join(t.dir, 'looked'), '1');
          return { ...v, macro: null, macroLookupError: 'injected: the macro moved to the archive between its lookup and its read' };
        }
        return v;
      });
      strictEqual(code, 0, t.lines.join('\n'));
      ok(injected, 'a look met the move while the done ran');
      const r = t.latest();
      deepStrictEqual(r.steps.map((x) => [x.kind, x.subtask_id, x.outcome]), [['done', 'A', 'ok']]);
      strictEqual(r.run.status, 'completed');
    } finally {
      t.fx.cleanup();
    }
  });
});
