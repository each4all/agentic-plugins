// Clears the operator's agentic session from a test process (docket C88;
// which variables, and why: scripts/lib/session-env.mjs).
//
// `npm test` loads this module first (`node --import`, which node --test also
// hands to the process it starts for each test file), so neither a test's own
// process nor any process it spawns inherits the session.

import { isSessionVariable } from '../scripts/lib/session-env.mjs';

for (const name of Object.keys(process.env)) {
  if (isSessionVariable(name)) delete process.env[name];
}
