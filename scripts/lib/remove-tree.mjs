// Removing a temporary tree a test made (docket C175): used by tests/_tmp.mjs,
// tests/_tmp-guard.mjs and scripts/run-tests.mjs, which removes the leak
// guard's run directory with it.
//
// CONTAINMENT. removeTree(base, path) removes only what is strictly inside
// `base`, the temporary directory the caller made the path in. The caller
// takes `base` with holdBase(directory) when it allocates, before it makes
// anything there: holdBase keeps the directory's name and what that name
// resolves to at that moment. Both paths are absolute and written without
// `.`, `..` or a doubled separator, `base` is no file system root, and the
// path is below `base`, never `base` itself. That is decided from the two
// strings, before any file system call, so a wrong argument (an empty string,
// a relative path, the checkout, the system's temporary directory itself, a
// base that is a bare string) removes nothing and throws. Then, once something
// is found at the path, `base` must still resolve to what holdBase saw, and
// the directory that holds the path must really be inside it (resolved), so a
// link among the path's directories, or a base replaced by a link to another
// directory since it was held, never leads the removal out of it.
//
// A limit: the two looks and the removal are separate system calls. A process
// still running that swaps one of the path's directories for a link between
// them is not caught; the callers remove a test's tree once its test ended.
//
// removeTree never follows a symbolic link: a link is removed, never its
// target, however the path is spelled (a trailing separator or `/.` would
// make lstat resolve the link, so those are dropped first). A tree whose
// directories were made read-only is made writable, its root first, and
// removed again once. It throws when the tree is still there.

import fs from 'node:fs';
import path from 'node:path';

const REPAIRABLE = new Set(['EACCES', 'EPERM', 'ENOTEMPTY']);

/** `fs.lstatSync`, or null when nothing is at `p`. */
function lstatOrNull(fsx, p) {
  try {
    return fsx.lstatSync(p);
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Makes every directory of the tree at `dir` readable, writable and
 * searchable by its owner, the root first so its entries can be listed; never
 * through a symbolic link. A directory that cannot be listed or changed is
 * left as it is: the retry that follows reports it.
 */
function repairTree(fsx, dir) {
  const st = lstatOrNull(fsx, dir);
  if (!st || !st.isDirectory()) return;
  try { fsx.chmodSync(dir, 0o700); } catch { /* the retry reports it */ }
  let names;
  try { names = fsx.readdirSync(dir); } catch { return; }
  for (const name of names) repairTree(fsx, path.join(dir, name));
}

/**
 * `given` without the trailing separators and `.` components that would make
 * lstat answer for a link's target instead of the link. Nothing before the
 * last component is touched. An empty path is refused.
 */
export function ownPath(given) {
  if (typeof given !== 'string' || given === '') throw new TypeError('removeTree: a path is empty or not a string');
  const seps = path.sep === '/' ? '/' : '/\\';
  const isSep = (c) => seps.includes(c);
  let p = given;
  for (;;) {
    let end = p.length;
    while (end > 1 && isSep(p[end - 1])) end -= 1;
    if (end > 2 && p[end - 1] === '.' && isSep(p[end - 2])) end -= 1;
    if (end === p.length) return p;
    p = p.slice(0, end);
  }
}

/**
 * The path to remove, when `given` is strictly inside `base`; throws
 * otherwise. A pure function of the two strings: it reads no file system and
 * no working directory.
 */
export function containedPath(base, given) {
  const b = ownPath(base);
  const p = ownPath(given);
  const refuse = (why) => { throw new RangeError(`removeTree: refusing to remove ${JSON.stringify(given)}: ${why}`); };
  if (!path.isAbsolute(b) || path.normalize(b) !== b) refuse(`its base ${JSON.stringify(base)} is not an absolute path written without ., .. or a doubled separator`);
  if (path.parse(b).root === b) refuse(`its base ${JSON.stringify(base)} is a file system root`);
  if (!path.isAbsolute(p) || path.normalize(p) !== p) refuse('it is not an absolute path written without ., .. or a doubled separator');
  if (!p.startsWith(b + path.sep) || p.length === b.length + 1) refuse(`it is not inside its base ${JSON.stringify(base)}`);
  return p;
}

/**
 * The base of later removals: the directory `dir` by name, and what that name
 * resolves to now. Call it when allocating, before anything is made in `dir`;
 * removeTree refuses once the name resolves to anything else. Throws for a
 * directory removeTree would refuse as a base (not absolute, not written
 * plainly, a root, or resolving to one) and for one that is not there.
 */
export function holdBase(dir, fsx = fs) {
  const b = ownPath(dir);
  if (!path.isAbsolute(b) || path.normalize(b) !== b || path.parse(b).root === b) {
    throw new RangeError(`holdBase: ${JSON.stringify(dir)} is not an absolute path written without ., .. or a doubled separator, or is a file system root`);
  }
  const real = fsx.realpathSync(b);
  if (path.parse(real).root === real) throw new RangeError(`holdBase: ${JSON.stringify(dir)} resolves to a file system root`);
  return Object.freeze({ path: b, real });
}

/** `base` as holdBase returns it; throws for anything else, a bare string included. */
function heldBase(base) {
  if (base === null || typeof base !== 'object' || typeof base.path !== 'string' || typeof base.real !== 'string' || base.real === '') {
    throw new TypeError('removeTree: its base is not what holdBase returned (the directory and what it resolved to when the caller allocated in it)');
  }
  return base;
}

/**
 * Null when `base` still resolves to what holdBase saw, to no root, and the
 * real directory holding `p` is that real path or inside it; else why not.
 */
function notHeldInside(fsx, base, p) {
  const realBase = fsx.realpathSync(base.path);
  if (realBase !== base.real) return `its base ${JSON.stringify(base.path)} no longer resolves to what it did when the caller allocated in it (${JSON.stringify(base.real)})`;
  if (path.parse(realBase).root === realBase) return `its base ${JSON.stringify(base.path)} resolves to a file system root`;
  const holder = fsx.realpathSync(path.dirname(p));
  if (holder === realBase || holder.startsWith(realBase + path.sep)) return null;
  return `a link among its directories leads out of its base ${JSON.stringify(base.path)}`;
}

/**
 * Removes the file, link or directory tree at `given`, which must be strictly
 * inside `base`, what holdBase returned for the directory the caller
 * allocated in (see CONTAINMENT above); nothing there is fine. `fsx` is the
 * file system (a test passes a fake). Throws on a path it refuses, and when
 * the tree stays.
 */
export function removeTree(base, given, fsx = fs) {
  const held = heldBase(base);
  const p = containedPath(held.path, given);
  const st = lstatOrNull(fsx, p);
  if (!st) return;
  const why = notHeldInside(fsx, held, p);
  if (why !== null) throw new RangeError(`removeTree: refusing to remove ${JSON.stringify(given)}: ${why}`);
  if (!st.isDirectory()) {
    // A link (dangling or not) or a file: removed itself, its target never.
    fsx.unlinkSync(p);
    return;
  }
  try {
    fsx.rmSync(p, { recursive: true, force: true });
    return;
  } catch (err) {
    if (!err || !REPAIRABLE.has(err.code)) throw err;
  }
  repairTree(fsx, p);
  fsx.rmSync(p, { recursive: true, force: true });
}
