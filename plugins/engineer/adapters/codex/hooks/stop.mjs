#!/usr/bin/env node
// plugins/engineer/adapters/codex/hooks/stop.mjs
//
// Codex-side Stop helper for the engineer plugin per ADR-0011 §4 +
// ADR-0017 §sub-decision 5.
//
// Codex CLI does not expose a hook system equivalent to Claude Code's
// PreCompact / Stop / SessionStart events (as of Codex CLI 0.128.0).
// This script is therefore intended to be invoked **manually** at the
// end of a Codex skill's command-invoked mode — i.e., the Codex SKILL
// agent calls this script as its final step before returning, which
// produces the same last_snapshot + host_history record that Claude's
// automatic Stop hook produces, AND triggers the same four-gate
// auto-archive evaluation when the workflow has crossed into a
// terminal state.
//
// SKILL.md's "When invoked by command" mode SHOULD include a final
// step:
//
//   node "${CLAUDE_PLUGIN_ROOT}/adapters/codex/hooks/stop.mjs"
//
// (CLAUDE_PLUGIN_ROOT here is the engineer plugin's resolved root
// in the Codex side; the env-var name is shared with Claude for
// symmetry but is set by the Codex skill agent's environment, not
// Claude Code.)
//
// Hook absence is non-fatal (ADR-0011 §4 explicit). This script
// silently no-ops on any error.

import { findActiveWorkflow } from '../../../scripts/state.mjs';
import { runStopArchive } from '../../../scripts/stop-archive.mjs';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';

function gitTopLevel(cwd) {
  try {
    const out = execSync('git rev-parse --show-toplevel', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.toString().trim();
  } catch {
    return null;
  }
}

function gitStatusDigest(repoRoot) {
  try {
    const raw = execSync('git status --porcelain=v1 -z', {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return createHash('sha256').update(raw).digest('hex');
  } catch {
    return '';
  }
}

function gitHeadSha(repoRoot) {
  try {
    const out = execSync('git rev-parse HEAD', {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.toString().trim() || null;
  } catch {
    return null;
  }
}

function gitHeadSubject(repoRoot) {
  try {
    const out = execSync('git log -1 --pretty=%s', {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.toString().trim() || null;
  } catch {
    return null;
  }
}

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
    await runStopArchive({
      workflowPath: active,
      host: 'codex',
      repoRoot,
      statusDigest: gitStatusDigest(repoRoot),
      headSha: gitHeadSha(repoRoot),
      headSubject: gitHeadSubject(repoRoot),
    });
  } catch (err) {
    process.stderr.write(`engineer/codex-stop: ${err.message}\n`);
  }
  return 0;
}

const code = await main();
process.exit(code);
