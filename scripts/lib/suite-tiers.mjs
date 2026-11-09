// The test size tiers `npm test` runs in two passes (scripts/run-tests.mjs;
// AGENTS.md § Build / test / CI; ADR-0033, amendment of 2026-11-09).
//
//   small   one process, function calls only;
//   medium  subprocesses (git, CLIs) and temporary repositories;
//   large   depends on the state of the whole machine: the full process
//           listing, real CPU or elapsed time measured against a bound, a
//           runbook run end to end.
//
// Small and medium tests share the parallel pool; large tests run after it,
// in a pass of low concurrency, where the machine is quiet enough for what
// they measure to mean something. Only `large` is declared: every file the
// declaration does not name is in the pool. The declaration is one reviewed
// file, scripts/data/test-tiers.json, never a guess made at run time:
// `{ "schema": 1, "large": [<sorted repository-relative paths>] }`.
//
// Each entry must be a file Node's no-argument discovery finds in the whole
// repository (scripts/lib/discover-tests.mjs), so a renamed or deleted test
// cannot leave a stale name that quietly moves nothing. The loader is named
// `suite-tiers`, not `test-tiers`: a module matching discovery's `test-*`
// pattern would be run as a test file.

import fs from 'node:fs';
import path from 'node:path';

import { listTestFiles } from './discover-tests.mjs';
import { isSafeTestPath } from '../shard-tests.mjs';

export const TIERS_FILE = 'scripts/data/test-tiers.json';
export const TIERS_SCHEMA = 1;

/**
 * Checks a parsed declaration; returns its large files as a sorted array.
 * `discovered` is every file discovery finds in the repository. Throws,
 * naming every problem, on anything else.
 */
export function validateTiers(data, discovered, label = TIERS_FILE) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error(`${label} is not an object`);
  if (data.schema !== TIERS_SCHEMA) throw new Error(`${label} schema is not ${TIERS_SCHEMA}`);
  const extra = Object.keys(data).filter((k) => k !== 'schema' && k !== 'large');
  if (extra.length > 0) throw new Error(`${label} has keys it does not declare: ${extra.join(', ')}`);
  const { large } = data;
  if (!Array.isArray(large)) throw new Error(`${label} has no large array`);
  const problems = [];
  const found = new Set(discovered);
  const seen = new Set();
  large.forEach((rel, i) => {
    if (!isSafeTestPath(rel)) { problems.push(`entry ${i + 1} (${JSON.stringify(rel)}) is not a repository-relative path of letters, digits, . _ - /`); return; }
    if (seen.has(rel)) problems.push(`${rel} is declared twice`);
    seen.add(rel);
    if (!found.has(rel)) problems.push(`${rel} is not a test file discovery finds`);
    if (i > 0 && typeof large[i - 1] === 'string' && large[i - 1] > rel) problems.push(`${rel} is out of order (the list is sorted)`);
  });
  if (problems.length > 0) throw new Error(`${label} is refused:\n  ${problems.join('\n  ')}`);
  return [...large];
}

/** The repository's declared large files; `file` overrides the declaration's path. */
export function readTiers(repoRoot, file = path.join(repoRoot, TIERS_FILE)) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file} cannot be read as JSON: ${err.message}`);
  }
  return validateTiers(data, listTestFiles(repoRoot), file);
}

/**
 * Splits `files` (repository-relative POSIX paths, or anything `key` maps to
 * one) into the pool and the large pass, each in the order given.
 */
export function partitionByTier(files, large, key = (f) => f) {
  const big = new Set(large);
  const pool = [];
  const later = [];
  for (const f of files) (big.has(key(f)) ? later : pool).push(f);
  return { pool, large: later };
}
