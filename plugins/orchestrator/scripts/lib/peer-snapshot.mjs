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
//
// Every git call runs with the caller's git selectors removed (GIT_DIR,
// GIT_WORK_TREE, GIT_INDEX_FILE, …): one left in the environment would point
// the capture, or the peer, back at the live tree.

import { spawn } from 'node:child_process';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { fingerprintForPid, identityState, isGroupAlive, stopProcessGroup } from './process-identity.mjs';

export const SNAPSHOT_LOCK_PREFIX = 'peer-snapshot v1 ';
export const SNAPSHOT_OWNER_FILE = 'owner.json';
export const SNAPSHOT_OWNER_SCHEMA = 'peer-snapshot-owner-1';
export const SNAPSHOT_TREE_DIR = 'tree';
// An owner record that cannot be judged (unreadable, or a process whose
// identity cannot be told) is reclaimed only once it is this old.
export const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
const SNAPSHOT_DIR_MARK = '-peer-snapshot-';
// How long an aborted git call's process group gets after SIGTERM.
const ABORT_GRACE_MS = 2000;
// The characters XML escapes, which no snapshot root carries.
const XML_SPECIAL = /[&<>"']/;

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
  if (liveIndexPresent) await copyFile(staged, worktree);

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

function snapshotBase(top) {
  const candidates = [];
  try {
    candidates.push(realpathSync(tmpdir()));
  } catch {
    /* an unresolvable TMPDIR is skipped */
  }
  try {
    candidates.push(realpathSync('/tmp'));
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
      supervisor: { pid: supervisorPid, fingerprint: await fingerprintForPid(supervisorPid) },
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

// A live group blocks the reclaim however old the record: the companion may
// have exited and left a child running in the snapshot. Its group id is the
// companion's pid, which the system gives no new process while the group
// lives, so a live group under a pid no process has is the companion's, and
// one under a pid whose process cannot be told may be. Only under a pid
// another process now has may it be that process's own group: told apart by
// age alone.
async function companionState(companion) {
  if (!companion) return null;
  const state = await identityState({ pid: companion.pid, fingerprint: companion.fingerprint });
  if (state === 'match') return 'alive';
  const group = isGroupAlive(companion.pgid);
  if (group && state !== 'differ') return 'alive';
  if (group || state === 'unknown') return 'unknown';
  return 'gone';
}

// Whether a snapshot may be reclaimed: 'reclaim', or 'keep' with why.
// Its supervisor (the run that made it) and its companion (the peer's
// process group) must both be gone; a process whose identity cannot be told,
// or a companion launched and never recorded, keeps the snapshot until the
// record is SNAPSHOT_TTL_MS old.
export async function judgeSnapshot(owner, { now = Date.now(), ttlMs = SNAPSHOT_TTL_MS, recordedAtMs = null } = {}) {
  const old = (atMs) => Number.isFinite(atMs) && now - atMs > ttlMs;
  if (owner === null) return old(recordedAtMs) ? { verdict: 'reclaim', why: 'owner-unreadable-expired' } : { verdict: 'keep', why: 'owner-unreadable' };
  const supervisor = await identityState(owner.supervisor);
  const companion = await companionState(owner.companion);
  if (supervisor === 'match') return { verdict: 'keep', why: 'supervisor-alive' };
  if (companion === 'alive') return { verdict: 'keep', why: 'companion-alive' };
  // A launch whose companion was never recorded: the peer may be running
  // unnamed, so the snapshot is judged like an identity that cannot be told.
  const unnamedLaunch = companion === null && typeof owner.launched_at === 'string';
  if (supervisor === 'unknown' || companion === 'unknown' || unnamedLaunch) {
    return old(Date.parse(owner.created_at)) ? { verdict: 'reclaim', why: 'identity-unknown-expired' } : { verdict: 'keep', why: 'identity-unknown' };
  }
  return { verdict: 'reclaim', why: companion === null ? 'supervisor-gone-companion-unrecorded' : 'owners-gone' };
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
export async function reclaimPeerSnapshots({ cwd, env = process.env, now = Date.now(), ttlMs = SNAPSHOT_TTL_MS, hooks = {} } = {}) {
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
      : await judgeOwnerRecord(ownerPath, { now, ttlMs, recordedAtMs: (await mtimeMs(ownerPath)) ?? (await mtimeMs(dirname(ownerPath))) }, hooks);
    if (judged.verdict !== 'reclaim') {
      report.kept.push({ tree: worktree, why: judged.why });
      continue;
    }
    const removed = await removePeerSnapshot({ live_toplevel: top, root: worktree, parent: dirname(ownerPath), branch: owner?.branch ?? null }, { env });
    if (removed.removed) report.reclaimed.push({ tree: worktree, why: judged.why });
    else report.errors.push(`${worktree}: ${removed.error}`);
  }
  // Interrupted creations: a snapshot directory with this repository's owner
  // record and no registered worktree.
  const bases = new Set();
  for (const b of [tmpdir(), '/tmp']) {
    try {
      bases.add(realpathSync(b));
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
      const { judged, owner } = await judgeOwnerRecord(join(parent, SNAPSHOT_OWNER_FILE), { now, ttlMs }, hooks);
      if (owner === null) continue;
      if (judged.verdict !== 'reclaim') {
        report.kept.push({ tree: owner.tree, why: judged.why });
        continue;
      }
      const removed = await removePeerSnapshot({ live_toplevel: top, root: null, parent, branch: owner.branch ?? null }, { env });
      if (removed.removed) report.reclaimed.push({ tree: owner.tree, why: `interrupted-${judged.why}` });
      else report.errors.push(`${parent}: ${removed.error}`);
    }
  }
  return report;
}
