// PC2a2 T0: founder and designer's compose, decide, frame and investigate
// runbooks characterized before their shell blocks become generated regions.
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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from './_personas.mjs';
import { VERB_RUNBOOK_PERSONAS, VERB_RUNBOOK_VERBS, characterize, runbookText } from './_verb-runbooks.mjs';

const FIXTURE = JSON.parse(readFileSync(join(REPO_ROOT, 'tests/persona-pipeline/fixtures/verb-runbooks.json'), 'utf8'));
const arg = (call, flag) => {
  const found = call.args.filter(([f]) => f === flag);
  strictEqual(found.length, 1, `${call.script} ${call.sub} carries ${flag} once`);
  return found[0][1];
};

describe('verb runbook characterization (PC2a2 T0)', () => {
  it('the fixture covers the eight runbooks, and no difference is allowed yet', () => {
    const keys = VERB_RUNBOOK_PERSONAS.flatMap((p) => VERB_RUNBOOK_VERBS.map((v) => `${p}/${v}`)).sort();
    deepStrictEqual(Object.keys(FIXTURE.runbooks).sort(), keys);
    deepStrictEqual(FIXTURE.allowed_differences, []);
  });

  for (const persona of VERB_RUNBOOK_PERSONAS) {
    for (const verb of VERB_RUNBOOK_VERBS) {
      describe(`${persona}/${verb}`, () => {
        const got = characterize(runbookText(persona, verb));
        const calls = got.calls;
        const of = (script, sub) => calls.map((c, i) => [c, i]).filter(([c]) => c.script === script && c.sub === sub);

        it('does what the fixture recorded: calls, argument values, guards, run-id prefix, prompt file, note scaffold', () => {
          deepStrictEqual(got, FIXTURE.runbooks[`${persona}/${verb}`]);
        });

        it('identity: persona, verb, phase and ensemble type match the expected map', () => {
          const type = FIXTURE.expected_ensemble_types[persona][verb];
          const [[create]] = of('state.mjs', 'create');
          strictEqual(arg(create, '--persona'), persona);
          strictEqual(arg(create, '--verb'), verb);
          const [[run]] = of('peer-runner.mjs', 'run');
          strictEqual(arg(run, '--phase'), verb);
          strictEqual(arg(run, '--ensemble-type'), type);
          const [[commit]] = of('state.mjs', 'ensemble-commit');
          strictEqual(arg(commit, '--phase'), verb);
          strictEqual(arg(commit, '--ensemble-type'), type);
          deepStrictEqual(got.run_id_prefixes, [type]);
          deepStrictEqual(got.mktemp_templates.filter((t) => t.endsWith('-prompt.XXXXXX')), [`${persona}-${verb}-prompt.XXXXXX`]);
        });

        it('order: find-active, then bootstrap or resume, the dispatch, the note, ensemble-commit, set-terminal — every write on $ACTIVE', () => {
          const index = (script, sub, nth = 0) => {
            const sites = of(script, sub);
            ok(sites.length > nth, `${script} ${sub} #${nth + 1}`);
            return sites[nth][1];
          };
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
          ok(got.note !== null && got.note.startsWith(`### Ensemble launched: ${verb === 'investigate' ? FIXTURE.expected_ensemble_types[persona][verb] : verb} at <iso-utc>\n`));
        });
      });
    }
  }
});
