// ADR-0067 Decision 8, item 3 (WP) — the worktree /orchestrator:next selects
// first when a dirty tree stops its dispatch: the runbook's command from a
// fixed template at runtime:worktree's path, one template per case (the
// subtask branch absent with and without origin, present, held by another
// worktree), and none where the new worktree could not find the macro.

import { describe, it, before, after } from 'node:test';
import { strictEqual, ok, match, deepStrictEqual } from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import {
  isPlainBranch, macroInDefaultRoot, nextWorktreeProposal, worktreePathFor, worktreeProposalText,
} from '../../plugins/orchestrator/scripts/lib/worktree-proposal.mjs';

const REPO_ROOT = join(dirname(new URL(import.meta.url).pathname), '..', '..');
const ORCH_STATE = join(REPO_ROOT, 'plugins/orchestrator/scripts/state.mjs');
const DIGEST = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
};
const cleanEnv = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && !k.startsWith('GIT_'))),
  ...GIT_ENV,
});
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const run = (args) => spawnSync(process.execPath, [ORCH_STATE, ...args], { encoding: 'utf8', env: cleanEnv() });

describe('worktree proposal for /orchestrator:next (ADR-0067 Decision 8, item 3)', () => {
  let dir;
  let main;
  let lane;
  let head;
  let macroPath;
  let macroId;
  let laneMacro;
  const propose = (over = {}) => nextWorktreeProposal({
    repoRoot: main, macroPath, macroId, subtaskId: 'A', branch: 'feat/a', baseline: 'main', ...over,
  });

  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'wt-proposal-')));
    main = join(dir, 'repo');
    mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    writeFileSync(join(main, '.gitignore'), '.agentic-plugins/\n');
    git(main, 'add', '.gitignore');
    git(main, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
    main = realpathSync(main);
    head = git(main, 'rev-parse', 'HEAD');
    git(main, 'worktree', 'add', '-q', '-b', 'feat/lane', join(dir, 'lane'));
    lane = realpathSync(join(dir, 'lane'));
    const create = (checkout, branch) => {
      const r = run(['create', '--repo-root', checkout, '--verb', 'plan', '--host', 'claude', '--git-baseline-branch', branch,
        '--git-baseline-head', head, '--status-digest', DIGEST, '--original-request', 'worktree proposal fixture']);
      strictEqual(r.status, 0, r.stderr);
      const path = r.stdout.trim();
      const file = join(dir, `${basename(path)}.json`);
      writeFileSync(file, JSON.stringify([
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'pending' },
        { id: 'B', verb: 'compose', branch: 'feat/b', blocked_by: [], status: 'pending' },
      ]));
      const p = run(['plan-set', '--workflow-path', path, '--host', 'claude', '--subtasks-json-file', file, '--verdict', 'pass']);
      strictEqual(p.status, 0, p.stderr);
      return path;
    };
    macroPath = create(main, 'main');
    macroId = basename(macroPath, '.md');
    laneMacro = create(lane, 'feat/lane');
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("runtime:worktree's path rule: <parent>/<repo>-<slug of the branch>", () => {
    strictEqual(worktreePathFor('/x/repo', 'feat/lanes-wp'), '/x/repo-feat-lanes-wp');
    strictEqual(worktreePathFor('/x/repo', '///'), '/x/repo-worktree');
  });

  it('the branch absent, no origin: git worktree add -b from the local baseline, then next inside it', () => {
    const p = propose();
    strictEqual(p.proposed, true);
    strictEqual(p.path, join(dir, 'repo-feat-a'));
    deepStrictEqual(p.commands, [`git -C ${main} worktree add -b feat/a ${join(dir, 'repo-feat-a')} refs/heads/main`]);
    strictEqual(p.then, `/orchestrator:next A --workflow=${macroId}`);
    strictEqual(propose({ host: 'codex' }).then, `$orchestrator:next A --workflow=${macroId}`);
  });

  it('the branch absent, with origin: the fetch first, then --no-track -b from the remote baseline', () => {
    const bare = join(dir, 'origin.git');
    git(dir, 'init', '-q', '--bare', bare);
    git(main, 'remote', 'add', 'origin', bare);
    try {
      const p = propose();
      deepStrictEqual(p.commands, [
        `git -C ${main} fetch --no-tags --refmap= origin +refs/heads/main:refs/remotes/origin/main`,
        `git -C ${main} worktree add --no-track -b feat/a ${join(dir, 'repo-feat-a')} refs/remotes/origin/main`,
      ]);
      match(p.note, /when the fetch fails, the add starts from the last fetched origin\/main/);
    } finally {
      git(main, 'remote', 'remove', 'origin');
    }
  });

  it('the branch present and free: git worktree add <path> <branch>', () => {
    git(main, 'branch', 'feat/a');
    try {
      deepStrictEqual(propose().commands, [`git -C ${main} worktree add ${join(dir, 'repo-feat-a')} feat/a`]);
    } finally {
      git(main, 'branch', '-D', 'feat/a');
    }
  });

  it('the branch held by another worktree: run next there; held by this checkout: no worktree helps', () => {
    const elsewhere = propose({ branch: 'feat/lane' });
    strictEqual(elsewhere.proposed, true);
    strictEqual(elsewhere.held, true);
    strictEqual(elsewhere.path, lane);
    deepStrictEqual(elsewhere.commands, []);
    match(worktreeProposalText(elsewhere), new RegExp(`^→ Proposed: run /orchestrator:next A --workflow=${macroId} in ${lane}, where feat/lane is already checked out;`));
    const here = propose({ branch: 'main' });
    strictEqual(here.proposed, false);
    strictEqual(here.resume, undefined);
    match(here.reason, /main is checked out in this checkout, so its changes are on the subtask's own branch/);
  });

  it("held by this checkout with the subtask in progress: the ordinary resume of its engineer workflow is the selection", () => {
    const here = propose({ branch: 'main', status: 'in_progress' });
    deepStrictEqual([here.proposed, here.resume, here.then], [false, true, '/engineer:resume']);
    strictEqual(worktreeProposalText(here), '→ Proposed: no new worktree: main is checked out in this checkout and subtask A is in progress, ' +
      "so these changes are its engineer workflow's work. Continue that workflow on this branch (/engineer:resume); it commits them " +
      'through its own steps. Commit, stash or revert them by hand only if they are not its work.');
    strictEqual(propose({ branch: 'main', status: 'in_progress', host: 'codex' }).then, '$engineer:resume');
    // Held elsewhere, in progress or not, the worktree that holds it is the place.
    strictEqual(propose({ branch: 'feat/lane', status: 'in_progress' }).held, true);
  });

  it("the resume here needs no other worktree: it is selected for a macro in a linked worktree's own home too", () => {
    const own = { repoRoot: lane, macroPath: laneMacro, macroId: basename(laneMacro, '.md'), subtaskId: 'A', branch: 'feat/lane', baseline: 'feat/lane' };
    const here = nextWorktreeProposal({ ...own, status: 'in_progress' });
    deepStrictEqual([here.proposed, here.resume], [false, true]);
    match(here.reason, /^feat\/lane is checked out in this checkout and subtask A is in progress/);
    // Not in progress, a worktree is the question, and the macro's home answers it.
    match(nextWorktreeProposal({ ...own, status: 'pending' }).reason, /not in a home of the default state root/);
  });

  it("a macro in a linked worktree's own home: no worktree, and the cutover named", () => {
    ok(!macroInDefaultRoot(main, laneMacro));
    ok(macroInDefaultRoot(lane, macroPath), 'the main checkout\'s macro is in the default state root, seen from the lane too');
    const p = propose({ macroPath: laneMacro, macroId: basename(laneMacro, '.md') });
    strictEqual(p.proposed, false);
    match(p.reason, /not in a home of the default state root .*state-root cutover \(docs\/runbooks\/state-root-cutover\.md\)/);
    strictEqual(worktreeProposalText(p), `→ A new worktree would not help here: ${p.reason}.`);
  });

  it('a branch, baseline or id a command line cannot carry bare is refused, never quoted into a command', () => {
    ok(!isPlainBranch("feat/a'b") && !isPlainBranch('feat/../x') && !isPlainBranch('-x') && !isPlainBranch('a.lock'));
    ok(isPlainBranch('feat/lanes-wp_2.x'));
    strictEqual(propose({ branch: 'feat/$(x)' }).proposed, false);
    strictEqual(propose({ baseline: 'ma in' }).proposed, false);
    strictEqual(propose({ subtaskId: 'A;B' }).proposed, false);
    strictEqual(propose({ macroId: 'not-a-macro' }).proposed, false);
  });

  it('a checkout path with a space and an apostrophe is quoted, and the rendered command runs as printed', () => {
    const odd = join(dir, "it's here");
    mkdirSync(odd);
    const repo = join(odd, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, '.gitignore'), '.agentic-plugins/\n');
    git(repo, 'add', '.gitignore');
    git(repo, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
    const created = run(['create', '--repo-root', repo, '--verb', 'plan', '--host', 'claude', '--git-baseline-branch', 'main',
      '--git-baseline-head', git(repo, 'rev-parse', 'HEAD'), '--status-digest', DIGEST, '--original-request', 'odd path']);
    strictEqual(created.status, 0, created.stderr);
    const p = nextWorktreeProposal({
      repoRoot: realpathSync(repo), macroPath: created.stdout.trim(), macroId: basename(created.stdout.trim(), '.md'),
      subtaskId: 'A', branch: 'feat/a', baseline: 'main',
    });
    strictEqual(p.commands.length, 1);
    match(p.commands[0], /^git -C '.*it'\\''s here\/repo' worktree add -b feat\/a '.*it'\\''s here\/repo-feat-a' refs\/heads\/main$/);
    const sh = spawnSync('/bin/sh', ['-c', p.commands[0]], { encoding: 'utf8', env: cleanEnv() });
    strictEqual(sh.status, 0, sh.stderr);
    strictEqual(git(join(odd, 'repo-feat-a'), 'branch', '--show-current'), 'feat/a');
  });

  it('an existing path is flagged', () => {
    mkdirSync(join(dir, 'repo-feat-b'));
    try {
      const p = propose({ subtaskId: 'B', branch: 'feat/b' });
      strictEqual(p.path_exists, true);
      match(worktreeProposalText(p), /⚠ .*repo-feat-b already exists: remove it, or give git worktree add another path\.$/);
    } finally {
      rmSync(join(dir, 'repo-feat-b'), { recursive: true, force: true });
    }
  });

  it("next.md's Phase 2 refuses a dirty tree with the worktree first, and switches nothing", () => {
    const text = readFileSync(join(REPO_ROOT, 'plugins/orchestrator/commands/next.md'), 'utf8');
    const from = text.indexOf('## Phase 2 — Branch precondition');
    ok(from >= 0, 'next.md carries its Phase 2');
    const block = /```bash\n([\s\S]*?)```/.exec(text.slice(from))[1];
    writeFileSync(join(main, 'stray.txt'), 'uncommitted\n');
    try {
      const env = {
        ...cleanEnv(), AGENTIC_ORCHESTRATOR_ROOT: join(REPO_ROOT, 'plugins/orchestrator'),
        REPO_ROOT: main, MACRO_PATH: macroPath, SUBTASK_ID: 'B', SUBTASK_BRANCH: 'feat/b',
      };
      const r = spawnSync('bash', ['-c', block], { cwd: main, encoding: 'utf8', env });
      strictEqual(r.status, 1);
      strictEqual(r.stderr, [
        '✗ Working tree not clean — /orchestrator:next does not switch branches over uncommitted changes.',
        "  (engineer's Phase 0 status_digest capture is meaningful only on a clean tree.)",
        '→ Proposed: a worktree first, so this checkout\'s changes stay where they are:',
        `    git -C ${main} worktree add -b feat/b ${join(dir, 'repo-feat-b')} refs/heads/main`,
        `  then, in ${join(dir, 'repo-feat-b')}: /orchestrator:next B --workflow=${macroId}`,
        "  Or, when these changes are this subtask's or are finished: commit, stash, or revert them here, then rerun /orchestrator:next.",
        '',
      ].join('\n'));
      strictEqual(git(main, 'branch', '--show-current'), 'main');
    } finally {
      rmSync(join(main, 'stray.txt'), { force: true });
    }
  });

  it('state.mjs worktree-proposal prints the lines the runbook shows', () => {
    const r = run(['worktree-proposal', '--workflow-path', macroPath, '--repo-root', main, '--subtask-id', 'B', '--format', 'text']);
    strictEqual(r.status, 0, r.stderr);
    strictEqual(r.stdout, [
      '→ Proposed: a worktree first, so this checkout\'s changes stay where they are:',
      `    git -C ${main} worktree add -b feat/b ${join(dir, 'repo-feat-b')} refs/heads/main`,
      `  then, in ${join(dir, 'repo-feat-b')}: /orchestrator:next B --workflow=${macroId}`,
      '',
    ].join('\n'));
    const json = JSON.parse(run(['worktree-proposal', '--workflow-path', macroPath, '--repo-root', main, '--subtask-id', 'B']).stdout);
    strictEqual(json.proposed, true);
    const unknown = run(['worktree-proposal', '--workflow-path', macroPath, '--repo-root', main, '--subtask-id', 'Z']);
    strictEqual(unknown.status, 1);
    match(unknown.stderr, /subtask id "Z" not found/);
  });

  it("state.mjs worktree-proposal reads the subtask's status: in progress on the branch held here, the resume", () => {
    const repo = join(dir, 'held');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, '.gitignore'), '.agentic-plugins/\n');
    git(repo, 'add', '.gitignore');
    git(repo, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
    const created = run(['create', '--repo-root', repo, '--verb', 'plan', '--host', 'claude', '--git-baseline-branch', 'main',
      '--git-baseline-head', git(repo, 'rev-parse', 'HEAD'), '--status-digest', DIGEST, '--original-request', 'held here']);
    strictEqual(created.status, 0, created.stderr);
    const path = created.stdout.trim();
    writeFileSync(join(dir, 'held.json'), JSON.stringify([{ id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'pending' }]));
    strictEqual(run(['plan-set', '--workflow-path', path, '--host', 'claude', '--subtasks-json-file', join(dir, 'held.json'), '--verdict', 'pass']).status, 0);
    git(repo, 'switch', '-q', '-c', 'feat/a');
    const text = () => run(['worktree-proposal', '--workflow-path', path, '--repo-root', realpathSync(repo), '--subtask-id', 'A', '--format', 'text']).stdout;
    match(text(), /^→ A new worktree would not help here: feat\/a is checked out in this checkout, so its changes/);
    const u = run(['subtask-update', '--workflow-path', path, '--host', 'claude', '--subtask-id', 'A', '--status=in_progress']);
    strictEqual(u.status, 0, u.stderr);
    match(text(), /^→ Proposed: no new worktree: feat\/a is checked out in this checkout and subtask A is in progress, .*\(\/engineer:resume\)/);
  });
});
