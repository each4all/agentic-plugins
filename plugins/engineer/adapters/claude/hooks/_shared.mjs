// plugins/engineer/adapters/claude/hooks/_shared.mjs
//
// Shared helpers for Claude Code hooks. Each hook reads stdin (JSON
// payload from Claude Code's hook contract), resolves the active
// workflow if any, and computes the git status digest. The actual
// state mutation is performed by the canonical state.mjs module
// (plugins/engineer/scripts/state.mjs).
//
// All operations are best-effort. Hook absence is non-fatal per
// ADR-0011 §4 — these hooks silently no-op on any failure rather
// than blocking the host's lifecycle event.

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';

export async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export function gitTopLevel(cwd) {
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

export function gitStatusDigest(repoRoot) {
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
