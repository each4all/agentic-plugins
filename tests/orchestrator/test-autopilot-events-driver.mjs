// tests/orchestrator/test-autopilot-events-driver.mjs
//
// ADR-0068 Decision 4 — what a serial run publishes in its event file
// (driver.mjs over events.mjs), end to end with no model: the fake `claude`
// hands each step to the scripted worker (fixtures/autopilot-scripted-worker.mjs),
// as in test-autopilot-driver.mjs. Each kind is written once, beside its
// record, with its documented fields only, pointing at a record that exists
// then; no line carries text a worker, a peer or a halt's detail wrote; a
// launch refused at its locks writes nothing and is never reported; a failed
// write is counted while the run goes on; nothing follows a run's
// `run-ended`; `--notify-local` is unchanged. A run with lanes:
// test-autopilot-events-lanes.mjs.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, rejects, strictEqual } from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs, { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeRepo, ORCH, ENG, RUNTIME } from './fixtures/autopilot-repo.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const AP = resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot');
const { startRun, DEFAULTS } = await import(resolve(AP, 'driver.mjs'));
const L = await import(resolve(AP, 'ledger.mjs'));
const E = await import(resolve(AP, 'events.mjs'));
const C = await import(resolve(AP, 'cli.mjs'));
const { observe: realObserve } = await import(resolve(AP, 'observe.mjs'));
const CLI = resolve(AP, 'cli.mjs');
// The reader in a process of its own: `node -e READER <cli> <args…>`.
const READER = 'const { main } = await import(process.argv[1]); process.exitCode = await main(process.argv.slice(2), { env: process.env, out: (s) => process.stdout.write(`${s}\\n`), err: () => {} });';
const FAKE = resolve(REPO_ROOT, 'tests/orchestrator/fixtures/autopilot-fake-claude.mjs');
const SCRIPTED = resolve(REPO_ROOT, 'tests/orchestrator/fixtures/autopilot-scripted-worker.mjs');

const version = (root) => JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const ROOTS = { orchestrator: ORCH, engineer: ENG, runtime: RUNTIME };
const PLUGINS = Object.entries(ROOTS).map(([name, root]) => ({ name, path: root, source: `${name}@agentic-plugins`, version: version(root) }));
const COMMIT = { kind: 'commit', verb: null, confidence: 'HIGH' };
const DONE = { kind: 'done', verb: null, confidence: 'HIGH' };
const HEAD = ['schema', 'run_id', 'seq', 'at', 'kind', 'macro_id', 'subtask_id'];
// Each kind's keys, in the order the writer puts them.
const KEYS = {
  'run-started': [...HEAD, 'lanes', 'detector', 'run_dir', 'pointer'],
  halt: [...HEAD, 'reason', 'step', 'pointer', 'step_record'],
  'step-failed': [...HEAD, 'step', 'reason', 'abort', 'pointer'],
  'commit-finished': [...HEAD, 'step', 'commit', 'readiness', 'pointer'],
  'run-ended': [...HEAD, 'status', 'reason', 'exit', 'pointer', 'cleanup', 'terminal'],
};

async function setup({ scenario } = {}) {
  const fx = await makeRepo();
  const work = realpathSync(fx.work);
  fx.env.HOME = join(fx.dir, 'home');
  mkdirSync(fx.env.HOME);
  const scen = join(fx.dir, 'scenario.json');
  writeFileSync(scen, JSON.stringify(scenario));
  const env = {
    ...fx.env,
    AUTOPILOT_CLAUDE_BIN: FAKE, FAKE_CLAUDE_MODE: 'script', FAKE_WORKER_SCRIPT: SCRIPTED, FAKE_SCENARIO: scen,
    FAKE_CLAUDE_LOG: join(fx.dir, 'claude.log'),
    AGENTIC_ORCHESTRATOR_ROOT: ORCH, AGENTIC_ENGINEER_ROOT: ENG, AGENTIC_RUNTIME_ROOT: RUNTIME, FAKE_PLUGINS: JSON.stringify(PLUGINS),
  };
  const lines = [];
  const signals = new EventEmitter();
  const run = (opts = {}, deps = {}) => startRun({
    repoRoot: work,
    options: { ...DEFAULTS, models: 'owner-default', model: null, effort: null, macro: null, forced: null, forcedText: null, notifyLocal: false, ...opts },
    env, out: (s) => lines.push(s), err: (s) => lines.push(`ERR ${s}`), deps: { signals, ...deps },
  });
  const latest = () => L.readRun(work, L.listRuns(work).at(-1));
  const file = E.eventsPath({ mainRoot: work, macroId: fx.macroId, checkout: work });
  const events = () => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const of = (runId) => events().filter((e) => e.run_id === runId);
  // The reader, as the main session's Monitor runs it, once.
  const watch = async (cursor) => {
    const got = [];
    const code = await C.main(['events', '--macro', fx.macroId, '--after', cursor, '--repo', work], { env: { ...env, AGENTIC_HOST: 'claude' }, out: (s) => got.push(JSON.parse(s)), err: () => {} });
    return { code, got };
  };
  return { fx, work, env, run, lines, latest, file, events, of, signals, watch };
}

// Every line has exactly its kind's keys, its seq rising from 1, and points
// at a file that exists.
function wellFormed(lines) {
  lines.forEach((e, i) => {
    deepStrictEqual(Object.keys(e), KEYS[e.kind], e.kind);
    strictEqual(e.seq, i + 1);
    strictEqual(e.schema, E.EVENT_SCHEMA);
    ok(existsSync(e.pointer), `${e.kind} points at ${e.pointer}`);
  });
}

describe('a serial run\'s events (ADR-0068 Decision 4)', () => {
  it('a halt and a completion: each kind once, with its fields only, pointing at the records that hold the rest, and no text', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [DONE], file: false } } });
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      const r1 = t.latest();
      const e1 = t.of(r1.run.run_id);
      wellFormed(e1);
      deepStrictEqual(e1.map((e) => e.kind), ['run-started', 'commit-finished', 'halt', 'run-ended']);
      const [started, commit, halt, ended] = e1;
      deepStrictEqual([started.lanes, started.detector, started.run_dir, started.pointer, started.macro_id], [1, 'off', r1.dir, join(r1.dir, 'run.json'), t.fx.macroId]);
      deepStrictEqual([commit.subtask_id, commit.step, commit.commit, commit.readiness, commit.pointer],
        ['A', 2, t.fx.git('rev-parse', 'feat/a'), r1.landing[0].sync.state, join(r1.dir, 'landing.jsonl')]);
      deepStrictEqual([halt.reason, halt.step, halt.pointer, halt.step_record], ['awaiting-landing', null, join(r1.dir, 'run.json'), null]);
      deepStrictEqual([ended.status, ended.reason, ended.exit, ended.pointer, ended.cleanup, ended.terminal], ['halted', 'awaiting-landing', 2, join(r1.dir, 'halt.json'), false, true]);
      deepStrictEqual(r1.run.events, { path: t.file, failed_writes: 0 });
      ok(t.lines.includes(`  events ${t.file}`), t.lines.join('\n'));
      ok(t.lines.includes(`  watch: agentic-autopilot events --macro ${t.fx.macroId} --after ${r1.run.run_id}:0 --follow`), t.lines.join('\n'));
      // The relaunch, after the owner merges A, completes the macro.
      t.fx.setPrs([t.fx.land('A', 'feat/a')]);
      strictEqual(await t.run({ maxSteps: 4 }), 0, t.lines.join('\n'));
      const r2 = t.latest();
      const e2 = t.of(r2.run.run_id);
      wellFormed(e2);
      deepStrictEqual(e2.map((e) => e.kind), ['run-started', 'run-ended']);
      deepStrictEqual([e2[1].status, e2[1].reason, e2[1].exit, e2[1].pointer], ['completed', null, 0, join(r2.dir, 'run.json')]);
      // Nothing a worker reported, nor a halt's detail, reaches the file.
      const text = readFileSync(t.file, 'utf8');
      for (const s of ['scripted step', 'scripted verb', r1.halt.detail]) ok(!text.includes(s), s);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a step that fails: its step-failed with the halt code and no abort, then the halt at its step\'s line', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [DONE] }, actions: { 2: 'report-failed' } } });
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      const r = t.latest();
      const e = t.of(r.run.run_id);
      wellFormed(e);
      deepStrictEqual(e.map((x) => x.kind), ['run-started', 'step-failed', 'halt', 'run-ended']);
      const steps = join(r.dir, 'steps.jsonl');
      deepStrictEqual([e[1].subtask_id, e[1].step, e[1].reason, e[1].abort, e[1].pointer], ['A', 2, r.halt.reason, null, steps]);
      deepStrictEqual([e[2].reason, e[2].step, e[2].step_record], [r.halt.reason, 2, steps]);
      ok(!readFileSync(t.file, 'utf8').includes('scripted failure after the commit'));
    } finally {
      t.fx.cleanup();
    }
  });

  it('an interrupt during a step: step-failed with its abort kind, the interrupted halt, run-ended', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT] }, actions: { 1: 'sleep' } } });
    try {
      const running = t.run();
      for (let i = 0; i < 200 && !t.lines.some((l) => l.startsWith('[1] ')); i += 1) await new Promise((r) => { setTimeout(r, 50); });
      await new Promise((r) => { setTimeout(r, 300); });
      t.signals.emit('SIGTERM');
      strictEqual(await running, 2, t.lines.join('\n'));
      const r = t.latest();
      const e = t.of(r.run.run_id);
      wellFormed(e);
      deepStrictEqual(e.map((x) => [x.kind, x.reason ?? null, x.abort ?? null]), [
        ['run-started', null, null], ['step-failed', 'interrupted', 'interrupted'], ['halt', 'interrupted', null], ['run-ended', 'interrupted', null],
      ]);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a run that stops on an error: the step in flight\'s step-failed, then run-ended error, exit 1, and nothing after', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT] } } });
    try {
      await rejects(t.run({}, { startWorker: () => { throw new Error('simulated: the worker host is gone'); } }), /simulated/);
      const r = t.latest();
      const e = t.of(r.run.run_id);
      wellFormed(e);
      deepStrictEqual(e.map((x) => [x.kind, x.step ?? null, x.reason ?? null]), [['run-started', null, null], ['step-failed', 1, 'error'], ['run-ended', null, null]]);
      deepStrictEqual([e[2].status, e[2].exit, e[2].pointer], ['error', 1, join(r.dir, 'run.json')]);
      ok(!readFileSync(t.file, 'utf8').includes('simulated'));
    } finally {
      t.fx.cleanup();
    }
  });

  it('a launch refused at its locks writes no line, and is never reported missing its terminal event', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT] } } });
    try {
      // Another run holds the checkout's lock (this process stands for it).
      const other = await L.acquireLock(L.worktreeLockPath(t.work), { record: { run_id: 'autopilot-20261019T080000Z-0ther1' } });
      try {
        strictEqual(await t.run(), 2, t.lines.join('\n'));
      } finally {
        other.release();
      }
      const r = t.latest();
      strictEqual(r.halt.reason, 'owner-choice');
      strictEqual(r.run.events, undefined, 'run.json records no part in the event file');
      deepStrictEqual(t.events(), []);
      const w = await t.watch(`${r.run.run_id}:0`);
      strictEqual(w.code, 0);
      deepStrictEqual(w.got.filter((x) => x.kind === 'reader-terminal-missing'), []);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a write that fails is printed and counted in run.json while the run goes on; the reader then reports the run\'s terminal event missing', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [DONE], file: false } } });
    try {
      // The file's lock is a directory: no write can take it.
      mkdirSync(`${t.file}.lock`, { recursive: true });
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(r.steps.map((s) => [s.kind, s.outcome]), [['dispatch', 'ok'], ['commit', 'ok']], 'the run went on');
      strictEqual(r.halt.reason, 'awaiting-landing');
      deepStrictEqual(r.run.events, { path: t.file, failed_writes: 4 });
      strictEqual(t.lines.filter((l) => l.startsWith('⚠ the event file could not take a line')).length, 4);
      rmSync(`${t.file}.lock`, { recursive: true });
      const w = await t.watch(`${r.run.run_id}:0`);
      deepStrictEqual(w.got.filter((x) => x.kind === 'reader-terminal-missing').map((x) => [x.run_id, x.failed_writes, x.status, x.pointer]),
        [[r.run.run_id, 4, 'halted', join(r.dir, 'run.json')]]);
    } finally {
      t.fx.cleanup();
    }
  });

  it('the next run\'s start cleans up after a dead run: its run-ended, marked cleanup, after the new run\'s run-started', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [DONE], file: false } } });
    try {
      // A run that died: its run-started on file, its open-run record left.
      const dead = 'autopilot-20261019T080000Z-dead02';
      const runDir = L.createRunDir(t.work, dead);
      L.writeRun(runDir, {
        run_id: dead, repo: t.work, macro_id: t.fx.macroId, started_at: new Date().toISOString(), ended_at: null, status: 'running',
        roots: ROOTS, steps: 0, cost_usd: 0, cost_complete: true, accounted_seqs: [], halt: null, events: { path: t.file, failed_writes: 0 },
      });
      E.createEventWriter({ file: t.file, runId: dead, macroId: t.fx.macroId }).emit('run-started', { lanes: 1, detector: 'off', run_dir: runDir, pointer: join(runDir, 'run.json') });
      const { spawnSync } = await import('node:child_process');
      const gone = Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }).stdout);
      L.writeOpenRun(t.work, { runId: dead, macroId: t.fx.macroId, checkout: t.work, runDir, pid: gone, fingerprint: { kind: 'none' }, startedAt: new Date().toISOString() });
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      const r = t.latest();
      const order = t.events().map((e) => `${e.run_id === dead ? 'dead' : 'new'}:${e.kind}`);
      strictEqual(order.indexOf('dead:run-ended'), order.indexOf('new:run-started') + 1, order.join(', '));
      const end = t.of(dead).find((e) => e.kind === 'run-ended');
      deepStrictEqual([end.seq, end.status, end.reason, end.cleanup, end.pointer], [2, 'halted', 'interrupted', true, join(runDir, 'halt.json')]);
      wellFormed(t.of(r.run.run_id));
    } finally {
      t.fx.cleanup();
    }
  });

  it('a run that halts at its start, after it joined the file and before its open-run record: its locks name it until its run-ended is on file, and a reader then reports nothing missing', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT] } } });
    try {
      // The look under the locks finds another macro: the run halts there.
      let looks = 0;
      const observe = (a) => {
        looks += 1;
        const v = realObserve(a);
        return looks === 2 ? { ...v, macro: null } : v;
      };
      // At the run's last output before its run-ended, a reader runs, as a
      // Monitor arming then would: in another process, its arm-time reconcile.
      let runId = null;
      let probe = null;
      const out = (s) => {
        t.lines.push(s);
        if (s.startsWith('autopilot autopilot-')) runId = s.slice('autopilot '.length);
        if (!s.startsWith('  run autopilot-')) return;
        const r = spawnSync(process.execPath, ['--input-type=module', '-e', READER, CLI, 'events', '--macro', t.fx.macroId, '--after', `${runId}:0`, '--repo', t.work],
          { encoding: 'utf8', env: { ...t.env, AGENTIC_HOST: 'claude' }, timeout: 60_000 });
        probe = {
          ended: t.of(runId).some((e) => e.kind === 'run-ended'),
          locks: L.listLocks(t.work, t.work).filter((l) => l.holder?.run_id === runId).length,
          open: L.readOpenRun(t.work, runId) !== null,
          status: r.status,
          got: r.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)),
        };
      };
      strictEqual(await startRun({
        repoRoot: t.work, options: { ...DEFAULTS, models: 'owner-default', model: null, effort: null, macro: null, forced: null, forcedText: null, notifyLocal: false },
        env: t.env, out, err: (s) => t.lines.push(`ERR ${s}`), deps: { signals: new EventEmitter(), observe },
      }), 2, t.lines.join('\n'));
      const r = t.latest();
      ok(/the macro changed while the run took its locks/.test(r.halt.detail), r.halt.detail);
      // The probe ran in the window: the run took part, wrote no open-run
      // record, and its run-ended was not on file yet.
      ok(r.run.events, 'run.json records its part in the event file');
      ok(probe, 'the reader ran before the run ended');
      deepStrictEqual([probe.ended, probe.open], [false, false]);
      ok(probe.locks > 0, 'a lock entry names the live driver');
      strictEqual(probe.status, 0);
      ok(probe.got.some((x) => x.kind === 'reader-armed'), JSON.stringify(probe.got));
      deepStrictEqual(probe.got.filter((x) => x.kind === 'reader-terminal-missing'), []);
      // Then its end, and its locks go.
      deepStrictEqual(t.of(runId).map((e) => e.kind), ['run-started', 'halt', 'run-ended']);
      deepStrictEqual(L.listLocks(t.work, t.work).filter((l) => l.holder?.run_id === runId), []);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a run that stops on an error at its start, before its open-run record: run-ended error is written while its locks still name it', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT] } } });
    try {
      let looks = 0;
      const observe = (a) => {
        looks += 1;
        if (looks === 2) throw new Error('simulated: the look under the locks failed');
        return realObserve(a);
      };
      const atEnd = [];
      const eventsWriteSync = (fd, buf, off, len) => {
        for (const raw of buf.toString('utf8', off, off + len).split('\n')) {
          let e = null;
          try { e = JSON.parse(raw); } catch { /* a lead newline */ }
          if (e?.kind === 'run-ended') atEnd.push([e.status, L.listLocks(t.work, t.work).filter((l) => l.holder?.run_id === e.run_id).length > 0]);
        }
        return writeSync(fd, buf, off, len);
      };
      await rejects(t.run({}, { observe, eventsWriteSync }), /simulated/);
      const r = t.latest();
      deepStrictEqual(t.of(r.run.run_id).map((e) => e.kind), ['run-started', 'run-ended']);
      deepStrictEqual(atEnd, [['error', true]]);
      deepStrictEqual(L.listLocks(t.work, t.work).filter((l) => l.holder?.run_id === r.run.run_id), [], 'released after');
    } finally {
      t.fx.cleanup();
    }
  });

  it('a run whose record of its part in the event file failed records none after, and is never reported missing its terminal event', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT] } } });
    // The first run.json write that records the run's part fails; every
    // other write goes through.
    const rename = fs.renameSync;
    let failed = 0;
    fs.renameSync = (from, to) => {
      if (failed === 0 && String(to).endsWith('run.json') && /"events"/.test(fs.readFileSync(from, 'utf8'))) {
        failed += 1;
        throw new Error('simulated: run.json could not be written');
      }
      return rename(from, to);
    };
    try {
      await rejects(t.run(), /simulated/);
      fs.renameSync = rename;
      strictEqual(failed, 1);
      const r = t.latest();
      strictEqual(r.run.status, 'error');
      strictEqual(r.run.events, undefined, 'run.json records no part in the event file');
      deepStrictEqual(t.of(r.run.run_id), []);
      const w = await t.watch(`${r.run.run_id}:0`);
      strictEqual(w.code, 0);
      deepStrictEqual(w.got.filter((x) => x.kind === 'reader-terminal-missing'), []);
    } finally {
      fs.renameSync = rename;
      t.fx.cleanup();
    }
  });

  it('a lock entry that cannot be removed after an early end\'s run-ended is printed, and leaves the end it published standing', { skip: process.getuid?.() === 0 ? 'root removes it anyway' : false }, async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT] } } });
    const dirs = [L.worktreeLockPath(t.work), L.macroLockPath(t.work, t.fx.macroId)];
    try {
      let looks = 0;
      const observe = (a) => {
        looks += 1;
        const v = realObserve(a);
        return looks === 2 ? { ...v, macro: null } : v;
      };
      // At the run's last output, its lock directories stop taking removals.
      const out = (s) => {
        t.lines.push(s);
        if (s.startsWith('  run autopilot-')) for (const d of dirs) chmodSync(d, 0o555);
      };
      strictEqual(await startRun({
        repoRoot: t.work, options: { ...DEFAULTS, models: 'owner-default', model: null, effort: null, macro: null, forced: null, forcedText: null, notifyLocal: false },
        env: t.env, out, err: (s) => t.lines.push(`ERR ${s}`), deps: { signals: new EventEmitter(), observe },
      }), 2, t.lines.join('\n'));
      const r = t.latest();
      strictEqual(r.run.status, 'halted');
      const ended = t.of(r.run.run_id).at(-1);
      deepStrictEqual([ended.kind, ended.status, ended.exit], ['run-ended', 'halted', 2]);
      ok(t.lines.some((l) => l.startsWith('⚠ a lock entry of the run could not be removed')), t.lines.join('\n'));
    } finally {
      for (const d of dirs) { try { chmodSync(d, 0o755); } catch { /* gone */ } }
      t.fx.cleanup();
    }
  });

  it('a lock entry that cannot be removed at a recorded run\'s end is printed, and its run-ended is still written', { skip: process.getuid?.() === 0 ? 'root removes it anyway' : false }, async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [DONE], file: false } } });
    const dirs = [L.worktreeLockPath(t.work), L.macroLockPath(t.work, t.fx.macroId)];
    try {
      // As the run publishes the halt that ends it, its lock directories stop
      // taking removals.
      const eventsWriteSync = (fd, buf, off, len) => {
        if (buf.toString('utf8', off, off + len).includes('"kind":"halt"')) for (const d of dirs) chmodSync(d, 0o555);
        return writeSync(fd, buf, off, len);
      };
      strictEqual(await t.run({}, { eventsWriteSync }), 2, t.lines.join('\n'));
      const r = t.latest();
      strictEqual(r.run.status, 'halted');
      const ended = t.of(r.run.run_id).at(-1);
      deepStrictEqual([ended.kind, ended.status, ended.reason, ended.exit], ['run-ended', 'halted', 'awaiting-landing', 2]);
      ok(t.lines.some((l) => l.startsWith('⚠ a lock entry of the run could not be removed')), t.lines.join('\n'));
      strictEqual(t.signals.listenerCount('SIGINT'), 0, 'its signal handlers are detached');
    } finally {
      for (const d of dirs) { try { chmodSync(d, 0o755); } catch { /* gone */ } }
      t.fx.cleanup();
    }
  });

  it('a lock entry that cannot be removed when a recorded run stops on an error: run-ended error is written, the run\'s own error thrown', { skip: process.getuid?.() === 0 ? 'root removes it anyway' : false }, async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT] } } });
    const dirs = [L.worktreeLockPath(t.work), L.macroLockPath(t.work, t.fx.macroId)];
    try {
      const eventsWriteSync = (fd, buf, off, len) => {
        if (buf.toString('utf8', off, off + len).includes('"kind":"step-failed"')) for (const d of dirs) chmodSync(d, 0o555);
        return writeSync(fd, buf, off, len);
      };
      await rejects(t.run({}, { eventsWriteSync, startWorker: () => { throw new Error('simulated: the worker host is gone'); } }), /simulated/);
      const r = t.latest();
      strictEqual(r.run.status, 'error');
      deepStrictEqual(t.of(r.run.run_id).map((e) => [e.kind, e.status ?? null]), [['run-started', null], ['step-failed', null], ['run-ended', 'error']]);
      strictEqual(t.signals.listenerCount('SIGINT'), 0, 'its signal handlers are detached');
    } finally {
      for (const d of dirs) { try { chmodSync(d, 0o755); } catch { /* gone */ } }
      t.fx.cleanup();
    }
  });

  it('a warning that cannot be printed after the run-ended leaves the end it published standing: an early end\'s lock entry, a recorded end\'s open-run record', { skip: process.getuid?.() === 0 ? 'root removes it anyway' : false }, async () => {
    // An early end (the macro changed under the locks): its lock entry cannot
    // be removed after its run-ended, and the warning's output fails.
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [DONE], file: false } } });
    const dirs = [L.worktreeLockPath(t.work), L.macroLockPath(t.work, t.fx.macroId)];
    const opts = { ...DEFAULTS, models: 'owner-default', model: null, effort: null, macro: null, forced: null, forcedText: null, notifyLocal: false };
    let openDir = null;
    try {
      let looks = 0;
      const observe = (a) => {
        looks += 1;
        const v = realObserve(a);
        return looks === 2 ? { ...v, macro: null } : v;
      };
      const early = (s) => {
        if (s.startsWith('⚠ a lock entry of the run could not be removed')) throw new Error('simulated: EPIPE');
        t.lines.push(s);
        if (s.startsWith('  run autopilot-')) for (const d of dirs) chmodSync(d, 0o555);
      };
      strictEqual(await startRun({ repoRoot: t.work, options: opts, env: t.env, out: early, err: (s) => t.lines.push(`ERR ${s}`), deps: { signals: new EventEmitter(), observe } }), 2, t.lines.join('\n'));
      const r1 = t.latest();
      strictEqual(r1.run.status, 'halted');
      deepStrictEqual([t.of(r1.run.run_id).at(-1).kind, t.of(r1.run.run_id).at(-1).status], ['run-ended', 'halted']);
      for (const d of dirs) chmodSync(d, 0o755);
      // Its entries name this process, alive: gone, as when that driver exits.
      const left = L.listLocks(t.work, t.work).filter((l) => l.holder?.run_id === r1.run.run_id);
      ok(left.length > 0, 'the early end left its lock entries');
      for (const l of left) rmSync(l.entry);
      // A recorded end: its open-run record cannot be removed after its
      // run-ended, and the warning's output fails.
      let runId = null;
      const recorded = (s) => {
        if (s.startsWith('⚠ the run\'s open-run record could not be removed')) throw new Error('simulated: EPIPE');
        t.lines.push(s);
        if (s.startsWith('autopilot autopilot-')) runId = s.slice('autopilot '.length);
        if (s.startsWith('  run autopilot-')) {
          openDir = resolve(L.openRunPath(t.work, runId), '..');
          chmodSync(openDir, 0o555);
        }
      };
      strictEqual(await startRun({ repoRoot: t.work, options: opts, env: t.env, out: recorded, err: (s) => t.lines.push(`ERR ${s}`), deps: { signals: new EventEmitter() } }), 2, t.lines.join('\n'));
      const r2 = t.latest();
      strictEqual(r2.run.run_id, runId);
      strictEqual(r2.run.status, 'halted');
      deepStrictEqual([t.of(runId).at(-1).kind, t.of(runId).at(-1).status], ['run-ended', 'halted']);
    } finally {
      for (const d of [...dirs, ...(openDir ? [openDir] : [])]) { try { chmodSync(d, 0o755); } catch { /* gone */ } }
      t.fx.cleanup();
    }
  });

  it('a signal while the run\'s end is notified interrupts nothing: a real SIGHUP, and run-ended is still written', { skip: process.platform === 'win32' ? 'no SIGHUP' : false }, async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [DONE], file: false } } });
    try {
      // The driver in a process of its own, its signals the process's: the
      // notification, as a closed terminal or an ssh drop would, sends SIGHUP.
      const child = 'const [drv, repo, opts] = process.argv.slice(1); const { startRun, DEFAULTS } = await import(drv);'
        + ' process.exitCode = await startRun({ repoRoot: repo, options: { ...DEFAULTS, ...JSON.parse(opts) }, env: process.env, out: () => {}, err: () => {},'
        + " deps: { platform: 'darwin', notifySpawn: () => { process.kill(process.pid, 'SIGHUP'); return { status: 0 }; } } });";
      const opts = { models: 'owner-default', model: null, effort: null, macro: null, forced: null, forcedText: null, notifyLocal: true };
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', child, resolve(AP, 'driver.mjs'), t.work, JSON.stringify(opts)], { encoding: 'utf8', env: t.env, timeout: 120_000 });
      deepStrictEqual([r.signal, r.status], [null, 2], r.stderr);
      const run = t.latest();
      strictEqual(run.run.status, 'halted');
      const ended = t.of(run.run.run_id).at(-1);
      deepStrictEqual([ended.kind, ended.status, ended.exit], ['run-ended', 'halted', 2]);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a reader that finds no open-run record, then no lock entry, reads the record again: a driver that wrote it in between and released its locks is alive', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT] } } });
    // A live run past its start: run.json records its part, run-started is
    // on file, no run-ended. The reader's reconcile (its second look at the
    // run, after the armed line's) first finds no open-run record; while it
    // reads run.json the driver writes its record (this process stands for
    // the driver) and holds no lock entry, as at its end.
    const id = 'autopilot-20261019T080000Z-beef03';
    const runDir = L.createRunDir(t.work, id);
    L.writeRun(runDir, {
      run_id: id, repo: t.work, macro_id: t.fx.macroId, started_at: new Date().toISOString(), ended_at: null, status: 'running',
      roots: ROOTS, steps: 0, cost_usd: 0, cost_complete: true, accounted_seqs: [], halt: null, events: { path: t.file, failed_writes: 0 },
    });
    E.createEventWriter({ file: t.file, runId: id, macroId: t.fx.macroId }).emit('run-started', { lanes: 1, detector: 'off', run_dir: runDir, pointer: join(runDir, 'run.json') });
    const fingerprint = await L.processFingerprint(process.pid);
    const read = fs.readFileSync;
    let reads = 0;
    let wrote = 0;
    fs.readFileSync = (p, ...rest) => {
      if (String(p) === join(runDir, 'run.json') && (reads += 1) === 2) {
        wrote += 1;
        L.writeOpenRun(t.work, { runId: id, macroId: t.fx.macroId, checkout: t.work, runDir, pid: process.pid, fingerprint, startedAt: new Date().toISOString() });
      }
      return read(p, ...rest);
    };
    syncBuiltinESMExports();
    try {
      const w = await t.watch(`${id}:0`);
      strictEqual(wrote, 1, 'the record was written between the reader\'s first read of it and its lock scan');
      strictEqual(w.code, 0);
      deepStrictEqual(w.got.filter((x) => x.kind === 'reader-terminal-missing'), []);
    } finally {
      fs.readFileSync = read;
      syncBuiltinESMExports();
      t.fx.cleanup();
    }
  });

  it('output that fails after the halt is recorded: the halt published, then run-ended error, exit 1, at run.json', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [DONE], file: false } } });
    try {
      const out = (s) => { if (s.startsWith('  run autopilot-')) throw new Error('simulated: EPIPE'); t.lines.push(s); };
      await rejects(startRun({
        repoRoot: t.work, options: { ...DEFAULTS, models: 'owner-default', model: null, effort: null, macro: null, forced: null, forcedText: null, notifyLocal: false },
        env: t.env, out, err: (s) => t.lines.push(s), deps: { signals: new EventEmitter() },
      }), /EPIPE/);
      const r = t.latest();
      const e = t.of(r.run.run_id);
      deepStrictEqual(e.map((x) => x.kind).slice(-2), ['halt', 'run-ended']);
      deepStrictEqual([e.at(-1).status, e.at(-1).exit, e.at(-1).pointer, r.run.status], ['error', 1, join(r.dir, 'run.json'), 'error']);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a landing report that could not be recorded publishes no commit-finished pointing at it', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [DONE], file: false } } });
    try {
      // The macro's landing log is a directory: no report can be recorded.
      mkdirSync(join(t.work, '.agentic-plugins/runs/autopilot/landing', `${t.fx.macroId}.jsonl`), { recursive: true });
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      const e = t.of(t.latest().run.run_id);
      deepStrictEqual(e.filter((x) => x.kind === 'commit-finished'), []);
      deepStrictEqual(e.map((x) => x.kind), ['run-started', 'halt', 'run-ended']);
    } finally {
      t.fx.cleanup();
    }
  });

  it('--notify-local is unchanged: one fixed AppleScript, the payload as argv, on macOS only', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [DONE], file: false } } });
    try {
      const calls = [];
      const notifySpawn = (cmd, args, o) => { calls.push([cmd, args, o]); return { status: 0 }; };
      strictEqual(await t.run({ notifyLocal: true }, { platform: 'darwin', notifySpawn }), 2, t.lines.join('\n'));
      const r = t.latest();
      const script = ['-e', 'on run argv', '-e', 'display notification (item 1 of argv) with title (item 2 of argv)', '-e', 'end run'];
      deepStrictEqual(calls, [['osascript', [...script, `${r.halt.reason} — ${r.halt.detail}`.slice(0, 180), 'autopilot: halted'], { stdio: 'ignore', timeout: 5000 }]]);
      t.fx.setPrs([t.fx.land('A', 'feat/a')]);
      strictEqual(await t.run({ notifyLocal: true, maxSteps: 4 }, { platform: 'darwin', notifySpawn }), 0, t.lines.join('\n'));
      deepStrictEqual(calls[1], ['osascript', [...script, 'the macro completed', 'autopilot: completed'], { stdio: 'ignore', timeout: 5000 }]);
      // Elsewhere, or without the flag, none.
      await t.run({ notifyLocal: true }, { platform: 'linux', notifySpawn });
      await t.run({ notifyLocal: false }, { platform: 'darwin', notifySpawn });
      strictEqual(calls.length, 2);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a recorded run\'s run-ended is on file before its open-run record goes', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [DONE], file: false } } });
    try {
      // Read at the write itself: whether the record is still there.
      const seen = [];
      const eventsWriteSync = (fd, buf, off, len) => {
        const text = buf.toString('utf8', off, off + len);
        if (text.includes('"kind":"run-ended"')) seen.push(L.readOpenRun(t.work, JSON.parse(text.trim()).run_id) !== null);
        return writeSync(fd, buf, off, len);
      };
      strictEqual(await t.run({}, { eventsWriteSync }), 2, t.lines.join('\n'));
      deepStrictEqual(seen, [true], 'the record was there when run-ended was written');
      strictEqual(L.readOpenRun(t.work, t.latest().run.run_id), null, 'and is gone after it');
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('stop and status while a run ends (ADR-0068 Decision 4)', () => {
  it('stop asked once the run has released its locks, its record still there and its driver alive, waits for it to end and reports none active', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT] } } });
    // A run past its locks, ending: its record names this live process
    // (standing for its driver), which removes it a moment later, as the
    // driver does after its run-ended.
    const id = 'autopilot-20261019T080000Z-beef04';
    const runDir = L.createRunDir(t.work, id);
    // Its end recorded, as finish writes it before it releases the locks.
    L.writeRun(runDir, { run_id: id, repo: t.work, macro_id: t.fx.macroId, status: 'halted', steps: 0, cost_usd: 0, roots: ROOTS });
    const fingerprint = await L.processFingerprint(process.pid);
    L.writeOpenRun(t.work, { runId: id, macroId: t.fx.macroId, checkout: t.work, runDir, pid: process.pid, fingerprint, startedAt: new Date().toISOString() });
    const removed = setTimeout(() => L.removeOpenRun(t.work, id), 700);
    try {
      const lines = [];
      const code = await C.main(['stop', '--macro', t.fx.macroId, '--repo', t.work], { env: t.env, out: (s) => lines.push(s), err: (s) => lines.push(`ERR ${s}`) });
      strictEqual(code, 0, lines.join('\n'));
      ok(lines.includes(`run ${id} is ending; waiting for it`), lines.join('\n'));
      ok(lines.includes('no autopilot run is active'), lines.join('\n'));
      ok(!lines.some((l) => /is not stopped/.test(l)), lines.join('\n'));
    } finally {
      clearTimeout(removed);
      t.fx.cleanup();
    }
  });

  it('a run whose end is slow (its notification, then run-ended, then its record goes) is stopped, not reported dead, and status shows no cleanup pending', { timeout: 120_000 }, async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT] }, B: { next: [DONE] }, actions: { 1: 'sleep' } } });
    const marker = join(t.fx.dir, 'notifying');
    try {
      // The driver in a process of its own; its notification marks the
      // window (locks released, record still there) and lasts 2 s.
      const child = 'const [drv, repo, opts, marker] = process.argv.slice(1); const { startRun, DEFAULTS } = await import(drv); const fs = await import("node:fs");'
        + ' process.exitCode = await startRun({ repoRoot: repo, options: { ...DEFAULTS, ...JSON.parse(opts) }, env: process.env, out: () => {}, err: () => {},'
        + ' deps: { platform: "darwin", notifySpawn: () => { fs.writeFileSync(marker, "x"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000); return { status: 0 }; } } });';
      const opts = { models: 'owner-default', model: null, effort: null, macro: null, forced: null, forcedText: null, notifyLocal: true };
      const driver = spawn(process.execPath, ['--input-type=module', '-e', child, resolve(AP, 'driver.mjs'), t.work, JSON.stringify(opts), marker], { env: t.env, stdio: ['ignore', 'ignore', 'pipe'] });
      let derr = '';
      driver.stderr.on('data', (d) => { derr += d; });
      const exited = new Promise((r) => { driver.on('exit', (code) => r(code)); });
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && !existsSync(join(t.fx.dir, 'ledger-1.json'))) await new Promise((r) => { setTimeout(r, 100); });
      ok(existsSync(join(t.fx.dir, 'ledger-1.json')), `the step started: ${derr}`);
      const stop = spawn(process.execPath, [CLI, 'stop', '--repo', t.work], { env: t.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let sout = '';
      stop.stdout.on('data', (d) => { sout += d; });
      stop.stderr.on('data', (d) => { sout += d; });
      const stopped = new Promise((r) => { stop.on('exit', (code) => r(code)); });
      while (Date.now() < deadline && !existsSync(marker)) await new Promise((r) => { setTimeout(r, 20); });
      ok(existsSync(marker), `the driver reached its notification: ${derr}`);
      // In the window: no live lock entry, the record there, its driver alive.
      const runId = L.listRuns(t.work).at(-1);
      ok(L.readOpenRun(t.work, runId), 'the record is still there');
      const status = spawnSync(process.execPath, [CLI, 'status', '--json', '--repo', t.work], { env: t.env, encoding: 'utf8' });
      strictEqual(status.status, 0, status.stderr);
      strictEqual(JSON.parse(status.stdout).cleanup_pending, false, 'a run ending is not one to clean up after');
      strictEqual(await stopped, 0, sout);
      ok(/it stopped; its halt is recorded as interrupted/.test(sout), sout);
      ok(!/exited without recording its end/.test(sout), sout);
      strictEqual(await exited, 2, derr);
      const r = t.latest();
      deepStrictEqual([r.run.status, r.halt.reason, r.run.dead_run_cleanup ?? null], ['halted', 'interrupted', null]);
      deepStrictEqual(t.of(runId).at(-1).kind, 'run-ended');
    } finally {
      t.fx.cleanup();
    }
  });
});
