// Mutation spec — do the verify-exec tests catch the defects they exist for?
// (ADR-0068 Decision 5, items 1, 3, 6 to 10; Decision 6, items 5 and 7)
//
// Run: npm run mutate -- scripts/mutation-specs/verify-exec.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. The verification step is the driver acting
// with no model in the loop: a check it should not have run, a result it
// should not have trusted, a timeout that never fires or a batch it charges
// each fails where no worker report would show it. A green suite says the
// happy path works; each mutation below breaks one guarantee and names the
// test that must notice.
//
// Groups: C the declaration copy and the offer, O order and stops, B binding
// and recovery, R repeats, P processes and bounds, W the wrapper's status
// channel, F the fixtures' git isolation. The driver's and the policy's are
// verify-exec-driver.mjs's: a spec that anchors a file selects every test it
// lists for a change to that file (verify-select R6), and the driver's tests
// are the ones that file needs.

const T_DECL = 'tests/orchestrator/test-autopilot-verify-decl.mjs';
const T_RUN = 'tests/orchestrator/test-autopilot-verify-run.mjs';
const T_DRV = 'tests/orchestrator/test-autopilot-verify-driver.mjs';
const T_REF = 'tests/orchestrator/test-autopilot-verify-refusal.mjs';
const T_WRAP = 'tests/orchestrator/test-heavy-lock-wrapper.mjs';

const AP = 'plugins/orchestrator/adapters/claude/autopilot';
const RUN = `${AP}/verify-run.mjs`;
const DECL = `${AP}/verify-decl.mjs`;
const JOURNAL = `${AP}/verify-journal.mjs`;
const FIX = 'tests/orchestrator/_verify-fixtures.mjs';

export const TESTS = [T_DECL, T_RUN, T_DRV, T_REF, T_WRAP];

export const MUTATIONS = [
  // ---- C: the declaration copy and the offer -------------------------------
  {
    id: 'C1', file: DECL, tests: [T_DECL],
    from: "  if (value.startsWith('-')) return 'begins with -';\n",
    to: '',
    why: 'the driver\'s copy takes an argument beginning with -, which the persona refuses: the copies part',
    killed_by: /resolves and refuses every check as the persona does/,
  },
  {
    id: 'C2', file: DECL, tests: [T_DECL],
    from: '  const shown = gitShow(repoRoot, `${commit}:${VERIFY_DECLARATION_PATH}`);',
    to: "  const shown = spawnSync('cat', [join(repoRoot, VERIFY_DECLARATION_PATH)], { encoding: 'utf8' });",
    why: 'the declaration is read from the working tree, which a worker\'s step can widen',
    killed_by: /reads the committed declaration, never the working tree's/,
  },
  {
    id: 'C3', file: RUN, tests: [T_DRV],
    from: '  const decl = job.offer.declaration;',
    to: "  const decl = (await import('./verify-decl.mjs')).parseDeclaration(fs.readFileSync(path.join(job.lane, '.agentic-plugins/verify-checks.json'), 'utf8'));",
    why: 'a batch resolves its checks from the lane\'s declaration, which the worker edited in its step',
    killed_by: /a worker that edits the declaration in its step widens nothing/,
  },
  {
    id: 'C4', file: `${AP}/roots.mjs`, tests: [T_RUN],
    from: '    if (text === null || !text.includes(token)) return `engineer at ${root} lacks ${what} (${file})`;',
    to: '    if (false) return `engineer at ${root} lacks ${what} (${file})`;',
    why: 'a persona without the record CLI is offered verification, and its workers write a kind it cannot record',
    killed_by: /a persona without the capability, or a baseline with no declaration, is not offered/,
  },
  {
    id: 'C5', file: `${AP}/worker.mjs`, tests: [T_REF, T_DRV],
    from: "  if (typeof verifyBaseline === 'string' && /^[0-9a-f]{40}$/.test(verifyBaseline)) env.AGENTIC_AUTOPILOT_VERIFY = verifyBaseline;\n",
    to: '',
    why: 'the run offers verification and never tells its workers, so no step can hand its long checks over',
    killed_by: [/the run's own offer \(verify-exec\) is the one a worker gets/, /a run that does not offer it halts run-wide on a verify child/],
  },
  {
    id: 'C6', file: DECL, tests: [T_DECL],
    from: '  if (!Number.isInteger(kind.timeout_s) || kind.timeout_s < 1 || kind.timeout_s > MAX_CHECK_TIMEOUT_S) {',
    to: '  if (!Number.isInteger(kind.timeout_s) || kind.timeout_s < 1 || kind.timeout_s > MAX_CHECK_TIMEOUT_S + 1) {',
    why: 'the driver\'s copy takes a declared timeout one second over the bound the persona refuses: the copies part on what a check may run for',
    killed_by: /parses, refuses and digests every declaration of the corpus as the persona does/,
  },
  {
    id: 'C7', file: DECL, tests: [T_DECL],
    from: '          const inTree = pathInTree(tree, v);\n',
    to: '          const inTree = null;\n',
    why: 'a path argument is never checked against the tested tree: a check naming a file the lane does not hold runs, where the persona refuses it',
    killed_by: /holds a path argument to the tested tree as the persona does/,
  },
  {
    id: 'C8', file: DECL, tests: [T_DECL],
    from: '  return Math.max(\n    scalarBytes(\'verify_results\', { ...results, batches: [...results.batches, filled] }),\n    scalarBytes(\'verify_results\', { ...results, batches: [link, link] }),\n  );',
    to: '  return scalarBytes(\'verify_results\', { ...results, batches: [...results.batches, filled] });',
    why: 'the worst case leaves out a continued batch\'s widest form: the driver starts a batch the persona\'s bound then refuses',
    killed_by: /bounds a batch's worst-case results as the persona does/,
  },
  // ---- O: order and stops ----------------------------------------------------
  {
    id: 'O1', file: RUN, tests: [T_RUN],
    from: '  if (firstSelfLocking === -1) return [...worker, ...additions];',
    to: '  return [...worker, ...additions];',
    why: 'the driver\'s tests run after the worker\'s mutation run, which the harness refuses on a tree whose tests were never run',
    killed_by: /places the driver's additions before the worker's first check that locks itself/,
  },
  {
    id: 'O2', file: RUN, tests: [T_RUN, T_DRV],
    from: "    if (r.outcome !== 'passed') break;\n",
    to: '',
    why: 'the batch runs on past a failure: a mutation run on a failing tree, a result after the one the batch stopped at',
    killed_by: [/stops at the first that does not pass, the rest not run/, /a failing check recorded and routed|dispatch → verify \(fails\)/],
  },
  {
    id: 'O3', file: RUN, tests: [T_RUN],
    from: "  if (treeNow !== batch.tree_start) return { tree_end: treeNow, end: 'no-evidence', cause: 'tree-changed' };\n",
    to: '',
    why: 'a batch whose tree changed under it ends as if its results were evidence for the tree it ended on',
    killed_by: /a tree edited during the batch gives no evidence/,
  },
  {
    id: 'O4', file: RUN, tests: [T_RUN],
    from: '      const argv = resolveCheck(decl, { kind: c.kind, args: c.args ?? {} }, { tree: job.lane });',
    to: '      const argv = resolveCheck(decl, { kind: c.kind, args: c.args ?? {} });',
    why: 'a path argument is no longer held to the tested tree: a check runs on a file that is not there',
    killed_by: /a check that does not resolve against the declaration is refused before anything runs/,
  },
  {
    id: 'O5', file: RUN, tests: [T_RUN],
    from: "    const cause = abortedBy() ? 'driver-end' : ctl.stopCause();",
    to: "    const cause = abortedBy() ? 'driver-end' : null;",
    why: 'a hold that arrives between two checks does not stop the batch: the second runs in a lane the owner holds',
    killed_by: /a hold between two checks stops the batch before the second/,
  },
  {
    id: 'O6', file: RUN, tests: [T_RUN],
    from: '  for (let i = results.length; i < checks.length; i += 1) {',
    to: "  for (let i = Math.max(results.length, (plan.prior?.results ?? []).filter((x) => x.outcome === 'passed').length); i < checks.length; i += 1) {",
    why: 'a continuation skips the checks its cut-short batch passed whatever the tree and the commands now: old passes answer an edited tree',
    killed_by: [/an edit under a hold, then the release: the batch cut short runs again whole/, /a relaunch whose declaration resolves the request to other commands runs it again whole/],
  },
  {
    id: 'O7', file: RUN, tests: [T_RUN],
    from: '  for (const ch of name) {\n    if (out.length + ch.length > MAX_FAILING_TEST_CHARS) break;',
    to: '  for (const ch of name.split(\'\')) {\n    if (out.length + ch.length > MAX_FAILING_TEST_CHARS) break;',
    why: 'a failing test\'s name is cut by UTF-16 unit, splitting a surrogate pair: the persona refuses the result as not well formed',
    killed_by: /a failing test's name is cut to the bound without splitting a surrogate pair/,
  },
  // ---- B: binding and recovery -------------------------------------------------
  {
    id: 'B7', file: RUN, tests: [T_RUN],
    from: "  if (typeof job.requestKnown === 'function' && !job.requestKnown(request)) {",
    to: '  if (false) {',
    why: 'a request a worker wrote by hand, naming a step no run took, runs its checks and takes on_pass',
    killed_by: /a request naming a step no run of the repository recorded for the subtask is refused/,
  },
  {
    id: 'B8', file: RUN, tests: [T_RUN],
    from: "  if (ctl.stopCause() || ctl.aborted()) {\n    signalGroup(pgid, 'SIGKILL');",
    to: "  if (false) {\n    signalGroup(pgid, 'SIGKILL');",
    why: 'a hold that arrives while the check\'s group is put on the locks lets the check start in a held lane',
    killed_by: /a hold that arrives while the check's group is put on the locks/,
  },
  {
    id: 'B9', file: JOURNAL, tests: [T_RUN],
    from: '      fs.ftruncateSync(fd, before);\n    }',
    to: '      // (not taken back)\n    }',
    why: 'a torn line a dead driver left joins the next intent, which then reads as nothing, and the next makes the journal unreadable',
    killed_by: /a torn last line of the journal is taken back/,
  },
  {
    id: 'B16', file: JOURNAL, tests: [T_RUN],
    from: '    end -= len;\n',
    to: '    break;\n',
    why: 'the scan for a torn line\'s start reads only the last 64 KiB, so a longer torn line (a large batch\'s start) takes back every line before it',
    killed_by: /a torn last line longer than 64 KiB is taken back to its start/,
  },
  {
    id: 'B1', file: RUN, tests: [T_RUN],
    from: "  if (problem) return { action: 'restart', why: problem, replaces:",
    to: "  if (false) return { action: 'restart', why: problem, replaces:",
    why: 'a record another writer forged is taken as evidence, and its pass makes on_pass the next step',
    killed_by: [/a record the journal does not hold is set aside in one restart/, /its result edited by hand, is set aside and run again/],
  },
  {
    id: 'B2', file: JOURNAL, tests: [T_RUN],
    from: '      if (!find(entries, id, \'result\', b.batch_id, (e) => e.index === r.index).some((e) => same(e.payload, r))) {',
    to: '      if (!find(entries, id, \'result\', b.batch_id, (e) => e.index === r.index).length) {',
    why: 'trust by batch id and index only: a result edited by hand under a batch the driver started passes as its own',
    killed_by: /whose failing tests were edited by hand, its batch and end untouched/,
  },
  {
    id: 'B3', file: RUN, tests: [T_RUN],
    from: "  if (latest && latest.end === undefined) return { action: 'end', batch: latest, end: endFor(latest, treeNow) };\n",
    to: '',
    why: 'a batch a dead driver left open is never ended: the check whose result was lost never runs again',
    killed_by: [/a check that ended before its result was recorded runs again/, /a batch left open at a recorded failure/],
  },
  {
    id: 'B4', file: RUN, tests: [T_RUN],
    from: "  if (last?.outcome === 'failed') return { tree_end: treeNow, end: 'failed', cause: null };\n",
    to: '',
    why: 'a recovered batch at a recorded failure is cut short instead, which the persona refuses, and the verb never resumes',
    killed_by: [/a batch left open at a recorded failure/, /stops at the first that does not pass/],
  },
  {
    id: 'B5', file: RUN, tests: [T_RUN],
    from: '        return treeNow === latest.tree_start\n',
    to: '        return true\n',
    why: 'a batch that passed on another tree takes on_pass: old results answer a tree they never ran on',
    killed_by: /a tree changed after a pass, before verify-pass, resumes the verb/,
  },
  {
    id: 'B6', file: RUN, tests: [T_RUN],
    from: '    if (tree !== p.start.payload?.tree_start) facts[id] = { guard:',
    to: '    if (false) facts[id] = { guard:',
    why: 'an answered request whose tree changed after the pass dispatches its on_pass on the changed tree',
    killed_by: /an answered one whose tree changed since its pass is guarded/,
  },
  {
    id: 'B10', file: RUN, tests: [T_DRV],
    from: '      noteResume(batchId, meta.verb, final);\n',
    to: '',
    why: 'the step decides the requesting verb follows and never tells the policy, which steps the batch that ended again and again',
    killed_by: /dispatch → verify \(fails\) → the verb resumes/,
  },
  {
    id: 'B11', file: JOURNAL, tests: [T_RUN],
    from: '    if (!hop || hop.tree_start !== tree || hop.checks_digest !== digest) return false;\n',
    to: '    if (!hop) return false;\n',
    why: 'a pass the driver recorded, carried into a batch on another tree or with other commands, or through a hop on one, counts there: an old pass reaches on_pass on a changed tree',
    killed_by: /a carried result is trusted only as the carry of a pass into a batch that continues its own/,
  },
  {
    id: 'B12', file: JOURNAL, tests: [T_RUN],
    from: '    if (cur === from) return true;\n    seen.add(cur);\n    cur = hop.continues ?? null;\n  }\n  return false;',
    to: '    if (cur === from) return true;\n    seen.add(cur);\n    cur = hop.continues ?? null;\n  }\n  return continues === null ? true : false;',
    why: 'a recorded pass set into a batch that continues nothing (or another chain) counts as carried',
    killed_by: /a carried result is trusted only as the carry of a pass into a batch that continues its own/,
  },
  {
    id: 'B13', file: JOURNAL, tests: [T_RUN],
    from: "  if (typeof summary.record_digest !== 'string' || r.payload.record_digest !== summary.record_digest) return null;\n",
    to: '',
    why: 'a resume line holds for a record edited after it: the requesting verb reads failing tests the driver never recorded',
    killed_by: /a record edited after its resume line .* yields no resume/,
  },
  {
    id: 'B14', file: RUN, tests: [T_RUN],
    from: '    try { all = first.length > 0 ? worktrees(first[0]) : []; } catch { all = []; }',
    to: '    all = [];',
    why: 'a request a run from a linked checkout recorded is unknown to a relaunch from the main checkout, which parks the lane',
    killed_by: /a request a run from a linked checkout recorded is known to a relaunch from the main one/,
  },
  {
    id: 'B15', file: RUN, tests: [T_RUN],
    from: '    noteResume(own(request, fm.verify_results).at(-1)?.batch_id, plan.verb, fm);\n',
    to: '',
    why: 'a step that finds a batch already ended decides the requesting verb and never tells the policy, which never dispatches it',
    killed_by: /on a tree changed since, the step decides the requesting verb, and the policy takes it from the journal/,
  },
  // ---- R: repeats ---------------------------------------------------------------
  {
    id: 'R1', file: RUN, tests: [T_RUN],
    from: '  if (!forcedRerun && before && before.checks_digest === digest',
    to: '  if (false && before && before.checks_digest === digest',
    why: 'a verb that records the same checks again on an unchanged tree loops through a batch that cannot change',
    killed_by: /halt no-progress and run nothing; the owner's rerun runs them once/,
  },
  {
    id: 'R2', file: RUN, tests: [T_RUN],
    from: " && (before.end === 'passed' || before.end === 'failed')) {",
    to: ') {',
    why: 'a batch that gave no evidence (a timeout) counts as an answer, and the checks never run again',
    killed_by: /second timed out, the same checks run again whole/,
  },
  {
    id: 'R3', file: RUN, tests: [T_RUN],
    from: '  if (e.end === \'passed\') {\n    await write(\'pass\', \'verify-pass\', [\'--batch-id\', batchId], { batch_id: batchId, payload: null });\n    follow = { kind: \'on_pass\' };\n',
    to: '  if (e.end === \'passed\') {\n    follow = { kind: \'on_pass\' };\n',
    why: 'a batch that passed never answers its request: the step reports on_pass, but the workflow\'s next step stays verify and the next look takes the pass up again',
    killed_by: /a passing batch makes on_pass the next step, and runs nothing on the next look/,
  },
  {
    id: 'R4', file: RUN, tests: [T_RUN],
    from: '      case \'failed\':\n      case \'no-evidence\':\n        return { action: \'resume\', verb: requester(latest), why: `batch ${latest.batch_id} ended ${latest.end}` };\n      case \'cut-short\':\n',
    to: '      case \'no-evidence\':\n        return { action: \'resume\', verb: requester(latest), why: `batch ${latest.batch_id} ended ${latest.end}` };\n      case \'failed\':\n      case \'cut-short\':\n',
    why: 'a recorded failure is taken up as a batch cut short: the step asks the persona to continue a failed batch, which it refuses, and the verb never resumes',
    killed_by: /a recorded failure resumes the verb, even after the driver died, and runs no later check/,
  },
  {
    id: 'R5', file: RUN, tests: [T_RUN],
    from: "          ? { action: 'pass', batchId: latest.batch_id }\n",
    to: "          ? { action: 'resume', verb: requester(latest), why: `batch ${latest.batch_id} passed` }\n",
    why: 'a batch that passed, its driver dead before verify-pass, resumes the paid verb on the tree it passed on instead of taking on_pass',
    killed_by: /on the tree it passed on, the next step answers it with verify-pass, on_pass follows, and nothing runs again/,
  },
  // ---- S: a stop before the batch starts -----------------------------------------
  {
    id: 'S1', file: RUN, tests: [T_RUN],
    from: '  const before = stopNow();\n  if (before) return yielded(before);\n',
    to: '',
    why: 'a hold that came while the batch was prepared is not read before its start: the batch starts and runs its checks in a held lane',
    killed_by: /a hold that came while the batch was prepared starts none: the step yields, writes nothing, and the next step runs it/,
  },
  {
    id: 'S2', file: RUN, tests: [T_RUN],
    from: "    const cause = seen ?? (HELD_LANE_REFUSAL.test(String(e?.message ?? '')) ? 'hold' : null);\n    if (cause) return yielded(cause, seen === null);\n    throw e;\n",
    to: '    throw e;\n',
    why: 'a start the persona refuses because a hold came after the driver\'s read is the step\'s failure, which parks the lane, not a yield',
    killed_by: /a start the persona refuses while a stop is set yields as the stop; refused with none set, the step fails/,
  },
  {
    id: 'S3', file: RUN, tests: [T_RUN],
    from: "  const stopNow = () => (abortedBy() ? 'driver-end' : ctl.stopCause());\n",
    to: "  const stopNow = () => (ctl.stopCause() ?? (abortedBy() ? 'driver-end' : null));\n",
    why: 'a hold read before the driver\'s end: an interrupted batch yields as held, where every other stop of the batch names the driver\'s end first',
    killed_by: /a hold that came while the batch was prepared starts none: the step yields, writes nothing, and the next step runs it/,
  },
  // ---- P: processes and bounds --------------------------------------------------
  {
    id: 'P1', file: RUN, tests: [T_RUN],
    from: "  'AGENTIC_AUTOPILOT', 'AGENTIC_AUTOPILOT_TOKEN', 'AGENTIC_AUTOPILOT_STEP', 'AGENTIC_AUTOPILOT_VERIFY', 'AGENTIC_STATE_BASE',",
    to: "  'AGENTIC_AUTOPILOT_STEP', 'AGENTIC_AUTOPILOT_VERIFY', 'AGENTIC_STATE_BASE',",
    why: 'a check inherits the run\'s admission token and autopilot flag, and can act as a worker of the run',
    killed_by: /a check gets the worker's environment without the run's token/,
  },
  {
    id: 'P2', file: RUN, tests: [T_RUN],
    from: '      const ran = Date.now() - acquiredAt;',
    to: '      const ran = Date.now() - goAt;',
    why: 'the declared timeout counts the wait for the lock, so a check behind a long holder times out before it runs',
    killed_by: /the declared timeout counts from the lock's acquisition/,
  },
  {
    id: 'P3', file: RUN, tests: [T_RUN],
    from: "        else if (Date.now() - goAt >= bounds.lockWaitMs) await kill('bound');\n",
    to: '',
    why: 'the driver\'s wait for the heavy-work lock has no bound',
    killed_by: /the lock wait has its own bound/,
  },
  {
    id: 'P4', file: RUN, tests: [T_RUN],
    from: "        if (ctl.stopCause()) await kill('stopped');\n",
    to: '',
    why: 'a hold or a drain does not end the driver\'s wait for the lock',
    killed_by: /a drain during the lock wait ends the wait/,
  },
  {
    id: 'P5', file: RUN, tests: [T_RUN],
    from: "  sup.stdin.write('go\\n');\n  const goAt = Date.now();",
    to: "  const goAt = Date.now();",
    prepare: (copy, { applyEdit }) => {
      applyEdit(copy, { file: RUN, from: '  let entries = [];\n  try {\n    entries = await ctl.register({ pid: sup.pid, pgid });', to: "  sup.stdin.write('go\\n');\n  let entries = [];\n  try {\n    entries = await ctl.register({ pid: sup.pid, pgid });" });
    },
    why: 'a check starts before its group is on the run\'s locks: a group no lock entry names runs heavy work',
    killed_by: /a check run directly whose group cannot be put on the run's locks never runs/,
  },
  {
    id: 'P6', file: RUN, tests: [T_RUN],
    from: '  if (Number.isInteger(end.code)) return',
    to: "  if (end.code === 127) return { ...base, outcome: 'not-started', exit: null, signal: null };\n  if (Number.isInteger(end.code)) return",
    why: 'a test run that exits 127 is read as a command not found, and its failure gives no evidence',
    killed_by: /a command that exits 127 failed; one that is not found could not start/,
  },
  {
    id: 'P7', file: RUN, tests: [T_RUN],
    from: "      if (ran >= deadlineMs.declared) await kill('timeout');",
    to: "      if (false) await kill('timeout');",
    why: 'a check never ends at its declared timeout',
    killed_by: /the declared timeout ends a hung check with no evidence/,
  },
  {
    id: 'P8', file: RUN, tests: [T_RUN],
    from: "      else if (ran >= deadlineMs.batchLeft) await kill('bound');",
    to: "      else if (false) await kill('bound');",
    why: 'the batch\'s 6-hour bound never cuts a running check',
    killed_by: /the batch bound ends a check it cuts with no evidence/,
  },
  {
    id: 'P9', file: RUN, tests: [T_RUN],
    from: "    if (ctl.aborted()) await kill('aborted');",
    to: '    if (false) await kill(\'aborted\');',
    why: 'the driver\'s signal leaves a running check running',
    killed_by: /the driver's signal stops a running check/,
  },
  {
    id: 'P10', file: RUN, tests: [T_RUN],
    from: "    inner = { pgid: ready.pgid, started: typeof ready.started === 'string' ? ready.started : null };\n    if (ctl.stopCause()) return kill('stopped');\n",
    to: "    inner = { pgid: ready.pgid, started: typeof ready.started === 'string' ? ready.started : null };\n",
    prepare: (copy, { applyEdit }) => {
      applyEdit(copy, { file: RUN, from: "    }\n    if (ctl.stopCause()) return kill('stopped');\n    if (ctl.aborted()) return kill('aborted');\n    fs.writeFileSync(goFile, 'go\\n');", to: "    }\n    if (ctl.aborted()) return kill('aborted');\n    fs.writeFileSync(goFile, 'go\\n');" });
    },
    why: 'the driver gives the go once the wrapper holds the lock without reading the holds: a hold that came with the acquisition runs the check',
    killed_by: /a hold that arrives while the wrapper's command group is put on the locks stops it before the go/,
  },
  {
    id: 'P11', file: RUN, tests: [T_RUN],
    from: "    if (inner !== null) signalLeader(inner.pgid, inner.started, 'SIGKILL');\n",
    to: '',
    why: 'teardown kills the wrapper\'s group only: the check\'s own group, its supervisor stopped, runs on off the run\'s locks',
    killed_by: /a stopped supervisor of it is killed, never left running off the run's locks/,
  },
  {
    id: 'P12', file: RUN, tests: [T_RUN],
    from: '      entries = [...entries, ...await ctl.register({ pid: inner.pgid, pgid: inner.pgid })];\n',
    to: '',
    why: 'the check\'s own command group is never a run-lock entry: a reader of the run\'s locks never sees the heavy work running',
    killed_by: [/places the driver's additions before the worker's first check that locks itself/, /a stopped supervisor of it is killed/],
  },
  {
    id: 'P13', file: RUN, tests: [T_RUN],
    from: "  'AGENTIC_HEAVY_LOCK_PROOF', 'AGENTIC_HEAVY_LOCK_VIA',\n",
    to: '',
    why: 'a check keeps a holding worker\'s heavy-lock proof and joins that holder\'s ownership instead of waiting for the lock',
    killed_by: /a check never joins the heavy-work ownership a holding worker's environment carries/,
  },
  {
    id: 'P14', file: RUN, tests: [T_RUN],
    from: '        saidAcquired = true;\n        ctl.waiting(null);\n',
    to: '        saidAcquired = true;\n        ctl.waiting(null);\n        fs.writeFileSync(goFile, \'go\\n\');\n        acquiredAt = Date.now();\n        continue;\n',
    why: 'the driver gives the go as the lock is acquired, before it reads the holds (the defect the go handshake closed): a hold that came with the acquisition runs the check',
    killed_by: /a hold that arrives as the wrapper takes the lock stops the check before its command starts/,
  },
  {
    id: 'P15', file: RUN, tests: [T_RUN],
    from: '  const pgid = sup.pid;\n  let entries = [];\n',
    to: '  const pgid = sup.pid;\n  const reg0 = ctl.register;\n  ctl = { ...ctl, register: async (g) => { try { return await reg0(g); } catch { return []; } } };\n  let entries = [];\n',
    why: 'a registration on the run\'s locks that fails is ignored: the check runs as a group no lock entry names',
    killed_by: [/a check whose group cannot be put on the run's locks never runs$/, /a check run directly whose group cannot be put on the run's locks never runs/],
  },
  {
    id: 'P16', file: RUN, tests: [T_RUN],
    from: "  if (rec.host === os.hostname() && groupOf(rec.pid) === pgid) return null;\n",
    to: '',
    why: 'a lock the check\'s own wrapper took between the driver\'s two reads is reported as the holder it waits for: the run names itself as the holder',
    killed_by: /the lock wait never names the check's own wrapper as its holder/,
  },
  {
    id: 'P17', file: RUN, tests: [T_RUN],
    from: '  if (rec.host === os.hostname() && groupOf(rec.pid) === pgid) return null;',
    to: '  if (rec.host === os.hostname() && rec.pid === pgid) return null;',
    why: 'only the group\'s leader is taken for the check\'s own: the wrapper, a child of the supervisor that leads the group, is still reported as the holder',
    killed_by: /the lock wait never names the check's own wrapper as its holder/,
  },
  {
    id: 'P18', file: RUN, tests: [T_RUN],
    from: '  if (rec.host === os.hostname() && groupOf(rec.pid) === pgid) return null;',
    to: '  if (groupOf(rec.pid) === pgid) return null;',
    why: 'a holder on another machine whose pid matches a process of this check\'s group here is taken for the check\'s own, and its wait is reported with no holder',
    killed_by: /the lock wait never names the check's own wrapper as its holder/,
  },
  // ---- F: the fixtures' git isolation --------------------------------------
  {
    id: 'F1', file: FIX, tests: [T_RUN],
    from: 'Object.assign(process.env, GIT_ISOLATION);\n',
    to: '',
    why: 'the fixture\'s scrub deletes the isolation autopilot-repo.mjs set: the persona CLIs and the driver\'s git run under the machine\'s global and system config, its hooks and signing included',
    killed_by: /this process and the fixture's git read the isolated global config/,
  },
  {
    id: 'F2', file: FIX, tests: [T_RUN],
    from: "!k.startsWith('GIT_'))), ...GIT_ISOLATION });",
    to: "!k.startsWith('GIT_'))) });",
    why: 'the fixture\'s own git drops the isolation with the inherited GIT_* names, and its commits run under the machine\'s config',
    killed_by: /this process and the fixture's git read the isolated global config/,
  },
  // ---- W: the wrapper's status channel ------------------------------------------
  {
    id: 'W1', file: 'plugins/orchestrator/scripts/lib/heavy-run.mjs', tests: [T_WRAP],
    from: "    status({ state: 'ended', error: String(report.error) });",
    to: "    status({ state: 'ended', code: startFailureStatus(report.error) });",
    why: 'the status channel reports a command that was not found as one that exited 127',
    killed_by: /--status-file: acquired, running and ended/,
  },
  {
    id: 'W2', file: 'plugins/orchestrator/scripts/lib/heavy-run.mjs', tests: [T_WRAP],
    from: '    while (!unready && received() === null && !existsSync(goFile)) await sleep(GO_POLL_MS);\n',
    to: '',
    why: 'the wrapper starts its command once it holds the lock, before the driver has read its holds and put the command group on its locks',
    killed_by: /--go-file: ready with the command's group, and the command starts only once the go file exists/,
  },
  {
    id: 'W3', file: 'plugins/orchestrator/scripts/lib/heavy-run.mjs', tests: [T_WRAP],
    from: "    unready = !status({ state: 'ready', pgid: g.pgid, started: g.started ?? null });",
    to: "    status({ state: 'ready', pgid: g.pgid, started: g.started ?? null });",
    why: 'a ready line the status file never took leaves the wrapper waiting for a go no driver can give, the heavy-work lock held',
    killed_by: /a ready line the status file does not take is no go/,
  },
];
