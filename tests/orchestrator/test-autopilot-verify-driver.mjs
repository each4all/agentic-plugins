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
//     file, and the batch adds no event kind;
//   - the owner's instruction (ADR-0068 Decision 7, item 5): one applied after
//     the batch passed, the tree changed since, replaces on_pass, and the P7
//     guard does not resume the requesting verb over it; the owner's rerun
//     (`--next verify`) beside one with a step is refused.

import { describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

  it('a verb that asks for the commit with no final verification is resumed once with the driver\'s sentence; the suite then passes and the commit goes, each on the driver\'s record (C178)', BOUNDED, async () => {
    const VJ = await import(resolve(AP, 'verify-journal.mjs'));
    const P = await import(resolve(AP, 'policy.mjs'));
    const t = await setup({ scenario: { A: { next: [COMMIT, verify([{ kind: 'pass' }]), COMMIT], file: true } } });
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(r.steps.map((s) => [s.kind, s.outcome]), [['dispatch', 'ok'], ['verb', 'ok'], ['verify', 'ok'], ['commit', 'ok']], t.lines.join('\n'));
      const [, verb, batch, commit] = r.steps;
      strictEqual(verb.resume, 'final-verify');
      ok(verb.command.endsWith(` ${P.FINAL_VERIFY_SENTENCE}`), verb.command);
      deepStrictEqual(batch.verify.batch.checks.map((c) => [c.kind, c.origin]), [['pass', 'worker'], ['test-suite', 'driver']]);
      strictEqual(commit.suite_evidence.batch_id, batch.verify.batch.batch_id, 'the commit names the batch that passed the suite');
      strictEqual(commit.command, '/engineer:commit');
      deepStrictEqual(t.ran(), ['pass', 'suite']);
      const wf = readdirSync(join(t.work, '.agentic-plugins/state/orchestrator/verify-journal')).map((f) => f.replace(/\.jsonl$/, ''));
      strictEqual(wf.length, 1);
      const ops = VJ.readJournal(VJ.journalPath(t.work, wf[0])).entries.map((e) => e.op);
      deepStrictEqual(ops, ['final-resume', 'start', 'result', 'result', 'end', 'pass', 'commit']);
    } finally {
      t.cleanup();
    }
  });

  it('a verb that asks for the commit again, without the final verification, halts no-progress: the gate resumes it once on a tree', BOUNDED, async () => {
    const t = await setup({ scenario: { A: { next: [COMMIT], file: true } } });
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      const r = t.latest();
      deepStrictEqual(r.steps.map((s) => [s.kind, s.resume ?? null]), [['dispatch', null], ['verb', 'final-verify']], t.lines.join('\n'));
      strictEqual(r.halt.reason, 'no-progress');
      match(r.halt.detail, /the commit gate resumed a verb on this tree already/);
      deepStrictEqual(t.ran(), []);
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

  it('`--next verify` beside a pending instruction that carries a next step is refused, naming it: no check and no worker starts (ADR-0068 Decision 7, item 5)', BOUNDED, async () => {
    const t = await setup({ scenario: { A: { next: [verify([{ kind: 'pass' }, { kind: 'fail' }]), verify([{ kind: 'pass' }, { kind: 'fail' }]), COMMIT], file: true } } });
    try {
      strictEqual(await t.run(), 2, t.lines.join('\n'));
      strictEqual(t.latest().halt.reason, 'no-progress', JSON.stringify(t.latest().halt));
      deepStrictEqual(t.ran(), ['pass', 'fail']);
      // The owner's instruction to the lane, with a step, while the request waits.
      const I = await import(resolve(REPO_ROOT, 'plugins/orchestrator/scripts/lib/instructions.mjs'));
      const dir = join(t.work, '.agentic-plugins/state/engineer/workflows');
      const text = readdirSync(dir).filter((n) => n.endsWith('.md')).map((n) => readFileSync(join(dir, n), 'utf8')).find((x) => x.includes('originating_subtask: "A"'));
      ok(text, 'the lane\'s child');
      const e = await I.writeInstruction({
        mainRoot: t.work, macroId: t.fx.macroId, subtaskId: 'A', branch: 'feat/a', child: /workflow_id: "([^"]+)"/.exec(text)[1], step: '/engineer:refine',
        note: I.checkNoteBytes(Buffer.from('refine instead of the rerun')), witness: I.gateWitnessOf(text), writtenBy: 'owner',
      });
      const workersBefore = t.workers().length;
      const { parseForcedStep } = await import(resolve(AP, 'policy.mjs'));
      await t.run({ forced: parseForcedStep('verify'), forcedText: 'verify' });
      const r2 = t.latest();
      strictEqual(r2.halt.reason, 'owner-choice', t.lines.join('\n'));
      ok(new RegExp(`subtask A has instruction ${e.id} r1 pending with the next step /engineer:refine`).test(r2.halt.detail), r2.halt.detail);
      deepStrictEqual(r2.steps, [], 'no batch and no step');
      deepStrictEqual(t.ran(), ['pass', 'fail'], 'no check ran');
      strictEqual(t.workers().length, workersBefore, 'no worker started');
      strictEqual(I.readInstructions(t.work, t.fx.macroId, 'A').record.entries[0].state, 'pending');
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

describe('verify-driver: the owner\'s instruction beside an answered request (ADR-0068 Decision 7, item 5)', () => {
  it('an instruction applied after the batch passed, the tree changed since, replaces on_pass, and the P7 guard does not resume the requesting verb over it', BOUNDED, async () => {
    const { pathToFileURL } = await import('node:url');
    const I = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/scripts/lib/instructions.mjs')).href);
    const t = await setup({ scenario: { A: { next: [verify([{ kind: 'pass' }]), COMMIT, COMMIT], file: true } } });
    try {
      const VRUN = await import(resolve(AP, 'verify-run.mjs'));
      let written = null;
      const startVerify = (a) => {
        const h = VRUN.startVerify(a);
        return {
          ...h,
          // The owner writes an instruction while the batch runs: it is
          // applied once the batch has ended, at the lane's next boundary.
          done: h.done.then(async (r) => {
            // The hold-aware engineer on both hosts (item 9), once the
            // dispatch, which reads the installed persona, has run.
            for (const host of ['.claude', '.codex']) {
              const dir = join(t.env.HOME, host, 'plugins/cache/agentic-plugins/engineer/0.33.0', 'scripts');
              mkdirSync(dir, { recursive: true });
              writeFileSync(join(dir, 'state.mjs'), "if (process.argv[2] === 'hold-capability') console.log(JSON.stringify({ capability: 'hold-persona-1', protocol: 1 })); else process.exit(2);\n");
            }
            // The owner also changes the tree after the pass, so the P7 guard
            // would resume the requesting verb over the on_pass.
            writeFileSync(join(t.work, 'owner-edit.txt'), 'an edit of the owner\n');
            const wf = a.job.workflowPath;
            const text = readFileSync(wf, 'utf8');
            written = await I.writeInstruction({
              mainRoot: t.work, macroId: t.fx.macroId, subtaskId: 'A', branch: 'feat/a', child: /workflow_id: "([^"]+)"/.exec(text)[1], step: '/engineer:refine',
              note: I.checkNoteBytes(Buffer.from('refine before the commit')), witness: I.gateWitnessOf(text), writtenBy: 'owner',
            });
            return r;
          }),
        };
      };
      await t.run({ maxSteps: 2 }, { startVerify });
      const r = t.latest();
      ok(written, t.lines.join('\n'));
      deepStrictEqual(r.steps.map((s) => [s.kind, s.command?.replace(/ .*/, '') ?? null]), [['dispatch', '/orchestrator:next'], ['verify', 'verify'], ['verb', '/engineer:refine']], `${JSON.stringify(r.steps.map((s) => [s.kind, s.command]))}\n${t.lines.join('\n')}`);
      strictEqual(r.steps[1].verify.batch.end, 'passed');
      const e = I.readInstructions(t.work, t.fx.macroId, 'A').record.entries[0];
      strictEqual(e.state, 'applied');
      strictEqual(r.steps[2].instruction_application, e.ack.application_id, 'the step carries the application');
    } finally {
      t.cleanup();
    }
  });

  it('a relaunch ends the batch a dead driver left open before it applies an instruction with a step, which then replaces what is left of it (F1)', BOUNDED, async () => {
    const { pathToFileURL } = await import('node:url');
    const I = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/scripts/lib/instructions.mjs')).href);
    const { S, VD, VJ, digestOf } = await import('./_verify-fixtures.mjs');
    const t = await setup({ scenario: { A: { next: [verify([{ kind: 'pass' }, { kind: 'pass2' }]), COMMIT, COMMIT], file: true } } });
    try {
      // Run 1: the dispatch records the request, and the run ends there.
      await t.run({ maxSteps: 1 });
      const dir = join(t.work, '.agentic-plugins/state/engineer/workflows');
      const wf = readdirSync(dir).filter((n) => n.endsWith('.md')).map((n) => join(dir, n)).find((f) => readFileSync(f, 'utf8').includes('originating_subtask: "A"'));
      ok(wf, `the lane's child\n${t.lines.join('\n')}`);
      const fm = (await S.readWorkflow(wf)).frontmatter;
      strictEqual(fm.next_step_kind, 'verify', t.lines.join('\n'));
      // A batch of the request a driver started and died in: the journal and
      // the record hold its start, and nothing ended it.
      const sha = t.fx.git('rev-parse', 'HEAD');
      const decl = VD.readDeclarationAt(t.work, sha).declaration;
      const checks = fm.verify_request.checks.map((c) => ({ kind: c.kind, origin: 'worker', argv: VD.resolveCheck(decl, c) }));
      const start = VJ.startPayload({ batchId: 'dead-1', runId: L.listRuns(t.work).at(-1), treeStart: await digestOf(t.work), declarationCommit: sha, declarationDigest: decl.digest, checks, checksDigest: VD.checksDigest(checks.map((c) => c.argv)), startedAt: '2026-10-20T01:00:00Z' });
      VJ.appendJournal(VJ.journalPath(t.work, fm.workflow_id), { op: 'start', request_id: fm.verify_request.id, batch_id: 'dead-1', payload: start, meta: { verb: fm.verb, base: sha, checks_digest: start.checks_digest } });
      await S.recordBatchStart({ workflowPath: wf, host: 'claude', requestId: fm.verify_request.id, input: start });
      // The hold-aware engineer on both hosts (item 9), and the owner's
      // instruction with a step, written while the batch is open.
      for (const host of ['.claude', '.codex']) {
        const d = join(t.env.HOME, host, 'plugins/cache/agentic-plugins/engineer/0.33.0', 'scripts');
        mkdirSync(d, { recursive: true });
        writeFileSync(join(d, 'state.mjs'), "if (process.argv[2] === 'hold-capability') console.log(JSON.stringify({ capability: 'hold-persona-1', protocol: 1 })); else process.exit(2);\n");
      }
      const text = readFileSync(wf, 'utf8');
      const e = await I.writeInstruction({
        mainRoot: t.work, macroId: t.fx.macroId, subtaskId: 'A', branch: 'feat/a', child: fm.workflow_id, step: '/engineer:refine',
        note: I.checkNoteBytes(Buffer.from('refine after the batch')), witness: I.gateWitnessOf(text), writtenBy: 'owner',
      });
      await t.run({ maxSteps: 1 });
      const r = t.latest();
      deepStrictEqual(r.steps.map((s) => [s.kind, s.command?.replace(/ .*/, '') ?? null]), [['verify', 'verify'], ['verb', '/engineer:refine']], `${JSON.stringify(r.steps.map((s) => [s.kind, s.command]))}\n${t.lines.join('\n')}`);
      // The verify step ends the batch and gives the lane back: what is left
      // of it is a request not running, which the instruction's step replaces
      // (item 5), so no check runs.
      deepStrictEqual([r.steps[0].verify.outcome, r.steps[0].verify.batch?.batch_id, r.steps[0].verify.batch?.end], ['none', 'dead-1', 'cut-short'], JSON.stringify(r.steps[0].verify));
      deepStrictEqual(t.ran(), [], 'nothing of the batch ran');
      // The refine's own finish-verb clears the request from the record; the
      // journal keeps the batch's end.
      const ends = VJ.readJournal(VJ.journalPath(t.work, fm.workflow_id)).entries.filter((x) => x.op === 'end').map((x) => [x.batch_id, x.payload?.end, x.payload?.cause ?? null]);
      deepStrictEqual(ends, [['dead-1', 'cut-short', 'driver-end']], 'the open batch was ended, never left open');
      const applied = I.readInstructions(t.work, t.fx.macroId, 'A').record.entries[0];
      strictEqual(applied.id, e.id);
      strictEqual(applied.state, 'applied');
      strictEqual(applied.ack.replaced_step, 'verify', 'its step replaced the request');
      strictEqual(r.steps[1].instruction_application, applied.ack.application_id);
      ok(t.lines.some((l) => /verification batch dead-1 is open on subtask A's child/.test(l)), t.lines.join('\n'));
    } finally {
      t.cleanup();
    }
  });

  it('an instruction with a step written while a batch is prepared, after the admission, starts no batch: its step replaces the request (critique 10 F1)', BOUNDED, async () => {
    const { pathToFileURL } = await import('node:url');
    const I = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/scripts/lib/instructions.mjs')).href);
    const VO = await import(resolve(AP, 'verify-ops.mjs'));
    const VJ = await import(resolve(AP, 'verify-journal.mjs'));
    const t = await setup({ scenario: { A: { next: [verify([{ kind: 'pass' }]), COMMIT, COMMIT], file: true } } });
    try {
      let written = null;
      const verifyOps = {
        treeDigest: VO.DEFAULT_OPS.treeDigest,
        // The owner writes the instruction during the checks' selection, an
        // await of the batch's preparation, after the step's admission.
        select: async (a) => {
          if (!written) {
            for (const host of ['.claude', '.codex']) {
              const dir = join(t.env.HOME, host, 'plugins/cache/agentic-plugins/engineer/0.33.0', 'scripts');
              mkdirSync(dir, { recursive: true });
              writeFileSync(join(dir, 'state.mjs'), "if (process.argv[2] === 'hold-capability') console.log(JSON.stringify({ capability: 'hold-persona-1', protocol: 1 })); else process.exit(2);\n");
            }
            const dir = join(t.work, '.agentic-plugins/state/engineer/workflows');
            const wf = readdirSync(dir).filter((n) => n.endsWith('.md')).map((n) => join(dir, n)).find((f) => readFileSync(f, 'utf8').includes('originating_subtask: "A"'));
            const text = readFileSync(wf, 'utf8');
            written = await I.writeInstruction({
              mainRoot: t.work, macroId: t.fx.macroId, subtaskId: 'A', branch: 'feat/a', child: /workflow_id: "([^"]+)"/.exec(text)[1], step: '/engineer:refine',
              note: I.checkNoteBytes(Buffer.from('refine instead of the checks')), witness: I.gateWitnessOf(text), writtenBy: 'owner',
            });
          }
          return VO.DEFAULT_OPS.select(a);
        },
      };
      await t.run({ maxSteps: 2 }, { verifyOps });
      const r = t.latest();
      ok(written, t.lines.join('\n'));
      deepStrictEqual(r.steps.map((s) => [s.kind, s.command?.replace(/ .*/, '') ?? null]), [['dispatch', '/orchestrator:next'], ['verify', 'verify'], ['verb', '/engineer:refine']], `${JSON.stringify(r.steps.map((s) => [s.kind, s.command]))}\n${t.lines.join('\n')}`);
      deepStrictEqual([r.steps[1].verify.outcome, r.steps[1].verify.batch], ['none', null], JSON.stringify(r.steps[1].verify));
      deepStrictEqual(t.ran(), [], 'no check ran');
      const e = I.readInstructions(t.work, t.fx.macroId, 'A').record.entries[0];
      strictEqual(e.id, written.id);
      strictEqual(e.state, 'applied');
      strictEqual(e.ack.replaced_step, 'verify', 'its step replaced the request');
      strictEqual(r.steps[2].instruction_application, e.ack.application_id);
      // Nothing of a batch was written: not even the journal's intent.
      const starts = VJ.readJournal(VJ.journalPath(t.work, e.child)).entries.filter((x) => x.op === 'start' || x.op === 'restart');
      deepStrictEqual(starts, [], 'no batch start was recorded');
    } finally {
      t.cleanup();
    }
  });

  it('two batches in a row that yield to an instruction written while each was prepared are no steps that changed nothing: the run goes on (critique 10 F1\'s refine)', BOUNDED, async () => {
    const t = await setup({ scenario: { A: { next: [verify([{ kind: 'pass' }]), COMMIT], file: true } } });
    try {
      const VRUN = await import(resolve(AP, 'verify-run.mjs'));
      // Two owner writes, each withdrawn before the pass could apply it, as
      // startVerify answers them; the third batch runs.
      let yields = 0;
      const startVerify = (a) => {
        if (yields < 2) {
          yields += 1;
          return { abort: () => {}, done: Promise.resolve({ outcome: 'none', instruction: true, detail: 'an instruction with a next step was written while the batch was prepared', wrote: false }) };
        }
        return VRUN.startVerify(a);
      };
      await t.run({ maxSteps: 2 }, { startVerify });
      const r = t.latest();
      deepStrictEqual(r.steps.map((s) => [s.kind, s.verify?.outcome ?? null]), [['dispatch', null], ['verify', 'none'], ['verify', 'none'], ['verify', 'ran'], ['commit', null]], `${JSON.stringify(r.steps.map((s) => [s.kind, s.outcome]))}\n${t.lines.join('\n')}`);
      strictEqual(r.halt.reason, 'awaiting-landing', t.lines.join('\n'));
    } finally {
      t.cleanup();
    }
  });

  it('an instruction record that cannot be read while a batch is prepared starts no batch, as one with a pending step (critique 10 F1\'s refine)', BOUNDED, async () => {
    const { pathToFileURL } = await import('node:url');
    const I = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/scripts/lib/instructions.mjs')).href);
    const IB = await import(resolve(AP, 'instruct-boundary.mjs'));
    const VO = await import(resolve(AP, 'verify-ops.mjs'));
    const t = await setup({ scenario: { A: { next: [verify([{ kind: 'pass' }]), COMMIT], file: true } } });
    try {
      const file = I.instructionsPath(t.work, t.fx.macroId, 'A');
      let damaged = false;
      let repaired = false;
      const verifyOps = {
        treeDigest: VO.DEFAULT_OPS.treeDigest,
        // The record is damaged during the checks' selection.
        select: async (a) => {
          if (!damaged) { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, '{'); damaged = true; }
          return VO.DEFAULT_OPS.select(a);
        },
      };
      // ...and repaired (removed) before the next pass applies it.
      const applyInstructions = async (a) => {
        if (damaged && !repaired) { rmSync(file, { force: true }); repaired = true; }
        return IB.applyAtBoundary(a);
      };
      await t.run({ maxSteps: 2 }, { verifyOps, applyInstructions });
      const r = t.latest();
      ok(damaged && repaired, t.lines.join('\n'));
      deepStrictEqual(r.steps.map((s) => [s.kind, s.verify?.outcome ?? null]), [['dispatch', null], ['verify', 'none'], ['verify', 'ran'], ['commit', null]], `${JSON.stringify(r.steps.map((s) => [s.kind, s.outcome]))}\n${t.lines.join('\n')}`);
      deepStrictEqual(t.ran().filter((x) => x === 'pass'), ['pass'], 'the batch ran once, after the record was repaired');
    } finally {
      t.cleanup();
    }
  });

  it('a note written while the run resolves its roots for a verification step, after the turn\'s application, is applied before the batch, which then runs (II16, the serial verification admission)', BOUNDED, async () => {
    const { pathToFileURL } = await import('node:url');
    const I = await import(pathToFileURL(join(REPO_ROOT, 'plugins/orchestrator/scripts/lib/instructions.mjs')).href);
    const R = await import(resolve(AP, 'roots.mjs'));
    const t = await setup({ scenario: { A: { next: [verify([{ kind: 'pass' }]), COMMIT], file: true } } });
    try {
      // A's dispatch records the request. The turn after it applies
      // instructions (none) and decides the verification step; the owner
      // writes a note while its drift check resolves the roots. A note
      // replaces no request, so only the step's admission applies it first.
      let written = null;
      const resolveRoots = async (o) => {
        const dir = join(t.work, '.agentic-plugins/state/engineer/workflows');
        let wf = null;
        try { wf = readdirSync(dir).filter((n) => n.endsWith('.md')).map((n) => join(dir, n)).find((f) => readFileSync(f, 'utf8').includes('originating_subtask: "A"')); } catch { wf = null; }
        const text = wf ? readFileSync(wf, 'utf8') : '';
        if (!written && /next_step_kind: "?verify/.test(text)) {
          for (const host of ['.claude', '.codex']) {
            const d = join(t.env.HOME, host, 'plugins/cache/agentic-plugins/engineer/0.33.0', 'scripts');
            mkdirSync(d, { recursive: true });
            writeFileSync(join(d, 'state.mjs'), "if (process.argv[2] === 'hold-capability') console.log(JSON.stringify({ capability: 'hold-persona-1', protocol: 1 })); else process.exit(2);\n");
          }
          written = await I.writeInstruction({
            mainRoot: t.work, macroId: t.fx.macroId, subtaskId: 'A', branch: 'feat/a', child: /workflow_id: "([^"]+)"/.exec(text)[1], step: null,
            note: I.checkNoteBytes(Buffer.from('a note for the verified change')), witness: I.gateWitnessOf(text), writtenBy: 'owner',
          });
        }
        return R.resolveRoots(o);
      };
      await t.run({ maxSteps: 2 }, { resolveRoots });
      const r = t.latest();
      ok(written, `the note was written during a drift check after the dispatch\n${t.lines.join('\n')}`);
      deepStrictEqual(r.steps.map((s) => [s.kind, s.verify?.batch?.end ?? null]), [['dispatch', null], ['verify', 'passed'], ['commit', null]], `${JSON.stringify(r.steps.map((s) => [s.kind, s.command]))}\n${t.lines.join('\n')}`);
      const e = I.readInstructions(t.work, t.fx.macroId, 'A').record.entries[0];
      strictEqual(e.state, 'applied', JSON.stringify(e));
      const yieldAt = t.lines.findIndex((l) => /subtask A: an instruction written since its last application attempt comes before this step/.test(l));
      const appliedAt = t.lines.findIndex((l) => /applied subtask A's instructions/.test(l));
      const verifyAt = t.lines.findIndex((l) => /verify \(subtask A\)/.test(l));
      ok(yieldAt >= 0 && appliedAt > yieldAt && verifyAt > appliedAt, `the step yielded, the note was applied, then the batch started\n${t.lines.join('\n')}`);
    } finally {
      t.cleanup();
    }
  });
});
