// plugins/orchestrator/adapters/claude/autopilot/parks.mjs
//
// ADR-0068 Decision 1, item 3 — the kept parks. A run with lanes keeps each
// lane it parks in the macro's records beside the holds, not only in the run,
// so neither a relaunch nor a crash loses it:
// `<main>/.agentic-plugins/runs/autopilot/holds/<macro-id>/parks/<subtask-id>.json`,
// one record per subtask, written whole (a temporary file renamed over it),
// under the directory's own lock (`parks/.lock`, a lock of run-locks.mjs, so
// a live holder is never taken over and a dead one is judged by its process),
// each change appended to `parks/events.jsonl`. The holds of Decision 2 live beside it in their own
// subdirectory.
//
// A record is in one of three states:
//   - `creating`: written before a lane's creation, while the run creates it;
//   - `in-flight`: written before a lane step's worker spawns, naming the run,
//     its ledger and the step's seq;
//   - `parked`: the lane is parked, with the reason, detail, pointer and
//     resolution of its halt, and the lane's fingerprint (policy.mjs
//     `parkFingerprint`, versioned).
// The run settles each marker: a lane halt promotes it to `parked`, any other
// end deletes it. A marker a dead run left is judged by the next run of the
// macro from that run's ledger (`stepVerdict`), before it acts on the lane: a
// step that never recorded its verdict parks the lane, so no crash between a
// failed step's end and its park lets a relaunch dispatch the lane again on
// its unchanged record.
//
// Every change the run makes is conditional on the record id its writer last
// read there (`expect`), and a release of a record that cannot be read on the
// bytes it read (`expectDigest`), under the lock: a run never recreates a
// record the owner released, and a release never ends a park newer than the
// one it read. A record that cannot be read is never overwritten: it keeps its
// subtask parked until the owner releases it.

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { isSafeMacroId, isSafeSubtaskId } from './policy.mjs';
import { acquireLock, AUTOPILOT_DIR_REL, LockHeldError, processFingerprint } from '../../../scripts/lib/run-locks.mjs';

export const PARK_SCHEMA = 'agentic-autopilot-park-1.0';
export const PARK_STATES = Object.freeze(['creating', 'in-flight', 'parked']);
// How long a writer waits for the directory's lock while another holds it.
const LOCK_WAIT_MS = 5000;
const RECORD_ID_RE = /^[0-9a-f]{16}$/;

export const newRecordId = () => randomBytes(8).toString('hex');

/** The macro's holds directory, beside its lock (ADR-0068 Decision 2, item 1). */
export function holdsDir(mainRoot, macroId) {
  if (!isSafeMacroId(macroId)) throw new Error(`not a macro id: ${JSON.stringify(macroId)}`);
  return path.join(mainRoot, AUTOPILOT_DIR_REL, 'holds', macroId);
}

export const parksDir = (mainRoot, macroId) => path.join(holdsDir(mainRoot, macroId), 'parks');

export function parkPath(mainRoot, macroId, subtaskId) {
  if (!isSafeSubtaskId(subtaskId)) throw new Error(`not a subtask id: ${JSON.stringify(subtaskId)}`);
  return path.join(parksDir(mainRoot, macroId), `${subtaskId}.json`);
}

function valid(record, subtaskId) {
  return record !== null && typeof record === 'object' && record.schema === PARK_SCHEMA
    && typeof record.record_id === 'string' && RECORD_ID_RE.test(record.record_id)
    && record.subtask_id === subtaskId && PARK_STATES.includes(record.state);
}

/**
 * { state: 'absent' } | { state: 'ok', record } | { state: 'unreadable', error,
 * digest } — `digest` the sha256 of the bytes read, or null when none could be.
 */
export function readPark(mainRoot, macroId, subtaskId) {
  const file = parkPath(mainRoot, macroId, subtaskId);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { state: 'absent' };
    return { state: 'unreadable', error: `cannot read ${file} (${err.code || err.message})`, digest: null };
  }
  const digest = createHash('sha256').update(text).digest('hex');
  let record;
  try { record = JSON.parse(text); } catch (err) {
    return { state: 'unreadable', error: `cannot parse ${file} (${err.message})`, digest };
  }
  return valid(record, subtaskId) ? { state: 'ok', record } : { state: 'unreadable', error: `${file} is not a park record (${PARK_SCHEMA}) of subtask ${subtaskId}`, digest };
}

/**
 * Every record of the macro: { records: [{ subtaskId, file, state, record?,
 * error? }], problem } — `problem` when the directory cannot be listed (a
 * missing one holds none). A file whose name is no subtask id is unreadable.
 */
export function readParks(mainRoot, macroId) {
  const dir = parksDir(mainRoot, macroId);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (err.code === 'ENOENT') return { records: [], problem: null };
    return { records: [], problem: `cannot list ${dir} (${err.code || err.message})` };
  }
  const records = [];
  for (const name of names.sort()) {
    if (!name.endsWith('.json') || name.startsWith('.')) continue;
    const subtaskId = name.slice(0, -'.json'.length);
    const file = path.join(dir, name);
    if (!isSafeSubtaskId(subtaskId)) {
      records.push({ subtaskId, file, state: 'unreadable', error: `${file} names no subtask id` });
      continue;
    }
    records.push({ subtaskId, file, ...readPark(mainRoot, macroId, subtaskId) });
  }
  return { records, problem: null };
}

const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });
// This process's fingerprint, read once: a run writes its parks at each step's
// admission, and a `ps` per write would lengthen every admission.
let selfFingerprint = null;

// The directory's lock, a run-locks.mjs lock (`acquireLock`): an entry per
// participant, judged by its process's fingerprint, so a live holder is never
// taken over however long it holds it, and one whose process is gone is
// cleared. A writer waits for a live holder until `waitMs`, then fails.
async function withLock(mainRoot, macroId, fn, { waitMs = LOCK_WAIT_MS } = {}) {
  const dir = parksDir(mainRoot, macroId);
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, '.lock');
  const deadline = Date.now() + waitMs;
  let held;
  for (;;) {
    try {
      selfFingerprint ??= await processFingerprint(process.pid);
      held = await acquireLock(lock, { record: { kind: 'parks', run_id: `the park records of ${macroId}` }, attempts: 3, selfFingerprint });
      break;
    } catch (err) {
      if (!(err instanceof LockHeldError)) throw err;
      if (Date.now() >= deadline) throw new Error(`the park records' lock ${lock} is held (${err.message})`);
      await pause(20 + Math.floor(Math.random() * 30));
    }
  }
  try {
    return fn();
  } finally {
    held.release();
  }
}

function appendEvent(mainRoot, macroId, record) {
  fs.appendFileSync(path.join(parksDir(mainRoot, macroId), 'events.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`);
}

// The record id there now: a string, null for none, or undefined for a file
// that cannot be read (which no conditional change matches).
const idOf = (cur) => (cur.state === 'ok' ? cur.record.record_id : cur.state === 'absent' ? null : undefined);

/**
 * Write a record, only while the one there is the one its writer last read
 * (`expect`: its record id, or null for none). { ok: true, record } or
 * { ok: false, current } (readPark's answer for what is there).
 */
export async function writePark(mainRoot, macroId, record, { expect = null, waitMs } = {}) {
  if (!valid(record, record?.subtask_id)) throw new Error(`not a park record: ${JSON.stringify(record)}`);
  return withLock(mainRoot, macroId, () => {
    const cur = readPark(mainRoot, macroId, record.subtask_id);
    if (idOf(cur) !== expect) return { ok: false, current: cur };
    const file = parkPath(mainRoot, macroId, record.subtask_id);
    const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
    fs.renameSync(tmp, file);
    appendEvent(mainRoot, macroId, { event: record.state, subtask_id: record.subtask_id, record_id: record.record_id, run_id: record.run_id ?? null, reason: record.reason ?? null });
    return { ok: true, record };
  }, { waitMs });
}

/**
 * Delete a subtask's record, only while it is the one its deleter last read:
 * `expect` a record id, or `expectDigest` the digest readPark gave of a record
 * that cannot be read (the bytes are still the ones read). With neither,
 * whatever is there. `event` and `fields` go to the events file.
 * { ok: true, current } or { ok: false, current }.
 */
export async function deletePark(mainRoot, macroId, subtaskId, { expect, expectDigest, event, fields = {}, waitMs }) {
  return withLock(mainRoot, macroId, () => {
    const cur = readPark(mainRoot, macroId, subtaskId);
    if (cur.state === 'absent') return { ok: expect === undefined && expectDigest === undefined, current: cur };
    if (expectDigest !== undefined) {
      if (cur.state !== 'unreadable' || cur.digest !== expectDigest) return { ok: false, current: cur };
    } else if (expect !== undefined && idOf(cur) !== expect) return { ok: false, current: cur };
    fs.rmSync(parkPath(mainRoot, macroId, subtaskId), { force: true });
    appendEvent(mainRoot, macroId, { event, subtask_id: subtaskId, record_id: cur.record?.record_id ?? null, ...fields });
    return { ok: true, current: cur };
  }, { waitMs });
}

/**
 * The verdict a run's ledger holds for one step: its `finished` line, or null
 * when it has none (the run stopped before it judged the step). A ledger that
 * cannot be read holds none.
 */
export function stepVerdict(runDir, seq) {
  if (typeof runDir !== 'string' || !Number.isInteger(seq)) return null;
  let text = '';
  try { text = fs.readFileSync(path.join(runDir, 'steps.jsonl'), 'utf8'); } catch { return null; }
  let found = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r?.event === 'finished' && r.seq === seq) found = r;
    } catch { /* torn */ }
  }
  return found;
}

/**
 * The records that no longer apply, which any reader may delete (lazily, on
 * read): a subtask completed or no longer in the plan, or every record of a
 * macro that is archived. Returns the subtask ids of { records } that retire.
 */
export function retiring(records, view) {
  const macro = view?.macro;
  if (!macro) return [];
  if (macro.archived) return records.map((r) => r.subtaskId);
  const subtasks = Array.isArray(macro.fm?.plan?.subtasks) ? macro.fm.plan.subtasks : [];
  return records.filter((r) => {
    const s = subtasks.find((x) => x?.id === r.subtaskId);
    return !s || s.status === 'completed';
  }).map((r) => r.subtaskId);
}
