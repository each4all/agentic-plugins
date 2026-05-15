#!/usr/bin/env node
// plugins/orchestrator/adapters/codex/hooks/pre-compact.mjs
//
// Codex plugin PreCompact hook for the orchestrator plugin. Mirrors the
// Claude adapter behavior but records host='codex'. Best-effort and
// non-blocking.

import { findActiveWorkflow, snapshot } from '../../../scripts/state.mjs';
import { gitStatusDigest, gitTopLevel, readStdinJson } from '../../claude/hooks/_shared.mjs';

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
      host: 'codex',
      trigger: 'pre-compact',
      statusDigest: gitStatusDigest(repoRoot),
    });
  } catch (err) {
    process.stderr.write(`orchestrator/codex-pre-compact: ${err.message}\n`);
  }
  return 0;
}

const code = await main();
process.exit(code);
