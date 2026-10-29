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
//   landing.jsonl       a `landing-ready` line for each observation of a
//                       committed subtask the run reported, whatever its
//                       readiness: its `ready` field, not the event name, says
//                       whether it can land (landing-ready.mjs, ADR-0067
//                       Decision 7)
//   lanes.jsonl         the lane events of a run with lanes: created, adopted,
//                       removed, kept, reconciled, reported, identity-assigned,
//                       lanes-first-run, fetch-warning, parked, resumed
//                       (lanes.mjs, ADR-0067 Decisions 5 and 6; scheduler.mjs,
//                       ADR-0068 Decision 1: the kept parks themselves are in
//                       the macro's holds directory, parks.mjs); the lane's
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
// before its first spawn until it ends with every worker group empty and
// every step's peers accounted for (ADR-0067 Decision 6, Locks; a step whose
// peers are not records `peers_unaccounted` on its `finished` line). It points at the run's ledger, so a run whose
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

/**
 * ADR-0068 Decision 1, item 4 — the bare release that ends a lane's kept
 * park, with or without a live run.
 */
export function releaseCommand({ subtaskId, macroId, repoRoot }) {
  const a = `release ${subtaskId} --macro ${macroId}`;
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

/**
 * A `stall` line (ADR-0068 Decision 3, item 7): whole, or not at all. Its
 * failure is counted and the run goes on, so a write cut short is taken back
 * (the file truncated to its size before it), never left for the step's
 * `finished` line to join. Throws the write's error, after the truncation.
 * `writeSync` is a test seam.
 */
export function appendStallLine(runDir, record, { writeSync = fs.writeSync } = {}) {
  const fd = fs.openSync(path.join(runDir, 'steps.jsonl'), 'a');
  try {
    const size = fs.fstatSync(fd).size;
    const buf = Buffer.from(`${JSON.stringify(record)}\n`);
    try {
      for (let off = 0; off < buf.length;) off += writeSync(fd, buf, off, buf.length - off);
    } catch (e) {
      try { fs.ftruncateSync(fd, size); } catch { /* the reader passes a torn last line over */ }
      throw e;
    }
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Append one line to a JSONL file, creating it and its directory. A torn last
 * line (a writer that died mid-line) is ended first, so the two never join
 * and the next record still parses. A short write is continued from the byte
 * it stopped at; a write that makes no progress throws. `writeSync` is a test
 * seam.
 */
export function appendLine(file, line, { writeSync = fs.writeSync } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a+');
  try {
    const { size } = fs.fstatSync(fd);
    let lead = '';
    if (size > 0) {
      const last = Buffer.alloc(1);
      fs.readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== 0x0a) lead = '\n';
    }
    const bytes = Buffer.from(`${lead}${line}\n`, 'utf8');
    for (let at = 0; at < bytes.length;) {
      const n = writeSync(fd, bytes, at, bytes.length - at);
      if (!(n > 0)) throw new Error(`could not append to ${file}: a write made no progress`);
      at += n;
    }
  } finally {
    fs.closeSync(fd);
  }
}

export function appendLanding(runDir, record, o) {
  appendLine(path.join(runDir, 'landing.jsonl'), JSON.stringify(record), o);
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
 * halt.json. A step's `stall` lines (ADR-0068 Decision 3) are observations,
 * never part of its lifecycle: each step lists them in `stalls`, in order.
 */
export function readRun(repoRoot, runId) {
  const dir = path.join(autopilotDir(repoRoot), runId);
  const run = readJson(path.join(dir, 'run.json'));
  if (!run) return null;
  const steps = new Map();
  const stalls = new Map();
  for (const rec of readLines(path.join(dir, 'steps.jsonl'))) {
    if (rec.event === 'stall') {
      if (!stalls.has(rec.seq)) stalls.set(rec.seq, []);
      stalls.get(rec.seq).push(rec);
      continue;
    }
    const prev = steps.get(rec.seq) ?? {};
    steps.set(rec.seq, rec.event === 'finished' ? { ...prev, ...rec } : { ...rec, ...prev });
  }
  return {
    dir, run,
    steps: [...steps.values()].sort((a, b) => a.seq - b.seq).map((s) => ({ ...s, stalls: stalls.get(s.seq) ?? [] })),
    landing: readLines(path.join(dir, 'landing.jsonl')),
    lanes: readLines(path.join(dir, 'lanes.jsonl')),
    halt: readJson(path.join(dir, 'halt.json')),
  };
}

