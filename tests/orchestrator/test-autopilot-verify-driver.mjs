// tests/orchestrator/test-autopilot-verify-driver.mjs
//
// ADR-0068 Decision 5 (verify-exec) — the verification step in a serial run
// (driver.mjs), end to end: the fake Claude and the scripted worker
// (fixtures/autopilot-scripted-worker.mjs) record each verb's next step
// through the real persona CLI, a `verify` one with its request, and the
// driver runs the requested checks itself, with no worker.
//
// Covers:
//   - the offer: a repository with a declaration at the run's baseline and a
//     persona with the capability is offered verification (run.json, the
//     worker's environment); one without a declaration is not, and a verify
//     child halts the run owner-choice, run-wide; a relaunch that offers it
//     goes on with no release; a worker's edit of the declaration in its
//     step widens nothing;
//   - a failing check recorded and routed: the batch stops at it, the
//     requesting verb resumes, reads it, records a passing request, whose
//     on_pass (the commit) follows;
//   - budget accounting: a batch is a step of the ledger, of kind verify,
//     with no cost; it is no step of --max-steps, and run.steps counts the
//     worker steps only; the last permitted worker step recording verify
//     starts nothing more, and the request survives;
//   - a request below HIGH halts low-confidence and runs nothing;
//   - a batch start the persona refuses as a held lane's (a hold published as
//     the serial run started) halts the run owner-choice, with no loop;
//   - records: no failing test name reaches the main session or the event
//     file, and the batch adds no event kind.

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeRepo, ORCH, ENG, RUNTIME } from './fixtures/autopilot-repo.mjs';
import { CHECK_SCRIPT, DECLARATION } from './_verify-fixtures.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const AP = resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot');
const { startRun, DEFAULTS } = await import(resolve(AP, 'driver.mjs'));
const L = await import(resolve(AP, 'ledger.mjs'));
const FAKE = resolve(REPO_ROOT, 'tests/orchestrator/fixtures/autopilot-fake-claude.mjs');
const SCRIPTED = resolve(REPO_ROOT, 'tests/orchestrator/fixtures/autopilot-scripted-worker.mjs');
const BOUNDED = { timeout: 240_000 };

const version = (root) => JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).version;
const roots = { orchestrator: ORCH, engineer: ENG, runtime: RUNTIME };
const plugins = Object.entries(roots).map(([name, root]) => ({ name, path: root, source: `${name}@agentic-plugins`, version: version(root) }));
const COMMIT = { kind: 'commit', verb: null, confidence: 'HIGH' };
const verify = (checks, { on_pass = { kind: 'commit', confidence: 'HIGH' }, confidence = 'HIGH' } = {}) => ({ kind: 'verify', verb: null, confidence, checks, on_pass });


async function setup({ scenario, declare = true }) {
  const fx = await makeRepo({ subtasks: [{ id: 'A' }] });
  const work = realpathSync(fx.work);
  fx.env.HOME = join(fx.dir, 'home');
  mkdirSync(fx.env.HOME);
  mkdirSync(join(work, 'scripts'), { recursive: true });
  writeFileSync(join(work, 'scripts/check.mjs'), CHECK_SCRIPT);
  if (declare) {
    mkdirSync(join(work, '.agentic-plugins'), { recursive: true });
    writeFileSync(join(work, '.agentic-plugins/verify-checks.json'), DECLARATION);
  }
  fx.git('add', '-A');
  fx.git('commit', '-q', '-m', 'chore: checks');
  fx.git('push', '-q', 'origin', 'HEAD:main');
  const logs = mkdtempSync(join(tmpdir(), 'verify-driver-log-'));
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
  const run = (opts = {}, deps = {}) => startRun({
    repoRoot: work,
    options: { ...DEFAULTS, models: 'owner-default', model: null, effort: null, macro: null, forced: null, forcedText: null, notifyLocal: false, ...opts },
    env, out: (s) => lines.push(s), err: (s) => lines.push(`ERR ${s}`),
    deps: { signals: new EventEmitter(), verifyBounds: { secondMs: 100, killGraceMs: 300, lingerMs: 500, pollMs: 25 }, ...deps },
  });
  const latest = () => L.readRun(work, L.listRuns(work).at(-1));
  const workers = () => readFileSync(join(fx.dir, 'claude.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.argv.includes('-p'));
  const ran = () => { try { return readFileSync(join(logs, 'order.log'), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  return { fx, work, env, run, lines, latest, ran, scen, workers, cleanup: () => { fx.cleanup(); rmSync(logs, { recursive: true, force: true }); } };
}

describe('verify-driver: a failing check recorded and routed, in a serial run', () => {
  it('dispatch → verify (fails) → the verb resumes → verify (passes) → on_pass commit; batches cost nothing and are no worker step', BOUNDED, async () => {
    const t = await setup({ scenario: { A: { next: [verify([{ kind: 'pass' }, { kind: 'fail' }, { kind: 'pass2' }]), verify([{ kind: 'pass' }]), COMMIT], file: true } } });
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(r.steps.map((s) => [s.kind, s.outcome]), [['dispatch', 'ok'], ['verify', 'ok'], ['verb', 'ok'], ['verify', 'ok'], ['commit', 'ok']], t.lines.join('\n'));
      strictEqual(r.halt.reason, 'awaiting-landing');
      // The step's A.txt is read by no test, so the driver adds the whole
      // suite, after the worker's checks: the first batch stopped before it.
      deepStrictEqual(t.ran(), ['pass', 'fail', 'pass', 'suite'], 'the batch stopped at the failure; pass2 and the suite never ran');
      deepStrictEqual(r.steps[3].verify.batch.checks.map((c) => [c.kind, c.origin]), [['pass', 'worker'], ['test-suite', 'driver']]);
      // The resumed verb is the requesting one, and its step saw the results.
      strictEqual(r.steps[2].command, '/engineer:compose');
      strictEqual(r.steps[1].verify.batch.end, 'failed');
      strictEqual(r.steps[3].verify.batch.end, 'passed');
      // Budget accounting: the batches are seqs of the ledger with no cost,
      // and no worker steps.
      for (const s of [r.steps[1], r.steps[3]]) deepStrictEqual([s.cost_usd, s.cost_charged_usd, s.step_budget_usd], [0, 0, 0]);
      strictEqual(r.run.steps, 3, 'run.steps counts the three worker steps');
      deepStrictEqual(r.run.accounted_seqs, [1, 3, 5]);
      strictEqual(r.run.verify.offered, true);
      // No failing test name or log text reaches the main session or the event file.
      ok(!t.lines.join('\n').includes('it fails'), 'not in the session');
      const events = readFileSync(r.run.events.path, 'utf8');
      ok(!events.includes('it fails'));
      ok(!/"kind":"verify/.test(events), 'no event kind for a batch');
      // status: a batch's line has no cost and no session, and names no test.
      const C = await import(resolve(AP, 'cli.mjs'));
      const printed = [];
      const here = process.cwd();
      process.chdir(t.work);
      try {
        await C.main(['status'], { env: t.env, io: { stdin: { isTTY: false }, stderr: process.stderr }, out: (x) => printed.push(x), err: (x) => printed.push(x) });
      } finally {
        process.chdir(here);
      }
      const text = printed.join('\n');
      match(text, /\[2\] verify → ok · batch failed, 2 of 4 check\(s\) run · no cost/);
      match(text, /\[4\] verify → ok · batch passed, 2 of 2 check\(s\) run · no cost/);
      match(text, /verification offered \(declaration [0-9a-f]{12}\)/);
      ok(!text.includes('it fails') && !/\[2\] verify.*session/.test(text), text);
    } finally {
      t.cleanup();
    }
  });

  it('the last permitted worker step recording verify starts nothing more, and the request survives for the relaunch', BOUNDED, async () => {
    const t = await setup({ scenario: { A: { next: [verify([{ kind: 'pass' }]), COMMIT], file: true } } });
    try {
      strictEqual(await t.run({ maxSteps: 1 }), 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(r.steps.map((s) => s.kind), ['dispatch']);
      strictEqual(r.halt.reason, 'budget');
      deepStrictEqual(t.ran(), []);
      // The relaunch runs the request.
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      deepStrictEqual(t.latest().steps.map((s) => [s.kind, s.outcome]), [['verify', 'ok'], ['commit', 'ok']]);
      deepStrictEqual(t.ran(), ['pass', 'suite']);
    } finally {
      t.cleanup();
    }
  });

  it('a request below HIGH halts low-confidence and runs nothing', BOUNDED, async () => {
    const t = await setup({ scenario: { A: { next: [verify([{ kind: 'pass' }], { confidence: 'MEDIUM' })], file: true } } });
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      const r = t.latest();
      strictEqual(r.halt.reason, 'low-confidence');
      deepStrictEqual(r.steps.map((s) => s.kind), ['dispatch']);
      deepStrictEqual(t.ran(), []);
    } finally {
      t.cleanup();
    }
  });
});

describe('verify-driver: a start the persona refuses as a held lane\'s', () => {
  it('a serial run halts owner-choice on the batch that yielded, rather than decide it again without end', BOUNDED, async () => {
    const t = await setup({ scenario: { A: { next: [verify([{ kind: 'pass' }]), COMMIT], file: true } } });
    try {
      // A hold published as the serial run started, which could no longer be
      // withdrawn (holds-cli.mjs): set, with the hold protocol on, while the
      // batch is prepared. The persona refuses the batch's start; a serial run
      // reads no hold of its own, so only the refusal tells it.
      const VO = await import(resolve(AP, 'verify-ops.mjs'));
      const HO = await import(resolve(REPO_ROOT, 'plugins/orchestrator/scripts/lib/hold-ops.mjs'));
      const HR = await import(resolve(REPO_ROOT, 'plugins/orchestrator/scripts/lib/holds.mjs'));
      let hold = null;
      const verifyOps = {
        treeDigest: VO.DEFAULT_OPS.treeDigest,
        select: async (a) => {
          if (hold === null) {
            HR.writeProtocol(t.work, t.fx.macroId, { writtenBy: 'test' });
            hold = await HO.setHold({ mainRoot: t.work, macroId: t.fx.macroId, subtaskId: 'A', branch: t.fx.git('branch', '--show-current') });
          }
          return VO.DEFAULT_OPS.select(a);
        },
      };
      // A watchdog: a run that decides the free step again without end never
      // ends by itself; the owner's interrupt ends it, and the test fails.
      const signals = new EventEmitter();
      const watchdog = setTimeout(() => signals.emit('SIGINT'), 60_000);
      const code = await t.run({}, { signals, verifyOps }).finally(() => clearTimeout(watchdog));
      strictEqual(code, 2, t.lines.join('\n'));
      ok(hold, 'the hold was set while the batch was prepared');
      const r = t.latest();
      deepStrictEqual(r.steps.map((s) => [s.kind, s.outcome, s.verify?.outcome ?? null]), [['dispatch', 'ok', null], ['verify', 'owner-choice', 'stopped']], t.lines.join('\n'));
      strictEqual(r.halt.reason, 'owner-choice');
      match(r.halt.detail, /did not start: a hold came before the batch started; nothing ran\. A serial run does not honour holds/);
      deepStrictEqual(t.ran(), [], 'no check ran');
    } finally {
      t.cleanup();
    }
  });
});

describe('verify-driver: the owner\'s rerun', () => {
  it('a request recorded again on an unchanged tree halts no-progress; `--next verify` runs its checks once more, whole, and the run goes on', BOUNDED, async () => {
    // The dispatch writes A.txt; the resumed verb changes nothing and records
    // the same checks again, a pass before the failure: the repeat rule stops it.
    const t = await setup({ scenario: { A: { next: [verify([{ kind: 'pass' }, { kind: 'fail' }]), verify([{ kind: 'pass' }, { kind: 'fail' }]), verify([{ kind: 'pass' }]), COMMIT], file: true } } });
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      const r1 = t.latest();
      deepStrictEqual(r1.steps.map((s) => s.kind), ['dispatch', 'verify', 'verb', 'verify'], t.lines.join('\n'));
      strictEqual(r1.halt.reason, 'no-progress', JSON.stringify(r1.halt));
      match(r1.halt.detail, /rerun them once with --next verify/);
      deepStrictEqual(t.ran(), ['pass', 'fail'], 'the repeat ran nothing');
      // The owner's rerun, as the CLI parses it.
      const { parseForcedStep } = await import(resolve(AP, 'policy.mjs'));
      strictEqual(await t.run({ forced: parseForcedStep('verify'), forcedText: 'verify' }), 2, t.lines.join('\n'));
      const r2 = t.latest();
      deepStrictEqual(r2.steps.map((s) => [s.kind, s.outcome]), [['verify', 'ok'], ['verb', 'ok'], ['verify', 'ok'], ['commit', 'ok']], t.lines.join('\n'));
      strictEqual(r2.steps[0].forced, true);
      // A batch of the request recorded again, past the repeat rule (its own
      // record holds none yet, so it starts, no restart).
      deepStrictEqual([r2.steps[0].verify.outcome, r2.steps[0].verify.batch.end], ['ran', 'failed'], JSON.stringify(r2.steps[0].verify));
      ok(r2.steps[0].verify.batch.batch_id !== r1.steps[1].verify.batch.batch_id);
      deepStrictEqual(t.ran().slice(0, 4), ['pass', 'fail', 'pass', 'fail'], 'the rerun ran the batch whole, its passed check included');
      strictEqual(r2.halt.reason, 'awaiting-landing');
    } finally {
      t.cleanup();
    }
  });
});

describe('verify-driver: a check group that outlives SIGKILL', () => {
  it('halts the run run-wide, and the run keeps its lock entries and its open-run record while the group lives', BOUNDED, async () => {
    const t = await setup({ scenario: { A: { next: [verify([{ kind: 'pass' }]), COMMIT], file: true } } });
    try {
      // Lingering once; a run that took it for a result would come back, and
      // then meets an error (a halt of another reason), never a loop.
      let calls = 0;
      const startVerify = () => ({ done: Promise.resolve(calls++ === 0 ? { outcome: 'ran', lingering: 424242, wrote: true, batch: { batch_id: 'b1', end: null, checks: [] } } : { outcome: 'error', detail: 'stub', wrote: true }), abort() {} });
      strictEqual(await t.run({}, { startVerify }), 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(r.steps.map((s) => s.kind), ['dispatch', 'verify']);
      strictEqual(r.halt.reason, 'worker-failed');
      match(r.halt.detail, /process group \(424242\) is still there after SIGKILL/);
      ok(L.readLockEntries(L.macroLockPath(t.work, t.fx.macroId)).length > 0, 'the run keeps its macro lock entries');
      ok(L.listOpenRuns(t.work).length > 0, 'and its open-run record, for the cleanup once the group is gone');
    } finally {
      t.cleanup();
    }
  });
});

describe('verify-driver: the offer', () => {
  it('a repository with no declaration at the run\'s baseline is not offered verification, and its workers get no offer', BOUNDED, async () => {
    const t = await setup({ declare: false, scenario: { A: { next: [COMMIT], file: true } } });
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual([r.run.verify.offered, r.halt.reason], [false, 'awaiting-landing']);
      match(r.run.verify.why, /has no \.agentic-plugins\/verify-checks\.json at the run's baseline/);
      ok(t.lines.some((l) => l.includes('verification: not offered')));
      const ws = t.workers();
      strictEqual(ws.length, 2);
      for (const w of ws) {
        ok(!('AGENTIC_AUTOPILOT_VERIFY' in w.env), 'no offer in the environment');
        ok(!w.argv[w.argv.indexOf('--append-system-prompt') + 1].includes('offers verification'), 'nor in the rules');
      }
    } finally {
      t.cleanup();
    }
  });

  it('a run that does not offer it halts run-wide on a verify child; a relaunch that offers it goes on with no release', BOUNDED, async () => {
    const t = await setup({ scenario: { A: { next: [verify([{ kind: 'pass' }]), COMMIT], file: true } } });
    try {
      strictEqual(await t.run({ maxSteps: 1 }), 2, t.lines.join('\n'));
      const offered = t.workers()[0];
      strictEqual(offered.env.AGENTIC_AUTOPILOT_VERIFY, t.latest().run.git_baseline.head, 'an offered worker gets the run\'s baseline');
      ok(offered.argv[offered.argv.indexOf('--append-system-prompt') + 1].includes('This run offers verification'));
      strictEqual(await t.run({}, { verifyOffer: () => ({ offered: false, why: 'the installed persona lacks it (test)', baseline: null }) }), 2);
      const r = t.latest();
      deepStrictEqual([r.halt.reason, r.steps.length], ['owner-choice', 0]);
      match(r.halt.detail, /subtask A: its next step is verify @ HIGH.*this run does not offer verification \(the installed persona lacks it \(test\)\)/);
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      deepStrictEqual(t.latest().steps.map((s) => [s.kind, s.outcome]), [['verify', 'ok'], ['commit', 'ok']]);
    } finally {
      t.cleanup();
    }
  });

  it('a worker that edits the declaration in its step widens nothing: the batch runs what the baseline declares', BOUNDED, async () => {
    const t = await setup({ scenario: { A: { next: [verify([{ kind: 'pass' }]), COMMIT], file: '.agentic-plugins/verify-checks.json' } } });
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(r.steps.map((s) => [s.kind, s.outcome]), [['dispatch', 'ok'], ['verify', 'ok'], ['commit', 'ok']]);
      strictEqual(readFileSync(join(t.work, '.agentic-plugins/verify-checks.json'), 'utf8').trim(), 'A', 'the worker replaced the declaration in its tree');
      deepStrictEqual(t.ran(), ['pass', 'suite']);
    } finally {
      t.cleanup();
    }
  });
});
