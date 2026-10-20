// plugins/orchestrator/scripts/lib/heavy-run.mjs
//
// ADR-0068 Decision 6, item 4 — the wrapper:
//
//   agentic-autopilot heavy [--purpose <text>] [--repo <dir>]
//                           [--declaration-ref <rev>] -- <command> [args...]
//
// It takes the repository's heavy-work lock (lib/heavy-lock.mjs), runs the
// command as its child, in a process group of its own, and releases the lock
// once the command and its group have stopped. While it waits it names the
// holder, as the mutation harness does. Inside another holder's ownership (its
// environment carries that holder's proof) it joins instead: it waits for
// nothing and releases nothing.
//
// THE GROUP. A supervisor, detached so that it leads a new process group G,
// starts idle and runs the command only once the wrapper has registered G in
// the lock's ownership and written `go` on its stdin, the wrapper's lifeline:
// when that pipe ends (the wrapper killed with SIGKILL) the supervisor kills G.
// It reports how the command ended on a pipe of its own (fd 3), never on the
// command's stderr, then kills what is left of G. The command's stdin is
// /dev/null: heavy work is not interactive, and a group that is not the
// terminal's foreground group would be stopped (SIGTTIN) reading it.
//
// SIGNALS (SIGINT, SIGTERM, SIGHUP). While waiting for the lock, the wait is
// cancelled and nothing runs. While the command runs, the same signal goes to G,
// and SIGKILL follows 5 s later; the wrapper then waits until G and the groups
// registered under it are gone, with no bound, then releases (or, joined, ends).
// A second signal is noted. SIGKILL to the wrapper leaves G to its supervisor
// and the lock to a reader's stale judgment. All of this is about the wrapper's
// own pid. The installed `agentic-autopilot` launcher (launcher.template.mjs) is
// a copied file an upgrade does not replace, and forwards SIGINT and SIGTERM
// only: a SIGHUP or SIGKILL to the launcher's pid alone ends the launcher, and
// the wrapper runs its command to the end, then releases. A terminal's Ctrl-C
// reaches both, so the wrapper notes the launcher's forwarded copy as a second
// signal. Exit status, as `env` and
// `timeout` give theirs: the command's own; 128+n for signal n, whether it
// ended the command or stopped the wrapper; 125 for the wrapper's own failure
// or refusal; 126 when the command cannot be executed; 127 when it is not found.
//
// The lock is repository-level and host-neutral, so this command is exempt from
// the autopilot's host refusal (ADR-0063 D9 is about the driver) and runs
// inside an autopilot step too.
//
// A COMMAND THAT LOCKS ITSELF (item 3). The wrapper refuses, with 125, a command
// the repository's check declaration marks as taking the lock itself
// (`locks_itself`): an older harness under a holder would wait on its own
// holder. It reads the committed declaration at `--declaration-ref` (the
// driver passes its run's baseline) or HEAD, never the working tree.

import { spawn, spawnSync } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import { resolve } from 'node:path';

import {
  HeavyLockBusyError, HeavyLockError, PROOF_ENV, VIA_ENV, WAIT_REPORT_MS, acquire, groupState, ownershipGroups, registerGroup,
  shown, signalGroup,
} from './heavy-lock.mjs';

export const DECLARATION_PATH = '.agentic-plugins/verify-checks.json';
export const KILL_GRACE_MS = 5000;
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
// Test seams: how often a waiter polls, and how often it repeats a line.
export const POLL_ENV = 'AGENTIC_HEAVY_LOCK_POLL_MS';
export const REPORT_ENV = 'AGENTIC_HEAVY_LOCK_REPORT_MS';

export const HEAVY_USAGE = `Usage: agentic-autopilot heavy [--purpose <text>] [--repo <dir>] [--declaration-ref <rev>] -- <command> [args...]

Takes the repository's heavy-work lock (ADR-0068 Decision 6), runs the command,
and releases the lock once the command and its process group have stopped.
Inside another holder's ownership it joins it and waits for nothing.

  --purpose <text>         what the lock's holder is named by (default: the command line)
  --repo <dir>             the repository whose lock to take (default: the current one)
  --declaration-ref <rev>  read the check declaration at this commit (default: HEAD)

Exit: the command's status · 128+n for signal n · 125 the wrapper's own failure or refusal
      · 126 the command cannot be executed · 127 the command is not found`;

export class HeavyUsageError extends Error {}

/** Parse the words after `heavy`: options, then `--` and the command. */
export function parseHeavy(words) {
  const o = { purpose: null, repo: null, declarationRef: null, command: [], help: false };
  const value = (i, name) => {
    if (i >= words.length || words[i] === '--') throw new HeavyUsageError(`${name} takes a value`);
    return words[i];
  };
  let i = 0;
  for (; i < words.length; i++) {
    const w = words[i];
    if (w === '--') { o.command = words.slice(i + 1); break; }
    if (w === '--help' || w === '-h') o.help = true;
    else if (w === '--purpose') o.purpose = value(++i, '--purpose');
    else if (w === '--repo') o.repo = value(++i, '--repo');
    else if (w === '--declaration-ref') o.declarationRef = value(++i, '--declaration-ref');
    else throw new HeavyUsageError(`unknown option ${shown(w)}; the command follows --`);
  }
  if (o.help) return o;
  if (i >= words.length) throw new HeavyUsageError('the command follows --');
  if (o.command.length === 0 || o.command[0] === '') throw new HeavyUsageError('no command after --');
  return o;
}

const git = (repo, args) => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', timeout: 30_000 });

/**
 * Why the committed declaration refuses `command`, or null. It reads the
 * declaration at `ref`: each check kind's `argv` and `locks_itself`, nothing
 * else. A kind that locks itself refuses a command whose words begin with the
 * fixed words of its argv (those before its first `{slot}`). No declaration at
 * the ref refuses nothing; one that does not parse refuses everything, naming
 * it; a ref that names no commit is refused.
 */
export function selfLockingRefusal(repoRoot, ref, command) {
  const commit = git(repoRoot, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (commit.status !== 0) return `--declaration-ref ${shown(ref)} names no commit of ${repoRoot}`;
  const sha = commit.stdout.trim();
  if (git(repoRoot, ['cat-file', '-e', `${sha}:${DECLARATION_PATH}`]).status !== 0) return null;
  const shownAt = git(repoRoot, ['show', `${sha}:${DECLARATION_PATH}`]);
  const where = `${DECLARATION_PATH} at ${shown(ref)}`;
  if (shownAt.status !== 0) return `cannot read ${where}: ${shown(shownAt.stderr.trim())}`;
  let declaration;
  try {
    declaration = JSON.parse(shownAt.stdout);
  } catch (err) {
    return `${where} does not parse: ${shown(err.message)}`;
  }
  const kinds = declaration?.kinds;
  if (kinds === null || typeof kinds !== 'object' || Array.isArray(kinds)) return `${where} does not parse: it has no kinds object`;
  for (const [kind, spec] of Object.entries(kinds)) {
    if (spec?.locks_itself !== true) continue;
    if (!Array.isArray(spec.argv) || !spec.argv.every((w) => typeof w === 'string')) {
      return `${where} does not parse: kind ${shown(kind)} has no argv of words`;
    }
    const fixed = [];
    for (const w of spec.argv) {
      if (w.includes('{')) break;
      fixed.push(w);
    }
    if (fixed.length > 0 && fixed.every((w, n) => command[n] === w)) {
      return `${where} marks the check kind ${shown(kind)} (${shown(fixed.join(' '))}) as taking the heavy-work lock itself; `
        + 'run it without the wrapper (ADR-0068 Decision 6, item 3)';
    }
  }
  return null;
}

// The supervisor: idle until `go`, then the command; its report on fd 3.
export const SUPERVISOR = [
  "const { spawn } = require('node:child_process');",
  "const { writeSync } = require('node:fs');",
  "const report = (r) => { try { writeSync(3, JSON.stringify(r) + '\\n'); } catch {} };",
  'let run = null;',
  "const stop = () => { try { process.kill(0, 'SIGKILL'); } catch { if (run !== null) try { run.kill('SIGKILL'); } catch {} process.exit(1); } };",
  "for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, () => {});",
  "process.stdin.on('end', stop);",
  "process.stdin.on('error', stop);",
  'const [command, ...args] = JSON.parse(process.argv[1]);',
  "let line = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => { if (run !== null) return; line += chunk; if (line.includes('\\n')) (line === 'go\\n' ? go : stop)(); });",
  'process.stdin.resume();',
  'function go() {',
  // Node throws some exec failures (ENOEXEC, ENOTDIR) and emits the others.
  "try { run = spawn(command, args, { stdio: ['ignore', 'inherit', 'inherit'] }); } catch (err) { report({ error: err.code ?? err.message }); stop(); return; }",
  "run.on('error', (err) => { report({ error: err.code ?? err.message }); stop(); });",
  "run.on('exit', (code, signal) => { report({ code, signal }); stop(); });",
  '}',
].join('\n');

const signalNumber = (signal) => osConstants.signals[signal] ?? 1;

// The system out of processes, memory or descriptors: the command was never
// tried, so this is the wrapper's own failure, as `timeout` treats a failed
// fork.
const RESOURCE_ERRORS = new Set(['EAGAIN', 'EMFILE', 'ENFILE', 'ENOMEM']);

/** The status for a command the supervisor could not start, by its error code. */
export function startFailureStatus(code) {
  if (code === 'ENOENT') return 127;
  return RESOURCE_ERRORS.has(code) ? 125 : 126;
}
const sleep = (ms) => new Promise((wake) => { setTimeout(wake, ms); });

function tuned(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 10 && n <= fallback ? n : fallback;
}

function toplevel(dir) {
  const r = git(dir, ['rev-parse', '--show-toplevel']);
  return r.status === 0 ? r.stdout.trim() : null;
}

/**
 * Run the wrapper. Resolves its exit status; installs its signal handlers for
 * as long as it runs. `err` takes each line it reports. `beforeGo` (awaited
 * between the group's registration and the go line) is for tests.
 */
export async function runHeavy(words, {
  env = process.env, cwd = process.cwd(), out = (s) => process.stdout.write(`${s}\n`), err = (s) => process.stderr.write(`${s}\n`),
  beforeGo = async () => {},
} = {}) {
  let o;
  try {
    o = parseHeavy(words);
  } catch (e) {
    err(`heavy: ${e.message}`);
    err('Run agentic-autopilot heavy --help for usage.');
    return 125;
  }
  if (o.help) { out(HEAVY_USAGE); return 0; }
  if (process.platform === 'win32') { err('heavy: process groups are POSIX; this wrapper does not run on Windows'); return 125; }
  const repoRoot = toplevel(resolve(cwd, o.repo ?? '.'));
  if (repoRoot === null) { err(`heavy: ${shown(o.repo ?? cwd)} is not inside a git repository`); return 125; }
  const refusal = selfLockingRefusal(repoRoot, o.declarationRef ?? 'HEAD', o.command);
  if (refusal !== null) { err(`heavy: ✗ ${refusal}`); return 125; }
  const purpose = o.purpose ?? o.command.join(' ');
  const pollMs = tuned(env, POLL_ENV, 2000);
  const reportMs = tuned(env, REPORT_ENV, WAIT_REPORT_MS);

  const cancel = new AbortController();
  let received = null;
  // The command's group, once registered: its id and its leader's start, so
  // that no kill reaches a group that took the id after this one ended.
  let group = null;
  let killTimer = null;
  const onSignal = (signal) => {
    if (received !== null) {
      err(`heavy: ${signal} noted; already stopping after ${received}`);
      return;
    }
    received = signal;
    if (group === null) {
      cancel.abort();
      return;
    }
    signalGroup(group.pgid, group.started, signal);
    killTimer = setTimeout(() => { signalGroup(group.pgid, group.started, 'SIGKILL'); }, KILL_GRACE_MS);
  };
  for (const s of SIGNALS) process.on(s, onSignal);
  try {
    let handle;
    try {
      handle = await acquire(repoRoot, {
        kind: 'wrapper', purpose, log: err, prefix: 'heavy', signal: cancel.signal, env, mint: true, pollMs, reportMs,
      });
    } catch (e) {
      if (received !== null) return 128 + signalNumber(received);
      err(`heavy: ${e.message}`);
      return 125;
    }
    try {
      return await runHeld(handle, o.command, {
        env, err, pollMs, reportMs, beforeGo, received: () => received, started: (g) => { group = g; },
      });
    } catch (e) {
      if (!(e instanceof HeavyLockError)) throw e;
      err(`heavy: ${e.message}`);
      return 125;
    }
  } finally {
    clearTimeout(killTimer);
    for (const s of SIGNALS) process.off(s, onSignal);
  }
}

// With the lock held or joined: run the command in its group, wait for the
// group and what registered under it to end, then release.
async function runHeld(handle, command, { env, err, pollMs, reportMs, beforeGo, received, started }) {
  const releaseLock = async () => {
    if (handle.joined) return;
    for (let said = 0; ;) {
      try {
        handle.release();
        return;
      } catch (e) {
        if (!(e instanceof HeavyLockBusyError)) throw e;
        if (Date.now() - said >= reportMs) {
          err(`heavy: ${e.message} until it ends`);
          said = Date.now();
        }
        await sleep(Math.min(pollMs, 200));
      }
    }
  };
  if (received() !== null) {
    await releaseLock();
    return 128 + signalNumber(received());
  }
  let sup;
  try {
    sup = spawn(process.execPath, ['-e', SUPERVISOR, '--', JSON.stringify(command)], {
      env: { ...env, [PROOF_ENV]: handle.proof, [VIA_ENV]: handle.chain.join(',') },
      detached: true,
      stdio: ['pipe', 'inherit', 'inherit', 'pipe'],
    });
  } catch (e) {
    // Thrown, not emitted: an argument list the system refuses (E2BIG).
    await releaseLock();
    err(`heavy: cannot start the command's supervisor: ${shown(e.message)}`);
    return 125;
  }
  const closed = new Promise((done) => {
    sup.on('error', (e) => done({ error: e }));
    sup.on('close', () => done({}));
  });
  // Emitted, with no pid: EMFILE and ENFILE leave its pipes unset too.
  if (sup.pid === undefined) {
    const { error } = await closed;
    await releaseLock();
    err(`heavy: cannot start the command's supervisor: ${error?.message ?? 'no pid'}`);
    return 125;
  }
  sup.stdin.on('error', () => { /* the supervisor has exited */ });
  let reportText = '';
  sup.stdio[3].setEncoding('utf8');
  sup.stdio[3].on('data', (chunk) => { reportText += chunk; });
  let entry;
  try {
    entry = registerGroup(handle.ownership, sup.pid);
  } catch (e) {
    try { process.kill(-sup.pid, 'SIGKILL'); } catch { /* gone */ }
    await closed;
    await releaseLock();
    err(`heavy: ${e.message}; the command was not started`);
    return 125;
  }
  const g = { pgid: sup.pid, started: entry.leaderStarted };
  started(g);
  await beforeGo();
  if (received() === null) sup.stdin.write('go\n');
  else signalGroup(g.pgid, g.started, 'SIGKILL');
  await closed;
  // What is left of the group ends with the command.
  for (let said = Date.now(); groupState(g.pgid, g.started) === 'running';) {
    signalGroup(g.pgid, g.started, 'SIGKILL');
    if (Date.now() - said >= reportMs) {
      err(`heavy: process group ${sup.pid} has not ended; the lock is kept until it does`);
      said = Date.now();
    }
    await sleep(20);
  }
  // A joined acquirer waits for its own descendants' groups; a holder for every
  // group of its ownership, in its release, which refuses while one runs.
  const self = handle.chain[handle.chain.length - 1];
  for (let said = Date.now(); handle.joined;) {
    const left = ownershipGroups(handle.path, handle.token, { via: self }).filter((g) => g.name !== entry.name);
    if (left.length === 0) break;
    if (Date.now() - said >= reportMs) {
      err(`heavy: process group ${left.map((g) => g.pgid).join(', ')} started under this command still runs; waiting until it ends`);
      said = Date.now();
    }
    await sleep(Math.min(pollMs, 200));
  }
  entry.unregister();
  await releaseLock();
  if (received() !== null) return 128 + signalNumber(received());
  const line = reportText.split('\n').find((l) => l !== '');
  let report = null;
  try { report = line === undefined ? null : JSON.parse(line); } catch { /* none */ }
  if (report === null) {
    err('heavy: the command\'s supervisor ended without reporting how the command ended');
    return 125;
  }
  if (report.error !== undefined) {
    err(`heavy: cannot run ${shown(command[0])}: ${shown(report.error)}`);
    return startFailureStatus(report.error);
  }
  if (Number.isInteger(report.code)) return report.code;
  return 128 + signalNumber(report.signal);
}
