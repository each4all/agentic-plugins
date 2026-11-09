#!/usr/bin/env node
// `npm test`'s runner: the suite in two passes by test size tier (ADR-0033,
// amendment of 2026-11-09; the tiers: scripts/lib/suite-tiers.mjs).
//
//   node scripts/run-tests.mjs [node test options] [files or directories]
//
// Pass 1 runs every small and medium file in the parallel pool, at the
// concurrency the caller gave (Node's default when none). Pass 2 runs the
// large files the declaration names (scripts/data/test-tiers.json) after it,
// at a concurrency of at most LARGE_CONCURRENCY: they read the whole process
// table or measure real time, which a pool that keeps every CPU busy makes
// mean nothing. A pass with no file is skipped, never run with none (a
// `node --test` with no file runs the whole discovery). The run fails when
// either pass failed; pass 2 runs after a failed pass 1 too, so one run
// reports every failure.
//
// THE ARGUMENTS. Each is `node --test`'s own, read the way Node reads them: an
// option in VALUE_OPTIONS takes the next argument as its value unless written
// `--option=value`; any other argument starting with `-` is a flag; `--` ends
// the options; everything else names files. With no file the pool and the
// large pass split Node's no-argument discovery (scripts/lib/discover-tests.mjs).
// A named file is passed as given and matched against the declaration by its
// repository-relative path (`./tests/x.mjs` and an absolute path are the same
// file); a directory stands for the discovered files under it; a glob Node
// would expand is expanded the same way. A name that matches nothing is
// refused: `node --test` given one runs the rest and exits 0. A file outside
// discovery (a probe a test runs through npm test) goes to the pool.
//
// THE REPORTERS. Node opens each file destination of `--test-reporter-
// destination` for writing, so pass 2 would overwrite what pass 1 wrote.
// When both passes run, pass 2 writes each file destination to a temporary
// file in a private directory, appended to the caller's after it and removed
// when the run ends; stdout and stderr are left alone. That suits a reporter
// that writes lines (spec, dot, the duration reporter). A reporter that
// writes one document per run (DOCUMENT_REPORTERS: tap, with its version line
// and its plan, and junit) would leave two documents wherever both passes
// write, a file, stdout or stderr, which no consumer of that format reads as
// one: it is refused when both passes run, with the cure. A duration
// recording holds one run summary per pass (scripts/shard-tests.mjs `record`
// checks each pass's files and summary).
//
// WATCH MODE. A `--watch` pass never exits, so the pass after it would never
// start and the large tier would be dropped without a word: refused when both
// passes run (the last of `--watch` and `--no-watch` decides, as in Node),
// with the cure (name one tier's files). `--watch-path` is left to Node,
// which refuses it beside `--test` in every pass, so the run fails.
//
// NODE_OPTIONS. Node reads the reporter and watch options from NODE_OPTIONS
// too, before the command line's, and each pass inherits them: they are
// judged with the arguments. A file destination given there cannot be
// redirected for pass 2, which would overwrite pass 1's output: refused when
// both passes run (pass it as an npm test argument). Node takes `_` for `-`
// in an option's name, so the names are read that way.
//
// THE PROCESSES. Each pass is a child in this process's own process group (a
// verification check's supervisor leads the group and is to cover it), with
// every inherited NODE_TEST_* variable removed: a `node --test` that inherits
// NODE_TEST_CONTEXT takes itself for a child, runs nothing and exits 0.
// SIGINT and SIGTERM are forwarded to the pass running, and no pass starts
// after one: the run then exits 128 + the signal's number, whatever the pass
// answered. A pass that cannot start exits 1.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { listTestFiles } from './lib/discover-tests.mjs';
import { partitionByTier, readTiers } from './lib/suite-tiers.mjs';

export const LARGE_CONCURRENCY = 2;

// The `node --test` options that take a value: written apart from it, the next
// argument is that value, never a file.
export const VALUE_OPTIONS = new Set([
  '--import', '--require', '-r', '--loader', '--experimental-loader', '--env-file', '--conditions', '-C',
  '--test-reporter', '--test-reporter-destination', '--test-name-pattern', '--test-skip-pattern',
  '--test-concurrency', '--test-timeout', '--test-shard', '--test-global-setup',
  '--test-coverage-include', '--test-coverage-exclude', '--watch-path',
]);

const GLOB_CHARS = /[*?[\]{}]/;

// Node's built-in reporters that write one document per run, which a second
// pass would follow with another: refused when both passes run.
export const DOCUMENT_REPORTERS = new Set(['tap', 'junit']);

/** Node's own reading of an option's name: `--test_reporter` is `--test-reporter`. */
const optionName = (n) => (n.startsWith('--') ? `--${n.slice(2).replaceAll('_', '-')}` : n);

/**
 * NODE_OPTIONS split as Node splits it: on white space, with a double-quoted
 * run kept whole and a backslash in it escaping the next character.
 */
export function splitNodeOptions(text = '') {
  const out = [];
  let cur = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"') {
      cur ??= '';
      for (i += 1; i < text.length && text[i] !== '"'; i += 1) {
        if (text[i] === '\\' && i + 1 < text.length) i += 1;
        cur += text[i];
      }
    } else if (/\s/.test(c)) {
      if (cur !== null) { out.push(cur); cur = null; }
    } else {
      cur = (cur ?? '') + c;
    }
  }
  if (cur !== null) out.push(cur);
  return out;
}

/**
 * Splits the arguments into options, each the list of its raw arguments with
 * its name, and file arguments. Throws on a value option with no value.
 */
export function parseArgs(argv) {
  const options = [];
  const files = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--') { files.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('-') && a !== '-') {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        options.push({ name: optionName(a.slice(0, eq)), value: a.slice(eq + 1), raw: [a] });
      } else if (VALUE_OPTIONS.has(optionName(a))) {
        if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
        options.push({ name: optionName(a), value: argv[i + 1], raw: [a, argv[i + 1]] });
        i += 1;
      } else {
        options.push({ name: optionName(a), value: null, raw: [a] });
      }
    } else {
      files.push(a);
    }
  }
  return { options, files };
}

const toKey = (repoRoot, p) => path.relative(repoRoot, path.resolve(repoRoot, p)).split(path.sep).join('/');

/**
 * The files to run, each `{ arg, key }`: the argument passed to Node and its
 * repository-relative path. `fsx` is the file system's view (for tests).
 */
export function resolveFiles(repoRoot, fileArgs, discovered, fsx = realFs) {
  if (fileArgs.length === 0) return discovered.map((rel) => ({ arg: rel, key: rel }));
  const out = [];
  const seen = new Set();
  const add = (arg, key) => { if (!seen.has(key)) { seen.add(key); out.push({ arg, key }); } };
  const refused = [];
  for (const arg of fileArgs) {
    const key = toKey(repoRoot, arg);
    const kind = fsx.kind(path.resolve(repoRoot, arg));
    if (kind === 'dir') {
      const under = discovered.filter((rel) => key === '' || rel.startsWith(`${key}/`));
      if (under.length === 0) refused.push(`${arg} is a directory with no test file discovery finds`);
      for (const rel of under) add(rel, rel);
    } else if (kind === 'file') {
      add(arg, key);
    } else if (GLOB_CHARS.test(arg)) {
      const matched = fsx.glob(arg, repoRoot);
      if (matched.length === 0) refused.push(`${arg} matches no file`);
      // An absolute pattern matches absolute paths: each is keyed by its
      // repository path, as a named file is.
      for (const m of matched) add(m, toKey(repoRoot, m));
    } else {
      refused.push(`${arg} does not exist`);
    }
  }
  if (refused.length > 0) {
    throw new Error(`refusing to run: node --test would skip these names and pass without them:\n  ${refused.join('\n  ')}`
      + '\n(an option that takes a value, written apart from it, can be read as a file: write it --option=value)');
  }
  return out;
}

const realFs = {
  kind(abs) {
    try {
      const st = fs.statSync(abs);
      return st.isDirectory() ? 'dir' : 'file';
    } catch {
      return null;
    }
  },
  glob(pattern, cwd) {
    return fs.globSync(pattern, { cwd, exclude: (name) => name === 'node_modules' })
      .map((rel) => rel.split(path.sep).join('/'))
      .filter((rel) => realFs.kind(path.resolve(cwd, rel)) === 'file')
      .sort();
  },
};

/**
 * The passes to run: each `{ tier, args, files, destinations }`, where `args`
 * follow `node` (`--test` first) and `destinations` maps each temporary
 * reporter file of pass 2 to the caller's. A pass with no file is left out.
 */
export function buildPasses({ argv, repoRoot, discovered, large, nodeOptions = '', fsx = realFs, tmpFile = defaultTmpFile }) {
  const { options, files } = parseArgs(argv);
  const resolved = resolveFiles(repoRoot, files, discovered, fsx);
  const { pool, large: later } = partitionByTier(resolved, large, (f) => f.key);
  if (pool.length > 0 && later.length > 0) refuseTwoPassModes(options, parseArgs(splitNodeOptions(nodeOptions)).options);
  const flat = (opts) => opts.flatMap((o) => o.raw);
  const passes = [];
  if (pool.length > 0) {
    passes.push({ tier: 'pool', args: ['--test', ...flat(options), ...pool.map((f) => f.arg)], files: pool.map((f) => f.key), destinations: [] });
  }
  if (later.length > 0) {
    // The caller's concurrency, capped; a value that is no positive count is
    // passed as given, for Node to refuse in this pass as in the pool.
    const asked = options.filter((o) => o.name === '--test-concurrency').at(-1);
    const n = asked ? Number(asked.value) : NaN;
    const concurrency = !asked || (Number.isInteger(n) && n > 0)
      ? [`--test-concurrency=${asked ? Math.min(n, LARGE_CONCURRENCY) : LARGE_CONCURRENCY}`]
      : asked.raw;
    const destinations = [];
    const opts = options.filter((o) => o.name !== '--test-concurrency').map((o) => {
      if (o.name !== '--test-reporter-destination') return o;
      if (passes.length === 0 || o.value === 'stdout' || o.value === 'stderr') return o;
      const tmp = tmpFile();
      destinations.push({ tmp, target: path.resolve(repoRoot, o.value) });
      return { ...o, value: tmp, raw: [`--test-reporter-destination=${tmp}`] };
    });
    passes.push({
      tier: 'large',
      args: ['--test', ...flat(opts), ...concurrency, ...later.map((f) => f.arg)],
      files: later.map((f) => f.key),
      destinations,
    });
  }
  return passes;
}

// The modes two passes cannot honour, refused before anything runs when both
// passes would: a document reporter (two documents), watch mode (no pass 2)
// and a file destination in NODE_OPTIONS (pass 2 overwrites it). `inherited`
// are NODE_OPTIONS' options, which Node reads before the arguments'.
function refuseTwoPassModes(options, inherited = []) {
  const cure = 'run the pool and the large tier as two npm test runs, naming each one\'s files '
    + '(the large ones are listed in scripts/data/test-tiers.json)';
  const all = [...inherited, ...options];
  const watch = all.filter((o) => o.name === '--watch' || o.name === '--no-watch').at(-1);
  if (watch && watch.name === '--watch') {
    throw new Error(`${watch.raw[0]}${inherited.includes(watch) ? ' (in NODE_OPTIONS)' : ''} keeps the pool running until it is stopped, `
      + `so the large tier would never run: ${cure}`);
  }
  const fileDest = inherited.find((o) => o.name === '--test-reporter-destination' && o.value !== 'stdout' && o.value !== 'stderr');
  if (fileDest) {
    throw new Error(`NODE_OPTIONS names the reporter destination ${fileDest.value}, which the large pass would overwrite: `
      + 'pass the reporter options as npm test arguments instead, where the runner appends both passes\' output');
  }
  // Node pairs the i-th reporter with the i-th destination; one reporter and
  // no destination writes to stdout, and none at all is spec.
  const reporters = all.filter((o) => o.name === '--test-reporter').map((o) => o.value);
  const dests = all.filter((o) => o.name === '--test-reporter-destination').map((o) => o.value);
  const i = reporters.findIndex((r) => DOCUMENT_REPORTERS.has(r));
  if (i !== -1) {
    const where = dests[i] ?? (dests.length === 0 ? 'stdout' : 'its destination');
    throw new Error(`the ${reporters[i]} reporter writes one document per run, and the two passes would leave two in ${where}: `
      + `${cure}, each with its own destination`);
  }
}

// Each call a new name in this run's private directory, which removeTmp
// removes.
let tmpDir = null;
let tmpCount = 0;
export function defaultTmpFile() {
  tmpDir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'run-tests-'));
  tmpCount += 1;
  return path.join(tmpDir, `reporter-${tmpCount}.out`);
}

/** Removes the private directory defaultTmpFile made, if it made one. */
export function removeTmp() {
  if (tmpDir === null) return;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (err) {
    // A directory left behind fails no test: the run's status stands.
    process.stderr.write(`⚠ run-tests: could not remove ${tmpDir}: ${err.message}\n`);
  }
  tmpDir = null;
}

/** The children's environment: this one with every NODE_TEST_* removed. */
export function childEnv(env = process.env) {
  const out = { ...env };
  for (const name of Object.keys(out)) if (name.startsWith('NODE_TEST_')) delete out[name];
  return out;
}

/** Runs the passes; resolves the run's exit status. */
export async function runPasses(passes, { env = childEnv(), log = (m) => process.stderr.write(`${m}\n`) } = {}) {
  let signalled = null;
  let child = null;
  const onSignal = (sig) => {
    signalled ??= sig;
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill(sig); } catch { /* gone */ }
    }
  };
  const handlers = { SIGINT: () => onSignal('SIGINT'), SIGTERM: () => onSignal('SIGTERM') };
  for (const [sig, h] of Object.entries(handlers)) process.on(sig, h);
  let status = 0;
  try {
    for (const pass of passes) {
      if (signalled) break;
      if (passes.length > 1) {
        log(`run-tests: ${pass.tier === 'pool' ? 'the parallel pool' : 'the large tier (scripts/data/test-tiers.json)'}, ${pass.files.length} files`);
      }
      const res = await new Promise((done) => {
        child = spawn(process.execPath, pass.args, { stdio: 'inherit', env });
        child.once('error', (err) => done({ error: err }));
        child.once('exit', (code, sig) => done({ code, sig }));
      });
      child = null;
      if (res.error) {
        log(`✗ run-tests: node --test could not start: ${res.error.message}`);
        return 1;
      }
      for (const { tmp, target } of pass.destinations) {
        try {
          fs.appendFileSync(target, fs.readFileSync(tmp));
        } catch (err) {
          log(`✗ run-tests: could not append the large pass's reporter output to ${target}: ${err.message}`);
          if (status === 0) status = 1;
        }
      }
      const code = res.code ?? 128 + (os.constants.signals[res.sig] ?? 0);
      if (code !== 0 && status === 0) status = code;
    }
  } finally {
    for (const [sig, h] of Object.entries(handlers)) process.off(sig, h);
  }
  if (signalled) return 128 + os.constants.signals[signalled];
  return status;
}

export async function main(argv, { repoRoot = process.cwd() } = {}) {
  try {
    let passes;
    try {
      const discovered = listTestFiles(repoRoot);
      const large = readTiers(repoRoot);
      passes = buildPasses({ argv, repoRoot, discovered, large, nodeOptions: process.env.NODE_OPTIONS ?? '' });
    } catch (err) {
      process.stderr.write(`✗ run-tests: ${err.message}\n`);
      return 1;
    }
    if (passes.length === 0) {
      process.stderr.write('run-tests: no test file to run\n');
      return 0;
    }
    return await runPasses(passes);
  } finally {
    removeTmp();
  }
}

const invoked = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
if (invoked === fs.realpathSync(fileURLToPath(import.meta.url))) {
  (async () => { process.exitCode = await main(process.argv.slice(2)); })();
}
