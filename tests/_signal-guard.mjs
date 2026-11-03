// tests/_signal-guard.mjs
//
// A test process never signals its own process group (docket C169).
//
// `npm test` loads this module first (`node --import`, which node --test also
// hands to the process it starts for each test file). Every test file then
// shares one process group with the runner, `npm test` and, under the
// autopilot's verification step, the supervisor that runs the check and
// reports how it ended. A test that signals pid 0 (`Number('')` from a pid
// file read between its creation and its write, tests/_pidfile.mjs), pid -1,
// or its own group by number kills all of them: the check ends with no report
// and no evidence (verification batches s1-37fef6, s16-6d4e91 and
// s18-387b50 of run autopilot-20261102T142858Z-309f46). So `process.kill`
// refuses, by throwing, any signal but 0 to those targets, before the system
// sees it. Signal 0, the existence probe, goes through: it changes nothing.
//
// Only a test's own process is guarded: a process it spawns does not load
// this module, unless it is started with it.
//
// Not discovered by `node --test`: the stem `_signal-guard` matches none of
// Node's test-file patterns.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

/** The error a refused signal throws. */
export class SelfSignalError extends Error {
  constructor(pid, signal) {
    super(`a test process signalled ${pid === -1 ? 'every process it may signal (pid -1)' : `its own process group (pid ${pid})`} with ${String(signal)}; refused (tests/_signal-guard.mjs)`);
    this.code = 'ESELFSIGNAL';
  }
}

/**
 * Whether `process.kill(pid, signal)` from a process of group `ownGroup`
 * (a positive integer, or null when unknown) would signal that group, or every
 * process: any signal but 0 to pid 0, pid -1, or -`ownGroup`.
 */
export function signalsOwnGroup(pid, signal, ownGroup) {
  if (signal === 0 || signal === '0') return false;
  const n = Number(pid);
  if (n === 0 || n === -1) return true;
  return n < -1 && ownGroup !== null && -n === ownGroup;
}

let own = null;
// The caller's process group, read once it is first needed, for a group
// target only: on Linux from /proc, elsewhere from ps. A read that fails is
// not kept, so the next group signal reads again. Where neither can be read
// (a sandbox that denies ps), a group named by number goes through: a limit;
// pid 0, -0 and -1 are refused all the same.
function ownGroup() {
  if (own !== null) return own;
  let g = NaN;
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync('/proc/self/stat', 'utf8');
      g = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]);
    } catch { /* unread */ }
  } else {
    const r = spawnSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    if (r.status === 0) g = Number(r.stdout.trim());
  }
  if (Number.isInteger(g) && g > 1) own = g;
  return own;
}

const kill = process.kill.bind(process);
process.kill = function guardedKill(pid, signal = 'SIGTERM') {
  if (signalsOwnGroup(pid, signal, Number(pid) < -1 ? ownGroup() : null)) throw new SelfSignalError(pid, signal);
  return kill(pid, signal);
};
