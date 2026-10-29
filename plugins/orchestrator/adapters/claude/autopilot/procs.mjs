// plugins/orchestrator/adapters/claude/autopilot/procs.mjs
//
// ADR-0068 Decision 3, item 6 — the process table the stall detector reads:
// each process's parent, group, CPU time at 0.1 s or finer, its age, and a
// start time that makes its identity, in output that does not depend on the
// caller's locale or environment.
//
// - Linux: `/proc/<pid>/stat` (procps `ps` prints whole seconds, too coarse),
//   the clock tick from `getconf CLK_TCK`, the age from `/proc/uptime`.
// - macOS: `ps -A` with its locale pinned to C, as the run locks do for their
//   fingerprint (scripts/lib/run-locks.mjs `processFingerprint`): under another
//   locale `lstart` is localized (measured: ko_KR, de_DE, 2026-10-29), and a
//   table that does not parse is a failed read, never a table of idle
//   processes.
//
// A process's CPU is its own (user + system), never its exited children's
// (Linux `cutime`/`cstime`, BSD `ps -S`): Decision 3, item 3.
//
// The read is one snapshot of the whole table, bounded by a deadline that
// covers every part of it (the /proc walk and getconf included). A read past
// its deadline answers `timeout` and is told to stop (the walk stops at its
// next process; ps and getconf are killed at the same bound); until it has,
// a new read answers `slow` and starts nothing, so reads never pile up:
//   { ok: true, procs: [{ pid, ppid, pgid, key, ageMs, cpuMs }], unreadable:
//     [pid], exited: [pid], resolutionMs }
//   { ok: false, why }   why: failed | timeout | slow | parse | coarse
// A process absent from the listing was not alive throughout it: an exit.
// One listed whose read then says it is gone (ENOENT, ESRCH) exited between
// the listing and its read (`exited`); one listed that cannot be read
// (EACCES, a malformed line) is `unreadable`, which the detector judges for
// the worker whose member it may be (stall.mjs).

import { execFile as execFileCb } from 'node:child_process';
import fsp from 'node:fs/promises';

export const PROBE_DEADLINE_MS = 5000;
// Decision 3, item 4: a resolution coarser than 0.1 s is unknown.
export const MAX_RESOLUTION_MS = 100;

const PS_ARGS = Object.freeze(['-A', '-o', 'pid=,ppid=,pgid=,etime=,lstart=,time=']);

/** The environment `ps` runs in: the caller's, its locale pinned to C. */
export const psEnv = (base = process.env) => ({ ...base, LC_ALL: 'C', LANG: 'C' });

const defaultExecFile = (cmd, args, opts) => new Promise((resolve, reject) => {
  execFileCb(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts }, (err, stdout) => {
    if (err) reject(err);
    else resolve({ stdout });
  });
});

// `[[dd-]hh:]mm:ss[.ff]` → { ms, fraction: digits after the point }, or null.
// macOS prints a CPU time past an hour as minutes (`298:24.90`), so the
// leftmost part is not bounded by 59.
export function parseClock(text) {
  const m = /^(?:(\d+)-)?(\d+(?::\d+){0,2})(?:\.(\d+))?$/.exec(text);
  if (!m) return null;
  const parts = m[2].split(':').map(Number);
  if (parts.length < 2) return null;
  for (let i = 1; i < parts.length; i += 1) if (parts[i] > 59) return null;
  if (m[1] !== undefined && parts.length !== 3) return null;
  let s = 0;
  for (const p of parts) s = s * 60 + p;
  if (m[1] !== undefined) s += Number(m[1]) * 86400;
  const frac = m[3] ?? '';
  const ms = s * 1000 + (frac ? Math.round(Number(`0.${frac}`) * 1000) : 0);
  return { ms, fractionDigits: frac.length };
}

const LSTART = '[A-Z][a-z]{2} [A-Z][a-z]{2} [ \\d]\\d \\d\\d:\\d\\d:\\d\\d \\d{4}';
const PS_LINE = new RegExp(`^\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s+(\\S+)\\s+(${LSTART})\\s+(\\S+)\\s*$`);

/** A C-locale `ps -A -o pid=,ppid=,pgid=,etime=,lstart=,time=` table, parsed. */
export function parsePsTable(text) {
  const procs = [];
  let resolutionMs = 0;
  for (const line of String(text).split('\n')) {
    if (line.trim() === '') continue;
    const m = PS_LINE.exec(line);
    if (!m) return { ok: false, why: 'parse' };
    const age = parseClock(m[4]);
    const cpu = parseClock(m[6]);
    if (!age || !cpu) return { ok: false, why: 'parse' };
    // No fraction: whole seconds, coarser than 0.1 s.
    const res = cpu.fractionDigits === 0 ? 1000 : 10 ** (3 - Math.min(cpu.fractionDigits, 3));
    if (res > resolutionMs) resolutionMs = res;
    const pid = Number(m[1]);
    procs.push({
      pid, ppid: Number(m[2]), pgid: Number(m[3]), key: `${pid}@${m[5].replace(/\s+/g, ' ')}`, ageMs: age.ms, cpuMs: cpu.ms,
    });
  }
  if (procs.length === 0) return { ok: false, why: 'parse' };
  if (resolutionMs > MAX_RESOLUTION_MS) return { ok: false, why: 'coarse' };
  return { ok: true, procs, unreadable: [], exited: [], resolutionMs };
}

/**
 * One `/proc/<pid>/stat` line → { pid, ppid, pgid, startTicks, cpuTicks }, or
 * null. The command name may hold `) `, so the fields are read after the last
 * `)`: state is field 3, ppid 4, pgrp 5, utime 14, stime 15, starttime 22.
 */
export function parseProcStat(text) {
  const s = String(text);
  const open = s.indexOf(' (');
  const close = s.lastIndexOf(')');
  if (open <= 0 || close < open) return null;
  const pid = Number(s.slice(0, open));
  const f = s.slice(close + 1).trim().split(/\s+/);
  if (f.length < 20) return null;
  const nums = [f[1], f[2], f[11], f[12], f[19]].map(Number);
  if (!Number.isInteger(pid) || pid <= 0 || nums.some((n) => !Number.isSafeInteger(n) || n < 0)) return null;
  const [ppid, pgid, utime, stime, startTicks] = nums;
  return { pid, ppid, pgid, startTicks, cpuTicks: utime + stime };
}

let cachedHz = null;
/** For tests: forget the cached clock tick. */
export const resetClockTick = () => { cachedHz = null; };

async function readLinux({ procRoot, execFile, getconf, readFile, readdir, deadlineMs, stopped }) {
  if (cachedHz === null) {
    const r = getconf ? await getconf() : await execFile('getconf', ['CLK_TCK'], { timeout: deadlineMs });
    const hz = Number(String(r?.stdout ?? r).trim());
    if (!Number.isInteger(hz) || hz <= 0) return { ok: false, why: 'failed' };
    cachedHz = hz;
  }
  const hz = cachedHz;
  const resolutionMs = 1000 / hz;
  if (resolutionMs > MAX_RESOLUTION_MS) return { ok: false, why: 'coarse' };
  const uptime = Number(String(await readFile(`${procRoot}/uptime`, 'utf8')).trim().split(/\s+/)[0]);
  if (!Number.isFinite(uptime) || uptime < 0) return { ok: false, why: 'parse' };
  const names = (await readdir(procRoot)).filter((n) => /^\d+$/.test(n));
  const procs = [];
  const unreadable = [];
  const exited = [];
  for (const name of names) {
    if (stopped()) return { ok: false, why: 'timeout' };
    const pid = Number(name);
    let text;
    try {
      text = await readFile(`${procRoot}/${name}/stat`, 'utf8');
    } catch (e) {
      if (e?.code === 'ENOENT' || e?.code === 'ESRCH') exited.push(pid);
      else unreadable.push(pid);
      continue;
    }
    const st = parseProcStat(text);
    if (!st || st.pid !== pid) { unreadable.push(pid); continue; }
    procs.push({
      pid, ppid: st.ppid, pgid: st.pgid, key: `${pid}@${st.startTicks}`,
      ageMs: Math.max(0, uptime * 1000 - (st.startTicks * 1000) / hz), cpuMs: (st.cpuTicks * 1000) / hz,
    });
  }
  return { ok: true, procs, unreadable, exited, resolutionMs };
}

/**
 * Read the process table once, within `deadlineMs`. Never throws: a failure
 * is { ok: false, why }, which the detector takes for an unknown sample.
 *
 * @param a.platform  process.platform (a test seam)
 * @param a.execFile  (cmd, args, opts) => Promise<{stdout}> (a test seam)
 * @param a.getconf   () => Promise<string|{stdout}> (Linux, a test seam)
 * @param a.procRoot  '/proc' (a test seam)
 * @param a.readFile, a.readdir  fs.promises' (test seams)
 */
let running = null; // the read still under way, until it has stopped
/** For tests: whether a read is still under way. */
export const readInFlight = () => running !== null;

export async function readProcessTable({
  platform = process.platform, execFile = defaultExecFile, getconf = null, procRoot = '/proc',
  readFile = fsp.readFile, readdir = fsp.readdir, deadlineMs = PROBE_DEADLINE_MS, env = process.env,
} = {}) {
  if (running !== null) return { ok: false, why: 'slow' };
  let timer = null;
  let late = false;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => { late = true; resolve({ ok: false, why: 'timeout' }); }, deadlineMs);
    timer.unref?.();
  });
  const read = (async () => {
    try {
      if (platform === 'linux') return await readLinux({ procRoot, execFile, getconf, readFile, readdir, deadlineMs, stopped: () => late });
      if (platform === 'darwin') {
        const { stdout } = await execFile('ps', [...PS_ARGS], { env: psEnv(env), timeout: deadlineMs });
        return parsePsTable(stdout);
      }
      return { ok: false, why: 'failed' };
    } catch {
      return { ok: false, why: 'failed' };
    }
  })();
  const mine = read.finally(() => { if (running === mine) running = null; });
  running = mine;
  try {
    return await Promise.race([read, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
