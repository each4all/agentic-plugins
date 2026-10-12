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
//                                     [--work-dir d] [--keep] [--timeout s]
//
// A spec module exports:
//   TESTS      string[]   test files (repo-relative) run when a mutation names none
//   MUTATIONS  object[]   { id, why, prepare?, file?, from?, to?, count?,
//                           tests?, expect?, killed_by? }
//
// Each id names one case, its copy and its verdict, so a spec that repeats one
// is refused, and so is an `--only` id the spec does not have (C102).
//
// Each test run may take `--timeout` seconds (or `MUTATION_HARNESS_TIMEOUT`;
// 900 by default). A run that takes longer is stopped and reported as TIMEOUT,
// which is no verdict: the defect was neither caught nor missed (C135).
//
// Runs of the CLI in worktrees of one repository take turns: the second waits
// for the first (C101). See `acquireRunLock` below.
//
// `prepare(copy, tools)` mutates the copy freely; `file`/`from`/`to` is the
// common single-anchor case. `expect` defaults to `'KILLED'` — a mutation with
// no stated expectation is a defect injection, and a fixture that must keep
// PASSING has to say `expect: 'SURVIVED'` out loud. Exit status is 0 only when
// every mutation matched its expectation.
//
// `killed_by` (a RegExp, or a list of them) names the tests that must catch the
// defect: each pattern must match the name of a failing test, nested ones
// included, or its path (`suite > test`, to tie a contract to a suite). A run that fails only elsewhere — a harness-level crash, a test
// the defect breaks by accident — is scored KILLED-ELSEWHERE, not KILLED: a
// nonzero exit alone does not show that the intended contract caught it.

import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, unlinkSync,
  writeFileSync,
} from 'node:fs';
import { constants as osConstants, hostname, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isSessionVariable } from './lib/session-env.mjs';

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
 *
 * The operator's agentic session is dropped too, as `npm test` drops it
 * (`scripts/lib/session-env.mjs`): inherited, it fails the control under an
 * autopilot worker, and the harness refuses to score anything.
 */
export function childEnv(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('NODE_TEST_') || isSessionVariable(key)) continue;
    out[key] = value;
  }
  return out;
}

// How long one test run may take (C135). A fixed 900 s used to stop the
// persona runbook suites, whose unmutated control alone took about 15 minutes,
// and `spawnSync` reported the stop as "test run failed to start".
export const DEFAULT_TIMEOUT_SECONDS = 900;
export const TIMEOUT_ENV = 'MUTATION_HARNESS_TIMEOUT';
// setTimeout fires at once for a delay above 2^31 - 1 ms.
const MAX_TIMEOUT_SECONDS = Math.floor((2 ** 31 - 1) / 1000);

/** A timeout in whole seconds, from 1 up; `source` names where it came from. */
export function parseTimeoutSeconds(value, source) {
  const text = String(value);
  if (!/^[1-9][0-9]*$/.test(text) || Number(text) > MAX_TIMEOUT_SECONDS) {
    throw new MutationHarnessError(
      `${source} takes a whole number of seconds from 1 to ${MAX_TIMEOUT_SECONDS}, got ${JSON.stringify(text)}`,
    );
  }
  return Number(text);
}

/** The `--timeout` value, else the environment's, else the default. */
export function resolveTimeoutSeconds(flag, env = process.env) {
  if (flag !== undefined) return parseTimeoutSeconds(flag, '--timeout');
  if (env[TIMEOUT_ENV] !== undefined) return parseTimeoutSeconds(env[TIMEOUT_ENV], TIMEOUT_ENV);
  return DEFAULT_TIMEOUT_SECONDS;
}

// A test run leads a process group of its own, so that a timeout, the end of
// the run and a signal to the harness stop everything it started, not only the
// runner: `node --test` runs each file in a child process, and a test may
// spawn more. The group's leader is SUPERVISOR, which runs `node --test` and
// holds a pipe from the harness as its stdin: when that pipe ends, the harness
// is gone (killed with SIGKILL, or a test process running a nested harness
// that was killed), and the supervisor kills its whole group. Without it a
// detached group would outlive the harness that could stop it.
//
// The supervisor reports how the runner ended on its stderr, which the runner
// does not share, as one REPORT line: `{ code, signal }`, or `{ error }` when
// the runner could not start. Only that report is a test result. Its own exit
// status is not: a runner that failed to start, or a supervisor that crashed,
// would otherwise be scored as a test that failed, and so as a kill.
const GROUPS = process.platform !== 'win32';
const KILL_GRACE_MS = 5000;
const REPORT = 'mutation-harness-run ';

export const SUPERVISOR = [
  "const { spawn } = require('node:child_process');",
  "const { writeSync } = require('node:fs');",
  `const report = (r) => writeSync(2, ${JSON.stringify(REPORT)} + JSON.stringify(r) + '\\n');`,
  "const run = spawn(process.execPath, process.argv.slice(1), { stdio: ['ignore', 'inherit', 'ignore'] });",
  "const stop = () => { try { process.kill(0, 'SIGKILL'); } catch { run.kill('SIGKILL'); process.exit(1); } };",
  "process.stdin.on('end', stop);",
  "process.stdin.on('error', stop);",
  'process.stdin.resume();',
  "run.on('error', (err) => { report({ error: err.message }); process.exit(1); });",
  "run.on('exit', (code, signal) => { report({ code, signal }); signal ? process.kill(process.pid, signal) : process.exit(code); });",
].join('\n');

// The supervisor's REPORT, or null when it made none.
function runReport(stderr) {
  const line = stderr.split('\n').filter((l) => l.startsWith(REPORT)).pop();
  if (line === undefined) return null;
  try {
    return JSON.parse(line.slice(REPORT.length));
  } catch {
    return null;
  }
}

function stopRun(pid, signal) {
  try {
    process.kill(GROUPS ? -pid : pid, signal);
  } catch {
    /* gone already */
  }
}

function groupAlive(pid) {
  try {
    process.kill(GROUPS ? -pid : pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// The supervisors of the test runs in progress, for `stopRuns`; the runs it
// stopped, which it waits for on every call until they are gone; and whether
// it was called: from then on no test run starts.
const LIVE = new Set();
const HALTED = new Set();
let stopping = false;

/**
 * Stop every test run in progress, start no more, and wait, up to `ms`, until
 * each run's supervisor has exited and nothing in its group is left; resolves
 * whether that happened in time. The CLI calls it on a signal before it removes
 * the copies and releases the lock: a run still writing into a copy, or still
 * running once another harness holds the lock, is what the lock exists to
 * prevent. A run that ends while this waits would otherwise let `runSpec` start
 * the next one.
 */
export async function stopRuns(ms = KILL_GRACE_MS) {
  stopping = true;
  for (const child of LIVE) HALTED.add(child);
  for (const child of HALTED) {
    stopRun(child.pid, 'SIGKILL');
    child.stdout.destroy();
    child.stderr.destroy();
  }
  const exited = (child) => child.exitCode !== null || child.signalCode !== null;
  for (const end = Date.now() + ms; Date.now() < end;) {
    if ([...HALTED].every((child) => exited(child) && !groupAlive(child.pid))) return true;
    await new Promise((wake) => setTimeout(wake, 20));
  }
  return false;
}

/**
 * Run `tests` in `copy`. Resolves `{ status, timedOut, failing, failingPaths,
 * stdout }`; a run stopped at the timeout resolves `timedOut: true` with no
 * status, which is no verdict. The timeout bounds the whole run, its output
 * included: a process that left the group still holding the output pipe does
 * not hold the harness past it.
 */
export function runTests(copy, tests, { timeoutSeconds = DEFAULT_TIMEOUT_SECONDS } = {}) {
  return new Promise((done, fail) => {
    if (stopping) {
      fail(new MutationHarnessError('the harness is stopping; no test run starts'));
      return;
    }
    const child = spawn(
      process.execPath,
      ['-e', SUPERVISOR, '--', '--test', '--test-concurrency=1', '--test-reporter=tap', ...tests],
      { cwd: copy, env: childEnv(), detached: GROUPS, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    LIVE.add(child);
    let stdout = '';
    let stderr = '';
    let exit = null;
    let timedOut = false;
    let settled = false;
    let grace;
    child.stdin.on('error', () => { /* the supervisor has exited */ });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => {
      timedOut = true;
      stopRun(child.pid, 'SIGTERM');
      grace = setTimeout(() => {
        stopRun(child.pid, 'SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
      }, KILL_GRACE_MS);
    }, timeoutSeconds * 1000);
    const settle = (result) => {
      if (settled) return;
      settled = true;
      LIVE.delete(child);
      clearTimeout(timer);
      clearTimeout(grace);
      child.stdin.destroy();
      result();
    };
    child.on('error', (err) => settle(() => fail(new MutationHarnessError(`test run failed to start: ${err.message}`))));
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      // What the run left behind ends with it, and its output pipe closes.
      stopRun(child.pid, 'SIGKILL');
    });
    child.on('close', () => settle(() => {
      if (timedOut) {
        done({ status: null, timedOut: true, failing: [], failingPaths: [], stdout });
        return;
      }
      const report = runReport(stderr);
      if (report === null) {
        fail(new MutationHarnessError(
          `test run ended without reporting how its runner exited (supervisor exit ${exit.code ?? exit.signal}) — treat as no verdict`,
        ));
        return;
      }
      if (report.error !== undefined) {
        fail(new MutationHarnessError(`test run failed to start: ${report.error}`));
        return;
      }
      if (!Number.isInteger(report.code)) {
        fail(new MutationHarnessError(`test run did not exit (signal ${report.signal}) — treat as no verdict`));
        return;
      }
      const failed = failingTests(stdout);
      done({
        status: report.code,
        timedOut: false,
        failing: failed.map((f) => f.name),
        failingPaths: failed.map((f) => f.path),
        stdout,
      });
    }));
  });
}

/**
 * The failing tests of a TAP stream, nested subtests included: each `{ name,
 * path }`, the path naming its ancestors (`suite > test`). Read as records, not
 * as lines: a test point counts only outside the YAML diagnostics that follow
 * one, where an error message may hold any text (a peer made an unrelated
 * failure's message read as a killer), and names are unescaped (`\\#`).
 */
export function failingTests(tap) {
  const unescape = (s) => s.replace(/\\([\\#])/g, '$1');
  const out = [];
  const stack = []; // open subtests: { indent, name }
  let yaml = null; // indent of an open diagnostics block
  for (const line of tap.split('\n')) {
    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    if (yaml !== null) {
      if (body === '...' && indent === yaml) yaml = null;
      continue;
    }
    if (body === '---') { yaml = indent; continue; }
    const sub = /^# Subtest: (.*)$/.exec(body);
    if (sub) {
      while (stack.length > 0 && stack[stack.length - 1].indent >= indent) stack.pop();
      stack.push({ indent, name: unescape(sub[1]) });
      continue;
    }
    const point = /^(not ok|ok) \d+ - (.*?)(?: # (?:SKIP|TODO)\b.*)?$/.exec(body);
    if (!point) continue;
    while (stack.length > 0 && stack[stack.length - 1].indent > indent) stack.pop();
    const name = unescape(point[2]);
    const ancestors = stack.filter((s) => s.indent < indent).map((s) => s.name);
    if (point[1] === 'not ok') out.push({ name, path: [...ancestors, name].join(' > ') });
    if (stack.length > 0 && stack[stack.length - 1].indent === indent) stack.pop();
  }
  return out;
}

/**
 * The mutations `only` selects (all of them when it is empty). An id names one
 * case, its copy and its verdict, so ids must be present and distinct (C102);
 * an `only` id the spec does not have is refused rather than dropped, even
 * when another requested id exists.
 */
export function selectMutations(mutations, only = [], specPath = 'the spec') {
  const ids = mutations.map((m) => m?.id);
  const missing = ids.filter((id) => typeof id !== 'string' || id === '').length;
  if (missing > 0) throw new MutationHarnessError(`${specPath} has ${missing} mutation(s) without an id`);
  const seen = new Set();
  const repeated = new Set(ids.filter((id) => seen.has(id) || !seen.add(id)));
  if (repeated.size > 0) {
    throw new MutationHarnessError(`${specPath} repeats mutation id(s) ${[...repeated].join(', ')}`);
  }
  const unknown = only.filter((id) => !seen.has(id));
  if (unknown.length > 0) {
    throw new MutationHarnessError(`--only names id(s) ${specPath} does not have: ${unknown.join(', ')}`);
  }
  return mutations.filter((m) => only.length === 0 || only.includes(m.id));
}

/** Import a spec and select its mutations. Returns `{ spec, mutations }`. */
export async function loadSpec(specPath, { repoRoot = process.cwd(), only = [] } = {}) {
  const absSpec = isAbsolute(specPath) ? specPath : resolve(repoRoot, specPath);
  const spec = await import(pathToFileURL(absSpec).href);
  const mutations = selectMutations(spec.MUTATIONS ?? [], only, specPath);
  if (mutations.length === 0) throw new MutationHarnessError(`${specPath} selected no mutations`);
  return { spec, mutations };
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
    timeoutSeconds = DEFAULT_TIMEOUT_SECONDS,
  } = options;

  const run = { timeoutSeconds: parseTimeoutSeconds(timeoutSeconds, 'timeoutSeconds') };
  const { spec, mutations } = await loadSpec(specPath, { repoRoot, only });
  const noVerdict = `passed ${run.timeoutSeconds} s and was stopped — no verdict; `
    + `give it longer with --timeout <seconds> or ${TIMEOUT_ENV}`;

  const tools = {
    applyEdit,
    readJson,
    writeJson,
    fileAt: (copy, ref, file) => fileAt(repoRoot, copy, ref, file),
  };

  mkdirSync(workDir, { recursive: true });
  const controlDir = join(workDir, 'control');
  makeDisposableCopy(repoRoot, controlDir);
  // The control must cover EVERY file any scored mutation will run, not just
  // the spec default. A mutation that names its own `tests` used to be scored
  // against a set the control never ran: peer-measured on this file, a designer
  // test that failed at startup still produced `CONTROL exit=0` and two KILLED
  // verdicts — a kill credited to a mutation that changed nothing about it.
  // Scoring a set the control has not proven green is exactly the fabricated
  // verdict this harness exists to prevent.
  const controlTests = [...new Set([
    ...(spec.TESTS ?? []),
    ...mutations.flatMap((m) => m.tests ?? []),
  ])];
  if (controlTests.length === 0) {
    throw new MutationHarnessError(`${specPath} names no test files — there is nothing to score against`);
  }
  const control = await runTests(controlDir, controlTests, run);
  if (control.timedOut) throw new MutationHarnessError(`the UNMUTATED copy's test run ${noVerdict}`);
  log(`CONTROL   exit=${control.status}  failing=${control.failing.length}  files=${controlTests.length}`);
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
    const killers = [mutation.killed_by ?? []].flat();
    try {
      if (killers.some((re) => !(re instanceof RegExp))) throw new MutationHarnessError('killed_by takes a RegExp or a list of them');
      if (killers.some((re) => re.global || re.sticky)) throw new MutationHarnessError('killed_by patterns carry no g or y flag (their lastIndex would carry over)');
      if (killers.length > 0 && expect !== 'KILLED') throw new MutationHarnessError('killed_by names who catches a defect; a survivor has none');
      if (mutation.prepare) mutation.prepare(dir, tools);
      if (mutation.from !== undefined) applyEdit(dir, mutation);
    } catch (err) {
      if (!(err instanceof MutationHarnessError)) throw err;
      results.push({ id: mutation.id, verdict: 'HARNESS-ERROR', expect, agrees: false, detail: err.message });
      log(`${mutation.id.padEnd(6)} HARNESS-ERROR  ${err.message}`);
      continue;
    }
    const out = await runTests(dir, mutation.tests ?? spec.TESTS ?? [], run);
    if (out.timedOut) {
      const detail = `the test run ${noVerdict}`;
      results.push({ id: mutation.id, verdict: 'TIMEOUT', expect, agrees: false, detail });
      log(`${mutation.id.padEnd(6)} TIMEOUT   ${detail}`);
      continue;
    }
    let verdict = out.status === 0 ? 'SURVIVED' : 'KILLED';
    // A pattern may name a test or its path (`suite > test`).
    const missed = verdict === 'KILLED'
      ? killers.filter((re) => !out.failing.some((name) => re.test(name)) && !out.failingPaths.some((path) => re.test(path)))
      : [];
    if (missed.length > 0) verdict = 'KILLED-ELSEWHERE';
    const agrees = verdict === expect;
    results.push({ id: mutation.id, verdict, expect, agrees, failing: out.failing, missed: missed.map(String) });
    log(
      `${mutation.id.padEnd(6)} ${verdict.padEnd(9)} `
      + `${(agrees ? 'as-expected' : `UNEXPECTED (wanted ${expect})`).padEnd(26)} ${mutation.why}`,
    );
    log(`       └─ ${out.failing.slice(0, 3).join(' | ') || '(no named failure)'}`);
    if (missed.length > 0) log(`       └─ no failing test matched ${missed.join(', ')}`);
  }

  const unexpected = results.filter((r) => !r.agrees);
  log(`\nas-expected ${results.length - unexpected.length} / unexpected ${unexpected.length}`);
  return { results, unexpected, control, workDir };
}

// ---------------------------------------------------------------------------
// One run at a time per repository (C101). Three runs at once, in separate
// worktrees, starved each other until none finished. The lock is a file in the
// git common dir, which every worktree of the repository shares, and a second
// run waits for it. The holder records its pid, host and start time: a run
// killed without releasing the lock (SIGKILL, a step cap) leaves a lock the
// next run finds stale, and the test run it left was stopped by its supervisor
// when the harness died (SUPERVISOR above).

const LOCK_NAME = 'mutation-harness.lock';
const WAIT_REPORT_MS = 5 * 60_000;

/** The run lock of the repository `repoRoot` belongs to. */
export function runLockPath(repoRoot) {
  let common;
  try {
    common = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    throw new MutationHarnessError(`cannot find the git common dir of ${repoRoot}: ${err.message.trim()}`);
  }
  return join(common, LOCK_NAME);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// What the system says of a running pid: `{ zombie, started }`, or null when it
// cannot say (no ps, or a sandbox that denies it). `started` names when the
// process started, and every reader must spell it alike, or a live holder reads
// as a reused pid and loses its lock. On Linux it is the start in clock ticks
// since boot, from /proc, which no clock change moves (ps derives its start time
// from the boot time, which moves when the clock is set). Elsewhere it is ps's
// start time in the C locale and UTC: ps prints local time, so two runs in
// different time zones would spell one start differently. Each spelling names
// its scheme (`boot:`, `utc:`), so that a reader compares only a start spelled
// as it spells one (see `holderRunning`).
function processInfo(pid) {
  if (process.platform === 'linux') {
    let stat;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch {
      return null;
    }
    // The fields after the command name, which is in parentheses and may hold
    // any byte: the state, then the start time 19 fields on.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[19] ? { zombie: fields[0] === 'Z', started: `boot:${fields[19]}` } : null;
  }
  let out;
  try {
    out = execFileSync('ps', ['-o', 'stat=,lstart=', '-p', String(pid)], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
    }).trim();
  } catch {
    return null;
  }
  const match = /^(\S+)\s+(.+)$/.exec(out);
  return match ? { zombie: match[1].startsWith('Z'), started: `utc:${match[2]}` } : null;
}

// Whether the process a record names is still the one running: alive, not a
// zombie, and started when the record says (a pid reused by another process
// started later). What cannot be checked counts as running; a holder on another
// host cannot be checked from here at all, and a start spelled in a scheme this
// reader does not use (a harness of another version wrote it) cannot be
// compared: unequal spellings of one start would read as a reused pid.
const startScheme = (started) => /^(boot|utc):/.exec(started)?.[1] ?? null;

function holderRunning(record) {
  if (record.host !== hostname()) return true;
  if (!processAlive(record.pid)) return false;
  const info = processInfo(record.pid);
  if (info === null) return true;
  if (info.zombie) return false;
  if (typeof record.started !== 'string' || startScheme(record.started) !== startScheme(info.started)) return true;
  return record.started === info.started;
}

// Write `record` whole, then link it to `target`: a reader never sees a part of
// it, and the link fails with EEXIST when `target` exists.
function placeExclusive(target, record) {
  const tmp = `${target}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record)}\n`, 'utf8');
  try {
    linkSync(tmp, target);
  } finally {
    rmSync(tmp, { force: true });
  }
}

// `{ raw, record }`, or null when there is no lock. A record that does not
// parse, or names no pid and host, is null: nothing but a whole record is ever
// linked into place, and one without a holder would be waited for for ever.
function readLock(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new MutationHarnessError(`cannot read the run lock ${path}: ${err.message}`);
  }
  let record = null;
  try {
    record = JSON.parse(raw);
  } catch {
    /* unreadable: stale */
  }
  const whole = Number.isInteger(record?.pid) && typeof record?.host === 'string';
  return { raw, record: whole ? record : null };
}

// The reap guard: a directory `<lock>.reap` holding one entry, named by its
// reaper's token and holding the reaper's record. A reaper places it whole, by
// renaming a directory it built aside onto the guard's name, which fails while
// another reaper's guard holds an entry (an empty guard is replaced). Returns
// whether this reaper now holds the guard.
function placeGuard(guard, self) {
  const tmp = `${guard}.${randomUUID()}.tmp`;
  try {
    mkdirSync(tmp);
    writeFileSync(join(tmp, self.token), `${JSON.stringify(self)}\n`, 'utf8');
    renameSync(tmp, guard);
    return true;
  } catch (err) {
    if (err.code === 'ENOTEMPTY' || err.code === 'EEXIST') return false;
    // A file there is the guard of a harness from before the guard was a
    // directory (never released). Its reaper cannot be judged by its entry, so
    // it is the operator's to remove.
    if (err.code === 'ENOTDIR') {
      throw new MutationHarnessError(
        `${guard} is a reap guard file left by an older harness; remove it once no mutation harness runs in this repository`,
      );
    }
    throw new MutationHarnessError(`cannot create ${guard}: ${err.message}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Remove the guard directory if it is empty; a reaper's guard never is.
function dropEmptyGuard(guard) {
  try {
    rmdirSync(guard);
  } catch (err) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(err.code)) {
      throw new MutationHarnessError(`cannot remove ${guard}: ${err.message}`);
    }
  }
}

// Remove the stale lock `seen`, if it is still the lock. One reaper at a time,
// under the reap guard: without it, a slow reaper could remove the lock a
// faster one's run has just taken. A guard is taken from its reaper only once
// that reaper has stopped running, never for its age, since a reaper paused
// for a while is still a reaper. And a waiter takes only the guard it judged:
// judging takes a while (ps), and the guard a live reaper placed meanwhile must
// stay, or two reapers each remove a lock, the second the one the first's run
// took. So a waiter never removes the guard by its name, whose holder can
// change while it judges. It captures the dead reaper's entry by renaming it
// away under the entry's own name, which no process but that reaper uses: the
// rename takes that entry or, when another waiter took it first, nothing,
// however late it comes, and a live reaper's entry, under another name, is
// never touched. An entry leaves the guard only by its own reaper or by such a
// capture. Returns whether this call removed the lock. `running` and `judged`
// (called after the last read of the guard, before its capture) are for tests.
export function reapStale(path, seen, self, log, { running = holderRunning, judged = () => {} } = {}) {
  const guard = `${path}.reap`;
  if (!placeGuard(guard, self)) {
    let names;
    try {
      names = readdirSync(guard);
    } catch (err) {
      if (err.code === 'ENOENT') return false;
      throw new MutationHarnessError(`cannot read ${guard}: ${err.message}`);
    }
    for (const name of names) {
      const reaper = readLock(join(guard, name));
      if (reaper === null) continue;
      if (reaper.record !== null && reaper.record.token === name && running(reaper.record)) continue;
      judged();
      const captured = `${guard}.${randomUUID()}.captured`;
      try {
        renameSync(join(guard, name), captured);
      } catch (err) {
        if (err.code === 'ENOENT') continue;
        throw new MutationHarnessError(`cannot capture ${join(guard, name)}: ${err.message}`);
      }
      rmSync(captured, { force: true });
      log(`mutation-harness: removed the guard of a reaper that is not running (${guard})`);
    }
    dropEmptyGuard(guard);
    return false;
  }
  try {
    const now = readLock(path);
    if (now === null || now.raw !== seen.raw) return false;
    unlinkSync(path);
    const holder = seen.record;
    log(`mutation-harness: removed a stale run lock (${holder ? `pid ${holder.pid}, ${holder.worktree}, which is not running` : 'unreadable'})`);
    return true;
  } finally {
    rmSync(join(guard, self.token), { force: true });
    dropEmptyGuard(guard);
  }
}

/**
 * Take the repository's run lock, waiting while another live run holds it.
 * Returns `{ path, release() }`.
 */
export async function acquireRunLock(repoRoot, { spec = '', log = console.log, pollMs = 2000 } = {}) {
  const path = runLockPath(repoRoot);
  const record = {
    pid: process.pid,
    host: hostname(),
    started: processInfo(process.pid)?.started ?? null,
    token: randomUUID(),
    started_at: new Date().toISOString(),
    worktree: resolve(repoRoot),
    spec,
  };
  const since = Date.now();
  let reported = null;
  let reportedAt = 0;
  for (;;) {
    try {
      placeExclusive(path, record);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw new MutationHarnessError(`cannot create the run lock ${path}: ${err.message}`);
    }
    const seen = readLock(path);
    if (seen === null) continue;
    if (seen.record === null || !holderRunning(seen.record)) {
      if (reapStale(path, seen, record, log)) continue;
    } else if (seen.record.token !== reported || Date.now() - reportedAt >= WAIT_REPORT_MS) {
      const h = seen.record;
      log(
        `mutation-harness: waiting for the run of ${h.spec || 'a spec'} in ${h.worktree} `
        + `(pid ${h.pid} on ${h.host}, since ${h.started_at}); its lock is ${path}`,
      );
      reported = h.token;
      reportedAt = Date.now();
    }
    await new Promise((wake) => setTimeout(wake, pollMs));
  }
  if (reported !== null) log(`mutation-harness: the run lock is ours after ${Math.round((Date.now() - since) / 1000)} s`);
  return {
    path,
    release() {
      if (readLock(path)?.record?.token === record.token) unlinkSync(path);
    },
  };
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
    else if (arg === '--timeout') opts.timeout = argv[++i] ?? '';
    else rest.push(arg);
  }
  opts.spec = rest[0];
  return opts;
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (!opts.spec) {
    console.error('Usage: node scripts/mutation-harness.mjs <spec.mjs> [--only id,id] [--repo-root d] [--work-dir d] [--keep] [--timeout s]');
    return 2;
  }
  const repoRoot = opts.repoRoot ?? process.cwd();
  const workDir = opts.workDir ?? mkdtempSync(join(tmpdir(), 'mutation-run-'));
  let lock = null;
  let signalled = false;
  // The copies go first and the lock last: while the lock is held, no other run
  // starts beside what is left of this one.
  const cleanUp = () => {
    try {
      if (!opts.keep && !opts.workDir) rmSync(workDir, { recursive: true, force: true, maxRetries: 3 });
    } finally {
      lock?.release();
      lock = null;
    }
  };
  // A signal stops the test runs, which a signal sent to the harness's group
  // does not reach, and only then removes the copies and releases the lock. A
  // run that will not end keeps them: the harness waits, saying so, until it
  // ends, or until a SIGKILL leaves the lock for the next run to judge stale.
  const onSignal = async (signal) => {
    if (signalled) return;
    signalled = true;
    try {
      while (!(await stopRuns())) {
        console.error(`mutation-harness: a test run has not ended after ${signal}; the lock is kept until it does (SIGKILL ${process.pid} to stop waiting)`);
      }
      cleanUp();
    } catch (err) {
      console.error(`mutation-harness: cleaning up after ${signal}: ${err.message}`);
    } finally {
      process.exit(128 + (osConstants.signals[signal] ?? 1));
    }
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  for (const signal of signals) process.on(signal, onSignal);
  try {
    // Everything that can be refused is refused before the wait for the lock.
    const timeoutSeconds = resolveTimeoutSeconds(opts.timeout);
    await loadSpec(opts.spec, { repoRoot, only: opts.only });
    lock = await acquireRunLock(repoRoot, { spec: opts.spec });
    const { unexpected } = await runSpec(opts.spec, {
      repoRoot,
      workDir,
      only: opts.only,
      timeoutSeconds,
    });
    if (opts.keep) console.log(`\ncopies kept under ${workDir}`);
    return unexpected.length === 0 ? 0 : 1;
  } catch (err) {
    // A run the signal stopped fails with it; the signal's cleanup reports.
    if (signalled) return 1;
    if (!(err instanceof MutationHarnessError)) throw err;
    console.error(`mutation-harness: ${err.message}`);
    return 1;
  } finally {
    // After a signal, its handler cleans up, in order, and exits.
    if (!signalled) {
      for (const signal of signals) process.off(signal, onSignal);
      cleanUp();
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  (async () => { process.exitCode = await main(process.argv.slice(2)); })();
}

export { main, parseArgs };
