// ADR-0068 Decision 5, `verify-runbooks` — the rules the persona's state.mjs
// applies when a verb's Phase 0 runs, in process, through the functions its
// CLI calls: the preflight banner says whether the run offers verification
// (autopilotPreflight), and the results a resume prints (readVerifyResults
// with the tree now, then formatVerifySummary, which `verify-results --format
// text` writes) name a failed batch's failing test and its log, count the
// checks the driver added apart from those requested, and say so when a
// result kept no log. One CLI call, for the dispatcher's own branch: it reads
// `--current-tree` as true or false and refuses any other word.
//
// The runbook blocks that print these are run in test-verify-runbooks.mjs
// (their branches) and test-verify-runbooks-e2e.mjs (the happy path), through
// the shared fixture (_verify-runbook-fixture.mjs).
//
// Run via `npm test -- tests/persona-pipeline/test-verify-results.mjs`.

import { describe, it } from 'node:test';
import { ok, strictEqual } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

import { fileTmpDirs } from '../_tmp.mjs';
import { RUN, VERIFY_PERSONAS, verifyFixture } from './_verify-runbook-fixture.mjs';

// The repositories' directories, removed when the file's tests end: taken
// here, before any test is declared (_verify-runbook-fixture.mjs).
const tmpDirs = fileTmpDirs();

for (const persona of VERIFY_PERSONAS) {
  const fx = await verifyFixture(persona, tmpDirs);
  const { S } = fx;
  // What the resume block prints: `verify-results --current-tree true
  // --format text`, run in the checkout.
  const printed = async (wf, dir) => S.formatVerifySummary(await S.readVerifyResults({ workflowPath: wf, currentTree: true, cwd: dir }));
  // The resume's append before it reads them: Phase 0 takes the request up
  // (clears next step verify), so a failed batch is read as the resumed verb
  // reads it, never while the request is still pending.
  const resumed = async (wf, sha) => {
    await S.appendPhase({ workflowPath: wf, host: 'claude', verb: 'compose', phaseLabel: 'Phase 0: Resume into compose', phaseNote: 'Resumed.', currentPhase: 'phase-0-resume', nextAction: 'Run compose skill', clearNextStep: true, event: 'resumed', env: fx.offer(sha, '4') });
    const fm = await fx.front(wf);
    ok(fm.next_step_kind === undefined && fm.verify_request !== undefined, 'the request is taken up and kept');
    strictEqual((await S.readVerifyResults({ workflowPath: wf })).pending, false);
  };

  describe(`${persona}: the preflight banner (autopilotPreflight)`, () => {
    it('Phase 0: the preflight banner says whether the run offers verification, the signal the long-check guidance names', async () => {
      await fx.withRepo(async ({ dir, sha, wf }) => {
        const banner = async (env) => {
          const r = await S.autopilotPreflight({ workflowPath: wf, host: 'claude', env, cwd: dir });
          strictEqual(r.refuse, false, r.stderr);
          return r.stdout;
        };
        const offered = await banner(fx.offer(sha));
        ok(offered.includes('This run offers verification:'), offered);
        const unoffered = await banner({ AGENTIC_AUTOPILOT: RUN, AGENTIC_AUTOPILOT_STEP: '3' });
        ok(unoffered.includes('This run does not offer verification:') && !unoffered.includes('This run offers verification'), unoffered);
        // A declaration the offer's commit does not hold is no offer.
        const undeclared = await banner(fx.offer('f'.repeat(40)));
        ok(undeclared.includes('This run does not offer verification:'), undeclared);
        const interactive = await banner({});
        ok(!/This run (?:does not )?offers? verification/.test(interactive), interactive);
      });
    });
  });

  describe(`${persona}: the results a verb's resume prints (readVerifyResults, formatVerifySummary)`, () => {
    it('a failed batch: the resumed verb (compose) reads the failing test, its log, and that it applies to the tree now', async () => {
      await fx.withRepo(async (ctx) => {
        const { dir, wf } = ctx;
        await fx.requestInProcess(ctx);
        await fx.driverBatch(wf, { tree: S.currentTreeDigest(dir), outcome: 'failed' });
        await resumed(wf, ctx.sha);
        const out = await printed(wf, dir);
        ok(/Verification request [0-9a-f]+ \(step 3 of run autopilot-/.test(out), out);
        ok(out.includes('- Batch b1: ended failed.'), out);
        ok(/1\. test \[worker\] npm test -- tests\/a\.mjs: failed \(exit 1\); evidence yes; applies to the tree now: yes\./.test(out), out);
        ok(out.includes('failing: suite > the changed case fails'), out);
        ok(out.includes(`log: .agentic-plugins/runs/autopilot/${RUN}/verify/b1/0.log`), out);
        ok(/2\. mutate \[worker\] npm run mutate -- scripts\/mutation-specs\/s\.mjs --only S1 --timeout 1800: not run/.test(out), out);
      });
    });

    it('the header counts the checks requested and those the driver added apart; a result with no log says so, never a path ending /null', async () => {
      await fx.withRepo(async (ctx) => {
        const { dir, wf } = ctx;
        await fx.requestInProcess(ctx);
        await fx.driverBatch(wf, { tree: S.currentTreeDigest(dir), outcome: 'failed', added: true, noLog: true });
        await resumed(wf, ctx.sha);
        const out = await printed(wf, dir);
        ok(/\(step 3 of run [^;]+; 2 check\(s\) requested, 1 added by the driver; on_pass verb critique\)/.test(out), out);
        ok(/3\. test-suite \[driver\] /.test(out), out);
        ok(out.includes('log: none was kept for this check'), out);
        ok(!/\/null\b/.test(out), out);
      });
      await fx.withRepo(async (ctx) => {
        const { dir, wf } = ctx;
        await fx.requestInProcess(ctx);
        await fx.driverBatch(wf, { tree: S.currentTreeDigest(dir), outcome: 'failed' });
        const out = await printed(wf, dir);
        ok(/; 2 check\(s\) requested; on_pass /.test(out), out);
      });
    });
  });

  describe(`${persona}: the verify-results CLI (its dispatcher's own branch)`, () => {
    it('verify-results reads --current-tree as true or false and refuses any other word', async () => {
      await fx.withRepo(async (ctx) => {
        const { dir, wf } = ctx;
        await fx.requestInProcess(ctx);
        await fx.driverBatch(wf, { tree: S.currentTreeDigest(dir), outcome: 'failed' });
        const run = (v) => spawnSync('node', [fx.STATE, 'verify-results', '--workflow-path', wf, '--current-tree', v], { cwd: dir, encoding: 'utf8' });
        strictEqual(JSON.parse(run('true').stdout).tree_digest, S.currentTreeDigest(dir));
        const no = run('false');
        strictEqual(no.status, 0, no.stderr);
        ok(!('tree_digest' in JSON.parse(no.stdout)), no.stdout);
        for (const word of ['yes', '1', 'TRUE']) {
          const r = run(word);
          ok(r.status !== 0, `${word}: refused`);
          ok(/--current-tree is true or false/.test(r.stderr), r.stderr);
        }
      });
    });
  });
}
