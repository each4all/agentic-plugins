// tests/runtime/test-doctor-settings-exit-flush.mjs
//
// R2 — runtime:doctor and runtime:settings end through exitAfterFlush, and
// their mid-function exits became returns of the code.
//
//   - A usage error echoes the offending argument. `process.exit` right after
//     that stderr write delivered only its first 64 KiB to a pipe; an argument
//     of about 1 MB, passed through an args file (one argv word is capped at
//     128 KiB on Linux), is past any pipe or socket buffer.
//   - Nothing runs after help or a refusal: help beside proof, apply and
//     execute flags, and a usage error after them, start no host CLI and
//     write nothing.
//   - settings no longer waits for every live handle, so a plugin-management
//     or cleanup command still running after its timeout and SIGTERM is
//     reported as such (not retryable, with its pid, one follow-up per host)
//     instead of being invited to a retry that could race it. Its host gets
//     no further plugin-management or cleanup command in that run, and no
//     plan, recommendation or follow-up of the report offers a command to run
//     on that host until the command has exited. The CLI
//     still waits for that command after its report, or after a failure:
//     exiting would close its pipes and cut it short at its next write.
//
// The CLIs' existing exit-code and report cases stay in test-doctor-exit.mjs
// and test-settings.mjs.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, existsSync, mkdirSync,mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { runCommand } from '../../plugins/runtime/scripts/doctor.mjs';
import { formatText, runSettings } from '../../plugins/runtime/scripts/settings.mjs';
import {
  buildPluginCleanupManualFollowups,
  buildPluginManagementManualFollowups,
  busyHostsOf,
  holdCommandsOnBusyHosts,
} from '../../plugins/runtime/scripts/lib/plugin-management-plan.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const DOCTOR = join(REPO_ROOT, 'plugins', 'runtime', 'scripts', 'doctor.mjs');
const SETTINGS = join(REPO_ROOT, 'plugins', 'runtime', 'scripts', 'settings.mjs');
const SKIP_POSIX = process.platform === 'win32' ? 'POSIX pipes and shell' : false;
const WATCHDOG_MS = 30_000;
// Under the args file's 1 MiB limit with its JSON wrapper.
const LONG_ARGUMENT = `--${'x'.repeat(1_000_000)}`;

// A HOME and a cwd side by side, and a PATH holding `node` plus a `claude` and
// a `codex` that leave a marker when anything starts them.
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
  const base = mkdtempSync(join(tmpdir(), 'runtime-exit-flush-'));
  t.after(() => cleanup(base));
  const home = join(base, 'home');
  const cwd = join(base, 'cwd');
  const bin = join(base, 'bin');
  const markers = join(base, 'markers');
  for (const dir of [home, cwd, bin, markers]) mkdirSync(dir);
  symlinkSync(process.execPath, join(bin, 'node'));
  for (const name of ['claude', 'codex']) {
    writeFileSync(join(bin, name), `#!/bin/sh\n: > '${join(markers, name)}'\nexit 1\n`, 'utf8');
    chmodSync(join(bin, name), 0o755);
  }
  return { base, home, cwd, bin, markers };
}

// `close` names a stream the parent closes at once (the reader went away);
// `onStdout` sees each stdout chunk as it arrives.
async function runCli(script, machine, argv, { close, onStdout } = {}) {
  const child = spawn(process.execPath, [script, ...argv], {
    cwd: machine.cwd,
    env: { HOME: machine.home, PATH: machine.bin, TMPDIR: tmpdir() },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (close) child[close].destroy();
  let timedOut = false;
  const watchdog = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, WATCHDOG_MS);
  const out = [];
  const err = [];
  child.stdout.on('data', (c) => { onStdout?.(c); out.push(c); });
  child.stderr.on('data', (c) => err.push(c));
  const [status, signal] = await once(child, 'close');
  clearTimeout(watchdog);
  assert.equal(timedOut, false, `the watchdog killed ${script} after ${WATCHDOG_MS} ms`);
  return { status, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
}

function argsFile(machine, text) {
  const file = join(machine.base, 'args.json');
  writeFileSync(file, `${JSON.stringify({ agentic_args: 1, text })}\n`, 'utf8');
  return file;
}

// Every path under the directories, with each file's size and mtime: what a
// run that did any work would change.
function tree(...roots) {
  const rows = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) { rows.push(`${p}/`); walk(p); } else { const s = statSync(p); rows.push(`${p} ${s.size} ${s.mtimeMs}`); }
    }
  };
  for (const root of roots) walk(root);
  return rows.sort();
}

function assertNoWork(machine, before) {
  assert.deepEqual(readdirSync(machine.markers), [], 'a host CLI was started');
  assert.deepEqual(tree(machine.home, machine.cwd), before, 'the run wrote to HOME or the repository');
}

for (const { label, script } of [{ label: 'runtime:doctor', script: DOCTOR }, { label: 'runtime:settings', script: SETTINGS }]) {
  describe(`${label} CLI — exit after stdout and stderr flush (R2)`, () => {
    it('a usage error echoing a 1 MB argument reaches a pipe reader whole', { skip: SKIP_POSIX }, async (t) => {
      const machine = makeMachine(t);
      const r = await runCli(script, machine, ['--args-file', argsFile(machine, LONG_ARGUMENT)]);
      assert.equal(r.status, 2, `status ${r.status} (signal ${r.signal})`);
      assert.equal(r.stdout, '');
      assert.ok(r.stderr.startsWith(`Unknown argument: ${LONG_ARGUMENT}\n`), `stderr arrived with ${r.stderr.length} bytes`);
      assert.match(r.stderr, /Usage:[\s\S]*\n$/, 'the usage block after the argument is cut');
    });
  });
}

describe('runtime:doctor CLI — nothing runs after help or a refusal (R2)', () => {
  const PROOF_FLAGS = ['--deep-peer-smoke', '--execute-deep-peer-smoke', '--permission-proof', '--execute-permission-proof', '--record'];

  it('--help beside proof and record flags prints the usage, exits 0, starts nothing and writes nothing', { skip: SKIP_POSIX }, async (t) => {
    const machine = makeMachine(t);
    const before = tree(machine.home, machine.cwd);
    const r = await runCli(DOCTOR, machine, [...PROOF_FLAGS, '--help', '--repo-root', machine.cwd]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Usage:/);
    assertNoWork(machine, before);
  });

  it('a usage error after proof and record flags exits 2, starts nothing and writes nothing', { skip: SKIP_POSIX }, async (t) => {
    const machine = makeMachine(t);
    const before = tree(machine.home, machine.cwd);
    const r = await runCli(DOCTOR, machine, [...PROOF_FLAGS, '--repo-root', machine.cwd, '--bogus']);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(r.stdout, '');
    assertNoWork(machine, before);
  });

  it('an unreadable repo root exits 2, starts nothing and writes nothing', { skip: SKIP_POSIX }, async (t) => {
    const machine = makeMachine(t);
    const before = tree(machine.home, machine.cwd);
    const r = await runCli(DOCTOR, machine, [...PROOF_FLAGS, '--repo-root', join(machine.base, 'absent')]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /^repo root is not readable/);
    assertNoWork(machine, before);
  });
});

describe('runtime:settings CLI — nothing runs after help or a refusal (R2)', () => {
  // Each set is one runSettings accepts on its own (attestation cannot share a
  // run with execution), so help falling through would do its work.
  const APPLY_FLAGS = ['--apply', '--target', 'both', '--execute-plugin-management', '--execute-plugin-cleanup'];
  const ATTEST_FLAGS = ['--apply', '--target', 'both', '--attest-codex-hook-review'];

  for (const [name, flags] of [['apply and execute', APPLY_FLAGS], ['apply and attestation', ATTEST_FLAGS]]) {
    it(`--help beside ${name} flags prints the usage, exits 0, starts nothing and writes nothing`, { skip: SKIP_POSIX }, async (t) => {
      const machine = makeMachine(t);
      const before = tree(machine.home, machine.cwd);
      const r = await runCli(SETTINGS, machine, [...flags, '--help', '--repo-root', machine.cwd]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^Usage:/);
      assertNoWork(machine, before);
    });
  }

  it('a usage error after apply and execute flags exits 2, starts nothing and writes nothing', { skip: SKIP_POSIX }, async (t) => {
    const machine = makeMachine(t);
    const before = tree(machine.home, machine.cwd);
    const r = await runCli(SETTINGS, machine, [...APPLY_FLAGS, '--repo-root', machine.cwd, '--bogus']);
    assert.equal(r.status, 2, r.stderr);
    assert.equal(r.stdout, '');
    assertNoWork(machine, before);
  });

  it('an unreadable repo root exits 2, starts nothing and writes nothing', { skip: SKIP_POSIX }, async (t) => {
    const machine = makeMachine(t);
    const before = tree(machine.home, machine.cwd);
    const r = await runCli(SETTINGS, machine, [...APPLY_FLAGS, '--repo-root', join(machine.base, 'absent')]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /^repo root is not readable/);
    assertNoWork(machine, before);
  });
});

describe('runCommand — a mutating command still running after its timeout (R2)', () => {
  // A child that ignores SIGTERM: the ignored TERM survives `exec`.
  const stubborn = (pidFile) => ['-c', `echo $$ > '${pidFile}'; trap '' TERM; exec /bin/sleep 60`];

  it('with closeGraceMs, reports the child still running and its pid once the grace passes', { skip: SKIP_POSIX }, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'runtime-run-command-'));
    const pidFile = join(dir, 'pid');
    t.after(() => {
      try { process.kill(readPid(pidFile), 'SIGKILL'); } catch { /* gone */ }
      rmSync(dir, { recursive: true, force: true });
    });
    const started = Date.now();
    const result = await runCommand('/bin/sh', stubborn(pidFile), { timeoutMs: 300, closeGraceMs: 300 });
    assert.ok(Date.now() - started < 10_000, 'runCommand waited for the child instead of the grace');
    assert.equal(result.timed_out, true);
    assert.equal(result.child_running, true);
    assert.equal(result.child_pid, readPid(pidFile));
    // The caller waits on `closed`; it never reaches a report.
    assert.equal(Object.keys(result).includes('closed'), false, 'closed is enumerable');
    let closed = false;
    result.closed.then(() => { closed = true; });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(closed, false, 'closed resolved while the child still runs');
    process.kill(result.child_pid, 'SIGKILL');
    await result.closed;
  });

  it('with closeGraceMs, reports the child gone when it closes within the grace', { skip: SKIP_POSIX }, async () => {
    const result = await runCommand('/bin/sleep', ['60'], { timeoutMs: 300, closeGraceMs: 5_000 });
    assert.equal(result.timed_out, true);
    assert.equal(result.child_running, false);
  });

  it('without closeGraceMs (a read-only probe), resolves at the timeout and adds nothing', { skip: SKIP_POSIX }, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'runtime-run-command-'));
    const pidFile = join(dir, 'pid');
    t.after(() => {
      try { process.kill(readPid(pidFile), 'SIGKILL'); } catch { /* gone */ }
      rmSync(dir, { recursive: true, force: true });
    });
    const result = await runCommand('/bin/sh', stubborn(pidFile), { timeoutMs: 300 });
    assert.equal(result.timed_out, true);
    assert.equal('child_running' in result, false);
  });
});

// The pid the stubborn child wrote before it set its trap; NaN when it never ran.
function readPid(file) {
  try { return Number.parseInt(readFileSync(file, 'utf8'), 10); } catch { return Number.NaN; }
}

describe('runtime:settings — a plugin-management command still running is not retryable (R2)', () => {
  it('reports the live child and its pid, not retryable, and passes the close grace only to the mutating command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-live-child-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-live-child-home-'));
    for (const name of ['companions', 'engineer', 'orchestrator', 'runtime']) {
      mkdirSync(join(root, 'plugins', name, '.claude-plugin'), { recursive: true });
      writeFileSync(join(root, 'plugins', name, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version: '1.0.0', description: name }));
    }
    const MUTATING = 'codex plugin marketplace add each4all/agentic-plugins';
    const graces = {};
    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      now: new Date('2026-10-16T00:00:00.000Z'),
      runId: 'settings-20261016T000000Z-abcdef',
      executePluginManagement: true,
      pluginManagementHost: 'codex',
      runner: async (command, args, opts = {}) => {
        const key = `${command} ${args.join(' ')}`;
        graces[key] = opts.closeGraceMs;
        if (key === MUTATING) {
          return { ok: false, exit_code: null, stdout: '', stderr: '', error_code: 'ETIMEDOUT', timed_out: true, child_running: true, child_pid: 4242 };
        }
        if (key === 'codex --version') return { ok: true, exit_code: 0, stdout: 'codex-cli 0.137.0\n', stderr: '', error_code: null, timed_out: false };
        return { ok: false, exit_code: null, stdout: '', stderr: '', error_code: 'ENOENT', error_message: `spawn ${command} ENOENT`, timed_out: false };
      },
    });
    const failed = report.plugin_management.plans.find((plan) => plan.command === MUTATING);
    assert.ok(failed, `no plan ran ${MUTATING}`);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.result.failure_type, 'timeout_child_running');
    assert.equal(failed.result.retryable, false);
    assert.equal(failed.result.child_running, true);
    assert.equal(failed.result.child_pid, 4242);
    assert.match(failed.result.retry_after, /wait for pid 4242 .*re-run runtime:doctor/);
    assert.equal(report.plugin_management.summary.failed_retryable, 0);
    assert.match(formatText(report), /still-running: pid=4242/);
    // The follow-up names the pid to wait for and offers nothing to re-run.
    const followup = report.plugin_management.manual_followups.find((item) => item.id === 'codex-plugin-management-command-still-running');
    assert.ok(followup, 'no follow-up names the command still running');
    assert.deepEqual(followup.pids, [4242]);
    assert.deepEqual(followup.commands, []);
    assert.match(followup.verify, /^Wait for pid 4242 .*re-run runtime:doctor before retrying/);
    assert.equal(graces[MUTATING], 5000, 'the mutating command ran without the close grace');
    for (const [key, grace] of Object.entries(graces)) {
      if (key !== MUTATING) assert.equal(grace, undefined, `the read-only probe ${key} got a close grace`);
    }
  });

  it('with --host all, keeps one still-running follow-up per host in the merged report', async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-settings-live-children-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'runtime-settings-live-children-home-'));
    t.after(() => {
      rmSync(root, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    });
    for (const name of ['companions', 'engineer', 'orchestrator', 'runtime']) {
      mkdirSync(join(root, 'plugins', name, '.claude-plugin'), { recursive: true });
      writeFileSync(join(root, 'plugins', name, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version: '1.0.0', description: name }));
    }
    const ok = (stdout) => ({ ok: true, exit_code: 0, stdout, stderr: '', error_code: null, timed_out: false });
    const probes = {
      'claude --version': ok('2.1.140 (Claude Code)\n'),
      'claude plugin --help': ok('Commands:\n  install\n  list\n  update\n  uninstall\n'),
      'claude plugin list': ok('No plugins installed.\n'),
      'codex --version': ok('codex-cli 0.137.0\n'),
    };
    const pids = { claude: [], codex: [] };
    let nextPid = 5000;
    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      now: new Date('2026-10-16T00:00:00.000Z'),
      runId: 'settings-20261016T000000Z-abcdef',
      executePluginManagement: true,
      pluginManagementHost: 'all',
      runner: async (command, args, opts = {}) => {
        // Every mutating command (the ones given a close grace) is still running.
        if (opts.closeGraceMs !== undefined) {
          const pid = nextPid++;
          pids[command].push(pid);
          return { ok: false, exit_code: null, stdout: '', stderr: '', error_code: 'ETIMEDOUT', timed_out: true, child_running: true, child_pid: pid };
        }
        return probes[`${command} ${args.join(' ')}`]
          ?? { ok: false, exit_code: null, stdout: '', stderr: '', error_code: 'ENOENT', error_message: `spawn ${command} ENOENT`, timed_out: false };
      },
    });
    assert.ok(pids.claude.length > 0 && pids.codex.length > 0, `both hosts ran a mutating command: ${JSON.stringify(pids)}`);
    const running = report.plugin_management.manual_followups.filter((item) => item.id.endsWith('-command-still-running'));
    assert.deepEqual(running.map((item) => [item.id, item.host, item.pids]), [
      ['claude-plugin-management-command-still-running', 'claude', pids.claude],
      ['codex-plugin-management-command-still-running', 'codex', pids.codex],
    ]);
  });
});

// A Claude host with agentic-plugins plugins to install and two retired entries
// to uninstall, so both executors have more than one Claude command to run.
async function liveChildMachine(t, label) {
  const root = await mkdtemp(join(tmpdir(), `runtime-settings-${label}-repo-`));
  const home = await mkdtemp(join(tmpdir(), `runtime-settings-${label}-home-`));
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  for (const name of ['companions', 'engineer', 'orchestrator', 'runtime']) {
    mkdirSync(join(root, 'plugins', name, '.claude-plugin'), { recursive: true });
    writeFileSync(join(root, 'plugins', name, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version: '1.0.0', description: name }));
  }
  const ok = (stdout) => ({ ok: true, exit_code: 0, stdout, stderr: '', error_code: null, timed_out: false });
  const retired = (name) => [`  > ${name}@agentic-plugins`, '    Version: 0.1.0', '    Scope: user', '    Status: failed', `    Error: Plugin ${name} not found in marketplace agentic-plugins`];
  const probes = {
    'claude --version': ok('2.1.140 (Claude Code)\n'),
    'claude plugin --help': ok('Commands:\n  install\n  list\n  update\n  uninstall\n'),
    'claude plugin list': ok(['Installed plugins:', '', ...retired('research'), '', ...retired('legacy-probe'), ''].join('\n')),
    'codex --version': ok('codex-cli 0.137.0\n'),
  };
  const probe = (command, args) => probes[`${command} ${args.join(' ')}`]
    ?? { ok: false, exit_code: null, stdout: '', stderr: '', error_code: 'ENOENT', error_message: `spawn ${command} ENOENT`, timed_out: false };
  return { root, home, probe };
}

const stillRunningResult = (pid) => ({ ok: false, exit_code: null, stdout: '', stderr: '', error_code: 'ETIMEDOUT', timed_out: true, child_running: true, child_pid: pid });

describe('runtime:settings — a host whose command is still running gets no further command (R2)', () => {
  it('blocks the host\'s remaining plugin-management and cleanup commands, journals them, and offers none for a re-run', async (t) => {
    const { root, home, probe } = await liveChildMachine(t, 'busy-host');
    const RUN_ID = 'settings-20261016T000000Z-abcdef';
    const started = [];
    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      now: new Date('2026-10-16T00:00:00.000Z'),
      runId: RUN_ID,
      executePluginManagement: true,
      pluginManagementHost: 'all',
      executePluginCleanup: true,
      runner: async (command, args, opts = {}) => {
        if (opts.closeGraceMs === undefined) return probe(command, args);
        const key = `${command} ${args.join(' ')}`;
        started.push(key);
        // The first Claude command is still running; any later one ends.
        if (command === 'claude' && started.filter((k) => k.startsWith('claude ')).length === 1) return stillRunningResult(6001);
        return { ok: true, exit_code: 0, stdout: '', stderr: '', error_code: null, timed_out: false };
      },
    });
    const claudeStarted = started.filter((key) => key.startsWith('claude '));
    assert.equal(claudeStarted.length, 1, `Claude commands started while the first was still running: ${JSON.stringify(claudeStarted)}`);
    assert.ok(started.some((key) => key.startsWith('codex ')), 'the other host\'s commands were blocked too');

    const behind = (plans) => plans.filter((plan) => plan.status === 'blocked' && plan.block_reason === 'host-command-still-running');
    const management = behind(report.plugin_management.plans);
    const cleanup = behind(report.plugin_cleanup.plans);
    assert.ok(management.length >= 1, 'no further plugin-management plan on the host was blocked');
    assert.equal(cleanup.length, 2, `cleanup plans: ${JSON.stringify(report.plugin_cleanup.plans.map((plan) => [plan.plugin, plan.status]))}`);
    for (const plan of [...management, ...cleanup]) {
      assert.equal(plan.host, 'claude');
      assert.equal(plan.executed, false);
      assert.deepEqual(plan.blocked_by_pids, [6001]);
      assert.match(plan.next_step, /^Wait for pid 6001 .*re-run runtime:doctor before retrying/);
    }

    const followups = report.plugin_management.manual_followups;
    const managementFollowup = followups.find((item) => item.id === 'claude-plugin-management-command-still-running');
    assert.deepEqual(managementFollowup?.pids, [6001]);
    assert.deepEqual(managementFollowup.not_started, management.map((plan) => plan.id));
    const cleanupFollowup = followups.find((item) => item.id === 'claude-plugin-cleanup-command-still-running');
    assert.ok(cleanupFollowup, 'no follow-up names the cleanup commands not started');
    assert.deepEqual(cleanupFollowup.pids, [6001]);
    assert.equal(cleanupFollowup.not_started.length, 2);
    // An uninstall not started is listed there once, not again as a cleanup
    // that could not be completed.
    assert.equal(followups.find((item) => item.id === 'claude-retired-plugin-cleanup'), undefined);
    // Nothing offers a Claude command to run while pid 6001 still runs.
    const offered = followups.flatMap((item) => item.commands ?? []).filter((command) => command.startsWith('claude '));
    assert.deepEqual(offered, []);

    // The write-ahead journal records each plan that was not started.
    const artifact = JSON.parse(readFileSync(join(root, '.agentic-plugins', 'runs', 'settings', RUN_ID, 'settings.json'), 'utf8'));
    const journaled = artifact.journal.filter((entry) => entry.host === 'claude' && entry.status === 'blocked');
    assert.equal(journaled.length, management.length + cleanup.length);
  });

  it('a Codex install not started behind a running command is not read as a policy block', () => {
    const followups = buildPluginManagementManualFollowups([{
      id: 'engineer:codex:install-plugin',
      plugin: 'engineer',
      host: 'codex',
      action: 'install-plugin',
      status: 'blocked',
      block_reason: 'host-command-still-running',
      blocked_by_pids: [6002],
      command: 'codex plugin add engineer@agentic-plugins',
    }]);
    assert.deepEqual(followups.map((item) => item.id), ['codex-plugin-management-command-still-running']);
    assert.deepEqual(followups[0].pids, [6002]);
    assert.deepEqual(followups[0].not_started, ['engineer:codex:install-plugin']);
    assert.deepEqual(followups[0].commands, []);
    assert.match(followups[0].reason, /^An earlier codex command of this run timed out/);
  });
});

// What the operator may run now is decided per host: on a host whose command
// is still running, nothing the report offers names a command to run, from
// whichever plan, area or follow-up it came.
describe('runtime:settings — no command is offered on a host whose command is still running (R2)', () => {
  const OK = { ok: true, exit_code: 0, stdout: '', stderr: '', error_code: null, timed_out: false };
  const textOffers = (text, host) => text.split('\n').filter((line) => new RegExp(`(?:^|[ ;])command[=:] ?${host} plugin `).test(line));

  it('holds every Claude command (plans, recommendations, follow-ups, text) and leaves the other host\'s', async (t) => {
    const { root, home, probe } = await liveChildMachine(t, 'busy-host-offers');
    let claudeStarted = 0;
    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      now: new Date('2026-10-16T00:00:00.000Z'),
      runId: 'settings-20261016T000000Z-abcdef',
      // Cleanup is not requested: its dry-run plans and follow-up are held too.
      executePluginManagement: true,
      pluginManagementHost: 'all',
      runner: async (command, args, opts = {}) => {
        if (opts.closeGraceMs === undefined) return probe(command, args);
        if (command === 'claude' && ++claudeStarted === 1) return stillRunningResult(6001);
        return OK;
      },
    });
    const claudePlans = [...report.plugin_management.plans, ...report.plugin_cleanup.plans].filter((plan) => plan.host === 'claude');
    assert.ok(claudePlans.some((plan) => plan.result?.child_running === true), 'no Claude plan is still running');
    assert.ok(report.plugin_cleanup.plans.length === 2 && report.plugin_cleanup.plans.every((plan) => plan.executed === false), 'cleanup ran');
    for (const plan of claudePlans) {
      assert.deepEqual(plan.held_by_pids, [6001], `${plan.id ?? plan.plugin}: not held`);
      assert.match(plan.next_step, /^Wait for pid 6001 .*re-run runtime:doctor before retrying\.$/, `${plan.id ?? plan.plugin}: ${plan.next_step}`);
    }

    const claudeRecommendations = [
      ...Object.values(report.plugins).flatMap((plugin) => plugin.recommendations),
      ...report.recommendations.filter((item) => ['plugin', 'plugin-cleanup'].includes(item.area)),
    ].filter((item) => item.host === 'claude');
    assert.ok(claudeRecommendations.some((item) => item.area === 'plugin-cleanup'), 'no top-level cleanup recommendation');
    for (const item of claudeRecommendations) {
      assert.equal(item.command, null, `${item.action}: offers ${item.command}`);
      assert.equal(item.argv, null, `${item.action}: offers argv ${JSON.stringify(item.argv)}`);
      assert.equal(item.executable, false);
      assert.deepEqual(item.held_by_pids, [6001]);
      assert.match(item.next_step, /^Wait for pid 6001 /);
    }
    assert.ok(claudeRecommendations.some((item) => item.held_command === 'claude plugin uninstall research@agentic-plugins'));

    const followups = report.plugin_management.manual_followups;
    assert.deepEqual(followups.filter((item) => item.host === 'claude').flatMap((item) => item.commands), []);
    const cleanupFollowup = followups.find((item) => item.id === 'claude-retired-plugin-cleanup');
    assert.deepEqual(cleanupFollowup?.held_commands, ['claude plugin uninstall research@agentic-plugins', 'claude plugin uninstall legacy-probe@agentic-plugins']);
    assert.deepEqual(cleanupFollowup.held_by_pids, [6001]);
    assert.match(cleanupFollowup.verify, /^Wait for pid 6001 .* Then: Re-run runtime:settings/);

    const text = formatText(report);
    assert.deepEqual(textOffers(text, 'claude'), [], 'the text output offers a Claude command');
    assert.match(text, /held-command: claude plugin uninstall research@agentic-plugins/);
    // The other host is not busy: its commands stay on offer.
    assert.ok(report.recommendations.some((item) => item.host === 'codex' && item.command === 'codex plugin marketplace add each4all/agentic-plugins' && !item.held_by_pids));
    assert.notDeepEqual(textOffers(text, 'codex'), []);
  });

  it('does not offer an earlier failed uninstall again while a later one is still running', async (t) => {
    const { root, home, probe } = await liveChildMachine(t, 'busy-host-failed-sibling');
    let uninstalls = 0;
    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      now: new Date('2026-10-16T00:00:00.000Z'),
      runId: 'settings-20261016T000000Z-abcdef',
      executePluginCleanup: true,
      runner: async (command, args, opts = {}) => {
        if (!`${command} ${args.join(' ')}`.startsWith('claude plugin uninstall ')) return probe(command, args);
        // The first uninstall fails and ends; the second is still running.
        return ++uninstalls === 1 ? { ...OK, ok: false, exit_code: 1, stderr: 'boom' } : stillRunningResult(7002);
      },
    });
    assert.equal(uninstalls, 2);
    const [failed, running] = report.plugin_cleanup.plans;
    assert.equal(failed.status, 'failed');
    assert.equal(failed.result.child_running, false);
    assert.equal(running.result.child_running, true);
    const cleanupFollowup = report.plugin_management.manual_followups.find((item) => item.id === 'claude-retired-plugin-cleanup');
    assert.deepEqual(cleanupFollowup?.commands, []);
    assert.deepEqual(cleanupFollowup.held_commands, ['claude plugin uninstall research@agentic-plugins']);
    assert.deepEqual(cleanupFollowup.held_by_pids, [7002]);
    assert.match(failed.next_step, /^Wait for pid 7002 /);
    assert.deepEqual(textOffers(formatText(report), 'claude'), []);
  });

  it('holds a Codex install-policy follow-up while another Codex command is still running', () => {
    const plans = [
      { id: 'engineer:codex:install-plugin', plugin: 'engineer', host: 'codex', action: 'install-plugin', status: 'failed', command: 'codex plugin add engineer@agentic-plugins', result: { child_running: true, child_pid: 6003 } },
      { id: 'founder:codex:install-plugin', plugin: 'founder', host: 'codex', action: 'install-plugin', status: 'blocked', block_reason: 'install-policy-not-available', command: 'codex plugin add founder@agentic-plugins' },
      { id: 'founder:claude:install-plugin', plugin: 'founder', host: 'claude', action: 'install-plugin', status: 'blocked', reason: 'claude plugin CLI is unavailable', argv: { command: 'claude', args: ['plugin', 'install', 'founder@agentic-plugins'] } },
    ];
    const followups = buildPluginManagementManualFollowups(plans);
    holdCommandsOnBusyHosts({ busyHosts: busyHostsOf([{ host: 'codex', pid: 6003, closed: Promise.resolve() }]), plans, followups });
    const policy = followups.find((item) => item.id === 'codex-install-policy-blocked');
    assert.deepEqual(policy?.commands, []);
    assert.deepEqual(policy.held_commands, ['codex plugin add founder@agentic-plugins']);
    assert.match(policy.verify, /^Wait for pid 6003 .* Then: Resolve the policy condition/);
    assert.match(plans[1].next_step, /^Wait for pid 6003 /);
    // The Claude host is not busy: its follow-up keeps its command.
    assert.deepEqual(followups.find((item) => item.id === 'claude-plugin-surface-unavailable')?.commands, ['claude plugin install founder@agentic-plugins']);
    assert.equal(plans[2].held_by_pids, undefined);
  });
});

describe('runtime:settings — the cleanup executor\'s command still running (R2)', () => {
  it('gives the uninstall the close grace, reports it still running, and starts no further uninstall', async (t) => {
    const { root, home, probe } = await liveChildMachine(t, 'cleanup-live-child');
    const graces = [];
    const report = await runSettings({
      repoRoot: root,
      homeDir: home,
      now: new Date('2026-10-16T00:00:00.000Z'),
      runId: 'settings-20261016T000000Z-abcdef',
      executePluginCleanup: true,
      runner: async (command, args, opts = {}) => {
        const key = `${command} ${args.join(' ')}`;
        if (!key.startsWith('claude plugin uninstall ')) return probe(command, args);
        graces.push([key, opts.closeGraceMs]);
        return graces.length === 1 ? stillRunningResult(7001) : { ok: true, exit_code: 0, stdout: '', stderr: '', error_code: null, timed_out: false };
      },
    });
    assert.equal(graces.length, 1, `uninstalls started while the first was still running: ${JSON.stringify(graces)}`);
    assert.equal(graces[0][1], 5000, 'the uninstall ran without the close grace');
    const [first, second] = report.plugin_cleanup.plans;
    assert.equal(first.status, 'failed');
    assert.equal(first.result.child_running, true);
    assert.equal(first.result.child_pid, 7001);
    assert.equal(first.result.failure_type, 'timeout_child_running');
    assert.equal(second.status, 'blocked');
    assert.equal(second.block_reason, 'host-command-still-running');
    assert.match(formatText(report), /Plugin Cleanup[\s\S]*still-running: pid=7001/);
    const followup = report.plugin_management.manual_followups.find((item) => item.id === 'claude-plugin-cleanup-command-still-running');
    assert.deepEqual(followup?.pids, [7001]);
    assert.deepEqual(followup.commands, []);
  });
});

// The real CLI with a fake `codex` whose `plugin marketplace add` ignores
// SIGTERM and keeps writing to stdout past the timeout and the 5 s close grace,
// then leaves a done file. Exiting once the report flushed would close the
// read end of its stdout, and its next write would kill it (EPIPE / SIGPIPE).
// A reader that closes the CLI's stdout or stderr must not end that wait
// either: an unhandled EPIPE would exit the CLI and cut the command short.
describe('runtime:settings CLI — waits for a mutating command still running after its report (R2)', () => {
  const MARKETPLACE_ADD = 'codex plugin marketplace add each4all/agentic-plugins';

  // `breakJournal`: the command also replaces the run's artifact directory with
  // a file, so the journal write after it fails and runSettings rejects (a
  // failure that holds for root too, unlike a permission).
  function stubbornMarketplaceAdd(machine, { breakJournal = false } = {}) {
    for (const name of ['companions', 'engineer', 'orchestrator', 'runtime']) {
      mkdirSync(join(machine.cwd, 'plugins', name, '.claude-plugin'), { recursive: true });
      writeFileSync(join(machine.cwd, 'plugins', name, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version: '1.0.0', description: name }));
    }
    const pidFile = join(machine.base, 'codex.pid');
    const doneFile = join(machine.base, 'codex.done');
    const runs = join(machine.cwd, '.agentic-plugins', 'runs', 'settings');
    writeFileSync(join(machine.bin, 'codex'), [
      '#!/bin/sh',
      'if [ "$1" = --version ]; then echo "codex-cli 0.137.0"; exit 0; fi',
      'if [ "$1 $2 $3" = "plugin marketplace add" ]; then',
      "  trap '' TERM",
      `  echo $$ > '${pidFile}'`,
      ...(breakJournal ? [`  for d in '${runs}'/settings-*; do /bin/rm -rf "$d"; : > "$d"; done`] : []),
      '  i=0',
      '  while [ $i -lt 50 ]; do echo tick; /bin/sleep 0.2; i=$((i+1)); done',
      `  : > '${doneFile}'`,
      '  exit 0',
      'fi',
      'exit 1',
      '',
    ].join('\n'), 'utf8');
    return { pidFile, doneFile };
  }

  const ARGV = (machine) => [
    '--execute-plugin-management', '--plugin-management-host', 'codex', '--plugin-management-timeout-ms', '2000',
    '--format', 'json', '--repo-root', machine.cwd,
  ];

  function assertReportsStillRunning(stdout, pidFile) {
    const report = JSON.parse(stdout);
    const plan = report.plugin_management.plans.find((p) => p.command === MARKETPLACE_ADD && p.status === 'failed');
    assert.ok(plan, 'the marketplace add did not run, or did not time out');
    assert.equal(plan.result.child_running, true);
    assert.equal(plan.result.child_pid, readPid(pidFile));
    return plan;
  }

  it('reports the command still running, then exits only after it finished', { skip: SKIP_POSIX }, async (t) => {
    const machine = makeMachine(t);
    const { pidFile, doneFile } = stubbornMarketplaceAdd(machine);
    let doneAtFirstOutput = null;
    const r = await runCli(SETTINGS, machine, ARGV(machine), {
      onStdout: () => { doneAtFirstOutput ??= existsSync(doneFile); },
    });
    assert.equal(r.status, 0, r.stderr);
    const plan = assertReportsStillRunning(r.stdout, pidFile);
    assert.equal(doneAtFirstOutput, false, 'the report arrived only after the command finished');
    assert.match(r.stderr, new RegExp(`waiting for pid ${plan.result.child_pid} to exit`));
    assert.ok(existsSync(doneFile), 'settings exited before the command finished, cutting it short');
  });

  it('a reader that closes stdout does not end the wait', { skip: SKIP_POSIX }, async (t) => {
    const machine = makeMachine(t);
    const { doneFile } = stubbornMarketplaceAdd(machine);
    const r = await runCli(SETTINGS, machine, ARGV(machine), { close: 'stdout' });
    assert.equal(r.signal, null);
    assert.ok(existsSync(doneFile), `settings exited (status ${r.status}) before the command finished: ${r.stderr.slice(0, 300)}`);
  });

  it('a reader that closes stderr does not end the wait, and the report arrives whole', { skip: SKIP_POSIX }, async (t) => {
    const machine = makeMachine(t);
    const { pidFile, doneFile } = stubbornMarketplaceAdd(machine);
    const r = await runCli(SETTINGS, machine, ARGV(machine), { close: 'stderr' });
    assert.equal(r.status, 0);
    assertReportsStillRunning(r.stdout, pidFile);
    assert.ok(existsSync(doneFile), 'settings exited before the command finished, cutting it short');
  });

  it('a failure after the command started still waits for it, then exits 1', { skip: SKIP_POSIX }, async (t) => {
    const machine = makeMachine(t);
    const { pidFile, doneFile } = stubbornMarketplaceAdd(machine, { breakJournal: true });
    const r = await runCli(SETTINGS, machine, ARGV(machine));
    assert.equal(r.status, 1, `status ${r.status} (signal ${r.signal}): ${r.stderr.slice(0, 300)}`);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^runtime:settings failed: /);
    assert.match(r.stderr, new RegExp(`waiting for pid ${readPid(pidFile)} to exit`));
    assert.ok(existsSync(doneFile), 'settings exited on the failure before the command finished, cutting it short');
  });

  it('a failure after the command started, with a reader that closed stderr, still waits for it', { skip: SKIP_POSIX }, async (t) => {
    const machine = makeMachine(t);
    const { doneFile } = stubbornMarketplaceAdd(machine, { breakJournal: true });
    const r = await runCli(SETTINGS, machine, ARGV(machine), { close: 'stderr' });
    assert.equal(r.signal, null);
    assert.ok(existsSync(doneFile), `settings exited (status ${r.status}) on the failure before the command finished`);
  });
});

// A probe child that ignores SIGTERM keeps its pipes open after runCommand's
// 5 s timeout resolves without waiting for `close`. Ending with
// `process.exitCode` alone (doctor's old report path, settings' natural exit)
// waits for that child; exitAfterFlush exits once the report has flushed.
// Only the first `claude` start is stubborn, so one probe times out and the
// rest fail fast.
for (const { label, script, argv } of [
  { label: 'runtime:doctor', script: DOCTOR, argv: ['--format', 'json'] },
  { label: 'runtime:settings', script: SETTINGS, argv: ['--format', 'json'] },
]) {
  describe(`${label} CLI — exits while a probe child that ignores SIGTERM outlives its timeout (R2)`, () => {
    it('exits with a parseable report before the child ends', { skip: SKIP_POSIX }, async (t) => {
      const machine = makeMachine(t);
      const pidFile = join(machine.base, 'claude.pid');
      writeFileSync(join(machine.bin, 'claude'), `#!/bin/sh\nif [ ! -e '${pidFile}' ]; then\n  echo $$ > '${pidFile}'\n  trap '' TERM\n  exec /bin/sleep 120\nfi\nexit 1\n`, 'utf8');
      const r = await runCli(script, machine, [...argv, '--repo-root', machine.cwd]);
      assert.ok(Number.isSafeInteger(readPid(pidFile)), 'the stubborn claude never ran, so no probe timed out');
      let report;
      assert.doesNotThrow(() => { report = JSON.parse(r.stdout); }, `the report does not parse: ${r.stdout.slice(0, 300)}; stderr=${r.stderr.slice(0, 300)}`);
      assert.equal(typeof report, 'object');
    });
  });
}

describe('runtime:settings — a cleanup command still running is not offered for a re-run (R2)', () => {
  const plan = (over) => ({
    host: 'claude',
    action: 'uninstall-retired-plugin',
    status: 'failed',
    command: 'claude plugin uninstall research@agentic-plugins',
    ...over,
  });

  it('names the pid to wait for and drops the re-run command', () => {
    const followups = buildPluginCleanupManualFollowups([
      plan({ result: { child_running: true, child_pid: 4242 } }),
    ]);
    assert.deepEqual(followups.map((item) => item.id), ['claude-plugin-cleanup-command-still-running']);
    assert.deepEqual(followups[0].pids, [4242]);
    assert.deepEqual(followups[0].commands, []);
    assert.ok(!JSON.stringify(followups).includes('claude plugin uninstall'), 'the still-running uninstall is offered for a re-run');
  });

  it('still offers the re-run for a cleanup that failed and ended', () => {
    const followups = buildPluginCleanupManualFollowups([plan({ result: { child_running: false } })]);
    assert.deepEqual(followups.map((item) => item.id), ['claude-retired-plugin-cleanup']);
    assert.deepEqual(followups[0].commands, ['claude plugin uninstall research@agentic-plugins']);
  });
});
