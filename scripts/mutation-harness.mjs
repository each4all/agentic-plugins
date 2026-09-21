#!/usr/bin/env node
// Mutation harness — run a set of deliberate defects against a set of tests and
// score each one against its stated expectation.
//
// WHY THIS EXISTS AS A TOOL AND NOT AS A ONE-OFF. A green test suite is not
// evidence that the suite tests anything; the repository's own history is full
// of guards that passed because they matched nothing. The only cheap proof is
// to break the thing on purpose and watch the guard notice. Doing that by hand
// costs two mistakes that are easy to make and hard to see afterwards:
//
//   1. EDITING IN PLACE. Every cross-package gate here derives its repo root
//      from `import.meta.url`, so running a mutated test from a different cwd
//      changes nothing about what it reads — the mutation silently does not
//      apply and the run is scored anyway. Each mutation therefore gets its own
//      disposable COPY of the tree, and the copy is built from HEAD *plus the
//      working tree*, because the files under test are usually uncommitted.
//
//   2. SCORING AN EDIT THAT NEVER LANDED. An anchor that has drifted matches
//      zero times; `sed` reports success, the test still passes, and the
//      mutation is recorded as "survived" — the exact opposite of the truth.
//      `applyEdit` refuses an anchor whose occurrence count is not the declared
//      one, and refuses an edit that changes nothing, as a HARNESS ERROR that
//      is never scored as a verdict.
//
// The copy is written through a SEPARATE `GIT_INDEX_FILE`, so the repository's
// real index and working tree are never touched, and it honours `.gitignore` —
// local runtime state under `.agentic-plugins/state/` does not travel into a
// mutation run.
//
// A third trap, found by this file's own gate rather than by reasoning: a
// nested `node --test` inherits `NODE_TEST_CONTEXT` and silently stops
// reporting failure through its exit status. See `childEnv` below — without it
// every nested run reads as a pass, so every mutation reads as SURVIVED.
//
// Usage:
//   node scripts/mutation-harness.mjs <spec.mjs> [--only id,id] [--repo-root d]
//                                     [--work-dir d] [--keep]
//
// A spec module exports:
//   TESTS      string[]   test files (repo-relative) run when a mutation names none
//   MUTATIONS  object[]   { id, why, prepare?, file?, from?, to?, count?,
//                           tests?, expect? }
//
// `prepare(copy, tools)` mutates the copy freely; `file`/`from`/`to` is the
// common single-anchor case. `expect` defaults to `'KILLED'` — a mutation with
// no stated expectation is a defect injection, and a fixture that must keep
// PASSING has to say `expect: 'SURVIVED'` out loud. Exit status is 0 only when
// every mutation matched its expectation.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export class MutationHarnessError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MutationHarnessError';
  }
}

/**
 * Extract HEAD + the current working tree of `repoRoot` into `dest`.
 *
 * Uses a throwaway index file, so the repository's real index is untouched and
 * nothing is staged as a side effect. The result is a plain directory, NOT a
 * git checkout — deliberately, so a mutation cannot be undone by `git checkout`
 * and cannot leak back.
 *
 * @returns {string} The sha of the throwaway tree object that was extracted.
 */
export function makeDisposableCopy(repoRoot, dest) {
  const scratch = mkdtempSync(join(tmpdir(), 'mutation-copy-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(scratch, 'index') };
  const git = (args, opts = {}) =>
    execFileSync('git', ['-C', repoRoot, ...args], { env, encoding: 'utf8', ...opts });
  try {
    git(['read-tree', 'HEAD']);
    git(['add', '-A']);
    const tree = git(['write-tree']).trim();
    const tarPath = join(scratch, 'tree.tar');
    git(['archive', '--format=tar', '-o', tarPath, tree]);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    execFileSync('tar', ['-xf', tarPath, '-C', dest], { encoding: 'utf8' });
    return tree;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Replace every occurrence of `from` with `to` in `<copy>/<file>`, refusing the
 * two failures that would otherwise be scored as a verdict.
 *
 * @returns {number} Occurrences replaced (always equal to `count`).
 */
export function applyEdit(copy, { file, from, to, count = 1 }) {
  const path = join(copy, file);
  let before;
  try {
    before = readFileSync(path, 'utf8');
  } catch (err) {
    throw new MutationHarnessError(`cannot read ${file} in the copy: ${err.message}`);
  }
  const found = before.split(from).length - 1;
  if (found !== count) {
    throw new MutationHarnessError(
      `anchor occurs ${found}x in ${file}, expected ${count} — the anchor drifted, `
      + `so the mutation would not have applied: ${JSON.stringify(String(from).slice(0, 80))}`,
    );
  }
  const after = before.split(from).join(to);
  if (after === before) {
    throw new MutationHarnessError(
      `the edit to ${file} changes nothing — a mutation that mutates nothing must not be scored`,
    );
  }
  writeFileSync(path, after, 'utf8');
  return found;
}

/** Read a JSON file from the copy. */
export function readJson(copy, file) {
  return JSON.parse(readFileSync(join(copy, file), 'utf8'));
}

/** Write a JSON file into the copy, trailing newline included. */
export function writeJson(copy, file, value) {
  writeFileSync(join(copy, file), `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

/**
 * Overwrite a file in the copy with its contents at a git ref. This is how a
 * spec compares today's guard against a historical one; pin the ref by FULL
 * sha, since a short sha cannot be widened and a branch name moves.
 */
export function fileAt(repoRoot, copy, ref, file) {
  let content;
  try {
    content = execFileSync('git', ['-C', repoRoot, 'show', `${ref}:${file}`], { encoding: 'utf8' });
  } catch (err) {
    throw new MutationHarnessError(
      `cannot read ${file} at ${ref}: ${err.message.trim()} — a shallow clone or a rewritten `
      + 'history cannot reproduce a historical-baseline control; fetch the full history or drop it',
    );
  }
  writeFileSync(join(copy, file), content, 'utf8');
  return content;
}

/**
 * Environment for a nested test run, with the test-runner's own variables
 * removed.
 *
 * `node --test` sets `NODE_TEST_CONTEXT=child-v8` in every file it runs, and a
 * plain `spawnSync` inherits it. A nested `node --test` that sees it starts in
 * CHILD mode: it reports through the parent's protocol instead of acting as a
 * runner, and its exit status stops reflecting whether the tests passed. The
 * harness then reads every nested run as a pass — fabricating `SURVIVED` for
 * every mutation, which is the one verdict that must never be fabricated.
 *
 * Measured, not assumed: before this scrub, the harness's own end-to-end gate
 * scored a mutation that broke the only assertion in its fixture as SURVIVED.
 */
export function childEnv(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('NODE_TEST_')) continue;
    out[key] = value;
  }
  return out;
}

function runTests(copy, tests) {
  const res = spawnSync(
    process.execPath,
    ['--test', '--test-concurrency=1', '--test-reporter=tap', ...tests],
    { cwd: copy, encoding: 'utf8', timeout: 900000, env: childEnv() },
  );
  if (res.error) throw new MutationHarnessError(`test run failed to start: ${res.error.message}`);
  if (res.status === null) {
    throw new MutationHarnessError(`test run did not exit (signal ${res.signal}) — treat as no verdict`);
  }
  return {
    status: res.status,
    failing: [...(res.stdout || '').matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1].trim()),
    stdout: res.stdout || '',
  };
}

/**
 * Run one spec. Returns `{ results, unexpected, control }`.
 *
 * The unmutated copy is run FIRST. If it is not green, every verdict below is
 * noise and the run aborts rather than reporting kills it did not earn.
 */
export async function runSpec(specPath, options = {}) {
  const {
    repoRoot = process.cwd(),
    workDir = mkdtempSync(join(tmpdir(), 'mutation-run-')),
    only = [],
    log = console.log,
  } = options;

  const absSpec = isAbsolute(specPath) ? specPath : resolve(repoRoot, specPath);
  const spec = await import(pathToFileURL(absSpec).href);
  const mutations = (spec.MUTATIONS ?? []).filter((m) => only.length === 0 || only.includes(m.id));
  if (mutations.length === 0) throw new MutationHarnessError(`${specPath} selected no mutations`);

  const tools = {
    applyEdit,
    readJson,
    writeJson,
    fileAt: (copy, ref, file) => fileAt(repoRoot, copy, ref, file),
  };

  mkdirSync(workDir, { recursive: true });
  const controlDir = join(workDir, 'control');
  makeDisposableCopy(repoRoot, controlDir);
  const control = runTests(controlDir, spec.TESTS ?? []);
  log(`CONTROL   exit=${control.status}  failing=${control.failing.length}`);
  if (control.status !== 0) {
    log(control.stdout.slice(-4000));
    throw new MutationHarnessError(
      'the UNMUTATED copy is not green — every verdict below would be unearned',
    );
  }

  const results = [];
  for (const mutation of mutations) {
    const dir = join(workDir, mutation.id);
    makeDisposableCopy(repoRoot, dir);
    const expect = mutation.expect ?? 'KILLED';
    try {
      if (mutation.prepare) mutation.prepare(dir, tools);
      if (mutation.from !== undefined) applyEdit(dir, mutation);
    } catch (err) {
      if (!(err instanceof MutationHarnessError)) throw err;
      results.push({ id: mutation.id, verdict: 'HARNESS-ERROR', expect, agrees: false, detail: err.message });
      log(`${mutation.id.padEnd(6)} HARNESS-ERROR  ${err.message}`);
      continue;
    }
    const out = runTests(dir, mutation.tests ?? spec.TESTS ?? []);
    const verdict = out.status === 0 ? 'SURVIVED' : 'KILLED';
    const agrees = verdict === expect;
    results.push({ id: mutation.id, verdict, expect, agrees, failing: out.failing });
    log(
      `${mutation.id.padEnd(6)} ${verdict.padEnd(9)} `
      + `${(agrees ? 'as-expected' : `UNEXPECTED (wanted ${expect})`).padEnd(26)} ${mutation.why}`,
    );
    log(`       └─ ${out.failing.slice(0, 3).join(' | ') || '(no named failure)'}`);
  }

  const unexpected = results.filter((r) => !r.agrees);
  log(`\nas-expected ${results.length - unexpected.length} / unexpected ${unexpected.length}`);
  return { results, unexpected, control, workDir };
}

function parseArgs(argv) {
  const opts = { only: [], keep: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--only') opts.only = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (arg === '--repo-root') opts.repoRoot = argv[++i];
    else if (arg === '--work-dir') opts.workDir = argv[++i];
    else if (arg === '--keep') opts.keep = true;
    else rest.push(arg);
  }
  opts.spec = rest[0];
  return opts;
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (!opts.spec) {
    console.error('Usage: node scripts/mutation-harness.mjs <spec.mjs> [--only id,id] [--repo-root d] [--work-dir d] [--keep]');
    return 2;
  }
  const workDir = opts.workDir ?? mkdtempSync(join(tmpdir(), 'mutation-run-'));
  try {
    const { unexpected } = await runSpec(opts.spec, {
      repoRoot: opts.repoRoot ?? process.cwd(),
      workDir,
      only: opts.only,
    });
    if (opts.keep) console.log(`\ncopies kept under ${workDir}`);
    return unexpected.length === 0 ? 0 : 1;
  } catch (err) {
    if (!(err instanceof MutationHarnessError)) throw err;
    console.error(`mutation-harness: ${err.message}`);
    return 1;
  } finally {
    if (!opts.keep && !opts.workDir) rmSync(workDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  (async () => { process.exitCode = await main(process.argv.slice(2)); })();
}

export { main, parseArgs };
