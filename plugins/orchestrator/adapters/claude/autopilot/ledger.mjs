// plugins/orchestrator/adapters/claude/autopilot/ledger.mjs
//
// ADR-0063 D8 — the run ledger and the per-macro lock.
//
// Everything a run leaves lives under
// `<repo>/.agentic-plugins/runs/autopilot/<run-id>/`:
//   run.json            options, model plan, roots, pinned versions, git
//                       baseline, macro, status, step count, cost, halt
//   steps.jsonl         a `started` line written BEFORE the worker is spawned
//                       (D1: every spawn is on record before it starts), then a
//                       `finished` line after it
//   landing.jsonl       a `landing-ready` line for each committed subtask the
//                       run reported (landing-ready.mjs, ADR-0067 Decision 7)
//   worker-<seq>.jsonl  the raw worker stream (byte-capped by worker.mjs)
//   halt.json           reason, detail, pointer, resume hints
//
// The lock is per macro (D8: at most one run drives a macro), under the main
// worktree so linked worktrees share it:
// `<main>/.agentic-plugins/runs/autopilot/locks/<macro-id>.lock/`. The
// macro's landing log sits beside it (`landing/<macro-id>.jsonl`). The lock is a
// directory of participant entries, each holding its run's pid and process
// fingerprint (the peer-runner pattern), so an entry whose run died, or whose
// pid was reused, is recognised as stale.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { isAutopilotRun } from '../../../scripts/state.mjs';
import { fingerprintsMatch, isProcessAlive } from '../../../scripts/peer-runner.mjs';

export const AUTOPILOT_DIR_REL = '.agentic-plugins/runs/autopilot';

export function autopilotDir(repoRoot) {
  return path.join(repoRoot, AUTOPILOT_DIR_REL);
}

// The worktree that holds the repository's common git dir: the place every
// linked worktree of this repository can find the same lock.
export function mainWorktreeRoot(repoRoot) {
  try {
    const common = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000,
    }).trim();
    if (path.basename(common) === '.git') return path.dirname(common);
  } catch {
    /* fall back below */
  }
  return repoRoot;
}

export function newRunId(now = new Date(), random = () => randomBytes(3).toString('hex')) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const id = `autopilot-${stamp}-${random()}`;
  // The id is the AGENTIC_AUTOPILOT value; runbooks treat a malformed one as
  // "autopilot off", which would silently run every step interactively.
  if (!isAutopilotRun({ AGENTIC_AUTOPILOT: id })) throw new Error(`generated run id ${id} is not a valid autopilot run id`);
  return id;
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function createRunDir(repoRoot, runId) {
  if (!isAutopilotRun({ AGENTIC_AUTOPILOT: runId })) throw new Error(`invalid run id ${runId}`);
  const dir = path.join(autopilotDir(repoRoot), runId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeRun(runDir, run) {
  writeJsonAtomic(path.join(runDir, 'run.json'), run);
}

export function appendStep(runDir, record) {
  fs.appendFileSync(path.join(runDir, 'steps.jsonl'), `${JSON.stringify(record)}\n`);
}

export function appendLanding(runDir, record) {
  fs.appendFileSync(path.join(runDir, 'landing.jsonl'), `${JSON.stringify(record)}\n`);
}

export function writeHalt(runDir, haltRecord) {
  writeJsonAtomic(path.join(runDir, 'halt.json'), haltRecord);
}

export function workerStreamPath(runDir, seq) {
  return path.join(runDir, `worker-${seq}.jsonl`);
}

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};

/** Run ids under the repository's ledger, oldest first. */
export function listRuns(repoRoot) {
  let names = [];
  try { names = fs.readdirSync(autopilotDir(repoRoot)); } catch { return []; }
  return names.filter((n) => isAutopilotRun({ AGENTIC_AUTOPILOT: n })).sort();
}

const readLines = (file) => {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* none yet */ }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn */ }
  }
  return out;
};

/**
 * One run's records: run.json, the steps (started/finished paired by seq), the
 * landing-ready records in the order they were written, halt.json.
 */
export function readRun(repoRoot, runId) {
  const dir = path.join(autopilotDir(repoRoot), runId);
  const run = readJson(path.join(dir, 'run.json'));
  if (!run) return null;
  const steps = new Map();
  for (const rec of readLines(path.join(dir, 'steps.jsonl'))) {
    const prev = steps.get(rec.seq) ?? {};
    steps.set(rec.seq, rec.event === 'finished' ? { ...prev, ...rec } : { ...rec, ...prev });
  }
  return {
    dir, run,
    steps: [...steps.values()].sort((a, b) => a.seq - b.seq),
    landing: readLines(path.join(dir, 'landing.jsonl')),
    halt: readJson(path.join(dir, 'halt.json')),
  };
}

// ---------------------------------------------------------------------------
// Locks
//
// Two locks:
//   - per macro, under the main worktree, so no two runs drive one macro from
//     any worktree (D8);
//   - per worktree, under the driven worktree, so no two runs — of different
//     macros — switch one checkout's branch at the same time (the serial
//     driver's per-repo lock, until worktree lanes land).
//
// A lock is a directory. Each run that wants it adds an entry of its own,
// `h-<pid>-<random>.json`, recording the driver and, while a step runs, its
// worker; an entry is stale only when both are gone (a driver that died does
// not prove its worker did, and a second run must not start beside a live
// worker). A run holds the lock when, after adding its entry, it finds no
// other live entry. Since every entry has a name no other participant uses,
// a run only ever removes its own entry or one whose owners are gone — never
// a live participant's — so two runs cannot both hold the lock: whichever
// added its entry second sees the first one's.

export function macroLockPath(mainRoot, macroId) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(macroId ?? '')) throw new Error(`invalid macro id for a lock: ${macroId}`);
  return path.join(mainRoot, AUTOPILOT_DIR_REL, 'locks', `${macroId}.lock`);
}

export function worktreeLockPath(repoRoot) {
  return path.join(repoRoot, AUTOPILOT_DIR_REL, 'worktree.lock');
}

export class LockHeldError extends Error {
  constructor(lock, holder) {
    super(`another autopilot run holds ${lock}: ${holder?.run_id ?? 'unknown run'} (pid ${holder?.pid ?? '?'}${holder?.worker?.pid ? `, worker ${holder.worker.pid}` : ''})`);
    this.name = 'LockHeldError';
    this.lock = lock;
    this.holder = holder;
  }
}

// An entry is written whole (a rename), so one that does not parse is not
// being written: younger than this it is still treated as a participant,
// older it is debris.
const FRESH_UNPARSED_MS = 5_000;

const ENTRY = /^h-(\d+)-[0-9a-f]+\.json$/;
const TEMP = /^t-(\d+)-[0-9a-f]+\.tmp$/;

/**
 * A process's fingerprint, in the shape peer-runner's `fingerprintsMatch`
 * compares — `{kind: 'macos_lstart_command', lstart, command}` or
 * `{kind: 'linux_proc_starttime', starttime, command}` — plus `zombie: true`
 * for a process that has exited and waits only for its parent to reap it,
 * which `kill(pid, 0)` still reports as alive. `{kind: 'none'}` when it
 * cannot be read.
 *
 * Not peer-runner's `fingerprintForPid`: that one parses `ps`'s start time
 * in whatever locale the caller runs in, and its pattern only fits the C
 * locale. Under any other, the start time swallows the command line, so the
 * start alone could not be compared, and two processes in different locales
 * would fingerprint the same process differently (measured: ko_KR, 2026-10-03).
 * `ps` runs here with LC_ALL=C.
 */
export async function processFingerprint(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { kind: 'none' };
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      // Fields after the command name, which may itself hold ') '.
      const rest = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      let command = '';
      try { command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); } catch { /* exited meanwhile */ }
      const fp = { kind: 'linux_proc_starttime', starttime: rest[19], command };
      return rest[0] === 'Z' || rest[0] === 'X' ? { ...fp, zombie: true } : fp;
    } catch {
      return { kind: 'none' };
    }
  }
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('ps', ['-p', String(pid), '-o', 'stat=', '-o', 'lstart=', '-o', 'command='], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' },
      }).trim();
      const m = /^(\S+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4})\s*([\s\S]*)$/.exec(out);
      if (!m) return { kind: 'none' };
      const fp = { kind: 'macos_lstart_command', lstart: m[2], command: m[3] };
      return m[1].startsWith('Z') ? { ...fp, zombie: true } : fp;
    } catch {
      return { kind: 'none' };
    }
  }
  return { kind: 'none' };
}

// Whether two fingerprints of one pid prove two processes: they started at
// different times. Only the start proves it — the macOS fingerprint also holds
// the command line, which an exec in place (a wrapper that execs claude)
// changes without changing the process (round 6).
function startDiffers(recorded, current) {
  if (recorded.kind !== current.kind) return false;
  if (recorded.kind === 'linux_proc_starttime') return recorded.starttime !== current.starttime;
  if (recorded.kind === 'macos_lstart_command') return recorded.lstart !== current.lstart;
  return false;
}

// What a recorded process is now: 'dead', 'other' (its pid is alive and
// provably started after the recorded one — reused by another process), or
// 'live'.
async function processState(pid, recorded, probe) {
  if (!Number.isInteger(pid) || pid <= 0) return 'dead';
  if (!(await isProcessAlive(pid))) return 'dead';
  const current = await probe(pid);
  const comparable = Boolean(recorded && recorded.kind !== 'none' && current && current.kind !== 'none');
  // A different start proves another process reused the pid, whether it is
  // running or has exited — checked first, so that an exited stranger is
  // not taken for the recorded process having exited (round 8).
  if (comparable && startDiffers(recorded, current)) return 'other';
  // The recorded process, exited and not yet reaped by its parent (CI,
  // 2026-10-03: a driver whose parent was blocked in spawnSync held its lock
  // until the wait ended).
  if (current?.zombie === true) return 'dead';
  // Otherwise the pid counts as the holder: the same start, whatever an exec
  // in place did to the command line, or nothing to compare — unverifiable
  // is not stale.
  return 'live';
}

// Whether any process is left in a process group. Unverifiable (EPERM: a
// member this user cannot signal) counts as left.
function groupAlive(pgid) {
  if (process.platform === 'win32' || !Number.isInteger(pgid) || pgid <= 0) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Whether a lock entry's driver, or the worker it recorded, is still running —
 * or, for a worker whose process group outlived SIGKILL (the driver then
 * keeps the entry and halts), anything left in that group. `probe` reads a
 * pid's fingerprint (a test seam: the platform probe can fail).
 */
export async function holderAlive(holder, { probe = processFingerprint } = {}) {
  if (!holder) return false;
  if ((await processState(holder.pid, holder.fingerprint, probe)) === 'live') return true;
  const worker = await processState(holder.worker?.pid, holder.worker?.fingerprint, probe);
  if (worker === 'live') return true;
  // The worker led its group (pgid = its pid). A pid reused by another
  // process means that group had ended: POSIX reuses neither a pid nor a
  // process group id while a group of that id exists. A group under that id
  // now is someone else's (round 5).
  if (worker === 'other' && holder.worker?.pgid === holder.worker?.pid) return false;
  return groupAlive(holder.worker?.pgid);
}

/**
 * Whether `pid` is provably the process a record names: alive, and its
 * fingerprint readable and equal. Liveness above errs toward "held"; a signal
 * needs proof, so an unreadable or missing fingerprint is not enough here.
 */
export async function provablySame(pid, recorded, { probe = processFingerprint } = {}) {
  if (!Number.isInteger(pid) || pid <= 0 || !recorded || recorded.kind === 'none') return false;
  if (!(await isProcessAlive(pid))) return false;
  const current = await probe(pid);
  return Boolean(current && current.kind !== 'none' && current.zombie !== true && fingerprintsMatch(recorded, current));
}

// One entry as it is now, or null once it is gone.
function readEntry(file) {
  let text;
  let mtimeMs = 0;
  try {
    text = fs.readFileSync(file, 'utf8');
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  let holder = null;
  try { holder = JSON.parse(text); } catch { /* debris, or not ours */ }
  return { file, text, holder, mtimeMs };
}

/** The entries in a lock directory: [{ file, text, holder (null when it does not parse), mtimeMs }]. */
export function readLockEntries(lock) {
  let names;
  try {
    names = fs.readdirSync(lock);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const name of names.filter((n) => ENTRY.test(n)).sort()) {
    const e = readEntry(path.join(lock, name));
    if (e) out.push(e); // else removed meanwhile
  }
  return out;
}

const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function judgeOne(e, { probe, now }) {
  if (e.holder === null) return now() - e.mtimeMs < FRESH_UNPARSED_MS ? 'busy' : 'gone';
  return (await holderAlive(e.holder, { probe })) ? 'live' : 'gone';
}

// Each entry of the lock but `exclude`, judged: 'live', 'busy' (does not parse
// and is fresh), or 'gone'.
//
// 'gone' holds only for the record it was judged on. An entry is read, then its
// processes are checked, and its owner may rewrite it in between — recording a
// worker, and then dying (round 4). So a 'gone' entry is read again after the
// check: unchanged, it stays gone, and stays unchanged, since only its owner
// writes it and the check found that owner dead. Changed, it is judged again.
// `hooks.afterRead` is a test seam between the read and the check.
async function judgeEntries(lock, { exclude = null, probe, now, hooks = {}, phase }) {
  const judged = [];
  const entries = readLockEntries(lock).filter((e) => e.file !== exclude);
  if (hooks.afterRead) await hooks.afterRead(phase);
  for (let e of entries) {
    let state = await judgeOne(e, { probe, now });
    for (let rereads = 0; state === 'gone'; rereads += 1) {
      const again = readEntry(e.file);
      if (!again) { state = 'missing'; break; }
      if (again.text === e.text) break;
      // Rewritten again and again while judged dead: not settled, so not gone.
      if (rereads === 3) { state = 'busy'; break; }
      e = again;
      state = await judgeOne(e, { probe, now });
    }
    if (state !== 'missing') judged.push({ ...e, state });
  }
  return judged;
}

function writeWhole(lock, file, body) {
  const tmp = path.join(lock, `t-${process.pid}-${randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(body)}\n`, { flag: 'wx' });
  fs.renameSync(tmp, file);
}

function unlinkQuiet(file) {
  try { fs.unlinkSync(file); } catch (err) { if (err.code !== 'ENOENT') throw err; }
}

// Entries judged gone, and temporary files whose writer is gone. Only names no
// live participant uses are removed.
async function clearDebris(lock, judged) {
  for (const e of judged) if (e.state === 'gone') unlinkQuiet(e.file);
  let names = [];
  try { names = fs.readdirSync(lock); } catch { /* none */ }
  for (const n of names) {
    const m = TEMP.exec(n);
    if (m && !(await isProcessAlive(Number(m[1])))) unlinkQuiet(path.join(lock, n));
  }
}

/**
 * Take a lock. Resolves to { release, setWorker, entry }, or rejects with
 * LockHeldError while another live run holds it or is taking it.
 *
 *   1. Another live entry: refused. One that is still unreadable but fresh:
 *      wait for it.
 *   2. Add this run's entry.
 *   3. Look again. Another live (or fresh unreadable) entry means a contender
 *      added its entry at the same time: remove ours, wait a random moment,
 *      and start over — and on the last attempt, refuse.
 *   4. Otherwise this run holds the lock; remove the entries whose runs are gone.
 *
 * `hooks.beforeCreate` and `hooks.afterCreate` are test seams around step 2,
 * and `hooks.afterRead(phase)` one inside each scan ('check', 'recheck').
 */
export async function acquireLock(lock, { record, now = () => Date.now(), probe = processFingerprint, hooks = {}, attempts = 20 }) {
  fs.mkdirSync(lock, { recursive: true });
  const self = { pid: process.pid, fingerprint: await processFingerprint(process.pid) };
  const base = { ...record, ...self, worker: null };
  const mine = path.join(lock, `h-${process.pid}-${randomBytes(6).toString('hex')}.json`);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const before = await judgeEntries(lock, { probe, now, hooks, phase: 'check' });
    const live = before.find((e) => e.state === 'live');
    if (live) throw new LockHeldError(lock, live.holder);
    if (before.some((e) => e.state === 'busy')) { await pause(100); continue; }

    if (hooks.beforeCreate) await hooks.beforeCreate();
    writeWhole(lock, mine, base);
    if (hooks.afterCreate) await hooks.afterCreate();

    const after = await judgeEntries(lock, { exclude: mine, probe, now, hooks, phase: 'recheck' });
    const rival = after.find((e) => e.state !== 'gone');
    if (!rival) {
      await clearDebris(lock, after);
      return {
        entry: mine,
        release: () => unlinkQuiet(mine),
        setWorker: (worker) => {
          if (fs.existsSync(mine)) writeWhole(lock, mine, { ...base, worker });
        },
      };
    }
    unlinkQuiet(mine);
    if (attempt === attempts) throw new LockHeldError(lock, rival.holder ?? { run_id: 'a run taking the lock' });
    await pause(20 + Math.floor(Math.random() * 80));
  }
  throw new Error(`could not take the autopilot lock ${lock} after repeated attempts`);
}

/** The macro locks under the main worktree and the driven worktree's lock, one row per entry, with its holder. */
export function listLocks(mainRoot, repoRoot = null) {
  const out = [];
  const dir = path.join(mainRoot, AUTOPILOT_DIR_REL, 'locks');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { /* none */ }
  for (const n of names.filter((x) => x.endsWith('.lock')).sort()) {
    const lock = path.join(dir, n);
    for (const e of readLockEntries(lock)) {
      out.push({ kind: 'macro', macroId: n.slice(0, -'.lock'.length), lock, entry: e.file, holder: e.holder });
    }
  }
  if (repoRoot) {
    const lock = worktreeLockPath(repoRoot);
    for (const e of readLockEntries(lock)) {
      out.push({ kind: 'worktree', macroId: e.holder?.macro_id ?? null, lock, entry: e.file, holder: e.holder });
    }
  }
  return out;
}
