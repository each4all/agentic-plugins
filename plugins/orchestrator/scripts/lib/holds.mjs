// scripts/lib/holds.mjs — the orchestrator's reads and locks over a macro's
// holds (ADR-0068 Decision 2; implementation notes N1-N5 and I1-I3).
//
// The records themselves are holds-records.mjs's. This module adds what the
// orchestrator judges a lane by: the holds lock, a child's open persona
// operations (read fresh from the child's file, never from a summary that
// leaves the field out), the workflows on a subtask's branch, and the facts a
// handoff, a release and a rebinding check. It imports neither state.mjs nor
// the Claude adapter, so both can import it.

import fs from 'node:fs';
import path from 'node:path';

import {
  acquireLock, holderAlive, LockHeldError, macroLockPath, processFingerprint, readLockEntries,
} from './run-locks.mjs';
import {
  AUTOPILOT_DIR_REL, dirState, holdsLockPath, OPERATION_ID_RE, readJson, readOps, readRegular, recordPath,
} from './holds-records.mjs';

export * from './holds-records.mjs';

// The homes a persona workflow lives in under a state root: each persona's
// own, and the legacy home only the engineer has (state-root.mjs SHARED_HOMES),
// where an older engineer left its workflows and archive.
export const PERSONA_HOMES = Object.freeze([
  '.agentic-plugins/state/engineer', '.agentic-plugins/state/designer', '.agentic-plugins/state/founder', '.claude/agentic-engineer',
]);

// How long a writer waits for the holds lock while another holds it.
let lockWaitMs = 5000;
/** Tests only: set that wait (ms) and return the previous one. */
export function setHoldsLockWaitMs(ms) {
  const previous = lockWaitMs;
  lockWaitMs = ms;
  return previous;
}

const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });
let selfFingerprint = null;

/**
 * Run `fn` holding the macro's holds lock (`<holdsDir>/.lock`, a run-locks
 * lock: a live holder is never taken over, a dead one is cleared), retrying
 * briefly while another holds it. Lock order (N5, I2): worktree lock, macro
 * lock, this, then `parks/.lock`; never a persona lock awaited inside it.
 * `onWait` (tests) runs once when the lock is first found held.
 */
export async function withHoldsLock(mainRoot, macroId, fn, { waitMs = lockWaitMs, purpose = 'holds', onWait = null } = {}) {
  return withDirLock(holdsLockPath(mainRoot, macroId), { kind: 'holds', run_id: `${purpose} of ${macroId}` }, 'the holds lock', fn, waitMs, onWait);
}

// A run-locks lock at `lock`, taken with a short retry: the holds lock, and
// the park records' `parks/.lock` as parks.mjs takes it (same record kind).
async function withDirLock(lock, record, name, fn, waitMs, onWait = null) {
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const deadline = Date.now() + waitMs;
  let held;
  for (;;) {
    try {
      selfFingerprint ??= await processFingerprint(process.pid);
      held = await acquireLock(lock, { record, attempts: 3, selfFingerprint });
      break;
    } catch (err) {
      if (!(err instanceof LockHeldError)) throw err;
      if (onWait) { onWait(); onWait = null; }
      if (Date.now() >= deadline) throw new Error(`${name} ${lock} is held (${err.message})`);
      await pause(20 + Math.floor(Math.random() * 30));
    }
  }
  try {
    return await fn();
  } finally {
    held.release();
  }
}

/**
 * Decision 2, item 8 — a retirement ends the subtask's kept park, whatever it
 * holds (readable or not: a completed lane never parks), under the park
 * records' own lock (`parks/.lock`, taken after the holds lock, I2), the
 * change appended to `parks/events.jsonl` as parks.mjs appends its own.
 * `{ removed }`. A missing parks directory is not made.
 */
export async function removeKeptPark(mainRoot, macroId, subtaskId, { event = 'retired', fields = {}, waitMs = lockWaitMs } = {}) {
  const file = recordPath(mainRoot, macroId, 'parks', subtaskId);
  const dir = path.dirname(file);
  if (dirState(dir).state === 'absent') return { removed: false };
  return withDirLock(path.join(dir, '.lock'), { kind: 'parks', run_id: `the park records of ${macroId}` }, "the park records' lock", () => {
    let present = true;
    try { fs.lstatSync(file); } catch (err) { if (err.code === 'ENOENT') present = false; else throw err; }
    if (!present) return { removed: false };
    const r = readJson(file);
    fs.rmSync(file, { force: true, recursive: true });
    fs.appendFileSync(path.join(dir, 'events.jsonl'), `${JSON.stringify({
      at: new Date().toISOString(), event, subtask_id: subtaskId, record_id: typeof r.value?.record_id === 'string' ? r.value.record_id : null, ...fields,
    })}\n`);
    return { removed: true };
  }, waitMs);
}

// --- a workflow file, read without state.mjs ------------------------------------

/**
 * The frontmatter of a persona workflow file as the few scalars the holds
 * read: `{ state: 'ok', fields, text }`, `{ state: 'absent' }` or
 * `{ state: 'unreadable', error }`. `fields` holds `workflow_id`,
 * `parent_workflow`, `originating_subtask`, `branch` (git_baseline.branch),
 * `current_phase`, `pending_ensemble` (whether any entry is pending) and
 * `persona_operations` (the raw scalar, or undefined).
 */
export function readWorkflowFacts(file) {
  const r = readRegular(file);
  if (r.absent) return { state: 'absent' };
  if (r.error) return { state: 'unreadable', error: r.error };
  const text = r.text.replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return { state: 'unreadable', error: `${file} has no frontmatter` };
  const end = text.indexOf('\n---\n', 4);
  if (end < 0) return { state: 'unreadable', error: `${file} has no frontmatter end` };
  const lines = text.slice(4, end).split('\n');
  const fields = { pending_ensemble: false };
  // A quoted scalar that does not parse (a torn or hand-cut line) is no
  // value: the file cannot be read, so it counts open and blocks, never a
  // workflow on no branch that every scan passes over.
  let bad = null;
  const scalar = (raw, key) => {
    const v = raw.trim();
    if (v.startsWith('"')) {
      try { return JSON.parse(v); } catch { bad ??= key; return undefined; }
    }
    return v === 'null' || v === '' ? null : v;
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = /^([a-z_]+):(.*)$/.exec(line);
    if (!m) continue;
    const [, key, rest] = m;
    if (key === 'git_baseline') {
      for (let j = i + 1; j < lines.length && lines[j].startsWith('  '); j += 1) {
        const b = /^ {2}branch:(.*)$/.exec(lines[j]);
        if (b) fields.branch = scalar(b[1], 'git_baseline.branch');
      }
    } else if (key === 'pending_ensemble') {
      const inline = rest.trim();
      fields.pending_ensemble = inline !== '[]' && (inline !== '' || (lines[i + 1] ?? '').startsWith('  - '));
    } else if (key === 'persona_operations') {
      fields.persona_operations = rest.trim();
    } else if (['workflow_id', 'parent_workflow', 'originating_subtask', 'current_phase', 'parent_detached'].includes(key)) {
      fields[key] = scalar(rest, key);
    }
  }
  if (bad !== null) return { state: 'unreadable', error: `${file}: ${bad} is a quoted scalar that does not parse` };
  return { state: 'ok', fields, text: r.text };
}

/**
 * The child's own entries of `persona_operations` (N4: one JSON document in a
 * double-quoted scalar): `{ state: 'absent' | 'ok' | 'unreadable', ops,
 * error? }`. A document of a later version, or one that does not decode, is
 * unreadable, which counts open.
 */
export function decodePersonaOperations(raw) {
  if (raw === undefined || raw === null || raw === '') return { state: 'absent', ops: [] };
  let doc;
  try {
    const inner = JSON.parse(raw);
    doc = typeof inner === 'string' ? JSON.parse(inner) : inner;
  } catch (err) {
    return { state: 'unreadable', ops: [], error: `persona_operations does not decode (${err.message})` };
  }
  if (doc === null || typeof doc !== 'object' || !Array.isArray(doc.ops)) {
    return { state: 'unreadable', ops: [], error: 'persona_operations is not an operations document' };
  }
  if (doc.v !== 1) return { state: 'unreadable', ops: [], error: `persona_operations is version ${JSON.stringify(doc.v)}, not 1` };
  const ops = [];
  for (const op of doc.ops) {
    if (!op || typeof op.id !== 'string' || !OPERATION_ID_RE.test(op.id)) {
      return { state: 'unreadable', ops: [], error: 'persona_operations holds an entry with no operation id' };
    }
    ops.push({ id: op.id, kind: typeof op.kind === 'string' ? op.kind : null, opened_at: op.opened_at ?? null, ext: op.ext === true });
  }
  return { state: 'ok', ops };
}

/**
 * Decision 2, item 7 — the persona operations open in a subtask's lane: the
 * child's entries (read fresh from its file, archived or not) united with the
 * records under `ops/<subtask>/` that no `.cleared` names. A cleared
 * operation is not open, whichever side still names it; a record, a child or
 * an ops directory that cannot be read counts open. `childPath` null when the
 * subtask has no child. `{ open: [{ id, kind, from, error? }], cleared }`.
 */
export function openOperations({ mainRoot, macroId, subtaskId, childPath = null }) {
  const open = new Map();
  const add = (id, kind, from, error) => {
    const cur = open.get(id);
    if (cur) {
      cur.from = cur.from === from ? from : 'both';
      if (error && !cur.error) cur.error = error;
      cur.kind ??= kind;
    } else {
      open.set(id, { id, kind, from, ...(error ? { error } : {}) });
    }
  };
  const ops = readOps(mainRoot, macroId, subtaskId);
  const cleared = new Set(ops.ops.filter((o) => o.cleared).map((o) => o.id));
  if (ops.state === 'unreadable') add('(ops)', null, 'record', ops.error);
  for (const o of ops.ops) {
    if (o.cleared) continue;
    add(o.id, o.record?.kind ?? null, 'record', o.error);
  }
  if (childPath) {
    const facts = readWorkflowFacts(childPath);
    if (facts.state === 'unreadable') add('(child)', null, 'entry', facts.error);
    else if (facts.state === 'ok') {
      const decoded = decodePersonaOperations(facts.fields.persona_operations);
      if (decoded.state === 'unreadable') add('(child)', null, 'entry', decoded.error);
      for (const op of decoded.ops) if (!cleared.has(op.id)) add(op.id, op.kind, 'entry');
    }
  }
  return { open: [...open.values()], cleared: [...cleared] };
}

/** One line naming the open operations, for a refusal or `status`. */
export function describeOperations(open) {
  return open.map((o) => (o.error ? `${o.id} (cannot be read: ${o.error})` : `${o.id}${o.kind ? ` (${o.kind})` : ''}`)).join(', ');
}

/**
 * Every persona workflow on `branch` under the state roots given, active
 * ones only (`workflows/` of each persona home, the legacy one included): `{ linked: [file], other: [{ file, workflowId,
 * why }], unreadable: [{ file, error }] }`. A workflow is linked when it
 * carries this macro's and subtask's dispatch linkage; any other on the
 * branch (unlinked, another lane's) blocks a handoff and a release, since
 * its writes are not the lane's operations (N4, "how the orchestrator reads
 * a workflow begun on a lane's branch before its hold").
 */
export function branchWorkflows({ stateRoots, branch, macroId, subtaskId }) {
  const out = { linked: [], other: [], unreadable: [] };
  const seen = new Set();
  for (const root of stateRoots) {
    for (const home of PERSONA_HOMES) {
      const dir = path.join(root, home, 'workflows');
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch (err) {
        if (err.code === 'ENOENT') continue;
        out.unreadable.push({ file: dir, error: `cannot list ${dir} (${err.code || err.message})` });
        continue;
      }
      for (const name of names.sort()) {
        if (!name.endsWith('.md')) continue;
        const file = path.join(dir, name);
        let real = file;
        try { real = fs.realpathSync(file); } catch { /* as is */ }
        if (seen.has(real)) continue;
        seen.add(real);
        const facts = readWorkflowFacts(file);
        if (facts.state === 'absent') continue;
        if (facts.state === 'unreadable') { out.unreadable.push({ file, error: facts.error }); continue; }
        if (facts.fields.branch !== branch) continue;
        if (facts.fields.parent_workflow === macroId && facts.fields.originating_subtask === subtaskId) out.linked.push(file);
        else {
          out.other.push({
            file, workflowId: facts.fields.workflow_id ?? null,
            why: facts.fields.parent_workflow ? `linked to ${facts.fields.parent_workflow} subtask ${facts.fields.originating_subtask}` : 'carries no dispatch linkage',
          });
        }
      }
    }
  }
  return out;
}

// --- live runs and busy lanes (Decision 2, item 4; N3) -------------------------

const isRunId = (id) => typeof id === 'string' && /^autopilot-\d{8}T\d{6}Z-[0-9a-f]{6}$/.test(id);

/**
 * N3 — the live runs of a macro: `{ live, runs: [{ run_id, pid, capabilities,
 * repo }], why }`. A run is live while its driver lives (a worker that
 * outlived its driver makes its lane busy, not the run live). A lock or an
 * entry that cannot be read, or one too fresh to have been written whole,
 * counts as live; such a run has no id.
 */
export async function liveRuns(mainRoot, macroId, { probe = processFingerprint } = {}) {
  let entries;
  try {
    entries = readLockEntries(macroLockPath(mainRoot, macroId));
  } catch (err) {
    return { live: true, runs: [{ run_id: null, pid: null, capabilities: [], repo: null }], why: `the run lock of ${macroId} cannot be read (${err.message})` };
  }
  const runs = [];
  let why = 'no live run';
  for (const e of entries) {
    if (e.session) continue;
    if (e.holder === null || typeof e.holder !== 'object') {
      if (Date.now() - e.mtimeMs < 5_000) {
        runs.push({ run_id: null, pid: null, capabilities: [], repo: null });
        why = `a run is taking the lock of ${macroId}`;
      }
      continue;
    }
    // Only the driver is judged: a serial run's own entry records its worker
    // (setWorker), and a group's entry names its driver too, so an entry of a
    // dead driver is no live run, whatever worker it records.
    if (runs.some((x) => x.run_id !== null && x.run_id === e.holder.run_id)) continue;
    if (await holderAlive({ pid: e.holder.pid, fingerprint: e.holder.fingerprint }, { probe })) {
      runs.push({
        run_id: e.holder.run_id ?? null, pid: e.holder.pid,
        capabilities: Array.isArray(e.holder.capabilities) ? e.holder.capabilities : [],
        repo: e.holder.repo ?? null,
      });
      why = `run ${e.holder.run_id ?? 'unknown'} (driver pid ${e.holder.pid}) is live`;
    }
  }
  return { live: runs.length > 0, runs, why };
}

/**
 * Decision 2, item 4 — whether something of a run is still in a subtask's
 * lane, seen from outside any driver: a worker or task group of any run of
 * the macro still lives and names the subtask, or names none (a surviving
 * group that names no subtask makes every lane busy); or a run whose driver
 * died left a step of the lane unfinished in its ledger (`stop` or a
 * relaunch cleans that up first). What cannot be read is busy. A live
 * driver's own in-flight work is the driver's to judge. `exceptRun` names
 * the caller's own run (a worker of it running `/orchestrator:done` for the
 * lane), whose worker is the caller itself. `{ busy, why }`.
 */
export async function laneBusy(mainRoot, macroId, subtaskId, { probe = processFingerprint, exceptRun = null } = {}) {
  let entries;
  try {
    entries = readLockEntries(macroLockPath(mainRoot, macroId));
  } catch (err) {
    return { busy: true, why: `the run lock of ${macroId} cannot be read (${err.message})` };
  }
  for (const e of entries) {
    if (e.session || !e.holder?.worker) continue;
    if (exceptRun !== null && e.holder.run_id === exceptRun) continue;
    const w = e.holder.worker;
    const names = w.subtask_id ?? w.lane ?? null;
    if (names !== null && names !== subtaskId) continue;
    if (await holderAlive({ worker: w }, { probe })) {
      return { busy: true, why: names === null
        ? `a worker group of run ${e.holder.run_id ?? 'unknown'} (pid ${w.pid}) names no lane, so every lane of it is busy`
        : `a worker group of run ${e.holder.run_id ?? 'unknown'} (pid ${w.pid}) still runs in the lane` };
    }
  }
  const dir = path.join(mainRoot, AUTOPILOT_DIR_REL, 'open');
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    if (err.code !== 'ENOENT') return { busy: true, why: `the open-run records ${dir} cannot be listed (${err.code || err.message})` };
  }
  for (const name of names.sort()) {
    if (!name.endsWith('.json') || !isRunId(name.slice(0, -'.json'.length))) continue;
    const r = readRegular(path.join(dir, name));
    if (r.absent) continue;
    let rec = null;
    try { rec = r.error ? null : JSON.parse(r.text); } catch { /* below */ }
    if (rec === null || typeof rec !== 'object') return { busy: true, why: `the open-run record ${path.join(dir, name)} cannot be read` };
    if (rec.macro_id !== macroId) continue;
    // A live driver's run is its own to judge; only a dead one's record is.
    if (await holderAlive({ pid: rec.pid, fingerprint: rec.fingerprint }, { probe })) continue;
    const steps = readRegular(path.join(String(rec.run_dir ?? ''), 'steps.jsonl'));
    if (steps.absent) continue;
    if (steps.error) return { busy: true, why: `the ledger of dead run ${rec.run_id} cannot be read (${steps.error})` };
    const open = new Map();
    for (const line of steps.text.split('\n')) {
      if (!line.trim()) continue;
      let s;
      try { s = JSON.parse(line); } catch { continue; }
      if (s?.event === 'started') open.set(s.seq, s.subtask_id ?? null);
      else if (s?.event === 'finished') open.delete(s.seq);
    }
    for (const [seq, sid] of open) {
      if (sid === subtaskId) {
        return { busy: true, why: `run ${rec.run_id} ended uncleanly with step ${seq} of the lane unfinished: \`agentic-autopilot stop --macro ${macroId}\` or a relaunch cleans it up` };
      }
    }
  }
  return { busy: false, why: 'nothing of a run is in the lane' };
}

/** Whether a workflow's file lock is held, judged by its presence (N5). */
export function workflowLockPresent(workflowPath) {
  try {
    fs.lstatSync(`${workflowPath}.lock`);
    return true;
  } catch (err) {
    return err.code !== 'ENOENT';
  }
}
