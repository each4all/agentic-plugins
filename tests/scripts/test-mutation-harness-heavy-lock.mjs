// The mutation harness as a holder of the shared heavy-work lock (ADR-0068
// Decision 6): each test run's process group is registered in the lock's
// ownership before the run starts (the go line), a run settles only once its
// group is gone, a harness under a wrapper joins the wrapper's lock instead of
// waiting on it, and neither a test run nor a worker inherits the lock's proof.
// The harness's other behaviour is tests/scripts/test-mutation-harness.mjs's.

import { afterEach, describe, it } from 'node:test';
import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { MutationHarnessError, acquireRunLock, childEnv, runTests } from '../../scripts/mutation-harness.mjs';
import { closeOwnership, mintProof, ownershipGroups } from '../../plugins/orchestrator/scripts/lib/heavy-lock.mjs';
import { workerEnv } from '../../plugins/orchestrator/adapters/claude/autopilot/worker.mjs';
import {
  BOUNDED, HARNESS, REPO_ROOT, barrierCommand, gone, heavy, letGo, lockOf, makeRepo, ready, running, sleep, spawnNode,
  testEnv, tracker, until, write,
} from '../orchestrator/_heavy-lock-fixtures.mjs';

let t;
afterEach(() => t?.cleanUp());

const LOCK_MODULE = join(REPO_ROOT, 'plugins', 'orchestrator', 'scripts', 'lib', 'heavy-lock.mjs');
const PROOF = 'AGENTIC_HEAVY_LOCK_PROOF';
const VIA = 'AGENTIC_HEAVY_LOCK_VIA';

// A repository whose one test notes each run in `marker` and passes; with
// `leftover`, it also leaves a process in its group and notes its pid.
function scoringRepo({ marker, leftover = null, hang = false } = {}) {
  const root = t.dir(makeRepo());
  t.lock(lockOf(root));
  write(root, 'src/value.mjs', 'export const VALUE = 1;\n// a comment nobody asserts on\n');
  write(root, 'tests/test-value.mjs', [
    "import { test } from 'node:test';",
    "import { appendFileSync } from 'node:fs';",
    "import { spawn } from 'node:child_process';",
    "import { VALUE } from '../src/value.mjs';",
    `appendFileSync(${JSON.stringify(marker)}, process.pid + '\\n');`,
    leftover ? `const s = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); s.unref(); appendFileSync(${JSON.stringify(leftover)}, s.pid + '\\n');` : '',
    hang ? 'await new Promise(() => setInterval(() => {}, 1000));' : '',
    "test('value', () => { if (VALUE !== 1) throw new Error('VALUE'); });",
    '',
  ].join('\n'));
  write(root, 'spec.mjs', [
    "export const TESTS = ['tests/test-value.mjs'];",
    "export const MUTATIONS = [{ id: 'K', file: 'src/value.mjs', from: 'VALUE = 1', to: 'VALUE = 2', why: 'breaks it' }];",
    '',
  ].join('\n'));
  write(root, 'package.json', `${JSON.stringify({ name: 'fixture', private: true, scripts: { mutate: `node ${JSON.stringify(HARNESS)}` } })}\n`);
  return root;
}

const pids = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number) : []);

describe('the go line', () => {
  it('a harness killed between a run\'s spawn and its registration runs no test', BOUNDED, async () => {
    t = tracker();
    const S = t.scratch();
    const marker = join(S, 'marker');
    const root = scoringRepo({ marker });
    const supFile = join(S, 'sup');
    const harness = spawnNode(['--input-type=module', '-e', [
      "import { writeFileSync } from 'node:fs';",
      `import { acquireRunLock, runTests } from ${JSON.stringify(pathToFileURL(HARNESS).href)};`,
      `import { ownershipGroups } from ${JSON.stringify(pathToFileURL(LOCK_MODULE).href)};`,
      `const lock = await acquireRunLock(${JSON.stringify(root)}, { log: () => {} });`,
      `await runTests(${JSON.stringify(root)}, ['tests/test-value.mjs'], { ownership: lock.ownership, beforeGo: (child) => {`,
      '  const registered = ownershipGroups(lock.path, lock.ownership.token).map((g) => g.pgid);',
      `  writeFileSync(${JSON.stringify(supFile)}, JSON.stringify({ pid: child.pid, registered }));`,
      '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);',
      '} });',
    ].join('\n')], { track: t });
    ok(await until(() => existsSync(supFile)), harness.output());
    const at = JSON.parse(readFileSync(supFile, 'utf8'));
    const sup = t.group(at.pid);
    deepStrictEqual(at.registered, [at.pid], 'the run\'s group was registered before the go line');
    // Long enough for a run started without the go line to note itself.
    await sleep(2000);
    deepStrictEqual(pids(marker), [], 'nothing ran before the go line');
    harness.child.kill('SIGKILL');
    await harness.exited;
    ok(await gone(sup), 'the idle supervisor ends with its lifeline');
    await sleep(300);
    deepStrictEqual(pids(marker), [], 'nothing ran at all');
  });

  it('a registration refused because the ownership closed starts nothing', BOUNDED, async () => {
    t = tracker();
    const S = t.scratch();
    const marker = join(S, 'marker');
    const root = scoringRepo({ marker });
    const lock = await acquireRunLock(root, { log: () => {} });
    try {
      closeOwnership(lock.path, lock.ownership.token);
      await rejects(runTests(root, ['tests/test-value.mjs'], { ownership: lock.ownership }),
        (err) => err instanceof MutationHarnessError && /ownership .* is closed/.test(err.message));
      await sleep(300);
      deepStrictEqual(pids(marker), [], 'the run never started');
    } finally {
      lock.release();
    }
    // Control: with the ownership open, the same run runs and is registered.
    const fresh = await acquireRunLock(root, { log: () => {} });
    let seen = [];
    const out = await runTests(root, ['tests/test-value.mjs'], {
      ownership: fresh.ownership,
      beforeGo: () => { seen = ownershipGroups(fresh.path, fresh.ownership.token).map((g) => g.pgid); },
    });
    strictEqual(out.status, 0);
    strictEqual(seen.length, 1, 'the run\'s group was registered before it started');
    deepStrictEqual(ownershipGroups(fresh.path, fresh.ownership.token), [], 'and unregistered once it ended');
    deepStrictEqual(pids(marker).length, 1);
    fresh.release();
  });
});

describe('a run settles only once its group is gone', () => {
  // In this process, SIGKILL to a group is refused (EPERM) until `allowed()`.
  function holdKills(allowed) {
    const kill = process.kill;
    process.kill = (pid, signal) => {
      if (pid < 0 && signal === 'SIGKILL' && !allowed()) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      return kill.call(process, pid, signal);
    };
    return () => { process.kill = kill; };
  }

  it('waits for what the run left in its group before it settles', BOUNDED, async () => {
    t = tracker();
    const S = t.scratch();
    const marker = join(S, 'marker');
    const leftover = join(S, 'left');
    const root = scoringRepo({ marker, leftover });
    const lock = await acquireRunLock(root, { log: () => {} });
    const since = Date.now();
    const restore = holdKills(() => Date.now() - since > 1500);
    try {
      const out = await runTests(root, ['tests/test-value.mjs'], { ownership: lock.ownership });
      strictEqual(out.status, 0);
      const left = t.pidFile(leftover);
      strictEqual(left.length, 1);
      ok(!running(left[0]), `pid ${left[0]}, left in the run's group, was gone when the run settled`);
      deepStrictEqual(ownershipGroups(lock.path, lock.ownership.token), []);
    } finally {
      restore();
      lock.release();
    }
  });

  it('a group that will not end fails the run as no verdict and stays in the ownership', BOUNDED, async () => {
    t = tracker();
    const S = t.scratch();
    const marker = join(S, 'marker');
    const leftover = join(S, 'left');
    const root = scoringRepo({ marker, leftover });
    const said = [];
    const lock = await acquireRunLock(root, { log: (l) => said.push(l) });
    let allow = false;
    const restore = holdKills(() => allow);
    try {
      await rejects(runTests(root, ['tests/test-value.mjs'], { ownership: lock.ownership }),
        (err) => err instanceof MutationHarnessError && /still runs 5 s after its runner ended; it stays in the lock's ownership/.test(err.message));
      strictEqual(ownershipGroups(lock.path, lock.ownership.token).length, 1, 'the group is kept in the ownership');
      lock.release();
      ok(said.some((l) => /process group \d+ of this lock's ownership still runs; the lock is kept/.test(l)), said.join('\n'));
      ok(existsSync(lock.path), 'the lock outlives the release of its holder');
    } finally {
      allow = true;
      restore();
      for (const pid of t.pidFile(leftover)) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
    ok(await until(() => ownershipGroups(lock.path, lock.ownership.token).length === 0));
    lock.release();
    ok(!existsSync(lock.path));
  });

  it('the CLI keeps the copies while a group that would not end still runs there', BOUNDED, async () => {
    t = tracker();
    const S = t.scratch();
    const marker = join(S, 'marker');
    const leftover = join(S, 'left');
    const root = scoringRepo({ marker, leftover });
    // In the harness CLI alone, SIGKILL to a group is refused.
    const preload = join(S, 'preload.cjs');
    writeFileSync(preload, [
      `if (process.argv[1] === ${JSON.stringify(HARNESS)}) {`,
      '  const kill = process.kill.bind(process);',
      "  process.kill = (pid, signal) => { if (pid < 0 && signal === 'SIGKILL') throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); return kill(pid, signal); };",
      '}',
      '',
    ].join('\n'));
    const cli = await spawnNode([HARNESS, 'spec.mjs', '--repo-root', root], {
      cwd: root, env: testEnv({ NODE_OPTIONS: `--require ${JSON.stringify(preload)}` }), track: t,
    }).exited;
    for (const pid of t.pidFile(leftover)) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    strictEqual(cli.code, 1, cli.out);
    const kept = /copies kept under (\S+): process group \d+ of a test run still runs there/.exec(cli.out)?.[1];
    ok(kept, cli.out);
    t.dir(kept);
    ok(existsSync(join(kept, 'control', 'tests', 'test-value.mjs')), 'the copy the group ran in is still there');
  });
});

describe('a harness under a wrapper', () => {
  it('npm run mutate, through a script, joins the wrapper\'s lock without waiting; a wrong proof waits, naming the holder', BOUNDED, async () => {
    t = tracker();
    const S = t.scratch();
    const marker = join(S, 'marker');
    const root = scoringRepo({ marker });
    write(root, 'run.sh', `npm run mutate -- spec.mjs --repo-root ${JSON.stringify(root)}\n`);
    const joined = await heavy(['--purpose', 'the whole suite', '--', 'sh', 'run.sh'], { cwd: root, track: t }).exited;
    strictEqual(joined.code, 0, joined.out);
    ok(/mutation-harness: inside the heavy-work lock of the whole suite \(pid \d+\); not waiting/.test(joined.out), joined.out);
    ok(!joined.out.includes('waiting for the run of'), joined.out);
    strictEqual(pids(marker).length, 2, 'the control and the mutation ran');
    ok(!existsSync(lockOf(root)), 'the wrapper released the lock');

    const dir = join(S, 'barrier');
    const log = join(S, 'log');
    mkdirSync(dir);
    const holder = heavy(['--purpose', 'the held suite', '--', ...barrierCommand(dir, 'held', log)], { cwd: root, track: t });
    ok(await until(() => ready(dir, 'held')), holder.output());
    const waiter = spawnNode([HARNESS, 'spec.mjs', '--repo-root', root], { cwd: root, env: testEnv({ [PROOF]: mintProof() }), track: t });
    ok(await until(() => waiter.output().includes(`waiting for the run of the held suite in ${root}`)), waiter.output());
    await sleep(200);
    strictEqual(waiter.child.exitCode, null, 'a wrong proof waits');
    letGo(dir, 'held');
    strictEqual((await holder.exited).code, 0);
    const done = await waiter.exited;
    strictEqual(done.code, 0, done.out);
    ok(done.out.includes('the run lock is ours after'), done.out);
  });

  it('SIGKILL to a harness holder: no acquirer takes the lock while a group of its test runs lives', BOUNDED, async () => {
    t = tracker();
    const S = t.scratch();
    const marker = join(S, 'marker');
    const leftover = join(S, 'left');
    const root = scoringRepo({ marker, leftover, hang: true });
    // In the test run's supervisor alone, the group cannot be killed: when the
    // harness dies, the supervisor ends and what it started stays in its group.
    const preload = join(S, 'preload.cjs');
    writeFileSync(preload, [
      "if (process.execArgv[0] === '-e' && String(process.execArgv[1]).includes('mutation-harness-run')) {",
      '  const kill = process.kill.bind(process);',
      "  process.kill = (pid, signal) => { if (pid === 0) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); return kill(pid, signal); };",
      '}',
      '',
    ].join('\n'));
    const cli = spawnNode([HARNESS, 'spec.mjs', '--repo-root', root, '--timeout', '600'], {
      cwd: root, env: testEnv({ NODE_OPTIONS: `--require ${JSON.stringify(preload)}` }), track: t,
    });
    ok(await until(() => pids(leftover).length === 1, 30_000), cli.output());
    const left = t.pidFile(leftover)[0];
    cli.child.kill('SIGKILL');
    await cli.exited;
    ok(running(left), 'the run\'s leftover outlived the harness and its supervisor');
    const said = [];
    let taken = null;
    const waiting = acquireRunLock(root, { log: (l) => said.push(l), pollMs: 20 }).then((l) => { taken = l; return l; });
    ok(await until(() => said.some((l) => l.includes(`(pid ${cli.child.pid} exited; its group`))), said.join('\n'));
    await sleep(300);
    strictEqual(taken, null, 'the lock is not taken while the group lives');
    process.kill(left, 'SIGKILL');
    for (const pid of pids(marker)) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    const lock = await waiting;
    ok(said.some((l) => l.includes(`removed a stale run lock (pid ${cli.child.pid}, `)), said.join('\n'));
    lock.release();
  });
});

describe('the proof is not inherited by what a holder does not mean to share', () => {
  it('a test run, a test process and an autopilot worker are each started without the proof and the chain', BOUNDED, () => {
    const base = { [PROOF]: 'p'.repeat(64), [VIA]: 'v', KEEP_ME: 'yes' };
    const forRun = childEnv(base);
    strictEqual(forRun.AGENTIC_HEAVY_LOCK_PROOF, undefined);
    strictEqual(forRun.AGENTIC_HEAVY_LOCK_VIA, undefined);
    strictEqual(forRun.KEEP_ME, 'yes');
    const forWorker = workerEnv(base, { runId: 'autopilot-20261020T000000Z-abcdef', roots: { orchestrator: '/o', engineer: '/e', runtime: '/r' } });
    strictEqual(forWorker.AGENTIC_HEAVY_LOCK_PROOF, undefined);
    strictEqual(forWorker.AGENTIC_HEAVY_LOCK_VIA, undefined);
    strictEqual(forWorker.KEEP_ME, 'yes');
    const probe = spawnSync(process.execPath, [
      '--import', pathToFileURL(join(REPO_ROOT, 'tests', '_hermetic-env.mjs')).href, '-e',
      'process.stdout.write(JSON.stringify([process.env.AGENTIC_HEAVY_LOCK_PROOF ?? null, process.env.AGENTIC_HEAVY_LOCK_VIA ?? null, process.env.KEEP_ME]))',
    ], { env: { ...process.env, ...base }, encoding: 'utf8' });
    deepStrictEqual(JSON.parse(probe.stdout), [null, null, 'yes'], probe.stderr);
  });
});
