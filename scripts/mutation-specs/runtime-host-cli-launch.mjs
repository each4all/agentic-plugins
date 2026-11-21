// Mutation spec — do the tests catch runtime starting claude/codex some way
// other than the launch it resolved and hashed? (C180, resolver-consumers)
//
// Run: npm run mutate -- scripts/mutation-specs/runtime-host-cli-launch.mjs
//
// H1-H2 are settings' plan-hash boundary (plugins/runtime/scripts/lib/
// plugin-management-plan.mjs): a launch the hash does not cover, or a plan of
// an unresolved CLI left planned. H3-H4 are doctor's runCommand: a launch it is
// handed and ignores, or a failed resolution that spawns anyway. H5 is the
// executor handing the runner no launch, H6 doctor dropping the reason that
// names the variable. Six cases, the most one `mutate` check names (AGENTS.md).

const T_PLAN = 'tests/runtime/test-plugin-management-plan.mjs';
const T_SETTINGS = 'tests/runtime/test-settings.mjs';
const T_LAUNCH = 'tests/runtime/test-host-cli-launch.mjs';
const T_DOCTOR = 'tests/runtime/test-doctor.mjs';

export const TESTS = [T_PLAN, T_SETTINGS, T_LAUNCH, T_DOCTOR];

export const MUTATIONS = [
  {
    id: 'H1', file: 'plugins/runtime/scripts/lib/plugin-management-plan.mjs', tests: [T_PLAN, T_SETTINGS],
    from: '  return plan.launch ? [plan.launch.command, ...plan.launch.args_prefix] : null;\n',
    to: '  return null;\n',
    why: 'the plan hash no longer covers the launch, so an override or shim target changed after the plan was presented executes unrefused',
    killed_by: [/a changed override or shim target changes the hash; the same launches do not/, /refuses an override changed since/],
  },
  {
    id: 'H2', file: 'plugins/runtime/scripts/lib/plugin-management-plan.mjs', tests: [T_PLAN],
    from: '  const unresolved = unresolvedLaunch(launches, recommendation.host);\n',
    to: '  const unresolved = null;\n',
    why: 'a plan of a host CLI that could not be resolved stays planned and executable',
    killed_by: /blocks the plans of a host CLI it could not resolve, with the reason naming the variable/,
  },
  {
    id: 'H3', file: 'plugins/runtime/scripts/doctor.mjs', tests: [T_LAUNCH],
    from: '    const resolved = launch ?? resolveHostLaunch(command, { env });\n',
    to: '    const resolved = resolveHostLaunch(command, { env });\n',
    why: 'runCommand resolves again instead of spawning the launch the plan hash covered',
    killed_by: /runCommand spawns the launch it is handed, prefix first, in place of the bare name/,
  },
  {
    id: 'H4', file: 'plugins/runtime/scripts/doctor.mjs', tests: [T_LAUNCH],
    from: '    if (resolved.ok === false) return unresolvedLaunchResult(resolved);\n',
    to: '    if (false) return unresolvedLaunchResult(resolved);\n',
    why: 'a failed resolution spawns anyway, and the reason naming the variable is lost to a spawn error',
    killed_by: /runCommand spawns nothing for a host CLI it cannot resolve, and says why/,
  },
  {
    id: 'H5', file: 'plugins/runtime/scripts/settings.mjs', tests: [T_SETTINGS],
    from: '  return plan?.launch ? { launch: plan.launch } : {};\n',
    to: '  return {};\n',
    why: 'the executor hands the runner no launch, so what runs is a fresh resolution, not the hashed launch',
    killed_by: /executes the launch the plan recorded, and refuses an override changed since/,
  },
  {
    id: 'H6', file: 'plugins/runtime/scripts/lib/machine-probe.mjs', tests: [T_DOCTOR],
    from: '    launch_failure: version.error_code === HOST_CLI_NOT_FOUND\n',
    to: '    launch_failure: false\n',
    why: 'doctor reports a bare "unavailable" and never names the variable to set',
    killed_by: /names the variable to set when a host CLI cannot be resolved/,
  },
];
