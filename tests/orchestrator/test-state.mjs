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
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const STATE_MJS = resolve(REPO_ROOT, 'plugins/orchestrator/scripts/state.mjs');

const {
  SCHEMA_VERSION,
  SUPPORTED_SCHEMA_VERSIONS,
  WORKFLOW_DIR_REL,
  ENSEMBLE_RESULTS_RETENTION_CAP,
  workflowDir,
  workflowFilePath,
  generateWorkflowId,
  withDirectoryLock,
  withFileLock,
  currentGitBranch,
  findActiveWorkflowByBranch,
  findActiveWorkflow,
  parseWorkflowFile,
  assembleWorkflowFile,
  scrubSecrets,
  singleLine,
  createWorkflow,
  createWorkflowUnderLock,
  appendPhase,
  snapshot,
  readWorkflow,
  pruneEnsembleResults,
  recordPendingEnsemble,
  commitEnsemble,
  setPlan,
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

// ---------------------------------------------------------------------------
// Constants + path helpers

describe('orchestrator state.mjs constants', () => {
  it('schema is 1.0 (orchestrator-only)', () => {
    strictEqual(SCHEMA_VERSION, '1.0');
  });
  it('SUPPORTED_SCHEMA_VERSIONS rejects engineer 1, "1.1", 2', () => {
    ok(SUPPORTED_SCHEMA_VERSIONS.has('1.0'));
    ok(!SUPPORTED_SCHEMA_VERSIONS.has(1));
    ok(!SUPPORTED_SCHEMA_VERSIONS.has('1.1'));
    ok(!SUPPORTED_SCHEMA_VERSIONS.has(2));
  });
  it('WORKFLOW_DIR_REL is .claude/agentic-orchestrator/workflows', () => {
    strictEqual(WORKFLOW_DIR_REL, '.claude/agentic-orchestrator/workflows');
  });
  it('ENSEMBLE_RESULTS_RETENTION_CAP is 20 (engineer parity)', () => {
    strictEqual(ENSEMBLE_RESULTS_RETENTION_CAP, 20);
  });
  it('workflowDir composes the correct path', () => {
    strictEqual(workflowDir('/tmp/foo'), '/tmp/foo/.claude/agentic-orchestrator/workflows');
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
});

// ---------------------------------------------------------------------------
// validateFrontmatter — schema isolation

describe('validateFrontmatter rejects engineer schemas', () => {
  it('rejects schema 1 (legacy engineer)', () => {
    const fm = baseFrontmatter();
    fm.schema = 1;
    throws(() => parseWorkflowFile(assembleEngineerStyle(fm)), /Unsupported schema/);
  });

  it('rejects schema "1.1" (current engineer)', () => {
    const fm = baseFrontmatter();
    fm.schema = '1.1';
    throws(() => parseWorkflowFile(assembleEngineerStyle(fm)), /Unsupported schema/);
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
          { id: 'A', blocked_by: [], status: 'pending' },
          { id: 'A', blocked_by: [], status: 'pending' },
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
          { id: 'A', blocked_by: ['ZZZ'], status: 'pending' },
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
          { id: 'A', blocked_by: ['A'], status: 'pending' },
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
          { id: 'A', blocked_by: [], status: 'maybe' },
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
          { id: 'A', label: 'first', branch: 'feat/a', blocked_by: [], status: 'pending' },
          { id: 'B', label: 'second', branch: 'feat/b', blocked_by: ['A'], status: 'blocked' },
          { id: 'C', blocked_by: ['A', 'B'], status: 'pending' },
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
  it('creates workflow file at agentic-orchestrator/workflows/<id>.md', async () => {
    await withTmpRepo('create', async (root) => {
      const { filePath, workflowId } = await createWorkflow({
        repoRoot: root, verb: 'plan', host: 'claude',
        gitBaseline: MIN_BASELINE(), originalRequest: 'test',
      });
      ok(workflowId.startsWith('macro-plan-'));
      ok(filePath.includes('.claude/agentic-orchestrator/workflows/'));
      ok(filePath.endsWith(`${workflowId}.md`));
      const { frontmatter } = await readWorkflow(filePath);
      strictEqual(frontmatter.schema, '1.0');
      strictEqual(frontmatter.workflow_type, 'macro');
      deepStrictEqual(frontmatter.plan, { subtasks: [] });
      strictEqual(frontmatter.git_baseline.branch, 'main');
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
        { id: 'A', label: 'first', branch: 'feat/a', blocked_by: [], status: 'pending' },
        { id: 'B', blocked_by: ['A'], status: 'blocked' },
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
      strictEqual(fm.schema, '1.0');
      strictEqual(fm.workflow_type, 'macro');
    });
  });
});
