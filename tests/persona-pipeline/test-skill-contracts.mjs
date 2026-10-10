// Skill contracts over the generated SKILL.md regions (ADR-0066 Decision 5).
//
// On Codex a persona's SKILL.md is the runbook for its skill mention: Codex
// injects the file byte for byte and substitutes nothing, and its shell blocks
// name the plugin root as `<plugin-root>`. This family checks what a host or
// the agent acts on, over each persona's committed SKILL.md and over the one
// assembled from the templates (what the next `--write` would produce):
//
//   - the frontmatter stays first, and nothing is left unrendered;
//   - generated shell blocks name the plugin root only as `<plugin-root>`;
//   - every `state.mjs` subcommand a region names is one the persona's own
//     `state.mjs` dispatches;
//   - the command-resolution table's Plugin root row, per document;
//   - the calls, flags, order and stops a region gives the agent: the
//     checkpoint call, peer-now's synchronous dispatch and its stop, resume's
//     marker and probe order, start's Codex Phase 0 order and lifecycle calls,
//     compose's state-write limit, decide's approval gate, the commit skill's
//     blocks, and the finish paragraph's terminal write and handoff command,
//     each by capability;
//   - the privacy gate (its scope, the genericizing rule, no `--image`) before
//     the peer step, its spec citation resolved from the skill's own directory;
//   - the sections the finish paragraphs cite resolve inside the plugin;
//   - each extension a skill slot holds carries the command it exists for.
//
// Each assertion is bound to its region with a nonzero count, so a contract
// that matches nothing fails instead of passing.

import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
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

const FILES = skillFiles();
const COMMAND_RESOLUTION = ['checkpoint', 'peer-now', 'resume', 'commit'];

// The commit surface's skill: each Codex block is the Claude command's block,
// with `<plugin-root>` for the plugin root and `<claude|codex>` for the host;
// the pairs, skill region to command region.
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
  // The three resolver lines the Codex block leaves out; a command block that
  // does not open with them would be compared from the wrong line.
  ok(/^ROOT_OVERRIDE="\$\(printenv '[A-Z_]+' \|\| true\)"$/.test(lines[0]), `the block opens with the resolver: ${lines[0]}`);
  ok(lines[1].startsWith('CLAUDE_PLUGIN_ROOT="${ROOT_OVERRIDE:-') && lines[2].startsWith('[ -n "$CLAUDE_PLUGIN_ROOT" ] || CLAUDE_PLUGIN_ROOT='), 'the resolver\'s three lines');
  return lines.slice(3).join('\n').replaceAll('"$CLAUDE_PLUGIN_ROOT/', '"<plugin-root>/').replaceAll('"${AGENTIC_HOST:-claude}"', '<claude|codex>');
}

// The privacy gate a skill states before its peer step: the verb's
// prohibition sentence (the manifest's value, the runbook's sentence), and the
// heading of the step that calls the peer, which the gate must precede.
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
const NO_IMAGE = 'No dispatch passes `--image`';
// designer's screenshot rule, authored right after the regions: what it keeps
// from the peer.
const SCREENSHOT = {
  critique: 'is **never sent to the peer as inline image bytes**',
  refine: 'is **never sent to the peer as inline image bytes**',
  start: 'is read host-direct and never leaves the local host as bytes',
};

// Each extension a skill slot holds: the command its authored text must carry,
// so a marker left without what it stands for fails. Every skill slot in the
// manifest needs an entry.
const EXTENSION_ANCHORS = {
  'start-archetype': ['`AGENTIC_DESIGNER_PROFILE="<archetype>" node …/decide-registry.mjs resolve --args-file …`'],
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
// paragraph (skill-verb-finish.md).
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

describe('skill regions: the contracts hold for every enrolled persona', () => {
  it('the contracts reach the skill files they are about (guards a vacuous pass)', () => {
    // Contract: persona-pipeline/manifest.json, which the generator reads — a
    // skill, persona or slot dropped from it leaves the checks below nothing to run on.
    deepStrictEqual([...FILES.keys()].map(skillOf).sort(), ['checkpoint', 'commit', 'compose', 'critique', 'decide', 'frame', 'investigate', 'peer-now', 'refine', 'resume', 'start']);
    // The commit skill is the commit surface's: every persona that declares it on.
    for (const [dest, personas] of FILES) {
      const expected = skillOf(dest) === 'commit' ? ['designer', 'engineer', 'founder'].filter(commitSurfaceOn) : ['designer', 'engineer', 'founder'];
      ok(expected.length > 0, `${dest}: no persona to check`);
      deepStrictEqual([...personas].sort(), expected, `${dest}: enrolled personas`);
    }
    deepStrictEqual(FINISH_VERBS.filter((v) => FILES.has(`${SKILLS_REL}/${v}/SKILL.md`)), FINISH_VERBS, 'every finish verb has a skill with regions');
    deepStrictEqual(SKILL_SLOTS.map((e) => `${e.dest}#${e.id}`), ['core/skills/start/SKILL.md#start-archetype'], 'the skill slots');
    for (const slot of SKILL_SLOTS) ok(EXTENSION_ANCHORS[slot.id], `anchor commands for the skill slot ${slot.id}`);
  });

  for (const [dest, personas] of FILES) {
    const skill = skillOf(dest);
    for (const persona of [...personas].sort()) {
      for (const [which] of documents(persona, dest)) {
        describe(`${persona}/${dest} (${which})`, () => {
          const text = new Map(documents(persona, dest)).get(which);

          it('nothing is left unrendered, and the frontmatter stays first', () => {
            // Contract: the generator's render — a `{{…}}` left behind reaches the agent as literal text.
            ok(!text.includes('{{'), 'a placeholder survived the render');
            // Contract: Codex reads `name` and `description` from the frontmatter that opens the
            // file — no opening or closing `---`, or a marker above it, and the skill is not found.
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
              // Contract: the agent running these blocks on Codex — a host root variable is unset
              // there, so a script path built from it resolves nowhere.
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
            // Contract: state.mjs's dispatch — a subcommand it lacks exits 2 when the agent runs it.
            for (const sub of named) ok(known.has(sub), `${persona}/${skill}: state.mjs has no subcommand ${sub}`);
          });

          const slots = SKILL_SLOTS.filter((e) => e.dest === dest && e.personas.includes(persona));
          if (slots.length > 0) {
            it('each extension this persona\'s slots hold carries the command it exists for', () => {
              const exts = extensionTexts(text);
              for (const slot of slots) {
                const held = exts.filter((x) => x.id === slot.id);
                // Contract: the manifest's slot bounds, which the generator enforces on the markers.
                ok(held.length >= slot.min && held.length <= slot.max, `${slot.id}: ${held.length} marker(s)`);
                for (const ext of held) {
                  // Contract: the agent resolving designer's preset in Phase 1c — without the inline
                  // AGENTIC_DESIGNER_PROFILE prefix, the archetype is gone in that later block.
                  for (const command of EXTENSION_ANCHORS[slot.id]) ok(squash(ext.text).includes(command), `${slot.id}: ${command}`);
                }
              }
            });
          }

          if (COMMAND_RESOLUTION.includes(skill)) {
            it('the command-resolution table has one Plugin root row, and its Codex cell says where the root comes from', () => {
              const table = region(text, `${skill}-command-resolution`);
              const rows = pluginRootRows(table);
              // Contract: the agent deriving `<plugin-root>` on Codex reads one row — two can
              // disagree, and cells that do not line up put the Codex cell under another host.
              strictEqual(rows.length, 1, 'Plugin root rows in the generated table');
              strictEqual(pluginRootRows(text).length, 1, 'Plugin root rows in the file');
              const [{ header, cells, codex }] = rows;
              strictEqual(cells.length, header.length, 'cells per row');
              // Contract: the agent deriving `<plugin-root>` on Codex — the cell gives the path
              // every block runs its scripts under (the shared cell check, tests/_plugin-root-cell.mjs).
              deepStrictEqual(codexCellProblems(codex, persona, { skillsRel: SKILLS_REL, startMacro: true }), []);
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
                // Contract: the agent running $<persona>:commit on Codex — a block that drifts from
                // the command's runs another driver call than /<persona>:commit does.
                strictEqual(ours[0], asSkillBlock(theirs[0]), `${persona}/${skillId}: the Codex block drifted from the command's ${commandId}`);
              }
            });

            it('the blocks run each driver mode, and Codex is told to ignore autopilot mode exactly where dispatch_target is on', () => {
              const dispatch = declaration(persona).capabilities?.dispatch_target === true;
              // Contract: the Codex agent running $<persona>:commit — autopilot mode is Claude-only,
              // so a Codex run must not call the driver in it.
              strictEqual(squash(region(text, 'commit-host-availability')).includes('ignore it on Codex'), dispatch, 'autopilot mode is Claude-only');
              // Contract: the agent running each block — another --mode runs another driver step.
              for (const [id, mode] of [['commit-plan', 'plan'], ['commit-execute', 'execute'], ['commit-close', 'close']]) {
                strictEqual([...shellBlocks(region(text, id)).join('\n').matchAll(new RegExp(`phase7-commit\\.mjs" --mode ${mode} \\\\\\n`, 'g'))].length, 1, `${id}: --mode ${mode}`);
              }
              // Contract: the commit's preflight call — --surface commit selects its own rules, and
              // `|| exit $?` stops the commit when the preflight refuses.
              ok(shellBlocks(region(text, 'commit-phase-0'))[0].includes(' --surface commit || exit $?'), 'the commit surface\'s preflight');
            });
          }

          if (skill === 'checkpoint') {
            it('the checkpoint is written to the workflow Phase 1 found, and SessionStart re-injects it post-compact only', () => {
              const set = region(text, 'checkpoint-set');
              // Contract: the agent running checkpoint-set — any variable but $ACTIVE is one no step
              // set, so the summary goes to no workflow.
              strictEqual([...set.matchAll(/state\.mjs" checkpoint-set \\\n\s+--workflow-path "\$ACTIVE" /g)].length, 1, 'checkpoint-set on $ACTIVE');
              // Contract (ADR-0059, amendment of 2026-10-10): checkpoint-set requires a summary, the
              // text the user typed — it goes as the file the agent wrote, never on the command line,
              // where the shell would split or run it.
              strictEqual([...set.matchAll(/ --summary-file "\$TEXT_DIR\/summary\.txt"\n```/g)].length, 1, 'the summary goes as the agent\'s file, the call\'s last');
              ok(set.includes("TEXT_DIR='<directory from step 1>'\n") && set.includes('mktemp -d "${TMPDIR:-/tmp}/agentic-text.XXXXXX"') && squash(set).includes('With your file-writing tool, not the shell, create `summary.txt`'), 'the steps that write it');
              ok(!/--summary "|single quoted argument/.test(set), 'no inline summary left');
              // Contract: hooks.json, read by both hosts — a SessionStart matcher other than compact
              // re-injects the checkpoint on every session start.
              for (const hooks of ['hooks/hooks.json', 'adapters/codex/hooks/hooks.json']) {
                const start = JSON.parse(readFileSync(join(pluginRoot(persona), hooks), 'utf8')).hooks.SessionStart;
                deepStrictEqual(start.map((h) => h.matcher), ['compact'], `${persona}/${hooks}: SessionStart registers matcher compact only`);
              }
            });
          }

          if (skill === 'peer-now') {
            it('the dispatch is synchronous, and a failed run stops before any phase note', () => {
              const dispatch = region(text, 'peer-now-dispatch');
              // The region's first block is the mktemp step; the dispatch is the runner's.
              const block = shellBlocks(dispatch).find((b) => b.includes('/scripts/peer-runner.mjs" run'));
              ok(block, 'the dispatch block');
              // Contract: the agent running the dispatch block — one runner call, its exit code read
              // in the foreground; backgrounded, RUN_RC is the launch's status, not the run's.
              strictEqual([...block.matchAll(/^node "<plugin-root>\/scripts\/peer-runner\.mjs" run \\$/gm)].length, 1, 'one runner call');
              ok(/ > "\$RUN_JSON" 2> "\$RUN_ERR"\nRUN_RC=\$\?\n/.test(block), 'the runner\'s exit code is read right after it, in the foreground');
              ok(!/&\s*$/m.test(block.replace(/&&|& 0x/g, '')), 'nothing runs in the background');
              // Contract (ADR-0059, amendment of 2026-10-10): the agent passing either prompt
              // form — both are the prompt.xml it wrote; a --prompt-file's path pasted into the
              // block would be the user's text read as shell source.
              ok(block.startsWith("TEXT_DIR='<directory from step 1>'\n"), 'the block names the text directory first');
              deepStrictEqual(block.match(/^PROMPT_FILE=.*$/gm), ['PROMPT_FILE="$TEXT_DIR/prompt.xml"'], 'the prompt is the agent\'s prompt.xml');
              // Contract: the agent after a failed run — it stops, and appends no phase note for a
              // run that answered nothing.
              const after = squash(dispatch.slice(dispatch.indexOf('RUN_RC=$?')));
              ok(/On `RUN_RC != 0`.*stop without appending a phase note and exit non-zero/.test(after), 'a failed run stops before the note');
              const call = block.slice(block.indexOf('node "<plugin-root>/scripts/peer-runner.mjs" run'), block.indexOf('RUN_RC=$?')).replace(/[ \t]*\\\n[ \t]*/g, ' ');
              // Contract: peer-runner.mjs run's arguments — --kind peer-now keeps the run off the
              // workflow's ensemble bookkeeping, which a workflow flag would book it into.
              for (const flag of ['--kind peer-now', '--run-id "$RUN_ID"', '--peer "$PEER"', '--output-format text', '--repo-root "$REPO_ROOT"']) ok(call.includes(` ${flag} `), `the runner call passes ${flag}`);
              for (const flag of ['--workflow-path', '--ensemble-type', '--phase']) ok(!call.includes(flag), `a side-channel run passes no ${flag}`);
              // Contract: the note's state.mjs append — --current-phase or --next-action would move
              // the workflow for a side-channel consultation.
              ok(squash(region(text, 'peer-now-label')).includes('Do NOT pass `--current-phase` / `--next-action`'), 'the note leaves the phase alone');
            });
          }

          if (skill === 'resume') {
            it('the resume marker is a host-history append that moves no phase', () => {
              const marker = squash(region(text, 'resume-marker'));
              // Contract: the agent writing the marker — --event resumed, only on a valid baseline,
              // and no phase flags on the append.
              ok(marker.includes('`state.mjs append --event resumed`'), 'the marker appends a resumed event');
              ok(marker.includes('**Skip** the marker append when the baseline is invalid'), 'an invalid baseline skips it');
              ok(marker.includes('Do NOT bump `current_phase` or `next_action`'), 'it moves no phase');
              const dirty = squash(region(text, 'resume-dirty-enrichment'));
              // Contract: the agent running the dirty probes — the baseline check first, so no probe
              // runs against a commit that is not there, then the four probes in order.
              const probes = ['`git log <BASE_HEAD>..HEAD --oneline`', '`git diff --stat HEAD`', '`git log --diff-filter=R --name-status <BASE_HEAD>..HEAD`', '`git log --diff-filter=D --name-status <BASE_HEAD>..HEAD`'];
              const guard = dirty.indexOf('`git cat-file -e <head>^{commit}`');
              ok(guard >= 0, 'the probes are guarded by the baseline validity check');
              let at = guard;
              for (const probe of probes) { const next = dirty.indexOf(probe); ok(next > at, `the probe ${probe}, in order, after the guard`); at = next; }
              ok(dirty.includes('If the baseline commit object is not available, skip all four probes'), 'a missing baseline skips every probe');
            });
          }

          if (skill === 'start') {
            it('start\'s intro gives the clean-baseline gate, the handoff commands, the accept flag and the lifecycle\'s calls', () => {
              const intro = squash(region(text, 'start-command-intro'));
              const commitSurface = declaration(persona).capabilities.commit_surface === true;
              // Contract: the agent running the clean-baseline gate — any status but clean or
              // accepted stops the bootstrap (it fails closed).
              ok(intro.includes('only an explicit `clean` / `accepted` status proceeds'), 'the clean-baseline gate fails closed');
              // Contract: the handoff for a refused workflow — a command the persona lacks sends the
              // user nowhere.
              ok(intro.includes(`archives it (\`$${persona}:resume\`)`), 'it names this persona\'s resume');
              strictEqual(intro.includes(`commits it (\`$${persona}:commit\`)`), commitSurface, 'it names this persona\'s commit, exactly where it has one');
              // Contract: the accept flag on check-clean-baseline, and again on both Phase 7 modes —
              // an accepted tree is not remembered, so a mode run without it stages only the manifest.
              // The flag is passed only once the user accepts the tree: the CLI takes the flag as the
              // consent and checks nothing else, so an agent passing it unasked bootstraps over
              // (and later commits) a dirty tree nobody accepted.
              ok(intro.includes('`--accept-current-tree true` once the user accepts the current tree'), 'the Codex check takes the accept flag, only on the user\'s acceptance');
              strictEqual(intro.includes('pass `--accept-current-tree` to both of its modes'), commitSurface, 'Phase 7 is passed the accept flag again, exactly where the persona has it');
              // Contract: the agent between phases — each phase's attempt is settled before the next.
              ok(intro.includes('(`peer-runner.mjs settle`) before the next phase'), 'each phase is settled before the next');
              // Contract: the lifecycle's one terminal write — a phase that runs finish-verb closes
              // the lifecycle mid-way; with a commit surface the Phase 7 driver closes it instead.
              ok(intro.includes('No phase makes a verb\'s terminal write'), 'no phase makes a terminal write');
              strictEqual(intro.includes('the lifecycle\'s one terminal write is the Phase 7 commit driver (`phase7-commit.mjs`'), commitSurface, 'the Phase 7 driver closes the lifecycle, exactly where the persona has a commit surface');
              strictEqual(intro.includes('the lifecycle\'s one terminal write is `finish-verb`'), !commitSurface, 'finish-verb closes it otherwise');
              // Contract: an owner gate met in a phase — awaiting-owner-set, the lifecycle pauses,
              // and awaiting-owner-clear lets it continue.
              ok(/`state\.mjs awaiting-owner-set`.*the lifecycle pauses.*`state\.mjs awaiting-owner-clear`/.test(intro), 'an owner gate pauses the lifecycle until it is cleared');
            });

            it('the Codex entry runs the command\'s Phase 0 in its order', () => {
              const intro = squash(region(text, 'start-command-intro'));
              const commitSurface = declaration(persona).capabilities.commit_surface === true;
              const at = (needle) => {
                const i = intro.indexOf(needle);
                ok(i >= 0, `the intro names ${needle}`);
                return i;
              };
              // Contract: the agent running $<persona>:start on Codex — the guard, find-active and
              // the preflight before any write; resume or refuse by workflow type; with a commit
              // surface the redundancy probe, then a new args file; the gate before create.
              const order = [
                at('Refuse a detached HEAD'),
                at('state.mjs find-active --repo-root <root>'),
                at('state.mjs autopilot-preflight --workflow-path <found> --host codex` before any write'),
                at('--clear-next-step true --event resumed'),
                at('typed conflict: refuse, writing nothing'),
                ...(commitSurface ? [at('state.mjs diagnose-redundancy --repo-root <root> --base-branch <ref>'), at('then, with a new args file, for the bootstrap')] : []),
                at('**clean-baseline gate** below, then `state.mjs create --workflow-type start --verb investigate --persona ' + persona + ' --original-request-file <the description\'s file>`'),
              ];
              deepStrictEqual(order, [...order].sort((a, b) => a - b), 'in the command\'s order');
              // Contract: the resume predicate — only a start workflow resumes into the lifecycle.
              ok(intro.includes('`workflow_type` `start` → resume: `state.mjs append'), 'only workflow_type start resumes');
              // Contract: the owner-gate clear — said once, and only on the start branch, so a
              // workflow the lifecycle refuses is never written to.
              const clear = at('clear it with the phase the lifecycle continues at');
              ok(clear > at('`workflow_type` `start` → resume') && clear < at('Any other workflow (`verb-chain`'), 'the gate is cleared only on the start branch');
              strictEqual(intro.split('clear it with').length - 1, 1, 'one place says to clear the gate');
              // Contract: args-file transport — the description reaches start-args.mjs in a file,
              // never on a command line.
              strictEqual(intro.includes('scripts/start-args.mjs --args-file <path>'), commitSurface, 'the args file, exactly where the persona has a commit surface');
              // Contract (ADR-0059, amendment of 2026-10-10): the description reaches create as a
              // file — the agent's request.txt, or with a commit surface a file the block writes from
              // the extractor's output — never as an inline flag.
              ok(!/--original-request </.test(intro), 'no inline request');
              strictEqual(intro.includes('write it with the file-writing tool as `request.txt`'), !commitSurface, 'the agent writes the request file, exactly where no args file holds the description');
            });

            it('the finish paragraph names the lifecycle\'s last write, by declaration, and its citations resolve', () => {
              const commitSurface = declaration(persona).capabilities.commit_surface === true;
              const converges = declaration(persona).verbs?.start?.terminal_requires_convergence === true;
              const id = commitSurface ? 'start-finish-commit' : converges ? 'start-finish-convergent' : 'start-finish';
              // Contract: the generator renders the one variant the declaration selects — a second
              // would give the agent two last writes.
              for (const other of ['start-finish', 'start-finish-convergent', 'start-finish-commit'].filter((x) => x !== id)) {
                strictEqual(parseRegions(text).regions.filter((r) => r.id === other).length, 0, `only the variant the declaration selects, not ${other}`);
              }
              const body = region(text, id);
              const fin = squash(body);
              // Contract: the agent closing an unconverged lifecycle — its last write turns the
              // terminal marker off, or the Stop hook archives an open lifecycle.
              strictEqual(fin.includes('--clear-terminal-marker true'), converges, 'the unconverged write clears the marker, exactly where the lifecycle waits for convergence');
              // Contract: the lifecycle's one terminal write — with a commit surface the Phase 7
              // driver writes set-terminal, and a finish-verb after it would write a closed workflow.
              strictEqual(fin.includes('`phase7-commit.mjs`'), commitSurface, 'the Phase 7 driver, exactly where the persona has a commit surface');
              strictEqual(fin.includes('no `finish-verb` runs'), commitSurface, 'no finish-verb after the driver');
              // Contract: the hand-off to the next deliverable — until the Stop hook archives the
              // terminal workflow, start on this branch finds and resumes it, so a next start there
              // reopens the finished lifecycle instead of beginning a new one.
              ok(fin.includes('so start the next deliverable after the archive, or on another branch'), 'the next deliverable waits for the archive, or takes another branch');
              // Contract: the agent running the skill's terminal write — the runbook's call, with
              // the same next action, kind commit, and a stop when the write fails.
              const runbook = readFileSync(join(pluginRoot(persona), 'commands', 'start.md'), 'utf8');
              const calls = shellBlocks(body).filter((b) => b.includes('state.mjs" finish-verb'));
              const runbookCalls = shellBlocks(runbook).filter((b) => b.includes('state.mjs" finish-verb'));
              strictEqual(calls.length, commitSurface ? 0 : 1, 'one finish-verb block, exactly where the lifecycle ends with it');
              strictEqual(runbookCalls.length, commitSurface ? 0 : 1, 'and the runbook\'s');
              if (!commitSurface) {
                // ADR-0059, amendment of 2026-10-10: both read the next action from the agent's
                // file, whose scaffold holds the lifecycle's declared default in each.
                const nextAction = (block) => /--next-action-file ("\$TEXT_DIR\/next-action\.txt")/.exec(block)?.[1];
                ok(nextAction(calls[0]), 'the skill block names its next action\'s file');
                strictEqual(nextAction(calls[0]), nextAction(runbookCalls[0]), 'the skill reads the runbook\'s next-action file');
                const declared = declaration(persona).verbs.start.next_action;
                const scaffold = (doc) => doc.split(`\n   \`\`\`text\n   ${declared}\n   \`\`\`\n`).length - 1;
                deepStrictEqual([scaffold(body), scaffold(runbook)], [1, 1], 'the declared next action, as the next-action.txt scaffold of each');
                ok(/--next-step-kind commit --next-step-confidence "<HIGH\|MEDIUM\|LOW>" \|\| exit \$\?$/.test(calls[0].trim()), 'kind commit, and a failed write stops');
              }
              // Contract: the agent following a citation — each names a heading of a file this
              // persona ships.
              const cites = sectionCitations(persona, skill, fin);
              ok(cites.length > 0, 'the paragraph\'s citations were read');
              for (const c of cites) {
                ok(existsSync(c.file), `${persona}/start: ${c.target} is not in the plugin`);
                ok(new RegExp(`^#{1,6} ${c.heading}(?![\\w-])`, 'm').test(readFileSync(c.file, 'utf8')), `${persona}/start: ${c.target} has no § ${c.heading}`);
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
              // Contract: the agent before web search and peer dispatch — the gate names what this
              // persona must genericize, and the raw value never leaves the local host.
              ok(gate.startsWith(`PRIVACY GATE: ${decl.peer.privacy_scope} pass an explicit privacy gate before BOTH web search AND peer-host dispatch. `), 'the gate names this persona\'s scope');
              ok(gate.includes(` ${prohibition} `), 'the verb\'s prohibition');
              // Contract: the agent following the gate's citation — read from the skill's
              // directory, it names the declared privacy spec, which exists.
              const cited = /See `([^`]+)` § Privacy Gate\.$/.exec(gate);
              ok(cited, 'the gate cites its spec');
              strictEqual(posix.join(SKILLS_REL, skill, cited[1]), decl.peer.privacy_spec, 'the citation, read from the skill\'s directory, is the declared spec');
              ok(existsSync(join(pluginRoot(persona), SKILLS_REL, skill, cited[1])), 'the cited spec exists');
              // Contract: the peer dispatch's flags — no `--image` where the persona declares images off.
              const noImage = parseRegions(text).regions.filter((r) => r.id === `${skill}-privacy-no-image`);
              strictEqual(noImage.length, decl.peer.images === false ? 1 : 0, 'the no-image region, exactly where images are off');
              for (const r of noImage) ok(squash(regionBody(text, r)).includes(NO_IMAGE), 'the no-image rule');
              // Contract: order — the agent reads the gate before the step that calls the peer.
              const step = text.search(peerStep);
              ok(step > 0, 'the peer step heading');
              const last = text.indexOf(`<!-- pipeline:end ${skill}-privacy-${noImage.length > 0 ? 'no-image' : 'gate'} -->`);
              ok(last > 0 && last < step, 'the gate and the no-image rule precede the peer step');
              if (persona === 'designer') {
                // Contract: the agent before designer's peer step — a screenshot never reaches the
                // peer as bytes.
                ok(squash(text.slice(last, step)).includes(SCREENSHOT[skill]), `designer's screenshot rule follows the regions, before the peer step: ${SCREENSHOT[skill]}`);
              }
            });
          }

          if (skill === 'compose' || skill === 'frame') {
            it(`${skill} confirms before any downstream verb`, () => {
              // Contract: the agent presenting the artifact — it stops for the user's confirmation
              // before running a downstream verb.
              ok(squash(region(text, `${skill}-present`)).includes('confirm before downstream verbs'), 'the confirmation rule');
              if (skill === 'compose') {
                const write = squash(region(text, 'compose-state-write'));
                // Contract: what the compose skill itself may write — with a commit surface only the
                // code profile's record-composed-file (Phase 7 treats an unrecorded file as extra),
                // without one nothing.
                if (declaration(persona).capabilities.commit_surface === true) {
                  ok(!write.includes('does not write workflow state'), 'the skill does not deny its manifest write');
                  ok(write.includes('its one workflow write is the `code` profile\'s commit-manifest recording'), 'the manifest write is named');
                  const below = text.slice(text.indexOf('<!-- pipeline:end compose-state-write -->'));
                  ok(below.includes('state.mjs" record-composed-file'), 'the recording it names follows');
                } else {
                  ok(write.includes('This skill itself does not write workflow state.'), 'the skill writes none');
                }
              }
            });
          }

          if (skill === 'decide') {
            it('decide waits for the user\'s explicit choice before anything downstream', () => {
              const gate = squash(region(text, 'decide-approval-gate'));
              const autopilot = declaration(persona).capabilities.dispatch_target === true;
              // Contract: the agent after the recommendation — it waits for the user's choice;
              // under an autopilot run (dispatch_target) no one is there, so it does not wait, and a
              // CONFLICT stops at its owner gate.
              ok(gate.includes('do not proceed without explicit approval'), 'the approval gate');
              strictEqual(gate.includes('so do not wait'), autopilot, 'the autopilot rule, exactly where the persona has autopilot');
              strictEqual(gate.includes('A CONFLICT stops at the `decide-conflict` owner gate'), autopilot, 'a CONFLICT under autopilot stops at its gate');
              // Contract: order — the gate comes before the state write.
              const at = text.indexOf('<!-- pipeline:begin decide-approval-gate -->');
              const write = text.indexOf('### State write');
              ok(at > 0 && write > at, 'the gate precedes the state write');
            });
          }

          if (FINISH_VERBS.includes(skill)) {
            it('the finish paragraph names the handoff by capability, and its citations resolve inside the plugin', () => {
              const caps = declaration(persona).capabilities;
              // A verb that closes only once it converged (designer's refine)
              // renders the convergent variant.
              const converges = declaration(persona).verbs?.[skill]?.terminal_requires_convergence === true;
              const id = converges ? `${skill}-finish-convergent` : `${skill}-finish`;
              // Contract: the generator renders the one variant the declaration selects.
              strictEqual(parseRegions(text).regions.filter((r) => r.id === (converges ? `${skill}-finish` : `${skill}-finish-convergent`)).length, 0, 'only the variant the declaration selects');
              const fin = squash(region(text, id));
              // Contract: the Codex agent — autopilot mode is Claude-only, so Codex ignores it,
              // said exactly where the persona has it.
              strictEqual(fin.includes('ignore it on Codex'), caps.dispatch_target === true, 'autopilot is Claude-only, said exactly where the persona has it');
              // Contract: the handoff command — /<persona>:commit exists exactly where the persona
              // has a commit surface.
              strictEqual(fin.includes(`\`/${persona}:commit\``), caps.commit_surface === true, 'the commit command, exactly where the persona has one');
              // Contract: the agent running the skill — standalone it writes no workflow
              // state, and inside the lifecycle no phase makes the verb's terminal write;
              // without these a skill run closes or edits a workflow it does not own.
              ok(fin.includes('A standalone skill invocation writes no workflow state'), 'no workflow write standalone');
              ok(fin.includes(`Inside \`/${persona}:start\` no phase makes a verb's terminal write`), 'no terminal write inside the lifecycle');
              // Contract: the agent undoing a terminal write — the marker clears
              // only before the same turn's Stop fires; told it clears at any
              // time, the agent defers the clear past the archive it meant to stop.
              ok(fin.includes('works only before that Stop fires'), 'the marker clears only before the same-turn Stop');
              // Contract: the agent finishing an unconverged verb (designer's
              // refine) — its last write is an `append` that leaves the workflow
              // open; finish-verb would make the terminal write, and the Stop hook
              // would archive work that has not converged.
              if (converges) {
                ok(fin.includes("Not converged, it leaves the workflow open") && fin.includes("the finalize's last write is an `append`"), 'an unconverged verb ends with an append');
                ok(fin.includes('no terminal write is made'), 'an unconverged verb makes no terminal write');
              }
              // Contract: the agent following a citation — each names a heading of a file this
              // persona ships, inside its own plugin.
              const cites = sectionCitations(persona, skill, fin);
              ok(cites.length > 0, 'the paragraph\'s citations were read');
              for (const c of cites) {
                // Inside this persona's plugin (a `../` path can leave it).
                const root = pluginRoot(persona);
                ok(posix.normalize(c.file.split('\\').join('/')).startsWith(`${root.split('\\').join('/')}/`), `${persona}/${skill}: ${c.target} leaves the plugin`);
                ok(existsSync(c.file), `${persona}/${skill}: ${c.target} is not in the plugin`);
                const heading = new RegExp(`^#{1,6} ${c.heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'm');
                ok(heading.test(readFileSync(c.file, 'utf8')), `${persona}/${skill}: ${c.target} has no § ${c.heading}`);
              }
            });
          }
        });
      }
    }
  }
});
