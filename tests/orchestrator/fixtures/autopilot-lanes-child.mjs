// A run with lanes in a process of its own, for a test that kills its driver
// (tests/orchestrator/test-autopilot-scheduler-lane-ends.mjs): the same start
// as autopilot-lanes-run.mjs's `run`, with the environment the test passes
// (the fake claude and the scripted worker), so a worker's "kill-driver"
// action SIGKILLs this process and nothing else.
//
//   node autopilot-lanes-child.mjs <repo> <macro id>

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../..');
const { startRun, DEFAULTS } = await import(resolve(REPO_ROOT, 'plugins/orchestrator/adapters/claude/autopilot/driver.mjs'));

const [repoRoot, macro] = process.argv.slice(2);
const code = await startRun({
  repoRoot,
  options: {
    ...DEFAULTS, models: 'owner-default', model: null, effort: null, macro, forced: null, forcedText: null,
    forcedPairs: null, notifyLocal: false, lanes: 2,
  },
  env: process.env, out: (s) => process.stdout.write(`${s}\n`), err: (s) => process.stderr.write(`${s}\n`),
});
process.exitCode = code;
