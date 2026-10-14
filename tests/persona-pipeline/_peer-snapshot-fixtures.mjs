// Shared fixtures of the peer snapshot suites (C96): real git repositories,
// fake companions whose `vandal` mode does what a peer was measured doing
// (`checkout -- .` and `clean -fd` in the directory it was given), and the
// probes the cases judge them by. tests/persona-pipeline/test-peer-snapshot.mjs
// runs them for every persona, tests/orchestrator/test-peer-snapshot.mjs for
// the orchestrator's copies.

import { ok } from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const GIT_ENV = {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
};
export const cleanEnv = (extra = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && !k.startsWith('GIT_'))),
  ...GIT_ENV,
  ...extra,
});
export const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], {
  encoding: 'utf8', env: cleanEnv({ GIT_OPTIONAL_LOCKS: '0' }), stdio: ['ignore', 'pipe', 'pipe'],
});
export const gitTry = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: cleanEnv() });

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function waitFor(predicate, { timeoutMs = 20000, message = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await predicate();
    if (v) return v;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${message}`);
}
export const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
/** `promise`, or a failure naming `what` after `ms`: a defect is a verdict, never a hang. */
export async function within(promise, what, ms = 30000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms: ${what}`)), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

/** Kill whatever a test started that a defect could leave running. */
export function killGroup(pid) {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* gone */
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* gone */
  }
}
export const groupAlive = (pgid) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/** A private temporary area, and TMPDIR pointed at it while `fn` runs, so a
 * snapshot directory left behind is counted, not lost among other runs'. */
export async function withTmp(fn) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'peer-snapshot-test-')));
  const snaps = join(dir, 'tmp');
  mkdirSync(snaps);
  const saved = process.env.TMPDIR;
  process.env.TMPDIR = snaps;
  try {
    await fn(dir, snaps);
  } finally {
    if (saved === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved;
    for (const w of snapshotWorktrees(join(dir, 'repo'))) gitTry(join(dir, 'repo'), 'worktree', 'remove', '-f', '-f', w.worktree);
    rmSync(dir, { recursive: true, force: true });
  }
}

export const leftovers = (snaps) => readdirSync(snaps).filter((n) => n.includes('-peer-snapshot-'));

export function snapshotWorktrees(top) {
  if (!existsSync(top)) return [];
  const r = gitTry(top, 'worktree', 'list', '--porcelain', '-z');
  if (r.status !== 0) return [];
  const out = [];
  let cur = null;
  for (const f of r.stdout.split('\0')) {
    if (f.startsWith('worktree ')) cur = { worktree: f.slice(9), locked: null };
    else if (f.startsWith('locked ') && cur) cur.locked = f.slice(7);
    else if (f === '' && cur) {
      out.push(cur);
      cur = null;
    }
  }
  return out.filter((w) => (w.locked ?? '').startsWith('peer-snapshot v1 '));
}

/**
 * A repository with one commit, then every state the capture must keep:
 * a partially staged file, staged and unstaged deletions, a staged rename,
 * untracked, ignored (file and directory), intent-to-add, assume-unchanged
 * and skip-worktree entries, a subdirectory, and a state home that
 * .gitignore does not ignore.
 */
export function makeDirtyRepo(dir) {
  const top = join(dir, 'repo');
  mkdirSync(top);
  git(top, 'init', '-q', '-b', 'main');
  for (const f of ['a', 'b', 'c', 'd', 'e', 'f']) writeFileSync(join(top, f), `${f}1\n${f}2\n${f}3\n`);
  writeFileSync(join(top, '.gitignore'), 'ignored.txt\nigdir/\n');
  mkdirSync(join(top, 'sub'));
  writeFileSync(join(top, 'sub', 's'), 's\n');
  git(top, 'add', '.');
  git(top, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init');
  writeFileSync(join(top, 'a'), 'A1\na2\na3\n');
  git(top, 'add', 'a');
  writeFileSync(join(top, 'a'), 'A1\na2\nA3\n');
  git(top, 'rm', '-q', 'b');
  rmSync(join(top, 'c'));
  git(top, 'mv', 'd', 'd2');
  writeFileSync(join(top, 'untracked'), 'u\n');
  writeFileSync(join(top, 'ignored.txt'), 'i\n');
  mkdirSync(join(top, 'igdir'));
  writeFileSync(join(top, 'igdir', 'x'), 'x\n');
  writeFileSync(join(top, 'ita'), 'ita\n');
  git(top, 'add', '-N', 'ita');
  git(top, 'update-index', '--assume-unchanged', 'e');
  git(top, 'update-index', '--skip-worktree', 'f');
  mkdirSync(join(top, '.agentic-plugins', 'state', 'engineer'), { recursive: true });
  writeFileSync(join(top, '.agentic-plugins', 'state', 'engineer', 'w.md'), 'w\n');
  return realpathSync(top);
}

/** A repository whose index is unmerged: a merge stopped on a conflict. */
export function makeUnmergedRepo(dir) {
  const top = join(dir, 'repo');
  mkdirSync(top);
  git(top, 'init', '-q', '-b', 'main');
  writeFileSync(join(top, 'm'), 'base\n');
  git(top, 'add', 'm');
  git(top, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'base');
  git(top, 'checkout', '-q', '-b', 'other');
  writeFileSync(join(top, 'm'), 'other\n');
  git(top, '-c', 'commit.gpgsign=false', 'commit', '-qam', 'other');
  git(top, 'checkout', '-q', 'main');
  writeFileSync(join(top, 'm'), 'main\n');
  git(top, '-c', 'commit.gpgsign=false', 'commit', '-qam', 'main');
  gitTry(top, '-c', 'commit.gpgsign=false', 'merge', 'other');
  ok(git(top, 'ls-files', '-u').length > 0, 'the fixture is unmerged');
  return realpathSync(top);
}

export function liveView(top) {
  return {
    status: git(top, 'status', '--porcelain=v1', '-uall'),
    cached: git(top, 'diff', '--cached', '-M'),
    diff: git(top, 'diff'),
    head: git(top, 'rev-parse', 'HEAD').trim(),
    flags: git(top, 'ls-files', '-v'),
  };
}

export function indexStamp(top) {
  const idx = join(top, '.git', 'index');
  return { bytes: readFileSync(idx).toString('base64'), mtime: statSync(idx).mtimeMs };
}

// The live view minus the state home, which the snapshot never carries.
export const withoutStateHome = (status) => status.split('\n').filter((l) => !l.includes('.agentic-plugins/')).join('\n');

export async function writeFakeCompanions(root) {
  const companionsRoot = join(root, 'fake-companions');
  mkdirSync(companionsRoot, { recursive: true });
  writeFileSync(join(companionsRoot, 'discover-peer.mjs'), `
export async function discoverPeerCompanion({ peer } = {}) {
  return { ok: true, path: new URL('./' + peer + '-companion.mjs', import.meta.url).pathname };
}
`);
  const companion = `#!/usr/bin/env node
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
const args = process.argv.slice(2);
const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : null; };
const mode = process.env.FAKE_COMPANION_MODE || 'vandal';
const cwd = get('--cwd');
const promptFile = get('--prompt-file');
const record = { cwd, promptFile, prompt: readFileSync(promptFile, 'utf8'), pid: process.pid, gitDir: process.env.GIT_DIR ?? null };
if (mode === 'vandal' || mode === 'stubborn') {
  const g = (...a) => { try { execFileSync('git', ['-C', cwd, ...a], { stdio: 'ignore' }); } catch {} };
  g('checkout', '--', '.');
  g('clean', '-fdq');
  g('reset', '-q');
  writeFileSync(cwd + '/peer-wrote-this', 'x');
}
if (mode === 'stubborn' || mode === 'leaky') {
  // leaky: the child keeps the companion's stdout and stderr open.
  const stdio = mode === 'leaky' ? ['ignore', 'inherit', 'inherit'] : 'ignore';
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio, cwd });
  record.grandchild = child.pid;
  child.unref();
}
if (process.env.FAKE_RECORD) {
  writeFileSync(process.env.FAKE_RECORD + '.tmp', JSON.stringify(record));
  renameSync(process.env.FAKE_RECORD + '.tmp', process.env.FAKE_RECORD);
}
if (mode === 'hang') { setInterval(() => {}, 1000); await new Promise(() => {}); }
const fail = mode === 'fail';
process.stdout.write(JSON.stringify(fail
  ? { status: 'peer_error', peer_host: 'codex', peer_model: null, stdout: '', exit_code: 1, error: { kind: 'peer_run_error', message: 'boom', detail: null } }
  : { status: 'success', peer_host: 'codex', peer_model: null, stdout: 'peer answer', exit_code: 0 }));
process.exit(fail ? 1 : 0);
`;
  for (const peer of ['claude', 'codex']) {
    const p = join(companionsRoot, `${peer}-companion.mjs`);
    writeFileSync(p, companion);
    chmodSync(p, 0o755);
  }
  return companionsRoot;
}
