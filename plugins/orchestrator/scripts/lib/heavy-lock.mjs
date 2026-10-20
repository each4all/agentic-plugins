// plugins/orchestrator/scripts/lib/heavy-lock.mjs
//
// ADR-0068 Decision 6 — one heavy-work lock per repository. Its holders are
// the mutation harness (`scripts/mutation-harness.mjs`, which imports this file
// by its path in the tree) and the wrapper `agentic-autopilot heavy -- <cmd>`
// (lib/heavy-run.mjs). The installed orchestrator loads this file from its own
// tree: nothing here imports the repository's `scripts/`.
//
// THE LOCK FILE is the harness's, `<git-common-dir>/mutation-harness.lock`,
// shared by every worktree; the name is historical. A holder writes its record
// whole and hard-links it into place, so a second link fails with EEXIST. Every
// harness copy from 7badfe23bd486a2c43007d02f26496374a729f48 on takes the same
// file the same way and reads the same fields (pid, host, started, token,
// started_at, worktree, spec), so an older harness, on an older branch, honors
// a holder of this release and is honored by it. The start spelling (`boot:`,
// `utc:`) and the reap guard (`<lock>.reap`) are byte-compatible with it.
//
// OWNERSHIP. A holder's heavy work runs in process groups of its own (a test
// run's, the wrapped command's). Each group is registered, before anything in
// it starts, as an entry of the holder's ownership directory,
// `<lock>.groups/<token>/<pgid>-<uuid>.json`. A reader of this release judges a
// lock stale only once its holder is not running AND no group of its ownership
// runs (ADR-0068 Decision 6, item 2). Closing is the one synchronization point:
// a releaser or a reaper renames the directory to `<token>.closed.<uuid>`
// before it judges the entries, so a registration after that point fails (its
// directory is gone) and one that landed before it moved with the directory.
// The ownership of a token is its open directory and every closed one. An entry
// leaves only by its own registrant, under its own unique name. A scan that a
// close overtakes starts again. An acquirer that has placed its lock closes
// every other ownership before it judges them, and withdraws and waits while a
// group of one runs, so a process of an earlier holder that registers after
// the acquirer's last look never runs beside it. Every kill of a registered
// group first checks that its id still names that group (`signalGroup`): once
// a group has ended, its id is free for another.
//
// NESTED ACQUISITION (item 3). A wrapper holder mints a proof, 32 random bytes,
// and hands it to its command as AGENTIC_HEAVY_LOCK_PROOF; its record keeps only
// the proof's sha256. An acquirer whose proof hashes to a running holder's
// digest joins: it waits for nothing and releases nothing, and the groups it
// registers are the holder's ownership. AGENTIC_HEAVY_LOCK_VIA carries the
// chain of handles above it, so an acquirer waits for its own entries and its
// descendants' only; a chain of 64 handles is not extended. A process inside
// an ownership whose holder has ended while the ownership runs is refused: it
// would wait on its own ancestors. A harness holder mints no proof. The proof keeps an
// unrelated process from joining by accident; a process of the same user that
// reads the holder's environment can join.
//
// What an older harness does not do (item 2, narrower): it publishes no
// groups, so against an older holder a reader of this release judges by the
// recorded process alone, as the older one does; and an older reader judges a
// holder of this release by its pid alone, so after the holder's death it may
// start beside the holder's last children for as long as their supervisor
// takes to stop them. Measured on macOS (darwin, Node 24), as observations and
// not bounds (tests/orchestrator/test-heavy-lock-compat.mjs prints them): an
// older harness took a killed wrapper's lock some 50 ms after its death, with
// the wrapper's group still running; a reader of this release took a killed
// older holder's lock some 20 ms after its death, about when that holder's
// supervisor had stopped its test run. A process that leaves its holder's
// group (a daemon, a detached child) outlives every holder's release.

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  existsSync, linkSync, mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';

export class HeavyLockError extends Error {
  constructor(message) {
    super(message);
    this.name = 'HeavyLockError';
  }
}

/** A release refused while a group of the ownership still runs. */
export class HeavyLockBusyError extends HeavyLockError {
  constructor(message, groups) {
    super(message);
    this.name = 'HeavyLockBusyError';
    this.groups = groups;
  }
}

/** A registration into an ownership that has been closed. */
export class HeavyLockClosedError extends HeavyLockError {
  constructor(message) {
    super(message);
    this.name = 'HeavyLockClosedError';
  }
}

export const LOCK_NAME = 'mutation-harness.lock';
export const WAIT_REPORT_MS = 5 * 60_000;
export const RECORD_SCHEMA = 'agentic-heavy-lock-1';
export const PROOF_ENV = 'AGENTIC_HEAVY_LOCK_PROOF';
export const VIA_ENV = 'AGENTIC_HEAVY_LOCK_VIA';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MAX_CHAIN = 64;

// Text from a record or the command line is quoted into lines that reach a
// terminal, where a control character or line separator in it could forge or
// erase a line. Each one is shown as its code point instead (as
// lib/args-file.mjs shows an argument).
const UNSAFE_IN_MESSAGE = new RegExp(`[\\x00-\\x1f\\x7f-\\x9f${String.fromCharCode(0x2028, 0x2029)}]`, 'g');
export const shown = (text) => String(text).replace(UNSAFE_IN_MESSAGE,
  (c) => `<U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}>`);

/** The heavy-work lock of the repository `repoRoot` belongs to. */
export function lockPath(repoRoot) {
  let common;
  try {
    common = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    throw new HeavyLockError(`cannot find the git common dir of ${repoRoot}: ${err.message.trim()}`);
  }
  return join(common, LOCK_NAME);
}

export function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// What the system says of a running pid: `{ zombie, started }`, or null when it
// cannot say (no ps, or a sandbox that denies it). `started` names when the
// process started, and every reader must spell it alike, or a live holder reads
// as a reused pid and loses its lock. On Linux it is the start in clock ticks
// since boot, from /proc, which no clock change moves (ps derives its start time
// from the boot time, which moves when the clock is set). Elsewhere it is ps's
// start time in the C locale and UTC: ps prints local time, so two runs in
// different time zones would spell one start differently. Each spelling names
// its scheme (`boot:`, `utc:`), so that a reader compares only a start spelled
// as it spells one (see `holderRunning`).
export function processInfo(pid) {
  if (process.platform === 'linux') {
    let stat;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch {
      return null;
    }
    // The fields after the command name, which is in parentheses and may hold
    // any byte: the state, then the start time 19 fields on.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[19] ? { zombie: fields[0] === 'Z', started: `boot:${fields[19]}` } : null;
  }
  let out;
  try {
    out = execFileSync('ps', ['-o', 'stat=,lstart=', '-p', String(pid)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    }).trim();
  } catch {
    return null;
  }
  const match = /^(\S+)\s+(.+)$/.exec(out);
  return match ? { zombie: match[1].startsWith('Z'), started: `utc:${match[2]}` } : null;
}

// Whether the process a record names is still the one running: alive, not a
// zombie, and started when the record says (a pid reused by another process
// started later). What cannot be checked counts as running; a holder on another
// host cannot be checked from here at all, and a start spelled in a scheme this
// reader does not use (a harness of another version wrote it) cannot be
// compared: unequal spellings of one start would read as a reused pid.
const startScheme = (started) => /^(boot|utc):/.exec(started)?.[1] ?? null;

export function holderRunning(record) {
  if (record.host !== hostname()) return true;
  if (!processAlive(record.pid)) return false;
  const info = processInfo(record.pid);
  if (info === null) return true;
  if (info.zombie) return false;
  if (typeof record.started !== 'string' || startScheme(record.started) !== startScheme(info.started)) return true;
  return record.started === info.started;
}

// Write `record` whole, then link it to `target`: a reader never sees a part of
// it, and the link fails with EEXIST when `target` exists.
export function placeExclusive(target, record) {
  const tmp = `${target}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record)}\n`, 'utf8');
  try {
    linkSync(tmp, target);
  } finally {
    rmSync(tmp, { force: true });
  }
}

// `{ raw, record }`, or null when there is no lock. A record that does not
// parse, or names no pid and host, is null: nothing but a whole record is ever
// linked into place, and one without a holder would be waited for for ever.
export function readLock(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new HeavyLockError(`cannot read the run lock ${path}: ${err.message}`);
  }
  let record = null;
  try {
    record = JSON.parse(raw);
  } catch {
    /* unreadable: stale */
  }
  const whole = Number.isInteger(record?.pid) && typeof record?.host === 'string';
  return { raw, record: whole ? record : null };
}

// ---------------------------------------------------------------------------
// Ownership: the process groups a holder's heavy work runs in.

const groupsDir = (path) => `${path}.groups`;
// A token is a path component only when it is a UUID: a record of any other
// shape has no ownership, and nothing of it is touched.
const tokenOf = (record) => (typeof record?.token === 'string' && UUID.test(record.token) ? record.token : null);
const CLOSED = /^([0-9a-f-]{36})\.closed\.[0-9a-f-]{36}$/;

// The ownership directories of `token`, open and closed, as absolute paths.
function ownershipDirs(path, token) {
  let names;
  try {
    names = readdirSync(groupsDir(path));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new HeavyLockError(`cannot read ${groupsDir(path)}: ${err.message}`);
  }
  return names
    .filter((n) => n === token || CLOSED.exec(n)?.[1] === token)
    .map((n) => join(groupsDir(path), n));
}

// Every entry of `token`'s ownership: `{ dir, name, entry }`, `entry` null when
// it does not parse (it then counts as running). A directory that moves while
// it is read (its holder closed it, renaming it) makes the scan start again, so
// an entry is never lost between the two names; a scan that keeps finding its
// directories moving yields an entry `{ moving: true }`, which counts as
// running. `listed` (called once the directories are listed) is for tests.
const MAX_SCANS = 100;

export function ownershipEntries(path, token, { listed = () => {} } = {}) {
  for (let scan = 0; ; scan++) {
    const out = [];
    let moved = false;
    const dirs = ownershipDirs(path, token);
    listed();
    for (const dir of dirs) {
      let names;
      try {
        names = readdirSync(dir);
      } catch (err) {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') { moved = true; continue; }
        throw new HeavyLockError(`cannot read ${dir}: ${err.message}`);
      }
      for (const name of names.filter((n) => n.endsWith('.json'))) {
        let entry = null;
        try {
          entry = JSON.parse(readFileSync(join(dir, name), 'utf8'));
        } catch (err) {
          if (err.code === 'ENOENT') {
            // Unregistered, or its directory moved since it was listed.
            if (!existsSync(dir)) moved = true;
            continue;
          }
        }
        const whole = Number.isInteger(entry?.pgid) && entry.pgid > 0;
        out.push({ dir, name, entry: whole ? entry : null });
      }
    }
    if (!moved) return out;
    if (scan >= MAX_SCANS) return [...out, { dir: null, name: '(moving)', entry: null, moving: true }];
  }
}

/**
 * The state of the process group `pgid` registered with its leader's start:
 * 'gone', 'running' (ours), or 'foreign' (the id names another group now).
 *
 * A group is gone only when the system says so: ESRCH from `kill(-pgid, 0)`.
 * No look at the process list stands for that answer, since no such look is
 * atomic (on Linux /proc is read pid by pid; on macOS ps collects the pids,
 * then reads each one), and a member that changes pid during it is missed.
 *
 * A group whose leader has exited still runs while a member lives (POSIX keeps
 * its id reserved while the group exists). A leader alive, or a zombie, with
 * another start than the registered one is a reused pid, and EPERM from the
 * probe (a member another user's, or on macOS a group of zombies only) is
 * judged by the leader the same way: another user's process that took the id
 * is not ours. What cannot be told (the probe fails otherwise, a start that
 * cannot be read or is in another scheme) counts as running.
 *
 * KNOWN LIMIT: a group of zombies only is not gone until they are reaped. Under
 * a parent that never reaps them (a PID 1 with no init, as in a container
 * started without one), the group keeps its ownership, and so the lock, until
 * that parent reaps them or exits. On macOS launchd reaps orphans, and on Linux
 * an init does. `sys` is for tests.
 */
export function groupState(pgid, leaderStarted, sys = {}) {
  const { kill = (p, s) => process.kill(p, s), info = processInfo } = sys;
  try {
    kill(-pgid, 0);
  } catch (err) {
    if (err.code === 'ESRCH') return 'gone';
    if (err.code !== 'EPERM') return 'running';
  }
  let leaderAlive;
  try {
    kill(pgid, 0);
    leaderAlive = true;
  } catch (err) {
    leaderAlive = err.code !== 'ESRCH';
  }
  if (!leaderAlive) return 'running';
  const now = info(pgid);
  if (now === null || typeof leaderStarted !== 'string') return 'running';
  if (startScheme(leaderStarted) !== startScheme(now.started)) return 'running';
  if (leaderStarted !== now.started) return 'foreign';
  // The registered leader, a zombie or not: its group is not reaped yet.
  return 'running';
}

/**
 * Send `signal` to the process group `pgid` its registrant started, unless the
 * id now names another group (its leader's pid was reused by a process that
 * leads a group of its own): once a group has ended its id is free, and a kill
 * sent by the id alone would reach whatever took it. Returns whether it sent.
 * `sys` is for tests.
 */
export function signalGroup(pgid, leaderStarted, signal, sys = {}) {
  const { kill = (p, s) => process.kill(p, s) } = sys;
  if (groupState(pgid, leaderStarted, sys) !== 'running') return false;
  try {
    kill(-pgid, signal);
    return true;
  } catch {
    return false;
  }
}

/**
 * The running groups of `token`'s ownership: `[{ pgid, name, via }]`, an entry
 * that does not parse as `{ pgid: null }`. With `via`, only the entries
 * registered under that handle (its own and its descendants'); a scan whose
 * directories kept moving counts for every handle. `listed` is for tests.
 */
export function ownershipGroups(path, token, { via = null, sys, listed } = {}) {
  if (token === null || !UUID.test(token)) return [];
  const out = [];
  for (const { name, entry, moving } of ownershipEntries(path, token, { listed })) {
    if (entry === null) {
      if (via === null || moving) out.push({ pgid: null, name, via: [] });
      continue;
    }
    const chain = Array.isArray(entry.via) ? entry.via : [];
    if (via !== null && !chain.includes(via)) continue;
    if (groupState(entry.pgid, entry.leader_started, sys) !== 'running') continue;
    out.push({ pgid: entry.pgid, name, via: chain });
  }
  return out;
}

/** Whether a group of `record`'s ownership runs. */
export function ownershipRunning(path, record) {
  return ownershipGroups(path, tokenOf(record)).length > 0;
}

/** Close `token`'s open ownership directory, if it has one. */
export function closeOwnership(path, token) {
  if (token === null || !UUID.test(token)) return;
  try {
    renameSync(join(groupsDir(path), token), join(groupsDir(path), `${token}.closed.${randomUUID()}`));
  } catch (err) {
    if (err.code !== 'ENOENT') throw new HeavyLockError(`cannot close the ownership of ${token}: ${err.message}`);
  }
}

// Remove `token`'s closed ownership directories, then the groups directory
// once it is empty. Called only once they are closed and judged.
function removeOwnership(path, token) {
  for (const dir of ownershipDirs(path, token)) {
    if (CLOSED.test(dir.slice(groupsDir(path).length + 1))) rmSync(dir, { recursive: true, force: true });
  }
  try {
    rmdirSync(groupsDir(path));
  } catch { /* another ownership is there, or none is */ }
}

// Open the ownership directory of a holder that has just placed its lock.
function openOwnership(path, token) {
  for (let attempt = 0; ; attempt++) {
    try {
      mkdirSync(groupsDir(path), { recursive: true });
      mkdirSync(join(groupsDir(path), token));
      return;
    } catch (err) {
      // A releaser removed the empty groups directory between the two calls.
      if (err.code === 'ENOENT' && attempt < 10) continue;
      throw new HeavyLockError(`cannot open the ownership of ${token}: ${err.message}`);
    }
  }
}

// Every token whose ownership directories are there.
function ownershipTokens(path) {
  let names;
  try {
    names = readdirSync(groupsDir(path));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw new HeavyLockError(`cannot read ${groupsDir(path)}: ${err.message}`);
  }
  return [...new Set(names.map((n) => (UUID.test(n) ? n : CLOSED.exec(n)?.[1] ?? null)).filter(Boolean))];
}

/**
 * The running groups of an ownership whose token holds no lock: left, for one,
 * by an older harness that reaped a holder of this release by its pid while its
 * groups still ran. A new acquirer waits for them before it places the lock.
 */
export function orphanGroups(path) {
  const current = tokenOf(readLock(path)?.record);
  const out = [];
  for (const token of ownershipTokens(path)) {
    if (token === current) continue;
    for (const g of ownershipGroups(path, token)) out.push({ token, ...g });
  }
  return out;
}

// Close every foreign ownership, then remove each with no running group, and
// return the running groups of the rest (`[{ token, pgid, name, via }]`). Run by
// a holder that has just placed its lock, whose own token is `own`. Closing
// comes first: a process that joined an earlier holder and registers after the
// acquirer's last look (an older reaper left that holder's ownership open) then
// fails to register, and one that registered before the close is judged here,
// so the acquirer withdraws and waits for it instead of running beside it.
export function collectOwnerships(path, own) {
  const running = [];
  for (const token of ownershipTokens(path)) {
    if (token === own) continue;
    closeOwnership(path, token);
    const left = ownershipGroups(path, token);
    if (left.length > 0) {
      running.push(...left.map((g) => ({ token, ...g })));
      continue;
    }
    removeOwnership(path, token);
  }
  return running;
}

/**
 * Register the process group `pgid` in an ownership `{ path, token, chain }`,
 * before anything in it starts. Throws HeavyLockClosedError when the ownership
 * has been closed (its directory is gone): the registrant then starts nothing.
 * Returns `{ name, leaderStarted, unregister() }`; unregister removes this
 * entry only, wherever it lies now.
 */
export function registerGroup(ownership, pgid, { leaderStarted } = {}) {
  const { path, token, chain = [] } = ownership;
  if (token === null || !UUID.test(String(token))) throw new HeavyLockError(`the ownership token ${shown(token)} is not a UUID`);
  if (!Number.isInteger(pgid) || pgid <= 0) throw new HeavyLockError(`the process group ${shown(pgid)} is not a positive integer`);
  const started = leaderStarted === undefined ? processInfo(pgid)?.started ?? null : leaderStarted;
  const name = `${pgid}-${randomUUID()}.json`;
  const dir = join(groupsDir(path), token);
  const tmp = join(dir, `${name}.tmp`);
  const closed = () => new HeavyLockClosedError(`the heavy-work lock's ownership ${token} is closed; nothing more joins it`);
  try {
    writeFileSync(tmp, `${JSON.stringify({ pgid, leader_started: started, via: chain, at: new Date().toISOString() })}\n`, { flag: 'wx' });
  } catch (err) {
    if (err.code === 'ENOENT') throw closed();
    throw new HeavyLockError(`cannot register process group ${pgid}: ${err.message}`);
  }
  try {
    renameSync(tmp, join(dir, name));
  } catch (err) {
    if (err.code === 'ENOENT') throw closed();
    throw new HeavyLockError(`cannot register process group ${pgid}: ${err.message}`);
  }
  return {
    name,
    leaderStarted: started,
    unregister() {
      for (const d of [dir, ...ownershipDirs(path, token)]) {
        try {
          unlinkSync(join(d, name));
          return;
        } catch (err) {
          if (err.code !== 'ENOENT') throw new HeavyLockError(`cannot unregister ${name}: ${err.message}`);
        }
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The reap guard: a directory `<lock>.reap` holding one entry, named by its
// reaper's token and holding the reaper's record. A reaper places it whole, by
// renaming a directory it built aside onto the guard's name, which fails while
// another reaper's guard holds an entry (an empty guard is replaced). Returns
// whether this reaper now holds the guard.
function placeGuard(guard, self) {
  const tmp = `${guard}.${randomUUID()}.tmp`;
  try {
    mkdirSync(tmp);
    writeFileSync(join(tmp, self.token), `${JSON.stringify(self)}\n`, 'utf8');
    renameSync(tmp, guard);
    return true;
  } catch (err) {
    if (err.code === 'ENOTEMPTY' || err.code === 'EEXIST') return false;
    // A file there is the guard of a harness from before the guard was a
    // directory (never released). Its reaper cannot be judged by its entry, so
    // it is the operator's to remove.
    if (err.code === 'ENOTDIR') {
      throw new HeavyLockError(
        `${guard} is a reap guard file left by an older harness; remove it once no mutation harness runs in this repository`,
      );
    }
    throw new HeavyLockError(`cannot create ${guard}: ${err.message}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Remove the guard directory if it is empty; a reaper's guard never is.
function dropEmptyGuard(guard) {
  try {
    rmdirSync(guard);
  } catch (err) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(err.code)) {
      throw new HeavyLockError(`cannot remove ${guard}: ${err.message}`);
    }
  }
}

// Remove the stale lock `seen`, if it is still the lock. One reaper at a time,
// under the reap guard: without it, a slow reaper could remove the lock a
// faster one's run has just taken. A guard is taken from its reaper only once
// that reaper has stopped running, never for its age, since a reaper paused
// for a while is still a reaper. And a waiter takes only the guard it judged:
// judging takes a while (ps), and the guard a live reaper placed meanwhile must
// stay, or two reapers each remove a lock, the second the one the first's run
// took. So a waiter never removes the guard by its name, whose holder can
// change while it judges. It captures the dead reaper's entry by renaming it
// away under the entry's own name, which no process but that reaper uses: the
// rename takes that entry or, when another waiter took it first, nothing,
// however late it comes, and a live reaper's entry, under another name, is
// never touched. An entry leaves the guard only by its own reaper or by such a
// capture. Under the guard the reaper closes the holder's ownership, then
// judges it once more: a group still running there keeps the lock. Returns
// whether this call removed the lock. `running` and `judged` (called after the
// last read of the guard, before its capture) are for tests; `prefix` names the
// caller in its lines.
export function reapStale(path, seen, self, log, { running = holderRunning, judged = () => {}, prefix = 'mutation-harness' } = {}) {
  const guard = `${path}.reap`;
  if (!placeGuard(guard, self)) {
    let names;
    try {
      names = readdirSync(guard);
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw new HeavyLockError(`cannot read ${guard}: ${err.message}`);
    }
    for (const name of names) {
      const reaper = readLock(join(guard, name));
      if (reaper === null) continue;
      if (reaper.record !== null && reaper.record.token === name && running(reaper.record)) continue;
      judged();
      const captured = `${guard}.${randomUUID()}.captured`;
      try {
        renameSync(join(guard, name), captured);
      } catch (err) {
        if (err.code === 'ENOENT') continue;
        throw new HeavyLockError(`cannot capture ${join(guard, name)}: ${err.message}`);
      }
      rmSync(captured, { force: true });
      log(`${prefix}: removed the guard of a reaper that is not running (${guard})`);
    }
    dropEmptyGuard(guard);
    return false;
  }
  try {
    const now = readLock(path);
    if (now === null || now.raw !== seen.raw) return false;
    const token = tokenOf(seen.record);
    if (token !== null) {
      closeOwnership(path, token);
      if (ownershipGroups(path, token).length > 0) return false;
    }
    unlinkSync(path);
    if (token !== null) removeOwnership(path, token);
    const holder = seen.record;
    log(`${prefix}: removed a stale run lock (${holder ? `pid ${holder.pid}, ${holder.worktree}, which is not running` : 'unreadable'})`);
    return true;
  } finally {
    rmSync(join(guard, self.token), { force: true });
    dropEmptyGuard(guard);
  }
}

// ---------------------------------------------------------------------------
// The proof and joining.

const digest = (proof) => createHash('sha256').update(String(proof)).digest('hex');

/** A new proof, for a wrapper holder to hand its command. */
export const mintProof = () => randomBytes(32).toString('hex');

// The chain of handles AGENTIC_HEAVY_LOCK_VIA names: [] when it is unset or
// empty, null when it is not a chain of at most MAX_CHAIN handles.
export function parseChain(text) {
  if (text === undefined || text === '') return [];
  if (typeof text !== 'string') return null;
  const ids = text.split(',');
  return ids.length <= MAX_CHAIN && ids.every((id) => UUID.test(id)) ? ids : null;
}

/**
 * The running holder `env`'s proof lets a process join, or null: the proof
 * hashes to the digest a live record of the lock `path` keeps. A proof that
 * matches no live holder, a holder that is not running, or a record with no
 * ownership (its token is not a UUID) is no join. `chain` is null when
 * AGENTIC_HEAVY_LOCK_VIA is malformed.
 */
export function joinable(path, env = process.env) {
  const proof = env[PROOF_ENV];
  if (typeof proof !== 'string' || !HEX64.test(proof)) return null;
  const record = readLock(path)?.record;
  if (!record || typeof record.proof_digest !== 'string' || !HEX64.test(record.proof_digest)) return null;
  const got = Buffer.from(digest(proof), 'hex');
  const want = Buffer.from(record.proof_digest, 'hex');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  if (tokenOf(record) === null || !holderRunning(record)) return null;
  return { record, proof, chain: parseChain(env[VIA_ENV]) };
}

/** The live holder of `repoRoot`'s lock whose ownership `env` is inside, or null. */
export function holderOf(repoRoot, env = process.env) {
  if (typeof env[PROOF_ENV] !== 'string') return null;
  return joinable(lockPath(repoRoot), env)?.record ?? null;
}

/** How a record's holder is named in a line. */
export const holderName = (h) => shown(h.purpose || h.spec || 'a spec');

const sleep = (ms, signal) => new Promise((wake, fail) => {
  if (signal?.aborted) { fail(signal.reason); return; }
  const onAbort = () => { clearTimeout(timer); fail(signal.reason); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); wake(); }, ms);
  signal?.addEventListener('abort', onAbort, { once: true });
});

// Withdraw a lock just placed, before anything of it ran: its own (empty)
// ownership goes, then the lock, if the record is still its own.
function withdraw(path, record) {
  closeOwnership(path, record.token);
  removeOwnership(path, record.token);
  if (readLock(path)?.record?.token === record.token) unlinkSync(path);
}

// Open the ownership of the lock `record` has just placed and collect the
// foreign ones. Returns the running groups of foreign ownerships, after
// withdrawing the lock when there are any: the acquirer then waits for them.
function takeOwnership(path, record) {
  try {
    openOwnership(path, record.token);
    const late = collectOwnerships(path, record.token);
    if (late.length > 0) withdraw(path, record);
    return late;
  } catch (err) {
    if (readLock(path)?.record?.token === record.token) unlinkSync(path);
    throw err;
  }
}

// A process inside a holder's ownership whose holder has ended waits on its
// own ancestors when it waits for that ownership: they wait on it in turn.
const ownAncestors = (token, path, pid) => new HeavyLockError(
  `the holder of the heavy-work lock this process runs inside (token ${token}${pid ? `, pid ${pid}` : ''}) has ended `
  + `while its ownership still runs; waiting for it would wait on this process's own ancestors; its lock was ${path}`,
);

/**
 * Take the repository's heavy-work lock, waiting while another live holder, or
 * a running group of its ownership, holds it; or join the holder whose proof
 * `env` carries. Resolves a handle:
 *   { path, joined, record, token, chain, proof, ownership, release() }
 * `ownership` ({ path, token, chain }) is where the caller registers each
 * process group before it starts anything in it. A holder's release() closes
 * its ownership and throws HeavyLockBusyError, keeping the lock, while a group
 * of it runs; a joined handle's release() does nothing. `signal` (an
 * AbortSignal) cancels the wait: the promise rejects with its reason, nothing
 * placed. `mint` makes a wrapper holder: its record keeps the digest of
 * `handle.proof`. A process inside an ownership whose holder has ended, still
 * running, is refused (HeavyLockError) rather than left to wait on its own
 * ancestors, and so is a chain deeper than MAX_CHAIN. Repeated waiting lines
 * say how long the wait has lasted. `beforePlace` (called before each attempt
 * to place the lock) is for tests.
 */
export async function acquire(repoRoot, {
  kind = 'harness', purpose = '', spec = purpose, log = console.log, pollMs = 2000, reportMs = WAIT_REPORT_MS,
  prefix = 'mutation-harness', signal, env = process.env, mint = false, beforePlace = () => {},
} = {}) {
  signal?.throwIfAborted();
  const path = lockPath(repoRoot);
  const join_ = joinable(path, env);
  if (join_ !== null) {
    const h = join_.record;
    if (join_.chain === null || join_.chain.length >= MAX_CHAIN) {
      throw new HeavyLockError(`${VIA_ENV} is not a chain of fewer than ${MAX_CHAIN} handles; nesting this deep is refused`);
    }
    const chain = [...join_.chain, randomUUID()];
    log(`${prefix}: inside the heavy-work lock of ${holderName(h)} (pid ${h.pid}); not waiting`);
    return {
      path, joined: true, record: h, token: h.token, chain, proof: join_.proof,
      ownership: { path, token: h.token, chain },
      release() {},
    };
  }
  // The holder whose ownership this process was started inside, if any.
  const inherited = typeof env[PROOF_ENV] === 'string' ? parseChain(env[VIA_ENV])?.[0] ?? null : null;
  const proof = mint ? mintProof() : null;
  const record = {
    pid: process.pid,
    host: hostname(),
    started: processInfo(process.pid)?.started ?? null,
    token: randomUUID(),
    started_at: new Date().toISOString(),
    worktree: resolve(repoRoot),
    spec,
    schema: RECORD_SCHEMA,
    kind,
    purpose,
    ...(proof === null ? {} : { proof_digest: digest(proof) }),
  };
  const since = Date.now();
  let reported = null;
  let reportedAt = 0;
  const say = (key, line) => {
    if (key === reported && Date.now() - reportedAt < reportMs) return;
    log(key === reported ? `${line}; waited ${Math.round((Date.now() - since) / 1000)} s so far` : line);
    reported = key;
    reportedAt = Date.now();
  };
  for (;;) {
    signal?.throwIfAborted();
    let orphans = orphanGroups(path);
    if (orphans.length === 0) {
      beforePlace();
      let placed = false;
      try {
        placeExclusive(path, record);
        placed = true;
      } catch (err) {
        if (err.code !== 'EEXIST') throw new HeavyLockError(`cannot create the run lock ${path}: ${err.message}`);
      }
      if (placed) {
        orphans = takeOwnership(path, record);
        if (orphans.length === 0) break;
      }
    }
    if (inherited !== null && orphans.some((o) => o.token === inherited)) throw ownAncestors(inherited, path, null);
    const seen = readLock(path);
    if (seen === null) {
      if (orphans.length === 0) continue;
      const g = orphans.map((o) => o.pgid ?? 'unreadable').join(', ');
      say(`orphan:${g}`, `${prefix}: waiting for process group ${g} of an earlier holder (token ${orphans[0].token}), which still runs though its lock is gone; its lock was ${path}`);
    } else if (seen.record === null || !holderRunning(seen.record)) {
      const left = seen.record === null ? [] : ownershipGroups(path, tokenOf(seen.record));
      if (left.length === 0) {
        if (reapStale(path, seen, record, log, { prefix })) continue;
      } else {
        const h = seen.record;
        if (inherited !== null && h.token === inherited) throw ownAncestors(inherited, path, h.pid);
        say(`${h.token}:left`, `${prefix}: waiting for the run of ${holderName(h)} in ${h.worktree} `
          + `(pid ${h.pid} exited; its group ${left.map((o) => o.pgid ?? 'unreadable').join(', ')} still runs, since ${h.started_at}); its lock is ${path}`);
      }
    } else {
      const h = seen.record;
      say(h.token, `${prefix}: waiting for the run of ${holderName(h)} in ${h.worktree} `
        + `(pid ${h.pid} on ${h.host}, since ${h.started_at}); its lock is ${path}`);
    }
    await sleep(pollMs, signal);
  }
  if (reported !== null) log(`${prefix}: the run lock is ours after ${Math.round((Date.now() - since) / 1000)} s`);
  const chain = [record.token];
  return {
    path, joined: false, record, token: record.token, chain, proof,
    ownership: { path, token: record.token, chain },
    // `beforeClose` (called before the ownership is closed) is for tests.
    release({ beforeClose = () => {} } = {}) {
      beforeClose();
      closeOwnership(path, record.token);
      const left = ownershipGroups(path, record.token);
      if (left.length > 0) {
        const groups = left.map((o) => o.pgid ?? 'unreadable').join(', ');
        throw new HeavyLockBusyError(`process group ${groups} of this lock's ownership still runs; the lock is kept`, left);
      }
      removeOwnership(path, record.token);
      if (readLock(path)?.record?.token === record.token) unlinkSync(path);
    },
  };
}
