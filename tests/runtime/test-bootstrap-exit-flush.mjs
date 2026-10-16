// tests/runtime/test-bootstrap-exit-flush.mjs
//
// R2 — the real `bootstrap.mjs` CLI, not the injected runBootstrap of
// test-bootstrap-cli.mjs, ends through exitAfterFlush:
//
//   (i)  a `plan --format json` report past 1 MiB reaches a reader on a pipe
//        whole. `process.exit` right after the write dropped what the pipe had
//        not taken (65,536 of 88,157 bytes on macOS); the report is sized past
//        any pipe or socket buffer so the defect shows on Linux as well.
//   (ii) the CLI still exits when a probe child that ignores SIGTERM outlives
//        its timeout. The runner resolves after SIGTERM without waiting for
//        `close`, so the child's pipes stay live: a tail that only set
//        `process.exitCode` would wait for that child to end.
//
// The report in (i) is a `run-open` refusal: every empty run directory counts
// as an open run with an unreadable manifest (bootstrap-artifacts.mjs), and
// none is an artifact, so the 64 KiB artifact bound is not involved.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const BOOTSTRAP = join(REPO_ROOT, 'plugins', 'runtime', 'scripts', 'bootstrap.mjs');
const SKIP_POSIX = process.platform === 'win32' ? 'POSIX pipes and shell' : false;

// About 41 bytes of report per open run: 26,000 make a report past 1 MiB.
const OPEN_RUNS = 26_000;
const ONE_MIB = 1024 * 1024;
// (i) reads 26,000 run directories, which a loaded CI machine can take a while
// over; (ii) must stay well under the stubborn child's 120 s, so a CLI that
// waits for it is caught.
const REPORT_WATCHDOG_MS = 90_000;
const PROBE_WATCHDOG_MS = 30_000;

// A temporary HOME beside a temporary cwd, never beneath it (a HOME inside
// the cwd is refused `home-is-repo` before any run is read), and a PATH that
// holds only `node` plus whatever the case adds.
// Kills every child whose pid a case recorded under base (*.pid), then removes
// base: one hook, in that order, so no stubborn child outlives the test.
function cleanup(base) {
  for (const name of readdirSync(base)) {
    if (!name.endsWith('.pid')) continue;
    const pid = Number.parseInt(readFileSync(join(base, name), 'utf8'), 10);
    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
  }
  rmSync(base, { recursive: true, force: true });
}

function makeMachine(t) {
  const base = mkdtempSync(join(tmpdir(), 'bootstrap-exit-flush-'));
  t.after(() => cleanup(base));
  const home = join(base, 'home');
  const cwd = join(base, 'cwd');
  const bin = join(base, 'bin');
  for (const dir of [home, cwd, bin]) mkdirSync(dir);
  symlinkSync(process.execPath, join(bin, 'node'));
  return { base, home, cwd, bin };
}

async function runCli({ home, cwd, bin }, argv, watchdogMs) {
  const child = spawn(process.execPath, [BOOTSTRAP, ...argv], {
    cwd,
    env: { HOME: home, PATH: bin },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let timedOut = false;
  const watchdog = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, watchdogMs);
  const out = [];
  const err = [];
  child.stdout.on('data', (c) => out.push(c));
  child.stderr.on('data', (c) => err.push(c));
  const [status, signal] = await once(child, 'exit');
  clearTimeout(watchdog);
  // The exit status is known; collect what the pipes still hold. A child that
  // outlives the CLI keeps nothing of ours open: its stdio is the CLI's own
  // probe pipes, not these.
  await Promise.all([child.stdout, child.stderr].map((s) => (s.closed ? null : once(s, 'close'))));
  return { status, signal, timedOut, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
}

describe('runtime:bootstrap CLI — exit after stdout and stderr flush (R2)', () => {
  it('(i) a plan report past 1 MiB reaches a pipe reader whole and parses', { skip: SKIP_POSIX }, async (t) => {
    const machine = makeMachine(t);
    const runs = join(machine.home, '.agentic-plugins', 'runs', 'bootstrap');
    mkdirSync(runs, { recursive: true });
    for (let i = 0; i < OPEN_RUNS; i += 1) {
      mkdirSync(join(runs, `bootstrap-20260101T000000Z-${i.toString(16).padStart(6, '0')}`));
    }
    const r = await runCli(machine, ['plan', '--format', 'json'], REPORT_WATCHDOG_MS);
    assert.equal(r.timedOut, false, `the watchdog killed bootstrap after ${REPORT_WATCHDOG_MS} ms`);
    assert.equal(r.status, 40, `status ${r.status} (signal ${r.signal}); stderr=${r.stderr.slice(0, 500)}`);
    assert.ok(r.stdout.length > ONE_MIB, `the report reached the pipe with ${r.stdout.length} bytes; the fixture must exceed ${ONE_MIB}`);
    let report;
    assert.doesNotThrow(() => { report = JSON.parse(r.stdout); }, `the report is cut at ${r.stdout.length} bytes`);
    assert.equal(report.status, 'refused');
    assert.equal(report.reason, 'run-open');
    assert.equal(report.open_runs.length, OPEN_RUNS);
    assert.equal(report.findings_omitted, true);
  });

  it('(ii) exits with a whole report while a probe child that ignores SIGTERM outlives its timeout', { skip: SKIP_POSIX }, async (t) => {
    const machine = makeMachine(t);
    const pidFile = join(machine.base, 'claude.pid');
    // The ignored TERM survives `exec`, so the sleep is the child the runner
    // signals after its 5 s probe timeout, and it keeps the probe's pipes open.
    const fake = join(machine.bin, 'claude');
    writeFileSync(fake, `#!/bin/sh\necho $$ > '${pidFile}'\ntrap '' TERM\nexec /bin/sleep 120\n`, 'utf8');
    chmodSync(fake, 0o755);
    const r = await runCli(machine, ['plan', '--format', 'json'], PROBE_WATCHDOG_MS);
    assert.equal(r.timedOut, false, `the watchdog killed bootstrap after ${PROBE_WATCHDOG_MS} ms: the CLI waited for the probe child that ignores SIGTERM`);
    assert.ok(readFileSync(pidFile, 'utf8').trim() !== '', 'the fake claude never ran, so no probe timed out');
    let report;
    assert.doesNotThrow(() => { report = JSON.parse(r.stdout); }, `the report does not parse: ${r.stdout.slice(0, 300)}`);
    assert.equal(report.verb, 'plan');
    assert.ok([0, 10, 20].includes(r.status), `status ${r.status} (signal ${r.signal}); stderr=${r.stderr.slice(0, 500)}`);
  });
});
