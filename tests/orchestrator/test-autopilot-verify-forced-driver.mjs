// tests/orchestrator/test-autopilot-verify-forced-driver.mjs
//
// C168 (ADR-0068 implementation note 2026-11-03) — the owner's forced
// verification step on a request below HIGH, end to end through the serial
// driver (driver.mjs) and the scheduler (a run with lanes, scheduler.mjs): the
// fake Claude and the scripted worker record each verb's next step through
// the real persona CLI, and the driver runs the requested checks itself.
//
// Covers:
//   - serial: a MEDIUM request halts low-confidence and runs nothing; the
//     owner's `--next verify` runs it, and when its batch fails the requesting
//     verb resumes with no second forced step, the run going on to the commit;
//     a batch that ends with no evidence resumes the verb as well; a batch
//     that passes dispatches a HIGH on_pass and halts low-confidence on a
//     MEDIUM one;
//   - lanes: the same, with `--lane A --next verify`.
// The journal, the policy and the step's recoveries (a dead driver, a batch
// cut short, a crash before the answer, a record set aside) are
// test-autopilot-verify-forced.mjs's.

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeRepo, ORCH, ENG, RUNTIME } from './fixtures/autopilot-repo.mjs';
import { setup as lanesSetup } from './fixtures/autopilot-lanes-run.mjs';
import { CHECK_SCRIPT, DECLARATION } from './_verify-fixtures.mjs';
import { BOUNDS, commitChecks } from './_verify-lanes-helpers.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const AP = resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot');
const { startRun, DEFAULTS } = await import(resolve(AP, 'driver.mjs'));
const { parseForcedStep } = await import(resolve(AP, 'policy.mjs'));
const L = await import(resolve(AP, 'ledger.mjs'));
const PK = await import(resolve(AP, 'parks.mjs'));
const FAKE = resolve(REPO_ROOT, 'tests/orchestrator/fixtures/autopilot-fake-claude.mjs');
const SCRIPTED = resolve(REPO_ROOT, 'tests/orchestrator/fixtures/autopilot-scripted-worker.mjs');
const BOUNDED = { timeout: 240_000 };

const version = (root) => JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const plugins = Object.entries({ orchestrator: ORCH, engineer: ENG, runtime: RUNTIME }).map(([name, root]) => ({ name, path: root, source: `${name}@agentic-plugins`, version: version(root) }));
const COMMIT = { kind: 'commit', verb: null, confidence: 'HIGH' };
const verify = (checks, { on_pass = { kind: 'commit', confidence: 'HIGH' }, confidence = 'MEDIUM' } = {}) => ({ kind: 'verify', verb: null, confidence, checks, on_pass });
const FORCED = { forced: parseForcedStep('verify'), forcedText: 'verify' };

async function serial(scenario) {
  const fx = await makeRepo({ subtasks: [{ id: 'A' }] });
  const work = realpathSync(fx.work);
  fx.env.HOME = join(fx.dir, 'home');
  mkdirSync(fx.env.HOME);
  mkdirSync(join(work, 'scripts'), { recursive: true });
  writeFileSync(join(work, 'scripts/check.mjs'), CHECK_SCRIPT);
  mkdirSync(join(work, '.agentic-plugins'), { recursive: true });
  writeFileSync(join(work, '.agentic-plugins/verify-checks.json'), DECLARATION);
  fx.git('add', '-A');
  fx.git('commit', '-q', '-m', 'chore: checks');
  fx.git('push', '-q', 'origin', 'HEAD:main');
  const logs = mkdtempSync(join(tmpdir(), 'verify-forced-log-'));
  const scen = join(fx.dir, 'scenario.json');
  writeFileSync(scen, JSON.stringify(scenario));
  const env = {
    ...fx.env,
    AUTOPILOT_CLAUDE_BIN: FAKE, FAKE_CLAUDE_MODE: 'script', FAKE_WORKER_SCRIPT: SCRIPTED, FAKE_SCENARIO: scen,
    FAKE_CLAUDE_LOG: join(fx.dir, 'claude.log'),
    AGENTIC_ORCHESTRATOR_ROOT: ORCH, AGENTIC_ENGINEER_ROOT: ENG, AGENTIC_RUNTIME_ROOT: RUNTIME,
    FAKE_PLUGINS: JSON.stringify(plugins), VERIFY_FIXTURE_LOG: join(logs, 'order.log'),
  };
  const lines = [];
  const run = (opts = {}) => startRun({
    repoRoot: work,
    options: { ...DEFAULTS, models: 'owner-default', model: null, effort: null, macro: null, forced: null, forcedText: null, notifyLocal: false, ...opts },
    env, out: (s) => lines.push(s), err: (s) => lines.push(`ERR ${s}`),
    deps: { signals: new EventEmitter(), verifyBounds: { secondMs: 100, killGraceMs: 300, lingerMs: 500, pollMs: 25 } },
  });
  const latest = () => L.readRun(work, L.listRuns(work).at(-1));
  const ran = () => { try { return readFileSync(join(logs, 'order.log'), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  return { run, lines, latest, ran, cleanup: () => { fx.cleanup(); rmSync(logs, { recursive: true, force: true }); } };
}

// The first run: the dispatch records the MEDIUM request, which halts
// low-confidence with nothing run.
async function haltedOnMedium(t) {
  strictEqual(await t.run(), 2, t.lines.join('\n'));
  const r = t.latest();
  deepStrictEqual(r.steps.map((s) => s.kind), ['dispatch']);
  strictEqual(r.halt.reason, 'low-confidence');
  match(r.halt.detail, /verify @ MEDIUM: the requested checks are not run below HIGH/);
  deepStrictEqual(t.ran(), []);
}
const shape = (r) => r.steps.map((s) => [s.kind, s.outcome]);

describe('verify-forced-driver: a serial run', () => {
  it('the owner\'s --next verify on a MEDIUM request whose batch fails resumes the requesting verb, with no second forced step, and goes on to the commit', BOUNDED, async () => {
    const t = await serial({ A: { next: [verify([{ kind: 'pass' }, { kind: 'fail' }]), verify([{ kind: 'pass' }], { confidence: 'HIGH' }), COMMIT], file: true } });
    try {
      await haltedOnMedium(t);
      strictEqual(await t.run(FORCED), 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(shape(r), [['verify', 'ok'], ['verb', 'ok'], ['verify', 'ok'], ['commit', 'ok']], t.lines.join('\n'));
      strictEqual(r.steps[0].forced, true);
      strictEqual(r.steps[0].verify.batch.end, 'failed');
      strictEqual(r.steps[1].command, '/engineer:compose');
      strictEqual(r.halt.reason, 'awaiting-landing');
    } finally {
      t.cleanup();
    }
  });

  it('a forced MEDIUM batch that ends with no evidence resumes the requesting verb too', BOUNDED, async () => {
    const t = await serial({ A: { next: [verify([{ kind: 'hang' }]), COMMIT], file: true } });
    try {
      await haltedOnMedium(t);
      strictEqual(await t.run(FORCED), 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(shape(r), [['verify', 'ok'], ['verb', 'ok'], ['commit', 'ok']], t.lines.join('\n'));
      strictEqual(r.steps[0].verify.batch.end, 'no-evidence');
    } finally {
      t.cleanup();
    }
  });

  it('a forced MEDIUM batch that passes dispatches its HIGH on_pass, and halts low-confidence on a MEDIUM one', BOUNDED, async () => {
    const high = await serial({ A: { next: [verify([{ kind: 'pass' }])], file: true } });
    try {
      await haltedOnMedium(high);
      strictEqual(await high.run(FORCED), 2, high.lines.join('\n'));
      const r = high.latest();
      deepStrictEqual(shape(r), [['verify', 'ok'], ['commit', 'ok']], high.lines.join('\n'));
      strictEqual(r.steps[0].verify.batch.end, 'passed');
    } finally {
      high.cleanup();
    }
    const medium = await serial({ A: { next: [verify([{ kind: 'pass' }], { on_pass: { kind: 'verb', verb: 'critique', confidence: 'MEDIUM' } })], file: true } });
    try {
      await haltedOnMedium(medium);
      strictEqual(await medium.run(FORCED), 2, medium.lines.join('\n'));
      const r = medium.latest();
      deepStrictEqual(shape(r), [['verify', 'ok']], medium.lines.join('\n'));
      strictEqual(r.halt.reason, 'low-confidence');
      match(r.halt.detail, /verb:critique @ MEDIUM/);
    } finally {
      medium.cleanup();
    }
  });
});

describe('verify-forced-driver: a run with lanes', () => {
  it('`--lane A --next verify` on a MEDIUM request whose batch fails resumes the requesting verb in the lane, which goes on to the commit', { timeout: 300_000 }, async () => {
    const t = await lanesSetup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [verify([{ kind: 'pass' }, { kind: 'fail' }]), verify([{ kind: 'pass' }], { confidence: 'HIGH' }), COMMIT], file: true } } });
    const logs = mkdtempSync(join(tmpdir(), 'verify-forced-lanes-'));
    try {
      commitChecks(t);
      const log = join(logs, 'order.log');
      Object.assign(t.env, { VERIFY_FIXTURE_LOG: log });
      const ran = () => readFileSync(log, { encoding: 'utf8', flag: 'a+' }).split('\n').filter(Boolean);
      strictEqual(await t.run({}, { verifyBounds: BOUNDS }), 2, t.lines.join('\n'));
      const r1 = t.latest();
      deepStrictEqual(shape(r1), [['dispatch', 'ok']], t.lines.join('\n'));
      strictEqual(PK.readPark(t.work, t.fx.macroId, 'A').record?.reason, 'low-confidence');
      deepStrictEqual(ran(), [], 'below HIGH nothing ran');
      const forcedPairs = [{ lane: 'A', step: parseForcedStep('verify') }];
      strictEqual(await t.run({ forcedPairs, forcedText: '--lane A --next verify' }, { verifyBounds: BOUNDS }), 2, t.lines.join('\n'));
      const r2 = t.latest();
      deepStrictEqual(shape(r2), [['verify', 'ok'], ['verb', 'ok'], ['verify', 'ok'], ['commit', 'ok']], t.lines.join('\n'));
      deepStrictEqual([r2.steps[0].forced, r2.steps[0].verify?.batch?.end], [true, 'failed']);
      ok(ran().slice(0, 2).join() === 'pass,fail', ran().join());
    } finally {
      t.fx.cleanup();
      rmSync(logs, { recursive: true, force: true });
    }
  });

  it('`--lane A --next verify` on a MEDIUM request whose batch passes halts the lane low-confidence on a MEDIUM on_pass', { timeout: 300_000 }, async () => {
    const t = await lanesSetup({ subtasks: [{ id: 'A' }], scenario: { A: { next: [verify([{ kind: 'pass' }], { on_pass: { kind: 'verb', verb: 'critique', confidence: 'MEDIUM' } })], file: true } } });
    const logs = mkdtempSync(join(tmpdir(), 'verify-forced-lanes-'));
    try {
      commitChecks(t);
      Object.assign(t.env, { VERIFY_FIXTURE_LOG: join(logs, 'order.log') });
      strictEqual(await t.run({}, { verifyBounds: BOUNDS }), 2, t.lines.join('\n'));
      strictEqual(PK.readPark(t.work, t.fx.macroId, 'A').record?.reason, 'low-confidence');
      strictEqual(await t.run({ forcedPairs: [{ lane: 'A', step: parseForcedStep('verify') }], forcedText: '--lane A --next verify' }, { verifyBounds: BOUNDS }), 2, t.lines.join('\n'));
      const r2 = t.latest();
      deepStrictEqual(shape(r2), [['verify', 'ok']], t.lines.join('\n'));
      strictEqual(r2.steps[0].verify?.batch?.end, 'passed');
      const park = PK.readPark(t.work, t.fx.macroId, 'A').record;
      strictEqual(park?.reason, 'low-confidence', JSON.stringify(park));
      match(park?.detail ?? '', /verb:critique @ MEDIUM/);
    } finally {
      t.fx.cleanup();
      rmSync(logs, { recursive: true, force: true });
    }
  });
});
