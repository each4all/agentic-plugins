// Mutation spec — do the scoped launch's tests catch the defects it exists
// for? (ADR-0023 §6, amendments of 2026-11-22 and 2026-11-24, C181: launched
// through a gate, closed to entry, a launcher inside another's scope)
//
// Run: npm run mutate -- scripts/mutation-specs/scope-launch.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. The launch is fail-closed code: each of its
// refusals keeps a kill from reaching a process nobody put in the run on
// purpose (a scope that held something other than the gate, a scope left open
// to entry), or keeps a launcher from making a scope beside the one that
// encloses it, outside that scope's kill. A refusal that stops refusing
// launches anyway with no test going red unless a row shows the refusal. The
// edits go to the persona-pipeline source, which the tests import. L3 and L6
// need this machine's systemd user manager (the live rows skip without one,
// and the mutation then survives).

const T_LAUNCH = 'tests/persona-pipeline/test-scope-launch.mjs';
const T_READER = 'tests/persona-pipeline/test-scope-reader.mjs';
const LAUNCH = 'persona-pipeline/files/scripts/lib/scope-launch.mjs';
const READER = 'persona-pipeline/files/scripts/lib/scope-reader.mjs';

export const TESTS = [T_LAUNCH, T_READER];

export const MUTATIONS = [
  {
    id: 'L1', file: READER, tests: [T_READER],
    from: "    if (members.length !== 1 || members[0].trim() !== String(gatePid)) return withheld('gate-placement');\n",
    to: "    if (members.length === 0) return withheld('gate-placement');\n",
    why: 'a scope holding a process besides the gate, or not the gate at all, is taken as the run\'s new scope',
    killed_by: /refuses a scope holding another member/,
  },
  {
    id: 'L2', file: READER, tests: [T_READER],
    from: "      system.fchmod(dir.fd, system.fstat(dir.fd).mode & 0o7555);\n",
    to: '',
    why: 'the scope\'s directory keeps its write permission, so a member makes a cgroup below it',
    killed_by: /closes the scope to entry/,
  },
  {
    id: 'L3', file: LAUNCH, tests: [T_LAUNCH],
    from: '  const closed = closeNewScope(reader, { path, cgroupId: scope.cgroupId });\n',
    to: '  const closed = { ok: true };\n',
    why: 'the word is given with the scope still open to entry',
    killed_by: /records the identity before the word, closes the scope/,
  },
  {
    id: 'L4', file: LAUNCH, tests: [T_LAUNCH],
    from: '  if (!underManager && noUnit) return { inside: false };\n',
    to: '  if (!underManager) return { inside: false };\n',
    why: 'a launcher outside the user manager is read as in no launcher\'s scope whatever the manager answered',
    killed_by: /a session path with any other failure of the manager withholds|a session path with the manager naming a unit withholds/,
  },
  {
    id: 'L5', file: LAUNCH, tests: [T_LAUNCH],
    from: '  if (underManager && unit !== null && parts.indexOf(unit, managerAt + 1) > managerAt) {\n',
    to: '  if (underManager && unit !== null) {\n',
    why: 'the launcher\'s placement is judged on the manager\'s unit alone, its own path reading aside',
    killed_by: /a launcher scope the manager does not name withholds|holds no component of the path withholds|named only above the manager/,
  },
  {
    id: 'L6', file: LAUNCH, tests: [T_LAUNCH],
    from: '  recorded = true;\n',
    to: '',
    why: 'a record that failed part way is reported unwritten, so the caller launches directly without marking it abandoned',
    killed_by: /a record that fails before the word runs nothing and says it was called/,
  },
];
