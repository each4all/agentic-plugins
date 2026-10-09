// scripts/lib/state-root.mjs — where workflow records are found and created
// (ADR-0067 Decisions 1 and 2).
//
// One source for the three personas (generated, ADR-0066) and, byte for byte,
// for orchestrator's copy at plugins/orchestrator/scripts/lib/state-root.mjs
// (ADR-0010 §5: a plugin may not import another's script).
// tests/persona-pipeline/test-state-root.mjs holds the two copies equal, and
// runtime's reader copy (plugins/runtime/scripts/lib/state-root.mjs) to the
// same default state root. It reads no persona declaration, so every copy runs
// the same bytes.
//
// Three contracts (Decision 1):
// - storage: the default state root and the read set say where existing
//   records are FOUND; creationRoot() says where a new one is CREATED;
// - git: every git fact comes from a checkout, never from a state root.
//   Nothing here reads HEAD or a working tree; it lists worktrees (and the
//   branch each has out) and runs the attestation checks, always through the
//   checkout it is given;
// - pointers: a pointer into a shared record is spelled relative to the root
//   that holds it, as today.
//
// - The default state root is the parent of the git common dir when that dir
//   is named `.git`, and otherwise the checkout's toplevel. It is found the way
//   git finds it, from the checkout's `.git` and that git dir's `commondir`
//   file, as runtime's reader copy does, so readers and writers agree.
// - The read set is the default state root, then the checkout's toplevel: one
//   location when they are one directory, spelled as the checkout then.
//   AGENTIC_STATE_BASE and the shared-creation switch choose where a record is
//   created, never where it is found.
// - The shared-creation switch is one file per repository under the default
//   state root. Absent: off, and records are created in the checkout, as
//   before. A file that cannot be read or parsed refuses every creation.

import { AsyncLocalStorage } from 'node:async_hooks';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const STATE_BASE_ENV = 'AGENTIC_STATE_BASE';
export const STATE_DIR_REL = '.agentic-plugins/state';
export const SHARED_CREATION_REL = `${STATE_DIR_REL}/shared-creation.json`;
export const SHARED_CREATION_SCHEMA = 'agentic-shared-creation-1.0';
export const CUTOVER_RUNS_REL = '.agentic-plugins/runs/cutover';
export const CUTOVER_MANIFEST_SCHEMA = 'agentic-state-cutover-1.0';
export const STATE_ROOT_REPORT_SCHEMA = 'agentic-state-root-1.0';

// The homes whose records are shared (Decision 1(a)): each plugin's canonical
// home, and the legacy homes only engineer and orchestrator have.
export const SHARED_HOMES = Object.freeze([
  { plugin: 'engineer', home: 'canonical', rel: `${STATE_DIR_REL}/engineer` },
  { plugin: 'engineer', home: 'legacy', rel: '.claude/agentic-engineer' },
  { plugin: 'founder', home: 'canonical', rel: `${STATE_DIR_REL}/founder` },
  { plugin: 'designer', home: 'canonical', rel: `${STATE_DIR_REL}/designer` },
  { plugin: 'orchestrator', home: 'canonical', rel: `${STATE_DIR_REL}/orchestrator` },
  { plugin: 'orchestrator', home: 'legacy', rel: '.claude/agentic-orchestrator' },
]);

export class StateRootError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'StateRootError';
    this.code = code;
  }
}

const GITDIR_LINE_RE = /^gitdir:\s*(.+?)\s*$/;

// The repository identity of `checkout`, read the way git reads it, from its
// `.git` and that git dir's `commondir` file:
// - { state: 'none' }: no `.git` there, outside a repository;
// - { state: 'ok', commonDir };
// - { state: 'unreadable', why, readerCommonDir }: a `.git` that cannot be
//   read or followed (a link to nothing included), or a common dir that is
//   not a directory. `readerCommonDir` is what runtime's reader copy computes
//   for it (null, or the common dir named), so gitCommonDir agrees with it.
// A writer fails closed on the last: the repository's other worktrees cannot
// be listed, and "no other worktree" would let a copy there pass.
export function gitIdentity(checkout) {
  const dotGit = path.join(checkout, '.git');
  const unreadable = (what, error, readerCommonDir = null) => ({
    state: 'unreadable', why: `${what} (${error?.code || error?.message || error})`, readerCommonDir,
  });
  try {
    fs.lstatSync(dotGit);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { state: 'none' };
    return unreadable(dotGit, error);
  }
  let stat;
  try {
    stat = fs.statSync(dotGit);
  } catch (error) {
    // The entry is there and names nothing: a repository whose identity is
    // lost, not the absence of one.
    return unreadable(dotGit, error);
  }
  let gitDir;
  if (stat.isDirectory()) {
    gitDir = dotGit;
  } else if (stat.isFile()) {
    let text;
    try {
      text = fs.readFileSync(dotGit, 'utf8');
    } catch (error) {
      return unreadable(dotGit, error);
    }
    const match = GITDIR_LINE_RE.exec(text.split(/\r?\n/, 1)[0] ?? '');
    if (!match) return unreadable(dotGit, 'no gitdir line');
    gitDir = path.resolve(checkout, match[1]);
  } else {
    return unreadable(dotGit, 'neither a directory nor a file');
  }
  // `commondir` is relative to the physical git dir: git resolves a gitdir
  // reached through a symlink before it reads it.
  try {
    gitDir = fs.realpathSync(gitDir);
  } catch (error) {
    return unreadable(gitDir, error);
  }
  const commonDirFile = path.join(gitDir, 'commondir');
  try {
    fs.lstatSync(commonDirFile);
  } catch (error) {
    // No `commondir`: the git dir is its own common dir (a main worktree, a
    // separate-git-dir checkout, a submodule).
    if (error?.code === 'ENOENT') return { state: 'ok', commonDir: gitDir };
    return unreadable(commonDirFile, error);
  }
  let commonDir;
  try {
    // A regular file only, opened without blocking: a FIFO there would stall
    // every writer's guard. The reader's rule takes a read that fails for
    // anything but absence (a directory, say) for none.
    const fd = fs.openSync(commonDirFile, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
    try {
      if (!fs.fstatSync(fd).isFile()) return unreadable(commonDirFile, 'not a regular file');
      commonDir = fs.readFileSync(fd, 'utf8').trim();
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    // The entry is there and cannot be read: a link to nothing is a lost
    // identity, as for `.git`. The reader's rule takes its ENOENT for no
    // `commondir` (the git dir), any other failure for none.
    return unreadable(commonDirFile, error, error?.code === 'ENOENT' ? gitDir : null);
  }
  if (!commonDir) return { state: 'ok', commonDir: gitDir };
  const named = path.resolve(gitDir, commonDir);
  // A common dir that is gone (the main checkout moved or deleted) holds no
  // worktree list: "no other worktree" there would be a guess.
  try {
    if (!fs.statSync(named).isDirectory()) return unreadable(named, 'not a directory', named);
  } catch (error) {
    return unreadable(named, error, named);
  }
  return { state: 'ok', commonDir: named };
}

// The git common dir of `checkout`, or null when there is none or it cannot be
// read: the reader's rule, which runtime's copy applies too (a writer asks
// gitIdentity, which tells the cases apart).
export function gitCommonDir(checkout) {
  const identity = gitIdentity(checkout);
  if (identity.state === 'ok') return identity.commonDir;
  return identity.state === 'unreadable' ? identity.readerCommonDir : null;
}

// ADR-0067 Decision 1(a) — the directory a command acts in. A caller that
// knows its checkout (a hook from its payload, a script from --repo-root) runs
// its writes inside runInCommandDirectory, so the write guard and the handoff
// slot judge that checkout, not the process's working directory; anything else
// acts in process.cwd(). A subprocess is handed the same directory as its cwd.
const commandDirectoryStore = new AsyncLocalStorage();

export function runInCommandDirectory(dir, fn) {
  return commandDirectoryStore.run(path.resolve(dir), fn);
}

export function commandDirectory() {
  return commandDirectoryStore.getStore() ?? process.cwd();
}

export function defaultStateRoot(checkout) {
  const toplevel = path.resolve(checkout);
  const common = gitCommonDir(toplevel);
  if (common && path.basename(common) === '.git') return path.dirname(common);
  return toplevel;
}

// Whether two paths name one existing directory. When the filesystem will not
// say, they are treated as two, so both are read: a record reached twice is
// counted once by its real path (readers), never chosen between.
export function sameDirectory(a, b) {
  if (path.resolve(a) === path.resolve(b)) return true;
  try {
    const sa = fs.statSync(a);
    const sb = fs.statSync(b);
    return sa.isDirectory() && sb.isDirectory() && sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

// The read set (Decision 1(a)): the default state root first, then the
// checkout's toplevel, or the toplevel alone when they are one directory.
export function readSet(checkout) {
  const toplevel = path.resolve(checkout);
  const shared = defaultStateRoot(toplevel);
  if (sameDirectory(shared, toplevel)) return [toplevel];
  return [shared, toplevel];
}

// The toplevels of the repository's other worktrees, whose own homes a create
// and the macro's child scans also search (Decision 2, Decision 1(b)): every
// worktree `git worktree list` names that is not in `checkout`'s read set and
// still exists. Empty outside a repository, and without asking git when the
// common dir records no linked worktree: the main worktree is the default
// state root, already in the read set. Fails closed: a repository whose
// identity cannot be read, whose worktrees git cannot list, or a listed
// worktree that cannot be stat'ed for any reason but absence, throws
// (StateRootError 'worktrees-unlisted'), since "no other worktree" would let a
// copy or an active workflow there pass.
export function otherWorktreeRoots(checkout) {
  const unlisted = (why) => new StateRootError(
    `Cannot list the other worktrees of ${path.resolve(checkout)}: ${why}. A copy or an active workflow ` +
      'there would go unseen, so nothing that needs the list proceeds (ADR-0067 Decision 2).',
    'worktrees-unlisted',
  );
  const identity = gitIdentity(path.resolve(checkout));
  if (identity.state === 'none') return [];
  if (identity.state === 'unreadable') throw unlisted(`its repository identity cannot be read: ${identity.why}`);
  const common = identity.commonDir;
  try {
    if (fs.readdirSync(path.join(common, 'worktrees')).length === 0) return [];
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw unlisted(`${path.join(common, 'worktrees')} (${error?.code || error?.message})`);
  }
  let out;
  try {
    out = String(execFileSync('git', ['-C', checkout, 'worktree', 'list', '--porcelain', '-z'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000,
    }));
  } catch (error) {
    throw unlisted(`git worktree list failed (${error?.code || error?.status || error?.message})`);
  }
  const read = readSet(checkout);
  const roots = [];
  for (const field of out.split('\0')) {
    if (!field.startsWith('worktree ')) continue;
    const root = field.slice('worktree '.length);
    try {
      if (!fs.statSync(root).isDirectory()) continue;
    } catch (error) {
      // A worktree removed without `git worktree prune` holds nothing.
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') continue;
      throw unlisted(`${root} (${error?.code || error?.message})`);
    }
    if (read.some((r) => sameDirectory(r, root)) || roots.some((r) => sameDirectory(r, root))) continue;
    roots.push(root);
  }
  return roots;
}

// Every root whose homes may hold a record of this repository: the read set,
// then the other worktrees' toplevels. A write path searches them all for a
// second file of the record it writes (Decision 4, item 2).
export function repositoryRoots(checkout) {
  return [...readSet(checkout), ...otherWorktreeRoots(checkout)];
}

// The roots a write to an existing record searches for a second active
// workflow on the record's branch key (Decision 2; Decision 4, item 1: a
// reader that sees two reports the ambiguity and its writers refuse): the read
// set of the root holding the record and that of the checkout the command
// runs in; every root of the repository when that checkout cannot be told, or
// when the directory the caller named (runInCommandDirectory: --repo-root, a
// hook's payload) is no checkout of the record's repository. A mistyped
// option must not narrow the guard to the storage root.
export function writerRoots(stateRoot, cwd = commandDirectory()) {
  const at = commandCheckoutOf(stateRoot, cwd);
  const named = commandDirectoryStore.getStore();
  const everyRoot = at.kind === 'unknown' || (at.kind === 'outside' && named !== undefined && path.resolve(cwd) === named);
  const roots = [];
  for (const root of everyRoot ? repositoryRoots(stateRoot) : [...readSet(stateRoot), ...readSet(at.checkout ?? stateRoot)]) {
    if (!roots.some((r) => sameDirectory(r, root))) roots.push(root);
  }
  return roots;
}

// The branches checked out in any worktree of the repository (Decision 1(b):
// only that worktree's Stop sees its working tree), as { ok: true, branches }
// or { ok: false } when git cannot list them; a caller then leaves every kept
// branch alone.
export function worktreeBranches(checkout) {
  let out;
  try {
    out = String(execFileSync('git', ['-C', checkout, 'worktree', 'list', '--porcelain', '-z'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000,
    }));
  } catch {
    return { ok: false, branches: new Set() };
  }
  const branches = new Set();
  for (const field of out.split('\0')) {
    if (field.startsWith('branch refs/heads/')) branches.add(field.slice('branch refs/heads/'.length));
  }
  return { ok: true, branches };
}

// The toplevel of the worktree that has `branch` checked out, or null when
// none has or git cannot list them: the only place a working-tree fact about
// that branch may come from (Decision 1(b)). The holder must be a working tree
// of this repository (isWorkingTreeOf), and null (unavailable) otherwise.
export function worktreeHoldingBranch(checkout, branch) {
  let out;
  try {
    out = String(execFileSync('git', ['-C', checkout, 'worktree', 'list', '--porcelain', '-z'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000,
    }));
  } catch {
    return null;
  }
  let current = null;
  for (const field of out.split('\0')) {
    if (field.startsWith('worktree ')) current = field.slice('worktree '.length);
    else if (field === `branch refs/heads/${branch}` && current !== null) {
      return isWorkingTreeOf(current, checkout) ? current : null;
    }
  }
  return null;
}

// Whether `holder`, a worktree git lists, is a working tree of `checkout`'s
// repository: its identity is this repository's; it is neither the common dir
// nor inside it; and when its `.git` is the common dir itself (a main
// worktree), a checked-out index entry is on disk there. In a separate-git-dir
// layout git names the main worktree by the metadata directory (the git dir,
// or the directory holding a git dir named .git), whose status is not a
// working tree's. The limit: a real main checkout with no checked-out entry on
// disk (an empty index, every file deleted or skip-worktree) cannot be told
// from that directory by anything git records or the layout shows, so its
// working-tree facts read as unavailable, the safe direction (Decision 1(b)).
function isWorkingTreeOf(holder, checkout) {
  const own = gitCommonDir(holder);
  const ours = gitCommonDir(path.resolve(checkout));
  if (own === null || ours === null || !samePhysicalFile(own, ours)) return false;
  if (isUnder(realOr(holder), realOr(own))) return false;
  if (!samePhysicalFile(path.join(holder, '.git'), own)) return true;
  return checkedOutEntryOnDisk(holder) !== null;
}

// ADR-0067 Decision 1(a) — the checkout a command runs in: the toplevel of
// `cwd` when that is a checkout of the repository holding `stateRoot`, else
// `stateRoot` itself (a caller working outside it, as a test does, keeps
// today's behaviour). Null when it cannot be told: git fails in a directory
// that is, or may be, a checkout of this repository (its `.git` names this
// common dir, or cannot be read). A caller then writes nothing per checkout:
// the storage root's slot would be another checkout's.
export function commandCheckout(stateRoot, cwd = commandDirectory()) {
  const at = commandCheckoutOf(stateRoot, cwd);
  if (at.kind === 'checkout') return at.checkout;
  return at.kind === 'outside' ? stateRoot : null;
}

// How `cwd` stands to the repository holding `stateRoot`: { kind: 'checkout',
// checkout } inside one of its checkouts; { kind: 'outside' } inside none
// (another repository, no repository, a path that is not there); { kind:
// 'unknown' } when that cannot be told.
function commandCheckoutOf(stateRoot, cwd) {
  const unknown = { kind: 'unknown' };
  const outside = { kind: 'outside' };
  const holderIdentity = gitIdentity(path.resolve(stateRoot));
  // The storage root's own identity cannot be read: whether `cwd` is one of
  // its checkouts cannot be told.
  if (holderIdentity.state === 'unreadable') return unknown;
  const holder = holderIdentity.state === 'ok' ? holderIdentity.commonDir : null;
  let top = null;
  try {
    top = String(execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000,
    })).replace(/\n$/, '');
  } catch {
    top = null;
  }
  if (top && path.isAbsolute(top)) {
    const own = gitCommonDir(top);
    if (own === null) return unknown;
    return holder !== null && samePhysicalFile(own, holder) ? { kind: 'checkout', checkout: top } : outside;
  }
  // git could not say: look for the nearest `.git` without it.
  let dir = path.resolve(cwd);
  for (;;) {
    let found = true;
    try {
      fs.lstatSync(path.join(dir, '.git'));
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') return unknown;
      found = false;
    }
    if (found) {
      const own = gitCommonDir(dir);
      if (own === null) return unknown;
      return holder !== null && samePhysicalFile(own, holder) ? unknown : outside;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return outside;
    dir = parent;
  }
}

// The first directory on the way from `base` down `rel` that is a symbolic
// link, or that cannot be lstat'ed for any reason but absence; null when none
// is. A per-checkout file (the handoff slot, its markers) is written under a
// checkout's home only when this is null: a home linked to another checkout's
// would share them (Decision 1(a)).
export function aliasedComponent(base, rel) {
  let dir = path.resolve(base);
  for (const part of String(rel).split(/[\\/]+/).filter(Boolean)) {
    dir = path.join(dir, part);
    try {
      if (fs.lstatSync(dir).isSymbolicLink()) return dir;
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      return dir;
    }
  }
  return null;
}

// The files other than `file` in `dirs` that hold the same record: one with
// the same file name, or one whose frontmatter names the same `workflowId`
// (Decision 4, item 2: one workflow id, one writable copy). One physical file
// reached twice counts once; a file gone between the listing and its read (an
// archive moved it) is none. Only regular files are read, and only through
// their frontmatter (readFrontmatterText): the scan runs under a writer's lock
// across every worktree, and a FIFO or a long body must not stall it. Fails
// closed (StateRootError 'scan-failed'): a directory or a file that cannot be
// read for any reason but absence throws, since it may be the copy, and so
// does a workflow name that is not a regular file (a FIFO, a device, a
// directory), which runtime's readers report as not a regular file too
// (Decision 4, item 1: readers and writers agree).
export function otherCopiesOf({ file, workflowId, dirs }) {
  const name = path.basename(file);
  const copies = [];
  const failed = (what, error) => new StateRootError(
    `Cannot read ${what} (${error?.code || error?.message}): it may hold a second copy of ${name} ` +
      '(ADR-0067 Decision 4, item 2), so no write proceeds until it can be read.',
    'scan-failed',
  );
  for (const dir of dirs) {
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch (error) {
      // Only absence is none: a file in a directory's place (ENOTDIR) is a
      // layout runtime's readers refuse too (not-a-directory).
      if (error?.code === 'ENOENT') continue;
      throw failed(dir, error);
    }
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.md') || entry.endsWith('.md.tmp')) continue;
      const candidate = path.join(dir, entry);
      if (samePhysicalFile(candidate, file) || copies.some((c) => samePhysicalFile(c, candidate))) continue;
      let head;
      try {
        head = readFrontmatterText(candidate);
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw failed(candidate, error);
      }
      if (head === null) throw failed(candidate, { message: 'not a regular file' });
      if (entry === name || (workflowId && workflowIdOfText(head, { partial: true }) === workflowId)) copies.push(candidate);
    }
  }
  return copies;
}

// What keeps the entry `file` of a workflow home from being read as a
// workflow: 'not a regular file' (a FIFO, a device, a directory, or a link to
// one), which runtime's readers refuse too (Decision 4, item 1); 'gone' when
// it vanished since the listing (an archive moved it), a link to nothing
// included (ENOENT only: a file in a directory's place throws); null for a regular file, or a link to one: a path that resolves to
// the same real file is that file (Decision 4, item 1). A path that cannot be
// judged otherwise throws.
export function workflowEntryProblem(file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch (error) {
    if (error?.code === 'ENOENT') return 'gone';
    throw error;
  }
  return st.isFile() ? null : 'not a regular file';
}

const READ_CHUNK = 64 * 1024;
const FRONTMATTER_OPEN = Buffer.from('---\n');
const FRONTMATTER_CLOSE = Buffer.from('\n---\n');

// The text of `file` from its start through the line that closes its
// frontmatter (`\n---\n`, as parseWorkflowFile reads it), or null when it is
// not a regular file. A file that opens no frontmatter yields its first bytes,
// one whose frontmatter never closes the whole file: never a cut inside the
// frontmatter, so a key late in it is read, not missed. Opened without
// blocking, so a FIFO is seen and skipped, never waited on; a long body is
// never read. Linear in what it reads: each chunk is searched once, with the
// few bytes before it a close could start in, and the text is joined once.
// Throws what open and read throw (ENOENT: gone since a listing).
export function readFrontmatterText(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  try {
    if (!fs.fstatSync(fd).isFile()) return null;
    const chunks = [];
    let length = 0;
    let opened = null;
    // The last bytes read, fewer than a close delimiter: a close cut across
    // two chunks starts there.
    let carry = Buffer.alloc(0);
    for (;;) {
      const chunk = Buffer.alloc(READ_CHUNK);
      const n = fs.readSync(fd, chunk, 0, READ_CHUNK, null);
      if (n === 0) break;
      const got = chunk.subarray(0, n);
      chunks.push(got);
      const start = length;
      length += n;
      if (opened === null && length >= FRONTMATTER_OPEN.length) {
        opened = Buffer.concat(chunks, length).subarray(0, FRONTMATTER_OPEN.length).equals(FRONTMATTER_OPEN);
        if (!opened) break;
      }
      const searched = Buffer.concat([carry, got]);
      const windowStart = start - carry.length;
      // The search starts after the open delimiter, as parseWorkflowFile's
      // does.
      const close = searched.indexOf(FRONTMATTER_CLOSE, Math.max(0, FRONTMATTER_OPEN.length - windowStart));
      if (close >= 0) {
        return Buffer.concat(chunks, length).subarray(0, windowStart + close + FRONTMATTER_CLOSE.length).toString('utf8');
      }
      carry = searched.subarray(Math.max(0, searched.length - (FRONTMATTER_CLOSE.length - 1)));
    }
    return Buffer.concat(chunks, length).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// ADR-0067 Decision 4, items 1 and 2 — the run directories of one peer-runs
// directory, by the one identity rule every listing of them follows, runtime's
// readers included (scanPeerRuns and retention list `isDirectory()` entries
// and refuse a link): a directory is a run directory; a link, whatever it
// names, is none, and the runners never make one. [] when `dir` is absent. An
// entry that cannot be judged throws: a ledger read as absent could be
// created, settled or kept twice.
export function runDirectoryEntries(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw new StateRootError(
      `Peer-run storage: cannot list ${dir} (${error?.code || error?.message}) (ADR-0067 Decision 4, item 2).`,
      'scan-failed',
    );
  }
  const out = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (entry.isDirectory()) out.push({ runId: entry.name, runDir: path.join(dir, entry.name) });
  }
  return out;
}

// Whether `runDir` is a run directory by that rule: a directory, never a link.
// Absence (ENOENT) is none; a path that cannot be judged throws, a file in a
// directory's place on the way (ENOTDIR) included.
export function runDirectoryAt(runDir) {
  let own;
  try {
    own = fs.lstatSync(runDir);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw new StateRootError(
      `Peer-run storage: cannot tell whether ${runDir} is a run directory (${error?.code || error?.message}) (ADR-0067 Decision 4, item 2).`,
      'scan-failed',
    );
  }
  return own.isDirectory();
}

// Whether nothing at all is at `p` (ENOENT): a run id no run directory holds
// is reported as no ledger only then, never read through a link or a file
// standing there (Decision 4, items 1 and 2). Anything else throws.
export function absentAt(p) {
  try {
    fs.lstatSync(p);
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw new StateRootError(
      `Peer-run storage: cannot tell what is at ${p} (${error?.code || error?.message}) (ADR-0067 Decision 4, item 2).`,
      'scan-failed',
    );
  }
  return false;
}

// The physical ledgers that hold `runId` in `dirs` now, each once: its run
// directory, and a prune's claim on it (claimName), which is still that run
// id's ledger. A run directory is named by its run id (no link is one), so
// asking each directory for those two names finds every ledger a sweep's
// selection would; the sweeps ask again before each change they make
// (Decision 4, item 2).
export function ledgersHolding(dirs, runId) {
  const held = [];
  for (const dir of dirs) {
    for (const runDir of [path.join(dir, runId), path.join(dir, claimName(runId))]) {
      if (runDirectoryAt(runDir) && !held.some((h) => samePhysicalFile(h, runDir))) held.push(runDir);
    }
  }
  return held;
}

// What identifies the ledger a sweep planned to delete: its directory's
// device and inode, and the handle's run id and timestamps. An inode is
// reused once a directory is gone (Linux hands it out again at once), so the
// timestamps a recreated run writes anew are compared too.
export function ledgerIdentity(runDir, handle) {
  const st = fs.lstatSync(runDir);
  return JSON.stringify([
    st.dev, st.ino, handle?.run_id ?? null, handle?.started_at ?? null,
    handle?.updated_at ?? null, handle?.completed_at ?? null, handle?.status ?? null,
  ]);
}

// The name of a prune's claim on the run directory of `runId`: a sibling name
// no run id can take (`~` is no run-id character), one per run id, so every
// ownership check finds it by asking for that name (ledgersHolding), and of a
// bounded length whatever the run id's (a digest of it).
const CLAIM_PREFIX = '~prune~';
export function claimName(runId) {
  return `${CLAIM_PREFIX}${createHash('sha256').update(String(runId)).digest('hex').slice(0, 32)}`;
}
export function isClaimName(name) {
  return new RegExp(`^${CLAIM_PREFIX}[0-9a-f]{32}$`).test(name);
}

// A prune's claim on the run directory it is about to judge (Decision 4, item
// 2): the directory moves, in one rename, to its claim name (claimName), out
// of every lookup by run id but still counted as that run id's ledger, so the
// directory the sweep judges next is the one it deletes:
// - { claim }: claimed;
// - { gone: true }: nothing is at `runDir` any more;
// - { held }: a claim on the run id already stands there (a prune that is
//   judging it, or one left by an interrupted prune): the run id has two
//   ledgers, and nothing moved.
export function claimRunDirectory(runDir) {
  const claim = path.join(path.dirname(runDir), claimName(path.basename(runDir)));
  // rename(2) replaces an empty directory and refuses a non-empty one, so the
  // claim name is looked at first, and a refusal of the rename is read again.
  if (!absentAt(claim)) return { held: claim };
  try {
    fs.renameSync(runDir, claim);
  } catch (error) {
    if (error?.code === 'ENOENT') return { gone: true };
    if (error?.code === 'ENOTEMPTY' || error?.code === 'EEXIST') return { held: claim };
    throw new StateRootError(
      `Peer-run storage: cannot claim ${runDir} for its prune (${error?.code || error?.message}) (ADR-0067 Decision 4, item 2).`,
      'scan-failed',
    );
  }
  return { claim };
}

// Puts a claimed run directory back under its run id while nothing stands
// there; true when it did. When something does (a ledger made under the run
// id since the claim), the claim keeps its own name, and the sweep reports
// it. Node has no rename that refuses to replace, and rename(2) replaces an
// empty directory, so the name is looked at first: a directory made in the
// instant between that look and the rename is the gap left, as the admission
// check's is.
export function releaseClaim(claim, runDir) {
  try {
    fs.lstatSync(runDir);
    return false;
  } catch (error) {
    if (error?.code !== 'ENOENT') return false;
  }
  try {
    fs.renameSync(claim, runDir);
    return true;
  } catch {
    return false;
  }
}

// ADR-0067 Decision 4, item 2 — the claims a sweep finds in `scanDirs`, each
// physical directory once, and what becomes of each. A claim no prune can
// still hold (renamed more than `graceMs` ago: the rename sets its ctime),
// whose handle names the run id it is the claim of, is put back under that
// run id while no other ledger in `dirs` holds it ('recovered'). Otherwise it
// stays, reported: 'held' (younger: a prune may be judging it), 'kept'
// (another ledger holds the run id, so both are left, as for any run id two
// ledgers hold), 'unreadable' (no regular handle naming that run id: a claim
// a failed deletion left partly deleted included).
export function recoverClaims({ scanDirs, dirs, graceMs, now = new Date(), handleFile = 'handle.json', validName }) {
  const out = [];
  const seen = [];
  for (const dir of scanDirs) {
    for (const { runId: name, runDir: claim } of runDirectoryEntries(dir)) {
      if (!isClaimName(name) || seen.some((s) => samePhysicalFile(s, claim))) continue;
      seen.push(claim);
      let st;
      try {
        st = fs.lstatSync(claim);
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw new StateRootError(
          `Peer-run storage: cannot judge the claim ${claim} (${error?.code || error?.message}) (ADR-0067 Decision 4, item 2).`,
          'scan-failed',
        );
      }
      if (now.getTime() - st.ctimeMs < graceMs) {
        out.push({ path: claim, run_id: null, state: 'held' });
        continue;
      }
      let runId = null;
      try {
        const handle = JSON.parse(readRegularFile(path.join(claim, handleFile)));
        if (typeof handle?.run_id === 'string' && validName(handle.run_id) && claimName(handle.run_id) === name) runId = handle.run_id;
      } catch {
        /* no handle naming the run id: reported, left */
      }
      if (runId === null) {
        out.push({ path: claim, run_id: null, state: 'unreadable' });
        continue;
      }
      const runDir = path.join(dir, runId);
      if (ledgersHolding(dirs, runId).some((h) => !samePhysicalFile(h, claim)) || !releaseClaim(claim, runDir)) {
        out.push({ path: claim, run_id: runId, state: 'kept' });
        continue;
      }
      out.push({ path: runDir, run_id: runId, state: 'recovered' });
    }
  }
  return out;
}

// A regular file's text, never waiting on a FIFO or following a link standing
// in its place.
function readRegularFile(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    if (!fs.fstatSync(fd).isFile()) throw new StateRootError(`${file} is not a regular file`, 'scan-failed');
    return fs.readFileSync(fd, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

// ADR-0067 Decision 4, item 2 — what a sweep of the peer-runs directories
// `dirs` acts on. Every spelling of each physical ledger is collected first
// (one directory reached through two scanned roots), so the order the
// directories are read in decides nothing:
// - `ambiguous`: each run id two physical ledgers hold, with the directories
//   holding them; neither ledger is acted on;
// - `chosen`: for every other ledger, the one spelling it is swept through, a
//   name `validName` accepts. A ledger with no such name is not swept.
// The selection is made once; the sweeps check it again (ledgersHolding)
// before each change, since a second ledger may appear meanwhile.
export function sweepSelection(dirs, validName) {
  const ledgers = [];
  for (const dir of dirs) {
    for (const entry of runDirectoryEntries(dir)) {
      const identity = realOr(entry.runDir);
      let ledger = ledgers.find((l) => l.identity === identity);
      if (!ledger) {
        ledger = { identity, entries: [] };
        ledgers.push(ledger);
      }
      ledger.entries.push({ ...entry, dir });
    }
  }
  const holders = new Map();
  for (const ledger of ledgers) {
    for (const entry of ledger.entries) {
      const held = holders.get(entry.runId) ?? [];
      if (!held.some((h) => h.ledger === ledger)) held.push({ ledger, dir: entry.dir });
      holders.set(entry.runId, held);
    }
  }
  const ambiguous = new Map();
  const blocked = new Set();
  for (const [runId, own] of holders) {
    if (isClaimName(runId)) continue;
    // A prune's claim on the run id is a ledger of it too (ledgersHolding).
    const held = [...own];
    for (const c of holders.get(claimName(runId)) ?? []) {
      if (!held.some((h) => h.ledger === c.ledger)) held.push(c);
    }
    if (held.length < 2) continue;
    ambiguous.set(runId, held.map((h) => h.dir));
    for (const h of held) blocked.add(h.ledger);
  }
  const chosen = new Set();
  for (const ledger of ledgers) {
    if (blocked.has(ledger)) continue;
    const pick = ledger.entries.find((e) => validName(e.runId));
    if (pick) chosen.add(pick.runDir);
  }
  return { ambiguous, chosen };
}

// The same file reached through two spellings counts once.
export function samePhysicalFile(a, b) {
  if (path.resolve(a) === path.resolve(b)) return true;
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}

// Is `child` the same path as `parent`, or inside it? Lexical.
function isUnder(child, parent) {
  const c = path.resolve(child);
  const p = path.resolve(parent);
  if (c === p) return true;
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

function realOr(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

// The directory lanes live under (Decision 5): `<parent>/<repo>-lanes`, named
// from the main worktree, the default state root.
export function lanesDirectory(defaultRoot) {
  const root = path.resolve(defaultRoot);
  return path.join(path.dirname(root), `${path.basename(root)}-lanes`);
}

export function isUnderLanesDirectory(dir, defaultRoot) {
  const lanes = lanesDirectory(defaultRoot);
  return isUnder(realOr(dir), realOr(lanes)) || isUnder(path.resolve(dir), lanes);
}

// ---------------------------------------------------------------------------
// The shared-creation switch (Decision 1(a))

export function sharedCreationPath(checkout) {
  return path.join(defaultStateRoot(checkout), SHARED_CREATION_REL);
}

const ISO_UTC_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;

function switchRecordProblem(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return 'not a JSON object';
  if (record.schema !== SHARED_CREATION_SCHEMA) return `schema is not ${SHARED_CREATION_SCHEMA}`;
  if (typeof record.enabled !== 'boolean') return 'enabled is not a boolean';
  for (const key of ['enabled_at', 'disabled_at', 'lanes_first_run_at']) {
    if (record[key] !== undefined && record[key] !== null && !(typeof record[key] === 'string' && ISO_UTC_RE.test(record[key]))) {
      return `${key} is not an ISO UTC time`;
    }
  }
  if (record.enabled && typeof record.enabled_at !== 'string') return 'enabled without enabled_at';
  return null;
}

// { state: 'off' | 'on' | 'unreadable', path, record?, error? }. Only `on`
// moves creation; `unreadable` refuses it.
export function readSharedCreation(checkout) {
  const file = sharedCreationPath(checkout);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'off', path: file, record: null };
    return { state: 'unreadable', path: file, record: null, error: `cannot read ${file} (${error?.code || error?.message})` };
  }
  let record;
  try {
    record = JSON.parse(text);
  } catch (error) {
    return { state: 'unreadable', path: file, record: null, error: `cannot parse ${file} (${error.message})` };
  }
  const problem = switchRecordProblem(record);
  if (problem) return { state: 'unreadable', path: file, record: null, error: `${file}: ${problem}` };
  return { state: record.enabled ? 'on' : 'off', path: file, record };
}

// ---------------------------------------------------------------------------
// AGENTIC_STATE_BASE (Decision 2)

// The override, checked: { set: false } when unset or empty, else
// { set: true, ok: true, root } or { set: true, ok: false, error }. Allowed:
// the checkout's toplevel (never a lane's), and, once shared creation is on,
// the default state root. Anything else fails closed: a fallback would open a
// second writable copy.
export function checkStateBase({ checkout, env = process.env, switchState }) {
  const value = env[STATE_BASE_ENV];
  if (value === undefined || value === '') return { set: false };
  const fail = (why) => ({ set: true, ok: false, value, error: `${STATE_BASE_ENV}=${JSON.stringify(value)} ${why}` });
  if (!path.isAbsolute(value)) return fail('is not an absolute path.');
  if (path.normalize(value) !== value || (value.length > 1 && value.endsWith(path.sep))) {
    return fail('is not a normalized path (no ".", "..", doubled or trailing separator).');
  }
  const toplevel = path.resolve(checkout);
  const shared = defaultStateRoot(toplevel);
  if (sameDirectory(value, toplevel)) {
    if (!sameDirectory(shared, toplevel) && isUnderLanesDirectory(toplevel, shared)) {
      return fail(`names a lane (${toplevel}): a lane is removed when its subtask lands, and records created in it would go with it.`);
    }
    return { set: true, ok: true, value, root: toplevel };
  }
  if (sameDirectory(value, shared)) {
    if (switchState === 'on') return { set: true, ok: true, value, root: shared };
    return fail(
      `names the default state root (${shared}) while shared creation is off: an older host in this checkout ` +
        'does not look there. Until the cutover turns shared creation on, it may name only this checkout.',
    );
  }
  return fail(
    `names neither this checkout (${toplevel}) nor the default state root (${shared}). ` +
      'A record created anywhere else is seen only by sessions that carry the same value.',
  );
}

// Where a new shared record is created (Decision 1(a)): the checkout while
// shared creation is off, else AGENTIC_STATE_BASE, else the default state
// root. Throws StateRootError on an unreadable switch or a refused override.
export function creationRoot(checkout, { env = process.env } = {}) {
  const toplevel = path.resolve(checkout);
  const switchInfo = readSharedCreation(toplevel);
  if (switchInfo.state === 'unreadable') {
    throw new StateRootError(
      `Shared-creation switch unreadable: ${switchInfo.error}. No record is created until it is repaired ` +
        '(ADR-0067 Decision 1(a)); see docs/runbooks/state-root-cutover.md.',
      'switch-unreadable',
    );
  }
  const base = checkStateBase({ checkout: toplevel, env, switchState: switchInfo.state });
  if (base.set && !base.ok) throw new StateRootError(`${base.error} (ADR-0067 Decision 2)`, 'state-base-refused');
  if (switchInfo.state !== 'on') return { root: toplevel, sharedCreation: 'off', defaultRoot: defaultStateRoot(toplevel) };
  return { root: base.set ? base.root : defaultStateRoot(toplevel), sharedCreation: 'on', defaultRoot: defaultStateRoot(toplevel) };
}

// ---------------------------------------------------------------------------
// The main-checkout attestation (Decision 1(a)) and the report

function git(checkout, args) {
  return String(execFileSync('git', ['-C', checkout, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30_000, maxBuffer: 256 * 1024 * 1024,
  }));
}

// The three checks `shared-creation --enable` makes before it takes the
// operator's run as the attestation that `checkout` is the repository's main
// checkout. Passing them is no proof (git does not record where the main
// worktree is); they catch the plain mistakes.
export function attestationChecks(checkout) {
  const toplevel = path.resolve(checkout);
  const checks = [];
  let gitDir = null;
  let commonDir = null;
  let top = null;
  try {
    gitDir = git(toplevel, ['rev-parse', '--path-format=absolute', '--git-dir']).trim();
    commonDir = git(toplevel, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
    top = git(toplevel, ['rev-parse', '--show-toplevel']).trim();
  } catch {
    checks.push({ id: 'git-dir-is-common-dir', ok: false, detail: `git cannot read ${toplevel} as a checkout` });
    return { ok: false, checks };
  }
  const commonOk = realOr(gitDir) === realOr(commonDir) && path.basename(commonDir) === '.git';
  checks.push({
    id: 'git-dir-is-common-dir',
    ok: commonOk,
    detail: commonOk
      ? `the git dir is the common dir, ${commonDir}`
      : `the git dir (${gitDir}) is not the common dir named .git (${commonDir}): a linked worktree, or a git dir under another name`,
  });
  const shared = defaultStateRoot(toplevel);
  const topOk = sameDirectory(top, shared) && sameDirectory(toplevel, shared);
  checks.push({
    id: 'toplevel-is-default-state-root',
    ok: topOk,
    detail: topOk
      ? `the toplevel is the default state root, ${shared}`
      : `the toplevel (${top}) is not the default state root (${shared}): a .git file pointing elsewhere, or not the main worktree`,
  });
  const present = checkedOutEntryOnDisk(toplevel);
  checks.push({
    id: 'checked-out-entry-on-disk',
    ok: present !== null,
    detail: present !== null
      ? `the checked-out index entry ${JSON.stringify(present)} is on disk`
      : 'no checked-out index entry (git ls-files -t tag H) is on disk: a directory that holds only the git dir, or an empty index',
  });
  return { ok: checks.every((c) => c.ok), checks };
}

// The first checked-out index entry (git ls-files -t tag H) of `toplevel`
// that is on disk there, or null: a directory that holds only a git dir, or
// an empty index, has none.
function checkedOutEntryOnDisk(toplevel) {
  try {
    const listing = git(toplevel, ['ls-files', '-t', '-z']);
    for (const entry of listing.split('\0')) {
      if (!entry.startsWith('H ')) continue;
      const rel = entry.slice(2);
      try {
        fs.lstatSync(path.join(toplevel, rel));
        return rel;
      } catch {
        /* missing on disk: keep looking */
      }
    }
  } catch {
    return null;
  }
  return null;
}

// Can the default state root take writes? Read-only: asks the nearest
// existing directory on the way to its state directory.
export function defaultRootWritable(checkout) {
  const shared = defaultStateRoot(checkout);
  for (const dir of [path.join(shared, STATE_DIR_REL), path.join(shared, '.agentic-plugins'), shared]) {
    try {
      if (!fs.statSync(dir).isDirectory()) return false;
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      return false;
    }
    try {
      fs.accessSync(dir, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

// What `state.mjs state-root --repo-root <checkout>` prints (read-only).
export function describeStateRoot(checkout, { env = process.env } = {}) {
  const toplevel = path.resolve(checkout);
  const shared = defaultStateRoot(toplevel);
  const isDefault = sameDirectory(shared, toplevel);
  const switchInfo = readSharedCreation(toplevel);
  const base = checkStateBase({ checkout: toplevel, env, switchState: switchInfo.state });
  let creation = null;
  let creationError = null;
  try {
    creation = creationRoot(toplevel, { env }).root;
  } catch (error) {
    creationError = error.message;
  }
  const record = switchInfo.record ?? {};
  return {
    schema: STATE_ROOT_REPORT_SCHEMA,
    checkout: toplevel,
    default_state_root: shared,
    checkout_is_default_state_root: isDefault,
    read_set: readSet(toplevel),
    shared_creation: {
      state: switchInfo.state,
      path: switchInfo.path,
      enabled_at: record.enabled_at ?? null,
      disabled_at: record.disabled_at ?? null,
      lanes_first_run_at: record.lanes_first_run_at ?? null,
      versions: record.versions ?? null,
      error: switchInfo.error ?? null,
    },
    state_base: base.set ? { value: base.value, ok: base.ok, error: base.error ?? null } : null,
    creation_root: creation,
    creation_error: creationError,
    attestation: isDefault ? attestationChecks(toplevel) : null,
    default_root_writable: defaultRootWritable(toplevel),
  };
}

// ---------------------------------------------------------------------------
// Turning shared creation on and off (Decision 4, items 4 and 5)

function isoUtc(now) {
  return new Date(now).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function listIds(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  return entries.filter((n) => n.endsWith('.md') && !n.endsWith('.md.tmp')).map((n) => n.slice(0, -3));
}

// Every workflow id under the default state root's shared homes, active and
// archived. An archived file may carry a suffix (`<id>-<stamp>.md`); its id is
// read from the file, never guessed from the name.
export function inventoryDefaultRoot(checkout) {
  const shared = defaultStateRoot(checkout);
  const ids = new Set();
  const records = [];
  for (const spec of SHARED_HOMES) {
    for (const dir of ['workflows', 'archive']) {
      const abs = path.join(shared, spec.rel, dir);
      for (const name of listIds(abs)) {
        const id = workflowIdOf(path.join(abs, `${name}.md`)) ?? name;
        ids.add(id);
        records.push({ plugin: spec.plugin, home: spec.home, dir, workflow_id: id, path: path.join(spec.rel, dir, `${name}.md`) });
      }
    }
  }
  return { workflow_ids: [...ids].sort(), records };
}

// The frontmatter's workflow_id, or null. LF frontmatter, the key to its first
// colon, a JSON-quoted or bare value.
export function workflowIdOf(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  return workflowIdOfText(text);
}

// `partial`: `text` is a file's head, so a frontmatter not closed within it is
// read to its end.
export function workflowIdOfText(text, { partial = false } = {}) {
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---', 4);
  const fm = end < 0 ? (partial ? text.slice(4) : '') : text.slice(4, end);
  for (const line of fm.split('\n')) {
    const m = /^workflow_id:\s*(.*)$/.exec(line);
    if (!m) continue;
    const raw = m[1].trim();
    if (raw.startsWith('"')) {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    }
    return raw || null;
  }
  return null;
}

function cutoverDir(checkout) {
  return path.join(defaultStateRoot(checkout), CUTOVER_RUNS_REL);
}

export function newestOpenCutoverManifest(checkout) {
  const dir = cutoverDir(checkout);
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  for (const name of names.reverse()) {
    const file = path.join(dir, name);
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    // A cutover a rollback reversed is no longer open (cutover.mjs).
    if (doc?.schema === CUTOVER_MANIFEST_SCHEMA && doc.kind === 'cutover' && !doc.inventory && !doc.rolled_back_at) return { file, doc };
  }
  return null;
}

// `state.mjs shared-creation --enable`, run in the main checkout. Refuses
// unless the attestation checks pass and the default state root is writable.
// Appends the inventory to the open cutover manifest (or a new one holding
// only the inventory), then writes the switch.
export function enableSharedCreation({ checkout, versions, now = new Date() }) {
  const toplevel = path.resolve(checkout);
  if (!versions || typeof versions !== 'object' || Array.isArray(versions)) {
    throw new StateRootError('--versions must be a JSON object naming the release tuple verified on both hosts.', 'versions-invalid');
  }
  const attestation = attestationChecks(toplevel);
  if (!attestation.ok) {
    const failed = attestation.checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`).join('; ');
    throw new StateRootError(
      `${toplevel} does not pass the main-checkout checks (${failed}). Run shared-creation --enable in the ` +
        "repository's main checkout; a repository without one has no shared root (ADR-0067 Decision 1(a)).",
      'attestation-failed',
    );
  }
  if (!defaultRootWritable(toplevel)) {
    throw new StateRootError(`The default state root ${defaultStateRoot(toplevel)} cannot be written.`, 'root-unwritable');
  }
  const current = readSharedCreation(toplevel);
  if (current.state === 'unreadable') throw new StateRootError(`Shared-creation switch unreadable: ${current.error}.`, 'switch-unreadable');
  if (current.state === 'on') return { changed: false, switch: current.record, path: current.path, manifest: current.record.manifest ?? null };
  const at = isoUtc(now);
  const inventory = inventoryDefaultRoot(toplevel);
  const open = newestOpenCutoverManifest(toplevel);
  const stamp = at.replace(/[-:]/g, '');
  const manifestFile = open?.file ?? path.join(cutoverDir(toplevel), `${stamp}-${randomBytes(3).toString('hex')}.json`);
  const manifest = open?.doc ?? {
    schema: CUTOVER_MANIFEST_SCHEMA,
    kind: 'cutover',
    created_at: at,
    main_checkout: toplevel,
    pairs: [],
    moved: [],
    inventory: null,
  };
  manifest.inventory = { at, workflow_ids: inventory.workflow_ids, records: inventory.records };
  writeJsonAtomic(manifestFile, manifest);
  const record = {
    schema: SHARED_CREATION_SCHEMA,
    enabled: true,
    enabled_at: at,
    attested_checkout: toplevel,
    versions,
    manifest: path.relative(defaultStateRoot(toplevel), manifestFile).split(path.sep).join('/'),
    lanes_first_run_at: current.record?.lanes_first_run_at ?? null,
  };
  writeJsonAtomic(current.path, record);
  return { changed: true, switch: record, path: current.path, manifest: manifestFile };
}

// `state.mjs shared-creation --disable` (rollback). Refused once lanes have
// run: their workflows live under the default state root, and no single home
// serves both the old tuple and them.
export function disableSharedCreation({ checkout, now = new Date() }) {
  const toplevel = path.resolve(checkout);
  const current = readSharedCreation(toplevel);
  if (current.state === 'unreadable') throw new StateRootError(`Shared-creation switch unreadable: ${current.error}.`, 'switch-unreadable');
  if (current.state === 'off') return { changed: false, switch: current.record, path: current.path };
  if (current.record.lanes_first_run_at) {
    throw new StateRootError(
      `Lanes first ran at ${current.record.lanes_first_run_at}: the cutover can no longer be rolled back. ` +
        'Repair forward (ADR-0067 Decision 4, item 4, Rollback).',
      'lanes-have-run',
    );
  }
  const record = { ...current.record, enabled: false, disabled_at: isoUtc(now) };
  writeJsonAtomic(current.path, record);
  return { changed: true, switch: record, path: current.path };
}
