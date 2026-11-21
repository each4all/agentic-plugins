// Mutation spec — do the tests catch the autopilot starting Claude Code some
// way other than the one launch its preflight resolved and probed? (C180,
// resolver-autopilot)
//
// Run: npm run mutate -- scripts/mutation-specs/autopilot-claude-launch.mjs
//
// A1 is the driver handing its workers no launch (each resolves again), A2 a
// worker ignoring the launch it is handed. A3 drops the re-check before the
// spawn, so a target gone since the preflight is spawned anyway; A4 is the
// re-check judging every launch runnable. A5 lets AUTOPILOT_CLAUDE_BIN lose
// its precedence over CLAUDE_BIN, A6 lets the preflight spawn a CLI it could
// not resolve. Six cases, the most one `mutate` check names (AGENTS.md).

const T_LAUNCH = 'tests/orchestrator/test-autopilot-claude-launch.mjs';
const T_DRIVER = 'tests/orchestrator/test-autopilot-claude-launch-driver.mjs';

export const TESTS = [T_LAUNCH, T_DRIVER];

const AP = 'plugins/orchestrator/adapters/claude/autopilot';

export const MUTATIONS = [
  {
    id: 'A1', file: `${AP}/driver.mjs`, tests: [T_DRIVER],
    from: '  const startWorker = (o) => startWorkerSeam({ claudeLaunch: pre.claudeLaunch ?? null, ...o });\n',
    to: '  const startWorker = (o) => startWorkerSeam({ ...o });\n',
    why: 'each worker resolves Claude Code again instead of spawning the launch the preflight checked',
    killed_by: /each step spawns the launch the preflight resolved and probed/,
  },
  {
    id: 'A2', file: `${AP}/worker.mjs`, tests: [T_LAUNCH, T_DRIVER],
    from: '  const launch = o.claudeLaunch ?? resolveClaudeLaunch(env);\n',
    to: '  const launch = resolveClaudeLaunch(env);\n',
    why: 'the worker spawns a fresh resolution, not the launch the run handed it',
    killed_by: /startWorker spawns nothing for it and reports a spawn error carrying the reason/,
  },
  {
    id: 'A3', file: `${AP}/worker.mjs`, tests: [T_LAUNCH, T_DRIVER],
    from: '  const unrunnable = launch.ok ? launchGone(launch) : launch.reason;\n',
    to: '  const unrunnable = launch.ok ? null : launch.reason;\n',
    why: 'a launch target gone since the preflight is spawned anyway, and the step ends on a bare spawn error or a node module error',
    killed_by: [/startWorker spawns nothing for it and reports a spawn error carrying the reason/, /a launch target removed after the preflight fails the step with that reason/],
  },
  {
    id: 'A4', file: `${AP}/worker.mjs`, tests: [T_LAUNCH],
    from: "  if (launch.source === 'bare') return null;\n",
    to: '  return null;\n',
    why: 'the re-check judges every launch runnable, so a missing target is never named',
    killed_by: /launchGone names the missing file and the variable/,
  },
  {
    id: 'A5', file: `${AP}/worker.mjs`, tests: [T_LAUNCH],
    from: '  const lookup = viaOwn ? { ...withoutShared(), CLAUDE_BIN: own }\n',
    to: '  const lookup = false ? { ...withoutShared(), CLAUDE_BIN: own }\n',
    why: 'AUTOPILOT_CLAUDE_BIN no longer stands in for CLAUDE_BIN, so CLAUDE_BIN or the bare name wins',
    killed_by: [/takes CLAUDE_BIN, and AUTOPILOT_CLAUDE_BIN before it/, /an AUTOPILOT_CLAUDE_BIN that names nothing is an error naming it/],
  },
  {
    id: 'A6', file: `${AP}/driver.mjs`, tests: [T_LAUNCH],
    from: "  if (!launch.ok) return { problems: [`the Claude Code CLI cannot be started: ${launch.reason}`], claude: null, launch: null };\n",
    to: '',
    why: 'the preflight spawns a CLI it could not resolve, losing the reason that names the variable',
    killed_by: /a CLI that cannot be resolved refuses the start naming the variable, and starts nothing/,
  },
];
