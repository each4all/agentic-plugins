// Mutation spec — do the tests catch the defects the autopilot step's scope
// exists for? (ADR-0023, amendments of 2026-11-22 and 2026-11-24, C181: the
// autopilot worker, and what is kept while a scope is not read gone)
//
// Run: npm run mutate -- scripts/mutation-specs/step-scope.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. Each defect below either drops what a step's
// scope still holds (a lock entry taken for debris, a step's end that releases
// its locks and scratch, a dead run's record released) or writes a kill no
// record authorizes, and none of them makes anything fail on its own: the run
// goes on, a later run starts beside a mutation run that still holds the
// heavy-work lock, or a scope another run owns is ended. The rows pass their
// own ender, so no case needs a systemd user manager.

const SMALL = 'tests/orchestrator/test-autopilot-step-scope.mjs';
const DEAD = 'tests/orchestrator/test-autopilot-dead-runs.mjs';
const RL = 'plugins/orchestrator/scripts/lib/run-locks.mjs';
const SS = 'plugins/orchestrator/adapters/claude/autopilot/step-scope.mjs';
const DR = 'plugins/orchestrator/adapters/claude/autopilot/dead-runs.mjs';

export const TESTS = [SMALL, DEAD];

export const MUTATIONS = [
  {
    id: 'S1', file: RL, tests: [SMALL],
    from: "    if (hold !== null && hold.state !== 'gone') {\n",
    to: '    if (false) {\n',
    why: 'a dead driver\'s entry whose step scope is not read gone is taken for debris and removed, so a later run starts beside what the scope holds',
    killed_by: /a dead driver's entry held by its step's scope refuses/,
  },
  {
    id: 'S2', file: RL, tests: [SMALL],
    from: '  if (agrees) {\n    let sup;\n',
    to: '  if (true) {\n    let sup;\n',
    why: 'the lock gate kills a scope its entry does not bind, or whose step record disagrees: a kill no record authorizes',
    killed_by: /no kill where the driver is not proven gone, the step's record disagrees/,
  },
  {
    id: 'S3', file: SS, tests: [SMALL],
    from: "  return w.scopeTeardown !== null && typeof w.scopeTeardown === 'object' && w.scopeTeardown.state !== 'gone';\n",
    to: '  return false;\n',
    why: 'a step whose scope was not read gone releases its locks, open-run record and scratch as if nothing were left',
    killed_by: /a scope not read gone lingers as a group that outlived SIGKILL does/,
  },
  {
    id: 'S4', file: SS, tests: [SMALL],
    from: "      return { child: null, failure: 'scope_abandon_unwritten', identity: recordedIdentity };\n",
    to: '',
    why: 'a recorded identity whose abandoned mark could not be written is followed by a direct launch, leaving a record that names a scope the step never used',
    killed_by: /an abandoned mark that cannot be written launches nothing/,
  },
  {
    id: 'S5', file: DR, tests: [DEAD],
    from: "    const binds = id.owner.kind === 'autopilot-step' && id.owner.run === runId && id.owner.step === String(s.seq) && id.supervisor.pid === record.pid;\n",
    to: '    const binds = true;\n',
    why: 'the dead-run cleanup kills a step scope that names another driver or step',
    killed_by: /writes no kill for a scope that names another driver or step/,
  },
  {
    id: 'S6', file: DR, tests: [DEAD],
    from: "    if (reading?.state !== 'gone') held.push({ seq: o.seq, unit: o.id.unit, reading });\n",
    to: '',
    why: 'a dead run\'s step scope not read gone keeps nothing: the record, and with it the step\'s scratch, is released',
    killed_by: /keeps the record while it is not read gone/,
  },
];
