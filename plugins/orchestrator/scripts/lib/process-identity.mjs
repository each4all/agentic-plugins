// COPIED from persona-pipeline — do not edit this copy.
// Source: persona-pipeline/files/scripts/lib/process-identity.mjs, byte for byte below these
// three lines; tests/scripts/test-orchestrator-peer-snapshot-parity.mjs checks it.
// scripts/lib/process-identity.mjs
//
// Whether a recorded process is still the one that was recorded: a pid plus a
// fingerprint (its start time, and on macOS its command line) taken when it
// was recorded, so a pid the system has since handed to another process is
// told apart from the original. peer-runner's ledger and the peer snapshot's
// owner record (lib/peer-snapshot.mjs) both judge their processes here, and
// both peer dispatchers stop a peer's process group here.
// Generated from persona-pipeline/ (ADR-0066).

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

export async function fingerprintForPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { kind: 'none' };

  if (process.platform === 'linux') {
    try {
      const statText = await readFile(`/proc/${pid}/stat`, 'utf8');
      const end = statText.lastIndexOf(')');
      const rest = statText.slice(end + 2).trim().split(/\s+/);
      const starttime = rest[19]; // proc_pid_stat(5): field 22 after comm/state offset.
      const cmdline = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => '');
      return {
        kind: 'linux_proc_starttime',
        starttime,
        command: cmdline.replace(/\0/g, ' ').trim(),
      };
    } catch {
      return { kind: 'none' };
    }
  }

  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'command='], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      if (!out) return { kind: 'none' };
      const m = out.match(/^(\S+\s+\S+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+([\s\S]*)$/);
      return {
        kind: 'macos_lstart_command',
        lstart: m ? m[1] : out,
        command: m ? m[2] : '',
      };
    } catch {
      return { kind: 'none' };
    }
  }

  return { kind: 'none' };
}

export async function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

// Whether any process of the group `pgid` is alive: a companion that exited
// can leave children in its group, still running in its directory.
export function isGroupAlive(pgid) {
  if (!Number.isInteger(pgid) || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

export function fingerprintsMatch(recorded, current) {
  if (!recorded || recorded.kind === 'none') return false;
  if (!current || current.kind !== recorded.kind) return false;
  if (recorded.kind === 'linux_proc_starttime') {
    return recorded.starttime === current.starttime;
  }
  if (recorded.kind === 'macos_lstart_command') {
    return recorded.lstart === current.lstart && recorded.command === current.command;
  }
  return false;
}

// What is known of a recorded process `{ pid, fingerprint }` now:
//   'gone'    no process has its pid;
//   'match'   a process has its pid and its recorded fingerprint;
//   'differ'  a process has its pid and another fingerprint (the pid reused);
//   'unknown' a process has its pid, and no fingerprint was recorded or none
//             can be taken now, so it may be the original.
// A record without a pid is 'gone': nothing was recorded to be alive.
export async function identityState(record) {
  const pid = record?.pid;
  if (!Number.isInteger(pid) || pid <= 0) return 'gone';
  if (!(await isProcessAlive(pid))) return 'gone';
  const recorded = record.fingerprint;
  if (!recorded || recorded.kind === 'none') return 'unknown';
  const current = await fingerprintForPid(pid);
  if (current.kind === 'none') {
    // It may have exited between the two looks.
    return (await isProcessAlive(pid)) ? 'unknown' : 'gone';
  }
  return fingerprintsMatch(recorded, current) ? 'match' : 'differ';
}

// Stop what is left of a peer's process group (a child that outlived the
// companion may still run in its directory): SIGTERM, then SIGKILL after the
// grace. Only a recorded group is signalled; with none there is nothing a run
// can tell apart from another process.
export async function stopProcessGroup(pgid, graceMs) {
  if (!Number.isInteger(pgid) || pgid <= 0 || !isGroupAlive(pgid)) return;
  try {
    process.kill(-pgid, 'SIGTERM');
  } catch {
    return;
  }
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline && isGroupAlive(pgid)) await new Promise((r) => setTimeout(r, 25));
  if (!isGroupAlive(pgid)) return;
  try {
    process.kill(-pgid, 'SIGKILL');
  } catch {
    return;
  }
  const killDeadline = Date.now() + 2000;
  while (Date.now() < killDeadline && isGroupAlive(pgid)) await new Promise((r) => setTimeout(r, 25));
}

// What a signal to a peer dispatch (`peer-runner run`, `dispatch-peer`)
// requests: one cancellation, however many signals arrive; a listener
// registered after it fires at once. onRequest returns what retires the
// listener: a run that has ended signals nothing of what it recorded, whose
// pid may by then be another process's.
export function createRunCancellation() {
  const listeners = new Set();
  const cancellation = {
    signal: null,
    request(signal) {
      if (cancellation.signal !== null) return false;
      cancellation.signal = signal;
      for (const fn of [...listeners]) fn(signal);
      return true;
    },
    onRequest(fn) {
      if (cancellation.signal !== null) {
        fn(cancellation.signal);
        return () => {};
      }
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
  return cancellation;
}
