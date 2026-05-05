#!/usr/bin/env node
// plugins/engineer/adapters/claude/hooks/session-start.mjs
//
// Claude Code SessionStart hook (matcher: compact) for the engineer
// plugin per ADR-0011 §4. Reads the active workflow file and emits a
// one-line summary on stdout — Claude Code injects stdout into the
// new session's context after compaction. Read-only; never writes.
// Empty stdout when no active workflow exists or on any failure.

import { findActiveWorkflow, readWorkflow } from '../../../scripts/state.mjs';
import { readStdinJson, gitTopLevel } from './_shared.mjs';

const CONTROL_CHARS = /[\x00-\x1F\x7F]/g;

function sanitize(s) {
  if (s === undefined || s === null) return '';
  return String(s).replace(CONTROL_CHARS, ' ').trim();
}

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

  let frontmatter;
  try {
    ({ frontmatter } = await readWorkflow(active));
  } catch {
    return 0;
  }

  const verb = sanitize(frontmatter.verb);
  const profile = sanitize(frontmatter.profile);
  const phase = sanitize(frontmatter.current_phase);
  const next = sanitize(frontmatter.next_action);
  const id = sanitize(frontmatter.workflow_id);

  const profileSuffix = profile ? `:${profile}` : '';
  process.stdout.write(
    `engineer active: /${verb}${profileSuffix} (phase=${phase}; next=${next}) [${id}]\n`,
  );
  return 0;
}

const code = await main();
process.exit(code);
