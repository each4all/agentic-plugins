// tests/orchestrator/test-landing.mjs
//
// ADR-0062 §Decisions 1-2 — `state.mjs resolve-landing` finds the commit
// that landed a subtask: the merge commit of the pull request that belongs
// to this attempt, verified against the integration branch's
// remote-tracking ref. /orchestrator:done used to record the subtask branch
// tip, which a squash or rebase merge leaves outside `main`.
//
// `gh` is replaced by a fake on PATH that answers `pr list` from a fixture;
// git runs for real against a bare "origin" and a clone.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const STATE_MJS = resolve(REPO_ROOT, 'plugins/orchestrator/scripts/state.mjs');
const { createWorkflow, setPlan, updateSubtask } = await import(STATE_MJS);

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t.local',
  GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t.local',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();

const DISPATCHED = '2026-09-27T10:00:00Z';
const ENGINEER_ID = 'compose-20260927T100000Z-abcdef';
const BRANCH = 'feat/a';

// A fake `gh` that prints the fixture for `pr list` and exits with
// FAKE_GH_EXIT when set (an unauthenticated or broken gh).
const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.env.FAKE_GH_EXIT) { process.stderr.write('gh: authentication required\\n'); process.exit(Number(process.env.FAKE_GH_EXIT)); }
process.stdout.write(fs.readFileSync(process.env.FAKE_GH_PRS, 'utf8'));
`;

async function withLanding(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-landing-'));
  try {
    const origin = join(dir, 'origin.git');
    const work = join(dir, 'work');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: GIT_ENV });
    execFileSync('git', ['clone', '-q', origin, work], { env: GIT_ENV });
    git(work, 'commit', '-q', '--allow-empty', '-m', 'base');
    git(work, 'push', '-q', 'origin', 'main');
    // The subtask branch: its tip is what Phase 7 used to record.
    git(work, 'switch', '-q', '-c', BRANCH);
    git(work, 'commit', '-q', '--allow-empty', '-m', 'subtask work');
    const branchTip = git(work, 'rev-parse', 'HEAD');
    // The squash that landed it on main (a different commit).
    git(work, 'switch', '-q', 'main');
    git(work, 'commit', '-q', '--allow-empty', '-m', 'subtask work (#7)');
    const squash = git(work, 'rev-parse', 'HEAD');
    git(work, 'push', '-q', 'origin', 'main');
    git(work, 'fetch', '-q', 'origin');
    // A commit that exists locally but never reached origin/main.
    git(work, 'switch', '-q', '-c', 'local-only');
    git(work, 'commit', '-q', '--allow-empty', '-m', 'unpushed');
    const unpushed = git(work, 'rev-parse', 'HEAD');
    git(work, 'switch', '-q', 'main');
    // A commit on the local integration branch that was never pushed.
    git(work, 'commit', '-q', '--allow-empty', '-m', 'local main only');
    const localMainOnly = git(work, 'rev-parse', 'HEAD');

    const { filePath: macroPath } = await createWorkflow({
      repoRoot: work, verb: 'plan', host: 'claude',
      gitBaseline: { branch: 'main', head: '0'.repeat(40), status_digest: '' },
      originalRequest: 'landing fixture',
    });
    await setPlan({
      workflowPath: macroPath, host: 'claude',
      subtasks: [
        { id: 'A', verb: 'compose', branch: BRANCH, blocked_by: [], status: 'in_progress' },
        // U's owner was never recorded on the macro (the /next post-create
        // update was missed); /done recovers it from the engineer archive.
        { id: 'U', verb: 'compose', branch: 'feat/u', blocked_by: [], status: 'in_progress' },
      ],
    });
    await updateSubtask({ workflowPath: macroPath, subtaskId: 'A', host: 'claude', engineerWorkflowId: ENGINEER_ID });

    const bin = join(dir, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'gh'), FAKE_GH);
    await chmod(join(bin, 'gh'), 0o755);
    const prsFile = join(dir, 'prs.json');
    const logFile = join(dir, 'gh.log');
    await writeFile(logFile, '');

    const pr = (over = {}) => ({
      number: 7, url: 'https://github.com/o/r/pull/7', state: 'MERGED',
      baseRefName: 'main', headRefName: BRANCH, createdAt: '2026-09-27T10:30:00Z',
      mergeCommit: { oid: squash }, ...over,
    });

    async function resolveLanding(prs, extraArgs = [], env = {}) {
      await writeFile(prsFile, JSON.stringify(prs));
      const r = spawnSync(process.execPath, [
        STATE_MJS, 'resolve-landing', `--repo-root=${work}`,
        `--workflow-path=${macroPath}`, '--subtask-id=A', ...extraArgs,
      ], {
        encoding: 'utf8',
        env: {
          ...GIT_ENV,
          PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`,
          FAKE_GH_PRS: prsFile, FAKE_GH_LOG: logFile, ...env,
        },
      });
      return { status: r.status, stderr: r.stderr, json: r.stdout.trim() ? JSON.parse(r.stdout) : null };
    }

    return await fn({ work, macroPath, branchTip, squash, unpushed, localMainOnly, pr, resolveLanding, logFile });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('resolve-landing (ADR-0062)', () => {
  it('returns the merge commit of the merged pull request, verified against origin/main', async () => {
    await withLanding(async ({ squash, pr, resolveLanding, logFile }) => {
      const r = await resolveLanding([pr()]);
      strictEqual(r.status, 0, r.stderr);
      deepStrictEqual(r.json, {
        ok: true, commit: squash, pr_url: 'https://github.com/o/r/pull/7', pr_number: 7,
        verification: 'merge-commit', integration_ref: 'refs/remotes/origin/main',
      });
      const { readFileSync } = await import('node:fs');
      const call = JSON.parse(readFileSync(logFile, 'utf8').trim().split('\n')[0]);
      ok(call.includes('--head') && call.includes(BRANCH), `gh asked for the subtask head: ${call}`);
      ok(call.includes('all'), 'gh asked for every state, so open and merged can be told apart');
    });
  });

  it('refuses the branch tip as --commit: it is not what landed', async () => {
    await withLanding(async ({ branchTip, pr, resolveLanding }) => {
      const r = await resolveLanding([pr()], [`--commit=${branchTip}`]);
      strictEqual(r.status, 1);
      strictEqual(r.json.reason, 'commit_mismatch');
    });
  });

  it('accepts --commit when it equals the merge commit', async () => {
    await withLanding(async ({ squash, pr, resolveLanding }) => {
      const r = await resolveLanding([pr()], [`--commit=${squash.slice(0, 12)}`]);
      strictEqual(r.status, 0, JSON.stringify(r.json));
      strictEqual(r.json.commit, squash);
    });
  });

  it('distinguishes an open pull request from none at all', async () => {
    await withLanding(async ({ pr, resolveLanding }) => {
      const open = await resolveLanding([pr({ state: 'OPEN', mergeCommit: null })]);
      strictEqual(open.json.reason, 'not_merged');
      const none = await resolveLanding([]);
      strictEqual(none.json.reason, 'no_pr');
    });
  });

  it('ignores a merged pull request from before this attempt was dispatched (reused branch)', async () => {
    await withLanding(async ({ pr, resolveLanding }) => {
      const old = pr({ number: 3, url: 'https://github.com/o/r/pull/3', createdAt: '2026-09-01T00:00:00Z' });
      const r = await resolveLanding([old, pr({ state: 'OPEN', mergeCommit: null })]);
      strictEqual(r.json.reason, 'not_merged');
      const alone = await resolveLanding([old]);
      strictEqual(alone.json.reason, 'no_pr');
    });
  });

  it('refuses two merged pull requests unless --pr names one', async () => {
    await withLanding(async ({ squash, pr, resolveLanding }) => {
      const two = [pr(), pr({ number: 8, url: 'https://github.com/o/r/pull/8' })];
      const r = await resolveLanding(two);
      strictEqual(r.json.reason, 'ambiguous');
      ok(/7.*8/.test(r.json.detail), r.json.detail);
      const picked = await resolveLanding(two, ['--pr=8']);
      strictEqual(picked.status, 0, JSON.stringify(picked.json));
      strictEqual(picked.json.pr_number, 8);
      strictEqual(picked.json.commit, squash);
    });
  });

  it('applies the dispatch time to an explicitly named pull request', async () => {
    await withLanding(async ({ pr, resolveLanding }) => {
      const old = pr({ number: 3, url: 'https://github.com/o/r/pull/3', createdAt: '2026-09-01T00:00:00Z' });
      const r = await resolveLanding([old], ['--pr=3']);
      strictEqual(r.json.reason, 'pr_before_dispatch');
    });
  });

  it('ignores a pull request opened minutes before this attempt was dispatched', async () => {
    await withLanding(async ({ pr, resolveLanding }) => {
      const r = await resolveLanding([pr({ createdAt: '2026-09-27T09:55:00Z' })]);
      strictEqual(r.json.reason, 'no_pr');
    });
  });

  it('dates an unowned subtask from the owner the caller recovered, and refuses without one', async () => {
    await withLanding(async ({ squash, pr, resolveLanding }) => {
      const forU = (over) => pr({ headRefName: 'feat/u', ...over });
      const bare = await resolveLanding([forU()], ['--subtask-id=U']);
      strictEqual(bare.json.reason, 'no_dispatch_time');
      const old = forU({ number: 3, url: 'https://github.com/o/r/pull/3', createdAt: '2026-09-01T00:00:00Z' });
      const oldOnly = await resolveLanding([old], ['--subtask-id=U', `--engineer-workflow-id=${ENGINEER_ID}`]);
      strictEqual(oldOnly.json.reason, 'no_pr');
      const ok1 = await resolveLanding([old, forU()], ['--subtask-id=U', `--engineer-workflow-id=${ENGINEER_ID}`]);
      strictEqual(ok1.status, 0, JSON.stringify(ok1.json));
      strictEqual(ok1.json.commit, squash);
    });
  });

  it('refuses a pull request merged into another base', async () => {
    await withLanding(async ({ pr, resolveLanding }) => {
      const r = await resolveLanding([pr({ baseRefName: 'release' })]);
      strictEqual(r.json.reason, 'base_mismatch');
    });
  });

  it('refuses a merge commit that origin/main does not contain', async () => {
    await withLanding(async ({ unpushed, pr, resolveLanding }) => {
      const r = await resolveLanding([pr({ mergeCommit: { oid: unpushed } })]);
      strictEqual(r.json.reason, 'not_reachable');
    });
  });

  it('refuses a merge commit that only the local integration branch contains', async () => {
    await withLanding(async ({ localMainOnly, pr, resolveLanding }) => {
      const r = await resolveLanding([pr({ mergeCommit: { oid: localMainOnly } })]);
      strictEqual(r.json.reason, 'not_reachable');
      const gone = await resolveLanding([pr()], [`--commit=${localMainOnly}`], { FAKE_GH_EXIT: '4' });
      strictEqual(gone.json.reason, 'not_reachable');
    });
  });

  it('without a working gh: refuses unless --commit, then verifies by ancestry only', async () => {
    await withLanding(async ({ squash, branchTip, pr, resolveLanding }) => {
      const env = { FAKE_GH_EXIT: '4' };
      const bare = await resolveLanding([pr()], [], env);
      strictEqual(bare.json.reason, 'gh_unavailable');
      const ok1 = await resolveLanding([pr()], [`--commit=${squash}`], env);
      strictEqual(ok1.status, 0, JSON.stringify(ok1.json));
      strictEqual(ok1.json.verification, 'ancestry-only');
      strictEqual(ok1.json.pr_url, null);
      const tip = await resolveLanding([pr()], [`--commit=${branchTip}`], env);
      strictEqual(tip.json.reason, 'not_reachable');
    });
  });

  it('refuses when the integration branch has no remote-tracking ref', async () => {
    await withLanding(async ({ pr, resolveLanding }) => {
      const r = await resolveLanding([pr()], ['--integration-branch=develop']);
      strictEqual(r.json.reason, 'no_integration_ref');
    });
  });
});
