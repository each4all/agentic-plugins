#!/usr/bin/env node
// Splits `npm test`'s files into the shards full-tests.yml runs (ADR-0033,
// amendment of 2026-10-19), and runs one shard.
//
// The suite outgrew one job: 24.5 to 25 minutes on green runs, against a
// 25-minute step bound. The workflow now runs it as a matrix of N shards, each
// of which calls this script with its index; together they must run every
// test file exactly once.
//
//   node scripts/shard-tests.mjs run <i>/<N>     run shard i of N through npm test
//   node scripts/shard-tests.mjs list <i>/<N>    print shard i's files
//   node scripts/shard-tests.mjs plan [N]        each shard's files and weight
//   node scripts/shard-tests.mjs record --from <file.jsonl>
//                                                rewrite the recorded durations
//   (each takes --repo-root <dir>; the default is this script's repository)
//
// THE FILES. The list is Node's own no-argument discovery, the files `npm test`
// runs with no argument (scripts/lib/discover-tests.mjs, held to a real
// `node --test` by its test). No list is kept anywhere: a new test file lands
// in a shard by being created.
//
// THE ASSIGNMENT. Each file weighs its recorded seconds
// (scripts/data/test-weights.json) plus a fixed per-file overhead, or a fixed
// estimate when it has no recording. Files are placed heaviest first (ties by
// path), each into the least-loaded shard (ties to the lowest index): the
// longest-processing-time rule, deterministic for one tree and one weights
// file, so every shard of one run computes the same partition. Before any
// shard runs, the whole partition is checked: every discovered file in exactly
// one shard, no shard empty, every path of a shape that reaches the runner
// unchanged. Anything else stops the shard, naming the files.
//
// THE LAUNCH. `run` starts `npm test -- <files>` itself, with an argument
// array, so the flags `npm test` carries (the hermetic preload, the per-test
// timeout) are the suite's own. npm runs the script through `sh`; the path
// rule above keeps each name one word there, with nothing to expand or
// substitute. It first checks that each file exists (`node --test` given a
// name that matches nothing runs the rest and exits 0) and that package.json
// has no `pretest` hook that could change the files after that check. It
// removes any inherited `NODE_TEST_*` variable from npm's environment: a
// `node --test` that inherits `NODE_TEST_CONTEXT` takes itself for a child,
// runs nothing and exits 0.
//
// THE WEIGHTS. `record` rewrites the weights file from one full run's
// per-file durations, written by scripts/lib/duration-reporter.mjs (its header
// has the command). It refuses a run that did not finish or did not pass, or
// that missed a discovered file. Weights only balance the shards: stale or
// missing ones cost time, never coverage.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { listTestFiles } from './lib/discover-tests.mjs';

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const WEIGHTS_FILE = 'scripts/data/test-weights.json';
export const WEIGHTS_SCHEMA = 1;
// A file's process start and preload, which its recorded duration leaves out.
export const OVERHEAD_SECONDS = 0.5;
// The estimate for a file with no recording yet.
export const UNRECORDED_SECONDS = 5;
export const MIN_SHARDS = 2;
export const MAX_SHARDS = 4;

/**
 * A path the runner receives unchanged: repository-relative, POSIX, only
 * letters, digits, `.`, `_`, `-` and `/`, no empty, `.` or `..` segment, and
 * not starting with `-`, which `node` would read as an option. Glob characters
 * are excluded too: `node --test` reads each file argument as a pattern.
 */
export function isSafeTestPath(rel) {
  return typeof rel === 'string'
    && /^[A-Za-z0-9._/-]+$/.test(rel)
    && !rel.startsWith('-')
    && rel.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** Parses `<i>/<N>`; throws on anything else. */
export function parseShardSpec(spec) {
  const m = /^([1-9])\/([1-9])$/.exec(String(spec ?? ''));
  if (!m) throw new Error(`a shard is <i>/<N>, such as 1/3; got '${spec}'`);
  const index = Number(m[1]);
  const total = Number(m[2]);
  checkTotal(total);
  if (index > total) throw new Error(`shard ${index} of ${total} does not exist`);
  return { index, total };
}

function checkTotal(total) {
  if (!Number.isInteger(total) || total < MIN_SHARDS || total > MAX_SHARDS) {
    throw new Error(`the shard count is ${MIN_SHARDS} to ${MAX_SHARDS}; got ${total}`);
  }
}

/** The recorded seconds per file, validated; throws on a malformed file. */
export function readWeights(repoRoot) {
  const file = path.join(repoRoot, WEIGHTS_FILE);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${WEIGHTS_FILE} cannot be read as JSON: ${err.message}`);
  }
  return validateWeights(data);
}

export function validateWeights(data) {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${WEIGHTS_FILE} is not an object`);
  }
  if (data.schema !== WEIGHTS_SCHEMA) throw new Error(`${WEIGHTS_FILE} schema is not ${WEIGHTS_SCHEMA}`);
  const { seconds } = data;
  if (seconds === null || typeof seconds !== 'object' || Array.isArray(seconds)) {
    throw new Error(`${WEIGHTS_FILE} has no seconds object`);
  }
  const bad = Object.entries(seconds)
    .filter(([rel, s]) => !isSafeTestPath(rel) || typeof s !== 'number' || !Number.isFinite(s) || s < 0)
    .map(([rel, s]) => `${rel}: ${JSON.stringify(s)}`);
  if (bad.length > 0) {
    throw new Error(`${WEIGHTS_FILE} has entries that are not a safe path with a finite, non-negative number:\n  ${bad.join('\n  ')}`);
  }
  return new Map(Object.entries(seconds));
}

export function weightOf(rel, seconds) {
  return (seconds.has(rel) ? seconds.get(rel) : UNRECORDED_SECONDS) + OVERHEAD_SECONDS;
}

/**
 * Longest processing time first: heaviest file first (ties by path), each to
 * the least-loaded shard (ties to the lowest index). Returns one sorted file
 * list per shard and each shard's estimated seconds.
 */
export function assignShards(files, seconds, total) {
  checkTotal(total);
  const shards = Array.from({ length: total }, () => []);
  const loads = new Array(total).fill(0);
  const order = files
    .map((rel) => ({ rel, weight: weightOf(rel, seconds) }))
    .sort((a, b) => b.weight - a.weight || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  for (const { rel, weight } of order) {
    let target = 0;
    for (let i = 1; i < total; i += 1) if (loads[i] < loads[target]) target = i;
    shards[target].push(rel);
    loads[target] += weight;
  }
  for (const shard of shards) shard.sort();
  return { shards, loads };
}

/**
 * Every way `shards` fails to be an exact partition of `files`: a file in no
 * shard or in two, a shard file that was not discovered, an empty shard, a
 * path the runner would not receive unchanged. Empty when it is one.
 */
export function partitionProblems(files, shards) {
  const problems = [];
  const seen = new Map();
  shards.forEach((shard, i) => {
    if (shard.length === 0) problems.push(`shard ${i + 1} of ${shards.length} is empty`);
    for (const rel of shard) seen.set(rel, [...(seen.get(rel) ?? []), i + 1]);
  });
  const discovered = new Set(files);
  for (const rel of files) {
    const where = seen.get(rel) ?? [];
    if (where.length === 0) problems.push(`${rel} is in no shard`);
    else if (where.length > 1) problems.push(`${rel} is in shards ${where.join(', ')}`);
  }
  for (const rel of seen.keys()) if (!discovered.has(rel)) problems.push(`${rel} is in a shard but was not discovered`);
  for (const rel of files) if (!isSafeTestPath(rel)) problems.push(`${rel} is not a path the runner receives unchanged (letters, digits, . _ - /)`);
  return problems;
}

/** The checked partition of the repository's suite into `total` shards; throws on any problem. */
export function planShards(repoRoot, total) {
  const files = listTestFiles(repoRoot);
  const { shards, loads } = assignShards(files, readWeights(repoRoot), total);
  const problems = partitionProblems(files, shards);
  if (problems.length > 0) {
    throw new Error(`the ${total} shards are not an exact partition of the ${files.length} test files:\n  ${problems.join('\n  ')}`);
  }
  return { files, shards, loads };
}

/** package.json's scripts; none when it has no package.json. */
function readPackageScripts(repoRoot) {
  let text;
  try {
    text = fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return {};
    throw err;
  }
  return JSON.parse(text).scripts ?? {};
}

/** Runs one shard through `npm test -- <files>`; returns npm's exit status. */
export function runShard(repoRoot, index, total, { log = console.log } = {}) {
  const { shards, loads } = planShards(repoRoot, total);
  const files = shards[index - 1];
  const missing = files.filter((rel) => !fs.existsSync(path.join(repoRoot, rel)));
  if (missing.length > 0) {
    throw new Error(`shard ${index}/${total} names files that do not exist:\n  ${missing.join('\n  ')}`);
  }
  if (Object.hasOwn(readPackageScripts(repoRoot), 'pretest')) {
    throw new Error('package.json has a pretest script, which would run after the files were checked and before node --test reads them');
  }
  log(`Shard ${index}/${total}: ${files.length} test files, weight ${Math.round(loads[index - 1])} s of recorded file time:`);
  for (const rel of files) log(`  ${rel}`);
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('NODE_TEST_')) delete env[name];
  const res = spawnSync('npm', ['test', '--', ...files], { cwd: repoRoot, env, stdio: 'inherit' });
  if (res.error) throw new Error(`npm test could not start: ${res.error.message}`);
  return res.status ?? 1;
}

/**
 * Reads a duration-reporter recording and returns the weights file's new
 * content; throws when the run did not finish or missed a discovered file.
 */
export function weightsFromRecording(repoRoot, text) {
  const root = fs.realpathSync(repoRoot);
  const seconds = new Map();
  const problems = [];
  const lines = text.split('\n').filter((line) => line.trim() !== '');
  lines.forEach((line, n) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      problems.push(`line ${n + 1} is not JSON`);
      return;
    }
    if (event?.summary === true) {
      // The run's summary is its last line, and only that.
      if (n !== lines.length - 1) problems.push(`line ${n + 1} is a run summary before the end of the recording`);
      else if (event.success !== true || event.counts?.cancelled !== 0) problems.push('the run did not pass: its summary is not a success with no test cancelled');
      return;
    }
    const ms = event?.duration_ms;
    if (typeof event?.file !== 'string' || typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
      problems.push(`line ${n + 1} is neither a file's duration nor the run's summary`);
      return;
    }
    // The directory is resolved (the run's cwd may be spelled through a
    // link, /tmp for /private/tmp), never the file: a test file that is a
    // link is discovered under its own name.
    const abs = path.resolve(root, event.file);
    let dir = path.dirname(abs);
    try {
      dir = fs.realpathSync(dir);
    } catch { /* a directory gone since the run is reported below */ }
    const rel = path.relative(root, path.join(dir, path.basename(abs))).split(path.sep).join('/');
    if (!isSafeTestPath(rel)) problems.push(`${event.file} is not a test path inside the repository`);
    else if (seconds.has(rel)) problems.push(`${rel} is recorded twice`);
    else seconds.set(rel, ms / 1000);
  });
  const last = lines.length > 0 ? (() => { try { return JSON.parse(lines.at(-1)); } catch { return null; } })() : null;
  if (last?.summary !== true) problems.push('the recording does not end with the run\'s summary: the run did not finish');
  const discovered = listTestFiles(repoRoot);
  const found = new Set(discovered);
  for (const rel of discovered) if (!seconds.has(rel)) problems.push(`${rel} has no recorded duration`);
  for (const rel of seconds.keys()) if (!found.has(rel)) problems.push(`${rel} was recorded but is not discovered`);
  if (problems.length > 0) throw new Error(`refusing the recording:\n  ${problems.join('\n  ')}`);
  const sorted = Object.fromEntries([...seconds.keys()].sort().map((rel) => [rel, Math.round(seconds.get(rel) * 10) / 10]));
  return {
    schema: WEIGHTS_SCHEMA,
    recorded: new Date().toISOString().slice(0, 10),
    source: `one full npm test run, Node ${process.version}, ${os.platform()}, ${os.availableParallelism()} CPUs`,
    seconds: sorted,
  };
}

function parseArgs(argv) {
  const out = { positional: [], repoRoot: DEFAULT_REPO_ROOT, from: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--repo-root' || a === '--from') {
      if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`);
      if (a === '--repo-root') out.repoRoot = path.resolve(argv[i + 1]);
      else out.from = argv[i + 1];
      i += 1;
    } else if (a.startsWith('--')) {
      throw new UsageError(`unknown option ${a}`);
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

class UsageError extends Error {}

const USAGE = 'usage: shard-tests.mjs run <i>/<N> | list <i>/<N> | plan [N] | record --from <file.jsonl> [--repo-root <dir>]';

export function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
    const [command, operand, extra] = args.positional;
    if (extra !== undefined) throw new UsageError(`unexpected argument ${extra}`);
    if (command === 'run' || command === 'list') {
      const { index, total } = parseShardSpec(operand);
      if (command === 'run') return runShard(args.repoRoot, index, total);
      for (const rel of planShards(args.repoRoot, total).shards[index - 1]) console.log(rel);
      return 0;
    }
    if (command === 'plan') {
      const totals = operand === undefined ? [2, 3, 4] : [Number(operand)];
      for (const total of totals) {
        const { files, loads, shards } = planShards(args.repoRoot, total);
        console.log(`${total} shards over ${files.length} files (weight: seconds of recorded file time, not wall time): `
          + shards.map((s, i) => `${i + 1}: ${s.length} files, weight ${Math.round(loads[i])} s`).join('; '));
      }
      return 0;
    }
    if (command === 'record') {
      if (operand !== undefined) throw new UsageError(`unexpected argument ${operand}`);
      if (args.from === null) throw new UsageError('record needs --from <file.jsonl>');
      const content = weightsFromRecording(args.repoRoot, fs.readFileSync(args.from, 'utf8'));
      fs.writeFileSync(path.join(args.repoRoot, WEIGHTS_FILE), `${JSON.stringify(content, null, 2)}\n`);
      console.log(`${WEIGHTS_FILE}: ${Object.keys(content.seconds).length} files recorded`);
      return 0;
    }
    throw new UsageError(command === undefined ? 'no command' : `unknown command ${command}`);
  } catch (err) {
    console.error(`✗ shard-tests: ${err.message}`);
    if (err instanceof UsageError) {
      console.error(USAGE);
      return 2;
    }
    return 1;
  }
}

const invoked = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
if (invoked === fs.realpathSync(fileURLToPath(import.meta.url))) process.exitCode = main(process.argv.slice(2));
