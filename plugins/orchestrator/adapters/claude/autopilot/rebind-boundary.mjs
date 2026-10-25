// adapters/claude/autopilot/rebind-boundary.mjs — ADR-0068 Decision 8, item 4:
// a note the owner's approval recorded and did not finish telling reaches the
// child before a run starts its next step, never mid-step.
//
// The driver asks `rebindDue` of the macro it looked at, for the subtask of
// the step it decided. A child the binding writes' told check refuses is not
// stepped: the same predicate answers at the boundary and at the writes, so
// no step runs a child under words whose work its writeback would refuse.
// When a note waits, it runs the pinned orchestrator's
// `state.mjs rebind-deliver` for that subtask, with the run's pinned engineer
// root, as a worker of the run (its id and secret, so the admission the
// command joins passes on the run's own lock), and then decides again from a
// fresh look: every check before the spawn runs again, on the child as the
// note left it, and the step's progress baseline includes the note. A note
// that cannot be told stops that step: its lane parks, or a serial run halts.
//
// The command runs as a worker group of the run: `hold` puts its process on
// the run's locks (the serial run's worker, or a group of a run with lanes)
// until it exits, so a driver that dies while it writes leaves the locks live
// while the writer lives, and no approval or other run starts beside it. It
// starts idle (`--await-start`) and begins only once `hold` has put it on the
// locks, as a worker gets its prompt only from `begin()`: a driver that dies
// before then leaves a process with nothing written, which exits when its
// stdin closes. It leaves the locks only once its group is empty, as a worker
// does (worker.mjs terminateGroup): the engineer `append` it runs is a process
// of that group, and one that outlived the command would otherwise write its
// note after the locks let another approval or delivery in. A process of the
// group that outlives SIGKILL keeps the run's locks, and the run drains.

import { spawn } from 'node:child_process';
import path from 'node:path';

import { processFingerprint } from '../../../scripts/lib/run-locks.mjs';
import { childVouchVerdict } from '../../../scripts/state.mjs';
import { terminateGroup } from './worker.mjs';
import { parseRebindRecord, REBIND_KEY } from '../../../scripts/lib/rebind.mjs';

/**
 * What holds the step of `subtaskId` at the boundary, as { due, why } or null:
 * 'pending' when the macro's record holds a note for it, 'unreadable' when the
 * record cannot be read and the subtask is in progress (its child may be owed
 * one), 'unknown' when the record names it `unknown` with no note pending
 * (what its child was last told is not known, and only an approval can
 * restate it). Otherwise, for a subtask in progress, 'refused' when the
 * binding writes' told check refuses the child the step would run
 * (state.mjs childVouchVerdict, read from `macroPath`): the child would work
 * under words its last note contradicts, and `why` is the check's own, naming
 * the way out the binding writes name. One predicate answers both, with no
 * record of rebindings too: more than one file bearing the child refuses it
 * whatever the record holds (state.mjs childCopies). That child
 * is the subtask's recorded owner, or, when none is recorded, `selected`: the
 * child the look selected for the subtask (observe.mjs `children`), the one
 * the step spawns.
 */
export function rebindDue(fm, subtaskId, { macroPath = null, selected = null } = {}) {
  if (!fm || typeof subtaskId !== 'string' || subtaskId === '') return null;
  const s = (fm.plan?.subtasks ?? []).find((x) => x?.id === subtaskId);
  const parsed = parseRebindRecord(fm[REBIND_KEY]);
  if (parsed.status === 'unreadable') return s?.status === 'in_progress' ? { due: 'unreadable' } : null;
  const record = parsed.status === 'readable' ? parsed.record : null;
  if (record?.pending.some((p) => p.subtask === subtaskId)) return { due: 'pending' };
  if (s?.status !== 'in_progress') return null;
  if ((record?.unknown ?? []).includes(subtaskId)) return { due: 'unknown' };
  // The child the step runs: a recorded owner first, as the binding writes
  // vouch the child they name; else the one the look selected.
  const owner = s.engineer_workflow_id;
  const child = typeof owner === 'string' && owner !== '' ? owner : selected;
  if (typeof child !== 'string' || child === '') return null;
  // The check reads the child's start from the macro's state root, as the
  // writes do: without the macro's path it would read none, and hold a child
  // the writes bind. A caller that leaves it out is wrong, not owner-choice.
  if (typeof macroPath !== 'string' || macroPath === '') {
    throw new TypeError(`rebindDue: the macro's path is required to ask the told check of subtask ${subtaskId}'s child`);
  }
  const v = childVouchVerdict({ frontmatter: fm, workflowPath: macroPath, subtaskId, current: s, child });
  return v.ok ? null : { due: 'refused', why: v.why };
}

/**
 * Tell `subtaskId`'s child the notes its macro holds pending. Resolves to
 * { ok: true, results } when every one is delivered or found written, or
 * { ok: false, detail } naming what waits and how the owner ends it; with
 * `lingering: true` when a process of the writer's group outlived SIGKILL,
 * after `onLingering` (its locks were kept: the run drains). `terminate` is
 * the group teardown (worker.mjs terminateGroup; a test seam). `due` and
 * `why` are rebindDue's; a 'refused' step tells nothing, and its detail is the
 * told check's `why`.
 */
export async function deliverAtBoundary({
  roots, macroPath, macroId, subtaskId, repoRoot, env, runId, token, due, why = null, hold = null, onLingering = null,
  terminate = terminateGroup,
}) {
  const held = heldDetail({ macroPath, macroId, subtaskId, due, why });
  if (held !== null) return { ok: false, detail: held };
  const approve = `/orchestrator:approve --workflow=${macroId ?? path.basename(macroPath ?? '', '.md')}`;
  const args = [
    path.join(roots.orchestrator, 'scripts', 'state.mjs'), 'rebind-deliver', '--workflow-path', macroPath, '--host', 'claude',
    '--subtask-id', subtaskId, '--engineer-root', roots.engineer, '--repo-root', repoRoot, '--await-start',
  ];
  const { err, stdout, stderr, lingering } = await runHeld(args, { env: { ...env, AGENTIC_AUTOPILOT: runId, AGENTIC_AUTOPILOT_TOKEN: token }, hold, terminate });
  if (lingering) {
    onLingering?.();
    return {
      ok: false, lingering: true,
      detail: `a process of the group that told subtask ${subtaskId}'s child the owner's instruction change is still there after SIGKILL; ` +
        `the run keeps its locks until that group is empty`,
    };
  }
  if (err) {
    return { ok: false, detail: `subtask ${subtaskId}'s child could not be told the owner's instruction change: ${String(stderr || err.message).trim().split('\n')[0]}` };
  }
  let results;
  try {
    results = JSON.parse(stdout).deliveries;
  } catch {
    results = null;
  }
  if (!Array.isArray(results)) return { ok: false, detail: `rebind-deliver for subtask ${subtaskId} printed no result` };
  const waiting = results.filter((r) => r.status !== 'delivered' && r.status !== 'acknowledged');
  if (waiting.length === 0) return { ok: true, results };
  return {
    ok: false,
    detail: `subtask ${subtaskId}'s child is not told the owner's instruction change (${waiting.map((r) => `delivery ` +
      `${r.delivery_id} ${r.status}: ${r.detail}`).join('; ')}); its next step waits for the note, never runs under the ` +
      `old words (ADR-0068 Decision 8, item 4). Resolve it, or approve the plan again (${approve}), then relaunch`,
  };
}

/**
 * What a hold no delivery ends says, naming its way out: a 'refused' child
 * (the told check's `why`), an 'unreadable' record, an 'unknown' subtask; null
 * for a 'pending' note, which a delivery tells. The run's re-check after a
 * delivery says the same of a hold that changed kind meanwhile.
 */
export function heldDetail({ macroPath = null, macroId = null, subtaskId, due, why = null }) {
  const approve = `/orchestrator:approve --workflow=${macroId ?? path.basename(macroPath ?? '', '.md')}`;
  if (due === 'refused') {
    return `subtask ${subtaskId}'s child is not stepped under words its last note contradicts: ${why ?? 'the told check refused it'} ` +
      '(the binding writes\' told check, ADR-0068 Decision 8, item 4); then relaunch';
  }
  if (due === 'unreadable') {
    return `the macro's record of rebindings (${REBIND_KEY}) cannot be read, so subtask ${subtaskId}'s child cannot be told ` +
      `what the owner approved; approve the plan again (${approve}), which rewrites it (ADR-0068 Decision 8)`;
  }
  if (due === 'unknown') {
    return `what subtask ${subtaskId}'s child was last told is not known (an approval replaced an unreadable record of ` +
      `rebindings), and no note restates it yet; make its child readable and the plan rebindable for it, then approve ` +
      `the plan again (${approve}), which tells the child its words in full (ADR-0068 Decision 8, item 4)`;
  }
  return null;
}

/**
 * The detail of a step still held after its note was told (rebindDue's
 * `after`): a note the macro still holds pending, or the hold it changed into
 * (heldDetail), with that hold's own way out.
 */
export function stillHeldDetail({ macroPath = null, macroId = null, subtaskId, due, why = null }) {
  if (due === 'refused') return `subtask ${subtaskId}'s note was told, but its child is still refused: ${why}; then relaunch`;
  const held = heldDetail({ macroPath, macroId, subtaskId, due, why });
  if (held !== null) return `subtask ${subtaskId}'s note was told, but ${held}`;
  return `subtask ${subtaskId}'s note was told, but the macro still holds it pending; run state.mjs rebind-deliver for it, then relaunch`;
}

const DELIVERY_TIMEOUT_MS = 120_000;

// Run the command in its own process group, on the run's locks from before it
// begins (the line `start` on its stdin) until its group is empty (signalled
// at the timeout, and emptied once the command has exited). Resolves to
// { err, stdout, stderr, lingering }; never rejects.
async function runHeld(args, { env, hold, terminate }) {
  const detached = process.platform !== 'win32';
  const child = spawn(process.execPath, args, { env, detached, stdio: ['pipe', 'pipe', 'pipe'] });
  // A child gone before the line is written: its exit says why.
  child.stdin.on('error', () => {});
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (c) => { stdout += c; });
  child.stderr.setEncoding('utf8').on('data', (c) => { stderr += c; });
  const exited = new Promise((resolve) => {
    child.on('error', (err) => resolve({ err }));
    child.on('close', (code, signal) => resolve(code === 0 ? { err: null } : { err: new Error(`rebind-deliver exited ${code ?? signal}`) }));
  });
  let held = [];
  if (hold && Number.isInteger(child.pid)) {
    try {
      held = await hold({ pid: child.pid, pgid: detached ? child.pid : null, fingerprint: await processFingerprint(child.pid), session_id: null });
    } catch (err) {
      try { process.kill(detached ? -child.pid : child.pid, 'SIGKILL'); } catch { /* gone */ }
      child.stdin.destroy();
      await exited;
      return { err: new Error(`its process could not be put on the run's locks (${err?.message ?? err})`), stdout, stderr };
    }
  }
  child.stdin.end('start\n');
  const timer = setTimeout(() => {
    try { process.kill(detached ? -child.pid : child.pid, 'SIGKILL'); } catch { /* gone */ }
  }, DELIVERY_TIMEOUT_MS);
  const { err } = await exited;
  clearTimeout(timer);
  // Nothing the command began outlives its place on the locks.
  let teardown = 'empty';
  if (Number.isInteger(child.pid)) {
    try { teardown = await terminate(child.pid); } catch { teardown = 'lingering'; }
  }
  if (teardown === 'lingering') return { err, stdout, stderr, lingering: true };
  for (const h of [held].flat()) h?.release?.();
  return { err, stdout, stderr, lingering: false };
}
