// Mutation spec — the verification policy of 2026-11-10 (C178; ADR-0068
// Decision 5, amendment of that date).
//
// Run: npm run mutate -- scripts/mutation-specs/verify-policy.mjs
//
// Gate and fail-closed code only: the suite's evidence a commit needs, the
// policy's gate at each route to the commit, the bound on its resume, the
// mark that keeps a reused pass from being reused in turn, and the driver's
// cap on a batch's mutation cases. Each case removes one refusal and names
// the test that must notice.
//
// The G cases run the gate's own test file, which is small (function calls
// and one temporary directory). The R cases run the verification step's
// file, which starts processes and takes about a minute and a half. One
// The S cases run the lanes file, end to end (several minutes): one case a
// check. One batch runs at most six case ids (AGENTS.md § Build / test / CI),
// so a request names at most six cases of one group, never the whole spec.

const T_GATE = 'tests/orchestrator/test-autopilot-verify-gate.mjs';
const T_RUN = 'tests/orchestrator/test-autopilot-verify-run.mjs';
const T_LANES = 'tests/orchestrator/test-autopilot-verify-lanes.mjs';

const AP = 'plugins/orchestrator/adapters/claude/autopilot';

export const TESTS = [T_GATE, T_RUN, T_LANES];

export const MUTATIONS = [
  // ---- G: the evidence and the policy's gate ---------------------------------
  {
    id: 'G1', file: `${AP}/verify-journal.mjs`, tests: [T_GATE],
    from: '    if (!p || p.tree_start !== tree || p.declaration_digest !== declarationDigest ||',
    to: '    if (!p || p.declaration_digest !== declarationDigest ||',
    why: 'a suite that passed on another tree, ended on this one, counts as evidence for this one',
    killed_by: /a batch that started on another tree is no evidence/,
  },
  {
    id: 'G2', file: `${AP}/verify-journal.mjs`, tests: [T_GATE],
    from: "    if (e.op !== 'end' || e.payload?.end !== 'passed' || e.payload.tree_end !== tree) continue;",
    to: "    if (e.op !== 'end' || e.payload.tree_end !== tree) continue;",
    why: 'a batch that failed, was cut short or gave no evidence counts as the suite\'s pass',
    killed_by: [/a batch that failed is no evidence/, /a batch cut short is no evidence/],
  },
  {
    id: 'G3', file: `${AP}/policy.mjs`, tests: [T_GATE],
    from: '  if (fact?.ok === true) return null;\n  return fact?.why',
    to: '  return null;\n  return fact?.why',
    why: 'the gate is open whatever the evidence: every commit goes as before the amendment',
    killed_by: /without it the lane's last verb is resumed to end with the final verification/,
  },
  {
    id: 'G4', file: `${AP}/policy.mjs`, tests: [T_GATE],
    from: "        if (missing !== null && !recovers(child, fact)) return nope(gateRefusalText(active[0].subtask.id, missing));",
    to: '        if (false) return nope(gateRefusalText(active[0].subtask.id, missing));',
    why: 'the owner\'s forced commit of a serial run crosses the gate with no evidence',
    killed_by: /a serial run refuses it without the evidence/,
  },
  {
    id: 'G5', file: `${AP}/policy.mjs`, tests: [T_GATE],
    from: "      if (missing !== null && !recovers(view.children?.[s.id], fact)) {\n        out.laneHalts.push(halt('owner-choice', `--next does not apply:",
    to: "      if (false) {\n        out.laneHalts.push(halt('owner-choice', `--next does not apply:",
    why: 'a forced lane commit is judged only as the run starts, when no lane\'s tree can be read: it crosses the gate at the decision',
    killed_by: /with lanes it is refused when the pairs are judged, and again at each decision/,
  },
  {
    id: 'G6', file: `${AP}/policy.mjs`, tests: [T_GATE],
    from: '      if (missing !== null && !recovers(child, vf?.suite)) {',
    to: '      if (false) {',
    why: 'an interrupted commit is taken up on a lane edited since the driver admitted it',
    killed_by: /on another content it halts for the owner/,
  },
  {
    id: 'G7', file: `${AP}/policy.mjs`, tests: [T_GATE],
    from: '      if (vf?.suite?.resumed === true) {',
    to: '      if (false) {',
    why: 'a verb that never ends with the final verification is resumed on the same tree without end',
    killed_by: /a second resume on the same tree is no progress/,
  },
  {
    id: 'G8', file: `${AP}/policy.mjs`, tests: [T_GATE],
    from: "    if (missing !== null && !(ns.kind === 'done' && vf?.suite?.dirty === false)) {",
    to: "    if (missing !== null && !(ns.kind === 'done')) {",
    why: 'done over a changed tree, which commits what the tree holds, crosses the gate',
    killed_by: /done over a tree with no change only closes; over a changed tree it is held as the commit is/,
  },
  {
    id: 'G9', file: `${AP}/verify-run.mjs`, tests: [T_GATE],
    from: "    recovery: admittedEv !== null && content !== null && typeof admitted?.payload?.content === 'string' && admitted.payload.content === content,",
    to: "    recovery: admittedEv !== null && content !== null && typeof admitted?.payload?.content === 'string',",
    why: 'any commit the driver once admitted lets an interrupted commit be taken up, whatever the lane holds now',
    killed_by: /the driver records a commit it admits and a verb it resumes/,
  },
  {
    id: 'G10', file: `${AP}/verify-run.mjs`, tests: [T_GATE],
    from: "    recovery: admittedEv !== null && content !== null &&",
    to: "    recovery: content !== null &&",
    why: 'an interrupted commit is taken up on its content alone: with a tree that cannot be read, or under another declaration or base than the commit was admitted with',
    killed_by: /the driver records a commit it admits and a verb it resumes/,
  },
  {
    id: 'G11', file: `${AP}/verify-run.mjs`, tests: [T_GATE],
    from: "  const readable = entries !== null && tree !== null && baseRead;",
    to: "  const readable = entries !== null && tree !== null;",
    why: 'a base that could not be read off the loop is taken as no base, which a batch run with no base then matches',
    killed_by: /another tree, another base, or a tree, a status or a content that cannot be read is no evidence/,
  },
  // ---- S: the admission (a run with lanes) -----------------------------------
  {
    id: 'S1', file: `${AP}/scheduler.mjs`, tests: [T_LANES],
    from: "      if (treeNow !== (byContent ? s.suite.content : s.suite.tree)) {",
    to: "      if (false) {",
    why: 'a lane edited while its commit step was prepared reaches /engineer:commit, which commits a tree the suite never passed on',
    killed_by: /a lane edited since the decision read its tree starts no commit/,
  },
  {
    id: 'S2', file: `${AP}/scheduler.mjs`, tests: [T_LANES],
    from: "      if (typeof treeNow !== 'string') return refuse({ reason: 'owner-choice', detail: `the lane's tree cannot be read as its commit is admitted",
    to: "      if (false) return refuse({ reason: 'owner-choice', detail: `the lane's tree cannot be read as its commit is admitted",
    why: 'a tree that cannot be digested at the admission is decided again without end: no step ends the turn',
    killed_by: /a lane whose tree cannot be digested then starts no commit and is parked for the owner/,
  },
  // ---- R: the step ------------------------------------------------------------
  {
    id: 'R1', file: `${AP}/verify-run.mjs`, tests: [T_RUN],
    from: "    if (sameFooting && before.reused_from) return repeat('passed, on results already reused once');",
    to: '',
    why: 'a pass is replayed again and again: the same request on an unchanged tree never halts',
    killed_by: /a third halts no-progress/,
  },
  {
    id: 'R2', file: `${AP}/verify-run.mjs`, tests: [T_RUN],
    from: '    if (cases > MAX_BATCH_MUTATE_CASES) throw new Error(',
    to: '    if (false) throw new Error(',
    why: 'the driver\'s additions take a batch over the cap on mutation cases, and it runs',
    killed_by: /the driver refuses a batch its additions take over it/,
  },
  {
    id: 'R3', file: `${AP}/verify-run.mjs`, tests: [T_RUN],
    from: "    const sameFooting = typeof declarationDigest === 'string' && before.declaration_digest === declarationDigest && (before.base ?? null) === (base ?? null);",
    to: '    const sameFooting = true;',
    why: 'a pass run with another declaration or selection base is replayed as this request\'s',
    killed_by: /a pass run with another selection base, or another declaration, runs again whole/,
  },
  {
    id: 'R4', file: `${AP}/verify-run.mjs`, tests: [T_RUN],
    from: "      if (!worker.some((c) => c.kind === 'test-suite')) additions.push({ kind: 'test-suite', args: {}, origin: 'driver' });",
    to: '',
    why: 'a final batch whose selection added only test files runs no suite: the commit\'s evidence is never made',
    killed_by: /a final request's batch holds the suite once/,
  },
];
