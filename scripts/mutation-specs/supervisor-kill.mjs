// Mutation spec — do the tests catch the defects of docket C169: a check's
// supervisor that ends with no report and no record of how it ended, and a
// test that signals its own process group?
//
// Run: npm run mutate -- scripts/mutation-specs/supervisor-kill.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. The evidence a supervisor leaves changes no
// outcome, so losing it breaks nothing a green run shows; and the guard
// against a test's signal to its own group (tests/_signal-guard.mjs) acts only
// on a race no ordinary run makes on demand. Each case breaks one rule and
// names the test that must notice it.
//
// Groups: E the evidence of how the supervisor ended (heavy-run.mjs, the
// driver's journal in verify-run.mjs), kept apart from G the guard and its
// wiring into `npm test` (tests/_signal-guard.mjs, package.json) and T the
// heavy-lock tests' survivor tracker (tests/orchestrator/_heavy-lock-fixtures.mjs).
//
// SAFETY. A guard case lets a probe's SIGKILL to pid 0, -0 or its own group
// through: the probe runs in a group of its own, the heavy-work wrapper's,
// never this harness's; the guard's own refusal is asserted in a detached
// child, so a broken guard's SIGCONT reaches that child's group alone. No case
// lets a signal to pid -1 through: that one is proved on the guard's decision
// alone (G2).
//
// Not mutated, each with its reason: the call sites that now read a pid with
// readPid and publish it at once (test-heavy-lock-compat.mjs,
// test-heavy-lock-wrapper.mjs, test-autopilot-driver.mjs,
// test-autopilot-ledger.mjs): an empty read there is a race no test makes on
// demand, and G and T close the class; the driver's parse of a direct run's
// report through readSupervisorReport (verify-run.mjs): equivalent for every
// report a supervisor writes, whose report precedes its stop line; the
// evidence on a check the driver cut (timeout, bound, stop) and on a failed
// registration (heavy-run.mjs): a wrapper the driver's SIGKILL ends writes no
// ended line to read, so no test makes the record on demand.

const HR = 'plugins/orchestrator/scripts/lib/heavy-run.mjs';
const VRN = 'plugins/orchestrator/adapters/claude/autopilot/verify-run.mjs';
const GUARD = 'tests/_signal-guard.mjs';
const FIX = 'tests/orchestrator/_heavy-lock-fixtures.mjs';
const PKG = 'package.json';
const TW = 'tests/orchestrator/test-heavy-lock-wrapper.mjs';
const TVR = 'tests/orchestrator/test-autopilot-verify-run.mjs';
const TG = 'tests/test-signal-guard.mjs';

export const TESTS = [TW, TVR, TG];

const NORMAL = /a normal end keeps its report/;
const OUTSIDE = /a supervisor killed by a signal it did not send/;
const MALFORMED = /a supervisor that exits before its go, and one whose report is malformed/;
const NAMES = /the supervisor names its stop/;
const JOURNAL = /how a check's supervisor ended is the driver's record alone/;
const DECISION = /refuses any signal but 0 to pid 0, -0, -1 and the caller's own group/;
const THROWS = /throws before the system sees the signal, naming the guard/;
const THROUGH_NPM = /through npm test, each signal is refused/;
const TRACKER = /records no pid or group it may not signal/;

export const MUTATIONS = [
  // ---- E: how the supervisor ended ---------------------------------------------
  {
    id: 'E1', file: HR, tests: [TW],
    from: "const stop = (why) => { report({ stop: why }); try {",
    to: "const stop = (why) => { try {",
    why: 'the supervisor\'s own stop leaves no line: its own end and a signal from outside read the same',
    killed_by: [NORMAL, NAMES],
  },
  {
    id: 'E2', file: HR, tests: [TW, TVR],
    from: "const ended = (line) => status({ state: 'ended', ...line, supervisor: supEnd });",
    to: "const ended = (line) => status({ state: 'ended', ...line });",
    why: 'the status file\'s ended line drops how the supervisor ended (the record the batches lacked)',
    killed_by: [NORMAL, OUTSIDE, JOURNAL],
  },
  {
    id: 'E3', file: HR, tests: [TW],
    from: 'ended without reporting how the command ended (${supervisorEndText(supEnd)})`);',
    to: 'ended without reporting how the command ended`);',
    why: 'the check\'s log says only that no report came, not how the supervisor ended',
    killed_by: OUTSIDE,
  },
  {
    id: 'E4', file: HR, tests: [TW],
    from: 'if (isStop) { stop ??= v.stop; continue; }',
    to: 'if (isStop) { stop ??= v.stop; }',
    why: 'a stop line is taken for the report: a supervisor stopped before its go would read as reporting',
    killed_by: NAMES,
  },
  {
    id: 'E5', file: HR, tests: [TW],
    from: "  if (report === null && text !== '') end.report_head = text.slice(0, REPORT_HEAD);\n",
    to: '',
    why: 'a malformed report leaves no trace of what was written',
    killed_by: MALFORMED,
  },
  {
    id: 'E6', file: HR, tests: [TW],
    from: '  if (report === null) {\n    err(`heavy: the command\'s supervisor',
    to: '  if (report === null || supEnd.signal !== null) {\n    err(`heavy: the command\'s supervisor',
    why: 'a supervisor that reported, then ended by its own stop\'s SIGKILL, loses its report',
    killed_by: NORMAL,
  },
  {
    id: 'E8', file: HR, tests: [TW],
    from: "    : end.signal !== null ? 'no stop line received (most likely a signal it did not send)' : 'no stop line received';",
    to: "    : 'no stop line received (most likely a signal it did not send)';",
    why: 'the log blames a signal for a supervisor that exited by itself',
    killed_by: MALFORMED,
  },
  {
    id: 'E7', file: VRN, tests: [TVR],
    from: '{ batch_id: batchId, index: i, payload, ...(r.supervisor ? { supervisor: r.supervisor } : {}) }',
    to: '{ batch_id: batchId, index: i, payload }',
    why: 'the driver\'s journal drops how the check\'s supervisor ended',
    killed_by: JOURNAL,
  },
  // ---- G: the guard and its wiring ---------------------------------------------
  {
    id: 'G1', file: GUARD, tests: [TG],
    from: '  if (n === 0 || n === -1) return true;',
    to: '  if (n === -1) return true;',
    why: 'a signal to pid 0, the number an empty pid file reads as, reaches the runner\'s group',
    killed_by: [DECISION, THROWS, THROUGH_NPM],
  },
  {
    id: 'G2', file: GUARD, tests: [TG],
    from: '  if (n === 0 || n === -1) return true;',
    to: '  if (n === 0) return true;',
    why: 'a signal to pid -1, every process of the user, goes through',
    killed_by: DECISION,
  },
  {
    id: 'G3', file: GUARD, tests: [TG],
    from: '  return n < -1 && ownGroup !== null && -n === ownGroup;',
    to: '  return false;',
    why: 'a signal to the caller\'s own group by its number goes through',
    killed_by: [DECISION, THROUGH_NPM],
  },
  {
    id: 'G4', file: GUARD, tests: [TG],
    from: "  if (signal === 0 || signal === '0') return false;\n",
    to: '',
    why: 'the existence probe to pid 0 is refused too, breaking every liveness check',
    killed_by: [DECISION, THROWS],
  },
  {
    id: 'G5', file: PKG, tests: [TG],
    from: ' --import=./tests/_signal-guard.mjs"',
    to: '"',
    why: 'npm test loads no guard: a test\'s signal to its own group ends the check\'s supervisor again',
    killed_by: THROUGH_NPM,
  },
  {
    id: 'G6', file: GUARD, tests: [TG],
    from: "process.kill = function guardedKill(pid, signal = 'SIGTERM') {",
    to: "export const unused = function guardedKill(pid, signal = 'SIGTERM') {",
    why: 'the guard decides but is never installed',
    killed_by: [THROWS, THROUGH_NPM],
  },
  // ---- T: the survivor tracker -------------------------------------------------
  {
    id: 'T1', file: FIX, tests: [TG],
    from: 'const signalable = (n) => Number.isSafeInteger(n) && n > 1;',
    to: 'const signalable = (n) => Number.isInteger(n);',
    why: 'the tracker records 0, and its cleanUp kills the runner\'s own group',
    killed_by: TRACKER,
  },
  {
    id: 'T2', file: FIX, tests: [TG],
    from: ".filter((l) => /^[1-9][0-9]*$/.test(l)).map(Number).filter(signalable);",
    to: '.filter(Boolean).map(Number);',
    why: 'a pid file\'s 0, 1 or torn line is recorded and signalled',
    killed_by: TRACKER,
  },
];
