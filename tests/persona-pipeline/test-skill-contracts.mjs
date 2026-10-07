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
//   - each verb's finish paragraph: the command's last write, the footer and
//     the archive timing, by capability, its citations resolved in the
//     persona's own plugin, stated once and closing the Completion section;
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
const COMMAND_RESOLUTION = ['checkpoint', 'peer-now', 'resume', 'commit'];

// The commit surface's skill (PC3b U4): each Codex block is the Claude
// command's block, with `<plugin-root>` for the plugin root and
// `<claude|codex>` for the host; the pairs, skill region to command region.
const COMMIT_BLOCK_PAIRS = [
  ['commit-phase-0', 'commit-phase-0'],
  ['commit-plan', 'commit-plan'],
  ['commit-staging-clear', 'commit-staging-clear'],
  ['commit-execute', 'commit-execute'],
  ['commit-close', 'commit-close'],
];
const commitSurfaceOn = (persona) => declaration(persona).capabilities?.commit_surface === true;

/** A command block as its Codex skill states it: no resolver lines, the root and host as placeholders. */
function asSkillBlock(block) {
  const lines = block.split('\n');
  ok(/^ROOT_OVERRIDE="\$\(printenv '[A-Z_]+' \|\| true\)"$/.test(lines[0]), `the block opens with the resolver: ${lines[0]}`);
  ok(lines[1].startsWith('CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-') && lines[2].startsWith('[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT='), 'the resolver\'s three lines');
  return lines.slice(3).join('\n').replaceAll('"$CLAUDE_PLUGIN_ROOT/', '"<plugin-root>/').replaceAll('"${AGENTIC_HOST:-claude}"', '<claude|codex>');
}

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

// The verbs whose skill closes its Completion section with the finish
// paragraph (PC3b U3b, skill-verb-finish.md): founder's and designer's
// parenthetical and investigate's paragraph, and engineer's State-write
// paragraph and Session-level handoff section, were one fact in three wordings.
const FINISH_VERBS = ['compose', 'critique', 'decide', 'frame', 'investigate', 'refine'];

/**
 * The citations a section makes — a backticked `*.md` path and the `§`
 * heading after it, read from squashed text up to the punctuation that ends
 * it (so `Owner gates_missing` is read whole) — with the file each names: a
 * `../` path from the skill's own directory, a `core/…` path from the plugin
 * root.
 */
function sectionCitations(persona, skill, body) {
  return [...body.matchAll(/`([^`\s]+\.md)` § ([^.;:,()`]+?)(?=[.;:,()]|$)/g)].map(([, target, heading]) => ({
    target,
    heading: heading.trim(),
    file: target.startsWith('core/') ? join(pluginRoot(persona), target) : join(pluginRoot(persona), SKILLS_REL, skill, target),
  }));
}

// The convergent finish is a variant of the plain one, as the runbooks'
// convergent finalize is (test-runbook-contracts.mjs): its convergence
// paragraph, then the plain template byte for byte, so the two cannot drift.
describe('the convergent finish paragraph is the plain one after its convergence rule, nothing else (PC3b U3b)', () => {
  it('skill-verb-finish-convergent.md: its opening paragraph, then skill-verb-finish.md', () => {
    const read = (name) => readFileSync(join(REPO_ROOT, 'persona-pipeline', 'regions', name), 'utf8');
    const plain = read('skill-verb-finish.md');
    const variant = read('skill-verb-finish-convergent.md');
    const split = variant.indexOf('\n\n');
    ok(split > 0, 'the variant opens with its own paragraph');
    const opening = variant.slice(0, split);
    ok(opening.startsWith('This verb closes only once it converged (`terminal_requires_convergence`).'), 'the convergence rule');
    ok(!opening.includes('{{'), 'the convergence rule names no persona or capability');
    strictEqual(variant.slice(split + 2), plain, 'the rest is the plain template');
  });

  // PC3b U3c: start's finish, the same way; and its commit-surface variant
  // states the footer and the archive timing in the plain template's words.
  it('skill-start-finish-convergent.md: its opening paragraph, then skill-start-finish.md', () => {
    const read = (name) => readFileSync(join(REPO_ROOT, 'persona-pipeline', 'regions', name), 'utf8');
    const plain = read('skill-start-finish.md');
    const variant = read('skill-start-finish-convergent.md');
    const split = variant.indexOf('\n\n');
    ok(split > 0, 'the variant opens with its own paragraph');
    ok(variant.startsWith('This lifecycle closes only once Phase 4 converged'), 'the convergence rule');
    ok(!variant.slice(0, split).includes('{{'), 'the convergence rule names no persona or capability');
    strictEqual(variant.slice(split + 2), plain, 'the rest is the plain template');
  });

  it('skill-start-finish-commit.md: the footer and the archive timing are skill-start-finish.md\'s, byte for byte', () => {
    const read = (name) => readFileSync(join(REPO_ROOT, 'persona-pipeline', 'regions', name), 'utf8');
    const TAIL = 'The write fires the session-handoff sidecar';
    const tail = (text) => {
      const at = text.indexOf(TAIL);
      ok(at > 0, 'the shared footer and timing');
      return text.slice(at);
    };
    strictEqual(tail(read('skill-start-finish-commit.md')), tail(read('skill-start-finish.md')));
  });
});

describe('skill regions: the contracts hold for every enrolled persona', () => {
  it('the contracts reach the skill files they are about (guards a vacuous pass)', () => {
    deepStrictEqual([...FILES.keys()].map(skillOf).sort(), ['checkpoint', 'commit', 'compose', 'critique', 'decide', 'frame', 'investigate', 'peer-now', 'refine', 'resume', 'start']);
    // engineer's skills joined the regions one group at a time in Stage 3
    // (PC3 U7; start, compose, frame and decide in PC3b U3; critique, refine
    // and investigate with the finish paragraph in U3b). The commit skill is
    // the commit surface's (PC3b U4): every persona that declares it on.
    for (const [dest, personas] of FILES) {
      const expected = skillOf(dest) === 'commit' ? ['designer', 'engineer', 'founder'].filter(commitSurfaceOn) : ['designer', 'engineer', 'founder'];
      ok(expected.length > 0, `${dest}: no persona to check`);
      deepStrictEqual([...personas].sort(), expected, `${dest}: enrolled personas`);
    }
    deepStrictEqual(FINISH_VERBS.filter((v) => FILES.has(`${SKILLS_REL}/${v}/SKILL.md`)), FINISH_VERBS, 'every finish verb has a skill with regions');
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

          if (skill === 'commit') {
            it('each Codex block is the command\'s block, with <plugin-root> for the root and <claude|codex> for the host (PC3b U4)', () => {
              const dest = 'commands/commit.md';
              const committed = readFileSync(join(pluginRoot(persona), dest), 'utf8');
              const command = which === 'committed' ? committed : assembled(persona, dest, committed);
              for (const [skillId, commandId] of COMMIT_BLOCK_PAIRS) {
                const ours = shellBlocks(region(text, skillId));
                const theirs = shellBlocks(region(command, commandId));
                deepStrictEqual([ours.length, theirs.length], [1, 1], `${skillId}: one block each`);
                strictEqual(ours[0], asSkillBlock(theirs[0]), `${persona}/${skillId}: the Codex block drifted from the command's ${commandId}`);
              }
            });

            it('the host table and the blocks name each driver mode, the autopilot mode Claude-only exactly where dispatch_target is on (PC3b U4)', () => {
              const hosts = squash(region(text, 'commit-host-availability'));
              const dispatch = declaration(persona).capabilities?.dispatch_target === true;
              for (const s of ['`phase7-commit.mjs --mode plan` / `execute` / `close`', dispatch ? '`state.mjs autopilot-preflight` (mode + pending owner gate)' : '`state.mjs autopilot-preflight` (a pending owner gate)', `\`$${persona}:resume\` archives by hand`]) ok(hosts.includes(s), s);
              strictEqual(hosts.includes('`phase7-commit.mjs --mode autopilot`'), dispatch, 'the autopilot row');
              strictEqual(hosts.includes('autopilot mode is Claude-only (ADR-0063 D9); ignore it on Codex'), dispatch, 'Claude-only');
              for (const [id, mode] of [['commit-plan', 'plan'], ['commit-execute', 'execute'], ['commit-close', 'close']]) {
                strictEqual([...shellBlocks(region(text, id)).join('\n').matchAll(new RegExp(`phase7-commit\\.mjs" --mode ${mode} \\\\\\n`, 'g'))].length, 1, `${id}: --mode ${mode}`);
              }
              ok(shellBlocks(region(text, 'commit-phase-0'))[0].includes(' --surface commit || exit $?'), 'the commit surface\'s preflight');
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
              const commitSurface = declaration(persona).capabilities.commit_surface === true;
              strictEqual(steps.includes('redundancy probe'), commitSurface, 'the redundancy probe, exactly where the persona has a commit surface');
              ok(intro.includes('only an explicit `clean` / `accepted` status proceeds'), 'the clean-baseline gate fails closed');
              ok(intro.includes(`archives it (\`$${persona}:resume\`)`), 'it names this persona\'s resume');
              strictEqual(intro.includes(`commits it (\`$${persona}:commit\`)`), commitSurface, 'it names this persona\'s commit, exactly where it has one');
              ok(intro.includes('`--accept-current-tree true` once the user accepts the current tree'), 'the Codex check takes the accept flag');
              // An accepted tree is not remembered: Phase 7 is told again, in
              // both modes (plan-verify peer, PC3b U3).
              strictEqual(intro.includes('pass `--accept-current-tree` to both of its modes'), commitSurface, 'Phase 7 is passed the accept flag again, exactly where the persona has it');
              // PC2b RV3: the lifecycle rules, as the runbook's phase boundary states them.
              for (const rule of [
                'Phase 0 runs `state.mjs autopilot-preflight` once, before any write, and a resumed start workflow clears the next step it carried.',
                'Each phase\'s ensemble attempt is settled from its run ledger (`peer-runner.mjs settle`) before the next phase, a repeated phase under a new run id.',
                commitSurface
                  ? 'No phase makes a verb\'s terminal write; the lifecycle\'s one terminal write is the Phase 7 commit driver (`phase7-commit.mjs` in execute mode, which writes `set-terminal` last).'
                  : 'No phase makes a verb\'s terminal write; the lifecycle\'s one terminal write is `finish-verb` at the end',
                'is recorded with `state.mjs awaiting-owner-set`, which leaves the workflow open; the lifecycle pauses, and continues at the next phase once the owner\'s decision clears it (`state.mjs awaiting-owner-clear` with that phase as the next step and its action as the next action).',
              ]) ok(intro.includes(rule), rule);
            });

            // PC3b U2 (plan-verify peer, MAJOR), generated in U3: the Codex
            // entry follows the command's order — the guard, find-active and
            // the preflight before any write; a start workflow resumes with no
            // description and its next step cleared; any other is refused,
            // unwritten; only then the bootstrap (with a commit surface, the
            // args file read for the probe and then the bootstrap).
            it('the Codex entry runs the command\'s Phase 0 in its order', () => {
              const intro = squash(region(text, 'start-command-intro'));
              const commitSurface = declaration(persona).capabilities.commit_surface === true;
              const at = (needle) => {
                const i = intro.indexOf(needle);
                ok(i >= 0, `the intro names ${needle}`);
                return i;
              };
              const order = [
                at('Refuse a detached HEAD'),
                at('state.mjs find-active --repo-root <root>'),
                at('state.mjs autopilot-preflight --workflow-path <found> --host codex` before any write'),
                at('--clear-next-step true --event resumed'),
                at('typed conflict: refuse, writing nothing'),
                ...(commitSurface ? [at('state.mjs diagnose-redundancy --repo-root <root> --base-branch <ref>'), at('then, with a new args file, for the bootstrap')] : []),
                at('**clean-baseline gate** below, then `state.mjs create --workflow-type start --verb investigate --persona ' + persona + ' --original-request <the description>`'),
              ];
              deepStrictEqual(order, [...order].sort((a, b) => a - b), 'in the command\'s order');
              ok(intro.includes('no description is needed'), 'a resume reads no arguments');
              // Only a start workflow resumes (plan-verify peer, PC3b U3).
              ok(intro.includes('**Active-workflow branching.** `workflow_type` `start` → resume: `state.mjs append'), 'only workflow_type start resumes');
              ok(intro.includes('Any other workflow (`verb-chain`, or a legacy one without the field) → typed conflict: refuse, writing nothing, its owner gate included'), 'any other workflow is refused, its gate untouched');
              // The preflight only reports a gate; it is resolved and cleared
              // inside the start branch, never on a workflow the lifecycle
              // refuses (plan-verify peer, PC3b U3).
              ok(intro.includes('before any write: it reports a pending owner gate and writes nothing.'), 'the preflight writes nothing');
              const clear = at('clear it with the phase the lifecycle continues at');
              ok(clear > at('**Active-workflow branching.** `workflow_type` `start` → resume') && clear < at('Any other workflow (`verb-chain`'), 'the gate is cleared only on the start branch');
              strictEqual(intro.split('clear it with').length - 1, 1, 'one place says to clear the gate');
              strictEqual(intro.includes('scripts/start-args.mjs --args-file <path>'), commitSurface, 'the args file, exactly where the persona has a commit surface');
            });

            // PC3b U3c: the lifecycle's last write and its footer, one region
            // in three variants as the runbook's terminal is (start-terminal,
            // its convergent variant, start-commit). founder's and designer's
            // footer paragraph claimed the blanket detached-HEAD rule and named
            // ADR-0043 by stage; engineer's told Codex to hand-pass the
            // projection at completion beside the emitted footer.
            it('the finish paragraph states the lifecycle\'s last write, the footer and the archive timing, by declaration', () => {
              const commitSurface = declaration(persona).capabilities.commit_surface === true;
              const converges = declaration(persona).verbs?.start?.terminal_requires_convergence === true;
              const id = commitSurface ? 'start-finish-commit' : converges ? 'start-finish-convergent' : 'start-finish';
              for (const other of ['start-finish', 'start-finish-convergent', 'start-finish-commit'].filter((x) => x !== id)) {
                strictEqual(parseRegions(text).regions.filter((r) => r.id === other).length, 0, `only the variant the declaration selects, not ${other}`);
              }
              const body = region(text, id);
              const fin = squash(body);
              for (const sentence of [
                'The runtime completion footer is **code-emitted** on that terminal write (ADR-0039)',
                'The write fires the session-handoff sidecar, which renders the runtime `footer.mjs`, the ADR-0031 continue-vs-fresh session handoff included, on that command\'s stderr.',
                'It is advisory and pointer-only, and never mutates host session context.',
                `The workflow is then terminal, and the Stop hook archives it once every archive gate passes; until then \`/${persona}:start\` on this branch finds it and resumes it, so start the next deliverable after the archive, or on another branch.`,
                'Do not hand-compose a second footer or hand-pass the projection; surface the emitted one.',
                'On a detached HEAD the branch-based preflight reports "no active branch context" and never recommends a fresh session (ADR-0018 §sub-2); the path-targeted terminal sidecar renders the footer as on a branch, its continue-vs-fresh advice included.',
                `\`$${persona}:start\` on Codex surfaces the footer as \`/${persona}:start\` does.`,
                'On Claude the Stop hook fires at **every turn end**, so that terminal write puts the workflow in front of the archive gates at the end of **that same turn**, not at session close',
                'Clearing the marker (`--terminal-marker false`, with set-terminal\'s full flag set) works only before that Stop fires and does not restore the previous phase.',
                'On Codex the hook runs only once the operator has trusted the plugin hooks (`/hooks`), so evaluation waits.',
              ]) ok(fin.includes(sentence), sentence);
              strictEqual(fin.startsWith('This lifecycle closes only once Phase 4 converged (`terminal_requires_convergence`). Not converged, it leaves the workflow open and prints no footer: the last write is an `append` that records the next step resolving the flagged item (`refine`, `decide` or `investigate`) and turns off a terminal marker an earlier write left (`--clear-terminal-marker true`), so the Stop hook cannot archive it. Converged, it ends as follows.'), converges, 'the convergence rule opens the paragraph, exactly where the lifecycle waits for convergence');
              strictEqual(fin.includes('The lifecycle\'s one terminal write is the Phase 7 driver in execute mode (`phase7-commit.mjs`): it commits, runs the post-commit gates and the P10 parent writeback, and writes `set-terminal` last; no `finish-verb` runs.'), commitSurface, 'the Phase 7 driver, exactly where the persona has a commit surface');
              strictEqual(fin.includes('decide before running execute mode whether the workflow may close in this turn'), commitSurface, 'the decision before execute mode, exactly where the driver writes the marker');
              strictEqual(fin.includes('records its next step in closed-enum form, `--next-step-kind commit`: the owner saves and commits the deliverable'), !commitSurface, 'finish-verb kind commit, exactly where the owner commits');
              // Which ADR enabled a persona's footer is history, not a
              // capability (PC3b U5a review): the paragraph names ADR-0039
              // alone, and session-handoff.md's title keeps the provenance.
              ok(!/ADR-0043/.test(fin), 'no ADR-0043 attribution');
              strictEqual(fin.includes('(ADR-0039): its completion state is `publish-needed` while only the owner\'s save and commit remain'), !commitSurface, 'the publish-needed mapping, exactly where the owner commits');
              // The terminal write the skill shows is the runbook's: the same
              // call, next step and next action (both from the declaration).
              const runbook = readFileSync(join(pluginRoot(persona), 'commands', 'start.md'), 'utf8');
              const calls = shellBlocks(body).filter((b) => b.includes('state.mjs" finish-verb'));
              const runbookCalls = shellBlocks(runbook).filter((b) => b.includes('state.mjs" finish-verb'));
              strictEqual(calls.length, commitSurface ? 0 : 1, 'one finish-verb block, exactly where the lifecycle ends with it');
              strictEqual(runbookCalls.length, commitSurface ? 0 : 1, 'and the runbook\'s');
              if (!commitSurface) {
                const nextAction = (block) => /--next-action ('(?:[^']|'\\'')*')/.exec(block)?.[1];
                ok(nextAction(calls[0]), 'the skill block names its next action');
                strictEqual(nextAction(calls[0]), nextAction(runbookCalls[0]), 'the skill shows the runbook\'s next action');
                ok(/--next-step-kind commit --next-step-confidence "<HIGH\|MEDIUM\|LOW>" \|\| exit \$\?$/.test(calls[0].trim()), 'kind commit, and a failed write stops');
              }
              // Each section it cites is a heading of a file this persona ships.
              const cites = sectionCitations(persona, skill, fin);
              deepStrictEqual(cites.map((c) => c.heading), ['Archive timing'], 'the sections the paragraph cites');
              for (const c of cites) {
                ok(existsSync(c.file), `${persona}/start: ${c.target} is not in the plugin`);
                ok(new RegExp(`^#{1,6} ${c.heading}(?![\\w-])`, 'm').test(readFileSync(c.file, 'utf8')), `${persona}/start: ${c.target} has no § ${c.heading}`);
              }
              // It closes the terminal step, and nothing outside it says the
              // same again.
              const begin = text.indexOf(`<!-- pipeline:begin ${id} -->`);
              const end = text.indexOf(`<!-- pipeline:end ${id} -->`);
              const heading = text.lastIndexOf('\n### ', begin);
              ok(text.slice(heading + 1).startsWith(commitSurface ? '### Phase 7 — Commit' : '### Terminal — present + save'), 'the paragraph sits in the terminal step');
              const next = text.indexOf('\n## ', end);
              ok(next > end && !/\S/.test(text.slice(end, next).replace(`<!-- pipeline:end ${id} -->`, '').replace(/^---$/m, '')), 'and closes it');
              const outside = squash(text.slice(0, begin) + text.slice(end));
              for (const fact of [/code-emit/i, /every turn end/i, /hand-pass/i, /hand-compose/i, /fires the session-handoff sidecar/i, /never mutates host session context/i, /--workflow-projection-file/, /ADR-0043 S\d/, /Detached HEAD never auto-recommends/i, /preflight is what reports/i, /sidecar reports "no active branch context"/i, /Surface the ADR-0031 session-level continue-vs-fresh preflight at this completion/i]) {
                ok(!fact.test(outside), `${persona}/start: ${fact} stated again outside the paragraph`);
              }
            });
          }

          // A persona that declares no peer policy (engineer) holds no privacy
          // gate in its skills, as in its runbooks.
          if (Object.hasOwn(SKILL_PRIVACY, skill) && !declaration(persona).peer) {
            it('no privacy gate where the persona declares no peer policy', () => {
              strictEqual(parseRegions(text).regions.filter((r) => r.id.startsWith(`${skill}-privacy-`)).length, 0, 'privacy regions');
            });
          }

          if (Object.hasOwn(SKILL_PRIVACY, skill) && declaration(persona).peer) {
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
                ok(write.includes(`When \`/${persona}:compose\` runs as a sub-step of another ${persona} workflow command, the invoking command writes the artifact + progress to its workflow file.`), 'the invoking command writes the state');
                ok(write.includes('When invoked standalone, no workflow file write occurs.'), 'standalone, nothing is written');
                // With a commit surface the code profile records each file it
                // writes into commit_manifest, which the skill does itself
                // (plan-verify peer, PC3b U3): the region must not deny it.
                if (declaration(persona).capabilities.commit_surface === true) {
                  ok(!write.includes('does not write workflow state'), 'the skill does not deny its manifest write');
                  ok(write.includes('its one workflow write is the `code` profile\'s commit-manifest recording below'), 'the manifest write is named');
                  const below = text.slice(text.indexOf('<!-- pipeline:end compose-state-write -->'));
                  ok(/^### Layer 2 commit-manifest recording/m.test(below) && below.includes('state.mjs" record-composed-file'), 'the recording it names follows');
                } else {
                  ok(write.includes('This skill itself does not write workflow state.'), 'the skill writes none');
                }
              }
            });
          }

          if (skill === 'decide') {
            it('decide waits for the user\'s explicit choice before anything downstream', () => {
              const gate = squash(region(text, 'decide-approval-gate'));
              ok(gate.includes('**Wait for the user to choose a direction** — do not proceed without explicit approval.'), 'the approval gate');
              // PC3b U3: with dispatch_target an autopilot run has no one to
              // choose; the recommendation is recorded as the next step and a
              // CONFLICT stops at its owner gate.
              const autopilot = declaration(persona).capabilities.dispatch_target === true;
              strictEqual(gate.includes('**Autopilot mode (Claude only, ADR-0063 D4 / R4):** there is no one to choose, so do not wait.'), autopilot, 'the autopilot rule, exactly where the persona has autopilot');
              strictEqual(gate.includes('A CONFLICT stops at the `decide-conflict` owner gate'), autopilot, 'a CONFLICT under autopilot stops at its gate');
              const at = text.indexOf('<!-- pipeline:begin decide-approval-gate -->');
              const write = text.indexOf('### State write');
              ok(at > 0 && write > at, 'the gate precedes the state write');
            });
          }

          if (FINISH_VERBS.includes(skill)) {
            it('the finish paragraph states the command\'s last write, the footer and the archive timing, by capability', () => {
              const caps = declaration(persona).capabilities;
              // A verb that closes only once it converged (designer's refine)
              // renders the convergent variant: not converged, its last write
              // is an append that leaves the workflow open (verb-finalize-convergent.md).
              const converges = declaration(persona).verbs?.[skill]?.terminal_requires_convergence === true;
              const id = converges ? `${skill}-finish-convergent` : `${skill}-finish`;
              strictEqual(parseRegions(text).regions.filter((r) => r.id === (converges ? `${skill}-finish` : `${skill}-finish-convergent`)).length, 0, 'only the variant the declaration selects');
              const fin = squash(region(text, id));
              // Its exits as the command's convergent finalize and Owner
              // decision make them (plan-verify peer, PC3b U3b): an owner gate,
              // the finalize's append, the deferral's awaiting-owner-clear.
              strictEqual(fin.startsWith(`This verb closes only once it converged (\`terminal_requires_convergence\`). Not converged, it leaves the workflow open and prints no footer: unless an owner gate ends it, the finalize's last write is an \`append\` that records the next step resolving the flagged item (\`refine\`, \`decide\` or \`investigate\`) and turns off a terminal marker an earlier verb left, so the Stop hook cannot archive it; an owner's deferral of a recurring finding is cleared with that next step (\`awaiting-owner-clear\`), and no terminal write is made. Converged, it ends as follows. Run by \`/${persona}:${skill}\``), converges, 'the convergence rule opens the paragraph, exactly where the verb waits for convergence');
              if (converges) {
                const runbook = readFileSync(join(pluginRoot(persona), 'commands', `${skill}.md`), 'utf8');
                ok(runbook.includes(`<!-- pipeline:begin ${skill}-finalize-convergent -->`), 'the command closes only once converged too');
                ok(runbook.includes(`<!-- pipeline:begin ${skill}-owner-decision-convergent -->`) && /\n  # Not converged: the gate is cleared with the next step that resolves what\n  # is still open, and no terminal write is made\.\n  node "\$CLAUDE_PLUGIN_ROOT\/scripts\/state\.mjs" awaiting-owner-clear \\\n/.test(runbook), 'and its unconverged deferral clears the gate with no terminal write');
              }
              for (const sentence of [
                `Run by \`/${persona}:${skill}\`, the command's last write, \`state.mjs finish-verb\`, records this proposal's closed-enum form — \`next_step_kind\`, \`next_step_verb\` and \`next_step_confidence\` (ADR-0063 D6;`,
                'the fields are host-shared. Unless it ends with an owner gate, that write is terminal.',
                `Inside \`/${persona}:start\` no phase makes a verb's terminal write: the lifecycle makes its one terminal write at its end.`,
                'A standalone skill invocation writes no workflow state and emits no footer.',
                'The runtime completion footer is **code-emitted** on that terminal write (ADR-0039): its completion state is',
                'Do not hand-compose a second footer or hand-pass the projection; surface the emitted one.',
                // The sidecar is path-targeted (ADR-0043 §2): on a detached
                // HEAD it renders under the runtime's usual continue-vs-fresh
                // policy; only the branch preflight reports no branch context
                // and recommends no fresh session (engineer's skill said the
                // sidecar did; plan-verify peer, PC3b U3b, measured the rest).
                'On a detached HEAD the branch-based preflight reports "no active branch context" and never recommends a fresh session (ADR-0018 §sub-2); the path-targeted terminal sidecar renders the footer as on a branch, its continue-vs-fresh advice included.',
                `\`$${persona}:${skill}\` on Codex surfaces the footer as \`/${persona}:${skill}\` does.`,
                'On Claude the Stop hook fires at **every turn end**, so that terminal write puts the workflow in front of the archive gates at the end of **that same turn**, not at session close',
                'Clearing the marker (`--terminal-marker false`, with set-terminal\'s full flag set) works only before that Stop fires and does not restore the previous phase.',
                'On Codex the hook runs only once the operator has trusted the plugin hooks (`/hooks`), so evaluation waits.',
              ]) ok(fin.includes(sentence), sentence);
              const autopilot = caps.dispatch_target === true;
              strictEqual(fin.includes('is Claude-only (ADR-0063); ignore it on Codex.'), autopilot, 'autopilot is Claude-only, said exactly where the persona has it');
              strictEqual(fin.includes('Under an autopilot run `finish-verb` writes the next step only and leaves the terminal marker for the commit command, which alone closes a workflow there, so no footer is printed'), autopilot, 'an autopilot write is not terminal and prints no footer, exactly where the persona has autopilot');
              const commit = caps.commit_surface === true;
              strictEqual(fin.includes('its completion state is `blocked`, with the commit as its unblocking action, when only the commit remains'), commit, 'the blocked mapping, exactly where the persona has a commit surface');
              strictEqual(fin.includes(`\`/${persona}:commit\` commits the change, or closes the workflow when there is none.`), commit, 'the commit command, exactly where the persona has one');
              strictEqual(fin.includes('its completion state is `publish-needed` when only the owner\'s save and commit remain'), !commit, 'the publish-needed mapping, exactly where the owner commits');
              // Which ADR enabled a persona's footer is history, not a
              // capability (PC3b U5a review): ADR-0039 alone, for every persona.
              ok(!/ADR-0043/.test(fin), 'no ADR-0043 attribution');
              // Each section it cites is a heading of a file this persona ships.
              const cites = sectionCitations(persona, skill, fin);
              deepStrictEqual(cites.map((c) => c.heading).sort(), ['Active Next-Action Proposal', 'Archive timing', 'Owner gates'], 'the sections the paragraph cites');
              for (const c of cites) {
                // Inside this persona's plugin (a `../` path can leave it).
                const root = pluginRoot(persona);
                ok(posix.normalize(c.file.split('\\').join('/')).startsWith(`${root.split('\\').join('/')}/`), `${persona}/${skill}: ${c.target} leaves the plugin`);
                ok(existsSync(c.file), `${persona}/${skill}: ${c.target} is not in the plugin`);
                const heading = new RegExp(`^#{1,6} ${c.heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'm');
                ok(heading.test(readFileSync(c.file, 'utf8')), `${persona}/${skill}: ${c.target} has no § ${c.heading}`);
              }
              // It closes the Completion section, and nothing outside it says
              // the same again (engineer said it twice, in two wordings).
              const head = text.indexOf('\n## Completion — Active Next-Action Proposal\n');
              const begin = text.indexOf(`<!-- pipeline:begin ${id} -->`);
              const end = text.indexOf(`<!-- pipeline:end ${id} -->`);
              const next = text.indexOf('\n## ', head + 1);
              ok(head > 0 && begin > head && (next < 0 || end < next), 'the paragraph sits in the Completion section');
              ok(!/\S/.test(text.slice(end, next < 0 ? text.length : next).replace(`<!-- pipeline:end ${id} -->`, '').replace(/^---$/m, '')), 'and closes it');
              const outside = squash(text.slice(0, begin) + text.slice(end));
              // The facts, and the section and claim the paragraph replaced
              // (plan-verify peer, PC3b U3b: a re-added section with the old
              // detached-HEAD claim held none of the four facts).
              for (const fact of [/code-emitted/i, /every turn end/i, /`next_step_confidence`/, /closed-enum/, /Session-level handoff preflight/i, /sidecar reports "no active branch context"/i, /auto-recommend/i]) {
                ok(!fact.test(outside), `${persona}/${skill}: ${fact} stated again outside the paragraph`);
              }
            });
          }
        });
      }
    }
  }
});
