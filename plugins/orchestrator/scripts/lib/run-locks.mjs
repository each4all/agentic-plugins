// scripts/lib/run-locks.mjs — the autopilot run locks and the interactive
// commands' admission entries (ADR-0063 D8; ADR-0067 Decision 4, item 5).
//
// Moved from the Claude adapter (adapters/claude/autopilot/ledger.mjs, which
// re-exports it), since the interactive commands and their Codex mirrors take
// part in the same locks: `state.mjs admission join|check|release`. It imports
// neither state.mjs nor peer-runner.mjs, so state.mjs can import it without a
// cycle (its CLI entry awaits at the top level).

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const AUTOPILOT_DIR_REL = '.agentic-plugins/runs/autopilot';

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


// Whether a pid is running (EPERM: running, as another user's).
export async function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

// Whether two fingerprints name one process (peer-runner's rule).
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
// An interactive command that switches the branch or writes the macro joins
// them too, with an admission entry `s-<admission id>.json` (ADR-0067
// Decision 4, item 5): live until released, never judged gone.
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
  constructor(lock, holder, { now = Date.now() } = {}) {
    super(holder?.kind === 'session'
      ? `an interactive session holds ${lock}: ${describeAdmission(holder, { now })}`
      : `another autopilot run holds ${lock}: ${holder?.run_id ?? 'unknown run'} (pid ${holder?.pid ?? '?'}${holder?.worker?.pid ? `, worker ${holder.worker.pid}` : ''})${holder?.repo ? `, launched in ${holder.repo}: run /orchestrator:autopilot status there` : ''}`);
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
const ADMISSION_ENTRY = /^s-([0-9a-f]{32})\.json$/;
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
  return { file, text, holder, mtimeMs, session: ADMISSION_ENTRY.test(path.basename(file)) };
}

/** The entries in a lock directory, runs' and sessions': [{ file, text, holder (null when it does not parse), mtimeMs, session }]. */
export function readLockEntries(lock) {
  let names;
  try {
    names = fs.readdirSync(lock);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const name of names.filter((n) => ENTRY.test(n) || ADMISSION_ENTRY.test(n)).sort()) {
    const e = readEntry(path.join(lock, name));
    if (e) out.push(e); // else removed meanwhile
  }
  return out;
}

const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });

async function judgeOne(e, { probe, now }) {
  // An admission entry is live until released: its command may be paused
  // inside a step, and no process proves it gone (ADR-0067 Decision 4, item 5).
  // One that does not parse is shown to the owner, never cleared as debris.
  if (e.session) return e.holder === null && now() - e.mtimeMs < FRESH_UNPARSED_MS ? 'busy' : 'live';
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
 * Take a lock. Resolves to { release, setWorker, addWorkerGroup, entry }, or
 * rejects with LockHeldError while another live run holds it or is taking it.
 *
 * A serial run records its one worker on its own entry (`setWorker`). A run
 * with several worker groups in flight (ADR-0067 Decision 6, Locks) adds one
 * more entry per group instead (`addWorkerGroup(worker)`, released once the
 * group is empty): each entry records the driver and that one group, so
 * `holderAlive` keeps the lock live while the driver or any group lives — for
 * an older reader too, which judges each entry alone and would delete an
 * entry listing several groups once the one it read had ended. The worker
 * field adds the group's lane and cwd.
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
        addWorkerGroup: (worker) => {
          if (!worker || !Number.isInteger(worker.pid)) throw new Error('addWorkerGroup needs the group\'s worker pid');
          // Only while the run still holds the lock: an entry added after the
          // release would hold it for a group no run accounts for.
          if (!fs.existsSync(mine)) throw new Error(`the run no longer holds ${lock}`);
          const group = path.join(lock, `h-${process.pid}-${randomBytes(6).toString('hex')}.json`);
          writeWhole(lock, group, { ...base, worker });
          return { entry: group, release: () => unlinkQuiet(group) };
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
      out.push({ kind: 'macro', macroId: n.slice(0, -'.lock'.length), lock, entry: e.file, holder: e.holder, session: e.session });
    }
  }
  if (repoRoot) {
    const lock = worktreeLockPath(repoRoot);
    for (const e of readLockEntries(lock)) {
      out.push({ kind: 'worktree', macroId: e.holder?.macro_id ?? null, lock, entry: e.file, holder: e.holder, session: e.session });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Admission entries (ADR-0067 Decision 4, item 5)
//
// The interactive commands that switch the branch, write the macro or
// dispatch into the checkout join the locks a run takes, so neither starts
// beside the other. `join` writes one entry under one random id in every lock
// the command joins and proceeds only when no other live entry is there (a
// run's or another session's), else it removes its own and refuses. Each
// guarded block `check`s its own id; every exit after the join `release`s it.
// A run's workers pass without an entry, proved by the run's secret.

export const ADMISSION_COMMANDS = Object.freeze(['next', 'done', 'finalize', 'abort', 'resume']);
// Shown as stale past this age, for the owner to judge; never expired.
export const ADMISSION_STALE_MS = 4 * 60 * 60 * 1000;
const ADMISSION_ID = /^[0-9a-f]{32}$/;

export class AdmissionError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'AdmissionError';
    this.code = code;
  }
}

export function newAdmissionId() {
  return randomBytes(16).toString('hex');
}

export function admissionEntryPath(lock, admissionId) {
  if (!ADMISSION_ID.test(admissionId ?? '')) throw new AdmissionError(`not an admission id: ${JSON.stringify(admissionId)}`, 'usage');
  return path.join(lock, `s-${admissionId}.json`);
}

// The checkout `checkout` lies in, keyed as the driver keys the worktree lock
// it takes (the autopilot CLI's repo root: `git rev-parse --show-toplevel`,
// then its real path), so a session in a subdirectory, or under another
// spelling of the same directory, meets a run and other sessions in one
// worktree lock. An empty value (a flag left without its path) is refused:
// git would read it as the working directory.
export function checkoutRoot(checkout) {
  if (typeof checkout !== 'string' || checkout === '') {
    throw new AdmissionError('--checkout needs a path: the checkout the command runs in', 'usage');
  }
  let top;
  try {
    top = execFileSync('git', ['-C', checkout, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000,
    }).trim();
  } catch {
    top = '';
  }
  if (top === '') throw new AdmissionError(`--checkout ${checkout} is not in a git checkout`, 'usage');
  try {
    return fs.realpathSync(top);
  } catch {
    return top;
  }
}

// The locks a command joins, in the order the driver takes them: the one
// command that switches the branch, /orchestrator:next, first joins the
// worktree lock of its checkout; every command joins the macro lock.
export function admissionLocks({ command, checkout, macroId }) {
  if (!ADMISSION_COMMANDS.includes(command)) {
    throw new AdmissionError(`--command must be one of ${ADMISSION_COMMANDS.join(', ')} (got ${JSON.stringify(command)})`, 'usage');
  }
  const root = path.resolve(checkout);
  return [...(command === 'next' ? [worktreeLockPath(root)] : []), macroLockPath(mainWorktreeRoot(root), macroId)];
}

// The digest a run stores in its lock entries for its secret (the lock files
// are readable; the secret is not written anywhere).
export function tokenDigest(token) {
  return createHash('sha256').update(String(token)).digest('hex');
}

// Whether the caller is a worker of the run `holder` records: its
// AGENTIC_AUTOPILOT names that run, and its AGENTIC_AUTOPILOT_TOKEN hashes to
// the digest the run stored. A process group is no proof: a worker's
// descendants can leave it.
export function isHoldingRunWorker(holder, env = process.env) {
  if (!holder || holder.kind === 'session' || typeof holder.run_id !== 'string') return false;
  if (env.AGENTIC_AUTOPILOT !== holder.run_id) return false;
  const token = env.AGENTIC_AUTOPILOT_TOKEN;
  if (typeof token !== 'string' || token === '' || typeof holder.token_digest !== 'string') return false;
  const got = Buffer.from(tokenDigest(token), 'hex');
  const want = Buffer.from(holder.token_digest, 'hex');
  return got.length === want.length && got.length > 0 && timingSafeEqual(got, want);
}

function ageText(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  return minutes < 120 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

// A session's admission, as a refusal and `status` show it: its command,
// checkout, host, session id when recorded, age (stale past 4 h) and id, with
// the command that releases it once the owner knows that session is gone.
export function describeAdmission(holder, { now = Date.now() } = {}) {
  const acquired = Date.parse(holder?.acquired_at ?? '');
  const age = Number.isFinite(acquired) ? now - acquired : null;
  const parts = [
    `/orchestrator:${holder?.command ?? '?'}`,
    `checkout ${holder?.checkout ?? '?'}`,
    `host ${holder?.host ?? '?'}`,
    ...(holder?.session_id ? [`session ${holder.session_id}`] : []),
    age === null ? 'admitted at an unknown time' : `admitted ${ageText(age)} ago${age > ADMISSION_STALE_MS ? ' (stale: older than 4 h; judge whether that session is gone)' : ''}`,
    `admission ${holder?.admission_id ?? '?'}`,
  ];
  return `${parts.join(', ')}. Once that session is gone, release it: state.mjs admission release --macro ${holder?.macro_id ?? '<macro id>'} --checkout ${holder?.checkout ?? '<checkout>'} --admission ${holder?.admission_id ?? '<admission id>'}`;
}

/**
 * Join the locks `command` takes part in. Resolves to { admissionId, locks }
 * with this session's entries written, or { admissionId: '', workerOf } for a
 * worker of the run holding every one of them, which passes without an entry.
 * Rejects with LockHeldError naming another live participant (its entries
 * removed), or AdmissionError on a usage error.
 */
export async function joinAdmission({
  command, checkout, macroId, host, sessionId = null, env = process.env,
  now = () => Date.now(), probe = processFingerprint, hooks = {},
}) {
  checkout = checkoutRoot(checkout);
  if (host !== 'claude' && host !== 'codex') throw new AdmissionError(`--host must be claude or codex (got ${JSON.stringify(host)})`, 'usage');
  const locks = admissionLocks({ command, checkout, macroId });
  const seen = [];
  for (const lock of locks) {
    const judged = await judgeEntries(lock, { probe, now, hooks, phase: 'check' });
    seen.push({ lock, others: judged.filter((e) => e.state !== 'gone') });
  }
  const worker = seen.every(({ others }) => others.length > 0 && others.every((e) => e.state === 'live' && isHoldingRunWorker(e.holder, env)));
  if (worker) return { admissionId: '', workerOf: env.AGENTIC_AUTOPILOT, locks };
  const held = seen.find(({ others }) => others.length > 0);
  if (held) throw new LockHeldError(held.lock, held.others[0].holder ?? { run_id: 'a participant taking the lock' }, { now: now() });

  const admissionId = newAdmissionId();
  const entry = {
    kind: 'session', admission_id: admissionId, command, macro_id: macroId,
    checkout: path.resolve(checkout), host, session_id: sessionId || null,
    acquired_at: new Date(now()).toISOString(),
  };
  const written = [];
  try {
    for (const lock of locks) {
      fs.mkdirSync(lock, { recursive: true });
      const file = admissionEntryPath(lock, admissionId);
      writeWhole(lock, file, entry);
      written.push(file);
    }
    if (hooks.afterCreate) await hooks.afterCreate();
    // Look again: a run, or another session, that added its entry meanwhile.
    for (const lock of locks) {
      const after = await judgeEntries(lock, { exclude: admissionEntryPath(lock, admissionId), probe, now, hooks, phase: 'recheck' });
      const rival = after.find((e) => e.state !== 'gone');
      if (rival) throw new LockHeldError(lock, rival.holder ?? { run_id: 'a participant taking the lock' }, { now: now() });
      await clearDebris(lock, after);
    }
  } catch (err) {
    for (const file of written) unlinkQuiet(file);
    throw err;
  }
  return { admissionId, locks };
}

/**
 * Whether the admission `admissionId` still stands: its entry in the macro
 * lock, and in every other lock its command joined. '' (a worker) stands
 * while the caller is a worker of a live run holding the macro lock.
 * Resolves to { ok: true } or { ok: false, why }.
 */
export async function checkAdmission({ checkout, macroId, admissionId, env = process.env, probe = processFingerprint }) {
  checkout = checkoutRoot(checkout);
  const macroLock = macroLockPath(mainWorktreeRoot(path.resolve(checkout)), macroId);
  if (admissionId === '' || admissionId === undefined || admissionId === null) {
    for (const e of readLockEntries(macroLock)) {
      if (!e.session && isHoldingRunWorker(e.holder, env) && await holderAlive(e.holder, { probe })) return { ok: true };
    }
    return { ok: false, why: `no live run this session is a worker of holds ${macroLock}` };
  }
  const own = readEntryOrNull(admissionEntryPath(macroLock, admissionId));
  if (!own?.holder || own.holder.admission_id !== admissionId) return { ok: false, why: `admission ${admissionId} is gone from ${macroLock}` };
  if (path.resolve(own.holder.checkout ?? '') !== path.resolve(checkout)) {
    return { ok: false, why: `admission ${admissionId} was made for the checkout ${own.holder.checkout}, not ${path.resolve(checkout)}` };
  }
  for (const lock of admissionLocks({ command: own.holder.command, checkout, macroId })) {
    if (!readEntryOrNull(admissionEntryPath(lock, admissionId))) return { ok: false, why: `admission ${admissionId} is gone from ${lock}` };
  }
  return { ok: true };
}

/** Remove every entry of `admissionId` from the locks a command can join; the paths removed. '' (a worker) holds none. */
export function releaseAdmission({ checkout, macroId, admissionId }) {
  checkout = checkoutRoot(checkout);
  if (admissionId === '' || admissionId === undefined || admissionId === null) return [];
  const removed = [];
  for (const lock of admissionLocks({ command: 'next', checkout, macroId })) {
    const file = admissionEntryPath(lock, admissionId);
    try {
      fs.unlinkSync(file);
      removed.push(file);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  return removed;
}

function readEntryOrNull(file) {
  try {
    return readEntry(file);
  } catch {
    return null;
  }
}
