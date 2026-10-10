// ADR-0067 Decision 8, item 4 (WP) — the two launch triggers preview and
// start judge separately: launched on the main checkout (the home-worktree
// setup: git worktree add, the start command pinned to the installed Claude
// Code cache) and plugin roots inside the repository (the refusal stays; the
// proposal pins to the caches, or to a detached snapshot worktree). Each
// trigger, and its absence.

import { describe, it, before, after } from 'node:test';
import { strictEqual, ok, match, deepStrictEqual } from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

import {
  HOME_BRANCH, installedCacheRoots, launchProposals, mainCheckoutProposal, proposalLines, reportEntries, rootsInRepoProposal,
} from '../../plugins/orchestrator/adapters/claude/autopilot/launch-proposals.mjs';
import { ROOT_MARKERS } from '../../plugins/orchestrator/adapters/claude/autopilot/roots.mjs';
import { installLikeRelease, releaseScripts } from './fixtures/install-cache.mjs';

const MACRO = 'macro-plan-20261010T000000Z-abcdef';
const GIT_ENV = {
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
};
const cleanEnv = () => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('AGENTIC_') && !k.startsWith('GIT_'))),
  ...GIT_ENV,
});
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// Each release laid out as this repository's plugin is (fixtures/install-cache.mjs).
const install = installLikeRelease;

describe('autopilot launch proposals (ADR-0067 Decision 8, item 4)', () => {
  let dir;
  let main;
  let lane;
  let home;
  let empty;
  let pins;
  const view = () => ({ macro: { id: MACRO, path: join(main, '.agentic-plugins/state/orchestrator/workflows', `${MACRO}.md`), fm: { git_baseline: { branch: 'main' } } } });
  const outside = { orchestrator: '/opt/o', engineer: '/opt/e', runtime: '/opt/r' };

  before(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'launch-proposals-')));
    main = join(dir, 'repo');
    mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    writeFileSync(join(main, 'README.md'), 'x\n');
    mkdirSync(join(main, 'plugins', 'engineer'), { recursive: true });
    writeFileSync(join(main, 'plugins', 'engineer', 'x'), 'x\n');
    git(main, 'add', '.');
    git(main, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init');
    main = realpathSync(main);
    git(main, 'worktree', 'add', '-q', '-b', 'feat/lane', join(dir, 'lane'));
    lane = realpathSync(join(dir, 'lane'));
    home = join(dir, 'home');
    empty = join(dir, 'empty-home');
    mkdirSync(empty);
    install(home, 'orchestrator', '0.9.0');
    pins = {
      orchestrator: install(home, 'orchestrator', '0.10.0'),
      engineer: install(home, 'engineer', '0.26.0'),
      runtime: install(home, 'runtime', '0.102.0'),
    };
    install(home, 'engineer', '0.27.0', { scripts: [] });
    install(home, 'runtime', '0.200.0', { name: 'not-runtime' });
    // A newer "runtime" carrying state.mjs but not the file its resolver
    // checks: not a runtime release a run can use.
    install(home, 'runtime', '0.300.0', { scripts: ['state.mjs'] });
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const startOf = (repo, extra = '') => `AGENTIC_ORCHESTRATOR_ROOT=${pins.orchestrator} AGENTIC_ENGINEER_ROOT=${pins.engineer} ` +
    `AGENTIC_RUNTIME_ROOT=${pins.runtime} node ${pins.orchestrator}/adapters/claude/autopilot/cli.mjs start --execute --macro ${MACRO}${extra} --repo ${repo}`;

  it('the fixture is a real layout: runtime ships no scripts/state.mjs, and each plugin its resolver\'s file', () => {
    ok(!releaseScripts('runtime').includes('state.mjs'), 'runtime has no state.mjs: a fixture that plants one hides a wrong marker');
    for (const [plugin, marker] of Object.entries(ROOT_MARKERS)) ok(existsSync(join(pins[plugin], marker)), `${plugin}: ${marker}`);
  });

  it("the installed cache: the newest manifest-verified release carrying its resolver's file, by number", () => {
    deepStrictEqual(installedCacheRoots(home), {
      orchestrator: { root: pins.orchestrator, version: '0.10.0' },
      engineer: { root: pins.engineer, version: '0.26.0' },
      runtime: { root: pins.runtime, version: '0.102.0' },
    });
    deepStrictEqual(installedCacheRoots(empty), {});
  });

  it('launched on the main checkout, serial: the home worktree from the baseline, then the pinned start in it', () => {
    const p = mainCheckoutProposal({ repoRoot: main, view: view(), options: {}, roots: outside, env: {}, home });
    strictEqual(p.kind, 'worktree');
    match(p.detail, /whose branch a serial run switches at each dispatch/);
    const homePath = join(dir, 'repo-autopilot');
    strictEqual(p.command, `git -C ${main} worktree add -b ${HOME_BRANCH} ${homePath} refs/heads/main && ${startOf(homePath)}`);
    strictEqual(p.pointer, '/opt/o/README.md#the-home-worktree');
    deepStrictEqual(reportEntries([p]), [{ kind: 'worktree', command: p.command, pointer: p.pointer }]);
    // The git step runs as printed.
    const [add] = p.command.split(' && ');
    const sh = spawnSync('/bin/sh', ['-c', add], { encoding: 'utf8', env: cleanEnv() });
    strictEqual(sh.status, 0, sh.stderr);
    try {
      strictEqual(git(homePath, 'branch', '--show-current'), HOME_BRANCH);
      // Now it exists: reused, the start command alone.
      const again = mainCheckoutProposal({ repoRoot: main, view: view(), options: { lanes: 2 }, roots: outside, env: {}, home });
      strictEqual(again.command, startOf(homePath, ' --lanes 2'));
      match(again.detail, /launch lanes from a home worktree no one works in: the home worktree .*repo-autopilot exists/);
      // A serial run leaves the home on a subtask's branch: still found, by its path.
      git(homePath, 'switch', '-q', '-c', 'feat/subtask');
      const moved = mainCheckoutProposal({ repoRoot: main, view: view(), options: {}, roots: outside, env: {}, home });
      strictEqual(moved.command, startOf(homePath), 'reused on whatever branch it is, never added again');
      ok(!/already exists/.test(moved.detail), moved.detail);
    } finally {
      git(main, 'worktree', 'remove', '--force', homePath);
      git(main, 'branch', '-D', 'feat/subtask');
    }
    // The branch left behind, with no worktree: added, not created again.
    const kept = mainCheckoutProposal({ repoRoot: main, view: view(), roots: outside, env: {}, home });
    match(kept.command, new RegExp(`^git -C ${main} worktree add ${homePath} ${HOME_BRANCH} && `));
    git(main, 'branch', '-D', HOME_BRANCH);
  });

  it('starts from the remote baseline when it was fetched', () => {
    git(main, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    try {
      const p = mainCheckoutProposal({ repoRoot: main, view: view(), roots: outside, env: {}, home });
      match(p.command, / refs\/remotes\/origin\/main && /);
    } finally {
      git(main, 'update-ref', '-d', 'refs/remotes/origin/main');
    }
  });

  it('absent from a linked worktree', () => {
    strictEqual(mainCheckoutProposal({ repoRoot: lane, view: view(), roots: outside, env: {}, home }), null);
    deepStrictEqual(launchProposals({ repoRoot: lane, view: view(), roots: outside, env: {}, home }), []);
  });

  it('names no command, and says why, without an install, or with the macro outside the default state root', () => {
    const none = mainCheckoutProposal({ repoRoot: main, view: view(), roots: outside, env: {}, home: empty });
    strictEqual(none.command, null);
    match(none.detail, /no Claude Code install of orchestrator, engineer, runtime to pin/);
    deepStrictEqual(reportEntries([none]), []);
    const elsewhere = mainCheckoutProposal({
      repoRoot: main, view: { macro: { id: MACRO, path: join(lane, '.agentic-plugins/state/orchestrator/workflows/x.md'), fm: {} } }, roots: outside, env: {}, home,
    });
    strictEqual(elsewhere.command, null);
    match(elsewhere.detail, /the home worktree would not find it: the state-root cutover .* comes first/);
    deepStrictEqual(proposalLines([elsewhere]), [`→ Proposed (main-checkout): ${elsewhere.detail}.`]);
  });

  it('names no command without a macro to name: the home worktree, on autopilot/home, finds none by its branch', () => {
    const unnamed = mainCheckoutProposal({ repoRoot: main, view: null, options: {}, roots: outside, env: {}, home });
    strictEqual(unnamed.command, null);
    match(unnamed.detail, /no macro was found here to name, and the home worktree, on autopilot\/home, finds none by its branch: name it with --macro <id>$/);
    // An explicit --macro is enough on its own.
    const named = mainCheckoutProposal({ repoRoot: main, view: null, options: { macro: MACRO }, roots: outside, env: {}, home });
    match(named.command, new RegExp(` start --execute --macro ${MACRO} --repo `));
  });

  it('notes an AGENTIC_STATE_BASE the home worktree would refuse', () => {
    const p = mainCheckoutProposal({ repoRoot: main, view: view(), roots: outside, env: { AGENTIC_STATE_BASE: main }, home });
    match(p.detail, /AGENTIC_STATE_BASE is set \(.*\): the home worktree accepts only itself, or the default state root once shared creation is on/);
  });

  it('roots inside the repository, with every plugin installed: pins to the caches, in this checkout', () => {
    const roots = { ...outside, engineer: join(main, 'plugins', 'engineer') };
    const p = rootsInRepoProposal({ repoRoot: main, roots, options: { macro: MACRO, lanes: 2 }, home });
    strictEqual(p.trigger, 'roots-in-repo');
    match(p.detail, /^engineer root is inside the repository this run drives: pin every root to the installed release cache \(orchestrator 0\.10\.0, engineer 0\.26\.0, runtime 0\.102\.0\)/);
    strictEqual(p.command, startOf(main, ' --lanes 2'));
    // The pins do not move what Claude Code loads.
    const loads = 'these pins move the scripts the runbooks run, not the commands and hooks Claude Code loads: when it loads these plugins from this checkout (a directory marketplace here), the first step still halts, and the run must be driven from another checkout';
    strictEqual(p.note, loads);
    deepStrictEqual(proposalLines([p]).slice(1), [`    ${p.command}`, `  (${p.note})`]);
    // Judged beside the main-checkout trigger, the note names the home
    // worktree exactly when that proposal gave its command.
    const both = launchProposals({ repoRoot: main, view: view(), roots, options: {}, env: {}, home });
    deepStrictEqual([both[0].note, Boolean(both[1].command)], [`${loads}: the home worktree the main-checkout proposal names`, true]);
    const unnamed = launchProposals({ repoRoot: main, view: null, roots, options: {}, env: {}, home });
    deepStrictEqual([unnamed[0].note, unnamed[1].command], [loads, null]);
    const fromLane = launchProposals({ repoRoot: lane, view: view(), roots: { ...outside, engineer: join(lane, 'plugins', 'engineer') }, options: {}, env: {}, home });
    deepStrictEqual(fromLane.map((x) => [x.trigger, x.note]), [['roots-in-repo', loads]]);
  });

  it('roots inside the repository, one plugin not installed: a detached snapshot worktree, the inside roots pinned into it', () => {
    const partial = join(dir, 'partial-home');
    install(partial, 'orchestrator', '0.10.0');
    install(partial, 'runtime', '0.102.0');
    const roots = { ...outside, engineer: join(main, 'plugins', 'engineer') };
    const p = rootsInRepoProposal({ repoRoot: main, roots, options: {}, home: partial });
    const head = git(main, 'rev-parse', 'HEAD');
    const snap = join(dir, 'repo-plugins-snapshot');
    strictEqual(p.command, `git -C ${main} worktree add --detach ${snap} ${head} && ` +
      `AGENTIC_ORCHESTRATOR_ROOT=/opt/o AGENTIC_ENGINEER_ROOT=${snap}/plugins/engineer AGENTIC_RUNTIME_ROOT=/opt/r ` +
      `node /opt/o/adapters/claude/autopilot/cli.mjs start --execute --repo ${main}`);
    match(p.detail, /and engineer has no Claude Code install: pin to a detached snapshot worktree no run drives and no one updates/);
    // Without every install the main-checkout proposal names no command, so
    // the note names no home worktree either.
    ok(p.note.endsWith('the run must be driven from another checkout'), p.note);
  });

  it('absent when every root lies outside the repository', () => {
    strictEqual(rootsInRepoProposal({ repoRoot: main, roots: outside, options: {}, home }), null);
    deepStrictEqual(launchProposals({ repoRoot: main, view: view(), roots: outside, env: {}, home }).map((p) => p.trigger), ['main-checkout']);
  });

  it('both triggers at once are two proposals, the roots first', () => {
    const roots = { ...outside, engineer: join(main, 'plugins', 'engineer') };
    deepStrictEqual(launchProposals({ repoRoot: main, view: view(), roots, env: {}, home }).map((p) => p.trigger), ['roots-in-repo', 'main-checkout']);
  });
});
