// The verb runbooks' blocks (ADR-0063 S3+S4; ADR-0066 Stage 3, PC3b U4b), run
// as written in bash against temporary repositories with the persona's real
// scripts, for every persona the verb regions are generated into: each branch
// and refusal once, in one shell (AGENTS.md § Adding a test). Every verb's
// happy path runs in every installed shell in test-verb-runbook-runs-e2e.mjs,
// and the R4 F1 kill case, which needs real signals and real time, in
// test-verb-runbook-killed-dispatch.mjs, both on the large tier. Each case
// runs over the committed runbook and over the one assembled from the
// templates; where the two are byte-equal (the drift check holds) the
// assembled run is skipped, since it would run the same text again. The
// fixture is _verb-runbook-fixture.mjs.
//
// A finalize's branches run once per finalize region a persona's verbs are
// generated from (verb-finalize: compose; verb-finalize-consensus: critique;
// verb-finalize-convergent: refine where the persona has it), checked against
// the manifest below; the conflict retries once per conflict gate (decide's
// decide-conflict, critique's peer-conflict).
//
// Covers:
//   - a verb's Phase 0: the preflight is silent interactively and puts a
//     pending owner gate to the user without a write; with dispatch_target on
//     it prints the rules under an autopilot run and refuses before any write
//     when a gate is set, and with it off the run is ignored, said once on
//     stderr, and the verb runs interactively; with scripts that predate the
//     preflight (a stand-in, and the newest release without it) the block
//     fails before any write (new runbook text, old install);
//   - the resume block clears the previous next step;
//   - a verb's Phase 2 under an autopilot run: the next step only
//     (dispatch_target on) or the interactive write (off);
//   - the finalize settles from a real run ledger — a completed run records
//     the synthesis verdict, a failed one `failed`, a never-launched attempt
//     nothing; an empty DISPATCH_DIR beside a pending run is refused (R4 H1:
//     no run launched never names one); a launched run whose dispatch
//     directory is gone is named by its own ledger directory (R4 G2, J1), and
//     `gone` names no run; a ledger of another workflow, or a run of another
//     phase (R4 G1), stop it before any write; a conflict finalize run again
//     after its consensus-task failed settles the run it kept in its TEXT_DIR
//     (R4 G2); a verb that closes only once it converged
//     (terminal_requires_convergence) stays open, with its next step, when it
//     did not;
//   - decide's Owner selection and refine's Owner decision: the owner's words
//     reach the resolved note as written, the clear writes the next step and
//     its next action, and inside a /<persona>:start lifecycle the block
//     clears the gate and leaves the terminal write to the lifecycle;
//   - the texts the agent writes (ADR-0059's amendment of 2026-10-10): each
//     block reads them from the files the agent wrote with its file tool, in
//     the directory its TEXT_DIR line names, so hostile text reaches the
//     workflow as written and nothing in it runs.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import {
  AUTOPILOT_RUN_ID, HOSTILE, MACRO, OP_DIR_LINE, PERSONAS, REPO_ROOT, RESOLVE_LINE, REVIEW_TYPES, SUBTASK, TEXT_DIR_LINE, VERBS,
  assertPersonasReached, dedent, fill, gateOpDir, section, verbRunbookFixture, writing,
} from './_verb-runbook-fixture.mjs';
import { MANIFEST } from './_personas.mjs';

const shell = 'bash';

describe('the verb runbook runs reach every persona (guards a vacuous pass)', () => {
  it('the personas the verb regions are generated into are the personas on disk, and each verb runbook holds generated regions', () => {
    assertPersonasReached();
  });
});

// The template a persona's verb finalize is generated from.
const finalizeTemplate = (persona, verb) => {
  const r = MANIFEST.regions.filter((x) => x.dest === `commands/${verb}.md` && x.personas.includes(persona) && /-finalize(-convergent)?$/.test(x.id));
  strictEqual(r.length, 1, `${persona}/${verb}: one finalize region`);
  return r[0].template;
};

// The newest release of the persona whose state.mjs has no autopilot-preflight
// (a clone without tags has none, and the case skips).
function releaseWithoutPreflight(persona) {
  const tags = spawnSync('git', ['-C', REPO_ROOT, 'tag', '-l', `plugin-${persona}-v*`, '--sort=-v:refname'], { encoding: 'utf8' });
  for (const tag of (tags.stdout ?? '').split('\n').filter(Boolean)) {
    const r = spawnSync('git', ['-C', REPO_ROOT, 'show', `${tag}:plugins/${persona}/scripts/state.mjs`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status === 0 && !r.stdout.includes('autopilot-preflight')) return tag;
  }
  return null;
}

for (const persona of PERSONAS) {
  const fx = await verbRunbookFixture(persona);
  const { P, readWorkflow, dispatchOn, commitOn, convergent, DOCUMENTS, runBlock, state, withTexts, dispatched, filled, withRepo, createWorkflow, archive, stubCompanions, launch } = fx;
  // One verb per finalize region this persona's verbs are generated from.
  const BRANCH_VERBS = ['compose', 'critique', ...(convergent('refine') ? ['refine'] : [])];

  describe(`${persona}: the finalize branches run once per finalize region`, () => {
    it('the verbs whose finalize branches run are generated from every finalize template the persona\'s verbs use, one verb each', () => {
      const all = [...new Set(VERBS.map((v) => finalizeTemplate(persona, v)))].sort();
      const chosen = BRANCH_VERBS.map((v) => finalizeTemplate(persona, v));
      deepStrictEqual([...chosen].sort(), all);
      strictEqual(new Set(chosen).size, chosen.length, 'one verb per template');
    });
  });

  for (const [which, docs, same] of DOCUMENTS) {
    const skip = (...verbs) => (same(verbs) ? { skip: `byte-equal to the committed runbook${verbs.length > 1 ? 's' : ''}, which the committed case runs` } : {});
    const verbBlocks = (verb) => fx.verbBlocks(docs, verb);
    const finalize = (verb, opts) => fx.finalize(docs, verb, opts);

    describe(`${persona}: verb runbook blocks (${shell}, ${which})`, () => {
      it('Phase 0: silent interactively; a pending gate is put to the user with no write; an autopilot run as the capability says', skip('critique'), async () => {
        await withRepo(async (dir) => {
          const { find } = verbBlocks('critique');
          let r = runBlock(shell, dir, find);
          strictEqual(r.status, 0, r.stderr);
          strictEqual(r.stdout, '', 'no workflow yet, interactive: nothing');
          const wf = createWorkflow(dir, 'critique');
          r = runBlock(shell, dir, find);
          strictEqual(r.status, 0, r.stderr);
          deepStrictEqual([r.stdout, r.stderr], ['', '']);
          r = runBlock(shell, dir, find, { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID });
          strictEqual(r.status, 0, r.stderr);
          if (dispatchOn) {
            ok(r.stdout.startsWith(`Autopilot run ${AUTOPILOT_RUN_ID}`), r.stdout);
          } else {
            strictEqual(r.stdout, '', 'no rules: the persona is no autopilot subject');
            ok(r.stderr.includes(`AGENTIC_AUTOPILOT=${AUTOPILOT_RUN_ID} is ignored: ${persona} is not an autopilot dispatch target`), r.stderr);
          }
          state('awaiting-owner-set', '--workflow-path', wf, '--host', 'claude', '--gate', 'scope-routing', '--anchor', 'routing-recommendation');
          const before = await readFile(wf, 'utf8');
          r = runBlock(shell, dir, find);
          strictEqual(r.status, 0, r.stderr);
          ok(r.stdout.startsWith('Owner gate scope-routing is pending'), r.stdout);
          strictEqual(await readFile(wf, 'utf8'), before, 'the notice writes nothing');
          r = runBlock(shell, dir, find, { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID });
          if (dispatchOn) {
            strictEqual(r.status, 1);
            ok(r.stderr.includes('owner gate scope-routing is set'), r.stderr);
          } else {
            strictEqual(r.status, 0, r.stderr);
            ok(r.stdout.startsWith('Owner gate scope-routing is pending'), r.stdout);
          }
          strictEqual(await readFile(wf, 'utf8'), before);
        });
      });

      it('Phase 0 with scripts that predate the preflight fails before any write (new text, old install)', skip('critique'), async () => {
        await withRepo(async (dir) => {
          // A stand-in for an older install: it knows find-active and refuses
          // every subcommand it does not know, as the real state.mjs does.
          const old = await realpath(await mkdtemp(join(tmpdir(), `${persona}-old-root-`)));
          try {
            await mkdir(join(old, 'scripts'), { recursive: true });
            await writeFile(join(old, 'scripts', 'state.mjs'), [
              'const [sub] = process.argv.slice(2);',
              "if (sub === 'find-active') { process.stdout.write(process.env.STUB_ACTIVE + '\\n'); process.exit(0); }",
              "process.stderr.write('state.mjs: Unknown subcommand: ' + sub + '\\n'); process.exit(2);",
            ].join('\n'));
            const wf = createWorkflow(dir, 'critique');
            const before = await readFile(wf, 'utf8');
            const { find } = verbBlocks('critique');
            const r = runBlock(shell, dir, find, { STUB_ACTIVE: wf }, old);
            strictEqual(r.status, 2, r.stderr);
            ok(r.stderr.includes('Unknown subcommand: autopilot-preflight'), r.stderr);
            strictEqual(await readFile(wf, 'utf8'), before);
          } finally {
            await rm(old, { recursive: true, force: true });
          }
        });
      });

      it('Phase 0 with the newest released scripts that predate the preflight fails before any write (new text, old install)', skip('critique'), async (t) => {
        const tag = releaseWithoutPreflight(persona);
        if (!tag) { t.skip(`no plugin-${persona}-v* release without the preflight in this clone`); return; }
        await withRepo(async (dir) => {
          const old = await mkdtemp(join(tmpdir(), `${persona}-released-`));
          try {
            // The whole plugin, as an install holds it: a release whose
            // scripts read the persona declaration needs persona.json beside them.
            // Through a file, never tar's stdin: bsdtar exits at the
            // end-of-archive blocks, before reading git archive's record
            // padding, so a write still in flight fails with EPIPE.
            const tarball = join(old, '.release.tar');
            execFileSync('git', ['-C', REPO_ROOT, 'archive', '--format=tar', '-o', tarball, tag, `plugins/${persona}`, '.claude-plugin/marketplace.json']);
            execFileSync('tar', ['-xf', tarball, '-C', old]);
            await rm(tarball);
            const wf = createWorkflow(dir, 'critique');
            const before = await readFile(wf, 'utf8');
            const { find } = verbBlocks('critique');
            const r = runBlock(shell, dir, find, {}, join(old, 'plugins', persona));
            ok(r.status !== 0, `${tag}: the block stops`);
            // At the preflight, which that release does not know (an earlier
            // stop, such as find-active failing, would prove nothing).
            ok(/unknown subcommand:? autopilot-preflight/i.test(r.stderr), r.stderr);
            strictEqual(await readFile(wf, 'utf8'), before);
          } finally {
            await rm(old, { recursive: true, force: true });
          }
        });
      });

      it('resume clears the previous next step', skip('critique'), async () => {
        await withRepo(async (dir) => {
          const wf = createWorkflow(dir, 'critique');
          state('append', '--workflow-path', wf, '--host', 'claude', '--next-step-kind', 'verb', '--next-step-verb', 'critique', '--next-step-confidence', 'HIGH');
          const r = runBlock(shell, dir, fill(verbBlocks('critique').resume, '"<profile or empty>"', '""'), { ACTIVE: wf });
          strictEqual(r.status, 0, r.stderr);
          const fm = (await readWorkflow(wf)).frontmatter;
          deepStrictEqual([fm.next_step_kind, fm.current_phase], [undefined, 'phase-0-resume']);
        });
      });

      // ADR-0068 Decision 2, item 7 (N4): the operation a verb's Phase 0
      // opens on a macro's child, carried to its finalize in the directory
      // Phase 0 printed, there closed; with the macro's holds active, its
      // record published and removed.
      it('Phase 0 prints the operation directory, and the finalize closes the operation there (dispatch_target on; off: no operation directory)', skip('compose'), async () => {
        await withRepo(async (dir) => {
          const { resume, phase2 } = verbBlocks('compose');
          if (!dispatchOn) {
            ok(!resume.includes('OP_DIR') && !phase2.includes('OP_DIR'), 'no operation directory with dispatch_target off');
            return;
          }
          const holds = join(dir, '.agentic-plugins/runs/autopilot/holds', MACRO);
          await mkdir(holds, { recursive: true });
          await writeFile(join(holds, 'protocol.json'), JSON.stringify({ schema: 'agentic-holds-protocol-1', protocol: 1, written_by: 'test', at: '2026-10-25T00:00:00Z' }));
          const wf = createWorkflow(dir, 'compose', { parent: true });
          const r = runBlock(shell, dir, fill(resume, '"<profile or empty>"', '""'));
          strictEqual(r.status, 0, r.stderr);
          const opDir = /^OP_DIR=(.+)$/m.exec(r.stdout)?.[1];
          ok(opDir && existsSync(join(opDir, 'operation.json')), r.stdout);
          const [entry] = (await readWorkflow(wf)).frontmatter.persona_operations.ops;
          const record = join(holds, 'ops', SUBTASK, `${entry.id}.json`);
          ok(existsSync(record), 'the record is published');
          // A value left unfilled stops the finalize before any write.
          const before = await readFile(wf, 'utf8');
          const unfilled = (await finalize('compose')).replace("OP_DIR=''", () => OP_DIR_LINE);
          const u = runBlock(shell, dir, unfilled);
          strictEqual(u.status, 1);
          ok(u.stderr.includes('OP_DIR is not set to the operation directory Phase 0 printed'), u.stderr);
          strictEqual(await readFile(wf, 'utf8'), before);
          const f = runBlock(shell, dir, await finalize('compose', { opDir }));
          strictEqual(f.status, 0, f.stderr);
          const fm = (await readWorkflow(wf)).frontmatter;
          // The operation closed by the last write, the finalize released its
          // directory (ADR-0059 Decision 10, item 1).
          deepStrictEqual([fm.persona_operations, fm.terminal_marker, existsSync(record), existsSync(opDir)], [undefined, true, false, false]);
        });
      });

      // The interactive finish is every verb's happy path (the e2e file) and
      // the refused settlement each finalize case below; this one is the
      // autopilot branch.
      it('Phase 2 under an autopilot run: the next step only with dispatch_target on, the interactive terminal write with it off', skip('critique'), async () => {
        await withRepo(async (dir) => {
          const wf = createWorkflow(dir, 'critique');
          const r = runBlock(shell, dir, await finalize('critique'), { ACTIVE: '/w/stale.md', AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID });
          strictEqual(r.status, 0, r.stderr);
          const fm = (await readWorkflow(wf)).frontmatter;
          // On: the terminal marker is left for the commit; off: the run is
          // ignored.
          deepStrictEqual([fm.current_phase, fm.terminal_marker === true, fm.next_step_kind, fm.next_step_verb, fm.next_step_confidence],
            [dispatchOn ? 'phase-2-presented' : 'summary-complete', !dispatchOn, 'verb', 'refine', 'HIGH']);
        });
      });

      // C163 A2b (ADR-0069 Decision 1, item 6): the file the agent wrote is the
      // only way a review's subject reaches its record; a review with none
      // vouches for nothing. A stand-in runner shows what the block passes.
      for (const verb of ['compose', 'critique', 'refine']) {
        it(`${verb}: subject.json reaches the review's record, from the dispatch and, with no run launched, from the finalize; no file passes no flag, and an older runner is not given it`, skip(verb), async () => {
          const companions = await stubCompanions();
          const standIns = await realpath(await mkdtemp(join(tmpdir(), `${persona}-stand-in-runners-`)));
          const textDirOf = (b) => /^TEXT_DIR='([^'\n]+)'$/m.exec(b)[1];
          const subject = { shown: ['a.txt', 'b.txt'], covered: ['a.txt'] };
          const prompt = { 'prompt.xml': '<task>fixture</task>' };
          const withSubject = { ...prompt, 'subject.json': JSON.stringify(subject) };
          const standIn = async (name, wf, comment) => {
            const root = join(standIns, name);
            await mkdir(join(root, 'scripts'), { recursive: true });
            await writeFile(join(root, 'scripts', 'state.mjs'), `process.stdout.write(${JSON.stringify(wf)});\n`);
            await writeFile(join(root, 'scripts', 'peer-runner.mjs'), `// ${comment}\nprocess.stdout.write(process.argv[2] === 'new-run-id' ? 'run-1' : JSON.stringify(process.argv.slice(2)));\n`);
            return root;
          };
          try {
            await withRepo(async (dir) => {
              const { dispatch } = verbBlocks(verb);
              const wf = createWorkflow(dir, verb);
              // What the block passes.
              const passed = async (texts, root) => {
                const b = await withTexts(dispatch, texts);
                const r = runBlock(shell, dir, b, {}, root);
                strictEqual(r.status, 0, r.stderr);
                return { dir: textDirOf(b), argv: JSON.parse(await readFile(join(textDirOf(b), 'prompt.xml.run.json'), 'utf8')) };
              };
              const current = await standIn('current', wf, "names '--subject-file'");
              const older = await standIn('older', wf, 'predates the flag');
              const given = await passed(withSubject, current);
              strictEqual(given.argv[given.argv.indexOf('--subject-file') + 1], join(given.dir, 'subject.json'));
              ok(!(await passed(prompt, current)).argv.includes('--subject-file'), 'no file, no flag');
              ok(!(await passed(withSubject, older)).argv.includes('--subject-file'), 'an older runner would refuse the flag');
              // The real runner: the dispatch's handle holds it.
              const b = await withTexts(dispatch, withSubject);
              const r = runBlock(shell, dir, b, { AGENTIC_COMPANIONS_ROOT: companions });
              strictEqual(r.status, 0, r.stderr);
              const { handle_path: handle } = JSON.parse(await readFile(join(textDirOf(b), 'prompt.xml.run.json'), 'utf8'));
              deepStrictEqual(JSON.parse(await readFile(handle, 'utf8')).subject.covered, subject.covered);
            });
            await withRepo(async (dir) => {
              // No run launched: the finalize's settle records it with the attempt.
              const wf = createWorkflow(dir, verb);
              const b = (await finalize(verb)).replace("NO_RUN_REASON=''", () => "NO_RUN_REASON='local-only'");
              await writeFile(join(textDirOf(b), 'subject.json'), `${JSON.stringify(subject)}\n`);
              const r = runBlock(shell, dir, b);
              strictEqual(r.status, 0, r.stderr);
              const { frontmatter: fm } = await readWorkflow(wf);
              const [attempt] = JSON.parse(fm.review_attempts).attempts;
              // The record keeps whether the subject covered the whole change; with
              // no subject it would be null (unbound, no-subject).
              deepStrictEqual(['full', 'partial'].includes(JSON.parse(fm.review_bindings).attempts[attempt.id].coverage), true);
            });
          } finally {
            await rm(companions, { recursive: true, force: true });
            await rm(standIns, { recursive: true, force: true });
          }
        });
      }

      // C163 A1a: what a finalize records when no run launched follows the
      // verb's ensemble type, a substitution of its region, not the region
      // alone: a review records its attempt under that type, any other verb
      // none. Every verb, since the branch cases below run one per region.
      it('every verb\'s finalize with no run launched records its review attempt under the verb\'s ensemble type, and a verb that is no review records none', skip(...VERBS), async () => {
        await withRepo(async (dir) => {
          for (const verb of VERBS) {
            const { type } = verbBlocks(verb);
            ok(typeof type === 'string', `${verb}: the runbook names its ensemble type`);
            const wf = createWorkflow(dir, verb);
            const r = runBlock(shell, dir, await finalize(verb), { ACTIVE: '/w/stale.md' });
            strictEqual(r.status, 0, `${verb}: ${r.stderr}`);
            const fm = (await readWorkflow(wf)).frontmatter;
            const attempts = fm.review_attempts === undefined ? [] : JSON.parse(fm.review_attempts).attempts;
            deepStrictEqual([verb, fm.current_phase, attempts.map((a) => [a.type, a.outcome, a.reason])],
              [verb, 'summary-complete', REVIEW_TYPES.includes(type) ? [[type, 'skipped', 'unspecified']] : []]);
            archive(dir, wf);
          }
        });
      });

      for (const verb of BRANCH_VERBS) {
        it(`${verb}'s finalize: completed → the synthesis verdict, failed → failed, never launched → nothing, each then finish-verb; an empty DISPATCH_DIR beside a pending run is refused, the run's ledger directory settles that run, and a ledger of another workflow (A's run finalized on B) stops the block before any write (R4 G2, H1, J1)`, skip(verb), async () => {
          const ok_ = await stubCompanions();
          const gone = await stubCompanions({ missing: true });
          try {
            await withRepo(async (dir) => {
              const { type } = verbBlocks(verb);
              // A value an earlier shell left is not what the block reads.
              const vars = { ACTIVE: '/w/stale.md', RUN_ID: 'stale', VERDICT: 'stale' };
              const results = async (wf) => {
                const fm = (await readWorkflow(wf)).frontmatter;
                return { fm, results: fm.ensemble_results ?? [], pending: fm.pending_ensemble ?? [] };
              };
              const isReview = REVIEW_TYPES.includes(type);

              // Completed: the synthesis verdict, the pending row gone, the
              // terminal write with the verb's next step and declared action.
              let wf = await fx.completedFinalize(shell, dir, docs, verb, ok_, vars);
              archive(dir, wf);

              // Launched and failed (no companion): verdict failed, whatever the synthesis said.
              wf = createWorkflow(dir, verb);
              let r = launch(dir, wf, verb, type, `${type}-gone`, gone);
              r = runBlock(shell, dir, await finalize(verb, { runDir: await dispatched(r) }), vars);
              strictEqual(r.status, 0, r.stderr);
              let got = await results(wf);
              deepStrictEqual(got.results.map((e) => [e.run_id, e.verdict]), [[`${type}-gone`, 'failed']]);
              deepStrictEqual([got.pending.length, got.fm.current_phase], [0, 'summary-complete']);
              archive(dir, wf);

              // Never launched: no result, the verb still finishes; a review
              // records its attempt skipped, reason unspecified, as
              // NO_RUN_REASON was left empty (C163 A1a).
              wf = createWorkflow(dir, verb);
              r = runBlock(shell, dir, await finalize(verb), vars);
              strictEqual(r.status, 0, r.stderr);
              got = await results(wf);
              deepStrictEqual([got.results.length, got.pending.length, got.fm.current_phase], [0, 0, 'summary-complete']);
              const attempts = got.fm.review_attempts === undefined ? [] : JSON.parse(got.fm.review_attempts).attempts;
              deepStrictEqual(attempts.map((a) => [a.type, a.outcome, a.reason]), isReview ? [[type, 'skipped', 'unspecified']] : []);
              archive(dir, wf);

              // Never launched because no peer was found: the block, with
              // NO_RUN_REASON filled, records a review's attempt unavailable
              // with that reason (C163 A1a).
              wf = createWorkflow(dir, verb);
              const unavailable = (await finalize(verb)).replace("NO_RUN_REASON=''", () => "NO_RUN_REASON='peer-unavailable'");
              ok(unavailable.includes("NO_RUN_REASON='peer-unavailable'"), 'the block takes the reason');
              r = runBlock(shell, dir, unavailable, vars);
              strictEqual(r.status, 0, r.stderr);
              got = await results(wf);
              deepStrictEqual([got.results.length, got.pending.length, got.fm.current_phase], [0, 0, 'summary-complete']);
              const noPeer = got.fm.review_attempts === undefined ? [] : JSON.parse(got.fm.review_attempts).attempts;
              deepStrictEqual(noPeer.map((a) => [a.type, a.outcome, a.reason, a.tree_reason]), isReview ? [[type, 'unavailable', 'peer-unavailable', 'no-launch']] : []);
              // A later review of the same verb in this workflow that never
              // launched either, finalized from a text directory of its own:
              // an attempt of its own, never merged into the first.
              const later = (await finalize(verb)).replace("NO_RUN_REASON=''", () => "NO_RUN_REASON='local-only'");
              ok(later.includes("NO_RUN_REASON='local-only'"), 'the block takes the reason');
              r = runBlock(shell, dir, later, vars);
              strictEqual(r.status, 0, r.stderr);
              got = await results(wf);
              const twice = got.fm.review_attempts === undefined ? [] : JSON.parse(got.fm.review_attempts).attempts;
              deepStrictEqual(twice.map((a) => [a.type, a.outcome, a.reason]), isReview ? [[type, 'unavailable', 'peer-unavailable'], [type, 'skipped', 'local-only']] : []);
              archive(dir, wf);

              // A critique whose dispatch would have run adversarial-scan
              // (engineer's full-codebase, founder's red-team): the block's
              // ATTEMPT_TYPE, set as the dispatch's ENSEMBLE_TYPE was, names
              // the type of the review that never launched.
              if (verb === 'critique') {
                wf = createWorkflow(dir, verb);
                // A type the runner would refuse (a capital, a leading
                // hyphen) stops the block before any write.
                for (const bad of ['Review', '-review']) {
                  const before = await readFile(wf, 'utf8');
                  const refused = runBlock(shell, dir, (await finalize(verb)).replace("NO_RUN_REASON=''", () => "NO_RUN_REASON='peer-unavailable'").replace("ATTEMPT_TYPE='review'", () => `ATTEMPT_TYPE='${bad}'`), vars);
                  strictEqual(refused.status, 1, bad);
                  ok(refused.stderr.includes('ATTEMPT_TYPE is not an ensemble type'), refused.stderr);
                  strictEqual(await readFile(wf, 'utf8'), before, `${bad}: nothing written`);
                }
                const adversarial = (await finalize(verb)).replace("NO_RUN_REASON=''", () => "NO_RUN_REASON='peer-unavailable'").replace("ATTEMPT_TYPE='review'", () => "ATTEMPT_TYPE='adversarial-scan'");
                ok(adversarial.includes("ATTEMPT_TYPE='adversarial-scan'"), 'the block takes the type');
                r = runBlock(shell, dir, adversarial, vars);
                strictEqual(r.status, 0, r.stderr);
                got = await results(wf);
                deepStrictEqual(JSON.parse(got.fm.review_attempts).attempts.map((a) => [a.type, a.outcome, a.reason]), [['adversarial-scan', 'unavailable', 'peer-unavailable']]);
                archive(dir, wf);
              }

              if (convergent(verb)) {
                // Not converged: settled, then an append with the step that
                // resolves what is open; the workflow stays open, an earlier
                // verb's terminal marker turned off.
                wf = createWorkflow(dir, verb);
                state('set-terminal', '--workflow-path', wf, '--host', 'claude', '--terminal-phase', 'summary-complete', '--terminal-marker', 'true');
                r = runBlock(shell, dir, await finalize(verb, { converged: false, nextAction: 'Paused: the flagged item; refine resolves it' }), vars);
                strictEqual(r.status, 0, r.stderr);
                ok(r.stderr.includes('PAUSED (not converged)'), r.stderr);
                got = await results(wf);
                deepStrictEqual([got.fm.current_phase, got.fm.terminal_marker === true, got.fm.next_step_kind, got.fm.next_step_verb, got.fm.next_action],
                  ['phase-2-presented', false, 'verb', 'refine', 'Paused: the flagged item; refine resolves it']);
                archive(dir, wf);
              }

              // R4 H1: an empty DISPATCH_DIR while a launched run is pending (a
              // local-only synthesis, say) is the empty id, never that run:
              // settle refuses it, and nothing is written.
              wf = createWorkflow(dir, verb);
              const hidden = launch(dir, wf, verb, type, `${type}-hidden`, ok_);
              strictEqual(hidden.status, 0);
              const hiddenDir = await dispatched(hidden);
              const unread = await readFile(wf, 'utf8');
              r = runBlock(shell, dir, await finalize(verb), vars);
              strictEqual(r.status, 1, r.stderr);
              ok(r.stderr.includes(`${type}-hidden`), `settle names the run it would hide: ${r.stderr}`);
              strictEqual(await readFile(wf, 'utf8'), unread, 'no run launched beside a pending run: nothing was written');
              // R4 J1: the dispatch's directory gone, the run's own ledger
              // directory names it: the block settles that run, bound to this
              // workflow by its handle, then finishes the verb.
              const ledgerOf = (id) => join(dir, P.stateDirRel, 'peer-runs', id);
              r = runBlock(shell, dir, await finalize(verb, { runDir: ledgerOf(`${type}-hidden`) }), vars);
              strictEqual(r.status, 0, r.stderr);
              got = await results(wf);
              deepStrictEqual([got.results.map((e) => [e.run_id, e.verdict]), got.pending.length, got.fm.current_phase], [[[`${type}-hidden`, 'agreed']], 0, 'summary-complete']);
              archive(dir, wf);

              // R4: a run of another workflow (the branch's workflow changed
              // after the dispatch) is refused before any write to this one.
              const other = createWorkflow(dir, verb);
              const before = await readFile(other, 'utf8');
              r = runBlock(shell, dir, await finalize(verb, { runDir: hiddenDir }), vars);
              strictEqual(r.status, 1, r.stderr);
              ok(r.stderr.includes('its handle names another workflow'), r.stderr);
              strictEqual(await readFile(other, 'utf8'), before, 'nothing was written');
              // R4 J1, the peer's repro: A's run (archived with its workflow)
              // named by its ledger directory on B, whose own run of this phase
              // is pending: refused, B's workflow untouched and its run still
              // pending.
              strictEqual(launch(dir, other, verb, type, `${type}-b`, ok_).status, 0);
              const pendingB = await readFile(other, 'utf8');
              r = runBlock(shell, dir, await finalize(verb, { runDir: ledgerOf(`${type}-hidden`) }), vars);
              strictEqual(r.status, 1, r.stderr);
              ok(r.stderr.includes('its handle names another workflow'), r.stderr);
              strictEqual(await readFile(other, 'utf8'), pendingB, "A's ledger on B: nothing was written");
              // The peer's repro exactly: `gone` on B while B's one run of this
              // phase is pending (the run a pending-row fallback would settle
              // with A's summary) is refused, and B is untouched.
              r = runBlock(shell, dir, await finalize(verb, { runDir: 'gone' }), vars);
              strictEqual(r.status, 1, r.stderr);
              ok(r.stderr.includes("set it to the run's ledger directory"), r.stderr);
              strictEqual(await readFile(other, 'utf8'), pendingB, 'gone on B, its one run pending: nothing was written');

              // R4 G1: a run of this workflow but another phase (a dispatch
              // directory from an earlier verb) is refused by settle, the
              // block's first write, so neither the note nor the phase moves.
              const elsewhere = verb === 'compose' ? 'critique' : 'compose';
              r = launch(dir, other, elsewhere, type, `${type}-elsewhere`, ok_);
              strictEqual(r.status, 0, r.stderr);
              const elsewhereDir = await dispatched(r);
              const unmoved = await readFile(other, 'utf8');
              r = runBlock(shell, dir, await finalize(verb, { runDir: elsewhereDir }), vars);
              strictEqual(r.status, 1, r.stderr);
              ok(r.stderr.includes(`is phase ${elsewhere}, not ${verb}`), r.stderr);
              strictEqual(await readFile(other, 'utf8'), unmoved, 'another phase: nothing was written');

              // R4 J1: two runs pending for this phase. `gone` names no run
              // and is refused before any write; each run's ledger directory
              // settles that run only, never the other pending one.
              strictEqual(launch(dir, other, verb, type, `${type}-a`, ok_).status, 0);
              const held = await readFile(other, 'utf8');
              r = runBlock(shell, dir, await finalize(verb, { runDir: 'gone' }), vars);
              strictEqual(r.status, 1, r.stderr);
              ok(r.stderr.includes("set it to the run's ledger directory"), r.stderr);
              strictEqual(await readFile(other, 'utf8'), held, 'gone: nothing was written');
              r = runBlock(shell, dir, await finalize(verb, { runDir: ledgerOf(`${type}-a`) }), vars);
              strictEqual(r.status, 0, r.stderr);
              got = await results(other);
              deepStrictEqual([got.results.map((e) => [e.run_id, e.verdict]), got.pending.filter((e) => e.phase === verb).map((e) => e.run_id)], [[[`${type}-a`, 'agreed']], [`${type}-b`]]);
            });
          } finally {
            await rm(ok_, { recursive: true, force: true });
            await rm(gone, { recursive: true, force: true });
          }
        });

        // ADR-0059's amendment of 2026-10-10: the note, the summary and the
        // next action are the agent's text; through the real scripts they
        // reach the workflow as written, and a shell never reads a line.
        it(`${verb}'s finalize: the note, the summary and the next action the agent wrote reach the workflow as written, nothing in them runs, and a file left unwritten or blank stops the block before any write`, skip(verb), async () => {
          const ok_ = await stubCompanions();
          try {
            await withRepo(async (dir) => {
              const { type } = verbBlocks(verb);
              const wf = createWorkflow(dir, verb);
              const run = launch(dir, wf, verb, type, `${type}-hostile`, ok_);
              strictEqual(run.status, 0);
              const summary = '--agreed: "A" $(touch pwned) `touch pwned2` it\'s done';
              const nextAction = `Next: "${verb}" $(touch pwned) or \`touch pwned2\`, it's next`;
              const r = runBlock(shell, dir, await finalize(verb, { note: HOSTILE, summary, nextAction, runDir: await dispatched(run) }), {});
              strictEqual(r.status, 0, r.stderr);
              const { frontmatter: fm, body } = await readWorkflow(wf);
              ok(body.includes(HOSTILE), `the note, as written: ${body}`);
              deepStrictEqual([fm.next_action, (fm.ensemble_results ?? []).map((e) => [e.verdict, e.summary])], [nextAction, [['agreed', summary]]]);
              for (const side of ['pwned', 'pwned2', 'injected']) strictEqual(spawnSync('test', ['-e', join(dir, side)]).status, 1, `${side}: nothing in the texts ran`);
              archive(dir, wf);
              // Each file left unwritten, holding only the newline that the
              // scripts remove (so they refuse it as empty), or a BOM and that
              // newline (which settle trims to nothing), in turn: the block
              // stops before any write — settle no longer refuses after the
              // append has written the note.
              for (const name of ['note.md', 'summary.txt', 'next-action.txt']) {
                for (const [how, content] of [['left unwritten', null], ['holding a newline only', ''], ['holding a BOM and a newline', '﻿']]) {
                  const w = createWorkflow(dir, verb);
                  const before = await readFile(w, 'utf8');
                  let b = filled(verbBlocks(verb).phase2);
                  if (convergent(verb)) b = fill(b.replace(/CONVERGED="<yes\|no[^"\n]*>"/, 'CONVERGED="yes"'), RESOLVE_LINE, "RESOLVE_VERB='refine'");
                  const files = { 'note.md': 'n', 'summary.txt': 's', 'next-action.txt': 'a' };
                  if (content === null) delete files[name];
                  else files[name] = content;
                  const left = runBlock(shell, dir, await withTexts(b, files), {});
                  strictEqual(left.status, 1, `${name} ${how}: ${left.stderr}`);
                  ok(left.stderr.includes(`${name} in TEXT_DIR (`) && left.stderr.includes('is missing, blank or not UTF-8 text'), left.stderr);
                  strictEqual(await readFile(w, 'utf8'), before, `${name} ${how}: nothing was written`);
                  archive(dir, w);
                }
              }
            });
          } finally {
            await rm(ok_, { recursive: true, force: true });
          }
        });
      }

      // R4 J1, J2, J4, a retry with the real scripts: a conflict finalize
      // naming the run by its ledger directory, whose consensus-task
      // failed, stops before the phase note; run again with the same
      // TEXT_DIR, it settles nothing more, appends the note once and
      // records the gate for that run. Decide's, whose gate is
      // decide-conflict (critique's peer-conflict is the case below).
      it('decide\'s finalize: with the dispatch directory gone, a conflict named by its ledger directory whose consensus-task failed stops before the note; run again with the same TEXT_DIR, it appends the note once and records the gate for that run (R4 J1, J2, J4)', skip('decide'), async () => {
        const verb = 'decide';
        ok(docs[verb].includes('scripts/state.mjs" consensus-task'), 'decide\'s finalize runs consensus-task');
        const ok_ = await stubCompanions();
        try {
          await withRepo(async (dir) => {
            const { type, phase2 } = verbBlocks(verb);
            const vars = { ACTIVE: '/w/stale.md', RUN_ID: 'stale', VERDICT: 'stale' };
            const wf = createWorkflow(dir, verb);
            const id = `${type}-kept`;
            strictEqual(launch(dir, wf, verb, type, id, ok_).status, 0);
            let b = filled(phase2, join(dir, P.stateDirRel, 'peer-runs', id), 'conflict');
            b = await withTexts(b, { 'note.md': '### Ensemble synthesis: fixture-J4', 'summary.txt': 'split', 'next-action.txt': 'Owner: weigh C1', 'contested.md': 'C1: keep A or B' });
            const notes = async () => (await readFile(wf, 'utf8')).split('### Ensemble synthesis: fixture-J4').length - 1;
            // consensus-task cannot write its task file: a file stands where
            // its directory goes.
            const home = join(dir, P.stateDirRel, 'consensus');
            await writeFile(home, 'in the way\n');
            let r = runBlock(shell, dir, b, vars);
            ok(r.status !== 0, `the first run stops at consensus-task: ${r.stderr}`);
            let fm = (await readWorkflow(wf)).frontmatter;
            deepStrictEqual([(fm.ensemble_results ?? []).map((e) => [e.run_id, e.verdict]), (fm.pending_ensemble ?? []).length, fm.awaiting_owner_gate],
              [[[id, 'conflict']], 0, undefined], 'settled, the pending entry gone, no gate');
            strictEqual(await notes(), 0, 'no phase note before the task file');
            ok(r.stderr.includes('the phase note and the gate were not recorded. Run this block again with the same TEXT_DIR and DISPATCH_DIR'), r.stderr);
            await rm(home);
            r = runBlock(shell, dir, b, vars);
            strictEqual(r.status, 0, r.stderr);
            strictEqual(await notes(), 1, 'the retry appends the note once');
            fm = (await readWorkflow(wf)).frontmatter;
            deepStrictEqual([fm.awaiting_owner_gate, fm.awaiting_owner_run_id, fm.next_step_kind, (fm.ensemble_results ?? []).length],
              ['decide-conflict', id, 'owner-decision', 1]);
          });
        } finally {
          await rm(ok_, { recursive: true, force: true });
        }
      });

      // R4 K2, L1, L2, the bypasses the owner's J2 ruling closes, with the
      // real scripts: a conflict a finalize settled, its consensus-task
      // failed, cannot be finished without its gate by a retry with another
      // verdict, no run named (the empty id), the run itself, or a later run
      // finalized as a conflict (L1); the workflow is left as it was. The
      // route the message names, the conflict finalized from a fresh
      // TEXT_DIR, records the gate; while it is pending, the later run
      // cannot close the verb beside it (L2); once the owner clears it (its
      // task file retired), the later run finishes the phase. Critique's,
      // whose gate is peer-conflict.
      it('critique\'s finalize: a recorded conflict whose gate was never set stops a finalize with another verdict, the empty id included, and a later run as a conflict, before any write; finalized as a conflict it records the gate, which holds a later run until the owner clears it, and then the phase finishes (R4 K2, L1, L2)', skip('critique'), async () => {
        const verb = 'critique';
        ok(docs[verb].includes('scripts/state.mjs" consensus-task'), 'critique\'s finalize runs consensus-task');
        const ok_ = await stubCompanions();
        try {
          await withRepo(async (dir) => {
            const { type, phase2 } = verbBlocks(verb);
            const gate = 'peer-conflict';
            const vars = { ACTIVE: '/w/stale.md', RUN_ID: 'stale', VERDICT: 'stale' };
            const wf = createWorkflow(dir, verb);
            const id = `${type}-k2`;
            strictEqual(launch(dir, wf, verb, type, id, ok_).status, 0);
            const ledger = join(dir, P.stateDirRel, 'peer-runs', id);
            const texts = { 'note.md': '### Ensemble synthesis: fixture-K2', 'summary.txt': 'split', 'next-action.txt': 'Owner: weigh C1', 'contested.md': 'C1: keep A or B' };
            // consensus-task cannot write its task file: a file stands where
            // its directory goes.
            const home = join(dir, P.stateDirRel, 'consensus');
            await writeFile(home, 'in the way\n');
            let r = runBlock(shell, dir, await withTexts(filled(phase2, ledger, 'conflict'), texts), vars);
            ok(r.status !== 0, `the first run stops at consensus-task: ${r.stderr}`);
            await rm(home);
            // A later run of the phase, launched beside the conflict.
            const later = `${type}-k2-later`;
            strictEqual(launch(dir, wf, verb, type, later, ok_).status, 0);
            const laterLedger = join(dir, P.stateDirRel, 'peer-runs', later);
            let held = await readFile(wf, 'utf8');
            for (const [why, runDir, verdict] of [['no run named, agreed', '', 'agreed'], ['no run named, concerns', '', 'concerns'], ['the run itself, agreed', ledger, 'agreed'], ['a later run as a conflict', laterLedger, 'conflict']]) {
              r = runBlock(shell, dir, await withTexts(filled(phase2, runDir, verdict), { ...texts, 'note.md': '### Ensemble synthesis: bypass' }), vars);
              strictEqual(r.status, 1, `${why}: ${r.stderr}`);
              ok(r.stderr.includes(`✗ Run ${id} is recorded in this phase with the verdict conflict, and no owner ruling names it`), `${why}: ${r.stderr}`);
              strictEqual(await readFile(wf, 'utf8'), held, `${why}: the workflow is left as it was`);
            }
            r = runBlock(shell, dir, await withTexts(filled(phase2, ledger, 'conflict'), texts), vars);
            strictEqual(r.status, 0, r.stderr);
            let fm = (await readWorkflow(wf)).frontmatter;
            deepStrictEqual([fm.awaiting_owner_gate, fm.awaiting_owner_run_id], [gate, id], 'the route the message names records the gate');
            // L2: beside the pending gate, the later run cannot close the verb.
            held = await readFile(wf, 'utf8');
            r = runBlock(shell, dir, await withTexts(filled(phase2, laterLedger, 'agreed'), { ...texts, 'note.md': '### Ensemble synthesis: beside the gate' }), vars);
            strictEqual(r.status, 1, `a later run beside the gate: ${r.stderr}`);
            ok(r.stderr.includes(`✗ This verb's conflict gate is pending for run ${id}: until the owner rules on it`), r.stderr);
            strictEqual(await readFile(wf, 'utf8'), held, 'beside the gate: the workflow is left as it was');
            state('awaiting-owner-clear', '--workflow-path', wf, '--host', 'claude', '--gate', gate, '--resolution', 'Owner decision: keep A');
            r = runBlock(shell, dir, await withTexts(filled(phase2, laterLedger, 'agreed'), { ...texts, 'note.md': '### Ensemble synthesis: after the ruling' }), vars);
            strictEqual(r.status, 0, `cleared, the phase finishes: ${r.stderr}`);
            fm = (await readWorkflow(wf)).frontmatter;
            deepStrictEqual([(fm.ensemble_results ?? []).map((e) => [e.run_id, e.verdict]), fm.awaiting_owner_gate], [[[id, 'conflict'], [later, 'agreed']], undefined]);
          });
        } finally {
          await rm(ok_, { recursive: true, force: true });
        }
      });

      it('decide\'s Owner selection stops at a refused clear, writing no selection; it records the choice with its next step, and inside a start lifecycle clears the gate and stops (round-2 #7, PC3b U1)', skip('decide'), async () => {
        await withRepo(async (dir) => {
          // The generated block reads the owner's words from the file the agent
          // wrote (ADR-0059's amendment of 2026-10-10), as it read a quoted
          // heredoc before (PC3 U7).
          const raw = gateOpDir(writing(section(docs.decide, '## Owner selection (decide-conflict)'))[0]);
          // Contract: the owner's words reach state.mjs as a file, never as shell text, where `$`,
          // backticks and a delimiter-like line in them would run.
          ok(raw.startsWith(`${TEXT_DIR_LINE}\n`) && raw.includes('--resolution-file "$TEXT_DIR/resolution.txt"') && !raw.includes('OWNER_RESOLUTION'), 'the resolution is the agent\'s file');
          const words = `Owner selection: option A, the $simplest \`one\`\nOWNER_RESOLUTION\ntouch injected`;
          const block = await withTexts(raw, { 'resolution.txt': words });
          const wf = createWorkflow(dir, 'decide');
          state('awaiting-owner-set', '--workflow-path', wf, '--host', 'claude', '--gate', 'scope-routing', '--anchor', 'routing-recommendation');
          const before = await readFile(wf, 'utf8');
          // No ACTIVE is passed in: the block resolves the workflow itself (round-3 F2).
          let r = runBlock(shell, dir, block);
          ok(r.status !== 0, 'the clear refuses a different gate and the block stops');
          strictEqual(await readFile(wf, 'utf8'), before);
          // With the right gate it records the choice and ends terminal.
          state('awaiting-owner-clear', '--workflow-path', wf, '--host', 'claude', '--gate', 'scope-routing');
          state('finish-verb', '--workflow-path', wf, '--host', 'claude', '--next-action', 'Owner: choose a direction', '--next-step-kind', 'owner-decision',
            '--next-step-confidence', 'MEDIUM', '--owner-gate', 'decide-conflict', '--owner-gate-anchor', 'ensemble-synthesis');
          r = runBlock(shell, dir, block);
          strictEqual(r.status, 0, r.stderr);
          const { frontmatter: fm, body } = await readWorkflow(wf);
          deepStrictEqual([fm.awaiting_owner_gate, fm.next_step_kind, fm.next_step_verb, fm.next_action, fm.current_phase, fm.terminal_marker],
            [undefined, 'verb', 'compose', P.declaration.verbs.decide.next_action, 'summary-complete', true]);
          ok(body.includes(`\n\n${words}`) && /### Owner gate resolved: decide-conflict at [^\n]+\n\nOwner selection: option A, the \$simplest `one`\nOWNER_RESOLUTION\ntouch injected/.test(body), 'the decision sits in the resolved note as written (round-3 F1)');
          strictEqual(spawnSync('test', ['-e', join(dir, 'injected')]).status, 1, 'nothing in the decision ran');
          archive(dir, wf);

          // Inside a /<persona>:start lifecycle the block clears the gate and
          // stops: the lifecycle owns its phase order (PC3b U1, PC3 step-7
          // peer findings 2 and 3), so the clear records no next step and
          // replaces the gate's "Owner: …" next action, and the lifecycle
          // makes its one terminal write.
          // ADR-0059 Decision 10 — the recorded choice released its directory;
          // the next resolution writes into a new one.
          strictEqual(existsSync(/^TEXT_DIR='([^']*)'/.exec(block)[1]), false, 'the resolution directory is released');
          const sw = createWorkflow(dir, 'investigate', { type: 'start' });
          state('finish-verb', '--workflow-path', sw, '--host', 'claude', '--next-action', 'Owner: choose a direction', '--next-step-kind', 'owner-decision',
            '--next-step-confidence', 'MEDIUM', '--owner-gate', 'decide-conflict', '--owner-gate-anchor', 'ensemble-synthesis');
          r = runBlock(shell, dir, await withTexts(raw, { 'resolution.txt': words }));
          strictEqual(r.status, 0, r.stderr);
          ok(r.stderr.includes(`Resume the lifecycle with /${persona}:start`), r.stderr);
          const s = (await readWorkflow(sw)).frontmatter;
          deepStrictEqual([s.awaiting_owner_gate, s.next_step_kind, s.next_step_verb, s.next_action, s.current_phase === 'summary-complete', s.terminal_marker === true],
            [undefined, undefined, undefined, `Resume /${persona}:start: the lifecycle continues after decide with the selected direction`, false, false]);
        });
      });

      it('refine\'s Owner decision: each block resolves the workflow itself and records the decision with the next step and its next action in one write; inside a start lifecycle each clears the gate and stops (PC3b U1)', skip('refine'), async () => {
        await withRepo(async (dir) => {
          // The generated blocks read the owner's resolution from the file the
          // agent wrote (ADR-0059's amendment of 2026-10-10), as they read a
          // quoted heredoc before (PC3 U7).
          const owner = async (block, words, files = {}) => {
            // Contract: the owner's words reach state.mjs as a file, never as shell text.
            ok(block.startsWith(`${TEXT_DIR_LINE}\n`) && block.includes('--resolution-file "$TEXT_DIR/resolution.txt"') && !block.includes('OWNER_RESOLUTION'), 'the resolution is the agent\'s file');
            return withTexts(block, { 'resolution.txt': words, ...files });
          };
          const [rawFix, rawDefer] = writing(section(docs.refine, '## Owner decision (recurring-finding)')).map(dedent).map(gateOpDir);
          // Each run takes a directory of its own: a resolution that succeeded
          // released the one it read (ADR-0059 Decision 10).
          const fixNowBlock = () => owner(rawFix, 'Owner decision: fix the cache key now');
          // A refine that closes only once it converged sets the convergence
          // in the Defer block; converged, the deferral ends the verb.
          const deferBlock = async () => {
            const deferWords = await owner(rawDefer, 'Owner decision: defer the cache key — tracked in C99');
            return convergent('refine') ? deferWords.replace(/CONVERGED="<yes\|no[^"\n]*>"/, 'CONVERGED="yes"') : deferWords;
          };
          const fixNow = await fixNowBlock();
          const defer = await deferBlock();
          // Contract: the Defer block's convergence step exists exactly where refine waits for it.
          ok(convergent('refine') === defer.includes('CONVERGED="yes"'), 'the convergence is set exactly where the verb waits for it');
          // The deferral's next action: the commit /<persona>:commit makes
          // (commit_surface on), or the owner's save and commit (off).
          const deferredAction = commitOn
            ? 'Commit the refined change; the recurring finding is deferred'
            : 'The recurring finding is deferred; the owner saves and commits the refined artifact';

          const wf = createWorkflow(dir, 'refine');
          const gate = (path) => state('finish-verb', '--workflow-path', path, '--host', 'claude', '--next-action', 'Owner: fix or defer', '--next-step-kind', 'owner-decision',
            '--next-step-confidence', 'HIGH', '--owner-gate', 'recurring-finding', '--owner-gate-anchor', 'recurring-finding');
          gate(wf);
          let r = runBlock(shell, dir, fixNow);
          strictEqual(r.status, 0, r.stderr);
          strictEqual(existsSync(/^TEXT_DIR='([^']*)'/.exec(fixNow)[1]), false, 'Fix now released the resolution directory');
          let fm = (await readWorkflow(wf)).frontmatter;
          deepStrictEqual([fm.awaiting_owner_gate, fm.next_step_kind, fm.next_step_verb, fm.next_action], [undefined, 'verb', 'refine', 'Fix the recurring finding in this refine, then re-critique']);
          gate(wf);
          r = runBlock(shell, dir, defer);
          strictEqual(r.status, 0, r.stderr);
          const read = await readWorkflow(wf);
          fm = read.frontmatter;
          deepStrictEqual([fm.awaiting_owner_gate, fm.next_step_kind, fm.next_action, fm.current_phase, fm.terminal_marker], [undefined, 'commit', deferredAction, 'summary-complete', true]);
          ok(/### Owner gate resolved: recurring-finding at [^\n]+\n\nOwner decision: defer the cache key — tracked in C99/.test(read.body), read.body);
          archive(dir, wf);

          if (convergent('refine')) {
            // Not converged with the finding deferred: the gate is cleared
            // with the step that resolves what is open, and no terminal write.
            const w2 = createWorkflow(dir, 'refine');
            gate(w2);
            let open = (await owner(rawDefer, 'Owner decision: defer the cache key — tracked in C99', { 'next-action.txt': 'Re-critique the deferred finding' })).replace(/CONVERGED="<yes\|no[^"\n]*>"/, 'CONVERGED="no"');
            open = fill(open, '"<refine|decide|investigate>"', 'refine');
            open = fill(open, '"<HIGH|MEDIUM|LOW>"', 'HIGH');
            r = runBlock(shell, dir, open);
            strictEqual(r.status, 0, r.stderr);
            ok(r.stderr.includes('PAUSED (not converged)'), r.stderr);
            fm = (await readWorkflow(w2)).frontmatter;
            deepStrictEqual([fm.awaiting_owner_gate, fm.next_step_kind, fm.next_step_verb, fm.next_action, fm.current_phase === 'summary-complete', fm.terminal_marker === true],
              [undefined, 'verb', 'refine', 'Re-critique the deferred finding', false, false]);
            archive(dir, w2);
          }

          // Inside a /<persona>:start lifecycle the Defer block clears the
          // gate and stops: the lifecycle makes its one terminal write (PC3 U7).
          const sw = createWorkflow(dir, 'investigate', { type: 'start' });
          gate(sw);
          r = runBlock(shell, dir, await deferBlock());
          strictEqual(r.status, 0, r.stderr);
          ok(r.stderr.includes(`Resume the lifecycle with /${persona}:start`), r.stderr);
          const s = (await readWorkflow(sw)).frontmatter;
          deepStrictEqual([s.awaiting_owner_gate, s.next_step_kind, s.next_action, s.current_phase === 'summary-complete', s.terminal_marker === true],
            [undefined, 'commit', `Resume /${persona}:start: the finding is deferred, and the lifecycle continues at its terminal step`, false, false]);

          // PC3b U1 (PC3 step-7 peer finding 1): Fix now inside the lifecycle
          // clears the gate and stops: this refine's own phases, whose
          // finalize is a terminal write, do not run before the lifecycle's
          // terminal step.
          archive(dir, sw);
          const sf = createWorkflow(dir, 'refine', { type: 'start' });
          gate(sf);
          r = runBlock(shell, dir, await fixNowBlock());
          strictEqual(r.status, 0, r.stderr);
          ok(r.stderr.includes(`Resume the lifecycle with /${persona}:start`), r.stderr);
          const sfm = (await readWorkflow(sf)).frontmatter;
          deepStrictEqual([sfm.awaiting_owner_gate, sfm.next_step_kind, sfm.next_step_verb, sfm.next_action, sfm.current_phase === 'summary-complete', sfm.terminal_marker === true],
            [undefined, 'verb', 'refine', `Resume /${persona}:start: its refine phase fixes the recurring finding`, false, false]);
        });
      });
    });
  }
}
