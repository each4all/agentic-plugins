// Cross-host integration test — codex-side workflow create → claude-side
// resume. Reverse direction of test-claude-to-codex-resume.mjs. Same five
// invariants per ADR-0018 §sub-decision 5; host parameter swapped.
//
// Run via `npm run test:cross-host`.

import { describe, it } from 'node:test';
import { strictEqual, deepStrictEqual, ok } from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { withTmpGitRepo, MIN_BASELINE, APPEND_PHASE_MUTABLE_KEYS } from './_helpers.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');

const engineerState = await import(
  resolve(REPO_ROOT, 'plugins/engineer/scripts/state.mjs')
);
const orchestratorState = await import(
  resolve(REPO_ROOT, 'plugins/orchestrator/scripts/state.mjs')
);

const tmpRepo = (name, fn) => withTmpGitRepo(`cross-host-x2c-${name}`, fn);

// ---------------------------------------------------------------------------
// engineer scenario — schema 1.1, codex-first

describe('cross-host codex→claude resume — engineer (schema 1.1)', () => {
  it('host_history is strictly append-only across host boundary', async () => {
    await tmpRepo('engineer-history', async ({ repoRoot }) => {
      const { filePath } = await engineerState.createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'codex',
        gitBaseline: MIN_BASELINE(),
        originalRequest: 'reverse direction',
      });
      const before = await engineerState.readWorkflow(filePath);
      const preHistory = before.frontmatter.host_history;
      strictEqual(preHistory.length, 1);
      strictEqual(preHistory[0].host, 'codex');
      strictEqual(preHistory[0].event, 'created');

      await engineerState.appendPhase({
        workflowPath: filePath,
        host: 'claude',
        phaseLabel: 'Phase 1: Resume from claude',
        currentPhase: 'phase-1',
        nextAction: 'continue',
        event: 'resumed',
      });
      const after = await engineerState.readWorkflow(filePath);
      const postHistory = after.frontmatter.host_history;
      deepStrictEqual(postHistory.slice(0, preHistory.length), preHistory);
      strictEqual(postHistory.length, preHistory.length + 1);
      strictEqual(postHistory[postHistory.length - 1].host, 'claude');
      strictEqual(postHistory[postHistory.length - 1].event, 'resumed');
    });
  });

  it('checkpoint written after codex→claude handoff remains visible and attributed to claude', async () => {
    await tmpRepo('engineer-checkpoint', async ({ repoRoot }) => {
      const { filePath } = await engineerState.createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'codex',
        gitBaseline: MIN_BASELINE(),
        originalRequest: 'reverse checkpoint',
      });
      const before = await engineerState.readWorkflow(filePath);
      const preHistory = before.frontmatter.host_history;

      await engineerState.setCheckpoint({
        workflowPath: filePath,
        host: 'claude',
        summary: 'Claude picked up the Codex-started workflow.',
        now: new Date('2026-05-09T07:00:00Z'),
      });

      const after = await engineerState.readWorkflow(filePath);
      deepStrictEqual(after.frontmatter.host_history.slice(0, preHistory.length), preHistory);
      strictEqual(after.frontmatter.latest_checkpoint.summary, 'Claude picked up the Codex-started workflow.');
      strictEqual(after.frontmatter.latest_checkpoint.at, '2026-05-09T07:00:00Z');
      strictEqual(after.frontmatter.host_history.at(-1).host, 'claude');
      strictEqual(after.frontmatter.host_history.at(-1).event, 'checkpointed');
    });
  });

  it('findActiveWorkflowByBranch returns the same path before and after host transition', async () => {
    await tmpRepo('engineer-find', async ({ repoRoot }) => {
      const { filePath } = await engineerState.createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'codex',
        gitBaseline: MIN_BASELINE('feature/r'),
        originalRequest: 'reverse find-active',
      });
      const beforePath = await engineerState.findActiveWorkflowByBranch(
        repoRoot,
        'feature/r',
      );
      strictEqual(beforePath, filePath);

      await engineerState.appendPhase({
        workflowPath: filePath,
        host: 'claude',
        currentPhase: 'phase-1',
        event: 'resumed',
      });
      const afterPath = await engineerState.findActiveWorkflowByBranch(
        repoRoot,
        'feature/r',
      );
      strictEqual(afterPath, filePath);
    });
  });

  it('parsed frontmatter structure stable across host writes', async () => {
    await tmpRepo('engineer-fm-stable', async ({ repoRoot }) => {
      const { filePath } = await engineerState.createWorkflow({
        repoRoot,
        verb: 'frame',
        host: 'codex',
        gitBaseline: MIN_BASELINE(),
        originalRequest: 'reverse fm',
      });
      const before = await engineerState.readWorkflow(filePath);
      const preFm = structuredClone(before.frontmatter);

      await engineerState.appendPhase({
        workflowPath: filePath,
        host: 'claude',
        currentPhase: 'phase-1',
        event: 'resumed',
      });
      const after = await engineerState.readWorkflow(filePath);
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

  it('pending_ensemble lifecycle: codex record → claude commit', async () => {
    await tmpRepo('engineer-pending', async ({ repoRoot }) => {
      const { filePath } = await engineerState.createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'codex',
        gitBaseline: MIN_BASELINE(),
        originalRequest: 'reverse pending',
      });
      await engineerState.recordPendingEnsemble({
        workflowPath: filePath,
        phase: 'investigate',
        ensemble_type: 'investigate',
        run_id: 'rev-1',
        started_at: '2026-05-09T03:00:00Z',
      });
      const mid = await engineerState.readWorkflow(filePath);
      strictEqual(mid.frontmatter.pending_ensemble.length, 1);

      await engineerState.commitEnsemble({
        workflowPath: filePath,
        run_id: 'rev-1',
        phase: 'investigate',
        ensemble_type: 'investigate',
        verdict: 'pass',
        summary: 'reverse cross-host commit OK',
        completed_at: '2026-05-09T03:01:00Z',
      });
      const after = await engineerState.readWorkflow(filePath);
      strictEqual(after.frontmatter.pending_ensemble.length, 0);
      strictEqual(after.frontmatter.ensemble_results[0].run_id, 'rev-1');
    });
  });

  it('ensemble_results retention cap (20) enforced regardless of writing host', async () => {
    await tmpRepo('engineer-retention', async ({ repoRoot }) => {
      const { filePath } = await engineerState.createWorkflow({
        repoRoot,
        verb: 'investigate',
        host: 'codex',
        gitBaseline: MIN_BASELINE(),
        originalRequest: 'reverse retention',
      });
      const total = engineerState.ENSEMBLE_RESULTS_RETENTION_CAP + 1;
      for (let i = 0; i < total; i++) {
        const completedAt = `2026-05-09T${String(i).padStart(2, '0')}:00:00Z`;
        await engineerState.commitEnsemble({
          workflowPath: filePath,
          run_id: `rev-r-${i}`,
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
      ok(!ids.includes('rev-r-0'));
      ok(ids.includes('rev-r-20'));
    });
  });
});

// ---------------------------------------------------------------------------
// orchestrator scenario — schema 1.0, codex-first

describe('cross-host codex→claude resume — orchestrator (schema 1.0)', () => {
  it('host_history is strictly append-only across host boundary', async () => {
    await tmpRepo('orchestrator-history', async ({ repoRoot }) => {
      const { filePath } = await orchestratorState.createWorkflow({
        repoRoot,
        verb: 'plan',
        host: 'codex',
        gitBaseline: MIN_BASELINE(),
        originalRequest: 'reverse orchestrator',
      });
      const before = await orchestratorState.readWorkflow(filePath);
      const preHistory = before.frontmatter.host_history;
      strictEqual(preHistory.length, 1);
      strictEqual(preHistory[0].host, 'codex');

      await orchestratorState.appendPhase({
        workflowPath: filePath,
        host: 'claude',
        currentPhase: 'phase-1',
        event: 'resumed',
      });
      const after = await orchestratorState.readWorkflow(filePath);
      deepStrictEqual(
        after.frontmatter.host_history.slice(0, preHistory.length),
        preHistory,
      );
      strictEqual(after.frontmatter.host_history.length, preHistory.length + 1);
      strictEqual(
        after.frontmatter.host_history[after.frontmatter.host_history.length - 1].host,
        'claude',
      );
    });
  });

  it('checkpoint written after codex→claude handoff remains visible and attributed to claude', async () => {
    await tmpRepo('orchestrator-checkpoint', async ({ repoRoot }) => {
      const { filePath } = await orchestratorState.createWorkflow({
        repoRoot,
        verb: 'plan',
        host: 'codex',
        gitBaseline: MIN_BASELINE(),
        originalRequest: 'reverse orchestrator checkpoint',
      });
      const before = await orchestratorState.readWorkflow(filePath);
      const preHistory = before.frontmatter.host_history;

      await orchestratorState.setCheckpoint({
        workflowPath: filePath,
        host: 'claude',
        summary: 'Claude checkpointed the Codex-started macro.',
        now: new Date('2026-05-09T08:00:00Z'),
      });

      const after = await orchestratorState.readWorkflow(filePath);
      deepStrictEqual(after.frontmatter.host_history.slice(0, preHistory.length), preHistory);
      strictEqual(after.frontmatter.latest_checkpoint.summary, 'Claude checkpointed the Codex-started macro.');
      strictEqual(after.frontmatter.latest_checkpoint.at, '2026-05-09T08:00:00Z');
      strictEqual(after.frontmatter.host_history.at(-1).host, 'claude');
      strictEqual(after.frontmatter.host_history.at(-1).event, 'checkpointed');
    });
  });

  it('findActiveWorkflowByBranch returns the same path before and after host transition', async () => {
    await tmpRepo('orchestrator-find', async ({ repoRoot }) => {
      const { filePath } = await orchestratorState.createWorkflow({
        repoRoot,
        verb: 'plan',
        host: 'codex',
        gitBaseline: MIN_BASELINE('feature/s'),
        originalRequest: 'reverse find orch',
      });
      const beforePath = await orchestratorState.findActiveWorkflowByBranch(
        repoRoot,
        'feature/s',
      );
      strictEqual(beforePath, filePath);

      await orchestratorState.appendPhase({
        workflowPath: filePath,
        host: 'claude',
        currentPhase: 'phase-1',
        event: 'resumed',
      });
      const afterPath = await orchestratorState.findActiveWorkflowByBranch(
        repoRoot,
        'feature/s',
      );
      strictEqual(afterPath, filePath);
    });
  });

  it('parsed frontmatter structure stable across host writes', async () => {
    await tmpRepo('orchestrator-fm-stable', async ({ repoRoot }) => {
      const { filePath } = await orchestratorState.createWorkflow({
        repoRoot,
        verb: 'plan',
        host: 'codex',
        gitBaseline: MIN_BASELINE(),
        originalRequest: 'reverse fm orch',
      });
      const before = await orchestratorState.readWorkflow(filePath);
      const preFm = structuredClone(before.frontmatter);

      await orchestratorState.appendPhase({
        workflowPath: filePath,
        host: 'claude',
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

  it('pending_ensemble lifecycle: codex record → claude commit', async () => {
    await tmpRepo('orchestrator-pending', async ({ repoRoot }) => {
      const { filePath } = await orchestratorState.createWorkflow({
        repoRoot,
        verb: 'plan',
        host: 'codex',
        gitBaseline: MIN_BASELINE(),
        originalRequest: 'reverse pending orch',
      });
      await orchestratorState.recordPendingEnsemble({
        workflowPath: filePath,
        phase: 'plan',
        ensemble_type: 'plan-verify',
        run_id: 'rev-orch-1',
        started_at: '2026-05-09T04:00:00Z',
      });
      // Symmetry with the claude→codex direction: assert the
      // intermediate single-pending state before commitEnsemble pops it.
      const mid = await orchestratorState.readWorkflow(filePath);
      strictEqual(mid.frontmatter.pending_ensemble.length, 1);

      await orchestratorState.commitEnsemble({
        workflowPath: filePath,
        run_id: 'rev-orch-1',
        phase: 'plan',
        ensemble_type: 'plan-verify',
        verdict: 'pass',
        summary: 'reverse orch commit OK',
        completed_at: '2026-05-09T04:01:00Z',
      });
      const after = await orchestratorState.readWorkflow(filePath);
      strictEqual(after.frontmatter.pending_ensemble.length, 0);
      strictEqual(after.frontmatter.ensemble_results[0].run_id, 'rev-orch-1');
    });
  });

  it('ensemble_results retention cap (20) enforced regardless of writing host', async () => {
    await tmpRepo('orchestrator-retention', async ({ repoRoot }) => {
      const { filePath } = await orchestratorState.createWorkflow({
        repoRoot,
        verb: 'plan',
        host: 'codex',
        gitBaseline: MIN_BASELINE(),
        originalRequest: 'reverse retention orch',
      });
      const total = orchestratorState.ENSEMBLE_RESULTS_RETENTION_CAP + 1;
      for (let i = 0; i < total; i++) {
        const completedAt = `2026-05-09T${String(i).padStart(2, '0')}:00:00Z`;
        await orchestratorState.commitEnsemble({
          workflowPath: filePath,
          run_id: `rev-orch-r-${i}`,
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
      ok(!ids.includes('rev-orch-r-0'));
      ok(ids.includes('rev-orch-r-20'));
    });
  });
});
