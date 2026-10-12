// Mutation spec — the kit/lint rules that guard a skills-root relocation.
//
// Run: node scripts/mutation-harness.mjs scripts/mutation-specs/relocation-guards.mjs
//
// Both first rules exist because a Codex peer review MEASURED their absence on
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
// The rest close shapes that passed later (C23, C25):
//
//   A6/A7 — the pointer pattern read only the unbraced `$CLAUDE_PLUGIN_ROOT/`,
//       so once the commands moved to `${CLAUDE_PLUGIN_ROOT}` (2026-09-29) it
//       checked 0 of 45 pointers. Each spelling has a mutation of its own.
//   D — a command's references to the skills tree's other documents.
//   E, F — the sibling-relative `./` and bare `references/` shapes inside the
//       tree, F2–F5 pinning the directory a bare `references/` is read from.
//   G — a core/skills/ tree the Codex manifest does not declare.
//   H — a reference must name a file, not a directory.
//
// A guard added because its absence was invisible has to be shown to fail when
// removed, or it is the same silence with more lines. That is what this spec
// is: it breaks each rule on purpose and scores the result against a stated
// expectation. The fixtures live in the gated test file, so every mutation
// here is an edit to the LINTER, never to the tests that judge it — a spec
// that mutated its own oracle would prove nothing.
//
// SCOPE of rule A, restated because the spec cannot test what the rule does not
// cover: the pointer pattern matches 45 pointers across designer, engineer,
// founder, image and orchestrator. `plugins/runtime` carries none — its command
// runbooks are inline — so runtime's own relocation is NOT covered by it.
//
// The A2 anchor is the regex literal's tail INCLUDING the closing paren. An
// earlier draft anchored on `SKILL\.md/g` and the harness refused to score it
// rather than reporting a verdict on an edit that never applied; that refusal
// is the harness working, and the anchor was widened rather than the check
// loosened.
//
// Recorded result at authoring time (2026-09-21): 6/6 as-expected. With the
// C23/C25 rules (2026-10-12): 28/28 as-expected.

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
  {
    id: 'A6', file: LINT,
    from: 'const COMMAND_SKILL_POINTER = /\\$(?:\\{CLAUDE_PLUGIN_ROOT\\}|CLAUDE_PLUGIN_ROOT)\\/(',
    to: 'const COMMAND_SKILL_POINTER = /\\$CLAUDE_PLUGIN_ROOT\\/(',
    why: 'the braced spelling unread — the state that checked 0 of the 45 real pointers (C23)',
  },
  {
    id: 'A7', file: LINT,
    from: 'const COMMAND_SKILL_POINTER = /\\$(?:\\{CLAUDE_PLUGIN_ROOT\\}|CLAUDE_PLUGIN_ROOT)\\/(',
    to: 'const COMMAND_SKILL_POINTER = /\\$\\{CLAUDE_PLUGIN_ROOT\\}\\/(',
    why: 'the unbraced spelling unread — fixing the braced one must not drop the other',
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
    from: '      if (escapesPluginDir(target) && !repoLayoutPresent) continue;',
    to: '      if (escapesPluginDir(target)) continue;',
    why: 'outbound references always skipped, never merely when undecidable. This was a recorded '
      + 'BLIND SPOT while every fixture sat in a bare tmpdir where the branch was taken anyway; the '
      + 'repository-layout fixtures added on S3 reach it, so it is now a scored kill rather than a '
      + 'limitation written down.',
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
  {
    id: 'C6', file: LINT,
    from: 'const SKILL_REF_REPO_RELATIVE = /(?<![A-Za-z0-9_@.-])plugins\\/[a-z0-9-]+\\/[A-Za-z0-9_@./-]+/g;',
    to: 'const SKILL_REF_REPO_RELATIVE = /(?<![A-Za-z0-9_@.-])plugins-nope\\/[a-z0-9-]+\\/[A-Za-z0-9_@./-]+/g;',
    why: 'the repo-relative pattern matches nothing — the shape that cites a SIBLING plugin, which neither other pattern sees',
  },

  // ---- D. a command's references into the skills tree ---------------------
  {
    id: 'D1', file: LINT,
    from: '\nawait checkCommandSkillTreeReferences();',
    to: '\n// await checkCommandSkillTreeReferences();',
    why: 'the command reference check is never called — a document reference reverted to skills/ passes (C23)',
  },
  {
    id: 'D2', file: LINT,
    from: "      [COMMAND_SKILL_TREE_POINTER, PLUGIN_DIR, 'plugin-root pointer', isSkillFile],\n",
    to: '',
    why: 'the ${CLAUDE_PLUGIN_ROOT}/ document pointer unread — both spellings of it must fail',
  },
  {
    id: 'D3', file: LINT,
    from: "      [SKILL_REF_ROOT_RELATIVE, PLUGIN_DIR, 'plugin-root-relative'],\n    ]);",
    to: '    ]);',
    why: 'the bare core/skills/… reference in a command unread — the founder and designer critique.md shape',
  },

  // ---- E, F. sibling-relative and bare references/ in the tree ------------
  {
    id: 'E1', file: LINT,
    from: 'const SKILL_REF_SIBLING_RELATIVE = /(?<![A-Za-z0-9_@./-])\\.\\/[A-Za-z0-9_@./-]+/g;',
    to: 'const SKILL_REF_SIBLING_RELATIVE = /(?<![A-Za-z0-9_@./-])\\.-nope\\/[A-Za-z0-9_@./-]+/g;',
    why: 'the sibling-relative pattern matches nothing',
  },
  {
    id: 'F1', file: LINT,
    from: 'const SKILL_REF_BARE_REFERENCES = /(?<![A-Za-z0-9_@./$-])references\\/[A-Za-z0-9_@./-]+/g;',
    to: 'const SKILL_REF_BARE_REFERENCES = /(?<![A-Za-z0-9_@./$-])references-nope\\/[A-Za-z0-9_@./-]+/g;',
    why: 'the bare references/ pattern matches nothing',
  },
  {
    id: 'F2', file: LINT,
    from: "[SKILL_REF_BARE_REFERENCES, await skillDirOf(file, skillsRoot), 'skill-relative'],",
    to: "[SKILL_REF_BARE_REFERENCES, dirname(file), 'skill-relative'],",
    why: 'a bare references/ read from the citing file’s directory — references/guide.md citing references/spec.md must still pass',
  },
  {
    id: 'F3', file: LINT,
    from: '  return resolve(skillsRoot, relative(skillsRoot, dirname(file)).split(sep)[0]);',
    to: '  return dirname(file);',
    why: 'the _shared/ fallback lost — _shared/references/protocol.md citing its own references/notes.md must still pass',
  },

  // ---- G. a core/skills/ tree the manifest does not declare (C25) ---------
  {
    id: 'G1', file: LINT,
    from: 'if (codexManifest && !relocatedRootDeclared) {',
    to: 'if (false && codexManifest && !relocatedRootDeclared) {',
    why: 'the undeclared-tree rule disabled — skills reverted to ./skills/ with the tree in core/skills/ passes',
  },
  {
    id: 'G2', file: LINT,
    from: 'for (const root of skillsRoots) relocatedRootDeclared ||= await declaresRelocatedRoot(root);',
    to: "relocatedRootDeclared = codexManifest?.skills === './core/skills/';",
    why: 'the declared root compared by spelling, not by path — "core/skills" names the same root and must pass',
  },
  {
    id: 'G3', file: LINT,
    from: '  const real = (await containedRealPath(root)) ?? root;',
    to: '  const real = root;',
    why: 'the declared root compared lexically — a declared symlink to core/skills/ declares it and must pass',
  },
  {
    id: 'G4', file: LINT,
    from: '  return real === realRelocatedRoot || !escapesDir(real, realRelocatedRoot);',
    to: '  return real === realRelocatedRoot;',
    why: 'containment dropped — a declared "./core/" holds core/skills/ and must pass',
  },

  // ---- F, H. the skill directory and the file a reference names -----------
  {
    id: 'F4', file: LINT,
    from: "    if (await exists(resolve(dir, 'SKILL.md'))) return dir;",
    to: '    if (false) return dir;',
    why: 'the ancestor search lost — a nested skill’s references/ must be read from that skill, not the top-level directory',
  },
  {
    id: 'F5', file: LINT,
    from: 'dir === skillsRoot || !escapesDir(skillsRoot, dir);',
    to: '!escapesDir(skillsRoot, dir);',
    why: 'the skills root itself skipped — a SKILL.md at the root makes the root the skill directory',
  },
  {
    id: 'H1', file: LINT,
    from: '      if (!(await stat(target).then((info) => info.isFile(), () => false))) {',
    to: '      if (!(await exists(target))) {',
    why: 'a reference resolving to a directory accepted as a document',
  },
];
