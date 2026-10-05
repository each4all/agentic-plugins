// Declaration format 1.1, the per-verb fields (ADR-0066 Decision 2), bound to
// the runbooks that state the same facts. Until the verb runbooks hold
// generated regions, the declared values are copies of their text; these cases
// keep the two in step, so a region that later renders from the declaration
// renders what the runbook says today. Each binding is to a site, with a
// nonzero count.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MANIFEST, declaration, pluginRoot } from './_personas.mjs';
import { noteScaffold, shellBlocks, stripComments } from './_verb-runbooks.mjs';

const runbook = (persona, verb) => readFileSync(join(pluginRoot(persona), 'commands', `${verb}.md`), 'utf8');
const count = (text, needle) => text.split(needle).length - 1;
const withVerbs = MANIFEST.personas.filter((p) => declaration(p).verbs !== undefined).sort();
const NOTE_VERBS = ['investigate', 'frame', 'decide', 'compose'];
const NOTE_FIELDS = ['request_placeholder', 'artifact', 'rationale_gate', 'evidence_pointers', 'next_action'];

// Where a declared value is today's text with a listed change (PC2a2 PD5).
const LISTED_CHANGES = {
  // The placeholder loses its inner single quotes.
  'designer/investigate/next_action': (runbookValue) => runbookValue.split("'").join(''),
};

const CONVERGED_GUARD = 'if [ "${CONVERGED:-no}" = "yes" ]; then';

/**
 * Whether the runbook's terminal writes run only under a fail-closed
 * convergence check: true when every `set-terminal` call sits in the `then`
 * branch of `if [ "${CONVERGED:-no}" = "yes" ]; then` (nested ifs allowed),
 * with `CONVERGED` assigned earlier in the same block; false when none does.
 * Some guarded and some not fails the case: that is a defect whatever the
 * declaration says. Comments are dropped first, so a commented `else` or
 * `fi` changes nothing; an `else` or `elif` anywhere on a line counts.
 */
function terminalGuardedByConvergence(text) {
  const blocks = shellBlocks(text).map((b) => stripComments(b.text)).filter((b) => /state\.mjs" set-terminal\b/.test(b));
  strictEqual(blocks.length, 1, 'one block makes the terminal write');
  const verdicts = [];
  const frames = []; // { converged, branch }
  let assigned = false;
  for (const line of blocks[0].split('\n')) {
    const t = line.trim();
    if (/^CONVERGED=/.test(t)) assigned = true;
    if (/(^|[;\s])if\s/.test(t) && /;\s*then$/.test(t)) frames.push({ converged: t === CONVERGED_GUARD && assigned, branch: 'then' });
    if (/(^|[;\s])(else|elif)(\s|;|$)/.test(t) && frames.length > 0) frames[frames.length - 1].branch = 'else';
    if (/state\.mjs" set-terminal\b/.test(t)) verdicts.push(frames.some((f) => f.converged && f.branch === 'then'));
    if (/(^|[;\s])fi(\s|;|$)/.test(t)) frames.pop();
  }
  ok(verdicts.length > 0, 'a set-terminal call');
  ok(verdicts.every((v) => v === verdicts[0]), `every terminal write is guarded alike (${verdicts.join(', ')})`);
  return verdicts[0];
}

describe('declaration 1.1: which personas declare verbs', () => {
  it('founder and designer declare verbs (format 1.1); engineer stays 1.0 without them (DD4)', () => {
    deepStrictEqual(withVerbs, ['designer', 'founder']);
    for (const p of withVerbs) strictEqual(declaration(p).schema, 'persona-declaration-1.1');
    strictEqual(declaration('engineer').schema, 'persona-declaration-1.0');
    strictEqual(declaration('engineer').verbs, undefined);
  });

  for (const persona of ['founder', 'designer']) {
    it(`${persona}: every verb whose runbook writes a phase note declares the note's fields; refine and start declare convergence`, () => {
      const verbs = declaration(persona).verbs;
      for (const verb of NOTE_VERBS) {
        for (const f of NOTE_FIELDS) ok(verbs[verb]?.[f] !== undefined, `${persona} verbs.${verb}.${f}`);
      }
      for (const verb of ['refine', 'start']) strictEqual(typeof verbs[verb]?.terminal_requires_convergence, 'boolean', `${persona} verbs.${verb}`);
    });
  }
});

for (const persona of ['founder', 'designer']) {
  describe(`${persona}: the declared verb fields are what the runbooks say`, () => {
    const verbs = declaration(persona).verbs;

    for (const verb of ['refine', 'start']) {
      it(`${verb}: terminal_requires_convergence is true exactly when the terminal write waits for CONVERGED (DD5)`, () => {
        strictEqual(verbs[verb].terminal_requires_convergence, terminalGuardedByConvergence(runbook(persona, verb)));
      });
    }

    it('compose: the Profiles list, its default, "Missing profile" and the argument hint name the declared profiles', () => {
      const text = runbook(persona, 'compose');
      const { profiles, default_profile: def } = verbs.compose;
      const listed = [...text.matchAll(/^- `([a-z][a-z0-9-]*)`( \(default\))? — /gm)];
      deepStrictEqual(listed.map((m) => m[1]), profiles);
      deepStrictEqual(listed.filter((m) => m[2]).map((m) => m[1]), [def]);
      strictEqual(count(text, `Missing profile → \`${def}\`.`), 1);
      strictEqual(count(text, `\nargument-hint: --profile=${profiles.join('|')} | `), 1);
    });

    it('investigate: the argument hint names the declared profiles; the bootstrap placeholder names the default', () => {
      const text = runbook(persona, 'investigate');
      const { profiles, default_profile: def } = verbs.investigate;
      strictEqual(count(text, `\nargument-hint: --profile=${profiles.join('|')} | `), 1);
      strictEqual(count(text, `<profile from the arguments above — ${profiles.join(', ')}; default '${def}'>`), 1);
    });

    it('investigate: the ensemble type is the one its dispatch and ensemble-commit name', () => {
      const text = runbook(persona, 'investigate');
      strictEqual(count(text, `--ensemble-type ${verbs.investigate.ensemble_type} --run-id`), 2);
      strictEqual(count(text, `### Ensemble launched: ${verbs.investigate.ensemble_type} at <iso-utc>`), 1);
    });

    for (const verb of NOTE_VERBS) {
      it(`${verb}: request placeholder, note artifact, rationale, evidence and next action`, () => {
        const text = runbook(persona, verb);
        const v = verbs[verb];
        // An authored bootstrap holds the placeholder in the block; a generated
        // one (PC2a2 PD3) names it in the prose above a persona-neutral one.
        const inBlock = count(text, `--original-request "\${AGENTIC_TOPIC:-<${v.request_placeholder}>}"`);
        const inProse = count(text.replace(/\s+/g, ' '), `\`<the original request described above>\` with a ${v.request_placeholder};`);
        strictEqual(inBlock + inProse, 1, 'request placeholder');
        if (inProse === 1) strictEqual(count(text, '--original-request "${AGENTIC_TOPIC:-<the original request described above>}"'), 1, 'the block names the prose');
        const note = noteScaffold(text);
        ok(note !== null, 'the finalize step holds a phase-note scaffold');
        // The artifact sections are exactly the note text between the breakdown
        // and the proposal heading: nothing left out, nothing added.
        strictEqual(count(note, `<AGREED / LOCAL-ONLY / PEER-ONLY / CONFLICT breakdown>\n\n${v.artifact.join('\n')}\n\n### Active next-action proposal\n`), 1, 'artifact sections');
        strictEqual(count(note, `- rationale:             <why best — ${v.rationale_gate}>\n`), 1, 'rationale');
        strictEqual(count(note, `- evidence_pointers:     <${v.evidence_pointers} — pointers only>\n`), 1, 'evidence pointers');
        const listed = LISTED_CHANGES[`${persona}/${verb}/next_action`] ?? ((s) => s);
        // Double-quoted as authored, single-quoted as generated (Decision 4).
        const actions = [...text.matchAll(/--next-action (?:"([^"]*)"|'([^']*)') \\$/gm)].map((m) => listed(m[1] ?? m[2]));
        strictEqual(actions.filter((a) => a === v.next_action).length, 2, `the finalize append and finish write record ${JSON.stringify(v.next_action)}`);
      });
    }
  });
}
