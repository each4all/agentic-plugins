// Codex plugin-root contract — engineer, designer and founder.
//
// Those three personas' command-resolution tables told a Codex agent that its
// plugin root was the marketplace checkout under `~/.codex/.tmp/marketplaces/`,
// "Codex marketplace install layout per ADR-0008". That directory is the
// install SOURCE: Codex loads the skills from a versioned copy under
// `~/.codex/plugins/cache/agentic-plugins/<plugin>/` and injects a mentioned
// skill together with that copy's absolute SKILL.md path (measured on
// codex-cli 0.156.1, ADR-0008 Amendment 2026-09-24). Eleven table rows carried
// the claim and seven engineer passages pointed readers at it. This file
// guards all of them from one place, for the reason
// test-checkpoint-reinjection-contract.mjs gives: one guard per persona would
// repeat the one-of-N-copies defect in the tests.
//
// Scope: orchestrator's seven command-resolution tables describe the root as
// the "Codex marketplace install path" and are outside this contract; the
// ADR-0008 amendment records that they keep their wording.
//
// Traps this closes:
//   - A table that loses its row, or a new command-resolution section, would
//     pass a per-row check by not being visited. Among each skill's SKILL.md,
//     tables are found by their section heading as well as by the row, and
//     the set found must equal the one written down here. A table added to a
//     reference document is not searched for; the sweep below still rejects
//     the checkout path or a retired claim there.
//   - Equality over nothing passes, so every cell's content is asserted before
//     the cells are compared.
//   - The corrected cell names the checkout path in order to say it is not the
//     loaded copy, so the path's presence proves nothing by itself. The source
//     sentence is required, each table file names the path exactly once (in
//     its cell), and no other .md/.yaml/.yml/.json file in the three plugins
//     (CHANGELOG.md aside) may name it.
//   - A per-FILE check on the engineer pointers passes when the passage
//     reverts and the same words survive elsewhere in the file, so each
//     pointer is checked inside its own passage, each pointer file points at
//     the table exactly once, and the relative path it names must resolve to
//     the checkpoint SKILL.md. A paragraph passage ends at a blank line
//     (whitespace-only counts); the list-item passage ends at the next line
//     that starts in column 0, so nested bullets stay inside it and an
//     unindented paragraph or sibling bullet of any marker does not. CRLF is
//     normalized first.
//   - Each table file carries exactly one command-resolution section, and its
//     Plugin root row must sit inside that section.
//   - The skills root has moved before (ADR-0006, 2026-09-18). The suffix the
//     cell tells readers to drop is taken from each plugin's declared skills
//     root, not spelled into this file.
//
// Limits: the retired phrasings below are the old sentences' affirmative
// shapes, subject included, so an accurate sentence that shares words with
// them (a correction, a negation) still passes, and a
// paraphrase of the old claim is caught only when it names the checkout path
// or adds a table. The corrected sentences are pinned as written, so
// rewording them means updating this file in the same change.

import { describe, it } from 'node:test';
import { ok, strictEqual, deepStrictEqual } from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { resolve, join, relative, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveSkillsRoot, skillsPath } from '../_helpers.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');

// The command-resolution tables that document a Codex plugin root in these
// three personas. engineer's start macro has none; designer's and founder's do.
const TABLES = {
  engineer: ['checkpoint', 'peer-now', 'resume'],
  designer: ['checkpoint', 'peer-now', 'resume', 'start'],
  founder: ['checkpoint', 'peer-now', 'resume', 'start'],
};
const PERSONAS = Object.keys(TABLES);

// Engineer passages that send a Codex reader to the checkpoint table for the
// root, each with the delimiters of its passage. The five non-decide verbs
// share one paragraph, which test-engineer-plugin.mjs also holds identical.
// Passages end at a paragraph or sibling-bullet boundary, not at a phrase, so
// re-wrapping a passage cannot move its end past the text it has to hold.
const BLANK_LINE = /\n[ \t]*\n/;
const VERB_PASSAGE = { start: 'On Codex the resolver takes one extra step', end: BLANK_LINE };
const ENGINEER_POINTERS = {
  'decide/SKILL.md': {
    start: '**Cross-host scope note (ADR-0001 §5 honest scope)**',
    end: BLANK_LINE,
    claim: 'the root is that path without its trailing `/<skills>/<skill>/SKILL.md`',
  },
  '_shared/references/entry-routing-contract.md': {
    start: '- **The registry is the single axis source.**',
    end: /\n(?=\S)/,
    claim: 'Claude/Codex command resolution shows how to take the root from it',
  },
  ...Object.fromEntries(
    ['compose', 'critique', 'frame', 'investigate', 'refine'].map((verb) => [
      `${verb}/SKILL.md`,
      { ...VERB_PASSAGE, claim: 'Claude/Codex command resolution shows how to take the root from it' },
    ]),
  ),
};

const squash = (s) => s.replace(/\s+/g, ' ');
const pluginDir = (persona) => join(REPO_ROOT, 'plugins', persona);
const label = (path) => relative(REPO_ROOT, path).split(sep).join('/');
// `core/skills` today; whatever the plugin's manifest declares tomorrow.
const skillsRel = (persona) => relative(pluginDir(persona), resolveSkillsRoot(pluginDir(persona))).split(sep).join('/');

const CHECKOUT = '.tmp/marketplaces';
const SECTION = /^#{2,}\s.*command resolution\s*$/im;
const SECTION_ALL = /^#{2,}\s.*command resolution\s*$/gim;
const HEADING = /^#{1,6}\s/m;
const ROW = /^\s*\|\s*(?:\*\*)?\s*Plugin root\b/i;

// Retired claims, in the affirmative shapes the old sentences had (subject
// included), so that the corrected text — which names the checkout as the
// install source — and accurate corrections using the same words do not match.
const RETIRED = [
  [/\(Codex marketplace install layout per ADR-0008/i, 'calls the marketplace checkout the Codex install layout per ADR-0008'],
  [/no versioned subdirectory, no glob needed/i, 'says the Codex install has no versioned subdirectory'],
  [/command resolution,? (?:which )?records the default (?:Codex )?layout/i, 'says the checkpoint table records a default layout to assume'],
  [/a non-default install root (?:means resolving|or marketplace name means the path must be|must be resolved)/i, 'treats the root as assumable unless the install is non-default'],
];
const POINTER = /(`[^`]*checkpoint\/SKILL\.md`) § Claude\/Codex command resolution/g;

// A GFM row: strip the outer pipes, split on unescaped ones (the Claude
// fallback carries `\|` inside a code span).
const splitRow = (line) => line.trim().replace(/^\|/, '').replace(/(?<!\\)\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim());

function pluginRootRows(raw) {
  const lines = raw.split(/\r?\n/);
  const rows = [];
  lines.forEach((line, i) => {
    if (!ROW.test(line)) return;
    let top = i;
    while (top > 0 && lines[top - 1].trim().startsWith('|')) top -= 1;
    const header = splitRow(lines[top]);
    const cells = splitRow(line);
    rows.push({ header, cells, codex: cells[header.indexOf('Codex')] ?? '' });
  });
  return rows;
}

function passage(text, { start, end }) {
  const from = text.indexOf(start);
  if (from === -1) return null;
  const rest = text.slice(from + start.length);
  const m = end.exec(rest);
  // No end means the passage shape changed; returning the rest of the file
  // would let later text satisfy the checks.
  return m ? text.slice(from, from + start.length + m.index) : null;
}
const lf = (s) => s.replace(/\r\n?/g, '\n');

async function* docFiles(persona) {
  for (const entry of await readdir(pluginDir(persona), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(md|ya?ml|json)$/.test(entry.name) || entry.name === 'CHANGELOG.md') continue;
    yield join(entry.parentPath ?? entry.path, entry.name);
  }
}

describe('Codex plugin-root contract — engineer, designer, founder', () => {
  it('the SKILL.md files with a command-resolution section or a Plugin root row are exactly the enumerated tables', async () => {
    for (const persona of PERSONAS) {
      const root = resolveSkillsRoot(pluginDir(persona));
      const found = [];
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        let raw;
        try {
          raw = await readFile(join(root, entry.name, 'SKILL.md'), 'utf8');
        } catch (err) {
          if (err.code === 'ENOENT') continue;
          throw err;
        }
        if (SECTION.test(raw) || pluginRootRows(raw).length > 0) found.push(entry.name);
      }
      deepStrictEqual(
        found.sort(),
        [...TABLES[persona]].sort(),
        `plugins/${persona}: the SKILL.md files with a command-resolution section or a Plugin root row must be exactly the enumerated tables`,
      );
    }
  });

  it('every table has one Plugin root row whose Codex cell takes the root from the injected path and names the checkout only as the source', async () => {
    const normalized = [];
    for (const [persona, skills] of Object.entries(TABLES)) {
      const rel = skillsRel(persona);
      ok(existsSync(join(pluginDir(persona), '.codex-plugin', 'plugin.json')), `plugins/${persona} must ship .codex-plugin/plugin.json — the cell tells readers the root holds it`);
      for (const skill of skills) {
        const path = skillsPath(pluginDir(persona), skill, 'SKILL.md');
        const raw = await readFile(path, 'utf8');
        const sections = [...raw.matchAll(SECTION_ALL)];
        strictEqual(sections.length, 1, `${label(path)} must carry exactly one command-resolution section (found ${sections.length})`);
        const after = raw.slice(sections[0].index + sections[0][0].length);
        const next = after.search(HEADING);
        const section = next === -1 ? after : after.slice(0, next);
        const rows = pluginRootRows(raw);
        strictEqual(rows.length, 1, `${label(path)} must carry exactly one Plugin root row (found ${rows.length})`);
        strictEqual(pluginRootRows(section).length, 1, `${label(path)} Plugin root row must sit inside its command-resolution section`);
        const [{ header, cells, codex }] = rows;
        ok(header.includes('Codex'), `${label(path)} Plugin root row must sit in a table with a Codex column`);
        strictEqual(cells.length, header.length, `${label(path)} Plugin root row must have as many cells as its header`);
        const required = [
          [`For a mentioned \`${persona}\` skill, the plugin directory that contains it`, 'scope the rule to a mentioned skill of this plugin'],
          [`inside \`$${persona}:start\`, the mentioned skill is \`start\`, which runs the six verb skills in place`, 'name start as the mentioned skill when it runs the verbs in place'],
          ['Codex injects a mentioned skill with its absolute path', 'say where the root comes from'],
          [`dropping \`/${rel}/<skill>/SKILL.md\` from it leaves the root, which holds \`.codex-plugin/plugin.json\``, `derive the root by dropping this plugin's declared skills root (/${rel}/<skill>/SKILL.md)`],
          ['a new mention of the skill supplies it again', 'say how to recover the path once it has left the context'],
          [`With the default Codex home and the \`agentic-plugins\` marketplace added from Git, the root is \`~/.codex/plugins/cache/agentic-plugins/${persona}/<version>\`, the versioned copy Codex loads skills from`, "name its own plugin's versioned cache as the location under the default Codex home and Git marketplace"],
          [`\`~/.codex/.tmp/marketplaces/agentic-plugins/plugins/${persona}\` is the marketplace checkout Codex installs from, not that copy`, 'name the checkout as the source Codex installs from, not the loaded copy'],
        ];
        for (const [sentence, why] of required) {
          ok(codex.includes(sentence), `${label(path)} Codex cell must ${why}: expected "${sentence}"`);
        }
        strictEqual(codex.split(CHECKOUT).length - 1, 1, `${label(path)} Codex cell must name the checkout once, as the install source only`);
        for (const [pattern, why] of RETIRED) {
          ok(!pattern.test(codex), `${label(path)} Codex cell ${why}`);
        }
        normalized.push(codex.replace(new RegExp(`\\b${persona}\\b`, 'g'), '<persona>'));
      }
    }
    // Self-check on this file: every table above must have reached the push.
    strictEqual(normalized.length, Object.values(TABLES).flat().length, 'every enumerated table must contribute its Codex cell before the cells are compared');
    strictEqual(
      new Set(normalized).size,
      1,
      'the Codex plugin-root cells must stay identical apart from the plugin name — updating one copy and not the others is the defect this guard exists to catch',
    );
  });

  it('each engineer pointer to the checkpoint table carries the mechanism inside its own passage', async () => {
    const rel = skillsRel('engineer');
    for (const [file, spec] of Object.entries(ENGINEER_POINTERS)) {
      const path = skillsPath(pluginDir('engineer'), ...file.split('/'));
      const text = lf(await readFile(path, 'utf8'));
      strictEqual(text.split(spec.start).length - 1, 1, `${label(path)} must carry its pointer passage exactly once (starts "${spec.start}")`);
      const body = passage(text, spec);
      ok(body, `${label(path)} pointer passage not found`);
      const flat = squash(body);
      const refs = [...flat.matchAll(POINTER)];
      strictEqual(refs.length, 1, `${label(path)} passage must point at the checkpoint command-resolution table exactly once`);
      const target = resolve(dirname(path), refs[0][1].slice(1, -1));
      strictEqual(label(target), label(skillsPath(pluginDir('engineer'), 'checkpoint', 'SKILL.md')), `${label(path)} passage must name a path that resolves to the checkpoint SKILL.md`);
      ok(flat.includes('injects the mentioned skill with its absolute path'), `${label(path)} passage must say where the root comes from — the absolute path Codex injects with the mentioned skill`);
      const claim = spec.claim.replace('<skills>', rel);
      ok(flat.includes(claim), `${label(path)} passage must keep the corrected claim: ${claim}`);
      for (const [pattern, why] of RETIRED) {
        ok(!pattern.test(flat), `${label(path)} passage ${why}`);
      }
    }
  });

  it('across the three plugins, only the table cells name the checkout, only the listed passages point at the table, and no retired claim survives', async () => {
    // With the per-file counts below, a table file's one occurrence is the one
    // the cell test found, and a pointer file's one pointer is inside the
    // passage the pointer test extracted.
    const tableFiles = PERSONAS.flatMap((p) => TABLES[p].map((s) => label(skillsPath(pluginDir(p), s, 'SKILL.md'))));
    const pointerFiles = Object.keys(ENGINEER_POINTERS).map((f) => label(skillsPath(pluginDir('engineer'), ...f.split('/'))));
    const naming = [];
    const pointing = [];
    let scanned = 0;
    for (const persona of PERSONAS) {
      for await (const path of docFiles(persona)) {
        const text = squash(await readFile(path, 'utf8'));
        scanned += 1;
        for (const [pattern, why] of RETIRED) {
          ok(!pattern.test(text), `${label(path)} ${why}`);
        }
        const named = text.split(CHECKOUT).length - 1;
        if (named > 0) {
          naming.push(label(path));
          strictEqual(named, 1, `${label(path)} may name the marketplace checkout only once, inside its Plugin root cell (found ${named})`);
        }
        const pointers = [...text.matchAll(POINTER)].length;
        if (pointers > 0) {
          pointing.push(label(path));
          strictEqual(pointers, 1, `${label(path)} may point at the checkpoint command-resolution table only once, inside its pointer passage (found ${pointers})`);
        }
      }
    }
    ok(scanned > 100, `the sweep must reach the three plugins' documents (scanned ${scanned})`);
    deepStrictEqual(naming.sort(), tableFiles.sort(), 'only the enumerated Plugin root cells may name the marketplace checkout in these plugins');
    deepStrictEqual(pointing.sort(), pointerFiles.sort(), 'the passages pointing at the checkpoint command-resolution table must be exactly the enumerated ones');
  });
});
