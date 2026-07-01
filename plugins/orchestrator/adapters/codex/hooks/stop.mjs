#!/usr/bin/env node
// plugins/orchestrator/adapters/codex/hooks/stop.mjs
//
// Codex-side Stop helper for the orchestrator plugin per ADR-0019 §5
// macro completion semantics (PR-E). Mirrors
// plugins/orchestrator/adapters/claude/hooks/stop.mjs functionally;
// the main divergence is that Codex bundled plugin hooks load only when the
// plugin is enabled with generic [features].hooks (default on) and pass host
// trust/review (stage-aware gate per ADR-0030), so this
// script remains the fallback final step in /orchestrator:finalize,
// /orchestrator:abort, /orchestrator:next, and /orchestrator:done runbooks
// under Codex.
//
// Equivalent behavior to the Claude adapter:
//
//   1. Iterate every non-archived macro under the selected canonical or
//      legacy orchestrator workflow home.
//   2. For each macro: snapshot last_snapshot/host_history + evaluate
//      A1–A4 gates + archive on pass.
//
// Fallback invocation contract:
//
//   node "${PLUGIN_ROOT}/adapters/codex/hooks/stop.mjs"
//
// (Codex plugin hooks also set CLAUDE_PLUGIN_ROOT for compatibility with
// existing plugin hooks, but PLUGIN_ROOT is the preferred Codex spelling.)
//
// Hook absence is non-fatal (ADR-0011 §4 explicit). This script
// silently no-ops on any error.

import { listAllMacros, readWorkflow } from '../../../scripts/state.mjs';
import { emitTerminalHandoffSidecar } from '../../../scripts/session-handoff.mjs';
import { runMacroStopArchiveAll } from '../../../scripts/stop-archive.mjs';
import { gitHeadSubject, gitStatusDigest, gitTopLevel } from '../../claude/hooks/_shared.mjs';

// ADR-0031 hook backstop (orchestrator-hook-backstop) — before the archive scan,
// (re)fire the activation sidecar for any TERMINAL macro so the guaranteed
// channel is populated even when the primary setMacroTerminal / updateSubtask
// emit was missed or failed transiently. Branch-agnostic; per-macro + whole-scan
// non-fatal so it never blocks the Stop lifecycle. Not a substitute for primary.
async function fireMacroHandoffBackstop(repoRoot) {
  try {
    const macros = await listAllMacros(repoRoot);
    for (const workflowPath of macros) {
      try {
        const { frontmatter } = await readWorkflow(workflowPath);
        if (frontmatter?.terminal_marker === true) {
          // ADR-0039 — thread host so the backstop footer render localizes for
          // Codex; idempotency marker makes this a no-op if the primary rendered.
          await emitTerminalHandoffSidecar({ repoRoot, workflowPath, host: 'codex' });
        }
      } catch {
        /* per-macro non-fatal — skip an unreadable macro */
      }
    }
  } catch (err) {
    process.stderr.write(`orchestrator/codex-stop handoff-backstop: ${err.message}\n`);
  }
}

async function main() {
  const repoRoot = gitTopLevel(process.cwd());
  if (!repoRoot) return 0;

  await fireMacroHandoffBackstop(repoRoot);

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
