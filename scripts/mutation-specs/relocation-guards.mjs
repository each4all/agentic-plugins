// Mutation spec — the two kit/lint rules that guard a skills-root relocation.
//
// Run: node scripts/mutation-harness.mjs scripts/mutation-specs/relocation-guards.mjs
//
// Both rules exist because a Codex peer review MEASURED their absence on
// plugins/image, the first plugin to move, where either gap would have been
// repeated five more times:
//
//   A — COMMAND SKILL POINTERS. A command runbook names its skill by explicit
//       path. Pointing compose back at the pre-relocation
//       `skills/compose/SKILL.md` left kit/lint AND the plugin's own shape test
//       green while the target did not exist.
//   B — THE CLAUDE MANIFEST STAYS SILENT (relocation clause 4). Adding
//       `"skills": "./core/skills/"` to `.claude-plugin/plugin.json` returned
//       image to `Skills (12)` / ~1,183 always-on tok from `Skills (6)` /
//       ~232 — the whole saving undone — with both gates still green.
//
// A guard added because its absence was invisible has to be shown to fail when
// removed, or it is the same silence with more lines. That is what this spec
// is: it breaks each rule on purpose and scores the result against a stated
// expectation. The fixtures live in the gated test file, so every mutation
// here is an edit to the LINTER, never to the tests that judge it — a spec
// that mutated its own oracle would prove nothing.
//
// SCOPE of rule A, restated because the spec cannot test what the rule does not
// cover: the pointer pattern matches 43 pointers across designer, engineer,
// founder, image and orchestrator. `plugins/runtime` carries none — its command
// runbooks are inline — so runtime's own relocation is NOT covered by it.
//
// The G3 anchor is the regex literal's tail INCLUDING the closing paren. An
// earlier draft anchored on `SKILL\.md/g` and the harness refused to score it
// rather than reporting a verdict on an edit that never applied; that refusal
// is the harness working, and the anchor was widened rather than the check
// loosened.
//
// Recorded result at authoring time (2026-09-21): 6/6 as-expected.

const T = 'kit/lint/tests/test-check-plugin-shape.mjs';
const LINT = 'kit/lint/check-plugin-shape.mjs';

export const TESTS = [T];

export const MUTATIONS = [
  // ---- B. the Claude manifest clause --------------------------------------
  {
    id: 'B1', file: LINT,
    from: 'if (claudeManifest && claudeManifest.skills !== undefined) {',
    to: 'if (false && claudeManifest && claudeManifest.skills !== undefined) {',
    why: 'clause 4 disabled — a Claude manifest declaring the relocated root must not pass',
  },

  // ---- A. command skill pointers ------------------------------------------
  {
    id: 'A1', file: LINT,
    from: '\nawait checkCommandSkillPointers();',
    to: '\n// await checkCommandSkillPointers();',
    why: 'the check is never called — every pointer case must fail',
  },
  {
    id: 'A2', file: LINT,
    from: 'SKILL\\.md)/g',
    to: 'SKILL\\.mdX)/g',
    why: 'the pointer pattern matches nothing — a guard that matches nothing is the failure being guarded against',
  },
  {
    id: 'A3', file: LINT,
    from: "    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;",
    to: "    if (!entry.isFile() || !entry.name.endsWith('.markdown')) continue;",
    why: 'no command file is ever read — the walk must not silently skip everything it should open',
  },
  {
    id: 'A4', file: LINT,
    from: '      if (escapesPluginDir(target)) {\n        errors.push(`${label} escapes the plugin directory`);\n        continue;\n      }',
    to: '      if (false) {\n        errors.push(`${label} escapes the plugin directory`);\n        continue;\n      }',
    why: 'containment dropped — a pointer escaping the plugin must not be accepted',
  },
  {
    id: 'A5', file: LINT,
    from: 'if (!info.isFile()) errors.push(`${label} resolves to something that is not a file`);',
    to: 'if (false) errors.push(`${label} resolves to something that is not a file`);',
    why: 'a pointer resolving to a directory is accepted as a skill file',
  },

  // ---- C. references inside the skills tree -------------------------------
  {
    id: 'C1', file: LINT,
    from: '  if (await exists(root)) await checkSkillTreeReferences(root);',
    to: '  if (false) await checkSkillTreeReferences(root);',
    why: 'the reference check is never called — every reference case must fail',
  },
  {
    id: 'C2', file: LINT,
    from: "const SKILL_REF_MANAGED_EXT = /\\.(md|mjs|js|json|ya?ml|txt)$/;",
    to: "const SKILL_REF_MANAGED_EXT = /.?/;",
    why: 'the extension filter qualifies everything — the illustrative ../../etc/passwd token must stay excluded',
  },
  {
    id: 'C3', file: LINT,
    from: '      if (escapesPluginDir(target) && !repoLayoutPresent) return;',
    to: '      if (escapesPluginDir(target)) return;',
    why: 'KNOWN BLIND SPOT, recorded rather than claimed: dropping the layout probe so outbound '
      + 'references are ALWAYS skipped is invisible to these fixtures, because every one of them sits '
      + 'in a tmpdir where the layout is absent and the branch is taken anyway. Only a run against the '
      + 'real repository tree distinguishes the two, and that is lint:plugin-shape, not this spec.',
    expect: 'SURVIVED',
  },
  {
    id: 'C4', file: LINT,
    from: 'const SKILL_REF_ROOT_RELATIVE = /(?<![A-Za-z0-9_/.$-])(?:core\\/)?skills\\/[A-Za-z0-9_@./-]+/g;',
    to: 'const SKILL_REF_ROOT_RELATIVE = /(?<![A-Za-z0-9_/.$-])(?:core\\/)?skills-nope\\/[A-Za-z0-9_@./-]+/g;',
    why: 'the plugin-root-relative pattern matches nothing',
  },
  {
    id: 'C5', file: LINT,
    from: 'const repoLayoutPresent = basename(dirname(PLUGIN_DIR)) === \'plugins\'',
    to: 'const repoLayoutPresent = true || basename(dirname(PLUGIN_DIR)) === \'plugins\'',
    why: 'the layout is assumed rather than detected — the fixture pinning limit 2 must fail',
  },
];
