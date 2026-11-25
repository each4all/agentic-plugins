// Mutation spec — do the scoped run's tests catch the defects its launch and
// end exist for? (ADR-0023 §6, amendments of 2026-11-22 and 2026-11-24, C181:
// a launch that fails before the word, one end of a run)
//
// Run: npm run mutate -- scripts/mutation-specs/scope-run.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. The run's end decides what a scoped run's
// snapshot rests on: a teardown not read gone keeps the snapshot for good, so
// an end that never reads a scope its kill could not reach keeps every
// ordinary run's snapshot; a drain with no bound waits on a pipe a process
// outside the scope holds. A failed launch that does not mark its record
// abandoned, or launches although it could not, leaves a record no reader can
// tell from a launched one. Each defect leaves the run completed, with no test
// going red unless a row shows it. The edits go to the engineer's generated
// copy, which the runner the tests drive loads (the drift check, not run
// here, holds it to the source). Every case needs this machine's systemd user
// manager (the live rows skip without one, and the mutation then survives).

const T_RUN = 'tests/persona-pipeline/test-peer-runner-scope.mjs';
const RUN = 'plugins/engineer/scripts/lib/scope-run.mjs';

export const TESTS = [T_RUN];

export const MUTATIONS = [
  {
    id: 'E1', file: RUN, tests: [T_RUN],
    from: '    reading = ender.read(identity);\n',
    to: '    reading = { state: kill.state, ...(kill.check ? { check: kill.check } : {}) };\n',
    why: 'a kill the manager\'s check withholds (a scope already collected) becomes the teardown with no reading, so an ordinary run\'s scope is never read gone',
    killed_by: /leaves nothing behind reads gone/,
  },
  {
    id: 'E2', file: RUN, tests: [T_RUN],
    from: "        launch.failure = 'scope_abandon_unwritten';\n        return { launched: false };\n",
    to: "        return { launched: false, relaunch: () => directLaunch(command, args, options) };\n",
    why: 'a launch whose abandoned mark could not be written launches the companion anyway',
    killed_by: /launches nothing where the mark cannot be written/,
  },
  {
    id: 'E3', file: RUN, tests: [T_RUN],
    from: '        await plan.writeRecord(abandonedRecord(recordedIdentity));\n',
    to: '',
    why: 'a record that carries the identity is left unmarked before the direct launch',
    killed_by: /marks its record abandoned and launches directly/,
  },
  {
    id: 'E4', file: RUN, tests: [T_RUN],
    from: '  if (!drained) {\n',
    to: '  if (false) {\n',
    why: 'a pipe a process outside the scope holds is neither closed nor reported',
    killed_by: /keeps the pipe, which the end closes within its bound/,
  },
];
