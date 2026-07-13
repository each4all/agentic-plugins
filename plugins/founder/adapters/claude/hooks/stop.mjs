#!/usr/bin/env node
// plugins/founder/adapters/claude/hooks/stop.mjs
//
// Claude Code Stop hook for the founder plugin per ADR-0011 §4 +
// ADR-0017 §sub-decision 5. Two responsibilities:
//   1. Snapshot the active workflow's last_snapshot + host_history
//      (preserved from the original ADR-0011 §4 contract).
//   2. Evaluate the four hard auto-archive gates (terminal_marker,
//      terminal-phase whitelist, HEAD-moved, no active children) plus
//      the soft conventional-commit warning gate. On all gates pass,
//      atomically move the workflow into `archive/`.
//
// Hook absence is non-fatal (ADR-0011 §4 explicit). Every error path
// logs to stderr and returns exit 0 so the host's Stop lifecycle is
// never blocked.

import { findActiveWorkflow, readWorkflow } from '../../../scripts/state.mjs';
import { emitTerminalHandoffSidecar } from '../../../scripts/session-handoff.mjs';
import { runStopArchive, runStopArchiveOrphanSweep } from '../../../scripts/stop-archive.mjs';
import {
  gitHeadSha,
  gitHeadSubject,
  gitStatusDigest,
  gitTopLevel,
  readStdinJson,
} from './_shared.mjs';

async function main() {
  const payload = await readStdinJson();
  const cwd = payload.cwd || process.cwd();
  const repoRoot = gitTopLevel(cwd);
  if (!repoRoot) return 0;

  let active = null;
  try {
    active = await findActiveWorkflow(repoRoot);
  } catch {
    active = null;
  }
  if (active) {
    // ADR-0031 hook backstop (founder-hook-backstop, ADR-0043 S3) — if the
    // active workflow is terminal, (re)fire the activation sidecar BEFORE
    // archiving so the guaranteed-channel projection is written even when the
    // primary set-terminal sidecar's emit was missed or failed transiently.
    // Non-fatal; never blocks the Stop lifecycle. Not a substitute for the
    // primary firing. Scope honesty: the branch-agnostic orphan sweep below
    // archives deleted-branch terminals WITHOUT a final emit attempt (the
    // inherited engineer/orchestrator limitation, documented in
    // skills/_shared/references/session-handoff.md).
    try {
      const { frontmatter } = await readWorkflow(active);
      if (frontmatter?.terminal_marker === true) {
        // ADR-0039 — thread host so the backstop footer render localizes for
        // Claude; idempotency marker makes this a no-op if the primary rendered.
        await emitTerminalHandoffSidecar({ repoRoot, workflowPath: active, host: 'claude' });
      }
    } catch (err) {
      process.stderr.write(`founder/stop handoff-backstop: ${err.message}\n`);
    }
    try {
      await runStopArchive({
        workflowPath: active,
        host: 'claude',
        repoRoot,
        statusDigest: gitStatusDigest(repoRoot),
        headSha: gitHeadSha(repoRoot),
        headSubject: gitHeadSubject(repoRoot),
      });
    } catch (err) {
      process.stderr.write(`founder/stop: ${err.message}\n`);
    }
  }
  // ADR-0031 branch-agnostic orphan sweep — runs even when there is no
  // current-branch workflow, archiving terminal workflows whose baseline
  // branch was deleted (best-effort, non-fatal per ADR-0011 §4).
  try {
    await runStopArchiveOrphanSweep({ repoRoot, host: 'claude' });
  } catch (err) {
    process.stderr.write(`founder/stop orphan-sweep: ${err.message}\n`);
  }
  return 0;
}

const code = await main();
process.exit(code);
