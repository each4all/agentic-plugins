import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual, throws, rejects } from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  formatText,
  parseArgs,
  runContext,
} from '../../plugins/runtime/scripts/context.mjs';

const RUN_ID = 'context-20260513T000000Z-abcdef';
const LATER_RUN_ID = 'context-20260513T020000Z-fedcba';

describe('runtime context', () => {
  it('captures a bounded context artifact without mutating host session state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-context-capture-'));
    const report = await runContext({
      command: 'capture',
      repoRoot: root,
      runId: RUN_ID,
      now: new Date('2026-05-13T00:00:00.000Z'),
      summary: 'Context summary for the runtime context hygiene MVP.',
      risk: 'yellow',
      riskReason: 'Large follow-up work should start from an artifact pointer.',
      artifacts: ['readiness:.agentic-plugins/runs/doctor/latest.json'],
      nextAction: 'Start a fresh session before expanding runtime automation.',
      nextSessionPrompt: 'Continue from the runtime context artifact and keep scope bounded.',
    });

    strictEqual(report.command, 'capture');
    strictEqual(report.run_id, RUN_ID);
    strictEqual(report.risk_level, 'yellow');
    strictEqual(report.context_summary, 'Context summary for the runtime context hygiene MVP.');
    strictEqual(report.next_session.recommended_action, 'Start a fresh session before expanding runtime automation.');
    ok(report.artifacts.some((artifact) => artifact.kind === 'readiness' && artifact.pointer === '.agentic-plugins/runs/doctor/latest.json'));
    ok(report.limits.some((limit) => /does not mutate host session context/i.test(limit)));

    const artifact = await readJson(join(root, '.agentic-plugins', 'runs', 'context', RUN_ID, 'context.json'));
    strictEqual(artifact.schema_version, 'runtime-context-artifact-1.0');
    strictEqual(artifact.context.risk_level, 'yellow');
    strictEqual(artifact.next_session.prompt_pointer, `.agentic-plugins/runs/context/${RUN_ID}/next-session-prompt.md`);

    const prompt = await readFile(join(root, artifact.next_session.prompt_pointer), 'utf8');
    strictEqual(prompt, 'Continue from the runtime context artifact and keep scope bounded.\n');
    ok(formatText(report).includes('context summary:'));
    ok(formatText(report).includes('recommended next action: Start a fresh session'));
  });

  it('generates a next-session prompt and status report from the stored artifact', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-context-status-'));
    await runContext({
      command: 'capture',
      repoRoot: root,
      runId: RUN_ID,
      now: new Date('2026-05-13T00:00:00.000Z'),
      summary: 'Use this context artifact for the next runtime PR.',
      risk: 'red',
      artifacts: ['consensus:.agentic-plugins/runs/consensus/run/consensus.json'],
    });

    const report = await runContext({
      command: 'status',
      repoRoot: root,
      runId: RUN_ID,
    });

    strictEqual(report.command, 'status');
    strictEqual(report.risk_level, 'red');
    ok(report.next_session.prompt_preview.includes('Use this context artifact for the next runtime PR.'));
    ok(report.artifacts.some((artifact) => artifact.kind === 'consensus'));
    ok(!JSON.stringify(report).includes('RAW PEER OUTPUT'));
  });

  it('finds the latest context artifact and reports stale handoff status', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-context-latest-'));
    await runContext({
      command: 'capture',
      repoRoot: root,
      runId: RUN_ID,
      now: new Date('2026-05-13T00:00:00.000Z'),
      summary: 'Older runtime handoff.',
      risk: 'green',
    });
    await runContext({
      command: 'capture',
      repoRoot: root,
      runId: LATER_RUN_ID,
      now: new Date('2026-05-13T02:00:00.000Z'),
      summary: 'Latest runtime handoff.',
      risk: 'yellow',
    });

    const report = await runContext({
      command: 'status',
      repoRoot: root,
      latest: true,
      now: new Date('2026-05-13T04:00:00.000Z'),
      staleAfterMs: 60 * 60 * 1000,
    });

    strictEqual(report.run_id, LATER_RUN_ID);
    strictEqual(report.context_summary, 'Latest runtime handoff.');
    strictEqual(report.handoff.mode, 'latest');
    strictEqual(report.handoff.latest, true);
    strictEqual(report.handoff.age_minutes, 120);
    strictEqual(report.handoff.stale, true);
    strictEqual(report.handoff.guidance.state, 'capture_new_context');
    strictEqual(report.handoff.guidance.reason, 'handoff artifact age exceeds the configured stale threshold');
    ok(report.handoff.guidance.recommended_action.includes('Capture a new runtime:context artifact'));
    ok(formatText(report).includes('handoff lookup:'));
    ok(formatText(report).includes('handoff guidance: capture_new_context'));
  });

  it('reports source-stale handoffs when the current git commit moved after capture', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-context-source-stale-'));
    await runContext({
      command: 'capture',
      repoRoot: root,
      runId: RUN_ID,
      now: new Date('2026-05-13T00:00:00.000Z'),
      summary: 'Context from the previous runtime release.',
      risk: 'yellow',
      sourceSnapshot: {
        status: 'observed',
        kind: 'git',
        commit: '1111111111111111111111111111111111111111',
        branch: 'main',
        dirty: false,
      },
    });

    const report = await runContext({
      command: 'status',
      repoRoot: root,
      runId: RUN_ID,
      now: new Date('2026-05-13T00:30:00.000Z'),
      currentSourceSnapshot: {
        status: 'observed',
        kind: 'git',
        commit: '2222222222222222222222222222222222222222',
        branch: 'main',
        dirty: false,
      },
    });

    strictEqual(report.source_snapshot.commit, '1111111111111111111111111111111111111111');
    strictEqual(report.handoff.source_freshness.status, 'stale');
    strictEqual(report.handoff.source_freshness.artifact_commit, '1111111111111111111111111111111111111111');
    strictEqual(report.handoff.source_freshness.current_commit, '2222222222222222222222222222222222222222');
    strictEqual(report.handoff.source_freshness.reason, 'current git commit differs from the context artifact commit');
    strictEqual(report.handoff.guidance.state, 'capture_new_context');
    strictEqual(report.handoff.guidance.recommended_session, 'fresh_or_resumed');
    ok(report.handoff.guidance.recommended_action.includes('Capture a new runtime:context artifact'));
    ok(report.handoff.guidance.commands.some((command) => command.includes('runtime:context capture')));
    ok(formatText(report).includes('source freshness:'));
    ok(formatText(report).includes('- source status: stale'));
    ok(formatText(report).includes('handoff guidance: capture_new_context'));
  });

  it('does not treat dirty-captured source handoffs as verified-current', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-context-dirty-artifact-'));
    await runContext({
      command: 'capture',
      repoRoot: root,
      runId: RUN_ID,
      now: new Date('2026-05-13T00:00:00.000Z'),
      summary: 'Context captured while uncommitted source changes existed.',
      risk: 'yellow',
      sourceSnapshot: {
        status: 'observed',
        kind: 'git',
        commit: '3333333333333333333333333333333333333333',
        branch: 'feature/runtime-context',
        dirty: true,
      },
    });

    const report = await runContext({
      command: 'status',
      repoRoot: root,
      runId: RUN_ID,
      now: new Date('2026-05-13T00:15:00.000Z'),
      currentSourceSnapshot: {
        status: 'observed',
        kind: 'git',
        commit: '3333333333333333333333333333333333333333',
        branch: 'feature/runtime-context',
        dirty: false,
      },
    });

    strictEqual(report.handoff.source_freshness.status, 'unknown');
    strictEqual(report.handoff.source_freshness.artifact_dirty, true);
    strictEqual(report.handoff.source_freshness.current_dirty, false);
    strictEqual(report.handoff.guidance.state, 'inspect_context');
    ok(report.handoff.source_freshness.reason.includes('dirty worktree'));
    ok(report.handoff.guidance.recommended_action.includes('Inspect the current checkout'));
    ok(formatText(report).includes('- source status: unknown'));
    ok(formatText(report).includes('handoff guidance: inspect_context'));
  });

  it('checks explicit context budget without creating artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-context-check-'));
    const report = await runContext({
      command: 'check',
      repoRoot: root,
      tokenBudget: 100000,
      usedTokens: 82000,
    });

    strictEqual(report.command, 'check');
    strictEqual(report.read_only, true);
    strictEqual(report.risk_level, 'yellow');
    strictEqual(report.context_budget.status, 'observed');
    strictEqual(report.context_budget.used_percent, 82);
    strictEqual(report.context_budget.remaining_tokens, 18000);
    ok(report.next_session.recommended_action.includes('Prefer a fresh or resumed session'));
    ok(report.limits.some((limit) => /no context artifact is created/i.test(limit)));
    ok(formatText(report).includes('context budget:'));
    await rejects(stat(join(root, '.agentic-plugins')), /ENOENT/);
  });

  it('classifies green and red context checks from explicit inputs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-context-check-risk-'));
    const green = await runContext({
      command: 'check',
      repoRoot: root,
      tokenBudget: 100000,
      remainingTokens: 40000,
    });
    const red = await runContext({
      command: 'check',
      repoRoot: root,
      tokenBudget: 100000,
      usedTokens: 95000,
    });

    strictEqual(green.risk_level, 'green');
    strictEqual(green.context_budget.used_tokens, 60000);
    strictEqual(red.risk_level, 'red');
    strictEqual(red.context_budget.used_ratio, 0.95);
  });

  it('accepts caller-supplied check risk without pretending to measure host context', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-context-check-manual-'));
    const report = await runContext({
      command: 'check',
      repoRoot: root,
      risk: 'red',
      riskReason: 'Long implementation session.',
    });

    strictEqual(report.risk_level, 'red');
    strictEqual(report.context_budget.status, 'not_provided');
    strictEqual(report.risk_reason, 'Long implementation session.');
  });

  it('normalizes absolute artifact pointers only when they stay inside the repo', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-context-artifacts-'));
    const report = await runContext({
      command: 'capture',
      repoRoot: root,
      runId: RUN_ID,
      summary: 'Absolute artifact pointers are normalized to repo-relative pointers.',
      artifacts: [`note:${resolve(root, 'notes', 'handoff.md')}`],
    });

    ok(report.artifacts.some((artifact) => artifact.kind === 'note' && artifact.pointer === 'notes/handoff.md'));
    await rejectsAsync(
      runContext({
        command: 'capture',
        repoRoot: root,
        runId: 'context-20260513T000001Z-abcdef',
        summary: 'bad',
        artifacts: [`bad:${resolve(root, '..', 'outside.md')}`],
      }),
      /escapes repo root/,
    );
  });

  it('parses CLI arguments and rejects unsafe ids or ambiguous text inputs', () => {
    const opts = parseArgs([
      'capture',
      '--repo-root',
      '/tmp/repo',
      '--format',
      'json',
      '--summary',
      'Context is getting large.',
      '--risk',
      'green',
      '--artifact',
      'workflow:.claude/agentic-engineer/workflows/id.md',
      '--next-action',
      'Continue carefully.',
    ]);
    strictEqual(opts.command, 'capture');
    strictEqual(opts.format, 'json');
    strictEqual(opts.risk, 'green');
    deepStrictEqual(opts.artifacts, ['workflow:.claude/agentic-engineer/workflows/id.md']);

    const commandStyle = parseArgs(['--repo-root', '/tmp/repo', 'status', '--run-id', RUN_ID]);
    strictEqual(commandStyle.command, 'status');
    strictEqual(commandStyle.runId, RUN_ID);

    const latestStatus = parseArgs(['status', '--latest', '--stale-after-hours', '6']);
    strictEqual(latestStatus.command, 'status');
    strictEqual(latestStatus.latest, true);
    strictEqual(latestStatus.staleAfterMs, 6 * 60 * 60 * 1000);

    const check = parseArgs(['check', '--repo-root', '/tmp/repo', '--token-budget', '100000', '--used-tokens', '71000']);
    strictEqual(check.command, 'check');
    strictEqual(check.tokenBudget, 100000);
    strictEqual(check.usedTokens, 71000);

    throws(() => parseArgs(['status', '--run-id', '../bad']), /Invalid --run-id/);
    throws(() => parseArgs(['capture', '--risk', 'orange']), /green, yellow, or red/);
    throws(() => parseArgs(['capture', '--artifact', 'bad\npath']), /single-line/);
    throws(() => parseArgs(['check', '--token-budget', '0', '--used-tokens', '1']), /positive integer/);
    throws(() => parseArgs(['check', '--used-tokens', 'abc']), /non-negative integer/);
  });

  it('rejects ambiguous or incomplete context budget checks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-context-check-invalid-'));
    await rejectsAsync(
      runContext({
        command: 'check',
        repoRoot: root,
        tokenBudget: 100000,
      }),
      /check requires --token-budget/,
    );
    await rejectsAsync(
      runContext({
        command: 'check',
        repoRoot: root,
        tokenBudget: 100000,
        usedTokens: 1000,
        remainingTokens: 99000,
      }),
      /Use either --used-tokens or --remaining-tokens/,
    );
    await rejectsAsync(
      runContext({
        command: 'check',
        repoRoot: root,
        tokenBudget: 100000,
        usedTokens: 1000,
        risk: 'green',
      }),
      /Use budget metrics or --risk/,
    );
  });

  it('rejects missing or ambiguous context status lookup inputs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-context-status-invalid-'));
    await rejectsAsync(
      runContext({
        command: 'status',
        repoRoot: root,
      }),
      /status requires --run-id or --latest/,
    );
    await rejectsAsync(
      runContext({
        command: 'status',
        repoRoot: root,
        runId: RUN_ID,
        latest: true,
      }),
      /Use either --run-id or --latest/,
    );
    await rejectsAsync(
      runContext({
        command: 'status',
        repoRoot: root,
        latest: true,
      }),
      /No context artifacts found/,
    );
  });
});

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function rejectsAsync(promise, pattern) {
  try {
    await promise;
  } catch (error) {
    ok(pattern.test(error.message), `expected ${error.message} to match ${pattern}`);
    return;
  }
  throw new Error('Expected promise to reject');
}
