// PC2a2 T0 and PC2a3 T0': founder and designer's verb runbooks characterized
// before their shell blocks become generated regions — compose, decide, frame
// and investigate (PC2a2), critique, refine and start (PC2a3, recorded before
// their regions). PC3 U7: engineer's seven, recorded before its verb runbooks
// join the regions; until they do, engineer's authored finalize commits the
// ensemble with ensemble-commit and closes with finish-verb, and its start
// runs the Phase 7 commit driver.
//
// fixtures/verb-runbooks.json records, per runbook, the ordered script calls
// with their argument values by flag (read as the shell reads them, so a
// quoting change alone is not a difference), the guards, the run-id prefix,
// the prompt-file template and the phase-note scaffold. The runbooks must keep
// doing exactly that; a change a region makes on purpose is listed in the
// fixture's allowed_differences, never absorbed by rewriting the fixture.
//
// The identity checks compare with the fixture's expected ensemble types,
// which are written there by hand — not read from the manifest or the
// declarations a region renders from — so a wrong manifest value fails here.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert/strict';

import { FIXTURE, STRUCTURAL_OPS, VERB_RUNBOOK_PERSONAS, VERB_RUNBOOK_VERBS, applyDifference, characterize, expectedFor, runbookText } from './_verb-runbooks.mjs';

const arg = (call, flag) => {
  const found = call.args.filter(([f]) => f === flag);
  strictEqual(found.length, 1, `${call.script} ${call.sub} carries ${flag} once`);
  return found[0][1];
};

describe('verb runbook characterization (PC2a2 T0)', () => {
  it('the fixture covers the twenty-one runbooks; every allowed difference is a listed, reasoned change to a known runbook', () => {
    const keys = VERB_RUNBOOK_PERSONAS.flatMap((p) => VERB_RUNBOOK_VERBS.map((v) => `${p}/${v}`)).sort();
    deepStrictEqual(Object.keys(FIXTURE.runbooks).sort(), keys);
    ok(Array.isArray(FIXTURE.allowed_differences));
    for (const d of FIXTURE.allowed_differences) {
      const structural = Object.hasOwn(d, 'op');
      deepStrictEqual(Object.keys(d).sort(), structural ? ['from', 'op', 'runbooks', 'to', 'where', 'why'] : ['from', 'runbooks', 'to', 'where', 'why'], JSON.stringify(d));
      ok(d.runbooks.length > 0 && d.runbooks.every((k) => keys.includes(k)), `${d.where}: runbooks`);
      // ADR-0067-WP: the worktree-first start (ADR-0067 Decision 8, item 3).
      ok(/^(?:PC2(?:a[234]|b)|PC3b?|ADR-0067-WP) /.test(d.why), `${d.where}: a change with its reason`);
      if (structural) ok(STRUCTURAL_OPS.includes(d.op), `${d.where}: a known op`);
      else ok(typeof d.from === 'string' && typeof d.to === 'string' && d.from !== d.to && d.from.length > 0, `${d.where}: a string change`);
    }
  });

  // PC2b RV7: the structural changes, each refusing a value it does not find
  // as recorded.
  describe('structural allowed differences (PC2b RV7)', () => {
    const call = (script, sub, args = []) => ({ script, sub, args });
    const record = () => ({
      calls: [
        call('state.mjs', 'find-active', [['--repo-root', '$REPO_ROOT']]),
        call('state.mjs', 'create', [['--verb', 'compose']]),
        call('state.mjs', 'append', [['--workflow-path', '$ACTIVE'], ['--current-phase', 'phase-0-resume'], ['--event', 'resumed']]),
        call('state.mjs', 'append', [['--workflow-path', '$ACTIVE'], ['--phase-note', '$NOTE']]),
        call('state.mjs', 'set-terminal', [['--workflow-path', '$ACTIVE'], ['--next-action', 'Critique']]),
      ],
      guards: { ensemble_launched: 'if [ -n "${RUN_ID:-}" ]; then\n  commit\nfi', converged: null },
      note: 'x',
    });
    const preflight = call('state.mjs', 'autopilot-preflight', [['--workflow-path', '$ACTIVE'], ['--persona', '{persona}']]);
    const apply = (d, r = record()) => { applyDifference(r, { runbooks: [], why: 'PC2b test', ...d }, 'founder'); return r; };

    it('insert-call puts the call right after its anchor, between the two calls it names', () => {
      const r = apply({ op: 'insert-call', where: 'call:state.mjs find-active', from: 'state.mjs create', to: preflight });
      deepStrictEqual(r.calls.map((c) => c.sub), ['find-active', 'autopilot-preflight', 'create', 'append', 'append', 'set-terminal']);
      deepStrictEqual(r.calls[1].args[1], ['--persona', 'founder'], '{persona} is substituted inside the call');
      const atEnd = apply({ op: 'insert-call', where: 'call:state.mjs set-terminal', from: '', to: preflight });
      strictEqual(atEnd.calls.at(-1).sub, 'autopilot-preflight');
      const second = apply({ op: 'insert-call', where: 'call:state.mjs append#1', from: 'state.mjs append', to: preflight });
      deepStrictEqual(second.calls.map((c) => c.sub).slice(2, 5), ['append', 'autopilot-preflight', 'append']);
    });

    it('insert-call refuses a neighbor that is not the recorded one, a missing anchor and an ambiguous one', () => {
      throws(() => apply({ op: 'insert-call', where: 'call:state.mjs find-active', from: 'state.mjs append', to: preflight }), /finds "state\.mjs append" after it/);
      throws(() => apply({ op: 'insert-call', where: 'call:state.mjs find-active', from: '', to: preflight }), /after it/);
      throws(() => apply({ op: 'insert-call', where: 'call:state.mjs read', from: '', to: preflight }), /one such call/);
      throws(() => apply({ op: 'insert-call', where: 'call:state.mjs append', from: 'state.mjs append', to: preflight }), /one such call/);
    });

    it('add-flag puts the flag right after the one it names, and refuses a flag already carried or a missing anchor flag', () => {
      const r = apply({ op: 'add-flag', where: 'call:state.mjs append#1:--clear-next-step', from: '--current-phase', to: 'true' });
      deepStrictEqual(r.calls[2].args, [['--workflow-path', '$ACTIVE'], ['--current-phase', 'phase-0-resume'], ['--clear-next-step', 'true'], ['--event', 'resumed']]);
      deepStrictEqual(r.calls[3], record().calls[3], 'the other append is untouched');
      const bare = apply({ op: 'add-flag', where: 'call:state.mjs create:--dry-run', from: '--verb', to: null });
      deepStrictEqual(bare.calls[1].args.at(-1), ['--dry-run', null]);
      throws(() => apply({ op: 'add-flag', where: 'call:state.mjs append#1:--event', from: '--current-phase', to: 'x' }), /finds the flag absent/);
      throws(() => apply({ op: 'add-flag', where: 'call:state.mjs append#1:--clear-next-step', from: '--next-action', to: 'true' }), /finds --next-action once/);
    });

    it('replace-call swaps a call read exactly as recorded, and refuses any other reading', () => {
      const finish = call('state.mjs', 'finish-verb', [['--workflow-path', '$ACTIVE'], ['--next-action', 'Critique'], ['--next-step-kind', 'verb']]);
      const r = apply({ op: 'replace-call', where: 'call:state.mjs set-terminal', from: record().calls[4], to: finish });
      deepStrictEqual(r.calls[4], finish);
      strictEqual(r.calls.length, 5);
      const stale = { ...record().calls[4], args: [['--workflow-path', '$ACTIVE'], ['--next-action', 'Refine']] };
      throws(() => apply({ op: 'replace-call', where: 'call:state.mjs set-terminal', from: stale, to: finish }), /finds the call as recorded/);
      throws(() => apply({ op: 'replace-call', where: 'call:state.mjs set-terminal', from: { ...record().calls[4], sub: 'append' }, to: finish }), /finds the call as recorded/);
    });

    it('null-guard removes a guard whose whole text reads as recorded, and refuses a partial text or a guard already gone', () => {
      const r = apply({ op: 'null-guard', where: 'guards.ensemble_launched', from: record().guards.ensemble_launched, to: null });
      strictEqual(r.guards.ensemble_launched, null);
      throws(() => apply({ op: 'null-guard', where: 'guards.ensemble_launched', from: '  commit', to: null }), /finds the guard as recorded/);
      throws(() => apply({ op: 'null-guard', where: 'guards.converged', from: '', to: null }), /names no recorded guard/);
      throws(() => apply({ op: 'null-guard', where: 'guards.ensemble_launched', from: record().guards.ensemble_launched, to: '' }), /sets null/);
    });

    // PC3b U2: a call that moved into another block, and a guard a runbook
    // adopts from the shared template.
    it('remove-call drops a call read exactly as recorded, and refuses any other reading or a missing call', () => {
      const r = apply({ op: 'remove-call', where: 'call:state.mjs append#1', from: record().calls[2], to: null });
      deepStrictEqual(r.calls.map((c) => c.sub), ['find-active', 'create', 'append', 'set-terminal']);
      deepStrictEqual(r.calls[2], record().calls[3], 'the other append stays');
      throws(() => apply({ op: 'remove-call', where: 'call:state.mjs append#1', from: record().calls[3], to: null }), /finds the call as recorded/);
      throws(() => apply({ op: 'remove-call', where: 'call:state.mjs read', from: record().calls[2], to: null }), /one such call/);
      throws(() => apply({ op: 'remove-call', where: 'call:state.mjs create', from: record().calls[1], to: record().calls[1] }), /sets null/);
    });

    it('a call without a subcommand is named by its script alone, the n-th with #<n>', () => {
      const withArgs = () => ({ ...record(), calls: [call('start-args.mjs', null, [['--args-file', 'a']]), ...record().calls, call('start-args.mjs', null, [['--args-file', 'b']])] });
      const r = apply({ op: 'remove-call', where: 'call:start-args.mjs#2', from: withArgs().calls.at(-1), to: null }, withArgs());
      deepStrictEqual(r.calls.filter((c) => c.script === 'start-args.mjs').map((c) => c.args[0][1]), ['a']);
      strictEqual(apply({ where: 'call:start-args.mjs:--args-file', from: 'a', to: 'c' }, r).calls[0].args[0][1], 'c');
      throws(() => apply({ where: 'call:start-args.mjs:--args-file', from: 'a', to: 'c' }, withArgs()), /one such call/);
    });

    it('set-guard sets a guard the runbook did not have, and refuses one it has or an empty text', () => {
      const r = apply({ op: 'set-guard', where: 'guards.converged', from: null, to: 'if x; then\n  y\nfi' });
      strictEqual(r.guards.converged, 'if x; then\n  y\nfi');
      throws(() => apply({ op: 'set-guard', where: 'guards.ensemble_launched', from: null, to: 'x' }), /finds the guard absent/);
      throws(() => apply({ op: 'set-guard', where: 'guards.converged', from: 'x', to: 'y' }), /replaces null/);
      throws(() => apply({ op: 'set-guard', where: 'guards.converged', from: null, to: '' }), /sets a guard text/);
      throws(() => apply({ op: 'set-guard', where: 'guards.unknown', from: null, to: 'x' }), /names no recorded guard/);
    });

    it('an unknown op is refused; a string difference still needs its text exactly once', () => {
      throws(() => apply({ op: 'remove-everything', where: 'note', from: 'x', to: '' }), /unknown allowed-difference op/);
      strictEqual(apply({ where: 'call:state.mjs create:--verb', from: 'compose', to: 'frame' }).calls[1].args[0][1], 'frame');
      throws(() => apply({ where: 'call:state.mjs create:--verb', from: 'o', to: 'a' }), /finds "o" once/);
    });
  });

  // Contract: the agent running each runbook's blocks — the script calls, their arguments by
  // flag, their order and the guards' exits below are what it runs; a change to any is a change
  // to what runs.
  for (const persona of VERB_RUNBOOK_PERSONAS) {
    for (const verb of VERB_RUNBOOK_VERBS) {
      describe(`${persona}/${verb}`, () => {
        const got = characterize(runbookText(persona, verb));
        const calls = got.calls;
        const of = (script, sub) => calls.map((c, i) => [c, i]).filter(([c]) => c.script === script && c.sub === sub);

        it('does what the fixture recorded, with the listed changes: calls, argument values, guards, run-id prefix, prompt file, note scaffold', () => {
          deepStrictEqual(got, expectedFor(`${persona}/${verb}`));
        });

        it('identity: persona, verb, phase and ensemble type match the expected map', () => {
          const [[create]] = of('state.mjs', 'create');
          if (persona === 'engineer' && verb === 'start') {
            // engineer's lifecycle (commit_surface, PC3b U2) creates its start
            // workflow for itself in its first verb from the description its
            // args file holds, clears the next step on resume, and commits
            // through the Phase 7 driver: plan, then the approved execute.
            strictEqual(arg(create, '--persona'), 'engineer');
            deepStrictEqual([arg(create, '--verb'), arg(create, '--workflow-type'), arg(create, '--original-request')], ['investigate', 'start', '$FEATURE']);
            deepStrictEqual([of('peer-runner.mjs', 'run').length, of('state.mjs', 'ensemble-commit').length], [0, 0]);
            const [[resume]] = of('state.mjs', 'append');
            deepStrictEqual([arg(resume, '--workflow-path'), arg(resume, '--clear-next-step')], ['$ACTIVE', 'true']);
            deepStrictEqual(calls.filter((c) => c.script === 'start-args.mjs').map((c) => arg(c, '--args-file')), ['<directory from step 1>/args.json', '<directory from step 1>/args.json']);
            deepStrictEqual(calls.filter((c) => c.script === 'phase7-commit.mjs').map((c) => [arg(c, '--mode'), arg(c, '--workflow-path')]), [['plan', '$ACTIVE'], ['execute', '$ACTIVE']]);
            deepStrictEqual([got.run_id_prefixes, got.mktemp_templates], [[], []]);
            return;
          }
          strictEqual(arg(create, '--persona'), persona);
          if (verb === 'start') {
            // The lifecycle macro creates a start workflow in its first verb,
            // and dispatches through the verbs it sequences, not in its blocks.
            // Its first append is the resume's next-step clear (PC2b RV4); a
            // lifecycle that waits for convergence (designer) records a paused
            // next step with a second (U5c).
            strictEqual(arg(create, '--verb'), 'investigate');
            strictEqual(arg(create, '--workflow-type'), 'start');
            deepStrictEqual([of('peer-runner.mjs', 'run').length, of('state.mjs', 'ensemble-commit').length, of('state.mjs', 'append').length], [0, 0, persona === 'designer' ? 2 : 1]);
            const [[resume]] = of('state.mjs', 'append');
            deepStrictEqual([arg(resume, '--workflow-path'), arg(resume, '--clear-next-step')], ['$ACTIVE', 'true']);
            deepStrictEqual([got.run_id_prefixes, got.mktemp_templates], [[], []]);
            return;
          }
          const type = FIXTURE.expected_ensemble_types[persona][verb];
          strictEqual(arg(create, '--verb'), verb);
          const [[run]] = of('peer-runner.mjs', 'run');
          strictEqual(arg(run, '--phase'), verb);
          strictEqual(arg(run, '--ensemble-type'), type);
          const settles = of('peer-runner.mjs', 'settle');
          if (settles.length > 0) {
            // PC2b DD6: settle names the phase and the run id; it reads the
            // ensemble type from the run ledger, so nothing repeats it.
            strictEqual(settles.length, 1, 'one settle');
            const [[settle]] = settles;
            deepStrictEqual([arg(settle, '--phase'), arg(settle, '--run-id'), arg(settle, '--workflow-path')], [verb, '$RUN_ID', '$ACTIVE']);
            strictEqual(settle.args.some(([f]) => f === '--ensemble-type'), false, 'settle repeats no ensemble type');
            strictEqual(of('state.mjs', 'ensemble-commit').length, 0, 'no ensemble-commit beside settle');
          } else {
            const [[commit]] = of('state.mjs', 'ensemble-commit');
            strictEqual(arg(commit, '--phase'), verb);
            // founder critique names the type in its dispatch block and reads it
            // back from a variable the agent sets there (recorded as it is, QD5).
            strictEqual(arg(commit, '--ensemble-type'), FIXTURE.expected_commit_ensemble_types?.[persona]?.[verb] ?? type);
          }
          // engineer's authored investigate reads the run id's prefix from
          // ENSEMBLE_TYPE, which the agent sets: the prefix is that symbol (its
          // critique did too until it joined the regions in PC3 U7).
          deepStrictEqual(got.run_id_prefixes, [type]);
          deepStrictEqual(got.mktemp_templates.filter((t) => t.endsWith('-prompt.XXXXXX')), [`${persona}-${verb}-prompt.XXXXXX`]);
        });

        it('order: find-active, then bootstrap or resume, the dispatch, the note, the settlement, the terminal write — every write on $ACTIVE', () => {
          const index = (script, sub, nth = 0) => {
            const sites = of(script, sub);
            ok(sites.length > nth, `${script} ${sub} #${nth + 1}`);
            return sites[nth][1];
          };
          if (persona === 'engineer' && verb === 'start') {
            // engineer's start (PC3b U2): the preflight, the redundancy probe,
            // the clean-baseline gate before the bootstrap, the workflow_type
            // read on resume, then the Phase 7 driver's plan and execute — the
            // lifecycle's one terminal write — every one on $ACTIVE.
            const order = [index('state.mjs', 'find-active'), index('state.mjs', 'autopilot-preflight'), index('state.mjs', 'diagnose-redundancy'), index('state.mjs', 'check-clean-baseline'), index('state.mjs', 'create'), index('state.mjs', 'read'), index('phase7-commit.mjs', null, 0), index('phase7-commit.mjs', null, 1)];
            deepStrictEqual([...order].sort((a, b) => a - b), order);
            for (const c of [calls[index('state.mjs', 'read')], calls[order[6]], calls[order[7]]]) strictEqual(arg(c, '--workflow-path'), '$ACTIVE');
            deepStrictEqual([of('state.mjs', 'finish-verb').length, of('state.mjs', 'set-terminal').length], [0, 0]);
            return;
          }
          if (verb === 'start') {
            // start: the clean-baseline gate before the bootstrap, the
            // workflow_type read on resume, the terminal write at the end.
            const order = ['find-active', 'check-clean-baseline', 'create', 'read', 'finish-verb'].map((sub) => index('state.mjs', sub));
            deepStrictEqual([...order].sort((a, b) => a - b), order);
            for (const sub of ['read', 'finish-verb']) strictEqual(arg(calls[index('state.mjs', sub)], '--workflow-path'), '$ACTIVE');
            // PC2b U5c: the lifecycle closes with kind commit, the owner's save.
            deepStrictEqual([arg(calls[index('state.mjs', 'finish-verb')], '--next-step-kind'), of('state.mjs', 'set-terminal').length], ['commit', 0]);
            return;
          }
          const find = index('state.mjs', 'find-active');
          const create = index('state.mjs', 'create');
          const resume = index('state.mjs', 'append', 0);
          const run = index('peer-runner.mjs', 'run');
          const note = index('state.mjs', 'append', 1);
          // PC2b: settle and finish-verb where the finalize is settled (the
          // generated four), ensemble-commit and set-terminal until then;
          // engineer's authored finalize, ensemble-commit and finish-verb.
          const settled = of('peer-runner.mjs', 'settle').length > 0;
          const commit = settled ? index('peer-runner.mjs', 'settle') : index('state.mjs', 'ensemble-commit');
          const terminal = settled || persona === 'engineer' ? index('state.mjs', 'finish-verb') : index('state.mjs', 'set-terminal');
          ok(find < create && create < resume && resume < run && run < note && note < commit && commit < terminal);
          if (settled) {
            // The closed-enum next step the typical case records: the verb
            // after this one in the lifecycle (an independent map).
            const NEXT = { investigate: 'frame', frame: 'decide', decide: 'compose', compose: 'critique', critique: 'refine', refine: 'critique' };
            deepStrictEqual([arg(calls[terminal], '--next-step-kind'), arg(calls[terminal], '--next-step-verb')], ['verb', NEXT[verb]]);
            strictEqual(of('state.mjs', 'set-terminal').length, 0, 'no set-terminal beside finish-verb');
          }
          // A refine that waits for convergence (designer) records its next
          // step with a third, non-terminal append when it did not converge
          // (PC2b U5b).
          const paused = persona === 'designer' && verb === 'refine';
          strictEqual(of('state.mjs', 'append').length, paused ? 3 : 2);
          if (paused) {
            const last = calls[index('state.mjs', 'append', 2)];
            ok(last && index('state.mjs', 'append', 2) === terminal + 1, 'the paused append follows the converged finish-verb, its alternative');
            deepStrictEqual([arg(last, '--workflow-path'), arg(last, '--clear-terminal-marker'), last.args.some(([f]) => f === '--phase-note')], ['$ACTIVE', 'true', false]);
          }
          strictEqual(arg(calls[note], '--phase-note'), '$NOTE');
          for (const c of [calls[resume], calls[run], calls[note], calls[commit], calls[terminal]]) strictEqual(arg(c, '--workflow-path'), '$ACTIVE');
          strictEqual(arg(calls[terminal], '--next-action'), arg(calls[note], '--next-action'));
        });

        it('guards: detached HEAD and find-active failures exit; decide also exits on both resolver failures', () => {
          const exits = (guard) => (guard ?? '').split('\n').filter((l) => /^\s*exit\b/.test(l)).length;
          strictEqual(exits(got.guards.detached_head), 1, 'detached HEAD exits');
          strictEqual(exits(got.guards.find_rc), 1, 'a failed find-active exits');
          ok(got.guards.find_rc.includes('exit "$FIND_RC"'), 'with its status');
          if (verb === 'decide') strictEqual(exits(got.guards.resolve_rc), 2, 'both resolver failures exit');
          else strictEqual(got.guards.resolve_rc, null);
          // Contract: the lifecycle's phase notes are its verbs' — a note scaffold of its own would
          // add a phase-note write to start.
          if (verb === 'start') strictEqual(got.note, null, 'start writes no phase note of its own');
        });

        // PC2a3 T0': the guards start, critique and refine add.
        it('guards: start admits only a clean or accepted baseline; designer records an ensemble only when it launched, and its refine and start close only when converged', () => {
          const exits = (guard) => (guard ?? '').split('\n').filter((l) => /^\s*exit\b/.test(l) || /;\s*exit\b/.test(l)).length;
          const g = got.guards;
          if (verb === 'start') {
            strictEqual(exits(g.baseline_rc), 1, 'a failed baseline check exits');
            ok(g.baseline_rc.includes('exit "$BASELINE_RC"'), 'with its status');
            // Every persona's start refuses with the shared case (engineer's
            // if went in PC3b U2).
            const arms = g.baseline_status.split('\n').filter((l) => /^\s*[^\s()]+\)/.test(l)).map((l) => l.trim().split(')')[0]);
            deepStrictEqual(arms, ['clean|accepted', 'dirty', '*'], 'the admitted values, the dirty arm, the wildcard');
            strictEqual(exits(g.baseline_status), 2, 'the dirty and the wildcard arm exit');
          } else {
            deepStrictEqual([g.baseline_rc, g.baseline_status], [null, null]);
          }
          strictEqual(g.baseline_dirty, null);
          // The D2 guard went with the generated finalize (critique in PC2b
          // U5a, refine in U5b): settle decides from the ledger.
          strictEqual(g.ensemble_launched, null, 'no D2 guard on ensemble-commit');
          strictEqual(g.converged !== null, persona === 'designer' && (verb === 'refine' || verb === 'start'), 'the convergence guard');
          if (g.converged !== null) ok(/^  node "\$CLAUDE_PLUGIN_ROOT\/scripts\/state\.mjs" (set-terminal|finish-verb) \\$/m.test(g.converged.split('\nelse\n')[0]), 'it guards the terminal write in its then branch');
        });
      });
    }
  }
});
