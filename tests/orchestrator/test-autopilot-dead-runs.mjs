// tests/orchestrator/test-autopilot-dead-runs.mjs
//
// ADR-0067 Decision 6, Locks — a dead run is cleaned up, not forgotten
// (plugins/orchestrator/adapters/claude/autopilot/dead-runs.mjs). A dead
// run's open-run record, ledger and peer-run handles are laid out in a scratch
// repository, and the real engineer peer-runner cancels what the cleanup asks
// it to. The end-to-end cases kill a real driver (the CLI, with the fake
// `claude` and the scripted worker) in the middle of a step whose verb started
// a peer, then clean up with `stop` or with the next run.

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeRepo, ORCH, ENG, RUNTIME } from './fixtures/autopilot-repo.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const AP = resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot');
const DR = await import(join(AP, 'dead-runs.mjs'));
const L = await import(join(AP, 'ledger.mjs'));
const C = await import(join(AP, 'cli.mjs'));
const { startRun, DEFAULTS } = await import(join(AP, 'driver.mjs'));
const RUNNER = await import(join(ENG, 'scripts/peer-runner.mjs'));
const FAKE = resolve(REPO_ROOT, 'tests/orchestrator/fixtures/autopilot-fake-claude.mjs');
const SCRIPTED = resolve(REPO_ROOT, 'tests/orchestrator/fixtures/autopilot-scripted-worker.mjs');

const DEAD = 'autopilot-20261009T010000Z-dead01';
const OTHER = 'autopilot-20261009T010000Z-0the12';

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (cond, ms = 15_000) => {
  for (const end = Date.now() + ms; Date.now() < end && !cond();) await new Promise((r) => { setTimeout(r, 100); });
  return cond();
};

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

// A live process in its own group, as peer-runner starts a peer, and not this
// process's child: a cleanup blocks this process in spawnSync while it cancels
// the peer, so a child of it would stay a zombie, unreaped, and peer-runner
// would see its fingerprint change (measured). An orphan is reaped by init.
function sleeper() {
  const r = spawnSync(process.execPath, ['-e', `
    const p = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    p.unref();
    process.stdout.write(String(p.pid));
  `], { encoding: 'utf8' });
  return Number(r.stdout);
}

async function setup() {
  const fx = await makeRepo();
  const work = realpathSync(fx.work);
  const mainRoot = L.mainWorktreeRoot(work);
  const t0 = new Date(Date.now() - 60_000).toISOString();
  const child = (id) => fx.eng.createWorkflow({
    repoRoot: work, verb: 'compose', host: 'claude', profile: 'backend', originalRequest: `do ${id}`,
    gitBaseline: { branch: `feat/${id.toLowerCase()}`, head: fx.git('rev-parse', 'HEAD'), status_digest: '' },
    currentPhase: 'phase-0-bootstrap', nextAction: 'Run the verb', parentWorkflow: fx.macroId, originatingSubtask: id,
  });
  const { filePath: wfA } = await child('A');
  const { filePath: wfB } = await child('B');
  const peerHome = join(work, '.agentic-plugins/state/engineer/peer-runs');
  const pids = [];
  const t = {
    fx, work, mainRoot, t0, wfA, wfB, pids,
    // A dead run: run.json as the driver last wrote it (one step charged), a
    // second step started and never finished, and its open-run record.
    async deadRun(runId = DEAD, { record = true, steps = [{ seq: 2, subtask_id: 'A', step_budget_usd: 25 }] } = {}) {
      const runDir = L.createRunDir(work, runId);
      L.writeRun(runDir, {
        run_id: runId, repo: work, macro_id: fx.macroId, started_at: t0, ended_at: null, status: 'running',
        roots: { orchestrator: ORCH, engineer: ENG, runtime: RUNTIME },
        state_root: { root: work, source: 'checkout', shared_creation: 'off', default_state_root: work },
        steps: 1, cost_usd: 3, cost_complete: true, halt: null,
      });
      L.appendStep(runDir, { event: 'started', seq: 1, kind: 'dispatch', subtask_id: 'A', step_budget_usd: 25, started_at: t0, session_id: 's-1' });
      L.appendStep(runDir, { event: 'finished', seq: 1, cost_usd: 3, outcome: 'ok' });
      for (const { finished, ...s } of steps) {
        L.appendStep(runDir, { event: 'started', kind: 'verb', started_at: t0, session_id: `s-${s.seq}`, ...s });
        if (finished) L.appendStep(runDir, { event: 'finished', seq: s.seq, outcome: 'ok', ...finished });
      }
      const driver = await deadProcess();
      if (record) L.writeOpenRun(mainRoot, { runId, macroId: fx.macroId, checkout: work, runDir, pid: driver.pid, fingerprint: driver.fingerprint, startedAt: t0 });
      return runDir;
    },
    // A peer-run handle as peer-runner writes it, `autopilot_run` included
    // when given; a live process behind it when `live`.
    async peer(id, { names, workflow = wfA, status = 'running', live = false, startedAt = new Date().toISOString() } = {}) {
      const pid = live ? sleeper() : null;
      if (pid) pids.push(pid);
      await new Promise((r) => { setTimeout(r, live ? 150 : 0); });
      const dir = join(peerHome, id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'handle.json'), JSON.stringify({
        schema_version: RUNNER.HANDLE_SCHEMA_VERSION, run_id: id, plugin: 'engineer', kind: 'ensemble', workflow_path: workflow,
        phase: 'compose', ensemble_type: 'plan-verify', host: 'claude', peer_host: 'codex', model: null, effort: null, cwd: work,
        output_format: 'json', status, pid, pgid: pid, process_fingerprint: pid ? await RUNNER.fingerprintForPid(pid) : { kind: 'none' },
        started_at: startedAt, updated_at: startedAt, completed_at: null, last_output_at: null, stdout_bytes: 0, stderr_bytes: 0,
        exit_code: null, error_kind: null, prompt_retained: false, ...(names !== undefined ? { autopilot_run: names } : {}),
      }, null, 2));
      return { id, pid, handle: () => JSON.parse(readFileSync(join(dir, 'handle.json'), 'utf8')) };
    },
    cleanup: (o = {}) => {
      const lines = [];
      return DR.cleanupDeadRuns({
        mainRoot, macroId: fx.macroId, engineerRoot: ENG, by: { run_id: null, label: 'stop' }, env: fx.env, out: (s) => lines.push(s), ...o,
      }).then((results) => ({ results, lines, of: (id) => results.find((r) => r.run_id === id) }));
    },
    done() {
      for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
      fx.cleanup();
    },
  };
  return t;
}

describe('cleaning up after a dead run (ADR-0067 Decision 6, Locks)', () => {
  it('cancels only the peers that name the dead run, reports a pending one that names no run, counts the unfinished step once, records the halt, then removes the record', { timeout: 60_000 }, async () => {
    const t = await setup();
    try {
      const runDir = await t.deadRun();
      const named = await t.peer('plan-verify-20261009T010001Z-aaaa01', { names: DEAD, live: true });
      const unnamed = await t.peer('plan-verify-20261009T010001Z-aaaa02');
      const others = await t.peer('plan-verify-20261009T010001Z-aaaa03', { names: OTHER, live: true });
      await t.peer('plan-verify-20261009T010001Z-aaaa04', { workflow: t.wfB });
      await t.peer('plan-verify-20261009T010001Z-aaaa05', { startedAt: new Date(Date.parse(t.t0) - 60_000).toISOString() });
      await t.peer('plan-verify-20261009T010001Z-aaaa06', { names: DEAD, status: 'completed' });

      const { results, lines, of } = await t.cleanup();
      strictEqual(results.length, 1, lines.join('\n'));
      const r = of(DEAD);
      strictEqual(r.outcome, 'cleaned', lines.join('\n'));
      deepStrictEqual(r.cancelled.map((c) => c.run_id), [named.id], 'only the pending peer that names the dead run');
      deepStrictEqual(r.reported.map((p) => p.run_id), [unnamed.id],
        'a pending peer that names no run, on the step\'s subtask since the step: not a later step\'s, not another subtask\'s');
      ok(await until(() => !alive(named.pid)), 'the named peer is gone');
      strictEqual(named.handle().status, 'cancelled');
      ok(alive(others.pid), 'a peer that names another run is left alone');
      strictEqual(others.handle().status, 'running');
      ok(lines.some((l) => l.includes(unnamed.id) && /names no run/.test(l) && /peer-runner\.mjs cancel --run-id/.test(l)), lines.join('\n'));

      const run = L.readRun(t.work, DEAD);
      deepStrictEqual([run.run.status, run.run.halt?.reason, run.halt?.reason], ['halted', 'interrupted', 'interrupted']);
      deepStrictEqual([run.run.steps, run.run.cost_usd, run.run.cost_complete], [2, 28, false], 'the unfinished step counts its whole budget, once');
      deepStrictEqual(run.run.dead_run_cleanup.settled, [{ seq: 2, charged_usd: 25, finished: false }]);
      strictEqual(L.readOpenRun(t.mainRoot, DEAD), null, 'the record goes last');

      // A second cleaner meeting the same record counts nothing twice.
      L.writeOpenRun(t.mainRoot, { runId: DEAD, macroId: t.fx.macroId, checkout: t.work, runDir, pid: 1 << 22, fingerprint: { kind: 'none' }, startedAt: t.t0 });
      const again = (await t.cleanup()).of(DEAD);
      deepStrictEqual([again.outcome, again.cancelled.length, again.settled.length], ['cleaned', 0, 0]);
      const twice = L.readRun(t.work, DEAD).run;
      deepStrictEqual([twice.steps, twice.cost_usd], [2, 28]);
    } finally {
      t.done();
    }
  });

  it('leaves a run whose driver or worker group still runs, keeps a record whose ledger is gone, and keeps one whose peer could not be cancelled', { timeout: 60_000 }, async () => {
    const t = await setup();
    const held = [];
    try {
      // A live driver: this process.
      const liveRun = 'autopilot-20261009T010000Z-11ae01';
      const liveDir = L.createRunDir(t.work, liveRun);
      L.writeRun(liveDir, { run_id: liveRun, status: 'running', macro_id: t.fx.macroId, steps: 0, cost_usd: 0 });
      L.writeOpenRun(t.mainRoot, { runId: liveRun, macroId: t.fx.macroId, checkout: t.work, runDir: liveDir, pid: process.pid, fingerprint: await L.processFingerprint(process.pid), startedAt: t.t0 });
      // A dead driver whose worker group runs on: its lock entry is live.
      const grouped = 'autopilot-20261009T010000Z-96007e';
      await t.deadRun(grouped);
      const worker = sleeper();
      t.pids.push(worker);
      await new Promise((r) => { setTimeout(r, 150); });
      const lock = L.macroLockPath(t.mainRoot, t.fx.macroId);
      mkdirSync(lock, { recursive: true });
      const gone = await deadProcess();
      writeFileSync(join(lock, `h-${gone.pid}-0a0b0c0d0e0f.json`), JSON.stringify({ run_id: grouped, macro_id: t.fx.macroId, ...gone, worker: { pid: worker, pgid: worker, fingerprint: await L.processFingerprint(worker) } }));
      // A record whose ledger is gone.
      const lost = 'autopilot-20261009T010000Z-10571e';
      const dead = await deadProcess();
      L.writeOpenRun(t.mainRoot, { runId: lost, macroId: t.fx.macroId, checkout: t.work, runDir: join(t.work, '.agentic-plugins/runs/autopilot', lost), pid: dead.pid, fingerprint: dead.fingerprint, startedAt: t.t0 });
      // Another macro's record: not this cleanup's.
      L.writeOpenRun(t.mainRoot, { runId: 'autopilot-20261009T010000Z-0a0a0a', macroId: 'macro-plan-20261009T000000Z-ffffff', checkout: t.work, runDir: join(t.work, 'x'), pid: dead.pid, fingerprint: dead.fingerprint, startedAt: t.t0 });
      // A dead run whose named peer cannot be cancelled: its process is not
      // the one the handle recorded (an unverifiable fingerprint).
      await t.deadRun(DEAD);
      const stuck = await t.peer('plan-verify-20261009T010001Z-bbbb01', { names: DEAD, live: true });
      const h = stuck.handle();
      writeFileSync(join(t.work, '.agentic-plugins/state/engineer/peer-runs', stuck.id, 'handle.json'), JSON.stringify({ ...h, process_fingerprint: { ...h.process_fingerprint, ...(h.process_fingerprint.lstart ? { lstart: 'Thu Jan  1 00:00:00 1970' } : { starttime: '1' }) } }));

      const { results, lines, of } = await t.cleanup();
      deepStrictEqual(results.map((r) => r.run_id).sort(), [DEAD, grouped, liveRun, lost].sort(), lines.join('\n'));
      deepStrictEqual([of(liveRun).outcome, of(grouped).outcome, of(lost).outcome, of(DEAD).outcome], ['live', 'live', 'kept', 'kept'], lines.join('\n'));
      match(of(grouped).detail, /a worker group of it still runs/);
      match(of(lost).detail, /ledger .* is gone/);
      for (const id of [liveRun, grouped, lost, DEAD]) ok(L.readOpenRun(t.mainRoot, id), `${id}'s record is kept`);
      ok(alive(stuck.pid), 'a peer the cleanup cannot prove is not signalled');
      // What could be done is done, and recorded; the halt waits.
      const run = L.readRun(t.work, DEAD).run;
      deepStrictEqual([run.status, run.steps, run.dead_run_cleanup.complete, run.dead_run_cleanup.unresolved], ['running', 2, false, [stuck.id]]);
      ok(lines.some((l) => /✗ peer run plan-verify-20261009T010001Z-bbbb01 may be its but was not cancelled/.test(l)), lines.join('\n'));
      strictEqual(L.readRun(t.work, grouped).run.status, 'running', 'nothing of a run with a live group is touched');

      // Someone else cleaning up after it: left to them.
      held.push(await L.acquireLock(join(L.openRunsDir(t.mainRoot), `${DEAD}.cleanup.lock`), { record: { run_id: null } }));
      strictEqual((await t.cleanup()).of(DEAD).outcome, 'busy');

      // stop: with the worker group gone, it cleans up after that run, and
      // exits 1 for what it has to keep (the lost ledger) or leave (DEAD, busy).
      // The live run's record goes first: its own case is stop's exit for a
      // live record, so here the exit is the kept and busy records' alone.
      L.removeOpenRun(t.mainRoot, liveRun);
      process.kill(worker, 'SIGKILL');
      ok(await until(() => !alive(worker)), 'the worker group is gone');
      const out = [];
      const errs = [];
      strictEqual(await C.main(['stop', '--repo', t.work, '--macro', t.fx.macroId], { env: t.fx.env, out: (s) => out.push(s), err: (s) => errs.push(s) }), 1, [...out, ...errs].join('\n'));
      ok(out.some((l) => l.startsWith(`dead run ${grouped}: cleaned up`)), out.join('\n'));
      ok(errs.some((l) => l.startsWith(`✗ dead run ${lost}:`)), errs.join('\n'));
      strictEqual(L.readOpenRun(t.mainRoot, grouped), null);
    } finally {
      for (const h of held) h.release();
      t.done();
    }
  });

  it('counts what run.json missed, a finished step\'s charge or an unfinished step\'s budget; keeps a run whose step log does not read; and tells a reused pid from its driver', { timeout: 60_000 }, async () => {
    const t = await setup();
    try {
      // Died between a step's finished line and the run.json that counts it,
      // then during the next step.
      const torn = 'autopilot-20261009T010000Z-70a170';
      await t.deadRun(torn, { steps: [{ seq: 2, subtask_id: 'A', step_budget_usd: 25, finished: { cost_usd: 4, cost_charged_usd: 4 } }, { seq: 3, subtask_id: 'A', step_budget_usd: 25 }] });
      // Died before its first spawn: nothing to count.
      const early = 'autopilot-20261009T010000Z-ea771e';
      const earlyDir = await t.deadRun(early, { steps: [] });
      L.writeRun(earlyDir, { ...L.readRun(t.work, early).run, steps: 0, cost_usd: 0 });
      writeFileSync(join(earlyDir, 'steps.jsonl'), '');
      // A step log with a line that does not parse before its last.
      const broken = 'autopilot-20261009T010000Z-b70e11';
      const brokenDir = await t.deadRun(broken);
      writeFileSync(join(brokenDir, 'steps.jsonl'), `{"event":"started","seq":1}\nnot json\n{"event":"started","seq":2}\n`);
      // A record whose pid now belongs to another process (this one, started
      // later than the record says).
      const reused = 'autopilot-20261009T010000Z-2e05ed';
      const reusedDir = await t.deadRun(reused, { record: false, steps: [] });
      const self = await L.processFingerprint(process.pid);
      const older = self.kind === 'linux_proc_starttime' ? { ...self, starttime: '1' } : { ...self, lstart: 'Thu Jan  1 00:00:00 1970' };
      L.writeOpenRun(t.mainRoot, { runId: reused, macroId: t.fx.macroId, checkout: t.work, runDir: reusedDir, pid: process.pid, fingerprint: older, startedAt: t.t0 });

      const { lines, of } = await t.cleanup();
      deepStrictEqual([of(torn).outcome, of(early).outcome, of(broken).outcome], ['cleaned', 'cleaned', 'kept'], lines.join('\n'));
      deepStrictEqual(of(torn).settled.map((s) => [s.seq, s.charged_usd, s.finished]), [[2, 4, true], [3, 25, false]]);
      const tr = L.readRun(t.work, torn).run;
      deepStrictEqual([tr.steps, tr.cost_usd, tr.cost_complete], [3, 32, false]);
      deepStrictEqual([of(early).settled, L.readRun(t.work, early).run.cost_usd, L.readRun(t.work, early).run.status], [[], 0, 'halted']);
      match(of(broken).detail, /line 2 of its step log does not parse/);
      strictEqual(L.readRun(t.work, broken).run.status, 'running', 'a run whose unfinished steps are not known is left as it is');
      ok(L.readOpenRun(t.mainRoot, broken));
      if (self.kind === 'none') return;
      strictEqual(of(reused).outcome, 'cleaned', `a pid that started after the record's driver is another process:\n${lines.join('\n')}`);
    } finally {
      t.done();
    }
  });

  it('settles each step once by its seq: with lanes a later step can finish first, so an earlier unfinished one below `steps` is still counted, and a run that died draining is halted', { timeout: 60_000 }, async () => {
    const t = await setup();
    try {
      // Lane A's step 2 never finished; lane B's step 3 finished and was
      // counted (run.json: two steps taken, accounted 1 and 3, $3 + $5).
      const lanes = 'autopilot-20261009T010000Z-1a7e5a';
      const dir = await t.deadRun(lanes, { steps: [{ seq: 2, subtask_id: 'A', step_budget_usd: 25 }, { seq: 3, subtask_id: 'B', step_budget_usd: 25, finished: { cost_usd: 5, cost_charged_usd: 5 } }] });
      L.writeRun(dir, { ...L.readRun(t.work, lanes).run, status: 'draining', steps: 2, cost_usd: 8, accounted_seqs: [1, 3] });
      const { lines, of } = await t.cleanup();
      strictEqual(of(lanes).outcome, 'cleaned', lines.join('\n'));
      deepStrictEqual(of(lanes).settled.map((s) => [s.seq, s.charged_usd, s.finished]), [[2, 25, false]]);
      const r = L.readRun(t.work, lanes).run;
      // Three steps taken: counted by seq, not up to the highest seq it settled.
      deepStrictEqual([r.cost_usd, r.accounted_seqs, r.steps, r.cost_complete, r.status], [33, [1, 2, 3], 3, false, 'halted']);
      // Idempotent: a second cleanup meets no record and counts nothing twice.
      await t.cleanup();
      strictEqual(L.readRun(t.work, lanes).run.cost_usd, 33);
    } finally {
      t.done();
    }
  });

  it('keeps the record when a peer-run home cannot be resolved for any reason but its absence', { timeout: 60_000 }, async (tt) => {
    if (process.getuid?.() === 0) { tt.skip('root reads through a mode-000 directory'); return; }
    const t = await setup();
    const shut = join(t.work, '.claude/agentic-engineer');
    try {
      await t.deadRun();
      mkdirSync(join(shut, 'peer-runs'), { recursive: true });
      chmodSync(shut, 0o000);
      const { lines, of } = await t.cleanup();
      strictEqual(of(DEAD).outcome, 'kept', lines.join('\n'));
      ok(lines.some((l) => /✗ .*agentic-engineer\/peer-runs does not resolve \(EACCES\): its peers cannot be told/.test(l)), lines.join('\n'));
      ok(L.readOpenRun(t.mainRoot, DEAD), 'its record is kept');
      strictEqual(L.readRun(t.work, DEAD).run.status, 'running', 'and its halt waits');
      chmodSync(shut, 0o755);
      strictEqual((await t.cleanup()).of(DEAD).outcome, 'cleaned', 'once the home resolves, the cleanup finishes');
    } finally {
      try { chmodSync(shut, 0o755); } catch { /* gone */ }
      t.done();
    }
  });
});

describe('stop reports a run stopped only once nothing of it runs', () => {
  it('exits 1 when the run it stops still runs: a live driver it cannot prove is not taken for a dead one', { timeout: 60_000 }, async () => {
    const t = await setup();
    try {
      const runId = 'autopilot-20261009T010000Z-11ae02';
      const runDir = await t.deadRun(runId, { record: false });
      const driver = sleeper();
      const worker = sleeper();
      t.pids.push(driver, worker);
      await new Promise((r) => { setTimeout(r, 150); });
      // A driver whose fingerprint does not read: alive to the lock and to the
      // cleanup, never provable to a signal. Each stop below empties one group.
      const lock = L.macroLockPath(t.mainRoot, t.fx.macroId);
      mkdirSync(lock, { recursive: true });
      const group = async (w, n) => writeFileSync(join(lock, `h-${driver}-0a0b0c0d0e0${n}.json`), JSON.stringify({ run_id: runId, macro_id: t.fx.macroId, pid: driver, fingerprint: { kind: 'none' }, worker: { pid: w, pgid: w, fingerprint: await L.processFingerprint(w) } }));
      await group(worker, 1);
      const lines = [];
      const say = (s) => lines.push(s);
      // No open-run record (a driver from before them): nothing says the run
      // is live but its entries, read again once its group is empty.
      strictEqual(await C.main(['stop', '--repo', t.work, '--macro', t.fx.macroId], { env: t.fx.env, out: say, err: say }), 1, lines.join('\n'));
      ok(lines.some((l) => new RegExp(`✗ run ${runId} is not stopped: an entry of it still lives`).test(l)), lines.join('\n'));
      ok(await until(() => !alive(worker)), 'its provable group was emptied');
      // With its record: the cleanup says the run is live. The emptied group's
      // entry goes (a live driver's entries outlive their groups).
      rmSync(join(lock, `h-${driver}-0a0b0c0d0e01.json`));
      const second = sleeper();
      t.pids.push(second);
      await new Promise((r) => { setTimeout(r, 150); });
      await group(second, 2);
      L.writeOpenRun(t.mainRoot, { runId, macroId: t.fx.macroId, checkout: t.work, runDir, pid: driver, fingerprint: { kind: 'none' }, startedAt: t.t0 });
      lines.length = 0;
      strictEqual(await C.main(['stop', '--repo', t.work, '--macro', t.fx.macroId], { env: t.fx.env, out: say, err: say }), 1, lines.join('\n'));
      ok(lines.some((l) => new RegExp(`✗ run ${runId} is not stopped: its driver \\(pid ${driver}\\) is running`).test(l)), lines.join('\n'));
      ok(alive(driver), 'the driver it could not prove was not signalled');
      ok(L.readOpenRun(t.mainRoot, runId), 'its record is kept');
      strictEqual(L.readRun(t.work, runId).run.status, 'running');
    } finally {
      t.done();
    }
  });

  it('exits 1 when it finds no run in the locks but the record of a live one', { timeout: 60_000 }, async () => {
    const t = await setup();
    try {
      // A lock it could not read hides the run from the listing: here, no lock at all.
      const runId = 'autopilot-20261009T010000Z-11ae03';
      const runDir = await t.deadRun(runId, { record: false });
      const driver = sleeper();
      t.pids.push(driver);
      await new Promise((r) => { setTimeout(r, 150); });
      L.writeOpenRun(t.mainRoot, { runId, macroId: t.fx.macroId, checkout: t.work, runDir, pid: driver, fingerprint: await L.processFingerprint(driver), startedAt: t.t0 });
      const lines = [];
      const say = (s) => lines.push(s);
      strictEqual(await C.main(['stop', '--repo', t.work], { env: t.fx.env, out: say, err: say }), 1, lines.join('\n'));
      ok(lines.includes('no autopilot run is active'), lines.join('\n'));
      ok(lines.some((l) => new RegExp(`✗ run ${runId} is not stopped: its driver \\(pid ${driver}\\) is running`).test(l)), lines.join('\n'));
      ok(L.readOpenRun(t.mainRoot, runId), 'its record is kept');
    } finally {
      t.done();
    }
  });

  it('reads the run\'s entries again while it waits: a group the driver started as it died is emptied, then the run is cleaned up after', { timeout: 60_000 }, async () => {
    const t = await setup();
    let driver = null;
    try {
      const runDir = L.createRunDir(t.work, DEAD);
      L.writeRun(runDir, { run_id: DEAD, repo: t.work, macro_id: t.fx.macroId, status: 'running', steps: 0, cost_usd: 0, roots: { engineer: ENG } });
      const ready = join(t.fx.dir, 'driver-ready.json');
      const lock = L.macroLockPath(t.mainRoot, t.fx.macroId);
      driver = spawn(process.execPath, [resolve(REPO_ROOT, 'tests/orchestrator/fixtures/autopilot-lane-driver.mjs'), lock, ready, DEAD, t.fx.macroId, t.work, t.work, '--group-on-term'], { stdio: 'ignore', env: t.fx.env });
      ok(await until(() => existsSync(ready)), 'the driver took its lock and put its record down');
      const lines = [];
      const say = (s) => lines.push(s);
      const code = await C.main(['stop', '--repo', t.work], { env: t.fx.env, out: say, err: say });
      ok(existsSync(`${ready}.term`), `the driver started a group as it died:\n${lines.join('\n')}`);
      const { group } = JSON.parse(readFileSync(`${ready}.term`, 'utf8'));
      t.pids.push(-group);
      strictEqual(code, 0, lines.join('\n'));
      ok(lines.some((l) => /its driver exited, but a worker group of it still runs/.test(l)), lines.join('\n'));
      let left = true;
      try { process.kill(-group, 0); } catch { left = false; }
      ok(!left, `the group it left is empty:\n${lines.join('\n')}`);
      const run = L.readRun(t.work, DEAD).run;
      deepStrictEqual([run.status, run.halt?.reason, run.dead_run_cleanup?.by], ['halted', 'interrupted', 'stop']);
      strictEqual(L.readOpenRun(t.mainRoot, DEAD), null);
    } finally {
      driver?.kill('SIGKILL');
      t.done();
    }
  });
});

describe('a driver that dies on the SIGTERM stop sent it', () => {
  it('stop sees its record left behind, and cleans up after it before it reports', { timeout: 60_000 }, async () => {
    const t = await setup();
    let driver = null;
    try {
      const runDir = L.createRunDir(t.work, DEAD);
      L.writeRun(runDir, { run_id: DEAD, repo: t.work, macro_id: t.fx.macroId, status: 'running', steps: 0, cost_usd: 0, roots: { engineer: ENG } });
      const ready = join(t.fx.dir, 'driver-ready.json');
      const lock = L.macroLockPath(t.mainRoot, t.fx.macroId);
      driver = spawn(process.execPath, [resolve(REPO_ROOT, 'tests/orchestrator/fixtures/autopilot-lane-driver.mjs'), lock, ready, DEAD, t.fx.macroId, t.work, t.work, '--no-groups'], { stdio: 'ignore', env: t.fx.env });
      ok(await until(() => existsSync(ready)), 'the driver took its lock and put its record down');
      const lines = [];
      const say = (s) => lines.push(s);
      strictEqual(await C.main(['stop', '--repo', t.work], { env: t.fx.env, out: say, err: say }), 0, lines.join('\n'));
      ok(lines.some((l) => /sent SIGTERM/.test(l)) && lines.some((l) => /exited without recording its end; cleaning up after it/.test(l)), lines.join('\n'));
      const run = L.readRun(t.work, DEAD).run;
      deepStrictEqual([run.status, run.halt?.reason, run.dead_run_cleanup?.by], ['halted', 'interrupted', 'stop']);
      strictEqual(L.readOpenRun(t.mainRoot, DEAD), null);
    } finally {
      driver?.kill('SIGKILL');
      t.done();
    }
  });
});

// The driver end to end: a real CLI driver, the fake `claude`, the scripted
// worker, whose verb starts a peer process under a handle naming the run.
async function driverSetup() {
  const fx = await makeRepo();
  const work = realpathSync(fx.work);
  fx.env.HOME = join(fx.dir, 'home');
  mkdirSync(fx.env.HOME);
  const scen = join(fx.dir, 'scenario.json');
  writeFileSync(scen, JSON.stringify({ A: { next: [{ kind: 'commit', verb: null, confidence: 'HIGH' }] }, B: { next: [{ kind: 'done', verb: null, confidence: 'HIGH' }] }, actions: { 1: 'peer-sleep' } }));
  const roots = { orchestrator: ORCH, engineer: ENG, runtime: RUNTIME };
  const version = (root) => JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  const env = {
    ...fx.env,
    AUTOPILOT_CLAUDE_BIN: FAKE, FAKE_CLAUDE_MODE: 'script', FAKE_WORKER_SCRIPT: SCRIPTED, FAKE_SCENARIO: scen,
    FAKE_CLAUDE_LOG: join(fx.dir, 'claude.log'),
    AGENTIC_ORCHESTRATOR_ROOT: ORCH, AGENTIC_ENGINEER_ROOT: ENG, AGENTIC_RUNTIME_ROOT: RUNTIME,
    FAKE_PLUGINS: JSON.stringify(Object.entries(roots).map(([name, root]) => ({ name, path: root, source: `${name}@agentic-plugins`, version: version(root) }))),
  };
  const ready = join(fx.dir, 'peer-ready');
  const kills = [];
  // Start the driver, wait until its verb started the peer, and kill it.
  const killDriverMidStep = async () => {
    const driver = spawn(process.execPath, [join(AP, 'cli.mjs'), 'start', '--execute', '--repo', work, '--models', 'owner-default'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    driver.stdout.on('data', (d) => { output += d; });
    driver.stderr.on('data', (d) => { output += d; });
    const exited = new Promise((r) => driver.on('exit', r));
    ok(await until(() => existsSync(ready), 30_000), `the step's verb started its peer: ${output}`);
    const peer = JSON.parse(readFileSync(ready, 'utf8'));
    kills.push(peer.peer, -peer.worker);
    const runId = L.listRuns(work).at(-1);
    ok(L.readOpenRun(L.mainWorktreeRoot(work), runId), 'the run put its open-run record down before its first spawn');
    driver.kill('SIGKILL');
    await exited;
    return { peer, runId, output: () => output };
  };
  return {
    fx, work, env, killDriverMidStep,
    done() {
      for (const k of kills) { try { process.kill(k, 'SIGKILL'); } catch { /* gone */ } }
      fx.cleanup();
    },
  };
}

describe('a driver killed in the middle of a step whose verb started a peer', () => {
  // A worker whose driver died exits once its stdin closes; a worker group
  // that outlives its driver is stop's to empty first (the worker-group test in
  // test-autopilot-lanes.mjs).
  it('stop cancels the peer, counts the step, records the halt and removes the record, once nothing of the run is left running', { timeout: 90_000 }, async () => {
    const d = await driverSetup();
    try {
      const { peer, runId } = await d.killDriverMidStep();
      ok(await until(() => !alive(peer.worker)), 'the worker exits with its stdin closed');
      ok(alive(peer.peer), 'the peer runs on, detached from it');
      const stop = spawnSync(process.execPath, [join(AP, 'cli.mjs'), 'stop', '--repo', d.work], { env: d.env, encoding: 'utf8' });
      strictEqual(stop.status, 0, stop.stderr + stop.stdout);
      match(stop.stdout, /no autopilot run is active/);
      match(stop.stdout, new RegExp(`dead run ${runId}: cleaned up after its dead driver: cancelled its peer run\\(s\\) ${peer.peer_run_id}`));
      ok(await until(() => !alive(peer.peer)), 'the peer is gone');
      strictEqual(JSON.parse(readFileSync(peer.handle, 'utf8')).status, 'cancelled');
      const r = L.readRun(d.work, runId);
      deepStrictEqual([r.run.status, r.run.halt.reason, r.run.steps, r.run.cost_complete], ['halted', 'interrupted', 1, false]);
      strictEqual(r.run.cost_usd, DEFAULTS.stepBudgetUsd, 'the killed step counts its whole budget');
      strictEqual(L.readOpenRun(L.mainWorktreeRoot(d.work), runId), null);
      const status = spawnSync(process.execPath, [join(AP, 'cli.mjs'), 'status', '--repo', d.work], { env: d.env, encoding: 'utf8' });
      match(status.stdout, new RegExp(`${runId} · halted`));
      match(status.stdout, new RegExp(`cleaned up after its dead driver by stop at .*: cancelled ${peer.peer_run_id}`));
    } finally {
      d.done();
    }
  });

  it('with no stop, the next run of the macro cleans up after it before its first step', { timeout: 90_000 }, async () => {
    const d = await driverSetup();
    try {
      const { peer, runId } = await d.killDriverMidStep();
      // Nothing holds the lock once the worker is gone too.
      ok(await until(() => !alive(peer.worker)), 'the worker exits with its stdin closed');
      ok(alive(peer.peer), 'the peer runs on, detached from it');
      const lines = [];
      const code = await startRun({
        repoRoot: d.work,
        options: { ...DEFAULTS, models: 'owner-default', model: null, effort: null, macro: null, forced: null, forcedText: null, notifyLocal: false },
        env: d.env, out: (s) => lines.push(s), err: (s) => lines.push(`ERR ${s}`), deps: { signals: new EventEmitter() },
      });
      ok(await until(() => !alive(peer.peer)), `the next run cancelled the dead run's peer:\n${lines.join('\n')}`);
      strictEqual(JSON.parse(readFileSync(peer.handle, 'utf8')).status, 'cancelled');
      const dead = L.readRun(d.work, runId).run;
      deepStrictEqual([dead.status, dead.halt.reason, dead.dead_run_cleanup.by], ['halted', 'interrupted', `run ${L.listRuns(d.work).at(-1)}`]);
      strictEqual(L.readOpenRun(L.mainWorktreeRoot(d.work), runId), null);
      const next = L.readRun(d.work, L.listRuns(d.work).at(-1));
      deepStrictEqual(next.run.dead_runs.map((x) => [x.run_id, x.outcome, x.cancelled]), [[runId, 'cleaned', [peer.peer_run_id]]]);
      const at = lines.findIndex((l) => l.includes(`dead run ${runId}: cleaned up`));
      ok(at >= 0 && !lines.slice(0, at).some((l) => /^\[\d+\] /.test(l)), `the cleanup comes before the run's first step:\n${lines.join('\n')}`);
      ok([0, 2].includes(code), lines.join('\n'));
      strictEqual(L.readOpenRun(L.mainWorktreeRoot(d.work), next.run.run_id), null, 'the next run removed its own record when it ended');
    } finally {
      d.done();
    }
  });
});
