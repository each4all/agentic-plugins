// tests/orchestrator/test-autopilot-step-evidence-runs.mjs
//
// C163 (ADR-0063, implementation note of 2026-11-04) — the serial driver and
// the scheduler end to end, with the scripted worker
// (fixtures/autopilot-scripted-worker.mjs): a verb that did its work passes;
// one that only rewrote the next step halts, at the dispatch and later; a
// recorded no-change outcome passes; an owner-forced step whose only change
// is an edit of an already-modified file is progress. The rule on its own:
// test-autopilot-step-evidence.mjs.

import { describe, it } from 'node:test';
import { deepStrictEqual, match, strictEqual } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeRepo, ORCH, ENG, RUNTIME } from './fixtures/autopilot-repo.mjs';
import * as lanesRun from './fixtures/autopilot-lanes-run.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const AP = resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot');
const { parseForcedStep } = await import(resolve(AP, 'policy.mjs'));
const D = await import(resolve(AP, 'driver.mjs'));
const L = await import(resolve(AP, 'ledger.mjs'));

const COMMIT = { kind: 'commit', verb: null, confidence: 'HIGH' };
const DONE = { kind: 'done', verb: null, confidence: 'HIGH' };
const CRITIQUE = { kind: 'verb', verb: 'critique', confidence: 'HIGH' };
const REFINE = { kind: 'verb', verb: 'refine', confidence: 'HIGH' };
const LOW = { kind: 'verb', verb: 'critique', confidence: 'LOW' };

// ---------------------------------------------------------------------------
// End to end: the serial driver.

async function serial(scenario) {
  const fx = await makeRepo();
  const work = realpathSync(fx.work);
  fx.env.HOME = join(fx.dir, 'home');
  mkdirSync(fx.env.HOME);
  const scen = join(fx.dir, 'scenario.json');
  writeFileSync(scen, JSON.stringify(scenario));
  const version = (root) => JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version;
  const roots = { orchestrator: ORCH, engineer: ENG, runtime: RUNTIME };
  const env = {
    ...fx.env,
    AUTOPILOT_CLAUDE_BIN: resolve(REPO_ROOT, 'tests/orchestrator/fixtures/autopilot-fake-claude.mjs'), FAKE_CLAUDE_MODE: 'script',
    FAKE_WORKER_SCRIPT: resolve(REPO_ROOT, 'tests/orchestrator/fixtures/autopilot-scripted-worker.mjs'), FAKE_SCENARIO: scen,
    FAKE_CLAUDE_LOG: join(fx.dir, 'claude.log'),
    AGENTIC_ORCHESTRATOR_ROOT: ORCH, AGENTIC_ENGINEER_ROOT: ENG, AGENTIC_RUNTIME_ROOT: RUNTIME,
    FAKE_PLUGINS: JSON.stringify(Object.entries(roots).map(([name, root]) => ({ name, path: root, source: `${name}@agentic-plugins`, version: version(root) }))),
  };
  const lines = [];
  const run = (opts = {}) => D.startRun({
    repoRoot: work,
    options: { ...D.DEFAULTS, models: 'owner-default', model: null, effort: null, macro: null, forced: null, forcedText: null, notifyLocal: false, ...opts },
    env, out: (s) => lines.push(s), err: (s) => lines.push(`ERR ${s}`), deps: { signals: new EventEmitter() },
  });
  return { fx, work, run, lines, latest: () => L.readRun(work, L.listRuns(work).at(-1)) };
}

const RE_DISPATCH = /the dispatch of subtask A left no new "### Phase 1: Compose \(synthesized\)" section with its synthesis or artifact/;
const RE_LATER = /the \/engineer:critique step left no new "### Phase 1: Critique \(synthesized\)" section with its synthesis or artifact/;

describe('the serial driver', () => {
  it('a dispatch whose first verb only recorded its next step halts owner-choice at the dispatch, though it wrote a file', async () => {
    const t = await serial({ A: { next: [COMMIT], file: true }, B: { next: [DONE] }, actions: { 'dispatch:A': 'handoff-only' } });
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(r.steps.map((s) => [s.kind, s.outcome]), [['dispatch', 'owner-choice']]);
      deepStrictEqual([r.halt.reason, r.halt.subtask_id, r.halt.pointer ?? null], ['owner-choice', 'A', null]);
      match(r.halt.detail, RE_DISPATCH);
    } finally {
      t.fx.cleanup();
    }
  });

  it('a later verb that only rewrote its next step halts owner-choice; one that did its work passes', async () => {
    const t = await serial({ A: { next: [CRITIQUE, COMMIT], file: true }, B: { next: [DONE] }, actions: { 'verb:A': 'handoff-only' } });
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(r.steps.map((s) => [s.kind, s.outcome]), [['dispatch', 'ok'], ['verb', 'owner-choice']]);
      deepStrictEqual([r.halt.reason, r.halt.subtask_id], ['owner-choice', 'A']);
      match(r.halt.detail, RE_LATER);
    } finally {
      t.fx.cleanup();
    }
    const u = await serial({ A: { next: [CRITIQUE, COMMIT], file: true }, B: { next: [DONE] } });
    try {
      strictEqual(await u.run(), 2, u.lines.join('\n'));
      const r = u.latest();
      deepStrictEqual(r.steps.map((s) => [s.kind, s.outcome]), [['dispatch', 'ok'], ['verb', 'ok'], ['commit', 'ok']]);
      strictEqual(r.halt.reason, 'awaiting-landing');
    } finally {
      u.fx.cleanup();
    }
  });

  it('a later verb that records it changes nothing, and changes no file, passes', async () => {
    const t = await serial({ A: { next: [REFINE, COMMIT], file: true }, B: { next: [DONE] }, actions: { 'verb:A': 'no-change' } });
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(r.steps.map((s) => [s.kind, s.outcome]), [['dispatch', 'ok'], ['verb', 'ok'], ['commit', 'ok']]);
      strictEqual(r.halt.reason, 'awaiting-landing');
    } finally {
      t.fx.cleanup();
    }
  });

  it('an owner-forced verb whose only change is an edit of an already-modified file is progress, not no-progress', async () => {
    const t = await serial({ A: { next: [LOW], file: true }, B: { next: [DONE] }, actions: { 'verb:A': 'edit-only' } });
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      strictEqual(t.latest().halt.reason, 'low-confidence');
      const porcelain = execFileSync('git', ['-C', t.work, 'status', '--porcelain'], { encoding: 'utf8' });
      strictEqual(await t.run({ forced: parseForcedStep('/engineer:critique'), forcedText: '/engineer:critique' }), 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(r.steps.map((s) => [s.kind, s.forced, s.outcome]), [['verb', true, 'ok']], r.halt.detail);
      strictEqual(r.halt.reason, 'low-confidence', 'the next decision reads the same LOW next step');
      strictEqual(execFileSync('git', ['-C', t.work, 'status', '--porcelain'], { encoding: 'utf8' }), porcelain, 'the porcelain status did not move');
      match(readFileSync(join(t.work, 'a.txt'), 'utf8'), /edited at step/);
    } finally {
      t.fx.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// End to end: the scheduler (lanes).

describe('the scheduler', () => {
  it('a lane\'s dispatch whose first verb only recorded its next step halts the lane owner-choice', async () => {
    const t = await lanesRun.setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [COMMIT], file: true }, actions: { 'dispatch:A': 'handoff-only' } } });
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(lanesRun.laneSteps(r), { A: ['dispatch owner-choice'] });
      deepStrictEqual([r.halt.reason, r.halt.subtask_id], ['owner-choice', 'A']);
      match(r.halt.detail, RE_DISPATCH);
    } finally {
      t.fx.cleanup();
    }
  });

  it('the halt parks its own lane only: the other lane goes on to its commit', async () => {
    const t = await lanesRun.setup({ scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT], file: 'b.txt' }, actions: { 'dispatch:A': 'handoff-only' } } });
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(lanesRun.laneSteps(r), { A: ['dispatch owner-choice'], B: ['dispatch ok', 'commit ok'] });
      deepStrictEqual([r.halt.reason, r.halt.subtask_id], ['owner-choice', 'A']);
      match(r.halt.detail, RE_DISPATCH);
      strictEqual(lanesRun.bySubtask(r).B.state, 'waiting-to-land');
    } finally {
      t.fx.cleanup();
    }
  });

  it('a lane\'s later verb that only rewrote its next step halts the lane; a recorded no-change outcome passes', async () => {
    const t = await lanesRun.setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [CRITIQUE, COMMIT], file: true }, actions: { 'verb:A': 'handoff-only' } } });
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(lanesRun.laneSteps(r), { A: ['dispatch ok', 'verb owner-choice'] });
      match(r.halt.detail, RE_LATER);
    } finally {
      t.fx.cleanup();
    }
    const u = await lanesRun.setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [REFINE, COMMIT], file: true }, actions: { 'verb:A': 'no-change' } } });
    try {
      strictEqual(await u.run(), 2, u.lines.join('\n'));
      const r = u.latest();
      deepStrictEqual(lanesRun.laneSteps(r), { A: ['dispatch ok', 'verb ok', 'commit ok'] });
      strictEqual(r.halt.reason, 'awaiting-landing');
    } finally {
      u.fx.cleanup();
    }
  });

  it('an owner-forced verb in a lane whose only change is an edit of an already-modified file is progress', async () => {
    const t = await lanesRun.setup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [LOW], file: true }, actions: { 'verb:A': 'edit-only' } } });
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      strictEqual(t.latest().halt.reason, 'low-confidence');
      strictEqual(await t.run({ forcedPairs: [{ lane: 'A', step: parseForcedStep('/engineer:critique') }] }), 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(r.steps.map((s) => [s.lane, s.kind, s.forced, s.outcome]), [['A', 'verb', true, 'ok']], r.halt.detail);
      strictEqual(r.halt.reason, 'low-confidence');
      match(readFileSync(join(t.lane('A'), 'a.txt'), 'utf8'), /edited at step/);
    } finally {
      t.fx.cleanup();
    }
  });
});
