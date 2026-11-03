// adapters/claude/autopilot/instruct-boundary.mjs — ADR-0068 Decision 7,
// item 3: a live run applies a lane's pending instructions when it next looks
// at the lane, before it chooses the lane's next step, never mid-step.
//
// The driver asks `instructionsDue` of the macro it looked at; for a lane with
// an instruction pending it runs the pinned orchestrator's `state.mjs
// instruct-apply` for that subtask as a worker group of the run (its id and
// secret, so the admission the command joins passes on the run's own lock),
// started idle (`--await-start`) and put on the run's locks before it begins,
// as rebind-boundary.mjs runs a note's writer (runHeld). Then it decides again
// from a fresh look: the child's next step is the instruction's, and its
// fingerprint changed, so a parked lane is reconsidered (Decision 1, item 4).
// The engineer append the command runs is outside the run's step numbering
// (instruct-apply.mjs personaEnv, P9).

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { applicationHeading, childNextStep, dropCause, linkedChildren } from '../../../scripts/lib/instruct-apply.mjs';
import { repositoryRoots } from '../../../scripts/lib/state-root.mjs';

import { instructionsPath, laneApplicationIds, linesOutsideApplications, listInstructionIds, readEndedInstructions, readInstructions, summarizeEntry } from '../../../scripts/lib/instructions.mjs';
import { runHeld } from './rebind-boundary.mjs';
import { terminateGroup } from './worker.mjs';

/**
 * The subtasks of the view with an instruction pending (item 3), in plan
 * order: `[{ subtaskId, step }]`, `step` the last step a pending entry names,
 * or null. A record that cannot be read now is due too (`unreadable: true`,
 * step null): what it holds is not known, so the application is tried, its
 * `unreadable` result defers the lane's recorded step as any other, and the
 * lane halts for the owner if it stays so; skipped, the lane's old step would
 * run over whatever it holds. So is every open subtask of the plan (not
 * completed, deferred or abandoned) when the instructions directory itself
 * cannot be listed: which lanes have one cannot be told, and "none" would let
 * every lane's old step run. `mainRoot` is the main checkout.
 */
export function instructionsDue(mainRoot, macroId, subtasks) {
  const plan = Array.isArray(subtasks) ? subtasks : [];
  const planIds = plan.map((x) => x?.id).filter((id) => typeof id === 'string');
  const ids = listInstructionIds(mainRoot, macroId);
  if (ids.state === 'unreadable') {
    return plan.filter((x) => typeof x?.id === 'string' && !['completed', 'deferred', 'abandoned'].includes(x.status))
      .map((x) => ({ subtaskId: x.id, step: null, unreadable: true }));
  }
  if (ids.state !== 'ok' || ids.ids.length === 0) return [];
  // In plan order, then each record of a subtask the plan no longer holds,
  // which the lifecycle sweep drops (`left-plan`, item 6).
  const order = [...planIds.filter((id) => ids.ids.includes(id)), ...ids.ids.filter((id) => !planIds.includes(id))];
  const out = [];
  for (const id of order) {
    const r = readInstructions(mainRoot, macroId, id);
    if (r.state === 'unreadable') { out.push({ subtaskId: id, step: null, unreadable: true }); continue; }
    if (r.state !== 'ok') continue;
    const pending = r.record.entries.filter((e) => e.state === 'pending' || e.state === 'applying');
    if (pending.length === 0) continue;
    out.push({ subtaskId: id, step: pending.filter((e) => e.step !== null).at(-1)?.step ?? null });
  }
  return out;
}

const pendingOrApplying = (e) => e.state === 'pending' || e.state === 'applying';
const entryKey = (e) => `${e.id}:${e.revision}`;

/**
 * The pending instructions of `subtaskId` that carry a next step and still
 * apply (item 5, beside a forced step): `{ entries }`, each such entry in the
 * order written; `{ unreadable }`, the record's path, when the record cannot
 * be read (what it holds is not known, as instructionsDue counts it); or null.
 * An entry the lifecycle sweep would drop (instruct-apply.mjs dropCause: the
 * subtask left the plan or changed branch, the entry's child archived, or
 * another child took the lane) applies to nothing (item 6), so it refuses
 * nothing. An entry being applied (`applying`), and every entry while the
 * homes or the worktrees cannot all be read or two children are active, still
 * counts: which child the lane has cannot be told. `subtask` is the plan's
 * entry (undefined when gone); `stateRoots`, every root a child may be in,
 * the main checkout's worktrees when not given.
 */
export function pendingInstructionSteps(mainRoot, macroId, subtaskId, { subtask, stateRoots = null } = {}) {
  const r = readInstructions(mainRoot, macroId, subtaskId);
  if (r.state === 'unreadable') return { unreadable: r.path };
  if (r.state !== 'ok') return null;
  const steps = r.record.entries.filter((e) => pendingOrApplying(e) && e.step !== null);
  if (steps.length === 0) return null;
  let roots = stateRoots;
  if (roots === null) {
    try { roots = [...new Set([mainRoot, ...repositoryRoots(mainRoot)])]; } catch { return { entries: steps }; }
  }
  const linked = linkedChildren(roots, { macroId, subtaskId });
  const activeOnes = linked.children.filter((c) => !c.archived && (!subtask || c.branch === subtask.branch));
  if (linked.unreadable || activeOnes.length > 1) return { entries: steps };
  const active = activeOnes.length === 1 ? activeOnes[0].id : null;
  const live = steps.filter((e) => e.state === 'applying' || dropCause(e, { subtask, active, linked }) === null);
  return live.length ? { entries: live } : null;
}

/**
 * The refusal of a forced step beside `subtaskId`'s pending instructions with
 * a next step (item 5), or null: `what` names the forced step as the owner
 * wrote it (`--next <step>`, `--lane <id> --next`). Every such instruction is
 * named, so one withdrawal per name clears it.
 */
export function forcedStepRefusal(found, { what, subtaskId, macroId }) {
  if (!found) return null;
  if (found.unreadable) {
    return `${what} is refused: subtask ${subtaskId}'s instructions record ${found.unreadable} cannot be read, so whether it holds a pending next step cannot be told (ADR-0068 Decision 7, item 5). ` +
      'Repair or remove the record, or relaunch without the forced step';
  }
  const names = found.entries.map((e) => `instruction ${e.id} r${e.revision} pending with the next step ${e.step}`).join(', ');
  const withdraw = found.entries.filter((e) => e.state === 'pending')
    .map((e) => `agentic-autopilot instruct ${subtaskId} --macro ${macroId} --withdraw ${e.id}`);
  return `${what} is refused: subtask ${subtaskId} has ${names} (ADR-0068 Decision 7, item 5). ` +
    `${withdraw.length ? `Withdraw ${withdraw.length > 1 ? 'them' : 'it'} (${withdraw.join('; ')}), or relaunch` : 'Relaunch'} without the forced step`;
}

/**
 * Item 5, beside a forced step — the pending entries of every instruction
 * record of the macro as a run finds them when it takes its forced steps:
 * subtask id → Set of `<id>:<revision>`; a record that cannot be read is
 * left out. Item 3 applies these before the run acts on a lane, its forced
 * step included; an entry written or revised after this look waits for the
 * forced step (onlyLaunchPending), and is applied at the boundary after it.
 */
export function launchPending(mainRoot, macroId) {
  const out = new Map();
  const ids = listInstructionIds(mainRoot, macroId);
  if (ids.state !== 'ok') return out;
  for (const id of ids.ids) {
    const r = readInstructions(mainRoot, macroId, id);
    if (r.state === 'ok') out.set(id, new Set(r.record.entries.filter(pendingOrApplying).map(entryKey)));
  }
  return out;
}

/**
 * The entries of `subtaskId`'s record pending now that were pending, at the
 * same revision, when the run took its forced steps (`launch`,
 * launchPending's answer), as `<id>:<revision>` keys: item 3 applies these
 * before the lane's untaken forced step (the next run applies them before it
 * acts on the lane), and the application reserves only these
 * (`--only-entries`), so an entry written or revised since, before the look
 * or between the look and the reservation, stays pending for the forced step
 * (item 5). `[]` when there are none, or the record cannot be read now.
 */
export function launchEntries(mainRoot, macroId, subtaskId, launch) {
  const at = launch?.get(subtaskId);
  if (!at) return [];
  const r = readInstructions(mainRoot, macroId, subtaskId);
  if (r.state !== 'ok') return [];
  return r.record.entries.filter((e) => pendingOrApplying(e) && at.has(entryKey(e))).map(entryKey);
}

/**
 * Apply `subtaskId`'s pending instructions as a worker group of the run.
 * Resolves to `{ ok: true, result }` (the command's JSON: `state`, and for an
 * application its id, entries, step and supersessions), or `{ ok: false,
 * detail }`, with `lingering: true` when a process of the group outlived
 * SIGKILL (its locks were kept: the run drains). `hold` puts the process on
 * the run's locks (the serial run's worker, or a group of a run with lanes).
 */
export async function applyAtBoundary({ roots, macroPath, subtaskId, env, runId, token, hold = null, onLingering = null, terminate = terminateGroup, onlyEntries = null }) {
  const args = [
    path.join(roots.orchestrator, 'scripts', 'state.mjs'), 'instruct-apply', '--workflow-path', macroPath, '--host', 'claude',
    '--subtask-id', subtaskId, '--engineer-root', roots.engineer, '--by', `run ${runId}`, '--await-start',
    // Beside an untaken forced step, only the entries pending at the launch
    // (launchEntries), enforced in the reservation itself.
    ...(onlyEntries ? ['--only-entries', onlyEntries.join(',')] : []),
  ];
  const { err, stdout, stderr, lingering } = await runHeld(args, { env: { ...env, AGENTIC_AUTOPILOT: runId, AGENTIC_AUTOPILOT_TOKEN: token }, hold, terminate });
  if (lingering) {
    onLingering?.();
    return { ok: false, lingering: true, detail: `a process of the group that applied subtask ${subtaskId}'s instructions is still there after SIGKILL; the run keeps its locks until that group is empty` };
  }
  if (err) return { ok: false, detail: `subtask ${subtaskId}'s instructions could not be applied: ${String(stderr || err.message).trim().split('\n')[0]}` };
  let result = null;
  try { result = JSON.parse(stdout).instructions; } catch { result = null; }
  if (!result || typeof result.state !== 'string') return { ok: false, detail: `instruct-apply for subtask ${subtaskId} printed no result` };
  return { ok: true, result };
}

/**
 * The results that leave a lane's instructions pending for a reason that may
 * pass at its next boundary: a live applier or a child that moved (`waiting`),
 * an append the engineer refused (`failed`), a record that could not be read
 * (`unreadable`). The lane's recorded step is not run over them: the driver
 * defers it and tries the application again, at most INSTRUCT_DEFER_TRIES
 * times on a record left as it was, then halts the lane for the owner. The
 * other results (`none`, `not-at-boundary`, `inactive`, `no-child`) leave the
 * lane decided as before: its step is what the instruction waits for (an
 * interrupted commit, a dispatch), or nothing applies there at all.
 */
export const DEFER_STATES = Object.freeze(new Set(['waiting', 'failed', 'unreadable']));
export const INSTRUCT_DEFER_TRIES = 3;
/** How long a serial run waits before it tries a deferred application again. */
export const INSTRUCT_RETRY_MS = 5_000;

/**
 * The instruction records as a run with lanes watches them (item 3: one
 * written, revised or withdrawn wakes the loop within the poll). `read` is
 * the digest (instructions.mjs instructionsDigest). `poll()` reports whether
 * it changed since last seen, and takes it as seen. A pass of applications
 * calls `begin()` before it reads what is due, and the function it returns
 * once it ends: what the pass acted on is at least the digest read at its
 * start, so that one is taken as seen, and a write that lands while the pass
 * runs, after it read what was due, still wakes the loop at the next poll
 * (impl-instruct critique 7 F1). A poll during the pass that already took a
 * later digest is left as it is.
 *
 * `sincePass()` is the run's end's question (impl-instruct critique 8 F1):
 * whether the records changed since the last pass read them at its start.
 * A tick's poll may already have taken such a write as seen, and the wake it
 * queued is never read by an end that does not wait, so the end asks the
 * records themselves. It answers each change once (it takes the digest as
 * the one the end acted on), so an end that cannot run a pass is asked again
 * only after another write.
 */
export function instructionsWatch(read) {
  let seen = read();
  let passed = seen;
  return {
    begin() {
      const was = seen;
      const at = read();
      passed = at;
      return () => { if (seen === was) seen = at; };
    },
    sincePass() {
      const now = read();
      if (now === passed) return false;
      passed = now;
      return true;
    },
    poll() {
      const now = read();
      if (now === seen) return false;
      seen = now;
      return true;
    },
  };
}

/**
 * The lane's instruction record as an attempt sees it: its entries' ids,
 * revisions and states, or the read's state. Two attempts on the same key met
 * the same record.
 */
export function instructionsKey(mainRoot, macroId, subtaskId) {
  return recordKey(readInstructions(mainRoot, macroId, subtaskId));
}
const recordKey = (rec) => (rec.state === 'ok' ? JSON.stringify(rec.record.entries.map((e) => [e.id, e.revision, e.state])) : rec.state);

/**
 * Item 3 at a step's admission (impl-instruct critique 9 F1). A run applies a
 * lane's instructions in a pass before it looks, reports the landing and
 * decides; an instruction written after that pass would otherwise lose to the
 * step decided without it (a commit, which archives the child and drops the
 * instruction `child-archived`). Each driver asks, right before a step
 * starts, `untried(subtaskId, triedKey)`: whether the lane's record holds an
 * entry pending or being applied, or cannot be read (what it holds is not
 * known, as instructionsDue counts it), on a record other than `triedKey`,
 * the key (instructionsKey's) the last application attempt on the lane met.
 * Then the step yields and the run decides again after a pass, which applies
 * it, or defers the lane. It answers each record once, so a lane a pass does
 * not try costs one more turn, never a loop. The caller leaves out the lanes
 * a pass does not try (a batch open, an untaken forced step first).
 */
export function admissionRecheck(mainRoot, macroId) {
  const yielded = new Map();
  return (subtaskId, triedKey) => {
    if (typeof subtaskId !== 'string' || !macroId) return false;
    const rec = readInstructions(mainRoot, macroId, subtaskId);
    if (rec.state === 'ok' && !rec.record.entries.some(pendingOrApplying)) return false;
    if (rec.state !== 'ok' && rec.state !== 'unreadable') return false;
    const key = recordKey(rec);
    if (key === triedKey || yielded.get(subtaskId) === key) return false;
    yielded.set(subtaskId, key);
    return true;
  };
}

/**
 * Count one more deferred attempt on `deferred` (a Map: subtask id →
 * `{ key, tries }`), the count starting again when the record changed.
 * Returns the attempts made on this key.
 */
export function countDeferral(deferred, subtaskId, key) {
  const prev = deferred.get(subtaskId);
  const tries = (prev && prev.key === key ? prev.tries : 0) + 1;
  deferred.set(subtaskId, { key, tries });
  return tries;
}

/**
 * The halt detail of a lane whose instructions stayed deferred through every
 * attempt. Neither a withdrawal nor a repair changes what a kept park's
 * fingerprint reads, so a run with lanes gives the lane back only on its
 * release: the detail names it. `mainRoot` names the record's file when it
 * could not be read.
 */
export function deferredHaltDetail(subtaskId, macroId, result, tries, mainRoot = null) {
  const what = result.state === 'unreadable'
    ? `Repair or remove the record${mainRoot ? ` ${instructionsPath(mainRoot, macroId, subtaskId)}` : ''}`
    : `Resolve what keeps them, or withdraw them (agentic-autopilot status --macro ${macroId} lists them)`;
  return `subtask ${subtaskId}'s instructions stayed ${result.state} through ${tries} attempts at its boundary` +
    `${result.detail ? ` (${result.detail})` : ''}, so its recorded step was not run over them (ADR-0068 Decision 7, item 3). ` +
    `${what}; a run with lanes keeps the lane parked until its release (agentic-autopilot release ${subtaskId} --macro ${macroId}); then relaunch`;
}

/** One line for the run's output and the halt detail: what became of the lane's instructions. */
export function applicationLine(subtaskId, result) {
  const dropped = (result.dropped ?? []).map((d) => `${d.id} dropped (${d.cause})`);
  if (result.state === 'applied') {
    return `applied subtask ${subtaskId}'s instructions as ${result.applicationId}${result.effective ? ` (next ${result.effective})` : ' (notes only)'}` +
      `${result.superseded?.length ? `; superseded ${result.superseded.map((x) => `${x.id} (${x.cause})`).join(', ')}` : ''}${dropped.length ? `; ${dropped.join(', ')}` : ''}`;
  }
  return `subtask ${subtaskId}'s instructions ${result.state}${result.detail ? `: ${result.detail}` : ''}${dropped.length ? `; ${dropped.join(', ')}` : ''}`;
}

/**
 * P2 — whether the child's next step is the one an application recorded, with
 * no write to the child since (its bytes are the ones the application left):
 * then the instruction's step replaces what a verification batch would have
 * dispatched (Decision 7, item 5), and the policy's P7 guard, which resumes
 * the requesting verb over a newly written step, is passed over for it.
 */
export function instructedStep(mainRoot, macroId, subtaskId, childPath) {
  const r = readInstructions(mainRoot, macroId, subtaskId);
  if (r.state !== 'ok' || typeof childPath !== 'string') return null;
  let text;
  try { text = fs.readFileSync(childPath, 'utf8').replace(/\r\n/g, '\n'); } catch { return null; }
  const child = /^workflow_id:\s*"?([^"\n]+)"?\s*$/m.exec(text)?.[1] ?? null;
  // The latest application to this child that set a step.
  const last = (r.record.receipts ?? []).filter((x) => x.state === 'done' && x.effective_step !== null && x.child === child).at(-1);
  if (!last) return null;
  // The heading's first occurrence is the application's own: its id is
  // random and did not exist before the append, so any other occurrence is a
  // later note quoting it.
  const at = text.indexOf(`\n### ${applicationHeading(last.application_id)}\n`);
  if (at < 0) return null;
  // No worker step since: a verb's first write is its Phase 0 note, which
  // clears the step; a note-only application, a rebinding's note or a
  // snapshot after it leaves the step the instruction's.
  if (workerStepSince(text, at + 1, laneApplicationIds(r.record, child))) return null;
  if (childNextStep(text) !== last.effective_step) return null;
  return { applicationId: last.application_id, step: last.effective_step };
}

/**
 * Whether a worker's step wrote to the child `text` from offset `from` on
 * (an application's heading): a `### Phase 0` heading there, outside the
 * owner's notes (instructions.mjs linesOutsideApplications, which the gate
 * witness reads by the same rule), `applications` the lane's application ids.
 * An application's note may quote such a heading; a worker's note is read line
 * by line, so an unclosed fence in it, or its quote of another lane's heading,
 * never hides a later step's heading.
 */
export function workerStepSince(text, from = 0, applications = new Set()) {
  for (const line of linesOutsideApplications(text, from, applications)) {
    if (/^### Phase 0[: ]/.test(line)) return true;
  }
  return false;
}

/** The application a step about to start comes from (P2), or null: `s` the policy's step. */
export function stepApplication(mainRoot, macroId, s, childPath) {
  if (!s?.subtaskId || (s.kind !== 'verb' && s.kind !== 'commit')) return null;
  const ia = instructedStep(mainRoot, macroId, s.subtaskId, childPath);
  if (!ia) return null;
  const step = s.kind === 'commit' ? '/engineer:commit' : `/engineer:${s.verb}`;
  return ia.step === step ? ia.applicationId : null;
}

/**
 * Decision 7, item 8 — the event file's line for an application (events.mjs
 * kind `instruction`): codes, ids and counts, never a note; null when nothing
 * was applied or dropped. `pointer` is the run's lanes.jsonl, or its
 * steps.jsonl for a serial run.
 */
export function instructionEvent(result, pointer) {
  const dropped = (result.dropped ?? []).length;
  if (result.state !== 'applied' && dropped === 0) return null;
  return {
    action: result.state === 'applied' ? 'applied' : 'dropped',
    application_id: result.state === 'applied' ? result.applicationId : null,
    applied: result.state === 'applied' ? (result.entries ?? []).length : 0,
    superseded: (result.superseded ?? []).length,
    dropped,
    step_set: result.state === 'applied' && typeof result.effective === 'string',
    pointer,
  };
}

/**
 * ADR-0068 Decision 7, items 4 and 8 — what the step ledger records of an
 * application: codes and ids, never a note. The step the driver spawns from
 * it carries its application id (`instruction_application`), so `status`
 * says whether the step ran.
 */
export function instructionLedger(result) {
  return {
    instruction: {
      state: result.state, application_id: result.applicationId ?? null, effective: result.effective ?? null,
      entries: (result.entries ?? []).map((e) => `${e.id}:${e.revision}`),
      superseded: (result.superseded ?? []).map((x) => ({ id: x.id, cause: x.cause })),
      dropped: (result.dropped ?? []).map((d) => ({ id: d.id, cause: d.cause })),
      detail_code: result.state === 'applied' || result.state === 'none' ? null : result.state,
    },
  };
}

/**
 * Decision 7, items 4, 6 and 8 — halt.json's `instructions`: every
 * instruction of the macro with its state and what became of it (its cause,
 * the application that applied it), ids and codes only; a record that cannot
 * be read is named by its code. `[]` when the macro has none.
 */
export function instructionsSummary(mainRoot, macroId) {
  const ids = listInstructionIds(mainRoot, macroId);
  if (ids.state === 'absent') return readEndedInstructions(mainRoot, macroId) ?? [];
  if (ids.state === 'unreadable') return [{ subtask_id: null, unreadable: ids.code }];
  const out = [];
  for (const id of ids.ids) {
    const r = readInstructions(mainRoot, macroId, id);
    if (r.state === 'unreadable') { out.push({ subtask_id: id, unreadable: r.code }); continue; }
    if (r.state !== 'ok') continue;
    for (const e of r.record.entries) out.push(summarizeEntry(id, e));
  }
  return out;
}
