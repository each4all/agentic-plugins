// Mutation spec — do the review-gate tests catch the defects they exist for?
// (C163 A1b; ADR-0063 and ADR-0028, implementation notes of 2026-11-07)
//
// Run: npm run mutate -- scripts/mutation-specs/review-gate.mjs
//
// Every rule here fails open and quietly: a lane whose review failed commits
// as if it had passed, and nothing downstream says so. Each mutation removes
// one rule and names the tests that must notice. The persona mutations edit
// the generated copies the tests import (ADR-0066): engineer is the one
// persona with the commit driver. The library mutations edit the
// orchestrator's byte copy, which the policy suite reads through the observer.
//
// Groups: L the library's rule (reviewGate; L20–L23 and L24–L27 one outcome
// class each, on the orchestrator's copy and the engineer's), K its skips and
// the skip reasons, O the autopilot policy and its reports, S state.mjs's
// review-gate and review-accept, P Phase 7.

const T_ORCH = 'tests/orchestrator/test-autopilot-review-gate.mjs';
const T_PERSONA = 'tests/persona-pipeline/test-review-gate.mjs';

const LIB = 'plugins/orchestrator/scripts/lib/review-attempts.mjs';
const PERSONA_LIB = 'plugins/engineer/scripts/lib/review-attempts.mjs';
const OBSERVE = 'plugins/orchestrator/adapters/claude/autopilot/observe.mjs';
const POLICY = 'plugins/orchestrator/adapters/claude/autopilot/policy.mjs';
const LANDING = 'plugins/orchestrator/adapters/claude/autopilot/landing-ready.mjs';
const SCHEDULER = 'plugins/orchestrator/adapters/claude/autopilot/scheduler.mjs';
const DRIVER = 'plugins/orchestrator/adapters/claude/autopilot/driver.mjs';
const ROOTS = 'plugins/orchestrator/adapters/claude/autopilot/roots.mjs';
const STATE = 'plugins/engineer/scripts/state.mjs';
const PHASE7 = 'plugins/engineer/scripts/phase7-commit.mjs';

export const TESTS = [T_ORCH, T_PERSONA];

const T_CLASSES = /failed, degraded, unavailable, malformed and unknown hold it; passed, concerns, conflict and skipped do not/;
const T_LATEST = /the latest is the last attempt listed, whatever an earlier one was: an open one reads unknown/;
const T_SUPERSEDED = /a superseded attempt listed last is unknown: its replacement registers after it/;
const T_LEGACY_ORDER = /a legacy review row an older writer added after the latest attempt, or one that cannot be ordered/;
const T_LANE_RECHECK = /a forced commit judged when the run began meets the gate again at each decision/;
const T_CARRIER = /reads the record from an older engineer's forward-compat carrier/;
const T_P7_UNKNOWN = /a review record that cannot be read is unknown, and refuses the commit/;
const T_ACCEPT_LIB = /an acceptance naming the latest attempt lets it; one naming an earlier attempt is stale/;
const T_HALT = /a commit step over a failed review halts awaiting-owner:review-outcome/;
const T_EACH = /each blocking outcome class halts the commit; each usable one lets it/;
const T_DONE_RECOVERY = /the done step and the recovery of a commit begun are held too/;
const T_FORCED = /the owner's --next <verb> replaces the halt; --next commit does not/;
const T_RESOLUTION = /resolution, restart and invalidation: the owner's acceptance lets the relaunched run commit/;
const T_LANE_FORCED = /--lane A \/engineer:commit is refused while the lane is held/;
const T_PARK = /the owner's acceptance, a re-acceptance for another tree and a new outcome each move a held lane's fingerprint/;
const T_WAITING = /a subtask waiting to land carries its review outcomes/;
const T_DEDUP = /a new outcome, an acceptance or a history found incomplete at unchanged commits is a new observation/;
const T_STATE_ACCEPT = /a failed latest review holds the commit; the owner accepts it for this tree, and the gate lets it/;
const T_STATE_MOVED = /an edit after the acceptance moves the tree, and holds the commit again/;
const T_STATE_REFUSED = /review-accept is refused under an autopilot run, for an attempt that is not the latest/;
const T_P7_REFUSE = /under autopilot a failed latest review refuses the commit \(exit 10\)/;
const T_P7_MOVED = /the owner's acceptance lets the commit; an edit after it holds the commit again/;
const T_P7_RECOVERY = /the recovery of a commit begun is held as well; an acceptance lets it recover/;
const T_P7_WARN = /interactively execute warns and commits/;
// The refine of 2026-11-07 (critique MAJOR 1–5).
const T_BOUND = /an acceptance given while the attempt read one outcome is stale once it reads another/;
// The refine of 2026-11-07, second pass (critique MAJOR 1–6).
const T_BACKWARD = /a supersession link back to an earlier attempt revives nothing/;
const T_SKIP_CLEARS = /a review that never ran clears no earlier outcome that holds the commit/;
const T_QUOTE = /a workflow path with a space, a non-ASCII character or a quote is quoted into the accept command/;
const T_LANDING_EVENT = /the landing event carries the review record, so a new outcome at unchanged commits is reported again/;
const T_LANES_RUN = /two lanes held on the review gate: the halt names A's outcomes, its also B's/;
const T_STATE_SUPERSEDE = /review-attempt-supersede refuses a replacement listed before the attempt it replaces/;
const T_P7_ADMISSION = /a failed review recorded after the plan and the first check refuses the commit at admission/;
const T_P7_SKIP = /a review skipped after a failure \(local-only, privacy-gate\) refuses the commit/;
const T_P7_STAGING = /a held review is refused before the staging-set gate is recorded/;
const T_SKIP_SUPERSEDE = /a skip clears no unresolved supersession, and none of the history truncation dropped/;
const T_BOUND_RECORD = /an acceptance is bound to the record the owner saw/;
const T_P7_STALE = /an acceptance a later registration made stale stays stale when a skip reads the accepted attempt again/;
const T_INSTANT = /a legacy row is ordered against the latest attempt by instant, whatever the precision/;
const T_SKIP = /skipped with no reason, an unspecified one or owner-skip holds the commit/;
const T_PARK_V = /a park kept before the review facts \(fingerprint version 3\) is never compared/;
const T_STATE_OPEN = /review-accept refuses an attempt still open \(its run pending\)/;
const T_STATE_SKIP = /a skipped review with no reason given holds the commit, and the owner can accept it/;
const T_REACCEPT = /accepting the same attempt for the same tree again, after it settled with another outcome, moves the fingerprint/;
const T_STATE_SPLIT = /review-accept refuses an open attempt an older writer settled \(no pending run\), and a closed one whose run is still pending/;
// The refine of 2026-11-07, third pass (critique MAJOR 1–4).
const T_VERIFY = /verifyStep: a commit step that leaves the gate holding, with no new commit, is the gate's halt/;
const T_VERIFY_CONTROLS = /a commit made, a stored gate recorded, or a worker that crashed is not this halt/;
const T_NOT_THE_GATE = /a step the gate did not stop is judged as any other/;
const T_FAILED_KEPT = /a failed report stays worker-failed, so the run cancels its peers, and carries the record/;
const T_DECIDE_MOVED = /decide holds the step: a moved tree, or one that cannot be compared, halts on the gate/;
const T_RESOLUTION_TEXT = /a parked lane's resolution names only what its record takes/;
const T_E2E_MOVED = /moved before the step, the run halts with no worker; moved during it, Phase 7 refuses and the run halts on the gate/;
// One end-to-end test of these five runs became two (it came within seconds
// of the suite's timeout): the kept park, and the edit and re-acceptance.
const T_E2E_KEPT = /a kept park reports its record$/;
const T_E2E_REACCEPT = /an edit after the acceptance holds the lane on the gate; the first tree accepted again is picked up and commits/;
const T_REACCEPT_SAME = /a re-acceptance of the same attempt and tree moves the fingerprint/;
const T_PRINTED_NEXT = /the --next the halt prints parses, and a run with lanes takes the --lane it prints/;
const T_REPAIR = /a record this reader cannot use offers neither a new review nor an acceptance/;
// The refine of 2026-11-07, fourth pass (critique MAJOR 2, 3 and 5).
const T_SKIP_HOLDS = /a skip that holds hides no failure behind it, and only the failure can be accepted/;
const T_COMPACT_LAST = /compaction never drops the last attempt listed, the one the gate reads/;
const T_P7_SKIP_HOLDS = /a skip that holds after a failure refuses the commit and names the failure/;
const T_PLAN_HOLD = /interactively the plan names the hold before the decision, and writes nothing/;
const T_PLAN_CLEAN = /the plan names no hold over a clean tree that lands nothing/;
const T_PLAN_RELAY = /tells the agent to show the plan's review_hold before asking/;
const T_OPEN_WAY = /an attempt still open offers a new review, never the acceptance review-accept refuses/;
const T_FLOOR = /an engineer with no review-accept is below the floor/;
const T_STATE_UNCOMPARED = /a working tree that cannot be compared holds the commit, whatever the acceptance names/;
const T_STATE_WAYS = /the hold offers no new review or acceptance for a record no new review can repair/;
const T_P7_BOUND =/an acceptance given while the attempt read another outcome, and a skip with no reason, each refuse the commit/;

export const MUTATIONS = [
  // ---- L: the library's rule ------------------------------------------------------
  {
    id: 'L1', file: LIB, tests: [T_ORCH],
    from: "export const REVIEW_BLOCKING_OUTCOMES = Object.freeze(['failed', 'degraded', 'unavailable', 'malformed', UNKNOWN_OUTCOME]);",
    to: "export const REVIEW_BLOCKING_OUTCOMES = Object.freeze(['failed', 'degraded', 'unavailable', 'malformed']);",
    why: 'an open attempt, a legacy row or an unreadable record (unknown) no longer holds the commit: a review that never closed reads as passed',
    killed_by: [T_CLASSES, T_LATEST, T_EACH],
  },
  {
    id: 'L20', file: LIB, tests: [T_ORCH],
    from: "export const REVIEW_BLOCKING_OUTCOMES = Object.freeze(['failed', 'degraded', 'unavailable', 'malformed', UNKNOWN_OUTCOME]);",
    to: "export const REVIEW_BLOCKING_OUTCOMES = Object.freeze(['degraded', 'unavailable', 'malformed', UNKNOWN_OUTCOME]);",
    why: 'a latest outcome of failed no longer holds the commit: the autopilot commits as if the review had passed',
    killed_by: [T_CLASSES, T_EACH],
  },
  {
    id: 'L24', file: PERSONA_LIB, tests: [T_PERSONA],
    from: "export const REVIEW_BLOCKING_OUTCOMES = Object.freeze(['failed', 'degraded', 'unavailable', 'malformed', UNKNOWN_OUTCOME]);",
    to: "export const REVIEW_BLOCKING_OUTCOMES = Object.freeze(['degraded', 'unavailable', 'malformed', UNKNOWN_OUTCOME]);",
    why: "the persona's Phase 7 commits over a latest outcome of failed",
    killed_by: [T_P7_REFUSE],
  },
  {
    id: 'L21', file: LIB, tests: [T_ORCH],
    from: "export const REVIEW_BLOCKING_OUTCOMES = Object.freeze(['failed', 'degraded', 'unavailable', 'malformed', UNKNOWN_OUTCOME]);",
    to: "export const REVIEW_BLOCKING_OUTCOMES = Object.freeze(['failed', 'unavailable', 'malformed', UNKNOWN_OUTCOME]);",
    why: 'a latest outcome of degraded no longer holds the commit: the autopilot commits as if the review had passed',
    killed_by: [T_CLASSES, T_EACH],
  },
  {
    id: 'L25', file: PERSONA_LIB, tests: [T_PERSONA],
    from: "export const REVIEW_BLOCKING_OUTCOMES = Object.freeze(['failed', 'degraded', 'unavailable', 'malformed', UNKNOWN_OUTCOME]);",
    to: "export const REVIEW_BLOCKING_OUTCOMES = Object.freeze(['failed', 'unavailable', 'malformed', UNKNOWN_OUTCOME]);",
    why: "the persona's Phase 7 commits over a latest outcome of degraded",
    killed_by: [T_P7_REFUSE],
  },
  {
    id: 'L22', file: LIB, tests: [T_ORCH],
    from: "export const REVIEW_BLOCKING_OUTCOMES = Object.freeze(['failed', 'degraded', 'unavailable', 'malformed', UNKNOWN_OUTCOME]);",
    to: "export const REVIEW_BLOCKING_OUTCOMES = Object.freeze(['failed', 'degraded', 'malformed', UNKNOWN_OUTCOME]);",
    why: 'a latest outcome of unavailable no longer holds the commit: the autopilot commits as if the review had passed',
    killed_by: [T_CLASSES, T_EACH],
  },
  {
    id: 'L26', file: PERSONA_LIB, tests: [T_PERSONA],
    from: "export const REVIEW_BLOCKING_OUTCOMES = Object.freeze(['failed', 'degraded', 'unavailable', 'malformed', UNKNOWN_OUTCOME]);",
    to: "export const REVIEW_BLOCKING_OUTCOMES = Object.freeze(['failed', 'degraded', 'malformed', UNKNOWN_OUTCOME]);",
    why: "the persona's Phase 7 commits over a latest outcome of unavailable",
    killed_by: [T_P7_REFUSE],
  },
  {
    id: 'L23', file: LIB, tests: [T_ORCH],
    from: "export const REVIEW_BLOCKING_OUTCOMES = Object.freeze(['failed', 'degraded', 'unavailable', 'malformed', UNKNOWN_OUTCOME]);",
    to: "export const REVIEW_BLOCKING_OUTCOMES = Object.freeze(['failed', 'degraded', 'unavailable', UNKNOWN_OUTCOME]);",
    why: 'a latest outcome of malformed no longer holds the commit: the autopilot commits as if the review had passed',
    killed_by: [T_CLASSES, T_EACH],
  },
  {
    id: 'L27', file: PERSONA_LIB, tests: [T_PERSONA],
    from: "export const REVIEW_BLOCKING_OUTCOMES = Object.freeze(['failed', 'degraded', 'unavailable', 'malformed', UNKNOWN_OUTCOME]);",
    to: "export const REVIEW_BLOCKING_OUTCOMES = Object.freeze(['failed', 'degraded', 'unavailable', UNKNOWN_OUTCOME]);",
    why: "the persona's Phase 7 commits over a latest outcome of malformed",
    killed_by: [T_P7_REFUSE],
  },
  {
    id: 'L2', file: LIB, tests: [T_ORCH],
    from: '  const last = attempts[attempts.length - 1];',
    to: '  const last = attempts[0];',
    why: 'the first attempt is read as the latest: a review that failed after one that passed lets the commit',
    killed_by: [T_CLASSES, T_LATEST],
  },
  {
    id: 'L3', file: LIB, tests: [T_ORCH],
    from: "  return { ...last, outcome: UNKNOWN_OUTCOME, reason: replacement ? 'replacement-backward' : 'replacement-missing' };",
    to: "  return replacement ? { ...last, outcome: UNKNOWN_OUTCOME, reason: 'replacement-backward' } : null;",
    why: 'an attempt superseded by one that never registered reads as no review at all',
    killed_by: [T_SUPERSEDED],
  },
  {
    id: 'L16', file: LIB, tests: [T_ORCH],
    from: "  return { ...last, outcome: UNKNOWN_OUTCOME, reason: replacement ? 'replacement-backward' : 'replacement-missing' };",
    to: "  if (replacement) return replacement;\n  return { ...last, outcome: UNKNOWN_OUTCOME, reason: 'replacement-missing' };",
    why: 'a link back to an earlier attempt is followed: it revives a pass listed before, or an acceptance a later registration made stale (critique of 2026-11-07, MAJOR 2)',
    killed_by: [T_BACKWARD],
  },
  {
    // The condition goes, not the line: the truncation rule's `else if`
    // follows it, and a deleted line would leave that `else` unattached, a
    // syntax error every test of the file fails on, whatever it asserts.
    id: 'K4', file: LIB, tests: [T_ORCH],
    from: '      if (ran !== null && reviewOutcomeBlocks(ran)) pick = { ...ran, later_skip: pick.id };\n',
    to: '      if (false) pick = { ...ran, later_skip: pick.id };\n',
    why: "a worker's local-only or privacy-gate skip after a failed review clears the failure, and the commit lands (critique of 2026-11-07, MAJOR 3)",
    killed_by: [T_SKIP_CLEARS],
  },
  {
    // As K4: the condition goes, so the `else if` after it stays attached.
    id: 'K5', file: PERSONA_LIB, tests: [T_PERSONA],
    from: '      if (ran !== null && reviewOutcomeBlocks(ran)) pick = { ...ran, later_skip: pick.id };\n',
    to: '      if (false) pick = { ...ran, later_skip: pick.id };\n',
    why: "the persona's Phase 7 commits over a failure a later skip claims to clear",
    killed_by: [T_P7_SKIP],
  },
  {
    id: 'K6', file: LIB, tests: [T_ORCH],
    from: '      const ranAt = instantOf(ran?.recorded_at ?? ran?.registered_at);\n      if (ran === null || legacy.at === null || ranAt === null || legacy.at >= ranAt)',
    to: '      const ranAt = instantOf(pick?.recorded_at ?? pick?.registered_at);\n      if (pick === null || legacy.at === null || ranAt === null || legacy.at >= ranAt)',
    why: "a legacy row is ordered against the skip, not the review that ran: a skip after it hides the older writer's unknown",
    killed_by: [T_SKIP_CLEARS],
  },
  {
    id: 'K7', file: LIB, tests: [T_ORCH],
    from: "    if (a.outcome === 'superseded') {\n",
    to: '    if (false) {\n',
    why: 'a superseded attempt between the failure and the skip is read as the review that ran, and hides the failure',
    killed_by: [T_SKIP_CLEARS],
  },
  {
    id: 'K9', file: LIB, tests: [T_ORCH],
    from: "      if (j > i) continue;\n      return { ...a, outcome: UNKNOWN_OUTCOME, reason: j === -1 ? 'replacement-missing' : 'replacement-backward' };\n",
    to: '      continue;\n',
    why: 'a skip after an attempt whose replacement never registered (or is listed before it) passes over it, and the unknown it read is cleared (refine-verify F1)',
    killed_by: [T_SKIP_SUPERSEDE],
  },
  {
    id: 'K10', file: LIB, tests: [T_ORCH],
    from: "      else if (ran === null && view.coverage.reasons.includes('truncation')) pick = { ...pick, outcome: UNKNOWN_OUTCOME, reason: 'history-truncated' };\n",
    to: '',
    why: 'enough skips to truncate the record drop the failure before them, and the last skip lets the commit (refine-verify F3)',
    killed_by: [T_SKIP_SUPERSEDE],
  },
  {
    id: 'L17', file: LIB, tests: [T_ORCH],
    from: "  if ((doc.listed?.id ?? null) !== (listed?.id ?? null) || (doc.listed?.at ?? null) !== (listed?.at ?? null)) return 'other-attempt';\n",
    to: '',
    why: 'an acceptance a later registration made stale matches again once a skip reads the accepted attempt, or once compaction drops it and its id is recorded again (refine-verify F1, F2)',
    killed_by: [T_BOUND_RECORD],
  },
  {
    id: 'L18', file: LIB, tests: [T_ORCH],
    from: "  if (reasons.some((r) => !doc.gaps.includes(r))) return 'history-changed';\n",
    to: '',
    why: 'a gap found since the acceptance (a newer legacy row pruned) lets the acceptance match the attempt it had stopped covering (refine-verify F2)',
    killed_by: [T_BOUND_RECORD],
  },
  {
    id: 'L19', file: PERSONA_LIB, tests: [T_PERSONA],
    from: "  if ((doc.listed?.id ?? null) !== (listed?.id ?? null) || (doc.listed?.at ?? null) !== (listed?.at ?? null)) return 'other-attempt';\n",
    to: '',
    why: "the persona's Phase 7 commits on an acceptance a later registration made stale, once a skip reads the accepted attempt again",
    killed_by: [T_P7_STALE],
  },
  {
    id: 'K8', file: LIB, tests: [T_ORCH],
    from: "    if (a.outcome === 'skipped') continue;\n",
    to: '',
    why: 'a second skip clears the failure the first could not',
    killed_by: [T_SKIP_CLEARS],
  },
  {
    id: 'L9', file: LIB, tests: [T_ORCH],
    from: '      const ranAt = instantOf(ran?.recorded_at ?? ran?.registered_at);',
    to: '      const ranAt = ran?.recorded_at ?? ran?.registered_at ?? null;',
    why: "the latest attempt's time is not an instant: a legacy row after it (or of another precision) never orders after it, and its unknown never holds the commit (critique MAJOR 4)",
    killed_by: [T_INSTANT],
  },
  {
    id: 'L10', file: LIB, tests: [T_ORCH],
    from: '  const at = new Map((Array.isArray(results) ? results : []).map((r) => [r?.run_id, instantOf(r?.completed_at)]));',
    to: "  const at = new Map((Array.isArray(results) ? results : []).map((r) => [r?.run_id, typeof r?.completed_at === 'string' ? r.completed_at : null]));",
    why: 'legacy times compare as strings: `…00Z` sorts after `…00.500Z`, and an unparseable time is ordered (critique MAJOR 4)',
    killed_by: [T_INSTANT],
  },
  {
    id: 'L11', file: LIB, tests: [T_ORCH],
    from: '  return doc.attempt_id === latest.id && doc.outcome === latest.outcome\n    && (doc.error_kind ?? null) === (latest.error_kind ?? null)\n    && (doc.reason ?? null) === (latest.reason ?? null);',
    to: '  return doc.attempt_id === latest.id;',
    why: 'an acceptance matches on the attempt id alone: accepted while open, it covers the failure its settle records later (critique MAJOR 1)',
    killed_by: [T_BOUND],
  },
  {
    id: 'L12', file: LIB, tests: [T_ORCH],
    from: '\n    && (doc.error_kind ?? null) === (latest.error_kind ?? null)\n',
    to: '\n',
    why: 'an acceptance covers another error kind of the outcome it names',
    killed_by: [T_BOUND],
  },
  {
    id: 'L13', file: LIB, tests: [T_ORCH],
    from: '\n    && (doc.reason ?? null) === (latest.reason ?? null);',
    to: ';',
    why: 'an acceptance covers another reason of the outcome it names',
    killed_by: [T_BOUND],
  },
  {
    id: 'L15', file: LIB, tests: [T_ORCH],
    from: '  return doc.attempt_id === latest.id && doc.outcome === latest.outcome\n',
    to: '  return doc.attempt_id === latest.id\n',
    why: 'an acceptance covers another outcome of the attempt it names, when error kind and reason agree',
    killed_by: [T_BOUND],
  },
  {
    id: 'L14', file: PERSONA_LIB, tests: [T_PERSONA],
    from: '  return doc.attempt_id === latest.id && doc.outcome === latest.outcome\n    && (doc.error_kind ?? null) === (latest.error_kind ?? null)\n    && (doc.reason ?? null) === (latest.reason ?? null);',
    to: '  return doc.attempt_id === latest.id;',
    why: "the persona's Phase 7 commits over a failure its owner accepted before the attempt had an outcome",
    killed_by: [T_P7_BOUND, T_STATE_OPEN],
  },
  {
    id: 'K1', file: LIB, tests: [T_ORCH],
    from: "  return line.outcome === 'skipped' && BLOCKING_SKIP_SET.has(line.reason ?? 'unspecified');",
    to: '  return false;',
    why: 'a review that never ran, with no reason given or an owner-skip no owner made, lets the commit (critique MAJOR 5)',
    killed_by: [T_SKIP],
  },
  {
    id: 'K2', file: LIB, tests: [T_ORCH],
    from: "  return line.outcome === 'skipped' && BLOCKING_SKIP_SET.has(line.reason ?? 'unspecified');",
    to: "  return line.outcome === 'skipped' && BLOCKING_SKIP_SET.has(line.reason);",
    why: 'a skipped outcome that names no reason at all lets the commit',
    killed_by: [T_SKIP],
  },
  {
    id: 'K3', file: PERSONA_LIB, tests: [T_PERSONA],
    from: "  return line.outcome === 'skipped' && BLOCKING_SKIP_SET.has(line.reason ?? 'unspecified');",
    to: '  return false;',
    why: "the persona's Phase 7 and review-gate let a review no one ran, with no reason given",
    killed_by: [T_P7_BOUND, T_STATE_SKIP],
  },
  {
    id: 'L5', file: LIB, tests: [T_ORCH],
    from: '      if (ran === null || legacy.at === null || ranAt === null || legacy.at >= ranAt) latest = outcomeLine(legacy.row, true);',
    to: '      if (ran === null) latest = outcomeLine(legacy.row, true);',
    why: "an older writer's review after the latest attempt is ignored: its unknown outcome never holds the commit",
    killed_by: [T_LEGACY_ORDER],
  },
  {
    id: 'L6', file: PERSONA_LIB, tests: [T_PERSONA],
    from: "export const REVIEW_BLOCKING_OUTCOMES = Object.freeze(['failed', 'degraded', 'unavailable', 'malformed', UNKNOWN_OUTCOME]);",
    to: "export const REVIEW_BLOCKING_OUTCOMES = Object.freeze(['failed', 'degraded', 'unavailable', 'malformed']);",
    why: "the persona's Phase 7 commits over a review record it cannot read",
    killed_by: [T_P7_UNKNOWN],
  },
  {
    id: 'L4', file: LIB, tests: [T_ORCH],
    from: "    held: blocking && acceptance.state !== 'matches',",
    to: '    held: blocking,',
    why: "the owner's acceptance is ignored: no way on but a new review, and a held lane can never commit",
    killed_by: [T_ACCEPT_LIB, T_RESOLUTION],
  },

  // ---- O: the autopilot policy and its reports ---------------------------------
  {
    id: 'O1', file: POLICY, tests: [T_ORCH],
    from: "    // and the owner's acceptance lets it).\n    if (held) return { kind: 'active', judgment: true, halt: held };\n",
    to: "    // and the owner's acceptance lets it).\n",
    why: 'a commit or done step over a failed review is dispatched',
    killed_by: [T_HALT, T_EACH, T_DONE_RECOVERY, T_RESOLUTION],
  },
  {
    id: 'O2', file: POLICY, tests: [T_ORCH],
    from: "      || (child.terminal_marker === true && COMMIT_SURFACE_PHASES.has(child.current_phase))) {\n      if (held) return { kind: 'active', judgment: true, halt: held };\n",
    to: "      || (child.terminal_marker === true && COMMIT_SURFACE_PHASES.has(child.current_phase))) {\n",
    why: 'the recovery of a commit begun is dispatched over a failed review',
    killed_by: [T_DONE_RECOVERY],
  },
  {
    id: 'O3', file: POLICY, tests: [T_ORCH],
    from: "      if (forced.kind === 'commit' && child?.review?.held) return nope(`subtask ${active[0].subtask.id}: ${reviewHeldText(child.review, child)}`);\n",
    to: '',
    why: "the owner's --next /engineer:commit steps around the review gate, which a judgment halt lets it replace",
    killed_by: [T_FORCED],
  },
  {
    id: 'O4', file: POLICY, tests: [T_ORCH],
    from: "        if (f.kind === 'commit' && view.children[id].review?.held) return nope(`subtask ${id}: ${reviewHeldText(view.children[id].review, view.children[id])}`);\n",
    to: '',
    why: '--lane <id> /engineer:commit steps around the review gate in a run with lanes',
    killed_by: [T_LANE_FORCED],
  },
  {
    id: 'O5', file: POLICY, tests: [T_ORCH],
    from: "  } else if (rv?.blocking === true || accepted !== null) {",
    to: '  } else if (false) {',
    why: "a lane parked on the review gate stays parked after the owner's acceptance, a re-acceptance or a new outcome",
    killed_by: [T_PARK],
  },
  {
    id: 'O6', file: POLICY, tests: [T_ORCH],
    from: "        ...(child.review ? { review: reviewRecord(child.review) } : {}),\n",
    to: '',
    why: 'the landing report and the awaiting-landing halt no longer name the review outcomes of what waits to land',
    killed_by: [T_WAITING],
  },
  {
    id: 'O7', file: LANDING, tests: [T_ORCH],
    from: ', r?.sync?.state ?? null, reviewKey(r?.review)]);',
    to: ', r?.sync?.state ?? null]);',
    why: 'a new review outcome at unchanged commits is deduplicated away: the landing log never reports it',
    killed_by: [T_DEDUP],
  },
  {
    id: 'O8', file: POLICY, tests: [T_ORCH],
    from: "    if (held) return { kind: 'active', judgment: true, halt: held };\n    // The commit gate, at the route every verb takes to the commit:",
    to: "    if (held) return { kind: 'halt', halt: held };\n    // The commit gate, at the route every verb takes to the commit:",
    why: "the review gate's halt stands whatever the owner's --next says: a new review (--next critique) cannot replace it",
    killed_by: [T_FORCED],
  },

  {
    id: 'O9', file: POLICY, tests: [T_ORCH],
    from: "    if (f?.kind === 'commit' && view.children?.[s.id]?.review?.held) {",
    to: '    if (false) {',
    why: 'a forced lane commit queued when the run began crosses a review failure recorded since',
    killed_by: [T_LANE_RECHECK],
  },
  {
    id: 'O10', file: OBSERVE, tests: [T_ORCH],
    from: "    if (REVIEW_KEYS.includes(u?.key) && fm[u.key] === undefined && typeof u.value === 'string') out = { ...out, [u.key]: u.value };",
    to: '    void u;',
    why: "an engineer older than the record hides it in its forward-compat carrier, and the gate reads no review: it fails open",
    killed_by: [T_CARRIER],
  },
  {
    id: 'O11', file: POLICY, tests: [T_ORCH],
    from: 'export const PARK_FINGERPRINT_VERSION = 4;',
    to: 'export const PARK_FINGERPRINT_VERSION = 3;',
    why: "a park an earlier release kept before the review facts is compared, reads `changed` once its child's outcome blocks, and resumes without the owner (critique MAJOR 2)",
    killed_by: [T_PARK_V],
  },
  {
    id: 'O12', file: POLICY, tests: [T_ORCH],
    from: "  const acceptedState = accepted !== null ? (rv?.acceptance?.state ?? null) : null;",
    to: '  const acceptedState = null;',
    why: "the owner's re-acceptance of the same attempt and tree, after it settled with another outcome, moves no fingerprint, so its parked lane stays parked",
    killed_by: [T_REACCEPT],
  },
  {
    id: 'O13', file: POLICY, tests: [T_ORCH],
    from: '--workflow-path ${pathWord(file)} --attempt-id ${id} --note-file <file>`',
    to: '--workflow-path ${file} --attempt-id ${id} --note-file <file>`',
    why: 'a path with a space or a quote enters the accept command unquoted: the owner runs it and the shell splits it (critique of 2026-11-07, MAJOR 4)',
    killed_by: [T_QUOTE],
  },
  {
    id: 'O14', file: POLICY, tests: [T_ORCH],
    from: "  const acceptable = id !== null && isReviewAttemptId(id);\n  const printable = typeof file === 'string' && file !== '' && !/[\\u0000-\\u001f\\u007f]/.test(file);",
    to: "  const acceptable = id !== null && isReviewAttemptId(id);\n  const printable = typeof file === 'string' && /^[A-Za-z0-9._/-]+$/.test(file);",
    why: 'a path with a space or a non-ASCII character drops the accept command, hiding the owner\'s only way on but a new review',
    killed_by: [T_QUOTE],
  },
  {
    id: 'O15', file: SCHEDULER, tests: [T_ORCH],
    from: '    Object.assign(lane(id), { halt: { reason: h.reason, detail: h.detail, ...(h.review ? { review: h.review } : {}) }, park: showPark({ ...rec, kept }) });',
    to: '    Object.assign(lane(id), { halt: { reason: h.reason, detail: h.detail }, park: showPark({ ...rec, kept }) });',
    why: "a lane parked in the run reports its halt with no review record (critique of 2026-11-07, MAJOR 5)",
    killed_by: [T_LANES_RUN],
  },
  {
    id: 'O16', file: SCHEDULER, tests: [T_ORCH],
    from: ', parked: true, release_only: p.release_only === true, ...(p.review ? { review: p.review } : {}) })),',
    to: ', parked: true, release_only: p.release_only === true })),',
    why: "the run's halt names only the first held lane's outcomes: the other lanes parked beside it lose theirs",
    killed_by: [T_LANES_RUN],
  },
  {
    id: 'O17', file: LANDING, tests: [T_ORCH],
    from: '    review: entry.review ?? null,',
    to: '    review: null,',
    why: 'the landing event drops the record, so the dedup key never sees a new outcome at unchanged commits (critique of 2026-11-07, MAJOR 6)',
    killed_by: [T_LANDING_EVENT],
  },
  {
    id: 'O18', file: SCHEDULER, tests: [T_ORCH],
    from: '    if (h.review) out(`  ${reviewOutcomesText(h.review)}`);\n    out(`  other lanes continue',
    to: '    out(`  other lanes continue',
    why: "a lane parked on the gate prints no line naming its review outcomes",
    killed_by: [T_LANES_RUN],
  },
  {
    id: 'O19', file: POLICY, tests: [T_ORCH],
    from: '  const reviewHeldAfter = reviewHaltAfterCommitStep(s, before, after, summary);\n  if (reviewHeldAfter) return reviewHeldAfter;\n',
    to: '',
    why: 'a commit Phase 7 refuses over a tree the acceptance does not cover halts owner-choice, with no attempt, no record and no way on (critique of 2026-11-07, third pass, MAJOR 1)',
    killed_by: [T_VERIFY, T_E2E_MOVED],
  },
  {
    id: 'O20', file: OBSERVE, tests: [T_ORCH],
    from: '  child.review = { ...r, held: true, change: { state: state.state, reason: state.reason ?? null } };\n',
    to: '',
    why: 'the observer reads no moved tree, so the gate lets the step and the refusal halts owner-choice: no new commit alone cannot say it was the review',
    killed_by: [T_E2E_MOVED, T_E2E_REACCEPT],
  },
  {
    id: 'O21', file: POLICY, tests: [T_ORCH],
    from: "  if (!after?.git?.head || after.git.head !== before?.git?.head) return null;\n  const h = reviewHalt(",
    to: '  const h = reviewHalt(',
    why: 'a commit that landed, the tree moved since, is reported as held',
    killed_by: [T_VERIFY_CONTROLS],
  },
  {
    id: 'O22', file: POLICY, tests: [T_ORCH],
    from: "if (child?.location !== 'active' || child.awaiting_owner?.gate || child.review?.held",
    to: "if (child?.location !== 'active' || child.review?.held",
    why: 'a commit step that records the staging-set gate over a held review halts on the review gate, and hides the gate the owner must answer',
    killed_by: [T_VERIFY_CONTROLS],
  },
  {
    id: 'O23', file: POLICY, tests: [T_ORCH],
    from: "held ? { subtaskId: held.subtaskId, pointer: held.pointer, review: held.review } : {});",
    to: '{});',
    why: "a worker reporting Phase 7's refusal as a failure halts with no record, against requirement (3)",
    killed_by: [T_FAILED_KEPT],
  },
  {
    id: 'O37', file: POLICY, tests: [T_ORCH],
    from: "    return halt('worker-failed', `the worker reports failure: ${summary}${held ? `; ${held.detail}` : ''}`,",
    to: "    if (held) return held;\n    return halt('worker-failed', `the worker reports failure: ${summary}`,",
    why: "a failed step over a held review stops being worker-failed, so the run no longer cancels the peers it left (refine-verify of 2026-11-07, B)",
    killed_by: [T_FAILED_KEPT],
  },
  {
    id: 'O38', file: POLICY, tests: [T_ORCH],
    from: "child.awaiting_owner?.gate || child.review?.held !== true) return null;",
    to: "child.awaiting_owner?.gate || child.review?.blocking !== true) return null;\n  if (child.review.held !== true) child.review.held = true;",
    why: 'no new commit over an accepted outcome is read as a review hold, whatever stopped the step: a refused subject or an unfinished recovery reads as the gate (refine-verify of 2026-11-07, A)',
    killed_by: [T_NOT_THE_GATE],
  },
  {
    id: 'O39', file: POLICY, tests: [T_ORCH],
    from: "    accepted: r.acceptance?.state === 'matches' && r.held !== true ? r.acceptance.attempt_id : null,",
    to: "    accepted: r.acceptance?.state === 'matches' ? r.acceptance.attempt_id : null,",
    why: 'the report names as accepted an outcome whose acceptance the tree has moved past',
    killed_by: [T_DECIDE_MOVED],
  },
  {
    id: 'O40', file: POLICY, tests: [T_ORCH],
    from: "  const why = r.change?.state === 'moved'\n    ? `the owner accepted ${id} for another working tree, so Phase 7 refuses the commit (exit 10)`\n    : r.change?.state === 'unreadable'",
    to: "  const why = r.change?.state === 'unreadable'",
    why: 'the halt over a moved tree says the owner has not accepted the attempt, which the owner just did',
    killed_by: [T_DECIDE_MOVED, T_E2E_MOVED],
  },
  {
    id: 'O41', file: OBSERVE, tests: [T_ORCH],
    from: "child.branch !== branch || r?.blocking !== true",
    to: "r?.blocking !== true",
    why: "a run with lanes asks the persona about a lane's child from the main checkout, which reads as another branch: an accepted lane parks unreadable, and the owner's acceptance never lets it commit",
    killed_by: [T_E2E_REACCEPT],
  },
  {
    id: 'O24', file: OBSERVE, tests: [T_ORCH],
    from: "      accepted_at: g.acceptance.doc?.accepted_at ?? null,\n",
    to: '',
    why: 'a re-acceptance of the first tree moves no fingerprint, so its kept park stays parked and the relaunch runs nothing (critique of 2026-11-07, third pass, MAJOR 2)',
    killed_by: [T_REACCEPT_SAME, T_E2E_REACCEPT],
  },
  {
    id: 'O25', file: POLICY, tests: [T_ORCH],
    from: "    tuple.push(['review', rv.latest?.id ?? null, rv.latest?.outcome ?? null, accepted, acceptedTree, acceptedState, acceptedAt]);",
    to: "    tuple.push(['review', rv.latest?.id ?? null, rv.latest?.outcome ?? null, accepted, acceptedTree, acceptedState]);",
    why: 'as O24, for the park fingerprint alone',
    killed_by: [T_REACCEPT_SAME],
  },
  {
    id: 'O26', file: POLICY, tests: [T_ORCH],
    from: "    if (accepted !== null) tuple.push(['review-acceptance', accepted, acceptedTree, acceptedState, acceptedAt]);",
    to: "    if (accepted !== null) tuple.push(['review-acceptance', accepted, acceptedTree, acceptedState]);",
    why: 'the fingerprint without peers misses a re-acceptance',
    killed_by: [T_REACCEPT_SAME],
  },
  {
    id: 'O27', file: POLICY, tests: [T_ORCH],
    from: '(relaunch with \\`--next /engineer:critique\\` or, in a run with lanes, \\`--lane ${lane} --next /engineer:critique\\`;',
    to: '(--next critique;',
    why: "the halt's first way on is one parseForcedStep refuses, and names no lane (critique of 2026-11-07, third pass, MAJOR 3)",
    killed_by: [T_PRINTED_NEXT, T_HALT],
  },
  {
    id: 'O28', file: POLICY, tests: [T_ORCH],
    from: "  if (repair) return `${held}${incomplete}; ${repair}, then relaunch`;\n",
    to: '',
    why: 'a record no new review can repair offers a new review, which records nothing, and the lane stays held',
    killed_by: [T_REPAIR],
  },
  {
    id: 'O29', file: POLICY, tests: [T_ORCH],
    from: '  const ways = r.latest?.open\n',
    to: '  const ways = false\n',
    why: 'an attempt still open offers the acceptance review-accept refuses',
    killed_by: [T_OPEN_WAY],
  },
  {
    id: 'O30', file: SCHEDULER, tests: [T_ORCH],
    from: '      : h.review ? reviewResolutionText(h.review, id)\n',
    to: '',
    why: 'a lane parked on the review gate is told to clear a gate that is never stored',
    killed_by: [T_E2E_KEPT],
  },
  {
    id: 'O42', file: POLICY, tests: [T_ORCH],
    from: "  if (repair) return `${repair}; the record read again picks the lane up`;\n",
    to: '',
    why: "a lane parked on a record no new review can repair is told to accept or review (refine-verify of 2026-11-07, C)",
    killed_by: [T_RESOLUTION_TEXT],
  },
  {
    id: 'O43', file: POLICY, tests: [T_ORCH],
    from: "  if (rec?.latest?.open) return `a new review outcome picks it up again;",
    to: "  if (false) return `a new review outcome picks it up again;",
    why: 'a lane parked on an attempt still open is told to accept it, which review-accept refuses (refine-verify of 2026-11-07, C)',
    killed_by: [T_RESOLUTION_TEXT],
  },
  {
    id: 'O31', file: SCHEDULER, tests: [T_ORCH],
    from: "      watch(id, fp.fresh ? before : null);\n      Object.assign(lane(id), { park: showPark(rec), halt: { reason: rec.reason, detail: rec.detail, ...(rec.review ? { review: rec.review } : {}) },",
    to: "      watch(id, fp.fresh ? before : null);\n      Object.assign(lane(id), { park: showPark(rec), halt: { reason: rec.reason, detail: rec.detail },",
    why: 'a park an earlier run kept reports no review record in its lane report',
    killed_by: [T_E2E_KEPT],
  },
  {
    id: 'O32', file: DRIVER, tests: [T_ORCH],
    from: "  if (d.review) out(`  ${reviewOutcomesText(d.review)}`);\n",
    to: '',
    why: "a serial run's halt prints no line naming the review outcomes",
    killed_by: [T_E2E_MOVED],
  },
  {
    id: 'O33', file: DRIVER, tests: [T_ORCH],
    from: "    if (w.review) out(`      ${reviewOutcomesText(w.review)}`);\n",
    to: '',
    why: 'the awaiting-landing halt prints no line naming the review outcomes of what waits to land',
    killed_by: [T_E2E_MOVED],
  },
  {
    id: 'O34', file: DRIVER, tests: [T_ORCH],
    from: "    ...(d.review ? { review: d.review } : {}),\n",
    to: '',
    why: "the run's halt record loses the review outcomes",
    killed_by: [T_E2E_MOVED, T_LANES_RUN],
  },
  {
    id: 'O35', file: ROOTS, tests: [T_ORCH],
    from: "    ['scripts/state.mjs', \"case 'review-accept'\", 'the review gate, with the owner\\'s review-accept and Phase 7\\'s refusal (C163 A1b)'],\n",
    to: '',
    why: 'the driver runs with an engineer that can neither record an acceptance nor refuse the commit itself',
    killed_by: [T_FLOOR],
  },
  {
    id: 'O36', file: POLICY, tests: [T_ORCH],
    from: "      || (child.terminal_marker === true && COMMIT_SURFACE_PHASES.has(child.current_phase))) {\n      if (held) return { kind: 'active', judgment: true, halt: held };\n",
    to: "      || (child.terminal_marker === true && COMMIT_SURFACE_PHASES.has(child.current_phase))) {\n      if (held) return { kind: 'halt', halt: held };\n",
    why: "the review gate's halt at a recovery stands whatever the owner's --next says: a new review cannot replace it",
    killed_by: [T_DONE_RECOVERY],
  },

  // ---- S: state.mjs review-gate and review-accept ------------------------------
  {
    id: 'S1', file: STATE, tests: [T_PERSONA],
    from: "    else if (checkout.tree !== gate.acceptance.doc.tree) change = { state: 'moved', tree: checkout.tree, accepted_tree: gate.acceptance.doc.tree };\n",
    to: '',
    why: 'an acceptance given for one change lets any later edit commit',
    killed_by: [T_STATE_MOVED, T_P7_MOVED],
  },
  {
    id: 'S2', file: STATE, tests: [T_PERSONA],
    from: '  if (isAutopilotRun(env)) {\n    throw new Error(`review-accept: refused under an autopilot run',
    to: '  if (false) {\n    throw new Error(`review-accept: refused under an autopilot run',
    why: 'an autopilot worker accepts the review outcome that holds its own commit back',
    killed_by: [T_STATE_REFUSED],
  },
  {
    id: 'S3', file: STATE, tests: [T_PERSONA],
    from: '    if (gate.latest.id !== attemptId) throw new Error(`review-accept: ${attemptId} is not the latest review attempt',
    to: '    if (false) throw new Error(`review-accept: ${attemptId} is not the latest review attempt',
    why: 'an earlier attempt is accepted, which then reads stale at once (or, written over the latest id, covers a review the owner never read)',
    killed_by: [T_STATE_REFUSED],
  },
  {
    id: 'S4', file: STATE, tests: [T_PERSONA],
    from: '    if (!gate.blocking) throw new Error(`review-accept: ${attemptId} is ${gate.latest.outcome}, which holds nothing back',
    to: '    if (false) throw new Error(`review-accept: ${attemptId} is ${gate.latest.outcome}, which holds nothing back',
    why: 'a usable review is accepted: an acceptance recorded where none is asked for',
    killed_by: [T_STATE_REFUSED],
  },
  {
    id: 'S5', file: STATE, tests: [T_PERSONA],
    from: "    if (listed?.state === 'open' || pending) {",
    to: '    if (false) {',
    why: 'an attempt with no outcome yet is accepted, so the acceptance stands for an outcome the owner never saw (critique MAJOR 1)',
    killed_by: [T_STATE_OPEN],
  },
  {
    id: 'S6', file: STATE, tests: [T_PERSONA],
    from: "    if (listed?.state === 'open' || pending) {",
    to: '    if (pending) {',
    why: "an open attempt an older writer settled (no pending run) is accepted before it has an outcome",
    killed_by: [T_STATE_SPLIT],
  },
  {
    id: 'S7', file: STATE, tests: [T_PERSONA],
    from: "    if (listed?.state === 'open' || pending) {",
    to: "    if (listed?.state === 'open') {",
    why: 'an attempt whose run is still pending is accepted',
    killed_by: [T_STATE_SPLIT],
  },
  {
    id: 'S8', file: STATE, tests: [T_PERSONA],
    from: '    if (back !== -1 && back < at) {',
    to: '    if (false) {',
    why: 'an attempt is superseded by one listed before it, a link the gate reads unknown at best (critique of 2026-11-07, MAJOR 2)',
    killed_by: [T_STATE_SUPERSEDE],
  },
  {
    id: 'S9', file: STATE, tests: [T_PERSONA],
    from: "gate.acceptance.state === 'matches' && change?.state === 'same';",
    to: "gate.acceptance.state === 'matches' && change?.state !== 'moved';",
    why: 'a working tree the gate cannot compare commits on an acceptance given for another (critique of 2026-11-07, third pass, MAJOR 4)',
    killed_by: [T_STATE_UNCOMPARED],
  },
  {
    id: 'S10', file: STATE, tests: [T_PERSONA],
    from: '  return { ...gate, change, held: gate.blocking && !accepted };',
    to: '  return { ...gate, change, held: gate.blocking };',
    why: "the owner's acceptance is ignored by the persona: no way on but a new review",
    killed_by: [T_STATE_ACCEPT],
  },
  {
    id: 'S11', file: STATE, tests: [T_PERSONA],
    from: "  if (repair) return `the latest review outcome holds the commit back: ${latestOutcomeText(check)}; ${repair}`;\n",
    to: '',
    why: "Phase 7's refusal offers a new review for a record no new review can repair (critique of 2026-11-07, third pass, MAJOR 3)",
    killed_by: [T_STATE_WAYS],
  },
  {
    id: 'S12', file: STATE, tests: [T_PERSONA],
    from: '  if (check.latest?.open || !id) {',
    to: '  if (!id) {',
    why: "Phase 7's refusal offers the acceptance review-accept refuses for an attempt still open",
    killed_by: [T_STATE_WAYS],
  },

  // ---- P: Phase 7 ------------------------------------------------------------------
  {
    id: 'P1', file: PHASE7, tests: [T_PERSONA],
    from: "  if (plan.branch !== 'no-changes') {\n    const refused = await heldReviewRefusal({ workflowPath, repoRoot, stderr, flags, paths: plan.staging_set });\n",
    to: "  if (false) {\n    const refused = await heldReviewRefusal({ workflowPath, repoRoot, stderr, flags, paths: plan.staging_set });\n",
    why: 'a held review records the staging-set gate instead of being refused: the owner is asked to confirm a set that cannot land',
    killed_by: [T_P7_STAGING],
  },
  {
    id: 'P2', file: PHASE7, tests: [T_PERSONA],
    from: '      const recovering = await reviewAdmission({ workflowPath, repoRoot, stderr, flags, paths: [], enforce: enforceSubjects });\n      if (recovering) return recovering;\n',
    to: '',
    why: 'the recovery of a commit begun finishes over a failed review',
    killed_by: [T_P7_RECOVERY],
  },
  {
    id: 'P4', file: PHASE7, tests: [T_PERSONA],
    from: '  const admitted = await reviewAdmission({\n    workflowPath, repoRoot, stderr, flags, paths: shape.commits.flatMap((c) => c.files), enforce: enforceSubjects,\n  });\n  if (admitted) return admitted;\n',
    to: '',
    why: 'the commit is judged only on the frontmatter read before planning: a failure recorded while the plan was made lands (critique of 2026-11-07, MAJOR 1)',
    killed_by: [T_P7_ADMISSION],
  },
  {
    id: 'K11', file: LIB, tests: [T_ORCH],
    from: "    if (pick !== null && pick.outcome === 'skipped') {\n",
    to: "    if (pick !== null && pick.outcome === 'skipped' && !reviewOutcomeBlocks(pick)) {\n",
    why: 'a skip that holds is read alone: accepting it clears the failure before it, which it does not name (critique of 2026-11-07, fourth pass, MAJOR 2)',
    killed_by: [T_SKIP_HOLDS],
  },
  {
    id: 'K12', file: LIB, tests: [T_ORCH],
    from: "    if (a.outcome === 'skipped') continue;\n",
    to: "    if (a.outcome === 'skipped' && !reviewOutcomeBlocks(a)) continue;\n",
    why: 'the lookback stops at a skip that holds in the middle of the list, which hides the failure before it (critique of 2026-11-07, fourth pass, MAJOR 2)',
    killed_by: [T_SKIP_HOLDS],
  },
  {
    id: 'K13', file: LIB, tests: [T_ORCH],
    from: "      else if (holdingSkip !== null && holdingSkip !== pick) pick = { ...holdingSkip, later_skip: pick.id };\n",
    to: '',
    why: 'a usable skip after a skip that holds clears it: the commit lands with no review and no acceptance',
    killed_by: [T_SKIP_HOLDS],
  },
  {
    id: 'K14', file: LIB, tests: [T_ORCH],
    from: 'for (let i = attempts.length - 1; i >= 0 && attempts[i].id !== ran?.id; i -= 1) {',
    to: 'for (let i = attempts.length - 1; i >= 0; i -= 1) {',
    why: 'a skip that holds before the review that ran is read as if it came after it: a passed review no longer answers it',
    killed_by: [T_SKIP_HOLDS],
  },
  {
    id: 'K15', file: PERSONA_LIB, tests: [T_PERSONA],
    from: "    if (pick !== null && pick.outcome === 'skipped') {\n",
    to: "    if (pick !== null && pick.outcome === 'skipped' && !reviewOutcomeBlocks(pick)) {\n",
    why: "the persona's Phase 7 names only the skip, not the failure behind it, and offers to accept the skip",
    killed_by: [T_P7_SKIP_HOLDS],
  },
  {
    id: 'L28', file: LIB, tests: [T_ORCH],
    from: "    let i = out.attempts.slice(0, -1).findIndex((a) => a.state === 'closed');\n",
    to: "    let i = out.attempts.findIndex((a) => a.state === 'closed');\n",
    why: 'the attempt just recorded goes when every older attempt is open, and the gate later reads the pass of an older one (critique of 2026-11-07, fourth pass, MAJOR 5)',
    killed_by: [T_COMPACT_LAST],
  },
  {
    id: 'P5', file: PHASE7, tests: [T_PERSONA],
    from: '    review_hold: reviewHold,\n',
    to: '    review_hold: null,\n',
    why: 'the interactive user decides with no word of the hold, which arrives once the commit has landed (critique of 2026-11-07, fourth pass, MAJOR 3)',
    killed_by: [T_PLAN_HOLD],
  },
  {
    id: 'P6', file: PHASE7, tests: [T_PERSONA],
    from: "  const reviewHold = landsNothing\n    ? null\n    : reviewHoldText(",
    to: '  const reviewHold = false\n    ? null\n    : reviewHoldText(',
    why: 'a close that lands nothing is presented as held, though execute lets it',
    killed_by: [T_PLAN_CLEAN],
  },
  {
    id: 'P8', file: PHASE7, tests: [T_PERSONA],
    from: "  const landsNothing = noChanges !== null && noChanges.path !== 'recovery';\n",
    to: '  const landsNothing = noChanges !== null;\n',
    why: 'the recovery of a commit begun lands commits, and the plan says nothing of the hold over them',
    killed_by: [T_P7_RECOVERY],
  },
  {
    id: 'P7', file: 'plugins/engineer/commands/commit.md', tests: [T_PERSONA],
    from: "When the plan's `review_hold` is set, a review outcome holds this commit back:\nshow the user that line before asking anything.",
    to: 'Present the plan.',
    why: 'the plan carries the hold, and the runbook never tells the agent to show it',
    killed_by: [T_PLAN_RELAY],
  },
  {
    id: 'P3', file: PHASE7, tests: [T_PERSONA],
    from: '    if (held) stderr.write(`⚠ review: ${held}. Interactively this is a warning; under autopilot the commit is refused.\\n`);',
    to: '    void held;',
    why: 'an interactive commit over a failed review says nothing',
    killed_by: [T_P7_WARN],
  },
];
