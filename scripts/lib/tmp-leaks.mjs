// The temporary-file leak guard of `npm test` (docket C175; AGENTS.md
// § Build / test / CI; ADR-0033, amendment of 2026-11-10): its declaration of
// the test files still allowed to leave entries in their TMPDIR, the run
// directory scripts/run-tests.mjs hands the guard, and the run's summary.
//
// HOW A RUN IS GUARDED. scripts/run-tests.mjs makes one run directory under
// `os.tmpdir()` (`tg-XXXXXX`), writes `run.json` there (the repository root
// and the declared files), passes its path to every `node --test` pass in
// TEST_TMP_GUARD_DIR, and loads tests/_tmp-guard.mjs first in each test file's
// process. The guard makes that file its own directory in the run directory
// (`f-XXXXXX`, with an owner record `f-XXXXXX.owner.json` beside it), points
// the file's TMPDIR at it, and at the file's exit records what is left in it
// (`f-XXXXXX.result.json`) and removes it; a directory there again when the
// passes end holds entries made after that count (an exit listener that ran
// later), which the runner adds to the file's count. A file not declared that left
// anything fails; a declared one passes. Because each file has a directory of
// its own, an entry is charged to the file that made it, never to one running
// beside it. When the passes end, the runner reconciles the owner and result
// records against the files it ran, prints the summary and removes the run
// directory.
//
// THE DECLARATION. scripts/data/test-tmp-leaks.json:
// `{ "schema": 1, "leaks": [<sorted repository-relative paths>] }`, each a
// file Node's no-argument discovery finds. A file adopting tests/_tmp.mjs
// leaves the list once it leaves nothing; the summary names each listed file
// that ran to its end and left nothing ("stale").
//
// A COUNT THAT IS NOT WHOLE FAILS THE RUN, declared or not (guardFailures): a
// file that ended before its result, a file's directory that cannot be
// listed, one the guard could not remove, a run directory that cannot be
// read, and a file the passes named that left no record. Only "left entries"
// depends on the declaration. With Node's own `--test-shard` or `--watch`
// among the options Node leaves named files unrun, so a file with no record
// is then reported, not failed.
//
// The variable's name has no
// AGENTIC_ prefix: tests/_hermetic-env.mjs removes AGENTIC_*_ROOT from every
// test process.
//
// Not discovered by `node --test`: `tmp-leaks` matches none of its patterns.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isSafeTestPath } from '../shard-tests.mjs';

export const LEAKS_FILE = 'scripts/data/test-tmp-leaks.json';
export const LEAKS_SCHEMA = 1;
export const GUARD_DIR_VAR = 'TEST_TMP_GUARD_DIR';
// Set in a guarded file's process to its own directory: a process it starts
// with the guard loaded inherits it, and stays unguarded rather than taking
// itself for a test file.
export const GUARD_OWNER_VAR = 'TEST_TMP_GUARD_OWNER';
export const RUN_FILE = 'run.json';
export const RUN_SCHEMA = 1;
// The names the guard writes in the run directory.
export const FILE_DIR_PREFIX = 'f-';
export const OWNER_SUFFIX = '.owner.json';
export const RESULT_SUFFIX = '.result.json';
// How many entry names a result keeps (its count is always whole).
export const MAX_NAMES = 20;
// Entries a file's directory may hold that are no leak: npm (10 and later)
// keeps its module compile cache in `os.tmpdir()/node-compile-cache`, one
// directory reused by every npm process, which a test that runs `npm` makes
// in its own TMPDIR. It is removed with that directory.
export const IGNORED_NAMES = Object.freeze(['node-compile-cache']);

/**
 * Checks a parsed declaration; returns its files as a sorted array.
 * `discovered` is every file discovery finds. Throws, naming every problem.
 */
export function validateLeaks(data, discovered, label = LEAKS_FILE) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${label} is not an object`);
  if (data.schema !== LEAKS_SCHEMA) throw new Error(`${label} schema is not ${LEAKS_SCHEMA}`);
  const extra = Object.keys(data).filter((k) => k !== 'schema' && k !== 'leaks');
  if (extra.length > 0) throw new Error(`${label} has keys it does not declare: ${extra.join(', ')}`);
  const { leaks } = data;
  if (!Array.isArray(leaks)) throw new Error(`${label} has no leaks array`);
  const problems = [];
  const found = new Set(discovered);
  const seen = new Set();
  leaks.forEach((rel, i) => {
    if (!isSafeTestPath(rel)) { problems.push(`entry ${i + 1} (${JSON.stringify(rel)}) is not a repository-relative path of letters, digits, . _ - /`); return; }
    if (seen.has(rel)) problems.push(`${rel} is declared twice`);
    seen.add(rel);
    if (!found.has(rel)) problems.push(`${rel} is not a test file discovery finds`);
    if (i > 0 && typeof leaks[i - 1] === 'string' && leaks[i - 1] > rel) problems.push(`${rel} is out of order (the list is sorted)`);
  });
  if (problems.length > 0) throw new Error(`${label} is refused:\n  ${problems.join('\n  ')}`);
  return [...leaks];
}

/**
 * The repository's declared files. A repository with no declaration declares
 * none, so every file that leaves an entry fails.
 */
export function readLeaks(repoRoot, discovered, file = path.join(repoRoot, LEAKS_FILE)) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw new Error(`${file} cannot be read: ${err.message}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} cannot be read as JSON: ${err.message}`);
  }
  return validateLeaks(data, discovered, file);
}

/**
 * A test file's identity, in `/` form: its path as `node --test` resolved it,
 * relative to the repository's real path, the key discovery and the
 * declaration use, a link's own path included. Only a file that path puts
 * outside the repository (its directory reached through another spelling,
 * /var for /private/var on macOS) is keyed by its real path.
 */
export function fileKey(repoRoot, file) {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  const root = real(repoRoot);
  const asGiven = path.relative(root, path.resolve(file));
  const rel = asGiven.startsWith('..') || path.isAbsolute(asGiven) ? path.relative(root, real(file)) : asGiven;
  return rel.split(path.sep).join('/');
}

/**
 * Makes a run directory under `tmp` and writes its run.json; returns its
 * path. A directory whose run.json cannot be written is removed.
 */
export function startRun({ repoRoot, leaks, tmp = os.tmpdir() }) {
  const dir = fs.mkdtempSync(path.join(tmp, 'tg-'));
  try {
    fs.writeFileSync(path.join(dir, RUN_FILE), `${JSON.stringify({ schema: RUN_SCHEMA, repo_root: repoRoot, leaks })}\n`);
  } catch (err) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* the error below is the one to report */ }
    throw err;
  }
  return dir;
}

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

/**
 * What a run left, from its run directory: `{ files: Map<key, {count,
 * names, complete, late, unreadable, kept}>, missing: [keys run with no
 * record] }`. Throws when the run directory cannot be listed. A file whose
 * process ended without its result (killed) is charged what its directory
 * still holds, and is incomplete. A file with a result whose directory is
 * there again is charged what it holds too (`late`): the guard removed the
 * directory after its count, so those entries were made after it (when the
 * removal failed, the result's `kept` lists the entries counted, and only
 * the others are late). A directory that is there and cannot be listed counts
 * as one entry, named for the error, and marks the file `unreadable`: nothing
 * unseen passes as nothing. `kept` marks a file whose directory the guard
 * could not remove. `ran` are the keys of every file the passes named.
 */
export function collectRun(runDir, ran) {
  const files = new Map();
  const names = fs.readdirSync(runDir);
  for (const name of names) {
    if (!name.startsWith(FILE_DIR_PREFIX) || !name.endsWith(OWNER_SUFFIX)) continue;
    const base = name.slice(0, -OWNER_SUFFIX.length);
    const owner = readJson(path.join(runDir, name));
    if (!owner || typeof owner.file !== 'string') continue;
    const result = readJson(path.join(runDir, `${base}${RESULT_SUFFIX}`));
    let left = [];
    let unreadable = false;
    try {
      left = fs.readdirSync(path.join(runDir, base)).filter((n) => !IGNORED_NAMES.includes(n)).sort();
    } catch (err) {
      if (!(err && err.code === 'ENOENT')) {
        left = [`(unreadable: ${(err && err.code) ?? 'error'})`];
        unreadable = true;
      }
    }
    let entry;
    // A result is taken only as its owner's and with a count that can be one:
    // anything else is no result, and the file's count is incomplete.
    if (result && result.file === owner.file && Number.isInteger(result.count) && result.count >= 0) {
      if (result.unreadable === true) unreadable = true;
      const counted = Array.isArray(result.kept) ? new Set(result.kept) : null;
      const late = counted ? left.filter((n) => !counted.has(n)) : left;
      entry = { count: result.count + late.length, names: [...(Array.isArray(result.names) ? result.names : []), ...late].slice(0, MAX_NAMES), complete: true, late: late.length, unreadable, kept: counted !== null };
    } else {
      entry = { count: left.length, names: left.slice(0, MAX_NAMES), complete: false, late: 0, unreadable, kept: false };
    }
    const prev = files.get(owner.file);
    if (prev) {
      // One file run twice (named twice, or a process it started with the
      // guard): the counts add up, and either incomplete makes it so.
      files.set(owner.file, {
        count: prev.count + entry.count, names: [...prev.names, ...entry.names].slice(0, MAX_NAMES), complete: prev.complete && entry.complete,
        late: prev.late + entry.late, unreadable: prev.unreadable || entry.unreadable, kept: prev.kept || entry.kept,
      });
    } else {
      files.set(owner.file, entry);
    }
  }
  // The files the passes named, under the identity the guard recorded them
  // with (fileKey, from the run's own repository root): a file named through
  // another spelling of the repository is the same file.
  const run = readJson(path.join(runDir, RUN_FILE));
  const keyOf = (k) => (run && typeof run.repo_root === 'string' ? fileKey(run.repo_root, path.resolve(run.repo_root, k)) : k);
  const missing = ran.filter((k) => !files.has(k) && !files.has(keyOf(k)));
  return { files, missing };
}

/**
 * The summary lines of a run: the entries left in total, each file that left
 * any (most first, declared or not), the declared files that ran to their end
 * and left none (stale), and the files with no complete record. `stale` names
 * a file only from a whole record: one that ran to its result, whose
 * directory was read and removed.
 */
export function summarize({ files, missing }, leaks) {
  const listed = new Set(leaks);
  const leakers = [...files].filter(([, e]) => e.count > 0).sort((a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : 1));
  const total = leakers.reduce((n, [, e]) => n + e.count, 0);
  const unlisted = leakers.filter(([k]) => !listed.has(k));
  const stale = [...files].filter(([k, e]) => listed.has(k) && e.complete && !e.unreadable && !e.kept && e.count === 0).map(([k]) => k).sort();
  const incomplete = [...files].filter(([, e]) => !e.complete).map(([k]) => k).sort();
  const unreadable = [...files].filter(([, e]) => e.unreadable).map(([k]) => k).sort();
  const kept = [...files].filter(([, e]) => e.kept).map(([k]) => k).sort();
  const lines = [`run-tests: temporary entries left: ${total} by ${leakers.length} of ${files.size} files (${unlisted.length} not declared in ${LEAKS_FILE})`];
  for (const [k, e] of leakers) {
    lines.push(`  ${e.count}\t${k}${listed.has(k) ? '' : ' (not declared: fails)'}${e.complete ? '' : ' (incomplete)'}${e.late > 0 ? ` (${e.late} made after its count)` : ''}\t${e.names.slice(0, 3).join(' ')}`);
  }
  if (stale.length > 0) {
    lines.push(`run-tests: ${stale.length} declared files left nothing (remove them from ${LEAKS_FILE}): ${stale.join(' ')}`);
  }
  if (incomplete.length > 0 || missing.length > 0) {
    lines.push(`run-tests: the count is incomplete: ${[...incomplete.map((k) => `${k} (ended before its result)`), ...missing.map((k) => `${k} (no record)`)].join(', ')}`);
  }
  return { lines, total, leakers: leakers.length, unlisted: unlisted.length, stale, incomplete, missing, unreadable, kept };
}

/**
 * Why a guarded run fails, one line each; none when it passes. `summary` is
 * null when the run directory could not be read, `removed` false when it
 * could not be removed, and `partial` true when Node itself leaves named
 * files unrun (`--test-shard`, `--watch`), so a file with no record is no
 * failure then. Only the first reason depends on the declaration.
 */
export function guardFailures({ summary, removed = true, partial = false }) {
  const out = [];
  if (!summary) {
    out.push('what the test files left could not be read');
  } else {
    if (summary.unlisted > 0) out.push(`${summary.unlisted} files not declared in ${LEAKS_FILE} left temporary entries (above)`);
    if (summary.incomplete.length > 0) out.push(`${summary.incomplete.length} files ended before their result: ${summary.incomplete.join(' ')}`);
    if (summary.unreadable.length > 0) out.push(`the temporary directory of ${summary.unreadable.length} files could not be listed: ${summary.unreadable.join(' ')}`);
    if (summary.kept.length > 0) out.push(`the temporary directory of ${summary.kept.length} files could not be removed: ${summary.kept.join(' ')}`);
    if (!partial && summary.missing.length > 0) out.push(`${summary.missing.length} files ran with no record: ${summary.missing.join(' ')}`);
  }
  if (!removed) out.push('the run directory could not be removed');
  return out;
}
