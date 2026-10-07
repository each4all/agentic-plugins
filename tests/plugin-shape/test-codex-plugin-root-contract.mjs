// Codex plugin-root contract — engineer, designer, founder and orchestrator.
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
// Scope: orchestrator's seven command-resolution tables joined in ADR-0061
// S2, which replaced their "Codex marketplace install path" wording (the
// ADR-0008 amendment, dated before it, records that they kept it). They carry
// the same cell without the start-macro clause, since orchestrator has no
// start macro. The same change reworded the cell's last sentence: the
// checkout "tracks the repository's main branch" rather than being what Codex
// "installs from", which ADR-0061's pinned catalog makes untrue. An eighth,
// approve's, joined with ADR-0063 S2 (2026-09-30), carrying the same cell.
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
//   - A pointer names its target section by heading, so the checkpoint
//     SKILL.md it resolves to must carry that heading with its Plugin root row
//     inside. Other tables are not reached by heading, and their sections are
//     not checked.
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
import { readFile, readdir } from 'node:fs/promises';
import { resolve, join, relative, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveSkillsRoot, skillsPath } from '../_helpers.mjs';
import { CHECKOUT, RETIRED, codexCellProblems, pluginRootRows, startClause } from '../_plugin-root-cell.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');

// The command-resolution tables that document a Codex plugin root in these
// plugins. engineer's start macro has none; designer's and founder's do.
const TABLES = {
  engineer: ['checkpoint', 'commit', 'peer-now', 'resume'],
  designer: ['checkpoint', 'peer-now', 'resume', 'start'],
  founder: ['checkpoint', 'peer-now', 'resume', 'start'],
  orchestrator: ['abort', 'approve', 'checkpoint', 'done', 'finalize', 'next', 'peer-now', 'resume'],
};
const PERSONAS = Object.keys(TABLES);
// The plugins whose start macro runs the six verb skills in place, so their
// cell names it.
const START_MACRO = new Set(['engineer', 'designer', 'founder']);

// Passages that send a Codex reader to the checkpoint table for the root, per
// plugin, each with the delimiters of its passage. engineer's five non-decide
// verbs share one paragraph, which test-engineer-plugin.mjs also holds
// identical; founder and designer carry one pointer each, in the multi-axis
// lens of their entry-routing contract (PC2a4, rendered from the persona
// pipeline's routing-lens template).
// Passages end at a paragraph or sibling-bullet boundary, not at a phrase, so
// re-wrapping a passage cannot move its end past the text it has to hold.
const BLANK_LINE = /\n[ \t]*\n/;
const VERB_PASSAGE = { start: 'On Codex the resolver takes one extra step', end: BLANK_LINE };
const REGISTRY_PASSAGE = {
  start: '- **The registry is the single axis source.**',
  end: /\n(?=\S)/,
  claim: 'Claude/Codex command resolution shows how to take the root from it',
};
const ENGINEER_POINTERS = {
  'decide/SKILL.md': {
    start: '**Cross-host scope note (ADR-0001 §5 honest scope)**',
    end: BLANK_LINE,
    claim: 'the root is that path without its trailing `/<skills>/<skill>/SKILL.md`',
  },
  '_shared/references/entry-routing-contract.md': REGISTRY_PASSAGE,
  ...Object.fromEntries(
    ['compose', 'critique', 'frame', 'investigate', 'refine'].map((verb) => [
      `${verb}/SKILL.md`,
      { ...VERB_PASSAGE, claim: 'Claude/Codex command resolution shows how to take the root from it' },
    ]),
  ),
};
const POINTERS = {
  engineer: ENGINEER_POINTERS,
  founder: { '_shared/references/entry-routing-contract.md': REGISTRY_PASSAGE },
  designer: { '_shared/references/entry-routing-contract.md': REGISTRY_PASSAGE },
  orchestrator: {},
};

const squash = (s) => s.replace(/\s+/g, ' ');
const pluginDir = (persona) => join(REPO_ROOT, 'plugins', persona);
const label = (path) => relative(REPO_ROOT, path).split(sep).join('/');
// `core/skills` today; whatever the plugin's manifest declares tomorrow.
const skillsRel = (persona) => relative(pluginDir(persona), resolveSkillsRoot(pluginDir(persona))).split(sep).join('/');

// The row, the cell's sentences and the retired claims live in
// tests/_plugin-root-cell.mjs, shared with the persona pipeline's skill
// contracts, which run the cell check per document (PC2a3).
const SECTION = /^#{2,}\s.*command resolution\s*$/im;
const HEADING = /^#{1,6}\s/m;
const POINTED_SECTION = 'Claude/Codex command resolution';
const POINTER = /(`[^`]*checkpoint\/SKILL\.md`) § Claude\/Codex command resolution/g;

// The body of the first `##`+ section titled exactly `title`, up to the next
// heading of any level; null when the file has no such heading.
function sectionBody(raw, title) {
  const lines = lf(raw).split('\n');
  const at = lines.findIndex((line) => /^#{2,}\s/.test(line) && line.replace(/^#+\s+/, '').trim() === title);
  if (at === -1) return null;
  const rest = lines.slice(at + 1).join('\n');
  const next = rest.search(HEADING);
  return next === -1 ? rest : rest.slice(0, next);
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

describe('Codex plugin-root contract — engineer, designer, founder, orchestrator', () => {
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
      // Contract: the Codex agent running any of these skills takes its root
      // from the Plugin root row — a table the cell check below does not
      // enumerate goes unchecked, and a command-resolution section that lost
      // its row leaves the agent no root at all.
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
      // Reads the plugin's .codex-plugin/plugin.json, which the cell tells the
      // agent the root holds, and throws when it is missing.
      const rel = skillsRel(persona);
      for (const skill of skills) {
        const path = skillsPath(pluginDir(persona), skill, 'SKILL.md');
        const raw = await readFile(path, 'utf8');
        const rows = pluginRootRows(raw);
        // Contract: the Codex agent deriving `<plugin-root>` reads one row — two
        // can disagree, and cells that do not line up with the header put the
        // Codex cell under another host.
        strictEqual(rows.length, 1, `${label(path)} must carry exactly one Plugin root row (found ${rows.length})`);
        const [{ header, cells, codex }] = rows;
        ok(header.includes('Codex'), `${label(path)} Plugin root row must sit in a table with a Codex column`);
        strictEqual(cells.length, header.length, `${label(path)} Plugin root row must have as many cells as its header`);
        // Contract: the Codex agent deriving `<plugin-root>` — the cell gives the
        // directory every `<plugin-root>/scripts/…` call runs from; the
        // marketplace checkout in its place runs main-branch code.
        deepStrictEqual(
          codexCellProblems(codex, persona, { skillsRel: rel, startMacro: START_MACRO.has(persona) }).map((p) => `${label(path)} ${p}`),
          [],
        );
        normalized.push(codex.replace(startClause(persona), '').replace(new RegExp(`\\b${persona}\\b`, 'g'), '<persona>'));
      }
    }
    // Self-check on this file: every table above must have reached the push.
    strictEqual(normalized.length, Object.values(TABLES).flat().length, 'every enumerated table must contribute its Codex cell before the cells are compared');
    // Contract: the Codex agent in each of these plugins — one copy that
    // drifts by a sentence the cell check does not know (a fallback to some
    // other directory) sends that plugin's agent there.
    strictEqual(
      new Set(normalized).size,
      1,
      'the Codex plugin-root cells must stay identical apart from the plugin name — updating one copy and not the others is the defect this guard exists to catch',
    );
  });

  it('each pointer to the checkpoint table carries the mechanism inside its own passage, in every plugin that has one', async () => {
    let checked = 0;
    for (const persona of PERSONAS) {
      const rel = skillsRel(persona);
      for (const [file, spec] of Object.entries(POINTERS[persona])) {
        checked += 1;
        const path = skillsPath(pluginDir(persona), ...file.split('/'));
        const text = lf(await readFile(path, 'utf8'));
        strictEqual(text.split(spec.start).length - 1, 1, `${label(path)} must carry its pointer passage exactly once (starts "${spec.start}")`);
        const body = passage(text, spec);
        ok(body, `${label(path)} pointer passage not found`);
        const flat = squash(body);
        const refs = [...flat.matchAll(POINTER)];
        strictEqual(refs.length, 1, `${label(path)} passage must point at the checkpoint command-resolution table exactly once`);
        const target = resolve(dirname(path), refs[0][1].slice(1, -1));
        // Contract: the Codex agent follows this relative path, then the named
        // section — a path to another file, a renamed heading, or a Plugin root
        // row outside that section is not where the pointer leads.
        strictEqual(label(target), label(skillsPath(pluginDir(persona), 'checkpoint', 'SKILL.md')), `${label(path)} passage must name a path that resolves to its own plugin's checkpoint SKILL.md`);
        const pointed = sectionBody(await readFile(target, 'utf8'), POINTED_SECTION);
        ok(pointed !== null, `${label(target)} has no "${POINTED_SECTION}" heading, which ${label(path)} points at`);
        strictEqual(pluginRootRows(pointed).length, 1, `${label(target)} Plugin root row must sit in its "${POINTED_SECTION}" section, where ${label(path)} points`);
        // Contract: the Codex agent resolving a script path from this skill —
        // without where the root comes from (the injected absolute path) and how
        // to take it, it falls back to $CLAUDE_PLUGIN_ROOT, which reads empty
        // in a Codex skill shell, or guesses.
        ok(flat.includes('injects the mentioned skill with its absolute path'), `${label(path)} passage must say where the root comes from — the absolute path Codex injects with the mentioned skill`);
        const claim = spec.claim.replace('<skills>', rel);
        ok(flat.includes(claim), `${label(path)} passage must keep the corrected claim: ${claim}`);
        for (const [pattern, why] of RETIRED) {
          ok(!pattern.test(flat), `${label(path)} passage ${why}`);
        }
      }
    }
    strictEqual(checked, Object.values(POINTERS).reduce((n, files) => n + Object.keys(files).length, 0), 'every enumerated pointer passage must be checked');
    ok(Object.keys(POINTERS.founder).length > 0 && Object.keys(POINTERS.designer).length > 0, 'founder and designer each carry a pointer passage');
  });

  it('across the four plugins, only the table cells name the checkout, only the listed passages point at the table, and no retired claim survives', async () => {
    // With the per-file counts below, a table file's one occurrence is the one
    // the cell test found, and a pointer file's one pointer is inside the
    // passage the pointer test extracted.
    // Contract: the Codex agent reading any of these plugins' documents — a
    // retired claim, or the checkout path outside its cell, tells it the root
    // is the marketplace checkout; a pointer outside the listed passages
    // escapes the mechanism check above.
    const tableFiles = PERSONAS.flatMap((p) => TABLES[p].map((s) => label(skillsPath(pluginDir(p), s, 'SKILL.md'))));
    const pointerFiles = PERSONAS.flatMap((p) => Object.keys(POINTERS[p]).map((f) => label(skillsPath(pluginDir(p), ...f.split('/')))));
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
    ok(scanned > 100, `the sweep must reach the four plugins' documents (scanned ${scanned})`);
    deepStrictEqual(naming.sort(), tableFiles.sort(), 'only the enumerated Plugin root cells may name the marketplace checkout in these plugins');
    deepStrictEqual(pointing.sort(), pointerFiles.sort(), 'the passages pointing at the checkpoint command-resolution table must be exactly the enumerated ones');
  });
});
