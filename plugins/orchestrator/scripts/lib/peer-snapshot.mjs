// COPIED from persona-pipeline — do not edit this copy.
// Source: persona-pipeline/files/scripts/lib/peer-snapshot.mjs, byte for byte below these
// three lines; tests/scripts/test-orchestrator-peer-snapshot-parity.mjs checks it.
// scripts/lib/peer-snapshot.mjs
//
// C96 — a codex peer runs in a snapshot of the checkout, never in the checkout
// itself. Measured: a peer asked only to read a diff tidied the working tree it
// was pointed at (`checkout -- .`, `clean`), reverting the caller's uncommitted
// edits and deleting its untracked files. The snapshot is a detached worktree
// of HEAD holding the working tree's content and the index's staging, made
// from temporary index files, so the live index and working tree are only
// read; the peer is given the snapshot as its directory and the snapshot is
// removed when the run ends. ADR-0023, amendment of 2026-10-13, has the
// contract and its limits. Generated from persona-pipeline/ (ADR-0066).
//
//   createPeerSnapshot   capture HEAD, the index and the working tree, and
//                        materialize them in a locked worktree outside the
//                        checkout, with an owner record beside it
//   removePeerSnapshot   remove the worktree, its registration and its
//                        directory, the owner record last
//   reclaimPeerSnapshots remove the snapshots of this repository whose owner
//                        processes are gone (a supervisor that died before
//                        its cleanup), never one a live process may be using
//   snapshotEnded        whether the run that made a snapshot is proven over
//                        (C142: the judgment a cancel or a settle that finds
//                        a host-killed run needs before it finishes the run
//                        and removes its snapshot, removeOwnedSnapshot)
//   captureWorkingTree   the same capture of the working tree, written as a
//                        tree object and nothing materialized (C120: the
//                        tree a document review is held to)
//
// Every git call runs with the caller's git selectors removed (GIT_DIR,
// GIT_WORK_TREE, GIT_INDEX_FILE, …): one left in the environment would point
// the capture, or the peer, back at the live tree.

import { spawn } from 'node:child_process';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { allProcessCwds, fingerprintForPid, groupMemberCwds, identityState, isGroupAlive, processLineage, stopProcessGroup } from './process-identity.mjs';

export const SNAPSHOT_LOCK_PREFIX = 'peer-snapshot v1 ';
export const SNAPSHOT_OWNER_FILE = 'owner.json';
export const SNAPSHOT_OWNER_SCHEMA = 'peer-snapshot-owner-1';
export const SNAPSHOT_TREE_DIR = 'tree';
// An owner record that cannot be judged (unreadable, or a process whose
// identity cannot be told) is reclaimed only once it is this old.
export const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_DIR_MARK = '-peer-snapshot-';
// The largest pid a process can have (pid_t is a signed 32-bit integer): a
// recorded pid past it names no process, and would read as one gone.
const PID_MAX = 2 ** 31 - 1;
// A pid a run's process can have: past init's (1, whose group `kill(-1)` would
// read as every process) and within PID_MAX.
const isRunPid = (n) => Number.isInteger(n) && n > 1 && n <= PID_MAX;
// How long an aborted git call's process group gets after SIGTERM.
const ABORT_GRACE_MS = 2000;
// The characters XML escapes, which no snapshot root carries.
const XML_SPECIAL = /[&<>"']/;

// C142 — the listing of every process a judgment reads when its caller passes
// none: the system's (allProcessCwds, for the run whose `clock` the judgment
// names), or the one a function installed on `globalThis` under this symbol
// gives, handed the system's to read from. Only code loaded into this process
// installs one: a test preloads a module that does (`node --import`) into the
// runner it starts, so that no result of its depends on what else runs on the
// machine. Nothing here reads the environment for it.
export const LISTING_HOOK = Symbol.for('agentic-plugins.peer-snapshot.list-processes');
function listProcessesHere(options = {}) {
  const hook = globalThis[LISTING_HOOK];
  return typeof hook === 'function' ? hook(() => allProcessCwds(options)) : allProcessCwds(options);
}

// The state homes a snapshot never carries: a copy of them in another
// worktree of the repository would read, to the ADR-0067 write guard, as a
// second copy of each record.
export const SNAPSHOT_EXCLUDED_PATHSPECS = ['.agentic-plugins/state', ':(glob).claude/agentic-*/**'];

// The variables that select a repository, worktree or index for git. Removed
// from every git call here and from the companion's environment.
export const GIT_SELECTOR_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
  'GIT_CEILING_DIRECTORIES',
];

export class SnapshotError extends Error {
  constructor(reason, message) {
    super(message ?? reason);
    this.reason = reason;
  }
}

export function scrubGitSelectors(env = process.env) {
  const out = { ...env };
  for (const name of GIT_SELECTOR_VARS) delete out[name];
  return out;
}

function gitEnv(env) {
  return { ...scrubGitSelectors(env), LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
}

// A call `signal` can stop runs in a process group of its own, and an abort
// stops that whole group: a clean or smudge filter is git's child, and
// stopping git alone would leave the filter running. The call settles on
// 'close' and, after an abort, once the group is gone too: a descendant that
// ignores SIGTERM and holds no pipe outlives 'close', and a caller that exits
// on the settled call would take the SIGKILL still due to it with it.
function runProcess(cmd, args, { env, input, signal } = {}) {
  return new Promise((resolveP) => {
    const detached = Boolean(signal) && process.platform !== 'win32';
    let child;
    try {
      child = spawn(cmd, args, { env, stdio: ['pipe', 'pipe', 'pipe'], detached });
    } catch (error) {
      resolveP({ code: null, stdout: '', stderr: String(error?.message ?? error), error });
      return;
    }
    let stopped = null;
    const stop = () => {
      if (detached && Number.isInteger(child.pid)) stopped = stopProcessGroup(child.pid, ABORT_GRACE_MS);
      else child.kill('SIGTERM');
    };
    if (signal?.aborted) stop();
    else signal?.addEventListener('abort', stop, { once: true });
    const out = [];
    const err = [];
    let spawnError = null;
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    // A failed spawn emits 'error', then 'close'.
    child.once('error', (error) => { spawnError = error; });
    child.once('close', async (code) => {
      signal?.removeEventListener('abort', stop);
      await stopped;
      resolveP(spawnError
        ? { code: null, stdout: '', stderr: String(spawnError?.message ?? spawnError), error: spawnError }
        : { code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input ?? '');
  });
}

// git in `dir`, hooks and fsmonitor off; `indexFile` sets the index it uses.
// `signal` (an AbortSignal) stops it: a cancellation reaches a capture that a
// slow filter or a huge tree keeps running.
async function git(dir, args, { env, indexFile, input, signal } = {}) {
  const cancelled = () => new SnapshotError('cancelled', 'the snapshot was cancelled');
  if (signal?.aborted) throw cancelled();
  const e = gitEnv(env);
  if (indexFile) e.GIT_INDEX_FILE = indexFile;
  const r = await runProcess('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', dir, ...args], { env: e, input, signal });
  if (signal?.aborted) throw cancelled();
  return r;
}

async function gitOk(dir, args, reason, options) {
  const r = await git(dir, args, options);
  if (r.code !== 0) {
    throw new SnapshotError(reason, `git ${args[0]} failed (${reason}): ${(r.stderr || r.stdout).trim().split('\n')[0] || `exit ${r.code}`}`);
  }
  return r.stdout;
}

function isWithinOrEqual(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

// Whether `dir` or an ancestor has a `.git` entry. Without one the directory
// is no checkout and the peer runs there as before (isolation: none); with
// one, any git failure fails the snapshot.
function hasGitAncestor(dir) {
  for (let d = dir; ; d = dirname(d)) {
    try {
      lstatSync(join(d, '.git'));
      return true;
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') return true;
    }
    if (dirname(d) === d) return false;
  }
}

function realDir(dir) {
  try {
    return realpathSync(dir);
  } catch (error) {
    throw new SnapshotError('cwd-unreadable', `the peer directory ${dir} cannot be resolved (${error?.code || error?.message})`);
  }
}

// The live toplevel `cwd` belongs to and its repository's common git
// directory (one for every worktree of it), or null when it is no checkout.
async function liveToplevel(cwd, env) {
  const real = realDir(resolve(cwd));
  if (!hasGitAncestor(real)) return null;
  const top = (await gitOk(real, ['rev-parse', '--show-toplevel'], 'git-discovery', { env })).trim();
  if (!top) throw new SnapshotError('git-discovery', `${real} has a .git entry but no worktree toplevel`);
  const common = (await gitOk(top, ['rev-parse', '--git-common-dir'], 'git-discovery', { env })).trim();
  return { top: realpathSync(top), cwd: real, commonDir: realpathSync(resolve(top, common)) };
}

async function readHead(top, env, signal) {
  const r = await git(top, ['rev-parse', '--verify', '-q', 'HEAD^{commit}'], { env, signal });
  if (r.code === 0 && r.stdout.trim()) return { head: r.stdout.trim(), unborn: false };
  const sym = await git(top, ['symbolic-ref', '-q', 'HEAD'], { env, signal });
  if (sym.code === 0) return { head: null, unborn: true };
  throw new SnapshotError('head-unreadable', `HEAD of ${top} names no commit and no branch`);
}

function nulFields(text) {
  return text.split('\0').filter((f) => f.length > 0);
}

// One capture: HEAD, the index (I: what is staged) and the working tree (W:
// the index with every working-tree change added, .gitignore respected, the
// state homes removed), each from a copy of the live index.
async function capture(top, parent, env, signal, beforeRecheck) {
  const headBefore = await readHead(top, env, signal);
  const liveIndex = resolve(top, (await gitOk(top, ['rev-parse', '--git-path', 'index'], 'git-discovery', { env, signal })).trim());
  const staged = join(parent, 'index.staged');
  const worktree = join(parent, 'index.worktree');
  await rm(staged, { force: true });
  await rm(worktree, { force: true });
  let liveIndexPresent = true;
  try {
    await copyFile(liveIndex, staged);
  } catch (error) {
    // No index: a checkout whose index was deleted, where every tracked file
    // reads as a staged deletion; the snapshot keeps that meaning.
    if (error?.code !== 'ENOENT') throw new SnapshotError('index-unreadable', `cannot copy ${liveIndex} (${error?.code || error?.message})`);
    liveIndexPresent = false;
  }
  if (liveIndexPresent) {
    // The copies keep the live index's timestamps: git trusts an entry whose
    // stat matches unless the file is not older than the index (racy git), so
    // a copy stamped now would hide a same-size edit made in the second the
    // live index was written (C120, found by its fixtures).
    try {
      const { atime, mtime } = await stat(liveIndex);
      await utimes(staged, atime, mtime);
    } catch (error) {
      throw new SnapshotError('index-unreadable', `cannot stamp the copy of ${liveIndex} (${error?.code || error?.message})`);
    }
    await copyFile(staged, worktree);
    const { atime, mtime } = await stat(staged);
    await utimes(worktree, atime, mtime);
  }

  const unmerged = await gitOk(top, ['ls-files', '-u', '-z'], 'index-unreadable', { env, signal, indexFile: staged });
  if (unmerged.length > 0) throw new SnapshotError('unmerged-index', `${top} has unmerged paths: resolve the merge before asking a peer`);
  const indexTree = (await gitOk(top, ['write-tree'], 'index-unreadable', { env, signal, indexFile: staged })).trim();

  // Intent-to-add entries (`.A` in porcelain v2) are not in a written tree;
  // they are replayed in the snapshot's index. So are the assume-unchanged and
  // skip-worktree flags (`ls-files -v`: a lower-case tag, `S`).
  const intentToAdd = [];
  const status = await gitOk(top, ['status', '--porcelain=v2', '-z', '--untracked-files=no', '--ignore-submodules=all'], 'index-unreadable', { env, signal, indexFile: staged });
  const records = status.split('\0');
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (rec.startsWith('2 ')) {
      i += 1; // a rename record carries its source path in the next field
      continue;
    }
    if (!rec.startsWith('1 ')) continue;
    const parts = rec.split(' ');
    if (parts[1] === '.A') intentToAdd.push(parts.slice(8).join(' '));
  }
  const assumeUnchanged = [];
  const skipWorktree = [];
  for (const field of nulFields(await gitOk(top, ['ls-files', '-v', '-z'], 'index-unreadable', { env, signal, indexFile: staged }))) {
    const tag = field[0];
    const path = field.slice(2);
    if (tag === 'S' || tag === 's') skipWorktree.push(path);
    if (tag !== 'S' && tag >= 'a' && tag <= 'z') assumeUnchanged.push(path);
  }

  await gitOk(top, ['add', '-A'], 'worktree-unreadable', { env, signal, indexFile: worktree });
  await gitOk(top, ['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', ...SNAPSHOT_EXCLUDED_PATHSPECS], 'worktree-unreadable', { env, signal, indexFile: worktree });
  const worktreeTree = (await gitOk(top, ['write-tree'], 'worktree-unreadable', { env, signal, indexFile: worktree })).trim();

  if (beforeRecheck) await beforeRecheck();
  const headAfter = await readHead(top, env, signal);
  const moved = headAfter.head !== headBefore.head || headAfter.unborn !== headBefore.unborn;
  return { ...headBefore, moved, indexTree, worktreeTree, intentToAdd, assumeUnchanged, skipWorktree, staged, worktree };
}

// C120 — the working tree of the checkout `cwd` belongs to, as the tree
// object a snapshot would hold (`worktreeTree`: .gitignore respected, the
// state homes removed), with HEAD; nothing is materialized and the temporary
// index files are removed. Null when `cwd` is no checkout. The capture is
// taken again when HEAD moves during it, and refused when it moves twice.
// `flagged` lists the index entries marked assume-unchanged or skip-worktree:
// `git add -A` keeps their staged blob, so an edit to such a file is not in
// `tree`, and a caller that vouches for the working tree refuses it.
export async function captureWorkingTree({ cwd, env = process.env, signal = null, hooks = {} } = {}) {
  const live = await liveToplevel(cwd, env);
  if (live === null) return null;
  const { top } = live;
  const parent = await mkdtemp(join(snapshotBase(top), 'review-capture-'));
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const snap = await capture(top, parent, env, signal, hooks.afterCapture ? () => hooks.afterCapture(attempt) : null);
      if (!snap.moved) return { top, head: snap.head, unborn: snap.unborn, tree: snap.worktreeTree, flagged: [...new Set([...snap.assumeUnchanged, ...snap.skipWorktree])].sort() };
    }
    throw new SnapshotError('head-moved', `HEAD of ${top} moved during the capture, twice`);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

// The supervisor's fingerprint with what places it among the processes
// (processLineage): its `starttime` (on Linux the fingerprint's own), the
// `clock` it was read in and its `ancestors`, by which treeOccupancy places a
// process the listing did not read. A lineage that cannot be read adds
// nothing, and a fingerprint of none adds none.
export async function supervisorFingerprint(pid) {
  const fingerprint = await fingerprintForPid(pid);
  if (fingerprint.kind === 'none') return fingerprint;
  const lineage = await processLineage(pid);
  if (lineage === null) return fingerprint;
  const starttime = fingerprint.kind === 'linux_proc_starttime' ? fingerprint.starttime : lineage.starttime;
  return { ...fingerprint, starttime, clock: lineage.clock, ancestors: lineage.ancestors };
}

function snapshotBase(top) {
  const candidates = [];
  try {
    candidates.push(realpathSync.native(tmpdir()));
  } catch {
    /* an unresolvable TMPDIR is skipped */
  }
  try {
    candidates.push(realpathSync.native('/tmp'));
  } catch {
    /* no /tmp */
  }
  // A root an XML prompt would have to escape is skipped too: the prompt's
  // rewritten paths then read the same in text, in an attribute and raw.
  const base = candidates.find((c) => !isWithinOrEqual(c, top) && !XML_SPECIAL.test(c));
  if (!base) throw new SnapshotError('no-snapshot-tmpdir', `no temporary directory outside ${top}, and free of ${XML_SPECIAL.source}, to hold the snapshot`);
  return base;
}

async function writeJsonAtomic(path, value) {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, path);
}

// `signal` (an AbortSignal) cancels the capture and the materialize: the
// git process running is stopped, what was made is removed, and the call
// throws SnapshotError 'cancelled'.
// Test seam: `hooks.afterCapture(attempt)` runs after a capture has read
// the index and the working tree and before it reads HEAD again, so a test
// can move HEAD in between.
export async function createPeerSnapshot({
  cwd,
  runId = null,
  persona = 'persona',
  env = process.env,
  supervisorPid = process.pid,
  signal = null,
  hooks = {},
} = {}) {
  const live = await liveToplevel(cwd, env);
  if (live === null) return { isolation: 'none', reason: 'not-a-checkout' };
  const { top } = live;
  const base = snapshotBase(top);
  const parent = await mkdtemp(join(base, `${persona}${SNAPSHOT_DIR_MARK}`));
  const ownerPath = join(parent, SNAPSHOT_OWNER_FILE);
  const tree = join(parent, SNAPSHOT_TREE_DIR);
  const branch = `peer-snapshot/${basename(parent)}`;
  let createdBranch = null;
  try {
    const owner = {
      schema: SNAPSHOT_OWNER_SCHEMA,
      run_id: runId,
      persona,
      live_toplevel: top,
      common_dir: live.commonDir,
      tree,
      branch: null,
      supervisor: { pid: supervisorPid, fingerprint: await supervisorFingerprint(supervisorPid) },
      companion: null,
      created_at: new Date().toISOString(),
    };
    await writeJsonAtomic(ownerPath, owner);

    let snap = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      snap = await capture(top, parent, env, signal, hooks.afterCapture ? () => hooks.afterCapture(attempt) : null);
      if (!snap.moved) break;
      snap = null;
    }
    if (snap === null) throw new SnapshotError('head-moved', `HEAD of ${top} moved during the capture, twice`);

    if (snap.unborn) {
      owner.branch = branch;
      await writeJsonAtomic(ownerPath, owner);
    }
    const reason = `${SNAPSHOT_LOCK_PREFIX}${ownerPath}`;
    const add = snap.unborn
      ? ['worktree', 'add', '--orphan', '-b', branch, '--lock', '--reason', reason, tree]
      : ['worktree', 'add', '--detach', '--no-checkout', '--lock', '--reason', reason, tree, snap.head];
    if (snap.unborn) createdBranch = branch;
    const added = await git(top, add, { env, signal });
    if (added.code !== 0) {
      const why = (added.stderr || added.stdout).trim().split('\n')[0];
      throw new SnapshotError(snap.unborn ? 'unborn-head-needs-git-2.42' : 'worktree-add-failed', `git worktree add failed: ${why}`);
    }
    await gitOk(tree, ['read-tree', '-u', '--reset', snap.worktreeTree], 'materialize-failed', { env, signal });
    await gitOk(tree, ['read-tree', snap.indexTree], 'materialize-failed', { env, signal });
    if (snap.intentToAdd.length > 0) {
      await gitOk(tree, ['add', '-N', '--pathspec-from-file=-', '--pathspec-file-nul'], 'materialize-failed', { env, signal, input: `${snap.intentToAdd.join('\0')}\0` });
    }
    if (snap.assumeUnchanged.length > 0) {
      await gitOk(tree, ['update-index', '--assume-unchanged', '-z', '--stdin'], 'materialize-failed', { env, signal, input: `${snap.assumeUnchanged.join('\0')}\0` });
    }
    if (snap.skipWorktree.length > 0) {
      await gitOk(tree, ['update-index', '--skip-worktree', '-z', '--stdin'], 'materialize-failed', { env, signal, input: `${snap.skipWorktree.join('\0')}\0` });
    }
    await rm(snap.staged, { force: true });
    await rm(snap.worktree, { force: true });

    const peerCwd = join(tree, relative(top, live.cwd));
    await mkdir(peerCwd, { recursive: true });
    return {
      isolation: 'snapshot',
      reason: null,
      live_toplevel: top,
      root: tree,
      parent,
      peer_cwd: peerCwd,
      owner_path: ownerPath,
      branch: snap.unborn ? branch : null,
      head: snap.head,
      index_tree: snap.indexTree,
      worktree_tree: snap.worktreeTree,
      supervisor: owner.supervisor,
    };
  } catch (error) {
    await removePeerSnapshot({ live_toplevel: top, root: tree, parent, branch: createdBranch }, { env, signal }).catch(() => {});
    if (error instanceof SnapshotError) throw error;
    throw new SnapshotError('snapshot-error', String(error?.message ?? error));
  }
}

// Mark, before the companion is spawned, that it may be running: from here
// until recordSnapshotCompanion names it, a dead supervisor is no proof that
// nothing runs in the snapshot.
export async function recordSnapshotLaunch(snapshot) {
  if (!snapshot?.owner_path) return;
  const owner = JSON.parse(await readFile(snapshot.owner_path, 'utf8'));
  owner.launched_at = new Date().toISOString();
  await writeJsonAtomic(snapshot.owner_path, owner);
}

// Record the companion's process (its pid, group and fingerprint) in the
// owner record, so a later run tells a live peer from a dead one.
export async function recordSnapshotCompanion(snapshot, { pid, pgid, fingerprint }) {
  if (!snapshot?.owner_path) return;
  const owner = JSON.parse(await readFile(snapshot.owner_path, 'utf8'));
  owner.companion = { pid, pgid: pgid ?? null, fingerprint: fingerprint ?? { kind: 'none' } };
  await writeJsonAtomic(snapshot.owner_path, owner);
}

// The handle's `snapshot` field: what was isolated, where, and from what.
// `supervisor` is the owner record's (the run that made the snapshot, its pid
// and fingerprint), kept on the handle so that a run whose snapshot a reclaim
// removed can still be judged by it (C142).
export function peerSnapshotRecord(snapshot, extra = {}) {
  if (!snapshot) return null;
  return {
    isolation: snapshot.isolation,
    reason: snapshot.reason ?? null,
    root: snapshot.root ?? null,
    peer_cwd: snapshot.peer_cwd ?? null,
    head: snapshot.head ?? null,
    index_tree: snapshot.index_tree ?? null,
    worktree_tree: snapshot.worktree_tree ?? null,
    owner_path: snapshot.owner_path ?? null,
    supervisor: snapshot.supervisor ?? null,
    removed_at: null,
    cleanup_error: null,
    prompt_paths_rewritten: 0,
    ...extra,
  };
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// A path as an XML prompt carries it: in text (`&`, `<`, `>` escaped, as the
// persona's prompt builder escapes) and in an attribute (`"` too).
const xmlText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const xmlAttr = (s) => xmlText(s).replace(/"/g, '&quot;');

// Rewrite every occurrence of the live toplevel, in any of its spellings and
// as XML escapes it, at a path boundary (`/repo` and `/repo/x`, never
// `/repo-other` or `/x/repo`) to the snapshot root, so an absolute path in the
// prompt names the snapshot's copy of the file and never sends the peer back
// to the live tree. Every spelling gets the root as it is: a snapshot root
// carries no character XML escapes (snapshotBase), so it reads the same in
// text, in an attribute and raw.
export function rewritePromptPaths(text, spellings, root) {
  const replacements = new Map();
  for (const s of spellings) {
    if (typeof s !== 'string') continue;
    const spelled = s.replace(/\/+$/, '');
    if (spelled.length <= 1) continue;
    replacements.set(spelled, root);
  }
  for (const spelled of [...replacements.keys()]) {
    for (const escaped of [xmlText(spelled), xmlAttr(spelled)]) {
      if (!replacements.has(escaped)) replacements.set(escaped, root);
    }
  }
  const unique = [...replacements.keys()].sort((a, b) => b.length - a.length);
  if (unique.length === 0) return { text, count: 0 };
  const pattern = new RegExp(`(?<![A-Za-z0-9._~-])(?:${unique.map(escapeRegExp).join('|')})(?![A-Za-z0-9._~-])`, 'g');
  let count = 0;
  const out = text.replace(pattern, (found) => {
    count += 1;
    return replacements.get(found);
  });
  return { text: out, count };
}

// The spellings of the live toplevel a caller may have written: its real
// path, and the toplevel as spelled in the caller's own directory names (a
// symlinked prefix such as macOS /tmp → /private/tmp).
export function toplevelSpellings(snapshot, callerPaths = []) {
  const top = snapshot.live_toplevel;
  const out = [top];
  for (const p of callerPaths) {
    if (typeof p !== 'string' || p.length === 0) continue;
    const spelled = resolve(p);
    let real;
    try {
      real = realpathSync(spelled);
    } catch {
      continue;
    }
    if (!isWithinOrEqual(real, top)) continue;
    const rel = relative(top, real);
    if (rel === '') {
      out.push(spelled);
    } else if (spelled.endsWith(`${sep}${rel}`)) {
      out.push(spelled.slice(0, spelled.length - rel.length - 1));
    }
  }
  return out;
}

// Write the companion's private copy of the prompt beside the snapshot, its
// live-toplevel paths rewritten. Returns the copy's path and the count.
export async function writeSnapshotPrompt(snapshot, text, callerPaths = []) {
  const { text: rewritten, count } = rewritePromptPaths(text, toplevelSpellings(snapshot, callerPaths), snapshot.root);
  const path = join(snapshot.parent, 'prompt.xml');
  await writeFile(path, rewritten, { mode: 0o600 });
  return { path, count };
}

// Remove a snapshot: its worktree and registration (`worktree remove -f -f`
// works on a locked worktree and on one whose directory is gone), the orphan
// branch an unborn HEAD's snapshot may have got a commit on, then its
// directory, the owner record last, and only once all else is gone. Returns
// { removed, error }.
export async function removePeerSnapshot(snapshot, { env = process.env } = {}) {
  const { live_toplevel: top, root: tree, parent } = snapshot;
  const errors = [];
  if (top && tree) {
    let admin = null;
    try {
      const m = /^gitdir:\s*(.+)$/m.exec(await readFile(join(tree, '.git'), 'utf8'));
      if (m) admin = resolve(tree, m[1].trim());
    } catch {
      /* no tree, or no .git in it */
    }
    let r = await git(top, ['worktree', 'remove', '-f', '-f', tree], { env });
    if (r.code !== 0 && !/is not a working tree/.test(r.stderr)) {
      // A directory git would not remove: emptied first, then the
      // registration of the missing directory; failing that, that one
      // registration is deleted (what `worktree prune` does for it).
      await rm(tree, { recursive: true, force: true }).catch(() => {});
      r = await git(top, ['worktree', 'remove', '-f', '-f', tree], { env });
      if (r.code !== 0 && !/is not a working tree/.test(r.stderr)) {
        if (admin && await adminNames(admin, tree)) {
          await rm(admin, { recursive: true, force: true }).catch((e) => errors.push(`registration ${admin}: ${e?.code || e?.message}`));
        } else {
          errors.push(`git worktree remove: ${(r.stderr || r.stdout).trim().split('\n')[0]}`);
        }
      }
    }
  }
  // The branch goes whether or not a worktree was made: an interrupted
  // creation's record may name one. Deleting a ref that is absent succeeds.
  if (top && snapshot.branch) {
    const del = await git(top, ['update-ref', '-d', `refs/heads/${snapshot.branch}`], { env });
    if (del.code !== 0) errors.push(`branch ${snapshot.branch}: ${(del.stderr || del.stdout).trim().split('\n')[0] || `exit ${del.code}`}`);
  }
  if (parent) {
    try {
      for (const entry of await readdir(parent)) {
        if (entry === SNAPSHOT_OWNER_FILE) continue;
        await rm(join(parent, entry), { recursive: true, force: true });
      }
      // What could not be removed keeps its owner record, so a later reclaim
      // finds the snapshot again and retries.
      if (errors.length > 0) return { removed: false, error: errors.join('; ') };
      await rm(join(parent, SNAPSHOT_OWNER_FILE), { force: true });
      await rm(parent, { recursive: true, force: true });
    } catch (error) {
      if (error?.code !== 'ENOENT') errors.push(`${parent}: ${error?.code || error?.message}`);
    }
  }
  return { removed: errors.length === 0, error: errors.length ? errors.join('; ') : null };
}

async function adminNames(admin, tree) {
  try {
    const gitdir = (await readFile(join(admin, 'gitdir'), 'utf8')).trim();
    return resolve(dirname(gitdir)) === resolve(tree);
  } catch {
    return false;
  }
}

function parseWorktreeList(text) {
  const out = [];
  let cur = null;
  for (const field of text.split('\0')) {
    if (field === '') {
      if (cur) out.push(cur);
      cur = null;
      continue;
    }
    if (field.startsWith('worktree ')) {
      if (cur) out.push(cur);
      cur = { worktree: field.slice('worktree '.length), locked: null };
    } else if (cur && field === 'locked') {
      cur.locked = '';
    } else if (cur && field.startsWith('locked ')) {
      cur.locked = field.slice('locked '.length);
    }
  }
  if (cur) out.push(cur);
  return out;
}

// The owner record path a worktree's lock reason names, when the worktree is
// a peer snapshot: `<parent>/tree` locked with `peer-snapshot v1
// <parent>/owner.json`. Anything else is not a snapshot.
export function snapshotOwnerPathOf(worktree, lockReason) {
  if (typeof lockReason !== 'string' || !lockReason.startsWith(SNAPSHOT_LOCK_PREFIX)) return null;
  const ownerPath = lockReason.slice(SNAPSHOT_LOCK_PREFIX.length);
  if (basename(worktree) !== SNAPSHOT_TREE_DIR || basename(ownerPath) !== SNAPSHOT_OWNER_FILE) return null;
  if (!basename(dirname(ownerPath)).includes(SNAPSHOT_DIR_MARK)) return null;
  const same = (a, b) => {
    if (a === b) return true;
    try {
      return realpathSync(a) === realpathSync(b);
    } catch {
      return false;
    }
  };
  return same(dirname(worktree), dirname(ownerPath)) ? ownerPath : null;
}

// Whether a lock reason marks a peer snapshot (the state-root scans skip
// those worktrees).
export function isSnapshotLockReason(reason) {
  return typeof reason === 'string' && reason.startsWith(SNAPSHOT_LOCK_PREFIX);
}

async function readOwner(ownerPath) {
  try {
    const owner = JSON.parse(await readFile(ownerPath, 'utf8'));
    return owner?.schema === SNAPSHOT_OWNER_SCHEMA ? owner : null;
  } catch {
    return null;
  }
}

// A snapshot's owner record, or null when it cannot be read as one.
export async function readSnapshotOwner(ownerPath) {
  return readOwner(ownerPath);
}

// A live group blocks the reclaim however old the record: the companion may
// have exited and left a child running in the snapshot. Its group id is the
// companion's pid, which the system gives no new process while the group
// lives, so a live group under a pid no process has is the companion's, and
// one under a pid whose process cannot be told may be. Only under a pid
// another process now has may it be that process's own group: told apart by
// age alone. `identity` is the companion's own identityState, which the state
// came from, read in the pid namespace `clock`, the supervisor's, names.
async function companionStates(companion, clock) {
  if (!companion) return { state: null, identity: null };
  const identity = await identityState({ pid: companion.pid, fingerprint: companion.fingerprint }, { clock: typeof clock === 'string' ? clock : null });
  if (identity === 'match') return { state: 'alive', identity };
  const group = isGroupAlive(companion.pgid);
  if (group && identity !== 'differ') return { state: 'alive', identity };
  if (group || identity === 'unknown') return { state: 'unknown', identity };
  return { state: 'gone', identity };
}

async function companionState(companion, clock) {
  return (await companionStates(companion, clock)).state;
}

// Whether a snapshot may be reclaimed: 'reclaim', or 'keep' with why.
// Its supervisor (the run that made it) and its companion (the peer's
// process group) must both be gone; a process whose identity cannot be told,
// or a companion launched and never recorded, keeps the snapshot until the
// record is SNAPSHOT_TTL_MS old, and so does a process running in its `tree`
// (the snapshot's own, found apart from the record; treeOccupancy) once both
// are gone (C142).
export async function judgeSnapshot(owner, { now = Date.now(), ttlMs = SNAPSHOT_TTL_MS, recordedAtMs = null, tree = null, listProcesses = listProcessesHere } = {}) {
  const old = (atMs) => Number.isFinite(atMs) && now - atMs > ttlMs;
  if (owner === null) return old(recordedAtMs) ? { verdict: 'reclaim', why: 'owner-unreadable-expired' } : { verdict: 'keep', why: 'owner-unreadable' };
  const supervisor = await identityState(owner.supervisor);
  const companion = await companionState(owner.companion, owner.supervisor?.fingerprint?.clock);
  if (supervisor === 'match') return { verdict: 'keep', why: 'supervisor-alive' };
  if (companion === 'alive') return { verdict: 'keep', why: 'companion-alive' };
  // A launch whose companion was never recorded: the peer may be running
  // unnamed, so the snapshot is judged like an identity that cannot be told.
  const unnamedLaunch = companion === null && typeof owner.launched_at === 'string';
  if (supervisor === 'unknown' || companion === 'unknown' || unnamedLaunch) {
    return old(Date.parse(owner.created_at)) ? { verdict: 'reclaim', why: 'identity-unknown-expired' } : { verdict: 'keep', why: 'identity-unknown' };
  }
  const occupancy = await treeOccupancy(tree ?? owner.tree, { supervisor: owner.supervisor, listProcesses });
  if (occupancy !== 'none') return old(Date.parse(owner.created_at)) ? { verdict: 'reclaim', why: `tree-${occupancy}-expired` } : { verdict: 'keep', why: `tree-${occupancy}` };
  return { verdict: 'reclaim', why: companion === null ? 'supervisor-gone-companion-unrecorded' : 'owners-gone' };
}

// C142 — the companion's process a run's handle names, read once for every
// judgment and every signal: { pid, pgid } (pgid null when the companion led
// no group of its own), null when the handle names none, or { malformed: true }.
// The process is its `peer_process`, which the runner records once the peer
// runs and no later write clears; on a handle written before it existed (or
// one whose record names no process), its `pid` and `pgid`, which the run's
// end, a cancel and an orphan write clear. The runner writes both the same, a
// pid in a run's range and the group it leads (none on Windows, where the
// companion leads no group of its own), and writes `peer_process` only with
// its pid, so a field present that is anything else, a `peer_process` naming
// no pid, or `pid`/`pgid` that disagree with `peer_process`, is a handle the
// runner did not write: it proves nothing, and is never read as one naming
// no process.
export function handlePeerProcess(handle) {
  if (handle === null || typeof handle !== 'object') return null;
  const groupless = process.platform === 'win32';
  const read = (pid, pgid) => {
    if ((pid ?? null) === null && (pgid ?? null) === null) return null;
    if (!isRunPid(pid)) return { malformed: true };
    if ((pgid ?? null) === null ? !groupless : pgid !== pid) return { malformed: true };
    return { pid, pgid: pgid ?? null };
  };
  const live = read(handle.pid, handle.pgid);
  if ((handle.peer_process ?? null) === null) return live;
  const record = handle.peer_process;
  const kept = typeof record === 'object' && !Array.isArray(record) ? read(record.pid, record.pgid) ?? { malformed: true } : { malformed: true };
  if (kept.malformed || live?.malformed) return { malformed: true };
  if (live !== null && (live.pid !== kept.pid || live.pgid !== kept.pgid)) return { malformed: true };
  return kept;
}

// C142 — the supervisor a run's handle keeps, read once for every judgment
// (handlePeerProcess's rule): { pid, fingerprint }, the owner record's, which
// the runner copies onto the handle's snapshot record when it makes the
// snapshot; null on a handle an earlier runner wrote, which keeps neither a
// supervisor nor a `peer_process`; else { malformed: true }. The runner writes
// the key on every snapshot record, with a pid in a run's range and the
// fingerprint it took, so a key it holds that is anything else, or one absent
// beside a `peer_process` (which only this runner writes), is a handle the
// runner did not write, and is never read as an earlier runner's.
export function handleSupervisor(handle) {
  const rec = handle?.snapshot;
  if (rec === null || typeof rec !== 'object') return null;
  if (!Object.hasOwn(rec, 'supervisor') && (handle.peer_process ?? null) === null) return null;
  const { supervisor } = rec;
  const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isRecord(supervisor) || !isRunPid(supervisor.pid) || !isRecord(supervisor.fingerprint)) return { malformed: true };
  return { pid: supervisor.pid, fingerprint: supervisor.fingerprint };
}

// Whether two supervisor records name one process: its pid and the
// fingerprint taken once, which the runner copies from one record to the other.
const sameSupervisor = (a, b) => a?.pid === b.pid && JSON.stringify(a?.fingerprint) === JSON.stringify(b.fingerprint);

// C142 — whether the group `pgid` is a run's apart from its id, which the
// system may have given another process's group once the run's ended: 'tied'
// when a process of it runs in the run's snapshot `tree` (the companion starts
// there, and what it starts inherits it), 'untied' when none does (none could
// be read, or the group has ended), 'unknown' when its processes cannot be
// listed. A path no process of another's runs in, the snapshot's directory
// being made for this one run, ties the group; nothing else does. The tree is
// never followed through a link: one put in its place could name any
// directory, `/` included. Only its parent's spelling is resolved, so a tree
// that is a link ties nothing (no process reports a cwd under the link's own
// path), and a removed tree is the path recorded, which is the one its
// processes report. `clock` is the one the run's supervisor was read in (its
// recorded fingerprint's): a group listed in another pid namespace than the
// one it names, or through a /proc that is not the reader's, is 'unknown'
// (groupMemberCwds, C142 U-F1). `system` is what the listing reads (a test
// passes its own).
export async function groupTiedToTree(pgid, tree, { clock = null, system } = {}) {
  if (typeof tree !== 'string' || tree === '') return 'untied';
  const members = await groupMemberCwds(pgid, { clock, system });
  if (members === null) return 'unknown';
  const inTree = treeTest(tree);
  return members.some((m) => inTree(m.cwd)) ? 'tied' : 'untied';
}

// Whether a cwd lies in the tree, under the tree's spellings groupTiedToTree
// takes: the path recorded, and the one with its parent resolved.
function treeTest(tree) {
  const trees = treeSpellings(tree);
  return (cwd) => typeof cwd === 'string' && isAbsolute(cwd) && trees.some((t) => isWithinOrEqual(cwd, t));
}

function treeSpellings(tree) {
  const trees = [resolve(tree)];
  try {
    trees.push(join(realpathSync.native(dirname(resolve(tree))), basename(tree)));
  } catch {
    /* its parent removed too */
  }
  return trees;
}

// C142 — whether any process the user can see runs in the run's snapshot
// `tree`, which a removal must find empty: a process the companion started in
// a group or a session of its own outlives the companion's group, still
// running there. 'none' when no process does, 'occupied' when one may, and
// 'unknown' when the processes cannot be listed (elsewhere than Linux and
// macOS, a `/proc` or `lsof` that fails, a listing that does not list its
// reader, a macOS `ps` that fails, a Linux listing read in another pid
// namespace than the one the supervisor's recorded clock names), when a
// process runs where the listing did not read (allProcessCwds'
// `unreadable`: on Linux one of the user's own not
// dumpable; on macOS one lsof could not read or left out, its name an error
// report or none) and may be the run's, or no tree is named. Such a process
// is placed outside the run by the run's `supervisor` (the owner record's,
// which started the companion), its start time and ancestors read in the
// clock the process's were (clockDomain; start times compare in clock ticks
// since boot on Linux, seconds on macOS):
//   - it started before the supervisor: what the run starts descends from
//     the supervisor, and so starts after it;
//   - or one of its ancestors started before the supervisor and is not one
//     of the supervisor's ancestors: a process of the run descends from the
//     supervisor, and one left by its parent is given to the nearest
//     subreaper among its ancestors or to its pid namespace's init, so each
//     ancestor of it is the supervisor, a process the run started since, an
//     ancestor of the supervisor, or such an init. Only its ancestors below
//     the first init (pid 1, or one that may be a pid namespace's init:
//     `reaper`) count: an init may have adopted it, though it is no ancestor
//     of its parent, and what lies above that init is the init's lineage,
//     which says nothing of its own;
//   - or, on macOS (a clock of `darwin-boot/`), its ancestors reach one of
//     the supervisor's other than launchd (pid 1) before they reach the
//     supervisor's pid: macOS has no subreaper and gives an orphan to
//     launchd, so a process of the run reaches the supervisor's ancestors
//     only through the supervisor. A new terminal tab's set-uid `login`,
//     under a terminal the supervisor runs in, is placed so. (A debugger that
//     attaches to a process becomes its parent there; one attached to a
//     hidden process of the run, which takes root for a set-uid one, would
//     place it.)
// One it does not place may be the run's: the interactive codex, another
// lane's peer, an ssh session or a `sudo` started since is placed by the
// shell, the session or the daemon it runs under, when that started before
// the run and is no ancestor of its supervisor. Where a tie
// needs a name read as written, here a name that may be the tree's counts:
// the one Linux's " (deleted)" mark leaves or the mark kept, and an escaped
// lsof name, which keeps the tree's spelling verbatim when that spelling has
// nothing lsof escapes, and could be any otherwise. A process in the tree is
// not thereby the run's (a location proves no ancestry): nothing here signals
// it, and the run is left to the reclaim's age.
// On a machine that starts processes faster than the listing reads them (a
// test suite running beside the run, measured 2026-10-21), a process of the
// user's own started during the listing can stay unread, and when it descends
// from an ancestor of the supervisor nothing places it outside the run: the
// tree reads 'unknown', and cancel, settle and the reclaim keep the snapshot
// for a later attempt. That is the retention direction, never a removal under
// a live process; it only delays the cleanup on a busy machine. A rule that
// places a process started after the listing began is deferred (C142's
// listing-hardening slice). `listProcesses` lists them (listProcessesHere;
// a test passes its own).
export async function treeOccupancy(tree, { listProcesses = listProcessesHere, supervisor = null } = {}) {
  if (typeof tree !== 'string' || tree === '') return 'unknown';
  const recorded = supervisor?.fingerprint;
  const runClock = typeof recorded?.clock === 'string' ? recorded.clock : null;
  const all = await listProcesses({ clock: runClock });
  if (all === null) return 'unknown';
  const inTree = treeTest(tree);
  const plain = treeSpellings(tree).every((t) => /^[\x20-\x5b\x5d-\x7e]*$/.test(t));
  const suffix = ' (deleted)';
  const runStart = runClock !== null && /^\d+$/.test(recorded.starttime ?? '') ? BigInt(recorded.starttime) : null;
  const before = (starttime) => runStart !== null && /^\d+$/.test(starttime ?? '') && BigInt(starttime) < runStart;
  const runAncestors = lineageOf(recorded?.ancestors);
  const darwin = runClock?.startsWith('darwin-boot/') === true;
  const outsideRun = (starttime, clock, ancestors) => {
    if (runStart === null || clock !== runClock) return false;
    if (before(starttime)) return true;
    if (runAncestors === null) return false;
    for (const a of lineageOf(ancestors) ?? []) {
      if (a.pid === 1 || a.reaper === true || (darwin && a.pid === supervisor.pid)) return false;
      if (runAncestors.some((r) => r.pid === a.pid && r.starttime === a.starttime)) {
        if (darwin) return true;
      } else if (before(a.starttime)) return true;
    }
    return false;
  };
  let escaped = false;
  let unread = false;
  for (const { cwd, raw, unreadable, starttime, clock, ancestors } of all) {
    if (unreadable === true && !outsideRun(starttime, clock, ancestors)) unread = true;
    if (typeof raw !== 'string') continue;
    if (inTree(cwd) || inTree(raw) || (raw.endsWith(suffix) && inTree(raw.slice(0, -suffix.length)))) return 'occupied';
    if (cwd === null) escaped = true;
  }
  if (escaped && !plain) return 'occupied';
  // A process whose directory was not read, and that is not placed outside
  // the run, may run in the tree: the tree is not proven empty.
  return unread ? 'unknown' : 'none';
}

// A list of ancestors as processLineage writes it ([{ pid, starttime,
// reaper }], a pid and a start time in digits, `reaper` true or absent), or
// null for anything else.
function lineageOf(ancestors) {
  if (!Array.isArray(ancestors)) return null;
  return ancestors.every((a) => a !== null && typeof a === 'object' && Number.isInteger(a.pid) && a.pid > 0 && /^\d+$/.test(a.starttime ?? '') && (a.reaper === undefined || a.reaper === true)) ? ancestors : null;
}

// C142 — whether the run that made a snapshot is proven over, the judgment a
// terminal write and a removal of that one run's snapshot need (a cancel or a
// settle that finds the run's supervisor killed before its cleanup). Stricter
// than judgeSnapshot, which also reclaims on age: here no age counts.
//   'ended'   the record reads, its supervisor is gone (no process has its
//             pid), its companion's group is gone (or none was launched),
//             and no process runs in the run's tree (treeOccupancy);
//   'alive'   the supervisor, or a process of the companion's group, runs;
//   'unknown' anything else: no record, an identity that cannot be told (a
//             companion's group alive under a pid whose process cannot be
//             told included, and one whose leader is gone while none of its
//             processes runs in the run's tree), a launch whose companion was
//             never recorded, a process in the run's tree outside the
//             companion's group (`tree-occupied`), or processes that cannot
//             be listed (`tree-unknown`).
//             A supervisor pid a process has under another fingerprint
//             (identityState's `differ`) is one that cannot be told: a
//             recorded fingerprint that is incomplete or of a kind this
//             platform does not take reads `differ`, and so does a macOS
//             `lstart` read under another locale or time zone than the
//             runner's (C141), the runner alive. A pid truly reused is left
//             to the reclaim.
// `supervisor` and `companion` are the states the verdict came from
// (identityState's and companionState's), so a caller can tell a companion
// group outliving its dead supervisor from a supervisor still at work. A
// `companion-alive` verdict names a group whose leader is still the companion,
// or is gone while a process of the group runs in the run's tree, never one
// that cannot be told: a caller may stop that group as the run's. `handle`,
// when given, is the run's handle, which the runner writes apart from this
// record and which names the companion's process (handlePeerProcess). `tree`,
// when given, is the run's tree as found apart from the record (judgeRunEnded
// takes it from where the record lies), which a group must run in to be the
// run's: a record's own `tree` could name any directory. `listProcesses` is
// treeOccupancy's.
export async function snapshotEnded(owner, { handle = null, tree = null, listProcesses = listProcessesHere } = {}) {
  if (owner === null || typeof owner !== 'object') return { verdict: 'unknown', why: 'owner-unreadable', supervisor: null, companion: null };
  // A record that names no supervisor, or no snapshot to remove, proves
  // nothing: a missing pid would read as a process gone, and so would one
  // past the range a pid takes. Nor does one that names a companion without
  // its pid and group (a missing group would read as one ended while a
  // process of it runs on), or with a group it does not lead: the runner
  // starts the companion as its group's leader, so a group under another id
  // is no group of the run's. Nor, whatever its `launched_at` says, does one
  // that omits the companion the run's handle names, or names another: the
  // runner records the same process in both, so a record that disagrees with
  // the handle is one the runner did not write. A handle whose process fields,
  // or whose kept supervisor, the runner did not write (handlePeerProcess,
  // handleSupervisor) proves nothing either.
  const id = isRunPid;
  const named = owner.companion;
  const companionIncomplete = named !== null && named !== undefined && (typeof named !== 'object' || !id(named.pid) || named.pgid !== named.pid);
  const shown = handlePeerProcess(handle);
  const kept = handleSupervisor(handle);
  if (shown?.malformed || kept?.malformed) return { verdict: 'unknown', why: 'handle-malformed', supervisor: null, companion: null };
  const handleNames = shown !== null;
  const handleDisagrees = handleNames && (named === null || typeof named !== 'object' || named.pid !== shown.pid || (Number.isInteger(shown.pgid) && named.pgid !== shown.pgid));
  // The supervisor too: the runner copies the record's onto the handle, so a
  // record naming another (an exited one, while the handle's runs) is one it
  // did not write.
  const supervisorDisagrees = kept !== null && !sameSupervisor(owner.supervisor, kept);
  if (!id(owner.supervisor?.pid) || typeof owner.live_toplevel !== 'string' || typeof owner.tree !== 'string' || companionIncomplete || handleDisagrees || supervisorDisagrees) {
    return { verdict: 'unknown', why: 'owner-incomplete', supervisor: null, companion: null };
  }
  const supervisor = await identityState(owner.supervisor);
  const { state: companion, identity: companionIdentity } = await companionStates(named ?? null, owner.supervisor.fingerprint?.clock);
  const judged = (verdict, why) => ({ verdict, why, supervisor, companion });
  if (supervisor === 'match') return judged('alive', 'supervisor-alive');
  // A group alive under a companion pid whose process cannot be told may be
  // that process's own (the pid reused once the companion's group ended):
  // nothing proves it the run's, so nothing may stop it as the run's.
  if (companion === 'alive' && companionIdentity === 'unknown') return judged('unknown', 'companion-unknown');
  // Nor does a group whose leader is gone prove itself the run's by its id:
  // once the companion's group ended, the id may lead a group another process
  // started and left (a job-control pipeline, a daemon's double fork). It is
  // the run's only while a process of it runs in the run's tree
  // (groupTiedToTree), read in the pid namespace its supervisor's clock names.
  if (companion === 'alive' && companionIdentity === 'gone' && (await groupTiedToTree(named.pgid, tree ?? owner.tree, { clock: owner.supervisor.fingerprint?.clock })) !== 'tied') return judged('unknown', 'companion-untied');
  if (companion === 'alive') return judged('alive', 'companion-alive');
  if (supervisor === 'unknown' || supervisor === 'differ') return judged('unknown', 'supervisor-unknown');
  if (companion === 'unknown') return judged('unknown', 'companion-unknown');
  if (companion === null && typeof owner.launched_at === 'string') return judged('unknown', 'launch-unrecorded');
  // Nor is a run over while a process runs in its tree: the companion may
  // have started it in a group of its own, which its group's end leaves
  // running (treeOccupancy).
  const occupancy = await treeOccupancy(tree ?? owner.tree, { supervisor: owner.supervisor, listProcesses });
  if (occupancy !== 'none') return judged('unknown', `tree-${occupancy}`);
  return judged('ended', companion === null ? 'supervisor-gone-nothing-launched' : 'owners-gone');
}

// C142 — judge the run of the snapshot whose owner record is at `ownerPath`
// (snapshotEnded), the record read again once it is judged `ended`: the first
// read came before the judgment awaited the owner processes, and a supervisor
// that recorded a launch (or its companion) and then died in between has
// written it since (judgeOwnerRecord's rule). A record that names another run
// than `runId` proves nothing of this one, nor one that disagrees with the
// run's `handle` (snapshotEnded's rule). The run's tree is the record's
// directory's `tree`, where createPeerSnapshot made it. Returns
// { judged, owner }.
export async function judgeRunEnded(ownerPath, { runId = null, handle = null } = {}) {
  const tree = typeof ownerPath === 'string' ? join(dirname(ownerPath), SNAPSHOT_TREE_DIR) : null;
  const judge = async (owner) => {
    if (owner !== null && runId !== null && owner.run_id !== runId) return { verdict: 'unknown', why: 'owner-of-another-run', supervisor: null, companion: null };
    return snapshotEnded(owner, { handle, tree });
  };
  const first = await readOwner(ownerPath);
  const judged = await judge(first);
  if (judged.verdict !== 'ended') return { judged, owner: first };
  const reread = await readOwner(ownerPath);
  if (JSON.stringify(reread) === JSON.stringify(first)) return { judged, owner: first };
  return { judged: await judge(reread), owner: reread };
}

// C142 — remove the one snapshot an owner record describes, a run's own, never
// a scan of the repository's (reclaimPeerSnapshots): its worktree and
// registration, its branch and its directory, through the checkout it was
// made from, or, that one gone, its repository's common git directory. The
// caller has judged its run ended (judgeRunEnded). `root` is the tree the
// run's handle recorded. Returns removePeerSnapshot's { removed, error }, or
// { removed: false, error: null, refused } when the record names anything
// but its own snapshot (ownedSnapshotTarget).
export async function removeOwnedSnapshot(ownerPath, owner, { env = process.env, root } = {}) {
  let top = owner.live_toplevel;
  if ((await mtimeMs(top)) === null && typeof owner.common_dir === 'string' && (await mtimeMs(owner.common_dir)) !== null) top = owner.common_dir;
  const target = await ownedSnapshotTarget(ownerPath, owner, top, root, env);
  if (target.refused) return { removed: false, error: null, refused: target.refused };
  if (target.error) return { removed: false, error: target.error };
  return removePeerSnapshot(target.snapshot, { env });
}

// What an owner record may remove, confirmed apart from the record's own
// paths, which a corrupted record, or one another tool wrote, could point at
// any worktree or branch (a forced `worktree remove` deletes uncommitted
// files): the record sits in a snapshot directory, its tree is that
// directory's `tree` and the tree the run's handle recorded, its branch is
// the one createPeerSnapshot names for that directory, and a worktree
// registered at the tree is locked naming this record, as the reclaim
// requires of every worktree it removes (snapshotOwnerPathOf). A tree with no
// registration is removed with its directory, as an interrupted creation's.
// Returns { snapshot }, { refused: why } or { error }.
async function ownedSnapshotTarget(ownerPath, owner, top, root, env) {
  const parent = dirname(ownerPath);
  if (basename(ownerPath) !== SNAPSHOT_OWNER_FILE || !basename(parent).includes(SNAPSHOT_DIR_MARK)) return { refused: 'owner-path-not-a-snapshot' };
  const tree = join(parent, SNAPSHOT_TREE_DIR);
  if (!samePath(owner.tree, tree)) return { refused: 'tree-not-the-snapshot' };
  if (root !== undefined && !samePath(root, tree)) return { refused: 'tree-not-the-handle-root' };
  const branch = snapshotBranchOf(parent, owner);
  if (branch === null && (owner.branch ?? null) !== null) return { refused: 'branch-not-the-snapshot' };
  const listed = await git(top, ['worktree', 'list', '--porcelain', '-z'], { env });
  if (listed.code !== 0) return { error: `git worktree list: ${(listed.stderr || listed.stdout).trim().split('\n')[0] || `exit ${listed.code}`}` };
  let registered = null;
  for (const { worktree, locked } of parseWorktreeList(listed.stdout)) {
    if (!samePath(worktree, tree)) continue;
    const named = snapshotOwnerPathOf(worktree, locked);
    if (named === null || !samePath(named, ownerPath)) return { refused: 'registration-not-locked-by-owner' };
    registered = worktree;
  }
  return { snapshot: { live_toplevel: top, root: registered, parent, branch } };
}

// The branch an owner record may have deleted: the one createPeerSnapshot
// names for the record's directory, never another branch the record names.
function snapshotBranchOf(parent, owner) {
  return owner?.branch === `peer-snapshot/${basename(parent)}` ? owner.branch : null;
}

// Whether two spellings name one path: as written, resolved, or through the
// real path of the directory that holds it (the path itself may be gone).
function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a === '' || b === '') return false;
  if (resolve(a) === resolve(b)) return true;
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      try {
        return join(realpathSync(dirname(p)), basename(p));
      } catch {
        return null;
      }
    }
  };
  const ra = real(a);
  return ra !== null && ra === real(b);
}

// Judge a snapshot from its owner record and, when it would be reclaimed,
// read the record again: the first read came before the judgment awaited the
// owner processes, and a supervisor that recorded a launch (or its
// companion) and then died in between has written it since. That death,
// which a reclaim verdict needs, makes the second read final.
// Test seam: `hooks.afterOwnerRead(ownerPath)` runs after the first read.
async function judgeOwnerRecord(ownerPath, options, hooks) {
  const first = await readOwner(ownerPath);
  if (hooks.afterOwnerRead) await hooks.afterOwnerRead(ownerPath);
  const judged = await judgeSnapshot(first, options);
  if (judged.verdict !== 'reclaim') return { judged, owner: first };
  const again = await readOwner(ownerPath);
  if (JSON.stringify(again) === JSON.stringify(first)) return { judged, owner: first };
  return { judged: await judgeSnapshot(again, options), owner: again };
}

// Whether an owner record names this repository: its common git directory,
// shared by every worktree of it, or for a record without one, the toplevel.
function ownsRepository(owner, live) {
  if (typeof owner.common_dir === 'string') return owner.common_dir === live.commonDir;
  return owner.live_toplevel === live.top;
}

async function mtimeMs(path) {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

// Reclaim this repository's abandoned snapshots: every worktree locked as a
// peer snapshot, and every snapshot directory an interrupted creation left in
// a temporary directory naming this repository, whose owners judgeSnapshot
// finds gone. A snapshot another reclaimer removed first is not an error.
// `listProcesses` is judgeSnapshot's.
export async function reclaimPeerSnapshots({ cwd, env = process.env, now = Date.now(), ttlMs = SNAPSHOT_TTL_MS, hooks = {}, listProcesses = listProcessesHere } = {}) {
  const report = { reclaimed: [], kept: [], errors: [] };
  let live;
  try {
    live = await liveToplevel(cwd, env);
  } catch (error) {
    report.errors.push(String(error?.message ?? error));
    return report;
  }
  if (live === null) return report;
  const { top } = live;
  const listed = await git(top, ['worktree', 'list', '--porcelain', '-z'], { env });
  if (listed.code !== 0) {
    report.errors.push(`git worktree list: ${listed.stderr.trim()}`);
    return report;
  }
  const worktrees = parseWorktreeList(listed.stdout);
  const registered = new Set();
  for (const { worktree, locked } of worktrees) {
    const ownerPath = snapshotOwnerPathOf(worktree, locked);
    if (ownerPath === null) continue;
    registered.add(dirname(ownerPath));
    registered.add(dirname(worktree));
    const parentGone = (await mtimeMs(dirname(ownerPath))) === null && (await mtimeMs(worktree)) === null;
    const { judged, owner } = parentGone
      ? { judged: { verdict: 'reclaim', why: 'directory-gone' }, owner: null }
      : await judgeOwnerRecord(ownerPath, { now, ttlMs, recordedAtMs: (await mtimeMs(ownerPath)) ?? (await mtimeMs(dirname(ownerPath))), tree: worktree, listProcesses }, hooks);
    if (judged.verdict !== 'reclaim') {
      report.kept.push({ tree: worktree, why: judged.why });
      continue;
    }
    const removed = await removePeerSnapshot({ live_toplevel: top, root: worktree, parent: dirname(ownerPath), branch: snapshotBranchOf(dirname(ownerPath), owner) }, { env });
    if (removed.removed) report.reclaimed.push({ tree: worktree, why: judged.why });
    else report.errors.push(`${worktree}: ${removed.error}`);
  }
  // Interrupted creations: a snapshot directory with this repository's owner
  // record and no registered worktree.
  const bases = new Set();
  for (const b of [tmpdir(), '/tmp']) {
    try {
      bases.add(realpathSync.native(b));
    } catch {
      /* skipped */
    }
  }
  for (const base of bases) {
    let entries = [];
    try {
      entries = readdirSync(base, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.includes(SNAPSHOT_DIR_MARK)) continue;
      const parent = join(base, entry.name);
      if (registered.has(parent)) continue;
      const seen = await readOwner(join(parent, SNAPSHOT_OWNER_FILE));
      if (seen === null || !ownsRepository(seen, live)) continue;
      if (worktrees.some((w) => w.worktree === seen.tree)) continue;
      const { judged, owner } = await judgeOwnerRecord(join(parent, SNAPSHOT_OWNER_FILE), { now, ttlMs, tree: join(parent, SNAPSHOT_TREE_DIR), listProcesses }, hooks);
      if (owner === null) continue;
      if (judged.verdict !== 'reclaim') {
        report.kept.push({ tree: owner.tree, why: judged.why });
        continue;
      }
      const removed = await removePeerSnapshot({ live_toplevel: top, root: null, parent, branch: snapshotBranchOf(parent, owner) }, { env });
      if (removed.removed) report.reclaimed.push({ tree: owner.tree, why: `interrupted-${judged.why}` });
      else report.errors.push(`${parent}: ${removed.error}`);
    }
  }
  return report;
}
