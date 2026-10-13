// C96 — a codex peer runs in a snapshot of the checkout, never the live tree:
// plugins/<persona>/scripts/lib/peer-snapshot.mjs (capture, materialize,
// remove, reclaim) and its two callers, peer-runner.mjs and dispatch-peer.mjs,
// run once for every persona the persona-pipeline manifest generates the
// library into (ADR-0066 Decision 5).
//
// The fixtures are real git repositories. The fake companion's `vandal` mode
// does what a peer was measured doing — `checkout -- .` and `clean -fd` in
// the directory it was given — so "the live tree is intact" is tested against
// the failure it exists for, not against a peer that never writes.

import { describe, it } from 'node:test';
import { ok, strictEqual, notStrictEqual, deepStrictEqual, rejects, match } from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
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
  symlinkSync,
  writeFileSync,
  cpSync,
} from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import { personasFor, personaInfo } from './_personas.mjs';

const require = createRequire(import.meta.url);

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
};
const cleanEnv = (extra = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && !k.startsWith('GIT_'))),
  ...GIT_ENV,
  ...extra,
});
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], {
  encoding: 'utf8', env: cleanEnv({ GIT_OPTIONAL_LOCKS: '0' }), stdio: ['ignore', 'pipe', 'pipe'],
});
const gitTry = (cwd, ...args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: cleanEnv() });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(predicate, { timeoutMs = 20000, message = 'condition' } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const v = await predicate();
    if (v) return v;
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${message}`);
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
/** `promise`, or a failure naming `what` after `ms`: a defect is a verdict, never a hang. */
async function within(promise, what, ms = 30000) {
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
function killGroup(pid) {
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
const groupAlive = (pgid) => {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};

/** A private temporary area, and TMPDIR pointed at it while `fn` runs, so a
 * snapshot directory left behind is counted, not lost among other runs'. */
async function withTmp(fn) {
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

const leftovers = (snaps) => readdirSync(snaps).filter((n) => n.includes('-peer-snapshot-'));

function snapshotWorktrees(top) {
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
function makeDirtyRepo(dir) {
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
function makeUnmergedRepo(dir) {
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

function liveView(top) {
  return {
    status: git(top, 'status', '--porcelain=v1', '-uall'),
    cached: git(top, 'diff', '--cached', '-M'),
    diff: git(top, 'diff'),
    head: git(top, 'rev-parse', 'HEAD').trim(),
    flags: git(top, 'ls-files', '-v'),
  };
}

function indexStamp(top) {
  const idx = join(top, '.git', 'index');
  return { bytes: readFileSync(idx).toString('base64'), mtime: statSync(idx).mtimeMs };
}

// The live view minus the state home, which the snapshot never carries.
const withoutStateHome = (status) => status.split('\n').filter((l) => !l.includes('.agentic-plugins/')).join('\n');

async function writeFakeCompanions(root) {
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

for (const persona of personasFor('scripts/lib/peer-snapshot.mjs')) {
  const P = personaInfo(persona);
  const lib = await import(pathToFileURL(P.path('scripts/lib/peer-snapshot.mjs')).href);
  const identity = await import(pathToFileURL(P.path('scripts/lib/process-identity.mjs')).href);
  const runner = await import(pathToFileURL(P.path('scripts/peer-runner.mjs')).href);
  const dispatcher = await import(pathToFileURL(P.path('scripts/dispatch-peer.mjs')).href);
  const state = await import(pathToFileURL(P.path('scripts/state.mjs')).href);
  const stateRoot = await import(pathToFileURL(P.path('scripts/lib/state-root.mjs')).href);
  const env = cleanEnv();

  describe(`${persona}: peer snapshot — capture and materialize (C96)`, () => {
    it('keeps every working-tree and index state, leaves the live index untouched, and is removed whole', async () => {
      await withTmp(async (dir, snaps) => {
        const top = makeDirtyRepo(dir);
        const before = liveView(top);
        const stamp = indexStamp(top);
        const snap = await lib.createPeerSnapshot({ cwd: join(top, 'sub'), runId: 'r1', persona, env });
        strictEqual(snap.isolation, 'snapshot');
        deepStrictEqual(indexStamp(top), stamp, 'the live index is read, never written');
        ok(relative(top, snap.root).startsWith('..'), 'the snapshot is outside the checkout');
        strictEqual(snap.peer_cwd, join(snap.root, 'sub'));
        const view = liveView(snap.root);
        strictEqual(view.head, before.head);
        strictEqual(view.status, withoutStateHome(before.status));
        strictEqual(view.cached, before.cached);
        strictEqual(view.diff, before.diff);
        strictEqual(view.flags, before.flags, 'assume-unchanged and skip-worktree flags are replayed');
        strictEqual(readFileSync(join(snap.root, 'a'), 'utf8'), 'A1\na2\nA3\n', 'the working bytes of a partially staged file');
        strictEqual(git(snap.root, 'show', ':a'), 'A1\na2\na3\n', 'its staged bytes');
        ok(!existsSync(join(snap.root, 'ignored.txt')) && !existsSync(join(snap.root, 'igdir')), 'ignored files stay out');
        ok(!existsSync(join(snap.root, '.agentic-plugins')), 'the state home stays out');
        ok(existsSync(join(snap.root, 'untracked')));
        strictEqual(snapshotWorktrees(top).length, 1);
        // A peer that tidies its directory tidies the snapshot only.
        git(snap.root, 'checkout', '--', '.');
        git(snap.root, 'clean', '-fdq');
        deepStrictEqual(liveView(top), before);
        const removed = await lib.removePeerSnapshot(snap, { env });
        deepStrictEqual(removed, { removed: true, error: null });
        strictEqual(snapshotWorktrees(top).length, 0);
        deepStrictEqual(leftovers(snaps), []);
        deepStrictEqual(indexStamp(top), stamp);
      });
    });

    it('a peer directory that holds only ignored files is created in the snapshot', async () => {
      await withTmp(async (dir) => {
        const top = makeDirtyRepo(dir);
        const snap = await lib.createPeerSnapshot({ cwd: join(top, 'igdir'), persona, env });
        strictEqual(snap.peer_cwd, join(snap.root, 'igdir'));
        ok(statSync(snap.peer_cwd).isDirectory());
        ok(!existsSync(join(snap.peer_cwd, 'x')));
        await lib.removePeerSnapshot(snap, { env });
      });
    });

    it('from a linked worktree: that worktree\'s HEAD and its own index', async () => {
      await withTmp(async (dir, snaps) => {
        const top = makeDirtyRepo(dir);
        const lane = join(dir, 'lane');
        git(top, 'worktree', 'add', '-q', '-b', 'feat/x', lane);
        writeFileSync(join(lane, 'a'), 'lane-staged\n');
        git(lane, 'add', 'a');
        writeFileSync(join(lane, 'a'), 'lane-working\n');
        const before = liveView(lane);
        const snap = await lib.createPeerSnapshot({ cwd: lane, persona, env });
        const view = liveView(snap.root);
        strictEqual(view.head, before.head);
        strictEqual(view.status, before.status);
        strictEqual(view.cached, before.cached);
        strictEqual(readFileSync(join(snap.root, 'a'), 'utf8'), 'lane-working\n');
        await lib.removePeerSnapshot(snap, { env });
        deepStrictEqual(leftovers(snaps), []);
        deepStrictEqual(liveView(lane), before);
      });
    });

    it('an unborn HEAD gets an orphan snapshot, and no branch is left behind', async () => {
      await withTmp(async (dir, snaps) => {
        const top = join(dir, 'repo');
        mkdirSync(top);
        git(top, 'init', '-q', '-b', 'main');
        writeFileSync(join(top, 'staged'), 's\n');
        git(top, 'add', 'staged');
        writeFileSync(join(top, 'loose'), 'l\n');
        const before = git(top, 'status', '--porcelain=v1', '-uall');
        const snap = await lib.createPeerSnapshot({ cwd: top, persona, env });
        strictEqual(snap.isolation, 'snapshot');
        strictEqual(snap.head, null);
        strictEqual(git(snap.root, 'status', '--porcelain=v1', '-uall'), before);
        // A commit the peer makes there would create the orphan branch.
        git(snap.root, '-c', 'commit.gpgsign=false', 'commit', '-qm', 'peer');
        await lib.removePeerSnapshot(snap, { env });
        strictEqual(git(top, 'for-each-ref'), '');
        deepStrictEqual(leftovers(snaps), []);
        strictEqual(git(top, 'status', '--porcelain=v1', '-uall'), before);
      });
    });

    it('a directory that is no checkout runs as before (isolation none)', async () => {
      await withTmp(async (dir, snaps) => {
        const plain = join(dir, 'plain');
        mkdirSync(plain);
        deepStrictEqual(await lib.createPeerSnapshot({ cwd: plain, persona, env }), { isolation: 'none', reason: 'not-a-checkout' });
        deepStrictEqual(leftovers(snaps), []);
      });
    });

    it('a broken .git fails the snapshot (never "no checkout") and leaves nothing', async () => {
      await withTmp(async (dir, snaps) => {
        const top = join(dir, 'repo');
        mkdirSync(top);
        writeFileSync(join(top, '.git'), 'gitdir: /nonexistent/elsewhere\n');
        await rejects(lib.createPeerSnapshot({ cwd: top, persona, env }), (e) => e.reason === 'git-discovery');
        deepStrictEqual(leftovers(snaps), []);
      });
    });

    it('an unmerged index fails the snapshot and leaves no worktree or directory', async () => {
      await withTmp(async (dir, snaps) => {
        const top = makeUnmergedRepo(dir);
        await rejects(lib.createPeerSnapshot({ cwd: top, persona, env }), (e) => e.reason === 'unmerged-index');
        deepStrictEqual(leftovers(snaps), []);
        strictEqual(snapshotWorktrees(top).length, 0);
      });
    });

    it('git selectors in the caller\'s environment cannot point the capture or the snapshot at the live tree', async () => {
      await withTmp(async (dir) => {
        const top = makeDirtyRepo(dir);
        const before = liveView(top);
        const stamp = indexStamp(top);
        const poisoned = { ...env, GIT_DIR: join(top, '.git'), GIT_WORK_TREE: top, GIT_INDEX_FILE: join(top, '.git', 'index') };
        const snap = await lib.createPeerSnapshot({ cwd: top, persona, env: poisoned });
        deepStrictEqual(indexStamp(top), stamp);
        strictEqual(liveView(snap.root).status, withoutStateHome(before.status));
        const scrubbed = lib.scrubGitSelectors(poisoned);
        for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) ok(!(name in scrubbed), `${name} is scrubbed`);
        await lib.removePeerSnapshot(snap, { env: poisoned });
        deepStrictEqual(liveView(top), before);
      });
    });

    it('a TMPDIR inside the checkout puts the snapshot outside it', async () => {
      await withTmp(async (dir) => {
        const top = makeDirtyRepo(dir);
        const inside = join(top, 'igdir', 'tmp');
        mkdirSync(inside, { recursive: true });
        const saved = process.env.TMPDIR;
        process.env.TMPDIR = inside;
        try {
          const snap = await lib.createPeerSnapshot({ cwd: top, persona, env });
          ok(relative(top, snap.root).startsWith('..'), `${snap.root} is outside ${top}`);
          await lib.removePeerSnapshot(snap, { env });
        } finally {
          process.env.TMPDIR = saved;
        }
      });
    });

    it('HEAD moving during the capture is captured again; moving twice fails, leaving nothing', async () => {
      await withTmp(async (dir, snaps) => {
        const top = makeDirtyRepo(dir);
        const move = () => git(top, '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'moved');
        const snap = await lib.createPeerSnapshot({ cwd: top, persona, env, hooks: { afterCapture: (n) => (n === 1 ? move() : null) } });
        strictEqual(snap.head, git(top, 'rev-parse', 'HEAD').trim(), 'the second capture, at the moved HEAD');
        await lib.removePeerSnapshot(snap, { env });
        await rejects(lib.createPeerSnapshot({ cwd: top, persona, env, hooks: { afterCapture: move } }), (e) => e.reason === 'head-moved');
        deepStrictEqual(leftovers(snaps), []);
        strictEqual(snapshotWorktrees(top).length, 0);
      });
    });

    it('a cancellation during the capture stops it and leaves nothing', async () => {
      await withTmp(async (dir, snaps) => {
        const top = makeDirtyRepo(dir);
        const abort = new AbortController();
        await rejects(lib.createPeerSnapshot({ cwd: top, persona, env, signal: abort.signal, hooks: { afterCapture: () => abort.abort() } }), (e) => e.reason === 'cancelled');
        deepStrictEqual(leftovers(snaps), []);
        strictEqual(snapshotWorktrees(top).length, 0);
      });
    });

    it('a cancellation while a git call runs (a slow clean filter) stops that call, the filter with it, and reads as cancelled', async () => {
      await withTmp(async (dir, snaps) => {
        const top = makeDirtyRepo(dir);
        // The filter is git's child: it records its shell's pid, starts a
        // descendant that ignores SIGTERM and holds none of git's pipes (so
        // 'close' does not wait for it), records that one's pid, then sleeps.
        const pidFile = join(dir, 'filter.pid');
        const descFile = join(dir, 'descendant.pid');
        // The descendant says it is ready once its trap is in place.
        const readyFile = join(dir, 'descendant.ready');
        git(top, 'config', 'filter.slow.clean', `(trap '' TERM; : > '${readyFile}'; exec sleep 30) </dev/null >/dev/null 2>&1 & echo $! > '${descFile}'; echo $$ > '${pidFile}'; sleep 30; cat`);
        writeFileSync(join(top, '.gitattributes'), 'slowfile filter=slow\n');
        writeFileSync(join(top, 'slowfile'), 'slow\n');
        const abort = new AbortController();
        const started = Date.now();
        const creating = lib.createPeerSnapshot({ cwd: top, persona, env, signal: abort.signal });
        let filterPid = null;
        let descendantPid = null;
        try {
          await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() && existsSync(readyFile), { message: 'the filter and its SIGTERM-ignoring descendant to start' });
          filterPid = Number(readFileSync(pidFile, 'utf8').trim());
          descendantPid = Number(readFileSync(descFile, 'utf8').trim());
          ok(alive(descendantPid), 'the descendant runs');
          abort.abort();
          await rejects(creating, (e) => e.reason === 'cancelled');
          ok(Date.now() - started < 20000, 'the filter was stopped, not waited out');
          ok(!alive(filterPid), 'the filter git started is stopped with git');
          ok(!alive(descendantPid), 'the descendant that ignores SIGTERM is killed before the call settles');
          deepStrictEqual(leftovers(snaps), []);
          strictEqual(snapshotWorktrees(top).length, 0);
        } finally {
          abort.abort();
          await creating.catch(() => {});
          if (filterPid) killGroup(filterPid);
          if (descendantPid) killGroup(descendantPid);
        }
      });
    });

    it('rewrites the live toplevel in a prompt, in every spelling, at path boundaries only', () => {
      const out = lib.rewritePromptPaths(
        'a=/r/top/x b=/link/top/y c=/r/top d=/r/top-other/z e=/q/r/top/w f=file:///r/top/v',
        ['/r/top', '/link/top'],
        '/snap/tree',
      );
      strictEqual(out.text, 'a=/snap/tree/x b=/snap/tree/y c=/snap/tree d=/r/top-other/z e=/q/r/top/w f=file:///snap/tree/v');
      strictEqual(out.count, 4);
    });

    it('rewrites the toplevel as an XML prompt escapes it', () => {
      const out = lib.rewritePromptPaths(
        'raw=/r/R&D/a text=/r/R&amp;D/b <f path="/r/Q&quot;s&amp;D/c"/> other=/r/R&amp;Dx/d',
        ['/r/R&D', '/r/Q"s&D'],
        '/snap/tree',
      );
      strictEqual(out.text, 'raw=/snap/tree/a text=/snap/tree/b <f path="/snap/tree/c"/> other=/r/R&amp;Dx/d');
      strictEqual(out.count, 3);
    });

    it('a TMPDIR whose path XML would escape is passed over: the root reads the same escaped or not', async () => {
      await withTmp(async (dir) => {
        const top = makeDirtyRepo(dir);
        const special = join(dir, 'R&D "tmp"');
        mkdirSync(special);
        const saved = process.env.TMPDIR;
        process.env.TMPDIR = special;
        try {
          const snap = await lib.createPeerSnapshot({ cwd: top, persona, env });
          ok(!/[&<>"']/.test(snap.root), `${snap.root} carries no character XML escapes`);
          await lib.removePeerSnapshot(snap, { env });
        } finally {
          process.env.TMPDIR = saved;
        }
      });
    });
  });

  describe(`${persona}: peer snapshot — reclaim (C96)`, () => {
    async function deadPid() {
      const child = spawn(process.execPath, ['-e', '0'], { stdio: 'ignore' });
      await new Promise((r) => child.once('exit', r));
      return child.pid;
    }
    const editOwner = (snap, fn) => {
      const owner = JSON.parse(readFileSync(snap.owner_path, 'utf8'));
      fn(owner);
      writeFileSync(snap.owner_path, JSON.stringify(owner));
    };

    it('reclaims a snapshot whose supervisor and companion are gone; keeps a live one', async () => {
      await withTmp(async (dir, snaps) => {
        const top = makeDirtyRepo(dir);
        const dead = await lib.createPeerSnapshot({ cwd: top, persona, env, supervisorPid: await deadPid() });
        const live = await lib.createPeerSnapshot({ cwd: top, persona, env });
        editOwner(dead, (o) => { o.companion = { pid: o.supervisor.pid, pgid: o.supervisor.pid, fingerprint: { kind: 'none' } }; });
        const report = await lib.reclaimPeerSnapshots({ cwd: top, env });
        deepStrictEqual(report.reclaimed.map((r) => r.tree), [dead.root]);
        deepStrictEqual(report.kept.map((k) => [k.tree, k.why]), [[live.root, 'supervisor-alive']]);
        ok(!existsSync(dead.parent));
        ok(existsSync(live.root));
        await lib.removePeerSnapshot(live, { env });
        deepStrictEqual(leftovers(snaps), []);
      });
    });

    it('keeps a snapshot whose supervisor died while its companion still runs, and reclaims it once that ends', async (t) => {
      await withTmp(async (dir) => {
        const top = makeDirtyRepo(dir);
        const snap = await lib.createPeerSnapshot({ cwd: top, persona, env, supervisorPid: await deadPid() });
        const peer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
        await new Promise((r) => peer.once('spawn', r));
        t.after(() => killGroup(peer.pid));
        await lib.recordSnapshotCompanion(snap, { pid: peer.pid, pgid: peer.pid, fingerprint: await identity.fingerprintForPid(peer.pid) });
        let report = await lib.reclaimPeerSnapshots({ cwd: top, env });
        deepStrictEqual(report.kept.map((k) => k.why), ['companion-alive']);
        ok(existsSync(snap.root));
        process.kill(-peer.pid, 'SIGKILL');
        await waitFor(() => !groupAlive(peer.pid), { message: 'the companion group to end' });
        report = await lib.reclaimPeerSnapshots({ cwd: top, env });
        deepStrictEqual(report.reclaimed.map((r) => [r.tree, r.why]), [[snap.root, 'owners-gone']]);
      });
    });

    it('a reused supervisor pid (another fingerprint) counts as gone', async () => {
      await withTmp(async (dir) => {
        const top = makeDirtyRepo(dir);
        const snap = await lib.createPeerSnapshot({ cwd: top, persona, env });
        editOwner(snap, (o) => {
          o.supervisor.fingerprint = { ...o.supervisor.fingerprint, lstart: 'Thu Jan  1 00:00:00 1970', starttime: '1' };
        });
        strictEqual(await identity.identityState(JSON.parse(readFileSync(snap.owner_path, 'utf8')).supervisor), 'differ');
        const report = await lib.reclaimPeerSnapshots({ cwd: top, env });
        deepStrictEqual(report.reclaimed.map((r) => r.why), ['supervisor-gone-companion-unrecorded']);
      });
    });

    it('a launch whose companion was never recorded is kept after its supervisor dies, until the TTL', async () => {
      await withTmp(async (dir) => {
        const top = makeDirtyRepo(dir);
        const snap = await lib.createPeerSnapshot({ cwd: top, persona, env, supervisorPid: await deadPid() });
        await lib.recordSnapshotLaunch(snap);
        let report = await lib.reclaimPeerSnapshots({ cwd: top, env });
        deepStrictEqual(report.kept.map((k) => k.why), ['identity-unknown']);
        report = await lib.reclaimPeerSnapshots({ cwd: top, env, now: Date.now() + lib.SNAPSHOT_TTL_MS + 60_000 });
        deepStrictEqual(report.reclaimed.map((r) => r.why), ['identity-unknown-expired']);
      });
    });

    it('an identity that cannot be told is kept until the record is older than the TTL', async () => {
      await withTmp(async (dir) => {
        const top = makeDirtyRepo(dir);
        const snap = await lib.createPeerSnapshot({ cwd: top, persona, env });
        editOwner(snap, (o) => { o.supervisor.fingerprint = { kind: 'none' }; });
        let report = await lib.reclaimPeerSnapshots({ cwd: top, env });
        deepStrictEqual(report.kept.map((k) => k.why), ['identity-unknown']);
        report = await lib.reclaimPeerSnapshots({ cwd: top, env, now: Date.now() + lib.SNAPSHOT_TTL_MS + 60_000 });
        deepStrictEqual(report.reclaimed.map((r) => r.why), ['identity-unknown-expired']);
      });
    });

    it('an unreadable owner record follows the TTL too', async () => {
      await withTmp(async (dir) => {
        const top = makeDirtyRepo(dir);
        const snap = await lib.createPeerSnapshot({ cwd: top, persona, env });
        writeFileSync(snap.owner_path, '{ not json');
        let report = await lib.reclaimPeerSnapshots({ cwd: top, env });
        deepStrictEqual(report.kept.map((k) => k.why), ['owner-unreadable']);
        report = await lib.reclaimPeerSnapshots({ cwd: top, env, now: Date.now() + lib.SNAPSHOT_TTL_MS + 60_000 });
        deepStrictEqual(report.reclaimed.map((r) => r.why), ['owner-unreadable-expired']);
        strictEqual(snapshotWorktrees(top).length, 0);
      });
    });

    it('a snapshot whose directory is gone loses its registration', async () => {
      await withTmp(async (dir) => {
        const top = makeDirtyRepo(dir);
        const snap = await lib.createPeerSnapshot({ cwd: top, persona, env });
        rmSync(snap.parent, { recursive: true, force: true });
        const report = await lib.reclaimPeerSnapshots({ cwd: top, env });
        deepStrictEqual(report.reclaimed.map((r) => r.why), ['directory-gone']);
        strictEqual(snapshotWorktrees(top).length, 0);
      });
    });

    it('an interrupted creation (an owner record, no worktree) is reclaimed when its supervisor is gone', async () => {
      await withTmp(async (dir, snaps) => {
        const top = makeDirtyRepo(dir);
        const parent = mkdtempSync(join(snaps, `${persona}-peer-snapshot-`));
        const owner = (pid) => ({
          schema: lib.SNAPSHOT_OWNER_SCHEMA, run_id: null, persona, live_toplevel: top, tree: join(parent, 'tree'), branch: null,
          supervisor: { pid, fingerprint: { kind: 'none' } }, companion: null, created_at: new Date().toISOString(),
        });
        writeFileSync(join(parent, 'owner.json'), JSON.stringify(owner(process.pid)));
        let report = await lib.reclaimPeerSnapshots({ cwd: top, env });
        ok(existsSync(parent), 'a creator that may still be running is left alone');
        writeFileSync(join(parent, 'owner.json'), JSON.stringify(owner(await deadPid())));
        report = await lib.reclaimPeerSnapshots({ cwd: top, env });
        deepStrictEqual(report.reclaimed.map((r) => r.why), ['interrupted-supervisor-gone-companion-unrecorded']);
        deepStrictEqual(leftovers(snaps), []);
      });
    });

    it('a launch its supervisor records while the reclaim judges it is read again before anything is removed', async () => {
      await withTmp(async (dir) => {
        const top = makeDirtyRepo(dir);
        const snap = await lib.createPeerSnapshot({ cwd: top, persona, env, supervisorPid: await deadPid() });
        // The supervisor records the launch, spawns its peer and dies after
        // the reclaim's first read of the owner record.
        let raced = false;
        const hooks = { afterOwnerRead: async () => {
          if (raced) return;
          raced = true;
          await lib.recordSnapshotLaunch(snap);
        } };
        const report = await lib.reclaimPeerSnapshots({ cwd: top, env, hooks });
        ok(raced);
        deepStrictEqual(report.reclaimed, []);
        deepStrictEqual(report.kept.map((k) => [k.tree, k.why]), [[snap.root, 'identity-unknown']]);
        ok(existsSync(snap.root));
        await lib.removePeerSnapshot(snap, { env });
      });
    });

    it('a live companion group whose leader exited blocks the reclaim, however old the record', async (t) => {
      await withTmp(async (dir) => {
        const top = makeDirtyRepo(dir);
        const snap = await lib.createPeerSnapshot({ cwd: top, persona, env, supervisorPid: await deadPid() });
        // The leader starts a child in its own group, then exits.
        const leader = spawn(process.execPath, ['-e', "require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).unref()"], { stdio: 'ignore', detached: true });
        t.after(() => killGroup(leader.pid));
        await new Promise((r) => leader.once('exit', r));
        ok(!alive(leader.pid) && groupAlive(leader.pid), 'the leader is gone, its group lives');
        await lib.recordSnapshotCompanion(snap, { pid: leader.pid, pgid: leader.pid, fingerprint: { kind: 'none' } });
        const report = await lib.reclaimPeerSnapshots({ cwd: top, env, now: Date.now() + 10 * lib.SNAPSHOT_TTL_MS });
        deepStrictEqual(report.reclaimed, []);
        deepStrictEqual(report.kept.map((k) => k.why), ['companion-alive']);
        ok(existsSync(snap.root));
        await lib.removePeerSnapshot(snap, { env });
      });
    });

    it('an interrupted creation from a linked worktree is reclaimed from the main checkout', async () => {
      await withTmp(async (dir, snaps) => {
        const top = makeDirtyRepo(dir);
        const lane = join(dir, 'lane');
        git(top, 'worktree', 'add', '-q', '-b', 'feat/lane', lane);
        const snap = await lib.createPeerSnapshot({ cwd: lane, persona, env, supervisorPid: await deadPid() });
        strictEqual(JSON.parse(readFileSync(snap.owner_path, 'utf8')).common_dir, realpathSync(join(top, '.git')));
        // What a creation that died before `worktree add` left: the directory
        // and its owner record, no registered worktree.
        git(top, 'worktree', 'remove', '-f', '-f', snap.root);
        ok(existsSync(snap.owner_path));
        const report = await lib.reclaimPeerSnapshots({ cwd: top, env });
        deepStrictEqual(report.reclaimed.map((r) => r.why), ['interrupted-supervisor-gone-companion-unrecorded']);
        deepStrictEqual(leftovers(snaps), []);
      });
    });

    it('an interrupted creation\'s orphan branch is deleted with it', async () => {
      await withTmp(async (dir, snaps) => {
        const top = makeDirtyRepo(dir);
        const parent = mkdtempSync(join(snaps, `${persona}-peer-snapshot-`));
        const branch = `peer-snapshot/${relative(snaps, parent)}`;
        git(top, 'update-ref', `refs/heads/${branch}`, 'HEAD');
        writeFileSync(join(parent, 'owner.json'), JSON.stringify({
          schema: lib.SNAPSHOT_OWNER_SCHEMA, run_id: null, persona, live_toplevel: top, tree: join(parent, 'tree'), branch,
          supervisor: { pid: await deadPid(), fingerprint: { kind: 'none' } }, companion: null, created_at: new Date().toISOString(),
        }));
        const report = await lib.reclaimPeerSnapshots({ cwd: top, env });
        deepStrictEqual(report.errors, []);
        deepStrictEqual(report.reclaimed.map((r) => r.why), ['interrupted-supervisor-gone-companion-unrecorded']);
        strictEqual(git(top, 'for-each-ref', 'refs/heads/peer-snapshot'), '');
        deepStrictEqual(leftovers(snaps), []);
      });
    });

    it('a branch that cannot be deleted keeps the owner record, and a later reclaim deletes it', async () => {
      await withTmp(async (dir, snaps) => {
        const top = makeDirtyRepo(dir);
        const parent = mkdtempSync(join(snaps, `${persona}-peer-snapshot-`));
        const branch = `peer-snapshot/${relative(snaps, parent)}`;
        git(top, 'update-ref', `refs/heads/${branch}`, 'HEAD');
        writeFileSync(join(parent, 'owner.json'), JSON.stringify({
          schema: lib.SNAPSHOT_OWNER_SCHEMA, run_id: null, persona, live_toplevel: top, tree: join(parent, 'tree'), branch,
          supervisor: { pid: await deadPid(), fingerprint: { kind: 'none' } }, companion: null, created_at: new Date().toISOString(),
        }));
        // A ref lock another git process holds makes the deletion fail.
        const lock = join(top, '.git', 'refs', 'heads', `${branch}.lock`);
        writeFileSync(lock, '');
        let report = await lib.reclaimPeerSnapshots({ cwd: top, env });
        strictEqual(report.reclaimed.length, 0);
        strictEqual(report.errors.length, 1);
        ok(existsSync(join(parent, 'owner.json')), 'the record the retry needs is kept');
        rmSync(lock);
        report = await lib.reclaimPeerSnapshots({ cwd: top, env });
        deepStrictEqual(report.errors, []);
        deepStrictEqual(report.reclaimed.map((r) => r.why), ['interrupted-supervisor-gone-companion-unrecorded']);
        strictEqual(git(top, 'for-each-ref', 'refs/heads/peer-snapshot'), '');
        deepStrictEqual(leftovers(snaps), []);
      });
    });

    it('two reclaimers racing remove the snapshot once, without errors', async () => {
      await withTmp(async (dir, snaps) => {
        const top = makeDirtyRepo(dir);
        await lib.createPeerSnapshot({ cwd: top, persona, env, supervisorPid: await deadPid() });
        const [a, b] = await Promise.all([lib.reclaimPeerSnapshots({ cwd: top, env }), lib.reclaimPeerSnapshots({ cwd: top, env })]);
        deepStrictEqual([...a.errors, ...b.errors], []);
        strictEqual(snapshotWorktrees(top).length, 0);
        deepStrictEqual(leftovers(snaps), []);
      });
    });

    it('a worktree locked for another reason, or naming an owner outside its own directory, is not a snapshot', async () => {
      await withTmp(async (dir) => {
        const top = makeDirtyRepo(dir);
        const other = join(dir, 'other-peer-snapshot-x', 'tree');
        mkdirSync(dirname(other));
        writeFileSync(join(dirname(other), 'owner.json'), '{}');
        git(top, 'worktree', 'add', '-q', '--detach', '--lock', '--reason', `peer-snapshot v1 ${join(dir, 'elsewhere-peer-snapshot-y', 'owner.json')}`, other);
        const report = await lib.reclaimPeerSnapshots({ cwd: top, env, now: Date.now() + 10 * lib.SNAPSHOT_TTL_MS });
        deepStrictEqual(report.reclaimed, []);
        ok(existsSync(other));
        git(top, 'worktree', 'remove', '-f', '-f', other);
      });
    });
  });

  describe(`${persona}: peer snapshot — the ADR-0067 write guard (C96)`, () => {
    it('a live workflow stays writable while a snapshot exists in a repository that does not ignore the state home', async () => {
      await withTmp(async (dir) => {
        const top = makeDirtyRepo(dir);
        rmSync(join(top, '.agentic-plugins'), { recursive: true, force: true });
        const { filePath } = await stateRoot.runInCommandDirectory(top, () => state.createWorkflow({
          repoRoot: top, verb: 'compose', originalRequest: 'guard', host: 'claude', currentPhase: 'p', nextAction: 'n',
          gitBaseline: { branch: 'main', head: git(top, 'rev-parse', 'HEAD').trim(), status_digest: '' },
        }));
        const snap = await lib.createPeerSnapshot({ cwd: top, persona, env });
        await stateRoot.runInCommandDirectory(top, () => state.assertWorkflowWritable(filePath));
        // Control: the same record copied into the snapshot is a second copy
        // the guard refuses, so the pass above is the exclusion's doing.
        const copy = join(snap.root, relative(top, filePath));
        mkdirSync(dirname(copy), { recursive: true });
        cpSync(filePath, copy);
        await rejects(stateRoot.runInCommandDirectory(top, () => state.assertWorkflowWritable(filePath)));
        await lib.removePeerSnapshot(snap, { env });
      });
    });
  });

  describe(`${persona}: peer-runner — a codex peer runs in the snapshot (C96)`, () => {
    const PEER_RUNNER = P.path('scripts/peer-runner.mjs');

    async function fixture(dir) {
      const top = makeDirtyRepo(dir);
      const companions = await writeFakeCompanions(dir);
      return { top, companions, record: join(dir, 'record.json') };
    }
    const fakeEnv = (f, mode, extra = {}) => ({ ...env, AGENTIC_COMPANIONS_ROOT: f.companions, FAKE_COMPANION_MODE: mode, FAKE_RECORD: f.record, ...extra });

    it('the vandal peer tidies only the snapshot; its paths and prompt name the snapshot; the snapshot is removed', async () => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const link = join(dir, 'link');
        symlinkSync(f.top, link);
        const before = liveView(f.top);
        const promptFile = join(dir, 'prompt.xml');
        const prompt = `<task>read ${f.top}/a and ${link}/sub/s, not ${f.top}-other/a</task>`;
        writeFileSync(promptFile, prompt);
        const result = await runner.runPeer({
          repoRoot: f.top, peer: 'codex', promptFile, cwd: link, outputFormat: 'json',
          env: fakeEnv(f, 'vandal', { GIT_DIR: join(f.top, '.git'), GIT_WORK_TREE: f.top }),
        });
        strictEqual(result.status, 'completed');
        // The run's own ledger is the one change the live tree may show.
        const sansLedger = (v) => ({ ...v, status: withoutStateHome(v.status) });
        deepStrictEqual(sansLedger(liveView(f.top)), sansLedger(before), 'the live tree and index are intact');
        ok(!existsSync(join(f.top, 'peer-wrote-this')));
        const rec = JSON.parse(readFileSync(f.record, 'utf8'));
        strictEqual(rec.cwd, result.snapshot.peer_cwd);
        ok(rec.cwd.startsWith(dirname(result.snapshot.root)) && relative(f.top, rec.cwd).startsWith('..'));
        ok(relative(f.top, rec.promptFile).startsWith('..'), 'the prompt copy is outside the checkout');
        strictEqual(rec.prompt, `<task>read ${result.snapshot.root}/a and ${result.snapshot.root}/sub/s, not ${f.top}-other/a</task>`);
        strictEqual(rec.gitDir, null, 'no git selector reaches the companion');
        strictEqual(readFileSync(promptFile, 'utf8'), prompt, 'the caller\'s prompt file is unchanged');
        strictEqual(result.snapshot.isolation, 'snapshot');
        strictEqual(result.snapshot.prompt_paths_rewritten, 2);
        ok(result.snapshot.removed_at);
        strictEqual(result.snapshot.cleanup_error, null);
        strictEqual((await runner.readHandle(result.handle_path)).snapshot.head, before.head);
        strictEqual(snapshotWorktrees(f.top).length, 0);
        deepStrictEqual(leftovers(snaps), []);
      });
    });

    it('a failed peer run removes its snapshot too', async () => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const result = await runner.runPeer({ repoRoot: f.top, peer: 'codex', promptText: 'x', cwd: f.top, env: fakeEnv(f, 'fail') });
        strictEqual(result.status, 'failed');
        ok(result.snapshot.removed_at);
        deepStrictEqual(leftovers(snaps), []);
      });
    });

    it('a run that throws once its snapshot exists (an unreadable prompt) ends failed, its snapshot removed, no companion run', async () => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const promptDir = join(dir, 'prompt-is-a-directory');
        mkdirSync(promptDir);
        await rejects(runner.runPeer({ repoRoot: f.top, runId: 'throws-1', peer: 'codex', promptFile: promptDir, cwd: f.top, env: fakeEnv(f, 'vandal') }), (e) => e.code === 'EISDIR');
        const handle = await runner.readHandle(runner.peerRunPaths(f.top, 'throws-1').handle);
        strictEqual(handle.status, 'failed');
        strictEqual(handle.error_kind, 'EISDIR');
        ok(handle.completed_at);
        strictEqual(handle.snapshot.isolation, 'snapshot');
        ok(handle.snapshot.removed_at);
        ok(!existsSync(f.record), 'no companion ran');
        deepStrictEqual(leftovers(snaps), []);
        strictEqual(snapshotWorktrees(f.top).length, 0);
      });
    });

    it('a cancellation still reaches the peer when the ledger refuses the write that records it running', async (t) => {
      if (process.getuid?.() === 0) return t.skip('root writes through a read-only directory');
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const ledger = runner.peerRunPaths(f.top, 'eacces-1').dir;
        const cancellation = runner.createRunCancellation();
        // The update that records the running peer is shown to the run, then
        // its write fails: the ledger directory is read-only from here on.
        const hooks = { beforeHandleWrite: (h) => { if (h.status === 'running') chmodSync(ledger, 0o500); } };
        const running = runner.runPeer({ repoRoot: f.top, runId: 'eacces-1', peer: 'codex', promptText: 'x', cwd: f.top, env: fakeEnv(f, 'hang'), cancellation, cancelGraceMs: 500, hooks });
        // Handled now, judged below: an early rejection must fail this test,
        // not end it while it still holds TMPDIR.
        running.catch(() => {});
        let pid = null;
        try {
          await waitFor(() => existsSync(f.record), { message: 'the companion to start' });
          pid = JSON.parse(readFileSync(f.record, 'utf8')).pid;
          await waitFor(() => (statSync(ledger).mode & 0o777) === 0o500, { message: 'the ledger to turn read-only' });
          cancellation.request('SIGTERM');
          await rejects(within(running, 'the run to end on the cancellation'), (e) => e.code === 'EACCES');
          ok(!alive(pid), 'the peer is stopped');
          // The write that would have recorded the running peer is the one
          // that failed: the ledger never left spawning.
          const onDisk = await runner.readHandle(runner.peerRunPaths(f.top, 'eacces-1').handle);
          strictEqual(onDisk.status, 'spawning');
          strictEqual(onDisk.pid ?? null, null);
          deepStrictEqual(leftovers(snaps), []);
          strictEqual(snapshotWorktrees(f.top).length, 0);
        } finally {
          chmodSync(ledger, 0o700);
          if (pid) killGroup(pid);
          await running.catch(() => {});
        }
      });
    });

    it('a cancellation that comes after the run read its handle and before the terminal write still ends it cancelled', async () => {
      await withTmp(async (dir) => {
        const f = await fixture(dir);
        const cancellation = runner.createRunCancellation();
        // The signal lands as the terminal record is about to be written.
        const hooks = { beforeHandleWrite: (h, before) => { if (h.status === 'completed' && before === 'running') cancellation.request('SIGTERM'); } };
        const result = await runner.runPeer({ repoRoot: f.top, peer: 'codex', promptText: 'x', cwd: f.top, env: fakeEnv(f, 'vandal'), cancellation, hooks });
        strictEqual(cancellation.signal, 'SIGTERM');
        strictEqual(result.status, 'cancelled');
        strictEqual(result.error_kind, 'cancelled');
        strictEqual((await runner.readHandle(result.handle_path)).status, 'cancelled');
      });
    });

    // The interleaving the refine review of 2026-10-13 reproduced: the peer
    // exits on its own while a `cancel` from another process is under way,
    // the run reads its handle (`running`) to compute the terminal status, and
    // the cancel's write — `cancel_requested`, or its last, `cancelled` —
    // lands before the terminal write. That read sits in the four-copy spawn
    // section, which has no seam, so the test writes the cancel's record from
    // inside the read itself: fs/promises' readFile, wrapped for this one run.
    for (const landed of ['cancel_requested', 'cancelled']) {
      it(`a cancel whose ${landed} record lands between the run's last read and its terminal write keeps the run cancelled`, async () => {
        await withTmp(async (dir) => {
          const f = await fixture(dir);
          const runId = `landed-${landed}`;
          const paths = runner.peerRunPaths(f.top, runId);
          const fsp = require('node:fs/promises');
          const readFile = fsp.readFile;
          let injected = false;
          fsp.readFile = async (path, ...rest) => {
            const text = await readFile(path, ...rest);
            // The first read of the handle once the envelope is written is
            // the one the terminal status is computed from.
            if (!injected && String(path) === paths.handle && existsSync(paths.envelope)) {
              injected = true;
              const h = JSON.parse(text);
              strictEqual(h.status, 'running', 'the run reads its peer running');
              writeFileSync(paths.handle, `${JSON.stringify({ ...h, status: landed, error_kind: 'cancelled' }, null, 2)}\n`);
            }
            return text;
          };
          syncBuiltinESMExports();
          let result;
          try {
            result = await runner.runPeer({ repoRoot: f.top, runId, peer: 'codex', promptText: 'x', cwd: f.top, env: fakeEnv(f, 'vandal') });
          } finally {
            fsp.readFile = readFile;
            syncBuiltinESMExports();
          }
          ok(injected, 'the cancel landed in the gap');
          strictEqual(result.status, 'cancelled');
          strictEqual(result.error_kind, 'cancelled');
          strictEqual((await runner.readHandle(result.handle_path)).status, 'cancelled');
        });
      });
    }

    it('a cancellation requested after the run ended signals nothing of its peer', async () => {
      await withTmp(async (dir) => {
        const f = await fixture(dir);
        const cancellation = runner.createRunCancellation();
        const result = await runner.runPeer({ repoRoot: f.top, peer: 'codex', promptText: 'x', cwd: f.top, env: fakeEnv(f, 'vandal'), cancellation, cancelGraceMs: 200 });
        strictEqual(result.status, 'completed');
        const { pid } = JSON.parse(readFileSync(f.record, 'utf8'));
        const sent = [];
        const kill = process.kill;
        process.kill = (target, sig) => {
          if (Math.abs(target) === pid) sent.push([target, sig]);
          return kill.call(process, target, sig);
        };
        try {
          cancellation.request('SIGTERM');
          await sleep(500);
        } finally {
          process.kill = kill;
        }
        deepStrictEqual(sent, [], 'the ended peer\'s pid and group, which may be another process\'s by now, get no signal');
        strictEqual((await runner.readHandle(result.handle_path)).status, 'completed');
      });
    });

    it('a claude peer is not isolated: it gets the directory it was given', async () => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const result = await runner.runPeer({ repoRoot: f.top, peer: 'claude', promptText: 'x', cwd: join(f.top, 'sub'), env: fakeEnv(f, 'record') });
        strictEqual(result.status, 'completed');
        strictEqual(JSON.parse(readFileSync(f.record, 'utf8')).cwd, join(f.top, 'sub'));
        deepStrictEqual(result.snapshot.isolation, 'none');
        strictEqual(result.snapshot.reason, 'peer-not-isolated');
        deepStrictEqual(leftovers(snaps), []);
      });
    });

    it('a snapshot that cannot be made fails the run before any companion runs (snapshot_failed), and settles failed', async () => {
      await withTmp(async (dir) => {
        const f = { top: makeUnmergedRepo(dir), companions: await writeFakeCompanions(dir), record: join(dir, 'record.json') };
        const { filePath: workflowPath } = await stateRoot.runInCommandDirectory(f.top, () => state.createWorkflow({
          repoRoot: f.top, verb: 'compose', originalRequest: 'x', host: 'claude', currentPhase: 'p', nextAction: 'n',
          gitBaseline: { branch: 'main', head: git(f.top, 'rev-parse', 'HEAD').trim(), status_digest: '' },
        }));
        const result = await runner.runPeer({
          repoRoot: f.top, peer: 'codex', promptText: 'x', cwd: f.top, env: fakeEnv(f, 'vandal'),
          kind: 'ensemble', runId: 'snap-fail', workflowPath, phase: 'compose', ensembleType: 'plan-verify',
        });
        strictEqual(result.status, 'failed');
        strictEqual(result.error_kind, 'snapshot_failed');
        strictEqual(result.exit_code, null);
        strictEqual(result.snapshot.isolation, 'failed');
        strictEqual(result.snapshot.reason, 'unmerged-index');
        ok(!existsSync(f.record), 'no companion ran');
        const settled = await runner.settleEnsemble({ repoRoot: f.top, workflowPath, phase: 'compose', runId: 'snap-fail', verdict: 'agreed', summary: 's' });
        strictEqual(settled.verdict, 'failed');
        strictEqual(settled.error_kind, 'snapshot_failed');
      });
    });

    it('a cancellation requested before the spawn ends the run cancelled — the capture itself stopped — no companion, no snapshot left', async () => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const cancellation = runner.createRunCancellation();
        cancellation.request('SIGTERM');
        const result = await runner.runPeer({ repoRoot: f.top, peer: 'codex', promptText: 'x', cwd: f.top, env: fakeEnv(f, 'vandal'), cancellation });
        strictEqual(result.status, 'cancelled');
        strictEqual(result.snapshot.reason, 'cancelled');
        ok(!existsSync(f.record));
        deepStrictEqual(leftovers(snaps), []);
        strictEqual(snapshotWorktrees(f.top).length, 0);
      });
    });

    it('a child holding the companion\'s stdout open does not hold the run: it is stopped once the companion exits', async () => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const running = runner.runPeer({ repoRoot: f.top, peer: 'codex', promptText: 'x', cwd: f.top, env: fakeEnv(f, 'leaky'), cancelGraceMs: 300 });
        let grandchild = null;
        try {
          const result = await within(running, 'the run to end with a child holding its pipes');
          grandchild = JSON.parse(readFileSync(f.record, 'utf8')).grandchild;
          strictEqual(result.status, 'completed');
          await waitFor(() => !alive(grandchild), { timeoutMs: 5000, message: 'the child to be stopped' });
          ok(result.snapshot.removed_at);
          deepStrictEqual(leftovers(snaps), []);
        } finally {
          if (grandchild === null && existsSync(f.record)) grandchild = JSON.parse(readFileSync(f.record, 'utf8')).grandchild;
          if (grandchild) killGroup(grandchild);
        }
      });
    });

    it('a claude peer\'s leftover child is stopped too: the group outlives no run', async () => {
      await withTmp(async (dir) => {
        const f = await fixture(dir);
        const plain = join(dir, 'plain');
        mkdirSync(plain);
        const result = await runner.runPeer({ repoRoot: f.top, peer: 'claude', promptText: 'x', cwd: plain, env: fakeEnv(f, 'stubborn'), cancelGraceMs: 300 });
        const { grandchild } = JSON.parse(readFileSync(f.record, 'utf8'));
        try {
          strictEqual(result.status, 'completed');
          await waitFor(() => !alive(grandchild), { timeoutMs: 5000, message: 'the claude peer\'s child to be stopped' });
        } finally {
          killGroup(grandchild);
        }
      });
    });

    it('a codex peer outside any checkout still gets no git selector naming the live repository', async () => {
      await withTmp(async (dir) => {
        const f = await fixture(dir);
        const before = liveView(f.top);
        const plain = join(dir, 'plain');
        mkdirSync(plain);
        const result = await runner.runPeer({
          repoRoot: f.top, peer: 'codex', promptText: 'x', cwd: plain,
          env: fakeEnv(f, 'vandal', { GIT_DIR: join(f.top, '.git'), GIT_WORK_TREE: f.top }),
        });
        strictEqual(result.snapshot.isolation, 'none');
        strictEqual(JSON.parse(readFileSync(f.record, 'utf8')).gitDir, null);
        const sansLedger = (v) => ({ ...v, status: withoutStateHome(v.status) });
        deepStrictEqual(sansLedger(liveView(f.top)), sansLedger(before));
      });
    });

    it('cancelPeerRun on a running peer: the snapshot is removed when the run ends', async (t) => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const running = runner.runPeer({ repoRoot: f.top, runId: 'cancel-me', peer: 'codex', promptText: 'x', cwd: f.top, env: fakeEnv(f, 'hang') });
        running.catch(() => {}); // judged below
        await waitFor(() => existsSync(f.record), { message: 'the companion to start' });
        const peerPid = JSON.parse(readFileSync(f.record, 'utf8')).pid;
        t.after(() => killGroup(peerPid));
        const handlePath = runner.peerRunPaths(f.top, 'cancel-me').handle;
        await waitFor(async () => (await runner.readHandle(handlePath)).status === 'running', { message: 'the run to be running' });
        const cancelled = await runner.cancelPeerRun({ repoRoot: f.top, runId: 'cancel-me', graceMs: 2000 });
        strictEqual(cancelled.ok, true);
        const result = await within(running, 'the cancelled run to end');
        strictEqual(result.status, 'cancelled');
        ok(result.snapshot.removed_at);
        deepStrictEqual(leftovers(snaps), []);
      });
    });

    it('a child the companion leaves running is stopped before the snapshot is removed', async () => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const result = await runner.runPeer({ repoRoot: f.top, peer: 'codex', promptText: 'x', cwd: f.top, env: fakeEnv(f, 'stubborn'), cancelGraceMs: 300 });
        strictEqual(result.status, 'completed');
        const { grandchild } = JSON.parse(readFileSync(f.record, 'utf8'));
        try {
          await waitFor(() => !alive(grandchild), { timeoutMs: 5000, message: 'the stubborn grandchild to be killed' });
        } finally {
          killGroup(grandchild);
        }
        ok(result.snapshot.removed_at);
        deepStrictEqual(leftovers(snaps), []);
      });
    });

    it('concurrent runs get distinct snapshots, and both are removed', async () => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const run = (id) => runner.runPeer({ repoRoot: f.top, runId: id, peer: 'codex', promptText: 'x', cwd: f.top, env: fakeEnv(f, 'vandal', { FAKE_RECORD: join(dir, `${id}.json`) }) });
        const [a, b] = await Promise.all([run('c-1'), run('c-2')]);
        strictEqual(a.status, 'completed');
        strictEqual(b.status, 'completed');
        notStrictEqual(a.snapshot.root, b.snapshot.root);
        deepStrictEqual(leftovers(snaps), []);
        strictEqual(snapshotWorktrees(f.top).length, 0);
      });
    });

    it('the CLI ends on SIGTERM (repeated) with 143, a cancelled ledger, the peer stopped and the snapshot removed', async () => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const cli = spawn(process.execPath, [PEER_RUNNER, 'run', '--repo-root', f.top, '--run-id', 'sig-1', '--peer', 'codex', '--prompt-text', 'x', '--cwd', f.top, '--cancel-grace-ms', '1000'], {
          env: { ...fakeEnv(f, 'hang'), TMPDIR: snaps }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        const exited = new Promise((r) => cli.once('exit', (code, signal) => r({ code, signal })));
        await waitFor(() => existsSync(f.record), { message: 'the companion to start' });
        const { pid } = JSON.parse(readFileSync(f.record, 'utf8'));
        try {
          cli.kill('SIGTERM');
          cli.kill('SIGTERM');
          deepStrictEqual(await within(exited, 'the CLI to exit'), { code: 143, signal: null });
          ok(!alive(pid), 'the peer is stopped');
        } finally {
          killGroup(pid);
          killGroup(cli.pid);
        }
        const handle = await runner.readHandle(runner.peerRunPaths(f.top, 'sig-1').handle);
        strictEqual(handle.status, 'cancelled');
        ok(handle.snapshot.removed_at);
        deepStrictEqual(leftovers(snaps), []);
      });
    });

    it('a runner killed outright leaves a snapshot its live peer keeps; the next sweep reclaims it once the peer ends', async (t) => {
      await withTmp(async (dir, snaps) => {
        const f = await fixture(dir);
        const cli = spawn(process.execPath, [PEER_RUNNER, 'run', '--repo-root', f.top, '--run-id', 'kill-1', '--peer', 'codex', '--prompt-text', 'x', '--cwd', f.top], {
          env: { ...fakeEnv(f, 'hang'), TMPDIR: snaps }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        await waitFor(() => existsSync(f.record), { message: 'the companion to start' });
        const { pid } = JSON.parse(readFileSync(f.record, 'utf8'));
        t.after(() => killGroup(pid));
        const [snap] = snapshotWorktrees(f.top);
        const owner = snap.locked.slice('peer-snapshot v1 '.length);
        await waitFor(() => JSON.parse(readFileSync(owner, 'utf8')).companion !== null, { message: 'the companion record' });
        cli.kill('SIGKILL');
        await new Promise((r) => cli.once('exit', r));
        let swept = await runner.sweepPeerRuns({ repoRoot: f.top });
        deepStrictEqual(swept.snapshots.kept.map((k) => k.why), ['companion-alive']);
        process.kill(-pid, 'SIGKILL');
        await waitFor(() => !groupAlive(pid), { message: 'the peer group to end' });
        swept = await runner.sweepPeerRuns({ repoRoot: f.top });
        deepStrictEqual(swept.snapshots.reclaimed.map((r) => r.why), ['owners-gone']);
        deepStrictEqual(leftovers(snaps), []);
      });
    });
  });

  describe(`${persona}: runbook guidance for the snapshot (C96, C127)`, () => {
    const protocol = readFileSync(P.path('core/skills/_shared/references/ensemble-protocol.md'), 'utf8').replace(/\s+/g, ' ');
    const peerNow = [readFileSync(P.path('commands/peer-now.md'), 'utf8'), readFileSync(P.path('core/skills/peer-now/SKILL.md'), 'utf8')].map((t) => t.replace(/\s+/g, ' '));

    it('the launch step says the peer reads a snapshot and to name a review base by commit id', () => {
      ok(protocol.includes('A codex peer never works in the checkout: the runner gives it a snapshot of HEAD plus the working tree and the index'));
      ok(protocol.includes('name files repo-relatively and a review base by its commit id'));
    });

    it('the collect step names snapshot_failed, maps snapshot paths back, and keeps pgrep -f from matching its own loop', () => {
      ok(protocol.includes('`snapshot_failed` (no snapshot of the checkout could be made for a codex peer'));
      ok(protocol.includes('A path in the answer under the handle\'s `snapshot.root` names the snapshot the peer read'));
      ok(protocol.includes('Collecting the peer stays notification-only.'));
      ok(protocol.includes("bracket one character (`pgrep -f '[m]utation-harness'`) or wait on a pid file (C127)"));
    });

    it('peer-now says files the peer writes are discarded', () => {
      for (const text of peerNow) ok(text.includes('A codex peer answers from a snapshot of the checkout, removed when the run ends (C96): a file it writes is discarded with it.'));
    });
  });

  describe(`${persona}: dispatch-peer — a codex peer runs in the snapshot (C96)`, () => {
    const DISPATCH = P.path('scripts/dispatch-peer.mjs');
    const fakeEnv = (f, mode) => ({ ...env, AGENTIC_COMPANIONS_ROOT: f.companions, FAKE_COMPANION_MODE: mode, FAKE_RECORD: f.record });

    it('the vandal peer tidies only the snapshot, which is removed when the dispatch ends', async () => {
      await withTmp(async (dir, snaps) => {
        const top = makeDirtyRepo(dir);
        const f = { top, companions: await writeFakeCompanions(dir), record: join(dir, 'record.json') };
        const before = liveView(top);
        const r = spawnSync(process.execPath, [DISPATCH, '--peer', 'codex', '--prompt-text', `look at ${top}/a`, '--cwd', top], {
          env: { ...fakeEnv(f, 'vandal'), TMPDIR: snaps }, encoding: 'utf8',
        });
        strictEqual(r.status, 0, r.stderr);
        deepStrictEqual(liveView(top), before);
        const rec = JSON.parse(readFileSync(f.record, 'utf8'));
        ok(relative(top, rec.cwd).startsWith('..'), `${rec.cwd} is outside the checkout`);
        match(rec.prompt, /^look at \/.+\/tree\/a$/);
        ok(!rec.prompt.includes(`${top}/`));
        deepStrictEqual(leftovers(snaps), []);
        strictEqual(snapshotWorktrees(top).length, 0);
      });
    });

    it('SIGTERM (doctor\'s timeout) stops the peer group, removes the snapshot and exits 143', async () => {
      await withTmp(async (dir, snaps) => {
        const top = makeDirtyRepo(dir);
        const f = { top, companions: await writeFakeCompanions(dir), record: join(dir, 'record.json') };
        const cli = spawn(process.execPath, [DISPATCH, '--peer', 'codex', '--prompt-text', 'x', '--cwd', top], {
          env: { ...fakeEnv(f, 'hang'), TMPDIR: snaps }, stdio: ['ignore', 'pipe', 'pipe'],
        });
        const exited = new Promise((r) => cli.once('exit', (code, signal) => r({ code, signal })));
        await waitFor(() => existsSync(f.record), { message: 'the companion to start' });
        const { pid } = JSON.parse(readFileSync(f.record, 'utf8'));
        try {
          cli.kill('SIGTERM');
          deepStrictEqual(await within(exited, 'the CLI to exit'), { code: 143, signal: null });
          ok(!groupAlive(pid));
        } finally {
          killGroup(pid);
          killGroup(cli.pid);
        }
        deepStrictEqual(leftovers(snaps), []);
        strictEqual(snapshotWorktrees(top).length, 0);
      });
    });

    it('a child holding the companion\'s pipes is stopped once the companion exits, and the dispatch ends', async () => {
      await withTmp(async (dir, snaps) => {
        const top = makeDirtyRepo(dir);
        const f = { top, companions: await writeFakeCompanions(dir), record: join(dir, 'record.json') };
        let grandchild = null;
        try {
          const result = await within(dispatcher.dispatchPeer({ peer: 'codex', promptText: 'x', cwd: top, env: fakeEnv(f, 'leaky'), cancelGraceMs: 300 }), 'the dispatch to end');
          strictEqual(result.ok, true, result.stderr);
          grandchild = JSON.parse(readFileSync(f.record, 'utf8')).grandchild;
          await waitFor(() => !alive(grandchild), { timeoutMs: 5000, message: 'the child to be stopped' });
          deepStrictEqual(leftovers(snaps), []);
        } finally {
          if (grandchild === null && existsSync(f.record)) grandchild = JSON.parse(readFileSync(f.record, 'utf8')).grandchild;
          if (grandchild) killGroup(grandchild);
        }
      });
    });

    it('a cancellation requested after the dispatch ended signals nothing of its peer', async () => {
      await withTmp(async (dir) => {
        const top = makeDirtyRepo(dir);
        const f = { top, companions: await writeFakeCompanions(dir), record: join(dir, 'record.json') };
        const cancellation = identity.createRunCancellation();
        const result = await dispatcher.dispatchPeer({ peer: 'codex', promptText: 'x', cwd: top, env: fakeEnv(f, 'vandal'), cancellation, cancelGraceMs: 200 });
        strictEqual(result.ok, true, result.stderr);
        const { pid } = JSON.parse(readFileSync(f.record, 'utf8'));
        const sent = [];
        const kill = process.kill;
        process.kill = (target, sig) => {
          if (Math.abs(target) === pid) sent.push([target, sig]);
          return kill.call(process, target, sig);
        };
        try {
          cancellation.request('SIGTERM');
          await sleep(500);
        } finally {
          process.kill = kill;
        }
        deepStrictEqual(sent, []);
      });
    });

    it('a codex peer outside any checkout gets no git selector naming the live repository', async () => {
      await withTmp(async (dir) => {
        const top = makeDirtyRepo(dir);
        const f = { top, companions: await writeFakeCompanions(dir), record: join(dir, 'record.json') };
        const before = liveView(top);
        const plain = join(dir, 'plain');
        mkdirSync(plain);
        const result = await dispatcher.dispatchPeer({ peer: 'codex', promptText: 'x', cwd: plain, env: { ...fakeEnv(f, 'vandal'), GIT_DIR: join(top, '.git'), GIT_WORK_TREE: top } });
        strictEqual(result.ok, true, result.stderr);
        strictEqual(JSON.parse(readFileSync(f.record, 'utf8')).gitDir, null);
        deepStrictEqual(liveView(top), before);
      });
    });

    it('a snapshot that cannot be made: companion_error / snapshot_failed, no envelope, no companion', async () => {
      await withTmp(async (dir) => {
        const top = join(dir, 'repo');
        mkdirSync(top);
        writeFileSync(join(top, '.git'), 'gitdir: /nonexistent\n');
        const f = { top, companions: await writeFakeCompanions(dir), record: join(dir, 'record.json') };
        const result = await dispatcher.dispatchPeer({ peer: 'codex', promptText: 'x', cwd: top, env: fakeEnv(f, 'vandal') });
        strictEqual(result.ok, false);
        strictEqual(result.status, 'companion_error');
        strictEqual(result.kind, 'snapshot_failed');
        strictEqual(result.envelope, null);
        strictEqual(result.exitCode, 3);
        ok(!existsSync(f.record));
      });
    });

    it('a repository with no commit yet (runtime doctor\'s proof repo) is dispatched in an orphan snapshot', async () => {
      await withTmp(async (dir, snaps) => {
        const top = join(dir, 'repo');
        mkdirSync(top);
        git(top, 'init', '-q', '-b', 'main');
        writeFileSync(join(top, 'loose'), 'l\n');
        const f = { top, companions: await writeFakeCompanions(dir), record: join(dir, 'record.json') };
        const result = await dispatcher.dispatchPeer({ peer: 'codex', promptText: 'x', cwd: top, env: fakeEnv(f, 'vandal') });
        strictEqual(result.ok, true, result.stderr);
        ok(existsSync(join(top, 'loose')), 'the untracked file the peer cleaned is still in the live tree');
        ok(relative(realpathSync(top), JSON.parse(readFileSync(f.record, 'utf8')).cwd).startsWith('..'));
        deepStrictEqual(leftovers(snaps), []);
        strictEqual(git(top, 'for-each-ref'), '');
      });
    });
  });
}
