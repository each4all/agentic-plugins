// tests/orchestrator/test-autopilot-stall.mjs
//
// ADR-0068 Decision 3 — the stall detector (plugins/orchestrator/adapters/
// claude/autopilot/stall.mjs), fed a fake stream and a fake process table on
// a simulated clock: the measured shapes (a mutation run and a Codex wait,
// quiet but busy; a foreground wait on nothing with heartbeats; a background
// sleep; a polling loop of short processes), a missing sample, identity and
// sticky membership, the clocks, and what the verdict records.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const S = await import(resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/stall.mjs'));

const W = 1000; // the worker's pid
const SEC = 1000;
const MIN = 60 * SEC;
const WALL0 = Date.parse('2026-10-29T00:00:00.000Z');

// A process of the fake table.
const proc = (pid, { ppid = W, pgid = W, cpuMs = 0, ageMs = 0, start = 's' } = {}) => ({ pid, ppid, pgid, key: `${pid}@${start}`, ageMs, cpuMs });
const table = (procs, extra = {}) => ({ ok: true, procs, unreadable: [], exited: [], resolutionMs: 10, ...extra });

/**
 * Run a detector over a timeline: a sample every `step` ms until `until`,
 * `snap(t)` giving each one (or undefined to skip it), `events` [[t, ev]]
 * observed in order between them, `wall(t)` the wall clock. Returns the
 * records with the time each came at, and the detector.
 */
function timeline({ until, step = 10 * SEC, snap, events = [], wall = (t) => WALL0 + t, opts = {} }) {
  const d = S.createStallDetector({ workerPid: W, startMono: 0, startWall: wall(0), ...opts });
  const records = [];
  const evs = [...events].sort((a, b) => a[0] - b[0]);
  let e = 0;
  const flush = (upTo) => {
    while (e < evs.length && evs[e][0] <= upTo) {
      const [t, ev] = evs[e];
      const r = d.observeEvent(ev, t, wall(t));
      if (r) records.push({ t, ...r });
      e += 1;
    }
  };
  for (let t = step; t <= until; t += step) {
    flush(t - 1);
    const s = snap(t);
    if (s !== undefined) {
      const r = d.observeSample(s, t, wall(t));
      if (r) records.push({ t, ...r });
    }
  }
  flush(until);
  return { d, records };
}

const verdicts = (records) => records.map((r) => [r.t / SEC, r.verdict]);
const assistantToolUse = (id) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id, name: 'Bash' }] } });
const heartbeat = (id) => ({ type: 'tool_progress', tool_use_id: `${id}-heartbeat`, parent_tool_use_id: id, heartbeat: true });
const toolResult = (id) => ({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: id }] } });
const every = (fromMs, untilMs, stepMs, ev) => {
  const out = [];
  for (let t = fromMs; t <= untilMs; t += stepMs) out.push([t, typeof ev === 'function' ? ev(t) : ev]);
  return out;
};

describe('the stream clock (Decision 3, item 1)', () => {
  it('heartbeats and hook events are not activity; every other event is', () => {
    strictEqual(S.isActivity(heartbeat('t')), false);
    strictEqual(S.isActivity({ type: 'system', subtype: 'hook_started' }), false);
    strictEqual(S.isActivity({ type: 'system', subtype: 'hook_response' }), false);
    for (const ev of [
      { type: 'system', subtype: 'thinking_tokens' }, { type: 'system', subtype: 'task_progress' },
      { type: 'rate_limit_event' }, { type: 'system', subtype: 'api_retry' }, { type: 'result' },
      { type: 'system', subtype: 'task_notification' }, { type: 'tool_progress', heartbeat: false },
      { type: 'assistant', message: {} }, { type: 'user', message: {} },
    ]) strictEqual(S.isActivity(ev), true, JSON.stringify(ev));
  });

  it('a foreground wait on nothing with heartbeats only, no CPU: stalled at 10 min, a foreground tool running', () => {
    const { records } = timeline({
      until: 12 * MIN, snap: () => table([proc(1001, { cpuMs: 50, ageMs: 0 })]),
      events: [[1 * SEC, assistantToolUse('toolu_1')], ...every(30 * SEC, 12 * MIN, 30 * SEC, heartbeat('toolu_1'))],
    });
    deepStrictEqual(verdicts(records), [[610, 'stalled']], 'quiet measured from the tool call at 1 s');
    const r = records[0];
    deepStrictEqual([r.tool_running, r.answer_owed, r.pending_tasks], [true, false, 0]);
    ok(r.window_cpu_ms < 1000);
  });

  it('a stream of hook events only stalls too', () => {
    const { records } = timeline({
      until: 11 * MIN, snap: () => table([]),
      events: every(5 * SEC, 11 * MIN, 5 * SEC, (t) => ({ type: 'system', subtype: t % 10000 ? 'hook_started' : 'hook_response' })),
    });
    deepStrictEqual(verdicts(records), [[600, 'stalled']]);
    strictEqual(records[0].answer_owed, true, 'the step\'s prompt owes an answer before any event');
  });

  it('a step younger than the window is active, however quiet', () => {
    const { records } = timeline({ until: 9 * MIN + 50 * SEC, snap: () => table([]) });
    deepStrictEqual(records, []);
  });

  it('activity between samples ends a stall at the activity, not at the next sample', () => {
    const { records } = timeline({
      until: 13 * MIN, snap: () => table([]),
      events: [[12 * MIN + 5 * SEC, { type: 'assistant', parent_tool_use_id: null, message: { content: [] } }]],
    });
    deepStrictEqual(verdicts(records), [[600, 'stalled'], [725, 'active']]);
    strictEqual(records[1].at, new Date(WALL0 + 12 * MIN + 5 * SEC).toISOString());
    strictEqual(records[1].why, 'stream');
  });
});

describe('whose CPU counts (Decision 3, item 3)', () => {
  // A descendant whose CPU grows by `perSample(t)` at each sample.
  const busy = (perSample, extra = []) => {
    let cpu = 0;
    return (t) => {
      cpu += perSample(t);
      return table([proc(1001, { cpuMs: cpu, ageMs: t }), ...extra]);
    };
  };

  it('a mutation run, quiet but busy (6 s of CPU per 120 s), stays active', () => {
    const { records } = timeline({ until: 30 * MIN, snap: busy(() => 500) });
    deepStrictEqual(records, []);
  });

  it('a Codex wait, quiet but busy (0.3 s per minute, 40 s at zero between bursts), stays active', () => {
    // Per minute: four samples at 0, two at 0.15 s: at least 0.1 s per 60 s,
    // 1.5 s per 300 s, a 40 s run at zero (the measured shape).
    const { records } = timeline({ until: 30 * MIN, snap: busy((t) => ((t / (10 * SEC)) % 6 >= 4 ? 150 : 0)) });
    deepStrictEqual(records, []);
  });

  it('the worker process itself is excluded (its claude uses up to 0.6 s per 10 s doing nothing)', () => {
    let own = 0;
    const { records } = timeline({
      until: 11 * MIN, snap: () => { own += 600; return table([proc(W, { ppid: 1, pgid: W, cpuMs: own, ageMs: 0 })]); },
    });
    deepStrictEqual(verdicts(records), [[600, 'stalled']]);
  });

  it('a background sleep stalls, its task pending', () => {
    const { records } = timeline({
      until: 11 * MIN, snap: (t) => table([proc(1001, { cpuMs: 2, ageMs: t })]),
      events: [[2 * SEC, { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1' }] }],
        [3 * SEC, { type: 'result', subtype: 'success' }]],
    });
    deepStrictEqual(verdicts(records), [[610, 'stalled']]);
    deepStrictEqual([records[0].pending_tasks, records[0].answer_owed, records[0].tool_running], [1, false, false]);
  });

  it('a polling loop of short processes (a new 0.01 s one every 10 s) stalls: the number of new processes is never read', () => {
    let n = 0;
    const { records } = timeline({
      until: 11 * MIN, snap: () => { n += 1; return table([proc(5000 + n, { cpuMs: 10, ageMs: 2 * SEC })]); },
    });
    deepStrictEqual(verdicts(records), [[600, 'stalled']]);
    ok(records[0].window_cpu_ms >= 590 && records[0].window_cpu_ms <= 610, `each counted once: ${records[0].window_cpu_ms}`);
  });

  it('the threshold: 999 ms in the window stalls, 1000 and 1001 do not', () => {
    for (const [total, want] of [[999, 'stalled'], [1000, null], [1001, null]]) {
      // One burst at 5 min, inside the window at 10 min and still at 10:10.
      const { records } = timeline({
        until: 10 * MIN, snap: (t) => table([proc(1001, { cpuMs: t >= 5 * MIN ? total : 0, ageMs: t })]),
      });
      deepStrictEqual(records.map((r) => r.verdict), want ? [want] : [], `${total} ms`);
    }
  });

  it('several descendants, each under the threshold, together over it, are active', () => {
    const { records } = timeline({
      until: 12 * MIN,
      snap: (t) => table([1, 2, 3].map((i) => proc(1000 + i, { cpuMs: (t / MIN) * 40, ageMs: t }))),
    });
    deepStrictEqual(records, [], '0.4 s per 10 min each, 1.2 s together');
  });

  it('identity is the pid with its start time: a reused pid is a new process, never a counter that went back', () => {
    const { records } = timeline({
      until: 11 * MIN,
      snap: (t) => table([t < 5 * MIN
        ? proc(2000, { cpuMs: 50 * SEC, ageMs: t, start: 'old' })
        : proc(2000, { cpuMs: 100, ageMs: 3 * SEC, start: 'new' })]),
    });
    // The old process's 50 s, first seen in 0:00–0:10, leaves the window at
    // 10:10; the new one's 0.1 s is growth of a new identity, not a regression.
    deepStrictEqual(verdicts(records), [[610, 'stalled']]);
  });

  it('a counter that goes back on one identity makes the window unknown', () => {
    const { records } = timeline({
      until: 11 * MIN, snap: (t) => table([proc(2000, { cpuMs: t === 5 * MIN ? 0 : 400, ageMs: t })]),
    });
    deepStrictEqual(verdicts(records), [[600, 'unknown']]);
    strictEqual(records[0].why, 'regression');
  });

  it('membership sticks: a descendant reparented when its parent exits (a detached peer) is still counted', () => {
    let cpu = 0;
    const { records } = timeline({
      until: 15 * MIN,
      snap: (t) => {
        cpu += 500;
        const peer = proc(1002, { ppid: t < 1 * MIN ? 1001 : 1, pgid: 1002, cpuMs: cpu, ageMs: t });
        return table(t < 1 * MIN ? [proc(1001, { ageMs: t }), peer] : [peer]);
      },
    });
    deepStrictEqual(records, []);
  });

  it('every member of the worker\'s process group counts, whatever its parent', () => {
    let cpu = 0;
    const { records } = timeline({
      until: 12 * MIN, snap: (t) => { cpu += 400; return table([proc(1009, { ppid: 1, pgid: W, cpuMs: cpu, ageMs: t })]); },
    });
    deepStrictEqual(records, []);
  });

  it('a short process seen once counts what it used; it ages out with its interval', () => {
    const { records } = timeline({
      until: 13 * MIN,
      snap: (t) => table(t === 2 * MIN ? [proc(3000, { cpuMs: 2 * SEC, ageMs: 5 * SEC })] : []),
    });
    // Its interval (1:50–2:00) leaves the window at 12:00.
    deepStrictEqual(verdicts(records), [[720, 'stalled']]);
  });

  it('a process first seen that started before the window counts nothing (only a baseline)', () => {
    const { records } = timeline({
      until: 11 * MIN, snap: (t) => table(t >= 3 * MIN ? [proc(3000, { ppid: 1, pgid: W, cpuMs: 30 * SEC, ageMs: 20 * MIN })] : []),
    });
    deepStrictEqual(verdicts(records), [[600, 'stalled']]);
  });

  it('a process first seen that started inside the window, before its interval (a scan that missed it), counts what it used', () => {
    // Born at 1:31, missed by the 1:40 and 1:50 scans, seen once at 2:00 with
    // 2 s of CPU, gone by the next.
    const { records } = timeline({
      until: 12 * MIN, snap: (t) => table(t === 2 * MIN ? [proc(3000, { cpuMs: 2 * SEC, ageMs: 29 * SEC })] : []),
    });
    deepStrictEqual(verdicts(records), [[720, 'stalled']], 'active until its interval leaves the window');
  });

  it('the CPU of an exited process is never added after its last sample', () => {
    const { records } = timeline({
      until: 11 * MIN,
      snap: (t) => table(t <= 30 * SEC ? [proc(1001, { cpuMs: t, ageMs: t })] : []),
    });
    // What the samples saw of it (up to 0:30) leaves the window at 10:30.
    deepStrictEqual(verdicts(records), [[630, 'stalled']]);
  });
});

describe('a missing sample is unknown, never zero (Decision 3, item 4)', () => {
  it('a failed sample in a quiet, idle window makes it unknown until the sample leaves the window', () => {
    const { records } = timeline({
      until: 16 * MIN, snap: (t) => (t === 5 * MIN ? { ok: false, why: 'failed' } : table([])),
    });
    // Unknown: the failed sample's interval (4:50–5:00) and the next (5:00–5:10).
    deepStrictEqual(verdicts(records), [[600, 'unknown'], [910, 'stalled']]);
    strictEqual(records[0].window_cpu_ms, null);
    strictEqual(records[0].unknown_ms, 20 * SEC);
  });

  for (const why of ['slow', 'timeout', 'parse', 'coarse', 'probe-error']) {
    it(`a ${why} sample never yields stalled`, () => {
      const { records } = timeline({ until: 11 * MIN, snap: (t) => (t === 6 * MIN ? { ok: false, why } : table([])) });
      deepStrictEqual(verdicts(records), [[600, 'unknown']]);
      strictEqual(records[0].why, why);
    });
  }

  it('a live member that cannot be read leaves the sample unknown', () => {
    const sticky = new Map([['1001@s', 1001]]);
    const snap = table([proc(1002)], { unreadable: [1001] });
    deepStrictEqual(S.membersOf(snap, W, sticky).complete, false);
    const { records } = timeline({
      until: 11 * MIN, snap: (t) => (t === 4 * MIN ? table([], { unreadable: [1001] }) : table(t < 4 * MIN ? [proc(1001, { ageMs: t })] : [])),
    });
    deepStrictEqual(verdicts(records), [[600, 'unknown']]);
    strictEqual(records[0].why, 'unreadable-member');
  });

  it('a pid that cannot be read and was never seen leaves the sample unknown', () => {
    const { records } = timeline({ until: 11 * MIN, snap: () => table([], { unreadable: [1001] }) });
    deepStrictEqual(verdicts(records), [[600, 'unknown']]);
    strictEqual(records[0].why, 'unreadable-member');
  });

  it('a pid the table before read outside the tree, unreadable once, is unknown: a descendant may have reused it', () => {
    // 4000 is read outside the tree until 9:50; by 10:00 it has exited, a
    // busy descendant of the worker has its pid, and its stat cannot be read.
    const unread = (t) => t === 10 * MIN;
    const { records } = timeline({
      until: 11 * MIN, snap: (t) => table(unread(t) ? [] : [proc(4000, { ppid: 1, pgid: 4000 })], { unreadable: unread(t) ? [4000] : [] }),
    });
    deepStrictEqual(verdicts(records), [[600, 'unknown']]);
    strictEqual(records[0].why, 'unreadable-member');
    strictEqual(S.membersOf(table([], { unreadable: [4000] }), W, new Map()).complete, false);
  });

  it('a member that cannot be read stays a member: once readable again, its CPU counts', () => {
    let cpu = 0;
    const { records } = timeline({
      until: 25 * MIN,
      snap: (t) => {
        // A detached peer (its own group, parent 1 once its parent exits),
        // unreadable from 1:00 to 3:00, then readable and busy.
        if (t > 1 * MIN && t <= 3 * MIN) return table([], { unreadable: [1002] });
        if (t > 3 * MIN) cpu += 500;
        return table([proc(1002, { ppid: t <= 30 * SEC ? W : 1, pgid: 1002, cpuMs: cpu, ageMs: t })]);
      },
    });
    // Unknown while the unreadable samples are in the window; then its CPU,
    // still a member, keeps it active (not a member, it would read stalled).
    deepStrictEqual(verdicts(records), [[600, 'unknown'], [790, 'active']]);
  });

  it('a heartbeat after the last sample never decides stalled: the time since the sample is unseen', () => {
    const d = S.createStallDetector({ workerPid: W, startMono: 0, startWall: WALL0 });
    for (let t = 10 * SEC; t <= 590 * SEC; t += 10 * SEC) d.observeSample(table([]), t, WALL0 + t);
    strictEqual(d.observeEvent(heartbeat('x'), 600 * SEC + 1, WALL0 + 600 * SEC + 1), null);
    strictEqual(d.observeSample(table([proc(1001, { cpuMs: 2 * SEC, ageMs: 5 * SEC })]), 601 * SEC, WALL0 + 601 * SEC), null);
    strictEqual(d.verdict, 'active', 'its CPU, seen at the sample, keeps it active');
    // A forward wall-clock step before the heartbeat: unknown at the sample.
    const d2 = S.createStallDetector({ workerPid: W, startMono: 0, startWall: WALL0 });
    for (let t = 10 * SEC; t <= 590 * SEC; t += 10 * SEC) d2.observeSample(table([]), t, WALL0 + t);
    strictEqual(d2.observeEvent(heartbeat('x'), 600 * SEC + 1, WALL0 + 30 * MIN), null);
    strictEqual(d2.observeSample(table([]), 600 * SEC + 5, WALL0 + 30 * MIN).verdict, 'unknown');
  });

  it('no sample for over three intervals is unknown, never stalled', () => {
    const { records } = timeline({ until: 11 * MIN, snap: (t) => (t <= 9 * MIN ? table([]) : undefined) });
    deepStrictEqual(verdicts(records), []);
    const d = S.createStallDetector({ workerPid: W, startMono: 0, startWall: WALL0 });
    for (let t = 10 * SEC; t <= 9 * MIN; t += 10 * SEC) d.observeSample(table([]), t, WALL0 + t);
    const r = d.observeEvent(heartbeat('x'), 11 * MIN, WALL0 + 11 * MIN);
    strictEqual(r.verdict, 'unknown');
    strictEqual(r.why, 'no-sample');
    const late = S.createStallDetector({ workerPid: W, startMono: 0, startWall: WALL0 });
    late.observeSample(table([]), 10 * SEC, WALL0);
    ok(late.observeEvent(heartbeat('x'), 20 * MIN, WALL0).unknown_ms <= 10 * MIN, 'the unknown time is the window\'s at most');
  });
});

describe('the clocks (Decision 3, item 5)', () => {
  it('a suspend longer than an interval between two samples an interval apart on the monotonic clock is unknown', () => {
    const { records } = timeline({
      until: 11 * MIN, snap: () => table([]), wall: (t) => WALL0 + t + (t >= 5 * MIN ? 20 * MIN : 0),
    });
    deepStrictEqual(verdicts(records), [[600, 'unknown']]);
    strictEqual(records[0].why, 'clock');
  });

  it('a suspend shorter than an interval, and a wall-clock step backward, change no verdict', () => {
    for (const shift of [5 * SEC, -30 * MIN]) {
      const { records } = timeline({ until: 11 * MIN, snap: () => table([]), wall: (t) => WALL0 + t + (t >= 5 * MIN ? shift : 0) });
      deepStrictEqual(verdicts(records), [[600, 'stalled']], `shift ${shift}`);
    }
  });

  it('samples spaced more than three intervals apart on the monotonic clock are unknown', () => {
    const { records } = timeline({ until: 11 * MIN, snap: (t) => (t > 3 * MIN && t < 3 * MIN + 40 * SEC ? undefined : table([])) });
    deepStrictEqual(verdicts(records), [[600, 'unknown']]);
    strictEqual(records[0].why, 'spacing');
  });

  it('irregular spacing: CPU and unknown intervals each leave the window with their end', () => {
    // Samples at irregular times; one burst of 2 s at 1:07 and a failed
    // sample at 3:33. At 11:07 the burst's interval has left; at 13:33+ the
    // unknown ones have too.
    const times = [];
    for (let t = 7 * SEC; t <= 15 * MIN; t += (times.length % 3 === 0 ? 7 : 13) * SEC) times.push(t);
    const d = S.createStallDetector({ workerPid: W, startMono: 0, startWall: WALL0 });
    const out = [];
    let cpu = 0;
    for (const t of times) {
      if (Math.abs(t - 67 * SEC) < 7 * SEC && cpu === 0) cpu = 2000;
      const s = Math.abs(t - 213 * SEC) < 7 * SEC ? { ok: false, why: 'failed' } : table([proc(1001, { cpuMs: cpu, ageMs: t })]);
      const r = d.observeSample(s, t, WALL0 + t);
      if (r) out.push([t, r.verdict]);
    }
    deepStrictEqual(out.map(([, v]) => v), ['unknown', 'stalled']);
    ok(out[0][0] >= 10 * MIN && out[0][0] < 11 * MIN + 30 * SEC, `unknown once the burst left: ${out[0][0]}`);
    ok(out[1][0] > 13 * MIN + 33 * SEC && out[1][0] < 14 * MIN, `stalled once the unknown left: ${out[1][0]}`);
  });
});

describe('what the verdict records (Decision 3, item 2)', () => {
  it('a subagent\'s heartbeat is not the step\'s foreground tool; a tool stops at its tool_result or 75 s after its last heartbeat', () => {
    const d = S.createStallDetector({ workerPid: W, startMono: 0, startWall: WALL0 });
    d.observeEvent(assistantToolUse('main_1'), 1 * SEC, WALL0);
    d.observeEvent({ type: 'assistant', parent_tool_use_id: 'task_1', message: { content: [{ type: 'tool_use', id: 'sub_1' }] } }, 2 * SEC, WALL0);
    // The subagent's tool beats until the verdict.
    for (let t = 10 * SEC; t <= 10 * MIN; t += 10 * SEC) {
      d.observeEvent(heartbeat('sub_1'), t - 5 * SEC, WALL0);
      d.observeSample(table([]), t, WALL0 + t);
    }
    let r = d.observeSample(table([]), 10 * MIN + 10 * SEC, WALL0);
    strictEqual(r.verdict, 'stalled');
    strictEqual(r.tool_running, false, 'a subagent tool\'s heartbeat');
    strictEqual(r.answer_owed, false, 'the model asked for a tool');

    const d2 = S.createStallDetector({ workerPid: W, startMono: 0, startWall: WALL0 });
    d2.observeEvent(assistantToolUse('main_1'), 1 * SEC, WALL0);
    for (let t = 30 * SEC; t <= 8 * MIN; t += 30 * SEC) d2.observeEvent(heartbeat('main_1'), t, WALL0 + t);
    for (let t = 10 * SEC; t <= 10 * MIN; t += 10 * SEC) d2.observeSample(table([]), t, WALL0 + t);
    r = d2.observeSample(table([]), 10 * MIN + 10 * SEC, WALL0);
    strictEqual(r.verdict, 'stalled');
    strictEqual(r.tool_running, false, '75 s after its last heartbeat (8:00)');
  });

  it('a tool result owes an answer, and ends its tool', () => {
    // A grace longer than the window: only the result can end the tool.
    const d = S.createStallDetector({ workerPid: W, startMono: 0, startWall: WALL0, heartbeatGraceMs: 30 * MIN });
    d.observeEvent(assistantToolUse('main_1'), 1 * SEC, WALL0);
    d.observeEvent(heartbeat('main_1'), 20 * SEC, WALL0);
    d.observeEvent(toolResult('main_1'), 25 * SEC, WALL0);
    for (let t = 10 * SEC; t <= 10 * MIN + 30 * SEC; t += 10 * SEC) {
      const r = d.observeSample(table([]), t, WALL0 + t);
      if (r) deepStrictEqual([r.verdict, r.tool_running, r.answer_owed], ['stalled', false, true]);
    }
    strictEqual(d.verdict, 'stalled');
  });

  it('a background task, a foreground tool and an owed answer are recorded together', () => {
    const d = S.createStallDetector({ workerPid: W, startMono: 0, startWall: WALL0 });
    d.observeEvent({ type: 'system', subtype: 'background_tasks_changed', tasks: [{}, {}] }, 1 * SEC, WALL0);
    d.observeEvent(assistantToolUse('main_1'), 2 * SEC, WALL0);
    d.observeEvent({ type: 'system', subtype: 'task_notification' }, 3 * SEC, WALL0);
    let r = null;
    for (let t = 10 * SEC; t <= 10 * MIN + 10 * SEC; t += 10 * SEC) {
      // Each observation judges, a heartbeat's too.
      r = d.observeEvent(heartbeat('main_1'), t - 5 * SEC, WALL0) ?? r;
      r = d.observeSample(table([]), t, WALL0 + t) ?? r;
    }
    deepStrictEqual([r.verdict, r.pending_tasks, r.tool_running, r.answer_owed], ['stalled', 2, true, true]);
  });

  it('the summary: longest quiet, lowest known window, unknown time, counts, the longest owed answer, each stalled wait', () => {
    const { d } = timeline({
      until: 25 * MIN,
      snap: (t) => (t === 20 * MIN ? { ok: false, why: 'failed' } : table([])),
      events: [[2 * MIN, { type: 'assistant', parent_tool_use_id: null, message: { content: [] } }],
        [15 * MIN, { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'x' }] } }]],
    });
    // Stalled at 12:00, active at 15:00, unknown at 25:00 (its window holds
    // the failed sample at 20:00), still unknown at the close.
    const { record, summary } = d.close(25 * MIN + 5 * SEC, WALL0 + 25 * MIN + 5 * SEC);
    strictEqual(record, null);
    strictEqual(summary.longest_quiet_ms, 13 * MIN, 'from 2:00 to 15:00');
    strictEqual(summary.lowest_window_cpu_ms, 0);
    strictEqual(summary.unknown_ms, 20 * SEC);
    deepStrictEqual(summary.verdict_counts, { active: 2, stalled: 1, unknown: 1 });
    strictEqual(summary.answer_owed_max_ms, 10 * MIN + 5 * SEC, 'owed from the tool result at 15:00 to the close; the first, from the prompt, 2:00');
    strictEqual(summary.stalled_waits.length, 1);
    deepStrictEqual(Object.keys(summary.stalled_waits[0]), ['at', 'quiet_ms', 'window_cpu_ms', 'pending_tasks', 'tool_running', 'answer_owed']);
    strictEqual(summary.stalled_waits[0].at, new Date(WALL0 + 12 * MIN).toISOString());
    strictEqual(summary.last, 'unknown');
  });

  it('the stalled waits are bounded, the rest counted', () => {
    const d = S.createStallDetector({ workerPid: W, startMono: 0, startWall: WALL0, stalledWaitsMax: 2 });
    let t = 0;
    for (let k = 0; k < 4; k += 1) {
      for (let i = 0; i < 62; i += 1) { t += 10 * SEC; d.observeSample(table([]), t, WALL0 + t); }
      d.observeEvent({ type: 'result' }, t + 1, WALL0 + t);
    }
    const s = d.summary();
    strictEqual(s.stalled_waits.length, 2);
    strictEqual(s.stalled_waits_truncated, 2);
    strictEqual(s.verdict_counts.stalled, 4);
  });

  it('close records the final verdict (never stalled, whose CPU it has not seen), and nothing is observed after it', () => {
    const d = S.createStallDetector({ workerPid: W, startMono: 0, startWall: WALL0 });
    for (let t = 10 * SEC; t <= 10 * MIN - 10 * SEC; t += 10 * SEC) d.observeSample(table([]), t, WALL0 + t);
    strictEqual(d.close(10 * MIN + 1, WALL0 + 10 * MIN).record, null);
    const d2 = S.createStallDetector({ workerPid: W, startMono: 0, startWall: WALL0 });
    for (let t = 10 * SEC; t <= 5 * MIN; t += 10 * SEC) d2.observeSample(table([]), t, WALL0 + t);
    const { record, summary } = d2.close(11 * MIN, WALL0 + 11 * MIN);
    deepStrictEqual([record.verdict, record.why], ['unknown', 'no-sample']);
    strictEqual(summary.last, 'unknown');
    strictEqual(d2.observeEvent({ type: 'result' }, 12 * MIN, WALL0), null);
    strictEqual(d2.observeSample(table([]), 12 * MIN, WALL0), null);
  });

  it('the steps.jsonl line and the halt detail', () => {
    const r = { verdict: 'stalled', at: '2026-10-29T00:10:00.000Z', quiet_ms: 600000.4, window_cpu_ms: 12.6, unknown_ms: 0, pending_tasks: 1, tool_running: false, answer_owed: true, why: 'quiet-and-idle' };
    deepStrictEqual(S.stallStepLine(r, { seq: 3, lane: 'a', mode: 'log' }), {
      event: 'stall', seq: 3, lane: 'a', at: r.at, mode: 'log', verdict: 'stalled', quiet_ms: 600000, window_cpu_ms: 13,
      unknown_ms: 0, pending_tasks: 1, tool_running: false, answer_owed: true, why: 'quiet-and-idle',
    });
    strictEqual(S.stalledDetail(r), 'the step stalled: no stream activity for 10 min and its descendants used 0.01 s of CPU in the last 10 min (waiting on: an answer of the model owed, 1 background task pending); its process group was killed');
  });
});
