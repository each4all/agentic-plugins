// Mutation spec — do the tests of a verb step's evidence and of content
// progress notice each part of the rule going missing? (C163; ADR-0063,
// implementation note of 2026-11-04)
//
// Run: npm run mutate -- scripts/mutation-specs/autopilot-step-evidence.mjs
//
// Groups: R the drivers' calls of the rule (the serial driver and the
// scheduler), each held by its end-to-end tests; S the rule's own parts
// (policy.mjs stepEvidence), each by a unit case and, where the topic names
// one, an end-to-end one; N a no-change outcome, which must pass without a
// file changed; C the content fact (the observer's projection, its exclusions
// and HEAD, and the no-progress rule reading it); G the observer's grammar of
// the phase notes (phase-evidence.mjs); W the scripted worker's section, which
// every passing end-to-end scenario rests on.

const POLICY = 'plugins/orchestrator/adapters/claude/autopilot/policy.mjs';
const DRIVER = 'plugins/orchestrator/adapters/claude/autopilot/driver.mjs';
const SCHED = 'plugins/orchestrator/adapters/claude/autopilot/scheduler.mjs';
const OBSERVE = 'plugins/orchestrator/adapters/claude/autopilot/observe.mjs';
const GRAMMAR = 'plugins/orchestrator/adapters/claude/autopilot/phase-evidence.mjs';
const DIGEST = 'plugins/orchestrator/scripts/lib/lane-digest.mjs';
const WORKER = 'tests/orchestrator/fixtures/autopilot-scripted-worker.mjs';
const UNIT = 'tests/orchestrator/test-autopilot-step-evidence.mjs';
const RUNS = 'tests/orchestrator/test-autopilot-step-evidence-runs.mjs';

export const TESTS = [UNIT, RUNS];

const T_SERIAL_DISPATCH = /a dispatch whose first verb only recorded its next step halts owner-choice at the dispatch/;
const T_SERIAL_LATER = /a later verb that only rewrote its next step halts owner-choice; one that did its work passes/;
const T_SERIAL_NO_CHANGE = /a later verb that records it changes nothing, and changes no file, passes/;
const T_SERIAL_EDIT = /an owner-forced verb whose only change is an edit of an already-modified file is progress/;
const T_LANE_DISPATCH = /a lane's dispatch whose first verb only recorded its next step halts the lane owner-choice/;
const T_LANE_LATER = /a lane's later verb that only rewrote its next step halts the lane; a recorded no-change outcome passes/;
const T_LANE_EDIT = /an owner-forced verb in a lane whose only change is an edit of an already-modified file is progress/;
const T_U_LATER_PASS = /a later verb that appended its own synthesized section passes/;
const T_U_LATER_HALT = /a later verb that only rewrote the next step halts owner-choice on its subtask/;
const T_U_OTHER = /a section of another verb, or one with no synthesis or artifact, is not the step's work/;
const T_U_REWRITE = /a step that changed the notes before it halts, though it appended a section/;
const T_U_INSERT = /a heading put into the last section before the step/;
const T_U_GONE = /a later verb step that leaves its child archived, or its subtask with no child observed, halts/;
const T_U_SUBMODULE = /a checked-out submodule counts by its own content/;
const T_G_REGION = /only headings after "## Phase notes" are sections/;
const T_G_EMPTY_FENCE = /an empty code block is not the verb's work/;
const T_LANE_PARK = /the halt parks its own lane only: the other lane goes on to its commit/;
const T_U_DISPATCH = /a dispatch's first verb is judged from no sections/;
const T_U_RESUME = /a verification resumption is held to the rule/;
const T_U_EXEMPT = /an owner-forced step, a step whose child records an owner gate/;
const T_U_PROJECTION = /an edit of a file the porcelain status already lists moves the projection/;
const T_U_PROGRESS = /a step whose only change is its files' content is progress/;
const T_G_ORDER = /reports each synthesized section in order/;
const T_G_FENCE = /a heading inside a fenced block is text/;
const T_G_FILE = /reads a workflow file's body after its frontmatter/;
const T_G_REQ_FENCE = /a fence in the request opens nothing, and a backtick line whose info string holds a backtick is no fence/;
const T_G_WRITER = /the engineer's own writer: backticks in the request and an inline-backtick note line/;
const T_U_BOUND = /a later verb step is bound to the child the look before it read/;

export const MUTATIONS = [
  {
    id: 'R1', file: DRIVER, tests: [RUNS],
    from: '      if (!verdict) verdict = stepEvidence({ step: s, before, after: view });',
    to: '      if (!verdict) verdict = null;',
    why: 'the serial driver never judges a verb step by its evidence: a dispatch and a later verb that only rewrote the next step pass',
    killed_by: [T_SERIAL_DISPATCH, T_SERIAL_LATER],
  },
  {
    id: 'R2', file: SCHED, tests: [RUNS],
    from: '    if (!verdict) verdict = stepEvidence({ step: s, before: entry.before, after });',
    to: '    if (!verdict) verdict = null;',
    why: 'the scheduler never judges a lane step by its evidence: a lane\'s dispatch and later verb that only rewrote the next step pass',
    killed_by: [T_LANE_DISPATCH, T_LANE_LATER, T_LANE_PARK],
  },
  {
    id: 'S1', file: POLICY, tests: [UNIT, RUNS],
    from: "  if (!RUNS_A_VERB.has(s.kind) || s.forced === true) return null;",
    to: "  if (s.kind !== 'verb' || s.forced === true) return null;",
    why: "a dispatch's first verb is not judged: a dispatch that only recorded its next step passes",
    killed_by: [T_U_DISPATCH, T_SERIAL_DISPATCH, T_LANE_DISPATCH],
  },
  {
    id: 'S2', file: POLICY, tests: [UNIT, RUNS],
    from: "  if (!RUNS_A_VERB.has(s.kind) || s.forced === true) return null;",
    to: "  if (s.kind !== 'dispatch' || s.forced === true) return null;",
    why: 'a later verb step is not judged, a verification resumption included: one that only rewrote the next step passes',
    killed_by: [T_U_LATER_HALT, T_U_RESUME, T_SERIAL_LATER, T_LANE_LATER],
  },
  {
    id: 'S3', file: POLICY, tests: [UNIT],
    from: '  const fresh = ev.sections.filter((x) => x.start >= base.length && x.substantive === true && (verb === null || x.verb === verb));',
    to: '  const fresh = ev.sections.filter((x) => x.start >= base.length && (verb === null || x.verb === verb));',
    why: 'a section with no synthesis and no artifact counts as the verb\'s work',
    killed_by: [T_U_OTHER],
  },
  {
    id: 'S4', file: POLICY, tests: [UNIT],
    from: '  const fresh = ev.sections.filter((x) => x.start >= base.length && x.substantive === true && (verb === null || x.verb === verb));',
    to: '  const fresh = ev.sections.filter((x) => x.start >= base.length && x.substantive === true);',
    why: 'another verb\'s section counts as the step\'s verb\'s work',
    killed_by: [T_U_OTHER, T_U_DISPATCH],
  },
  {
    id: 'S5', file: POLICY, tests: [UNIT],
    from: '  if (!ev.body.startsWith(base)) {',
    to: '  if (false) {',
    why: 'a step that rewrote the notes before it passes on a section it appended, or on old text a heading it put in front of it makes read as new',
    killed_by: [T_U_REWRITE, T_U_INSERT],
  },
  {
    id: 'S6', file: POLICY, tests: [UNIT],
    from: '  if (child.awaiting_owner?.gate) return null;\n  const wf = child.workflow_id ?? \'?\';',
    to: "  const wf = child.workflow_id ?? '?';",
    why: 'a step whose child records an owner gate halts on its evidence instead of leaving the gate to halt the next decision',
    killed_by: [T_U_EXEMPT],
  },
  {
    id: 'N1', file: POLICY, tests: [UNIT, RUNS],
    from: '  if (fresh.length > 0) return null;',
    to: '  if (fresh.length > 0 && contentMoved(before, after)) return null;',
    why: 'a verb that records it changes nothing halts unless a file changed',
    killed_by: [T_U_RESUME, T_SERIAL_NO_CHANGE, T_LANE_LATER],
  },
  {
    id: 'C1', file: POLICY, tests: [UNIT, RUNS],
    from: '    : fingerprint(before) === fingerprint(after)) && !contentMoved(before, after);',
    to: '    : fingerprint(before) === fingerprint(after));',
    why: 'the no-progress rule ignores the content: a step whose only change is an edit of an already-modified file halts no-progress',
    killed_by: [T_U_PROGRESS, T_SERIAL_EDIT, T_LANE_EDIT],
  },
  {
    id: 'C2', file: OBSERVE, tests: [RUNS],
    from: '    git.content = contentProjection(repoRoot);',
    to: '    git.content = null;',
    why: 'the observer projects no content: an edit of an already-modified file is no progress',
    killed_by: [T_SERIAL_EDIT, T_LANE_EDIT],
  },
  {
    id: 'C3', file: DIGEST, tests: [UNIT],
    from: "  return projectTree(root, { withHead: false, exclude: [...CONTENT_EXCLUDED], trustStat: true, tag: CONTENT_PROJECTION_TAG }).digest;",
    to: "  return projectTree(root, { withHead: false, exclude: [], trustStat: true, tag: CONTENT_PROJECTION_TAG }).digest;",
    why: 'the generated state and the run ledgers count as content: bookkeeping moves the projection',
    killed_by: [T_U_PROJECTION],
  },
  {
    id: 'C4', file: DIGEST, tests: [UNIT],
    from: "  return projectTree(root, { withHead: false, exclude: [...CONTENT_EXCLUDED], trustStat: true, tag: CONTENT_PROJECTION_TAG }).digest;",
    to: "  return projectTree(root, { withHead: true, exclude: [...CONTENT_EXCLUDED], trustStat: true, tag: CONTENT_PROJECTION_TAG }).digest;",
    why: 'HEAD counts as content: a commit of the same files moves the projection',
    killed_by: [T_U_PROJECTION],
  },
  {
    id: 'S7', file: POLICY, tests: [UNIT],
    from: "    if (s.kind === 'dispatch') return null;\n    return halt(",
    to: "    return null;\n    return halt(",
    why: 'a verb step that archives its child, or moves its subtask on, escapes the rule: nothing is observed, so nothing is judged',
    killed_by: [T_U_GONE],
  },
  {
    id: 'G4', file: GRAMMAR, tests: [UNIT],
    from: "      if (line === '## Phase notes') notes = true;\n      continue;\n",
    to: "      if (line === '## Phase notes') { notes = true; continue; }\n",
    why: 'a section quoted in the original request counts as a verb\'s work',
    killed_by: [T_G_REGION],
  },
  {
    id: 'G5', file: GRAMMAR, tests: [UNIT],
    from: "      fence = f[1];\n      continue;",
    to: "      fence = f[1];\n      if (counts()) current.substantive = true;\n      continue;",
    why: 'an empty code block counts as the verb\'s synthesis or artifact',
    killed_by: [T_G_EMPTY_FENCE],
  },
  {
    id: 'C5', file: DIGEST, tests: [UNIT],
    from: '    const own = withHead ? [] : links.filter((x) => x.checkedOut).map((x) => x.rel);',
    to: '    const own = [];',
    why: "a commit inside a checked-out submodule moves the content projection through its gitlink",
    killed_by: [T_U_SUBMODULE],
  },
  {
    id: 'G1', file: GRAMMAR, tests: [UNIT],
    from: "const NOT_THE_WORK = [/^Ensemble launched\\b/, /^Active next-action proposal\\b/];",
    to: 'const NOT_THE_WORK = [];',
    why: 'a launch line or a next-action proposal alone counts as the verb\'s synthesis or artifact',
    killed_by: [T_G_ORDER, T_U_OTHER],
  },
  {
    id: 'G2', file: GRAMMAR, tests: [UNIT],
    from: '    const f = FENCE_RE.exec(line);\n    // CommonMark',
    to: '    const f = null;\n    // CommonMark',
    why: 'a Phase heading quoted in a fenced block counts as a section',
    killed_by: [T_G_FENCE],
  },
  {
    id: 'G3', file: GRAMMAR, tests: [UNIT, RUNS],
    from: "  return close === -1 ? null : t.slice(close + 5).replace(/^\\n+/, '');",
    to: '  return close === -1 ? null : t.slice(close + 5);',
    why: 'the blank lines the engineer\'s writes add before a body read as a change of the notes: every later verb that did its work halts',
    killed_by: [T_G_FILE, T_SERIAL_LATER, T_LANE_LATER],
  },
  {
    id: 'W1', file: WORKER, tests: [RUNS],
    from: "    if (action === 'handoff-only') return;",
    to: '    return;',
    why: 'the scripted verbs write no section: each scenario that should pass rests on it, so each halts',
    killed_by: [T_SERIAL_LATER, T_SERIAL_NO_CHANGE, T_LANE_LATER],
  },
  {
    id: 'S8', file: POLICY, tests: [UNIT],
    from: "  if (!same && s.kind !== 'dispatch') {",
    to: '  if (false) {',
    why: 'a later verb step whose child is not the one the look before it read (another workflow id, none, or an error child) starts from no notes: its old sections count as fresh',
    killed_by: [T_U_BOUND],
  },
  {
    id: 'G6', file: GRAMMAR, tests: [UNIT],
    from: "    if (!notes) {\n      if (line === '## Phase notes') notes = true;",
    to: "    if (!notes && !fence && !FENCE_RE.test(line)) {\n      if (line === '## Phase notes') notes = true;",
    why: 'a fence in the request is tracked: one left unclosed hides the notes heading, and a legitimate verb halts',
    killed_by: [T_G_REQ_FENCE],
  },
  {
    id: 'G7', file: GRAMMAR, tests: [UNIT],
    from: "    if (f && !(f[1][0] === '`' && f[2].includes('`'))) {",
    to: '    if (f) {',
    why: 'a backtick line whose info string holds a backtick ("```a``` inline") opens a fence that swallows every later section',
    killed_by: [T_G_REQ_FENCE, T_G_WRITER],
  },
  {
    id: 'G8', file: GRAMMAR, tests: [UNIT],
    from: '      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && /^[ \\t]*$/.test(m[2])) fence = null;',
    to: '      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) fence = null;',
    why: 'a fence delimiter followed by a no-break space closes the fence, so a synthesized heading quoted after it counts as a section',
    killed_by: [T_G_REQ_FENCE],
  },
  {
    id: 'G9', file: GRAMMAR, tests: [UNIT],
    from: 'const FENCE_RE = /^ {0,3}(`{3,}|~{3,})([\\s\\S]*)$/;',
    to: 'const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;',
    why: 'an info string holding U+2028 opens no fence, so a synthesized heading quoted in the block counts as a section',
    killed_by: [T_G_REQ_FENCE],
  },
];
