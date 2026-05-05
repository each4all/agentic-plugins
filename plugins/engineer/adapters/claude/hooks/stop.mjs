#!/usr/bin/env node
// plugins/engineer/adapters/claude/hooks/stop.mjs
//
// Claude Code Stop hook for the engineer plugin per ADR-0011 §4.
// Updates the active workflow's last_snapshot + appends a host_history
// snapshot entry (event: snapshot, trigger: stop). Same shape as
// pre-compact.mjs; hook absence is non-fatal.

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

  const statusDigest = gitStatusDigest(repoRoot);
  try {
    await snapshot({
      workflowPath: active,
      host: 'claude',
      trigger: 'stop',
      statusDigest,
    });
  } catch (err) {
    process.stderr.write(`engineer/stop: ${err.message}\n`);
  }
  return 0;
}

const code = await main();
process.exit(code);
