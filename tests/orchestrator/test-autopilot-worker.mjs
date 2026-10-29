// tests/orchestrator/test-autopilot-worker.mjs
//
// ADR-0063 D5/D7 — the autopilot's worker host (plugins/orchestrator/
// adapters/claude/autopilot/worker.mjs), against a fake `claude`
// (tests/orchestrator/fixtures/autopilot-fake-claude.mjs, through
// AUTOPILOT_CLAUDE_BIN): stdin is held open until a result has arrived and no
// background task or follow-up turn is pending (probe D2), a PreCompact event
// and a timeout abort the step and kill the whole process group, the context
// sensor counts main-thread messages only, the posture never escalates, the
// environment is scrubbed, and network pushes fail at the git level. The
// stall watch (ADR-0068 Decision 3, items 7, 8 and 10) against a fake sampler
// on a clock the test moves: log mode records and never stops the step; `on`
// aborts a stalled step as a timeout does; a worker that ignores an idle close
// of stdin is judged until it exits; a close on a finished report, an abort
// and the worker's exit end the watch. The run's sampler:
// test-autopilot-stall-sampler.mjs.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const W = await import(resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/worker.mjs'));
const FAKE = resolve(REPO_ROOT, 'tests/orchestrator/fixtures/autopilot-fake-claude.mjs');
const SM = await import(resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/stall-sampler.mjs'));
chmodSync(FAKE, 0o755);

const RUN = 'autopilot-20261001T000000Z-123456';
const ROOTS = { orchestrator: '/roots/orchestrator', engineer: '/roots/engineer', runtime: '/roots/runtime' };

function scratch() {
  return mkdtempSync(join(tmpdir(), 'autopilot-worker-'));
}

async function run(mode, over = {}, envOver = {}) {
  const dir = scratch();
  const log = join(dir, 'claude.log');
  try {
    const handle = W.startWorker({
      cwd: dir, prompt: '/engineer:critique', stepKind: 'verb', runId: RUN, seq: 1, roots: ROOTS,
      stepBudgetUsd: 1, stepTimeoutSec: 30, model: null, effort: null, rawPath: join(dir, 'worker-1.jsonl'),
      env: { ...process.env, AUTOPILOT_CLAUDE_BIN: FAKE, FAKE_CLAUDE_MODE: mode, FAKE_CLAUDE_LOG: log, ...envOver },
      ...over,
    });
    if (!over.noBegin) handle.begin();
    const w = await handle.done;
    const lines = existsSync(join(dir, 'worker-1.jsonl'))
      ? readFileSync(join(dir, 'worker-1.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
      : [];
    const started = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
    return { w, lines, started, dir };
  } finally {
    if (!over.keep) rmSync(dir, { recursive: true, force: true });
  }
}

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

describe('stream-json hosting', () => {
  it('hands every rate_limit_event to the driver as it comes, and keeps the last (ADR-0067 Decision 6, Throttle)', async () => {
    const infos = [
      { status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1791572400, unifiedWindows: { five_hour: { utilization: 0.4, resetsAt: 1791572400 } } },
      { status: 'allowed_warning', rateLimitType: 'seven_day', resetsAt: 1791792000, utilization: 0.81, unifiedWindows: { seven_day: { utilization: 0.81, resetsAt: 1791792000 } } },
    ];
    const seen = [];
    const { w } = await run('simple', { onRateLimit: (info) => seen.push(info) }, { FAKE_RATE_LIMIT: JSON.stringify(infos) });
    deepStrictEqual(seen, infos, 'each event, in stream order');
    deepStrictEqual(w.rateLimit, infos[1]);
    strictEqual(w.exitCode, 0);
  });

  it('a throwing rate-limit callback does not stop the stream', async () => {
    const { w } = await run('simple', { onRateLimit: () => { throw new Error('driver bug'); } }, { FAKE_RATE_LIMIT: JSON.stringify({ status: 'allowed' }) });
    strictEqual(w.exitCode, 0);
    strictEqual(w.costUsd, 0.05, 'the result after the event is still read');
  });

  it('holds stdin open until the background task and its follow-up turn finish (probe D2)', async () => {
    const { w, lines } = await run('background');
    strictEqual(w.turns, 2);
    strictEqual(w.costUsd, 0.15, 'the step costs what the last result reports (cumulative)');
    strictEqual(w.peakCtx, 52010);
    const closedAt = lines.findIndex((e) => e.subtype === 'fake_stdin_closed');
    const lastResult = lines.map((e) => e.type).lastIndexOf('result');
    ok(closedAt > lastResult, 'stdin closes only after the follow-up result');
    strictEqual(w.exitCode, 0);
  });

  it('the step\'s report is the follow-up turn\'s, not the one taken while the task was pending', async () => {
    // The worker prompt tells the model a report filed while it waits is
    // provisional and only the last one counts; this is the host side of that.
    const first = { outcome: 'failed', workflow: 'refine-x', next_step: null, awaiting_owner: null, summary: 'provisional: waiting for the peer' };
    const last = { outcome: 'completed', workflow: 'refine-x', next_step: { kind: 'commit', verb: null, confidence: 'HIGH' }, awaiting_owner: null, summary: 'settled' };
    const { w } = await run('background', {}, { FAKE_FIRST_REPORT: JSON.stringify(first), FAKE_REPORT: JSON.stringify(last) });
    strictEqual(w.turns, 2);
    deepStrictEqual(w.report, last);
  });

  it('waits out a background task and a follow-up turn that each outlast the 2 s close debounce', async () => {
    const { w, lines } = await run('background-slow');
    strictEqual(w.turns, 2, 'stdin stayed open for the follow-up turn');
    strictEqual(w.costUsd, 0.15);
    const closedAt = lines.findIndex((e) => e.subtype === 'fake_stdin_closed');
    ok(closedAt > lines.map((e) => e.type).lastIndexOf('result'));
  });

  it('a simple step resolves with one turn and its report', async () => {
    const report = { outcome: 'completed', workflow: 'compose-x', next_step: null, awaiting_owner: null, summary: 's' };
    const { w } = await run('simple', {}, { FAKE_REPORT: JSON.stringify(report) });
    deepStrictEqual([w.turns, w.exitCode, w.aborted, w.costUsd], [1, 0, null, 0.05]);
    deepStrictEqual(w.report, report);
    deepStrictEqual(w.lastResult, { is_error: false, subtype: 'success', num_turns: 1 });
  });

  it('a PreCompact hook event aborts the step', async () => {
    const { w } = await run('precompact');
    strictEqual(w.aborted, 'compaction-imminent');
    strictEqual(w.costUsd, null, 'a killed worker reports no cost; the driver charges its budget');
  });

  it('a timeout kills the whole process group, a grandchild included', async () => {
    const dir = scratch();
    const pidfile = join(dir, 'grandchild.pid');
    try {
      const { w } = await run('hang', { stepTimeoutSec: 1 }, { FAKE_CLAUDE_PIDFILE: pidfile });
      strictEqual(w.aborted, 'timeout');
      ok(w.groupTeardown === 'empty' || w.groupTeardown === 'terminated', `the whole group took the SIGTERM, and nothing needed SIGKILL: ${w.groupTeardown}`);
      const grandchild = Number(readFileSync(pidfile, 'utf8'));
      ok(Number.isInteger(grandchild) && grandchild > 0);
      for (let i = 0; i < 50 && alive(grandchild); i += 1) await new Promise((r) => { setTimeout(r, 100); });
      ok(!alive(grandchild), `grandchild ${grandchild} survived the group kill`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the kill escalates to SIGKILL for a group member that ignores SIGTERM, after the worker itself is gone', async () => {
    const dir = scratch();
    const pidfile = join(dir, 'grandchild.pid');
    try {
      const { w } = await run('stubborn', { stepTimeoutSec: 1 }, { FAKE_CLAUDE_PIDFILE: pidfile });
      strictEqual(w.aborted, 'timeout');
      strictEqual(w.groupTeardown, 'killed');
      // Checked at once: the step is not over while its group holds anything.
      const grandchild = Number(readFileSync(pidfile, 'utf8'));
      ok(!alive(grandchild), `grandchild ${grandchild} survived SIGTERM and the escalation`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a descendant that keeps the output pipes open does not hold the step open', { timeout: 60_000 }, async () => {
    const dir = scratch();
    const pidfile = join(dir, 'holder.pid');
    let holder = null;
    // A watchdog, so that a host that does wait on the pipes fails this test
    // instead of hanging the run: it kills the holder after 20 s.
    let watchdog = null;
    const watch = (async () => {
      for (let i = 0; i < 100 && !existsSync(pidfile); i += 1) await new Promise((r) => { setTimeout(r, 50); });
      const pid = Number(readFileSync(pidfile, 'utf8'));
      watchdog = setTimeout(() => { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }, 20_000);
    })();
    try {
      const t0 = Date.now();
      const { w } = await run('pipe-holder', { stepTimeoutSec: 60 }, { FAKE_CLAUDE_PIDFILE: pidfile });
      await watch;
      clearTimeout(watchdog);
      holder = Number(readFileSync(pidfile, 'utf8'));
      ok(alive(holder), 'the holder is outside the worker\'s group and still holds the pipes');
      deepStrictEqual([w.exitCode, w.turns, w.aborted], [0, 1, null]);
      ok(Date.now() - t0 < 20_000, `the step ended ${Date.now() - t0} ms after it started`);
    } finally {
      clearTimeout(watchdog);
      if (holder) { try { process.kill(holder, 'SIGKILL'); } catch { /* gone */ } }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a worker that ignores SIGTERM itself is killed after the grace', { timeout: 60_000 }, async () => {
    const dir = scratch();
    const pidfile = join(dir, 'worker.pid');
    // A watchdog, so that a host that never escalates fails this test instead
    // of hanging the run.
    let watchdog = null;
    const watch = (async () => {
      for (let i = 0; i < 100 && !existsSync(pidfile); i += 1) await new Promise((r) => { setTimeout(r, 50); });
      const pid = Number(readFileSync(pidfile, 'utf8'));
      watchdog = setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }, 20_000);
    })();
    try {
      const t0 = Date.now();
      const { w } = await run('deaf', { stepTimeoutSec: 1 }, { FAKE_CLAUDE_PIDFILE: pidfile });
      await watch;
      clearTimeout(watchdog);
      deepStrictEqual([w.aborted, w.signal], ['timeout', 'SIGKILL']);
      ok(Date.now() - t0 < 15_000, `the step ended ${Date.now() - t0} ms after it started`);
    } finally {
      clearTimeout(watchdog);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a step that ends normally leaves nothing running in its process group', async () => {
    const dir = scratch();
    const pidfile = join(dir, 'grandchild.pid');
    try {
      const { w } = await run('leaves-child', {}, { FAKE_CLAUDE_PIDFILE: pidfile });
      deepStrictEqual([w.exitCode, w.aborted, w.groupTeardown], [0, null, 'terminated']);
      const grandchild = Number(readFileSync(pidfile, 'utf8'));
      ok(!alive(grandchild), `grandchild ${grandchild} outlived its step`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the worker gets no prompt until begin(): a driver that dies before it leaves a worker with nothing to do', async () => {
    const dir = scratch();
    try {
      const handle = W.startWorker({
        cwd: dir, prompt: '/engineer:critique', stepKind: 'verb', runId: RUN, seq: 1, roots: ROOTS,
        stepBudgetUsd: 1, stepTimeoutSec: 30, model: null, effort: null, rawPath: join(dir, 'worker-1.jsonl'),
        env: { ...process.env, AUTOPILOT_CLAUDE_BIN: FAKE, FAKE_CLAUDE_MODE: 'simple' },
      });
      await new Promise((r) => { setTimeout(r, 700); });
      strictEqual(readFileSync(join(dir, 'worker-1.jsonl'), 'utf8'), '', 'no output: the worker never saw a message');
      handle.abort('interrupted');
      const w = await handle.done;
      deepStrictEqual([w.aborted, w.turns], ['interrupted', 0]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a raw-stream path that cannot be opened fails before any worker starts', () => {
    const dir = scratch();
    const log = join(dir, 'claude.log');
    try {
      throws(() => W.startWorker({
        cwd: dir, prompt: '/engineer:critique', stepKind: 'verb', runId: RUN, seq: 1, roots: ROOTS,
        stepBudgetUsd: 1, stepTimeoutSec: 30, model: null, effort: null, rawPath: join(dir, 'missing', 'worker-1.jsonl'),
        env: { ...process.env, AUTOPILOT_CLAUDE_BIN: FAKE, FAKE_CLAUDE_LOG: log },
      }), /ENOENT/);
      ok(!existsSync(log), 'no worker was spawned');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a worker that exits without a result is reported as such', async () => {
    const { w } = await run('noresult');
    deepStrictEqual([w.exitCode, w.lastResult, w.report, w.costUsd], [3, null, null, null]);
  });

  it('a binary that does not start is a spawn error, not a hang', async () => {
    const { w } = await run('simple', {}, { AUTOPILOT_CLAUDE_BIN: '/nonexistent/claude' });
    ok(w.spawnError, 'spawnError is set');
    strictEqual(w.lastResult, null);
  });

  it('the raw stream is capped, with a marker', async () => {
    const { w, lines } = await run('background', { rawMaxBytes: 300 });
    strictEqual(w.rawTruncated, true);
    strictEqual(lines.at(-1).subtype, 'raw_stream_truncated');
    strictEqual(w.turns, 2, 'the host still read the whole stream');
  });
});

describe('C127: a finished report ends the step, whatever background tasks are pending', () => {
  // Short timings: the close debounce, the grace after EOF, the kill grace.
  const timing = { closeDebounceMs: 300, reportExitGraceMs: 600, killGraceMs: 600 };
  const finished = { outcome: 'completed', workflow: 'compose-x', next_step: null, awaiting_owner: null, summary: 'done', waiting_on_background: false };
  const waiting = { ...finished, outcome: 'failed', summary: 'provisional', waiting_on_background: true };
  const task = { task_id: 't9', run_id: 'r-t9', task_type: 'local_bash', description: 'a monitor' };
  const tasks = (...ts) => ({ type: 'system', subtype: 'background_tasks_changed', tasks: ts });
  const events = (list) => ({ FAKE_EVENTS: JSON.stringify(list) });
  const closedAt = (lines) => lines.findIndex((e) => e.subtype === 'fake_stdin_closed');
  const timed = async (...a) => {
    const t0 = Date.now();
    const r = await run(...a);
    return { ...r, ms: Date.now() - t0 };
  };

  it('a finished report with a never-ending background task ends the step ok, tears its group down, and names the task', async () => {
    const dir = scratch();
    const pidfile = join(dir, 'task.pid');
    try {
      const { w, ms } = await timed('background-forever', { timing, stepTimeoutSec: 30 }, { FAKE_CLAUDE_PIDFILE: pidfile });
      deepStrictEqual([w.aborted, w.exitCode, w.reportEof, w.closedOnReport, w.reportTeardown, w.costUsd], [null, 0, true, true, null, 0.12]);
      deepStrictEqual(w.abandonedBackground, [{ task_id: 'bt1', task_type: 'local_bash', description: 'Run the full suite in background', run_id: 'r-bt1' }]);
      strictEqual(w.groupTeardown, 'terminated', 'the background task was still in the group, and was ended');
      const pid = Number(readFileSync(pidfile, 'utf8'));
      ok(!alive(pid), `the background task ${pid} outlived its step`);
      ok(ms < 10_000, `the step ended ${ms} ms after it started, not at its timeout`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a report that says it waits keeps the step open, as today, to its timeout', async () => {
    const dir = scratch();
    const pidfile = join(dir, 'task.pid');
    try {
      const { w, lines } = await run('background-forever', { timing, stepTimeoutSec: 2 }, { FAKE_CLAUDE_PIDFILE: pidfile, FAKE_REPORT: JSON.stringify(waiting) });
      deepStrictEqual([w.aborted, w.closedOnReport, w.abandonedBackground], ['timeout', false, []]);
      strictEqual(closedAt(lines), -1, 'stdin never closed');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a report with the field missing, mistyped, or another field invalid never closes the step early; nor does an error result', async () => {
    const { waiting_on_background: _drop, ...missing } = finished;
    const cases = [
      ['missing', { result: missing }],
      ['a string', { result: { ...finished, waiting_on_background: 'false' } }],
      ['no summary', { result: (({ summary: _s, ...r }) => r)(finished) }],
      ['a bad outcome', { result: { ...finished, outcome: 'done' } }],
      ['an unknown field', { result: { ...finished, extra: 1 } }],
      ['an error result', { type: 'result', subtype: 'error_during_execution', is_error: true, structured_output: finished }],
    ];
    for (const [label, ev] of cases) {
      const { w, lines } = await run('events', { timing, stepTimeoutSec: 2 }, events([{ event: tasks(task) }, { event: ev }]));
      strictEqual(w.aborted, 'timeout', label);
      strictEqual(closedAt(lines), -1, `${label}: stdin never closed`);
    }
  });

  it('true then false within the debounce: the later, waiting report disarms the close', async () => {
    const { w, lines } = await run('events', { timing, stepTimeoutSec: 2 }, events([
      { event: tasks(task) }, { event: { result: finished } }, { delay: 100, event: { result: waiting } },
    ]));
    deepStrictEqual([w.aborted, w.closedOnReport, closedAt(lines)], ['timeout', false, -1]);
  });

  it('false then true within the debounce: the later, finished report closes the step on itself', async () => {
    const { w } = await run('events', { timing, stepTimeoutSec: 10 }, events([
      { event: tasks(task) }, { event: { result: waiting } }, { delay: 100, event: { result: finished } },
    ]));
    deepStrictEqual([w.aborted, w.closedOnReport, w.turns, w.exitCode], [null, true, 2, 0]);
    deepStrictEqual(w.report, finished);
    deepStrictEqual(w.abandonedBackground.map((t) => t.task_id), ['t9']);
  });

  it('a task notification during the debounce disarms the close; the follow-up turn then ends the step the usual way', async () => {
    const { w, lines } = await run('events', { timing, stepTimeoutSec: 10 }, events([
      { event: tasks(task) }, { event: { result: finished } },
      { delay: 100, event: { type: 'system', subtype: 'task_notification', task_id: 't9', status: 'completed' } },
      { delay: 700, event: tasks() }, { event: { result: finished, cost: 0.2 } },
    ]));
    deepStrictEqual([w.aborted, w.closedOnReport, w.turns, w.costUsd], [null, false, 2, 0.2]);
    ok(closedAt(lines) > lines.map((e) => e.type).lastIndexOf('result'), 'stdin closed after the follow-up result');
  });

  it('other stream events do not push the close back (armed once per result)', async () => {
    const chatter = Array.from({ length: 40 }, () => ({ delay: 100, event: { type: 'system', subtype: 'hook_response', hook_event: 'Stop' } }));
    const { w, ms } = await timed('events', { timing, stepTimeoutSec: 20 }, events([{ event: tasks(task) }, { event: { result: finished } }, ...chatter]));
    deepStrictEqual([w.aborted, w.closedOnReport], [null, true]);
    ok(ms < 2500, `the close waited for the chatter to stop (${ms} ms; 4 s of events)`);
  });

  it('a host that ignores stdin closure is signalled after the grace, and events after EOF do not re-arm it', async () => {
    const { w, ms } = await timed('events', { timing, stepTimeoutSec: 20 }, {
      ...events([
        { event: tasks(task) }, { event: { result: finished } },
        { delay: 500, event: { type: 'system', subtype: 'task_notification', task_id: 't9', status: 'completed' } },
        { delay: 100, event: { type: 'system', subtype: 'hook_response', hook_event: 'Stop' } },
      ]),
      FAKE_IGNORE_STDIN_CLOSE: '1',
    });
    deepStrictEqual([w.aborted, w.closedOnReport, w.reportTeardown, w.signal], [null, true, 'signalled', 'SIGTERM']);
    ok(ms < 5000, `bounded: ${ms} ms`);
  });

  it('a host that ignores stdin closure and SIGTERM is killed after the kill grace', async () => {
    const dir = scratch();
    const pidfile = join(dir, 'task.pid');
    try {
      const { w, ms } = await timed('background-forever', { timing, stepTimeoutSec: 20 }, { FAKE_CLAUDE_PIDFILE: pidfile, FAKE_IGNORE_STDIN_CLOSE: '1', FAKE_IGNORE_SIGTERM: '1' });
      deepStrictEqual([w.aborted, w.closedOnReport, w.reportTeardown, w.signal], [null, true, 'killed', 'SIGKILL']);
      ok(!alive(Number(readFileSync(pidfile, 'utf8'))), 'the background task is gone');
      ok(ms < 8000, `bounded: ${ms} ms`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a result after EOF ends the exemption, never the history: the EOF, the abandoned tasks and the teardown stay on record', async () => {
    const { w } = await run('events', { timing: { ...timing, reportExitGraceMs: 1500 }, stepTimeoutSec: 20 }, {
      ...events([{ event: tasks(task) }, { event: { result: finished } }, { delay: 600, event: { result: { ...finished, summary: 'later' } } }]),
      FAKE_IGNORE_STDIN_CLOSE: '1',
    });
    deepStrictEqual([w.reportEof, w.closedOnReport, w.abandonedBackground.map((t) => t.task_id), w.reportTeardown, w.report.summary], [true, false, ['t9'], 'signalled', 'later']);
  });

  it('a worker that exits before the debounce fires is never closed on its report: its exit is judged', async () => {
    const dir = scratch();
    const pidfile = join(dir, 'holder.pid');
    try {
      const { w } = await run('events', { timing: { ...timing, closeDebounceMs: 1500 }, stepTimeoutSec: 20 }, {
        ...events([{ event: tasks(task) }, { event: { result: finished } }, { delay: 300, event: { exit: 1, holdPipes: true } }]),
        FAKE_CLAUDE_PIDFILE: pidfile,
      });
      deepStrictEqual([w.exitCode, w.reportEof, w.closedOnReport], [1, false, false]);
    } finally {
      try { process.kill(Number(readFileSync(pidfile, 'utf8')), 'SIGKILL'); } catch { /* gone */ }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the task list moving to empty and back does not push an armed close back', async () => {
    const { w, lines } = await run('events', { timing: { ...timing, closeDebounceMs: 1000 }, stepTimeoutSec: 20 }, events([
      { event: tasks(task) }, { event: { result: finished } },
      { delay: 500, event: tasks() }, { delay: 700, event: tasks({ ...task, task_id: 't10' }) },
    ]));
    deepStrictEqual([w.aborted, w.closedOnReport], [null, true]);
    strictEqual(lines.filter((e) => e.subtype === 'background_tasks_changed').length, 2, 'stdin closed at 1 s, before the task list moved back at 1.2 s');
  });

  it('a PreCompact event during the debounce, and a timeout during the grace, keep their abort', async () => {
    const pre = await run('events', { timing, stepTimeoutSec: 10 }, events([
      { event: tasks(task) }, { event: { result: finished } },
      { delay: 100, event: { type: 'system', subtype: 'hook_started', hook_event: 'PreCompact' } },
    ]));
    deepStrictEqual([pre.w.aborted, pre.w.closedOnReport], ['compaction-imminent', false]);
    const late = await run('events', { timing: { ...timing, reportExitGraceMs: 5000 }, stepTimeoutSec: 1 }, {
      ...events([{ event: tasks(task) }, { event: { result: finished } }]), FAKE_IGNORE_STDIN_CLOSE: '1',
    });
    deepStrictEqual([late.w.aborted, late.w.reportTeardown], ['timeout', null]);
  });

  it('the cost of a step closed on its report: reported, zero, or missing (then the driver charges the budget)', async () => {
    for (const [cost, want] of [[0.3, 0.3], [0, 0], [null, null]]) {
      const { w } = await run('events', { timing, stepTimeoutSec: 10 }, events([{ event: tasks(task) }, { event: { result: finished, cost } }]));
      deepStrictEqual([w.closedOnReport, w.costUsd], [true, want], String(cost));
    }
  });
});

describe('the context sensor (D7)', () => {
  it('divides each model\'s peak by that model\'s window', async () => {
    const { w } = await run('two-models');
    // fake-model: 40010 of 1,000,000; fake-subagent-model on the main thread:
    // 52010 of 200,000 — the step's peak share is the second.
    strictEqual(w.peakCtx, 52010);
    strictEqual(w.contextWindow, 200000);
    strictEqual(w.peakPct, 52010 / 200000);
  });

  it('counts main-thread messages only, against their own model\'s window', async () => {
    const { w } = await run('subagent');
    strictEqual(w.peakCtx, 40010, 'the subagent\'s 190K context is its own, not the step\'s');
    strictEqual(w.contextWindow, 1000000);
    strictEqual(w.peakPct, 40010 / 1000000);
  });

  it('records the share when the result keys the model with a window suffix (C136: `<model>[1m]`)', async () => {
    const { w } = await run('simple', {}, { FAKE_MODEL_USAGE: JSON.stringify({ 'fake-model[1m]': { contextWindow: 1000000 } }) });
    strictEqual(w.peakCtx, 40010);
    strictEqual(w.contextWindow, 1000000);
    strictEqual(w.peakPct, 40010 / 1000000);
  });

  it('contextWindowFor: the key as written first, then the model without its suffix, on both sides, the largest window whatever the keys\' order', () => {
    const cw = (usage, model) => W.contextWindowFor(usage, model);
    strictEqual(cw({ 'claude-opus-4-7[1m]': { contextWindow: 1_000_000 } }, 'claude-opus-4-7'), 1_000_000);
    strictEqual(cw({ 'claude-opus-4-7': { contextWindow: 200_000 } }, 'claude-opus-4-7[1m]'), 200_000, 'a suffixed sample model finds its plain key');
    strictEqual(cw({ m: { contextWindow: 200_000 }, 'm[1m]': { contextWindow: 1_000_000 } }, 'm'), 200_000, 'an exact key decides');
    strictEqual(cw({ m: {}, 'm[1m]': { contextWindow: 1_000_000 } }, 'm'), 1_000_000, 'an exact key without a usable window falls to the normalized ones');
    strictEqual(cw({ m: { contextWindow: 0 }, 'm[x]': { contextWindow: 'big' } }, 'm'), null);
    strictEqual(cw({ 'm[a]': { contextWindow: 200_000 }, 'm[1m]': { contextWindow: 1_000_000 } }, 'm'), 1_000_000);
    strictEqual(cw({ 'm[1m]': { contextWindow: 1_000_000 }, 'm[a]': { contextWindow: 200_000 } }, 'm'), 1_000_000, 'the same answer in the other order');
    strictEqual(cw({ 'mm[1m]': { contextWindow: 1_000_000 }, 'other': { contextWindow: 5 } }, 'm'), null, 'another model is not this one');
    strictEqual(cw({ '[1m]': { contextWindow: 1_000_000 } }, ''), null, 'no model names no window');
    strictEqual(cw(null, 'm'), null);
  });
});

describe('plugin provenance at init', () => {
  it('aborts before the first turn when checkInit refuses the loaded plugins', async () => {
    const plugins = [{ name: 'engineer', path: '/repo/plugins/engineer', source: 'engineer@agentic-plugins', version: '0.23.0' }];
    let seen = null;
    const { w } = await run('precompact', {
      checkInit: (p) => { seen = p; return { reason: 'version-drift', detail: 'engineer 0.23.0' }; },
    }, { FAKE_PLUGINS: JSON.stringify(plugins) });
    deepStrictEqual(seen, plugins, 'checkInit gets the init event\'s plugins');
    deepStrictEqual([w.aborted, w.abortReason, w.abortDetail], ['provenance', 'version-drift', 'engineer 0.23.0']);
    deepStrictEqual(w.plugins, plugins);
  });
});

describe('the posture (D5)', () => {
  const argsFor = (stepKind, extra = {}) => W.workerArgs({ sessionId: 's', stepKind, runId: RUN, seq: 1, stepBudgetUsd: 25, model: null, effort: null, ...extra });
  const valueOf = (args, flag) => args[args.indexOf(flag) + 1];

  it('manual mode, no prompts, the exact lists; git commit denied except on /engineer:commit', () => {
    const verb = argsFor('verb');
    deepStrictEqual([valueOf(verb, '--permission-mode'), valueOf(verb, '--permission-prompts')], ['manual', 'none']);
    strictEqual(valueOf(verb, '--allowedTools'), 'Bash Read Edit Write NotebookEdit Task Skill WebFetch WebSearch TaskStop Monitor');
    ok(valueOf(verb, '--disallowedTools').split(' ').includes('Bash(git'), 'a deny rule with a space stays in one string');
    ok(valueOf(verb, '--disallowedTools').endsWith('Bash(git commit:*)'));
    ok(!valueOf(argsFor('commit'), '--disallowedTools').includes('git commit'));
    for (const kind of ['dispatch', 'done', 'done-no-commit', 'finalize']) ok(valueOf(argsFor(kind), '--disallowedTools').includes('Bash(git commit:*)'), kind);
    strictEqual(valueOf(verb, '--max-budget-usd'), '25');
    ok(JSON.parse(valueOf(verb, '--json-schema')).required.includes('workflow'));
    ok(!verb.includes('--model') && !verb.includes('--effort'), 'the owner\'s default when the plan says so');
    deepStrictEqual([valueOf(argsFor('verb', { model: 'sonnet', effort: 'low' }), '--model'), valueOf(argsFor('verb', { model: 'sonnet', effort: 'low' }), '--effort')], ['sonnet', 'low']);
    // Contract: the worker agent reads this appended system prompt — without the rule
    // it ends the step on the report it gave while a background task was pending.
    ok(valueOf(verb, '--append-system-prompt').includes('A report the host takes when you end a turn to wait for a background task is provisional'), 'a report taken mid-wait does not end the step');
    ok(valueOf(verb, '--append-system-prompt').includes('Only the last report counts.'));
    // C127: the report says whether the worker still waits, and the prompt
    // says what each value does.
    ok(JSON.parse(valueOf(verb, '--json-schema')).required.includes('waiting_on_background'));
    ok(valueOf(verb, '--append-system-prompt').includes('set waiting_on_background = true'));
    ok(valueOf(verb, '--append-system-prompt').includes('In your last report set waiting_on_background = false'));
  });

  it('refuses any escalation', () => {
    for (const bad of [['--dangerously-skip-permissions'], ['--permission-mode', 'bypassPermissions'], ['--permission-mode', 'auto'],
      ['--permission-prompts', 'host'], ['--resume', 'x'], ['--continue'], ['--fork-session'], ['--allow-dangerously-skip-permissions']]) {
      throws(() => W.assertNoEscalation(['-p', ...bad]), /escalation|must be|bypassPermissions/, bad.join(' '));
    }
  });

  it('scrubs the launching session and the dispatch contract, sets the run, the step\'s number and the roots', async () => {
    const { started } = await run('simple', { seq: 7 }, {
      AGENTIC_AUTOPILOT_STEP: '3', AGENTIC_AUTOPILOT_VERIFY: 'a'.repeat(40),
      CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'outer', CLAUDE_CODE_SESSION_KIND: 'bg',
      CLAUDE_BG_SESSION_PERMISSION_RULES: '{"allow":["Bash(*)"],"deny":[]}', CLAUDE_CODE_MESSAGING_SOCKET: '/s',
      CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_RELAUNCH_SESSION_ADD_DIRS: '[]', CLAUDE_PID: '1', CLAUDE_EFFORT: 'max',
      CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_CODE_EXECPATH: '/x', AGENTIC_NOTIFY_EGRESS_CHANNEL: 'telegram',
      AGENTIC_COMPANION_DEPTH: '1', AGENTIC_PARENT_WORKFLOW: 'macro-other', AGENTIC_ORIGINATING_SUBTASK: 'Z',
      AGENTIC_PARENT_WORKFLOW_PATH: '/other/.agentic-plugins/state/orchestrator/workflows/macro-other.md',
      AGENTIC_STATE_BASE: '/other', AGENTIC_AUTOPILOT_TOKEN: 'f'.repeat(32),
      AGENTIC_PROFILE: 'x', AGENTIC_TOPIC: 'y', AGENTIC_HOST: 'codex', CLAUDE_PLUGIN_ROOT: '/stale',
      AGENTIC_AUTOPILOT: 'autopilot-19990101T000000Z-000000', KEEP_ME: 'yes',
      // An autopilot worker running this suite already carries a push block;
      // counted from none, the check below sees only the one this worker adds.
      GIT_CONFIG_COUNT: '0',
    });
    const env = started[0].env;
    for (const k of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_KIND', 'CLAUDE_BG_SESSION_PERMISSION_RULES',
      'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_RELAUNCH_SESSION_ADD_DIRS', 'CLAUDE_PID', 'CLAUDE_EFFORT',
      'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'AGENTIC_NOTIFY_EGRESS_CHANNEL', 'AGENTIC_COMPANION_DEPTH',
      'AGENTIC_PARENT_WORKFLOW', 'AGENTIC_ORIGINATING_SUBTASK', 'AGENTIC_PARENT_WORKFLOW_PATH', 'AGENTIC_STATE_BASE',
      'AGENTIC_AUTOPILOT_TOKEN', 'AGENTIC_PROFILE', 'AGENTIC_TOPIC', 'AGENTIC_HOST', 'CLAUDE_PLUGIN_ROOT']) {
      ok(!(k in env), `${k} reached the worker`);
    }
    strictEqual(env.KEEP_ME, 'yes');
    strictEqual(env.AGENTIC_AUTOPILOT, RUN);
    // ADR-0068 Decision 5, item 7 — the step's number is the step's seq, never
    // an inherited one, and it comes with no offer of verification.
    strictEqual(env.AGENTIC_AUTOPILOT_STEP, '7');
    ok(!('AGENTIC_AUTOPILOT_VERIFY' in env));
    deepStrictEqual([env.AGENTIC_ORCHESTRATOR_ROOT, env.AGENTIC_ENGINEER_ROOT, env.AGENTIC_RUNTIME_ROOT], [ROOTS.orchestrator, ROOTS.engineer, ROOTS.runtime]);
    // Contract: git reads GIT_CONFIG_COUNT/KEY/VALUE — without the block the worker
    // pushes with `git -C`, which the command denylist does not match.
    ok(Number(env.GIT_CONFIG_COUNT) >= 4, 'the push block is in the worker environment');
  });

  it("exports the run's state root, never the inherited one (ADR-0067 Decision 2)", () => {
    const env = W.workerEnv({ AGENTIC_STATE_BASE: '/inherited', KEEP_ME: 'yes' }, { runId: RUN, roots: ROOTS, stateBase: '/the/run/root' });
    strictEqual(env.AGENTIC_STATE_BASE, '/the/run/root');
    const none = W.workerEnv({ AGENTIC_STATE_BASE: '/inherited' }, { runId: RUN, roots: ROOTS });
    ok(!('AGENTIC_STATE_BASE' in none), 'no run root given: nothing, and never the inherited value');
  });

  it("exports the run's admission secret, never an inherited one (ADR-0067 Decision 4, item 5)", () => {
    const env = W.workerEnv({ AGENTIC_AUTOPILOT_TOKEN: 'inherited', KEEP_ME: 'yes' }, { runId: RUN, roots: ROOTS, autopilotToken: 'the-run-secret' });
    strictEqual(env.AGENTIC_AUTOPILOT_TOKEN, 'the-run-secret');
    const none = W.workerEnv({ AGENTIC_AUTOPILOT_TOKEN: 'inherited' }, { runId: RUN, roots: ROOTS });
    ok(!('AGENTIC_AUTOPILOT_TOKEN' in none), 'no secret given: nothing, and never the inherited value');
  });
});

describe('the git-level push block', () => {
  const GIT_ENV = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  const push = (cwd, env, ...args) => spawnSync('git', ['-C', cwd, 'push', ...args], { encoding: 'utf8', env, timeout: 20_000 });

  it('fails every network push at once, leaves local pushes and fetches alone, and keeps existing GIT_CONFIG entries', () => {
    const dir = scratch();
    try {
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', join(dir, 'origin.git')], { env: { ...process.env, ...GIT_ENV } });
      execFileSync('git', ['clone', '-q', join(dir, 'origin.git'), join(dir, 'work')], { env: { ...process.env, ...GIT_ENV } });
      const work = join(dir, 'work');
      execFileSync('git', ['-C', work, 'commit', '-q', '--allow-empty', '-m', 'x'], { env: { ...process.env, ...GIT_ENV } });
      execFileSync('git', ['-C', work, 'remote', 'add', 'gh', 'git@github.com:o/r.git'], { env: { ...process.env, ...GIT_ENV } });
      execFileSync('git', ['-C', work, 'remote', 'add', 'pushy', join(dir, 'origin.git')], { env: { ...process.env, ...GIT_ENV } });
      execFileSync('git', ['-C', work, 'config', 'remote.pushy.pushurl', 'https://example.invalid/r.git'], { env: { ...process.env, ...GIT_ENV } });
      // A push the block misses would reach this mock ssh, not the network.
      const base = { ...process.env, ...GIT_ENV, GIT_SSH_COMMAND: 'false', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'user.name', GIT_CONFIG_VALUE_0: 'Kept' };
      const remotes = { fetchUrls: [join(dir, 'origin.git'), 'git@github.com:o/r.git', join(dir, 'origin.git')], pushUrls: ['https://example.invalid/r.git'] };
      const env = { ...base, ...W.pushBlockConfig(base, remotes) };
      strictEqual(env.GIT_CONFIG_KEY_0, 'user.name', 'an existing entry keeps its index');

      for (const target of [['https://example.invalid/x.git', 'HEAD'], ['gh', 'HEAD'], ['pushy', 'HEAD:main'], ['ssh://git@example.invalid/x.git', 'HEAD'], ['git@elsewhere.invalid:owner/other.git', 'HEAD']]) {
        const r = push(work, env, ...target);
        ok(r.status !== 0 && /autopilot-push-blocked/.test(r.stderr), `${target[0]}: ${r.stderr}`);
      }
      const own = push(work, env, 'origin', 'HEAD:main');
      ok(own.status !== 0 && /autopilot-push-blocked/.test(own.stderr), 'the repository\'s own origin is blocked even as a path');
      const local = spawnSync('git', ['-C', work, 'push', join(dir, 'origin.git'), 'HEAD:refs/heads/side'], { encoding: 'utf8', env: { ...env, ...W.pushBlockConfig(base, { fetchUrls: [] }) }, timeout: 20_000 });
      strictEqual(local.status, 0, `a local push outside the repository's remotes is untouched: ${local.stderr}`);
      strictEqual(spawnSync('git', ['-C', work, 'fetch', '-q', 'origin'], { env, timeout: 20_000 }).status, 0, 'fetch still works');
      strictEqual(spawnSync('git', ['-C', work, 'config', 'user.name'], { env, encoding: 'utf8' }).stdout.trim(), 'Kept');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('leaves an explicit pushurl that is also a fetch URL open, as documented', () => {
    const cfg = W.pushBlockConfig({}, { fetchUrls: ['https://h/r.git'], pushUrls: ['https://h/r.git'] });
    const values = Object.entries(cfg).filter(([k]) => k.startsWith('GIT_CONFIG_KEY_')).map(([k, v]) => [v, cfg[k.replace('KEY', 'VALUE')]]);
    ok(!values.some(([k, v]) => k.endsWith('.insteadOf') && v === 'https://h/r.git'), 'no insteadOf that would break the fetch');
  });
});

// The fixture must stay executable for the AUTOPILOT_CLAUDE_BIN path.
describe('fixture', () => {
  it('answers --version and --help like the real CLI does for preflight', () => {
    ok(/Fake Claude/.test(execFileSync(FAKE, ['--version'], { encoding: 'utf8' })));
    ok(execFileSync(FAKE, ['--help'], { encoding: 'utf8' }).includes('--permission-prompts'));
  });
});

// ---------------------------------------------------------------------------
// ADR-0068 Decision 3 — the stall watch.

const WALL0 = Date.parse('2026-10-29T00:00:00.000Z');
// The detector, scaled: a 1 s window, a sample every 100 ms.
const SCALED = { windowMs: 1000, intervalMs: 100, cpuThresholdMs: 10, heartbeatGraceMs: 500 };
const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });
const table = (procs = []) => ({ ok: true, procs, unreadable: [], exited: [], resolutionMs: 10 });
// Wait until the worker's raw stream holds a line `match` takes.
async function lineIn(t, match, ms = 10_000) {
  const file = join(t.dir, 'worker-1.jsonl');
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    for (const l of text.split('\n')) {
      try { if (l && match(JSON.parse(l))) return; } catch { /* torn */ }
    }
    await pause(20);
  }
  throw new Error('the line never came');
}
const assistantIn = (t) => lineIn(t, (e) => e.type === 'assistant');

// A sampler whose clock and samples the test drives.
function fakeSampler() {
  let mono = 0;
  const ls = new Set();
  return {
    clock: { mono: () => mono, wall: () => WALL0 + mono },
    get size() { return ls.size; },
    register(l) { ls.add(l); return { unregister() { ls.delete(l); } }; },
    // Move the clock by `ms`, one sample every 100 ms of it.
    samples(ms, snap = table()) {
      for (let t = 0; t < ms; t += 100) {
        mono += 100;
        for (const l of [...ls]) l(typeof snap === 'function' ? snap() : snap, mono, WALL0 + mono);
      }
    },
  };
}

function start(mode, { stall = 'log', sampler = fakeSampler(), env = {}, over = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'autopilot-stall-worker-'));
  const records = [];
  const handle = W.startWorker({
    cwd: dir, prompt: '/engineer:critique', stepKind: 'verb', runId: RUN, seq: 1, roots: ROOTS,
    stepBudgetUsd: 1, stepTimeoutSec: 30, model: null, effort: null, rawPath: join(dir, 'worker-1.jsonl'),
    env: { ...process.env, AUTOPILOT_CLAUDE_BIN: FAKE, FAKE_CLAUDE_MODE: mode, ...env },
    stall: { mode: stall, sampler, detector: SCALED }, onStall: (r) => records.push(r),
    timing: { closeDebounceMs: 100, reportExitGraceMs: 400, killGraceMs: 300 },
    ...over,
  });
  handle.begin();
  return { handle, records, sampler, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('the worker\'s watch (Decision 3, items 7, 8 and 10)', () => {
  it('log mode records a stall through onStall and never stops the step', async () => {
    const t = start('events', { env: { FAKE_EVENTS: JSON.stringify([{ delay: 900, event: { result: null } }]) } });
    try {
      await assistantIn(t); // init and the first message are in
      t.sampler.samples(1200);
      deepStrictEqual(t.records.map((r) => r.verdict), ['stalled']);
      const w = await t.handle.done;
      deepStrictEqual([w.aborted, w.exitCode], [null, 0], 'the step ended as it would have');
      deepStrictEqual(t.records.map((r) => r.verdict), ['stalled', 'active'], 'its result is activity');
      strictEqual(w.stall.mode, 'log');
      deepStrictEqual(w.stall.summary.verdict_counts, { active: 2, stalled: 1, unknown: 0 });
      strictEqual(w.stall.last.verdict, 'active');
      ok(Number.isInteger(w.stall.summary.longest_quiet_ms));
      strictEqual(t.sampler.size, 0, 'unregistered at the watch\'s end');
    } finally {
      t.cleanup();
    }
  });

  it('with the detector on, a stalled verdict aborts the step (`stalled`) and its group is torn down', async () => {
    const t = start('events', { stall: 'on', env: { FAKE_EVENTS: '[]' } });
    try {
      await assistantIn(t);
      t.sampler.samples(1200);
      const w = await t.handle.done;
      strictEqual(w.aborted, 'stalled');
      ok(/^the step stalled: no stream activity/.test(w.abortDetail), w.abortDetail);
      ok(['empty', 'terminated', 'killed'].includes(w.groupTeardown), w.groupTeardown);
      strictEqual(w.costUsd, null, 'no result: the driver charges the reservation');
      strictEqual(w.stall.mode, 'on');
    } finally {
      t.cleanup();
    }
  });

  it('a failing probe is unknown and never aborts, even with the detector on', async () => {
    const t = start('events', { stall: 'on', env: { FAKE_EVENTS: JSON.stringify([{ delay: 800, event: { result: null } }]) } });
    try {
      await assistantIn(t);
      t.sampler.samples(1200, { ok: false, why: 'failed' });
      deepStrictEqual(t.records.map((r) => [r.verdict, r.why]), [['unknown', 'failed']]);
      const w = await t.handle.done;
      strictEqual(w.aborted, null);
    } finally {
      t.cleanup();
    }
  });

  it('a detector that throws on a sample reads it as unknown (`probe-error`), never as the step\'s error', async () => {
    const t = start('events', { env: { FAKE_EVENTS: JSON.stringify([{ delay: 600, event: { result: null } }]) } });
    try {
      await assistantIn(t);
      // A table whose procs throw when read.
      const bad = { ok: true, unreadable: [], exited: [], get procs() { throw new Error('boom'); } };
      t.sampler.samples(1200, bad);
      deepStrictEqual(t.records.map((r) => [r.verdict, r.why]), [['unknown', 'probe-error']]);
      const w = await t.handle.done;
      strictEqual(w.aborted, null);
    } finally {
      t.cleanup();
    }
  });

  it('a throwing onStall never changes the step\'s outcome', async () => {
    const t = start('events', { over: { onStall: () => { throw new Error('driver bug'); } }, env: { FAKE_EVENTS: JSON.stringify([{ delay: 600, event: { result: null } }]) } });
    try {
      await assistantIn(t);
      t.sampler.samples(1200);
      const w = await t.handle.done;
      deepStrictEqual([w.aborted, w.exitCode], [null, 0]);
      strictEqual(w.stall.summary.verdict_counts.stalled, 1);
    } finally {
      t.cleanup();
    }
  });

  it('a worker that ignores an idle close of stdin is judged until it exits', async () => {
    const t = start('simple', { stall: 'on', env: { FAKE_IGNORE_STDIN_CLOSE: '1' } });
    try {
      // The result, then the idle close after the debounce, which the fake ignores.
      await lineIn(t, (e) => e.subtype === 'fake_stdin_closed');
      strictEqual(t.sampler.size, 1, 'an idle EOF keeps the watch');
      t.sampler.samples(1200);
      const w = await t.handle.done;
      strictEqual(w.aborted, 'stalled');
    } finally {
      t.cleanup();
    }
  });

  it('a close on a finished report ends the watch; one armed and not yet fired does not', async () => {
    const report = { outcome: 'completed', workflow: null, next_step: null, awaiting_owner: null, summary: 's', waiting_on_background: false };
    const t = start('background-forever', {
      env: { FAKE_REPORT: JSON.stringify(report), FAKE_IGNORE_STDIN_CLOSE: '1' },
      over: { timing: { closeDebounceMs: 700, reportExitGraceMs: 300, killGraceMs: 300 } },
    });
    try {
      await lineIn(t, (e) => e.type === 'result'); // the close is armed for 700 ms
      t.sampler.samples(1200);
      deepStrictEqual(t.records.map((r) => r.verdict), ['stalled'], 'judged while the close is only armed');
      await pause(700);
      strictEqual(t.sampler.size, 0, 'the close itself ended the watch');
      t.sampler.samples(1500, { ok: false, why: 'failed' });
      const w = await t.handle.done;
      strictEqual(w.closedOnReport, true);
      deepStrictEqual(t.records.map((r) => r.verdict), ['stalled'], 'nothing judged after it');
    } finally {
      t.cleanup();
    }
  });

  it('the worker\'s exit ends the watch before its output closes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'autopilot-stall-holder-'));
    const pidfile = join(dir, 'holder.pid');
    const t = start('events', { env: { FAKE_EVENTS: JSON.stringify([{ delay: 0, event: { exit: 0, holdPipes: true } }]), FAKE_CLAUDE_PIDFILE: pidfile } });
    try {
      await pause(500);
      strictEqual(t.sampler.size, 0, 'exited, its pipes still held');
      const w = await t.handle.done;
      strictEqual(w.exitCode, 0);
    } finally {
      if (existsSync(pidfile)) { try { process.kill(Number(readFileSync(pidfile, 'utf8')), 'SIGKILL'); } catch { /* gone */ } }
      rmSync(dir, { recursive: true, force: true });
      t.cleanup();
    }
  });

  it('an abort ends the watch: a PreCompact abort, then samples, judge nothing while the worker is still there', async () => {
    // The worker ignores SIGTERM, so it outlives the abort by the kill grace.
    const t = start('precompact', { stall: 'on', env: { FAKE_IGNORE_SIGTERM: '1' }, over: { timing: { closeDebounceMs: 100, reportExitGraceMs: 400, killGraceMs: 3000 } } });
    try {
      await lineIn(t, (e) => e.subtype === 'hook_started');
      await pause(100);
      strictEqual(t.sampler.size, 0, 'the abort ended the watch, the worker still running');
      t.sampler.samples(1200);
      deepStrictEqual(t.records, []);
      const w = await t.handle.done;
      strictEqual(w.aborted, 'compaction-imminent');
    } finally {
      t.cleanup();
    }
  });

  it('the wall clock stays the step\'s stop in log mode, and with the detector on an unknown step runs to it', async () => {
    for (const mode of ['log', 'on']) {
      const t = start('events', { stall: mode, env: { FAKE_EVENTS: '[]' }, over: { stepTimeoutSec: 1 } });
      try {
        await assistantIn(t);
        t.sampler.samples(1200, { ok: false, why: 'timeout' });
        const w = await t.handle.done;
        strictEqual(w.aborted, 'timeout', mode);
        deepStrictEqual(t.records.map((r) => r.verdict), ['unknown'], mode);
      } finally {
        t.cleanup();
      }
    }
  });

  it('no sampler, no watch: the step is hosted as before, `stall` null', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'autopilot-stall-none-'));
    try {
      const h = W.startWorker({
        cwd: dir, prompt: 'x', stepKind: 'verb', runId: RUN, seq: 1, roots: ROOTS, stepBudgetUsd: 1, stepTimeoutSec: 30,
        rawPath: join(dir, 'w.jsonl'), env: { ...process.env, AUTOPILOT_CLAUDE_BIN: FAKE, FAKE_CLAUDE_MODE: 'simple' },
      });
      h.begin();
      const w = await h.done;
      strictEqual(w.stall, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a real descendant that burns CPU keeps a quiet step active (the probe and the tree, end to end)', { skip: !['darwin', 'linux'].includes(process.platform) }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'autopilot-stall-busy-'));
    const pidfile = join(dir, 'busy.pid');
    const sampler = SM.createStallSampler({ intervalMs: 200 });
    const records = [];
    try {
      const h = W.startWorker({
        cwd: dir, prompt: 'x', stepKind: 'verb', runId: RUN, seq: 1, roots: ROOTS, stepBudgetUsd: 1, stepTimeoutSec: 30,
        rawPath: join(dir, 'w.jsonl'),
        env: { ...process.env, AUTOPILOT_CLAUDE_BIN: FAKE, FAKE_CLAUDE_MODE: 'events', FAKE_CLAUDE_PIDFILE: pidfile, FAKE_EVENTS: JSON.stringify([{ delay: 5000, event: { result: null } }]), FAKE_BUSY_CHILD: '1' },
        stall: { mode: 'on', sampler, detector: { windowMs: 2000, intervalMs: 200, cpuThresholdMs: 100 } }, onStall: (r) => records.push(r),
      });
      h.begin();
      const w = await h.done;
      strictEqual(w.aborted, null, `a busy child is activity: ${JSON.stringify(records)}`);
      deepStrictEqual(records.filter((r) => r.verdict === 'stalled'), []);
      ok(w.stall.summary.lowest_window_cpu_ms >= 100, JSON.stringify(w.stall.summary));
    } finally {
      sampler.stop();
      if (existsSync(pidfile)) { try { process.kill(Number(readFileSync(pidfile, 'utf8')), 'SIGKILL'); } catch { /* gone */ } }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
