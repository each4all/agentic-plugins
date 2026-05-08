#!/usr/bin/env node
// plugins/orchestrator/adapters/codex/hooks/stop.mjs
//
// Codex-side Stop helper for the orchestrator plugin (plan-only MVP).
//
// As of Codex CLI 0.128.0, **no plugin-local automatic hook packaging
// has been verified** for orchestrator's lifecycle events. Whether
// Codex CLI exposes a global hook surface that could fire this script
// at session-end is a separate user-environment concern; this helper
// is shipped as a script the user can invoke manually at the end of a
// Codex session, or that a future Codex hook surface can register if
// plugin-local hook packaging becomes available.
//
// Equivalent behavior to plugins/orchestrator/adapters/claude/hooks/
// stop.mjs: writes last_snapshot + host_history snapshot (trigger:
// stop). Auto-archive is **not** performed in this MVP — it ships in
// a follow-up PR alongside /orchestrator:done.
//
// Manual invocation contract:
//
//   node "${CLAUDE_PLUGIN_ROOT}/adapters/codex/hooks/stop.mjs"
//
// (CLAUDE_PLUGIN_ROOT is the orchestrator plugin's resolved root in the
// Codex side; the env-var name is shared with Claude for symmetry.)
//
// Hook absence is non-fatal (ADR-0011 §4 explicit). This script
// silently no-ops on any error.

import { findActiveWorkflow, snapshot } from '../../../scripts/state.mjs';
// Reuse the canonical git probes from the Claude adapter shared module
// (Phase 6 review SUGGESTION resolved — same helpers, single source of
// truth for both adapter sides).
import { gitTopLevel, gitStatusDigest } from '../../claude/hooks/_shared.mjs';

async function main() {
  const repoRoot = gitTopLevel(process.cwd());
  if (!repoRoot) return 0;

  let active;
  try {
    active = await findActiveWorkflow(repoRoot);
  } catch {
    return 0;
  }
  if (!active) return 0;

  try {
    await snapshot({
      workflowPath: active,
      host: 'codex',
      trigger: 'stop',
      statusDigest: gitStatusDigest(repoRoot),
    });
  } catch (err) {
    process.stderr.write(`orchestrator/codex-stop: ${err.message}\n`);
  }
  return 0;
}

const code = await main();
process.exit(code);
