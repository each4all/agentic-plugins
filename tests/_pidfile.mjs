// tests/_pidfile.mjs
//
// Reading a pid a test fixture published in a file, for a test that later
// signals it.
//
// A pid file that exists may still be empty: `writeFileSync` creates the file
// before it writes, and a reader between the two reads ''. `Number('')` is 0,
// and `process.kill(0, sig)` and `process.kill(-0, sig)` signal the caller's
// own process group: the test runner, `npm test` and every process sharing
// their group, such as the supervisor the autopilot's verification step runs a
// check under, which then ends without reporting (verification batch
// autopilot-20261101T020524Z-9f420b-s8-c27cad, 2026-11-01). So a test never
// signals a number read from a pid file: it signals what `readPid` returns,
// and only when that is not null.
//
// Not discovered by `node --test`: the stem `_pidfile` matches none of Node's
// test-file patterns.

import { readFileSync, renameSync, writeFileSync } from 'node:fs';

/**
 * The pid in `file`, a positive integer, or null when the file is missing,
 * empty, or holds anything else (0, a negative number, text).
 */
export function readPid(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { return null; }
  const s = text.trim();
  if (!/^[1-9][0-9]*$/.test(s)) return null;
  const pid = Number(s);
  return Number.isSafeInteger(pid) ? pid : null;
}

/**
 * Publish `pid` in `file` at once: written beside it, then renamed over it, so
 * a reader sees no file or the whole pid, never an empty one.
 */
export function publishPid(file, pid) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, String(pid));
  renameSync(tmp, file);
}
