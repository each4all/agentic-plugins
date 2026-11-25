// Mutation spec — does the scope readers' test catch the defects it exists
// for? (ADR-0023 §6, amendment of 2026-11-24, C181: who else ends a scope,
// and what is kept while one is not read gone)
//
// Run: npm run mutate -- scripts/mutation-specs/scope-readers.mjs
//
// WHY THIS NEEDS A SPEC AT ALL. The scope step of `cancel`, `settle`,
// `sweep` and the reclaim is fail-closed code: each of its refusals stands between a kill
// written outside the companion's group and a run whose runner may still own
// it, or a handle with no authority over the scope; and retention's hold
// keeps the only record a later reader can end a scope from. A refusal that
// stops refusing kills, or prunes, with no test going red unless a row shows
// the refusal. The edits go to the engineer's generated copy, which the test
// imports (every persona's copy is the same source); R14–R16, the kill
// authorization's, go to the source, which its test imports.

const T_READERS = 'tests/persona-pipeline/test-peer-runner-scope-readers.mjs';
// The kill authorization (authorizeKill), whose test imports the source.
const T_READER = 'tests/persona-pipeline/test-scope-reader.mjs';
const READER = 'persona-pipeline/files/scripts/lib/scope-reader.mjs';
const RUNNER = 'plugins/engineer/scripts/peer-runner.mjs';
const SNAPSHOT = 'plugins/engineer/scripts/lib/peer-snapshot.mjs';
// scopeBinding's refusal of an owner record of another persona or run.
const BINDING_PERSONA = '(owner.record.persona !== personaName() || owner.record.run_id !== handle.run_id)';
const BINDING_RUN_ONLY = '(owner.record.run_id !== handle.run_id)';

export const TESTS = [T_READERS, T_READER];

export const MUTATIONS = [
  {
    id: 'R1', file: RUNNER, tests: [T_READERS],
    from: "  if (supervisor?.gone !== true) return { report: { state: 'withheld', check: `supervisor-${supervisor?.check ?? 'unknown'}`, unit } };\n",
    to: '',
    why: 'a scope is killed while the supervisor its record names lives, or cannot be told',
    killed_by: /a supervisor not proven gone keeps the scope/,
  },
  {
    id: 'R2', file: RUNNER, tests: [T_READERS],
    from: "    return { report: { state: 'withheld', check: bind.reason, unit } };\n",
    to: '    return { identity, kill: true, unit };\n',
    why: 'a handle that binds nothing (an owner record that cannot be read, records that disagree) grants a kill',
    killed_by: /an owner record that cannot be read binds nothing/,
  },
  {
    id: 'R3', file: RUNNER, tests: [T_READERS],
    from: "    if (!Number.isFinite(refMs) || now.getTime() - refMs <= staleGraceMs) return { report: { state: 'withheld', check: 'not-stale', unit } };\n",
    to: '',
    why: 'the scope of a run neither terminal nor stale is killed under a runner that may still write',
    killed_by: /has not moved for less than the stale grace/,
  },
  {
    id: 'R4', file: RUNNER, tests: [T_READERS],
    from: "    if (bind.reason === 'owner-absent') return { identity, kill: false, unit, read_only: 'owner-absent' };\n",
    to: "    if (bind.reason === 'owner-absent') return { identity, kill: true, unit, read_only: 'owner-absent' };\n",
    why: 'a handle whose owner record is proven absent, which holds no authority, writes a kill',
    killed_by: /proven absent is read, never killed/,
  },
  {
    id: 'R5', file: RUNNER, tests: [T_READERS],
    from: "  return 'scope-not-gone';\n}\n",
    to: '  return null;\n}\n',
    why: 'retention prunes a terminal run whose scope is not read gone, erasing the record a later reader ends it from',
    killed_by: /retention keeps a terminal run whose scope is not read gone/,
  },
  {
    id: 'R6', file: RUNNER, tests: [T_READERS],
    from: "  if (state.state === 'unknown-version') return 'scope-unknown-version';\n",
    to: '',
    why: 'retention prunes a run whose scope is of a version this reader does not know',
    killed_by: /a scope of a version this reader does not know keeps its run/,
  },
  {
    id: 'R7', file: RUNNER, tests: [T_READERS],
    from: '  let current = handle;\n  if (reread !== null) {\n',
    to: '  let current = handle;\n  if (false) {\n',
    why: 'the kill rests on a handle read before the supervisor check, so a runner that moved meanwhile has its scope killed',
    killed_by: /moved during the supervisor check/,
  },
  {
    // The binding (scopeBinding) refuses the same owner record again, so the
    // kill alone cannot show this refusal; the row also asserts the reclaim
    // reports no teardown, the route it takes only without it. R13 holds the
    // binding's refusal, through cancel.
    id: 'R8', file: RUNNER, tests: [T_READERS],
    from: "owner.persona !== personaName() || !validRunId(owner.run_id)) return null;\n",
    to: '!validRunId(owner.run_id)) return null;\n',
    why: 'the reclaim kills the scope of another persona\'s snapshot, whose own readers own it',
    killed_by: /another persona's snapshot: no kill/,
  },
  {
    id: 'R9', file: RUNNER, tests: [T_READERS],
    from: " || rec.isolation !== 'snapshot' || !sameOwnerRecord(rec.owner_path, ownerPath)) return null;\n",
    to: " || rec.isolation !== 'snapshot') return null;\n",
    why: 'the reclaim kills through a handle whose snapshot is another owner record than the one it judges',
    killed_by: /names another owner record, one that binds: no kill/,
  },
  {
    id: 'R10', file: SNAPSHOT, tests: [T_READERS],
    from: '    : scopedRun && named !== null && named !== undefined;\n',
    to: '    : false;\n',
    why: 'a scoped run whose owner record names a companion its handle does not is judged on that companion, a record the runner did not write',
    killed_by: /naming no companion while the owner record names one/,
  },
  {
    id: 'R11', file: RUNNER, tests: [T_READERS],
    from: '  if (!ownerSupervisorAgrees(owner.supervisor, state.identity.supervisor)) return null;\n',
    to: '',
    why: 'the reclaim kills on the scope\'s supervisor proven gone while the snapshot\'s own recorded supervisor may live',
    killed_by: /whose supervisor is not its scope's/,
  },
  {
    id: 'R12', file: RUNNER, tests: [T_READERS],
    from: '        return again !== null && sameDirectory(again.paths.dir, target.paths.dir) ? again.handle : null;\n',
    to: '        return readHandle(target.paths.handle);\n',
    why: 'the reclaim\'s kill rests on a handle redirected to another owner record during the supervisor check',
    killed_by: /redirected to another owner record during the supervisor check/,
  },
  {
    id: 'R13', file: RUNNER, tests: [T_READERS],
    from: BINDING_PERSONA,
    to: BINDING_RUN_ONLY,
    why: 'a handle of this persona\'s run binds through another persona\'s owner record, whose scope that persona\'s readers own',
    killed_by: /names another persona's owner record binds nothing/,
  },
  {
    id: 'R14', file: READER, tests: [T_READER],
    from: "      if (listsAll && system.kill0(pid) === 'ESRCH') continue;\n",
    to: "      continue;\n",
    why: 'a member whose stat misses, though the pid answers a probe or /proc may hide it, is skipped and the kill written past it',
    killed_by: /a member whose start cannot be read grants nothing/,
  },
  {
    id: 'R15', file: READER, tests: [T_READER],
    from: "      if (listsAll && system.kill0(pid) === 'ESRCH') continue;\n",
    to: "      if (system.kill0(pid) === 'ESRCH') continue;\n",
    why: 'a probe of ESRCH is trusted under a /proc that may hide processes (hidepid)',
    killed_by: /a member whose start cannot be read grants nothing/,
  },
  {
    id: 'R16', file: READER, tests: [T_READER],
    from: "    if (!/^[1-9]\\d*$/.test(line.trim())) return fail('member-start');\n",
    to: "    if (!/^\\d+$/.test(line.trim())) return fail('member-start');\n",
    // On Linux signal 0 to pid 0 probes the caller's group, so the row holds
    // this by asserting 0 is refused before any lookup or probe.
    why: 'pid 0, a member in a pid namespace the reader does not see, passes and is skipped as gone',
    killed_by: /a member whose start cannot be read grants nothing/,
  },
];
