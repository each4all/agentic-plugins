// tests/orchestrator/test-autopilot-driver.mjs
//
// ADR-0063 D1/D3/D3a/D4/D8 — the autopilot driver end to end, with no model:
// the fake `claude` hands each step to a scripted worker
// (fixtures/autopilot-scripted-worker.mjs) that does what the runbook would
// through this checkout's real state APIs and CLIs — `phase7-commit.mjs
// --mode autopilot` included — and runs the real engineer and orchestrator
// Stop hooks at its turn end. The repository has a bare origin and a fake
// `gh`, so the landing round trip of D23 = (A) runs as the owner would do it:
// the run halts awaiting-landing, the owner squash-merges, the relaunch
// records the landing and finishes the macro, judged from the archived macro.

import { describe, it } from 'node:test';
import assert, { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeRepo, ORCH, ENG, RUNTIME } from './fixtures/autopilot-repo.mjs';
import { installLikeRelease } from './fixtures/install-cache.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const AP = resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot');
const { startRun, DEFAULTS, effectiveStateRoot, newPendingRuns } = await import(resolve(AP, 'driver.mjs'));
const L = await import(resolve(AP, 'ledger.mjs'));
const fingerprintForPid = L.processFingerprint;
const FAKE = resolve(REPO_ROOT, 'tests/orchestrator/fixtures/autopilot-fake-claude.mjs');
const SCRIPTED = resolve(REPO_ROOT, 'tests/orchestrator/fixtures/autopilot-scripted-worker.mjs');

const version = (root) => JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const pluginsFor = (roots) => Object.entries(roots).map(([name, root]) => ({ name, path: root, source: `${name}@agentic-plugins`, version: version(root) }));
const COMMIT = { kind: 'commit', verb: null, confidence: 'HIGH' };
const DONE = { kind: 'done', verb: null, confidence: 'HIGH' };

async function setup({ scenario, subtasks, roots = { orchestrator: ORCH, engineer: ENG, runtime: RUNTIME }, plugins } = {}) {
  const fx = await makeRepo(subtasks ? { subtasks } : undefined);
  const work = realpathSync(fx.work);
  fx.env.HOME = join(fx.dir, 'home');
  mkdirSync(fx.env.HOME);
  const scen = join(fx.dir, 'scenario.json');
  writeFileSync(scen, JSON.stringify(scenario));
  const env = {
    ...fx.env,
    AUTOPILOT_CLAUDE_BIN: FAKE, FAKE_CLAUDE_MODE: 'script', FAKE_WORKER_SCRIPT: SCRIPTED, FAKE_SCENARIO: scen,
    FAKE_CLAUDE_LOG: join(fx.dir, 'claude.log'),
    AGENTIC_ORCHESTRATOR_ROOT: roots.orchestrator, AGENTIC_ENGINEER_ROOT: roots.engineer, AGENTIC_RUNTIME_ROOT: roots.runtime,
    FAKE_PLUGINS: JSON.stringify(plugins ?? pluginsFor(roots)),
  };
  const lines = [];
  const run = (opts = {}, deps = {}) => startRun({
    repoRoot: work,
    options: { ...DEFAULTS, models: 'owner-default', model: null, effort: null, macro: null, forced: null, forcedText: null, notifyLocal: false, ...opts },
    env, out: (s) => lines.push(s), err: (s) => lines.push(`ERR ${s}`), deps: { signals: new EventEmitter(), ...deps },
  });
  const latest = () => {
    const runs = L.listRuns(work);
    return L.readRun(work, runs.at(-1));
  };
  return { fx, work, env, run, lines, latest, scen };
}

describe('the landing round trip (D23 = A)', () => {
  it('dispatch → commit → awaiting-landing; the owner merges; done → dispatch → close → done --no-commit → completed', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [DONE], file: false } } });
    try {
      // Run 1: up to the first landing.
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      let r = t.latest();
      deepStrictEqual(r.steps.map((s) => [s.kind, s.outcome]), [['dispatch', 'ok'], ['commit', 'ok']]);
      strictEqual(r.halt.reason, 'awaiting-landing');
      deepStrictEqual(r.halt.waiting.map((w) => [w.subtaskId, w.branch, w.reason]), [['A', 'feat/a', 'no_pr']]);
      deepStrictEqual(r.halt.waiting[0].commands, ['git push -u origin feat/a', 'gh pr create --base main --head feat/a --fill']);
      strictEqual(r.run.status, 'halted');
      const subject = t.fx.git('log', '-1', '--format=%s', 'feat/a');
      ok(/^(feat|fix|docs|chore|refactor|test)(\(.+\))?: /.test(subject), `a conventional subject from /engineer:commit: ${subject}`);
      strictEqual((await t.fx.subtask('A')).status, 'in_progress', 'a commit does not complete a subtask (ADR-0062)');
      for (const seq of [1, 2]) {
        deepStrictEqual(JSON.parse(readFileSync(join(t.fx.dir, `ledger-${seq}.json`), 'utf8')), { recorded: true, registered: true },
          `step ${seq} was on record, and its worker on the lock, before it got its prompt`);
      }
      deepStrictEqual(L.readLockEntries(L.macroLockPath(t.work, t.fx.macroId)), [], 'the macro lock is released');
      deepStrictEqual(L.readLockEntries(L.worktreeLockPath(t.work)), [], 'the worktree lock is released');
      deepStrictEqual(L.listOpenRuns(t.work), [], 'a halted run removes its open-run record');

      // The owner pushes, reviews and squash-merges A.
      t.fx.setPrs([t.fx.land('A', 'feat/a')]);

      // Run 2: records the landing and finishes the macro — in exactly the
      // four steps its cap allows (completion on the last allowed step is
      // completion, not a budget halt).
      strictEqual(await t.run({ maxSteps: 4 }), 0, t.lines.join('\n'));
      r = t.latest();
      deepStrictEqual(r.steps.map((s) => [s.kind, s.subtask_id, s.outcome]), [
        ['done', 'A', 'ok'], ['dispatch', 'B', 'ok'], ['commit', 'B', 'ok'], ['done-no-commit', 'B', 'ok'],
      ]);
      strictEqual(r.run.status, 'completed');
      strictEqual(r.halt, null);
      deepStrictEqual(L.listOpenRuns(t.work), [], 'a completed run removes its open-run record');
      ok(!existsSync(t.fx.macroPath), 'the macro is archived');
      const archived = readdirSync(join(t.work, '.agentic-plugins/state/orchestrator/archive')).filter((n) => n.startsWith(t.fx.macroId));
      strictEqual(archived.length, 1);
      const steps = readFileSync(join(r.dir, 'steps.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      deepStrictEqual(steps.map((s) => s.event), ['started', 'finished', 'started', 'finished', 'started', 'finished', 'started', 'finished']);
      ok(r.steps.every((s) => typeof s.session_id === 'string' && typeof s.fingerprint_before === 'string' && typeof s.fingerprint_after === 'string'));
      ok(r.run.loaded_plugins.engineer, 'the run records which plugin code its workers loaded');
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('halts', () => {
  it('a plan edited while a step runs halts plan-unapproved before the next step', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [DONE] }, actions: { 1: 'edit-plan' } } });
    try {
      strictEqual(await t.run(), 2);
      const r = t.latest();
      deepStrictEqual(r.steps.map((s) => s.kind), ['dispatch']);
      strictEqual(r.halt.reason, 'plan-unapproved');
    } finally {
      t.fx.cleanup();
    }
  });

  it('the first step is decided from the state under the locks, not from the look before them (round 6)', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT] }, B: { next: [DONE] } } });
    const { observe } = await import(resolve(AP, 'observe.mjs'));
    try {
      let looks = 0;
      let lockedAtSecondLook = null;
      // Another run changes the state — here, the plan, which then needs the
      // owner's approval again — after this run's first look and before it
      // holds the locks.
      const editPlan = `
        const orch = await import(${JSON.stringify(resolve(ORCH, 'scripts/state.mjs'))});
        const p = ${JSON.stringify(t.fx.macroPath)};
        const fm = (await orch.readWorkflow(p)).frontmatter;
        await orch.setPlan({ workflowPath: p, host: 'claude', subtasks: fm.plan.subtasks.map((s) => (s.id === 'B' ? { ...s, topic: s.topic + ' (edited)' } : s)) });`;
      const code = await t.run({}, {
        observe: (args) => {
          // The look the first step is decided from is taken under both locks.
          if (looks === 1) {
            lockedAtSecondLook = L.readLockEntries(L.worktreeLockPath(t.work)).length === 1
              && L.readLockEntries(L.macroLockPath(t.work, t.fx.macroId)).length === 1;
          }
          const view = observe(args);
          looks += 1;
          if (looks === 1) execFileSync(process.execPath, ['--input-type=module', '-e', editPlan], { env: { ...process.env, ...t.fx.env } });
          return view;
        },
      });
      strictEqual(code, 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual([r.steps.length, r.halt.reason], [0, 'plan-unapproved']);
      ok(!existsSync(join(t.fx.dir, 'claude.log')), 'no worker was started');
      strictEqual(lockedAtSecondLook, true, 'the second look was taken while the run held both locks');
    } finally {
      t.fx.cleanup();
    }
  });

  it('a step that changes nothing halts no-progress', async () => {
    const t = await setup({ scenario: { A: { next: [{ kind: 'verb', verb: 'critique', confidence: 'HIGH' }], file: true }, B: { next: [DONE] }, actions: { 2: 'noop' } } });
    try {
      strictEqual(await t.run(), 2);
      const r = t.latest();
      deepStrictEqual(r.steps.map((s) => [s.kind, s.outcome]), [['dispatch', 'ok'], ['verb', 'no-progress']]);
      strictEqual(r.halt.reason, 'no-progress');
      ok(r.halt.resume[0].startsWith('claude --resume '), 'the halt names the session to inspect');
    } finally {
      t.fx.cleanup();
    }
  });

  it('a dirty tree halts before a dispatch, and no worker is spawned', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT] }, B: { next: [DONE] } } });
    try {
      writeFileSync(join(t.work, 'stray.txt'), 'x');
      strictEqual(await t.run(), 2);
      strictEqual(t.latest().halt.reason, 'dirty-tree');
      ok(!existsSync(join(t.fx.dir, 'claude.log')), 'no worker started');
    } finally {
      t.fx.cleanup();
    }
  });

  it('a live run holding the macro halts the second run, which spawns nothing', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT] }, B: { next: [DONE] } } });
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      const lock = L.macroLockPath(t.work, t.fx.macroId);
      mkdirSync(lock, { recursive: true });
      const other = join(lock, `h-${sleeper.pid}-aaaa.json`);
      writeFileSync(other, JSON.stringify({ run_id: 'autopilot-20261001T000000Z-aaaaaa', macro_id: t.fx.macroId, pid: sleeper.pid, fingerprint: await fingerprintForPid(sleeper.pid) }));
      strictEqual(await t.run(), 2);
      const r = t.latest();
      strictEqual(r.halt.reason, 'owner-choice');
      ok(/another autopilot run holds/.test(r.halt.detail), r.halt.detail);
      ok(!existsSync(join(t.fx.dir, 'claude.log')));
      deepStrictEqual(L.readLockEntries(lock).map((e) => e.file), [other], 'the other run\'s entry is left alone, and the halted run left none');
      deepStrictEqual(L.readLockEntries(L.worktreeLockPath(t.work)), [], 'the worktree lock it took first is released');
    } finally {
      sleeper.kill('SIGKILL');
      t.fx.cleanup();
    }
  });

  it('a live run of another macro in this worktree halts the run (one checkout, one run)', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT] }, B: { next: [DONE] } } });
    const sleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    try {
      const lock = L.worktreeLockPath(t.work);
      mkdirSync(lock, { recursive: true });
      writeFileSync(join(lock, `h-${sleeper.pid}-bbbb.json`), JSON.stringify({ run_id: 'autopilot-20261001T000000Z-bbbbbb', macro_id: 'macro-plan-20261001T000000Z-other0', pid: sleeper.pid, fingerprint: await fingerprintForPid(sleeper.pid) }));
      strictEqual(await t.run(), 2);
      const r = t.latest();
      strictEqual(r.halt.reason, 'owner-choice');
      ok(/another autopilot run holds .*worktree\.lock/.test(r.halt.detail), r.halt.detail);
      ok(!existsSync(join(t.fx.dir, 'claude.log')));
      deepStrictEqual(L.readLockEntries(L.macroLockPath(t.work, t.fx.macroId)), [], 'the macro lock was not left behind');
    } finally {
      sleeper.kill('SIGKILL');
      t.fx.cleanup();
    }
  });

  it('a remote whose explicit pushurl is its fetch URL is refused before anything runs', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT] }, B: { next: [DONE] } } });
    try {
      t.fx.git('config', 'remote.origin.pushurl', t.fx.git('config', 'remote.origin.url'));
      strictEqual(await t.run(), 1);
      ok(t.lines.some((l) => /explicit pushurl equals a fetch URL/.test(l)), t.lines.join('\n'));
      ok(!existsSync(join(t.fx.dir, 'claude.log')));
    } finally {
      t.fx.cleanup();
    }
  });

  it('the step cap halts budget', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [DONE] } } });
    try {
      strictEqual(await t.run({ maxSteps: 1 }), 2);
      const r = t.latest();
      strictEqual(r.steps.length, 1);
      deepStrictEqual([r.halt.reason, /step cap \(1\)/.test(r.halt.detail)], ['budget', true]);
    } finally {
      t.fx.cleanup();
    }
  });

  it('plugins loaded from inside the driven repository abort the first step at init', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT] }, B: { next: [DONE] } } });
    try {
      const plugins = pluginsFor({ orchestrator: ORCH, engineer: ENG, runtime: RUNTIME });
      plugins[1] = { ...plugins[1], path: join(t.work, 'plugins', 'engineer') };
      t.env.FAKE_PLUGINS = JSON.stringify(plugins);
      t.env.FAKE_CLAUDE_MODE = 'precompact'; // never reaches a result on its own
      strictEqual(await t.run(), 2);
      const r = t.latest();
      strictEqual(r.halt.reason, 'owner-choice');
      ok(/inside the repository this run drives \(a directory marketplace\)/.test(r.halt.detail), r.halt.detail);
      strictEqual(r.steps[0].aborted, 'provenance');
    } finally {
      t.fx.cleanup();
    }
  });

  it('a worker that loaded another plugin version halts version-drift', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT] }, B: { next: [DONE] } } });
    try {
      const plugins = pluginsFor({ orchestrator: ORCH, engineer: ENG, runtime: RUNTIME }).map((p) => (p.name === 'engineer' ? { ...p, version: '0.0.1' } : p));
      t.env.FAKE_PLUGINS = JSON.stringify(plugins);
      t.env.FAKE_CLAUDE_MODE = 'precompact';
      strictEqual(await t.run(), 2);
      const r = t.latest();
      strictEqual(r.halt.reason, 'version-drift');
      ok(/loads engineer 0\.0\.1/.test(r.halt.detail), r.halt.detail);
      strictEqual(r.run.cost_complete, false, 'a killed step reported no cost, so its budget was charged');
      strictEqual(r.steps[0].cost_charged_usd, DEFAULTS.stepBudgetUsd);
      strictEqual(r.run.cost_usd, DEFAULTS.stepBudgetUsd);
    } finally {
      t.fx.cleanup();
    }
  });

  it('an installed version that changes between steps halts version-drift', async () => {
    const copy = mkdtempSync(join(tmpdir(), 'autopilot-engineer-copy-'));
    const engCopy = join(copy, 'engineer');
    cpSync(ENG, engCopy, { recursive: true });
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [DONE] }, actions: { 1: 'bump-engineer' } }, roots: { orchestrator: ORCH, engineer: engCopy, runtime: RUNTIME } });
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      const r = t.latest();
      strictEqual(r.steps.length, 1);
      strictEqual(r.halt.reason, 'version-drift');
      ok(/engineer .* -> 99\.0\.0/.test(r.halt.detail), r.halt.detail);
    } finally {
      t.fx.cleanup();
      rmSync(copy, { recursive: true, force: true });
    }
  });
});

describe('a killed step', () => {
  it('cancels the peer runs it left pending — before its dispatch recorded the subtask — and halts interrupted', async () => {
    const copy = mkdtempSync(join(tmpdir(), 'autopilot-engineer-stub-'));
    const engCopy = join(copy, 'engineer');
    cpSync(ENG, engCopy, { recursive: true });
    const log = join(copy, 'peer-runner.log');
    // A stand-in for engineer's peer-runner: records the cancel it is asked for.
    writeFileSync(join(engCopy, 'scripts', 'peer-runner.mjs'), `#!/usr/bin/env node
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write(JSON.stringify({ ok: true, run_id: process.argv[4], status: 'cancelled' }) + '\\n');
`);
    const t = await setup({ scenario: { A: { next: [COMMIT] }, B: { next: [DONE] }, actions: { 1: 'pending-sleep' } }, roots: { orchestrator: ORCH, engineer: engCopy, runtime: RUNTIME } });
    const signals = new EventEmitter();
    try {
      const running = startRun({
        repoRoot: t.work,
        options: { ...DEFAULTS, models: 'owner-default', model: null, effort: null, macro: null, forced: null, forcedText: null, notifyLocal: false },
        env: t.env, out: (s) => t.lines.push(s), err: (s) => t.lines.push(`ERR ${s}`), deps: { signals },
      });
      const ready = join(t.fx.dir, 'pending-ready');
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && !existsSync(ready)) await new Promise((r) => { setTimeout(r, 100); });
      ok(existsSync(ready), t.lines.join('\n'));
      signals.emit('SIGTERM');
      strictEqual(await running, 2);
      const r = t.latest();
      strictEqual(r.halt.reason, 'interrupted');
      ok(/cancelled the step's pending peer run\(s\) plan-verify-20261001T000000Z-feed01/.test(r.halt.detail), r.halt.detail);
      deepStrictEqual(r.steps[0].peer_cancellations.map((c) => [c.run_id, c.exit]), [['plan-verify-20261001T000000Z-feed01', 0]]);
      const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      deepStrictEqual(calls, [['cancel', '--run-id', 'plan-verify-20261001T000000Z-feed01', '--repo-root', t.work]]);
    } finally {
      t.fx.cleanup();
      rmSync(copy, { recursive: true, force: true });
    }
  });
});

describe('peer cancellation is the step\'s own (ADR-0067 Decision 6)', () => {
  it('cancels the peer run of the killed step\'s subtask, and leaves another lane\'s pending run alone', async () => {
    const copy = mkdtempSync(join(tmpdir(), 'autopilot-engineer-stub-'));
    const engCopy = join(copy, 'engineer');
    cpSync(ENG, engCopy, { recursive: true });
    const log = join(copy, 'peer-runner.log');
    writeFileSync(join(engCopy, 'scripts', 'peer-runner.mjs'), `#!/usr/bin/env node
import fs from 'node:fs';
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
process.stdout.write(JSON.stringify({ ok: true, run_id: process.argv[4], status: 'cancelled' }) + '\\n');
`);
    const t = await setup({
      scenario: { A: { next: [COMMIT] }, B: { next: [DONE] }, actions: { 1: 'pending-sleep' }, otherLane: { id: 'B', branch: 'feat/b' } },
      roots: { orchestrator: ORCH, engineer: engCopy, runtime: RUNTIME },
    });
    const signals = new EventEmitter();
    try {
      const running = startRun({
        repoRoot: t.work,
        options: { ...DEFAULTS, models: 'owner-default', model: null, effort: null, macro: null, forced: null, forcedText: null, notifyLocal: false },
        env: t.env, out: (s) => t.lines.push(s), err: (s) => t.lines.push(`ERR ${s}`), deps: { signals },
      });
      const ready = join(t.fx.dir, 'pending-ready');
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && !existsSync(ready)) await new Promise((r) => { setTimeout(r, 100); });
      ok(existsSync(ready), t.lines.join('\n'));
      signals.emit('SIGTERM');
      strictEqual(await running, 2);
      const r = t.latest();
      strictEqual(r.halt.reason, 'interrupted');
      deepStrictEqual(r.steps[0].peer_cancellations.map((c) => c.run_id), ['plan-verify-20261001T000000Z-feed01']);
      const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      deepStrictEqual(calls, [['cancel', '--run-id', 'plan-verify-20261001T000000Z-feed01', '--repo-root', t.work]],
        'B\'s pending run became pending during the step too, but it is another lane\'s');
    } finally {
      t.fx.cleanup();
      rmSync(copy, { recursive: true, force: true });
    }
  });

  it('takes a step\'s new pending runs from its own subtask\'s in-progress child and claims, never another subtask\'s child', () => {
    // Both subtasks in progress, each child with a peer started during the
    // step: the case the scripted test above, whose subtasks are pending, does
    // not reach.
    const before = { children: { A: { pending_runs: ['a0'] }, B: { pending_runs: ['b0'] } }, claims: [] };
    const after = {
      children: { A: { pending_runs: ['a0', 'a1'] }, B: { pending_runs: ['b0', 'b1'] } },
      claims: [{ originating_subtask: 'A', pending_runs: ['a2'] }, { originating_subtask: 'B', pending_runs: ['b2'] }],
    };
    deepStrictEqual(newPendingRuns(before, after, 'A').sort(), ['a1', 'a2']);
    deepStrictEqual(newPendingRuns(before, after, 'B').sort(), ['b1', 'b2']);
    deepStrictEqual(newPendingRuns(before, after, null), [], 'a step with no subtask has none');
  });
});

describe('a process group that outlives SIGKILL (round 4)', () => {
  it('halts the run, which keeps its lock entries until the group is empty', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT] }, B: { next: [DONE] } } });
    const pidfile = join(t.fx.dir, 'grandchild.pid');
    let member = null;
    try {
      // The worker leaves a member in its group. The kernel's part is
      // simulated: the teardown reports a member it could not kill, and kills
      // nothing, so the member is really there.
      t.env.FAKE_CLAUDE_MODE = 'leaves-child';
      t.env.FAKE_CLAUDE_PIDFILE = pidfile;
      strictEqual(await t.run({}, { terminateGroup: async () => 'lingering' }), 2, t.lines.join('\n'));
      member = Number(readFileSync(pidfile, 'utf8'));
      const r = t.latest();
      deepStrictEqual([r.steps.length, r.steps[0].group_teardown, r.halt.reason], [1, 'lingering', 'worker-failed']);
      ok(/still there after SIGKILL/.test(r.halt.detail), r.halt.detail);
      // Its open-run record stays with the entries (ADR-0067 Decision 6, Locks).
      ok(L.readOpenRun(t.work, r.run.run_id), 'a run whose group lingers keeps its open-run record');
      const locks = [L.worktreeLockPath(t.work), L.macroLockPath(t.work, t.fx.macroId)];
      for (const lock of locks) {
        const entries = L.readLockEntries(lock);
        strictEqual(entries.length, 1, `${lock} keeps the run's entry`);
        const { worker } = entries[0].holder;
        ok(Number.isInteger(worker?.pgid) && worker.pgid === worker.pid, 'the entry names the worker\'s group');
        // As after the driver exits: only the group keeps the entry live.
        writeFileSync(entries[0].file, JSON.stringify({ ...entries[0].holder, pid: (await new Promise((res) => { const c = spawn(process.execPath, ['-e', '0']); c.on('exit', () => res(c.pid)); })) }));
      }
      for (const lock of locks) {
        await assert.rejects(L.acquireLock(lock, { record: { run_id: 'autopilot-20261001T000000Z-eeeeee' } }), L.LockHeldError);
      }
      process.kill(member, 'SIGKILL');
      for (let i = 0; i < 50 && (() => { try { process.kill(member, 0); return true; } catch { return false; } })(); i += 1) await new Promise((res) => { setTimeout(res, 100); });
      for (const lock of locks) {
        const next = await L.acquireLock(lock, { record: { run_id: 'autopilot-20261001T000000Z-eeeeee' } });
        deepStrictEqual(L.readLockEntries(lock).map((e) => e.holder.run_id), ['autopilot-20261001T000000Z-eeeeee'], 'the emptied group\'s entry is cleared');
        next.release();
      }
    } finally {
      if (member) { try { process.kill(member, 'SIGKILL'); } catch { /* gone */ } }
      t.fx.cleanup();
    }
  });
});

describe('an error in the middle of a step (ADR-0067 Decision 6, Locks)', () => {
  it('tears the step down before it releases anything, and a group that outlived SIGKILL keeps the entries and the open-run record', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT] }, B: { next: [DONE] } } });
    try {
      let aborted = null;
      // A worker whose start fails once it is on the locks, and whose group
      // outlives the teardown.
      const startWorker = () => ({
        sessionId: 's-err', pid: process.pid,
        begin: () => { throw new Error('the step could not begin'); },
        abort: (reason) => { aborted = reason; },
        done: new Promise((r) => { setTimeout(() => r({ groupTeardown: 'lingering' }), 50); }),
      });
      await assert.rejects(t.run({}, { startWorker }), /the step could not begin/);
      strictEqual(aborted, 'interrupted');
      const r = t.latest();
      strictEqual(r.run.status, 'error');
      strictEqual(L.readLockEntries(L.worktreeLockPath(t.work)).length, 1, 'the entry naming the group stays');
      ok(L.readOpenRun(t.work, r.run.run_id), 'so does the open-run record');
    } finally {
      t.fx.cleanup();
    }
  });
});

describe('stop', () => {
  it('a stopped driver exits only once its worker\'s process group is empty, a member that ignores SIGTERM included (round 3)', { timeout: 60_000 }, async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT] }, B: { next: [DONE] } } });
    const cli = join(AP, 'cli.mjs');
    const pidfile = join(t.fx.dir, 'grandchild.pid');
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    let grandchild = null;
    try {
      t.env.FAKE_CLAUDE_MODE = 'stubborn';
      t.env.FAKE_CLAUDE_PIDFILE = pidfile;
      const driver = spawn(process.execPath, [cli, 'start', '--execute', '--repo', t.work, '--models', 'owner-default'], { env: t.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      driver.stdout.on('data', (d) => { output += d; });
      driver.stderr.on('data', (d) => { output += d; });
      const exited = new Promise((r) => { driver.on('exit', (code) => r(code)); });
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && !existsSync(pidfile)) await new Promise((r) => { setTimeout(r, 100); });
      ok(existsSync(pidfile), `the worker started its grandchild: ${output}`);
      grandchild = Number(readFileSync(pidfile, 'utf8'));
      const stop = spawnSync(process.execPath, [cli, 'stop', '--repo', t.work], { env: t.env, encoding: 'utf8' });
      strictEqual(stop.status, 0, stop.stderr + stop.stdout);
      strictEqual(await exited, 2, output);
      // Checked at once: the escalation must not depend on the driver living on.
      ok(!alive(grandchild), `grandchild ${grandchild}, which ignores SIGTERM, outlived the driver`);
      const r = t.latest();
      deepStrictEqual([r.halt.reason, r.steps[0].group_teardown], ['interrupted', 'killed']);
      deepStrictEqual(L.readLockEntries(L.worktreeLockPath(t.work)), [], 'the locks are released');
    } finally {
      if (grandchild) { try { process.kill(grandchild, 'SIGKILL'); } catch { /* gone */ } }
      t.fx.cleanup();
    }
  });

  it('stop signals the driver, which kills its worker and records an interrupted halt', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT] }, B: { next: [DONE] }, actions: { 1: 'sleep' } } });
    const cli = join(AP, 'cli.mjs');
    try {
      const driver = spawn(process.execPath, [cli, 'start', '--execute', '--repo', t.work, '--models', 'owner-default'], { env: t.env, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      driver.stdout.on('data', (d) => { output += d; });
      driver.stderr.on('data', (d) => { output += d; });
      const exited = new Promise((r) => { driver.on('exit', (code) => r(code)); });
      // Wait for the step to be on record, then for the worker to be running.
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline && !existsSync(join(t.fx.dir, 'ledger-1.json'))) await new Promise((r) => { setTimeout(r, 100); });
      ok(existsSync(join(t.fx.dir, 'ledger-1.json')), `the step started: ${output}`);
      const [{ holder: lock }] = L.readLockEntries(L.worktreeLockPath(t.work));
      ok(Number.isInteger(lock.worker?.pid), 'the lock records the running worker');
      const stop = spawnSync(process.execPath, [cli, 'stop', '--repo', t.work], { env: t.env, encoding: 'utf8' });
      strictEqual(stop.status, 0, stop.stderr + stop.stdout);
      ok(/sent SIGTERM/.test(stop.stdout));
      strictEqual(await exited, 2, output);
      const r = t.latest();
      strictEqual(r.halt.reason, 'interrupted');
      strictEqual(r.steps[0].aborted, 'interrupted');
      let workerAlive = true;
      try { process.kill(lock.worker.pid, 0); } catch { workerAlive = false; }
      ok(!workerAlive, 'the worker was killed');
      deepStrictEqual(L.readLockEntries(L.worktreeLockPath(t.work)), [], 'the locks are released');
    } finally {
      t.fx.cleanup();
    }
  });
});

// ADR-0067 Decision 8, item 4 — launched on the main checkout, start prints
// the home-worktree setup, pinned to the installed releases, and goes on.
describe('the launch proposal at start', () => {
  it('on the main checkout, start proposes the home worktree pinned to the installed cache, then runs', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [DONE], file: false } } });
    try {
      // Releases laid out as this repository's plugins are (runtime has no state.mjs).
      const pins = Object.fromEntries(['orchestrator', 'engineer', 'runtime'].map((p) => [p, installLikeRelease(t.env.HOME, p, '1.0.0')]));
      strictEqual(await t.run({ maxSteps: 1 }), 2, t.lines.join('\n'));
      const at = t.lines.findIndex((l) => l.startsWith('→ Proposed (main-checkout): this is the main checkout, whose branch a serial run switches at each dispatch'));
      ok(at >= 0, t.lines.join('\n'));
      const command = t.lines[at + 1];
      ok(command.startsWith(`    git -C ${t.work} worktree add -b autopilot/home `), command);
      ok(command.includes(`AGENTIC_ORCHESTRATOR_ROOT=${pins.orchestrator} AGENTIC_ENGINEER_ROOT=${pins.engineer} AGENTIC_RUNTIME_ROOT=${pins.runtime} node `), command);
      strictEqual(t.latest().steps.length, 1, 'the run went on after the proposal');
    } finally {
      t.fx.cleanup();
    }
  });
});

describe("the run's state root (ADR-0067 Decision 2)", () => {
  // No log file: no worker (and no fake claude at all) started.
  const workerStarts = (t) => (existsSync(join(t.fx.dir, 'claude.log'))
    ? readFileSync(join(t.fx.dir, 'claude.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      .filter((e) => typeof e.env.AGENTIC_AUTOPILOT === 'string')
    : []);

  it('is resolved once at start, recorded in run.json and exported to every worker', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [DONE], file: false } } });
    try {
      strictEqual(await t.run({ maxSteps: 1 }), 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(r.run.state_root, { root: t.work, source: 'checkout', shared_creation: 'off', default_state_root: t.work });
      const starts = workerStarts(t);
      ok(starts.length >= 1, 'a worker started');
      for (const s of starts) strictEqual(s.env.AGENTIC_STATE_BASE, t.work);
    } finally {
      t.fx.cleanup();
    }
  });

  it("an operator's value binds when the driven checkout's scripts accept it, and refuses the start otherwise", async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [DONE], file: false } } });
    try {
      t.env.AGENTIC_STATE_BASE = join(t.fx.dir, 'elsewhere');
      strictEqual(await t.run({ maxSteps: 1 }), 1);
      ok(t.lines.some((l) => /the run's state root: AGENTIC_STATE_BASE=.* names neither this checkout/.test(l)), t.lines.join('\n'));
      strictEqual(workerStarts(t).length, 0, 'no worker started');
      t.env.AGENTIC_STATE_BASE = t.work;
      strictEqual(await t.run({ maxSteps: 1 }), 2, t.lines.join('\n'));
      deepStrictEqual(t.latest().run.state_root.source, 'operator');
      for (const s of workerStarts(t)) strictEqual(s.env.AGENTIC_STATE_BASE, t.work);
    } finally {
      t.fx.cleanup();
    }
  });

  it("draws a secret its workers carry, and writes only the secret's digest, in its lock entry (ADR-0067 Decision 4, item 5)", async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [DONE], file: false } } });
    try {
      strictEqual(await t.run({ maxSteps: 1 }), 2, t.lines.join('\n'));
      const starts = workerStarts(t);
      ok(starts.length >= 1, 'a worker started');
      const sha = (s) => createHash('sha256').update(s).digest('hex');
      for (const s of starts) {
        const token = s.env.AGENTIC_AUTOPILOT_TOKEN;
        match(token ?? '', /^[0-9a-f]{32}$/, 'a 128-bit secret');
        const own = s.locks.filter((e) => e.run_id === s.env.AGENTIC_AUTOPILOT);
        strictEqual(own.length, 1, JSON.stringify(s.locks));
        strictEqual(own[0].token_digest, sha(token), "the run's lock entry holds the secret's digest");
        ok(!JSON.stringify(s.locks).includes(token), 'never the secret itself');
      }
      const runDir = t.latest().dir;
      for (const name of readdirSync(runDir)) {
        ok(!readFileSync(join(runDir, name), 'utf8').includes(starts[0].env.AGENTIC_AUTOPILOT_TOKEN), `not in the ledger's ${name}`);
      }
    } finally {
      t.fx.cleanup();
    }
  });

  it('a driven checkout that is a lane refuses the start: records created there would go with it', async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [DONE], file: false } } });
    try {
      const lane = join(`${t.work}-lanes`, 'macro', 'T');
      mkdirSync(dirname(lane), { recursive: true });
      t.fx.git('worktree', 'add', '-q', '-b', 'feat/lane-t', lane);
      const refused = effectiveStateRoot(realpathSync(lane), {});
      strictEqual(refused.stateRoot, null);
      ok(/names a lane/.test(refused.problem), refused.problem);
      strictEqual(effectiveStateRoot(t.work, {}).problem, null, 'control: the main checkout');
    } finally {
      rmSync(`${t.work}-lanes`, { recursive: true, force: true });
      t.fx.cleanup();
    }
  });
});
