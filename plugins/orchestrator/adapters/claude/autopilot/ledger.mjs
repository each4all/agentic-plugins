// plugins/orchestrator/adapters/claude/autopilot/ledger.mjs
//
// ADR-0063 D8 — the run ledger and the per-macro lock.
//
// Everything a run leaves lives under
// `<repo>/.agentic-plugins/runs/autopilot/<run-id>/`:
//   run.json            options, model plan, roots, pinned versions, git
//                       baseline, macro, status, step count, cost, halt
//   steps.jsonl         a `started` line written BEFORE the worker is spawned
//                       (D1: every spawn is on record before it starts), then a
//                       `finished` line after it
//   landing.jsonl       a `landing-ready` line for each committed subtask the
//                       run reported (landing-ready.mjs, ADR-0067 Decision 7)
//   lanes.jsonl         the lane events of a run with lanes: created, adopted,
//                       removed, kept, reconciled, reported, identity-assigned,
//                       lanes-first-run, fetch-warning
//                       (lanes.mjs, ADR-0067 Decisions 5 and 6); the lane's
//                       git lock reason, not this file, proves ownership
//   worker-<seq>.jsonl  the raw worker stream (byte-capped by worker.mjs)
//   halt.json           reason, detail, pointer, resume hints
//
// The lock is per macro (D8: at most one run drives a macro), under the main
// worktree so linked worktrees share it (scripts/lib/run-locks.mjs):
// `<main>/.agentic-plugins/runs/autopilot/locks/<macro-id>.lock/`. The
// macro's landing log sits beside it (`landing/<macro-id>.jsonl`). The lock is a
// directory of participant entries, each holding its run's pid and process
// fingerprint (the peer-runner pattern), so an entry whose run died, or whose
// pid was reused, is recognised as stale.
//
// Beside the locks, outside every lock directory, each run keeps an open-run
// record, `<main>/.agentic-plugins/runs/autopilot/open/<run-id>.json`, from
// before its first spawn until it ends with every worker group empty
// (ADR-0067 Decision 6, Locks). It points at the run's ledger, so a run whose
// driver died is found and cleaned up after (dead-runs.mjs), from any
// checkout: no lock consumer lists that directory, so no lock cleanup deletes
// the pointer. Whoever cleans up after a run holds `open/<run-id>.cleanup.lock/`
// meanwhile, so two cleaners never meet in one ledger.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { isAutopilotRun } from '../../../scripts/state.mjs';
import { AUTOPILOT_DIR_REL } from '../../../scripts/lib/run-locks.mjs';

// The locks moved to scripts/lib/run-locks.mjs (ADR-0067 Decision 4, item 5:
// the interactive commands and their Codex mirrors take part in them too).
export {
  AUTOPILOT_DIR_REL,
  LockHeldError,
  acquireLock,
  holderAlive,
  listLocks,
  macroLockPath,
  mainWorktreeRoot,
  processFingerprint,
  provablySame,
  readLockEntries,
  worktreeLockPath,
} from '../../../scripts/lib/run-locks.mjs';


export function autopilotDir(repoRoot) {
  return path.join(repoRoot, AUTOPILOT_DIR_REL);
}

export function newRunId(now = new Date(), random = () => randomBytes(3).toString('hex')) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const id = `autopilot-${stamp}-${random()}`;
  // The id is the AGENTIC_AUTOPILOT value; runbooks treat a malformed one as
  // "autopilot off", which would silently run every step interactively.
  if (!isAutopilotRun({ AGENTIC_AUTOPILOT: id })) throw new Error(`generated run id ${id} is not a valid autopilot run id`);
  return id;
}

/**
 * ADR-0067 Decision 6 — the command that relaunches a run: it repeats the
 * run's macro and its lanes, since a run with lanes is proposed from a
 * checkout no one works in, often off the branch the macro would be found
 * from. `--lanes` is repeated when the run had two or more.
 */
export function relaunchCommand({ macroId = null, lanes = 1, repoRoot }) {
  const args = ['start --execute'];
  if (macroId) args.push(`--macro ${macroId}`);
  if (Number.isInteger(lanes) && lanes >= 2) args.push(`--lanes ${lanes}`);
  const a = args.join(' ');
  return `/orchestrator:autopilot ${a}   (or: agentic-autopilot ${a} --repo ${repoRoot})`;
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

export function createRunDir(repoRoot, runId) {
  if (!isAutopilotRun({ AGENTIC_AUTOPILOT: runId })) throw new Error(`invalid run id ${runId}`);
  const dir = path.join(autopilotDir(repoRoot), runId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function writeRun(runDir, run) {
  writeJsonAtomic(path.join(runDir, 'run.json'), run);
}

export function appendStep(runDir, record) {
  fs.appendFileSync(path.join(runDir, 'steps.jsonl'), `${JSON.stringify(record)}\n`);
}

export function appendLanding(runDir, record) {
  fs.appendFileSync(path.join(runDir, 'landing.jsonl'), `${JSON.stringify(record)}\n`);
}

export function appendLaneEvent(runDir, record) {
  fs.appendFileSync(path.join(runDir, 'lanes.jsonl'), `${JSON.stringify(record)}\n`);
}

export function writeHalt(runDir, haltRecord) {
  writeJsonAtomic(path.join(runDir, 'halt.json'), haltRecord);
}

export function workerStreamPath(runDir, seq) {
  return path.join(runDir, `worker-${seq}.jsonl`);
}

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
};

/** Run ids under the repository's ledger, oldest first. */
export function listRuns(repoRoot) {
  let names = [];
  try { names = fs.readdirSync(autopilotDir(repoRoot)); } catch { return []; }
  return names.filter((n) => isAutopilotRun({ AGENTIC_AUTOPILOT: n })).sort();
}

const readLines = (file) => {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* none yet */ }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn */ }
  }
  return out;
};

// ---------------------------------------------------------------------------
// Open-run records (ADR-0067 Decision 6, Locks)

export const OPEN_RUN_SCHEMA = 'agentic-autopilot-open-run-1.0';

export function openRunsDir(mainRoot) {
  return path.join(mainRoot, AUTOPILOT_DIR_REL, 'open');
}

export function openRunPath(mainRoot, runId) {
  if (!isAutopilotRun({ AGENTIC_AUTOPILOT: runId })) throw new Error(`invalid run id ${runId}`);
  return path.join(openRunsDir(mainRoot), `${runId}.json`);
}

/**
 * Write a run's record: its id, macro, the checkout and run directory of its
 * ledger, and its driver's pid and fingerprint, judged as a lock entry's are.
 */
export function writeOpenRun(mainRoot, { runId, macroId, checkout, runDir, pid, fingerprint, startedAt }) {
  const file = openRunPath(mainRoot, runId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, {
    schema: OPEN_RUN_SCHEMA, run_id: runId, macro_id: macroId ?? null, checkout, run_dir: runDir,
    pid, fingerprint, started_at: startedAt,
  });
  return file;
}

export function removeOpenRun(mainRoot, runId) {
  try {
    fs.unlinkSync(openRunPath(mainRoot, runId));
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

export function readOpenRun(mainRoot, runId) {
  return readJson(openRunPath(mainRoot, runId));
}

/**
 * Every open-run record under the main worktree, oldest run first:
 * [{ file, runId, record }] — `record` null, with `error`, for one that does
 * not read as a record of its name.
 */
export function listOpenRuns(mainRoot) {
  let names = [];
  try {
    names = fs.readdirSync(openRunsDir(mainRoot));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const runId = name.slice(0, -'.json'.length);
    if (!isAutopilotRun({ AGENTIC_AUTOPILOT: runId })) continue;
    const file = path.join(openRunsDir(mainRoot), name);
    let record = null;
    let error = null;
    try {
      record = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code === 'ENOENT') continue; // removed meanwhile
      error = err.message;
    }
    if (record && (record.schema !== OPEN_RUN_SCHEMA || record.run_id !== runId
      || typeof record.checkout !== 'string' || typeof record.run_dir !== 'string')) {
      error = `not an open-run record of ${runId}`;
      record = null;
    }
    out.push({ file, runId, record, ...(error ? { error } : {}) });
  }
  return out;
}

/**
 * One run's records: run.json, the steps (started/finished paired by seq), the
 * landing-ready records and the lane events in the order they were written,
 * halt.json.
 */
export function readRun(repoRoot, runId) {
  const dir = path.join(autopilotDir(repoRoot), runId);
  const run = readJson(path.join(dir, 'run.json'));
  if (!run) return null;
  const steps = new Map();
  for (const rec of readLines(path.join(dir, 'steps.jsonl'))) {
    const prev = steps.get(rec.seq) ?? {};
    steps.set(rec.seq, rec.event === 'finished' ? { ...prev, ...rec } : { ...rec, ...prev });
  }
  return {
    dir, run,
    steps: [...steps.values()].sort((a, b) => a.seq - b.seq),
    landing: readLines(path.join(dir, 'landing.jsonl')),
    lanes: readLines(path.join(dir, 'lanes.jsonl')),
    halt: readJson(path.join(dir, 'halt.json')),
  };
}

