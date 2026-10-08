// Mutation spec — do the landing-ready tests catch the defects they exist
// for? (ADR-0067 Decision 7, docket C118)
//
// Run: npm run mutate -- scripts/mutation-specs/landing-ready.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. The event adds no gate, so every defect in it
// is silent: a run that never reports a commit still dispatches, still halts
// awaiting-landing at the end and still exits 2, which is what C118 measured
// (a commit waiting 75 minutes unreported). A report that repeats itself, or
// that misses a new commit or a new attempt, a check that calls a conflict
// clean, and a check that writes a ref or pushes all leave the suite green
// unless a test reads the record itself. Each mutation below breaks one rule
// and names the test that must notice.
//
// Groups: D the driver's report points and where the log is, K the overlap
// check, the merge order and the halt, R recovery and deduplication, B what
// the commit is read from, N the read-only promise, H the scratch repository
// the check runs in, which nothing of the repository's but its objects and
// shallow boundary reaches. GIT_CONFIG_NOSYSTEM and GIT_ATTR_NOSYSTEM have no
// mutation: the system config and attributes files are outside a test's
// reach.

const T = 'tests/orchestrator/test-autopilot-landing-ready.mjs';

const AP = 'plugins/orchestrator/adapters/claude/autopilot';
const DRIVER = `${AP}/driver.mjs`;
const LANDING = `${AP}/landing-ready.mjs`;
const POLICY = `${AP}/policy.mjs`;

const T_DISPATCHING = /a commit step emits the event while the run keeps dispatching/;
const T_FAILED = /a commit whose step is judged failed is still reported/;
const T_PAIRS = /reports one clean and one conflicting pair, the merge order, and the awaiting-landing halt lists the same/;
const T_RECOVERY = /recovers an unrecorded commit when a run starts, reports it once across restarts, and a new commit again/;
const T_READ_ONLY = /changes no ref, object, index, worktree or remote/;
const T_KEY = /keys an event by subtask, attempt and commit/;
const T_RETRY = /does not keep an unavailable check: the next look checks again/;
const T_BASE = /reports a conflict with the integration branch once it moves/;
const T_HERMETIC = /checks where no merge driver, config or attributes reach it, and writes nothing to the repository/;
const T_SHALLOW = /answers in a shallow clone, and checks again once its boundary moves/;
const T_ORDER = /orders the merge by the plan's dependencies, then by position/;

const MERGE_CHECK = '    const answer = mergeCheck(scratch, a, b, { timeout: Math.min(GIT_TIMEOUT_MS, left) });';
const AFTER_STEP = "      // A commit stands whatever the verdict on its step.\n      reportLanding(view, seq);\n      if (verdict) return finish('halted', verdict);";
const CAPTURE = "    .map((w) => ({ ...w, commit: resolveCommit(repoRoot, typeof w.branch === 'string' && w.branch ? `refs/heads/${w.branch}` : null, env) }))";
const BASE_CHECK = '        base: { ref: baseRef, commit: baseCommit, ...check(baseCommit, e.commit, e.commit ? baseMissing : noCommit(e)) },';
const REPORT = '        landing = reportLandingReady({ repoRoot, mainRoot, runDir, runId, seq, view: v, out, now, cache: mergeChecks, env });';
const SCRATCH_HOME = '    ...out, HOME: dir, XDG_CONFIG_HOME: dir,';

export const TESTS = [T];

export const MUTATIONS = [
  // ---- D: the driver reports after each step, into the main worktree's log -------
  {
    id: 'D1', file: DRIVER, tests: [T],
    from: AFTER_STEP,
    to: "      if (verdict) return finish('halted', verdict);",
    why: 'a commit is reported only when a run starts: C118 again, a commit waits unreported while the run dispatches',
    killed_by: T_DISPATCHING,
  },
  {
    id: 'D2', file: POLICY, tests: [T],
    from: '        engineerWorkflowId: child.workflow_id ?? null,',
    to: '        engineerWorkflowId: null,',
    why: 'the event does not name the attempt',
    killed_by: T_DISPATCHING,
  },
  {
    id: 'D3', file: DRIVER, tests: [T],
    from: AFTER_STEP,
    to: "      if (verdict) return finish('halted', verdict);\n      reportLanding(view, seq);",
    why: 'a commit whose step the driver judges failed or interrupted goes unreported until the next run',
    killed_by: T_FAILED,
  },
  {
    id: 'D4', file: DRIVER, tests: [T],
    from: REPORT,
    to: REPORT.replace('{ repoRoot, mainRoot,', '{ repoRoot, mainRoot: repoRoot,'),
    why: 'a run in a linked worktree keeps the log there: apart from the macro lock, deduplicated apart from the other worktrees, and not where a watcher tails it',
    killed_by: T_DISPATCHING,
  },
  {
    id: 'D5', file: LANDING, tests: [T],
    from: 'export const LANDING_DIR_REL = `${AUTOPILOT_DIR_REL}/landing`;',
    to: 'export const LANDING_DIR_REL = `${AUTOPILOT_DIR_REL}/landing-ready`;',
    why: 'the log moves away from the path ADR-0067 Decision 7 names, and a watcher tailing it sees nothing',
    killed_by: T_DISPATCHING,
  },

  // ---- K: the overlap check, the merge order and the halt -------------------------
  {
    id: 'K1', file: LANDING, tests: [T],
    from: "    if (r.code === 0) return { result: 'clean' };",
    to: "    return { result: 'clean' };",
    why: 'a conflicting pair is reported clean (merge-tree exits 1 on a conflict)',
    killed_by: T_PAIRS,
  },
  {
    id: 'K2', file: LANDING, tests: [T],
    from: "      .filter((p) => p.result === 'conflict' && position.get(p.subtaskId) < position.get(e.subtaskId))",
    to: "      .filter((p) => p.result === 'conflict')",
    why: 'both sides of a conflict are told to rebase, the first to land included',
    killed_by: T_PAIRS,
  },
  {
    id: 'K3', file: DRIVER, tests: [T],
    from: "      if (d.outcome === 'halt') return finish('halted', withLanding(d, landing));",
    to: "      if (d.outcome === 'halt') return finish('halted', d);",
    why: 'the awaiting-landing halt lists the branches without their commits, overlap and merge order',
    killed_by: T_PAIRS,
  },
  {
    id: 'K4', file: LANDING, tests: [T],
    from: '    const next = list.find((s) => !placed.has(s.id) && ready(s)) ?? list.find((s) => !placed.has(s.id));',
    to: '    const next = list.find((s) => !placed.has(s.id));',
    why: 'the merge order is the plan\'s position alone, ignoring its dependencies',
    killed_by: T_ORDER,
  },
  {
    id: 'K5', file: LANDING, tests: [T],
    from: "    if (answer.result !== 'unavailable') cache.set(key, answer);",
    to: '    cache.set(key, answer);',
    why: 'a check that timed out or could not run stays unavailable for the rest of the run',
    killed_by: T_RETRY,
  },
  {
    id: 'K6', file: LANDING, tests: [T],
    from: BASE_CHECK,
    to: BASE_CHECK.replace('check(baseCommit, e.commit,', 'check(e.commit, e.commit,'),
    why: 'a branch that conflicts with where the integration branch has moved is reported clean',
    killed_by: T_BASE,
  },

  // ---- R: recovery and deduplication ----------------------------------------------
  {
    id: 'R1', file: DRIVER, tests: [T],
    from: '    reportLanding(view, 0);',
    to: '    void reportLanding;',
    why: 'a commit no run recorded (committed by hand, or by a run that died first) is never reported',
    killed_by: T_RECOVERY,
  },
  {
    id: 'R2', file: LANDING, tests: [T],
    from: '      if (reported.has(key)) continue;',
    to: '      if (false) continue;',
    why: 'every look reports every waiting commit again, across restarts and within a run',
    killed_by: T_RECOVERY,
  },
  {
    id: 'R3', file: LANDING, tests: [T],
    from: 'export const eventKey = (r) => JSON.stringify([r?.subtask_id ?? null, r?.engineer_workflow_id ?? null, r?.commit ?? null]);',
    to: 'export const eventKey = (r) => JSON.stringify([r?.subtask_id ?? null, r?.engineer_workflow_id ?? null]);',
    why: 'a new commit on a reported branch (the owner\'s fix) is taken for the one already reported',
    killed_by: T_RECOVERY,
  },
  {
    id: 'R4', file: LANDING, tests: [T],
    from: 'export const eventKey = (r) => JSON.stringify([r?.subtask_id ?? null, r?.engineer_workflow_id ?? null, r?.commit ?? null]);',
    to: 'export const eventKey = (r) => JSON.stringify([r?.subtask_id ?? null, r?.commit ?? null]);',
    why: 'a new attempt of the subtask on the same commit is taken for the one already reported',
    killed_by: T_KEY,
  },
  {
    id: 'R5', file: LANDING, tests: [T],
    from: "      if (last[0] !== 0x0a) lead = '\\n';",
    to: '      void last[0];',
    why: 'a torn last line joins the next record, which then reads as unparsable and is reported again forever',
    killed_by: T_RECOVERY,
  },
  {
    id: 'R6', file: LANDING, tests: [T],
    from: '    report.publishError = e?.message ?? String(e);',
    to: '    throw e;',
    why: 'a log that cannot be written drops the report, and the halt lists the branches without their facts',
    killed_by: T_RECOVERY,
  },

  // ---- B: what the commit is read from --------------------------------------------
  {
    id: 'B1', file: LANDING, tests: [T],
    from: CAPTURE,
    to: CAPTURE.replace("typeof w.branch === 'string' && w.branch", '/^[A-Za-z0-9._\\/-]+$/.test(w.branch)'),
    why: 'a branch name outside the print-safe alphabet, which git accepts, loses its commit',
    killed_by: T_KEY,
  },
  {
    id: 'B2', file: LANDING, tests: [T],
    from: '      if (!entry.commit) continue;',
    to: '      void entry;',
    why: 'a branch git cannot resolve is reported as a commit, keyed by null',
    killed_by: T_KEY,
  },

  // ---- N: read-only ---------------------------------------------------------------
  {
    id: 'N1', file: LANDING, tests: [T],
    from: MERGE_CHECK,
    to: `    git(repoRoot, ['update-ref', 'refs/landing-check/' + a.slice(0, 12), a], { env });\n${MERGE_CHECK}`,
    why: 'the check writes a ref',
    killed_by: T_READ_ONLY,
  },
  {
    id: 'N2', file: LANDING, tests: [T],
    from: MERGE_CHECK,
    to: `    git(repoRoot, ['push', '-q', 'origin', b + ':refs/heads/landing-check-' + b.slice(0, 12)], { env });\n${MERGE_CHECK}`,
    why: 'the check pushes (here to the fixture\'s local bare origin)',
    killed_by: T_READ_ONLY,
  },
  {
    id: 'N3', file: LANDING, tests: [T],
    from: MERGE_CHECK,
    to: `    git(repoRoot, ['read-tree', b], { env });\n${MERGE_CHECK}`,
    why: 'the check merges through the index of the repository',
    killed_by: T_READ_ONLY,
  },

  // ---- H: the scratch repository the check runs in --------------------------------
  {
    id: 'H1', file: LANDING, tests: [T],
    from: "    scratch ??= scratchRepo(layout, { env, objectFormat: a.length === 64 ? 'sha256' : 'sha1' });",
    to: "    scratch ??= { dir: repoRoot, gitDir: path.join(repoRoot, '.git'), env };",
    why: 'the check runs in the repository: its merge drivers run (one writes a ref), its attributes decide the answer, and merge-tree writes objects into it',
    killed_by: T_HERMETIC,
  },
  {
    id: 'H2', file: LANDING, tests: [T],
    from: "  for (const [k, v] of Object.entries(base ?? process.env)) if (!k.startsWith('GIT_')) out[k] = v;",
    to: '  for (const [k, v] of Object.entries(base ?? process.env)) out[k] = v;',
    why: 'config passed in the environment (GIT_CONFIG_COUNT) reaches the check, and the driver it defines runs',
    killed_by: T_HERMETIC,
  },
  {
    id: 'H3', file: LANDING, tests: [T],
    from: SCRATCH_HOME,
    to: '    ...out, XDG_CONFIG_HOME: dir,',
    why: 'the user\'s global config reaches the check, and the attributes file it names calls a conflict clean',
    killed_by: T_HERMETIC,
  },
  {
    id: 'H4', file: LANDING, tests: [T],
    from: SCRATCH_HOME,
    to: '    ...out, HOME: dir,',
    why: 'the user\'s XDG attributes reach the check and call a conflict clean',
    killed_by: T_HERMETIC,
  },
  {
    id: 'H5', file: LANDING, tests: [T],
    from: "    if (layout.shallow) fs.writeFileSync(path.join(gitDir, 'shallow'), layout.shallow);",
    to: '    void layout.shallow;',
    why: 'in a shallow clone the scratch cannot read the merge base\'s parents, and every check is unavailable',
    killed_by: T_SHALLOW,
  },
  {
    id: 'H6', file: LANDING, tests: [T],
    from: '    scratch?.dispose?.();',
    to: '    void scratch;',
    why: 'every look that checks leaves a scratch repository in the temp directory',
    killed_by: T_HERMETIC,
  },
  {
    id: 'H7', file: LANDING, tests: [T],
    from: "    const key = `${boundary}:${[a, b].sort().join('..')}`;",
    to: "    const key = [a, b].sort().join('..');",
    why: 'a deepening fetch moves the shallow boundary, and the cache keeps the answer the old boundary gave',
    killed_by: T_SHALLOW,
  },
];
