import { describe, it } from 'node:test';
import { ok, strictEqual, throws } from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
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
    strictEqual(report.completion_state, 'next-work-available');
    strictEqual(report.completion.source, 'inferred');
    strictEqual(report.completion.next_action, 'Open the pull request and watch CI.');
    strictEqual(report.workflow.kind, 'engineer');
    ok(report.artifacts.some((artifact) => artifact.kind === 'workflow'));
    ok(report.artifacts.some((artifact) => artifact.kind === 'diff'));
    strictEqual(report.next_session.command, '$engineer:critique --profile=parallel-review');
    ok(report.limits.some((limit) => /does not mutate host session context/i.test(limit)));

    const text = formatText(report);
    ok(text.includes('Runtime completion footer (advisory)'));
    ok(text.includes('context state: green'));
    ok(text.includes('completion state: next-work-available'));
    ok(text.includes('completion next action: Open the pull request'));
    ok(text.includes('recommended next work: Open the pull request'));
  });

  it('allows callers to explicitly mark a fully closed completion state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-footer-closed-'));
    const report = await runFooter({
      repoRoot: root,
      host: 'neutral',
      contextState: 'green',
      completionState: 'closed',
      completionReason: 'All PR, release, installed-state, and cleanup evidence is complete.',
    });

    strictEqual(report.completion_state, 'closed');
    strictEqual(report.completion.source, 'explicit');
    ok(report.completion.next_action.includes('No further repo, PR, release, cleanup'));
    strictEqual(report.recommended_next_work, report.completion.next_action);
    strictEqual(report.next_session.action, 'No next session is required from this footer evidence.');

    const text = formatText(report);
    ok(text.includes('completion state: closed'));
    ok(text.includes('All PR, release, installed-state, and cleanup evidence is complete.'));
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
    ok(report.context.lookup.guidance.commands.some((command) => command.includes('/runtime:context capture')));
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
    ok(report.context.lookup.guidance.commands.some((command) => command === `$runtime:context status --run-id ${RUN_ID}`));
    const text = formatText(report);
    ok(text.includes('context handoff guidance: reuse_handoff'));
    ok(text.includes(`context handoff command: $runtime:context status --run-id ${RUN_ID}`));
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
    ok(report.context.lookup.guidance.commands.some((command) => command.includes('$runtime:context capture')));
    const text = formatText(report);
    ok(text.includes('source freshness:'));
    ok(text.includes('- source status: stale'));
    ok(text.includes('context handoff guidance: capture_new_context'));
    ok(text.includes('context handoff command: $runtime:context capture --summary'));
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
    strictEqual(report.completion_state, 'next-work-available');
    strictEqual(report.recommended_next_work, 'Execute the planned peer prompts, or run them manually and record each raw output as an artifact.');
    strictEqual(report.completion.next_action, report.recommended_next_work);
    strictEqual(report.next_session.command, `$runtime:consensus status --run-id ${CONSENSUS_RUN_ID}`);
    ok(report.consensus.status_guidance.next_steps.some((step) => step === `$runtime:consensus execute --run-id ${CONSENSUS_RUN_ID} --round 1 --execute`));
    ok(report.artifacts.some((artifact) => artifact.kind === 'consensus-run'));
    ok(report.artifacts.some((artifact) => artifact.kind === 'consensus-manifest'));

    const text = formatText(report);
    ok(text.includes(`consensus: ${CONSENSUS_RUN_ID}; status=planned`));
    ok(text.includes('consensus next action: Execute the planned peer prompts'));
    ok(text.includes(`$runtime:consensus execute --run-id ${CONSENSUS_RUN_ID} --round 1 --execute`));
    ok(!text.includes('RAW CONSENSUS PROMPT BODY'));
    ok(!JSON.stringify(report).includes('RAW CONSENSUS PROMPT BODY'));
  });

  it('links consensus owner decisions without leaking decision text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-footer-consensus-decision-'));
    await runConsensus({
      command: 'plan',
      repoRoot: root,
      runId: CONSENSUS_RUN_ID,
      task: 'Choose between unresolved consensus outcomes.',
      maxRounds: 1,
    });
    const summaryFile = join(root, 'summary.md');
    const disagreementsFile = join(root, 'disagreements.json');
    const decisionFile = join(root, 'owner-decision.md');
    await writeFile(summaryFile, 'The consensus remains unresolved.\n');
    await writeFile(disagreementsFile, JSON.stringify([
      { summary: 'One path ships now; the other waits for verifier coverage.', kind: 'contradiction' },
    ]));
    await writeFile(decisionFile, 'RAW OWNER DECISION BODY must stay hidden from the footer.\n');
    await runConsensus({
      command: 'synthesize',
      repoRoot: root,
      runId: CONSENSUS_RUN_ID,
      summaryFile,
      disagreementsFile,
    });
    await runConsensus({
      command: 'decide',
      repoRoot: root,
      runId: CONSENSUS_RUN_ID,
      decisionFile,
      nextAction: 'Proceed with the verifier-backed path.',
    });

    const report = await runFooter({
      repoRoot: root,
      host: 'codex',
      consensusRunId: CONSENSUS_RUN_ID,
    });

    strictEqual(report.consensus.status, 'owner-decided');
    strictEqual(report.consensus.status_guidance.state, 'owner_decided');
    strictEqual(report.completion_state, 'next-work-available');
    strictEqual(report.recommended_next_work, 'Proceed with the verifier-backed path.');
    ok(report.consensus.owner_decision_pointer.endsWith('/owner-decision.json'));
    ok(report.artifacts.some((artifact) => artifact.kind === 'consensus-owner-decision'));

    const text = formatText(report);
    ok(text.includes('consensus owner decision:'));
    ok(text.includes('consensus guidance: owner_decided'));
    ok(!text.includes('RAW OWNER DECISION BODY'));
    ok(!JSON.stringify(report).includes('RAW OWNER DECISION BODY'));
  });

  it('links consensus owner ratification without leaking ratification text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-footer-consensus-ratify-'));
    await runConsensus({
      command: 'plan',
      repoRoot: root,
      runId: CONSENSUS_RUN_ID,
      task: 'Ratify a converged consensus with a residual owner lever.',
    });
    const summaryFile = join(root, 'summary.md');
    const disagreementsFile = join(root, 'disagreements.json');
    const ratificationFile = join(root, 'owner-ratification.md');
    await writeFile(summaryFile, 'All peers converged; one residual owner lever remains.\n');
    await writeFile(disagreementsFile, JSON.stringify([
      { summary: 'Resolution lever (owner\'s call): implement now vs wait for a trigger.', kind: 'complementary' },
    ]));
    await writeFile(ratificationFile, 'RAW OWNER RATIFICATION BODY must stay hidden from the footer.\n');
    await runConsensus({
      command: 'synthesize',
      repoRoot: root,
      runId: CONSENSUS_RUN_ID,
      summaryFile,
      disagreementsFile,
      convergenceState: 'complementary',
    });
    await runConsensus({
      command: 'ratify',
      repoRoot: root,
      runId: CONSENSUS_RUN_ID,
      ratificationFile,
      lever: 'implement now vs wait: wait for a trigger',
      nextAction: 'Proceed with the ratified consensus.',
    });

    const report = await runFooter({
      repoRoot: root,
      host: 'codex',
      consensusRunId: CONSENSUS_RUN_ID,
    });

    strictEqual(report.consensus.status, 'converged');
    strictEqual(report.consensus.status_guidance.state, 'complete');
    ok(report.consensus.ratification_pointer.endsWith('/owner-ratification.json'));
    ok(report.artifacts.some((artifact) => artifact.kind === 'consensus-owner-ratification'));

    const text = formatText(report);
    ok(text.includes('consensus owner ratification:'));
    ok(!text.includes('RAW OWNER RATIFICATION BODY'));
    ok(!JSON.stringify(report).includes('RAW OWNER RATIFICATION BODY'));
  });

  it('links consensus cancellation without leaking cancellation reason text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-footer-consensus-cancel-'));
    await runConsensus({
      command: 'plan',
      repoRoot: root,
      runId: CONSENSUS_RUN_ID,
      task: 'Cancel this consensus run without exposing reason text.',
    });
    const reasonFile = join(root, 'cancel-reason.md');
    await writeFile(reasonFile, 'RAW CANCELLATION REASON must stay hidden from the footer.\n');
    await runConsensus({
      command: 'cancel',
      repoRoot: root,
      runId: CONSENSUS_RUN_ID,
      reasonFile,
      nextAction: 'Start a new consensus run only if the issue still needs peer review.',
    });

    const report = await runFooter({
      repoRoot: root,
      host: 'codex',
      consensusRunId: CONSENSUS_RUN_ID,
    });

    strictEqual(report.consensus.status, 'cancelled');
    strictEqual(report.consensus.status_guidance.state, 'cancelled');
    strictEqual(report.recommended_next_work, 'Start a new consensus run only if the issue still needs peer review.');
    ok(report.consensus.cancellation_pointer.endsWith('/cancellation.json'));
    ok(report.artifacts.some((artifact) => artifact.kind === 'consensus-cancellation'));

    const text = formatText(report);
    ok(text.includes('consensus cancellation:'));
    ok(text.includes('consensus guidance: cancelled'));
    ok(!text.includes('RAW CANCELLATION REASON'));
    ok(!JSON.stringify(report).includes('RAW CANCELLATION REASON'));
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

  it('can link the latest open consensus run without selecting terminal artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-footer-consensus-latest-open-'));
    const openRunId = 'consensus-20260513T000000Z-111111';
    const cancelledRunId = CONSENSUS_RUN_ID;
    await runConsensus({
      command: 'plan',
      repoRoot: root,
      runId: openRunId,
      now: new Date('2026-05-13T00:00:00.000Z'),
      task: 'open consensus task must stay hidden.',
    });
    await runConsensus({
      command: 'plan',
      repoRoot: root,
      runId: cancelledRunId,
      now: new Date('2026-05-13T01:00:00.000Z'),
      task: 'cancelled consensus task must stay hidden.',
    });
    await runConsensus({
      command: 'cancel',
      repoRoot: root,
      runId: cancelledRunId,
      now: new Date('2026-05-13T02:00:00.000Z'),
      reason: 'No longer needed.',
    });

    const report = await runFooter({
      repoRoot: root,
      host: 'codex',
      consensusLatestOpen: true,
    });

    strictEqual(report.consensus.run_id, openRunId);
    strictEqual(report.consensus.lookup.mode, 'latest-open');
    strictEqual(report.consensus.lookup.latest_open, true);
    strictEqual(report.consensus.lookup.skipped_terminal, 1);
    strictEqual(report.consensus.status_guidance.state, 'execute_or_record');
    strictEqual(report.next_session.command, `$runtime:consensus status --run-id ${openRunId}`);

    const text = formatText(report);
    ok(text.includes('consensus lookup:'));
    ok(text.includes('- mode: latest-open'));
    ok(text.includes('consensus guidance: execute_or_record'));
    ok(!text.includes('open consensus task'));
    ok(!text.includes('cancelled consensus task'));
    ok(!JSON.stringify(report).includes('cancelled consensus task'));
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
    strictEqual(report.completion_state, 'publish-needed');
    ok(report.completion.next_action.includes('Ask the user whether to commit'));
    strictEqual(report.pr_handling.should_ask_user, true);
    ok(report.pr_handling.prompt.includes('Ask the user'));
    ok(report.pr_handling.criteria.every((criterion) => criterion.status === 'pass'));

    const text = formatText(report);
    ok(text.includes('PR handling:'));
    ok(text.includes('- recommendation: ask-user'));
    ok(text.includes('completion state: publish-needed'));
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
    strictEqual(report.completion_state, 'blocked');
    ok(report.completion.next_action.includes('Resolve failed PR handling criteria'));
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
    strictEqual(report.completion_state, 'review-needed');
    strictEqual(report.pr_handling.should_ask_user, false);
    ok(report.pr_handling.criteria.some((criterion) => criterion.name === 'blocking_reviews' && criterion.status === 'unknown'));
  });

  it('renders advisory cutover record guidance without writing evidence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-footer-cutover-ready-'));
    const report = await runFooter({
      repoRoot: root,
      host: 'codex',
      completionState: 'next-work-available',
      completionReason: 'release/install loop complete; R4 remains open',
      cutoverRecord: true,
      cutoverOmccDevActive: 'no',
      cutoverOmccDevNote: 'runtime-only dogfood',
      cutoverDogfoodDate: '2026-05-16',
    });

    strictEqual(report.cutover_record.status, 'ready');
    strictEqual(report.cutover_record.recommended, true);
    strictEqual(report.cutover_record.footer_state, 'next-work-available');
    strictEqual(report.cutover_record.omcc_dev_active, 'no');
    ok(report.cutover_record.command.includes('$runtime:cutover record'));
    ok(report.cutover_record.command.includes('--footer-state next-work-available'));
    ok(report.cutover_record.command.includes('--footer-reason "release/install loop complete; R4 remains open"'));
    ok(report.cutover_record.command.includes('--omcc-dev-active no'));
    ok(report.cutover_record.command.includes('--omcc-dev-note "runtime-only dogfood"'));
    ok(report.cutover_record.command.includes('--dogfood-date 2026-05-16'));
    ok(report.cutover_record.limits.some((limit) => /does not write cutover evidence/i.test(limit)));

    const text = formatText(report);
    ok(text.includes('cutover record:'));
    ok(text.includes('- status: ready'));
    ok(text.includes('$runtime:cutover record'));
    ok(text.includes('does not write cutover evidence'));
  });

  it('requires explicit omcc-dev activity evidence before suggesting cutover record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-footer-cutover-missing-'));
    const report = await runFooter({
      repoRoot: root,
      host: 'neutral',
      cutoverRecord: true,
    });

    strictEqual(report.cutover_record.status, 'needs-operator-evidence');
    strictEqual(report.cutover_record.recommended, false);
    strictEqual(report.cutover_record.omcc_dev_active, null);
    strictEqual(report.cutover_record.command, null);
    ok(report.cutover_record.next_action.includes('--cutover-omcc-dev-active'));

    const text = formatText(report);
    ok(text.includes('- status: needs-operator-evidence'));
    ok(text.includes('- recommended: false'));
    ok(!text.includes('runtime:cutover record --footer-state'));
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
      '--completion-state',
      'cleanup-needed',
      '--completion-reason',
      'Merged branch remains to clean up.',
      '--completion-next-action',
      'Delete merged local and remote branches.',
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
      '--cutover-record',
      '--cutover-omcc-dev-active',
      'unknown',
      '--cutover-omcc-dev-note',
      'operator will verify activity',
      '--cutover-dogfood-date',
      '2026-05-16',
      '--recommended-next-work',
      'Commit after review.',
    ]);
    strictEqual(opts.format, 'json');
    strictEqual(opts.host, 'neutral');
    strictEqual(opts.contextState, 'yellow');
    strictEqual(opts.completionState, 'cleanup-needed');
    strictEqual(opts.completionReason, 'Merged branch remains to clean up.');
    strictEqual(opts.completionNextAction, 'Delete merged local and remote branches.');
    strictEqual(opts.consensusRunId, 'consensus-20260513T010000Z-abcdef');
    strictEqual(opts.workflowKind, 'engineer');
    strictEqual(opts.prHandling, true);
    strictEqual(opts.prCompletionBoundary, 'reached');
    strictEqual(opts.prValidationState, 'passed');
    strictEqual(opts.prReviewState, 'clear');
    strictEqual(opts.prBranchState, 'pushable');
    strictEqual(opts.cutoverRecord, true);
    strictEqual(opts.cutoverOmccDevActive, 'unknown');
    strictEqual(opts.cutoverOmccDevNote, 'operator will verify activity');
    strictEqual(opts.cutoverDogfoodDate, '2026-05-16');

    throws(() => parseArgs(['render', '--context-latest', '--context-run-id', RUN_ID]), /Use either --context-run-id or --context-latest/);
    const latestOpenOpts = parseArgs(['render', '--consensus-latest-open']);
    strictEqual(latestOpenOpts.consensusLatestOpen, true);

    throws(() => parseArgs(['render', '--consensus-latest', '--consensus-run-id', CONSENSUS_RUN_ID]), /Use only one of --consensus-run-id, --consensus-latest, or --consensus-latest-open/);
    throws(() => parseArgs(['render', '--consensus-latest', '--consensus-latest-open']), /Use only one of --consensus-run-id, --consensus-latest, or --consensus-latest-open/);
    throws(() => parseArgs(['render', '--context-run-id', '../bad']), /Invalid --context-run-id/);
    throws(() => parseArgs(['render', '--consensus-run-id', '../bad']), /Invalid --consensus-run-id/);
    throws(() => parseArgs(['render', '--stale-after-hours', 'soon']), /non-negative integer/);
    throws(() => parseArgs(['render', '--context-state', 'orange']), /green, yellow, or red/);
    throws(() => parseArgs(['render', '--completion-state', 'done-ish']), /review-needed, publish-needed, cleanup-needed, next-work-available, blocked, or closed/);
    throws(() => parseArgs(['render', '--pr-completion-boundary', 'maybe']), /reached, not-reached, or unknown/);
    throws(() => parseArgs(['render', '--pr-validation-state', 'maybe']), /passed, waived, failed, not-run, or unknown/);
    throws(() => parseArgs(['render', '--pr-review-state', 'maybe']), /clear, blocking, or unknown/);
    throws(() => parseArgs(['render', '--pr-branch-state', 'maybe']), /pushable, not-pushable, or unknown/);
    throws(() => parseArgs(['render', '--cutover-omcc-dev-active', 'maybe']), /yes, no, or unknown/);
    throws(() => parseArgs(['render', '--cutover-dogfood-date', '2026-02-30']), /valid calendar date/);
    throws(() => parseArgs(['render', '--cutover-dogfood-date', '05-16-2026']), /YYYY-MM-DD/);
    throws(() => parseArgs(['render', '--artifact', 'bad\npath']), /single-line/);
    ok(formatText({ help: true }).includes('--consensus-latest-open'));

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

describe('runtime footer session handoff (ADR-0031)', () => {
  const fullProjection = (overrides = {}) => ({
    workflow_kind: 'orchestrator',
    workflow_id: 'macro-x',
    workflow_path: '.agentic-plugins/state/orchestrator/workflows/macro-x.md',
    phase: 'phase-2-presented',
    next_action: 'dispatch the next subtask',
    archive_gate: 'not_terminal',
    routing_recommendation: '/orchestrator:next',
    ...overrides,
  });

  it('enriches the footer with the projection and session decision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-footer-projection-'));
    const projPath = join(root, 'proj.json');
    await writeFile(projPath, JSON.stringify(fullProjection()));
    const report = await runFooter({
      repoRoot: root,
      host: 'claude',
      contextState: 'red',
      workflowProjectionFile: projPath,
    });
    strictEqual(report.workflow.kind, 'orchestrator');
    strictEqual(report.workflow.archive_gate, 'not_terminal');
    strictEqual(report.session_handoff.recommended_session, 'fresh_or_resumed');
    strictEqual(report.session_handoff.routing_recommendation, '/orchestrator:next');
    strictEqual(report.session_handoff.next_command, '/orchestrator:next');
    const text = formatText(report);
    ok(text.includes('session handoff (continue-vs-fresh):'));
    ok(text.includes('workflow archive gate: not_terminal'));
    ok(text.includes('next command: /orchestrator:next'));
  });

  it('accepts founder and designer projections as first-class supported kinds (ADR-0043 §1)', async () => {
    for (const kind of ['founder', 'designer']) {
      const root = await mkdtemp(join(tmpdir(), `runtime-footer-${kind}-`));
      const projPath = join(root, 'proj.json');
      await writeFile(projPath, JSON.stringify(fullProjection({ workflow_kind: kind })));
      const report = await runFooter({
        repoRoot: root,
        host: 'claude',
        contextState: 'yellow',
        workflowProjectionFile: projPath,
      });
      strictEqual(report.projection_error, undefined, `${kind} must load without a projection error`);
      strictEqual(report.workflow.kind, kind);
      strictEqual(report.workflow.archive_gate, 'not_terminal');
      strictEqual('unsupported_workflow_kind' in report.session_handoff, false,
        `${kind} must not be reported as an unsupported kind`);
    }
  });

  it('reports an honest unsupported workflow_kind in the footer instead of no-active-workflow (runtime-unsupported-kind)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-footer-unsupported-'));
    const projPath = join(root, 'image.json');
    // The genuinely unsupported fixture is `image` (lean L2 with no workflow
    // state machine — ADR-0037): the degradation path outlived the
    // founder/designer enablement (ADR-0043 §1), and the footer must keep
    // reporting it honestly, not silently drop to the no-active-workflow
    // (absent) path.
    await writeFile(projPath, JSON.stringify(fullProjection({ workflow_kind: 'image', routing_recommendation: '/image:frame' })));
    const report = await runFooter({
      repoRoot: root,
      host: 'claude',
      contextState: 'yellow',
      workflowProjectionFile: projPath,
    });
    strictEqual(report.session_handoff.archive_gate, 'unsupported_kind');
    strictEqual(report.session_handoff.unsupported_workflow_kind, 'image');
    ok(report.projection_error, 'the projection rejection is still surfaced');
    const text = formatText(report);
    ok(text.includes('unsupported workflow kind: image'), 'footer text names the unsupported kind');
    ok(/enablement out of scope/.test(text), 'footer text records the enablement boundary');
  });

  it('degrades to per-field workflow flags and omits session_handoff without a projection', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-footer-noproj-'));
    const report = await runFooter({
      repoRoot: root,
      host: 'claude',
      contextState: 'yellow',
      workflowKind: 'engineer',
      workflowId: 'w1',
    });
    strictEqual(report.workflow.kind, 'engineer');
    strictEqual('session_handoff' in report, false);
    strictEqual('archive_gate' in report.workflow, false);
  });

  it('degrades cleanly on a malformed projection and ignores legacy workflow flags', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-footer-badproj-'));
    const badPath = join(root, 'bad.json');
    await writeFile(badPath, '{ not valid json');
    const report = await runFooter({
      repoRoot: root,
      host: 'claude',
      contextState: 'yellow',
      workflowProjectionFile: badPath,
      // legacy flags must NOT leak through once the projection model was opted into.
      workflowKind: 'engineer',
      workflowId: 'should-not-appear',
    });
    ok(report.projection_error);
    strictEqual(report.session_handoff.archive_gate, 'absent');
    strictEqual(report.workflow.kind, null);
    strictEqual(report.workflow.id, null);
  });

  it('rejects a projection with missing required fields (bounded schema)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-footer-incomplete-'));
    const badPath = join(root, 'incomplete.json');
    const incomplete = fullProjection();
    delete incomplete.phase;
    await writeFile(badPath, JSON.stringify(incomplete));
    const report = await runFooter({
      repoRoot: root,
      host: 'claude',
      contextState: 'yellow',
      workflowProjectionFile: badPath,
    });
    ok(/phase/.test(report.projection_error));
    strictEqual(report.workflow.kind, null);
  });

  it('parses --workflow-projection-file and --routing-recommendation', () => {
    const options = parseArgs([
      '--host', 'claude',
      '--workflow-projection-file', '/tmp/p.json',
      '--routing-recommendation', '/orchestrator:next',
    ]);
    strictEqual(options.workflowProjectionFile, '/tmp/p.json');
    strictEqual(options.routingRecommendation, '/orchestrator:next');
  });
});

// ADR-0039 follow-up — persona colon-commands (engineer:/orchestrator:/founder:/
// designer:/image:) must render host-correct on every advisory command surface,
// exactly like runtime: commands. The projection produces host-neutral data with
// Claude-shaped routing (/engineer:resume); the RENDER host decides the prefix.
// designer joined the localization set via ADR-0043 §1 (latent-omission fix).
describe('runtime footer persona command host-localization', () => {
  const personaProjection = (overrides = {}) => ({
    workflow_kind: 'engineer',
    workflow_id: 'w-1',
    workflow_path: 'wf/w-1.md',
    phase: 'summary-complete',
    next_action: 'Address findings via /engineer:refine before archiving',
    archive_gate: 'not_terminal',
    routing_recommendation: '/engineer:resume',
    ...overrides,
  });

  const renderWith = async (host, overrides = {}, options = {}) => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-footer-persona-'));
    const projPath = join(root, 'proj.json');
    await writeFile(projPath, JSON.stringify(personaProjection(overrides)));
    return runFooter({
      repoRoot: root,
      host,
      contextState: 'red', // red → fresh_or_resumed → next_command is populated
      workflowProjectionFile: projPath,
      ...options,
    });
  };

  it('rewrites Claude-shaped persona routing to $ for a codex render (report + text)', async () => {
    const report = await renderWith('codex');
    strictEqual(report.session_handoff.routing_recommendation, '$engineer:resume');
    strictEqual(report.session_handoff.next_command, '$engineer:resume');
    strictEqual(report.session_handoff.workflow.next_action, 'Address findings via $engineer:refine before archiving');
    strictEqual(report.workflow.routing_recommendation, '$engineer:resume');
    strictEqual(report.workflow.next_action, 'Address findings via $engineer:refine before archiving');
    const text = formatText(report);
    ok(text.includes('- routing: $engineer:resume'));
    ok(text.includes('- next command: $engineer:resume'));
    ok(!text.includes('/engineer:resume'), 'no Claude-shaped persona command may survive a codex render');
  });

  it('rewrites Codex-shaped routing back to / for a claude render (cross-host symmetry)', async () => {
    const report = await renderWith('claude', {
      workflow_kind: 'orchestrator',
      routing_recommendation: '$orchestrator:resume',
      next_action: 'Dispatch via $orchestrator:next',
    });
    strictEqual(report.session_handoff.routing_recommendation, '/orchestrator:resume');
    strictEqual(report.session_handoff.next_command, '/orchestrator:resume');
    strictEqual(report.workflow.next_action, 'Dispatch via /orchestrator:next');
  });

  it('keeps a neutral render untouched (existing behavior preserved)', async () => {
    const report = await renderWith('neutral');
    strictEqual(report.session_handoff.routing_recommendation, '/engineer:resume');
    strictEqual(report.session_handoff.next_command, '/engineer:resume');
    strictEqual(report.workflow.next_action, 'Address findings via /engineer:refine before archiving');
  });

  it('localizes designer routing on a supported-kind projection (ADR-0043 §1 latent-omission regression)', async () => {
    // Before ADR-0043, PLUGIN_COMMAND_RE omitted designer:, so a
    // /designer:<verb> command flowing through a footer survived a codex
    // render un-rewritten. Pin the fix on the now-supported designer kind.
    const report = await renderWith('codex', {
      workflow_kind: 'designer',
      routing_recommendation: '/designer:resume',
      next_action: 'Re-critique via /designer:critique before archiving',
    });
    strictEqual('unsupported_workflow_kind' in report.session_handoff, false);
    strictEqual(report.session_handoff.routing_recommendation, '$designer:resume');
    strictEqual(report.session_handoff.next_command, '$designer:resume');
    strictEqual(report.workflow.next_action, 'Re-critique via $designer:critique before archiving');
  });

  it('localizes the routing surviving an unsupported-kind projection (image)', async () => {
    const report = await renderWith('codex', {
      workflow_kind: 'image',
      routing_recommendation: '/image:frame',
    });
    strictEqual(report.session_handoff.unsupported_workflow_kind, 'image');
    strictEqual(report.session_handoff.routing_recommendation, '$image:frame');
    strictEqual(report.session_handoff.next_command, '$image:frame');
  });

  it('localizes every PLUGIN_COMMAND_RE member (table-driven omission guard)', async () => {
    // The designer omission fixed by ADR-0043 §1 was exactly this failure
    // mode: a plugin with a command surface missing from the regex. Drive
    // every member through the render path so the next omission cannot land
    // without failing here.
    const commands = ['runtime', 'engineer', 'orchestrator', 'founder', 'designer', 'image'];
    const root = await mkdtemp(join(tmpdir(), 'runtime-footer-persona-table-'));
    const report = await runFooter({
      repoRoot: root,
      host: 'codex',
      contextState: 'green',
      recommendedNextWork: commands.map((name) => `/${name}:x`).join(' '),
    });
    strictEqual(
      report.recommended_next_work,
      commands.map((name) => `$${name}:x`).join(' '),
    );
  });

  it('localizes recommended-next-work and the completion next action (sidecar path)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-footer-persona-rnw-'));
    const report = await runFooter({
      repoRoot: root,
      host: 'codex',
      contextState: 'green',
      recommendedNextWork: 'Run /engineer:refine then runtime:doctor, /designer:critique and image:compose',
    });
    strictEqual(
      report.recommended_next_work,
      'Run $engineer:refine then $runtime:doctor, $designer:critique and $image:compose',
    );
    strictEqual(
      report.completion.next_action,
      'Run $engineer:refine then $runtime:doctor, $designer:critique and $image:compose',
    );
  });

  it('does not rewrite path-like text and is idempotent on already-localized commands', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-footer-persona-safe-'));
    const report = await runFooter({
      repoRoot: root,
      host: 'codex',
      contextState: 'green',
      recommendedNextWork: 'See plugins/runtime/scripts and a/engineer:x then $engineer:resume',
    });
    strictEqual(
      report.recommended_next_work,
      'See plugins/runtime/scripts and a/engineer:x then $engineer:resume',
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
