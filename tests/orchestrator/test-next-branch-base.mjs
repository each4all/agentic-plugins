// tests/orchestrator/test-next-branch-base.mjs
//
// ADR-0062 §Decision 2 — /orchestrator:next creates a new subtask branch
// from the integration branch as the remote last reported it, never from the
// checked-out HEAD. Before, `git switch -c <branch>` started the successor
// wherever the operator stood, typically on the previous subtask's branch,
// which a squash or rebase merge leaves outside `main`.
//
// The step is runbook bash, so the test runs the exact block from
// commands/next.md (between its marker comments) against real repositories.

import { describe, it } from 'node:test';
import { strictEqual, ok, notStrictEqual } from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const ORCH_ROOT = resolve(REPO_ROOT, 'plugins/orchestrator');
const { createWorkflow } = await import(resolve(ORCH_ROOT, 'scripts/state.mjs'));

const START = '# --- ADR-0062 branch-base step (extracted by tests) ---';
const END = '# --- end ADR-0062 branch-base step ---';

async function branchBaseStep() {
  const text = await readFile(resolve(ORCH_ROOT, 'commands/next.md'), 'utf8');
  const from = text.indexOf(START);
  const to = text.indexOf(END);
  ok(from >= 0 && to > from, 'next.md carries the marked branch-base step');
  return text.slice(from, to + END.length);
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t.local',
  GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t.local',
  GIT_CONFIG_NOSYSTEM: '1',
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();

async function withRepos(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-next-base-'));
  try {
    const origin = join(dir, 'origin.git');
    const work = join(dir, 'work');
    const other = join(dir, 'other');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin], { env: GIT_ENV });
    execFileSync('git', ['clone', '-q', origin, work], { env: GIT_ENV });
    git(work, 'commit', '-q', '--allow-empty', '-m', 'm1');
    git(work, 'push', '-q', 'origin', 'main');
    // The previous subtask's branch, never merged as such.
    git(work, 'switch', '-q', '-c', 'feat/old');
    git(work, 'commit', '-q', '--allow-empty', '-m', 'old work');
    // main advances on the remote (the squash that landed feat/old).
    execFileSync('git', ['clone', '-q', origin, other], { env: GIT_ENV });
    git(other, 'commit', '-q', '--allow-empty', '-m', 'squash of old work');
    git(other, 'push', '-q', 'origin', 'main');
    const { filePath } = await createWorkflow({
      repoRoot: work, verb: 'plan', host: 'claude',
      gitBaseline: { branch: 'main', head: '0'.repeat(40), status_digest: '' },
      originalRequest: 'branch base fixture',
    });
    return await fn({ work, origin, other, macroPath: filePath });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function runStep({ work, macroPath, subtaskBranch }) {
  const script = `${await branchBaseStep()}\necho "HEAD=$(git -C "$REPO_ROOT" rev-parse HEAD)"\n`;
  return spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: {
      ...GIT_ENV,
      CLAUDE_PLUGIN_ROOT: ORCH_ROOT,
      REPO_ROOT: work,
      MACRO_PATH: macroPath,
      SUBTASK_BRANCH: subtaskBranch,
    },
  });
}

describe('/orchestrator:next branch base (ADR-0062 §Decision 2)', () => {
  it('starts a new subtask branch from the fetched origin/<integration>, not from HEAD', async () => {
    await withRepos(async ({ work, other, macroPath }) => {
      const oldTip = git(work, 'rev-parse', 'HEAD');
      const landed = git(other, 'rev-parse', 'HEAD');
      const r = await runStep({ work, macroPath, subtaskBranch: 'feat/new' });
      strictEqual(r.status, 0, r.stderr);
      strictEqual(git(work, 'branch', '--show-current'), 'feat/new');
      strictEqual(git(work, 'rev-parse', 'HEAD'), landed);
      notStrictEqual(git(work, 'rev-parse', 'HEAD'), oldTip);
      const upstream = spawnSync('git', ['rev-parse', '--abbrev-ref', 'feat/new@{upstream}'], { cwd: work, encoding: 'utf8' });
      notStrictEqual(upstream.status, 0, 'the new branch does not track origin/main');
    });
  });

  it('switches to an existing subtask branch as it is', async () => {
    await withRepos(async ({ work, macroPath }) => {
      const oldTip = git(work, 'rev-parse', 'HEAD');
      git(work, 'switch', '-q', 'main');
      const r = await runStep({ work, macroPath, subtaskBranch: 'feat/old' });
      strictEqual(r.status, 0, r.stderr);
      strictEqual(git(work, 'rev-parse', 'HEAD'), oldTip);
    });
  });

  it('refuses when the integration branch has no remote-tracking ref', async () => {
    await withRepos(async ({ work, macroPath }) => {
      const text = await readFile(macroPath, 'utf8');
      const { writeFile } = await import('node:fs/promises');
      await writeFile(macroPath, text.replace('branch: "main"', 'branch: "develop"'));
      const r = await runStep({ work, macroPath, subtaskBranch: 'feat/new' });
      strictEqual(r.status, 1, r.stdout);
      ok(/refs\/remotes\/origin\/develop does not exist/.test(r.stderr), r.stderr);
      strictEqual(git(work, 'branch', '--show-current'), 'feat/old');
    });
  });

  it('without an origin remote, starts from the local integration branch', async () => {
    await withRepos(async ({ work, macroPath }) => {
      git(work, 'remote', 'remove', 'origin');
      const localMain = git(work, 'rev-parse', 'main');
      const r = await runStep({ work, macroPath, subtaskBranch: 'feat/new' });
      strictEqual(r.status, 0, r.stderr);
      strictEqual(git(work, 'rev-parse', 'HEAD'), localMain);
    });
  });
});
