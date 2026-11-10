// tests/_tmp.mjs
//
// Temporary directories a test removes itself, on success and on failure
// (docket C175). A test that calls `fs.mkdtempSync` and removes the directory
// only at the end of its body leaves it behind whenever an assertion throws
// first; the leak guard (tests/_tmp-guard.mjs) counts what a test file leaves
// in its own TMPDIR.
//
//   import { tmpDir, fileTmpDirs } from '../_tmp.mjs';
//
//   test('x', (t) => {
//     const dir = tmpDir(t, 'x-');        // removed when the test ends
//   });
//
//   const shared = fileTmpDirs();           // at the top of a file
//   const fixtureRoot = shared('fix-');    // removed when the file's tests end
//
// Every directory is made under `os.tmpdir()` as it is at the call, so under
// `npm test` it lands in the test file's own TMPDIR. That directory, as it
// resolves when the directory is made, is the base of its removal:
// scripts/lib/remove-tree.mjs removes nothing outside it, refuses when it was
// replaced since, never follows a symbolic link, removes a tree a test made
// read-only (its root repaired first), and throws when a tree stays.
//
// Not discovered by `node --test`: the stem `_tmp` matches none of Node's
// test-file patterns.

import { after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { holdBase, removeTree } from '../scripts/lib/remove-tree.mjs';

/**
 * A new directory `prefix` + six random characters, directly in `base`. A
 * prefix that is empty or holds a separator would make it beside `base` or
 * elsewhere, where its removal is refused: it is refused here, before
 * anything is made.
 */
function allocate(base, prefix) {
  if (typeof prefix !== 'string' || prefix === '' || /[/\\]/.test(prefix) || prefix.startsWith('.')) {
    throw new TypeError(`tests/_tmp.mjs: the prefix ${JSON.stringify(prefix)} is empty, starts with a dot or holds a separator`);
  }
  return fs.mkdtempSync(path.join(base.path, prefix));
}

/**
 * A new directory under `os.tmpdir()`, named `prefix` and six random
 * characters, removed when the test `t` ends, whether it passed or failed.
 */
export function tmpDir(t, prefix = 'test-') {
  const base = holdBase(path.resolve(os.tmpdir()));
  const dir = allocate(base, prefix);
  t.after(() => removeTree(base, dir));
  return dir;
}

/**
 * For a fixture shared by a file's tests: a function that makes a new
 * directory as tmpDir does, every one of them removed when the file's tests
 * end, the others still removed when one cannot be. Call it at the top level
 * of a test file.
 */
export function fileTmpDirs() {
  const made = [];
  after(() => {
    const failed = [];
    for (const { base, dir } of made.splice(0)) {
      try { removeTree(base, dir); } catch (err) { failed.push(err); }
    }
    if (failed.length > 0) throw failed[0];
  });
  return (prefix = 'test-') => {
    const base = holdBase(path.resolve(os.tmpdir()));
    const dir = allocate(base, prefix);
    made.push({ base, dir });
    return dir;
  };
}
