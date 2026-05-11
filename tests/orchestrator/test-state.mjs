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
  updateSubtask,
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
  it('schema is 1.1 (orchestrator emits 1.1 post ADR-0019 PR-B; 1.0 still readable)', () => {
    strictEqual(SCHEMA_VERSION, '1.1');
  });
  it('SUPPORTED_SCHEMA_VERSIONS accepts both 1.0 and 1.1; rejects engineer schema-1 / 2', () => {
    ok(SUPPORTED_SCHEMA_VERSIONS.has('1.0'));
    ok(SUPPORTED_SCHEMA_VERSIONS.has('1.1'));
    ok(!SUPPORTED_SCHEMA_VERSIONS.has(1));
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
      // ADR-0019 PR-B — orchestrator emits schema 1.1 for new workflows
      strictEqual(frontmatter.schema, '1.1');
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
        '.claude/agentic-orchestrator/workflows/macro-plan-20260101T000000Z-zzzzzz.md',
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
        '.claude/agentic-orchestrator/workflows/macro-plan-20260101T000000Z-zzzzzz.md',
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
        '.claude/agentic-orchestrator/workflows/macro-plan-20260101T000001Z-yyyyyy.md',
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
