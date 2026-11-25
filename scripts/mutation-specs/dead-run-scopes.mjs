// Mutation spec — do the dead-run cleanup's tests catch the defects its scan
// of a dead step's scoped peers exists for? (ADR-0023, amendment of
// 2026-11-24, C181: peer runs of a dead step that hold scopes of their own)
//
// Run: npm run mutate -- scripts/mutation-specs/dead-run-scopes.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. Each defect below releases a dead run's
// open-run record, and with it the step's scratch, while a peer's scope may
// still hold processes: a scan that skips terminal handles, another persona's
// ledger or a lane's checkout; a release on a cancel that read no gone; a
// scope that names the run but no step of it, or no run at all, taken for
// one that keeps nothing. The cleanup still reports `cleaned`, so no test goes
// red unless a row shows it. The rows pass their own cancel and reading, so
// no case needs a systemd user manager.

const T = 'tests/orchestrator/test-autopilot-dead-runs.mjs';
const DR = 'plugins/orchestrator/adapters/claude/autopilot/dead-runs.mjs';

export const TESTS = [T];

export const MUTATIONS = [
  {
    id: 'D1', file: DR, tests: [T],
    from: "        } else if (reading !== null && reading.state !== 'gone') {\n",
    to: '        } else if (false) {\n',
    why: 'a cancel whose own reading of the scope is not gone (or that read none) releases the record',
    killed_by: /releases the record only on that cancel's reading of gone/,
  },
  {
    id: 'D2', file: DR, tests: [T],
    from: "      if (handle !== null && typeof handle === 'object') peers.push(",
    to: "      if (handle !== null && typeof handle === 'object' && PENDING.has(handle.status)) peers.push(",
    why: 'a terminal handle whose scope names the dead run is not scanned, so its scope is never ended or read',
    killed_by: /releases the record only on that cancel's reading of gone/,
  },
  {
    id: 'D3', file: DR, tests: [T],
    from: '    for (const { plugin, rel } of SHARED_HOMES) {\n',
    to: "    for (const { plugin, rel } of SHARED_HOMES.filter((h) => h.plugin === 'engineer')) {\n",
    why: 'only the engineer\'s ledger is scanned, so another persona\'s or the orchestrator\'s scoped peer is missed',
    killed_by: /finds a scoped peer in another persona's ledger/,
  },
  {
    id: 'D4', file: DR, tests: [T],
    from: '  const roots = [run?.state_root?.root, run?.state_root?.default_state_root, record.checkout, ...steps.map((s) => s?.cwd)]\n',
    to: '  const roots = [run?.state_root?.root, run?.state_root?.default_state_root, record.checkout]\n',
    why: 'a lane\'s own checkout, which the scheduler records as a step\'s cwd, is not scanned',
    killed_by: /finds a scoped peer in another persona's ledger/,
  },
  {
    id: 'D5', file: DR, tests: [T],
    from: '    return { ours: true, unit: state.identity.unit, identity: state.identity, step: STEP_SEQ.test(a.autopilot_step) && stepSeqs.has(Number(a.autopilot_step)) };\n',
    to: '    return { ours: true, unit: state.identity.unit, identity: state.identity, step: true };\n',
    why: 'a scope that names the run but no step of it is released as one of its steps\'',
    killed_by: /keeps the record for a scope that names the run but no step of it/,
  },
  {
    id: 'D6', file: DR, tests: [T],
    from: "        if (reading.state !== 'gone') {\n          keep(`its scope ${claim.unit} names no run",
    to: "        if (false) {\n          keep(`its scope ${claim.unit} names no run",
    why: 'a scope that names no run and is not read gone now (a stored gone included) keeps nothing',
    killed_by: /keeps the record for a scope that names the run but no step of it/,
  },
];
