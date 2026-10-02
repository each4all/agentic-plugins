// tests/orchestrator/test-autopilot-ledger.mjs
//
// ADR-0063 D1/D8 — the autopilot ledger and locks (plugins/orchestrator/
// adapters/claude/autopilot/ledger.mjs): run ids are valid AGENTIC_AUTOPILOT
// values, a step's `started` record pairs with its `finished` one (and stays
// alone when the driver died mid-step), and a lock — a directory of
// per-participant entries — is refused while another entry's driver or the
// worker it recorded lives, cleared of entries whose runs are gone, and held
// by at most one of any number of contenders.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const L = await import(resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/ledger.mjs'));
const { isAutopilotRun } = await import(resolve(REPO_ROOT, 'plugins/orchestrator/scripts/state.mjs'));
const { fingerprintForPid } = await import(resolve(REPO_ROOT, 'plugins/orchestrator/scripts/peer-runner.mjs'));

const MACRO = 'macro-plan-20261001T000000Z-abcdef';
const scratch = () => mkdtempSync(join(tmpdir(), 'autopilot-ledger-'));

async function deadPid() {
  const child = spawn(process.execPath, ['-e', '0']);
  await new Promise((r) => { child.on('exit', r); });
  return child.pid;
}

function sleeper() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  return child;
}

describe('run ids and records', () => {
  it('a run id is a valid AGENTIC_AUTOPILOT value', () => {
    const id = L.newRunId(new Date('2026-10-01T01:02:03.456Z'), () => 'abc123');
    strictEqual(id, 'autopilot-20261001T010203Z-abc123');
    ok(isAutopilotRun({ AGENTIC_AUTOPILOT: id }));
    throws(() => L.newRunId(new Date(), () => 'XYZ'), /not a valid autopilot run id/);
    throws(() => L.createRunDir(scratch(), 'autopilot-bad'), /invalid run id/);
  });

  it('pairs a step\'s started and finished records, and keeps a started one alone', () => {
    const repo = scratch();
    try {
      const id = L.newRunId();
      const dir = L.createRunDir(repo, id);
      L.writeRun(dir, { run_id: id, status: 'running' });
      L.appendStep(dir, { event: 'started', seq: 1, command: '/engineer:critique', session_id: 's1' });
      L.appendStep(dir, { event: 'finished', seq: 1, outcome: 'ok', cost_usd: 0.1 });
      L.appendStep(dir, { event: 'started', seq: 2, command: '/engineer:commit', session_id: 's2' });
      const r = L.readRun(repo, id);
      strictEqual(r.steps.length, 2);
      deepStrictEqual([r.steps[0].command, r.steps[0].outcome, r.steps[0].session_id], ['/engineer:critique', 'ok', 's1']);
      deepStrictEqual([r.steps[1].command, r.steps[1].event, r.steps[1].outcome], ['/engineer:commit', 'started', undefined]);
      deepStrictEqual(L.listRuns(repo), [id]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe('locks', () => {
  const record = (runId) => ({ run_id: runId, macro_id: MACRO, repo: '/r', started_at: 'now' });
  // An entry written as another participant would leave it.
  const plant = (lock, holder, name = `h-${holder.pid ?? 1}-${Math.random().toString(16).slice(2, 10)}.json`) => {
    mkdirSync(lock, { recursive: true });
    const file = join(lock, name);
    writeFileSync(file, typeof holder === 'string' ? holder : JSON.stringify(holder));
    return file;
  };
  const holders = (lock) => L.readLockEntries(lock).map((e) => e.holder?.run_id ?? null);

  it('is exclusive while its driver lives, and a release removes only the run\'s own entry', async () => {
    const main = scratch();
    try {
      const lock = L.macroLockPath(main, MACRO);
      const a = await L.acquireLock(lock, { record: record('run-a') });
      deepStrictEqual(holders(lock), ['run-a']);
      await rejects(L.acquireLock(lock, { record: record('run-b') }), L.LockHeldError);
      deepStrictEqual(holders(lock), ['run-a'], 'a refused run leaves no entry');
      a.release();
      deepStrictEqual(holders(lock), []);
      const b = await L.acquireLock(lock, { record: record('run-b') });
      a.release();
      deepStrictEqual(holders(lock), ['run-b'], 'a release by a run that no longer holds the lock leaves the holder\'s entry');
      b.release();
    } finally {
      rmSync(main, { recursive: true, force: true });
    }
  });

  it('clears an entry whose driver is gone, and takes the lock', async () => {
    const main = scratch();
    try {
      const lock = L.macroLockPath(main, MACRO);
      const stale = plant(lock, { ...record('run-old'), pid: await deadPid(), fingerprint: { kind: 'none' }, worker: null });
      const b = await L.acquireLock(lock, { record: record('run-new') });
      ok(!existsSync(stale), 'the stale entry is removed');
      deepStrictEqual(holders(lock), ['run-new']);
      b.release();
    } finally {
      rmSync(main, { recursive: true, force: true });
    }
  });

  it('is held while the worker it recorded lives, even after its driver died', async () => {
    const main = scratch();
    const worker = sleeper();
    try {
      const lock = L.macroLockPath(main, MACRO);
      const a = await L.acquireLock(lock, { record: record('run-a') });
      a.setWorker({ pid: worker.pid, fingerprint: await fingerprintForPid(worker.pid) });
      const held = JSON.parse(readFileSync(a.entry, 'utf8'));
      strictEqual(held.worker.pid, worker.pid);
      writeFileSync(a.entry, JSON.stringify({ ...held, pid: await deadPid() }));
      await rejects(L.acquireLock(lock, { record: record('run-b') }), /worker/);
      worker.kill('SIGKILL');
      await new Promise((r) => { worker.on('exit', r); });
      const b = await L.acquireLock(lock, { record: record('run-b') });
      deepStrictEqual(holders(lock), ['run-b']);
      b.release();
    } finally {
      try { worker.kill('SIGKILL'); } catch { /* gone */ }
      rmSync(main, { recursive: true, force: true });
    }
  });

  it('treats a reused pid (fingerprint changed) as stale, and an unverifiable one as live', async (t) => {
    const self = await fingerprintForPid(process.pid);
    if (self.kind === 'none') { t.skip('no process fingerprint on this platform'); return; }
    const main = scratch();
    try {
      const lock = L.macroLockPath(main, MACRO);
      const reused = { ...self, ...(self.kind === 'macos_lstart_command' ? { lstart: 'Thu Jan  1 00:00:00 1970' } : { starttime: '1' }) };
      plant(lock, { ...record('run-a'), pid: process.pid, fingerprint: reused, worker: null });
      const b = await L.acquireLock(lock, { record: record('run-b') });
      deepStrictEqual(holders(lock), ['run-b'], 'a live pid with another start time is another process');
      b.release();
      plant(lock, { ...record('run-c'), pid: process.pid, fingerprint: { kind: 'none' }, worker: null });
      await rejects(L.acquireLock(lock, { record: record('run-d') }), L.LockHeldError);
    } finally {
      rmSync(main, { recursive: true, force: true });
    }
  });

  it('treats a live holder whose fingerprint cannot be read now as live', async () => {
    const main = scratch();
    const holder = sleeper();
    try {
      const lock = L.macroLockPath(main, MACRO);
      const recorded = { kind: 'macos_lstart_command', lstart: 'x', command: 'y' };
      plant(lock, { ...record('run-a'), pid: holder.pid, fingerprint: recorded, worker: null });
      // The platform probe fails (no ps, no /proc): unverifiable is not stale.
      await rejects(L.acquireLock(lock, { record: record('run-b'), probe: async () => ({ kind: 'none' }) }), L.LockHeldError);
      strictEqual(await L.holderAlive({ pid: holder.pid, fingerprint: recorded }, { probe: async () => ({ kind: 'none' }) }), true);
    } finally {
      holder.kill('SIGKILL');
      rmSync(main, { recursive: true, force: true });
    }
  });

  it('counts a worker\'s process group while it has members, after the worker itself exited (round 4)', async () => {
    const dir = scratch();
    const pidfile = join(dir, 'member.pid');
    let member = null;
    try {
      // A group leader that starts a member and exits, as a worker whose group
      // outlived SIGKILL leaves it.
      const leader = spawn(process.execPath, ['-e', `
        const g = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
        require('node:fs').writeFileSync(process.argv[1], String(g.pid));
        g.unref();
      `, pidfile], { detached: true, stdio: 'ignore' });
      await new Promise((r) => { leader.on('exit', r); });
      member = Number(readFileSync(pidfile, 'utf8'));
      const holder = { pid: await deadPid(), fingerprint: { kind: 'none' }, worker: { pid: leader.pid, pgid: leader.pid, fingerprint: { kind: 'none' } } };
      strictEqual(await L.holderAlive(holder), true, 'the group still has a member');
      strictEqual(await L.holderAlive({ ...holder, worker: { ...holder.worker, pgid: null } }), false, 'without the group, driver and worker are both gone');
      process.kill(member, 'SIGKILL');
      for (let i = 0; i < 50 && await L.holderAlive(holder); i += 1) await new Promise((r) => { setTimeout(r, 100); });
      strictEqual(await L.holderAlive(holder), false, 'an empty group holds nothing');
    } finally {
      if (member) { try { process.kill(member, 'SIGKILL'); } catch { /* gone */ } }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a group under the worker\'s id whose leader is provably another process is not the run\'s (round 5)', async (t) => {
    const main = scratch();
    // A process group with a live leader, standing in for an unrelated group
    // that reused the worker's pid and process group id.
    const leader = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    try {
      const current = await fingerprintForPid(leader.pid);
      if (current.kind === 'none') { t.skip('no process fingerprint on this platform'); return; }
      const recorded = { ...current, ...(current.kind === 'macos_lstart_command' ? { lstart: 'Thu Jan  1 00:00:00 1970' } : { starttime: '1' }) };
      const holder = { ...record('run-a'), pid: await deadPid(), fingerprint: { kind: 'none' }, worker: { pid: leader.pid, pgid: leader.pid, fingerprint: recorded } };
      strictEqual(await L.holderAlive(holder), false, 'the leader started after the worker did: the worker\'s group had ended');
      strictEqual(await L.holderAlive({ ...holder, worker: { ...holder.worker, fingerprint: current } }), true, 'the worker itself, still running');
      strictEqual(await L.holderAlive({ ...holder, worker: { ...holder.worker, fingerprint: { kind: 'none' } } }), true, 'unverifiable: held');
      const lock = L.macroLockPath(main, MACRO);
      plant(lock, holder);
      const b = await L.acquireLock(lock, { record: record('run-b') });
      deepStrictEqual(holders(lock), ['run-b']);
      b.release();
    } finally {
      try { process.kill(-leader.pid, 'SIGKILL'); } catch { /* gone */ }
      rmSync(main, { recursive: true, force: true });
    }
  });

  it('only a different start proves a reused pid: a command line changed by an exec in place does not (round 6)', async () => {
    const main = scratch();
    // A live group leader whose pid the worker record names.
    const leader = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    try {
      const mac = (lstart, command) => ({ kind: 'macos_lstart_command', lstart, command });
      const linux = (starttime) => ({ kind: 'linux_proc_starttime', starttime });
      const deadDriver = await deadPid();
      const holder = (fingerprint) => ({ ...record('run-a'), pid: deadDriver, fingerprint: { kind: 'none' }, worker: { pid: leader.pid, pgid: leader.pid, fingerprint } });
      const cases = [
        ['macOS, same start, command changed by an exec', mac('Fri Oct  2 10:00:00 2026', 'claude -p'), mac('Fri Oct  2 10:00:00 2026', 'node /x/cli.js -p'), true],
        ['macOS, another start', mac('Fri Oct  2 10:00:00 2026', 'claude -p'), mac('Fri Oct  2 11:00:00 2026', 'claude -p'), false],
        ['Linux, another start', linux('100'), linux('200'), false],
        ['fingerprints of different kinds prove nothing', mac('Fri Oct  2 10:00:00 2026', 'claude -p'), linux('200'), true],
      ];
      for (const [name, recorded, current, held] of cases) {
        strictEqual(await L.holderAlive(holder(recorded), { probe: async () => current }), held, name);
      }
      const lock = L.macroLockPath(main, MACRO);
      plant(lock, holder(cases[0][1]));
      await rejects(L.acquireLock(lock, { record: record('run-b'), probe: async () => cases[0][2] }), L.LockHeldError, 'a live worker that exec\'d keeps its run\'s lock');
    } finally {
      try { process.kill(-leader.pid, 'SIGKILL'); } catch { /* gone */ }
      rmSync(main, { recursive: true, force: true });
    }
  });

  it('an entry rewritten between its read and its check is judged on what it says now (round 4)', async () => {
    const main = scratch();
    // A's driver, which records its worker and then dies while B is between
    // reading A's entry and checking A's processes.
    const driverA = sleeper();
    const workerA = sleeper();
    try {
      const lock = L.macroLockPath(main, MACRO);
      let entryA = null;
      const bodyA = { ...record('run-a'), pid: driverA.pid, fingerprint: { kind: 'none' }, worker: null };
      const b = L.acquireLock(lock, {
        record: record('run-b'),
        attempts: 1,
        hooks: {
          // A takes the lock after B's first look, before B adds its entry.
          beforeCreate: () => { entryA = plant(lock, bodyA, `h-${driverA.pid}-a0a0a0.json`); },
          afterRead: async (phase) => {
            if (phase !== 'recheck') return;
            // B has read A's entry with no worker. A records its worker (a
            // whole-file rewrite, as setWorker does) and its driver dies.
            writeFileSync(`${entryA}.tmp`, JSON.stringify({ ...bodyA, worker: { pid: workerA.pid, pgid: null, fingerprint: { kind: 'none' } } }));
            renameSync(`${entryA}.tmp`, entryA);
            driverA.kill('SIGKILL');
            await new Promise((r) => { driverA.on('exit', r); });
          },
        },
      });
      await rejects(b, L.LockHeldError, 'B must not take the lock beside A\'s live worker');
      ok(existsSync(entryA), 'A\'s entry, which protects its live worker, is left in place');
      strictEqual(JSON.parse(readFileSync(entryA, 'utf8')).worker.pid, workerA.pid);
    } finally {
      for (const p of [driverA, workerA]) { try { p.kill('SIGKILL'); } catch { /* gone */ } }
      rmSync(main, { recursive: true, force: true });
    }
  });

  it('provablySame needs a readable fingerprint that matches; liveness alone is not proof', async (t) => {
    const self = await fingerprintForPid(process.pid);
    strictEqual(await L.provablySame(process.pid, { kind: 'none' }), false, 'no recorded fingerprint: not proof');
    strictEqual(await L.provablySame(await deadPid(), self), false);
    strictEqual(await L.provablySame(process.pid, self, { probe: async () => ({ kind: 'none' }) }), false, 'an unreadable fingerprint is not proof');
    // A signal needs the whole fingerprint: the start time alone, which is
    // enough to keep a lock held, is not proof (round 7).
    const mac = (command) => ({ kind: 'macos_lstart_command', lstart: 'Fri Oct  2 10:00:00 2026', command });
    strictEqual(await L.provablySame(process.pid, mac('claude -p'), { probe: async () => mac('node /x/cli.js -p') }), false, 'same start, another command');
    strictEqual(await L.provablySame(process.pid, mac('claude -p'), { probe: async () => mac('claude -p') }), true, 'the whole fingerprint matches');
    if (self.kind === 'none') { t.skip('no process fingerprint on this platform'); return; }
    strictEqual(await L.provablySame(process.pid, self), true);
    strictEqual(await L.provablySame(process.pid, { ...self, lstart: 'x', starttime: 'x' }), false, 'a reused pid');
  });

  it('three contenders that all added their entries before any looked again: at most one holds (round 3)', async () => {
    const main = scratch();
    try {
      const lock = L.macroLockPath(main, MACRO);
      plant(lock, { ...record('stale'), pid: await deadPid(), fingerprint: { kind: 'none' }, worker: null });
      // Each contender pauses after adding its entry until all three have
      // added theirs, then looks again in the order given — the interleaving
      // that gave the takeover protocol two holders.
      for (const order of [['A', 'B', 'C'], ['C', 'A', 'B'], ['B', 'C', 'A']]) {
        let arrived = 0;
        let allIn;
        const allArrived = new Promise((r) => { allIn = r; });
        const gates = {};
        const contender = (name) => {
          let first = true;
          return L.acquireLock(lock, {
            record: record(name),
            attempts: 1,
            hooks: {
              afterCreate: async () => {
                if (!first) return;
                first = false;
                arrived += 1;
                if (arrived === 3) allIn();
                await allArrived;
                await new Promise((r) => { gates[name] = r; });
              },
            },
          });
        };
        const runs = Object.fromEntries(['A', 'B', 'C'].map((n) => [n, contender(n)]));
        await allArrived;
        while (Object.keys(gates).length < 3) await new Promise((r) => { setImmediate(r); });
        const settled = {};
        for (const n of order) {
          gates[n]();
          settled[n] = await runs[n].then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));
        }
        const won = Object.entries(settled).filter(([, s]) => s.ok);
        ok(won.length <= 1, `${order.join('')}: ${won.map(([n]) => n).join(', ')} all hold the lock`);
        for (const [, s] of Object.entries(settled)) if (!s.ok) ok(s.e instanceof L.LockHeldError, String(s.e));
        for (const [, s] of won) s.v.release();
        deepStrictEqual(holders(lock).filter((h) => h !== 'stale'), [], 'every contender\'s entry is gone after its release or refusal');
      }
    } finally {
      rmSync(main, { recursive: true, force: true });
    }
  });

  it('of many contenders racing freely, exactly one holds, and the rest are refused', async () => {
    const main = scratch();
    try {
      const lock = L.macroLockPath(main, MACRO);
      for (let round = 0; round < 10; round += 1) {
        plant(lock, { ...record('stale'), pid: await deadPid(), fingerprint: { kind: 'none' }, worker: null });
        const results = await Promise.allSettled(['x', 'y', 'z', 'w'].map((n) => L.acquireLock(lock, { record: record(`${n}${round}`) })));
        const won = results.filter((r) => r.status === 'fulfilled');
        strictEqual(won.length, 1, `round ${round}: ${results.map((r) => r.status).join(', ')}`);
        for (const r of results.filter((x) => x.status === 'rejected')) ok(r.reason instanceof L.LockHeldError, String(r.reason));
        deepStrictEqual(holders(lock), [won[0].value === undefined ? null : JSON.parse(readFileSync(won[0].value.entry, 'utf8')).run_id]);
        won[0].value.release();
      }
    } finally {
      rmSync(main, { recursive: true, force: true });
    }
  });

  it('waits for an unparsable entry while it is fresh, and clears it once it is old', async () => {
    const main = scratch();
    try {
      const lock = L.macroLockPath(main, MACRO);
      const half = plant(lock, '{"half', 'h-1-aaaa.json');
      await rejects(L.acquireLock(lock, { record: record('b'), attempts: 3 }), /could not take/);
      const old = (Date.now() - 60_000) / 1000;
      utimesSync(half, old, old);
      const b = await L.acquireLock(lock, { record: record('b') });
      ok(!existsSync(half));
      deepStrictEqual(holders(lock), ['b']);
      b.release();
    } finally {
      rmSync(main, { recursive: true, force: true });
    }
  });

  it('clears a temporary file whose writer is gone, and keeps a live writer\'s', async () => {
    const main = scratch();
    try {
      const lock = L.macroLockPath(main, MACRO);
      mkdirSync(lock, { recursive: true });
      const dead = join(lock, `t-${await deadPid()}-abcd.tmp`);
      const live = join(lock, `t-${process.pid}-abcd.tmp`);
      writeFileSync(dead, '');
      writeFileSync(live, '');
      const a = await L.acquireLock(lock, { record: record('a') });
      ok(!existsSync(dead));
      ok(existsSync(live));
      a.release();
    } finally {
      rmSync(main, { recursive: true, force: true });
    }
  });

  it('lists the macro locks and this worktree\'s lock, one row per entry', async () => {
    const main = scratch();
    try {
      const m = await L.acquireLock(L.macroLockPath(main, MACRO), { record: record('r1') });
      const w = await L.acquireLock(L.worktreeLockPath(main), { record: record('r1') });
      const locks = L.listLocks(main, main);
      deepStrictEqual(locks.map((l) => [l.kind, l.holder.run_id]), [['macro', 'r1'], ['worktree', 'r1']]);
      strictEqual(locks[0].macroId, MACRO);
      deepStrictEqual(locks.map((l) => l.entry), [m.entry, w.entry]);
      ok(!L.listRuns(main).length, 'lock directories are not runs');
      m.release();
      w.release();
      deepStrictEqual(L.listLocks(main, main), []);
    } finally {
      rmSync(main, { recursive: true, force: true });
    }
  });
});
