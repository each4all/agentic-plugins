// Mutation spec — does the persona pipeline's suite catch the defects it exists
// for (ADR-0066 Decision 5)?
//
// Run: npm run mutate -- scripts/mutation-specs/persona-pipeline.mjs
//
// WHY A SPEC. Once one canonical source generates every persona's copy, a
// green suite proves two weak things at once: that the copies match the
// source (the drift check), and that the source is right. The first is
// mechanical; the second is what the contract tests carry. So the defects
// below go into the CANONICAL source and are REGENERATED, the way a real edit
// travels — never hand-applied to one copy — and a contract test must fail:
//
//   P  a canonical defect regenerated into exactly ONE persona, once per
//      persona the unit is enrolled into, so each KILLED names the persona
//      whose copy carried it (per-persona attribution);
//   A  a canonical defect regenerated into EVERY target: drift equality stays
//      clean, so only a contract test can catch it;
//   D  the drift check itself: a hand edit to a generated file, a region
//      comparison that ignores differences, a loader without its name check.
//   C  a control: an innocuous canonical edit, regenerated everywhere, keeps
//      the drift check clean (expect SURVIVED).
//
// `prepare` is synchronous and runs before any declarative edit, so each case
// edits and regenerates inside it, and a failed regeneration is a harness
// error, never a verdict.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { MutationHarnessError } from '../mutation-harness.mjs';

const MANIFEST = JSON.parse(readFileSync(new URL('../../persona-pipeline/manifest.json', import.meta.url), 'utf8'));
const enrolled = (dest) => MANIFEST.units.find((u) => u.dest === dest).personas;

const T_ENTRY = 'tests/persona-pipeline/test-cli-entry-guard.mjs';
const T_STOP = 'tests/persona-pipeline/test-stop-archive.mjs';
const T_SYNC = 'tests/persona-pipeline/test-sync-persona-pipeline.mjs';
const T_REGION = 'tests/persona-pipeline/test-region-engine.mjs';
const T_DECL = 'tests/persona-pipeline/test-persona-declaration.mjs';
const T_CROSS = 'tests/persona-pipeline/test-capabilities-and-declaration.mjs';

export const TESTS = [T_SYNC];

function regenerate(copy) {
  try {
    execFileSync(process.execPath, [join(copy, 'scripts/sync-persona-pipeline.mjs'), '--write'], { cwd: copy, stdio: 'pipe' });
  } catch (err) {
    throw new MutationHarnessError(`regeneration failed in the copy: ${err.stderr?.toString() || err.message}`);
  }
}

/**
 * Edit the canonical source of `dest`, regenerate, then put every persona other
 * than `only` back to its pre-edit generated copy, so exactly one persona's
 * copy carries the defect. `only` null keeps it in every target.
 */
function canonicalDefect(copy, tools, { dest, from, to, only = null }) {
  const keep = {};
  for (const persona of enrolled(dest)) {
    if (only !== null && persona !== only) keep[persona] = readFileSync(join(copy, 'plugins', persona, dest), 'utf8');
  }
  tools.applyEdit(copy, { file: `persona-pipeline/files/${dest}`, from, to });
  regenerate(copy);
  for (const [persona, text] of Object.entries(keep)) writeFileSync(join(copy, 'plugins', persona, dest), text);
}

const ENTRY = {
  dest: 'scripts/lib/cli-entry.mjs',
  from: '  if (entry !== self) return false;',
  to: '  if (importMetaUrl !== `file://${argv1}`) return false;',
};
const STOP_GATE = {
  dest: 'scripts/stop-archive.mjs',
  from: "    if (refState === 'present') {",
  to: '    if (false) {',
};

export const MUTATIONS = [
  // ---- P: one persona's copy carries a canonical defect ----------------------
  ...enrolled(ENTRY.dest).map((persona) => ({
    id: `P1-${persona}`, tests: [T_ENTRY],
    prepare: (copy, tools) => canonicalDefect(copy, tools, { ...ENTRY, only: persona }),
    why: `${persona}: the CLI entry guard compares a URL with a path again (D1) — its CLIs exit 0 silently through a symlink or an escaped path`,
  })),
  ...enrolled(STOP_GATE.dest).map((persona) => ({
    id: `P2-${persona}`, tests: [T_STOP],
    prepare: (copy, tools) => canonicalDefect(copy, tools, { ...STOP_GATE, only: persona }),
    why: `${persona}: a terminal workflow on a kept branch is never swept (one stop-archive gate inverted)`,
  })),

  // ---- A: every target carries it; drift equality cannot see it ----------------
  {
    id: 'A1', tests: [T_CROSS, T_SYNC],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'adapters/claude/hooks/stop.mjs',
      from: '  const persona = hookPersona();\n  if (!persona) return 0;\n',
      to: '  const persona = hookPersona() ?? { name: \'unknown\' };\n',
    }),
    why: 'the Claude Stop hook stops validating the declaration first and sweeps with a broken one',
  },
  {
    id: 'A2', tests: [T_CROSS],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/state.mjs',
      from: "    if (!personaOrRefuse('state.mjs')) {\n      process.exitCode = 1;\n      return;\n    }\n",
      to: '',
    }),
    why: 'state.mjs writes without validating the declaration at entry',
  },
  {
    id: 'A3', tests: [T_DECL, T_CROSS],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/lib/persona.mjs',
      from: '  if (plugin !== d.name) {',
      to: '  if (false) {',
    }),
    why: 'the loader accepts a declaration naming another plugin',
  },

  // ---- D: the drift check ---------------------------------------------------------
  {
    id: 'D1', tests: [T_SYNC], file: 'plugins/founder/scripts/state.mjs',
    from: "import { isCliEntry } from './lib/cli-entry.mjs';",
    to: "import { isCliEntry } from './lib/cli-entry.mjs'; // hand fix",
    why: 'a hand edit to a generated copy (the drift check must fail)',
  },
  {
    id: 'D2', tests: [T_REGION], file: 'scripts/sync-persona-pipeline.mjs',
    from: '        if (regionBody(text, region) !== bodies[region.id]) {',
    to: '        if (false) {',
    why: 'the check stops comparing region bodies, so a hand edit inside a region passes',
  },
  {
    id: 'D3', tests: [T_SYNC], file: 'scripts/sync-persona-pipeline.mjs',
    from: '    } else if (isExecutable(abs) !== item.executable) {',
    to: '    } else if (false) {',
    why: 'the check stops comparing the executable bit',
  },

  // ---- R: the review findings (Codex review of PC1) stay fixed -------------------------
  {
    id: 'R1', tests: [T_ENTRY],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: ENTRY.dest,
      from: '  if (claims.has(self)) return false;\n',
      to: '',
    }),
    why: 'two instances of one file both run the CLI under --preserve-symlinks-main (set-terminal ran twice)',
  },
  {
    id: 'R2', tests: [T_DECL],
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/lib/persona.mjs',
      from: '  const problems = structureProblems(d, minor);\n',
      to: '  const problems = [];\n',
    }),
    why: 'a schema-invalid declaration (no decide object) still authorizes writes',
  },
  {
    id: 'R3', tests: [T_SYNC], file: 'scripts/sync-persona-pipeline.mjs',
    from: '        const link = symlinkOnPath(root, rel);\n        if (link !== null) {\n          fatal.push(`${rel}: refused — ${link} is a symlink`);\n          continue;\n        }\n        drift.push(`${rel}: owned output the manifest no longer generates`);',
    to: '        drift.push(`${rel}: owned output the manifest no longer generates`);',
    why: 'a deletion follows a symlinked persona directory out of the tree',
  },
  {
    id: 'R4', tests: [T_SYNC], file: 'scripts/sync-persona-pipeline.mjs',
    from: '  atomicWrite(ledgerPath, renderLedger(owned), false);',
    to: '  writeFileSync(ledgerPath, renderLedger(owned));',
    why: 'the ledger is written through a symlink instead of replaced atomically',
  },
  {
    id: 'R5', tests: [T_SYNC], file: 'scripts/sync-persona-pipeline.mjs',
    from: '      if (regionDests.get(persona)?.has(dest)) {',
    to: '      if (false) {',
    why: 'a whole-file output that now holds regions is deleted, authored text included',
  },
  {
    id: 'R6', tests: [T_SYNC], file: 'scripts/sync-persona-pipeline.mjs',
    from: '        if (reparsed.errors.length > 0 || !sameJson(reparsed.regions.map((r) => r.id), foundIds)) {',
    to: '        if (false) {',
    why: 'a render that breaks the region grammar is written',
  },

  // ---- C: control -------------------------------------------------------------------
  {
    id: 'C1', tests: [T_SYNC], expect: 'SURVIVED',
    prepare: (copy, tools) => canonicalDefect(copy, tools, {
      dest: 'scripts/state.mjs',
      from: '// scripts/state.mjs\n',
      to: '// scripts/state.mjs (regenerated by the mutation control)\n',
    }),
    why: 'an innocuous canonical edit regenerated into every target leaves the drift check clean',
  },
];
