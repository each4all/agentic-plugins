#!/usr/bin/env node
// adapters/codex/hooks/pre-compact.mjs
//
// Codex plugin PreCompact hook for a persona plugin (one copy for every
// persona, generated from persona-pipeline/, ADR-0066). Mirrors the Claude
// adapter behavior but records host='codex' so cross-host continuity snapshots
// preserve where the lifecycle event ran. Best-effort and non-blocking.

import { findActiveWorkflow, snapshot } from '../../../scripts/state.mjs';
import { gitStatusDigest, gitTopLevel, hookPersona, readStdinJson } from '../../../scripts/lib/hook-helpers.mjs';

async function main() {
  // Validate the persona declaration first, before any other work: when it is
  // missing or broken the hook does nothing and exits 0 (ADR-0066 Decision 2;
  // hooks stay non-fatal, ADR-0011 §4).
  const persona = hookPersona();
  if (!persona) return 0;
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
    process.stderr.write(`${persona.name}/codex-pre-compact: ${err.message}\n`);
  }
  return 0;
}

const code = await main();
process.exit(code);
