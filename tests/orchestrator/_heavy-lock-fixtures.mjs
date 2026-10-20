// Shared fixtures for the heavy-work lock's tests (ADR-0068 Decision 6):
// throwaway repositories, processes spawned with a deadline, readiness barriers
// (files a process writes when it reaches a point, files a test writes to let
// it go on) instead of timing, and a survivor tracker that kills every process
// group a test started or the lock registered, whatever the test's outcome.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..');
export const LOCK_LIB = join(REPO_ROOT, 'plugins', 'orchestrator', 'scripts', 'lib', 'heavy-lock.mjs');
export const CLI = join(REPO_ROOT, 'plugins', 'orchestrator', 'adapters', 'claude', 'autopilot', 'cli.mjs');
export const LAUNCHER = join(REPO_ROOT, 'plugins', 'orchestrator', 'adapters', 'claude', 'autopilot', 'launcher.template.mjs');
export const HARNESS = join(REPO_ROOT, 'scripts', 'mutation-harness.mjs');
export const OLD_HARNESS = join(REPO_ROOT, 'tests', 'fixtures', 'heavy-lock', 'harness-a739c10d', 'mutation-harness.mjs');

// A regression here would hang, not fail: each test carries a bound.
export const BOUNDED = { timeout: 90_000 };

export const sleep = (ms) => new Promise((wake) => { setTimeout(wake, ms); });

/** Whether `condition` holds within `ms`, polled every 20 ms. */
export async function until(condition, ms = 10_000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(20)) {
    if (condition()) return true;
  }
  return condition();
}

// Running, and not a zombie (an orphan's new parent may be slow to reap it).
export function running(pid) {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code === 'ESRCH') return false;
  }
  const ps = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  if (ps.error) return true;
  const stat = (ps.stdout ?? '').trim();
  return stat !== '' && !stat.startsWith('Z');
}

export function groupAlive(pgid) {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export const gone = (pid, ms) => until(() => !running(pid), ms);

/** A process that exited: its pid names no running process. */
export const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test User', GIT_AUTHOR_EMAIL: 'test@test.local',
  GIT_COMMITTER_NAME: 'Test User', GIT_COMMITTER_EMAIL: 'test@test.local',
};

export function write(root, rel, content) {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  return path;
}

export function git(root, ...args) {
  return execFileSync('git', ['-C', root, ...args], { env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A throwaway repository with one commit; `files` are committed. */
export function makeRepo(files = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'heavy-lock-')));
  execFileSync('git', ['init', '-q', '-b', 'main', root], { env: GIT_ENV, stdio: 'ignore' });
  git(root, 'config', 'commit.gpgsign', 'false');
  write(root, 'README.md', 'fixture\n');
  for (const [rel, content] of Object.entries(files)) write(root, rel, content);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'fixture', '--no-gpg-sign');
  return root;
}

/** A second worktree of `root`, removed with it. */
export function addLane(root, name = 'lane') {
  const lane = `${root}-${name}`;
  git(root, 'worktree', 'add', '-q', '-b', name, lane);
  return lane;
}

export const lockOf = (root) => join(git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'mutation-harness.lock');

/** The pgids every registered entry under the lock `path` names. */
export function registeredGroups(path) {
  const groups = `${path}.groups`;
  const out = [];
  if (!existsSync(groups)) return out;
  for (const dir of readdirSync(groups)) {
    let names = [];
    try { names = readdirSync(join(groups, dir)); } catch { continue; }
    for (const name of names.filter((n) => n.endsWith('.json'))) {
      try { out.push(JSON.parse(readFileSync(join(groups, dir, name), 'utf8')).pgid); } catch { /* gone */ }
    }
  }
  return out;
}

/** The environment of a process under test: no session, a fast poll. */
export function testEnv(extra = {}) {
  const env = { ...process.env, AGENTIC_HEAVY_LOCK_POLL_MS: '20' };
  for (const key of Object.keys(env)) {
    if (key.startsWith('NODE_TEST_') || key === 'AGENTIC_HEAVY_LOCK_PROOF' || key === 'AGENTIC_HEAVY_LOCK_VIA') delete env[key];
  }
  delete env.MUTATION_HARNESS_TIMEOUT;
  return { ...env, ...extra };
}

/**
 * The survivor tracker: every process and group a test starts, and every group
 * the locks it watches registered, is killed in `cleanUp`, whatever the test's
 * outcome. Its kills are independent of the behaviour under test.
 */
export function tracker() {
  const pids = new Set();
  const groups = new Set();
  const locks = new Set();
  const dirs = new Set();
  return {
    pid(pid) { if (Number.isInteger(pid)) pids.add(pid); return pid; },
    group(pgid) { if (Number.isInteger(pgid)) groups.add(pgid); return pgid; },
    lock(path) { locks.add(path); return path; },
    dir(path) { dirs.add(path); return path; },
    scratch() { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'heavy-scratch-'))); dirs.add(dir); return dir; },
    pidFile(file) {
      if (!existsSync(file)) return [];
      const found = readFileSync(file, 'utf8').split('\n').filter(Boolean).map(Number);
      for (const pid of found) pids.add(pid);
      return found;
    },
    cleanUp() {
      for (const path of locks) for (const pgid of registeredGroups(path)) groups.add(pgid);
      for (const pgid of groups) try { process.kill(-pgid, 'SIGKILL'); } catch { /* gone */ }
      for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
      for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Spawn `node <args>`, killed at its deadline. Resolves `exited` with
 * `{ code, signal, out }` (stdout and stderr, interleaved).
 */
export function spawnNode(args, { env = testEnv(), cwd, deadlineMs = 60_000, track } = {}) {
  const child = spawn(process.execPath, args, { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  track?.pid(child.pid);
  let out = '';
  child.stdout.on('data', (c) => { out += c; });
  child.stderr.on('data', (c) => { out += c; });
  const deadline = setTimeout(() => child.kill('SIGKILL'), deadlineMs);
  const exited = new Promise((done) => child.on('close', (code, signal) => {
    clearTimeout(deadline);
    done({ code, signal, out });
  }));
  return { child, exited, output: () => out };
}

/** `agentic-autopilot heavy [options] -- <command...>` through cli.mjs. */
export const heavy = (words, opts) => spawnNode([CLI, 'heavy', ...words], opts);

/**
 * A node one-liner for a wrapped command: it notes `name start` in `log`,
 * writes `<dir>/<name>.ready`, waits until `<dir>/<name>.go` exists, notes
 * `name end`, and exits with `code`.
 */
export function barrierCommand(dir, name, log, code = 0) {
  const script = [
    "const fs = require('node:fs');",
    `fs.appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(`${name} start\n`)});`,
    `fs.writeFileSync(${JSON.stringify(join(dir, `${name}.ready`))}, String(process.pid));`,
    `const t = setInterval(() => { if (fs.existsSync(${JSON.stringify(join(dir, `${name}.go`))})) {`,
    `  clearInterval(t); fs.appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(`${name} end\n`)}); process.exit(${code}); } }, 10);`,
  ].join('\n');
  return [process.execPath, '-e', script];
}

export const ready = (dir, name) => existsSync(join(dir, `${name}.ready`));
export const letGo = (dir, name) => writeFileSync(join(dir, `${name}.go`), '');
export const lines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
