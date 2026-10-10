// Mutation spec — do the scheduler's tests catch the defects they exist for?
// (ADR-0067 Decision 6: the throttle, the budget reservations, the lanes
// policy, a dead run's accounting by seq)
//
// Run: npm run mutate -- scripts/mutation-specs/autopilot-scheduler.mjs
//
// Every rule below decides what a run with lanes may start, or what it is
// charged, and each defect is quiet: a lane started into a refused rate-limit
// window, a run halted while it could wait, a step charged twice or never, one
// lane's progress taken for another's. Each mutation breaks one rule and names
// the test that must notice.
//
// Groups: T the throttle, B the budget, L the lanes policy, A a dead run's
// accounting, O the work run off the loop (offloop.mjs), S the scheduler end
// to end (scheduler.mjs and its start in driver.mjs and cli.mjs, against the
// fake claude: each runs for minutes).

const TT = 'tests/orchestrator/test-autopilot-throttle.mjs';
const TB = 'tests/orchestrator/test-autopilot-budget.mjs';
const TP = 'tests/orchestrator/test-autopilot-policy.mjs';
const TW = 'tests/orchestrator/test-autopilot-worker.mjs';
const TC = 'tests/orchestrator/test-autopilot-cli.mjs';
const TDR = 'tests/orchestrator/test-autopilot-dead-runs.mjs';
const TS = 'tests/orchestrator/test-autopilot-scheduler.mjs';
const TO = 'tests/orchestrator/test-autopilot-offloop.mjs';
const TLS = 'tests/orchestrator/test-autopilot-lanes-supervision.mjs';

const AP = 'plugins/orchestrator/adapters/claude/autopilot';
const THROTTLE = `${AP}/throttle.mjs`;
const BUDGET = `${AP}/budget.mjs`;
const POLICY = `${AP}/policy.mjs`;
const WORKER = `${AP}/worker.mjs`;
const CLI = `${AP}/cli.mjs`;
const DEAD = `${AP}/dead-runs.mjs`;
const SCHED = `${AP}/scheduler.mjs`;
const DRIVER = `${AP}/driver.mjs`;
const LEDGER = `${AP}/ledger.mjs`;
const ROOTS = `${AP}/roots.mjs`;
const OFFLOOP = `${AP}/offloop.mjs`;
const GATE = '  const gate = (refreshable = false) => gateNewLane(throttle, { nowSec: now() / 1000, deadlineSec: budget.deadlineSec(), inFlight: inflight.size, refreshable });';
const TERMINAL = '  if (macro.fm?.terminal_marker === true && !ctx.driverBusy) {';

export const TESTS = [TT, TB, TP, TW, TC, TDR, TO, TS, TLS];

export const MUTATIONS = [
  // ---- T: the throttle ------------------------------------------------------
  {
    id: 'T1', file: THROTTLE, tests: [TT],
    from: '    state.windows[info.rateLimitType].status = part(info.status, info.resetsAt);',
    to: '    for (const w of WINDOWS) state.windows[w].status = part(info.status, info.resetsAt);',
    why: 'a seven-day warning overwrites a five-hour refusal: the state is kept per event, not per window',
    killed_by: /never erases what is kept for the other/,
  },
  {
    id: 'T2', file: THROTTLE, tests: [TT],
    from: '      if (p && p.resetsAt !== null && p.resetsAt <= nowSec) state.windows[w][k] = null;',
    to: '      if (p && p.resetsAt !== null && p.resetsAt <= nowSec) { state.windows.five_hour[k] = null; state.windows.seven_day[k] = null; }',
    why: 'a five-hour reset also drops a seven-day refusal',
    killed_by: /each kept part is dropped once its own reset has passed/,
  },
  {
    id: 'T3', file: THROTTLE, tests: [TT],
    from: '  if (five.utilization && isNum(five.utilization.value) && five.utilization.value >= FIVE_HOUR_LIMIT) {',
    to: '  if (five.utilization && isNum(five.utilization.value) && five.utilization.value > FIVE_HOUR_LIMIT) {',
    why: 'a five-hour utilization of exactly 0.85 starts a new lane',
    killed_by: /the boundary included/,
  },
  {
    id: 'T4', file: THROTTLE, tests: [TT],
    from: "  if (five.status && five.status.value !== 'allowed' && five.status.value !== 'rejected') {",
    to: "  if (five.status && five.status.value === 'never') {",
    why: 'a five-hour warning below 0.85 does not throttle',
    killed_by: /other than exactly allowed throttles/,
  },
  {
    id: 'T5', file: THROTTLE, tests: [TT],
    from: "  if (state.events === 0) return { state: 'unknown', why: 'no rate-limit event in this run yet', throttling };",
    to: '',
    why: 'before the first event a run with workers in flight starts more lanes',
    killed_by: /no event in this run is unknown/,
  },
  {
    id: 'T6', file: THROTTLE, tests: [TT],
    from: '    return inFlight > 0\n',
    to: '    return false\n',
    why: 'an unknown rate limit starts a new lane beside a worker in flight',
    killed_by: /unknown starts a new lane only while no worker is in flight/,
  },
  {
    id: 'T7', file: THROTTLE, tests: [TT],
    from: '  const late = j.throttling.find((p) => p.resetsAt > deadlineSec);',
    to: '  const late = null;',
    why: 'a run waits for a window that reopens only after its deadline',
    killed_by: /resets after the run's deadline/,
  },
  {
    id: 'T8', file: THROTTLE, tests: [TT],
    from: '  if (inFlight > 0 || refreshable) return',
    to: '  if (inFlight > 0) return',
    why: 'a throttled run with a started lane that can step halts or sleeps instead of stepping',
    killed_by: /a started lane with a runnable step, waits for newer events/,
  },
  {
    id: 'T9', file: WORKER, tests: [TW],
    from: '        try { o.onRateLimit(ev.rate_limit_info ?? null); } catch { /* the driver\'s, not the step\'s */ }',
    to: '        o.onRateLimit(ev.rate_limit_info ?? null);',
    why: 'a bug in the driver\'s bookkeeping stops the worker\'s stream',
    killed_by: /a throwing rate-limit callback does not stop the stream/,
  },
  {
    id: 'T10', file: THROTTLE, tests: [TT],
    from: "  if (!usable(five.utilization)) return { state: 'unknown', why: 'no five-hour utilization is known', throttling };",
    to: "  if (!usable(five.utilization)) return { state: 'open', why: 'no five-hour utilization is known', throttling };",
    why: 'events came but none kept a five-hour utilization (dropped at its reset, or never reported): the run reads it open and starts lanes',
    killed_by: /events came, but no five-hour utilization/,
  },

  // ---- B: the budget --------------------------------------------------------
  {
    id: 'B1', file: BUDGET, tests: [TB],
    from: '      if (st.taken + open.size >= maxSteps) {\n        return { wait: true',
    to: '      if (st.taken + open.size >= maxSteps) {\n        return { exhausted: true',
    why: 'a start blocked only by other steps\' reservations halts the run',
    killed_by: /the step cap counts reserved steps/,
  },
  {
    id: 'B2', file: BUDGET, tests: [TB],
    from: '      const left = maxCostUsd - st.spent - reservedUsd();',
    to: '      const left = maxCostUsd - st.spent;',
    why: 'concurrent launches each reserve the whole remaining budget',
    killed_by: /run cap − spent − reserved/,
  },
  {
    id: 'B3', file: BUDGET, tests: [TB],
    from: '      if (!spawned) return 0;',
    to: '',
    why: 'a lane creation that halted before its spawn is charged a step',
    killed_by: /halted before the spawn charges nothing/,
  },
  {
    id: 'B4', file: BUDGET, tests: [TB],
    from: '      if (!reservation || st.settled.has(reservation.id) || !open.has(reservation.id)) return 0;',
    to: '      if (!reservation) return 0;',
    why: 'a step settled twice is charged twice',
    killed_by: /a reservation is settled once/,
  },
  {
    id: 'B5', file: BUDGET, tests: [TB],
    from: "      return Math.floor(Math.min(reservation?.timeoutSec ?? stepTimeoutSec, maxTimeSec - elapsedSec()));",
    to: "      return reservation?.timeoutSec ?? stepTimeoutSec;",
    why: 'a worker whose lane took long to create runs past the run\'s deadline',
    killed_by: /judged again at its spawn/,
  },
  {
    id: 'B6', file: CLI, tests: [TC],
    from: '        if (o.stepBudgetUsd < MIN_STEP_BUDGET_USD) throw',
    to: '        if (false) throw',
    why: 'a per-step cap below the minimum step is accepted, and no step can ever be reserved',
    killed_by: /refuses what it does not know/,
  },

  // ---- L: the lanes policy --------------------------------------------------
  {
    id: 'L1', file: POLICY, tests: [TP],
    from: "    subtask: s ? [s.id, s.status ?? null, s.engineer_workflow_id ?? null, s.commit ?? null, s.pr_url ?? null, s.closed_at ?? null] : null,\n    child: c ? childTuple(subtaskId, c) : null,",
    to: "    subtask: s ? [s.id, s.status ?? null, s.engineer_workflow_id ?? null, s.commit ?? null, s.pr_url ?? null, s.closed_at ?? null] : null,\n    child: c ? childTuple(subtaskId, c) : null,\n    all: view?.children,",
    why: 'another lane\'s progress satisfies this lane\'s no-progress check',
    killed_by: /another lane's progress, and the macro's own bookkeeping/,
  },
  {
    id: 'L2', file: POLICY, tests: [TP],
    from: '    ? laneFingerprint(before, s.subtaskId) === laneFingerprint(after, s.subtaskId)',
    to: '    ? fingerprint(before) === fingerprint(after)',
    why: 'a lane step that changed nothing passes because another lane moved',
    killed_by: /verifyStep judges a lane step by its lane/,
  },
  {
    id: 'L3', file: POLICY, tests: [TP],
    from: '  const gates = s.lane ? laneGates(after, s.subtaskId) : stateGates(after);',
    to: '  const gates = stateGates(after);',
    why: 'a lane step\'s report of another lane\'s owner gate is taken at its word',
    killed_by: /only another lane's child records/,
  },
  {
    id: 'L4', file: POLICY, tests: [TP],
    from: '    if (s?.status !== \'in_progress\' || inFlight.has(s.id)) continue;',
    to: '    if (s?.status !== \'in_progress\') continue;',
    why: 'a lane with a step in flight is judged mid-step: its pending peer or commit phase halts the run',
    killed_by: /not judged until the step ends/,
  },
  {
    id: 'L5', file: POLICY, tests: [TP],
    from: '  const claim = claimProblem({ ...view, claims: (view.claims ?? []).filter((c) => !inFlight.has(c?.originating_subtask)) }, subtasks);',
    to: '  const claim = claimProblem(view, subtasks);',
    why: 'a dispatch in flight, whose new child claims its still-pending subtask, halts the run',
    killed_by: /a pending subtask claimed by its new child is not a claim problem then/,
  },
  {
    id: 'L6', file: POLICY, tests: [TP],
    from: '  if (!ctx.driverBusy && done.length > 0) {',
    to: '  if (done.length > 0) {',
    why: 'two /orchestrator:done workers run at once in the driver\'s checkout',
    killed_by: /one at a time/,
  },
  {
    id: 'L7', file: POLICY, tests: [TP],
    from: "  } else if (quiet && view.ready?.reason === 'all_terminal') {",
    to: "  } else if (view.ready?.reason === 'all_terminal') {",
    why: 'finalize runs while a lane\'s step is still in flight',
    killed_by: /finalize waits until nothing is in flight/,
  },
  {
    id: 'L8', file: POLICY, tests: [TP],
    from: "    if (f && f.kind !== 'dispatch') { out.laneSteps.push(laneStep({ ...f, forced: true }, s.id)); continue; }",
    to: '',
    why: 'a forced step does not replace its own lane\'s judgment halt',
    killed_by: /a forced step replaces only its own lane's judgment halt/,
  },
  {
    id: 'L9', file: POLICY, tests: [TP],
    from: "      if (active.length > 1) return nope(`${active.length} engineer workflows are active",
    to: "      if (false) return nope(`${active.length} engineer workflows are active",
    why: '--next without --lane picks one of several active lanes',
    killed_by: /with more than one active child, --next needs --lane/,
  },
  {
    id: 'L10', file: POLICY, tests: [TP],
    from: '  const laneStep = (st, id) => ({ ...st, lane: true, newLane: !started.has(id), needsLane: !lanes.has(id) });',
    to: '  const laneStep = (st, id) => ({ ...st, lane: true, newLane: !lanes.has(id), needsLane: !lanes.has(id) });',
    why: 'an adopted lane\'s first step in the run escapes the throttle (a new lane is its first step, not a new worktree)',
    killed_by: /each a step in its own lane/,
  },
  {
    id: 'L11', file: POLICY, tests: [TP],
    from: TERMINAL,
    to: '  if (macro.fm?.terminal_marker === true) {',
    why: 'the terminal marker the last done writes before its Stop hook archives the macro halts the run while that done runs',
    killed_by: /the macro's terminal marker is judged once no done or finalize is in flight/,
  },

  // ---- A: a dead run's accounting --------------------------------------------
  {
    id: 'A1', file: DEAD, tests: [TDR],
    from: '    const accounted = Array.isArray(run.accounted_seqs) ? new Set(run.accounted_seqs) : null;',
    to: '    const accounted = null;',
    why: 'with lanes, an earlier unfinished step below `steps` is never charged',
    killed_by: /settles each step once by its seq/,
  },

  // ---- O: the work run off the loop -----------------------------------------
  {
    id: 'O1', file: OFFLOOP, tests: [TO],
    from: '      settle(answer?.ok === true ? { value: answer.value } : { error: answer?.error ?? `${label} answered nothing` });',
    to: '      settle({ value: answer.value });',
    why: 'a task that throws (a lane layer error) answers as if it succeeded, and the scheduler acts on nothing',
    killed_by: /a task that throws answers \{ error \}/,
  },
  {
    id: 'O2', file: OFFLOOP, tests: [TO],
    from: "    try { teardown = await terminate(pid); } catch { teardown = 'lingering'; }",
    to: "    try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }",
    why: 'a task that runs out of time is killed alone: the git it started goes on after the answer, and after the caller lets go of its locks',
    killed_by: /a task that runs out of time is killed with everything it started/,
  },
  {
    id: 'O3', file: OFFLOOP, tests: [TO],
    from: '  if (pid !== null) {\n    try { teardown',
    to: '  if (pid !== null && answer.error) {\n    try { teardown',
    why: 'a task that answers is not torn down: a process it left in its group outlives the answer and the locks the caller then lets go',
    killed_by: /a task that answers leaves nothing behind/,
  },
  {
    id: 'O4', file: OFFLOOP, tests: [TO],
    from: '    if (hold && pid !== null) entries = await hold({',
    to: '    if (hold && pid !== null) child.stdin.end(input);\n    if (hold && pid !== null) entries = await hold({',
    why: 'a task has its input before its group is on the locks: a driver that dies in between leaves a task at work that holds no lock',
    killed_by: /a task's group goes on the locks before the task has its input/,
  },
  {
    id: 'O5', file: OFFLOOP, tests: [TO],
    from: '  // Nothing the task began outlives its answer.\n',
    to: '  for (const e of entries) e.release();\n  // Nothing the task began outlives its answer.\n',
    why: 'a task\'s entries go before its group is confirmed empty: another run may take the locks while the task\'s processes still run',
    killed_by: /a task's group goes on the locks before the task has its input/,
  },
  {
    id: 'O6', file: OFFLOOP, tests: [TO],
    from: "    signal?.addEventListener('abort', onAbort, { once: true });\n    if (signal?.aborted) onAbort();\n",
    to: '',
    why: 'a stop does not reach a task in flight: an interrupt waits for a look\'s network bound',
    killed_by: /a stop tears a task down at once/,
  },
  {
    id: 'O7', file: OFFLOOP, tests: [TO],
    from: '  } else {\n    child.stdin.destroy();\n  }',
    to: '  } else {\n    child.stdin.end(input);\n    await io.ended;\n  }',
    why: 'a task whose group could not be put on the locks runs anyway, outside the run\'s exclusion',
    killed_by: /a task that cannot be put on the locks answers \{ error \} and runs nothing/,
  },
  {
    id: 'O8', file: OFFLOOP, tests: [TO],
    from: '    if (hold && pid !== null) entries = await hold({ pid, pgid: GROUPS ? pid : null, fingerprint: await processFingerprint(pid), task });',
    to: '    if (hold && pid !== null) entries = await hold({ pid: process.pid, pgid: null, fingerprint: await processFingerprint(process.pid), task });',
    why: 'the lock records the driver, not the task\'s group: a driver that dies leaves a task running that holds no lock, and the next run takes it',
    killed_by: /a driver that dies with a task in flight leaves the task's group on its lock/,
  },
  {
    id: 'W1', file: WORKER, tests: [TO],
    from: "    .map((p) => (process.platform === 'win32' ? p : -p))\n    .filter(targetAlive);",
    to: '    .filter(targetAlive);',
    why: 'the driver\'s exit signals each group\'s leader alone: what the leader started goes on after the driver is gone',
    killed_by: /signals every group it is given, its descendants included/,
  },
  {
    id: 'O9', file: OFFLOOP, tests: [TO],
    from: "export const KILLED_AT_INTERRUPT = Object.freeze(['observe', 'fetchBaseline', 'reportLanding']);",
    to: 'export const KILLED_AT_INTERRUPT = Object.freeze([]);',
    why: 'an interrupt waits on a look, a fetch or the landing report in flight for the whole bound instead of killing it',
    killed_by: /stops a look, a fetch and the landing report in flight at once/,
  },
  {
    id: 'O10', file: OFFLOOP, tests: [TO],
    from: '    const left = Math.max(0, interruptedAt + boundMs - Date.now());',
    to: '    const left = boundMs;',
    why: 'the bound counts from each task\'s start, not from the interrupt: tasks started one after another extend the interrupt without end',
    killed_by: /stops a look, a fetch and the landing report in flight at once/,
  },

  // ---- S: the scheduler, end to end ------------------------------------------
  {
    id: 'S1', file: SCHED, tests: [TS],
    from: "    if (!draining) {\n      draining = hh;",
    to: "    if (!draining && !hh.subtaskId) {\n      draining = hh;",
    why: "a halt in one lane does not drain the run: the other lane goes on starting steps",
    killed_by: /a halt in one lane drains the run/,
  },
  {
    id: 'S2', file: SCHED, tests: [TS],
    from: "      if (draining) {\n        if (inflight.size > 0) { await nextEvent(); continue; }\n        return await end('halted', draining);",
    to: "      if (draining) {\n        return await end('halted', draining);",
    why: "a drain ends the run with a step still in flight, never verified or recorded",
    killed_by: /a halt in one lane drains the run/,
  },
  {
    id: 'S3', file: SCHED, tests: [TS],
    from: "    for (const e of inflight.values()) if (running(e)) e.worker?.abort('interrupted');\n    tasks.interrupt();",
    to: "    tasks.interrupt();",
    why: "SIGTERM during a drain waits for the steps in flight instead of aborting them",
    killed_by: /SIGTERM during a drain aborts the step still in flight/,
  },
  {
    id: 'S4', file: SCHED, tests: [TS],
    from: "    if (r.wait) return { stop: true, why: r.why };",
    to: "    if (r.wait) return { halt: asHalt({ reason: 'budget', detail: r.why }) };",
    why: "a start blocked only by other steps' reservations halts the run as exhausted instead of waiting",
    killed_by: /waits for them to settle, then runs/,
  },
  {
    id: 'S5', file: SCHED, tests: [TS],
    from: GATE,
    to: '  const gate = () => ({ start: true });',
    why: "a new lane starts into a throttled five-hour window",
    killed_by: /a five-hour window at 0\.85 or more starts no new lane/,
  },
  {
    id: 'S6', file: SCHED, tests: [TS],
    from: "      if (r.waitUntilSec) {\n        armReset(r.waitUntilSec);\n        await nextEvent();\n        continue;\n      }\n",
    to: "",
    why: "throttled with nothing running, the run halts idle instead of waiting for the reset",
    killed_by: /waits for the reset, then starts the new lane/,
  },
  {
    id: 'S7', file: SCHED, tests: [TS],
    from: "    if (judgeThrottle(throttle, nowSec).state !== was) wake();",
    to: "",
    why: "a rate-limit event that opens the throttle wakes nothing: a second lane waits for the first lane's step to end",
    killed_by: /progress independently, each in its own worktree/,
  },
  {
    id: 'S8', file: SCHED, tests: [TS],
    from: GATE,
    to: GATE.replace('inFlight: inflight.size', 'inFlight: 0'),
    why: "before the first rate-limit event a new lane starts beside a worker in flight",
    killed_by: /before the first rate-limit event a new lane starts only while no worker is in flight/,
  },
  {
    id: 'S9', file: SCHED, tests: [TS],
    from: "      for (const l of [c.macroLock, inLane ? held.lock : c.driverLock]) entry.groups.push(l.addWorkerGroup(group));",
    to: "      for (const l of [c.macroLock, c.driverLock]) entry.groups.push(l.addWorkerGroup(group));",
    why: "a lane's worker group is recorded in the driver checkout's lock, not in the lock of the lane it runs in",
    killed_by: /progress independently, each in its own worktree/,
  },
  {
    id: 'S10', file: SCHED, tests: [TS],
    from: "    if (DONE_KINDS.has(s.kind) && lanes.has(id) && !c.interrupted()) await retire(id);",
    to: "",
    why: "a lane outlives its subtask's done",
    killed_by: /progress independently, each in its own worktree/,
  },
  {
    id: 'S11', file: SCHED, tests: [TS],
    from: "      forced = f.forced;",
    to: "      forced = new Map();",
    why: "--lane A --next is ignored: A's judgment halt drains the run again",
    killed_by: /--lane A --next replaces only A's judgment halt/,
  },
  {
    id: 'S12', file: DRIVER, tests: [TS],
    from: "    : serialRefusal({ repoRoot, macroId, view, env });",
    to: "    : [];",
    why: "a serial run starts beside a lane that holds an unfinished subtask",
    killed_by: /a serial run refuses beside the waiting lane/,
  },
  {
    id: 'S13', file: LEDGER, tests: [TS],
    from: "  if (Number.isInteger(lanes) && lanes >= 2) args.push(`--lanes ${lanes}`);",
    to: "",
    why: "the relaunch command drops the run's lanes, so the relaunch is serial and refuses",
    killed_by: /progress independently, each in its own worktree/,
  },
  {
    id: 'S14', file: CLI, tests: [TS],
    from: "      waits_for_rate_limit_event: st.newLane === true && result.first_wave.length > 0,",
    to: "      waits_for_rate_limit_event: false,",
    why: "the preview shows a new lane starting at once beside a worker in flight, before the first rate-limit event",
    killed_by: /shows the reconciliation plan and the first wave/,
  },
  {
    id: 'S15', file: ROOTS, tests: [TS],
    from: "    if (r.status !== 0 || report?.schema !== STATE_ROOT_REPORT || !Array.isArray(report?.read_set)) {",
    to: "    if (false) {",
    why: "a pinned engineer without state-root passes the lanes capability floor",
    killed_by: /the capability floor runs state-root/,
  },
  {
    id: 'S16', file: DRIVER, tests: [TS],
    from: "      ? lanesRequirements({ checkout: repoRoot, stateRoot, macroPath: view.macro.path, view })",
    to: "      ? []",
    why: "a run with lanes starts while shared creation is off",
    killed_by: /refuses to start, and records no run, while shared creation is off/,
  },
  {
    id: 'S17', file: CLI, tests: [TC],
    from: "  if (pendingLane !== null) throw new UsageError(`--lane ${pendingLane} needs a --next after it`);\n  if (pairs.length > 0) {",
    to: "  if (pairs.length > 0) {",
    why: "a --lane with no --next after it is dropped silently: the owner's forced step never runs",
    killed_by: /reads --lanes, and --lane <subtask> --next/,
  },
  {
    id: 'S18', file: SCHED, tests: [TS],
    from: "  const mustYield = () => c.interrupted() || draining || ended.length > 0;",
    to: "  const mustYield = () => c.interrupted() || draining;",
    why: "a step that ended while another lane's admission awaited is settled only after that lane spawns",
    killed_by: /a step that ended while another lane's admission awaited is settled first/,
  },
  {
    id: 'S19', file: SCHED, tests: [TS],
    from: "    if (after.lookError) {",
    to: "    if (false) {",
    why: "a failed look after a step passes as progress: the step is never verified",
    killed_by: /a look that fails after a step halts the run unverified/,
  },
  {
    id: 'S20', file: SCHED, tests: [TS],
    from: "      c.keepOpenRecord();\n",
    to: "",
    why: "a run whose look after a step failed removes its open-run record: that step's peers are never cancelled",
    killed_by: /a look that fails after a step halts the run unverified/,
  },
  {
    id: 'S21', file: SCHED, tests: [TS],
    from: "      if (before.git.head !== f.tip) {",
    to: "      if (false) {",
    why: "a prepared lane cut from an old baseline is dispatched into",
    killed_by: /a prepared lane's dispatch is checked against the baseline/,
  },
  {
    id: 'S22', file: SCHED, tests: [TLS],
    from: '        stepBudgetUsd: reservation.usd, stepTimeoutSec: timeoutSec, model, effort,',
    to: '        stepBudgetUsd: options.stepBudgetUsd, stepTimeoutSec: timeoutSec, model, effort,',
    why: 'a worker started beside another may spend the whole per-step cap, past what the run cap leaves after the other\'s reservation',
    killed_by: /two steps in flight hold two reservations/,
  },
  {
    id: 'S23', file: SCHED, tests: [TS],
    from: '    if (d && halts.length > 1) d = { ...d, also:',
    to: '    if (false) d = { ...d, also:',
    why: 'a second lane\'s halt met during the drain is missing from halt.json',
    killed_by: /simultaneous halts/,
  },
  {
    id: 'S24', file: SCHED, tests: [TS],
    from: "    if (r.exhausted) return { halt: asHalt({ reason: 'budget', detail: r.detail }) };",
    to: '    if (r.exhausted) return { stop: true };',
    why: 'an exhausted step cap ends the run as if nothing were dispatchable, not as a budget halt',
    killed_by: /a step cap held by a step in flight/,
  },
  {
    id: 'S25', file: DRIVER, tests: [TS],
    from: '    if (lanes >= 2) {\n      // With lanes the report runs in a child',
    to: '    if (lanes >= 1) {\n      // With lanes the report runs in a child',
    why: '--lanes 1 runs the scheduler, in lanes, instead of the serial driver in the driven checkout',
    killed_by: /--lanes 1 is the serial driver/,
  },
  {
    id: 'S26', file: SCHED, tests: [TLS],
    from: '    const refreshable = d.laneHalts.length > 0\n      ? d.laneSteps.some((x) => x.forced && !x.newLane)\n      : d.laneSteps.some((x) => !x.newLane) || d.driverStep !== null;',
    to: '    const refreshable = false;',
    why: 'a forced new lane that is throttled halts the run budget while a started lane still has a runnable step',
    killed_by: /a forced new lane that is throttled waits while a started lane has a runnable step/,
  },
  {
    id: 'S27', file: SCHED, tests: [TLS],
    from: '    if (s.newLane) {\n      const g = gate();\n      if (!g.start) { noteThrottle(g.why); return refuse(null); }\n    }',
    to: "    if (s.newLane && judgeThrottle(throttle, now() / 1000).state === 'throttled') return refuse(null);",
    why: 'a five-hour part that expires while a new lane is admitted (unknown) lets it spawn beside a worker in flight',
    killed_by: /a five-hour part that expires while a new lane is admitted/,
  },
  {
    id: 'S28', file: SCHED, tests: [TLS],
    from: '      const made = created.error\n        ? { ok: false, failed: true,',
    to: '      if (created.error) throw new Error(created.error);\n      const made = false\n        ? { ok: false, failed: true,',
    why: 'a lane whose creation fails aborts every worker in flight and ends the run as an error, instead of draining',
    killed_by: /a lane whose creation fails is that lane's halt/,
  },
  {
    id: 'S29', file: SCHED, tests: [TLS],
    from: "      const created = await task('createLane', { home, checkout: repoRoot, macroId, subtask, view, baseline, runId, runDir, nowMs: now() });",
    to: "      const created = { value: (await import('./offloop.mjs')).TASKS.createLane({ home, checkout: repoRoot, macroId, subtask, view, baseline, runId, runDir, nowMs: now() }, env) };",
    why: 'a lane is created on the scheduler\'s event loop: no worker in flight is supervised (its timeout, a signal) until the creation ends',
    killed_by: /a lane's creation runs off the loop/,
  },
  {
    id: 'S30', file: POLICY, tests: [TLS],
    from: TERMINAL,
    to: '  if (macro.fm?.terminal_marker === true) {',
    why: 'a look while the last done runs halts the run on the terminal marker that done wrote before its Stop hook archives the macro',
    killed_by: /the macro's terminal marker the last done writes/,
  },
  {
    id: 'S31', file: SCHED, tests: [TLS],
    from: '      if ((view.macroLookupError || view.readyError) && driverBusy()) { await nextEvent(); continue; }\n',
    to: '',
    why: 'a look that meets the last done\'s Stop hook moving the macro to the archive halts the run on a macro lookup error',
    killed_by: /a macro lookup that fails while the last done runs/,
  },
  {
    id: 'S32', file: SCHED, tests: [TLS],
    from: '      if (open.length || unlisted) c.keepOpenRecord();\n',
    to: '      if (unlisted) c.keepOpenRecord();\n',
    why: 'a peer run the run could not cancel after a failed step is forgotten: the run removes its open-run record, so no later cleanup finds that peer',
    killed_by: /a pending peer run the run could not cancel after a failed step keeps the run's open-run record/,
  },
  // S33 (a lane this run created and did not use, dispatched into later from
  // an old baseline) is gone with its case: such a lane is removed at once
  // (S35), and `!createdNow` now differs from `state === 'prepared'` in no
  // state a run reaches.
  {
    id: 'S34', file: SCHED, tests: [TLS],
    from: "    const r = removed.error ? { outcome: 'kept', why: `its removal failed (${removed.error})` } : removed.value;",
    to: '    const r = removed.value;',
    why: 'a lane whose removal fails after its done ends the run as an error instead of being kept',
    killed_by: /a lane whose removal fails after its done is kept/,
  },
  {
    id: 'S35', file: SCHED, tests: [TLS],
    from: '      if (!r.admitted && s.subtaskId && unused.has(s.subtaskId) && !c.interrupted()) await removeUnused(s.subtaskId);\n',
    to: '',
    why: 'an admission that gives way after creating its lane leaves the lane on disk without its step (Decision 5)',
    killed_by: /a five-hour part that expires while a new lane is admitted/,
  },
  {
    id: 'S36', file: SCHED, tests: [TLS],
    from: '      if (open.length || unlisted) c.keepOpenRecord();\n',
    to: '      if (open.length) c.keepOpenRecord();\n',
    why: 'after a failed step, a look that could not list the step\'s peers finds none, and the run removes its open-run record: no later cleanup finds them',
    killed_by: /a look that cannot read the macro cannot list the step's peers/,
  },
  {
    id: 'S37', file: SCHED, tests: [TLS],
    from: '    tasks.interrupt();\n',
    to: '',
    why: 'an interrupt does not reach the tasks in flight: Ctrl-C waits for a look\'s network bound',
    killed_by: /SIGTERM with a look in flight stops the look at once/,
  },
  {
    id: 'S38', file: SCHED, tests: [TLS],
    from: '      for (const l of [c.macroLock, lock]) added.push(l.addWorkerGroup({ ...group, lane: laneId, cwd: at }));',
    to: '      for (const l of [c.macroLock]) added.push(l.addWorkerGroup({ ...group, lane: laneId, cwd: at }));',
    why: 'a task\'s group is not on the lock of the checkout it acts in: a dead driver\'s task runs on while another run or session drives that checkout',
    killed_by: /SIGTERM with a look in flight stops the look at once/,
  },
  {
    id: 'S43', file: SCHED, tests: [TLS],
    from: '      for (const l of [c.macroLock, lock]) added.push(l.addWorkerGroup({ ...group, lane: laneId, cwd: at }));',
    to: '      for (const l of [lock]) added.push(l.addWorkerGroup({ ...group, lane: laneId, cwd: at }));',
    why: 'a task\'s group is not on the macro lock: a dead driver\'s task runs beside the next run\'s cleanup and reconciliation',
    killed_by: /SIGTERM with a look in flight stops the look at once/,
  },
  {
    id: 'S44', file: SCHED, tests: [TLS],
    from: "[...[...inflight.values()].filter((e) => running(e) || e.w.groupTeardown === 'lingering').map((e) => e.worker?.pid), ...tasks.groups()]",
    to: '[...[...inflight.values()].map((e) => e.worker?.pid), ...tasks.groups()]',
    why: 'the driver\'s exit signals the group id of a worker whose group its host has emptied, which may be another process\'s group by then',
    killed_by: /the driver's exit targets a worker still in flight, and neither/,
  },
  {
    id: 'S39', file: SCHED, tests: [TLS],
    from: '      if (!r.admitted && s.subtaskId && unused.has(s.subtaskId) && !c.interrupted()) await removeUnused(s.subtaskId);',
    to: '      if (!r.admitted && s.subtaskId && unused.has(s.subtaskId)) await removeUnused(s.subtaskId);',
    why: 'a removal starts after the interrupt: the interrupted run removes the lane its creation just made instead of keeping it',
    killed_by: /SIGHUP with a lane's creation under way/,
  },
  {
    id: 'S40', file: DRIVER, tests: [TLS],
    from: "  signals.on('SIGHUP', onSignal);\n",
    to: '',
    why: 'a closed terminal does not interrupt the run: a SIGHUP kills the driver and leaves its groups to run on',
    killed_by: /SIGHUP with a lane's creation under way/,
  },
  {
    id: 'S41', file: DRIVER, tests: [TLS],
    from: '    (deps.terminateGroupsSync ?? terminateGroupsSync)([...(Number.isInteger(current?.pid) ? [current.pid] : []), ...groupsInFlight()]);',
    to: '    (deps.terminateGroupsSync ?? terminateGroupsSync)(Number.isInteger(current?.pid) ? [current.pid] : []);',
    why: 'an exit that did not unwind the run leaves its lanes\' workers and tasks running',
    killed_by: /the driver's exit with a task in flight empties the task's group/,
  },
  {
    id: 'S42', file: OFFLOOP, tests: [TLS],
    from: "export const KILLED_AT_INTERRUPT = Object.freeze(['observe', 'fetchBaseline', 'reportLanding']);",
    to: "export const KILLED_AT_INTERRUPT = Object.freeze(['observe', 'fetchBaseline', 'reportLanding', 'createLane']);",
    why: 'an interrupt kills a lane\'s creation part way, leaving a worktree with no identity for the next run to judge',
    killed_by: /SIGHUP with a lane's creation under way/,
  },
  {
    id: 'S45', file: SCHED, tests: [TLS],
    from: "    for (const e of inflight.values()) if (running(e)) e.worker?.abort('interrupted');",
    to: "    for (const e of inflight.values()) e.worker?.abort('interrupted');",
    why: 'an interrupt signals the group id of a worker whose group its host has emptied, which may be another process\'s group by then',
    killed_by: /the driver's exit targets a worker still in flight, and neither the exit nor an interrupt/,
  },
  {
    id: 'S46', file: SCHED, tests: [TLS],
    from: '  if (!child || LISTED_CHILD.has(child.location)) return view;',
    to: '  if (!child) return view;',
    why: 'a workflow read in place of the subtask\'s child is a source of the step\'s peer cancellations: a failed step cancels an unrelated workflow\'s peer',
    killed_by: /ownChildOnly:/,
  },
  {
    id: 'P1', file: SCHED, tests: [TLS],
    from: '  if (view.claimsError) return',
    to: '  if (false) return',
    why: 'a look that could not list the claims counts the step\'s peers as listed',
    killed_by: /peersUnlisted:/,
  },
  {
    id: 'P2', file: SCHED, tests: [TLS],
    from: "const LISTED_CHILD = new Set(['active', 'archived', 'unrecorded']);",
    to: "const LISTED_CHILD = new Set(['active', 'archived', 'unrecorded', 'missing', 'linkage-mismatch']);",
    why: 'a look that finds the subtask\'s recorded child in no home the run reads, or another workflow in its place, counts the step\'s peers as listed',
    killed_by: /peersUnlisted:/,
  },
  {
    id: 'P3', file: SCHED, tests: [TLS],
    from: '  if (child && !LISTED_CHILD.has(child.location)) {',
    to: '  if (false) {',
    why: 'a look that could not read the subtask\'s child counts the step\'s peers as listed',
    killed_by: /peersUnlisted:/,
  },
];
