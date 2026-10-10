// plugins/orchestrator/adapters/claude/autopilot/dead-runs.mjs
//
// ADR-0067 Decision 6, Locks — a dead run is cleaned up, not forgotten.
//
// A driver that dies (killed, crashed, its host gone) leaves what only it
// would have cleaned up: the peer runs its steps started, which run detached
// from the worker groups, and the budget of the step it had in flight. Each
// run keeps an open-run record (ledger.mjs) from before its first spawn until
// it ends with every worker group empty. `stop`, and every run at its start,
// list the records of the macro, judge each driver by its pid and fingerprint
// as a lock entry's is judged, and for a dead one whose worker groups are
// empty (a starting run holds the macro lock; `stop` empties them first):
//
//   1. cancel, through engineer's fingerprint-checked `peer-runner cancel`,
//      each pending peer run whose handle names the dead run (`autopilot_run`,
//      the AGENTIC_AUTOPILOT of the worker that started it), and only those. A
//      peer the owner started after the crash names none and is left alone. A
//      pending peer that names no run, on the macro's workflow of an
//      unfinished step's subtask and started since that step, came from a
//      peer-runner that records none: it is reported, never cancelled;
//   2. record each unfinished step (a `started` line with no `finished` line)
//      as spent in the run's run.json, once, by its seq, and a finished step
//      whose charge the driver had no time to write there;
//   3. record the run halted (interrupted), and only then remove the record.
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

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { listOpenRuns, openRunsDir, readRun, relaunchCommand, removeOpenRun, writeHalt, writeRun } from './ledger.mjs';
import { ENGINEER_STATE_HOMES } from './observe.mjs';
import {
  acquireLock, holderAlive, LockHeldError, macroLockPath, processFingerprint, readLockEntries, worktreeLockPath,
} from '../../../scripts/lib/run-locks.mjs';

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

// The engineer peer-run homes a dead run's peers can be in: under the state
// root its workers created records in, the default state root, and its
// checkout (a run from before the shared state root keeps them there). Only
// a home that does not exist (ENOENT) holds none; one whose path cannot be
// resolved for another reason (EACCES, EIO, …) may hold the run's peers, and
// is returned unreadable, which keeps the record.
function peerRunDirs(run, record) {
  const roots = [run?.state_root?.root, run?.state_root?.default_state_root, record.checkout]
    .filter((r) => typeof r === 'string' && r !== '');
  const seen = new Set();
  const dirs = [];
  const unreadable = [];
  for (const root of roots) {
    for (const home of ENGINEER_STATE_HOMES) {
      const dir = path.join(root, home, 'peer-runs');
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
      dirs.push({ root, dir });
    }
  }
  return { dirs, unreadable };
}

// Every peer run in those homes whose handle says it may still be going, and
// the ones that cannot be told: a home or a handle that does not read (a run
// directory with no handle yet is one being created, or pruned).
function pendingPeers({ dirs, unreadable: unresolvedHomes }) {
  const peers = [];
  const unreadable = [...unresolvedHomes];
  for (const { root, dir } of dirs) {
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
        unreadable.push({ run_id: name, root, why: `its handle ${file} does not read (${err.code ?? err.message})` });
        continue;
      }
      if (handle?.run_id === name && PENDING.has(handle.status)) peers.push({ root, handle });
    }
  }
  return { peers, unreadable };
}

// A run's steps, read strictly: a step log that does not read, or holds a
// line that does not parse before its last, cannot say which steps were left
// unfinished. A last line cut short is a write a crash interrupted, before
// the spawn it announced. Started and finished lines are paired by seq, as
// readRun pairs them.
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
    const prev = bySeq.get(rec.seq) ?? {};
    bySeq.set(rec.seq, rec.event === 'finished' ? { ...prev, ...rec } : { ...rec, ...prev });
  }
  return { steps: [...bySeq.values()].sort((a, b) => a.seq - b.seq) };
}

// The unfinished step a peer that names no run may belong to: one on the
// macro's workflow of that step's subtask, started since the step started.
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
 */
export async function cleanupDeadRuns({
  mainRoot, macroId = null, selfRunId = null, engineerRoot = null, by,
  env = process.env, now = () => Date.now(), out = () => {}, probe = processFingerprint,
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
      r = await cleanupOne({ mainRoot, file, record, engineerRoot, by, env, now, probe });
    } catch (e) {
      r = { run_id: runId, outcome: 'kept', detail: `the cleanup failed (${e?.message ?? e}); its record is kept` };
    }
    results.push({ macro_id: record.macro_id ?? null, ...r });
  }
  for (const r of results) for (const line of describe(r)) out(line);
  return results;
}

async function cleanupOne({ mainRoot, file, record, engineerRoot, by, env, now, probe }) {
  const runId = record.run_id;
  if (await holderAlive({ pid: record.pid, fingerprint: record.fingerprint, worker: null }, { probe })) {
    return { run_id: runId, outcome: 'live', detail: `its driver (pid ${record.pid}) is running` };
  }
  if (await liveEntry(record, mainRoot, probe)) {
    return { run_id: runId, outcome: 'live', detail: 'its driver is gone, but a worker group of it still runs: /orchestrator:autopilot stop empties it, then cleans up' };
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
    if (!r || real(r.dir) !== real(record.run_dir)) {
      return { run_id: runId, outcome: 'kept', detail: `its ledger ${record.run_dir} is gone; check that run's peers, then delete ${file}` };
    }
    if (r.run.run_id !== runId || (r.run.macro_id ?? null) !== (record.macro_id ?? null)) {
      return { run_id: runId, outcome: 'kept', detail: `its ledger ${r.dir} names run ${r.run.run_id ?? '?'} of macro ${r.run.macro_id ?? '-'}, not its record's; check it, then delete ${file}` };
    }
    const strict = readStepsStrictly(r.dir);
    if (strict.error) {
      return { run_id: runId, outcome: 'kept', detail: `${strict.error}, so its unfinished steps are not known; check ${r.dir}, then delete ${file}` };
    }
    const run = r.run;
    const unfinished = strict.steps.filter((s) => s.event === 'started');

    const engineer = engineerFor(run, engineerRoot);
    const cancelled = [];
    const reported = [];
    const { peers, unreadable } = pendingPeers(peerRunDirs(run, record));
    const unresolved = unreadable.map((p) => ({ ...p, engineer }));
    for (const { root, handle } of peers) {
      const names = handle[AUTOPILOT_RUN_FIELD];
      if (names === runId) {
        if (!engineer) {
          unresolved.push({ run_id: handle.run_id, root, why: 'no engineer peer-runner to cancel it with' });
          continue;
        }
        const c = cancelPeer(engineer, handle.run_id, root, env);
        if (c.settled) cancelled.push(c);
        else {
          const reason = typeof c.result === 'object' ? (c.result.reason ?? JSON.stringify(c.result)) : c.result;
          unresolved.push({ run_id: handle.run_id, root, why: reason, engineer, action: OWNER_ACTION[reason]?.(engineer, root) ?? null });
        }
        continue;
      }
      // Another run's peer, or the owner's.
      if (names !== undefined && names !== null && names !== '') continue;
      const step = stepOfUnnamed(handle, unfinished, record.macro_id);
      if (step) reported.push({ run_id: handle.run_id, root, workflow: handle.workflow_path ?? null, subtask_id: step.subtask_id, seq: step.seq, engineer });
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
    if (complete && (run.status === 'running' || run.status === 'draining')) {
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
    if (complete) removeOpenRun(mainRoot, runId);
    return {
      run_id: runId,
      outcome: complete ? 'cleaned' : 'kept',
      detail: complete ? 'cleaned up after its dead driver' : 'a peer run that may be its could not be cancelled or read; its record is kept',
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
    if (p.run_id === null) {
      lines.push(`  ✗ ${p.why}: its peers cannot be told; check that run's peers there`);
      continue;
    }
    lines.push(`  ✗ peer run ${p.run_id} may be its but was not cancelled (${p.why}); check it, then: ${p.action ?? `node ${p.engineer ?? '<engineer>'}/scripts/peer-runner.mjs cancel --run-id ${p.run_id} --repo-root ${p.root}`}`);
  }
  for (const p of r.reported ?? []) {
    lines.push(`  ⚠ peer run ${p.run_id} on ${p.workflow ?? '?'} (subtask ${p.subtask_id}, step [${p.seq}]) names no run (its peer-runner records none), so it was not cancelled; if it is that step's, cancel it: node ${p.engineer ?? '<engineer>'}/scripts/peer-runner.mjs cancel --run-id ${p.run_id} --repo-root ${p.root}`);
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
