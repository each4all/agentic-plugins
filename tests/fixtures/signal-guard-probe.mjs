// tests/fixtures/signal-guard-probe.mjs
//
// The probe tests/test-signal-guard.mjs runs, through `npm test` or through
// the script as it was before tests/_signal-guard.mjs (docket C169). As a test
// of the heavy-work lock did, it reads a pid file between its creation and its
// write, gets 0, and signals it; then -0, and its own group by number. It
// notes what each signal did, and keeps a descendant of its group running
// until `<dir>/go` exists.
//
// Not discovered by `node --test`: the stem `signal-guard-probe` matches none
// of Node's test-file patterns.

import { test } from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { publishPid } from '../_pidfile.mjs';

const dir = process.env.SIGNAL_GUARD_PROBE_DIR;

test('signals read from an empty pid file', async () => {
  const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  publishPid(join(dir, 'descendant'), descendant.pid);
  writeFileSync(join(dir, 'empty'), '');
  const pid = Number(readFileSync(join(dir, 'empty'), 'utf8'));
  const pgid = Number(spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).stdout.trim());
  const results = [];
  for (const target of [pid, -pid, -pgid]) {
    try {
      process.kill(target, 'SIGKILL');
      results.push('sent');
    } catch (e) {
      results.push(e.code ?? e.message);
    }
  }
  // Published at once: written beside it, then renamed over it.
  writeFileSync(join(dir, 'results.json.tmp'), JSON.stringify({ pid, pgid, results }));
  renameSync(join(dir, 'results.json.tmp'), join(dir, 'results.json'));
  while (!existsSync(join(dir, 'go'))) await new Promise((wake) => { setTimeout(wake, 20); });
  descendant.kill('SIGKILL');
});
