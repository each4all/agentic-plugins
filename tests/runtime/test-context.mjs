import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  formatText,
  parseArgs,
  runContext,
} from '../../plugins/runtime/scripts/context.mjs';

const RUN_ID = 'context-20260513T000000Z-abcdef';

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

    throws(() => parseArgs(['status', '--run-id', '../bad']), /Invalid --run-id/);
    throws(() => parseArgs(['capture', '--risk', 'orange']), /green, yellow, or red/);
    throws(() => parseArgs(['capture', '--artifact', 'bad\npath']), /single-line/);
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
