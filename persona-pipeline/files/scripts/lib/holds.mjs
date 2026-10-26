// scripts/lib/holds.mjs — the persona's reads of a macro's holds directory
// (ADR-0068 Decision 2, the implementation note of 2026-10-25, N1-N3 and N8).
//
// The orchestrator writes the holds directory; the persona only reads it, and
// publishes and removes its own operation records (N4; the operation's
// lifecycle is state.mjs's, the record and transport files are here). A
// plugin may not import another's script (ADR-0010 §5), so the few rules this
// shares with the orchestrator's run locks (where the main worktree is, how a
// recorded process is judged alive) are restated here, and the fixtures under
// tests/fixtures/holds-protocol/ hold both halves to one set of verdicts.
//
// Every reader answers with a state, never throws for what it finds on disk:
// `absent`, a readable record, or `unreadable` with the reason, so a caller
// decides what an unreadable record means where it reads it.

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const AUTOPILOT_DIR_REL = '.agentic-plugins/runs/autopilot';
export const HOLDS_PROTOCOL_SCHEMA = 'agentic-holds-protocol-1';
export const HOLDS_PROTOCOL = 1;
export const HOLD_SCHEMA = 'agentic-hold-1';
export const HOLD_STATES = Object.freeze(['held', 'released', 'retired']);
export const PERSONA_OP_SCHEMA = 'agentic-persona-op-1';
// N8 — the token the driver's lanes capability floor reads in this file.
export const HOLD_PERSONA_CAPABILITY = 'hold-persona-1';

// The orchestrator's identifier forms (policy.mjs), restated: a path is built
// only from an id of its form.
const MACRO_ID_RE = /^macro-[a-z][a-z0-9-]*-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const SUBTASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const OPERATION_ID_RE = /^op-\d{8}T\d{6}Z-[0-9a-f]{8}$/;
const HOLD_ID_RE = /^[0-9a-f]{16}$/;
export const isSafeMacroId = (id) => typeof id === 'string' && MACRO_ID_RE.test(id);
export const isSafeSubtaskId = (id) => typeof id === 'string' && SUBTASK_ID_RE.test(id);

// An entry of a run lock, as run-locks.mjs names a run's (`h-<pid>-<hex>`).
const RUN_ENTRY_RE = /^h-(\d+)-[0-9a-f]+\.json$/;
// A run entry is written whole (a rename), so one that does not parse is not
// being written: younger than this it is a participant, older it is debris
// (run-locks.mjs FRESH_UNPARSED_MS).
const FRESH_UNPARSED_MS = 5_000;

/**
 * The worktree that holds the repository's common git dir, from any checkout
 * of it (or a directory inside one): where every lane finds the same holds
 * directory. `dir` itself when git cannot tell.
 */
export function mainWorktreeRoot(dir) {
  try {
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));
    const common = execFileSync('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, env,
    }).trim();
    if (path.basename(common) === '.git') return path.dirname(common);
  } catch {
    /* fall back below */
  }
  return dir;
}

/** `<main>/.agentic-plugins/runs/autopilot/holds/<macro-id>` (N1). */
export function holdsDir(mainRoot, macroId) {
  if (!isSafeMacroId(macroId)) throw new Error(`not a macro id: ${JSON.stringify(macroId)}`);
  return path.join(mainRoot, AUTOPILOT_DIR_REL, 'holds', macroId);
}

function subtaskFile(mainRoot, macroId, kind, subtaskId) {
  if (!isSafeSubtaskId(subtaskId)) throw new Error(`not a subtask id: ${JSON.stringify(subtaskId)}`);
  return path.join(holdsDir(mainRoot, macroId), kind, `${subtaskId}.json`);
}

export const opsDir = (mainRoot, macroId, subtaskId) => {
  if (!isSafeSubtaskId(subtaskId)) throw new Error(`not a subtask id: ${JSON.stringify(subtaskId)}`);
  return path.join(holdsDir(mainRoot, macroId), 'ops', subtaskId);
};

// A regular file's whole text, `{ absent: true }` when nothing is there, or
// `{ error }`: a directory, a FIFO (opened without blocking, so it is seen,
// never waited on), a dangling link or a read that fails.
function readRegular(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  } catch (err) {
    if (err.code === 'ENOENT') {
      // A link whose target is gone reads ENOENT too, and is not "nothing".
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

function readJson(file) {
  const r = readRegular(file);
  if (r.absent || r.error) return r;
  try {
    return { value: JSON.parse(r.text) };
  } catch (err) {
    return { error: `cannot parse ${file} (${err.message})` };
  }
}

// Whether `dir` can be listed: `{ state: 'absent' | 'ok' | 'unreadable', error? }`.
function dirState(dir) {
  try {
    const st = fs.statSync(dir);
    if (!st.isDirectory()) return { state: 'unreadable', error: `${dir} is not a directory` };
    fs.readdirSync(dir);
    return { state: 'ok' };
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

/**
 * N2 — whether a hold-aware orchestrator runs for the macro:
 * `{ state: 'inactive' | 'active' | 'unreadable', path, error? }`. Inactive
 * with no holds directory or no marker in it; active with a marker of this
 * schema and protocol 1; unreadable otherwise (a directory or a marker that
 * cannot be read, a marker of another schema or a later protocol).
 */
export function readActivation(mainRoot, macroId) {
  const dir = holdsDir(mainRoot, macroId);
  const marker = path.join(dir, 'protocol.json');
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
    const later = Number.isInteger(m.protocol) && m.protocol > HOLDS_PROTOCOL;
    return {
      state: 'unreadable', path: marker,
      error: later
        ? `${marker} names holds protocol ${m.protocol}, later than this persona's ${HOLDS_PROTOCOL}: install the persona release the orchestrator names`
        : `${marker} names no holds protocol this persona reads (${JSON.stringify(m.protocol)})`,
    };
  }
  return { state: 'active', path: marker, protocol: m.protocol };
}

function validHold(record, subtaskId) {
  return record !== null && typeof record === 'object' && record.schema === HOLD_SCHEMA
    && typeof record.hold_id === 'string' && HOLD_ID_RE.test(record.hold_id)
    && record.subtask_id === subtaskId && HOLD_STATES.includes(record.state)
    && typeof record.branch === 'string' && record.branch.length > 0
    && (record.child === null || record.child === undefined || typeof record.child === 'string')
    && (record.orphaned === undefined || (record.orphaned !== null && typeof record.orphaned === 'object'));
}

/**
 * N3 — the owner's record of a subtask: `{ state: 'absent' }`,
 * `{ state: 'ok', record, path }` or `{ state: 'unreadable', error, path }`.
 */
export function readOwnerHold(mainRoot, macroId, subtaskId) {
  const file = subtaskFile(mainRoot, macroId, 'holds', subtaskId);
  const d = dirState(path.dirname(file));
  if (d.state === 'unreadable') return { state: 'unreadable', path: path.dirname(file), error: d.error };
  if (d.state === 'absent') return { state: 'absent', path: file };
  const r = readJson(file);
  if (r.absent) return { state: 'absent', path: file };
  if (r.error) return { state: 'unreadable', path: file, error: r.error };
  if (!validHold(r.value, subtaskId)) {
    return { state: 'unreadable', path: file, error: `${file} is not a hold record (${HOLD_SCHEMA}) of subtask ${subtaskId}` };
  }
  return { state: 'ok', path: file, record: r.value };
}

/**
 * N3 — whether the owner's record (readOwnerHold's answer) applies to a child
 * on `branch` with workflow id `workflowId` (null for a child not created
 * yet): `{ applies, why }`. An unreadable record applies; a missing one does
 * not; a readable one while `held`, not orphaned, on the child's branch, and
 * set on this child or on none.
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
 * `parks/`, readable or not. `{ kept, why }`; a parks directory that cannot be
 * listed keeps every subtask parked.
 */
export function readKeptPark(mainRoot, macroId, subtaskId) {
  const file = subtaskFile(mainRoot, macroId, 'parks', subtaskId);
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

// --- process liveness, as run-locks.mjs judges a run's driver ----------------

/**
 * A process's fingerprint in the C locale (so two readers in different
 * locales agree), with `zombie: true` for one that exited and waits to be
 * reaped. `{ kind: 'none' }` when it cannot be read. run-locks.mjs
 * `processFingerprint`, restated.
 */
export function processFingerprint(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { kind: 'none' };
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const rest = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      let command = '';
      try { command = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim(); } catch { /* exited */ }
      const fp = { kind: 'linux_proc_starttime', starttime: rest[19], command };
      return rest[0] === 'Z' || rest[0] === 'X' ? { ...fp, zombie: true } : fp;
    } catch {
      return { kind: 'none' };
    }
  }
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('ps', ['-p', String(pid), '-o', 'stat=', '-o', 'lstart=', '-o', 'command='], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, LC_ALL: 'C' },
      }).trim();
      const m = /^(\S+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4})\s*([\s\S]*)$/.exec(out);
      if (!m) return { kind: 'none' };
      const fp = { kind: 'macos_lstart_command', lstart: m[2], command: m[3] };
      return m[1].startsWith('Z') ? { ...fp, zombie: true } : fp;
    } catch {
      return { kind: 'none' };
    }
  }
  return { kind: 'none' };
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Only a different start proves a pid reused: an exec in place changes the
// command line, not the process.
function startDiffers(recorded, current) {
  if (recorded.kind !== current.kind) return false;
  if (recorded.kind === 'linux_proc_starttime') return recorded.starttime !== current.starttime;
  if (recorded.kind === 'macos_lstart_command') return recorded.lstart !== current.lstart;
  return false;
}

/**
 * Whether the process a record names (`pid`, `fingerprint`) still runs:
 * gone when its pid is dead, reused by a process that started at another
 * time, or a zombie; running otherwise, unverifiable included.
 */
export function recordedProcessLive(pid, recorded, { probe = processFingerprint } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (!pidAlive(pid)) return false;
  const current = probe(pid);
  const comparable = Boolean(recorded && recorded.kind && recorded.kind !== 'none' && current && current.kind !== 'none');
  if (comparable && startDiffers(recorded, current)) return false;
  if (current?.zombie === true) return false;
  return true;
}

/**
 * N3 — whether a run of the macro is live: an entry `h-*.json` of the macro
 * lock whose driver runs (a run is live while its driver lives; a worker that
 * outlived its driver makes its lane busy, not the run live). A lock or an
 * entry that cannot be read, and one too fresh to have been written whole,
 * count as live. `{ live, why }`.
 */
export function macroRunLive(mainRoot, macroId, { probe = processFingerprint, now = Date.now() } = {}) {
  if (!isSafeMacroId(macroId)) throw new Error(`not a macro id: ${JSON.stringify(macroId)}`);
  const lock = path.join(mainRoot, AUTOPILOT_DIR_REL, 'locks', `${macroId}.lock`);
  let names;
  try {
    names = fs.readdirSync(lock);
  } catch (err) {
    if (err.code === 'ENOENT') return { live: false, why: 'no run lock' };
    return { live: true, why: `the run lock ${lock} cannot be listed (${err.code || err.message})` };
  }
  for (const name of names.sort()) {
    if (!RUN_ENTRY_RE.test(name)) continue;
    const file = path.join(lock, name);
    // Opened without blocking, so an entry that is no regular file (a FIFO)
    // is judged, never waited on.
    const r = readRegular(file);
    if (r.absent) continue;
    if (r.error) return { live: true, why: `the run lock entry ${file} cannot be read (${r.error})` };
    let holder = null;
    try { holder = JSON.parse(r.text); } catch { /* below */ }
    if (holder === null || typeof holder !== 'object') {
      if (now - r.mtimeMs < FRESH_UNPARSED_MS) return { live: true, why: `a run is taking the lock ${lock}` };
      continue;
    }
    if (recordedProcessLive(holder.pid, holder.fingerprint, { probe })) {
      return { live: true, why: `run ${holder.run_id ?? 'unknown'} (driver pid ${holder.pid}) holds ${lock}` };
    }
  }
  return { live: false, why: 'no live run' };
}

// --- operation records (N4) --------------------------------------------------

/**
 * The operation records of a subtask under `ops/<subtask>/`:
 * `{ state: 'absent' | 'ok' | 'unreadable', error?, ops: [{ id, record,
 * cleared, error? }] }` — `record` null for a `.cleared` with no record
 * beside it (a pre-activation operation the owner cleared), `error` for a
 * record that cannot be read (it counts open).
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
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    // Removed or replaced between the two looks.
    if (err.code === 'ENOENT') return { state: 'absent', ops: [] };
    return { state: 'unreadable', error: `cannot list ${dir} (${err.code || err.message})`, ops: [] };
  }
  for (const name of names.sort()) {
    if (name.startsWith('.')) continue;
    const m = /^(.*)\.(json|cleared)$/.exec(name);
    if (!m || !OPERATION_ID_RE.test(m[1])) continue;
    const e = entry(m[1]);
    if (m[2] === 'cleared') {
      e.cleared = true;
      continue;
    }
    const r = readJson(path.join(dir, name));
    if (r.absent) continue;
    if (r.error) e.error = r.error;
    else if (r.value?.schema !== PERSONA_OP_SCHEMA || r.value?.operation_id !== m[1]) e.error = `${path.join(dir, name)} is not a persona operation record (${PERSONA_OP_SCHEMA})`;
    else e.record = r.value;
  }
  return { state: 'ok', ops: [...byId.values()].filter((e) => e.record !== null || e.error !== undefined || e.cleared) };
}

/** A new operation id, `op-<yyyymmddThhmmssZ>-<8 hex>` (N4). */
export function newOperationId(now = new Date()) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  return `op-${stamp}-${randomBytes(4).toString('hex')}`;
}

/**
 * N4 — publish the operation's record `ops/<subtask>/<id>.json`, whole and
 * exclusively (written aside, then linked into place: a second publisher of
 * the id meets EEXIST). `{ published: true }`, or `{ published: false,
 * existing }` when a record of the id is already there (`existing` is the
 * record, or null when it cannot be read as one).
 */
export function publishOpRecord(mainRoot, macroId, subtaskId, record) {
  const id = record?.operation_id;
  if (typeof id !== 'string' || !OPERATION_ID_RE.test(id)) throw new Error(`not an operation id: ${JSON.stringify(id)}`);
  const dir = opsDir(mainRoot, macroId, subtaskId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${id}.json`);
  // A name readOps passes over (it starts with a dot), linked under the
  // record's name only once written whole.
  const aside = path.join(dir, `.${id}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  fs.writeFileSync(aside, `${JSON.stringify({ schema: PERSONA_OP_SCHEMA, ...record })}\n`, { mode: 0o600, flag: 'wx' });
  try {
    fs.linkSync(aside, file);
    return { published: true, path: file };
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    const r = readJson(file);
    const existing = r.value?.schema === PERSONA_OP_SCHEMA && r.value?.operation_id === id ? r.value : null;
    return { published: false, path: file, existing };
  } finally {
    try { fs.unlinkSync(aside); } catch { /* already gone */ }
  }
}

/** N4 — remove the operation's record; one already gone is removed. */
export function removeOpRecord(mainRoot, macroId, subtaskId, id) {
  if (typeof id !== 'string' || !OPERATION_ID_RE.test(id)) throw new Error(`not an operation id: ${JSON.stringify(id)}`);
  try {
    fs.unlinkSync(path.join(opsDir(mainRoot, macroId, subtaskId), `${id}.json`));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

/**
 * Whether the operation's record is there: `present`, `absent`, or
 * `unreadable` (a lookup that fails other than by absence).
 */
export function opRecordState(mainRoot, macroId, subtaskId, id) {
  if (typeof id !== 'string' || !OPERATION_ID_RE.test(id)) throw new Error(`not an operation id: ${JSON.stringify(id)}`);
  try {
    fs.lstatSync(path.join(opsDir(mainRoot, macroId, subtaskId), `${id}.json`));
    return 'present';
  } catch (err) {
    return err.code === 'ENOENT' ? 'absent' : 'unreadable';
  }
}

// --- the operation's transport file (N4) ------------------------------------

export const OPERATION_TRANSPORT_SCHEMA = 'agentic-persona-op-transport-1';
export const OPERATION_TRANSPORT_FILE = 'operation.json';
const TRANSPORT_STATES = Object.freeze(['opening', 'open', 'closed']);

/**
 * The transport file a command's first write leaves in its operation
 * directory, which its later blocks pass back: `{ absent: true }`, `{ value }`
 * or `{ error }` (a file that is not one, or binds no operation).
 */
export function readOperationTransport(dir) {
  const file = path.join(dir, OPERATION_TRANSPORT_FILE);
  const r = readJson(file);
  if (r.absent || r.error) return r;
  const t = r.value;
  const ok = t !== null && typeof t === 'object' && t.schema === OPERATION_TRANSPORT_SCHEMA
    && typeof t.operation_id === 'string' && OPERATION_ID_RE.test(t.operation_id)
    && typeof t.kind === 'string' && /^[a-z]+$/.test(t.kind) && isSafeMacroId(t.macro_id) && isSafeSubtaskId(t.subtask_id)
    && typeof t.branch === 'string' && t.branch.length > 0
    && typeof t.opened_at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(t.opened_at)
    && (t.workflow_id === null || typeof t.workflow_id === 'string')
    && TRANSPORT_STATES.includes(t.state);
  return ok ? { value: t } : { error: `${file} is not an operation transport file (${OPERATION_TRANSPORT_SCHEMA})` };
}

/** Write the transport file whole (aside, then renamed over it). */
export function writeOperationTransport(dir, value) {
  const file = path.join(dir, OPERATION_TRANSPORT_FILE);
  const aside = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(aside, `${JSON.stringify({ schema: OPERATION_TRANSPORT_SCHEMA, ...value })}\n`, { mode: 0o600 });
  fs.renameSync(aside, file);
}

/** Whether operation `id` was cleared by the owner (`writer-clear`, N4). */
export function operationCleared(mainRoot, macroId, subtaskId, id) {
  if (typeof id !== 'string' || !OPERATION_ID_RE.test(id)) throw new Error(`not an operation id: ${JSON.stringify(id)}`);
  try {
    fs.lstatSync(path.join(opsDir(mainRoot, macroId, subtaskId), `${id}.cleared`));
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    // Cannot tell: the operation is taken as cleared, so its last write
    // refuses rather than writes beside the owner's word.
    return true;
  }
}

/**
 * Decision 2, item 5 — whether `branch` is a held lane, for a bootstrap that
 * carries no dispatch linkage there: `{ state: 'none' }`, `{ state: 'held',
 * macroId, subtaskId, holdId, path, why }` or `{ state: 'unreadable', path,
 * error }`. Each macro a hold-aware orchestrator runs for (N2) is read: a
 * hold of it applies to the branch as N3 says, with no child to compare.
 * `linked` ({ macroId, subtaskId }) is the lane a linked bootstrap continues,
 * whose own admission is its operation's (N4): its hold is not read here. A
 * holds directory, marker or owner's record that cannot be read may hold this
 * branch, so it answers unreadable; a macro with no marker refuses nothing.
 */
export function heldLaneOfBranch(mainRoot, branch, { linked = null } = {}) {
  const root = path.join(mainRoot, AUTOPILOT_DIR_REL, 'holds');
  const listed = (dir) => {
    const d = dirState(dir);
    if (d.state !== 'ok') return d;
    try {
      return { state: 'ok', names: fs.readdirSync(dir).sort() };
    } catch (err) {
      return { state: 'unreadable', error: `cannot list ${dir} (${err.code || err.message})` };
    }
  };
  const top = listed(root);
  if (top.state === 'absent') return { state: 'none' };
  if (top.state === 'unreadable') return { state: 'unreadable', path: root, error: top.error };
  for (const macroId of top.names) {
    if (!isSafeMacroId(macroId)) continue;
    // The linked lane's own macro, where it cannot be read, is its
    // operation's to judge (N4): the lane's hold is its own subtask's.
    const own = linked !== null && linked.macroId === macroId;
    const activation = readActivation(mainRoot, macroId);
    if (activation.state === 'inactive') continue;
    if (activation.state === 'unreadable') {
      if (own) continue;
      return { state: 'unreadable', path: activation.path, error: activation.error };
    }
    const dir = path.join(holdsDir(mainRoot, macroId), 'holds');
    const held = listed(dir);
    if (held.state === 'absent') continue;
    if (held.state === 'unreadable') {
      if (own) continue;
      return { state: 'unreadable', path: dir, error: held.error };
    }
    for (const name of held.names) {
      // A record is `<subtask>.json`; anything else (a temporary file, a
      // lock) is no record.
      const subtaskId = name.endsWith('.json') ? name.slice(0, -'.json'.length) : '';
      if (!isSafeSubtaskId(subtaskId)) continue;
      if (linked !== null && linked.macroId === macroId && linked.subtaskId === subtaskId) continue;
      const read = readOwnerHold(mainRoot, macroId, subtaskId);
      if (read.state === 'unreadable') return { state: 'unreadable', path: read.path, error: read.error };
      const applies = holdApplies(read, { branch });
      if (applies.applies) {
        return { state: 'held', macroId, subtaskId, holdId: read.record.hold_id, path: read.path, why: applies.why };
      }
    }
  }
  return { state: 'none' };
}

/**
 * The holds facts of a macro's child, read at once: activation, the owner's
 * hold and whether it applies, a kept park, and a live run.
 */
export function laneHoldFacts({ mainRoot, macroId, subtaskId, branch, workflowId = null, probe }) {
  const activation = readActivation(mainRoot, macroId);
  if (activation.state !== 'active') return { activation };
  const hold = readOwnerHold(mainRoot, macroId, subtaskId);
  return {
    activation,
    hold,
    applies: holdApplies(hold, { branch, workflowId }),
    park: readKeptPark(mainRoot, macroId, subtaskId),
    run: macroRunLive(mainRoot, macroId, probe ? { probe } : {}),
  };
}
