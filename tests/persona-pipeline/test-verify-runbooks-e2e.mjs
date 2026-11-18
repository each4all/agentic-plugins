// ADR-0068 Decision 5, `verify-runbooks` — the verify form's happy path, end
// to end through each runbook that renders it (compose, refine, critique,
// decide, frame and investigate), in every shell the runbooks may run in, with
// the persona's real scripts and a stub peer: under an offering run Phase 0's
// banner says so, the resume opens the verb's operation and prints nothing of
// a request the workflow does not hold, the peer run the dispatch launched is
// settled by the finalize, whose verify form records the request with the
// operation closed and no terminal marker; once the driver records a passed
// batch, the verb's resume prints it as applying to the tree now.
//
// The one end-to-end run per runbook path, in the large tier
// (scripts/data/test-tiers.json). The branches and refusals are in
// test-verify-runbooks.mjs (each once, in bash), and the rules the CLI applies
// in test-verify-results.mjs, in process. A shell that is not installed (zsh
// on the CI image) is reported as skipped, not passed.
//
// Run via `npm test -- tests/persona-pipeline/test-verify-runbooks-e2e.mjs`.

import { describe, it, before } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { fileTmpDirs } from '../_tmp.mjs';
import { REQ, RUN, SHELLS, VERIFY_FORM_VERBS, VERIFY_PERSONAS, verifyFixture } from './_verify-runbook-fixture.mjs';

// The repositories' directories, removed when the file's tests end: taken
// here, before any test is declared (_verify-runbook-fixture.mjs).
const tmpDirs = fileTmpDirs();

for (const persona of VERIFY_PERSONAS) {
  const fx = await verifyFixture(persona, tmpDirs);
  const { S } = fx;
  for (const [shell, installed] of SHELLS) {
    describe(`${persona}: the verify form, end to end (ADR-0068 Decision 5, ${shell})`, { skip: !installed && `${shell} is not installed` }, () => {
      before(() => { fx.shell = shell; });
      for (const verb of VERIFY_FORM_VERBS) {
        it(`${verb}: Phase 0 under an offering run, its peer run settled, the request recorded; a passed batch then reads as applying`, async () => {
          await fx.withRepo(async ({ dir, sha, wf, area }) => {
            const phase0 = fx.runBlock(dir, fx.phase0Of(verb), fx.offer(sha));
            strictEqual(phase0.status, 0, phase0.stderr);
            ok(phase0.stdout.includes(`Autopilot run ${RUN}`) && phase0.stdout.includes('This run offers verification:'), phase0.stdout);
            const first = fx.resume(dir, verb, fx.offer(sha));
            ok(!/Verification request|could not be read/.test(first.stdout + first.stderr), first.stdout + first.stderr);
            const { runId, ddir } = await fx.realRun({ dir, sha, wf, area, phase: verb });
            const tdir = await fx.textDir(area, fx.texts({ 'verify-request.json': REQ }));
            const b = fx.finalize(verb, { tdir, opDir: first.opDir, verdict: 'concerns' }).replace("DISPATCH_DIR=''", () => `DISPATCH_DIR='${ddir}'`);
            const r = fx.runBlock(dir, b, fx.offer(sha));
            strictEqual(r.status, 0, r.stderr);
            const fm = await fx.front(wf);
            deepStrictEqual(
              [fm.next_step_kind, fm.verify_request?.checks, fm.verify_request?.on_pass, fm.verify_request?.step, fm.pending_ensemble ?? [], fm.ensemble_results?.at(-1)?.run_id, fm.ensemble_results?.at(-1)?.verdict, fm.persona_operations, fm.terminal_marker === true],
              ['verify', REQ.checks, REQ.on_pass, 3, [], runId, 'concerns', undefined, false],
            );
            deepStrictEqual([fm.next_step_verb, fm.next_step_confidence, fm.current_phase, fm.next_action, fm.verify_request?.run_id],
              [undefined, 'HIGH', 'phase-2-presented', 'Verify the change, then critique', RUN]);
            strictEqual(JSON.parse(await readFile(join(tdir, 'finalize-verify.json'), 'utf8')).request_sha256.length, 64);
            await fx.driverBatch(wf, { tree: S.currentTreeDigest(dir), outcome: 'passed', pass: true });
            const again = fx.resume(dir, verb, fx.offer(sha, '4'));
            ok(/answered by batch b1, which passed/.test(again.stdout), again.stdout);
            ok(/1\. test \[worker\] [^\n]*: passed \(exit 0\); evidence yes; applies to the tree now: yes\./.test(again.stdout), again.stdout);
          });
        });
      }
    });
  }
}
