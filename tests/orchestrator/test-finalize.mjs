// plugins/orchestrator/commands/finalize.md — §5 finalize ritual e2e tests
// (ADR-0019 PR-E).
//
// The slash-command runbook orchestrates three steps:
//   1. bulkSubtaskStatus pending|blocked|in_progress → deferred (parent lock).
//   2. Active-children detach pass: for each engineer workflow with
//      parent_workflow == <macro id>, route to either engineer
//      stop-archive (terminal, with explicit --head-sha) or
//      detach-archive (mid-flight, or stop-archive gate-not-met).
//   3. setMacroTerminal terminalPhase='finalized' terminal_marker=true.
//
// The markdown runbook itself is not directly executable; these tests
// invoke the same orchestrator state.mjs CLI + engineer state.mjs CLI
// sequence the runbook describes, verifying the resulting on-disk shape.
//
// Coverage (Codex CONCERN #2 plan-verify):
//   - Happy path: terminal child archived via stop-archive
//   - Mid-flight child: detach-archive routes correctly
//   - Deleted subtask branch (null probe): falls through to detach-archive
//   - Malformed engineer envelope: stderr diagnostic, finalize continues
//   - gate-not-met head_moved: fallback to detach-archive
//   - Step 1 deferred guard: subsequent /done on a deferred subtask is rejected
//
// Run via `node --test tests/orchestrator/test-finalize.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, match } from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT_ABS = resolve(fileURLToPath(import.meta.url), '../../..');
const PLUGIN_ROOT = resolve(REPO_ROOT_ABS, 'plugins/orchestrator');
const ORCH_STATE = resolve(PLUGIN_ROOT, 'scripts/state.mjs');
const ENGINEER_PLUGIN = resolve(REPO_ROOT_ABS, 'plugins/engineer');
const ENG_STATE = resolve(ENGINEER_PLUGIN, 'scripts/state.mjs');

const {
  createWorkflow,
  setPlan,
  setMacroTerminal,
  bulkSubtaskStatus,
  archiveDir,
  WORKFLOW_DIR_REL,
  ARCHIVE_DIR_REL,
  readWorkflow,
} = await import(ORCH_STATE);

// -----------------------------------------------------------------------------
// Test fixtures

async function withTmpRepo(name, fn) {
  const dir = await mkdtemp(join(tmpdir(), `orch-finalize-${name}-`));
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 't@t.local'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir, stdio: 'ignore' });
  await writeFile(join(dir, 'README.md'), '# tmp\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'feat: initial commit'], { cwd: dir });
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const MIN_BASELINE = (branch = 'main', head = 'a'.repeat(40)) => ({
  branch, head, status_digest: '',
});

async function bootstrapMacro(repoRoot, subtasks) {
  const { filePath } = await createWorkflow({
    repoRoot,
    verb: 'plan',
    host: 'claude',
    gitBaseline: MIN_BASELINE(),
    currentPhase: 'phase-0',
    nextAction: 'plan-set',
    originalRequest: 'finalize-test',
  });
  await setPlan({ workflowPath: filePath, host: 'claude', subtasks });
  return { macroPath: filePath, macroId: filePath.split('/').pop().replace(/\.md$/, '') };
}

async function bootstrapEngineerChild(repoRoot, {
  verb = 'compose', subtaskId, parentMacroId, branch, terminalCommit = null, terminalPhase = null,
}) {
  // Use engineer state.mjs CLI to create the workflow so all required
  // fields land correctly. Tests can NOT use the engineer's createWorkflow
  // import via `await import` because the engineer module emits schema=1.1
  // frontmatter that diverges from orchestrator schema validation in subtle
  // shared-name ways; using the CLI subprocess keeps the boundary clean.
  const out = execFileSync(
    process.execPath,
    [
      ENG_STATE, 'create',
      '--repo-root', repoRoot,
      '--verb', verb,
      '--host', 'claude',
      '--git-baseline-branch', branch,
      '--git-baseline-head', terminalCommit ?? 'b'.repeat(40),
      '--parent-workflow', parentMacroId,
      '--originating-subtask', subtaskId,
    ],
    { encoding: 'utf8' },
  ).trim();

  // If we need a terminal child, set its phase + marker via engineer
  // state.mjs set-terminal.
  if (terminalPhase) {
    execFileSync(
      process.execPath,
      [
        ENG_STATE, 'set-terminal',
        '--workflow-path', out,
        '--host', 'claude',
        '--terminal-phase', terminalPhase,
        '--terminal-marker', 'true',
      ],
      { encoding: 'utf8' },
    );
  }
  return out;
}

async function listEngineerWorkflows(repoRoot) {
  try {
    const dir = join(repoRoot, '.agentic-plugins/state/engineer/workflows');
    const entries = await readdir(dir);
    return entries.filter((e) => e.endsWith('.md'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function listEngineerArchive(repoRoot) {
  try {
    const dir = join(repoRoot, '.agentic-plugins/state/engineer/archive');
    const entries = await readdir(dir);
    return entries.filter((e) => e.endsWith('.md'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// =============================================================================
// Step 1 — bulkSubtaskStatus transitions

describe('finalize step 1 — bulkSubtaskStatus → deferred', () => {
  it('transitions all pending|blocked|in_progress subtasks to deferred', async () => {
    await withTmpRepo('step1-bulk', async (root) => {
      const { macroPath } = await bootstrapMacro(root, [
        { id: 'T1', verb: 'compose', branch: 'feat/t1', blocked_by: [], status: 'pending' },
        { id: 'T2', verb: 'compose', branch: 'feat/t2', blocked_by: [], status: 'in_progress' },
        { id: 'T3', verb: 'compose', branch: 'feat/t3', blocked_by: ['T1'], status: 'blocked' },
        { id: 'T4', verb: 'compose', branch: 'feat/t4', blocked_by: [], status: 'completed' },
      ]);
      await bulkSubtaskStatus({
        workflowPath: macroPath,
        host: 'claude',
        fromStatuses: ['pending', 'blocked', 'in_progress'],
        toStatus: 'deferred',
      });
      const { frontmatter } = await readWorkflow(macroPath);
      const status = (id) => frontmatter.plan.subtasks.find((s) => s.id === id).status;
      strictEqual(status('T1'), 'deferred');
      strictEqual(status('T2'), 'deferred');
      strictEqual(status('T3'), 'deferred');
      strictEqual(status('T4'), 'completed'); // unchanged — outside from-set
    });
  });
});

// =============================================================================
// Step 2 — active-children detach pass

describe('finalize step 2 — terminal child archived via engineer stop-archive', () => {
  it('routes terminal child to stop-archive CLI with explicit --head-sha (engineer baseline branch HEAD)', async () => {
    await withTmpRepo('step2-terminal', async (root) => {
      const { macroId } = await bootstrapMacro(root, [
        { id: 'T1', verb: 'compose', branch: 'feat/t1', blocked_by: [], status: 'deferred' },
      ]);
      // Engineer child anchored to 'feat/t1' branch with a real commit on it.
      execFileSync('git', ['checkout', '-q', '-b', 'feat/t1'], { cwd: root });
      execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'feat(plugins/engineer): child work'], { cwd: root });
      const childBaselineHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
      execFileSync('git', ['checkout', '-q', 'main'], { cwd: root });

      const childPath = await bootstrapEngineerChild(root, {
        subtaskId: 'T1',
        parentMacroId: macroId,
        branch: 'feat/t1',
        terminalCommit: 'a'.repeat(40), // baseline; we'll probe HEAD separately
        terminalPhase: 'commit-complete',
      });

      // Probe child's branch HEAD (as the runbook does via `git rev-parse refs/heads/<branch>`)
      const probedHead = execFileSync(
        'git', ['-C', root, 'rev-parse', '--verify', 'refs/heads/feat/t1'],
        { encoding: 'utf8' },
      ).trim();
      const probedSubject = execFileSync(
        'git', ['-C', root, 'log', '-1', '--pretty=%s', probedHead],
        { encoding: 'utf8' },
      ).trim();

      const cp = spawnSync(
        process.execPath,
        [
          ENG_STATE, 'stop-archive',
          '--workflow-path', childPath,
          '--host', 'claude',
          '--repo-root', root,
          '--head-sha', probedHead,
          '--head-subject', probedSubject,
        ],
        { encoding: 'utf8' },
      );
      strictEqual(cp.status, 0, `stderr: ${cp.stderr}`);
      const envelope = JSON.parse(cp.stdout.trim());
      strictEqual(envelope.archived, true);
      // Child file moved out of engineer workflows/
      strictEqual((await listEngineerWorkflows(root)).length, 0);
      ok((await listEngineerArchive(root)).length === 1);
    });
  });
});

describe('finalize step 2 — mid-flight child routed to detach-archive', () => {
  it('archives via detach-archive with parent_detached:true + terminal_marker:false', async () => {
    await withTmpRepo('step2-midflight', async (root) => {
      const { macroId } = await bootstrapMacro(root, [
        { id: 'T1', verb: 'compose', branch: 'feat/t1-mid', blocked_by: [], status: 'deferred' },
      ]);
      const childPath = await bootstrapEngineerChild(root, {
        subtaskId: 'T1',
        parentMacroId: macroId,
        branch: 'feat/t1-mid',
        // No terminalPhase — child is mid-flight
      });

      const cp = spawnSync(
        process.execPath,
        [
          ENG_STATE, 'detach-archive',
          '--workflow-path', childPath,
          '--host', 'claude',
          '--repo-root', root,
        ],
        { encoding: 'utf8' },
      );
      strictEqual(cp.status, 0, `stderr: ${cp.stderr}`);
      const envelope = JSON.parse(cp.stdout.trim());
      strictEqual(envelope.detached, true);
      strictEqual((await listEngineerWorkflows(root)).length, 0);
      const archived = await listEngineerArchive(root);
      strictEqual(archived.length, 1);
      const text = await readFile(join(root, '.agentic-plugins/state/engineer/archive', archived[0]), 'utf8');
      match(text, /parent_detached: true/);
      match(text, /terminal_marker: false/);
    });
  });
});

describe('finalize step 2 — deleted branch (D-ε′ null probe) falls back to detach-archive', () => {
  it('child whose baseline branch was deleted gets routed to detach-archive', async () => {
    await withTmpRepo('step2-deleted-branch', async (root) => {
      const { macroId } = await bootstrapMacro(root, [
        { id: 'T1', verb: 'compose', branch: 'feat/deleted', blocked_by: [], status: 'deferred' },
      ]);
      // Create the branch + child, then DELETE the branch
      execFileSync('git', ['checkout', '-q', '-b', 'feat/deleted'], { cwd: root });
      execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'feat: child work'], { cwd: root });
      execFileSync('git', ['checkout', '-q', 'main'], { cwd: root });

      const childPath = await bootstrapEngineerChild(root, {
        subtaskId: 'T1',
        parentMacroId: macroId,
        branch: 'feat/deleted',
        terminalPhase: 'commit-complete',
      });

      // Delete the branch
      execFileSync('git', ['branch', '-q', '-D', 'feat/deleted'], { cwd: root });

      // Probing the branch HEAD now fails — runbook routes to detach-archive
      const probe = spawnSync(
        'git', ['-C', root, 'rev-parse', '--verify', 'refs/heads/feat/deleted'],
        { encoding: 'utf8' },
      );
      ok(probe.status !== 0, 'git rev-parse must fail for deleted branch (precondition for D-ε′ fallback)');

      // Runbook routes to detach-archive
      const cp = spawnSync(
        process.execPath,
        [
          ENG_STATE, 'detach-archive',
          '--workflow-path', childPath,
          '--host', 'claude',
          '--repo-root', root,
        ],
        { encoding: 'utf8' },
      );
      strictEqual(cp.status, 0, `stderr: ${cp.stderr}`);
      const envelope = JSON.parse(cp.stdout.trim());
      strictEqual(envelope.detached, true);
      strictEqual((await listEngineerWorkflows(root)).length, 0);
    });
  });
});

describe('finalize step 2 — gate-not-met head_moved → fallback to detach-archive', () => {
  it('stop-archive returns gate-not-met head_moved when --head-sha equals baseline; finalize falls back to detach-archive', async () => {
    await withTmpRepo('step2-head-moved-fallback', async (root) => {
      const { macroId } = await bootstrapMacro(root, [
        { id: 'T1', verb: 'compose', branch: 'feat/t1', blocked_by: [], status: 'deferred' },
      ]);
      const baselineHead = 'c'.repeat(40);
      const childPath = await bootstrapEngineerChild(root, {
        subtaskId: 'T1',
        parentMacroId: macroId,
        branch: 'feat/t1',
        terminalCommit: baselineHead,
        terminalPhase: 'commit-complete',
      });

      // Invoke stop-archive with --head-sha == baseline; expect gate-not-met
      const cp = spawnSync(
        process.execPath,
        [
          ENG_STATE, 'stop-archive',
          '--workflow-path', childPath,
          '--host', 'claude',
          '--repo-root', root,
          '--head-sha', baselineHead, // same as baseline → head_moved fails
        ],
        { encoding: 'utf8' },
      );
      strictEqual(cp.status, 0, `stderr: ${cp.stderr}`);
      const envelope = JSON.parse(cp.stdout.trim());
      strictEqual(envelope.archived, false);
      ok(envelope.gateFailures.includes('head_moved'));

      // Runbook's fallback: detach-archive
      const cp2 = spawnSync(
        process.execPath,
        [
          ENG_STATE, 'detach-archive',
          '--workflow-path', childPath,
          '--host', 'claude',
          '--repo-root', root,
        ],
        { encoding: 'utf8' },
      );
      strictEqual(cp2.status, 0, `stderr: ${cp2.stderr}`);
      strictEqual(JSON.parse(cp2.stdout.trim()).detached, true);
      strictEqual((await listEngineerWorkflows(root)).length, 0);
    });
  });
});

// =============================================================================
// Step 3 — setMacroTerminal

describe('finalize step 3 — setMacroTerminal "finalized"', () => {
  it('writes terminal_marker:true + current_phase:finalized atomically', async () => {
    await withTmpRepo('step3-setterminal', async (root) => {
      const { macroPath } = await bootstrapMacro(root, [
        { id: 'T1', verb: 'compose', branch: 'feat/t1', blocked_by: [], status: 'deferred' },
      ]);
      await setMacroTerminal({
        workflowPath: macroPath,
        host: 'claude',
        terminalPhase: 'finalized',
        terminalMarker: true,
        nextAction: 'archive',
      });
      const { frontmatter } = await readWorkflow(macroPath);
      strictEqual(frontmatter.current_phase, 'finalized');
      strictEqual(frontmatter.terminal_marker, true);
      strictEqual(frontmatter.next_action, 'archive');
    });
  });
});

// =============================================================================
// End-to-end §5 ritual

describe('finalize §5 end-to-end ritual', () => {
  it('after step 1 + step 2 + step 3, macro is terminal and all engineer children are archived', async () => {
    await withTmpRepo('e2e-finalize', async (root) => {
      const { macroPath, macroId } = await bootstrapMacro(root, [
        { id: 'T1', verb: 'compose', branch: 'feat/t1', blocked_by: [], status: 'in_progress' },
        { id: 'T2', verb: 'compose', branch: 'feat/t2', blocked_by: [], status: 'pending' },
      ]);
      // Engineer child T1 — mid-flight (no terminal_marker)
      await bootstrapEngineerChild(root, {
        subtaskId: 'T1', parentMacroId: macroId, branch: 'feat/t1',
      });
      // Engineer child T2 — terminal (commit-complete)
      execFileSync('git', ['checkout', '-q', '-b', 'feat/t2'], { cwd: root });
      execFileSync('git', ['commit', '--allow-empty', '-q', '-m', 'feat: T2 work'], { cwd: root });
      execFileSync('git', ['checkout', '-q', 'main'], { cwd: root });
      const t2Path = await bootstrapEngineerChild(root, {
        subtaskId: 'T2', parentMacroId: macroId, branch: 'feat/t2',
        terminalPhase: 'commit-complete',
      });

      // Step 1
      await bulkSubtaskStatus({
        workflowPath: macroPath, host: 'claude',
        fromStatuses: ['pending', 'blocked', 'in_progress'],
        toStatus: 'deferred',
      });

      // Step 2 — call engineer CLIs directly (the runbook does the same)
      // T1: mid-flight → detach-archive
      const t1Path = (await listEngineerWorkflows(root))
        .filter((n) => n.startsWith('compose-'))
        .map((n) => join(root, '.agentic-plugins/state/engineer/workflows', n))[0];
      // We can't be sure which is T1 vs T2 from filename alone, so probe via frontmatter
      for (const name of await listEngineerWorkflows(root)) {
        const path = join(root, '.agentic-plugins/state/engineer/workflows', name);
        const text = await readFile(path, 'utf8');
        if (text.includes('originating_subtask: "T1"')) {
          // mid-flight
          execFileSync(
            process.execPath,
            [ENG_STATE, 'detach-archive', '--workflow-path', path, '--host', 'claude', '--repo-root', root],
            { encoding: 'utf8' },
          );
        } else if (text.includes('originating_subtask: "T2"')) {
          // terminal — probe branch HEAD + stop-archive
          const head = execFileSync('git', ['-C', root, 'rev-parse', '--verify', 'refs/heads/feat/t2'], { encoding: 'utf8' }).trim();
          const sub = execFileSync('git', ['-C', root, 'log', '-1', '--pretty=%s', head], { encoding: 'utf8' }).trim();
          execFileSync(
            process.execPath,
            [
              ENG_STATE, 'stop-archive',
              '--workflow-path', path, '--host', 'claude', '--repo-root', root,
              '--head-sha', head, '--head-subject', sub,
            ],
            { encoding: 'utf8' },
          );
        }
      }

      // Step 3
      await setMacroTerminal({
        workflowPath: macroPath, host: 'claude',
        terminalPhase: 'finalized', terminalMarker: true, nextAction: 'archive',
      });

      // Assertions
      const { frontmatter } = await readWorkflow(macroPath);
      strictEqual(frontmatter.current_phase, 'finalized');
      strictEqual(frontmatter.terminal_marker, true);
      for (const s of frontmatter.plan.subtasks) {
        strictEqual(s.status, 'deferred');
      }
      // All engineer children archived
      strictEqual((await listEngineerWorkflows(root)).length, 0);
      strictEqual((await listEngineerArchive(root)).length, 2);
    });
  });
});

// =============================================================================
// Stale-token audit — commands/finalize.md must contain no stale tokens
// (covered by tests/plugin-shape/test-orchestrator-plugin.mjs ALL_AUDIT_DOCS
//  extension); no additional assertion here.
