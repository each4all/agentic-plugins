// plugins/orchestrator/adapters/claude/autopilot/events.mjs
//
// ADR-0068 Decision 4 — the driver's event file, watched by the main session.
//
// One append-only file per lock scope:
//   a run of a macro:  <main>/.agentic-plugins/runs/autopilot/events/<macro-id>.jsonl
//   a verb chain:      <checkout>/.agentic-plugins/runs/autopilot/events.jsonl
// Its writers are the driver of a run once it holds its locks, and the
// cleanup of a run whose driver died (dead-runs.mjs), which writes that run's
// `run-ended`. Each line is one JSON object of machine data only: codes from
// closed sets, ids checked against their alphabets, integers, booleans, and
// the paths of records the driver writes, every name in them from its set or
// alphabet (recordPathParts). A field outside its kind's allow-list,
// or a value outside its set, is refused, and the refusal counts as a failed
// write: no text a worker, a peer or a person wrote reaches the file.
//
// The writer (createEventWriter) is synchronous, so the order of the lines a
// process writes is the order of its calls. Appends are serialized by a lock
// file beside the event file (`<file>.lock`, written to a file of its own and
// linked into place, so it appears whole or not at all, holding its writer's
// pid and a token of its own): a lock whose writer is dead is taken
// over, one whose writer lives never is, and a writer removes only the lock
// that still holds its token. Under the lock the writer reads the file, chooses the
// next `seq` of its run (one above the highest seq it has used, its write
// failed or not, and above every parseable line of its run on file, a torn
// last line holding complete JSON included), and appends one whole line with
// ledger.mjs `appendLine`, which ends a torn last line first. `run-ended` is
// written at most once per run, and `lane-released` once per release id: a
// writer that finds one on file writes nothing more for it, but still ends a
// torn last line, so a reader that holds it until its newline delivers it.
// A writer is closed once it has written its run's `run-ended` (or tried to):
// nothing a run does after its end is published. No call throws: a failure
// is returned, and passed to `onFailure`, which the driver counts in run.json.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { appendLine } from './ledger.mjs';
import { HALT_REASONS, isSafeMacroId, isSafeSubtaskId, OWNER_GATES } from './codes.mjs';
import { AUTOPILOT_DIR_REL } from '../../../scripts/lib/run-locks.mjs';
import { shellQuote } from '../../../scripts/lib/worktree-proposal.mjs';

export const EVENT_SCHEMA = 'agentic-autopilot-event/1';
export const READER_SCHEMA = 'agentic-autopilot-reader/1';
export const EVENT_KINDS = Object.freeze([
  'run-started', 'halt', 'lane-parked', 'lane-resumed', 'lane-held', 'lane-released',
  'step-failed', 'commit-finished', 'stall', 'run-ended',
]);
// Only `run-ended` is terminal: the one line of a run a watcher must see.
export const TERMINAL_KINDS = Object.freeze(['run-ended']);
export const READER_KINDS = Object.freeze([
  'reader-armed', 'reader-gap', 'reader-skipped', 'reader-terminal-missing', 'reader-error', 'reader-summary',
]);

// The closed sets the fields take their codes from.
export const RESUME_CAUSES = Object.freeze(['record-changed', 'release', 'hold-ended', 'forced']);
export const RELEASE_VERDICTS = Object.freeze(['consumed', 'rejected']);
export const RUN_STATUSES = Object.freeze(['completed', 'halted', 'error']);
export const READINESS = Object.freeze(['ready', 'needs-sync', 'unknown']);
// The worker's abort kinds (worker.mjs; `stalled` is Decision 3's).
export const ABORT_KINDS = Object.freeze(['timeout', 'stalled', 'interrupted', 'compaction-imminent', 'provenance']);
// Decision 3's verdicts, and the detector's modes that write a `stall` line
// (`--stall-detector log`, the default, and `on`). A run-started line names
// the run's mode; `off` is what a run before impl-stall wrote, still read.
export const STALL_VERDICTS = Object.freeze(['active', 'stalled', 'unknown']);
export const STALL_MODES = Object.freeze(['log', 'on']);
export const DETECTOR_MODES = Object.freeze(['off', ...STALL_MODES]);
// The records a path field names, each in a run's directory.
export const RUN_RECORDS = Object.freeze(['run.json', 'halt.json', 'steps.jsonl', 'lanes.jsonl', 'landing.jsonl']);
// A step's outcome: a halt code, or `error` when the run stopped on one.
export const STEP_OUTCOMES = Object.freeze([...HALT_REASONS, 'error']);
// The lock is held for one read and one append; a writer waits this long.
export const LOCK_WAIT_MS = 2000;
// A `stall` event is written from inside a running step, on the event loop
// every lane's stream and timers share (Decision 3, item 7: the detector
// records and never acts), so it waits on no other writer: it takes the lock
// when it is free (a held one costs it one 10 ms pause), and is otherwise
// refused and counted. Its record is the step's `stall` line in steps.jsonl,
// written first; the event only points at it.
export const STALL_LOCK_WAIT_MS = 0;
// A lock that does not read (its writer died between creating and filling
// it) is taken over once it is this old.
const LOCK_TORN_MS = 2000;

const RUN_ID_RE = /^autopilot-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
// A hold's and a release's id (holds-records.mjs `newRecordId`).
const RELEASE_ID_RE = /^[0-9a-f]{16}$/;
const HOLD_ID_RE = /^[0-9a-f]{16}$/;
const COMMIT_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export const isRunId = (id) => typeof id === 'string' && RUN_ID_RE.test(id);

/** A halt's reason code: a HALT_REASONS member, or `awaiting-owner:<gate>`. */
export function isHaltCode(v) {
  if (typeof v !== 'string') return false;
  if (HALT_REASONS.includes(v)) return true;
  const m = /^awaiting-owner:(.+)$/.exec(v);
  return Boolean(m && OWNER_GATES.includes(m[1]));
}

const oneOf = (set) => (v) => set.includes(v);
const nullable = (check) => (v) => v === null || check(v);
const int = (min = 0) => (v) => Number.isInteger(v) && v >= min;
const bool = (v) => typeof v === 'boolean';
// A path names a record the driver writes, and nothing else: the checkout it
// is in, then the checkout's autopilot tree and, under it, a run's directory
// (`<run-id>`), one of its records (`<run-id>/<RUN_RECORDS>`), a macro's
// landing log (`landing/<macro-id>.jsonl`) or a lane's kept park
// (`holds/<macro-id>/parks/<subtask-id>.json`), each name from its set or
// alphabet. The checkout is absolute and normalized, with no control,
// format or separator character (a bidi override, a line break); the reader
// prints it only when it is one of the repository's checkouts (shownEvent).
const UNSAFE_PATH_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const TREE = `/${AUTOPILOT_DIR_REL}/`;
/** A path field's parts: { root, kind } (`run-dir` or `record`), or null. */
export function recordPathParts(v) {
  if (typeof v !== 'string' || v.length === 0 || v.length > 4096 || !path.posix.isAbsolute(v)) return null;
  if (UNSAFE_PATH_RE.test(v) || path.posix.normalize(v) !== v) return null;
  const at = v.indexOf(TREE);
  if (at <= 0) return null;
  const root = v.slice(0, at);
  const rest = v.slice(at + TREE.length).split('/');
  if (rest.length === 1 && isRunId(rest[0])) return { root, kind: 'run-dir' };
  if (rest.length === 2 && isRunId(rest[0]) && RUN_RECORDS.includes(rest[1])) return { root, kind: 'record' };
  if (rest.length === 2 && rest[0] === 'landing' && rest[1].endsWith('.jsonl') && isSafeMacroId(rest[1].slice(0, -'.jsonl'.length))) return { root, kind: 'record' };
  if (rest.length === 4 && rest[0] === 'holds' && isSafeMacroId(rest[1]) && rest[2] === 'parks'
    && rest[3].endsWith('.json') && isSafeSubtaskId(rest[3].slice(0, -'.json'.length))) return { root, kind: 'record' };
  return null;
}
const runDirPath = (v) => recordPathParts(v)?.kind === 'run-dir';
const recordPath = (v) => recordPathParts(v)?.kind === 'record';
// The fields that hold a path, which the reader holds to the checkouts.
export const PATH_FIELDS = Object.freeze(['run_dir', 'pointer', 'step_record']);

// Each kind's own fields, and nothing else.
const FIELDS = Object.freeze({
  'run-started': { lanes: int(1), detector: oneOf(DETECTOR_MODES), run_dir: runDirPath, pointer: recordPath },
  halt: { reason: isHaltCode, step: nullable(int(1)), pointer: recordPath, step_record: nullable(recordPath) },
  'lane-parked': { reason: isHaltCode, step: nullable(int(1)), kept: bool, pointer: recordPath },
  'lane-resumed': { cause: oneOf(RESUME_CAUSES), pointer: recordPath },
  'lane-held': { hold_id: (v) => typeof v === 'string' && HOLD_ID_RE.test(v), pointer: recordPath },
  'lane-released': {
    hold_id: nullable((v) => typeof v === 'string' && HOLD_ID_RE.test(v)),
    release_id: (v) => typeof v === 'string' && RELEASE_ID_RE.test(v),
    verdict: oneOf(RELEASE_VERDICTS), pointer: recordPath,
  },
  'step-failed': { step: int(1), reason: oneOf(STEP_OUTCOMES), abort: nullable(oneOf(ABORT_KINDS)), pointer: recordPath },
  'commit-finished': { step: int(1), commit: (v) => typeof v === 'string' && COMMIT_RE.test(v), readiness: oneOf(READINESS), pointer: recordPath },
  // Decision 3's (impl-stall): the verdict, the mode, the quiet time, the
  // window's CPU (null when unknown) and the unknown time in it, in whole ms,
  // and the wait's three facts (stallEventFields).
  stall: {
    step: int(1), verdict: oneOf(STALL_VERDICTS), mode: oneOf(STALL_MODES),
    quiet_ms: int(0), window_cpu_ms: nullable(int(0)), unknown_ms: int(0),
    pending_tasks: int(0), tool_running: bool, answer_owed: bool, pointer: recordPath,
  },
  'run-ended': {
    status: oneOf(RUN_STATUSES), reason: nullable(isHaltCode), exit: oneOf([0, 1, 2]), pointer: recordPath, cleanup: bool,
  },
});

/**
 * Why an event cannot be written as given, or null: its kind, its subtask id
 * and every field are checked; a field its kind does not list, a missing
 * one, or a value outside its set is refused.
 */
export function eventProblem(kind, subtaskId, fields) {
  const spec = typeof kind === 'string' && Object.hasOwn(FIELDS, kind) ? FIELDS[kind] : null;
  if (!spec) return `unknown event kind ${JSON.stringify(kind)}`;
  if (!(subtaskId === null || isSafeSubtaskId(subtaskId))) return `${kind}: subtask_id is not a subtask id`;
  if (fields === null || typeof fields !== 'object') return `${kind}: no fields`;
  for (const k of Object.keys(fields)) if (!Object.hasOwn(spec, k)) return `${kind}: field ${k} is not one of its fields`;
  for (const [k, check] of Object.entries(spec)) {
    if (!Object.hasOwn(fields, k)) return `${kind}: field ${k} is missing`;
    if (!check(fields[k])) return `${kind}: field ${k} is not a value it takes`;
  }
  return null;
}

const wholeMs = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : v);

/**
 * A detector's record (stall.mjs) as a `stall` event's fields: times rounded
 * to whole ms (the detector compares in full precision), the mode added, the
 * record's `why` left to steps.jsonl, which the pointer names.
 */
export function stallEventFields(record, { step, mode, pointer }) {
  return {
    step, verdict: record.verdict, mode,
    quiet_ms: wholeMs(record.quiet_ms), window_cpu_ms: record.window_cpu_ms === null ? null : wholeMs(record.window_cpu_ms),
    unknown_ms: wholeMs(record.unknown_ms), pending_tasks: record.pending_tasks,
    tool_running: record.tool_running === true, answer_owed: record.answer_owed === true, pointer,
  };
}

/** The event file of a run: its macro's, under the main worktree, or its checkout's. */
export function eventsPath({ mainRoot, macroId = null, checkout }) {
  if (macroId !== null && macroId !== undefined) {
    if (!isSafeMacroId(macroId)) throw new Error(`invalid macro id ${macroId}`);
    return path.join(mainRoot, AUTOPILOT_DIR_REL, 'events', `${macroId}.jsonl`);
  }
  return path.join(checkout, AUTOPILOT_DIR_REL, 'events.jsonl');
}

/** The Monitor command that watches a run's file from its first line, as a shell runs it. */
export function watchCommand({ macroId = null, checkout, runId }) {
  const where = macroId ? `--macro ${macroId}` : `--checkout ${shellQuote(checkout)}`;
  return `agentic-autopilot events ${where} --after ${runId}:0 --follow`;
}

/**
 * The lines of an event file's text: { start, end, complete, raw, event },
 * `complete` when its newline is there, `event` the parsed object or null.
 * The last line, cut short, is listed with complete false.
 */
export function splitLines(text) {
  const out = [];
  let at = 0;
  while (at < text.length) {
    const nl = text.indexOf('\n', at);
    const complete = nl !== -1;
    const end = complete ? nl : text.length;
    const raw = text.slice(at, end);
    let event = null;
    if (raw.trim()) {
      try {
        const v = JSON.parse(raw);
        if (v && typeof v === 'object' && !Array.isArray(v)) event = v;
      } catch { /* torn or not JSON */ }
    }
    if (raw.trim() || complete) out.push({ start: at, end, complete, raw, event });
    at = complete ? nl + 1 : text.length;
  }
  return out;
}

/** Whether a parsed line is an event with an identity. */
export const hasIdentity = (e) => Boolean(e) && isRunId(e.run_id) && Number.isInteger(e.seq) && e.seq >= 1 && typeof e.kind === 'string';

// The keys every line has before its kind's fields, in the writer's order.
const HEAD_KEYS = Object.freeze(['schema', 'run_id', 'seq', 'at', 'kind', 'macro_id', 'subtask_id']);
// The writer's `at`: Date#toISOString.
const AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * A parsed line held to the writer's rules, as the reader passes it on: the
 * line itself when it is one the writer could have written (this schema, an
 * identity, a known kind, its `at`, macro and subtask ids, exactly its kind's
 * fields with values in their sets, `terminal: true` on a terminal kind and
 * nowhere else), else null. The file is append-only for anyone who can write
 * it, so the writer's allow-lists protect it only once the reader checks them
 * again: a line that fails reaches nobody (ADR-0068 Decision 4, item 2).
 * The writer's dedupe and the reader take the same lines: whether a line is
 * an event never depends on the checkouts there are now (shownEvent).
 */
export function eventOfLine(v) {
  if (!hasIdentity(v) || v.schema !== EVENT_SCHEMA || !EVENT_KINDS.includes(v.kind)) return null;
  if (typeof v.at !== 'string' || !AT_RE.test(v.at) || !Number.isFinite(Date.parse(v.at))) return null;
  if (!Object.hasOwn(v, 'macro_id') || !(v.macro_id === null || isSafeMacroId(v.macro_id))) return null;
  if (!Object.hasOwn(v, 'subtask_id')) return null;
  const terminal = TERMINAL_KINDS.includes(v.kind);
  if (terminal ? v.terminal !== true : Object.hasOwn(v, 'terminal')) return null;
  // Own data properties, so a `__proto__` key on the line is a field like any
  // other (and refused), never the prototype of the fields checked.
  const fields = Object.fromEntries(Object.entries(v).filter(([k]) => !HEAD_KEYS.includes(k) && k !== 'terminal'));
  if (eventProblem(v.kind, v.subtask_id, fields) !== null) return null;
  return v;
}

/**
 * An event as the reader prints it: each path field whose checkout `isRoot`
 * does not take (a directory named by text, or a checkout removed since) is
 * null, so no word of the path's own reaches the session, while the line
 * stays the event it is, for its cursor and its run's end. No `isRoot`, and
 * the event is printed as it is.
 */
export function shownEvent(e, isRoot = null) {
  if (!isRoot) return e;
  let shown = e;
  for (const k of PATH_FIELDS) {
    if (!Object.hasOwn(e, k) || e[k] === null) continue;
    if (!isRoot(recordPathParts(e[k]).root)) shown = { ...shown, [k]: null };
  }
  return shown;
}

// ---------------------------------------------------------------------------
// The file's lock: a file linked into place whole, holding its writer's pid.

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

const sleepSync = (ms) => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

/**
 * Take the lock of `file`, waiting up to `waitMs`: a lock whose writer is
 * dead is taken over, one whose writer lives is waited on however old it is
 * (a writer suspended while it holds it still holds it). Returns its release,
 * which removes the lock only while it is still this one. Throws when the
 * lock is still there at the bound, a dead writer's that cannot be removed
 * included. The bound is measured on `clockMs`, a clock that moves (never
 * the run's event clock, which a test may freeze).
 */
export function lockEventFile(file, { waitMs = LOCK_WAIT_MS, clockMs = () => performance.now() } = {}) {
  const lock = `${file}.lock`;
  const deadline = clockMs() + waitMs;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let holder = null;
  for (let tried = false; ; tried = true) {
    // Every retry checks the bound, whatever sent it round again.
    if (tried && clockMs() >= deadline) throw new Error(`the event file's lock ${lock} is held${holder ? ` by pid ${holder.pid}` : ''}`);
    holder = null;
    const token = randomBytes(8).toString('hex');
    const mine = JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() });
    // The lock appears whole or not at all: written to a file of its own,
    // then linked in place (which fails when a lock is there), so no live
    // writer's lock is ever seen empty and taken for a torn one.
    const tmp = `${lock}.${process.pid}.${token}`;
    try {
      fs.writeFileSync(tmp, mine, { flag: 'wx' });
      try {
        fs.linkSync(tmp, lock);
      } finally {
        try { fs.unlinkSync(tmp); } catch { /* gone */ }
      }
      return () => {
        try {
          if (fs.readFileSync(lock, 'utf8') === mine) fs.unlinkSync(lock);
        } catch { /* gone */ }
      };
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
    }
    let raw = null;
    let st = null;
    try {
      raw = fs.readFileSync(lock, 'utf8');
      st = fs.statSync(lock);
    } catch (e) {
      if (e?.code === 'ENOENT') continue;
      throw e;
    }
    try { holder = JSON.parse(raw); } catch { /* torn: its writer died writing it, before this writer's way */ }
    const stale = holder ? !pidAlive(holder.pid) : Date.now() - st.mtimeMs > LOCK_TORN_MS;
    if (stale) {
      // Only the lock judged: one another writer took meanwhile stays. A
      // lock removed, or gone, is tried again at once; one that cannot be
      // removed (its directory not writable) is waited on to the bound.
      let removed = true;
      try {
        if (fs.readFileSync(lock, 'utf8') === raw) fs.unlinkSync(lock);
      } catch (e) {
        removed = e?.code === 'ENOENT';
      }
      if (removed) continue;
    }
    sleepSync(10);
  }
}

// ---------------------------------------------------------------------------
// The writer.

/**
 * A run's writer of its event file.
 *
 * @param a.file       the event file (eventsPath)
 * @param a.runId      the run the lines are of
 * @param a.macroId    its macro, or null
 * @param a.now        the clock (ms)
 * @param a.onFailure  called with the error of each failed write
 * @param a.lockWaitMs how long a write waits for the lock (emit's own
 *                     `lockWaitMs` overrides it for one write)
 * @param a.writeSync  appendLine's write (a test seam)
 * @returns { emit(kind, fields, { subtaskId, lockWaitMs }), close(), closed, failures }
 */
export function createEventWriter({
  file, runId, macroId = null, now = () => Date.now(), onFailure = () => {}, lockWaitMs = LOCK_WAIT_MS, writeSync,
}) {
  let used = 0;
  let closed = false;
  let failures = 0;
  const fail = (error) => {
    failures += 1;
    try { onFailure(error); } catch { /* the caller's */ }
    return { ok: false, error };
  };
  const w = {
    get closed() { return closed; },
    get failures() { return failures; },
    close() { closed = true; },
    emit(kind, fields, { subtaskId = null, lockWaitMs: waitMs = lockWaitMs } = {}) {
      if (closed) return { ok: false, closed: true };
      if (kind === 'run-ended') closed = true;
      const problem = !isRunId(runId) ? `invalid run id ${runId}`
        : !(macroId === null || isSafeMacroId(macroId)) ? `invalid macro id ${macroId}`
          : eventProblem(kind, subtaskId, fields);
      if (problem) return fail(problem);
      let release = null;
      try {
        release = lockEventFile(file, { waitMs });
        let text = '';
        try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
        let max = 0;
        let existing = null;
        for (const l of splitLines(text)) {
          const e = l.event;
          if (!hasIdentity(e)) continue;
          if (e.run_id === runId && e.seq > max) max = e.seq;
          // Only a line a reader delivers stands for the one this would
          // write: a forged or malformed one, which every reader skips, would
          // otherwise suppress the run's real end (its seq is still passed).
          if (kind === 'run-ended' && e.kind === 'run-ended' && e.run_id === runId && eventOfLine(e)) existing = e;
          if (kind === 'lane-released' && e.kind === 'lane-released' && e.release_id === fields.release_id && eventOfLine(e)) existing = e;
        }
        if (existing) {
          // Written already, by this run or another writer of it: nothing
          // more, but a torn last line is ended, so a reader delivers it.
          if (text.length > 0 && !text.endsWith('\n')) fs.appendFileSync(file, '\n');
          return { ok: true, suppressed: true, seq: existing.seq, run_id: existing.run_id };
        }
        const seq = Math.max(used, max) + 1;
        used = seq;
        const line = {
          schema: EVENT_SCHEMA, run_id: runId, seq, at: new Date(now()).toISOString(), kind,
          macro_id: macroId, subtask_id: subtaskId, ...fields,
          ...(TERMINAL_KINDS.includes(kind) ? { terminal: true } : {}),
        };
        appendLine(file, JSON.stringify(line), writeSync ? { writeSync } : {});
        return { ok: true, seq };
      } catch (e) {
        return fail(e?.message ?? String(e));
      } finally {
        release?.();
      }
    },
  };
  return w;
}

/**
 * Whether the file holds a `run-ended` of the run, and its run's lines:
 * { lines: [events of the run], ended }. A file that is not there holds none.
 */
export function runLinesOnFile(file, runId) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { if (e?.code !== 'ENOENT') throw e; }
  const lines = splitLines(text).map((l) => l.event).filter((e) => hasIdentity(e) && e.run_id === runId);
  return { lines, ended: lines.some((e) => e.kind === 'run-ended') };
}
