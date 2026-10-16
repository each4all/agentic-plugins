// Shared test suite for exitAfterFlush, the exit every companion script ends
// through (C125): `process.exit` right after a write to a pipe drops whatever
// the pipe has not taken yet, so a JSON envelope past 65,536 bytes reached its
// reader cut short. Each script carries its own inline copy of the helper (the
// bundle stays self-contained), and each copy is tested here once, from one
// definition.
//
// Every case runs a real child process, because the behaviour under test is
// what the operating system's pipes do at exit. The child is a small driver
// that imports the helper from the script under test and writes, then calls
// it; it reports on fd 3 the moment it starts flushing, and the parent reads,
// delays, or closes the child's pipes to set up the reader each case needs.
// No sleep is an assertion: a delay only holds a pipe blocked, and every
// watchdog kills the child and fails its test by name.
//
// Not discovered by `node --test` on its own (no *.test.mjs suffix, per
// ADR-0033); it runs through claude-companion.test.mjs, codex-companion.test.mjs
// and tests/companions/test-discover-peer.mjs.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

// On Windows, pipe writes are synchronous, so a pipe cannot be held blocked
// and the fake peers are POSIX shell scripts.
const SKIP_POSIX = process.platform === 'win32' ? 'POSIX pipes and shell' : false;

// Far more than a pipe and the parent's read buffer hold together, so a
// premature exit always leaves some of it unwritten.
const PAYLOAD = 2 * 1024 * 1024;
const PIPE_CAPACITY = 65_536;
const WATCHDOG_MS = 20_000;
// How long the parent leaves a pipe unread after the child starts flushing.
const DRAIN_DELAY_MS = 300;

// The driver reports on fd 3 when it starts flushing, and at exit how long the
// flush took by its own clock and which delays it saw scheduled with
// setTimeout (`spyTimer`), so no timing assertion depends on when the parent
// gets to run.
const driverSource = (moduleUrl) => `import { writeSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { exitAfterFlush } from ${JSON.stringify(moduleUrl)};

const spec = JSON.parse(process.argv[2]);
const report = { timers: [] };
let flushStart;
if (spec.spyTimer) {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...args) => { report.timers.push(ms); return realSetTimeout(fn, ms, ...args); };
}
process.on('exit', () => {
  if (flushStart !== undefined) report.flushMs = performance.now() - flushStart;
  writeSync(3, \`report \${JSON.stringify(report)}\\n\`);
});
const act = () => {
  if (spec.interval) setInterval(() => {}, 1000);
  if (spec.cork) process.stdout.cork();
  if (spec.stdout) process.stdout.write('o'.repeat(spec.stdout));
  if (spec.stderr) process.stderr.write('e'.repeat(spec.stderr));
  writeSync(3, 'flushing\\n');
  flushStart = performance.now();
  if (spec.fallbackMs === undefined) exitAfterFlush(spec.code);
  else exitAfterFlush(spec.code, spec.fallbackMs);
  if (spec.second) exitAfterFlush(spec.second.code, spec.second.fallbackMs);
};
if (spec.waitGo) {
  process.stdin.once('data', () => { process.stdin.destroy(); act(); });
} else {
  act();
}
`;

// Runs the driver with `spec`. The parent reads each of the child's stdout and
// stderr at once (`'read'`), only DRAIN_DELAY_MS after the child starts
// flushing (`'delayed'`), never (`'never'`), or closes it before the child
// writes (`'closed'`).
async function runDriver(driver, spec, { stdout = 'read', stderr = 'read' } = {}) {
  const child = spawn(process.execPath, [driver, JSON.stringify(spec)], {
    stdio: [spec.waitGo ? 'pipe' : 'ignore', 'pipe', 'pipe', 'pipe'],
  });
  let timedOut = false;
  const watchdog = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, WATCHDOG_MS);
  const chunks = { stdout: [], stderr: [] };
  const modes = { stdout, stderr };
  const reading = [];
  let delayedStarted = false;
  const startReading = (name) => {
    const stream = child[name];
    reading.push(stream.closed ? null : once(stream, 'close'));
    stream.on('data', (c) => chunks[name].push(c));
  };
  const startDelayed = () => {
    if (delayedStarted) return;
    delayedStarted = true;
    for (const name of ['stdout', 'stderr']) if (modes[name] === 'delayed') startReading(name);
  };
  for (const name of ['stdout', 'stderr']) if (modes[name] === 'read') startReading(name);
  let control = '';
  let marked = false;
  reading.push(once(child.stdio[3], 'close'));
  child.stdio[3].on('data', (c) => {
    control += c;
    if (marked || !control.includes('flushing\n')) return;
    marked = true;
    setTimeout(startDelayed, DRAIN_DELAY_MS);
  });
  const exited = once(child, 'exit');
  if (stdout === 'closed') child.stdout.destroy();
  if (stderr === 'closed') child.stderr.destroy();
  if (spec.waitGo) child.stdin.end('go\n');
  const [status, signal] = await exited;
  clearTimeout(watchdog);
  startDelayed();
  await Promise.all(reading);
  for (const name of ['stdout', 'stderr']) if (modes[name] === 'never') child[name].destroy();
  return {
    status,
    signal,
    timedOut,
    stdout: Buffer.concat(chunks.stdout).toString('utf8'),
    stderr: Buffer.concat(chunks.stderr).toString('utf8'),
    report: JSON.parse(control.match(/^report (.*)$/m)?.[1] ?? 'null'),
  };
}

function assertExited(r, code) {
  assert.equal(r.timedOut, false, `the watchdog killed the child after ${WATCHDOG_MS} ms: exitAfterFlush never exited`);
  assert.equal(r.status, code, `exit status ${r.status} (signal ${r.signal}), stderr length ${r.stderr.length}`);
}

function assertWhole(actual, ch, label) {
  assert.equal(actual.length, PAYLOAD, `${label} arrived with ${actual.length} of ${PAYLOAD} bytes`);
  assert.ok(actual === ch.repeat(PAYLOAD), `${label} arrived altered`);
}

export function defineExitAfterFlushSuite({ label, modulePath }) {
  describe(`${label} — exitAfterFlush (C125)`, () => {
    let dir;
    let driver;
    const setup = () => {
      if (driver) return driver;
      dir = mkdtempSync(path.join(os.tmpdir(), 'exit-flush-'));
      driver = path.join(dir, 'driver.mjs');
      writeFileSync(driver, driverSource(pathToFileURL(modulePath).href), 'utf8');
      process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
      return driver;
    };

    it('the fallback is 10 s', async () => {
      const mod = await import(pathToFileURL(modulePath).href);
      assert.equal(mod.EXIT_FLUSH_FALLBACK_MS, 10_000);
      assert.equal(typeof mod.exitAfterFlush, 'function');
    });

    it('stdout and stderr over 64 KiB each reach a reader that drains late, whole', { skip: SKIP_POSIX }, async () => {
      const r = await runDriver(setup(), { stdout: PAYLOAD, stderr: PAYLOAD, code: 0 }, { stdout: 'delayed', stderr: 'delayed' });
      assertExited(r, 0);
      assertWhole(r.stdout, 'o', 'stdout');
      assertWhole(r.stderr, 'e', 'stderr');
    });

    it('a nonzero code is preserved, with both streams whole', { skip: SKIP_POSIX }, async () => {
      const r = await runDriver(setup(), { stdout: PAYLOAD, stderr: PAYLOAD, code: 3 });
      assertExited(r, 3);
      assertWhole(r.stdout, 'o', 'stdout');
      assertWhole(r.stderr, 'e', 'stderr');
    });

    it('waits for stderr as well: a blocked stderr with nothing on stdout still arrives whole', { skip: SKIP_POSIX }, async () => {
      const r = await runDriver(setup(), { stderr: PAYLOAD, code: 3 }, { stderr: 'delayed' });
      assertExited(r, 3);
      assert.equal(r.stdout, '');
      assertWhole(r.stderr, 'e', 'stderr');
    });

    it('exits with the code while a ref\'d handle keeps the loop alive', { skip: SKIP_POSIX }, async () => {
      const r = await runDriver(setup(), { interval: true, stdout: 16, code: 5, fallbackMs: 60_000 });
      assertExited(r, 5);
      assert.equal(r.stdout, 'o'.repeat(16));
    });

    it('exits by the fallback, with the code, when the reader never drains', { skip: SKIP_POSIX }, async () => {
      const r = await runDriver(setup(), { stdout: PAYLOAD, code: 3, fallbackMs: 1000 }, { stdout: 'never' });
      assertExited(r, 3);
      // By the child's own clock: no earlier than the fallback, and well
      // before twice it.
      assert.ok(r.report.flushMs >= 990 && r.report.flushMs < 1900, `exited ${r.report.flushMs} ms after it started flushing, against a 1000 ms fallback`);
    });

    it('the fallback defaults to EXIT_FLUSH_FALLBACK_MS', { skip: SKIP_POSIX }, async () => {
      const r = await runDriver(setup(), { spyTimer: true, stdout: 16, code: 0 });
      assertExited(r, 0);
      assert.deepEqual(r.report.timers, [10_000]);
    });

    it('the fallback timer is ref\'d: with nothing else holding the loop it still exits with the code', { skip: SKIP_POSIX }, async () => {
      // A corked stdout never completes its write, and no other handle is
      // live, so only a ref'd timer keeps the process up to exit with 3.
      const r = await runDriver(setup(), { cork: true, stdout: 16, code: 3, fallbackMs: 300 });
      assertExited(r, 3);
    });

    it('exits with the code when the reader of stdout closed early (EPIPE), before the fallback', { skip: SKIP_POSIX }, async () => {
      // stderr stays blocked, so only the stdout error ends the flush; with no
      // error listener on stdout that error would crash the process with exit 1.
      const r = await runDriver(
        setup(),
        { waitGo: true, stdout: PAYLOAD, stderr: PAYLOAD, code: 3, fallbackMs: 60_000 },
        { stdout: 'closed', stderr: 'never' },
      );
      assertExited(r, 3);
    });

    it('exits with the code when the reader of stderr closed early (EPIPE), before the fallback', { skip: SKIP_POSIX }, async () => {
      // The mirror of the case above: stdout stays blocked, so only the
      // stderr error ends the flush.
      const r = await runDriver(
        setup(),
        { waitGo: true, stdout: PAYLOAD, stderr: PAYLOAD, code: 3, fallbackMs: 60_000 },
        { stdout: 'never', stderr: 'closed' },
      );
      assertExited(r, 3);
    });

    it('a second call while flushing is ignored', { skip: SKIP_POSIX }, async () => {
      const r = await runDriver(
        setup(),
        { stdout: PAYLOAD, code: 3, fallbackMs: 300, second: { code: 4, fallbackMs: 50 } },
        { stdout: 'never' },
      );
      assertExited(r, 3);
    });

    it('writes nothing itself', { skip: SKIP_POSIX }, async () => {
      const r = await runDriver(setup(), { code: 0 });
      assertExited(r, 0);
      assert.equal(r.stdout, '');
      assert.equal(r.stderr, '');
    });
  });
}

// The defect as a consumer meets it: a peer answer past 64 KiB, relayed by the
// real companion script to a reader on a pipe. The fake peer is `cat` of a
// file the test writes, so the fixture delivers its output whole.
export function defineLargeEnvelopeRegression({ label, scriptPath, peerBin }) {
  describe(`${label} — a large peer answer reaches a pipe reader whole (C125)`, () => {
    const ANSWER = 1_000_000;

    async function runCompanion(argv) {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'companion-large-'));
      try {
        const bin = path.join(dir, 'bin');
        mkdirSync(bin);
        const answerFile = path.join(dir, 'answer.txt');
        const answer = 'a'.repeat(ANSWER);
        writeFileSync(answerFile, answer, 'utf8');
        const fake = path.join(bin, peerBin);
        writeFileSync(fake, `#!/bin/sh\nexec /bin/cat '${answerFile}'\n`, 'utf8');
        chmodSync(fake, 0o755);
        const child = spawn(process.execPath, [scriptPath, ...argv], {
          env: { PATH: bin, HOME: dir },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let timedOut = false;
        const watchdog = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, WATCHDOG_MS);
        const out = [];
        const err = [];
        child.stdout.on('data', (c) => out.push(c));
        child.stderr.on('data', (c) => err.push(c));
        child.stdin.end('<task>large answer</task>');
        const [status] = await once(child, 'close');
        clearTimeout(watchdog);
        assert.equal(timedOut, false, `the watchdog killed ${label} after ${WATCHDOG_MS} ms`);
        return { status, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), answer };
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }

    it('JSON mode: the envelope past 64 KiB parses and carries the whole answer', { skip: SKIP_POSIX }, async () => {
      const r = await runCompanion(['task', '--output-format', 'json']);
      assert.equal(r.status, 0, `stderr=${r.stderr.slice(0, 500)}`);
      assert.ok(r.stdout.length > PIPE_CAPACITY, `stdout is ${r.stdout.length} bytes`);
      let envelope;
      assert.doesNotThrow(() => { envelope = JSON.parse(r.stdout); }, `the envelope is cut at ${r.stdout.length} bytes`);
      assert.equal(envelope.status, 'success');
      assert.equal(envelope.stdout.length, ANSWER);
      assert.ok(envelope.stdout === r.answer, 'the envelope carries an altered answer');
    });

    it('text mode: the answer past 64 KiB arrives whole', { skip: SKIP_POSIX }, async () => {
      const r = await runCompanion(['task']);
      assert.equal(r.status, 0, `stderr=${r.stderr.slice(0, 500)}`);
      assert.equal(r.stdout.length, ANSWER, `stdout arrived with ${r.stdout.length} of ${ANSWER} bytes`);
      assert.ok(r.stdout === r.answer, 'stdout arrived altered');
    });
  });
}
