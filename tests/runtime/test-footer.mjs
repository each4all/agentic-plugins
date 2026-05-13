import { describe, it } from 'node:test';
import { ok, strictEqual, throws } from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { runContext } from '../../plugins/runtime/scripts/context.mjs';
import {
  formatText,
  parseArgs,
  runFooter,
} from '../../plugins/runtime/scripts/footer.mjs';

const RUN_ID = 'context-20260513T010000Z-abcdef';

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
    strictEqual(report.next_session.command, `$runtime:context status --run-id ${RUN_ID}`);
    ok(report.artifacts.some((artifact) => artifact.kind === 'review'));

    const text = formatText(report);
    ok(text.includes('context artifact: .agentic-plugins/runs/context/'));
    ok(text.includes('context lookup:'));
    ok(text.includes('- mode: latest'));
    ok(!text.includes('latest context summary'));
    ok(!JSON.stringify(report).includes('latest prompt'));
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
      '--workflow-kind',
      'engineer',
      '--workflow-id',
      'engineer-1',
      '--artifact',
      'workflow:.claude/agentic-engineer/workflows/engineer-1.md',
      '--recommended-next-work',
      'Commit after review.',
    ]);
    strictEqual(opts.format, 'json');
    strictEqual(opts.host, 'neutral');
    strictEqual(opts.contextState, 'yellow');
    strictEqual(opts.workflowKind, 'engineer');

    throws(() => parseArgs(['render', '--context-latest', '--context-run-id', RUN_ID]), /Use either --context-run-id or --context-latest/);
    throws(() => parseArgs(['render', '--context-run-id', '../bad']), /Invalid --context-run-id/);
    throws(() => parseArgs(['render', '--stale-after-hours', 'soon']), /non-negative integer/);
    throws(() => parseArgs(['render', '--context-state', 'orange']), /green, yellow, or red/);
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
