// plugins/orchestrator/adapters/claude/autopilot/throttle.mjs
//
// ADR-0067 Decision 6, Throttle — with lanes only. The driver reads every
// `rate_limit_event` from every worker stream ({type: 'rate_limit_event',
// rate_limit_info: {...}}) and starts no new lane while the account's
// five-hour window is refused, warned, or at 0.85 or more of its use. Lanes
// already started keep stepping: only a lane's first step in the run is gated.
//
// The state is kept per window, not per event. An event's top-level `status`
// speaks for the window its `rateLimitType` names, with the top-level
// `resetsAt` as that status's reset; its `unifiedWindows.<window>` carries that
// window's utilization and reset. An event updates only what it carries, so a
// seven-day warning that arrives after a five-hour refusal leaves the refusal
// in place. Each kept part expires at its own reset (Unix seconds); a part
// with no numeric reset is kept until a later event replaces it.
//
// The state is per run: a relaunch starts with no event, which is "unknown".
// Pure: the driver holds the state object and passes the clock.

export const WINDOWS = Object.freeze(['five_hour', 'seven_day']);
// The owner's five-hour limit (§Context, 2026-10-07).
export const FIVE_HOUR_LIMIT = 0.85;

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const part = (value, resetsAt) => ({ value, resetsAt: isNum(resetsAt) ? resetsAt : null });

/** A run's throttle state: no event yet, nothing kept. */
export function createThrottleState() {
  return {
    events: 0,
    windows: Object.fromEntries(WINDOWS.map((w) => [w, { status: null, utilization: null }])),
  };
}

/**
 * Keep what one event carries. `info` is the event's `rate_limit_info`; an
 * event that is not an object is not counted. Returns whether it counted.
 */
export function applyRateLimitEvent(state, info) {
  if (!info || typeof info !== 'object' || Array.isArray(info)) return false;
  state.events += 1;
  if (WINDOWS.includes(info.rateLimitType) && typeof info.status === 'string') {
    state.windows[info.rateLimitType].status = part(info.status, info.resetsAt);
  }
  const unified = info.unifiedWindows && typeof info.unifiedWindows === 'object' ? info.unifiedWindows : {};
  for (const w of WINDOWS) {
    const u = unified[w];
    if (u && typeof u === 'object' && 'utilization' in u) state.windows[w].utilization = part(u.utilization, u.resetsAt);
  }
  return true;
}

/** Drop every kept part whose reset has passed. */
export function expireThrottle(state, nowSec) {
  for (const w of WINDOWS) {
    for (const k of ['status', 'utilization']) {
      const p = state.windows[w][k];
      if (p && p.resetsAt !== null && p.resetsAt <= nowSec) state.windows[w][k] = null;
    }
  }
}

const usable = (p) => p !== null && isNum(p.value) && p.value >= 0 && p.value <= 1;

/**
 * The throttle's state now, in the ADR's order:
 *   1. throttled — a kept status `rejected` for either window, a kept
 *      five-hour status other than exactly `allowed`, or a kept five-hour
 *      utilization that is a number of 0.85 or more (explicit evidence decides
 *      even when another part is missing);
 *   2. unknown — no event in this run, or no kept five-hour utilization that
 *      is a number in [0, 1];
 *   3. open — otherwise.
 * { state, why, throttling: [{window, part, value, resetsAt}] }. Expires first.
 */
export function judgeThrottle(state, nowSec) {
  expireThrottle(state, nowSec);
  const throttling = [];
  for (const w of WINDOWS) {
    const s = state.windows[w].status;
    if (s && s.value === 'rejected') throttling.push({ window: w, part: 'status', value: s.value, resetsAt: s.resetsAt });
  }
  const five = state.windows.five_hour;
  if (five.status && five.status.value !== 'allowed' && five.status.value !== 'rejected') {
    throttling.push({ window: 'five_hour', part: 'status', value: five.status.value, resetsAt: five.status.resetsAt });
  }
  if (five.utilization && isNum(five.utilization.value) && five.utilization.value >= FIVE_HOUR_LIMIT) {
    throttling.push({ window: 'five_hour', part: 'utilization', value: five.utilization.value, resetsAt: five.utilization.resetsAt });
  }
  if (throttling.length > 0) {
    return { state: 'throttled', why: throttling.map(describePart).join('; '), throttling };
  }
  if (state.events === 0) return { state: 'unknown', why: 'no rate-limit event in this run yet', throttling };
  if (!usable(five.utilization)) return { state: 'unknown', why: 'no five-hour utilization is known', throttling };
  return { state: 'open', why: `five-hour utilization ${five.utilization.value}`, throttling };
}

function describePart(p) {
  const name = p.window === 'five_hour' ? 'five-hour' : 'seven-day';
  return p.part === 'status' ? `${name} status ${p.value}` : `${name} utilization ${p.value} (limit ${FIVE_HOUR_LIMIT})`;
}

/**
 * May a new lane (a lane's first step in this run) start now?
 *   - open: yes;
 *   - unknown: only while no worker is in flight (that worker's first event
 *     decides the next);
 *   - throttled: no. With nothing to refresh it — no worker in flight and no
 *     started lane with a runnable step — wait until every throttling part has
 *     expired, or halt `budget` when one has no reset or resets after the
 *     run's deadline.
 * { start: true } | { start: false, why } | { start: false, waitUntilSec, why }
 * | { start: false, halt: {reason, detail} }.
 */
export function gateNewLane(state, { nowSec, deadlineSec, inFlight = 0, refreshable = false }) {
  const j = judgeThrottle(state, nowSec);
  if (j.state === 'open') return { start: true, judgment: j };
  if (j.state === 'unknown') {
    return inFlight > 0
      ? { start: false, why: `the rate limit is unknown (${j.why}); a new lane waits for the first event of the worker in flight`, judgment: j }
      : { start: true, judgment: j };
  }
  if (inFlight > 0 || refreshable) return { start: false, why: `throttled: ${j.why}`, judgment: j };
  const unbounded = j.throttling.find((p) => p.resetsAt === null);
  if (unbounded) {
    return { start: false, halt: { reason: 'budget', detail: `the rate limit throttles new lanes (${describePart(unbounded)}) with no reset time, and nothing is running to bring a newer event` }, judgment: j };
  }
  const late = j.throttling.find((p) => p.resetsAt > deadlineSec);
  if (late) {
    return { start: false, halt: { reason: 'budget', detail: `the ${late.window === 'five_hour' ? 'five-hour' : 'seven-day'} rate-limit window (${describePart(late)}) resets at ${iso(late.resetsAt)}, after the run's deadline ${iso(deadlineSec)}` }, judgment: j };
  }
  const waitUntilSec = Math.max(...j.throttling.map((p) => p.resetsAt));
  return { start: false, waitUntilSec, why: `throttled (${j.why}) with nothing running; waiting for the reset at ${iso(waitUntilSec)}`, judgment: j };
}

const iso = (sec) => (isNum(sec) ? new Date(sec * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') : 'unknown');

/** What the run line and run.json report: each window's kept parts. The seven-day window is reported, never gated (except `rejected`). */
export function throttleSnapshot(state, nowSec) {
  const j = judgeThrottle(state, nowSec);
  const w = (name) => ({
    status: state.windows[name].status?.value ?? null,
    status_resets_at: state.windows[name].status?.resetsAt ?? null,
    utilization: state.windows[name].utilization?.value ?? null,
    utilization_resets_at: state.windows[name].utilization?.resetsAt ?? null,
  });
  return { state: j.state, why: j.why, events: state.events, five_hour: w('five_hour'), seven_day: w('seven_day') };
}

/** One line for the terminal. */
export function throttleText(state, nowSec) {
  const s = throttleSnapshot(state, nowSec);
  const one = (label, x) => `${label} ${x.utilization ?? '?'}${x.status ? ` ${x.status}` : ''}${x.utilization_resets_at ? ` (resets ${iso(x.utilization_resets_at)})` : ''}`;
  return `rate limit ${s.state} · ${one('five-hour', s.five_hour)} · ${one('seven-day', s.seven_day)}`;
}
