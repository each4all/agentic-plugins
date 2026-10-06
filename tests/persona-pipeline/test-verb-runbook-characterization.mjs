// PC2a2 T0 and PC2a3 T0': founder and designer's verb runbooks characterized
// before their shell blocks become generated regions — compose, decide, frame
// and investigate (PC2a2), critique, refine and start (PC2a3, recorded before
// their regions).
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
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';

import { FIXTURE, VERB_RUNBOOK_PERSONAS, VERB_RUNBOOK_VERBS, characterize, expectedFor, runbookText } from './_verb-runbooks.mjs';

const arg = (call, flag) => {
  const found = call.args.filter(([f]) => f === flag);
  strictEqual(found.length, 1, `${call.script} ${call.sub} carries ${flag} once`);
  return found[0][1];
};

describe('verb runbook characterization (PC2a2 T0)', () => {
  it('the fixture covers the fourteen runbooks; every allowed difference is a listed, reasoned change to a known runbook', () => {
    const keys = VERB_RUNBOOK_PERSONAS.flatMap((p) => VERB_RUNBOOK_VERBS.map((v) => `${p}/${v}`)).sort();
    deepStrictEqual(Object.keys(FIXTURE.runbooks).sort(), keys);
    ok(Array.isArray(FIXTURE.allowed_differences));
    for (const d of FIXTURE.allowed_differences) {
      deepStrictEqual(Object.keys(d).sort(), ['from', 'runbooks', 'to', 'where', 'why'], JSON.stringify(d));
      ok(d.runbooks.length > 0 && d.runbooks.every((k) => keys.includes(k)), `${d.where}: runbooks`);
      ok(d.from !== d.to && d.from.length > 0 && /^PC2a[234] /.test(d.why), `${d.where}: a change with its reason`);
    }
  });

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
          strictEqual(arg(create, '--persona'), persona);
          if (verb === 'start') {
            // The lifecycle macro creates a start workflow in its first verb,
            // and dispatches through the verbs it sequences, not in its blocks.
            strictEqual(arg(create, '--verb'), 'investigate');
            strictEqual(arg(create, '--workflow-type'), 'start');
            deepStrictEqual([of('peer-runner.mjs', 'run').length, of('state.mjs', 'ensemble-commit').length, of('state.mjs', 'append').length], [0, 0, 0]);
            deepStrictEqual([got.run_id_prefixes, got.mktemp_templates], [[], []]);
            return;
          }
          const type = FIXTURE.expected_ensemble_types[persona][verb];
          strictEqual(arg(create, '--verb'), verb);
          const [[run]] = of('peer-runner.mjs', 'run');
          strictEqual(arg(run, '--phase'), verb);
          strictEqual(arg(run, '--ensemble-type'), type);
          const [[commit]] = of('state.mjs', 'ensemble-commit');
          strictEqual(arg(commit, '--phase'), verb);
          // founder critique names the type in its dispatch block and reads it
          // back from a variable the agent sets there (recorded as it is, QD5).
          strictEqual(arg(commit, '--ensemble-type'), FIXTURE.expected_commit_ensemble_types?.[persona]?.[verb] ?? type);
          deepStrictEqual(got.run_id_prefixes, [type]);
          deepStrictEqual(got.mktemp_templates.filter((t) => t.endsWith('-prompt.XXXXXX')), [`${persona}-${verb}-prompt.XXXXXX`]);
        });

        it('order: find-active, then bootstrap or resume, the dispatch, the note, ensemble-commit, set-terminal — every write on $ACTIVE', () => {
          const index = (script, sub, nth = 0) => {
            const sites = of(script, sub);
            ok(sites.length > nth, `${script} ${sub} #${nth + 1}`);
            return sites[nth][1];
          };
          if (verb === 'start') {
            // start: the clean-baseline gate before the bootstrap, the
            // workflow_type read on resume, the terminal write at the end.
            const order = ['find-active', 'check-clean-baseline', 'create', 'read', 'set-terminal'].map((sub) => index('state.mjs', sub));
            deepStrictEqual([...order].sort((a, b) => a - b), order);
            for (const sub of ['read', 'set-terminal']) strictEqual(arg(calls[index('state.mjs', sub)], '--workflow-path'), '$ACTIVE');
            return;
          }
          const find = index('state.mjs', 'find-active');
          const create = index('state.mjs', 'create');
          const resume = index('state.mjs', 'append', 0);
          const run = index('peer-runner.mjs', 'run');
          const note = index('state.mjs', 'append', 1);
          const commit = index('state.mjs', 'ensemble-commit');
          const terminal = index('state.mjs', 'set-terminal');
          ok(find < create && create < resume && resume < run && run < note && note < commit && commit < terminal);
          strictEqual(of('state.mjs', 'append').length, 2);
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
          if (verb === 'start') {
            strictEqual(got.note, null, 'start writes no phase note of its own');
            return;
          }
          const launched = FIXTURE.expected_launched?.[persona]?.[verb] ?? (verb === 'investigate' ? FIXTURE.expected_ensemble_types[persona][verb] : verb);
          ok(got.note !== null && got.note.startsWith(`### Ensemble launched: ${launched} at <iso-utc>\n`));
        });

        // PC2a3 T0': the guards start, critique and refine add.
        it('guards: start admits only a clean or accepted baseline; designer records an ensemble only when it launched, and its refine and start close only when converged', () => {
          const exits = (guard) => (guard ?? '').split('\n').filter((l) => /^\s*exit\b/.test(l) || /;\s*exit\b/.test(l)).length;
          const g = got.guards;
          if (verb === 'start') {
            strictEqual(exits(g.baseline_rc), 1, 'a failed baseline check exits');
            ok(g.baseline_rc.includes('exit "$BASELINE_RC"'), 'with its status');
            const arms = g.baseline_status.split('\n').filter((l) => /^\s*[^\s()]+\)/.test(l)).map((l) => l.trim().split(')')[0]);
            deepStrictEqual(arms, ['clean|accepted', 'dirty', '*'], 'the admitted values, the dirty arm, the wildcard');
            strictEqual(exits(g.baseline_status), 2, 'the dirty and the wildcard arm exit');
          } else {
            deepStrictEqual([g.baseline_rc, g.baseline_status], [null, null]);
          }
          const designerGuarded = persona === 'designer' && (verb === 'critique' || verb === 'refine');
          strictEqual(g.ensemble_launched !== null, designerGuarded, 'the D2 guard on ensemble-commit');
          if (designerGuarded) ok(/state\.mjs" ensemble-commit/.test(g.ensemble_launched), 'it guards the ensemble-commit');
          strictEqual(g.converged !== null, persona === 'designer' && (verb === 'refine' || verb === 'start'), 'the convergence guard');
          if (g.converged !== null) ok(/state\.mjs" set-terminal/.test(g.converged), 'it guards the terminal write');
        });
      });
    }
  }
});
