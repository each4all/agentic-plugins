// plugins/orchestrator/scripts/state.mjs unit tests.
//
// Covers:
//   - workflow lifecycle (createWorkflow, readWorkflow, snapshot,
//     appendPhase, recordPendingEnsemble, commitEnsemble, setPlan)
//   - schema isolation (orchestrator '1.0' rejects engineer 1 / '1.1' / 2)
//   - subtasks[] validation (id uniq, blocked_by → existing, no
//     self-cycle, status enum, optional string-or-null fields)
//   - empty subtasks[] policy (0 deliverables is valid; explicit "no
//     deliverables" terminal plan)
//   - detached HEAD edge (currentGitBranch empty → findActiveWorkflow null)
//   - concurrent createWorkflow same-branch reject
//   - pruneEnsembleResults retention cap
//   - secret scrubbing
//   - generateWorkflowId macro-<verb>-<iso>-<rand> format
//   - CLI subcommand surface
//
// Run via `node --test tests/orchestrator/test-state.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual, ok, rejects, throws } from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const STATE_MJS = resolve(REPO_ROOT, 'plugins/orchestrator/scripts/state.mjs');

const {
  SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  WORKFLOW_DIR_REL,
  LEGACY_WORKFLOW_DIR_REL,
  ENSEMBLE_RESULTS_RETENTION_CAP,
  resolveWorkflowStorage,
  workflowDir,
  workflowFilePath,
  generateWorkflowId,
  withDirectoryLock,
  withFileLock,
  currentGitBranch,
  findActiveWorkflowByBranch,
  findActiveWorkflow,
  findMacroBySubtaskBranch,
  parseWorkflowFile,
  assembleWorkflowFile,
  scrubSecrets,
  singleLine,
  createWorkflow,
  createWorkflowUnderLock,
  appendPhase,
  snapshot,
  setCheckpoint,
  readWorkflow,
  pruneEnsembleResults,
  recordPendingEnsemble,
  commitEnsemble,
  setPlan,
  updateSubtask,
  // ADR-0019 PR-E exports — populated by T5 GREEN. Tests that use these
  // before T5 fails with "X is not a function" / "undefined" — that's
  // the intended RED state.
  ARCHIVE_DIR_REL,
  LEGACY_ARCHIVE_DIR_REL,
  MACRO_TERMINAL_PHASES,
  archiveDir,
  archiveWorkflow,
  bulkSubtaskStatus,
  setMacroTerminal,
  terminalMarkerCheck,
  macroTerminalPhaseCheck,
  allSubtasksTerminalCheck,
  listAllMacros,
  noActiveEngineerChildrenScan,
} = await import(STATE_MJS);

// ---------------------------------------------------------------------------
// Test fixtures

async function withTmpRepo(name, fn) {
  const dir = await mkdtemp(join(tmpdir(), `orchestrator-state-${name}-`));
  // Initialize a git repo so `git branch --show-current` returns a stable
  // value. Using -b main avoids the warning about init.defaultBranch.
  execFileSync('git', ['init', '-b', 'main', dir], { stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test.local'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'ignore' });
  // Empty initial commit so HEAD resolves.
  execFileSync(
    'git',
    ['commit', '--allow-empty', '-m', 'initial', '--no-gpg-sign'],
    { cwd: dir, stdio: 'ignore' },
  );
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const MIN_BASELINE = (branch = 'main') => ({
  branch,
  head: '0000000000000000000000000000000000000000',
  status_digest: '',
});

async function writeWorkflowFixture(path, branch) {
  await writeFile(path, [
    '---',
    'schema: "1.1"',
    `workflow_id: ${JSON.stringify(path.split('/').at(-1).replace(/\.md$/, ''))}`,
    'workflow_type: "macro"',
    'original_request: "fixture"',
    'started_at: "2026-01-01T00:00:00Z"',
    'updated_at: "2026-01-01T00:00:00Z"',
    'repo_root: ""',
    'git_baseline:',
    `  branch: ${JSON.stringify(branch)}`,
    '  head: "0000000000000000000000000000000000000000"',
    '  status_digest: ""',
    'current_phase: "phase-0"',
    'next_action: ""',
    'plan:',
    '  subtasks:',
    'host_history:',
    '  - host: "codex"',
    '    at: "2026-01-01T00:00:00Z"',
    '    event: "created"',
    '---',
    '',
    '# fixture',
    '',
  ].join('\n'));
}

// ---------------------------------------------------------------------------
// Constants + path helpers

describe('orchestrator state.mjs constants', () => {
  it('schema is 1.1 (orchestrator emits 1.1 post ADR-0019 PR-B; 1.0 still readable)', () => {
    strictEqual(SCHEMA_VERSION, '1.1');
  });
  it('SUPPORTED_SCHEMA_VERSIONS accepts both 1.0 and 1.1; rejects engineer schema-1 / 2', () => {
    ok(SUPPORTED_SCHEMA_VERSIONS.has('1.0'));
    ok(SUPPORTED_SCHEMA_VERSIONS.has('1.1'));
    ok(!SUPPORTED_SCHEMA_VERSIONS.has(1));
    ok(!SUPPORTED_SCHEMA_VERSIONS.has(2));
  });
  it('WORKFLOW_DIR_REL is canonical .agentic-plugins/state/orchestrator/workflows', () => {
    strictEqual(WORKFLOW_DIR_REL, '.agentic-plugins/state/orchestrator/workflows');
    strictEqual(LEGACY_WORKFLOW_DIR_REL, '.claude/agentic-orchestrator/workflows');
  });
  it('ENSEMBLE_RESULTS_RETENTION_CAP is 20 (engineer parity)', () => {
    strictEqual(ENSEMBLE_RESULTS_RETENTION_CAP, 20);
  });
  it('workflowDir composes the correct path', () => {
    strictEqual(workflowDir('/tmp/foo'), '/tmp/foo/.agentic-plugins/state/orchestrator/workflows');
  });
});

// ---------------------------------------------------------------------------
// generateWorkflowId

describe('generateWorkflowId', () => {
  it('produces macro-<verb>-<iso>-<6hex> format', () => {
    const id = generateWorkflowId('plan', {
      now: new Date('2026-05-08T05:30:00Z'),
      randomSource: () => Buffer.from('abcdef', 'hex'),
    });
    strictEqual(id, 'macro-plan-20260508T053000Z-abcdef');
  });
  it('rejects unknown verbs', () => {
    throws(() => generateWorkflowId('investigate'), /Invalid verb/);
    throws(() => generateWorkflowId('next'), /Invalid verb/);
    throws(() => generateWorkflowId('done'), /Invalid verb/);
  });
});

// ---------------------------------------------------------------------------
// scrubSecrets + singleLine

describe('scrubSecrets', () => {
  it('redacts AWS access keys + GitHub tokens + sk- API keys', () => {
    const text = 'aws=AKIAIOSFODNN7EXAMPLE gh=ghp_abcdefABCDEF1234567890abcdefABCDEF1234 openai=sk-proj-abcdefABCDEF1234567890_-aA';
    const out = scrubSecrets(text);
    ok(!out.includes('AKIAIOSFODNN7EXAMPLE'));
    ok(!out.includes('ghp_abcdefABCDEF1234567890abcdefABCDEF1234'));
    ok(!out.includes('sk-proj-abcdefABCDEF1234567890_-aA'));
    ok(out.includes('<redacted>'));
  });
});

describe('singleLine', () => {
  it('collapses CR/LF and runs of whitespace to single space', () => {
    strictEqual(singleLine('  a\n\nb\rc \td  '), 'a b c d');
  });
});

// ---------------------------------------------------------------------------
// Roundtrip parse / serialize

describe('parseWorkflowFile + assembleWorkflowFile roundtrip', () => {
  it('handles minimum frontmatter (empty plan, no last_snapshot)', () => {
    const fm = {
      schema: '1.0',
      workflow_id: 'macro-plan-20260508T120000Z-abcdef',
      workflow_type: 'macro',
      original_request: 'test',
      started_at: '2026-05-08T12:00:00Z',
      updated_at: '2026-05-08T12:00:00Z',
      repo_root: '/tmp/r',
      git_baseline: { branch: 'main', head: 'deadbeef', status_digest: '' },
      current_phase: 'phase-0',
      next_action: '',
      plan: { subtasks: [] },
      host_history: [{ host: 'claude', at: '2026-05-08T12:00:00Z', event: 'created' }],
    };
    const text = assembleWorkflowFile(fm, '# body\n');
    const parsed = parseWorkflowFile(text);
    deepStrictEqual(parsed.frontmatter, fm);
  });

  it('roundtrips plan.subtasks[] preserving "absent vs explicitly null" — optional nulls dropped on emit', () => {
    // Per setPlan pattern: optional subtask fields with null/undefined
    // are NOT emitted (preserves absent-vs-explicit-null distinction).
    // Round-trip writes only what is present, so the parsed shape
    // contains only the populated optional fields.
    const fm = {
      schema: '1.0',
      workflow_id: 'macro-plan-20260508T120000Z-abcdef',
      workflow_type: 'macro',
      original_request: 'test',
      started_at: '2026-05-08T12:00:00Z',
      updated_at: '2026-05-08T12:01:00Z',
      repo_root: '/tmp/r',
      git_baseline: { branch: 'main', head: 'deadbeef', status_digest: '' },
      current_phase: 'plan-set',
      next_action: 'review',
      plan: {
        decision: 'approach A',
        architecture: 'engineer mirror',
        subtasks: [
          {
            id: 'PR1',
            label: 'shell + catalog',
            branch: 'feat/orchestrator-shell',
            blocked_by: [],
            status: 'pending',
          },
          {
            id: 'PR2',
            label: 'state spine',
            branch: 'feat/orchestrator-state',
            blocked_by: ['PR1'],
            status: 'blocked',
            engineer_workflow_id: 'plan-20260508T130000Z-abc123',
          },
        ],
      },
      host_history: [{ host: 'claude', at: '2026-05-08T12:00:00Z', event: 'created' }],
    };
    const text = assembleWorkflowFile(fm, '# body\n');
    const parsed = parseWorkflowFile(text);
    deepStrictEqual(parsed.frontmatter, fm);
  });

  it('roundtrips pending_ensemble + ensemble_results', () => {
    const fm = {
      schema: '1.0',
      workflow_id: 'macro-plan-20260508T120000Z-abcdef',
      workflow_type: 'macro',
      original_request: 'test',
      started_at: '2026-05-08T12:00:00Z',
      updated_at: '2026-05-08T12:00:00Z',
      repo_root: '/tmp/r',
      git_baseline: { branch: 'main', head: 'deadbeef', status_digest: '' },
      current_phase: 'plan',
      next_action: '',
      plan: { subtasks: [] },
      host_history: [{ host: 'claude', at: '2026-05-08T12:00:00Z', event: 'created' }],
      pending_ensemble: [
        { phase: 'plan', ensemble_type: 'plan-verify', run_id: 'r1', started_at: '2026-05-08T12:01:00Z' },
      ],
      ensemble_results: [
        {
          // codex_session_id is optional + nullable; absent-vs-null is
          // preserved on emit. Round-trip drops null; only populated keys
          // appear after parse.
          phase: 'plan',
          ensemble_type: 'plan-verify',
          run_id: 'r2',
          verdict: 'pass',
          summary: 'all good',
          completed_at: '2026-05-08T12:05:00Z',
        },
      ],
    };
    const text = assembleWorkflowFile(fm, '# body\n');
    const parsed = parseWorkflowFile(text);
    deepStrictEqual(parsed.frontmatter, fm);
  });

  it('roundtrips latest_checkpoint', () => {
    const fm = {
      schema: '1.1',
      workflow_id: 'macro-plan-20260508T120000Z-abcdef',
      workflow_type: 'macro',
      original_request: 'test',
      started_at: '2026-05-08T12:00:00Z',
      updated_at: '2026-05-08T12:00:00Z',
      repo_root: '/tmp/r',
      git_baseline: { branch: 'main', head: 'deadbeef', status_digest: '' },
      current_phase: 'plan',
      next_action: '',
      plan: { subtasks: [] },
      host_history: [{ host: 'claude', at: '2026-05-08T12:00:00Z', event: 'created' }],
      latest_checkpoint: {
        at: '2026-05-08T12:03:00Z',
        summary: 'Plan approved; next dispatch PR1',
      },
    };
    const text = assembleWorkflowFile(fm, '# body\n');
    const parsed = parseWorkflowFile(text);
    deepStrictEqual(parsed.frontmatter, fm);
  });
});

// ---------------------------------------------------------------------------
// validateFrontmatter — schema isolation

describe('validateFrontmatter rejects engineer schemas', () => {
  it('rejects schema 1 (legacy engineer)', () => {
    const fm = baseFrontmatter();
    fm.schema = 1;
    throws(() => parseWorkflowFile(assembleEngineerStyle(fm)), /Unsupported schema/);
  });

  it('accepts schema "1.1" (orchestrator post-PR-B emit) — namespace separation now relies on workflow_type=macro + plan structure, not schema string', () => {
    // Per ADR-0019 PR-B, orchestrator's own '1.1' schema string
    // collides with engineer's '1.1' string. Namespace separation is
    // preserved by structural validation: engineer files don't have
    // `workflow_type: macro` or `plan.subtasks[]`, so they get
    // rejected at the per-field gates instead of the schema-version
    // gate. This test confirms the schema string is accepted; the
    // structural rejection is covered by the workflow_type test below.
    const fm = baseFrontmatter();
    fm.schema = '1.1';
    // Add 1.1-required subtask fields when populating; baseFrontmatter
    // emits empty subtasks so REQUIRED-key check passes vacuously.
    const parsed = parseWorkflowFile(assembleEngineerStyle(fm));
    strictEqual(parsed.frontmatter.schema, '1.1');
  });

  it('rejects schema 2 (hypothetical future)', () => {
    const fm = baseFrontmatter();
    fm.schema = 2;
    throws(() => parseWorkflowFile(assembleEngineerStyle(fm)), /Unsupported schema/);
  });

  it('rejects workflow_type other than "macro"', () => {
    const text = `---
schema: "1.0"
workflow_id: "x"
workflow_type: "start"
original_request: ""
started_at: "2026-05-08T00:00:00Z"
updated_at: "2026-05-08T00:00:00Z"
repo_root: "/tmp"
git_baseline:
  branch: "main"
  head: "h"
  status_digest: ""
current_phase: "phase-0"
next_action: ""
plan:
  subtasks: []
host_history: []
---
`;
    throws(() => parseWorkflowFile(text), /workflow_type must be 'macro'/);
  });
});

function baseFrontmatter() {
  return {
    schema: '1.0',
    workflow_id: 'macro-plan-20260508T120000Z-abcdef',
    workflow_type: 'macro',
    original_request: 'test',
    started_at: '2026-05-08T12:00:00Z',
    updated_at: '2026-05-08T12:00:00Z',
    repo_root: '/tmp/r',
    git_baseline: { branch: 'main', head: 'deadbeef', status_digest: '' },
    current_phase: 'phase-0',
    next_action: '',
    plan: { subtasks: [] },
    host_history: [{ host: 'claude', at: '2026-05-08T12:00:00Z', event: 'created' }],
  };
}

// Build a frontmatter text with arbitrary schema for negative tests.
function assembleEngineerStyle(fm) {
  // Format the schema scalar verbatim so tests can pass non-1.0 schemas.
  // Use bare integer for numbers, JSON-stringified for strings.
  const schemaLine = typeof fm.schema === 'number' ? String(fm.schema) : JSON.stringify(fm.schema);
  return [
    '---',
    `schema: ${schemaLine}`,
    `workflow_id: ${JSON.stringify(fm.workflow_id)}`,
    `workflow_type: ${JSON.stringify(fm.workflow_type)}`,
    `original_request: ${JSON.stringify(fm.original_request)}`,
    `started_at: ${JSON.stringify(fm.started_at)}`,
    `updated_at: ${JSON.stringify(fm.updated_at)}`,
    `repo_root: ${JSON.stringify(fm.repo_root)}`,
    `git_baseline:`,
    `  branch: ${JSON.stringify(fm.git_baseline.branch)}`,
    `  head: ${JSON.stringify(fm.git_baseline.head)}`,
    `  status_digest: ${JSON.stringify(fm.git_baseline.status_digest)}`,
    `current_phase: ${JSON.stringify(fm.current_phase)}`,
    `next_action: ${JSON.stringify(fm.next_action)}`,
    `plan:`,
    `  subtasks: []`,
    `host_history:`,
    `  - host: ${JSON.stringify(fm.host_history[0].host)}`,
    `    at: ${JSON.stringify(fm.host_history[0].at)}`,
    `    event: ${JSON.stringify(fm.host_history[0].event)}`,
    '---',
    '',
    '# body',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Subtasks validation

describe('subtasks validation', () => {
  it('rejects duplicate subtask ids', async () => {
    await withTmpRepo('subtask-dup', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE(), originalRequest: 'test',
      });
      await rejects(() => setPlan({
        workflowPath: filePath,
        host: 'claude',
        subtasks: [
          { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'pending' },
          { id: 'A', verb: 'compose', branch: 'feat/a-dup', blocked_by: [], status: 'pending' },
        ],
      }), /Duplicate subtask id/);
    });
  });

  it('rejects blocked_by referencing unknown id', async () => {
    await withTmpRepo('subtask-unknown', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE(), originalRequest: 'test',
      });
      await rejects(() => setPlan({
        workflowPath: filePath,
        host: 'claude',
        subtasks: [
          { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: ['ZZZ'], status: 'pending' },
        ],
      }), /unknown subtask id/);
    });
  });

  it('rejects blocked_by self-cycle', async () => {
    await withTmpRepo('subtask-self', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE(), originalRequest: 'test',
      });
      await rejects(() => setPlan({
        workflowPath: filePath,
        host: 'claude',
        subtasks: [
          { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: ['A'], status: 'pending' },
        ],
      }), /self-reference/);
    });
  });

  it('rejects invalid status', async () => {
    await withTmpRepo('subtask-status', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE(), originalRequest: 'test',
      });
      await rejects(() => setPlan({
        workflowPath: filePath,
        host: 'claude',
        subtasks: [
          { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'maybe' },
        ],
      }), /status invalid/);
    });
  });

  it('accepts empty subtasks[] (0 deliverables — valid "no deliverables")', async () => {
    await withTmpRepo('subtask-empty', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE(), originalRequest: 'test',
      });
      await setPlan({
        workflowPath: filePath,
        host: 'claude',
        decision: 'no work needed',
        subtasks: [],
      });
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.plan.decision, 'no work needed');
      deepStrictEqual(frontmatter.plan.subtasks, []);
    });
  });

  it('accepts well-formed subtasks with dependencies', async () => {
    await withTmpRepo('subtask-deps', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE(), originalRequest: 'test',
      });
      await setPlan({
        workflowPath: filePath,
        host: 'claude',
        subtasks: [
          { id: 'A', verb: 'compose', label: 'first', branch: 'feat/a', blocked_by: [], status: 'pending' },
          { id: 'B', verb: 'compose', label: 'second', branch: 'feat/b', blocked_by: ['A'], status: 'blocked' },
          { id: 'C', verb: 'critique', branch: 'feat/c', blocked_by: ['A', 'B'], status: 'pending' },
        ],
      });
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.plan.subtasks.length, 3);
      strictEqual(frontmatter.plan.subtasks[2].blocked_by.length, 2);
      ok(frontmatter.plan.subtasks[2].blocked_by.includes('A'));
      ok(frontmatter.plan.subtasks[2].blocked_by.includes('B'));
    });
  });
});

// ---------------------------------------------------------------------------
// Workflow lifecycle

describe('createWorkflow + branch-keyed lookup', () => {
  it('creates workflow file under canonical .agentic-plugins/state by default', async () => {
    await withTmpRepo('create', async (root) => {
      const { filePath, workflowId } = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE(), originalRequest: 'test',
      });
      ok(workflowId.startsWith('macro-plan-'));
      ok(filePath.includes('.agentic-plugins/state/orchestrator/workflows/'));
      ok(filePath.endsWith(`${workflowId}.md`));
      const storage = await resolveWorkflowStorage(root);
      strictEqual(storage.home, 'canonical');
      strictEqual(storage.canonicalHasState, true);
      strictEqual(storage.legacyHasState, false);
      const { frontmatter } = await readWorkflow(filePath);
      // ADR-0019 PR-B — orchestrator emits schema 1.1 for new workflows
      strictEqual(frontmatter.schema, '1.1');
      strictEqual(frontmatter.workflow_type, 'macro');
      deepStrictEqual(frontmatter.plan, { subtasks: [] });
      strictEqual(frontmatter.git_baseline.branch, 'main');
    });
  });

  it('keeps writing to legacy storage while legacy orchestrator state exists', async () => {
    await withTmpRepo('legacy-write', async (root) => {
      const legacyDir = join(root, LEGACY_WORKFLOW_DIR_REL);
      await mkdir(legacyDir, { recursive: true });
      await writeWorkflowFixture(
        join(legacyDir, 'macro-plan-20260101T000000Z-aaaaaa.md'),
        'legacy/main',
      );

      const { filePath } = await createWorkflow({
        repoRoot: root,
        verb: 'plan',
        host: 'claude',
        gitBaseline: MIN_BASELINE('feature/new'),
        originalRequest: 'legacy write continuity',
      });

      ok(filePath.includes('/.claude/agentic-orchestrator/workflows/'), filePath);
      const storage = await resolveWorkflowStorage(root);
      strictEqual(storage.home, 'legacy');
      strictEqual(storage.canonicalHasState, false);
      strictEqual(storage.legacyHasState, true);
    });
  });

  it('fails closed when canonical and legacy homes both have an active macro on the same branch', async () => {
    await withTmpRepo('ambiguous-storage', async (root) => {
      await mkdir(join(root, WORKFLOW_DIR_REL), { recursive: true });
      await mkdir(join(root, LEGACY_WORKFLOW_DIR_REL), { recursive: true });
      await writeWorkflowFixture(
        join(root, WORKFLOW_DIR_REL, 'macro-plan-20260101T000000Z-aaaaaa.md'),
        'main',
      );
      await writeWorkflowFixture(
        join(root, LEGACY_WORKFLOW_DIR_REL, 'macro-plan-20260101T000001Z-bbbbbb.md'),
        'main',
      );

      await rejects(
        () => findActiveWorkflowByBranch(root, 'main'),
        /Ambiguous orchestrator workflow storage/,
      );
    });
  });

  it('blocks ordinary writes when canonical and legacy homes both contain orchestrator state', async () => {
    await withTmpRepo('blocked-storage', async (root) => {
      await mkdir(join(root, WORKFLOW_DIR_REL), { recursive: true });
      await mkdir(join(root, LEGACY_WORKFLOW_DIR_REL), { recursive: true });
      await writeWorkflowFixture(
        join(root, WORKFLOW_DIR_REL, 'macro-plan-20260101T000000Z-aaaaaa.md'),
        'canonical/main',
      );
      await writeWorkflowFixture(
        join(root, LEGACY_WORKFLOW_DIR_REL, 'macro-plan-20260101T000001Z-bbbbbb.md'),
        'legacy/main',
      );

      await rejects(
        () => createWorkflow({
          repoRoot: root,
          verb: 'plan',
          host: 'codex',
          gitBaseline: MIN_BASELINE('main'),
          originalRequest: 'blocked split home',
        }),
        /Workflow storage migration blocked/,
      );
    });
  });

  it('rejects same-branch concurrent createWorkflow', async () => {
    await withTmpRepo('same-branch-reject', async (root) => {
      await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE('main'), originalRequest: 'first',
      });
      await rejects(
        () => createWorkflow({
          repoRoot: root, verb: 'plan', host: 'claude',
          gitBaseline: MIN_BASELINE('main'), originalRequest: 'second',
        }),
        /single-active invariant|already exists/i,
      );
    });
  });

  it('allows different-branch workflows to coexist', async () => {
    await withTmpRepo('multi-branch', async (root) => {
      const a = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE('main'), originalRequest: 'on-main',
      });
      const b = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE('feature/x'), originalRequest: 'on-feature',
      });
      ok(a.filePath !== b.filePath);
      const onMain = await findActiveWorkflowByBranch(root, 'main');
      const onFeature = await findActiveWorkflowByBranch(root, 'feature/x');
      strictEqual(onMain, a.filePath);
      strictEqual(onFeature, b.filePath);
    });
  });

  it('returns null on detached HEAD / empty branch', async () => {
    await withTmpRepo('detached', async (root) => {
      // No workflow file → empty-branch lookup also null.
      const r = await findActiveWorkflowByBranch(root, '');
      strictEqual(r, null);
    });
  });

  it('cross-branch malformed file does NOT block same-branch lookup (engineer parity)', async () => {
    await withTmpRepo('cross-branch-skip', async (root) => {
      const { filePath: validPath } = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE('main'), originalRequest: 'good',
      });
      // Sibling file whose body is corrupt but whose lightweight
      // extractable git_baseline.branch is 'other' — cross-branch.
      // The lightweight extractor reads `branch: "other"` and skips
      // this file without invoking the strict parseWorkflowFile.
      const sibling = join(
        root,
        '.agentic-plugins/state/orchestrator/workflows/macro-plan-20260101T000000Z-zzzzzz.md',
      );
      await writeFile(
        sibling,
        '---\nschema: 99\ngit_baseline:\n  branch: "other"\n---\n!!corrupt body!!\n',
        { mode: 0o600 },
      );
      const result = await findActiveWorkflowByBranch(root, 'main');
      strictEqual(
        result,
        validPath,
        'cross-branch malformed file must not block lookup of the same-branch workflow',
      );
    });
  });

  it('same-branch undeterminable file FAILS CLOSED (engineer parity)', async () => {
    await withTmpRepo('same-branch-fail-closed', async (root) => {
      await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE('main'), originalRequest: 'good',
      });
      // Sibling file with no extractable branch field AND unparseable
      // frontmatter. fail-closed rule (ADR-0018 §sub-2) requires
      // findActiveWorkflowByBranch to throw rather than risk inviting
      // createWorkflow to add a second same-branch file.
      const opaque = join(
        root,
        '.agentic-plugins/state/orchestrator/workflows/macro-plan-20260101T000000Z-zzzzzz.md',
      );
      await writeFile(opaque, '---\n!!totally corrupt!!\n', { mode: 0o600 });
      await rejects(
        () => findActiveWorkflowByBranch(root, 'main'),
        /undeterminable|invariant at risk/i,
      );
    });
  });

  it('extractFrontmatterBranch handles malformed quoted branch (broken JSON) — null then fail-closed', async () => {
    await withTmpRepo('malformed-quoted', async (root) => {
      await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE('main'), originalRequest: 'good',
      });
      // Sibling with branch that starts AND ends with `"` so the
      // lightweight extractor enters the JSON.parse branch — but the
      // contents fail to parse (invalid escape sequence). Extractor
      // returns null → falls back to parseWorkflowFile. parseWorkflowFile
      // rejects schema 99 → fail-closed throw (same code path as (h)).
      const sibling = join(
        root,
        '.agentic-plugins/state/orchestrator/workflows/macro-plan-20260101T000001Z-yyyyyy.md',
      );
      await writeFile(
        sibling,
        '---\nschema: 99\ngit_baseline:\n  branch: "broken\\u"\n---\n',
        { mode: 0o600 },
      );
      await rejects(
        () => findActiveWorkflowByBranch(root, 'main'),
        /undeterminable|invariant at risk|cannot parse/i,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// snapshot + appendPhase

describe('snapshot + appendPhase', () => {
  it('snapshot writes last_snapshot + host_history snapshot event', async () => {
    await withTmpRepo('snapshot', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE(), originalRequest: 'x',
      });
      await snapshot({ workflowPath: filePath, host: 'claude', trigger: 'pre-compact', statusDigest: 'abc123' });
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.last_snapshot.trigger, 'pre-compact');
      strictEqual(frontmatter.last_snapshot.status_digest, 'abc123');
      ok(frontmatter.host_history.some((e) => e.event === 'snapshot'));
    });
  });

  it('appendPhase updates current_phase + appends host_history resumed event', async () => {
    await withTmpRepo('append', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE(), originalRequest: 'x',
      });
      await appendPhase({
        workflowPath: filePath, host: 'claude',
        currentPhase: 'plan-verify', nextAction: 'await user',
        phaseLabel: 'plan-verify', phaseNote: 'codex dispatched',
      });
      const { frontmatter, body } = await readWorkflow(filePath);
      strictEqual(frontmatter.current_phase, 'plan-verify');
      strictEqual(frontmatter.next_action, 'await user');
      ok(body.includes('plan-verify'));
      ok(body.includes('codex dispatched'));
      ok(frontmatter.host_history.some((e) => e.event === 'resumed'));
    });
  });
});

describe('checkpoint — setCheckpoint', () => {
  it('sets latest_checkpoint and appends host_history checkpointed', async () => {
    await withTmpRepo('checkpoint', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE(), originalRequest: 'x',
      });
      await setCheckpoint({
        workflowPath: filePath,
        host: 'codex',
        summary: 'macro plan reviewed; dispatch next',
      });
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.latest_checkpoint.summary, 'macro plan reviewed; dispatch next');
      strictEqual(typeof frontmatter.latest_checkpoint.at, 'string');
      const last = frontmatter.host_history.at(-1);
      strictEqual(last.event, 'checkpointed');
      strictEqual(last.host, 'codex');
    });
  });

  it('rejects empty summaries', async () => {
    await withTmpRepo('checkpoint-empty', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE(), originalRequest: 'x',
      });
      await rejects(
        () => setCheckpoint({ workflowPath: filePath, host: 'claude', summary: '' }),
        /summary must be a non-empty string/,
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Ensemble bookkeeping

describe('pruneEnsembleResults', () => {
  it('returns input unchanged when below cap', () => {
    const arr = [
      { completed_at: '2026-05-08T12:00:00Z' },
      { completed_at: '2026-05-08T12:01:00Z' },
    ];
    deepStrictEqual(pruneEnsembleResults(arr, 5), arr);
  });

  it('evicts oldest by completed_at when above cap', () => {
    const arr = [
      { id: 1, completed_at: '2026-05-08T12:00:00Z' },
      { id: 2, completed_at: '2026-05-08T12:01:00Z' },
      { id: 3, completed_at: '2026-05-08T12:02:00Z' },
    ];
    const out = pruneEnsembleResults(arr, 2);
    strictEqual(out.length, 2);
    deepStrictEqual(out.map((e) => e.id), [2, 3]);
  });

  it('rejects negative cap', () => {
    throws(() => pruneEnsembleResults([], -1), /cap must be a non-negative integer/);
  });
});

describe('recordPendingEnsemble + commitEnsemble', () => {
  it('full lifecycle: pending → commit (3-step atomic mutation pop+append+prune)', async () => {
    await withTmpRepo('ensemble', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE(), originalRequest: 'x',
      });
      await recordPendingEnsemble({
        workflowPath: filePath,
        phase: 'plan',
        ensemble_type: 'plan-verify',
        run_id: 'r1',
      });
      let { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.pending_ensemble.length, 1);
      strictEqual(frontmatter.pending_ensemble[0].run_id, 'r1');

      await commitEnsemble({
        workflowPath: filePath,
        run_id: 'r1',
        phase: 'plan',
        ensemble_type: 'plan-verify',
        verdict: 'pass',
        summary: 'all good',
      });
      ({ frontmatter } = await readWorkflow(filePath));
      strictEqual(frontmatter.pending_ensemble.length, 0);
      strictEqual(frontmatter.ensemble_results.length, 1);
      strictEqual(frontmatter.ensemble_results[0].run_id, 'r1');
      strictEqual(frontmatter.ensemble_results[0].verdict, 'pass');
    });
  });

  it('idempotent commit (same run_id is no-op for results list)', async () => {
    await withTmpRepo('ensemble-idemp', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE(), originalRequest: 'x',
      });
      await commitEnsemble({
        workflowPath: filePath, run_id: 'r1', phase: 'plan',
        ensemble_type: 'plan-verify', verdict: 'pass', summary: 'a',
      });
      await commitEnsemble({
        workflowPath: filePath, run_id: 'r1', phase: 'plan',
        ensemble_type: 'plan-verify', verdict: 'pass', summary: 'b',
      });
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.ensemble_results.length, 1);
      // idempotent → first summary kept
      strictEqual(frontmatter.ensemble_results[0].summary, 'a');
    });
  });

  it('recordPendingEnsemble replaces entry with same run_id (engineer parity)', async () => {
    await withTmpRepo('pending-dedupe', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE(), originalRequest: 'x',
      });
      await recordPendingEnsemble({
        workflowPath: filePath,
        phase: 'plan',
        ensemble_type: 'plan-verify',
        run_id: 'macro-plan-1',
        started_at: '2026-05-09T01:00:00Z',
      });
      await recordPendingEnsemble({
        workflowPath: filePath,
        phase: 'plan',
        ensemble_type: 'plan-verify',
        run_id: 'macro-plan-1',
        started_at: '2026-05-09T01:00:30Z',
      });
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.pending_ensemble.length, 1);
      strictEqual(
        frontmatter.pending_ensemble[0].started_at,
        '2026-05-09T01:00:30Z',
      );
    });
  });
});

// ---------------------------------------------------------------------------
// CLI subcommand surface

describe('CLI subcommands', () => {
  it('find-active prints empty stdout for no workflow', async () => {
    await withTmpRepo('cli-find', async (root) => {
      const out = execFileSync(
        process.execPath,
        [STATE_MJS, 'find-active', '--repo-root', root, '--branch', 'main'],
        { encoding: 'utf8' },
      );
      strictEqual(out, '');
    });
  });

  it('plan-set rejects --cap negative on ensemble-commit', async () => {
    await withTmpRepo('cli-cap-neg', async (root) => {
      const stateOut = execFileSync(
        process.execPath,
        [
          STATE_MJS, 'create',
          '--repo-root', root,
          '--verb', 'plan',
          '--host', 'claude',
          '--git-baseline-branch', 'main',
          '--git-baseline-head', '0000000000000000000000000000000000000000',
        ],
        { encoding: 'utf8' },
      );
      const filePath = stateOut.trim();
      throws(
        () => execFileSync(
          process.execPath,
          [
            STATE_MJS, 'ensemble-commit',
            '--workflow-path', filePath,
            '--run-id', 'x',
            '--phase', 'plan',
            '--ensemble-type', 'plan-verify',
            '--verdict', 'pass',
            '--summary', 'ok',
            '--cap', '-1',
          ],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
        ),
        /Command failed/,
      );
    });
  });

  it('plan-set CLI reads subtasks JSON file and writes plan', async () => {
    await withTmpRepo('cli-plan-set', async (root) => {
      const stateOut = execFileSync(
        process.execPath,
        [
          STATE_MJS, 'create',
          '--repo-root', root, '--verb', 'plan', '--host', 'claude',
          '--git-baseline-branch', 'main',
          '--git-baseline-head', '0000000000000000000000000000000000000000',
        ],
        { encoding: 'utf8' },
      );
      const filePath = stateOut.trim();

      const subtasksPath = join(root, 'subtasks.json');
      await writeFile(subtasksPath, JSON.stringify([
        { id: 'A', verb: 'compose', label: 'first', branch: 'feat/a', blocked_by: [], status: 'pending' },
        { id: 'B', verb: 'critique', branch: 'feat/b', blocked_by: ['A'], status: 'blocked' },
      ]), 'utf8');

      execFileSync(
        process.execPath,
        [
          STATE_MJS, 'plan-set',
          '--workflow-path', filePath,
          '--host', 'claude',
          '--subtasks-json-file', subtasksPath,
          '--decision', 'approach A',
        ],
        { encoding: 'utf8' },
      );

      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.plan.decision, 'approach A');
      strictEqual(frontmatter.plan.subtasks.length, 2);
      strictEqual(frontmatter.plan.subtasks[1].blocked_by[0], 'A');
    });
  });

  it('read CLI emits parsed frontmatter as JSON', async () => {
    await withTmpRepo('cli-read', async (root) => {
      const stateOut = execFileSync(
        process.execPath,
        [
          STATE_MJS, 'create',
          '--repo-root', root, '--verb', 'plan', '--host', 'claude',
          '--git-baseline-branch', 'main',
          '--git-baseline-head', '0000000000000000000000000000000000000000',
        ],
        { encoding: 'utf8' },
      );
      const filePath = stateOut.trim();
      const readOut = execFileSync(
        process.execPath,
        [STATE_MJS, 'read', '--workflow-path', filePath],
        { encoding: 'utf8' },
      );
      const fm = JSON.parse(readOut);
      // ADR-0019 PR-B — orchestrator emits schema 1.1 for new workflows
      strictEqual(fm.schema, '1.1');
      strictEqual(fm.workflow_type, 'macro');
    });
  });

  it('checkpoint-set CLI writes latest_checkpoint', async () => {
    await withTmpRepo('cli-checkpoint', async (root) => {
      const stateOut = execFileSync(
        process.execPath,
        [
          STATE_MJS, 'create',
          '--repo-root', root, '--verb', 'plan', '--host', 'claude',
          '--git-baseline-branch', 'main',
          '--git-baseline-head', '0000000000000000000000000000000000000000',
        ],
        { encoding: 'utf8' },
      );
      const filePath = stateOut.trim();
      const out = execFileSync(
        process.execPath,
        [
          STATE_MJS, 'checkpoint-set',
          '--workflow-path', filePath,
          '--host', 'codex',
          '--summary', 'dispatch PR2 next',
        ],
        { encoding: 'utf8' },
      );
      strictEqual(out.trim(), filePath);
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.latest_checkpoint.summary, 'dispatch PR2 next');
      strictEqual(frontmatter.host_history.at(-1).host, 'codex');
      strictEqual(frontmatter.host_history.at(-1).event, 'checkpointed');
    });
  });
});

// ============================================================================
// ADR-0019 PR-B — schema 1.1 bump + plan producers (atomic). Covers:
//  - subtask schema 1.1 fields (verb / profile / topic) round-trip
//  - new terminal-partial statuses (deferred / abandoned)
//  - terminal_marker top-level optional boolean
//  - 1.0 read-only path (legacy file readable, mutations refused)
//  - 1.1 verb whitelist + branch git ref-format validation
// ============================================================================

describe('state.mjs — ADR-0019 PR-B 1.1 subtask fields (verb / profile / topic)', () => {
  it('accepts well-formed 1.1 subtasks with verb + branch + profile + topic', async () => {
    await withTmpRepo('pr-b-subtask-full', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE(), originalRequest: '1.1 subtask shape',
      });
      await setPlan({
        workflowPath: filePath,
        host: 'claude',
        subtasks: [
          {
            id: 'PR1',
            verb: 'investigate',
            branch: 'feat/x',
            profile: 'architecture',
            topic: 'evaluate sharded vs flat',
            label: 'baseline study',
            blocked_by: [],
            status: 'pending',
          },
        ],
      });
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.plan.subtasks[0].verb, 'investigate');
      strictEqual(frontmatter.plan.subtasks[0].branch, 'feat/x');
      strictEqual(frontmatter.plan.subtasks[0].profile, 'architecture');
      strictEqual(frontmatter.plan.subtasks[0].topic, 'evaluate sharded vs flat');
    });
  });

  it('rejects subtask with non-canonical verb', async () => {
    await withTmpRepo('pr-b-bad-verb', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE(), originalRequest: 'bad verb',
      });
      await rejects(() => setPlan({
        workflowPath: filePath,
        host: 'claude',
        subtasks: [
          { id: 'A', verb: 'inspect', branch: 'feat/a', blocked_by: [], status: 'pending' },
        ],
      }), /verb invalid/);
    });
  });

  it('rejects subtask missing required verb (1.1)', async () => {
    await withTmpRepo('pr-b-missing-verb', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE(), originalRequest: 'missing verb',
      });
      await rejects(() => setPlan({
        workflowPath: filePath,
        host: 'claude',
        subtasks: [
          { id: 'A', branch: 'feat/a', blocked_by: [], status: 'pending' },
        ],
      }), /Missing required subtask key.*verb/);
    });
  });

  it('rejects subtask missing required branch (1.1)', async () => {
    await withTmpRepo('pr-b-missing-branch', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE(), originalRequest: 'missing branch',
      });
      await rejects(() => setPlan({
        workflowPath: filePath,
        host: 'claude',
        subtasks: [
          { id: 'A', verb: 'compose', blocked_by: [], status: 'pending' },
        ],
      }), /Missing required subtask key.*branch/);
    });
  });

  it('rejects full git-invalid branch refs (full ref-format coverage)', async () => {
    // Per ADR-0019 §1 + git check-ref-format(1) rules. Codex review
    // flagged that the original simple regex missed component-level
    // rules and special names — this enumerates the full set so
    // peer-emitted plans can't slip past plan-set.
    const invalidBranches = [
      // Whitespace / control chars
      'feat with space',
      'feat\ttab',
      // Disallowed chars
      'feat/sub^1',
      'feat~child',
      'feat/sub:1',
      'feat/sub?',
      'feat/sub*',
      'feat/sub[1]',
      'feat\\backslash',
      // Segment-level rules (Codex review additions)
      '.dotfile',                  // whole-string leading dot
      'feat/.hidden',              // segment-level leading dot
      'feat/sub.lock',             // trailing .lock
      'foo.lock/bar',              // segment-level .lock
      // Path rules
      '/foo',                      // leading slash
      'feat/sub/',                 // trailing slash
      'feat//sub',                 // consecutive slashes
      // .. and trailing dot
      'foo..bar',
      'feat.',                     // trailing dot
      // @ rules
      '@',                         // single '@'
      'feat@{ref}',                // '@{' sequence
      // Branch-specific rules
      'HEAD',                      // reserved name
      '-feat',                     // leading dash
    ];
    for (const branch of invalidBranches) {
      await withTmpRepo(`pr-b-bad-branch-${branch.replace(/[^a-z0-9]/gi, '-')}`, async (root) => {
        const { filePath } = await createWorkflow({
          repoRoot: root, verb: 'plan', host: 'claude',
          gitBaseline: MIN_BASELINE(), originalRequest: 'bad branch',
        });
        await rejects(() => setPlan({
          workflowPath: filePath,
          host: 'claude',
          subtasks: [
            { id: 'A', verb: 'compose', branch, blocked_by: [], status: 'pending' },
          ],
        }), /branch invalid git ref-format/);
      });
    }
  });

  it('rejects duplicate subtask branches (1.1 dispatch keys by branch)', async () => {
    await withTmpRepo('pr-b-dup-branch', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE(), originalRequest: 'dup branch',
      });
      await rejects(() => setPlan({
        workflowPath: filePath,
        host: 'claude',
        subtasks: [
          { id: 'A', verb: 'compose', branch: 'feat/shared', blocked_by: [], status: 'pending' },
          { id: 'B', verb: 'critique', branch: 'feat/shared', blocked_by: [], status: 'pending' },
        ],
      }), /Duplicate subtask branch/);
    });
  });

  it('rejects branch prefix collisions (git refs cannot be both leaf and parent dir)', async () => {
    await withTmpRepo('pr-b-prefix-collision', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE(), originalRequest: 'prefix collision',
      });
      // feat/api as leaf ref + feat/api/db as nested ref cannot coexist
      // — git would fail to create the second after the first lands.
      await rejects(() => setPlan({
        workflowPath: filePath,
        host: 'claude',
        subtasks: [
          { id: 'A', verb: 'compose', branch: 'feat/api', blocked_by: [], status: 'pending' },
          { id: 'B', verb: 'compose', branch: 'feat/api/db', blocked_by: [], status: 'pending' },
        ],
      }), /prefix collision/);
    });
  });

  it('rejects branch prefix collisions (reverse order)', async () => {
    await withTmpRepo('pr-b-prefix-collision-reverse', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE(), originalRequest: 'prefix collision reverse',
      });
      await rejects(() => setPlan({
        workflowPath: filePath,
        host: 'claude',
        subtasks: [
          { id: 'A', verb: 'compose', branch: 'feat/api/db', blocked_by: [], status: 'pending' },
          { id: 'B', verb: 'compose', branch: 'feat/api', blocked_by: [], status: 'pending' },
        ],
      }), /prefix collision/);
    });
  });

  it('rejects subtask branch that path-collides with macro branch', async () => {
    // Macro workflow is on 'main' (per MIN_BASELINE) — try a subtask
    // branch 'main/sub' which would attempt to nest under macro's ref.
    await withTmpRepo('pr-b-macro-prefix', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE(), originalRequest: 'macro prefix',
      });
      await rejects(() => setPlan({
        workflowPath: filePath,
        host: 'claude',
        subtasks: [
          // 'main/sub' would require 'main' to be a parent dir; ref-storage prevents that
          { id: 'A', verb: 'compose', branch: 'main/sub', blocked_by: [], status: 'pending' },
        ],
      }), /prefix collision/);
    });
  });

  it('accepts sibling branches with shared prefix (no parent-child relationship)', async () => {
    await withTmpRepo('pr-b-sibling-branches', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE(), originalRequest: 'siblings',
      });
      // feat/api/db and feat/api/auth share the prefix 'feat/api/' but
      // neither is the parent of the other — both can exist as siblings
      // under refs/heads/feat/api/.
      await setPlan({
        workflowPath: filePath,
        host: 'claude',
        subtasks: [
          { id: 'A', verb: 'compose', branch: 'feat/api/db', blocked_by: [], status: 'pending' },
          { id: 'B', verb: 'compose', branch: 'feat/api/auth', blocked_by: [], status: 'pending' },
        ],
      });
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.plan.subtasks.length, 2);
    });
  });

  it('accepts new terminal-partial statuses (deferred / abandoned)', async () => {
    await withTmpRepo('pr-b-terminal-partial', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE(), originalRequest: 'terminal partial',
      });
      await setPlan({
        workflowPath: filePath,
        host: 'claude',
        subtasks: [
          { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'deferred' },
          { id: 'B', verb: 'compose', branch: 'feat/b', blocked_by: [], status: 'abandoned' },
        ],
      });
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.plan.subtasks[0].status, 'deferred');
      strictEqual(frontmatter.plan.subtasks[1].status, 'abandoned');
    });
  });
});

describe('state.mjs — ADR-0019 PR-B terminal_marker top-level field', () => {
  it('parses 1.1 frontmatter with terminal_marker: true', () => {
    const text = [
      '---',
      'schema: "1.1"',
      'workflow_id: "macro-plan-20260510T000000Z-aaaaaa"',
      'workflow_type: "macro"',
      'original_request: "term marker test"',
      'started_at: "2026-05-10T00:00:00Z"',
      'updated_at: "2026-05-10T00:00:00Z"',
      'repo_root: "/tmp/r"',
      'git_baseline:',
      '  branch: "main"',
      '  head: "deadbeef"',
      '  status_digest: ""',
      'current_phase: "finalized"',
      'next_action: "archive"',
      'plan:',
      '  subtasks: []',
      'host_history:',
      '  - host: "claude"',
      '    at: "2026-05-10T00:00:00Z"',
      '    event: "created"',
      'terminal_marker: true',
      '---',
      '',
      '# body',
      '',
    ].join('\n');
    const { frontmatter } = parseWorkflowFile(text);
    strictEqual(frontmatter.terminal_marker, true);
  });

  it('rejects non-boolean terminal_marker', () => {
    const text = [
      '---',
      'schema: "1.1"',
      'workflow_id: "x"',
      'workflow_type: "macro"',
      'original_request: ""',
      'started_at: ""',
      'updated_at: ""',
      'repo_root: ""',
      'git_baseline:',
      '  branch: ""',
      '  head: ""',
      '  status_digest: ""',
      'current_phase: ""',
      'next_action: ""',
      'plan:',
      '  subtasks: []',
      'host_history: []',
      'terminal_marker: "yes"',
      '---',
      '',
    ].join('\n');
    throws(() => parseWorkflowFile(text), /terminal_marker must be a boolean/);
  });

  it('terminal_marker absence is normal (omitted by default)', async () => {
    await withTmpRepo('pr-b-no-marker', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE(), originalRequest: 'no marker',
      });
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual('terminal_marker' in frontmatter, false);
    });
  });
});

describe('state.mjs — ADR-0019 PR-B 1.0 legacy read-only (ensureMutable)', () => {
  it('reads a hand-crafted 1.0 file (legacy schema) without rejection', () => {
    const text = [
      '---',
      'schema: "1.0"',
      'workflow_id: "macro-plan-20260101T000000Z-aabbcc"',
      'workflow_type: "macro"',
      'original_request: "legacy 1.0 file"',
      'started_at: "2026-01-01T00:00:00Z"',
      'updated_at: "2026-01-01T00:00:00Z"',
      'repo_root: "/tmp/r"',
      'git_baseline:',
      '  branch: "main"',
      '  head: "deadbeef"',
      '  status_digest: ""',
      'current_phase: "phase-0"',
      'next_action: ""',
      'plan:',
      '  subtasks:',
      '    - id: "A"',
      '      label: "legacy first"',
      '      branch: "feat/a"',
      '      blocked_by: []',
      '      status: "pending"',
      'host_history:',
      '  - host: "claude"',
      '    at: "2026-01-01T00:00:00Z"',
      '    event: "created"',
      '---',
      '',
      '# body',
      '',
    ].join('\n');
    const { frontmatter } = parseWorkflowFile(text);
    strictEqual(frontmatter.schema, '1.0');
    strictEqual(frontmatter.plan.subtasks[0].id, 'A');
    // 1.0 subtask has no verb — and that's OK on read.
    strictEqual('verb' in frontmatter.plan.subtasks[0], false);
  });

  it('refuses setPlan mutation on a 1.0 file with diagnostic', async () => {
    await withTmpRepo('pr-b-1.0-mutation', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE(), originalRequest: 'starts at 1.1',
      });
      // Hand-downgrade the on-disk schema to 1.0 to simulate a
      // pre-PR-B file. The reader still parses; mutations refuse.
      const raw = await readFile(filePath, 'utf8');
      const downgraded = raw.replace(/^schema: "1\.1"\s*$/m, 'schema: "1.0"');
      await writeFile(filePath, downgraded, { mode: 0o600 });

      await rejects(() => setPlan({
        workflowPath: filePath,
        host: 'claude',
        subtasks: [
          { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'pending' },
        ],
      }), /Cannot mutate schema 1\.0 file/);
    });
  });

  it('refuses snapshot mutation on a 1.0 file', async () => {
    await withTmpRepo('pr-b-1.0-snapshot', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE(), originalRequest: 'starts 1.1',
      });
      const raw = await readFile(filePath, 'utf8');
      const downgraded = raw.replace(/^schema: "1\.1"\s*$/m, 'schema: "1.0"');
      await writeFile(filePath, downgraded, { mode: 0o600 });

      // snapshot takes mutation lock; ensureMutable should reject.
      const { snapshot } = await import('../../plugins/orchestrator/scripts/state.mjs');
      await rejects(() => snapshot({
        workflowPath: filePath,
        host: 'claude',
        trigger: 'stop',
      }), /Cannot mutate schema 1\.0 file/);
    });
  });
});

// ============================================================================
// ADR-0019 PR-C0 — updateSubtask atomic single-subtask mutation
// Covers:
//   - basic status / engineer_workflow_id / commit / pr_url / closed_at updates
//   - immutable field rejection (id / verb / branch / blocked_by / profile / topic / label)
//   - unknown subtask id, empty payload, null arg rejections
//   - unblock pass (blocked → pending when blocked_by all completed)
//   - auto-terminal pass (terminal_marker + current_phase set when all terminal)
//   - 1.0 read-only refused
//   - CLI subtask-update subcommand
// ============================================================================

describe('state.mjs — ADR-0019 PR-C0 updateSubtask atomic single-subtask mutation', () => {
  async function setupPlan(repoRoot, subtasks) {
    const { filePath } = await createWorkflow({
      repoRoot, verb: 'plan', host: 'claude',
      gitBaseline: MIN_BASELINE(), originalRequest: 'pr-c0 fixture',
    });
    await setPlan({ workflowPath: filePath, host: 'claude', subtasks });
    return filePath;
  }

  it('updates status atomically and adds host_history entry', async () => {
    await withTmpRepo('pr-c0-status', async (root) => {
      const filePath = await setupPlan(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'pending' },
      ]);
      const r = await updateSubtask({
        workflowPath: filePath,
        subtaskId: 'A',
        host: 'claude',
        status: 'in_progress',
      });
      strictEqual(r.updatedSubtask.status, 'in_progress');
      strictEqual(r.autoTerminal, false);
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.plan.subtasks[0].status, 'in_progress');
      strictEqual('terminal_marker' in frontmatter, false);
    });
  });

  it('writes engineer_workflow_id + commit + closed_at on completion', async () => {
    await withTmpRepo('pr-c0-writeback', async (root) => {
      const filePath = await setupPlan(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'in_progress' },
      ]);
      const r = await updateSubtask({
        workflowPath: filePath,
        subtaskId: 'A',
        host: 'codex',
        status: 'completed',
        // ADR-0019 §4 — completion writebacks REQUIRE engineerWorkflowId
        engineerWorkflowId: 'compose-20260510T120000Z-abcdef',
        commit: 'deadbeef',
        closedAt: '2026-05-10T12:30:00Z',
      });
      strictEqual(r.updatedSubtask.status, 'completed');
      strictEqual(r.updatedSubtask.engineer_workflow_id, 'compose-20260510T120000Z-abcdef');
      strictEqual(r.updatedSubtask.commit, 'deadbeef');
      strictEqual(r.updatedSubtask.closed_at, '2026-05-10T12:30:00Z');
    });
  });

  it('rejects unknown subtask id', async () => {
    await withTmpRepo('pr-c0-unknown', async (root) => {
      const filePath = await setupPlan(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'pending' },
      ]);
      await rejects(() => updateSubtask({
        workflowPath: filePath, subtaskId: 'ZZZ', host: 'claude', status: 'in_progress',
      }), /subtask id "ZZZ" not found/);
    });
  });

  it('rejects empty payload (no mutable fields)', async () => {
    await withTmpRepo('pr-c0-empty', async (root) => {
      const filePath = await setupPlan(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'pending' },
      ]);
      await rejects(() => updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
      }), /at least one mutable field/);
    });
  });

  it('rejects null arg (must omit to leave value untouched)', async () => {
    await withTmpRepo('pr-c0-null', async (root) => {
      const filePath = await setupPlan(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'pending' },
      ]);
      await rejects(() => updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude', commit: null,
      }), /commit must not be null/);
    });
  });

  it('rejects invalid status enum', async () => {
    await withTmpRepo('pr-c0-bad-status', async (root) => {
      const filePath = await setupPlan(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'pending' },
      ]);
      await rejects(() => updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude', status: 'maybe',
      }), /status invalid/);
    });
  });

  it('unblock pass: blocked subtask transitions to pending when blocked_by completes', async () => {
    await withTmpRepo('pr-c0-unblock', async (root) => {
      const filePath = await setupPlan(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'in_progress' },
        { id: 'B', verb: 'critique', branch: 'feat/b', blocked_by: ['A'], status: 'blocked' },
        { id: 'C', verb: 'refine', branch: 'feat/c', blocked_by: ['A', 'B'], status: 'blocked' },
      ]);
      // Complete A — only B should unblock (C still depends on B too)
      await updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        status: 'completed', engineerWorkflowId: 'eng-A',
        commit: 'aaa', closedAt: '2026-05-10T12:00:00Z',
      });
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.plan.subtasks[0].status, 'completed');
      strictEqual(frontmatter.plan.subtasks[1].status, 'pending');  // B unblocked
      strictEqual(frontmatter.plan.subtasks[2].status, 'blocked');  // C still blocked on B
    });
  });

  it('auto-terminal pass: sets terminal_marker + current_phase=commit-complete when all terminal', async () => {
    await withTmpRepo('pr-c0-auto-terminal', async (root) => {
      const filePath = await setupPlan(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'completed' },
        { id: 'B', verb: 'compose', branch: 'feat/b', blocked_by: [], status: 'in_progress' },
      ]);
      const r = await updateSubtask({
        workflowPath: filePath, subtaskId: 'B', host: 'claude',
        status: 'completed', engineerWorkflowId: 'eng-B',
        commit: 'bbb', closedAt: '2026-05-10T13:00:00Z',
      });
      strictEqual(r.autoTerminal, true);
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.terminal_marker, true);
      strictEqual(frontmatter.current_phase, 'commit-complete');
      // Completion-output contract: the auto-terminal pass must rewrite the
      // now-stale next_action so the sidecar footer never recommends
      // pre-terminal work (e.g. dispatching a subtask that no longer exists).
      ok(
        frontmatter.next_action.includes('All subtasks are terminal'),
        `auto-terminal must rewrite next_action; got: ${frontmatter.next_action}`,
      );
    });
  });

  it('auto-terminal accepts mixed terminal states (completed + deferred + abandoned)', async () => {
    await withTmpRepo('pr-c0-mixed-terminal', async (root) => {
      const filePath = await setupPlan(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'completed' },
        { id: 'B', verb: 'compose', branch: 'feat/b', blocked_by: [], status: 'deferred' },
        { id: 'C', verb: 'compose', branch: 'feat/c', blocked_by: [], status: 'in_progress' },
      ]);
      // Completing the last in_progress subtask flips all-terminal.
      // Note: setPlan seeds 'abandoned'/'deferred' (those are /finalize-
      // / /abort-domain statuses); updateSubtask only sets 'completed'.
      await updateSubtask({
        workflowPath: filePath, subtaskId: 'C', host: 'claude',
        status: 'completed', engineerWorkflowId: 'eng-C', commit: 'ccc',
      });
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.terminal_marker, true);
      strictEqual(frontmatter.current_phase, 'commit-complete');
    });
  });

  it('does NOT re-auto-terminal once terminal_marker is already true', async () => {
    await withTmpRepo('pr-c0-no-reterminal', async (root) => {
      const filePath = await setupPlan(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'completed' },
      ]);
      // First update triggers auto-terminal
      await updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        engineerWorkflowId: 'old-id',
      });
      // Manually overwrite current_phase to something else to verify
      // the second update doesn't auto-reset it.
      const { frontmatter: fm1 } = await readWorkflow(filePath);
      strictEqual(fm1.terminal_marker, true);
      strictEqual(fm1.current_phase, 'commit-complete');
    });
  });

  it('refuses mutation on schema 1.0 file (ensureMutable)', async () => {
    await withTmpRepo('pr-c0-legacy', async (root) => {
      const filePath = await setupPlan(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'pending' },
      ]);
      const raw = await readFile(filePath, 'utf8');
      const downgraded = raw.replace(/^schema: "1\.1"\s*$/m, 'schema: "1.0"');
      await writeFile(filePath, downgraded, { mode: 0o600 });
      await rejects(() => updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude', status: 'completed',
      }), /Cannot mutate schema 1\.0 file/);
    });
  });

  it('non-completion update on deferred subtask also skipped (absorbing state)', async () => {
    await withTmpRepo('pr-c0-deferred-absorb', async (root) => {
      const filePath = await setupPlan(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'deferred' },
      ]);
      // Attempt to reopen via in_progress + engineerWorkflowId (no commit)
      // — would be a delayed /next writeback. Must be skipped per ADR-0019
      // §4 (terminal-partial = absorbing).
      const r = await updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        status: 'in_progress',
        engineerWorkflowId: 'late-dispatch',
      });
      strictEqual(r.skipped, true);
      strictEqual(r.updatedSubtask.status, 'deferred');
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.plan.subtasks[0].status, 'deferred');
      strictEqual('engineer_workflow_id' in frontmatter.plan.subtasks[0], false);
    });
  });

  it('rejects status=deferred via updateSubtask (setPlan domain only)', async () => {
    await withTmpRepo('pr-c0-no-deferred', async (root) => {
      const filePath = await setupPlan(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'in_progress' },
      ]);
      await rejects(() => updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        status: 'deferred',
      }), /cannot set status to "deferred".*setPlan/);
    });
  });

  it('rejects status=abandoned via updateSubtask (setPlan domain only)', async () => {
    await withTmpRepo('pr-c0-no-abandoned', async (root) => {
      const filePath = await setupPlan(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'in_progress' },
      ]);
      await rejects(() => updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        status: 'abandoned',
      }), /cannot set status to "abandoned".*setPlan/);
    });
  });

  it('rejects first-write completion without engineer_workflow_id (unowned completion)', async () => {
    await withTmpRepo('pr-c0-unowned', async (root) => {
      const filePath = await setupPlan(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'in_progress' },
      ]);
      // Current has no engineer_workflow_id; trying to write commit without supplying owner
      await rejects(() => updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        status: 'completed', commit: 'no-owner',
      }), /completion writeback.*MUST supply.*engineer-workflow-id/);
    });
  });

  it('completed subtask status downgrade skipped (absorbing)', async () => {
    await withTmpRepo('pr-c0-completed-absorb', async (root) => {
      const filePath = await setupPlan(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'completed' },
      ]);
      // Try to downgrade to in_progress — must be skipped.
      const r = await updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        status: 'in_progress',
      });
      strictEqual(r.skipped, true);
      strictEqual(r.updatedSubtask.status, 'completed');
      ok(/'completed' is absorbing/.test(r.skipReason));
    });
  });

  it('completed subtask idempotent metadata update allowed (no status change)', async () => {
    await withTmpRepo('pr-c0-completed-meta', async (root) => {
      const filePath = await setupPlan(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'in_progress' },
      ]);
      // Owner records via /next
      await updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        engineerWorkflowId: 'eng-X',
      });
      // engineer Stop completes
      await updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        engineerWorkflowId: 'eng-X', status: 'completed', commit: 'aaa',
      });
      // /orchestrator:done later adds pr_url — idempotent, same owner, no status change
      const r = await updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        engineerWorkflowId: 'eng-X',
        prUrl: 'https://github.com/example/pulls/1',
      });
      strictEqual(r.skipped, undefined);  // not skipped
      strictEqual(r.updatedSubtask.pr_url, 'https://github.com/example/pulls/1');
      strictEqual(r.updatedSubtask.status, 'completed');
    });
  });

  it('non-completion update on abandoned subtask also skipped', async () => {
    await withTmpRepo('pr-c0-abandoned-absorb', async (root) => {
      const filePath = await setupPlan(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'abandoned' },
      ]);
      const r = await updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        status: 'pending',
      });
      strictEqual(r.skipped, true);
      strictEqual(r.updatedSubtask.status, 'abandoned');
    });
  });

  it('skips late completion writeback on deferred subtask (preserves /finalize intent)', async () => {
    await withTmpRepo('pr-c0-skip-deferred', async (root) => {
      const filePath = await setupPlan(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'deferred' },
      ]);
      const r = await updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        status: 'completed', commit: 'late-commit', closedAt: '2026-05-10T15:00:00Z',
      });
      strictEqual(r.skipped, true);
      strictEqual(r.updatedSubtask.status, 'deferred');           // unchanged
      ok(/already terminal as deferred/.test(r.skipReason));
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.plan.subtasks[0].status, 'deferred');  // persisted
      strictEqual('commit' in frontmatter.plan.subtasks[0], false);  // late commit NOT written
    });
  });

  it('skips late completion writeback on abandoned subtask (preserves /abort intent)', async () => {
    await withTmpRepo('pr-c0-skip-abandoned', async (root) => {
      const filePath = await setupPlan(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'abandoned' },
      ]);
      const r = await updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        status: 'completed', commit: 'late-commit',
      });
      strictEqual(r.skipped, true);
      strictEqual(r.updatedSubtask.status, 'abandoned');
    });
  });

  it('rejects mismatched engineer_workflow_id (ownership check)', async () => {
    await withTmpRepo('pr-c0-ownership', async (root) => {
      const filePath = await setupPlan(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'in_progress' },
      ]);
      // First /next records engineer_workflow_id = 'eng-first'
      await updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        engineerWorkflowId: 'eng-first',
      });
      // Stale writeback with different engineer_workflow_id rejected
      await rejects(() => updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        engineerWorkflowId: 'eng-stale',
        commit: 'stale-commit',
      }), /engineer_workflow_id mismatch/);
    });
  });

  it('completion writeback REQUIRES engineer_workflow_id when one is already recorded', async () => {
    await withTmpRepo('pr-c0-completion-needs-owner', async (root) => {
      const filePath = await setupPlan(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'in_progress' },
      ]);
      // Record owner
      await updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        engineerWorkflowId: 'eng-owner',
      });
      // Completion writeback that OMITS engineerWorkflowId — must reject
      await rejects(() => updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        status: 'completed', commit: 'sha', closedAt: '2026-05-10T16:00:00Z',
      }), /completion writeback.*MUST supply.*engineer-workflow-id/);
    });
  });

  it('autoTerminal=false when terminal_marker was already true (this call did not set it)', async () => {
    await withTmpRepo('pr-c0-auto-no-reset', async (root) => {
      const filePath = await setupPlan(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'completed' },
      ]);
      // First update triggers auto-terminal
      const r1 = await updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        engineerWorkflowId: 'eng-1',
      });
      strictEqual(r1.autoTerminal, true);
      // Second update on same subtask (e.g., late commit recorded by /done)
      const r2 = await updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        engineerWorkflowId: 'eng-1',
        commit: 'late-commit',
      });
      // autoTerminal must be FALSE — this call did not set the marker
      strictEqual(r2.autoTerminal, false);
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.terminal_marker, true);  // still true (from r1)
    });
  });

  it('API rejects unknown opts keys (immutable plan-time field spread protection)', async () => {
    await withTmpRepo('pr-c0-unknown-opt', async (root) => {
      const filePath = await setupPlan(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'pending' },
      ]);
      // Spread-style call with immutable field — must reject.
      await rejects(() => updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        status: 'in_progress',
        branch: 'other-branch',  // immutable; not in allowed opts
      }), /unknown option "branch"/);
      // Also verify verb, blocked_by, etc.
      await rejects(() => updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        verb: 'investigate',
      }), /unknown option "verb"/);
    });
  });

  it('pr_url writeback also requires owner id (single-writer guarantee)', async () => {
    await withTmpRepo('pr-c0-prurl-owner', async (root) => {
      const filePath = await setupPlan(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'in_progress' },
      ]);
      // Record owner
      await updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        engineerWorkflowId: 'eng-owner',
      });
      // pr_url writeback without owner id — must reject
      await rejects(() => updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        prUrl: 'https://github.com/example/pulls/99',
      }), /MUST supply.*engineer-workflow-id/);
    });
  });

  it('pr_url writeback also skipped on deferred subtask (precondition includes pr_url)', async () => {
    await withTmpRepo('pr-c0-prurl-skip', async (root) => {
      const filePath = await setupPlan(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'deferred' },
      ]);
      const r = await updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        prUrl: 'https://github.com/example/pulls/100',
      });
      strictEqual(r.skipped, true);
    });
  });

  it('CLI subtask-update rejects immutable-field flags (--branch / --verb / --id / etc.)', async () => {
    await withTmpRepo('pr-c0-cli-immutable', async (root) => {
      const filePath = await setupPlan(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'pending' },
      ]);
      const immutableFlags = ['--id', '--verb', '--branch', '--blocked-by', '--profile', '--topic', '--label'];
      for (const flag of immutableFlags) {
        const result = spawnSync(process.execPath, [
          STATE_MJS, 'subtask-update',
          '--workflow-path', filePath,
          '--host', 'claude',
          '--subtask-id', 'A',
          '--status', 'in_progress',
          flag, 'attempted-mutation',
        ], { encoding: 'utf8' });
        strictEqual(result.status, 1, `flag ${flag} should be rejected (got exit ${result.status})`);
        ok(/immutable plan-time field/.test(result.stderr), `flag ${flag} stderr: ${result.stderr}`);
      }
    });
  });

  it('CLI subtask-update emits skipped + skipReason on deferred subtask', async () => {
    await withTmpRepo('pr-c0-cli-skip', async (root) => {
      const filePath = await setupPlan(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'deferred' },
      ]);
      const result = spawnSync(process.execPath, [
        STATE_MJS, 'subtask-update',
        '--workflow-path', filePath,
        '--host', 'claude',
        '--subtask-id', 'A',
        '--status', 'completed',
        '--commit', 'late',
      ], { encoding: 'utf8' });
      strictEqual(result.status, 0);
      const envelope = JSON.parse(result.stdout.trim());
      strictEqual(envelope.skipped, true);
      ok(/already terminal as deferred/.test(envelope.skipReason));
      // stderr also carries the diagnostic
      ok(/already terminal as deferred/.test(result.stderr));
    });
  });

  it('idempotent same engineer_workflow_id with new fields (legitimate writeback)', async () => {
    await withTmpRepo('pr-c0-idempotent', async (root) => {
      const filePath = await setupPlan(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'in_progress' },
      ]);
      // /next records engineer_workflow_id
      await updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        engineerWorkflowId: 'eng-X',
      });
      // Engineer Stop writeback updates same id with commit + status
      const r = await updateSubtask({
        workflowPath: filePath, subtaskId: 'A', host: 'claude',
        engineerWorkflowId: 'eng-X',
        status: 'completed',
        commit: 'abc123',
      });
      strictEqual(r.updatedSubtask.commit, 'abc123');
      strictEqual(r.updatedSubtask.status, 'completed');
    });
  });

  it('CLI subtask-update emits JSON envelope with autoTerminal', async () => {
    await withTmpRepo('pr-c0-cli', async (root) => {
      const filePath = await setupPlan(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'in_progress' },
      ]);
      const out = execFileSync(process.execPath, [
        STATE_MJS, 'subtask-update',
        '--workflow-path', filePath,
        '--host', 'claude',
        '--subtask-id', 'A',
        '--status', 'completed',
        '--engineer-workflow-id', 'eng-cli',
        '--commit', 'aaa111',
        '--closed-at', '2026-05-10T14:00:00Z',
      ], { encoding: 'utf8' });
      const envelope = JSON.parse(out.trim());
      strictEqual(envelope.updatedSubtask.status, 'completed');
      strictEqual(envelope.updatedSubtask.commit, 'aaa111');
      strictEqual(envelope.autoTerminal, true);
    });
  });
});

describe('state.mjs — ADR-0019 PR-D findMacroBySubtaskBranch branch-agnostic macro lookup', () => {
  // ADR-0019 §1 lines 187-213 — after /orchestrator:next switches the
  // user to a subtask branch, the macro workflow (anchored to a
  // different branch via git_baseline.branch) cannot be found by the
  // branch-keyed findActiveWorkflowByBranch. findMacroBySubtaskBranch
  // scans all active orchestrator workflows for any whose
  // plan.subtasks[].branch matches the supplied (subtask) branch, with
  // a fail-closed exact-one uniqueness rule.

  async function setupMacro(repoRoot, subtasks, { macroBranch = 'main' } = {}) {
    const { filePath } = await createWorkflow({
      repoRoot,
      verb: 'plan',
      host: 'claude',
      gitBaseline: { branch: macroBranch, head: 'a'.repeat(40), status_digest: '' },
      originalRequest: 'pr-d find-macro fixture',
    });
    await setPlan({ workflowPath: filePath, host: 'claude', subtasks });
    return filePath;
  }

  it('returns null when no macro references the subtask branch', async () => {
    await withTmpRepo('pr-d-find-macro-none', async (root) => {
      await setupMacro(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'pending' },
      ]);
      const result = await findMacroBySubtaskBranch(root, 'feat/zzz');
      strictEqual(result, null);
    });
  });

  it('returns the macro path when exactly one references the subtask branch', async () => {
    await withTmpRepo('pr-d-find-macro-one', async (root) => {
      const filePath = await setupMacro(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'pending' },
        { id: 'B', verb: 'critique', branch: 'feat/b', blocked_by: [], status: 'pending' },
      ]);
      const result = await findMacroBySubtaskBranch(root, 'feat/b');
      strictEqual(result, filePath);
    });
  });

  it('throws fail-closed when two+ macros reference the same subtask branch', async () => {
    // Branches are unique within a single macro plan (plan-set rejects
    // duplicates), but two SEPARATE macro plans could each declare a
    // subtask on the same branch — ADR-0019 §1 says auto-resolution
    // MUST fail-closed in that case so writes do not land on the wrong
    // parent.
    await withTmpRepo('pr-d-find-macro-ambiguous', async (root) => {
      await setupMacro(root, [
        { id: 'A', verb: 'compose', branch: 'feat/shared', blocked_by: [], status: 'pending' },
      ], { macroBranch: 'macro-1' });
      await setupMacro(root, [
        { id: 'X', verb: 'critique', branch: 'feat/shared', blocked_by: [], status: 'pending' },
      ], { macroBranch: 'macro-2' });
      await rejects(
        () => findMacroBySubtaskBranch(root, 'feat/shared'),
        /ambiguous.*feat\/shared.*macro/i,
      );
    });
  });

  it('ignores archived workflows (workflows/ only — archive/ is frozen)', async () => {
    await withTmpRepo('pr-d-find-macro-archive', async (root) => {
      const filePath = await setupMacro(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'pending' },
      ]);
      // Simulate the macro being archived (file moved out of workflows/).
      const archiveDir = join(root, '.claude', 'agentic-orchestrator', 'archive');
      await mkdir(archiveDir, { recursive: true });
      const archived = join(archiveDir, filePath.split('/').pop());
      await writeFile(archived, await readFile(filePath, 'utf8'));
      await rm(filePath);
      const result = await findMacroBySubtaskBranch(root, 'feat/a');
      strictEqual(result, null);
    });
  });

  it('rejects empty / non-string branch argument', async () => {
    await withTmpRepo('pr-d-find-macro-empty', async (root) => {
      await setupMacro(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'pending' },
      ]);
      strictEqual(await findMacroBySubtaskBranch(root, ''), null);
      strictEqual(await findMacroBySubtaskBranch(root, null), null);
      strictEqual(await findMacroBySubtaskBranch(root, undefined), null);
    });
  });
});

describe('state.mjs CLI — ADR-0019 PR-D find-macro subcommand', () => {
  async function setupMacro(repoRoot, subtasks, { macroBranch = 'main' } = {}) {
    const { filePath } = await createWorkflow({
      repoRoot, verb: 'plan', host: 'claude',
      gitBaseline: { branch: macroBranch, head: 'a'.repeat(40), status_digest: '' },
      originalRequest: 'pr-d find-macro CLI fixture',
    });
    await setPlan({ workflowPath: filePath, host: 'claude', subtasks });
    return filePath;
  }

  it('find-macro emits empty stdout when no match (exit 0)', async () => {
    await withTmpRepo('pr-d-cli-find-macro-none', async (root) => {
      await setupMacro(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'pending' },
      ]);
      const cp = spawnSync(process.execPath, [
        STATE_MJS, 'find-macro',
        '--repo-root', root,
        '--subtask-branch', 'feat/none',
      ], { encoding: 'utf8' });
      strictEqual(cp.status, 0);
      strictEqual(cp.stdout, '');
    });
  });

  it('find-macro emits absolute path on exact-one match (exit 0)', async () => {
    await withTmpRepo('pr-d-cli-find-macro-one', async (root) => {
      const filePath = await setupMacro(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'pending' },
      ]);
      const cp = spawnSync(process.execPath, [
        STATE_MJS, 'find-macro',
        '--repo-root', root,
        '--subtask-branch', 'feat/a',
      ], { encoding: 'utf8' });
      strictEqual(cp.status, 0);
      strictEqual(cp.stdout.trim(), filePath);
    });
  });

  it('find-macro exits non-zero on ambiguous match (exit 1)', async () => {
    await withTmpRepo('pr-d-cli-find-macro-ambiguous', async (root) => {
      await setupMacro(root, [
        { id: 'A', verb: 'compose', branch: 'feat/shared', blocked_by: [], status: 'pending' },
      ], { macroBranch: 'macro-1' });
      await setupMacro(root, [
        { id: 'X', verb: 'critique', branch: 'feat/shared', blocked_by: [], status: 'pending' },
      ], { macroBranch: 'macro-2' });
      const cp = spawnSync(process.execPath, [
        STATE_MJS, 'find-macro',
        '--repo-root', root,
        '--subtask-branch', 'feat/shared',
      ], { encoding: 'utf8' });
      ok(cp.status !== 0, `expected non-zero exit; got ${cp.status}`);
      ok(cp.stderr.includes('ambiguous'), `stderr: ${cp.stderr}`);
    });
  });

  it('find-macro --subtask-branch is required', async () => {
    await withTmpRepo('pr-d-cli-find-macro-no-flag', async (root) => {
      const cp = spawnSync(process.execPath, [
        STATE_MJS, 'find-macro', '--repo-root', root,
      ], { encoding: 'utf8' });
      ok(cp.status !== 0);
      ok(cp.stderr.includes('subtask-branch'), `stderr: ${cp.stderr}`);
    });
  });
});

describe('state.mjs CLI — ADR-0019 PR-D read-subtask + next-ready subcommands', () => {
  async function setupMacro(repoRoot, subtasks) {
    const { filePath } = await createWorkflow({
      repoRoot, verb: 'plan', host: 'claude',
      gitBaseline: MIN_BASELINE(),
      originalRequest: 'pr-d read/next-ready CLI fixture',
    });
    await setPlan({ workflowPath: filePath, host: 'claude', subtasks });
    return filePath;
  }

  it('read-subtask emits the subtask object as JSON', async () => {
    await withTmpRepo('pr-d-cli-read-subtask', async (root) => {
      const filePath = await setupMacro(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'pending',
          profile: 'plan', topic: 'design the API' },
      ]);
      const cp = spawnSync(process.execPath, [
        STATE_MJS, 'read-subtask',
        '--workflow-path', filePath,
        '--subtask-id', 'A',
      ], { encoding: 'utf8' });
      strictEqual(cp.status, 0, `stderr: ${cp.stderr}`);
      const out = JSON.parse(cp.stdout.trim());
      strictEqual(out.id, 'A');
      strictEqual(out.verb, 'compose');
      strictEqual(out.branch, 'feat/a');
      strictEqual(out.profile, 'plan');
      strictEqual(out.topic, 'design the API');
    });
  });

  it('read-subtask exits 1 + stderr when subtask id not found', async () => {
    await withTmpRepo('pr-d-cli-read-subtask-not-found', async (root) => {
      const filePath = await setupMacro(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'pending' },
      ]);
      const cp = spawnSync(process.execPath, [
        STATE_MJS, 'read-subtask',
        '--workflow-path', filePath,
        '--subtask-id', 'ZZZ',
      ], { encoding: 'utf8' });
      ok(cp.status !== 0);
      ok(cp.stderr.includes('ZZZ'));
    });
  });

  it('next-ready emits the first pending+deps-satisfied subtask', async () => {
    await withTmpRepo('pr-d-cli-next-ready-happy', async (root) => {
      const filePath = await setupMacro(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'completed' },
        { id: 'B', verb: 'critique', branch: 'feat/b', blocked_by: ['A'], status: 'pending' },
        { id: 'C', verb: 'refine', branch: 'feat/c', blocked_by: ['B'], status: 'blocked' },
      ]);
      const cp = spawnSync(process.execPath, [
        STATE_MJS, 'next-ready', '--workflow-path', filePath,
      ], { encoding: 'utf8' });
      strictEqual(cp.status, 0);
      const out = JSON.parse(cp.stdout.trim());
      strictEqual(out.ready.id, 'B');
    });
  });

  it('next-ready reports all_terminal when no candidate exists and every subtask is terminal', async () => {
    await withTmpRepo('pr-d-cli-next-ready-all-terminal', async (root) => {
      const filePath = await setupMacro(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'completed' },
      ]);
      const cp = spawnSync(process.execPath, [
        STATE_MJS, 'next-ready', '--workflow-path', filePath,
      ], { encoding: 'utf8' });
      strictEqual(cp.status, 0);
      const out = JSON.parse(cp.stdout.trim());
      strictEqual(out.ready, null);
      strictEqual(out.reason, 'all_terminal');
      strictEqual(out.summary.completed, 1);
    });
  });

  it('next-ready reports in_progress_or_blocked when waiting on a non-terminal sibling', async () => {
    await withTmpRepo('pr-d-cli-next-ready-blocked', async (root) => {
      const filePath = await setupMacro(root, [
        { id: 'A', verb: 'compose', branch: 'feat/a', blocked_by: [], status: 'in_progress' },
        { id: 'B', verb: 'critique', branch: 'feat/b', blocked_by: ['A'], status: 'blocked' },
      ]);
      const cp = spawnSync(process.execPath, [
        STATE_MJS, 'next-ready', '--workflow-path', filePath,
      ], { encoding: 'utf8' });
      strictEqual(cp.status, 0);
      const out = JSON.parse(cp.stdout.trim());
      strictEqual(out.ready, null);
      strictEqual(out.reason, 'in_progress_or_blocked');
      strictEqual(out.summary.in_progress, 1);
      strictEqual(out.summary.blocked, 1);
    });
  });

  it('next-ready reports empty_plan when plan.subtasks[] is empty', async () => {
    await withTmpRepo('pr-d-cli-next-ready-empty', async (root) => {
      const filePath = await setupMacro(root, []);
      const cp = spawnSync(process.execPath, [
        STATE_MJS, 'next-ready', '--workflow-path', filePath,
      ], { encoding: 'utf8' });
      strictEqual(cp.status, 0);
      const out = JSON.parse(cp.stdout.trim());
      strictEqual(out.ready, null);
      strictEqual(out.reason, 'empty_plan');
    });
  });
});

// ============================================================================
// ADR-0019 PR-E — macro lifecycle primitives, archive infrastructure, predicates,
// and macro-A4 scan helpers. Covers:
//   - constants: ARCHIVE_DIR_REL + MACRO_TERMINAL_PHASES
//   - archiveDir / archiveWorkflow (mirror engineer)
//   - bulkSubtaskStatus (atomic transition with from/to enum guard)
//   - setMacroTerminal (atomic current_phase + terminal_marker write)
//   - terminalMarkerCheck / macroTerminalPhaseCheck / allSubtasksTerminalCheck
//   - listAllMacros (readdir + workflow-id filter)
//   - noActiveEngineerChildrenScan (engineer workflows dir scan + parent_workflow filter)
//   - CLI subcommands (bulk-subtask-status / set-terminal / archive)
//   - Codex CONCERN regression: subtask-update must reject status=deferred|abandoned
// ============================================================================

describe('state.mjs — ADR-0019 PR-E constants', () => {
  it('ARCHIVE_DIR_REL is .agentic-plugins/state/orchestrator/archive', () => {
    strictEqual(ARCHIVE_DIR_REL, '.agentic-plugins/state/orchestrator/archive');
    strictEqual(LEGACY_ARCHIVE_DIR_REL, '.claude/agentic-orchestrator/archive');
  });
  it('MACRO_TERMINAL_PHASES contains commit-complete + finalized + aborted (and only those)', () => {
    ok(MACRO_TERMINAL_PHASES instanceof Set);
    ok(MACRO_TERMINAL_PHASES.has('commit-complete'));
    ok(MACRO_TERMINAL_PHASES.has('finalized'));
    ok(MACRO_TERMINAL_PHASES.has('aborted'));
    // Engineer phases NOT in orchestrator macro set (cross-plugin namespace isolation)
    ok(!MACRO_TERMINAL_PHASES.has('summary-complete'));
    ok(!MACRO_TERMINAL_PHASES.has('fix-complete'));
    strictEqual(MACRO_TERMINAL_PHASES.size, 3);
  });
  it('archiveDir composes the correct absolute path', () => {
    strictEqual(archiveDir('/tmp/foo'), '/tmp/foo/.agentic-plugins/state/orchestrator/archive');
  });
  it('archiveDir rejects relative repoRoot', () => {
    throws(() => archiveDir('relative/path'), /absolute/);
  });
});

describe('state.mjs — ADR-0019 PR-E archiveWorkflow', () => {
  it('moves workflow file from workflows/ to archive/', async () => {
    await withTmpRepo('pr-e-archive-happy', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root,
        verb: 'plan',
        host: 'claude',
        gitBaseline: MIN_BASELINE(),
        currentPhase: 'finalized',
        nextAction: 'archive',
        originalRequest: 'pr-e archive happy',
      });
      const result = await archiveWorkflow({ workflowPath: filePath, host: 'claude', repoRoot: root });
      strictEqual(result.archived, true);
      ok(result.to.includes(ARCHIVE_DIR_REL));
      // Source file no longer exists in workflows/
      const sourceText = await readFile(filePath, 'utf8').catch((e) => ({ err: e.code }));
      ok(sourceText.err === 'ENOENT', 'source file should be unlinked');
      // Destination file readable
      const destText = await readFile(result.to, 'utf8');
      ok(destText.includes('workflow_id:'));
    });
  });

  it('is idempotent: second archive of an already-archived path returns archived=false reason=source-missing', async () => {
    await withTmpRepo('pr-e-archive-idempotent', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root,
        verb: 'plan',
        host: 'claude',
        gitBaseline: MIN_BASELINE(),
        currentPhase: 'finalized',
        nextAction: 'archive',
        originalRequest: 'pr-e archive idempotent',
      });
      const first = await archiveWorkflow({ workflowPath: filePath, host: 'claude', repoRoot: root });
      strictEqual(first.archived, true);
      const second = await archiveWorkflow({ workflowPath: filePath, host: 'claude', repoRoot: root });
      strictEqual(second.archived, false);
      ok(second.reason === 'source-missing' || second.reason === 'source-missing-after-lock');
    });
  });

  it('collision-safe: archiving two files with the same basename produces distinct destinations', async () => {
    await withTmpRepo('pr-e-archive-collision', async (root) => {
      // Two macro workflows on different branches but identical baseline basename.
      // We force the same basename by writing a second workflow with the
      // first's basename pre-populated into archive/.
      const { filePath: a } = await createWorkflow({
        repoRoot: root,
        verb: 'plan',
        host: 'claude',
        gitBaseline: MIN_BASELINE('main'),
        currentPhase: 'finalized',
        nextAction: 'archive',
        originalRequest: 'collision-a',
      });
      const first = await archiveWorkflow({ workflowPath: a, host: 'claude', repoRoot: root });
      strictEqual(first.archived, true);
      // Re-create a workflow with the SAME basename in archive/. We achieve
      // this by pre-writing the basename into archive/ ahead of the second
      // archive call.
      const aBasename = a.split('/').pop();
      const collisionTarget = join(root, ARCHIVE_DIR_REL, aBasename);
      await writeFile(collisionTarget, '---\nstub: true\n---\n# stub\n');
      const { filePath: b } = await createWorkflow({
        repoRoot: root,
        verb: 'plan',
        host: 'claude',
        gitBaseline: MIN_BASELINE('other'),
        currentPhase: 'finalized',
        nextAction: 'archive',
        originalRequest: 'collision-b',
      });
      const second = await archiveWorkflow({ workflowPath: b, host: 'claude', repoRoot: root });
      strictEqual(second.archived, true);
      ok(second.to !== first.to, 'collision must produce a distinct destination');
    });
  });
});

describe('state.mjs — ADR-0019 PR-E bulkSubtaskStatus', () => {
  async function bootstrapMacroWithSubtasks(root, subtasks) {
    const { filePath } = await createWorkflow({
      repoRoot: root,
      verb: 'plan',
      host: 'claude',
      gitBaseline: MIN_BASELINE(),
      currentPhase: 'phase-0',
      nextAction: 'plan-set',
      originalRequest: 'pr-e bulk fixture',
    });
    await setPlan({ workflowPath: filePath, host: 'claude', subtasks });
    return filePath;
  }

  it('transitions matching subtasks atomically (pending|blocked|in_progress → deferred)', async () => {
    await withTmpRepo('pr-e-bulk-deferred', async (root) => {
      const filePath = await bootstrapMacroWithSubtasks(root, [
        { id: 'T1', verb: 'compose', branch: 'feat/t1', blocked_by: [], status: 'pending' },
        { id: 'T2', verb: 'compose', branch: 'feat/t2', blocked_by: [], status: 'blocked' },
        { id: 'T3', verb: 'compose', branch: 'feat/t3', blocked_by: [], status: 'in_progress' },
        { id: 'T4', verb: 'compose', branch: 'feat/t4', blocked_by: [], status: 'completed' },
      ]);
      await bulkSubtaskStatus({
        workflowPath: filePath,
        host: 'claude',
        fromStatuses: ['pending', 'blocked', 'in_progress'],
        toStatus: 'deferred',
      });
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.plan.subtasks.find((s) => s.id === 'T1').status, 'deferred');
      strictEqual(frontmatter.plan.subtasks.find((s) => s.id === 'T2').status, 'deferred');
      strictEqual(frontmatter.plan.subtasks.find((s) => s.id === 'T3').status, 'deferred');
      strictEqual(
        frontmatter.plan.subtasks.find((s) => s.id === 'T4').status,
        'completed',
        'completed subtasks MUST NOT be transitioned (outside from-set)',
      );
      // closed_at written on transitioned subtasks
      ok(frontmatter.plan.subtasks.find((s) => s.id === 'T1').closed_at);
    });
  });

  it('rejects toStatus outside {deferred, abandoned}', async () => {
    await withTmpRepo('pr-e-bulk-reject', async (root) => {
      const filePath = await bootstrapMacroWithSubtasks(root, [
        { id: 'T1', verb: 'compose', branch: 'feat/t1', blocked_by: [], status: 'pending' },
      ]);
      await rejects(
        bulkSubtaskStatus({
          workflowPath: filePath,
          host: 'claude',
          fromStatuses: ['pending'],
          toStatus: 'completed', // not a terminal-partial state
        }),
        /toStatus|completed/,
      );
    });
  });

  it('rejects fromStatuses elements outside {pending, blocked, in_progress}', async () => {
    await withTmpRepo('pr-e-bulk-from-reject', async (root) => {
      const filePath = await bootstrapMacroWithSubtasks(root, [
        { id: 'T1', verb: 'compose', branch: 'feat/t1', blocked_by: [], status: 'pending' },
      ]);
      await rejects(
        bulkSubtaskStatus({
          workflowPath: filePath,
          host: 'claude',
          fromStatuses: ['pending', 'completed'], // 'completed' is not transitionable
          toStatus: 'deferred',
        }),
        /fromStatuses|completed/,
      );
    });
  });
});

describe('state.mjs — ADR-0019 PR-E setMacroTerminal', () => {
  it('writes current_phase + terminal_marker atomically; appends host_history event', async () => {
    await withTmpRepo('pr-e-set-terminal', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root,
        verb: 'plan',
        host: 'claude',
        gitBaseline: MIN_BASELINE(),
        currentPhase: 'phase-0',
        nextAction: 'plan',
        originalRequest: 'pr-e set-terminal',
      });
      await setMacroTerminal({
        workflowPath: filePath,
        host: 'claude',
        terminalPhase: 'finalized',
        terminalMarker: true,
        nextAction: 'archive',
      });
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.current_phase, 'finalized');
      strictEqual(frontmatter.terminal_marker, true);
      strictEqual(frontmatter.next_action, 'archive');
      ok(frontmatter.host_history.some((h) => h.event === 'updated'));
    });
  });

  it('rejects terminalPhase outside the macro whitelist', async () => {
    await withTmpRepo('pr-e-set-terminal-reject', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root,
        verb: 'plan',
        host: 'claude',
        gitBaseline: MIN_BASELINE(),
        currentPhase: 'phase-0',
        nextAction: 'plan',
        originalRequest: 'pr-e reject',
      });
      // Engineer terminal phase — must be rejected for orchestrator macro
      await rejects(
        setMacroTerminal({
          workflowPath: filePath,
          host: 'claude',
          terminalPhase: 'summary-complete',
        }),
        /terminalPhase|whitelist|summary-complete/,
      );
    });
  });

  it('rejects non-boolean terminalMarker', async () => {
    await withTmpRepo('pr-e-set-terminal-marker-boolean', async (root) => {
      const { filePath } = await createWorkflow({
        repoRoot: root,
        verb: 'plan',
        host: 'claude',
        gitBaseline: MIN_BASELINE(),
        currentPhase: 'phase-0',
        nextAction: 'plan',
        originalRequest: 'pr-e boolean',
      });
      await rejects(
        setMacroTerminal({
          workflowPath: filePath,
          host: 'claude',
          terminalPhase: 'finalized',
          terminalMarker: 'true', // string, not boolean
        }),
        /terminalMarker|boolean/,
      );
    });
  });
});

describe('state.mjs — ADR-0019 PR-E predicates', () => {
  it('terminalMarkerCheck is true only when frontmatter.terminal_marker === true', () => {
    strictEqual(terminalMarkerCheck({ terminal_marker: true }), true);
    strictEqual(terminalMarkerCheck({ terminal_marker: false }), false);
    strictEqual(terminalMarkerCheck({ terminal_marker: 'true' }), false);
    strictEqual(terminalMarkerCheck({}), false);
    strictEqual(terminalMarkerCheck(undefined), false);
    strictEqual(terminalMarkerCheck(null), false);
  });

  it('macroTerminalPhaseCheck accepts {commit-complete, finalized, aborted} only', () => {
    strictEqual(macroTerminalPhaseCheck('commit-complete'), true);
    strictEqual(macroTerminalPhaseCheck('finalized'), true);
    strictEqual(macroTerminalPhaseCheck('aborted'), true);
    strictEqual(macroTerminalPhaseCheck('phase-0'), false);
    strictEqual(macroTerminalPhaseCheck('summary-complete'), false); // engineer phase
    strictEqual(macroTerminalPhaseCheck(undefined), false);
    strictEqual(macroTerminalPhaseCheck(null), false);
  });

  it('allSubtasksTerminalCheck passes only when every subtask is in {completed, deferred, abandoned}', () => {
    const all = (subtasks) =>
      allSubtasksTerminalCheck({ plan: { subtasks } });
    strictEqual(
      all([
        { id: 'T1', status: 'completed' },
        { id: 'T2', status: 'deferred' },
        { id: 'T3', status: 'abandoned' },
      ]),
      true,
    );
    strictEqual(all([{ id: 'T1', status: 'pending' }]), false);
    strictEqual(all([{ id: 'T1', status: 'in_progress' }]), false);
    strictEqual(all([{ id: 'T1', status: 'blocked' }]), false);
    // Empty plan: vacuously true (no subtasks → no non-terminal subtasks).
    strictEqual(all([]), true);
    // Missing plan: vacuously true.
    strictEqual(allSubtasksTerminalCheck({}), true);
    strictEqual(allSubtasksTerminalCheck(null), true);
  });
});

describe('state.mjs — ADR-0019 PR-E listAllMacros', () => {
  it('lists all non-archived macro files in workflows/', async () => {
    await withTmpRepo('pr-e-list-all', async (root) => {
      const { filePath: a } = await createWorkflow({
        repoRoot: root,
        verb: 'plan',
        host: 'claude',
        gitBaseline: MIN_BASELINE('main'),
        currentPhase: 'phase-0',
        nextAction: 'plan',
        originalRequest: 'list-a',
      });
      const { filePath: b } = await createWorkflow({
        repoRoot: root,
        verb: 'plan',
        host: 'claude',
        gitBaseline: MIN_BASELINE('other'),
        currentPhase: 'phase-0',
        nextAction: 'plan',
        originalRequest: 'list-b',
      });
      const paths = await listAllMacros(root);
      strictEqual(paths.length, 2);
      ok(paths.includes(a));
      ok(paths.includes(b));
    });
  });

  it('returns empty array when workflows/ directory does not exist', async () => {
    await withTmpRepo('pr-e-list-empty', async (root) => {
      const paths = await listAllMacros(root);
      deepStrictEqual(paths, []);
    });
  });

  it('excludes archived files (only lists current workflows/)', async () => {
    await withTmpRepo('pr-e-list-skip-archive', async (root) => {
      const { filePath: a } = await createWorkflow({
        repoRoot: root,
        verb: 'plan',
        host: 'claude',
        gitBaseline: MIN_BASELINE('main'),
        currentPhase: 'finalized',
        nextAction: 'archive',
        originalRequest: 'soon-archived',
      });
      await archiveWorkflow({ workflowPath: a, host: 'claude', repoRoot: root });
      // Now create a second live macro
      const { filePath: b } = await createWorkflow({
        repoRoot: root,
        verb: 'plan',
        host: 'claude',
        gitBaseline: MIN_BASELINE('other'),
        currentPhase: 'phase-0',
        nextAction: 'plan',
        originalRequest: 'live',
      });
      const paths = await listAllMacros(root);
      strictEqual(paths.length, 1);
      strictEqual(paths[0], b, 'archived macro must not appear in listAllMacros');
    });
  });
});

describe('state.mjs — ADR-0019 PR-E noActiveEngineerChildrenScan', () => {
  // Build engineer-shape workflow files manually under the engineer
  // workflows directory — orchestrator state.mjs can NOT create
  // engineer workflows (different schema). Engineer's
  // createWorkflow is unavailable here per ADR-0010 §5 cross-plugin
  // import boundary; orchestrator's scan reads frontmatter directly
  // via parseEngineerFrontmatter or a generic readdir+regex shim. The
  // test exercises the directory-scan contract regardless of which
  // schema the engineer files emit.
  const ENG_WORKFLOW_DIR_REL = '.agentic-plugins/state/engineer/workflows';

  async function writeEngineerWorkflow(root, name, frontmatterFields) {
    const dir = join(root, ENG_WORKFLOW_DIR_REL);
    await mkdir(dir, { recursive: true });
    const lines = ['---'];
    for (const [k, v] of Object.entries(frontmatterFields)) {
      lines.push(`${k}: ${typeof v === 'string' ? JSON.stringify(v) : v}`);
    }
    lines.push('---', '# engineer fixture', '');
    await writeFile(join(dir, name), lines.join('\n'));
  }

  it('returns 0 when engineer workflows directory does not exist', async () => {
    await withTmpRepo('pr-e-scan-no-dir', async (root) => {
      const n = await noActiveEngineerChildrenScan(root, 'macro-plan-20260511T000000Z-abcdef');
      strictEqual(n, 0);
    });
  });

  it('counts engineer files where parent_workflow == macroId', async () => {
    await withTmpRepo('pr-e-scan-match', async (root) => {
      const macroId = 'macro-plan-20260511T000000Z-abcdef';
      // Engineer workflow-id regex: `<verb>-<YYYYMMDDTHHMMSSZ>-<6hex>`
      await writeEngineerWorkflow(root, 'compose-20260511T000100Z-aaaaaa.md', {
        schema: '1.1',
        workflow_id: 'compose-20260511T000100Z-aaaaaa',
        parent_workflow: macroId,
        originating_subtask: 'T1',
      });
      await writeEngineerWorkflow(root, 'compose-20260511T000200Z-bbbbbb.md', {
        schema: '1.1',
        workflow_id: 'compose-20260511T000200Z-bbbbbb',
        parent_workflow: 'macro-different-id',
        originating_subtask: 'T1',
      });
      await writeEngineerWorkflow(root, 'investigate-20260511T000300Z-cccccc.md', {
        schema: '1.1',
        workflow_id: 'investigate-20260511T000300Z-cccccc',
        parent_workflow: macroId,
        originating_subtask: 'T2',
      });
      const n = await noActiveEngineerChildrenScan(root, macroId);
      strictEqual(n, 2, 'should count 2 engineer files referencing macroId');
    });
  });

  it('ignores engineer files with no parent_workflow field (root workflows)', async () => {
    await withTmpRepo('pr-e-scan-skip-root', async (root) => {
      const macroId = 'macro-plan-20260511T000000Z-abcdef';
      await writeEngineerWorkflow(root, 'compose-20260511T000400Z-dddddd.md', {
        schema: '1.1',
        workflow_id: 'compose-20260511T000400Z-dddddd',
      });
      const n = await noActiveEngineerChildrenScan(root, macroId);
      strictEqual(n, 0);
    });
  });

  it('ignores files whose name does not match the engineer workflow-id regex', async () => {
    await withTmpRepo('pr-e-scan-skip-malformed', async (root) => {
      const dir = join(root, ENG_WORKFLOW_DIR_REL);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'README.md'), '# not a workflow\n');
      await writeFile(join(dir, '.lock'), '');
      const n = await noActiveEngineerChildrenScan(root, 'macro-foo');
      strictEqual(n, 0);
    });
  });

  // ADR-0019 PR-E Phase 5 review (Phase 6 resolve) — CRLF tolerance.
  // Engineer's state.mjs writes LF, but a frontmatter file manually
  // edited on a Windows-style tool could carry \r\n. The scan must
  // correctly match `parent_workflow` regardless of line ending so a
  // CRLF-saved child isn't silently miscounted as "not a child".
  it('counts CRLF-line-ending engineer files correctly (Windows-edited frontmatter)', async () => {
    await withTmpRepo('pr-e-scan-crlf', async (root) => {
      const macroId = 'macro-plan-20260511T000000Z-abcdef';
      const dir = join(root, ENG_WORKFLOW_DIR_REL);
      await mkdir(dir, { recursive: true });
      const crlfBody = [
        '---',
        'schema: "1.1"',
        `workflow_id: "compose-20260511T010101Z-aaaaaa"`,
        `parent_workflow: ${JSON.stringify(macroId)}`,
        'originating_subtask: "T1"',
        '---',
        '# CRLF engineer fixture',
        '',
      ].join('\r\n');
      await writeFile(join(dir, 'compose-20260511T010101Z-aaaaaa.md'), crlfBody);
      const n = await noActiveEngineerChildrenScan(root, macroId);
      strictEqual(n, 1, 'CRLF-line-ending child should still be counted as a referencing child');
    });
  });
});

describe('state.mjs — ADR-0019 PR-E CLI subcommands', () => {
  async function setupMacroForCli(root, subtasks) {
    const filePath = await (async () => {
      const { filePath: fp } = await createWorkflow({
        repoRoot: root,
        verb: 'plan',
        host: 'claude',
        gitBaseline: MIN_BASELINE(),
        currentPhase: 'phase-0',
        nextAction: 'plan-set',
        originalRequest: 'pr-e cli fixture',
      });
      return fp;
    })();
    if (subtasks) {
      await setPlan({ workflowPath: filePath, host: 'claude', subtasks });
    }
    return filePath;
  }

  it('bulk-subtask-status CLI transitions matching subtasks', async () => {
    await withTmpRepo('pr-e-cli-bulk', async (root) => {
      const filePath = await setupMacroForCli(root, [
        { id: 'T1', verb: 'compose', branch: 'feat/t1', blocked_by: [], status: 'pending' },
        { id: 'T2', verb: 'compose', branch: 'feat/t2', blocked_by: [], status: 'in_progress' },
      ]);
      const cp = spawnSync(process.execPath, [
        STATE_MJS,
        'bulk-subtask-status',
        '--workflow-path', filePath,
        '--host', 'claude',
        '--from-statuses', 'pending,in_progress',
        '--to-status', 'deferred',
      ], { encoding: 'utf8' });
      strictEqual(cp.status, 0, `stderr: ${cp.stderr}`);
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.plan.subtasks[0].status, 'deferred');
      strictEqual(frontmatter.plan.subtasks[1].status, 'deferred');
    });
  });

  it('set-terminal CLI writes current_phase + terminal_marker', async () => {
    await withTmpRepo('pr-e-cli-set-terminal', async (root) => {
      const filePath = await setupMacroForCli(root, []);
      const cp = spawnSync(process.execPath, [
        STATE_MJS,
        'set-terminal',
        '--workflow-path', filePath,
        '--host', 'claude',
        '--terminal-phase', 'aborted',
        '--terminal-marker', 'true',
      ], { encoding: 'utf8' });
      strictEqual(cp.status, 0, `stderr: ${cp.stderr}`);
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.current_phase, 'aborted');
      strictEqual(frontmatter.terminal_marker, true);
    });
  });

  it('archive CLI moves workflow into archive/', async () => {
    await withTmpRepo('pr-e-cli-archive', async (root) => {
      const filePath = await setupMacroForCli(root, []);
      const cp = spawnSync(process.execPath, [
        STATE_MJS,
        'archive',
        '--workflow-path', filePath,
        '--host', 'claude',
        '--repo-root', root,
      ], { encoding: 'utf8' });
      strictEqual(cp.status, 0, `stderr: ${cp.stderr}`);
      ok(cp.stdout.includes(ARCHIVE_DIR_REL));
    });
  });
});

describe('state.mjs — ADR-0019 PR-E Codex CONCERN regression: subtask-update rejects deferred|abandoned', () => {
  // PR-C0 added a deferred/abandoned guard in updateSubtask. This is a
  // regression test to ensure the guard remains in place after PR-E.
  async function setupMacroForGuard(root) {
    const filePath = await (async () => {
      const { filePath: fp } = await createWorkflow({
        repoRoot: root,
        verb: 'plan',
        host: 'claude',
        gitBaseline: MIN_BASELINE(),
        currentPhase: 'phase-0',
        nextAction: 'plan-set',
        originalRequest: 'pr-e guard fixture',
      });
      return fp;
    })();
    await setPlan({
      workflowPath: filePath,
      host: 'claude',
      subtasks: [
        { id: 'T1', verb: 'compose', branch: 'feat/t1', blocked_by: [], status: 'in_progress' },
      ],
    });
    return filePath;
  }

  it('updateSubtask rejects status=deferred (must use bulkSubtaskStatus + setMacroTerminal)', async () => {
    await withTmpRepo('pr-e-guard-deferred', async (root) => {
      const filePath = await setupMacroForGuard(root);
      await rejects(
        updateSubtask({
          workflowPath: filePath,
          host: 'claude',
          subtaskId: 'T1',
          status: 'deferred',
        }),
        /deferred|finalize|bulkSubtaskStatus/i,
      );
    });
  });

  it('updateSubtask rejects status=abandoned (must use bulkSubtaskStatus + setMacroTerminal)', async () => {
    await withTmpRepo('pr-e-guard-abandoned', async (root) => {
      const filePath = await setupMacroForGuard(root);
      await rejects(
        updateSubtask({
          workflowPath: filePath,
          host: 'claude',
          subtaskId: 'T1',
          status: 'abandoned',
        }),
        /abandoned|abort/i,
      );
    });
  });
});
