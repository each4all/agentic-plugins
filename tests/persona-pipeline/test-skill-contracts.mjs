// Skill contracts over the generated SKILL.md regions (ADR-0066 Decision 5,
// PC2a3 T7 QD10).
//
// The command runbooks have their family in test-runbook-contracts.mjs. A
// skill differs in what it can be held to: its shell blocks illustrate a call
// with `<plugin-root>` and run nothing, Codex injects the file byte for byte,
// and Claude substitutes nothing in it. So this family checks the text an
// agent acts on, over each persona's committed SKILL.md and over the one
// assembled from the templates (what the next `--write` would produce):
//
//   - nothing left unrendered, the frontmatter still first;
//   - shell blocks name the plugin root only as `<plugin-root>`;
//   - every `state.mjs` subcommand a region names is one the persona's own
//     `state.mjs` dispatches;
//   - the command-resolution table's Plugin root row, per document;
//   - what each generated section states about behavior: the checkpoint's
//     write target and re-injection scope, peer-now's synchronous dispatch and
//     its failure-before-note rule and flags, resume's marker and its dirty
//     probes, compose's and frame's confirmation, compose's state-write rule,
//     decide's approval gate, and the privacy gate critique, refine and start
//     state before their peer step (its citation resolved from the skill's own
//     directory);
//   - each extension a skill slot holds states the sentences it exists for.
//
// Each assertion is bound to its region with a nonzero count, so a contract
// that matches nothing fails instead of passing.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

import {
  parseRegions,
  regionBody,
  renderTemplate,
  renderingDeclaration,
  replaceRegionBodies,
} from '../../scripts/lib/persona-pipeline.mjs';
import { MANIFEST, REPO_ROOT, declaration, pluginRoot } from './_personas.mjs';
import { codexCellProblems, pluginRootRows } from '../_plugin-root-cell.mjs';

const SKILLS_REL = 'core/skills';
const skillOf = (dest) => new RegExp(`^${SKILLS_REL}/([a-z-]+)/SKILL\\.md$`).exec(dest)?.[1] ?? null;

/** The SKILL.md files of the manifest and the personas enrolled into each. */
function skillFiles() {
  const byDest = new Map();
  for (const region of MANIFEST.regions) {
    if (!skillOf(region.dest)) continue;
    if (!byDest.has(region.dest)) byDest.set(region.dest, new Set());
    for (const p of region.personas) byDest.get(region.dest).add(p);
  }
  return byDest;
}

function assembled(persona, dest, text) {
  const parsed = parseRegions(text, dest);
  deepStrictEqual(parsed.errors, [], `${persona}/${dest}: region grammar`);
  const bodies = {};
  for (const region of MANIFEST.regions.filter((r) => r.dest === dest && r.personas.includes(persona))) {
    const rendered = renderTemplate(readFileSync(join(REPO_ROOT, 'persona-pipeline', region.template), 'utf8'), {
      declaration: renderingDeclaration(declaration(persona)),
      substitutions: region.substitutions ?? {},
      label: region.template,
    });
    bodies[region.id] = rendered.endsWith('\n') ? rendered.slice(0, -1) : rendered;
  }
  return replaceRegionBodies(text, parsed.regions, bodies);
}

function documents(persona, dest) {
  const committed = readFileSync(join(pluginRoot(persona), dest), 'utf8');
  return [
    ['committed', committed],
    ['assembled from the templates', assembled(persona, dest, committed)],
  ];
}

/** A region's body by id; fails when the document does not hold it once. */
function region(text, id) {
  const found = parseRegions(text).regions.filter((r) => r.id === id);
  strictEqual(found.length, 1, `region ${id}`);
  return regionBody(text, found[0]);
}

/** Every generated body of a document, joined. */
function generated(text) {
  return parseRegions(text).regions.map((r) => regionBody(text, r)).join('\n');
}

/** Fenced shell blocks, as an agent reads them. */
function shellBlocks(text) {
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*```(bash|sh|zsh|shell)\s*$/.test(lines[i])) continue;
    let e = i + 1;
    while (e < lines.length && lines[e].trim() !== '```') e++;
    out.push(lines.slice(i + 1, e).join('\n'));
    i = e;
  }
  return out;
}

const squash = (s) => s.replace(/\s+/g, ' ');

/** The subcommands a persona's state.mjs dispatches (its `case '<name>':` arms). */
const SUBCOMMANDS = new Map();
function subcommands(persona) {
  if (!SUBCOMMANDS.has(persona)) {
    const source = readFileSync(join(pluginRoot(persona), 'scripts', 'state.mjs'), 'utf8');
    SUBCOMMANDS.set(persona, new Set([...source.matchAll(/^\s+case '([a-z-]+)': \{/gm)].map((m) => m[1])));
  }
  return SUBCOMMANDS.get(persona);
}

/** The persona's own SessionStart re-injection marker, from its loader. */
function metadataTag(persona) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e',
    `const m = await import(${JSON.stringify(join(pluginRoot(persona), 'scripts', 'lib', 'persona.mjs'))}); process.stdout.write(m.metadataTag());`], { encoding: 'utf8' });
  strictEqual(r.status, 0, r.stderr);
  return r.stdout;
}

const FILES = skillFiles();
const COMMAND_RESOLUTION = ['checkpoint', 'peer-now', 'resume'];

// The Phase 0 steps start's skill may say its entry path owns, each with the
// site that runs it in the persona's commands/start.md. A step the intro names
// that is not here, or that the runbook does not run, fails: founder's intro
// named a redundancy probe its runbook never ran (PC2a3 U7, listed
// unification).
const START_PHASE0 = {
  'argument intake': /\$ARGUMENTS/,
  'detached-HEAD guard': /Detached HEAD/,
  'redundancy probe': /state\.mjs" diagnose-redundancy/,
  'clean-baseline gate': /state\.mjs" check-clean-baseline /,
  'active-workflow branching': /workflow_type/,
};

// The privacy gate a skill states before its peer step (PC2a3 U7(b)): the
// verb's prohibition sentence (the manifest's value, the runbook's sentence),
// and the heading of the step that calls the peer, which the gate must precede.
// The no-image rule is the runbooks' sentence; designer's screenshot sentence
// stays its authored text right after the regions.
const SKILL_PRIVACY = {
  critique: {
    prohibition: 'Genericize the artifact before the peer prompt; the pre-genericization value MUST never leave the local host.',
    peerStep: /^### Step 4: Peer ensemble /m,
  },
  refine: {
    prohibition: 'Genericize the revision before the peer prompt; the pre-genericization value MUST never leave the local host.',
    peerStep: /^### Step 4: Peer ensemble /m,
  },
  start: {
    prohibition: 'The lifecycle runs web search (Phase 1 investigate) and dispatches the peer ensemble at every phase boundary (always-max) — genericize before any external call; the pre-genericization value MUST never leave the local host. Each verb skill restates this gate; the macro inherits it at every phase.',
    peerStep: /^### Phase 1 — /m,
  },
};
const NO_IMAGE = 'No dispatch passes `--image`: the companion peer path has no image channel, so an image never reaches the peer as bytes.';
// designer's screenshot sentence: its label and the prohibition it states.
const SCREENSHOT = {
  critique: ['**Screenshots are sensitive by default**', 'is **never sent to the peer as inline image bytes**'],
  refine: ['**Screenshots are sensitive by default**', 'is **never sent to the peer as inline image bytes**'],
  start: ['**Screenshots are sensitive by default**', 'is read host-direct and never leaves the local host as bytes'],
};

// Each extension a skill slot holds (PC2a3 QD10, as QD8 for the runbooks): the
// sentences its authored text must state, so a marker left without the text it
// stands for fails. Every skill slot in the manifest needs an entry.
const EXTENSION_ANCHORS = {
  'start-archetype': ['**Carry the archetype inline, not as durable state.**', '`AGENTIC_DESIGNER_PROFILE="<archetype>" node …/decide-registry.mjs resolve --args-file …`'],
};
const SKILL_SLOTS = MANIFEST.extension_points.filter((e) => skillOf(e.dest));

/** Each extension marker, with the authored text after it up to the next marker. */
function extensionTexts(text) {
  const lines = text.split('\n');
  const out = [];
  lines.forEach((line, i) => {
    const m = /^<!-- pipeline:extension ([a-z][a-z0-9._-]*) -->$/.exec(line);
    if (!m) return;
    let e = i + 1;
    while (e < lines.length && !lines[e].startsWith('<!-- pipeline:')) e++;
    out.push({ id: m[1], text: lines.slice(i + 1, e).join('\n') });
  });
  return out;
}

describe('skill regions: the contracts hold for every enrolled persona', () => {
  it('the contracts reach the skill files they are about (guards a vacuous pass)', () => {
    deepStrictEqual([...FILES.keys()].map(skillOf).sort(), ['checkpoint', 'compose', 'critique', 'decide', 'frame', 'peer-now', 'refine', 'resume', 'start']);
    for (const [dest, personas] of FILES) deepStrictEqual([...personas].sort(), ['designer', 'founder'], `${dest}: enrolled personas`);
    deepStrictEqual(SKILL_SLOTS.map((e) => `${e.dest}#${e.id}`), ['core/skills/start/SKILL.md#start-archetype'], 'the skill slots');
    for (const slot of SKILL_SLOTS) ok(EXTENSION_ANCHORS[slot.id], `anchor sentences for the skill slot ${slot.id}`);
  });

  for (const [dest, personas] of FILES) {
    const skill = skillOf(dest);
    for (const persona of [...personas].sort()) {
      for (const [which] of documents(persona, dest)) {
        describe(`${persona}/${dest} (${which})`, () => {
          const text = new Map(documents(persona, dest)).get(which);

          it('nothing is left unrendered, and the frontmatter stays first', () => {
            ok(!text.includes('{{'), 'a placeholder survived the render');
            ok(text.startsWith('---\n'), 'the file opens with its frontmatter');
            const close = text.indexOf('\n---\n', 4);
            ok(close > 0, 'the frontmatter closes');
            const first = text.indexOf('<!-- pipeline:');
            ok(first > close, 'every marker sits below the frontmatter');
          });

          it('the generated shell blocks name the plugin root only as <plugin-root>', () => {
            // Authored sections keep their own spelling (decide's and frame's
            // `<persona-plugin-root>`); the generated ones say `<plugin-root>`.
            const blocks = shellBlocks(generated(text));
            if (['checkpoint', 'peer-now'].includes(skill)) ok(blocks.length > 0, 'no generated shell block');
            for (const block of blocks) {
              ok(!/CLAUDE_PLUGIN_ROOT|AGENTIC_[A-Z_]*ROOT/.test(block), `${persona}/${skill}: a skill block names a host root variable:\n${block}`);
              for (const m of block.matchAll(/\S*\/scripts\/[a-z-]+\.mjs/g)) {
                ok(m[0].includes('<plugin-root>/scripts/'), `${persona}/${skill}: ${m[0]} does not start at <plugin-root>`);
              }
            }
          });

          it('every state.mjs subcommand a generated section names is one this persona\'s state.mjs dispatches', () => {
            const named = [...squash(generated(text)).matchAll(/state\.mjs"? (?:\\ )?([a-z][a-z-]*)/g)].map((m) => m[1]);
            const known = subcommands(persona);
            ok(known.size > 10, `${persona}: the state.mjs dispatch was not read`);
            for (const sub of named) ok(known.has(sub), `${persona}/${skill}: state.mjs has no subcommand ${sub}`);
          });

          const slots = SKILL_SLOTS.filter((e) => e.dest === dest && e.personas.includes(persona));
          if (slots.length > 0) {
            it('each extension this persona\'s slots hold states the sentences it exists for', () => {
              const exts = extensionTexts(text);
              for (const slot of slots) {
                const held = exts.filter((x) => x.id === slot.id);
                ok(held.length >= slot.min && held.length <= slot.max, `${slot.id}: ${held.length} marker(s)`);
                for (const ext of held) {
                  for (const sentence of EXTENSION_ANCHORS[slot.id]) ok(squash(ext.text).includes(sentence), `${slot.id}: ${sentence}`);
                }
              }
            });
          }

          if (COMMAND_RESOLUTION.includes(skill)) {
            it('the command-resolution table has one Plugin root row, and its Codex cell says where the root comes from', () => {
              const table = region(text, `${skill}-command-resolution`);
              const rows = pluginRootRows(table);
              strictEqual(rows.length, 1, 'Plugin root rows in the generated table');
              strictEqual(pluginRootRows(text).length, 1, 'Plugin root rows in the file');
              const [{ header, cells, codex }] = rows;
              strictEqual(cells.length, header.length, 'cells per row');
              deepStrictEqual(codexCellProblems(codex, persona, { skillsRel: SKILLS_REL, startMacro: true }), []);
              ok(cells[header.indexOf('Claude')].includes(`from \`${renderingDeclaration(declaration(persona)).derived.root_env}\` when set`), 'the Claude cell names this persona\'s root variable');
              ok(table.includes(`\`/${persona}:${skill}`) && table.includes(`\`$${persona}:${skill}`), 'the entry path names this persona\'s command and skill mention');
            });
          }

          if (skill === 'checkpoint') {
            it('the checkpoint is written to the workflow Phase 1 found, and comes back post-compact under this persona\'s marker', () => {
              const set = region(text, 'checkpoint-set');
              strictEqual([...set.matchAll(/state\.mjs" checkpoint-set \\\n\s+--workflow-path "\$ACTIVE" /g)].length, 1, 'checkpoint-set on $ACTIVE');
              strictEqual([...set.matchAll(/ --summary "\$SUMMARY"\n```/g)].length, 1, 'the summary goes as one quoted argument, the call\'s last');
              const tag = `[${metadataTag(persona)}]`;
              const hosts = squash(region(text, 'checkpoint-host-availability'));
              ok(hosts.includes('both hosts register the hook with `matcher: "compact"`, so this is **post-compact only**'), 'the re-injection row states the post-compact scope');
              ok(hosts.includes(tag), `the re-injection row names ${tag}`);
              ok(squash(region(text, 'checkpoint-outcomes')).includes(`as part of the \`${tag}\` marker`), `the outcomes name ${tag}`);
              for (const hooks of ['hooks/hooks.json', 'adapters/codex/hooks/hooks.json']) {
                const start = JSON.parse(readFileSync(join(pluginRoot(persona), hooks), 'utf8')).hooks.SessionStart;
                deepStrictEqual(start.map((h) => h.matcher), ['compact'], `${persona}/${hooks}: SessionStart registers matcher compact only`);
              }
            });
          }

          if (skill === 'peer-now') {
            it('the dispatch is synchronous, and a failed run stops before any phase note', () => {
              const dispatch = region(text, 'peer-now-dispatch');
              const [block] = shellBlocks(dispatch);
              ok(block, 'the dispatch block');
              strictEqual([...block.matchAll(/^node "<plugin-root>\/scripts\/peer-runner\.mjs" run \\$/gm)].length, 1, 'one runner call');
              ok(/ > "\$RUN_JSON" 2> "\$RUN_ERR"\nRUN_RC=\$\?\n/.test(block), 'the runner\'s exit code is read right after it, in the foreground');
              ok(!/&\s*$/m.test(block.replace(/&&|& 0x/g, '')), 'nothing runs in the background');
              const after = squash(dispatch.slice(dispatch.indexOf('RUN_RC=$?')));
              ok(after.includes('On `RUN_RC != 0`, surface the first line from `$RUN_ERR`') && after.includes('stop without appending a phase note and exit non-zero'), 'a failed run stops before the note');
              const call = block.slice(block.indexOf('node "<plugin-root>/scripts/peer-runner.mjs" run'), block.indexOf('RUN_RC=$?')).replace(/[ \t]*\\\n[ \t]*/g, ' ');
              for (const flag of ['--kind peer-now', '--run-id "$RUN_ID"', '--peer "$PEER"', '--output-format text', '--repo-root "$REPO_ROOT"']) ok(call.includes(` ${flag} `), `the runner call passes ${flag}`);
              for (const flag of ['--workflow-path', '--ensemble-type', '--phase']) ok(!call.includes(flag), `a side-channel run passes no ${flag}`);
              ok(squash(dispatch).includes('With `--kind peer-now`, it does NOT touch `pending_ensemble` or `ensemble_results`'), 'the prose says the run leaves the ensemble bookkeeping alone');
              const label = squash(region(text, 'peer-now-label'));
              ok(label.includes('Do NOT pass `--current-phase` / `--next-action`'), 'the note leaves the phase alone');
              ok(label.includes(`.agentic-plugins/state/${persona}/`) || dispatch.includes(`.agentic-plugins/state/${persona}/peer-runs/`), 'the ledger is this persona\'s');
            });
          }

          if (skill === 'resume') {
            it('the resume marker is a host-history append that moves no phase', () => {
              const marker = squash(region(text, 'resume-marker'));
              ok(marker.includes('via `state.mjs append --event resumed`'), 'the marker appends a resumed event');
              ok(marker.includes('**Skip** the marker append when the baseline is invalid'), 'an invalid baseline skips it');
              ok(marker.includes('Do NOT bump `current_phase` or `next_action`'), 'it moves no phase');
              ok(marker.includes(`\`${persona}:start\``), 'it names this persona\'s start');
              const dirty = squash(region(text, 'resume-dirty-enrichment'));
              const probes = ['`git log <BASE_HEAD>..HEAD --oneline`', '`git diff --stat HEAD`', '`git log --diff-filter=R --name-status <BASE_HEAD>..HEAD`', '`git log --diff-filter=D --name-status <BASE_HEAD>..HEAD`'];
              const guard = dirty.indexOf('`git cat-file -e <head>^{commit}`');
              ok(guard >= 0, 'the probes are guarded by the baseline validity check');
              let at = guard;
              for (const probe of probes) { const next = dirty.indexOf(probe); ok(next > at, `the probe ${probe}, in order, after the guard`); at = next; }
              ok(dirty.includes('If the baseline commit object is not available, skip all four probes'), 'a missing baseline skips every probe');
              ok(dirty.includes('non-zero exit prints `(probe failed:'), 'a failed probe says so');
              ok(dirty.includes('current plugin does not auto-reconcile; review and decide [resume / archive / abort]'), 'the no-auto-reconcile notice');
              const intake = squash(region(text, 'resume-intake'));
              ok(intake.includes(`\`/${persona}:resume\``) && intake.includes(`\`$${persona}:resume\``), 'the intake names this persona\'s entry points');
            });
          }

          if (skill === 'start') {
            it('start names only the Phase 0 steps its runbook runs, and the gates it states', () => {
              const intro = squash(region(text, 'start-command-intro'));
              const list = /^Phase 0 host-side bootstrap \(([^)]+)\) is owned by the entry path: `commands\/start\.md`/.exec(intro);
              ok(list, 'the intro lists the Phase 0 steps');
              const steps = list[1].split(', ');
              ok(steps.length >= 4, 'the steps were read');
              const runbook = readFileSync(join(pluginRoot(persona), 'commands', 'start.md'), 'utf8');
              for (const step of steps) {
                ok(Object.hasOwn(START_PHASE0, step), `${persona}/start: unknown Phase 0 step "${step}"`);
                ok(START_PHASE0[step].test(runbook), `${persona}/start: the intro names "${step}", which commands/start.md does not run`);
              }
              ok(intro.includes('Resume into the lifecycle only when `workflow_type == start`'), 'only a start workflow resumes');
              ok(intro.includes('only an explicit `clean` / `accepted` status proceeds'), 'the clean-baseline gate fails closed');
              ok(intro.includes(`(\`/${persona}:resume\`)`), 'it names this persona\'s resume');
            });
          }

          if (Object.hasOwn(SKILL_PRIVACY, skill)) {
            it('the privacy gate precedes the peer step: this persona\'s scope, the verb\'s prohibition, the spec it cites, the no-image rule where images are off', () => {
              const { prohibition, peerStep } = SKILL_PRIVACY[skill];
              const decl = declaration(persona);
              const gate = squash(region(text, `${skill}-privacy-gate`)).trim();
              ok(gate.startsWith(`PRIVACY GATE: ${decl.peer.privacy_scope} pass an explicit privacy gate before BOTH web search AND peer-host dispatch. `), 'the gate names this persona\'s scope');
              ok(gate.includes(` ${prohibition} `), 'the verb\'s prohibition');
              const cited = /See `([^`]+)` § Privacy Gate\.$/.exec(gate);
              ok(cited, 'the gate cites its spec');
              strictEqual(posix.join(SKILLS_REL, skill, cited[1]), decl.peer.privacy_spec, 'the citation, read from the skill\'s directory, is the declared spec');
              ok(existsSync(join(pluginRoot(persona), SKILLS_REL, skill, cited[1])), 'the cited spec exists');
              const noImage = parseRegions(text).regions.filter((r) => r.id === `${skill}-privacy-no-image`);
              strictEqual(noImage.length, decl.peer.images === false ? 1 : 0, 'the no-image region, exactly where images are off');
              for (const r of noImage) ok(squash(regionBody(text, r)).includes(NO_IMAGE), 'the no-image rule');
              const step = text.search(peerStep);
              ok(step > 0, 'the peer step heading');
              const last = text.indexOf(`<!-- pipeline:end ${skill}-privacy-${noImage.length > 0 ? 'no-image' : 'gate'} -->`);
              ok(last > 0 && last < step, 'the gate and the no-image rule precede the peer step');
              if (persona === 'designer') {
                const between = squash(text.slice(last, step));
                for (const sentence of SCREENSHOT[skill]) ok(between.includes(sentence), `designer's screenshot sentence follows the regions, before the peer step: ${sentence}`);
              }
            });
          }

          if (skill === 'compose' || skill === 'frame') {
            it(`${skill} confirms before any downstream verb`, () => {
              ok(squash(region(text, `${skill}-present`)).includes('confirm before downstream verbs'), 'the confirmation rule');
              if (skill === 'compose') {
                const write = squash(region(text, 'compose-state-write'));
                ok(write.includes(`When \`/${persona}:compose\` runs as a sub-step of a ${persona} workflow command, the invoking command writes the artifact + progress to its workflow file.`), 'the invoking command writes the state');
                ok(write.includes('This skill itself does not write workflow state. When invoked standalone, no workflow file write occurs.'), 'the skill writes none');
              }
            });
          }

          if (skill === 'decide') {
            it('decide waits for the user\'s explicit choice before anything downstream', () => {
              const gate = squash(region(text, 'decide-approval-gate'));
              ok(gate.includes('**Wait for the user to choose a direction** — do not proceed without explicit approval.'), 'the approval gate');
              const at = text.indexOf('<!-- pipeline:begin decide-approval-gate -->');
              const write = text.indexOf('### State write');
              ok(at > 0 && write > at, 'the gate precedes the state write');
            });
          }
        });
      }
    }
  }
});
