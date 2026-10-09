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

/**
 * One run's records: run.json, the steps (started/finished paired by seq), the
 * landing-ready records in the order they were written, halt.json.
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
    halt: readJson(path.join(dir, 'halt.json')),
  };
}

