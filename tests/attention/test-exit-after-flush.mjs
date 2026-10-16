// tests/attention/test-exit-after-flush.mjs
//
// R2 — the attention package's copy of exitAfterFlush, tested by the shared
// suite, and the three entry points that end through it:
//
//   - discover-runtime.mjs's `unknown flag` diagnostic echoes the flag.
//     `process.exit` right after that stderr write delivered only its first
//     64 KiB to a pipe. The CLI has no args file, so the flag rides in argv:
//     900 KB on macOS (at 1 MB Node itself fails with a stack overflow before
//     the script runs), and just under Linux's 128 KiB cap on one argument.
//     That fits the socket buffer a Node child's stdio gets on Linux, where a
//     bare exit then loses nothing (measured), so stderr goes through a shell
//     pipe instead: a kernel pipe holds 64 KiB, and its reader starts late, so
//     the diagnostic must wait in the pipe on both platforms.
//   - the SessionStart and Stop hooks keep their contract under the new tail:
//     exit 0, nothing on stderr, and nothing on stdout for an empty payload.
//     Both are Claude-only hooks; their output is bounded (one short line at
//     most), so a bare exit loses nothing today and this is behaviour, not a
//     regression.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { defineExitAfterFlushSuite } from '../_exit-after-flush-suite.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const ATTENTION = join(REPO_ROOT, 'plugins', 'attention');
const DISCOVER = join(ATTENTION, 'scripts', 'discover-runtime.mjs');
const SKIP_POSIX = process.platform === 'win32' ? 'POSIX pipes' : false;
const WATCHDOG_MS = 30_000;

defineExitAfterFlushSuite({
  label: 'attention scripts/lib/exit-after-flush.mjs',
  modulePath: join(ATTENTION, 'scripts', 'lib', 'exit-after-flush.mjs'),
});

// Runs `script` with node, or `command` itself when given.
async function run(script, argv, { stdin = '', command } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'attention-exit-flush-'));
  try {
    const child = spawn(command ?? process.execPath, command ? argv : [script, ...argv], {
      cwd: home,
      env: { HOME: home, PATH: '/usr/bin:/bin', CODEX_HOME: join(home, '.codex') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let timedOut = false;
    const watchdog = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, WATCHDOG_MS);
    const out = [];
    const err = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.stdin.end(stdin);
    const [status, signal] = await once(child, 'close');
    clearTimeout(watchdog);
    assert.equal(timedOut, false, `the watchdog killed ${script ?? command} after ${WATCHDOG_MS} ms`);
    return { status, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

describe('attention discover-runtime.mjs CLI — exit after stdout and stderr flush (R2)', () => {
  const FLAG = `--${'x'.repeat(process.platform === 'linux' ? 131_000 : 900_000)}`;

  it('the unknown-flag diagnostic reaches a late pipe reader whole', { skip: SKIP_POSIX }, async () => {
    // The CLI's stderr is a shell pipe whose reader sleeps first; stdout goes
    // to /dev/null, and the CLI's own status is written to a file.
    const home = mkdtempSync(join(tmpdir(), 'attention-exit-flush-'));
    try {
      const statusFile = join(home, 'status');
      const r = await run(null, [
        '-c',
        '{ "$0" "$1" discover "$2" 2>&1 >/dev/null; echo $? > "$3"; } | { sleep 0.5; cat; }',
        process.execPath, DISCOVER, FLAG, statusFile,
      ], { command: '/bin/sh' });
      assert.equal(r.status, 0, `the shell failed: ${r.stderr.slice(0, 300)}`);
      assert.equal(readFileSync(statusFile, 'utf8').trim(), '2', 'discover-runtime did not exit 2');
      const expected = `discover-runtime.mjs: unknown flag ${FLAG}\n`;
      assert.equal(r.stdout.length, expected.length, `stderr arrived with ${r.stdout.length} bytes`);
      assert.ok(r.stdout === expected, 'stderr arrived altered');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('--help exits 0 with the usage on stdout', async () => {
    const r = await run(DISCOVER, ['--help']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^plugins\/attention\/scripts\/discover-runtime\.mjs\n/);
    assert.equal(r.stderr, '');
  });
});

describe('attention Claude hooks — exit 0, silent, under exitAfterFlush (R2)', () => {
  for (const hook of ['session-start.mjs', 'stop.mjs']) {
    it(`${hook} with an empty payload exits 0 and writes nothing`, async () => {
      const r = await run(join(ATTENTION, 'adapters', 'claude', 'hooks', hook), [], { stdin: '{}' });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '');
      assert.equal(r.stderr, '');
    });

    it(`${hook} with malformed stdin exits 0 and writes nothing`, async () => {
      const r = await run(join(ATTENTION, 'adapters', 'claude', 'hooks', hook), [], { stdin: '{not json' });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, '');
      assert.equal(r.stderr, '');
    });
  }
});
