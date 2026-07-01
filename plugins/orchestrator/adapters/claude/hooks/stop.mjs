#!/usr/bin/env node
// plugins/orchestrator/adapters/claude/hooks/stop.mjs
//
// Claude Code Stop hook for the orchestrator plugin per ADR-0019 §5
// macro completion semantics (PR-E).
//
// Two responsibilities, both performed for every non-archived macro
// under the selected canonical or legacy orchestrator workflow home:
//
//   1. Snapshot — write `last_snapshot` + `host_history` snapshot
//      entry (trigger: stop). This preserves the original ADR-0011 §4
//      contract for every macro.
//   2. Macro auto-archive — evaluate the four hard gates
//      (terminal_marker / macro terminal_phase / all_subtasks_terminal
//      / no_active_engineer_children) and atomically move the workflow
//      file into `archive/` on pass.
//
// Branch-agnostic discovery (ADR-0019 §5): the macro plan spans the
// parent branch + N subtask branches. The Stop event that finalizes
// the last subtask fires on a subtask branch where the engineer-style
// branch-keyed `findActiveWorkflow` lookup would miss the parent
// macro. So we iterate every macro under `workflows/` regardless of
// the current git branch.
//
// Hook absence is non-fatal (ADR-0011 §4 explicit). Every error path
// logs to stderr and returns exit 0 so the host's Stop lifecycle is
// never blocked.

import { listAllMacros, readWorkflow } from '../../../scripts/state.mjs';
import { emitTerminalHandoffSidecar } from '../../../scripts/session-handoff.mjs';
import { runMacroStopArchiveAll } from '../../../scripts/stop-archive.mjs';
import {
  gitHeadSubject,
  gitStatusDigest,
  gitTopLevel,
  readStdinJson,
} from './_shared.mjs';

// ADR-0031 hook backstop (orchestrator-hook-backstop) — before the archive scan,
// (re)fire the activation sidecar for any TERMINAL macro so the guaranteed
// channel is populated even when the primary setMacroTerminal / updateSubtask
// emit was missed or failed transiently. Branch-agnostic (the macro spans
// branches, like runMacroStopArchiveAll); per-macro + whole-scan non-fatal so it
// never blocks the Stop lifecycle. Not a substitute for the primary firing.
async function fireMacroHandoffBackstop(repoRoot) {
  try {
    const macros = await listAllMacros(repoRoot);
    for (const workflowPath of macros) {
      try {
        const { frontmatter } = await readWorkflow(workflowPath);
        if (frontmatter?.terminal_marker === true) {
          // ADR-0039 — thread host so the backstop footer render localizes for
          // Claude; idempotency marker makes this a no-op if the primary rendered.
          await emitTerminalHandoffSidecar({ repoRoot, workflowPath, host: 'claude' });
        }
      } catch {
        /* per-macro non-fatal — skip an unreadable macro */
      }
    }
  } catch (err) {
    process.stderr.write(`orchestrator/stop handoff-backstop: ${err.message}\n`);
  }
}

async function main() {
  const payload = await readStdinJson();
  const cwd = payload.cwd || process.cwd();
  const repoRoot = gitTopLevel(cwd);
  if (!repoRoot) return 0;

  await fireMacroHandoffBackstop(repoRoot);

  try {
    await runMacroStopArchiveAll({
      repoRoot,
      host: 'claude',
      statusDigest: gitStatusDigest(repoRoot),
      headSubject: gitHeadSubject(repoRoot),
      stderr: process.stderr,
    });
  } catch (err) {
    process.stderr.write(`orchestrator/stop: ${err.message}\n`);
  }
  return 0;
}

const code = await main();
process.exit(code);
