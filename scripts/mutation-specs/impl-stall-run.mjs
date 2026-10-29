// Mutation spec — do the run's tests of the stall detector catch the defects
// ADR-0068 Decision 3 guards against, where a run records and acts on its
// verdicts?
//
// Run: npm run mutate -- scripts/mutation-specs/impl-stall-run.mjs
//
// The detector itself, its probe, the run's sampler and the worker's watch:
// impl-stall.mjs, whose header says why the detector needs a spec at all.
// Here: the policy's halt for a stalled abort, readRun keeping the stall lines
// out of a step's lifecycle, the event's fields, the driver's and the
// scheduler's records, and the CLI's mode and emergency cap.

const POL = 'plugins/orchestrator/adapters/claude/autopilot/policy.mjs';
const LED = 'plugins/orchestrator/adapters/claude/autopilot/ledger.mjs';
const EV = 'plugins/orchestrator/adapters/claude/autopilot/events.mjs';
const DRV = 'plugins/orchestrator/adapters/claude/autopilot/driver.mjs';
const SCH = 'plugins/orchestrator/adapters/claude/autopilot/scheduler.mjs';
const CLI = 'plugins/orchestrator/adapters/claude/autopilot/cli.mjs';

const TD = 'tests/orchestrator/test-autopilot-stall-driver.mjs';

export const TESTS = [TD];

export const MUTATIONS = [
  {
    id: 'D1', file: POL, tests: [TD],
    from: "  if (w.aborted === 'stalled') return halt('worker-failed', w.abortDetail ?? 'the step stalled and its process group was killed');\n",
    to: '',
    why: 'a stalled abort halts with the generic detail, naming neither the stall nor the wait',
    killed_by: [/a stalled abort halts worker-failed with its detail/, /a stalled step ends worker-failed, its detail naming the stall/],
  },
  {
    id: 'D2', file: LED, tests: [TD],
    from: '      stalls.get(rec.seq).push(rec);\n      continue;',
    to: '      stalls.get(rec.seq).push(rec);',
    why: 'readRun merges a stall line into its step',
    killed_by: /each verdict change is a stall line and an event/,
  },
  {
    id: 'D3', file: EV, tests: [TD],
    from: "const wholeMs = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : v);",
    to: 'const wholeMs = (v) => v;',
    why: 'an event keeps fractional milliseconds, which the allow-list refuses',
    killed_by: /a stall event's fields are whole milliseconds/,
  },
  {
    id: 'D4', file: DRV, tests: [TD],
    from: "  stallDetector: 'log',\n});",
    to: "  stallDetector: 'on',\n});",
    why: 'the detector is on by default',
    killed_by: /--stall-detector: log by default/,
  },
  {
    id: 'D5', file: CLI, tests: [TD],
    from: "  if (o.stallDetector === 'on' && !o.stepTimeoutExplicit) o.stepTimeoutSec = EMERGENCY_CAP_SEC;",
    to: "  if (o.stallDetector === 'on') o.stepTimeoutSec = EMERGENCY_CAP_SEC;",
    why: 'the emergency cap overrides an explicit --step-timeout',
    killed_by: /an explicit --step-timeout wins in either order/,
  },
  {
    id: 'D6', file: CLI, tests: [TD],
    from: "  if (o.stallDetector === 'on' && !o.stepTimeoutExplicit) o.stepTimeoutSec = EMERGENCY_CAP_SEC;\n",
    to: '',
    why: 'with the detector on, the step clock keeps its 3600 s default',
    killed_by: /on makes the default step clock the emergency cap/,
  },
  {
    id: 'D7', file: DRV, tests: [TD],
    from: "    publish('run-started', { lanes, detector: stallMode, run_dir: runDir, pointer: runFile });",
    to: "    publish('run-started', { lanes, detector: 'off', run_dir: runDir, pointer: runFile });",
    why: 'run-started does not name the run\'s detector mode',
    killed_by: /each verdict change is a stall line and an event/,
  },
  {
    id: 'D8', file: DRV, tests: [TD],
    from: '        stall: w.stall ?? null,\n        fingerprint_after: fingerprint(view)',
    to: '        fingerprint_after: fingerprint(view)',
    why: 'a serial step\'s finished line carries no summary',
    killed_by: /each verdict change is a stall line and an event/,
  },
  {
    id: 'D9', file: SCH, tests: [TD],
    from: '      stall: w.stall ?? null,\n      fingerprint_after: entry.lane',
    to: '      fingerprint_after: entry.lane',
    why: 'a lane step\'s finished line carries no summary',
    killed_by: /in a lane, a stalled step parks its lane/,
  },
  {
    id: 'D10', file: SCH, tests: [TD],
    from: '        ...(c.stallOf ? c.stallOf({ seq: mine, lane: inLane ? id : null, subtaskId: id }) : {}),\n',
    to: '',
    why: 'a run with lanes watches none of its steps',
    killed_by: [/in a lane, a stalled step parks its lane/, /a stalled done is the run's/],
  },
  {
    id: 'D11', file: DRV, tests: [TD],
    from: '        run.stall_record_failures = (run.stall_record_failures ?? 0) + 1;\n',
    to: '',
    why: 'a stall line that could not be appended is not counted',
    killed_by: /a stall line cut short and an event that cannot be written are counted/,
  },
  {
    id: 'D15', file: LED, tests: [TD],
    from: '      try { fs.ftruncateSync(fd, size); } catch { /* the reader passes a torn last line over */ }\n',
    to: '',
    why: 'a stall line cut short is left for the finished line to join',
    killed_by: [/appendStallLine takes back a write cut short/, /a stall line cut short and an event that cannot be written are counted/],
  },
  {
    id: 'D12', file: DRV, tests: [TD],
    from: "      try { publish('stall', stallEventFields(",
    to: "      try { void ('stall', stallEventFields(",
    why: 'a verdict change is never published',
    killed_by: /each verdict change is a stall line and an event/,
  },
  {
    id: 'D13', file: DRV, tests: [TD],
    from: '    stall: { mode: stallMode, sampler: sampler(),',
    to: "    stall: { mode: 'log', sampler: sampler(),",
    why: '--stall-detector on never reaches the worker',
    killed_by: /a stalled step ends worker-failed, its detail naming the stall/,
  },
  {
    id: 'D14', file: DRV, tests: [TD],
    from: '    try { stallSampler?.stop(); } catch { /* the sampler\'s */ }\n',
    to: '',
    why: 'the run\'s sampler outlives its run',
    killed_by: /each verdict change is a stall line and an event/,
  },
  {
    id: 'D16', file: DRV, tests: [TD],
    from: ', subtaskId, { lockWaitMs: STALL_LOCK_WAIT_MS }); } catch { /* counted by the writer */ }',
    to: ', subtaskId); } catch { /* counted by the writer */ }',
    why: 'a stall event waits on another writer\'s lock, holding every lane\'s stream and timers up to LOCK_WAIT_MS',
    killed_by: /a stall event waits on no other writer of the event file/,
  },
  {
    id: 'D17', file: EV, tests: [TD],
    from: '        release = lockEventFile(file, { waitMs });',
    to: '        release = lockEventFile(file, { waitMs: lockWaitMs });',
    why: 'a write\'s own lock wait is ignored, so a stall event waits the writer\'s bound',
    killed_by: /a stall event waits on no other writer of the event file/,
  },
];
