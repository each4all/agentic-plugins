// Mutation spec — do the subject-type tests catch the defects they exist for?
// (ADR-0028 §P6, implementation note of 2026-11-04, C163)
//
// Run: npm run mutate -- scripts/mutation-specs/phase7-subject-type.mjs
//
// Every rule here fails quietly: a commit with the wrong type still lands, and
// only the release that does not happen (or happens for nothing) shows it, a
// landing later. Each mutation removes one rule and names the tests that must
// notice. The mutations edit the generated copy the tests import (ADR-0066):
// engineer is the one persona with the commit driver.
//
// Groups: R the rule itself (subjectRule, packageScopes, checkSubjectRule,
// changeContent), S the suggestion (inferSubject, plan mode), X execute's
// check (warning, refusal, the topic cut short), A autopilot's own refusals,
// L the recovery path's landed subjects, B the commit runbook's Autopilot
// block, I the interactive Phase 7 runbook texts.

const T_TYPE = 'tests/persona-pipeline/test-phase7-subject-type.mjs';
const T_RUNBOOK = 'tests/persona-pipeline/test-commit-runbook.mjs';

const PHASE7 = 'plugins/engineer/scripts/phase7-commit.mjs';
const COMMIT_MD = 'plugins/engineer/commands/commit.md';
const START_MD = 'plugins/engineer/commands/start.md';
const SKILL_MD = 'plugins/engineer/core/skills/commit/SKILL.md';
const START_SKILL_MD = 'plugins/engineer/core/skills/start/SKILL.md';

export const TESTS = [T_TYPE, T_RUNBOOK];

const T_MAP = /applies only with a package map: none, or an empty one, checks nothing/;
const T_CONSUMER = /a consumer repository with no release-please configuration/;
const T_PACKAGE = /a package commit takes feat or fix and a scope naming the package/;
const T_OTHER_SCOPE = /a scope that is another package's own is not this one's/;
const T_DATA = /a change under plugins\/runtime\/data\/ is named as such, and takes feat or fix/;
const T_DATA_AUTO = /a change under plugins\/runtime\/data\/ without feat or fix is refused, naming the data/;
const T_NO_PACKAGE = /a commit touching no package path is never feat or fix: docs, test, or chore\/ci\/refactor by content/;
const T_NOT_CC = /a subject that is not a conventional commit fails with no correction/;
const T_INFER = /inferSubject keeps the verb's type where the change allows it and corrects it where not/;
const T_PLAN = /a mixed change is decided by its package part; a split names each commit's rule/;
const T_WARN = /a feat on a documentation-only change outside every package commits as given, with the warning/;
const T_FITS = /a subject that fits draws no warning \(control\)/;
const T_AUTO_TYPE = /a type that does not route the package, or a scope that does not name it, is refused/;
const T_AUTO_SUBJECT = /no subject, or --suggested-subjects, is refused; so is a description that is the topic cut short/;
const T_MIXED = /a mixed change is decided by its package part: docs refused, fix taken/;
const T_SPLIT = /a split checks every commit before the first: one bad subject commits none/;
const T_RETRY = /a retry after a partial split checks the commits it still makes/;
const T_LANDED_AUTO = /under autopilot a landed subject that does not fit is refused \(exit 9\), writing nothing/;
const T_LANDED_WARN = /interactively it warns with the corrected subject and recovers/;
const T_EMPTY = /an empty description fails, whatever the type/;
const T_ROOT = /a root package \("\."\) owns the paths no other package does/;
const T_LENIENT = /--lenient-cc does not loosen autopilot, and an empty summary is refused/;
const T_RETRY_LANDED = /under autopilot an earlier landed commit whose subject does not fit refuses the retry/;
const T_LANDED_ALL = /every landed commit is checked, not only the newest, and a landed topic cut short is refused/;
const T_RUNBOOK_AUTO = /under autopilot: Phase 0 prints the commit rules, and the Autopilot block commits/;
const T_RUNBOOK_CLOSE = /under autopilot: on a clean tree the Autopilot block, with no subject written, closes the workflow/;
const T_RUNBOOK_SPLIT = /under autopilot: a split commits each package with its own subject, from the lines added where the block shows them/;
const T_LANDED_SPLIT = /a landed commit touching several packages has no one subject: it is to be split/;
const T_TEXT_COMMIT = /commands\/commit\.md § commit-plan/;
const T_TEXT_SKILL = /core\/skills\/commit\/SKILL\.md § commit-plan/;
const T_TEXT_START = /commands\/start\.md § start-commit/;
const T_TEXT_START_SKILL = /core\/skills\/start\/SKILL\.md § ### Phase 7/;
const T_NO_COPY =/a refusal for the topic cut short or an empty description gives no subject to copy, only the type and scope to keep/;

export const MUTATIONS = [
  // ---- R: the rule --------------------------------------------------------------
  {
    id: 'R1', file: PHASE7, tests: [T_TYPE],
    from: '  if (!Array.isArray(packageMap) || packageMap.length === 0) return null;\n  const list = Array.isArray(files) ? files : [];\n',
    to: '  if (!Array.isArray(packageMap)) return null;\n  const list = Array.isArray(files) ? files : [];\n',
    why: 'an empty package map (a consumer repository) is read as "every path outside a package": its docs commits stop taking feat',
    killed_by: [T_MAP, T_CONSUMER],
  },
  {
    id: 'R2', file: PHASE7, tests: [T_TYPE],
    from: "const RELEASE_ROUTING_TYPES = Object.freeze(['feat', 'fix']);",
    to: "const RELEASE_ROUTING_TYPES = Object.freeze(['feat', 'fix', 'chore']);",
    why: 'a package commit may take chore, which routes no release (the Macro 6 c167 landing)',
    killed_by: [T_PACKAGE, T_AUTO_TYPE],
  },
  {
    id: 'R3', file: PHASE7, tests: [T_TYPE],
    from: '  const primary = packageScope(packageKey, packageMap);\n  const candidates = [primary, packageKey];',
    to: '  const primary = packageScope(packageKey);\n  const candidates = [primary, packageKey];',
    why: "plugins/companions accepts the bare scope `companions`, which names the root companions package",
    killed_by: [T_OTHER_SCOPE],
  },
  {
    id: 'R4', file: PHASE7, tests: [T_TYPE],
    from: '    const runtimeData = list.some((p) => p.startsWith(RUNTIME_DATA_PREFIX));',
    to: '    const runtimeData = false;',
    why: 'a change to plugins/runtime/data/ is refused without saying that the installed plugin reads it',
    killed_by: [T_DATA, T_DATA_AUTO],
  },
  {
    id: 'R5', file: PHASE7, tests: [T_TYPE],
    from: "  if (list.every(isTestPath)) return 'tests';",
    to: '',
    why: 'a tests-only change outside every package is classed documentation or other, and test is refused for it',
    killed_by: [T_NO_PACKAGE, T_SPLIT],
  },
  {
    id: 'R6', file: PHASE7, tests: [T_TYPE],
    from: "    return { ok: false, problems: ['it is not a conventional-commit subject'], corrected: null };",
    to: "    return { ok: true, problems: [], corrected: null };",
    why: 'a subject that is not a conventional commit passes the rule',
    killed_by: [T_NOT_CC],
  },
  {
    id: 'R7', file: PHASE7, tests: [T_TYPE],
    from: "  if (parsed.description.trim() === '') problems.push('its description is empty; it summarizes the change');\n",
    to: '',
    why: 'a subject with an empty description (fix(engineer):) is committed',
    killed_by: [T_EMPTY, T_LENIENT],
  },
  {
    id: 'R8', file: PHASE7, tests: [T_TYPE],
    from: "  if (!packageKey && packageMap.includes('.')) return null;\n",
    to: '',
    why: "a root package's files route as docs-only and are refused feat and fix",
    killed_by: [T_ROOT],
  },
  {
    id: 'R9', file: PHASE7, tests: [T_TYPE],
    from: '  return DOCUMENTATION_EXTENSION_RE.test(p);',
    to: "  return p.split('/')[0] === 'docs' || DOCUMENTATION_EXTENSION_RE.test(p);",
    why: 'a script under docs/ counts as documentation, and docs is forced on it',
    killed_by: [T_NO_PACKAGE],
  },
  // ---- S: the suggestion --------------------------------------------------------
  {
    id: 'S1', file: PHASE7, tests: [T_TYPE],
    from: '  return rule === null ? subject : checkSubjectRule({ subject, rule }).corrected;',
    to: '  return subject;',
    why: 'the suggestion keeps the verb\'s type whatever the change: a critique of package code still suggests chore',
    killed_by: [T_INFER, T_PLAN],
  },
  {
    id: 'S2', file: PHASE7, tests: [T_TYPE],
    from: '        packageMap,\n        files: c.files,\n      }),',
    to: '        packageMap,\n      }),',
    why: "plan mode suggests without the commit's files: a documentation-only docs commit is suggested chore",
    killed_by: [T_PLAN],
  },
  // ---- X: execute's check -------------------------------------------------------
  {
    id: 'X1', file: PHASE7, tests: [T_TYPE],
    from: '  if (failures.length > 0) {\n    reportSubjectProblems({\n      failures, enforce: enforceSubjects, stderr,\n',
    to: '  if (false) {\n    reportSubjectProblems({\n      failures, enforce: enforceSubjects, stderr,\n',
    why: 'execute never reports a subject that does not fit: no warning, no reason',
    killed_by: [T_WARN],
  },
  {
    id: 'X1b', file: PHASE7, tests: [T_TYPE],
    from: '  if (enforceSubjects && (failures.length > 0 || landedFailures.length > 0)) {',
    to: '  if (enforceSubjects && landedFailures.length > 0) {',
    why: 'under autopilot a subject of a commit still to make that does not fit is reported, and committed',
    killed_by: [T_AUTO_TYPE, T_MIXED, T_SPLIT, T_RETRY],
  },
  {
    id: 'X5', file: PHASE7, tests: [T_TYPE],
    from: '  if (enforceSubjects) strictCC = true;\n',
    to: '',
    why: '--lenient-cc loosens autopilot: a subject that is not a conventional commit lands with a warning',
    killed_by: [T_LENIENT],
  },
  {
    id: 'X2', file: PHASE7, tests: [T_TYPE],
    from: '    if (problems.length > 0) failures.push(',
    to: '    if (problems.length >= 0) failures.push(',
    why: 'every subject is reported, a fitting one too',
    killed_by: [T_FITS],
  },
  {
    id: 'X3', file: PHASE7, tests: [T_TYPE],
    from: "  const enforceSubjects = flags['autopilot-subjects'] === true;",
    to: '  const enforceSubjects = false;',
    why: 'under autopilot a subject that does not fit only warns, and commits',
    killed_by: [T_AUTO_TYPE, T_DATA_AUTO, T_MIXED, T_SPLIT, T_RETRY, T_LANDED_AUTO],
  },
  {
    id: 'X4', file: PHASE7, tests: [T_TYPE],
    from: '  const topicCut = enforceSubjects ? truncatedTopic(frontmatter) : null;',
    to: '  const topicCut = null;',
    why: "under autopilot the suggestion's description, the topic cut short, is committed",
    killed_by: [T_AUTO_SUBJECT],
  },
  {
    id: 'X6', file: PHASE7, tests: [T_TYPE],
    from: '  if (!replaceDescription) return { corrected: verdict.ok ? null : verdict.corrected, rewrite: null, summary_needed: false };',
    to: '  if (true) return { corrected: verdict.ok ? null : verdict.corrected, rewrite: null, summary_needed: false };',
    why: 'a refusal for the topic cut short offers a corrected subject that keeps the cut description, which a worker copies and is refused again (C163 critique F2)',
    killed_by: [T_NO_COPY],
  },
  {
    id: 'X7', file: PHASE7, tests: [T_TYPE],
    from: "    : `${fixed.type}${fixed.scope ? `(${fixed.scope})` : ''}${fixed.breaking ? '!' : ''}`;",
    to: "    : (verdict.corrected ?? '').slice(0, (verdict.corrected ?? '').indexOf(':'));",
    why: 'the type and scope to keep are cut at the first colon, which a scope may hold: the prefix named is not a valid subject start (refine-verify MINOR)',
    killed_by: [T_NO_COPY],
  },
  // ---- A: autopilot's own refusals ----------------------------------------------
  {
    id: 'A1', file: PHASE7, tests: [T_TYPE],
    from: "  if (typeof flags.subject !== 'string' && flags['subject-pkg'].length === 0) {\n    stderr.write(\n      '✗ refused under autopilot: no subject was given",
    to: "  if (false) {\n    stderr.write(\n      '✗ refused under autopilot: no subject was given",
    why: 'autopilot with no subject reaches execute, which fails on the missing flag without the reason or the exit code',
    killed_by: [T_AUTO_SUBJECT],
  },
  {
    id: 'A2', file: PHASE7, tests: [T_TYPE],
    from: "  if (flags.mode === 'autopilot' && flags['suggested-subjects'] === true) {",
    to: "  if (false && flags['suggested-subjects'] === true) {",
    why: '--suggested-subjects is not refused by --mode autopilot',
    killed_by: [T_AUTO_SUBJECT],
  },
  // ---- L: the recovery path -----------------------------------------------------
  {
    id: 'L1', file: PHASE7, tests: [T_TYPE],
    from: '      const landedFailures = landedSubjectProblems({ repoRoot, shas: noChanges.marked_commits, packageMap, topicCut });',
    to: '      const landedFailures = [];',
    why: 'the recovery path finishes landed commits whose subjects do not fit, unchecked',
    killed_by: [T_LANDED_AUTO, T_LANDED_WARN],
  },
  {
    id: 'L2', file: PHASE7, tests: [T_TYPE],
    from: '    repoRoot, shas: markedCommitShas({ repoRoot, frontmatter }), packageMap, topicCut,',
    to: '    repoRoot, shas: [], packageMap, topicCut,',
    why: "a retry checks only the commits it still makes: an earlier attempt's landed subject goes unchecked",
    killed_by: [T_RETRY_LANDED],
  },
  {
    id: 'L3', file: PHASE7, tests: [T_TYPE],
    from: '  for (const sha of shas) {\n    const subject = gitSync(repoRoot, [\'log\', \'-1\', \'--format=%s\', sha], { allowFailure: true }) ?? \'\';',
    to: '  for (const sha of shas.slice(0, 1)) {\n    const subject = gitSync(repoRoot, [\'log\', \'-1\', \'--format=%s\', sha], { allowFailure: true }) ?? \'\';',
    why: 'only the newest landed commit is checked',
    killed_by: [T_LANDED_ALL],
  },
  {
    id: 'L4', file: PHASE7, tests: [T_TYPE],
    from: '    const problems = [...verdict.problems, ...topicCutProblem(subject, topicCut)];',
    to: '    const problems = [...verdict.problems];',
    why: 'a landed commit whose description is the topic cut short is finished unchecked',
    killed_by: [T_LANDED_ALL],
  },
  {
    id: 'L5', file: PHASE7, tests: [T_TYPE],
    from: "        ? 'A landed commit is the owner\\'s to reword, or to split where it touches several packages: this step rewrites no history (no amend, rebase or reset). ' +\n          'Report each landed commit named above, with its reason, in the step\\'s report, and stop.\\n'\n",
    to: "        ? 'Reword the landed commit (keeping its Workflow-ID trailer), then run the step again.\\n'\n",
    why: 'under autopilot the landed-commit refusal tells the headless worker to rewrite branch history, which the runbook leaves to the owner (C163 critique F3)',
    killed_by: [T_LANDED_AUTO],
  },
  {
    id: 'L6', file: PHASE7, tests: [T_TYPE],
    from: '        corrected: null,\n        split_needed: true,\n',
    to: '        corrected: null,\n',
    why: 'a landed commit touching several packages is refused with no way out named: neither a corrected subject nor the split it needs',
    killed_by: [T_LANDED_SPLIT],
  },
  // ---- I: the interactive Phase 7 runbook texts ---------------------------------
  {
    id: 'I1', file: START_MD, tests: [T_TYPE],
    from: 'check a subject the user edited against it before execute',
    to: 'present a subject the user edited before execute',
    why: '/start Phase 7, the interactive Phase 7, never tells the agent to check an edited subject against subject_rule (C163 critique F4)',
    killed_by: [T_TEXT_START],
  },
  {
    id: 'I2', file: SKILL_MD, tests: [T_TYPE],
    from: '    given, and prints the corrected subject: pass the warning and the\n    corrected subject to the user',
    to: '    given, and prints the corrected subject',
    why: "the Codex commit skill drops execute's warning and corrected subject on the floor instead of passing them to the user (C163 critique F4)",
    killed_by: [T_TEXT_SKILL],
  },
  {
    id: 'I3', file: COMMIT_MD, tests: [T_TYPE],
    from: ' and, for a\n  package commit, one of its `scopes`; check it before execute.',
    to: '; check it before execute.',
    why: 'the Claude commit-plan text drops the package commit\'s scope from the rule it states',
    killed_by: [T_TEXT_COMMIT],
  },
  {
    id: 'I4', file: START_SKILL_MD, tests: [T_TYPE],
    from: '   `scopes`: check a subject the user edited against it before execute,\n',
    to: '   `scopes`, and present a subject the user edited before execute,\n',
    why: 'the Codex /start skill, whose Phase 7 is its own text, never tells the agent to check an edited subject against subject_rule (C163 refine-verify MAJOR)',
    killed_by: [T_TEXT_START_SKILL],
  },
  {
    id: 'L7', file: PHASE7, tests: [T_TYPE],
    from: '      tail: !(enforceSubjects && landedFailures.length > 0),\n',
    to: '      tail: true,\n',
    why: 'with a landed commit and a subject still to commit both refused, the worker is told both to stop for the owner and to run the step again',
    killed_by: [T_RETRY_LANDED],
  },
  // ---- B: the commit runbook's Autopilot block ----------------------------------
  {
    id: 'B1', file: COMMIT_MD, tests: [T_RUNBOOK],
    from: '  SUBJECT_ARGS+=(--subject-file "$TEXT_DIR/subject.txt")\n',
    to: '',
    why: "the installed runbook's Autopilot block passes no subject file, so every autopilot commit is refused",
    killed_by: [T_RUNBOOK_AUTO],
  },
  {
    id: 'B2', file: COMMIT_MD, tests: [T_RUNBOOK],
    from: 'if [ -n "$TEXT_DIR" ] && [ -e "$TEXT_DIR/subject.txt" ]; then\n  SUBJECT_ARGS+=(--subject-file "$TEXT_DIR/subject.txt")',
    to: 'if true; then\n  SUBJECT_ARGS+=(--subject-file "$TEXT_DIR/subject.txt")',
    why: 'the Autopilot block always passes the subject file, so on a clean tree (a close, a recovery) the driver fails on the missing file (C163 critique F1)',
    killed_by: [T_RUNBOOK_CLOSE],
  },
  {
    id: 'B3', file: COMMIT_MD, tests: [T_RUNBOOK],
    from: 'SUBJECT_ARGS=()\nif [ -n "$TEXT_DIR" ] && [ -e "$TEXT_DIR/subject.txt" ]; then\n  SUBJECT_ARGS+=(--subject-file "$TEXT_DIR/subject.txt")\nfi\n# A split: one line per commit here, after the two above, each as\n#   SUBJECT_ARGS+=(--subject-pkg-file \'<package>\'="$TEXT_DIR/subject-<n>.txt")\n',
    to: '# A split: one line per commit here, after the two above, each as\n#   SUBJECT_ARGS+=(--subject-pkg-file \'<package>\'="$TEXT_DIR/subject-<n>.txt")\nSUBJECT_ARGS=()\nif [ -n "$TEXT_DIR" ] && [ -e "$TEXT_DIR/subject.txt" ]; then\n  SUBJECT_ARGS+=(--subject-file "$TEXT_DIR/subject.txt")\nfi\n',
    why: "the block shows a split's lines before SUBJECT_ARGS=(), which clears them, so every split is refused for want of a subject (refine-verify MAJOR)",
    killed_by: [T_RUNBOOK_SPLIT],
  },
];
