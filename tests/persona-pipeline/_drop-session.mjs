// tests/persona-pipeline/_drop-session.mjs
//
// Imported first by a test file whose fixtures write workflows as the owner,
// on the default process.env: it drops every inherited AGENTIC_* variable at
// load, as those files drop GIT_*. `npm test` clears the session already
// (tests/_hermetic-env.mjs); a file run directly with `node --test` from an
// autopilot step does not, and its owner writes would then be written as the
// step's (AGENTIC_AUTOPILOT, AGENTIC_AUTOPILOT_STEP) or sent to its state base
// (AGENTIC_STATE_BASE). A test that needs one sets it itself.
//
// `runPlanted` is the check each such file makes: the file run again in a
// child with an autopilot session planted, only the tests `pattern` names. The
// control keeps the planted session (PLANTED_SESSION_CONTROL=1, a name the
// drop leaves), so it proves the planting reaches the probe and the probe can
// see it.

import { spawnSync } from 'node:child_process';

if (process.env.PLANTED_SESSION_CONTROL !== '1') {
  for (const k of Object.keys(process.env)) if (k.startsWith('AGENTIC_')) delete process.env[k];
}

export const PLANTED_SESSION = Object.freeze({
  AGENTIC_AUTOPILOT: 'autopilot-20261020T010203Z-abcdef',
  AGENTIC_AUTOPILOT_STEP: '9',
  AGENTIC_AUTOPILOT_VERIFY: 'f'.repeat(40),
  AGENTIC_STATE_BASE: '/planted/state-base',
});

/**
 * Run test `file` in a child under the planted session, only the tests whose
 * name matches `pattern`; `control` keeps the session in the child. A nested
 * node --test that inherits NODE_TEST_* reports to this runner instead of
 * exiting with its own status, so those are dropped. Returns the child's
 * status and its pass and fail counts.
 */
export function runPlanted(file, pattern, { control = false } = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('NODE_TEST_')) env[k] = v;
  Object.assign(env, PLANTED_SESSION);
  if (control) env.PLANTED_SESSION_CONTROL = '1';
  else delete env.PLANTED_SESSION_CONTROL;
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', `--test-name-pattern=${pattern}`, file], { env, encoding: 'utf8' });
  const count = (name) => Number(new RegExp(`^ℹ ${name} (\\d+)$`, 'm').exec(r.stdout)?.[1] ?? -1);
  return { status: r.status, pass: count('pass'), fail: count('fail'), out: `${r.stdout}\n${r.stderr}` };
}
