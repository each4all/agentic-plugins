// `agentic-autopilot heavy -- <command>` (ADR-0068 Decision 6, item 4;
// plugins/orchestrator/scripts/lib/heavy-run.mjs): two wrappers take turns,
// nesting joins instead of deadlocking, the exit status and the signals, the
// supervisor's go line and report, the waiting report, a joined wrapper's
// cancellation and a holder's refused release, the launcher, the driver that
// refuses to start inside a holder (item 3), and the command a declaration
// marks as taking the lock itself (item 3).

import { afterEach, describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { join } from 'node:path';

import {
  BOUNDED, CLI, HARNESS, LAUNCHER, REPO_ROOT, addLane, barrierCommand, git, heavy, letGo, lines, lockOf,
  makeRepo, ready, registeredGroups, running, sleep, spawnNode, testEnv, tracker, until, write,
} from './_heavy-lock-fixtures.mjs';
import { acquire, closeOwnership } from '../../plugins/orchestrator/scripts/lib/heavy-lock.mjs';
import { runHeavy } from '../../plugins/orchestrator/scripts/lib/heavy-run.mjs';

let t;
afterEach(() => t?.cleanUp());

function setUp(files) {
  t = tracker();
  const S = t.scratch();
  const root = t.dir(makeRepo(files));
  const path = t.lock(lockOf(root));
  return { S, root, path };
}

// A command that starts a child in its group, then waits; each notes its pid
// once it is ready (with `ignoreTerm`, once it ignores SIGTERM; with `trap`,
// once it notes in that file each signal it gets, and exits on it).
const groupCommand = (pidFile, { ignoreTerm = false, trap = null } = {}) => {
  const traps = trap === null ? '' : `for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => { require('node:fs').appendFileSync(${JSON.stringify(trap)}, process.pid + ' ' + s + '\\n'); process.exit(0); }); `;
  const note = `${ignoreTerm ? "process.on('SIGTERM', () => {}); " : ''}${traps}require('node:fs').appendFileSync(${JSON.stringify(pidFile)}, process.pid + '\\n'); setInterval(() => {}, 1000);`;
  return [process.execPath, '-e', [
    "const { spawn } = require('node:child_process');",
    `spawn(process.execPath, ['-e', ${JSON.stringify(note)}], { stdio: 'ignore' });`,
    note,
  ].join('\n')];
};

const pidsIn = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number) : []);

// A harness fixture: a spec with one killed mutation over one test.
const HARNESS_FILES = {
  'src/value.mjs': 'export const VALUE = 1;\n',
  'tests/test-value.mjs': "import { test } from 'node:test';\nimport { VALUE } from '../src/value.mjs';\ntest('value', () => { if (VALUE !== 1) throw new Error('VALUE'); });\n",
  'spec.mjs': "export const TESTS = ['tests/test-value.mjs'];\nexport const MUTATIONS = [{ id: 'K', file: 'src/value.mjs', from: 'VALUE = 1', to: 'VALUE = 2', why: 'breaks it' }];\n",
  'package.json': `${JSON.stringify({ name: 'fixture', private: true, scripts: { mutate: `node ${JSON.stringify(HARNESS)}` } })}\n`,
};

describe('taking turns', () => {
  it('two wrappers in two worktrees take turns: the second\'s command never starts while the first\'s runs', BOUNDED, async () => {
    const { S, root } = setUp();
    const lane = t.dir(addLane(root));
    const log = join(S, 'log');
    const first = heavy(['--purpose', 'first', '--', ...barrierCommand(S, 'a', log)], { cwd: root, track: t });
    ok(await until(() => ready(S, 'a')), first.output());
    const second = heavy(['--purpose', 'second', '--', ...barrierCommand(S, 'b', log)], { cwd: lane, track: t });
    ok(await until(() => second.output().includes(`heavy: waiting for the run of first in ${root} (pid ${first.child.pid} on `)), second.output());
    await sleep(300);
    ok(!ready(S, 'b'), 'the second command has not started');
    letGo(S, 'a');
    strictEqual((await first.exited).code, 0);
    ok(await until(() => ready(S, 'b')), second.output());
    letGo(S, 'b');
    const done = await second.exited;
    strictEqual(done.code, 0, done.out);
    ok(/heavy: the run lock is ours after \d+ s/.test(done.out), done.out);
    deepStrictEqual(lines(log), ['a start', 'a end', 'b start', 'b end']);
  });

  it('repeats its waiting line at its cadence, and escapes the holder\'s purpose', BOUNDED, async () => {
    const { S, root } = setUp();
    const holder = heavy(['--purpose', 'evil\nheavy: forged\u001b[2J', '--', ...barrierCommand(S, 'a', join(S, 'log'))], { cwd: root, track: t });
    ok(await until(() => ready(S, 'a')), holder.output());
    const waiter = heavy(['--', 'true'], { cwd: root, track: t, env: testEnv({ AGENTIC_HEAVY_LOCK_REPORT_MS: '200' }) });
    ok(await until(() => (waiter.output().match(/waiting for the run of/g) ?? []).length >= 3, 5000), waiter.output());
    ok(waiter.output().includes('waiting for the run of evil<U+000A>heavy: forged<U+001B>[2J in '), waiter.output());
    ok(/; waited \d+ s so far\n/.test(waiter.output()), 'a repeated line says how long the wait has lasted');
    ok(!waiter.output().split('\n').some((l) => l.startsWith('heavy: forged')), 'no forged line');
    letGo(S, 'a');
    strictEqual((await holder.exited).code, 0);
    strictEqual((await waiter.exited).code, 0);
  });
});

describe('nesting', () => {
  it('a wrapper in a wrapper, the harness in a wrapper, and npm run mutate in a wrapper in a wrapper all join', BOUNDED, async () => {
    const { root, path } = setUp(HARNESS_FILES);
    const inner = await heavy(['--purpose', 'outer', '--', process.execPath, CLI, 'heavy', '--', process.execPath, '-e', 'process.exit(4)'],
      { cwd: root, track: t, deadlineMs: 20_000 }).exited;
    strictEqual(inner.code, 4, inner.out);
    ok(/heavy: inside the heavy-work lock of outer \(pid \d+\); not waiting/.test(inner.out), inner.out);

    const harness = await heavy(['--purpose', 'mutations', '--', process.execPath, HARNESS, 'spec.mjs', '--repo-root', root],
      { cwd: root, track: t, deadlineMs: 30_000 }).exited;
    strictEqual(harness.code, 0, harness.out);
    ok(/mutation-harness: inside the heavy-work lock of mutations \(pid \d+\); not waiting/.test(harness.out), harness.out);

    // The middle wrapper forwards the proof it inherited; a new one would match
    // no holder and the harness would wait on its own holder.
    const deep = await heavy(['--purpose', 'top', '--', process.execPath, CLI, 'heavy', '--purpose', 'middle', '--',
      'npm', 'run', 'mutate', '--', 'spec.mjs', '--repo-root', root], { cwd: root, track: t, deadlineMs: 30_000 }).exited;
    strictEqual(deep.code, 0, deep.out);
    ok(/mutation-harness: inside the heavy-work lock of top \(pid \d+\); not waiting/.test(deep.out), deep.out);
    ok(!existsSync(path), 'the outermost wrapper released the lock');
  });
});

describe('exit status', () => {
  it('the command\'s own status, 128+n for a signal that ended it, 126 and 127', BOUNDED, async () => {
    const { S, root } = setUp();
    const run = async (command) => (await heavy(['--', ...command], { cwd: root, track: t }).exited).code;
    strictEqual(await run(['true']), 0);
    strictEqual(await run(['sh', '-c', 'exit 3']), 3);
    strictEqual(await run(['sh', '-c', 'kill -TERM $$']), 143);
    const plain = write(S, 'not-executable', '#!/bin/sh\nexit 0\n');
    chmodSync(plain, 0o644);
    strictEqual(await run([plain]), 126);
    strictEqual(await run([join(S, 'missing')]), 127);
    strictEqual(await run(['no-such-command-anywhere']), 127);
  });

  it('--status-file: acquired, running and ended, a command that exits 127 told from one that was not found (verify-exec)', BOUNDED, async () => {
    const { S, root } = setUp();
    const statusOf = async (name, command) => {
      const file = join(S, `${name}.status`);
      const r = await heavy(['--status-file', file, '--', ...command], { cwd: root, track: t }).exited;
      return { code: r.code, out: r.out, states: lines(file).map((l) => JSON.parse(l)) };
    };
    const exits127 = await statusOf('exits', ['sh', '-c', 'exit 127']);
    const missing = await statusOf('missing', [join(S, 'missing')]);
    strictEqual(exits127.code, 127);
    strictEqual(missing.code, 127);
    deepStrictEqual(exits127.states.map((x) => x.state), ['acquired', 'running', 'ended'], 'with no --go-file, no ready line and no wait');
    deepStrictEqual(exits127.states.at(-1), { state: 'ended', code: 127 });
    deepStrictEqual(missing.states.at(-1), { state: 'ended', error: 'ENOENT' });
    ok(Number.isInteger(exits127.states[1].pgid), JSON.stringify(exits127.states));
    const signalled = await statusOf('signalled', [process.execPath, '-e', "process.kill(process.pid, 'SIGTERM')"]);
    deepStrictEqual(signalled.states.at(-1), { state: 'ended', signal: 'SIGTERM' }, signalled.out);
    // A refusal before the lock: the declaration names the command as taking it itself.
    const refusedFile = join(S, 'refused.status');
    const r = await heavy(['--status-file', refusedFile, '--repo', join(S, 'nowhere'), '--', 'true'], { cwd: root, track: t }).exited;
    strictEqual(r.code, 125, r.out);
    ok(lines(refusedFile).map((l) => JSON.parse(l)).at(-1).refused, lines(refusedFile).join('\n'));
  });

  it('--go-file: ready with the command\'s group, and the command starts only once the go file exists; a signal before it stops the wrapper, nothing run (verify-exec)', BOUNDED, async () => {
    const { S, root } = setUp();
    const log = join(S, 'ran.log');
    const command = ['sh', '-c', `echo ran >> ${JSON.stringify(log)}`];
    const statusFile = join(S, 'a.status');
    const goFile = join(S, 'a.go');
    const w = heavy(['--status-file', statusFile, '--go-file', goFile, '--', ...command], { cwd: root, track: t });
    const states = (file) => lines(file).map((l) => JSON.parse(l));
    ok(await until(() => states(statusFile).some((x) => x.state === 'ready')), lines(statusFile).join('\n'));
    const readyLine = states(statusFile).find((x) => x.state === 'ready');
    // The leader's start, or null where the system will not tell it (a sandbox denying ps).
    ok(Number.isInteger(readyLine.pgid) && (typeof readyLine.started === 'string' || readyLine.started === null), JSON.stringify(readyLine));
    await sleep(400);
    strictEqual(existsSync(log), false, 'the command waits for the go');
    writeFileSync(goFile, 'go\n');
    const r = await w.exited;
    strictEqual(r.code, 0, r.out);
    strictEqual(readFileSync(log, 'utf8'), 'ran\n');
    deepStrictEqual(states(statusFile).map((x) => x.state), ['acquired', 'ready', 'running', 'ended']);

    const stopped = join(S, 'b.status');
    const w2 = heavy(['--status-file', stopped, '--go-file', join(S, 'b.go'), '--', ...command], { cwd: root, track: t });
    ok(await until(() => states(stopped).some((x) => x.state === 'ready')), lines(stopped).join('\n'));
    w2.child.kill('SIGTERM');
    const r2 = await w2.exited;
    strictEqual(r2.code, 128 + osConstants.signals.SIGTERM, r2.out);
    deepStrictEqual(states(stopped).at(-1), { state: 'ended', stopped: 'SIGTERM' });
    strictEqual(readFileSync(log, 'utf8'), 'ran\n', 'the stopped command never ran');
    // --go-file without --status-file is a usage error: nothing tells the driver to give the go.
    strictEqual((await heavy(['--go-file', join(S, 'c.go'), '--', 'true'], { cwd: root, track: t }).exited).code, 125);
  });

  it('--go-file: a ready line the status file does not take is no go: the command never runs, and the wrapper refuses (verify-exec)', BOUNDED, async () => {
    const { S, root } = setUp();
    const log = join(S, 'ran.log');
    const statusFile = join(S, 'd.status');
    // A go that comes late anyway: a wrapper that waited for it on a ready
    // line nobody saw would run the command then, and not hang the test.
    const late = setTimeout(() => writeFileSync(join(S, 'd.go'), 'go\n'), 2000);
    // Between the group's registration and the ready line, the status file
    // stops taking lines: the driver would never see the group to give its go.
    const code = await runHeavy(['--status-file', statusFile, '--go-file', join(S, 'd.go'), '--', 'sh', '-c', `echo ran >> ${JSON.stringify(log)}`], {
      cwd: root, env: testEnv(), err: () => {}, beforeGo: async () => { chmodSync(statusFile, 0o444); },
    }).finally(() => clearTimeout(late));
    strictEqual(code, 125);
    strictEqual(existsSync(log), false, 'the command never ran');
    deepStrictEqual(lines(statusFile).map((l) => JSON.parse(l).state), ['acquired']);
  });

  it('126 for an exec failure Node throws (ENOEXEC, ENOTDIR); 125 when the system has no room to start it', BOUNDED, async () => {
    const { S, root, path } = setUp();
    const run = (command, env) => heavy(['--', ...command], { cwd: root, track: t, env }).exited;
    // A path through a file: Node throws ENOTDIR on every platform.
    const file = write(S, 'a-file', '');
    let r = await run([join(file, 'below')]);
    strictEqual(r.code, 126, r.out);
    ok(r.out.includes('heavy: cannot run ') && r.out.includes(': ENOTDIR'), r.out);
    // The supervisor's spawn throws as the system would make it: ENOEXEC (macOS
    // gives it for an executable in no format it runs; glibc's execvp runs such
    // a file with /bin/sh instead), and EAGAIN, a full process table.
    const throwing = (code) => write(S, `${code}.cjs`, [
      "if (process.execArgv[0] === '-e' && String(process.execArgv[1]).includes('JSON.parse(process.argv[1])')) {",
      `  require('node:child_process').spawn = () => { throw Object.assign(new Error('spawn ${code}'), { code: '${code}' }); };`,
      '}',
      '',
    ].join('\n'));
    for (const [code, status] of [['ENOEXEC', 126], ['EAGAIN', 125]]) {
      r = await run(['true'], testEnv({ NODE_OPTIONS: `--require ${JSON.stringify(throwing(code))}` }));
      strictEqual(r.code, status, `${code}: ${r.out}`);
      ok(r.out.includes(`: ${code}`), r.out);
    }
    ok(!existsSync(path), 'each released the lock');
  });

  it('a supervisor that dies before the go line, or ends with no report, is 125', BOUNDED, async () => {
    const { S, root, path } = setUp();
    const supervisor = "String(process.execArgv[1]).includes('JSON.parse(process.argv[1])')";
    const early = write(S, 'early.cjs', `if (process.execArgv[0] === '-e' && ${supervisor}) process.exit(9);\n`);
    const ran = join(S, 'ran');
    const touch = [process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(ran)}, '')`];
    let r = await heavy(['--', ...touch], { cwd: root, track: t, env: testEnv({ NODE_OPTIONS: `--require ${JSON.stringify(early)}` }) }).exited;
    strictEqual(r.code, 125, r.out);
    ok(r.out.includes('ended without reporting how the command ended'), r.out);
    ok(!existsSync(ran), 'the command never ran');
    ok(!existsSync(path));
    const mute = write(S, 'mute.cjs', [
      `if (process.execArgv[0] === '-e' && ${supervisor}) {`,
      "  const fs = require('node:fs'); const w = fs.writeSync;",
      '  fs.writeSync = (fd, ...rest) => (fd === 3 ? 0 : w(fd, ...rest));',
      '}',
      '',
    ].join('\n'));
    r = await heavy(['--', ...touch], { cwd: root, track: t, env: testEnv({ NODE_OPTIONS: `--require ${JSON.stringify(mute)}` }) }).exited;
    strictEqual(r.code, 125, r.out);
    ok(existsSync(ran), 'the command ran');
    ok(!existsSync(path));
  });
});

describe('signals', () => {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    it(`${signal} while the command runs reaches its group, which is gone before the lock is`, BOUNDED, async () => {
      const { S, root, path } = setUp();
      const pidFile = join(S, 'pids');
      const got = join(S, 'got');
      const w = heavy(['--', ...groupCommand(pidFile, { trap: got })], { cwd: root, track: t });
      ok(await until(() => pidsIn(pidFile).length === 2), w.output());
      const started = t.pidFile(pidFile);
      ok(existsSync(path));
      w.child.kill(signal);
      let left = null;
      while (left === null) {
        if (!existsSync(path) || w.child.exitCode !== null || w.child.signalCode !== null) left = started.filter(running);
        await sleep(1);
      }
      deepStrictEqual(left, [], 'nothing of the group was left when the lock went');
      strictEqual((await w.exited).code, 128 + osConstants.signals[signal]);
      ok(!existsSync(path));
      deepStrictEqual(lines(got).sort(), started.map((pid) => `${pid} ${signal}`).sort(), 'each process of the group got that signal');
    });
  }

  it('a command that ignores the signal gets SIGKILL 5 s later', BOUNDED, async () => {
    const { S, root, path } = setUp();
    const pidFile = join(S, 'pids');
    const w = heavy(['--', ...groupCommand(pidFile, { ignoreTerm: true })], { cwd: root, track: t });
    ok(await until(() => pidsIn(pidFile).length === 2), w.output());
    const started = t.pidFile(pidFile);
    const since = Date.now();
    w.child.kill('SIGTERM');
    await sleep(1000);
    ok(started.every(running) && existsSync(path), 'it waits for the group');
    strictEqual((await w.exited).code, 143);
    ok(Date.now() - since >= 4500);
    ok(!started.some(running));
  });

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    it(`${signal} while waiting ends the wait: 128+n, the command never ran, the holder's lock untouched`, BOUNDED, async () => {
      const { S, root, path } = setUp();
      const holder = heavy(['--purpose', 'holder', '--', ...barrierCommand(S, 'a', join(S, 'log'))], { cwd: root, track: t });
      ok(await until(() => ready(S, 'a')), holder.output());
      const raw = readFileSync(path, 'utf8');
      const ran = join(S, 'ran');
      const waiter = heavy(['--', process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(ran)}, '')`], { cwd: root, track: t });
      ok(await until(() => waiter.output().includes('waiting for the run of holder')), waiter.output());
      waiter.child.kill(signal);
      strictEqual((await waiter.exited).code, 128 + osConstants.signals[signal]);
      ok(!existsSync(ran), 'the command never ran');
      strictEqual(readFileSync(path, 'utf8'), raw, 'the holder keeps its lock');
      letGo(S, 'a');
      strictEqual((await holder.exited).code, 0);
    });
  }
});

describe('a holder and the wrappers that joined it', () => {
  it('a joined wrapper\'s cancellation stops its own group only', BOUNDED, async () => {
    const { S, root, path } = setUp();
    const log = join(S, 'log');
    const codes = join(S, 'codes');
    // The holder's command runs two joined wrappers and notes how each ended.
    const both = [
      "const { spawn } = require('node:child_process');",
      "const fs = require('node:fs');",
      `const one = (name) => spawn(process.execPath, [${JSON.stringify(CLI)}, 'heavy', '--purpose', name, '--', ...${JSON.stringify(barrierCommand(S, '@', log))}.map((w) => w.replaceAll('@', name))], { stdio: 'inherit' });`,
      "const kids = { sibling: one('sibling'), target: one('target') };",
      `fs.writeFileSync(${JSON.stringify(join(S, 'kids'))}, JSON.stringify({ sibling: kids.sibling.pid, target: kids.target.pid }));`,
      `for (const [name, kid] of Object.entries(kids)) kid.on('exit', (code) => fs.appendFileSync(${JSON.stringify(codes)}, name + ' ' + code + '\\n'));`,
    ].join('\n');
    const holder = heavy(['--purpose', 'holder', '--', process.execPath, '-e', both], { cwd: root, track: t });
    ok(await until(() => ready(S, 'sibling') && ready(S, 'target')), holder.output());
    const kids = JSON.parse(readFileSync(join(S, 'kids'), 'utf8'));
    process.kill(kids.target, 'SIGTERM');
    ok(await until(() => lines(codes).includes('target 143')), `${lines(codes)}\n${holder.output()}`);
    ok(lines(log).includes('sibling start') && !lines(log).includes('sibling end'), 'the sibling still runs');
    ok(running(kids.sibling) && existsSync(path), 'the holder still holds');
    letGo(S, 'sibling');
    const done = await holder.exited;
    strictEqual(done.code, 0, done.out);
    deepStrictEqual(lines(codes).sort(), ['sibling 0', 'target 143']);
  });

  it('a holder\'s release is refused while a joined wrapper that left its group runs', BOUNDED, async () => {
    const { S, root, path } = setUp();
    const log = join(S, 'log');
    // The holder's command starts a joined wrapper outside its group and, once
    // that wrapper runs its command (so it has registered), exits.
    const detach = [
      "const { spawn } = require('node:child_process');",
      `const kid = spawn(process.execPath, [${JSON.stringify(CLI)}, 'heavy', '--purpose', 'joined', '--', ...${JSON.stringify(barrierCommand(S, 'j', log))}], { stdio: 'ignore', detached: true });`,
      'kid.unref();',
      `require('node:fs').writeFileSync(${JSON.stringify(join(S, 'kid'))}, String(kid.pid));`,
      `const t = setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(join(S, 'j.ready'))})) clearInterval(t); }, 10);`,
    ].join('\n');
    const holder = heavy(['--purpose', 'holder', '--', process.execPath, '-e', detach], {
      cwd: root, track: t, env: testEnv({ AGENTIC_HEAVY_LOCK_REPORT_MS: '200' }),
    });
    ok(await until(() => ready(S, 'j')), holder.output());
    t.pid(Number(readFileSync(join(S, 'kid'), 'utf8')));
    ok(await until(() => holder.output().includes('of this lock\'s ownership still runs; the lock is kept until it ends')), holder.output());
    await sleep(200);
    strictEqual(holder.child.exitCode, null, 'the holder waits');
    ok(existsSync(path), 'and keeps the lock');
    letGo(S, 'j');
    const done = await holder.exited;
    strictEqual(done.code, 0, done.out);
    ok(!existsSync(path));
    deepStrictEqual(registeredGroups(path), []);
  });
});

describe('the launcher', () => {
  it('runs the wrapper, forwards SIGTERM to it, and passes its exit status through', BOUNDED, async () => {
    const { S, root, path } = setUp();
    const env = testEnv({ AGENTIC_ORCHESTRATOR_ROOT: join(REPO_ROOT, 'plugins', 'orchestrator') });
    const ok3 = await spawnNode([LAUNCHER, 'heavy', '--', 'sh', '-c', 'exit 3'], { cwd: root, env, track: t }).exited;
    strictEqual(ok3.code, 3, ok3.out);
    const pidFile = join(S, 'pids');
    const l = spawnNode([LAUNCHER, 'heavy', '--', ...groupCommand(pidFile)], { cwd: root, env, track: t });
    ok(await until(() => pidsIn(pidFile).length === 2), l.output());
    const started = t.pidFile(pidFile);
    l.child.kill('SIGTERM');
    strictEqual((await l.exited).code, 143);
    ok(!started.some(running));
    ok(!existsSync(path));
  });

  it('SIGHUP to the launcher\'s pid ends the launcher alone: the wrapper keeps the lock until its command ends', BOUNDED, async () => {
    const { S, root, path } = setUp();
    const env = testEnv({ AGENTIC_ORCHESTRATOR_ROOT: join(REPO_ROOT, 'plugins', 'orchestrator') });
    const log = join(S, 'log');
    const l = spawnNode([LAUNCHER, 'heavy', '--', ...barrierCommand(S, 'a', log)], { cwd: root, env, track: t });
    // The launcher's own end: its output pipes stay open while the wrapper runs.
    const launcherEnded = new Promise((done) => { l.child.once('exit', (code, signal) => done({ code, signal })); });
    ok(await until(() => ready(S, 'a')), l.output());
    const holder = t.pid(JSON.parse(readFileSync(path, 'utf8')).pid);
    ok(holder !== l.child.pid, 'the wrapper, not the launcher, holds the lock');
    l.child.kill('SIGHUP');
    deepStrictEqual(await launcherEnded, { code: null, signal: 'SIGHUP' }, 'the launcher does not forward SIGHUP');
    await sleep(300);
    ok(running(holder) && existsSync(path), 'the wrapper runs on, holding the lock');
    deepStrictEqual(lines(log), ['a start'], 'and its command was not stopped');
    letGo(S, 'a');
    ok(await until(() => !running(holder)), l.output());
    ok(!existsSync(path), 'it released once its command ended');
    deepStrictEqual(lines(log), ['a start', 'a end']);
  });
});

describe('a driver inside a holder', () => {
  it('refuses to start, naming the holder, with nothing created; a stale proof is no refusal', BOUNDED, async () => {
    const { root, path } = setUp();
    const r = await heavy(['--purpose', 'a suite', '--', process.execPath, CLI, 'start', '--execute', '--models', 'sonnet'], { cwd: root, track: t }).exited;
    strictEqual(r.code, 1, r.out);
    ok(r.out.includes(`✗ this shell runs inside the heavy-work lock of a suite (pid `), r.out);
    deepStrictEqual(readdirSync(root).sort(), ['.git', 'README.md'], 'no run directory');
    ok(!existsSync(path));
    const stale = await spawnNode([CLI, 'start', '--execute', '--models', 'sonnet'], {
      cwd: root, track: t, env: testEnv({ AGENTIC_HEAVY_LOCK_PROOF: 'a'.repeat(64) }),
    }).exited;
    ok(!stale.out.includes('inside the heavy-work lock'), stale.out);
  });
});

describe('a command declared as taking the lock itself', () => {
  const DECLARATION = '.agentic-plugins/verify-checks.json';
  const declare = (kinds) => `${JSON.stringify({ schema: 'agentic-verify-checks-1.0', kinds }, null, 2)}\n`;
  const SELF = { mutate: { argv: ['sh', 'self.sh', '{spec}'], slots: [{ name: 'spec', type: 'path', repeat: 'one' }], locks_itself: true } };

  it('is refused with 125 from the committed declaration, never the working tree', BOUNDED, async () => {
    const { root, path } = setUp({ 'self.sh': 'exit 0\n', [DECLARATION]: declare(SELF) });
    const before = git(root, 'rev-parse', 'HEAD');
    let r = await heavy(['--', 'sh', 'self.sh', 'x'], { cwd: root, track: t }).exited;
    strictEqual(r.code, 125, r.out);
    ok(r.out.includes('marks the check kind mutate (sh self.sh) as taking the heavy-work lock itself'), r.out);
    ok(!existsSync(path), 'nothing was acquired');
    // An edit in the working tree counts for nothing.
    write(root, DECLARATION, declare({}));
    strictEqual((await heavy(['--', 'sh', 'self.sh', 'x'], { cwd: root, track: t }).exited).code, 125);
    write(root, DECLARATION, declare({ other: { argv: ['true'], locks_itself: true } }));
    strictEqual((await heavy(['--', 'true'], { cwd: root, track: t }).exited).code, 0);
    // --declaration-ref reads that commit: one without the declaration refuses nothing.
    git(root, 'rm', '-q', '--cached', DECLARATION);
    git(root, 'commit', '-q', '-m', 'no declaration', '--no-gpg-sign');
    r = await heavy(['--declaration-ref', before, '--', 'sh', 'self.sh', 'x'], { cwd: root, track: t }).exited;
    strictEqual(r.code, 125, r.out);
    strictEqual((await heavy(['--', 'sh', 'self.sh', 'x'], { cwd: root, track: t }).exited).code, 0);
    r = await heavy(['--declaration-ref', 'no-such-ref', '--', 'true'], { cwd: root, track: t }).exited;
    strictEqual(r.code, 125, r.out);
    ok(r.out.includes('--declaration-ref no-such-ref names no commit'), r.out);
  });

  it('one that does not parse at the ref refuses, naming it', BOUNDED, async () => {
    const { root } = setUp({ [DECLARATION]: '{ not json\n' });
    const r = await heavy(['--', 'true'], { cwd: root, track: t }).exited;
    strictEqual(r.code, 125, r.out);
    ok(r.out.includes(`${DECLARATION} at HEAD does not parse`), r.out);
    mkdirSync(join(root, 'x'), { recursive: true });
    writeFileSync(join(root, DECLARATION), declare(SELF));
    git(root, 'add', DECLARATION);
    git(root, 'commit', '-q', '-m', 'fixed', '--no-gpg-sign');
    strictEqual((await heavy(['--', 'true'], { cwd: root, track: t }).exited).code, 0);
  });
});

describe('the command\'s group', () => {
  it('a joined wrapper whose holder\'s ownership has closed starts nothing', BOUNDED, async () => {
    const { S, root } = setUp();
    const holder = await acquire(root, { kind: 'wrapper', purpose: 'closing', log: () => {}, mint: true });
    try {
      closeOwnership(holder.path, holder.token);
      const ran = join(S, 'ran');
      const r = await heavy(['--', process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(ran)}, '')`], {
        cwd: root, track: t, env: testEnv({ AGENTIC_HEAVY_LOCK_PROOF: holder.proof, AGENTIC_HEAVY_LOCK_VIA: holder.chain.join(',') }),
      }).exited;
      strictEqual(r.code, 125, r.out);
      ok(r.out.includes('is closed; nothing more joins it; the command was not started'), r.out);
      await sleep(300);
      ok(!existsSync(ran), 'the command never ran');
    } finally {
      holder.release();
    }
  });

  it('SIGKILL to the wrapper: its supervisor stops the group, and the next wrapper then takes the lock', BOUNDED, async () => {
    const { S, root } = setUp();
    const pidFile = join(S, 'pids');
    const w = heavy(['--', ...groupCommand(pidFile)], { cwd: root, track: t });
    ok(await until(() => pidsIn(pidFile).length === 2), w.output());
    const started = t.pidFile(pidFile);
    w.child.kill('SIGKILL');
    await w.exited;
    ok(await until(() => !started.some(running), 5000), 'the supervisor stopped the group when its lifeline ended');
    const next = await heavy(['--', 'true'], { cwd: root, track: t }).exited;
    strictEqual(next.code, 0, next.out);
    ok(next.out.includes(`heavy: removed a stale run lock (pid ${w.child.pid}, `), next.out);
  });

  it('an orderly end: what the command left in its group is stopped before the lock goes', BOUNDED, async () => {
    const { S, root, path } = setUp();
    // In the supervisor alone, its own kill of the group fails: the wrapper
    // must stop what the command left.
    const preload = write(S, 'preload.cjs', [
      "if (process.execArgv[0] === '-e' && String(process.execArgv[1]).includes('JSON.parse(process.argv[1])')) {",
      '  const kill = process.kill.bind(process);',
      "  process.kill = (pid, signal) => { if (pid === 0) throw Object.assign(new Error('EPERM'), { code: 'EPERM' }); return kill(pid, signal); };",
      '}',
      '',
    ].join('\n'));
    const leftFile = join(S, 'left');
    const command = [process.execPath, '-e', [
      "const { spawn } = require('node:child_process');",
      `const c = spawn(process.execPath, ['-e', ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(leftFile)}, String(process.pid)); setInterval(() => {}, 1000)`)}], { stdio: 'ignore' });`,
      'c.unref();',
      `const t = setInterval(() => { if (require('node:fs').existsSync(${JSON.stringify(leftFile)})) process.exit(0); }, 10);`,
    ].join('\n')];
    const w = heavy(['--', ...command], { cwd: root, track: t, env: testEnv({ NODE_OPTIONS: `--require ${JSON.stringify(preload)}` }) });
    ok(await until(() => existsSync(leftFile)), w.output());
    const left = t.pid(Number(readFileSync(leftFile, 'utf8')));
    let aliveAtRelease = null;
    while (aliveAtRelease === null) {
      if (!existsSync(path) || w.child.exitCode !== null) aliveAtRelease = running(left);
      await sleep(1);
    }
    strictEqual(aliveAtRelease, false, 'the command\'s leftover was stopped before the lock went');
    strictEqual((await w.exited).code, 0);
  });
});

describe('in process', () => {
  it('the command starts only once its group is registered, at the go line', BOUNDED, async () => {
    const { S, root, path } = setUp();
    const ran = join(S, 'ran');
    let seen = null;
    const code = await runHeavy(['--', process.execPath, '-e', `require('node:fs').writeFileSync(${JSON.stringify(ran)}, '')`], {
      cwd: root, env: testEnv(), err: () => {},
      beforeGo: async () => {
        // Long enough for a command started without the go line to run.
        await sleep(1500);
        seen = { ran: existsSync(ran), groups: registeredGroups(path).length };
      },
    });
    strictEqual(code, 0);
    deepStrictEqual(seen, { ran: false, groups: 1 }, 'registered, and nothing ran, before the go line');
    ok(existsSync(ran), 'it ran after');
  });

  it('a supervisor the system refuses to start is 125, and the lock is released', BOUNDED, async () => {
    const { root, path } = setUp();
    const said = [];
    const code = await runHeavy(['--purpose', 'too long', '--', 'true', 'x'.repeat(4 * 1024 * 1024)], { cwd: root, env: testEnv(), err: (l) => said.push(l) });
    strictEqual(code, 125, said.join('\n'));
    ok(said.some((l) => l.startsWith('heavy: cannot start the command\'s supervisor')), said.join('\n'));
    ok(!existsSync(path), 'nothing is left held');
  });
});

describe('what is left behind', () => {
  it('an orderly end leaves no record, guard or ownership', BOUNDED, async () => {
    const { root, path } = setUp();
    strictEqual((await heavy(['--', 'true'], { cwd: root, track: t }).exited).code, 0);
    const common = join(path, '..');
    deepStrictEqual(readdirSync(common).filter((n) => n.startsWith('mutation-harness.lock')), []);
  });
});
