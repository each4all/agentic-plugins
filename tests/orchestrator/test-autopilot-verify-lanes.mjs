// tests/orchestrator/test-autopilot-verify-lanes.mjs
//
// ADR-0068 Decision 5, item 9, and Decision 6, item 5 (verify-exec) — the
// verification batches of a run with lanes (scheduler.mjs), end to end with
// the fake Claude and the scripted worker (fixtures/autopilot-lanes-run.mjs).
//
// Covers:
//   - a batch holds no worker slot: a lane's worker steps while another
//     lane's batch runs; the batches are seqs of the ledger with no cost, and
//     run.steps counts the worker steps;
//   - one batch at a time across the lanes, in the order the requests were
//     recorded: with checks whose command takes the heavy-work lock itself
//     (run directly, so no wrapper's lock serializes them), the scheduler's
//     queue alone keeps three lanes' batches apart, and the request recorded
//     second runs second whatever its lane's name;
//   - lock contention: a lane's check waits for the heavy-work lock another
//     checkout of the repository holds, the run showing it waiting with its
//     holder, and runs once the holder lets go; and between two lanes, lane
//     B's worker holding the lock while lane A's batch waits for it;
//   - a start the persona refuses for a hold the run does not read (a holds
//     marker it cannot read) yields, and its second yield in a row parks the
//     lane no-progress rather than loop;
//   - a batch is admitted to its lane as a worker step is: a request whose
//     lane was removed gets it back, waits while another session's persona
//     operation is open in it, and its child is told an owner's rebinding
//     before the batch runs; a hold set while a batch is prepared starts
//     none and parks nothing, withdrawn before the settle or not;
//   - the new-lane throttle: a batch spawns no worker, so a lane whose only
//     step in the run was a batch is still new for its first worker.

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { COMMIT, CRITIQUE, OPEN, hour, setup } from './fixtures/autopilot-lanes-run.mjs';
import { CHECK_SCRIPT, DECLARATION } from './_verify-fixtures.mjs';
import { acquire } from '../../plugins/orchestrator/scripts/lib/heavy-lock.mjs';

const RB = await import('../../plugins/orchestrator/adapters/claude/autopilot/rebind-boundary.mjs');
const PK = await import('../../plugins/orchestrator/adapters/claude/autopilot/parks.mjs');
const OL = await import('../../plugins/orchestrator/adapters/claude/autopilot/offloop.mjs');
const VR = await import('../../plugins/orchestrator/adapters/claude/autopilot/verify-run.mjs');
const VO = await import('../../plugins/orchestrator/adapters/claude/autopilot/verify-ops.mjs');
const HO = await import('../../plugins/orchestrator/scripts/lib/hold-ops.mjs');
const HR = await import('../../plugins/orchestrator/scripts/lib/holds.mjs');

const verify = (checks) => ({ kind: 'verify', verb: null, confidence: 'HIGH', checks, on_pass: { kind: 'commit', confidence: 'HIGH' } });
const BOUNDS = { secondMs: 100, killGraceMs: 300, lingerMs: 500, pollMs: 25 };
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

// The checks committed on main, and the origin fetched: what each lane forks from.
function commitChecks(t, declaration = DECLARATION) {
  mkdirSync(join(t.work, 'scripts'), { recursive: true });
  mkdirSync(join(t.work, '.agentic-plugins'), { recursive: true });
  writeFileSync(join(t.work, 'scripts/check.mjs'), CHECK_SCRIPT);
  writeFileSync(join(t.work, '.agentic-plugins/verify-checks.json'), declaration);
  t.git(t.work, 'add', '-A');
  t.git(t.work, 'commit', '-q', '-m', 'chore: checks');
  t.git(t.work, 'push', '-q', 'origin', 'HEAD:main');
  t.git(t.work, 'fetch', '-q', 'origin');
}

function checkLogs(r) {
  const dir = join(r.dir, 'verify');
  try {
    return readdirSync(dir).flatMap((b) => readdirSync(join(dir, b)).filter((n) => n.endsWith('.log')).map((n) => `${b}/${n}: ${readFileSync(join(dir, b, n), 'utf8').slice(-600)}`)).join('\n');
  } catch (e) { return String(e); }
}

describe('verify-lanes: batches across lanes', () => {
  it('a batch holds no worker slot, and the batches cost nothing and are no worker step', { timeout: 300_000 }, async () => {
    // A and B request a batch at once; C and D are workers that step meanwhile.
    const t = await setup({
      subtasks: [{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }],
      scenario: { A: { next: [verify([{ kind: 'slow' }]), COMMIT], file: true }, B: { next: [verify([{ kind: 'slow' }]), COMMIT], file: true }, C: { next: [CRITIQUE, COMMIT], file: true }, D: { next: [CRITIQUE, COMMIT], file: true } },
    });
    const logs = mkdtempSync(join(tmpdir(), 'verify-lanes-log-'));
    // 30 s of declared timeout (×100 ms seconds), far past the 2.5 s check
    // and a loaded machine's start and teardown of it.
    const decl = JSON.parse(DECLARATION);
    decl.kinds.slow = { ...decl.kinds.slow, timeout_s: 300 };
    try {
      commitChecks(t, JSON.stringify(decl, null, 2));
      Object.assign(t.env, { VERIFY_FIXTURE_LOG: join(logs, 'order.log'), VERIFY_FIXTURE_SLOW_MS: '2500' });
      const code = await t.run({}, { verifyBounds: BOUNDS });
      strictEqual(code, 2, t.lines.join('\n'));
      const r = t.latest();
      const verifies = r.steps.filter((s) => s.kind === 'verify');
      deepStrictEqual(verifies.map((s) => [s.subtask_id, s.outcome, s.verify?.batch?.end]).sort(), [['A', 'ok', 'passed'], ['B', 'ok', 'passed']], checkLogs(r));
      // No worker slot: while a batch ran, two workers (--lanes 2) ran beside it.
      const span = (s) => [Date.parse(s.started_at), Date.parse(s.ended_at)];
      const workers = r.steps.filter((s) => s.kind !== 'verify' && s.ended_at).map(span);
      const twoBeside = verifies.some((v) => {
        const [v0, v1] = span(v);
        return workers.some((x, i) => workers.some((y, j) => i < j && Math.max(x[0], y[0], v0) < Math.min(x[1], y[1], v1)));
      });
      ok(twoBeside, JSON.stringify(r.steps.map((s) => [s.seq, s.subtask_id, s.kind, s.started_at, s.ended_at])));
      // The batches cost nothing and are no worker step.
      for (const s of verifies) deepStrictEqual([s.cost_usd, s.cost_charged_usd], [0, 0]);
      strictEqual(r.run.steps, r.steps.filter((s) => s.kind !== 'verify').length);
    } finally {
      t.fx.cleanup();
      rmSync(logs, { recursive: true, force: true });
    }
  });

  it('two lanes\' batches run one at a time, in request order: the scheduler\'s queue, not the heavy-work lock, keeps them apart', { timeout: 300_000 }, async () => {
    // Checks whose command takes the heavy-work lock itself run directly, so
    // no wrapper's lock serializes them. A records its request first and its
    // batch runs long; C records its own a while after A's, B a while after
    // C's (the requests' times are whole seconds): while A's batch runs both
    // wait, and C's, recorded first, runs before B's though B's lane comes
    // first by name.
    const decl = JSON.parse(DECLARATION);
    // 30 s of declared timeout (×100 ms seconds), past the 12 s check.
    decl.kinds.selfslow = { ...decl.kinds.slow, locks_itself: true, timeout_s: 300 };
    const t = await setup({
      subtasks: [{ id: 'A' }, { id: 'B' }, { id: 'C' }],
      scenario: {
        A: { next: [verify([{ kind: 'selfslow' }]), COMMIT], file: true },
        B: { next: [verify([{ kind: 'selfslow' }]), COMMIT], file: true },
        C: { next: [verify([{ kind: 'selfslow' }]), COMMIT], file: true },
        // Each lane's dispatch, by its subtask (the lanes' admission sets the
        // seqs): C waits for A's request, B for C's, each a while more.
        actions: { 'dispatch:A': ['mark:a-recorded'], 'dispatch:B': ['wait:c-recorded', 'pause:1100'], 'dispatch:C': ['wait:a-recorded', 'pause:1100', 'mark:c-recorded'] },
      },
    });
    const logs = mkdtempSync(join(tmpdir(), 'verify-lanes-log-'));
    try {
      commitChecks(t, JSON.stringify(decl, null, 2));
      const log = join(logs, 'order.log');
      Object.assign(t.env, { VERIFY_FIXTURE_LOG: log, VERIFY_FIXTURE_SLOW_MS: '12000' });
      // A watchdog: a scheduler that loses a batch (two at once) never ends
      // the run by itself; the owner's interrupt ends it, and the test fails.
      const watchdog = setTimeout(() => t.signals.emit('SIGINT'), 180_000);
      const code = await t.run({ lanes: 3 }, { verifyBounds: BOUNDS }).finally(() => clearTimeout(watchdog));
      strictEqual(code, 2, t.lines.join('\n'));
      const r = t.latest();
      for (const name of ['c-recorded', 'a-recorded']) {
        let timedOut = false;
        try { readFileSync(join(t.dir, `${name}.timeout`)); timedOut = true; } catch { /* waited for it */ }
        strictEqual(timedOut, false, `the order the test set up happened (${name})`);
      }
      const verifies = r.steps.filter((s) => s.kind === 'verify').sort((a, b) => a.seq - b.seq);
      deepStrictEqual(verifies.map((s) => [s.subtask_id, s.outcome, s.verify?.batch?.end]), [['A', 'ok', 'passed'], ['C', 'ok', 'passed'], ['B', 'ok', 'passed']], `${JSON.stringify(verifies.map((s) => s.verify?.batch))}\n${t.lines.join('\n')}`);
      // Not vacuous: B's request, the last, was recorded (its step ended)
      // while A's batch still ran, so C's and B's both waited in the queue.
      const bStep = r.steps.find((s) => s.subtask_id === 'B' && s.kind !== 'verify');
      ok(Date.parse(bStep.ended_at) < Date.parse(verifies[0].ended_at), JSON.stringify(r.steps.map((s) => [s.seq, s.subtask_id, s.kind, s.started_at, s.ended_at])));
      // One batch at a time: each check ends before the next one starts.
      const order = readFileSync(log, 'utf8').split('\n').filter((l) => l === 'slow' || l === 'slow-end');
      deepStrictEqual(order, ['slow', 'slow-end', 'slow', 'slow-end', 'slow', 'slow-end'], readFileSync(log, 'utf8'));
    } finally {
      t.fx.cleanup();
      rmSync(logs, { recursive: true, force: true });
    }
  });

  it('a lane\'s check waits for the heavy-work lock another checkout holds, the run showing it waiting with its holder', { timeout: 300_000 }, async () => {
    const t = await setup({
      subtasks: [{ id: 'A' }, { id: 'B' }],
      scenario: { A: { next: [verify([{ kind: 'pass' }]), COMMIT], file: true }, B: { next: [CRITIQUE, COMMIT], file: true } },
    });
    const logs = mkdtempSync(join(tmpdir(), 'verify-lanes-log-'));
    let holder = null;
    try {
      commitChecks(t);
      const log = join(logs, 'order.log');
      Object.assign(t.env, { VERIFY_FIXTURE_LOG: log, AGENTIC_HEAVY_LOCK_POLL_MS: '50' });
      // The main checkout holds the lock its lanes share (one git common dir).
      holder = await acquire(t.work, { kind: 'harness', purpose: 'a mutation run in the main checkout', log: () => {}, pollMs: 20 });
      const running = t.run({}, { verifyBounds: BOUNDS });
      let waiting = null;
      for (let i = 0; i < 1200 && waiting === null; i += 1) {
        await sleep(50);
        try {
          const v = t.latest().run.verifying;
          if (v?.state === 'waiting') waiting = v;
        } catch { /* the run is not on file yet */ }
      }
      ok(waiting, t.lines.join('\n'));
      deepStrictEqual([waiting.subtask_id, waiting.holder_pid], ['A', process.pid]);
      ok(typeof waiting.holder === 'string' && waiting.holder.includes('a mutation run in the main checkout'), JSON.stringify(waiting));
      strictEqual(readFileSync(log, { encoding: 'utf8', flag: 'a+' }), '', 'nothing ran while the lock was held');
      holder.release();
      holder = null;
      const code = await running;
      strictEqual(code, 2, t.lines.join('\n'));
      const r = t.latest();
      const v = r.steps.find((s) => s.kind === 'verify');
      deepStrictEqual([v?.subtask_id, v?.outcome, v?.verify?.batch?.end], ['A', 'ok', 'passed'], checkLogs(r));
      // The worker's check, then the suite the driver adds for the lane's change.
      strictEqual(readFileSync(log, 'utf8').split('\n').filter(Boolean)[0], 'pass');
      ok(t.lines.some((l) => /lane A: verification waits for the heavy-work lock, held by/.test(l)), t.lines.join('\n'));
    } finally {
      holder?.release();
      t.fx.cleanup();
      rmSync(logs, { recursive: true, force: true });
    }
  });

  it('lock contention between two lanes: A\'s check waits for the heavy-work lock B\'s worker holds, and runs once B\'s worker lets go', { timeout: 300_000 }, async () => {
    // B's worker takes the lock at its start, as a heavy command it ran would;
    // A's dispatch, which records A's request, waits until B holds it.
    const t = await setup({
      subtasks: [{ id: 'A' }, { id: 'B' }],
      scenario: {
        A: { next: [verify([{ kind: 'pass' }]), COMMIT], file: true },
        B: { next: [CRITIQUE, COMMIT], file: 'b.txt' },
        actions: { 'dispatch:A': ['wait:b-heavy'], 'dispatch:B': ['heavy:b-heavy'] },
      },
    });
    const logs = mkdtempSync(join(tmpdir(), 'verify-lanes-log-'));
    const release = join(t.dir, 'b-heavy.release');
    try {
      commitChecks(t);
      const log = join(logs, 'order.log');
      Object.assign(t.env, { VERIFY_FIXTURE_LOG: log, AGENTIC_HEAVY_LOCK_POLL_MS: '50' });
      const running = t.run({ lanes: 2 }, { verifyBounds: BOUNDS });
      let waiting = null;
      for (let i = 0; i < 1200 && waiting === null; i += 1) {
        await sleep(50);
        try {
          const v = t.latest().run.verifying;
          if (v?.state === 'waiting') waiting = v;
        } catch { /* the run is not on file yet */ }
      }
      ok(waiting, t.lines.join('\n'));
      // The holder is B's worker, a process of the run: not this test's.
      const bWorker = Number(readFileSync(join(t.dir, 'b-heavy'), 'utf8'));
      ok(Number.isInteger(bWorker) && bWorker !== process.pid, String(bWorker));
      deepStrictEqual([waiting.subtask_id, waiting.holder_pid], ['A', bWorker], JSON.stringify(waiting));
      match(waiting.holder ?? '', /lane B's worker/);
      strictEqual(readFileSync(log, { encoding: 'utf8', flag: 'a+' }), '', 'nothing ran while B held the lock');
      const releasedAt = Date.now();
      writeFileSync(release, 'go\n');
      const code = await running;
      strictEqual(code, 2, t.lines.join('\n'));
      for (const name of ['b-heavy', 'b-heavy.release']) {
        let timedOut = false;
        try { readFileSync(join(t.dir, `${name}.timeout`)); timedOut = true; } catch { /* waited for it */ }
        strictEqual(timedOut, false, `the order the test set up happened (${name})`);
      }
      const r = t.latest();
      const v = r.steps.find((s) => s.kind === 'verify');
      deepStrictEqual([v?.subtask_id, v?.outcome, v?.verify?.batch?.end], ['A', 'ok', 'passed'], checkLogs(r));
      // A's batch began before B's worker let go, and ended after: it waited for it.
      ok(Date.parse(v.started_at) < releasedAt && releasedAt <= Date.parse(v.ended_at), JSON.stringify([releasedAt, r.steps.map((s) => [s.seq, s.subtask_id, s.kind, s.started_at, s.ended_at])]));
      ok(t.lines.some((l) => /lane A: verification waits for the heavy-work lock, held by lane B's worker/.test(l)), t.lines.join('\n'));
    } finally {
      writeFileSync(release, 'go\n');
      t.fx.cleanup();
      rmSync(logs, { recursive: true, force: true });
    }
  });
});

describe('verify-lanes: a batch is admitted to its lane as a worker step is', () => {
  it('a request whose lane was removed gets its lane back, waits out an operation open in it, and its child hears the owner\'s rebinding before the batch', { timeout: 300_000 }, async () => {
    const t = await setup({ subtasks: [{ id: 'A' }], scenario: { recordDispatch: true, A: { next: [verify([{ kind: 'pass' }]), COMMIT] } } });
    try {
      commitChecks(t);
      // Run 1: A's dispatch records the request, and the last step the
      // budget allows leaves it queued.
      strictEqual(await t.run({ maxSteps: 1 }, { verifyBounds: BOUNDS }), 2, t.lines.join('\n'));
      deepStrictEqual(t.latest().steps.map((s) => s.kind), ['dispatch']);
      // The owner changes A's words; the approval leaves the note for A's
      // next boundary.
      const m = await t.fx.readMacro();
      await t.fx.orch.setPlan({ workflowPath: t.fx.macroPath, host: 'claude', subtasks: m.plan.subtasks.map((s) => (s.id === 'A' ? { ...s, topic: 'B words' } : s)) });
      const { digest } = t.fx.orch.planRebindView({ workflowPath: t.fx.macroPath, repoRoot: t.work });
      await t.fx.orch.approvePlan({ workflowPath: t.fx.macroPath, host: 'claude', env: {}, expectRebind: digest, repoRoot: t.work });
      const pending = async () => JSON.parse((await t.fx.readMacro()).plan_rebindings).pending;
      strictEqual((await pending()).length, 1);
      // The clean lane is removed; its branch and its workflow stay.
      const lanePath = t.lane('A');
      try { t.git(t.work, 'worktree', 'unlock', lanePath); } catch { /* not locked */ }
      t.git(t.work, 'worktree', 'remove', lanePath);
      const lines0 = t.lines.length;

      // Run 2: another session's operation is open in A once; then the
      // rebinding is told, and only then the batch runs, in a lane made again.
      const seen = [];
      let first = true;
      const laneBusy = (id) => {
        if (id !== 'A') return false;
        const busy = first;
        first = false;
        seen.push(['busy', busy]);
        return busy ? 'an operation of another session (test)' : false;
      };
      const deliverRebindings = async (a) => {
        seen.push(['deliver', a.subtaskId, t.lines.slice(lines0).some((l) => /lane A: verify/.test(l))]);
        return RB.deliverAtBoundary(a);
      };
      await t.run({}, { verifyBounds: BOUNDS, laneBusy, deliverRebindings });
      const r = t.latest();
      const after = t.lines.slice(lines0).join('\n');
      deepStrictEqual(seen.slice(0, 3), [['busy', true], ['busy', false], ['deliver', 'A', false]], after);
      ok(/lane A: waits: an operation of another session \(test\)/.test(after), after);
      ok(/lane A: created /.test(after), after);
      const v = r.steps.find((s) => s.kind === 'verify');
      deepStrictEqual([v?.subtask_id, v?.outcome, v?.verify?.batch?.end], ['A', 'ok', 'passed'], `${checkLogs(r)}\n${after}`);
      deepStrictEqual(await pending(), []);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a hold set while a batch is prepared starts none and parks nothing, though withdrawn before the settle; the batch runs once it is gone', { timeout: 300_000 }, async () => {
    await heldWhilePrepared({ hidden: false });
  });

  it('a hold the persona refused the batch\'s start for, withdrawn before the refusal reaches the driver, parks nothing either', { timeout: 300_000 }, async () => {
    // The driver's own reads never see the hold (it came after the read
    // before the start, and is gone after the refusal): the refusal names it.
    await heldWhilePrepared({ hidden: true });
  });

  it('two holds in a row, each seen while a batch is prepared and withdrawn before its settle, park nothing; the batch runs once they are gone', { timeout: 300_000 }, async () => {
    // The driver saw each: the owner's holds, not a refusal it cannot explain.
    await heldWhilePrepared({ hidden: false, times: 2 });
  });
});

// The owner holds A while its batch is prepared (the selection), with the hold
// protocol on, so the persona refuses the batch's start; the hold is withdrawn
// once that step resolves, before its settle. `hidden`: the driver's stop
// reads do not see the hold, so only the persona's refusal tells it. `times`:
// that many batches in a row meet a new hold so.
function holdDuringPreparation(t, { hidden = false, times = 1 } = {}) {
  const s = { hold: null, withdrawn: null, results: [], holds: 0 };
  let current = null;
  const verifyOps = {
    treeDigest: VO.DEFAULT_OPS.treeDigest,
    select: async (a) => {
      if (s.holds < times) {
        current = await HO.setHold({ mainRoot: t.work, macroId: t.fx.macroId, subtaskId: 'A', branch: t.git(a.lane, 'branch', '--show-current') });
        s.holds += 1;
        s.hold ??= current;
      }
      return VO.DEFAULT_OPS.select(a);
    },
  };
  const startVerify = (a) => {
    const h = VR.startVerify(hidden && s.hold === null ? { ...a, stopCause: () => null } : a);
    return {
      abort: h.abort,
      done: h.done.then(async (r) => {
        s.results.push(r);
        if (current) {
          const w = await HO.withdrawUnhandedHold({ mainRoot: t.work, macroId: t.fx.macroId, subtaskId: 'A', holdId: current.hold_id });
          s.withdrawn = s.withdrawn === false ? false : w;
          current = null;
        }
        return r;
      }),
    };
  };
  return { s, verifyOps, startVerify };
}

// The hold protocol on for the macro: the persona then refuses a held lane's
// writes (the fixture's hosts carry no engineer cache, so the run cannot turn
// it on itself).
function holdsOn(t) {
  HR.writeProtocol(t.work, t.fx.macroId, { writtenBy: 'test' });
  strictEqual(HR.readActivation(t.work, t.fx.macroId).state, 'active');
}

async function heldWhilePrepared({ hidden, times = 1 }) {
  const t = await setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [verify([{ kind: 'pass' }]), COMMIT], file: true } } });
  const logs = mkdtempSync(join(tmpdir(), 'verify-lanes-log-'));
  try {
    commitChecks(t);
    holdsOn(t);
    const log = join(logs, 'order.log');
    Object.assign(t.env, { VERIFY_FIXTURE_LOG: log });
    const { s, verifyOps, startVerify } = holdDuringPreparation(t, { hidden, times });
    strictEqual(await t.run({}, { verifyBounds: BOUNDS, verifyOps, startVerify }), 2, t.lines.join('\n'));
    ok(s.hold, 'the hold was set during the preparation');
    strictEqual(s.holds, times, 'a hold came while each batch was prepared');
    strictEqual(s.withdrawn, true, 'each hold was still pending, and withdrawn before the settle');
    deepStrictEqual([s.results[0]?.outcome, s.results[0]?.cause], ['stopped', 'hold'], JSON.stringify(s.results[0]));
    // Seen by the driver, the start was never asked for: nothing written, not
    // even the journal's intent. Hidden from it, the persona refused the start
    // its journal line announced.
    strictEqual(s.results[0]?.wrote, hidden, JSON.stringify(s.results[0]));
    // Only a hold the driver never read is the refusal's alone, which the settle bounds.
    deepStrictEqual(s.results.slice(0, times).map((x) => x.refusal), Array.from({ length: times }, () => hidden), JSON.stringify(s.results));
    match(s.results[0]?.detail ?? '', /before the batch started; nothing ran/);
    const r = t.latest();
    deepStrictEqual(r.steps.map((x) => [x.kind, x.outcome, x.verify?.outcome ?? null]), [
      ['dispatch', 'ok', null], ...Array.from({ length: times }, () => ['verify', 'ok', 'stopped']), ['verify', 'ok', 'ran'], ['commit', 'ok', null],
    ], t.lines.join('\n'));
    strictEqual(PK.readPark(t.work, t.fx.macroId, 'A').state, 'absent', 'a hold parks no lane');
    deepStrictEqual(readFileSync(log, 'utf8').split('\n').filter(Boolean).slice(0, 1), ['pass'], 'the batch ran once, after the hold');
  } finally {
    t.fx.cleanup();
    rmSync(logs, { recursive: true, force: true });
  }
}

describe('verify-lanes: a start the persona refuses for a hold the run does not read', () => {
  it('the batch yields, is decided again, and its second yield in a row parks the lane no-progress: the free step does not loop', { timeout: 300_000 }, async () => {
    const t = await setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [verify([{ kind: 'pass' }]), COMMIT], file: true } } });
    const logs = mkdtempSync(join(tmpdir(), 'verify-lanes-log-'));
    try {
      commitChecks(t);
      holdsOn(t);
      const log = join(logs, 'order.log');
      Object.assign(t.env, { VERIFY_FIXTURE_LOG: log });
      // While the batch is prepared, the macro's holds marker comes to name a
      // later protocol: the persona then cannot tell whether the lane is held,
      // and refuses every batch start as a held lane's, while the run's hold
      // read, which lists the hold records, finds none.
      const marker = HR.readActivation(t.work, t.fx.macroId).path;
      const verifyOps = {
        treeDigest: VO.DEFAULT_OPS.treeDigest,
        select: async (a) => {
          writeFileSync(marker, `${JSON.stringify({ ...JSON.parse(readFileSync(marker, 'utf8')), protocol: 99 })}\n`);
          return VO.DEFAULT_OPS.select(a);
        },
      };
      // A watchdog: a run that loops on the free step never ends by itself;
      // the owner's interrupt ends it, and the test fails.
      const watchdog = setTimeout(() => t.signals.emit('SIGINT'), 120_000);
      const code = await t.run({}, { verifyBounds: BOUNDS, verifyOps }).finally(() => clearTimeout(watchdog));
      strictEqual(code, 2, t.lines.join('\n'));
      strictEqual(HR.readActivation(t.work, t.fx.macroId).state, 'unreadable', 'the persona read the marker as unreadable');
      const r = t.latest();
      deepStrictEqual(r.steps.map((x) => [x.kind, x.outcome, x.verify?.outcome ?? null]), [
        ['dispatch', 'ok', null], ['verify', 'ok', 'stopped'], ['verify', 'no-progress', 'stopped'],
      ], t.lines.join('\n'));
      const park = PK.readPark(t.work, t.fx.macroId, 'A');
      strictEqual(park.record?.reason, 'no-progress', JSON.stringify(park));
      match(park.record?.detail ?? '', /yielded twice in a row to a hold this run does not read/);
      deepStrictEqual(readFileSync(log, { encoding: 'utf8', flag: 'a+' }), '', 'no check ran');
    } finally {
      t.fx.cleanup();
      rmSync(logs, { recursive: true, force: true });
    }
  });
});

describe('verify-lanes: the new-lane throttle', () => {
  it('a lane whose only step in the run was a batch is still new: its first worker waits for the throttle', { timeout: 300_000 }, async () => {
    const t = await setup({ subtasks: [{ id: 'A' }, { id: 'B' }], scenario: { A: { next: [verify([{ kind: 'pass' }]), COMMIT], file: true }, B: { next: [CRITIQUE, COMMIT], file: 'b.txt' } } });
    try {
      commitChecks(t);
      // Run 1: A's dispatch records its request, and the last step the
      // budget allows leaves it queued.
      strictEqual(await t.run({ maxSteps: 1 }, { verifyBounds: BOUNDS }), 2, t.lines.join('\n'));
      deepStrictEqual(t.latest().steps.map((s) => [s.subtask_id, s.kind]), [['A', 'dispatch']]);
      // Run 2: B's worker reports a five-hour window at 0.99. A's batch, free,
      // runs; A's commit is its first worker of this run, which the throttle
      // holds back. The wait for the reset, an hour off, ends at SIGTERM.
      t.env.FAKE_RATE_LIMIT = JSON.stringify({ ...OPEN(), unifiedWindows: { five_hour: { utilization: 0.99, resetsAt: hour() }, seven_day: { utilization: 0.4, resetsAt: hour() + 86400 } } });
      const lines0 = t.lines.length;
      const push = t.lines.push.bind(t.lines);
      t.lines.push = (line) => {
        if (/waiting for the reset at /.test(line)) setTimeout(() => t.signals.emit('SIGTERM'), 50);
        return push(line);
      };
      strictEqual(await t.run({}, { verifyBounds: BOUNDS }), 2, t.lines.join('\n'));
      const r = t.latest();
      const after = t.lines.slice(lines0).join('\n');
      const steps = r.steps.map((s) => [s.subtask_id, s.kind, s.verify?.batch?.end ?? null]);
      ok(steps.some((x) => x[0] === 'A' && x[1] === 'verify' && x[2] === 'passed'), `${JSON.stringify(steps)}\n${after}`);
      ok(steps.some((x) => x[0] === 'B' && x[1] === 'commit'), `B, started, kept stepping: ${JSON.stringify(steps)}`);
      ok(!steps.some((x) => x[0] === 'A' && x[1] !== 'verify'), `A's commit never started: ${JSON.stringify(steps)}\n${after}`);
      strictEqual(r.halt?.reason, 'interrupted', 'the wait ended only at the signal');
      ok(/waiting for the reset at /.test(after), after);
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('verify-lanes: the owner\'s rerun', () => {
  it('a lane whose request repeats on an unchanged tree parks no-progress; `--lane A --next verify` runs its checks once more and the lane goes on', { timeout: 300_000 }, async () => {
    const t = await setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [verify([{ kind: 'pass' }, { kind: 'fail' }]), verify([{ kind: 'pass' }, { kind: 'fail' }]), verify([{ kind: 'pass' }]), COMMIT], file: true } } });
    const logs = mkdtempSync(join(tmpdir(), 'verify-lanes-log-'));
    try {
      commitChecks(t);
      const log = join(logs, 'order.log');
      Object.assign(t.env, { VERIFY_FIXTURE_LOG: log });
      const ran = () => readFileSync(log, { encoding: 'utf8', flag: 'a+' }).split('\n').filter(Boolean);
      strictEqual(await t.run({}, { verifyBounds: BOUNDS }), 2, t.lines.join('\n'));
      const r1 = t.latest();
      deepStrictEqual(r1.steps.map((s) => [s.kind, s.outcome]), [['dispatch', 'ok'], ['verify', 'ok'], ['verb', 'ok'], ['verify', 'no-progress']], t.lines.join('\n'));
      strictEqual(PK.readPark(t.work, t.fx.macroId, 'A').record?.reason, 'no-progress');
      deepStrictEqual(ran(), ['pass', 'fail'], 'the repeat ran nothing');
      // The owner's rerun of lane A, as the CLI parses it.
      const { parseForcedStep } = await import('../../plugins/orchestrator/adapters/claude/autopilot/policy.mjs');
      const forcedPairs = [{ lane: 'A', step: parseForcedStep('verify') }];
      strictEqual(await t.run({ forcedPairs, forcedText: '--lane A --next verify' }, { verifyBounds: BOUNDS }), 2, t.lines.join('\n'));
      const r2 = t.latest();
      deepStrictEqual(r2.steps.map((s) => [s.kind, s.outcome]), [['verify', 'ok'], ['verb', 'ok'], ['verify', 'ok'], ['commit', 'ok']], t.lines.join('\n'));
      deepStrictEqual([r2.steps[0].forced, r2.steps[0].verify?.outcome, r2.steps[0].verify?.batch?.end], [true, 'ran', 'failed'], JSON.stringify(r2.steps[0]));
      deepStrictEqual(ran().slice(0, 4), ['pass', 'fail', 'pass', 'fail'], 'the rerun ran the batch whole, its passed check included');
    } finally {
      t.fx.cleanup();
      rmSync(logs, { recursive: true, force: true });
    }
  });

  it('a rerun whose batch yields to a hold before it starts is kept: once the hold is gone the batch runs as the rerun', { timeout: 300_000 }, async () => {
    const t = await setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [verify([{ kind: 'pass' }, { kind: 'fail' }]), verify([{ kind: 'pass' }, { kind: 'fail' }]), verify([{ kind: 'pass' }]), COMMIT], file: true } } });
    const logs = mkdtempSync(join(tmpdir(), 'verify-lanes-log-'));
    try {
      commitChecks(t);
      holdsOn(t);
      const log = join(logs, 'order.log');
      Object.assign(t.env, { VERIFY_FIXTURE_LOG: log });
      const ran = () => readFileSync(log, { encoding: 'utf8', flag: 'a+' }).split('\n').filter(Boolean);
      strictEqual(await t.run({}, { verifyBounds: BOUNDS }), 2, t.lines.join('\n'));
      strictEqual(PK.readPark(t.work, t.fx.macroId, 'A').record?.reason, 'no-progress');
      // The owner's rerun of lane A; a hold comes while its batch is prepared.
      const { parseForcedStep } = await import('../../plugins/orchestrator/adapters/claude/autopilot/policy.mjs');
      const { s, verifyOps, startVerify } = holdDuringPreparation(t);
      strictEqual(await t.run({ forcedPairs: [{ lane: 'A', step: parseForcedStep('verify') }], forcedText: '--lane A --next verify' }, { verifyBounds: BOUNDS, verifyOps, startVerify }), 2, t.lines.join('\n'));
      strictEqual(s.withdrawn, true, 'the hold was withdrawn before the settle');
      const r2 = t.latest();
      deepStrictEqual(r2.steps.map((x) => [x.kind, x.outcome, x.forced === true, x.verify?.outcome ?? null]), [
        ['verify', 'ok', true, 'stopped'], ['verify', 'ok', true, 'ran'], ['verb', 'ok', false, null], ['verify', 'ok', false, 'ran'], ['commit', 'ok', false, null],
      ], t.lines.join('\n'));
      strictEqual(r2.steps[1].verify?.batch?.end, 'failed', 'the rerun ran the batch, not the repeat rule');
      deepStrictEqual(ran().slice(0, 4), ['pass', 'fail', 'pass', 'fail']);
    } finally {
      t.fx.cleanup();
      rmSync(logs, { recursive: true, force: true });
    }
  });
});

describe('verify-lanes: the owner\'s interrupt', () => {
  it('a Ctrl-C during a batch whose persona write it fails ends the run interrupted, and parks no lane', { timeout: 300_000 }, async () => {
    const t = await setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [verify([{ kind: 'pass' }]), COMMIT] } } });
    try {
      commitChecks(t);
      // The batch's persona write is a child of the driver's foreground
      // group: the owner's Ctrl-C reaches it, and the step returns the
      // write's failure, as a real batch's does.
      let aborted = null;
      const startVerify = () => {
        let settle;
        const done = new Promise((r) => { settle = r; });
        setImmediate(() => t.signals.emit('SIGINT'));
        return {
          done,
          abort(why) {
            aborted ??= why;
            settle({ outcome: 'error', detail: 'state.mjs verify-batch-start was killed by SIGINT', wrote: true });
          },
        };
      };
      strictEqual(await t.run({}, { verifyBounds: BOUNDS, startVerify }), 2, t.lines.join('\n'));
      strictEqual(aborted, 'interrupted', 'the interrupt reached the batch');
      const r = t.latest();
      strictEqual(r.halt?.reason, 'interrupted', JSON.stringify(r.halt));
      const v = r.steps.find((s) => s.kind === 'verify');
      strictEqual(v?.outcome, 'interrupted', JSON.stringify(v));
      strictEqual(PK.readPark(t.work, t.fx.macroId, 'A').state, 'absent', 'an owner stop parks no lane');
    } finally {
      t.fx.cleanup();
    }
  });

  it('a Ctrl-C that comes during the look after a batch that failed is judged too, and parks no lane', { timeout: 300_000 }, async () => {
    const t = await setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [verify([{ kind: 'pass' }]), COMMIT] } } });
    try {
      commitChecks(t);
      // The batch fails on its own, with no interrupt; the owner's Ctrl-C
      // comes while the run looks at the lane after it.
      let ended = false;
      let sent = false;
      const startVerify = () => ({
        done: new Promise((r) => { setImmediate(() => { ended = true; r({ outcome: 'error', detail: 'a persona write failed (test)', wrote: true }); }); }),
        abort() {},
      });
      const observeAsync = async (a, o) => {
        if (ended && !sent) {
          sent = true;
          t.signals.emit('SIGINT');
        }
        return OL.observeInChild(a, o);
      };
      strictEqual(await t.run({}, { verifyBounds: BOUNDS, startVerify, observeAsync }), 2, t.lines.join('\n'));
      ok(sent, 'the interrupt came during a look after the batch');
      const r = t.latest();
      strictEqual(r.halt?.reason, 'interrupted', JSON.stringify(r.halt));
      strictEqual(r.steps.find((s) => s.kind === 'verify')?.outcome, 'interrupted', JSON.stringify(r.steps));
      strictEqual(PK.readPark(t.work, t.fx.macroId, 'A').state, 'absent', 'an owner stop parks no lane');
    } finally {
      t.fx.cleanup();
    }
  });
});
