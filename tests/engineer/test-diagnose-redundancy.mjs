// plugins/engineer/scripts/state.mjs — diagnoseRedundancy subcommand
// tests (ADR-0020 §Sub-decision 7, PR 3).
//
// The helper runs in /engineer:start Phase 0 BEFORE a workflow is
// bootstrapped to detect overlap with recently-merged or in-flight
// changes on the current branch. Probes are reused from
// commands/resume.md:168-198 plus an optional `gh pr list` check.
//
// Status rule: redundancy iff (commits ahead of merge-base with
// --base-branch) OR (open PR on current branch). Conservative —
// caller (/engineer:start runbook) surfaces evidence and asks the
// user proceed/abort. The helper itself never auto-archives.

import { describe, it } from 'node:test';
import { strictEqual, ok, match } from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const STATE_PATH = resolve(REPO_ROOT, 'plugins/engineer/scripts/state.mjs');

const { diagnoseRedundancy } = await import(STATE_PATH);

function gitInit(dir, branch) {
  execFileSync('git', ['init', '-q', '-b', branch], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir, stdio: 'ignore' });
}

function gitCommit(dir, message, files = {}) {
  for (const [name, content] of Object.entries(files)) {
    execFileSync('sh', ['-c', `printf '%s' "${content}" > "${name}"`], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['add', name], { cwd: dir, stdio: 'ignore' });
  }
  execFileSync('git', ['commit', '-q', '--allow-empty', '-m', message], { cwd: dir, stdio: 'ignore' });
}

async function withTmpRepo(fn, { branch = 'main' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'engineer-diagnose-test-'));
  try {
    gitInit(dir, branch);
    // Initial commit so HEAD resolves.
    await writeFile(join(dir, 'README.md'), '# test\n');
    execFileSync('git', ['add', 'README.md'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: dir, stdio: 'ignore' });
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('state.mjs — diagnoseRedundancy (ADR-0020 §Sub-decision 7)', () => {
  it('returns status=no-redundancy on a clean branch with no commits ahead of base', async () => {
    await withTmpRepo(async (repoRoot) => {
      // No work since initial — base is HEAD, no commits ahead, no PRs.
      const result = await diagnoseRedundancy({ repoRoot, baseBranch: 'HEAD' });
      strictEqual(result.status, 'no-redundancy');
      strictEqual(result.evidence, null);
      strictEqual(result.recommended_action, null);
      ok(result.scanned, 'scanned must be populated');
      strictEqual(result.scanned.base_branch, 'HEAD');
    });
  });

  it('returns status=redundancy when commits exist ahead of base (evidence.kind=commit)', async () => {
    await withTmpRepo(async (repoRoot) => {
      // Tag the initial commit as the "base", then add a feature commit.
      execFileSync('git', ['tag', 'base'], { cwd: repoRoot, stdio: 'ignore' });
      gitCommit(repoRoot, 'feat: workflow_type field additive');
      const result = await diagnoseRedundancy({ repoRoot, baseBranch: 'base' });
      strictEqual(result.status, 'redundancy');
      ok(result.evidence, 'evidence must be populated when status=redundancy');
      strictEqual(result.evidence.kind, 'commit');
      ok(result.evidence.ref, 'evidence.ref (commit sha) must be populated');
      strictEqual(result.recommended_action, 'archive');
    });
  });

  it('scanned.commits_ahead distinguishes ok=true empty (no commits) from ok=false (probe failure)', async () => {
    await withTmpRepo(async (repoRoot) => {
      const result = await diagnoseRedundancy({ repoRoot, baseBranch: 'HEAD' });
      // baseBranch = HEAD → no commits ahead. Probe succeeds with empty stdout.
      ok(result.scanned.commits_ahead, 'commits_ahead probe must be present');
      strictEqual(result.scanned.commits_ahead.ok, true);
      strictEqual(result.scanned.commits_ahead.stdout.trim(), '');
    });
  });

  it('scanned includes working_tree_diff_stat / renames / deletes probes (Codex MINOR — full dirty-case surface)', async () => {
    await withTmpRepo(async (repoRoot) => {
      const result = await diagnoseRedundancy({ repoRoot, baseBranch: 'HEAD' });
      ok(result.scanned.working_tree_diff_stat, 'working_tree_diff_stat probe missing');
      ok(result.scanned.renames, 'renames probe missing');
      ok(result.scanned.deletes, 'deletes probe missing');
      // Each probe carries {ok, stdout}.
      for (const key of ['working_tree_diff_stat', 'renames', 'deletes']) {
        strictEqual(typeof result.scanned[key].ok, 'boolean', `${key}.ok must be boolean`);
        strictEqual(typeof result.scanned[key].stdout, 'string', `${key}.stdout must be string`);
      }
    });
  });

  it('scanned.open_prs is null when gh CLI is not available (graceful fallback)', async () => {
    await withTmpRepo(async (repoRoot) => {
      // Simulate gh absence by temporarily prepending an empty PATH segment.
      // The helper must catch ENOENT / EACCES and emit null, not throw.
      const origPath = process.env.PATH;
      process.env.PATH = '/dev/null/no-such-dir';
      try {
        const result = await diagnoseRedundancy({ repoRoot, baseBranch: 'HEAD' });
        strictEqual(result.scanned.open_prs, null);
      } finally {
        process.env.PATH = origPath;
      }
    });
  });

  it('CLI diagnose-redundancy --repo-root emits JSON on stdout', async () => {
    await withTmpRepo(async (repoRoot) => {
      const result = spawnSync(process.execPath, [
        STATE_PATH,
        'diagnose-redundancy',
        '--repo-root', repoRoot,
        '--base-branch', 'HEAD',
      ], { encoding: 'utf8' });
      strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      const parsed = JSON.parse(result.stdout);
      ok(['no-redundancy', 'redundancy'].includes(parsed.status), `unexpected status: ${parsed.status}`);
      ok(parsed.scanned, 'scanned missing in JSON output');
    });
  });

  it('CLI defaults --base-branch to origin/main when omitted (graceful when origin/main absent)', async () => {
    await withTmpRepo(async (repoRoot) => {
      const result = spawnSync(process.execPath, [
        STATE_PATH,
        'diagnose-redundancy',
        '--repo-root', repoRoot,
      ], { encoding: 'utf8' });
      // origin/main does not exist in a fresh local repo, so the probes
      // either fail gracefully (ok=false) or fall back. Either way the
      // helper MUST NOT throw — exit 0 with parseable JSON.
      strictEqual(result.status, 0, `expected exit 0, got ${result.status}: ${result.stderr}`);
      const parsed = JSON.parse(result.stdout);
      strictEqual(parsed.scanned.base_branch, 'origin/main');
      // base_head probably null when origin/main doesn't resolve.
      ok('base_head' in parsed.scanned, 'base_head field missing');
    });
  });

  it('CLI requires --repo-root flag', async () => {
    const result = spawnSync(process.execPath, [
      STATE_PATH,
      'diagnose-redundancy',
    ], { encoding: 'utf8' });
    // cliRequire throws inside the subcommand case → caught by the
    // outer try → exit 1 (parity with other subcommands' required-flag
    // handling, e.g., CLI create empty-parent-workflow test).
    strictEqual(result.status, 1);
    match(result.stderr, /Missing required flags: --repo-root/);
  });

  it('scanned.base_head is null when baseBranch does not resolve (graceful)', async () => {
    await withTmpRepo(async (repoRoot) => {
      const result = await diagnoseRedundancy({
        repoRoot,
        baseBranch: 'origin/never-existed',
      });
      strictEqual(result.scanned.base_head, null);
      // Helper does not throw; status falls back per heuristic.
      ok(['no-redundancy', 'redundancy'].includes(result.status));
    });
  });

  it('scanned.git_present + scanned.base_resolution_failed distinguish probe outcomes (Codex Phase 5 MAJOR)', async () => {
    // git-present (true) + base resolves → both flags reflect success.
    await withTmpRepo(async (repoRoot) => {
      const result = await diagnoseRedundancy({ repoRoot, baseBranch: 'HEAD' });
      strictEqual(result.scanned.git_present, true);
      strictEqual(result.scanned.base_resolution_failed, false);
    });
  });

  it('scanned.base_resolution_failed=true when baseBranch unreachable but git present', async () => {
    await withTmpRepo(async (repoRoot) => {
      const result = await diagnoseRedundancy({
        repoRoot,
        baseBranch: 'origin/never-existed',
      });
      strictEqual(result.scanned.git_present, true, 'git is on PATH in test env');
      strictEqual(result.scanned.base_resolution_failed, true);
    });
  });

  // Note: an explicit `git_present=false` test would require process-level
  // git removal that is not reliably reproducible across CI environments
  // (macOS in particular keeps an Xcode-developer-tools git stub
  // discoverable via fork+exec independent of PATH). The signal IS
  // emitted by `runGit`'s ENOENT catch in `state.mjs`; the
  // `git_present=true` + `base_resolution_failed=true` pair above
  // exercises the surrounding logic transparently.
});
