// `npm test` clears the operator's agentic session from every test process
// (tests/_hermetic-env.mjs over scripts/lib/session-env.mjs, docket C88).
// Proved end to end: every session
// variable is planted in the environment `npm test` starts from, and a probe
// run through the npm script must see none of them, in its own process or in
// one it spawns, while an opt-in switch survives. The control runs the same
// probe without the script and must fail on the planted names, so the
// planting is real and the probe can see a leak.

import { describe, it } from 'node:test';
import { match, strictEqual } from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SESSION_VARIABLES, isSessionVariable } from '../scripts/lib/session-env.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROBE = 'tests/fixtures/hermetic-env-probe.mjs';
const PLUGIN_ROOTS = ['ENGINEER', 'ORCHESTRATOR', 'RUNTIME', 'FOUNDER', 'DESIGNER', 'COMPANIONS', 'IMAGE']
  .map((p) => `AGENTIC_${p}_ROOT`);
const PLANTED = [...SESSION_VARIABLES, ...PLUGIN_ROOTS];

/**
 * The parent's environment with every session variable planted. A nested
 * node --test that inherits NODE_TEST_CONTEXT reports to this runner instead
 * of exiting with its own status, so the test runner's variables are dropped.
 */
function plantedEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('NODE_TEST_')) env[k] = v;
  for (const name of PLANTED) env[name] = name.endsWith('_ROOT') ? '/planted/root' : 'autopilot-20261007T000000Z-abcdef';
  env.HERMETIC_PROBE_PLANTED = JSON.stringify(PLANTED);
  env.AGENTIC_EGRESS_REAL_SMOKE = 'kept';
  return env;
}

describe('npm test runs every test file without the operator\'s agentic session (C88)', () => {
  it('each planted variable is one the scrub removes', () => {
    for (const name of PLANTED) strictEqual(isSessionVariable(name), true, name);
    strictEqual(isSessionVariable('AGENTIC_EGRESS_REAL_SMOKE'), false);
  });

  // Contract: the dispatch contract /orchestrator:next exports (ADR-0019 §1,
  // ADR-0067 Decision 3), named here rather than read from the list it checks:
  // under an autopilot worker these are set, and a test run that inherits them
  // links its fixtures' workflows to the worker's macro. The path ends in
  // _PATH, so only its name, not the _ROOT pattern, removes it (ADR-0067
  // Decision 2).
  it('the dispatch contract is scrubbed by name', () => {
    for (const name of ['AGENTIC_PARENT_WORKFLOW', 'AGENTIC_ORIGINATING_SUBTASK', 'AGENTIC_PARENT_WORKFLOW_PATH']) {
      strictEqual(SESSION_VARIABLES.includes(name), true, name);
    }
  });

  it('through the npm script, the probe and its child see none of them', () => {
    const r = spawnSync('npm', ['test', '--', PROBE], { cwd: REPO, env: plantedEnv(), encoding: 'utf8' });
    strictEqual(r.status, 0, `${r.stdout}\n${r.stderr}`);
    match(r.stdout, /^ℹ pass 3$/m);
  });

  it('control: without the script the planted variables reach the probe', () => {
    const r = spawnSync(process.execPath, ['--test', PROBE], { cwd: REPO, env: plantedEnv(), encoding: 'utf8' });
    strictEqual(r.status, 1, `${r.stdout}\n${r.stderr}`);
    match(r.stdout, /^ℹ fail 2$/m);
    match(r.stdout, /AGENTIC_AUTOPILOT/);
  });
});
