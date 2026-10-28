// Mutation spec — do the holds tests catch the defects they exist for?
// (ADR-0068 Decision 2, the orchestrator's half: impl-hold)
//
// Run: npm run mutate -- scripts/mutation-specs/impl-hold.mjs
//
// A hold that fails open gives a person's lane to the driver while they work
// in it, and one that fails closed strands a lane no command can name. Each
// mutation breaks one rule and names the test that must notice.
//
// Groups: R the records and their readers (Task 1), F the fence (Task 3), B
// the busy lane and live runs (Task 2), H the handoff and release, D the
// basis and comparison, C the rollout, K the owner's commands, S the
// scheduler, and the review's findings; W the driver's comparison of a
// release and the wake-ups of the hold records (Task 9); L a relaunch with a
// held lane and the run's end (Task 10); N /orchestrator:next's hold gate and
// dispatch mark (Task 11); X every hold's exit: retirement, orphaning, a
// macro's end, abort/finalize's check and the cutover guards (Task 12); Q a
// rebinding's blockers at the approval and the delivery (Task 13; the
// reader's whole removal and an ended hold refusing are orchestrator-rebind's
// A2 and A3); T the takeover acceptance against the released persona, end to
// end through the driver, `hold`, `status` and `release` (Task 14); V the
// seams the whole-change critique found (its refine: a withdrawal over a
// release in force, the lane a hold records, the child a hold set before its
// dispatch compares, the scans that fail closed, a crash's exclusion at a
// macro's end or a move, a plan id that is no hold key, the wave past a held
// refusal, the named hold-back, and the parks at the run's edges); Y the
// seams its re-critique found (the comparison refusing what the release would,
// an archived child that cannot be read, one rule for archived children at the
// dispatch gate, a dispatch whose holds were off at the switch, Phase 5's
// pass, abort's and finalize's record reads, discard's fences and its
// compare-on-release, a held lane's park outside the quiet clock, and the
// order and guards of a withdrawal that restores a release); Z the residues
// of its refine the owner had fixed (a lane's worktree that cannot be looked
// at, at each reader of it; a named archived child looked for in every state
// root; a dispatch check that takes its earlier pass away before any
// discovery that can fail); M the seams its third critique found between the
// holds and the driver's own work (a serial run beside a release awaiting its
// comparison, the finalize preflight under the run's own worker, a run with
// nothing running waiting on an open operation only as long as a step may
// take); G the seams its fourth critique found (the lane a hold on a subtask
// with no worktree records, and takes at its handoff or release, and hold's
// and discard's reads of the plan under the holds lock); P the seams its fifth
// critique found (a serial run beside a rejected release, the Codex close
// skills' archive pass, the release from a person's own worktree, and hold's
// look taken while it waits on a held lock); O the owner's decision on row
// 12 (ADR-0062 Decision 2, amendment of 2026-10-27: a consumed release's
// recorded tip, the baseline as its ancestor, and halts that never advise
// discarding work); U the sixth critique's findings (hold's worktree command
// for a branch not created yet, the engineer's read as the oracle of ours,
// the dispatch on a handed-back tip, the release that waits on the holds
// lock with no timer deciding it, and a no-worktree release's branch tip).
// Left out as
// layered (Y, not measured): the tick's skip of a gated lane's digest, since
// the quiet clock (Y17) and the end's reconsideration (Y18) are what would
// keep the run waiting or look inside the lane; a wake-up alone ends the same.
//
// Left out as equivalent (measured SURVIVED, 2026-10-26): removeFence's check
// that the entry is this hold's fence (the entry's name derives from the hold
// id, so no other hold's fence can stand there), and repairHoldFence's holds
// lock (its guard that skips a pending hold already keeps it off a handoff
// between its fence and its ack; each layer alone holds the test); and the
// scheduler's check that a consumed release ends the park the run keeps for
// its lane (`givenBack`): no path of the driver parks a lane a hold or an
// unconsumed release gates, so the park it keeps is the one the release
// recorded, and the conditional delete by that id (W6) holds the I3 rule;
// the park of a rejection right after its comparison (the next pass's
// rebuild, W3, parks the lane before any decision could step it, so no test
// can tell the two apart). Left out as redundant (measured SURVIVED,
// 2026-10-26): givenBack's own reconciliation of a lane the relaunch passed
// by, which `passedBack` (L9) makes in the same turn. Not proved by a mutation
// (measured SURVIVED, 2026-10-26): the after-run handoff pass ignoring the
// run's own steps in flight, which only a run that stops on an error with a
// step still in flight reaches (the error test stops on a look after its step
// settled). Not proved by a mutation: givenBack's pass of a
// park the records could not take (kept false), reproduced by the Task 9
// review only under a held parks lock. Left out as layered (measured SURVIVED,
// 2026-10-26): the first look of a subtask's retirement for an open persona
// operation, since its look again behind its own exclusion record (X48) finds
// any operation the first look would, and returns the same `waiting`. Left out
// as layered (measured SURVIVED, 2026-10-26): the plan's branch in a
// rebinding's lane scan, since the child file the rebinding found is read
// directly too (Q10, Q11), and carries the same entry. Left out as layered
// (measured KILLED-ELSEWHERE, 2026-10-26): the release's own refusal beside an
// open operation (writerBlockers), since its exclusion record's look again
// (excludeWriters) refuses the same operation, naming it. Left out as layered
// (V, not measured): basisFor's child read from the child it found, since the
// handoff records the lane's child (V6) and `heldChild` gives it to the
// release, so the two name the same child on every path a test can build; and
// the admission's first gate in `launch`, which the creation's gate (V17) and
// the spawn's (V18) back on every path but a note's delivery. Left out as
// layered (measured SURVIVED, 2026-10-26): publishDispatchMark's own guard for
// a plan id that is no hold key, since the gate it calls first
// (handDispatchRefusal, V13) answers holds-off for it, and nothing is published.

const TR = 'tests/orchestrator/test-holds-records.mjs';
const TL = 'tests/orchestrator/test-holds-liveness.mjs';
const TF = 'tests/orchestrator/test-holds-fence.mjs';
const TH = 'tests/orchestrator/test-holds-handoff.mjs';
const TD = 'tests/orchestrator/test-lane-digest.mjs';
const TC = 'tests/orchestrator/test-holds-capability.mjs';
const TK = 'tests/orchestrator/test-autopilot-holds-cli.mjs';
const TS = 'tests/orchestrator/test-autopilot-scheduler-holds.mjs';
const TRC = 'tests/orchestrator/test-autopilot-scheduler-releases.mjs';
const TRR = 'tests/orchestrator/test-autopilot-scheduler-releases-recovery.mjs';
const TRW = 'tests/orchestrator/test-autopilot-scheduler-releases-wake.mjs';
const TLH = 'tests/orchestrator/test-autopilot-lanes-holds.mjs';
const TN = 'tests/orchestrator/test-next-holds.mjs';
const TX = 'tests/orchestrator/test-holds-retirement.mjs';
const TXR = 'tests/orchestrator/test-autopilot-holds-retire-run.mjs';
const TCU = 'tests/orchestrator/test-cutover.mjs';
const TPR = 'tests/orchestrator/test-plan-rebind.mjs';
const TA = 'tests/acceptance/hold-takeover/test-hold-takeover-orchestrator.mjs';
const TV = 'tests/orchestrator/test-holds-seams.mjs';
const TSV = 'tests/orchestrator/test-autopilot-scheduler-holds-seams.mjs';
const TLG = 'tests/orchestrator/test-autopilot-scheduler-lane-gate.mjs';
const TLN = 'tests/orchestrator/test-autopilot-lanes.mjs';
const TSC = 'tests/orchestrator/test-autopilot-scheduler.mjs';
const ENG_PHASE7 = 'plugins/engineer/scripts/phase7-commit.mjs';
const ENG_STOP = 'plugins/engineer/scripts/stop-archive.mjs';

const LIB = 'plugins/orchestrator/scripts/lib';
const HR = `${LIB}/holds-records.mjs`;
const H = `${LIB}/holds.mjs`;
const RL = `${LIB}/run-locks.mjs`;
const PK = 'plugins/orchestrator/adapters/claude/autopilot/parks.mjs';
const ST = 'plugins/orchestrator/scripts/state.mjs';
const OPS = `${LIB}/hold-ops.mjs`;
const LD = `${LIB}/lane-digest.mjs`;
const CU = `${LIB}/cutover.mjs`;
const SA = 'plugins/orchestrator/scripts/stop-archive.mjs';
const CMD = 'plugins/orchestrator/commands';
const SKILLS = 'plugins/orchestrator/core/skills';
const ACT = `${LIB}/hold-activation.mjs`;
const AP = 'plugins/orchestrator/adapters/claude/autopilot';
const NEXT_MD = 'plugins/orchestrator/commands/next.md';
const NEXT_SKILL = 'plugins/orchestrator/core/skills/next/SKILL.md';
const ROOTS = `${AP}/roots.mjs`;
const DRV = `${AP}/driver.mjs`;
const CLI = `${AP}/cli.mjs`;
const HCLI = `${AP}/holds-cli.mjs`;
const SCH = `${AP}/scheduler.mjs`;
const LNS = `${AP}/lanes.mjs`;

export const TESTS = [TR, TL, TF, TH, TD, TC, TK, TS, TRC, TRR, TRW, TLH, TA, TV, TSV];

export const MUTATIONS = [
  // ---- B: live runs and busy lanes ------------------------------------------
  {
    id: 'B1', file: H, tests: [TL],
    from: "    return { live: true, runs: [{ run_id: null, pid: null, capabilities: [], repo: null }], why: `the run lock of ${macroId} cannot be read (${err.message})` };",
    to: "    return { live: false, runs: [], why: '' };",
    why: 'a run lock that cannot be read counts as no live run, so a hold beside it completes its own handoff (N3: unreadable is live)',
    killed_by: /a lock entry that cannot be read counts as a live run/,
  },
  {
    id: 'B2', file: H, tests: [TL],
    from: '    if (await holderAlive({ pid: e.holder.pid, fingerprint: e.holder.fingerprint }, { probe })) {',
    to: '    if (await holderAlive(e.holder, { probe })) {',
    why: 'a worker group that outlived its driver makes the run look live (a run is live while its driver lives)',
    killed_by: /a dead driver is no live run/,
  },
  {
    id: 'B3', file: H, tests: [TL],
    from: '    if (names !== null && names !== subtaskId) continue;',
    to: '    if (names !== subtaskId) continue;',
    why: 'a surviving group that names no subtask no longer makes every lane busy',
    killed_by: /a live group that names no subtask makes every lane busy/,
  },
  {
    id: 'B4', file: H, tests: [TL],
    from: "      if (s?.event === 'started') open.set(s.seq, s.subtask_id ?? null);",
    to: '',
    why: "a dead run's unfinished step of the lane no longer keeps it busy until it is cleaned up",
    killed_by: /a dead run's unfinished step of the lane keeps it busy/,
  },
  // ---- F: the fence ---------------------------------------------------------
  {
    id: 'F1', file: RL, tests: [TF],
    from: "    kind: 'session', command: 'hold', admission_id: admissionId, hold_id: holdId, subtask_id: subtaskId,",
    to: "    kind: 'hold', command: 'hold', admission_id: admissionId, hold_id: holdId, subtask_id: subtaskId,",
    why: 'the fence is no session entry, so it is judged by a process it has none of and cleared as gone',
    killed_by: [/is a session-named entry/, /a run cannot take the lane beside it/],
  },
  {
    id: 'F2', file: RL, tests: [TF],
    from: '    if (isFence(own?.holder)) {\n      throw new AdmissionError(',
    to: '    if (false) {\n      throw new AdmissionError(',
    why: "the session `admission release` removes a hold's fence, unfencing a held lane",
    killed_by: /the session `admission release` refuses it/,
  },
  {
    id: 'F4', file: RL, tests: [TF],
    from: '  if (isFence(holder)) {\n    return `a hold of subtask',
    to: '  if (false) {\n    return `a hold of subtask',
    why: 'a refusal beside a fence names a session admission to release instead of the hold',
    killed_by: [/the refusal names the release/, /an interactive admission is refused beside it, naming the release/],
  },
  {
    id: 'F5', file: ST, tests: [TF],
    from: "            if (!(err instanceof AdmissionError) || err.code !== 'fence') throw err;",
    to: '            throw err;',
    why: 'the CLI crashes with a stack instead of refusing a fence with the release command',
    killed_by: /the session `admission release` refuses it/,
  },
  // ---- R: the records and their readers ---------------------------------------
  {
    id: 'R1', file: HR, tests: [TR],
    from: "    if (!st.isFile()) return { error: `${file} is not a regular file` };",
    to: '',
    why: 'a FIFO or a directory standing where a record is expected is read as a record',
    killed_by: [/A7-marker-directory/, /H14-hold-fifo/],
  },
  {
    id: 'R2', file: HR, tests: [TR],
    from: "        if (fs.lstatSync(file).isSymbolicLink()) return { error: `${file} is a link to nothing` };",
    to: '        if (false) return {};',
    why: 'a dangling link where a record is expected reads as nothing, so the hold it stands for does not apply',
    killed_by: [/A9-marker-dangling-link/, /readPark neither hangs/],
  },
  {
    id: 'R3', file: HR, tests: [TR],
    from: "  if (read.state === 'unreadable') return { applies: true, why: `the hold record cannot be read (${read.error})` };",
    to: "  if (read.state === 'unreadable') return { applies: false, why: '' };",
    why: 'a hold record that cannot be read gives the lane back (item 8: it holds its subtask)',
    killed_by: [/H9-hold-not-json/, /H14-hold-fifo/],
  },
  {
    id: 'R4', file: HR, tests: [TR],
    from: "  if (typeof r.child === 'string' && workflowId !== null && r.child !== workflowId) {",
    to: '  if (false) {',
    why: 'a hold set on another child applies to a new one (a reused branch)',
    killed_by: /H4-held-other-child/,
  },
  {
    id: 'R5', file: HR, tests: [TR],
    from: "    return { state: own(handoff) ? 'held' : 'pending', hold, handoff, release };",
    to: "    return { state: handoff.state === 'ok' ? 'held' : 'pending', hold, handoff, release };",
    why: "an older hold's acked handoff makes a new hold show held before its own handoff fenced the lane",
    killed_by: /the records give each state of the table/,
  },
  {
    id: 'R6', file: HR, tests: [TR],
    from: "  ['rejected', 'compare-equal', 'a rejected release is not compared again'],",
    to: '',
    why: 'a rejected release can be compared again once the tree is put back',
    killed_by: /every transition of the table, and every refusal/,
  },
  {
    id: 'R7', file: H, tests: [TR],
    from: '      for (const op of decoded.ops) if (!cleared.has(op.id)) add(op.id, op.kind, \'entry\');',
    to: "      for (const op of decoded.ops) add(op.id, op.kind, 'entry');",
    why: "an operation the owner cleared still blocks the lane through the child's stale entry (a cleared record beats an open entry)",
    killed_by: /a \.cleared beats an entry/,
  },
  {
    id: 'R8', file: H, tests: [TR],
    from: "      if (decoded.state === 'unreadable') add('(child)', null, 'entry', decoded.error);",
    to: '',
    why: 'a child whose operations document cannot be read counts no operation open',
    killed_by: [/an unreadable document counts open/, /a later document version counts open/],
  },
  {
    id: 'R9', file: H, tests: [TR],
    from: "        if (facts.fields.parent_workflow === macroId && facts.fields.originating_subtask === subtaskId) out.linked.push(file);",
    to: '        if (facts.fields.parent_workflow === macroId) out.linked.push(file);',
    why: "another lane's workflow on the branch is taken for the lane's own child",
    killed_by: /the linked child, another lane's and an unlinked workflow are told apart/,
  },
  {
    id: 'R10', file: PK, tests: [TR],
    from: "  if (r.absent) return { state: 'absent' };\n  if (r.error) return { state: 'unreadable', error: r.error, digest: null };",
    to: "  if (r.absent || r.error) return { state: 'absent' };",
    why: 'the park reader reads a FIFO or a dangling link where a park is kept as no park',
    killed_by: /readPark neither hangs on a FIFO/,
  },
  {
    id: 'R11', file: RL, tests: [TR],
    from: '  const r = readRegular(file);\n  if (r.absent) return null;\n  if (r.error) throw new Error(r.error);',
    to: "  const r = readRegular(file);\n  if (r.absent || r.error) return null;",
    why: 'a lock entry that is a link to nothing, or no regular file, is taken for gone, so a fence an older reader cannot read stops fencing',
    killed_by: /readLockEntries neither hangs on a FIFO entry/,
  },
  // ---- H: the handoff and the release -----------------------------------------
  {
    id: 'H1', file: OPS, tests: [TH],
    from: '    const after = await blockersNow();',
    to: '    const after = [];',
    why: 'the handoff acks without looking again after its fence, beside an admission that came in between its looks',
    killed_by: /an admission that writes between the two looks withdraws the fence/,
  },
  {
    id: 'H2', file: OPS, tests: [TH],
    from: '      if (lane.laneRoot) repairFence({ laneRoot: lane.laneRoot, holdId: hold.hold_id, subtaskId, macroId, held: true });',
    to: '',
    why: "a held lane whose fence an older orchestrator's `admission release` removed stays unfenced",
    killed_by: /gets it back from the next handoff/,
  },
  {
    id: 'H3', file: OPS, tests: [TH],
    from: "      if (lane.laneRoot && fenceState(lane.laneRoot, hold.hold_id) === 'present') removeFence(lane.laneRoot, hold.hold_id);",
    to: '',
    why: 'a fence a crashed handoff left stays while the hold is pending, so the lane is fenced but not shown held',
    killed_by: /a retried handoff that finds its own fence redoes every check/,
  },
  {
    id: 'H4', file: OPS, tests: [TH],
    from: "      const own = busy(subtaskId);\n      if (own) out.push(own);",
    to: '',
    why: "the driver's own steps in flight in the lane do not keep the handoff pending",
    killed_by: /or the caller's lane is busy/,
  },
  {
    id: 'H5', file: OPS, tests: [TH],
    from: '    if (hold.hold_id !== holdId) {',
    to: '    if (false) {',
    why: 'a release ends a newer hold than the one it names',
    killed_by: /names the hold it ends, and refuses while a writer may be active/,
  },
  {
    id: 'H6', file: OPS, tests: [TH],
    from: "  const fingerprint = await processFingerprint(process.pid);\n  publishOpRecord(mainRoot, macroId, subtaskId, {\n    operation_id: id, kind,",
    to: "  const fingerprint = await processFingerprint(process.pid);\n  ({\n    operation_id: id, kind,",
    why: "the release digests the lane with no exclusion record, so a persona operation's first write can start mid-digest (P2)",
    killed_by: /records its basis behind the writer exclusion/,
  },
  {
    id: 'H7', file: OPS, tests: [TH],
    from: '    const blockers = writerBlockers({ mainRoot, macroId, subtaskId, lane });\n    if (blockers.length) {',
    to: '    const blockers = [];\n    if (blockers.length) {',
    why: 'a release goes through while a persona operation is open in the lane',
    killed_by: /names the hold it ends, and refuses while a writer may be active/,
  },
  // ---- D: the release basis and its comparison --------------------------------
  {
    id: 'D1', file: LD, tests: [TD],
    from: "    for (const flag of ['--no-assume-unchanged', '--no-skip-worktree']) {",
    to: "    for (const flag of []) {",
    why: "an edit hidden by an assume-unchanged or skip-worktree bit is outside the digest, so a release is consumed over it",
    killed_by: /sees an edit its assume-unchanged or skip-worktree bit hides/,
  },
  {
    id: 'D2', file: LD, tests: [TD],
    from: "  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_'))),",
    to: "  ...process.env,",
    why: "an inherited GIT_DIR or GIT_INDEX_FILE redirects the digest to another repository or index",
    killed_by: /ignores an inherited GIT_DIR or GIT_INDEX_FILE/,
  },
  {
    id: 'D3', file: LD, tests: [TD],
    from: "      h.update(`submodule ${rel} ${checkedOut ? treeDigest(sub).digest : `gitlink ${l.split(' ')[1]}`}\\n`);",
    to: "      h.update(`submodule ${rel} ${`gitlink ${l.split(' ')[1]}`}\\n`);",
    why: "an edit inside a checked-out submodule leaves the digest unchanged",
    killed_by: /a checked-out submodule's edits move it/,
  },
  {
    id: 'D4', file: LD, tests: [TD],
    from: "    const env = { GIT_INDEX_FILE: index };",
    to: "    const env = {};",
    why: "the digest stages into the lane's real index",
    killed_by: /never touches the lane's own index/,
  },
  {
    id: 'D5', file: OPS, tests: [TD],
    from: "    && a.tree_digest === b.tree_digest && a.content_digest === b.content_digest",
    to: "    && a.content_digest === b.content_digest",
    why: "a lane edited after its release consumes the release",
    killed_by: /a lane edited after its release rejects it/,
  },
  {
    id: 'D6', file: OPS, tests: [TD],
    from: "    if (r.state !== 'ok' || r.record.state !== 'consumed' || r.record.park_ended) return { finished: false };",
    to: "    if (r.state !== 'ok' || r.record.state !== 'consumed') return { finished: false };",
    why: "a consumption whose park already ended ends a park again (a newer one under the same lane would go)",
    killed_by: /finished by the recorded park id only/,
  },
  {
    id: 'D7', file: OPS, tests: [TD],
    from: "  const others = openOperations({ mainRoot, macroId, subtaskId, childPath }).open.filter((o) => o.id !== id);",
    to: "  const others = [];",
    why: "the comparison digests beside a persona operation that began first",
    killed_by: /exactly one side refuses \(the persona first\)/,
  },
  // ---- C: rollout, K: the owner's commands, S: the scheduler ------------------
  {
    id: 'C1', file: ROOTS, tests: [TC],
    from: "    ['engineer', 'scripts/lib/holds.mjs', 'hold-persona-1', 'the hold-aware persona (ADR-0068 Decision 2, N8)'],",
    to: "",
    why: "a run with lanes starts with a pinned engineer that writes terminal in a held lane",
    killed_by: /the lanes capability floor needs the pinned engineer's hold-aware persona/,
  },
  {
    id: 'C2', file: ACT, tests: [TC],
    from: "  for (const host of ['claude', 'codex']) {",
    to: "  for (const host of ['claude']) {",
    why: "holds turn on while the Codex host's engineer is not hold-aware",
    killed_by: /turns on only once both hosts/,
  },
  {
    id: 'C3', file: ACT, tests: [TC],
    from: "  if (problems.length) return { ok: false, problems };",
    to: "",
    why: "the marker is written while the persona is missing somewhere",
    killed_by: /turns on only once both hosts/,
  },
  {
    id: 'C4', file: DRV, tests: [TC],
    from: "      .filter(([, s]) => s.state === 'pending' || s.state === 'held' || s.state === 'unreadable');",
    to: "      .filter(() => false);",
    why: "a serial run starts beside a hold, and switches the branch of the checkout the person works in",
    killed_by: /names each hold that applies, with its release/,
  },
  {
    id: 'K1', file: HCLI, tests: [TK],
    from: "    if (!r.capabilities.includes(HOLDS_CAPABILITY)) {",
    to: "    if (false) {",
    why: "a hold is set beside a live run that does not honour it",
    killed_by: /refuses beside a live run that does not honour holds/,
  },
  {
    id: 'K2', file: CLI, tests: [TK],
    from: "  if (hs.state === 'pending' || hs.state === 'held') {",
    to: "  if (false) {",
    why: "a bare release ends a held lane's park",
    killed_by: /refuses a held lane, an uncompared release/,
  },
  {
    id: 'K3', file: HCLI, tests: [TK],
    from: "        schema: 'agentic-hold-1', hold_id: newRecordId(), subtask_id: o.subtask, ...replacement,",
    to: "        schema: 'agentic-hold-1', hold_id: newRecordId(), subtask_id: o.subtask, branch: '(discarded)', lane: null, child: null,",
    why: "a discarded owner's record is replaced by a hold that applies to no branch, giving the lane back unguarded",
    killed_by: /never given back unguarded/,
  },
  {
    id: 'K4', file: HCLI, tests: [TK],
    from: "  let handoff = { state: 'pending', blocker: again.live ?",
    to: "  let handoff = { state: 'pending', blocker: false ?",
    why: "hold completes the handoff itself beside a live run, racing it",
    killed_by: /leaves the handoff to it/,
  },
  {
    id: 'S1', file: SCH, tests: [TS],
    from: "  const gateOf = (id) => (id ? holdGate({ mainRoot, macroId, subtaskId: id }) : null);",
    to: "  const gateOf = () => null;",
    why: "the driver dispatches and steps a held subtask",
    killed_by: /never dispatched/,
  },
  {
    id: 'S2', file: SCH, tests: [TS],
    from: "    const open = openOperations({ mainRoot, macroId, subtaskId: id, childPath }).open;\n    if (open.length === 0) return false;",
    to: "    const open = [];\n    if (open.length === 0) return false;",
    why: "a worker spawns into a lane with a persona operation open",
    killed_by: /holds its spawn back until it closes/,
  },
  // ---- the review's findings ----------------------------------------------
  {
    id: 'D8', file: LD, tests: [TD],
    from: "      fs.utimesSync(index, 1, 1);",
    to: "",
    why: "the copied index trusts each entry's stat, missing an edit of the same size whose times were put back",
    killed_by: /sees an edit of the same size whose times were put back/,
  },
  {
    id: 'D9', file: LD, tests: [TD],
    from: "    git(top, ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', WORKTREE_LOCK_REL], env);",
    to: "",
    why: "the release's own fence is in its basis where the lane does not ignore its runs, so its removal rejects the release",
    killed_by: /worktree lock is outside it/,
  },
  {
    id: 'R12', file: HR, tests: [TH],
    from: "    if (handoff.state === 'unreadable') return { state: 'unreadable', hold, handoff, release, why: handoff.error };",
    to: "",
    why: "an unreadable handoff reads as pending, so a release withdraws a held lane with no comparison",
    killed_by: /an unreadable handoff record is neither pending nor held/,
  },
  {
    id: 'H9', file: OPS, tests: [TH],
    from: "    for (const l of lanes) removeSubtaskFences(l, { macroId, subtaskId, keepHoldId: null });\n",
    to: "",
    why: "a new hold strands the fence of the hold it replaces, which no command can name",
    killed_by: /strands no fence/,
  },
  {
    id: 'K5', file: HCLI, tests: [TK],
    from: "  if (blind) {",
    to: "  if (false) {",
    why: "a hold published beside a serial run that started between its looks stays",
    killed_by: /second look finds a run that does not honour holds/,
  },
  // ---- W: the driver's comparison and the wake-ups (Task 9) ----------------------
  {
    id: 'W1', file: SCH, tests: [TRC],
    from: "        if (st.state !== 'released-uncompared') continue;\n",
    to: "        continue;\n",
    why: 'no release is ever compared, so a released lane never steps again',
    killed_by: /an unchanged lane's release is consumed/,
  },
  {
    id: 'W3', file: SCH, tests: [TRC],
    from: "          if (await parkRejected(id, holdId, st.release.record.release_id)) changed = true;\n",
    to: "",
    why: 'a rejection whose park went is not parked again (I3: the next run rebuilds the park)',
    killed_by: /not compared again once the tree is put back/,
  },
  {
    id: 'W4', file: SCH, tests: [TRC],
    from: "        if (g) return await end('halted', asHalt(",
    to: "        if (false) return await end('halted', asHalt(",
    why: 'a forced --next on a rejected lane ends its park, though only a new hold and release give it back',
    killed_by: /not compared again once the tree is put back/,
  },
  {
    id: 'W5', file: SCH, tests: [TRR],
    from: "        if (st.state === 'consumed' && st.release.record.park_ended !== true) {\n",
    to: "        if (false) {\n",
    why: 'a consumption a crash stopped before the kept park ended is never finished: the lane stays parked',
    killed_by: /consumption stopped before its kept park/,
  },
  {
    id: 'W6', file: SCH, tests: [TRR],
    from: "    expect: recordId, event: 'resumed', fields: { run_id: runId, why: 'its release was consumed' },\n",
    to: "    event: 'resumed', fields: { run_id: runId, why: 'its release was consumed' },\n",
    why: 'a consumption ends whatever park the lane has, a newer one included (I3: by the recorded id only)',
    killed_by: /leaves the newer park standing/,
  },
  {
    id: 'W7', file: SCH, tests: [TRW],
    from: "    if (hk !== holdsSeen) { holdsSeen = hk; found = true; }\n",
    to: "    if (hk !== holdsSeen) { holdsSeen = hk; }\n",
    why: 'a release or a hold wakes nothing: the run sees it only at a step\'s end, or never before it ends',
    killed_by: /a release while another lane's step runs wakes the run/,
  },
  {
    id: 'W8', file: SCH, tests: [TRW],
    from: "    return ids.ids.map((id) => `${id}=${statKey(recordPath(mainRoot, macroId, 'holds', id))}`).join('|');\n",
    to: "    return ids.ids.map((id) => `${id}=${statKey(recordPath(mainRoot, macroId, 'holds', id))}${statKey(recordPath(mainRoot, macroId, 'handoffs', id))}`).join('|');\n",
    why: "the driver's own handoff records wake the run on its own activity",
    killed_by: /own records and the holds lock wake nothing/,
  },
  {
    id: 'W9', file: SCH, tests: [TRW],
    from: "    else if (pendingHandoffs().some((id) => !subtasksInFlight().has(id))) found = true;\n",
    to: "",
    why: 'a pending handoff whose blocker went away without touching a source is not tried again until a step ends',
    killed_by: /pending handoff is tried again at each tick/,
  },
  {
    id: 'W10', file: SCH, tests: [TRW],
    from: "      if (await consumeReleases()) continue;\n",
    to: "",
    why: "a release recorded after the turn's comparison is left uncompared when the run ends",
    killed_by: /recorded after the run's last look of the turn/,
  },
  {
    id: 'W11', file: SCH, tests: [TRC],
    from: "      if (gateOf(id)) {\n        // A rejection's park this run's first comparison wrote is applied already.\n",
    to: "      if (false) {\n        // A rejection's park this run's first comparison wrote is applied already.\n",
    why: "a held lane's kept park is compared and ended by the person's own work, before any release",
    killed_by: /kept park is kept as it is while held/,
  },
  {
    id: 'W12', file: SCH, tests: [TRR],
    from: "    return resume(id, 'its release was consumed', 'release', { parkEnded: true });\n",
    to: "    return false;\n",
    why: 'a lane the run parked stays parked after its release is consumed',
    killed_by: /held and released again in the same run is consumed and stepped/,
  },
  {
    id: 'W13', file: SCH, tests: [TRC],
    from: "    await consumeReleases();\n    if (options.forcedPairs?.length) {\n",
    to: "    if (options.forcedPairs?.length) {\n",
    why: 'a forced --next on a released lane is refused as not compared, though the run compares it first',
    killed_by: /forced --next on a released lane runs once its release is compared/,
  },
  {
    id: 'W14', file: SCH, tests: [TRW],
    from: "      await consumeReleases();\n      await passedBack();\n",
    to: "      await passedBack();\n",
    why: 'a release is compared only when the run is about to end, never while other lanes run',
    killed_by: /a release while another lane's step runs wakes the run/,
  },
  {
    id: 'W15', file: SCH, tests: [TRW],
    from: "    else if ([...releaseRetry].some(releaseDue)) found = true;\n",
    to: "",
    why: 'a comparison refused or failed waits for a step to end after its cause went, or for the run to end',
    killed_by: /comparison an open operation refused is tried again at each tick/,
  },
  {
    id: 'W16', file: SCH, tests: [TRR],
    from: "        await withHoldsLock(mainRoot, macroId, () => sweepDeadExclusions({ mainRoot, macroId, subtaskId: id }));\n",
    to: "",
    why: "a consumption a crash stopped leaves its dead driver's exclusion record open, and the lane never steps (I3)",
    killed_by: /past the exclusion record its dead driver left/,
  },
  {
    id: 'W17', file: SCH, tests: [TRR],
    from: "        await repairHoldFence({ mainRoot, macroId, subtaskId: id });\n",
    to: "",
    why: "a release stopped before its fence went leaves the fence, which then strands the lane (I3)",
    killed_by: /stopped before its fence went leaves no fence/,
  },
  {
    id: 'W18', file: SCH, tests: [TRW],
    from: "        noteRelease(id, `⚠ lane ${id}: its release could not be compared or settled",
    to: "        throw e; noteRelease(id, `⚠ lane ${id}: its release could not be compared or settled",
    why: 'a basis that could not be taken stops the run and every lane in it',
    killed_by: /basis could not be taken does not stop the run/,
  },
  {
    id: 'W19', file: SCH, tests: [TRW],
    from: "      } catch (e) {\n        r = { state: 'pending', holdId: st.hold.record.hold_id,",
    to: "      } catch (e) {\n        throw e; r = { state: 'pending', holdId: st.hold.record.hold_id,",
    why: "a handoff the holds lock keeps from running stops the run, and every other lane's step with it",
    killed_by: /handoff the holds lock keeps from running stays pending/,
  },
  {
    id: 'W20', file: SCH, tests: [TRW],
    from: "      if (await reconsider(true)) continue;\n      if (draining || c.interrupted()) continue;\n      // A release recorded since this turn's comparison, its last look\n      // included, is not lost (Decision 1, item 7): every pending one is\n      // compared before the run ends.\n      if (await consumeReleases()) continue;\n",
    to: "      if (await consumeReleases()) continue;\n      if (await reconsider(true)) continue;\n      if (draining || c.interrupted()) continue;\n",
    why: "the run's last comparison comes before its last look, so a release recorded during that look is left to the next run",
    killed_by: /recorded during the run's last reconsideration/,
  },
  // ---- L: a relaunch with a held lane, and the run's end (Task 10) -------------
  {
    id: 'L1', file: LNS, tests: [TLH],
    from: "    if (passed(e.subtaskId, l.path)) continue;\n",
    to: "",
    why: "a relaunch's rows act on a held lane: it is adopted, its lock refused by the fence, and the lane parks",
    killed_by: /a relaunch passes a held lane by/,
  },
  {
    id: 'L2', file: LNS, tests: [TLH],
    from: "  plan.halts = plan.halts.filter((h) => !gated(h.subtaskId));\n",
    to: "",
    why: 'a row of a held lane halts it (item 11: a held lane is no halt)',
    killed_by: /worktree is gone, git still registering it, is no halt/,
  },
  {
    id: 'L3', file: LNS, tests: [TLH],
    from: "    if (passed(p.intent?.subtask_id ?? p.lane?.subtaskId, p.intent?.path ?? p.lane?.path)) continue;\n",
    to: "",
    why: "the relaunch's pre-pass writes a lane id into a held lane",
    killed_by: /no identity gets none from the relaunch/,
  },
  {
    id: 'L5', file: SCH, tests: [TLH],
    from: "  if (entry.held) return 'held';\n",
    to: "",
    why: "halt.json and the report give a held lane another state than held",
    killed_by: /a relaunch passes a held lane by/,
  },
  {
    id: 'L6', file: SCH, tests: [TLH],
    from: "(d.idle?.reason !== 'awaiting-landing' ? firstHeld() ?? firstBusy() : null) ?? d.idle",
    to: "d.idle",
    why: "a run whose lanes left are all held ends on 'nothing is dispatchable', without the release",
    killed_by: /a relaunch passes a held lane by/,
  },
  {
    id: 'L7', file: SCH, tests: [TLH],
    from: "        ...heldAtEnd().filter((x) => x.subtask_id !== d.subtaskId),\n",
    to: "",
    why: "a held lane beside the halt's own reason is left out of halt.json's also, with its release",
    killed_by: /listed in the halt's also, with its release/,
  },
  {
    // The last handoffs run in the driver's finish, once the lock entries
    // are gone (impl-events: before the run's run-ended).
    id: 'L8', file: 'plugins/orchestrator/adapters/claude/autopilot/driver.mjs', tests: [TLH],
    from: "      await last().catch(() => {});\n",
    to: '',
    why: 'a hold set as the run ends, beside its lock entries, stays pending: no one hands it over',
    killed_by: /handed over once they are gone/,
  },
  {
    id: 'L9', file: SCH, tests: [TLH],
    from: "      await passedBack();\n",
    to: "",
    why: 'a lane the relaunch passed by, given back (its release consumed, or its hold ended without one), is stepped or created over its worktree, its rows never judged again',
    killed_by: /(hold ended without a release is reconciled and stepped|passed by, then reconciled and stepped once its comparison consumes it)/,
  },
  {
    id: 'L10', file: LNS, tests: [TLH],
    from: "    if (passed(u.intent?.subtask_id, w.path)) continue;\n",
    to: "    if (passedBy.some((p) => p.subtaskId === u.intent?.subtask_id)) continue;\n",
    why: 'the gate read once, early in the pass: a hold set while reconciliation runs does not stop a later row removing its lane',
    killed_by: /hold set while reconciliation runs stops every later action/,
  },
  {
    id: 'L11', file: DRV, tests: [TLH],
    from: "    if (afterRelease) await afterRelease().catch(() => {});\n",
    to: "",
    why: 'a run that stops on an error leaves a hold set before it stopped pending: no one hands it over',
    killed_by: /stops on an error hands over a hold/,
  },
  {
    id: 'L12', file: LNS, tests: [TLH],
    from: "  for (const w of facts.atOurPaths) if (w.present && !passed(intentAt(w)?.subtask_id, w.path)) w.removal = await removable(w.path);\n",
    to: "  for (const w of facts.atOurPaths) if (w.present) w.removal = await removable(w.path);\n",
    why: "an unlocked held lane's removal check runs git in the owner's lane",
    killed_by: /gets no removal check and is not removed/,
  },
  {
    id: 'L13', file: SCH, tests: [TLH],
    from: "      if (gateOf(id)) continue;\n      // A park the lane keeps stands",
    to: "      passedBy.delete(id);\n      if (gateOf(id)) continue;\n      // A park the lane keeps stands",
    why: 'a lane given back, then held again before its rows were judged, is no longer known to need them, and never steps',
    killed_by: /held again before its rows are judged is reconciled/,
  },
  {
    id: 'N1', file: OPS, tests: [TN],
    from: "  if (a.state === 'inactive') return { active: false, why: null };\n  if (a.state === 'unreadable') {\n",
    to: "  if (a.state === 'unreadable') {\n",
    why: 'a macro whose holds are off gets something new: its dispatch publishes a mark no engineer removes, under a holds directory it creates',
    killed_by: /(nothing new — no refusal|nothing new while the holds are off)/,
  },
  {
    id: 'N2', file: OPS, tests: [TN],
    from: "    return { active: true, why: exit ? `${gate}; ${exit}` : gate };\n",
    to: "    return { active: true, why: null };\n",
    why: 'a held subtask, or one whose release no run has compared, is dispatched by hand',
    killed_by: /(refuses a pending and a held hold|is not compared yet|hold gate and Phase 3's capability check refuse|hold set before Phase 3b refuses|Phase 1 gate refuses a held subtask)/,
  },
  {
    id: 'N3', file: OPS, tests: [TN],
    from: "  const open = laneOperations({ mainRoot, macroId, subtaskId, branch, stateRoots }).filter((o) => o.id !== ownOperationId);\n",
    to: "  const open = [];\n",
    why: 'a subtask with a persona operation open in its lane is dispatched beside it',
    killed_by: /refuses an open persona operation in the lane/,
  },
  {
    id: 'N4', file: OPS, tests: [TN],
    from: "    keep({ active: true, operationId: id });\n    publishOpRecord(mainRoot, macroId, subtaskId, {",
    to: "    keep({ active: true, operationId: id });\n    if (false) publishOpRecord(mainRoot, macroId, subtaskId, {",
    why: 'the dispatch publishes no mark: a hold set during it is handed over at once, and its engineer then runs in a held lane',
    killed_by: /Phase 3b publishes the mark|its switch publishes the mark/,
  },
  {
    id: 'N5', file: OPS, tests: [TN],
    from: "    if (carried.unreadable || carried.ids.has(operationId)) return { state: 'carried' };\n",
    to: "",
    why: "an exit withdraws the mark its engineer's bootstrap took over: the operation runs on with no record, and a hold is handed over beside it",
    killed_by: /the real engineer bootstrap continues it, and its last write ends it/,
  },
  {
    id: 'N6', file: NEXT_MD, tests: [TN],
    from: "release_admission() {\n  withdraw_mark\n  node \"$CLAUDE_PLUGIN_ROOT/scripts/state.mjs\" admission release \\\n",
    to: "release_admission() {\n  node \"$CLAUDE_PLUGIN_ROOT/scripts/state.mjs\" admission release \\\n",
    why: "Phase 3b's exits leave the mark: a failed switch keeps an open operation in the lane until the owner clears it",
    killed_by: /an exit before the engineer took the mark over withdraws it/,
  },
  {
    id: 'N7', file: NEXT_MD, tests: [TN],
    from: "release_admission() {\n  withdraw_mark\n  node \"$ORCH_PLUGIN_ROOT/scripts/state.mjs\" admission release \\\n",
    to: "release_admission() {\n  node \"$ORCH_PLUGIN_ROOT/scripts/state.mjs\" admission release \\\n",
    why: "Phase 5's exits leave a mark no engineer took over: a dispatch whose engineer never ran keeps the lane's operation open",
    killed_by: /an exit before the engineer took the mark over withdraws it/,
  },
  {
    id: 'N8', file: NEXT_MD, tests: [TN],
    from: "if [ -n \"$DISPATCH_OPERATION_ID\" ]; then\n  export AGENTIC_OPERATION_ID=\"$DISPATCH_OPERATION_ID\"\nelse\n  unset AGENTIC_OPERATION_ID\nfi\n\nexport CLAUDE_PLUGIN_ROOT=",
    to: "\nexport CLAUDE_PLUGIN_ROOT=",
    why: "the engineer's bootstrap is not given the mark's id: it opens another operation beside the mark, and refuses",
    killed_by: /the real engineer bootstrap continues it/,
  },
  {
    id: 'N9', file: ST, tests: [TN],
    from: "        if (mark !== null && mark.active === false && !mark.reattach) {\n",
    to: "        if (false) {\n",
    why: 'holds that turned on after Phase 3b judged them off let the dispatch go on with no mark a hold would wait for',
    killed_by: /holds turned on after Phase 3b judged them off/,
  },
  {
    id: 'N10', file: ST, tests: [TN],
    from: "          const problem = engineerHoldProblem(flags['engineer-root']);\n",
    to: "          const problem = null;\n",
    why: 'with the holds on, a dispatch goes into an engineer that is not hold-aware, which writes terminal and leaves no operation a hold would see',
    killed_by: /refuses an engineer that is not hold-aware/,
  },
  {
    id: 'N11', file: NEXT_MD, tests: [TN],
    from: "REATTACH=false\nif [ -n \"$EXISTING_ENG_PATH\" ]; then REATTACH=true; fi\n",
    to: "REATTACH=false\n",
    why: "a re-attach publishes a mark its engineer's resume does not continue: the resume opens its own operation beside it, and refuses",
    killed_by: /a re-attach publishes no mark/,
  },
  {
    id: 'N12', file: NEXT_SKILL, tests: [TN],
    from: "if [ -n \"$DISPATCH_OPERATION_ID\" ]; then\n  export AGENTIC_OPERATION_ID=\"$DISPATCH_OPERATION_ID\"\nelse\n  unset AGENTIC_OPERATION_ID\nfi\nexport CLAUDE_PLUGIN_ROOT=",
    to: "export CLAUDE_PLUGIN_ROOT=",
    why: "the Codex prelude does not export the mark's id: the engineer's bootstrap opens another operation beside the mark",
    killed_by: /its prelude exports it/,
  },
  {
    id: 'N13', file: OPS, tests: [TN],
    from: "  const { ids } = childEntries({ macroId, subtaskId, branch, stateRoots });\n  if (operationId) return ids.has(operationId);\n",
    to: "  const { ids } = childEntries({ macroId, subtaskId, branch, stateRoots });\n  if (operationId) return false;\n",
    why: "the prelude run again before a later engineer block refuses the engineer's own operation once a hold is set: the verb stops mid-way",
    killed_by: /the prelude run again before a later engineer block passes/,
  },
  {
    id: 'N14', file: NEXT_MD, tests: [TN],
    from: "elif [ ! -f \"$TEXT_DIR/dispatch-mark.json.checked\" ]; then\n",
    to: "elif false; then\n",
    why: "a dispatch whose check refused (a hold set before the engineer) is still recorded in progress",
    killed_by: /is not recorded in progress, though a linked child is on the branch/,
  },
  {
    id: 'N15', file: NEXT_MD, tests: [TN],
    from: "  --checkout \"$REPO_ROOT\" --mark-file \"$TEXT_DIR/dispatch-mark.json\" \\\n  --engineer-root \"$ENGINEER_PLUGIN_ROOT\" || exit 1\n",
    to: "  --checkout \"$REPO_ROOT\" --mark-file \"$TEXT_DIR/dispatch-mark.json\" || exit 1\n",
    why: "holds that turn on after Phase 3 passed an old engineer let the dispatch go into it",
    killed_by: /holds turned on after Phase 3 passed an engineer that is not hold-aware/,
  },
  {
    id: 'N16', file: OPS, tests: [TN],
    from: "  if (own.error) return `the dispatch's mark ${operationId} cannot be read (${own.error})`;\n",
    to: "",
    why: "a mark that cannot be read passes the check, and the engineer's bootstrap then refuses it",
    killed_by: /a mark that cannot be read is no mark/,
  },
  {
    id: 'N17', file: OPS, tests: [TN],
    from: "      for (const n of names) if (n.endsWith('.md')) scan.push(path.join(dir, n));\n",
    to: "",
    why: "a mark an archived child still carries is withdrawn: its operation runs on with no record, and its last write is refused",
    killed_by: /a mark an archived child carries is not withdrawn/,
  },
  {
    id: 'N18', file: OPS, tests: [TN],
    from: "  if (!isSafeSubtaskId(subtaskId) || readActivation(mainRoot, macroId).state === 'inactive') {\n    const result = { active: false, operationId: null };\n",
    to: "  if (!isSafeSubtaskId(subtaskId)) {\n    const result = { active: false, operationId: null };\n",
    why: "a dispatch for a macro whose holds are off makes a holds directory",
    killed_by: /the mark makes no holds directory/,
  },
  {
    id: 'N19', file: OPS, tests: [TN],
    from: "    const others = laneOperations({ mainRoot, macroId, subtaskId, branch, stateRoots }).filter((o) => o.id !== id);\n",
    to: "    const others = [];\n",
    why: "a persona first write that published beside the mark is not seen: both proceed",
    killed_by: /between the mark and its second look withdraws the mark/,
  },
  {
    id: 'N20', file: OPS, tests: [TN],
    from: "  for (const childPath of wf.linked.length ? wf.linked : [null]) {\n",
    to: "  for (const childPath of [null]) {\n",
    why: "an operation begun before the holds turned on, an entry on the child with no record, is not seen: the subtask is dispatched beside it",
    killed_by: /begun before the holds turned on/,
  },
  // ---- X: every hold's exit (Task 12) ------------------------------------------
  {
    id: 'X2', file: OPS, tests: [TX],
    from: "  const b = await laneBusy(mainRoot, macroId, subtaskId, { ...(probe ? { probe } : {}), exceptRun });\n",
    to: "  const b = { busy: false };\n",
    why: 'a retirement no longer waits while a process of a run lives in the lane',
    killed_by: /waits while a worker of a run lives in the lane/,
  },
  {
    id: 'X3', file: H, tests: [TX],
    from: "    if (exceptRun !== null && e.holder.run_id === exceptRun) continue;\n",
    to: '',
    why: "a run's own worker recording done waits on itself: its retirement never happens",
    killed_by: /waits while a worker of a run lives in the lane, but not for the caller's own run/,
  },
  {
    id: 'X4', file: OPS, tests: [TX],
    from: "    if (h && !retired) writeWhole(hold.path, { ...h, state: 'retired', retired_at: now().toISOString() });\n",
    to: '',
    why: "done leaves the owner's record held: the completed lane stays held",
    killed_by: /retires every record/,
  },
  {
    id: 'X5', file: OPS, tests: [TX],
    from: "    if (park.kept) await removeKeptPark(mainRoot, macroId, subtaskId, { event: 'retired', fields: { by: 'retirement' } });\n",
    to: '',
    why: "a completed lane keeps its park: the release's park record outlives it",
    killed_by: [/retires every record/, /a kept park alone/],
  },
  {
    id: 'X6', file: OPS, tests: [TX],
    from: "      if (laneSeen) removeSubtaskFences(h.lane, { macroId, subtaskId, keepHoldId: null });\n",
    to: '',
    why: "a retired hold's fence stays in the lane's worktree lock, which no command names any more",
    killed_by: /fence is removed with it/,
  },
  {
    id: 'X7', file: OPS, tests: [TX],
    from: "    if (!park.kept && handoff.state === 'absent' && release.state === 'absent' && (hold.state === 'absent' || retired)) {\n",
    to: "    if (hold.state === 'absent' || retired) {\n",
    why: "I3: a retirement a crash stopped after the owner record turned retired is never finished, and a park alone is never retired",
    killed_by: [/a crash after the owner record turned retired/, /a kept park alone/],
  },
  {
    id: 'X8', file: OPS, tests: [TX],
    from: "    if (hold.state === 'unreadable') {\n      return { state: 'unreadable', why: \`the hold record of \${subtaskId} cannot be read",
    to: "    if (false) {\n      return { state: 'unreadable', why: \`the hold record of \${subtaskId} cannot be read",
    why: 'a hold record that cannot be read is retired around instead of left for the owner to discard (item 8)',
    killed_by: /a hold record that cannot be read is not retired/,
  },
  {
    id: 'X9', file: OPS, tests: [TX],
    from: "  if (!subtask) return \`subtask \${id} left the plan\`;\n",
    to: "  if (!subtask) return null;\n",
    why: 'a hold whose subtask left the plan still applies',
    killed_by: [/orphanReason/, /left the plan orphans its hold/],
  },
  {
    id: 'X10', file: OPS, tests: [TX],
    from: "  if (subtask.branch !== hold.branch) return",
    to: "  if (false) return",
    why: "a hold set on a branch the plan no longer names still applies",
    killed_by: [/orphanReason/, /changes the subtask's branch orphans its hold/],
  },
  {
    id: 'X11', file: OPS, tests: [TX],
    from: "  if (typeof hold.child === 'string' && typeof childNow === 'string' && childNow !== hold.child) {\n",
    to: "  if (false) {\n",
    why: 'a hold set on one child still applies to the next child of the subtask',
    killed_by: [/orphanReason/, /a different linked child orphans/],
  },
  {
    id: 'X12', file: OPS, tests: [TX],
    from: "  if (typeof hold.lane === 'string' && typeof laneNow === 'string' && !sameDir(laneNow, hold.lane)) {\n",
    to: "  if (typeof hold.lane === 'string' && laneNow !== undefined && !sameDir(laneNow ?? '', hold.lane)) {\n",
    why: "the absence of a lane orphans a hold: a held subtask whose unused lane was removed is given back",
    killed_by: /orphanReason/,
  },
  {
    id: 'X13', file: OPS, tests: [TX],
    from: "      writeWhole(st.hold.path, { ...hold, orphaned: { at: now().toISOString(), why } });\n",
    to: '',
    why: 'an orphaned hold is not recorded orphaned: it applies again',
    killed_by: /left the plan orphans its hold/,
  },
  {
    id: 'X14', file: OPS, tests: [TX],
    from: "      if (laneSeen) removeSubtaskFences(hold.lane, { macroId, subtaskId: id, keepHoldId: null });\n      appendHoldEvent(mainRoot, macroId, { event: 'orphaned'",
    to: "      appendHoldEvent(mainRoot, macroId, { event: 'orphaned'",
    why: "an orphaned hold's fence stays, fencing a lane no hold applies to",
    killed_by: /left the plan orphans its hold/,
  },
  {
    id: 'X15', file: OPS, tests: [TX],
    from: "        for (const r of [st.handoff, st.release]) if (r?.state === 'ok' && r.record.hold_id === hold.hold_id) unlinkQuiet(r.path);\n",
    to: '',
    why: 'I3: the records a retired or orphaned hold left are never removed',
    killed_by: /any reader removes what a retired or orphaned hold left/,
  },
  {
    id: 'X16', file: OPS, tests: [TX],
    from: "      if (open.length) out.push(\`a persona operation is open in subtask \${id}'s lane: \${describeOperations(open)}\`);\n",
    to: '',
    why: "a macro's end removes the holds directory under a persona operation still open",
    killed_by: /retires the whole holds directory/,
  },
  {
    id: 'X17', file: OPS, tests: [TX],
    from: "    if (others.length) out.push(live.why);\n",
    to: '',
    why: "a macro's end removes the holds directory under a live run of it",
    killed_by: /retires the whole holds directory/,
  },
  {
    id: 'X18', file: OPS, tests: [TX, TXR],
    from: "      for (const [id, l] of fenced) removeSubtaskFences(l, { macroId, subtaskId: id, keepHoldId: null });\n",
    to: '',
    why: "a macro's end leaves each held lane's fence, which nothing can name once the directory is gone",
    killed_by: [/retires the whole holds directory/, /a held lane alone closes/],
  },
  {
    id: 'X19', file: OPS, tests: [TX, TCU],
    from: "  if (applies.applies) {\n",
    to: "  if (false) {\n",
    why: "cutover moves a held lane's child from under the person working in it",
    killed_by: [/childWriteRefusal/, /refuses a held lane's child/],
  },
  {
    id: 'X20', file: OPS, tests: [TX, TCU],
    from: "  if (open.length) return \`a persona operation is open on ",
    to: "  if (false) return \`a persona operation is open on ",
    why: 'cutover moves a child under an open persona operation',
    killed_by: [/childWriteRefusal/, /refuses a held lane's child and one with an operation open/],
  },
  {
    id: 'X21', file: CU, tests: [TCU],
    from: "'nothing to move'] };\n    }\n    const held = await heldChildRefusals(main, plan.pairs);\n    if (held.length > 0) return { ok: false, refusals: held, plan };\n",
    to: "'nothing to move'] };\n    }\n",
    why: "a cutover writes its manifest before it refuses a held lane's child",
    killed_by: /--move refuses a held lane's child/,
  },
  {
    id: 'X22', file: CU, tests: [TCU],
    from: "  if (held.length > 0) return { ok: false, manifest: file, refusals: held };\n  // A move refused behind the writer exclusion refuses the command; the pairs\n  // moved before it stay recorded, and a rerun continues the manifest.\n  let movedNow;",
    to: "  // A move refused behind the writer exclusion refuses the command; the pairs\n  // moved before it stay recorded, and a rerun continues the manifest.\n  let movedNow;",
    why: "a rerun of an interrupted cutover moves a held lane's child",
    killed_by: /a rerun of an open manifest refuses/,
  },
  {
    id: 'X23', file: CU, tests: [TCU],
    from: "  if (held.length > 0) return { ok: false, manifest: file, refusals: held };\n  // Nothing more",
    to: "  // Nothing more",
    why: "an interrupted rollback turns the switch off and moves a held lane's child back",
    killed_by: /--rollback --move refuses a held lane's child/,
  },
  {
    id: 'X24', file: CU, tests: [TCU],
    from: "    if (!plan.ok) return { ok: false, refusals: plan.refusals, plan };\n    const held = await heldChildRefusals(main, plan.pairs);\n    if (held.length > 0) return { ok: false, refusals: held, plan };\n    const at = isoUtc(now);\n    const file = path.join(root, CUTOVER_RUNS_REL, \`\${at.replace(/[-:]/g, '')}-\${randomBytes(3).toString('hex')}.json\`);\n    const doc = {\n      schema: CUTOVER_MANIFEST_SCHEMA,\n      kind: 'rollback',",
    to: "    if (!plan.ok) return { ok: false, refusals: plan.refusals, plan };\n    const at = isoUtc(now);\n    const file = path.join(root, CUTOVER_RUNS_REL, \`\${at.replace(/[-:]/g, '')}-\${randomBytes(3).toString('hex')}.json\`);\n    const doc = {\n      schema: CUTOVER_MANIFEST_SCHEMA,\n      kind: 'rollback',",
    why: "a rollback writes its manifest before it refuses a held lane's child",
    killed_by: /--rollback --move refuses a held lane's child/,
  },
  {
    id: 'X25', file: ST, tests: [TX],
    from: "        if (flags.status === 'completed' && result.updatedSubtask?.status === 'completed') {\n",
    to: "        if (false) {\n",
    why: 'done completes a subtask and leaves its hold records: a completed lane parks on its release',
    killed_by: /held, committed, released, then recorded done/,
  },
  {
    id: 'X26', file: ST, tests: [TX],
    from: "            macroEnded: result.autoTerminal === true || result.frontmatter?.terminal_marker === true,\n",
    to: "            macroEnded: false,\n",
    why: "the write that ends the macro leaves its holds directory",
    killed_by: /completes the last subtask ends the macro/,
  },
  {
    id: 'X27', file: `${CMD}/done.md`, tests: [TX],
    from: "  node \"$CLAUDE_PLUGIN_ROOT/scripts/state.mjs\" holds-retire \\\n    --workflow-path \"$MACRO_PATH\" --subtask-id \"$SUBTASK_ID\" || true\n",
    to: '',
    why: "done's no-op path no longer finishes a retirement that waited",
    killed_by: /no-op path finishes it once the operation ends/,
  },
  {
    id: 'X28', file: `${SKILLS}/done/SKILL.md`, tests: [TX],
    from: "  node \"<orchestrator-plugin-root>/scripts/state.mjs\" holds-retire \\\n    --workflow-path \"$MACRO_PATH\" --subtask-id \"$SUBTASK_ID\" || true\n",
    to: '',
    why: "the Codex done's no-op path no longer finishes a retirement that waited",
    killed_by: /the Codex done mirror's no-op path retires too/,
  },
  ...['abort', 'finalize'].flatMap((name, i) => [
    {
      id: `X${29 + i * 4}`, file: `${CMD}/${name}.md`, tests: [TX],
      from: 'node "$ORCH_PLUGIN_ROOT/scripts/state.mjs" holds-preflight \\\n  --workflow-path "$MACRO_PATH" --engineer-root "$HOLDS_ENGINEER_ROOT" || exit 1\n',
      to: '',
      why: `${name} closes the macro beside an open persona operation`,
      killed_by: new RegExp(`${name}\\.md \\(bash\\): an open operation stops it`),
    },
    {
      id: `X${30 + i * 4}`, file: `${CMD}/${name}.md`, tests: [TX],
      from: 'node "$ORCH_PLUGIN_ROOT/scripts/state.mjs" holds-retire \\\n  --workflow-path "$MACRO_PATH" --macro-end true || true\n',
      to: '',
      why: `${name} leaves the ended macro's holds directory and its fences`,
      killed_by: new RegExp(`${name}\\.md \\(bash\\): an open operation stops it`),
    },
    {
      id: `X${31 + i * 4}`, file: `${SKILLS}/${name}/SKILL.md`, tests: [TX],
      from: 'node "<orchestrator-plugin-root>/scripts/state.mjs" holds-preflight \\\n  --workflow-path "$MACRO_PATH" --engineer-root "$HOLDS_ENGINEER_ROOT" || {\n',
      to: 'true || {\n',
      why: `the Codex ${name} closes the macro beside an open persona operation`,
      killed_by: new RegExp(`${name} \\(Codex mirror\\): the check runs before the bulk write`),
    },
    {
      id: `X${32 + i * 4}`, file: `${SKILLS}/${name}/SKILL.md`, tests: [TX],
      from: 'node "<orchestrator-plugin-root>/scripts/state.mjs" holds-retire \\\n  --workflow-path "$MACRO_PATH" --macro-end true || true\n',
      to: '',
      why: `the Codex ${name} leaves the ended macro's holds directory`,
      killed_by: new RegExp(`${name} \\(Codex mirror\\): the check runs before the bulk write`),
    },
  ]),
  {
    id: 'X37', file: OPS, tests: [TX],
    from: "    if (open.length) {\n      why.push(\`a persona operation is open in subtask \${id}'s lane:",
    to: "    if (false) {\n      why.push(\`a persona operation is open in subtask \${id}'s lane:",
    why: "abort and finalize close beside an open persona operation",
    killed_by: [/closeRefusals/, /holds-preflight: silent when off/],
  },
  {
    id: 'X38', file: OPS, tests: [TX],
    from: "    if (b.busy) why.push(\`subtask \${id}'s lane is busy: \${b.why}\`);\n",
    to: '',
    why: 'abort and finalize close beside a busy lane',
    killed_by: /closeRefusals/,
  },
  {
    id: 'X39', file: ST, tests: [TX],
    from: "            if (problem) why.push(\`the holds of \${ctx.macroId} are on, and \${problem}:",
    to: "            if (false) why.push(\`the holds of \${ctx.macroId} are on, and \${problem}:",
    why: "abort and finalize archive a held lane's child with an engineer that is not hold-aware",
    killed_by: /holds-preflight: silent when off/,
  },
  {
    id: 'X40', file: ST, tests: [TX],
    from: "          if (!ended) throw new Error(",
    to: "          if (false) throw new Error(",
    why: "the holds of a macro that has made no terminal write are retired (I3: only after it)",
    killed_by: /holds-retire: --macro-end before the terminal write/,
  },
  {
    id: 'X41', file: ST, tests: [TX],
    from: "      const live = where(id, 'workflows');\n",
    to: "      const live = { state: 'no' };\n",
    why: "the Stop sweep retires a live macro's holds",
    killed_by: /never a live macro's/,
  },
  {
    id: 'X42', file: SA, tests: [TXR],
    from: "    await retireEndedMacroHolds({ checkout: repoRoot, write: (s) => stderr.write(\`orchestrator/stop-archive: \${s}\`) });\n",
    to: '',
    why: "the Stop hook never retires an archived macro's holds a crash left",
    killed_by: /at the Stop sweep/,
  },
  {
    id: 'X43', file: SCH, tests: [TXR],
    from: "    await retireEnded();\n",
    to: '',
    why: "a run's start leaves orphaned holds and a completed subtask's records",
    killed_by: /a run's start orphans a hold/,
  },
  {
    id: 'X44', file: HCLI, tests: [TXR],
    from: "      for (const o of await orphanStale({ mainRoot, macroId, planNow, stateRoots: roots, laneOf: laneNow })) lines.push(",
    to: "      for (const o of []) lines.push(",
    why: 'status no longer orphans a hold its subtask left',
    killed_by: /status orphans and retires too/,
  },
  {
    id: 'X45', file: HCLI, tests: [TXR],
    from: "      const r = await retireMacroHolds({ mainRoot, macroId, subtasks, stateRoots: roots });\n",
    to: "      const r = { state: 'none' };\n",
    why: "status no longer retires an archived macro's holds directory",
    killed_by: /status orphans and retires too/,
  },
  {
    id: 'X46', file: HCLI, tests: [TK],
    from: "  if (macro.archived || macro.fm?.terminal_marker === true) {\n    return { problem: \`macro ",
    to: "  if (false) {\n    return { problem: \`macro ",
    why: "a hold is set on a macro that ended: its holds directory's retirement takes it, or it outlives the macro",
    killed_by: /refuses a subtask the plan closed/,
  },
  {
    id: 'X47', file: HCLI, tests: [TK],
    from: "  if (['completed', 'deferred', 'abandoned'].includes(s.status)) return { problem:",
    to: "  if (s.status === 'completed') return { problem:",
    why: 'a hold is set on a subtask the plan deferred or abandoned',
    killed_by: /refuses a subtask the plan closed/,
  },

  // ---- X (cont.): the Task 12 review's findings ---------------------------------
  {
    id: 'X48', file: OPS, tests: [TX],
    from: "      const open = laneOpen({ ...lane, exceptIds: [own] });\n      if (open.length) return { state: 'waiting'",
    to: "      const open = [];\n      if (open.length) return { state: 'waiting'",
    why: 'a persona first write that published between the first look and the exclusion record is not seen: the hold retires under it',
    killed_by: /publishes between the first look and the exclusion/,
  },
  {
    id: 'X49', file: OPS, tests: [TX, TV],
    from: "  for (const id of c.ids) if (!cleared.has(id) && !seen.has(id)) seen.set(id, { id, kind: null, from: 'entry' });\n",
    to: '',
    why: "an archived child's entry-only operation is not seen by the dispatch gate: a hand dispatch goes on into a lane whose archived child holds an open operation (retirement reads it through the hold's child too)",
    killed_by: /an archived linked child's open entry refuses a hand dispatch/,
  },
  {
    id: 'X50', file: OPS, tests: [TX],
    from: "    if (!(await stillCompleted())) return { state: 'none',",
    to: "    if (false) return { state: 'none',",
    why: 'a retirement acts on a stale look at the plan: a newer hold on a reused id is retired',
    killed_by: /a stale look at the plan retires nothing/,
  },
  {
    id: 'X51', file: OPS, tests: [TX],
    from: "        if (r.state === 'unreadable') out.push(\`\${r.path} cannot be read",
    to: "        if (false) out.push(\`\${r.path} cannot be read",
    why: "a macro's end removes a hold record that cannot be read, its fence left and its bytes lost",
    killed_by: /waits while a hold's record cannot be read/,
  },
  {
    id: 'X52', file: OPS, tests: [TX],
    from: "      const again = await blockers(own);\n      if (again.length) return { state: 'waiting', why: again.join('; ') };\n",
    to: '',
    why: "a macro's end removes the directory under a persona first write that published after its first look",
    killed_by: /publishes between the macro end's first look and its lock/,
  },
  {
    id: 'X53', file: OPS, tests: [TX],
    from: "      if (retired) fenced();\n",
    to: '',
    why: 'I3: a retirement a crash stopped before its fence went leaves the fence for good',
    killed_by: /stopped before its fence went is finished by the retry/,
  },
  {
    id: 'X54', file: OPS, tests: [TX],
    from: "    await sweepDeadExclusions({ mainRoot, macroId, subtaskId });\n    if (!(await stillCompleted()))",
    to: "    if (!(await stillCompleted()))",
    why: "a dead release's exclusion record keeps the retirement waiting forever",
    killed_by: /an exclusion a dead release left does not keep the retirement waiting/,
  },
  {
    id: 'X55', file: CU, tests: [TCU],
    from: "      ? await excludeChildWriters({ mainRoot: main, childPath: pair.source })\n",
    to: "      ? () => {}\n",
    why: 'a hold set after the checks, before the move, does not stop the move: the held child moves',
    killed_by: /a hold set after the checks, before the child's move/,
  },
  {
    id: 'X56', file: CU, tests: [TCU],
    from: "    if (!['workflow', 'archive'].includes(pair?.kind) || typeof pair.source !== 'string' || !present(pair.source)) continue;\n",
    to: "    if (pair?.kind !== 'workflow' || typeof pair.source !== 'string' || !present(pair.source)) continue;\n",
    why: "an archived child moves under its lane's open operation (a commit's continuation)",
    killed_by: /refuses a held lane's child and one with an operation open/,
  },
  {
    id: 'X57', file: ST, tests: [TX],
    from: "        if (err.code !== 'ENOENT' && err.code !== 'ENOTDIR') unknown = true;\n",
    to: '',
    why: "a workflow home that cannot be looked at reads as no live macro: the Stop sweep retires a live macro's holds",
    killed_by: /retires nothing while a workflow home of the macro cannot be looked at/,
  },
  {
    id: 'X58', file: ST, tests: [TX],
    from: "        for (const s of plan.filter((x) => x?.status === 'completed')) await retireCompletedHolds(",
    to: "        for (const s of []) await retireCompletedHolds(",
    why: 'a done retirement that waited is never finished by the Stop sweep',
    killed_by: /the Stop sweep finishes a done retirement that waited/,
  },
  {
    id: 'X59', file: HCLI, tests: [TX],
    from: "    if (macro.archived || macro.fm?.terminal_marker === true) {\n      const r = await retireMacroHolds(",
    to: "    if (macro.archived) {\n      const r = await retireMacroHolds(",
    why: "status leaves an ended (terminal, not yet archived) macro's holds directory",
    killed_by: /status retires an ended macro's directory/,
  },
  {
    id: 'X60', file: HCLI, tests: [TK],
    from: "again.live ? \`run \${again.runs[0]?.run_id ?? 'unknown'} completes",
    to: "again.live ? \`run \${live.runs[0].run_id} completes",
    why: 'a hold-aware run that started between the two looks crashes hold, leaving a pending hold whose id was never printed',
    killed_by: /second look finds a hold-aware run that started meanwhile/,
  },
  // ---- Q: a rebinding's blockers (Task 13; Decision 8, item 3) -----------------
  {
    id: 'Q1', file: OPS, tests: [TPR],
    from: "    case 'pending': why.push(",
    to: "    case 'pending': if (false) why.push(",
    why: 'a hold whose handoff is pending (the person may already be at work in the lane) lets the approval rebind its subtask',
    killed_by: /a pending or held subtask, or one whose release awaits its comparison, refuses/,
  },
  {
    id: 'Q2', file: OPS, tests: [TPR],
    from: "    case 'held': why.push(",
    to: "    case 'held': if (false) why.push(",
    why: 'a held subtask is rebound and told while the person works in its lane',
    killed_by: [/a pending or held subtask, or one whose release awaits its comparison, refuses/, /a delivery waits while its subtask is held/],
  },
  {
    id: 'Q3', file: OPS, tests: [TPR],
    from: "    case 'released-uncompared':\n      why.push(",
    to: "    case 'released-uncompared':\n      if (false) why.push(",
    why: 'a note lands in a lane whose release awaits its comparison, so the comparison rejects the release the note itself changed',
    killed_by: [/a pending or held subtask, or one whose release awaits its comparison, refuses/, /a delivery waits while its subtask is held or its release awaits its comparison/],
  },
  {
    id: 'Q4', file: OPS, tests: [TPR],
    from: '  if (open.length) {\n    why.push(`a persona operation is open in subtask ${subtaskId}\'s lane',
    to: '  if (false) {\n    why.push(`a persona operation is open in subtask ${subtaskId}\'s lane',
    why: 'an approval rebinds, and a delivery writes its note, mid-step beside an open persona operation',
    killed_by: /a persona operation open in the lane refuses the approval and the delivery/,
  },
  {
    id: 'Q5', file: OPS, tests: [TPR],
    from: "  if (a.state === 'unreadable') {\n    return [`the holds directory of ${macroId} cannot be read (${a.error}), so whether subtask ${subtaskId} is held cannot be told`];",
    to: "  if (false) {\n    return [`the holds directory of ${macroId} cannot be read (${a.error}), so whether subtask ${subtaskId} is held cannot be told`];",
    why: 'a holds marker that cannot be read is taken for no holds: a hold it hides is rebound',
    killed_by: /a holds marker that cannot be read refuses/,
  },
  {
    id: 'Q6', file: ST, tests: [TPR],
    from: '      ...view.rebindings.filter((e) => !kept(e)).map((e) => e.subtask),',
    to: '      ...view.rebindings.map((e) => e.subtask),',
    why: 'a rebinding carried as it was makes its subtask\'s hold refuse an approval of another subtask (the interim reader\'s scope)',
    killed_by: /an approval of another subtask carries a rebinding of a held subtask as it was/,
  },
  {
    id: 'Q7', file: ST, tests: [TPR],
    from: '      && h.from_digest === e.from_digest && h.to_digest === e.to_digest && canonicalJson(h.fields) === canonicalJson(e.fields));',
    to: '      && h.from_digest === e.from_digest && canonicalJson(h.fields) === canonicalJson(e.fields));',
    why: 'a change of a held subtask\'s rebinding passes as the rebinding the record holds when no note follows it (its child archived)',
    killed_by: /a change of an archived child's rebinding, which sends no note, is refused beside its hold/,
  },
  {
    id: 'Q9', file: ST, tests: [TPR],
    from: '(h) => h.subtask === e.subtask && h.child === e.child && h.child_state === e.child_state\n',
    to: '(h) => h.subtask === e.subtask && h.child === e.child\n',
    why: 'a rebinding whose child archived since is carried past its hold, and the record it rewrites makes the release\'s comparison reject it',
    killed_by: /a carried rebinding whose child archived since is recorded anew/,
  },
  {
    id: 'Q10', file: OPS, tests: [TPR],
    from: '  for (const o of childOpen()) if (!cleared.has(o.id) && !open.some((x) => x.id === o.id)) open.push(o);',
    to: '  for (const o of []) if (!cleared.has(o.id) && !open.some((x) => x.id === o.id)) open.push(o);',
    why: 'a child in the legacy workflow home, which the lane scan does not list, is rebound and told beside its open operation',
    killed_by: /a child in the legacy workflow home is read directly/,
  },
  {
    id: 'Q11', file: ST, tests: [TPR],
    from: "    const childPaths = typeof info.path === 'string' ? [info.path] : [];",
    to: '    const childPaths = [];',
    why: 'the delivery does not read the child it found: a legacy-home child is told beside its open operation',
    killed_by: /a child in the legacy workflow home is read directly/,
  },
  {
    id: 'Q12', file: OPS, tests: [TPR],
    from: '  if (!isSafeSubtaskId(subtaskId)) return [];\n  const childOpen',
    to: '  const childOpen',
    why: 'an approval of a plan id the plan accepts but no hold key throws on the path the hold records would have',
    killed_by: /a plan id that is no hold key is approved and told/,
  },
  {
    id: 'Q13', file: OPS, tests: [TPR],
    from: '  for (const o of childOpen()) if (!cleared.has(o.id) && !open',
    to: '  for (const o of childOpen()) if (!open',
    why: 'an operation the owner cleared still refuses through the child\'s own entry: writer-clear cannot end it',
    killed_by: /a persona operation open in the lane refuses the approval and the delivery, the holds off or on; cleared by the owner, it does not/,
  },

  // ---- T: the takeover acceptance (Task 14) ---------------------------------
  {
    id: 'T1', file: HCLI, tests: [TA],
    from: "best = { run: n, session: s.session_id, cwd: s.cwd ?? null, at };",
    to: "best = { run: n, session: s.session_id, cwd: null, at };",
    why: "`hold` no longer says where the lane's last session worked, so `claude --resume` of it is not run from the lane (item 5)",
    killed_by: /a person's verb in the held lane, its ensemble a barrier/,
  },
  {
    id: 'T2', file: OPS, tests: [TA],
    from: "      if (lane.laneRoot) removeFence(lane.laneRoot, hold.hold_id);\n      appendHoldEvent(mainRoot, macroId, { event: 'released'",
    to: "      appendHoldEvent(mainRoot, macroId, { event: 'released'",
    why: "the release command leaves its hold's fence in the lane: an older driver or a serial run beside it stays fenced out until a later repair (the scheduler's own repair at run start removes it, so only the command's own contract can tell)",
    killed_by: /the person's next step commit: the driver's commit step commits/,
  },
  {
    id: 'T3', file: OPS, tests: [TA],
    from: '  const roots = [...new Set([...stateRoots, ...(laneRoot ? [laneRoot] : [])])];',
    to: '  const roots = [...new Set([...stateRoots])];',
    why: "with shared creation off the lane's child, in the lane's own checkout, is not found: the handoff and the release miss its operations and digest",
    killed_by: /hold waits on the dispatched verb's operation, status completes the handoff once it closes/,
  },
  {
    id: 'T4', file: LD, tests: [TA],
    from: "    git(top, ['add', '-A', '--', '.'], env);",
    to: "    git(top, ['add', '-u', '--', '.'], env);",
    why: 'an edit of an untracked file after the release (the worker\'s new file) is not compared in: the release is consumed over it',
    killed_by: /a hand edit after the release rejects it/,
  },
  {
    id: 'T5', file: HCLI, tests: [TA],
    from: '  if (!again.live) handoff = await completeHandoff({ mainRoot, macroId: o.macro, subtaskId: o.subtask, stateRoots: [mainRoot] });',
    to: '  if (false) handoff = await completeHandoff({ mainRoot, macroId: o.macro, subtaskId: o.subtask, stateRoots: [mainRoot] });',
    why: '`hold` with no live run leaves the handoff pending: the person is told to wait for a run that is not there (item 4)',
    killed_by: /no child: a hold set before the run keeps A undispatched/,
  },
  {
    id: 'T6', file: HCLI, tests: [TA],
    from: '        handoff = await completeHandoff({ mainRoot, macroId, subtaskId: id, stateRoots: [mainRoot] });',
    to: "        handoff = { state: 'pending', blocker: null };",
    why: '`status` with no live run no longer completes a pending handoff once the lane is free, so a lane held with no run never shows held (item 4)',
    killed_by: /hold waits on the dispatched verb's operation, status completes the handoff once it closes/,
  },
  {
    id: 'T7', file: LD, tests: [TA],
    from: "    git(top, ['add', '-A', '--', '.'], env);",
    to: "    git(top, ['add', '-A', '-f', '--', '.'], env);",
    why: "the tree digest counts the lane's ignored state (the session capture the session's last turn writes after the release): a lane no one edited is rejected",
    killed_by: /the person's owner decision: the gate stays on the open workflow/,
  },
  {
    id: 'T8', file: OPS, tests: [TA],
    from: "    if (facts.state === 'ok' && facts.fields.pending_ensemble) out.push(`the child ${facts.fields.workflow_id} has a pending peer ensemble`);",
    to: '    // pending ensemble ignored',
    why: "the release no longer names the child's pending peer ensemble among what may still write the lane (item 7)",
    killed_by: /a person's verb in the held lane, its ensemble a barrier/,
  },
  {
    id: 'T9', file: ST, tests: [TA],
    from: '    const note = body.includes(heading)\n      ? \'\'',
    to: '    const note = true\n      ? \'\'',
    why: "the orchestrator's writer no longer notes a held lane's terminal commit on the macro (ADR-0062 Decision 2)",
    killed_by: /the person's commit: an operation through its archive and the real parent writeback/,
  },
  {
    id: 'T10', file: ENG_PHASE7, tests: [TA],
    from: '  if (whyOwner.length > 0) {',
    to: '  if (false) {',
    why: "the resumed worker's commit no longer stops for the owner on a tree the person left dirty outside its manifest",
    killed_by: /a hand edit in no manifest is compared in; the resumed worker's commit stops at the staging-set gate/,
  },
  {
    id: 'T11', file: HCLI, tests: [TK],
    from: '      if (run?.macro_id !== macroId) continue;\n',
    to: '',
    why: "`hold` names another macro's session for a subtask of the same id, so the person resumes the wrong lane's session (item 5)",
    killed_by: /names the lane's last session of this macro/,
  },
  {
    id: 'T12', file: ENG_STOP, tests: [TA],
    from: "    await noteParent({ frontmatter, commit: headSha, host, repoRoot, stderr, archivedPath: archiveResult.to });\n    // ADR-0068 Decision 2, item 7 — the commit's operation ran through the\n    // archive and the note: this ends it.\n    await closeArchivedCommit({ archivedPath: archiveResult.to, host, stderr });",
    to: "    await closeArchivedCommit({ archivedPath: archiveResult.to, host, stderr });\n    await noteParent({ frontmatter, commit: headSha, host, repoRoot, stderr, archivedPath: archiveResult.to });",
    why: "the commit's operation ends before the parent note, so a release inside the note's slot is taken while the parent is still written",
    killed_by: /the person's commit: an operation through its archive and the real parent writeback/,
  },
  {
    id: 'T13', file: H, tests: [TA],
    from: '  const add = (id, kind, from, error) => {\n    const cur = open.get(id);',
    to: "  const add = (id, kind, from, error) => {\n    if (kind === 'peer') return;\n    const cur = open.get(id);",
    why: "a peer consultation the session started (/engineer:peer-now) is no open operation to the orchestrator, so the release is taken while the peer runs",
    killed_by: /a peer run the session started itself \(\/engineer:peer-now\)/,
  },
  // ---- V: the whole-change critique's seams (refine of 2026-10-26) ------------
  {
    id: 'V1', file: OPS, tests: [TV],
    from: "      if (hold.prior !== undefined && hold.prior !== null) {\n        // The new hold's fence",
    to: "      if (false) {\n        // The new hold's fence",
    why: 'a hold set over a rejected release and withdrawn before its handoff writes `withdrawn` over the rejection, and the lane steps with no comparison (I12)',
    killed_by: /a hold over a rejected release, withdrawn before its handoff/,
  },
  {
    id: 'V2', file: OPS, tests: [TV],
    from: '    if (restorePrior({ mainRoot, macroId, subtaskId, hold: st.hold.record, hooks })) return true;\n',
    to: '',
    why: 'a hold `hold` withdraws because a blind run started unlinks its owner record, and the uncompared release it was set over is never compared',
    killed_by: /withdrawn because a blind run started/,
  },
  {
    id: 'V3', file: OPS, tests: [TV],
    from: "    const prior = st.state === 'rejected' || st.state === 'released-uncompared'\n",
    to: '    const prior = false\n',
    why: 'a new hold keeps nothing of the release it is set over, so its withdrawal cannot put that release back',
    killed_by: /a hold over a (rejected|uncompared) release/,
  },
  {
    id: 'V4', file: HCLI, tests: [TV],
    from: '  const lane = at ?? null;\n',
    to: '  const lane = at === undefined ? null : (at ?? mainRoot);\n',
    why: "`hold` records the main checkout as a hand-dispatched subtask's lane, and its fence would close the driver's own checkout",
    killed_by: /hand-dispatched subtask/,
  },
  {
    id: 'V5', file: OPS, tests: [TV],
    from: '  return sameDir(w, mainRoot) ? null : w;\n}',
    to: '  return w;\n}',
    why: "the main checkout counts as a hold's lane, so a fence closes the driver's own checkout",
    killed_by: /branchLane: a linked worktree is the lane|hand-dispatched subtask/,
  },
  {
    id: 'V6', file: OPS, tests: [TV],
    from: '    const child = hold.child ?? (lane.childPath ? readWorkflowFacts(lane.childPath).fields?.workflow_id ?? null : null);',
    to: '    const child = hold.child;',
    why: 'a hold set before its dispatch never learns its child, so after the child archives the release and the comparison both read no child, and an edit to it is consumed',
    killed_by: /the handoff records the child the lane has/,
  },
  {
    id: 'V7', file: OPS, tests: [TV],
    from: "    const hold = { ...st.hold.record, child: (typeof release.basis?.child === 'string' ? release.basis.child : null) ?? heldChild(st).child };",
    to: '    const hold = st.hold.record;',
    why: "the comparison looks for the archived child by the owner's record alone, so a child the release read is not found and an unchanged lane is rejected",
    killed_by: /the child archived before the release, unchanged since, is consumed/,
  },
  {
    id: 'V8', file: H, tests: [TV],
    from: "  '.agentic-plugins/state/engineer', '.agentic-plugins/state/designer', '.agentic-plugins/state/founder', '.claude/agentic-engineer',\n",
    to: "  '.agentic-plugins/state/engineer', '.agentic-plugins/state/designer', '.agentic-plugins/state/founder',\n",
    why: "a child in the legacy engineer home is invisible to the lane's scans, so a handoff acks beside its open operation",
    killed_by: /legacy engineer home/,
  },
  {
    id: 'V9', file: OPS, tests: [TV],
    from: "    if (facts.state !== 'ok') { unreadable = true; files.push(file); continue; }",
    to: "    if (facts.state !== 'ok') { if (wf.linked.includes(file)) unreadable = true; continue; }",
    why: "an archived workflow that cannot be read is passed over, so a retirement proceeds beside an operation it may carry (fails open)",
    killed_by: /an archived workflow that cannot be read/,
  },
  {
    id: 'V10', file: H, tests: [TV],
    from: "  if (bad !== null) return { state: 'unreadable'",
    to: "  if (false) return { state: 'unreadable'",
    why: 'a torn quoted scalar reads as no value, so a child with an open operation drops out of every scan of its branch (fails open)',
    killed_by: /a torn quoted branch line/,
  },
  {
    id: 'V11', file: OPS, tests: [TV],
    from: '  await withHoldsLock(mainRoot, macroId, async () => {\n    for (const id of lanes().keys()) await sweepDeadExclusions({ mainRoot, macroId, subtaskId: id });\n  });\n',
    to: '',
    why: "a macro's end whose earlier retirement crashed counts that retirement's exclusion open at its first look, and waits forever",
    killed_by: /earlier retirement crashed/,
  },
  {
    id: 'V12', file: OPS, tests: [TV],
    from: '  await sweepChildExclusions({ mainRoot, childPath });\n  const first',
    to: '  const first',
    why: "a move whose earlier move crashed is refused by that move's dead exclusion, for good",
    killed_by: /earlier move crashed/,
  },
  {
    id: 'V13', file: OPS, tests: [TV],
    from: '  if (!isSafeSubtaskId(subtaskId)) return { active: false, why: null };\n  const a = readActivation(mainRoot, macroId);',
    to: '  const a = readActivation(mainRoot, macroId);',
    why: 'a plan id that is no hold key (`task:13`) throws in the hand dispatch\'s gate once the holds are on, so it cannot be dispatched',
    killed_by: /no refusal, no mark, nothing to retire|state\.mjs hold-gate and dispatch-mark-publish pass it/,
  },
  {
    id: 'V15', file: OPS, tests: [TV],
    from: "  if (!isSafeSubtaskId(subtaskId) || dirState(holdsDir(mainRoot, macroId)).state === 'absent') return { state: 'none' };",
    to: "  if (dirState(holdsDir(mainRoot, macroId)).state === 'absent') return { state: 'none' };",
    why: "a completed subtask whose plan id is no hold key throws in its retirement, which skips the macro's end and the subtasks after it",
    killed_by: /no refusal, no mark, nothing to retire/,
  },
  {
    id: 'V16', file: SCH, tests: [TSV],
    from: '      if (r.held) { res.again = true; return true; }\n',
    to: '',
    why: "a hold set between the decision and an admission stops the whole wave, and the run ends on the owner's lane while another is ready",
    killed_by: /set before the creation: no lane is created for it, and the wave goes on/,
  },
  {
    id: 'V17', file: SCH, tests: [TSV],
    from: '      if (gateOf(id)) return { ...refuse(null), again: false, held: true };\n      const occupiedNow',
    to: '      const occupiedNow',
    why: 'a hold set while the creation awaited its marker no longer stops the creation: a lane is created for a held subtask',
    killed_by: /set before the creation: no lane is created for it/,
  },
  {
    id: 'V18', file: SCH, tests: [TSV],
    from: '    if (gateOf(id)) return { ...refuse(null), again: false, held: true };\n    const occupiedLast',
    to: '    const occupiedLast',
    why: "a hold set after the lane was created no longer stops the spawn: a worker runs in the owner's lane",
    killed_by: /set after the lane was created/,
  },
  {
    id: 'V19', file: SCH, tests: [TSV],
    from: "    if (gateOf(id)) { lane(id).note = 'held: kept'; return; }\n",
    to: '',
    why: "a created lane a hold then stopped is removed as unused, under the person who holds it",
    killed_by: /set after the lane was created/,
  },
  {
    id: 'V20', file: SCH, tests: [TSV],
    from: '    out(`  lane ${id}: waits: ${line}`);\n',
    to: '',
    why: 'a lane held back by an open operation waits silently: nothing names the operation or the writer-clear command',
    killed_by: /names it, and the command that clears it/,
  },
  {
    id: 'V21', file: SCH, tests: [TSV],
    from: '    return `a persona operation is open in it: ${describeOperations(open)}; when its session is gone, the owner clears it: ${clears.length ? clears.join(\'; \') : `agentic-autopilot writer-clear ${id} --macro ${macroId} --operation <id>`}`;',
    to: '    return true;',
    why: "the hold-back's line names neither the operation nor the owner's way out",
    killed_by: /names it, and the command that clears it/,
  },
  {
    id: 'V22', file: SCH, tests: [TSV],
    from: '    if (mine?.rejected_release === releaseId) {\n      if (mine.kept !== false) return false;',
    to: '    if (mine?.rejected_release === releaseId && mine.kept !== false) {\n      if (mine.kept !== false) return false;',
    why: 'a rejected release whose park cannot be kept is parked afresh at every pass, watched afresh, and the run never ends',
    killed_by: /records cannot take is parked once, and the run still ends/,
  },
  {
    id: 'V23', file: SCH, tests: [TSV],
    from: "      if (why === 'released') {\n        parked.delete(id);",
    to: '      if (false) {\n        parked.delete(id);',
    why: "a held lane whose kept park the owner released is judged again at every tick, and the run never ends",
    killed_by: /kept park that goes while the run lives/,
  },
  {
    id: 'V24', file: SCH, tests: [TSV],
    from: "    if (gateOf(id)) {\n      if (why === 'released') {",
    to: "    if (false) {\n      if (why === 'released') {",
    why: "a held lane whose kept park goes is picked up again, and its rows reconciled, while the owner holds it",
    killed_by: /kept park that goes while the run lives/,
  },
  {
    id: 'V25', file: SCH, tests: [TSV],
    from: "      if (parked.has(id)) continue;\n      // Its gate went",
    to: "      // Its gate went",
    why: 'a lane the relaunch passed by whose hold ends has the park that still stands deleted, and steps though nothing resolved it',
    killed_by: /keeps the park that still stands/,
  },
  {
    id: 'V26', file: OPS, tests: [TD],
    from: '  return Boolean(a && b) && a.fingerprint_version === b.fingerprint_version && a.fingerprint === b.fingerprint\n',
    to: '  return Boolean(a && b) && a.fingerprint_version === b.fingerprint_version\n',
    why: "the comparison ignores the fingerprint, so a change only it sees (the lane's ignored state) is consumed",
    killed_by: /basesEqual: every clause decides|an ignored file the fingerprint reads/,
  },
  {
    id: 'V27', file: OPS, tests: [TD],
    from: '  return Boolean(a && b) && a.fingerprint_version === b.fingerprint_version && a.fingerprint === b.fingerprint\n',
    to: '  return Boolean(a && b) && a.fingerprint === b.fingerprint\n',
    why: 'two fingerprints of different versions are compared as if one, though their inputs differ',
    killed_by: /basesEqual: every clause decides/,
  },
  {
    id: 'V28', file: OPS, tests: [TD],
    from: '    && a.tree_digest === b.tree_digest && a.content_digest === b.content_digest && (a.child ?? null) === (b.child ?? null);',
    to: '    && a.tree_digest === b.tree_digest && a.content_digest === b.content_digest;',
    why: 'a different child after the release (a new dispatch) is consumed when its digests happen to match',
    killed_by: /basesEqual: every clause decides/,
  },
  {
    id: 'V29', file: OPS, tests: [TV],
    from: '        if (lane.laneRoot) removeFence(lane.laneRoot, hold.hold_id);\n        if (hooks.beforeRestore) hooks.beforeRestore();\n',
    to: '        if (hooks.beforeRestore) hooks.beforeRestore();\n',
    why: "a withdrawal that puts the earlier hold back leaves the new hold's fence, which nothing names any more: a rival in the lane's lock for good",
    killed_by: /release --hold of the new hold removes its fence/,
  },
  {
    id: 'V30', file: OPS, tests: [TV],
    from: "    if (typeof l === 'string' && laneThere(l)) removeFence(l, holdId);\n",
    to: '',
    why: "hold's own withdrawal beside a blind run leaves the withdrawn hold's fence in the lane",
    killed_by: /hold's own withdrawal \(a blind run\) removes it too/,
  },
  {
    id: 'V31', file: OPS, tests: [TV],
    from: '      childPath = a.latest;\n',
    to: '      childPath = null;\n',
    why: 'a child archived before the handoff of a hold that names none is not found, so the release reads no child and an edit to it is consumed',
    killed_by: /a child archived before the handoff is found by its linkage/,
  },
  {
    id: 'V32', file: OPS, tests: [TV],
    from: '        if (!best || t > best.t) best = { file, t };',
    to: '        if (!best) best = { file, t };',
    why: "of a subtask's archived children the first listed is taken for the lane's, not the latest",
    killed_by: /the latest is the lane's/,
  },
  {
    id: 'V33', file: CU, tests: [TCU],
    from: '    await sweepChildExclusions({ mainRoot: main, childPath: pair.source });\n',
    to: '',
    why: "cutover's first check counts a crashed move's exclusion open, so the move is refused for good",
    killed_by: /whose earlier move crashed with its exclusion published/,
  },
  {
    id: 'Y1', file: OPS, tests: [TV],
    from: "    if (before.length) return { verdict: 'refused', why: before.join('; ') };\n    if (hooks.beforeExclusion) await hooks.beforeExclusion();\n",
    to: "    if (hooks.beforeExclusion) await hooks.beforeExclusion();\n",
    why: "the comparison's first look goes: a child with a pending peer ensemble (or its workflow lock held) has its release consumed beside that writer",
    killed_by: /the child's pending peer ensemble refuses the comparison/,
  },
  {
    id: 'Y2', file: OPS, tests: [TV],
    from: "      if (lane.blockers.length) return { verdict: 'refused', why: lane.blockers.join('; ') };\n",
    to: "",
    why: "a workflow begun on the branch between the comparison's first look and its exclusion record is not seen: the release is consumed beside it",
    killed_by: /one begun between the first look and the exclusion record refuses too/,
  },
  {
    id: 'Y3', file: OPS, tests: [TV],
    from: "      for (const u of a.unreadable) blockers.push(`${u.file} cannot be read (${u.error}), and it may be the lane's archived child`);\n",
    to: "",
    why: "an archived workflow that cannot be read is passed over for a hold that names no child: its handoff acks and its release goes on beside an operation it may carry",
    killed_by: /the handoff stays pending, naming it/,
  },
  {
    id: 'Y4', file: OPS, tests: [TV],
    from: "        if (err.code !== 'ENOENT') unreadable.push({ file: dir, error: `cannot list it (${err.code || err.message})` });\n",
    to: "",
    why: "an archive directory that cannot be listed reads as empty",
    killed_by: /an archive directory that cannot be listed blocks too/,
  },
  {
    id: 'Y5', file: OPS, tests: [TV],
    from: "  if (c.unreadable && more.length) {\n",
    to: "  if (false) {\n",
    why: "an archived workflow that cannot be read no longer counts open in the lane's operations: retirement goes on beside it",
    killed_by: /an archived workflow that cannot be read keeps a completed subtask's retirement waiting/,
  },
  {
    id: 'Y6', file: OPS, tests: [TV],
    from: "  return [...ids].some((id) => !cleared.has(id) && !before.has(id));\n",
    to: "  return [...ids].some((id) => !cleared.has(id));\n",
    why: "a re-attach's handover counts an archived child's operation from before the check: a later prelude passes into a held lane",
    killed_by: /the re-attach handover counts only an operation begun since the check passed/,
  },
  {
    id: 'Y7', file: ST, tests: [TN],
    from: "        if (check && earlier !== null && dispatchHandedOver(",
    to: "        if (check && mark.active && earlier !== null && dispatchHandedOver(",
    why: "a dispatch whose holds were off at the switch is refused by every later prelude once a hold turns them on, though its engineer holds the lane",
    killed_by: /a dispatch whose holds were off at the switch passes the prelude again/,
  },
  {
    id: 'Y8', file: ST, tests: [TN],
    from: "          rmSync(checkedFile, { force: true });\n",
    to: "",
    why: "a check that refuses, or fails on an error, leaves the earlier pass behind, and Phase 5 records the dispatch",
    killed_by: /a later prelude that refuses removes the earlier pass|takes its earlier pass away/,
  },
  {
    id: 'Y9', file: NEXT_MD, tests: [TN],
    from: "writer-clear ends it).\" >&2\n  exit 1\n",
    to: "writer-clear ends it).\" >&2\n",
    why: "Phase 5 records a dispatch whose mark file is gone, which no check passed",
    killed_by: /a dispatch whose mark file is gone is not recorded in progress/,
  },
  {
    id: 'Y10', file: OPS, tests: [TV],
    from: "  for (const kind of ['holds', 'handoffs', 'releases', 'parks']) {\n    const l = listRecordIds(mainRoot, macroId, kind);\n    if (l.state === 'unreadable') why.push(",
    to: "  for (const kind of ['holds', 'releases', 'parks']) {\n    const l = listRecordIds(mainRoot, macroId, kind);\n    if (l.state === 'unreadable') why.push(",
    why: "abort's and finalize's check does not read the handoffs directory: a handoff only it names is not judged",
    killed_by: /a handoff the plan does not name/,
  },
  {
    id: 'Y11', file: OPS, tests: [TV],
    from: "      if (r.state === 'unreadable') why.push(`subtask ${id}'s ${what} record cannot be read",
    to: "      if (false) why.push(`subtask ${id}'s ${what} record cannot be read",
    why: "an unreadable handoff or release record does not stop abort or finalize, whose bulk write then lands before the retirement refuses",
    killed_by: /an unreadable handoff record refuses the close/,
  },
  {
    id: 'Y12', file: HCLI, tests: [TK],
    from: "        for (const l of lanes) removeSubtaskFences(",
    to: "        for (const l of [replacement.lane].filter((x) => x && fs.existsSync(x))) removeSubtaskFences(",
    why: "a discard takes the unreadable hold's fences from the replacement's lane only: one in the lane a plan revision moved the subtask from is stranded",
    killed_by: /takes the old hold's fence from every worktree/,
  },
  {
    id: 'Y13', file: OPS, tests: [TK],
    from: "    if (st.state === 'pending' && !comparesOnRelease(hold)) {\n",
    to: "    if (st.state === 'pending') {\n",
    why: "a hold a discard touched is withdrawn with nothing to compare: a lane its person still edits is given back, and a rejection is dropped",
    killed_by: /a discarded handoff: the release is compared/,
  },
  {
    id: 'Y14', file: HCLI, tests: [TK],
    from: "          state: 'held', set_by: 'discard', set_at: new Date().toISOString(), compare_on_release: true,\n",
    to: "          state: 'held', set_by: 'discard', set_at: new Date().toISOString(),\n",
    why: "a discarded owner record's replacement, pending beside the old acked handoff, is withdrawn uncompared",
    killed_by: /a discarded owner's record beside an acked handoff/,
  },
  {
    id: 'Y15', file: HCLI, tests: [TK],
    from: "        markCompared();\n        if (hooks.beforeDependentWrite) hooks.beforeDependentWrite(kind);\n        unlinkQuiet(file);\n",
    to: "        if (hooks.beforeDependentWrite) hooks.beforeDependentWrite(kind);\n        unlinkQuiet(file);\n",
    why: "a discarded handoff turns a held hold pending, which a release then withdraws with nothing to compare",
    killed_by: /a discarded handoff: the release is compared/,
  },
  {
    id: 'Y16', file: HCLI, tests: [TK],
    from: "        markCompared();\n        if (hooks.beforeDependentWrite) hooks.beforeDependentWrite(kind);\n        writeWhole(file,",
    to: "        if (hooks.beforeDependentWrite) hooks.beforeDependentWrite(kind);\n        writeWhole(file,",
    why: "a discarded release's rejection is overwritten by a withdrawal of the pending hold (I12)",
    killed_by: /a discarded release of a pending hold counts as rejected/,
  },
  {
    id: 'Y17', file: SCH, tests: [TSV],
    from: "      // A gated lane's changes are its person's, never its resolution: the\n      // run does not wait on them (pollWake).\n      if (gateOf(id)) continue;\n",
    to: "",
    why: "a held lane's kept park keeps the run waiting while its person works: each change resets the quiet clock",
    killed_by: /the person working in it never keeps the run from ending/,
  },
  {
    id: 'Y18', file: SCH, tests: [TSV],
    from: "      if (!why && rec.state === 'parked' && !gateOf(id)) {\n",
    to: "      if (!why && rec.state === 'parked') {\n",
    why: "the run's end takes a held lane's fingerprint, a look inside the owner's lane",
    killed_by: /the run's end never takes a held lane's fingerprint/,
  },
  {
    id: 'Y19', file: OPS, tests: [TV],
    from: "  writeWhole(recordPath(mainRoot, macroId, 'releases', subtaskId), p.release);\n  // Tests: a crash between the two writes.\n  if (hooks.betweenRestoreWrites) hooks.betweenRestoreWrites();\n  writeWhole(recordPath(mainRoot, macroId, 'holds', subtaskId), p.hold);\n",
    to: "  writeWhole(recordPath(mainRoot, macroId, 'holds', subtaskId), p.hold);\n  // Tests: a crash between the two writes.\n  if (hooks.betweenRestoreWrites) hooks.betweenRestoreWrites();\n  writeWhole(recordPath(mainRoot, macroId, 'releases', subtaskId), p.release);\n",
    why: "a withdrawal puts the earlier hold's record back before its release: a crash between leaves a released hold with no release, which no retry withdraws",
    killed_by: /a crash between the release's restoration and the owner record's leaves the new hold pending/,
  },
  {
    id: 'Y20', file: OPS, tests: [TV],
    from: "        if (lane.laneRoot) removeFence(lane.laneRoot, hold.hold_id);\n        if (hooks.beforeRestore) hooks.beforeRestore();\n        restorePrior({ mainRoot, macroId, subtaskId, hold, hooks });\n",
    to: "        if (hooks.beforeRestore) hooks.beforeRestore();\n        restorePrior({ mainRoot, macroId, subtaskId, hold, hooks });\n        if (lane.laneRoot) removeFence(lane.laneRoot, hold.hold_id);\n",
    why: "the release's withdrawal removes the new hold's fence only after the earlier hold is back: a crash between strands a fence nothing names",
    killed_by: /release: the new hold's fence is gone before the earlier hold comes back/,
  },
  {
    id: 'Y21', file: OPS, tests: [TV],
    from: "    if (typeof l === 'string' && laneThere(l)) removeFence(l, holdId);\n    if (hooks.beforeRestore) hooks.beforeRestore();\n    if (restorePrior({ mainRoot, macroId, subtaskId, hold: st.hold.record, hooks })) return true;\n",
    to: "    if (hooks.beforeRestore) hooks.beforeRestore();\n    if (restorePrior({ mainRoot, macroId, subtaskId, hold: st.hold.record, hooks })) { if (typeof l === 'string' && laneThere(l)) removeFence(l, holdId); return true; }\n    if (typeof l === 'string' && laneThere(l)) removeFence(l, holdId);\n",
    why: "hold's own withdrawal removes the new hold's fence only after the earlier hold is back",
    killed_by: /withdrawUnhandedHold: the new hold's fence is gone before the earlier hold comes back/,
  },
  {
    id: 'Y22', file: OPS, tests: [TV],
    from: "    if (st.state !== 'pending' || st.hold.record.hold_id !== holdId) return false;\n",
    to: "    if (st.hold.record.hold_id !== holdId) return false;\n",
    why: "hold's withdrawal of an unhanded hold withdraws a hold already handed over",
    killed_by: /withdrawUnhandedHold withdraws only the pending hold it names/,
  },
  {
    id: 'Y23', file: OPS, tests: [TV],
    from: "    if (st.state !== 'pending' || st.hold.record.hold_id !== holdId) return false;\n",
    to: "    if (st.state !== 'pending') return false;\n",
    why: "hold's withdrawal of an unhanded hold withdraws another hold than the one it set",
    killed_by: /withdrawUnhandedHold withdraws only the pending hold it names/,
  },
  {
    id: 'Y24', file: OPS, tests: [TV],
    from: "  if (!validHold(p?.hold, subtaskId) || !validRelease(p?.release, subtaskId) || p.release.hold_id !== p.hold.hold_id) {\n",
    to: "  if (false) {\n",
    why: "a withdrawal writes back a prior release that cannot be read, losing it (I12)",
    killed_by: /a prior release that cannot be read refuses the withdrawal/,
  },
  {
    id: 'Y25', file: OPS, tests: [TV],
    from: "        if (f.fields.parent_workflow !== macroId || f.fields.originating_subtask !== subtaskId || f.fields.branch !== branch) continue;\n",
    to: "        if (f.fields.branch !== branch) continue;\n",
    why: "another subtask's or macro's archived workflow on the branch is taken for the lane's child",
    killed_by: /the latest archived child is the subtask's own/,
  },
  {
    id: 'Y26', file: HCLI, tests: [TK],
    from: "        markCompared();\n        if (hooks.beforeDependentWrite) hooks.beforeDependentWrite(kind);\n        unlinkQuiet(file);\n",
    to: "        if (hooks.beforeDependentWrite) hooks.beforeDependentWrite(kind);\n        unlinkQuiet(file);\n        markCompared();\n",
    why: "a discarded handoff goes before its hold is marked compared: a crash between leaves a pending hold a release withdraws uncompared",
    killed_by: /a discarded handoff: the release is marked compared before the record it depends on changes/,
  },
  {
    id: 'Y27', file: HCLI, tests: [TK],
    from: "    const roots = repositoryRoots(mainRoot);\n",
    to: "    let roots = []; try { roots = repositoryRoots(mainRoot); } catch { /* the replacement's lane alone */ }\n",
    why: "a discard whose worktrees git cannot list replaces the owner record anyway, stranding the old fences nothing names any more",
    killed_by: /git that cannot list the worktrees refuses the discard/,
  },
  {
    id: 'Y28', file: OPS, tests: [TV],
    from: "      for (const u of a.unreadable) blockers.push(`${u.file} cannot be read (${u.error}), and it may hold the lane's archived child ${hold.child}`);\n",
    to: "",
    why: "a named archived child whose archive cannot be looked at reads as absent: the handoff acks and the release and comparison read no child",
    killed_by: /a hold that names its child: an archive that cannot be looked at/,
  },
  {
    id: 'Y29', file: OPS, tests: [TV],
    from: "        if (err.code !== 'ENOENT') unreadable.push({ file, error: err.code || err.message });\n",
    to: "",
    why: "a stat of a named archived child that fails for any reason is read as its absence",
    killed_by: /a hold that names its child: an archive that cannot be looked at/,
  },
  {
    id: 'Z1', file: OPS, tests: [TV],
    from: "    if (err.code === 'ENOENT') return false;\n",
    to: "    return false;\n",
    why: "a lane's worktree whose stat fails for any reason is read as gone: its fence is passed over and its basis is a lane with no worktree",
    killed_by: /cannot be looked at|blind run\) refuses|a fence repair, a retirement/,
  },
  {
    id: 'Z2', file: OPS, tests: [TV],
    from: "    if (lane.laneError) throw new HoldRefusal(lane.laneError, 'lane-unreadable');\n",
    to: "",
    why: "a pending hold whose lane cannot be looked at is withdrawn, its fence left behind unnamed",
    killed_by: /the handoff stays pending, naming it; a release, a withdrawal and a new hold refuse/,
  },
  {
    id: 'Z3', file: OPS, tests: [TV],
    from: "  const blockers = laneError ? [laneError] : [];\n",
    to: "  const blockers = [];\n",
    why: "a lane that cannot be looked at blocks nothing: the handoff acks a lane it never fenced",
    killed_by: /the handoff stays pending, naming it/,
  },
  {
    id: 'Z4', file: OPS, tests: [TV],
    from: "      return { state: 'waiting', why: err.message, holdId: h.hold_id ?? null };\n",
    to: "      laneSeen = false;\n",
    why: "a retirement retires a hold whose lane cannot be looked at, its fence left named by nothing",
    killed_by: /a fence repair, a retirement, an orphaning and a macro end wait/,
  },
  {
    id: 'Z5', file: OPS, tests: [TV],
    from: "        if (laneSeen === null) continue;\n",
    to: "",
    why: "an orphaning orphans a hold whose lane cannot be looked at without removing its fence",
    killed_by: /a fence repair, a retirement, an orphaning and a macro end wait/,
  },
  {
    id: 'Z6', file: OPS, tests: [TV],
    from: "          return { state: 'waiting', why: `subtask ${id}: ${err.message}` };\n",
    to: "",
    why: "a macro's end moves the holds away while a lane's fence cannot be seen, leaving it named by nothing",
    killed_by: /a fence repair, a retirement, an orphaning and a macro end wait/,
  },
  {
    id: 'Z7', file: OPS, tests: [TV],
    from: "      return { repaired: 'none', blocker: err.message };\n",
    to: "      return { repaired: 'none' };\n",
    why: "a fence repair that cannot look at the lane says nothing, as if it had nothing to repair",
    killed_by: /a fence repair, a retirement, an orphaning and a macro end wait/,
  },
  {
    id: 'Z8', file: OPS, tests: [TV],
    from: "    if (typeof l === 'string' && laneThere(l)) removeFence(l, holdId);\n    if (hooks.beforeRestore)",
    to: "    if (typeof l === 'string' && laneSeenNow(l)) removeFence(l, holdId);\n    if (hooks.beforeRestore)",
    why: "hold's own withdrawal goes on beside a lane it cannot look at, its fence left named by nothing",
    killed_by: /blind run\) refuses, its fence left in place/,
  },
  {
    id: 'Z9', file: OPS, tests: [TV],
    from: "filter((l) => typeof l === 'string' && laneThere(l));\n",
    to: "filter((l) => typeof l === 'string' && laneSeenNow(l));\n",
    why: "a new hold over a lane it cannot look at is written, the earlier hold's fence passed over",
    killed_by: /the handoff stays pending, naming it; a release, a withdrawal and a new hold refuse/,
  },
  {
    id: 'Z10', file: OPS, tests: [TV],
    from: "        if (!found.some((f) => f.dev === dev && f.ino === ino)) found.push({ file, dev, ino });\n",
    to: "        return { file, unreadable, others: [] };\n",
    why: "the named child's first copy is accepted before the later roots are looked in: a copy there, unreadable or holding an open operation, is never seen",
    killed_by: /a later root's copy that cannot be looked at blocks|two copies in two roots block/,
  },
  {
    id: 'Z11', file: OPS, tests: [TV],
    from: "      if (a.others.length) blockers.push(",
    to: "      if (false) blockers.push(",
    why: "a child archived in two roots is read from the first, the other copy's open operation passed over",
    killed_by: /two copies in two roots block/,
  },
  {
    id: 'Z12', file: ST, tests: [TN],
    from: "        if ((subcommand === 'dispatch-mark-check' || subcommand === 'dispatch-mark-publish') && flags['mark-file']) {\n          rmSync(checkedFile, { force: true });\n        }\n        const macroPath = flags['workflow-path'];\n        const stateRoot = workflowStateRoot(macroPath);\n        if (stateRoot === null) throw new Error(`${macroPath} is under no state home, so its holds cannot be read`);\n        const mainRoot = mainWorktreeRoot(stateRoot);\n        const macroId = basename(macroPath, '.md');\n        // A plan id that is no hold key is judged as a macro whose holds are\n        // off: no hold is kept for it (hold-ops.mjs handDispatchRefusal).\n        const subtaskId = flags['subtask-id'];\n        const branch = flags.branch;\n        const stateRoots = [...new Set([mainRoot, ...repositoryRoots(flags.checkout)])];\n",
    to: "        const macroPath = flags['workflow-path'];\n        const stateRoot = workflowStateRoot(macroPath);\n        if (stateRoot === null) throw new Error(`${macroPath} is under no state home, so its holds cannot be read`);\n        const mainRoot = mainWorktreeRoot(stateRoot);\n        const macroId = basename(macroPath, '.md');\n        // A plan id that is no hold key is judged as a macro whose holds are\n        // off: no hold is kept for it (hold-ops.mjs handDispatchRefusal).\n        const subtaskId = flags['subtask-id'];\n        const branch = flags.branch;\n        const stateRoots = [...new Set([mainRoot, ...repositoryRoots(flags.checkout)])];\n        if ((subcommand === 'dispatch-mark-check' || subcommand === 'dispatch-mark-publish') && flags['mark-file']) {\n          rmSync(checkedFile, { force: true });\n        }\n",
    why: "a check that fails while it lists the repository's worktrees leaves the earlier pass, and Phase 5 records the dispatch past a hold",
    killed_by: /fails in its discovery/,
  },
  {
    id: 'M1', file: DRV, tests: [TC],
    from: "      .filter(([, s]) => s.state === 'released-uncompared' || (s.state === 'consumed' && s.release?.record?.park_ended !== true));\n",
    to: "      .filter(() => false);\n",
    why: "a serial run starts beside a release no run compared, and steps the lane on what the person left (I10)",
    killed_by: /refuses beside a release awaiting its comparison/,
  },
  {
    id: 'M2', file: DRV, tests: [TC],
    from: "s.state === 'released-uncompared' || (s.state === 'consumed' && s.release?.record?.park_ended !== true)",
    to: "s.state === 'released-uncompared'",
    why: "a serial run starts beside a consumption whose park the lanes run has not ended yet",
    killed_by: /refuses beside a release awaiting its comparison/,
  },
  {
    id: 'M3', file: ST, tests: [TX],
    from: "stateRoots: ctx.stateRoots, exceptRun: process.env.AGENTIC_AUTOPILOT || null });",
    to: "stateRoots: ctx.stateRoots });",
    why: "the autopilot's finalize worker, which names no lane, makes every lane busy: every finalize of a macro whose holds are on refuses",
    killed_by: /holds-preflight under an autopilot run/,
  },
  {
    id: 'M4', file: OPS, tests: [TX],
    from: "    const b = await laneBusy(mainRoot, macroId, id, { ...(probe ? { probe } : {}), exceptRun });\n    if (b.busy) why.push(`subtask ${id}'s lane is busy: ${b.why}`);",
    to: "    const b = await laneBusy(mainRoot, macroId, id, probe ? { probe } : {});\n    if (b.busy) why.push(`subtask ${id}'s lane is busy: ${b.why}`);",
    why: "closeRefusals drops the caller's run: the finalize worker's own entry refuses the close",
    killed_by: /holds-preflight under an autopilot run/,
  },
  {
    id: 'M5', file: SCH, tests: [TLG],
    from: "        if (now() - busyIdleSince < busyWaitMs) { await nextEvent(); continue; }\n",
    to: "        { await nextEvent(); continue; }\n",
    why: "with nothing running, a lane held back by an operation that never closes (its worker killed) keeps the run waiting for ever",
    killed_by: /does not wait on an open operation without bound/,
  },
  {
    id: 'M7', file: SCH, tests: [TLG],
    from: "        if (now() - busyIdleSince < busyWaitMs) { await nextEvent(); continue; }\n",
    to: "        if (false) { await nextEvent(); continue; }\n",
    why: "the run ends beside a lane held back by an open operation at once, never waiting for a person's operation (a gate's resolution) to close",
    killed_by: /does not wait on an open operation without bound/,
  },
  {
    id: 'M6', file: SCH, tests: [TLG],
    from: "firstHeld() ?? firstBusy() : null) ?? d.idle);",
    to: "firstHeld() : null) ?? d.idle);",
    why: "the run that ends beside an open operation names neither the operation nor its writer-clear",
    killed_by: /does not wait on an open operation without bound/,
  },
  // G — the seams its fourth critique found: the lane a hold on a subtask
  // with no worktree records, and hold's eligibility asked again under the
  // holds lock.
  {
    // The record before the fix: the path a run would create (laneHome and
    // lanePath are imported again for the release's lane check, P5).
    id: 'G1', file: HCLI, tests: [TK],
    from: '  const lane = at ?? null;\n',
    to: '  const lane = at !== undefined ? at : (laneHome(repoRoot).problem ? null : lanePath(laneHome(repoRoot), o.macro, o.subtask));\n',
    why: "a hold on a subtask with no worktree records the lane a run would create, and the worktree the person makes for the branch orphans it",
    killed_by: /records no lane, and a worktree the person then makes for the branch leaves it held/,
  },
  {
    id: 'G2', file: OPS, tests: [TK],
    from: '    const hold = adoptLane(mainRoot, st);\n    const lane = laneOf({ hold, stateRoots, macroId });\n',
    to: '    const hold = st.hold.record;\n    const lane = laneOf({ hold, stateRoots, macroId });\n',
    why: "a hold set before its subtask had a worktree never takes the one that holds its branch by the handoff: the lane the work is in is unfenced, and its release's basis is the main checkout's",
    killed_by: /a worktree that holds the branch by the handoff is taken then, and fenced/,
  },
  {
    id: 'G3', file: OPS, tests: [TK],
    from: "    if (ineligible) throw new HoldRefusal(ineligible, 'ineligible');\n",
    to: '',
    why: "a hold queued behind the holds lock while a finalize ends the macro still publishes its record, and tells the person the lane is theirs (I7's limit)",
    killed_by: /a finalize that ends the macro and retires its holds after the first looks refuses the hold/,
  },
  {
    id: 'G4', file: HCLI, tests: [TK],
    from: "        return act.state === 'active' ? null\n",
    to: '        return true ? null\n',
    why: "a hold whose macro's holds were retired since it turned them on writes into the directory its lock made again, with the holds inactive",
    killed_by: /holds retired since the hold turned them on refuse it too/,
  },
  {
    id: 'G5', file: HCLI, tests: [TK],
    from: '        if (now.problem) return now.problem;\n',
    to: '',
    why: "a hold queued while an abort ends the macro, whose retirement waits, is set on an ended macro",
    killed_by: /a macro ended after the first looks refuses the hold/,
  },
  // G (cont.) — what the Refine-verify of the G fixes found.
  {
    id: 'G6', file: OPS, tests: [TK],
    from: '    hold = adoptLane(mainRoot, st);\n',
    to: '',
    why: "a worktree the person made after the handoff is not the release's lane: its basis is the main checkout's, and an edit there after the release is consumed",
    killed_by: /a worktree made after the handoff is taken at the release/,
  },
  {
    id: 'G7', file: HCLI, tests: [TK],
    from: '  await withHoldsLock(mainRoot, o.macro, () => {\n    readPlan();\n',
    to: '  readPlan();\n  await withHoldsLock(mainRoot, o.macro, () => {\n',
    why: "discard reads the plan before the holds lock: a plan revised while it waits gives the replacement the old branch, and the next status orphans it",
    killed_by: /a plan revised while the discard waits for the lock gives its replacement the new branch/,
  },
  {
    id: 'G8', file: HCLI, tests: [TK],
    from: "  const laneNow = now.state === 'ok' && now.record.hold_id === record.hold_id ? now.record.lane : record.lane;\n",
    to: '  const laneNow = record.lane;\n',
    why: "hold prints the lane as set, not the one its handoff took: \"no lane yet\" beside a fenced worktree, with no last session",
    killed_by: /hold prints the lane its handoff took/,
  },
  // ---- P: the seams its fifth critique found ----------------------------------
  {
    id: 'P1', file: DRV, tests: [TC],
    from: ".filter(([, s]) => s.state === 'rejected');\n",
    to: '.filter(() => false);\n',
    why: "a serial run starts beside a rejected release whose park was never kept, and steps a lane that changed after its release (I10; M1's mirror)",
    killed_by: /refuses beside a rejected release that keeps no park/,
  },
  {
    id: 'P2', file: `${SKILLS}/finalize/SKILL.md`, tests: [TX],
    from: "- when `stop-archive` answers with an envelope of `archived: false`, whatever\n  its `reason` (`gate-not-met`, or `held-lane` for a child in a held lane,\n  ADR-0068 Decision 2, item 7), invoke engineer `state.mjs detach-archive`\n  for that child, as `commands/finalize.md` does: that answer is not a\n  failure;\n",
    to: '',
    why: "the Codex finalize counts the engineer's held-lane answer as a failure and stops before Phase 3, its subtasks already deferred and the child still active",
    killed_by: /finalize \(Codex mirror\): Phase 2 routes any archived: false from stop-archive/,
  },
  {
    id: 'P3', file: `${SKILLS}/abort/SKILL.md`, tests: [TX],
    from: "   `state.mjs detach-archive`, and every child whose `stop-archive` answers\n   with an envelope of `archived: false`, whatever its `reason`\n   (`gate-not-met`, or `held-lane` for a child in a held lane, ADR-0068\n   Decision 2, item 7), as `commands/abort.md` does: that answer is not a\n   failure;\n",
    to: '   `state.mjs detach-archive`, and gate-not-met children too;\n',
    why: "the Codex abort names only gate-not-met: a held lane's terminal child stops it before Phase 3, its subtasks already abandoned",
    killed_by: /abort \(Codex mirror\): Phase 2 routes any archived: false from stop-archive/,
  },
  {
    id: 'P4', file: OPS, tests: [TK],
    from: '    const foreign = lane.laneRoot ? laneRefusal(lane.laneRoot) : null;\n',
    to: '    const foreign = null;\n',
    why: "a release from a person's own worktree records a basis naming a lane the run never steps: kept, the run parks it on row 11; removed, the comparison rejects it for the wrong cause",
    killed_by: /a person's own worktree goes back to the run in one stated order/,
  },
  {
    id: 'P5', file: HCLI, tests: [TK],
    from: '    if (reason && reason.macroId === macroId && reason.subtaskId === subtaskId) return null;\n',
    to: '',
    why: "the run's own lane counts as a person's worktree: every release of a dispatched subtask's lane refuses",
    killed_by: /whose lane it is: a run's lane, locked with its reason, is not refused/,
  },
  {
    // The first form of the fix: ownership by the path a run would use.
    id: 'P8', file: HCLI, tests: [TK],
    from: '    if (reason && reason.macroId === macroId && reason.subtaskId === subtaskId) return null;\n',
    to: '    if (reason !== undefined && real(lanePath(home, macroId, subtaskId)) === real(laneRoot)) return null;\n',
    why: "whose lane it is is judged by path, not by the run's lock as reconciliation judges it: a moved run lane is refused, and an unlocked worktree at the canonical path, which the run parks on row 11, is released",
    killed_by: [/whose lane it is: a run's lane moved elsewhere, its lock kept, is not refused/, /whose lane it is: an unlocked worktree at the path a run would use is refused/],
  },
  {
    id: 'P9', file: DRV, tests: [TC],
    from: '    const rejected = holds.ids.filter((id) => !settled.has(id)).map(',
    to: '    const rejected = holds.ids.map(',
    why: "a rejected release of a subtask gone from the plan, or completed, holds back every serial run, and names a hold that refuses",
    killed_by: /refuses beside a rejected release that keeps no park/,
  },
  {
    id: 'P10', file: HCLI, tests: [TK],
    from: "  if (s.status === 'pending') {\n",
    to: '  if (false) {\n',
    why: "hold no longer says that commits on an undispatched subtask's branch keep the run from taking it up",
    killed_by: /a person's own worktree goes back to the run in one stated order/,
  },
  {
    id: 'P6', file: HCLI, tests: [TK],
    from: "    out(`  to work in a worktree of your own (${add}): before the release, commit your work there and remove it (git worktree remove <path>); a release refuses while it has the branch`);\n",
    to: '',
    why: "hold no longer says the one order a person's own worktree goes back in, and the person learns it only from the release's refusal",
    killed_by: /a person's own worktree goes back to the run in one stated order/,
  },
  {
    // K3X: the look the K3 fix moved under the lock, back before it.
    id: 'P7', file: OPS, tests: [TK],
    from: "  return withHoldsLock(mainRoot, macroId, async () => {\n    const ineligible = await stillEligible();\n    if (ineligible) throw new HoldRefusal(ineligible, 'ineligible');\n",
    to: "  const ineligible = await stillEligible();\n  if (ineligible) throw new HoldRefusal(ineligible, 'ineligible');\n  return withHoldsLock(mainRoot, macroId, async () => {\n",
    why: "hold's eligibility is asked before the holds lock: a finalize that ends the macro while the hold waits for the lock still gets a hold published (K3's race, I7's limit)",
    killed_by: /a hold that waits on the holds lock while a finalize ends the macro asks once it has the lock/,
  },
  // ---- O: the owner's decision on row 12 (ADR-0062 Decision 2, amendment of 2026-10-27)
  {
    id: 'O1', file: LNS, tests: [TK],
    from: "  if (vouched && vouched.tip === tip) {\n",
    to: "  if (false) {\n",
    why: "a consumed release's recorded tip vouches for nothing: a person's work on an undispatched subtask halts its lane (2(a))",
    killed_by: /a consumed release records the branch tip, and row 12 dispatches on it/,
  },
  {
    id: 'O2', file: HCLI, tests: [TK],
    from: "      ...(mainRoot ? { branch_tip: branchTip } : {}),\n",
    to: "",
    why: "a release records no branch tip, so its consumption vouches for none (2(a), item 1)",
    killed_by: /a consumed release records the branch tip, and row 12 dispatches on it/,
  },
  {
    id: 'O3', file: HCLI, tests: [TK],
    from: "      basisOf: basisFor({ engineerRoot, fingerprintOf, mainRoot }),\n",
    to: "      basisOf: basisFor({ engineerRoot, fingerprintOf }),\n",
    why: "the owner's release takes its basis without the branch tip (2(a), item 1)",
    killed_by: /a consumed release records the branch tip, and row 12 dispatches on it/,
  },
  {
    id: 'O4', file: LNS, tests: [TK],
    from: "    const tip = st.state === 'consumed' ? st.release.record.basis?.branch_tip : null;\n",
    to: "    const tip = st.release?.state === 'ok' ? st.release.record.basis?.branch_tip : null;\n",
    why: "a release the run has not compared yet vouches for its tip (2(a): consumed only)",
    killed_by: /a consumed release records the branch tip, and row 12 dispatches on it/,
  },
  {
    id: 'O5', file: LNS, tests: [TK],
    from: "    if (typeof tip === 'string' && st.hold.record.branch === s.branch) handedBack[s.id] = { tip, holdId: st.hold.record.hold_id };\n",
    to: "    if (typeof tip === 'string') handedBack[s.id] = { tip, holdId: st.hold.record.hold_id };\n",
    why: "a release of the subtask's former branch vouches for the branch the plan names now",
    killed_by: /a consumed release records the branch tip, and row 12 dispatches on it/,
  },
  {
    id: 'O6', file: LNS, tests: [TK],
    from: "    if (a.containsBase) return { ok: true };\n",
    to: "    return { ok: true };\n",
    why: "a handed-back tip that does not contain the baseline is dispatched on, omitting a landed predecessor (2(b))",
    killed_by: /a handed-back tip that does not contain the baseline halts with a rebase/,
  },
  {
    id: 'O7', file: LNS, tests: [TK],
    from: "hold it again (${hold}), rebase ${branch} onto origin/${facts.baseline}, then release it",
    to: "remove or reset it, then relaunch",
    why: "the halt of a handed-back tip that does not contain the baseline advises discarding the work (item 3)",
    killed_by: /a handed-back tip that does not contain the baseline halts with a rebase/,
  },
  {
    id: 'O8', file: LNS, tests: [TK],
    from: "  if (a.beyondBase) {\n",
    to: "  if (false) {\n",
    why: "a branch carrying commits the baseline lacks, vouched for by nothing, is told to reset (item 4)",
    killed_by: /a consumed release records the branch tip, and row 12 dispatches on it/,
  },
  {
    id: 'O9', file: LNS, tests: [TLN],
    from: "        const beyond = typeof l.head === 'string' && facts.baseTip !== null && (facts.ancestry[l.head]?.beyondBase ?? true);\n",
    to: "        const beyond = false;\n",
    why: "a prepared lane whose branch carries commits the baseline lacks is told to remove the lane and its branch (row 4)",
    killed_by: /halts on a prepared lane whose branch carries commits the baseline lacks/,
  },
  {
    id: 'O10', file: LNS, tests: [TLN],
    from: "        const behind = typeof l.head === 'string' && facts.baseTip !== null && !beyond;\n",
    to: "        const behind = !beyond;\n",
    why: "with no baseline ref, a prepared lane whose branch carries commits is told to remove the lane and its branch (row 4, a preview)",
    killed_by: /halts on a prepared lane whose branch carries commits the baseline lacks/,
  },
  {
    id: 'O11', file: SCH, tests: [TSC],
    from: "then relaunch. Delete ${held.branch} too only when git rev-list ${f.ref}..${held.branch} prints nothing: otherwise it carries commits the baseline lacks, and the next run judges it as a branch with no lane (row 12)`",
    to: "remove the lane and its branch, then relaunch`",
    why: "the admission's refusal of a prepared lane advises deleting its branch whatever it carries (a baseline rewound under it)",
    killed_by: /a prepared lane's dispatch is checked against the baseline/,
  },
  // ---- U: the sixth critique's findings (refine pass 10) --------------------
  {
    id: 'U1', file: HCLI, tests: [TK],
    from: '    const add = branchExists(mainRoot, s.branch)\n',
    to: '    const add = true\n',
    why: "hold names `git worktree add <path> <branch>` for a branch dispatch has not created yet, which git refuses (M1)",
    killed_by: /a person's own worktree goes back to the run in one stated order/,
  },
  {
    id: 'U2', file: HCLI, tests: [TK],
    from: '    const add = branchExists(mainRoot, s.branch)\n',
    to: '    const add = false\n',
    why: 'hold names `git worktree add -b` for a branch that exists, which git refuses (M1)',
    killed_by: /names a worktree command that works for a branch that already exists/,
  },
  {
    id: 'U8', file: HCLI, tests: [TK],
    from: '`git worktree add --no-track -b ${s.branch} <path>',
    to: '`git worktree add -b ${s.branch} <path>',
    why: "the branch hold's command creates tracks the baseline, so the person's push goes to it (the Refine-verify of refine pass 10)",
    killed_by: /a person's own worktree goes back to the run in one stated order/,
  },
  {
    id: 'U3', file: H, tests: [TR],
    from: 'opened_at: op.opened_at ?? null, ext: op.ext === true });',
    to: 'opened_at: null, ext: op.ext === true });',
    why: "our decoding of a child's operations drifts from the engineer's own read of the file it wrote (M2: the oracle runs)",
    killed_by: /the real engineer's workflow, with an operation open, decodes/,
  },
  {
    id: 'U4', file: SCH, tests: [TA],
    from: "    if (inLane && s.kind === 'dispatch' && !createdNow) {\n",
    to: "    if (inLane && s.kind === 'dispatch') {\n",
    why: "a lane created now at a handed-back tip is checked as a prepared one, and its dispatch is refused as the baseline moved (M3: row 12 to the dispatch)",
    killed_by: /the driver dispatches on the person's commit/,
  },
  {
    id: 'U5', file: OPS, tests: [TH],
    from: "  return withHoldsLock(mainRoot, macroId, async () => {\n    await sweepDeadExclusions({ mainRoot, macroId, subtaskId });\n    const st = holdStateOf(mainRoot, macroId, subtaskId);\n    if (st.state === 'unreadable') {\n",
    to: "  return ((f) => f())(async () => {\n    await sweepDeadExclusions({ mainRoot, macroId, subtaskId });\n    const st = holdStateOf(mainRoot, macroId, subtaskId);\n    if (st.state === 'unreadable') {\n",
    why: 'a release takes no holds lock, and reads a hold mid-handoff as pending (M4)',
    killed_by: /a release that arrives between the fence and the acknowledgement waits for the ack/,
  },
  {
    // U5 with the release's read 150 ms late, standing in for load: the
    // round-6 critique's Q3, which the old 100 ms timer let survive.
    id: 'U6', file: OPS, tests: [TH],
    from: "  return withHoldsLock(mainRoot, macroId, async () => {\n    await sweepDeadExclusions({ mainRoot, macroId, subtaskId });\n    const st = holdStateOf(mainRoot, macroId, subtaskId);\n    if (st.state === 'unreadable') {\n",
    to: "  return ((f) => f())(async () => {\n    await sweepDeadExclusions({ mainRoot, macroId, subtaskId });\n    await new Promise((r) => { setTimeout(r, 150); });\n    const st = holdStateOf(mainRoot, macroId, subtaskId);\n    if (st.state === 'unreadable') {\n",
    why: 'a release takes no holds lock and reaches its read late, under load (M4: no timer decides the test)',
    killed_by: /a release that arrives between the fence and the acknowledgement waits for the ack/,
  },
  {
    id: 'U7', file: HCLI, tests: [TK],
    from: "    const fingerprint = parkFingerprint(view, subtaskId, laneRoot ? { form: 'lane' } : { form: 'no-worktree', branch: hold.branch, branchTip });\n",
    to: "    const fingerprint = parkFingerprint(view, subtaskId, laneRoot ? { form: 'lane' } : { form: 'no-worktree', branch: hold.branch, branchTip: null });\n",
    why: "a no-worktree release's basis ignores the branch tip, so a commit after the release is consumed (M5)",
    killed_by: /a release with no worktree is rejected when the branch moves after it/,
  },
];
