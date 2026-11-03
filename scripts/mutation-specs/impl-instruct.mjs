// Mutation spec — do the tests of the owner's instructions to a lane catch
// the defects ADR-0068 Decision 7 guards against?
//
// Run: npm run mutate -- scripts/mutation-specs/impl-instruct.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. An instruction that is applied twice, lost,
// applied to the wrong child, applied mid-step, applied over a gate's
// resolution, or shown with its note in the event file breaks nothing a green
// run would show: the run goes on, under the wrong word. Each mutation breaks
// one rule and names the test that must notice it; each new test of
// impl-instruct has one here.
//
// Groups: R the record (instructions.mjs), A the application
// (instruct-apply.mjs), C the owner command (instruct-cli.mjs, cli.mjs,
// state.mjs applyLaneInstructions), D the serial driver (driver.mjs), L the
// run with lanes (scheduler.mjs, events.mjs), X the retirement (hold-ops.mjs),
// F what the slice's critique found (2026-11-01: the step ledger's instruction
// line, a failed or deferred application, a crash's receipt beside a child
// that cannot be read, a quoted Phase 0 heading, and the tests the ADR named),
// G what its second critique found (a lane at no boundary skipped past its
// boundary's opening, reads that could not know taken for nothing to do, and
// an instruction beside a started, a queued and a hold-cut batch), N what
// its third critique found (a worker's unclosed fence hid a later gate
// resolution from the witness, and a heading of the application's shape was
// taken for this lane's on its shape alone), N3 what its fourth critique
// found (a replacement child read with its predecessor's applications), and
// Q what its fifth found (an instruction to a lane mid-step in a run with
// lanes, the owner's rerun beside a pending instruction with a step, and the
// malformed-step refusals no mutation proved), and T what its sixth found (a
// batch a dead driver left open taken for a boundary, the forced-step refusal
// naming an instruction that applies to nothing, and a note pending at a
// relaunch made to wait for the forced step), and T4 what its seventh found
// (an owner's write that landed while a pass ran taken as seen at the pass's
// end, so it woke nothing).
//
// Not mutated, each with its reason: the tick's wake for a deferred lane
// (scheduler.mjs pollWake, `instructDeferred.size > 0`) would leave a run
// waiting with no wake, a TIMEOUT and not a verdict; the reconcile's
// `states.includes('unreadable')` (a child file gone between the listing and
// its read) is a race no test makes on demand; a draining run's
// `draining ||` guard in applyInstructions is equivalent (the loop's drain
// block continues before the pass); the verify queue's drop of a request the
// decision no longer gives is equivalent (the batch's admission reads the
// child again and starts none for a request no longer pending); the batch
// exclusion's `openBatches` (a batch whose handle ended with no end) is a
// state no test makes on demand.
// H the tests' pid files (tests/_pidfile.mjs): a pid file read as 0 made a
// test's kill signal its runner's own group, which ended verification batch
// autopilot-20261101T020524Z-9f420b-s8-c27cad with no evidence; this lane's
// verification depends on it. The call sites' guards (`if (pid !== null)`)
// are not mutated: an empty read there is a race no test makes on demand.
//
// L1 and L4 (the instruction records as a wake source, and the nomination of
// the parked lane an application changed) bite only because the parked-lane
// test sets a quiet interval longer than itself: at the default the tick's
// own wake, a quiet interval after the park, applied and judged the lane
// anyway, and both mutations were equivalent under the test's timing.

const REC = 'plugins/orchestrator/scripts/lib/instructions.mjs';
const APP = 'plugins/orchestrator/scripts/lib/instruct-apply.mjs';
const CMD = 'plugins/orchestrator/adapters/claude/autopilot/instruct-cli.mjs';
const CLI = 'plugins/orchestrator/adapters/claude/autopilot/cli.mjs';
const ST = 'plugins/orchestrator/scripts/state.mjs';
const DRV = 'plugins/orchestrator/adapters/claude/autopilot/driver.mjs';
const SCH = 'plugins/orchestrator/adapters/claude/autopilot/scheduler.mjs';
const OPS = 'plugins/orchestrator/scripts/lib/hold-ops.mjs';

const TR = 'tests/orchestrator/test-instructions-records.mjs';
const TA = 'tests/orchestrator/test-instruct-apply.mjs';
const TC = 'tests/orchestrator/test-autopilot-instruct-cli.mjs';
const TD = 'tests/orchestrator/test-autopilot-instruct-serial.mjs';
const TL = 'tests/orchestrator/test-autopilot-instruct-lanes.mjs';
const PIDF = 'tests/_pidfile.mjs';
const TW = 'tests/orchestrator/test-autopilot-worker.mjs';
const TDR = 'tests/orchestrator/test-autopilot-dead-runs.mjs';
const TV = 'tests/orchestrator/test-autopilot-verify-driver.mjs';
const TVL = 'tests/orchestrator/test-autopilot-verify-lanes.mjs';
// The owner's instruction beside an answered request (Decision 7, item 5),
// in a file of its own: a case that targets it runs that suite alone (about
// four minutes), not the whole lanes file, which neared the harness's 900 s
// timeout and ended T7c with no verdict.
const TVLI = 'tests/orchestrator/test-autopilot-verify-lanes-instruct.mjs';
const TVR = 'tests/orchestrator/test-autopilot-verify-run.mjs';
const VRN = 'plugins/orchestrator/adapters/claude/autopilot/verify-run.mjs';
const IBD = 'plugins/orchestrator/adapters/claude/autopilot/instruct-boundary.mjs';
const LED = 'plugins/orchestrator/adapters/claude/autopilot/ledger.mjs';
const DRS = 'plugins/orchestrator/adapters/claude/autopilot/dead-runs.mjs';

export const TESTS = [TR, TA, TC, TD, TL, TDR, TV, TVL, TVLI];

export const MUTATIONS = [
  // ---- R: the record -------------------------------------------------------------
  {
    id: 'R1', file: REC, tests: [TR],
    from: "  if (cmd === '/orchestrator:next') return { ok: false, code: 'dispatch' };\n",
    to: '',
    why: 'a dispatch is refused only as a malformed step, its own reason lost',
    killed_by: /refuses a dispatch, a rerun and anything malformed, each with its own code/,
  },
  {
    id: 'R2', file: REC, tests: [TR],
    from: "  if (note.trim() === '') return { ok: false, code: 'blank' };\n",
    to: '',
    why: 'a blank note is taken',
    killed_by: /refuses bytes that are no UTF-8, a NUL, a blank note and one past the bound/,
  },
  {
    id: 'R3', file: REC, tests: [TR],
    from: "  if (bytes.length > NOTE_MAX_BYTES) return { ok: false, code: 'too-large' };\n",
    to: '',
    why: 'a note past the bound is taken',
    killed_by: /refuses bytes that are no UTF-8, a NUL, a blank note and one past the bound/,
  },
  {
    id: 'R4', file: REC, tests: [TR],
    from: '      if (cur.revision !== revises.revision) {',
    to: '      if (false) {',
    why: 'a revision of a superseded revision is taken',
    killed_by: /refuses a revision that is no longer current/,
  },
  {
    id: 'R5', file: REC, tests: [TR],
    from: '      const entry = { id: cur.id, revision: cur.revision + 1, ...base };\n      const entries = record.entries.slice();\n      entries[at] = entry;',
    to: '      const entry = { id: cur.id, revision: cur.revision + 1, ...base };\n      const entries = [...record.entries.filter((e) => e.id !== cur.id), entry];',
    why: 'a revision loses its place: it goes to the end, after instructions written later',
    killed_by: /revises a pending instruction in its place/,
  },
  {
    id: 'R6', file: REC, tests: [TR],
    from: "  ['pending', 'revise', 'pending'],\n",
    to: "  ['pending', 'revise', 'pending'],\n  ['applying', 'revise', 'pending'],\n",
    why: 'an instruction being applied is revised under its receipt',
    killed_by: /refuses to revise or withdraw an instruction being applied, and an applied one/,
  },
  {
    id: 'R7', file: REC, tests: [TR],
    from: "      if (e.state !== 'pending') return e;\n      const c = cause(e);",
    to: "      if (e.state !== 'pending' && e.state !== 'applying') return e;\n      const c = cause(e);",
    why: 'a drop reaches an instruction being applied, before its receipt is reconciled',
    killed_by: /drops pending instructions with their cause, and leaves one being applied to its receipt/,
  },
  {
    id: 'R8', file: REC, tests: [TR],
    from: "  } catch {\n    return { state: 'unreadable', path: file, code: 'parse' };\n  }",
    to: "  } catch (err) {\n    return { state: 'unreadable', path: file, code: 'parse', error: err.message };\n  }",
    why: 'a record that does not parse is answered with JSON.parse\'s message, which quotes the note (P11)',
    killed_by: /answers a record it cannot read with a code and no byte of the note/,
  },
  {
    id: 'R9', file: REC, tests: [TR, TA],
    from: '  for (const line of linesOutsideApplications(t, end + 5, applications)) {',
    to: "  for (const line of t.slice(end + 5).split('\\n')) {",
    why: 'a resolution heading quoted in the owner\'s note counts as a gate resolved, and supersedes the instruction\'s step over a gate no one set',
    killed_by: [/reads the gate set and counts the resolutions outside the owner's notes/, /keeps a note's unclosed fence from hiding a later gate resolution/],
  },
  {
    id: 'R10', file: REC, tests: [TR],
    from: "    h.update(`${n}\\0${typeof r.text === 'string' ? ownerWritten(r.text, n.slice(0, -'.json'.length)) : (r.absent ? '(absent)' : '(unreadable)')}\\0`);",
    to: '    h.update(`${n}\\0`);',
    why: 'the wake digest reads the names only: a write, a revision or a withdrawal to a record already there wakes nothing',
    killed_by: /changes the wake digest at every write the owner makes/,
  },

  // ---- A: the application ----------------------------------------------------------
  {
    id: 'A1', file: APP, tests: [TA],
    from: '    if (e.witness === null || witnessChanged(e.witness, witness)) {',
    to: '    if (e.witness === null) {',
    why: 'a gate set or resolved after the write no longer supersedes the step: the instruction overrides the gate\'s resolution',
    killed_by: [/lets a gate set after the write supersede the step/, /keeps a gate's resolution/],
  },
  {
    id: 'A2', file: APP, tests: [TA],
    from: "    if (winner) superseded.push({ id: winner.id, cause: 'later-step' });\n",
    to: '',
    why: 'an earlier step a later one replaced is acknowledged applied, as if it had taken effect',
    killed_by: /applies several at one boundary/,
  },
  {
    id: 'A3', file: APP, tests: [TA],
    from: "      if (states.includes('written')) {\n        changed = true;\n        out.finalized.push(x.application_id);",
    to: '      if (false) {\n        changed = true;\n        out.finalized.push(x.application_id);',
    why: 'a receipt whose note the child holds is rolled back: a crash after the write applies the instruction twice',
    killed_by: /applies once when the applier dies between the child's write and the acknowledgement/,
  },
  {
    id: 'A4', file: APP, tests: [TA],
    from: "      if (alive.get(x.application_id) || linked.unreadable || states.length === 0 || states.includes('unreadable')) { out.waiting.push(x.application_id); return x; }\n",
    to: "      if (linked.unreadable || states.length === 0 || states.includes('unreadable')) { out.waiting.push(x.application_id); return x; }\n",
    why: 'a receipt whose applier still lives is rolled back under it',
    killed_by: /rolls an application a crash stopped before the write back to pending/,
  },
  {
    id: 'A5', file: APP, tests: [TA],
    from: "  if (sha256(readRegular(childPath).text ?? '') !== sha256(before)) {",
    to: '  if (false) {',
    why: 'a write that slipped in between the look and the append is overwritten by the instruction\'s step',
    killed_by: /when the child moved before the write/,
  },
  {
    id: 'A6', file: APP, tests: [TA],
    from: "      await end('rolled-back', { why: 'append-refused' });",
    to: "      await end('done', { why: 'append-refused' });",
    why: 'an instruction whose append was refused is acknowledged applied, and lost',
    killed_by: /leaves the entries pending when the append is refused/,
  },
  {
    id: 'A7', file: APP, tests: [TA],
    from: '  const first = linked.children.find((c) => idTime(c.id) >= after && c.branch === entry.branch);',
    to: '  const first = linked.children.find((c) => c.branch === entry.branch);',
    why: 'a note written before a re-dispatch binds to the child that archived before it, and is dropped',
    killed_by: /binds a note written before a re-dispatch to the child after it/,
  },
  {
    id: 'A8', file: APP, tests: [TA],
    from: "  if (b.archived) return 'child-archived';\n",
    to: '',
    why: 'an instruction whose child archived is dropped as replaced, its cause wrong',
    killed_by: /drops an instruction whose child archived/,
  },
  {
    id: 'A9', file: APP, tests: [TA],
    from: "  if (subtask.branch !== entry.branch) return 'branch-changed';\n",
    to: '',
    why: 'an instruction outlives its subtask\'s change of branch',
    killed_by: /drops on a branch change and a subtask gone from the plan/,
  },
  {
    id: 'A10', file: APP, tests: [TD],
    from: "    execFileSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: APPEND_TIMEOUT_MS, env: personaEnv(env) });",
    to: "    execFileSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: APPEND_TIMEOUT_MS, env });",
    why: 'the run\'s application writes inside the run\'s step numbering, and the engineer refuses it as a stale attempt (P9)',
    // The mid-step case: there this run's worker has already marked the child,
    // and the engineer cannot order a write naming that run with no step
    // number against the mark (state.mjs orderAgainstMark). An idle lane's
    // application opens a relaunch: the mark is the earlier run's, the later
    // run orders after it, and the write passes (verification batch
    // s10-b943b7: KILLED-ELSEWHERE).
    killed_by: /to a lane mid-step: applied after the step ends, the record surviving the worker's finish-verb/,
  },

  // ---- C: the owner command ------------------------------------------------------------
  {
    id: 'C1', file: CMD, tests: [TC],
    from: '    if (el.child === null) {\n      return `subtask ${o.subtask} has no child yet',
    to: '    if (el.child === null && false) {\n      return `subtask ${o.subtask} has no child yet',
    why: 'a step is taken for a subtask before its dispatch',
    killed_by: /takes a note alone before the dispatch, and refuses a step there/,
  },
  {
    id: 'C2', file: CMD, tests: [TC],
    from: '    if (el.witness?.gate) {',
    to: '    if (false) {',
    why: 'a step is taken for a child whose owner gate is set',
    killed_by: /refuses a step for a child with an owner gate set/,
  },
  {
    id: 'C3', file: CMD, tests: [TC],
    from: '  if (archived.latest) {\n',
    to: '  if (false) {\n',
    why: 'an instruction is written for a subtask whose child has archived',
    killed_by: /refuses a subtask whose child has archived/,
  },
  {
    id: 'C4', file: CLI, tests: [TC],
    from: "    case 'hold':\n    case 'instruct':\n    case 'writer-clear': {",
    to: "    case 'instruct': return instructCmd(o, repoRoot, { out, err });\n    case 'hold':\n    case 'writer-clear': {",
    why: 'a worker of a run instructs a lane',
    killed_by: /refuses a worker of a run, a subtask not in the plan or closed, and an ended macro/,
  },
  {
    id: 'C5', file: CMD, tests: [TC],
    from: '    if (blind.length) {',
    to: '    if (false) {',
    why: 'beside a live run that does not apply instructions, the command says nothing of the wait',
    killed_by: /warns beside a live run that does not apply instructions/,
  },
  {
    id: 'C6', file: APP, tests: [TC],
    from: '  const held = holdGate({ mainRoot, macroId, subtaskId });\n  if (held) return { why: held, stepFirst: false };',
    to: '  const held = null;',
    why: 'the command applies an instruction in a held lane, and before a release\'s comparison',
    killed_by: /leaves a held lane, and a released one whose release awaits its comparison, as they are/,
  },
  {
    id: 'C7', file: ST, tests: [TC],
    from: "  if (!act.ok) {\n    return { state: 'inactive',",
    to: "  if (false) {\n    return { state: 'inactive',",
    why: 'an instruction is applied where the lane\'s operations cannot be made visible',
    killed_by: /applies nothing where the lane's operations cannot be made visible/,
  },
  {
    id: 'C8', file: REC, tests: [TC],
    from: "    return `instruction ${e.id} r${e.revision}: ${e.state}${step} (${Buffer.byteLength(e.note, 'utf8')} bytes of note)${tail}`;",
    to: '    return `instruction ${e.id} r${e.revision}: ${e.state}${step} (${e.note})${tail}`;',
    why: 'status prints the note',
    killed_by: /prints its id and state and never the note; status lists it/,
  },

  {
    id: 'C9', file: CMD, tests: [TD],
    from: "          : later ? `; its step was replaced before it ran (by ${later.application_id})` : '; its step has not run yet';",
    to: "          : '; its step has not run yet';",
    why: 'status says an applied step is still to run after a later application replaced it (P2)',
    killed_by: /status says the first one's step never ran/,
  },
  {
    id: 'C10', file: CMD, tests: [TD],
    from: '        tail = s ? `; its step ran (run ${s.run}, step ${s.seq})`',
    to: '        tail = false ? `; its step ran (run ${s.run}, step ${s.seq})`',
    why: 'status never says an applied instruction\'s step ran (P2)',
    killed_by: /status says the first one's step never ran/,
  },

  // ---- D: the serial driver ---------------------------------------------------------------
  {
    id: 'D1', file: DRV, tests: [TD],
    from: "        if (refused) return await finish('halted', {",
    to: "        if (false) return await finish('halted', {",
    why: 'a forced step is taken beside a pending instruction that carries a next step, and one of the two words is lost',
    killed_by: /refuses a forced step beside a pending instruction with a next step/,
  },
  {
    id: 'D3', file: DRV, tests: [TD],
    from: '        ...(() => { const ia = stepApplication(mainRoot, view.macro.id, s, view.children?.[s.subtaskId]?.path); return ia ? { instruction_application: ia } : {}; })(),\n',
    to: '',
    why: 'the step an application chose does not name it: status cannot say whether the instruction\'s step ran (P2)',
    killed_by: /its step ledger line names the application/,
  },
  {
    id: 'D4', file: DRV, tests: [TD],
    from: '        if (applied) view = look(view.macro.id);\n',
    to: '',
    why: 'the step is decided from the look taken before the application: the child\'s old step runs',
    killed_by: [/to an idle lane whose judgment halted the last run/, /to a lane mid-step: applied after the step ends/],
  },

  // ---- L: the run with lanes ------------------------------------------------------------------
  {
    id: 'L1', file: SCH, tests: [TL],
    from: '    if (instructionsSeen.poll()) { instructTried.clear(); found = true; }',
    to: '    if (instructionsSeen.poll()) { instructTried.clear(); }',
    why: 'the instruction records are no wake source: one to a parked lane waits for some other event',
    // Bites only with the test's quiet interval longer than the test: at the
    // default, the tick's wake to judge the lane parked from the decision's
    // look applied it a quiet interval later (batch s10-b943b7: SURVIVED).
    killed_by: /to a parked lane while another lane's step runs: applied within the poll/,
  },
  {
    id: 'L4', file: SCH, tests: [TL],
    from: '        if (parked.has(id)) candidates.add(id);\n        again = true;\n',
    to: '        again = true;\n',
    why: 'a parked lane an instruction changed is never judged again: its instructed step waits for some other wake',
    killed_by: /to a parked lane while another lane's step runs: applied within the poll/,
  },
  {
    id: 'L2', file: SCH, tests: [TL],
    from: "        if (refused) return await end('halted', asHalt({",
    to: "        if (false) return await end('halted', asHalt({",
    why: 'a relaunch\'s --lane --next is taken beside a pending instruction that carries a next step',
    killed_by: /refuses a relaunch's --lane <id> --next beside a pending instruction/,
  },
  {
    id: 'L3', file: SCH, tests: [TL],
    from: "      if (ev) pub.emit('instruction', ev, id);\n",
    to: '',
    why: 'what the driver did with an instruction is not published in the event file',
    killed_by: /to a parked lane while another lane's step runs/,
  },

  // ---- X: the retirement ----------------------------------------------------------------------
  {
    id: 'X1', file: OPS, tests: [TR],
    from: '    && !readKeptPark(mainRoot, macroId, subtaskId).kept && !instructed) return { state: \'none\' };',
    to: '    && !readKeptPark(mainRoot, macroId, subtaskId).kept) return { state: \'none\' };',
    why: 'done leaves the instructions of a subtask that has no other record pending, to be applied after its completion',
    killed_by: /done drops what no boundary applied, for a subtask with no other record/,
  },
  {
    id: 'X2', file: OPS, tests: [TR],
    from: "          for (const e of await dropInstructions({ mainRoot, macroId, subtaskId: id, cause: () => 'macro-ended', by: 'retirement', locked: true })) {",
    to: '          for (const e of []) {',
    why: 'the macro\'s end retires its instructions unnamed: the owner is never told which were never applied',
    killed_by: /the macro's end drops every pending instruction and names each in its summary/,
  },
  // ---- P: what the code review of the slice found (Plan-verify, 2026-11-01) ----------------
  {
    id: 'P1', file: ST, tests: [TC],
    from: '  const reconciled = await reconcileReceipts({ mainRoot, macroId, subtaskId, stateRoots });',
    to: "  const reconciled = { waiting: [], finalized: [], rolledBack: [] };",
    why: 'the public application exits on an entry a crash left applying before the recovery that would end it: the instruction is stuck forever',
    killed_by: /reconciles a receipt a crash left before anything else/,
  },
  {
    id: 'P2', file: APP, tests: [TA],
    from: "  if (facts.fields.current_phase === 'phase-7-commit' || (terminal && ['commit-complete', 'close-complete'].includes(facts.fields.current_phase))) {",
    to: "  if (facts.fields.current_phase === 'phase-7-commit' || terminal) {",
    why: 'an interactive verb\'s terminal end is taken for an interrupted commit, and the instruction never applies',
    killed_by: /takes an interactive verb's terminal end for no commit/,
  },
  {
    id: 'P3', file: APP, tests: [TA],
    from: "    parts.push(`#### Instruction ${e.id} r${e.revision} — ${fate}\\n\\n${fence}text\\n${e.note}\\n${fence}`);",
    to: "    parts.push(`#### Instruction ${e.id} r${e.revision} — ${fate}\\n\\n${e.note}`);",
    why: 'a note goes in verbatim: an unclosed fence in it hides every later gate resolution from the witness',
    killed_by: /keeps a note's unclosed fence from hiding a later gate resolution/,
  },
  {
    id: 'P4', file: 'plugins/orchestrator/adapters/claude/autopilot/instruct-boundary.mjs', tests: [TR],
    from: '  const order = [...planIds.filter((id) => ids.ids.includes(id)), ...ids.ids.filter((id) => !planIds.includes(id))];',
    to: '  const order = planIds.filter((id) => ids.ids.includes(id));',
    why: 'a subtask removed from the plan never reaches the sweep: its instructions stay pending, never dropped',
    killed_by: /names a subtask the plan no longer holds/,
  },
  {
    id: 'P5', file: OPS, tests: [TR],
    from: '      if (ended.length) writeEndedInstructions(mainRoot, macroId, ended);',
    to: '',
    why: 'the macro\'s end deletes every instruction\'s outcome with its holds directory: status and halt.json show none',
    killed_by: /the macro's end drops every pending instruction and names each in its summary/,
  },
  {
    id: 'P6', file: 'plugins/orchestrator/adapters/claude/autopilot/instruct-boundary.mjs', tests: [TD],
    from: '  if (workerStepSince(text, at + 1, laneApplicationIds(r.record, child))) return null;\n',
    to: "  if (true) return null;\n",
    why: 'an application the run did not make is not named on the step it chose (P2: restart-safe provenance)',
    killed_by: /names on a step's ledger line an application the run did not make/,
  },
  // ---- F: what the slice's critique found (2026-11-01) --------------------------------
  {
    id: 'F1a', file: LED, tests: [TDR, TD],
    from: "    if (rec.event === 'instruction') {\n      instructions.push(rec);\n      continue;\n    }\n",
    to: '',
    why: 'a serial run\'s instruction line is merged into the step of its seq, hiding that step\'s start',
    killed_by: [/never hides that step's start/, /takes one beside a note alone, applying the note pending at launch before it/],
  },
  {
    id: 'F1b', file: DRS, tests: [TDR],
    from: "    if (rec.event === 'stall' || rec.event === 'instruction') continue;",
    to: "    if (rec.event === 'stall') continue;",
    why: 'dead-run cleanup takes a step in flight after an instruction line for no step started: the peers naming no run that it may have started go unreported and the halt names no subtask or session',
    killed_by: /never hides that step's start/,
  },
  {
    id: 'F1c', file: IBD, tests: [TD, TL],
    from: "    if (r.state === 'unreadable') { out.push({ subtaskId: id, step: null, unreadable: true }); continue; }\n",
    to: '',
    why: 'a record that cannot be read is no longer due: its deferral is forgotten and the lane\'s recorded step runs over what it holds',
    killed_by: [/a record that turns unreadable keeps the recorded step deferred/, /a record that turns unreadable keeps the lane's recorded step deferred/],
  },
  {
    id: 'F3e', file: SCH, tests: [TL],
    from: '      if (instructDeferred.size > 0) { await nextEvent(); continue; }\n',
    to: '',
    why: 'a run with no other lane to run ends idle beside a deferred lane, after one attempt',
    killed_by: /a lane left waiting with no other lane to run is still tried at each tick/,
  },
  {
    id: 'F2a', file: SCH, tests: [TL],
    from: "        instructTried.set(id, { key, at: now(), failed: true });\n        instructDeferred.delete(id);\n        await halted({ reason: 'owner-choice', detail: a.detail, subtaskId: id });",
    to: "        instructDeferred.delete(id);\n        await halted({ reason: 'owner-choice', detail: a.detail, subtaskId: id });",
    why: 'a failed instruct-apply command is tried again at once, without end, and no other lane is ever decided',
    killed_by: /a failed instruct-apply command parks its lane once/,
  },
  {
    id: 'F2b', file: SCH, tests: [TL],
    from: '        if (tried.failed && parked.has(id)) continue;\n',
    to: '',
    why: 'a lane parked by a failed command is tried again at every tick on a record left as it was',
    killed_by: /a failed instruct-apply command parks its lane once/,
  },
  {
    id: 'F3a', file: SCH, tests: [TL],
    from: 'parked: new Set([...parked.keys(), ...busy, ...heldSubtasks(view), ...instructDeferred.keys()]), driverBusy',
    to: 'parked: new Set([...parked.keys(), ...busy, ...heldSubtasks(view)]), driverBusy',
    why: 'a lane whose application was left waiting runs its recorded step over the pending instruction',
    killed_by: /an application left waiting defers the lane's recorded step/,
  },
  {
    id: 'F3b', file: SCH, tests: [TL],
    from: '        if (tries >= INSTRUCT_DEFER_TRIES) {\n          instructDeferred.delete(id);',
    to: '        if (false) {\n          instructDeferred.delete(id);',
    why: 'a lane whose application stays waiting is deferred without bound, never handed to the owner',
    killed_by: /an application left waiting defers the lane's recorded step/,
  },
  {
    id: 'F3c', file: DRV, tests: [TD],
    from: '      if (deferredId && instructDeferred.has(deferredId)) {',
    to: '      if (false) {',
    why: 'a serial run takes the recorded step of a subtask whose application was left waiting',
    killed_by: /an application left waiting defers the lane's recorded step, tries again, and halts/,
  },
  {
    id: 'F3d', file: DRV, tests: [TD],
    from: '          if (tries >= INSTRUCT_DEFER_TRIES) {\n            return await finish(',
    to: '          if (false) {\n            return await finish(',
    why: 'a serial run retries an application left waiting without bound',
    killed_by: /an application left waiting defers the lane's recorded step, tries again, and halts/,
  },
  {
    id: 'F4a', file: APP, tests: [TA],
    from: "      if (alive.get(x.application_id) || linked.unreadable || states.length === 0 || states.includes('unreadable')) { out.waiting.push(x.application_id); return x; }\n",
    to: "      if (alive.get(x.application_id) || states.includes('unreadable')) { out.waiting.push(x.application_id); return x; }\n",
    why: 'a crash\'s receipt is rolled back while the child cannot be read, and its note is appended a second time once it reads',
    killed_by: /keeps a crash's receipt reserved while the child cannot be read/,
  },
  {
    id: 'F4c', file: APP, tests: [TA],
    from: "linked.unreadable || states.length === 0 || states.includes('unreadable')",
    to: "linked.unreadable || states.includes('unreadable')",
    why: 'a crash\'s receipt is rolled back while no copy of its child is found (moved between listings), and its note is appended again',
    killed_by: /keeps a crash's receipt reserved while no copy of its child is found/,
  },
  {
    id: 'F4d', file: APP, tests: [TA],
    from: '  const linked = linkedChildren(stateRoots, { macroId, subtaskId }, { allCopies: true });',
    to: '  const linked = linkedChildren(stateRoots, { macroId, subtaskId });',
    why: 'the recovery reads only the first root\'s copy of the child: a stale copy hides the note, and the receipt is rolled back',
    killed_by: /a stale copy under an earlier root never hides the note in a later one/,
  },
  {
    id: 'F4b', file: APP, tests: [TA],
    from: "  if (readBack === 'unreadable') {",
    to: '  if (false) {',
    why: 'an append whose child cannot be read back is rolled back, though the note may be in it',
    killed_by: /keeps the receipt reserved when the child cannot be read back after the append/,
  },
  {
    id: 'F5a', file: REC, tests: [TA],
    from: '      inApplication = true;\n      fence = null;\n',
    to: '      fence = null;\n',
    why: 'a Phase 0 heading quoted in the owner\'s fenced note is taken for a worker\'s step: the P7 guard resumes the requesting verb over the instruction, and its provenance is lost',
    killed_by: [/takes a Phase 0 heading quoted in the owner's note for no step/, /reads a worker's note as before/],
  },
  {
    id: 'F5c', file: IBD, tests: [TA],
    from: '  const at = text.indexOf(`\\n### ${applicationHeading(last.application_id)}\\n`);',
    to: '  const at = text.lastIndexOf(`\\n### ${applicationHeading(last.application_id)}\\n`);',
    why: 'a later note quoting the application\'s heading is taken for the application: the scan starts inside its fence and hides a later worker\'s Phase 0',
    killed_by: /takes a later note quoting the application's heading for a quote/,
  },
  {
    id: 'F5d', file: REC, tests: [TA],
    from: "    if (app && applications.has(app[1]) && (t.startsWith(`${line}\\n`) ? 0 : t.indexOf(`\\n${line}\\n`) + 1) === lineAt) {",
    to: '    if (app && applications.has(app[1])) {',
    why: 'a worker\'s note quoting an application\'s heading in a fence is taken for the owner\'s note, and a later Phase 0 is hidden',
    killed_by: /reads a worker's note as before/,
  },
  {
    id: 'F5b', file: IBD, tests: [TA],
    from: "    if (/^### Phase 0[: ]/.test(line)) return true;",
    to: '    if (false) return true;',
    why: 'a worker\'s step after an application is not seen: the instruction\'s step still passes the P7 guard after it ran',
    killed_by: [/and a worker's for one/, /reads a worker's note as before/],
  },
  {
    id: 'F6a', file: SCH, tests: [TL],
    from: '      // decided: the comparison above may have just given it back.\n      if (await applyInstructions()) continue;',
    to: '      // decided: the comparison above may have just given it back.\n      if (false) continue;',
    why: 'a held lane given back by its release\'s comparison is decided before its instruction applies: its recorded step runs over it',
    killed_by: /applies a held lane's instruction right after its release is compared/,
  },
  {
    id: 'F6b', file: DRV, tests: [TV],
    from: '        if (f?.guard && view.macro?.id && instructedStep(mainRoot, view.macro.id, id, view.children?.[id]?.path)) ctx.verify.facts[id] = { ...f, guard: null };',
    to: '        if (false) ctx.verify.facts[id] = { ...f, guard: null };',
    why: 'the P7 guard resumes the requesting verb over the owner\'s instructed step (item 5)',
    killed_by: /replaces on_pass, and the P7 guard does not resume the requesting verb over it/,
  },
  {
    id: 'F6d', file: SCH, tests: [TVLI],
    from: '        if (f?.guard && instructedStep(mainRoot, macroId, id, view.children?.[id]?.path)) vfacts[id] = { ...f, guard: null };',
    to: '        if (false) vfacts[id] = { ...f, guard: null };',
    why: 'a run with lanes lets the P7 guard resume the requesting verb over the owner\'s instructed step (item 5)',
    killed_by: /the lane's tree changed since, replaces on_pass, and the P7 guard does not resume the requesting verb over it/,
  },
  {
    id: 'F6c', file: APP, tests: [TD],
    from: "  if (facts.fields.current_phase === 'phase-7-commit' || (terminal && ['commit-complete', 'close-complete'].includes(facts.fields.current_phase))) {",
    to: "  if (terminal && ['commit-complete', 'close-complete'].includes(facts.fields.current_phase)) {",
    why: 'a run applies an instruction over a commit the child began and did not finish',
    killed_by: /leaves an instruction pending beside a commit the child began and did not finish/,
  },
  // ---- G: the slice's second critique ------------------------------------------
  {
    id: 'G1a', file: APP, tests: [TC],
    from: '  if (linked.unreadable) {\n',
    to: '  if (false) {\n',
    why: 'a home that cannot be read hides the entries\' child, so none applies and the result reads none: the lane\'s old step runs over them',
    killed_by: /beside an unrelated archive file in another persona's home that does not parse/,
  },
  {
    id: 'G1b', file: ST, tests: [TC],
    from: '  if (wf.unreadable.length) {\n',
    to: '  if (false) {\n',
    why: 'a lane\'s child whose file cannot be read reads as no child (no-child), and the lane is decided as before',
    killed_by: /beside the lane's own child, whose file does not parse/,
  },
  {
    id: 'G1c', file: ST, tests: [TC],
    from: "  } catch (err) {\n    return { state: 'waiting', detail: `the repository's worktrees cannot be listed",
    to: "  } catch (err) {\n    stateRoots = [mainRoot];\n  }\n  if (false) {\n    return { state: 'waiting', detail: `the repository's worktrees cannot be listed",
    why: 'worktrees git cannot list read as the main checkout alone: a child in a worktree goes unseen, and the application goes on',
    killed_by: /when the repository's worktrees cannot be listed/,
  },
  {
    id: 'G1d', file: CMD, tests: [TC],
    from: '      stateRoots = childStateRoots(mainRoot);\n    } catch (err) {\n',
    to: '      stateRoots = childStateRoots(mainRoot);\n    } catch (err) {\n      stateRoots = [mainRoot];\n    }\n    if (false) {\n',
    why: 'the owner command writes an instruction whose lane it searched in the main checkout alone',
    killed_by: /when the repository's worktrees cannot be listed, and refuses a write then/,
  },
  {
    id: 'G2', file: IBD, tests: [TR],
    from: "  if (ids.state === 'unreadable') {\n",
    to: "  if (false) {\n",
    why: 'an instructions directory that cannot be listed reads as no instruction anywhere: every lane\'s old step runs',
    killed_by: /names every open subtask of the plan, unreadable, when the instructions directory cannot be listed/,
  },
  {
    id: 'G1e', file: APP, tests: [TC],
    from: "          if (typeof id !== 'string' || id === '') { unreadableAt.push(file); continue; }\n          if (!allCopies && seen.has(`${sub}:${id}`)) continue;\n",
    to: "          if (typeof id !== 'string' || id === '' || (!allCopies && seen.has(`${sub}:${id}`))) continue;\n",
    why: 'a linked child whose file names no workflow id is skipped: still active, it reads as gone, and the sweep drops the instruction child-archived',
    killed_by: /beside the lane's own child, whose file names no workflow id/,
  },
  {
    id: 'G1f', file: ST, tests: [TC],
    from: '  if (orphan) {\n',
    to: '  if (false) {\n',
    why: 'an entry left applying that no reserved receipt names reads as nothing pending: the result is none, and the lane\'s old step runs',
    killed_by: /leaves an entry left applying that no reserved receipt names unresolved/,
  },
  {
    id: 'G3a', file: SCH, tests: [TL],
    from: "      if (r.state === 'not-at-boundary' && r.step_first !== true) {\n",
    to: '      if (false) {\n',
    why: 'a lane at no boundary is decided as before: an operation that closes between the attempt and the step\'s start lets the recorded step run over the instruction',
    killed_by: /keeps a lane at no boundary from its recorded step until the instruction applies/,
  },
  {
    id: 'G3b', file: SCH, tests: [TL],
    from: "      if (r.state === 'not-at-boundary' && r.step_first !== true) {\n",
    to: "      if (r.state === 'not-at-boundary') {\n",
    why: 'a lane whose own step comes first (an interrupted commit) waits for a boundary only that step makes: it parks instead of running',
    killed_by: /decides a lane whose own step comes first/,
  },
  {
    id: 'G3c', file: DRV, tests: [TD],
    from: "          const waits = DEFER_STATES.has(a.result.state) || (a.result.state === 'not-at-boundary' && a.result.step_first !== true);\n",
    to: '          const waits = DEFER_STATES.has(a.result.state);\n',
    why: 'a serial run decides a lane at no boundary as before: its recorded step runs over the instruction',
    killed_by: /keeps a lane at no boundary \(an operation open\) from its recorded step/,
  },
  {
    id: 'G3d', file: DRV, tests: [TD],
    from: "          const waits = DEFER_STATES.has(a.result.state) || (a.result.state === 'not-at-boundary' && a.result.step_first !== true);\n",
    to: "          const waits = DEFER_STATES.has(a.result.state) || a.result.state === 'not-at-boundary';\n",
    why: 'a serial run waits on an interrupted commit for a boundary only the commit makes, and halts instead of running it',
    killed_by: /leaves an instruction pending beside a commit the child began and did not finish/,
  },
  {
    id: 'G3e', file: APP, tests: [TD],
    from: 'did not finish: the commit runs again, and its archive or gate decides`, stepFirst: true };\n',
    to: 'did not finish: the commit runs again, and its archive or gate decides`, stepFirst: false };\n',
    why: 'the boundary takes an interrupted commit for a wait: the run never lets the commit run again',
    killed_by: /leaves an instruction pending beside a commit the child began and did not finish/,
  },
  {
    id: 'G4a', file: SCH, tests: [TVLI],
    from: '      if (subtasksInFlight().has(id) || openBatches.has(id) || verifyActive?.subtaskId === id || forcedFirst || gateOf(id)) {\n',
    to: '      if ([...inflight.values()].some((e) => e.subtaskId === id) || forcedFirst || gateOf(id)) {\n',
    why: 'a lane whose batch has started is taken for one at its boundary: the run attempts an application while the batch waits for the heavy-work lock or runs its checks (the writer then refuses it, the child recording the batch open)',
    killed_by: /waits for the heavy-work lock, and one while its checks run, wait for the batch's end/,
  },
  {
    id: 'G4d', file: SCH, tests: [TVLI],
    from: '      if (subtasksInFlight().has(id) || openBatches.has(id) || verifyActive?.subtaskId === id || forcedFirst || gateOf(id)) {\n',
    to: "      if ([...inflight.values()].some((e) => e.subtaskId === id) || (verifyActive?.subtaskId === id && verifyActive.state === 'waiting') || forcedFirst || gateOf(id)) {\n",
    why: 'a batch keeps its lane only while it waits for the heavy-work lock: the run attempts an application while its checks run (the writer then refuses it, the child recording the batch open)',
    killed_by: /waits for the heavy-work lock, and one while its checks run, wait for the batch's end/,
  },
  {
    id: 'G4b', file: SCH, tests: [TVLI],
    from: '      if (subtasksInFlight().has(id) || openBatches.has(id) || verifyActive?.subtaskId === id || forcedFirst || gateOf(id)) {\n',
    to: '      if (subtasksInFlight().has(id) || openBatches.has(id) || verifyActive?.subtaskId === id || verifyQueue.has(id) || forcedFirst || gateOf(id)) {\n',
    why: 'a queued request is taken for a started batch: it runs before the instruction, which neither replaces it nor comes first',
    killed_by: [/a queued request is replaced by the instruction's step/, /a queued request is run under an instruction's note alone, after the note/],
  },
  {
    id: 'G4c', file: SCH, tests: [TVLI],
    from: '      if (subtasksInFlight().has(id) || openBatches.has(id) || verifyActive?.subtaskId === id || forcedFirst || gateOf(id)) {\n',
    to: "      if (subtasksInFlight().has(id) || openBatches.has(id) || verifyActive?.subtaskId === id || (lastGlobal ?? c.view)?.children?.[id]?.verify?.last_end === 'cut-short' || forcedFirst || gateOf(id)) {\n",
    why: 'what is left of a batch a hold cut short is taken for a batch still started: it runs before the instruction, which neither replaces it nor comes first',
    killed_by: [/what is left of a batch a hold cut short is replaced by the instruction's step/, /what is left of a batch a hold cut short is run under an instruction's note alone, after the note/],
  },
  // ---- H: the tests' pid files -------------------------------------------------
  {
    id: 'H1', file: PIDF, tests: [TW],
    from: "  if (!/^[1-9][0-9]*$/.test(s)) return null;\n",
    to: "  if (!/^-?[0-9]*$/.test(s)) return null;\n",
    why: 'an empty pid file reads as 0, and the kill a test sends it reaches its own runner\'s group',
    killed_by: /a pid file that is empty, missing or not a positive pid reads as null/,
  },
  {
    id: 'H2', file: PIDF, tests: [TW],
    from: "  writeFileSync(tmp, String(pid));\n  renameSync(tmp, file);\n",
    to: "  writeFileSync(file, String(pid));\n",
    why: 'the fixture writes its pid in place: a reader between the open and the write reads an empty file',
    killed_by: /a published pid replaces the file whole/,
  },
  // ---- N: the slice's third critique --------------------------------------------
  {
    id: 'N1a', file: REC, tests: [TR, TA],
    from: '  for (const line of linesOutsideApplications(t, end + 5, applications)) {\n    if (RESOLVED_HEADING_RE.test(line)) resolved += 1;\n  }\n',
    to: "  let fence = null;\n  for (const line of t.slice(end + 5).split('\\n')) {\n    const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);\n    if (f) {\n      if (fence === null) fence = f[1];\n      else if (f[1][0] === fence[0] && f[1].length >= fence.length && line.trim() === f[1]) fence = null;\n      continue;\n    }\n    if (fence === null && RESOLVED_HEADING_RE.test(line)) resolved += 1;\n  }\n",
    why: 'the witness walks every fence in the child: one a worker left unclosed hides every later gate resolution, and the instruction\'s step overrides the owner\'s later resolution',
    killed_by: [/counts a resolution past an unclosed fence in a worker's note/, /sees a gate resolution past a worker note's unclosed fence/],
  },
  {
    id: 'N1b', file: REC, tests: [TR],
    from: "const RESOLVED_HEADING_RE = /^### Owner gate resolved: [a-z][a-z-]* at \\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$/;",
    to: 'const RESOLVED_HEADING_RE = /^### Owner gate resolved: /;',
    why: 'any line opening with the heading counts, the shape a worker\'s fenced prose quotes now that its fences are read line by line',
    killed_by: /reads the gate set and counts the resolutions outside the owner's notes/,
  },
  {
    id: 'N2a', file: REC, tests: [TR, TA],
    from: "    if (app && applications.has(app[1]) && (t.startsWith(`${line}\\n`) ? 0 : t.indexOf(`\\n${line}\\n`) + 1) === lineAt) {",
    to: "    if (app && (t.startsWith(`${line}\\n`) ? 0 : t.indexOf(`\\n${line}\\n`) + 1) === lineAt) {",
    why: 'a worker\'s closed quote of another lane\'s application heading is taken for this lane\'s note: its closing fence opens one, which hides every later resolution and Phase 0',
    killed_by: [/takes a heading of the application's shape for the owner's note only when the lane's record names its id/, /takes another lane's application heading, quoted at its first occurrence here, for a worker's text/, /sees a gate resolution past a worker's closed quote of another lane's application heading/],
  },
  {
    id: 'N2b', file: CMD, tests: [TC],
    from: "    const witness = facts.state === 'ok' ? gateWitnessOf(facts.text, laneApplicationIds(rec.state === 'ok' ? rec.record : null, id)) : null;",
    to: "    const witness = facts.state === 'ok' ? gateWitnessOf(facts.text) : null;",
    why: 'the owner command reads the witness with no application of the lane: an earlier owner note quoting a resolution counts at the write and not at the application, and the step is superseded over a gate no one set',
    killed_by: /reads the gate witness as the application does/,
  },
  {
    id: 'N2c', file: APP, tests: [TC],
    from: '      const p = planApplication(record, { child, linked, witness: gateWitnessOf(before, laneApplicationIds(record, child)),',
    to: '      const p = planApplication(record, { child, linked, witness: gateWitnessOf(before),',
    why: 'the application reads the witness with no application of the lane: an earlier owner note quoting a resolution counts now and not at the write, and the step is superseded over a gate no one set',
    killed_by: /reads the gate witness as the application does/,
  },
  {
    id: 'N2d', file: IBD, tests: [TA],
    from: '  if (workerStepSince(text, at + 1, laneApplicationIds(r.record, child))) return null;\n',
    to: '  if (workerStepSince(text, at + 1)) return null;\n',
    why: 'the P2 scan reads the owner\'s notes as a worker\'s: a Phase 0 heading quoted in them is taken for a step, and the instruction\'s provenance is lost',
    killed_by: /takes a Phase 0 heading quoted in the owner's note for no step/,
  },
  // ---- N3: the slice's fourth critique ------------------------------------------
  {
    id: 'N3a', file: REC, tests: [TR, TA],
    from: "    .filter((r) => r?.child === child && (r.state === 'done' || r.state === 'reserved'))\n",
    to: "    .filter((r) => r?.state === 'done' || r?.state === 'reserved')\n",
    why: "every receipt of the lane names an owner's note in the child being read: a replacement child's quote of its predecessor's application heading is taken for this child's note, and its closing fence hides every later resolution and Phase 0",
    killed_by: [/takes only the receipts of the child being read for its owner's notes/, /sees a gate resolution past a replacement child's quote/, /sees a worker's Phase 0 past a replacement child's quote/],
  },
  {
    id: 'N3b', file: REC, tests: [TR],
    from: "    .filter((r) => r?.child === child && (r.state === 'done' || r.state === 'reserved'))\n",
    to: "    .filter((r) => r?.child === child)\n",
    why: "a rolled-back receipt, ended on proof that its child holds no such heading, names an owner's note: a later quote of its heading is taken for one, and its closing fence hides every later resolution",
    killed_by: /takes a rolled-back receipt's heading for a quote/,
  },
  {
    id: 'N3c', file: CMD, tests: [TC],
    from: "    const witness = facts.state === 'ok' ? gateWitnessOf(facts.text, laneApplicationIds(rec.state === 'ok' ? rec.record : null, id)) : null;",
    to: "    const witness = facts.state === 'ok' ? gateWitnessOf(facts.text, laneApplicationIds(rec.state === 'ok' ? { receipts: (rec.record.receipts ?? []).map((x) => ({ ...x, child: id })) } : null, id)) : null;",
    why: "the owner command reads a replacement child with the earlier child's applications: its quote hides a resolution at the write that the application sees, and the new instruction's step is superseded over a gate resolved before it",
    killed_by: /reads a replacement child's witness as the application does/,
  },
  {
    id: 'N3d', file: APP, tests: [TA],
    from: "      const p = planApplication(record, { child, linked, witness: gateWitnessOf(before, laneApplicationIds(record, child)),",
    to: "      const p = planApplication(record, { child, linked, witness: gateWitnessOf(before, laneApplicationIds({ receipts: (record.receipts ?? []).map((x) => ({ ...x, child })) }, child)),",
    why: "the application reads a replacement child with the earlier child's applications: the quote's closing fence hides the owner's later resolution, and the instruction's step overwrites it",
    killed_by: /sees a gate resolution past a replacement child's quote/,
  },
  {
    id: 'N3e', file: IBD, tests: [TA],
    from: "  if (workerStepSince(text, at + 1, laneApplicationIds(r.record, child))) return null;\n",
    to: "  if (workerStepSince(text, at + 1, laneApplicationIds({ receipts: (r.record.receipts ?? []).map((x) => ({ ...x, child })) }, child))) return null;\n",
    why: "the P2 scan reads a replacement child with the earlier child's applications: the quote's closing fence hides a worker's Phase 0, and the instruction keeps a provenance the worker's step ended",
    killed_by: /sees a worker's Phase 0 past a replacement child's quote/,
  },
  // ---- Q: the slice's fifth critique --------------------------------------------
  {
    id: 'Q1a', file: SCH, tests: [TL],
    from: '      if (subtasksInFlight().has(id) || openBatches.has(id) || verifyActive?.subtaskId === id || forcedFirst || gateOf(id)) {\n',
    to: '      if (openBatches.has(id) || verifyActive?.subtaskId === id || forcedFirst || gateOf(id)) {\n',
    why: "a lane whose worker step runs is taken for one at its boundary: the instruction is applied mid-step, the worker's finish-verb overwrites its step, and the owner's step is acknowledged and lost",
    killed_by: /to a lane mid-step: left pending while the step runs, applied after it/,
  },
  {
    id: 'Q2a', file: SCH, tests: [TVL],
    from: "        const refused = step && step.kind !== 'dispatch'\n",
    to: "        const refused = step && (step.kind === 'verb' || step.kind === 'commit')\n",
    why: "a run with lanes takes the owner's rerun beside a pending instruction with a step: the batch runs first, and the later of the two words decides by the order the code looks in",
    killed_by: /`--lane A --next verify` beside a pending instruction that carries a next step is refused/,
  },
  {
    id: 'Q2b', file: DRV, tests: [TV],
    from: "    if (ctx.forced && ctx.forced.kind !== 'dispatch' && view.macro?.id) {\n",
    to: "    if (ctx.forced && (ctx.forced.kind === 'verb' || ctx.forced.kind === 'commit') && view.macro?.id) {\n",
    why: "a serial run takes the owner's rerun beside a pending instruction with a step: the batch runs first, and the later of the two words decides by the order the code looks in",
    killed_by: /`--next verify` beside a pending instruction that carries a next step is refused/,
  },
  {
    id: 'Q2c', file: DRV, tests: [TD],
    from: "filter((x) => x?.status === 'in_progress' && view.children?.[x.id]?.location === 'active')) {\n",
    to: "filter((x) => x?.status === 'in_progress')) {\n",
    why: "a serial run reads every subtask in progress for the forced step's refusal: a sibling whose child has archived, awaiting its landing, refuses the active child's forced step with an instruction that applies to nothing",
    killed_by: /takes a forced step beside a sibling's pending instruction with a step when the sibling's child has archived/,
  },
  {
    id: 'Q3a', file: REC, tests: [TR, TC],
    from: "  if (!m || rest.length !== 0) return { ok: false, code: 'not-a-step' };\n",
    to: "  if (!m) return { ok: false, code: 'not-a-step' };\n",
    why: 'a step with trailing words is taken: the owner\'s free text reaches the step grammar, which carries none',
    killed_by: [/refuses a dispatch, a rerun and anything malformed, each with its own code/, /refuses a malformed step, a dispatch and a rerun as the step, with nothing written/],
  },
  {
    id: 'Q3b', file: REC, tests: [TR, TC],
    from: '  if (STEP_VERBS.includes(m[1])) return',
    to: '  if (m[1]) return',
    why: 'a verb the engineer does not have is taken as a step: the owner command writes it, and only the engineer\'s own check at the application refuses it',
    killed_by: [/refuses a dispatch, a rerun and anything malformed, each with its own code/, /refuses a malformed step, a dispatch and a rerun as the step, with nothing written/],
  },
  {
    id: 'Q3c', file: CMD, tests: [TC],
    from: '    if (!p.ok) { err(',
    to: '    if (false) { err(',
    why: 'the owner command writes an instruction for a step the parser refused, where it must write nothing',
    killed_by: /refuses a malformed step, a dispatch and a rerun as the step, with nothing written/,
  },
  // ---- T: the slice's sixth critique --------------------------------------------
  {
    // T1a and T1b are one defect, split by driver so that each run's
    // unmutated control stays within the harness's default timeout.
    id: 'T1a', file: APP, tests: [TA, TV],
    from: '  if (batch) {\n',
    to: '  if (false) {\n',
    why: "a batch a dead driver left open is taken for a boundary: the instruction's step replaces the request first, the verify step never runs to end the batch, and the record keeps it open for good",
    killed_by: [/verification batch started and not ended at no boundary/, /a relaunch ends the batch a dead driver left open/],
  },
  {
    id: 'T1b', file: APP, tests: [TVLI],
    from: '  if (batch) {\n',
    to: '  if (false) {\n',
    why: "a run with lanes takes a batch a dead driver left open for a boundary: the instruction's step replaces the request first, and the record keeps the batch open for good",
    killed_by: /a relaunch ends the batch a dead driver left open/,
  },
  {
    id: 'T2a', file: IBD, tests: [TD, TL],
    from: "  const live = steps.filter((e) => e.state === 'applying' || dropCause(e, { subtask, active, linked }) === null);\n",
    to: '  const live = steps;\n',
    why: 'a forced step is refused naming an instruction bound to a child that no longer has the lane, one that applies to nothing (item 6) and is dropped at the next boundary',
    killed_by: [/forced step beside a pending instruction with a step bound to a child that no longer has the lane/, /--lane <id> --next beside a pending instruction with a step bound to a child that no longer has the lane/],
  },
  {
    id: 'T2b', file: IBD, tests: [TD],
    from: "  if (r.state === 'unreadable') return { unreadable: r.path };\n",
    to: '',
    why: 'a forced step is taken over an instructions record that cannot be read, which may hold a pending next step',
    killed_by: /bound to a child that no longer has the lane, which is then dropped; a record that cannot be read refuses it/,
  },
  {
    id: 'T3a', file: DRV, tests: [TD],
    from: '(x.only === null || x.only.length > 0)',
    to: 'x.only === null',
    why: 'a serial run applies a note pending at its launch only after the forced step, which then runs without it (item 3: the next run applies them before it acts on the lane)',
    killed_by: /takes one beside a note alone, applying the note pending at launch before it/,
  },
  {
    id: 'T3b', file: DRV, tests: [TD],
    from: 'only: ctx.forced === null ? null : launchEntries(mainRoot, view.macro.id, x.subtaskId, launch)',
    to: 'only: null',
    why: "a serial run applies an instruction written after its launch before the untaken forced step, whose finish-verb then overwrites the instruction's step: the earlier word lost to the later by the order the code looks in",
    killed_by: /makes an instruction written after the launch wait for the untaken forced step/,
  },
  {
    id: 'T3c', file: SCH, tests: [TL],
    from: '      const forcedFirst = onlyEntries !== null && onlyEntries.length === 0;\n',
    to: '      const forcedFirst = forced.has(id);\n',
    why: "a run with lanes applies a note pending at its launch only after the lane's forced step, which then runs without it",
    killed_by: /applies a note pending at a relaunch before the lane's forced step/,
  },
  {
    id: 'T3d', file: SCH, tests: [TL],
    from: '      const onlyEntries = forced.has(id) ? launchEntries(mainRoot, macroId, id, launchInstructions) : null;\n',
    to: '      const onlyEntries = null;\n',
    why: "a run with lanes applies an instruction written after its launch before the lane's untaken forced step, whose finish-verb then overwrites the instruction's step",
    killed_by: /applies a note pending at a relaunch before the lane's forced step, and makes one written after the launch wait for it/,
  },
  {
    id: 'T3e', file: APP, tests: [TA, TL],
    from: "e.state === 'pending' && (only === null || only.has(",
    to: "e.state === 'pending' && (true || only.has(",
    why: 'the reservation beside a forced step takes every pending entry, an instruction written between the look and the reservation included, whose step the forced step then overwrites',
    killed_by: [/reserves only the entries it is given beside a forced step/, /makes one written after the launch wait for it/],
  },
  {
    id: 'T3f', file: ST, tests: [TL],
    from: "          by: flags.by || 'run',\n          onlyEntries,\n",
    to: "          by: flags.by || 'run',\n",
    why: "instruct-apply drops the run's launch entries, so the reservation beside a forced step takes an instruction written since",
    killed_by: /makes one written after the launch wait for it/,
  },
  {
    id: 'T3g', file: DRV, tests: [TD],
    from: "      const deferredId = d.outcome === 'halt' ? d.subtaskId : d.step?.subtaskId;\n",
    to: "      const deferredId = d.outcome === 'halt' ? d.subtaskId : (d.step?.forced ? null : d.step?.subtaskId);\n",
    why: 'a serial run takes its forced step while the application of a note pending at the launch is deferred, and the step runs without the note',
    killed_by: /keeps an untaken forced step waiting while the application of a note pending at the launch is deferred/,
  },
  {
    id: 'T1c', file: VRN, tests: [TVR],
    from: "    if (plan.action === 'start' && typeof job.yieldsToInstruction === 'function' && job.yieldsToInstruction()) {\n",
    to: '    if (false) {\n',
    why: "the verify step continues a batch it has just ended though an instruction with a step is pending: what is left of the batch, a request not running, runs before the instruction replaces it (item 5)",
    killed_by: /with an instruction's step pending, not continued: the step gives the lane back/,
  },
  {
    id: 'T1d', file: DRV, tests: [TV],
    from: '        yieldsToInstruction: stepPending,\n',
    to: '        yieldsToInstruction: () => false,\n',
    why: 'a serial run continues a batch a dead driver left open past a pending instruction with a step',
    killed_by: /which then replaces what is left of it/,
  },
  {
    id: 'T1e', file: SCH, tests: [TVLI],
    from: '      yieldsToInstruction: stepPending,\n',
    to: '      yieldsToInstruction: () => false,\n',
    why: 'a run with lanes continues a batch a dead driver left open past a pending instruction with a step',
    killed_by: /which then replaces what is left of it/,
  },

  // ---- T4: the seventh critique (2026-11-02) ---------------------------------------------------
  {
    id: 'T4a', file: SCH, tests: [TL],
    from: '    seenThrough();\n    return again;\n',
    to: '    instructionsSeen.begin()();\n    return again;\n',
    why: 'the pass takes the records as seen at its end: an owner write that landed after it read what was due wakes nothing, and a parked lane waits for some other event',
    killed_by: /wakes within the poll for an instruction written while a pass ran/,
  },
  {
    id: 'T4b', file: IBD, tests: [TR],
    from: '      return () => { if (seen === was) seen = at; };\n',
    to: '      return () => { if (seen === was) seen = read(); };\n',
    why: 'the watch reads the digest at the pass\'s end, not its start: a write during the pass is taken as seen',
    killed_by: /wakes the poll after a pass for an owner write that landed while the pass ran/,
  },
  {
    id: 'T4c', file: IBD, tests: [TR],
    from: '      return () => { if (seen === was) seen = at; };\n',
    to: '      return () => { seen = at; };\n',
    why: 'the pass\'s end takes back a later digest a poll during the pass already took, so the poll after it wakes again',
    killed_by: /wakes the poll after a pass for an owner write that landed while the pass ran/,
  },
  {
    id: 'T4d', file: REC, tests: [TR],
    from: "  return `entries\\0${JSON.stringify(v.entries.map((e) => [e?.id ?? null, e?.revision ?? null, e?.state === 'withdrawn']))}`;\n",
    to: '  return `bytes\\0${text}`;\n',
    why: 'the wake digest covers every byte of a record: a run\'s own reservation, rollback, application or drop wakes the loop and forgets every attempt, a failed lane\'s included',
    killed_by: /leaves the wake digest as it was at a run's own writes/,
  },
  {
    id: 'T4e', file: REC, tests: [TR],
    from: "e?.state === 'withdrawn']))",
    to: "false]))",
    why: 'a withdrawal is no wake: the lane it held back waits for some other event',
    killed_by: /changes the wake digest at every write the owner makes/,
  },
  {
    id: 'T4f', file: REC, tests: [TR],
    from: '  if (!validInstructions(v, subtaskId)) return `bytes\\0${text}`;\n',
    to: "  if (v === null || typeof v !== 'object' || !Array.isArray(v.entries)) return `bytes\\0${text}`;\n",
    why: 'a record the readers refuse, its ids and revisions kept, is digested by them alone: its corruption and its repair wake nothing',
    killed_by: /changes the wake digest at every write the owner makes/,
  },

  // ---- T5: the eighth critique (2026-11-02) ----------------------------------------------------
  {
    id: 'T5a', file: SCH, tests: [TL],
    from: '      if (instructionsSeen.sincePass()) { instructTried.clear(); continue; }\n',
    to: '',
    why: 'the idle end never reads the instruction records again: one the owner wrote during its last looks, which a tick took as seen, is left pending as the run halts beside it',
    killed_by: /applies an instruction written during the idle end's last looks before the run ends/,
  },
  {
    id: 'T5b', file: IBD, tests: [TR],
    from: '      if (now === passed) return false;\n',
    to: '      if (now === seen) return false;\n',
    why: 'the end compares the records with what a poll took as seen, not with what the last pass read: a write a tick saw during the end\'s looks is never told to it',
    killed_by: /tells the run's end of an owner write since the last pass read the records/,
  },
  {
    id: 'T5c', file: IBD, tests: [TR],
    from: '      passed = at;\n',
    to: '',
    why: 'a pass does not mark what it read: the end is told of a write the pass already acted on, and runs one more pass for it',
    killed_by: /tells the run's end of an owner write since the last pass read the records/,
  },
  {
    id: 'T5d', file: IBD, tests: [TR],
    from: '      passed = now;\n      return true;\n',
    to: '      return true;\n',
    why: 'the end is told of the same write again and again: an end that cannot run a pass (no plan to read) never ends',
    killed_by: /tells the run's end of an owner write since the last pass read the records/,
  },

  // ---- T6: the ninth critique (2026-11-02) -----------------------------------------------------
  {
    id: 'T6a', file: SCH, tests: [TL],
    from: '      && instructionsUntried(id, instructTried.get(id)?.key ?? null)) {\n',
    to: '      && false) {\n',
    why: 'a run with lanes admits a step with no look at the instructions: one the owner wrote during the landing report, after the loop\'s passes, loses to the commit decided without it, which archives the child and drops it',
    killed_by: /applies an instruction written during the landing report, after the loop's passes/,
  },
  {
    id: 'T6b', file: SCH, tests: [TL],
    from: '      && instructionsUntried(id, instructTried.get(id)?.key ?? null)) {\n',
    to: '      && instructionsUntried(id, null)) {\n',
    why: 'the admission does not ask what the last attempt met: a lane whose own step comes first (an interrupted commit) yields it once to an instruction the pass already tried',
    killed_by: /decides a lane whose own step comes first/,
  },
  {
    id: 'T6c', file: DRV, tests: [TD],
    from: '      if (instructionYields(d.step)) {\n',
    to: '      if (false) {\n',
    why: 'a serial run spawns a step with no look at the instructions: one the owner wrote after the turn\'s application, while the drift check resolved the roots, loses to the commit decided without it',
    killed_by: /applies an instruction written after the turn's application, while the run resolved its roots/,
  },
  {
    id: 'T6d', file: DRV, tests: [TD],
    from: '          instructKeys.set(due.subtaskId, key);\n',
    to: '',
    why: 'a serial turn keeps no record of what its attempt met: a commit the child began yields once to an instruction the turn already tried, and the turn is taken again',
    killed_by: /leaves an instruction pending beside a commit the child began and did not finish/,
  },
  {
    id: 'T6e', file: IBD, tests: [TR],
    from: '    if (key === triedKey || yielded.get(subtaskId) === key) return false;\n',
    to: '    if (key === triedKey) return false;\n',
    why: 'the admission yields to the same record at every turn: a lane a pass does not try (a pass that returned early) never steps, and the run turns without end',
    killed_by: /tells a step's admission of an instruction pending on a record no application attempt met/,
  },
  {
    id: 'T6f', file: IBD, tests: [TR],
    from: '    if (rec.state === \'ok\' && !rec.record.entries.some(pendingOrApplying)) return false;\n',
    to: '',
    why: 'a record with nothing pending (every entry withdrawn or applied) still yields the step, one turn lost after every owner write',
    killed_by: /tells a step's admission of an instruction pending on a record no application attempt met/,
  },
  {
    id: 'T6g', file: DRV, tests: [TD],
    from: '          instructKeys.set(due.subtaskId, key);\n',
    to: '          instructKeys.set(due.subtaskId, instructionsKey(mainRoot, view.macro.id, due.subtaskId));\n',
    why: 'a serial turn reads what its attempt met after the attempt returns: an instruction the owner wrote while the applier\'s group was torn down counts as tried, and the commit runs over it',
    killed_by: /applies an instruction written after the turn's application wrote and before it returned/,
  },

  // ---- T7: the tenth critique (2026-11-02) -----------------------------------------------------
  {
    id: 'T7a', file: VRN, tests: [TV],
    from: '  if (typeof job.instructionWrittenSince === \'function\' && job.instructionWrittenSince()) {\n',
    to: '  if (false) {\n',
    why: 'a batch starts with no look at the instructions after its preparation: one with a step the owner wrote during the checks\' selection, after the admission, does not replace the request, and the whole batch runs first',
    killed_by: /written while a batch is prepared, after the admission, starts no batch/,
  },
  {
    id: 'T7b', file: DRV, tests: [TV],
    from: '        instructionWrittenSince: () => stepPending() && instructionsUntried(id, instructKeys.get(id) ?? null),\n',
    to: '        instructionWrittenSince: () => false,\n',
    why: 'a serial run gives its batch no hook for an instruction written while the batch is prepared: the batch the instruction replaces runs',
    killed_by: /written while a batch is prepared, after the admission, starts no batch/,
  },
  {
    id: 'T7c', file: SCH, tests: [TVLI],
    from: '      instructionWrittenSince: () => stepPending() && instructionsUntried(id, instructTried.get(id)?.key ?? null),\n',
    to: '      instructionWrittenSince: () => false,\n',
    why: 'a run with lanes gives its batch no hook for an instruction written while the batch is prepared: the batch the instruction replaces runs',
    killed_by: /written while a batch is prepared, after the admission, starts no batch/,
  },
  {
    id: 'T7d', file: DRV, tests: [TV],
    from: '      if (instructionYields(s)) return { again: true };\n',
    to: '',
    why: 'a serial verification step is admitted with no look at the instructions: a note written while its drift check resolved the roots is applied only after the batch, not before the step (II16, untested until the tenth critique)',
    killed_by: /a note written while the run resolves its roots for a verification step/,
  },
  {
    id: 'T7e', file: DRV, tests: [TV],
    from: '      } else if (r.instruction === true) {\n',
    to: '      } else if (false) {\n',
    why: 'a serial run counts a batch that yielded to an owner\'s instruction as a step that changed nothing: two owner writes in a row halt the run no-progress',
    killed_by: /two batches in a row that yield to an instruction written while each was prepared/,
  },
  {
    id: 'T7f', file: SCH, tests: [TVLI],
    from: '    } else if (r.instruction === true) {\n',
    to: '    } else if (false) {\n',
    why: 'a run with lanes counts a batch that yielded to an owner\'s instruction as a step that changed nothing: two owner writes in a row park the lane no-progress',
    killed_by: /two batches in a row that yield to an instruction written while each was prepared/,
  },
  {
    id: 'T7g', file: DRV, tests: [TV],
    from: '        return Boolean(p?.entries || p?.unreadable);\n',
    to: '        return Boolean(p?.entries);\n',
    why: 'a serial run starts a batch beside an instruction record it cannot read, which may hold the step that replaces the request',
    killed_by: /an instruction record that cannot be read while a batch is prepared starts no batch/,
  },
  {
    id: 'T7h', file: SCH, tests: [TVLI],
    from: '      return Boolean(p?.entries || p?.unreadable);\n',
    to: '      return Boolean(p?.entries);\n',
    why: 'a run with lanes starts a batch beside an instruction record it cannot read, which may hold the step that replaces the request',
    killed_by: /an instruction record that cannot be read while a batch is prepared starts no batch/,
  },
];
