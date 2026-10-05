// scripts/lib/hook-helpers.mjs — the helpers both host adapters' hooks share
// (ADR-0066 D5): read the hook payload from stdin, find the repository, digest
// its status, read HEAD. One module under scripts/lib/, imported by the Claude
// and the Codex adapter alike, so neither adapter reaches into the other's tree.
// The state itself is written by scripts/state.mjs.
//
// Everything here is best-effort. A hook is non-fatal (ADR-0011 §4): it does
// nothing on any failure rather than block the host's lifecycle event.

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { CONVENTIONAL_COMMIT_RE } from '../validate-commit.mjs';
import { loadPersona } from './persona.mjs';

/**
 * Every hook calls this first, before any other work: the declaration, or null
 * when it is missing or broken — and then the hook exits 0 having done nothing
 * (ADR-0066 Decision 2).
 */
export function hookPersona() {
  try {
    return loadPersona();
  } catch {
    return null;
  }
}

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
    // drift-digest: --untracked-files=normal so untracked files are seen even under a
    // user's status.showUntrackedFiles=no (without it such a tree hashes/classifies as
    // CLEAN). `normal` — not `all` — is deliberate and measured: it overrides the config
    // exactly the same way, but keeps git's directory collapsing, so the output bytes are
    // IDENTICAL to the historical default-config behaviour (`?? sub/`). `all` would expand
    // each untracked dir into its files, changing every digest and dirty_count (measured:
    // an untracked dir of 3 files counts 1 under normal, 3 under all) and paying a full
    // recursive walk on huge untracked trees.
    // Pinning the mode also makes the digest MACHINE-INDEPENDENT: a user configured
    // `all` previously produced per-file entries, so the same tree digested
    // differently per machine. Dirty/clean is unaffected either way (both
    // non-empty); only listing granularity narrows for those users.
    const raw = execSync('git status --porcelain=v1 -z --untracked-files=normal', {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return createHash('sha256').update(raw).digest('hex');
  } catch {
    return '';
  }
}

export function gitHeadSha(repoRoot) {
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

export function gitHeadSubject(repoRoot) {
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

// ADR-0017 §sub-decision 5 conventional-commit warning gate. The regex itself
// is centralized in scripts/validate-commit.mjs (ADR-0028 §Centralization);
// this helper re-uses it so the Stop hook can warn on misconfigured terminal
// writes.
export function isConventionalCommitSubject(subject) {
  if (typeof subject !== 'string' || subject.length === 0) return false;
  return CONVENTIONAL_COMMIT_RE.test(subject);
}
