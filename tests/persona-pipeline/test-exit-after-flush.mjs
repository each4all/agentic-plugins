// plugins/<persona>/scripts/lib/cli-entry.mjs — exitAfterFlush and
// absorbOutputErrors (the owner's discussion-2 decision R2), run once for
// every persona the persona-pipeline manifest generates the unit into
// (ADR-0066 Decision 5), and once for the orchestrator's copy,
// plugins/orchestrator/scripts/lib/cli-entry.mjs (the source byte for byte
// under a copy notice, tests/scripts/test-orchestrator-peer-snapshot-parity.mjs).
//
// Child processes run a driver that imports the copy under test and
// writes twice PIPE_FLOOR_BYTES, read through pipes (or a file, or nothing) as a host
// reads a CLI: both streams arrive whole, the code is kept, a live handle does
// not hold the exit, an early-closed reader is no crash, and a reader that
// never drains is outlasted by the fallback. A control shows a bare
// process.exit() cutting the same output short.
//
// In-process cases drive the helper with controlled streams through its
// `streams` and `exit` seams, each on a fresh instance of the module: a
// second call is ignored, an 'error' event or a write callback's error exits
// at once, a recorded or destroyed stream needs no wait, and a stream that
// was ended is waited for until it finishes.

import { describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { closeSync, openSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { personasFor, personaInfo, REPO_ROOT } from './_personas.mjs';
import { PIPE_FLOOR_BYTES, runThroughPipe } from './_pipe-output.mjs';

const BYTES = 2 * PIPE_FLOOR_BYTES;

// The driver: argv[2] is the module URL, argv[3] the case.
const DRIVER = `
const { absorbOutputErrors, exitAfterFlush } = await import(process.argv[2]);
const mode = process.argv[3];
const big = 'x'.repeat(${BYTES});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (mode === 'bare') {
  process.stdout.write(big);
  process.stderr.write(big);
  process.exit(3);
}
absorbOutputErrors();
if (mode === 'both') {
  process.stdout.write(big);
  process.stderr.write(big);
  exitAfterFlush(0);
} else if (mode === 'code') {
  process.stdout.write(big);
  process.stderr.write(big);
  exitAfterFlush(3);
} else if (mode === 'live') {
  setInterval(() => {}, 1000);
  process.stdout.write(big);
  exitAfterFlush(0);
} else if (mode === 'stall') {
  process.stdout.write(big);
  exitAfterFlush(4, { fallbackMs: Number(process.argv[4]) });
} else if (mode === 'closed-before-tail') {
  await sleep(300);
  process.stdout.write(big);
  await sleep(300);
  process.stderr.write('tail reached\\n');
  exitAfterFlush(5);
} else if (mode === 'ended') {
  process.stdout.end(big);
  exitAfterFlush(0);
} else if (mode === 'quiet') {
  process.stdout.write(big);
  exitAfterFlush(6);
}
`;

// Each copy of the helper, by the plugin that ships it: the copy is loaded
// from its path, as a child module and as fresh in-process instances.
const COPIES = [
  ...personasFor('scripts/lib/cli-entry.mjs')
    .map((persona) => ({ label: persona, path: personaInfo(persona).path('scripts/lib/cli-entry.mjs') })),
  { label: 'orchestrator', path: join(REPO_ROOT, 'plugins/orchestrator/scripts/lib/cli-entry.mjs') },
];

for (const { label: persona, path: cliEntryPath } of COPIES) {
  const CLI_ENTRY_URL = pathToFileURL(cliEntryPath).href;

  async function withDriver(fn) {
    const dir = await mkdtemp(join(tmpdir(), `${persona}-exit-flush-`));
    try {
      const driver = join(dir, 'driver.mjs');
      await writeFile(driver, DRIVER);
      await fn({ dir, driver });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const run = (driver, mode, extra = []) =>
    runThroughPipe(process.execPath, [driver, CLI_ENTRY_URL, mode, ...extra], { timeoutMs: 30_000 });

  describe(`${persona}: cli-entry.mjs exitAfterFlush — a CLI process`, () => {
    it('stdout and stderr over 64 KiB both reach the reader whole, exit 0', async () => {
      await withDriver(async ({ driver }) => {
        const r = await run(driver, 'both');
        strictEqual(r.status, 0, r.stderr.slice(0, 500));
        strictEqual(r.stdout.length, BYTES, 'stdout whole');
        strictEqual(r.stderr.length, BYTES, 'stderr whole');
      });
    });

    it('a nonzero code is the exit status, the output still whole', async () => {
      await withDriver(async ({ driver }) => {
        const r = await run(driver, 'code');
        strictEqual(r.status, 3);
        strictEqual(r.stdout.length, BYTES);
        strictEqual(r.stderr.length, BYTES);
      });
    });

    it('a live ref\'d handle does not hold the exit', async () => {
      await withDriver(async ({ driver }) => {
        const r = await run(driver, 'live');
        strictEqual(r.timedOut, false, 'the process must exit with an interval still live');
        strictEqual(r.status, 0);
        strictEqual(r.stdout.length, BYTES);
      });
    });

    it('end() of a large payload, then the helper: the reader gets it whole', async () => {
      await withDriver(async ({ driver }) => {
        const r = await run(driver, 'ended');
        strictEqual(r.status, 0, r.stderr.slice(0, 500));
        strictEqual(r.stdout.length, BYTES);
      });
    });

    it('a reader closed early: exit with the code, no EPIPE stack, even when the error comes before the tail', async () => {
      await withDriver(async ({ driver }) => {
        const r = await new Promise((resolveRun, rejectRun) => {
          const child = spawn(process.execPath, [driver, CLI_ENTRY_URL, 'closed-before-tail'], { stdio: ['ignore', 'pipe', 'pipe'] });
          child.stdout.destroy();
          const err = [];
          child.stderr.on('data', (c) => err.push(c));
          const watchdog = setTimeout(() => child.kill('SIGKILL'), 30_000);
          child.once('error', rejectRun);
          child.once('close', (status, signal) => {
            clearTimeout(watchdog);
            resolveRun({ status, signal, stderr: Buffer.concat(err).toString('utf8') });
          });
        });
        strictEqual(r.status, 5, `stderr: ${r.stderr}`);
        ok(r.stderr.includes('tail reached'), 'the CLI ran on to its tail');
        ok(!/EPIPE|Error/.test(r.stderr), `no error stack: ${r.stderr}`);
      });
    });

    it('stdout to a file arrives whole', async () => {
      await withDriver(async ({ dir, driver }) => {
        const outPath = join(dir, 'out.txt');
        const fd = openSync(outPath, 'w');
        try {
          const status = await new Promise((resolveRun, rejectRun) => {
            const child = spawn(process.execPath, [driver, CLI_ENTRY_URL, 'both'], { stdio: ['ignore', fd, 'ignore'] });
            const watchdog = setTimeout(() => child.kill('SIGKILL'), 30_000);
            child.once('error', rejectRun);
            child.once('close', (code) => {
              clearTimeout(watchdog);
              resolveRun(code);
            });
          });
          strictEqual(status, 0);
        } finally {
          closeSync(fd);
        }
        strictEqual(statSync(outPath).size, BYTES);
      });
    });

    it('stdout and stderr ignored: exits with the code', async () => {
      await withDriver(async ({ driver }) => {
        const status = await new Promise((resolveRun, rejectRun) => {
          const child = spawn(process.execPath, [driver, CLI_ENTRY_URL, 'quiet'], { stdio: 'ignore' });
          const watchdog = setTimeout(() => child.kill('SIGKILL'), 30_000);
          child.once('error', rejectRun);
          child.once('close', (code) => {
            clearTimeout(watchdog);
            resolveRun(code);
          });
        });
        strictEqual(status, 6);
      });
    });

    it('a reader that never drains: the fallback exits with the code once it fires', async () => {
      await withDriver(async ({ driver }) => {
        const FALLBACK_MS = 1500;
        const r = await new Promise((resolveRun, rejectRun) => {
          const started = Date.now();
          // stdout is a pipe nobody reads: the child's writes stall.
          const child = spawn(process.execPath, [driver, CLI_ENTRY_URL, 'stall', String(FALLBACK_MS)], { stdio: ['ignore', 'pipe', 'pipe'] });
          child.stdout.pause();
          child.stderr.resume();
          let timedOut = false;
          const watchdog = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
          }, 30_000);
          child.once('error', rejectRun);
          child.once('exit', (status, signal) => {
            clearTimeout(watchdog);
            child.stdout.destroy();
            resolveRun({ status, signal, timedOut, elapsedMs: Date.now() - started });
          });
        });
        strictEqual(r.timedOut, false, 'the fallback must end the process');
        strictEqual(r.status, 4);
        ok(r.elapsedMs >= FALLBACK_MS, `exited after ${r.elapsedMs} ms, before the fallback`);
      });
    });

    it('control: a bare process.exit() cuts piped output short', async () => {
      await withDriver(async ({ driver }) => {
        const r = await run(driver, 'bare');
        strictEqual(r.status, 3);
        // What the pipe's buffer took (65,536 bytes on macOS, 146,176 on
        // Linux), or a little more when the reader drains meanwhile; never all.
        ok(r.stdout.length < BYTES,
          `without the helper the reader loses the rest (got ${r.stdout.length}); if this changes, the regressions above test nothing here`);
      });
    });
  });

  describe(`${persona}: cli-entry.mjs exitAfterFlush — controlled streams`, () => {
    let instance = 0;
    // A fresh module instance per case: the second-call guard is per instance.
    const fresh = () => import(`${CLI_ENTRY_URL}?case=${persona}-${(instance += 1)}`);

    // exitAfterFlush sets process.exitCode; the test process keeps its own.
    async function keepingExitCode(fn) {
      const saved = process.exitCode;
      try {
        await fn();
      } finally {
        process.exitCode = saved;
      }
    }
    function exitSpy() {
      const calls = [];
      let resolveExit;
      const exited = new Promise((r) => {
        resolveExit = r;
      });
      return {
        calls,
        exited,
        exit: (code) => {
          calls.push({ code, at: Date.now() });
          resolveExit(code);
        },
      };
    }
    // A stream whose writes complete only when the test releases them.
    function heldStream() {
      const held = [];
      const stream = new Writable({
        write(_chunk, _enc, cb) {
          held.push(cb);
        },
      });
      return { stream, release: () => held.splice(0).forEach((cb) => cb()) };
    }
    const within = (promise, ms, what) => Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${what}: no exit within ${ms} ms`)), ms)),
    ]);

    it('a second call while flushing is ignored: one exit, with the first code', async () => {
      await keepingExitCode(async () => {
        const { exitAfterFlush } = await fresh();
        const { stream, release } = heldStream();
        const first = exitSpy();
        const second = exitSpy();
        exitAfterFlush(3, { streams: [stream], exit: first.exit, fallbackMs: 60_000 });
        exitAfterFlush(9, { streams: [stream], exit: second.exit, fallbackMs: 1 });
        strictEqual(process.exitCode, 3, 'the second call leaves process.exitCode alone');
        await new Promise((r) => setTimeout(r, 50));
        strictEqual(second.calls.length, 0, 'the second call never exits');
        release();
        strictEqual(await within(first.exited, 2000, 'release'), 3);
        await new Promise((r) => setTimeout(r, 20));
        strictEqual(first.calls.length, 1, 'exit is called once');
        strictEqual(second.calls.length, 0);
      });
    });

    it('an \'error\' event on a stream exits at once with the code', async () => {
      await keepingExitCode(async () => {
        const { exitAfterFlush } = await fresh();
        const { stream } = heldStream();
        const spy = exitSpy();
        exitAfterFlush(5, { streams: [stream], exit: spy.exit, fallbackMs: 60_000 });
        stream.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
        strictEqual(await within(spy.exited, 1000, 'error event'), 5);
      });
    });

    it('a write callback reporting an error exits at once, though another stream is still pending', async () => {
      await keepingExitCode(async () => {
        const { exitAfterFlush } = await fresh();
        // Reports the error through the callback only, never as an event.
        const failing = Object.assign(new EventEmitter(), {
          write: (_chunk, cb) => {
            setImmediate(() => cb(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })));
            return false;
          },
        });
        const { stream: stalled } = heldStream();
        const spy = exitSpy();
        exitAfterFlush(6, { streams: [failing, stalled], exit: spy.exit, fallbackMs: 60_000 });
        strictEqual(await within(spy.exited, 1000, 'write callback error'), 6);
      });
    });

    it('an error recorded by absorbOutputErrors before the call exits at once', async () => {
      await keepingExitCode(async () => {
        const { absorbOutputErrors, exitAfterFlush } = await fresh();
        const { stream: broken } = heldStream();
        const { stream: stalled } = heldStream();
        absorbOutputErrors([broken]);
        absorbOutputErrors([broken]);
        strictEqual(broken.listenerCount('error'), 1, 'absorbOutputErrors is idempotent');
        broken.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
        const spy = exitSpy();
        exitAfterFlush(7, { streams: [stalled, broken], exit: spy.exit, fallbackMs: 60_000 });
        strictEqual(await within(spy.exited, 1000, 'recorded error'), 7);
      });
    });

    it('a stream already finished that errors while the other flushes exits at once', async () => {
      await keepingExitCode(async () => {
        const { exitAfterFlush } = await fresh();
        // Not destroyed on finish, so a write after its end emits 'error'.
        const done = new Writable({ autoDestroy: false, write: (_c, _e, cb) => cb() });
        done.end();
        await new Promise((r) => done.once('finish', r));
        const { stream: stalled } = heldStream();
        const spy = exitSpy();
        exitAfterFlush(9, { streams: [done, stalled], exit: spy.exit, fallbackMs: 60_000 });
        done.write('late');
        strictEqual(await within(spy.exited, 1000, 'write after end'), 9);
      });
    });

    it('a destroyed stream needs no flush', async () => {
      await keepingExitCode(async () => {
        const { exitAfterFlush } = await fresh();
        const { stream } = heldStream();
        stream.destroy();
        const spy = exitSpy();
        exitAfterFlush(8, { streams: [stream], exit: spy.exit, fallbackMs: 60_000 });
        strictEqual(await within(spy.exited, 1000, 'destroyed stream'), 8);
      });
    });

    it('an ended stream is waited for until it finishes', async () => {
      await keepingExitCode(async () => {
        const { exitAfterFlush } = await fresh();
        const { stream, release } = heldStream();
        stream.end('payload');
        const spy = exitSpy();
        exitAfterFlush(0, { streams: [stream], exit: spy.exit, fallbackMs: 60_000 });
        await new Promise((r) => setTimeout(r, 50));
        strictEqual(spy.calls.length, 0, 'an ended stream that has not finished is not flushed');
        release();
        strictEqual(await within(spy.exited, 1000, 'finish'), 0);
        ok(stream.writableFinished, 'the exit came after the stream finished');
      });
    });

    it('a stream that never drains: the fallback exits with the code once it fires', async () => {
      await keepingExitCode(async () => {
        const { exitAfterFlush } = await fresh();
        const { stream } = heldStream();
        const spy = exitSpy();
        const started = Date.now();
        exitAfterFlush(4, { streams: [stream], exit: spy.exit, fallbackMs: 200 });
        strictEqual(await within(spy.exited, 5000, 'fallback'), 4);
        ok(spy.calls[0].at - started >= 200, 'not before the fallback');
      });
    });
  });
}
