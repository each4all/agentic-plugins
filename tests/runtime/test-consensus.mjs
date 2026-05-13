import { describe, it } from 'node:test';
import { deepStrictEqual, ok, strictEqual, throws } from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  formatText,
  parseArgs,
  runConsensus,
} from '../../plugins/runtime/scripts/consensus.mjs';

const RUN_ID = 'consensus-20260513T000000Z-abcdef';

describe('runtime consensus', () => {
  it('plans independent peer fanout without executing peers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-consensus-plan-'));
    const report = await runConsensus({
      command: 'plan',
      repoRoot: root,
      runId: RUN_ID,
      now: new Date('2026-05-13T00:00:00.000Z'),
      task: 'Check the ADR-0024 runtime consensus MVP scope.',
      peers: ['claude', 'codex', 'reviewer'],
      maxPeers: 2,
      maxRounds: 2,
      tokenBudget: 8000,
    });

    strictEqual(report.command, 'plan');
    strictEqual(report.run_id, RUN_ID);
    deepStrictEqual(report.peers.active, ['claude', 'codex']);
    deepStrictEqual(report.peers.skipped, ['reviewer']);
    ok(report.limits.some((limit) => /never executes peer agents/i.test(limit)));

    const manifest = await readJson(join(root, '.agentic-plugins', 'runs', 'consensus', RUN_ID, 'manifest.json'));
    strictEqual(manifest.schema_version, 'runtime-consensus-run-1.0');
    strictEqual(manifest.status, 'planned');
    strictEqual(manifest.rounds[0].kind, 'independent-fanout');
    strictEqual(manifest.rounds[0].prompts.length, 2);
    strictEqual(manifest.policy.raw_output_policy, 'artifact-pointer-only');

    const prompt = await readFile(join(root, manifest.rounds[0].prompts[0].pointer), 'utf8');
    ok(prompt.includes('Check the ADR-0024 runtime consensus MVP scope.'));
    ok(formatText(report).includes(`run: ${RUN_ID}`));
  });

  it('records raw peer output as an artifact pointer without leaking content', async () => {
    const root = await seedPlan();
    const rawOutput = 'RAW PEER OUTPUT THAT MUST NOT ENTER THE MAIN REPORT';
    const inputFile = join(root, 'peer-output.txt');
    await writeFile(inputFile, rawOutput);

    const report = await runConsensus({
      command: 'record',
      repoRoot: root,
      runId: RUN_ID,
      peer: 'claude',
      inputFile,
      now: new Date('2026-05-13T00:01:00.000Z'),
    });

    strictEqual(report.command, 'record');
    strictEqual(report.raw_output.bytes, Buffer.byteLength(rawOutput));
    ok(report.raw_output.sha256);
    ok(!JSON.stringify(report).includes(rawOutput), 'json report must not include raw output content');
    ok(!formatText(report).includes(rawOutput), 'text report must not include raw output content');

    const stored = await readFile(join(root, report.raw_output.pointer), 'utf8');
    strictEqual(stored, rawOutput);
  });

  it('writes consensus result as summary, durable disagreements, and evidence pointers', async () => {
    const root = await seedPlan();
    await recordPeer(root, 'claude', 'CLAUDE RAW OUTPUT');
    await recordPeer(root, 'codex', 'CODEX RAW OUTPUT');
    const summaryFile = join(root, 'summary.md');
    const disagreementsFile = join(root, 'disagreements.json');
    await writeFile(summaryFile, 'Keep the MVP artifact-only and do not execute peers.\n');
    await writeFile(disagreementsFile, JSON.stringify([
      { summary: 'Whether next-round prompts should be generated before owner review.' },
    ]));

    const report = await runConsensus({
      command: 'synthesize',
      repoRoot: root,
      runId: RUN_ID,
      summaryFile,
      disagreementsFile,
      nextAction: 'Owner decides whether to run round 2.',
      now: new Date('2026-05-13T00:03:00.000Z'),
    });

    strictEqual(report.status, 'durable-disagreement');
    strictEqual(report.durable_disagreements.length, 1);
    ok(report.evidence_pointers.some((pointer) => pointer.kind === 'peer-output' && pointer.peer === 'claude'));
    ok(!JSON.stringify(report).includes('CLAUDE RAW OUTPUT'));
    ok(!formatText(report).includes('CODEX RAW OUTPUT'));

    const manifest = await readJson(join(root, '.agentic-plugins', 'runs', 'consensus', RUN_ID, 'manifest.json'));
    const result = await readJson(join(root, manifest.consensus_pointer));
    strictEqual(result.schema_version, 'runtime-consensus-result-1.0');
    strictEqual(result.synthesized_summary, 'Keep the MVP artifact-only and do not execute peers.');
    strictEqual(result.next_action, 'Owner decides whether to run round 2.');
  });

  it('plans a targeted rebuttal round from synthesized disagreements', async () => {
    const root = await seedPlan();
    const summaryFile = join(root, 'summary.md');
    const disagreementsFile = join(root, 'disagreements.md');
    await writeFile(summaryFile, 'Summary with remaining disagreement.\n');
    await writeFile(disagreementsFile, '- Confirm whether a follow-up executor should remain out of scope.\n');
    await runConsensus({
      command: 'synthesize',
      repoRoot: root,
      runId: RUN_ID,
      summaryFile,
      disagreementsFile,
    });

    const report = await runConsensus({
      command: 'next-round',
      repoRoot: root,
      runId: RUN_ID,
      now: new Date('2026-05-13T00:04:00.000Z'),
    });

    strictEqual(report.round, 2);
    strictEqual(report.artifacts.filter((artifact) => artifact.kind === 'peer-prompt').length, 2);
    const prompt = await readFile(join(root, report.artifacts.find((artifact) => artifact.peer === 'codex').pointer), 'utf8');
    ok(prompt.includes('Confirm whether a follow-up executor should remain out of scope.'));
    ok(prompt.includes('Do not quote or depend on raw peer output'));
  });

  it('parses CLI arguments and rejects unsafe ids or invalid budgets', () => {
    const opts = parseArgs([
      'plan',
      '--repo-root',
      '/tmp/repo',
      '--format',
      'json',
      '--task',
      'review scope',
      '--peers',
      'claude,codex',
      '--max-rounds',
      '2',
      '--token-budget',
      '1000',
    ]);
    strictEqual(opts.command, 'plan');
    strictEqual(opts.format, 'json');
    deepStrictEqual(opts.peers, ['claude', 'codex']);
    strictEqual(opts.maxRounds, 2);
    strictEqual(opts.tokenBudget, 1000);

    const commandStyle = parseArgs(['--repo-root', '/tmp/repo', 'record', '--run-id', RUN_ID, '--peer', 'claude', '--input-file', 'out.txt']);
    strictEqual(commandStyle.command, 'record');
    strictEqual(commandStyle.repoRoot, '/tmp/repo');
    strictEqual(commandStyle.peer, 'claude');

    throws(() => parseArgs(['record', '--run-id', '../bad']), /Invalid --run-id/);
    throws(() => parseArgs(['record', '--peer', 'bad/peer']), /Peer ids/);
    throws(() => parseArgs(['plan', '--max-rounds', '0']), /positive integer/);
  });
});

async function seedPlan() {
  const root = await mkdtemp(join(tmpdir(), 'runtime-consensus-seed-'));
  await runConsensus({
    command: 'plan',
    repoRoot: root,
    runId: RUN_ID,
    task: 'Evaluate runtime-owned dynamic consensus scaffold.',
    peers: ['claude', 'codex'],
    maxRounds: 2,
    now: new Date('2026-05-13T00:00:00.000Z'),
  });
  return root;
}

async function recordPeer(root, peer, output) {
  const path = join(root, `${peer}.txt`);
  await writeFile(path, output);
  return runConsensus({
    command: 'record',
    repoRoot: root,
    runId: RUN_ID,
    peer,
    inputFile: path,
  });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}
