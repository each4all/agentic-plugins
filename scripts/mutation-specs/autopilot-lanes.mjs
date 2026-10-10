// Mutation spec — do the lane-layer tests catch the defects they exist for?
// (ADR-0067 Decision 5, and the Locks and Peer cancellation bullets of
// Decision 6)
//
// Run: npm run mutate -- scripts/mutation-specs/autopilot-lanes.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. Until the scheduler (DL) calls it, the lane
// layer runs only in its tests, and every defect in it is a quiet one there
// too: a lane cut from a stale baseline, a foreign branch reused, a removal
// that deletes a record or a worktree it cannot prove its own, an intent closed
// while the lane is unlocked, a group entry that lets a second run start beside
// a dead driver's surviving worker. Each mutation below breaks one rule and
// names the test that must notice.
//
// Groups: P placement and identity, C creation, R removal, F the rollback
// fence, K reconciliation rows, S where a step runs, L the worker groups in
// the locks, X peer cancellation, D the dead-run cleanup (Decision 6, Locks:
// open-run records, a dead run's peers and budget, stop and the next run).

const T = 'tests/orchestrator/test-autopilot-lanes.mjs';
const TD = 'tests/orchestrator/test-autopilot-driver.mjs';
const TDR = 'tests/orchestrator/test-autopilot-dead-runs.mjs';

const AP = 'plugins/orchestrator/adapters/claude/autopilot';
const LANES = `${AP}/lanes.mjs`;
const CLI = `${AP}/cli.mjs`;
const DRIVER = `${AP}/driver.mjs`;
const DEAD = `${AP}/dead-runs.mjs`;
const LOCKS = 'plugins/orchestrator/scripts/lib/run-locks.mjs';

export const TESTS = [T, TDR];

export const MUTATIONS = [
  // ---- P: placement and identity ------------------------------------------
  {
    id: 'P1', file: LANES, tests: [T],
    from: '  const mainRoot = real(path.dirname(common));',
    to: '  const mainRoot = real(checkout);',
    why: 'lanes are named from the launching checkout (…-autopilot-lanes), not the repository',
    killed_by: /places lanes by the repository's identity/,
  },
  {
    id: 'P2', file: LANES, tests: [T],
    from: "  if (path.basename(common) !== '.git') {",
    to: '  if (false) {',
    why: 'a repository with no shared root (a git dir not named .git) is not told apart',
    killed_by: /refuses a repository whose git common dir is not named \.git/,
  },
  {
    id: 'P3', file: LANES, tests: [T],
    from: "    else if (r.event === 'done' || r.event === 'kept') open.delete(key);",
    to: "    else if (r.event === 'done') open.delete(key);",
    why: 'a kept removal stays open, and a later run finishes a removal the check refused',
    killed_by: /closes a removal intent only by a later done or kept record/,
  },

  // ---- C: creation --------------------------------------------------------
  {
    id: 'C1', file: LANES, tests: [T],
    from: "  const f = git(checkout, ['fetch', '--quiet', '--no-tags', '--refmap=', 'origin', `+refs/heads/${baseline}:${ref}`], { env, timeout: FETCH_TIMEOUT_MS });",
    to: "  const f = { code: 0, stderr: '' };",
    why: 'a lane is cut from the last fetched baseline, which may lack a landed predecessor (ADR-0062 Decision 2)',
    killed_by: /cuts an absent branch from the freshly fetched baseline/,
  },
  {
    id: 'C2', file: LANES, tests: [T],
    from: "      if (facts.baseTip !== null && b.tip === facts.baseTip) return { row: 12, action: 'existing-branch' };",
    to: "      return { row: 12, action: 'existing-branch' };",
    why: 'a foreign existing branch is reused, carrying history the baseline lacks',
    killed_by: /attaches to an existing branch at the baseline, and refuses one that is not/,
  },
  {
    id: 'C3', file: LANES, tests: [T],
    from: '  if (tip.code !== 0 || !tip.stdout) {',
    to: '  if (false) {',
    why: 'a missing baseline ref is not a halt: the creation goes on without a base',
    killed_by: /uses the last fetched baseline with a warning when the fetch fails, and halts when there is none/,
  },
  {
    id: 'C4', file: LANES, tests: [T],
    from: '  if (added.code !== 0) {',
    to: '  if (false) {',
    why: 'a failed worktree add is taken for a lane, and an identity is written into a directory that is not one',
    killed_by: /halts with git's reason when the add fails, and never forces it/,
  },

  // ---- R: removal ---------------------------------------------------------
  {
    id: 'R1', file: LANES, tests: [T],
    from: "  appendIntent(mainRoot, macroId, { event: 'done', ...base, at: at() });",
    to: '',
    why: 'a finished removal leaves its intent open',
    killed_by: /removes a clean lane of its own, keeps the branch, and closes the intent/,
  },
  {
    id: 'R2', file: LANES, tests: [T],
    from: '      if (names.length > 0) {',
    to: '      if (false) {',
    why: 'a shared record in the lane is deleted with it (git worktree remove deletes ignored files)',
    killed_by: /keeps a dirty lane, and one holding a shared record, still locked/,
  },
  {
    id: 'R3', file: LANES, tests: [T],
    from: '  if (!w.locked || w.lockReason !== reason) return',
    to: '  if (false) return',
    why: 'a worktree locked by someone else, or not at all, is handled as the run\'s',
    killed_by: /never touches a worktree it cannot prove its own/,
  },
  {
    id: 'R4', file: LANES, tests: [T],
    from: '  const again = removalCheck(lane, { env });\n  if (!again.ok) return keep(again.why, { unlocked: true });',
    to: '',
    why: 'no second check after the unlock: a record written since the first is lost to the remove',
    killed_by: /checks again after the unlock/,
  },
  {
    id: 'R5', file: LANES, tests: [T],
    from: '      if (again.code !== 0) {',
    to: '      if (false) {',
    why: 'an intent is closed while its lane stays unlocked: the last proof of ownership is gone',
    killed_by: /leaves the removal intent open when the lane cannot be locked again/,
  },
  {
    id: 'R6', file: LANES, tests: [T],
    from: '  if (kept) return keepLocked(kept);',
    to: '',
    why: 'the driver removes the lane that holds its own checkout or ledger (ADR-0067 Decision 2)',
    killed_by: /never removes a lane holding the driver's checkout, its run directory or the state root/,
  },
  {
    id: 'R7', file: LANES, tests: [T],
    from: '  const moved = changedSince({ mainRoot, lane, laneId, reason, unlocked: true, env });',
    to: '  const moved = null;',
    why: 'the remove acts on what was judged before the unlock: a worktree that replaced the lane at its path is removed with its ignored files',
    killed_by: /reads the lane again before the remove/,
  },
  {
    id: 'R8', file: LANES, tests: [T],
    from: '  if (await laneLockHeld(lane, ownLaneLock)) return keep(',
    to: '  if (false) return keep(',
    why: 'a session that joined the lane\'s worktree lock after the unlock loses its checkout',
    killed_by: /keeps a lane a run or a session joined after the unlock/,
  },
  {
    id: 'R9', file: LANES, tests: [T],
    from: '  if (changed) return { code: 1, stderr: `it is no longer the lane ${laneId}: ${changed}` };',
    to: '',
    why: 'a worktree that replaced an unlocked lane is locked with the run\'s reason, its intent closed, and a later run may remove it',
    killed_by: [/locks a crashed removal again only while the worktree there is the lane its intent names/, /reads the lane again before the remove/],
  },
  {
    id: 'R10', file: LANES, tests: [T],
    from: "  if (!intentWritten) {\n    appendIntent(mainRoot, macroId, { event: 'intent', ...base, at: at() });\n    const u = git(mainRoot, ['worktree', 'unlock', lane], { env });\n    if (u.code !== 0) {",
    to: "  {\n    if (!intentWritten) appendIntent(mainRoot, macroId, { event: 'intent', ...base, at: at() });\n    const u = git(mainRoot, ['worktree', 'unlock', lane], { env });\n    if (u.code !== 0 && !/is not locked/.test(u.stderr)) {",
    why: 'row 9 unlocks again and reads git\'s English message: under a translated git it closes the intent while the lane stays unlocked',
    killed_by: /a git that speaks another language changes nothing/,
  },
  {
    id: 'R11', file: LANES, tests: [T],
    from: '  if (await laneLockHeld(lane, ownLaneLock)) return keepLocked(',
    to: '  if (false) return keepLocked(',
    why: 'a lane another run or a session holds is unlocked and announced for removal',
    killed_by: /keeps a lane whose worktree lock another run or session holds/,
  },
  {
    id: 'R12', file: LANES, tests: [T],
    from: '  const changed = changedSince({ mainRoot, lane, laneId, reason, unlocked: intentWritten, env });',
    to: '  const changed = null;',
    why: 'a lane whose identity changed after it was judged is unlocked and announced for removal',
    killed_by: /leaves a lane whose identity changed after it was judged as it is/,
  },
  {
    id: 'R13', file: LANES, tests: [T],
    from: '      return keep(`git worktree unlock refused: ${u.stderr}`, { unlocked: !locked });',
    to: '      return keep(`git worktree unlock refused: ${u.stderr}`, { unlocked: false });',
    why: 'an unlock git reports failed but did is taken as refused: the intent is closed while the lane stays unlocked',
    killed_by: /after an unlock git reports failed, asks git whether the lane is locked/,
  },

  // ---- F: the rollback fence ----------------------------------------------
  {
    id: 'F1', file: LANES, tests: [T],
    from: '  fs.renameSync(tmp, sw.path);',
    to: '  fs.rmSync(tmp);',
    why: 'lanes_first_run_at is never recorded, so the cutover can be rolled back over lanes\' workflows',
    killed_by: /records lanes_first_run_at before the first lane/,
  },
  {
    id: 'F2', file: LANES, tests: [T],
    from: "  if (sw.state !== 'on') throw",
    to: '  if (false) throw',
    why: 'a lane is created while shared creation is off',
    killed_by: /creates no lane while shared creation is off/,
  },

  // ---- K: reconciliation rows ---------------------------------------------
  {
    id: 'K1', file: LANES, tests: [T],
    from: "    if (l.present && l.identity.state === 'absent') plan.prepass.push({ kind: 'assign-identity', lane: l });",
    to: '',
    why: 'a lane created before its identity was written is adopted without one, so no later removal can prove it',
    killed_by: /adopts a lane whose creation succeeded before its ledger write/,
  },
  {
    id: 'K2', file: LANES, tests: [T],
    from: '  if (b.heldBy !== null && !heldByOurLane) {',
    to: '  if (false) {',
    why: 'a branch checked out in another worktree is given a lane git will refuse (row 11)',
    killed_by: /halts on a subtask whose branch is checked out in a worktree that is not one of its lanes/,
  },
  {
    id: 'K3', file: LANES, tests: [T],
    from: '    readiness: subtaskReadiness(subtasks),',
    to: "    readiness: subtasks.map((s) => ({ id: s?.id, ready: s?.status === 'pending' })),",
    why: 'a subtask waiting on a predecessor is given a lane',
    killed_by: /judges readiness from the plan/,
  },
  {
    id: 'K4', file: LANES, tests: [T],
    from: '    if (b.tip !== null) {',
    to: '    if (false) {',
    why: 'an existing branch is cut again from the baseline instead of judged (row 12)',
    killed_by: /reuses an existing unclaimed branch only at the baseline/,
  },
  {
    id: 'K5', file: LANES, tests: [T],
    from: '      if (facts.baseTip !== null && l.head === facts.baseTip) {',
    to: '      if (true) {',
    why: 'a prepared lane is dispatched into after the baseline moved (row 4)',
    killed_by: /keeps a prepared lane while it is at the baseline, and halts once the baseline moved/,
  },
  {
    id: 'K6', file: LANES, tests: [T],
    from: '    if (l.branch !== s.branch) {',
    to: '    if (false) {',
    why: 'a lane on a branch the plan no longer gives its subtask is adopted (row 3)',
    killed_by: /halts on a lane whose branch the plan changed/,
  },
  {
    id: 'K7', file: LANES, tests: [T],
    from: "    if (!listed.has(real(i.path))) plan.prepass.push({ kind: 'intent-done', intent: i });",
    to: '',
    why: 'a removal that finished before a crash stays an open intent forever',
    killed_by: /finishes a cleanup interrupted after done/,
  },
  {
    id: 'K8', file: LANES, tests: [T],
    from: "    if (s.status === 'completed' && l.removal?.ok === true) {",
    to: "    if (s.status === 'completed') {",
    why: 'a completed lane that fails the removal check is sent to removal instead of kept and reported (row 8)',
    killed_by: /keeps a completed lane that fails the removal check/,
  },
  {
    id: 'K9', file: LANES, tests: [T],
    from: '    if (!l.present) {',
    to: '    if (false) {',
    why: 'a lane whose directory is gone is adopted instead of reported with the owner\'s commands (row 1)',
    killed_by: /halts on a lane whose directory is gone without pruning it/,
  },
  {
    id: 'K10', file: LANES, tests: [T],
    from: '  if (facts.claimsError) {',
    to: '  if (false) {',
    why: 'a look that could not list the claims judges every subtask unclaimed',
    killed_by: /judges readiness from the plan: .* a look that could not list the claims halts/,
  },
  {
    id: 'K11', file: LANES, tests: [T],
    from: '    if (await laneLockHeld(p, null)) return { ok: false, why:',
    to: '    if (false) return { ok: false, why:',
    why: 'row 7 sends a completed lane another run or a session holds to removal',
    killed_by: /keeps a lane whose worktree lock another run or session holds/,
  },
  {
    id: 'K12', file: LANES, tests: [T],
    from: '    if (claims.length > 0) {',
    to: '    if (false) {',
    why: 'a pending subtask a workflow already claims is given a lane and dispatched a second time',
    killed_by: /halts on a pending subtask an engineer workflow already claims while it has no lane/,
  },

  // ---- S: where a step runs -----------------------------------------------
  {
    id: 'S1', file: LANES, tests: [T],
    from: "const DRIVER_STEPS = new Set(['done', 'done-no-commit', 'finalize']);",
    to: 'const DRIVER_STEPS = new Set([]);',
    why: 'done and finalize run in a lane, which is removed once its subtask lands',
    killed_by: /runs dispatch, verbs and commit in the lane with the default state root/,
  },
  {
    id: 'S2', file: LANES, tests: [T],
    from: '  ].filter(outside);',
    to: '  ].filter(() => false);',
    why: 'a claiming workflow kept in another checkout\'s own home passes, and the lane\'s worker never finds it',
    killed_by: /every claiming workflow under the default state root/,
  },
  {
    id: 'S3', file: LANES, tests: [T],
    from: '  return acquireLock(worktreeLockPath(lane.path ?? lane), { record, now });',
    to: '  return acquireLock(worktreeLockPath(lane.path ?? lane), { record: {}, now });',
    why: 'the lane\'s lock does not carry the run\'s token digest, so its own worker is refused admission',
    killed_by: /admits its worker in the lane/,
  },
  {
    id: 'S4', file: LANES, tests: [T],
    from: "  const outside = (p) => typeof p === 'string' && p !== '' && !homes.some((h) => within(p, h));",
    to: "  const outside = (p) => typeof p === 'string' && p !== '' && !within(p, home.mainRoot);",
    why: 'a claiming workflow in a nested worktree\'s own home under the main worktree passes, and no lane reads it',
    killed_by: /every claiming workflow under the default state root/,
  },

  // ---- L: worker groups in the locks --------------------------------------
  {
    id: 'L1', file: LOCKS, tests: [T],
    from: '          writeWhole(lock, group, { ...base, worker });',
    to: '          writeWhole(lock, group, { ...base, worker: null });',
    why: 'a group entry does not name its group: a dead driver\'s surviving workers no longer hold the lock',
    killed_by: /a dead driver with two surviving groups keeps the macro lock live/,
  },
  {
    id: 'L2', file: LOCKS, tests: [T],
    from: '          if (!fs.existsSync(mine)) throw',
    to: '          if (false) throw',
    why: 'a group entry added after the release holds the lock for a group no run accounts for',
    killed_by: /adds a group entry only while the run holds the lock/,
  },
  {
    id: 'L3', file: CLI, tests: [T],
    from: '    for (const w of provable) {',
    to: '    for (const w of provable.slice(0, 1)) {',
    why: 'stop empties one of a dead driver\'s groups and reports success while the other runs on',
    killed_by: /status shows both and stop empties both/,
  },
  {
    id: 'L4', file: CLI, tests: [T],
    from: "      ? (driverAlive || groups.length === 0 ? 'running' :",
    to: "      ? (true ? 'running' :",
    why: 'status calls a run with a dead driver running, and does not say that stop empties its groups',
    killed_by: /status shows both and stop empties both/,
  },

  // ---- X: peer cancellation -----------------------------------------------
  {
    id: 'X1', file: DRIVER, tests: [TD],
    from: '    if (c?.originating_subtask !== subtaskId) continue;',
    to: '',
    why: 'a killed step cancels another lane\'s peer run (ADR-0067 Decision 6, Peer cancellation)',
    killed_by: /leaves another lane's pending run alone/,
  },
  {
    id: 'X2', file: DRIVER, tests: [TD],
    from: '  for (const id of view?.children?.[subtaskId]?.pending_runs ?? []) ids.add(id);',
    to: '  for (const c of Object.values(view?.children ?? {})) for (const id of c?.pending_runs ?? []) ids.add(id);',
    why: 'a killed step cancels the peer run of another subtask\'s in-progress child',
    killed_by: /takes a step's new pending runs from its own subtask's in-progress child and claims/,
  },

  // ---- D: the dead-run cleanup --------------------------------------------
  {
    id: 'D1', file: DEAD, tests: [TDR],
    from: '      if (names === runId) {',
    to: '      if (names === runId || !names) {',
    why: 'the cleanup cancels a peer that names no run — the owner\'s, or an older runner\'s it can only report',
    killed_by: /cancels only the peers that name the dead run/,
  },
  {
    id: 'D2', file: DEAD, tests: [TDR],
    from: '    if (Number.isFinite(started) && Number.isFinite(since) && started < since) continue;',
    to: '',
    why: 'a peer started before the unfinished step is reported as that step\'s',
    killed_by: /cancels only the peers that name the dead run/,
  },
  {
    id: 'D3', file: DEAD, tests: [TDR],
    from: '    if (link.parent_workflow === macroId && link.originating_subtask === s.subtask_id) return s;',
    to: '    if (link.parent_workflow === macroId) return s;',
    why: 'a peer on another subtask\'s workflow is reported as the unfinished step\'s',
    killed_by: /cancels only the peers that name the dead run/,
  },
  {
    id: 'D4', file: DEAD, tests: [TDR],
    from: '      if (accounted ? accounted.has(s.seq) : s.seq <= steps) continue;',
    to: '',
    why: 'a second cleaner meeting the record counts the step again',
    killed_by: [/cancels only the peers that name the dead run/, /counts what run\.json missed/, /settles each step once by its seq/],
  },
  {
    id: 'D5', file: DEAD, tests: [TDR],
    from: '    for (const s of strict.steps) {',
    to: '    for (const s of unfinished) {',
    why: 'a finished step whose charge the dead driver never wrote to run.json is lost from the run\'s cost',
    killed_by: /counts what run\.json missed/,
  },
  {
    id: 'D6', file: DEAD, tests: [TDR],
    from: '    if (complete) removeOpenRun(mainRoot, runId);',
    to: '    removeOpenRun(mainRoot, runId);',
    why: 'the record goes while a peer that names the run may still run, and nothing looks for it again',
    killed_by: /keeps one whose peer could not be cancelled/,
  },
  {
    id: 'D7', file: DEAD, tests: [TDR],
    from: "    if (complete && (run.status === 'running' || run.status === 'draining')) {",
    to: "    if (run.status === 'running' || run.status === 'draining') {",
    why: 'a run is reported stopped before its cleanup finished',
    killed_by: /keeps one whose peer could not be cancelled/,
  },
  {
    id: 'D8', file: DEAD, tests: [TDR],
    from: '  if (await holderAlive({ pid: record.pid, fingerprint: record.fingerprint, worker: null }, { probe })) {',
    to: '  if (false) {',
    why: 'a live driver\'s run is cleaned up after: its record removed and its run recorded halted while it runs',
    killed_by: /leaves a run whose driver or worker group still runs/,
  },
  {
    id: 'D9', file: DEAD, tests: [TDR],
    from: '  if (await liveEntry(record, mainRoot, probe)) {',
    to: '  if (false) {',
    why: 'a dead driver\'s run is cleaned up while a worker group of it still runs',
    killed_by: /leaves a run whose driver or worker group still runs/,
  },
  {
    id: 'D10', file: DEAD, tests: [TDR],
    from: '    if (!r || real(r.dir) !== real(record.run_dir)) {',
    to: '    if (false) {',
    why: 'a record whose ledger is gone is not reported as such for the owner',
    killed_by: /keeps a record whose ledger is gone/,
  },
  {
    id: 'D11', file: DEAD, tests: [TDR],
    from: "    if (e instanceof LockHeldError) return { run_id: runId, outcome: 'busy'",
    to: "    if (false) return { run_id: runId, outcome: 'busy'",
    why: 'a cleaner meeting another one at the same record fails instead of leaving it to them',
    killed_by: /keeps one whose peer could not be cancelled/,
  },
  {
    id: 'D12', file: DEAD, tests: [TDR],
    from: '    if (strict.error) {',
    to: '    if (false) {',
    why: 'a step log that does not read is taken for one with no unfinished step',
    killed_by: /keeps a run whose step log does not read/,
  },
  {
    id: 'D13', file: DRIVER, tests: [TDR],
    from: '    if (macroId) {\n      const dead = await cleanupDeadRuns({',
    to: '    if (false) {\n      const dead = await cleanupDeadRuns({',
    why: 'a run starts beside a dead run\'s peers and never cleans up after it',
    killed_by: /the next run of the macro cleans up after it before its first step/,
  },
  {
    id: 'D14', file: DRIVER, tests: [TDR],
    from: '    writeOpenRun(mainRoot, {',
    to: '    ((...a) => a)(mainRoot, {',
    why: 'a run spawns with no open-run record, so its death leaves nothing that finds it',
    killed_by: [/stop cancels the peer/, /the next run of the macro cleans up after it/],
  },
  {
    id: 'D15', file: DRIVER, tests: [TD],
    from: '    if (!lingering && !keepRecord) {\n      try {\n        removeOpenRun(mainRoot, runId);',
    to: '    if (false) {\n      try {\n        removeOpenRun(mainRoot, runId);',
    why: 'a run that ended leaves its record, and every later run and stop judges it again',
    killed_by: /dispatch → commit → awaiting-landing/,
  },
  {
    id: 'D16', file: DRIVER, tests: [TD],
    from: '    if (!lingering && !keepRecord) {\n      try {\n        removeOpenRun(mainRoot, runId);',
    to: '    if (!keepRecord) {\n      try {\n        removeOpenRun(mainRoot, runId);',
    why: 'a run whose group outlived SIGKILL removes its record while that group runs',
    killed_by: /halts the run, which keeps its lock entries until the group is empty/,
  },
  {
    id: 'D17', file: DRIVER, tests: [TD],
    from: "      if (w?.groupTeardown === 'lingering') lingering = true;\n      current = null;",
    to: '      current = null;',
    why: 'an error mid-step releases the entries that name a group still running',
    killed_by: /tears the step down before it releases anything/,
  },
  {
    id: 'D18', file: CLI, tests: [TDR],
    from: '    return (await cleanUp(o.macro)).code;',
    to: '    return 0;',
    why: 'stop finds no live run and leaves a dead run\'s peers and record as they are',
    killed_by: /stop cancels the peer/,
  },
  {
    id: 'D19', file: CLI, tests: [T],
    from: '    const { results, code } = await cleanUp(holder.macro_id ?? o.macro, holder.run_id);',
    to: '    const { results, code } = { results: [], code: 0 };',
    why: 'stop empties a dead driver\'s groups and reports, without cleaning up after the run',
    killed_by: /status shows both and stop empties both/,
  },
  {
    id: 'D20', file: CLI, tests: [TDR],
    from: "    const unfinished = results.some((r) => r.outcome === 'kept' || r.outcome === 'busy');",
    to: '    const unfinished = false;',
    why: 'stop exits 0 while a record is kept for the owner',
    killed_by: /keeps one whose peer could not be cancelled/,
  },
  {
    id: 'D21', file: CLI, tests: [TDR],
    from: "      if (left === null) { out('it stopped; its halt is recorded as interrupted'); return 0; }",
    to: "      { out('it stopped; its halt is recorded as interrupted'); return 0; }",
    why: 'a driver that died on the SIGTERM is reported stopped, with no halt and its peers left',
    killed_by: /stop sees its record left behind/,
  },
  {
    id: 'D22', file: CLI, tests: [TDR],
    from: '  if (c) {',
    to: '  if (false) {',
    why: 'status does not say who cleaned up after a dead run, nor what it cancelled',
    killed_by: /stop cancels the peer/,
  },
  {
    id: 'D23', file: DEAD, tests: [TDR],
    from: "        if (err.code === 'ENOENT') continue;\n        key = path.resolve(dir);",
    to: '        continue;\n        key = path.resolve(dir);',
    why: 'a peer-run home that cannot be read (EACCES, EIO) is taken for one with no peers, and the record goes unexamined',
    killed_by: /keeps the record when a peer-run home cannot be resolved/,
  },
  {
    id: 'D24', file: CLI, tests: [TDR],
    from: "    const running = results.filter((r) => r.outcome === 'live' && (target === null || r.run_id === target));",
    to: '    const running = [];',
    why: 'stop exits 0 while the run it stopped still runs (a live driver it could not prove)',
    killed_by: /exits 1 when the run it stops still runs/,
  },
  {
    id: 'D25', file: CLI, tests: [TDR],
    from: '    const live = await liveEntriesOf(holder.run_id);',
    to: '    const live = []; for (const h of entries) if (await holderAlive(h)) live.push(h);',
    why: 'stop waits on the entries it listed before the SIGTERM, and misses a group registered after',
    killed_by: /reads the run's entries again while it waits/,
  },
  {
    id: 'D26', file: CLI, tests: [TDR],
    from: '    if (!(await holderAlive({ pid: holder.pid, fingerprint: holder.fingerprint, worker: null }))) {',
    to: '    if (false) {',
    why: 'stop waits on a group whose driver died, which nothing will empty',
    killed_by: /reads the run's entries again while it waits/,
  },
  {
    id: 'D27', file: CLI, tests: [TDR],
    from: "    const running = results.filter((r) => r.outcome === 'live' && (target === null || r.run_id === target));",
    to: "    const running = results.filter((r) => r.outcome === 'live' && target !== null && r.run_id === target);",
    why: 'stop finds no run in the locks and exits 0 beside the record of a live one',
    killed_by: /exits 1 when it finds no run in the locks but the record of a live one/,
  },
  {
    id: 'D28', file: CLI, tests: [TDR],
    from: '    if (code === 0 && (await liveEntriesOf(holder.run_id)).length > 0) {',
    to: '    if (false) {',
    why: 'stop empties a dead-looking driver\'s groups and exits 0 while the driver, alive but unprovable and with no record, runs on',
    killed_by: /exits 1 when the run it stops still runs/,
  },
];
