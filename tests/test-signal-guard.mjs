// tests/test-signal-guard.mjs
//
// `npm test` refuses a test's signal to its own process group (docket C169,
// tests/_signal-guard.mjs), proved where it mattered: a verification check's
// topology, the heavy-work wrapper's supervisor leading the group that runs
// `npm test`, its runner and the test file. The probe
// (tests/fixtures/signal-guard-probe.mjs) reads 0 from an empty pid file and
// signals it, -0 and its own group, with a descendant of the group running.
//
// The control runs the probe through the script as it was before the guard:
// its first SIGKILL ends the whole group, the supervisor with it, and the
// wrapper refuses with no report and no stop of the supervisor's own (the
// signature of the three batches). Through `npm test` the same signals are
// refused: the supervisor reports, an unrelated process and the descendant
// live on, and the group stays registered under the lock while it runs.
//
// pid -1 is proved on the guard's decision alone: a signal to it, were the
// guard broken, would reach every process of the user.

import { afterEach, describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { readPid } from './_pidfile.mjs';
import { SelfSignalError, signalsOwnGroup } from './_signal-guard.mjs';
import {
  REPO_ROOT, heavy, lines, lockOf, makeRepo, registeredGroups, running, testEnv, tracker, until,
} from './orchestrator/_heavy-lock-fixtures.mjs';

const PROBE = 'tests/fixtures/signal-guard-probe.mjs';
const BOUNDED = { timeout: 120_000 };

let t;
afterEach(() => t?.cleanUp());

describe('the guard\'s decision', () => {
  it('refuses any signal but 0 to pid 0, -0, -1 and the caller\'s own group; lets every other target through', () => {
    for (const pid of [0, -0, '0', -1, '-1']) {
      strictEqual(signalsOwnGroup(pid, 'SIGKILL', 4242), true, `pid ${pid}`);
      strictEqual(signalsOwnGroup(pid, 15, null), true, `pid ${pid}, a signal by number`);
      strictEqual(signalsOwnGroup(pid, 0, 4242), false, `pid ${pid}, the existence probe`);
    }
    strictEqual(signalsOwnGroup(-4242, 'SIGTERM', 4242), true, 'the own group by number');
    strictEqual(signalsOwnGroup(-4243, 'SIGTERM', 4242), false, 'another group');
    strictEqual(signalsOwnGroup(-4242, 'SIGTERM', null), false, 'an own group that could not be read refuses nothing more');
    strictEqual(signalsOwnGroup(4242, 'SIGKILL', 4242), false, 'a process');
  });

  it('throws before the system sees the signal, naming the guard', BOUNDED, async () => {
    strictEqual(new SelfSignalError(0, 'SIGKILL').code, 'ESELFSIGNAL');
    // In a detached child that loads the guard: should it be broken, its
    // SIGCONT reaches that child's own group alone, never this runner's.
    const probe = [
      "try { process.kill(0, 0); } catch (e) { console.log('probe', e.code); process.exit(1); }",
      "try { process.kill(0, 'SIGCONT'); console.log('sent'); } catch (e) { console.log(e.code, /tests\\/_signal-guard\\.mjs/.test(e.message)); }",
    ].join('\n');
    const child = spawn(process.execPath, ['--import', pathToFileURL(join(REPO_ROOT, 'tests', '_signal-guard.mjs')).href, '-e', probe], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    const code = await new Promise((done) => child.on('close', done));
    strictEqual(code, 0, out);
    strictEqual(out.trim(), 'ESELFSIGNAL true', 'the existence probe went through; SIGCONT to pid 0 was refused, naming the guard');
  });
});

describe('the heavy-lock tests\' survivor tracker', () => {
  it('records no pid or group it may not signal: 0, 1, a negative number, NaN, a pid file\'s empty or torn line', () => {
    const tr = tracker();
    const dir = tr.scratch();
    const file = join(dir, 'pids');
    writeFileSync(file, '\n0\n1\n-5\n12x\n');
    for (const n of [0, -0, 1, -1, Number(''), NaN, 2.5]) { tr.pid(n); tr.group(n); }
    deepStrictEqual(tr.pidFile(file), []);
    const seen = [];
    const kill = process.kill;
    process.kill = (pid, signal) => { seen.push(pid); return true; };
    try { tr.cleanUp(); } finally { process.kill = kill; }
    deepStrictEqual(seen, [], 'cleanUp signalled nothing');
  });
});

describe('a check\'s group under the wrapper (C169)', () => {
  // The probe as a verification check runs it: the wrapper's supervisor leads
  // its group, which runs the script, its runner and the probe.
  const run = (script) => {
    const S = t.scratch();
    const root = t.dir(makeRepo());
    t.lock(lockOf(root));
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
    t.group(unrelated.pid);
    const statusFile = join(S, 'status');
    const env = testEnv({ SIGNAL_GUARD_PROBE_DIR: S });
    const w = heavy(['--repo', root, '--status-file', statusFile, '--', ...script], { cwd: REPO_ROOT, env, track: t, deadlineMs: 100_000 });
    const states = () => lines(statusFile).map((l) => JSON.parse(l));
    return { S, root, w, states, unrelated: unrelated.pid };
  };

  it('control: through the script as it was, the probe\'s first signal ends the group, and the supervisor with it, unreported', BOUNDED, async () => {
    t = tracker();
    const { S, w, states, unrelated } = run([process.execPath, '--test', '--import', './tests/_hermetic-env.mjs', PROBE]);
    const done = await w.exited;
    strictEqual(done.code, 125, done.out);
    const ended = states().at(-1);
    deepStrictEqual(ended, {
      state: 'ended', refused: 'the command\'s supervisor ended without reporting how the command ended',
      supervisor: { code: null, signal: 'SIGKILL', stop: null, report_bytes: 0 },
    });
    strictEqual(existsSync(join(S, 'results.json')), false, 'the probe never got past its first signal');
    ok(running(unrelated), 'a process outside the group is not reached');
  });

  it('through npm test, each signal is refused: the supervisor reports, and an unrelated process and the group\'s descendant live on, the group registered under the lock', BOUNDED, async () => {
    t = tracker();
    const { S, root, w, states, unrelated } = run(['npm', 'test', '--', PROBE]);
    let over = false;
    w.exited.then(() => { over = true; });
    ok(await until(() => existsSync(join(S, 'results.json')) || over, 90_000) && !over, w.output());
    const { pid, pgid, results } = JSON.parse(readFileSync(join(S, 'results.json'), 'utf8'));
    strictEqual(pid, 0, 'the probe read 0 from the empty pid file');
    deepStrictEqual(results, ['ESELFSIGNAL', 'ESELFSIGNAL', 'ESELFSIGNAL']);
    const descendant = t.pid(readPid(join(S, 'descendant')));
    ok(descendant !== null && running(descendant), 'the group\'s descendant runs');
    const runningLine = states().find((x) => x.state === 'running');
    strictEqual(runningLine?.pgid, pgid, 'the probe ran in the group the wrapper started');
    ok(registeredGroups(lockOf(root)).includes(pgid), 'its group is still registered under the lock while it runs');
    ok(states().every((x) => x.state !== 'ended'), 'the wrapper has not ended');
    writeFileSync(join(S, 'go'), '');
    const done = await w.exited;
    strictEqual(done.code, 0, done.out);
    const ended = states().at(-1);
    strictEqual(ended.code, 0, JSON.stringify(ended));
    strictEqual(ended.supervisor.stop, 'command-exit', 'the supervisor reported, then stopped itself');
    ok(running(unrelated), 'a process outside the group is not reached');
  });
});
