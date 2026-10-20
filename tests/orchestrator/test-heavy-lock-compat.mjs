// The heavy-work lock beside an older harness copy (ADR-0068 Decision 6,
// items 1 to 3): the harness of a739c10d, checked in under
// tests/fixtures/heavy-lock/, stands for every copy on a branch cut before
// this release. They exclude each other both ways; an older harness under a
// wrapper cannot join and waits, naming its holder. What the older copy does
// not do is measured and stated, not bounded: it judges a holder by its pid
// alone, and stops only its test run's group before it releases. A process
// that leaves its holder's group is outside the guarantee for every holder.

import { afterEach, describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { acquire } from '../../plugins/orchestrator/scripts/lib/heavy-lock.mjs';
import {
  BOUNDED, OLD_HARNESS, REPO_ROOT, barrierCommand, heavy, letGo, lockOf, makeRepo, ready, running, sleep,
  spawnNode, testEnv, tracker, until, write,
} from './_heavy-lock-fixtures.mjs';

const BASE = 'a739c10d1cd2022a4bb65a3ebbd3974c154f353b';

let t;
afterEach(() => t?.cleanUp());

// A repository with a spec whose one test waits for `<S>/run.go`, noting its
// pid in `<S>/run.pids` (and, with `detach`, a process that left its group).
function slowRepo(S, { detach = false } = {}) {
  const root = t.dir(makeRepo());
  t.lock(lockOf(root));
  write(root, 'src/value.mjs', 'export const VALUE = 1;\n');
  write(root, 'tests/test-value.mjs', [
    "import { test } from 'node:test';",
    "import { appendFileSync, existsSync } from 'node:fs';",
    "import { spawn } from 'node:child_process';",
    "import { VALUE } from '../src/value.mjs';",
    `appendFileSync(${JSON.stringify(join(S, 'run.pids'))}, process.pid + '\\n');`,
    detach ? `const d = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true }); d.unref(); appendFileSync(${JSON.stringify(join(S, 'detached.pids'))}, d.pid + '\\n');` : '',
    `await new Promise((go) => { const t = setInterval(() => { if (existsSync(${JSON.stringify(join(S, 'run.go'))})) { clearInterval(t); go(); } }, 10); });`,
    "test('value', () => { if (VALUE !== 1) throw new Error('VALUE'); });",
    '',
  ].join('\n'));
  write(root, 'spec.mjs', "export const TESTS = ['tests/test-value.mjs'];\nexport const MUTATIONS = [{ id: 'S', expect: 'SURVIVED', file: 'src/value.mjs', from: 'VALUE = 1;', to: 'VALUE = 1; ', why: 'nothing' }];\n");
  return root;
}

const pidsIn = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number) : []);
const oldCli = (root, opts = {}) => spawnNode([OLD_HARNESS, 'spec.mjs', '--repo-root', root], { cwd: root, ...opts, track: t });

describe('the older harness copy', () => {
  it('is the harness of a739c10d, byte for byte', (ctx) => {
    const have = spawnSync('git', ['-C', REPO_ROOT, 'cat-file', '-e', `${BASE}^{commit}`]);
    if (have.status !== 0) {
      ctx.skip('no git history here (a mutation copy, or a shallow clone): only the provenance is skipped');
      return;
    }
    for (const [fixture, path] of [['mutation-harness.mjs', 'scripts/mutation-harness.mjs'], ['lib/session-env.mjs', 'scripts/lib/session-env.mjs']]) {
      const want = spawnSync('git', ['-C', REPO_ROOT, 'show', `${BASE}:${path}`]).stdout;
      ok(readFileSync(join(OLD_HARNESS, '..', fixture)).equals(want), `${fixture} matches ${path} at ${BASE}`);
    }
  });
});

describe('exclusion, both ways', () => {
  it('an older harness waits for a wrapper, naming its purpose; a wrapper waits for an older harness', BOUNDED, async () => {
    t = tracker();
    const S = t.scratch();
    const root = slowRepo(S);
    const holder = heavy(['--purpose', 'the wrapped suite', '--', ...barrierCommand(S, 'w', join(S, 'log'))], { cwd: root, track: t });
    ok(await until(() => ready(S, 'w')), holder.output());
    writeFileSync(join(S, 'run.go'), '');
    const older = oldCli(root);
    ok(await until(() => older.output().includes(`mutation-harness: waiting for the run of the wrapped suite in ${root}`)), older.output());
    await sleep(300);
    strictEqual(pidsIn(join(S, 'run.pids')).length, 0, 'the older harness ran nothing while the wrapper held');
    letGo(S, 'w');
    strictEqual((await holder.exited).code, 0);
    const done = await older.exited;
    strictEqual(done.code, 0, done.out);

    // The other way: the older harness holds while its run waits.
    const S2 = t.scratch();
    const root2 = slowRepo(S2);
    const holding = oldCli(root2);
    ok(await until(() => pidsIn(join(S2, 'run.pids')).length === 1, 30_000), holding.output());
    const ran = join(S2, 'ran');
    const waiter = heavy(['--', process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(ran)}, '')`], { cwd: root2, track: t });
    ok(await until(() => waiter.output().includes(`heavy: waiting for the run of spec.mjs in ${root2}`)), waiter.output());
    await sleep(300);
    ok(!existsSync(ran), 'the wrapper ran nothing while the older harness held');
    writeFileSync(join(S2, 'run.go'), '');
    strictEqual((await holding.exited).code, 0);
    strictEqual((await waiter.exited).code, 0);
    ok(existsSync(ran));
  });

  it('an older harness started through a script under the wrapper cannot join: it waits, naming the wrapper', BOUNDED, async () => {
    t = tracker();
    const S = t.scratch();
    const root = slowRepo(S);
    write(root, 'run-old.sh', `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(OLD_HARNESS)} spec.mjs --repo-root ${JSON.stringify(root)}\n`);
    const w = heavy(['--purpose', 'a nested suite', '--', 'sh', 'run-old.sh'], { cwd: root, track: t });
    ok(await until(() => w.output().includes(`mutation-harness: waiting for the run of a nested suite in ${root}`)), w.output());
    w.child.kill('SIGTERM');
    strictEqual((await w.exited).code, 143);
    ok(!existsSync(lockOf(root)));
  });
});

describe('a holder killed with SIGKILL', () => {
  it('a wrapper holder: no acquirer of this release takes the lock before its group ends; an older one does (measured)', BOUNDED, async (ctx) => {
    t = tracker();
    const S = t.scratch();
    const root = slowRepo(S);
    // In the wrapper's supervisor alone, its group cannot be killed: when the
    // wrapper dies, the supervisor kills the command and ends, and the
    // command's child stays in the group.
    const preload = write(S, 'preload.cjs', [
      "if (process.execArgv[0] === '-e' && String(process.execArgv[1]).includes('JSON.parse(process.argv[1])')) {",
      '  const kill = process.kill.bind(process);',
      "  process.kill = (pid, signal) => { if (pid === 0) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); return kill(pid, signal); };",
      '}',
      '',
    ].join('\n'));
    const command = [process.execPath, '-e', [
      "const { spawn } = require('node:child_process');",
      `const c = spawn(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(join(S, 'child'))}, String(process.pid)); setInterval(() => {}, 1000)`)}], { stdio: 'ignore' });`,
      'setInterval(() => {}, 1000);',
    ].join('\n')];
    const w = heavy(['--purpose', 'killed', '--', ...command], { cwd: root, track: t, env: testEnv({ NODE_OPTIONS: `--require ${JSON.stringify(preload)}` }) });
    ok(await until(() => existsSync(join(S, 'child'))), w.output());
    const child = t.pid(Number(readFileSync(join(S, 'child'), 'utf8')));
    const killedAt = Date.now();
    w.child.kill('SIGKILL');
    await w.exited;
    ok(running(child), 'the command\'s child outlived the wrapper');
    let taken = null;
    const waiting = acquire(root, { log: () => {}, pollMs: 20 }).then((l) => { taken = Date.now(); return l; });
    await sleep(500);
    strictEqual(taken, null, 'no acquirer of this release takes the lock while the group lives');
    process.kill(child, 'SIGKILL');
    const groupEndedAt = Date.now();
    (await waiting).release();
    ctx.diagnostic(`this release: lock taken ${taken - groupEndedAt} ms after the group ended (the wrapper died ${groupEndedAt - killedAt} ms before)`);

    // The older harness judges the record alone: it takes the lock once the
    // wrapper is dead, though the group lives. Measured, not bounded.
    const w2 = heavy(['--purpose', 'killed again', '--', ...command], { cwd: root, track: t, env: testEnv({ NODE_OPTIONS: `--require ${JSON.stringify(preload)}` }) });
    rmSync(join(S, 'child'), { force: true });
    ok(await until(() => existsSync(join(S, 'child'))), w2.output());
    const child2 = t.pid(Number(readFileSync(join(S, 'child'), 'utf8')));
    const killed2 = Date.now();
    w2.child.kill('SIGKILL');
    await w2.exited;
    const older = spawnNode(['--input-type=module', '-e',
      `import { acquireRunLock } from ${JSON.stringify(pathToFileURL(OLD_HARNESS).href)};\n`
      + `const l = await acquireRunLock(${JSON.stringify(root)}, { pollMs: 20 }); console.log('TAKEN', Date.now()); l.release();\n`], { track: t });
    const done = await older.exited;
    const takenAt = Number(/TAKEN (\d+)/.exec(done.out)?.[1]);
    ok(Number.isFinite(takenAt), done.out);
    ok(running(child2), 'the group still ran when the older harness took the lock');
    ctx.diagnostic(`older harness: took the lock ${takenAt - killed2} ms after the wrapper's death, with the wrapper's group still running (ADR-0068 Decision 6, item 2: narrower with older copies)`);
    process.kill(child2, 'SIGKILL');
  });

  it('an older holder: a waiter of this release takes the lock once the holder is dead (window measured)', BOUNDED, async (ctx) => {
    t = tracker();
    const S = t.scratch();
    const root = slowRepo(S);
    const holding = oldCli(root);
    ok(await until(() => pidsIn(join(S, 'run.pids')).length === 1, 30_000), holding.output());
    const run = t.pidFile(join(S, 'run.pids'))[0];
    const killedAt = Date.now();
    holding.child.kill('SIGKILL');
    await holding.exited;
    let takenAt = null;
    const lock = await acquire(root, { log: () => {}, pollMs: 20 }).then((l) => { takenAt = Date.now(); return l; });
    const runGone = await until(() => !running(run), 5000);
    const runEndedAt = Date.now();
    ok(runGone, 'the older supervisor stopped the test run');
    ctx.diagnostic(`older holder: lock taken ${takenAt - killedAt} ms after its death; its test run was seen gone ${runEndedAt - killedAt} ms after (its supervisor's delay; this reader cannot see an older holder's groups)`);
    lock.release();
  });
});

describe('a process that left its holder\'s group', () => {
  it('survives an orderly end of the wrapper and of an older harness: outside the guarantee (measured)', BOUNDED, async (ctx) => {
    t = tracker();
    const S = t.scratch();
    const root = slowRepo(S, { detach: true });
    const spawnDetached = [process.execPath, '-e', [
      "const { spawn } = require('node:child_process');",
      "const d = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });",
      `require('node:fs').writeFileSync(${JSON.stringify(join(S, 'wrapper-detached'))}, String(d.pid));`,
      'd.unref();',
    ].join('\n')];
    const w = await heavy(['--', ...spawnDetached], { cwd: root, track: t }).exited;
    strictEqual(w.code, 0, w.out);
    const fromWrapper = t.pid(Number(readFileSync(join(S, 'wrapper-detached'), 'utf8')));
    ok(!existsSync(lockOf(root)), 'the wrapper released');
    await sleep(500);
    ok(running(fromWrapper), 'the detached descendant of a wrapper survived its release');

    writeFileSync(join(S, 'run.go'), '');
    const older = await oldCli(root).exited;
    strictEqual(older.code, 0, older.out);
    const fromOlder = t.pidFile(join(S, 'detached.pids'));
    ok(fromOlder.length >= 1);
    await sleep(500);
    ok(fromOlder.every(running), 'the detached descendant of an older harness\'s test run survived its end');
    ctx.diagnostic('a process that left its holder\'s group outlived the release of both, 500 ms on (ADR-0068 Decision 6, items 2 and 8)');
  });
});
