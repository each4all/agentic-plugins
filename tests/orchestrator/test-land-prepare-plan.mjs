// tests/orchestrator/test-land-prepare-plan.mjs
//
// ADR-0062, amendment of 2026-11-11 — the pure decisions of the landing
// preparation helper (plugins/orchestrator/scripts/lib/land-prepare-plan.mjs).
// The git and GitHub side is held by test-land-prepare.mjs.

import { describe, it } from 'node:test';
import { deepStrictEqual, strictEqual, ok, match } from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const plan = await import(resolve(REPO_ROOT, 'plugins/orchestrator/scripts/lib/land-prepare-plan.mjs'));
// The CLI's URL rules; its entry guard keeps the import side-effect free.
const cli = await import(resolve(REPO_ROOT, 'plugins/orchestrator/scripts/land-prepare.mjs'));

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const msg = (subject, body, wf = 'compose-20261110T230321Z-8524d5') => `${subject}\n\n${body}\n\nWorkflow-ID: ${wf}\n`;
const CHILD = 'compose-20261110T230321Z-8524d5';
const KEYS = ['plugins/orchestrator', 'plugins/engineer', 'companions'];

describe('title and body rules', () => {
  it('takes a one-line title and refuses blank, multi-line and overlong ones', () => {
    strictEqual(plan.titleProblem('feat(x): add y\n'), null);
    match(plan.titleProblem('  \n'), /blank/);
    match(plan.titleProblem('a\nb'), /more than one line/);
    match(plan.titleProblem('x'.repeat(257)), /longer/);
  });

  it('refuses a body line release-please would route, and keeps prose about one', () => {
    strictEqual(plan.bodyProblem('Adds the helper.\n\nIt notes a breaking change in prose.'), null);
    match(plan.bodyProblem('Intro\n\nBREAKING CHANGE: gone'), /line 3 is a breaking-change footer/);
    // release-please reads Release-As as a version override.
    match(plan.bodyProblem('Intro\n\nRelease-As: 2.0.0'), /line 3 is a Release-As footer/);
    match(plan.bodyProblem('Intro\n  release as: 1.0.0'), /line 2 is a Release-As footer/);
    strictEqual(plan.bodyProblem('The release as a whole is unchanged.'), null);
    match(plan.bodyProblem('Intro\n  fix(x): y'), /line 2 reads as a conventional headline/);
    match(plan.bodyProblem('deps!: bump'), /headline/);
    strictEqual(plan.bodyProblem('- feat(x): y as a list item'), null);
    strictEqual(plan.bodyProblem('Note: a prose label'), null);
  });

  it("takes the squash text from the pull request as it reads, held to the same rules", () => {
    deepStrictEqual(plan.squashText({ title: ' W8: land \r\n', body: 'The body.\r\nSecond line.\r\n' }), { title: 'W8: land', body: 'The body.\nSecond line.' });
    match(plan.squashText({ title: 'x', body: 'Intro\n\nBREAKING CHANGE: gone' }).problem, /^body: line 3 is a breaking-change footer/);
    match(plan.squashText({ title: '', body: 'b' }).problem, /^title: the title is blank/);
    match(plan.squashText({ title: 'x', body: '' }).problem, /^body: the body is blank/);
    match(plan.squashText({ title: 'x' }).problem, /body could not be read/);
    match(plan.squashText(null).problem, /title could not be read/);
  });
});

describe('messages', () => {
  it('reads the last Workflow-ID trailer', () => {
    strictEqual(plan.workflowOfMessage(msg('s', 'b')), CHILD);
    strictEqual(plan.workflowOfMessage('s\n\nb\n'), null);
  });

  it('splits the subject from the body and drops the trailer block', () => {
    deepStrictEqual(plan.splitMessage(msg('fix(a): b', 'Line one.\n\nLine two.')), { subject: 'fix(a): b', body: 'Line one.\n\nLine two.' });
    deepStrictEqual(plan.splitMessage('only subject\n'), { subject: 'only subject', body: '' });
    // A last paragraph of Key: value lines with no Workflow-ID is body.
    deepStrictEqual(plan.splitMessage('s\n\nNote: kept\n'), { subject: 's', body: 'Note: kept' });
  });

  it('builds a pull request body from one commit or several', () => {
    strictEqual(plan.defaultPullRequestBody([{ message: msg('s', 'The body.') }]), 'The body.');
    strictEqual(plan.defaultPullRequestBody([{ message: msg('fix(a): one', 'B1') }, { message: msg('feat(b): two', 'B2\nmore') }]),
      '- fix(a): one\n\n  B1\n\n- feat(b): two\n\n  B2\n  more');
    // The list form passes the body rule: no headline at a line's start.
    strictEqual(plan.bodyProblem(plan.defaultPullRequestBody([{ message: msg('fix(a): one', 'B1') }, { message: msg('feat(b): two', 'B2') }])), null);
  });
});

describe('packages and the interval', () => {
  it('maps a path to the longest package key it lies under', () => {
    strictEqual(plan.packageOf('plugins/orchestrator/scripts/x.mjs', KEYS), 'plugins/orchestrator');
    strictEqual(plan.packageOf('plugins/orchestratorx/a', KEYS), null);
    strictEqual(plan.packageOf('docs/adr/0062.md', KEYS), null);
    deepStrictEqual(plan.packageKeysOf('{"packages":{"a":{},"b/c":{}}}'), ['a', 'b/c']);
    strictEqual(plan.packageKeysOf('nope'), null);
  });

  const commit = (sha, over = {}) => ({ sha, parents: [A], message: msg('s', 'b'), paths: ['plugins/orchestrator/x'], ...over });

  it('passes a series of one-package commits of the child, exempt paths alongside', () => {
    const r = plan.checkInterval([commit(B), commit(C, { paths: ['plugins/engineer/y', 'docs/z.md'] }), commit(A, { paths: ['docs/only.md'] })], { child: CHILD, packageKeys: KEYS });
    deepStrictEqual(r, { ok: true, packages: ['plugins/orchestrator', 'plugins/engineer', null] });
  });

  it('refuses an empty interval, a merge, a commit of no or another workflow, and a cross-package commit', () => {
    const run = (commits) => plan.checkInterval(commits, { child: CHILD, packageKeys: KEYS }).reason;
    strictEqual(run([]), 'empty-interval');
    strictEqual(run([commit(B, { parents: [A, C] })]), 'merge-commit');
    strictEqual(run([commit(B, { message: 's\n\nb\n' })]), 'commit-without-workflow');
    strictEqual(run([commit(B, { message: msg('s', 'b', 'compose-20260101T000000Z-000000') })]), 'commit-of-other-workflow');
    strictEqual(run([commit(B, { paths: ['plugins/orchestrator/a', 'plugins/engineer/b'] })]), 'cross-package-commit');
  });

  it('accepts a rebased series only when count, messages and paths are kept', () => {
    const before = [commit(A), commit(B)];
    strictEqual(plan.rebasedSeriesProblem(before, [commit(C), commit(C)]), null);
    match(plan.rebasedSeriesProblem(before, [commit(C)]), /1 commit\(s\) for 2/);
    match(plan.rebasedSeriesProblem(before, [commit(C), commit(C, { message: 'other' })]), /message/);
    match(plan.rebasedSeriesProblem(before, [commit(C), commit(C, { paths: ['x'] })]), /paths/);
  });
});

describe('the remote head (lease safety)', () => {
  // ancestry: A < B < C on one line; D off it.
  const line = [A, B, C];
  const ancestor = (x, y) => x === y || (line.includes(x) && line.includes(y) && line.indexOf(x) < line.indexOf(y));
  const D = 'd'.repeat(40);
  const E = 'e'.repeat(40);
  const F = 'f'.repeat(40);
  const G = '1'.repeat(40);

  it('accepts no remote, the local head, or an ancestor of it', () => {
    strictEqual(plan.remoteHeadProblem({ remote: null, local: C, ancestor }), null);
    strictEqual(plan.remoteHeadProblem({ remote: C, local: C, ancestor }), null);
    strictEqual(plan.remoteHeadProblem({ remote: A, local: C, ancestor }), null);
  });

  const pair = (before, after) => ({ before, after });

  it('accepts a remote at a head the local head was rebased from', () => {
    // C rebased to D: the remote at (an ancestor of) C is accepted.
    strictEqual(plan.remoteHeadProblem({ remote: B, local: D, lineage: [pair(C, D)], ancestor }), null);
    ok(plan.remoteHeadProblem({ remote: B, local: D, lineage: [], ancestor }));
    // The local head is not one the helper made (rewritten by hand).
    ok(plan.remoteHeadProblem({ remote: B, local: D, lineage: [pair(C, A)], ancestor }));
    // The remote is beside the chain.
    ok(plan.remoteHeadProblem({ remote: E, local: D, lineage: [pair(C, D)], ancestor }));
  });

  it('keeps every earlier pair: a pushed rebase rebased again, and a pair whose ref move never happened', () => {
    // O=C rebased to R1=D (pushed), then R1 rebased to R2=F: the remote at D.
    strictEqual(plan.remoteHeadProblem({ remote: D, local: F, lineage: [pair(C, D), pair(D, F)], ancestor }), null);
    // ...and at C, two rebases back.
    strictEqual(plan.remoteHeadProblem({ remote: C, local: F, lineage: [pair(C, D), pair(D, F)], ancestor }), null);
    // C rebased to D (not pushed: remote at C); a later rebase D→G was
    // appended but the ref never moved, so the local head is still D.
    strictEqual(plan.remoteHeadProblem({ remote: C, local: D, lineage: [pair(C, D), pair(D, G)], ancestor }), null);
  });

  it('refuses a remote of another chain: membership in the lineage is not enough', () => {
    // C→D recorded and pushed; someone grew the series to E and rebased it to
    // F (pushed); the local branch was reset to D. F is the remote: replacing
    // it with D would drop their commit.
    match(plan.remoteHeadProblem({ remote: F, local: D, lineage: [pair(C, D), pair(E, F)], ancestor }), /someone else pushed/);
    // A head the local head was rebased to, not from, does not count either.
    ok(plan.remoteHeadProblem({ remote: G, local: D, lineage: [pair(C, D), pair(D, G)], ancestor }));
  });

  it('refuses a remote that moved past or beside the local head', () => {
    match(plan.remoteHeadProblem({ remote: D, local: C, ancestor }), /someone else pushed/);
    ok(plan.remoteHeadProblem({ remote: C, local: A, ancestor }));
  });
});

describe('where a push to origin goes', () => {
  it('reads the GitHub repository from any spelling git accepts', () => {
    for (const url of ['https://github.com/o/r.git', 'https://user@GITHUB.COM:443/o/r', 'ssh://git@github.com:22/o/r.git', 'git@github.com:o/r.git', 'ssh://git@ssh.github.com:443/o/r.git', 'git+ssh://git@github.com/o/r']) {
      strictEqual(cli.githubSlugOf(url), 'o/r', url);
      ok(cli.isGithubUrl(url), url);
    }
    strictEqual(cli.githubSlugOf('/srv/mirror/r.git'), null);
    ok(!cli.isGithubUrl('/srv/mirror/r.git'));
    ok(cli.isGithubUrl('https://github.com/o'), 'a GitHub URL that names no repository is still GitHub');
  });

  it('refuses a rewrite to another GitHub repository in any spelling, and keeps a non-GitHub mirror', () => {
    const p = (fetchUrl, extra = {}) => cli.pushDestinationProblem({ slug: 'o/r', fetchUrl, pushUrls: [fetchUrl], ...extra });
    for (const other of ['ssh://git@github.com:22/other/repo.git', 'https://GITHUB.COM:443/other/repo', 'https://github.com/o', 'git@github.com.:other/repo.git', 'https://github.com./other/repo', 'git@[github.com.]:other/repo.git', 'git@[GitHub.com]:other/repo']) {
      match(p(other), /but git reaches/, other);
    }
    strictEqual(p('/srv/mirror/r.git'), null);
    strictEqual(p('git@github.com:O/R.git'), null);
    match(cli.pushDestinationProblem({ slug: 'o/r', fetchUrl: '/m.git', pushUrls: ['/n.git'] }), /pushes to \/n\.git but fetches from \/m\.git/);
    match(cli.pushDestinationProblem({ slug: 'o/r', fetchUrl: '/m.git', pushUrls: ['/m.git', '/n.git'] }), /2 URLs/);
    match(p('/srv/mirror/r.git', { overrides: ['remote.origin.receivepack'] }), /receivepack/);
  });
});

describe('the pull request of this attempt', () => {
  const since = new Date('2026-11-10T23:03:21Z');
  const pr = (over) => ({ number: 5, state: 'OPEN', headRefName: 'w8', baseRefName: 'main', createdAt: '2026-11-11T00:00:00Z', isCrossRepository: false, ...over });
  const pick = (prs) => plan.selectPullRequest(prs, { branch: 'w8', integration: 'main', since });

  it('reuses the one open, and creates when none is', () => {
    strictEqual(pick([pr()]).pr.number, 5);
    deepStrictEqual(pick([]), { pr: null });
  });

  it('ignores pull requests of an earlier attempt, another head and a fork', () => {
    deepStrictEqual(pick([pr({ createdAt: '2026-11-01T00:00:00Z' }), pr({ state: 'MERGED', createdAt: '2026-11-01T00:00:00Z' })]), { pr: null });
    deepStrictEqual(pick([pr({ headRefName: 'other' }), pr({ isCrossRepository: true })]), { pr: null });
  });

  it('stops at a merged or closed one, several open, or another base', () => {
    strictEqual(pick([pr({ state: 'MERGED' })]).refused, 'already-merged');
    strictEqual(pick([pr({ state: 'CLOSED' })]).refused, 'closed');
    strictEqual(pick([pr(), pr({ number: 6 })]).refused, 'ambiguous-pr');
    strictEqual(pick([pr({ baseRefName: 'dev' })]).refused, 'base-mismatch');
  });
});

describe('CI on the head', () => {
  const run = (over) => ({ headSha: C, status: 'completed', conclusion: 'success', createdAt: '2026-11-11T01:00:00Z', databaseId: 1, attempt: 1, url: 'u', ...over });
  const verdict = (byWf) => plan.ciVerdict(byWf, { head: C, workflows: ['full-tests.yml', 'validate.yml'] });

  it('is green only when the latest run of every workflow on the head succeeded', () => {
    strictEqual(verdict({ 'full-tests.yml': [run()], 'validate.yml': [run()] }).state, 'green');
  });

  it('never counts a run on an older sha', () => {
    const v = verdict({ 'full-tests.yml': [run({ headSha: B })], 'validate.yml': [run()] });
    strictEqual(v.state, 'pending');
    strictEqual(v.workflows[0].state, 'missing');
  });

  it('lets the latest attempt decide, and reads cancelled or skipped as not green', () => {
    const older = run({ conclusion: 'failure', createdAt: '2026-11-11T00:00:00Z', databaseId: 1 });
    strictEqual(verdict({ 'full-tests.yml': [older, run({ databaseId: 2 })], 'validate.yml': [run()] }).state, 'green');
    strictEqual(verdict({ 'full-tests.yml': [run({ databaseId: 1 }), run({ databaseId: 1, attempt: 2, conclusion: 'failure' })], 'validate.yml': [run()] }).state, 'failed');
    strictEqual(verdict({ 'full-tests.yml': [run({ conclusion: 'cancelled' })], 'validate.yml': [run()] }).state, 'failed');
    strictEqual(verdict({ 'full-tests.yml': [run({ conclusion: 'skipped' })], 'validate.yml': [run()] }).state, 'failed');
    strictEqual(verdict({ 'full-tests.yml': [run({ status: 'in_progress', conclusion: null })], 'validate.yml': [run()] }).state, 'pending');
  });

  it('lets a rerun of an older run that started last decide over a newer run', () => {
    const rerun = run({ databaseId: 1, attempt: 2, createdAt: '2026-11-11T00:00:00Z', startedAt: '2026-11-11T03:00:00Z', conclusion: 'failure' });
    const newer = run({ databaseId: 2, createdAt: '2026-11-11T01:00:00Z', startedAt: '2026-11-11T01:00:00Z' });
    strictEqual(verdict({ 'full-tests.yml': [newer, rerun], 'validate.yml': [run()] }).state, 'failed');
  });
});

describe('the next stage', () => {
  const base = { contains_tip: true, comparison_recorded: true, local: C, remote: C, pr: { number: 1, headRefOid: C }, ci: { state: 'green' } };
  it('walks rebase → record → push → PR → PR head → CI → ready', () => {
    strictEqual(plan.nextStage({ ...base, contains_tip: false }), 'rebase');
    strictEqual(plan.nextStage({ ...base, comparison_recorded: false }), 'record-comparison');
    strictEqual(plan.nextStage({ ...base, remote: B }), 'push');
    strictEqual(plan.nextStage({ ...base, remote: null }), 'push');
    strictEqual(plan.nextStage({ ...base, pr: null }), 'open-pr');
    strictEqual(plan.nextStage({ ...base, pr: { number: 1, headRefOid: B } }), 'wait-pr-head');
    strictEqual(plan.nextStage({ ...base, ci: null }), 'wait-ci');
    strictEqual(plan.nextStage({ ...base, ci: { state: 'pending' } }), 'wait-ci');
    strictEqual(plan.nextStage({ ...base, ci: { state: 'failed' } }), 'ci-failed');
    strictEqual(plan.nextStage(base), 'ready');
  });
});

describe('merge commands', () => {
  it('binds the head on both forms and reads the squash title through a variable', () => {
    deepStrictEqual(plan.mergeCommands({ prNumber: 7, head: C, commitCount: 2 }), [`gh pr merge 7 --rebase --match-head-commit ${C}`]);
    deepStrictEqual(plan.mergeCommands({ repo: 'o/r', prNumber: 7, head: C, commitCount: 2 }), [`gh pr merge 7 --repo o/r --rebase --match-head-commit ${C}`]);
    const [, squash] = plan.mergeCommands({ prNumber: 7, head: C, commitCount: 1, titleFile: "/r/it's/t.txt", bodyFile: '/r/b.txt' });
    strictEqual(squash, `TITLE="$(cat '/r/it'\\''s/t.txt')" && gh pr merge 7 --squash --match-head-commit ${C} --subject "$TITLE" --body-file '/r/b.txt'`);
  });
});
