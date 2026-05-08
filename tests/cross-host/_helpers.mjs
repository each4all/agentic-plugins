// Shared helpers for tests/cross-host/*.mjs.
//
// Extracted to remove ~40 LOC of duplicated git-fixture setup across
// the three cross-host test files. The helpers are deliberately
// minimal — they handle hermetic tmp git repo creation + cleanup and
// the canonical MIN_BASELINE shape.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Hermetic tmp git repo — disables gpg signing, overrides committer
// identity via env so the user's global gitconfig cannot leak.
// Mirrors tests/engineer/test-stop-archive.mjs:192-214 precedent.
export async function withTmpGitRepo(prefix, fn) {
  const dir = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Test User',
    GIT_AUTHOR_EMAIL: 'test@test.local',
    GIT_COMMITTER_NAME: 'Test User',
    GIT_COMMITTER_EMAIL: 'test@test.local',
  };
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', dir], { stdio: 'ignore', env });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], {
      cwd: dir, stdio: 'ignore', env,
    });
    execFileSync('git', ['config', 'user.email', 'test@test.local'], {
      cwd: dir, stdio: 'ignore', env,
    });
    execFileSync('git', ['config', 'user.name', 'Test User'], {
      cwd: dir, stdio: 'ignore', env,
    });
    execFileSync(
      'git',
      ['commit', '--allow-empty', '-m', 'initial', '--no-gpg-sign'],
      { cwd: dir, stdio: 'ignore', env },
    );
    return await fn({ repoRoot: dir, env });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export const MIN_BASELINE = (branch = 'main') => ({
  branch,
  head: '0000000000000000000000000000000000000000',
  status_digest: '',
});

// Frontmatter keys that legitimately mutate when appendPhase runs.
// Used by both resume tests to whitelist expected differences.
export const APPEND_PHASE_MUTABLE_KEYS = new Set([
  'updated_at',
  'host_history',
  'current_phase',
  'next_action',
]);
