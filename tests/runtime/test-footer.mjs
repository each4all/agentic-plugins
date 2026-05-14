import { describe, it } from 'node:test';
import { ok, strictEqual, throws } from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { runContext } from '../../plugins/runtime/scripts/context.mjs';
import { runConsensus } from '../../plugins/runtime/scripts/consensus.mjs';
import {
  formatText,
  parseArgs,
  runFooter,
} from '../../plugins/runtime/scripts/footer.mjs';

const RUN_ID = 'context-20260513T010000Z-abcdef';
const CONSENSUS_RUN_ID = 'consensus-20260513T010000Z-abcdef';

describe('runtime footer', () => {
  it('renders an advisory footer from explicit pointer-only fields', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-footer-explicit-'));
    const report = await runFooter({
      repoRoot: root,
      host: 'codex',
      contextState: 'green',
      workflowKind: 'engineer',
      workflowId: 'engineer-20260513T010000Z-abc123',
      workflowPath: '.claude/agentic-engineer/workflows/engineer-20260513T010000Z-abc123.md',
      artifacts: ['diff:.agentic-plugins/runs/review/diff.txt'],
      recommendedNextWork: 'Open the pull request and watch CI.',
      nextSessionAction: 'Continue in this session only for small review follow-ups.',
      nextSessionCommand: '$engineer:critique --profile=parallel-review',
    });

    strictEqual(report.advisory, true);
    strictEqual(report.context_state, 'green');
    strictEqual(report.workflow.kind, 'engineer');
    ok(report.artifacts.some((artifact) => artifact.kind === 'workflow'));
    ok(report.artifacts.some((artifact) => artifact.kind === 'diff'));
    strictEqual(report.next_session.command, '$engineer:critique --profile=parallel-review');
    ok(report.limits.some((limit) => /does not mutate host session context/i.test(limit)));

    const text = formatText(report);
    ok(text.includes('Runtime completion footer (advisory)'));
    ok(text.includes('context state: green'));
    ok(text.includes('recommended next work: Open the pull request'));
  });

  it('links a runtime context artifact without leaking summary or prompt bodies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-footer-context-'));
    await runContext({
      command: 'capture',
      repoRoot: root,
      runId: RUN_ID,
      now: new Date('2026-05-13T01:00:00.000Z'),
      summary: 'RAW PEER OUTPUT should stay hidden from the completion footer.',
      risk: 'red',
      artifacts: ['consensus:.agentic-plugins/runs/consensus/run-1/consensus.json'],
      nextAction: 'Start a fresh session from the prompt pointer.',
      nextSessionPrompt: 'RAW PEER OUTPUT should not be printed by the footer.',
    });

    const report = await runFooter({
      repoRoot: root,
      host: 'claude',
      contextRunId: RUN_ID,
      workflowKind: 'orchestrator',
      workflowId: 'macro-plan-20260513T010000Z-abc123',
      workflowPath: '.claude/agentic-orchestrator/workflows/macro-plan-20260513T010000Z-abc123.md',
      recommendedNextWork: 'Dispatch the next unblocked subtask.',
    });

    strictEqual(report.context_state, 'red');
    strictEqual(report.next_session.command, `/runtime:context status --run-id ${RUN_ID}`);
    strictEqual(report.next_session.prompt_pointer, `.agentic-plugins/runs/context/${RUN_ID}/next-session-prompt.md`);
    ok(report.artifacts.some((artifact) => artifact.kind === 'context-artifact'));
    ok(report.artifacts.some((artifact) => artifact.kind === 'consensus'));

    const serialized = JSON.stringify(report);
    ok(!serialized.includes('RAW PEER OUTPUT'));
    ok(!formatText(report).includes('RAW PEER OUTPUT'));
  });

  it('can link the latest runtime context artifact with stale metadata', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-footer-latest-'));
    await runContext({
      command: 'capture',
      repoRoot: root,
      runId: 'context-20260513T000000Z-111111',
      now: new Date('2026-05-13T00:00:00.000Z'),
      summary: 'older context summary must stay hidden.',
      risk: 'green',
      nextSessionPrompt: 'older prompt must stay hidden.',
    });
    await runContext({
      command: 'capture',
      repoRoot: root,
      runId: RUN_ID,
      now: new Date('2026-05-13T01:00:00.000Z'),
      summary: 'latest context summary must stay hidden.',
      risk: 'yellow',
      artifacts: ['review:.agentic-plugins/runs/review/latest.json'],
      nextAction: 'Resume from the latest context pointer.',
      nextSessionPrompt: 'latest prompt must stay hidden.',
    });

    const opts = parseArgs([
      'render',
      '--repo-root',
      root,
      '--host',
      'codex',
      '--context-latest',
      '--stale-after-hours',
      '12',
      '--workflow-id',
      'engineer-latest',
      '--recommended-next-work',
      'Use the latest context handoff before continuing.',
    ]);
    const report = await runFooter({
      ...opts,
      now: new Date('2026-05-13T02:00:00.000Z'),
    });

    strictEqual(report.context_state, 'yellow');
    strictEqual(report.context.run_id, RUN_ID);
    strictEqual(report.context.lookup.mode, 'latest');
    strictEqual(report.context.lookup.stale, false);
    strictEqual(report.context.lookup.age_minutes, 60);
    strictEqual(report.context.lookup.stale_after_ms, 12 * 60 * 60 * 1000);
    strictEqual(report.context.lookup.guidance.state, 'inspect_context');
    strictEqual(report.context.lookup.guidance.recommended_session, 'fresh_or_resumed');
    strictEqual(report.next_session.command, `$runtime:context status --run-id ${RUN_ID}`);
    ok(report.artifacts.some((artifact) => artifact.kind === 'review'));

    const text = formatText(report);
    ok(text.includes('context artifact: .agentic-plugins/runs/context/'));
    ok(text.includes('context lookup:'));
    ok(text.includes('- mode: latest'));
    ok(text.includes('context handoff guidance: inspect_context'));
    ok(!text.includes('latest context summary'));
    ok(!JSON.stringify(report).includes('latest prompt'));
  });

  it('recommends reusing a fresh context artifact from the current source snapshot', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-footer-source-current-'));
    await runContext({
      command: 'capture',
      repoRoot: root,
      runId: RUN_ID,
      now: new Date('2026-05-13T01:00:00.000Z'),
      summary: 'Reusable summary should stay hidden.',
      risk: 'green',
      sourceSnapshot: {
        status: 'observed',
        kind: 'git',
        commit: 'cccccccccccccccccccccccccccccccccccccccc',
        branch: 'main',
        dirty: false,
      },
    });

    const report = await runFooter({
      repoRoot: root,
      host: 'codex',
      contextRunId: RUN_ID,
      workflowId: 'runtime-context-source-current',
      now: new Date('2026-05-13T01:30:00.000Z'),
      currentSourceSnapshot: {
        status: 'observed',
        kind: 'git',
        commit: 'cccccccccccccccccccccccccccccccccccccccc',
        branch: 'main',
        dirty: false,
      },
    });

    strictEqual(report.context.lookup.stale, false);
    strictEqual(report.context.lookup.source_freshness.status, 'current');
    strictEqual(report.context.lookup.guidance.state, 'reuse_handoff');
    strictEqual(report.context.lookup.guidance.recommended_session, 'current_or_resumed');
    ok(report.context.lookup.guidance.commands.some((command) => command === `runtime:context status --run-id ${RUN_ID}`));
    const text = formatText(report);
    ok(text.includes('context handoff guidance: reuse_handoff'));
    ok(text.includes(`context handoff command: runtime:context status --run-id ${RUN_ID}`));
    ok(!text.includes('Reusable summary should stay hidden'));
  });

  it('surfaces source-stale context artifacts without printing context bodies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-footer-source-stale-'));
    await runContext({
      command: 'capture',
      repoRoot: root,
      runId: RUN_ID,
      now: new Date('2026-05-13T01:00:00.000Z'),
      summary: 'Summary body should stay hidden while source freshness is shown.',
      risk: 'yellow',
      sourceSnapshot: {
        status: 'observed',
        kind: 'git',
        commit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        branch: 'main',
        dirty: false,
      },
    });

    const report = await runFooter({
      repoRoot: root,
      host: 'codex',
      contextRunId: RUN_ID,
      workflowId: 'runtime-context-source-freshness',
      currentSourceSnapshot: {
        status: 'observed',
        kind: 'git',
        commit: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        branch: 'main',
        dirty: false,
      },
    });

    strictEqual(report.context.lookup.source_freshness.status, 'stale');
    strictEqual(report.context.lookup.source_freshness.artifact_commit, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    strictEqual(report.context.lookup.source_freshness.current_commit, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    strictEqual(report.context.lookup.guidance.state, 'capture_new_context');
    strictEqual(report.context.lookup.guidance.recommended_session, 'fresh_or_resumed');
    ok(report.context.lookup.guidance.recommended_action.includes('Capture a new runtime:context artifact'));
    ok(report.context.lookup.guidance.commands.some((command) => command.includes('runtime:context capture')));
    const text = formatText(report);
    ok(text.includes('source freshness:'));
    ok(text.includes('- source status: stale'));
    ok(text.includes('context handoff guidance: capture_new_context'));
    ok(text.includes('context handoff command: runtime:context capture --summary'));
    ok(!text.includes('Summary body should stay hidden'));
  });

  it('links consensus status guidance without leaking prompt bodies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-footer-consensus-'));
    await runConsensus({
      command: 'plan',
      repoRoot: root,
      runId: CONSENSUS_RUN_ID,
      now: new Date('2026-05-13T01:00:00.000Z'),
      task: 'RAW CONSENSUS PROMPT BODY must stay hidden from the footer.',
      peers: ['claude', 'codex'],
    });

    const report = await runFooter({
      repoRoot: root,
      host: 'codex',
      consensusRunId: CONSENSUS_RUN_ID,
      workflowKind: 'orchestrator',
      workflowId: 'macro-plan-20260513T010000Z-abcdef',
    });

    strictEqual(report.consensus.run_id, CONSENSUS_RUN_ID);
    strictEqual(report.consensus.status, 'planned');
    strictEqual(report.consensus.status_guidance.state, 'execute_or_record');
    strictEqual(report.recommended_next_work, 'Execute the planned peer prompts, or run them manually and record each raw output as an artifact.');
    strictEqual(report.next_session.command, `$runtime:consensus status --run-id ${CONSENSUS_RUN_ID}`);
    ok(report.artifacts.some((artifact) => artifact.kind === 'consensus-run'));
    ok(report.artifacts.some((artifact) => artifact.kind === 'consensus-manifest'));

    const text = formatText(report);
    ok(text.includes(`consensus: ${CONSENSUS_RUN_ID}; status=planned`));
    ok(text.includes('consensus next action: Execute the planned peer prompts'));
    ok(text.includes(`runtime:consensus execute --run-id ${CONSENSUS_RUN_ID} --round 1 --execute`));
    ok(!text.includes('RAW CONSENSUS PROMPT BODY'));
    ok(!JSON.stringify(report).includes('RAW CONSENSUS PROMPT BODY'));
  });

  it('can link the latest consensus run by manifest freshness', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-footer-consensus-latest-'));
    await runConsensus({
      command: 'plan',
      repoRoot: root,
      runId: 'consensus-20260513T000000Z-111111',
      now: new Date('2026-05-13T00:00:00.000Z'),
      task: 'older consensus task must stay hidden.',
    });
    await runConsensus({
      command: 'plan',
      repoRoot: root,
      runId: CONSENSUS_RUN_ID,
      now: new Date('2026-05-13T01:00:00.000Z'),
      task: 'latest consensus task must stay hidden.',
    });

    const report = await runFooter({
      repoRoot: root,
      host: 'neutral',
      consensusLatest: true,
    });

    strictEqual(report.consensus.run_id, CONSENSUS_RUN_ID);
    strictEqual(report.consensus.lookup.mode, 'latest');
    strictEqual(report.consensus.lookup.selected_at, '2026-05-13T01:00:00.000Z');
    strictEqual(report.next_session.command, `runtime:consensus status --run-id ${CONSENSUS_RUN_ID}`);

    const text = formatText(report);
    ok(text.includes('consensus lookup:'));
    ok(text.includes('- mode: latest'));
    ok(!text.includes('latest consensus task'));
  });

  it('recommends asking the user about PR handling only when readiness criteria pass', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-footer-pr-ready-'));
    const report = await runFooter({
      repoRoot: root,
      host: 'codex',
      contextState: 'yellow',
      prCompletionBoundary: 'reached',
      prValidationState: 'waived',
      prReviewState: 'clear',
      prBranchState: 'pushable',
    });

    strictEqual(report.pr_handling.recommendation, 'ask-user');
    strictEqual(report.pr_handling.should_ask_user, true);
    ok(report.pr_handling.prompt.includes('Ask the user'));
    ok(report.pr_handling.criteria.every((criterion) => criterion.status === 'pass'));

    const text = formatText(report);
    ok(text.includes('PR handling:'));
    ok(text.includes('- recommendation: ask-user'));
    ok(text.includes('deliverable_boundary: pass (reached)'));
  });

  it('blocks PR handling when validation, review, branch, or context criteria fail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-footer-pr-block-'));
    const report = await runFooter({
      repoRoot: root,
      host: 'codex',
      contextState: 'red',
      prCompletionBoundary: 'reached',
      prValidationState: 'failed',
      prReviewState: 'blocking',
      prBranchState: 'not-pushable',
    });

    strictEqual(report.pr_handling.recommendation, 'block');
    strictEqual(report.pr_handling.should_ask_user, false);
    strictEqual(report.pr_handling.prompt, null);
    ok(report.pr_handling.criteria.some((criterion) => criterion.name === 'context_risk' && criterion.status === 'fail'));
    ok(report.pr_handling.criteria.some((criterion) => criterion.name === 'validation' && criterion.status === 'fail'));
  });

  it('defers PR handling when readiness evidence is incomplete', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-footer-pr-defer-'));
    const report = await runFooter({
      repoRoot: root,
      host: 'codex',
      contextState: 'green',
      prHandling: true,
      prCompletionBoundary: 'reached',
      prValidationState: 'passed',
      prReviewState: 'unknown',
      prBranchState: 'pushable',
    });

    strictEqual(report.pr_handling.recommendation, 'defer');
    strictEqual(report.pr_handling.should_ask_user, false);
    ok(report.pr_handling.criteria.some((criterion) => criterion.name === 'blocking_reviews' && criterion.status === 'unknown'));
  });

  it('parses CLI arguments and rejects unsafe pointers or context ids', async () => {
    const opts = parseArgs([
      'render',
      '--repo-root',
      '/tmp/repo',
      '--format',
      'json',
      '--host',
      'neutral',
      '--context-state',
      'yellow',
      '--consensus-run-id',
      'consensus-20260513T010000Z-abcdef',
      '--workflow-kind',
      'engineer',
      '--workflow-id',
      'engineer-1',
      '--artifact',
      'workflow:.claude/agentic-engineer/workflows/engineer-1.md',
      '--pr-handling',
      '--pr-completion-boundary',
      'reached',
      '--pr-validation-state',
      'passed',
      '--pr-review-state',
      'clear',
      '--pr-branch-state',
      'pushable',
      '--recommended-next-work',
      'Commit after review.',
    ]);
    strictEqual(opts.format, 'json');
    strictEqual(opts.host, 'neutral');
    strictEqual(opts.contextState, 'yellow');
    strictEqual(opts.consensusRunId, 'consensus-20260513T010000Z-abcdef');
    strictEqual(opts.workflowKind, 'engineer');
    strictEqual(opts.prHandling, true);
    strictEqual(opts.prCompletionBoundary, 'reached');
    strictEqual(opts.prValidationState, 'passed');
    strictEqual(opts.prReviewState, 'clear');
    strictEqual(opts.prBranchState, 'pushable');

    throws(() => parseArgs(['render', '--context-latest', '--context-run-id', RUN_ID]), /Use either --context-run-id or --context-latest/);
    throws(() => parseArgs(['render', '--consensus-latest', '--consensus-run-id', CONSENSUS_RUN_ID]), /Use either --consensus-run-id or --consensus-latest/);
    throws(() => parseArgs(['render', '--context-run-id', '../bad']), /Invalid --context-run-id/);
    throws(() => parseArgs(['render', '--consensus-run-id', '../bad']), /Invalid --consensus-run-id/);
    throws(() => parseArgs(['render', '--stale-after-hours', 'soon']), /non-negative integer/);
    throws(() => parseArgs(['render', '--context-state', 'orange']), /green, yellow, or red/);
    throws(() => parseArgs(['render', '--pr-completion-boundary', 'maybe']), /reached, not-reached, or unknown/);
    throws(() => parseArgs(['render', '--pr-validation-state', 'maybe']), /passed, waived, failed, not-run, or unknown/);
    throws(() => parseArgs(['render', '--pr-review-state', 'maybe']), /clear, blocking, or unknown/);
    throws(() => parseArgs(['render', '--pr-branch-state', 'maybe']), /pushable, not-pushable, or unknown/);
    throws(() => parseArgs(['render', '--artifact', 'bad\npath']), /single-line/);

    const root = await mkdtemp(join(tmpdir(), 'runtime-footer-reject-'));
    await rejectsAsync(
      runFooter({
        repoRoot: root,
        artifacts: [`bad:${resolve(root, '..', 'outside.md')}`],
      }),
      /escapes repo root/,
    );
  });
});

async function rejectsAsync(promise, pattern) {
  try {
    await promise;
  } catch (error) {
    ok(pattern.test(error.message), `expected ${error.message} to match ${pattern}`);
    return;
  }
  throw new Error('Expected promise to reject');
}
