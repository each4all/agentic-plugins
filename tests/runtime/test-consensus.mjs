import { describe, it } from 'node:test';
import { deepStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
    deepStrictEqual(report.peers.executable, ['claude', 'codex']);
    deepStrictEqual(report.peers.manual, []);
    deepStrictEqual(report.peers.skipped, ['reviewer']);
    deepStrictEqual(report.peer_lanes.map((lane) => lane.lane), ['companion_execute', 'companion_execute']);
    ok(report.peer_lanes.every((lane) => lane.peer_execution === true));
    ok(report.limits.some((limit) => /requires the separate runtime:consensus execute command/i.test(limit)));

    const manifest = await readJson(join(root, '.agentic-plugins', 'runs', 'consensus', RUN_ID, 'manifest.json'));
    strictEqual(manifest.schema_version, 'runtime-consensus-run-1.0');
    strictEqual(manifest.status, 'planned');
    strictEqual(manifest.rounds[0].kind, 'independent-fanout');
    strictEqual(manifest.rounds[0].prompts.length, 2);
    strictEqual(manifest.policy.peer_selection, 'explicit-companion-peers-plus-manual-peer-labels');
    strictEqual(manifest.policy.raw_output_policy, 'artifact-pointer-only');
    strictEqual(manifest.policy.execution_timeout_ms, 120000);
    strictEqual(manifest.policy.limits.max_rounds_cap, 3);
    strictEqual(manifest.policy.limits.max_peers_cap, null);
    ok(manifest.policy.limits.peer_roster_boundary.includes('explicit --peers roster'));
    strictEqual(manifest.peers.lanes[0].peer, 'claude');
    strictEqual(manifest.peers.lanes[0].lane, 'companion_execute');
    strictEqual(manifest.peers.lanes[0].companion_direction, 'codex_to_claude');
    ok(manifest.peers.lanes[0].command_template.includes('--peers claude --execute'));

    const prompt = await readFile(join(root, manifest.rounds[0].prompts[0].pointer), 'utf8');
    ok(prompt.includes('Check the ADR-0024 runtime consensus MVP scope.'));
    ok(prompt.includes('Lane: companion_execute'));
    ok(formatText(report).includes(`run: ${RUN_ID}`));
    ok(formatText(report).includes('peer lanes:'));
  });

  it('does not impose a fixed small peer cap on an explicit broad roster', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-consensus-broad-roster-'));
    const manualPeers = Array.from({ length: 14 }, (_, index) => `reviewer${index + 1}`);
    const peers = ['claude', 'codex', ...manualPeers];
    const report = await runConsensus({
      command: 'plan',
      repoRoot: root,
      runId: RUN_ID,
      now: new Date('2026-05-13T00:00:00.000Z'),
      task: 'Collect a broad bounded roster without a hidden product cap.',
      peers,
      maxRounds: 2,
    });

    deepStrictEqual(report.peers.requested, peers);
    deepStrictEqual(report.peers.active, peers);
    deepStrictEqual(report.peers.skipped, []);
    deepStrictEqual(report.peers.executable, ['claude', 'codex']);
    deepStrictEqual(report.peers.manual, manualPeers);
    strictEqual(report.policy.max_peers, peers.length);
    strictEqual(report.policy.limits.max_peers_cap, null);

    const manifest = await readJson(join(root, '.agentic-plugins', 'runs', 'consensus', RUN_ID, 'manifest.json'));
    strictEqual(manifest.rounds[0].prompts.length, peers.length);
    strictEqual(manifest.peers.active.length, 16);
    strictEqual(manifest.policy.limits.peer_roster_boundary, 'explicit --peers roster; no hard-coded max peer cap');
    ok(manifest.limits.some((limit) => /explicit roster and optional --max-peers/i.test(limit)));
  });

  it('plans manual peer labels as record-only lanes and excludes them from default execution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-consensus-manual-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'runtime-consensus-home-'));
    await seedCompanionCache(homeDir);
    await runConsensus({
      command: 'plan',
      repoRoot: root,
      runId: RUN_ID,
      now: new Date('2026-05-13T00:00:00.000Z'),
      task: 'Collect broad implementation review before choosing a follow-up.',
      peers: ['claude', 'codex', 'security', 'docs', 'release'],
      maxPeers: 5,
      maxRounds: 2,
    });

    const manifest = await readJson(join(root, '.agentic-plugins', 'runs', 'consensus', RUN_ID, 'manifest.json'));
    deepStrictEqual(manifest.peers.active, ['claude', 'codex', 'security', 'docs', 'release']);
    deepStrictEqual(manifest.peers.executable, ['claude', 'codex']);
    deepStrictEqual(manifest.peers.manual, ['security', 'docs', 'release']);
    strictEqual(manifest.peers.lanes.find((lane) => lane.peer === 'security').lane, 'manual_subagent_record');
    strictEqual(manifest.peers.lanes.find((lane) => lane.peer === 'security').peer_execution, false);
    ok(manifest.peers.lanes.find((lane) => lane.peer === 'security').operator_action.includes('local subagent'));
    strictEqual(manifest.rounds[0].prompts.length, 5);
    const securityPrompt = await readFile(join(root, manifest.rounds[0].prompts.find((entry) => entry.peer === 'security').pointer), 'utf8');
    ok(securityPrompt.includes('Lane: manual_subagent_record'));
    ok(securityPrompt.includes('Run the prompt manually or in a local subagent'));

    const report = await runConsensus({
      command: 'execute',
      repoRoot: root,
      homeDir,
      runId: RUN_ID,
      execute: true,
      runner: fakeConsensusRunner(),
    });

    deepStrictEqual(report.executions.map((entry) => entry.peer), ['claude', 'codex']);
    strictEqual(report.status, 'passed');
    strictEqual(report.execution_summary.passed, 2);

    const status = await runConsensus({
      command: 'status',
      repoRoot: root,
      runId: RUN_ID,
    });

    strictEqual(status.status, 'partially-executed');
    strictEqual(status.status_guidance.state, 'record_manual_peers');
    strictEqual(status.peer_lanes.find((lane) => lane.peer === 'security').lane, 'manual_subagent_record');
    ok(status.next_steps.some((step) => step.includes('--peer security')));
    ok(status.next_steps.some((step) => step.includes('--peer docs')));
    ok(status.next_steps.some((step) => step.includes('--peer release')));
  });

  it('rejects explicit execution of manual peer labels', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-consensus-manual-reject-'));
    await runConsensus({
      command: 'plan',
      repoRoot: root,
      runId: RUN_ID,
      task: 'Manual lane should not be companion-executed.',
      peers: ['claude', 'reviewer'],
      maxPeers: 2,
    });

    await rejects(
      () => runConsensus({
        command: 'execute',
        repoRoot: root,
        runId: RUN_ID,
        peers: ['reviewer'],
        execute: true,
        runner: fakeConsensusRunner(),
      }),
      /manual-only peer\(s\): reviewer/,
    );
  });

  it('reports status guidance for a planned round before peer execution', async () => {
    const root = await seedPlan();

    const report = await runConsensus({
      command: 'status',
      repoRoot: root,
      runId: RUN_ID,
    });

    strictEqual(report.status_guidance.state, 'execute_or_record');
    strictEqual(report.next_action, 'Execute the planned peer prompts, or run them manually and record each raw output as an artifact.');
    ok(report.next_steps.includes(`runtime:consensus execute --run-id ${RUN_ID} --round 1 --execute`));
    ok(report.next_steps.some((step) => step.includes('runtime:consensus record')));
    ok(formatText(report).includes('next action: Execute the planned peer prompts'));
  });

  it('reports latest status by manifest freshness without reading raw peer output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-consensus-latest-status-'));
    const olderRunId = 'consensus-20260513T000000Z-111111';
    const newerRunId = 'consensus-20260513T010000Z-222222';
    await runConsensus({
      command: 'plan',
      repoRoot: root,
      runId: olderRunId,
      now: new Date('2026-05-13T00:00:00.000Z'),
      task: 'older consensus task must stay hidden.',
    });
    await runConsensus({
      command: 'plan',
      repoRoot: root,
      runId: newerRunId,
      now: new Date('2026-05-13T01:00:00.000Z'),
      task: 'latest consensus task must stay hidden.',
    });
    const malformedRunDir = join(root, '.agentic-plugins', 'runs', 'consensus', 'consensus-20260513T020000Z-333333');
    await mkdir(malformedRunDir, { recursive: true });
    await writeFile(join(malformedRunDir, 'manifest.json'), '{not json');

    const report = await runConsensus({
      command: 'status',
      repoRoot: root,
      latest: true,
    });

    strictEqual(report.run_id, newerRunId);
    strictEqual(report.lookup.mode, 'latest');
    strictEqual(report.lookup.selected_at, '2026-05-13T01:00:00.000Z');
    strictEqual(report.lookup.skipped_invalid, 1);
    strictEqual(report.status_guidance.state, 'execute_or_record');
    ok(report.next_steps.includes(`runtime:consensus execute --run-id ${newerRunId} --round 1 --execute`));
    ok(!JSON.stringify(report).includes('latest consensus task'), 'status report must not include task body');
  });

  it('executes a planned round only with --execute and stores raw outputs as artifacts', async () => {
    const root = await seedPlan();
    const homeDir = await mkdtemp(join(tmpdir(), 'runtime-consensus-home-'));
    await seedCompanionCache(homeDir);
    const claudeRaw = 'CLAUDE RAW OUTPUT THAT MUST STAY IN THE ARTIFACT';
    const codexRaw = 'CODEX RAW OUTPUT THAT MUST STAY IN THE ARTIFACT';

    const report = await runConsensus({
      command: 'execute',
      repoRoot: root,
      homeDir,
      runId: RUN_ID,
      execute: true,
      now: new Date('2026-05-13T00:02:00.000Z'),
      runner: fakeConsensusRunner({ claudeRaw, codexRaw }),
    });

    strictEqual(report.command, 'execute');
    strictEqual(report.peer_execution, true);
    strictEqual(report.execution_boundary.execute_flag_required, true);
    strictEqual(report.execution_summary.passed, 2);
    strictEqual(report.execution_summary.failed, 0);
    ok(!JSON.stringify(report).includes(claudeRaw), 'json report must not include raw Claude output');
    ok(!formatText(report).includes(codexRaw), 'text report must not include raw Codex output');

    const claudeResult = report.executions.find((entry) => entry.peer === 'claude');
    const codexResult = report.executions.find((entry) => entry.peer === 'codex');
    strictEqual(claudeResult.status, 'passed');
    strictEqual(codexResult.status, 'passed');
    strictEqual(claudeResult.raw_output.bytes, Buffer.byteLength(claudeRaw));
    ok(claudeResult.raw_output.sha256);
    strictEqual(await readFile(join(root, claudeResult.raw_output.pointer), 'utf8'), claudeRaw);
    strictEqual(await readFile(join(root, codexResult.raw_output.pointer), 'utf8'), codexRaw);

    const manifest = await readJson(join(root, '.agentic-plugins', 'runs', 'consensus', RUN_ID, 'manifest.json'));
    strictEqual(manifest.status, 'executed');
    strictEqual(manifest.rounds[0].status, 'executed');
    strictEqual(manifest.rounds[0].execution_results.length, 2);
    const latest = await readJson(join(root, '.agentic-plugins', 'runs', 'consensus', 'latest.json'));
    strictEqual(latest.run_id, RUN_ID);
    strictEqual(latest.summary.passed, 2);
  });

  it('classifies permission failures from explicit consensus execution without leaking raw text', async () => {
    const root = await seedPlan();
    const homeDir = await mkdtemp(join(tmpdir(), 'runtime-consensus-home-'));
    await seedCompanionCache(homeDir);

    const report = await runConsensus({
      command: 'execute',
      repoRoot: root,
      homeDir,
      runId: RUN_ID,
      execute: true,
      peers: ['claude'],
      runner: fakeConsensusRunner({
        claudeRaw: 'RAW DENIED OUTPUT THAT MUST NOT LEAK',
        claudeFailure: true,
        claudeFailureMessage: 'Operation not permitted by sandbox',
      }),
    });

    strictEqual(report.status, 'operator_action_required');
    strictEqual(report.execution_summary.failed, 1);
    strictEqual(report.execution_summary.failed_non_retryable, 1);
    strictEqual(report.execution_summary.operator_action_required, 1);
    const failure = report.executions[0];
    strictEqual(failure.peer, 'claude');
    strictEqual(failure.status, 'operator_action_required');
    strictEqual(failure.failure_type, 'sandbox_blocked');
    strictEqual(failure.operator_action_required, true);
    strictEqual(failure.retryable, false);
    ok(failure.retry_after.includes('operator'));
    ok(!JSON.stringify(report).includes('RAW DENIED OUTPUT'), 'raw failed peer output must not be in json report');
    ok(!formatText(report).includes('RAW DENIED OUTPUT'), 'raw failed peer output must not be in text report');
    ok(formatText(report).includes('operator-action-required=1'));
    strictEqual(await readFile(join(root, failure.raw_output.pointer), 'utf8'), 'RAW DENIED OUTPUT THAT MUST NOT LEAK');
  });

  it('classifies child-process auth failures as operator action without changing host auth status', async () => {
    const root = await seedPlan();
    const homeDir = await mkdtemp(join(tmpdir(), 'runtime-consensus-home-'));
    await seedCompanionCache(homeDir);

    const report = await runConsensus({
      command: 'execute',
      repoRoot: root,
      homeDir,
      runId: RUN_ID,
      execute: true,
      peers: ['codex'],
      runner: fakeConsensusRunner({
        codexRaw: 'AUTH RAW OUTPUT THAT MUST NOT LEAK',
        codexFailure: true,
        codexFailureKind: 'peer_unauthenticated',
        codexFailureMessage: 'login required in child process',
      }),
    });

    strictEqual(report.executions[0].status, 'operator_action_required');
    strictEqual(report.executions[0].failure_type, 'auth_required');
    strictEqual(report.executions[0].operator_action_required, true);
    strictEqual(report.execution_summary.operator_action_required, 1);
    ok(report.executions[0].retry_after.includes('same execution context'));
    ok(!JSON.stringify(report).includes('AUTH RAW OUTPUT'), 'auth failure raw output must not leak');
  });

  it('records per-peer timeout progress and retry guidance without leaking raw text', async () => {
    const root = await seedPlan();
    const homeDir = await mkdtemp(join(tmpdir(), 'runtime-consensus-home-'));
    await seedCompanionCache(homeDir);

    const report = await runConsensus({
      command: 'execute',
      repoRoot: root,
      homeDir,
      runId: RUN_ID,
      execute: true,
      timeoutMs: 90000,
      now: new Date('2026-05-13T00:02:00.000Z'),
      runner: fakeConsensusRunner({
        claudeTimeout: true,
        codexTimeout: true,
      }),
    });

    strictEqual(report.status, 'failed');
    strictEqual(report.progress_pointer, `.agentic-plugins/runs/consensus/${RUN_ID}/execution-progress.json`);
    strictEqual(report.execution_summary.failed_retryable, 2);
    ok(report.executions.every((entry) => entry.status === 'timed_out'));
    ok(report.executions.every((entry) => entry.failure_type === 'timeout'));
    ok(report.executions.every((entry) => entry.retryable === true));
    ok(report.executions.every((entry) => entry.retry_after.includes('runtime:doctor --deep-peer-smoke')));
    ok(formatText(report).includes('progress:'));
    ok(!JSON.stringify(report).includes('TIMED OUT RAW OUTPUT'), 'timeout report must not include raw text');

    const progress = await readJson(join(root, report.progress_pointer));
    strictEqual(progress.schema_version, 'runtime-consensus-progress-1.0');
    strictEqual(progress.status, 'failed');
    strictEqual(progress.summary.failed_retryable, 2);
    strictEqual(progress.peers.claude.status, 'timed_out');
    strictEqual(progress.peers.claude.failure_type, 'timeout');
    strictEqual(progress.peers.claude.retryable, true);
    strictEqual(progress.peers.claude.raw_output.bytes, 0);
    ok(progress.peers.claude.raw_output.sha256);
    strictEqual(progress.peers.codex.timeout_ms, 90000);
    ok(progress.peers.codex.retry_after.includes('--timeout-ms'));

    const latest = await readJson(join(root, '.agentic-plugins', 'runs', 'consensus', 'latest.json'));
    strictEqual(latest.progress_pointer, report.progress_pointer);
  });

  it('reports status guidance for retryable failed peers from execution artifacts', async () => {
    const root = await seedPlan();
    const homeDir = await mkdtemp(join(tmpdir(), 'runtime-consensus-home-'));
    await seedCompanionCache(homeDir);
    await runConsensus({
      command: 'execute',
      repoRoot: root,
      homeDir,
      runId: RUN_ID,
      execute: true,
      timeoutMs: 90000,
      runner: fakeConsensusRunner({
        claudeTimeout: true,
        codexTimeout: true,
      }),
    });

    const report = await runConsensus({
      command: 'status',
      repoRoot: root,
      runId: RUN_ID,
    });

    strictEqual(report.status_guidance.state, 'retry_failed_peers');
    strictEqual(report.execution_summary.failed_retryable, 2);
    ok(report.progress_pointer.endsWith('/execution-progress.json'));
    ok(report.status_guidance.commands.some((command) => command.includes(`--peers claude`) && command.includes('--timeout-ms 180000')));
    ok(report.status_guidance.commands.some((command) => command.includes(`--peers codex`) && command.includes('--process-budget 1')));
    ok(report.next_steps.some((step) => step.includes('After retryable peers pass')));
    ok(formatText(report).includes('next action: Retry only the retryable failed peers'));
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
    strictEqual(report.execution.available, true);
    strictEqual(report.execution.command, `runtime:consensus execute --run-id ${RUN_ID} --round 2 --execute`);
    const prompt = await readFile(join(root, report.artifacts.find((artifact) => artifact.peer === 'codex').pointer), 'utf8');
    ok(prompt.includes('Confirm whether a follow-up executor should remain out of scope.'));
    ok(prompt.includes('Do not quote or depend on raw peer output'));
  });

  it('reports status guidance for synthesized durable disagreements', async () => {
    const root = await seedPlan();
    const summaryFile = join(root, 'summary.md');
    const disagreementsFile = join(root, 'disagreements.md');
    await writeFile(summaryFile, 'Summary with remaining disagreement.\n');
    await writeFile(disagreementsFile, '- Confirm whether retry automation should remain bounded.\n');
    await runConsensus({
      command: 'synthesize',
      repoRoot: root,
      runId: RUN_ID,
      summaryFile,
      disagreementsFile,
    });

    const report = await runConsensus({
      command: 'status',
      repoRoot: root,
      runId: RUN_ID,
    });

    strictEqual(report.status_guidance.state, 'next_round_available');
    strictEqual(report.next_action, 'Durable disagreements remain; plan the bounded rebuttal round before executing more peers.');
    ok(report.status_guidance.commands.includes(`runtime:consensus next-round --run-id ${RUN_ID}`));
    ok(report.status_guidance.commands.includes(`runtime:consensus execute --run-id ${RUN_ID} --round 2 --execute`));
    ok(formatText(report).includes('next action: Durable disagreements remain'));
  });

  it('explains synthesize and next-round blocked states without executing peers', async () => {
    const root = await seedPlan();

    await rejects(
      () => runConsensus({ command: 'synthesize', repoRoot: root, runId: RUN_ID }),
      /runtime:consensus synthesize --run-id consensus-20260513T000000Z-abcdef --summary-file <summary.md>/,
    );

    await rejects(
      () => runConsensus({ command: 'next-round', repoRoot: root, runId: RUN_ID }),
      /next-round requires consensus.json or --disagreements-file/,
    );

    const summaryFile = join(root, 'summary.md');
    await writeFile(summaryFile, 'No durable disagreement remains.\n');
    await runConsensus({
      command: 'synthesize',
      repoRoot: root,
      runId: RUN_ID,
      summaryFile,
      converged: true,
    });

    await rejects(
      () => runConsensus({ command: 'next-round', repoRoot: root, runId: RUN_ID }),
      /next-round requires at least one durable disagreement/,
    );
  });

  it('parses CLI arguments and rejects unsafe ids or invalid budgets', async () => {
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

    const executeStyle = parseArgs(['execute', '--run-id', RUN_ID, '--execute', '--timeout-ms', '60000']);
    strictEqual(executeStyle.command, 'execute');
    strictEqual(executeStyle.execute, true);
    strictEqual(executeStyle.timeoutMs, 60000);

    const latestStyle = parseArgs(['status', '--latest']);
    strictEqual(latestStyle.command, 'status');
    strictEqual(latestStyle.latest, true);

    throws(() => parseArgs(['record', '--run-id', '../bad']), /Invalid --run-id/);
    throws(() => parseArgs(['record', '--peer', 'bad/peer']), /Peer ids/);
    throws(() => parseArgs(['status', '--latest', '--run-id', RUN_ID]), /Use either --run-id or --latest/);
    throws(() => parseArgs(['execute', '--latest']), /--latest is only supported by status/);
    throws(() => parseArgs(['plan', '--max-rounds', '0']), /positive integer/);
    await rejects(() => runConsensus({ command: 'execute', repoRoot: '/tmp/repo', runId: RUN_ID }), /requires --execute/);
    await rejects(() => runConsensus({ command: 'plan', repoRoot: '/tmp/repo', runId: RUN_ID, task: 'x', maxRounds: 4 }), /--max-rounds must be <= 3/);
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

async function seedCompanionCache(homeDir) {
  await mkdir(join(homeDir, '.claude', 'plugins', 'cache', 'agentic-plugins', 'companions', '0.1.0', '.claude-plugin'), { recursive: true });
  await mkdir(join(homeDir, '.claude', 'plugins', 'cache', 'agentic-plugins', 'companions', '0.1.0', 'scripts'), { recursive: true });
  await writeFile(join(homeDir, '.claude', 'plugins', 'cache', 'agentic-plugins', 'companions', '0.1.0', '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'companions', version: '0.1.0' }));
  await writeFile(join(homeDir, '.claude', 'plugins', 'cache', 'agentic-plugins', 'companions', '0.1.0', 'scripts', 'codex-companion.mjs'), "const CONTRACT_VERSION = '0.1.1'; // --prompt-file\n");

  await mkdir(join(homeDir, '.codex', 'plugins', 'cache', 'agentic-plugins', 'companions', '0.1.0', '.codex-plugin'), { recursive: true });
  await mkdir(join(homeDir, '.codex', 'plugins', 'cache', 'agentic-plugins', 'companions', '0.1.0', 'scripts'), { recursive: true });
  await writeFile(join(homeDir, '.codex', 'plugins', 'cache', 'agentic-plugins', 'companions', '0.1.0', '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'companions', version: '0.1.0' }));
  await writeFile(join(homeDir, '.codex', 'plugins', 'cache', 'agentic-plugins', 'companions', '0.1.0', 'scripts', 'claude-companion.mjs'), "const CONTRACT_VERSION = '0.1.1'; // --prompt-file\n");
}

function fakeConsensusRunner({
  claudeRaw = 'CLAUDE RAW OUTPUT',
  codexRaw = 'CODEX RAW OUTPUT',
  claudeFailure = false,
  codexFailure = false,
  claudeFailureKind = 'peer_invocation_error',
  codexFailureKind = 'peer_invocation_error',
  claudeFailureMessage = 'sandbox permission denied',
  codexFailureMessage = 'sandbox permission denied',
  claudeTimeout = false,
  codexTimeout = false,
} = {}) {
  return async (command, args = []) => {
    const key = [command, ...args].join(' ');
    if (command === 'claude') {
      if (args.join(' ') === '--version') return okResult('2.1.140 (Claude Code)\n');
      if (args.join(' ') === '--help') return okResult('Usage: claude --print --output-format --no-session-persistence --model --effort --permission-mode --plugin-dir\nCommands:\n  auth status\n  plugin list\n');
      if (args.join(' ') === 'auth status') return okResult(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' }));
      if (args.join(' ') === 'plugin list') return okResult('Installed plugins:\n\n  > runtime@agentic-plugins\n    Version: 0.11.0\n    Scope: user\n    Status: enabled\n');
    }
    if (command === 'codex') {
      if (args.join(' ') === '--version') return okResult('codex 1.0.0\n');
      if (args.join(' ') === '--help') return okResult('Usage: codex exec --model -c --config --cd --sandbox --ask-for-approval\nCommands:\n  login status\n  plugin marketplace add upgrade remove\n');
      if (args.join(' ') === 'exec --help') return okResult('Usage: codex exec --model -c --config --cd --sandbox --ask-for-approval\n');
      if (args.join(' ') === 'features list') return okResult('hooks Beta true\nplugin_hooks Beta false\n');
      if (args.join(' ') === 'login status') return okResult('Logged in using ChatGPT\n');
      if (args.join(' ') === 'plugin marketplace --help') return okResult('Usage: codex plugin marketplace add upgrade remove\n');
    }
    if (command === process.execPath) {
      const companionPath = args[0] ?? '';
      if (companionPath.includes('claude-companion.mjs')) {
        if (claudeTimeout) return timeoutResult('TIMED OUT RAW OUTPUT CLAUDE');
        return companionResult({ peer: 'claude', raw: claudeRaw, failed: claudeFailure, failureKind: claudeFailureKind, failureMessage: claudeFailureMessage });
      }
      if (companionPath.includes('codex-companion.mjs')) {
        if (codexTimeout) return timeoutResult('TIMED OUT RAW OUTPUT CODEX');
        return companionResult({ peer: 'codex', raw: codexRaw, failed: codexFailure, failureKind: codexFailureKind, failureMessage: codexFailureMessage });
      }
    }
    throw new Error(`unexpected command: ${key}`);
  };
}

function companionResult({ peer, raw, failed, failureKind, failureMessage }) {
  const envelope = failed
    ? {
        status: 'companion_error',
        peer_host: peer,
        peer_model: null,
        stdout: raw,
        exit_code: 3,
        metadata: { duration_ms: 12, started_at: '2026-05-13T00:02:00.000Z', completed_at: '2026-05-13T00:02:00.012Z' },
        error: { kind: failureKind, message: failureMessage },
      }
    : {
        status: 'success',
        peer_host: peer,
        peer_model: null,
        stdout: raw,
        exit_code: 0,
        metadata: { duration_ms: 12, started_at: '2026-05-13T00:02:00.000Z', completed_at: '2026-05-13T00:02:00.012Z' },
      };
  return {
    ok: !failed,
    exit_code: failed ? 3 : 0,
    stdout: JSON.stringify(envelope),
    stderr: failed ? failureMessage : '',
    error_code: null,
    timed_out: false,
  };
}

function okResult(stdout) {
  return { ok: true, exit_code: 0, stdout, stderr: '', error_code: null, timed_out: false };
}

function timeoutResult(stdout = '') {
  return {
    ok: false,
    exit_code: null,
    stdout,
    stderr: '',
    error_code: 'ETIMEDOUT',
    error_message: 'command timed out',
    timed_out: true,
  };
}
