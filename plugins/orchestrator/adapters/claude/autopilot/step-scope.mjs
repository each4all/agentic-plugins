// plugins/orchestrator/adapters/claude/autopilot/step-scope.mjs
//
// C181 (ADR-0023 §6, amendments of 2026-11-22 and 2026-11-24) — the scope of
// an autopilot step: a cgroup the worker host makes for the claude it starts
// for a step, before that claude runs, whose kill ends what the step left
// outside the claude's process group (a mutation run it started with
// `setsid`, holding the heavy-work lock, a background task, a peer run).
//
// The worker host composes the launch primitives the peer runner uses
// (scripts/lib/scope-launch.mjs, scripts/lib/scope-reader.mjs) with an owner
// of its own, `autopilot-step` (`run`, `step`), and the driver as the scope's
// supervisor (the worker runs in the driver's process):
//
//   planStepScope   before the launch: whether the step makes a scope, and
//                   where it makes none the record that says why (no scope can
//                   be made here, or the driver itself runs inside another
//                   launcher's scope, whose kill then covers the step);
//   launchStep      the child: gated in a new scope, the identity recorded to
//                   the step's records (`recordScope`, which throws when it
//                   cannot) before the word; on a failure before the word the
//                   recorded attempt is marked abandoned, then a direct
//                   launch, or none where the mark could not be written or a
//                   cancellation came; a direct launch for a direct plan;
//   endStepScope    every end of a step, once its group's signals and their
//                   grace are done: the kill under every check, then the wait
//                   for a reading of gone up to SCOPE_EMPTY_WAIT_MS; a kill
//                   withheld or refused gets one reading. Never waits on the
//                   claude's own exit or close.
//
// Who reads the step's scope afterwards: the run locks' gate
// (scripts/lib/run-locks.mjs, a worker entry that carries a scope not read
// gone is held, whatever holderAlive says) and the dead-run cleanup
// (dead-runs.mjs). A step whose scope is not read gone is kept as a group that
// outlived SIGKILL is (`lingers`).

import { spawn } from 'node:child_process';

import { SCOPE_EMPTY_WAIT_MS, teardownOf } from '../../../scripts/lib/scope.mjs';
import {
  abandonedRecord,
  gateHandshake,
  launcherPlacement,
  noScopeRecord,
  scopeAvailability,
  scopeUnitName,
  scopedRecord,
  spawnGated,
} from '../../../scripts/lib/scope-launch.mjs';
import { SYSTEM, createScopeEnder, readScopeOnce } from '../../../scripts/lib/scope-reader.mjs';
import { associationOf } from '../../../scripts/lib/scope-run.mjs';

export const STEP_OWNER_KIND = 'autopilot-step';

// How often the end reads a killed scope while it waits for gone.
const GONE_POLL_MS = 50;

const sleep = (ms) => new Promise((resolveP) => { setTimeout(resolveP, ms); });

// The owner a step's scope records: the run and the step's seq, as a string.
export function stepOwner(runId, seq) {
  return { kind: STEP_OWNER_KIND, run: String(runId), step: String(seq) };
}

/**
 * Whether the step makes a scope (synchronous: the checks are the readers'
 * own, within SCOPE_CHECK_MS). Answers
 *   { kind: 'gated', unit, owner, association }, or
 *   { kind: 'direct', record, why }   `record` the `none` record to write,
 *                                     `why` the check that withheld a scope
 *                                     (null for an enclosing launcher's scope).
 * A scope is made only on a placement read as outside every launcher's scope
 * (`inside === false`); inside one, the record names the enclosing unit; a
 * placement that cannot be told makes none.
 */
// `checks` is a test seam: { availability, placement }, scope-launch.mjs's own.
export function planStepScope({ runId, seq, env = process.env, system = SYSTEM, checks = {} } = {}) {
  const availabilityOf = checks.availability ?? scopeAvailability;
  const placementOf = checks.placement ?? launcherPlacement;
  try {
    const availability = availabilityOf({ system });
    if (!availability.available) return { kind: 'direct', record: noScopeRecord('unavailable'), why: availability.check };
    const placement = placementOf({ system });
    if (placement.inside === true) return { kind: 'direct', record: noScopeRecord('inside-launcher', placement.enclosingUnit), why: null };
    if (placement.inside !== false) return { kind: 'direct', record: noScopeRecord('unavailable'), why: placement.withheld ?? 'placement' };
  } catch (err) {
    return { kind: 'direct', record: noScopeRecord('unavailable'), why: `check-failed: ${String(err?.message ?? err)}` };
  }
  return {
    kind: 'gated',
    unit: scopeUnitName(`${runId}-s${seq}`),
    owner: stepOwner(runId, seq),
    association: associationOf(env),
  };
}

/**
 * The step's child, through the plan. Answers
 *   { child, scoped: true, identity }       launched in its scope, the word sent;
 *   { child, scoped: false, record }        launched directly;
 *   { child: null, failure }                nothing launched: `cancelled`, or
 *                                           `scope_abandon_unwritten` (a
 *                                           recorded identity whose abandoned
 *                                           mark could not be written).
 * `recordScope(record)` writes a scope record to the step's records (the step
 * ledger and its lock entries) and throws when it cannot. A spawn that throws
 * throws, as the worker's own spawn does.
 */
export async function launchStep({
  plan, command, args, options, recordScope, signal = null, system = SYSTEM,
  spawnDirect = spawn, spawnGatedFn = spawnGated, handshake = gateHandshake, warn = () => {},
}) {
  const direct = async (record) => {
    // The `none` record grants nothing: best effort, as the peer runner's.
    try { await recordScope(record); } catch (err) { warn(`the step's scope record was not written (${String(err?.message ?? err)})`); }
    if (signal?.aborted) return { child: null, failure: 'cancelled' };
    return { child: spawnDirect(command, args, options), scoped: false, record };
  };
  if (plan?.kind !== 'gated') return direct(plan?.record ?? noScopeRecord('unavailable'));
  if (signal?.aborted) return { child: null, failure: 'cancelled' };
  const child = spawnGatedFn({ unit: plan.unit, command, args, options });
  let recordedIdentity = null;
  const answer = await handshake(child, {
    unit: plan.unit,
    owner: plan.owner,
    hasSnapshot: false,
    association: plan.association ?? null,
    system,
    signal,
    record: async (identity) => {
      recordedIdentity = identity;
      await recordScope(scopedRecord(identity));
    },
  });
  if (answer.launched) return { child, scoped: true, identity: answer.identity };
  // A failure before the word: the gate has run nothing. A record that may
  // carry the identity is marked abandoned before any other launch; a mark
  // that cannot be written launches nothing.
  if (answer.recorded) {
    try {
      if (recordedIdentity === null) throw new Error('no identity to mark');
      await recordScope(abandonedRecord(recordedIdentity));
    } catch (err) {
      warn(`the step's scoped launch failed before the word (${answer.check}) and its record could not be marked abandoned (${String(err?.message ?? err)}); nothing is launched`);
      // The records may still carry the identity: the step ends that scope,
      // and keeps them unless it reads it gone.
      return { child: null, failure: 'scope_abandon_unwritten', identity: recordedIdentity };
    }
    if (signal?.aborted) return { child: null, failure: 'cancelled' };
    warn(`the step's scoped launch failed before the word (${answer.check}); it launches as before`);
    return { child: spawnDirect(command, args, options), scoped: false, record: abandonedRecord(recordedIdentity) };
  }
  if (signal?.aborted) return { child: null, failure: 'cancelled' };
  warn(`the step's scoped launch failed before the word (${answer.check}); it launches as before`);
  return direct(noScopeRecord('unavailable'));
}

// A reading that never throws.
function readOnce(identity, system, read) {
  try {
    return read(identity, { system }) ?? { state: 'withheld', check: 'no-reading' };
  } catch {
    return { state: 'withheld', check: 'reading-failed' };
  }
}

/**
 * The end of a step's scope, once its group stop is done: the kill under every
 * check, then the wait for gone up to `waitMs`. Answers { reading, teardown }.
 * A kill read gone needs no wait; one withheld or refused gets one reading,
 * which needs no authority (a scope the manager already collected withholds
 * at the manager's check and reads gone).
 */
export async function endStepScope(identity, {
  system = SYSTEM, waitMs = SCOPE_EMPTY_WAIT_MS, ender = createScopeEnder({ system }), read = readScopeOnce, now = () => system.now(),
} = {}) {
  let reading;
  let kill;
  try {
    kill = ender.kill(identity);
  } catch {
    kill = { state: 'withheld', check: 'kill-failed' };
  }
  if (kill.state === 'gone') {
    reading = { state: 'gone', ...(kill.check ? { check: kill.check } : {}) };
  } else if (kill.state !== 'written') {
    try {
      reading = ender.read(identity);
    } catch {
      reading = { state: kill.state, check: kill.check ?? 'reading-failed' };
    }
  } else {
    const until = now() + waitMs;
    for (;;) {
      reading = readOnce(identity, system, read);
      if (reading.state === 'gone' || now() >= until) break;
      await sleep(Math.max(1, Math.min(GONE_POLL_MS, until - now())));
    }
  }
  return { reading, teardown: teardownOf(reading) };
}

/**
 * Whether a step's end leaves something the run must keep its locks, its
 * open-run record and its scratch for: a process group that outlived SIGKILL,
 * or (C181) a step scope its teardown did not read gone.
 */
export function lingers(w) {
  if (!w) return false;
  if (w.groupTeardown === 'lingering') return true;
  return w.scopeTeardown !== null && typeof w.scopeTeardown === 'object' && w.scopeTeardown.state !== 'gone';
}

// What a lingering step's halt says it waits for (policy.mjs verifyStep).
export function lingeringDetail(w) {
  if (w?.groupTeardown === 'lingering') {
    return `a process in the step's process group (${w.pgid ?? '?'}) is still there after SIGKILL; the run keeps its locks until that group is empty (ps -g ${w.pgid ?? '<pgid>'})`;
  }
  const unit = w?.scope?.identity?.unit ?? '<unit>';
  const t = w?.scopeTeardown ?? {};
  return `the step's scope ${unit} was not read gone after its kill (${t.state ?? '?'}${t.check ? `: ${t.check}` : ''}); the run keeps its locks, its open-run record and its scratch until a reader reads it gone (systemctl --user stop ${unit} ends it)`;
}

// Why a lingering step's scratch is kept (scratch.mjs release).
export function lingerReason(w) {
  return w?.groupTeardown === 'lingering' ? 'the step\'s process group outlived SIGKILL' : 'the step\'s scope was not read gone';
}
