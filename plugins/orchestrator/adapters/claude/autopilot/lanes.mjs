// plugins/orchestrator/adapters/claude/autopilot/lanes.mjs
//
// ADR-0067 Decision 5 — lanes: placement, ownership, lifecycle,
// reconciliation. A lane is one subtask attempt's git worktree, on
// `subtasks[i].branch`, at `<P>/<M>-lanes/<macro-id>/<subtask-id>`, where M is
// the main worktree's directory name and P its parent (the repository's
// identity, never the launching checkout's).
//
//   - Ownership is a git worktree lock whose reason is
//     `agentic-autopilot <macro-id> <subtask-id>`: creating the worktree and
//     marking it as the driver's are one git operation, a locked worktree
//     refuses `git worktree remove`, and `prune` keeps it. The run ledger
//     records each lane event (`lanes.jsonl`, ledger.mjs), but the lock
//     reason, not the ledger, proves ownership.
//   - A lane's identity is a random lane id in
//     `<lane>/.agentic-plugins/runs/autopilot/lane.json` (per checkout,
//     ignored), so a worktree created later at the same path has none, or
//     another.
//   - A removal is announced in
//     `<main>/.agentic-plugins/runs/autopilot/lanes/<macro-id>.jsonl` before
//     the unlock erases the ownership proof, and closed there (`done` or
//     `kept`), so a crash between the unlock and the remove is recovered.
//
// Nothing here forces anything: no `--force`, no `prune` (it has no path
// selector, and another worktree's metadata may become prunable meanwhile),
// no branch deletion (the owner prunes branches). A worktree this module did
// not create, or cannot prove it created, is reported and never touched.
//
// The scheduler that spawns steps into lanes is DL's (Decision 6); this module
// is the layer it calls: reconcileLanes at the start of a run with lanes,
// createLane once a lane's first step is admitted, removeLane once
// /orchestrator:done has recorded the subtask completed, stepPlacement for
// each step's checkout and state root.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { appendLaneEvent } from './ledger.mjs';
import { isSafeBranch, isSafeMacroId, isSafeSubtaskId } from './policy.mjs';
import { subtaskReadiness } from '../../../scripts/state.mjs';
import { acquireLock, AUTOPILOT_DIR_REL, holderAlive, readLockEntries, worktreeLockPath } from '../../../scripts/lib/run-locks.mjs';
import {
  attestationChecks, checkStateBase, gitCommonDir, isUnderLanesDirectory, lanesDirectory, readSharedCreation, sameDirectory,
  SHARED_HOMES, STATE_BASE_ENV,
} from '../../../scripts/lib/state-root.mjs';

export const LANE_FILE_REL = `${AUTOPILOT_DIR_REL}/lane.json`;
export const LANE_SCHEMA = 'agentic-autopilot-lane-1.0';
// The shared-record directories of Decision 1(a) inside each shared home: a
// record there was written by an older persona, or by an owner or Codex
// session in the lane, and `git worktree remove` would delete it (it deletes
// ignored files without --force; measured 2026-10-07, git 2.54).
export const SHARED_RECORD_DIRS = Object.freeze(['workflows', 'archive', 'peer-runs', 'consensus']);
// The four directories each checkout a worker writes in must ignore (the
// driver's preflight, per lane).
const IGNORED_STATE = ['runs', 'state', 'tmp', 'cache'];
const GIT_TIMEOUT_MS = 30_000;
const FETCH_TIMEOUT_MS = 120_000;
const LOCK_REASON_RE = /^agentic-autopilot (\S+) (\S+)$/;

export class LaneError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LaneError';
  }
}

function git(cwd, args, { env = process.env, timeout = GIT_TIMEOUT_MS } = {}) {
  const r = spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
  return {
    code: r.status,
    stdout: (r.stdout ?? '').replace(/\n$/, ''),
    stderr: ((r.stderr ?? '').trim() || (r.error ? r.error.message : '')).split('\n').slice(-3).join(' '),
  };
}

const real = (p) => {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
};
const exists = (p) => {
  try { fs.lstatSync(p); return true; } catch { return false; }
};
const halt = (detail, extra = {}) => ({ reason: 'owner-choice', detail, ...extra });
const within = (child, parent) => {
  const rel = path.relative(real(parent), real(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/**
 * Why a lane must not be removed although it is ours: it holds, or lies
 * inside, a path the run needs — the driver's own checkout, its run ledger,
 * the effective state root (ADR-0067 Decision 2: "the driver also never
 * removes the worktree that holds the effective state root or its own run
 * ledger"). A driver launched inside a lane would otherwise delete its own
 * ledger and locks with it. Null when none is.
 */
export function protectedOverlap(lane, protect = []) {
  for (const p of protect) {
    if (typeof p !== 'string' || p === '') continue;
    if (within(p, lane) || within(lane, p)) return `the lane ${lane} holds ${p}, which this run needs`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Placement and identity

/**
 * Where this repository's lanes live: { mainRoot, lanesDir }, or { problem }
 * for a repository with no shared root — a git common dir not named `.git`
 * (as a bare repository's usually is), where each worktree's default state
 * root would be its own, or a main checkout that cannot be attested (a
 * separate git dir), where the switch that lanes require is never turned on.
 */
export function laneHome(checkout) {
  const common = gitCommonDir(path.resolve(checkout));
  if (!common) return { problem: `${checkout} is not in a git repository whose identity can be read` };
  if (path.basename(common) !== '.git') {
    return { problem: `the repository's git common dir (${common}) is not named .git: each worktree's default state root would be its own, so lanes have no shared root (ADR-0067 Decision 5)` };
  }
  const mainRoot = real(path.dirname(common));
  const attested = attestationChecks(mainRoot);
  if (!attested.ok) {
    return { problem: `the main checkout ${mainRoot} cannot be attested (${attested.checks.filter((c) => !c.ok).map((c) => c.detail).join('; ')}), so shared creation, which lanes require, is never turned on (ADR-0067 Decision 5)` };
  }
  return { mainRoot, lanesDir: lanesDirectory(mainRoot) };
}

export function lanePath(home, macroId, subtaskId) {
  if (!isSafeMacroId(macroId)) throw new LaneError(`not a macro id: ${JSON.stringify(macroId)}`);
  if (!isSafeSubtaskId(subtaskId)) throw new LaneError(`not a subtask id: ${JSON.stringify(subtaskId)}`);
  return path.join(home.lanesDir, macroId, subtaskId);
}

export function lockReason(macroId, subtaskId) {
  if (!isSafeMacroId(macroId) || !isSafeSubtaskId(subtaskId)) throw new LaneError(`no lock reason for ${macroId} ${subtaskId}`);
  return `agentic-autopilot ${macroId} ${subtaskId}`;
}

/** { macroId, subtaskId } of a lock reason this module writes, or null. */
export function parseLockReason(reason) {
  const m = LOCK_REASON_RE.exec(reason ?? '');
  if (!m || !isSafeMacroId(m[1]) || !isSafeSubtaskId(m[2])) return null;
  return { macroId: m[1], subtaskId: m[2] };
}

/**
 * Every worktree of the repository, from `git worktree list --porcelain -z`:
 * [{ path, head, branch, detached, bare, locked, lockReason, prunable }]. git
 * lists each path as its real path. Throws LaneError when git cannot list
 * them: an unlisted lane would go unreconciled.
 */
export function listWorktrees(checkout, { env = process.env } = {}) {
  const r = spawnSync('git', ['-C', checkout, 'worktree', 'list', '--porcelain', '-z'], { env, encoding: 'utf8', timeout: GIT_TIMEOUT_MS });
  if (r.status !== 0) throw new LaneError(`git worktree list failed in ${checkout}: ${(r.stderr ?? '').trim() || r.error?.message || `exit ${r.status}`}`);
  const out = [];
  let cur = null;
  const flush = () => { if (cur) out.push(cur); cur = null; };
  for (const field of r.stdout.split('\0')) {
    if (field === '') { flush(); continue; }
    if (field.startsWith('worktree ')) {
      flush();
      cur = { path: field.slice('worktree '.length), head: null, branch: null, detached: false, bare: false, locked: false, lockReason: null, prunable: false };
      continue;
    }
    if (!cur) continue;
    if (field.startsWith('HEAD ')) cur.head = field.slice('HEAD '.length);
    else if (field.startsWith('branch refs/heads/')) cur.branch = field.slice('branch refs/heads/'.length);
    else if (field === 'detached') cur.detached = true;
    else if (field === 'bare') cur.bare = true;
    else if (field === 'locked') cur.locked = true;
    else if (field.startsWith('locked ')) { cur.locked = true; cur.lockReason = field.slice('locked '.length); }
    else if (field === 'prunable' || field.startsWith('prunable ')) cur.prunable = true;
  }
  flush();
  return out;
}

export function laneIdentityPath(lane) {
  return path.join(lane, LANE_FILE_REL);
}

export const newLaneId = () => randomBytes(8).toString('hex');

/** { state: 'absent' } | { state: 'ok', identity } | { state: 'unreadable', error } */
export function readLaneIdentity(lane) {
  const file = laneIdentityPath(lane);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { state: 'absent' };
    return { state: 'unreadable', error: `cannot read ${file} (${err.code || err.message})` };
  }
  try {
    const identity = JSON.parse(text);
    if (identity?.schema !== LANE_SCHEMA || typeof identity.lane_id !== 'string' || !/^[0-9a-f]{16}$/.test(identity.lane_id)) {
      return { state: 'unreadable', error: `${file} is not a lane identity (${LANE_SCHEMA})` };
    }
    return { state: 'ok', identity };
  } catch (err) {
    return { state: 'unreadable', error: `cannot parse ${file} (${err.message})` };
  }
}

/**
 * Write a lane's identity, never over one already there (a hard link of a
 * whole temporary file: a reader sees no file or the whole one). Resolves to
 * the identity written; throws when one is already there or the write fails.
 */
export function writeLaneIdentity(lane, { macroId, subtaskId, branch, laneId = newLaneId(), now = new Date() }) {
  const file = laneIdentityPath(lane);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const identity = { schema: LANE_SCHEMA, lane_id: laneId, macro_id: macroId, subtask_id: subtaskId, branch, created_at: now.toISOString() };
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(identity, null, 2)}\n`, { flag: 'wx' });
  try {
    fs.linkSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return identity;
}

// ---------------------------------------------------------------------------
// Removal intents, beside the macro lock under the main worktree

export function intentsPath(mainRoot, macroId) {
  if (!isSafeMacroId(macroId)) throw new LaneError(`not a macro id: ${JSON.stringify(macroId)}`);
  return path.join(mainRoot, AUTOPILOT_DIR_REL, 'lanes', `${macroId}.jsonl`);
}

export function appendIntent(mainRoot, macroId, record) {
  const file = intentsPath(mainRoot, macroId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
}

export function readIntents(mainRoot, macroId) {
  let text = '';
  try { text = fs.readFileSync(intentsPath(mainRoot, macroId), 'utf8'); } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn */ }
  }
  return out;
}

/** The intents not yet closed by a later `done` or `kept` record of the same lane id and path. */
export function openIntents(mainRoot, macroId) {
  const open = new Map();
  for (const r of readIntents(mainRoot, macroId)) {
    if (typeof r?.lane_id !== 'string' || typeof r?.path !== 'string') continue;
    const key = `${r.lane_id}\0${r.path}`;
    if (r.event === 'intent') open.set(key, r);
    else if (r.event === 'done' || r.event === 'kept') open.delete(key);
  }
  return [...open.values()];
}

// ---------------------------------------------------------------------------
// The rollback fence (Decision 4, item 4)

/**
 * Record in the shared-creation switch that lanes have run
 * (`lanes_first_run_at`), once: the cutover's rollback refuses from then on,
 * since the lanes' workflows live in the default state root and no single
 * home serves both the old tuple and them. Written before the first lane's
 * `git worktree add`, so a crash between the two leaves the fence set and no
 * lane, never a lane and no fence; the reconciliation sets it too when it
 * finds a lane of ours and none. Refuses unless shared creation is on.
 * Resolves to { changed, at }.
 */
export function markLanesFirstRun(checkout, { now = new Date() } = {}) {
  const sw = readSharedCreation(checkout);
  if (sw.state !== 'on') throw new LaneError(`lanes need shared creation on (it is ${sw.state}${sw.error ? `: ${sw.error}` : ''})`);
  if (sw.record.lanes_first_run_at) return { changed: false, at: sw.record.lanes_first_run_at };
  const at = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const tmp = `${sw.path}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ ...sw.record, lanes_first_run_at: at }, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(tmp, sw.path);
  return { changed: true, at };
}

// ---------------------------------------------------------------------------
// Checks

/**
 * Creation step 1: refresh `refs/remotes/origin/<baseline>`, and only it
 * (`--no-tags`, and an empty `--refmap=` so no configured mapping updates a
 * local ref). { ok: true, ref, tip, warning? } — a failed fetch falls back to
 * the last fetched ref, with a warning — or { ok: false, halt } when there is
 * no such ref.
 */
export function fetchBaseline({ checkout, baseline, env = process.env }) {
  if (!isSafeBranch(baseline)) return { ok: false, halt: halt(`the macro's baseline branch ${JSON.stringify(baseline)} is not a branch name the driver uses`) };
  const ref = `refs/remotes/origin/${baseline}`;
  const f = git(checkout, ['fetch', '--quiet', '--no-tags', '--refmap=', 'origin', `+refs/heads/${baseline}:${ref}`], { env, timeout: FETCH_TIMEOUT_MS });
  const tip = git(checkout, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { env });
  if (tip.code !== 0 || !tip.stdout) {
    return { ok: false, halt: halt(`no ${ref} to cut or check a lane against${f.code === 0 ? '' : ` (git fetch origin ${baseline} failed: ${f.stderr})`}; fetch it, then relaunch`) };
  }
  return {
    ok: true, ref, tip: tip.stdout,
    ...(f.code === 0 ? {} : { warning: `git fetch origin ${baseline} failed (${f.stderr}); using the last fetched ${ref} at ${tip.stdout}` }),
  };
}

function branchTip(checkout, branch, env) {
  const r = git(checkout, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], { env });
  return r.code === 0 && r.stdout ? r.stdout : null;
}

// Whether a lane's worktree lock has a live participant other than `exclude`
// (a run driving it, or an owner session's admission there).
async function laneLockHeld(lane, exclude) {
  for (const e of readLockEntries(worktreeLockPath(lane))) {
    if (exclude && e.file === exclude) continue;
    if (e.session || e.holder === null || await holderAlive(e.holder)) return true;
  }
  return false;
}

/**
 * The removal check, made while the lane is still locked: it is clean, and
 * no shared-record directory in it holds anything. { ok } or { ok: false, why }.
 */
export function removalCheck(lane, { env = process.env } = {}) {
  const st = git(lane, ['status', '--porcelain', '--untracked-files=normal'], { env });
  if (st.code !== 0) return { ok: false, why: `git status failed in ${lane}: ${st.stderr}` };
  if (st.stdout !== '') {
    const lines = st.stdout.split('\n');
    return { ok: false, why: `the lane is not clean: ${lines.slice(0, 3).join('; ')}${lines.length > 3 ? ` (+${lines.length - 3})` : ''}` };
  }
  for (const home of SHARED_HOMES) {
    for (const d of SHARED_RECORD_DIRS) {
      const dir = path.join(lane, home.rel, d);
      let names;
      try { names = fs.readdirSync(dir); } catch (err) {
        if (err.code === 'ENOENT') continue;
        return { ok: false, why: `cannot read ${dir} (${err.code || err.message})` };
      }
      if (names.length > 0) {
        return { ok: false, why: `${path.join(home.rel, d)} in the lane holds ${names.length} entr${names.length === 1 ? 'y' : 'ies'} (${names.slice(0, 3).join(', ')}): a shared record there would be lost with the lane` };
      }
    }
  }
  return { ok: true };
}

/** The preflight per lane: the four agentic state directories are ignored there. */
export function lanePreflight(lane, { env = process.env } = {}) {
  const unignored = IGNORED_STATE.filter((d) => git(lane, ['check-ignore', '-q', `.agentic-plugins/${d}/x`], { env }).code !== 0);
  return unignored.length === 0 ? null : `.agentic-plugins/{${unignored.join(',')}}/ is not gitignored in the lane ${lane}`;
}

// ---------------------------------------------------------------------------
// Facts and the rows

/**
 * Everything reconciliation reads, in one look: the worktrees, our lanes with
 * their identity, unlocked worktrees at our lane paths, the open removal
 * intents, each subtask's branch and its tip, the baseline tip, and the macro
 * as the observer read it (`view`: plan, children, claims). Readiness is
 * computed from the plan, every subtask's (next-ready names only the first
 * ready one). The tips are read after the caller's fetchBaseline, so a view
 * observed with `fetch: false` keeps that the only fetch they depend on.
 */
export function gatherLaneFacts({ home, checkout, macroId, view, baseline, env = process.env }) {
  const worktrees = listWorktrees(home.mainRoot, { env });
  const lanesReal = real(home.lanesDir);
  const macroDir = path.join(lanesReal, macroId);
  const under = (p, dir) => {
    const rel = path.relative(dir, real(p));
    return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
  };
  const ours = [];
  const atOurPaths = [];
  const others = [];
  for (const w of worktrees) {
    const reason = w.lockReason === null ? null : parseLockReason(w.lockReason);
    const present = exists(w.path);
    if (w.locked && reason && reason.macroId === macroId) {
      ours.push({ ...w, subtaskId: reason.subtaskId, present, identity: present ? readLaneIdentity(w.path) : { state: 'absent' } });
    } else if (!w.locked && under(w.path, macroDir) && path.dirname(real(w.path)) === macroDir) {
      atOurPaths.push({ ...w, present, identity: present ? readLaneIdentity(w.path) : { state: 'absent' } });
    } else if (under(w.path, lanesReal)) {
      others.push({ ...w, present, reason });
    }
  }
  const subtasks = Array.isArray(view?.macro?.fm?.plan?.subtasks) ? view.macro.fm.plan.subtasks : [];
  const branches = {};
  for (const s of subtasks) {
    if (typeof s?.branch !== 'string' || !isSafeBranch(s.branch)) continue;
    const holder = worktrees.find((w) => w.branch === s.branch) ?? null;
    branches[s.branch] = { tip: branchTip(checkout, s.branch, env), heldBy: holder ? holder.path : null };
  }
  const baseTip = git(checkout, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${baseline}^{commit}`], { env });
  const sw = readSharedCreation(home.mainRoot);
  return {
    sharedCreation: sw.state,
    lanesFirstRunAt: sw.state === 'on' ? (sw.record.lanes_first_run_at ?? null) : undefined,
    macroId,
    mainRoot: home.mainRoot,
    lanesDir: lanesReal,
    driverCheckout: real(checkout),
    worktrees,
    ours,
    atOurPaths,
    others,
    intents: openIntents(home.mainRoot, macroId),
    subtasks,
    children: view?.children ?? {},
    claims: view?.claims ?? [],
    // A look that could not list the claims cannot tell a subtask unclaimed.
    claimsError: view?.claimsError ?? null,
    readiness: subtaskReadiness(subtasks),
    branches,
    baseline,
    baseTip: baseTip.code === 0 && baseTip.stdout ? baseTip.stdout : null,
  };
}

const claimsOf = (facts, id) => facts.claims.filter((c) => c?.originating_subtask === id);

/**
 * The subtask rows (10–12) for one subtask the run would give a lane, or
 * that a creation is about to give one: { action } or { halt }.
 *   - action 'existing-branch': attach the lane to the branch (rows 10, 12);
 *   - action 'new-branch': cut the branch from the baseline (no row matched);
 *   - action 'none': the subtask is not one the run would give a lane.
 */
export function judgeSubtask(facts, subtask) {
  const id = subtask?.id;
  const branch = subtask?.branch;
  if (!isSafeSubtaskId(id) || !isSafeBranch(branch)) return { halt: halt(`subtask ${id ?? '?'} has no branch the driver can give a lane`) };
  const child = facts.children[id];
  const live = subtask.status === 'in_progress' && child?.location === 'active';
  const ready = subtask.status === 'pending' && facts.readiness.find((r) => r?.id === id)?.ready === true;
  if (!live && !ready) return { action: 'none' };
  const b = facts.branches[branch] ?? { tip: null, heldBy: null };
  const lanePathFor = path.join(facts.lanesDir, facts.macroId, id);
  const heldByOurLane = b.heldBy !== null && facts.ours.some((l) => l.subtaskId === id && real(l.path) === real(b.heldBy));
  // Row 10: in progress, its live child on branch B, B checked out nowhere.
  if (live && child.branch === branch && b.heldBy === null) return { row: 10, action: 'existing-branch' };
  // Row 11: its branch is checked out in a worktree that is not one of our lanes.
  if (b.heldBy !== null && !heldByOurLane) {
    const driver = real(b.heldBy) === facts.driverCheckout;
    return {
      row: 11,
      halt: halt(driver
        ? `subtask ${id}'s branch ${branch} is checked out in the driver's own checkout (${b.heldBy}): switch it off ${branch} and relaunch, so the subtask can have a lane (git checks a branch out in one worktree only)`
        : `subtask ${id}'s branch ${branch} is checked out in ${b.heldBy}, a worktree that is not one of this run's lanes: free it there, then relaunch (the driver never forces a worktree)`,
      { subtaskId: id }),
    };
  }
  if (ready) {
    const claims = claimsOf(facts, id);
    if (claims.length > 0) {
      return { halt: halt(`subtask ${id} is pending, but the engineer workflow ${claims[0].id ?? claims[0].path} claims it: the dispatch stopped before it recorded the subtask in progress; re-attach it with /orchestrator:next ${id}`, { subtaskId: id }) };
    }
    // Row 12: pending, its branch exists, no workflow of the macro claims it.
    if (b.tip !== null) {
      if (facts.baseTip !== null && b.tip === facts.baseTip) return { row: 12, action: 'existing-branch' };
      return {
        row: 12,
        halt: halt(`subtask ${id}'s branch ${branch} exists at ${b.tip.slice(0, 12)}, which is not refs/remotes/origin/${facts.baseline} (${facts.baseTip ? facts.baseTip.slice(0, 12) : 'missing'}): a branch behind would omit a landed predecessor, one ahead would carry foreign history (ADR-0062 Decision 2); remove or reset it, then relaunch`, { subtaskId: id }),
      };
    }
    return { action: 'new-branch', path: lanePathFor };
  }
  // In progress with its live child on another branch than the plan's: the
  // observer reports that as a linkage mismatch, which the policy halts on.
  return { action: 'none' };
}

/**
 * The reconciliation plan, from the facts alone: the rows of Decision 5 in
 * their groups, the first match in a group deciding. Pure: it writes nothing.
 * { prepass: [...], lanes: [...], unlocked: [...], subtasks: [...], others: [...], halts: [...] }
 */
export function planReconciliation(facts) {
  const plan = { prepass: [], lanes: [], unlocked: [], subtasks: [], others: [], halts: [] };
  if (facts.claimsError) {
    plan.halts.push({ row: null, ...halt(`the engineer workflows claiming the macro could not be listed (${facts.claimsError}): no subtask can be judged unclaimed`) });
    return plan;
  }
  const listed = new Set(facts.worktrees.map((w) => real(w.path)));
  // Pre-pass: an open intent whose path git no longer lists finished before a
  // crash; a lane of ours with no identity gets one while it is locked.
  for (const i of facts.intents) {
    if (!listed.has(real(i.path))) plan.prepass.push({ kind: 'intent-done', intent: i });
  }
  for (const l of facts.ours) {
    if (l.present && l.identity.state === 'absent') plan.prepass.push({ kind: 'assign-identity', lane: l });
  }
  // The rollback fence, when a lane of ours exists and the switch lacks it (a
  // lane created by hand with our reason, or a switch rewritten since).
  if (facts.ours.length > 0 && facts.lanesFirstRunAt === null) plan.prepass.push({ kind: 'mark-first-run' });

  // Our lanes: each worktree that carries our lock reason.
  const bySubtask = new Map(facts.subtasks.map((s) => [s?.id, s]));
  for (const l of [...facts.ours].sort((a, b) => a.path.localeCompare(b.path))) {
    const s = bySubtask.get(l.subtaskId);
    const entry = { lane: l, subtaskId: l.subtaskId };
    if (!l.present) {
      plan.halts.push({ row: 1, ...halt(`the lane ${l.path} of subtask ${l.subtaskId} is gone, but git still registers it there; when you no longer need it, run: git worktree unlock ${l.path} && git worktree prune (the driver never prunes)`, { subtaskId: l.subtaskId }) });
      plan.lanes.push({ ...entry, row: 1, action: 'halt' });
      continue;
    }
    if (l.identity.state === 'unreadable') {
      plan.halts.push({ row: null, ...halt(`the lane ${l.path}'s identity is unreadable (${l.identity.error}); repair or remove it`, { subtaskId: l.subtaskId }) });
      plan.lanes.push({ ...entry, row: null, action: 'halt' });
      continue;
    }
    if (!s) { plan.lanes.push({ ...entry, row: 2, action: 'keep', report: `subtask ${l.subtaskId} is no longer in the plan; its lane ${l.path} is kept for you to remove` }); continue; }
    if (l.branch !== s.branch) {
      plan.halts.push({ row: 3, ...halt(`the lane ${l.path} is on ${l.branch ?? 'no branch'}, but the plan now gives subtask ${s.id} ${s.branch}: a lane is never re-pointed; remove it, then relaunch`, { subtaskId: s.id }) });
      plan.lanes.push({ ...entry, row: 3, action: 'halt' });
      continue;
    }
    const claimed = claimsOf(facts, s.id).length > 0;
    if (s.status === 'pending' && !claimed) {
      if (facts.baseTip !== null && l.head === facts.baseTip) {
        plan.lanes.push({ ...entry, row: 4, action: 'prepared', ready: facts.readiness.find((r) => r?.id === s.id)?.ready === true });
      } else {
        plan.halts.push({ row: 4, ...halt(`the prepared lane ${l.path} (subtask ${s.id}, branch ${s.branch}) is at ${l.head?.slice(0, 12) ?? '?'}, but refs/remotes/origin/${facts.baseline} is at ${facts.baseTip?.slice(0, 12) ?? 'missing'}: the baseline moved since the lane was cut; remove the lane and its branch, then relaunch`, { subtaskId: s.id }) });
        plan.lanes.push({ ...entry, row: 4, action: 'halt' });
      }
      continue;
    }
    if (s.status === 'pending' && claimed) {
      plan.halts.push({ row: 5, ...halt(`subtask ${s.id} is pending, but an engineer workflow of the macro claims it (in the lane ${l.path}): the dispatch stopped before it recorded the subtask in progress; re-attach it with /orchestrator:next ${s.id}`, { subtaskId: s.id }) });
      plan.lanes.push({ ...entry, row: 5, action: 'halt' });
      continue;
    }
    if (s.status === 'in_progress') { plan.lanes.push({ ...entry, row: 6, action: 'adopt' }); continue; }
    if (s.status === 'completed' && l.removal?.ok === true) { plan.lanes.push({ ...entry, row: 7, action: 'remove' }); continue; }
    plan.lanes.push({ ...entry, row: 8, action: 'keep', report: `the lane ${l.path} of subtask ${s.id} (${s.status}) is kept${l.removal && !l.removal.ok ? `: ${l.removal.why}` : ''}` });
  }

  // Unlocked worktrees at our lane paths.
  for (const w of facts.atOurPaths) {
    const intent = facts.intents.find((i) => real(i.path) === real(w.path));
    if (intent && w.identity.state === 'ok' && w.identity.identity.lane_id === intent.lane_id) {
      plan.unlocked.push({ row: 9, worktree: w, intent, action: w.removal?.ok === true ? 'finish-removal' : 'relock' });
    } else {
      plan.others.push({ row: 13, worktree: w, report: `${w.path} is at a lane path of this macro, unlocked, and not provably ours; it is left alone` });
    }
  }

  // Subtasks the run would give a lane, when no lane of ours holds them.
  const held = new Set(facts.ours.map((l) => l.subtaskId));
  for (const s of facts.subtasks) {
    if (!s || held.has(s.id)) continue;
    const j = judgeSubtask(facts, s);
    if (j.halt) { plan.halts.push({ row: j.row ?? null, ...j.halt }); plan.subtasks.push({ subtaskId: s.id, row: j.row ?? null, action: 'halt' }); continue; }
    if (j.action !== 'none') plan.subtasks.push({ subtaskId: s.id, row: j.row ?? null, action: j.action });
  }

  // Everything else under the lanes directory.
  for (const w of facts.others) {
    plan.others.push({ row: 13, worktree: w, report: `${w.path} is under the lanes directory without this macro's lock reason${w.reason ? ` (it names ${w.reason.macroId} ${w.reason.subtaskId})` : ''}; it is left alone` });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// The writers

function relock(mainRoot, lane, reason, env) {
  return git(mainRoot, ['worktree', 'lock', '--reason', reason, lane], { env });
}

/**
 * Why the worktree at `lane` is no longer the lane `laneId` as the next step
 * of a removal expects it, or null while it is: listed, locked with `reason`
 * (or, `unlocked`, not locked at all), and its identity that lane id. Every
 * step that acts on a lane reads this again first, from git and the lane, so
 * a worktree that replaced the lane at its path, or one someone locked,
 * is never taken for it.
 */
function changedSince({ mainRoot, lane, laneId, reason, unlocked, env }) {
  let w;
  try {
    w = listWorktrees(mainRoot, { env }).find((x) => real(x.path) === real(lane));
  } catch (err) {
    return err.message;
  }
  if (!w) return 'git no longer lists it';
  if (unlocked ? w.locked : !(w.locked && w.lockReason === reason)) return `locked ${w.locked}, reason ${JSON.stringify(w.lockReason)}`;
  const id = readLaneIdentity(lane);
  if (id.state !== 'ok' || id.identity.lane_id !== laneId) return `identity ${id.identity?.lane_id ?? id.state}, not ${laneId}`;
  return null;
}

/**
 * Lock an unlocked lane again with our reason, only while it is still the
 * lane `laneId`: a worktree that replaced it at its path is not ours to lock.
 * What is left between the re-read and the lock is the lock itself.
 */
function relockIfOurs({ mainRoot, lane, laneId, reason, env }) {
  const changed = changedSince({ mainRoot, lane, laneId, reason, unlocked: true, env });
  if (changed) return { code: 1, stderr: `it is no longer the lane ${laneId}: ${changed}` };
  return relock(mainRoot, lane, reason, env);
}

/**
 * Unlock and remove one lane whose removal check passed: the intent first
 * (the unlock erases the proof), then `unlock` and `remove` without --force.
 * Ownership is read again where each step acts, not where the lane was
 * judged: before the unlock (still listed, locked with our reason — or, for
 * row 9, unlocked, with no unlock to run — and its identity the intent's),
 * and once more before the remove, with the lane's worktree lock (a session
 * that joined it meanwhile keeps the lane). After the unlock the removal
 * check is made again, so the window in which a record written in the lane
 * is lost is the remove itself (the ADR's residual race: nothing excludes a
 * writer from an ignored directory). A remove that refuses, or a lane a
 * session joined, is locked again with the same reason and its intent closed
 * `kept`; when that lock fails, or the worktree there is no longer the lane,
 * the intent stays open, the only proof left that the unlocked lane is ours
 * (row 9 next time). git's messages are never read: they are translated.
 * `hooks.afterUnlock` and `hooks.beforeRemove` (before the last ownership
 * read and the remove) are test seams.
 * { outcome: 'removed' } or { outcome: 'kept', why }.
 */
async function unlockAndRemove({ mainRoot, macroId, subtaskId, lane, laneId, runId, runDir, now, env, intentWritten = false, ownLaneLock = null, hooks = {} }) {
  const reason = lockReason(macroId, subtaskId);
  const at = () => new Date(now()).toISOString();
  const base = { path: lane, lane_id: laneId, subtask_id: subtaskId, run_id: runId };
  const keep = (why, { unlocked }) => {
    if (unlocked) {
      const again = relockIfOurs({ mainRoot, lane, laneId, reason, env });
      if (again.code !== 0) {
        const detail = `${why}; locking it again failed (${again.stderr}), so its removal intent stays open`;
        if (runDir) appendLaneEvent(runDir, { event: 'kept', ...base, at: at(), why: detail });
        return { outcome: 'kept', why: detail };
      }
    }
    appendIntent(mainRoot, macroId, { event: 'kept', ...base, at: at(), why });
    if (runDir) appendLaneEvent(runDir, { event: 'kept', ...base, at: at(), why });
    return { outcome: 'kept', why };
  };
  const changed = changedSince({ mainRoot, lane, laneId, reason, unlocked: intentWritten, env });
  if (changed) {
    const why = `the lane ${lane} changed after it was judged (${changed}); it is left as it is`;
    if (runDir) appendLaneEvent(runDir, { event: 'kept', ...base, at: at(), why });
    return { outcome: 'kept', why };
  }
  if (!intentWritten) {
    appendIntent(mainRoot, macroId, { event: 'intent', ...base, at: at() });
    const u = git(mainRoot, ['worktree', 'unlock', lane], { env });
    if (u.code !== 0) {
      // Whether the lane is unlocked now is asked of git, not read from its message.
      const locked = changedSince({ mainRoot, lane, laneId, reason, unlocked: false, env }) === null;
      return keep(`git worktree unlock refused: ${u.stderr}`, { unlocked: !locked });
    }
  }
  if (hooks.afterUnlock) await hooks.afterUnlock();
  const again = removalCheck(lane, { env });
  if (!again.ok) return keep(again.why, { unlocked: true });
  if (hooks.beforeRemove) await hooks.beforeRemove();
  const moved = changedSince({ mainRoot, lane, laneId, reason, unlocked: true, env });
  if (moved) return keep(`the lane changed after the unlock (${moved})`, { unlocked: true });
  if (await laneLockHeld(lane, ownLaneLock)) return keep(`a run or a session joined the lane's worktree lock (${worktreeLockPath(lane)})`, { unlocked: true });
  const r = git(mainRoot, ['worktree', 'remove', lane], { env });
  if (r.code !== 0) return keep(`git worktree remove refused: ${r.stderr}`, { unlocked: true });
  appendIntent(mainRoot, macroId, { event: 'done', ...base, at: at() });
  if (runDir) appendLaneEvent(runDir, { event: 'removed', ...base, at: at() });
  return { outcome: 'removed' };
}

/**
 * Remove a lane once /orchestrator:done has recorded its subtask completed
 * (Decision 5, Removal), never with --force and only when the lock reason is
 * this macro's for that subtask. `ownLaneLock` is the caller's own entry in
 * the lane's worktree lock, which it releases after; any other live
 * participant there keeps the lane, and so does a lane that holds a path in
 * `protect` (the driver's checkout, its run directory, the effective state
 * root). The caller judges that the subtask is completed. `hooks.afterCheck`,
 * `hooks.afterUnlock` and `hooks.beforeRemove` are test seams
 * (unlockAndRemove reads the lane's ownership again after each).
 * Resolves to { outcome: 'removed' | 'kept' | 'absent' | 'not-ours', why? }.
 */
export async function removeLane({ home, macroId, subtaskId, runId = null, runDir = null, now = () => Date.now(), env = process.env, ownLaneLock = null, protect = [], hooks = {} }) {
  const lane = lanePath(home, macroId, subtaskId);
  const reason = lockReason(macroId, subtaskId);
  const w = listWorktrees(home.mainRoot, { env }).find((x) => real(x.path) === real(lane));
  if (!w) return { outcome: 'absent' };
  if (!w.locked || w.lockReason !== reason) return { outcome: 'not-ours', why: `${lane} is not locked with ${JSON.stringify(reason)}${w.locked ? ` (its reason: ${JSON.stringify(w.lockReason)})` : ''}` };
  const at = () => new Date(now()).toISOString();
  let id = readLaneIdentity(lane);
  if (id.state === 'absent') {
    // The lock proves the lane ours (a crash before its identity was written).
    try {
      writeLaneIdentity(lane, { macroId, subtaskId, branch: w.branch, now: new Date(now()) });
      id = readLaneIdentity(lane);
    } catch (err) {
      id = { state: 'unreadable', error: `its identity could not be written (${err.message})` };
    }
  }
  const keepLocked = (why) => {
    if (runDir) appendLaneEvent(runDir, { event: 'kept', path: lane, lane_id: id.identity?.lane_id ?? null, subtask_id: subtaskId, run_id: runId, at: at(), why });
    return { outcome: 'kept', why };
  };
  if (id.state !== 'ok') return keepLocked(id.error);
  const kept = protectedOverlap(lane, protect);
  if (kept) return keepLocked(kept);
  if (await laneLockHeld(lane, ownLaneLock)) return keepLocked(`a run or a session holds the lane's worktree lock (${worktreeLockPath(lane)})`);
  const check = removalCheck(lane, { env });
  if (!check.ok) return keepLocked(check.why);
  if (hooks.afterCheck) await hooks.afterCheck();
  return unlockAndRemove({ mainRoot: home.mainRoot, macroId, subtaskId, lane, laneId: id.identity.lane_id, runId, runDir, now, env, ownLaneLock, hooks });
}

/**
 * Create a lane once its first step is admitted (Decision 5, Creation): fetch
 * the baseline, judge the subtask rows again (a branch can appear, or be
 * checked out, while a run goes on), add the worktree locked with our reason,
 * write its identity, record it, and check that it ignores the agentic state.
 * Resolves to { ok: true, lane: { path, laneId, branch, subtaskId, form, base } }
 * or { ok: false, halt }; a halt after the worktree exists keeps it (a
 * prepared lane: row 4 next time).
 */
export function createLane({ home, checkout, macroId, subtask, view, baseline, runId = null, runDir = null, now = () => Date.now(), env = process.env, out = () => {} }) {
  const fetched = fetchBaseline({ checkout, baseline, env });
  if (!fetched.ok) return { ok: false, halt: fetched.halt };
  if (fetched.warning) {
    out(`⚠ ${fetched.warning}`);
    if (runDir) appendLaneEvent(runDir, { event: 'fetch-warning', subtask_id: subtask?.id ?? null, run_id: runId, at: new Date(now()).toISOString(), warning: fetched.warning });
  }
  const facts = gatherLaneFacts({ home, checkout, macroId, view, baseline, env });
  if (facts.ours.some((l) => l.subtaskId === subtask?.id)) {
    return { ok: false, halt: halt(`subtask ${subtask.id} already has a lane; reconcile before creating another`, { subtaskId: subtask.id }) };
  }
  const j = judgeSubtask(facts, subtask);
  if (j.halt) return { ok: false, halt: j.halt };
  if (j.action === 'none') return { ok: false, halt: halt(`subtask ${subtask.id} is ${subtask.status} with no live child: it gets no lane`, { subtaskId: subtask.id }) };
  const lane = lanePath(home, macroId, subtask.id);
  const reason = lockReason(macroId, subtask.id);
  // The rollback fence goes up before the first lane exists.
  try {
    const m = markLanesFirstRun(home.mainRoot, { now: new Date(now()) });
    if (m.changed && runDir) appendLaneEvent(runDir, { event: 'lanes-first-run', lanes_first_run_at: m.at, run_id: runId, at: new Date(now()).toISOString() });
  } catch (err) {
    return { ok: false, halt: halt(`no lane was created: ${err.message}`, { subtaskId: subtask.id }) };
  }
  const add = j.action === 'new-branch'
    ? ['worktree', 'add', '--quiet', '--lock', '--reason', reason, '--no-track', '-b', subtask.branch, lane, fetched.ref]
    : ['worktree', 'add', '--quiet', '--lock', '--reason', reason, lane, subtask.branch];
  const added = git(home.mainRoot, add, { env });
  if (added.code !== 0) {
    return { ok: false, halt: halt(`git worktree add for subtask ${subtask.id}'s lane at ${lane} failed: ${added.stderr} (the driver never retries with --force)`, { subtaskId: subtask.id }) };
  }
  let identity;
  try {
    identity = writeLaneIdentity(lane, { macroId, subtaskId: subtask.id, branch: subtask.branch, now: new Date(now()) });
  } catch (err) {
    return { ok: false, halt: halt(`the lane ${lane} was created, but its identity could not be written (${err.message}); the next reconciliation gives it one`, { subtaskId: subtask.id }) };
  }
  const record = {
    path: lane, laneId: identity.lane_id, branch: subtask.branch, subtaskId: subtask.id,
    form: j.action, base: fetched.tip,
  };
  if (runDir) {
    appendLaneEvent(runDir, {
      event: 'created', path: lane, lane_id: identity.lane_id, subtask_id: subtask.id, branch: subtask.branch,
      form: j.action, row: j.row ?? null, base: fetched.tip, run_id: runId, at: new Date(now()).toISOString(),
    });
  }
  const unignored = lanePreflight(lane, { env });
  if (unignored) return { ok: false, halt: halt(`${unignored}: add .agentic-plugins/{runs,state,tmp,cache}/ to .gitignore on ${subtask.branch}`, { subtaskId: subtask.id }), lane: record };
  return { ok: true, lane: record };
}

/**
 * Reconciliation at the start of a run with lanes (Decision 5): fetch the
 * baseline, gather the facts, plan the rows and apply them. Resolves to
 * { halt | null, lanes: Map<subtaskId, lane>, toCreate: [{subtaskId, action}],
 *   reports: [string], plan }.
 * The halt is the first one the rows found; everything the rows act on is
 * still applied (the pre-pass, a removal, a relock), since each is safe alone.
 * `protect` names what no removal may take (the driver's checkout, its run
 * directory, the effective state root). Run it under the macro lock, with a
 * view observed after the locks were taken. Each removal and relock reads the
 * lane's ownership again where it acts; `hooks` are test seams (removeLane's,
 * and `beforeRelock(path)` before row 9 locks a lane again).
 */
export async function reconcileLanes({ home, checkout, macroId, view, baseline, runId = null, runDir = null, now = () => Date.now(), env = process.env, out = () => {}, protect = [], hooks = {} }) {
  const fetched = fetchBaseline({ checkout, baseline, env });
  if (!fetched.ok) return { halt: fetched.halt, lanes: new Map(), toCreate: [], reports: [], plan: null };
  if (fetched.warning) out(`⚠ ${fetched.warning}`);
  const at = () => new Date(now()).toISOString();
  const record = (event, fields) => { if (runDir) appendLaneEvent(runDir, { event, run_id: runId, at: at(), ...fields }); };
  if (fetched.warning) record('fetch-warning', { warning: fetched.warning });

  let facts = gatherLaneFacts({ home, checkout, macroId, view, baseline, env });
  // The pre-pass, then a fresh look: an identity written now is read by the rows.
  const first = planReconciliation(facts);
  for (const p of first.prepass) {
    if (p.kind === 'mark-first-run') {
      let m;
      try { m = markLanesFirstRun(home.mainRoot, { now: new Date(now()) }); } catch (err) {
        return { halt: halt(`the rollback fence could not be recorded: ${err.message}`), halts: [], lanes: new Map(), toCreate: [], reports: [], plan: null };
      }
      if (m.changed) record('lanes-first-run', { lanes_first_run_at: m.at });
    } else if (p.kind === 'intent-done') {
      appendIntent(home.mainRoot, macroId, { event: 'done', path: p.intent.path, lane_id: p.intent.lane_id, subtask_id: p.intent.subtask_id ?? null, run_id: runId, at: at(), why: 'git no longer lists the path: the removal finished before a crash' });
      record('reconciled', { path: p.intent.path, lane_id: p.intent.lane_id, action: 'intent-done' });
    } else if (p.kind === 'assign-identity') {
      const identity = writeLaneIdentity(p.lane.path, { macroId, subtaskId: p.lane.subtaskId, branch: p.lane.branch, now: new Date(now()) });
      record('identity-assigned', { path: p.lane.path, lane_id: identity.lane_id, subtask_id: p.lane.subtaskId });
    }
  }
  if (first.prepass.length > 0) facts = gatherLaneFacts({ home, checkout, macroId, view, baseline, env });
  // The removal check runs only where a row needs it (rows 7 and 9), and a
  // lane that holds what the run needs never passes it.
  const removable = async (p) => {
    const kept = protectedOverlap(p, protect);
    if (kept) return { ok: false, why: kept };
    if (await laneLockHeld(p, null)) return { ok: false, why: `a run or a session holds the lane's worktree lock (${worktreeLockPath(p)})` };
    return removalCheck(p, { env });
  };
  const status = new Map((facts.subtasks ?? []).map((s) => [s?.id, s?.status]));
  for (const l of facts.ours) {
    if (l.present && status.get(l.subtaskId) === 'completed') l.removal = await removable(l.path);
  }
  for (const w of facts.atOurPaths) if (w.present) w.removal = await removable(w.path);
  const plan = planReconciliation(facts);

  const lanes = new Map();
  const reports = [];
  for (const e of plan.lanes) {
    const l = e.lane;
    const laneId = l.identity?.identity?.lane_id ?? null;
    if (e.action === 'adopt' || e.action === 'prepared') {
      // The preflight per lane, before the lane's first step in this run: a
      // lane adopted or reused may sit on a branch whose ignore rules changed.
      const unignored = lanePreflight(l.path, { env });
      if (unignored) {
        plan.halts.push({ row: e.row, ...halt(`${unignored}: add .agentic-plugins/{runs,state,tmp,cache}/ to .gitignore on ${l.branch}`, { subtaskId: e.subtaskId }) });
        record('reconciled', { path: l.path, lane_id: laneId, subtask_id: e.subtaskId, row: e.row, action: 'halt', why: unignored });
        continue;
      }
      lanes.set(e.subtaskId, { path: l.path, laneId, branch: l.branch, subtaskId: e.subtaskId, state: e.action, ready: e.ready ?? null });
      record(e.action === 'adopt' ? 'adopted' : 'reconciled', { path: l.path, lane_id: laneId, subtask_id: e.subtaskId, row: e.row, action: e.action });
    } else if (e.action === 'remove') {
      const r = await unlockAndRemove({ mainRoot: home.mainRoot, macroId, subtaskId: e.subtaskId, lane: l.path, laneId, runId, runDir, now, env, hooks });
      reports.push(r.outcome === 'removed' ? `removed the lane ${l.path} of completed subtask ${e.subtaskId}` : `kept the lane ${l.path}: ${r.why}`);
    } else if (e.action === 'keep') {
      reports.push(e.report);
      record('kept', { path: l.path, lane_id: laneId, subtask_id: e.subtaskId, row: e.row, why: e.report });
    } else {
      record('reconciled', { path: l.path, lane_id: laneId, subtask_id: e.subtaskId, row: e.row, action: 'halt' });
    }
  }
  for (const u of plan.unlocked) {
    const w = u.worktree;
    if (u.action === 'finish-removal') {
      const r = await unlockAndRemove({ mainRoot: home.mainRoot, macroId, subtaskId: u.intent.subtask_id, lane: w.path, laneId: u.intent.lane_id, runId, runDir, now, env, intentWritten: true, hooks });
      reports.push(r.outcome === 'removed' ? `finished removing the lane ${w.path}` : `kept the lane ${w.path}: ${r.why}`);
    } else {
      const subtaskId = u.intent.subtask_id;
      const why = w.removal?.why ?? 'the removal check failed';
      if (hooks.beforeRelock) await hooks.beforeRelock(w.path);
      // The lane as it is now, not as the facts read it: a worktree that
      // replaced it at its path since is not ours to lock.
      const again = isSafeSubtaskId(subtaskId)
        ? relockIfOurs({ mainRoot: home.mainRoot, lane: w.path, laneId: u.intent.lane_id, reason: lockReason(macroId, subtaskId), env })
        : { code: 1, stderr: 'the intent names no subtask' };
      if (again.code === 0) {
        appendIntent(home.mainRoot, macroId, { event: 'kept', path: w.path, lane_id: u.intent.lane_id, subtask_id: subtaskId ?? null, run_id: runId, at: at(), why });
        record('kept', { path: w.path, lane_id: u.intent.lane_id, subtask_id: subtaskId ?? null, row: 9, why });
        reports.push(`kept the lane ${w.path} (locked again): ${why}`);
      } else {
        // Its intent stays open: the only proof left that it is ours.
        record('kept', { path: w.path, lane_id: u.intent.lane_id, subtask_id: subtaskId ?? null, row: 9, why: `${why}; locking it again failed (${again.stderr}), so its removal intent stays open` });
        reports.push(`kept the lane ${w.path}, unlocked: ${why}; locking it again failed (${again.stderr})`);
      }
    }
  }
  for (const o of plan.others) {
    reports.push(o.report);
    record('reported', { path: o.worktree.path, row: o.row, why: o.report });
  }
  const toCreate = plan.subtasks.filter((s) => s.action === 'existing-branch' || s.action === 'new-branch');
  return { halt: plan.halts[0] ?? null, halts: plan.halts, lanes, toCreate, reports, plan };
}

// ---------------------------------------------------------------------------
// Where a step runs (Decision 5, Steps; Decision 2)

/**
 * The start conditions lanes add (Decision 2; Decision 6): a repository with
 * a shared root, a driver that does not run inside a lane, shared creation
 * on, the run's effective state root the default state root (an operator's
 * AGENTIC_STATE_BASE binds, and so must name it), and the macro and every
 * engineer workflow claiming it in a home of the default state root (a
 * shared home, legacy homes included, under the main worktree): a lane's
 * read set is the default root and the lane, so a child kept in another
 * checkout's own home — a worktree nested under the main one included — would
 * be reconciled but never found by the lane's worker, nor its peers
 * cancelled. The capability floor lanes add to S8's is the scheduler's start
 * check (DL). [problem, ...] — empty when lanes can run.
 */
export function lanesRequirements({ checkout, stateRoot, macroPath, view = null }) {
  const problems = [];
  const home = laneHome(checkout);
  if (home.problem) return [home.problem];
  if (isUnderLanesDirectory(checkout, home.mainRoot)) {
    problems.push(`the driver's checkout ${checkout} is under the lanes directory ${home.lanesDir}: run it from a checkout that is not a lane (a lane is removed when its subtask lands, and the run's ledger and locks would go with it)`);
  }
  const sw = readSharedCreation(checkout);
  if (sw.state !== 'on') problems.push(`lanes need shared creation on (it is ${sw.state}${sw.error ? `: ${sw.error}` : ''}); see docs/runbooks/state-root-cutover.md`);
  if (!stateRoot?.root || !sameDirectory(stateRoot.root, home.mainRoot)) {
    problems.push(`lanes need the run's state root to be the default state root ${home.mainRoot}${stateRoot?.root ? `, not ${stateRoot.root}${stateRoot.source === 'operator' ? ` (the operator's ${STATE_BASE_ENV})` : ''}` : ''}: a lane is removed when its subtask lands, and records kept anywhere but the shared root would go with it or be missed`);
  }
  // A home of the default state root, not anywhere under the main worktree:
  // a nested worktree's own home is there too, and no lane reads it.
  const homes = SHARED_HOMES.map((h) => path.join(home.mainRoot, h.rel));
  const outside = (p) => typeof p === 'string' && p !== '' && !homes.some((h) => within(p, h));
  if (outside(macroPath)) problems.push(`the macro ${macroPath} is not in a home of the default state root ${home.mainRoot}: run the cutover (docs/runbooks/state-root-cutover.md) first`);
  const strays = [
    ...Object.values(view?.children ?? {}).filter((c) => c?.location === 'active').map((c) => c.path),
    ...(view?.claims ?? []).map((c) => c?.path),
  ].filter(outside);
  for (const p of [...new Set(strays)]) {
    problems.push(`the engineer workflow ${p} claims the macro but is not in a home of the default state root ${home.mainRoot}: move it with the cutover (docs/runbooks/state-root-cutover.md) first`);
  }
  return problems;
}

/**
 * Take the lane's worktree lock for the run (Decision 5: a run that drives a
 * lane holds that lane's worktree lock while it does), with the run's record
 * — its token digest included, so the run's worker in the lane passes
 * `/orchestrator:next`'s admission, which joins the lock of the checkout it
 * runs in. Resolves to acquireLock's handle; rejects with LockHeldError.
 */
export function holdLane(lane, { record, now = () => Date.now() }) {
  return acquireLock(worktreeLockPath(lane.path ?? lane), { record, now });
}

// The steps that never switch branches, which run in the driver's checkout.
const DRIVER_STEPS = new Set(['done', 'done-no-commit', 'finalize']);

/**
 * The checkout and state root a step runs with. Dispatch, verbs and commit
 * run in their subtask's lane; done and finalize in the driver's checkout.
 * In a lane, the worker's AGENTIC_STATE_BASE is the run's state root, which
 * must be one the lane's own scripts accept (the default state root, with
 * shared creation on). { cwd, stateBase } or { problem }.
 */
export function stepPlacement(step, { lanes, checkout, stateRoot }) {
  if (!lanes || DRIVER_STEPS.has(step?.kind)) return { cwd: checkout, stateBase: stateRoot?.root ?? null, lane: null };
  const lane = lanes.get(step?.subtaskId);
  if (!lane) return { problem: `subtask ${step?.subtaskId ?? '?'} has no lane for its ${step?.kind ?? '?'} step` };
  const checked = checkStateBase({ checkout: lane.path, env: { [STATE_BASE_ENV]: stateRoot?.root ?? '' }, switchState: stateRoot?.shared_creation });
  if (!checked.set || !checked.ok) return { problem: `the lane ${lane.path} would not accept the run's state root: ${checked.error ?? 'none was resolved'}` };
  return { cwd: lane.path, stateBase: checked.root, lane: lane.subtaskId };
}
