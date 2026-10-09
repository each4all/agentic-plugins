// The variables an agentic session exports for the code it runs (docket C88):
// the autopilot run marker, the plugin-root overrides, the linkage a parent
// workflow hands its child, and the companion nesting depth. The code under
// test reads them, in its own process and in every process it spawns, so a
// test run started from such a session tests the session instead of its
// fixtures: under an autopilot worker, 35 tests failed. The two test runners
// remove them: `npm test` (tests/_hermetic-env.mjs) and the mutation harness
// (`childEnv`). A test that needs one sets it itself.
//
// An opt-in switch a test reads on purpose (AGENTIC_EGRESS_REAL_SMOKE) is not
// session context, and stays.

export const SESSION_VARIABLES = Object.freeze([
  'AGENTIC_AUTOPILOT',
  'AGENTIC_HOST',
  'AGENTIC_PARENT_WORKFLOW',
  // ADR-0067 Decision 2 lists these by name: none ends in _ROOT, so the
  // plugin-root pattern below would not catch them.
  'AGENTIC_PARENT_WORKFLOW_PATH',
  // ADR-0067 Decision 4, item 5 — the dispatch selection, beside the ids.
  'AGENTIC_DISPATCH_SELECTION',
  'AGENTIC_STATE_BASE',
  'AGENTIC_AUTOPILOT_TOKEN',
  'AGENTIC_ORIGINATING_SUBTASK',
  'AGENTIC_PROFILE',
  'AGENTIC_DESIGNER_PROFILE',
  'AGENTIC_TOPIC',
  'AGENTIC_COMPANION_DEPTH',
  'AGENTIC_COMPANION_MAX_DEPTH',
]);

/**
 * AGENTIC_ENGINEER_ROOT, AGENTIC_RUNTIME_ROOT and every other plugin-root
 * override, a persona's included (AGENTIC_WEB_UX_ROOT for `web-ux`).
 */
const PLUGIN_ROOT = /^AGENTIC_[A-Z0-9_]+_ROOT$/;

export function isSessionVariable(name) {
  return SESSION_VARIABLES.includes(name) || PLUGIN_ROOT.test(name);
}
