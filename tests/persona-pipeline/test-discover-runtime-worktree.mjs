// ADR-0067 Decision 8, item 3 (WP) — `discover-runtime.mjs worktree-plan`,
// the worktree a blocked persona start proposes first: the runtime:worktree
// planner's `git worktree add` command for the request, read from --task or
// from an args file, or the reason there is none. Run for every persona the
// manifest generates the script into, against this repository's runtime.

import { describe, it, before, after } from 'node:test';
import { strictEqual, ok, match, deepStrictEqual } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import { declaration, personasFor, pluginRoot, REPO_ROOT } from './_personas.mjs';

const RUNTIME = join(REPO_ROOT, 'plugins', 'runtime');
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
};
const cleanEnv = (extra = {}) => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && !k.startsWith('GIT_'))),
  ...GIT_ENV,
  ...extra,
});
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim();

for (const persona of personasFor('scripts/discover-runtime.mjs')) {
  describe(`${persona}: discover-runtime.mjs worktree-plan`, () => {
    const SCRIPT = join(pluginRoot(persona), 'scripts', 'discover-runtime.mjs');
    // With commit_surface the start reads --base-branch from its arguments
    // (start-args.mjs); without, the arguments are the request, whole.
    const commits = declaration(persona).capabilities.commit_surface === true;
    let dir;
    let repo;
    let home;
    const plan = (args, env = { AGENTIC_RUNTIME_ROOT: RUNTIME }) => spawnSync(process.execPath, [SCRIPT, 'worktree-plan', '--repo-root', repo, ...args], {
      encoding: 'utf8', env: cleanEnv({ HOME: home, ...env }),
    });

    before(() => {
      dir = realpathSync(mkdtempSync(join(tmpdir(), `wt-plan-${persona}-`)));
      repo = join(dir, 'repo');
      home = join(dir, 'home');
      mkdirSync(repo);
      mkdirSync(home);
      git(repo, 'init', '-q', '-b', 'main');
      writeFileSync(join(repo, 'README.md'), 'x\n');
      git(repo, 'add', 'README.md');
      git(repo, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
      // The planner's default base resolves.
      git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    });
    after(() => rmSync(dir, { recursive: true, force: true }));

    it("prints the planner's command for --task, at runtime:worktree's path, from the base given", () => {
      const r = plan(['--task', 'Add the lane advice', '--base', 'main']);
      strictEqual(r.status, 0, r.stderr);
      const json = JSON.parse(r.stdout);
      strictEqual(json.command, `git worktree add -b feat/add-the-lane-advice ${join(dir, 'repo-feat-add-the-lane-advice')} main`);
      strictEqual(json.branch, 'feat/add-the-lane-advice');
      strictEqual(json.base, 'main');
      strictEqual(json.runtime_root, realpathSync(RUNTIME));
      const text = plan(['--task', 'Add the lane advice', '--base', 'main', '--format', 'text', '--host', 'codex']);
      strictEqual(text.stdout, [
        '→ Proposed: start this in a new worktree, which leaves this checkout as it is:',
        `    git worktree add -b feat/add-the-lane-advice ${join(dir, 'repo-feat-add-the-lane-advice')} main`,
        `  then, in ${join(dir, 'repo-feat-add-the-lane-advice')}: $${persona}:start again with the same request.`,
        '',
      ].join('\n'));
    });

    it(`reads the request from an args file in the start's own grammar (${commits ? '--base-branch is the base' : 'the request whole'}), and removes the file`, () => {
      const args = mkdtempSync(join(tmpdir(), 'agentic-args.'));
      writeFileSync(join(args, 'args.json'), JSON.stringify({ agentic_args: 1, text: "Fix it's \"A\"; $(id) --base-branch main" }));
      const r = plan(['--args-file', join(args, 'args.json')]);
      strictEqual(r.status, 0, r.stderr);
      const json = JSON.parse(r.stdout);
      ok(!existsSync(join(args, 'args.json')), 'the args file is removed once read');
      if (commits) {
        strictEqual(json.base, 'main');
        match(json.command, /^git worktree add -b feat\/fix-it-s-a-id '?\//);
      } else {
        strictEqual(json.base, 'origin/main', 'no --base-branch grammar: the planner\'s default base');
        strictEqual(json.branch, 'feat/fix-it-s-a-id-base-branch-main');
      }
      const empty = mkdtempSync(join(tmpdir(), 'agentic-args.'));
      writeFileSync(join(empty, 'args.json'), JSON.stringify({ agentic_args: 1, text: '  ' }));
      const none = JSON.parse(plan(['--args-file', join(empty, 'args.json')]).stdout);
      strictEqual(none.command, null);
      match(none.reason, commits ? /needs a feature description/ : /^arguments: the args file holds no request$/);
    });

    it('quotes every word of the command from the planner\'s argv: a typed base reaches the shell as one word, never as source', () => {
      // git takes this as a branch name; unquoted, a shell would run touch.
      const base = 'rel;touch${IFS}PWNED';
      git(repo, 'branch', base);
      try {
        const json = JSON.parse(plan(['--task', 'Quoted base', '--base', base]).stdout);
        strictEqual(json.base, base);
        strictEqual(json.command, `git worktree add -b feat/quoted-base ${join(dir, 'repo-feat-quoted-base')} 'rel;touch${'$'}{IFS}PWNED'`);
        for (const shell of ['/bin/sh', 'zsh']) {
          if (shell === 'zsh' && spawnSync('zsh', ['-c', 'true']).status !== 0) continue;
          const sh = spawnSync(shell, ['-c', json.command], { cwd: repo, encoding: 'utf8', env: cleanEnv() });
          strictEqual(sh.status, 0, `${shell}: ${sh.stderr}`);
          ok(!existsSync(join(repo, 'PWNED')), `${shell}: nothing in the base ran`);
          strictEqual(git(join(dir, 'repo-feat-quoted-base'), 'rev-parse', 'HEAD'), git(repo, 'rev-parse', base));
          git(repo, 'worktree', 'remove', '--force', join(dir, 'repo-feat-quoted-base'));
          git(repo, 'branch', '-D', 'feat/quoted-base');
        }
      } finally {
        git(repo, 'branch', '-D', base);
      }
    });

    it('names the reason, with no command, when the planner blocks or no runtime resolves', () => {
      git(repo, 'branch', 'feat/taken');
      try {
        const blocked = JSON.parse(plan(['--task', 'taken', '--base', 'main']).stdout);
        strictEqual(blocked.command, null);
        match(blocked.reason, /^runtime:worktree plan is blocked: branch_available: local branch already exists/);
      } finally {
        git(repo, 'branch', '-D', 'feat/taken');
      }
      const none = plan(['--task', 'x', '--format', 'text'], { AGENTIC_RUNTIME_ROOT: join(dir, 'nowhere') });
      strictEqual(none.status, 0, none.stderr);
      match(none.stdout, /^→ Proposed: a new worktree; \/runtime:worktree plan --task "<the request>" suggests its git worktree add command \(no runtime .* with scripts\/worktree\.mjs resolved\)\.\n$/);
      const unread = JSON.parse(plan(['--args-file', join(dir, 'missing.json')]).stdout);
      strictEqual(unread.command, null);
      match(unread.reason, /--args-file: no file at/);
    });

    it('refuses a usage it does not know (exit 2), and writes nothing', () => {
      for (const args of [[], ['--task', 'x', '--args-file', 'y'], ['--args-file', 'y', '--base', 'main'], ['--task', 'x', '--format', 'yaml'], ['--bogus', 'x']]) {
        const r = spawnSync(process.execPath, [SCRIPT, 'worktree-plan', ...(args.length ? ['--repo-root', repo, ...args] : [])], { encoding: 'utf8', env: cleanEnv({ HOME: home }) });
        strictEqual(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
      }
      deepStrictEqual(git(repo, 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).length, 1, 'no worktree was added');
    });
  });
}
