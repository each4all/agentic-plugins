// tests/orchestrator/test-autopilot-events-cleanup.mjs
//
// ADR-0068 Decision 4, items 1, 3 and 4 — a dead run's `run-ended`, written
// by its cleanup (dead-runs.mjs, through `stop` or the next run's start): once,
// with a new identity, after a line the driver tore; with the outcome the
// run's run.json records; among the lines of the next run when it finishes
// after that run began; never for a run that took no part in the file.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeRepo, ORCH, ENG, RUNTIME } from './fixtures/autopilot-repo.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const AP = resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot');
const DR = await import(join(AP, 'dead-runs.mjs'));
const L = await import(join(AP, 'ledger.mjs'));
const E = await import(join(AP, 'events.mjs'));
const C = await import(join(AP, 'cli.mjs'));

const DEAD = 'autopilot-20261019T090000Z-dead01';
const NEXT = 'autopilot-20261019T091500Z-0e7701';

// A process that is gone, and the fingerprint it had: a dead driver.
async function deadProcess() {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  await new Promise((r) => { setTimeout(r, 200); });
  const fingerprint = await L.processFingerprint(child.pid);
  const exited = new Promise((r) => child.on('exit', r));
  child.kill('SIGKILL');
  await exited;
  return { pid: child.pid, fingerprint };
}

async function setup() {
  const fx = await makeRepo();
  const work = realpathSync(fx.work);
  const mainRoot = L.mainWorktreeRoot(work);
  const file = E.eventsPath({ mainRoot, macroId: fx.macroId, checkout: work });
  const t0 = new Date(Date.now() - 60_000).toISOString();
  const t = {
    fx, work, mainRoot, file,
    // A dead run that took part in the event file: its run-started on file,
    // run.json as the driver last wrote it, and its open-run record.
    async deadRun({ status = 'running', halt = null, events = true, runId = DEAD } = {}) {
      const runDir = L.createRunDir(work, runId);
      L.writeRun(runDir, {
        run_id: runId, repo: work, macro_id: fx.macroId, started_at: t0, ended_at: status === 'running' ? null : t0, status,
        roots: { orchestrator: ORCH, engineer: ENG, runtime: RUNTIME },
        state_root: { root: work, source: 'checkout', shared_creation: 'off', default_state_root: work },
        steps: 0, cost_usd: 0, cost_complete: true, accounted_seqs: [], halt,
        ...(events ? { events: { path: file, failed_writes: 0 } } : {}),
      });
      if (halt) L.writeHalt(runDir, halt);
      if (events) E.createEventWriter({ file, runId, macroId: fx.macroId }).emit('run-started', { lanes: 1, detector: 'off', run_dir: runDir, pointer: join(runDir, 'run.json') });
      const driver = await deadProcess();
      L.writeOpenRun(mainRoot, { runId, macroId: fx.macroId, checkout: work, runDir, pid: driver.pid, fingerprint: driver.fingerprint, startedAt: t0 });
      return runDir;
    },
    cleanup: (by = 'run test') => DR.cleanupDeadRuns({ mainRoot, macroId: fx.macroId, engineerRoot: ENG, by: { run_id: null, label: by } }),
    lines: () => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }),
  };
  return t;
}
const ended = (ls, runId = DEAD) => ls.filter((e) => e?.run_id === runId && e.kind === 'run-ended');

describe('a dead run\'s run-ended, written by its cleanup', () => {
  it('a driver killed mid-line, then a cleanup: the run-ended takes a new identity, and a torn line holding complete JSON is not duplicated', async () => {
    const t = await setup();
    try {
      const runDir = await t.deadRun();
      // The driver died writing seq 2: its JSON whole, its newline not.
      appendFileSync(t.file, JSON.stringify({ schema: E.EVENT_SCHEMA, run_id: DEAD, seq: 2, at: new Date().toISOString(), kind: 'lane-held', macro_id: t.fx.macroId, subtask_id: 'A', hold_id: '0123456789abcdef', pointer: join(runDir, 'lanes.jsonl') }));
      const [r] = await t.cleanup();
      strictEqual(r.outcome, 'cleaned', JSON.stringify(r));
      const ls = t.lines();
      deepStrictEqual(ls.map((e) => [e.seq, e.kind]), [[1, 'run-started'], [2, 'lane-held'], [3, 'run-ended']]);
      const [end] = ended(ls);
      deepStrictEqual([end.status, end.reason, end.exit, end.pointer, end.cleanup, end.terminal], ['halted', 'interrupted', 2, join(runDir, 'halt.json'), true, true]);
      ok(readFileSync(t.file, 'utf8').endsWith('\n'));
      deepStrictEqual(L.readRun(t.work, DEAD).run.events, { path: t.file, failed_writes: 0 });
    } finally {
      t.fx.cleanup();
    }
  });

  it('a cleanup retried after it wrote run-ended (its record put back, as a crash before its removal leaves it) writes no second', async () => {
    const t = await setup();
    try {
      await t.deadRun();
      await t.cleanup();
      const record = await deadProcess();
      const runDir = L.readRun(t.work, DEAD).dir;
      L.writeOpenRun(t.mainRoot, { runId: DEAD, macroId: t.fx.macroId, checkout: t.work, runDir, pid: record.pid, fingerprint: record.fingerprint, startedAt: new Date().toISOString() });
      const [again] = await t.cleanup();
      strictEqual(again.outcome, 'cleaned');
      strictEqual(ended(t.lines()).length, 1);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a run that recorded its end and died before its line keeps that end: completed at run.json, halted at halt.json with its own reason', async () => {
    const t = await setup();
    try {
      const done = await t.deadRun({ status: 'completed' });
      await t.cleanup();
      deepStrictEqual(ended(t.lines()).map((e) => [e.status, e.reason, e.exit, e.pointer, e.cleanup]), [['completed', null, 0, join(done, 'run.json'), true]]);
      strictEqual(L.readRun(t.work, DEAD).run.status, 'completed');
      const halt = { run_id: NEXT, reason: 'awaiting-landing', detail: 'a branch waits to land', pointer: null, resume: [] };
      const halted = await t.deadRun({ runId: NEXT, status: 'halted', halt });
      await t.cleanup();
      deepStrictEqual(ended(t.lines(), NEXT).map((e) => [e.status, e.reason, e.exit, e.pointer]), [['halted', 'awaiting-landing', 2, join(halted, 'halt.json')]]);
      ok(!readFileSync(t.file, 'utf8').includes('a branch waits to land'), 'no halt detail');
    } finally {
      t.fx.cleanup();
    }
  });

  it('a dead run\'s cleanup finishing after the next run began: its line among the new run\'s, and each identity its own', async () => {
    const t = await setup();
    try {
      await t.deadRun();
      const next = E.createEventWriter({ file: t.file, runId: NEXT, macroId: t.fx.macroId });
      next.emit('lane-held', { hold_id: '0123456789abcdef', pointer: join(t.work, '.agentic-plugins/runs/autopilot', NEXT, 'lanes.jsonl') });
      await t.cleanup();
      next.emit('lane-held', { hold_id: '0123456789abcdef', pointer: join(t.work, '.agentic-plugins/runs/autopilot', NEXT, 'lanes.jsonl') });
      deepStrictEqual(t.lines().map((e) => `${e.run_id === DEAD ? 'dead' : 'next'}:${e.seq}:${e.kind}`), [
        'dead:1:run-started', 'next:1:lane-held', 'dead:2:run-ended', 'next:2:lane-held',
      ]);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a run that took no part in the file (an older driver, a launch refused at its locks) gets no line', async () => {
    const t = await setup();
    try {
      await t.deadRun({ events: false });
      const [r] = await t.cleanup();
      strictEqual(r.outcome, 'cleaned');
      deepStrictEqual(ended((() => { try { return t.lines(); } catch { return []; } })()), []);
    } finally {
      t.fx.cleanup();
    }
  });

  it('through stop: the run-ended is written, and the reader then reports nothing missing', async () => {
    const t = await setup();
    try {
      await t.deadRun();
      const env = { ...t.fx.env, AGENTIC_HOST: 'claude', AGENTIC_ORCHESTRATOR_ROOT: ORCH, AGENTIC_ENGINEER_ROOT: ENG, AGENTIC_RUNTIME_ROOT: RUNTIME };
      const out = [];
      strictEqual(await C.main(['stop', '--macro', t.fx.macroId, '--repo', t.work], { env, out: (s) => out.push(s), err: (s) => out.push(s) }), 0, out.join('\n'));
      deepStrictEqual(ended(t.lines()).map((e) => [e.cleanup, e.status]), [[true, 'halted']]);
      const got = [];
      strictEqual(await C.main(['events', '--macro', t.fx.macroId, '--after', `${DEAD}:0`, '--repo', t.work], { env, out: (s) => got.push(JSON.parse(s)), err: () => {} }), 0);
      deepStrictEqual(got.filter((x) => x.kind === 'reader-terminal-missing'), []);
      deepStrictEqual(got.filter((x) => x.schema === E.EVENT_SCHEMA).map((x) => x.kind), ['run-started', 'run-ended']);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a run whose driver died after writing halt.json, before run.json recorded it: the cleanup\'s run-ended points at run.json, which holds the halt it names', async () => {
    const t = await setup();
    try {
      const runDir = await t.deadRun();
      L.writeHalt(runDir, { run_id: DEAD, reason: 'awaiting-landing', detail: 'a branch waits', pointer: null, resume: [] });
      await t.cleanup();
      const [end] = ended(t.lines());
      deepStrictEqual([end.reason, end.pointer], ['interrupted', join(runDir, 'run.json')]);
      strictEqual(L.readRun(t.work, DEAD).run.halt.reason, 'interrupted');
    } finally {
      t.fx.cleanup();
    }
  });

  it('is not reported while a cleanup of it runs, nor while a lock entry of it lives before its open-run record is written', async () => {
    const t = await setup();
    try {
      const runDir = await t.deadRun();
      const env = { ...t.fx.env, AGENTIC_HOST: 'claude' };
      const watch = async () => {
        const got = [];
        await C.main(['events', '--macro', t.fx.macroId, '--after', `${DEAD}:0`, '--repo', t.work], { env, out: (s) => got.push(JSON.parse(s)), err: () => {} });
        return got.filter((x) => x.kind === 'reader-terminal-missing');
      };
      // A cleanup under way (this process holds its lock).
      const cleaning = await L.acquireLock(join(t.mainRoot, '.agentic-plugins/runs/autopilot/open', `${DEAD}.cleanup.lock`), { record: { run_id: null, cleanup_of: DEAD } });
      deepStrictEqual(await watch(), []);
      cleaning.release();
      // The run's record gone, a live lock entry of the run left (a run holds
      // its locks before it writes its record).
      L.removeOpenRun(t.mainRoot, DEAD);
      const held = await L.acquireLock(L.macroLockPath(t.mainRoot, t.fx.macroId), { record: { run_id: DEAD } });
      deepStrictEqual(await watch(), []);
      held.release();
      deepStrictEqual((await watch()).map((x) => [x.run_id, x.pointer]), [[DEAD, join(runDir, 'run.json')]]);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a dead uncleaned run is reported missing its terminal event, pointing at its run.json', async () => {
    const t = await setup();
    try {
      const runDir = await t.deadRun();
      const got = [];
      const env = { ...t.fx.env, AGENTIC_HOST: 'claude' };
      strictEqual(await C.main(['events', '--macro', t.fx.macroId, '--after', `${DEAD}:0`, '--repo', t.work], { env, out: (s) => got.push(JSON.parse(s)), err: () => {} }), 0);
      deepStrictEqual(got.filter((x) => x.kind === 'reader-terminal-missing').map((x) => [x.run_id, x.status, x.pointer]), [[DEAD, 'running', join(runDir, 'run.json')]]);
    } finally {
      t.fx.cleanup();
    }
  });
});
