// Declaration format 1.1 and later, the per-verb fields (ADR-0066 Decision 2),
// bound to what the runbooks run or a host reads: the convergence flag to the
// terminal write's guard, the profiles to each command's `argument-hint`
// frontmatter and the default its bootstrap block assigns, the investigate
// ensemble type to the dispatch and settle calls, the brief file and output
// root to the output-file rules, the privacy scope to each runbook's gate,
// and the next action to the `--next-action` the finalize records. Each
// binding is to a site, with a nonzero count.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { derivedFields } from '../../scripts/lib/persona-pipeline.mjs';
import { MANIFEST, declaration, pluginRoot } from './_personas.mjs';
import { shellBlocks, stripComments } from './_verb-runbooks.mjs';

const runbook = (persona, verb) => readFileSync(join(pluginRoot(persona), 'commands', `${verb}.md`), 'utf8');
const count = (text, needle) => text.split(needle).length - 1;
const NOTE_VERBS = ['investigate', 'frame', 'decide', 'compose', 'critique', 'refine'];
const withVerbs = MANIFEST.personas.filter((p) => declaration(p).verbs !== undefined).sort();
const NOTE_FIELDS = ['request_placeholder', 'artifact', 'rationale_gate', 'evidence_pointers', 'next_action'];

// Where a declared value is today's text with a listed change (PC2a2 PD5).
const LISTED_CHANGES = {
  // The placeholder loses its inner single quotes.
  'designer/investigate/next_action': (runbookValue) => runbookValue.split("'").join(''),
};

const CONVERGED_GUARD = 'if [ "${CONVERGED:-no}" = "yes" ]; then';

/**
 * Whether the runbook's terminal writes run only under a fail-closed
 * convergence check: true when every terminal write (`set-terminal`, or
 * `finish-verb` once generated, PC2b U5b) sits in the `then`
 * branch of `if [ "${CONVERGED:-no}" = "yes" ]; then` (nested ifs allowed),
 * with `CONVERGED` assigned earlier in the same block; false when none does.
 * Some guarded and some not fails the case: that is a defect whatever the
 * declaration says. Comments are dropped first, so a commented `else` or
 * `fi` changes nothing; an `else` or `elif` anywhere on a line counts.
 */
function terminalGuardedByConvergence(text) {
  // The finalize block: the one that reads the phase note (generated) or makes
  // the authored terminal write. decide-style resolution blocks finish a verb
  // too, but only after an owner's decision, never on convergence.
  const TERMINAL = /state\.mjs" (set-terminal|finish-verb)\b/;
  const blocks = shellBlocks(text).map((b) => stripComments(b.text)).filter((b) => TERMINAL.test(b) && !/awaiting-owner-clear\b/.test(b));
  strictEqual(blocks.length, 1, 'one block makes the terminal write');
  const verdicts = [];
  const frames = []; // { converged, branch }
  let assigned = false;
  for (const line of blocks[0].split('\n')) {
    const t = line.trim();
    if (/^CONVERGED=/.test(t)) assigned = true;
    if (/(^|[;\s])if\s/.test(t) && /;\s*then$/.test(t)) frames.push({ converged: t === CONVERGED_GUARD && assigned, branch: 'then' });
    if (/(^|[;\s])(else|elif)(\s|;|$)/.test(t) && frames.length > 0) frames[frames.length - 1].branch = 'else';
    if (TERMINAL.test(t)) verdicts.push(frames.some((f) => f.converged && f.branch === 'then'));
    if (/(^|[;\s])fi(\s|;|$)/.test(t)) frames.pop();
  }
  ok(verdicts.length > 0, 'a terminal write');
  ok(verdicts.every((v) => v === verdicts[0]), `every terminal write is guarded alike (${verdicts.join(', ')})`);
  return verdicts[0];
}

// engineer declares a verb once its runbook holds the generated finalize (or
// start's generated bootstrap), so the declared set and the joined runbooks
// stay one set.
const ENGINEER_JOINED_VERBS = [
  ...NOTE_VERBS.filter((verb) => runbook('engineer', verb).includes(`<!-- pipeline:begin ${verb}-finalize -->`)),
  ...(runbook('engineer', 'start').includes('<!-- pipeline:begin start-bootstrap -->') ? ['start'] : []),
];

describe('declaration 1.1: which personas declare verbs', () => {
  it('founder and designer declare verbs (format 1.2, which adds peer); engineer declares 1.4 (1.3 adds the investigate brief names, 1.4 its brief profile and ensemble type), exactly the verbs whose runbooks joined the regions, and no peer (DD4, PC3 U7)', () => {
    deepStrictEqual(withVerbs, ['designer', 'engineer', 'founder']);
    for (const p of ['designer', 'founder']) strictEqual(declaration(p).schema, 'persona-declaration-1.2');
    strictEqual(declaration('engineer').schema, 'persona-declaration-1.4');
    strictEqual(declaration('engineer').peer, undefined);
    ok(ENGINEER_JOINED_VERBS.length > 0, 'a joined engineer verb (guards a vacuous pass)');
    // Contract: the generator's region markers — a declared verb whose runbook holds no
    // generated region renders nothing from its declaration.
    deepStrictEqual(Object.keys(declaration('engineer').verbs).sort(), [...ENGINEER_JOINED_VERBS].sort());
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

const ALL_VERBS = ['investigate', 'frame', 'decide', 'compose', 'critique', 'refine', 'start'];

// Format 1.2's peer policy, bound to the privacy gate every verb runbook states.
for (const persona of ['founder', 'designer']) {
  describe(`${persona}: the declared peer policy is what the privacy gates say`, () => {
    const peer = declaration(persona).peer;
    it('images is false: no runbook passes an image to the peer (QD3)', () => {
      strictEqual(peer.images, false);
    });
    for (const verb of ALL_VERBS) {
      it(`${verb}: the gate names the declared scope`, () => {
        const flat = runbook(persona, verb).replace(/\s+/g, ' ');
        // Contract: the agent before web search and peer dispatch — the gate names what this
        // persona must genericize; a runbook without it sends the raw value to the peer.
        strictEqual(count(flat, `PRIVACY GATE: ${peer.privacy_scope} pass an explicit`), 1, 'scope');
      });
    }
  });
}

for (const persona of ['founder', 'designer', 'engineer']) {
  describe(`${persona}: the declared verb fields are what the runbooks say`, () => {
    const verbs = declaration(persona).verbs;
    const declared = (verb) => Object.hasOwn(verbs, verb);

    for (const verb of ['refine', 'start']) {
      if (!declared(verb)) continue;
      // PC3b U2: with commit_surface on, start's one terminal write is the
      // Phase 7 commit driver, no finish-verb, so it declares no convergence
      // flag (the flag picks a finish-verb variant it does not render).
      if (verb === 'start' && declaration(persona).capabilities.commit_surface) {
        it('start: commit_surface on — no convergence flag, and the terminal write is the Phase 7 driver, not finish-verb (PC3b U2)', () => {
          strictEqual(Object.hasOwn(verbs.start, 'terminal_requires_convergence'), false);
          // Contract: the agent running start's blocks — the Phase 7 execute is the one terminal
          // write; a finish-verb or set-terminal beside it closes the lifecycle twice.
          const code = shellBlocks(runbook(persona, 'start')).map((b) => stripComments(b.text)).join('\n');
          strictEqual(/state\.mjs" (set-terminal|finish-verb)\b/.test(code), false, 'no finish-verb or set-terminal');
          strictEqual(count(code, 'phase7-commit.mjs" \\\n  --mode execute'), 1, 'the Phase 7 execute');
        });
        continue;
      }
      it(`${verb}: terminal_requires_convergence is true exactly when the terminal write waits for CONVERGED (DD5)`, () => {
        // Contract: the agent running the finalize block — its terminal write runs only under the
        // CONVERGED guard exactly where the declaration says the verb waits for convergence.
        strictEqual(verbs[verb].terminal_requires_convergence, terminalGuardedByConvergence(runbook(persona, verb)));
      });
    }

    if (declared('compose')) it('compose: the argument hint names the declared profiles', () => {
      const text = runbook(persona, 'compose');
      const { profiles } = verbs.compose;
      // Contract: Claude Code reads `argument-hint` from the command's frontmatter and offers it
      // to the user — a profile missing there is one the user is never shown.
      strictEqual(count(text, `\nargument-hint: --profile=${profiles.join('|')} | `), 1);
    });

    if (declared('investigate')) it('investigate: the argument hint names the declared profiles; the bootstrap placeholder names the default', () => {
      const text = runbook(persona, 'investigate');
      const { profiles, default_profile: def } = verbs.investigate;
      // Contract: Claude Code reads `argument-hint` from the command's frontmatter.
      strictEqual(count(text, `\nargument-hint: --profile=${profiles.join('|')} | `), 1);
      // Contract: the --profile argument of the bootstrap's create — authored, the placeholder
      // spells the default; generated, it reads DEFAULT_PROFILE, which the block assigns.
      const authored = count(text, `<profile from the arguments above — ${profiles.join(', ')}; default '${def}'>`);
      const generated = count(text, '<profile from the arguments above — default ${DEFAULT_PROFILE}>');
      strictEqual(authored + generated, 1, 'one profile placeholder');
      if (generated === 1) strictEqual(count(text, `\nDEFAULT_PROFILE='${def}'\n`), 1, 'the block assigns the declared default');
    });

    // PC3 U7: the brief names the declaration implies (declared, or derived
    // from the default profile and the name) are the ones the persona's
    // output-file rules use; engineer's rules are still authored, so a dropped
    // declared name would bind its brief to a file and variable nothing reads.
    if (declared('investigate')) it('investigate: the brief file and output-root variable the declaration implies are the ones its output-file rules name (PC3 U7)', () => {
      const { brief_file: brief, output_root_env: env } = derivedFields(declaration(persona));
      const rules = readFileSync(join(pluginRoot(persona), 'core/skills/investigate/references/output-file-rules.md'), 'utf8');
      // Contract: the agent writing the brief — the file name it writes and the variable it reads
      // for the output root are the ones the declaration renders into the runbooks.
      ok(count(rules, `\`${brief}\``) > 0, `output-file-rules.md names ${brief}`);
      ok(count(rules, `\`${env}\``) > 0, `output-file-rules.md overrides the root with ${env}`);
    });

    if (declared('critique')) it('critique: the argument hint names the declared profiles besides the default, which the bootstrap block assigns (PC2a3 QD6)', () => {
      const text = runbook(persona, 'critique');
      const { profiles, default_profile: def } = verbs.critique;
      ok(profiles.length > 1 && profiles.includes(def), 'the declared profiles');
      // A profile may name its optional sub-focus in brackets (engineer's
      // full-codebase[:security|…]).
      const others = profiles.filter((p) => p !== def).join('|').replace(/[|]/g, '\\|');
      // Contract: Claude Code reads `argument-hint` from the command's frontmatter.
      strictEqual((text.match(new RegExp(`\\nargument-hint: --profile=${others}(?:\\[:[^\\]\\n]+\\])? \\| `, 'g')) ?? []).length, 1, 'the argument hint');
      // Contract: the --profile the bootstrap's create passes when the arguments name none.
      strictEqual(count(text, `\nDEFAULT_PROFILE='${def}'\n`), 1, 'the block assigns the declared default');
    });

    if (declared('investigate')) it('investigate: the ensemble type is the one its dispatch names; settle reads it from the run ledger (PC2b DD6)', () => {
      const text = runbook(persona, 'investigate');
      const type = verbs.investigate.ensemble_type;
      // Contract: peer-runner.mjs run's --ensemble-type, which settle later reads back from the
      // run ledger — so settle names the phase and run id, never the type again.
      strictEqual(text.split(`ENSEMBLE_TYPE='${type}'\n`).length - 1, 1, 'the dispatch assigns the type');
      strictEqual(text.split('--ensemble-type "$ENSEMBLE_TYPE" --run-id').length - 1, 1, 'and names it once');
      strictEqual(text.split(/--phase 'investigate' --run-id "\$RUN_ID" \\\n/).length - 1, 1, 'settle names the phase and the run id, no type');
    });

    for (const verb of NOTE_VERBS) {
      if (!declared(verb)) continue;
      it(`${verb}: the finalize records the declared next action`, () => {
        const text = runbook(persona, verb);
        const v = verbs[verb];
        const listed = LISTED_CHANGES[`${persona}/${verb}/next_action`] ?? ((s) => s);
        // Double-quoted as authored, single-quoted as generated (Decision 4).
        const actions = [...text.matchAll(/--next-action (?:"([^"]*)"|'([^']*)') \\$/gm)].map((m) => listed(m[1] ?? m[2]));
        // Contract: the --next-action state.mjs records, which SessionStart and the footer show —
        // the finalize append and the finish write (and decide's Owner selection) record the
        // declared one.
        strictEqual(actions.filter((a) => a === v.next_action).length, verb === 'decide' ? 3 : 2, `the finalize append and finish write record ${JSON.stringify(v.next_action)}`);
      });
    }
  });
}
