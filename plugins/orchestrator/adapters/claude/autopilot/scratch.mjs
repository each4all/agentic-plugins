// plugins/orchestrator/adapters/claude/autopilot/scratch.mjs
//
// ADR-0068, amendment of 2026-11-10 (C175) — a run's temporary files.
//
// A worker step and a verification check each get a TMPDIR of their own, so
// what they leave there (a runbook's `mktemp -d` directories, a test's
// repositories, a mutation copy) ends with them instead of piling up in the
// machine's temporary directory. A run owns one root,
//
//   <base>/agentic-ap/<run>/     <run>: the run id without its `autopilot-`
//     .scratch.json          the marker: schema, run id, repository
//     s<seq>/                a worker step's TMPDIR
//     v<seq>-<index>/        a verification check's TMPDIR
//
// where <base> is the driver's own temporary directory (TMPDIR, then /tmp),
// the first that lies outside every worktree of the repository: a directory
// inside a tested tree would dirty it. With none, the run does not start.
// The names are short on purpose: a tool that makes a unix socket under
// TMPDIR has about a hundred bytes for its whole path (104 on macOS, whose
// own per-user TMPDIR takes half of them).
//
// REMOVAL IS GUARDED. Nothing here removes a path it cannot prove the run's:
// the root is absolute, named for its run under `agentic-ap`, reached
// through no symbolic link, and holds a marker naming that run and this
// repository; a directory removed is the root's direct child with a name this
// module makes (`scratchTarget`, a pure judgment, then `proveScratch`). The
// root itself goes last and only when empty: its marker is unlinked and the
// directory removed without recursion.
//
// REMOVAL IS DEFERRED while something may still use a directory:
//   - a peer's snapshot under a step's directory whose run is not proven over
//     (peer-snapshot.mjs judgeRunEnded: no age counts), or whose removal did
//     not go through, keeps the WHOLE step directory: a surviving peer uses
//     more of it than its snapshot (its prompt directories);
//   - a step or a check whose process group outlived SIGKILL, and a step
//     whose peers the run could not account for, are held by the run (`release`
//     with a reason), which keeps its open-run record then.
// What a run leaves is found again from the shared index beside the open-run
// records, `<main>/.agentic-plugins/runs/autopilot/scratch/<run-id>.json`,
// written at allocation and removed only once the root is gone: the next
// run's start sweeps every entry whose driver is dead and whose run holds no
// open-run record (a dead run's cleanup removes that record first,
// dead-runs.mjs), never its own.
//
// A directory is renamed `.removing-<name>` before its contents go, so a
// removal a crash interrupted is finished by the next pass without judging a
// half-removed snapshot again. Removal is asynchronous and one at a time, and
// its failure is counted, never a step's or a check's outcome.
//
// Limits. A snapshot directory with no owner record that reads (a creation in
// flight, or a test's leftover) defers its step directory until someone
// removes it; `agentic-autopilot retention` lists what is deferred. On a
// machine whose users share /tmp and set no TMPDIR, the second user's run
// finds `agentic-ap` owned by another and does not start: set TMPDIR.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isAutopilotRun } from '../../../scripts/state.mjs';
import { AUTOPILOT_DIR_REL, holderAlive, processFingerprint } from '../../../scripts/lib/run-locks.mjs';
import { SNAPSHOT_OWNER_FILE, judgeRunEnded, removeOwnedSnapshot } from '../../../scripts/lib/peer-snapshot.mjs';
import { listOpenRuns, openRunPath } from './ledger.mjs';

export const SCRATCH_SCHEMA = 'agentic-autopilot-scratch-1.0';
export const SCRATCH_INDEX_SCHEMA = 'agentic-autopilot-scratch-index-1.0';
export const SCRATCH_HOME = 'agentic-ap';
const RUN_PREFIX = 'autopilot-';
/** The name of a run's root: its id without the prefix every run id has. */
export const scratchRootName = (runId) => runId.slice(RUN_PREFIX.length);
export const SCRATCH_MARKER = '.scratch.json';
const REMOVING = '.removing-';
const SNAPSHOT_DIR_MARK = '-peer-snapshot-';
const STEP_NAME = /^s[1-9]\d*$/;
const CHECK_NAME = /^v[1-9]\d*-\d+$/;
// The characters XML escapes: a peer's prompt names paths under TMPDIR.
const XML_SPECIAL = /[&<>"']/;

const validRunId = (id) => typeof id === 'string' && isAutopilotRun({ AGENTIC_AUTOPILOT: id });
const within = (child, parent) => {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};
// A JSON file's value, or null: only a regular file is opened, so a FIFO or a
// device in its place is refused, never waited on.
function readJsonFile(file) {
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
const gitEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));

/** The repository's common git directory, resolved; null when it cannot be read. */
export function commonDirOf(repoRoot) {
  const r = spawnSync('git', ['-C', repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8', env: gitEnv(), timeout: 30_000 });
  if (r.status !== 0 || !r.stdout.trim()) return null;
  try { return fs.realpathSync(r.stdout.trim()); } catch { return null; }
}

function worktreesOf(repoRoot) {
  const r = spawnSync('git', ['-C', repoRoot, 'worktree', 'list', '--porcelain', '-z'], { encoding: 'utf8', env: gitEnv(), timeout: 30_000 });
  if (r.status !== 0) return null;
  return r.stdout.split('\0').filter((f) => f.startsWith('worktree ')).map((f) => {
    const p = f.slice('worktree '.length);
    try { return fs.realpathSync(p); } catch { return path.resolve(p); }
  });
}

/**
 * The directory a run's root goes under: { base }, or { problem } when no
 * temporary directory lies outside every worktree of the repository. Never a
 * fallback into a worktree.
 */
export function scratchBase({ repoRoot, env = process.env, worktrees = worktreesOf }) {
  const trees = worktrees(repoRoot);
  if (trees === null) return { problem: `the worktrees of ${repoRoot} cannot be listed, so no temporary directory can be shown to lie outside them` };
  const candidates = [];
  for (const c of [typeof env.TMPDIR === 'string' && env.TMPDIR !== '' ? env.TMPDIR : os.tmpdir(), '/tmp']) {
    if (!path.isAbsolute(c)) continue;
    try {
      const real = fs.realpathSync.native(c);
      if (!candidates.includes(real)) candidates.push(real);
    } catch { /* a directory that does not resolve is skipped */ }
  }
  const base = candidates.find((c) => !trees.some((t) => within(c, t)) && !XML_SPECIAL.test(c));
  if (!base) {
    return { problem: `no temporary directory for the run's steps: TMPDIR (${env.TMPDIR ?? 'unset'}) and /tmp each lie inside a worktree of the repository, do not resolve, or hold a character XML escapes. Set TMPDIR to a directory outside every worktree` };
  }
  return { base };
}

// ---------------------------------------------------------------------------
// The shared index

export function scratchIndexDir(mainRoot) {
  return path.join(mainRoot, AUTOPILOT_DIR_REL, 'scratch');
}

function indexPath(mainRoot, runId) {
  if (!validRunId(runId)) throw new Error(`invalid run id ${runId}`);
  return path.join(scratchIndexDir(mainRoot), `${runId}.json`);
}

function writeJsonExclusive(file, value, mode = 0o600) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode });
}

export function removeScratchIndex(mainRoot, runId) {
  try {
    fs.unlinkSync(indexPath(mainRoot, runId));
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

/** Every entry of the index, oldest run first: [{ file, runId, record }], `record` null for one that does not read as its run's. */
export function listScratchIndex(mainRoot) {
  let names = [];
  try {
    names = fs.readdirSync(scratchIndexDir(mainRoot));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const runId = name.slice(0, -'.json'.length);
    if (!validRunId(runId)) continue;
    const file = path.join(scratchIndexDir(mainRoot), name);
    if (!fs.existsSync(file)) continue; // removed meanwhile
    let record = readJsonFile(file);
    if (record && (record.schema !== SCRATCH_INDEX_SCHEMA || record.run_id !== runId || typeof record.root !== 'string')) record = null;
    out.push({ file, runId, record });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Allocation

/**
 * Make a run's root, exclusively, with its marker and its index entry. Throws
 * when no base is usable, when `agentic-ap` there is not this user's
 * own directory, or when the root already exists: the run does not start.
 * Returns { root, base, commonDir }.
 */
export async function allocateScratch({ repoRoot, mainRoot, runId, env = process.env, pid = process.pid, now = () => Date.now() }) {
  if (!validRunId(runId)) throw new Error(`invalid run id ${runId}`);
  const { base, problem } = scratchBase({ repoRoot, env });
  if (problem) throw new Error(problem);
  const commonDir = commonDirOf(repoRoot);
  if (commonDir === null) throw new Error(`the common git directory of ${repoRoot} cannot be read, so the run's temporary directory cannot be tied to the repository`);
  const home = path.join(base, SCRATCH_HOME);
  const makeHome = () => {
    try {
      fs.mkdirSync(home, { mode: 0o700 });
    } catch (err) {
      if (err.code !== 'EEXIST') throw new Error(`the run's temporary directory could not be made under ${base} (${err.code ?? err.message}); set TMPDIR to a directory you can write to`);
    }
    const st = fs.lstatSync(home);
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    if (!st.isDirectory() || st.isSymbolicLink() || (uid !== null && st.uid !== uid)) {
      throw new Error(`${home} is not a directory of your own (a link, a file, or another user's): the run's temporary files cannot go there. Set TMPDIR to a directory of your own`);
    }
  };
  makeHome();
  const root = path.join(home, scratchRootName(runId));
  const createdAt = new Date(now()).toISOString();
  let repo = repoRoot;
  try { repo = fs.realpathSync(repoRoot); } catch { /* as given */ }
  // The index entry first: a crash from here on leaves an entry the next
  // sweep finds, whatever of the root was made (none, or one with no marker
  // yet, which it removes while empty).
  fs.mkdirSync(scratchIndexDir(mainRoot), { recursive: true });
  const fingerprint = await processFingerprint(pid);
  try {
    writeJsonExclusive(indexPath(mainRoot, runId), { schema: SCRATCH_INDEX_SCHEMA, run_id: runId, root, repo, common_dir: commonDir, pid, fingerprint, created_at: createdAt });
  } catch (err) {
    throw new Error(`the run's temporary directory could not be put on the index ${indexPath(mainRoot, runId)} (${err.code ?? err.message})`);
  }
  try {
    try {
      fs.mkdirSync(root, { mode: 0o700 });
    } catch (err) {
      // Another run's end removed the empty home between its making here and
      // this line (dropEmptyHome): made again, once, with the same checks.
      if (err.code !== 'ENOENT') throw err;
      makeHome();
      fs.mkdirSync(root, { mode: 0o700 });
    }
  } catch (err) {
    // Not this run's: the entry that would hand it to a sweep goes.
    try { removeScratchIndex(mainRoot, runId); } catch { /* the sweep refuses a root with another's marker */ }
    throw new Error(`the run's temporary directory ${root} could not be made exclusively (${err.code ?? err.message})`);
  }
  writeJsonExclusive(path.join(root, SCRATCH_MARKER), { schema: SCRATCH_SCHEMA, run_id: runId, repo, common_dir: commonDir, created_at: createdAt });
  return { root, base, commonDir };
}

// ---------------------------------------------------------------------------
// The guard

/**
 * Whether `dir` is a path of the run's root this module may remove, judged
 * from the paths alone (no file is read): { ok: true, kind: 'root' | 'step' |
 * 'check' | 'removing' } or { ok: false, why }.
 */
export function scratchTarget(dir, { root, runId } = {}) {
  const refuse = (why) => ({ ok: false, why });
  const plain = (p) => typeof p === 'string' && p !== '' && path.isAbsolute(p) && path.normalize(p) === p && !(p.length > 1 && p.endsWith(path.sep));
  if (typeof root !== 'string' || root === '') return refuse('no-root');
  if (!plain(root)) return refuse('root-not-absolute');
  if (!validRunId(runId)) return refuse('run-id');
  if (`${RUN_PREFIX}${path.basename(root)}` !== runId || path.basename(path.dirname(root)) !== SCRATCH_HOME) return refuse('root-layout');
  if (!plain(dir)) return refuse('dir-not-absolute');
  if (dir === root) return { ok: true, kind: 'root' };
  if (path.dirname(dir) !== root) return refuse('outside-root');
  const name = path.basename(dir);
  if (STEP_NAME.test(name)) return { ok: true, kind: 'step' };
  if (CHECK_NAME.test(name)) return { ok: true, kind: 'check' };
  if (name.startsWith(REMOVING) && name.length > REMOVING.length) return { ok: true, kind: 'removing' };
  return refuse('name');
}

export class ScratchRefusal extends Error {
  constructor(why, dir) {
    super(`refusing to remove ${JSON.stringify(dir)}: ${why}`);
    this.name = 'ScratchRefusal';
    this.why = why;
  }
}

/**
 * The proof a removal needs, read from the file system: throws ScratchRefusal
 * unless the root is a real directory reached through no link, whose marker
 * names this run and this repository, and `dir` is the root or a real
 * directory directly in it. Returns { kind, gone } (`gone`: no such child).
 */
export function proveScratch(dir, { root, runId, commonDir } = {}) {
  const t = scratchTarget(dir, { root, runId });
  if (!t.ok) throw new ScratchRefusal(t.why, dir);
  if (typeof commonDir !== 'string' || commonDir === '') throw new ScratchRefusal('no-repository', dir);
  let st;
  try { st = fs.lstatSync(root); } catch { throw new ScratchRefusal('root-missing', dir); }
  if (st.isSymbolicLink() || !st.isDirectory()) throw new ScratchRefusal('root-not-a-directory', dir);
  let real = null;
  try { real = fs.realpathSync.native(root); } catch { /* refused below */ }
  if (real !== root) throw new ScratchRefusal('root-through-a-link', dir);
  const marker = readJsonFile(path.join(root, SCRATCH_MARKER));
  if (marker === null || typeof marker !== 'object') throw new ScratchRefusal('no-marker', dir);
  if (marker.schema !== SCRATCH_SCHEMA || marker.run_id !== runId) throw new ScratchRefusal('marker-of-another-run', dir);
  if (marker.common_dir !== commonDir) throw new ScratchRefusal('marker-of-another-repository', dir);
  if (t.kind === 'root') return { kind: t.kind, gone: false };
  let ds;
  try {
    ds = fs.lstatSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return { kind: t.kind, gone: true };
    throw new ScratchRefusal(`unreadable (${err.code ?? err.message})`, dir);
  }
  if (ds.isSymbolicLink() || !ds.isDirectory()) throw new ScratchRefusal('not-a-directory', dir);
  return { kind: t.kind, gone: false };
}

// ---------------------------------------------------------------------------
// Whether a step's directory may still be in use

async function snapshotDirs(dir) {
  const found = [];
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop();
    let handle;
    try {
      handle = await fs.promises.opendir(cur);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw err;
    }
    for await (const ent of handle) {
      if (!ent.isDirectory()) continue;
      const p = path.join(cur, ent.name);
      if (ent.name.includes(SNAPSHOT_DIR_MARK)) found.push(p);
      else stack.push(p);
    }
  }
  return found.sort();
}

/**
 * null when nothing under `dir` may still be in use, else why it is kept. A
 * peer snapshot anywhere under it (any directory whose name holds
 * `-peer-snapshot-`) keeps it unless its run is proven over and the snapshot
 * was removed with its registration: no owner record, a run that is alive or
 * cannot be told, and a removal refused or failed all keep the directory.
 * Every snapshot is judged, so each whose run is over goes whatever keeps
 * another; the first reason found is the one returned.
 */
export async function scratchBusy(dir, { env = process.env } = {}) {
  let snapshots;
  try {
    snapshots = await snapshotDirs(dir);
  } catch (err) {
    return `it cannot be read (${err.code ?? err.message})`;
  }
  let reason = null;
  const keep = (why) => { reason ??= why; };
  for (const snap of snapshots) {
    const ownerPath = path.join(snap, SNAPSHOT_OWNER_FILE);
    let judged;
    let owner;
    let regular = false;
    try { regular = fs.lstatSync(ownerPath).isFile(); } catch { /* none */ }
    if (!regular) { keep(`the peer snapshot ${snap} has no owner record that reads`); continue; }
    try {
      ({ judged, owner } = await judgeRunEnded(ownerPath));
    } catch (err) {
      keep(`the peer snapshot ${snap} could not be judged (${err?.message ?? err})`);
      continue;
    }
    if (owner === null) { keep(`the peer snapshot ${snap} has no owner record that reads`); continue; }
    if (judged.verdict !== 'ended') { keep(`the peer snapshot ${snap} is not proven over (${judged.verdict}: ${judged.why})`); continue; }
    let removed;
    try {
      removed = await removeOwnedSnapshot(ownerPath, owner, { env });
    } catch (err) {
      removed = { removed: false, error: String(err?.message ?? err) };
    }
    if (removed.removed !== true) keep(`the peer snapshot ${snap} could not be removed (${removed.refused ?? removed.error ?? 'unknown'})`);
  }
  return reason;
}

// ---------------------------------------------------------------------------
// Removal

/**
 * Remove one directory of the run, proven first (proveScratch throws
 * otherwise): a step's or a check's is renamed `.removing-<name>` and then
 * removed with what it holds; the root only when empty but for its marker,
 * the marker last. Resolves 'removed' or 'gone'.
 */
export async function removeScratch(dir, ident, { rm = fs.promises.rm } = {}) {
  const p = proveScratch(dir, ident);
  if (p.kind === 'root') {
    const left = fs.readdirSync(ident.root).filter((n) => n !== SCRATCH_MARKER);
    if (left.length > 0) throw new Error(`${ident.root} is not empty (${left.slice(0, 3).join(', ')})`);
    try { fs.unlinkSync(path.join(ident.root, SCRATCH_MARKER)); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    fs.rmdirSync(ident.root);
    dropEmptyHome(ident.root);
    return 'removed';
  }
  if (p.gone) return 'gone';
  let target = dir;
  if (p.kind !== 'removing') {
    target = path.join(ident.root, `${REMOVING}${path.basename(dir)}`);
    if (fs.existsSync(target)) target = `${target}.${process.pid}.${Date.now()}`;
    fs.renameSync(dir, target);
  }
  await rm(target, { recursive: true, force: true, maxRetries: 2 });
  return 'removed';
}

// The home goes with its last root, so an ended run leaves nothing under the
// base. `rmdir` removes an empty directory and nothing else: a home that
// holds another run's root, a link, or one already gone stays as it is. The
// caller has judged `root` (its parent is named `agentic-ap`). A run that is
// starting meanwhile makes the home again (allocateScratch).
function dropEmptyHome(root) {
  const home = path.dirname(root);
  if (path.basename(home) !== SCRATCH_HOME) return;
  try { fs.rmdirSync(home); } catch { /* not empty, a link, or gone */ }
}

// Whether `root` is the run's own path (its layout), a real directory
// reached through no link, with nothing in it.
function emptyRoot(root, { runId }) {
  if (!scratchTarget(root, { root, runId }).ok) return false;
  try {
    const st = fs.lstatSync(root);
    return st.isDirectory() && !st.isSymbolicLink() && fs.realpathSync.native(root) === root && fs.readdirSync(root).length === 0;
  } catch {
    return false;
  }
}

/**
 * One pass over a run's root: every directory in it that is not held and not
 * busy is removed, and the root with them when nothing is left. Resolves
 * { removed, deferred: [{ dir, why }], failures: [{ dir, error }], rootRemoved,
 * refused } (`refused`: the root is not proven the run's, and nothing was
 * touched).
 */
export async function sweepScratch({ root, runId, commonDir, env = process.env, hold = new Map(), busy = scratchBusy, rm }) {
  const ident = { root, runId, commonDir };
  const result = { removed: 0, deferred: [], failures: [], rootRemoved: false, refused: null };
  try {
    proveScratch(root, ident);
  } catch (err) {
    result.refused = err instanceof ScratchRefusal ? err.why : String(err?.message ?? err);
    // A crash between the root's creation and its marker, or between the
    // marker's removal and the root's: an EMPTY real directory at the run's
    // own path goes (rmdir removes nothing else), and the sweep is done.
    if (result.refused === 'no-marker' && emptyRoot(root, ident)) {
      try {
        fs.rmdirSync(root);
        dropEmptyHome(root);
        result.refused = null;
        result.rootRemoved = true;
      } catch { /* not empty after all, or gone: refused as it was */ }
    }
    return result;
  }
  let names;
  try {
    names = fs.readdirSync(root).sort();
  } catch (err) {
    result.failures.push({ dir: root, error: String(err.code ?? err.message) });
    return result;
  }
  for (const name of names) {
    if (name === SCRATCH_MARKER) continue;
    const dir = path.join(root, name);
    const t = scratchTarget(dir, ident);
    if (!t.ok) {
      result.deferred.push({ dir, why: 'not a directory the run made' });
      continue;
    }
    if (hold.has(dir)) {
      result.deferred.push({ dir, why: hold.get(dir) });
      continue;
    }
    try {
      // Proven first: the scan below removes the snapshots whose runs are
      // over, so it never opens a link, or a root that is not the run's.
      if (proveScratch(dir, ident).gone) continue;
      // A check's directory holds no peer's snapshot of the run's (a check is
      // no worker); what a test left there under that name is the check's.
      const why = t.kind === 'step' ? await busy(dir, { env }) : null;
      if (why) {
        result.deferred.push({ dir, why });
        continue;
      }
      await removeScratch(dir, ident, rm ? { rm } : {});
      result.removed += 1;
    } catch (err) {
      result.failures.push({ dir, error: String(err?.message ?? err).slice(0, 300) });
    }
  }
  if (result.deferred.length === 0 && result.failures.length === 0) {
    try {
      await removeScratch(root, ident);
      result.rootRemoved = true;
    } catch (err) {
      result.failures.push({ dir: root, error: String(err?.message ?? err).slice(0, 300) });
    }
  }
  return result;
}

/**
 * The run's own handle on its root.
 *   stepDir(seq), checkDir(seq, index)  the paths
 *   make(dir)       create one (throws: the step or check does not start)
 *   release(dir, why)  the step or check ended: with `why`, the run holds the
 *                   directory (a group that outlived SIGKILL, peers it could
 *                   not account for); without, it is removed unless busy, in
 *                   the background, one at a time. Never throws or rejects.
 *   end({ sweep })  the run's end: the removals in flight, then (`sweep`) one
 *                   pass over the root; resolves the record run.json keeps.
 */
export function createRunScratch({ root, runId, commonDir, mainRoot, env = process.env, busy = scratchBusy, rm, now = () => Date.now() }) {
  const ident = { root, runId, commonDir };
  const hold = new Map();
  const deferred = new Map();
  let failures = 0;
  let chain = Promise.resolve();
  const fail = () => { failures += 1; };
  return {
    root,
    stepDir: (seq) => path.join(root, `s${seq}`),
    checkDir: (seq, index) => path.join(root, `v${seq}-${index}`),
    make(dir) {
      const t = scratchTarget(dir, ident);
      if (!t.ok || (t.kind !== 'step' && t.kind !== 'check')) throw new Error(`${JSON.stringify(dir)} is not a step or check directory of ${root}`);
      fs.mkdirSync(dir, { mode: 0o700 });
      return dir;
    },
    release(dir, why = null) {
      if (typeof why === 'string' && why !== '') {
        hold.set(dir, why);
        return chain;
      }
      chain = chain.then(async () => {
        // Proven before the scan, which removes the snapshots whose runs
        // are over (proveScratch throws for anything not the run's).
        const t = proveScratch(dir, ident);
        if (t.gone) return;
        const reason = t.kind === 'step' ? await busy(dir, { env }) : null;
        if (reason) {
          deferred.set(dir, reason);
          return;
        }
        await removeScratch(dir, ident, rm ? { rm } : {});
      }).catch(fail);
      return chain;
    },
    idle: () => chain,
    async end({ sweep = true } = {}) {
      await chain;
      const record = { root, deferred: [], failures, removed_at: null };
      if (!sweep) {
        // The run ended on an error: its steps in flight are unknown, and the
        // next run's sweep, after the dead-run cleanup, takes what is left.
        try {
          record.deferred = fs.readdirSync(root).filter((n) => n !== SCRATCH_MARKER).map((n) => ({ dir: path.join(root, n), why: hold.get(path.join(root, n)) ?? 'the run ended on an error; the next run removes it' }));
        } catch { /* gone, or unreadable: the next sweep says */ }
        return record;
      }
      const r = await sweepScratch({ ...ident, env, hold, busy, rm });
      record.deferred = r.refused ? [{ dir: root, why: `not proven the run's (${r.refused})` }] : r.deferred;
      record.failures = failures + r.failures.length;
      if (r.rootRemoved) {
        record.removed_at = new Date(now()).toISOString();
        try { removeScratchIndex(mainRoot, runId); } catch { record.failures += 1; }
      }
      return record;
    },
  };
}

/**
 * What earlier runs left: every index entry but the caller's own whose run
 * holds no open-run record and whose driver is gone is swept, and its entry
 * removed once its root is. Resolves [{ run_id, outcome: 'removed' | 'deferred'
 * | 'kept' | 'live', detail, deferred, failures }]. Never throws.
 */
export async function sweepLeftovers({ mainRoot, selfRunId = null, env = process.env, probe = processFingerprint, busy = scratchBusy, hooks = {} }) {
  const results = [];
  let entries;
  let open;
  let commonDir;
  try {
    entries = listScratchIndex(mainRoot);
    // An open-run record of any shape keeps its run's root: the run lives, or
    // its cleanup has not finished (its peers may still run).
    open = new Set(listOpenRuns(mainRoot).map((r) => r.runId));
    commonDir = commonDirOf(mainRoot);
  } catch (err) {
    return [{ run_id: null, outcome: 'kept', detail: `the leftover temporary directories cannot be listed (${err?.message ?? err})`, deferred: [], failures: [] }];
  }
  for (const { file, runId, record } of entries) {
    if (runId === selfRunId || open.has(runId)) continue;
    const base = { run_id: runId, deferred: [], failures: [] };
    try {
      if (!record) {
        results.push({ ...base, outcome: 'kept', detail: `its index entry ${file} does not read` });
        continue;
      }
      if (await holderAlive({ pid: record.pid, fingerprint: record.fingerprint, worker: null }, { probe })) {
        results.push({ ...base, outcome: 'live', detail: `its driver (pid ${record.pid}) is running` });
        continue;
      }
      if (hooks.afterJudged) await hooks.afterJudged(runId); // a test seam
      // Its driver is gone, so what it wrote is final: its open-run record is
      // read again here, never taken from the listing above, which a run
      // starting at the same time may have been absent from when it was
      // taken and then joined (and died, its workers alive).
      if (fs.existsSync(openRunPath(mainRoot, runId))) continue;
      let exists = true;
      try { fs.lstatSync(record.root); } catch (err) { if (err.code === 'ENOENT') exists = false; }
      if (!exists) {
        removeScratchIndex(mainRoot, runId);
        results.push({ ...base, root: record.root, outcome: 'removed', detail: 'its directory was already gone' });
        continue;
      }
      if (commonDir === null) {
        results.push({ ...base, root: record.root, outcome: 'kept', detail: 'the repository\'s common git directory cannot be read' });
        continue;
      }
      const r = await sweepScratch({ root: record.root, runId, commonDir, env, busy });
      if (r.refused) results.push({ ...base, root: record.root, outcome: 'kept', detail: `${record.root} is not proven that run's (${r.refused}); check it, then delete it and ${file}` });
      else if (r.rootRemoved) {
        removeScratchIndex(mainRoot, runId);
        results.push({ ...base, root: record.root, outcome: 'removed', detail: `removed ${record.root}` });
      } else results.push({ ...base, root: record.root, outcome: 'deferred', detail: `${r.deferred.length + r.failures.length} of its directories stay`, deferred: r.deferred, failures: r.failures });
    } catch (err) {
      results.push({ ...base, outcome: 'kept', detail: `the sweep failed (${err?.message ?? err})` });
    }
  }
  return results;
}

/** The lines a leftover sweep prints. */
export function describeLeftovers(results) {
  const lines = [];
  for (const r of results) {
    if (r.outcome === 'live') continue;
    lines.push(`${r.outcome === 'removed' ? 'temporary files of' : '⚠ temporary files of'} run ${r.run_id ?? '(unknown)'}: ${r.detail}`);
    for (const d of r.deferred ?? []) lines.push(`  · kept ${d.dir}: ${d.why}`);
    for (const f of r.failures ?? []) lines.push(`  ✗ ${f.dir}: ${f.error}`);
  }
  return lines;
}
