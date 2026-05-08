// Cross-host integration test — claude-side workflow create → codex-side
// resume. Per ADR-0018 §sub-decision 5 contract: sequential transition
// MUST work, with host_history append-only and findActiveWorkflow returning
// the same workflow under both hosts. Hooks are simulated in-process.
//
// Covers both engineer (schema 1.1) and orchestrator (schema 1.0).
// Run via `npm run test:cross-host`.

import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual, ok } from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTmpGitRepo, MIN_BASELINE, APPEND_PHASE_MUTABLE_KEYS } from './_helpers.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');

// Namespace imports prevent collision between engineer's and
// orchestrator's identical export names (createWorkflow, etc.).
const engineerState = await import(
  resolve(REPO_ROOT, 'plugins/engineer/scripts/state.mjs')
);
const orchestratorState = await import(
  resolve(REPO_ROOT, 'plugins/orchestrator/scripts/state.mjs')
);

const tmpRepo = (name, fn) => withTmpGitRepo(`cross-host-c2x-${name}`, fn);

// ---------------------------------------------------------------------------
// engineer scenario — schema 1.1, verb 'investigate'

describe('cross-host claude→codex resume — engineer (schema 1.1)', () => {
  it('host_history is strictly append-only across host boundary', async () => {
    await tmpRepo('engineer-history', async ({ repoRoot }) => {
      const { filePath } = await engineerState.createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE(),
        originalRequest: 'cross-host test',
      });
      const before = await engineerState.readWorkflow(filePath);
      const preHistory = before.frontmatter.host_history;
      strictEqual(preHistory.length, 1);
      strictEqual(preHistory[0].host, 'claude');
      strictEqual(preHistory[0].event, 'created');

      await engineerState.appendPhase({
        workflowPath: filePath,
        host: 'codex',
        phaseLabel: 'Phase 1: Resume from codex',
        currentPhase: 'phase-1',
        nextAction: 'continue',
        event: 'resumed',
      });
      const after = await engineerState.readWorkflow(filePath);
      const postHistory = after.frontmatter.host_history;

      // Strict append-only: prefix preserved exactly, including each
      // entry's host name (per-entry host attribution must survive the
      // host boundary write — this is what catches a host-inversion
      // regression).
      deepStrictEqual(
        postHistory.slice(0, preHistory.length),
        preHistory,
        'prior host_history entries (including per-entry host) must be preserved',
      );
      strictEqual(postHistory.length, preHistory.length + 1);
      strictEqual(postHistory[postHistory.length - 1].host, 'codex');
      strictEqual(postHistory[postHistory.length - 1].event, 'resumed');
    });
  });

  it('findActiveWorkflowByBranch returns the same path before and after host transition', async () => {
    await tmpRepo('engineer-find', async ({ repoRoot }) => {
      const { filePath } = await engineerState.createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE('feature/x'),
        originalRequest: 'find-active',
      });
      const beforePath = await engineerState.findActiveWorkflowByBranch(
        repoRoot,
        'feature/x',
      );
      strictEqual(beforePath, filePath);

      await engineerState.appendPhase({
        workflowPath: filePath,
        host: 'codex',
        currentPhase: 'phase-1',
        event: 'resumed',
      });
      const afterPath = await engineerState.findActiveWorkflowByBranch(
        repoRoot,
        'feature/x',
      );
      strictEqual(afterPath, filePath);
    });
  });

  it('parsed frontmatter structure stable across host writes (parse/assemble is not byte-idempotent — verify parsed form, not raw text)', async () => {
    await tmpRepo('engineer-fm-stable', async ({ repoRoot }) => {
      const { filePath } = await engineerState.createWorkflow({
        repoRoot,
        verb: 'frame',
        host: 'claude',
        gitBaseline: MIN_BASELINE(),
        originalRequest: 'fm stability',
      });
      const before = await engineerState.readWorkflow(filePath);
      const preFm = structuredClone(before.frontmatter);

      await engineerState.appendPhase({
        workflowPath: filePath,
        host: 'codex',
        currentPhase: 'phase-1',
        event: 'resumed',
      });
      const after = await engineerState.readWorkflow(filePath);

      deepStrictEqual(
        Object.keys(after.frontmatter).sort(),
        Object.keys(preFm).sort(),
        'frontmatter key set must remain identical across host boundary',
      );
      // Positive assertion that appendPhase actually mutated the
      // expected fields — a silent no-op would otherwise pass the
      // immutable-key assertion below trivially.
      strictEqual(after.frontmatter.current_phase, 'phase-1');
      for (const key of Object.keys(preFm)) {
        if (APPEND_PHASE_MUTABLE_KEYS.has(key)) continue;
        deepStrictEqual(
          after.frontmatter[key],
          preFm[key],
          `non-mutable key '${key}' must be byte-equal after host transition`,
        );
      }
    });
  });

  it('pending_ensemble lifecycle: claude record → codex commit (no host attribution in API)', async () => {
    await tmpRepo('engineer-pending', async ({ repoRoot }) => {
      const { filePath } = await engineerState.createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE(),
        originalRequest: 'pending lifecycle',
      });
      await engineerState.recordPendingEnsemble({
        workflowPath: filePath,
        phase: 'investigate',
        ensemble_type: 'investigate',
        run_id: 'cross-1',
        started_at: '2026-05-09T01:00:00Z',
      });
      const mid = await engineerState.readWorkflow(filePath);
      strictEqual(mid.frontmatter.pending_ensemble.length, 1);
      strictEqual(mid.frontmatter.pending_ensemble[0].run_id, 'cross-1');

      await engineerState.commitEnsemble({
        workflowPath: filePath,
        run_id: 'cross-1',
        phase: 'investigate',
        ensemble_type: 'investigate',
        verdict: 'pass',
        summary: 'cross-host commit OK',
        completed_at: '2026-05-09T01:01:00Z',
      });
      const after = await engineerState.readWorkflow(filePath);
      strictEqual(after.frontmatter.pending_ensemble.length, 0);
      strictEqual(after.frontmatter.ensemble_results.length, 1);
      strictEqual(after.frontmatter.ensemble_results[0].run_id, 'cross-1');
      strictEqual(after.frontmatter.ensemble_results[0].verdict, 'pass');
    });
  });

  it('ensemble_results retention cap (20) enforced regardless of writing host', async () => {
    await tmpRepo('engineer-retention', async ({ repoRoot }) => {
      const { filePath } = await engineerState.createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'claude',
        gitBaseline: MIN_BASELINE(),
        originalRequest: 'retention',
      });
      strictEqual(engineerState.ENSEMBLE_RESULTS_RETENTION_CAP, 20);
      const total = engineerState.ENSEMBLE_RESULTS_RETENTION_CAP + 1;
      for (let i = 0; i < total; i++) {
        const completedAt = `2026-05-09T${String(i).padStart(2, '0')}:00:00Z`;
        await engineerState.commitEnsemble({
          workflowPath: filePath,
          run_id: `r-${i}`,
          phase: 'investigate',
          ensemble_type: 'investigate',
          verdict: 'pass',
          summary: `entry ${i}`,
          completed_at: completedAt,
        });
      }
      const after = await engineerState.readWorkflow(filePath);
      strictEqual(
        after.frontmatter.ensemble_results.length,
        engineerState.ENSEMBLE_RESULTS_RETENTION_CAP,
      );
      const ids = after.frontmatter.ensemble_results.map((e) => e.run_id);
      ok(!ids.includes('r-0'));
      ok(ids.includes('r-20'));
    });
  });
});

// ---------------------------------------------------------------------------
// orchestrator scenario — schema 1.0, verb 'plan'

describe('cross-host claude→codex resume — orchestrator (schema 1.0)', () => {
  it('host_history is strictly append-only across host boundary', async () => {
    await tmpRepo('orchestrator-history', async ({ repoRoot }) => {
      const { filePath } = await orchestratorState.createWorkflow({
        repoRoot,
        verb: 'plan',
        host: 'claude',
        gitBaseline: MIN_BASELINE(),
        originalRequest: 'cross-host orchestrator',
      });
      const before = await orchestratorState.readWorkflow(filePath);
      const preHistory = before.frontmatter.host_history;
      strictEqual(preHistory.length, 1);
      strictEqual(preHistory[0].host, 'claude');
      strictEqual(preHistory[0].event, 'created');

      await orchestratorState.appendPhase({
        workflowPath: filePath,
        host: 'codex',
        phaseLabel: 'Phase 1: Resume from codex',
        currentPhase: 'phase-1',
        nextAction: 'continue',
        event: 'resumed',
      });
      const after = await orchestratorState.readWorkflow(filePath);
      const postHistory = after.frontmatter.host_history;
      deepStrictEqual(
        postHistory.slice(0, preHistory.length),
        preHistory,
        'orchestrator host_history append-only across host boundary',
      );
      strictEqual(postHistory.length, preHistory.length + 1);
      strictEqual(postHistory[postHistory.length - 1].host, 'codex');
      strictEqual(postHistory[postHistory.length - 1].event, 'resumed');
    });
  });

  it('findActiveWorkflowByBranch returns the same path before and after host transition', async () => {
    await tmpRepo('orchestrator-find', async ({ repoRoot }) => {
      const { filePath } = await orchestratorState.createWorkflow({
        repoRoot,
        verb: 'plan',
        host: 'claude',
        gitBaseline: MIN_BASELINE('feature/y'),
        originalRequest: 'find-active orchestrator',
      });
      const beforePath = await orchestratorState.findActiveWorkflowByBranch(
        repoRoot,
        'feature/y',
      );
      strictEqual(beforePath, filePath);

      await orchestratorState.appendPhase({
        workflowPath: filePath,
        host: 'codex',
        currentPhase: 'phase-1',
        event: 'resumed',
      });
      const afterPath = await orchestratorState.findActiveWorkflowByBranch(
        repoRoot,
        'feature/y',
      );
      strictEqual(afterPath, filePath);
    });
  });

  it('parsed frontmatter structure stable across host writes', async () => {
    await tmpRepo('orchestrator-fm-stable', async ({ repoRoot }) => {
      const { filePath } = await orchestratorState.createWorkflow({
        repoRoot,
        verb: 'plan',
        host: 'claude',
        gitBaseline: MIN_BASELINE(),
        originalRequest: 'orchestrator fm',
      });
      const before = await orchestratorState.readWorkflow(filePath);
      const preFm = structuredClone(before.frontmatter);

      await orchestratorState.appendPhase({
        workflowPath: filePath,
        host: 'codex',
        currentPhase: 'phase-1',
        event: 'resumed',
      });
      const after = await orchestratorState.readWorkflow(filePath);

      deepStrictEqual(
        Object.keys(after.frontmatter).sort(),
        Object.keys(preFm).sort(),
      );
      strictEqual(after.frontmatter.current_phase, 'phase-1');
      for (const key of Object.keys(preFm)) {
        if (APPEND_PHASE_MUTABLE_KEYS.has(key)) continue;
        deepStrictEqual(after.frontmatter[key], preFm[key]);
      }
    });
  });

  it('pending_ensemble lifecycle: claude record → codex commit', async () => {
    await tmpRepo('orchestrator-pending', async ({ repoRoot }) => {
      const { filePath } = await orchestratorState.createWorkflow({
        repoRoot,
        verb: 'plan',
        host: 'claude',
        gitBaseline: MIN_BASELINE(),
        originalRequest: 'pending lifecycle orchestrator',
      });
      await orchestratorState.recordPendingEnsemble({
        workflowPath: filePath,
        phase: 'plan',
        ensemble_type: 'plan-verify',
        run_id: 'cross-orch-1',
        started_at: '2026-05-09T02:00:00Z',
      });
      const mid = await orchestratorState.readWorkflow(filePath);
      strictEqual(mid.frontmatter.pending_ensemble.length, 1);

      await orchestratorState.commitEnsemble({
        workflowPath: filePath,
        run_id: 'cross-orch-1',
        phase: 'plan',
        ensemble_type: 'plan-verify',
        verdict: 'pass',
        summary: 'orch cross-host commit OK',
        completed_at: '2026-05-09T02:01:00Z',
      });
      const after = await orchestratorState.readWorkflow(filePath);
      strictEqual(after.frontmatter.pending_ensemble.length, 0);
      strictEqual(after.frontmatter.ensemble_results.length, 1);
      strictEqual(after.frontmatter.ensemble_results[0].run_id, 'cross-orch-1');
    });
  });

  it('ensemble_results retention cap (20) enforced regardless of writing host', async () => {
    await tmpRepo('orchestrator-retention', async ({ repoRoot }) => {
      const { filePath } = await orchestratorState.createWorkflow({
        repoRoot,
        verb: 'plan',
        host: 'claude',
        gitBaseline: MIN_BASELINE(),
        originalRequest: 'retention orchestrator',
      });
      strictEqual(orchestratorState.ENSEMBLE_RESULTS_RETENTION_CAP, 20);
      const total = orchestratorState.ENSEMBLE_RESULTS_RETENTION_CAP + 1;
      for (let i = 0; i < total; i++) {
        const completedAt = `2026-05-09T${String(i).padStart(2, '0')}:00:00Z`;
        await orchestratorState.commitEnsemble({
          workflowPath: filePath,
          run_id: `orch-r-${i}`,
          phase: 'plan',
          ensemble_type: 'plan-verify',
          verdict: 'pass',
          summary: `entry ${i}`,
          completed_at: completedAt,
        });
      }
      const after = await orchestratorState.readWorkflow(filePath);
      strictEqual(
        after.frontmatter.ensemble_results.length,
        orchestratorState.ENSEMBLE_RESULTS_RETENTION_CAP,
      );
      const ids = after.frontmatter.ensemble_results.map((e) => e.run_id);
      ok(!ids.includes('orch-r-0'));
      ok(ids.includes('orch-r-20'));
    });
  });
});
