// scripts/lib/holds-records.mjs — the macro's holds directory: paths, record
// validation, whole-file writes and the safe readers (ADR-0068 Decision 2;
// the implementation notes of 2026-10-25, N1-N4, and 2026-10-26, I1-I3).
//
// It imports neither state.mjs, parks.mjs nor policy.mjs, so state.mjs, the
// Claude adapter's parks and the holds library can all import it without a
// cycle (policy.mjs reads state.mjs's enums at module init). The identifier
// forms are policy.mjs's, restated; tests hold the copies equal.
//
// Every reader answers with a state and never throws for what it finds on
// disk: `absent`, a readable record, or `unreadable` with the reason. A
// directory, a FIFO (opened without blocking, so it is seen, never waited
// on), a dangling link, a file that does not parse or a record of another
// schema is unreadable.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const AUTOPILOT_DIR_REL = '.agentic-plugins/runs/autopilot';
export const HOLDS_PROTOCOL_SCHEMA = 'agentic-holds-protocol-1';
export const HOLDS_PROTOCOL = 1;
export const HOLD_SCHEMA = 'agentic-hold-1';
export const HOLD_STATES = Object.freeze(['held', 'released', 'retired']);
export const HANDOFF_SCHEMA = 'agentic-hold-handoff-1';
export const RELEASE_SCHEMA = 'agentic-hold-release-1';
export const RELEASE_STATES = Object.freeze(['uncompared', 'consumed', 'rejected', 'withdrawn']);
export const PERSONA_OP_SCHEMA = 'agentic-persona-op-1';
// The capability this orchestrator's runs record in run.json and its
// `state.mjs hold-capability` prints (Decision 2, item 9).
export const HOLDS_CAPABILITY = 'holds-1';
// The pinned engineer's token (N8) the lanes capability floor needs.
export const HOLD_PERSONA_CAPABILITY = 'hold-persona-1';

const SUBTASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MACRO_ID_RE = /^macro-[a-z][a-z0-9-]*-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
export const OPERATION_ID_RE = /^op-\d{8}T\d{6}Z-[0-9a-f]{8}$/;
const RECORD_ID_RE = /^[0-9a-f]{16}$/;
export const isSafeSubtaskId = (id) => typeof id === 'string' && SUBTASK_ID_RE.test(id);
export const isSafeMacroId = (id) => typeof id === 'string' && MACRO_ID_RE.test(id);
export const isRecordId = (id) => typeof id === 'string' && RECORD_ID_RE.test(id);
export const newRecordId = () => randomBytes(8).toString('hex');

/** A new operation id, `op-<yyyymmddThhmmssZ>-<8 hex>` (N4). */
export function newOperationId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `op-${stamp}-${randomBytes(4).toString('hex')}`;
}

// --- paths ------------------------------------------------------------------

/** `<main>/.agentic-plugins/runs/autopilot/holds/<macro-id>` (N1). */
export function holdsDir(mainRoot, macroId) {
  if (!isSafeMacroId(macroId)) throw new Error(`not a macro id: ${JSON.stringify(macroId)}`);
  return path.join(mainRoot, AUTOPILOT_DIR_REL, 'holds', macroId);
}

export const holdsRoot = (mainRoot) => path.join(mainRoot, AUTOPILOT_DIR_REL, 'holds');
export const protocolPath = (mainRoot, macroId) => path.join(holdsDir(mainRoot, macroId), 'protocol.json');
export const holdsLockPath = (mainRoot, macroId) => path.join(holdsDir(mainRoot, macroId), '.lock');
export const holdEventsPath = (mainRoot, macroId) => path.join(holdsDir(mainRoot, macroId), 'events.jsonl');
export const discardedDir = (mainRoot, macroId) => path.join(holdsDir(mainRoot, macroId), 'discarded');

// Each record kind has its own subdirectory: a subtask id admits `.`.
export const RECORD_KINDS = Object.freeze(['holds', 'handoffs', 'releases', 'parks']);

export function recordPath(mainRoot, macroId, kind, subtaskId) {
  if (!RECORD_KINDS.includes(kind)) throw new Error(`not a record kind: ${JSON.stringify(kind)}`);
  if (!isSafeSubtaskId(subtaskId)) throw new Error(`not a subtask id: ${JSON.stringify(subtaskId)}`);
  return path.join(holdsDir(mainRoot, macroId), kind, `${subtaskId}.json`);
}

export function opsDir(mainRoot, macroId, subtaskId) {
  if (!isSafeSubtaskId(subtaskId)) throw new Error(`not a subtask id: ${JSON.stringify(subtaskId)}`);
  return path.join(holdsDir(mainRoot, macroId), 'ops', subtaskId);
}

// --- safe readers -------------------------------------------------------------

/**
 * A regular file's whole text: `{ text, mtimeMs }`, `{ absent: true }` when
 * nothing is there, or `{ error }` — a directory, a FIFO (opened without
 * blocking), a dangling link (which reads ENOENT and is not "nothing") or a
 * read that fails.
 */
export function readRegular(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  } catch (err) {
    if (err.code === 'ENOENT') {
      try {
        if (fs.lstatSync(file).isSymbolicLink()) return { error: `${file} is a link to nothing` };
      } catch { /* nothing there */ }
      return { absent: true };
    }
    if (err.code === 'ENOTDIR') return { error: `${file} cannot be reached: a file stands where a directory is expected` };
    return { error: `cannot open ${file} (${err.code || err.message})` };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { error: `${file} is not a regular file` };
    return { text: fs.readFileSync(fd, 'utf8'), mtimeMs: st.mtimeMs };
  } catch (err) {
    return { error: `cannot read ${file} (${err.code || err.message})` };
  } finally {
    fs.closeSync(fd);
  }
}

/** readRegular, parsed: `{ value, text }`, `{ absent: true }` or `{ error, text? }`. */
export function readJson(file) {
  const r = readRegular(file);
  if (r.absent || r.error) return r;
  try {
    return { value: JSON.parse(r.text), text: r.text };
  } catch (err) {
    return { error: `cannot parse ${file} (${err.message})`, text: r.text };
  }
}

/** Whether `dir` can be listed: `{ state: 'absent' | 'ok' | 'unreadable', error?, names? }`. */
export function dirState(dir) {
  try {
    const st = fs.statSync(dir);
    if (!st.isDirectory()) return { state: 'unreadable', error: `${dir} is not a directory` };
    return { state: 'ok', names: fs.readdirSync(dir).sort() };
  } catch (err) {
    if (err.code === 'ENOENT') {
      try {
        if (fs.lstatSync(dir).isSymbolicLink()) return { state: 'unreadable', error: `${dir} is a link to nothing` };
      } catch { /* nothing there */ }
      return { state: 'absent' };
    }
    return { state: 'unreadable', error: `cannot list ${dir} (${err.code || err.message})` };
  }
}

// --- writes -------------------------------------------------------------------

/** Write `value` as JSON whole: a temporary file beside it, renamed over it. */
export function writeWhole(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(tmp, file);
}

/** Remove a file; one already gone is removed. */
export function unlinkQuiet(file) {
  try { fs.unlinkSync(file); } catch (err) { if (err.code !== 'ENOENT') throw err; }
}

// --- activation (N2) ----------------------------------------------------------

/**
 * `{ state: 'inactive' | 'active' | 'unreadable', path, error? }`: inactive
 * with no holds directory or no marker in it; active with a marker of this
 * schema and protocol 1; unreadable otherwise.
 */
export function readActivation(mainRoot, macroId) {
  const dir = holdsDir(mainRoot, macroId);
  const marker = protocolPath(mainRoot, macroId);
  const d = dirState(dir);
  if (d.state === 'absent') return { state: 'inactive', path: marker };
  if (d.state === 'unreadable') return { state: 'unreadable', path: dir, error: d.error };
  const r = readJson(marker);
  if (r.absent) return { state: 'inactive', path: marker };
  if (r.error) return { state: 'unreadable', path: marker, error: r.error };
  const m = r.value;
  if (m === null || typeof m !== 'object' || m.schema !== HOLDS_PROTOCOL_SCHEMA) {
    return { state: 'unreadable', path: marker, error: `${marker} is not a holds protocol marker (${HOLDS_PROTOCOL_SCHEMA})` };
  }
  if (m.protocol !== HOLDS_PROTOCOL) {
    return { state: 'unreadable', path: marker, error: `${marker} names holds protocol ${JSON.stringify(m.protocol)}, not ${HOLDS_PROTOCOL}` };
  }
  return { state: 'active', path: marker, protocol: m.protocol };
}

/**
 * Write the marker once (exclusive create): `{ written }`, false when one is
 * there already. The caller has read activation first: a marker that cannot
 * be read is never overwritten.
 */
export function writeProtocol(mainRoot, macroId, { writtenBy, now = new Date() }) {
  const file = protocolPath(mainRoot, macroId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = path.join(path.dirname(file), `.protocol.json.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify({ schema: HOLDS_PROTOCOL_SCHEMA, protocol: HOLDS_PROTOCOL, written_by: writtenBy, at: now.toISOString() })}\n`, { flag: 'wx' });
  try {
    fs.linkSync(tmp, file);
    return { written: true, path: file };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    return { written: false, path: file };
  } finally {
    unlinkQuiet(tmp);
  }
}

// --- the owner's record (N3) --------------------------------------------------

export function validHold(record, subtaskId) {
  return record !== null && typeof record === 'object' && record.schema === HOLD_SCHEMA
    && isRecordId(record.hold_id) && record.subtask_id === subtaskId && HOLD_STATES.includes(record.state)
    && typeof record.branch === 'string' && record.branch.length > 0
    && (record.child === null || record.child === undefined || typeof record.child === 'string')
    && (record.lane === null || record.lane === undefined || typeof record.lane === 'string')
    && (record.orphaned === undefined || (record.orphaned !== null && typeof record.orphaned === 'object'));
}

export function validHandoff(record, subtaskId) {
  return record !== null && typeof record === 'object' && record.schema === HANDOFF_SCHEMA
    && isRecordId(record.hold_id) && record.subtask_id === subtaskId && record.state === 'acked'
    && (record.fence === null || typeof record.fence === 'string');
}

export function validRelease(record, subtaskId) {
  if (record === null || typeof record !== 'object' || record.schema !== RELEASE_SCHEMA) return false;
  if (!isRecordId(record.release_id) || !isRecordId(record.hold_id) || record.subtask_id !== subtaskId) return false;
  if (!RELEASE_STATES.includes(record.state)) return false;
  if (record.park_record_id !== null && !isRecordId(record.park_record_id)) return false;
  if (record.state === 'withdrawn') return true;
  const b = record.basis;
  return b !== null && typeof b === 'object' && typeof b.fingerprint === 'string' && typeof b.tree_digest === 'string'
    && typeof b.content_digest === 'string';
}

const VALIDATORS = { holds: validHold, handoffs: validHandoff, releases: validRelease };
const SCHEMAS = { holds: HOLD_SCHEMA, handoffs: HANDOFF_SCHEMA, releases: RELEASE_SCHEMA };

/**
 * A record of `kind` (`holds`, `handoffs`, `releases`) of a subtask:
 * `{ state: 'absent', path }`, `{ state: 'ok', record, path, text }` or
 * `{ state: 'unreadable', error, path, text? }`. A kind's directory that
 * cannot be listed is unreadable too.
 */
export function readRecord(mainRoot, macroId, kind, subtaskId) {
  const file = recordPath(mainRoot, macroId, kind, subtaskId);
  const d = dirState(path.dirname(file));
  if (d.state === 'unreadable') return { state: 'unreadable', path: path.dirname(file), error: d.error };
  if (d.state === 'absent') return { state: 'absent', path: file };
  const r = readJson(file);
  if (r.absent) return { state: 'absent', path: file };
  if (r.error) return { state: 'unreadable', path: file, error: r.error, text: r.text };
  if (!VALIDATORS[kind](r.value, subtaskId)) {
    return { state: 'unreadable', path: file, error: `${file} is not a record (${SCHEMAS[kind]}) of subtask ${subtaskId}`, text: r.text };
  }
  return { state: 'ok', path: file, record: r.value, text: r.text };
}

export const readOwnerHold = (mainRoot, macroId, subtaskId) => readRecord(mainRoot, macroId, 'holds', subtaskId);

/**
 * The subtask ids that have a file in a kind's directory: `{ state, ids,
 * error? }`. A name that is no `<subtask>.json` is passed over.
 */
export function listRecordIds(mainRoot, macroId, kind) {
  const dir = path.join(holdsDir(mainRoot, macroId), kind);
  const d = dirState(dir);
  if (d.state !== 'ok') return { state: d.state, ids: [], error: d.error };
  const ids = d.names.filter((n) => n.endsWith('.json') && !n.startsWith('.'))
    .map((n) => n.slice(0, -'.json'.length)).filter(isSafeSubtaskId);
  return { state: 'ok', ids };
}

/**
 * N3 — whether the owner's record (readOwnerHold's answer) applies to a child
 * on `branch` with workflow id `workflowId` (null for none yet): `{ applies,
 * why }`. An unreadable record applies; a missing one does not.
 */
export function holdApplies(read, { branch, workflowId = null }) {
  if (read.state === 'absent') return { applies: false, why: 'no hold' };
  if (read.state === 'unreadable') return { applies: true, why: `the hold record cannot be read (${read.error})` };
  const r = read.record;
  if (r.state !== 'held') return { applies: false, why: `the hold is ${r.state}` };
  if (r.orphaned !== undefined) return { applies: false, why: 'the hold is orphaned' };
  if (r.branch !== branch) return { applies: false, why: `the hold was set on branch ${r.branch}, not ${branch}` };
  if (typeof r.child === 'string' && workflowId !== null && r.child !== workflowId) {
    return { applies: false, why: `the hold was set on child ${r.child}, not ${workflowId}` };
  }
  return { applies: true, why: `hold ${r.hold_id} is held` };
}

/**
 * N3 — a kept park of the subtask (Decision 1, item 3): any record under
 * `parks/`, readable or not. `{ kept, why }`; a parks directory that cannot
 * be listed keeps every subtask parked.
 */
export function readKeptPark(mainRoot, macroId, subtaskId) {
  const file = recordPath(mainRoot, macroId, 'parks', subtaskId);
  const d = dirState(path.dirname(file));
  if (d.state === 'absent') return { kept: false, why: 'no park' };
  if (d.state === 'unreadable') return { kept: true, why: d.error };
  const r = readRegular(file);
  if (r.absent) return { kept: false, why: 'no park' };
  if (r.error) return { kept: true, why: r.error };
  let state = 'unreadable';
  try { state = JSON.parse(r.text)?.state ?? 'unreadable'; } catch { /* unreadable */ }
  return { kept: true, why: `a kept park (${typeof state === 'string' ? state : 'unreadable'}) at ${file}` };
}

// --- the transitions (N7; tests/fixtures/holds-protocol/release-transitions.json) --

export const HOLD_TRANSITIONS = Object.freeze([
  ['pending', 'handoff-complete', 'held'],
  ['pending', 'release-same-hold-id', 'withdrawn'],
  ['pending', 'done', 'retired'],
  ['pending', 'orphan', 'orphaned'],
  ['held', 'release-same-hold-id', 'released-uncompared'],
  ['held', 'done', 'retired'],
  ['held', 'orphan', 'orphaned'],
  ['released-uncompared', 'compare-equal', 'consumed'],
  ['released-uncompared', 'compare-different', 'rejected'],
  ['released-uncompared', 'done', 'retired'],
  ['released-uncompared', 'orphan', 'orphaned'],
]);
export const HOLD_TERMINAL_STATES = Object.freeze(['consumed', 'rejected', 'withdrawn', 'retired', 'orphaned']);

export const HOLD_REFUSALS = Object.freeze([
  ['pending', 'release-other-hold-id', 'a release names the hold it ends, never a newer one'],
  ['held', 'release-other-hold-id', 'a release names the hold it ends, never a newer one'],
  ['held', 'release-while-operation-open', 'it refuses while a writer may still be active in the lane'],
  ['held', 'bare-release', 'a bare release refuses on a held lane'],
  ['released-uncompared', 'bare-release', 'a bare release refuses on a lane whose release has not been compared'],
  ['rejected', 'compare-equal', 'a rejected release is not compared again'],
  ['rejected', 'compare-different', 'a rejected release is not compared again'],
  ['consumed', 'compare-equal', 'a release is consumed once'],
  ['consumed', 'compare-different', 'a release is consumed once'],
]);

/** `{ to }` for a transition the table has, `{ refused: why }` otherwise. */
export function holdTransition(from, event) {
  const t = HOLD_TRANSITIONS.find(([f, e]) => f === from && e === event);
  if (t) return { to: t[2] };
  const r = HOLD_REFUSALS.find(([f, e]) => f === from && e === event);
  if (r) return { refused: r[2] };
  if (HOLD_TERMINAL_STATES.includes(from)) return { refused: `the hold is ${from}: only a new hold gives the lane back` };
  return { refused: `no transition ${event} from ${from}` };
}

/**
 * The fixture state of a subtask's hold from its three records (I1):
 * `{ state, hold, handoff, release }`, with `state` one of the fixture's
 * states, `none` (no owner record), or `unreadable`.
 */
export function holdStateOf(mainRoot, macroId, subtaskId) {
  const hold = readOwnerHold(mainRoot, macroId, subtaskId);
  if (hold.state === 'absent') return { state: 'none', hold };
  if (hold.state === 'unreadable') return { state: 'unreadable', hold };
  const r = hold.record;
  const handoff = readRecord(mainRoot, macroId, 'handoffs', subtaskId);
  const release = readRecord(mainRoot, macroId, 'releases', subtaskId);
  const own = (x) => x.state === 'ok' && x.record.hold_id === r.hold_id;
  if (r.state === 'retired') return { state: 'retired', hold, handoff, release };
  if (r.orphaned !== undefined) return { state: 'orphaned', hold, handoff, release };
  if (r.state === 'held') {
    // A handoff or release record that cannot be read is neither absent nor
    // acked: the hold stays in force, and nothing that tells pending from
    // held (a release's withdrawal, a repair) acts on it.
    if (handoff.state === 'unreadable') return { state: 'unreadable', hold, handoff, release, why: handoff.error };
    if (release.state === 'unreadable') return { state: 'unreadable', hold, handoff, release, why: release.error };
    // A release of this hold written before its owner record moved (a crash
    // inside `release`) is not in force yet (I3).
    return { state: own(handoff) ? 'held' : 'pending', hold, handoff, release };
  }
  // released: the release of this hold says how far it went.
  if (release.state === 'unreadable') return { state: 'unreadable', hold, handoff, release };
  if (!own(release)) return { state: 'unreadable', hold, handoff, release, why: `hold ${r.hold_id} is released, but no release of it is recorded` };
  const map = { uncompared: 'released-uncompared', consumed: 'consumed', rejected: 'rejected', withdrawn: 'withdrawn' };
  return { state: map[release.record.state], hold, handoff, release };
}

// --- operation records (N4) ---------------------------------------------------

/**
 * The operation records of a subtask under `ops/<subtask>/`: `{ state:
 * 'absent' | 'ok' | 'unreadable', error?, ops: [{ id, record, cleared,
 * error? }] }` — `record` null for a `.cleared` alone, `error` for a record
 * that cannot be read (it counts open).
 */
export function readOps(mainRoot, macroId, subtaskId) {
  const dir = opsDir(mainRoot, macroId, subtaskId);
  const d = dirState(dir);
  if (d.state === 'absent') return { state: 'absent', ops: [] };
  if (d.state === 'unreadable') return { state: 'unreadable', error: d.error, ops: [] };
  const byId = new Map();
  const entry = (id) => {
    if (!byId.has(id)) byId.set(id, { id, record: null, cleared: false });
    return byId.get(id);
  };
  for (const name of d.names) {
    if (name.startsWith('.')) continue;
    const m = /^(.*)\.(json|cleared)$/.exec(name);
    if (!m || !OPERATION_ID_RE.test(m[1])) continue;
    const e = entry(m[1]);
    if (m[2] === 'cleared') { e.cleared = true; continue; }
    const r = readJson(path.join(dir, name));
    if (r.absent) continue;
    if (r.error) e.error = r.error;
    else if (r.value?.schema !== PERSONA_OP_SCHEMA || r.value?.operation_id !== m[1]) e.error = `${path.join(dir, name)} is not an operation record (${PERSONA_OP_SCHEMA})`;
    else e.record = r.value;
  }
  return { state: 'ok', ops: [...byId.values()].filter((e) => e.record !== null || e.error !== undefined || e.cleared) };
}

/**
 * Publish an operation record whole and exclusively (written aside, linked
 * into place): `{ published: true, path }`, or `{ published: false, path }`
 * when one of the id is there.
 */
export function publishOpRecord(mainRoot, macroId, subtaskId, record) {
  const id = record?.operation_id;
  if (typeof id !== 'string' || !OPERATION_ID_RE.test(id)) throw new Error(`not an operation id: ${JSON.stringify(id)}`);
  const dir = opsDir(mainRoot, macroId, subtaskId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${id}.json`);
  const aside = path.join(dir, `.${id}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(aside, `${JSON.stringify({ schema: PERSONA_OP_SCHEMA, ...record })}\n`, { mode: 0o600, flag: 'wx' });
  try {
    fs.linkSync(aside, file);
    return { published: true, path: file };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    return { published: false, path: file };
  } finally {
    unlinkQuiet(aside);
  }
}

export function removeOpRecord(mainRoot, macroId, subtaskId, id) {
  if (typeof id !== 'string' || !OPERATION_ID_RE.test(id)) throw new Error(`not an operation id: ${JSON.stringify(id)}`);
  unlinkQuiet(path.join(opsDir(mainRoot, macroId, subtaskId), `${id}.json`));
}

/**
 * `writer-clear` (Decision 2, item 7): create `<id>.cleared`, once, never
 * rewritten. `{ cleared: true }`, or `{ cleared: false }` when it was there.
 */
export function clearOperation(mainRoot, macroId, subtaskId, id, { by, now = new Date() }) {
  if (typeof id !== 'string' || !OPERATION_ID_RE.test(id)) throw new Error(`not an operation id: ${JSON.stringify(id)}`);
  const dir = opsDir(mainRoot, macroId, subtaskId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.writeFileSync(path.join(dir, `${id}.cleared`), `${JSON.stringify({ operation_id: id, cleared_by: by, at: now.toISOString() })}\n`, { flag: 'wx' });
    return { cleared: true };
  } catch (err) {
    if (err.code === 'EEXIST') return { cleared: false };
    throw err;
  }
}

// --- events -------------------------------------------------------------------

/** Append one event to the macro-scoped `events.jsonl` (I1). */
export function appendHoldEvent(mainRoot, macroId, event) {
  const file = holdEventsPath(mainRoot, macroId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

/** The macro-scoped events, oldest first; torn lines are passed over. */
export function readHoldEvents(mainRoot, macroId) {
  const r = readRegular(holdEventsPath(mainRoot, macroId));
  if (r.absent || r.error) return [];
  const out = [];
  for (const line of r.text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* torn */ }
  }
  return out;
}
