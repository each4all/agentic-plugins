// scripts/lib/instructions.mjs — the owner's instructions to a lane (ADR-0068
// Decision 7): the record, its bounds, its states and transitions, and the
// whole-record writes under the holds lock.
//
// One record per subtask, `holds/<macro>/instructions/<subtask>.json`, beside
// the holds (Decision 2, item 1) and never a field of the child: a worker's
// `finish-verb` that ends after it is written rewrites the child, and leaves
// the instruction as it was. The record keeps the lane's instructions in the
// order they were written (item 4). Each entry carries its note whole (at most
// NOTE_MAX_BYTES of strict UTF-8 with no NUL byte, as the engineer's
// `--phase-note-file` reads it), the step it names, if any, the branch and the
// child it was written for, and the child's gate witness at the write (item 5:
// a gate set or resolved after the write supersedes its step).
//
// The note is carried, never read (item 1): nothing here prints it, and every
// reader answers with a code and no excerpt of the file (a JSON.parse message
// quotes the text it failed on), so status, halt.json and the event file never
// show a byte of it.
//
// It imports neither state.mjs nor policy.mjs: the step grammar is
// policy.mjs's `parseForcedStep`, less the dispatch and the verification rerun,
// restated here; tests hold the copies equal.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  dirState, holdsDir, holdsRoot, isRecordId, isSafeMacroId, isSafeSubtaskId, newRecordId, readRegular, recordPath, writeWhole,
} from './holds-records.mjs';
import { withHoldsLock } from './holds.mjs';

export const INSTRUCTIONS_SCHEMA = 'agentic-instructions-1';
// The capability a run that applies instructions records in run.json (item 9).
export const INSTRUCTIONS_CAPABILITY = 'instructions-1';
export const NOTE_MAX_BYTES = 16 * 1024;
// At most this many entries a record keeps; one more is refused at the write.
export const MAX_ENTRIES = 64;

export const INSTRUCTION_STATES = Object.freeze(['pending', 'applying', 'applied', 'superseded', 'dropped', 'withdrawn']);
export const FINAL_STATES = Object.freeze(['applied', 'superseded', 'dropped', 'withdrawn']);
// Why an instruction was dropped, never applied (item 6).
export const DROP_CAUSES = Object.freeze([
  'left-plan', 'branch-changed', 'child-archived', 'child-replaced', 'completed', 'closed', 'macro-ended',
]);
// Why an applied instruction's step did not take effect (items 4 and 5): a
// later instruction's step at the same boundary, or a gate set after the write.
export const SUPERSEDE_CAUSES = Object.freeze(['later-step', 'gate']);

// The verbs a step names (policy.mjs VERBS, restated).
export const STEP_VERBS = Object.freeze(['investigate', 'frame', 'decide', 'compose', 'critique', 'refine']);

/**
 * An instruction's next step (item 1): `/engineer:<verb>` or
 * `/engineer:commit`, the forced-step grammar without its dispatch (which
 * follows readiness) and without `verify` (the owner's rerun at a relaunch).
 * `{ ok: true, step, kind, verb? }` with the step in its one spelling, or
 * `{ ok: false, code }`: `not-a-step`, `dispatch` or `verify`.
 */
export function parseInstructionStep(text) {
  if (typeof text !== 'string') return { ok: false, code: 'not-a-step' };
  const words = text.trim().split(/\s+/);
  const [cmd, ...rest] = words;
  if (cmd === '/orchestrator:next') return { ok: false, code: 'dispatch' };
  if (cmd === 'verify') return { ok: false, code: 'verify' };
  const m = /^\/engineer:([a-z]+)$/.exec(cmd ?? '');
  if (!m || rest.length !== 0) return { ok: false, code: 'not-a-step' };
  if (m[1] === 'commit') return { ok: true, step: '/engineer:commit', kind: 'commit' };
  if (STEP_VERBS.includes(m[1])) return { ok: true, step: `/engineer:${m[1]}`, kind: 'verb', verb: m[1] };
  return { ok: false, code: 'not-a-step' };
}

export const STEP_REFUSALS = Object.freeze({
  'not-a-step': 'is not a step an instruction names. Accepted: /engineer:<verb> (investigate, frame, decide, compose, critique, refine), /engineer:commit',
  dispatch: 'is a dispatch, which follows readiness and is never an instruction\'s step (ADR-0068 Decision 7, item 1)',
  verify: 'is the owner\'s rerun of a verification, a relaunch\'s --next, never an instruction\'s step',
});

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * A note's bytes as the engineer's `--phase-note-file` reads them: strict
 * UTF-8, no NUL byte, one trailing newline (LF or CRLF) removed, and text left
 * once blanks are trimmed; at most NOTE_MAX_BYTES. `{ ok: true, note,
 * sha256 }` or `{ ok: false, code }`: `utf8`, `nul`, `blank`, `too-large`.
 */
export function checkNoteBytes(bytes) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(String(bytes), 'utf8');
  if (bytes.length > NOTE_MAX_BYTES) return { ok: false, code: 'too-large' };
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { ok: false, code: 'utf8' };
  }
  if (text.includes('\0')) return { ok: false, code: 'nul' };
  const note = text.replace(/\r?\n$/, '');
  if (note.trim() === '') return { ok: false, code: 'blank' };
  return { ok: true, note, sha256: sha256(note) };
}

export const NOTE_REFUSALS = Object.freeze({
  utf8: 'is not valid UTF-8',
  nul: 'holds a NUL byte',
  blank: 'is empty or blank',
  'too-large': `is larger than ${NOTE_MAX_BYTES} bytes`,
  unreadable: 'cannot be read',
});

/**
 * checkNoteBytes of the regular file at `file`, its raw bytes (a byte that is
 * no UTF-8 is refused, never replaced): `{ ok: false, code: 'unreadable' }`
 * when it is no regular file or cannot be read. A FIFO is opened without
 * blocking, so it is refused, never waited on.
 */
export function readNoteFile(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  } catch {
    return { ok: false, code: 'unreadable' };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { ok: false, code: 'unreadable' };
    if (st.size > NOTE_MAX_BYTES) return { ok: false, code: 'too-large' };
    return checkNoteBytes(fs.readFileSync(fd));
  } catch {
    return { ok: false, code: 'unreadable' };
  } finally {
    fs.closeSync(fd);
  }
}

/** An application's heading line, as instruct-apply.mjs applicationHeading writes it. */
const APPLICATION_HEADING_RE = /^### Owner instructions (app-\d{8}T\d{6}Z-[0-9a-f]{8})$/;

/**
 * The application ids of a lane's instruction record (its receipts) whose
 * receipt names `child`, the workflow id of the child being read: the notes
 * the orchestrator appended to that child. A receipt of the lane's earlier
 * child names a note in that child only; in a replacement child (after a
 * rebinding) its heading can only be a quote, and the first-occurrence rule
 * of linesOutsideApplications proves nothing there (N3). Only a receipt that
 * may have written its note counts, `done` or `reserved`: a `rolled-back` one
 * was ended on proof that the child holds no such heading (instruct-apply.mjs),
 * so a later one is a quote. No child, no ids.
 */
export function laneApplicationIds(record, child) {
  if (typeof child !== 'string' || child === '') return new Set();
  return new Set((Array.isArray(record?.receipts) ? record.receipts : [])
    .filter((r) => r?.child === child && (r.state === 'done' || r.state === 'reserved'))
    .map((r) => r.application_id).filter((id) => typeof id === 'string'));
}

/**
 * The lines of the child `text` from offset `from` on that lie outside the
 * owner's notes an application of this lane appended. An application's note
 * holds the owner's text in fences the orchestrator built (applicationNote),
 * which may quote any heading: its fences are walked to the next heading
 * outside them, where the note ends, and its lines are not yielded. A heading
 * of the application's shape is taken for one only when its id is one of
 * `applications` (the lane's receipts for this child, laneApplicationIds: the
 * shape alone proves nothing, and a worker's note may quote another lane's
 * heading, or one of the lane's earlier child), and
 * only at its first occurrence in the child: its id is random and did not
 * exist before the append, so a later occurrence is a note quoting it.
 * Entering a note at a quote would take the quote's closing fence for an
 * opening one. Every other line is yielded as it is, fences or not: a fence
 * in a worker's note is that worker's Markdown, and one it left unclosed must
 * never hide a later heading.
 */
export function* linesOutsideApplications(text, from = 0, applications = new Set()) {
  const t = String(text);
  let inApplication = false;
  let fence = null;
  let at = from;
  for (const line of t.slice(from).split('\n')) {
    const lineAt = at;
    at += line.length + 1;
    if (inApplication) {
      const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (f) {
        if (fence === null) fence = f[1];
        else if (f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = null;
        continue;
      }
      if (fence !== null || !/^### /.test(line)) continue;
      inApplication = false;
    }
    const app = APPLICATION_HEADING_RE.exec(line);
    if (app && applications.has(app[1]) && (t.startsWith(`${line}\n`) ? 0 : t.indexOf(`\n${line}\n`) + 1) === lineAt) {
      inApplication = true;
      fence = null;
      continue;
    }
    yield line;
  }
}

// The heading a persona's awaiting-owner-clear writes, whole: the gate and
// the second-precision UTC time, so prose naming the heading is not one.
const RESOLVED_HEADING_RE = /^### Owner gate resolved: [a-z][a-z-]* at \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * The child's gate witness (item 5): the gate it has set now (its
 * `awaiting_owner_gate`, or null) and the count of `### Owner gate resolved:
 * <gate> at <iso>` headings in its body outside the owner's notes
 * (linesOutsideApplications over `applications`, the lane's application ids
 * for this child:
 * a worker's unclosed fence, or its quote of another lane's heading, never
 * hides a later resolution, and the owner's note never forges one). A gate set
 * or resolved after an instruction's write changes it, and supersedes that
 * instruction's step. `{ gate, resolved }`, or null when the text has no
 * frontmatter.
 */
export function gateWitnessOf(text, applications = new Set()) {
  if (typeof text !== 'string') return null;
  const t = text.replace(/\r\n/g, '\n');
  if (!t.startsWith('---\n')) return null;
  const end = t.indexOf('\n---\n', 4);
  if (end < 0) return null;
  let gate = null;
  for (const line of t.slice(4, end).split('\n')) {
    const m = /^awaiting_owner_gate:(.*)$/.exec(line);
    if (!m) continue;
    const v = m[1].trim();
    if (v === '' || v === 'null') gate = null;
    else {
      try { gate = v.startsWith('"') ? JSON.parse(v) : v; } catch { gate = v; }
    }
  }
  let resolved = 0;
  for (const line of linesOutsideApplications(t, end + 5, applications)) {
    if (RESOLVED_HEADING_RE.test(line)) resolved += 1;
  }
  return { gate: typeof gate === 'string' ? gate : null, resolved };
}

/** Whether two witnesses differ: a gate set, cleared or resolved between them. */
export function witnessChanged(a, b) {
  if (!a || !b) return a !== b;
  return a.gate !== b.gate || a.resolved !== b.resolved;
}

// --- the record -----------------------------------------------------------------

export const instructionsPath = (mainRoot, macroId, subtaskId) => recordPath(mainRoot, macroId, 'instructions', subtaskId);
export const instructionsDir = (mainRoot, macroId) => path.join(holdsDir(mainRoot, macroId), 'instructions');

const isIso = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

function validWitness(w) {
  return w === null || (w !== null && typeof w === 'object' && (w.gate === null || typeof w.gate === 'string')
    && Number.isInteger(w.resolved) && w.resolved >= 0);
}

function validAck(a) {
  if (a === null) return true;
  if (typeof a !== 'object') return false;
  return isIso(a.at) && typeof a.by === 'string'
    && (a.cause === null || typeof a.cause === 'string')
    && (a.application_id === null || typeof a.application_id === 'string')
    && (a.replaced_step === null || typeof a.replaced_step === 'string');
}

/** Whether `e` is a well-formed entry of subtask `subtaskId`. */
export function validEntry(e, subtaskId) {
  if (e === null || typeof e !== 'object') return false;
  if (!isRecordId(e.id) || !Number.isInteger(e.revision) || e.revision < 1) return false;
  if (e.subtask_id !== subtaskId || typeof e.branch !== 'string' || e.branch === '') return false;
  if (!(e.child === null || (typeof e.child === 'string' && e.child !== ''))) return false;
  if (!(e.step === null || parseInstructionStep(e.step).step === e.step)) return false;
  if (typeof e.note !== 'string' || typeof e.note_sha256 !== 'string' || sha256(e.note) !== e.note_sha256) return false;
  if (Buffer.byteLength(e.note, 'utf8') > NOTE_MAX_BYTES || e.note.includes('\0')) return false;
  if (!isIso(e.written_at) || typeof e.written_by !== 'string') return false;
  if (!validWitness(e.witness ?? null)) return false;
  if (!INSTRUCTION_STATES.includes(e.state)) return false;
  if (!validAck(e.ack ?? null)) return false;
  if (e.state === 'applying' && typeof e.receipt !== 'string') return false;
  if (e.state === 'dropped' && !DROP_CAUSES.includes(e.ack?.cause)) return false;
  if (e.state === 'superseded' && !SUPERSEDE_CAUSES.includes(e.ack?.cause)) return false;
  return true;
}

/** Whether `r` is a well-formed instructions record of `subtaskId`. */
export function validInstructions(r, subtaskId) {
  if (r === null || typeof r !== 'object' || r.schema !== INSTRUCTIONS_SCHEMA || r.subtask_id !== subtaskId) return false;
  if (!Array.isArray(r.entries) || !Array.isArray(r.receipts ?? [])) return false;
  const ids = new Set();
  for (const e of r.entries) {
    if (!validEntry(e, subtaskId) || ids.has(e.id)) return false;
    ids.add(e.id);
  }
  return true;
}

/**
 * The instructions record of a subtask: `{ state: 'absent', path }`, `{ state:
 * 'ok', path, record }` or `{ state: 'unreadable', path, code }`, the code one
 * of `dir` (the directory cannot be listed), `file` (not a regular file, a
 * dangling link, a read that fails), `parse` or `schema`, and never an excerpt
 * of the file (P11).
 */
export function readInstructions(mainRoot, macroId, subtaskId) {
  const file = instructionsPath(mainRoot, macroId, subtaskId);
  const d = dirState(path.dirname(file));
  if (d.state === 'unreadable') return { state: 'unreadable', path: file, code: 'dir' };
  if (d.state === 'absent') return { state: 'absent', path: file };
  const r = readRegular(file);
  if (r.absent) return { state: 'absent', path: file };
  if (r.error) return { state: 'unreadable', path: file, code: 'file' };
  let value;
  try {
    value = JSON.parse(r.text);
  } catch {
    return { state: 'unreadable', path: file, code: 'parse' };
  }
  if (!validInstructions(value, subtaskId)) return { state: 'unreadable', path: file, code: 'schema' };
  return { state: 'ok', path: file, record: { receipts: [], ...value } };
}

export const READ_CODES = Object.freeze({
  dir: 'the instructions directory cannot be listed',
  file: 'the record is not a readable regular file',
  parse: 'the record does not parse as JSON',
  schema: `the record is not an instructions record (${INSTRUCTIONS_SCHEMA}) of the subtask`,
});

/**
 * The subtasks with an instructions record: `{ state, ids, code? }`. A name
 * that is no `<subtask>.json` is passed over.
 */
export function listInstructionIds(mainRoot, macroId) {
  const d = dirState(instructionsDir(mainRoot, macroId));
  if (d.state === 'absent') return { state: 'absent', ids: [] };
  if (d.state === 'unreadable') return { state: 'unreadable', ids: [], code: 'dir' };
  const ids = d.names.filter((n) => n.endsWith('.json') && !n.startsWith('.'))
    .map((n) => n.slice(0, -'.json'.length)).filter(isSafeSubtaskId);
  return { state: 'ok', ids };
}

/**
 * The wake source's digest (item 3; Decision 1, item 6): the sha256, in name
 * order, of every record's name and what the owner writes in it, each entry's
 * id, revision and whether it is withdrawn, or of what keeps the directory or
 * a record from being read (a record the readers refuse, its bytes). It
 * changes whenever an instruction is written, revised or withdrawn, and a
 * record appears, goes or turns unreadable. What a run writes there, a
 * reservation, an application, a rollback, a drop and their receipts,
 * changes it not: a run's own write is no wake, and an attempt that writes a
 * receipt and fails is not tried again for it (impl-instruct critique 7 F1).
 */
export function instructionsDigest(mainRoot, macroId) {
  const h = createHash('sha256');
  const d = dirState(instructionsDir(mainRoot, macroId));
  h.update(`v2\0${d.state}\0`);
  for (const n of d.names ?? []) {
    if (!n.endsWith('.json') || n.startsWith('.')) continue;
    const r = readRegular(path.join(instructionsDir(mainRoot, macroId), n));
    h.update(`${n}\0${typeof r.text === 'string' ? ownerWritten(r.text, n.slice(0, -'.json'.length)) : (r.absent ? '(absent)' : '(unreadable)')}\0`);
  }
  return h.digest('hex');
}

// A record the readers refuse (readInstructions: it does not parse, or is no
// well-formed record of its subtask, a note and its sha256 that disagree
// included) is digested by its bytes: its corruption and its repair wake the
// loop, whatever ids and revisions it keeps.
function ownerWritten(text, subtaskId) {
  let v;
  try { v = JSON.parse(text); } catch { return `bytes\0${text}`; }
  if (!validInstructions(v, subtaskId)) return `bytes\0${text}`;
  return `entries\0${JSON.stringify(v.entries.map((e) => [e?.id ?? null, e?.revision ?? null, e?.state === 'withdrawn']))}`;
}

// --- the transitions ---------------------------------------------------------------

export const INSTRUCTION_TRANSITIONS = Object.freeze([
  ['pending', 'revise', 'pending'],
  ['pending', 'withdraw', 'withdrawn'],
  ['pending', 'reserve', 'applying'],
  ['pending', 'drop', 'dropped'],
  ['applying', 'apply', 'applied'],
  ['applying', 'supersede', 'superseded'],
  ['applying', 'rollback', 'pending'],
]);

export const INSTRUCTION_REFUSALS = Object.freeze([
  ['applying', 'revise', 'it is being applied: its application ends first, then write a new one'],
  ['applying', 'withdraw', 'it is being applied: its application ends first'],
  ['applying', 'drop', 'it is being applied: its receipt is reconciled before anything drops it'],
  ['applying', 'reserve', 'it is being applied already'],
]);

/** `{ to }` for a transition the table has, `{ refused: why }` otherwise. */
export function instructionTransition(from, event) {
  const t = INSTRUCTION_TRANSITIONS.find(([f, e]) => f === from && e === event);
  if (t) return { to: t[2] };
  const r = INSTRUCTION_REFUSALS.find(([f, e]) => f === from && e === event);
  if (r) return { refused: r[2] };
  if (FINAL_STATES.includes(from)) return { refused: `it is ${from}, which is final: write a new instruction` };
  return { refused: `no transition ${event} from ${from}` };
}

export class InstructionRefusal extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'InstructionRefusal';
    this.code = code;
  }
}

const emptyRecord = (subtaskId) => ({ schema: INSTRUCTIONS_SCHEMA, subtask_id: subtaskId, entries: [], receipts: [] });

/**
 * Run `fn(record)` on the subtask's record under the holds lock and write what
 * it returns whole (null: nothing written). An unreadable record refuses
 * (`unreadable`): nothing is written over it. `locked`: the caller holds
 * the holds lock already (a retirement), which is never taken twice.
 */
export async function updateInstructions(mainRoot, macroId, subtaskId, fn, { waitMs, locked = false } = {}) {
  const body = async () => {
    const r = readInstructions(mainRoot, macroId, subtaskId);
    if (r.state === 'unreadable') {
      throw new InstructionRefusal(`subtask ${subtaskId}'s instructions record ${r.path} cannot be read (${READ_CODES[r.code]}); nothing was written`, 'unreadable');
    }
    const record = r.state === 'ok' ? r.record : emptyRecord(subtaskId);
    const out = await fn(record);
    if (out?.record) writeWhole(r.path, out.record);
    return out?.result;
  };
  if (locked) return body();
  return withHoldsLock(mainRoot, macroId, body, { purpose: 'instructions', ...(waitMs !== undefined ? { waitMs } : {}) });
}

const transition = (entry, event) => {
  const t = instructionTransition(entry.state, event);
  if (t.refused) throw new InstructionRefusal(`instruction ${entry.id} (revision ${entry.revision}) is not changed: ${t.refused}`, `refused-${event}`);
  return t.to;
};

/**
 * Write an instruction (item 2), or revise a pending one in its place
 * (`revises: { id, revision }`, refused unless that is the entry's current
 * revision and it is pending). `note` is checkNoteBytes's `{ note, sha256 }`;
 * `step` is parseInstructionStep's step, or null. `still()`, asked under the
 * lock before the write, returns a refusal's text or null. Resolves to the
 * entry written.
 */
export async function writeInstruction({
  mainRoot, macroId, subtaskId, branch, child = null, step = null, note, witness = null, writtenBy, revises = null,
  now = new Date(), still = () => null,
}) {
  if (!isSafeSubtaskId(subtaskId)) throw new InstructionRefusal(`not a subtask id: ${JSON.stringify(subtaskId)}`, 'usage');
  if (step !== null && parseInstructionStep(step).step !== step) throw new InstructionRefusal(`--next ${JSON.stringify(step)} ${STEP_REFUSALS['not-a-step']}`, 'step');
  if (!note || typeof note.note !== 'string' || note.sha256 !== sha256(note.note)) throw new InstructionRefusal('the note was not checked', 'usage');
  return updateInstructions(mainRoot, macroId, subtaskId, async (record) => {
    const why = await still(record);
    if (why) throw new InstructionRefusal(why, 'refused');
    const base = {
      subtask_id: subtaskId, branch, child, step, note: note.note, note_sha256: note.sha256,
      written_at: now.toISOString(), written_by: writtenBy, witness, state: 'pending', ack: null,
    };
    if (revises) {
      const at = record.entries.findIndex((e) => e.id === revises.id);
      if (at < 0) throw new InstructionRefusal(`subtask ${subtaskId} has no instruction ${revises.id}`, 'unknown');
      const cur = record.entries[at];
      transition(cur, 'revise');
      if (cur.revision !== revises.revision) {
        throw new InstructionRefusal(`instruction ${cur.id} is at revision ${cur.revision}, not ${revises.revision}: a revision names the one it replaces, and ${revises.revision} is no longer current`, 'stale-revision');
      }
      const entry = { id: cur.id, revision: cur.revision + 1, ...base };
      const entries = record.entries.slice();
      entries[at] = entry;
      return { record: { ...record, entries }, result: entry };
    }
    if (record.entries.length >= MAX_ENTRIES) {
      throw new InstructionRefusal(`subtask ${subtaskId} keeps ${MAX_ENTRIES} instructions already; nothing was written`, 'full');
    }
    const entry = { id: newRecordId(), revision: 1, ...base };
    return { record: { ...record, entries: [...record.entries, entry] }, result: entry };
  });
}

/** Withdraw a pending instruction (item 4). Resolves to the entry withdrawn. */
export async function withdrawInstruction({ mainRoot, macroId, subtaskId, id, by, now = new Date() }) {
  return updateInstructions(mainRoot, macroId, subtaskId, async (record) => {
    const at = record.entries.findIndex((e) => e.id === id);
    if (at < 0) throw new InstructionRefusal(`subtask ${subtaskId} has no instruction ${id}`, 'unknown');
    const cur = record.entries[at];
    const state = transition(cur, 'withdraw');
    const entry = { ...cur, state, ack: { at: now.toISOString(), by, cause: null, application_id: null, replaced_step: null } };
    const entries = record.entries.slice();
    entries[at] = entry;
    return { record: { ...record, entries }, result: entry };
  });
}

/**
 * Drop every pending instruction of the subtask that `cause(entry)` names a
 * cause for (item 6): acknowledged with that cause, never applied. An entry
 * being applied is left for its receipt's reconciliation. Resolves to the
 * entries dropped; writes nothing when there are none.
 */
export async function dropInstructions({ mainRoot, macroId, subtaskId, cause, by, now = new Date(), locked = false }) {
  if (readInstructions(mainRoot, macroId, subtaskId).state === 'absent') return [];
  return updateInstructions(mainRoot, macroId, subtaskId, async (record) => {
    const dropped = [];
    const entries = record.entries.map((e) => {
      if (e.state !== 'pending') return e;
      const c = cause(e);
      if (!c) return e;
      if (!DROP_CAUSES.includes(c)) throw new Error(`not a drop cause: ${JSON.stringify(c)}`);
      const d = { ...e, state: transition(e, 'drop'), ack: { at: now.toISOString(), by, cause: c, application_id: null, replaced_step: null } };
      dropped.push(d);
      return d;
    });
    return dropped.length ? { record: { ...record, entries }, result: dropped } : { result: [] };
  }, { locked });
}

/** One entry as halt.json and the ended summary keep it: ids and codes, never the note. */
export const summarizeEntry = (subtaskId, e) => ({
  subtask_id: subtaskId, id: e.id, revision: e.revision, state: e.state, step: e.step,
  cause: e.ack?.cause ?? null, application_id: e.ack?.application_id ?? (e.state === 'applying' ? e.receipt : null),
});

// Item 6 — what the macro's end leaves of its instructions once its holds
// directory goes: every entry's outcome, kept beside the holds root (a name
// that is no macro id, which the holds' scans pass over), for status and the
// ending run's halt.json.
export const endedInstructionsPath = (mainRoot, macroId) => {
  if (!isSafeMacroId(macroId)) throw new Error(`not a macro id: ${JSON.stringify(macroId)}`);
  return path.join(holdsRoot(mainRoot), 'ended', `${macroId}.instructions.json`);
};
export function writeEndedInstructions(mainRoot, macroId, entries) {
  writeWhole(endedInstructionsPath(mainRoot, macroId), { schema: 'agentic-instructions-ended-1', macro_id: macroId, entries });
}
/** The ended macro's kept summary, or null when there is none or it cannot be read. */
export function readEndedInstructions(mainRoot, macroId) {
  const r = readRegular(endedInstructionsPath(mainRoot, macroId));
  if (r.absent || r.error) return null;
  try {
    const v = JSON.parse(r.text);
    return v?.schema === 'agentic-instructions-ended-1' && Array.isArray(v.entries) ? v.entries : null;
  } catch {
    return null;
  }
}

/** The entries still to apply, in the order they were written. */
export const pendingEntries = (record) => (record?.entries ?? []).filter((e) => e.state === 'pending');

/** Whether any pending entry names a step. */
export const pendingStep = (record) => pendingEntries(record).find((e) => e.step !== null) ?? null;

/**
 * One line per entry for `status` (item 4): its id, revision, state and what
 * became of it, and never its note, of which only the size shows.
 */
export function describeEntries(record) {
  return (record?.entries ?? []).map((e) => {
    const step = e.step ? ` next ${e.step}` : ' note only';
    const ack = e.ack;
    const tail = {
      pending: e.child ? ` for ${e.child}` : ' waiting for its dispatch',
      applying: ` being applied (${e.receipt})`,
      applied: ` by ${ack?.by ?? '?'} at ${ack?.at ?? '?'}${ack?.application_id ? ` (${ack.application_id})` : ''}${ack?.replaced_step !== undefined ? `, replacing ${ack.replaced_step ?? 'no next step'}` : ''}`,
      superseded: `: its note applied, its step superseded (${ack?.cause === 'gate' ? 'a gate set or resolved after it was written' : 'a later instruction\'s step'})${ack?.application_id ? ` (${ack.application_id})` : ''}`,
      dropped: `: never applied (${ack?.cause ?? '?'})`,
      withdrawn: ` at ${ack?.at ?? '?'}`,
    }[e.state] ?? '';
    return `instruction ${e.id} r${e.revision}: ${e.state}${step} (${Buffer.byteLength(e.note, 'utf8')} bytes of note)${tail}`;
  });
}
