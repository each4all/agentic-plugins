// scripts/lib/lane-advice.mjs — the lane advice /orchestrator:plan and
// /orchestrator:approve show after their Active Next-Action Proposal
// (ADR-0067 Decision 8, item 2).
//
// Computed each time from `plan.subtasks[].blocked_by`, never stored: a
// critical-path simulation at one lane and at more, bounded by the widest
// ready set, as the precedent's main session did by hand. Each subtask counts
// as one step; a step starts once every predecessor has finished, the ready
// ones in plan order. The advice is shown only when more lanes shorten the
// run, and its command only when the autopilot could take it: shared creation
// on, and the macro in a home of the default state root (Decision 2); otherwise
// the line says the cutover comes first (Decision 4, item 4). Display only: no
// field of the macro holds it, and no machine reads it.
//
// Pure: the caller reads the macro and the state-root facts.

// The owner's default with lanes (ADR-0067 Decision 6): the advice simulates
// up to this many, and never names more.
export const LANE_ADVICE_CAP = 2;

const TERMINAL = new Set(['completed', 'deferred', 'abandoned']);
// cli.mjs's --macro alphabet: the only id the command carries.
const MACRO_ID_RE = /^macro-[a-z][a-z0-9-]*-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CUTOVER_RUNBOOK = 'docs/runbooks/state-root-cutover.md';

const predecessorsOf = (s) => (Array.isArray(s?.blocked_by) ? s.blocked_by : []);

/**
 * The subtasks that can still run, in plan order: open (not completed,
 * deferred or abandoned), and not waiting, directly or through another, on a
 * subtask that never completes (deferred, abandoned, or not in the plan).
 */
export function runnableSubtasks(subtasks) {
  const list = (Array.isArray(subtasks) ? subtasks : []).filter((s) => s && typeof s.id === 'string');
  const byId = new Map(list.map((s) => [s.id, s]));
  const memo = new Map();
  const reachable = (id, seen = new Set()) => {
    if (memo.has(id)) return memo.get(id);
    const s = byId.get(id);
    if (!s || s.status === 'deferred' || s.status === 'abandoned' || seen.has(id)) return false;
    if (s.status === 'completed') return true;
    seen.add(id);
    const ok = predecessorsOf(s).every((p) => reachable(p, seen));
    seen.delete(id);
    memo.set(id, ok);
    return ok;
  };
  return list.filter((s) => !TERMINAL.has(s.status) && reachable(s.id));
}

/**
 * The run of the runnable subtasks with `lanes` at a time: `waves[i]` holds
 * the ids that run in step i. `stalled` lists what never became ready (a
 * cycle, which plan-set refuses).
 */
export function simulateLanes(subtasks, lanes) {
  const finished = new Set((Array.isArray(subtasks) ? subtasks : []).filter((s) => s?.status === 'completed').map((s) => s.id));
  let remaining = runnableSubtasks(subtasks);
  const waves = [];
  while (remaining.length > 0) {
    const ready = remaining.filter((s) => predecessorsOf(s).every((p) => finished.has(p)));
    if (ready.length === 0) break;
    const step = ready.slice(0, lanes);
    waves.push(step.map((s) => s.id));
    for (const s of step) finished.add(s.id);
    remaining = remaining.filter((s) => !step.includes(s));
  }
  return { steps: waves.length, waves, stalled: remaining.map((s) => s.id) };
}

const idText = (id) => (SAFE_ID_RE.test(id) ? id : JSON.stringify(id));

function listText(ids) {
  const words = ids.map(idText);
  return words.length <= 2 ? words.join(' and ') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

// "A and B are independent, C waits on both": each step that runs more than
// one subtask, with the subtasks of the next step that wait on all of them.
function wavesText(waves, subtasks) {
  const byId = new Map(subtasks.map((s) => [s.id, s]));
  const parts = [];
  waves.forEach((wave, i) => {
    if (wave.length < 2) return;
    let part = `${listText(wave)} are independent`;
    const waiting = (waves[i + 1] ?? []).filter((id) => wave.every((w) => predecessorsOf(byId.get(id)).includes(w)));
    if (waiting.length > 0) part += `, ${listText(waiting)} ${waiting.length === 1 ? 'waits' : 'wait'} on ${wave.length === 2 ? 'both' : 'all of them'}`;
    parts.push(part);
  });
  const shown = parts.slice(0, 3);
  if (parts.length > shown.length) shown.push(`${parts.length - shown.length} more such step${parts.length - shown.length === 1 ? '' : 's'}`);
  return shown.join('; ');
}

/**
 * @param a.subtasks                plan.subtasks
 * @param a.macroId                 the macro's id (its file name)
 * @param a.sharedCreation          the shared-creation switch: 'on' | 'off' | 'unreadable'
 * @param a.macroUnderDefaultRoot   whether the macro lies in a home of the default state root
 * @returns {{show: boolean, lanes?: number, steps?: Record<number, number>,
 *   waves?: string[][], text?: string, command?: ?string, cutover_first?: boolean, why?: ?string}}
 */
export function laneAdvice({ subtasks, macroId, sharedCreation, macroUnderDefaultRoot, cap = LANE_ADVICE_CAP }) {
  const list = Array.isArray(subtasks) ? subtasks : [];
  const width = Math.max(0, ...simulateLanes(list, Infinity).waves.map((w) => w.length));
  // Below two ready at once, the loop runs no lane count and best stays 1.
  const upTo = Math.min(cap, width);
  const steps = { 1: simulateLanes(list, 1).steps };
  let best = 1;
  for (let n = 2; n <= upTo; n += 1) {
    steps[n] = simulateLanes(list, n).steps;
    if (steps[n] < steps[best]) best = n;
  }
  if (best === 1) return { show: false };
  const { waves } = simulateLanes(list, best);
  const text = `${wavesText(waves, list)} (${steps[1]} steps in one lane, ${steps[best]} with ${best})`;
  let why = null;
  let cutoverFirst = false;
  if (!MACRO_ID_RE.test(String(macroId ?? ''))) {
    why = `${JSON.stringify(macroId)} is not a macro workflow id`;
  } else if (sharedCreation !== 'on') {
    why = `shared creation is ${sharedCreation ?? 'off'}`;
    cutoverFirst = true;
  } else if (!macroUnderDefaultRoot) {
    why = 'the macro is not in a home of the default state root';
    cutoverFirst = true;
  }
  return {
    show: true,
    lanes: best,
    steps,
    waves,
    text,
    command: why ? null : `/orchestrator:autopilot start --execute --macro ${macroId} --lanes ${best}`,
    cutover_first: cutoverFirst,
    why,
  };
}

/** The `- lane_advice:` line, or null when there is no advice. */
export function laneAdviceLine(advice) {
  if (!advice?.show) return null;
  if (advice.command) return `- lane_advice: ${advice.text}: ${advice.command}`;
  if (advice.cutover_first) return `- lane_advice: ${advice.text}; lanes need the state-root cutover first (${advice.why}): ${CUTOVER_RUNBOOK}`;
  return `- lane_advice: ${advice.text} (no command: ${advice.why})`;
}
