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
// The same holds for freshness (docket C128): a branch behind another lane's
// landing reported ready, or a fetch that failed taken for one that worked,
// still leaves every count of records right.
//
// Groups: D the driver's report points and where the log is, K the overlap
// check, the merge order and the halt, R recovery and deduplication, B what
// the commit is read from, N the read-only promise, H the scratch repository
// the check runs in, which nothing of the repository's but its objects and
// shallow boundary reaches, F freshness and its transitions, P a failure to
// record printed once, L the ledger's appends, S the surfaces that carry the
// report (halt, lanes, status), X the test fixture's git isolation (C123 F3).
// GIT_CONFIG_NOSYSTEM and GIT_ATTR_NOSYSTEM have no mutation: the system
// config and attributes files are outside a test's reach.

const T = 'tests/orchestrator/test-autopilot-landing-ready.mjs';
const T_LEDGER = 'tests/orchestrator/test-autopilot-ledger.mjs';
// The scheduler tests, split across files so node --test runs them in parallel.
const T_SCHED = [
  'tests/orchestrator/test-autopilot-scheduler.mjs',
  'tests/orchestrator/test-autopilot-scheduler-serial.mjs',
  'tests/orchestrator/test-autopilot-scheduler-landing-looks.mjs',
  'tests/orchestrator/test-autopilot-scheduler-landing-ends.mjs',
  'tests/orchestrator/test-autopilot-scheduler-landing-halts.mjs',
];
const T_DRAIN_FILE = 'tests/orchestrator/test-autopilot-drain-waiting.mjs';
const T_OBS = 'tests/orchestrator/test-autopilot-observe.mjs';

const AP = 'plugins/orchestrator/adapters/claude/autopilot';
const DRIVER = `${AP}/driver.mjs`;
const LANDING = `${AP}/landing-ready.mjs`;
const LEDGER = `${AP}/ledger.mjs`;
const OBSERVE = `${AP}/observe.mjs`;
const OFFLOOP = `${AP}/offloop.mjs`;
const POLICY = `${AP}/policy.mjs`;
const SCHEDULER = `${AP}/scheduler.mjs`;
const CLI = `${AP}/cli.mjs`;
const FIXTURE = 'tests/orchestrator/fixtures/autopilot-repo.mjs';

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
const T_A_THEN_B = /A lands, then B: B, reported ready before, is reported again as needing a sync/;
const T_FRESH = /is ready only when the branch contains the fetched integration tip/;
const T_UNKNOWN = /never calls a branch ready when its freshness is unknown/;
const T_TRANSITIONS = /reports again on each change of commit, integration tip or state/;
const T_ONCE = /prints a failure to record once until a report is recorded in full/;
const T_FIXTURE = /the fixture takes no git config and no GIT_\* variable of the caller's/;
const T_LEDGER_TORN = /appends a landing record after a torn last line without joining them/;
const T_LEDGER_SHORT = /continues a short write from the byte it stopped at, and refuses a write that makes no progress/;
const T_TWO_LANES = /progress independently, each in its own worktree, and halt awaiting-landing together/;
const T_DRAIN = /a commit made while the run drains is reported ready by a last look that fetches/;
const T_DRAIN_FAILS = /a drain whose last look fails leaves no freshness standing/;
const T_DRAIN_MACRO = /a drain whose last look cannot read the macro keeps each waiting lane, unknown/;
const T_DRAIN_UNIT = /a drain's last look keeps what it could not read, unknown/;
const T_REFUSED_THEN_FAILS = /a lane reported ready keeps its place, unknown, through a look whose landing check refuses and a last look that fails/;
const T_JOINS_BEFORE_HALT = /a lane a look reports waiting joins the run's list before that look halts the run/;
const T_DRAIN_COMMIT_FAILS = /a commit made while the run drains is still listed, unknown, when the drain's last look fails/;
const T_LANES_ONCE = /a log that cannot be read or written is reported once across the run's looks/;
const T_REFSPEC = /fetches the integration branch into its remote-tracking ref under a mapping that does not cover it/;
const T_INTERRUPT_DRAIN = /an interrupt during the drain's last look ends the run interrupted, and confirms nothing/;
const T_SETTLE_INTERRUPT = /an interrupt while a step settles: the lane it committed is listed unknown, and a lane that landed meanwhile is not listed/;
const T_ERROR_END = /a run that stops on an error confirms nothing it lists/;
const T_END_LOOK = /the look a run's end takes for its proposals feeds its list/;
const T_SERIAL_WAITING = /a serial run's halt for another reason lists the branch that waits to land/;
const T_WITHHELD_UNIT = /a look that did not fetch adds nothing to a freshness at the same commit/;
const T_FACTS_UNIT = /each waiting subtask takes the commit, freshness and overlap the report found/;
const T_UNREPORTED_UNIT = /an awaiting-landing halt whose report failed lists each branch unknown/;
const T_INTERRUPT_CUTOFF = /an interrupt that cuts off a look of the loop still lists what that look found waiting, unknown/;
const T_ERROR_CUTOFF = /an error that cuts off a look of the loop before its report still lists what that look found waiting, unknown/;
const T_HALT_AFTER_ERROR = /an error after the halt was recorded leaves no readiness standing in it/;
const T_NO_REPORT_RESTORE = /the end's own look, which has no report, never restores a readiness a later look took away/;
const T_RETRY_REPLACED = /a look a later look replaces still lists what it found waiting/;
const T_BANNER_ERROR = /an error before the run's first look of its own still lists what the first report found, unknown/;
const T_SERIAL_LOCKED = /a serial run that halts before its first report \(the macro lock is held\) still lists the branch/;
const T_NO_REPORT_UNIT = /a look with no report of its own keeps each entry as listed, lists a new one unknown/;
const T_LANDED_UNIT = /a look that did not fetch keeps no ready past a landing it saw, and a needs-sync stands/;
const T_SERIAL_RETRY = /a serial look a retry replaces still lists what it found waiting/;
const T_SERIAL_INTERRUPT = /a serial run the owner interrupts before its next step confirms nothing its halt lists/;
const T_END_LOOK_FAILS = /a failed look feeds the run's list too: when the end's own look fails/;
const T_IDLE_LANDED = /an awaiting-landing halt lists what the run's list holds as it ends: a lane that landed during the end's own look is not listed/;
const T_IDLE_INTERRUPT = /an awaiting-landing halt the owner interrupts as the run ends confirms nothing it lists/;
const T_HANDOFF = /the scheduler takes the driver's list: a lane only the look before the locks could read stays listed, unknown/;
const T_SERIAL_ERROR = /a serial run that stops on an error before any halt records what waited, unknown, and status shows it/;
const T_HALT_UNIT = /an awaiting-landing halt lists the run's list as its end left it, not the list of the look that decided it/;

const MERGE_CHECK = '    const answer = mergeCheck(scratch, a, b, { timeout: r.timeout });';
const AFTER_STEP = "      // A commit stands whatever the verdict on its step.\n      reportLanding(view, seq);\n      if (verdict) return await finish('halted', { ...verdict, seq });";
const CAPTURE = "    .map((w) => ({ ...w, commit: resolveCommit(repoRoot, typeof w.branch === 'string' && w.branch ? `refs/heads/${w.branch}` : null, env) }))";
const BASE_CHECK = '        base: { ref: baseRef, commit: baseCommit, ...check(baseCommit, e.commit, e.commit ? baseMissing : noCommit(e)) },';
const REPORT = '        landing = reportLandingReady({ repoRoot, mainRoot, runDir, runId, seq, view: v, out, now, cache: mergeChecks, env, notice });';
const SCRATCH_HOME = '    ...out, HOME: dir, XDG_CONFIG_HOME: dir,';
const SUBJECT = 'export const subjectKey = (r) => JSON.stringify([r?.subtask_id ?? null, r?.engineer_workflow_id ?? null]);';
const OBSERVATION = 'export const observationKey = (r) => JSON.stringify([r?.commit ?? null, r?.integration_branch ?? null, r?.sync?.base_commit ?? null, r?.sync?.state ?? null]);';
const DEDUP = '      if (latest.get(subject) === observationKey(record)) continue;';
const PUBLISHED = '      report.reported.push(entry.subtaskId);\n      notice.warned = false;';
const DRAIN_LOOK = '        if (reported) await c.reportLanding(v, seq, runAt(repoRoot));';
const DRAIN_GUARD = '        const reported = !c.interrupted() && !v.lookError && !v.macroLookupError;';
const DRAIN_RECONCILE = '        feed(v, reported);';
const LOOP_RECONCILE = '      feed(view, true);';
const SETTLE_RECONCILE = '    feed(after, reported);';
const SERIAL_HALT = '      d = withLanding(d, landing, waiting);';
const LOOK_FEED = '    feed(v, false);\n    return v;';
const END_BUILD = "    d = await proposalsAtEnd(() => look(repoRoot, false), d, [...report.values()]);\n    if (c.interrupted()) waiting = endedUnlooked(waiting, 'the owner interrupted the run');\n    if (d?.reason === 'awaiting-landing' && c.withLanding) d = c.withLanding(d, waiting);";

export const TESTS = [T];

export const MUTATIONS = [
  // ---- D: the driver reports after each step, into the main worktree's log -------
  {
    id: 'D1', file: DRIVER, tests: [T],
    from: AFTER_STEP,
    to: "      if (verdict) return await finish('halted', { ...verdict, seq });",
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
    to: "      if (verdict) return await finish('halted', { ...verdict, seq });\n      reportLanding(view, seq);",
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
    from: SERIAL_HALT,
    to: '      void withLanding;',
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
    from: DEDUP,
    to: '      if (false) continue;',
    why: 'every look reports every waiting commit again, across restarts and within a run',
    killed_by: T_RECOVERY,
  },
  {
    id: 'R3', file: LANDING, tests: [T],
    from: OBSERVATION,
    to: OBSERVATION.replace('r?.commit ?? null, ', ''),
    why: 'a new commit on a reported branch (the owner\'s fix) is taken for the one already reported',
    killed_by: T_RECOVERY,
  },
  {
    id: 'R4', file: LANDING, tests: [T],
    from: SUBJECT,
    to: SUBJECT.replace(', r?.engineer_workflow_id ?? null', ''),
    why: 'a new attempt of the subtask on the same commit is taken for the one already reported',
    killed_by: T_KEY,
  },
  {
    // The append moved to ledger.mjs (C123), which the run's ledger shares.
    id: 'R5', file: LEDGER, tests: [T, T_LEDGER],
    from: "      if (last[0] !== 0x0a) lead = '\\n';",
    to: '      void last[0];',
    why: 'a torn last line joins the next record, which then reads as unparsable and is reported again forever',
    killed_by: [T_RECOVERY, T_LEDGER_TORN],
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
    from: '      if (!entry.commit || entry.withheld) continue;',
    to: '      if (entry.withheld) continue;',
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
    from: "    scratch ??= scratchRepo(layout, { env, objectFormat: oid.length === 64 ? 'sha256' : 'sha1' });",
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
    from: "    const key = `merge:${boundaryOf()}:${[a, b].sort().join('..')}`;",
    to: "    const key = `merge:${[a, b].sort().join('..')}`;",
    why: 'a deepening fetch moves the shallow boundary, and the cache keeps the answer the old boundary gave',
    killed_by: T_SHALLOW,
  },

  // ---- F: freshness (C128) and its transitions ------------------------------------
  {
    id: 'F1', file: LANDING, tests: [T],
    from: "    if (fetched.attempted && fetched.ok) return { state: 'ready', base_commit: baseCommit, detail: null };",
    to: "    return { state: 'ready', base_commit: baseCommit, detail: null };",
    why: 'a look whose fetch failed, or that did not fetch, calls a branch ready against a stale tip',
    killed_by: [T_UNKNOWN, T_TRANSITIONS],
  },
  {
    id: 'F2', file: LANDING, tests: [T],
    from: '    if (answer.contains === false) {',
    to: '    if (false) {',
    why: 'the ancestry answer is ignored: a branch behind another lane\'s landing is ready, C128 itself',
    killed_by: [T_FRESH, T_A_THEN_B],
  },
  {
    id: 'F3', file: LANDING, tests: [T],
    from: "'merge-base', '--is-ancestor', ancestor, commit]",
    to: "'merge-base', '--is-ancestor', commit, ancestor]",
    why: 'the question is asked backwards: whether the tip contains the branch',
    killed_by: T_FRESH,
  },
  {
    id: 'F4', file: LANDING, tests: [T],
    from: '      if (layout.shallow) return unknown(',
    to: '      if (false) return unknown(',
    why: 'in a shallow clone a no from is-ancestor, which the boundary may cause, is taken for a branch behind',
    killed_by: T_UNKNOWN,
  },
  {
    id: 'F5', file: LANDING, tests: [T],
    from: OBSERVATION,
    to: OBSERVATION.replace('r?.sync?.base_commit ?? null, ', ''),
    why: 'the integration branch moving again leaves a branch that still needs a sync reported against the old tip',
    killed_by: T_TRANSITIONS,
  },
  {
    id: 'F6', file: LANDING, tests: [T],
    from: OBSERVATION,
    to: OBSERVATION.replace(', r?.sync?.state ?? null', ''),
    why: 'a fetch that failed, or recovered, on the same commits is never reported',
    killed_by: T_TRANSITIONS,
  },
  {
    id: 'F7', file: LANDING, tests: [T],
    from: DEDUP,
    to: '      if (readLandingLog(log).some((x) => subjectKey(x) === subject && observationKey(x) === observationKey(record))) continue;',
    why: 'any observation ever logged is suppressed: ready → unknown → ready, and unknown → ready → unknown, report once each',
    killed_by: T_TRANSITIONS,
  },
  {
    id: 'F8', file: LANDING, tests: [T],
    from: '      if (!entry.commit || entry.withheld) continue;',
    to: '      if (!entry.commit) continue;',
    why: 'a look that did not fetch publishes an unknown the next fetching look turns ready: two records for one commit',
    killed_by: T_TRANSITIONS,
  },
  {
    id: 'F9', file: SCHEDULER, tests: T_SCHED,
    from: DRAIN_LOOK,
    to: '',
    why: 'a commit a lane made while the run drained is held back by its look, which did not fetch, and never reported',
    killed_by: T_DRAIN,
  },
  {
    id: 'F10', file: OBSERVE, tests: [T_OBS],
    from: "      const f = run('git', ['-C', repoRoot, 'fetch', '--quiet', '--no-tags', '--refmap=', 'origin',\n        `+refs/heads/${integration}:refs/remotes/origin/${integration}`], { ...o, timeout: NETWORK_TIMEOUT_MS });",
    to: "      const f = run('git', ['-C', repoRoot, 'fetch', '--quiet', 'origin', integration], { ...o, timeout: NETWORK_TIMEOUT_MS });",
    why: 'under a mapping that does not cover the branch the fetch succeeds and the remote-tracking ref stays stale, so a stale tip reads as fetched',
    killed_by: T_REFSPEC,
  },

  {
    id: 'F11', file: LANDING, tests: [T],
    from: OBSERVATION,
    to: OBSERVATION.replace('r?.integration_branch ?? null, ', ''),
    why: 'the macro\'s baseline renamed at the same commit is never reported, and the log keeps the old name and its commands',
    killed_by: T_TRANSITIONS,
  },
  {
    id: 'F12', file: LANDING, tests: [T],
    from: "  if (state === 'ready') return { commands: [`git push origin ${branch}`], note: null };",
    to: "  if (state === 'ready') return { commands: [], note: null };",
    why: 'a branch synced here and not pushed reads ready with nothing to run, while its pull request\'s head and CI stay behind',
    killed_by: T_FRESH,
  },
  {
    id: 'F13', file: LANDING, tests: [T],
    from: '      `${g} fetch origin +refs/heads/${integration}:refs/remotes/origin/${integration}`,',
    to: '      `${g} fetch origin ${integration}`,',
    why: 'the printed fetch leaves origin/<baseline> stale under a narrower mapping, and the merge takes the old tip',
    killed_by: [T_FRESH, T_A_THEN_B],
  },
  {
    id: 'F14', file: SCHEDULER, tests: T_SCHED,
    from: DRAIN_RECONCILE,
    to: '        if (v.lookError || v.macroLookupError) void 0; else feed(v, reported);',
    why: 'a drain whose last look failed keeps a lane ready from an older look, after the integration branch may have moved, and one that cannot read the macro drops every waiting lane',
    killed_by: [T_DRAIN_FAILS, T_DRAIN_MACRO],
  },
  {
    id: 'F15', file: SCHEDULER, tests: T_SCHED,
    // Both re-checks go: either alone ends the run interrupted (the one after
    // the look also keeps an interrupted look from publishing).
    from: `${DRAIN_GUARD}\n${DRAIN_LOOK}\n${DRAIN_RECONCILE}\n        if (c.interrupted()) continue;`,
    to: `${DRAIN_GUARD.replace('!c.interrupted() && ', '')}\n${DRAIN_LOOK}\n${DRAIN_RECONCILE}`,
    why: 'an interrupt during the drain\'s last look, or its report, is recorded as the drain\'s own reason',
    killed_by: /an interrupt during the drain's last look ends the run interrupted/,
  },
  // F16 (the drain's last look listing the run's earlier list instead of what
  // it found) is retired: a step's settling look now lists a lane that commits
  // during the drain, so the two lists differ only when a lane stops waiting
  // during the drain, which the driven fixture cannot time.
  {
    id: 'F29', file: SCHEDULER, tests: T_SCHED,
    from: LOOP_RECONCILE,
    to: '      waiting = landingFactsOf(view.lookError || view.macroLookupError ? [] : waitingToLand(view), c.landing());',
    why: 'a look of the run\'s loop whose landing check refuses drops a lane known to wait, and a drain whose last look fails then lists nothing for it',
    killed_by: T_REFUSED_THEN_FAILS,
  },
  {
    id: 'F31', file: SCHEDULER, tests: T_SCHED,
    from: LOOP_RECONCILE,
    to: '',
    // The look already listed what it found as it returned (unreported), so
    // what this feed adds is its report's facts.
    why: 'the loop\'s report never gives a lane its facts: a lane reported ready ends the run unknown in the lane report',
    killed_by: T_TWO_LANES,
  },
  // F30 and F44 (the scheduler's own feed of the first report, and its
  // place before the banner) are retired: the scheduler no longer seeds a list
  // of its own; it takes the driver's (F47).
  // No case drops the drain's `!v.macroLookupError` guard: reconcileWaiting
  // already keeps the lanes a look without its macro cannot list, so the guard
  // only spares a report of nothing (an equivalent mutation).
  {
    id: 'F18', file: SCHEDULER, tests: [T_DRAIN_FILE],
    from: '    const why = whole ?? waitingUnread(view, w.subtaskId);',
    to: '    const why = whole;',
    why: 'a lane whose engineer workflow or landing check the drain\'s last look could not read drops out of the lane report',
    killed_by: T_DRAIN_UNIT,
  },
  {
    id: 'F19', file: SCHEDULER, tests: [T_DRAIN_FILE],
    from: "  if (s?.status !== 'in_progress') return null;",
    to: "  if (!s) return null;",
    why: 'a subtask the drain\'s last look reads as done stays listed waiting, unknown',
    killed_by: T_DRAIN_UNIT,
  },
  {
    id: 'F20', file: SCHEDULER, tests: [T_DRAIN_FILE],
    from: "  if (child?.location === 'active') return null;",
    to: '',
    why: 'a subtask reopened by a new attempt stays listed waiting, unknown',
    killed_by: T_DRAIN_UNIT,
  },
  {
    id: 'F21', file: SCHEDULER, tests: [T_DRAIN_FILE],
    from: "    return w.sync ? w : failed(w, 'its landing report did not complete');",
    to: '    return w;',
    why: 'a lane the last look found waiting, whose report did not complete, is listed with no freshness instead of unknown, in the lane report and in an awaiting-landing halt',
    killed_by: [T_DRAIN_UNIT, T_UNREPORTED_UNIT],
  },
  {
    id: 'F24', file: SCHEDULER, tests: [T_DRAIN_FILE],
    from: "  if (child.current_phase === 'close-complete') return null;",
    to: '',
    why: 'a subtask closed with no commit, which has no landing check, stays listed waiting, unknown',
    killed_by: T_DRAIN_UNIT,
  },
  {
    id: 'F25', file: SCHEDULER, tests: [T_DRAIN_FILE],
    from: '  if (landing?.ok === true) return null;',
    to: '',
    why: 'a subtask whose pull request merged stays listed waiting, unknown',
    killed_by: T_DRAIN_UNIT,
  },
  {
    id: 'F26', file: SCHEDULER, tests: [T_DRAIN_FILE],
    from: "  return `subtask ${id}'s landing check answered ${landing.reason ?? 'no reason'}${landing.detail ? ` (${landing.detail})` : ''}`;",
    to: '  return null;',
    why: 'a landing check that refused (gh unavailable) drops a lane reported ready from the run\'s last word on it',
    killed_by: T_DRAIN_UNIT,
  },
  {
    id: 'F27', file: SCHEDULER, tests: [T_DRAIN_FILE],
    from: "const unknownSync = (w, detail) => ({ ...w, sync: { state: 'unknown', base_commit: w.sync?.base_commit ?? null, detail, commands: [], note: null } });",
    to: "const unknownSync = (w, detail) => ({ ...w, sync: { ...w.sync, state: 'unknown', base_commit: w.sync?.base_commit ?? null, detail } });",
    why: 'a lane turned unknown keeps the push or sync commands of the readiness it lost',
    killed_by: T_DRAIN_UNIT,
  },
  {
    id: 'F28', file: SCHEDULER, tests: T_SCHED,
    from: SETTLE_RECONCILE,
    to: '',
    why: 'a lane that committed while the run drains drops out of the lane report when the drain\'s last look fails',
    killed_by: T_DRAIN_COMMIT_FAILS,
  },
  // ---- F32-F39: every end reconciles before its report (the owner's decision
  // of 2026-10-14 on the recurring finding). No case drops lanesSummary's
  // clearing of an earlier `.waiting`: the summary is built once per end, and
  // the catch rebuilds it from the same subtasks, so the clearing only guards
  // a later path (an equivalent mutation today).
  // No F32 (a settling look fed only when its report ran): the look already
  // fed the list as it returned, and a failed one, fed by nothing then, comes
  // only after an interrupt, whose end leaves every lane unknown anyway; it is
  // equivalent.
  {
    id: 'F33', file: SCHEDULER, tests: T_SCHED,
    from: SETTLE_RECONCILE,
    to: '    { const known = new Set(waiting.map((x) => x.subtaskId)); waiting = [...waiting, ...foundWaiting(after, reported, c.landing()).filter((x) => !known.has(x.subtaskId))]; }',
    why: 'a step\'s settling look only adds: the lane its own look listed takes none of its report\'s facts, and a drain whose last look fails lists it without its commit',
    killed_by: T_DRAIN_COMMIT_FAILS,
  },
  {
    id: 'F34', file: SCHEDULER, tests: T_SCHED,
    from: "    if (c.interrupted()) waiting = endedUnlooked(waiting, 'the owner interrupted the run');",
    to: '',
    why: 'an interrupted run reports a lane ready that its last look never confirmed',
    killed_by: [T_INTERRUPT_DRAIN, T_SETTLE_INTERRUPT, T_IDLE_INTERRUPT],
  },
  {
    id: 'F36', file: SCHEDULER, tests: T_SCHED,
    from: '    waiting = endedUnlooked(waiting, `the run stopped on an error: ${e?.message ?? e}`);',
    to: '',
    why: 'a run that stops on an error keeps a lane ready in run.json that no look confirmed',
    killed_by: T_ERROR_END,
  },
  {
    id: 'F37', file: SCHEDULER, tests: [T_DRAIN_FILE],
    from: '    if (withheld && p?.sync && w.commit && p.commit === w.commit) return keep({ ...w, sync: p.sync });',
    to: '',
    why: 'a look that did not fetch turns a lane ready at the same commit unknown, though it adds nothing to what was known',
    killed_by: T_WITHHELD_UNIT,
  },
  {
    id: 'F38', file: SCHEDULER, tests: [T_DRAIN_FILE],
    from: '    if (withheld && p?.sync && w.commit && p.commit === w.commit) return keep({ ...w, sync: p.sync });',
    to: '    if (withheld && p?.sync) return keep({ ...w, sync: p.sync });',
    why: 'a new commit an unfetched look held back takes the readiness of the old one',
    killed_by: T_WITHHELD_UNIT,
  },
  {
    id: 'F39', file: SCHEDULER, tests: [T_DRAIN_FILE],
    from: '...(e?.overlap ? { overlap: e.overlap } : {}), ...(e?.withheld ? { withheld: true } : {}) };',
    to: '...(e?.overlap ? { overlap: e.overlap } : {}) };',
    why: 'the run\'s list never learns that a report held an entry back, and an unfetched look turns a ready lane unknown',
    killed_by: T_FACTS_UNIT,
  },
  {
    id: 'F41', file: SCHEDULER, tests: [T_DRAIN_FILE],
    from: "    if (unreported) return p ? keep(p) : unknownSync(w, 'no report was made for the look that found it');",
    to: '',
    why: 'a look with no report of its own turns an entry it adds nothing to unknown, under another reason',
    killed_by: T_NO_REPORT_UNIT,
  },
  {
    id: 'F42', file: SCHEDULER, tests: T_SCHED,
    from: '  return reported ? landingFactsOf(found, report) : found.map((w) => ({ ...w, unreported: true }));',
    to: '  return landingFactsOf(found, report);',
    why: 'the end\'s look takes an older look\'s report as its own, and restores a readiness the drain\'s failed look took away',
    killed_by: T_NO_REPORT_RESTORE,
  },
  {
    id: 'F43', file: SCHEDULER, tests: T_SCHED,
    from: LOOK_FEED,
    to: '    return v;',
    why: 'a look an interrupt, an error or a retry cuts off never reaches the run\'s list, nor does the end\'s own look',
    killed_by: [T_INTERRUPT_CUTOFF, T_ERROR_CUTOFF, T_END_LOOK, T_RETRY_REPLACED],
  },
  // ---- F45-F47, S13, S14, S16, S17: the rule at its chokepoints (the owner's decision of
  // 2026-10-14 on the third recurrence): every look feeds the list as it
  // returns, a failed one too, and only an end builds a halt's list.
  {
    id: 'F45', file: SCHEDULER, tests: T_SCHED,
    from: LOOK_FEED,
    to: '    if (!v.lookError && !v.macroLookupError) feed(v, false);\n    return v;',
    why: 'a failed look feeds nothing: when the end\'s own look fails, a lane reported ready by an older look ends the run ready',
    killed_by: T_END_LOOK_FAILS,
  },
  {
    id: 'F46', file: SCHEDULER, tests: T_SCHED,
    from: END_BUILD,
    to: "    if (d?.reason === 'awaiting-landing' && c.withLanding) d = c.withLanding(d, waiting);\n    d = await proposalsAtEnd(() => look(repoRoot, false), d, [...report.values()]);\n    if (c.interrupted()) waiting = endedUnlooked(waiting, 'the owner interrupted the run');",
    why: 'an awaiting-landing halt is built before its end reconciles: it lists a lane that landed during the end\'s own look, and one the owner interrupted the run on, ready',
    killed_by: [T_IDLE_LANDED, T_IDLE_INTERRUPT],
  },
  {
    id: 'F47', file: SCHEDULER, tests: T_SCHED,
    from: '  let waiting = c.waiting?.() ?? [];',
    to: '  let waiting = [];',
    why: 'the scheduler starts a list of its own: what the driver\'s looks before it found waiting (before the locks, under them, the first report) is dropped, by an error at the banner, a look whose landing check refuses, or a lane later looks cannot read',
    killed_by: [T_HANDOFF, T_BANNER_ERROR, T_REFUSED_THEN_FAILS],
  },
  // ---- F48-F55: a look that did not fetch keeps no ready past a landing it
  // saw (the A-lands-then-B sequence, critique of 2026-10-14 12:51, MAJOR 1;
  // F53-F55 from its refine-verify).
  {
    id: 'F48', file: SCHEDULER, tests: [T_DRAIN_FILE, ...T_SCHED],
    from: '  const landed = landingsSeen(view, departed);',
    to: '  const landed = [];',
    why: 'a look that did not fetch sees A land and keeps B ready against the tip before it: the end\'s halt lists B ready',
    killed_by: [T_LANDED_UNIT, T_IDLE_LANDED],
  },
  {
    id: 'F49', file: SCHEDULER, tests: [T_DRAIN_FILE],
    from: "  const keep = (w) => (landed.length && w.sync?.state === 'ready'",
    to: '  const keep = (w) => (landed.length',
    why: 'a landing turns a needs-sync unknown too, and drops the merge commands that still apply',
    killed_by: T_LANDED_UNIT,
  },
  {
    id: 'F50', file: SCHEDULER, tests: [T_DRAIN_FILE],
    from: '    if (withheld && p?.sync && w.commit && p.commit === w.commit) return keep({ ...w, sync: p.sync });',
    to: '    if (withheld && p?.sync && w.commit && p.commit === w.commit) return { ...w, sync: p.sync };',
    why: 'a report that did not fetch withholds B and keeps its ready, past the landing the same look saw',
    killed_by: T_LANDED_UNIT,
  },
  {
    id: 'F51', file: SCHEDULER, tests: [T_DRAIN_FILE],
    from: "    || (departed.has(s.id) && s.status === 'completed' && typeof s.commit === 'string' && s.commit !== '')",
    to: '',
    why: 'a waiting lane that leaves recorded completed with its commit is not read as landed, and is not named',
    killed_by: T_LANDED_UNIT,
  },
  {
    id: 'F52', file: SCHEDULER, tests: [T_DRAIN_FILE],
    from: "  return (view.macro?.fm?.plan?.subtasks ?? []).filter((s) => s?.id != null && (",
    to: "  return (view.macro?.fm?.plan?.subtasks ?? []).filter((s) => s?.id != null && (true ||",
    why: 'a lane that stops waiting without landing (a new attempt) takes every other lane\'s ready',
    killed_by: T_LANDED_UNIT,
  },
  {
    id: 'F53', file: SCHEDULER, tests: [T_DRAIN_FILE],
    from: "    (s.status === 'in_progress' && view.landing?.[s.id]?.ok === true)",
    to: '    false',
    why: 'a merged pull request the list never held (its landing check failed until this look) leaves B ready',
    killed_by: T_LANDED_UNIT,
  },
  {
    id: 'F54', file: SCHEDULER, tests: [T_DRAIN_FILE],
    from: "    || (departed.has(s.id) && s.status === 'completed' && typeof s.commit === 'string' && s.commit !== '')",
    to: "    || (departed.has(s.id) && s.status === 'completed')",
    why: 'a completion with no commit, which lands nothing, takes the other lanes\' ready',
    killed_by: T_LANDED_UNIT,
  },
  {
    id: 'F55', file: SCHEDULER, tests: [T_DRAIN_FILE],
    from: "    || (departed.has(s.id) && s.status === 'completed' && typeof s.commit === 'string' && s.commit !== '')",
    to: "    || (s.status === 'completed' && typeof s.commit === 'string' && s.commit !== '')",
    why: 'every subtask the macro ever completed reads as a new landing, so no unfetched look keeps a ready',
    killed_by: T_LANDED_UNIT,
  },
  {
    id: 'F22', file: CLI, tests: T_SCHED,
    from: "      `${sync ? ` · ${landingLabel(sync)}${sync.detail ? ` (${sync.detail})` : ''}` : ''}`);",
    to: "      '');",
    why: 'status of a run halted for another reason shows a lane it left unknown with nothing after its earlier landing-ready record',
    killed_by: [T_DRAIN_FAILS, T_DRAIN_MACRO],
  },
  {
    id: 'F23', file: LANDING, tests: [T],
    from: '      `${g} merge refs/remotes/origin/${integration}`,',
    to: '      `${g} merge origin/${integration}`,',
    why: 'a tag or local branch named origin/<baseline> shadows the short name: the printed merge says "Already up to date" and the branch stays behind',
    killed_by: T_FRESH,
  },

  // ---- P: a failure to record, printed once (C123) --------------------------------
  {
    id: 'P1', file: LANDING, tests: [T],
    from: '      appendLanding(runDir, record);',
    to: '      notice.warned = false;\n      appendLanding(runDir, record);',
    why: 'a record published in part (the run ledger, not the log) clears the notice, and the same failure prints at every look',
    killed_by: T_ONCE,
  },
  {
    id: 'P2', file: LANDING, tests: [T],
    from: PUBLISHED,
    to: '      report.reported.push(entry.subtaskId);',
    why: 'once printed, a failure is never printed again, a new one after a recovery included',
    killed_by: T_ONCE,
  },
  {
    id: 'P3', file: LANDING, tests: [T],
    from: '    if (!notice.warned) {',
    to: '    if (true) {',
    why: 'every look prints the same failure',
    killed_by: T_ONCE,
  },
  {
    id: 'P4', file: OFFLOOP, tests: [T, ...T_SCHED],
    from: '    const notice = { warned: a.warned === true };',
    to: '    const notice = { warned: false };',
    why: 'an off-loop report does not know the run printed the failure, and prints it again',
    killed_by: [T_ONCE, T_LANES_ONCE],
  },
  {
    id: 'P5', file: DRIVER, tests: T_SCHED,
    from: 'cache: [...mergeChecks], warned: notice.warned }',
    to: 'cache: [...mergeChecks] }',
    why: 'the run does not pass its notice to an off-loop report',
    killed_by: T_LANES_ONCE,
  },
  {
    id: 'P6', file: DRIVER, tests: T_SCHED,
    from: '        notice.warned = r.value.warned === true;',
    to: '        void r.value.warned;',
    why: 'the run does not take the notice back from an off-loop report',
    killed_by: T_LANES_ONCE,
  },

  // ---- L: the ledger's appends (C123) ---------------------------------------------
  {
    id: 'L1', file: LEDGER, tests: [T_LEDGER],
    from: "  appendLine(path.join(runDir, 'landing.jsonl'), JSON.stringify(record), o);",
    to: "  fs.appendFileSync(path.join(runDir, 'landing.jsonl'), `${JSON.stringify(record)}\\n`);",
    why: 'the run\'s landing ledger appends after a torn line, and the next record joins it',
    killed_by: T_LEDGER_TORN,
  },
  {
    id: 'L2', file: LEDGER, tests: [T_LEDGER],
    from: '    for (let at = 0; at < bytes.length;) {',
    to: '    for (let at = 0; at < 1;) {',
    why: 'a short write is taken for the whole line, which is left cut',
    killed_by: T_LEDGER_SHORT,
  },
  {
    id: 'L3', file: LEDGER, tests: [T_LEDGER],
    from: "      if (!(n > 0)) throw new Error(`could not append to ${file}: a write made no progress`);",
    to: '      void n;',
    why: 'a write that makes no progress is retried for ever',
    killed_by: T_LEDGER_SHORT,
  },

  // ---- S: the surfaces that carry the report --------------------------------------
  {
    id: 'S1', file: DRIVER, tests: [T],
    from: '    merge_order: d.mergeOrder ? mergeOrderRecord(d.mergeOrder) : null,',
    to: '    merge_order: d.mergeOrder ?? null,',
    why: 'halt.json keeps the merge order in camel case, unlike landing.jsonl (C123)',
    killed_by: T_PAIRS,
  },
  {
    id: 'S2', file: DRIVER, tests: [T, T_DRAIN_FILE, ...T_SCHED],
    from: '  return { ...d, waiting, ...facts };',
    to: '  return { ...d, ...facts };',
    why: 'the awaiting-landing halt lists the decision\'s branches, without their freshness and sync commands, and one that landed as the run ended',
    killed_by: [T_PAIRS, T_A_THEN_B, T_HALT_UNIT, T_IDLE_LANDED],
  },
  {
    id: 'S3', file: SCHEDULER, tests: T_SCHED,
    from: 'commit: w.commit ?? null, sync: w.sync ?? null };',
    to: 'commit: w.commit ?? null };',
    why: 'a run with lanes reports each waiting lane without its freshness',
    killed_by: T_TWO_LANES,
  },
  {
    id: 'S4', file: CLI, tests: [T],
    from: '    out(`  ◆ ${landingLabel(l.sync)} after [${l.after_seq}]:',
    to: '    out(`  ◆ landing-ready after [${l.after_seq}]:',
    why: 'status labels a branch that needs a sync landing-ready',
    killed_by: T_A_THEN_B,
  },
  {
    id: 'S5', file: DRIVER, tests: [T],
    from: "    if (w.sync) out(`      ${syncText(w.sync, d.integration ? `refs/remotes/origin/${d.integration}` : null)}`);",
    to: '    void syncText;',
    why: 'the printed halt does not say a branch needs a sync',
    killed_by: T_A_THEN_B,
  },

  {
    id: 'S6', file: CLI, tests: [T],
    from: "      if (w.sync) out(`    · ${w.subtaskId} on ${w.branch}: ${landingLabel(w.sync)}${w.sync.detail ? ` (${w.sync.detail})` : ''}`);",
    to: '      void w;',
    why: 'status of a run that published nothing new shows no readiness for the branches its halt lists',
    killed_by: T_A_THEN_B,
  },
  {
    id: 'S7', file: DRIVER, tests: T_SCHED,
    from: SERIAL_HALT,
    to: "      if (d.reason === 'awaiting-landing') d = withLanding(d, landing, waiting);",
    why: 'a serial run that halts for another reason while a branch waits to land lists nothing of it (C128)',
    killed_by: [T_SERIAL_WAITING, T_SERIAL_RETRY, T_SERIAL_INTERRUPT],
  },
  {
    id: 'S8', file: DRIVER, tests: T_SCHED,
    from: '      waiting = reconcileWaiting(waiting, v, foundWaiting(v, true, landing));',
    to: '',
    why: 'a serial run\'s looks never feed its list, so its halt for another reason lists nothing',
    killed_by: T_SERIAL_WAITING,
  },
  // S9 (withLanding's own `unknown` for a branch its report did not list) is
  // retired: the halt lists the run's list, where reconcileWaiting marks that
  // branch (F21, killed by the same unit test).
  {
    id: 'S10', file: DRIVER, tests: T_SCHED,
    from: '      if (run.halt.waiting) run.halt = { ...run.halt, waiting: endedUnlooked(run.halt.waiting, why) };',
    to: '      void why;',
    why: 'an error after the halt was recorded leaves its waiting branches ready in halt.json',
    killed_by: T_HALT_AFTER_ERROR,
  },
  {
    id: 'S12', file: DRIVER, tests: T_SCHED,
    from: '    waiting = reconcileWaiting(waiting, v, foundWaiting(v, false, null));',
    to: '',
    why: 'a serial look never feeds the list as it returns: a halt before the first report (the locks are held) lists nothing of a branch the first look found waiting, and a look a failed retry replaces drops what it found',
    killed_by: [T_SERIAL_LOCKED, T_SERIAL_RETRY],
  },
  {
    id: 'S16', file: DRIVER, tests: T_SCHED,
    from: '      run.waiting = endedUnlooked(waiting, why);',
    to: '',
    why: 'a serial run that stops on an error before any halt records nothing of what waited, and status shows the log\'s last ready',
    killed_by: T_SERIAL_ERROR,
  },
  {
    id: 'S17', file: CLI, tests: T_SCHED,
    from: '  for (const w of r.run.waiting ?? []) {',
    to: '  for (const w of []) {',
    why: 'status of a serial run that stopped on an error does not show what waited, unknown',
    killed_by: T_SERIAL_ERROR,
  },
  {
    id: 'S13', file: DRIVER, tests: T_SCHED,
    from: '      view = look(view.macro.id);\n      // A look that could not read',
    to: '      view = observe({ repoRoot, roots, macroId: view.macro.id, fetch: true, env });\n      // A look that could not read',
    why: 'the look after a step bypasses the serial look: a branch it found waiting is lost when a retry that fails replaces it (C128 serial mirror of F43)',
    killed_by: T_SERIAL_RETRY,
  },
  {
    id: 'S14', file: DRIVER, tests: T_SCHED,
    from: "      if (interrupted) waiting = endedUnlooked(waiting, 'the owner interrupted the run');",
    to: '',
    why: 'a serial run the owner interrupts lists a branch ready that no look after the interrupt confirmed',
    killed_by: T_SERIAL_INTERRUPT,
  },
  {
    id: 'S11', file: DRIVER, tests: T_SCHED,
    from: '      try {\n        writeHalt(runDir, run.halt);\n      } catch { /* run.json carries it */ }',
    to: '',
    why: 'an error after the halt was recorded leaves halt.json as it was written, its lanes ready',
    killed_by: T_HALT_AFTER_ERROR,
  },

  // ---- X: the fixture keeps the caller's git out (C123 F3) ------------------------
  {
    id: 'X1', file: FIXTURE, tests: [T],
    from: "for (const k of Object.keys(process.env)) if (k.startsWith('GIT_')) delete process.env[k];",
    to: 'void 0;',
    why: 'a GIT_DIR the caller left (a hook\'s) reaches the state helpers the fixture calls in place',
    killed_by: T_FIXTURE,
  },
  {
    id: 'X2', file: FIXTURE, tests: [T],
    from: "  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(gitHome, 'gitconfig'), XDG_CONFIG_HOME: join(gitHome, 'xdg'),",
    to: "  GIT_CONFIG_NOSYSTEM: '1', XDG_CONFIG_HOME: join(gitHome, 'xdg'),",
    why: 'the caller\'s global config (a signing program, a hooks path) reaches the fixture\'s commits',
    killed_by: T_FIXTURE,
  },
];
