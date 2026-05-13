// plugins/orchestrator/commands/abort.md — §5 abort ritual e2e tests
// (ADR-0019 PR-E). Mirrors test-finalize.mjs structure; differences:
//   - bulkSubtaskStatus toStatus = 'abandoned' (not 'deferred')
//   - setMacroTerminal terminalPhase = 'aborted' (not 'finalized')
//
// Step 2 (active-children detach pass) is identical — engineer parent-
// writeback's absorbing precondition treats deferred + abandoned the
// same way. We test step 1 + step 3 variants here, then an end-to-end
// ritual.

import { describe, it } from 'node:test';
import { strictEqual, ok, match } from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT_ABS = resolve(fileURLToPath(import.meta.url), '../../..');
const PLUGIN_ROOT = resolve(REPO_ROOT_ABS, 'plugins/orchestrator');
const ORCH_STATE = resolve(PLUGIN_ROOT, 'scripts/state.mjs');
const ENG_STATE = resolve(REPO_ROOT_ABS, 'plugins/engineer/scripts/state.mjs');

const {
  createWorkflow,
  setPlan,
  setMacroTerminal,
  bulkSubtaskStatus,
  readWorkflow,
} = await import(ORCH_STATE);

async function withTmpRepo(name, fn) {
  const dir = await mkdtemp(join(tmpdir(), `orch-abort-${name}-`));
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
    repoRoot, verb: 'plan', host: 'claude',
    gitBaseline: MIN_BASELINE(),
    currentPhase: 'phase-0', nextAction: 'plan-set',
    originalRequest: 'abort-test',
  });
  await setPlan({ workflowPath: filePath, host: 'claude', subtasks });
  return { macroPath: filePath, macroId: filePath.split('/').pop().replace(/\.md$/, '') };
}

async function bootstrapEngineerChild(repoRoot, { subtaskId, parentMacroId, branch, terminalPhase = null }) {
  const out = execFileSync(
    process.execPath,
    [
      ENG_STATE, 'create',
      '--repo-root', repoRoot,
      '--verb', 'compose',
      '--host', 'claude',
      '--git-baseline-branch', branch,
      '--git-baseline-head', 'b'.repeat(40),
      '--parent-workflow', parentMacroId,
      '--originating-subtask', subtaskId,
    ],
    { encoding: 'utf8' },
  ).trim();
  if (terminalPhase) {
    execFileSync(
      process.execPath,
      [ENG_STATE, 'set-terminal', '--workflow-path', out, '--host', 'claude', '--terminal-phase', terminalPhase, '--terminal-marker', 'true'],
      { encoding: 'utf8' },
    );
  }
  return out;
}

async function listEngineerArchive(repoRoot) {
  try {
    return (await readdir(join(repoRoot, '.agentic-plugins/state/engineer/archive'))).filter((e) => e.endsWith('.md'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

async function listEngineerWorkflows(repoRoot) {
  try {
    return (await readdir(join(repoRoot, '.agentic-plugins/state/engineer/workflows'))).filter((e) => e.endsWith('.md'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

// =============================================================================

describe('abort step 1 — bulkSubtaskStatus → abandoned', () => {
  it('transitions all pending|blocked|in_progress subtasks to abandoned (NOT deferred)', async () => {
    await withTmpRepo('step1-abandoned', async (root) => {
      const { macroPath } = await bootstrapMacro(root, [
        { id: 'T1', verb: 'compose', branch: 'feat/t1', blocked_by: [], status: 'pending' },
        { id: 'T2', verb: 'compose', branch: 'feat/t2', blocked_by: [], status: 'in_progress' },
      ]);
      await bulkSubtaskStatus({
        workflowPath: macroPath, host: 'claude',
        fromStatuses: ['pending', 'blocked', 'in_progress'],
        toStatus: 'abandoned',
      });
      const { frontmatter } = await readWorkflow(macroPath);
      for (const s of frontmatter.plan.subtasks) {
        strictEqual(s.status, 'abandoned');
      }
    });
  });
});

describe('abort step 3 — setMacroTerminal "aborted"', () => {
  it('writes terminal_marker:true + current_phase:aborted', async () => {
    await withTmpRepo('step3-aborted', async (root) => {
      const { macroPath } = await bootstrapMacro(root, [
        { id: 'T1', verb: 'compose', branch: 'feat/t1', blocked_by: [], status: 'abandoned' },
      ]);
      await setMacroTerminal({
        workflowPath: macroPath, host: 'claude',
        terminalPhase: 'aborted', terminalMarker: true, nextAction: 'archive',
      });
      const { frontmatter } = await readWorkflow(macroPath);
      strictEqual(frontmatter.current_phase, 'aborted');
      strictEqual(frontmatter.terminal_marker, true);
    });
  });
});

describe('abort §5 end-to-end ritual', () => {
  it('after step 1 + step 2 + step 3, macro is aborted and all engineer children are archived', async () => {
    await withTmpRepo('e2e-abort', async (root) => {
      const { macroPath, macroId } = await bootstrapMacro(root, [
        { id: 'T1', verb: 'compose', branch: 'feat/t1', blocked_by: [], status: 'in_progress' },
      ]);
      // Mid-flight child
      const childPath = await bootstrapEngineerChild(root, {
        subtaskId: 'T1', parentMacroId: macroId, branch: 'feat/t1',
      });

      // Step 1
      await bulkSubtaskStatus({
        workflowPath: macroPath, host: 'claude',
        fromStatuses: ['pending', 'blocked', 'in_progress'],
        toStatus: 'abandoned',
      });

      // Step 2 — detach the mid-flight child
      execFileSync(
        process.execPath,
        [ENG_STATE, 'detach-archive', '--workflow-path', childPath, '--host', 'claude', '--repo-root', root],
        { encoding: 'utf8' },
      );

      // Step 3
      await setMacroTerminal({
        workflowPath: macroPath, host: 'claude',
        terminalPhase: 'aborted', terminalMarker: true, nextAction: 'archive',
      });

      const { frontmatter } = await readWorkflow(macroPath);
      strictEqual(frontmatter.current_phase, 'aborted');
      strictEqual(frontmatter.terminal_marker, true);
      strictEqual(frontmatter.plan.subtasks[0].status, 'abandoned');
      strictEqual((await listEngineerWorkflows(root)).length, 0);
      const archived = await listEngineerArchive(root);
      strictEqual(archived.length, 1);
      const archivedText = await readFile(join(root, '.agentic-plugins/state/engineer/archive', archived[0]), 'utf8');
      match(archivedText, /parent_detached: true/);
      match(archivedText, /terminal_marker: false/);
    });
  });
});
