// tests/orchestrator/test-autopilot-verify-run.mjs
//
// ADR-0068 Decision 5 (verify-exec) — the verification step the driver runs
// (plugins/orchestrator/adapters/claude/autopilot/verify-run.mjs), on real
// processes, the real heavy-work wrapper and the real persona CLI, with a
// declaration whose kinds run one node script (./_verify-fixtures.mjs).
//
// Covers:
//   - order and stops: the worker's checks in their order, the driver's
//     additions before the first check that locks itself; the batch stops at
//     the first check that does not pass, the rest not run; a failing check's
//     tests are recorded and the requesting verb resumes; a passing batch
//     makes on_pass the next step;
//   - outcomes: a command that exits 127 failed, one that is not found could
//     not start (no evidence); a check run directly when its command takes
//     the heavy-work lock itself;
//   - the environment: a check gets the worker's environment without the
//     run's admission token, autopilot flag, step, offer or state base, and
//     never joins the heavy-work ownership a holding worker's proof names;
//   - provenance: a request's step is looked up in every checkout of the
//     repository, a linked one's included;
//   - the tree: a tree edited during a batch gives no evidence;
//   - binding and recovery: a check that ended before its result was recorded
//     runs again; a recorded failure resumes the verb and runs nothing; a
//     record the journal does not hold is set aside and run again whole; a
//     tree changed after a pass resumes the verb;
//   - repeats: the same checks recorded again on an unchanged tree after a
//     failure halt no-progress and run nothing; after a batch with no
//     evidence they run again whole; the owner's rerun runs them once;
//   - bounds and stops: the declared timeout (from the lock's acquisition),
//     the lock wait and the batch bounds end what they bound with no
//     evidence; the lock wait names its holder, never the check's own
//     wrapper; a check that ignores SIGTERM is killed; a hold between two
//     checks stops the batch before the second, and the continuation runs
//     from it; a drain during the lock wait ends the wait; the driver's
//     signal stops a running check; a group that cannot be put on the locks
//     never runs; a hold that comes with the lock's acquisition stops the
//     check before the wrapper's go; the wrapper's command group is the
//     driver's to kill, its supervisor stopped included;
//   - trust: a carried result counts only as the carry of a pass into a batch
//     that continues its own, on its tree and commands; a resume line holds
//     only for the record it was decided on;
//   - a check that does not resolve against the declaration is refused before
//     anything runs.

import { after, describe, it } from 'node:test';
import { deepStrictEqual, match, ok, strictEqual } from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FAST, GIT_ISOLATION, RUN, VD, VJ, VR, cleanup, digestOf, git, jobFor, makeRepo, ran, readWorkflow, request, resumeVerb, runStep, workflowWithRequest,
} from './_verify-fixtures.mjs';
import { acquire } from '../../plugins/orchestrator/scripts/lib/heavy-lock.mjs';

const dirs = [];
after(() => cleanup(dirs));
const BOUNDED = { timeout: 90_000 };

async function setUp(checks, opts = {}) {
  const { dir, sha } = makeRepo(opts.repo);
  const logs = mkdtempSync(join(tmpdir(), 'verify-exec-log-'));
  dirs.push(dir, logs);
  const log = join(logs, 'order.log');
  const wf = await workflowWithRequest(dir, sha, checks, opts);
  const job = (over = {}) => jobFor({ dir, sha, wf, log, ...over });
  return { dir, sha, wf, log, logs, job };
}
const journalOf = (dir, wf) => VJ.readJournal(VJ.journalPath(dir, /([^/]+)\.md$/.exec(wf)[1])).entries;
const latest = (fm) => fm.verify_results.batches.at(-1);

describe('verify-run: the fixture\'s git', () => {
  it('this process and the fixture\'s git read the isolated global config, never the machine\'s', () => {
    const { dir } = makeRepo();
    dirs.push(dir);
    // A key planted in the isolation's own global file: read back only by a
    // git that reads that file in place of the machine's.
    writeFileSync(GIT_ISOLATION.GIT_CONFIG_GLOBAL, '[verifyfixture]\n\tprobe = isolated\n');
    try {
      strictEqual(process.env.GIT_CONFIG_NOSYSTEM, '1');
      strictEqual(git(dir, 'config', '--get', 'verifyfixture.probe'), 'isolated', 'the fixture\'s git');
      const inherited = execFileSync('git', ['-C', dir, 'config', '--get', 'verifyfixture.probe'], { encoding: 'utf8', env: process.env }).trim();
      strictEqual(inherited, 'isolated', 'a child of this process (the persona CLIs, the driver\'s git)');
    } finally {
      writeFileSync(GIT_ISOLATION.GIT_CONFIG_GLOBAL, '');
    }
  });
});

describe('verify-run: order, stops and the step that follows', () => {
  it('runs the worker\'s checks in order and stops at the first that does not pass, the rest not run', BOUNDED, async () => {
    const t = await setUp([{ kind: 'pass' }, { kind: 'fail' }, { kind: 'pass2' }]);
    const r = await runStep(t.job());
    deepStrictEqual(ran(t.log), ['pass', 'fail'], 'pass2 never ran');
    strictEqual(r.batch.end, 'failed');
    deepStrictEqual(r.follow, { kind: 'verb', verb: 'compose' });
    const fm = await readWorkflow(t.wf);
    strictEqual(fm.next_step_kind, 'verify', 'the request stays for the verb to read');
    const b = latest(fm);
    deepStrictEqual(b.results.map((x) => x.outcome), ['passed', 'failed']);
    deepStrictEqual(b.results[1].failing_tests, ['suite > it fails', 'another case']);
    strictEqual(b.results[1].log, `verify/${b.batch_id}/1.log`);
    // The journal holds each write, ahead of it, and nothing it did not make.
    deepStrictEqual(journalOf(t.dir, t.wf).map((e) => e.op), ['start', 'result', 'result', 'end', 'resume']);
    strictEqual(VJ.untrustedProblem({ request: fm.verify_request, results: fm.verify_results, entries: journalOf(t.dir, t.wf) }), null);
  });

  it('a passing batch makes on_pass the next step, and runs nothing on the next look', BOUNDED, async () => {
    const t = await setUp([{ kind: 'pass' }], { onPass: { kind: 'verb', verb: 'critique', confidence: 'HIGH' } });
    const r = await runStep(t.job());
    strictEqual(r.batch.end, 'passed');
    deepStrictEqual(r.follow, { kind: 'on_pass' });
    const fm = await readWorkflow(t.wf);
    deepStrictEqual([fm.next_step_kind, fm.next_step_verb, fm.next_step_confidence], ['verb', 'critique', 'HIGH']);
    strictEqual(fm.verify_request.answered_by, r.batch.batch_id);
    const again = await runStep(t.job({ seq: 5 }));
    strictEqual(again.outcome, 'none');
    deepStrictEqual(ran(t.log), ['pass']);
  });

  it('places the driver\'s additions before the worker\'s first check that locks itself, which runs without the wrapper', BOUNDED, async () => {
    const t = await setUp([{ kind: 'pass' }, { kind: 'self' }, { kind: 'pass2' }]);
    const r = await runStep(t.job(), { additions: [{ kind: 'driver', args: {} }] });
    deepStrictEqual(ran(t.log), ['pass', 'driver', 'selfpass', 'pass2']);
    strictEqual(r.batch.end, 'passed');
    const b = latest(await readWorkflow(t.wf));
    deepStrictEqual(b.checks.map((c) => [c.kind, c.origin]), [['pass', 'worker'], ['driver', 'driver'], ['self', 'worker'], ['pass2', 'worker']]);
    // Each check's group was put on the run's locks, and taken off once it
    // ended; a wrapped check's command group too (the wrapper's ready line),
    // before its go: 3 wrapped checks × 2 groups, and the one run directly.
    strictEqual(r.groups.length, 7);
    ok(r.groups.every((g) => g.released === true));
    // The wrapper's status file exists for the wrapped checks only.
    const dir = join(t.job().runDir, 'verify', b.batch_id);
    const status0 = readFileSync(join(dir, '0.status'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    deepStrictEqual(status0.map((x) => x.state), ['acquired', 'ready', 'running', 'ended']);
    ok(r.groups.some((g) => g.pgid === status0[1].pgid), 'the command\'s own group is on the run\'s locks');
    let selfStatus = null;
    try { selfStatus = readFileSync(join(dir, '2.status'), 'utf8'); } catch { selfStatus = null; }
    strictEqual(selfStatus, null, 'a check that locks itself runs without the wrapper');
  });

  it('a command that exits 127 failed; one that is not found could not start, and gives no evidence', BOUNDED, async () => {
    const t = await setUp([{ kind: 'exit127' }]);
    const r = await runStep(t.job());
    strictEqual(r.batch.end, 'failed');
    deepStrictEqual(latest(await readWorkflow(t.wf)).results.map((x) => [x.outcome, x.exit]), [['failed', 127]]);
    const m = await setUp([{ kind: 'missing' }, { kind: 'pass' }]);
    const rm = await runStep(m.job());
    strictEqual(rm.batch.end, 'no-evidence');
    deepStrictEqual(latest(await readWorkflow(m.wf)).results.map((x) => x.outcome), ['not-started']);
    deepStrictEqual(ran(m.log), [], 'nothing after it ran');
  });

  it('a check gets the worker\'s environment without the run\'s token, flag, step, offer or state base', BOUNDED, async () => {
    const t = await setUp([{ kind: 'env' }]);
    const envFile = join(t.logs, 'env.json');
    const job = t.job({ envFile, extraEnv: { AGENTIC_ENGINEER_ROOT: '/kept' } });
    ok(job.checkEnv.AGENTIC_ENGINEER_ROOT === '/kept');
    const r = await runStep(job);
    strictEqual(r.batch.end, 'passed');
    const names = JSON.parse(readFileSync(envFile, 'utf8'));
    for (const k of ['AGENTIC_AUTOPILOT', 'AGENTIC_AUTOPILOT_TOKEN', 'AGENTIC_AUTOPILOT_STEP', 'AGENTIC_AUTOPILOT_VERIFY', 'AGENTIC_STATE_BASE']) ok(!names.includes(k), `${k}: ${names}`);
    ok(names.includes('AGENTIC_ENGINEER_ROOT'), 'the rest of the worker environment is kept (control)');
  });

  it('a check never joins the heavy-work ownership a holding worker\'s environment carries: it waits for the lock like any other', BOUNDED, async () => {
    const t = await setUp([{ kind: 'pass' }]);
    // A worker that holds the lock (a mutation run of its own step) passes its
    // proof on in its environment: a check that kept it would join that
    // holder and run at once.
    const holder = await acquire(t.dir, { kind: 'harness', purpose: 'a worker\'s mutation run', log: () => {}, pollMs: 20, mint: true });
    try {
      const job = t.job({ extraEnv: { AGENTIC_HEAVY_LOCK_PROOF: holder.proof, AGENTIC_HEAVY_LOCK_VIA: holder.chain.join(','), AGENTIC_HEAVY_LOCK_POLL_MS: '20' } });
      for (const k of VR.CHECK_SCRUB) strictEqual(job.checkEnv[k], undefined, k);
      const r = await runStep(job, { bounds: { ...FAST, lockWaitMs: 1500 } });
      deepStrictEqual([r.batch.end, r.batch.cause], ['no-evidence', 'bound'], JSON.stringify(r.batch));
      deepStrictEqual(ran(t.log), [], 'it waited for the holder, never joined it');
    } finally {
      holder.release();
    }
  });

  it('a tree edited during the batch gives no evidence, whatever the checks did', BOUNDED, async () => {
    const t = await setUp([{ kind: 'touch' }, { kind: 'pass' }]);
    const r = await runStep(t.job());
    deepStrictEqual([r.batch.end, r.batch.cause], ['no-evidence', 'tree-changed']);
    deepStrictEqual(r.follow, { kind: 'verb', verb: 'compose' });
    strictEqual((await readWorkflow(t.wf)).next_step_kind, 'verify', 'no on_pass');
  });

  it('a request naming a step no run of the repository recorded for the subtask is refused, and nothing runs', BOUNDED, async () => {
    const t = await setUp([{ kind: 'pass' }]);
    const job = { ...t.job(), requestKnown: VR.requestKnownIn([t.dir], 'A') };
    const r = await runStep(job);
    strictEqual(r.outcome, 'halt');
    match(r.halt.detail, /names step 3 of run autopilot-20261020T010203Z-abcdef, which no run of this repository recorded/);
    deepStrictEqual(ran(t.log), []);
    // Control: the run's ledger records that step for the subtask.
    const runDir = join(t.dir, '.agentic-plugins/runs/autopilot', RUN);
    writeFileSync(join(runDir, 'steps.jsonl'), `${JSON.stringify({ event: 'started', seq: 3, kind: 'verb', subtask_id: 'A' })}\n`);
    strictEqual((await runStep({ ...t.job({ seq: 5 }), requestKnown: VR.requestKnownIn([t.dir], 'A') })).batch?.end, 'passed');
  });

  it('a request a run from a linked checkout recorded is known to a relaunch from the main one', () => {
    const { dir } = makeRepo();
    const linked = mkdtempSync(join(tmpdir(), 'verify-exec-linked-'));
    dirs.push(dir, linked);
    const wt = join(linked, 'wt');
    git(dir, 'worktree', 'add', '-q', '-b', 'feat/linked', wt);
    // The run that recorded the request was launched from the linked
    // checkout: its ledger is there, and the main checkout holds none.
    const runDir = join(wt, '.agentic-plugins/runs/autopilot', RUN);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'steps.jsonl'), `${JSON.stringify({ event: 'started', seq: 3, kind: 'verb', subtask_id: 'A' })}\n`);
    const req = { run_id: RUN, step: 3 };
    strictEqual(VR.requestKnownIn([dir, dir], 'A')(req), true, 'found in the linked checkout');
    strictEqual(VR.requestKnownIn([dir, dir], 'B')(req), false, 'another subtask\'s step is not this one\'s');
    strictEqual(VR.requestKnownIn([dir, dir], 'A')({ run_id: RUN, step: 4 }), false, 'a step no run took');
  });

  it('a check that does not resolve against the declaration is refused before anything runs', BOUNDED, async () => {
    const t = await setUp([{ kind: 'test', args: { files: ['tests/test-a.mjs'] } }]);
    // The file the request names is gone from the tree the batch would test.
    git(t.dir, 'rm', '-q', 'tests/test-a.mjs');
    const r = await runStep(t.job());
    strictEqual(r.outcome, 'halt');
    match(r.halt.detail, /cannot be run .*names no file in the tested tree.*nothing ran/);
    strictEqual(r.wrote, false);
    strictEqual(journalOf(t.dir, t.wf).length, 0);
    strictEqual((await readWorkflow(t.wf)).verify_results, undefined);
  });
});

describe('verify-run: binding and recovery', () => {
  it('a check that ended before its result was recorded runs again; the batch is ended cut short and continued', BOUNDED, async () => {
    const t = await setUp([{ kind: 'pass' }, { kind: 'pass2' }]);
    // A dead driver's batch: started (journal and record), its first check
    // run, its result never recorded.
    const job = t.job();
    const fm = await readWorkflow(t.wf);
    const tree = await digestOf(t.dir);
    const decl = job.offer.declaration;
    const checks = fm.verify_request.checks.map((c) => ({ kind: c.kind, origin: 'worker', argv: VD.resolveCheck(decl, c) }));
    const start = VJ.startPayload({ batchId: 'dead-1', runId: RUN, treeStart: tree, declarationCommit: t.sha, declarationDigest: decl.digest, checks, checksDigest: VD.checksDigest(checks.map((c) => c.argv)), startedAt: '2026-10-20T01:00:00Z' });
    const file = VJ.journalPath(t.dir, fm.workflow_id);
    VJ.appendJournal(file, { op: 'start', request_id: fm.verify_request.id, batch_id: 'dead-1', payload: start, meta: { verb: 'compose', base: t.sha, checks_digest: start.checks_digest } });
    const { S } = await import('./_verify-fixtures.mjs');
    await S.recordBatchStart({ workflowPath: t.wf, host: 'claude', requestId: fm.verify_request.id, input: start });
    writeFileSync(t.log, 'pass\n'); // the check that ran, before the driver died
    const r = await runStep(job);
    strictEqual(r.batch.continues, 'dead-1');
    strictEqual(r.batch.end, 'passed');
    deepStrictEqual(ran(t.log), ['pass', 'pass', 'pass2'], 'the check with no result ran again');
    const after = await readWorkflow(t.wf);
    deepStrictEqual(after.verify_results.batches.map((b) => [b.batch_id === 'dead-1', b.end, b.cause ?? null]), [[true, 'cut-short', 'driver-end'], [false, 'passed', null]]);
  });

  it('a recorded failure resumes the verb, even after the driver died, and runs no later check', BOUNDED, async () => {
    const t = await setUp([{ kind: 'fail' }, { kind: 'pass' }]);
    await runStep(t.job());
    const r = await runStep(t.job({ seq: 5 }));
    strictEqual(r.outcome, 'resume');
    deepStrictEqual(r.follow, { kind: 'verb', verb: 'compose' });
    strictEqual(r.wrote, false);
    deepStrictEqual(ran(t.log), ['fail']);
  });

  it('a record the journal does not hold is set aside in one restart and run again whole', BOUNDED, async () => {
    const t = await setUp([{ kind: 'pass' }]);
    const job = t.job();
    const fm = await readWorkflow(t.wf);
    const decl = job.offer.declaration;
    const checks = fm.verify_request.checks.map((c) => ({ kind: c.kind, origin: 'worker', argv: VD.resolveCheck(decl, c) }));
    const tree = await digestOf(t.dir);
    // Another writer's batch, ended passed: no evidence for this driver.
    const { S } = await import('./_verify-fixtures.mjs');
    const start = VJ.startPayload({ batchId: 'forged', runId: RUN, treeStart: tree, declarationCommit: t.sha, declarationDigest: decl.digest, checks, checksDigest: VD.checksDigest(checks.map((c) => c.argv)), startedAt: '2026-10-20T01:00:00Z' });
    await S.recordBatchStart({ workflowPath: t.wf, host: 'claude', requestId: fm.verify_request.id, input: start });
    await S.recordResult({ workflowPath: t.wf, host: 'claude', requestId: fm.verify_request.id, batchId: 'forged', input: VJ.resultPayload({ index: 0, outcome: 'passed', exit: 0, durationMs: 1, endedAt: '2026-10-20T01:00:01Z' }) });
    await S.recordBatchEnd({ workflowPath: t.wf, host: 'claude', requestId: fm.verify_request.id, batchId: 'forged', input: VJ.endPayload({ treeEnd: tree, end: 'passed', endedAt: '2026-10-20T01:00:02Z' }) });
    const r = await runStep(job);
    strictEqual(r.batch.restart, true);
    strictEqual(r.batch.end, 'passed');
    deepStrictEqual(ran(t.log), ['pass'], 'the forged pass was never taken');
    const after = await readWorkflow(t.wf);
    deepStrictEqual(after.verify_results.batches.map((b) => b.batch_id), [r.batch.batch_id]);
    strictEqual(after.verify_request.answered_by, r.batch.batch_id);
  });

  it('a tree changed after a pass, before verify-pass, resumes the verb: old results never take on_pass', BOUNDED, async () => {
    const t = await setUp([{ kind: 'pass' }]);
    // The batch passed and ended; the driver died before its pass.
    const ops = { treeDigest: digestOf, select: async () => ({ additions: [], tests: { files: [] } }) };
    const v = VR.startVerify({ job: t.job(), ops, bounds: FAST, register: async () => [{ release() {} }] });
    const r0 = await v.done;
    strictEqual(r0.batch.end, 'passed');
    // Undo the pass the step recorded: the persona keeps the record; the
    // driver's pass is replayed only on the tree the batch passed on.
    const fm = await readWorkflow(t.wf);
    strictEqual(fm.next_step_kind, 'commit');
    // A second request on a tree the person changed afterwards:
    writeFileSync(join(t.dir, 'edited.txt'), 'x');
    const plan = VR.planVerify({
      pending: true, request: { ...fm.verify_request, answered_by: undefined }, results: fm.verify_results,
      entries: journalOf(t.dir, t.wf).filter((e) => e.op !== 'pass'), treeNow: await digestOf(t.dir), checksDigest: null,
    });
    deepStrictEqual([plan.action, plan.verb], ['resume', 'compose']);
    match(plan.why, /tree changed after batch .* passed/);
  });
});

describe('verify-run: repeats and the owner\'s rerun', () => {
  it('the same checks recorded again on an unchanged tree after a failure halt no-progress and run nothing; the owner\'s rerun runs them once', BOUNDED, async () => {
    const t = await setUp([{ kind: 'fail' }]);
    await runStep(t.job());
    await resumeVerb(t.wf, { step: 5 });
    await request(t.wf, t.dir, t.sha, [{ kind: 'fail' }], { step: 5 });
    const r = await runStep(t.job({ seq: 6 }));
    strictEqual(r.outcome, 'halt');
    strictEqual(r.halt.reason, 'no-progress');
    deepStrictEqual(ran(t.log), ['fail'], 'nothing ran');
    const forced = await runStep(t.job({ seq: 7, forcedRerun: true }));
    strictEqual(forced.batch.end, 'failed');
    deepStrictEqual(ran(t.log), ['fail', 'fail']);
    // After a change, the same checks run again.
    writeFileSync(join(t.dir, 'scripts', 'changed.mjs'), '// a change\n');
    await resumeVerb(t.wf, { step: 8 });
    await request(t.wf, t.dir, t.sha, [{ kind: 'fail' }], { step: 8 });
    const changed = await runStep(t.job({ seq: 9 }));
    strictEqual(changed.batch.end, 'failed');
    deepStrictEqual(ran(t.log), ['fail', 'fail', 'fail']);
  });

  it('after a batch whose first check passed and second timed out, the same checks run again whole', BOUNDED, async () => {
    const t = await setUp([{ kind: 'pass' }, { kind: 'hang' }]);
    const r = await runStep(t.job());
    deepStrictEqual([r.batch.end, r.batch.cause], ['no-evidence', 'timeout']);
    await resumeVerb(t.wf, { step: 5 });
    await request(t.wf, t.dir, t.sha, [{ kind: 'pass' }, { kind: 'hang' }], { step: 5 });
    const again = await runStep(t.job({ seq: 6 }));
    deepStrictEqual([again.batch.end, again.batch.continues ?? null], ['no-evidence', null]);
    deepStrictEqual(ran(t.log), ['pass', 'hang', 'pass', 'hang']);
  });
});

describe('verify-run: bounds and stops', () => {
  it('the declared timeout ends a hung check with no evidence; one that ignores SIGTERM is killed', BOUNDED, async () => {
    const t = await setUp([{ kind: 'stubborn' }]);
    const t0 = Date.now();
    // The batch bound is a backstop well past the declared timeout, so that a
    // timeout that never fires ends the test (cause bound), not hangs it.
    const r = await runStep(t.job(), { bounds: { ...FAST, batchMs: 8000 } });
    deepStrictEqual([r.batch.end, r.batch.cause], ['no-evidence', 'timeout']);
    deepStrictEqual(latest(await readWorkflow(t.wf)).results.map((x) => x.outcome), ['timeout']);
    ok(Date.now() - t0 < 20_000);
    ok(r.groups.every((g) => g.released === true), 'its group ended and left the locks');
  });

  it('the batch bound ends a check it cuts with no evidence, cause bound', BOUNDED, async () => {
    const t = await setUp([{ kind: 'pass' }, { kind: 'hang' }]);
    // The hang's declared 2 s are longer than what the batch has left.
    const r = await runStep(t.job(), { bounds: { ...FAST, secondMs: 1000, batchMs: 700 } });
    deepStrictEqual([r.batch.end, r.batch.cause], ['no-evidence', 'bound']);
  });

  it('the declared timeout counts from the lock\'s acquisition; the lock wait has its own bound', BOUNDED, async () => {
    const t = await setUp([{ kind: 'slow' }]);
    const holder = await acquire(t.dir, { kind: 'harness', purpose: 'another holder', log: () => {}, pollMs: 20 });
    let held = true;
    const release = () => { if (held) { held = false; holder.release(); } };
    // The slow check's declared 30 s are 900 ms here. The holder is released
    // once the step reports the wait, which it does only more than 1000 ms
    // after the go: the lock is held for longer than the declared timeout,
    // whatever the machine's load, and the check still passes once it runs.
    // A watchdog releases it should no wait ever be reported.
    const waits = [];
    const watchdog = setTimeout(release, 20_000);
    let r;
    try {
      const v = VR.startVerify({
        job: t.job({ extraEnv: { AGENTIC_HEAVY_LOCK_POLL_MS: '20', VERIFY_FIXTURE_SLOW_MS: '300' } }), bounds: { ...FAST, secondMs: 30 },
        ops: { treeDigest: digestOf, select: async () => ({ additions: [], tests: { files: [] } }) },
        register: async () => [{ release() {} }], onWait: (w) => { if (w) { waits.push(w); release(); } },
      });
      r = await v.done;
    } finally {
      clearTimeout(watchdog);
      release();
    }
    strictEqual(r.batch.end, 'passed', JSON.stringify(r));
    strictEqual(waits[0]?.holder, 'another holder', JSON.stringify(waits));

    const b = await setUp([{ kind: 'pass' }]);
    const h2 = await acquire(b.dir, { kind: 'harness', purpose: 'stays', log: () => {}, pollMs: 20 });
    try {
      const rb = await runStep(b.job({ extraEnv: { AGENTIC_HEAVY_LOCK_POLL_MS: '20' } }), { bounds: { ...FAST, lockWaitMs: 600 } });
      deepStrictEqual([rb.batch.end, rb.batch.cause], ['no-evidence', 'bound']);
      deepStrictEqual(ran(b.log), [], 'the check never ran');
    } finally {
      h2.release();
    }
  });

  it('the lock wait never names the check\'s own wrapper as its holder, only a process outside its group', BOUNDED, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-holder-'));
    dirs.push(dir);
    const file = join(dir, 'heavy.lock');
    // A group of its own stands for the check's: its leader the supervisor,
    // and a child of it, not the leader, the wrapper that took the lock.
    const leader = spawn(process.execPath, ['-e', "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' }); process.stdout.write(c.pid + '\\n'); setTimeout(() => {}, 60000);"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      const wrapper = await new Promise((resolve, reject) => {
        let out = '';
        leader.stdout.on('data', (c) => { out += c; if (out.includes('\n')) resolve(Number(out.trim())); });
        leader.on('error', reject);
      });
      ok(Number.isInteger(wrapper) && wrapper !== leader.pid);
      const lockOf = (pid, host = hostname()) => writeFileSync(file, JSON.stringify({ pid, host, purpose: 'the holder' }));
      strictEqual(VR.groupOf(wrapper), leader.pid, 'the stand-in wrapper is in the leader\'s group');
      lockOf(wrapper);
      strictEqual(VR.waitHolder(file, leader.pid), null, 'the check\'s own wrapper is no holder it waits for');
      lockOf(process.pid);
      strictEqual(VR.waitHolder(file, leader.pid)?.purpose, 'the holder', 'a process outside the group is');
      lockOf(wrapper, `not-${hostname()}`);
      strictEqual(VR.waitHolder(file, leader.pid)?.purpose, 'the holder', 'a pid of another machine is never matched against this one\'s groups');
    } finally {
      try { process.kill(-leader.pid, 'SIGKILL'); } catch { /* gone */ }
    }
  });

  it('a hold between two checks stops the batch before the second; the continuation runs from it', BOUNDED, async () => {
    const t = await setUp([{ kind: 'pass' }, { kind: 'pass2' }]);
    // The hold arrives while the first check runs (its lock already held).
    const r = await runStep(t.job(), { stopCause: () => (ran(t.log).includes('pass') ? 'hold' : null) });
    deepStrictEqual([r.batch.end, r.batch.cause], ['cut-short', 'hold']);
    deepStrictEqual(ran(t.log), ['pass']);
    // Stopped before the second check, not during its wait: it was never
    // started, so it has no result and no group.
    deepStrictEqual(latest(await readWorkflow(t.wf)).results.map((x) => x.outcome), ['passed']);
    strictEqual(r.groups.length, 2, 'the first check\'s wrapper group and its command group');
    const next = await runStep(t.job({ seq: 5 }));
    strictEqual(next.batch.continues, r.batch.batch_id);
    strictEqual(next.batch.end, 'passed');
    deepStrictEqual(ran(t.log), ['pass', 'pass2'], 'the passed check was carried, not run again');
  });

  it('an edit under a hold, then the release: the batch cut short runs again whole on the edited tree', BOUNDED, async () => {
    const t = await setUp([{ kind: 'pass' }, { kind: 'pass2' }]);
    const r = await runStep(t.job(), { stopCause: () => (ran(t.log).includes('pass') ? 'hold' : null) });
    deepStrictEqual([r.batch.end, r.batch.cause], ['cut-short', 'hold']);
    writeFileSync(join(t.dir, 'scripts', 'edited-under-hold.mjs'), '// the person\'s edit\n');
    const next = await runStep(t.job({ seq: 5 }));
    deepStrictEqual([next.batch.continues, next.batch.end], [r.batch.batch_id, 'passed']);
    deepStrictEqual(ran(t.log), ['pass', 'pass', 'pass2'], 'nothing was carried onto the edited tree');
  });

  it('a relaunch whose declaration resolves the request to other commands runs it again whole', BOUNDED, async () => {
    const t = await setUp([{ kind: 'pass' }, { kind: 'pass2' }]);
    const r = await runStep(t.job(), { stopCause: () => (ran(t.log).includes('pass') ? 'hold' : null) });
    strictEqual(r.batch.end, 'cut-short');
    // A newer declaration at the relaunch's baseline: pass runs another script word.
    const decl = JSON.parse(readFileSync(join(t.dir, '.agentic-plugins/verify-checks.json'), 'utf8'));
    decl.kinds.pass.argv = ['node', './scripts/check.mjs', 'pass'];
    writeFileSync(join(t.dir, '.agentic-plugins/verify-checks.json'), JSON.stringify(decl, null, 2));
    git(t.dir, 'commit', '-q', '-am', 'a newer declaration');
    const sha2 = git(t.dir, 'rev-parse', 'HEAD');
    const job = jobFor({ dir: t.dir, sha: sha2, wf: t.wf, log: t.log, seq: 5 });
    const next = await runStep(job);
    strictEqual(next.batch.end, 'passed', JSON.stringify(next));
    deepStrictEqual(ran(t.log), ['pass', 'pass', 'pass2'], 'the pass of the old commands was not carried');
  });

  it('a drain during the lock wait ends the wait, and nothing ran', BOUNDED, async () => {
    const t = await setUp([{ kind: 'pass' }]);
    const holder = await acquire(t.dir, { kind: 'harness', purpose: 'holder', log: () => {}, pollMs: 20 });
    try {
      // The drain comes once the step reports the lock wait: every read
      // before it (the batch's start, its check's) finds none, whatever the
      // machine's load, and the next read, in the wait, finds it.
      let draining = false;
      const r = await runStep(t.job({ extraEnv: { AGENTIC_HEAVY_LOCK_POLL_MS: '20' } }), { onWait: (w) => { if (w) draining = true; }, stopCause: () => (draining ? 'drain' : null) });
      ok(draining, 'the step reported the lock wait');
      deepStrictEqual([r.batch.end, r.batch.cause], ['cut-short', 'drain']);
      deepStrictEqual(latest(await readWorkflow(t.wf)).results.map((x) => x.outcome), ['stopped']);
      deepStrictEqual(ran(t.log), []);
    } finally {
      holder.release();
    }
  });

  it('the driver\'s signal stops a running check, cut short by the driver\'s end', BOUNDED, async () => {
    const t = await setUp([{ kind: 'hang' }, { kind: 'pass' }]);
    // The signal comes once the hang check has started (its log line), not
    // after a fixed time a loaded machine may not have started it in.
    const r = await runStep(t.job(), { abortWhen: () => ran(t.log).includes('hang'), bounds: { ...FAST, secondMs: 1000 } });
    deepStrictEqual([r.batch.end, r.batch.cause], ['cut-short', 'driver-end']);
    deepStrictEqual(ran(t.log), ['hang']);
  });

  it('a hold that came while the batch was prepared starts none: the step yields, writes nothing, and the next step runs it', BOUNDED, async () => {
    const t = await setUp([{ kind: 'pass' }]);
    const r = await runStep(t.job(), { stopCause: () => 'hold' });
    deepStrictEqual([r.outcome, r.cause, r.wrote], ['stopped', 'hold', false], JSON.stringify(r));
    strictEqual(r.batch, undefined);
    strictEqual(journalOf(t.dir, t.wf).length, 0, 'no journal line');
    strictEqual((await readWorkflow(t.wf)).verify_results, undefined, 'no batch on the record');
    deepStrictEqual(ran(t.log), []);
    // The driver's end, read before the hold, is the cause when both are set.
    const v = VR.startVerify({ job: t.job({ seq: 5 }), ops: { treeDigest: digestOf, select: async () => { v.abort('interrupted'); return { additions: [], tests: { files: [] } }; } }, bounds: FAST, stopCause: () => 'hold', register: async () => [{ release() {} }] });
    deepStrictEqual([(await v.done).outcome, (await v.done).cause], ['stopped', 'driver-end']);
    // Once the hold is gone, the request runs.
    strictEqual((await runStep(t.job({ seq: 6 }))).batch.end, 'passed');
  });

  it('a start the persona refuses while a stop is set yields as the stop; refused with none set, the step fails', BOUNDED, async () => {
    // The request is replaced while the batch is prepared, so the persona
    // refuses its start (a write a held lane's persona refuses the same way).
    const replacing = (t, step) => ({
      treeDigest: digestOf,
      select: async () => { await request(t.wf, t.dir, t.sha, [{ kind: 'pass2' }], { step }); return { additions: [], tests: { files: [] } }; },
    });
    const t = await setUp([{ kind: 'pass' }]);
    // Read before the write (no stop yet), then from the refusal (a hold).
    let reads = 0;
    const v = VR.startVerify({ job: t.job(), ops: replacing(t, 3), bounds: FAST, stopCause: () => { reads += 1; return reads === 1 ? null : 'hold'; }, register: async () => [{ release() {} }] });
    const r = await v.done;
    deepStrictEqual([r.outcome, r.cause], ['stopped', 'hold'], JSON.stringify(r));
    strictEqual(reads, 2);
    deepStrictEqual(ran(t.log), []);
    // Control: the same refusal with no stop set is the step's failure.
    const c = await setUp([{ kind: 'pass' }]);
    const rc = await VR.startVerify({ job: c.job(), ops: replacing(c, 3), bounds: FAST, register: async () => [{ release() {} }] }).done;
    strictEqual(rc.outcome, 'error', JSON.stringify(rc));
    match(rc.detail, /verify-batch-start refused/);
  });

  it('a hold that arrives while the check\'s group is put on the locks stops it before its command starts', BOUNDED, async () => {
    const t = await setUp([{ kind: 'self' }]);
    let held = false;
    const r = await runStep(t.job(), { stopCause: () => (held ? 'hold' : null), register: async () => { held = true; return [{ release() {} }]; } });
    deepStrictEqual([r.batch.end, r.batch.cause], ['cut-short', 'hold']);
    deepStrictEqual(ran(t.log), []);
  });

  it('a hold that arrives as the wrapper takes the lock stops the check before its command starts', BOUNDED, async () => {
    const t = await setUp([{ kind: 'pass' }]);
    // The hold lands the moment the driver sees the lock acquired: the
    // wrapper waits for the driver's go, which never comes.
    let acquired = false;
    const r = await runStep(t.job(), { onWait: (w) => { if (w === null) acquired = true; }, stopCause: () => (acquired ? 'hold' : null) });
    ok(acquired, 'the lock was acquired');
    deepStrictEqual([r.batch.end, r.batch.cause], ['cut-short', 'hold']);
    deepStrictEqual(latest(await readWorkflow(t.wf)).results.map((x) => x.outcome), ['stopped']);
    deepStrictEqual(ran(t.log), [], 'the command never started');
    ok(r.groups.every((g) => g.released === true));
  });

  it('a hold that arrives while the wrapper\'s command group is put on the locks stops it before the go', BOUNDED, async () => {
    const t = await setUp([{ kind: 'pass' }]);
    let held = false;
    let calls = 0;
    // The second registration is the command group's, once the wrapper is ready.
    const register = async (g) => { calls += 1; if (calls === 2) held = true; return [{ release: () => { g.released = true; } }]; };
    const r = await runStep(t.job(), { stopCause: () => (held ? 'hold' : null), register });
    strictEqual(calls, 2);
    deepStrictEqual([r.batch.end, r.batch.cause], ['cut-short', 'hold']);
    deepStrictEqual(ran(t.log), [], 'the command never started');
  });

  it('the command\'s own group is the driver\'s too: a stopped supervisor of it is killed, never left running off the run\'s locks', BOUNDED, async () => {
    const t = await setUp([{ kind: 'hang' }]);
    const groups = [];
    // The wrapper's command group, put on the locks second, has its idle
    // supervisor stopped: the wrapper's own SIGTERM and its supervisor's
    // SIGKILL cannot end it, only a SIGKILL to that group.
    const register = async (g) => {
      groups.push(g);
      if (groups.length === 2) process.kill(g.pid, 'SIGSTOP');
      return [{ release: () => { g.released = true; } }];
    };
    const gone = (pgid) => { try { process.kill(-pgid, 0); return false; } catch (e) { return e.code === 'ESRCH'; } };
    try {
      const r = await runStep(t.job(), { register });
      strictEqual(groups.length, 2, 'the wrapper\'s group and its command\'s');
      strictEqual(r.lingering ?? null, null, JSON.stringify(r));
      deepStrictEqual([r.batch.end, r.batch.cause], ['no-evidence', 'timeout']);
      ok(gone(groups[1].pgid), 'the command group is gone');
      ok(groups.every((g) => g.released === true));
    } finally {
      for (const g of groups) { try { process.kill(-g.pgid, 'SIGKILL'); } catch { /* gone */ } }
    }
  });

  it('a check run directly whose group cannot be put on the run\'s locks never runs: its supervisor gets no go', BOUNDED, async () => {
    // A check that takes the heavy-work lock itself has no wrapper and so no
    // second gate: only the supervisor's go, after the registration, holds it.
    const t = await setUp([{ kind: 'self' }]);
    const r = await runStep(t.job(), { register: async () => { await new Promise((w) => { setTimeout(w, 1500); }); throw new Error('the run no longer holds its lock'); } });
    deepStrictEqual(latest(await readWorkflow(t.wf)).results.map((x) => x.outcome), ['not-started']);
    strictEqual(r.batch.end, 'no-evidence');
    deepStrictEqual(ran(t.log), []);
  });

  it('a check whose group cannot be put on the run\'s locks never runs', BOUNDED, async () => {
    const t = await setUp([{ kind: 'pass' }]);
    // The registration takes a while before it fails: a check that started
    // before it would have run by then.
    const r = await runStep(t.job(), { register: async () => { await new Promise((w) => { setTimeout(w, 1500); }); throw new Error('the run no longer holds its lock'); } });
    deepStrictEqual(latest(await readWorkflow(t.wf)).results.map((x) => x.outcome), ['not-started']);
    strictEqual(r.batch.end, 'no-evidence');
    deepStrictEqual(ran(t.log), []);
  });
});

describe('verify-run: trust is the journal\'s payload, not a batch id', () => {
  it('a record whose batch id the journal holds, its result edited by hand, is set aside and run again', BOUNDED, async () => {
    const t = await setUp([{ kind: 'fail' }]);
    const r = await runStep(t.job());
    strictEqual(r.batch.end, 'failed');
    // The worker edits the stored result into a pass, under the same batch id.
    const text = readFileSync(t.wf, 'utf8');
    const line = /^verify_results: (".*")$/m.exec(text);
    const res = JSON.parse(JSON.parse(line[1]));
    const b = res.batches[0];
    b.results[0] = { ...b.results[0], outcome: 'passed', exit: 0, failing_tests: [] };
    b.end = 'passed';
    writeFileSync(t.wf, text.replace(line[0], `verify_results: ${JSON.stringify(JSON.stringify(res))}`));
    const again = await runStep(t.job({ seq: 5 }));
    strictEqual(again.batch?.restart, true, JSON.stringify(again));
    strictEqual(again.batch.end, 'failed');
    deepStrictEqual(ran(t.log), ['fail', 'fail']);
    strictEqual((await readWorkflow(t.wf)).next_step_kind, 'verify', 'the forged pass never took on_pass');
  });

  it('a result whose failing tests were edited by hand, its batch and end untouched, is no evidence: the record is set aside', BOUNDED, async () => {
    const t = await setUp([{ kind: 'fail' }]);
    await runStep(t.job());
    const text = readFileSync(t.wf, 'utf8');
    const line = /^verify_results: (".*")$/m.exec(text);
    const res = JSON.parse(JSON.parse(line[1]));
    res.batches[0].results[0] = { ...res.batches[0].results[0], failing_tests: ['an unrelated test'] };
    writeFileSync(t.wf, text.replace(line[0], `verify_results: ${JSON.stringify(JSON.stringify(res))}`));
    const again = await runStep(t.job({ seq: 5 }));
    strictEqual(again.batch?.restart, true, JSON.stringify(again));
    deepStrictEqual(latest(await readWorkflow(t.wf)).results[0].failing_tests, ['suite > it fails', 'another case']);
  });

  it('a carried result is trusted only as the carry of a pass into a batch that continues its own, on its tree and commands', () => {
    const T1 = '1'.repeat(64);
    const T2 = '2'.repeat(64);
    const D = 'd'.repeat(64);
    const checks = [{ kind: 'pass', origin: 'worker', argv: ['node', 'scripts/check.mjs', 'pass'] }, { kind: 'hang', origin: 'worker', argv: ['node', 'scripts/check.mjs', 'hang'] }];
    const start = (batchId, { continues = null, tree = T1, digest = D } = {}) => VJ.startPayload({ batchId, runId: RUN, continues, treeStart: tree, declarationCommit: 'c'.repeat(40), declarationDigest: 'e'.repeat(64), checks, checksDigest: digest, startedAt: '2026-10-20T01:00:00Z' });
    const pass = VJ.resultPayload({ index: 0, outcome: 'passed', exit: 0, durationMs: 1, endedAt: '2026-10-20T01:00:01Z' });
    const failed = VJ.resultPayload({ index: 0, outcome: 'failed', exit: 1, durationMs: 1, endedAt: '2026-10-20T01:00:01Z' });
    const request = { id: 'r1' };
    const judge = (b2, { first = pass, extra = [] } = {}) => {
      const b1 = { ...start('b1'), results: [first], ...VJ.endPayload({ treeEnd: T1, end: 'cut-short', cause: 'hold', endedAt: '2026-10-20T01:00:02Z' }) };
      const entries = [
        { v: 1, op: 'start', request_id: 'r1', batch_id: 'b1', payload: start('b1') },
        { v: 1, op: 'result', request_id: 'r1', batch_id: 'b1', index: 0, payload: first },
        { v: 1, op: 'end', request_id: 'r1', batch_id: 'b1', payload: VJ.endPayload({ treeEnd: T1, end: 'cut-short', cause: 'hold', endedAt: '2026-10-20T01:00:02Z' }) },
        ...extra,
        { v: 1, op: 'start', request_id: 'r1', batch_id: 'b2', payload: b2 },
      ];
      const results = { request_id: 'r1', batches: [b1, { ...b2, results: [{ ...first, carried_from: { batch_id: 'b1', run_id: RUN } }] }] };
      return VJ.untrustedProblem({ request, results, entries });
    };
    strictEqual(judge(start('b2', { continues: 'b1' })), null, 'the carry the persona makes');
    match(judge(start('b2', { continues: 'b1', tree: T2 })), /no pass of a batch it continues, on its tree and commands/, 'another tree');
    match(judge(start('b2', { continues: 'b1', digest: 'f'.repeat(64) })), /on its tree and commands/, 'other commands');
    match(judge(start('b2')), /no pass of a batch it continues/, 'a batch that continues nothing');
    match(judge(start('b2', { continues: 'b1' }), { first: failed }), /no pass/, 'a failure carried');
    // Through a continuation that carried it on, the chain holds.
    const mid = { v: 1, op: 'start', request_id: 'r1', batch_id: 'bm', payload: start('bm', { continues: 'b1' }) };
    strictEqual(judge(start('b2', { continues: 'bm' }), { extra: [mid] }), null, 'carried on through a continuation');
    // Through one on another tree, which carried nothing, it does not, though
    // the batch after it returns to the first tree.
    const away = { v: 1, op: 'start', request_id: 'r1', batch_id: 'bm', payload: start('bm', { continues: 'b1', tree: T2 }) };
    match(judge(start('b2', { continues: 'bm' }), { extra: [away] }), /no pass of a batch it continues, on its tree and commands/, 'a hop on another tree ends the carry');
  });

  it('a batch left open at a recorded failure (the driver died before its end) ends failed and resumes the verb, running nothing', BOUNDED, async () => {
    const t = await setUp([{ kind: 'fail' }, { kind: 'pass' }]);
    const job = t.job();
    const fm = await readWorkflow(t.wf);
    const decl = job.offer.declaration;
    const checks = fm.verify_request.checks.map((c) => ({ kind: c.kind, origin: 'worker', argv: VD.resolveCheck(decl, c) }));
    const tree = await digestOf(t.dir);
    const start = VJ.startPayload({ batchId: 'open-1', runId: RUN, treeStart: tree, declarationCommit: t.sha, declarationDigest: decl.digest, checks, checksDigest: VD.checksDigest(checks.map((c) => c.argv)), startedAt: '2026-10-20T01:00:00Z' });
    const result = VJ.resultPayload({ index: 0, outcome: 'failed', exit: 1, durationMs: 5, failingTests: ['x'], endedAt: '2026-10-20T01:00:01Z' });
    const file = VJ.journalPath(t.dir, fm.workflow_id);
    const { S } = await import('./_verify-fixtures.mjs');
    VJ.appendJournal(file, { op: 'start', request_id: fm.verify_request.id, batch_id: 'open-1', payload: start, meta: { verb: 'compose', base: t.sha, checks_digest: start.checks_digest } });
    await S.recordBatchStart({ workflowPath: t.wf, host: 'claude', requestId: fm.verify_request.id, input: start });
    VJ.appendJournal(file, { op: 'result', request_id: fm.verify_request.id, batch_id: 'open-1', index: 0, payload: result });
    await S.recordResult({ workflowPath: t.wf, host: 'claude', requestId: fm.verify_request.id, batchId: 'open-1', input: result });
    const r = await runStep(job);
    deepStrictEqual([r.outcome, r.follow], ['resume', { kind: 'verb', verb: 'compose' }]);
    deepStrictEqual(ran(t.log), []);
    const b = latest(await readWorkflow(t.wf));
    deepStrictEqual([b.batch_id, b.end], ['open-1', 'failed']);
  });
});

describe('verify-run: what the policy takes from the journal', () => {
  const summaryOf = async (wf) => {
    const { verifySummary } = await import('../../plugins/orchestrator/adapters/claude/autopilot/observe.mjs');
    const fm = await readWorkflow(wf);
    return { location: 'active', workflow_id: fm.workflow_id, verb: fm.verb, verify: verifySummary(fm), next_step: fm.next_step_kind ? { kind: fm.next_step_kind, verb: fm.next_step_verb ?? null, confidence: fm.next_step_confidence } : null };
  };

  it('a request whose batch failed resumes its verb; an answered one whose tree changed since its pass is guarded', BOUNDED, async () => {
    const t = await setUp([{ kind: 'fail' }]);
    await runStep(t.job());
    let facts = await VR.verifyFacts({ view: { repoRoot: t.dir, children: { A: await summaryOf(t.wf) } }, mainRoot: t.dir, treeOf: digestOf });
    deepStrictEqual(facts.A?.resume?.verb, 'compose');

    const p = await setUp([{ kind: 'pass' }], { onPass: { kind: 'verb', verb: 'critique', confidence: 'HIGH' } });
    await runStep(p.job());
    const view = async () => ({ repoRoot: p.dir, children: { A: await summaryOf(p.wf) } });
    facts = await VR.verifyFacts({ view: await view(), mainRoot: p.dir, treeOf: digestOf });
    deepStrictEqual(facts, {}, 'on the tree it passed on, on_pass follows');
    writeFileSync(join(p.dir, 'changed.txt'), 'x');
    facts = await VR.verifyFacts({ view: await view(), mainRoot: p.dir, treeOf: digestOf });
    deepStrictEqual([facts.A?.guard?.verb, facts.A?.guard?.why], ['compose', 'the tree changed after its batch passed']);
  });

  it('a record edited after its resume line (a result\'s failing tests, same batch and end) yields no resume: the next step sets it aside', BOUNDED, async () => {
    const t = await setUp([{ kind: 'fail' }]);
    await runStep(t.job());
    const view = async () => ({ repoRoot: t.dir, children: { A: await summaryOf(t.wf) } });
    strictEqual((await VR.verifyFacts({ view: await view(), mainRoot: t.dir, treeOf: digestOf })).A?.resume?.verb, 'compose', 'the record the line was decided on');
    const text = readFileSync(t.wf, 'utf8');
    const line = /^verify_results: (".*")$/m.exec(text);
    const res = JSON.parse(JSON.parse(line[1]));
    res.batches[0].results[0] = { ...res.batches[0].results[0], failing_tests: ['an unrelated test'] };
    writeFileSync(t.wf, text.replace(line[0], `verify_results: ${JSON.stringify(JSON.stringify(res))}`));
    const facts = await VR.verifyFacts({ view: await view(), mainRoot: t.dir, treeOf: digestOf });
    strictEqual(facts.A?.resume, undefined, JSON.stringify(facts));
    // With no resume fact the policy gives the verification step, which sets
    // the edited record aside and runs the request again whole.
    const again = await runStep(t.job({ seq: 5 }));
    strictEqual(again.batch?.restart, true, JSON.stringify(again));
    deepStrictEqual(ran(t.log), ['fail', 'fail']);
  });
});

describe('verify-run: a pass the driver died before answering', () => {
  // A batch that passed and ended, journal and record, whose driver died
  // before its verify-pass.
  async function diedBeforePass(t, job) {
    const fm = await readWorkflow(t.wf);
    const decl = job.offer.declaration;
    const checks = fm.verify_request.checks.map((c) => ({ kind: c.kind, origin: 'worker', argv: VD.resolveCheck(decl, c) }));
    const tree = await digestOf(t.dir);
    const { S } = await import('./_verify-fixtures.mjs');
    const file = VJ.journalPath(t.dir, fm.workflow_id);
    const start = VJ.startPayload({ batchId: 'p1', runId: RUN, treeStart: tree, declarationCommit: t.sha, declarationDigest: decl.digest, checks, checksDigest: VD.checksDigest(checks.map((c) => c.argv)), startedAt: '2026-10-20T01:00:00Z' });
    const result = VJ.resultPayload({ index: 0, outcome: 'passed', exit: 0, durationMs: 1, endedAt: '2026-10-20T01:00:01Z' });
    const end = VJ.endPayload({ treeEnd: tree, end: 'passed', endedAt: '2026-10-20T01:00:02Z' });
    const id = fm.verify_request.id;
    VJ.appendJournal(file, { op: 'start', request_id: id, batch_id: 'p1', payload: start, meta: { verb: 'compose', base: t.sha, checks_digest: start.checks_digest } });
    await S.recordBatchStart({ workflowPath: t.wf, host: 'claude', requestId: id, input: start });
    VJ.appendJournal(file, { op: 'result', request_id: id, batch_id: 'p1', index: 0, payload: result });
    await S.recordResult({ workflowPath: t.wf, host: 'claude', requestId: id, batchId: 'p1', input: result });
    VJ.appendJournal(file, { op: 'end', request_id: id, batch_id: 'p1', payload: end });
    await S.recordBatchEnd({ workflowPath: t.wf, host: 'claude', requestId: id, batchId: 'p1', input: end });
  }

  it('on the tree it passed on, the next step answers it with verify-pass, on_pass follows, and nothing runs again', BOUNDED, async () => {
    const t = await setUp([{ kind: 'pass' }], { onPass: { kind: 'verb', verb: 'critique', confidence: 'HIGH' } });
    const job = t.job();
    await diedBeforePass(t, job);
    const r = await runStep(job);
    deepStrictEqual([r.outcome, r.follow, r.batch?.batch_id], ['passed-before', { kind: 'on_pass' }, 'p1']);
    strictEqual(r.wrote, true);
    deepStrictEqual(ran(t.log), [], 'the passed check never ran again');
    const after = await readWorkflow(t.wf);
    deepStrictEqual([after.next_step_kind, after.next_step_verb], ['verb', 'critique']);
    strictEqual(after.verify_request.answered_by, 'p1');
    deepStrictEqual(journalOf(t.dir, t.wf).map((e) => e.op), ['start', 'result', 'end', 'pass']);
  });

  it('on a tree changed since, the step decides the requesting verb, and the policy takes it from the journal', BOUNDED, async () => {
    const t = await setUp([{ kind: 'pass' }]);
    const job = t.job();
    await diedBeforePass(t, job);
    writeFileSync(join(t.dir, 'changed-after.txt'), 'x');
    const r = await runStep(job);
    deepStrictEqual([r.outcome, r.follow], ['resume', { kind: 'verb', verb: 'compose' }]);
    deepStrictEqual(ran(t.log), []);
    const { verifySummary } = await import('../../plugins/orchestrator/adapters/claude/autopilot/observe.mjs');
    const after = await readWorkflow(t.wf);
    const child = { location: 'active', workflow_id: after.workflow_id, verb: after.verb, verify: verifySummary(after), next_step: { kind: 'verify', verb: null, confidence: 'HIGH' } };
    const facts = await VR.verifyFacts({ view: { repoRoot: t.dir, children: { A: child } }, mainRoot: t.dir, treeOf: digestOf });
    deepStrictEqual(facts.A?.resume?.verb, 'compose');
  });

  it('a torn last line of the journal is taken back before the next one is appended', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-journal-'));
    dirs.push(dir);
    const file = join(dir, 'j.jsonl');
    VJ.appendJournal(file, { op: 'start', request_id: 'r', batch_id: 'b', payload: {} });
    writeFileSync(file, `${readFileSync(file, 'utf8')}{"v":1,"op":"res`);
    VJ.appendJournal(file, { op: 'end', request_id: 'r', batch_id: 'b', payload: {} });
    const read = VJ.readJournal(file);
    strictEqual(read.problem, undefined);
    deepStrictEqual(read.entries.map((e) => e.op), ['start', 'end']);
  });

  it('a torn last line longer than 64 KiB is taken back to its start, and the lines before it stay', () => {
    const dir = mkdtempSync(join(tmpdir(), 'verify-journal-'));
    dirs.push(dir);
    const file = join(dir, 'j.jsonl');
    // A start line as large as an admissible batch writes (hundreds of
    // selected paths), cut by a dead driver well past its first 64 KiB.
    const big = { op: 'start', request_id: 'r', batch_id: 'b2', payload: { checks: Array.from({ length: 2000 }, (_, i) => ({ index: i, argv: ['node', '--test', `tests/area/test-${'x'.repeat(40)}-${i}.mjs`] })) } };
    VJ.appendJournal(file, { op: 'start', request_id: 'r', batch_id: 'b1', payload: {} });
    const head = readFileSync(file, 'utf8');
    const line = JSON.stringify({ v: 1, ...big });
    ok(line.length > 3 * 64 * 1024, `the line spans several chunks (${line.length} bytes)`);
    writeFileSync(file, `${head}${line.slice(0, line.length - 100)}`);
    VJ.appendJournal(file, { op: 'end', request_id: 'r', batch_id: 'b1', payload: {} });
    const read = VJ.readJournal(file);
    strictEqual(read.problem, undefined);
    deepStrictEqual(read.entries.map((e) => [e.op, e.batch_id]), [['start', 'b1'], ['end', 'b1']]);
    // A journal that is one torn line, with no newline at all, is taken back whole.
    writeFileSync(file, line.slice(0, line.length - 100));
    VJ.appendJournal(file, { op: 'end', request_id: 'r', batch_id: 'b1', payload: {} });
    deepStrictEqual(VJ.readJournal(file).entries.map((e) => e.op), ['end']);
  });

  it('a failing test\'s name is cut to the bound without splitting a surrogate pair', () => {
    const name = `${'a'.repeat(199)}😀tail`;
    const { names } = VR.parseFailingTests(`not ok 1 - ${name}\n`);
    ok(names[0].isWellFormed(), JSON.stringify(names));
    strictEqual(names[0], 'a'.repeat(199));
  });
});

describe('verify-run: the offer', () => {
  it('a persona without the capability, or a baseline with no declaration, is not offered verification', BOUNDED, async () => {
    const { ENGINEER_ROOT } = await import('./_verify-fixtures.mjs');
    const { dir, sha } = makeRepo();
    const bare = makeRepo({ declaration: null });
    dirs.push(dir, bare.dir);
    const roots = { engineer: ENGINEER_ROOT };
    const yes = VR.verifyOfferFor({ roots, repoRoot: dir, baseline: sha });
    deepStrictEqual([yes.offered, yes.baseline], [true, sha]);
    const lacks = mkdtempSync(join(tmpdir(), 'verify-exec-old-persona-'));
    dirs.push(lacks);
    const old = VR.verifyOfferFor({ roots: { engineer: lacks }, repoRoot: dir, baseline: sha });
    strictEqual(old.offered, false);
    match(old.why, /lacks the verification record CLI/);
    const none = VR.verifyOfferFor({ roots, repoRoot: bare.dir, baseline: bare.sha });
    strictEqual(none.offered, false);
    match(none.why, /has no \.agentic-plugins\/verify-checks\.json/);
  });
});
