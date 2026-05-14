import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  formatText,
  parseArgs,
  runWorktree,
} from '../../plugins/runtime/scripts/worktree.mjs';

describe('runtime worktree', () => {
  it('plans a dedicated worktree from a clean default branch without mutating git state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-worktree-main-'));
    const report = await runWorktree({
      repoRoot: root,
      task: 'Large runtime slice',
      format: 'json',
      runner: fakeGitRunner({
        root,
        branch: 'main',
        dirtyLines: [],
        branchExists: false,
      }),
      now: new Date('2026-05-14T00:00:00.000Z'),
    });

    strictEqual(report.schema_version, 'runtime-worktree-plan-1.0');
    strictEqual(report.dry_run, true);
    strictEqual(report.request.branch, 'feat/large-runtime-slice');
    strictEqual(report.git.current.branch, 'main');
    strictEqual(report.git.current.dirty, false);
    strictEqual(report.recommendation.should_use_worktree, true);
    strictEqual(report.recommendation.blocked, false);
    strictEqual(report.recommendation.commands[0].label, 'create_worktree');
    strictEqual(report.recommendation.commands[0].execute, false);
    deepStrictEqual(report.recommendation.commands[0].argv.slice(0, 4), ['git', 'worktree', 'add', '-b']);
    ok(formatText(report).includes('suggested commands (not executed)'));
  });

  it('warns on dirty current checkout and still produces a read-only plan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-worktree-dirty-'));
    const report = await runWorktree({
      repoRoot: root,
      task: 'Follow-up PR',
      runner: fakeGitRunner({
        root,
        branch: 'feat/current-work',
        dirtyLines: [' M plugins/runtime/scripts/worktree.mjs', '?? scratch.txt'],
        branchExists: false,
      }),
    });

    strictEqual(report.git.current.dirty, true);
    strictEqual(report.git.current.dirty_count, 2);
    strictEqual(report.overall.should_use_worktree, true);
    ok(report.criteria.some((criterion) => criterion.name === 'current_worktree_clean' && criterion.status === 'warn'));
    ok(report.recommendation.reason.includes('dedicated worktree'));
  });

  it('recommends a dedicated worktree from a detached checkout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-worktree-detached-'));
    const report = await runWorktree({
      repoRoot: root,
      task: 'Detached follow-up',
      runner: fakeGitRunner({
        root,
        branch: 'HEAD',
        dirtyLines: [],
        branchExists: false,
      }),
    });

    strictEqual(report.git.current.branch, null);
    strictEqual(report.git.current.detached, true);
    strictEqual(report.overall.should_use_worktree, true);
    ok(report.criteria.some((criterion) => criterion.name === 'current_branch' && criterion.status === 'warn'));
  });

  it('blocks when the planned branch already exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-worktree-branch-exists-'));
    const report = await runWorktree({
      repoRoot: root,
      task: 'Existing branch',
      branch: 'feat/existing-branch',
      runner: fakeGitRunner({
        root,
        branch: 'main',
        dirtyLines: [],
        branchExists: true,
      }),
    });

    strictEqual(report.overall.status, 'blocked');
    strictEqual(report.recommendation.blocked, true);
    strictEqual(report.recommendation.commands.length, 0);
    ok(report.criteria.some((criterion) => criterion.name === 'branch_available' && criterion.status === 'fail'));
  });

  it('reports non-git directories as blocked without suggesting mutation commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-worktree-nongit-'));
    const report = await runWorktree({
      repoRoot: root,
      runner: fakeGitRunner({
        root,
        notGit: true,
      }),
    });

    strictEqual(report.git.status, 'not_git_repo');
    strictEqual(report.overall.status, 'blocked');
    strictEqual(report.recommendation.commands.length, 0);
  });

  it('parses CLI arguments and rejects unsafe branch names', () => {
    const opts = parseArgs([
      'plan',
      '--repo-root',
      '/tmp/repo',
      '--task',
      'Runtime worktree',
      '--branch',
      'feat/runtime-worktree',
      '--base',
      'origin/main',
      '--worktree-dir',
      '/tmp/repo-worktree',
      '--format',
      'json',
    ]);

    strictEqual(opts.command, 'plan');
    strictEqual(opts.repoRoot, '/tmp/repo');
    strictEqual(opts.task, 'Runtime worktree');
    strictEqual(opts.branch, 'feat/runtime-worktree');
    strictEqual(opts.baseRef, 'origin/main');
    strictEqual(opts.worktreeDir, '/tmp/repo-worktree');
    strictEqual(opts.format, 'json');

    throws(() => parseArgs(['plan', '--branch', '../bad']), /simple git branch name/);
    throws(() => parseArgs(['plan', '--format', 'yaml']), /--format must be text or json/);
  });
});

function fakeGitRunner({
  root,
  branch = 'main',
  dirtyLines = [],
  branchExists = false,
  baseResolves = true,
  notGit = false,
} = {}) {
  return async (command, args = []) => {
    strictEqual(command, 'git');
    const key = args.join(' ');
    if (key === '--version') return okResult('git version 2.50.0\n');
    if (key === 'rev-parse --show-toplevel') {
      return notGit ? failResult('fatal: not a git repository\n') : okResult(`${root}\n`);
    }
    if (key === 'rev-parse HEAD') return okResult('1111111111111111111111111111111111111111\n');
    if (key === 'rev-parse --abbrev-ref HEAD') return okResult(`${branch}\n`);
    if (key === 'status --short --branch') return okResult(`## ${branch}...origin/${branch}\n${dirtyLines.join('\n')}\n`);
    if (key === 'status --porcelain=v1') return okResult(dirtyLines.length ? `${dirtyLines.join('\n')}\n` : '');
    if (key === 'rev-parse --verify origin/main') {
      return baseResolves ? okResult('2222222222222222222222222222222222222222\n') : failResult('fatal: Needed a single revision\n');
    }
    if (key.startsWith('show-ref --verify refs/heads/')) {
      return branchExists ? okResult('3333333333333333333333333333333333333333 refs/heads/existing\n') : failResult('');
    }
    if (key === 'worktree list --porcelain') {
      return okResult(`worktree ${root}\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/${branch}\n`);
    }
    throw new Error(`unexpected git command: ${key}`);
  };
}

function okResult(stdout) {
  return { ok: true, exit_code: 0, stdout, stderr: '', error_code: null, timed_out: false };
}

function failResult(stderr) {
  return { ok: false, exit_code: 1, stdout: '', stderr, error_code: null, timed_out: false };
}
