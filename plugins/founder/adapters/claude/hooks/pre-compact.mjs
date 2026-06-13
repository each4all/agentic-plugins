#!/usr/bin/env node
// plugins/founder/adapters/claude/hooks/pre-compact.mjs
//
// Claude Code PreCompact hook for the founder plugin per ADR-0011 §4.
// Updates the active workflow's last_snapshot + appends a host_history
// snapshot entry (event: snapshot, trigger: pre-compact). Hook absence
// is non-fatal — silently no-ops on any error rather than blocking
// compaction.

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
      trigger: 'pre-compact',
      statusDigest,
    });
  } catch (err) {
    process.stderr.write(`founder/pre-compact: ${err.message}\n`);
  }
  return 0;
}

const code = await main();
process.exit(code);
