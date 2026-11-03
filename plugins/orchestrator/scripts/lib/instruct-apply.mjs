// scripts/lib/instruct-apply.mjs — applying the owner's instructions to a
// lane's child at its step boundary (ADR-0068 Decision 7, items 3 to 6).
//
// The application is one transaction with a durable receipt (impl-instruct
// P1): under the holds lock the applier reserves the lane's pending entries
// (`applying`, naming the receipt) and writes the receipt beside them; it
// releases the lock (never held across a persona lock, I2), runs the
// engineer's `append` on the child (one persona operation: the notes as one
// phase note whose heading names the receipt, and the effective next step at
// HIGH), reads the child back, and under the lock again finalizes the entries
// `applied` or `superseded` and the receipt `done`. A crash between leaves a
// receipt `reserved`, which the next application reconciles before anything
// else: the heading on the child finalizes it (the note was written, so it is
// never written twice), its absence with the applier gone rolls the entries
// back to `pending` (never lost). An applier still alive is waited for, and
// so is a child that cannot be read now: only a child read whole without the
// heading is its absence.
//
// Precedence (item 5): a gate set or resolved on the child after an entry was
// written (its witness differs) supersedes that entry's step, and its note is
// still appended; of the steps left, the last one written wins and the
// earlier ones are superseded (`later-step`). The note is carried, never read.
//
// Binding (item 6): an entry applies only to the child it was written for. A
// note written before the dispatch (child null) binds to the first child
// linked to the subtask that was created after it (P13); it never moves to a
// later one. The lifecycle sweep drops what applies to nothing, with its cause.
//
// It imports neither state.mjs nor the Claude adapter: the driver, the owner
// command and `state.mjs instruct-apply` all call it, each passing the append
// runner its writer needs (a worker group of the run, an admission's fenced
// writer, or a plain child process in tests).

import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { readRegular, readWorkflowFacts, PERSONA_HOMES } from './holds.mjs';
import {
  FINAL_STATES, gateWitnessOf, InstructionRefusal, instructionsPath, laneApplicationIds, parseInstructionStep, readInstructions, READ_CODES, updateInstructions, witnessChanged,
} from './instructions.mjs';
import { holderAlive, processFingerprint } from './run-locks.mjs';

export const RECEIPT_STATES = Object.freeze(['reserved', 'done', 'rolled-back']);
// At most this many ended receipts a record keeps; the oldest go first.
const KEEP_RECEIPTS = 16;
const APPEND_TIMEOUT_MS = 60_000;

/** A new application id, `app-<yyyymmddThhmmssZ>-<8 hex>`. */
export function newApplicationId(now = new Date()) {
  return `app-${now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${randomBytes(4).toString('hex')}`;
}
export const APPLICATION_ID_RE = /^app-\d{8}T\d{6}Z-[0-9a-f]{8}$/;

/** The phase label the application's note carries on the child, naming its receipt. */
export const applicationHeading = (applicationId) => `Owner instructions ${applicationId}`;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// --- the child -------------------------------------------------------------------

/**
 * The child's next step in an instruction's spelling (`/engineer:<verb>`,
 * `/engineer:commit`), or its kind (`owner-decision`, `done`, `verify`), or
 * null when none is recorded.
 */
export function childNextStep(text) {
  const t = String(text ?? '').replace(/\r\n/g, '\n');
  if (!t.startsWith('---\n')) return null;
  const end = t.indexOf('\n---\n', 4);
  const fm = t.slice(4, end < 0 ? t.length : end);
  const field = (k) => {
    const m = new RegExp(`^${k}:(.*)$`, 'm').exec(fm);
    if (!m) return null;
    const v = m[1].trim();
    if (v === '' || v === 'null') return null;
    try { return v.startsWith('"') ? JSON.parse(v) : v; } catch { return v; }
  };
  const kind = field('next_step_kind');
  if (kind === null) return null;
  if (kind === 'verb') return `/engineer:${field('next_step_verb') ?? '?'}`;
  if (kind === 'commit') return '/engineer:commit';
  return kind;
}

/**
 * The verification batch the child `text` records started and not ended for
 * its pending request (Decision 5: `next_step_kind: verify`, and the latest
 * batch of `verify_results` for that request has no `end`), as the driver's
 * verify step reads it (verify-run.mjs planVerify): its id, or null when none
 * is open. `true` when a request is pending and its request or results cannot
 * be read: the verify step is what judges that record.
 */
export function openBatchOf(text) {
  const t = String(text ?? '').replace(/\r\n/g, '\n');
  if (!t.startsWith('---\n')) return null;
  const end = t.indexOf('\n---\n', 4);
  const fm = t.slice(4, end < 0 ? t.length : end);
  const raw = (k) => {
    const m = new RegExp(`^${k}:(.*)$`, 'm').exec(fm);
    const v = m ? m[1].trim() : '';
    return v === '' || v === 'null' ? null : v;
  };
  const kind = raw('next_step_kind');
  if ((kind?.startsWith('"') ? kind.slice(1, -1) : kind) !== 'verify') return null;
  // A record is stored as `key: "<its JSON>"` (the persona's scalarBytes).
  const value = (k) => {
    const v = raw(k);
    if (v === null) return null;
    let x = JSON.parse(v);
    if (typeof x === 'string') x = JSON.parse(x);
    return x;
  };
  let request;
  let results;
  try {
    request = value('verify_request');
    results = value('verify_results');
  } catch {
    return true;
  }
  if (!request || typeof request !== 'object' || typeof request.id !== 'string') return null;
  if (!results || results.request_id !== request.id || !Array.isArray(results.batches)) return null;
  const latest = results.batches.at(-1);
  if (!latest || typeof latest !== 'object' || latest.end !== undefined) return null;
  return typeof latest.batch_id === 'string' && latest.batch_id !== '' ? latest.batch_id : true;
}

/** Workflow-id time, `yyyymmddThhmmssZ`, or ''. */
const idTime = (id) => /-(\d{8}T\d{6}Z)-[0-9a-f]+$/.exec(id ?? '')?.[1] ?? '';
const isoStamp = (iso) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/**
 * Every child linked to the subtask under the state roots, active or archived:
 * `{ children: [{ id, path, archived }], unreadable, unreadableAt }`, oldest
 * first by the time in the id, `unreadableAt` the directories and files that
 * could not be read. One id is listed once per home kind (workflows, archive),
 * from the first root that holds it; `allCopies` lists every copy under every
 * root, for the recovery, which must read each one.
 */
export function linkedChildren(stateRoots, { macroId, subtaskId }, { allCopies = false } = {}) {
  const children = [];
  const unreadableAt = [];
  const seen = new Set();
  for (const root of stateRoots) {
    for (const home of PERSONA_HOMES) {
      for (const sub of ['workflows', 'archive']) {
        const dir = path.join(root, home, sub);
        let names;
        try {
          names = fs.readdirSync(dir);
        } catch (err) {
          if (err.code !== 'ENOENT') unreadableAt.push(dir);
          continue;
        }
        for (const n of names.sort()) {
          if (!n.endsWith('.md')) continue;
          const file = path.join(dir, n);
          const f = readWorkflowFacts(file);
          if (f.state === 'absent') continue;
          if (f.state !== 'ok') { unreadableAt.push(file); continue; }
          if (f.fields.parent_workflow !== macroId || f.fields.originating_subtask !== subtaskId) continue;
          const id = f.fields.workflow_id;
          // A file linked to the subtask that names no workflow id may be the
          // entries' child: which child it is cannot be told, and skipped, a
          // child still active would read as gone (a drop, child-archived).
          if (typeof id !== 'string' || id === '') { unreadableAt.push(file); continue; }
          if (!allCopies && seen.has(`${sub}:${id}`)) continue;
          seen.add(`${sub}:${id}`);
          children.push({ id, path: file, archived: sub === 'archive', branch: f.fields.branch ?? null });
        }
      }
    }
  }
  children.sort((a, b) => idTime(a.id).localeCompare(idTime(b.id)));
  return { children, unreadable: unreadableAt.length > 0, unreadableAt };
}

/**
 * The child an entry is bound to (item 6; P13): its own `child`, or, for a
 * note written before the dispatch, the first linked child created at or
 * after its write. `{ child, archived }`, `{ child: null }` while none is
 * there yet, or `{ unknown: true }` when the homes cannot all be read.
 */
export function boundChild(entry, linked) {
  if (linked.unreadable) return { unknown: true };
  if (entry.child !== null) {
    const found = linked.children.filter((c) => c.id === entry.child);
    if (found.length === 0) return { child: entry.child, gone: true };
    return { child: entry.child, archived: found.every((c) => c.archived) };
  }
  const after = isoStamp(entry.written_at);
  const first = linked.children.find((c) => idTime(c.id) >= after && c.branch === entry.branch);
  if (!first) return { child: null };
  const copies = linked.children.filter((c) => c.id === first.id);
  return { child: first.id, archived: copies.every((c) => c.archived) };
}

// --- the lifecycle sweep (item 6; P4) ---------------------------------------------

/**
 * Why a pending entry applies to nothing now, or null: the subtask left the
 * plan, is completed, deferred or abandoned, changed branch; its child
 * archived; a different child took the lane. `subtask` is the plan's entry
 * (undefined when gone), `active` the lane's active child id (null for none),
 * `linked` linkedChildren's answer.
 */
export function dropCause(entry, { subtask, active, linked }) {
  if (!subtask) return 'left-plan';
  if (subtask.status === 'completed') return 'completed';
  if (subtask.status === 'deferred' || subtask.status === 'abandoned') return 'closed';
  if (subtask.branch !== entry.branch) return 'branch-changed';
  const b = boundChild(entry, linked);
  if (b.unknown) return null;
  if (b.child === null) return null;
  if (b.archived) return 'child-archived';
  if (b.gone) return active === null ? 'child-archived' : 'child-replaced';
  if (active !== null && active !== b.child) return 'child-replaced';
  return null;
}

/**
 * Drop every pending entry of the subtask that applies to nothing (dropCause).
 * Resolves to the entries dropped. A record that cannot be read drops nothing.
 */
export async function sweepInstructions({ mainRoot, macroId, subtaskId, subtask, stateRoots, by, now = new Date() }) {
  const r = readInstructions(mainRoot, macroId, subtaskId);
  if (r.state !== 'ok' || !r.record.entries.some((e) => e.state === 'pending')) return [];
  const linked = linkedChildren(stateRoots, { macroId, subtaskId });
  const activeOnes = linked.children.filter((c) => !c.archived && (!subtask || c.branch === subtask.branch));
  const active = activeOnes.length === 1 ? activeOnes[0].id : null;
  // Two active children: which one the lane has cannot be told, so nothing
  // is judged replaced.
  if (activeOnes.length > 1) return [];
  const dropped = [];
  try {
    await updateInstructions(mainRoot, macroId, subtaskId, async (record) => {
      const entries = record.entries.map((e) => {
        if (e.state !== 'pending') return e;
        const cause = dropCause(e, { subtask, active, linked });
        if (!cause) return e;
        const d = { ...e, state: 'dropped', ack: { at: now.toISOString(), by, cause, application_id: null, replaced_step: null } };
        dropped.push(d);
        return d;
      });
      return dropped.length ? { record: { ...record, entries } } : null;
    });
  } catch (err) {
    if (!(err instanceof InstructionRefusal)) throw err;
    return [];
  }
  return dropped;
}

// --- receipts and recovery (P1) -----------------------------------------------------

function validReceipt(r) {
  return r !== null && typeof r === 'object' && APPLICATION_ID_RE.test(r.application_id) && RECEIPT_STATES.includes(r.state)
    && Array.isArray(r.entries) && typeof r.child === 'string';
}

/** The receipt an entry being applied names, or null. */
const receiptOf = (record, id) => (record.receipts ?? []).find((x) => x.application_id === id) ?? null;

/**
 * Whether the child file at `childPath` holds the application's heading:
 * `written`, `absent` (the file read, and holds no such heading), or
 * `unreadable` (it could not be read now: a crash's write may be in it).
 */
export function childApplicationState(childPath, applicationId) {
  const r = readRegular(childPath);
  if (r.absent || r.error || typeof r.text !== 'string') return 'unreadable';
  return r.text.replace(/\r\n/g, '\n').includes(`\n### ${applicationHeading(applicationId)}\n`) ? 'written' : 'absent';
}

/** Whether the child file at `childPath` holds the application's heading (one that cannot be read does not). */
export function childHoldsApplication(childPath, applicationId) {
  return childApplicationState(childPath, applicationId) === 'written';
}

/**
 * Finalize, or roll back, the receipts a crash left `reserved` (P1), before
 * anything else reads the record: the child holding the heading finalizes it;
 * only its positive absence, with the applier gone, rolls it back (every
 * persona home read, at least one copy of the child found, and every copy
 * under every root read and found without it).
 * A receipt whose applier lives, or whose child cannot be read now (a home or
 * a file that does not read, a file gone between the listing and the read),
 * is left reserved (`{ waiting }`): rolled back, its note would be appended a
 * second time once the child reads again (Decision 7, item 3). Resolves to
 * `{ finalized, rolledBack, waiting }`, application ids.
 */
export async function reconcileReceipts({ mainRoot, macroId, subtaskId, stateRoots, probe = processFingerprint, now = new Date() }) {
  const out = { finalized: [], rolledBack: [], waiting: [] };
  const r = readInstructions(mainRoot, macroId, subtaskId);
  if (r.state !== 'ok' || !(r.record.receipts ?? []).some((x) => x.state === 'reserved')) return out;
  const linked = linkedChildren(stateRoots, { macroId, subtaskId }, { allCopies: true });
  const alive = new Map();
  for (const x of r.record.receipts.filter((y) => y.state === 'reserved')) {
    alive.set(x.application_id, await holderAlive({ pid: x.pid, fingerprint: x.fingerprint }, { probe }));
  }
  await updateInstructions(mainRoot, macroId, subtaskId, async (record) => {
    let changed = false;
    const receipts = record.receipts.map((x) => {
      if (x.state !== 'reserved') return x;
      const files = linked.children.filter((c) => c.id === x.child).map((c) => c.path);
      const states = files.map((f) => childApplicationState(f, x.application_id));
      if (states.includes('written')) {
        changed = true;
        out.finalized.push(x.application_id);
        return { ...x, state: 'done', recovered: true, ended_at: now.toISOString() };
      }
      // No copy of the recorded child found is no proof of absence either (a
      // child moved between the listings): only copies read whole, and none
      // holding the heading, are.
      if (alive.get(x.application_id) || linked.unreadable || states.length === 0 || states.includes('unreadable')) { out.waiting.push(x.application_id); return x; }
      changed = true;
      out.rolledBack.push(x.application_id);
      return { ...x, state: 'rolled-back', ended_at: now.toISOString() };
    });
    if (!changed) return null;
    const entries = record.entries.map((e) => {
      if (e.state !== 'applying') return e;
      const x = receipts.find((y) => y.application_id === e.receipt);
      if (!x || x.state === 'reserved') return e;
      return x.state === 'done' ? finalizeEntry(e, x, now) : rollbackEntry(e);
    });
    return { record: { ...record, entries, receipts: pruneReceipts(receipts) } };
  });
  return out;
}

function finalizeEntry(e, x, now) {
  const superseded = (x.superseded ?? []).find((s) => s.id === e.id);
  const { receipt, ...rest } = e;
  return {
    ...rest,
    state: superseded ? 'superseded' : 'applied',
    ack: { at: now.toISOString(), by: x.by, cause: superseded?.cause ?? null, application_id: x.application_id, replaced_step: x.replaced_step ?? null },
  };
}

function rollbackEntry(e) {
  const { receipt, ...rest } = e;
  return { ...rest, state: 'pending' };
}

function pruneReceipts(receipts) {
  const ended = receipts.filter((x) => x.state !== 'reserved');
  const drop = new Set(ended.slice(0, Math.max(0, ended.length - KEEP_RECEIPTS)).map((x) => x.application_id));
  return receipts.filter((x) => !drop.has(x.application_id));
}

// --- the application ---------------------------------------------------------------

/**
 * Which of the lane's pending entries apply to `child` now, and what each
 * becomes (items 4 and 5): `{ entries, effective, superseded }`, the step
 * `effective` the last one left after the gate rule, or null. `witness` is the
 * child's gate witness now. `only`, a Set of `<id>:<revision>` keys, or null:
 * beside a run's untaken forced step only the entries pending at its launch
 * apply (item 5); every other entry stays pending, whatever it says.
 */
export function planApplication(record, { child, linked, witness, only = null }) {
  const entries = record.entries.filter((e) => e.state === 'pending' && (only === null || only.has(`${e.id}:${e.revision}`))
    && boundChild(e, linked).child === child && !boundChild(e, linked).archived);
  const superseded = [];
  let effective = null;
  let winner = null;
  for (const e of entries) {
    if (e.step === null) continue;
    // A gate set or resolved after the write supersedes the step; a note
    // written before the dispatch carries no step.
    if (e.witness === null || witnessChanged(e.witness, witness)) {
      superseded.push({ id: e.id, cause: 'gate' });
      continue;
    }
    if (winner) superseded.push({ id: winner.id, cause: 'later-step' });
    winner = e;
    effective = e.step;
  }
  return { entries, effective, superseded };
}

/** The phase note the application appends: every note in order, each named, its step's fate said. */
export function applicationNote({ applicationId, entries, effective, superseded }) {
  const parts = [`The owner's instructions to this lane (ADR-0068 Decision 7), applied as ${applicationId}, in the order written.`];
  for (const e of entries) {
    const s = superseded.find((x) => x.id === e.id);
    const fate = e.step === null ? 'a note' : s
      ? `a note; its step ${e.step} is superseded (${s.cause === 'gate' ? 'a gate was set or resolved after it was written, and the gate decides' : 'a later instruction names the step'})`
      : `a note and the next step ${e.step}, recorded at HIGH`;
    // Each note inside a fence longer than any backtick run it holds: a
    // fence or a heading in the owner's text never reaches past it, so it can
    // neither hide a later gate resolution from the witness nor forge one.
    const fence = '`'.repeat(Math.max(3, ...[...e.note.matchAll(/`+/g)].map((m) => m[0].length + 1)));
    parts.push(`#### Instruction ${e.id} r${e.revision} — ${fate}\n\n${fence}text\n${e.note}\n${fence}`);
  }
  if (effective === null) parts.push('No next step is set by these instructions: the recorded one stands.');
  return `${parts.join('\n\n')}\n`;
}

/** The engineer append's arguments for the application. */
export function appendArgs({ engineerRoot, childPath, host, applicationId, noteFile, effective }) {
  const args = [
    path.join(engineerRoot, 'scripts', 'state.mjs'), 'append', '--workflow-path', childPath, '--host', host,
    '--phase-label', applicationHeading(applicationId), '--phase-note-file', noteFile, '--event', 'updated',
    '--once-operation', 'checkpoint',
  ];
  if (effective !== null) {
    const p = parseInstructionStep(effective);
    args.push('--next-action', `Run ${p.step} (the owner's instruction, ${applicationId})`);
    if (p.kind === 'commit') args.push('--next-step-kind', 'commit', '--next-step-confidence', 'HIGH');
    else args.push('--next-step-kind', 'verb', '--next-step-verb', p.verb, '--next-step-confidence', 'HIGH');
  }
  return args;
}

/**
 * The environment of the driver's persona writes (verify-run.mjs personaEnvOf,
 * restated): outside every autopilot run, as the owner writes, so the
 * engineer's attempt fencing never takes the application for a stale step of
 * the run (P9).
 */
export function personaEnv(base) {
  const env = {};
  for (const [k, v] of Object.entries(base)) if (!k.startsWith('AGENTIC_AUTOPILOT') && k !== 'AGENTIC_STATE_BASE') env[k] = v;
  return env;
}

/** A plain append runner: the engineer's append as a child process, outside the run. Resolves to `{ ok, detail? }`. */
export async function plainAppend(args, { env = process.env } = {}) {
  try {
    execFileSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: APPEND_TIMEOUT_MS, env: personaEnv(env) });
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: `the engineer's append refused: ${String(err.stderr || err.message).trim().split('\n')[0]}` };
  }
}

/**
 * Apply the lane's pending instructions to `childPath` (item 3), the caller
 * having judged the lane at a boundary. Resolves to `{ state, ... }`:
 * `none` (nothing pending for the child), `applied` with `applicationId`,
 * `entries`, `effective`, `superseded`, `replacedStep`; `waiting` (a receipt
 * of a live applier or beside a child that cannot be read, the child moved
 * before the write, or a child that cannot be read back after the append,
 * its receipt left reserved: try at the next boundary), `failed` with `detail` (the append refused: the entries are back
 * to pending), or `unreadable`. `runAppend(args)` is the writer; `onlyEntries`
 * (`<id>:<revision>` keys), when given, is all the reservation may take;
 * `hooks.beforeAppend` (tests) runs between the reservation and the write.
 */
export async function applyInstructions({
  mainRoot, macroId, subtaskId, childPath, engineerRoot, host = 'claude', by, stateRoots = [mainRoot],
  runAppend = plainAppend, now = () => new Date(), probe = processFingerprint, hooks = {}, onlyEntries = null,
}) {
  const rec = await reconcileReceipts({ mainRoot, macroId, subtaskId, stateRoots, probe, now: now() });
  if (rec.waiting.length) return { state: 'waiting', detail: `application ${rec.waiting.join(', ')} of subtask ${subtaskId}'s instructions is still being written by a live process, or its child cannot be read now` };
  const read = readInstructions(mainRoot, macroId, subtaskId);
  if (read.state === 'absent') return { state: 'none' };
  if (read.state === 'unreadable') return { state: 'unreadable', detail: READ_CODES[read.code] };
  const facts = readWorkflowFacts(childPath);
  if (facts.state !== 'ok') return { state: 'waiting', detail: `subtask ${subtaskId}'s child cannot be read` };
  const child = facts.fields.workflow_id;
  const before = readRegular(childPath).text;
  const linked = linkedChildren(stateRoots, { macroId, subtaskId });
  // A home or a file that cannot be read may hold a copy of the child, or the
  // child a note written before the dispatch is bound to: which entries apply
  // cannot be told, and none is (an entry bound to no known child would read
  // as nothing to do, and the lane's old step would run over it). The
  // instructions wait, and the driver defers the lane (DEFER_STATES).
  if (linked.unreadable) {
    return { state: 'waiting', detail: `the workflow homes subtask ${subtaskId}'s child may be in cannot all be read (${linked.unreadableAt.join(', ')}): which instructions apply to it cannot be told` };
  }
  const applicationId = newApplicationId(now());
  const fingerprint = await processFingerprint(process.pid);
  let plan = null;
  try {
    plan = await updateInstructions(mainRoot, macroId, subtaskId, async (record) => {
      const p = planApplication(record, { child, linked, witness: gateWitnessOf(before, laneApplicationIds(record, child)), only: onlyEntries ? new Set(onlyEntries) : null });
      if (p.entries.length === 0) return { result: p };
      const ids = new Set(p.entries.map((e) => e.id));
      const receipt = {
        application_id: applicationId, state: 'reserved', child, child_path: childPath,
        entries: p.entries.map((e) => ({ id: e.id, revision: e.revision })), effective_step: p.effective, superseded: p.superseded,
        replaced_step: p.effective === null ? null : childNextStep(before), before_sha256: sha256(before),
        by, pid: process.pid, fingerprint, at: now().toISOString(),
      };
      return {
        record: {
          ...record,
          entries: record.entries.map((e) => (ids.has(e.id) ? { ...e, state: 'applying', receipt: applicationId } : e)),
          receipts: [...(record.receipts ?? []), receipt],
        },
        result: p,
      };
    });
  } catch (err) {
    if (!(err instanceof InstructionRefusal)) throw err;
    return { state: 'unreadable', detail: err.message };
  }
  if (plan.entries.length === 0) return { state: 'none' };
  const end = async (state, extra = {}) => {
    await updateInstructions(mainRoot, macroId, subtaskId, async (record) => {
      const x = receiptOf(record, applicationId);
      if (!x || x.state !== 'reserved') return null;
      const ended = { ...x, state, ended_at: now().toISOString(), ...extra };
      const receipts = record.receipts.map((y) => (y.application_id === applicationId ? ended : y));
      const entries = record.entries.map((e) => (e.state === 'applying' && e.receipt === applicationId
        ? (state === 'done' ? finalizeEntry(e, ended, now()) : rollbackEntry(e)) : e));
      return { record: { ...record, entries, receipts: pruneReceipts(receipts) } };
    });
  };
  if (hooks.beforeAppend) await hooks.beforeAppend();
  // The child as reserved: a write that slipped in since (a session's, a
  // snapshot's) is judged at the next boundary, with its gate witness.
  if (sha256(readRegular(childPath).text ?? '') !== sha256(before)) {
    await end('rolled-back', { why: 'child-moved' });
    return { state: 'waiting', detail: `subtask ${subtaskId}'s child changed between the look and the write; its instructions wait for the next boundary` };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentic-instruct-'));
  let appended;
  try {
    const noteFile = path.join(dir, 'note.md');
    fs.writeFileSync(noteFile, applicationNote({ applicationId, ...plan }), { mode: 0o600 });
    appended = await runAppend(appendArgs({ engineerRoot, childPath, host, applicationId, noteFile, effective: plan.effective }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  // The child read back: a child that cannot be read now may hold the note,
  // so the receipt stays reserved, and the recovery decides once it reads
  // (this applier is gone by then); rolled back, the note would be appended
  // twice.
  const readBack = childApplicationState(childPath, applicationId);
  if (readBack === 'unreadable') {
    return { state: 'waiting', detail: `subtask ${subtaskId}'s child cannot be read back after the append${appended.ok ? '' : ` (${appended.detail})`}; application ${applicationId} stays reserved until it reads` };
  }
  if (!appended.ok) {
    // A refusal can still have written (a crash past the write): the heading
    // decides, as the recovery would.
    if (readBack === 'written') {
      await end('done', { after_note: 'written-despite-error' });
    } else {
      await end('rolled-back', { why: 'append-refused' });
      return { state: 'failed', detail: appended.detail };
    }
  } else {
    if (readBack !== 'written') {
      await end('rolled-back', { why: 'not-read-back' });
      return { state: 'failed', detail: `subtask ${subtaskId}'s child read back does not hold the instructions' note` };
    }
    await end('done', { after_sha256: sha256(readRegular(childPath).text ?? '') });
  }
  return {
    state: 'applied', applicationId, child, entries: plan.entries.map((e) => ({ id: e.id, revision: e.revision })),
    effective: plan.effective, superseded: plan.superseded, replacedStep: plan.effective === null ? null : childNextStep(before),
  };
}

/** The ids of every entry of the record that a final state ended (for status and tests). */
export const endedEntries = (record) => (record?.entries ?? []).filter((e) => FINAL_STATES.includes(e.state));

export { instructionsPath };

// --- the boundary (item 3) ------------------------------------------------------------

/**
 * Why the lane is not at a boundary for an instruction, or null (item 3):
 * held, or a release of it not compared yet (holds.mjs holdGate); a persona
 * operation open in it; a peer settlement pending on the child; the child in
 * a commit it began and did not finish (item 5: the commit runs again, and its
 * archive or gate decides). The caller adds what only it knows: a worker step
 * or a verification batch in flight (a run), a run's leftovers (laneBusy).
 */
export function boundaryRefusal(a) {
  return boundaryState(a)?.why ?? null;
}

/**
 * boundaryRefusal with what the lane's own step does about it: `{ why,
 * stepFirst }`, or null at a boundary. `stepFirst` is true where the lane's
 * recorded step is what the instruction waits for (a commit begun and not
 * finished runs again; a pending peer settlement is the step's to settle), so
 * the run decides the lane as before; false where the boundary only waits
 * (a hold, an open operation, a child that cannot be read), so the lane's
 * recorded step must not start over the instruction: the run keeps it waiting
 * and tries again.
 */
export function boundaryState({ mainRoot, macroId, subtaskId, childPath, holdGate, openOperations }) {
  const held = holdGate({ mainRoot, macroId, subtaskId });
  if (held) return { why: held, stepFirst: false };
  const facts = readWorkflowFacts(childPath);
  if (facts.state !== 'ok') return { why: `subtask ${subtaskId}'s child cannot be read (${facts.error ?? facts.state})`, stepFirst: false };
  const open = openOperations({ mainRoot, macroId, subtaskId, childPath }).open;
  if (open.length) return { why: `a persona operation is open in subtask ${subtaskId}'s lane (${open.map((o) => o.id).join(', ')})`, stepFirst: false };
  if (facts.fields.pending_ensemble) return { why: `a peer settlement is pending on subtask ${subtaskId}'s child`, stepFirst: true };
  const text = facts.text.replace(/\r\n/g, '\n');
  // A verification batch the child records started and not ended: a run
  // that died left it open, and only the lane's verify step ends it (cut
  // short, verify-run.mjs `end`). Applied first, an instruction's step would
  // replace the request and leave the batch open in the record for good.
  const batch = openBatchOf(text);
  if (batch) {
    return { why: `a verification batch ${batch === true ? 'whose record cannot be read' : batch} is open on subtask ${subtaskId}'s child: the lane's verify step ends it first`, stepFirst: true };
  }
  const terminal = /^terminal_marker:\s*true\s*$/m.test(text.slice(0, text.indexOf('\n---\n', 4)));
  // As the policy reads it (policy.mjs COMMIT_SURFACE_PHASES): a commit begun,
  // or one whose archive did not run; an interactive verb's terminal end is
  // no commit.
  if (facts.fields.current_phase === 'phase-7-commit' || (terminal && ['commit-complete', 'close-complete'].includes(facts.fields.current_phase))) {
    return { why: `subtask ${subtaskId}'s child is in a commit it began and did not finish: the commit runs again, and its archive or gate decides`, stepFirst: true };
  }
  return null;
}
