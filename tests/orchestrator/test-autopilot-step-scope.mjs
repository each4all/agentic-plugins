// tests/orchestrator/test-autopilot-step-scope.mjs
//
// C181 (ADR-0023 §6, amendments of 2026-11-22 and 2026-11-24, the autopilot
// worker) — the scope of an autopilot step, in process, through seams:
//   - the plan (step-scope.mjs planStepScope): a scope only on a placement read
//     outside every launcher's scope, the owner `autopilot-step` with the run
//     and the step's seq;
//   - the launch (launchStep): the identity on the step's records before the
//     word; a failure before the word marks the recorded attempt abandoned
//     before a direct launch, or launches nothing when the mark cannot be
//     written or a cancellation came;
//   - the end (endStepScope): the kill, then the wait for gone, bounded;
//   - what a step leaves (lingers): a scope not read gone is kept as a group
//     that outlived SIGKILL is;
//   - the run locks' gate (scripts/lib/run-locks.mjs judgeStepScope, and
//     acquireLock over a dead driver's entry): an entry held by a scope not
//     read gone refuses, naming the unit and the step, and is kept; the kill
//     is written only where the entry binds the scope, the step's record
//     agrees and the driver is proven gone;
//   - the step ledger's reducers: the last `scope` line is the step's.
// The live scope, on a real user manager: test-autopilot-worker.mjs (its pipe
// holder case) and test-autopilot-dead-runs.mjs (a driver killed mid-step).

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tmpDir } from '../_tmp.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const AP = resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot');
const SS = await import(join(AP, 'step-scope.mjs'));
const L = await import(join(AP, 'ledger.mjs'));
const RL = await import(resolve(REPO_ROOT, 'plugins/orchestrator/scripts/lib/run-locks.mjs'));

const RUN = 'autopilot-20261125T120000Z-abc123';
const BOOT = 'e55a09fa-13b3-445f-9aa0-4b51e123717f';
const CLOCK = `${BOOT}/time:[4026531834]/pid:[4026531836]`;
const UNIT = `agentic-launch-${RUN}-s3-0123456789abcdef.scope`;
// A pid no process holds: the driver of a dead run.
const DEAD_PID = (() => {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const pid = Number(r.stdout);
  if (r.status !== 0 || !Number.isSafeInteger(pid) || pid <= 0) throw new Error(`could not take a dead pid: ${r.error ?? r.stderr}`);
  return pid;
})();

function identity(over = {}) {
  return {
    owner: { kind: 'autopilot-step', run: RUN, step: '3' },
    unit: UNIT,
    invocation_id: '0123456789abcdef0123456789abcdef',
    cgroup_path: `/user.slice/user-1000.slice/user@1000.service/app.slice/${UNIT}`,
    cgroup_id: '18446744073709551615',
    boot_id: BOOT,
    gate: { pid: 4242, starttime: '123456', clock: CLOCK },
    supervisor: { pid: DEAD_PID, fingerprint: { kind: 'linux_proc_starttime', starttime: '123400' }, clock: CLOCK, boot_id: BOOT },
    has_snapshot: false,
    association: null,
    ...over,
  };
}
const scoped = (over = {}) => ({ version: 1, state: 'scoped', identity: identity(over) });

// An ender that records what it is asked: supervisorGone answers `gone`, a
// kill `kill`, and a reading the next of `reads` (the last repeats).
function fakeEnder({ gone = false, kill = { state: 'written' }, reads = [{ state: 'gone' }] } = {}) {
  const calls = [];
  let i = 0;
  return {
    calls,
    supervisorGone: (s) => { calls.push(['supervisorGone', s.pid]); return { gone }; },
    kill: (id) => { calls.push(['kill', id.unit]); return kill; },
    read: (id) => { calls.push(['read', id.unit]); const r = reads[Math.min(i, reads.length - 1)]; i += 1; return r; },
  };
}

describe('the plan: a scope only outside every launcher\'s scope', () => {
  const plan = (checks) => SS.planStepScope({ runId: RUN, seq: 3, env: {}, checks });
  it('outside: gated, owned by the step, its unit named for the run and the step', () => {
    const p = plan({ availability: () => ({ available: true }), placement: () => ({ inside: false }) });
    strictEqual(p.kind, 'gated');
    deepStrictEqual(p.owner, { kind: 'autopilot-step', run: RUN, step: '3' });
    ok(p.unit.startsWith(`agentic-launch-${RUN}-s3-`) && p.unit.endsWith('.scope'), p.unit);
    strictEqual(p.association, null, 'a driver outside any step has no association');
  });
  it('inside a launcher\'s scope: none, naming the enclosing unit, whose kill covers the step', () => {
    const p = plan({ availability: () => ({ available: true }), placement: () => ({ inside: true, enclosingUnit: UNIT }) });
    deepStrictEqual([p.kind, p.record], ['direct', { version: 1, state: 'none', reason: 'inside-launcher', enclosing_unit: UNIT }]);
  });
  it('no scope can be made, a placement that cannot be told, or a check that throws: none, unavailable, with the check', () => {
    const none = { version: 1, state: 'none', reason: 'unavailable' };
    const a = plan({ availability: () => ({ available: false, check: 'platform' }), placement: () => { throw new Error('not reached'); } });
    deepStrictEqual([a.kind, a.record, a.why], ['direct', none, 'platform']);
    const b = plan({ availability: () => ({ available: true }), placement: () => ({ withheld: 'check-timeout' }) });
    deepStrictEqual([b.kind, b.record, b.why], ['direct', none, 'check-timeout']);
    const c = plan({ availability: () => { throw new Error('boom'); } });
    deepStrictEqual([c.kind, c.record, c.why], ['direct', none, 'check-failed: boom']);
  });
});

describe('the launch: the identity on the step\'s records before the word', () => {
  const gated = { kind: 'gated', unit: UNIT, owner: { kind: 'autopilot-step', run: RUN, step: '3' }, association: null };
  const launch = (o) => {
    const records = [];
    const spawned = [];
    const res = SS.launchStep({
      plan: gated, command: 'claude', args: ['-p'], options: {},
      recordScope: async (r) => { if (o.failRecord?.(r)) throw new Error('disk full'); records.push(r.state); },
      spawnGatedFn: () => ({ gate: true }),
      spawnDirect: () => { spawned.push('direct'); return { direct: true }; },
      handshake: async (child, h) => {
        if (o.answer.recorded) { try { await h.record(identity()); } catch { /* the handshake's own failure */ } }
        return o.answer;
      },
      ...o.over,
    });
    return res.then((r) => ({ r, records, spawned }));
  };
  it('launched: scoped, its record written by the handshake before the word', async () => {
    const { r, records, spawned } = await launch({ answer: { launched: true, identity: identity(), recorded: true } });
    deepStrictEqual([r.scoped, r.child, records, spawned], [true, { gate: true }, ['scoped'], []]);
  });
  it('a failure after the record: marked abandoned, then a direct launch', async () => {
    const { r, records, spawned } = await launch({ answer: { launched: false, check: 'recheck-gate', recorded: true } });
    deepStrictEqual([r.scoped, r.child, r.record.state, records, spawned], [false, { direct: true }, 'abandoned', ['scoped', 'abandoned'], ['direct']]);
  });
  it('an abandoned mark that cannot be written launches nothing', async () => {
    const { r, spawned } = await launch({ answer: { launched: false, check: 'record', recorded: true }, failRecord: (rec) => rec.state === 'abandoned' });
    deepStrictEqual([r.child, r.failure, spawned], [null, 'scope_abandon_unwritten', []]);
  });
  it('a cancellation before the word launches nothing, recorded or not', async () => {
    const ac = new AbortController();
    ac.abort();
    const a = await launch({ answer: { launched: false, check: 'cancelled', recorded: true }, over: { signal: ac.signal } });
    deepStrictEqual([a.r.child, a.r.failure, a.spawned], [null, 'cancelled', []]);
    const b = await launch({ answer: { launched: false, check: 'cancelled', recorded: false }, over: { plan: { kind: 'direct', record: null }, signal: ac.signal } });
    deepStrictEqual([b.r.child, b.r.failure, b.spawned], [null, 'cancelled', []]);
  });
  it('a direct plan launches at once; its `none` record grants nothing, so a write that fails stops nothing', async () => {
    const none = { version: 1, state: 'none', reason: 'unavailable' };
    const { r, spawned } = await launch({ answer: {}, failRecord: () => true, over: { plan: { kind: 'direct', record: none } } });
    deepStrictEqual([r.scoped, r.child, r.record, spawned], [false, { direct: true }, none, ['direct']]);
  });
});

describe('the end: the kill, then the wait for gone, bounded', () => {
  it('a kill read gone needs no reading; one withheld gets the ender\'s one reading', async () => {
    const a = fakeEnder({ kill: { state: 'gone' } });
    const ra = await SS.endStepScope(identity(), { ender: a });
    deepStrictEqual([ra.reading.state, ra.teardown.state, a.calls.map((c) => c[0])], ['gone', 'gone', ['kill']]);
    const b = fakeEnder({ kill: { state: 'withheld', check: 'manager-unit' }, reads: [{ state: 'withheld', check: 'manager-unit' }] });
    const rb = await SS.endStepScope(identity(), { ender: b });
    deepStrictEqual([rb.teardown.state, rb.teardown.check, b.calls.map((c) => c[0])], ['withheld', 'manager-unit', ['kill', 'read']]);
  });
  it('a kill written is read until gone; one never read gone stops at the bound with its last reading', async () => {
    const reads = [{ state: 'unproven' }, { state: 'unproven' }, { state: 'gone' }];
    let n = 0;
    const r = await SS.endStepScope(identity(), { ender: fakeEnder(), read: () => reads[n++], waitMs: 10_000 });
    deepStrictEqual([r.reading.state, n], ['gone', 3]);
    let clock = 0;
    const stuck = await SS.endStepScope(identity(), { ender: fakeEnder(), read: () => { clock += 4000; return { state: 'unproven', check: 'members' }; }, waitMs: 10_000, now: () => clock });
    deepStrictEqual([stuck.teardown.state, stuck.teardown.check, clock], ['unproven', 'members', 12_000]);
  });
});

describe('what a step leaves', () => {
  it('a scope not read gone lingers as a group that outlived SIGKILL does; a gone one, or none, does not', () => {
    const w = (over) => ({ groupTeardown: 'terminated', scopeTeardown: null, scope: scoped(), pgid: 7, ...over });
    deepStrictEqual([
      SS.lingers(w({})), SS.lingers(w({ scopeTeardown: { state: 'gone', at: 'x' } })),
      SS.lingers(w({ scopeTeardown: { state: 'unproven', at: 'x' } })), SS.lingers(w({ groupTeardown: 'lingering' })), SS.lingers(null),
    ], [false, false, true, true, false]);
    const detail = SS.lingeringDetail(w({ scopeTeardown: { state: 'refused', at: 'x', check: 'EPERM' } }));
    ok(detail.includes(UNIT) && detail.includes('refused: EPERM') && detail.includes(`systemctl --user stop ${UNIT}`), detail);
    strictEqual(SS.lingerReason(w({ scopeTeardown: { state: 'unproven', at: 'x' } })), 'the step\'s scope was not read gone');
  });
});

describe('the run locks\' gate over a step\'s scope', () => {
  const holder = (over = {}, workerOver = {}) => ({
    run_id: RUN, repo: '/nowhere', pid: DEAD_PID, fingerprint: { kind: 'none' },
    worker: { pid: null, pgid: null, fingerprint: null, seq: 3, scope: scoped(), ...workerOver }, ...over,
  });
  const judge = (ender, agrees = true) => RL.createScopeJudge({ ender, stepRecord: (h) => (agrees ? { scope: h.worker.scope } : { scope: scoped({ invocation_id: 'f'.repeat(32) }) }) });

  it('an entry carrying no step scope is not the gate\'s', () => {
    for (const worker of [null, { pid: 1 }, { scope: { version: 1, state: 'none', reason: 'unavailable' } }, { scope: { version: 1, state: 'abandoned', identity: identity() } }]) {
      strictEqual(RL.judgeStepScope(holder({ worker }), judge(fakeEnder())), null, JSON.stringify(worker));
    }
  });
  it('bound, agreed with the step\'s record, its driver proven gone: the kill first, then the reading', () => {
    const e = fakeEnder({ gone: true });
    const h = RL.judgeStepScope(holder(), judge(e));
    deepStrictEqual([h.state, h.unit, h.step], ['gone', UNIT, '3']);
    deepStrictEqual(e.calls.map((c) => c[0]), ['supervisorGone', 'kill', 'read']);
  });
  it('no kill where the driver is not proven gone, the step\'s record disagrees, or the entry names another step: held while not read gone', () => {
    const cases = [
      [fakeEnder({ gone: false, reads: [{ state: 'unproven' }] }), holder(), true],
      [fakeEnder({ gone: true, reads: [{ state: 'unproven' }] }), holder(), false],
      [fakeEnder({ gone: true, reads: [{ state: 'unproven' }] }), holder({}, { seq: 4 }), true],
      [fakeEnder({ gone: true, reads: [{ state: 'unproven' }] }), holder({ run_id: 'autopilot-20261125T120000Z-other1' }), true],
    ];
    for (const [e, h, agrees] of cases) {
      const r = RL.judgeStepScope(h, judge(e, agrees));
      strictEqual(r.state, 'held');
      ok(!e.calls.some((c) => c[0] === 'kill'), JSON.stringify(e.calls));
    }
  });
  it('a scope of a version this reader does not know is held, withheld', () => {
    const r = RL.judgeStepScope(holder({}, { scope: { version: 2 } }), judge(fakeEnder()));
    deepStrictEqual([r.state, r.reading], ['held', { state: 'withheld', check: 'unknown-version' }]);
  });

  it('acquireLock: a dead driver\'s entry held by its step\'s scope refuses, naming the unit and the step, and stays; read gone, it is debris', async (t) => {
    const lock = join(tmpDir(t, 'step-scope-lock-'), 'm.lock');
    mkdirSync(lock, { recursive: true });
    const entry = join(lock, `h-${DEAD_PID}-aaaaaaaaaaaa.json`);
    writeFileSync(entry, `${JSON.stringify(holder())}\n`);
    const held = fakeEnder({ gone: true, kill: { state: 'refused', check: 'EPERM' }, reads: [{ state: 'refused', check: 'EPERM' }] });
    await rejects(RL.acquireLock(lock, { record: { run_id: 'next' }, scopes: judge(held) }), (e) => {
      ok(e instanceof RL.LockHeldError && e.scopeHold?.unit === UNIT, e.message);
      ok(e.message.includes(UNIT) && e.message.includes('step 3') && e.message.includes('refused: EPERM'), e.message);
      return true;
    });
    ok(existsSync(entry), 'the held entry is no debris');
    const lock2 = await RL.acquireLock(lock, { record: { run_id: 'next' }, scopes: judge(fakeEnder({ gone: true })) });
    ok(!existsSync(entry), 'an entry whose scope reads gone, and whose driver and group are gone, is debris');
    lock2.release();
  });
});

describe('the step ledger: the last scope line is the step\'s', () => {
  it('readRun keeps the step\'s started and takes its last scope record', (t) => {
    const repo = tmpDir(t, 'step-scope-ledger-');
    const dir = L.createRunDir(repo, RUN);
    L.writeRun(dir, { run_id: RUN });
    L.appendStep(dir, { event: 'started', seq: 3, kind: 'verb', command: '/engineer:compose' });
    L.appendStep(dir, { event: 'scope', seq: 3, scope: scoped() });
    L.appendStep(dir, { event: 'scope', seq: 3, scope: { version: 1, state: 'abandoned', identity: identity() } });
    const step = L.readRun(repo, RUN).steps.find((s) => s.seq === 3);
    deepStrictEqual([step.event, step.command, step.scope.state], ['started', '/engineer:compose', 'abandoned']);
    // The lock gate's reader of the step's record reads the same line.
    deepStrictEqual(RL.readStepScopeRecord({ repo, run_id: RUN, worker: { seq: 3 } })?.scope?.state, 'abandoned');
  });
});

const W = await import(join(AP, 'worker.mjs'));

describe('the worker\'s launch through a scope (worker.mjs, its launch seam)', () => {
  const FAKE = resolve(REPO_ROOT, 'tests/orchestrator/fixtures/autopilot-fake-claude.mjs');
  const gated = () => ({ kind: 'gated', unit: UNIT, owner: { kind: 'autopilot-step', run: RUN, step: '3' }, association: null });
  const start = (t, scope) => {
    const dir = tmpDir(t, 'step-scope-worker-');
    return W.startWorker({
      cwd: dir, prompt: 'x', stepKind: 'verb', runId: RUN, seq: 3, roots: { orchestrator: '/o', engineer: '/e', runtime: '/r' },
      stepBudgetUsd: 1, stepTimeoutSec: 30, model: null, effort: null, rawPath: join(dir, 'worker-3.jsonl'),
      env: { ...process.env, AUTOPILOT_CLAUDE_BIN: FAKE, FAKE_CLAUDE_MODE: 'simple' }, scope,
    });
  };
  it('a recorded identity whose abandoned mark was not written: nothing runs, the step ends that scope, and keeps the run\'s records while it is not read gone', async (t) => {
    const ended = [];
    const h = start(t, {
      plan: gated,
      launch: async () => ({ child: null, failure: 'scope_abandon_unwritten', identity: identity() }),
      end: async (id) => { ended.push(id.unit); return { teardown: { state: 'unproven', at: '2026-11-25T12:00:00Z' } }; },
    });
    h.begin();
    strictEqual(await h.ready, null);
    const w = await h.done;
    deepStrictEqual([ended, w.scope.state, w.scopeTeardown.state, SS.lingers(w), w.sessionId], [[UNIT], 'scoped', 'unproven', true, null]);
    ok(/launched nothing \(scope_abandon_unwritten\)/.test(w.spawnError), w.spawnError);
  });
  it('an abort while the launch is under way cancels it: nothing runs, and the step ends aborted', async (t) => {
    let signal = null;
    const h = start(t, {
      plan: gated,
      launch: (o) => { signal = o.signal; return new Promise((r) => { o.signal.addEventListener('abort', () => r({ child: null, failure: 'cancelled' })); }); },
      end: async () => { throw new Error('no scope was made'); },
    });
    h.begin();
    h.abort('interrupted');
    const w = await h.done;
    deepStrictEqual([signal.aborted, w.aborted, w.spawnError, w.scopeTeardown, h.pid], [true, 'interrupted', null, null, null]);
  });
  it('an abort while the group\'s teardown is pending signals nothing outside it: the teardown owns the group', async (t) => {
    let pid = null;
    const signals = [];
    let h = null;
    h = W.startWorker({
      ...(() => { const dir = tmpDir(t, 'step-scope-worker-'); return { cwd: dir, rawPath: join(dir, 'worker-3.jsonl') }; })(),
      prompt: 'x', stepKind: 'verb', runId: RUN, seq: 3, roots: { orchestrator: '/o', engineer: '/e', runtime: '/r' },
      stepBudgetUsd: 1, stepTimeoutSec: 30, model: null, effort: null,
      env: { ...process.env, AUTOPILOT_CLAUDE_BIN: FAKE, FAKE_CLAUDE_MODE: 'simple' },
      terminateGroup: async () => {
        const kill = t.mock.method(process, 'kill', (target, sig) => { signals.push([target, sig]); return true; });
        try {
          h.abort('interrupted');
          await new Promise((r) => setTimeout(r, 50));
        } finally {
          kill.mock.restore();
        }
        return 'terminated';
      },
      scope: {
        plan: gated,
        launch: async (o) => {
          const { spawn } = await import('node:child_process');
          const child = spawn(o.command, o.args, o.options);
          pid = child.pid;
          return { child, scoped: true, identity: identity() };
        },
        end: async () => ({ teardown: { state: 'gone', at: '2026-11-25T12:00:00Z' } }),
      },
    });
    h.begin();
    ok((await h.ready)?.pid === pid && Number.isInteger(pid));
    const w = await h.done;
    deepStrictEqual([signals.filter(([target]) => target === -pid || target === pid), w.scopeTeardown.state], [[], 'gone']);
  });
  it('an abort while the scope\'s end runs, after the group was emptied, signals nothing: the worker\'s id may be another group\'s', async (t) => {
    let pid = null;
    const signals = [];
    let h = null;
    h = W.startWorker({
      ...(() => { const dir = tmpDir(t, 'step-scope-worker-'); return { cwd: dir, rawPath: join(dir, 'worker-3.jsonl') }; })(),
      prompt: 'x', stepKind: 'verb', runId: RUN, seq: 3, roots: { orchestrator: '/o', engineer: '/e', runtime: '/r' },
      stepBudgetUsd: 1, stepTimeoutSec: 30, model: null, effort: null,
      env: { ...process.env, AUTOPILOT_CLAUDE_BIN: FAKE, FAKE_CLAUDE_MODE: 'simple' },
      terminateGroup: async () => 'terminated',
      scope: {
        plan: gated,
        launch: async (o) => {
          const { spawn } = await import('node:child_process');
          const child = spawn(o.command, o.args, o.options);
          pid = child.pid;
          return { child, scoped: true, identity: identity() };
        },
        end: async () => {
          // The group is released (pid reads null); an abort now must not
          // reach -pid, nor the child by its id.
          const kill = t.mock.method(process, 'kill', (target, sig) => { signals.push([target, sig]); return true; });
          try {
            strictEqual(h.pid, null);
            h.abort('interrupted');
            await new Promise((r) => setTimeout(r, 50));
          } finally {
            kill.mock.restore();
          }
          return { teardown: { state: 'gone', at: '2026-11-25T12:00:00Z' } };
        },
      },
    });
    h.begin();
    ok((await h.ready)?.pid === pid && Number.isInteger(pid));
    const w = await h.done;
    deepStrictEqual([signals.filter(([target]) => target === -pid || target === pid), w.scopeTeardown.state], [[], 'gone']);
  });
});

describe('a scope record that claims a scope but does not parse', () => {
  it('is held by the lock gate, with no kill', () => {
    const e = fakeEnder({ gone: true });
    const h = RL.judgeStepScope({ run_id: RUN, repo: '/nowhere', pid: DEAD_PID, worker: { seq: 3, scope: { version: 1, state: 'scoped', identity: { unit: UNIT } } } }, RL.createScopeJudge({ ender: e, stepRecord: () => null }));
    deepStrictEqual([h.state, h.unit, h.reading.check, e.calls], ['held', UNIT, 'malformed', []]);
  });
});
