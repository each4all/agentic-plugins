// plugins/engineer — ensemble_results frontmatter wiring tests
// (ADR-0017 §sub-decision 4).
//
// Validation contract per ADR-0017 §sub-decision 4:
//   - `dispatch-peer.mjs --workflow-path …` records a pending_ensemble
//     entry under the workflow file's per-file lock BEFORE the
//     companion is spawned.
//   - `state.mjs ensemble-commit` performs the three-step atomic
//     mutation (pop matching pending → append result → prune to cap)
//     in a single lock window.
//   - The retention cap (`ENSEMBLE_RESULTS_RETENTION_CAP = 20`) FIFO-
//     evicts oldest entries on append.
//   - Schema-1.0 readers tolerantly accept the new field on disk; the
//     next write upgrades the schema marker.
//
// Unit-level coverage of `pruneEnsembleResults`, `recordPendingEnsemble`,
// and `commitEnsemble` semantics lives in `tests/engineer/test-state.mjs`
// (lines 629/680/738). This file exercises the integration surfaces:
// `dispatch-peer.mjs` CLI all-or-nothing validation + the
// pending_ensemble-recording side-effect, plus the `ensemble-commit`
// CLI round-trip and the schema-1.0 read tolerance contract.
//
// Run via `node --test tests/engineer/test-ensemble-results.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual, match } from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const STATE_PATH = resolve(REPO_ROOT, 'plugins/engineer/scripts/state.mjs');
const DISPATCH_PATH = resolve(
  REPO_ROOT,
  'plugins/engineer/scripts/dispatch-peer.mjs',
);

const {
  createWorkflow,
  listWorkflowFiles,
  readWorkflow,
  ENSEMBLE_RESULTS_RETENTION_CAP,
} = await import(STATE_PATH);

const MIN_BASELINE = {
  branch: 'test',
  head: '0'.repeat(40),
  status_digest: '',
};

// Real git repo so findActiveWorkflow's `git branch --show-current`
// probe (ADR-0018 §sub-2) returns the expected name.
function gitInit(dir, branch) {
  execFileSync('git', ['init', '-q', '-b', branch], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: dir, stdio: 'ignore' });
}

async function withTmpRepo(fn, { branch = 'test' } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'engineer-ensemble-results-'));
  try {
    gitInit(dir, branch);
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- dispatch-peer.mjs CLI bookkeeping flag validation ---------------------

describe('dispatch-peer.mjs — ensemble bookkeeping flag validation', () => {
  it('rejects partial bookkeeping flags (only --workflow-path supplied)', async () => {
    await withTmpRepo(async (repoRoot) => {
      const promptFile = join(repoRoot, 'p.txt');
      await writeFile(promptFile, 'verbatim');
      const cp = spawnSync(
        process.execPath,
        [
          DISPATCH_PATH,
          '--peer',
          'codex',
          '--prompt-file',
          promptFile,
          '--workflow-path',
          join(repoRoot, 'fake.md'),
          // intentionally missing --phase / --ensemble-type / --run-id
        ],
        { encoding: 'utf8' },
      );
      strictEqual(cp.status, 2, `expected misuse exit 2; stderr: ${cp.stderr}`);
      match(cp.stderr, /requires.*phase.*ensemble-type.*run-id/);
    });
  });

  it('rejects partial bookkeeping flags (missing --run-id only)', async () => {
    await withTmpRepo(async (repoRoot) => {
      const promptFile = join(repoRoot, 'p.txt');
      await writeFile(promptFile, 'verbatim');
      const cp = spawnSync(
        process.execPath,
        [
          DISPATCH_PATH,
          '--peer',
          'codex',
          '--prompt-file',
          promptFile,
          '--workflow-path',
          join(repoRoot, 'fake.md'),
          '--phase',
          'compose',
          '--ensemble-type',
          'plan-verify',
          // missing --run-id
        ],
        { encoding: 'utf8' },
      );
      strictEqual(cp.status, 2);
      match(cp.stderr, /missing:.*runId/);
    });
  });
});

// --- dispatch-peer.mjs records pending_ensemble before companion spawn -----

describe('dispatch-peer.mjs --workflow-path → pending_ensemble side effect', () => {
  it('records a pending_ensemble entry even when companion lookup fails', async () => {
    await withTmpRepo(async (repoRoot) => {
      // Create a real workflow file under the repo so dispatch-peer can
      // find it and acquire its per-file lock.
      await createWorkflow({
        repoRoot,
        verb: 'compose',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'pending registration test',
      });
      const [workflowPath] = await listWorkflowFiles(repoRoot);

      // Strip env so companion lookup misses cleanly (exit 3,
      // companion_error). The pending registration has already happened
      // by the time the lookup miss returns — this is the contract: the
      // pending entry is durable even if the companion is unavailable.
      const cleanEnv = { ...process.env };
      delete cleanEnv.AGENTIC_COMPANIONS_ROOT;
      cleanEnv.HOME = repoRoot;

      const promptFile = join(repoRoot, 'p.txt');
      await writeFile(promptFile, 'verbatim probe');
      const runId = 'plan-verify-20260507T060000Z-aaaaaa';

      const cp = spawnSync(
        process.execPath,
        [
          DISPATCH_PATH,
          '--peer',
          'codex',
          '--prompt-file',
          promptFile,
          '--output-format',
          'json',
          '--workflow-path',
          workflowPath,
          '--phase',
          'compose',
          '--ensemble-type',
          'plan-verify',
          '--run-id',
          runId,
        ],
        { encoding: 'utf8', env: cleanEnv, cwd: repoRoot },
      );

      // Companion lookup fails → exit 3 ("companion_error"). The
      // bookkeeping registration ran first; we assert that side effect.
      strictEqual(cp.status, 3, `stderr: ${cp.stderr}`);
      const { frontmatter } = await readWorkflow(workflowPath);
      const pending = frontmatter.pending_ensemble ?? [];
      strictEqual(pending.length, 1, 'expected one pending entry');
      strictEqual(pending[0].run_id, runId);
      strictEqual(pending[0].phase, 'compose');
      strictEqual(pending[0].ensemble_type, 'plan-verify');
      ok(
        typeof pending[0].started_at === 'string' &&
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(pending[0].started_at),
        `started_at should be ISO-8601-UTC; got ${pending[0].started_at}`,
      );
    });
  });

  it('without bookkeeping flags, does NOT touch pending_ensemble', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'compose',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'no bookkeeping',
      });
      const [workflowPath] = await listWorkflowFiles(repoRoot);

      const cleanEnv = { ...process.env };
      delete cleanEnv.AGENTIC_COMPANIONS_ROOT;
      cleanEnv.HOME = repoRoot;

      const promptFile = join(repoRoot, 'p.txt');
      await writeFile(promptFile, 'verbatim');
      const cp = spawnSync(
        process.execPath,
        [
          DISPATCH_PATH,
          '--peer',
          'codex',
          '--prompt-file',
          promptFile,
          '--output-format',
          'json',
          // intentionally NO --workflow-path / --phase / etc.
        ],
        { encoding: 'utf8', env: cleanEnv, cwd: repoRoot },
      );

      strictEqual(cp.status, 3);
      const { frontmatter } = await readWorkflow(workflowPath);
      const pending = frontmatter.pending_ensemble ?? [];
      strictEqual(pending.length, 0, 'pending_ensemble should be untouched');
    });
  });
});

// --- ensemble-commit CLI round-trip ----------------------------------------

describe('state.mjs ensemble-commit CLI — three-step atomic mutation', () => {
  function commit(workflowPath, run_id, opts = {}) {
    const args = [
      STATE_PATH,
      'ensemble-commit',
      '--workflow-path',
      workflowPath,
      '--host',
      'claude',
      '--phase',
      opts.phase ?? 'compose',
      '--ensemble-type',
      opts.ensembleType ?? 'plan-verify',
      '--run-id',
      run_id,
      '--verdict',
      opts.verdict ?? 'agree',
      '--summary',
      opts.summary ?? 'peer agreed with the orchestrator plan',
      '--completed-at',
      opts.completedAt ?? '2026-05-07T06:00:00Z',
    ];
    return spawnSync(process.execPath, args, { encoding: 'utf8' });
  }

  function pending(workflowPath, run_id) {
    return spawnSync(
      process.execPath,
      [
        STATE_PATH,
        'ensemble-pending',
        '--workflow-path',
        workflowPath,
        '--phase',
        'compose',
        '--ensemble-type',
        'plan-verify',
        '--run-id',
        run_id,
        '--started-at',
        '2026-05-07T05:59:00Z',
      ],
      { encoding: 'utf8' },
    );
  }

  it('pops the matching pending entry and appends an ensemble_results entry', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'compose',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'commit round-trip',
      });
      const [workflowPath] = await listWorkflowFiles(repoRoot);
      const runId = 'plan-verify-20260507T060000Z-bbbbbb';

      const p = pending(workflowPath, runId);
      strictEqual(p.status, 0, `pending stderr: ${p.stderr}`);

      const c = commit(workflowPath, runId);
      strictEqual(c.status, 0, `commit stderr: ${c.stderr}`);

      const { frontmatter } = await readWorkflow(workflowPath);
      strictEqual(
        (frontmatter.pending_ensemble ?? []).length,
        0,
        'pending should have been popped',
      );
      strictEqual((frontmatter.ensemble_results ?? []).length, 1);
      const entry = frontmatter.ensemble_results[0];
      strictEqual(entry.run_id, runId);
      strictEqual(entry.verdict, 'agree');
      // codex_session_id is null at write time; the YAML parser may
      // surface that as either null or undefined depending on whether
      // the serializer emits an explicit `~` / omits the key. Both
      // round-trips are acceptable for the "no session id" semantics.
      ok(
        entry.codex_session_id === null || entry.codex_session_id === undefined,
        `expected codex_session_id null/undefined; got ${entry.codex_session_id}`,
      );
    });
  });

  it('idempotent — second commit on the same run_id is a no-op for the results list', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'compose',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'idempotent commit',
      });
      const [workflowPath] = await listWorkflowFiles(repoRoot);
      const runId = 'plan-verify-20260507T060000Z-cccccc';

      pending(workflowPath, runId);
      const first = commit(workflowPath, runId);
      strictEqual(first.status, 0);

      // Second commit — no pending entry, but same run_id already in
      // ensemble_results. Must NOT duplicate.
      const second = commit(workflowPath, runId, {
        verdict: 'modify',
        summary: 'second take',
      });
      strictEqual(second.status, 0);

      const { frontmatter } = await readWorkflow(workflowPath);
      strictEqual(
        (frontmatter.ensemble_results ?? []).length,
        1,
        'idempotent commit must not duplicate the entry',
      );
      // The first verdict wins (idempotent skip preserves original).
      strictEqual(frontmatter.ensemble_results[0].verdict, 'agree');
    });
  });

  it('FIFO retention cap evicts oldest when 21 entries are committed', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'compose',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'retention cap',
      });
      const [workflowPath] = await listWorkflowFiles(repoRoot);

      // Commit ENSEMBLE_RESULTS_RETENTION_CAP + 1 distinct run_ids; each
      // pre-registers as pending then commits with a distinct
      // completed-at timestamp so the FIFO ordering is unambiguous.
      for (let i = 0; i < ENSEMBLE_RESULTS_RETENTION_CAP + 1; i++) {
        const id = `plan-verify-20260507T07${String(i).padStart(2, '0')}00Z-${'d'.repeat(6)}`;
        pending(workflowPath, id);
        const c = commit(workflowPath, id, {
          completedAt: `2026-05-07T07:${String(i).padStart(2, '0')}:00Z`,
        });
        strictEqual(c.status, 0, `commit ${i} stderr: ${c.stderr}`);
      }

      const { frontmatter } = await readWorkflow(workflowPath);
      const results = frontmatter.ensemble_results;
      strictEqual(results.length, ENSEMBLE_RESULTS_RETENTION_CAP);
      // Oldest (i=0) was evicted; newest (i=20) is at the tail.
      ok(
        !results.some((e) =>
          e.run_id.startsWith('plan-verify-20260507T0700'),
        ),
        'oldest entry (i=0) should have been evicted',
      );
      strictEqual(
        results.at(-1).run_id,
        `plan-verify-20260507T07${String(ENSEMBLE_RESULTS_RETENTION_CAP).padStart(2, '0')}00Z-${'d'.repeat(6)}`,
      );
    });
  });
});

// --- Schema-1.0 read tolerance + auto-promote on next write ----------------

describe('schema 1.0 → 1.1 tolerance for ensemble_results writers', () => {
  it('reads a hand-crafted schema-1.0 workflow file without error', async () => {
    await withTmpRepo(async (repoRoot) => {
      // First create a real workflow then rewrite its schema marker
      // to "1" (the legacy integer marker) to mimic a workflow file
      // produced by the pre-PR1 reader.
      await createWorkflow({
        repoRoot,
        verb: 'compose',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'schema 1.0 round-trip',
      });
      const [workflowPath] = await listWorkflowFiles(repoRoot);
      let text = await readFile(workflowPath, 'utf8');
      text = text.replace(/^schema:\s*['"]?1\.[12]['"]?$/m, 'schema: 1');
      await writeFile(workflowPath, text);

      const { frontmatter } = await readWorkflow(workflowPath);
      strictEqual(frontmatter.schema, 1, 'reader should accept legacy schema=1');
      // ensemble_results absence is acceptable on a 1.0 file.
      strictEqual(frontmatter.ensemble_results, undefined);
    });
  });

  it('ensemble-commit on a schema=1 file preserves schema=1 (no silent promotion)', async () => {
    await withTmpRepo(async (repoRoot) => {
      await createWorkflow({
        repoRoot,
        verb: 'compose',
        host: 'claude',
        gitBaseline: MIN_BASELINE,
        originalRequest: 'schema preservation under ensemble-commit',
      });
      const [workflowPath] = await listWorkflowFiles(repoRoot);
      let text = await readFile(workflowPath, 'utf8');
      text = text.replace(/^schema:\s*['"]?1\.[12]['"]?$/m, 'schema: 1');
      await writeFile(workflowPath, text);

      const c = spawnSync(
        process.execPath,
        [
          STATE_PATH,
          'ensemble-commit',
          '--workflow-path',
          workflowPath,
          '--host',
          'claude',
          '--phase',
          'compose',
          '--ensemble-type',
          'plan-verify',
          '--run-id',
          'plan-verify-20260507T060000Z-eeeeee',
          '--verdict',
          'agree',
          '--summary',
          'schema-1 round-trip',
          '--completed-at',
          '2026-05-07T06:00:00Z',
        ],
        { encoding: 'utf8' },
      );
      strictEqual(c.status, 0, `commit stderr: ${c.stderr}`);

      const { frontmatter } = await readWorkflow(workflowPath);
      strictEqual(
        frontmatter.schema,
        1,
        'schema marker must be preserved (PR3 schema-preserve contract from setCheckpoint applies here too)',
      );
      strictEqual(
        (frontmatter.ensemble_results ?? []).length,
        1,
        'the new field must still be written even when schema marker stays at 1 (1.0 readers tolerantly ignore)',
      );
    });
  });
});
