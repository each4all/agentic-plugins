// plugins/orchestrator/adapters/claude/autopilot/dead-runs.mjs
//
// ADR-0067 Decision 6, Locks — a dead run is cleaned up, not forgotten.
//
// A driver that dies (killed, crashed, its host gone) leaves what only it
// would have cleaned up: the peer runs its steps started, which run detached
// from the worker groups, and the budget of the step it had in flight. Each
// run keeps an open-run record (ledger.mjs) from before its first spawn until
// it ends with every worker group empty and every step's peers accounted for.
// `stop`, and every run at its start, list the records of the macro, judge
// each driver by its pid and fingerprint as a lock entry's is judged, and for
// a dead one whose worker groups are
// empty (a starting run holds the macro lock; `stop` empties them first):
//
//   1. cancel, through engineer's fingerprint-checked `peer-runner cancel`,
//      each pending peer run whose handle names the dead run (`autopilot_run`,
//      the AGENTIC_AUTOPILOT of the worker that started it), and only those. A
//      peer the owner started after the crash names none and is left alone. A
//      pending peer that names no run, on the macro's workflow of an
//      unfinished step's subtask and started since that step, came from a
//      peer-runner that records none: it is reported, never cancelled. A
//      finished step whose run could not account for its peers (its
//      `finished` line says `peers_unaccounted`: the look after it failed
//      or could not read them, or their cancellation did not go through) is
//      searched as an unfinished one is;
//   2. record each unfinished step (a `started` line with no `finished` line)
//      as spent in the run's run.json, once, by its seq, and a finished step
//      whose charge the driver had no time to write there;
//   3. record the run halted (interrupted), and only then remove the record.
//      A run that took part in the event file (its run.json's `events`,
//      events.mjs) gets its `run-ended` there first, marked `cleanup`, with
//      the outcome run.json records: a run that recorded its end and died
//      before its line keeps that end. The writer appends it only when the
//      file holds none of that run, so a cleanup retried after a crash, or
//      one that meets the driver's own line, writes no second one
//      (ADR-0068 Decision 4).
//
// Each part is idempotent, and whoever cleans up holds the record's cleanup
// lock (`open/<run-id>.cleanup.lock`, beside it), so a `stop` and a starting
// run that meet one record count nothing twice. A record whose ledger is gone
// (its checkout removed) or does not read is reported and kept: the owner
// deletes it once they have checked that run's peers. A peer that could not be
// cancelled, or whose handle does not read, keeps the record too.
//
// peer-runner writes the handle field at spawn. That change is the persona
// pipeline's (engineer, founder, designer), apart from this package: until it
// ships, every pending peer names no run, and is reported.
//
// C181 (ADR-0023, peer runs of a dead step that hold scopes of their own) — a
// step that could make no scope leaves its peers to make their own, and each
// such scope records the autopilot run and step it was launched under (its
// identity's `association`, which only finds the run and grants nothing). The
// scan reads every persona's ledger (engineer, founder, designer, and the
// orchestrator's own) in every state root the run's records name, its lanes'
// checkouts among them, and every handle there, terminal ones included. Each
// handle whose scope names the dead run goes through its persona's `cancel`,
// whatever teardown it stores, and the record is kept unless that cancel's
// own reading (`scope_teardown`) is gone. A scope that names the run but no
// step of it, and a scope not read gone that names no run or cannot be read,
// keep the record too, and the run halts naming them.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { listOpenRuns, openRunsDir, readRun, relaunchCommand, removeOpenRun, writeHalt, writeRun } from './ledger.mjs';
import { createEventWriter, eventsPath, isHaltCode, RUN_STATUSES } from './events.mjs';
import {
  acquireLock, holderAlive, LockHeldError, macroLockPath, processFingerprint, readLockEntries, worktreeLockPath,
} from '../../../scripts/lib/run-locks.mjs';
import { SHARED_HOMES } from '../../../scripts/lib/state-root.mjs';
import { scopeRecordState } from '../../../scripts/lib/scope.mjs';
import { createScopeEnder, readScopeOnce } from '../../../scripts/lib/scope-reader.mjs';

// This orchestrator's root: the runner of its own peer runs when the dead
// run's pinned one is gone.
const SELF_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SEMVER_DIR = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const STEP_SEQ = /^[1-9][0-9]*$/;

// The handle field naming the run whose worker started a peer.
export const AUTOPILOT_RUN_FIELD = 'autopilot_run';
// peer-runner's statuses that are not terminal: the run may still be going.
const PENDING = new Set(['queued', 'spawning', 'running', 'cancel_requested']);
// A cancel that finds nothing running has nothing left to cancel.
const NOTHING_RUNS = new Set(['not_running', 'no_pid']);
// What the owner can do about a peer a cancel refused: one still queued or
// spawning has no process to cancel yet, and peer-runner's sweep marks it
// orphaned once its runner is gone.
const OWNER_ACTION = {
  not_cancellable: (eng, root) => `node ${eng}/scripts/peer-runner.mjs sweep --repo-root ${root}   # marks it orphaned once its runner is gone`,
};

const real = (p) => {
  try { return fs.realpathSync(p); } catch { return null; }
};
const iso = (ms) => new Date(ms).toISOString();

// The two frontmatter strings a workflow links to its macro by, read line by
// line: the workflow is engineer's, with keys this plugin's parser refuses.
export function workflowLinkage(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); } catch { return null; }
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---\n', 3);
  if (end === -1) return null;
  const fm = text.slice(4, end);
  const scalar = (key) => {
    const m = new RegExp(`^${key}: (.+)$`, 'm').exec(fm);
    if (!m) return null;
    try {
      const v = JSON.parse(m[1]);
      return typeof v === 'string' ? v : null;
    } catch {
      return m[1].trim();
    }
  };
  return { parent_workflow: scalar('parent_workflow'), originating_subtask: scalar('originating_subtask') };
}

// The peer-run homes a dead run's peers can be in: every persona's, and the
// orchestrator's (SHARED_HOMES), under the state root its workers created
// records in, the default state root, its checkout (a run from before the
// shared state root keeps them there), and the checkout of each of its steps
// (a lane's own, which the scheduler records as the step's `cwd`). Only a
// home that does not exist (ENOENT) holds none; one whose path cannot be
// resolved for another reason (EACCES, EIO, …) may hold the run's peers, and
// is returned unreadable, which keeps the record.
function peerRunDirs(run, record, steps = []) {
  const roots = [run?.state_root?.root, run?.state_root?.default_state_root, record.checkout, ...steps.map((s) => s?.cwd)]
    .filter((r) => typeof r === 'string' && r !== '' && path.isAbsolute(r));
  const seen = new Set();
  const dirs = [];
  const unreadable = [];
  for (const root of roots) {
    for (const { plugin, rel } of SHARED_HOMES) {
      const dir = path.join(root, rel, 'peer-runs');
      let key;
      try {
        key = fs.realpathSync(dir);
      } catch (err) {
        if (err.code === 'ENOENT') continue;
        key = path.resolve(dir);
        if (!seen.has(key)) unreadable.push({ run_id: null, root, why: `${dir} does not resolve (${err.code ?? err.message})` });
        seen.add(key);
        continue;
      }
      if (seen.has(key)) continue;
      seen.add(key);
      dirs.push({ root, dir, plugin });
    }
  }
  return { dirs, unreadable };
}

// Every peer run in those homes, terminal ones included (a scope's
// association is read whatever the run's status), and the ones that cannot
// be told: a home or a handle that does not read (a run directory with no
// handle yet is one being created, or pruned).
function scanPeers({ dirs, unreadable: unresolvedHomes }) {
  const peers = [];
  const unreadable = [...unresolvedHomes];
  for (const { root, dir, plugin } of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch (err) {
      if (err.code !== 'ENOENT') unreadable.push({ run_id: null, root, why: `${dir} does not list (${err.code ?? err.message})` });
      continue;
    }
    for (const name of names.sort()) {
      const file = path.join(dir, name, 'handle.json');
      let handle = null;
      try {
        handle = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (err) {
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') continue;
        unreadable.push({ run_id: name, root, plugin, why: `its handle ${file} does not read (${err.code ?? err.message})` });
        continue;
      }
      // A handle under a directory not named for its run (a retention
      // claim's `~prune~` name, an interrupted rename) cannot be cancelled by
      // its id, but its scope is still read below.
      if (handle !== null && typeof handle === 'object') peers.push({ root, plugin, handle, misplaced: handle.run_id !== name ? name : null });
    }
  }
  return { peers, unreadable };
}

// What a handle's scope says of the dead run (C181):
//   null                 no scope of its own (an earlier release's handle,
//                        none made, an abandoned launch): nothing;
//   { ours, step }       a scope whose association names the run; `step`
//                        is false when it names no step of the run's;
//   { other }            a scope another run, or no run, launched;
//   { unreadable }       a scope record this reader cannot read.
function scopeClaim(handle, runId, stepSeqs) {
  let state;
  try {
    state = scopeRecordState(handle);
  } catch {
    state = { state: 'malformed' };
  }
  if (state.state === 'legacy-missing' || state.state === 'none' || state.state === 'abandoned') return null;
  if (state.state !== 'scoped') return { unreadable: `scope-${state.state}` };
  const a = state.identity.association ?? null;
  if (a !== null && a.autopilot_run === runId) {
    return { ours: true, unit: state.identity.unit, identity: state.identity, step: STEP_SEQ.test(a.autopilot_step) && stepSeqs.has(Number(a.autopilot_step)) };
  }
  return { other: a === null ? 'no-association' : 'another-run', unit: state.identity.unit, identity: state.identity };
}

// The root of the plugin whose peer-runner ends a peer run of `plugin`: the
// engineer the dead run pinned (or the caller's), the orchestrator it pinned
// (or this one), and a founder or designer from its root variable, else
// beside the engineer (the same install cache, newest version first, or the
// same checkout), else from either host's install cache (the engineer may be
// pinned to a checkout while the persona is installed). null when none
// carries a peer-runner.
function newestIn(base, has) {
  let versions = [];
  try {
    versions = fs.readdirSync(base).filter((v) => SEMVER_DIR.test(v));
  } catch {
    return null;
  }
  versions.sort((x, y) => {
    const a = x.split('.').map(Number);
    const b = y.split('.').map(Number);
    return b[0] - a[0] || b[1] - a[1] || b[2] - a[2];
  });
  for (const v of versions) if (has(path.join(base, v))) return path.join(base, v);
  return null;
}

function runnerFor(plugin, { run, engineer, env }) {
  const has = (root) => typeof root === 'string' && root !== '' && fs.existsSync(path.join(root, 'scripts', 'peer-runner.mjs'));
  if (plugin === 'engineer') return engineer;
  if (plugin === 'orchestrator') {
    const pinned = run?.roots?.orchestrator;
    return has(pinned) ? pinned : (has(SELF_ROOT) ? SELF_ROOT : null);
  }
  const override = env?.[`AGENTIC_${plugin.toUpperCase()}_ROOT`];
  if (typeof override === 'string' && override !== '') return path.isAbsolute(override) && has(override) ? override : null;
  if (has(engineer)) {
    const parent = path.dirname(engineer);
    const beside = path.basename(parent) === 'engineer' && SEMVER_DIR.test(path.basename(engineer))
      ? newestIn(path.join(path.dirname(parent), plugin), has)
      : (has(path.join(parent, plugin)) ? path.join(parent, plugin) : null);
    if (beside) return beside;
  }
  const home = typeof env?.HOME === 'string' && path.isAbsolute(env.HOME) ? env.HOME : null;
  const codexHome = typeof env?.CODEX_HOME === 'string' && path.isAbsolute(env.CODEX_HOME) ? env.CODEX_HOME : (home ? path.join(home, '.codex') : null);
  for (const cache of [home && path.join(home, '.claude/plugins/cache'), codexHome && path.join(codexHome, 'plugins/cache')]) {
    if (!cache) continue;
    const found = newestIn(path.join(cache, 'agentic-plugins', plugin), has);
    if (found) return found;
  }
  return null;
}

// C181 (ADR-0023, the autopilot worker) — the scopes of a dead driver's
// steps, ended before the cleanup judges the run's worker groups: each step
// whose record holds a scope (its last `scope` line) that binds it (owner
// `autopilot-step`, the run, the step's seq, the driver as supervisor) and
// whose driver is proven gone has its kill written, every kill first; then
// each such scope is read once, with no wait. Answers the ones not read gone,
// which keep the record. A scope of a version this reader does not know, or
// one that binds another run, step or driver, gets no kill and is still read
// (a reading needs no authority).
function endStepScopes({ runId, record, steps, ender }) {
  const owned = [];
  const held = [];
  for (const s of steps) {
    if (!s || !Object.hasOwn(s, 'scope')) continue;
    let st;
    try { st = scopeRecordState(s); } catch { st = { state: 'malformed' }; }
    if (st.state === 'unknown-version') {
      held.push({ seq: s.seq, unit: null, reading: { state: 'withheld', check: 'unknown-version' } });
      continue;
    }
    // A record that claims a scope but does not parse grants no kill, and
    // keeps the record (its scope may hold processes).
    if (st.state === 'malformed' && s.scope?.state === 'scoped') {
      held.push({ seq: s.seq, unit: typeof s.scope?.identity?.unit === 'string' ? s.scope.identity.unit : null, reading: { state: 'withheld', check: 'malformed' } });
      continue;
    }
    if (st.state !== 'scoped') continue;
    const id = st.identity;
    const binds = id.owner.kind === 'autopilot-step' && id.owner.run === runId && id.owner.step === String(s.seq) && id.supervisor.pid === record.pid;
    owned.push({ seq: s.seq, id, binds });
  }
  for (const o of owned) {
    if (!o.binds) continue;
    let sup;
    try { sup = ender.supervisorGone(o.id.supervisor); } catch { sup = { gone: false }; }
    if (sup.gone) {
      try { ender.kill(o.id); } catch { /* the ender keeps it withheld */ }
    }
  }
  for (const o of owned) {
    let reading;
    try { reading = ender.read(o.id); } catch { reading = { state: 'withheld', check: 'reading-failed' }; }
    if (reading?.state !== 'gone') held.push({ seq: o.seq, unit: o.id.unit, reading });
  }
  return held;
}

// A run's steps, read strictly: a step log that does not read, or holds a
// line that does not parse before its last, cannot say which steps were left
// unfinished. A last line cut short is a write a crash interrupted, before
// the spawn it announced. Started and finished lines are paired by seq, as
// readRun pairs them; a `stall` line is an observation, never a step's, and
// so is a serial run's `instruction` line (ADR-0068 Decision 7), which
// carries the seq of the step about to start: merged, it would hide that
// step's `started`, and a step in flight would no longer read as unfinished
// (its budget is still settled, but the peers naming no run that it may
// have started go unsearched and the halt names neither its subtask nor its
// session).
function readStepsStrictly(runDir) {
  let text = '';
  try {
    text = fs.readFileSync(path.join(runDir, 'steps.jsonl'), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { steps: [] };
    return { error: `its step log does not read (${err.code ?? err.message})` };
  }
  const lines = text.split('\n').filter((l) => l.trim() !== '');
  const bySeq = new Map();
  for (const [i, line] of lines.entries()) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      if (i === lines.length - 1) break;
      return { error: `line ${i + 1} of its step log does not parse` };
    }
    if (!Number.isInteger(rec?.seq)) return { error: `line ${i + 1} of its step log has no seq` };
    if (rec.event === 'stall' || rec.event === 'instruction') continue;
    const prev = bySeq.get(rec.seq) ?? {};
    // C181 — a step's scope line (readRun's rule): the last one is the step's,
    // and it never stands for the step's `started`.
    if (rec.event === 'scope') {
      bySeq.set(rec.seq, { seq: rec.seq, ...prev, scope: rec.scope ?? null });
      continue;
    }
    bySeq.set(rec.seq, rec.event === 'finished' ? { ...prev, ...rec } : { ...rec, ...prev });
  }
  return { steps: [...bySeq.values()].sort((a, b) => a.seq - b.seq) };
}

// The step a peer that names no run may belong to — an unfinished one, or a
// finished one whose peers the run could not account for: one on the macro's
// workflow of that step's subtask, started since the step started.
function stepOfUnnamed(handle, unfinished, macroId) {
  const started = Date.parse(handle.started_at ?? '');
  let link;
  for (const s of unfinished) {
    if (!s.subtask_id) continue;
    const since = Date.parse(s.started_at ?? '');
    if (Number.isFinite(started) && Number.isFinite(since) && started < since) continue;
    link ??= workflowLinkage(handle.workflow_path ?? '') ?? {};
    if (link.parent_workflow === macroId && link.originating_subtask === s.subtask_id) return s;
  }
  return null;
}

// The engineer to cancel with: the one the dead run pinned, which started its
// peers, while it is still there; otherwise the caller's.
function engineerFor(run, fallback) {
  const pinned = run?.roots?.engineer;
  if (typeof pinned === 'string' && fs.existsSync(path.join(pinned, 'scripts', 'peer-runner.mjs'))) return pinned;
  return fallback ?? null;
}

function cancelPeer(engineerRoot, runId, root, env) {
  const cli = path.join(engineerRoot, 'scripts', 'peer-runner.mjs');
  const r = spawnSync(process.execPath, [cli, 'cancel', '--run-id', runId, '--repo-root', root], {
    cwd: root, env, encoding: 'utf8', timeout: 60_000,
  });
  let result = null;
  try { result = JSON.parse((r.stdout ?? '').trim()); } catch { /* not JSON */ }
  return {
    run_id: runId, root, exit: r.status,
    settled: result?.ok === true || NOTHING_RUNS.has(result?.reason),
    result: result ?? (r.stderr ?? '').trim().slice(-300),
  };
}

// Whether an entry of the run still lives in the locks it took: a worker
// group of a dead driver keeps its entry live.
async function liveEntry(record, mainRoot, probe) {
  const locks = [worktreeLockPath(record.checkout)];
  if (record.macro_id) locks.push(macroLockPath(mainRoot, record.macro_id));
  for (const lock of locks) {
    for (const e of readLockEntries(lock)) {
      if (e.holder?.run_id === record.run_id && await holderAlive(e.holder, { probe })) return true;
    }
  }
  return false;
}

/**
 * Clean up after the dead runs of a macro (every macro's when `macroId` is
 * null): the outcome of each open-run record looked at, other than the
 * caller's own. 'cleaned': its record is removed. 'kept': it needs the owner
 * (`detail` says why). 'live': its driver, or a worker group of it, runs.
 * 'busy': someone else is cleaning up after it.
 *
 * @param a.mainRoot      the main worktree (where the records are)
 * @param a.engineerRoot  the engineer to cancel with when the dead run's is gone
 * @param a.by            { run_id (the caller's run, or null), label }
 * @param a.cancel        the cancel of one peer run (a test passes its own)
 * @param a.readScope     one reading of a scope, with no kill (a test's own)
 */
export async function cleanupDeadRuns({
  mainRoot, macroId = null, selfRunId = null, engineerRoot = null, by,
  env = process.env, now = () => Date.now(), out = () => {}, probe = processFingerprint,
  cancel = cancelPeer, readScope = readScopeOnce, scopeEnder = createScopeEnder(),
}) {
  const results = [];
  let records;
  try {
    records = listOpenRuns(mainRoot);
  } catch (e) {
    results.push({ run_id: null, outcome: 'kept', detail: `the open-run records cannot be listed (${e.message})` });
    records = [];
  }
  for (const { file, runId, record, error } of records) {
    if (runId === selfRunId) continue;
    if (!record) {
      results.push({ run_id: runId, outcome: 'kept', detail: `its open-run record ${file} does not read (${error}); check that run's peers, then delete the record` });
      continue;
    }
    if (macroId !== null && record.macro_id !== macroId) continue;
    let r;
    try {
      r = await cleanupOne({ mainRoot, file, record, engineerRoot, by, env, now, probe, cancel, readScope, scopeEnder });
    } catch (e) {
      r = { run_id: runId, outcome: 'kept', detail: `the cleanup failed (${e?.message ?? e}); its record is kept` };
    }
    results.push({ macro_id: record.macro_id ?? null, ...r });
  }
  for (const r of results) for (const line of describe(r)) out(line);
  return results;
}

async function cleanupOne({ mainRoot, file, record, engineerRoot, by, env, now, probe, cancel, readScope, scopeEnder }) {
  const runId = record.run_id;
  if (await holderAlive({ pid: record.pid, fingerprint: record.fingerprint, worker: null }, { probe })) {
    return { run_id: runId, outcome: 'live', detail: `its driver (pid ${record.pid}) is running` };
  }

  // The lock sits beside the record, under the main worktree, which outlives
  // any checkout a ledger may have gone with.
  const lockDir = path.join(openRunsDir(mainRoot), `${runId}.cleanup.lock`);
  let lock;
  try {
    lock = await acquireLock(lockDir, { record: { run_id: by?.run_id ?? null, cleanup_of: runId, by: by?.label ?? null }, now, probe });
  } catch (e) {
    if (e instanceof LockHeldError) return { run_id: runId, outcome: 'busy', detail: 'another process is cleaning up after it' };
    throw e;
  }
  let complete = false;
  try {
    // Read under the lock: another cleaner may have finished meanwhile.
    if (!fs.existsSync(file)) {
      complete = true;
      return { run_id: runId, outcome: 'cleaned', detail: 'another process cleaned up after it', cancelled: [], reported: [], settled: [] };
    }
    const r = readRun(record.checkout, runId);
    const ledgerOk = Boolean(r) && real(r.dir) === real(record.run_dir) && r.run.run_id === runId && (r.run.macro_id ?? null) === (record.macro_id ?? null);
    const strict = ledgerOk ? readStepsStrictly(r.dir) : null;
    // C181 — under the cleanup lock, before the worker groups are judged:
    // the dead driver's step scopes are ended, so a live claude left in one
    // no longer makes the run live (one that left its scope is judged as
    // before), and a scope not read gone keeps the record.
    const heldSteps = strict && !strict.error ? endStepScopes({ runId, record, steps: strict.steps, ender: scopeEnder }) : [];
    if (await liveEntry(record, mainRoot, probe)) {
      return { run_id: runId, outcome: 'live', detail: 'its driver is gone, but a worker group of it still runs: /orchestrator:autopilot stop empties it, then cleans up' };
    }
    if (!r || real(r.dir) !== real(record.run_dir)) {
      return { run_id: runId, outcome: 'kept', detail: `its ledger ${record.run_dir} is gone; check that run's peers, then delete ${file}` };
    }
    if (r.run.run_id !== runId || (r.run.macro_id ?? null) !== (record.macro_id ?? null)) {
      return { run_id: runId, outcome: 'kept', detail: `its ledger ${r.dir} names run ${r.run.run_id ?? '?'} of macro ${r.run.macro_id ?? '-'}, not its record's; check it, then delete ${file}` };
    }
    if (strict.error) {
      return { run_id: runId, outcome: 'kept', detail: `${strict.error}, so its unfinished steps are not known; check ${r.dir}, then delete ${file}` };
    }
    const run = r.run;
    // ADR-0068 Decision 5, item 9 — a newer driver's verification batch is a
    // line of kind `verify` in the step ledger: no worker step and no cost. It
    // is never settled, counted in `steps` or `accounted_seqs`, or taken for a
    // step a peer may come from.
    strict.steps = strict.steps.filter((s) => s.kind !== 'verify');
    const unfinished = strict.steps.filter((s) => s.event === 'started');
    // Where a peer that names no run may come from: an unfinished step, or a
    // finished one whose peers its run could not account for.
    const unaccounted = strict.steps.filter((s) => s.event === 'started' || s.peers_unaccounted === true);

    const engineer = engineerFor(run, engineerRoot);
    const cancelled = [];
    const reported = [];
    const { peers, unreadable } = scanPeers(peerRunDirs(run, record, strict.steps));
    const unresolved = unreadable.map((p) => ({ ...p, runner: p.plugin ? runnerFor(p.plugin, { run, engineer, env }) : engineer }));
    for (const h of heldSteps) {
      unresolved.push({ run_id: null, step_scope: true, seq: h.seq, unit: h.unit, why: `step [${h.seq}]'s scope ${h.unit ?? '(of a version this reader does not know)'} was not read gone (${h.reading?.state ?? '?'}${h.reading?.check ? `: ${h.reading.check}` : ''})` });
    }
    const stepSeqs = new Set(strict.steps.map((s) => s.seq));
    // One reading of a scope, with no kill: a reading needs no authority.
    const readOnce = (identity) => {
      try {
        return readScope(identity) ?? { state: 'withheld', check: 'no-reading' };
      } catch (e) {
        return { state: 'withheld', check: `reading-failed: ${e?.message ?? e}` };
      }
    };
    const said = (reading) => `${reading?.state ?? 'unknown'}${reading?.check ? `: ${reading.check}` : ''}`;
    for (const { root, plugin, handle, misplaced } of peers) {
      const names = handle[AUTOPILOT_RUN_FIELD];
      const pending = PENDING.has(handle.status);
      const claim = scopeClaim(handle, runId, stepSeqs);
      // Another run's scope is that run's, whatever the handle's top-level
      // tag says: the tag never authorizes a kill of a scope another run's
      // association names.
      if (claim?.other === 'another-run') continue;
      const keep = (why, extra = {}) => unresolved.push({
        run_id: handle.run_id ?? misplaced, root, plugin, why, runner: runnerFor(plugin, { run, engineer, env }), ...(claim?.unit ? { unit: claim.unit } : {}), ...extra,
      });
      if (misplaced !== null) {
        // Not cancellable by its id; its scope is read, and keeps the record
        // unless gone.
        if (claim === null) continue;
        const where = path.join(root, '…', misplaced);
        if (claim.unreadable) { keep(`its handle lies under ${misplaced}, not its run's name, and its scope record does not read (${claim.unreadable})`, { action: `check ${where}` }); continue; }
        if (!claim.ours && claim.other !== 'no-association') continue;
        const reading = readOnce(claim.identity);
        if (reading.state !== 'gone') keep(`its handle lies under ${misplaced}, not its run's name, so it cannot be cancelled, and its scope ${claim.unit} was not read gone (${said(reading)})`, { action: `check ${where}` });
        else if (claim.ours && !claim.step) keep(`its scope ${claim.unit} names this run but no step of it`, { action: `check ${where}` });
        continue;
      }
      if ((pending && names === runId) || claim?.ours) {
        const runner = runnerFor(plugin, { run, engineer, env });
        if (!runner) {
          unresolved.push({ run_id: handle.run_id, root, plugin, why: `no ${plugin} peer-runner to cancel it with` });
          continue;
        }
        // The cancel ends the scope under its own conditions, and its answer
        // carries its own reading of it: the only reading that releases the
        // record. A stored teardown, the cancel's `ok` and a settlement say
        // nothing of the scope. A scope the handle gained after the scan is
        // in that answer too, and keeps the record unless read gone.
        const c = cancel(runner, handle.run_id, root, env);
        const result = typeof c.result === 'object' && c.result !== null ? c.result : null;
        const reading = result?.scope_teardown ?? null;
        const failure = (why, action = null) => unresolved.push({ run_id: handle.run_id, root, plugin, why, runner, action, ...(claim?.unit ? { unit: claim.unit } : {}) });
        if (pending && !c.settled) {
          const reason = result ? (result.reason ?? JSON.stringify(result)) : c.result;
          failure(reason, OWNER_ACTION[reason]?.(runner, root) ?? null);
        } else if (claim?.unreadable) {
          failure(`its scope record does not read (${claim.unreadable})`);
        } else if (reading !== null && reading.state !== 'gone') {
          failure(`its scope ${reading.unit ?? claim?.unit ?? ''} was not read gone (${said(reading)})`);
        } else if (claim && reading === null) {
          failure(`its scope ${claim.unit} was not read gone (the cancel read none)`);
        } else if (claim?.ours && !claim.step) {
          failure(`its scope ${claim.unit} names this run but no step of it`);
        } else {
          cancelled.push(c);
        }
        continue;
      }
      // A scope of its own that is not the dead run's: one that names no
      // run, or cannot be read, may be a peer of a step that could not tell
      // its run, so it keeps the record unless this reading, made now, is
      // gone (a stored teardown is a report).
      if (claim?.unreadable) {
        keep(`its scope record does not read (${claim.unreadable})`);
        continue;
      }
      if (claim?.other === 'no-association') {
        const reading = readOnce(claim.identity);
        if (reading.state !== 'gone') {
          keep(`its scope ${claim.unit} names no run and was not read gone (${said(reading)})`);
          continue;
        }
      }
      if (!pending) continue;
      // Another run's peer, or the owner's.
      if (names !== undefined && names !== null && names !== '') continue;
      const step = stepOfUnnamed(handle, unaccounted, record.macro_id);
      if (step) reported.push({ run_id: handle.run_id, root, workflow: handle.workflow_path ?? null, subtask_id: step.subtask_id, seq: step.seq, runner: runnerFor(plugin, { run, engineer, env }) });
    }

    // What run.json does not count yet: the driver charges a step in memory
    // and writes run.json after the step's finished line, so a driver that
    // died in between leaves a finished step, with its charge in that line,
    // uncounted; one that died during the step leaves an unfinished step,
    // which counts its whole budget. The error path writes run.json with the
    // charge and no finished line. Which steps run.json counts is its
    // `accounted_seqs` (ADR-0067 Decision 6, Budgets: a step is settled once,
    // by its seq), since with lanes a later step can finish before an earlier
    // one; a ledger from before it counts every step up to `steps`.
    let steps = Number.isInteger(run.steps) ? run.steps : 0;
    const accounted = Array.isArray(run.accounted_seqs) ? new Set(run.accounted_seqs) : null;
    let cost = Number(run.cost_usd ?? 0);
    const settled = [];
    let costKnown = true;
    for (const s of strict.steps) {
      if (accounted ? accounted.has(s.seq) : s.seq <= steps) continue;
      const finished = s.event === 'finished';
      const charged = finished && Number.isFinite(s.cost_charged_usd) ? s.cost_charged_usd
        : (Number.isFinite(s.step_budget_usd) ? s.step_budget_usd : 0);
      if (!finished || s.cost_usd === null || s.cost_usd === undefined) costKnown = false;
      cost += charged;
      settled.push({ seq: s.seq, charged_usd: charged, finished });
    }
    if (settled.length > 0) {
      // The steps run.json counts: by seq where it lists them (a later step
      // can finish before an earlier one), else up to the highest seq.
      steps = accounted ? new Set([...accounted, ...settled.map((s) => s.seq)]).size : Math.max(steps, ...settled.map((s) => s.seq));
      run.steps = steps;
      run.cost_usd = cost;
      if (accounted) run.accounted_seqs = [...accounted, ...settled.map((s) => s.seq)].sort((a, b) => a - b);
      if (!costKnown) run.cost_complete = false;
    }

    complete = unresolved.length === 0;
    const at = iso(now());
    const prev = run.dead_run_cleanup ?? {};
    run.dead_run_cleanup = {
      by: by?.label ?? null, at, complete,
      settled: [...(prev.settled ?? []), ...settled],
      cancelled: [...(prev.cancelled ?? []), ...cancelled.map((c) => c.run_id)],
      reported: reported.map((p) => p.run_id),
      unresolved: unresolved.map((p) => p.run_id),
    };
    // A run that died draining (its lanes' in-flight steps finishing after a
    // halt) died running too.
    // Whether halt.json holds the halt run.json records: the driver's own, or
    // one this cleanup writes; a halt.json the driver wrote before it died
    // recording the end is another halt (ADR-0068 Decision 4).
    let haltFile = run.status === 'halted' && Boolean(r.halt);
    if (complete && (run.status === 'running' || run.status === 'draining')) {
      haltFile = !r.halt;
      const last = unfinished.at(-1) ?? null;
      run.status = 'halted';
      run.ended_at = at;
      run.halt = {
        run_id: runId,
        reason: 'interrupted',
        detail: `its driver died without recording an end; ${by?.label ?? 'a cleanup'} cleaned up after it`,
        pointer: null,
        subtask_id: last?.subtask_id ?? null,
        waiting: null,
        merge_order: null,
        last_session_id: last?.session_id ?? null,
        resume: ['Check what the last step left, then relaunch:', relaunchCommand({ macroId: run.macro_id ?? record.macro_id ?? null, lanes: run.options?.lanes ?? 1, repoRoot: run.repo ?? record.checkout })],
      };
      if (!r.halt) writeHalt(r.dir, run.halt);
    }
    writeRun(r.dir, run);
    if (complete && !publishEnd({ mainRoot, record, run, dir: r.dir, now, haltFile })) writeRun(r.dir, run);
    if (complete) removeOpenRun(mainRoot, runId);
    return {
      run_id: runId,
      outcome: complete ? 'cleaned' : 'kept',
      detail: complete ? 'cleaned up after its dead driver' : 'a peer run that may be its could not be cancelled or read, or its scope was not read gone; its record is kept',
      cancelled, reported, unresolved, settled,
    };
  } finally {
    lock.release();
    // The record is gone: so goes its lock, unless another cleaner joined it.
    if (complete) {
      try { fs.rmdirSync(lockDir); } catch { /* not empty, or gone */ }
    }
  }
}

// A dead run's `run-ended`, once, for a run that took part in the event
// file, after its run.json records the end it names. False when the write
// failed: it is counted in run.json, which the caller writes again.
function publishEnd({ mainRoot, record, run, dir, now, haltFile }) {
  if (!run.events || typeof run.events !== 'object') return true;
  const macroId = run.macro_id ?? record.macro_id ?? null;
  let file;
  try {
    file = eventsPath({ mainRoot, macroId, checkout: record.checkout });
  } catch {
    file = null;
  }
  const count = () => { run.events.failed_writes = (Number.isInteger(run.events.failed_writes) ? run.events.failed_writes : 0) + 1; };
  if (!file) { count(); return false; }
  const status = RUN_STATUSES.includes(run.status) ? run.status : 'halted';
  return createEventWriter({ file, runId: run.run_id, macroId, now, onFailure: count }).emit('run-ended', {
    status, reason: isHaltCode(run.halt?.reason) ? run.halt.reason : null,
    exit: status === 'completed' ? 0 : status === 'error' ? 1 : 2,
    pointer: path.join(dir, haltFile ? 'halt.json' : 'run.json'), cleanup: true,
  }).ok;
}

// The lines a cleanup prints for one record.
export function describe(r) {
  const lines = [];
  const id = r.run_id ?? '(unknown run)';
  if (r.outcome === 'cleaned') {
    const parts = [];
    if (r.cancelled?.length) parts.push(`cancelled its peer run(s) ${r.cancelled.map((c) => c.run_id).join(', ')}`);
    if (r.settled?.length) parts.push(`counted its unfinished step(s) [${r.settled.map((s) => s.seq).join('], [')}] as spent ($${r.settled.reduce((a, s) => a + s.charged_usd, 0).toFixed(2)})`);
    lines.push(`dead run ${id}: ${r.detail}${parts.length ? `: ${parts.join('; ')}` : ''}`);
  } else {
    lines.push(`${r.outcome === 'kept' ? '✗ dead run' : 'run'} ${id}: ${r.detail}`);
  }
  for (const p of r.unresolved ?? []) {
    if (p.step_scope) {
      lines.push(`  ✗ ${p.why}: its scratch, open-run record and lock entries are kept; a later cleanup reads it again, or stop it: systemctl --user stop ${p.unit ?? '<unit>'}`);
      continue;
    }
    if (p.run_id === null) {
      lines.push(`  ✗ ${p.why}: its peers cannot be told; check that run's peers there`);
      continue;
    }
    const runner = p.runner ?? p.engineer ?? `<${p.plugin ?? 'engineer'}>`;
    lines.push(`  ✗ ${p.plugin && p.plugin !== 'engineer' ? `${p.plugin} ` : ''}peer run ${p.run_id} may be its but was not cancelled or read gone (${p.why}); check it, then: ${p.action ?? `node ${runner}/scripts/peer-runner.mjs cancel --run-id ${p.run_id} --repo-root ${p.root}`}`);
  }
  for (const p of r.reported ?? []) {
    lines.push(`  ⚠ peer run ${p.run_id} on ${p.workflow ?? '?'} (subtask ${p.subtask_id}, step [${p.seq}]) names no run (its peer-runner records none), so it was not cancelled; if it is that step's, cancel it: node ${p.runner ?? p.engineer ?? '<engineer>'}/scripts/peer-runner.mjs cancel --run-id ${p.run_id} --repo-root ${p.root}`);
  }
  return lines;
}

/** A result as a run records it in its own run.json (`dead_runs`). */
export function summary(r) {
  return {
    run_id: r.run_id, outcome: r.outcome, detail: r.detail,
    cancelled: (r.cancelled ?? []).map((c) => c.run_id),
    reported: (r.reported ?? []).map((p) => p.run_id),
    unresolved: (r.unresolved ?? []).map((p) => p.run_id),
    settled: (r.settled ?? []).map((s) => s.seq),
  };
}
