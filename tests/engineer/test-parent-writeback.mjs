// plugins/engineer/scripts/parent-writeback.mjs unit + integration tests
// (ADR-0019 PR-C — engineer-local parent-writeback helper).
//
// Scope:
//   - discoverOrchestratorPluginRoot — env override > Claude cache > Codex
//     cache > monorepo repo fallback. Pure-ish: tmp directories simulate
//     cache layouts; env passed in (no process.env mutation).
//   - writebackParent — invokes the orchestrator state.mjs subtask-update
//     CLI via child_process. Tests use the real monorepo orchestrator
//     state.mjs (so the atomic-mutation contract from PR-C0 is exercised
//     end-to-end, not stubbed).
//
// Run via `node --test tests/engineer/test-parent-writeback.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, match, deepStrictEqual } from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const ORCHESTRATOR_ROOT = resolve(REPO_ROOT, 'plugins/orchestrator');
const ORCHESTRATOR_STATE = resolve(ORCHESTRATOR_ROOT, 'scripts/state.mjs');
const PARENT_WRITEBACK_PATH = resolve(
  REPO_ROOT,
  'plugins/engineer/scripts/parent-writeback.mjs',
);

const { discoverOrchestratorPluginRoot, writebackParent } =
  await import(PARENT_WRITEBACK_PATH);

const MIN_DIGEST =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

// -----------------------------------------------------------------------------
// discoverOrchestratorPluginRoot — env override + cache walk + repo fallback

async function withTmpHomeAndRepo(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'parent-writeback-discover-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeManifest(root, { name, version }) {
  await mkdir(join(root, '.claude-plugin'), { recursive: true });
  await writeFile(
    join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name, version }),
  );
  await mkdir(join(root, 'scripts'), { recursive: true });
  // The discovery sentinel mirrors how dispatch-peer.mjs gates on
  // scripts/discover-peer.mjs existence; for orchestrator we gate on
  // scripts/state.mjs existence (the file callers will spawn).
  await writeFile(join(root, 'scripts', 'state.mjs'), '// stub\n');
}

// Helper to fabricate a `selfUrl` value pointing at a fake engineer
// plugin layout under a tmp dir. The discovery's sibling-fallback step
// derives the orchestrator path as `<engineer-root>/../orchestrator`,
// which under our tmp layout resolves to `<dir>/plugins/orchestrator/`.
function fakeEngineerSelfUrl(tmpDir) {
  const enginerScriptPath = join(tmpDir, 'plugins', 'engineer', 'scripts', 'parent-writeback.mjs');
  return `file://${enginerScriptPath}`;
}

describe('discoverOrchestratorPluginRoot — env override', () => {
  it('AGENTIC_ORCHESTRATOR_ROOT env override returns that path when scripts/state.mjs exists', async () => {
    await withTmpHomeAndRepo(async (dir) => {
      const override = join(dir, 'custom-orch');
      await writeManifest(override, { name: 'orchestrator', version: '9.9.9' });
      const result = await discoverOrchestratorPluginRoot({
        env: { AGENTIC_ORCHESTRATOR_ROOT: override },
        home: dir,
        selfUrl: fakeEngineerSelfUrl(dir),
      });
      strictEqual(result, override);
    });
  });

  it('AGENTIC_ORCHESTRATOR_ROOT env override returns null when scripts/state.mjs missing', async () => {
    await withTmpHomeAndRepo(async (dir) => {
      const override = join(dir, 'bogus-orch');
      await mkdir(override, { recursive: true });
      const result = await discoverOrchestratorPluginRoot({
        env: { AGENTIC_ORCHESTRATOR_ROOT: override },
        home: dir,
        selfUrl: fakeEngineerSelfUrl(dir),
      });
      strictEqual(result, null);
    });
  });
});

describe('discoverOrchestratorPluginRoot — Claude cache layout (multi-version SemVer)', () => {
  it('selects latest SemVer when multiple cached versions exist', async () => {
    await withTmpHomeAndRepo(async (dir) => {
      const base = join(dir, '.claude', 'plugins', 'cache', 'agentic-plugins', 'orchestrator');
      const v090 = join(base, '0.9.0');
      const v110 = join(base, '1.1.0');
      const v101 = join(base, '1.0.1');
      await writeManifest(v090, { name: 'orchestrator', version: '0.9.0' });
      await writeManifest(v110, { name: 'orchestrator', version: '1.1.0' });
      await writeManifest(v101, { name: 'orchestrator', version: '1.0.1' });

      const result = await discoverOrchestratorPluginRoot({
        env: {},
        home: dir,
        selfUrl: fakeEngineerSelfUrl(dir),
      });
      strictEqual(result, v110);
    });
  });

  it('skips directories whose plugin.json name is not orchestrator', async () => {
    await withTmpHomeAndRepo(async (dir) => {
      const base = join(dir, '.claude', 'plugins', 'cache', 'agentic-plugins', 'orchestrator');
      const v100 = join(base, '1.0.0');
      await writeManifest(v100, { name: 'something-else', version: '1.0.0' });

      const result = await discoverOrchestratorPluginRoot({
        env: {},
        home: dir,
        selfUrl: fakeEngineerSelfUrl(dir),
      });
      strictEqual(result, null);
    });
  });
});

describe('discoverOrchestratorPluginRoot — Codex cache layout (single fixed path)', () => {
  it('returns the Codex cache path when scripts/state.mjs exists', async () => {
    await withTmpHomeAndRepo(async (dir) => {
      const codexBase = join(
        dir, '.codex', '.tmp', 'marketplaces', 'agentic-plugins', 'plugins', 'orchestrator',
      );
      await writeManifest(codexBase, { name: 'orchestrator', version: '1.0.0' });
      const result = await discoverOrchestratorPluginRoot({
        env: {},
        home: dir,
        selfUrl: fakeEngineerSelfUrl(dir),
      });
      strictEqual(result, codexBase);
    });
  });
});

describe('discoverOrchestratorPluginRoot — sibling fallback (engineer plugin root → ../orchestrator)', () => {
  it('returns the sibling orchestrator under the engineer plugin root derived from selfUrl', async () => {
    await withTmpHomeAndRepo(async (dir) => {
      // Build a fake engineer plugin layout under `<dir>/plugins/engineer/`.
      // The sibling is `<dir>/plugins/orchestrator/` — that is what the
      // discovery's `resolve(dirname(selfUrl), '..', '..', 'orchestrator')`
      // computes, regardless of the caller's user-project repoRoot.
      const orch = join(dir, 'plugins', 'orchestrator');
      await writeManifest(orch, { name: 'orchestrator', version: '1.0.0' });
      const result = await discoverOrchestratorPluginRoot({
        env: {},
        home: join(dir, 'home'), // empty home, no cache hits
        selfUrl: fakeEngineerSelfUrl(dir),
      });
      strictEqual(result, orch);
    });
  });

  it('returns null when sibling has no scripts/state.mjs', async () => {
    await withTmpHomeAndRepo(async (dir) => {
      // No orchestrator sibling created.
      const result = await discoverOrchestratorPluginRoot({
        env: {},
        home: dir,
        selfUrl: fakeEngineerSelfUrl(dir),
      });
      strictEqual(result, null);
    });
  });

  it('does NOT use caller user-project paths as a search root (Codex P2 regression guard)', async () => {
    // Builds a "user project" tree at `<dir>/userproject/plugins/orchestrator/`
    // which is what a real engineer Stop hook would supply as repoRoot.
    // The sibling fallback must IGNORE this tree — discovery should fail
    // (return null) rather than execute an unrelated state.mjs.
    await withTmpHomeAndRepo(async (dir) => {
      const userOrchestrator = join(dir, 'userproject', 'plugins', 'orchestrator');
      await writeManifest(userOrchestrator, { name: 'orchestrator', version: '999.0.0' });
      // No engineer sibling layout — only the user's project tree.
      const isolatedSelfUrl = `file://${join(dir, 'unrelated-location', 'parent-writeback.mjs')}`;
      const result = await discoverOrchestratorPluginRoot({
        env: {},
        home: join(dir, 'home'), // empty home
        selfUrl: isolatedSelfUrl,
      });
      strictEqual(result, null,
        'discovery must not leak into user-project plugin trees');
    });
  });

  it('uses the real monorepo orchestrator when invoked with REPO_ROOT (smoke)', async () => {
    // Real this-file's import.meta.url drives the smoke test — under the
    // monorepo layout `<repo>/plugins/engineer/scripts/test-parent-writeback.mjs`
    // resolves the sibling to `<repo>/plugins/orchestrator/`.
    const result = await discoverOrchestratorPluginRoot({
      env: {},
      home: '/nonexistent-home-xyz',
      selfUrl: `file://${resolve(REPO_ROOT, 'plugins/engineer/scripts/parent-writeback.mjs')}`,
    });
    strictEqual(result, ORCHESTRATOR_ROOT);
  });
});

// -----------------------------------------------------------------------------
// writebackParent — end-to-end against the real orchestrator state.mjs CLI

async function withTmpRepoAndOrchestratorPlan(fn) {
  // The tmp dir plays the role of `repoRoot` from the engineer side's
  // perspective; orchestrator's `WORKFLOW_DIR_REL` lives under
  // <repoRoot>/.claude/agentic-orchestrator/workflows/.
  const dir = await mkdtemp(join(tmpdir(), 'parent-writeback-'));
  try {
    // Bootstrap an orchestrator macro workflow on a clean tmp branch.
    // We invoke orchestrator state.mjs CLI directly so we exercise the
    // same code paths PR-C will hit at runtime.
    const baselineBranch = 'orch-macro';
    const baselineHead = 'a'.repeat(40);
    const createOut = execFileSync(
      process.execPath,
      [
        ORCHESTRATOR_STATE,
        'create',
        '--repo-root', dir,
        '--verb', 'plan',
        '--host', 'claude',
        '--git-baseline-branch', baselineBranch,
        '--git-baseline-head', baselineHead,
        '--status-digest', MIN_DIGEST,
        '--original-request', 'pr-c integration test macro plan',
      ],
      { encoding: 'utf8' },
    ).trim();
    const parentPath = createOut;

    // Set a single-subtask plan so writeback has a target.
    const subtasks = [
      {
        id: 'T1',
        verb: 'compose',
        branch: 'feat/t1',
        blocked_by: [],
        status: 'in_progress',
        engineer_workflow_id: 'compose-20260511T010000Z-aaa111',
      },
    ];
    const subtasksFile = join(dir, 'subtasks.json');
    await writeFile(subtasksFile, JSON.stringify(subtasks));
    execFileSync(
      process.execPath,
      [
        ORCHESTRATOR_STATE,
        'plan-set',
        '--workflow-path', parentPath,
        '--host', 'claude',
        '--subtasks-json-file', subtasksFile,
      ],
      { encoding: 'utf8' },
    );

    const parentWorkflowId = parentPath
      .split('/')
      .pop()
      .replace(/\.md$/, '');

    await fn({
      repoRoot: dir,
      parentPath,
      parentWorkflowId,
      childWorkflowId: 'compose-20260511T010000Z-aaa111',
      childSubtaskId: 'T1',
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('writebackParent — happy path (parent file in workflows/)', () => {
  it('invokes the orchestrator CLI and marks the subtask completed', async () => {
    await withTmpRepoAndOrchestratorPlan(async ({
      repoRoot, parentPath, parentWorkflowId, childWorkflowId, childSubtaskId,
    }) => {
      const commitSha = 'b'.repeat(40);
      const closedAt = '2026-05-11T03:00:00Z';
      const stderrBuf = [];

      const result = await writebackParent({
        repoRoot,
        parentWorkflowId,
        originatingSubtaskId: childSubtaskId,
        engineerWorkflowId: childWorkflowId,
        commit: commitSha,
        closedAt,
        host: 'claude',
        orchestratorRoot: ORCHESTRATOR_ROOT,
        stderr: { write: (s) => stderrBuf.push(s) },
      });

      strictEqual(result.ok, true);
      ok(result.envelope, 'envelope returned');
      strictEqual(result.envelope.updatedSubtask.status, 'completed');
      strictEqual(result.envelope.updatedSubtask.commit, commitSha);
      strictEqual(result.envelope.updatedSubtask.closed_at, closedAt);
      strictEqual(result.envelope.updatedSubtask.engineer_workflow_id, childWorkflowId);
      strictEqual(result.envelope.autoTerminal, true,
        'single-subtask plan: completing the only subtask → auto-terminal');

      // Verify on-disk state matches the envelope. orchestrator's
      // YAML emit quotes string scalars but leaves booleans bare.
      const text = await readFile(parentPath, 'utf8');
      match(text, /status: "completed"/);
      match(text, new RegExp(`commit: "${commitSha}"`));
      match(text, /terminal_marker: true/);
    });
  });
});

describe('writebackParent — archive fallback (parent file in archive/)', () => {
  it('emits a stderr warning and returns skipped:true without throwing', async () => {
    await withTmpRepoAndOrchestratorPlan(async ({
      repoRoot, parentPath, parentWorkflowId, childWorkflowId, childSubtaskId,
    }) => {
      // Move parent to archive/ to simulate /orchestrator:finalize having
      // archived the macro before this child's stop hook fired.
      const archiveDir = join(repoRoot, '.claude', 'agentic-orchestrator', 'archive');
      await mkdir(archiveDir, { recursive: true });
      const archivedPath = join(archiveDir, `${parentWorkflowId}.md`);
      const text = await readFile(parentPath, 'utf8');
      await writeFile(archivedPath, text);
      await rm(parentPath);

      const stderrBuf = [];
      const result = await writebackParent({
        repoRoot,
        parentWorkflowId,
        originatingSubtaskId: childSubtaskId,
        engineerWorkflowId: childWorkflowId,
        commit: 'b'.repeat(40),
        closedAt: '2026-05-11T03:00:00Z',
        host: 'claude',
        orchestratorRoot: ORCHESTRATOR_ROOT,
        stderr: { write: (s) => stderrBuf.push(s) },
      });

      strictEqual(result.ok, false);
      strictEqual(result.skipped, true);
      strictEqual(result.reason, 'parent-archived');
      const stderrStr = stderrBuf.join('');
      match(stderrStr, /parent_workflow.*archive/i);

      // Archive file untouched (no completion writeback to a frozen parent).
      const archivedText = await readFile(archivedPath, 'utf8');
      ok(!archivedText.includes('status: "completed"'),
        'archived parent must not be mutated');
    });
  });
});

describe('writebackParent — orchestrator root not found', () => {
  it('emits a stderr warning and returns skipped:true', async () => {
    await withTmpRepoAndOrchestratorPlan(async ({
      repoRoot, parentWorkflowId, childWorkflowId, childSubtaskId,
    }) => {
      const stderrBuf = [];
      const result = await writebackParent({
        repoRoot,
        parentWorkflowId,
        originatingSubtaskId: childSubtaskId,
        engineerWorkflowId: childWorkflowId,
        commit: 'b'.repeat(40),
        closedAt: '2026-05-11T03:00:00Z',
        host: 'claude',
        // Force discovery failure by overriding every discovery channel
        // to a non-existent path: env empty, home + selfUrl both point
        // at locations with no orchestrator artifact.
        orchestratorRoot: null,
        discoverOpts: {
          env: { AGENTIC_ORCHESTRATOR_ROOT: '' },
          home: '/nonexistent-home-xyz',
          selfUrl: 'file:///nonexistent-engineer/scripts/parent-writeback.mjs',
        },
        stderr: { write: (s) => stderrBuf.push(s) },
      });

      strictEqual(result.ok, false);
      strictEqual(result.skipped, true);
      strictEqual(result.reason, 'orchestrator-root-not-found');
      const stderrStr = stderrBuf.join('');
      match(stderrStr, /orchestrator.*not.*found/i);
    });
  });
});

describe('writebackParent — cli-failed (orchestrator CLI exits non-zero)', () => {
  it('returns ok=false with reason=cli-failed when the subtask-id does not exist in the parent plan', async () => {
    await withTmpRepoAndOrchestratorPlan(async ({
      repoRoot, parentWorkflowId, childWorkflowId,
    }) => {
      const stderrBuf = [];
      const result = await writebackParent({
        repoRoot,
        parentWorkflowId,
        originatingSubtaskId: 'T999-DOES-NOT-EXIST',
        engineerWorkflowId: childWorkflowId,
        commit: 'b'.repeat(40),
        closedAt: '2026-05-11T03:00:00Z',
        host: 'claude',
        orchestratorRoot: ORCHESTRATOR_ROOT,
        stderr: { write: (s) => stderrBuf.push(s) },
      });

      strictEqual(result.ok, false);
      strictEqual(result.reason, 'cli-failed');
      strictEqual(typeof result.exitCode, 'number');
      ok(result.exitCode !== 0, `expected non-zero exit, got ${result.exitCode}`);
      const stderrStr = stderrBuf.join('');
      match(stderrStr, /orchestrator CLI exited/i);
      match(stderrStr, /T999-DOES-NOT-EXIST|not found/i);
    });
  });
});

describe('writebackParent — parent-not-found (linkage exists but file is missing)', () => {
  it('emits a dangling-linkage WARN and returns skipped:true', async () => {
    await withTmpRepoAndOrchestratorPlan(async ({
      repoRoot, parentPath, childWorkflowId, childSubtaskId,
    }) => {
      // Remove the parent file from workflows/ WITHOUT moving to
      // archive/ — simulates a manual delete or a never-existed parent
      // linkage. This is distinct from 'parent-archived' (frozen but
      // present in archive/) and should emit a louder diagnostic.
      await rm(parentPath);

      const stderrBuf = [];
      const result = await writebackParent({
        repoRoot,
        parentWorkflowId: parentPath.split('/').pop().replace(/\.md$/, ''),
        originatingSubtaskId: childSubtaskId,
        engineerWorkflowId: childWorkflowId,
        commit: 'b'.repeat(40),
        closedAt: '2026-05-11T03:00:00Z',
        host: 'claude',
        orchestratorRoot: ORCHESTRATOR_ROOT,
        stderr: { write: (s) => stderrBuf.push(s) },
      });

      strictEqual(result.ok, false);
      strictEqual(result.skipped, true);
      strictEqual(result.reason, 'parent-not-found');
      const stderrStr = stderrBuf.join('');
      match(stderrStr, /WARN dangling parent linkage/i);
      match(stderrStr, /data integrity/i);
    });
  });
});

describe('writebackParent — parent_workflow id traversal guard', () => {
  for (const evilId of [
    '../archive/some-other',
    'subdir/legit-id',
    '..',
    '.hidden-id',
    'with\0null',
  ]) {
    it(`rejects parent_workflow id ${JSON.stringify(evilId)} as path-traversal attempt`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'parent-writeback-traversal-'));
      try {
        const stderrBuf = [];
        const result = await writebackParent({
          repoRoot: dir,
          parentWorkflowId: evilId,
          originatingSubtaskId: 'T1',
          engineerWorkflowId: 'compose-20260511T010000Z-aaa111',
          commit: 'b'.repeat(40),
          closedAt: '2026-05-11T03:00:00Z',
          host: 'claude',
          orchestratorRoot: ORCHESTRATOR_ROOT,
          stderr: { write: (s) => stderrBuf.push(s) },
        });
        strictEqual(result.ok, false);
        strictEqual(result.skipped, true);
        strictEqual(result.reason, 'parent-id-invalid');
        const stderrStr = stderrBuf.join('');
        match(stderrStr, /WARN invalid parent_workflow id/i);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }
});

describe('writebackParent — subtask id starting with -- is not mis-parsed by the orchestrator CLI', () => {
  it('argv-injection guard: equals-form encoding passes `--evil-id` verbatim through to PR-C0', async () => {
    // Bootstrap a macro plan with a subtask id that starts with `--`.
    // The validator only requires non-empty string, so this shape is
    // a valid (if unusual) plan-time id. Without equals-form argv the
    // orchestrator CLI parser would interpret `--evil-id` as a flag
    // and leave --subtask-id empty.
    const dir = await mkdtemp(join(tmpdir(), 'parent-writeback-evil-'));
    try {
      const createOut = execFileSync(
        process.execPath,
        [
          ORCHESTRATOR_STATE,
          'create',
          '--repo-root', dir,
          '--verb', 'plan',
          '--host', 'claude',
          '--git-baseline-branch', 'orch-macro',
          '--git-baseline-head', 'a'.repeat(40),
          '--status-digest', MIN_DIGEST,
          '--original-request', 'argv-injection regression guard',
        ],
        { encoding: 'utf8' },
      ).trim();
      const parentPath = createOut;
      const parentWorkflowId = parentPath.split('/').pop().replace(/\.md$/, '');
      const subtasks = [{
        id: '--evil-id',
        verb: 'compose',
        branch: 'feat/evil',
        blocked_by: [],
        status: 'in_progress',
      }];
      const subtasksFile = join(dir, 'evil-subtasks.json');
      await writeFile(subtasksFile, JSON.stringify(subtasks));
      execFileSync(
        process.execPath,
        [
          ORCHESTRATOR_STATE, 'plan-set',
          '--workflow-path', parentPath,
          '--host', 'claude',
          '--subtasks-json-file', subtasksFile,
        ],
        { encoding: 'utf8' },
      );

      const stderrBuf = [];
      const result = await writebackParent({
        repoRoot: dir,
        parentWorkflowId,
        originatingSubtaskId: '--evil-id',
        engineerWorkflowId: 'compose-20260511T010000Z-evil11',
        commit: 'b'.repeat(40),
        closedAt: '2026-05-11T03:00:00Z',
        host: 'claude',
        orchestratorRoot: ORCHESTRATOR_ROOT,
        stderr: { write: (s) => stderrBuf.push(s) },
      });

      strictEqual(result.ok, true,
        `expected ok=true, got stderr=${stderrBuf.join('')} envelope=${JSON.stringify(result.envelope)}`);
      strictEqual(result.envelope.updatedSubtask.id, '--evil-id');
      strictEqual(result.envelope.updatedSubtask.status, 'completed');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('writebackParent — PR-C0 precondition skip (subtask already terminal)', () => {
  it('returns ok=true with envelope.skipped=true when subtask is already completed', async () => {
    await withTmpRepoAndOrchestratorPlan(async ({
      repoRoot, parentPath, parentWorkflowId, childWorkflowId, childSubtaskId,
    }) => {
      // First call — marks the subtask completed (auto-terminal).
      await writebackParent({
        repoRoot,
        parentWorkflowId,
        originatingSubtaskId: childSubtaskId,
        engineerWorkflowId: childWorkflowId,
        commit: 'b'.repeat(40),
        closedAt: '2026-05-11T03:00:00Z',
        host: 'claude',
        orchestratorRoot: ORCHESTRATOR_ROOT,
        stderr: { write: () => {} },
      });

      // Second call — idempotent: PR-C0 sees status==completed and
      // either no-ops (same payload) or rejects status downgrades.
      // Same payload: the absorbing-completed branch returns skipped=true.
      const stderrBuf = [];
      const result = await writebackParent({
        repoRoot,
        parentWorkflowId,
        originatingSubtaskId: childSubtaskId,
        engineerWorkflowId: childWorkflowId,
        commit: 'b'.repeat(40),
        closedAt: '2026-05-11T03:00:00Z',
        host: 'claude',
        orchestratorRoot: ORCHESTRATOR_ROOT,
        stderr: { write: (s) => stderrBuf.push(s) },
      });
      // Idempotent re-completion is NOT a downgrade — PR-C0 lets it
      // through as a status:'completed' update on an already-completed
      // subtask (the unblock pass + auto-terminal pass are still atomic
      // and idempotent). So ok stays true and skipped stays false.
      strictEqual(result.ok, true);
      ok(!result.skipped, 'idempotent re-completion is allowed by PR-C0');
    });
  });
});
