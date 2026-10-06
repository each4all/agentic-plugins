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
import { strictEqual, ok, deepStrictEqual, match } from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir, readFile, chmod, access, cp } from 'node:fs/promises';
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
        const p = plan(dir, wf);
        deepStrictEqual([p.no_changes?.path, p.no_changes?.reason], ['blocked', 'status-not-clean'], JSON.stringify(p.no_changes));
        const r = run(dir, PHASE7_BIN, closeArgs(dir, wf));
        strictEqual(r.code, 1, r.stderr);
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
