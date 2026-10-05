// Mutation spec — do the C3 tests catch the defects they exist for?
//
// Run: npm run mutate -- scripts/mutation-specs/off-branch-archive.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. Both rules fail quietly. A terminal workflow
// left on a kept branch just sits in workflows/ and holds a macro's
// no_active_engineer_children gate closed; nothing prints. A sweep that judged
// it against HEAD instead of its own branch would archive it anyway and write
// an unrelated commit into the parent's note, which reads like a real sha. A
// /done scan that reads an unreadable file as "no child" completes the
// subtask and exits 0. A green suite proves nothing about these; deleting
// each rule and watching a named test fail does.
//
// Groups: K the engineer sweep on a kept branch, S the designer and founder
// copies, G the /orchestrator:done scans.

const T_ENG = 'tests/engineer/test-stop-archive.mjs';
// designer's and founder's stop-archive is one canonical source generated into
// both (ADR-0066); its suite is parametrized over both, so a defect in one
// persona's copy fails that persona's cases.
const T_DES = 'tests/persona-pipeline/test-stop-archive.mjs';
const T_FOU = 'tests/persona-pipeline/test-stop-archive.mjs';
const T_DONE = 'tests/orchestrator/test-done-runbook.mjs';

const ENG = 'plugins/engineer/scripts/stop-archive.mjs';
const DES = 'plugins/designer/scripts/stop-archive.mjs';
const FOU = 'plugins/founder/scripts/stop-archive.mjs';
const stateOf = (file) => file.replace('stop-archive.mjs', 'state.mjs');
const DONE = 'plugins/orchestrator/commands/done.md';

export const TESTS = [T_ENG, T_DES, T_DONE];

const keptBranchPath = (id, file, tests, persona) => [
  {
    id: `${id}1`, file, tests,
    from: "    if (refState === 'present') {",
    to: '    if (false) {',
    why: `${persona}: a terminal workflow on a kept branch is left for a Stop that never comes (the C3 failure)`,
  },
  {
    id: `${id}2`, file, tests,
    from: '  const tip = branchTip(repoRoot, branch);',
    to: '  const tip = branchTip(repoRoot, checkedOutBranch(repoRoot).branch);',
    why: `${persona}: the kept branch is judged against the checked-out branch's HEAD`,
  },
  {
    id: `${id}3`, file, tests,
    from: "    if (checkout.state === 'branch' && branch === checkout.branch) continue; // the per-branch path owns it",
    to: '    void 0;',
    why: `${persona}: the sweep takes the checked-out branch's workflow from the per-branch path`,
  },
  {
    id: `${id}4`, file, tests,
    from: '  if (!verdict.shouldArchive) return null;',
    to: '  void 0;',
    why: `${persona}: a kept branch that never moved is archived anyway`,
  },
  {
    id: `${id}5`, file, tests,
    from: '  if (!tip) return null;',
    to: "  if (!tip) { await archiveWorkflow({ workflowPath, host, repoRoot }); return { workflowPath, archived: true }; }",
    why: `${persona}: a ref that does not resolve to a commit is treated as deleted and archived`,
  },
  {
    id: `${id}6`, file, tests,
    from: "      if (checkout.state === 'unknown') continue; // any kept branch could be the checked-out one",
    to: '      void 0;',
    why: `${persona}: with the checkout unknown, the checked-out branch's workflow is judged by the sweep`,
  },
  {
    id: `${id}7`, file, tests,
    from: '  if (!descendsFrom(repoRoot, frontmatter?.git_baseline?.head, tip.sha)) return null;',
    to: '  void 0;',
    why: `${persona}: a kept branch reset below its baseline counts as moved and is archived`,
  },
  {
    id: `${id}8`, file: stateOf(file), tests,
    from: "    return err && err.status === 1 ? { state: 'detached' } : { state: 'unknown' };",
    to: "    return { state: 'unknown' };",
    why: `${persona}: a confirmed detached HEAD is treated as unknown, so no kept branch is ever judged there`,
  },
  {
    id: `${id}9`, file, tests,
    from: '  const verdict = evaluateStopArchive({ frontmatter, headSha: tip.sha, headSubject: tip.subject });',
    to: '  const verdict = evaluateStopArchive({ frontmatter: { ...frontmatter, child_completions: [] }, headSha: tip.sha, headSubject: tip.subject });',
    why: `${persona}: the sweep archives a kept-branch workflow whose child is unfinished`,
  },
];

export const MUTATIONS = [
  // ---- K: the engineer sweep on a kept branch ---------------------------------
  ...keptBranchPath('K', ENG, [T_ENG], 'engineer'),
  {
    id: 'K10', file: ENG, tests: [T_ENG],
    from: '    await noteTerminalOnParent({ frontmatter, commit: tip.sha, host, repoRoot, stderr });',
    to: "    await noteTerminalOnParent({ frontmatter, commit: branchTip(repoRoot, checkedOutBranch(repoRoot).branch)?.sha, host, repoRoot, stderr });",
    why: 'the parent note carries the checked-out HEAD instead of the child branch tip',
  },
  {
    id: 'K11', file: ENG, tests: [T_ENG],
    from: '  if (!verdict.shouldArchive) return null;',
    to: "  if (!verdict.shouldArchive) { await snapshot({ workflowPath, host, trigger: 'stop', statusDigest: '' }); return null; }",
    why: 'a kept branch that can never pass grows by a snapshot on every Stop',
  },

  // ---- S: the designer and founder copies -------------------------------------
  ...keptBranchPath('SD', DES, [T_DES], 'designer'),
  ...keptBranchPath('SF', FOU, [T_FOU], 'founder'),

  // ---- G: /orchestrator:done scans fail closed --------------------------------
  {
    id: 'G1', file: DONE, tests: [T_DONE],
    from: ')" || {\n    echo "✗ Could not scan the engineer workflow homes for an active child of $SUBTASK_ID (see the error above); refusing --no-commit." >&2\n    exit 1\n  }',
    to: ')"',
    why: '--no-commit reads a failed child scan as "no child" and completes the subtask',
  },
  {
    id: 'G2', file: DONE, tests: [T_DONE],
    from: 'catch (e) { if (missing(e)) continue; throw e; }\n            if (text.includes(',
    to: 'catch (e) { continue; }\n            if (text.includes(',
    why: '--no-commit skips a child file it cannot read',
  },
  {
    id: 'G3', file: DONE, tests: [T_DONE],
    from: 'let names = []; try { names = fs.readdirSync(dir); } catch (e) { if (missing(e)) continue; throw e; }',
    to: 'let names = []; try { names = fs.readdirSync(dir); } catch (e) { continue; }',
    why: '--no-commit skips a workflow home it cannot list',
  },
  {
    id: 'G4', file: DONE, tests: [T_DONE],
    from: ')" || {\n    echo "✗ Could not scan the engineer workflow homes for $SUBTASK_ID\'s owner (see the error above); refusing to guess." >&2\n    exit 1\n  }',
    to: ')"',
    why: 'the owner scan reads a failed scan as its result and records a guessed owner',
  },
  {
    id: 'G5', file: DONE, tests: [T_DONE],
    from: 'catch (e) { if (missing(e)) continue; throw e; }\n            const fm =',
    to: 'catch (e) { continue; }\n            const fm =',
    why: 'the owner scan skips a file it cannot read, which could be a second claimant',
  },
];
