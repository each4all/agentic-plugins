// Mutation spec — do the lane tests keyed by a step's kind and subtask hold
// whatever order the scheduler admits the lanes' steps in? (C167)
//
// Run: npm run mutate -- scripts/mutation-specs/autopilot-lane-step-keys.mjs
//
// The scheduler numbers a step when it admits it, and a new lane waits for the
// throttle gate, so step 2 is lane B's dispatch only when B is admitted before
// A's first step ends. Scenarios that keyed B's actions by seq 2 then hung A's
// commit on A's own landing report, and the run ended another way (Macro 5
// and PR #1020's CI). They are keyed "dispatch:B" and "commit:A" now
// (fixtures/autopilot-scripted-worker.mjs), which no admission order moves.
//
// Groups: K a step key the worker no longer honors, which each re-keyed test
// must notice (the key is what orders the scenario); O the forced order (no
// rate limit known, so B cannot start beside A's first step) for the landing
// scenarios: the re-keyed tests pass under it (SURVIVED), and the same tests
// keyed by seq again fail under it (KILLED), so the forced order is the one
// that broke them; the events-lanes step failure, keyed "commit:A", likewise.
// The lane-gate wake scenarios have no O case: they need A's commit to run
// during B's dispatch, and a lane picked up again leaves the run's started
// lanes (scheduler.mjs), so with no rate limit known its next step waits as a
// new lane's would, and that setup fails whatever the keys. The product defects these tests catch
// stay in landing-ready.mjs (F34, F42, F43, F45, F46; F14 is retired there
// as an equivalent mutation) and autopilot-lane-gate.mjs (S84, S89).

const WORKER = 'tests/orchestrator/fixtures/autopilot-scripted-worker.mjs';
const TE = 'tests/orchestrator/test-autopilot-scheduler-landing-ends.mjs';
const TH = 'tests/orchestrator/test-autopilot-scheduler-landing-halts.mjs';
const TG = 'tests/orchestrator/test-autopilot-scheduler-lane-gate.mjs';
const TV = 'tests/orchestrator/test-autopilot-events-lanes.mjs';

export const TESTS = [TE, TH, TG, TV];

const T_DRAIN_FAILS = /a drain whose last look fails leaves no freshness standing/;
const T_END_LOOK = /the look a run's end takes for its proposals feeds its list/;
const T_IDLE_LANDED = /an awaiting-landing halt lists what the run's list holds as it ends/;
const T_IDLE_INTERRUPT = /an awaiting-landing halt the owner interrupts as the run ends confirms nothing it lists/;
const T_NO_REPORT_RESTORE = /the end's own look, which has no report, never restores a readiness/;
const T_DRAIN_MACRO = /a drain whose last look cannot read the macro keeps each waiting lane, unknown/;
const T_INTERRUPT_DRAIN = /an interrupt during the drain's last look ends the run interrupted, and confirms nothing/;
const T_SETTLE_INTERRUPT = /an interrupt while a step settles: the lane it committed is listed unknown/;
const T_END_LOOK_FAILS = /a failed look feeds the run's list too: when the end's own look fails/;
const T_STEP_FAILED = /a step that fails in a lane: its step-failed, then its lane's park at the same step/;
const T_GATE_BETWEEN = /a gate cleared between the decision's look and the park's own look/;
const T_GATE_JUDGING = /a gate cleared after the judging look read the lane/;

// The setups keyed "dispatch:B", as each file writes them.
const B_PLAIN = "scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT] }, actions: { 'dispatch:B'";
const B_FILE = "scenario: { A: { next: [COMMIT], file: true }, B: { next: [COMMIT], file: 'b.txt' }, actions: { 'dispatch:B'";
const forced = (from) => from.replace('scenario:', 'rateLimit: null, scenario:');

const forceLandingEnds = (copy, tools) => {
  tools.applyEdit(copy, { file: TE, from: B_PLAIN, to: forced(B_PLAIN), count: 3 });
  tools.applyEdit(copy, { file: TE, from: B_FILE, to: forced(B_FILE), count: 1 });
};
const V_SETUP = "scenario: { A: { next: [COMMIT], file: 'a.txt' }, B: { next: [COMMIT], file: 'b.txt' }, actions: { 'commit:A': 'report-failed' } }";
const forceStepFailed = (copy, tools) => {
  tools.applyEdit(copy, { file: TV, from: V_SETUP, to: forced(V_SETUP) });
};
const forceLandingHalts = (copy, tools) => {
  tools.applyEdit(copy, { file: TH, from: B_PLAIN, to: forced(B_PLAIN), count: 1 });
  tools.applyEdit(copy, { file: TH, from: B_FILE, to: forced(B_FILE), count: 1 });
};

export const MUTATIONS = [
  {
    id: 'K1', file: WORKER, tests: [TE, TH],
    from: '    if (dispatched) return `dispatch:${dispatched}`;',
    to: '    if (dispatched) return null;',
    why: "a dispatch's actions keyed by its subtask never apply: B's dispatch neither waits for A's report nor ends the way the scenario needs",
    killed_by: [T_DRAIN_FAILS, T_DRAIN_MACRO, T_INTERRUPT_DRAIN, T_SETTLE_INTERRUPT, T_END_LOOK, T_END_LOOK_FAILS, T_IDLE_LANDED, T_IDLE_INTERRUPT, T_NO_REPORT_RESTORE],
  },
  {
    id: 'K3', file: WORKER, tests: [TG],
    from: '    if (dispatched) return `dispatch:${dispatched}`;',
    to: '    if (dispatched) return null;',
    why: "A's dispatch keyed by its subtask never records its gate: A is never parked, and the wake the scenarios exist for never happens",
    killed_by: [T_GATE_BETWEEN, T_GATE_JUDGING],
  },
  {
    id: 'K2', file: WORKER, tests: [TG],
    from: "    return typeof subtask === 'string' && subtask ? `${kind}:${subtask}` : null;",
    to: '    return null;',
    why: "a commit's actions keyed by its lane's subtask never apply: A's resumed commit never marks its start, and B's dispatch waits out its bound",
    killed_by: [T_GATE_BETWEEN, T_GATE_JUDGING],
  },
  {
    id: 'O1', tests: [TE], expect: 'SURVIVED',
    prepare: forceLandingEnds,
    why: 'the control: B admitted only after A\'s first step ends, the re-keyed landing-ends scenarios still run as written',
  },
  {
    id: 'O2', tests: [TE],
    prepare: (copy, tools) => {
      forceLandingEnds(copy, tools);
      tools.applyEdit(copy, { file: TE, from: "actions: { 'dispatch:B': [", to: 'actions: { 2: [', count: 4 });
    },
    why: "the scenarios keyed by seq 2 again, under the forced order: A's commit takes seq 2 and waits on its own landing report (the Macro 5 and #1020 failure)",
    killed_by: [T_DRAIN_FAILS, T_END_LOOK],
  },
  {
    id: 'O3', tests: [TH], expect: 'SURVIVED',
    prepare: forceLandingHalts,
    why: "the control: B admitted only after A's first step ends, the re-keyed landing-halts scenarios still run as written",
  },
  {
    id: 'O4', tests: [TH],
    prepare: (copy, tools) => {
      forceLandingHalts(copy, tools);
      tools.applyEdit(copy, { file: TH, from: "actions: { 'dispatch:B': [", to: 'actions: { 2: [', count: 2 });
    },
    why: "the scenarios keyed by seq 2 again, under the forced order: A's commit takes seq 2 and waits on its own landing report (C165's step-number race)",
    killed_by: [T_IDLE_LANDED, T_NO_REPORT_RESTORE],
  },
  {
    id: 'K4', file: WORKER, tests: [TV],
    from: "    return typeof subtask === 'string' && subtask ? `${kind}:${subtask}` : null;",
    to: '    return null;',
    why: "a commit keyed by its lane's subtask never reports failure: no step fails, and no lane parks",
    killed_by: T_STEP_FAILED,
  },
  {
    id: 'O5', tests: [TV], expect: 'SURVIVED',
    prepare: forceStepFailed,
    why: "the control: B admitted only after A's first step ends, A's commit still fails and parks its lane",
  },
  {
    id: 'O6', tests: [TV],
    prepare: (copy, tools) => {
      forceStepFailed(copy, tools);
      tools.applyEdit(copy, { file: TV, from: "actions: { 'commit:A': 'report-failed' }", to: "actions: { 3: 'report-failed' }" });
    },
    why: "the step failure keyed by seq 3 again, under the forced order: seq 3 is B's dispatch, which ignores report-failed, and no step fails",
    killed_by: T_STEP_FAILED,
  },
];
