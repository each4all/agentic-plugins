// tests/orchestrator/test-autopilot-throttle.mjs
//
// ADR-0067 Decision 6, Throttle — the lanes run's rate-limit gate
// (plugins/orchestrator/adapters/claude/autopilot/throttle.mjs): the state is
// kept per window from the stream's rate_limit_event fields as observed, each
// part expires with its own window, the three rules decide in order, and a
// throttled run with nothing to refresh it waits for the reset or halts
// `budget` when the window cannot reopen before the deadline.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const T = await import(resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/throttle.mjs'));

const NOW = 1_791_560_000;
const FIVE_RESET = NOW + 3600;
const SEVEN_RESET = NOW + 86_400;

// The three shapes measured in the worker streams (802 + 124 + 97 events).
const allowed = (u5 = 0.42, u7 = 0.67) => ({
  status: 'allowed', resetsAt: FIVE_RESET, rateLimitType: 'five_hour', overageStatus: 'rejected', isUsingOverage: false,
  unifiedWindows: { five_hour: { utilization: u5, resetsAt: FIVE_RESET }, seven_day: { utilization: u7, resetsAt: SEVEN_RESET } },
});
const sevenWarning = (u5 = 0.42, u7 = 0.81) => ({
  status: 'allowed_warning', resetsAt: SEVEN_RESET, rateLimitType: 'seven_day', utilization: u7, isUsingOverage: false,
  unifiedWindows: { five_hour: { utilization: u5, resetsAt: FIVE_RESET }, seven_day: { utilization: u7, resetsAt: SEVEN_RESET } },
});
const fiveWarning = (u5 = 0.93) => ({
  status: 'allowed_warning', resetsAt: FIVE_RESET, rateLimitType: 'five_hour', utilization: u5, surpassedThreshold: 0.9, isUsingOverage: false,
  unifiedWindows: { five_hour: { utilization: u5, resetsAt: FIVE_RESET }, seven_day: { utilization: 0.7, resetsAt: SEVEN_RESET } },
});
const fiveRejected = () => ({
  status: 'rejected', resetsAt: FIVE_RESET, rateLimitType: 'five_hour', isUsingOverage: false,
  unifiedWindows: { five_hour: { utilization: 1, resetsAt: FIVE_RESET }, seven_day: { utilization: 0.7, resetsAt: SEVEN_RESET } },
});

const withEvents = (...infos) => {
  const s = T.createThrottleState();
  for (const i of infos) T.applyRateLimitEvent(s, i);
  return s;
};

describe('the state, per window', () => {
  it('an event updates the status of the window its rateLimitType names, and each window\'s utilization from unifiedWindows', () => {
    const s = withEvents(allowed(0.42, 0.67));
    deepStrictEqual(s.windows.five_hour.status, { value: 'allowed', resetsAt: FIVE_RESET });
    deepStrictEqual(s.windows.five_hour.utilization, { value: 0.42, resetsAt: FIVE_RESET });
    strictEqual(s.windows.seven_day.status, null, 'a five-hour event says nothing of the seven-day status');
    deepStrictEqual(s.windows.seven_day.utilization, { value: 0.67, resetsAt: SEVEN_RESET });
    strictEqual(s.events, 1);
  });

  it('a newer event about one window never erases what is kept for the other: a seven-day warning after a five-hour refusal leaves the refusal', () => {
    const s = withEvents(fiveRejected(), sevenWarning(0.5, 0.81));
    strictEqual(s.windows.five_hour.status.value, 'rejected');
    strictEqual(s.windows.seven_day.status.value, 'allowed_warning');
    const j = T.judgeThrottle(s, NOW);
    strictEqual(j.state, 'throttled');
    ok(j.throttling.some((p) => p.window === 'five_hour' && p.part === 'status' && p.value === 'rejected'));
  });

  it('an event that is not an object is not counted', () => {
    const s = T.createThrottleState();
    strictEqual(T.applyRateLimitEvent(s, null), false);
    strictEqual(T.applyRateLimitEvent(s, 'rejected'), false);
    strictEqual(T.applyRateLimitEvent(s, [allowed()]), false);
    strictEqual(s.events, 0);
  });
});

describe('the three rules, in order', () => {
  it('rule 2: no event in this run is unknown (the state is not persisted across a relaunch)', () => {
    const j = T.judgeThrottle(T.createThrottleState(), NOW);
    strictEqual(j.state, 'unknown');
    ok(/no rate-limit event/.test(j.why));
  });

  it('rule 3: a five-hour utilization below 0.85 with the five-hour status allowed is open', () => {
    strictEqual(T.judgeThrottle(withEvents(allowed(0.84)), NOW).state, 'open');
  });

  it('rule 1: a five-hour utilization of 0.85 or more throttles, the boundary included', () => {
    strictEqual(T.judgeThrottle(withEvents(allowed(0.85)), NOW).state, 'throttled');
    strictEqual(T.judgeThrottle(withEvents(allowed(0.9)), NOW).state, 'throttled');
  });

  it('rule 1: a five-hour status other than exactly allowed throttles, even below 0.85', () => {
    const s = withEvents({ ...fiveWarning(0.5) });
    const j = T.judgeThrottle(s, NOW);
    strictEqual(j.state, 'throttled');
    ok(j.throttling.some((p) => p.part === 'status' && p.value === 'allowed_warning'));
  });

  it('rule 1: a seven-day rejected throttles; a seven-day warning is reported, never gated', () => {
    strictEqual(T.judgeThrottle(withEvents({ ...sevenWarning(0.4), status: 'rejected' }), NOW).state, 'throttled');
    strictEqual(T.judgeThrottle(withEvents(sevenWarning(0.4, 0.99)), NOW).state, 'open',
      'a known five-hour utilization below 0.85 with only seven-day statuses kept is open');
  });

  it('rule 1 decides on explicit evidence even when another part is missing', () => {
    // A rejected status with no utilization anywhere is still throttled, not unknown.
    strictEqual(T.judgeThrottle(withEvents({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: FIVE_RESET }), NOW).state, 'throttled');
  });

  it('rule 2: events came, but no five-hour utilization that is a number in [0, 1] is kept — unknown', () => {
    strictEqual(T.judgeThrottle(withEvents({ status: 'allowed', rateLimitType: 'five_hour', resetsAt: FIVE_RESET, unifiedWindows: { seven_day: { utilization: 0.5, resetsAt: SEVEN_RESET } } }), NOW).state, 'unknown',
      'one event of 802 had no five_hour');
    strictEqual(T.judgeThrottle(withEvents({ ...allowed(), unifiedWindows: { five_hour: { utilization: 'high', resetsAt: FIVE_RESET } } }), NOW).state, 'unknown');
    strictEqual(T.judgeThrottle(withEvents({ ...allowed(), unifiedWindows: { five_hour: { utilization: -0.1, resetsAt: FIVE_RESET } } }), NOW).state, 'unknown');
  });
});

describe('expiry, per part', () => {
  it('each kept part is dropped once its own reset has passed: a five-hour refusal ends with its window, a seven-day one outlives it', () => {
    const s = withEvents(fiveRejected(), { ...sevenWarning(0.2), status: 'rejected' });
    strictEqual(T.judgeThrottle(s, FIVE_RESET + 1).state, 'throttled', 'the seven-day refusal outlives the five-hour reset');
    strictEqual(s.windows.five_hour.status, null, 'the five-hour status expired');
    strictEqual(s.windows.five_hour.utilization, null, 'and its utilization');
    strictEqual(T.judgeThrottle(s, SEVEN_RESET + 1).state, 'unknown', 'after both resets nothing is known');
  });

  it('a five-hour throttle that expires leaves the state unknown, not open', () => {
    const s = withEvents(allowed(0.9));
    strictEqual(T.judgeThrottle(s, NOW).state, 'throttled');
    strictEqual(T.judgeThrottle(s, FIVE_RESET).state, 'unknown');
  });

  it('a part with no numeric reset is kept until a later event replaces it', () => {
    const s = withEvents({ status: 'rejected', rateLimitType: 'five_hour' });
    strictEqual(T.judgeThrottle(s, NOW + 10 * 86_400).state, 'throttled');
    T.applyRateLimitEvent(s, allowed(0.3));
    strictEqual(T.judgeThrottle(s, NOW).state, 'open');
  });
});

describe('the gate on a new lane', () => {
  const deadlineSec = NOW + 2 * 3600;

  it('open starts a new lane', () => {
    strictEqual(T.gateNewLane(withEvents(allowed(0.5)), { nowSec: NOW, deadlineSec, inFlight: 3 }).start, true);
  });

  it('unknown starts a new lane only while no worker is in flight', () => {
    const s = T.createThrottleState();
    strictEqual(T.gateNewLane(s, { nowSec: NOW, deadlineSec, inFlight: 0 }).start, true);
    const g = T.gateNewLane(s, { nowSec: NOW, deadlineSec, inFlight: 1 });
    strictEqual(g.start, false);
    ok(/first event/.test(g.why));
  });

  it('throttled with a worker in flight, or a started lane with a runnable step, waits for newer events', () => {
    const s = withEvents(allowed(0.9));
    const a = T.gateNewLane(s, { nowSec: NOW, deadlineSec, inFlight: 1 });
    deepStrictEqual([a.start, a.waitUntilSec, a.halt], [false, undefined, undefined]);
    const b = T.gateNewLane(s, { nowSec: NOW, deadlineSec, inFlight: 0, refreshable: true });
    deepStrictEqual([b.start, b.waitUntilSec, b.halt], [false, undefined, undefined]);
  });

  it('throttled with nothing to refresh it waits until every throttling part has expired', () => {
    const s = withEvents({ ...allowed(0.9), unifiedWindows: { five_hour: { utilization: 0.9, resetsAt: FIVE_RESET + 60 } } });
    const g = T.gateNewLane(s, { nowSec: NOW, deadlineSec, inFlight: 0, refreshable: false });
    strictEqual(g.start, false);
    strictEqual(g.waitUntilSec, FIVE_RESET + 60, 'the latest reset among the throttling parts');
  });

  it('halts budget, naming the window, when a throttling part resets after the run\'s deadline', () => {
    const g = T.gateNewLane(withEvents(fiveRejected()), { nowSec: NOW, deadlineSec: FIVE_RESET - 1, inFlight: 0 });
    strictEqual(g.halt.reason, 'budget');
    ok(/five-hour rate-limit window/.test(g.halt.detail), g.halt.detail);
  });

  it('halts budget when a throttling part has no reset time', () => {
    const g = T.gateNewLane(withEvents({ status: 'rejected', rateLimitType: 'seven_day' }), { nowSec: NOW, deadlineSec, inFlight: 0 });
    strictEqual(g.halt.reason, 'budget');
    ok(/no reset time/.test(g.halt.detail), g.halt.detail);
  });
});

describe('reporting', () => {
  it('the snapshot and the line report both windows, the seven-day one included', () => {
    const s = withEvents(sevenWarning(0.4, 0.81));
    const snap = T.throttleSnapshot(s, NOW);
    strictEqual(snap.state, 'open');
    strictEqual(snap.seven_day.status, 'allowed_warning');
    strictEqual(snap.seven_day.utilization, 0.81);
    ok(/seven-day 0\.81 allowed_warning/.test(T.throttleText(s, NOW)), T.throttleText(s, NOW));
  });
});
