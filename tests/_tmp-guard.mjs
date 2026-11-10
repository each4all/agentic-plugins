// tests/_tmp-guard.mjs
//
// The temporary-file leak guard of one test file's process (docket C175; how
// a run is guarded, the declaration and the summary: scripts/lib/tmp-leaks.mjs).
//
// scripts/run-tests.mjs loads this module first in every test file's process
// (`node --test --import`, which Node hands to the process of each file) and
// sets TEST_TMP_GUARD_DIR to its run directory. Here, before the test file
// loads, the guard makes the file its own directory there, records which file
// owns it, and points TMPDIR at it, so `os.tmpdir()` in the file, and in every
// process it starts with the environment it inherits, lands in it. When the
// process exits, the guard records what is left there and removes it; a file
// the declaration does not name that left anything gets exit code 1, which
// `node --test` reports as that file's failure.
//
// The count is taken in an exit listener registered from a root after() hook,
// so it runs after every exit listener the file registered while it loaded or
// ran its tests (six files remove their fixtures that way). A file that ends
// its process before its tests end (process.exit in a test) never reaches the
// hook: the listener registered here at import then takes the count, before
// the file's own exit listeners, which may make the count too high.
//
// Inactive outside a `node --test` file process (no NODE_TEST_CONTEXT), with
// no TEST_TMP_GUARD_DIR, and in a process a guarded file started with the
// guard loaded (TEST_TMP_GUARD_OWNER is set): it then changes nothing.
//
// Limits (each rare in this repository, and documented rather than handled):
//   - a process started with an environment that has no TMPDIR, or one that
//     points it elsewhere, writes where nothing here looks;
//   - a preload that runs before this one (a --require, or an --import in
//     NODE_OPTIONS) makes its files before TMPDIR is set;
//   - a cleanup exit listener registered after the guard's own (from a root
//     after() hook the file registered, or in beforeExit) runs after the
//     count, which then charges the file what it removes; an entry such a
//     late listener makes is not in this process's count or exit code: the
//     runner finds the directory there again, adds what it holds to the
//     file's count, and fails the run for an undeclared file;
//   - a process killed with SIGKILL records no result: the runner charges its
//     file what its directory still holds and marks the count incomplete.
//
// Not discovered by `node --test`: the stem `_tmp-guard` matches none of
// Node's test-file patterns.

import { after } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import { holdBase, removeTree } from '../scripts/lib/remove-tree.mjs';
import {
  FILE_DIR_PREFIX, GUARD_DIR_VAR, GUARD_OWNER_VAR, IGNORED_NAMES, MAX_NAMES, OWNER_SUFFIX, RESULT_SUFFIX, RUN_FILE, RUN_SCHEMA, fileKey,
} from '../scripts/lib/tmp-leaks.mjs';

const runDir = process.env[GUARD_DIR_VAR];

if (runDir && process.env.NODE_TEST_CONTEXT && !process.env[GUARD_OWNER_VAR] && process.argv[1]) {
  let run;
  try {
    run = JSON.parse(fs.readFileSync(path.join(runDir, RUN_FILE), 'utf8'));
  } catch (err) {
    throw new Error(`tests/_tmp-guard.mjs: ${GUARD_DIR_VAR} is ${runDir}, whose ${RUN_FILE} cannot be read (${err.message}); run the tests with npm test`);
  }
  if (!run || run.schema !== RUN_SCHEMA || typeof run.repo_root !== 'string' || !Array.isArray(run.leaks)) {
    throw new Error(`tests/_tmp-guard.mjs: ${path.join(runDir, RUN_FILE)} is not a run record of schema ${RUN_SCHEMA}`);
  }
  const file = fileKey(run.repo_root, process.argv[1]);
  const declared = run.leaks.includes(file);
  // The run directory as it resolves now, before this file's directory is
  // made in it: the base of that directory's removal.
  const runBase = holdBase(path.resolve(runDir));
  const dir = fs.mkdtempSync(path.join(runDir, FILE_DIR_PREFIX));
  fs.writeFileSync(`${dir}${OWNER_SUFFIX}`, `${JSON.stringify({ file, pid: process.pid })}\n`);
  process.env.TMPDIR = dir;
  process.env[GUARD_OWNER_VAR] = dir;

  let counted = false;
  const count = () => {
    if (counted) return;
    counted = true;
    let names = [];
    let unreadable = false;
    try {
      names = fs.readdirSync(dir).filter((n) => !IGNORED_NAMES.includes(n)).sort();
    } catch (err) {
      if (!(err && err.code === 'ENOENT')) {
        names = [`(unreadable: ${err.code ?? err.message})`];
        // Kept in the result: the removal below may still succeed, and the
        // count was never taken.
        unreadable = true;
      }
    }
    const result = { file, count: names.length, names: names.slice(0, MAX_NAMES), ...(unreadable ? { unreadable: true } : {}) };
    let recorded = true;
    try {
      fs.writeFileSync(`${dir}${RESULT_SUFFIX}`, `${JSON.stringify(result)}\n`);
    } catch {
      // The directory is the evidence then: the runner counts what it holds,
      // marks the count incomplete, and removes it with the run directory.
      recorded = false;
    }
    if (recorded) {
      try {
        removeTree(runBase, dir);
      } catch (err) {
        process.stderr.write(`⚠ tests/_tmp-guard.mjs: could not remove ${dir}: ${err.message}\n`);
        // The directory stays with the entries counted above: the result
        // lists them all, or the runner would count them again as made
        // later; an entry not listed there was made after this count.
        try { fs.writeFileSync(`${dir}${RESULT_SUFFIX}`, `${JSON.stringify({ ...result, kept: names })}\n`); } catch { /* counted twice then: too high, never too low */ }
      }
    }
    if (names.length > 0 && !declared) {
      process.stderr.write(`✗ ${file} left ${names.length} entries in its temporary directory (${names.slice(0, 5).join(', ')}${names.length > 5 ? ', …' : ''}); `
        + 'remove each with tests/_tmp.mjs (tmpDir, fileTmpDirs), or declare the file in scripts/data/test-tmp-leaks.json\n');
      process.exitCode = 1;
    }
  };
  let hooked = false;
  process.on('exit', () => { if (!hooked) count(); });
  after(() => {
    hooked = true;
    process.on('exit', count);
  });
}
