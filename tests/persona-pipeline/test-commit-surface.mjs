// scripts/phase7-commit.mjs — ADR-0063 additions for the verb-chain commit
// surface (the persona's /commit), run against sandbox repos, one suite for
// every persona the pipeline generates the module into (ADR-0066 Decision 5).
// The module belongs to commit_surface (`on_only`); the cases that run under
// an autopilot run or close a parent-linked workflow need dispatch_target as
// well (autopilot mode and the parent linkage are its, ADR-0066 Decision 3),
// so they run only where both are on. The `plugins/engineer` paths and
// `feat(engineer)` subjects below are commit-routing data (this repository's
// release-please packages), not the persona under test.
//
// Covers:
//   - classifyNoChanges on a clean tree, as plan mode reports it: recovery
//     (the ADR-0028 A2 case), close, and blocked for partial-commit,
//     unmarked-commits and next-step-not-done; execute keeps its old
//     no-changes error for everything but recovery
//   - --suggested-subjects: single commit and a cross-package split (where
//     --subject is refused), each commit taking plan mode's suggestion
//   - a split whose second commit fails lands the rest on rerun
//   - under an autopilot run nothing bypasses the staging-set confirmation
//   - --mode close: close-complete + terminal marker + archive, and every
//     refusal (changes present, recovery, blocked, pending ensemble)
//
// Run via `node --test tests/persona-pipeline/test-commit-surface.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, notStrictEqual, ok, deepStrictEqual, match } from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile, readdir, chmod, access, cp, symlink } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { personasFor, personaInfo, REPO_ROOT } from './_personas.mjs';

for (const persona of personasFor('scripts/phase7-commit.mjs')) {
  const P = personaInfo(persona);
  const PHASE7_BIN = P.path('scripts/phase7-commit.mjs');
  const STATE_BIN = P.path('scripts/state.mjs');
  const STOP_ARCHIVE = P.path('scripts/stop-archive.mjs');
  // Autopilot mode and the parent linkage belong to dispatch_target (ADR-0066
  // Decision 3): their cases run only where it is on.
  const describeDispatchOn = P.capabilities.dispatch_target ? describe : () => {};
  const itDispatchOn = P.capabilities.dispatch_target ? it : () => {};
  const ORCH_STATE = resolve(REPO_ROOT, 'plugins/orchestrator/scripts/state.mjs');
  const REL_PLEASE_CFG = resolve(REPO_ROOT, 'release-please-config.json');
  const AUTOPILOT_RUN_ID = 'autopilot-20260930T010203Z-abcdef';

  const { readWorkflow } = await import(pathToFileURL(STATE_BIN).href);
  const { runStopArchive, evaluateStopArchive } = await import(pathToFileURL(STOP_ARCHIVE).href);

  function env(extra = {}) {
    const e = { ...process.env };
    delete e.AGENTIC_AUTOPILOT;
    delete e.ACCEPT_CURRENT_TREE;
    return { ...e, AGENTIC_ORCHESTRATOR_ROOT: resolve(REPO_ROOT, 'plugins/orchestrator'), ...extra };
  }

  function sh(cwd, cmd, args) {
    return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: env() }).trimEnd();
  }

  function run(cwd, bin, args, extra = {}) {
    const r = spawnSync('node', [bin, ...args], { cwd, encoding: 'utf8', env: env(extra) });
    return { code: r.status, stdout: r.stdout.trimEnd(), stderr: r.stderr.trimEnd() };
  }

  const exists = (p) => access(p).then(() => true, () => false);

  async function withSandbox(fn) {
    const dir = await mkdtemp(join(tmpdir(), 'engineer-commit-'));
    try {
      execFileSync('git', ['init', '-q', '-b', 'feat/s'], { cwd: dir });
      execFileSync('git', ['config', 'user.name', 'engineer-commit'], { cwd: dir });
      execFileSync('git', ['config', 'user.email', 'engineer-commit@example.invalid'], { cwd: dir });
      execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
      await writeFile(join(dir, 'release-please-config.json'), await readFile(REL_PLEASE_CFG, 'utf8'));
      await writeFile(join(dir, '.gitignore'), '.agentic-plugins/state/\n');
      await writeFile(join(dir, 'README.md'), '# sandbox\n');
      await mkdir(join(dir, 'plugins', 'engineer'), { recursive: true });
      await mkdir(join(dir, 'plugins', 'runtime'), { recursive: true });
      await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 0;\n');
      await writeFile(join(dir, 'plugins', 'runtime', 'b.mjs'), 'export const b = 0;\n');
      execFileSync('git', ['add', '.'], { cwd: dir });
      execFileSync('git', ['commit', '-qm', 'chore: sandbox baseline', '--no-verify'], { cwd: dir });
      await fn(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // A verb's Phase 0 records the sha256 of `git status --porcelain=v1 -z`.
  function statusDigest(dir) {
    return execFileSync('shasum', ['-a', '256'], {
      input: execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], { cwd: dir }),
      encoding: 'utf8',
    }).trim().split(/\s+/)[0];
  }
  const EMPTY_DIGEST = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

  // A verb-chain workflow as a verb's Phase 0 creates it.
  function createWorkflow(dir, { verb = 'compose', profile = 'code', request = 'wire the thing', parent } = {}) {
    const args = [
      'create', '--repo-root', dir, '--verb', verb, '--profile', profile, '--persona', persona,
      '--host', 'claude', '--git-baseline-branch', 'feat/s',
      '--git-baseline-head', sh(dir, 'git', ['rev-parse', 'HEAD']), '--status-digest', statusDigest(dir),
      '--current-phase', 'phase-0-bootstrap', '--next-action', 'Run skill', '--original-request', request,
    ];
    if (parent) args.push('--parent-workflow', parent.macroId, '--originating-subtask', parent.subtask);
    return sh(dir, 'node', [STATE_BIN, ...args]);
  }

  function record(dir, wf, path, op = 'edit') {
    sh(dir, 'node', [STATE_BIN, 'record-composed-file', '--workflow-path', wf, '--path', path, '--op', op]);
  }

  function nextStep(dir, wf, kind, verb) {
    const args = ['append', '--workflow-path', wf, '--host', 'claude', '--next-step-kind', kind, '--next-step-confidence', 'HIGH', '--event', 'updated'];
    if (verb) args.push('--next-step-verb', verb);
    sh(dir, 'node', [STATE_BIN, ...args]);
  }

  function plan(dir, wf, extra = {}) {
    const r = run(dir, PHASE7_BIN, ['--mode', 'plan', '--workflow-path', wf, '--repo-root', dir, '--host', 'claude'], extra);
    strictEqual(r.code, 0, r.stderr);
    return JSON.parse(r.stdout);
  }

  const execArgs = (dir, wf, ...extra) => ['--mode', 'execute', '--workflow-path', wf, '--repo-root', dir, '--host', 'claude', ...extra];
  const closeArgs = (dir, wf) => ['--mode', 'close', '--workflow-path', wf, '--repo-root', dir, '--host', 'claude'];

  describe(`${persona}: classifyNoChanges — what a clean tree means (ADR-0063)`, () => {
    it('close: nothing committed since the workflow began and the last verb said done', async () => {
      await withSandbox(async (dir) => {
        const wf = createWorkflow(dir, { verb: 'investigate', profile: '' });
        nextStep(dir, wf, 'done');
        const p = plan(dir, wf);
        strictEqual(p.branch, 'no-changes');
        deepStrictEqual(
          { path: p.no_changes.path, reason: p.no_changes.reason, head_moved: p.no_changes.head_moved, marked: p.no_changes.marked_commits },
          { path: 'close', reason: null, head_moved: false, marked: [] },
        );
        ok(p.notes.some((n) => n.startsWith('no_changes.path=close') && n.includes('--mode close')), p.notes.join('\n'));
        // execute keeps its no-changes refusal, and names the close.
        const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--subject', 'chore: x'));
        strictEqual(r.code, 1);
        ok(r.stderr.includes('no-changes: working tree is clean and there is nothing to commit.'), r.stderr);
        ok(r.stderr.includes('(close: '), r.stderr);
      });
    });

    it('blocked/next-step-not-done: nothing moved, but the last verb asked for a commit (or said nothing)', async () => {
      await withSandbox(async (dir) => {
        const wf = createWorkflow(dir);
        strictEqual(plan(dir, wf).no_changes.reason, 'next-step-not-done');
        nextStep(dir, wf, 'commit');
        const p = plan(dir, wf);
        strictEqual(p.no_changes.path, 'blocked');
        strictEqual(p.no_changes.reason, 'next-step-not-done');
      });
    });

    it('blocked/unmarked-commits: HEAD moved with no Workflow-ID commit, even when the verb said done', async () => {
      await withSandbox(async (dir) => {
        const wf = createWorkflow(dir);
        nextStep(dir, wf, 'done');
        await writeFile(join(dir, 'README.md'), '# sandbox\nhand commit\n');
        sh(dir, 'git', ['commit', '-qam', 'docs: by hand']);
        const p = plan(dir, wf);
        deepStrictEqual([p.no_changes.path, p.no_changes.reason, p.no_changes.head_moved], ['blocked', 'unmarked-commits', true]);
        const r = run(dir, PHASE7_BIN, closeArgs(dir, wf));
        strictEqual(r.code, 1);
        ok(r.stderr.includes('close-refused: blocked/unmarked-commits'), r.stderr);
      });
    });

    it('recovery vs blocked/partial-commit: a marked commit that covers the manifest, or does not', async () => {
      await withSandbox(async (dir) => {
        const wf = createWorkflow(dir);
        record(dir, wf, 'README.md');
        record(dir, wf, 'plugins/engineer/a.mjs');
        await writeFile(join(dir, 'README.md'), '# sandbox\nchanged\n');
        await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 1;\n');
        // A pending ensemble fails the post-commit P11 gate after the commit
        // landed: the ADR-0028 A2 situation.
        sh(dir, 'node', [STATE_BIN, 'ensemble-pending', '--workflow-path', wf, '--phase', 'compose', '--ensemble-type', 'plan-verify', '--run-id', 'pv-1']);
        let r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'));
        strictEqual(r.code, 5, r.stderr);
        ok(sh(dir, 'git', ['log', '-1', '--format=%B']).includes(`Workflow-ID: ${basename(wf, '.md')}`));
        let p = plan(dir, wf);
        deepStrictEqual([p.no_changes.path, p.no_changes.head_moved, p.no_changes.marked_commits.length], ['recovery', true, 1]);
        // Even a `done` next step does not turn a landed commit into a close.
        nextStep(dir, wf, 'done');
        strictEqual(plan(dir, wf).no_changes.path, 'recovery');
        r = run(dir, PHASE7_BIN, closeArgs(dir, wf));
        strictEqual(r.code, 1);
        ok(r.stderr.includes('close-refused: recovery'), r.stderr);

        // A manifest path the marked commit never touched: partial, not recovery.
        record(dir, wf, 'plugins/runtime/b.mjs');
        p = plan(dir, wf);
        deepStrictEqual([p.no_changes.path, p.no_changes.reason, p.no_changes.missing_manifest], ['blocked', 'partial-commit', ['plugins/runtime/b.mjs']]);
        r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'));
        strictEqual(r.code, 1);
        ok(r.stderr.includes('(blocked/partial-commit: '), r.stderr);
      });
    });

    it('recovery finishes through execute: post-commit gates + commit-complete, no second commit', async () => {
      await withSandbox(async (dir) => {
        const wf = createWorkflow(dir);
        record(dir, wf, 'README.md');
        await writeFile(join(dir, 'README.md'), '# sandbox\nchanged\n');
        sh(dir, 'node', [STATE_BIN, 'ensemble-pending', '--workflow-path', wf, '--phase', 'compose', '--ensemble-type', 'plan-verify', '--run-id', 'pv-1']);
        strictEqual(run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects')).code, 5);
        const landed = sh(dir, 'git', ['rev-parse', 'HEAD']);
        sh(dir, 'node', [STATE_BIN, 'ensemble-commit', '--workflow-path', wf, '--host', 'claude', '--phase', 'compose', '--ensemble-type', 'plan-verify', '--run-id', 'pv-1', '--verdict', 'agree', '--summary', 's']);
        const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'));
        strictEqual(r.code, 0, r.stderr);
        ok(r.stderr.includes('A2 fast-path'), r.stderr);
        strictEqual(sh(dir, 'git', ['rev-parse', 'HEAD']), landed, 'no second commit');
        const fm = (await readWorkflow(wf)).frontmatter;
        deepStrictEqual([fm.current_phase, fm.terminal_marker], ['commit-complete', true]);
      });
    });

    it('an /engineer:start workflow on a clean tree keeps the old refusal (no next step, never a close)', async () => {
      await withSandbox(async (dir) => {
        const head = sh(dir, 'git', ['rev-parse', 'HEAD']);
        const wf = sh(dir, 'node', [STATE_BIN, 'create', '--repo-root', dir, '--verb', 'compose', '--host', 'claude',
          '--workflow-type', 'start', '--git-baseline-branch', 'feat/s', '--git-baseline-head', head, '--original-request', 'start']);
        const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--subject', 'chore: x'));
        strictEqual(r.code, 1);
        ok(r.stderr.startsWith('✗ execute-mode failed: no-changes: working tree is clean and there is nothing to commit. ' +
          `Phase 7 cannot fire on an empty diff. ${P.commandPrefix}resume archive may be the right action.`), r.stderr);
        ok(r.stderr.includes('(blocked/start-workflow: '), r.stderr);
      });
    });

    it('blocked/status-not-clean: a staged change the working tree reverted is not a clean tree', async () => {
      await withSandbox(async (dir) => {
        const wf = createWorkflow(dir, { verb: 'investigate', profile: '' });
        nextStep(dir, wf, 'done');
        await writeFile(join(dir, 'README.md'), '# sandbox\nstaged\n');
        sh(dir, 'git', ['add', 'README.md']);
        await writeFile(join(dir, 'README.md'), '# sandbox\n');
        strictEqual(sh(dir, 'git', ['diff', '--name-only', 'HEAD']), '', 'the change list sees nothing');
        const p = plan(dir, wf);
        strictEqual(p.branch, 'no-changes');
        deepStrictEqual([p.no_changes.path, p.no_changes.reason, p.no_changes.status_paths], ['blocked', 'status-not-clean', ['README.md']]);
        const r = run(dir, PHASE7_BIN, closeArgs(dir, wf));
        strictEqual(r.code, 1);
        ok(r.stderr.includes('close-refused: blocked/status-not-clean'), r.stderr);
        ok(await exists(wf));
      });
    });

    it('a start workflow a verb wrote next_step done on is still never closed', async () => {
      await withSandbox(async (dir) => {
        const head = sh(dir, 'git', ['rev-parse', 'HEAD']);
        const wf = sh(dir, 'node', [STATE_BIN, 'create', '--repo-root', dir, '--verb', 'compose', '--host', 'claude',
          '--workflow-type', 'start', '--git-baseline-branch', 'feat/s', '--git-baseline-head', head, '--original-request', 'start']);
        nextStep(dir, wf, 'done');
        strictEqual(plan(dir, wf).no_changes.reason, 'start-workflow');
        const r = run(dir, PHASE7_BIN, closeArgs(dir, wf));
        strictEqual(r.code, 1);
        ok(await exists(wf));
      });
    });
  });

  describe(`${persona}: --suggested-subjects (ADR-0063 autopilot commit subjects)`, () => {
    it('a single commit takes plan mode\'s suggested subject', async () => {
      await withSandbox(async (dir) => {
        const wf = createWorkflow(dir, { request: 'Make the $(thing) `safe`; really' });
        record(dir, wf, 'plugins/engineer/a.mjs');
        await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 1;\n');
        const p = plan(dir, wf);
        strictEqual(p.requires_split, false);
        const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects', '--strict-cc'));
        strictEqual(r.code, 0, r.stderr);
        strictEqual(sh(dir, 'git', ['log', '-1', '--format=%s']), p.commits[0].suggested_subject);
        strictEqual(p.commits[0].suggested_subject, 'feat(engineer): Make the $(thing) `safe`; really');
      });
    });

    it('a cross-package split lands one commit per package, each with its suggestion; --subject is refused there', async () => {
      await withSandbox(async (dir) => {
        const wf = createWorkflow(dir, { verb: 'refine', profile: '', request: 'split fix' });
        record(dir, wf, 'plugins/engineer/a.mjs');
        record(dir, wf, 'plugins/runtime/b.mjs');
        await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 2;\n');
        await writeFile(join(dir, 'plugins', 'runtime', 'b.mjs'), 'export const b = 2;\n');
        const p = plan(dir, wf);
        strictEqual(p.requires_split, true);
        strictEqual(p.ask_user, false);
        let r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--subject', 'fix: one subject'));
        strictEqual(r.code, 1);
        ok(r.stderr.includes('not allowed when the staging set requires a split'), r.stderr);
        r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects', '--subject', 'fix: x'));
        strictEqual(r.code, 1);
        ok(r.stderr.includes('--suggested-subjects excludes --subject and --subject-pkg'), r.stderr);
        r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects', '--strict-cc'));
        strictEqual(r.code, 0, r.stderr);
        const subjects = sh(dir, 'git', ['log', '-2', '--format=%s']).split('\n').reverse();
        deepStrictEqual(subjects, p.commits.map((c) => c.suggested_subject));
        deepStrictEqual(subjects, ['fix(engineer): split fix', 'fix(runtime): split fix']);
        strictEqual(sh(dir, 'git', ['show', '--name-only', '--format=', 'HEAD~1']), 'plugins/engineer/a.mjs');
        strictEqual(sh(dir, 'git', ['show', '--name-only', '--format=', 'HEAD']), 'plugins/runtime/b.mjs');
      });
    });

    it('a split whose second commit fails keeps the first; a rerun lands the rest and terminalizes', async () => {
      await withSandbox(async (dir) => {
        const wf = createWorkflow(dir, { verb: 'refine', profile: '', request: 'split fix' });
        record(dir, wf, 'plugins/engineer/a.mjs');
        record(dir, wf, 'plugins/runtime/b.mjs');
        await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 3;\n');
        await writeFile(join(dir, 'plugins', 'runtime', 'b.mjs'), 'export const b = 3;\n');
        const hook = join(dir, '.git', 'hooks', 'pre-commit');
        await writeFile(hook, '#!/bin/sh\nif [ -f .block-runtime ] && git diff --cached --name-only | grep -q "^plugins/runtime/"; then echo blocked >&2; exit 1; fi\n');
        await chmod(hook, 0o755);
        await writeFile(join(dir, '.git', 'info', 'exclude'), '.block-runtime\n');
        await writeFile(join(dir, '.block-runtime'), '');
        const base = sh(dir, 'git', ['rev-parse', 'HEAD']);
        let r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'));
        strictEqual(r.code, 4, r.stderr);
        ok(r.stderr.includes('aborted at commit 2/2 (package=plugins/runtime): commit-failed'), r.stderr);
        strictEqual(sh(dir, 'git', ['rev-list', '--count', `${base}..HEAD`]), '1');
        let fm = (await readWorkflow(wf)).frontmatter;
        ok(fm.terminal_marker !== true, 'the workflow stays active');

        await rm(join(dir, '.block-runtime'));
        const p = plan(dir, wf);
        deepStrictEqual([p.branch, p.requires_split, p.staging_set], ['manifest-intersects-git', false, ['plugins/runtime/b.mjs']]);
        r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'));
        strictEqual(r.code, 0, r.stderr);
        strictEqual(sh(dir, 'git', ['rev-list', '--count', `${base}..HEAD`]), '2');
        strictEqual(sh(dir, 'git', ['log', '-1', '--format=%s']), 'fix(runtime): split fix');
        fm = (await readWorkflow(wf)).frontmatter;
        deepStrictEqual([fm.current_phase, fm.terminal_marker], ['commit-complete', true]);
      });
    });
  });

  // C84: a path the user staged before Phase 7 ran (a `git rm`, either end of
  // a `git mv`) is committed as staged, routed to its own package, and never
  // re-added from the working tree. C90: a rename counts as both endpoints
  // wherever Phase 7 lists paths. Each sandbox turns rename detection on, so
  // the cases do not depend on the user's git config.
  describe(`${persona}: staged deletions and renames (C84, C90)`, () => {
    // Every index entry, modes and blob ids included.
    const indexState = (dir) => execFileSync('git', ['ls-files', '--stage', '-z'], { cwd: dir, encoding: 'utf8' });
    const nameStatus = (dir, rev) => sh(dir, 'git', ['show', '--name-status', '--no-renames', '--format=', rev]);
    const stagedStatus = (dir) => sh(dir, 'git', ['diff', '--cached', '--name-status', '--no-renames']);

    async function withRenames(fn) {
      await withSandbox(async (dir) => {
        sh(dir, 'git', ['config', 'diff.renames', 'true']);
        sh(dir, 'git', ['config', 'core.quotePath', 'true']);
        await fn(dir);
      });
    }

    // A pre-commit hook that logs what each commit takes from the index, as
    // `git diff --cached --raw` (modes and full blob ids), one block per commit.
    async function recordingHook(dir, block = '') {
      const hook = join(dir, '.git', 'hooks', 'pre-commit');
      await writeFile(hook, '#!/bin/sh\n{ echo "--"; git diff --cached --no-renames --raw --no-abbrev; } >> .git/hook-log\n' + block);
      await chmod(hook, 0o755);
      return async () => (await readFile(join(dir, '.git', 'hook-log'), 'utf8')).split('--\n').filter((b) => b.length > 0).map((b) => b.trimEnd());
    }
    const blockRuntime = 'if [ -f .block-runtime ] && git diff --cached --name-only | grep -q "^plugins/runtime/"; then echo blocked >&2; exit 1; fi\n';
    const blockEngineer = 'if [ -f .block-engineer ] && git diff --cached --name-only | grep -q "^plugins/engineer/"; then echo blocked >&2; exit 1; fi\n';

    it('(a) a deletion-only commit of a `git rm`: the deletion is committed, never re-added', async () => {
      await withRenames(async (dir) => {
        const wf = createWorkflow(dir, { verb: 'refine', profile: '', request: 'drop a' });
        record(dir, wf, 'plugins/engineer/a.mjs');
        sh(dir, 'git', ['rm', '-q', 'plugins/engineer/a.mjs']);
        const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects', '--strict-cc'));
        strictEqual(r.code, 0, r.stderr);
        strictEqual(nameStatus(dir, 'HEAD'), 'D\tplugins/engineer/a.mjs');
        strictEqual(sh(dir, 'git', ['log', '-1', '--format=%s']), 'fix(engineer): drop a');
        deepStrictEqual((await readWorkflow(wf)).frontmatter.current_phase, 'commit-complete');
      });
    });

    it('(a) control: a deletion only in the working tree is staged by `git add` and committed', async () => {
      await withRenames(async (dir) => {
        const wf = createWorkflow(dir, { verb: 'refine', profile: '', request: 'drop b' });
        record(dir, wf, 'plugins/runtime/b.mjs');
        await rm(join(dir, 'plugins', 'runtime', 'b.mjs'));
        const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'));
        strictEqual(r.code, 0, r.stderr);
        strictEqual(nameStatus(dir, 'HEAD'), 'D\tplugins/runtime/b.mjs');
      });
    });

    it('(b) a staged deletion whose path was recreated is refused, leaving the index, HEAD and the marker as they were', async () => {
      await withRenames(async (dir) => {
        const wf = createWorkflow(dir);
        record(dir, wf, 'plugins/engineer/a.mjs');
        sh(dir, 'git', ['rm', '-q', 'plugins/engineer/a.mjs']);
        await mkdir(join(dir, 'plugins', 'engineer'), { recursive: true });
        // Recreated with its old content: the cached and HEAD counts are equal,
        // so the mixed-hunk check alone cannot see it.
        await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 0;\n');
        const head = sh(dir, 'git', ['rev-parse', 'HEAD']);
        const index = indexState(dir);
        const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'));
        strictEqual(r.code, 1, r.stderr);
        ok(r.stderr.includes('staged-deletion-recreated'), r.stderr);
        ok(r.stderr.includes('    plugins/engineer/a.mjs'), r.stderr);
        strictEqual(sh(dir, 'git', ['rev-parse', 'HEAD']), head);
        strictEqual(indexState(dir), index);
        ok((await readWorkflow(wf)).frontmatter.terminal_marker !== true);
      });
    });

    it('(c) a rename inside one package: both endpoints are changes, staged and committed', async () => {
      await withRenames(async (dir) => {
        const wf = createWorkflow(dir, { request: 'rename a' });
        record(dir, wf, 'plugins/engineer/a.mjs');
        record(dir, wf, 'plugins/engineer/c.mjs', 'create');
        sh(dir, 'git', ['mv', 'plugins/engineer/a.mjs', 'plugins/engineer/c.mjs']);
        const p = plan(dir, wf);
        deepStrictEqual([p.branch, p.git_changes, p.staging_set],
          ['manifest-intersects-git', ['plugins/engineer/a.mjs', 'plugins/engineer/c.mjs'], ['plugins/engineer/a.mjs', 'plugins/engineer/c.mjs']]);
        const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'));
        strictEqual(r.code, 0, r.stderr);
        strictEqual(nameStatus(dir, 'HEAD'), 'D\tplugins/engineer/a.mjs\nA\tplugins/engineer/c.mjs');
      });
    });

    it('(c2) C90: a marked rename commit covers both endpoints of the manifest, so a clean tree is recovery', async () => {
      await withRenames(async (dir) => {
        const wf = createWorkflow(dir);
        record(dir, wf, 'plugins/engineer/a.mjs');
        record(dir, wf, 'plugins/engineer/c.mjs', 'create');
        sh(dir, 'git', ['mv', 'plugins/engineer/a.mjs', 'plugins/engineer/c.mjs']);
        sh(dir, 'git', ['commit', '-qm', `feat(engineer): rename a\n\nWorkflow-ID: ${basename(wf, '.md')}`]);
        const p = plan(dir, wf);
        deepStrictEqual([p.branch, p.no_changes.path, p.no_changes.missing_manifest], ['no-changes', 'recovery', []]);
      });
    });

    it('(d) a rename across packages: each endpoint lands in its own package commit, exactly as staged', async () => {
      await withRenames(async (dir) => {
        const wf = createWorkflow(dir, { verb: 'refine', profile: '', request: 'move a' });
        record(dir, wf, 'plugins/engineer/a.mjs');
        record(dir, wf, 'plugins/runtime/a.mjs', 'create');
        sh(dir, 'git', ['mv', 'plugins/engineer/a.mjs', 'plugins/runtime/a.mjs']);
        const approved = sh(dir, 'git', ['diff', '--cached', '--no-renames', '--raw', '--no-abbrev']).split('\n');
        const hookLog = await recordingHook(dir);
        const base = sh(dir, 'git', ['rev-parse', 'HEAD']);
        const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects', '--strict-cc'));
        strictEqual(r.code, 0, r.stderr);
        deepStrictEqual(sh(dir, 'git', ['log', '--format=%s', `${base}..HEAD`]).split('\n').reverse(), ['fix(engineer): move a', 'fix(runtime): move a']);
        strictEqual(nameStatus(dir, 'HEAD~1'), 'D\tplugins/engineer/a.mjs');
        strictEqual(nameStatus(dir, 'HEAD'), 'A\tplugins/runtime/a.mjs');
        deepStrictEqual(await hookLog(), approved, 'each commit took its endpoint\'s approved index entry, mode and blob');
      });
    });

    it('(d2) under core.filemode=false an executable rename to an ignored path keeps its entry through a failure and a rerun', async () => {
      await withRenames(async (dir) => {
        sh(dir, 'git', ['config', 'core.filemode', 'false']);
        await writeFile(join(dir, '.git', 'info', 'exclude'), '.block-runtime\n*.gen\n');
        const wf = createWorkflow(dir, { verb: 'refine', profile: '', request: 'move a' });
        record(dir, wf, 'plugins/engineer/a.mjs');
        record(dir, wf, 'plugins/runtime/a.gen', 'create');
        sh(dir, 'git', ['mv', 'plugins/engineer/a.mjs', 'plugins/runtime/a.gen']);
        sh(dir, 'git', ['update-index', '--chmod=+x', 'plugins/runtime/a.gen']);
        const approvedEntry = sh(dir, 'git', ['ls-files', '--stage', '--', 'plugins/runtime/a.gen']);
        ok(approvedEntry.startsWith('100755 '), approvedEntry);
        await recordingHook(dir, blockRuntime);
        await writeFile(join(dir, '.block-runtime'), '');
        const base = sh(dir, 'git', ['rev-parse', 'HEAD']);
        let r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'));
        strictEqual(r.code, 4, r.stderr);
        ok(r.stderr.includes('aborted at commit 2/2 (package=plugins/runtime): commit-failed'), r.stderr);
        strictEqual(nameStatus(dir, 'HEAD'), 'D\tplugins/engineer/a.mjs');
        strictEqual(sh(dir, 'git', ['ls-files', '--stage', '--', 'plugins/runtime/a.gen']), approvedEntry, 'the entry is staged as approved');

        await rm(join(dir, '.block-runtime'));
        r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'));
        strictEqual(r.code, 0, r.stderr);
        strictEqual(sh(dir, 'git', ['rev-list', '--count', `${base}..HEAD`]), '2');
        strictEqual(sh(dir, 'git', ['ls-tree', 'HEAD', '--', 'plugins/runtime/a.gen']).split(' ')[0], '100755');
      });
    });

    it('(e1) control: a foreign staged file is refused as unapproved, leaving the index as it was', async () => {
      await withRenames(async (dir) => {
        const wf = createWorkflow(dir);
        record(dir, wf, 'plugins/engineer/a.mjs');
        await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 1;\n');
        await writeFile(join(dir, 'README.md'), '# sandbox\nforeign\n');
        sh(dir, 'git', ['add', 'README.md']);
        const head = sh(dir, 'git', ['rev-parse', 'HEAD']);
        const index = indexState(dir);
        const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects', '--confirm-non-interactive'));
        strictEqual(r.code, 1, r.stderr);
        ok(r.stderr.includes('unapproved pre-staged path(s)') && r.stderr.includes('    README.md'), r.stderr);
        strictEqual(sh(dir, 'git', ['rev-parse', 'HEAD']), head);
        strictEqual(indexState(dir), index);
      });
    });

    it('(e2) a foreign `git mv` recorded only by its new path: the old path is refused as unapproved', async () => {
      await withRenames(async (dir) => {
        const wf = createWorkflow(dir);
        record(dir, wf, 'plugins/engineer/b.mjs', 'create');
        sh(dir, 'git', ['mv', 'plugins/runtime/b.mjs', 'plugins/engineer/b.mjs']);
        const head = sh(dir, 'git', ['rev-parse', 'HEAD']);
        const index = indexState(dir);
        const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects', '--confirm-non-interactive'));
        strictEqual(r.code, 1, r.stderr);
        ok(r.stderr.includes('unapproved pre-staged path(s)') && r.stderr.includes('    plugins/runtime/b.mjs'), r.stderr);
        strictEqual(sh(dir, 'git', ['rev-parse', 'HEAD']), head);
        strictEqual(indexState(dir), index);
      });
    });

    it('(e3) a force-added ignored file stays staged as approved in a single commit', async () => {
      await withRenames(async (dir) => {
        await writeFile(join(dir, '.git', 'info', 'exclude'), '*.gen\n');
        const wf = createWorkflow(dir);
        record(dir, wf, 'plugins/engineer/x.gen', 'create');
        record(dir, wf, 'plugins/engineer/a.mjs');
        await writeFile(join(dir, 'plugins', 'engineer', 'x.gen'), 'generated\n');
        sh(dir, 'git', ['add', '-f', 'plugins/engineer/x.gen']);
        await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 1;\n');
        const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'));
        strictEqual(r.code, 0, r.stderr);
        strictEqual(nameStatus(dir, 'HEAD'), 'M\tplugins/engineer/a.mjs\nA\tplugins/engineer/x.gen');
      });
    });

    it('(f) a staged deletion of a later package is set aside for commit 1 and still staged after a failure; a rerun commits it', async () => {
      await withRenames(async (dir) => {
        const wf = createWorkflow(dir, { verb: 'refine', profile: '', request: 'split' });
        record(dir, wf, 'plugins/engineer/a.mjs');
        record(dir, wf, 'plugins/runtime/b.mjs');
        await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 4;\n');
        sh(dir, 'git', ['rm', '-q', 'plugins/runtime/b.mjs']);
        await recordingHook(dir, blockEngineer + blockRuntime);
        await writeFile(join(dir, '.git', 'info', 'exclude'), '.block-*\n');
        const base = sh(dir, 'git', ['rev-parse', 'HEAD']);

        // Commit 1 fails: the later package's deletion goes back to the index.
        await writeFile(join(dir, '.block-engineer'), '');
        let r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'));
        strictEqual(r.code, 4, r.stderr);
        ok(r.stderr.includes('aborted at commit 1/2 (package=plugins/engineer): commit-failed'), r.stderr);
        strictEqual(sh(dir, 'git', ['rev-parse', 'HEAD']), base);
        ok(stagedStatus(dir).split('\n').includes('D\tplugins/runtime/b.mjs'), stagedStatus(dir));

        // Commit 2 fails: commit 1 holds only the engineer change.
        await rm(join(dir, '.block-engineer'));
        await writeFile(join(dir, '.block-runtime'), '');
        r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'));
        strictEqual(r.code, 4, r.stderr);
        strictEqual(nameStatus(dir, 'HEAD'), 'M\tplugins/engineer/a.mjs');
        strictEqual(stagedStatus(dir), 'D\tplugins/runtime/b.mjs');

        await rm(join(dir, '.block-runtime'));
        r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'));
        strictEqual(r.code, 0, r.stderr);
        strictEqual(nameStatus(dir, 'HEAD'), 'D\tplugins/runtime/b.mjs');
        strictEqual(sh(dir, 'git', ['rev-list', '--count', `${base}..HEAD`]), '2');
      });
    });

    it('(g) a mixed change or a recreated deletion in package 2 refuses before package 1 commits', async () => {
      for (const variant of ['mixed', 'recreated']) {
        await withRenames(async (dir) => {
          const wf = createWorkflow(dir, { verb: 'refine', profile: '', request: 'split' });
          record(dir, wf, 'plugins/engineer/a.mjs');
          record(dir, wf, 'plugins/runtime/b.mjs');
          await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 6;\n');
          const b = join(dir, 'plugins', 'runtime', 'b.mjs');
          if (variant === 'mixed') {
            await writeFile(b, 'export const b = 6;\nstaged\n');
            sh(dir, 'git', ['add', 'plugins/runtime/b.mjs']);
            await writeFile(b, 'export const b = 6;\nstaged\nnot staged\n');
          } else {
            sh(dir, 'git', ['rm', '-q', 'plugins/runtime/b.mjs']);
            await mkdir(join(dir, 'plugins', 'runtime'), { recursive: true });
            await writeFile(b, 'export const b = 0;\n');
          }
          const head = sh(dir, 'git', ['rev-parse', 'HEAD']);
          const index = indexState(dir);
          const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'));
          strictEqual(r.code, variant === 'mixed' ? 3 : 1, `${variant}: ${r.stderr}`);
          ok(r.stderr.includes(variant === 'mixed' ? 'mixed-hunk' : 'staged-deletion-recreated'), r.stderr);
          strictEqual(sh(dir, 'git', ['rev-parse', 'HEAD']), head, `${variant}: nothing committed`);
          strictEqual(indexState(dir), index, `${variant}: the index is as it was`);
        });
      }
    });

    it('(h) an inherited terminal marker is off before the whole-set refusal, so a moved HEAD cannot archive it', async () => {
      await withRenames(async (dir) => {
        const wf = createWorkflow(dir);
        record(dir, wf, 'plugins/engineer/a.mjs');
        // Inherited from an interactive verb: summary-complete with the marker.
        sh(dir, 'node', [STATE_BIN, 'finish-verb', '--workflow-path', wf, '--host', 'claude', '--next-action', 'commit',
          '--next-step-kind', 'commit', '--next-step-confidence', 'HIGH']);
        strictEqual((await readWorkflow(wf)).frontmatter.terminal_marker, true);
        await writeFile(join(dir, 'README.md'), '# sandbox\nsomeone\n');
        sh(dir, 'git', ['commit', '-qm', 'docs: someone else', '--', 'README.md']);
        sh(dir, 'git', ['rm', '-q', 'plugins/engineer/a.mjs']);
        await mkdir(join(dir, 'plugins', 'engineer'), { recursive: true });
        await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 8;\n');
        const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'));
        strictEqual(r.code, 1, r.stderr);
        ok(r.stderr.includes('staged-deletion-recreated'), r.stderr);
        strictEqual((await readWorkflow(wf)).frontmatter.terminal_marker, false);
        const stop = await runStopArchive({ workflowPath: wf, host: 'claude', repoRoot: dir,
          headSha: sh(dir, 'git', ['rev-parse', 'HEAD']), headSubject: 'docs: someone else', stderr: { write() {} } });
        strictEqual(stop.archived, false);
        ok(stop.gateFailures.includes('terminal_marker'), JSON.stringify(stop));
      });
    });

    it('(i) a rename to a path git would quote (a space, non-ASCII) matches the manifest', async () => {
      await withRenames(async (dir) => {
        const target = 'plugins/engineer/새 이름.mjs';
        const wf = createWorkflow(dir);
        record(dir, wf, 'plugins/engineer/a.mjs');
        record(dir, wf, target, 'create');
        sh(dir, 'git', ['mv', 'plugins/engineer/a.mjs', target]);
        const p = plan(dir, wf);
        deepStrictEqual([p.branch, p.staging_set], ['manifest-intersects-git', ['plugins/engineer/a.mjs', target]]);
        const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'));
        strictEqual(r.code, 0, r.stderr);
        const touched = execFileSync('git', ['show', '--name-only', '--no-renames', '-z', '--format=', 'HEAD'], { cwd: dir, encoding: 'utf8' });
        deepStrictEqual(touched.split('\0').filter(Boolean), ['plugins/engineer/a.mjs', target]);
        strictEqual(plan(dir, wf).no_changes.path, 'recovery', 'the probe reads the quoted endpoint too');
      });
    });

    it('(k) a path a hook stages after commit 1 is refused at commit 2, not swept into it', async () => {
      await withRenames(async (dir) => {
        const wf = createWorkflow(dir, { verb: 'refine', profile: '', request: 'split' });
        record(dir, wf, 'plugins/engineer/a.mjs');
        record(dir, wf, 'plugins/runtime/b.mjs');
        await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 7;\n');
        await writeFile(join(dir, 'plugins', 'runtime', 'b.mjs'), 'export const b = 7;\n');
        const hook = join(dir, '.git', 'hooks', 'post-commit');
        await writeFile(hook, '#!/bin/sh\nif [ ! -f .git/staged-once ]; then touch .git/staged-once; echo stray > stray.md; git add stray.md; fi\n');
        await chmod(hook, 0o755);
        const base = sh(dir, 'git', ['rev-parse', 'HEAD']);
        const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'));
        strictEqual(r.code, 1, r.stderr);
        ok(r.stderr.includes('aborted at commit 2/2 (package=plugins/runtime): unapproved-pre-staged'), r.stderr);
        ok(r.stderr.includes('    stray.md'), r.stderr);
        strictEqual(sh(dir, 'git', ['rev-list', '--count', `${base}..HEAD`]), '1');
        strictEqual(nameStatus(dir, 'HEAD'), 'M\tplugins/engineer/a.mjs');
      });
    });

    it('(i2) a later package\'s pre-staged path with a tab in its name is set aside and put back exactly', async () => {
      await withRenames(async (dir) => {
        const target = 'plugins/runtime/a\tb.mjs';
        const wf = createWorkflow(dir, { verb: 'refine', profile: '', request: 'move a' });
        record(dir, wf, 'plugins/engineer/a.mjs');
        record(dir, wf, target, 'create');
        sh(dir, 'git', ['mv', 'plugins/engineer/a.mjs', target]);
        const approved = sh(dir, 'git', ['diff', '--cached', '--no-renames', '--raw', '--no-abbrev']).split('\n');
        const hookLog = await recordingHook(dir);
        const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'));
        strictEqual(r.code, 0, r.stderr);
        deepStrictEqual(await hookLog(), approved);
      });
    });

    it('(l) an approved path named like a glob stages only itself, never a file it would match', async () => {
      await withRenames(async (dir) => {
        const glob = 'plugins/engineer/*.mjs';
        const wf = createWorkflow(dir);
        record(dir, wf, 'plugins/engineer/a.mjs');
        record(dir, wf, glob, 'create');
        sh(dir, 'git', ['mv', 'plugins/engineer/a.mjs', glob]);
        await writeFile(join(dir, 'plugins', 'engineer', 'stray.mjs'), 'export const stray = 1;\n');
        const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects', '--confirm-non-interactive'));
        // The commit lands without the stray file, which then fails the
        // clean-after-commit gate as the unapproved change it is.
        strictEqual(r.code, 7, r.stderr);
        strictEqual(nameStatus(dir, 'HEAD'), `A\t${glob}\nD\tplugins/engineer/a.mjs`);
        strictEqual(sh(dir, 'git', ['status', '--porcelain=v1', '--', 'plugins/engineer/stray.mjs']), '?? plugins/engineer/stray.mjs');
      });
    });

    it('(m) an unmerged path is refused before anything is set aside, leaving the index and HEAD as they were', async () => {
      await withRenames(async (dir) => {
        const wf = createWorkflow(dir, { verb: 'refine', profile: '', request: 'split' });
        record(dir, wf, 'plugins/engineer/a.mjs');
        record(dir, wf, 'plugins/runtime/b.mjs');
        await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 9;\n');
        // A conflict on package 2's path: stages 1, 2 and 3, no stage 0.
        const blob = (text) => execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: text, encoding: 'utf8' }).trim();
        const p = 'plugins/runtime/b.mjs';
        const info = `0 ${'0'.repeat(40)}\t${p}\n` +
          [1, 2, 3].map((s) => `100644 ${blob(`export const b = ${s};\n`)} ${s}\t${p}`).join('\n') + '\n';
        execFileSync('git', ['update-index', '--index-info'], { cwd: dir, input: info });
        await writeFile(join(dir, p), 'export const b = 2;\n');
        const head = sh(dir, 'git', ['rev-parse', 'HEAD']);
        const index = indexState(dir);
        const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'));
        strictEqual(r.code, 1, r.stderr);
        ok(r.stderr.includes('unmerged-entries') && r.stderr.includes(`    ${p}`), r.stderr);
        strictEqual(sh(dir, 'git', ['rev-parse', 'HEAD']), head);
        strictEqual(indexState(dir), index);
      });
    });

    it('(n) a case-only `git mv` on a case-insensitive filesystem is a rename, not a recreated path', async (t) => {
      await withRenames(async (dir) => {
        await writeFile(join(dir, 'case-probe'), '');
        if (!(await exists(join(dir, 'CASE-PROBE')))) {
          t.skip('the filesystem is case-sensitive: a case-only rename cannot meet a recreated path here');
          return;
        }
        await rm(join(dir, 'case-probe'));
        const wf = createWorkflow(dir, { verb: 'refine', profile: '', request: 'rename b' });
        record(dir, wf, 'plugins/runtime/b.mjs');
        record(dir, wf, 'plugins/runtime/B.mjs', 'create');
        sh(dir, 'git', ['mv', 'plugins/runtime/b.mjs', 'plugins/runtime/B.mjs']);
        const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'));
        strictEqual(r.code, 0, r.stderr);
        strictEqual(nameStatus(dir, 'HEAD'), 'A\tplugins/runtime/B.mjs\nD\tplugins/runtime/b.mjs');
      });
    });

    it('(o) a directory at a staged deletion\'s path is no recreated file; a dangling symlink there is', async () => {
      for (const variant of ['directory', 'symlink']) {
        await withRenames(async (dir) => {
          const wf = createWorkflow(dir, { verb: 'refine', profile: '', request: 'drop b' });
          record(dir, wf, 'plugins/runtime/b.mjs');
          sh(dir, 'git', ['rm', '-q', 'plugins/runtime/b.mjs']);
          await mkdir(join(dir, 'plugins', 'runtime'), { recursive: true });
          if (variant === 'directory') await mkdir(join(dir, 'plugins', 'runtime', 'b.mjs'));
          else await symlink('nowhere', join(dir, 'plugins', 'runtime', 'b.mjs'));
          const index = indexState(dir);
          const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'));
          if (variant === 'directory') {
            strictEqual(r.code, 0, `${variant}: ${r.stderr}`);
            strictEqual(nameStatus(dir, 'HEAD'), 'D\tplugins/runtime/b.mjs');
          } else {
            strictEqual(r.code, 1, `${variant}: ${r.stderr}`);
            ok(r.stderr.includes('staged-deletion-recreated'), r.stderr);
            strictEqual(indexState(dir), index);
          }
        });
      }
    });

    it('(p) a staged change the working tree differs from at an equal line count (or a binary) is refused before any commit', async () => {
      for (const variant of ['text', 'binary', 'single']) {
        await withRenames(async (dir) => {
          const wf = createWorkflow(dir, { verb: 'refine', profile: '', request: 'split' });
          record(dir, wf, 'plugins/runtime/b.mjs');
          if (variant !== 'single') {
            record(dir, wf, 'plugins/engineer/a.mjs');
            await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 10;\n');
          }
          const b = join(dir, 'plugins', 'runtime', 'b.mjs');
          await writeFile(b, variant === 'binary' ? Buffer.from([0, 1, 2, 0]) : 'approved b\n');
          sh(dir, 'git', ['add', 'plugins/runtime/b.mjs']);
          await writeFile(b, variant === 'binary' ? Buffer.from([0, 1, 3, 0]) : 'unapproved b\n');
          const head = sh(dir, 'git', ['rev-parse', 'HEAD']);
          const index = indexState(dir);
          const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'));
          strictEqual(r.code, 3, `${variant}: ${r.stderr}`);
          ok(r.stderr.includes('mixed-hunk paths detected') && r.stderr.includes('plugins/runtime/b.mjs'), r.stderr);
          strictEqual(sh(dir, 'git', ['rev-parse', 'HEAD']), head, `${variant}: nothing committed`);
          strictEqual(indexState(dir), index, `${variant}: the staged content is kept`);
        });
      }
    });

    // A glob-named path and a sibling it would match: the mixed-hunk check asks
    // about each path alone. (q1) the glob is staged as it is and the sibling has
    // an unstaged edit; (q2) the glob has an unstaged edit and the sibling is
    // staged as it is. Neither path is mixed, so both commit.
    const glob = 'plugins/engineer/*.mjs';
    it('(q1) a staged glob-named path is not mixed because of a sibling\'s unstaged edit', async () => {
      await withRenames(async (dir) => {
        const wf = createWorkflow(dir);
        record(dir, wf, glob, 'create');
        record(dir, wf, 'plugins/engineer/a.mjs');
        await writeFile(join(dir, glob), 'export const g = 1;\n');
        sh(dir, 'git', ['--literal-pathspecs', 'add', '--', glob]);
        await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 11;\n');
        const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'));
        strictEqual(r.code, 0, r.stderr);
        strictEqual(nameStatus(dir, 'HEAD'), `A\t${glob}\nM\tplugins/engineer/a.mjs`);
      });
    });

    it('(q2) an unstaged glob-named path is not mixed because a sibling is staged', async () => {
      await withRenames(async (dir) => {
        await writeFile(join(dir, glob), 'export const g = 0;\n');
        sh(dir, 'git', ['--literal-pathspecs', 'add', '--', glob]);
        sh(dir, 'git', ['commit', '-qm', 'chore: glob-named file', '--no-verify']);
        const wf = createWorkflow(dir);
        record(dir, wf, glob);
        record(dir, wf, 'plugins/engineer/a.mjs');
        await writeFile(join(dir, glob), 'export const g = 2;\n');
        await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 12;\n');
        sh(dir, 'git', ['add', 'plugins/engineer/a.mjs']);
        const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'));
        strictEqual(r.code, 0, r.stderr);
        strictEqual(nameStatus(dir, 'HEAD'), `M\t${glob}\nM\tplugins/engineer/a.mjs`);
      });
    });

    // A split whose second commit holds an executable rename destination an
    // ignore rule matches (only the exact index entry can put it back) and a
    // staged deletion of a path named like a glob (removing it by hand must
    // not unstage plugins/runtime/b.mjs, which it matches).
    const globDeleted = 'plugins/runtime/*.mjs';
    async function laterEntries(dir) {
      sh(dir, 'git', ['config', 'core.filemode', 'false']);
      await writeFile(join(dir, '.git', 'info', 'exclude'), '*.gen\n');
      await writeFile(join(dir, globDeleted), 'export const g = 0;\n');
      sh(dir, 'git', ['--literal-pathspecs', 'add', '--', globDeleted]);
      sh(dir, 'git', ['commit', '-qm', 'chore: glob-named file', '--no-verify']);
      const wf = createWorkflow(dir, { verb: 'refine', profile: '', request: 'move a' });
      record(dir, wf, 'plugins/engineer/a.mjs');
      record(dir, wf, 'plugins/runtime/a.gen', 'create');
      record(dir, wf, globDeleted);
      sh(dir, 'git', ['mv', 'plugins/engineer/a.mjs', 'plugins/runtime/a.gen']);
      sh(dir, 'git', ['update-index', '--chmod=+x', 'plugins/runtime/a.gen']);
      sh(dir, 'git', ['--literal-pathspecs', 'rm', '-q', '--', globDeleted]);
      return { wf, approved: sh(dir, 'git', ['ls-files', '--stage', '--', 'plugins/runtime']) };
    }
    const runtimeIndex = (dir) => sh(dir, 'git', ['ls-files', '--stage', '--', 'plugins/runtime']);

    // A `git` first on PATH that runs the real one: `before` runs ahead of it
    // (and may fail the call), `after` once it succeeded. A fault between two
    // of the driver's own git writes, which no hook reaches.
    const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    async function gitShim(dir, { before = '', after = '' }) {
      const bin = join(dir, '.git', 'shim');
      await mkdir(bin, { recursive: true });
      await writeFile(join(bin, 'git'), `#!/bin/sh\nD='${dir}'\n${before}\n'${REAL_GIT}' "$@"\nrc=$?\nif [ $rc -eq 0 ]; then\n:\n${after}\nfi\nexit $rc\n`);
      await chmod(join(bin, 'git'), 0o755);
      return { PATH: `${bin}:${process.env.PATH}` };
    }

    // The by-hand restore the driver printed, run as printed.
    function restoreByHand(dir, stderr) {
      const lines = stderr.split('\n');
      const section = (header) => {
        const at = lines.findIndex((l) => l.includes(header));
        if (at < 0) return [];
        const out = [];
        for (let k = at + 1; k < lines.length && lines[k].startsWith('    '); k++) out.push(lines[k].slice(4));
        return out;
      };
      const entries = section('for `git update-index --index-info`:');
      if (entries.length > 0) execFileSync('git', ['update-index', '--index-info'], { cwd: dir, input: `${entries.join('\n')}\n` });
      // The deletion command as printed, its `<path>` filled in.
      const header = lines.find((l) => l.includes('staged deletions, each for `'));
      const deletions = header ? section(header) : [];
      const command = header ? header.slice(header.indexOf('`') + 1, header.lastIndexOf('`')).split(' ') : [];
      for (const p of deletions) execFileSync(command[0], command.slice(1).map((a) => (a === '<path>' ? p : a)), { cwd: dir });
      return { entries, deletions };
    }

    it('(r) a set-aside that fails reports the index as it was, with nothing to restore by hand', async () => {
      await withRenames(async (dir) => {
        const { wf } = await laterEntries(dir);
        const head = sh(dir, 'git', ['rev-parse', 'HEAD']);
        const index = indexState(dir);
        await writeFile(join(dir, '.git', 'index.lock'), '');
        const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'));
        strictEqual(r.code, 1, r.stderr);
        ok(r.stderr.includes('could not set the later commits\' staged entries aside') && r.stderr.includes('the index is as it was'), r.stderr);
        ok(!r.stderr.includes('restore them by hand'), r.stderr);
        await rm(join(dir, '.git', 'index.lock'));
        strictEqual(sh(dir, 'git', ['rev-parse', 'HEAD']), head);
        strictEqual(indexState(dir), index);
      });
    });

    it('(s) a restore that fails after commit 1 prints the set-aside entries, which put back by hand land on a rerun', async () => {
      await withRenames(async (dir) => {
        const { wf, approved } = await laterEntries(dir);
        const hook = join(dir, '.git', 'hooks', 'post-commit');
        await writeFile(hook, '#!/bin/sh\nif [ ! -f .git/locked-once ]; then touch .git/locked-once .git/index.lock; fi\n');
        await chmod(hook, 0o755);
        const base = sh(dir, 'git', ['rev-parse', 'HEAD']);
        let r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'));
        strictEqual(r.code, 1, r.stderr);
        ok(r.stderr.includes('aborted at commit 2/2 (package=plugins/runtime): index-restore-failed'), r.stderr);
        strictEqual(nameStatus(dir, 'HEAD'), 'D\tplugins/engineer/a.mjs');
        await rm(join(dir, '.git', 'index.lock'));
        notStrictEqual(runtimeIndex(dir), approved, 'the entries are still set aside');
        const byHand = restoreByHand(dir, r.stderr);
        deepStrictEqual([byHand.entries.length, byHand.deletions], [1, [globDeleted]]);
        strictEqual(runtimeIndex(dir), approved, 'the printed text restores the approved entries');
        r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'));
        strictEqual(r.code, 0, r.stderr);
        strictEqual(sh(dir, 'git', ['rev-list', '--count', `${base}..HEAD`]), '2');
        strictEqual(nameStatus(dir, 'HEAD'), `D\t${globDeleted}\nA\tplugins/runtime/a.gen`);
        strictEqual(sh(dir, 'git', ['ls-tree', 'HEAD', '--', 'plugins/runtime/a.gen']).split(' ')[0], '100755');
      });
    });

    it('(t) a restore that fails between its two writes prints only what is still out', async () => {
      await withRenames(async (dir) => {
        const { wf, approved } = await laterEntries(dir);
        const path = await gitShim(dir, {
          after: 'if [ "$1 $2 $3" = "update-index -z --index-info" ] && [ ! -f "$D/.git/shim-done" ]; then touch "$D/.git/shim-done" "$D/.git/index.lock"; fi',
        });
        const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'), path);
        strictEqual(r.code, 1, r.stderr);
        ok(r.stderr.includes('aborted at commit 2/2 (package=plugins/runtime): index-restore-failed'), r.stderr);
        await rm(join(dir, '.git', 'index.lock'));
        const byHand = restoreByHand(dir, r.stderr);
        deepStrictEqual([byHand.entries, byHand.deletions], [[], [globDeleted]], r.stderr);
        strictEqual(runtimeIndex(dir), approved);
      });
    });

    it('(u) a failure thrown after the set-aside puts the later commits\' entries back', async () => {
      await withRenames(async (dir) => {
        const { wf } = await laterEntries(dir);
        const head = sh(dir, 'git', ['rev-parse', 'HEAD']);
        const index = indexState(dir);
        // The second index check (commit 1's, after the set-aside) fails.
        const path = await gitShim(dir, {
          before: 'if [ "$1 $2 $3" = "ls-files --unmerged -z" ]; then n=$(cat "$D/.git/shim-n" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$D/.git/shim-n"; if [ $n -eq 2 ]; then echo "shim: injected failure" >&2; exit 2; fi; fi',
        });
        const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'), path);
        strictEqual(r.code, 1, r.stderr);
        ok(r.stderr.includes('shim: injected failure'), r.stderr);
        strictEqual(sh(dir, 'git', ['rev-parse', 'HEAD']), head);
        strictEqual(indexState(dir), index);
      });
    });

    it('(v) under core.precomposeUnicode an NFD name on disk is the NFC path git deleted: refused as recreated', async (t) => {
      if (process.platform !== 'darwin') {
        t.skip('git applies core.precomposeUnicode only on macOS');
        return;
      }
      await withRenames(async (dir) => {
        sh(dir, 'git', ['config', 'core.precomposeunicode', 'true']);
        const nfc = 'plugins/runtime/caf\u00e9.mjs';
        const nfd = 'plugins/runtime/cafe\u0301.mjs';
        await writeFile(join(dir, nfc), 'export const c = 0;\n');
        sh(dir, 'git', ['add', '--', nfc]);
        sh(dir, 'git', ['commit', '-qm', 'chore: nfc name', '--no-verify']);
        const wf = createWorkflow(dir, { verb: 'refine', profile: '', request: 'drop cafe' });
        record(dir, wf, nfc);
        sh(dir, 'git', ['rm', '-q', '--', nfc]);
        await writeFile(join(dir, nfd), 'export const c = 1;\n');
        ok((await readdir(join(dir, 'plugins', 'runtime'))).includes('cafe\u0301.mjs'), 'the name on disk is NFD');
        const head = sh(dir, 'git', ['rev-parse', 'HEAD']);
        const index = indexState(dir);
        const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'));
        strictEqual(r.code, 1, r.stderr);
        ok(r.stderr.includes('staged-deletion-recreated'), r.stderr);
        strictEqual(sh(dir, 'git', ['rev-parse', 'HEAD']), head);
        strictEqual(indexState(dir), index);
      });
    });

    // The user's diff drivers call the staged blob and the working tree the
    // same: a trusted external driver that always exits 0, or a textconv that
    // maps every file to one text. The blobs still differ, so the path is mixed.
    it('(w) a diff driver that hides a difference does not make a partly staged path look whole', async () => {
      for (const variant of ['external', 'textconv']) {
        await withRenames(async (dir) => {
          if (variant === 'external') {
            sh(dir, 'git', ['config', 'diff.external', 'true']);
            sh(dir, 'git', ['config', 'diff.trustExitCode', 'true']);
          } else {
            await writeFile(join(dir, '.git', 'info', 'attributes'), '*.mjs diff=same\n');
            sh(dir, 'git', ['config', 'diff.same.textconv', 'sh -c "echo same" --']);
          }
          const wf = createWorkflow(dir, { verb: 'refine', profile: '', request: 'edit b' });
          record(dir, wf, 'plugins/runtime/b.mjs');
          const b = join(dir, 'plugins', 'runtime', 'b.mjs');
          await writeFile(b, 'approved b\n');
          sh(dir, 'git', ['add', 'plugins/runtime/b.mjs']);
          await writeFile(b, 'approved b \n');
          const head = sh(dir, 'git', ['rev-parse', 'HEAD']);
          const index = indexState(dir);
          const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'));
          strictEqual(r.code, 3, `${variant}: ${r.stderr}`);
          ok(r.stderr.includes('mixed-hunk paths detected') && r.stderr.includes('plugins/runtime/b.mjs'), r.stderr);
          strictEqual(sh(dir, 'git', ['rev-parse', 'HEAD']), head, `${variant}: nothing committed`);
          strictEqual(indexState(dir), index, `${variant}: the staged content is kept`);
        });
      }
    });

    // The set-aside's `git reset` writes the index and then fails (a git killed
    // after its write): its failure alone does not say the index is as it was.
    // 'put back': the driver finds the entries out and puts them back; 'by hand':
    // a lock stops that too, and the printed text restores them.
    it('(x) a set-aside that failed after its write is read again: the entries are put back, or printed', async () => {
      for (const variant of ['put back', 'by hand']) {
        await withRenames(async (dir) => {
          const { wf, approved } = await laterEntries(dir);
          const head = sh(dir, 'git', ['rev-parse', 'HEAD']);
          const index = indexState(dir);
          const lock = variant === 'by hand' ? 'touch "$D/.git/index.lock"; ' : '';
          const path = await gitShim(dir, { after: `if [ "$1 $2" = "--literal-pathspecs reset" ]; then ${lock}rc=137; fi` });
          const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'), path);
          strictEqual(r.code, 1, `${variant}: ${r.stderr}`);
          ok(r.stderr.includes('could not set the later commits\' staged entries aside'), r.stderr);
          ok(!r.stderr.includes('Nothing was committed, and the index is as it was'), r.stderr);
          strictEqual(sh(dir, 'git', ['rev-parse', 'HEAD']), head, `${variant}: nothing committed`);
          if (variant === 'put back') {
            ok(r.stderr.includes('the set-aside entries were put back, and the index is as it was'), r.stderr);
            ok(!r.stderr.includes('restore them by hand'), r.stderr);
          } else {
            ok(r.stderr.includes('the set-aside entries are not all back') && r.stderr.includes('restore them by hand'), r.stderr);
            await rm(join(dir, '.git', 'index.lock'));
            notStrictEqual(runtimeIndex(dir), approved, 'the entries are still set aside');
            restoreByHand(dir, r.stderr);
          }
          strictEqual(runtimeIndex(dir), approved, `${variant}: the approved entries are back`);
          strictEqual(indexState(dir), index, `${variant}: the index is as it was`);
        });
      }
    });

    // A submodule moved to a new commit, under diff.ignoreSubmodules=all, which
    // hides gitlink changes from every git command that does not override it.
    // One variant per site: the pre-staged guard ('unapproved'), the changes
    // Phase 7 stages ('approved'), a marked commit's paths ('recovery'), and
    // the mixed-hunk check ('mixed': staged at one commit, moved on to
    // another).
    it('(y) a moved submodule is a change whatever diff.ignoreSubmodules says', async () => {
      const vendor = 'plugins/runtime/vendor';
      const ident = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'];
      for (const variant of ['unapproved', 'approved', 'recovery', 'mixed']) {
        const src = await mkdtemp(join(tmpdir(), 'engineer-commit-sub-'));
        try {
          execFileSync('git', ['init', '-q'], { cwd: src });
          execFileSync('git', [...ident, 'commit', '-q', '--allow-empty', '-m', 'one'], { cwd: src });
          await withRenames(async (dir) => {
            sh(dir, 'git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', src, vendor]);
            sh(dir, 'git', ['commit', '-qm', 'chore: vendor', '--no-verify']);
            sh(dir, 'git', ['config', 'diff.ignoreSubmodules', 'all']);
            const wf = createWorkflow(dir, { verb: 'refine', profile: '', request: 'move vendor' });
            execFileSync('git', [...ident, 'commit', '-q', '--allow-empty', '-m', 'two'], { cwd: join(dir, vendor) });
            const head = sh(dir, 'git', ['rev-parse', 'HEAD']);
            if (variant === 'unapproved') {
              record(dir, wf, 'plugins/engineer/a.mjs');
              await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 1;\n');
              sh(dir, 'git', ['add', '--', vendor]);
              const index = indexState(dir);
              const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects', '--confirm-non-interactive'));
              strictEqual(r.code, 1, `${variant}: ${r.stderr}`);
              ok(r.stderr.includes('unapproved pre-staged path(s)') && r.stderr.includes(`    ${vendor}`), r.stderr);
              strictEqual(sh(dir, 'git', ['rev-parse', 'HEAD']), head);
              strictEqual(indexState(dir), index);
            } else if (variant === 'approved') {
              record(dir, wf, vendor);
              const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'));
              strictEqual(r.code, 0, `${variant}: ${r.stderr}`);
              // nameStatus would hide the gitlink under the same setting.
              strictEqual(sh(dir, 'git', ['show', '--name-status', '--no-renames', '--ignore-submodules=none', '--format=', 'HEAD']), `M\t${vendor}`);
              strictEqual(sh(dir, 'git', ['rev-parse', `HEAD:${vendor}`]), sh(join(dir, vendor), 'git', ['rev-parse', 'HEAD']));
            } else if (variant === 'recovery') {
              record(dir, wf, vendor);
              sh(dir, 'git', ['add', '--', vendor]);
              sh(dir, 'git', ['commit', '-qm', `fix(runtime): move vendor\n\nWorkflow-ID: ${basename(wf, '.md')}`, '--no-verify']);
              const p = plan(dir, wf);
              deepStrictEqual([p.branch, p.no_changes.path, p.no_changes.missing_manifest], ['no-changes', 'recovery', []]);
            } else {
              record(dir, wf, vendor);
              sh(dir, 'git', ['add', '--', vendor]);
              execFileSync('git', [...ident, 'commit', '-q', '--allow-empty', '-m', 'three'], { cwd: join(dir, vendor) });
              const index = indexState(dir);
              const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'));
              strictEqual(r.code, 3, `${variant}: ${r.stderr}`);
              ok(r.stderr.includes('mixed-hunk paths detected') && r.stderr.includes(vendor), r.stderr);
              strictEqual(sh(dir, 'git', ['rev-parse', 'HEAD']), head);
              strictEqual(indexState(dir), index, `${variant}: the staged commit is kept`);
            }
          });
        } finally {
          await rm(src, { recursive: true, force: true });
        }
      }
    });

    // A sandbox with a submodule at plugins/runtime/vendor (one tracked file,
    // lib.c), its `ignore` set in .gitmodules when `ignore` is given, all
    // committed before the workflow starts. `fn` gets the sandbox, the
    // workflow, the submodule's directory and a function that commits in it.
    const VENDOR = 'plugins/runtime/vendor';
    async function withSubmodule(ignore, fn) {
      const ident = ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid'];
      const src = await mkdtemp(join(tmpdir(), 'engineer-commit-sub-'));
      try {
        execFileSync('git', ['init', '-q'], { cwd: src });
        await writeFile(join(src, 'lib.c'), 'int lib;\n');
        execFileSync('git', ['add', 'lib.c'], { cwd: src });
        execFileSync('git', [...ident, 'commit', '-q', '-m', 'one'], { cwd: src });
        await withRenames(async (dir) => {
          sh(dir, 'git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', src, VENDOR]);
          if (ignore) sh(dir, 'git', ['config', '-f', '.gitmodules', `submodule.${VENDOR}.ignore`, ignore]);
          sh(dir, 'git', ['add', '.gitmodules']);
          sh(dir, 'git', ['commit', '-qm', 'chore: vendor', '--no-verify']);
          const wf = createWorkflow(dir, { verb: 'refine', profile: '', request: 'move vendor' });
          const sub = join(dir, VENDOR);
          const move = () => execFileSync('git', [...ident, 'commit', '-q', '--allow-empty', '-m', 'moved'], { cwd: sub });
          await fn({ dir, wf, sub, move });
        });
      } finally {
        await rm(src, { recursive: true, force: true });
      }
    }
    // The commit a submodule has checked out, and the one HEAD records for it.
    const subHead = (sub) => sh(sub, 'git', ['rev-parse', 'HEAD']);
    const committedGitlink = (dir) => sh(dir, 'git', ['rev-parse', `HEAD:${VENDOR}`]);
    // Edits and an untracked file inside the submodule: dirt the superproject
    // cannot commit.
    const dirty = async (sub) => {
      await writeFile(join(sub, 'lib.c'), 'int lib = 1;\n');
      await writeFile(join(sub, 'build.out'), 'output\n');
    };

    // `ignore=all` in .gitmodules makes `git add <submodule>` skip the path
    // (exit 0) and `git status` hide it. One variant per site: the staging
    // ('approved', with a plain file beside it), its check ('unstaged': a
    // `git add --force` that stages nothing), the clean-after-commit gate
    // ('extra': a move left out of the commit; 'unreadable': a status read
    // that fails), and the close ('close': a
    // staged move the submodule has since checked out of, which the diff as
    // configured does not show).
    it('(z) a submodule set to ignore=all in .gitmodules: an approved move is committed, one left out is not clean', async () => {
      for (const variant of ['approved', 'unstaged', 'unreadable', 'extra', 'close']) {
        await withSubmodule('all', async ({ dir, wf, sub, move }) => {
          const head = sh(dir, 'git', ['rev-parse', 'HEAD']);
          move();
          if (variant === 'approved' || variant === 'unstaged' || variant === 'unreadable') {
            record(dir, wf, VENDOR);
            record(dir, wf, 'plugins/runtime/b.mjs');
            await writeFile(join(dir, 'plugins', 'runtime', 'b.mjs'), 'export const b = 1;\n');
            if (variant === 'approved') {
              const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'));
              strictEqual(r.code, 0, `${variant}: ${r.stderr}`);
              strictEqual(committedGitlink(dir), subHead(sub), `${variant}: the move is in the commit`);
              strictEqual(sh(dir, 'git', ['show', '--name-status', '--no-renames', '--ignore-submodules=none', '--format=', 'HEAD']), `M\tplugins/runtime/b.mjs\nM\t${VENDOR}`);
              strictEqual((await readWorkflow(wf)).frontmatter.terminal_marker, true, `${variant}: the workflow is done`);
            } else if (variant === 'unreadable') {
              // The gate's SUBMODULE_MOVES read fails, the configured one does
              // not: half of the union is no clean tree.
              const shim = await gitShim(dir, { before: 'case " $* " in *" status "*" --ignore-submodules=dirty "*) echo "fatal: injected" >&2; exit 128;; esac' });
              const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'), shim);
              strictEqual(r.code, 7, `${variant}: ${r.stderr}`);
              ok(r.stderr.includes("could not read the working tree's status after commit") && r.stderr.includes('fatal: injected'), r.stderr);
              strictEqual(committedGitlink(dir), subHead(sub), `${variant}: the commit landed`);
              notStrictEqual((await readWorkflow(wf)).frontmatter.terminal_marker, true, `${variant}: the workflow is not done`);
            } else {
              const shim = await gitShim(dir, { before: 'case " $* " in *" add --force "*) exit 0;; esac' });
              const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'), shim);
              strictEqual(r.code, 8, `${variant}: ${r.stderr}`);
              ok(r.stderr.includes('stage-failed') && r.stderr.includes(`left submodule(s) unstaged`) && r.stderr.includes(VENDOR), r.stderr);
              strictEqual(sh(dir, 'git', ['rev-parse', 'HEAD']), head);
            }
          } else if (variant === 'extra') {
            record(dir, wf, 'plugins/engineer/a.mjs');
            await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 1;\n');
            const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects', '--confirm-non-interactive'));
            strictEqual(r.code, 7, `${variant}: ${r.stderr}`);
            ok(r.stderr.includes('working tree is not clean after commit') && r.stderr.includes(VENDOR), r.stderr);
            notStrictEqual(committedGitlink(dir), subHead(sub), `${variant}: the move was left out`);
            notStrictEqual((await readWorkflow(wf)).frontmatter.terminal_marker, true, `${variant}: the workflow is not done`);
          } else {
            sh(dir, 'git', ['add', '--force', '--', VENDOR]);
            execFileSync('git', ['checkout', '-q', 'HEAD~1'], { cwd: sub });
            nextStep(dir, wf, 'done');
            const r = run(dir, PHASE7_BIN, closeArgs(dir, wf));
            strictEqual(r.code, 1, `${variant}: ${r.stderr}`);
            ok(r.stderr.includes(`close-refused: the working tree has 1 path(s) to commit (${VENDOR})`), r.stderr);
            notStrictEqual((await readWorkflow(wf)).frontmatter.terminal_marker, true, `${variant}: the workflow is not closed`);
          }
        });
      }
    });

    // A submodule's dirt is work the superproject cannot commit. Under
    // `ignore=dirty` it is no change, no mixed hunk and no unclean tree
    // ('execute', 'approved', 'close'); with no setting it still counts, as
    // the user's git shows it ('default extra': it is an extra to confirm;
    // 'default approved': the move lands and the gate reports the dirt left).
    it('(z2) a submodule\'s dirt counts as the user\'s ignore setting says, a move whatever it says', async () => {
      for (const variant of ['execute', 'approved', 'close', 'default extra', 'default approved']) {
        await withSubmodule(variant.startsWith('default') ? null : 'dirty', async ({ dir, wf, sub, move }) => {
          const before = committedGitlink(dir);
          if (variant === 'execute' || variant === 'default extra') {
            record(dir, wf, 'plugins/engineer/a.mjs');
            await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 1;\n');
            await dirty(sub);
            const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'));
            if (variant === 'execute') {
              strictEqual(r.code, 0, `${variant}: ${r.stderr}`);
              strictEqual(nameStatus(dir, 'HEAD'), 'M\tplugins/engineer/a.mjs');
            } else {
              strictEqual(r.code, 1, `${variant}: ${r.stderr}`);
              ok(r.stderr.includes('ask-user-required'), r.stderr);
            }
            strictEqual(committedGitlink(dir), before);
          } else if (variant === 'close') {
            await dirty(sub);
            nextStep(dir, wf, 'done');
            const r = run(dir, PHASE7_BIN, closeArgs(dir, wf));
            strictEqual(r.code, 0, `${variant}: ${r.stderr}`);
          } else {
            move();
            sh(dir, 'git', ['add', '--', VENDOR]);
            await dirty(sub);
            record(dir, wf, VENDOR);
            const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'));
            strictEqual(committedGitlink(dir), subHead(sub), `${variant}: the move is in the commit`);
            if (variant === 'approved') {
              strictEqual(r.code, 0, `${variant}: ${r.stderr}`);
            } else {
              strictEqual(r.code, 7, `${variant}: ${r.stderr}`);
              ok(r.stderr.includes('working tree is not clean after commit') && r.stderr.includes(VENDOR), r.stderr);
            }
          }
        });
      }
    });
  });

  describeDispatchOn(`${persona}: autopilot cannot bypass the staging-set confirmation (ADR-0063 D4)`, () => {
    const AP = { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID };

    it('refuses every bypass flag and ACCEPT_CURRENT_TREE=1 in execute, writing and committing nothing', async () => {
      await withSandbox(async (dir) => {
        const wf = createWorkflow(dir);
        record(dir, wf, 'README.md');
        await writeFile(join(dir, 'README.md'), '# sandbox\nx\n');
        await writeFile(join(dir, 'extra.md'), 'extra\n');
        strictEqual(plan(dir, wf).ask_user, true, 'manifest-subset-of-git needs the owner');
        const head = sh(dir, 'git', ['rev-parse', 'HEAD']);
        const before = await readFile(wf, 'utf8');
        for (const [extra, envExtra, named] of [
          [['--confirm-non-interactive'], {}, '--confirm-non-interactive'],
          [['--non-interactive'], {}, '--non-interactive'],
          [['--accept-current-tree'], {}, '--accept-current-tree'],
          [['--include-extra', 'extra.md'], {}, '--include-extra'],
          [[], { ACCEPT_CURRENT_TREE: '1' }, 'ACCEPT_CURRENT_TREE=1'],
        ]) {
          const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects', ...extra), { ...AP, ...envExtra });
          strictEqual(r.code, 2, `${named}: ${r.stderr}`);
          ok(r.stderr.includes(`refused under autopilot`) && r.stderr.includes(named), r.stderr);
        }
        // Without a bypass flag, execute itself is refused under autopilot: the
        // step is --mode autopilot, which holds the staging rules (round-2 #3).
        const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'), AP);
        strictEqual(r.code, 2);
        ok(r.stderr.includes('--mode execute is refused under an autopilot run'), r.stderr);
        // Interactively the ask_user staging set still refuses, as today.
        const i = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'));
        strictEqual(i.code, 1);
        ok(i.stderr.includes('ask-user-required'), i.stderr);
        strictEqual(sh(dir, 'git', ['rev-parse', 'HEAD']), head);
        strictEqual(await readFile(wf, 'utf8'), before);
      });
    });

    it('refuses a bypass in plan mode too, and allows the same flags interactively', async () => {
      await withSandbox(async (dir) => {
        const wf = createWorkflow(dir);
        await writeFile(join(dir, 'README.md'), '# sandbox\nx\n');
        let r = run(dir, PHASE7_BIN, ['--mode', 'plan', '--workflow-path', wf, '--repo-root', dir, '--host', 'claude', '--accept-current-tree'], AP);
        strictEqual(r.code, 2, r.stderr);
        r = run(dir, PHASE7_BIN, ['--mode', 'plan', '--workflow-path', wf, '--repo-root', dir, '--host', 'claude'], { ...AP, ACCEPT_CURRENT_TREE: '1' });
        strictEqual(r.code, 2, r.stderr);
        r = run(dir, PHASE7_BIN, ['--mode', 'plan', '--workflow-path', wf, '--repo-root', dir, '--host', 'claude', '--accept-current-tree']);
        strictEqual(r.code, 0, r.stderr);
        strictEqual(JSON.parse(r.stdout).branch, 'accept-current-tree');
        r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--subject', 'docs: interactive sweep', '--accept-current-tree'));
        strictEqual(r.code, 0, r.stderr);
      });
    });
  });

  describe(`${persona}: --mode close — the no-changes close (ADR-0063)`, () => {
    async function macroWithSubtask(dir) {
      const macroPath = sh(dir, 'node', [ORCH_STATE, 'create', '--repo-root', dir, '--verb', 'plan', '--host', 'claude',
        '--git-baseline-branch', 'main', '--git-baseline-head', sh(dir, 'git', ['rev-parse', 'HEAD']), '--original-request', 'close parent']);
      const subtasks = join(dir, '.agentic-plugins', 'state', 'subtasks.json');
      await writeFile(subtasks, JSON.stringify([{ id: 'T1', verb: 'investigate', branch: 'feat/s', blocked_by: [], status: 'in_progress' }]));
      sh(dir, 'node', [ORCH_STATE, 'plan-set', '--workflow-path', macroPath, '--host', 'claude', '--subtasks-json-file', subtasks]);
      return { macroPath, macroId: basename(macroPath, '.md') };
    }

    itDispatchOn('writes close-complete + the terminal marker, archives, and names /orchestrator:done --no-commit', async () => {
      await withSandbox(async (dir) => {
        const { macroPath, macroId } = await macroWithSubtask(dir);
        const macroBefore = await readFile(macroPath, 'utf8');
        const wf = createWorkflow(dir, { verb: 'investigate', profile: '', parent: { macroId, subtask: 'T1' } });
        nextStep(dir, wf, 'done');
        const head = sh(dir, 'git', ['rev-parse', 'HEAD']);
        // Under autopilot close runs only inside --mode autopilot.
        const refused = run(dir, PHASE7_BIN, closeArgs(dir, wf), { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID });
        strictEqual(refused.code, 2, refused.stderr);
        ok(refused.stderr.includes('--mode close is refused under an autopilot run'), refused.stderr);
        const r = run(dir, PHASE7_BIN, closeArgs(dir, wf));
        strictEqual(r.code, 0, r.stderr);
        const out = JSON.parse(r.stdout);
        deepStrictEqual([out.ok, out.closed, out.parent_linked, out.next], [true, true, true, '/orchestrator:done T1 --no-commit']);
        strictEqual(await exists(wf), false, 'the live file moved');
        ok(out.archived_to.endsWith(`/archive/${basename(wf)}`), out.archived_to);
        const fm = (await readWorkflow(out.archived_to)).frontmatter;
        deepStrictEqual([fm.current_phase, fm.terminal_marker, fm.next_step_kind], ['close-complete', true, 'done']);
        ok(fm.next_action.includes('/orchestrator:done T1 --no-commit'), fm.next_action);
        strictEqual(sh(dir, 'git', ['rev-parse', 'HEAD']), head, 'no commit');
        strictEqual(await readFile(macroPath, 'utf8'), macroBefore, 'no parent note: there is no commit to note');
      });
    });

    it('an unlinked workflow closes to "archive"', async () => {
      await withSandbox(async (dir) => {
        const wf = createWorkflow(dir, { verb: 'frame', profile: '' });
        nextStep(dir, wf, 'done');
        const r = run(dir, PHASE7_BIN, closeArgs(dir, wf));
        strictEqual(r.code, 0, r.stderr);
        const out = JSON.parse(r.stdout);
        deepStrictEqual([out.parent_linked, out.next], [false, null]);
        strictEqual((await readWorkflow(out.archived_to)).frontmatter.next_action, 'archive');
      });
    });

    it('refuses with changes to commit, a not-done next step, a pending ensemble — writing nothing', async () => {
      await withSandbox(async (dir) => {
        const wf = createWorkflow(dir);
        const snapshot = () => readFile(wf, 'utf8');
        let before = await snapshot();
        let r = run(dir, PHASE7_BIN, closeArgs(dir, wf));
        strictEqual(r.code, 1);
        ok(r.stderr.includes('close-refused: blocked/next-step-not-done'), r.stderr);
        strictEqual(await snapshot(), before);

        nextStep(dir, wf, 'done');
        await writeFile(join(dir, 'README.md'), '# sandbox\nleft over\n');
        before = await snapshot();
        r = run(dir, PHASE7_BIN, closeArgs(dir, wf));
        strictEqual(r.code, 1);
        ok(r.stderr.includes('close-refused: the working tree has 1 path(s) to commit (README.md)'), r.stderr);
        strictEqual(await snapshot(), before);

        sh(dir, 'git', ['checkout', '--', 'README.md']);
        sh(dir, 'node', [STATE_BIN, 'ensemble-pending', '--workflow-path', wf, '--phase', 'investigate', '--ensemble-type', 'explore', '--run-id', 'ex-1']);
        before = await snapshot();
        r = run(dir, PHASE7_BIN, closeArgs(dir, wf));
        strictEqual(r.code, 5, r.stderr);
        strictEqual(await snapshot(), before);
      });
    });

    itDispatchOn('refuses a bypass flag under autopilot like execute', async () => {
      await withSandbox(async (dir) => {
        const wf = createWorkflow(dir);
        nextStep(dir, wf, 'done');
        const r = run(dir, PHASE7_BIN, [...closeArgs(dir, wf), '--confirm-non-interactive'], { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID });
        strictEqual(r.code, 2, r.stderr);
        ok(await exists(wf));
      });
    });
  });

  describeDispatchOn(`${persona}: --mode autopilot — /engineer:commit under an autopilot run (ADR-0063)`, () => {
    const AP = { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID };
    const autoArgs = (dir, wf, ...extra) => ['--mode', 'autopilot', '--workflow-path', wf, '--repo-root', dir, '--host', 'claude', ...extra];

    it('refuses outside an autopilot run, writing nothing', async () => {
      await withSandbox(async (dir) => {
        const wf = createWorkflow(dir);
        record(dir, wf, 'README.md');
        await writeFile(join(dir, 'README.md'), '# sandbox\nx\n');
        const before = await readFile(wf, 'utf8');
        for (const extra of [{}, { AGENTIC_AUTOPILOT: 'autopilot-bad' }]) {
          const r = run(dir, PHASE7_BIN, autoArgs(dir, wf), extra);
          strictEqual(r.code, 2, r.stderr);
          ok(r.stderr.includes('--mode autopilot runs only under an autopilot run'), r.stderr);
        }
        strictEqual(await readFile(wf, 'utf8'), before);
      });
    });

    it('commits a manifest-covered change with the suggested subject and terminalizes', async () => {
      await withSandbox(async (dir) => {
        const wf = createWorkflow(dir, { request: 'wire the thing' });
        nextStep(dir, wf, 'commit');
        record(dir, wf, 'plugins/engineer/a.mjs');
        await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 9;\n');
        const r = run(dir, PHASE7_BIN, autoArgs(dir, wf), AP);
        strictEqual(r.code, 0, r.stderr);
        const out = JSON.parse(r.stdout);
        deepStrictEqual([out.ok, out.action], [true, 'committed']);
        strictEqual(sh(dir, 'git', ['log', '-1', '--format=%s']), 'feat(engineer): wire the thing');
        const fm = (await readWorkflow(wf)).frontmatter;
        deepStrictEqual([fm.current_phase, fm.terminal_marker], ['commit-complete', true]);
        // The next step is left as it was: `done` would read as the no-commit close.
        strictEqual(fm.next_step_kind, 'commit');
        strictEqual(fm.awaiting_owner_gate, undefined, 'a routine commit sets no gate (waiting to land is not pr-handling)');
      });
    });

    it('stops at the staging-set gate when the set needs the owner, committing nothing', async () => {
      await withSandbox(async (dir) => {
        const wf = createWorkflow(dir);
        nextStep(dir, wf, 'commit');
        record(dir, wf, 'README.md');
        await writeFile(join(dir, 'README.md'), '# sandbox\nx\n');
        await writeFile(join(dir, 'stray.md'), 'not in the manifest\n');
        const head = sh(dir, 'git', ['rev-parse', 'HEAD']);
        const r = run(dir, PHASE7_BIN, autoArgs(dir, wf), AP);
        strictEqual(r.code, 0, r.stderr);
        const out = JSON.parse(r.stdout);
        deepStrictEqual([out.action, out.gate, out.staging_set, out.extras], ['staging-set', 'staging-set', ['README.md'], ['stray.md']]);
        strictEqual(sh(dir, 'git', ['rev-parse', 'HEAD']), head);
        const { frontmatter: fm, body } = await readWorkflow(wf);
        strictEqual(fm.awaiting_owner_gate, 'staging-set');
        strictEqual(fm.awaiting_owner_pointer, `${P.workflowDirRel}/${basename(wf)}#phase7-plan`);
        deepStrictEqual([fm.next_step_kind, fm.next_step_confidence], ['owner-decision', 'HIGH']);
        ok(fm.terminal_marker !== true);
        ok(body.includes('### Phase 7 plan\n'), body);
        ok(body.includes('- stray.md'), body);
        // A second autopilot step on it is refused, by the preflight and by the
        // mode itself: the gate stays until the owner confirms.
        const pre = run(dir, STATE_BIN, ['autopilot-preflight', '--workflow-path', wf], AP);
        strictEqual(pre.code, 1, pre.stderr);
        const before = await readFile(wf, 'utf8');
        const again = run(dir, PHASE7_BIN, autoArgs(dir, wf), AP);
        strictEqual(again.code, 1, again.stderr);
        ok(again.stderr.includes('owner gate staging-set is set'), again.stderr);
        strictEqual(await readFile(wf, 'utf8'), before);
        strictEqual(sh(dir, 'git', ['rev-parse', 'HEAD']), head);
      });
    });

    it('closes a done workflow with nothing to commit, and recovers an interrupted commit', async () => {
      await withSandbox(async (dir) => {
        const closing = createWorkflow(dir, { verb: 'investigate', profile: '' });
        nextStep(dir, closing, 'done');
        let r = run(dir, PHASE7_BIN, autoArgs(dir, closing), AP);
        strictEqual(r.code, 0, r.stderr);
        let out = JSON.parse(r.stdout);
        deepStrictEqual([out.action, out.closed], ['closed', true]);
        strictEqual((await readWorkflow(out.archived_to)).frontmatter.current_phase, 'close-complete');

        const wf = createWorkflow(dir);
        nextStep(dir, wf, 'commit');
        record(dir, wf, 'README.md');
        await writeFile(join(dir, 'README.md'), '# sandbox\nrecover\n');
        sh(dir, 'node', [STATE_BIN, 'ensemble-pending', '--workflow-path', wf, '--phase', 'compose', '--ensemble-type', 'plan-verify', '--run-id', 'pv-9']);
        // Autopilot refuses before committing while the ensemble is pending ...
        const head = sh(dir, 'git', ['rev-parse', 'HEAD']);
        r = run(dir, PHASE7_BIN, autoArgs(dir, wf), AP);
        strictEqual(r.code, 5, r.stderr);
        strictEqual(sh(dir, 'git', ['rev-parse', 'HEAD']), head, 'nothing committed');
        // ... so interrupt a commit the interactive way, then let autopilot finish it.
        strictEqual(run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects')).code, 5);
        sh(dir, 'node', [STATE_BIN, 'ensemble-commit', '--workflow-path', wf, '--host', 'claude', '--phase', 'compose', '--ensemble-type', 'plan-verify', '--run-id', 'pv-9', '--verdict', 'agree', '--summary', 's']);
        const landed = sh(dir, 'git', ['rev-parse', 'HEAD']);
        r = run(dir, PHASE7_BIN, autoArgs(dir, wf), AP);
        strictEqual(r.code, 0, r.stderr);
        out = JSON.parse(r.stdout);
        deepStrictEqual([out.action, out.ok], ['recovered', true]);
        strictEqual(sh(dir, 'git', ['rev-parse', 'HEAD']), landed, 'no second commit');
        strictEqual((await readWorkflow(wf)).frontmatter.current_phase, 'commit-complete');
      });
    });

    it('refuses a blocked clean tree, writing nothing', async () => {
      await withSandbox(async (dir) => {
        const wf = createWorkflow(dir);
        nextStep(dir, wf, 'commit');
        const before = await readFile(wf, 'utf8');
        const r = run(dir, PHASE7_BIN, autoArgs(dir, wf), AP);
        strictEqual(r.code, 1, r.stderr);
        ok(r.stderr.includes('blocked/next-step-not-done'), r.stderr);
        strictEqual(await readFile(wf, 'utf8'), before);
      });
    });
  });

  describe(`${persona}: committing never runs terminal, and never crosses an owner gate (ADR-0063, Plan-verify G1/R-c)`, () => {
    it('an interactive verb\'s terminal marker does not survive into a split that fails halfway: Stop does not archive it', async () => {
      await withSandbox(async (dir) => {
        const wf = createWorkflow(dir, { verb: 'refine', profile: '', request: 'split fix' });
        record(dir, wf, 'plugins/engineer/a.mjs');
        record(dir, wf, 'plugins/runtime/b.mjs');
        await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 5;\n');
        await writeFile(join(dir, 'plugins', 'runtime', 'b.mjs'), 'export const b = 5;\n');
        // The verb ended interactively: summary-complete with the marker.
        sh(dir, 'node', [STATE_BIN, 'finish-verb', '--workflow-path', wf, '--host', 'claude', '--next-action', 'commit',
          '--next-step-kind', 'commit', '--next-step-confidence', 'HIGH']);
        strictEqual((await readWorkflow(wf)).frontmatter.terminal_marker, true);
        const hook = join(dir, '.git', 'hooks', 'pre-commit');
        await writeFile(hook, '#!/bin/sh\nif git diff --cached --name-only | grep -q "^plugins/runtime/"; then exit 1; fi\n');
        await chmod(hook, 0o755);
        const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'));
        strictEqual(r.code, 4, r.stderr);
        const fm = (await readWorkflow(wf)).frontmatter;
        deepStrictEqual([fm.current_phase, fm.terminal_marker], ['phase-7-commit', false]);
        const headSha = sh(dir, 'git', ['rev-parse', 'HEAD']);
        const stop = await runStopArchive({ workflowPath: wf, host: 'claude', repoRoot: dir, headSha, stderr: { write() {} } });
        strictEqual(stop.archived, false);
        ok(stop.gateFailures.includes('terminal_marker'), JSON.stringify(stop));
        ok(await exists(wf), 'the half-committed workflow stays active');
      });
    });

    it('a bad subject flag leaves the workflow exactly as it was', async () => {
      await withSandbox(async (dir) => {
        const wf = createWorkflow(dir);
        record(dir, wf, 'README.md');
        await writeFile(join(dir, 'README.md'), '# sandbox\nx\n');
        const before = await readFile(wf, 'utf8');
        const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--subject', 'not conventional', '--strict-cc'));
        strictEqual(r.code, 1, r.stderr);
        strictEqual(await readFile(wf, 'utf8'), before);
      });
    });

    it('execute and close refuse while an owner gate is set, in both modes, writing nothing', async () => {
      await withSandbox(async (dir) => {
        const wf = createWorkflow(dir);
        record(dir, wf, 'README.md');
        await writeFile(join(dir, 'README.md'), '# sandbox\nx\n');
        sh(dir, 'node', [STATE_BIN, 'awaiting-owner-set', '--workflow-path', wf, '--host', 'claude', '--gate', 'recurring-finding', '--anchor', 'recurring-finding']);
        const before = await readFile(wf, 'utf8');
        const head = sh(dir, 'git', ['rev-parse', 'HEAD']);
        let r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects'));
        strictEqual(r.code, 1, r.stderr);
        ok(r.stderr.includes('owner-gate: recurring-finding is set'), r.stderr);
        r = run(dir, PHASE7_BIN, closeArgs(dir, wf));
        strictEqual(r.code, 1, r.stderr);
        ok(r.stderr.includes('owner-gate: recurring-finding is set'), r.stderr);
        // Under autopilot both are refused before they read the gate, and
        // --mode autopilot refuses over it.
        for (const args of [execArgs(dir, wf, '--suggested-subjects'), closeArgs(dir, wf)]) {
          strictEqual(run(dir, PHASE7_BIN, args, { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID }).code, 2);
        }
        r = run(dir, PHASE7_BIN, ['--mode', 'autopilot', '--workflow-path', wf, '--repo-root', dir, '--host', 'claude'], { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID });
        strictEqual(r.code, 1, r.stderr);
        ok(r.stderr.includes('owner gate recurring-finding is set'), r.stderr);
        strictEqual(await readFile(wf, 'utf8'), before);
        strictEqual(sh(dir, 'git', ['rev-parse', 'HEAD']), head);
      });
    });

    it('close refuses over an owner gate even when everything else allows the close', async () => {
      await withSandbox(async (dir) => {
        const wf = createWorkflow(dir, { verb: 'frame', profile: '' });
        nextStep(dir, wf, 'done');
        strictEqual(plan(dir, wf).no_changes.path, 'close', 'without the gate this would close');
        sh(dir, 'node', [STATE_BIN, 'awaiting-owner-set', '--workflow-path', wf, '--host', 'claude', '--gate', 'scope-routing', '--anchor', 'routing-recommendation']);
        const before = await readFile(wf, 'utf8');
        const r = run(dir, PHASE7_BIN, closeArgs(dir, wf));
        strictEqual(r.code, 1, r.stderr);
        ok(r.stderr.includes('owner-gate: scope-routing is set'), r.stderr);
        strictEqual(await readFile(wf, 'utf8'), before);
      });
    });

    it('Stop never archives a workflow with an owner gate pending (gate 5)', () => {
      const base = {
        terminal_marker: true, current_phase: 'summary-complete',
        git_baseline: { head: 'a'.repeat(40) },
      };
      strictEqual(evaluateStopArchive({ frontmatter: base, headSha: 'b'.repeat(40), headSubject: 'feat: x' }).shouldArchive, true);
      const v = evaluateStopArchive({
        frontmatter: { ...base, awaiting_owner_gate: 'decide-conflict', awaiting_owner_since: '2026-09-30T00:00:00Z', awaiting_owner_pointer: 'a.md#b' },
        headSha: 'b'.repeat(40), headSubject: 'feat: x',
      });
      deepStrictEqual([v.shouldArchive, v.gateFailures], [false, ['awaiting_owner']]);
    });

    itDispatchOn('close writes no handoff projection (it would advise a commit), and Stop sends no parent note for close-complete', async () => {
      await withSandbox(async (dir) => {
        const macroPath = sh(dir, 'node', [ORCH_STATE, 'create', '--repo-root', dir, '--verb', 'plan', '--host', 'claude',
          '--git-baseline-branch', 'main', '--git-baseline-head', sh(dir, 'git', ['rev-parse', 'HEAD']), '--original-request', 'p']);
        const subtasks = join(dir, '.agentic-plugins', 'state', 'subtasks.json');
        await writeFile(subtasks, JSON.stringify([{ id: 'T1', verb: 'frame', branch: 'feat/s', blocked_by: [], status: 'in_progress' }]));
        sh(dir, 'node', [ORCH_STATE, 'plan-set', '--workflow-path', macroPath, '--host', 'claude', '--subtasks-json-file', subtasks]);
        const wf = createWorkflow(dir, { verb: 'frame', profile: '', parent: { macroId: basename(macroPath, '.md'), subtask: 'T1' } });
        nextStep(dir, wf, 'done');
        const r = run(dir, PHASE7_BIN, closeArgs(dir, wf));
        strictEqual(r.code, 0, r.stderr);
        strictEqual(await exists(join(dir, P.stateDirRel, 'last-session-handoff.json')), false);
        // A close-complete workflow that a crash left active, with HEAD moved
        // by someone else: Stop may archive it, but notes no commit.
        const wf2 = createWorkflow(dir, { verb: 'frame', profile: '', parent: { macroId: basename(macroPath, '.md'), subtask: 'T1' } });
        sh(dir, 'node', [STATE_BIN, 'set-terminal', '--workflow-path', wf2, '--host', 'claude', '--terminal-phase', 'close-complete']);
        await writeFile(join(dir, 'README.md'), '# sandbox\nsomeone\n');
        sh(dir, 'git', ['commit', '-qam', 'docs: someone else']);
        const before = await readFile(macroPath, 'utf8');
        const stop = await runStopArchive({ workflowPath: wf2, host: 'claude', repoRoot: dir,
          headSha: sh(dir, 'git', ['rev-parse', 'HEAD']), headSubject: 'docs: someone else', stderr: { write() {} } });
        strictEqual(stop.archived, true);
        strictEqual(await readFile(macroPath, 'utf8'), before, 'no engineer-terminal note for a close');
      });
    });

    itDispatchOn('autopilot stops at the staging-set gate when the workflow began on a dirty tree, or the index is pre-staged', async () => {
      await withSandbox(async (dir) => {
        await writeFile(join(dir, 'scratch.txt'), 'the owner\'s own change\n');
        const wf = createWorkflow(dir);
        strictEqual((await readWorkflow(wf)).frontmatter.git_baseline.status_digest === EMPTY_DIGEST, false);
        nextStep(dir, wf, 'commit');
        record(dir, wf, 'README.md');
        await writeFile(join(dir, 'README.md'), '# sandbox\ny\n');
        await rm(join(dir, 'scratch.txt'));
        strictEqual(plan(dir, wf).ask_user, false, 'the plan alone would commit it');
        let r = run(dir, PHASE7_BIN, ['--mode', 'autopilot', '--workflow-path', wf, '--repo-root', dir, '--host', 'claude'], { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID });
        strictEqual(r.code, 0, r.stderr);
        strictEqual(JSON.parse(r.stdout).action, 'staging-set');
        ok((await readWorkflow(wf)).body.includes('did not begin on a clean working tree'));

        const wf2dir = dir;
        sh(wf2dir, 'git', ['stash', '-u', '-q']);
        sh(wf2dir, 'node', [STATE_BIN, 'archive', '--workflow-path', wf, '--host', 'claude', '--repo-root', dir]);
        const clean = createWorkflow(dir);
        nextStep(dir, clean, 'commit');
        record(dir, clean, 'README.md');
        await writeFile(join(dir, 'README.md'), '# sandbox\nz\n');
        sh(dir, 'git', ['add', 'README.md']);
        r = run(dir, PHASE7_BIN, ['--mode', 'autopilot', '--workflow-path', clean, '--repo-root', dir, '--host', 'claude'], { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID });
        strictEqual(r.code, 0, r.stderr);
        strictEqual(JSON.parse(r.stdout).action, 'staging-set');
        ok((await readWorkflow(clean)).body.includes('the index already holds staged changes (README.md)'));
      });
    });
  });

  describeDispatchOn(`${persona}: Stop archive over an autopilot verb chain (spec §1.9)`, () => {
    it('does not archive after a commit a verb made, and archives after /engineer:commit', async () => {
      await withSandbox(async (dir) => {
        const AP = { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID };
        const wf = createWorkflow(dir, { request: 'chain' });
        record(dir, wf, 'plugins/engineer/a.mjs');
        await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 7;\n');
        // The verb ends under autopilot: next step recorded, no terminal marker.
        let r = run(dir, STATE_BIN, ['finish-verb', '--workflow-path', wf, '--host', 'claude', '--next-action', 'commit',
          '--next-step-kind', 'commit', '--next-step-confidence', 'HIGH'], AP);
        strictEqual(r.code, 0, r.stderr);
        // A commit the verb should not have made (the driver denies it; here it slips through).
        await writeFile(join(dir, 'README.md'), '# sandbox\nverb commit\n');
        sh(dir, 'git', ['commit', '-qm', 'chore: a verb committed', '--', 'README.md']);
        let stop = await runStopArchive({ workflowPath: wf, host: 'claude', repoRoot: dir,
          headSha: sh(dir, 'git', ['rev-parse', 'HEAD']), headSubject: 'chore: a verb committed', stderr: { write() {} } });
        deepStrictEqual([stop.archived, stop.gateFailures.includes('terminal_marker')], [false, true]);
        // /engineer:commit commits the workflow's own change; now Stop archives it.
        r = run(dir, PHASE7_BIN, ['--mode', 'autopilot', '--workflow-path', wf, '--repo-root', dir, '--host', 'claude'], AP);
        strictEqual(r.code, 0, r.stderr);
        strictEqual(JSON.parse(r.stdout).action, 'committed');
        stop = await runStopArchive({ workflowPath: wf, host: 'claude', repoRoot: dir,
          headSha: sh(dir, 'git', ['rev-parse', 'HEAD']), headSubject: sh(dir, 'git', ['log', '-1', '--format=%s']), stderr: { write() {} } });
        strictEqual(stop.archived, true, JSON.stringify(stop));
      });
    });
  });

  describe(`${persona}: round-2 review regressions (ADR-0063 S3+S4)`, () => {
    const AP = { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID };
    const autoArgs = (dir, wf) => ['--mode', 'autopilot', '--workflow-path', wf, '--repo-root', dir, '--host', 'claude'];

    it('#1 the staging-set gate turns an inherited terminal marker off, so a later refusal cannot be archived', async () => {
      await withSandbox(async (dir) => {
        const wf = createWorkflow(dir);
        record(dir, wf, 'README.md');
        await writeFile(join(dir, 'README.md'), '# sandbox\nx\n');
        await writeFile(join(dir, 'stray.md'), 'x\n');
        sh(dir, 'node', [STATE_BIN, 'finish-verb', '--workflow-path', wf, '--host', 'claude', '--next-action', 'commit',
          '--next-step-kind', 'commit', '--next-step-confidence', 'HIGH']);
        strictEqual((await readWorkflow(wf)).frontmatter.terminal_marker, true);
        const r = run(dir, PHASE7_BIN, autoArgs(dir, wf), AP);
        strictEqual(r.code, 0, r.stderr);
        strictEqual(JSON.parse(r.stdout).action, 'staging-set');
        const fm = (await readWorkflow(wf)).frontmatter;
        deepStrictEqual([fm.awaiting_owner_gate, fm.terminal_marker], ['staging-set', false]);
      });
    });

    it('#2 a rename into workflow storage is a deletion outside it: not a clean tree, and no close', async () => {
      await withSandbox(async (dir) => {
        const wf = createWorkflow(dir, { verb: 'investigate', profile: '' });
        nextStep(dir, wf, 'done');
        await mkdir(join(dir, P.stateDirRel), { recursive: true });
        sh(dir, 'git', ['mv', '-f', 'README.md', `${P.stateDirRel}/saved.md`]);
        const status = execFileSync('git', ['status', '--porcelain=v1'], { cwd: dir, encoding: 'utf8' });
        ok(status.split('\n').includes(`R  README.md -> ${P.stateDirRel}/saved.md`), status);
        // The change list counts a rename's two endpoints (C90), so the
        // deletion outside workflow storage is a change to commit ...
        const p = plan(dir, wf);
        deepStrictEqual([p.branch, p.git_changes, p.no_changes], ['empty-manifest', ['README.md'], null]);
        // ... and the clean-tree classifier, which reads git status, refuses
        // it on its own.
        const { classifyNoChanges } = await import(pathToFileURL(PHASE7_BIN).href);
        const c = classifyNoChanges({ repoRoot: dir, frontmatter: (await readWorkflow(wf)).frontmatter, manifestPaths: [] });
        deepStrictEqual([c.path, c.reason, c.status_paths], ['blocked', 'status-not-clean', ['README.md']]);
        const r = run(dir, PHASE7_BIN, closeArgs(dir, wf));
        strictEqual(r.code, 1, r.stderr);
        ok(r.stderr.includes('close-refused: the working tree has 1 path(s) to commit (README.md)'), r.stderr);
        ok(await exists(wf));
      });
    });

    itDispatchOn('#3 under autopilot a direct execute cannot step around the clean-baseline rule', async () => {
      await withSandbox(async (dir) => {
        await writeFile(join(dir, 'README.md'), '# sandbox\nthe owner\'s edit\n');
        const wf = createWorkflow(dir);
        record(dir, wf, 'README.md');
        await writeFile(join(dir, 'README.md'), '# sandbox\nthe owner\'s edit\nand the workflow\'s\n');
        const head = sh(dir, 'git', ['rev-parse', 'HEAD']);
        const r = run(dir, PHASE7_BIN, execArgs(dir, wf, '--suggested-subjects', '--strict-cc'), AP);
        strictEqual(r.code, 2, r.stderr);
        strictEqual(sh(dir, 'git', ['rev-parse', 'HEAD']), head, 'nothing committed');
      });
    });

    it('#4 the orphan sweep keeps a workflow whose branch is gone while an owner gate is pending', async () => {
      const { runStopArchiveOrphanSweep } = await import(pathToFileURL(STOP_ARCHIVE).href);
      await withSandbox(async (dir) => {
        sh(dir, 'git', ['branch', 'gone-a']);
        sh(dir, 'git', ['branch', 'gone-b']);
        const mk = (branch) => sh(dir, 'node', [STATE_BIN, 'create', '--repo-root', dir, '--verb', 'decide', '--host', 'claude',
          '--git-baseline-branch', branch, '--git-baseline-head', sh(dir, 'git', ['rev-parse', 'HEAD']), '--original-request', branch]);
        const gated = mk('gone-a');
        const plain = mk('gone-b');
        for (const wf of [gated, plain]) {
          sh(dir, 'node', [STATE_BIN, 'set-terminal', '--workflow-path', wf, '--host', 'claude', '--terminal-phase', 'summary-complete']);
        }
        // A gate recorded directly on the file (the CLI would turn the marker off).
        const text = await readFile(gated, 'utf8');
        await writeFile(gated, text.replace('\n---\n', '\nawaiting_owner_gate: "scope-routing"\nawaiting_owner_since: "2026-09-30T00:00:00Z"\nawaiting_owner_pointer: "a.md#b"\n---\n'));
        strictEqual((await readWorkflow(gated)).frontmatter.awaiting_owner_gate, 'scope-routing');
        sh(dir, 'git', ['branch', '-D', 'gone-a']);
        sh(dir, 'git', ['branch', '-D', 'gone-b']);
        const results = await runStopArchiveOrphanSweep({ repoRoot: dir, host: 'claude', stderr: { write() {} } });
        ok(await exists(gated), 'the gated workflow stays');
        strictEqual(await exists(plain), false, 'control: the ungated one is swept');
        ok(results.every((x) => x.workflowPath !== gated), JSON.stringify(results));
      });
    });
  });

  // The driver applies state.mjs's activation rule (ADR-0066 Decision 3): a
  // named run is autopilot only on Claude with dispatch_target on. Elsewhere
  // the run is ignored and the driver is interactive, as state reports it.
  describe(`${persona}: the commit driver's autopilot activation matches state's (ADR-0066 Decision 3)`, () => {
    const AP = { AGENTIC_AUTOPILOT: AUTOPILOT_RUN_ID };

    // A copy of the generated plugin whose declaration has dispatch_target
    // set as given; the generated code reads its own declaration.
    async function pluginWith(dispatchTarget) {
      const parent = await mkdtemp(join(tmpdir(), 'commit-decl-'));
      const root = join(parent, persona);
      await cp(P.root, root, { recursive: true });
      const decl = JSON.parse(await readFile(join(root, 'persona.json'), 'utf8'));
      decl.capabilities.dispatch_target = dispatchTarget;
      await writeFile(join(root, 'persona.json'), JSON.stringify(decl, null, 2));
      return { root, cleanup: () => rm(parent, { recursive: true, force: true }) };
    }

    const cases = [
      ['on Codex', P.capabilities.dispatch_target, 'codex', /autopilot mode is Claude-only/],
      ['with dispatch_target off', false, 'claude', /not an autopilot dispatch target \(dispatch_target off/],
    ];
    for (const [label, dispatchTarget, host, reason] of cases) {
      it(`${label}: --mode autopilot is refused with the reason, and execute and close run interactively`, async () => {
        const { root, cleanup } = await pluginWith(dispatchTarget);
        const bin = join(root, 'scripts/phase7-commit.mjs');
        const stateBin = join(root, 'scripts/state.mjs');
        try {
          await withSandbox(async (dir) => {
            const ws = (...args) => sh(dir, 'node', [stateBin, ...args]);
            const wf = ws('create', '--repo-root', dir, '--verb', 'compose', '--profile', 'code', '--persona', persona,
              '--host', host, '--git-baseline-branch', 'feat/s', '--git-baseline-head', sh(dir, 'git', ['rev-parse', 'HEAD']),
              '--status-digest', statusDigest(dir), '--current-phase', 'phase-0-bootstrap', '--next-action', 'Run skill',
              '--original-request', 'wire the thing');
            ws('record-composed-file', '--workflow-path', wf, '--path', 'plugins/engineer/a.mjs', '--op', 'edit');
            await writeFile(join(dir, 'plugins', 'engineer', 'a.mjs'), 'export const a = 9;\n');
            const args = (mode, ...extra) => ['--mode', mode, '--workflow-path', wf, '--repo-root', dir, '--host', host, ...extra];
            const before = await readFile(wf, 'utf8');
            const refused = run(dir, bin, args('autopilot'), AP);
            strictEqual(refused.code, 2, refused.stderr);
            ok(refused.stderr.includes('--mode autopilot runs only under an autopilot run'), refused.stderr);
            match(refused.stderr, reason);
            strictEqual(await readFile(wf, 'utf8'), before, 'the refusal writes nothing');
            // An ignored run does not refuse execute, nor the confirm flag an
            // interactive caller passes after confirming the staging set.
            const r = run(dir, bin, args('execute', '--subject', 'feat(engineer): wire the thing', '--confirm-non-interactive'), AP);
            strictEqual(r.code, 0, r.stderr);
            strictEqual(sh(dir, 'git', ['log', '-1', '--format=%s']), 'feat(engineer): wire the thing');
          });
          await withSandbox(async (dir) => {
            const ws = (...args) => sh(dir, 'node', [stateBin, ...args]);
            const wf = ws('create', '--repo-root', dir, '--verb', 'frame', '--persona', persona, '--host', host,
              '--git-baseline-branch', 'feat/s', '--git-baseline-head', sh(dir, 'git', ['rev-parse', 'HEAD']),
              '--current-phase', 'phase-0-bootstrap', '--next-action', 'Run skill', '--original-request', 'frame it');
            ws('append', '--workflow-path', wf, '--host', host, '--next-step-kind', 'done', '--next-step-confidence', 'HIGH', '--event', 'updated');
            const r = run(dir, bin, ['--mode', 'close', '--workflow-path', wf, '--repo-root', dir, '--host', host], AP);
            strictEqual(r.code, 0, r.stderr);
            strictEqual(JSON.parse(r.stdout).closed, true);
          });
        } finally {
          await cleanup();
        }
      });
    }

    itDispatchOn('control: on Claude with dispatch_target on, the same execute and close are refused as autopilot operations', async () => {
      await withSandbox(async (dir) => {
        const wf = createWorkflow(dir);
        nextStep(dir, wf, 'done');
        for (const mode of ['execute', 'close']) {
          const r = run(dir, PHASE7_BIN, ['--mode', mode, '--workflow-path', wf, '--repo-root', dir, '--host', 'claude'], AP);
          strictEqual(r.code, 2, r.stderr);
          ok(r.stderr.includes(`--mode ${mode} is refused under an autopilot run`), r.stderr);
        }
      });
    });
  });
}
