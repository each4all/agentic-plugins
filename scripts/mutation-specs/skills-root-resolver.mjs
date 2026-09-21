// Mutation spec — `tests/_helpers.mjs`'s `resolveSkillsRoot`, gated by
// `tests/test-skills-root-resolver.mjs`.
//
// Run: node scripts/mutation-harness.mjs scripts/mutation-specs/skills-root-resolver.mjs
//
// Two families. `M*` break the RESOLVER and must be caught by the resolver's
// own fixtures. `F*` leave the resolver alone and point a real plugin's
// manifest somewhere wrong — those must be caught by the gate's real-repository
// sweep, which is the only part of it that can go vacuous.
//
// Recorded result at authoring time (2026-09-19, eight plugins): 20/20
// as-expected. Every `M*` is a single anchored edit, so a drift in
// `tests/_helpers.mjs` surfaces as a harness error naming the anchor rather
// than as a silent change in the score.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const H = 'tests/_helpers.mjs';

export const TESTS = ['tests/test-skills-root-resolver.mjs'];

function repoint(tools, copy, plugin, value) {
  const file = `plugins/${plugin}/.codex-plugin/plugin.json`;
  const manifest = tools.readJson(copy, file);
  manifest.skills = value;
  tools.writeJson(copy, file, manifest);
}

export const MUTATIONS = [
  {
    id: 'M1', file: H,
    from: 'if (declared === undefined) {',
    to: 'if (declared === undefined || declared === null) {',
    why: 'null silently takes the convention fallback',
  },
  {
    id: 'M2', file: H,
    from: '} else if (declared.trim().length === 0) {',
    to: '} else if (false) {',
    why: 'an empty/whitespace declaration is accepted',
  },
  {
    id: 'M3', file: H,
    from: "} else if (typeof declared !== 'string') {",
    to: "} else if (false && typeof declared !== 'string') {",
    why: 'a non-string skills value stops being refused',
  },
  {
    id: 'M4', file: H,
    from: '    candidate = resolve(base, declared);',
    to: '    candidate = resolve(base, CONVENTIONAL_SKILLS_DIR);',
    why: 'the manifest is ignored and the convention always wins',
  },
  {
    id: 'M5', file: H,
    from: '  if (escapesDir(base, candidate)) {',
    to: '  if (false && escapesDir(base, candidate)) {',
    why: 'lexical containment is dropped',
  },
  {
    id: 'M6', file: H,
    from: '  if (escapesDir(realBase, realRoot)) {',
    to: '  if (false && escapesDir(realBase, realRoot)) {',
    why: 'realpath containment is dropped — an escaping symlink is accepted',
  },
  {
    id: 'M7', file: H,
    from: "      err?.code === 'ENOENT' ? 'skills-missing' : 'skills-stat-failed',",
    to: "      'skills-stat-failed',",
    why: 'a genuinely absent root is reported as a stat failure',
  },
  {
    id: 'M8', file: H,
    from: '  if (!stats.isDirectory()) {',
    to: '  if (false && !stats.isDirectory()) {',
    why: 'a file is accepted as the skills root',
  },
  {
    id: 'M9', file: H,
    from: "      err?.code === 'ENOENT' ? 'skills-missing' : 'skills-stat-failed',",
    to: "      'skills-missing',",
    why: 'ENOTDIR is flattened into "missing"',
  },
  {
    id: 'M10', file: H,
    from: "      err?.code === 'ENOENT' ? 'manifest-missing' : 'manifest-unreadable',",
    to: "      'manifest-unreadable',",
    why: 'a missing manifest is misreported as unreadable',
  },
  {
    id: 'M11', file: H,
    from: "      err?.code === 'ENOENT' ? 'manifest-missing' : 'manifest-unreadable',",
    to: "      'manifest-missing',",
    why: 'an unreadable manifest is misreported as missing',
  },
  {
    id: 'M12', file: H,
    from: "  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {",
    to: '  if (false) {',
    why: 'a non-object manifest falls through to the convention',
  },
  {
    id: 'M13', file: H,
    from: "  return rel === '' || rel === '..'",
    to: "  return rel === '..'",
    why: 'the plugin directory itself is accepted as its own skills root',
  },
  {
    id: 'M14', file: H,
    from: "  if (typeof pluginDir !== 'string' || pluginDir.length === 0) {",
    to: '  if (false) {',
    why: 'the argument contract is dropped',
  },
  {
    id: 'M15', file: H,
    from: "      'manifest-invalid-json',",
    to: "      'manifest-not-object',",
    why: 'unparseable JSON is misreported as a non-object',
  },
  {
    id: 'M16', file: H,
    from: '  return candidate;',
    to: '  return realRoot;',
    why: 'the realpath is returned instead of the declared path',
  },

  // F* — the "bogus root" controls. These never touch the resolver; they are
  // the only check on whether the gate's real-repository sweep means anything.
  //
  // Each target is chosen so the spec survives the ADR-0006 relocation itself:
  // the fabricated directory names cannot collide with `core/skills`, whether
  // or not the plugin has already moved.
  {
    id: 'F1',
    prepare: (copy, tools) => {
      mkdirSync(join(copy, 'plugins/image/core/skills-empty'), { recursive: true });
      repoint(tools, copy, 'image', './core/skills-empty/');
    },
    why: 'image points at a real but EMPTY root — the sweep must not pass vacuously',
  },
  {
    id: 'F2',
    prepare: (copy, tools) => repoint(tools, copy, 'image', './commands/'),
    why: 'image points at a real directory that holds no SKILL.md',
  },
  {
    id: 'F3',
    prepare: (copy, tools) => repoint(tools, copy, 'engineer', './core/skills-nonexistent/'),
    why: 'engineer declares a root that does not exist (the partial-move window)',
  },
  {
    id: 'F4',
    prepare: (copy, tools) => repoint(tools, copy, 'attention', './skills/README.md'),
    why: 'a plugin that packages no skills points at a file',
  },
];
