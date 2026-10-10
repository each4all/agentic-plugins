// tests/orchestrator/test-autopilot-offloop.mjs
//
// ADR-0067 Decision 6 — the synchronous work a run with lanes runs in a child
// process (plugins/orchestrator/adapters/claude/autopilot/offloop.mjs). A task
// answers { value } or { error } and never rejects: the scheduler turns an
// error into the lane's halt, a kept lane or a warning, never into an abort
// of the workers in flight.

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, rejects, strictEqual } from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const OFFLOOP = resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/offloop.mjs');
const RUN_LOCKS = resolve(REPO_ROOT, 'plugins/orchestrator/scripts/lib/run-locks.mjs');
const { createTaskRunner, offLoop, observeInChild } = await import(OFFLOOP);
const { acquireLock, LockHeldError, readLockEntries } = await import(RUN_LOCKS);
const { terminateGroup, terminateGroupsSync } = await import(resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/worker.mjs'));

const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
async function gone(pid, ms = 3000) {
  for (let i = 0; i < ms / 50 && alive(pid); i += 1) await pause(50);
  return !alive(pid);
}
async function appears(file, ms = 20_000) {
  for (let i = 0; i < ms / 50 && !existsSync(file); i += 1) await pause(50);
  return existsSync(file);
}
// A checkout whose fetch blocks: git runs the ssh command through sh, which
// records its pid, then `then` (a sleep by default).
function blockingRemote(dir, then = 'sleep 30; :') {
  execFileSync('git', ['init', '-q', dir]);
  execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'ssh://offloop.invalid/x']);
  const pidFile = join(dir, 'transport.pid');
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: `echo $$ > '${pidFile}'; ${then}` };
  return { pidFile, env, pid: () => Number(readFileSync(pidFile, 'utf8')) };
}

describe('offLoop', () => {
  it('a task that throws answers { error } with its message, and never rejects', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'offloop-'));
    try {
      const r = await offLoop('removeLane', { home: { mainRoot: dir, lanesDir: dir }, macroId: 'not a macro id!', subtaskId: 'A', protect: [] }, { cwd: dir });
      deepStrictEqual(Object.keys(r), ['error']);
      match(r.error, /not a macro id/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a task that answers is its value: a refusal the lane layer returns is a value, not an error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'offloop-'));
    try {
      const r = await offLoop('fetchBaseline', { checkout: dir, baseline: '../not a branch' }, { cwd: dir });
      strictEqual(r.error, undefined);
      strictEqual(r.value.ok, false);
      match(r.value.halt.detail, /not a branch name the driver uses/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a task that runs out of time, or is not a task, answers { error }', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'offloop-'));
    try {
      match((await offLoop('fetchBaseline', { checkout: dir, baseline: 'main' }, { cwd: dir, timeoutMs: 1 })).error, /the fetchBaseline task did not finish in 0 s/);
      match((await offLoop('nope', {}, { cwd: dir })).error, /no task nope/);
      const v = await observeInChild({ repoRoot: dir, roots: {}, macroId: null, fetch: false }, { timeoutMs: 1 });
      match(v.lookError, /^the look did not finish/);
      ok(v.git.detached && v.macro === null, 'a failed look is a view every guard halts on');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a task that runs out of time is killed with everything it started: a git fetch\'s transport does not outlive the answer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'offloop-'));
    try {
      execFileSync('git', ['init', '-q', dir]);
      execFileSync('git', ['-C', dir, 'remote', 'add', 'origin', 'ssh://offloop.invalid/x']);
      const pidFile = join(dir, 'transport.pid');
      // git runs the ssh command through sh, which records its pid and waits.
      const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_SSH_COMMAND: `echo $$ > '${pidFile}'; sleep 30; :` };
      const r = await offLoop('fetchBaseline', { checkout: dir, baseline: 'main' }, { cwd: dir, env, timeoutMs: 3000 });
      match(r.error, /the fetchBaseline task did not finish in 3 s/);
      const pid = Number(readFileSync(pidFile, 'utf8'));
      ok(pid > 0);
      let alive = true;
      for (let i = 0; i < 60 && alive; i += 1) {
        try {
          process.kill(pid, 0);
          await new Promise((res) => { setTimeout(res, 50); });
        } catch {
          alive = false;
        }
      }
      ok(!alive, `the transport git started (pid ${pid}) outlived the task's timeout`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a task\'s processes are held as a worker\'s are (ADR-0067 Decision 6, Locks)', () => {
  it('a task\'s group goes on the locks before the task has its input, and its entry goes only once the group is empty', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'offloop-'));
    try {
      const repo = join(dir, 'repo');
      const remote = blockingRemote(repo);
      const lockDir = join(dir, 'macro.lock');
      const lock = await acquireLock(lockDir, { record: { run_id: 'r1' } });
      let ranBeforeHeld = null;
      let atTeardown = null;
      const answer = offLoop('fetchBaseline', { checkout: repo, baseline: 'main' }, {
        cwd: repo, env: remote.env, timeoutMs: 4000,
        // The entries as the group is emptied: still there.
        terminate: (pgid) => {
          atTeardown = readLockEntries(lockDir).map((e) => e.holder?.worker?.task ?? null);
          return terminateGroup(pgid);
        },
        hold: async (group) => {
          const entry = lock.addWorkerGroup(group);
          // Given time to run, a task that had its input would have begun.
          await pause(500);
          ranBeforeHeld = existsSync(remote.pidFile);
          return [entry];
        },
      });
      ok(await appears(remote.pidFile), 'the task ran once it had its input');
      strictEqual(ranBeforeHeld, false, 'the task did nothing before its group was on the lock');
      const during = readLockEntries(lockDir).map((e) => e.holder?.worker).filter(Boolean);
      deepStrictEqual(during.map((w) => [w.task, Number.isInteger(w.pid), w.pgid === w.pid]), [['fetchBaseline', true, true]]);
      match((await answer).error, /the fetchBaseline task did not finish in 4 s/);
      deepStrictEqual(atTeardown?.sort(), [null, 'fetchBaseline'].sort(), 'the group\'s entry stays until its group is empty');
      ok(!alive(remote.pid()), 'the transport is gone when the task answers');
      deepStrictEqual(readLockEntries(lockDir).map((e) => e.holder?.worker ?? null), [null], 'only the run\'s own entry is left');
      lock.release();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a task that answers leaves nothing behind: a process it left running in its group is emptied before the answer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'offloop-'));
    try {
      const repo = join(dir, 'repo');
      const bgFile = join(dir, 'bg.pid');
      // The transport leaves a process behind in the task's group and fails, so the fetch answers at once.
      const remote = blockingRemote(repo, `sleep 30 >/dev/null 2>&1 </dev/null & echo $! > '${bgFile}'; false`);
      const r = await offLoop('fetchBaseline', { checkout: repo, baseline: 'main' }, { cwd: repo, env: remote.env, timeoutMs: 60_000 });
      strictEqual(r.error, undefined, r.error);
      strictEqual(r.value.ok, false, 'the failed fetch is the lane layer\'s answer');
      const bg = Number(readFileSync(bgFile, 'utf8'));
      ok(bg > 0);
      ok(!alive(bg), `the process the task left in its group (pid ${bg}) outlived the answer`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a stop tears a task down at once and answers { error }; a stop before it starts runs nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'offloop-'));
    try {
      const repo = join(dir, 'repo');
      const remote = blockingRemote(repo);
      const ac = new AbortController();
      const answer = offLoop('fetchBaseline', { checkout: repo, baseline: 'main' }, { cwd: repo, env: remote.env, timeoutMs: 60_000, signal: ac.signal });
      ok(await appears(remote.pidFile));
      const stoppedAt = Date.now();
      ac.abort('the run was interrupted');
      match((await answer).error, /the fetchBaseline task was stopped: the run was interrupted/);
      ok(Date.now() - stoppedAt < 4000, `it took ${Date.now() - stoppedAt} ms`);
      ok(!alive(remote.pid()), 'the transport is gone when the task answers');
      match((await offLoop('fetchBaseline', { checkout: repo, baseline: 'main' }, { cwd: repo, signal: ac.signal })).error, /was not started: the run was interrupted/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a task that cannot be put on the locks answers { error } and runs nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'offloop-'));
    try {
      const repo = join(dir, 'repo');
      const remote = blockingRemote(repo);
      const r = await offLoop('fetchBaseline', { checkout: repo, baseline: 'main' }, {
        cwd: repo, env: remote.env, hold: async () => { throw new Error('the run no longer holds macro.lock'); },
      });
      match(r.error, /the fetchBaseline task could not be put on the run's locks \(the run no longer holds macro.lock\)/);
      await pause(500);
      ok(!existsSync(remote.pidFile), 'the task never ran');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a driver that dies with a task in flight leaves the task\'s group on its lock: no other run takes it while the group runs, and once the group is emptied (as stop does) it is free', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'offloop-'));
    const repo = join(dir, 'repo');
    const remote = blockingRemote(repo);
    const lockDir = join(dir, 'macro.lock');
    // A stand-in driver: it takes the lock and runs one task on it.
    const source = [
      'const [locks, offloop, lockDir, checkout] = process.argv.slice(1);',
      'const { acquireLock } = await import(locks);',
      'const { offLoop } = await import(offloop);',
      'const lock = await acquireLock(lockDir, { record: { run_id: "stand-in" } });',
      'await offLoop("fetchBaseline", { checkout, baseline: "main" }, { cwd: checkout, env: process.env, hold: async (g) => [lock.addWorkerGroup(g)] });',
    ].join('\n');
    const driver = spawn(process.execPath, ['--input-type=module', '-e', source, pathToFileURL(RUN_LOCKS).href, pathToFileURL(OFFLOOP).href, lockDir, repo], { env: remote.env, stdio: 'ignore' });
    const exited = new Promise((r) => { driver.once('exit', r); });
    let group = null;
    try {
      ok(await appears(remote.pidFile), 'the stand-in driver\'s task runs');
      group = readLockEntries(lockDir).map((e) => e.holder?.worker).find((w) => w?.task === 'fetchBaseline');
      ok(group, 'the task\'s group is on the lock');
      driver.kill('SIGKILL');
      await exited;
      ok(alive(remote.pid()), 'the task runs on after its driver died');
      await rejects(acquireLock(lockDir, { record: { run_id: 'next' } }), LockHeldError);
      ok(['terminated', 'killed'].includes(await terminateGroup(group.pgid)));
      ok(!alive(remote.pid()));
      const next = await acquireLock(lockDir, { record: { run_id: 'next' } });
      next.release();
    } finally {
      try { driver.kill('SIGKILL'); } catch { /* gone */ }
      if (group) await terminateGroup(group.pgid);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createTaskRunner: the run\'s interrupt', () => {
  it('stops a look, a fetch and the landing report in flight at once, gives a lane\'s creation or removal and a peer cancellation the bound, and the bound holds for a task started after it', { timeout: 20_000 }, async () => {
    // Each fake task waits until it is stopped, and says when.
    const fake = async (task, args, o) => {
      await o.hold({ pid: 40000 + task.length, pgid: 40000 + task.length, fingerprint: null, task });
      return new Promise((res) => {
        o.signal.addEventListener('abort', () => res({ error: String(o.signal.reason) }), { once: true });
      });
    };
    const runner = createTaskRunner({ offLoop: fake, boundMs: 1000 });
    const reads = ['observe', 'fetchBaseline', 'reportLanding'].map((t) => runner.run(t, {}));
    const changes = ['createLane', 'removeLane', 'cancelPeerRuns'].map((t) => runner.run(t, {}));
    await pause(20);
    strictEqual(runner.groups().length, 6, 'every task in flight lists its group');
    const at = Date.now();
    runner.interrupt();
    for (const r of await Promise.all(reads)) strictEqual(r.error, 'the run was interrupted');
    ok(Date.now() - at < 200, 'the tasks that only read are stopped at once');
    await pause(600);
    const later = runner.run('observe', {});
    for (const r of await Promise.all(changes)) match(r.error, /did not finish within 1 s of the interrupt/);
    ok(Date.now() - at >= 950, 'the tasks that change what the next run finds got the bound');
    match((await later).error, /did not finish within 1 s of the interrupt/);
    ok(Date.now() - at < 1450, 'a task started after the interrupt gets what is left of the bound, counted from the interrupt');
    deepStrictEqual(runner.groups(), []);
  });
});

describe('terminateGroupsSync (the driver\'s exit backstop)', () => {
  it('signals every group it is given, its descendants included: SIGTERM, then SIGKILL after the grace for one that ignores it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'offloop-'));
    // Each group: a leader and a child it started, whose pid it records.
    const group = (name, prelude) => spawn('sh', ['-c', `${prelude}sleep 30 & echo $! > '${join(dir, name)}'; wait`], { detached: true, stdio: 'ignore' });
    const polite = group('polite', '');
    const stubborn = group('stubborn', 'trap "" TERM; ');
    try {
      ok(await appears(join(dir, 'polite'), 3000) && await appears(join(dir, 'stubborn'), 3000));
      await pause(100);
      const children = ['polite', 'stubborn'].map((n) => Number(readFileSync(join(dir, n), 'utf8')));
      ok([polite.pid, stubborn.pid, ...children].every(alive));
      const at = Date.now();
      terminateGroupsSync([polite.pid, stubborn.pid, null], { graceMs: 600 });
      ok(Date.now() - at >= 550, 'it waited the grace for the group that ignored SIGTERM');
      // SIGKILL is not waited on: each is gone once the kernel has reaped it.
      for (const pid of [polite.pid, stubborn.pid, ...children]) ok(await gone(pid, 1000), `pid ${pid} outlived the backstop`);
    } finally {
      for (const c of [polite, stubborn]) { try { process.kill(-c.pid, 'SIGKILL'); } catch { /* gone */ } }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
