// scripts/lib/agentic-dir.mjs — the directories a runbook makes for the text
// an agent writes and for a command's persona operation, made, marked and
// released only on a proof that this CLI made them (ADR-0059 Decision 9 and
// Decision 10, C175).
//
// A runbook block that makes a directory with `mktemp -d` has nothing but the
// path's name and location to go by when it removes it, and both are what a
// model transcribes from one call to the next. So the CLI makes the directory
// itself and writes a marker into it (`.agentic-dir.json`) that names the
// directory by its device, inode, basename, owner and parent, with an id drawn
// for this directory alone. The release removes a directory only while every
// check of that proof holds, claims it first (an exclusive `mkdir` of a
// `.removing-<name>` placeholder, then a rename onto it), and removes nothing
// recursively or through a link.
//
// The persona CLIs (generated from persona-pipeline) and the orchestrator's
// CLI (a byte copy under the COPIED notice) both make and release the same
// kinds, so either judges what the other made. Node builtins only; every
// system call goes through the `sys` seam so the tests can fail one call at a
// time. Nothing here prints: the CLIs print the report this module returns.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const DIR_MARKER_FILE = '.agentic-dir.json';
export const DIR_MARKER_SCHEMA = 'agentic-dir-1';
export const REMOVING_PREFIX = '.removing-';
export const NESTED_OP_NAME = 'op';
/** The top-level kinds and the basename prefix each is made under. */
export const DIR_KINDS = Object.freeze({ text: 'agentic-text', op: 'agentic-op' });
export const CONTROL_FILE_MAX = 64 * 1024;

const TOP_NAME_RE = /^agentic-(text|op)\.([A-Za-z0-9]{6,})$/;
const MARKER_ID_RE = /^[0-9a-f]{32}$/;
const DECIMAL_RE = /^(0|[1-9][0-9]*)$/;
const SUFFIX_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const SUFFIX_LENGTH = 10;
const MAKE_ATTEMPTS = 16;
// A path a single-quoted shell literal on one line cannot carry
// (Decision 10, item 1): a quote, or a control character.
const UNCARRIABLE_RE = /['\u0000-\u001f\u007f]/;

// The transport schema's identifier forms (holds.mjs, and the orchestrator's
// holds-records.mjs), restated: this module is copied byte for byte into the
// orchestrator and imports no plugin's own module.
// tests/persona-pipeline/test-agentic-dir-make.mjs holds the three equal.
export const OPERATION_ID_RE = /^op-\d{8}T\d{6}Z-[0-9a-f]{8}$/;
export const MACRO_ID_RE = /^macro-[a-z][a-z0-9-]*-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
export const SUBTASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const OPERATION_TRANSPORT_SCHEMA = 'agentic-persona-op-transport-1';
export const OPERATION_TRANSPORT_FILE = 'operation.json';
const TRANSPORT_STATES = Object.freeze(['opening', 'open', 'closed']);

/**
 * Whether `t` is a whole operation transport record (ADR-0068 Decision 2,
 * N4): the schema holds.mjs reads and writes, with the optional
 * `dir_marker_id` of the operation directory's marker (ADR-0059 Decision 9,
 * item 3), which when present is a marker id.
 */
export function validateOperationTransport(t) {
  return t !== null && typeof t === 'object' && !Array.isArray(t) && t.schema === OPERATION_TRANSPORT_SCHEMA
    && typeof t.operation_id === 'string' && OPERATION_ID_RE.test(t.operation_id)
    && typeof t.kind === 'string' && /^[a-z]+$/.test(t.kind)
    && typeof t.macro_id === 'string' && MACRO_ID_RE.test(t.macro_id)
    && typeof t.subtask_id === 'string' && SUBTASK_ID_RE.test(t.subtask_id)
    && typeof t.branch === 'string' && t.branch.length > 0
    && typeof t.opened_at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(t.opened_at)
    && (t.workflow_id === null || typeof t.workflow_id === 'string')
    && TRANSPORT_STATES.includes(t.state)
    && (t.dir_marker_id === undefined || (typeof t.dir_marker_id === 'string' && MARKER_ID_RE.test(t.dir_marker_id)));
}

/** The system calls this module makes, each replaceable by a test. */
export const defaultSys = Object.freeze({
  platform: () => process.platform,
  geteuid: () => (typeof process.geteuid === 'function' ? process.geteuid() : undefined),
  lstat: (p) => fs.lstatSync(p, { bigint: true }),
  stat: (p) => fs.statSync(p, { bigint: true }),
  fstat: (fd) => fs.fstatSync(fd, { bigint: true }),
  realpath: (p) => fs.realpathSync.native(p, { encoding: 'buffer' }),
  open: (p, flags, mode) => fs.openSync(p, flags, mode),
  read: (fd, buf, off, len) => fs.readSync(fd, buf, off, len, null),
  write: (fd, buf) => fs.writeSync(fd, buf),
  close: (fd) => fs.closeSync(fd),
  readdir: (p) => fs.readdirSync(p, { encoding: 'buffer' }),
  mkdir: (p, mode) => fs.mkdirSync(p, { mode }),
  chmod: (p, mode) => fs.chmodSync(p, mode),
  rename: (a, b) => fs.renameSync(a, b),
  unlink: (p) => fs.unlinkSync(p),
  rmdir: (p) => fs.rmdirSync(p),
  randomBytes: (n) => randomBytes(n),
  now: () => new Date(),
});

const sysOf = (sys) => (sys ? { ...defaultSys, ...sys } : defaultSys);
const codeOf = (err) => (err && typeof err.code === 'string' ? err.code : 'EUNKNOWN');
const sameId = (a, b) => typeof a === 'bigint' && typeof b === 'bigint' && a === b;
// Strict UTF-8 that keeps a byte order mark, so a file JSON.parse would refuse
// elsewhere (holds.mjs reads with no BOM stripping) is refused here too.
const strictText = (buf) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);

/**
 * A directory's entry names, each decoded strictly: a name that is not UTF-8
 * which round-trips is `null`, an entry no check can name by a string (a
 * lossy decoding would name another entry, or none).
 */
function listNames(dir, sys) {
  return sys.readdir(dir).map((n) => {
    if (typeof n === 'string') return n;
    try {
      const text = strictText(n);
      return Buffer.from(text, 'utf8').equals(n) ? text : null;
    } catch {
      return null;
    }
  });
}

/** The platform check of Decision 9, item 2: `null`, or why not. */
function platformUnsupported(sys) {
  if (sys.platform() === 'win32') return 'win32';
  const euid = sys.geteuid();
  if (typeof euid !== 'number' || !Number.isInteger(euid) || euid < 0) return 'no-euid';
  return null;
}

/**
 * Item 3's path check, with no file system call: `{ parent, base, name,
 * kind, claimed }`, or `{ reason }` for a path of another form.
 */
export function checkPath(p) {
  if (typeof p !== 'string' || p === '' || !p.startsWith('/')) return { reason: 'path-form' };
  if (p.length > 1 && p.endsWith('/')) return { reason: 'path-form' };
  if (p.includes('//') || p.includes('\0')) return { reason: 'path-form' };
  const parts = p.split('/').slice(1);
  if (parts.some((c) => c === '.' || c === '..' || c === '')) return { reason: 'path-form' };
  const base = parts[parts.length - 1];
  const claimed = base.startsWith(REMOVING_PREFIX);
  const name = claimed ? base.slice(REMOVING_PREFIX.length) : base;
  const m = TOP_NAME_RE.exec(name);
  if (!m) return { reason: 'path-form' };
  const parent = parts.length === 1 ? '/' : `/${parts.slice(0, -1).join('/')}`;
  return { parent, base, name, kind: m[1], claimed };
}

const join = (dir, name) => (dir === '/' ? `/${name}` : `${dir}/${name}`);

// --- control files ----------------------------------------------------------

/**
 * Read a control file without following a link (item 3): `{ absent: true }`,
 * `{ value }`, `{ invalid: reason }` (it reads, and is not one), or
 * `{ error: code }` (a system call failed). The descriptor is closed on every
 * path.
 */
export function readControlFile(file, sysIn) {
  const sys = sysOf(sysIn);
  let st;
  try {
    st = sys.lstat(file);
  } catch (err) {
    return codeOf(err) === 'ENOENT' ? { absent: true } : { error: codeOf(err) };
  }
  if (!st.isFile()) return { invalid: 'not-regular' };
  if (st.nlink !== 1n) return { invalid: 'nlink' };
  if (st.size > BigInt(CONTROL_FILE_MAX)) return { invalid: 'size' };
  let fd;
  try {
    fd = sys.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  } catch (err) {
    if (codeOf(err) === 'ELOOP') return { invalid: 'not-regular' };
    return { error: codeOf(err) };
  }
  try {
    let fst;
    try {
      fst = sys.fstat(fd);
    } catch (err) {
      return { error: codeOf(err) };
    }
    if (!fst.isFile()) return { invalid: 'not-regular' };
    if (fst.nlink !== 1n) return { invalid: 'nlink' };
    if (!sameId(fst.dev, st.dev) || !sameId(fst.ino, st.ino)) return { invalid: 'replaced' };
    if (fst.size > BigInt(CONTROL_FILE_MAX)) return { invalid: 'size' };
    const buf = Buffer.alloc(CONTROL_FILE_MAX + 1);
    let len = 0;
    try {
      for (;;) {
        const n = sys.read(fd, buf, len, buf.length - len);
        if (n === 0) break;
        len += n;
        if (len > CONTROL_FILE_MAX) return { invalid: 'size' };
      }
    } catch (err) {
      return { error: codeOf(err) };
    }
    let text;
    try {
      text = strictText(buf.subarray(0, len));
    } catch {
      return { invalid: 'encoding' };
    }
    try {
      return { value: JSON.parse(text) };
    } catch {
      return { invalid: 'parse' };
    }
  } finally {
    try { sys.close(fd); } catch { /* closed or never usable; nothing to keep */ }
  }
}

// --- the directory and its marker ------------------------------------------

/**
 * Whether `marker` names the directory: its schema, kind, basename, device
 * and inode, owner, and parent (`parent` is `{ path?, dev, ino }`, the path
 * only for a top-level directory).
 */
function markerMatches(marker, { kind, name, st, euid, parent }) {
  if (marker === null || typeof marker !== 'object' || Array.isArray(marker)) return 'marker-schema';
  if (marker.schema !== DIR_MARKER_SCHEMA) return 'marker-schema';
  if (typeof marker.id !== 'string' || !MARKER_ID_RE.test(marker.id)) return 'marker-schema';
  if (typeof marker.made_at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{3})?Z$/.test(marker.made_at)) return 'marker-schema';
  if (typeof marker.dev !== 'string' || !DECIMAL_RE.test(marker.dev) || typeof marker.ino !== 'string' || !DECIMAL_RE.test(marker.ino)) return 'marker-schema';
  const mp = marker.parent;
  if (mp === null || typeof mp !== 'object' || typeof mp.dev !== 'string' || !DECIMAL_RE.test(mp.dev)
    || typeof mp.ino !== 'string' || !DECIMAL_RE.test(mp.ino)) return 'marker-schema';
  if (marker.kind !== kind) return 'marker-kind';
  if (marker.name !== name) return 'marker-name';
  if (marker.dev !== String(st.dev) || marker.ino !== String(st.ino)) return 'marker-identity';
  if (marker.uid !== euid) return 'marker-uid';
  if (mp.dev !== String(parent.dev) || mp.ino !== String(parent.ino)) return 'marker-parent';
  if (parent.path !== undefined) {
    if (mp.path !== parent.path) return 'marker-parent';
  } else if (mp.path !== undefined) {
    return 'marker-parent';
  }
  return null;
}

/**
 * Item 3's directory and marker checks of a top-level directory at `dirPath`
 * (named `name` in its marker; `dirPath` may be its `.removing-` path).
 * `{ ok: true, marker, st }`, or `{ outcome: 'not-owned' | 'error', reason,
 * code? }`, or `{ gone: true }` when nothing is there.
 */
function checkTopLevel(dirPath, { name, kind }, sys, euid) {
  let st;
  try {
    st = sys.lstat(dirPath);
  } catch (err) {
    if (codeOf(err) === 'ENOENT') return { gone: true };
    return { outcome: 'error', reason: 'lookup', code: codeOf(err) };
  }
  if (st.isSymbolicLink()) return { outcome: 'not-owned', reason: 'symlink' };
  if (!st.isDirectory()) return { outcome: 'not-owned', reason: 'not-directory' };
  if (st.uid !== BigInt(euid)) return { outcome: 'not-owned', reason: 'uid' };
  const parentPath = path.posix.dirname(dirPath);
  let real;
  try {
    real = decodePath(sys.realpath(parentPath));
  } catch (err) {
    return { outcome: 'error', reason: 'parent-lookup', code: codeOf(err) };
  }
  if (real === null || real !== parentPath) return { outcome: 'not-owned', reason: 'parent-path' };
  let pst;
  try {
    pst = sys.stat(parentPath);
  } catch (err) {
    return { outcome: 'error', reason: 'parent-lookup', code: codeOf(err) };
  }
  const read = readControlFile(join(dirPath, DIR_MARKER_FILE), sys);
  if (read.absent) return { outcome: 'not-owned', reason: 'marker-absent' };
  if (read.error) return { outcome: 'error', reason: 'marker-read', code: read.error };
  if (read.invalid) return { outcome: 'not-owned', reason: `marker-${read.invalid}` };
  const bad = markerMatches(read.value, { kind, name, st, euid, parent: { path: parentPath, dev: pst.dev, ino: pst.ino } });
  if (bad) return { outcome: 'not-owned', reason: bad };
  return { ok: true, marker: read.value, st };
}

/**
 * ADR-0059 Decision 9, item 3 (**The operation**) — the marker id an
 * operation's first write records in its transport (`dir_marker_id`): the id
 * of the marker of the operation directory at `dirPath`, when that directory
 * passes the directory, control-file and marker checks the release applies to
 * it, as a top-level `agentic-op.*` or as the nested `op` of a text directory
 * that passes them itself. Otherwise `null` (a `mktemp -d` directory, a
 * marker refused or unreadable, a platform the release does not support), and
 * the write opens its operation with no field, as before. It changes nothing
 * and never throws.
 */
export function operationDirMarkerId(dirPath, { sys: sysIn } = {}) {
  try {
    const sys = sysOf(sysIn);
    if (platformUnsupported(sys) || typeof dirPath !== 'string' || UNCARRIABLE_RE.test(dirPath)) return null;
    const euid = sys.geteuid();
    const p = checkPath(dirPath);
    if (!p.reason) {
      if (p.kind !== 'op' || p.claimed) return null;
      const top = checkTopLevel(dirPath, { name: p.name, kind: 'op' }, sys, euid);
      return top.ok ? top.marker.id : null;
    }
    if (path.posix.basename(dirPath) !== NESTED_OP_NAME) return null;
    const parentPath = path.posix.dirname(dirPath);
    const pp = checkPath(parentPath);
    if (pp.reason || pp.kind !== 'text' || pp.claimed) return null;
    const parent = checkTopLevel(parentPath, { name: pp.name, kind: 'text' }, sys, euid);
    if (!parent.ok) return null;
    const est = sys.lstat(dirPath);
    if (!est.isDirectory() || est.uid !== BigInt(euid)) return null;
    const read = readControlFile(join(dirPath, DIR_MARKER_FILE), sys);
    if (!Object.hasOwn(read, 'value')) return null;
    const bad = markerMatches(read.value, { kind: 'op', name: NESTED_OP_NAME, st: est, euid, parent: { dev: parent.st.dev, ino: parent.st.ino } });
    return bad ? null : read.value.id;
  } catch {
    return null;
  }
}

// A real path, as a string, or null when it is not UTF-8 that round-trips.
function decodePath(buf) {
  if (typeof buf === 'string') return buf;
  try {
    return strictText(buf);
  } catch {
    return null;
  }
}

/**
 * The operation check of item 3: `null` when it passes, or `{ outcome,
 * reason, code? }`.
 */
function checkOperation(dir, markerId, sys) {
  const read = readControlFile(join(dir, OPERATION_TRANSPORT_FILE), sys);
  if (read.absent) return null;
  if (read.error) return { outcome: 'error', reason: 'operation-read', code: read.error };
  if (read.invalid) return { outcome: 'refused', reason: `operation-${read.invalid}` };
  const t = read.value;
  if (!validateOperationTransport(t)) return { outcome: 'refused', reason: 'operation-malformed' };
  if (t.state !== 'closed') return { outcome: 'refused', reason: 'operation-not-closed' };
  if (t.dir_marker_id !== markerId) return { outcome: 'refused', reason: 'operation-unbound' };
  return null;
}

/**
 * The entries check and the operation check of a proven directory (item 3):
 * `null` when they pass, or `{ outcome: 'refused' | 'error', reason, entry?,
 * code? }`.
 */
// `{ stop }` when a check stops the release, or `{ op }`: the identity of the
// nested op that passed, which the removal descends into and no other.
function checkContents(dirPath, { kind, marker, st }, sys, euid) {
  let names;
  try {
    names = listNames(dirPath, sys);
  } catch (err) {
    return { stop: { outcome: 'error', reason: 'list', code: codeOf(err) } };
  }
  let op = null;
  for (const entry of names) {
    if (entry === null) return { stop: { outcome: 'refused', reason: 'entry-name' } };
    if (entry === DIR_MARKER_FILE) continue;
    let est;
    try {
      est = sys.lstat(join(dirPath, entry));
    } catch (err) {
      if (codeOf(err) === 'ENOENT') continue;
      return { stop: { outcome: 'error', reason: 'entry-lookup', entry, code: codeOf(err) } };
    }
    if (est.isFile() || est.isSymbolicLink()) continue;
    if (kind === 'text' && entry === NESTED_OP_NAME && est.isDirectory()) {
      const nested = checkNestedOp(join(dirPath, NESTED_OP_NAME), est, st, sys, euid);
      if (nested.stop) return { stop: nested.stop };
      // An empty op with no marker proves nothing about what it may hold
      // later: the removal only rmdirs it (item 4, **An empty `op`**).
      op = { dev: est.dev, ino: est.ino, empty: nested.empty };
      continue;
    }
    return { stop: { outcome: 'refused', reason: 'entry', entry } };
  }
  if (kind === 'op') {
    const stop = checkOperation(dirPath, marker.id, sys);
    if (stop) return { stop };
  }
  return { op };
}

// A text directory's nested `op`: proven by its own marker when it holds
// entries, or empty with no marker (item 4, **An empty `op`**). `{ stop }`, or
// `{ empty }`: whether it passed as the empty op with no marker.
function checkNestedOp(opPath, est, parentSt, sys, euid) {
  const stop = (s) => ({ stop: s });
  const read = readControlFile(join(opPath, DIR_MARKER_FILE), sys);
  if (read.error) return stop({ outcome: 'error', reason: 'op-marker-read', code: read.error });
  if (read.invalid) return stop({ outcome: 'refused', reason: `op-marker-${read.invalid}` });
  let names;
  try {
    names = listNames(opPath, sys);
  } catch (err) {
    return stop({ outcome: 'error', reason: 'op-list', code: codeOf(err) });
  }
  // An empty op with no marker goes on its parent's proof, by its type alone.
  if (read.absent) return names.length === 0 ? { empty: true } : stop({ outcome: 'refused', reason: 'op-unmarked' });
  if (est.uid !== BigInt(euid)) return stop({ outcome: 'refused', reason: 'op-uid' });
  const bad = markerMatches(read.value, { kind: 'op', name: NESTED_OP_NAME, st: est, euid, parent: { dev: parentSt.dev, ino: parentSt.ino } });
  if (bad) return stop({ outcome: 'refused', reason: `op-${bad}` });
  for (const entry of names) {
    if (entry === null) return stop({ outcome: 'refused', reason: 'op-entry-name' });
    if (entry === DIR_MARKER_FILE) continue;
    let nst;
    try {
      nst = sys.lstat(join(opPath, entry));
    } catch (err) {
      if (codeOf(err) === 'ENOENT') continue;
      return stop({ outcome: 'error', reason: 'op-entry-lookup', entry: `${NESTED_OP_NAME}/${entry}`, code: codeOf(err) });
    }
    if (!nst.isFile() && !nst.isSymbolicLink()) return stop({ outcome: 'refused', reason: 'op-entry', entry: `${NESTED_OP_NAME}/${entry}` });
  }
  const s = checkOperation(opPath, read.value.id, sys);
  return s ? stop(s) : { empty: false };
}

// --- removal ----------------------------------------------------------------

/**
 * Unlink every entry of a proven, claimed directory but its marker, the
 * nested `op` that passed the proof (`op`, its identity) down to its own
 * marker, then the marker and the directory once a fresh listing finds the
 * marker alone (item 4, **The removal**). An entry whose name is not UTF-8 is
 * never named, so never unlinked: it keeps the directory, reported partial.
 */
// `keepNames` (the owner's run): a kept file in the removal's own listing
// stops it before anything is unlinked (`{ stop }`, so the claimer puts the
// directory back). The removal unlinks only the names of that listing, so one
// that appears later is never unlinked, and keeps the directory (partial).
function removeClaimed(dirPath, kind, op, sys, keepNames = []) {
  const tally = { unlinked: [], gone: [], kept: [], unlisted: false };
  const unlinkInto = (file, label) => {
    try {
      sys.unlink(file);
      tally.unlinked.push(label);
    } catch (err) {
      if (codeOf(err) === 'ENOENT') tally.gone.push(label);
      else tally.kept.push({ name: label, code: codeOf(err) });
    }
  };
  let names;
  try {
    names = listNames(dirPath, sys);
  } catch {
    tally.unlisted = true;
    return { done: false, tally, markerRemains: true };
  }
  const keptNow = names.find((n) => n !== null && keepNames.includes(n));
  if (keptNow !== undefined) return { stop: { outcome: 'refused', reason: 'kept-file', entry: keptNow } };
  for (const entry of names) {
    if (entry === null || entry === DIR_MARKER_FILE) continue;
    const file = join(dirPath, entry);
    if (kind === 'text' && entry === NESTED_OP_NAME) {
      let est;
      try {
        est = sys.lstat(file);
      } catch (err) {
        if (codeOf(err) === 'ENOENT') { tally.gone.push(entry); continue; }
        tally.kept.push({ name: entry, code: codeOf(err) });
        continue;
      }
      if (est.isDirectory()) {
        // Only the op the proof judged: another directory put there since
        // is left as it is.
        if (op === null || !sameId(est.dev, op.dev) || !sameId(est.ino, op.ino)) {
          tally.kept.push({ name: entry, code: 'ECHANGED' });
          continue;
        }
        if (op.empty) removeEmptyOp(file, sys, tally);
        else removeNestedOp(file, sys, tally, unlinkInto);
        continue;
      }
    }
    unlinkInto(file, entry);
  }
  let after;
  try {
    after = listNames(dirPath, sys);
  } catch {
    tally.unlisted = true;
    return { done: false, tally, markerRemains: true };
  }
  if (after.length !== 1 || after[0] !== DIR_MARKER_FILE) {
    return { done: false, tally, markerRemains: after.includes(DIR_MARKER_FILE), found: foundNames(after) };
  }
  try {
    sys.unlink(join(dirPath, DIR_MARKER_FILE));
  } catch (err) {
    if (codeOf(err) !== 'ENOENT') {
      tally.kept.push({ name: DIR_MARKER_FILE, code: codeOf(err) });
      return { done: false, tally, markerRemains: true };
    }
  }
  try {
    sys.rmdir(dirPath);
    return { done: true, tally };
  } catch (err) {
    let found;
    try {
      found = foundNames(listNames(dirPath, sys));
    } catch {
      tally.unlisted = true;
    }
    return { done: false, tally, markerRemains: false, rmdirCode: codeOf(err), found };
  }
}

// The entries a listing found besides the marker; a name that is not UTF-8
// is reported by a fixed label, never by a lossy decoding.
const foundNames = (names) => names.filter((n) => n !== DIR_MARKER_FILE).map((n) => (n === null ? '<not-utf8>' : n));

// The empty op with no marker that the proof passed: an rmdir and nothing
// else, so an entry written into it since keeps it (and its parent, partial).
function removeEmptyOp(opPath, sys, tally) {
  try {
    sys.rmdir(opPath);
    tally.unlinked.push(NESTED_OP_NAME);
  } catch (err) {
    if (codeOf(err) === 'ENOENT') tally.gone.push(NESTED_OP_NAME);
    else tally.kept.push({ name: NESTED_OP_NAME, code: codeOf(err) });
  }
}

function removeNestedOp(opPath, sys, tally, unlinkInto) {
  let names;
  try {
    names = listNames(opPath, sys);
  } catch (err) {
    if (codeOf(err) === 'ENOENT') { tally.gone.push(NESTED_OP_NAME); return; }
    tally.unlisted = true;
    return;
  }
  for (const entry of names) {
    if (entry === null || entry === DIR_MARKER_FILE) continue;
    unlinkInto(join(opPath, entry), `${NESTED_OP_NAME}/${entry}`);
  }
  let after;
  try {
    after = listNames(opPath, sys);
  } catch {
    tally.unlisted = true;
    return;
  }
  if (after.length === 1 && after[0] === DIR_MARKER_FILE) {
    const label = `${NESTED_OP_NAME}/${DIR_MARKER_FILE}`;
    try {
      sys.unlink(join(opPath, DIR_MARKER_FILE));
      tally.unlinked.push(label);
    } catch (err) {
      if (codeOf(err) !== 'ENOENT') { tally.kept.push({ name: label, code: codeOf(err) }); return; }
      tally.gone.push(label);
    }
  } else if (after.length !== 0) {
    return; // the outer listing finds `op` still there
  }
  try {
    sys.rmdir(opPath);
    tally.unlinked.push(NESTED_OP_NAME);
  } catch (err) {
    if (codeOf(err) === 'ENOENT') tally.gone.push(NESTED_OP_NAME);
    else tally.kept.push({ name: NESTED_OP_NAME, code: codeOf(err) });
  }
}

// --- the release ------------------------------------------------------------

/** The release's exit status for each outcome (Decision 9, item 5). */
export const RELEASE_EXIT = Object.freeze({
  removed: 0,
  absent: 0,
  unsupported: 0,
  'not-owned': 10,
  refused: 11,
  contention: 12,
  error: 13,
  claimed: 14,
  partial: 15,
});

// Whether anything is at `p`: `{ there: boolean }`, or `{ code }` for a
// lookup that failed other than by absence.
function lookup(p, sys) {
  try {
    sys.lstat(p);
    return { there: true };
  } catch (err) {
    return codeOf(err) === 'ENOENT' ? { there: false } : { code: codeOf(err) };
  }
}

/**
 * Release the directory at `givenPath`, the path a make printed or the
 * `.removing-` path a report gave for it (Decision 9, items 3 to 5). Returns
 * the report: `{ outcome, path, … }`, whose `outcome` RELEASE_EXIT maps to an
 * exit status. `path` is where the directory is as the release ends (the
 * given path once it is removed or absent). Never throws for what it finds.
 */
export function releaseDir(givenPath, { sys: sysIn, owner = null } = {}) {
  const sys = sysOf(sysIn);
  try {
    return releaseSteps(givenPath, sys, owner);
  } catch (err) {
    // A call that threw where none is expected: reported as an error, never
    // as a success, with the path as given.
    return { outcome: 'error', path: givenPath, reason: 'internal', code: codeOf(err) };
  }
}

// The owner's run (Decision 10, item 6) releases claim-only: a `.removing-`
// name there, before or at the claim, skips the directory rather than finish
// it. Just before the claim it checks again that no kept file is there and
// that the directory is still older than the age (`owner`: `{ keepNames,
// minAgeMs, now }`). A skip changes nothing: `{ outcome: 'skipped', reason }`.
function ownerSkip(origPath, claimedPath, owner, sys) {
  const l = lookup(claimedPath, sys);
  if (l.code) return { outcome: 'error', path: origPath, reason: 'lookup', code: l.code };
  if (l.there) return { outcome: 'skipped', path: origPath, reason: 'claimed', removing_path: claimedPath };
  for (const k of owner.keepNames) {
    const kl = lookup(join(origPath, k), sys);
    if (kl.code) return { outcome: 'error', path: origPath, reason: 'entry-lookup', entry: k, code: kl.code };
    if (kl.there) return { outcome: 'skipped', path: origPath, reason: 'kept-file', entry: k };
  }
  const newest = newestMtimeMs(origPath, sys);
  if (newest === null) return { outcome: 'skipped', path: origPath, reason: 'age-unknown' };
  if (owner.now.getTime() - newest < owner.minAgeMs) return { outcome: 'skipped', path: origPath, reason: 'young' };
  return null;
}

function releaseSteps(givenPath, sys, owner) {
  const unsupported = platformUnsupported(sys);
  if (unsupported) return { outcome: 'unsupported', path: givenPath, reason: unsupported };
  // A path a single-quoted literal cannot carry is never one a make printed
  // (Decision 10, item 4): nothing is judged, and nothing changes.
  if (typeof givenPath === 'string' && UNCARRIABLE_RE.test(givenPath)) return { outcome: 'unsupported', path: givenPath, reason: 'unsupported-path' };
  const euid = sys.geteuid();
  const p = checkPath(givenPath);
  if (p.reason) return { outcome: 'not-owned', path: givenPath, reason: p.reason };
  const origPath = join(p.parent, p.name);
  const claimedPath = join(p.parent, REMOVING_PREFIX + p.name);
  const spec = { name: p.name, kind: p.kind };

  // A report that judges `<name>` names the `.removing-` sibling when one is
  // there, whatever its outcome (item 4, **Before the claim**).
  const withSibling = (report) => {
    if (lookup(claimedPath, sys).there === true) report.removing_path = claimedPath;
    return report;
  };

  if (p.claimed && owner) return { outcome: 'skipped', path: givenPath, reason: 'claimed' };
  if (p.claimed) {
    const l = lookup(claimedPath, sys);
    if (l.code) return { outcome: 'error', path: claimedPath, reason: 'lookup', code: l.code };
    if (!l.there) return absentClaimed(claimedPath, origPath, sys);
    return finish(claimedPath, givenPath, spec, sys, euid, () => absentClaimed(claimedPath, origPath, sys));
  }

  const first = checkTopLevel(origPath, spec, sys, euid);
  if (first.gone) {
    const l = lookup(claimedPath, sys);
    if (l.code) return { outcome: 'error', path: origPath, reason: 'lookup', code: l.code };
    if (!l.there) return { outcome: 'absent', path: origPath };
    if (owner) return { outcome: 'skipped', path: origPath, reason: 'claimed', removing_path: claimedPath };
    return finish(claimedPath, givenPath, spec, sys, euid, () => ({ outcome: 'absent', path: origPath }));
  }
  if (!first.ok) return withSibling({ outcome: first.outcome, path: origPath, reason: first.reason, ...(first.code ? { code: first.code } : {}) });
  if (owner) {
    const skip = ownerSkip(origPath, claimedPath, owner, sys);
    if (skip) return skip;
  }

  // The claim: an exclusive placeholder, then the rename onto it.
  try {
    sys.mkdir(claimedPath, 0o700);
  } catch (err) {
    if (codeOf(err) === 'EEXIST') {
      // The owner's run is claim-only: a claim that appeared at the last
      // moment is skipped, not a failed release.
      if (owner) return { outcome: 'skipped', path: origPath, reason: 'claimed', removing_path: claimedPath };
      return { outcome: 'contention', path: origPath, reason: 'removing-exists', removing_path: claimedPath };
    }
    return withSibling({ outcome: 'error', path: origPath, reason: 'claim-mkdir', code: codeOf(err) });
  }
  try {
    sys.rename(origPath, claimedPath);
  } catch (err) {
    const report = { path: origPath, code: codeOf(err) };
    try {
      sys.rmdir(claimedPath);
    } catch (rmErr) {
      report.placeholder_left = { path: claimedPath, code: codeOf(rmErr) };
    }
    if (lookup(origPath, sys).there === false) return withSibling({ outcome: 'contention', reason: 'gone-before-claim', ...report });
    return withSibling({ outcome: 'error', reason: 'claim-rename', ...report });
  }

  // After the claim: the directory and the marker again, on the claimed one.
  const again = checkTopLevel(claimedPath, spec, sys, euid);
  if (!again.ok) {
    return {
      outcome: 'claimed', path: claimedPath, check: again.gone ? 'gone' : again.reason, not_back: 'unproven',
      ...(again.code ? { check_code: again.code } : {}),
    };
  }
  const c = checkContents(claimedPath, { kind: p.kind, marker: again.marker, st: again.st }, sys, euid);
  if (c.stop) return renameBack(claimedPath, origPath, c.stop, sys);
  return removeReport(claimedPath, givenPath, p.kind, c.op, sys, owner ? owner.keepNames : [], origPath);
}

// Nothing at the given `.removing-` path: absent, with whether `<name>`
// exists; a lookup of `<name>` that fails cannot say, and is an error.
function absentClaimed(claimedPath, origPath, sys) {
  const l = lookup(origPath, sys);
  if (l.code) return { outcome: 'error', path: claimedPath, reason: 'name-lookup', code: l.code };
  return { outcome: 'absent', path: claimedPath, name_exists: l.there };
}

// A finisher: a claimed directory, judged by the checks after the claim, and
// never renamed (item 4, **Finishing**). `whenGone` is the absent report of
// the path the release was given.
function finish(claimedPath, givenPath, spec, sys, euid, whenGone) {
  const c = checkTopLevel(claimedPath, spec, sys, euid);
  if (c.gone) return whenGone();
  if (!c.ok) return { outcome: c.outcome, path: claimedPath, reason: c.reason, finisher: true, ...(c.code ? { code: c.code } : {}) };
  const contents = checkContents(claimedPath, { kind: spec.kind, marker: c.marker, st: c.st }, sys, euid);
  if (contents.stop) return { ...stopFields(contents.stop), path: claimedPath, finisher: true };
  return removeReport(claimedPath, givenPath, spec.kind, contents.op, sys);
}

const stopFields = (stop) => ({
  outcome: stop.outcome, reason: stop.reason,
  ...(stop.entry !== undefined ? { entry: stop.entry } : {}),
  ...(stop.code ? { code: stop.code } : {}),
});

// The claimer puts the directory back when only the entries or the operation
// stopped it: an exclusive `mkdir` of `<name>`, then the rename onto it.
function renameBack(claimedPath, origPath, stop, sys) {
  const claimed = (notBack, extra = {}) => ({
    outcome: 'claimed', path: claimedPath, check: stop.reason,
    ...(stop.entry !== undefined ? { entry: stop.entry } : {}),
    ...(stop.code ? { check_code: stop.code } : {}),
    not_back: notBack, ...extra,
  });
  try {
    sys.mkdir(origPath, 0o700);
  } catch (err) {
    return claimed(codeOf(err) === 'EEXIST' ? 'name-taken' : codeOf(err));
  }
  try {
    sys.rename(claimedPath, origPath);
  } catch (err) {
    const extra = {};
    try {
      sys.rmdir(origPath);
    } catch (rmErr) {
      extra.placeholder_left = { path: origPath, code: codeOf(rmErr) };
    }
    return claimed(codeOf(err), extra);
  }
  return { ...stopFields(stop), path: origPath };
}

function removeReport(claimedPath, givenPath, kind, op, sys, keepNames = [], origPath = null) {
  const r = removeClaimed(claimedPath, kind, op, sys, keepNames);
  if (r.stop) return renameBack(claimedPath, origPath, r.stop, sys);
  if (r.done) return { outcome: 'removed', path: givenPath };
  const report = {
    outcome: 'partial', path: claimedPath,
    unlinked: r.tally.unlinked, gone: r.tally.gone, kept: r.tally.kept,
    unlisted: r.tally.unlisted, marker_remains: r.markerRemains,
  };
  if (r.rmdirCode) report.code = r.rmdirCode;
  if (r.found !== undefined) report.found = r.found;
  return report;
}

/**
 * The one line Decision 10, item 4 has the block print on standard error for
 * a release's outcome, or `null` for `removed`, `absent` and `unsupported`.
 * Paths are JSON-escaped; the line never suggests a rerun.
 */
export function releaseLine(report) {
  const o = report?.outcome;
  if (o === 'removed' || o === 'absent' || o === 'unsupported') return null;
  const at = JSON.stringify(String(report?.path ?? ''));
  const why = report?.reason ? ` (${report.reason})` : '';
  if (o === 'contention' && report.reason === 'gone-before-claim') {
    const left = report.placeholder_left ? `; a placeholder is left at ${JSON.stringify(String(report.placeholder_left.path))}` : '';
    return `agentic-dir release: contention${why}; nothing is at ${at} any more${left}`;
  }
  if (o === 'not-owned' || o === 'refused' || o === 'contention' || o === 'error') {
    return `agentic-dir release: ${o}${why}; the directory is kept at ${at}`;
  }
  if (o === 'claimed') {
    if (report.check === 'gone') return `agentic-dir release: claimed; the claimed directory is no longer at ${at}`;
    return `agentic-dir release: claimed; the directory is left at ${at} (${report.check} failed)`;
  }
  if (o === 'partial') {
    const n = Array.isArray(report.unlinked) ? report.unlinked.length : 0;
    return `agentic-dir release: partial; the removal of ${at} did not finish (${n} entries unlinked), and its marker ${report.marker_remains ? 'remains' : 'is gone'}`;
  }
  return `agentic-dir release: unknown outcome; the directory may remain at ${at} or at its ${REMOVING_PREFIX} path`;
}

// --- the make ---------------------------------------------------------------

function randomSuffix(sys) {
  const bytes = sys.randomBytes(SUFFIX_LENGTH);
  let s = '';
  for (let i = 0; i < SUFFIX_LENGTH; i += 1) s += SUFFIX_ALPHABET[bytes[i] % SUFFIX_ALPHABET.length];
  return s;
}

/**
 * Make a directory of `kind` and mark it (Decision 9, item 2): a top-level
 * `text` or `op` directory under `$TMPDIR` (`/tmp` when it is unset), or,
 * with `parent`, the nested `op` of that text directory. `{ ok: true, path,
 * marker }`, or `{ ok: false, reason, code? }`; on a failure it removed what
 * it made (its aside file, then the directory when empty), or names what it
 * could not in `left`.
 */
export function makeDir({ kind, parent = null, env = process.env, sys: sysIn } = {}) {
  const sys = sysOf(sysIn);
  if (kind !== 'text' && kind !== 'op') return { ok: false, reason: 'usage' };
  if (parent !== null && kind !== 'op') return { ok: false, reason: 'usage' };
  const unsupported = platformUnsupported(sys);
  if (unsupported) return { ok: false, reason: 'unsupported', detail: unsupported };
  const euid = sys.geteuid();
  try {
    return parent === null ? makeTopLevel(kind, env, sys, euid) : makeNested(parent, sys, euid);
  } catch (err) {
    // Before any mkdir (placeMarker catches what follows one): nothing made.
    return { ok: false, reason: 'error', code: codeOf(err) };
  }
}

// The root a top-level directory is made in, and the listing reads (item 2,
// **Where**): `$TMPDIR` when it is set, which must then be an absolute path to
// a directory, else `/tmp`. `{ real, rst }`, or `{ reason, code? }`.
function resolveRoot(env, sys) {
  const raw = env?.TMPDIR;
  const root = raw === undefined ? '/tmp' : raw;
  if (typeof root !== 'string' || root === '' || !path.posix.isAbsolute(root)) return { reason: 'tmpdir-unusable' };
  let real;
  try {
    real = decodePath(sys.realpath(root));
  } catch (err) {
    return { reason: 'tmpdir-unusable', code: codeOf(err) };
  }
  if (real === null || UNCARRIABLE_RE.test(real)) return { reason: 'unsupported-path' };
  let rst;
  try {
    rst = sys.stat(real);
  } catch (err) {
    return { reason: 'tmpdir-unusable', code: codeOf(err) };
  }
  if (!rst.isDirectory()) return { reason: 'tmpdir-unusable' };
  return { real, rst };
}

function makeTopLevel(kind, env, sys, euid) {
  const r = resolveRoot(env, sys);
  if (r.reason) return { ok: false, reason: r.reason, ...(r.code ? { code: r.code } : {}) };
  const { real, rst } = r;
  let dirPath;
  let name;
  for (let attempt = 0; ; attempt += 1) {
    name = `${DIR_KINDS[kind]}.${randomSuffix(sys)}`;
    dirPath = join(real, name);
    try {
      sys.mkdir(dirPath, 0o700);
      break;
    } catch (err) {
      if (codeOf(err) === 'EEXIST' && attempt + 1 < MAKE_ATTEMPTS) continue;
      return { ok: false, reason: 'error', code: codeOf(err) };
    }
  }
  return placeMarker({
    kind, name, dirPath, asideDir: dirPath, asidePrefix: `${DIR_MARKER_FILE}.`, euid, sys,
    parentIdentity: { path: real, dev: String(rst.dev), ino: String(rst.ino) },
  });
}

// Whether `parent` is a legacy text directory, one `mktemp -d` made before the
// switch, however the shell spelled it: macOS's `$TMPDIR` ends in `/` and lies
// under a linked `/var`, so `mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"`
// prints `…/T//agentic-text.X`, which the canonical-path checks refuse. This
// decides only the fallback of Decision 10, item 4 (a legacy parent gets a
// legacy `op`, made by the block's own `mkdir -m 700`, which follows the same
// spelling); it proves nothing a release relies on. A text-kind name, a
// directory of this user that is itself no link (only its ancestors may be,
// as macOS's `/var` is: `mktemp -d` never prints a link, so a link named
// like one, `…/agentic-text.X/` included, points elsewhere and never gets
// the fallback), and no marker in it: `{ legacy: true }`; a lookup that
// fails other than by absence: `{ code }`; otherwise `{}`.
function legacyParent(parent, sys, euid) {
  if (typeof parent !== 'string' || !parent.startsWith('/') || parent.includes('\0')) return {};
  const trimmed = parent.replace(/\/+$/, '');
  const base = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  const m = TOP_NAME_RE.exec(base);
  if (!m || m[1] !== 'text') return {};
  let st;
  try {
    st = sys.lstat(trimmed);
  } catch (err) {
    return codeOf(err) === 'ENOENT' ? {} : { code: codeOf(err) };
  }
  if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== BigInt(euid)) return {};
  const l = lookup(`${trimmed}/${DIR_MARKER_FILE}`, sys);
  if (l.code) return { code: l.code };
  return l.there ? {} : { legacy: true };
}

// The refusal of a parent that fails the canonical checks: `parent-legacy`
// when it is a legacy text directory spelled another way, else `refusal`.
function nonCanonicalParent(parent, sys, euid, refusal) {
  const l = legacyParent(parent, sys, euid);
  if (l.legacy) return { ok: false, reason: 'parent-legacy' };
  if (l.code) return { ok: false, reason: 'parent-unreadable', detail: 'legacy-lookup', code: l.code };
  return refusal;
}

function makeNested(parent, sys, euid) {
  const p = checkPath(parent);
  if (p.reason || p.kind !== 'text') {
    return nonCanonicalParent(parent, sys, euid, { ok: false, reason: 'parent-invalid', detail: p.reason ?? 'parent-kind' });
  }
  if (p.claimed) return { ok: false, reason: 'parent-claimed' };
  const spec = { name: p.name, kind: 'text' };
  const c = checkTopLevel(parent, spec, sys, euid);
  if (c.gone) {
    const l = lookup(join(p.parent, REMOVING_PREFIX + p.name), sys);
    if (l.code) return { ok: false, reason: 'parent-unreadable', detail: 'lookup', code: l.code };
    return l.there ? { ok: false, reason: 'parent-claimed' } : { ok: false, reason: 'parent-invalid', detail: 'gone' };
  }
  if (!c.ok) {
    if (c.outcome === 'error') return { ok: false, reason: 'parent-unreadable', detail: c.reason, ...(c.code ? { code: c.code } : {}) };
    if (c.reason === 'marker-absent') return { ok: false, reason: 'parent-legacy' };
    // A canonical-looking spelling through a linked ancestor (`/var/folders/…`
    // for `/private/var/folders/…`) fails the parent-path check first.
    if (c.reason === 'parent-path') return nonCanonicalParent(parent, sys, euid, { ok: false, reason: 'parent-invalid', detail: c.reason });
    return { ok: false, reason: 'parent-invalid', detail: c.reason };
  }
  const dirPath = join(parent, NESTED_OP_NAME);
  // The make prints only a path later blocks can carry (Decision 10, item 1).
  if (UNCARRIABLE_RE.test(dirPath)) return { ok: false, reason: 'unsupported-path' };
  try {
    sys.mkdir(dirPath, 0o700);
  } catch (err) {
    return { ok: false, reason: codeOf(err) === 'EEXIST' ? 'exists' : 'error', code: codeOf(err) };
  }
  // The nested aside is a plain file of the parent, so an interrupted make
  // leaves `op` empty (item 2, **How**).
  return placeMarker({
    kind: 'op', name: NESTED_OP_NAME, dirPath, asideDir: parent, asidePrefix: '.agentic-dir-op.', euid, sys,
    parentIdentity: { dev: String(c.st.dev), ino: String(c.st.ino) },
  });
}

// Check what the mkdir made, set its mode, and write the marker aside then
// rename it into place; on any failure remove the aside and the empty
// directory, and print nothing. Nothing after the mkdir escapes the cleanup:
// a seam or a call that throws is a failure like any other.
function placeMarker(args) {
  let made;
  try {
    made = placeMarkerSteps(args);
  } catch (err) {
    made = args.fail ? args.fail('error', { code: codeOf(err) }) : { ok: false, reason: 'error', code: codeOf(err) };
  }
  return made;
}

function placeMarkerSteps(args) {
  const { kind, name, dirPath, asideDir, asidePrefix, euid, sys, parentIdentity } = args;
  let asideMade = false;
  let aside = null;
  const fail = (reason, extra = {}) => {
    const left = [];
    if (asideMade && aside !== null) {
      try { sys.unlink(aside); } catch (err) { if (codeOf(err) !== 'ENOENT') left.push({ path: aside, code: codeOf(err) }); }
    }
    try { sys.rmdir(dirPath); } catch (err) { if (codeOf(err) !== 'ENOENT') left.push({ path: dirPath, code: codeOf(err) }); }
    return { ok: false, reason, ...extra, ...(left.length ? { left } : {}) };
  };
  args.fail = fail;
  let st;
  try {
    st = sys.lstat(dirPath);
  } catch (err) {
    return fail('error', { code: codeOf(err) });
  }
  if (!st.isDirectory()) return fail('error', { detail: 'not-directory' });
  if (st.uid === undefined || st.uid === null || st.ino === 0n) return fail('unsupported', { detail: 'stat' });
  // An owner this process is not fails the proof the release would make: not
  // a platform that cannot tell, so not the mktemp fallback's `unsupported`.
  if (st.uid !== BigInt(euid)) return fail('owner-mismatch');
  if ((st.mode & 0o777n) !== 0o700n) {
    try {
      sys.chmod(dirPath, 0o700);
      st = sys.lstat(dirPath);
    } catch (err) {
      return fail('error', { code: codeOf(err) });
    }
    if ((st.mode & 0o777n) !== 0o700n) return fail('error', { detail: 'mode' });
  }
  const marker = {
    schema: DIR_MARKER_SCHEMA,
    kind,
    id: sys.randomBytes(16).toString('hex'),
    name,
    dev: String(st.dev),
    ino: String(st.ino),
    uid: euid,
    made_at: sys.now().toISOString(),
    parent: parentIdentity,
  };
  aside = join(asideDir, `${asidePrefix}${sys.randomBytes(6).toString('hex')}.tmp`);
  let fd;
  try {
    fd = sys.open(aside, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    asideMade = true;
  } catch (err) {
    return fail('error', { code: codeOf(err) });
  }
  try {
    const buf = Buffer.from(`${JSON.stringify(marker)}\n`, 'utf8');
    let off = 0;
    while (off < buf.length) {
      const n = sys.write(fd, buf.subarray(off));
      if (!Number.isInteger(n) || n <= 0) throw Object.assign(new Error('short write'), { code: 'EIO' });
      off += n;
    }
  } catch (err) {
    try { sys.close(fd); } catch { /* the write failed already */ }
    return fail('error', { code: codeOf(err) });
  }
  try {
    sys.close(fd);
  } catch (err) {
    return fail('error', { code: codeOf(err) });
  }
  try {
    sys.rename(aside, join(dirPath, DIR_MARKER_FILE));
  } catch (err) {
    return fail('error', { code: codeOf(err) });
  }
  return { ok: true, path: dirPath, marker };
}

/**
 * The make's exit status for a failure reason a block branches on (Decision
 * 10, item 4): `unsupported` (make it with `mktemp -d`), `parent-legacy` (make
 * `op` with `mkdir -m 700`) and `unsupported-path` (stop, and say to set
 * `TMPDIR`); 2 for a usage error, 1 for every other failure. A success prints
 * the path and exits 0.
 */
export const MAKE_EXIT = Object.freeze({ usage: 2, unsupported: 3, 'parent-legacy': 4, 'unsupported-path': 5 });
export const makeExit = (result) => (result?.ok ? 0 : (MAKE_EXIT[result?.reason] ?? 1));

/** The one line a failed make prints on standard error; never a path it made. */
export function makeLine(result) {
  const detail = result?.detail ? ` (${result.detail})` : '';
  const code = result?.code ? ` [${result.code}]` : '';
  const left = Array.isArray(result?.left) && result.left.length > 0
    ? `; left: ${result.left.map((l) => `${JSON.stringify(String(l.path))} [${l.code}]`).join(', ')}`
    : '';
  return `agentic-dir make: ${result?.reason ?? 'error'}${detail}${code}; no directory was made${left}`;
}

// --- the listing and the owner's run (Decision 10, item 6) --------------------

/** Files a paused `/orchestrator:next` keeps outside `operation.json`. */
export const KEEP_NAMES = Object.freeze(['admission', 'dispatch-mark.json']);
export const DEFAULT_AGE_DAYS = 7;
const DAY_MS = 86_400_000;

const mtimeMsOf = (st) => {
  if (typeof st?.mtimeNs === 'bigint') return Number(st.mtimeNs / 1_000_000n);
  return typeof st?.mtimeMs === 'number' && Number.isFinite(st.mtimeMs) ? st.mtimeMs : null;
};

/**
 * The newest modification time, in milliseconds, among a directory and its
 * entries (`lstat`), the entries of its nested `op` included; `null` when any
 * of them cannot be read or named, so the directory is never old enough.
 */
export function newestMtimeMs(dirPath, sysIn) {
  const sys = sysOf(sysIn);
  const newestIn = (dir, depth) => {
    let st;
    try {
      st = sys.lstat(dir);
    } catch {
      return null;
    }
    let newest = mtimeMsOf(st);
    if (newest === null || !st.isDirectory()) return newest;
    let names;
    try {
      names = listNames(dir, sys);
    } catch {
      return null;
    }
    for (const n of names) {
      if (n === null) return null;
      let est;
      try {
        est = sys.lstat(join(dir, n));
      } catch (err) {
        if (codeOf(err) === 'ENOENT') continue;
        return null;
      }
      const m = depth === 0 && n === NESTED_OP_NAME && est.isDirectory() ? newestIn(join(dir, n), 1) : mtimeMsOf(est);
      if (m === null) return null;
      if (m > newest) newest = m;
    }
    return newest;
  };
  try {
    return newestIn(dirPath, 0);
  } catch {
    return null;
  }
}

/**
 * Read the root (`$TMPDIR`, else `/tmp`) and change nothing: every entry of a
 * top-level kind's form, with its newest modification time and its state —
 * `releasable` (marked, and the checks before the claim pass), `refused`
 * (with the outcome and reason code a release would give), `claimed` (a
 * `.removing-` path) or `unmarked` — and, for a marked directory, the kept
 * files it holds. `{ ok: true, root, entries }`, or `{ ok: false, reason }`.
 */
export function listDirs({ env = process.env, sys: sysIn } = {}) {
  const sys = sysOf(sysIn);
  try {
    const unsupported = platformUnsupported(sys);
    if (unsupported) return { ok: false, reason: 'unsupported', detail: unsupported };
    const euid = sys.geteuid();
    const r = resolveRoot(env, sys);
    if (r.reason) return { ok: false, reason: r.reason, ...(r.code ? { code: r.code } : {}) };
    let names;
    try {
      names = listNames(r.real, sys);
    } catch (err) {
      return { ok: false, reason: 'list', code: codeOf(err) };
    }
    const entries = [];
    for (const name of names) {
      if (name === null) continue;
      const dirPath = join(r.real, name);
      const p = checkPath(dirPath);
      if (p.reason) continue;
      entries.push(judgeEntry(dirPath, p, sys, euid));
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return { ok: true, root: r.real, entries };
  } catch (err) {
    return { ok: false, reason: 'internal', code: codeOf(err) };
  }
}

function judgeEntry(dirPath, p, sys, euid) {
  const newest = newestMtimeMs(dirPath, sys);
  const base = {
    name: p.base, path: dirPath, kind: p.kind,
    newest_mtime: newest === null ? null : new Date(newest).toISOString(), newest_mtime_ms: newest,
  };
  if (p.claimed) return { ...base, state: 'claimed' };
  const c = checkTopLevel(dirPath, { name: p.name, kind: p.kind }, sys, euid);
  if (c.gone) return { ...base, state: 'gone' };
  if (!c.ok) {
    if (c.reason === 'marker-absent') return { ...base, state: 'unmarked' };
    return { ...base, state: 'refused', outcome: c.outcome, reason: c.reason, ...(c.code ? { code: c.code } : {}) };
  }
  // A kept file whose lookup fails counts as there: the run skips what it
  // cannot tell.
  const keeps = KEEP_NAMES.filter((k) => lookup(join(dirPath, k), sys).there !== false);
  const contents = checkContents(dirPath, { kind: p.kind, marker: c.marker, st: c.st }, sys, euid);
  if (contents.stop) return { ...base, state: 'refused', ...stopFields(contents.stop), keeps };
  return { ...base, state: 'releasable', keeps };
}

/** `--age-days`: a decimal count of whole days, 0 to 36500; `null` otherwise. */
export function parseAgeDays(value) {
  if (value === undefined) return DEFAULT_AGE_DAYS;
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,4})$/.test(value) && Number(value) <= 36500 ? Number(value) : null;
}

/**
 * The flags a tmpdir subcommand's argument words repeat, or an empty list
 * (`--name value` and `--name=value` alike): a repeated flag is refused before
 * any file system call, where the generic parsers keep the last.
 */
export function repeatedFlags(words) {
  const seen = new Set();
  const repeated = new Set();
  for (const w of words) {
    if (typeof w !== 'string' || !w.startsWith('--')) continue;
    const name = w.slice(2).split('=')[0];
    if (seen.has(name)) repeated.add(name);
    seen.add(name);
  }
  return [...repeated];
}

/** The flags each tmpdir subcommand takes. */
export const TMPDIR_FLAGS = Object.freeze({
  'tmpdir-make': Object.freeze(['kind', 'parent']),
  'tmpdir-release': Object.freeze(['path']),
  'tmpdir-list': Object.freeze(['execute', 'age-days']),
});

/**
 * What is wrong with a tmpdir subcommand's argument words, judged on the raw
 * words before either CLI's parser runs, or reads a file a flag names: a flag
 * the subcommand does not take (an object key such as `__proto__` included),
 * a repeated flag, a word that is no flag's value, a flag with no value (an
 * empty `--name=`, or a bare `--name` last or before another flag), a value
 * joined to its flag (`--name=value`: the persona CLI's parser has no such
 * form, so neither CLI takes it), or an `--execute` other than `true` or
 * `false`. Both CLIs judge their words here first, so neither parser's own
 * reading of a bare flag, a joined value or a stray word ever decides: the
 * two answer every such call alike. An empty value given as its
 * own word (`--path ""`) is a value, which the library then judges (a release
 * reports it `not-owned`, a nested make `parent-invalid`). `null` when nothing
 * is wrong, or for a subcommand that is not one of them.
 */
export function tmpdirArgProblem(subcommand, words) {
  const allowed = Object.hasOwn(TMPDIR_FLAGS, subcommand) ? TMPDIR_FLAGS[subcommand] : null;
  if (allowed === null) return null;
  const repeated = repeatedFlags(words);
  if (repeated.length > 0) return `${subcommand}: --${repeated[0]} is given more than once`;
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (typeof w !== 'string' || !w.startsWith('--')) return `${subcommand}: unexpected argument ${JSON.stringify(String(w))}`;
    const eq = w.indexOf('=');
    const name = eq === -1 ? w.slice(2) : w.slice(2, eq);
    if (!allowed.includes(name)) return `${subcommand}: unexpected flag --${name}`;
    if (eq !== -1) {
      if (eq === w.length - 1) return `${subcommand}: --${name} needs a value`;
      return `${subcommand}: --${name}=<value> is not taken; give the value as its own word (--${name} <value>)`;
    }
    const value = words[i + 1];
    if (typeof value !== 'string' || value.startsWith('--')) return `${subcommand}: --${name} needs a value`;
    i += 1;
    if (name === 'execute' && value !== 'true' && value !== 'false') {
      return `${subcommand}: --execute takes true or false (got ${JSON.stringify(value)})`;
    }
  }
  return null;
}

/**
 * Write all of `text` to `fd` before returning, or throw: the owner's run
 * states its precondition this way, so a write that fails stops it before
 * any release.
 */
export function writeFullySync(fd, text) {
  const buf = Buffer.from(text, 'utf8');
  let off = 0;
  while (off < buf.length) {
    const n = fs.writeSync(fd, buf, off, buf.length - off);
    if (!Number.isInteger(n) || n <= 0) throw Object.assign(new Error('short write'), { code: 'EIO' });
    off += n;
  }
}

/** The subcommands' usage, shared by both CLIs' help. */
export const TMPDIR_HELP = Object.freeze([
  '  tmpdir-make --kind text|op [--parent <text directory>]',
  '    ADR-0059 Decision 9. Make a text or operation directory under $TMPDIR (/tmp',
  '    when unset), or with --parent (kind op) the nested op of a text directory,',
  '    mark it, and print its path. Exit 3 unsupported platform, 4 a parent with',
  '    no marker, 5 a path a single-quoted literal cannot carry, 1 other failures.',
  '',
  '  tmpdir-release --path <path>',
  '    Release a directory a make printed, on its proof: one JSON report on',
  '    stdout, one line on stderr unless removed, absent or unsupported. Exit 0',
  '    removed, absent or unsupported; 10 not-owned, 11 refused, 12 contention,',
  '    13 error, 14 claimed, 15 partial.',
  '',
  '  tmpdir-list [--execute true [--age-days <n>]]',
  '    ADR-0059 Decision 10, item 6. Read-only: every directory of these kinds',
  '    under the root with its state and newest modification time, as JSON. The',
  "    owner's --execute true releases those marked, releasable, holding no kept",
  '    file and at least --age-days (default 7) old, claim-only, after stating',
  '    the precondition it relies on; exit 1 when a release did not succeed.',
  '',
]);

/** What the owner's run states before it acts (Decision 10, item 6). */
export function executePrecondition(root, ageDays) {
  return [
    `agentic-dir list --execute: releasing the marked directories under ${JSON.stringify(String(root))} whose newest modification is at least ${ageDays} days old, one at a time, through the full proof, claim-only.`,
    'It relies on your precondition, which no CLI checks: no command whose directories this root could hold is running, paused or awaiting a retry (no /orchestrator:next between its switch and its writeback, no admission held, no persona operation open, no peer run unsettled, no finalize or commit you mean to rerun), and no other run of --execute.',
    `A directory holding ${KEEP_NAMES.join(' or ')} is skipped: release it by its path once you have cleared what it records.`,
  ].join('\n');
}

/**
 * The owner's run: list the root, then release each marked directory the
 * listing judged releasable, holds no kept file and is at least `ageDays`
 * old, by its `<name>`, through the full proof, claim-only, one at a time.
 * `onStart(root)` runs once the root is read and before the first release, so
 * the CLI states the precondition before it acts. `{ ok, root, age_days,
 * results }`: `ok` is false when a release ended other than `removed` or
 * `absent`; a skipped directory is not a failure.
 */
export function executeAbandoned({ env = process.env, ageDays = DEFAULT_AGE_DAYS, sys: sysIn, now, onStart } = {}) {
  const sys = sysOf(sysIn);
  if (!Number.isInteger(ageDays) || ageDays < 0) return { ok: false, reason: 'usage' };
  const listing = listDirs({ env, sys });
  if (!listing.ok) return listing;
  const at = now ?? sys.now();
  const minAgeMs = ageDays * DAY_MS;
  if (typeof onStart === 'function') onStart(listing.root);
  const owner = { keepNames: KEEP_NAMES, minAgeMs, now: at };
  const results = [];
  for (const e of listing.entries) {
    let skip = null;
    if (e.state !== 'releasable') skip = e.state;
    else if (e.keeps.length > 0) skip = 'kept-file';
    else if (e.newest_mtime_ms === null) skip = 'age-unknown';
    else if (at.getTime() - e.newest_mtime_ms < minAgeMs) skip = 'young';
    if (skip) {
      results.push({ ...e, action: 'skipped', skip });
      continue;
    }
    const report = releaseDir(e.path, { sys, owner });
    if (report.outcome === 'skipped') results.push({ ...e, action: 'skipped', skip: report.reason, report });
    else results.push({ ...e, action: 'released', report });
  }
  const ok = results.every((r) => r.action !== 'released' || r.report.outcome === 'removed' || r.report.outcome === 'absent');
  return { ok, root: listing.root, age_days: ageDays, results };
}
