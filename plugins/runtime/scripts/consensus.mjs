#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCommand, runDoctor } from './doctor.mjs';
import { RUNTIME_VERSION } from './version.mjs';

const VERSION = RUNTIME_VERSION;
const MANIFEST_SCHEMA = 'runtime-consensus-run-1.0';
const RESULT_SCHEMA = 'runtime-consensus-result-1.0';
const EXECUTION_SCHEMA = 'runtime-consensus-execution-1.0';
const LATEST_EXECUTION_SCHEMA = 'runtime-consensus-execution-latest-1.0';
const PROGRESS_SCHEMA = 'runtime-consensus-progress-1.0';
const VALID_COMMANDS = new Set(['plan', 'record', 'synthesize', 'next-round', 'execute', 'status']);
const DEFAULT_PEERS = ['claude', 'codex'];
const DEFAULT_MAX_ROUNDS = 2;
const MAX_ROUNDS_CAP = 3;
const DEFAULT_EXECUTION_TIMEOUT_MS = 120000;
const MAX_EXECUTION_TIMEOUT_MS = 600000;
const RUN_ID_RE = /^consensus-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const PEER_ID_RE = /^[A-Za-z0-9._-]+$/;
const PEER_DIRECTIONS = {
  codex: 'claude_to_codex',
  claude: 'codex_to_claude',
};
const COMPANION_PEERS = Object.freeze(Object.keys(PEER_DIRECTIONS));

export async function runConsensus(options = {}) {
  const command = options.command ?? 'plan';
  if (!VALID_COMMANDS.has(command)) {
    throw new Error(`Unsupported consensus command: ${command}`);
  }

  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  if (command === 'plan') {
    return createPlan({ ...options, repoRoot });
  }
  if (command === 'record') {
    return recordOutput({ ...options, repoRoot });
  }
  if (command === 'synthesize') {
    return synthesizeConsensus({ ...options, repoRoot });
  }
  if (command === 'next-round') {
    return planNextRound({ ...options, repoRoot });
  }
  if (command === 'execute') {
    return executeRound({ ...options, repoRoot });
  }
  return readStatus({ ...options, repoRoot });
}

export async function createPlan(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const now = options.now ?? new Date();
  const createdAt = toIso(now);
  const task = await resolveTask(options);
  const peers = normalizePeers(options.peers ?? DEFAULT_PEERS);
  const maxPeers = options.maxPeers === undefined
    ? peers.length
    : positiveInt(options.maxPeers, '--max-peers');
  const activePeers = peers.slice(0, maxPeers);
  const skippedPeers = peers.slice(maxPeers);
  const executablePeers = activePeers.filter(isCompanionPeer);
  const manualPeers = activePeers.filter((peer) => !isCompanionPeer(peer));
  const maxRounds = boundedPositiveInt(options.maxRounds ?? DEFAULT_MAX_ROUNDS, '--max-rounds', MAX_ROUNDS_CAP);
  const processBudgetCap = Math.max(1, executablePeers.length);
  const processBudget = boundedPositiveInt(options.processBudget ?? processBudgetCap, '--process-budget', processBudgetCap);
  const executionTimeoutMs = boundedPositiveInt(options.timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS, '--timeout-ms', MAX_EXECUTION_TIMEOUT_MS);
  const policy = {
    max_rounds: maxRounds,
    max_peers: maxPeers,
    token_budget: optionalPositiveInt(options.tokenBudget, '--token-budget'),
    time_budget_ms: optionalPositiveInt(options.timeBudgetMs, '--time-budget-ms'),
    process_budget: processBudget,
    execution_timeout_ms: executionTimeoutMs,
    peer_selection: 'explicit-companion-peers-plus-manual-peer-labels',
    companion_execution_peers: executablePeers,
    manual_peer_labels: manualPeers,
    raw_output_policy: 'artifact-pointer-only',
    main_session_output: 'synthesized-summary-disagreements-evidence-pointers-only',
    limits: {
      max_rounds_cap: MAX_ROUNDS_CAP,
      max_peers_cap: null,
      peer_roster_boundary: 'explicit --peers roster; no hard-coded max peer cap',
      max_execution_timeout_ms: MAX_EXECUTION_TIMEOUT_MS,
      cancellation: 'per-peer timeout sends SIGTERM through the command runner; no async cancellation subcommand is added in this PR',
    },
  };

  const runId = options.runId ? validateRunId(options.runId) : makeRunId(now);
  const peerLanes = buildPeerLanes({ runId, activePeers });
  const runDir = consensusRunDir(repoRoot, runId);
  await assertInside(consensusRoot(repoRoot), runDir);
  await mkdir(runDir, { recursive: true });

  const taskPath = resolve(runDir, 'task.md');
  await writeFile(taskPath, `${task.trim()}\n`);

  const round = {
    round: 1,
    kind: 'independent-fanout',
    status: 'planned',
    prompts: [],
    raw_outputs: [],
    created_at: createdAt,
  };
  for (const peer of activePeers) {
    const lane = peerLanes.find((entry) => entry.peer === peer);
    const promptPath = resolve(runDir, 'rounds', 'round-1', 'prompts', `${peer}.md`);
    await mkdir(dirname(promptPath), { recursive: true });
    await writeFile(promptPath, buildFanoutPrompt({ runId, peer, task, policy, lane }));
    round.prompts.push({ peer, pointer: pointer(repoRoot, promptPath) });
  }

  const manifest = {
    schema_version: MANIFEST_SCHEMA,
    run_id: runId,
    status: 'planned',
    created_at: createdAt,
    updated_at: createdAt,
    repo_root_pointer: '.',
    task_pointer: pointer(repoRoot, taskPath),
    policy,
    peers: {
      requested: peers,
      active: activePeers,
      executable: executablePeers,
      manual: manualPeers,
      skipped: skippedPeers,
      lanes: peerLanes,
    },
    rounds: [round],
    consensus_pointer: null,
    limits: [
      'Peer execution requires the separate runtime:consensus execute command plus --execute.',
      'Raw peer output is stored only as run artifacts and is not printed into the main session.',
      'Consensus output is limited to synthesized summary, durable disagreements, and evidence pointers.',
      'Runtime never relaxes host permissions, sandbox, authentication, secrets, or host session context.',
      'Consensus rounds, companion execution process budget, and timeouts are capped; peer breadth is bounded by the explicit roster and optional --max-peers rather than a hard-coded product cap.',
      'Automatic unbounded retry loops are forbidden.',
    ],
  };
  const manifestPath = resolve(runDir, 'manifest.json');
  await writeJson(manifestPath, manifest);

  return {
    command: 'plan',
    version: VERSION,
    run_id: runId,
    status: manifest.status,
    run_pointer: pointer(repoRoot, runDir),
    policy,
    peers: manifest.peers,
    peer_lanes: peerLanes,
    artifacts: [
      { kind: 'manifest', pointer: pointer(repoRoot, manifestPath) },
      { kind: 'task', pointer: pointer(repoRoot, taskPath) },
      ...round.prompts.map((prompt) => ({ kind: 'peer-prompt', ...prompt, round: 1 })),
    ],
    next_steps: compact([
      executablePeers.length > 0
        ? `Execute companion-backed peers with runtime:consensus execute --run-id ${runId} --execute.`
        : null,
      manualPeers.length > 0
        ? `Run manual peer prompt artifacts for ${manualPeers.join(', ')} and record each output with runtime:consensus record --run-id ${runId} --peer <peer> --input-file <path>.`
        : `Record any manually obtained raw peer output with runtime:consensus record --run-id ${runId} --peer <peer> --input-file <path>.`,
      `Synthesize with runtime:consensus synthesize --run-id ${runId} --summary-file <path> [--disagreements-file <path>].`,
    ]),
    limits: manifest.limits,
  };
}

export async function recordOutput(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const runId = validateRunId(required(options.runId, '--run-id'));
  const peer = validatePeerId(required(options.peer, '--peer'));
  const inputFile = resolve(required(options.inputFile, '--input-file'));
  await access(inputFile, constants.R_OK);
  const now = options.now ?? new Date();
  const manifestPath = manifestFile(repoRoot, runId);
  const manifest = await readJson(manifestPath);
  const roundNumber = positiveInt(options.round ?? latestRoundNumber(manifest), '--round');
  const round = findRound(manifest, roundNumber);
  if (!manifest.peers.active.includes(peer)) {
    throw new Error(`--peer must be one of active peers: ${manifest.peers.active.join(', ')}`);
  }

  const raw = await readFile(inputFile);
  const rawPath = resolve(consensusRunDir(repoRoot, runId), 'rounds', `round-${roundNumber}`, 'raw', `${peer}.txt`);
  await assertInside(consensusRunDir(repoRoot, runId), rawPath);
  await mkdir(dirname(rawPath), { recursive: true });
  await writeFile(rawPath, raw);
  const metadata = {
    peer,
    pointer: pointer(repoRoot, rawPath),
    bytes: raw.byteLength,
    sha256: sha256(raw),
    recorded_at: toIso(now),
  };

  round.raw_outputs = round.raw_outputs.filter((entry) => entry.peer !== peer);
  round.raw_outputs.push(metadata);
  round.status = hasAllOutputs(round, manifest.peers.active) ? 'recorded' : 'collecting';
  manifest.status = round.status === 'recorded' ? 'recorded' : 'collecting';
  manifest.updated_at = toIso(now);
  await writeJson(manifestPath, manifest);

  return {
    command: 'record',
    version: VERSION,
    run_id: runId,
    status: manifest.status,
    round: roundNumber,
    raw_output: metadata,
    artifacts: [
      { kind: 'manifest', pointer: pointer(repoRoot, manifestPath) },
      { kind: 'peer-output', round: roundNumber, ...metadata },
    ],
    limits: [
      'Raw peer output was written to an artifact file and is intentionally omitted from this report.',
    ],
  };
}

export async function synthesizeConsensus(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const runId = validateRunId(required(options.runId, '--run-id'));
  const now = options.now ?? new Date();
  const manifestPath = manifestFile(repoRoot, runId);
  const manifest = await readJson(manifestPath);
  const summary = await resolveSummary(options, runId);
  const durableDisagreements = await resolveDisagreements(options, repoRoot, manifest);
  const evidencePointers = collectEvidencePointers(manifest);
  const converged = options.converged === true;
  const nextRound = buildNextRoundAvailability({ manifest, durableDisagreements, runId });
  const result = {
    schema_version: RESULT_SCHEMA,
    run_id: runId,
    status: converged ? 'converged' : 'durable-disagreement',
    created_at: toIso(now),
    synthesized_summary: summary.trim(),
    durable_disagreements: durableDisagreements,
    evidence_pointers: evidencePointers,
    next_round: nextRound,
    next_action: options.nextAction ?? (converged ? 'Proceed with the synthesized decision.' : 'Owner decision required for durable disagreements.'),
    limits: [
      'Peer raw outputs remain in artifact files.',
      'This result is intentionally limited to synthesis, durable disagreements, and evidence pointers.',
    ],
  };
  const resultPath = resolve(consensusRunDir(repoRoot, runId), 'consensus.json');
  await writeJson(resultPath, result);
  manifest.consensus_pointer = pointer(repoRoot, resultPath);
  manifest.status = result.status;
  manifest.updated_at = toIso(now);
  await writeJson(manifestPath, manifest);

  return {
    command: 'synthesize',
    version: VERSION,
    run_id: runId,
    status: result.status,
    synthesized_summary: result.synthesized_summary,
    durable_disagreements: result.durable_disagreements,
    evidence_pointers: result.evidence_pointers,
    next_round: result.next_round,
    consensus_pointer: manifest.consensus_pointer,
    next_action: result.next_action,
    limits: result.limits,
  };
}

export async function planNextRound(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const runId = validateRunId(required(options.runId, '--run-id'));
  const now = options.now ?? new Date();
  const manifestPath = manifestFile(repoRoot, runId);
  const manifest = await readJson(manifestPath);
  const nextRound = positiveInt(options.round ?? latestRoundNumber(manifest) + 1, '--round');
  if (nextRound > manifest.policy.max_rounds) {
    throw new Error(`Round ${nextRound} exceeds policy max_rounds ${manifest.policy.max_rounds}; no next-round prompt was written and no peers were executed`);
  }
  if (manifest.rounds.some((round) => round.round === nextRound)) {
    throw new Error(`Round ${nextRound} already exists; choose a new --round or inspect runtime:consensus status --run-id ${runId}`);
  }
  const disagreements = await resolveNextRoundDisagreements(options, repoRoot, manifest);
  if (disagreements.length === 0) {
    throw new Error(`next-round requires at least one durable disagreement; no next-round prompt was written and no peers were executed`);
  }
  const round = {
    round: nextRound,
    kind: 'targeted-rebuttal',
    status: 'planned',
    prompts: [],
    raw_outputs: [],
    created_at: toIso(now),
  };
  for (const peer of manifest.peers.active) {
    const lane = peerLanesFor(manifest, runId).find((entry) => entry.peer === peer);
    const promptPath = resolve(consensusRunDir(repoRoot, runId), 'rounds', `round-${nextRound}`, 'prompts', `${peer}.md`);
    await mkdir(dirname(promptPath), { recursive: true });
    await writeFile(promptPath, buildRebuttalPrompt({ runId, peer, disagreements, round: nextRound, lane }));
    round.prompts.push({ peer, pointer: pointer(repoRoot, promptPath) });
  }
  manifest.rounds.push(round);
  manifest.status = 'planned-rebuttal';
  manifest.updated_at = toIso(now);
  await writeJson(manifestPath, manifest);
  const executablePeers = executablePeersFor(manifest);

  return {
    command: 'next-round',
    version: VERSION,
    run_id: runId,
    status: manifest.status,
    round: nextRound,
    execution: {
      available: executablePeers.length > 0,
      command: executablePeers.length > 0 ? `runtime:consensus execute --run-id ${runId} --round ${nextRound} --execute` : null,
      peer_execution: false,
    },
    artifacts: [
      { kind: 'manifest', pointer: pointer(repoRoot, manifestPath) },
      ...round.prompts.map((prompt) => ({ kind: 'peer-prompt', ...prompt, round: nextRound })),
    ],
    durable_disagreements: disagreements,
    limits: [
      'Next-round prompts contain synthesized disagreement summaries, not raw peer output.',
      'Peer execution still requires runtime:consensus execute --execute.',
    ],
  };
}

export async function executeRound(options = {}) {
  if (options.execute !== true) {
    throw new Error('execute command requires --execute');
  }
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const homeDir = resolve(options.homeDir ?? homedir());
  const env = options.env ?? process.env;
  const runner = options.runner ?? runCommand;
  const now = options.now ?? new Date();
  const startedAt = toIso(now);
  const runId = validateRunId(required(options.runId, '--run-id'));
  const manifestPath = manifestFile(repoRoot, runId);
  const manifest = await readJson(manifestPath);
  const roundNumber = positiveInt(options.round ?? latestRoundNumber(manifest), '--round');
  const round = findRound(manifest, roundNumber);
  const executablePeers = executablePeersFor(manifest);
  const requestedPeers = options.peers ? normalizePeers(options.peers) : executablePeers;
  const unknownPeers = requestedPeers.filter((peer) => !manifest.peers.active.includes(peer));
  if (unknownPeers.length > 0) {
    throw new Error(`--peers must be active peers from the manifest: ${manifest.peers.active.join(', ')}`);
  }
  const manualRequested = requestedPeers.filter((peer) => !executablePeers.includes(peer));
  if (manualRequested.length > 0) {
    throw new Error(`--peers includes manual-only peer(s): ${manualRequested.join(', ')}. Record those outputs with runtime:consensus record; execute only supports companion peers: ${executablePeers.join(', ') || '<none>'}`);
  }
  if (requestedPeers.length === 0) {
    throw new Error('No executable companion peers are available for this consensus run; use runtime:consensus record for manual peer outputs');
  }
  const timeoutMs = boundedPositiveInt(
    options.timeoutMs ?? manifest.policy?.execution_timeout_ms ?? DEFAULT_EXECUTION_TIMEOUT_MS,
    '--timeout-ms',
    MAX_EXECUTION_TIMEOUT_MS,
  );
  const processBudget = boundedPositiveInt(
    options.processBudget ?? Math.min(manifest.policy?.process_budget ?? requestedPeers.length, requestedPeers.length),
    '--process-budget',
    requestedPeers.length,
  );
  const executionPeers = requestedPeers.slice(0, processBudget);
  const skippedPeers = requestedPeers.slice(processBudget);
  const progressPath = resolve(consensusRunDir(repoRoot, runId), 'execution-progress.json');
  await assertInside(consensusRunDir(repoRoot, runId), progressPath);
  const progress = createExecutionProgress({
    repoRoot,
    runId,
    roundNumber,
    startedAt,
    requestedPeers,
    executionPeers,
    skippedPeers,
    timeoutMs,
    processBudget,
  });
  await writeExecutionProgress(repoRoot, progressPath, progress);

  const doctor = await runDoctor({
    repoRoot,
    homeDir,
    env,
    now,
    runner,
    format: 'json',
    explicitModel: options.model ?? null,
    explicitEffort: options.effort ?? null,
  });
  progress.preflight.status = 'completed';
  progress.preflight.completed_at = toIso(new Date());
  progress.updated_at = progress.preflight.completed_at;
  await writeExecutionProgress(repoRoot, progressPath, progress);

  const executions = [];
  for (const peer of executionPeers) {
    markProgressRunning(progress, peer, { timeoutMs });
    await writeExecutionProgress(repoRoot, progressPath, progress);
    const execution = await executePeer({
      repoRoot,
      runId,
      roundNumber,
      round,
      peer,
      doctor,
      env,
      runner,
      timeoutMs,
      now,
    });
    executions.push(execution);
    markProgressFromExecution(progress, execution);
    await writeExecutionProgress(repoRoot, progressPath, progress);
  }
  for (const peer of skippedPeers) {
    const execution = await writeSkippedExecution({
      repoRoot,
      runId,
      roundNumber,
      peer,
      reason: `skipped by --process-budget=${processBudget}`,
      now,
    });
    executions.push(execution);
    markProgressFromExecution(progress, execution);
    await writeExecutionProgress(repoRoot, progressPath, progress);
  }

  round.execution_results = mergePeerEntries(round.execution_results ?? [], executions);
  round.raw_outputs = mergePeerEntries(round.raw_outputs ?? [], executions.map((execution) => ({
    peer: execution.peer,
    pointer: execution.raw_output.pointer,
    bytes: execution.raw_output.bytes,
    sha256: execution.raw_output.sha256,
    recorded_at: execution.completed_at,
    source: 'runtime-consensus-executor',
    status: execution.status,
  })));
  round.status = summarizeRoundStatus({ executions, activePeers: manifest.peers.active, round });
  manifest.status = round.status;
  manifest.updated_at = startedAt;

  const executionSummary = summarizeExecutions(executions);
  const executionPath = resolve(consensusRunDir(repoRoot, runId), 'execution.json');
  const progressPointer = pointer(repoRoot, progressPath);
  const executionStatus = executionSummary.failed > 0
    ? executionSummary.operator_action_required === executionSummary.failed
      ? 'operator_action_required'
      : 'failed'
    : executionSummary.executed > 0 ? 'passed' : 'skipped';
  progress.status = executionStatus;
  progress.summary = executionSummary;
  progress.updated_at = toIso(new Date());
  await writeExecutionProgress(repoRoot, progressPath, progress);
  const executionArtifact = {
    schema_version: EXECUTION_SCHEMA,
    runtime_version: VERSION,
    run_id: runId,
    status: executionStatus,
    created_at: startedAt,
    updated_at: startedAt,
    round: roundNumber,
    peer_execution: true,
    progress_pointer: progressPointer,
    execution_boundary: {
      command: 'runtime:consensus execute',
      execute_flag_required: true,
      execute_flag_supplied: true,
      timeout_ms: timeoutMs,
      process_budget: processBudget,
    },
    summary: executionSummary,
    executions,
    failures: executions
      .filter((execution) => execution.status !== 'passed')
      .map((execution) => ({
        peer: execution.peer,
        status: execution.status,
        failure_type: execution.failure_type,
        operator_action_required: execution.operator_action_required,
        retryable: execution.retryable,
        retry_after: execution.retry_after,
        retry_command: execution.retry_command,
        raw_output: execution.raw_output,
      })),
    limits: executionLimits(),
  };
  await writeJson(executionPath, executionArtifact);
  await writeJson(resolve(consensusRoot(repoRoot), 'latest.json'), {
    schema_version: LATEST_EXECUTION_SCHEMA,
    runtime_version: VERSION,
    run_id: runId,
    status: executionArtifact.status,
    updated_at: startedAt,
    round: roundNumber,
    execution_pointer: pointer(repoRoot, executionPath),
    progress_pointer: progressPointer,
    summary: executionSummary,
  });
  await writeJson(manifestPath, manifest);

  return {
    command: 'execute',
    version: VERSION,
    run_id: runId,
    status: executionArtifact.status,
    round: roundNumber,
    peer_execution: true,
    run_pointer: pointer(repoRoot, consensusRunDir(repoRoot, runId)),
    execution_pointer: pointer(repoRoot, executionPath),
    progress_pointer: progressPointer,
    execution_boundary: executionArtifact.execution_boundary,
    execution_summary: executionSummary,
    executions,
    artifacts: [
      { kind: 'manifest', pointer: pointer(repoRoot, manifestPath) },
      { kind: 'consensus-execution', pointer: pointer(repoRoot, executionPath) },
      { kind: 'consensus-progress', pointer: progressPointer },
      ...executions.map((execution) => ({ kind: 'peer-output', round: roundNumber, peer: execution.peer, ...execution.raw_output })),
      ...executions.map((execution) => ({ kind: 'peer-execution', round: roundNumber, peer: execution.peer, pointer: execution.execution_pointer })),
    ],
    limits: executionArtifact.limits,
  };
}

export async function readStatus(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const selection = await resolveStatusRunSelection({
    repoRoot,
    runId: options.runId,
    latest: options.latest,
  });
  const runId = selection.runId;
  const manifestPath = manifestFile(repoRoot, runId);
  const manifest = await readJson(manifestPath);
  const runDir = consensusRunDir(repoRoot, runId);
  const executionPath = resolve(runDir, 'execution.json');
  const progressPath = resolve(runDir, 'execution-progress.json');
  const executionArtifact = await readJsonIfExists(executionPath);
  const progressArtifact = await readJsonIfExists(progressPath);
  const consensusArtifact = manifest.consensus_pointer
    ? await readJsonIfExists(resolve(repoRoot, manifest.consensus_pointer))
    : null;
  const evidencePointers = collectEvidencePointers(manifest);
  const statusGuidance = buildStatusGuidance({
    runId,
    manifest,
    executionArtifact,
    progressArtifact,
    consensusArtifact,
  });
  return {
    command: 'status',
    version: VERSION,
    run_id: runId,
    lookup: selection.lookup,
    status: manifest.status,
    run_pointer: pointer(repoRoot, consensusRunDir(repoRoot, runId)),
    manifest_pointer: pointer(repoRoot, manifestPath),
    consensus_pointer: manifest.consensus_pointer,
    execution_pointer: executionArtifact ? pointer(repoRoot, executionPath) : null,
    progress_pointer: progressArtifact ? pointer(repoRoot, progressPath) : null,
    execution_summary: executionArtifact?.summary ?? progressArtifact?.summary ?? null,
    rounds: manifest.rounds.map((round) => ({
      round: round.round,
      kind: round.kind,
      status: round.status,
      prompt_count: round.prompts.length,
      raw_output_count: round.raw_outputs.length,
    })),
    peer_lanes: peerLanesFor(manifest, runId),
    evidence_pointers: evidencePointers,
    status_guidance: statusGuidance,
    next_action: statusGuidance.next_action,
    next_steps: statusGuidance.next_steps,
    limits: manifest.limits,
  };
}

async function executePeer({
  repoRoot,
  runId,
  roundNumber,
  round,
  peer,
  doctor,
  env,
  runner,
  timeoutMs,
  now,
}) {
  const directionKey = PEER_DIRECTIONS[peer];
  if (!directionKey) {
    return writeFailedExecution({
      repoRoot,
      runId,
      roundNumber,
      peer,
      now,
      failure: failureClass({
        status: 'failed',
        type: 'unsupported_peer',
        retryable: false,
        retry_after: 'choose one of the supported companion peers: claude,codex',
      }),
      companionPath: null,
      raw: '',
      execution: {
        executed: false,
        started_at: null,
        timeout_ms: timeoutMs,
        companion_exit_code: null,
        companion_error_code: null,
        timed_out: false,
        envelope_status: null,
        peer_host: peer,
        peer_model: null,
        peer_exit_code: null,
        metadata: null,
        error: { kind: 'unsupported_peer', message: 'no companion direction is defined for this peer' },
      },
    });
  }

  const companionDirection = doctor.companions.directions[directionKey];
  const directionSettings = doctor.model_effort.directions[directionKey];
  const companionPath = companionDirection?.selected?.path ?? null;
  if (!companionPath) {
    return writeFailedExecution({
      repoRoot,
      runId,
      roundNumber,
      peer,
      now,
      failure: failureClass({
        status: 'failed',
        type: 'companion_unavailable',
        retryable: false,
        retry_after: 'install or repair the companions plugin before retrying runtime:consensus execute',
      }),
      companionPath,
      raw: '',
      execution: {
        executed: false,
        started_at: null,
        timeout_ms: timeoutMs,
        companion_exit_code: null,
        companion_error_code: null,
        timed_out: false,
        envelope_status: null,
        peer_host: peer,
        peer_model: null,
        peer_exit_code: null,
        metadata: null,
        error: { kind: 'companion_unavailable', message: `${companionDirection?.filename ?? 'companion'} is not available` },
      },
    });
  }

  const prompt = round.prompts.find((entry) => entry.peer === peer);
  if (!prompt) {
    return writeFailedExecution({
      repoRoot,
      runId,
      roundNumber,
      peer,
      now,
      failure: failureClass({
        status: 'failed',
        type: 'prompt_missing',
        retryable: false,
        retry_after: 'recreate the consensus plan or next-round prompt before retrying',
      }),
      companionPath,
      raw: '',
      execution: {
        executed: false,
        started_at: null,
        timeout_ms: timeoutMs,
        companion_exit_code: null,
        companion_error_code: null,
        timed_out: false,
        envelope_status: null,
        peer_host: peer,
        peer_model: null,
        peer_exit_code: null,
        metadata: null,
        error: { kind: 'prompt_missing', message: 'peer prompt artifact is missing from the manifest round' },
      },
    });
  }

  const args = [
    companionPath,
    'task',
    '--cwd',
    repoRoot,
    '--output-format',
    'json',
    '--prompt-file',
    resolve(repoRoot, prompt.pointer),
  ];
  if (directionSettings.model.value) args.push('--model', directionSettings.model.value);
  if (directionSettings.effort.value) args.push('--effort', directionSettings.effort.value);

  const startedAt = toIso(new Date());
  const result = await runner(process.execPath, args, {
    cwd: repoRoot,
    env,
    timeoutMs,
  });
  const parsed = parseJsonObject(result.stdout);
  const raw = typeof parsed?.stdout === 'string' ? parsed.stdout : '';
  const failure = classifyConsensusExecutionFailure({ result, parsed });
  return writeExecutionResult({
    repoRoot,
    runId,
    roundNumber,
    peer,
    now,
    companionPath,
    raw,
    status: failure ? failure.status : 'passed',
    failure,
    execution: {
      executed: true,
      started_at: startedAt,
      timeout_ms: timeoutMs,
      companion_exit_code: result.exit_code ?? null,
      companion_error_code: result.error_code ?? null,
      timed_out: Boolean(result.timed_out),
      envelope_status: parsed?.status ?? null,
      peer_host: parsed?.peer_host ?? peer,
      peer_model: parsed?.peer_model ?? null,
      peer_exit_code: parsed?.exit_code ?? null,
      metadata: normalizeExecutionMetadata(parsed?.metadata),
      error: normalizeExecutionError(parsed?.error, failure),
    },
  });
}

async function writeSkippedExecution({ repoRoot, runId, roundNumber, peer, reason, now }) {
  return writeFailedExecution({
    repoRoot,
    runId,
    roundNumber,
    peer,
    now,
    failure: failureClass({
      status: 'skipped',
      type: 'process_budget_exceeded',
      retryable: true,
      retry_after: 'retry with a larger --process-budget within the policy cap',
    }),
    companionPath: null,
    raw: '',
    execution: {
      executed: false,
      started_at: null,
      timeout_ms: null,
      companion_exit_code: null,
      companion_error_code: null,
      timed_out: false,
      envelope_status: null,
      peer_host: peer,
      peer_model: null,
      peer_exit_code: null,
      metadata: null,
      error: { kind: 'process_budget_exceeded', message: reason },
    },
  });
}

async function writeFailedExecution({ repoRoot, runId, roundNumber, peer, now, failure, companionPath, raw, execution }) {
  return writeExecutionResult({
    repoRoot,
    runId,
    roundNumber,
    peer,
    now,
    companionPath,
    raw,
    status: failure.status,
    failure,
    execution,
  });
}

async function writeExecutionResult({
  repoRoot,
  runId,
  roundNumber,
  peer,
  now,
  companionPath,
  raw,
  status,
  failure,
  execution,
}) {
  const completedAt = toIso(now);
  const rawBuffer = Buffer.from(raw ?? '', 'utf8');
  const rawPath = resolve(consensusRunDir(repoRoot, runId), 'rounds', `round-${roundNumber}`, 'raw', `${peer}.txt`);
  await assertInside(consensusRunDir(repoRoot, runId), rawPath);
  await mkdir(dirname(rawPath), { recursive: true });
  await writeFile(rawPath, rawBuffer);
  const rawOutput = {
    pointer: pointer(repoRoot, rawPath),
    bytes: rawBuffer.byteLength,
    sha256: sha256(rawBuffer),
  };
  const executionPath = resolve(consensusRunDir(repoRoot, runId), 'rounds', `round-${roundNumber}`, 'executions', `${peer}.json`);
  await assertInside(consensusRunDir(repoRoot, runId), executionPath);
  const metadata = {
    peer,
    status,
    started_at: execution.started_at ?? null,
    completed_at: completedAt,
    companion_path: companionPath,
    ...execution,
    raw_output: rawOutput,
    failure_type: failure?.type ?? null,
    operator_action_required: failure?.operator_action_required === true,
    retryable: failure?.retryable ?? false,
    retry_after: failure?.retry_after ?? null,
    retry_command: buildRetryCommand({
      failure,
      runId,
      roundNumber,
      peer,
      timeoutMs: execution.timeout_ms,
    }),
    limits: [
      'Raw peer stdout is stored only in the raw_output pointer.',
      'This execution metadata intentionally omits raw stdout and stderr.',
    ],
  };
  metadata.execution_pointer = pointer(repoRoot, executionPath);
  await writeJson(executionPath, metadata);
  return metadata;
}

function createExecutionProgress({
  repoRoot,
  runId,
  roundNumber,
  startedAt,
  requestedPeers,
  executionPeers,
  skippedPeers,
  timeoutMs,
  processBudget,
}) {
  const peers = {};
  for (const peer of requestedPeers) {
    const scheduled = executionPeers.includes(peer);
    peers[peer] = {
      peer,
      status: scheduled ? 'pending' : 'skipped',
      scheduled,
      started_at: null,
      completed_at: null,
      timeout_ms: scheduled ? timeoutMs : null,
      raw_output: null,
      execution_pointer: null,
      failure_type: scheduled ? null : 'process_budget_exceeded',
      operator_action_required: false,
      retryable: !scheduled,
      retry_after: scheduled ? null : 'retry with a larger --process-budget within the policy cap',
      retry_command: scheduled
        ? null
        : `runtime:consensus execute --run-id ${runId} --round ${roundNumber} --peers ${peer} --execute --process-budget 1`,
    };
  }
  return {
    schema_version: PROGRESS_SCHEMA,
    runtime_version: VERSION,
    run_id: runId,
    status: 'running',
    created_at: startedAt,
    updated_at: startedAt,
    round: roundNumber,
    peer_execution: true,
    execution_boundary: {
      execute_flag_required: true,
      execute_flag_supplied: true,
      timeout_ms: timeoutMs,
      process_budget: processBudget,
    },
    preflight: {
      status: 'running',
      completed_at: null,
    },
    requested_peers: requestedPeers,
    execution_peers: executionPeers,
    skipped_peers: skippedPeers,
    peers,
    summary: null,
    limits: [
      'Progress artifacts contain status, failure, retryability, and artifact pointers only.',
      'Raw peer stdout remains only in raw_output pointers under the consensus run directory.',
      'Progress does not authorize automatic retries, host permission relaxation, or host session mutation.',
    ],
    progress_pointer: pointer(repoRoot, resolve(consensusRunDir(repoRoot, runId), 'execution-progress.json')),
  };
}

async function writeExecutionProgress(repoRoot, progressPath, progress) {
  progress.progress_pointer = pointer(repoRoot, progressPath);
  await writeJson(progressPath, progress);
}

function markProgressRunning(progress, peer, { timeoutMs }) {
  const entry = progress.peers[peer];
  if (!entry) return;
  entry.status = 'running';
  entry.started_at = toIso(new Date());
  entry.timeout_ms = timeoutMs;
  entry.failure_type = null;
  entry.retryable = false;
  entry.retry_after = null;
  entry.retry_command = null;
  progress.status = 'running';
  progress.updated_at = entry.started_at;
}

function markProgressFromExecution(progress, execution) {
  const entry = progress.peers[execution.peer];
  if (!entry) return;
  entry.status = execution.status;
  entry.started_at = execution.started_at ?? entry.started_at;
  entry.completed_at = execution.completed_at;
  entry.timeout_ms = execution.timeout_ms ?? entry.timeout_ms;
  entry.raw_output = execution.raw_output;
  entry.execution_pointer = execution.execution_pointer;
  entry.failure_type = execution.failure_type;
  entry.operator_action_required = execution.operator_action_required;
  entry.retryable = execution.retryable;
  entry.retry_after = execution.retry_after;
  entry.retry_command = execution.retry_command;
  progress.updated_at = execution.completed_at;
}

function buildRetryCommand({ failure, runId, roundNumber, peer, timeoutMs }) {
  if (!failure?.retryable) return null;
  const base = `runtime:consensus execute --run-id ${runId} --round ${roundNumber} --peers ${peer} --execute`;
  if (failure.type === 'timeout') {
    const nextTimeout = Math.min(MAX_EXECUTION_TIMEOUT_MS, Math.max(DEFAULT_EXECUTION_TIMEOUT_MS, Math.ceil((timeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS) * 2)));
    return `${base} --timeout-ms ${nextTimeout} --process-budget 1`;
  }
  if (failure.type === 'process_budget_exceeded') {
    return `${base} --process-budget 1`;
  }
  return base;
}

function classifyConsensusExecutionFailure({ result, parsed }) {
  if (result.timed_out || result.error_code === 'ETIMEDOUT') {
    return failureClass({
      status: 'timed_out',
      type: 'timeout',
      retryable: true,
      retry_after: 'retry this peer with a larger --timeout-ms within the policy cap or after host command load drops; run runtime:doctor --deep-peer-smoke --execute-deep-peer-smoke when prompt startup latency is unclear',
    });
  }
  const text = [
    result.error_code,
    result.error_message,
    result.stderr,
    parsed?.status,
    parsed?.error?.kind,
    parsed?.error?.message,
  ].filter(Boolean).join(' ').toLowerCase();
  if (result.ok && parsed?.status === 'success' && parsed?.exit_code === 0) return null;
  if (['ENOENT', 'ENOTDIR'].includes(String(result.error_code ?? '').toUpperCase()) || /\b(peer_cli_not_found|not found|not executable)\b/.test(text)) {
    return failureClass({
      status: 'failed',
      type: 'cli_unavailable',
      retryable: false,
      retry_after: 'install the missing peer host CLI before retrying',
    });
  }
  if (/\b(peer_unauthenticated|not logged in|login required|auth required|authentication required|unauthorized|forbidden|401|403)\b/.test(text)) {
    return failureClass({
      status: 'operator_action_required',
      type: 'auth_required',
      retryable: false,
      retry_after: 'operator must authenticate the peer host CLI in the same execution context used by the companion, then retry',
    });
  }
  if (/\b(approval|consent|requires approval|approval required|permission prompt)\b/.test(text)) {
    return failureClass({
      status: 'operator_action_required',
      type: 'permission_required',
      retryable: false,
      retry_after: 'operator must satisfy host approval or permission policy outside runtime:consensus, then retry',
    });
  }
  if (/\b(permission denied|not permitted|operation not permitted|sandbox|read-only|read only|not allowed|eacces|eperm|denied)\b/.test(text)) {
    return failureClass({
      status: 'operator_action_required',
      type: 'sandbox_blocked',
      retryable: false,
      retry_after: 'operator must satisfy host sandbox or filesystem permission preconditions outside runtime:consensus, then retry',
    });
  }
  if (/\b(enotfound|econnreset|econnrefused|ehostunreach|network|networkerror|dns|tls|socket|temporary failure)\b/.test(text)) {
    return failureClass({
      status: 'failed',
      type: 'network',
      retryable: true,
      retry_after: 'retry after network connectivity recovers',
    });
  }
  if (/\b(rate limit|too many requests|429|temporarily unavailable|try again|busy)\b/.test(text)) {
    return failureClass({
      status: 'failed',
      type: 'transient_host_failure',
      retryable: true,
      retry_after: 'retry after the host-imposed backoff or transient failure clears',
    });
  }
  return failureClass({
    status: 'failed',
    type: parsed?.status === 'peer_error' ? 'peer_error' : 'companion_error',
    retryable: false,
    retry_after: 'inspect the peer host failure outside runtime:consensus before retrying',
  });
}

function failureClass({ status, type, retryable, retry_after }) {
  return {
    status,
    type,
    retryable,
    retry_after,
    operator_action_required: status === 'operator_action_required' || ['auth_required', 'permission_required', 'sandbox_blocked'].includes(type),
  };
}

function normalizeExecutionMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  return {
    duration_ms: Number.isFinite(metadata.duration_ms) ? metadata.duration_ms : null,
    started_at: sanitizeValue(metadata.started_at),
    completed_at: sanitizeValue(metadata.completed_at),
  };
}

function normalizeExecutionError(error, failure) {
  if (!error && !failure) return null;
  return {
    kind: sanitizeValue(error?.kind ?? failure?.type ?? 'execution_error'),
    message: failure ? sanitizeValue(failure.type) : sanitizeValue(error?.message ?? 'execution failed'),
  };
}

function summarizeExecutions(executions) {
  const summary = {
    executed: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    failed_retryable: 0,
    failed_non_retryable: 0,
    operator_action_required: 0,
  };
  for (const execution of executions) {
    if (execution.executed) summary.executed += 1;
    if (execution.status === 'passed') summary.passed += 1;
    else if (execution.status === 'skipped') summary.skipped += 1;
    else {
      summary.failed += 1;
      if (execution.retryable) summary.failed_retryable += 1;
      else summary.failed_non_retryable += 1;
      if (execution.operator_action_required) summary.operator_action_required += 1;
    }
  }
  return summary;
}

function summarizeRoundStatus({ executions, activePeers, round }) {
  const successful = new Set((round.raw_outputs ?? [])
    .filter((entry) => entry.status === 'passed' || entry.status === undefined)
    .map((entry) => entry.peer));
  for (const execution of executions) {
    if (execution.status === 'passed') successful.add(execution.peer);
    else successful.delete(execution.peer);
  }
  const failed = executions.some((execution) => !['passed', 'skipped'].includes(execution.status));
  if (failed && successful.size === 0) return 'failed';
  if (failed) return 'partially-failed';
  if (successful.size >= activePeers.length) return 'executed';
  return 'partially-executed';
}

function mergePeerEntries(existing, updates) {
  const byPeer = new Map((existing ?? []).map((entry) => [entry.peer, entry]));
  for (const update of updates) byPeer.set(update.peer, update);
  return [...byPeer.values()];
}

function buildNextRoundAvailability({ manifest, durableDisagreements, runId }) {
  const latestRound = latestRoundNumber(manifest);
  const hasDisagreements = durableDisagreements.length > 0;
  const budgetRemaining = latestRound < manifest.policy.max_rounds;
  const hasExecutablePeers = executablePeersFor(manifest).length > 0;
  return {
    available: hasDisagreements && budgetRemaining,
    reason: !hasDisagreements
      ? 'no durable disagreements were synthesized'
      : budgetRemaining
        ? 'durable disagreements remain and max_rounds budget is available'
        : `max_rounds ${manifest.policy.max_rounds} exhausted`,
    current_round: latestRound,
    max_rounds: manifest.policy.max_rounds,
    command: hasDisagreements && budgetRemaining ? `runtime:consensus next-round --run-id ${runId}` : null,
    execute_command: hasDisagreements && budgetRemaining && hasExecutablePeers ? `runtime:consensus execute --run-id ${runId} --round ${latestRound + 1} --execute` : null,
  };
}

function buildPeerLanes({ runId, activePeers }) {
  return activePeers.map((peer) => {
    const companionDirection = PEER_DIRECTIONS[peer] ?? null;
    const lane = companionDirection ? 'companion_execute' : 'manual_subagent_record';
    return {
      peer,
      lane,
      peer_execution: lane === 'companion_execute',
      companion_direction: companionDirection,
      operator_action: lane === 'companion_execute'
        ? 'Execute through runtime:consensus execute --execute, which invokes the companion contract for this peer.'
        : 'Run the prompt manually or in a local subagent, then store the output with runtime:consensus record.',
      command_template: runId ? laneCommandTemplate({ runId, peer, lane }) : null,
      output_policy: 'artifact-pointer-only',
      host_session_mutation: false,
    };
  });
}

function peerLanesFor(manifest, runId) {
  if (Array.isArray(manifest.peers?.lanes) && manifest.peers.lanes.length > 0) {
    return manifest.peers.lanes.map((lane) => ({
      ...lane,
      command_template: lane.command_template ?? laneCommandTemplate({ runId, peer: lane.peer, lane: lane.lane }),
    }));
  }
  return buildPeerLanes({ runId, activePeers: manifest.peers?.active ?? [] });
}

function laneCommandTemplate({ runId, peer, lane }) {
  if (lane === 'companion_execute') {
    return `runtime:consensus execute --run-id ${runId} --round <round> --peers ${peer} --execute`;
  }
  return `runtime:consensus record --run-id ${runId} --round <round> --peer ${peer} --input-file <path>`;
}

function buildStatusGuidance({ runId, manifest, executionArtifact, progressArtifact, consensusArtifact }) {
  const latestRound = findRound(manifest, latestRoundNumber(manifest));
  const summary = executionArtifact?.summary ?? progressArtifact?.summary ?? null;
  const retryCommands = collectRetryCommands(executionArtifact, progressArtifact);
  const executablePeers = executablePeersFor(manifest);
  const manualPeers = manualPeersFor(manifest);
  const missingManualPeers = missingOutputPeers(latestRound, manualPeers);
  const missingExecutablePeers = missingOutputPeers(latestRound, executablePeers);
  const latestRoundExecuteCommand = executablePeers.length > 0
    ? `runtime:consensus execute --run-id ${runId} --round ${latestRound.round} --execute`
    : null;
  const synthesizeCommand = `runtime:consensus synthesize --run-id ${runId} --summary-file <summary.md> [--disagreements-file <disagreements.md>]`;

  if (consensusArtifact) {
    const nextRound = buildNextRoundAvailability({
      manifest,
      durableDisagreements: consensusArtifact.durable_disagreements ?? [],
      runId,
    });
    if (consensusArtifact.status === 'converged' || (consensusArtifact.durable_disagreements ?? []).length === 0) {
      return guidance({
        state: 'complete',
        next_action: consensusArtifact.next_action ?? 'Consensus is converged; proceed with the synthesized decision.',
        next_steps: [],
        commands: [],
        reason: 'consensus artifact has no durable disagreements',
      });
    }
    if (nextRound.available) {
      return guidance({
        state: 'next_round_available',
        next_action: 'Durable disagreements remain; plan the bounded rebuttal round before executing more peers.',
        next_steps: [
          nextRound.command,
          nextRound.execute_command,
        ],
        commands: [nextRound.command, nextRound.execute_command].filter(Boolean),
        reason: nextRound.reason,
      });
    }
    return guidance({
      state: 'owner_decision_required',
      next_action: 'Durable disagreements remain but max_rounds is exhausted; ask the owner for a decision instead of running more peers.',
      next_steps: [],
      commands: [],
      reason: nextRound.reason,
    });
  }

  if (summary?.failed_retryable > 0 && retryCommands.length > 0) {
    return guidance({
      state: 'retry_failed_peers',
      next_action: 'Retry only the retryable failed peers using the per-peer retry commands.',
      next_steps: [
        ...retryCommands,
        'After retryable peers pass or are intentionally skipped, synthesize from artifact pointers.',
      ],
      commands: retryCommands,
      reason: `${summary.failed_retryable} retryable peer failure(s) recorded`,
    });
  }

  if (summary?.operator_action_required > 0) {
    return guidance({
      state: 'operator_action_required',
      next_action: 'Resolve host auth, sandbox, permission, or approval preconditions outside runtime before retrying peers.',
      next_steps: [
        'runtime:doctor --permission-proof --execute-permission-proof',
        'runtime:doctor --deep-peer-smoke --execute-deep-peer-smoke',
        ...retryCommands,
      ],
      commands: retryCommands,
      reason: `${summary.operator_action_required} peer failure(s) require operator action`,
    });
  }

  if (summary?.failed_non_retryable > 0) {
    return guidance({
      state: 'inspect_failure',
      next_action: 'Inspect the peer execution artifact and resolve the non-retryable failure before continuing consensus.',
      next_steps: [
        executionArtifact?.progress_pointer ? `runtime:consensus status --run-id ${runId}` : `Inspect ${executionArtifact?.execution_pointer ?? 'the execution artifact'} and rerun status.`,
      ],
      commands: [],
      reason: `${summary.failed_non_retryable} non-retryable peer failure(s) recorded`,
    });
  }

  if (missingManualPeers.length > 0 && ((latestRound.raw_outputs?.length ?? 0) > 0 || summary?.passed > 0 || missingExecutablePeers.length === 0)) {
    const recordCommands = missingManualPeers.map((peer) => `runtime:consensus record --run-id ${runId} --round ${latestRound.round} --peer ${peer} --input-file <path>`);
    return guidance({
      state: 'record_manual_peers',
      next_action: 'Record the remaining manual peer outputs before synthesis, or intentionally synthesize from partial evidence.',
      next_steps: [
        ...recordCommands,
        synthesizeCommand,
      ],
      commands: recordCommands,
      reason: `manual peer output missing for ${missingManualPeers.join(', ')}`,
    });
  }

  if ((latestRound.raw_outputs?.length ?? 0) > 0 || summary?.passed > 0) {
    return guidance({
      state: 'synthesize',
      next_action: 'Synthesize the recorded peer outputs into a bounded consensus result.',
      next_steps: [synthesizeCommand],
      commands: [synthesizeCommand],
      reason: 'peer output artifacts are available and no consensus artifact exists yet',
    });
  }

  if (latestRound.prompts?.length > 0) {
    const recordCommands = missingManualPeers.map((peer) => `runtime:consensus record --run-id ${runId} --round ${latestRound.round} --peer ${peer} --input-file <path>`);
    return guidance({
      state: 'execute_or_record',
      next_action: 'Execute the planned peer prompts, or run them manually and record each raw output as an artifact.',
      next_steps: compact([
        latestRoundExecuteCommand,
        ...recordCommands,
        `runtime:consensus record --run-id ${runId} --round ${latestRound.round} --peer <peer> --input-file <path>`,
      ]),
      commands: compact([latestRoundExecuteCommand]),
      reason: `round ${latestRound.round} has prompts but no peer output artifacts`,
    });
  }

  return guidance({
    state: 'blocked',
    next_action: 'Consensus status cannot identify a safe next step from the current artifacts.',
    next_steps: [`runtime:consensus status --run-id ${runId}`],
    commands: [],
    reason: 'no prompts, peer outputs, execution summary, or consensus result were found',
  });
}

function collectRetryCommands(executionArtifact, progressArtifact) {
  const commands = [];
  for (const execution of executionArtifact?.executions ?? []) {
    if (execution.retryable && execution.retry_command) commands.push(execution.retry_command);
  }
  for (const peer of Object.values(progressArtifact?.peers ?? {})) {
    if (peer.retryable && peer.retry_command) commands.push(peer.retry_command);
  }
  return [...new Set(commands)];
}

function guidance({ state, next_action, next_steps, commands, reason }) {
  return {
    state,
    reason,
    next_action,
    next_steps: next_steps.filter(Boolean),
    commands: commands.filter(Boolean),
  };
}

export function parseArgs(argv) {
  const args = [...argv];
  let command = null;
  if (args[0] && !args[0].startsWith('-')) {
    command = args.shift();
    if (!VALID_COMMANDS.has(command)) {
      throw new Error(`Command must be one of: ${[...VALID_COMMANDS].join(', ')}`);
    }
  }
  const options = {};
  while (args.length > 0) {
    const arg = args.shift();
    if (!arg.startsWith('-')) {
      if (!command && VALID_COMMANDS.has(arg)) {
        command = arg;
        continue;
      }
      throw new Error(`Command must be one of: ${[...VALID_COMMANDS].join(', ')}`);
    }
    switch (arg) {
      case '--repo-root':
        options.repoRoot = requireValue(args, arg);
        break;
      case '--format': {
        const format = requireValue(args, arg);
        if (!['text', 'json'].includes(format)) {
          throw new Error('--format must be text or json');
        }
        options.format = format;
        break;
      }
      case '--task':
        options.task = requireSingleLine(requireValue(args, arg), arg);
        break;
      case '--task-file':
        options.taskFile = requireValue(args, arg);
        break;
      case '--peers':
        options.peers = normalizePeers(requireValue(args, arg));
        break;
      case '--max-rounds':
        options.maxRounds = positiveInt(requireValue(args, arg), arg);
        break;
      case '--max-peers':
        options.maxPeers = positiveInt(requireValue(args, arg), arg);
        break;
      case '--token-budget':
        options.tokenBudget = positiveInt(requireValue(args, arg), arg);
        break;
      case '--time-budget-ms':
        options.timeBudgetMs = positiveInt(requireValue(args, arg), arg);
        break;
      case '--process-budget':
        options.processBudget = positiveInt(requireValue(args, arg), arg);
        break;
      case '--timeout-ms':
      case '--execution-timeout-ms':
        options.timeoutMs = positiveInt(requireValue(args, arg), arg);
        break;
      case '--execute':
        options.execute = true;
        break;
      case '--model':
        options.model = requireSingleLine(requireValue(args, arg), arg);
        break;
      case '--effort':
        options.effort = requireSingleLine(requireValue(args, arg), arg);
        break;
      case '--run-id':
        options.runId = validateRunId(requireValue(args, arg));
        break;
      case '--latest':
        options.latest = true;
        break;
      case '--peer':
        options.peer = validatePeerId(requireValue(args, arg));
        break;
      case '--input-file':
        options.inputFile = requireValue(args, arg);
        break;
      case '--round':
        options.round = positiveInt(requireValue(args, arg), arg);
        break;
      case '--summary':
        options.summary = requireValue(args, arg);
        break;
      case '--summary-file':
        options.summaryFile = requireValue(args, arg);
        break;
      case '--disagreements-file':
        options.disagreementsFile = requireValue(args, arg);
        break;
      case '--next-action':
        options.nextAction = requireSingleLine(requireValue(args, arg), arg);
        break;
      case '--converged':
        options.converged = true;
        break;
      case '--durable-disagreement':
        options.converged = false;
        break;
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  options.command = command ?? 'plan';
  if (options.runId && options.latest) {
    throw new Error('Use either --run-id or --latest, not both');
  }
  if (options.latest && options.command !== 'status') {
    throw new Error('--latest is only supported by status');
  }
  return options;
}

export function formatText(report) {
  if (report.help) {
    return helpText();
  }
  const lines = [`runtime:consensus ${report.version ?? VERSION} (${report.command})`];
  if (report.run_id) lines.push(`run: ${report.run_id}`);
  if (report.status) lines.push(`status: ${report.status}`);
  if (report.run_pointer) lines.push(`run artifact: ${report.run_pointer}`);
  if (report.consensus_pointer) lines.push(`consensus: ${report.consensus_pointer}`);
  if (report.execution_pointer) lines.push(`execution: ${report.execution_pointer}`);
  if (report.progress_pointer) lines.push(`progress: ${report.progress_pointer}`);
  if (report.execution_summary) {
    lines.push(`execution summary: executed=${report.execution_summary.executed}; passed=${report.execution_summary.passed}; failed=${report.execution_summary.failed}; skipped=${report.execution_summary.skipped}; retryable-failed=${report.execution_summary.failed_retryable}; non-retryable-failed=${report.execution_summary.failed_non_retryable}; operator-action-required=${report.execution_summary.operator_action_required ?? 0}`);
  }
  if (report.executions?.length) {
    lines.push('', 'executions:');
    for (const execution of report.executions) {
      lines.push(`- ${execution.peer}: status=${execution.status}; raw=${execution.raw_output.pointer}; bytes=${execution.raw_output.bytes}; sha256=${execution.raw_output.sha256}`);
      if (execution.failure_type) {
        lines.push(`  failure=${execution.failure_type}; operator-action-required=${Boolean(execution.operator_action_required)}; retryable=${execution.retryable}; retry-after=${execution.retry_after ?? '<none>'}`);
        if (execution.retry_command) lines.push(`  retry-command=${execution.retry_command}`);
      }
    }
  }
  if (report.peer_lanes?.length) {
    lines.push('', 'peer lanes:');
    for (const lane of report.peer_lanes) {
      lines.push(`- ${lane.peer}: lane=${lane.lane}; peer-execution=${lane.peer_execution}; command=${lane.command_template}`);
      lines.push(`  action: ${lane.operator_action}`);
    }
  }
  if (report.synthesized_summary) {
    lines.push('', 'synthesized summary:', report.synthesized_summary);
  }
  if (report.durable_disagreements?.length) {
    lines.push('', 'durable disagreements:');
    for (const disagreement of report.durable_disagreements) {
      lines.push(`- ${disagreement.summary ?? disagreement}`);
    }
  }
  if (report.evidence_pointers?.length) {
    lines.push('', 'evidence pointers:');
    for (const evidence of report.evidence_pointers) {
      const peer = evidence.peer ? ` ${evidence.peer}` : '';
      lines.push(`- ${evidence.kind}${peer}: ${evidence.pointer}`);
    }
  }
  if (report.artifacts?.length) {
    lines.push('', 'artifacts:');
    for (const artifact of report.artifacts) {
      const peer = artifact.peer ? ` ${artifact.peer}` : '';
      const round = artifact.round ? ` round-${artifact.round}` : '';
      lines.push(`- ${artifact.kind}${peer}${round}: ${artifact.pointer}`);
    }
  }
  if (report.next_steps?.length) {
    lines.push('', 'next steps:');
    for (const step of report.next_steps) lines.push(`- ${step}`);
  }
  if (report.next_action) {
    lines.push('', `next action: ${report.next_action}`);
  }
  if (report.next_round) {
    lines.push('', `next round: available=${report.next_round.available}; reason=${report.next_round.reason}`);
    if (report.next_round.command) lines.push(`next-round command: ${report.next_round.command}`);
    if (report.next_round.execute_command) lines.push(`execute command: ${report.next_round.execute_command}`);
  }
  if (report.limits?.length) {
    lines.push('', 'limits:');
    for (const limit of report.limits) lines.push(`- ${limit}`);
  }
  return lines.join('\n');
}

function helpText() {
  return `runtime:consensus ${VERSION}

Usage:
  runtime:consensus plan --task <text> [--peers claude,codex,reviewer] [--max-rounds N] [--max-peers N] [--timeout-ms N]
  runtime:consensus record --run-id <id> --peer <peer> --input-file <path>
  runtime:consensus synthesize --run-id <id> --summary-file <path> [--disagreements-file <path>]
  runtime:consensus next-round --run-id <id> [--disagreements-file <path>]
  runtime:consensus execute --run-id <id> [--round N] [--peers claude,codex] --execute [--timeout-ms N] [--process-budget N]
  runtime:consensus status --run-id <id>
  runtime:consensus status --latest

Planning and synthesis never execute peers. Peer dispatch is available only through the explicit execute command plus --execute. Only companion-backed peers (${COMPANION_PEERS.join(', ')}) are executable; other peer labels are manual/subagent lanes that must be collected with record.`;
}

async function resolveStatusRunSelection({ repoRoot, runId, latest }) {
  if (runId && latest) {
    throw new Error('Use either --run-id or --latest, not both');
  }
  if (latest) return findLatestConsensusRun(repoRoot);
  const validated = validateRunId(required(runId, '--run-id'));
  return {
    runId: validated,
    lookup: {
      mode: 'run-id',
      latest: false,
      selected_at: null,
      skipped_invalid: 0,
    },
  };
}

async function findLatestConsensusRun(repoRoot) {
  const root = consensusRoot(repoRoot);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error('status --latest requires at least one consensus run; no consensus run artifacts found');
    }
    throw error;
  }

  let selected = null;
  let skippedInvalid = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !RUN_ID_RE.test(entry.name)) continue;
    try {
      const manifest = await readJson(manifestFile(repoRoot, entry.name));
      if (manifest.run_id !== entry.name) {
        skippedInvalid += 1;
        continue;
      }
      const timestampMs = consensusTimestampMs(manifest, entry.name);
      if (timestampMs === null) {
        skippedInvalid += 1;
        continue;
      }
      if (!selected || timestampMs > selected.timestampMs) {
        selected = {
          runId: entry.name,
          timestampMs,
          selectedAt: new Date(timestampMs).toISOString(),
        };
      }
    } catch {
      skippedInvalid += 1;
    }
  }

  if (!selected) {
    throw new Error('status --latest found no readable consensus manifest artifacts');
  }
  return {
    runId: selected.runId,
    lookup: {
      mode: 'latest',
      latest: true,
      selected_at: selected.selectedAt,
      skipped_invalid: skippedInvalid,
    },
  };
}

async function resolveTask(options) {
  if (options.task && options.taskFile) {
    throw new Error('Use either --task or --task-file, not both');
  }
  if (options.task) {
    return options.task;
  }
  if (options.taskFile) {
    const text = await readFile(resolve(options.taskFile), 'utf8');
    if (!text.trim()) throw new Error('--task-file must not be empty');
    return text;
  }
  throw new Error('plan requires --task or --task-file');
}

async function resolveSummary(options, runId) {
  if (options.summary && options.summaryFile) {
    throw new Error('Use either --summary or --summary-file, not both');
  }
  if (options.summary) {
    if (!options.summary.trim()) throw new Error('--summary must not be empty');
    return options.summary;
  }
  if (options.summaryFile) {
    const text = await readFile(resolve(options.summaryFile), 'utf8');
    if (!text.trim()) throw new Error('--summary-file must not be empty');
    return text;
  }
  throw new Error(`synthesize requires --summary or --summary-file; write a bounded summary from artifact pointers, then retry: runtime:consensus synthesize --run-id ${runId} --summary-file <summary.md> [--disagreements-file <disagreements.md>]`);
}

async function resolveDisagreements(options) {
  if (!options.disagreementsFile) return [];
  const text = await readFile(resolve(options.disagreementsFile), 'utf8');
  return parseDisagreements(text);
}

async function resolveNextRoundDisagreements(options, repoRoot, manifest) {
  if (options.disagreementsFile) {
    return parseDisagreements(await readFile(resolve(options.disagreementsFile), 'utf8'));
  }
  if (!manifest.consensus_pointer) {
    throw new Error(`next-round requires consensus.json or --disagreements-file; run runtime:consensus synthesize --run-id ${manifest.run_id} --summary-file <summary.md> [--disagreements-file <disagreements.md>] first. No next-round prompt was written and no peers were executed`);
  }
  const result = await readJson(resolve(repoRoot, manifest.consensus_pointer));
  return result.durable_disagreements ?? [];
}

function parseDisagreements(text) {
  const trimmed = text.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new Error('JSON disagreements must be an array');
    }
    return parsed.map(normalizeDisagreement);
  } catch (error) {
    if (error.message === 'JSON disagreements must be an array') throw error;
    return trimmed
      .split(/\r?\n/)
      .map((line) => line.trim().replace(/^[-*]\s+/, ''))
      .filter(Boolean)
      .map((summary) => ({ summary, status: 'durable' }));
  }
}

function normalizeDisagreement(value) {
  if (typeof value === 'string') {
    return { summary: value, status: 'durable' };
  }
  if (!value || typeof value !== 'object') {
    throw new Error('Disagreements must be strings or objects');
  }
  if (!value.summary || typeof value.summary !== 'string') {
    throw new Error('Disagreement objects require a string summary');
  }
  return {
    summary: value.summary,
    status: value.status ?? 'durable',
    owner_decision: value.owner_decision ?? null,
    evidence_pointers: Array.isArray(value.evidence_pointers) ? value.evidence_pointers : [],
  };
}

function buildFanoutPrompt({ runId, peer, task, policy, lane }) {
  return `# Runtime Consensus Fanout

Run id: ${runId}
Peer: ${peer}
Lane: ${lane?.lane ?? 'unknown'}

Task:
${task.trim()}

Respond with concise independent analysis. Include:

- recommendation or conclusion
- key evidence pointers
- assumptions
- risks or ambiguity
- likely disagreement points

Budget policy:

- max_rounds: ${policy.max_rounds}
- token_budget: ${policy.token_budget ?? 'unspecified'}
- time_budget_ms: ${policy.time_budget_ms ?? 'unspecified'}
- process_budget: ${policy.process_budget}

Lane action:

${lane?.operator_action ?? 'Follow the consensus report lane instructions.'}

Do not assume host parity. Note host-specific limits explicitly.`;
}

function buildRebuttalPrompt({ runId, peer, disagreements, round, lane }) {
  const body = disagreements.length
    ? disagreements.map((item, index) => `${index + 1}. ${item.summary ?? item}`).join('\n')
    : 'No durable disagreements were provided.';
  return `# Runtime Consensus Targeted Rebuttal

Run id: ${runId}
Peer: ${peer}
Round: ${round}
Lane: ${lane?.lane ?? 'unknown'}

Review only these synthesized disagreement summaries:

${body}

Lane action:

${lane?.operator_action ?? 'Follow the consensus report lane instructions.'}

Respond with resolution evidence, remaining disagreement, and owner decision points. Do not quote or depend on raw peer output unless you have a direct artifact pointer.`;
}

function collectEvidencePointers(manifest) {
  const evidence = [];
  for (const round of manifest.rounds ?? []) {
    for (const prompt of round.prompts ?? []) {
      evidence.push({ kind: 'peer-prompt', round: round.round, peer: prompt.peer, pointer: prompt.pointer });
    }
    for (const output of round.raw_outputs ?? []) {
      evidence.push({
        kind: 'peer-output',
        round: round.round,
        peer: output.peer,
        pointer: output.pointer,
        bytes: output.bytes,
        sha256: output.sha256,
      });
    }
  }
  return evidence;
}

function executablePeersFor(manifest) {
  return Array.isArray(manifest.peers?.executable)
    ? manifest.peers.executable
    : (manifest.peers?.active ?? []).filter(isCompanionPeer);
}

function manualPeersFor(manifest) {
  return Array.isArray(manifest.peers?.manual)
    ? manifest.peers.manual
    : (manifest.peers?.active ?? []).filter((peer) => !isCompanionPeer(peer));
}

function missingOutputPeers(round, peers) {
  const recorded = new Set((round.raw_outputs ?? []).map((entry) => entry.peer));
  return peers.filter((peer) => !recorded.has(peer));
}

function isCompanionPeer(peer) {
  return Object.hasOwn(PEER_DIRECTIONS, peer);
}

function compact(values) {
  return values.filter(Boolean);
}

function normalizePeers(value) {
  const peers = Array.isArray(value) ? value : String(value).split(',');
  const normalized = peers.map((peer) => validatePeerId(peer.trim())).filter(Boolean);
  if (normalized.length === 0) throw new Error('--peers must include at least one peer');
  return [...new Set(normalized)];
}

function validatePeerId(peer) {
  if (!peer || !PEER_ID_RE.test(peer)) {
    throw new Error('Peer ids may contain only letters, numbers, dot, underscore, and hyphen');
  }
  return peer;
}

function validateRunId(runId) {
  if (!RUN_ID_RE.test(runId)) {
    throw new Error('Invalid --run-id; expected consensus-YYYYMMDDTHHMMSSZ-abcdef');
  }
  return runId;
}

function positiveInt(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return number;
}

function boundedPositiveInt(value, label, max) {
  const number = positiveInt(value, label);
  if (number > max) {
    throw new Error(`${label} must be <= ${max}`);
  }
  return number;
}

function optionalPositiveInt(value, label) {
  if (value === undefined || value === null || value === '') return null;
  return positiveInt(value, label);
}

function requireValue(args, flag) {
  if (args.length === 0 || args[0].startsWith('-')) {
    throw new Error(`${flag} requires a value`);
  }
  return args.shift();
}

function requireSingleLine(value, flag) {
  if (/[\r\n]/.test(value)) {
    throw new Error(`${flag} must be a single-line value`);
  }
  return value;
}

function required(value, flag) {
  if (value === undefined || value === null || value === '') {
    throw new Error(`${flag} is required`);
  }
  return value;
}

function latestRoundNumber(manifest) {
  return Math.max(...manifest.rounds.map((round) => round.round));
}

function findRound(manifest, roundNumber) {
  const round = manifest.rounds.find((candidate) => candidate.round === roundNumber);
  if (!round) throw new Error(`Round ${roundNumber} does not exist`);
  return round;
}

function hasAllOutputs(round, activePeers) {
  const recorded = new Set(round.raw_outputs.map((entry) => entry.peer));
  return activePeers.every((peer) => recorded.has(peer));
}

function makeRunId(now) {
  const stamp = toIso(now).replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `consensus-${stamp}-${randomBytes(3).toString('hex')}`;
}

function toIso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function consensusTimestampMs(manifest, fallbackRunId) {
  for (const value of [manifest.updated_at, manifest.created_at]) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return consensusRunIdTimestampMs(fallbackRunId);
}

function consensusRunIdTimestampMs(runId) {
  const match = String(runId ?? '').match(/^consensus-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-[0-9a-f]{6}$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const parsed = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

function consensusRoot(repoRoot) {
  return resolve(repoRoot, '.agentic-plugins', 'runs', 'consensus');
}

function consensusRunDir(repoRoot, runId) {
  return resolve(consensusRoot(repoRoot), validateRunId(runId));
}

function manifestFile(repoRoot, runId) {
  return resolve(consensusRunDir(repoRoot, runId), 'manifest.json');
}

function pointer(repoRoot, path) {
  const rel = relative(repoRoot, path).split(sep).join('/');
  return rel || basename(path);
}

async function assertInside(root, candidate) {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  const rel = relative(rootPath, candidatePath);
  if (rel.startsWith('..') || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`Artifact path escapes consensus root: ${candidatePath}`);
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function readJsonIfExists(path) {
  try {
    return await readJson(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sanitizeValue(value) {
  if (value === null || value === undefined) return null;
  return String(value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<redacted-email>')
    .replace(/\b(?:ghp|github_pat|xox[baprs])_[A-Za-z0-9_=-]{12,}\b/g, '<redacted-token>')
    .replace(/\b(?:sk|sk-proj|sk-ant)-[A-Za-z0-9_-]{12,}\b/g, '<redacted-token>')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '<redacted-aws-key>')
    .replace(/\b[0-9a-f]{32,}\b/gi, '<redacted-hex>');
}

function executionLimits() {
  return [
    'Execution requires runtime:consensus execute plus --execute; plan, synthesize, next-round, and status do not execute peers.',
    'Companions are invoked through companions/contract.md only; runtime does not shell out to peer CLIs ad hoc.',
    'Raw peer stdout is written under .agentic-plugins/runs/consensus/<run-id>/ and omitted from main output.',
    'Main output exposes only pointers, byte counts, hashes, status, failure class, and retryability.',
    'No host-native config, auth, secrets, sandbox, permission policy, or host session context is mutated.',
    'No automatic unbounded loop is allowed; max_rounds, max_peers, process_budget, and timeout caps bound execution.',
  ];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(helpText());
    return;
  }
  const report = await runConsensus(options);
  if (options.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatText(report));
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`runtime:consensus: ${error.message}`);
    process.exitCode = 1;
  });
}
