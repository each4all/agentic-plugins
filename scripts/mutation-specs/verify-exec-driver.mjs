// Mutation spec — the verify-exec defects of the driver and the policy
// (ADR-0068 Decision 5, items 2, 9 and 10). The runner's, the declaration
// copy's and the wrapper's are verify-exec.mjs's.
//
// Run: npm run mutate -- scripts/mutation-specs/verify-exec-driver.mjs
//
// A separate spec because a spec that anchors a file selects every test it
// lists for a change to that file (verify-select R6): the driver's and the
// policy's own tests are the ones a change to either needs, not the runner's.

const T_DRV = 'tests/orchestrator/test-autopilot-verify-driver.mjs';
const T_REF = 'tests/orchestrator/test-autopilot-verify-refusal.mjs';
const T_LANES = 'tests/orchestrator/test-autopilot-verify-lanes.mjs';
const T_POL = 'tests/orchestrator/test-autopilot-policy.mjs';

const AP = 'plugins/orchestrator/adapters/claude/autopilot';

export const TESTS = [T_DRV, T_REF, T_LANES, T_POL];

export const MUTATIONS = [
  {
    id: 'D1', file: `${AP}/driver.mjs`, tests: [T_DRV],
    from: '      run.steps = budget.taken;',
    to: '      run.steps = seq;',
    why: 'a batch is counted as a worker step of the run',
    killed_by: /batches cost nothing and are no worker step/,
  },
  {
    id: 'D2', file: `${AP}/driver.mjs`, tests: [T_DRV],
    from: '      const spentOut = budget.exhausted();\n      if (spentOut) return { halt: { reason: \'budget\', detail: spentOut } };',
    to: "      const rr = budget.reserve();\n      if (rr.ok) budget.settle(rr.reservation, { spawned: true, costUsd: null });\n      const spentOut = budget.exhausted();\n      if (spentOut) return { halt: { reason: 'budget', detail: spentOut } };",
    why: 'a batch takes a reservation and is charged its whole budget, and counts against --max-steps',
    killed_by: /batches cost nothing and are no worker step/,
  },
  {
    id: 'D3', file: `${AP}/driver.mjs`, tests: [T_DRV],
    from: '      const spentOut = budget.exhausted();\n      if (spentOut) return { halt: { reason: \'budget\', detail: spentOut } };',
    to: '      const spentOut = null;',
    why: 'an exhausted budget still starts a batch, and the run never ends on its budget',
    killed_by: /the last permitted worker step recording verify starts nothing more/,
  },
  {
    id: 'D4', file: `${AP}/policy.mjs`, tests: [T_DRV],
    from: '      if (vf?.resume && vf.resume.request_id === child.verify?.request_id && VERBS.includes(vf.resume.verb)) {',
    to: '      if (false) {',
    why: 'after a failed batch the requesting verb never resumes: the run loops on a request whose batch has ended',
    killed_by: /dispatch → verify \(fails\) → the verb resumes/,
  },
  {
    id: 'D5', file: `${AP}/policy.mjs`, tests: [T_DRV],
    from: "      if (ns.confidence !== 'HIGH') {\n        return { kind: 'active', judgment: true, halt: halt('low-confidence', `subtask ${id}: ${label}: the requested checks are not run below HIGH`",
    to: "      if (false) {\n        return { kind: 'active', judgment: true, halt: halt('low-confidence', `subtask ${id}: ${label}: the requested checks are not run below HIGH`",
    why: 'a request below HIGH runs its checks, where ADR-0063 D4 halts it low-confidence',
    killed_by: /a request below HIGH halts low-confidence and runs nothing/,
  },
  {
    id: 'D6', file: `${AP}/policy.mjs`, tests: [T_DRV, T_REF],
    from: '      if (verify?.offered !== true) {',
    to: '      if (false) {',
    why: 'a run that does not offer verification steps a verify child, which it cannot run',
    killed_by: [/a run that does not offer it halts run-wide on a verify child/, /a serial run halts owner-choice naming the missing driver support/],
  },
  {
    id: 'D7', file: `${AP}/driver.mjs`, tests: [T_DRV],
    from: '      if (r.lingering) {\n        lingering = true;',
    to: '      if (false) {\n        lingering = true;',
    why: 'a check group that outlived SIGKILL is taken for a result: the run goes on, and lets go of the locks the group still needs',
    killed_by: /halts the run run-wide, and the run keeps its lock entries/,
  },
  // ---- L: a run with lanes ------------------------------------------------------
  {
    id: 'L1', file: `${AP}/scheduler.mjs`, tests: [T_LANES],
    from: '    const room = () => N - inflight.size;',
    to: '    const room = () => N - inflight.size - (verifyActive ? 1 : 0);',
    why: 'a batch takes a worker slot: another lane\'s worker waits for a batch that charges nothing',
    killed_by: /a batch holds no worker slot/,
  },
  {
    id: 'L2', file: `${AP}/scheduler.mjs`, tests: [T_LANES],
    from: '    if (verifyActive || draining || c.interrupted() || verifyQueue.size === 0) return { again: false };',
    to: '    if (draining || c.interrupted() || verifyQueue.size === 0) return { again: false };',
    why: 'two lanes\' batches start at once, and their heavy checks contend',
    killed_by: /two lanes' batches run one at a time, in request order/,
  },
  {
    id: 'L4', file: `${AP}/scheduler.mjs`, tests: [T_LANES],
    from: '    const order = [...verifyQueue.entries()].sort((a, b) => String(a[1].recordedAt).localeCompare(String(b[1].recordedAt))',
    to: '    const order = [...verifyQueue.entries()].sort((a, b) => String(b[1].recordedAt).localeCompare(String(a[1].recordedAt))',
    why: 'the queue runs the request recorded last first: a lane that asked first waits behind every later one',
    killed_by: /two lanes' batches run one at a time, in request order/,
  },
  {
    id: 'L3', file: `${AP}/scheduler.mjs`, tests: [T_LANES],
    from: '        verifyBaseline: offer.offered ? offer.baseline : null,',
    to: '        verifyBaseline: null,',
    why: 'a run with lanes offers verification and never tells its workers',
    killed_by: /two lanes' batches run one at a time/,
  },
  {
    id: 'D10', file: `${AP}/driver.mjs`, tests: [T_DRV],
    from: '        verifyBaseline: offer.offered ? offer.baseline : null,',
    to: '        verifyBaseline: offer.baseline,',
    why: 'a run that offers no verification (no declaration at its baseline) still tells its workers it does: they hand checks to a step it cannot run',
    killed_by: /a repository with no declaration at the run's baseline is not offered verification, and its workers get no offer/,
  },
  {
    id: 'L5', file: `${AP}/scheduler.mjs`, tests: [T_LANES],
    from: "        entry.state = w ? 'waiting' : 'running';",
    to: "        entry.state = 'running';",
    why: 'a batch waiting for the heavy-work lock is shown running: the owner cannot tell a check that waits for another checkout\'s mutation run from one that hangs',
    killed_by: /a lane's check waits for the heavy-work lock another checkout holds, the run showing it waiting with its holder/,
  },
  {
    id: 'L6', file: `${AP}/scheduler.mjs`, tests: [T_LANES],
    from: '    const occupied = inLane ? laneBusy(id, view) : false;',
    to: '    const occupied = inLane && !batch ? laneBusy(id, view) : false;',
    prepare: (copy, { applyEdit }) => {
      applyEdit(copy, { file: `${AP}/scheduler.mjs`, from: '      const occupiedNow = laneBusy(id, view);', to: '      const occupiedNow = !batch && laneBusy(id, view);' });
      applyEdit(copy, { file: `${AP}/scheduler.mjs`, from: '    const occupiedLast = inLane ? laneBusy(id, before) : false;', to: '    const occupiedLast = inLane && !batch ? laneBusy(id, before) : false;' });
    },
    why: 'a batch never asks whether a persona operation is open in its lane: it writes the lane\'s workflow beside another session\'s operation (Decision 1, item 6)',
    killed_by: /a request whose lane was removed gets its lane back, waits out an operation open in it/,
  },
  {
    id: 'L7', file: `${AP}/scheduler.mjs`, tests: [T_LANES],
    from: '    const due = id ? rebindDue(view.macro?.fm, id, { macroPath: view.macro?.path, selected: view.children?.[id]?.workflow_id ?? null }) : null;',
    to: '    const due = id && !batch ? rebindDue(view.macro?.fm, id, { macroPath: view.macro?.path, selected: view.children?.[id]?.workflow_id ?? null }) : null;',
    why: 'a batch passes the boundary an owner\'s rebinding is told at: the child hears the change only after its checks ran on the old words (Decision 8, item 4)',
    killed_by: /a request whose lane was removed gets its lane back, waits out an operation open in it/,
  },
  {
    id: 'L8', file: `${AP}/scheduler.mjs`, tests: [T_LANES],
    from: '      if (gateOf(id) || parked.has(id)) continue;\n      const r = await admit(q.step, q.view);',
    to: '      if (gateOf(id) || parked.has(id)) continue;\n      if (!lanes.get(id)?.lock) continue;\n      const r = await admit(q.step, q.view);',
    why: 'a request whose lane the run does not hold is skipped: a relaunch after the lane was removed never makes it again, and halts with nothing dispatchable',
    killed_by: /a request whose lane was removed gets its lane back/,
  },
  {
    id: 'L9', file: `${AP}/scheduler.mjs`, tests: [T_LANES],
    from: '    } else if (c.interrupted()) {\n      // The owner\'s interrupt is judged before what the step returned',
    to: '    } else if (false) {\n      // The owner\'s interrupt is judged before what the step returned',
    why: 'a batch\'s settle reads the persona write a Ctrl-C failed as the step\'s error, and parks the lane owner-choice: the next run needs a release (Decision 1, item 1)',
    killed_by: /a Ctrl-C during a batch whose persona write it fails ends the run interrupted, and parks no lane/,
  },
  {
    id: 'L12', file: `${AP}/scheduler.mjs`, tests: [T_LANES],
    from: '    const after = await look(entry.cwd, false);\n    let verdict = null;',
    to: '    const interruptedBefore = c.interrupted();\n    const after = await look(entry.cwd, false);\n    let verdict = null;',
    prepare: (copy, { applyEdit }) => {
      applyEdit(copy, { file: `${AP}/scheduler.mjs`, from: '    } else if (c.interrupted()) {\n      // The owner\'s interrupt is judged before what the step returned', to: '    } else if (interruptedBefore) {\n      // The owner\'s interrupt is judged before what the step returned' });
    },
    why: 'a batch\'s settle reads the interrupt before its look: a Ctrl-C that comes while the look awaits finds the verdict taken, and the lane parks owner-choice',
    killed_by: /a Ctrl-C that comes during the look after a batch that failed is judged too/,
  },
  {
    id: 'D11', file: `${AP}/policy.mjs`, tests: [T_DRV],
    from: "  if (cmd === 'verify' && rest.length === 0) return { kind: 'verify' };\n",
    to: '',
    why: '`--next verify`, the rerun the repeat halt names, is refused as no step command: the owner cannot run the checks again',
    killed_by: /`--next verify` runs its checks once more, whole, and the run goes on/,
  },
  {
    id: 'D12', file: `${AP}/policy.mjs`, tests: [T_DRV],
    from: "      return { kind: 'verify', subtaskId: active[0].subtask.id, branch: child.branch ?? active[0].subtask.branch, rerun: true };",
    to: "      return { kind: 'verify', subtaskId: active[0].subtask.id, branch: child.branch ?? active[0].subtask.branch };",
    why: 'a serial run\'s forced verify is no rerun: the repeat rule halts it no-progress again, and the owner\'s rerun does nothing',
    killed_by: /`--next verify` runs its checks once more, whole, and the run goes on/,
  },
  {
    id: 'D13', file: `${AP}/driver.mjs`, tests: [T_DRV],
    from: '        engineerRoot: roots.engineer, offer, verb: child.verb ?? null, forcedRerun: s.forced === true && s.rerun === true,',
    to: '        engineerRoot: roots.engineer, offer, verb: child.verb ?? null, forcedRerun: false,',
    why: 'the serial driver never hands the rerun to the batch: the forced step meets the repeat rule as an automatic one does',
    killed_by: /`--next verify` runs its checks once more, whole, and the run goes on/,
  },
  {
    id: 'L10', file: `${AP}/policy.mjs`, tests: [T_LANES],
    from: "        forced.set(id, { kind: 'verify', subtaskId: id, branch: view.children[id].branch ?? s.branch, rerun: true });",
    to: "        forced.set(id, { kind: 'verify', subtaskId: id, branch: view.children[id].branch ?? s.branch });",
    why: 'a lane\'s forced verify (`--lane A --next verify`) is no rerun: the lane parks no-progress again',
    killed_by: /`--lane A --next verify` runs its checks once more and the lane goes on/,
  },
  {
    id: 'L11', file: `${AP}/scheduler.mjs`, tests: [T_LANES],
    from: '      engineerRoot: roots.engineer, offer, verb: child.verb ?? null, forcedRerun: s.forced === true && s.rerun === true,',
    to: '      engineerRoot: roots.engineer, offer, verb: child.verb ?? null, forcedRerun: false,',
    why: 'the scheduler never hands a lane\'s rerun to its batch: the forced step meets the repeat rule, and the lane parks again',
    killed_by: /`--lane A --next verify` runs its checks once more and the lane goes on/,
  },
  {
    id: 'L13', file: `${AP}/scheduler.mjs`, tests: [T_LANES],
    from: '    // A batch spawns no worker: the lane\'s first worker in this run is still\n    // a new lane\'s, which the throttle gates (`started` is the workers\').\n    unused.delete(id);\n',
    to: '    started.add(id);\n    unused.delete(id);\n',
    why: 'a batch marks its lane started: the lane\'s first worker of the run skips the new-lane throttle',
    killed_by: /a lane whose only step in the run was a batch is still new: its first worker waits for the throttle/,
  },
  {
    id: 'L14', file: `${AP}/scheduler.mjs`, tests: [T_LANES],
    from: "      stopCause: () => (gateOf(id) ? 'hold' : (draining || budget.exhausted()) ? 'drain' : null),",
    to: "      stopCause: () => ((draining || budget.exhausted()) ? 'drain' : null),",
    why: 'a lane\'s batch never reads its hold before its start: the start is asked of the persona, its intent journaled, and only the persona\'s refusal stops it (with the hold protocol off, nothing would)',
    killed_by: /a hold set while a batch is prepared starts none and parks nothing, though withdrawn before the settle/,
  },
  {
    id: 'L15', file: `${AP}/scheduler.mjs`, tests: [T_LANES],
    from: "    } else if (r.outcome === 'error') {\n      verdict = { reason: 'owner-choice', detail: `the verification step of subtask ${id} failed: ${r.detail}`, subtaskId: id };",
    to: "    } else if (r.outcome === 'error' || r.outcome === 'stopped') {\n      verdict = { reason: 'owner-choice', detail: `the verification step of subtask ${id} failed: ${r.detail}`, subtaskId: id };",
    why: 'a batch that yielded to a hold before it started is settled as a failed step: the lane parks owner-choice, and the park outlives the hold',
    killed_by: /a hold set while a batch is prepared starts none and parks nothing, though withdrawn before the settle/,
  },
  {
    id: 'L16', file: `${AP}/scheduler.mjs`, tests: [T_LANES],
    from: "    if (r.outcome === 'stopped' && entry.forcedStep && !forced.has(id)) forced.set(id, entry.forcedStep);\n",
    to: '',
    why: 'a rerun whose batch yielded to a hold before it started is spent: the next batch meets the repeat rule, and the lane parks no-progress',
    killed_by: /a rerun whose batch yields to a hold before it starts is kept/,
  },
  // The runner's (verify-run.mjs): its only test is the lanes run's, where the
  // real persona's refusal reaches it, so it is anchored here.
  {
    id: 'L17', file: `${AP}/verify-run.mjs`, tests: [T_LANES],
    from: "    const cause = seen ?? (HELD_LANE_REFUSAL.test(String(e?.message ?? '')) ? 'hold' : null);\n",
    to: '    const cause = seen;\n',
    why: 'a start the persona refused for a hold withdrawn before the refusal reached the driver is the step\'s failure: the lane parks owner-choice for a hold already gone',
    killed_by: /a hold the persona refused the batch's start for, withdrawn before the refusal reaches the driver, parks nothing either/,
  },
  {
    id: 'L18', file: `${AP}/scheduler.mjs`, tests: [T_LANES],
    from: '      if (r.refusal !== true || gateOf(id) || draining || budget.exhausted()) verifyNoop.delete(id);\n',
    to: '      if (true) verifyNoop.delete(id);\n',
    why: 'a batch that yields to a refusal no hold of the run explains is decided again without end: a free step, no step of --max-steps, loops',
    killed_by: /its second yield in a row parks the lane no-progress: the free step does not loop/,
  },
  {
    id: 'L20', file: `${AP}/scheduler.mjs`, tests: [T_LANES],
    from: '      if (r.refusal !== true || gateOf(id) || draining || budget.exhausted()) verifyNoop.delete(id);\n',
    to: '      if (gateOf(id) || draining || budget.exhausted()) verifyNoop.delete(id);\n',
    why: 'two holds the driver saw while batches were prepared, each withdrawn before its settle, count as unexplained refusals: the second parks the lane no-progress, and the park outlives the holds',
    killed_by: /two holds in a row, each seen while a batch is prepared and withdrawn before its settle, park nothing/,
  },
  {
    id: 'L19', file: `${AP}/verify-run.mjs`, tests: [T_LANES],
    from: '  const viaWrapper = check.locks_itself !== true;\n',
    to: '  const viaWrapper = false;\n',
    why: 'a check runs with no heavy-work lock: lane A\'s suite runs beside the heavy work lane B\'s worker holds the lock for',
    killed_by: /lock contention between two lanes: A's check waits for the heavy-work lock B's worker holds/,
  },
  {
    id: 'D14', file: `${AP}/driver.mjs`, tests: [T_DRV],
    from: "      } else if (r.outcome === 'stopped') {\n        // A serial run reads no hold",
    to: "      } else if (false) {\n        // A serial run reads no hold",
    why: 'a serial run decides a batch the persona refused as a held lane\'s again, and again: the free step loops with no bound',
    killed_by: /a serial run halts owner-choice on the batch that yielded, rather than decide it again without end/,
  },
  {
    id: 'D8', file: `${AP}/cli.mjs`, tests: [T_DRV],
    from: "    if (s.kind === 'verify') {\n      const b = s.verify?.batch;",
    to: "    if (false) {\n      const b = s.verify?.batch;",
    why: 'status shows a batch as a worker step, with a session it never had and nothing of how it ended',
    killed_by: /dispatch → verify \(fails\) → the verb resumes/,
  },
  {
    id: 'D9', file: `${AP}/policy.mjs`, tests: [T_POL],
    from: '    // The outcome table (ADR-0063 S3+S4 note): a live file in a commit phase\n',
    to: "    if (vf?.guard && ns && child.verify?.answered_by === vf.guard.batch_id && VERBS.includes(vf.guard.verb)) return { kind: 'active', step: { kind: 'verb', verb: vf.guard.verb, subtaskId: id, branch: child.branch, resume: 'verify' } };\n    // The outcome table (ADR-0063 S3+S4 note): a live file in a commit phase\n",
    why: 'the P7 guard is judged before the commit recovery: a commit the on_pass began, which kept the answer and changed the tree, resumes the requesting verb on a half-committed workflow',
    killed_by: /a commit an answered request's on_pass began recovers through \/engineer:commit/,
  },
];
