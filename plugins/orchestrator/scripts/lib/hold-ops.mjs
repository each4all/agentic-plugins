// scripts/lib/hold-ops.mjs — the changes a hold goes through (ADR-0068
// Decision 2; implementation note I1-I3): its handoff, its release, the
// comparison that consumes or rejects a release, and its retirement. Each is a
// sequence of whole-file writes under the holds lock, in the order I3 fixes,
// so a crash between two of them leaves a state the next hold-aware command
// or run completes.
//
// The driver, the owner's commands and the interactive orchestrator commands
// all call these; none of them imports state.mjs or the Claude adapter.

import fs from 'node:fs';
import path from 'node:path';

import { randomBytes } from 'node:crypto';

import {
  appendHoldEvent, branchWorkflows, decodePersonaOperations, describeOperations, dirState, holdApplies, holdsDir, holdsRoot, holdStateOf, holdTransition,
  isSafeMacroId, isSafeSubtaskId, laneBusy, PERSONA_HOMES, listRecordIds, liveRuns, newOperationId, newRecordId, openOperations, publishOpRecord, readActivation,
  readKeptPark, readOps, readOwnerHold, readRecord, readWorkflowFacts, recordPath, removeKeptPark, removeOpRecord, unlinkQuiet, withHoldsLock,
  validHold, validRelease, workflowLockPresent, writeWhole, HANDOFF_SCHEMA, RELEASE_SCHEMA,
} from './holds.mjs';
import {
  fenceState, holderAlive, laneLockRivals, processFingerprint, removeFence, removeSubtaskFences, repairFence, writeFence,
} from './run-locks.mjs';
import { worktreeHoldingBranch } from './state-root.mjs';

/**
 * Whether a lane's worktree is there. Only absence (ENOENT) reads as not
 * there: any other failure of the look (a parent directory without search
 * permission) throws a HoldRefusal coded `lane-unreadable`, so a lane, and
 * the fence in it, is never passed over because it cannot be seen (the
 * fail-closed rule for scans).
 */
function laneThere(p) {
  try {
    fs.statSync(p);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw new HoldRefusal(`the lane's worktree ${p} cannot be looked at (${err.code || err.message}); nothing of it is read as gone: restore access to it, then try again`, 'lane-unreadable');
  }
}

/** `laneThere`, with a worktree that cannot be looked at as null: the caller leaves it as it is. */
function laneSeenNow(p) {
  try {
    return laneThere(p);
  } catch (err) {
    if (err instanceof HoldRefusal) return null;
    throw err;
  }
}

/**
 * The lane a hold covers, as the handoff and the release read it: its
 * worktree (null when it has none), the linked child's active workflow (null
 * when none), and what blocks: other workflows on the branch, unreadable
 * ones, several linked children, a worktree that cannot be looked at
 * (`laneError`, its message, also a blocker).
 */
export function laneOf({ hold, stateRoots, macroId }) {
  let laneRoot = null;
  let laneError = null;
  try {
    laneRoot = typeof hold.lane === 'string' && laneThere(hold.lane) ? hold.lane : null;
  } catch (err) {
    if (!(err instanceof HoldRefusal)) throw err;
    laneError = err.message;
  }
  const roots = [...new Set([...stateRoots, ...(laneRoot ? [laneRoot] : [])])];
  const wf = branchWorkflows({ stateRoots: roots, branch: hold.branch, macroId, subtaskId: hold.subtask_id });
  const blockers = laneError ? [laneError] : [];
  if (wf.linked.length > 1) blockers.push(`several workflows are linked to subtask ${hold.subtask_id} on ${hold.branch}: ${wf.linked.join(', ')}`);
  for (const o of wf.other) blockers.push(`workflow ${o.workflowId ?? o.file} on ${hold.branch} is not the lane's child (${o.why}): archive it or finish it first`);
  for (const u of wf.unreadable) blockers.push(`${u.file} cannot be read (${u.error})`);
  let childPath = wf.linked.length === 1 ? wf.linked[0] : null;
  // A child that archived (committed, waiting to land) still carries the
  // operations it left open: a commit's stays open through its archive and
  // parent writeback (N4). Found by the id the hold recorded.
  // A hold that names none (set while its dispatch ran) finds the latest
  // archived child linked to its subtask on its branch: one archived before
  // the handoff is still the lane's. An archived workflow, or an archive, that
  // cannot be read may be that child, its operations open: it blocks, as the
  // scans that count it open do (childEntries), never passed over.
  if (childPath === null && wf.linked.length === 0) {
    if (typeof hold.child === 'string') {
      const a = archivedChildAt(roots, hold.child);
      childPath = a.file;
      for (const u of a.unreadable) blockers.push(`${u.file} cannot be read (${u.error}), and it may hold the lane's archived child ${hold.child}`);
      if (a.others.length) blockers.push(`the lane's archived child ${hold.child} is archived in several places (${[a.file, ...a.others].join(', ')}): which one holds its operations cannot be told; remove the stale copy`);
    } else {
      const a = archivedChildren(roots, { macroId, subtaskId: hold.subtask_id, branch: hold.branch });
      childPath = a.latest;
      for (const u of a.unreadable) blockers.push(`${u.file} cannot be read (${u.error}), and it may be the lane's archived child`);
    }
  }
  return { laneRoot, childPath, blockers, laneError };
}

// The id's time, for ordering the children of a subtask by when they began.
const idTime = (id) => /-(\d{8}T\d{6}Z)-[0-9a-f]+$/.exec(id ?? '')?.[1] ?? '';

/**
 * The archived persona workflows linked to a subtask on its branch under the
 * state roots: `{ latest, unreadable }`, `latest` the one latest by the time
 * in its id (null when none), `unreadable` each archived workflow or archive
 * directory that cannot be read (`[{ file, error }]`), whose linkage cannot
 * be told.
 */
export function archivedChildren(stateRoots, { macroId, subtaskId, branch }) {
  let best = null;
  const unreadable = [];
  for (const root of stateRoots) {
    for (const home of PERSONA_HOMES) {
      const dir = path.join(root, home, 'archive');
      let names = [];
      try {
        names = fs.readdirSync(dir);
      } catch (err) {
        if (err.code !== 'ENOENT') unreadable.push({ file: dir, error: `cannot list it (${err.code || err.message})` });
        continue;
      }
      for (const n of names) {
        if (!n.endsWith('.md')) continue;
        const file = path.join(dir, n);
        const f = readWorkflowFacts(file);
        if (f.state === 'absent') continue;
        if (f.state !== 'ok') { unreadable.push({ file, error: f.error }); continue; }
        if (f.fields.parent_workflow !== macroId || f.fields.originating_subtask !== subtaskId || f.fields.branch !== branch) continue;
        const t = idTime(f.fields.workflow_id);
        if (!best || t > best.t) best = { file, t };
      }
    }
  }
  return { latest: best?.file ?? null, unreadable };
}

/** The latest archived persona workflow linked to a subtask on its branch, or null (`archivedChildren`). */
export function latestArchivedChild(stateRoots, which) {
  return archivedChildren(stateRoots, which).latest;
}

/**
 * The owner's hold as its lane is read (`holdStateOf`'s result): its child
 * the one the owner's record names, or, for a hold set before its subtask's
 * dispatch, the one its handoff found.
 */
export function heldChild(st) {
  const h = st.hold.record;
  const own = st.handoff?.state === 'ok' && st.handoff.record.hold_id === h.hold_id && typeof st.handoff.record.child === 'string';
  return { ...h, child: h.child ?? (own ? st.handoff.record.child : null) };
}

/** A persona workflow's archived file under the state roots, or null (`archivedChildAt`). */
export function archivedChild(stateRoots, workflowId) {
  return archivedChildAt(stateRoots, workflowId).file;
}

/**
 * A persona workflow's archived file under the state roots: `{ file,
 * unreadable, others }`, `file` null when none is found, `unreadable` each
 * place it may be that cannot be looked at (`[{ file, error }]`: a stat that
 * fails for any reason but absence), never read as its absence, and `others`
 * each further copy found that is not the same file as `file`. Every root is
 * looked in before a match is accepted: a copy in a later root, unreadable or
 * not, may be the one that holds the child's open operations.
 */
export function archivedChildAt(stateRoots, workflowId) {
  const unreadable = [];
  const found = [];
  if (!/^[a-z]+-\d{8}T\d{6}Z-[0-9a-f]{6}$/.test(workflowId ?? '')) return { file: null, unreadable, others: [] };
  for (const root of stateRoots) {
    for (const home of PERSONA_HOMES) {
      const file = path.join(root, home, 'archive', `${workflowId}.md`);
      try {
        const { dev, ino } = fs.statSync(file);
        if (!found.some((f) => f.dev === dev && f.ino === ino)) found.push({ file, dev, ino });
      } catch (err) {
        if (err.code !== 'ENOENT') unreadable.push({ file, error: err.code || err.message });
      }
    }
  }
  return { file: found[0]?.file ?? null, unreadable, others: found.slice(1).map((f) => f.file) };
}

/**
 * What keeps a writer possibly active in the lane (Decision 2, items 4 and 7):
 * open persona operations, the child's pending peer ensemble, its workflow
 * lock, other workflows on the branch. `[why]`, empty when none.
 */
export function writerBlockers({ mainRoot, macroId, subtaskId, lane }) {
  const out = [...lane.blockers];
  const ops = openOperations({ mainRoot, macroId, subtaskId, childPath: lane.childPath });
  if (ops.open.length) out.push(`a persona operation is open in the lane: ${describeOperations(ops.open)}`);
  if (lane.childPath) {
    const facts = readWorkflowFacts(lane.childPath);
    if (facts.state === 'ok' && facts.fields.pending_ensemble) out.push(`the child ${facts.fields.workflow_id} has a pending peer ensemble`);
    if (workflowLockPresent(lane.childPath)) out.push(`the child's workflow file lock is held (${lane.childPath}.lock)`);
  }
  return out;
}

/**
 * Decision 2, item 4 — complete a pending hold's handoff, under the holds
 * lock: re-read the owner's record; judge the lane's lock entries, a busy
 * lane, open operations, the child's peers and workflow lock and the other
 * workflows on the branch; write the fence; look again as an admission does;
 * acknowledge. A retry that finds its own fence redoes every check. A held
 * hold whose fence went missing gets it back.
 *
 * `busy(subtaskId)` is the caller's own view of the lane (the driver's steps
 * in flight and settlements under way; none for a command). `exclude` names
 * lock entries the caller hands over to the fence (the driver's own lane-lock
 * entry). Resolves to `{ state, blocker?, holdId?, fence? }` with `state`
 * one of `held`, `pending`, `none` (no hold that a handoff concerns).
 */
export async function completeHandoff({
  mainRoot, macroId, subtaskId, stateRoots, busy = () => null, exclude = [], probe, hooks = {},
}) {
  return withHoldsLock(mainRoot, macroId, async () => {
    const st = holdStateOf(mainRoot, macroId, subtaskId);
    if (st.state !== 'pending' && st.state !== 'held') return { state: 'none', why: st.state };
    const hold = adoptLane(mainRoot, st);
    const lane = laneOf({ hold, stateRoots, macroId });
    if (st.state === 'held') {
      if (lane.laneRoot) repairFence({ laneRoot: lane.laneRoot, holdId: hold.hold_id, subtaskId, macroId, held: true });
      return { state: 'held', holdId: hold.hold_id, fence: st.handoff.record.fence };
    }
    const blockersNow = async () => {
      const out = [];
      const own = busy(subtaskId);
      if (own) out.push(own);
      if (lane.laneRoot) {
        const rivals = (await laneLockRivals(lane.laneRoot, { holdId: hold.hold_id, ...(probe ? { probe } : {}) }))
          .filter((e) => !exclude.includes(e.file));
        for (const e of rivals) out.push(`${path.basename(e.file)} in the lane's worktree lock (${e.holder?.kind === 'session' ? `a session's ${e.holder.command ?? 'admission'}` : `run ${e.holder?.run_id ?? 'unknown'}`})`);
      }
      const b = await laneBusy(mainRoot, macroId, subtaskId, probe ? { probe } : {});
      if (b.busy) out.push(b.why);
      out.push(...writerBlockers({ mainRoot, macroId, subtaskId, lane }));
      return out;
    };
    const before = await blockersNow();
    if (before.length) {
      // A fence a crashed handoff left stays only while it can be acked.
      if (lane.laneRoot && fenceState(lane.laneRoot, hold.hold_id) === 'present') removeFence(lane.laneRoot, hold.hold_id);
      return { state: 'pending', holdId: hold.hold_id, blocker: before.join('; ') };
    }
    const fence = lane.laneRoot ? writeFence({ laneRoot: lane.laneRoot, holdId: hold.hold_id, subtaskId, macroId }) : null;
    if (hooks.afterFence) await hooks.afterFence();
    // Look again: a writer that came in between the first look and the fence.
    const after = await blockersNow();
    if (after.length) {
      if (fence) removeFence(lane.laneRoot, hold.hold_id);
      return { state: 'pending', holdId: hold.hold_id, blocker: after.join('; ') };
    }
    // The child the lane has now, for a hold set before its subtask's
    // dispatch (a step in flight then): the release and its comparison find
    // it by this id once it has archived (`heldChild`).
    const child = hold.child ?? (lane.childPath ? readWorkflowFacts(lane.childPath).fields?.workflow_id ?? null : null);
    writeWhole(recordPath(mainRoot, macroId, 'handoffs', subtaskId), {
      schema: HANDOFF_SCHEMA, hold_id: hold.hold_id, subtask_id: subtaskId, state: 'acked', fence, child, at: new Date().toISOString(),
    });
    appendHoldEvent(mainRoot, macroId, { event: 'held', subtask_id: subtaskId, hold_id: hold.hold_id, fence });
    return { state: 'held', holdId: hold.hold_id, fence };
  });
}

/**
 * A pending or held hold recorded with no lane (I1: its branch had no
 * worktree when it was set) takes the worktree that holds its branch now, a
 * run's lane created meanwhile or the person's own, written into its owner
 * record (`st.hold.record` too) at its handoff and at its release, under the
 * holds lock: the fence, the release's basis and the comparison then cover
 * the worktree the work is in. The main checkout (a hand dispatch's) is no
 * lane. Returns the owner record as it stands.
 */
function adoptLane(mainRoot, st) {
  const hold = st.hold.record;
  if (hold.lane !== null || (st.state !== 'pending' && st.state !== 'held')) return hold;
  const at = branchLane(mainRoot, hold.branch);
  if (typeof at !== 'string') return hold;
  st.hold.record = { ...hold, lane: at };
  writeWhole(st.hold.path, st.hold.record);
  return st.hold.record;
}

/**
 * Remove a released, retired or orphaned hold's leftover fence (I3: owner
 * released with the fence present), and put back a held hold's missing one.
 * Read-only otherwise. `{ repaired: 'written' | 'removed' | 'none', blocker? }`,
 * `blocker` when the lane's worktree cannot be looked at: nothing is repaired.
 */
export async function repairHoldFence({ mainRoot, macroId, subtaskId }) {
  // Under the holds lock: a handoff between its fence and its ack is pending
  // with its fence present, and only the handoff itself may judge that fence.
  return withHoldsLock(mainRoot, macroId, () => {
    const hold = readOwnerHold(mainRoot, macroId, subtaskId);
    if (hold.state !== 'ok' || typeof hold.record.lane !== 'string') return { repaired: 'none' };
    try {
      if (!laneThere(hold.record.lane)) return { repaired: 'none' };
    } catch (err) {
      if (!(err instanceof HoldRefusal)) throw err;
      return { repaired: 'none', blocker: err.message };
    }
    const st = holdStateOf(mainRoot, macroId, subtaskId);
    if (st.state === 'pending' || st.state === 'unreadable') return { repaired: 'none' };
    return { repaired: repairFence({ laneRoot: hold.record.lane, holdId: hold.record.hold_id, subtaskId, macroId, held: st.state === 'held' }) };
  });
}

/** The records of a subtask other than the owner's that name an older hold: removed (I3, `hold`). */
export function dropStaleRecords({ mainRoot, macroId, subtaskId, holdId }) {
  for (const kind of ['handoffs', 'releases']) {
    const r = readRecord(mainRoot, macroId, kind, subtaskId);
    if (r.state === 'ok' && r.record.hold_id !== holdId) {
      // A release in force (uncompared) is never dropped: a new hold keeps it.
      if (kind === 'releases' && r.record.state === 'uncompared') continue;
      unlinkQuiet(r.path);
    }
  }
}

// --- hold and release (Decision 2, items 2, 7 and 8) ---------------------------

export class HoldRefusal extends Error {
  constructor(message, code = 'refused') {
    super(message);
    this.name = 'HoldRefusal';
    this.code = code;
  }
}

/**
 * The withdrawal of a hold set over a release still in force (`prior`, which
 * `setHold` kept): that release, then its hold's owner record, go back, so
 * the lane is as it was before the hold (I12: a rejection is never lost, and
 * an uncompared release is still compared). A crash between the two leaves
 * the new hold pending, which a retry withdraws again. A prior that cannot be
 * read refuses: withdrawing would lose it. `true` when one was restored.
 */
function restorePrior({ mainRoot, macroId, subtaskId, hold, hooks = {} }) {
  const p = hold.prior;
  if (p === undefined || p === null) return false;
  if (!validHold(p?.hold, subtaskId) || !validRelease(p?.release, subtaskId) || p.release.hold_id !== p.hold.hold_id) {
    throw new HoldRefusal(`hold ${hold.hold_id} of ${subtaskId} keeps an earlier release that cannot be read, and withdrawing it would lose that release: ` +
      `let its handoff complete (agentic-autopilot status --macro ${macroId}), then release it, and the driver compares the lane`, 'unreadable');
  }
  writeWhole(recordPath(mainRoot, macroId, 'releases', subtaskId), p.release);
  // Tests: a crash between the two writes.
  if (hooks.betweenRestoreWrites) hooks.betweenRestoreWrites();
  writeWhole(recordPath(mainRoot, macroId, 'holds', subtaskId), p.hold);
  return true;
}

/**
 * Whether a release of this hold must be compared though its handoff is
 * pending: `--discard-unreadable` replaced its record, or its handoff's, or a
 * release of it, so whether the lane was handed over cannot be told, and a
 * withdrawal with nothing to compare could give back a lane its person still
 * edits, or drop a rejection (I12).
 */
const comparesOnRelease = (hold) => hold.compare_on_release === true;

/**
 * Set a hold (the owner's `hold`), under the holds lock: a new owner record
 * `held` with a new hold id, naming the subtask's branch, lane and child; the
 * handoff is pending until `completeHandoff` acks it. Refuses over a record
 * that cannot be read (item 8) and beside a hold that is already held.
 * `stillEligible()`, asked first under the lock, is the caller's fresh look at
 * the plan and the holds: a reason (the macro ended, its holds retired since
 * the caller looked) refuses before any write. Resolves to the record written.
 */
export async function setHold({ mainRoot, macroId, subtaskId, branch, lane = null, child = null, setBy = 'owner', now = new Date(), stillEligible = () => null }) {
  return withHoldsLock(mainRoot, macroId, async () => {
    const ineligible = await stillEligible();
    if (ineligible) throw new HoldRefusal(ineligible, 'ineligible');
    const cur = readOwnerHold(mainRoot, macroId, subtaskId);
    if (cur.state === 'unreadable') {
      throw new HoldRefusal(`the hold record of ${subtaskId} cannot be read (${cur.error}); it is not overwritten: \`agentic-autopilot release ${subtaskId} --macro ${macroId} --discard-unreadable\` keeps a copy and replaces it`, 'unreadable');
    }
    if (cur.state === 'ok' && cur.record.state === 'held' && cur.record.orphaned === undefined) {
      throw new HoldRefusal(`subtask ${subtaskId} is already held (hold ${cur.record.hold_id})`, 'already-held');
    }
    // A release still in force (not compared yet, or rejected) is kept on the
    // new hold as `prior`: a withdrawal before its handoff puts it back, so a
    // rejection is never lost and an uncompared release is still compared
    // (I12); a release of the new hold replaces it.
    const st = holdStateOf(mainRoot, macroId, subtaskId);
    const prior = st.state === 'rejected' || st.state === 'released-uncompared'
      ? { hold: (({ prior: _, ...h }) => h)(st.hold.record), release: st.release.record }
      : null;
    const record = {
      schema: 'agentic-hold-1', hold_id: newRecordId(), subtask_id: subtaskId, branch, lane, child,
      state: 'held', set_by: setBy, set_at: now.toISOString(), ...(prior ? { prior } : {}),
    };
    // The fence an earlier hold of the subtask left (a release stopped after
    // its owner record moved) goes before that hold's id is lost (I3). A lane
    // that cannot be looked at refuses the hold before any write.
    const lanes = [...new Set([lane, cur.state === 'ok' ? cur.record.lane : null])].filter((l) => typeof l === 'string' && laneThere(l));
    for (const l of lanes) removeSubtaskFences(l, { macroId, subtaskId, keepHoldId: null });
    writeWhole(recordPath(mainRoot, macroId, 'holds', subtaskId), record);
    dropStaleRecords({ mainRoot, macroId, subtaskId, holdId: record.hold_id });
    return record;
  });
}

/**
 * P2 — publish the orchestrator's own exclusive operation record in the lane
 * (kind `release` or `compare`) before it looks, so a persona operation's
 * first write refuses beside it (N4, "whoever opened it"), then look again
 * for any other open operation: one found withdraws the record and refuses.
 * Resolves to the id published; `release(id)` removes it.
 */
export async function excludeWriters({ mainRoot, macroId, subtaskId, childPath, kind }) {
  const id = newOperationId();
  const fingerprint = await processFingerprint(process.pid);
  publishOpRecord(mainRoot, macroId, subtaskId, {
    operation_id: id, kind, subtask_id: subtaskId, workflow_id: null, persona: 'orchestrator',
    host: null, opened_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), pid: process.pid, fingerprint,
  });
  const others = openOperations({ mainRoot, macroId, subtaskId, childPath }).open.filter((o) => o.id !== id);
  if (others.length) {
    removeOpRecord(mainRoot, macroId, subtaskId, id);
    throw new HoldRefusal(`a persona operation is open in the lane: ${describeOperations(others)}`, 'operation-open');
  }
  return id;
}

/**
 * I3 — remove the orchestrator's own exclusion records (kind `release`,
 * `compare`, `retire` or `cutover`) whose recorded process is gone: a release,
 * comparison, retirement or move a crash stopped. A live one, and every persona record, stays.
 */
export async function sweepDeadExclusions({ mainRoot, macroId, subtaskId }) {
  const removed = [];
  for (const o of readOps(mainRoot, macroId, subtaskId).ops) {
    const r = o.record;
    if (!r || o.cleared || r.persona !== 'orchestrator' || !['release', 'compare', 'retire', 'cutover'].includes(r.kind)) continue;
    if (await holderAlive({ pid: r.pid, fingerprint: r.fingerprint })) continue;
    removeOpRecord(mainRoot, macroId, subtaskId, o.id);
    removed.push(o.id);
  }
  return removed;
}

/**
 * Release a hold (the owner's `release --hold <id>`), under the holds lock.
 * A pending hold is withdrawn with nothing to compare (one a discard touched
 * is released as a held one, `comparesOnRelease`); a held one records
 * the comparison basis (`basisOf(lane)`, Task 5's digest) behind the writer
 * exclusion, then the owner record `released`, then the fence's removal. A
 * release names the hold it ends; it refuses while a writer may be active,
 * and, for a held one, where `laneRefusal(laneRoot)` gives a reason (the
 * caller's: a worktree no run steps the subtask in), before any write but the
 * lane's adoption.
 * Resolves to `{ state: 'withdrawn' | 'released-uncompared', release }`.
 * `hooks.onLockWait` (tests) runs once when the holds lock is found held.
 */
export async function releaseHold({ mainRoot, macroId, subtaskId, holdId, stateRoots, basisOf, keptParkId = () => null, laneRefusal = () => null, probe, now = () => new Date(), hooks = {} }) {
  return withHoldsLock(mainRoot, macroId, async () => {
    await sweepDeadExclusions({ mainRoot, macroId, subtaskId });
    const st = holdStateOf(mainRoot, macroId, subtaskId);
    if (st.state === 'unreadable') {
      throw new HoldRefusal(`the hold records of ${subtaskId} cannot be read (${st.hold.error ?? st.release?.error ?? st.why}); \`agentic-autopilot release ${subtaskId} --macro ${macroId} --discard-unreadable\` keeps a copy and replaces them`, 'unreadable');
    }
    if (st.state === 'none') throw new HoldRefusal(`subtask ${subtaskId} of macro ${macroId} has no hold`, 'no-hold');
    let hold = st.hold.record;
    if (hold.hold_id !== holdId) {
      const t = holdTransition(st.state, 'release-other-hold-id');
      throw new HoldRefusal(`${t.refused ?? 'a release names the hold it ends'}: the hold of ${subtaskId} is ${hold.hold_id}, not ${holdId}`, 'other-hold');
    }
    if (st.state === 'released-uncompared') {
      // A retry of a release stopped after its owner record moved: finish it.
      if (typeof hold.lane === 'string' && laneThere(hold.lane)) removeFence(hold.lane, hold.hold_id);
      return { state: 'released-uncompared', release: st.release.record, again: true };
    }
    if (st.state !== 'pending' && st.state !== 'held') throw new HoldRefusal(`hold ${holdId} is ${st.state}: only a new hold gives the lane back`, 'ended');
    // A worktree the person made after the handoff is the lane the release's
    // basis covers, and the comparison finds it in the owner record.
    hold = adoptLane(mainRoot, st);
    const lane = laneOf({ hold: heldChild(st), stateRoots, macroId });
    // A worktree that cannot be looked at refuses every release, a withdrawal
    // too: its basis, and its fence's removal, would read it as gone.
    if (lane.laneError) throw new HoldRefusal(lane.laneError, 'lane-unreadable');
    const at = now().toISOString();
    const write = (release) => writeWhole(recordPath(mainRoot, macroId, 'releases', subtaskId), release);
    const finish = (release) => {
      writeWhole(recordPath(mainRoot, macroId, 'holds', subtaskId), { ...hold, state: 'released', released_at: at });
      if (lane.laneRoot) removeFence(lane.laneRoot, hold.hold_id);
      appendHoldEvent(mainRoot, macroId, { event: 'released', subtask_id: subtaskId, hold_id: hold.hold_id, release_id: release.release_id, state: release.state });
    };
    // A pending hold was never handed over, so it is withdrawn with nothing to
    // compare; one a discard touched may have been, so it is released as a
    // held one is, with its basis.
    if (st.state === 'pending' && !comparesOnRelease(hold)) {
      if (hold.prior !== undefined && hold.prior !== null) {
        // The new hold's fence (a handoff a crash stopped) goes first, while
        // the owner's record still names it: once the earlier hold's record is
        // back, nothing names this one, and no repair would find its fence.
        if (lane.laneRoot) removeFence(lane.laneRoot, hold.hold_id);
        if (hooks.beforeRestore) hooks.beforeRestore();
        restorePrior({ mainRoot, macroId, subtaskId, hold, hooks });
        const restored = hold.prior.release;
        appendHoldEvent(mainRoot, macroId, { event: 'released', subtask_id: subtaskId, hold_id: hold.hold_id, state: 'withdrawn', restored: restored.state, release_id: restored.release_id });
        return { state: 'withdrawn', release: restored, restored: restored.state };
      }
      const prior = st.release.state === 'ok' && st.release.record.hold_id === holdId && st.release.record.state === 'withdrawn' ? st.release.record : null;
      const release = prior ?? {
        schema: RELEASE_SCHEMA, release_id: newRecordId(), hold_id: holdId, subtask_id: subtaskId, state: 'withdrawn',
        basis: null, park_record_id: null, park_ended: false, released_at: at, compared_at: null,
      };
      if (!prior) write(release);
      finish(release);
      return { state: 'withdrawn', release };
    }
    // A worktree no run would step the subtask in (the person's own): its
    // basis would name a lane the comparison finds gone once the person
    // frees the branch for the run, and while they do not, the run parks the
    // lane (lanes.mjs row 11). The caller names the order that works.
    const foreign = lane.laneRoot ? laneRefusal(lane.laneRoot) : null;
    if (foreign) throw new HoldRefusal(foreign, 'foreign-lane');
    const blockers = writerBlockers({ mainRoot, macroId, subtaskId, lane });
    if (blockers.length) {
      throw new HoldRefusal(`${holdTransition('held', 'release-while-operation-open').refused}: ${blockers.join('; ')}`, 'writer-active');
    }
    const opId = await excludeWriters({ mainRoot, macroId, subtaskId, childPath: lane.childPath, kind: 'release' });
    try {
      const basis = await basisOf({ laneRoot: lane.laneRoot, childPath: lane.childPath, hold: heldChild(st) });
      const release = {
        schema: RELEASE_SCHEMA, release_id: newRecordId(), hold_id: holdId, subtask_id: subtaskId, state: 'uncompared',
        basis, park_record_id: keptParkId(subtaskId) ?? null, park_ended: false, released_at: at, compared_at: null,
      };
      write(release);
      finish(release);
      return { state: 'released-uncompared', release };
    } finally {
      removeOpRecord(mainRoot, macroId, subtaskId, opId);
    }
  }, { onWait: hooks.onLockWait });
}

// --- the comparison (Decision 2, item 7; I3 consumption and rejection) ---------

/** Whether two bases are equal: fingerprint (same version), tree digest, content digest and child. */
export function basesEqual(a, b) {
  return Boolean(a && b) && a.fingerprint_version === b.fingerprint_version && a.fingerprint === b.fingerprint
    && a.tree_digest === b.tree_digest && a.content_digest === b.content_digest && (a.child ?? null) === (b.child ?? null);
}

/**
 * Before a lane with an uncompared release steps, compare it once (the
 * driver's), under the holds lock and behind the writer exclusion (P2):
 * equal consumes it, then ends the kept park it recorded (`endPark(recordId)`,
 * a conditional delete by that id), then marks the park's end done; different
 * rejects it, for good. Resolves to `{ verdict: 'consumed' | 'rejected' |
 * 'none' | 'refused', why? }` — `none` when no release of the current hold is
 * uncompared; `refused` when a writer may be in the lane (`writerBlockers`,
 * looked at again beside the exclusion record): the lane does not step.
 * `hooks.beforeExclusion` (tests) runs between the first look and the record.
 */
export async function compareRelease({ mainRoot, macroId, subtaskId, stateRoots, basisOf, endPark = async () => true, now = () => new Date(), hooks = {} }) {
  return withHoldsLock(mainRoot, macroId, async () => {
    await sweepDeadExclusions({ mainRoot, macroId, subtaskId });
    const st = holdStateOf(mainRoot, macroId, subtaskId);
    if (st.state !== 'released-uncompared') return { verdict: 'none', state: st.state };
    const release = st.release.record;
    // The child the release's basis names: a hold set before the dispatch
    // names none, and its child, active at the release, may have archived
    // since (a commit): it is found by that id, so an edit to it is compared.
    const hold = { ...st.hold.record, child: (typeof release.basis?.child === 'string' ? release.basis.child : null) ?? heldChild(st).child };
    let lane = laneOf({ hold, stateRoots, macroId });
    // What would refuse the release refuses its comparison (I14): a workflow
    // on the branch that is not the lane's child, one that cannot be read,
    // the child's pending peers or workflow lock, an open operation. The
    // release left the lane, so a writer that came in since is the person's.
    const before = writerBlockers({ mainRoot, macroId, subtaskId, lane });
    if (before.length) return { verdict: 'refused', why: before.join('; ') };
    if (hooks.beforeExclusion) await hooks.beforeExclusion();
    let opId;
    try {
      opId = await excludeWriters({ mainRoot, macroId, subtaskId, childPath: lane.childPath, kind: 'compare' });
    } catch (err) {
      if (err instanceof HoldRefusal) return { verdict: 'refused', why: err.message };
      throw err;
    }
    try {
      // Look at the branch again beside the exclusion: a workflow begun
      // between the first look and the record.
      lane = laneOf({ hold, stateRoots, macroId });
      if (lane.blockers.length) return { verdict: 'refused', why: lane.blockers.join('; ') };
      const current = await basisOf({ laneRoot: lane.laneRoot, childPath: lane.childPath, hold });
      const verdict = basesEqual(release.basis, current) ? 'consumed' : 'rejected';
      const t = holdTransition('released-uncompared', verdict === 'consumed' ? 'compare-equal' : 'compare-different');
      const record = { ...release, state: t.to, compared_at: now().toISOString() };
      writeWhole(recordPath(mainRoot, macroId, 'releases', subtaskId), record);
      appendHoldEvent(mainRoot, macroId, { event: verdict, subtask_id: subtaskId, hold_id: hold.hold_id, release_id: release.release_id });
      if (verdict === 'consumed') await finishConsumption({ mainRoot, macroId, subtaskId, endPark, locked: true });
      return { verdict, release: record, current };
    } finally {
      removeOpRecord(mainRoot, macroId, subtaskId, opId);
    }
  });
}

/**
 * I3 — a consumed release whose kept park's end is still pending: end that
 * park, by the record id the release recorded, never a newer one; then mark
 * it done. Idempotent. `locked` when the caller already holds the holds lock.
 */
export async function finishConsumption({ mainRoot, macroId, subtaskId, endPark, locked = false }) {
  const run = async () => {
    const r = readRecord(mainRoot, macroId, 'releases', subtaskId);
    if (r.state !== 'ok' || r.record.state !== 'consumed' || r.record.park_ended) return { finished: false };
    if (r.record.park_record_id) await endPark(r.record.park_record_id);
    writeWhole(r.path, { ...r.record, park_ended: true });
    return { finished: true };
  };
  return locked ? run() : withHoldsLock(mainRoot, macroId, run);
}

// --- the driver's gate (Decision 2, item 3) -------------------------------------

/**
 * Whether the driver may act on a subtask's lane now: null, or why not. Read
 * right before each action (a creation, an admission, a spawn, a removal, a
 * reconciliation row, a landing record, a machine job): a hold that is
 * pending, held or cannot be read; a release not compared yet (the driver
 * compares it first) or rejected; a holds directory that cannot be read
 * (run-wide). verify-exec calls it before each machine job's start (P11).
 */
export function holdGate({ mainRoot, macroId, subtaskId }) {
  const ids = listRecordIds(mainRoot, macroId, 'holds');
  if (ids.state === 'unreadable') return `the holds of ${macroId} cannot be read (${ids.error})`;
  if (!ids.ids.includes(subtaskId)) return null;
  const st = holdStateOf(mainRoot, macroId, subtaskId);
  const id = st.hold?.record?.hold_id;
  switch (st.state) {
    case 'pending': return `subtask ${subtaskId} is held (hold ${id}, its handoff pending)`;
    case 'held': return `subtask ${subtaskId} is held (hold ${id})`;
    case 'unreadable': return `subtask ${subtaskId}'s hold records cannot be read (${st.hold?.error ?? st.release?.error ?? st.why})`;
    case 'released-uncompared': return `subtask ${subtaskId}'s release (hold ${id}) is not compared yet`;
    case 'rejected': return `subtask ${subtaskId}'s release (hold ${id}) was rejected: the lane changed after its release`;
    default: return null;
  }
}

// --- /orchestrator:next (Decision 2, item 5; N4) --------------------------------

/**
 * Why `/orchestrator:next` may not dispatch a subtask by hand, with its exit:
 * a hold that is pending, held or cannot be read, a release no run has
 * compared yet or one rejected, a holds directory that cannot be read, and an
 * open persona operation in the lane (other than `ownOperationId`, the
 * dispatch's own mark). `{ active: false }` when the macro's holds are not on
 * (nothing new then); else `{ active: true, why }`, `why` null when it may.
 * A plan id that is no hold key (the plan takes any string; `hold` takes only
 * those) is as a macro whose holds are off: no hold record is kept for it,
 * and the persona opens no operation for it (N4).
 */
export function handDispatchRefusal({ mainRoot, macroId, subtaskId, branch, stateRoots, ownOperationId = null }) {
  if (!isSafeSubtaskId(subtaskId)) return { active: false, why: null };
  const a = readActivation(mainRoot, macroId);
  if (a.state === 'inactive') return { active: false, why: null };
  if (a.state === 'unreadable') {
    return { active: true, why: `the holds directory of ${macroId} cannot be read (${a.error}), so whether subtask ${subtaskId} is held cannot be told` };
  }
  const gate = holdGate({ mainRoot, macroId, subtaskId });
  if (gate) {
    const st = holdStateOf(mainRoot, macroId, subtaskId);
    const id = st.hold?.record?.hold_id;
    const exit = {
      pending: `the owner gives it back with agentic-autopilot release ${subtaskId} --macro ${macroId} --hold ${id}`,
      held: `the owner gives it back with agentic-autopilot release ${subtaskId} --macro ${macroId} --hold ${id}`,
      'released-uncompared': 'a run compares the release before it steps the lane, and dispatches the subtask once it is ready: launch /orchestrator:autopilot',
      rejected: 'hold it and release it again once the lane is as it should be',
      unreadable: `agentic-autopilot release ${subtaskId} --macro ${macroId} --discard-unreadable keeps a copy and replaces it`,
    }[st.state];
    return { active: true, why: exit ? `${gate}; ${exit}` : gate };
  }
  const open = laneOperations({ mainRoot, macroId, subtaskId, branch, stateRoots }).filter((o) => o.id !== ownOperationId);
  if (open.length) {
    return {
      active: true,
      why: `a persona operation is open in subtask ${subtaskId}'s lane: ${describeOperations(open)}; wait for it to end, or, when its session is gone, ` +
        `have the owner clear it (agentic-autopilot writer-clear ${subtaskId} --macro ${macroId} --operation <id>)`,
    };
  }
  return { active: true, why: null };
}

// The operations open in a subtask's lane: the records under `ops/<subtask>/`
// and the entries of every child linked to it on its branch, active or
// archived (an archived child's entry outlives its file's move, and a commit's
// stays open through its archive). One rule for every reader of the lane: the
// dispatch's gate and mark, the re-attach's handover, retirement, a close and
// a rebinding. A cleared one is not open; a workflow, or an archive, that
// cannot be read counts open.
function laneOperations({ mainRoot, macroId, subtaskId, branch, stateRoots }) {
  const wf = branchWorkflows({ stateRoots, branch, macroId, subtaskId });
  const seen = new Map();
  for (const childPath of wf.linked.length ? wf.linked : [null]) {
    for (const o of openOperations({ mainRoot, macroId, subtaskId, childPath }).open) if (!seen.has(o.id)) seen.set(o.id, o);
  }
  for (const u of wf.unreadable) seen.set(`(${u.file})`, { id: '(workflow)', kind: null, from: 'entry', error: u.error });
  const cleared = new Set(readOps(mainRoot, macroId, subtaskId).ops.filter((o) => o.cleared).map((o) => o.id));
  const c = childEntries({ macroId, subtaskId, branch, stateRoots });
  const named = new Set(wf.unreadable.map((u) => u.file));
  const more = c.files.filter((f) => !named.has(f));
  if (c.unreadable && more.length) {
    seen.set('(child)', { id: '(child)', kind: null, from: 'entry', error: `a workflow that may be a child of subtask ${subtaskId} cannot be read (${more.join(', ')})` });
  }
  for (const id of c.ids) if (!cleared.has(id) && !seen.has(id)) seen.set(id, { id, kind: null, from: 'entry' });
  return [...seen.values()];
}

/**
 * The dispatch's mark (N4): before `/orchestrator:next` switches, under the
 * holds lock, judge the subtask as `handDispatchRefusal` does and publish the
 * operation record (kind `verb`, no child yet) its engineer's bootstrap
 * continues under the exported id (AGENTIC_OPERATION_ID). A hold set after it
 * waits for the dispatch to end (its handoff sees the operation open). Then
 * look again: a persona first write that published meanwhile withdraws the
 * mark and refuses. `mark: false` (a re-attach, whose engineer opens its own
 * operation) judges only. `keep(mark)` records the result before the record
 * is published, so a crash leaves the caller a mark it can withdraw.
 * `{ active: false, operationId: null }` when the holds are not on (no mark,
 * and no holds directory made: Phase 4 refuses holds that turned on since);
 * else `{ active: true, operationId }`; a refusal throws `HoldRefusal`.
 * `hooks.afterPublish` (tests) runs between the publication and the look.
 */
export async function publishDispatchMark({
  mainRoot, macroId, subtaskId, branch, stateRoots, host = null, mark = true, keep = () => {}, now = new Date(), hooks = {},
}) {
  // A plan id that is no hold key has no mark (handDispatchRefusal).
  if (!isSafeSubtaskId(subtaskId) || readActivation(mainRoot, macroId).state === 'inactive') {
    const result = { active: false, operationId: null };
    keep(result);
    return result;
  }
  return withHoldsLock(mainRoot, macroId, async () => {
    const gate = handDispatchRefusal({ mainRoot, macroId, subtaskId, branch, stateRoots });
    if (gate.active && gate.why) throw new HoldRefusal(gate.why, 'held');
    if (!gate.active || !mark) {
      const result = { active: gate.active, operationId: null };
      keep(result);
      return result;
    }
    const id = newOperationId(now);
    keep({ active: true, operationId: id });
    publishOpRecord(mainRoot, macroId, subtaskId, {
      operation_id: id, kind: 'verb', macro_id: macroId, subtask_id: subtaskId, branch, workflow_id: null, persona: 'orchestrator',
      host, opened_at: now.toISOString().replace(/\.\d+Z$/, 'Z'), dispatched_by: 'orchestrator:next',
    });
    if (hooks.afterPublish) await hooks.afterPublish(id);
    const others = laneOperations({ mainRoot, macroId, subtaskId, branch, stateRoots }).filter((o) => o.id !== id);
    if (others.length) {
      removeOpRecord(mainRoot, macroId, subtaskId, id);
      throw new HoldRefusal(`a persona operation is open in subtask ${subtaskId}'s lane: ${describeOperations(others)}`, 'operation-open');
    }
    return { active: true, operationId: id };
  });
}

/**
 * Every exit of `/orchestrator:next` after its mark was published: remove the
 * mark unless a child linked to the subtask carries its id (its engineer's
 * bootstrap took it over, and its last write removes it). `{ state:
 * 'withdrawn' | 'carried' | 'gone' }`.
 */
export async function withdrawDispatchMark({ mainRoot, macroId, subtaskId, branch, stateRoots, operationId }) {
  return withHoldsLock(mainRoot, macroId, () => {
    const ops = readOps(mainRoot, macroId, subtaskId);
    if (!ops.ops.some((o) => o.id === operationId && (o.record !== null || o.error !== undefined))) return { state: 'gone' };
    const carried = childEntries({ macroId, subtaskId, branch, stateRoots });
    // A child that cannot be read may carry it: the mark stays, for the owner.
    if (carried.unreadable || carried.ids.has(operationId)) return { state: 'carried' };
    removeOpRecord(mainRoot, macroId, subtaskId, operationId);
    return { state: 'withdrawn' };
  });
}

/**
 * The operation ids the children linked to a subtask carry, active ones on
 * its branch and archived ones alike (a verb's entry can outlive its last
 * write, and the Stop hook archives the file it is on): `{ ids, unreadable }`,
 * `unreadable` when one of them, or a directory of them, cannot be read: an
 * archived workflow that cannot be read may be one of them (its linkage
 * cannot be told), so it counts, named in `files`.
 */
export function childEntries({ macroId, subtaskId, branch, stateRoots }) {
  const ids = new Set();
  let unreadable = false;
  const files = [];
  const wf = branchWorkflows({ stateRoots, branch, macroId, subtaskId });
  if (wf.unreadable.length) unreadable = true;
  for (const u of wf.unreadable) files.push(u.file);
  const scan = [...wf.linked];
  for (const root of stateRoots) {
    for (const home of PERSONA_HOMES) {
      const dir = path.join(root, home, 'archive');
      let names = [];
      try { names = fs.readdirSync(dir); } catch (err) { if (err.code !== 'ENOENT') { unreadable = true; files.push(dir); } continue; }
      for (const n of names) if (n.endsWith('.md')) scan.push(path.join(dir, n));
    }
  }
  for (const file of scan) {
    const facts = readWorkflowFacts(file);
    if (facts.state === 'absent') continue;
    if (facts.state !== 'ok') { unreadable = true; files.push(file); continue; }
    if (facts.fields.parent_workflow !== macroId || facts.fields.originating_subtask !== subtaskId) continue;
    const decoded = decodePersonaOperations(facts.fields.persona_operations);
    if (decoded.state === 'unreadable') { unreadable = true; files.push(file); }
    for (const o of decoded.ops) ids.add(o.id);
  }
  return { ids, unreadable, files };
}

/**
 * Phase 4's check, from the second prelude on (after one passed): whether the
 * dispatch has handed the lane to its engineer — a linked child carries the
 * mark's id (a bootstrap), or, with no mark (a re-attach, or a macro whose
 * holds were off at the switch), an operation the owner has not cleared that
 * was not there when the check passed (`seen`, its ids then): the engineer's,
 * begun since.
 */
export function dispatchHandedOver({ mainRoot, macroId, subtaskId, branch, stateRoots, operationId, seen = [] }) {
  if (!isSafeSubtaskId(subtaskId)) return false;
  const { ids } = childEntries({ macroId, subtaskId, branch, stateRoots });
  if (operationId) return ids.has(operationId);
  const before = new Set(seen);
  const cleared = new Set(readOps(mainRoot, macroId, subtaskId).ops.filter((o) => o.cleared).map((o) => o.id));
  return [...ids].some((id) => !cleared.has(id) && !before.has(id));
}

/** The operation ids the children linked to a subtask carry now (`childEntries`), for `dispatchHandedOver`'s `seen`. */
export function childOperationIds({ macroId, subtaskId, branch, stateRoots }) {
  return [...childEntries({ macroId, subtaskId, branch, stateRoots }).ids];
}

/**
 * Whether the dispatch's own mark is still a record the engineer's bootstrap
 * can continue: there, readable, not cleared, of kind `verb` for this
 * subtask and no child yet. null, or why not.
 */
export function markProblem({ mainRoot, macroId, subtaskId, operationId }) {
  const own = readOps(mainRoot, macroId, subtaskId).ops.find((o) => o.id === operationId);
  if (!own || (own.record === null && own.error === undefined)) return `the dispatch's mark ${operationId} is gone`;
  if (own.error) return `the dispatch's mark ${operationId} cannot be read (${own.error})`;
  if (own.cleared) return `the dispatch's mark ${operationId} was cleared by the owner`;
  const r = own.record;
  if (r.kind !== 'verb' || (r.subtask_id ?? subtaskId) !== subtaskId || r.workflow_id != null) return `the dispatch's mark ${operationId} is not a dispatch's record`;
  return null;
}

// --- retirement, orphaning and a macro's end (Decision 2, item 8; I3) ------------

const sameDir = (a, b) => {
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  return real(a) === real(b);
};

/**
 * The lane of a subtask's branch, as a hold records it and an orphaning
 * compares it (Decision 2, item 8): the worktree that has the branch checked
 * out; null when that is the main checkout (a hand dispatch's: the driver's
 * own checkout, whose worktree lock its run holds, is no lane a fence may
 * close, so such a hold is unfenced); undefined when no worktree has it.
 */
export function branchLane(mainRoot, branch) {
  const w = typeof branch === 'string' && branch !== '' ? worktreeHoldingBranch(mainRoot, branch) : null;
  if (w === null) return undefined;
  return sameDir(w, mainRoot) ? null : w;
}

/**
 * Every persona operation open in a subtask's lane (Decision 2, item 7; N4):
 * the records under `ops/<subtask>/`, the entries of every child linked to it
 * on `branch`, active or archived (an entry-only operation begun before the
 * holds turned on included, and a commit's, open through its archive), and
 * those of the child the hold names. A cleared one is not open; what cannot be
 * read counts open. `exceptIds` are the caller's own exclusion records.
 */
function laneOpen({ mainRoot, macroId, subtaskId, branch, hold = null, stateRoots, exceptIds = [] }) {
  const open = new Map();
  const add = (o) => { if (!exceptIds.includes(o.id) && !open.has(o.id)) open.set(o.id, o); };
  if (typeof branch === 'string') for (const o of laneOperations({ mainRoot, macroId, subtaskId, branch, stateRoots })) add(o);
  const childPath = hold ? laneOf({ hold, stateRoots, macroId }).childPath : null;
  for (const o of openOperations({ mainRoot, macroId, subtaskId, childPath }).open) add(o);
  return [...open.values()];
}

/**
 * P2 for the orchestrator's own writers beyond a release and a comparison: an
 * exclusive operation record of `kind` (`retire`, `cutover`) in the lane, so a
 * persona operation's first write refuses beside it (N4, "whoever opened
 * it"), swept like theirs once its process is gone. Resolves to its id.
 */
async function publishExclusion({ mainRoot, macroId, subtaskId, kind }) {
  const id = newOperationId();
  publishOpRecord(mainRoot, macroId, subtaskId, {
    operation_id: id, kind, subtask_id: subtaskId, workflow_id: null, persona: 'orchestrator',
    host: null, opened_at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), pid: process.pid, fingerprint: await processFingerprint(process.pid),
  });
  return id;
}

/**
 * What keeps a subtask's retirement waiting (Decision 2, item 8): a persona
 * operation still open in the lane, or a process of a run still living there.
 * `exceptRun` is the caller's own run (a worker of it records the lane done).
 * `[why]`, empty when none.
 */
async function retirementBlockers({ mainRoot, macroId, subtaskId, branch, hold, stateRoots, probe, exceptRun, exceptIds = [] }) {
  const out = [];
  const open = laneOpen({ mainRoot, macroId, subtaskId, branch, hold, stateRoots, exceptIds });
  if (open.length) out.push(`a persona operation is open in the lane: ${describeOperations(open)}`);
  const b = await laneBusy(mainRoot, macroId, subtaskId, { ...(probe ? { probe } : {}), exceptRun });
  if (b.busy) out.push(b.why);
  return out;
}

/**
 * `/orchestrator:done` retires every record of the subtask it completes
 * (Decision 2, item 8): the owner's record `retired`, then its release and
 * handoff removed, its kept park ended, its fences removed (I3's order; a
 * crash leaves the owner `retired`, which never applies again, and the retry
 * finishes, its fence included). Under the holds lock, behind its own
 * exclusion record (P2), so no persona operation begins while it retires. It
 * waits while a persona operation is open in the lane or a process of a run
 * lives there: the hold applies until then (`waiting`, with why).
 * `stillCompleted()`, read under the lock, is the caller's fresh look at the
 * plan: a plan revised since it looked (the id reused, a new hold set on it)
 * retires nothing. A hold record that cannot be read is not retired
 * (`unreadable`: the owner discards it); a handoff or release that cannot be
 * read is left, and named. Nothing to retire, or no holds directory, is
 * `none`, and makes no directory. `{ state, why?, holdId?, left? }`.
 * `hooks.beforeExclusion` (tests) runs between the first look and the record.
 */
export async function retireSubtaskHolds({
  mainRoot, macroId, subtaskId, branch = null, stateRoots, probe, exceptRun = null, stillCompleted = async () => true, now = () => new Date(), hooks = {},
}) {
  // A plan id that is no hold key has no record to retire (handDispatchRefusal).
  if (!isSafeSubtaskId(subtaskId) || dirState(holdsDir(mainRoot, macroId)).state === 'absent') return { state: 'none' };
  // No record of the subtask at all: nothing to retire, and no lock taken.
  if (['holds', 'handoffs', 'releases'].every((k) => readRecord(mainRoot, macroId, k, subtaskId).state === 'absent')
    && !readKeptPark(mainRoot, macroId, subtaskId).kept) return { state: 'none' };
  return withHoldsLock(mainRoot, macroId, async () => {
    // I3 — an exclusion a crash left (a release's, a comparison's, an
    // earlier retirement's) is no writer.
    await sweepDeadExclusions({ mainRoot, macroId, subtaskId });
    if (!(await stillCompleted())) return { state: 'none', why: `the plan no longer records subtask ${subtaskId} completed` };
    const hold = readOwnerHold(mainRoot, macroId, subtaskId);
    const handoff = readRecord(mainRoot, macroId, 'handoffs', subtaskId);
    const release = readRecord(mainRoot, macroId, 'releases', subtaskId);
    const park = readKeptPark(mainRoot, macroId, subtaskId);
    const retired = hold.state === 'ok' && hold.record.state === 'retired';
    const h = hold.state === 'ok' ? hold.record : null;
    // The lane is looked at before any write: one that cannot be looked at
    // waits, as its fence's removal would read it as gone.
    let laneSeen;
    try {
      laneSeen = Boolean(h && typeof h.lane === 'string' && laneThere(h.lane));
    } catch (err) {
      if (!(err instanceof HoldRefusal)) throw err;
      return { state: 'waiting', why: err.message, holdId: h.hold_id ?? null };
    }
    const fenced = () => {
      if (laneSeen) removeSubtaskFences(h.lane, { macroId, subtaskId, keepHoldId: null });
    };
    if (!park.kept && handoff.state === 'absent' && release.state === 'absent' && (hold.state === 'absent' || retired)) {
      // I3 — a retirement a crash stopped before its fence's removal.
      if (retired) fenced();
      return { state: 'none' };
    }
    if (hold.state === 'unreadable') {
      return { state: 'unreadable', why: `the hold record of ${subtaskId} cannot be read (${hold.error}): \`agentic-autopilot release ${subtaskId} --macro ${macroId} --discard-unreadable\` keeps a copy and replaces it, and the next done retires it` };
    }
    const lane = { mainRoot, macroId, subtaskId, branch: branch ?? h?.branch ?? null, hold: h, stateRoots, probe, exceptRun };
    const before = await retirementBlockers(lane);
    if (before.length) return { state: 'waiting', why: before.join('; '), holdId: h?.hold_id ?? null };
    if (hooks.beforeExclusion) await hooks.beforeExclusion();
    const own = await publishExclusion({ mainRoot, macroId, subtaskId, kind: 'retire' });
    try {
      // Look again, as a persona first write looks: one that published
      // between the first look and this record waits for it.
      const open = laneOpen({ ...lane, exceptIds: [own] });
      if (open.length) return { state: 'waiting', why: `a persona operation is open in the lane: ${describeOperations(open)}`, holdId: h?.hold_id ?? null };
      if (h && !retired) writeWhole(hold.path, { ...h, state: 'retired', retired_at: now().toISOString() });
      const left = [];
      for (const r of [release, handoff]) {
        if (r.state === 'ok') unlinkQuiet(r.path);
        else if (r.state === 'unreadable') left.push(r.path);
      }
      if (park.kept) await removeKeptPark(mainRoot, macroId, subtaskId, { event: 'retired', fields: { by: 'retirement' } });
      fenced();
      appendHoldEvent(mainRoot, macroId, { event: 'retired', subtask_id: subtaskId, hold_id: h?.hold_id ?? null });
      return { state: 'retired', holdId: h?.hold_id ?? null, left };
    } finally {
      removeOpRecord(mainRoot, macroId, subtaskId, own);
    }
  });
}

/**
 * Why a hold no longer applies to its subtask (Decision 2, item 8), or null:
 * the subtask left the plan, the plan's branch for it differs from the one it
 * was held on, or it has a different lane (`laneNow`, a worktree path) or
 * child (`childNow`, a workflow id) than the hold was set on. The absence of
 * a lane or child (null), or one not known (undefined), never orphans.
 */
export function orphanReason(hold, { subtask, laneNow, childNow }) {
  const id = hold.subtask_id;
  if (!subtask) return `subtask ${id} left the plan`;
  if (subtask.branch !== hold.branch) return `the plan's branch for subtask ${id} is ${subtask.branch}, not ${hold.branch}, the branch it was held on`;
  if (typeof hold.lane === 'string' && typeof laneNow === 'string' && !sameDir(laneNow, hold.lane)) {
    return `subtask ${id}'s lane is ${laneNow} now, not ${hold.lane}, the lane it was held in`;
  }
  if (typeof hold.child === 'string' && typeof childNow === 'string' && childNow !== hold.child) {
    return `subtask ${id}'s child is ${childNow} now, not ${hold.child}, the child it was held on`;
  }
  return null;
}

/**
 * Orphan every hold of the macro that no longer applies (Decision 2, item 8),
 * and tidy what ended holds left (I3: any reader removes the records of a
 * retired or orphaned hold id, and its fence). An orphaned owner record keeps
 * its state and gains `orphaned {at, why}`, which no later plan revision
 * undoes: a hold once orphaned never applies again, even when a subtask
 * reuses the id and branch. `planNow()` is the plan, read under the holds
 * lock (a plan read before it could be older than a hold set since);
 * `subtasks` stands for it when none is given. `laneOf(subtask)` is the
 * subtask's worktree now (undefined when not known). No holds directory makes
 * none. Resolves to the holds orphaned now `[{ subtaskId, holdId, why }]`.
 */
export async function orphanStale({
  mainRoot, macroId, subtasks = [], planNow = null, stateRoots, laneOf: laneNowOf = () => undefined, now = () => new Date(),
}) {
  if (dirState(holdsDir(mainRoot, macroId)).state === 'absent') return [];
  const ids = listRecordIds(mainRoot, macroId, 'holds');
  if (ids.state !== 'ok') return [];
  return withHoldsLock(mainRoot, macroId, async () => {
    const read = planNow ? await planNow() : subtasks;
    // A plan that cannot be read now orphans nothing.
    if (!Array.isArray(read)) return [];
    const orphaned = [];
    for (const id of ids.ids) {
      const st = holdStateOf(mainRoot, macroId, id);
      if (st.state === 'none' || st.state === 'unreadable') continue;
      const hold = st.hold.record;
      if (st.state === 'retired' || st.state === 'orphaned') {
        for (const r of [st.handoff, st.release]) if (r?.state === 'ok' && r.record.hold_id === hold.hold_id) unlinkQuiet(r.path);
        // A lane that cannot be looked at keeps the fence: the owner's record
        // still names it, so a later pass removes it.
        if (typeof hold.lane === 'string' && laneSeenNow(hold.lane)) removeFence(hold.lane, hold.hold_id);
        continue;
      }
      if (!['pending', 'held', 'released-uncompared'].includes(st.state)) continue;
      const subtask = read.find((s) => s?.id === id) ?? null;
      let childNow;
      if (subtask && subtask.branch === hold.branch) {
        const wf = branchWorkflows({ stateRoots, branch: hold.branch, macroId, subtaskId: id });
        if (wf.linked.length === 1) childNow = readWorkflowFacts(wf.linked[0]).fields?.workflow_id ?? undefined;
      }
      const why = orphanReason(hold, { subtask, laneNow: subtask ? laneNowOf(subtask) : undefined, childNow });
      if (!why) continue;
      if (holdTransition(st.state, 'orphan').refused) continue;
      // A lane that cannot be looked at is not orphaned this pass: the hold
      // applies until its fence can be seen and removed.
      let laneSeen;
      if (typeof hold.lane === 'string') {
        laneSeen = laneSeenNow(hold.lane);
        if (laneSeen === null) continue;
      }
      writeWhole(st.hold.path, { ...hold, orphaned: { at: now().toISOString(), why } });
      if (laneSeen) removeSubtaskFences(hold.lane, { macroId, subtaskId: id, keepHoldId: null });
      appendHoldEvent(mainRoot, macroId, { event: 'orphaned', subtask_id: id, hold_id: hold.hold_id, why });
      orphaned.push({ subtaskId: id, holdId: hold.hold_id, why });
    }
    return orphaned;
  });
}

/**
 * A macro that ended (completed, aborted, finalized or archived) retires all
 * of its records (Decision 2, item 8). Under the holds lock and behind an
 * exclusion record in every lane (P2), so no hold, release or persona first
 * write lands while it works: every hold's fence is removed, then the holds
 * directory is renamed aside in one step, and removed. The caller has made
 * the macro's terminal write first (I3: a crash leaves the directory, which a
 * later done, status, Stop or run retires). It waits while a run of the macro
 * other than `exceptRun` lives, a persona operation is open in a lane (the
 * plan's `subtasks` and every subtask the directory names; their children,
 * active or archived, read through `stateRoots`), a lane is busy, or a hold's
 * record cannot be read (the owner discards it first: its fence and its
 * bytes would go with the directory). `{ state: 'retired' | 'waiting' |
 * 'none' | 'unreadable', why? }`. `hooks.beforeLock` (tests) runs between the
 * first look and the lock.
 */
export async function retireMacroHolds({ mainRoot, macroId, subtasks = [], stateRoots = [mainRoot], probe, exceptRun = null, hooks = {} }) {
  const dir = holdsDir(mainRoot, macroId);
  const d = dirState(dir);
  if (d.state === 'absent') return { state: 'none' };
  if (d.state === 'unreadable') return { state: 'unreadable', why: d.error };
  const lanes = () => {
    const ids = new Map((Array.isArray(subtasks) ? subtasks : []).filter((s) => isSafeSubtaskId(s?.id)).map((s) => [s.id, s.branch ?? null]));
    for (const kind of ['holds', 'handoffs', 'releases', 'parks']) for (const id of listRecordIds(mainRoot, macroId, kind).ids) if (!ids.has(id)) ids.set(id, null);
    const o = dirState(path.join(dir, 'ops'));
    for (const n of o.names ?? []) if (isSafeSubtaskId(n) && !ids.has(n)) ids.set(n, null);
    return ids;
  };
  const blockers = async (own = new Map()) => {
    const out = [];
    const live = await liveRuns(mainRoot, macroId, probe ? { probe } : {});
    const others = live.runs.filter((r) => r.run_id === null || r.run_id !== exceptRun);
    if (others.length) out.push(live.why);
    for (const kind of ['holds', 'handoffs', 'releases']) {
      const l = listRecordIds(mainRoot, macroId, kind);
      if (l.state === 'unreadable') out.push(`the ${kind} of ${macroId} cannot be read (${l.error})`);
    }
    for (const [id, planBranch] of lanes()) {
      const h = readOwnerHold(mainRoot, macroId, id);
      for (const r of [h, readRecord(mainRoot, macroId, 'handoffs', id), readRecord(mainRoot, macroId, 'releases', id)]) {
        if (r.state === 'unreadable') out.push(`${r.path} cannot be read (${r.error}): \`agentic-autopilot release ${id} --macro ${macroId} --discard-unreadable\` keeps a copy first`);
      }
      const hold = h.state === 'ok' ? h.record : null;
      const open = laneOpen({ mainRoot, macroId, subtaskId: id, branch: planBranch ?? hold?.branch ?? null, hold, stateRoots, exceptIds: own.has(id) ? [own.get(id)] : [] });
      if (open.length) out.push(`a persona operation is open in subtask ${id}'s lane: ${describeOperations(open)}`);
      const b = await laneBusy(mainRoot, macroId, id, { ...(probe ? { probe } : {}), exceptRun });
      if (b.busy) out.push(b.why);
    }
    return out;
  };
  // I3 — an exclusion a crash left (a retirement's, a move's, a release's)
  // is no writer: swept before the first look, which would count it open.
  await withHoldsLock(mainRoot, macroId, async () => {
    for (const id of lanes().keys()) await sweepDeadExclusions({ mainRoot, macroId, subtaskId: id });
  });
  const before = await blockers();
  if (before.length) return { state: 'waiting', why: before.join('; ') };
  const aside = path.join(holdsRoot(mainRoot), `.retired-${macroId}-${randomBytes(4).toString('hex')}`);
  if (hooks.beforeLock) await hooks.beforeLock();
  const result = await withHoldsLock(mainRoot, macroId, async () => {
    const own = new Map();
    let moved = false;
    try {
      for (const id of lanes().keys()) {
        await sweepDeadExclusions({ mainRoot, macroId, subtaskId: id });
        own.set(id, await publishExclusion({ mainRoot, macroId, subtaskId: id, kind: 'retire' }));
      }
      const again = await blockers(own);
      if (again.length) return { state: 'waiting', why: again.join('; ') };
      // Every lane is looked at before any fence goes: one that cannot be
      // looked at waits, as the directory's move would leave its fence
      // named by nothing.
      const fenced = [];
      for (const id of listRecordIds(mainRoot, macroId, 'holds').ids) {
        const h = readOwnerHold(mainRoot, macroId, id);
        if (h.state !== 'ok' || typeof h.record.lane !== 'string') continue;
        try {
          if (laneThere(h.record.lane)) fenced.push([id, h.record.lane]);
        } catch (err) {
          if (!(err instanceof HoldRefusal)) throw err;
          return { state: 'waiting', why: `subtask ${id}: ${err.message}` };
        }
      }
      for (const [id, l] of fenced) removeSubtaskFences(l, { macroId, subtaskId: id, keepHoldId: null });
      // Renamed while the lock is held: no hold or release lands between the
      // last look and the directory's going, and a persona first write meets
      // either this exclusion or no holds at all (inactive).
      try {
        fs.renameSync(dir, aside);
      } catch (err) {
        if (err.code === 'ENOENT') return { state: 'none' };
        throw err;
      }
      moved = true;
      return { state: 'retired' };
    } finally {
      if (!moved) for (const [id, op] of own) removeOpRecord(mainRoot, macroId, id, op);
    }
  });
  if (result.state === 'retired') fs.rmSync(aside, { recursive: true, force: true });
  return result;
}

/**
 * The macros under the holds root whose holds outlived them (I3, a macro's
 * end): ids for which `ended(id)` answers true. Names that are no macro id
 * (a directory renamed aside included) are passed over.
 */
export function endedMacroHolds(mainRoot, ended) {
  const d = dirState(holdsRoot(mainRoot));
  if (d.state !== 'ok') return [];
  return d.names.filter((n) => isSafeMacroId(n) && ended(n));
}

/**
 * Decision 2, item 7 — every command that writes a macro's child is a persona
 * operation under the writer exclusion or refuses in a held lane: the
 * orchestrator's own writers of a child (`cutover --move` and its rollback,
 * which move its file, active or archived) refuse while the child's subtask
 * is held (pending, held, or a hold record that cannot be read) or a persona
 * operation is open on it, and while the macro's holds cannot be read. null,
 * or why. A child of no macro, or of a macro whose holds are off, is never
 * refused.
 */
export function childWriteRefusal({ mainRoot, childPath, exceptIds = [] }) {
  const facts = readWorkflowFacts(childPath);
  if (facts.state === 'absent') return null;
  if (facts.state !== 'ok') return `${childPath} cannot be read (${facts.error}), so whether its lane is held cannot be told`;
  const { parent_workflow: macroId, originating_subtask: subtaskId, branch, workflow_id: workflowId } = facts.fields;
  if (!isSafeMacroId(macroId) || !isSafeSubtaskId(subtaskId)) return null;
  const a = readActivation(mainRoot, macroId);
  if (a.state === 'inactive') return null;
  if (a.state === 'unreadable') return `the holds of ${macroId} cannot be read (${a.error}), so whether ${workflowId ?? childPath}'s lane is held cannot be told`;
  const applies = holdApplies(readOwnerHold(mainRoot, macroId, subtaskId), { branch, workflowId: workflowId ?? null });
  if (applies.applies) {
    return `${workflowId ?? childPath} is the child of subtask ${subtaskId} of ${macroId}, which is held (${applies.why}): release it first`;
  }
  const open = openOperations({ mainRoot, macroId, subtaskId, childPath }).open.filter((o) => !exceptIds.includes(o.id));
  if (open.length) return `a persona operation is open on ${workflowId ?? childPath} (subtask ${subtaskId} of ${macroId}): ${describeOperations(open)}`;
  return null;
}

/**
 * The cutover's move of a macro's child, held to item 7 (P2): under the holds
 * lock, judge the child (`childWriteRefusal`), publish an exclusion record in
 * its lane, and judge it again beside that record, so a persona first write
 * that publishes meanwhile, or the one that comes after, refuses, and a hold
 * set meanwhile stays pending until the move ends (its handoff sees the
 * record open). Resolves to a function that withdraws the record; throws
 * `HoldRefusal` with the refusal. A child of no macro, or of a macro whose
 * holds are off, needs nothing.
 */
/**
 * I3 — the exclusions a crash left in a macro child's lane (an earlier
 * move's, a release's) are no writers: swept, under the holds lock, before a
 * writer of the child first looks (`childWriteRefusal` would count them
 * open). Nothing for a child of no macro, or of one whose holds are not on.
 */
export async function sweepChildExclusions({ mainRoot, childPath }) {
  const facts = readWorkflowFacts(childPath);
  const macroId = facts.fields?.parent_workflow;
  const subtaskId = facts.fields?.originating_subtask;
  if (!isSafeMacroId(macroId) || !isSafeSubtaskId(subtaskId) || readActivation(mainRoot, macroId).state !== 'active') return [];
  return withHoldsLock(mainRoot, macroId, () => sweepDeadExclusions({ mainRoot, macroId, subtaskId }));
}

export async function excludeChildWriters({ mainRoot, childPath }) {
  const facts = readWorkflowFacts(childPath);
  const macroId = facts.fields?.parent_workflow;
  const subtaskId = facts.fields?.originating_subtask;
  const guarded = isSafeMacroId(macroId) && isSafeSubtaskId(subtaskId) && readActivation(mainRoot, macroId).state !== 'inactive';
  await sweepChildExclusions({ mainRoot, childPath });
  const first = childWriteRefusal({ mainRoot, childPath });
  if (first) throw new HoldRefusal(first, 'held-lane');
  if (!guarded) return () => {};
  return withHoldsLock(mainRoot, macroId, async () => {
    await sweepDeadExclusions({ mainRoot, macroId, subtaskId });
    const own = await publishExclusion({ mainRoot, macroId, subtaskId, kind: 'cutover' });
    const again = childWriteRefusal({ mainRoot, childPath, exceptIds: [own] });
    if (again) {
      removeOpRecord(mainRoot, macroId, subtaskId, own);
      throw new HoldRefusal(again, 'held-lane');
    }
    return () => removeOpRecord(mainRoot, macroId, subtaskId, own);
  });
}

/**
 * `/orchestrator:abort` and `finalize` check the holds before their first
 * bulk status write (Decision 2, item 8): they stop while a persona operation
 * is open in a lane of the macro or a lane is busy, and while the holds cannot
 * be read. `subtasks` the plan; the lanes looked at are every subtask's of
 * the plan and every subtask the holds directory names. `exceptRun` names the
 * caller's own run (an autopilot worker running the close), whose worker is
 * the caller itself, as retirement's does. `{ active, why: [] }` — `active`
 * false when the macro's holds are off (nothing new then).
 */
export async function closeRefusals({ mainRoot, macroId, subtasks, stateRoots, probe, exceptRun = null }) {
  const a = readActivation(mainRoot, macroId);
  if (a.state === 'inactive') return { active: false, why: [] };
  if (a.state === 'unreadable') return { active: true, why: [`the holds directory of ${macroId} cannot be read (${a.error})`] };
  const why = [];
  const plan = Array.isArray(subtasks) ? subtasks : [];
  const ids = new Map(plan.filter((s) => isSafeSubtaskId(s?.id)).map((s) => [s.id, s.branch ?? null]));
  // Every record kind the macro's end retires (retireMacroHolds): one it
  // would refuse on refuses the close before its first bulk write (I7).
  for (const kind of ['holds', 'handoffs', 'releases', 'parks']) {
    const l = listRecordIds(mainRoot, macroId, kind);
    if (l.state === 'unreadable') why.push(`the ${kind} of ${macroId} cannot be read (${l.error})`);
    for (const id of l.ids) if (!ids.has(id)) ids.set(id, null);
  }
  const o = dirState(path.join(holdsDir(mainRoot, macroId), 'ops'));
  if (o.state === 'unreadable') why.push(`the operation records of ${macroId} cannot be read (${o.error})`);
  for (const n of o.names ?? []) if (isSafeSubtaskId(n) && !ids.has(n)) ids.set(n, null);
  for (const [id, planBranch] of ids) {
    const h = readOwnerHold(mainRoot, macroId, id);
    if (h.state === 'unreadable') why.push(`subtask ${id}'s hold record cannot be read (${h.error}): \`agentic-autopilot release ${id} --macro ${macroId} --discard-unreadable\` keeps a copy and replaces it`);
    for (const [what, r] of [['handoff', readRecord(mainRoot, macroId, 'handoffs', id)], ['release', readRecord(mainRoot, macroId, 'releases', id)]]) {
      if (r.state === 'unreadable') why.push(`subtask ${id}'s ${what} record cannot be read (${r.error}): \`agentic-autopilot release ${id} --macro ${macroId} --discard-unreadable\` keeps a copy and replaces it`);
    }
    const hold = h.state === 'ok' ? h.record : null;
    const open = laneOpen({ mainRoot, macroId, subtaskId: id, branch: planBranch ?? hold?.branch ?? null, hold, stateRoots });
    if (open.length) {
      why.push(`a persona operation is open in subtask ${id}'s lane: ${describeOperations(open)}; wait for it to end, or, when its session is gone, ` +
        `have the owner clear it (agentic-autopilot writer-clear ${id} --macro ${macroId} --operation <id>)`);
    }
    const b = await laneBusy(mainRoot, macroId, id, { ...(probe ? { probe } : {}), exceptRun });
    if (b.busy) why.push(`subtask ${id}'s lane is busy: ${b.why}`);
  }
  return { active: true, why };
}

// --- a rebinding (Decision 8, item 3; I8) ----------------------------------------

/**
 * What keeps an approval from recording or changing a rebinding of a
 * subtask, or a note to its child, and a delivery from completing (Decision
 * 8, item 3): a hold of it that is pending, held or cannot be read; a release
 * of it awaiting its comparison, whose content digest the note would change;
 * a persona operation open in its lane (`laneOpen`, on `branch`, the plan's;
 * checked whether the holds are on or not, since a persona writes its entries
 * either way), and the entries of `childPaths`, the child files the rebinding
 * found, read directly (a legacy workflow home, which the lane scan does not
 * list, included). A holds directory or marker that cannot be read refuses. A
 * retired, consumed, rejected, withdrawn or orphaned hold, a kept park and
 * another subtask's records do not. A plan id that is no hold key (the plan
 * takes any string; `hold` takes only those) has nothing to read: no hold
 * record is kept for it, and the persona opens no operation for it (N4).
 * Read-only: no lock taken, nothing repaired or created, since an approval
 * calls it holding the macro's file lock. `[why]`, empty when none.
 */
export function rebindRefusals({ mainRoot, macroId, subtaskId, branch = null, stateRoots, childPaths = [] }) {
  if (!isSafeSubtaskId(subtaskId)) return [];
  const childOpen = () => {
    const open = [];
    for (const file of childPaths) {
      const facts = readWorkflowFacts(file);
      if (facts.state === 'unreadable') open.push({ id: '(child)', kind: null, from: 'entry', error: facts.error });
      if (facts.state !== 'ok') continue;
      const decoded = decodePersonaOperations(facts.fields.persona_operations);
      if (decoded.state === 'unreadable') open.push({ id: '(child)', kind: null, from: 'entry', error: decoded.error });
      for (const o of decoded.ops) open.push({ id: o.id, kind: o.kind, from: 'entry' });
    }
    return open;
  };
  const a = readActivation(mainRoot, macroId);
  if (a.state === 'unreadable') {
    return [`the holds directory of ${macroId} cannot be read (${a.error}), so whether subtask ${subtaskId} is held cannot be told`];
  }
  const why = [];
  const st = holdStateOf(mainRoot, macroId, subtaskId);
  const id = st.hold?.record?.hold_id;
  const release = `agentic-autopilot release ${subtaskId} --macro ${macroId} --hold ${id}`;
  switch (st.state) {
    case 'pending': why.push(`subtask ${subtaskId} is held (hold ${id}, its handoff pending); the owner gives it back with ${release}`); break;
    case 'held': why.push(`subtask ${subtaskId} is held (hold ${id}); the owner gives it back with ${release}`); break;
    case 'unreadable':
      why.push(`subtask ${subtaskId}'s hold records cannot be read (${st.hold?.error ?? st.why ?? st.release?.error ?? st.handoff?.error}); ` +
        `agentic-autopilot release ${subtaskId} --macro ${macroId} --discard-unreadable keeps a copy and replaces it`);
      break;
    case 'released-uncompared':
      why.push(`subtask ${subtaskId}'s release (hold ${id}) awaits its comparison, whose digest the note would change; a run compares it ` +
        'before it steps the lane: launch /orchestrator:autopilot, then approve once it is compared');
      break;
    default: break;
  }
  const hold = st.hold?.state === 'ok' ? st.hold.record : null;
  const open = laneOpen({ mainRoot, macroId, subtaskId, branch: branch ?? hold?.branch ?? null, hold, stateRoots });
  const cleared = new Set(readOps(mainRoot, macroId, subtaskId).ops.filter((o) => o.cleared).map((o) => o.id));
  for (const o of childOpen()) if (!cleared.has(o.id) && !open.some((x) => x.id === o.id)) open.push(o);
  if (open.length) {
    why.push(`a persona operation is open in subtask ${subtaskId}'s lane: ${describeOperations(open)}; wait for it to end, or, when its ` +
      `session is gone, have the owner clear it (agentic-autopilot writer-clear ${subtaskId} --macro ${macroId} --operation <id>)`);
  }
  return why;
}

/**
 * Withdraw a hold `hold` just published, before any handoff (a run that does
 * not honour holds started between its two looks): its owner record goes,
 * only while it is that hold and still unhanded, and the release it was set
 * over, if any, comes back (`restorePrior`).
 */
export async function withdrawUnhandedHold({ mainRoot, macroId, subtaskId, holdId, hooks = {} }) {
  return withHoldsLock(mainRoot, macroId, () => {
    const st = holdStateOf(mainRoot, macroId, subtaskId);
    if (st.state !== 'pending' || st.hold.record.hold_id !== holdId) return false;
    // Its fence, should a handoff have written one, goes while its record
    // still names it (releaseHold's withdrawal).
    // A lane that cannot be looked at refuses the withdrawal before any write.
    const l = st.hold.record.lane;
    if (typeof l === 'string' && laneThere(l)) removeFence(l, holdId);
    if (hooks.beforeRestore) hooks.beforeRestore();
    if (restorePrior({ mainRoot, macroId, subtaskId, hold: st.hold.record, hooks })) return true;
    unlinkQuiet(st.hold.path);
    return true;
  });
}
