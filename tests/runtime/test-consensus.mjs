import { describe, it } from 'node:test';
import { deepStrictEqual, ok, rejects, strictEqual, throws } from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
    strictEqual(manifest.policy.quality_policy.objective, 'best-results-over-token-minimization');
    strictEqual(manifest.policy.quality_policy.default_peer_breadth, 'operator-constrained-max-peers');
    deepStrictEqual(manifest.policy.quality_policy.default_companion_peers, ['claude', 'codex']);
    ok(manifest.policy.quality_policy.model_effort_default.includes('does not downshift'));
    ok(manifest.policy.quality_policy.review_depth_default.includes('independent peer fanout'));
    strictEqual(manifest.policy.raw_output_policy, 'artifact-pointer-only');
    strictEqual(manifest.policy.execution_timeout_ms, 120000);
    strictEqual(manifest.policy.max_rounds, 2);
    deepStrictEqual(manifest.policy.round_policy, {
      default_max_rounds: 2,
      configured_max_rounds: 2,
      hard_cap: 3,
      exhaustion_behavior: 'owner-decision-required; do not run another rebuttal round without an explicit new owner decision',
    });
    strictEqual(manifest.policy.limits.max_rounds_cap, 3);
    strictEqual(manifest.policy.limits.max_peers_cap, null);
    ok(manifest.policy.limits.peer_roster_boundary.includes('explicit --peers roster'));
    strictEqual(manifest.peers.lanes[0].peer, 'claude');
    strictEqual(manifest.peers.lanes[0].lane, 'companion_execute');
    strictEqual(manifest.peers.lanes[0].role, 'claude_companion_peer');
    strictEqual(manifest.peers.lanes[0].companion_direction, 'codex_to_claude');
    ok(manifest.peers.lanes[0].command_template.includes('--peers claude --execute'));

    const prompt = await readFile(join(root, manifest.rounds[0].prompts[0].pointer), 'utf8');
    ok(prompt.includes('Check the ADR-0024 runtime consensus MVP scope.'));
    ok(prompt.includes('Lane: companion_execute'));
    ok(prompt.includes('Role: claude_companion_peer'));
    ok(prompt.includes('objective: best-results-over-token-minimization'));
    ok(prompt.includes('model_effort_default: host-native-default-or-runtime-settings'));
    ok(prompt.includes('review_depth_default: independent peer fanout'));
    ok(prompt.includes('default_max_rounds: 2'));
    ok(prompt.includes('max_rounds_hard_cap: 3'));
    ok(prompt.includes('exhausted_rounds_behavior: owner-decision-required'));
    ok(formatText(report).includes(`run: ${RUN_ID}`));
    ok(formatText(report).includes('peer lanes:'));
    ok(formatText(report).includes('role=claude_companion_peer'));
    ok(formatText(report).includes('quality policy:'));
    ok(formatText(report).includes('objective=best-results-over-token-minimization'));
    ok(formatText(report).includes('round policy:'));
    ok(formatText(report).includes('configured-max-rounds=2; default=2; hard-cap=3'));
    ok(formatText(report).includes('exhaustion-behavior=owner-decision-required'));
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
    strictEqual(report.policy.quality_policy.default_peer_breadth, 'all-requested-peers');
    strictEqual(report.policy.quality_policy.user_constraints.max_peers, 'not-constrained-by-default');

    const manifest = await readJson(join(root, '.agentic-plugins', 'runs', 'consensus', RUN_ID, 'manifest.json'));
    strictEqual(manifest.rounds[0].prompts.length, peers.length);
    strictEqual(manifest.peers.active.length, 16);
    strictEqual(manifest.policy.limits.peer_roster_boundary, 'explicit --peers roster; no hard-coded max peer cap');
    ok(manifest.limits.some((limit) => /explicit roster and optional --max-peers/i.test(limit)));
  });

  it('defaults consensus rebuttal policy to 2 rounds with a 3-round hard cap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-consensus-default-round-policy-'));
    const report = await runConsensus({
      command: 'plan',
      repoRoot: root,
      runId: RUN_ID,
      task: 'Verify the default consensus round policy is visible to operators.',
      peers: ['claude', 'codex'],
    });

    strictEqual(report.policy.max_rounds, 2);
    strictEqual(report.policy.round_policy.default_max_rounds, 2);
    strictEqual(report.policy.round_policy.configured_max_rounds, 2);
    strictEqual(report.policy.round_policy.hard_cap, 3);
    ok(report.policy.round_policy.exhaustion_behavior.includes('owner-decision-required'));
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
    strictEqual(manifest.peers.lanes.find((lane) => lane.peer === 'security').role, 'security_manual_subagent_peer');
    strictEqual(manifest.peers.lanes.find((lane) => lane.peer === 'security').peer_execution, false);
    ok(manifest.peers.lanes.find((lane) => lane.peer === 'security').operator_action.includes('local subagent'));
    strictEqual(manifest.rounds[0].prompts.length, 5);
    const securityPrompt = await readFile(join(root, manifest.rounds[0].prompts.find((entry) => entry.peer === 'security').pointer), 'utf8');
    ok(securityPrompt.includes('Lane: manual_subagent_record'));
    ok(securityPrompt.includes('Role: security_manual_subagent_peer'));
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
    strictEqual(status.peer_lanes.find((lane) => lane.peer === 'security').role, 'security_manual_subagent_peer');
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

  it('reports latest-open status by skipping terminal consensus runs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-consensus-latest-open-status-'));
    const openRunId = 'consensus-20260513T000000Z-111111';
    const cancelledRunId = 'consensus-20260513T010000Z-222222';
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

    const latest = await runConsensus({
      command: 'status',
      repoRoot: root,
      latest: true,
    });
    strictEqual(latest.run_id, cancelledRunId);
    strictEqual(latest.lookup.mode, 'latest');
    strictEqual(latest.status_guidance.state, 'cancelled');

    const latestOpen = await runConsensus({
      command: 'status',
      repoRoot: root,
      latestOpen: true,
    });
    strictEqual(latestOpen.run_id, openRunId);
    strictEqual(latestOpen.lookup.mode, 'latest-open');
    strictEqual(latestOpen.lookup.latest_open, true);
    strictEqual(latestOpen.lookup.skipped_terminal, 1);
    strictEqual(latestOpen.status_guidance.state, 'execute_or_record');
    ok(!JSON.stringify(latestOpen).includes('open consensus task'), 'status report must not include task body');
    ok(!JSON.stringify(latestOpen).includes('cancelled consensus task'), 'status report must not include skipped task body');
  });

  // The peer-execution seam must resolve the companion path + model/effort from the
  // FILESYSTEM only. Before the ADR-0024 extraction, consensus reached for `runDoctor`
  // to get two filesystem-derived values and paid ~3.1s of host-CLI probing for them --
  // 14 `claude`/`codex` processes it never read, each of which received the ambient
  // TELEGRAM_BOT_TOKEN. The scrub now lives inside runDoctor itself, at the point of use
  // (ADR-0041 sec.2b/2c); it used to be each caller's job and only settings.mjs did it.
  it('resolves peer context WITHOUT spawning any host CLI, and still hands the companion the raw env', async () => {
    const root = await seedPlan();
    const homeDir = await mkdtemp(join(tmpdir(), 'runtime-consensus-noprobe-home-'));
    await seedCompanionCache(homeDir);

    const ambientEnv = { ...process.env, TELEGRAM_BOT_TOKEN: 'sentinel-token' };
    const calls = [];
    const inner = fakeConsensusRunner();
    const recording = async (command, args = [], options = {}) => {
      calls.push({ command, args, env: options.env });
      return inner(command, args, options);
    };

    const report = await runConsensus({
      command: 'execute',
      repoRoot: root,
      homeDir,
      runId: RUN_ID,
      execute: true,
      env: ambientEnv,
      now: new Date('2026-05-13T00:02:00.000Z'),
      runner: recording,
    });
    strictEqual(report.execution_summary.passed, 2);

    // (1) Zero host-CLI probes. `command === process.execPath` alone would NOT be enough
    // -- `node doctor.mjs` is also an execPath launch -- so pin the exact selected paths.
    const hostCalls = calls.filter((call) => call.command === 'claude' || call.command === 'codex');
    deepStrictEqual(hostCalls, [], `consensus must not spawn host CLIs; got ${hostCalls.map((c) => `${c.command} ${c.args.join(' ')}`).join(', ')}`);

    strictEqual(calls.length, 2, 'exactly the two companion launches, nothing else');
    for (const call of calls) strictEqual(call.command, process.execPath);

    // The selected companion is the one the seam resolved from the SEEDED cache -- an
    // absolute path under the fixture home, not merely a string containing the filename.
    const claudeCompanion = join(homeDir, '.codex', 'plugins', 'cache', 'agentic-plugins', 'companions', '0.1.0', 'scripts', 'claude-companion.mjs');
    const codexCompanion = join(homeDir, '.claude', 'plugins', 'cache', 'agentic-plugins', 'companions', '0.1.0', 'scripts', 'codex-companion.mjs');
    deepStrictEqual(calls.map((call) => call.args[0]), [claudeCompanion, codexCompanion]);

    // The full argv, not just the script: `task` + the prompt-file contract flag.
    for (const call of calls) {
      strictEqual(call.args[1], 'task', 'the companion contract subcommand');
      ok(call.args.includes('--prompt-file'), 'the prompt rides as a file, never as argv text');
      ok(call.args[call.args.indexOf('--prompt-file') + 1].endsWith('.md'), 'the prompt-file value is a path');
    }

    // (2) The companion DELIBERATELY receives the WHOLE ambient env. The token has to
    // reach the peer session so its attention Stop hook can egress (attention sensor.mjs
    // -> notify.mjs reads process.env; ADR-0041 sec.3), and PATH/host config must survive
    // too. Scrubbing here would silently disable cross-machine notifications for peers.
    for (const call of calls) {
      deepStrictEqual(call.env, ambientEnv, 'the companion launch must receive the ambient env unchanged');
    }
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
    const claudePrompt = manifest.rounds[0].prompts.find((entry) => entry.peer === 'claude');
    const codexPrompt = manifest.rounds[0].prompts.find((entry) => entry.peer === 'codex');
    strictEqual(claudeResult.prompt_pointer, claudePrompt.pointer);
    strictEqual(codexResult.prompt_pointer, codexPrompt.pointer);
    ok(report.artifacts.some((artifact) => artifact.kind === 'peer-prompt' && artifact.peer === 'claude' && artifact.pointer === claudePrompt.pointer));
    ok(formatText(report).includes(`prompt=${claudePrompt.pointer}`));
    const executionArtifact = await readJson(join(root, report.execution_pointer));
    strictEqual(executionArtifact.executions.find((entry) => entry.peer === 'claude').prompt_pointer, claudePrompt.pointer);
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
    strictEqual(report.execution_remediation.status, 'retryable_failure');
    strictEqual(report.execution_remediation.failure_types.timeout, 2);
    ok(report.execution_remediation.next_action.includes('Retry only retryable peers'));
    ok(report.execution_remediation.proof_commands.includes('runtime:doctor --deep-peer-smoke --execute-deep-peer-smoke'));
    ok(report.execution_remediation.retry_commands.every((command) => command.includes('--process-budget 1')));
    ok(report.execution_remediation.peer_actions.every((entry) => entry.suggested_timeout_ms === 180000));
    ok(report.executions.every((entry) => entry.status === 'timed_out'));
    ok(report.executions.every((entry) => entry.prompt_pointer?.includes('/prompts/')));
    ok(report.executions.every((entry) => entry.failure_type === 'timeout'));
    ok(report.executions.every((entry) => entry.retryable === true));
    ok(report.executions.every((entry) => entry.retry_after.includes('runtime:doctor --deep-peer-smoke')));
    ok(formatText(report).includes('progress:'));
    ok(formatText(report).includes('remediation: retryable_failure'));
    ok(formatText(report).includes('proof-command: runtime:doctor --deep-peer-smoke --execute-deep-peer-smoke'));
    ok(!JSON.stringify(report).includes('TIMED OUT RAW OUTPUT'), 'timeout report must not include raw text');

    const progress = await readJson(join(root, report.progress_pointer));
    strictEqual(progress.schema_version, 'runtime-consensus-progress-1.0');
    strictEqual(progress.status, 'failed');
    strictEqual(progress.summary.failed_retryable, 2);
    strictEqual(progress.peers.claude.status, 'timed_out');
    strictEqual(progress.peers.claude.prompt_pointer, report.executions.find((entry) => entry.peer === 'claude').prompt_pointer);
    strictEqual(progress.peers.claude.failure_type, 'timeout');
    strictEqual(progress.peers.claude.retryable, true);
    strictEqual(progress.peers.claude.raw_output.bytes, 0);
    ok(progress.peers.claude.raw_output.sha256);
    strictEqual(progress.peers.codex.timeout_ms, 90000);
    ok(progress.peers.codex.retry_after.includes('--timeout-ms'));

    const latest = await readJson(join(root, '.agentic-plugins', 'runs', 'consensus', 'latest.json'));
    strictEqual(latest.progress_pointer, report.progress_pointer);
    strictEqual(latest.remediation.status, 'retryable_failure');
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
    strictEqual(report.execution_remediation.status, 'retryable_failure');
    strictEqual(report.execution_remediation.peer_actions.length, 2);
    ok(report.execution_remediation.retry_commands.some((command) => command.includes(`--peers claude`)));
    ok(report.execution_remediation.artifacts.execution.endsWith('/execution.json'));
    ok(report.execution_remediation.artifacts.progress.endsWith('/execution-progress.json'));
    ok(report.progress_pointer.endsWith('/execution-progress.json'));
    ok(report.status_guidance.commands.some((command) => command.includes(`--peers claude`) && command.includes('--timeout-ms 180000')));
    ok(report.status_guidance.commands.some((command) => command.includes(`--peers codex`) && command.includes('--process-budget 1')));
    ok(report.next_steps.some((step) => step.includes('After retryable peers pass')));
    ok(formatText(report).includes('next action: Retry only the retryable failed peers'));
  });

  it('reports aggregate round-output completeness after staged peer retries', async () => {
    const root = await seedPlan();
    const homeDir = await mkdtemp(join(tmpdir(), 'runtime-consensus-home-'));
    await seedCompanionCache(homeDir);

    await runConsensus({
      command: 'execute',
      repoRoot: root,
      homeDir,
      runId: RUN_ID,
      execute: true,
      peers: ['claude'],
      processBudget: 1,
      runner: fakeConsensusRunner({ claudeRaw: 'CLAUDE STAGED RAW' }),
    });
    await runConsensus({
      command: 'execute',
      repoRoot: root,
      homeDir,
      runId: RUN_ID,
      execute: true,
      peers: ['codex'],
      processBudget: 1,
      runner: fakeConsensusRunner({ codexRaw: 'CODEX STAGED RAW' }),
    });

    const report = await runConsensus({
      command: 'status',
      repoRoot: root,
      runId: RUN_ID,
    });

    strictEqual(report.execution_summary.executed, 1);
    strictEqual(report.execution_summary.passed, 1);
    strictEqual(report.round_output_summary.recorded, 2);
    strictEqual(report.round_output_summary.active_peers, 2);
    strictEqual(report.round_output_summary.complete, true);
    strictEqual(report.round_output_summary.passed_execution, 2);
    strictEqual(report.round_output_summary.failed_execution, 0);
    deepStrictEqual(report.round_output_summary.missing_peers, []);
    strictEqual(report.rounds[0].output_summary.complete, true);
    ok(formatText(report).includes('execution summary: executed=1; passed=1'));
    ok(formatText(report).includes('round outputs: round=1; recorded=2/2; complete=true; passed-execution=2; manual-recorded=0; failed-execution=0; missing=none'));
  });

  it('reports running execution progress instead of suggesting duplicate execution', async () => {
    const root = await seedPlan();
    const progressPointer = `.agentic-plugins/runs/consensus/${RUN_ID}/execution-progress.json`;
    await writeFile(join(root, progressPointer), JSON.stringify({
      schema_version: 'runtime-consensus-progress-1.0',
      runtime_version: '0.0.0-test',
      run_id: RUN_ID,
      status: 'running',
      created_at: '2026-05-13T00:02:00.000Z',
      updated_at: '2026-05-13T00:02:30.000Z',
      round: 1,
      peer_execution: true,
      preflight: {
        status: 'completed',
        completed_at: '2026-05-13T00:02:01.000Z',
      },
      peers: {
        claude: {
          peer: 'claude',
          status: 'running',
          scheduled: true,
          prompt_pointer: `.agentic-plugins/runs/consensus/${RUN_ID}/rounds/round-1/prompts/claude.md`,
        },
        codex: {
          peer: 'codex',
          status: 'pending',
          scheduled: true,
          prompt_pointer: `.agentic-plugins/runs/consensus/${RUN_ID}/rounds/round-1/prompts/codex.md`,
        },
      },
      summary: null,
      progress_pointer: progressPointer,
    }, null, 2));

    const report = await runConsensus({
      command: 'status',
      repoRoot: root,
      runId: RUN_ID,
    });

    strictEqual(report.status_guidance.state, 'execution_running');
    strictEqual(report.next_action, report.status_guidance.next_action);
    ok(report.next_action.includes('claude'));
    ok(report.status_guidance.reason.includes('pending=codex'));
    ok(report.status_guidance.commands.includes(`runtime:consensus status --run-id ${RUN_ID}`));
    ok(!report.status_guidance.next_steps.some((step) => step.includes('execute --run-id')));
    ok(formatText(report).includes('guidance state: execution_running'));
  });

  it('reports stalled running execution progress with guarded timeout remediation', async () => {
    const root = await seedPlan();
    const progressPointer = `.agentic-plugins/runs/consensus/${RUN_ID}/execution-progress.json`;
    await writeFile(join(root, progressPointer), JSON.stringify({
      schema_version: 'runtime-consensus-progress-1.0',
      runtime_version: '0.0.0-test',
      run_id: RUN_ID,
      status: 'running',
      created_at: '2026-05-13T00:02:00.000Z',
      updated_at: '2026-05-13T00:02:00.000Z',
      round: 1,
      peer_execution: true,
      execution_boundary: {
        execute_flag_required: true,
        execute_flag_supplied: true,
        timeout_ms: 90000,
        process_budget: 2,
      },
      preflight: {
        status: 'completed',
        completed_at: '2026-05-13T00:02:01.000Z',
      },
      peers: {
        claude: {
          peer: 'claude',
          status: 'running',
          scheduled: true,
          started_at: '2026-05-13T00:02:00.000Z',
          timeout_ms: 90000,
          prompt_pointer: `.agentic-plugins/runs/consensus/${RUN_ID}/rounds/round-1/prompts/claude.md`,
        },
        codex: {
          peer: 'codex',
          status: 'pending',
          scheduled: true,
          started_at: null,
          timeout_ms: 90000,
          prompt_pointer: `.agentic-plugins/runs/consensus/${RUN_ID}/rounds/round-1/prompts/codex.md`,
        },
      },
      summary: null,
      progress_pointer: progressPointer,
    }, null, 2));

    const report = await runConsensus({
      command: 'status',
      repoRoot: root,
      runId: RUN_ID,
      now: new Date('2026-05-13T00:05:00.000Z'),
    });

    strictEqual(report.status_guidance.state, 'execution_stalled');
    ok(report.next_action.includes('appears stalled for claude'));
    ok(report.status_guidance.reason.includes('stalled=claude'));
    ok(report.status_guidance.reason.includes('elapsed_ms=180000'));
    ok(report.status_guidance.commands.includes('runtime:doctor --deep-peer-smoke --execute-deep-peer-smoke'));
    ok(!report.status_guidance.commands.some((command) => command.includes('execute --run-id')));
    ok(report.status_guidance.next_steps.some((step) => step.includes('After confirming no original execute process is still active')));
    ok(report.status_guidance.next_steps.some((step) => step.includes(`--peers claude`) && step.includes('--timeout-ms 180000')));
    ok(formatText(report).includes('guidance state: execution_stalled'));
  });

  it('records artifact-only cancellation with explicit running-process confirmation', async () => {
    const root = await seedPlan();
    const progressPointer = `.agentic-plugins/runs/consensus/${RUN_ID}/execution-progress.json`;
    const reasonFile = join(root, 'cancel-reason.md');
    await writeFile(reasonFile, 'CANCEL REASON BODY THAT MUST STAY IN THE ARTIFACT\n');
    await writeFile(join(root, progressPointer), JSON.stringify({
      schema_version: 'runtime-consensus-progress-1.0',
      runtime_version: '0.0.0-test',
      run_id: RUN_ID,
      status: 'running',
      created_at: '2026-05-13T00:02:00.000Z',
      updated_at: '2026-05-13T00:02:00.000Z',
      round: 1,
      peer_execution: true,
      execution_boundary: {
        execute_flag_required: true,
        execute_flag_supplied: true,
        timeout_ms: 90000,
        process_budget: 2,
      },
      preflight: {
        status: 'completed',
        completed_at: '2026-05-13T00:02:01.000Z',
      },
      peers: {
        claude: {
          peer: 'claude',
          status: 'running',
          scheduled: true,
          started_at: '2026-05-13T00:02:00.000Z',
          timeout_ms: 90000,
          prompt_pointer: `.agentic-plugins/runs/consensus/${RUN_ID}/rounds/round-1/prompts/claude.md`,
        },
        codex: {
          peer: 'codex',
          status: 'pending',
          scheduled: true,
          started_at: null,
          timeout_ms: 90000,
          prompt_pointer: `.agentic-plugins/runs/consensus/${RUN_ID}/rounds/round-1/prompts/codex.md`,
        },
      },
      summary: null,
      progress_pointer: progressPointer,
    }, null, 2));

    await rejects(
      () => runConsensus({
        command: 'cancel',
        repoRoot: root,
        runId: RUN_ID,
        reasonFile,
      }),
      /confirm no original execute process is still active/,
    );

    const report = await runConsensus({
      command: 'cancel',
      repoRoot: root,
      runId: RUN_ID,
      reasonFile,
      cancelledBy: 'operator',
      confirmNoActiveProcess: true,
      nextAction: 'Start a new consensus run if the issue still needs peer review.',
      now: new Date('2026-05-13T00:06:00.000Z'),
    });

    strictEqual(report.status, 'cancelled');
    strictEqual(report.previous_status, 'planned');
    strictEqual(report.operator_confirmed_no_active_process, true);
    ok(report.cancellation_pointer.endsWith('/cancellation.json'));
    ok(report.reason_pointer.endsWith('/cancellation-reason.md'));
    ok(!JSON.stringify(report).includes('CANCEL REASON BODY'), 'cancel report must not include cancellation reason text');
    ok(!formatText(report).includes('CANCEL REASON BODY'), 'cancel text report must not include cancellation reason text');

    const manifest = await readJson(join(root, '.agentic-plugins', 'runs', 'consensus', RUN_ID, 'manifest.json'));
    strictEqual(manifest.status, 'cancelled');
    strictEqual(manifest.cancellation_pointer, report.cancellation_pointer);
    strictEqual(manifest.rounds[0].status, 'cancelled');
    const cancellation = await readJson(join(root, report.cancellation_pointer));
    strictEqual(cancellation.schema_version, 'runtime-consensus-cancellation-1.0');
    strictEqual(cancellation.reason_pointer, report.reason_pointer);
    strictEqual(cancellation.operator_confirmed_no_active_process, true);
    strictEqual(await readFile(join(root, cancellation.reason_pointer), 'utf8'), 'CANCEL REASON BODY THAT MUST STAY IN THE ARTIFACT\n');
    const progress = await readJson(join(root, progressPointer));
    strictEqual(progress.status, 'cancelled');
    strictEqual(progress.cancellation_pointer, report.cancellation_pointer);
    strictEqual(progress.peers.claude.status, 'cancelled');
    strictEqual(progress.peers.codex.status, 'cancelled');
    strictEqual(progress.summary.executed, 0);
    strictEqual(progress.summary.cancelled, 2);

    const status = await runConsensus({
      command: 'status',
      repoRoot: root,
      runId: RUN_ID,
    });

    strictEqual(status.status, 'cancelled');
    strictEqual(status.status_guidance.state, 'cancelled');
    strictEqual(status.cancellation.reason_pointer, report.reason_pointer);
    strictEqual(status.next_action, 'Start a new consensus run if the issue still needs peer review.');
    ok(formatText(status).includes('guidance state: cancelled'));
    ok(!JSON.stringify(status).includes('CANCEL REASON BODY'), 'status json must not include cancellation reason text');
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
    strictEqual(report.convergence_state, 'contradiction');
    strictEqual(report.durable_disagreements.length, 1);
    strictEqual(report.contradictions.length, 1);
    strictEqual(report.contradictions[0].issue_framing, 'Whether next-round prompts should be generated before owner review.');
    ok(report.evidence_pointers.some((pointer) => pointer.kind === 'peer-output' && pointer.peer === 'claude'));
    ok(!JSON.stringify(report).includes('CLAUDE RAW OUTPUT'));
    ok(!formatText(report).includes('CODEX RAW OUTPUT'));

    const manifest = await readJson(join(root, '.agentic-plugins', 'runs', 'consensus', RUN_ID, 'manifest.json'));
    const result = await readJson(join(root, manifest.consensus_pointer));
    strictEqual(result.schema_version, 'runtime-consensus-result-1.0');
    strictEqual(result.convergence_state, 'contradiction');
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
    ok(prompt.includes('Issue framing:'));
    ok(prompt.includes('Opposing views:'));
    ok(prompt.includes('Requested evidence standard:'));
    ok(prompt.includes('Role: codex_companion_peer'));
    ok(prompt.includes('Do not quote or depend on raw peer output'));
  });

  it('treats complementary disagreement as converged without a rebuttal round', async () => {
    const root = await seedPlan();
    const summaryFile = join(root, 'summary.md');
    const disagreementsFile = join(root, 'disagreements.json');
    await writeFile(summaryFile, 'Both peers agree on the direction but emphasize different risks.\n');
    await writeFile(disagreementsFile, JSON.stringify([
      {
        summary: 'Claude emphasized release safety while Codex emphasized operator UX.',
        kind: 'complementary',
      },
    ]));

    const report = await runConsensus({
      command: 'synthesize',
      repoRoot: root,
      runId: RUN_ID,
      summaryFile,
      disagreementsFile,
      convergenceState: 'complementary',
    });

    strictEqual(report.status, 'converged');
    strictEqual(report.convergence_state, 'complementary');
    strictEqual(report.next_round.available, false);
    strictEqual(report.contradictions.length, 0);

    const status = await runConsensus({
      command: 'status',
      repoRoot: root,
      runId: RUN_ID,
    });

    strictEqual(status.status_guidance.state, 'complete');
    strictEqual(status.status_guidance.reason, 'convergence_state=complementary');
    await rejects(
      () => runConsensus({ command: 'next-round', repoRoot: root, runId: RUN_ID }),
      /observed complementary/,
    );
  });

  it('records owner-decision-required when contradiction remains after bounded rounds', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-consensus-owner-decision-'));
    await runConsensus({
      command: 'plan',
      repoRoot: root,
      runId: RUN_ID,
      task: 'Evaluate a bounded one-round contradiction.',
      peers: ['claude', 'codex'],
      maxRounds: 1,
    });
    const summaryFile = join(root, 'summary.md');
    const disagreementsFile = join(root, 'disagreements.json');
    await writeFile(summaryFile, 'The peers still recommend incompatible actions.\n');
    await writeFile(disagreementsFile, JSON.stringify([
      {
        summary: 'Claude recommends shipping now; Codex recommends blocking on a verifier.',
        kind: 'contradiction',
        opposing_views: [
          'Ship now with manual review.',
          'Block release until a verifier exists.',
        ],
        evidence_standard: 'Choose based on test coverage, release risk, and rollback evidence.',
      },
    ]));

    const report = await runConsensus({
      command: 'synthesize',
      repoRoot: root,
      runId: RUN_ID,
      summaryFile,
      disagreementsFile,
    });

    strictEqual(report.convergence_state, 'owner-decision-required');
    strictEqual(report.status, 'durable-disagreement');
    strictEqual(report.next_round.available, false);
    strictEqual(report.contradictions.length, 1);

    const status = await runConsensus({
      command: 'status',
      repoRoot: root,
      runId: RUN_ID,
    });

    strictEqual(status.status_guidance.state, 'owner_decision_required');
    ok(status.next_action.includes('owner'));
    ok(status.next_steps.some((step) => step.includes('runtime:consensus decide')));
  });

  it('records an owner decision artifact to close an exhausted consensus without leaking decision text', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-consensus-owner-decision-record-'));
    await runConsensus({
      command: 'plan',
      repoRoot: root,
      runId: RUN_ID,
      task: 'Choose between incompatible release gates.',
      peers: ['claude', 'codex'],
      maxRounds: 1,
    });
    const summaryFile = join(root, 'summary.md');
    const disagreementsFile = join(root, 'disagreements.json');
    const decisionFile = join(root, 'owner-decision-source.md');
    await writeFile(summaryFile, 'The peers still recommend incompatible release gates.\n');
    await writeFile(disagreementsFile, JSON.stringify([
      {
        summary: 'Claude recommends shipping with manual review; Codex recommends blocking on verifier coverage.',
        kind: 'contradiction',
      },
    ]));
    await writeFile(decisionFile, 'OWNER DECISION BODY THAT MUST STAY IN THE ARTIFACT\n');
    await runConsensus({
      command: 'synthesize',
      repoRoot: root,
      runId: RUN_ID,
      summaryFile,
      disagreementsFile,
    });

    const report = await runConsensus({
      command: 'decide',
      repoRoot: root,
      runId: RUN_ID,
      decisionFile,
      decidedBy: 'owner',
      nextAction: 'Proceed with the verifier gate.',
      now: new Date('2026-05-13T00:05:00.000Z'),
    });

    strictEqual(report.status, 'owner-decided');
    strictEqual(report.previous_convergence_state, 'owner-decision-required');
    strictEqual(report.decided_by, 'owner');
    strictEqual(report.durable_disagreement_count, 1);
    strictEqual(report.contradiction_count, 1);
    ok(report.owner_decision_pointer.endsWith('/owner-decision.json'));
    ok(report.decision_pointer.endsWith('/owner-decision.md'));
    ok(!JSON.stringify(report).includes('OWNER DECISION BODY'), 'decision text must not be in json report');
    ok(!formatText(report).includes('OWNER DECISION BODY'), 'decision text must not be in text report');

    const manifest = await readJson(join(root, '.agentic-plugins', 'runs', 'consensus', RUN_ID, 'manifest.json'));
    strictEqual(manifest.status, 'owner-decided');
    strictEqual(manifest.owner_decision_pointer, report.owner_decision_pointer);
    const ownerDecision = await readJson(join(root, report.owner_decision_pointer));
    strictEqual(ownerDecision.schema_version, 'runtime-consensus-owner-decision-1.0');
    strictEqual(ownerDecision.previous_consensus_pointer, manifest.consensus_pointer);
    strictEqual(ownerDecision.previous_convergence_state, 'owner-decision-required');
    strictEqual(ownerDecision.next_action, 'Proceed with the verifier gate.');
    strictEqual(await readFile(join(root, ownerDecision.decision_pointer), 'utf8'), 'OWNER DECISION BODY THAT MUST STAY IN THE ARTIFACT\n');

    const status = await runConsensus({
      command: 'status',
      repoRoot: root,
      runId: RUN_ID,
    });

    strictEqual(status.status, 'owner-decided');
    strictEqual(status.status_guidance.state, 'owner_decided');
    strictEqual(status.owner_decision.decision_pointer, report.decision_pointer);
    strictEqual(status.next_action, 'Proceed with the verifier gate.');
    ok(formatText(status).includes('guidance state: owner_decided'));
    ok(!JSON.stringify(status).includes('OWNER DECISION BODY'), 'status json must not include decision text');
  });

  it('records an owner ratification on a converged complementary run', async () => {
    const root = await seedPlan();
    const summaryFile = join(root, 'summary.md');
    const disagreementsFile = join(root, 'disagreements.json');
    const ratificationFile = join(root, 'owner-ratification-source.md');
    await writeFile(summaryFile, 'All lanes converged on KEEP; the synthesis flags one residual owner lever.\n');
    await writeFile(disagreementsFile, JSON.stringify([
      {
        summary: 'Resolution lever (owner\'s call): implement the zero-dep-doable subset now vs wait for a trigger.',
        kind: 'complementary',
      },
    ]));
    await writeFile(ratificationFile, 'OWNER RATIFICATION BODY THAT MUST STAY IN THE ARTIFACT\n');
    await runConsensus({
      command: 'synthesize',
      repoRoot: root,
      runId: RUN_ID,
      summaryFile,
      disagreementsFile,
      convergenceState: 'complementary',
    });

    const report = await runConsensus({
      command: 'ratify',
      repoRoot: root,
      runId: RUN_ID,
      ratificationFile,
      ratifiedBy: 'owner',
      lever: 'fs-mutation surface: wait for a trigger, keep zero-dep',
      nextAction: 'Proceed with KEEP-ZERO-DEP; revisit on trigger T1/T2/T3.',
      now: new Date('2026-05-13T00:06:00.000Z'),
    });

    strictEqual(report.command, 'ratify');
    strictEqual(report.status, 'converged', 'ratify must not change the manifest status');
    strictEqual(report.convergence_state, 'complementary');
    strictEqual(report.ratified_by, 'owner');
    strictEqual(report.lever_summary, 'fs-mutation surface: wait for a trigger, keep zero-dep');
    strictEqual(report.durable_disagreement_count, 1);
    ok(report.ratification_pointer.endsWith('/owner-ratification.json'));
    ok(report.ratification_text_pointer.endsWith('/owner-ratification.md'));
    ok(!JSON.stringify(report).includes('OWNER RATIFICATION BODY'), 'ratification text must not be in json report');
    const reportText = formatText(report);
    ok(!reportText.includes('OWNER RATIFICATION BODY'), 'ratification text must not be in text report');
    ok(reportText.includes('lever: fs-mutation surface: wait for a trigger, keep zero-dep'));

    const manifest = await readJson(join(root, '.agentic-plugins', 'runs', 'consensus', RUN_ID, 'manifest.json'));
    strictEqual(manifest.status, 'converged');
    strictEqual(manifest.ratification_pointer, report.ratification_pointer);
    const ratification = await readJson(join(root, report.ratification_pointer));
    strictEqual(ratification.schema_version, 'runtime-consensus-owner-ratification-1.0');
    strictEqual(ratification.status, 'ratified');
    strictEqual(ratification.consensus_pointer, manifest.consensus_pointer);
    strictEqual(ratification.convergence_state, 'complementary');
    strictEqual(ratification.lever_summary, 'fs-mutation surface: wait for a trigger, keep zero-dep');
    strictEqual(ratification.next_action, 'Proceed with KEEP-ZERO-DEP; revisit on trigger T1/T2/T3.');
    strictEqual(await readFile(join(root, ratification.ratification_pointer), 'utf8'), 'OWNER RATIFICATION BODY THAT MUST STAY IN THE ARTIFACT\n');
    const consensusArtifact = await readJson(join(root, manifest.consensus_pointer));
    strictEqual(consensusArtifact.convergence_state, 'complementary', 'ratify must not rewrite consensus.json');

    const status = await runConsensus({
      command: 'status',
      repoRoot: root,
      runId: RUN_ID,
    });

    strictEqual(status.status, 'converged');
    strictEqual(status.status_guidance.state, 'complete');
    strictEqual(status.status_guidance.reason, 'convergence_state=complementary; owner ratification recorded by owner');
    strictEqual(status.next_action, 'Proceed with KEEP-ZERO-DEP; revisit on trigger T1/T2/T3.');
    strictEqual(status.ratification_pointer, report.ratification_pointer);
    strictEqual(status.ratification.ratification_pointer, report.ratification_text_pointer);
    strictEqual(status.ratification.lever_summary, 'fs-mutation surface: wait for a trigger, keep zero-dep');
    strictEqual(status.owner_ratification_briefing, null, 'ratified run must not print a ratification briefing');
    const statusText = formatText(status);
    ok(statusText.includes('owner ratification:'));
    ok(!statusText.includes('Owner ratification available'));
    ok(!JSON.stringify(status).includes('OWNER RATIFICATION BODY'), 'status json must not include ratification text');
  });

  it('surfaces an owner ratification briefing on an unratified complementary run and omits it for aligned runs', async () => {
    const root = await seedPlan();
    const summaryFile = join(root, 'summary.md');
    const disagreementsFile = join(root, 'disagreements.json');
    await writeFile(summaryFile, 'Converged with a residual owner lever.\n');
    await writeFile(disagreementsFile, JSON.stringify([
      {
        summary: 'Resolution lever (owner\'s call): implement now vs wait for a trigger.',
        kind: 'complementary',
      },
    ]));
    await runConsensus({
      command: 'synthesize',
      repoRoot: root,
      runId: RUN_ID,
      summaryFile,
      disagreementsFile,
      convergenceState: 'complementary',
    });

    const status = await runConsensus({ command: 'status', repoRoot: root, runId: RUN_ID });
    strictEqual(status.status_guidance.state, 'complete');
    ok(status.status_guidance.next_steps.some((step) => step.includes(`runtime:consensus ratify --run-id ${RUN_ID}`)));
    const briefing = status.owner_ratification_briefing;
    ok(briefing, 'unratified complementary run must surface the ratification briefing');
    strictEqual(briefing.state, 'complementary');
    strictEqual(briefing.disagreements.length, 1);
    strictEqual(briefing.ratify_command, `runtime:consensus ratify --run-id ${RUN_ID} --ratification-file <owner-ratification.md> --ratified-by owner`);
    const text = formatText(status);
    ok(text.includes('Owner ratification available (optional):'));
    ok(text.includes(`Ratify: runtime:consensus ratify --run-id ${RUN_ID}`));

    const alignedRoot = await seedPlan();
    const alignedSummary = join(alignedRoot, 'summary.md');
    await writeFile(alignedSummary, 'Full alignment without residual levers.\n');
    await runConsensus({
      command: 'synthesize',
      repoRoot: alignedRoot,
      runId: RUN_ID,
      summaryFile: alignedSummary,
    });
    const alignedStatus = await runConsensus({ command: 'status', repoRoot: alignedRoot, runId: RUN_ID });
    strictEqual(alignedStatus.status_guidance.state, 'complete');
    strictEqual(alignedStatus.owner_ratification_briefing, null, 'aligned run without disagreements must not print a ratification briefing');
    deepStrictEqual(alignedStatus.status_guidance.next_steps, []);
  });

  it('gates ratify to converged runs and keeps decide gated to unresolved runs', async () => {
    const root = await seedPlan();
    const summaryFile = join(root, 'summary.md');
    const disagreementsFile = join(root, 'disagreements.md');
    await writeFile(summaryFile, 'Direct contradiction remains.\n');
    await writeFile(disagreementsFile, '- Claude recommends shipping now; Codex recommends blocking.\n');
    await runConsensus({
      command: 'synthesize',
      repoRoot: root,
      runId: RUN_ID,
      summaryFile,
      disagreementsFile,
    });
    await rejects(
      () => runConsensus({ command: 'ratify', repoRoot: root, runId: RUN_ID, ratification: 'Ratify anyway.' }),
      /ratify requires converged consensus \(aligned\|complementary\); observed convergence_state=contradiction — use runtime:consensus decide/,
    );

    const convergedRoot = await seedPlan();
    const convergedSummary = join(convergedRoot, 'summary.md');
    await writeFile(convergedSummary, 'Aligned outcome.\n');
    await runConsensus({
      command: 'synthesize',
      repoRoot: convergedRoot,
      runId: RUN_ID,
      summaryFile: convergedSummary,
    });
    await rejects(
      () => runConsensus({ command: 'decide', repoRoot: convergedRoot, runId: RUN_ID, decision: 'Decide anyway.' }),
      /decide requires unresolved consensus; observed convergence_state=aligned/,
    );
    const aligned = await runConsensus({
      command: 'ratify',
      repoRoot: convergedRoot,
      runId: RUN_ID,
      ratification: 'Owner ratifies the aligned outcome.',
    });
    strictEqual(aligned.status, 'converged');
    strictEqual(aligned.convergence_state, 'aligned');
    strictEqual(aligned.lever_summary, null);
  });

  it('refuses ratify before synthesize, double ratification, and cancel/ratify cross-interactions', async () => {
    const root = await seedPlan();
    await rejects(
      () => runConsensus({ command: 'ratify', repoRoot: root, runId: RUN_ID, ratification: 'Too early.' }),
      /ratify requires consensus\.json; run runtime:consensus synthesize/,
    );

    const summaryFile = join(root, 'summary.md');
    await writeFile(summaryFile, 'Aligned outcome.\n');
    await runConsensus({ command: 'synthesize', repoRoot: root, runId: RUN_ID, summaryFile });
    await rejects(
      () => runConsensus({ command: 'ratify', repoRoot: root, runId: RUN_ID }),
      /ratify requires --ratification <text> or --ratification-file <path>/,
    );
    await rejects(
      () => runConsensus({
        command: 'ratify',
        repoRoot: root,
        runId: RUN_ID,
        ratification: 'Inline.',
        ratificationFile: summaryFile,
      }),
      /Use either --ratification or --ratification-file, not both/,
    );
    await runConsensus({ command: 'ratify', repoRoot: root, runId: RUN_ID, ratification: 'Owner ratifies.' });
    await rejects(
      () => runConsensus({ command: 'ratify', repoRoot: root, runId: RUN_ID, ratification: 'Ratify twice.' }),
      /ratify refused: consensus run already has ratification artifact/,
    );
    await rejects(
      () => runConsensus({ command: 'cancel', repoRoot: root, runId: RUN_ID, reason: 'Cancel after ratification.' }),
      /cancel refused: consensus run already has an owner ratification; preserve the ratification artifact instead/,
    );

    const cancelledRoot = await seedPlan();
    const cancelledSummary = join(cancelledRoot, 'summary.md');
    await writeFile(cancelledSummary, 'Aligned outcome.\n');
    await runConsensus({ command: 'synthesize', repoRoot: cancelledRoot, runId: RUN_ID, summaryFile: cancelledSummary });
    await runConsensus({ command: 'cancel', repoRoot: cancelledRoot, runId: RUN_ID, reason: 'Stopping this run.' });
    await rejects(
      () => runConsensus({ command: 'ratify', repoRoot: cancelledRoot, runId: RUN_ID, ratification: 'Ratify after cancel.' }),
      /ratify refused: consensus run already has cancellation artifact/,
    );
  });

  it('gates record/synthesize/next-round/execute/decide behind terminal artifacts', async () => {
    const root = await seedPlan();
    const summaryFile = join(root, 'summary.md');
    const disagreementsFile = join(root, 'disagreements.json');
    const peerFile = join(root, 'claude.txt');
    await writeFile(summaryFile, 'Converged with a residual owner lever.\n');
    await writeFile(disagreementsFile, JSON.stringify([
      { summary: 'Resolution lever (owner\'s call): implement now vs wait.', kind: 'complementary' },
    ]));
    await writeFile(peerFile, 'LATE PEER OUTPUT\n');
    await runConsensus({
      command: 'synthesize',
      repoRoot: root,
      runId: RUN_ID,
      summaryFile,
      disagreementsFile,
      convergenceState: 'complementary',
    });
    await runConsensus({ command: 'ratify', repoRoot: root, runId: RUN_ID, ratification: 'Owner ratifies; lever resolved as wait.' });

    // Post-ratification mutators must refuse: a later record/synthesize could
    // move the manifest off converged or rewrite consensus.json under the
    // recorded ratification (Codex review MAJORs).
    await rejects(
      () => runConsensus({ command: 'record', repoRoot: root, runId: RUN_ID, peer: 'claude', inputFile: peerFile }),
      /record refused: consensus run already has ratification artifact/,
    );
    await rejects(
      () => runConsensus({ command: 'synthesize', repoRoot: root, runId: RUN_ID, summaryFile }),
      /synthesize refused: consensus run already has ratification artifact/,
    );
    await rejects(
      () => runConsensus({ command: 'next-round', repoRoot: root, runId: RUN_ID, disagreementsFile }),
      /next-round refused: consensus run already has ratification artifact/,
    );
    await rejects(
      () => runConsensus({ command: 'execute', repoRoot: root, runId: RUN_ID, execute: true }),
      /execute refused: consensus run already has ratification artifact/,
    );
    await rejects(
      () => runConsensus({ command: 'decide', repoRoot: root, runId: RUN_ID, decision: 'Decide over ratification.' }),
      /decide refused: consensus run already has ratification artifact/,
    );
    const manifest = await readJson(join(root, '.agentic-plugins', 'runs', 'consensus', RUN_ID, 'manifest.json'));
    strictEqual(manifest.status, 'converged', 'refused mutators must not move the manifest off converged');

    // Owner-decided runs get the same mutator protection.
    const decidedRoot = await seedPlan();
    const decidedSummary = join(decidedRoot, 'summary.md');
    const decidedDisagreements = join(decidedRoot, 'disagreements.json');
    await writeFile(decidedSummary, 'Contradiction remains.\n');
    await writeFile(decidedDisagreements, JSON.stringify([
      { summary: 'Ship now vs block on coverage.', kind: 'contradiction' },
    ]));
    await runConsensus({ command: 'synthesize', repoRoot: decidedRoot, runId: RUN_ID, summaryFile: decidedSummary, disagreementsFile: decidedDisagreements, convergenceState: 'non-consensus' });
    await runConsensus({ command: 'decide', repoRoot: decidedRoot, runId: RUN_ID, decision: 'Owner picks blocking on coverage.' });
    await rejects(
      () => runConsensus({ command: 'synthesize', repoRoot: decidedRoot, runId: RUN_ID, summaryFile: decidedSummary }),
      /synthesize refused: consensus run already has owner-decision artifact/,
    );
    await rejects(
      () => runConsensus({ command: 'record', repoRoot: decidedRoot, runId: RUN_ID, peer: 'claude', inputFile: peerFile }),
      /record refused: consensus run already has owner-decision artifact/,
    );
    await rejects(
      () => runConsensus({ command: 'decide', repoRoot: decidedRoot, runId: RUN_ID, decision: 'Decide twice.' }),
      /decide refused: consensus run already has owner-decision artifact/,
    );
    // Cancel is pointer-gated, not status-gated: a status-drifted manifest
    // that still carries the owner-decision pointer must refuse cancellation.
    const decidedManifestPath = join(decidedRoot, '.agentic-plugins', 'runs', 'consensus', RUN_ID, 'manifest.json');
    const decidedManifest = await readJson(decidedManifestPath);
    decidedManifest.status = 'recorded';
    await writeFile(decidedManifestPath, JSON.stringify(decidedManifest, null, 2));
    await rejects(
      () => runConsensus({ command: 'cancel', repoRoot: decidedRoot, runId: RUN_ID, reason: 'Cancel a drifted owner-decided run.' }),
      /cancel refused: consensus run already has an owner decision/,
    );

    // Cancelled runs get the same mutator protection.
    const cancelledRoot = await seedPlan();
    await runConsensus({ command: 'cancel', repoRoot: cancelledRoot, runId: RUN_ID, reason: 'Abandoned.' });
    await rejects(
      () => runConsensus({ command: 'record', repoRoot: cancelledRoot, runId: RUN_ID, peer: 'claude', inputFile: peerFile }),
      /record refused: consensus run already has cancellation artifact/,
    );
    await rejects(
      () => runConsensus({ command: 'synthesize', repoRoot: cancelledRoot, runId: RUN_ID, summaryFile }),
      /synthesize refused: consensus run already has cancellation artifact/,
    );
    await rejects(
      () => runConsensus({ command: 'decide', repoRoot: cancelledRoot, runId: RUN_ID, decision: 'Decide after cancel.' }),
      /decide refused: consensus run already has cancellation artifact/,
    );
  });

  it('suppresses ratify guidance when the ratification pointer exists but the artifact is unreadable', async () => {
    const root = await seedPlan();
    const summaryFile = join(root, 'summary.md');
    const disagreementsFile = join(root, 'disagreements.json');
    await writeFile(summaryFile, 'Converged with a residual owner lever.\n');
    await writeFile(disagreementsFile, JSON.stringify([
      { summary: 'Resolution lever (owner\'s call): implement now vs wait.', kind: 'complementary' },
    ]));
    await runConsensus({
      command: 'synthesize',
      repoRoot: root,
      runId: RUN_ID,
      summaryFile,
      disagreementsFile,
      convergenceState: 'complementary',
    });
    const ratifyReport = await runConsensus({ command: 'ratify', repoRoot: root, runId: RUN_ID, ratification: 'Owner ratifies.' });
    await rm(join(root, ratifyReport.ratification_pointer));

    const status = await runConsensus({ command: 'status', repoRoot: root, runId: RUN_ID });
    strictEqual(status.ratification, null, 'unreadable ratification artifact must not fabricate a ratification block');
    strictEqual(status.ratification_pointer, ratifyReport.ratification_pointer, 'manifest pointer stays visible for repair');
    strictEqual(status.owner_ratification_briefing, null, 'briefing must not re-offer ratify when the pointer already exists');
    deepStrictEqual(status.status_guidance.next_steps, [], 'next_steps must not re-offer the refused ratify command');
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
    strictEqual(report.next_action, 'Direct contradictions remain; plan the bounded rebuttal round before executing more peers.');
    ok(report.status_guidance.commands.includes(`runtime:consensus next-round --run-id ${RUN_ID}`));
    ok(report.status_guidance.commands.includes(`runtime:consensus execute --run-id ${RUN_ID} --round 2 --execute`));
    ok(formatText(report).includes('next action: Direct contradictions remain'));
  });

  it('includes an owner_decision_briefing in status json for an owner-decision-required run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-consensus-briefing-json-'));
    await runConsensus({
      command: 'plan',
      repoRoot: root,
      runId: RUN_ID,
      task: 'Bounded one-round contradiction for owner briefing.',
      peers: ['claude', 'codex'],
      maxRounds: 1,
    });
    const summaryFile = join(root, 'summary.md');
    const disagreementsFile = join(root, 'disagreements.json');
    await writeFile(summaryFile, 'The peers still recommend incompatible actions.\n');
    await writeFile(disagreementsFile, JSON.stringify([
      {
        summary: 'Claude recommends shipping now; Codex recommends blocking on a verifier.',
        kind: 'contradiction',
        evidence_pointers: ['ptr/claude-position.md', 'ptr/codex-position.md'],
      },
    ]));
    const synth = await runConsensus({
      command: 'synthesize',
      repoRoot: root,
      runId: RUN_ID,
      summaryFile,
      disagreementsFile,
    });
    strictEqual(synth.convergence_state, 'owner-decision-required');

    const status = await runConsensus({
      command: 'status',
      repoRoot: root,
      runId: RUN_ID,
    });

    const briefing = status.owner_decision_briefing;
    ok(briefing, 'status should include owner_decision_briefing');
    strictEqual(briefing.state, 'owner-decision-required');
    strictEqual(briefing.disagreements.length, 1);
    strictEqual(briefing.disagreements[0].type, 'contradiction');
    strictEqual(briefing.disagreements[0].summary, 'Claude recommends shipping now; Codex recommends blocking on a verifier.');
    deepStrictEqual(briefing.disagreements[0].evidence_pointers, ['ptr/claude-position.md', 'ptr/codex-position.md']);
    strictEqual(briefing.decide_command, `runtime:consensus decide --run-id ${RUN_ID} --decision-file <owner-decision.md> --decided-by owner`);
    deepStrictEqual(briefing.template_hint, ['Context', 'Open Question', 'Considered Options', 'Decision', 'Rationale', 'Rollback']);
    ok(briefing.note.includes('raw peer output stays in artifacts'));
  });

  it('omits owner_decision_briefing for a converged (aligned) consensus run', async () => {
    const root = await seedPlan();
    const summaryFile = join(root, 'summary.md');
    await writeFile(summaryFile, 'Both peers converged on the same recommendation.\n');
    const synth = await runConsensus({
      command: 'synthesize',
      repoRoot: root,
      runId: RUN_ID,
      summaryFile,
    });
    strictEqual(synth.convergence_state, 'aligned');

    const status = await runConsensus({
      command: 'status',
      repoRoot: root,
      runId: RUN_ID,
    });

    strictEqual(status.owner_decision_briefing, null);
    ok(!formatText(status).includes('Owner decision required:'));
  });

  it('omits owner_decision_briefing for a converged (complementary) consensus run', async () => {
    const root = await seedPlan();
    const summaryFile = join(root, 'summary.md');
    const disagreementsFile = join(root, 'disagreements.json');
    await writeFile(summaryFile, 'Both peers agree on the direction but emphasize different risks.\n');
    await writeFile(disagreementsFile, JSON.stringify([
      {
        summary: 'Claude emphasized release safety while Codex emphasized operator UX.',
        kind: 'complementary',
      },
    ]));
    const synth = await runConsensus({
      command: 'synthesize',
      repoRoot: root,
      runId: RUN_ID,
      summaryFile,
      disagreementsFile,
      convergenceState: 'complementary',
    });
    strictEqual(synth.convergence_state, 'complementary');

    const status = await runConsensus({
      command: 'status',
      repoRoot: root,
      runId: RUN_ID,
    });

    strictEqual(status.status_guidance.state, 'complete');
    strictEqual(status.owner_decision_briefing, null);
    ok(!formatText(status).includes('Owner decision required:'));
  });

  it('omits owner_decision_briefing after a terminal owner decision despite persisted owner-decision-required state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-consensus-briefing-decided-'));
    await runConsensus({
      command: 'plan',
      repoRoot: root,
      runId: RUN_ID,
      task: 'Bounded one-round contradiction closed by an owner decision.',
      peers: ['claude', 'codex'],
      maxRounds: 1,
    });
    const summaryFile = join(root, 'summary.md');
    const disagreementsFile = join(root, 'disagreements.json');
    await writeFile(summaryFile, 'The peers still recommend incompatible actions.\n');
    await writeFile(disagreementsFile, JSON.stringify([
      {
        summary: 'Claude recommends shipping now; Codex recommends blocking on a verifier.',
        kind: 'contradiction',
      },
    ]));
    const synth = await runConsensus({
      command: 'synthesize',
      repoRoot: root,
      runId: RUN_ID,
      summaryFile,
      disagreementsFile,
    });
    strictEqual(synth.convergence_state, 'owner-decision-required');

    const decisionFile = join(root, 'owner-decision.md');
    await writeFile(decisionFile, 'OWNER DECISION BODY THAT MUST STAY IN THE ARTIFACT\n');
    await runConsensus({
      command: 'decide',
      repoRoot: root,
      runId: RUN_ID,
      decisionFile,
      decidedBy: 'owner',
      nextAction: 'Proceed with the verifier gate.',
      now: new Date('2026-05-13T00:05:00.000Z'),
    });

    const consensus = await readJson(join(root, '.agentic-plugins', 'runs', 'consensus', RUN_ID, 'consensus.json'));
    strictEqual(consensus.convergence_state, 'owner-decision-required');

    const status = await runConsensus({
      command: 'status',
      repoRoot: root,
      runId: RUN_ID,
    });

    strictEqual(status.status_guidance.state, 'owner_decided');
    strictEqual(status.owner_decision_briefing, null);
    ok(!formatText(status).includes('Owner decision required:'));
  });

  it('omits owner_decision_briefing after artifact-only cancellation despite persisted owner-decision-required state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-consensus-briefing-cancelled-'));
    await runConsensus({
      command: 'plan',
      repoRoot: root,
      runId: RUN_ID,
      task: 'Bounded one-round contradiction cancelled as an artifact.',
      peers: ['claude', 'codex'],
      maxRounds: 1,
    });
    const summaryFile = join(root, 'summary.md');
    const disagreementsFile = join(root, 'disagreements.json');
    await writeFile(summaryFile, 'The peers still recommend incompatible actions.\n');
    await writeFile(disagreementsFile, JSON.stringify([
      {
        summary: 'Claude recommends shipping now; Codex recommends blocking on a verifier.',
        kind: 'contradiction',
      },
    ]));
    const synth = await runConsensus({
      command: 'synthesize',
      repoRoot: root,
      runId: RUN_ID,
      summaryFile,
      disagreementsFile,
    });
    strictEqual(synth.convergence_state, 'owner-decision-required');

    const reasonFile = join(root, 'cancel-reason.md');
    await writeFile(reasonFile, 'CANCEL REASON BODY THAT MUST STAY IN THE ARTIFACT\n');
    await runConsensus({
      command: 'cancel',
      repoRoot: root,
      runId: RUN_ID,
      reasonFile,
      cancelledBy: 'operator',
      confirmNoActiveProcess: true,
      now: new Date('2026-05-13T00:06:00.000Z'),
    });

    const consensus = await readJson(join(root, '.agentic-plugins', 'runs', 'consensus', RUN_ID, 'consensus.json'));
    strictEqual(consensus.convergence_state, 'owner-decision-required');

    const status = await runConsensus({
      command: 'status',
      repoRoot: root,
      runId: RUN_ID,
    });

    strictEqual(status.status_guidance.state, 'cancelled');
    strictEqual(status.owner_decision_briefing, null);
    ok(!formatText(status).includes('Owner decision required:'));
  });

  it('renders the owner decision briefing section in status text output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-consensus-briefing-text-'));
    await runConsensus({
      command: 'plan',
      repoRoot: root,
      runId: RUN_ID,
      task: 'Bounded one-round contradiction for owner briefing text.',
      peers: ['claude', 'codex'],
      maxRounds: 1,
    });
    const summaryFile = join(root, 'summary.md');
    const disagreementsFile = join(root, 'disagreements.json');
    await writeFile(summaryFile, 'The peers still recommend incompatible actions.\n');
    await writeFile(disagreementsFile, JSON.stringify([
      {
        summary: 'Claude recommends shipping now; Codex recommends blocking on a verifier.',
        kind: 'contradiction',
        evidence_pointers: ['ptr/claude-position.md'],
      },
    ]));
    await runConsensus({
      command: 'synthesize',
      repoRoot: root,
      runId: RUN_ID,
      summaryFile,
      disagreementsFile,
    });

    const status = await runConsensus({
      command: 'status',
      repoRoot: root,
      runId: RUN_ID,
    });
    const text = formatText(status);
    ok(text.includes('Owner decision required:'));
    ok(text.includes('- [contradiction] Claude recommends shipping now; Codex recommends blocking on a verifier.'));
    ok(text.includes('evidence: ptr/claude-position.md'));
    ok(text.includes(`Decide: runtime:consensus decide --run-id ${RUN_ID} --decision-file <owner-decision.md> --decided-by owner`));
    ok(text.includes('Template sections: Context, Open Question, Considered Options, Decision, Rationale, Rollback'));
  });

  it('derives the owner decision briefing from synthesized summaries without leaking raw peer output', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-consensus-briefing-no-raw-'));
    await runConsensus({
      command: 'plan',
      repoRoot: root,
      runId: RUN_ID,
      task: 'Bounded one-round contradiction guarding raw output.',
      peers: ['claude', 'codex'],
      maxRounds: 1,
    });
    const claudeRaw = join(root, 'claude.txt');
    const codexRaw = join(root, 'codex.txt');
    await writeFile(claudeRaw, 'CLAUDE RAW OUTPUT THAT MUST STAY IN ARTIFACTS');
    await writeFile(codexRaw, 'CODEX RAW OUTPUT THAT MUST STAY IN ARTIFACTS');
    await runConsensus({ command: 'record', repoRoot: root, runId: RUN_ID, peer: 'claude', inputFile: claudeRaw });
    await runConsensus({ command: 'record', repoRoot: root, runId: RUN_ID, peer: 'codex', inputFile: codexRaw });

    const summaryFile = join(root, 'summary.md');
    const disagreementsFile = join(root, 'disagreements.json');
    await writeFile(summaryFile, 'Operator-synthesized summary of the contradiction.\n');
    await writeFile(disagreementsFile, JSON.stringify([
      {
        summary: 'Synthesized disagreement: ship-now versus block-on-verifier.',
        kind: 'contradiction',
      },
    ]));
    await runConsensus({
      command: 'synthesize',
      repoRoot: root,
      runId: RUN_ID,
      summaryFile,
      disagreementsFile,
    });

    const status = await runConsensus({
      command: 'status',
      repoRoot: root,
      runId: RUN_ID,
    });

    const briefing = status.owner_decision_briefing;
    ok(briefing, 'status should include owner_decision_briefing');
    strictEqual(briefing.disagreements[0].summary, 'Synthesized disagreement: ship-now versus block-on-verifier.');
    ok(!JSON.stringify(status).includes('CLAUDE RAW OUTPUT'), 'briefing json must not include raw peer output');
    ok(!JSON.stringify(status).includes('CODEX RAW OUTPUT'), 'briefing json must not include raw peer output');
    ok(!formatText(status).includes('CLAUDE RAW OUTPUT'), 'briefing text must not include raw peer output');
    ok(!formatText(status).includes('CODEX RAW OUTPUT'), 'briefing text must not include raw peer output');
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
    const convergedReport = await runConsensus({
      command: 'synthesize',
      repoRoot: root,
      runId: RUN_ID,
      summaryFile,
      converged: true,
    });
    strictEqual(convergedReport.convergence_state, 'aligned');
    strictEqual(convergedReport.next_round.available, false);

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
      '--convergence-state',
      'contradiction',
    ]);
    strictEqual(opts.command, 'plan');
    strictEqual(opts.format, 'json');
    deepStrictEqual(opts.peers, ['claude', 'codex']);
    strictEqual(opts.maxRounds, 2);
    strictEqual(opts.tokenBudget, 1000);
    strictEqual(opts.convergenceState, 'contradiction');

    const commandStyle = parseArgs(['--repo-root', '/tmp/repo', 'record', '--run-id', RUN_ID, '--peer', 'claude', '--input-file', 'out.txt']);
    strictEqual(commandStyle.command, 'record');
    strictEqual(commandStyle.repoRoot, '/tmp/repo');
    strictEqual(commandStyle.peer, 'claude');

    const executeStyle = parseArgs(['execute', '--run-id', RUN_ID, '--execute', '--timeout-ms', '60000']);
    strictEqual(executeStyle.command, 'execute');
    strictEqual(executeStyle.execute, true);
    strictEqual(executeStyle.timeoutMs, 60000);

    const decideStyle = parseArgs(['decide', '--run-id', RUN_ID, '--decision-file', 'owner.md', '--decided-by', 'owner']);
    strictEqual(decideStyle.command, 'decide');
    strictEqual(decideStyle.decisionFile, 'owner.md');
    strictEqual(decideStyle.decidedBy, 'owner');

    const ratifyStyle = parseArgs(['ratify', '--run-id', RUN_ID, '--ratification-file', 'owner-ratification.md', '--ratified-by', 'owner', '--lever', 'fs-scoping: wait for trigger']);
    strictEqual(ratifyStyle.command, 'ratify');
    strictEqual(ratifyStyle.ratificationFile, 'owner-ratification.md');
    strictEqual(ratifyStyle.ratifiedBy, 'owner');
    strictEqual(ratifyStyle.lever, 'fs-scoping: wait for trigger');

    const cancelStyle = parseArgs(['cancel', '--run-id', RUN_ID, '--reason-file', 'reason.md', '--cancelled-by', 'operator', '--confirm-no-active-process']);
    strictEqual(cancelStyle.command, 'cancel');
    strictEqual(cancelStyle.reasonFile, 'reason.md');
    strictEqual(cancelStyle.cancelledBy, 'operator');
    strictEqual(cancelStyle.confirmNoActiveProcess, true);

    const latestStyle = parseArgs(['status', '--latest']);
    strictEqual(latestStyle.command, 'status');
    strictEqual(latestStyle.latest, true);

    const latestOpenStyle = parseArgs(['status', '--latest-open']);
    strictEqual(latestOpenStyle.command, 'status');
    strictEqual(latestOpenStyle.latestOpen, true);

    throws(() => parseArgs(['record', '--run-id', '../bad']), /Invalid --run-id/);
    throws(() => parseArgs(['record', '--peer', 'bad/peer']), /Peer ids/);
    throws(() => parseArgs(['status', '--latest', '--run-id', RUN_ID]), /Use either --run-id or --latest/);
    throws(() => parseArgs(['status', '--latest', '--latest-open']), /Use either --latest or --latest-open/);
    throws(() => parseArgs(['execute', '--latest']), /--latest is only supported by status/);
    throws(() => parseArgs(['execute', '--latest-open']), /--latest-open is only supported by status/);
    throws(() => parseArgs(['plan', '--max-rounds', '0']), /positive integer/);
    throws(() => parseArgs(['synthesize', '--convergence-state', 'mixed']), /aligned, complementary, contradiction/);
    throws(() => parseArgs(['decide', '--decided-by', 'two\nlines']), /--decided-by must be a single-line value/);
    throws(() => parseArgs(['ratify', '--ratified-by', 'two\nlines']), /--ratified-by must be a single-line value/);
    throws(() => parseArgs(['ratify', '--lever', 'two\nlines']), /--lever must be a single-line value/);
    throws(() => parseArgs(['cancel', '--cancelled-by', 'two\nlines']), /--cancelled-by must be a single-line value/);
    ok(formatText({ help: true }).includes('default to 2 total rounds'));
    ok(formatText({ help: true }).includes('hard-capped at 3'));
    ok(formatText({ help: true }).includes('status --latest-open'));
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
    // No `claude` / `codex` branches on purpose. Consensus resolves its peer context from
    // the filesystem (lib/peer-execution-context.mjs) and spawns only the companion, so
    // any host-CLI call here is a regression -- it falls through to the throw below.
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
