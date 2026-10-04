// lib/repo-root.mjs — find the repository root a runtime command acts on.
//
// Moved verbatim out of notify.mjs (ADR-0064 Decision 2, item 1): `context.mjs`,
// `retention.mjs` and `dashboard.mjs` use it and outlive the notify emitter.

import fs from 'node:fs';
import path from 'node:path';

// Explicit --repo-root wins; otherwise walk up from cwd to the nearest .git
// marker (dir or worktree file) with pure fs — no child process is spawned to
// find the state home.
export function resolveRepoRoot({ cwd = process.cwd(), explicit = null } = {}) {
  if (explicit) return path.resolve(explicit);
  let current = path.resolve(cwd);
  try {
    current = fs.realpathSync(current);
  } catch {
    return null;
  }
  for (;;) {
    if (fs.existsSync(path.join(current, '.git'))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
