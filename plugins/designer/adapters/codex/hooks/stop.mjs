#!/usr/bin/env node
// plugins/designer/adapters/codex/hooks/stop.mjs
//
// Codex-side Stop helper for the designer plugin per ADR-0011 §4 +
// ADR-0017 §sub-decision 5.
//
// Codex can run this plugin's bundled Stop hook when the plugin is enabled,
// generic [features].hooks (default on) is set, and the hook is trusted in
// /hooks (stage-aware gate per ADR-0030). This script also remains the manual
// fallback for Codex skill
// command-invoked mode, producing the same last_snapshot + host_history record
// that Claude's automatic Stop hook produces, AND triggering the same four-gate
// auto-archive evaluation when the workflow has crossed into a terminal state.
//
// SKILL.md's "When invoked by command" fallback mode SHOULD include a final
// step when plugin hooks are disabled, untrusted, or not active:
//
//   node "${PLUGIN_ROOT}/adapters/codex/hooks/stop.mjs"
//
// (Codex plugin hooks also set CLAUDE_PLUGIN_ROOT for compatibility with
// existing plugin hooks, but PLUGIN_ROOT is the preferred Codex spelling.)
//
// Hook absence is non-fatal (ADR-0011 §4 explicit). This script
// silently no-ops on any error.

import { findActiveWorkflow } from '../../../scripts/state.mjs';
import { runStopArchive, runStopArchiveOrphanSweep } from '../../../scripts/stop-archive.mjs';
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

  let active = null;
  try {
    active = await findActiveWorkflow(repoRoot);
  } catch {
    active = null;
  }
  if (active) {
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
      process.stderr.write(`designer/codex-stop: ${err.message}\n`);
    }
  }
  // ADR-0031 branch-agnostic orphan sweep — runs even when there is no
  // current-branch workflow, archiving terminal workflows whose baseline
  // branch was deleted (best-effort, non-fatal per ADR-0011 §4).
  try {
    await runStopArchiveOrphanSweep({ repoRoot, host: 'codex' });
  } catch (err) {
    process.stderr.write(`designer/codex-stop orphan-sweep: ${err.message}\n`);
  }
  return 0;
}

const code = await main();
process.exit(code);
