// Mutation spec — do the lane gate's tests catch the defects they exist for?
// (ADR-0068 Decision 1: an owner gate stops only its lane)
//
// Run: npm run mutate -- scripts/mutation-specs/autopilot-lane-gate.mjs
//
// Each defect below is quiet: a lane halt that drains the whole run again, a
// run-wide cause that parks one lane, a park lost to a relaunch or a crash, a
// step retried on its unchanged record, a parked lane never picked up while
// the run lives, or picked up mid-resolution. Each mutation breaks one rule
// and names the test that must notice.
//
// Groups: L the scope of a halt and the park's fingerprint (policy.mjs), K the
// kept parks (parks.mjs, whose lock is run-locks.mjs's, with its own spec)
// and the release, S the lane gate end to end
// (scheduler.mjs against the fake claude: each runs for minutes). The cases of
// the drain, the throttle and the rest of the scheduler stay in
// autopilot-scheduler.mjs.

const TP = 'tests/orchestrator/test-autopilot-policy.mjs';
const TK = 'tests/orchestrator/test-autopilot-parks.mjs';
const TC = 'tests/orchestrator/test-autopilot-cli.mjs';
const TG = 'tests/orchestrator/test-autopilot-scheduler-lane-gate.mjs';
const TE = 'tests/orchestrator/test-autopilot-scheduler-lane-ends.mjs';

const AP = 'plugins/orchestrator/adapters/claude/autopilot';
const POLICY = `${AP}/policy.mjs`;
const PARKS = `${AP}/parks.mjs`;
const SCHED = `${AP}/scheduler.mjs`;
const LANES = `${AP}/lanes.mjs`;
const DRIVER = `${AP}/driver.mjs`;
const CLI = `${AP}/cli.mjs`;

export const TESTS = [TP, TK, TC, TG, TE];

export const MUTATIONS = [
  // ADR-0068 Decision 1, item 1: the scope of a halt.
  {
    id: 'L12', file: POLICY, tests: [TP],
    from: "export const RUN_WIDE_REASONS = Object.freeze(['version-drift', 'budget', 'plan-unapproved']);",
    to: 'export const RUN_WIDE_REASONS = Object.freeze([]);',
    why: 'an invalidated approval, an exhausted budget or version drift that names a lane parks that lane instead of draining the run',
    killed_by: /the closed run-wide list wins over the code and over a subtask the halt names/,
  },
  {
    id: 'L13', file: POLICY, tests: [TP],
    from: "export const RUN_WIDE_REASONS = Object.freeze(['version-drift', 'budget', 'plan-unapproved']);",
    to: "export const RUN_WIDE_REASONS = Object.freeze(['budget', 'plan-unapproved']);",
    why: 'version drift reported for one lane (a worker that loaded other plugins) parks that lane, and the run goes on with mixed code',
    killed_by: /the closed run-wide list wins over the code and over a subtask the halt names/,
  },
  {
    id: 'L14', file: POLICY, tests: [TP],
    from: '  const unnamed = problems.find((p) => p.subtaskId === null);',
    to: '  const unnamed = problems[0];',
    why: 'a claim problem that names one subtask of the plan drains the whole run, as before ADR-0068',
    killed_by: /a pending subtask claimed by its new child is not a claim problem then/,
  },
  {
    id: 'L15', file: POLICY, tests: [TP],
    from: '    if (!r.ready || away(r.id) || halted.has(r.id)) continue;',
    to: '    if (!r.ready || away(r.id)) continue;',
    why: 'a pending subtask halted on its claim in this decision is also dispatched in it, beside the workflow that claims it',
    killed_by: /a pending subtask claimed by its new child is not a claim problem then/,
  },
  {
    id: 'L16', file: POLICY, tests: [TP],
    from: '  const away = (id) => inFlight.has(id) || parked.has(id);',
    to: '  const away = (id) => inFlight.has(id);',
    why: 'a parked lane is judged at every decision: its gate parks it again and again, and a pending one is dispatched',
    killed_by: /a parked lane is left out as a lane in flight is/,
  },
  {
    id: 'L17', file: POLICY, tests: [TP],
    from: "(ps -g ${w.pgid ?? '<pgid>'})`, { scope: 'run' });",
    to: "(ps -g ${w.pgid ?? '<pgid>'})`);",
    why: 'a worker group that outlived SIGKILL parks its lane, and the run starts more beside a process it cannot stop',
    killed_by: /verifyStep marks a lingering group and an unread macro run-wide/,
  },
  {
    id: 'L18', file: POLICY, tests: [TP],
    from: "  if (record?.fingerprint_version !== PARK_FINGERPRINT_VERSION) return 'incomparable';\n",
    to: '',
    why: 'a park kept by another fingerprint version counts as changed: an upgrade between runs picks up every parked lane on its unchanged record',
    killed_by: /never counts a record of another fingerprint version/,
  },
  {
    id: 'L19', file: POLICY, tests: [TP],
    from: "  if (form === 'lane') return laneFingerprint(view, subtaskId);",
    to: "  if (form === 'lane') return laneFingerprint(view, subtaskId, { withoutPeers: true });",
    why: 'a park\'s fingerprint leaves out the peer bookkeeping: a lane parked on a pending ensemble is never picked up once the ensemble is settled',
    killed_by: /a pending peer ensemble settled included, in either form/,
  },
  {
    id: 'L19b', file: POLICY, tests: [TP],
    from: "  return laneFingerprint({ ...view, git: { branch, head: branchTip, porcelain: 'no worktree' } }, subtaskId);",
    to: "  return laneFingerprint({ ...view, git: { branch, head: branchTip, porcelain: 'no worktree' } }, subtaskId, { withoutPeers: true });",
    why: 'a lane with no worktree parked on a pending ensemble is never picked up once the ensemble is settled',
    killed_by: /a pending peer ensemble settled included, in either form/,
  },
  {
    id: 'L21', file: POLICY, tests: [TP],
    from: "export const RUN_WIDE_REASONS = Object.freeze(['version-drift', 'budget', 'plan-unapproved']);",
    to: "export const RUN_WIDE_REASONS = Object.freeze(['version-drift', 'plan-unapproved']);",
    why: 'an exhausted budget reported for one lane parks that lane, and the run goes on spending',
    killed_by: /the closed run-wide list wins over the code and over a subtask the halt names/,
  },
  {
    id: 'L22', file: POLICY, tests: [TP],
    from: "export const RUN_WIDE_REASONS = Object.freeze(['version-drift', 'budget', 'plan-unapproved']);",
    to: "export const RUN_WIDE_REASONS = Object.freeze(['version-drift', 'budget']);",
    why: 'an approval that no longer holds, reported for one lane, parks that lane, and the other lanes go on under a plan nobody approved',
    killed_by: /the closed run-wide list wins over the code and over a subtask the halt names/,
  },

  // ---- S: the lane gate, end to end ----------------------------------------
  {
    id: 'S69', file: SCHED, tests: [TG],
    from: "    if (haltScope(hh, lastGlobal) === 'lane') return park(hh, hint, facts);",
    to: '    if (false) return park(hh, hint, facts);',
    why: 'a lane\'s gate drains the whole run, as before ADR-0068: the other lane completes nothing more',
    killed_by: /a lane's gate parks that lane while the other completes/,
  },
  {
    id: 'S70', file: SCHED, tests: [TE],
    from: "    if (id && (inLane || DONE_KINDS.has(s.kind))) await mark(id, 'in-flight', { seq: seq + 1, step_kind: s.kind });\n",
    to: '',
    why: 'no marker names a lane step before its spawn: a driver killed before the verdict leaves a relaunch that dispatches the lane again on its unchanged record',
    killed_by: /a driver killed during a later step of a lane that already exists/,
  },
  {
    id: 'S71', file: SCHED, tests: [TE],
    from: "    if (outcome === 'ok' || outcome === 'interrupted'",
    to: "    if (outcome === null || outcome === 'ok' || outcome === 'interrupted'",
    why: 'a marker whose step has no verdict is taken as settled: the relaunch dispatches the lane again',
    killed_by: /a driver killed between a failed step's end and its verdict/,
  },
  {
    id: 'S72', file: SCHED, tests: [TG],
    from: '      if ((s.judged === null || d !== s.judged) && t - s.at >= quietMs) { candidates.add(id); found = true; }',
    to: '',
    why: 'the tick never makes a parked lane whose record changed a candidate: a gate the owner clears while other lanes run is seen only once they end',
    killed_by: /picked up again, while the other lane is mid-step/,
  },
  {
    id: 'S73', file: SCHED, tests: [TE],
    from: '      if (await reconsider(true)) continue;\n',
    to: '',
    why: 'the run ends with a lane parked whose record changed with no wake-up: the end takes no fingerprint again',
    killed_by: /the end's last pass picks up/,
  },
  {
    id: 'S74', file: LANES, tests: [TE],
    from: "  if (!fetched.ok) return { ok: false, halt: { ...fetched.halt, scope: 'run' } };",
    to: '  if (!fetched.ok) return { ok: false, halt: fetched.halt };',
    why: 'a baseline that cannot be fetched inside a creation parks that lane, and is kept, though it is the run\'s footing',
    killed_by: /a baseline fetch failing inside a lane's creation drains the run and keeps no park/,
  },
  {
    id: 'S75', file: SCHED, tests: [TG],
    from: '      if (r.halt) { await halted(r.halt, null, view); return !draining && !c.interrupted(); }',
    to: '      if (r.halt) { await halted(r.halt, null, view); return false; }',
    why: 'a refusal that parks its lane ends the admission wave: the other lane does not start',
    killed_by: /a creation refused before any worker starts parks that lane/,
  },
  {
    id: 'S76', file: SCHED, tests: [TG],
    from: "      if (cmp === 'changed') {",
    to: '      if (true) {',
    why: 'a relaunch picks up every kept park whatever its record: a worker that could not spawn is retried on its unchanged record',
    killed_by: /a worker that could not spawn parks its lane, is not retried/,
  },
  {
    id: 'S77', file: SCHED, tests: [TG],
    from: "        if (cur.state === 'absent' || (cur.state === 'ok' && cur.record.record_id !== rec.record_id)) {\n          candidates.add(id);",
    to: '        if (false) {\n          candidates.add(id);',
    why: 'a bare release while the run lives wakes nothing: the lane waits for the run\'s end',
    killed_by: /a bare release while the run lives/,
  },
  {
    id: 'S78', file: SCHED, tests: [TG],
    from: '    if (inLane && laneBusy(id, view)) {\n      busy.add(id);\n      return { ...refuse(null), again: false, busy: true };\n    }\n    let createdNow = false;',
    to: '    let createdNow = false;',
    why: 'a lane is created for a step whose lane has a persona operation open, then removed unused',
    killed_by: /a lane laneBusy holds is neither created nor stepped/,
  },
  {
    id: 'S79', file: DRIVER, tests: [TE],
    from: '    if (open.length > 0) {\n      problems.push(`macro ${macroId} keeps',
    to: '    if (false) {\n      problems.push(`macro ${macroId} keeps',
    why: 'a serial run starts beside a kept park, and drives the parked lane\'s subtask in the shared checkout',
    killed_by: /a serial run does not start beside a kept park/,
  },
  {
    id: 'S81', file: SCHED, tests: [TE],
    from: "  const unreadable = (v, id) => !v || Boolean(v.lookError || v.macroLookupError) || !v.macro || v.children?.[id]?.location === 'error';",
    to: '  const unreadable = (v) => !v || Boolean(v.lookError);',
    why: 'a look that could not read the macro counts as the owner\'s change: a relaunch retries a failed step on its unchanged record',
    killed_by: /a relaunch whose look of a parked lane cannot read the macro keeps the park/,
  },
  {
    id: 'S82', file: SCHED, tests: [TG],
    from: '    const usable = facts && !unreadable(facts, id) ? facts : null;',
    to: '    const usable = null;',
    why: 'a park takes its fingerprint from a look after its halt: a gate cleared meanwhile is folded into the park, and the lane is never picked up',
    killed_by: /a gate the owner clears while the park is recorded picks the lane up/,
  },
  {
    id: 'L23', file: POLICY, tests: [TP],
    from: '  if (macro.fm?.awaiting_owner_gate) {\n    return runHalt(gateReason(macro.fm.awaiting_owner_gate)',
    to: '  if (false) {\n    return runHalt(gateReason(macro.fm.awaiting_owner_gate)',
    why: 'a gate on the macro does not stop a run with lanes: its lanes go on beside the owner\'s decision on the plan',
    killed_by: /approval, macro gates and the terminal marker stay run-wide/,
  },
  {
    id: 'S83', file: POLICY, tests: [TE],
    from: "  if (!(approval?.status === 'approved' && approval?.hash_ok === true)) {\n    const state = !approval",
    to: '  if (false) {\n    const state = !approval',
    why: 'a plan pending approval again, with its gate, is judged only by the gate: the drain names the gate, not the approval that no longer holds',
    killed_by: /plan-unapproved: the run drains whatever is parked/,
  },
  {
    id: 'S84', file: SCHED, tests: [TG],
    from: '    seen.set(id, { digest: d, at: now(), judged, base: judged ?? d });',
    to: '    seen.set(id, { digest: d, at: now(), judged: d, base: d });',
    why: 'a park counts its digest read after the decision\'s look as judged: a gate cleared between them never wakes the lane while other lanes run',
    killed_by: /a gate cleared between the decision's look and the park's own look/,
  },
  {
    id: 'S89', file: SCHED, tests: [TG],
    from: "        if (compareKept(rec, fp) === 'changed') why = 'its record changed';\n      }",
    to: "        if (compareKept(rec, fp) === 'changed') why = 'its record changed';\n        else if (s) s.judged = s.digest;\n      }",
    why: 'a lane judged unchanged takes as judged a digest a tick read during the judging look: a gate cleared then never wakes it',
    killed_by: /a gate cleared after the judging look read the lane/,
  },
  {
    id: 'S85', file: SCHED, tests: [TG],
    from: "    if (p && existsSync(p)) {\n      const r = await task('reconcileLane'",
    to: "    if (!lanes.has(id) && p && existsSync(p)) {\n      const r = await task('reconcileLane'",
    why: 'a lane the run holds is picked up again without its rows: it is stepped in a worktree that is no longer provably the run\'s',
    killed_by: /whose ownership lock the owner removed while it was parked/,
  },
  {
    id: 'S86', file: SCHED, tests: [TG],
    from: '    if (inLane && laneBusy(id, before)) {\n      busy.add(id);\n      return { ...refuse(null), again: false, busy: true };\n    }\n',
    to: '',
    why: 'a persona operation that writes the lane\'s record while its admission awaits is not asked about again: the worker spawns beside it',
    killed_by: /a write to the lane's record during its admission holds the spawn/,
  },
  {
    id: 'S87', file: SCHED, tests: [TG],
    from: '  const laneBusy = c.laneBusy ?? ((id, view) => childWrittenOutside(id, view));',
    to: '  const laneBusy = c.laneBusy ?? (() => false);',
    why: 'no lane is ever busy outside a test: a worker spawns into a lane whose record the owner is still writing',
    killed_by: /a write to the lane's record during its admission holds the spawn/,
  },
  {
    id: 'S88', file: SCHED, tests: [TE],
    from: "    } else if (after.lookError && w.groupTeardown !== 'lingering') {",
    to: '    } else if (after.lookError) {',
    why: 'a worker group that outlived SIGKILL whose look then failed parks its lane, and the run starts more beside a process it cannot stop',
    killed_by: /a lingering group whose lane look fails drains the run/,
  },
  {
    id: 'S90', file: SCHED, tests: [TE],
    from: "        if (compareKept(rec, fp) === 'changed') why = 'its record changed';\n      }",
    to: "        if (compareKept(rec, fp) === 'changed') why = 'its record changed';\n        else if (s && fp.unread) s.judged = null;\n      }",
    why: 'a park whose fingerprint cannot be read, which only a release resumes, is judged again at every tick: the run never reaches its end',
    killed_by: /a park whose cause lies outside its record waits for a release only/,
  },
  {
    id: 'S92', file: SCHED, tests: [TG],
    from: '      await mark(id, \'creating\', { step_kind: s.kind });\n      if (mustYield() || (s.newLane && !gate().start)) return refuse(null);\n',
    to: '      await mark(id, \'creating\', { step_kind: s.kind });\n',
    why: 'what changed while the creation\'s marker awaited its lock is not asked: an interrupt then still creates a lane',
    killed_by: /an interrupt while a lane's creation marker waits for its lock creates no lane/,
  },
  {
    // The order before the fix: the marker awaited after every check, and
    // followed only by the yield check.
    id: 'S93', tests: [TG],
    prepare: (copy, tools) => {
      tools.applyEdit(copy, {
        file: SCHED,
        from: "    if (id && (inLane || DONE_KINDS.has(s.kind))) await mark(id, 'in-flight', { seq: seq + 1, step_kind: s.kind });\n    const drift = await driftNow();",
        to: '    const drift = await driftNow();',
      });
      tools.applyEdit(copy, {
        file: SCHED,
        from: '      return { ...refuse(null), again: false, busy: true };\n    }\n    // The whole per-step timeout',
        to: "      return { ...refuse(null), again: false, busy: true };\n    }\n    if (id && (inLane || DONE_KINDS.has(s.kind))) {\n      await mark(id, 'in-flight', { seq: seq + 1, step_kind: s.kind });\n      if (mustYield()) return refuse(null);\n    }\n    // The whole per-step timeout",
      });
    },
    why: 'the step\'s marker is awaited after the admission\'s checks: a write to the lane\'s record while it awaits its lock is not asked about, and the worker spawns beside it',
    killed_by: /a write to the lane's record while the step's marker waits for its lock holds the spawn/,
  },
  {
    id: 'S94', file: SCHED, tests: [TG],
    from: '      watch(id, fp.fresh ? before : null);',
    to: '      watch(id, before);',
    why: 'a relaunch takes a kept park of a lane with no worktree as judged at a digest read after its cached facts: a gate cleared between them never wakes the lane while other lanes run',
    killed_by: /a relaunch's kept park of a lane with no worktree wakes for a change after the facts it was judged from/,
  },
  {
    id: 'S91', file: SCHED, tests: [TE],
    from: "        if (compareKept(rec, fp) === 'changed') why = 'its record changed';\n      }",
    to: "        if (compareKept(rec, fp) === 'changed') why = 'its record changed';\n        else if (s && fp.unread) s.judged = null;\n      }",
    why: 'a parked lane whose judging look cannot be read is asked again at every tick: the run never reaches its end',
    killed_by: /but whose looks now fail, is not asked again at every tick/,
  },
  {
    id: 'S95', file: SCHED, tests: [TG],
    from: '    if (mustYield()) return refuse(null);\n    if (s.newLane) {',
    to: '    if (c.interrupted() || draining) return refuse(null);\n    if (s.newLane) {',
    why: 'a step that ended while the admission\'s marker awaited its lock is not settled first: a worker spawns beside a group that outlived SIGKILL',
    killed_by: /ending while another step's marker waits for its lock, lets nothing start beside it/,
  },
  {
    id: 'S97', file: SCHED, tests: [TG],
    from: '    let found = busy.size > 0;\n    if (found) busyDue = true;',
    to: '    let found = busy.size > 0;\n    busy.clear();',
    why: 'the tick lets a busy lane go itself: one during the busy refusal\'s marker settlement leaves nothing to retry the lane, and the run ends beside it',
    killed_by: /a tick while a busy refusal settles its marker does not lose the lane's retry/,
  },
  {
    id: 'S98', file: SCHED, tests: [TG],
    from: '      if (mustYield() || (s.newLane && !gate().start)) return refuse(null);\n      if (laneBusy(id, view)) {\n        busy.add(id);\n        return { ...refuse(null), again: false, busy: true };\n      }\n',
    to: '      if (mustYield() || (s.newLane && !gate().start)) return refuse(null);\n',
    why: 'a write to the lane\'s record while its creation\'s marker awaits its lock is not asked about: the lane is created beside the owner\'s operation',
    killed_by: /while its creation's marker waits for its lock holds the creation/,
  },
  {
    id: 'S96', file: SCHED, tests: [TG],
    from: '    await parkOps;\n    return c.finish(',
    to: '    return c.finish(',
    why: 'the run returns, and its locks go, before the park changes it queued are done: a settled marker outlives the run',
    killed_by: /the run returns only once the park changes it queued are done/,
  },
  {
    id: 'L20', file: POLICY, tests: [TP],
    from: "    out.laneHalts.push(halt('owner-choice', p.detail, { subtaskId: p.subtaskId, releaseOnly: true, claim: true }));",
    to: "    out.laneHalts.push(halt('owner-choice', p.detail, { subtaskId: p.subtaskId }));",
    why: 'a claim problem\'s park resumes on a change of the lane\'s own record though its cause, the claiming workflow, lies outside it',
    killed_by: /a pending subtask claimed by its new child is not a claim problem then/,
  },
  {
    id: 'K5', file: PARKS, tests: [TK],
    from: '      if (!(err instanceof LockHeldError)) throw err;\n',
    to: '',
    why: 'a lock that cannot be read or taken is retried as if a live holder held it: every write spins until the wait ends, then blames a holder',
    killed_by: /what is not a lock fails the writer at once/,
  },
  {
    id: 'K7', file: PARKS, tests: [TK],
    from: '      if (Date.now() >= deadline) throw new Error(',
    to: '      if (true) throw new Error(',
    why: 'a writer that meets a live holder fails at once: a release, or the run\'s own park, fails whenever another process is writing',
    killed_by: /a live holder is waited for until it lets go/,
  },
  {
    id: 'K8', file: PARKS, tests: [TK],
    from: "      if (cur.state !== 'unreadable' || cur.digest !== expectDigest) return { ok: false, current: cur };\n",
    to: '',
    why: 'a release of a record that cannot be read deletes whatever is there by then, a newer record included',
    killed_by: /a release ends only the bytes it read/,
  },
  {
    id: 'K6', file: CLI, tests: [TC],
    from: "  const read = cur.state === 'ok' ? { expect: cur.record.record_id } : { expectDigest: cur.digest ?? null };",
    to: "  const read = cur.state === 'ok' ? { expect: cur.record.record_id } : {};",
    why: 'a release of an unreadable record, across its read of the live run, deletes the marker a forced relaunch wrote meanwhile',
    killed_by: /release of a record that cannot be read ends only the bytes it read/,
  },
  {
    id: 'K1', file: PARKS, tests: [TK],
    from: '    if (idOf(cur) !== expect) return { ok: false, current: cur };\n    const file = parkPath',
    to: '    const file = parkPath',
    why: 'a park write ignores the record its writer last read: a run recreates a park the owner released',
    killed_by: /every change is conditional on the record id its writer last read/,
  },
  {
    id: 'K2', file: PARKS, tests: [TK],
    from: '    } else if (expect !== undefined && idOf(cur) !== expect) return { ok: false, current: cur };',
    to: '    }',
    why: 'a release, or a run\'s settlement, deletes a park newer than the one it read',
    killed_by: /every change is conditional on the record id its writer last read/,
  },
  {
    id: 'K3', file: PARKS, tests: [TK],
    from: "    return !s || s.status === 'completed';",
    to: '    return !s;',
    why: 'a park of a subtask recorded completed never retires: a serial run refuses beside it forever',
    killed_by: /retire once their subtask completed/,
  },
  {
    id: 'K4', file: CLI, tests: [TC],
    from: '  if (isAutopilotRun(env)) {\n    err(`✗ AGENTIC_AUTOPILOT=${env.AGENTIC_AUTOPILOT}: a step of an autopilot run never releases a lane',
    to: '  if (false) {\n    err(`✗ AGENTIC_AUTOPILOT=${env.AGENTIC_AUTOPILOT}: a step of an autopilot run never releases a lane',
    why: 'a worker of a run releases a lane, its own included',
    killed_by: /release ends a kept park/,
  },
];
