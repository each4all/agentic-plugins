// plugins/orchestrator/scripts/lib/heavy-check.mjs
//
// ADR-0023, amendments of 2026-11-22 and 2026-11-24, the harness bullet (C154)
// — the record of an autopilot verification check, and what it lets go.
//
// Every check the driver runs has a record, which verify-run.mjs writes in the
// run's directory (`<run dir>/checks/<seq>-<index>.json`), apart from the
// check's scratch, before it makes that scratch: it names the check and whether
// the check runs the mutation harness (a `mutate` check does). A record that
// cannot be written leaves the check unstarted and its scratch unmade. A check
// that runs the harness passes it the record's path in its environment
// (`CHECK_RECORD_ENV`), into which the harness writes, before its first
// launch, the lock path and token of the heavy-work ownership it holds or
// joined, with the device and inode of the directory holding that lock
// (`recordOwnership`).
//
// `checkHolds` is the one judgment every remover of a check's entries or
// scratch takes (verify-run's release, the run's scratch release and sweep, the
// leftover sweep): null when the directory may go, else why it is kept.
//
//   - a record that does not read whole, or is missing where the root's marker
//     says its checks have records: kept;
//   - a record that names no harness (an ordinary test check), or the harness
//     and no ownership (no launch of it holds an entry): nothing to consult;
//   - an ownership named: the lock's directory must be the one recorded (same
//     device and inode); the ownership's entries are then judged through a
//     scope collector (lib/heavy-scope.mjs: a scope whose harness is proven
//     gone is killed first, then each read once), and an entry whose group
//     runs or whose scope is not read gone keeps the directory. An ownership that reads absent (no
//     directory of its token, open or closed, or no groups directory) was
//     retired: every remover of an ownership removes it only once none of its
//     entries holds a running group or a scope not read gone;
//   - in every case, a heavy-work entry of that lock that names a copy (by
//     device and inode) inside the directory, under its name or the
//     `.removing-` name a removal gives it, keeps it.
//
// Mount crossing. Node has no openat2. On Linux the reading is pinned: the
// lock's directory is opened once (no link followed) and its mount id read
// from the descriptor's fdinfo; each directory and entry below it (the groups
// directory, each ownership directory, each entry) is opened relative to its
// parent's descriptor (through `/proc/self/fd/<fd>/<name>`, the last name
// never followed), and must be on the lock directory's device and mount id;
// directories are listed and entries read through their descriptors. A mount
// placed over the groups directory or an entry, or a mount id that cannot be
// read, keeps the check's directory. The groups of an ownership with entries
// are judged (heavy-lock's ownershipGroups) on the entries so read, and an
// entry it reads again is read here, pinned, too. KNOWN LIMIT: off Linux (no
// fdinfo) each directory is checked by device and link only, so a bind mount
// of the same file system is not told apart there; and an entry on another
// device than its directory (an overlay that does not keep one) keeps the
// check's directory.

import { closeSync, constants as FS, fstatSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';

import { ownershipGroups } from './heavy-lock.mjs';
import { heldText, scopeCollector } from './heavy-scope.mjs';

export const CHECK_RECORD_SCHEMA = 'agentic-check-record-1';
/**
 * The environment variable that hands a `mutate` check's record path to the
 * harness (C154 F1). The harness reads it and removes it from its own
 * environment before it loads a spec or starts a test run, so no test it runs
 * inherits it; an older harness ignores it. An environment variable, not a
 * flag offered after reading the harness's text: that read was a load edge to
 * the harness for the test selector, and a guess at the harness's spelling.
 */
export const CHECK_RECORD_ENV = 'AGENTIC_CHECK_RECORD';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const CLOSED = /^([0-9a-f-]{36})\.closed\.[0-9a-f-]{36}$/;
const REMOVING = '.removing-';

/** The record path of check `index` of step `seq`, in the run's directory. */
export function checkRecordPath(runDir, seq, index) {
  return join(runDir, 'checks', `${seq}-${index}.json`);
}

function writeAtomic(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(value)}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * Write a check's record before its scratch is made. Throws when it cannot be
 * written: the check does not start.
 */
export function writeCheckRecord(file, { check, runsHarness }) {
  writeAtomic(file, { schema: CHECK_RECORD_SCHEMA, check, runs_harness: runsHarness === true, ownership: null });
}

/** A record's value, or { problem } when it does not read whole. */
export function readCheckRecord(file) {
  let rec;
  try {
    if (!lstatSync(file).isFile()) return { problem: `${file} is not a regular file` };
    rec = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    return { problem: err?.code === 'ENOENT' ? `${file} is missing` : `${file} does not read (${err?.code ?? err?.message ?? err})` };
  }
  if (rec === null || typeof rec !== 'object' || rec.schema !== CHECK_RECORD_SCHEMA || typeof rec.runs_harness !== 'boolean'
    || rec.check === null || typeof rec.check !== 'object' || Array.isArray(rec.check) || !('ownership' in rec)) {
    return { problem: `${file} is not a check record` };
  }
  if (rec.ownership !== null) {
    if (!rec.runs_harness) return { problem: `${file} names an ownership for a check that runs no harness` };
    const o = rec.ownership;
    const ok = o && typeof o === 'object' && typeof o.lock_path === 'string' && isAbsolute(o.lock_path)
      && typeof o.token === 'string' && UUID.test(o.token)
      && o.lock_dir && DECIMAL.test(String(o.lock_dir.dev)) && DECIMAL.test(String(o.lock_dir.ino));
    if (!ok) return { problem: `${file} names an ownership that does not read whole` };
  }
  return { record: rec };
}

/**
 * The harness's write, before its first launch: the ownership it holds or
 * joined, with the device and inode of the directory holding its lock. Throws
 * when the record cannot be read or written: the harness launches nothing.
 */
export function recordOwnership(file, { lockPath, token }) {
  const read = readCheckRecord(file);
  if (read.problem) throw new Error(`the check record ${read.problem}`);
  const st = lstatSync(dirname(lockPath), { bigint: true });
  writeAtomic(file, { ...read.record, ownership: { lock_path: lockPath, token, lock_dir: { dev: String(st.dev), ino: String(st.ino) } } });
}

const within = (child, parent) => {
  const rel = relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

// A descriptor's mount id, from its fdinfo; null when it cannot be read or
// describes another inode. `mnt_id:` is there since Linux 3.15, `ino:` only
// since 5.14: the descriptor is this process's own and held open, so the
// inode cross-check is made where the kernel gives the line and an older
// kernel's fdinfo, without it, is read by its mount id alone (C154 F1).
export function fdMountId(fd, { readInfo = (n) => readFileSync(`/proc/self/fdinfo/${n}`, 'utf8') } = {}) {
  try {
    const text = readInfo(fd);
    const mnt = /^mnt_id:\s*(\d+)$/m.exec(text);
    const ino = /^ino:\s*(\d+)$/m.exec(text);
    if (mnt === null) return null;
    if (ino !== null && BigInt(ino[1]) !== fstatSync(fd, { bigint: true }).ino) return null;
    return mnt[1];
  } catch {
    return null;
  }
}

const DIR_FLAGS = FS.O_RDONLY | (FS.O_DIRECTORY ?? 0) | (FS.O_NOFOLLOW ?? 0);
const FILE_FLAGS = FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0);

// The pinned reader of the lock's directory (Linux): `root` its descriptor,
// `mnt` its mount id. `open(parentFd, name, dir)` answers a descriptor on the
// lock's device and mount, null when the name is absent (ENOENT), and throws
// otherwise (a link, a mount crossed, another kind of file).
function pinnedReader(lockDirPath, dev, ino, mountOf) {
  const close = (fd) => { try { closeSync(fd); } catch { /* closed */ } };
  const check = (fd, what, dir) => {
    const st = fstatSync(fd, { bigint: true });
    if (dir ? !st.isDirectory() : !st.isFile()) throw new Error(`${what} is not a ${dir ? 'directory' : 'file'}`);
    if (st.dev !== dev) throw new Error(`${what} lies on another mount than the lock`);
    const mnt = mountOf(fd);
    if (mnt === null) throw new Error(`the mount of ${what} cannot be read`);
    return mnt;
  };
  const root = openSync(lockDirPath, DIR_FLAGS);
  let mnt;
  try {
    mnt = check(root, lockDirPath, true);
    if (fstatSync(root, { bigint: true }).ino !== ino) throw new Error(`${lockDirPath} is not the directory its record names`);
  } catch (err) {
    close(root);
    throw err;
  }
  const fds = [root];
  return {
    root,
    open(parent, name, what, dir) {
      let fd;
      try {
        fd = openSync(`/proc/self/fd/${parent}/${name}`, dir ? DIR_FLAGS : FILE_FLAGS);
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        if (err.code === 'ENOTDIR' && dir) throw new Error(`${what} is not a directory`);
        if (err.code === 'ELOOP') throw new Error(`${what} is a link`);
        throw new Error(`${what} cannot be opened (${err.code ?? err.message})`);
      }
      fds.push(fd);
      if (check(fd, what, dir) !== mnt) throw new Error(`a mount is placed over ${what}`);
      return fd;
    },
    list: (fd) => readdirSync(`/proc/self/fd/${fd}`),
    read: (fd) => readFileSync(fd, 'utf8'),
    // A descriptor closed once it is used (an entry read, a directory looked
    // for again): a scan holds only its listed directories' descriptors open.
    done: (fd) => {
      const i = fds.indexOf(fd);
      if (i >= 0) fds.splice(i, 1);
      close(fd);
    },
    close: () => { for (const fd of fds) close(fd); },
  };
}

// A directory on the lock's device, reached through no link: its names, or
// null when it is absent (ENOENT). Throws why it cannot be read otherwise.
// The reading off Linux, where no fdinfo names a descriptor's mount.
function listOnDevice(dir, dev) {
  let st;
  try {
    st = lstatSync(dir, { bigint: true });
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`${dir} cannot be read (${err.code ?? err.message})`);
  }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new Error(`${dir} is not a directory`);
  if (st.dev !== dev) throw new Error(`${dir} lies on another mount than the lock`);
  try {
    return readdirSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`${dir} cannot be listed (${err.code ?? err.message})`);
  }
}

// Every entry of every ownership of the lock: [{ token, name, entry }]. A
// directory that moves while it is read (its holder closed it, renaming it
// `.closed.`) makes the scan start again, as heavy-lock's own scan does, so
// an entry is never lost between its two names; a scan that keeps finding its
// directories moving throws, and the directory is kept. `pinned` reads under
// the lock directory's descriptor (Linux); otherwise by path.
const MAX_SCANS = 100;
function lockEntries(lockPath, dev, { pinned, mountOf, ino }) {
  const groupsName = `${basename(lockPath)}.groups`;
  const groups = `${lockPath}.groups`;
  for (let scan = 0; scan < MAX_SCANS; scan++) {
    const out = [];
    let moved = false;
    const reader = pinned ? pinnedReader(dirname(lockPath), dev, ino, mountOf) : null;
    try {
      let groupsFd = null;
      let names;
      if (reader) {
        groupsFd = reader.open(reader.root, groupsName, groups, true);
        names = groupsFd === null ? [] : reader.list(groupsFd);
      } else {
        names = listOnDevice(groups, dev) ?? [];
      }
      for (const n of names) {
        const token = UUID.test(n) ? n : CLOSED.exec(n)?.[1] ?? null;
        if (token === null) continue;
        const dir = join(groups, n);
        let dirFd = null;
        let files;
        if (reader) {
          dirFd = reader.open(groupsFd, n, dir, true);
          files = dirFd === null ? null : reader.list(dirFd);
        } else {
          files = listOnDevice(dir, dev);
        }
        if (files === null) { moved = true; continue; }
        for (const f of files.filter((x) => x.endsWith('.json'))) {
          let entry = null;
          try {
            let text;
            if (reader) {
              const fd = reader.open(dirFd, f, join(dir, f), false);
              if (fd === null) throw Object.assign(new Error('gone'), { code: 'ENOENT' });
              try {
                text = reader.read(fd);
              } finally {
                reader.done(fd);
              }
            } else {
              const st = lstatSync(join(dir, f), { bigint: true });
              if (st.dev !== dev || !st.isFile()) throw new Error(`${join(dir, f)} is not a file on the lock's mount`);
              text = readFileSync(join(dir, f), 'utf8');
            }
            entry = JSON.parse(text);
          } catch (err) {
            if (err?.code === 'ENOENT') {
              // Unregistered, or its directory moved since it was listed.
              if (reader) {
                const again = reader.open(groupsFd, n, dir, true);
                if (again === null) moved = true;
                else reader.done(again);
              } else if (listOnDevice(dir, dev) === null) moved = true;
              continue;
            }
            if (err instanceof SyntaxError) entry = null;
            else throw err;
          }
          out.push({ token, dir, name: f, entry });
        }
      }
    } finally {
      reader?.close();
    }
    if (!moved) return out;
  }
  throw new Error(`the ownership directories under ${groups} kept moving while they were read`);
}

// Whether `copy` ({ path, dev, ino }) lies inside one of `dirs` (a check's
// directory under its name and its removal names), by device and inode.
function copyInside(copy, dirs) {
  if (!copy || typeof copy.path !== 'string' || !DECIMAL.test(String(copy.dev)) || !DECIMAL.test(String(copy.ino))) return false;
  const [orig] = dirs;
  for (const d of dirs) {
    let candidate = null;
    if (within(copy.path, d)) candidate = copy.path;
    else if (within(copy.path, orig)) candidate = join(d, relative(orig, copy.path));
    if (candidate === null) continue;
    try {
      const st = lstatSync(candidate, { bigint: true });
      if (String(st.dev) === String(copy.dev) && String(st.ino) === String(copy.ino)) return true;
    } catch (err) {
      // Only absence is read as absence; any other failure keeps the directory.
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw new Error(`the copy ${candidate} cannot be read (${err?.code ?? err?.message})`);
    }
  }
  return false;
}

/**
 * Whether check `dirs[0]` (its directory; further names: what a removal renamed
 * it to) is kept by its record `recordFile`: null when it may go, else why.
 * `required`: the root's marker says its checks have records, so a missing one
 * keeps the directory. `scopes` is a collector (lib/heavy-scope.mjs); one per
 * call by default. Never throws.
 */
export function checkHolds({
  recordFile, dirs = [], required = true, scopes = scopeCollector(), groups = ownershipGroups,
  pinned = process.platform === 'linux', mountOf = fdMountId,
}) {
  try {
    const read = readCheckRecord(recordFile);
    if (read.problem) {
      if (!required && /is missing$/.test(read.problem)) return null;
      return `its check record ${read.problem}`;
    }
    const rec = read.record;
    if (!rec.runs_harness || !rec.ownership) return null;
    const { lock_path: lockPath, token, lock_dir: lockDir } = rec.ownership;
    const lockDirPath = dirname(lockPath);
    let st;
    try {
      st = lstatSync(lockDirPath, { bigint: true });
    } catch (err) {
      return `the directory of the heavy-work lock its harness held, ${lockDirPath}, cannot be read (${err.code ?? err.message})`;
    }
    if (st.isSymbolicLink() || !st.isDirectory() || String(st.dev) !== String(lockDir.dev) || String(st.ino) !== String(lockDir.ino)) {
      return `the directory of the heavy-work lock its harness held, ${lockDirPath}, is not the one its record names`;
    }
    const how = { pinned, mountOf, ino: st.ino };
    const entries = lockEntries(lockPath, st.dev, how);
    const whole = (entry) => (Number.isInteger(entry?.pgid) && entry.pgid > 0 ? entry : null);
    const own = entries.filter((e) => e.token === token);
    if (own.length > 0) {
      // Every row is held: a group that runs, or a scope not read gone (a
      // scope read gone whose group has ended is no row). The groups are
      // judged on the entries read here, and an entry is read again here
      // too, so the judgment reads nothing by path.
      const reread = (_dir, name) => {
        const again = lockEntries(lockPath, st.dev, how).find((e) => e.token === token && e.name === name);
        return again ? { dir: again.dir, entry: whole(again.entry) } : { absent: true };
      };
      const held = groups(lockPath, token, {
        scopes, reread, entries: own.map((e) => ({ dir: e.dir, name: e.name, entry: whole(e.entry) })),
      });
      if (held.length > 0) return `its harness's test run ${held.map(heldText).join(', ')} still runs or is not read gone`;
    }
    const copies = entries.filter((e) => copyInside(e.entry?.copy, dirs));
    if (copies.length > 0) return `the heavy-work entry ${copies[0].name} names a copy inside it`;
    const again = lstatSync(lockDirPath, { bigint: true });
    if (again.dev !== st.dev || again.ino !== st.ino) return `the directory of the heavy-work lock ${lockDirPath} changed while it was read`;
    return null;
  } catch (err) {
    return `its harness's ownership cannot be read (${String(err?.message ?? err).slice(0, 200)})`;
  }
}

/** The names a check directory goes by: itself, and for a `.removing-` name the original. */
export function checkDirNames(dir) {
  const name = basename(dir);
  if (!name.startsWith(REMOVING)) return [dir];
  const orig = name.slice(REMOVING.length).replace(/\.\d+\.\d+$/, '');
  return [join(dirname(dir), orig), dir];
}
