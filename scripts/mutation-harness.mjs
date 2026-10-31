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
//   node scripts/mutation-harness.mjs --static [spec.mjs ...] [--only id,id]
//                                     [--repo-root d] [--work-dir d] [--keep]
//
// `--static` (`npm run mutate:static`) runs no test: it applies every case's
// edit, each to the copy as it was, and reports each one a run would refuse as
// a harness error (an anchor that drifted, a test file that is gone). With no
// spec named it checks every spec in scripts/mutation-specs. See `checkSpecs`.
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
// for the first (C101). The lock is the repository's heavy-work lock (ADR-0068
// Decision 6), which `agentic-autopilot heavy -- <command>` takes too; a run
// started under that wrapper joins its lock instead of waiting on it. See
// `acquireRunLock` below.
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
import {
  chmodSync, copyFileSync, cpSync, existsSync, lstatSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync,
  readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { constants as osConstants, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  HeavyLockError, acquire, groupState, lockPath, processInfo, reapStale as reapStaleLock, registerGroup,
} from '../plugins/orchestrator/scripts/lib/heavy-lock.mjs';
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
//
// The supervisor starts idle and runs nothing until the harness writes `go` on
// its lifeline, which the harness does only once the group is registered in the
// lock's ownership (ADR-0068 Decision 6). A harness killed before that leaves an
// idle supervisor, which its lifeline's end stops: nothing ran unregistered.
const GROUPS = process.platform !== 'win32';
const KILL_GRACE_MS = 5000;
const REPORT = 'mutation-harness-run ';

export const SUPERVISOR = [
  "const { spawn } = require('node:child_process');",
  "const { writeSync } = require('node:fs');",
  `const report = (r) => writeSync(2, ${JSON.stringify(REPORT)} + JSON.stringify(r) + '\\n');`,
  'let run = null;',
  "const stop = () => { try { process.kill(0, 'SIGKILL'); } catch { if (run !== null) run.kill('SIGKILL'); process.exit(1); } };",
  "process.stdin.on('end', stop);",
  "process.stdin.on('error', stop);",
  "let line = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (chunk) => { if (run !== null) return; line += chunk; if (line.includes('\\n')) (line === 'go\\n' ? go : stop)(); });",
  'process.stdin.resume();',
  'function go() {',
  "run = spawn(process.execPath, process.argv.slice(1), { stdio: ['ignore', 'inherit', 'ignore'] });",
  "run.on('error', (err) => { report({ error: err.message }); process.exit(1); });",
  "run.on('exit', (code, signal) => { report({ code, signal }); signal ? process.kill(process.pid, signal) : process.exit(code); });",
  '}',
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

// The start of each test run's supervisor, by its pid, which leads the run's
// group: once the group has ended its id is free, and a kill by the id alone
// would reach a group that took it since (lib/heavy-lock.mjs groupState).
const STARTS = new Map();
const reused = (pid) => GROUPS && STARTS.has(pid) && groupState(pid, STARTS.get(pid)) === 'foreign';

function stopRun(pid, signal) {
  if (reused(pid)) return;
  try {
    process.kill(GROUPS ? -pid : pid, signal);
  } catch {
    /* gone already */
  }
}

// A run's group runs until the system says it is gone (lib/heavy-lock.mjs
// groupState): a group of zombies only runs until they are reaped.
function groupAlive(pid) {
  if (GROUPS) return groupState(pid, STARTS.get(pid) ?? null) === 'running';
  try {
    process.kill(pid, 0);
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
// The ownership of the lock the CLI holds or joined, where each test run's
// group is registered; null when no lock is held (a test calling runTests).
let OWNERSHIP = null;
// The groups of test runs that failed because they would not end: the CLI
// keeps the copies while one of them runs, since it may still write there.
const STUCK = new Set();

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
 *
 * With an `ownership` (the CLI's lock), the run's group is registered there
 * before the run starts, and stays there until the group is gone: the run
 * settles only once nothing of its group is left, or, past KILL_GRACE_MS of
 * SIGKILLs, fails with the group kept in the ownership, so the lock outlives
 * it. A registration the ownership refuses (it was closed) starts nothing.
 * `beforeGo` (called between the registration and the go line) is for tests.
 */
export function runTests(copy, tests, { timeoutSeconds = DEFAULT_TIMEOUT_SECONDS, ownership = OWNERSHIP, beforeGo = () => {} } = {}) {
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
    let entry = null;
    let refused = null;
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
    child.on('close', () => { groupEnded(child.pid).then((ended) => settle(() => {
      if (!ended) {
        STUCK.add(child.pid);
        fail(new MutationHarnessError(
          `the process group ${child.pid} of a test run still runs ${KILL_GRACE_MS / 1000} s after its runner ended; `
          + 'it stays in the lock\'s ownership — treat as no verdict',
        ));
        return;
      }
      try {
        harnessError(() => entry?.unregister());
      } catch (err) {
        fail(err);
        return;
      }
      if (refused !== null) {
        fail(refused instanceof MutationHarnessError ? refused : new MutationHarnessError(`test run not started: ${refused.message}`));
        return;
      }
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
    })); });
    // Registered, then started: no group of the lock's ownership runs
    // unregistered (the go line).
    if (child.pid !== undefined) {
      const leaderStarted = processInfo(child.pid)?.started ?? null;
      STARTS.set(child.pid, leaderStarted);
      try {
        if (ownership) entry = harnessError(() => registerGroup(ownership, child.pid, { leaderStarted }));
        beforeGo(child);
        child.stdin.write('go\n');
      } catch (err) {
        refused = err;
        stopRun(child.pid, 'SIGKILL');
      }
    }
  });
}

// Whether the group of a run whose supervisor has ended is gone, SIGKILL sent
// to it until it is, for up to KILL_GRACE_MS.
async function groupEnded(pid) {
  for (const end = Date.now() + KILL_GRACE_MS; groupAlive(pid);) {
    if (Date.now() >= end) return false;
    stopRun(pid, 'SIGKILL');
    await new Promise((wake) => setTimeout(wake, 20));
  }
  return true;
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

// The tools a spec's `prepare` is handed.
function specTools(repoRoot) {
  return {
    applyEdit,
    readJson,
    writeJson,
    fileAt: (copy, ref, file) => fileAt(repoRoot, copy, ref, file),
  };
}

// Every test file the selected cases are scored against, which the control
// runs; a spec that names none is refused. A case that names its own `tests`
// is scored against those alone, so the spec default joins the control only
// for a selected case that names none: `--only` one case of a spec whose
// default is slow runs that case's files, not the whole default. A selected
// case scored against no file is refused too, whatever the others name: `node
// --test` with no file discovers the whole suite, a set the control never
// ran, and any failure in it would score the case KILLED.
function controlTestsOf(specPath, spec, mutations) {
  const tests = [...new Set(mutations.flatMap((m) => m.tests ?? spec.TESTS ?? []))];
  if (tests.length === 0) {
    throw new MutationHarnessError(`${specPath} names no test files — there is nothing to score against`);
  }
  const bare = mutations.filter((m) => (m.tests ?? spec.TESTS ?? []).length === 0).map((m) => m.id);
  if (bare.length > 0) {
    throw new MutationHarnessError(
      `${specPath} scores ${bare.join(', ')} against no test file — node --test would run the whole suite, which the control never ran`,
    );
  }
  return tests;
}

// The checks a case must pass before its tests run, then its edit, in `dir`:
// a refusal is a harness error, never a verdict. `runSpec` and `checkSpecs`
// share it, so the static check refuses every case a run would refuse; it is
// stricter in one way, failing closed: it also checks a spec's TESTS, which a
// run whose cases each name their own tests never uses. Returns the case's
// killers.
function applyMutation(dir, mutation, tools) {
  const expect = mutation.expect ?? 'KILLED';
  const killers = [mutation.killed_by ?? []].flat();
  if (killers.some((re) => !(re instanceof RegExp))) throw new MutationHarnessError('killed_by takes a RegExp or a list of them');
  if (killers.some((re) => re.global || re.sticky)) throw new MutationHarnessError('killed_by patterns carry no g or y flag (their lastIndex would carry over)');
  if (killers.length > 0 && expect !== 'KILLED') throw new MutationHarnessError('killed_by names who catches a defect; a survivor has none');
  if (mutation.prepare) mutation.prepare(dir, tools);
  if (mutation.from !== undefined) applyEdit(dir, mutation);
  return killers;
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

  const tools = specTools(repoRoot);

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
  const controlTests = controlTestsOf(specPath, spec, mutations);
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
    let killers;
    try {
      killers = applyMutation(dir, mutation, tools);
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
// The static check (`--static`): does every case still apply? Anchor drift
// recurred four times (C85, C97, C113, C129) because a spec runs only when
// someone runs it, and a full run of every spec takes hours. This applies each
// case's edit as `runSpec` does and runs no test. It takes no run lock: it
// starts no test run, and only reads the repository.
//
// A fresh copy per case costs about 0.2 s, some nine minutes for the
// repository's specs. So one copy serves every case: after each, every path
// that differs from a pristine copy is put back from it, and every path the
// case added is removed. A path differs when its lstat does — mode, size,
// inode, modification or change time. The change time alone does not tell a
// same-size rewrite on a filesystem with coarse times (one second on HFS+,
// a jiffy on Linux before 6.13): a case that rewrites a file in the tick its
// restore did keeps every field. So every file of the work copy carries one
// fixed modification time, set when it is copied: a write sets it to the
// present, which no clock tick reaches. A case that sets the time back itself
// is not seen on such a filesystem; no spec does. A directory is judged by its
// mode and its entries, the copy's own root among them, and a root that is no
// longer a directory (a link to another, say) is not followed. What the
// restore cannot put back (the copy itself removed or replaced), a new work
// copy replaces.

const SPEC_DIR = 'scripts/mutation-specs';

/** The repository's specs, repo-relative and sorted. */
export function listSpecs(repoRoot) {
  let files;
  try {
    files = readdirSync(join(repoRoot, SPEC_DIR));
  } catch (err) {
    throw new MutationHarnessError(`cannot list the specs in ${SPEC_DIR}: ${err.message}`);
  }
  const specs = files.filter((f) => f.endsWith('.mjs')).sort().map((f) => `${SPEC_DIR}/${f}`);
  if (specs.length === 0) throw new MutationHarnessError(`${SPEC_DIR} holds no spec`);
  return specs;
}

// A thrown value as text: a spec may throw anything.
function thrown(err) {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  try {
    return String(err);
  } catch {
    return typeof err;
  }
}

// The modification time every file of the work copy carries.
const SETTLED = new Date('2000-01-01T00:00:00Z');

function pathState(abs, lstat) {
  const st = lstat(abs);
  return `${st.mode}:${st.size}:${st.ino}:${st.mtimeNs}:${st.ctimeNs}`;
}

// Give every file under `root` the fixed modification time.
function settleTimes(root, rel = '') {
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) settleTimes(root, path);
    else lutimesSync(join(root, path), SETTLED, SETTLED);
  }
}

// A directory's state. One a case left closed is opened to be read: its mode
// then differs from the one recorded, and the restore puts that back.
function dirState(abs) {
  const { mode } = lstatSync(abs);
  if ((mode & 0o700) !== 0o700) chmodSync(abs, (mode & 0o7777) | 0o700);
  return `dir:${mode}`;
}

// Every path under `root`, each to its state, the root itself as ''. A root
// that is no longer a directory is refused before anything is read through it.
function pathStates(root, lstat, rel = '', out = new Map()) {
  if (rel === '') {
    if (!lstatSync(root).isDirectory()) throw new MutationHarnessError(`the work copy ${root} is no longer a directory`);
    out.set('', dirState(root));
  }
  for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
    const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
    const abs = join(root, path);
    if (entry.isDirectory()) {
      out.set(path, dirState(abs));
      pathStates(root, lstat, path, out);
    } else {
      out.set(path, pathState(abs, lstat));
    }
  }
  return out;
}

// Remove what is at `abs`, if anything. A link is unlinked: rmSync leaves a
// link that points nowhere in place, and reports nothing, on the node 24
// releases before 24.13.1, which `engines` admits (measured on 24.11.1).
function removePath(abs) {
  let st;
  try {
    st = lstatSync(abs);
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return;
    throw err;
  }
  if (st.isDirectory()) rmSync(abs, { recursive: true, force: true });
  else unlinkSync(abs);
}

// Put `work` back as `pristine` is, given the states its paths had then (a
// parent before its entries); returns them as they are now.
function restoreCopy(work, pristine, states, lstat) {
  const now = pathStates(work, lstat);
  for (const path of now.keys()) {
    if (!states.has(path)) removePath(join(work, path));
  }
  for (const [path, state] of states) {
    const current = now.get(path);
    if (current === state) continue;
    const abs = join(work, path);
    if (state.startsWith('dir:')) {
      if (current !== undefined && !current.startsWith('dir:')) removePath(abs);
      mkdirSync(abs, { recursive: true });
      chmodSync(abs, Number(state.slice(4)) & 0o7777);
      continue;
    }
    removePath(abs);
    mkdirSync(dirname(abs), { recursive: true });
    const source = join(pristine, path);
    if (lstatSync(source).isSymbolicLink()) symlinkSync(readlinkSync(source), abs);
    else copyFileSync(source, abs);
    lutimesSync(abs, SETTLED, SETTLED);
    states.set(path, pathState(abs, lstat));
  }
  return states;
}

/**
 * Apply every case of each spec, each to the copy as it was, and run no test.
 * Resolves `{ specs, drift }`: per spec `{ spec, cases, drift: [{ id, detail }] }`,
 * or `{ spec, error }` when it cannot be checked at all (it does not load, it
 * names no test file, or its TESTS name a file the tree lacks). A case drifts when a run would score
 * it HARNESS-ERROR, when it names a test file the tree lacks (the control would
 * fail), or when its `prepare` throws (a run would stop there). `drift` counts
 * drifted cases and specs that could not be checked. `lstat` is the bigint
 * lstat the change key reads; a test passes a coarser one to stand for a
 * filesystem with coarse times, which it cannot make.
 */
export async function checkSpecs(specPaths, options = {}) {
  const {
    repoRoot = process.cwd(),
    workDir = mkdtempSync(join(tmpdir(), 'mutation-static-')),
    only = [],
    log = console.log,
    lstat = (abs) => lstatSync(abs, { bigint: true }),
  } = options;
  const started = Date.now();
  const tools = specTools(repoRoot);
  const pristine = join(workDir, 'pristine');
  const work = join(workDir, 'work');
  mkdirSync(workDir, { recursive: true });
  makeDisposableCopy(repoRoot, pristine);
  const freshWork = () => {
    removePath(work);
    cpSync(pristine, work, { recursive: true, verbatimSymlinks: true });
    settleTimes(work);
    return pathStates(work, lstat);
  };
  let states = freshWork();
  const lacking = (what, tests) => {
    const gone = tests.filter((t) => !existsSync(join(pristine, t)));
    if (gone.length > 0) throw new MutationHarnessError(`${what} names ${gone.join(', ')}, which the tree does not have`);
  };

  const specs = [];
  let cases = 0;
  let drift = 0;
  for (const specPath of specPaths) {
    let mutations;
    try {
      let spec;
      ({ spec, mutations } = await loadSpec(specPath, { repoRoot, only }));
      controlTestsOf(specPath, spec, mutations);
      lacking('TESTS', spec.TESTS ?? []);
    } catch (err) {
      const error = err instanceof MutationHarnessError ? err.message : thrown(err);
      specs.push({ spec: specPath, error });
      drift += 1;
      log(`${specPath}  ERROR  ${error}`);
      continue;
    }
    const result = { spec: specPath, cases: mutations.length, drift: [] };
    for (const mutation of mutations) {
      try {
        lacking('tests', mutation.tests ?? []);
        applyMutation(work, mutation, tools);
      } catch (err) {
        const detail = err instanceof MutationHarnessError ? err.message : `prepare threw ${thrown(err)}`;
        result.drift.push({ id: mutation.id, detail });
        log(`${specPath}  ${mutation.id}  DRIFT  ${detail}`);
      } finally {
        try {
          states = restoreCopy(work, pristine, states, lstat);
        } catch (err) {
          log(`${specPath}  ${mutation.id}  the copy could not be put back (${thrown(err)}); it is made again`);
          states = freshWork();
        }
      }
    }
    specs.push(result);
    cases += result.cases;
    drift += result.drift.length;
    log(`${specPath}  ${result.cases} cases  ${result.drift.length} drift`);
  }
  log(`\nstatic: ${specs.length} specs, ${cases} cases, ${drift} drift, ${Math.round((Date.now() - started) / 1000)} s`);
  return { specs, drift, workDir };
}

// ---------------------------------------------------------------------------
// One run at a time per repository (C101). Three runs at once, in separate
// worktrees, starved each other until none finished. The lock is a file in the
// git common dir, which every worktree of the repository shares, and a second
// run waits for it. The holder records its pid, host and start time: a run
// killed without releasing the lock (SIGKILL, a step cap) leaves a lock the
// next run finds stale, and the test run it left was stopped by its supervisor
// when the harness died (SUPERVISOR above). Each test run's process group is
// registered in the lock's ownership before the run starts (the go line), so a
// reader of this release judges the lock stale only once that group is gone
// too.

// The lock itself, its record, its reap guard and its ownership, is the shared
// heavy-work lock (ADR-0068 Decision 6), in
// plugins/orchestrator/scripts/lib/heavy-lock.mjs: this harness, the wrapper
// `agentic-autopilot heavy -- <command>` and the driver take the same file. The
// functions below keep this file's names and its errors: what the module
// throws is rethrown as a MutationHarnessError with the same message.

// Run `fn`, rethrowing the lock's own error as this harness's.
function harnessError(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof HeavyLockError) throw new MutationHarnessError(err.message);
    throw err;
  }
}

/** The run lock of the repository `repoRoot` belongs to. */
export function runLockPath(repoRoot) {
  return harnessError(() => lockPath(repoRoot));
}

/** Remove the stale lock `seen`, if it is still the lock (heavy-lock.mjs). */
export function reapStale(path, seen, self, log, options = {}) {
  return harnessError(() => reapStaleLock(path, seen, self, log, options));
}

/**
 * Take the repository's run lock, waiting while another live run holds it, or
 * join the heavy-work lock whose proof the environment carries (a harness that
 * `npm run mutate` started under the wrapper): a joined run waits for nothing
 * and releases nothing. Returns `{ path, joined, ownership, release() }`; each
 * test run registers its process group in `ownership` before it starts. A
 * release while a test run's group still runs keeps the lock, saying so: the
 * next run waits until the group ends.
 */
export async function acquireRunLock(repoRoot, { spec = '', log = console.log, pollMs = 2000, env = process.env } = {}) {
  let handle;
  try {
    handle = await acquire(repoRoot, { kind: 'harness', purpose: spec, spec, log, pollMs, env, prefix: 'mutation-harness' });
  } catch (err) {
    if (err instanceof HeavyLockError) throw new MutationHarnessError(err.message);
    throw err;
  }
  return {
    path: handle.path,
    joined: handle.joined,
    ownership: handle.ownership,
    release() {
      try {
        harnessError(() => handle.release());
      } catch (err) {
        if (!(err instanceof MutationHarnessError)) throw err;
        log(`mutation-harness: ${err.message} (the next run waits until it ends)`);
      }
    },
  };
}

function parseArgs(argv) {
  const opts = { only: [], keep: false, static: false };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--static') opts.static = true;
    else if (arg === '--only') opts.only = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (arg === '--repo-root') opts.repoRoot = argv[++i];
    else if (arg === '--work-dir') opts.workDir = argv[++i];
    else if (arg === '--keep') opts.keep = true;
    else if (arg === '--timeout') opts.timeout = argv[++i] ?? '';
    else rest.push(arg);
  }
  opts.spec = rest[0];
  opts.specs = rest;
  return opts;
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (!opts.spec && !opts.static) {
    console.error('Usage: node scripts/mutation-harness.mjs <spec.mjs> [--only id,id] [--repo-root d] [--work-dir d] [--keep] [--timeout s]');
    console.error('       node scripts/mutation-harness.mjs --static [spec.mjs ...] [--only id,id] [--repo-root d] [--work-dir d] [--keep]');
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
      const stuck = [...STUCK].filter(groupAlive);
      if (stuck.length > 0) {
        console.error(`mutation-harness: copies kept under ${workDir}: process group ${stuck.join(', ')} of a test run still runs there`);
      } else if (!opts.keep && !opts.workDir) rmSync(workDir, { recursive: true, force: true, maxRetries: 3 });
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
    if (opts.static) {
      const specs = opts.specs.length > 0 ? opts.specs : listSpecs(repoRoot);
      if (opts.only.length > 0 && specs.length !== 1) {
        throw new MutationHarnessError(`--only takes one spec: an id names a case of one spec, and ${specs.length} were named`);
      }
      const { drift } = await checkSpecs(specs, { repoRoot, workDir, only: opts.only });
      if (opts.keep) console.log(`\ncopies kept under ${workDir}`);
      return drift === 0 ? 0 : 1;
    }
    // Everything that can be refused is refused before the wait for the lock.
    const timeoutSeconds = resolveTimeoutSeconds(opts.timeout);
    await loadSpec(opts.spec, { repoRoot, only: opts.only });
    lock = await acquireRunLock(repoRoot, { spec: opts.spec });
    OWNERSHIP = lock.ownership;
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
