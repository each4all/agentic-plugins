// ADR-0068 Decision 5, `verify-runbooks`: the persona runbooks hand long
// checks to the driver's verification step when the run offers it, and read
// the results when they resume. The blocks run as written, in bash, against
// temporary repositories holding the repository's check declaration, with the
// persona's real scripts, for every persona whose runbooks render the verify
// form (dispatch_target on; a persona with it off renders none, which the
// first case pins). Each branch and refusal runs once here, in bash; the happy
// path of every runbook rendering the verify form runs end to end in
// test-verify-runbooks-e2e.mjs (large tier, every shell), and the rules the
// CLI applies (the preflight banner, the results text, verify-results' flag)
// in test-verify-results.mjs, in process. The fixture they share is
// _verify-runbook-fixture.mjs.
//
// Covers:
//   - the finalize of compose, refine and critique (each finalize template:
//     the plain one and the consensus variant), on a macro's child with the
//     operation Phase 0 opened: a request in TEXT_DIR under an offering run
//     ends compose with the next step verify and the request, the operation
//     closed and no terminal marker; with no request, the verb form; a run
//     that offers no verification, a request the last write would refuse,
//     and (consensus) a conflict verdict stop the block before any write; run
//     again with the same TEXT_DIR, a request removed, changed or added since
//     stops it before any write, the same request is taken again, and one
//     whose last write failed is recorded on the rerun; a dangling request
//     link refuses, and (critique) a conflict for a real peer run stops the
//     block before settle; an owner gate beside a request, OWNER_GATE's
//     owner-decision form, the critique cap and NEXT_STEP_KIND;
//   - the resume of a verb prints the results: a passed batch's results as
//     applying to the tree now (the on_pass critique), not applying once the
//     tree changed, and a warning (exit 0) for a results record a later
//     release wrote;
//   - the persona's tree digest is the driver's (lane-digest.mjs treeDigest)
//     on a tree with staged, unstaged, untracked, assume-unchanged and
//     skip-worktree changes and the driver's lock fence;
//   - the prose: under an offering run no rendered compose, refine or
//     critique runbook or skill tells the worker to run the whole suite or a
//     mutation run itself, and each points to the long-check guidance.
//
// Run via `npm test -- tests/persona-pipeline/test-verify-runbooks.mjs`.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { mkdir, readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { treeDigest as driverTreeDigest } from '../../plugins/orchestrator/scripts/lib/lane-digest.mjs';
import { personaInfo } from './_personas.mjs';
import { fileTmpDirs } from '../_tmp.mjs';
import { PERSONAS, REQ, RUN, VERBS, VERIFY_PERSONAS, fill, git, verifyFixture, withGate } from './_verify-runbook-fixture.mjs';

// The repositories' directories, removed when the file's tests end: taken
// here, before any test is declared (_verify-runbook-fixture.mjs).
const tmpDirs = fileTmpDirs();

for (const persona of VERIFY_PERSONAS) {
  const fx = await verifyFixture(persona, tmpDirs);
  const { S, withRepo, offer, runBlock, resume, textDir, finalize, texts, front, realRun } = fx;

  describe(`${persona}: the finalize hands long checks to the verification step (bash, committed runbooks)`, () => {
    // The verify form's two branches, with the operation Phase 0 opened
    // closed by each, in every verb with long-check guidance.
    for (const [verb, nextVerb] of Object.entries(VERBS)) {
      it(`${verb}: a request under an offering run ends with next step verify, the request, the operation closed and no terminal marker; with none, the verb form`, async () => {
        await withRepo(async ({ dir, sha, wf, area }) => {
          const { opDir } = resume(dir, verb, offer(sha));
          const tdir = await textDir(area, texts({ 'verify-request.json': REQ }));
          const r = runBlock(dir, finalize(verb, { tdir, opDir }), offer(sha));
          strictEqual(r.status, 0, r.stderr);
          const fm = await front(wf);
          deepStrictEqual(
            [fm.next_step_kind, fm.next_step_verb, fm.next_step_confidence, fm.terminal_marker === true, fm.persona_operations, fm.current_phase, fm.next_action],
            ['verify', undefined, 'HIGH', false, undefined, 'phase-2-presented', 'Verify the change, then critique'],
          );
          deepStrictEqual([fm.verify_request.checks, fm.verify_request.on_pass, fm.verify_request.run_id, fm.verify_request.step],
            [REQ.checks, REQ.on_pass, RUN, 3]);
          deepStrictEqual(JSON.parse(await readFile(join(tdir, 'finalize-verify.json'), 'utf8')).request_sha256.length, 64);
        });
        await withRepo(async ({ dir, sha, wf, area }) => {
          const { opDir } = resume(dir, verb, offer(sha));
          const tdir = await textDir(area, texts());
          const r = runBlock(dir, finalize(verb, { tdir, opDir }), offer(sha));
          strictEqual(r.status, 0, r.stderr);
          const fm = await front(wf);
          deepStrictEqual([fm.next_step_kind, fm.next_step_verb, 'verify_request' in fm, fm.persona_operations], ['verb', nextVerb, false, undefined]);
          deepStrictEqual(JSON.parse(await readFile(join(tdir, 'finalize-verify.json'), 'utf8')), { request_sha256: null });
        });
      });

      it(`${verb}: no offer, a request the last write would refuse, or a conflict verdict stops the block before any write`, async () => {
        await withRepo(async ({ dir, sha, wf, area }) => {
          const { opDir } = resume(dir, verb, offer(sha));
          const before = await readFile(wf, 'utf8');
          const refused = async (files, env, pattern, opts = {}) => {
            const tdir = await textDir(area, texts(files));
            const r = runBlock(dir, finalize(verb, { tdir, opDir, ...opts }), env);
            strictEqual(r.status, 1, `${pattern}: ${r.stderr}`);
            ok(pattern.test(r.stderr), r.stderr);
            strictEqual(await readFile(wf, 'utf8'), before, `${pattern}: nothing was written`);
          };
          const unoffered = { AGENTIC_AUTOPILOT: RUN, AGENTIC_AUTOPILOT_STEP: '3' };
          await refused({ 'verify-request.json': REQ }, unoffered, /next step verify is refused: missing the run's offer[\s\S]*The last write would refuse verify-request\.json/);
          await refused({ 'verify-request.json': { ...REQ, checks: [{ kind: 'test', args: { files: ['tests/gone.mjs'] } }] } }, offer(sha), /names no file in the tested tree/);
          await refused({ 'verify-request.json': { ...REQ, confidence: 'MEDIUM' } }, offer(sha), /is not the request's confidence MEDIUM/);
          await refused({ 'verify-request.json': { ...REQ, checks: [{ kind: 'shell', args: {} }] } }, offer(sha), /check kind "shell" is not declared/);
          // A request entry the check cannot read (a dangling link) is not
          // the verb form: it refuses too.
          const dangling = await textDir(area, texts());
          await symlink(join(area, 'gone.json'), join(dangling, 'verify-request.json'));
          const d = runBlock(dir, finalize(verb, { tdir: dangling, opDir }), offer(sha));
          strictEqual(d.status, 1, d.stderr);
          ok(/The last write would refuse verify-request\.json/.test(d.stderr), d.stderr);
          strictEqual(await readFile(wf, 'utf8'), before, 'a dangling link: nothing was written');
          // Each finalize template: compose and refine render the plain one,
          // critique the consensus variant.
          await refused({ 'verify-request.json': REQ, 'contested.md': 'a contested item' }, offer(sha), /but VERDICT is conflict: a conflict ends on its gate and takes no request/, { verdict: 'conflict' });
        });
      });
    }

    // A step that ends on its owner's judgment takes no request: next step
    // verify would hide the gate, and the driver would run on_pass past it.
    // decide's owner selection or veto records decide-conflict under its
    // ordinary synthesis heading, so only OWNER_GATE names it.
    for (const verb of [...Object.keys(VERBS), 'decide']) {
      it(`${verb}: an owner gate (OWNER_GATE, or its note's heading) beside a request stops the block before any write`, async () => {
        await withRepo(async ({ dir, sha, wf, area }) => {
          const { opDir } = resume(dir, verb, offer(sha));
          const before = await readFile(wf, 'utf8');
          const refused = async (files, pattern, ownerGate = '') => {
            const tdir = await textDir(area, texts(files));
            const r = runBlock(dir, withGate(finalize(verb, { tdir, opDir }), ownerGate), offer(sha));
            strictEqual(r.status, 1, `${pattern}: ${r.stderr}`);
            ok(pattern.test(r.stderr), r.stderr);
            strictEqual(await readFile(wf, 'utf8'), before, `${pattern}: nothing was written`);
          };
          const gate = verb === 'decide' ? 'decide-conflict' : 'pr-handling';
          await refused({ 'verify-request.json': REQ }, new RegExp(`but OWNER_GATE is ${gate}: a step that ends on its owner's judgment takes no request`), gate);
          const headings = verb === 'decide' ? [] : ['Routing recommendation', 'Outward action needed', ...(verb === 'refine' ? ['Recurring finding'] : [])];
          for (const heading of headings) {
            await refused({ 'verify-request.json': REQ, 'note.md': `### Ensemble synthesis: fixture\n\n### ${heading}\n\nOwner: the judgment` }, /records an owner gate \(its heading\), but OWNER_GATE is empty/);
          }
          // The control: the same request with no gate is taken.
          const tdir = await textDir(area, texts({ 'verify-request.json': REQ }));
          const r = runBlock(dir, finalize(verb, { tdir, opDir }), offer(sha));
          strictEqual(r.status, 0, r.stderr);
          strictEqual((await front(wf)).next_step_kind, 'verify');
        });
      });
    }

    // Naming the gate is what records it (C2-M1): OWNER_GATE selects the last
    // write's owner-decision form, so a step can neither name a gate and close
    // with the verb form, nor hold a gate's heading in its note and close
    // without naming it.
    const OWN_GATE = { compose: ['pr-handling', 'pr-handling'], refine: ['recurring-finding', 'recurring-finding'], critique: ['pr-handling', 'pr-handling'], decide: ['decide-conflict', 'ensemble-synthesis'] };
    for (const verb of [...Object.keys(VERBS), 'decide']) {
      it(`${verb}: OWNER_GATE makes the last write the owner-decision form with the gate's anchor, under autopilot and interactively; a gate the verb does not end on, or a gate's heading with OWNER_GATE empty, stops the block before any write`, async () => {
        // Its own gate under autopilot and interactively; scope-routing, the
        // gate every verb ends on, with its anchor routing-recommendation.
        const cases = [[...OWN_GATE[verb], (sha) => offer(sha)], [...OWN_GATE[verb], () => ({})], ['scope-routing', 'routing-recommendation', (sha) => offer(sha)]];
        for (const [gate, anchor, env] of cases) {
          await withRepo(async ({ dir, sha, wf, area }) => {
            const { opDir } = resume(dir, verb, env(sha));
            const tdir = await textDir(area, texts({ 'next-action.txt': 'Owner: the judgment' }));
            const r = runBlock(dir, withGate(finalize(verb, { tdir, opDir }), gate), env(sha));
            strictEqual(r.status, 0, r.stderr);
            const fm = await front(wf);
            deepStrictEqual(
              [fm.next_step_kind, fm.next_step_verb, fm.awaiting_owner_gate, fm.awaiting_owner_pointer?.endsWith(`#${anchor}`), fm.awaiting_owner_run_id, fm.terminal_marker === true, 'verify_request' in fm, fm.persona_operations, fm.next_action],
              ['owner-decision', undefined, gate, true, undefined, false, false, undefined, 'Owner: the judgment'],
            );
          });
        }
        await withRepo(async ({ dir, sha, wf, area }) => {
          const { opDir } = resume(dir, verb, offer(sha));
          const before = await readFile(wf, 'utf8');
          const refused = async (files, ownerGate, pattern, opts = {}) => {
            const tdir = await textDir(area, texts(files));
            const r = runBlock(dir, withGate(finalize(verb, { tdir, opDir, ...opts }), ownerGate), offer(sha));
            strictEqual(r.status, 1, `${pattern}: ${r.stderr}`);
            ok(pattern.test(r.stderr), r.stderr);
            strictEqual(await readFile(wf, 'utf8'), before, `${pattern}: nothing was written`);
          };
          const foreign = verb === 'refine' ? 'decide-conflict' : 'recurring-finding';
          for (const g of [foreign, 'staging-set', 'peer-conflict', 'no-such-gate']) {
            await refused({}, g, new RegExp(`OWNER_GATE is ${g}, which is not a gate this verb ends on`));
          }
          // A heading indented by up to three spaces, or with more than one
          // space or a tab after its ###, is still one (CommonMark).
          for (const [heading, indent, sep] of [['Routing recommendation', '', ' '], ['Outward action needed', '', ' '], ['Routing recommendation', ' ', ' '], ['Outward action needed', '   ', ' '], ['Routing recommendation', '', '  '], ['Outward action needed', '', '\t']]) {
            await refused({ 'note.md': `### Ensemble synthesis: fixture\n\n${indent}###${sep}${heading}\n\nOwner: the judgment` }, '', /records an owner gate \(its heading\), but OWNER_GATE is empty/);
          }
          if (verb === 'critique' || verb === 'decide') {
            await refused({ 'contested.md': 'a contested item' }, 'scope-routing', /OWNER_GATE is scope-routing, but VERDICT is conflict/, { verdict: 'conflict' });
          }
        });
      });
    }

    it('critique: a conflict verdict for a real completed peer run, with a request beside it, stops the block before settle', async () => {
      await withRepo(async ({ dir, sha, wf, area }) => {
        const { opDir } = resume(dir, 'critique', offer(sha));
        const { ddir } = await realRun({ dir, sha, wf, area, phase: 'critique' });
        const before = await readFile(wf, 'utf8');
        const tdir = await textDir(area, texts({ 'verify-request.json': REQ, 'contested.md': 'a contested item' }));
        const b = finalize('critique', { tdir, opDir, verdict: 'conflict' }).replace("DISPATCH_DIR=''", () => `DISPATCH_DIR='${ddir}'`);
        const r = runBlock(dir, b, offer(sha));
        strictEqual(r.status, 1, r.stderr);
        ok(/but VERDICT is conflict: a conflict ends on its gate and takes no request/.test(r.stderr), r.stderr);
        strictEqual(await readFile(wf, 'utf8'), before, 'nothing was written: the run is still pending, unsettled');
      });
    });

    // C176 — the critique cap is checked before settle, the first write: a
    // critique at its cap (a limit of 1, its first round in progress) whose
    // verb form or request would start another round stops the block with
    // nothing written; commit and the critique-cap gate proceed.
    it('critique: at the cap under autopilot, the verb form or a request whose on_pass is a verb stops the block before settle; commit (NEXT_STEP_KIND) and the critique-cap gate proceed', async () => {
      const capOne = async (wf) => {
        const t = await readFile(wf, 'utf8');
        const end = t.indexOf('\n---\n');
        await writeFile(wf, `${t.slice(0, end)}\ncritique_round_limit: 1${t.slice(end)}`);
      };
      await withRepo(async ({ dir, sha, wf, area }) => {
        await capOne(wf);
        const { opDir } = resume(dir, 'critique', offer(sha));
        const before = await readFile(wf, 'utf8');
        for (const files of [{}, { 'verify-request.json': { ...REQ, on_pass: { kind: 'verb', verb: 'refine', confidence: 'HIGH' } } }]) {
          const tdir = await textDir(area, texts(files));
          const r = runBlock(dir, finalize('critique', { tdir, opDir }), offer(sha));
          strictEqual(r.status, 1, r.stderr);
          ok(/round 1 of the subtask's critique cap 1/.test(r.stderr), r.stderr);
          strictEqual(await readFile(wf, 'utf8'), before, `${Object.keys(files)}: nothing was written`);
        }
        const tdir = await textDir(area, texts({ 'next-action.txt': 'Commit the change' }));
        const r = runBlock(dir, fill(finalize('critique', { tdir, opDir }), "NEXT_STEP_KIND='verb'", "NEXT_STEP_KIND='commit'"), offer(sha));
        strictEqual(r.status, 0, r.stderr);
        const fm = await front(wf);
        deepStrictEqual([fm.next_step_kind, fm.next_step_verb, fm.critique_rounds, fm.terminal_marker === true], ['commit', undefined, 1, false]);
      });
      await withRepo(async ({ dir, sha, wf, area }) => {
        await capOne(wf);
        const { opDir } = resume(dir, 'critique', offer(sha));
        const tdir = await textDir(area, texts({ 'note.md': '### Ensemble synthesis: fixture\n\n### Critique cap reached\n\nOwner: grant rounds or accept', 'next-action.txt': 'Owner: grant rounds or accept' }));
        const r = runBlock(dir, withGate(finalize('critique', { tdir, opDir }), 'critique-cap'), offer(sha));
        strictEqual(r.status, 0, r.stderr);
        const fm = await front(wf);
        deepStrictEqual([fm.next_step_kind, fm.awaiting_owner_gate, fm.awaiting_owner_pointer?.endsWith('#critique-cap'), fm.critique_rounds], ['owner-decision', 'critique-cap', true, 1]);
      });
    });

    // C176 — NEXT_STEP_KIND selects the verb form's commit or done branch in
    // every finalize template, and the critique cap check stays out of the
    // other verbs.
    for (const verb of ['compose', 'refine', 'decide']) {
      it(`${verb}: NEXT_STEP_KIND commit or done ends the verb form with that next step and no verb`, async () => {
        for (const kind of ['commit', 'done']) {
          await withRepo(async ({ dir, sha, wf, area }) => {
            const { opDir } = resume(dir, verb, offer(sha));
            const tdir = await textDir(area, texts({ 'next-action.txt': `Next: ${kind}` }));
            const r = runBlock(dir, fill(finalize(verb, { tdir, opDir }), "NEXT_STEP_KIND='verb'", `NEXT_STEP_KIND='${kind}'`), offer(sha));
            strictEqual(r.status, 0, r.stderr);
            const fm = await front(wf);
            deepStrictEqual([fm.next_step_kind, fm.next_step_verb, fm.terminal_marker === true, 'critique_rounds' in fm], [kind, undefined, false, false]);
          });
        }
      });
    }

    // The verify form's usual case: a verb whose peer ran (Plan-verify,
    // Review, Refine-verify) ends with a request. The check sets aside the run
    // the block settles first, and only that one.
    // compose here; every runbook's verify form after its peer run runs end
    // to end in the e2e file.
    for (const verb of ['compose']) {
      it(`${verb}: a real completed peer run with a non-conflict verdict and a request: settled, then the verify form records the request`, async () => {
        await withRepo(async ({ dir, sha, wf, area }) => {
          const { opDir } = resume(dir, verb, offer(sha));
          const { runId, ddir } = await realRun({ dir, sha, wf, area, phase: verb });
          const tdir = await textDir(area, texts({ 'verify-request.json': REQ }));
          const b = finalize(verb, { tdir, opDir, verdict: 'concerns' }).replace("DISPATCH_DIR=''", () => `DISPATCH_DIR='${ddir}'`);
          const r = runBlock(dir, b, offer(sha));
          strictEqual(r.status, 0, r.stderr);
          const fm = await front(wf);
          deepStrictEqual(
            [fm.next_step_kind, fm.verify_request?.checks, fm.pending_ensemble ?? [], fm.ensemble_results?.at(-1)?.run_id, fm.ensemble_results?.at(-1)?.verdict, fm.persona_operations, fm.terminal_marker === true],
            ['verify', REQ.checks, [], runId, 'concerns', undefined, false],
          );
        });
      });
    }

    it('compose, run again with the same TEXT_DIR: the request removed, changed or added since stops the block before any write; the same request is taken again', async () => {
      await withRepo(async ({ dir, sha, wf, area }) => {
        const { opDir } = resume(dir, 'compose', offer(sha));
        const tdir = await textDir(area, texts({ 'verify-request.json': REQ }));
        strictEqual(runBlock(dir, finalize('compose', { tdir, opDir }), offer(sha)).status, 0);
        const after1 = await readFile(wf, 'utf8');
        const id1 = (await front(wf)).verify_request.id;
        const request = join(tdir, 'verify-request.json');
        const kept = await readFile(request, 'utf8');
        const again = () => runBlock(dir, finalize('compose', { tdir, opDir: '' }), offer(sha));
        await unlink(request);
        let r = again();
        strictEqual(r.status, 1, r.stderr);
        ok(/keeps another form than verify-request\.json there gives now/.test(r.stderr), r.stderr);
        strictEqual(await readFile(wf, 'utf8'), after1, 'removed: nothing was written');
        await writeFile(request, JSON.stringify({ ...REQ, checks: [REQ.checks[0]] }));
        r = again();
        strictEqual(r.status, 1, r.stderr);
        ok(/keeps another form/.test(r.stderr), r.stderr);
        strictEqual(await readFile(wf, 'utf8'), after1, 'changed: nothing was written');
        await writeFile(request, kept);
        r = again();
        strictEqual(r.status, 0, r.stderr);
        deepStrictEqual([(await front(wf)).verify_request.id, (await front(wf)).next_step_kind], [id1, 'verify'], 'the same request, taken again');
      });
      await withRepo(async ({ dir, sha, wf, area }) => {
        const { opDir } = resume(dir, 'compose', offer(sha));
        const tdir = await textDir(area, texts());
        // The verb form's last write refused (a stale operation directory), so
        // the agent runs the block again, now with a request.
        const first = runBlock(dir, finalize('compose', { tdir, opDir: join(area, 'no-such-op') }), offer(sha));
        ok(first.status !== 0, 'the first run failed at its last write');
        const before = await readFile(wf, 'utf8');
        await writeFile(join(tdir, 'verify-request.json'), JSON.stringify(REQ));
        const r = runBlock(dir, finalize('compose', { tdir, opDir }), offer(sha));
        strictEqual(r.status, 1, r.stderr);
        ok(/keeps another form/.test(r.stderr), r.stderr);
        strictEqual(await readFile(wf, 'utf8'), before, 'added: nothing was written');
      });
      await withRepo(async ({ dir, sha, wf, area }) => {
        const { opDir } = resume(dir, 'compose', offer(sha));
        const tdir = await textDir(area, texts({ 'verify-request.json': REQ }));
        // The verify form's own last write refused (a stale operation
        // directory) after settle and the note: run again with the same
        // TEXT_DIR and the right directory, it records the same request.
        const first = runBlock(dir, finalize('compose', { tdir, opDir: join(area, 'no-such-op') }), offer(sha));
        ok(first.status !== 0, 'the first run failed at its last write');
        strictEqual((await front(wf)).next_step_kind, undefined, 'no next step yet');
        const r = runBlock(dir, finalize('compose', { tdir, opDir }), offer(sha));
        strictEqual(r.status, 0, r.stderr);
        const fm = await front(wf);
        deepStrictEqual([fm.next_step_kind, fm.verify_request.checks, fm.persona_operations], ['verify', REQ.checks, undefined]);
      });
    });

    // The form is kept just before settle, after every other check: a run one
    // of them stops keeps none, so the same TEXT_DIR takes a request added
    // since. compose renders the plain template, critique the consensus one
    // (whose contested check comes later still).
    for (const verb of ['compose', 'critique']) {
      it(`${verb}: a run a check before settle stops keeps no form, and the same TEXT_DIR then takes a request added since`, async () => {
        const stops = [[{ 'summary.txt': '   ' }, {}, /summary\.txt in TEXT_DIR .* is missing, blank or not UTF-8 text/]];
        if (verb === 'critique') stops.push([{}, { verdict: 'conflict' }, /contested\.md in TEXT_DIR .* is missing/]);
        for (const [files, opts, pattern] of stops) {
          await withRepo(async ({ dir, sha, wf, area }) => {
            const { opDir } = resume(dir, verb, offer(sha));
            const before = await readFile(wf, 'utf8');
            const tdir = await textDir(area, texts(files));
            const first = runBlock(dir, finalize(verb, { tdir, opDir, ...opts }), offer(sha));
            strictEqual(first.status, 1, first.stderr);
            ok(pattern.test(first.stderr), first.stderr);
            strictEqual(await readFile(wf, 'utf8'), before, 'nothing was written');
            ok(!existsSync(join(tdir, 'finalize-verify.json')), 'no form was kept');
            await writeFile(join(tdir, 'summary.txt'), 'fine\n');
            await writeFile(join(tdir, 'verify-request.json'), JSON.stringify(REQ));
            const r = runBlock(dir, finalize(verb, { tdir, opDir }), offer(sha));
            strictEqual(r.status, 0, r.stderr);
            deepStrictEqual([(await front(wf)).next_step_kind, (await front(wf)).verify_request.checks], ['verify', REQ.checks]);
          });
        }
      });
    }
  });

  // The request is recorded in process, as the verify form's last write
  // records it, and the batch as the driver records it: what these cases run
  // is the resume block that reads them back.
  describe(`${persona}: a verb's resume prints the results the verification step recorded`, () => {
    it('a passed batch: on_pass critique reads the results as applying; once the tree changed, as not applying', async () => {
      for (const changed of [false, true]) {
        await withRepo(async (ctx) => {
          const { dir, sha, wf } = ctx;
          await fx.requestInProcess(ctx);
          await fx.driverBatch(wf, { tree: S.currentTreeDigest(dir), outcome: 'passed', pass: true });
          deepStrictEqual([(await front(wf)).next_step_kind, (await front(wf)).next_step_verb], ['verb', 'critique']);
          if (changed) await writeFile(join(dir, 'tests/a.mjs'), '// edited since the batch\n');
          const r = resume(dir, 'critique', offer(sha, '4'));
          ok(/answered by batch b1, which passed/.test(r.stdout), r.stdout);
          ok(new RegExp(`1\\. test \\[worker\\] [^\\n]*: passed \\(exit 0\\); evidence yes; applies to the tree now: ${changed ? 'no' : 'yes'}\\.`).test(r.stdout), r.stdout);
        });
      }
    });

    it('a results record a later release wrote: a warning, and the verb goes on', async () => {
      await withRepo(async (ctx) => {
        const { dir, wf } = ctx;
        await fx.requestInProcess(ctx);
        await fx.driverBatch(wf, { tree: S.currentTreeDigest(dir), outcome: 'failed' });
        // A later release's results record (a higher v), carried as written.
        const raw = await readFile(wf, 'utf8');
        const line = raw.match(/^verify_results: (".*")$/m);
        ok(line, 'the results scalar');
        const newer = { ...JSON.parse(JSON.parse(line[1])), v: 2 };
        await writeFile(wf, raw.replace(line[0], () => `verify_results: ${JSON.stringify(JSON.stringify(newer))}`));
        const r = resume(dir, 'refine', {});
        ok(/verify_results \(v 2\) was written by a later release/.test(r.stderr), r.stderr);
        ok(r.stderr.includes('⚠ The verification results could not be read'), r.stderr);
      });
    });
  });

  describe(`${persona}: the tree digest a result applies to is the driver's`, () => {
    it('staged, unstaged, untracked, assume-unchanged and skip-worktree changes, and the lock fence, digest alike; each change moves it', async () => {
      await withRepo(async ({ dir }) => {
        const same = () => {
          const mine = S.currentTreeDigest(dir);
          strictEqual(mine, driverTreeDigest(dir).digest);
          return mine;
        };
        const seen = new Set([same()]);
        const step = async (fn) => { await fn(); const d = same(); ok(!seen.has(d), 'the change moves the digest'); seen.add(d); };
        await step(() => writeFile(join(dir, 'tests/a.mjs'), '// unstaged\n'));
        await step(async () => { await writeFile(join(dir, 'tests/b.mjs'), '// staged\n'); git(dir, 'add', 'tests/b.mjs'); });
        await step(() => writeFile(join(dir, 'untracked.txt'), 'u\n'));
        await step(async () => { git(dir, 'update-index', '--assume-unchanged', 'notes.txt'); await writeFile(join(dir, 'notes.txt'), 'hidden\n'); });
        await step(async () => { git(dir, 'update-index', '--skip-worktree', 'scripts/mutation-specs/s.mjs'); await writeFile(join(dir, 'scripts/mutation-specs/s.mjs'), '// skipped\n'); });
        // The lock fence is the driver's bookkeeping: it moves neither.
        const before = same();
        const fence = join(dir, '.agentic-plugins/runs/autopilot/worktree.lock');
        await mkdir(join(fence, '..'), { recursive: true });
        await writeFile(fence, 'lock\n');
        git(dir, 'add', '-f', fence);
        strictEqual(same(), before, 'the lock fence moves no digest');
        ok(existsSync(fence));
      });
    });
  });
}

// Declared after the persona loop, as every test here: a test declared before
// its top-level await would run, and end the file's root, during that await.
describe('the verify form reaches exactly the personas with dispatch_target on (guards a vacuous pass)', () => {
  it('engineer renders it in every verb finalize; a persona with dispatch_target off renders none of it', () => {
    const on = PERSONAS.filter((p) => personaInfo(p).capabilities.dispatch_target === true);
    ok(on.includes('engineer'), 'engineer has dispatch_target on');
    for (const persona of PERSONAS) {
      const P = personaInfo(persona);
      for (const verb of Object.keys(VERBS)) {
        const text = readFileSync(P.path(`commands/${verb}.md`), 'utf8');
        const has = /--next-step-kind verify --next-step-confidence "\$CONFIDENCE"/.test(text) && text.includes('verify-request-check');
        strictEqual(has, on.includes(persona), `${persona}/${verb}`);
      }
    }
  });
});

// The prose an LLM step follows: under an offering run the worker's own step
// runs no whole suite and no mutation run. The rendered runbooks and skills of
// compose, refine and critique route every instruction to run a suite through
// the long-check guidance.
describe('the long-check guidance (ADR-0068 Decision 5, item 1)', () => {
  const RUN_SUITE = /\b[Rr]un (?:the )?(?:relevant |full |whole )?test suite\b/;
  for (const persona of PERSONAS.filter((p) => personaInfo(p).capabilities.dispatch_target === true)) {
    const P = personaInfo(persona);
    for (const rel of ['commands/compose.md', 'commands/refine.md', 'commands/critique.md', 'core/skills/compose/SKILL.md', 'core/skills/refine/SKILL.md', 'core/skills/critique/SKILL.md']) {
      it(`${persona}/${rel}: carries the guidance, and no instruction to run the suite bypasses it`, () => {
        const t = readFileSync(P.path(rel), 'utf8');
        ok(/<!-- pipeline:begin [a-z]+-long-checks -->/.test(t), 'the long-check region');
        ok(/never wait(?:s)? for the heavy-work lock/.test(t.replace(/\s+/g, ' ')), 'under the offer, no wait for the heavy-work lock');
        ok(/agentic-autopilot heavy --/.test(t), 'interactively, the heavy-work lock wrapper');
        // A command renders the short form, which sends its reader to the
        // skill it follows for the whole text: the path it names is that
        // skill, and the skill carries the section.
        if (rel.startsWith('commands/')) {
          const verb = rel.slice('commands/'.length, -'.md'.length);
          const pointed = t.replace(/\s+/g, ' ').match(/`(core\/skills\/[a-z]+\/SKILL\.md)` § Long checks/);
          strictEqual(pointed?.[1], `core/skills/${verb}/SKILL.md`, 'the short form names the skill this command follows');
          ok(/<!-- pipeline:begin [a-z]+-long-checks -->\n### Long checks/.test(readFileSync(P.path(pointed[1]), 'utf8')), 'and that skill carries § Long checks');
        }
        const outside = t.replace(/<!-- pipeline:begin [a-z]+-long-checks -->[\s\S]*?<!-- pipeline:end [a-z]+-long-checks -->/g, '');
        for (const line of outside.split('\n').filter((l) => RUN_SUITE.test(l))) {
          ok(/long[- ]checks?/i.test(line), `an instruction to run the suite that does not route through the long-check guidance: ${line.trim()}`);
        }
      });
    }
    // The verify form renders in every verb's finalize, decide, frame and
    // investigate included, which carry no guidance of their own: it points
    // at runbooks that do.
    it(`${persona}: every runbook rendering the verify form points at long-check guidance that runbook can reach`, () => {
      const commands = ['compose', 'refine', 'critique', 'decide', 'frame', 'investigate'];
      let forms = 0;
      for (const verb of commands) {
        const t = readFileSync(P.path(`commands/${verb}.md`), 'utf8');
        if (!t.includes('**The verify form**')) continue;
        forms += 1;
        const named = t.replace(/\s+/g, ' ').match(/\(§ Long checks in ([^)]*?) says which are long\)/);
        ok(named, `${verb}: the verify form names where the long-check guidance is`);
        const targets = [...named[1].matchAll(new RegExp(`\`/${persona}:([a-z]+)\``, 'g'))].map((m) => m[1]);
        ok(targets.length > 0, `${verb}: it names runbooks: ${named[1]}`);
        for (const target of targets) {
          ok(/<!-- pipeline:begin [a-z]+-long-checks -->\n### Long checks/.test(readFileSync(P.path(`commands/${target}.md`), 'utf8')), `${verb}: /${persona}:${target} carries § Long checks`);
        }
      }
      strictEqual(forms, commands.length, 'every verb renders the verify form');
    });
  }
});
