#!/usr/bin/env node
// plugins/orchestrator/adapters/codex/hooks/stop.mjs
//
// Codex-side Stop helper for the orchestrator plugin per ADR-0019 §5
// macro completion semantics (PR-E). Mirrors
// plugins/orchestrator/adapters/claude/hooks/stop.mjs functionally;
// the only divergence is that Codex CLI exposes host-level hooks but
// agentic-plugins has not verified plugin-local automatic hook packaging
// equivalent to Claude Code's plugin Stop binding, so this script is
// invoked manually as a final step in
// /orchestrator:finalize, /orchestrator:abort, /orchestrator:next, and
// /orchestrator:done runbooks under Codex.
//
// Equivalent behavior to the Claude adapter:
//
//   1. Iterate every non-archived macro under the selected canonical or
//      legacy orchestrator workflow home.
//   2. For each macro: snapshot last_snapshot/host_history + evaluate
//      A1–A4 gates + archive on pass.
//
// Manual invocation contract:
//
//   node "${CLAUDE_PLUGIN_ROOT}/adapters/codex/hooks/stop.mjs"
//
// (CLAUDE_PLUGIN_ROOT is the orchestrator plugin's resolved root in
// the Codex side; the env-var name is shared with Claude for symmetry.)
//
// Hook absence is non-fatal (ADR-0011 §4 explicit). This script
// silently no-ops on any error.

import { runMacroStopArchiveAll } from '../../../scripts/stop-archive.mjs';
import { gitHeadSubject, gitStatusDigest, gitTopLevel } from '../../claude/hooks/_shared.mjs';

async function main() {
  const repoRoot = gitTopLevel(process.cwd());
  if (!repoRoot) return 0;

  try {
    await runMacroStopArchiveAll({
      repoRoot,
      host: 'codex',
      statusDigest: gitStatusDigest(repoRoot),
      headSubject: gitHeadSubject(repoRoot),
      stderr: process.stderr,
    });
  } catch (err) {
    process.stderr.write(`orchestrator/codex-stop: ${err.message}\n`);
  }
  return 0;
}

const code = await main();
process.exit(code);
