#!/usr/bin/env node
// plugins/orchestrator/adapters/claude/hooks/stop.mjs
//
// Claude Code Stop hook for the orchestrator plugin (plan-only MVP).
//
// **Snapshot-only**: this MVP writes a `last_snapshot` + `host_history`
// snapshot entry (event: snapshot, trigger: stop) and **does not**
// auto-archive. The auto-archive A1–A4 gate (terminal_marker +
// terminal-phase whitelist + HEAD-moved + no-active-children) ships in
// a follow-up PR alongside `/orchestrator:done` and the macro-phase
// terminal_marker mapping per ADR-0018 §sub-decision-1.
//
// Until then, manual archive is by file-move once the macro plan is
// complete (mirror of engineer's pre-ADR-0017 §sub-5 model).
//
// Hook absence is non-fatal (ADR-0011 §4 explicit). Every error path
// logs to stderr and returns exit 0 so the host's Stop lifecycle is
// never blocked.

import { findActiveWorkflow, snapshot } from '../../../scripts/state.mjs';
import { readStdinJson, gitTopLevel, gitStatusDigest } from './_shared.mjs';

async function main() {
  const payload = await readStdinJson();
  const cwd = payload.cwd || process.cwd();
  const repoRoot = gitTopLevel(cwd);
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
      host: 'claude',
      trigger: 'stop',
      statusDigest: gitStatusDigest(repoRoot),
    });
  } catch (err) {
    process.stderr.write(`orchestrator/stop: ${err.message}\n`);
  }
  return 0;
}

const code = await main();
process.exit(code);
