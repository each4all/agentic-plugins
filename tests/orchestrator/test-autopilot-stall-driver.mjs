// tests/orchestrator/test-autopilot-stall-driver.mjs
//
// ADR-0068 Decision 3 — the stall detector in a run, end to end with no model
// (the fake `claude` hands each step to the scripted worker, as in
// test-autopilot-events-driver.mjs and test-autopilot-events-lanes.mjs). A
// step chosen by its seq is handed a quiet, idle window (or failed samples)
// by a sampler on a clock the test moves, before the worker's first line.
//
// Log mode: each verdict change is a `stall` line in steps.jsonl and an event
// with exactly its fields, from the detector's own records; the finished line
// carries the summary; the outcome, the 3600 s step clock and every halt are
// unchanged; a record that cannot be written is counted and changes nothing.
// `--stall-detector on`: a stalled step ends `worker-failed`, its detail
// naming the stall, charged its reservation, and parks its lane; a stalled
// done is the run's and halts it; an unknown step is never aborted.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeRepo, ORCH, ENG, RUNTIME } from './fixtures/autopilot-repo.mjs';
import { setup as lanesSetup } from './fixtures/autopilot-lanes-run.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const AP = resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot');
const { startRun, DEFAULTS, EMERGENCY_CAP_SEC } = await import(resolve(AP, 'driver.mjs'));
const { startWorker: realStartWorker } = await import(resolve(AP, 'worker.mjs'));
const L = await import(resolve(AP, 'ledger.mjs'));
const E = await import(resolve(AP, 'events.mjs'));
const C = await import(resolve(AP, 'cli.mjs'));
const PO = await import(resolve(AP, 'policy.mjs'));
const FAKE = resolve(REPO_ROOT, 'tests/orchestrator/fixtures/autopilot-fake-claude.mjs');
const SCRIPTED = resolve(REPO_ROOT, 'tests/orchestrator/fixtures/autopilot-scripted-worker.mjs');

const version = (root) => JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const ROOTS = { orchestrator: ORCH, engineer: ENG, runtime: RUNTIME };
const PLUGINS = Object.entries(ROOTS).map(([name, root]) => ({ name, path: root, source: `${name}@agentic-plugins`, version: version(root) }));
const COMMIT = { kind: 'commit', verb: null, confidence: 'HIGH' };
const DONE = { kind: 'done', verb: null, confidence: 'HIGH' };
const WALL0 = Date.parse('2026-10-29T00:00:00.000Z');
// The detector, scaled: a 1 s window, a sample every 100 ms.
const SCALED = { windowMs: 1000, intervalMs: 100, cpuThresholdMs: 10 };
const HEAD = ['schema', 'run_id', 'seq', 'at', 'kind', 'macro_id', 'subtask_id'];
const STALL_EVENT_KEYS = [...HEAD, 'step', 'verdict', 'mode', 'quiet_ms', 'window_cpu_ms', 'unknown_ms', 'pending_tasks', 'tool_running', 'answer_owed', 'pointer'];
const STALL_LINE_KEYS = ['event', 'seq', 'lane', 'at', 'mode', 'verdict', 'quiet_ms', 'window_cpu_ms', 'unknown_ms', 'pending_tasks', 'tool_running', 'answer_owed', 'why'];
const table = () => ({ ok: true, procs: [], unreadable: [], exited: [], resolutionMs: 10 });

/**
 * deps.startWorker: the real worker host, its run sampler replaced by one
 * that hands each step in `seqs` twelve samples at once (`idle` tables, or
 * `failed` reads) on a clock the test moves, before its first stream line.
 */
function stallSeam({ seqs = [1], probe = 'idle' } = {}) {
  let mono = 0;
  const clock = { mono: () => mono, wall: () => WALL0 + mono };
  const seen = [];
  const startWorker = (o) => {
    seen.push({ seq: o.seq, stall: o.stall ? { mode: o.stall.mode, detector: o.stall.detector } : null, timeout: o.stepTimeoutSec });
    const sampler = {
      clock,
      register(l) {
        if (seqs.includes(o.seq)) {
          setImmediate(() => {
            for (let i = 0; i < 12; i += 1) {
              mono += 100;
              l(probe === 'idle' ? table() : { ok: false, why: 'failed' }, mono, WALL0 + mono);
            }
          });
        }
        return { unregister() {} };
      },
    };
    return realStartWorker({ ...o, stall: o.stall ? { ...o.stall, sampler } : null });
  };
  return { startWorker, seen, stallDetector: SCALED };
}

async function serialSetup(scenario) {
  const fx = await makeRepo();
  const work = realpathSync(fx.work);
  fx.env.HOME = join(fx.dir, 'home');
  mkdirSync(fx.env.HOME);
  const scen = join(fx.dir, 'scenario.json');
  writeFileSync(scen, JSON.stringify(scenario));
  const env = {
    ...fx.env,
    AUTOPILOT_CLAUDE_BIN: FAKE, FAKE_CLAUDE_MODE: 'script', FAKE_WORKER_SCRIPT: SCRIPTED, FAKE_SCENARIO: scen,
    AGENTIC_ORCHESTRATOR_ROOT: ORCH, AGENTIC_ENGINEER_ROOT: ENG, AGENTIC_RUNTIME_ROOT: RUNTIME, FAKE_PLUGINS: JSON.stringify(PLUGINS),
  };
  const lines = [];
  const run = (opts = {}, deps = {}) => startRun({
    repoRoot: work,
    options: { ...DEFAULTS, models: 'owner-default', model: null, effort: null, macro: null, forced: null, forcedText: null, notifyLocal: false, ...opts },
    env, out: (s) => lines.push(s), err: (s) => lines.push(`ERR ${s}`), deps: { signals: new EventEmitter(), ...deps },
  });
  const latest = () => L.readRun(work, L.listRuns(work).at(-1));
  const file = E.eventsPath({ mainRoot: work, macroId: fx.macroId, checkout: work });
  const of = (runId) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []).filter((e) => e.run_id === runId);
  const watch = async (cursor) => {
    const got = [];
    const code = await C.main(['events', '--macro', fx.macroId, '--after', cursor, '--repo', work], { env: { ...env, AGENTIC_HOST: 'claude' }, out: (s) => got.push(JSON.parse(s)), err: () => {} });
    return { code, got };
  };
  return { fx, work, run, lines, latest, file, of, watch };
}

const stallLinesOf = (dir) => readFileSync(join(dir, 'steps.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.event === 'stall');
const SCEN = { A: { next: [COMMIT], file: true }, B: { next: [DONE], file: false } };

describe('log mode in a serial run (Decision 3, item 7)', () => {
  it('each verdict change is a stall line and an event from the detector\'s records; the summary is on the finished line; nothing else changes', async () => {
    const plain = await serialSetup(SCEN);
    const t = await serialSetup(SCEN);
    try {
      // The same run without a stall, for what must not change.
      strictEqual(await plain.run({}, { stallSampler: { clock: { mono: () => 0, wall: () => 0 }, register: () => ({ unregister() {} }), stop() {} } }), 2, plain.lines.join('\n'));
      const base = plain.latest();
      const seam = stallSeam({ seqs: [1] });
      // The run's own sampler, which the seam's per-step samplers stand in
      // for: stopped once, at the run's end.
      let stopped = 0;
      const runSampler = { clock: { mono: () => 0, wall: () => 0 }, register: () => ({ unregister() {} }), stop() { stopped += 1; } };
      strictEqual(await t.run({}, { ...seam, stallSampler: runSampler }), 2, t.lines.join('\n'));
      strictEqual(stopped, 1, 'the run stops its sampler');
      const r = t.latest();
      deepStrictEqual(r.steps.map((s) => [s.seq, s.kind, s.outcome, s.event]), base.steps.map((s) => [s.seq, s.kind, s.outcome, s.event]), 'the outcome of every step');
      strictEqual(r.halt.reason, base.halt.reason);
      deepStrictEqual(seam.seen.map((x) => [x.stall.mode, x.timeout]), r.steps.map(() => ['log', 3600]), 'the step clock is the 3600 s default');
      strictEqual(r.run.options.stall_detector, 'log');
      for (const s of r.steps) strictEqual(s.stall_detector, 'log');

      // steps.jsonl: the step's lines, exactly their fields, in whole ms.
      const lines = stallLinesOf(r.dir);
      deepStrictEqual(lines.map((l) => [l.seq, l.verdict, l.mode]), [[1, 'stalled', 'log'], [1, 'active', 'log']]);
      for (const l of lines) {
        deepStrictEqual(Object.keys(l), STALL_LINE_KEYS);
        for (const k of ['quiet_ms', 'unknown_ms']) ok(Number.isInteger(l[k]), k);
      }
      strictEqual(lines[0].why, 'quiet-and-idle');
      strictEqual(lines[0].answer_owed, true, 'the prompt owes an answer before any event');
      // readRun keeps them out of the step's lifecycle.
      const s1 = r.steps[0];
      strictEqual(s1.event, 'finished');
      strictEqual(s1.verdict, undefined, 'never merged into the step');
      deepStrictEqual(s1.stalls.map((x) => x.verdict), ['stalled', 'active']);
      // The finished line's summary.
      strictEqual(s1.stall.mode, 'log');
      deepStrictEqual(s1.stall.summary.verdict_counts, { active: 2, stalled: 1, unknown: 0 });
      strictEqual(s1.stall.summary.stalled_waits.length, 1);
      strictEqual(s1.stall.last.verdict, 'active');
      for (const s of r.steps.slice(1)) deepStrictEqual(s.stalls, []);

      // The events: exactly their fields, the same values as the lines.
      const evs = t.of(r.run.run_id).filter((e) => e.kind === 'stall');
      deepStrictEqual(evs.map((e) => Object.keys(e)), [STALL_EVENT_KEYS, STALL_EVENT_KEYS]);
      evs.forEach((e, i) => {
        const l = lines[i];
        deepStrictEqual([e.step, e.verdict, e.mode, e.quiet_ms, e.window_cpu_ms, e.unknown_ms, e.pending_tasks, e.tool_running, e.answer_owed],
          [l.seq, l.verdict, l.mode, l.quiet_ms, l.window_cpu_ms, l.unknown_ms, l.pending_tasks, l.tool_running, l.answer_owed]);
        strictEqual(e.pointer, join(r.dir, 'steps.jsonl'));
        strictEqual(e.subtask_id, s1.subtask_id);
      });
      strictEqual(t.of(r.run.run_id)[0].detector, 'log');
      // The reader delivers them as events.
      const { got } = await t.watch(`${r.run.run_id}:0`);
      deepStrictEqual(got.filter((e) => e.kind === 'stall').map((e) => e.verdict), ['stalled', 'active']);
    } finally {
      plain.fx.cleanup();
      t.fx.cleanup();
    }
  });

  it('a stall line cut short and an event that cannot be written are counted, leave no torn line, and change nothing', async () => {
    const t = await serialSetup(SCEN);
    try {
      const seam = stallSeam({ seqs: [1] });
      // Each stall line's write takes 20 bytes, then the disk is full.
      const stallWriteSync = (fd, buf, off, len) => {
        if (len > 20) { writeSync(fd, buf, off, 20); }
        const e = new Error('injected: ENOSPC'); e.code = 'ENOSPC'; throw e;
      };
      const eventsWriteSync = (fd, buf, off, len) => {
        if (buf.toString('utf8', off, off + len).includes('"kind":"stall"')) throw new Error('injected: the event file refused the line');
        return writeSync(fd, buf, off, len);
      };
      strictEqual(await t.run({}, { ...seam, stallWriteSync, eventsWriteSync }), 2, t.lines.join('\n'));
      const r = t.latest();
      // Every line of the step log parses: the cut lines were taken back.
      const raw = readFileSync(join(r.dir, 'steps.jsonl'), 'utf8').split('\n').filter(Boolean);
      for (const l of raw) JSON.parse(l);
      deepStrictEqual(stallLinesOf(r.dir), []);
      strictEqual(r.run.stall_record_failures, 2);
      strictEqual(r.run.events.failed_writes, 2);
      deepStrictEqual([r.steps[0].event, r.steps[0].outcome], ['finished', 'ok'], 'its finished line whole');
      deepStrictEqual(r.steps[0].stall.summary.verdict_counts, { active: 2, stalled: 1, unknown: 0 }, 'the summary still holds them');
      strictEqual(r.halt.reason, 'awaiting-landing');
    } finally {
      t.fx.cleanup();
    }
  });

  it('a stall event waits on no other writer of the event file: refused at once and counted, its stall line kept', async () => {
    const t = await serialSetup(SCEN);
    try {
      const seam = stallSeam({ seqs: [1] });
      // A live writer (this process's pid, another token) holds the event
      // file's lock from each stall line's write until the event loop next
      // turns: a stall event that waited on it would hold the loop to the
      // writer's bound (LOCK_WAIT_MS) first. Both verdicts may come before
      // that turn, so each write is timed, whichever made the lock.
      const lock = `${t.file}.lock`;
      const held = [];
      const stallWriteSync = (fd, buf, off, len) => {
        if (!existsSync(lock)) writeFileSync(lock, JSON.stringify({ pid: process.pid, token: 'another-writer', at: new Date().toISOString() }));
        const at = performance.now();
        setImmediate(() => { held.push(performance.now() - at); rmSync(lock, { force: true }); });
        return writeSync(fd, buf, off, len);
      };
      strictEqual(await t.run({}, { ...seam, stallWriteSync }), 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(stallLinesOf(r.dir).map((l) => l.verdict), ['stalled', 'active'], 'the stall lines are the record');
      deepStrictEqual(t.of(r.run.run_id).filter((e) => e.kind === 'stall'), [], 'each event refused');
      strictEqual(r.run.events.failed_writes, 2);
      strictEqual(held.length, 2);
      for (const ms of held) ok(ms < E.LOCK_WAIT_MS / 2, `the loop was held ${Math.round(ms)} ms`);
      deepStrictEqual([r.steps[0].event, r.steps[0].outcome], ['finished', 'ok']);
      strictEqual(r.halt.reason, 'awaiting-landing');
    } finally {
      t.fx.cleanup();
    }
  });

  it('appendStallLine takes back a write cut short, so the next line starts whole', () => {
    const dir = mkdtempSync(join(tmpdir(), 'autopilot-stall-line-'));
    try {
      writeFileSync(join(dir, 'steps.jsonl'), '{"event":"started","seq":1}\n');
      const fail = (fd, buf, off) => { writeSync(fd, buf, off, 5); throw new Error('ENOSPC'); };
      let threw = null;
      try { L.appendStallLine(dir, { event: 'stall', seq: 1 }, { writeSync: fail }); } catch (e) { threw = e.message; }
      strictEqual(threw, 'ENOSPC');
      strictEqual(readFileSync(join(dir, 'steps.jsonl'), 'utf8'), '{"event":"started","seq":1}\n', 'taken back');
      L.appendStallLine(dir, { event: 'stall', seq: 1, verdict: 'stalled' });
      strictEqual(readFileSync(join(dir, 'steps.jsonl'), 'utf8').split('\n').filter(Boolean).length, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('--stall-detector on (Decision 3, item 8)', () => {
  it('a stalled step ends worker-failed, its detail naming the stall and the wait, charged its whole reservation', async () => {
    const t = await serialSetup(SCEN);
    try {
      const seam = stallSeam({ seqs: [1] });
      strictEqual(await t.run({ stallDetector: 'on', stepTimeoutSec: EMERGENCY_CAP_SEC }, seam), 2, t.lines.join('\n'));
      const r = t.latest();
      strictEqual(r.halt.reason, 'worker-failed');
      ok(/^the step stalled: no stream activity for \d+ min .*\(waiting on: an answer of the model owed\)/.test(r.halt.detail), r.halt.detail);
      const s1 = r.steps[0];
      deepStrictEqual([s1.aborted, s1.outcome, s1.stall_detector, s1.step_timeout_sec], ['stalled', 'worker-failed', 'on', EMERGENCY_CAP_SEC]);
      strictEqual(s1.cost_usd, null);
      strictEqual(s1.cost_charged_usd, s1.step_budget_usd, 'no cost reported: the whole reservation');
      strictEqual(r.run.cost_complete, false);
      const failed = t.of(r.run.run_id).filter((e) => e.kind === 'step-failed');
      deepStrictEqual(failed.map((e) => [e.step, e.reason, e.abort]), [[1, 'worker-failed', 'stalled']]);
      deepStrictEqual(t.of(r.run.run_id).filter((e) => e.kind === 'stall').map((e) => [e.verdict, e.mode]), [['stalled', 'on']]);
      strictEqual(r.steps.length, 1, 'nothing after it');
    } finally {
      t.fx.cleanup();
    }
  });

  it('an unknown step is never aborted: it runs as it would have', async () => {
    const t = await serialSetup(SCEN);
    try {
      const seam = stallSeam({ seqs: [1], probe: 'failed' });
      strictEqual(await t.run({ stallDetector: 'on' }, seam), 2, t.lines.join('\n'));
      const r = t.latest();
      strictEqual(r.halt.reason, 'awaiting-landing');
      deepStrictEqual(stallLinesOf(r.dir).map((l) => [l.seq, l.verdict, l.why]), [[1, 'unknown', 'failed'], [1, 'active', 'stream']]);
      strictEqual(r.steps[0].aborted, null);
    } finally {
      t.fx.cleanup();
    }
  });

  it('in a lane, a stalled step parks its lane, and the other lane goes on', async () => {
    const t = await lanesSetup({ scenario: { A: { next: [COMMIT] }, B: { next: [COMMIT], file: 'b.txt' } } });
    try {
      const seam = stallSeam({ seqs: [1] });
      strictEqual(await t.run({ stallDetector: 'on' }, seam), 2, t.lines.join('\n'));
      const r = t.latest();
      const s1 = r.steps.find((s) => s.seq === 1);
      deepStrictEqual([s1.aborted, s1.outcome, s1.halt_scope], ['stalled', 'worker-failed', 'lane']);
      deepStrictEqual([s1.stall.mode, s1.stall.last.verdict], ['on', 'stalled'], 'the finished line\'s summary');
      const parked = (r.run.lanes?.lanes ?? []).find((l) => l.subtask_id === s1.subtask_id);
      strictEqual(parked?.park?.reason, 'worker-failed', JSON.stringify(parked));
      const other = r.steps.filter((s) => s.subtask_id !== s1.subtask_id && s.subtask_id);
      ok(other.some((s) => s.kind === 'commit' && s.outcome === 'ok'), JSON.stringify(r.steps.map((s) => [s.seq, s.subtask_id, s.kind, s.outcome])));
      const file = E.eventsPath({ mainRoot: t.work, macroId: t.fx.macroId, checkout: t.work });
      const evs = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.run_id === r.run.run_id);
      deepStrictEqual(evs.filter((e) => e.kind === 'lane-parked').map((e) => [e.subtask_id, e.reason]), [[s1.subtask_id, 'worker-failed']]);
      strictEqual(evs.find((e) => e.kind === 'stall')?.subtask_id, s1.subtask_id);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a stalled done is the run\'s: it halts the run, no lane parked', async () => {
    const t = await lanesSetup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [COMMIT], file: true } } });
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      strictEqual(t.latest().halt.reason, 'awaiting-landing');
      t.fx.setPrs([t.fx.land('A', 'feat/a', { number: 7 })]);
      const seam = stallSeam({ seqs: [1] });
      strictEqual(await t.run({ stallDetector: 'on' }, seam), 2, t.lines.join('\n'));
      const r = t.latest();
      const s1 = r.steps[0];
      deepStrictEqual([s1.kind, s1.aborted, s1.outcome, s1.halt_scope], ['done', 'stalled', 'worker-failed', 'run']);
      strictEqual(r.halt.reason, 'worker-failed');
      ok(!(r.run.lanes?.lanes ?? []).some((l) => l.park), 'no lane parked');
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('the policy and the options', () => {
  it('a stall event\'s fields are whole milliseconds, the mode added and the why left out, and the writer takes them', () => {
    const record = { verdict: 'stalled', at: '2026-10-29T00:10:00.000Z', quiet_ms: 600000.6, window_cpu_ms: 12.4, unknown_ms: 0.2, pending_tasks: 2, tool_running: true, answer_owed: false, why: 'quiet-and-idle' };
    const pointer = '/repo/.agentic-plugins/runs/autopilot/autopilot-20261029T000000Z-abcdef/steps.jsonl';
    const f = E.stallEventFields(record, { step: 4, mode: 'log', pointer });
    deepStrictEqual(f, { step: 4, verdict: 'stalled', mode: 'log', quiet_ms: 600001, window_cpu_ms: 12, unknown_ms: 0, pending_tasks: 2, tool_running: true, answer_owed: false, pointer });
    strictEqual(E.eventProblem('stall', 'A', f), null);
    strictEqual(E.eventProblem('stall', 'A', E.stallEventFields({ ...record, window_cpu_ms: null }, { step: 4, mode: 'on', pointer })), null);
    ok(E.eventProblem('stall', 'A', { ...f, why: 'x' }), 'no text field');
    ok(E.eventProblem('stall', 'A', { ...f, mode: 'off' }), 'off writes no stall line');
    strictEqual(E.eventProblem('run-started', null, { lanes: 1, detector: 'log', run_dir: '/repo/.agentic-plugins/runs/autopilot/autopilot-20261029T000000Z-abcdef', pointer: '/repo/.agentic-plugins/runs/autopilot/autopilot-20261029T000000Z-abcdef/run.json' }), null);
  });

  it('a stalled abort halts worker-failed with its detail, before the generic abort', () => {
    const d = PO.verifyStep({
      step: { kind: 'verb', subtaskId: null }, worker: { aborted: 'stalled', abortDetail: 'the step stalled: x', exitCode: null, report: null, lastResult: null },
      before: { macro: null, children: {} }, after: { macro: null, children: {} },
    });
    deepStrictEqual([d.reason, d.detail], ['worker-failed', 'the step stalled: x']);
  });

  it('--stall-detector: log by default; on makes the default step clock the emergency cap; an explicit --step-timeout wins in either order', () => {
    strictEqual(C.parseCli(['start']).stallDetector, 'log');
    strictEqual(C.parseCli(['start']).stepTimeoutSec, 3600);
    strictEqual(C.parseCli(['start', '--stall-detector', 'log']).stepTimeoutSec, 3600);
    strictEqual(C.parseCli(['start', '--stall-detector', 'on']).stepTimeoutSec, EMERGENCY_CAP_SEC);
    strictEqual(EMERGENCY_CAP_SEC, 28800);
    strictEqual(C.parseCli(['start', '--stall-detector', 'on', '--step-timeout', '3600']).stepTimeoutSec, 3600);
    strictEqual(C.parseCli(['start', '--step-timeout', '3600', '--stall-detector=on']).stepTimeoutSec, 3600);
    let refused = null;
    try { C.parseCli(['start', '--stall-detector', 'off']); } catch (e) { refused = e.message; }
    ok(/--stall-detector must be one of log, on/.test(refused ?? ''), refused);
    ok(C.USAGE.includes('--stall-detector <mode>'));
  });
});
