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
const OWNER_DECISION_SCHEMA = 'runtime-consensus-owner-decision-1.0';
const CANCELLATION_SCHEMA = 'runtime-consensus-cancellation-1.0';
const EXECUTION_SCHEMA = 'runtime-consensus-execution-1.0';
const LATEST_EXECUTION_SCHEMA = 'runtime-consensus-execution-latest-1.0';
const PROGRESS_SCHEMA = 'runtime-consensus-progress-1.0';
const VALID_COMMANDS = new Set(['plan', 'record', 'synthesize', 'decide', 'cancel', 'next-round', 'execute', 'status']);
const VALID_CONVERGENCE_STATES = new Set([
  'aligned',
  'complementary',
  'contradiction',
  'insufficient-evidence',
  'owner-decision-required',
  'non-consensus',
]);
const VALID_DISAGREEMENT_KINDS = new Set([
  'complementary',
  'contradiction',
  'insufficient-evidence',
  'non-consensus',
]);
const DEFAULT_PEERS = ['claude', 'codex'];
const DEFAULT_MAX_ROUNDS = 2;
const MAX_ROUNDS_CAP = 3;
const DEFAULT_EXECUTION_TIMEOUT_MS = 120000;
const MAX_EXECUTION_TIMEOUT_MS = 600000;
const RESULT_QUALITY_OBJECTIVE = 'best-results-over-token-minimization';
const TERMINAL_MANIFEST_STATUSES = new Set(['cancelled', 'converged', 'owner-decided']);
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
  if (command === 'decide') {
    return decideConsensus({ ...options, repoRoot });
  }
  if (command === 'cancel') {
    return cancelConsensus({ ...options, repoRoot });
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
    quality_policy: buildQualityPolicy({
      maxPeersConstrained: options.maxPeers !== undefined,
      tokenBudgetConstrained: options.tokenBudget !== undefined,
      timeBudgetConstrained: options.timeBudgetMs !== undefined,
    }),
    max_rounds: maxRounds,
    round_policy: buildRoundPolicy(maxRounds),
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
      cancellation: 'runtime:consensus cancel records an operator-confirmed cancellation artifact; it does not kill host processes',
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
      `Consensus rebuttal defaults to ${DEFAULT_MAX_ROUNDS} total rounds, hard-caps at ${MAX_ROUNDS_CAP}, and moves to owner-decision-required after the configured round budget is exhausted.`,
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
  const convergenceState = classifyConvergenceState({ options, durableDisagreements, manifest });
  const contradictions = await resolveContradictions(options, durableDisagreements, convergenceState);
  validateConvergenceResult({ convergenceState, durableDisagreements, contradictions });
  const nextRound = buildNextRoundAvailability({ manifest, durableDisagreements, runId, convergenceState });
  const result = {
    schema_version: RESULT_SCHEMA,
    run_id: runId,
    status: statusForConvergence(convergenceState),
    convergence_state: convergenceState,
    created_at: toIso(now),
    synthesized_summary: summary.trim(),
    durable_disagreements: durableDisagreements,
    contradictions,
    evidence_pointers: evidencePointers,
    next_round: nextRound,
    next_action: options.nextAction ?? defaultNextActionForConvergence({ convergenceState, nextRound }),
    limits: [
      'Peer raw outputs remain in artifact files.',
      'This result is intentionally limited to synthesis, durable disagreements, and evidence pointers.',
      'The synthesis must not average incompatible recommendations; it must converge on evidence, request owner decision, or preserve non-consensus.',
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
    convergence_state: result.convergence_state,
    synthesized_summary: result.synthesized_summary,
    durable_disagreements: result.durable_disagreements,
    contradictions: result.contradictions,
    evidence_pointers: result.evidence_pointers,
    next_round: result.next_round,
    consensus_pointer: manifest.consensus_pointer,
    next_action: result.next_action,
    limits: result.limits,
  };
}

export async function decideConsensus(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const runId = validateRunId(required(options.runId, '--run-id'));
  const now = options.now ?? new Date();
  const manifestPath = manifestFile(repoRoot, runId);
  const manifest = await readJson(manifestPath);
  if (!manifest.consensus_pointer) {
    throw new Error(`decide requires consensus.json; run runtime:consensus synthesize --run-id ${runId} --summary-file <summary.md> first`);
  }
  const consensusArtifact = await readJson(resolve(repoRoot, manifest.consensus_pointer));
  const convergenceState = convergenceStateFromArtifact(consensusArtifact);
  if (['aligned', 'complementary'].includes(convergenceState)) {
    throw new Error(`decide requires unresolved consensus; observed convergence_state=${convergenceState}`);
  }
  const decision = await resolveDecision(options, runId);
  const decisionText = `${decision.trim()}\n`;
  const decisionBuffer = Buffer.from(decisionText, 'utf8');
  const runDir = consensusRunDir(repoRoot, runId);
  const decisionPath = resolve(runDir, 'owner-decision.md');
  await assertInside(runDir, decisionPath);
  await writeFile(decisionPath, decisionBuffer);

  const decidedBy = options.decidedBy
    ? requireSingleLine(options.decidedBy, '--decided-by')
    : 'owner';
  const decisionPointer = pointer(repoRoot, decisionPath);
  const ownerDecision = {
    schema_version: OWNER_DECISION_SCHEMA,
    runtime_version: VERSION,
    run_id: runId,
    status: 'owner-decided',
    created_at: toIso(now),
    decided_by: decidedBy,
    previous_consensus_pointer: manifest.consensus_pointer,
    previous_convergence_state: convergenceState,
    decision_pointer: decisionPointer,
    decision_bytes: decisionBuffer.byteLength,
    decision_sha256: sha256(decisionBuffer),
    durable_disagreement_count: (consensusArtifact.durable_disagreements ?? []).length,
    contradiction_count: (consensusArtifact.contradictions ?? []).length,
    evidence_pointers: consensusArtifact.evidence_pointers ?? [],
    next_action: options.nextAction
      ? requireSingleLine(options.nextAction, '--next-action')
      : 'Proceed with the recorded owner decision while preserving the consensus evidence pointers.',
    limits: [
      'Owner decision text is stored as an artifact pointer and is not printed by status or footer output.',
      'Recording an owner decision does not execute peers, relax host policy, mutate host session context, or create another rebuttal round.',
      'The previous consensus artifact and evidence pointers remain the audit trail for the decision.',
    ],
  };
  const ownerDecisionPath = resolve(runDir, 'owner-decision.json');
  await assertInside(runDir, ownerDecisionPath);
  await writeJson(ownerDecisionPath, ownerDecision);
  manifest.owner_decision_pointer = pointer(repoRoot, ownerDecisionPath);
  manifest.status = 'owner-decided';
  manifest.updated_at = toIso(now);
  await writeJson(manifestPath, manifest);

  return {
    command: 'decide',
    version: VERSION,
    run_id: runId,
    status: manifest.status,
    previous_convergence_state: convergenceState,
    owner_decision_pointer: manifest.owner_decision_pointer,
    decision_pointer: decisionPointer,
    decision_bytes: ownerDecision.decision_bytes,
    decision_sha256: ownerDecision.decision_sha256,
    decided_by: decidedBy,
    durable_disagreement_count: ownerDecision.durable_disagreement_count,
    contradiction_count: ownerDecision.contradiction_count,
    next_action: ownerDecision.next_action,
    artifacts: [
      { kind: 'manifest', pointer: pointer(repoRoot, manifestPath) },
      { kind: 'owner-decision', pointer: manifest.owner_decision_pointer },
      { kind: 'owner-decision-text', pointer: decisionPointer, bytes: ownerDecision.decision_bytes, sha256: ownerDecision.decision_sha256 },
    ],
    limits: ownerDecision.limits,
  };
}

export async function cancelConsensus(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const runId = validateRunId(required(options.runId, '--run-id'));
  const now = options.now ?? new Date();
  const cancelledAt = toIso(now);
  const manifestPath = manifestFile(repoRoot, runId);
  const manifest = await readJson(manifestPath);
  if (manifest.cancellation_pointer) {
    throw new Error(`cancel refused: consensus run already has cancellation artifact ${manifest.cancellation_pointer}`);
  }
  if (manifest.status === 'owner-decided') {
    throw new Error('cancel refused: consensus run already has an owner decision; preserve the owner-decision artifact instead');
  }
  const runDir = consensusRunDir(repoRoot, runId);
  const executionPath = resolve(runDir, 'execution.json');
  const progressPath = resolve(runDir, 'execution-progress.json');
  const executionArtifact = await readJsonIfExists(executionPath);
  const progressArtifact = await readJsonIfExists(progressPath);
  const progressRunning = !executionArtifact && progressArtifact?.status === 'running';
  if (progressRunning && options.confirmNoActiveProcess !== true) {
    throw new Error('cancel refused: execution progress is running; confirm no original execute process is still active with --confirm-no-active-process before recording cancellation');
  }

  const reason = await resolveCancellationReason(options, runId);
  const reasonText = `${reason.trim()}\n`;
  const reasonBuffer = Buffer.from(reasonText, 'utf8');
  const reasonPath = resolve(runDir, 'cancellation-reason.md');
  await assertInside(runDir, reasonPath);
  await writeFile(reasonPath, reasonBuffer);
  const reasonPointer = pointer(repoRoot, reasonPath);
  const cancellationPath = resolve(runDir, 'cancellation.json');
  await assertInside(runDir, cancellationPath);
  const cancellation = {
    schema_version: CANCELLATION_SCHEMA,
    runtime_version: VERSION,
    run_id: runId,
    status: 'cancelled',
    created_at: cancelledAt,
    cancelled_by: options.cancelledBy
      ? requireSingleLine(options.cancelledBy, '--cancelled-by')
      : 'operator',
    reason_pointer: reasonPointer,
    reason_bytes: reasonBuffer.byteLength,
    reason_sha256: sha256(reasonBuffer),
    previous_status: manifest.status ?? null,
    previous_consensus_pointer: manifest.consensus_pointer ?? null,
    previous_owner_decision_pointer: manifest.owner_decision_pointer ?? null,
    execution_pointer: executionArtifact ? pointer(repoRoot, executionPath) : null,
    progress_pointer: progressArtifact ? pointer(repoRoot, progressPath) : null,
    operator_confirmed_no_active_process: progressRunning ? true : Boolean(options.confirmNoActiveProcess),
    next_action: options.nextAction
      ? requireSingleLine(options.nextAction, '--next-action')
      : 'Preserve the cancelled consensus run as evidence; create a new consensus run before restarting peer collection.',
    limits: [
      'Cancellation is artifact-only and does not kill, interrupt, or signal host CLI processes.',
      'If execution progress was running, the operator must confirm no original execute process is still active before cancellation is recorded.',
      'Cancellation reason text is stored as an artifact pointer and is not printed by status or footer output.',
    ],
  };
  await writeJson(cancellationPath, cancellation);
  const cancellationPointer = pointer(repoRoot, cancellationPath);

  if (progressArtifact) {
    markProgressCancelled({
      progress: progressArtifact,
      cancelledAt,
      cancellationPointer,
      confirmNoActiveProcess: cancellation.operator_confirmed_no_active_process,
    });
    await writeJson(progressPath, progressArtifact);
  }
  const latestRound = findRound(manifest, latestRoundNumber(manifest));
  latestRound.status = 'cancelled';
  manifest.cancellation_pointer = cancellationPointer;
  manifest.status = 'cancelled';
  manifest.updated_at = cancelledAt;
  await writeJson(manifestPath, manifest);

  return {
    command: 'cancel',
    version: VERSION,
    run_id: runId,
    status: manifest.status,
    cancellation_pointer: cancellationPointer,
    reason_pointer: reasonPointer,
    reason_bytes: cancellation.reason_bytes,
    reason_sha256: cancellation.reason_sha256,
    cancelled_by: cancellation.cancelled_by,
    previous_status: cancellation.previous_status,
    operator_confirmed_no_active_process: cancellation.operator_confirmed_no_active_process,
    next_action: cancellation.next_action,
    artifacts: [
      { kind: 'manifest', pointer: pointer(repoRoot, manifestPath) },
      { kind: 'consensus-cancellation', pointer: cancellationPointer },
      { kind: 'consensus-cancellation-reason', pointer: reasonPointer, bytes: cancellation.reason_bytes, sha256: cancellation.reason_sha256 },
      cancellation.execution_pointer ? { kind: 'consensus-execution', pointer: cancellation.execution_pointer } : null,
      cancellation.progress_pointer ? { kind: 'consensus-progress', pointer: cancellation.progress_pointer } : null,
    ].filter(Boolean),
    limits: cancellation.limits,
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
  const { disagreements, convergenceState } = await resolveNextRoundInput(options, repoRoot, manifest);
  if (disagreements.length === 0) {
    throw new Error(`next-round requires at least one durable disagreement; no next-round prompt was written and no peers were executed`);
  }
  if (convergenceState !== 'contradiction') {
    throw new Error(`next-round requires convergence_state=contradiction or an explicit --disagreements-file; observed ${convergenceState}. No next-round prompt was written and no peers were executed`);
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
  const promptPointersByPeer = Object.fromEntries(
    (round.prompts ?? []).map((prompt) => [prompt.peer, prompt.pointer]),
  );
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
    promptPointersByPeer,
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
      promptPointer: promptPointersByPeer[peer] ?? null,
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
  const executionPointer = pointer(repoRoot, executionPath);
  const executionStatus = executionSummary.failed > 0
    ? executionSummary.operator_action_required === executionSummary.failed
      ? 'operator_action_required'
      : 'failed'
    : executionSummary.executed > 0 ? 'passed' : 'skipped';
  progress.status = executionStatus;
  progress.summary = executionSummary;
  progress.updated_at = toIso(new Date());
  await writeExecutionProgress(repoRoot, progressPath, progress);
  const executionRemediation = buildExecutionRemediation({
    runId,
    roundNumber,
    summary: executionSummary,
    executions,
    executionPointer,
    progressPointer,
  });
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
    execution_remediation: executionRemediation,
    executions,
    failures: executions
      .filter((execution) => execution.status !== 'passed')
      .map((execution) => ({
        peer: execution.peer,
        status: execution.status,
        prompt_pointer: execution.prompt_pointer,
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
    execution_pointer: executionPointer,
    progress_pointer: progressPointer,
    summary: executionSummary,
    remediation: executionRemediation,
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
    execution_pointer: executionPointer,
    progress_pointer: progressPointer,
    execution_boundary: executionArtifact.execution_boundary,
    execution_summary: executionSummary,
    execution_remediation: executionRemediation,
    executions,
    artifacts: [
      { kind: 'manifest', pointer: pointer(repoRoot, manifestPath) },
      { kind: 'consensus-execution', pointer: executionPointer },
      { kind: 'consensus-progress', pointer: progressPointer },
      ...executions
        .filter((execution) => execution.prompt_pointer)
        .map((execution) => ({ kind: 'peer-prompt', round: roundNumber, peer: execution.peer, pointer: execution.prompt_pointer })),
      ...executions.map((execution) => ({ kind: 'peer-output', round: roundNumber, peer: execution.peer, ...execution.raw_output })),
      ...executions.map((execution) => ({ kind: 'peer-execution', round: roundNumber, peer: execution.peer, pointer: execution.execution_pointer })),
    ],
    limits: executionArtifact.limits,
  };
}

export async function readStatus(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const now = options.now ?? new Date();
  const selection = await resolveStatusRunSelection({
    repoRoot,
    runId: options.runId,
    latest: options.latest,
    latestOpen: options.latestOpen,
  });
  const runId = selection.runId;
  const manifestPath = manifestFile(repoRoot, runId);
  const manifest = await readJson(manifestPath);
  const runDir = consensusRunDir(repoRoot, runId);
  const executionPath = resolve(runDir, 'execution.json');
  const progressPath = resolve(runDir, 'execution-progress.json');
  const executionArtifact = await readJsonIfExists(executionPath);
  const progressArtifact = await readJsonIfExists(progressPath);
  const executionPointer = executionArtifact ? pointer(repoRoot, executionPath) : null;
  const progressPointer = progressArtifact ? pointer(repoRoot, progressPath) : null;
  const consensusArtifact = manifest.consensus_pointer
    ? await readJsonIfExists(resolve(repoRoot, manifest.consensus_pointer))
    : null;
  const ownerDecisionArtifact = manifest.owner_decision_pointer
    ? await readJsonIfExists(resolve(repoRoot, manifest.owner_decision_pointer))
    : null;
  const cancellationArtifact = manifest.cancellation_pointer
    ? await readJsonIfExists(resolve(repoRoot, manifest.cancellation_pointer))
    : null;
  const evidencePointers = collectEvidencePointers(manifest);
  const latestRound = findRound(manifest, latestRoundNumber(manifest));
  const roundOutputSummary = summarizeRoundOutputs({ round: latestRound, activePeers: manifest.peers.active });
  const statusGuidance = buildStatusGuidance({
    runId,
    manifest,
    executionArtifact,
    progressArtifact,
    consensusArtifact,
    ownerDecisionArtifact,
    cancellationArtifact,
    now,
  });
  return {
    command: 'status',
    version: VERSION,
    run_id: runId,
    lookup: selection.lookup,
    status: manifest.status,
    convergence_state: consensusArtifact ? convergenceStateFromArtifact(consensusArtifact) : null,
    run_pointer: pointer(repoRoot, consensusRunDir(repoRoot, runId)),
    manifest_pointer: pointer(repoRoot, manifestPath),
    consensus_pointer: manifest.consensus_pointer,
    owner_decision_pointer: manifest.owner_decision_pointer ?? null,
    cancellation_pointer: manifest.cancellation_pointer ?? null,
    owner_decision: ownerDecisionArtifact ? {
      status: ownerDecisionArtifact.status,
      decided_by: ownerDecisionArtifact.decided_by,
      created_at: ownerDecisionArtifact.created_at,
      previous_convergence_state: ownerDecisionArtifact.previous_convergence_state,
      decision_pointer: ownerDecisionArtifact.decision_pointer,
      decision_bytes: ownerDecisionArtifact.decision_bytes,
      decision_sha256: ownerDecisionArtifact.decision_sha256,
      next_action: ownerDecisionArtifact.next_action,
    } : null,
    cancellation: cancellationArtifact ? {
      status: cancellationArtifact.status,
      cancelled_by: cancellationArtifact.cancelled_by,
      created_at: cancellationArtifact.created_at,
      previous_status: cancellationArtifact.previous_status,
      reason_pointer: cancellationArtifact.reason_pointer,
      reason_bytes: cancellationArtifact.reason_bytes,
      reason_sha256: cancellationArtifact.reason_sha256,
      operator_confirmed_no_active_process: cancellationArtifact.operator_confirmed_no_active_process === true,
      next_action: cancellationArtifact.next_action,
    } : null,
    execution_pointer: executionPointer,
    progress_pointer: progressPointer,
    execution_summary: executionArtifact?.summary ?? progressArtifact?.summary ?? null,
    round_output_summary: roundOutputSummary,
    execution_remediation: resolveExecutionRemediation({
      runId,
      executionArtifact,
      progressArtifact,
      executionPointer,
      progressPointer,
    }),
    rounds: manifest.rounds.map((round) => ({
      round: round.round,
      kind: round.kind,
      status: round.status,
      prompt_count: round.prompts.length,
      raw_output_count: round.raw_outputs.length,
      output_summary: summarizeRoundOutputs({ round, activePeers: manifest.peers.active }),
    })),
    peer_lanes: peerLanesFor(manifest, runId),
    durable_disagreements: consensusArtifact?.durable_disagreements ?? [],
    contradictions: consensusArtifact?.contradictions ?? [],
    evidence_pointers: evidencePointers,
    status_guidance: statusGuidance,
    next_action: statusGuidance.next_action,
    next_steps: statusGuidance.next_steps,
    limits: manifest.limits,
  };
}

function summarizeRoundOutputs({ round, activePeers }) {
  const outputs = Array.isArray(round?.raw_outputs) ? round.raw_outputs : [];
  const byPeer = new Map(outputs.map((entry) => [entry.peer, entry]));
  const active = Array.isArray(activePeers) ? activePeers : [];
  const recordedPeers = active.filter((peer) => byPeer.has(peer));
  const missingPeers = active.filter((peer) => !byPeer.has(peer));
  const passedExecutionPeers = recordedPeers.filter((peer) => byPeer.get(peer)?.status === 'passed');
  const failedExecutionPeers = recordedPeers.filter((peer) => {
    const status = byPeer.get(peer)?.status;
    return Boolean(status) && status !== 'passed';
  });
  const manualRecordedPeers = recordedPeers.filter((peer) => !byPeer.get(peer)?.status);
  return {
    round: round?.round ?? null,
    active_peers: active.length,
    recorded: recordedPeers.length,
    complete: missingPeers.length === 0 && failedExecutionPeers.length === 0,
    passed_execution: passedExecutionPeers.length,
    manual_recorded: manualRecordedPeers.length,
    failed_execution: failedExecutionPeers.length,
    missing: missingPeers.length,
    recorded_peers: recordedPeers,
    missing_peers: missingPeers,
    failed_execution_peers: failedExecutionPeers,
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
      promptPointer: null,
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
  const prompt = round.prompts.find((entry) => entry.peer === peer);
  const promptPointer = prompt?.pointer ?? null;
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
      companionPath: null,
      promptPointer,
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
      promptPointer,
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
    promptPointer,
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

async function writeSkippedExecution({ repoRoot, runId, roundNumber, peer, reason, promptPointer, now }) {
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
    promptPointer,
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

async function writeFailedExecution({ repoRoot, runId, roundNumber, peer, now, failure, companionPath, promptPointer, raw, execution }) {
  return writeExecutionResult({
    repoRoot,
    runId,
    roundNumber,
    peer,
    now,
    companionPath,
    promptPointer,
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
  promptPointer,
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
    prompt_pointer: promptPointer ?? null,
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
  promptPointersByPeer = {},
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
      prompt_pointer: promptPointersByPeer[peer] ?? null,
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
  entry.prompt_pointer = execution.prompt_pointer ?? entry.prompt_pointer ?? null;
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

function markProgressCancelled({
  progress,
  cancelledAt,
  cancellationPointer,
  confirmNoActiveProcess,
}) {
  progress.status = 'cancelled';
  progress.cancelled_at = cancelledAt;
  progress.cancellation_pointer = cancellationPointer;
  progress.operator_confirmed_no_active_process = confirmNoActiveProcess === true;
  let cancelled = 0;
  for (const peer of Object.values(progress.peers ?? {})) {
    if (['running', 'pending'].includes(peer.status)) {
      peer.status = 'cancelled';
      peer.completed_at = cancelledAt;
      peer.failure_type = 'operator_cancelled';
      peer.operator_action_required = false;
      peer.retryable = false;
      peer.retry_after = 'create a new consensus run before restarting peer collection';
      peer.retry_command = null;
      cancelled += 1;
    }
  }
  const previousSummary = progress.summary ?? {};
  progress.summary = {
    executed: previousSummary.executed ?? 0,
    passed: previousSummary.passed ?? 0,
    failed: previousSummary.failed ?? 0,
    skipped: previousSummary.skipped ?? 0,
    failed_retryable: previousSummary.failed_retryable ?? 0,
    failed_non_retryable: previousSummary.failed_non_retryable ?? 0,
    operator_action_required: previousSummary.operator_action_required ?? 0,
    cancelled: (previousSummary.cancelled ?? 0) + cancelled,
  };
  progress.updated_at = cancelledAt;
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

function resolveExecutionRemediation({
  runId,
  executionArtifact,
  progressArtifact,
  executionPointer,
  progressPointer,
}) {
  if (executionArtifact?.execution_remediation) {
    return executionArtifact.execution_remediation;
  }
  const summary = executionArtifact?.summary ?? progressArtifact?.summary ?? null;
  if (!summary) return null;
  const executions = executionArtifact?.executions ?? Object.values(progressArtifact?.peers ?? {});
  return buildExecutionRemediation({
    runId,
    roundNumber: executionArtifact?.round ?? progressArtifact?.round ?? latestRoundFromExecutions(executions),
    summary,
    executions,
    executionPointer,
    progressPointer,
  });
}

function buildExecutionRemediation({
  runId,
  roundNumber,
  summary,
  executions,
  executionPointer,
  progressPointer,
}) {
  const failedExecutions = executions.filter((execution) => execution.status !== 'passed');
  const retryCommands = unique(failedExecutions
    .filter((execution) => execution.retryable && execution.retry_command)
    .map((execution) => execution.retry_command));
  const failureTypes = {};
  for (const execution of failedExecutions) {
    const type = execution.failure_type ?? execution.status ?? 'unknown';
    failureTypes[type] = (failureTypes[type] ?? 0) + 1;
  }
  const proofCommands = buildProofCommands(failureTypes, summary);
  const status = remediationStatus({ summary, retryCommands });
  const peerActions = failedExecutions.map((execution) => ({
    peer: execution.peer,
    status: execution.status,
    failure_type: execution.failure_type ?? null,
    retryable: execution.retryable === true,
    operator_action_required: execution.operator_action_required === true,
    retry_after: execution.retry_after ?? null,
    retry_command: execution.retry_command ?? null,
    suggested_timeout_ms: suggestedTimeoutMs(execution),
    raw_output: execution.raw_output ?? null,
    execution_pointer: execution.execution_pointer ?? null,
  }));

  return {
    status,
    next_action: remediationNextAction(status),
    run_id: runId,
    round: roundNumber ?? null,
    failure_types: failureTypes,
    retry_commands: retryCommands,
    proof_commands: proofCommands,
    peer_actions: peerActions,
    artifacts: {
      execution: executionPointer,
      progress: progressPointer,
      peer_executions: peerActions
        .map((action) => action.execution_pointer)
        .filter(Boolean),
    },
    limits: [
      'Remediation is advisory and bounded; it does not auto-retry peers.',
      'Runtime does not relax host auth, sandbox, approval, permission, network, or session state.',
      'Raw peer stdout remains only in raw_output pointers.',
    ],
  };
}

function remediationStatus({ summary, retryCommands }) {
  if (summary?.operator_action_required > 0) return 'operator_action_required';
  if (summary?.failed_retryable > 0 || retryCommands.length > 0) return 'retryable_failure';
  if (summary?.failed_non_retryable > 0) return 'inspect_failure';
  if (summary?.skipped > 0) return 'skipped_peers';
  return 'none';
}

function remediationNextAction(status) {
  switch (status) {
    case 'operator_action_required':
      return 'Resolve host auth, sandbox, approval, or permission preconditions outside runtime before retrying selected peers.';
    case 'retryable_failure':
      return 'Retry only retryable peers with the listed commands; run proof commands first when startup latency or host readiness is unclear.';
    case 'inspect_failure':
      return 'Inspect sanitized execution artifacts and resolve non-retryable peer failures before continuing consensus.';
    case 'skipped_peers':
      return 'Run the skipped peer commands explicitly or synthesize from intentionally partial evidence.';
    default:
      return 'No execution remediation is required.';
  }
}

function buildProofCommands(failureTypes, summary) {
  const commands = [];
  if (failureTypes.timeout || summary?.failed_retryable > 0) {
    commands.push('runtime:doctor --deep-peer-smoke --execute-deep-peer-smoke');
  }
  if (
    failureTypes.auth_required
    || failureTypes.permission_required
    || failureTypes.sandbox_blocked
    || summary?.operator_action_required > 0
  ) {
    commands.push('runtime:doctor --permission-proof --execute-permission-proof');
  }
  return unique(commands);
}

function suggestedTimeoutMs(execution) {
  if (execution.failure_type !== 'timeout') return null;
  const timeoutMs = Number(execution.timeout_ms);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) return DEFAULT_EXECUTION_TIMEOUT_MS;
  return Math.min(MAX_EXECUTION_TIMEOUT_MS, Math.max(DEFAULT_EXECUTION_TIMEOUT_MS, Math.ceil(timeoutMs * 2)));
}

function latestRoundFromExecutions(executions) {
  const rounds = executions
    .map((execution) => Number(execution.round))
    .filter((round) => Number.isInteger(round) && round > 0);
  return rounds.length ? Math.max(...rounds) : null;
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

function buildNextRoundAvailability({ manifest, durableDisagreements, runId, convergenceState = null }) {
  const latestRound = latestRoundNumber(manifest);
  const hasDisagreements = durableDisagreements.length > 0;
  const contradiction = convergenceState === 'contradiction';
  const budgetRemaining = latestRound < manifest.policy.max_rounds;
  const hasExecutablePeers = executablePeersFor(manifest).length > 0;
  return {
    available: contradiction && hasDisagreements && budgetRemaining,
    reason: convergenceState === 'owner-decision-required'
      ? `max_rounds ${manifest.policy.max_rounds} exhausted; owner decision is required`
      : !contradiction
      ? `convergence_state ${convergenceState ?? '<unknown>'} does not require a rebuttal round`
      : !hasDisagreements
      ? 'no durable disagreements were synthesized'
      : budgetRemaining
        ? 'durable disagreements remain and max_rounds budget is available'
        : `max_rounds ${manifest.policy.max_rounds} exhausted`,
    current_round: latestRound,
    max_rounds: manifest.policy.max_rounds,
    command: contradiction && hasDisagreements && budgetRemaining ? `runtime:consensus next-round --run-id ${runId}` : null,
    execute_command: contradiction && hasDisagreements && budgetRemaining && hasExecutablePeers ? `runtime:consensus execute --run-id ${runId} --round ${latestRound + 1} --execute` : null,
  };
}

function classifyConvergenceState({ options, durableDisagreements, manifest }) {
  if (options.convergenceState) return validateConvergenceState(options.convergenceState);
  if (options.converged === true) return 'aligned';
  if (durableDisagreements.length === 0) return 'aligned';
  const kinds = durableDisagreements.map(disagreementKind).filter(Boolean);
  if (kinds.length > 0 && kinds.every((kind) => kind === 'complementary')) return 'complementary';
  if (kinds.length > 0 && kinds.every((kind) => kind === 'insufficient-evidence')) return 'insufficient-evidence';
  if (kinds.length > 0 && kinds.every((kind) => kind === 'non-consensus')) return 'non-consensus';
  if (latestRoundNumber(manifest) >= manifest.policy.max_rounds) return 'owner-decision-required';
  return 'contradiction';
}

function convergenceStateFromArtifact(consensusArtifact) {
  if (consensusArtifact.convergence_state) {
    return validateConvergenceState(consensusArtifact.convergence_state);
  }
  if (consensusArtifact.status === 'converged' || (consensusArtifact.durable_disagreements ?? []).length === 0) {
    return 'aligned';
  }
  return 'contradiction';
}

function disagreementKind(disagreement) {
  return disagreement?.kind ?? null;
}

function statusForConvergence(convergenceState) {
  return ['aligned', 'complementary'].includes(convergenceState)
    ? 'converged'
    : 'durable-disagreement';
}

function defaultNextActionForConvergence({ convergenceState, nextRound }) {
  if (convergenceState === 'aligned') return 'Proceed with the synthesized decision.';
  if (convergenceState === 'complementary') return 'Proceed with the synthesized decision while preserving the complementary perspectives as caveats.';
  if (convergenceState === 'contradiction') {
    return nextRound.available
      ? 'Plan the bounded rebuttal round before executing more peers.'
      : 'Direct contradictions remain but the bounded rebuttal budget is exhausted; ask the owner for a decision.';
  }
  if (convergenceState === 'insufficient-evidence') return 'Collect the missing evidence or ask the owner to choose the evidence standard before deciding.';
  if (convergenceState === 'owner-decision-required') return 'Ask the owner to decide between the preserved alternatives; do not run more rebuttal rounds without explicit approval.';
  return 'Preserve the non-consensus result with evidence and ask the owner whether to choose, defer, or narrow scope.';
}

function validateConvergenceResult({ convergenceState, durableDisagreements, contradictions }) {
  const unresolved = durableDisagreements.length + contradictions.length;
  if (convergenceState === 'aligned' && unresolved > 0) {
    throw new Error('convergence_state aligned cannot include durable disagreements or contradictions');
  }
  if (convergenceState === 'complementary' && contradictions.length > 0) {
    throw new Error('convergence_state complementary cannot include contradiction summaries');
  }
  if (['contradiction', 'insufficient-evidence', 'owner-decision-required', 'non-consensus'].includes(convergenceState) && unresolved === 0) {
    throw new Error(`convergence_state ${convergenceState} requires at least one durable disagreement or contradiction summary`);
  }
}

function buildPeerLanes({ runId, activePeers }) {
  return activePeers.map((peer) => {
    const companionDirection = PEER_DIRECTIONS[peer] ?? null;
    const lane = companionDirection ? 'companion_execute' : 'manual_subagent_record';
    return {
      peer,
      lane,
      role: peerLaneRole({ peer, lane }),
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

function buildQualityPolicy({ maxPeersConstrained, tokenBudgetConstrained, timeBudgetConstrained }) {
  return {
    objective: RESULT_QUALITY_OBJECTIVE,
    default_peer_breadth: maxPeersConstrained
      ? 'operator-constrained-max-peers'
      : 'all-requested-peers',
    default_companion_peers: DEFAULT_PEERS,
    model_effort_default: 'host-native-default-or-runtime-settings; consensus does not downshift model or effort for token saving',
    review_depth_default: 'independent peer fanout plus synthesized disagreements, with bounded contradiction rebuttal rounds',
    user_constraints: {
      max_peers: maxPeersConstrained ? 'explicit-operator-constraint' : 'not-constrained-by-default',
      token_budget: tokenBudgetConstrained ? 'explicit-operator-constraint' : 'not-constrained-by-default',
      time_budget_ms: timeBudgetConstrained ? 'explicit-operator-constraint' : 'not-constrained-by-default',
    },
  };
}

function peerLanesFor(manifest, runId) {
  if (Array.isArray(manifest.peers?.lanes) && manifest.peers.lanes.length > 0) {
    return manifest.peers.lanes.map((lane) => ({
      ...lane,
      role: lane.role ?? peerLaneRole({ peer: lane.peer, lane: lane.lane }),
      command_template: lane.command_template ?? laneCommandTemplate({ runId, peer: lane.peer, lane: lane.lane }),
    }));
  }
  return buildPeerLanes({ runId, activePeers: manifest.peers?.active ?? [] });
}

function peerLaneRole({ peer, lane }) {
  if (lane === 'companion_execute') {
    return `${peer}_companion_peer`;
  }
  return `${peer}_manual_subagent_peer`;
}

function laneCommandTemplate({ runId, peer, lane }) {
  if (lane === 'companion_execute') {
    return `runtime:consensus execute --run-id ${runId} --round <round> --peers ${peer} --execute`;
  }
  return `runtime:consensus record --run-id ${runId} --round <round> --peer ${peer} --input-file <path>`;
}

function buildStatusGuidance({ runId, manifest, executionArtifact, progressArtifact, consensusArtifact, ownerDecisionArtifact, cancellationArtifact, now }) {
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

  if (cancellationArtifact) {
    return guidance({
      state: 'cancelled',
      next_action: cancellationArtifact.next_action ?? 'Consensus run is cancelled; create a new consensus run before restarting peer collection.',
      next_steps: [],
      commands: [],
      reason: `cancellation recorded; previous_status=${cancellationArtifact.previous_status ?? '<unknown>'}; operator_confirmed_no_active_process=${cancellationArtifact.operator_confirmed_no_active_process === true}`,
    });
  }

  if (ownerDecisionArtifact) {
    return guidance({
      state: 'owner_decided',
      next_action: ownerDecisionArtifact.next_action ?? 'Proceed with the recorded owner decision while preserving consensus evidence pointers.',
      next_steps: [],
      commands: [],
      reason: `owner decision recorded; previous_convergence_state=${ownerDecisionArtifact.previous_convergence_state ?? '<unknown>'}`,
    });
  }

  if (!executionArtifact && progressArtifact?.status === 'running') {
    const runningPeers = peersWithProgressStatus(progressArtifact, 'running');
    const pendingPeers = peersWithProgressStatus(progressArtifact, 'pending');
    const stalledPeers = stalledProgressPeers(progressArtifact, now);
    if (stalledPeers.length > 0) {
      const stalledNames = stalledPeers.map((peer) => peer.peer);
      const guardedRetrySteps = stalledPeers
        .map((peer) => peer.retry_command
          ? `After confirming no original execute process is still active: ${peer.retry_command}`
          : null);
      return guidance({
        state: 'execution_stalled',
        next_action: `Consensus execution progress appears stalled for ${stalledNames.join(', ')}; inspect the progress artifact and confirm no original execute process is still active before retrying selected peers.`,
        next_steps: [
          progressArtifact.progress_pointer ? `Inspect ${progressArtifact.progress_pointer}` : null,
          'runtime:doctor --deep-peer-smoke --execute-deep-peer-smoke',
          ...guardedRetrySteps,
          `runtime:consensus status --run-id ${runId}`,
        ],
        commands: [
          'runtime:doctor --deep-peer-smoke --execute-deep-peer-smoke',
          `runtime:consensus status --run-id ${runId}`,
        ],
        reason: `execution progress exceeded per-peer timeout; stalled=${stalledPeers.map((peer) => `${peer.peer}:elapsed_ms=${peer.elapsed_ms}:timeout_ms=${peer.timeout_ms}`).join(',')}; pending=${pendingPeers.join(',') || '<none>'}`,
      });
    }
    return guidance({
      state: 'execution_running',
      next_action: runningPeers.length > 0
        ? `Consensus execution is still running for ${runningPeers.join(', ')}; wait for completion or inspect the progress artifact before retrying.`
        : 'Consensus execution preflight is still running; wait for completion or inspect the progress artifact before retrying.',
      next_steps: [
        `runtime:consensus status --run-id ${runId}`,
        progressArtifact.progress_pointer ? `Inspect ${progressArtifact.progress_pointer}` : null,
      ],
      commands: [`runtime:consensus status --run-id ${runId}`],
      reason: `execution progress is running; running=${runningPeers.join(',') || '<none>'}; pending=${pendingPeers.join(',') || '<none>'}`,
    });
  }

  if (consensusArtifact) {
    const convergenceState = convergenceStateFromArtifact(consensusArtifact);
    const nextRound = buildNextRoundAvailability({
      manifest,
      durableDisagreements: consensusArtifact.durable_disagreements ?? [],
      runId,
      convergenceState,
    });
    if (['aligned', 'complementary'].includes(convergenceState)) {
      return guidance({
        state: 'complete',
        next_action: consensusArtifact.next_action ?? 'Consensus is converged; proceed with the synthesized decision.',
        next_steps: [],
        commands: [],
        reason: `convergence_state=${convergenceState}`,
      });
    }
    if (convergenceState === 'insufficient-evidence') {
      return guidance({
        state: 'evidence_required',
        next_action: consensusArtifact.next_action ?? 'Consensus cannot converge because required evidence is missing; collect evidence or ask the owner to choose the evidence standard.',
        next_steps: [],
        commands: [],
        reason: 'convergence_state=insufficient-evidence',
      });
    }
    if (convergenceState === 'non-consensus') {
      return guidance({
        state: 'non_consensus',
        next_action: consensusArtifact.next_action ?? 'Irreducible disagreement remains; preserve the non-consensus evidence and ask the owner for a decision.',
        next_steps: [],
        commands: [],
        reason: 'convergence_state=non-consensus',
      });
    }
    if (nextRound.available) {
      return guidance({
        state: 'next_round_available',
        next_action: 'Direct contradictions remain; plan the bounded rebuttal round before executing more peers.',
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
      next_action: consensusArtifact.next_action ?? 'Direct contradictions remain but max_rounds is exhausted; ask the owner for a decision instead of running more peers.',
      next_steps: [
        `runtime:consensus decide --run-id ${runId} --decision-file <owner-decision.md>`,
      ],
      commands: [
        `runtime:consensus decide --run-id ${runId} --decision-file <owner-decision.md>`,
      ],
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

function peersWithProgressStatus(progressArtifact, status) {
  return Object.values(progressArtifact?.peers ?? {})
    .filter((peer) => peer?.status === status)
    .map((peer) => peer.peer)
    .filter(Boolean);
}

function stalledProgressPeers(progressArtifact, now) {
  const nowMs = timestampMs(now);
  if (nowMs === null) return [];
  return Object.values(progressArtifact?.peers ?? {})
    .filter((peer) => peer?.status === 'running')
    .map((peer) => progressStall(peer, progressArtifact, nowMs))
    .filter(Boolean);
}

function progressStall(peer, progressArtifact, nowMs) {
  const startedAtMs = timestampMs(peer.started_at);
  const timeoutMs = Number(peer.timeout_ms ?? progressArtifact?.execution_boundary?.timeout_ms);
  if (startedAtMs === null || !Number.isFinite(timeoutMs) || timeoutMs < 1) return null;
  const elapsedMs = Math.max(0, nowMs - startedAtMs);
  if (elapsedMs <= timeoutMs) return null;
  return {
    peer: peer.peer,
    elapsed_ms: elapsedMs,
    timeout_ms: timeoutMs,
    retry_command: buildRetryCommand({
      failure: { type: 'timeout', retryable: true },
      runId: progressArtifact.run_id,
      roundNumber: progressArtifact.round,
      peer: peer.peer,
      timeoutMs,
    }),
  };
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
      case '--latest-open':
        options.latestOpen = true;
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
      case '--decision':
        options.decision = requireValue(args, arg);
        break;
      case '--decision-file':
        options.decisionFile = requireValue(args, arg);
        break;
      case '--decided-by':
        options.decidedBy = requireSingleLine(requireValue(args, arg), arg);
        break;
      case '--reason':
        options.reason = requireValue(args, arg);
        break;
      case '--reason-file':
        options.reasonFile = requireValue(args, arg);
        break;
      case '--cancelled-by':
        options.cancelledBy = requireSingleLine(requireValue(args, arg), arg);
        break;
      case '--confirm-no-active-process':
        options.confirmNoActiveProcess = true;
        break;
      case '--disagreements-file':
        options.disagreementsFile = requireValue(args, arg);
        break;
      case '--contradictions-file':
        options.contradictionsFile = requireValue(args, arg);
        break;
      case '--convergence-state':
        options.convergenceState = validateConvergenceState(requireValue(args, arg));
        break;
      case '--next-action':
        options.nextAction = requireSingleLine(requireValue(args, arg), arg);
        break;
      case '--converged':
        options.converged = true;
        options.convergenceState = options.convergenceState ?? 'aligned';
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
  if (options.runId && (options.latest || options.latestOpen)) {
    throw new Error('Use either --run-id or --latest/--latest-open, not both');
  }
  if (options.latest && options.latestOpen) {
    throw new Error('Use either --latest or --latest-open, not both');
  }
  if (options.latest && options.command !== 'status') {
    throw new Error('--latest is only supported by status');
  }
  if (options.latestOpen && options.command !== 'status') {
    throw new Error('--latest-open is only supported by status');
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
  if (report.convergence_state) lines.push(`convergence state: ${report.convergence_state}`);
  if (report.run_pointer) lines.push(`run artifact: ${report.run_pointer}`);
  if (report.consensus_pointer) lines.push(`consensus: ${report.consensus_pointer}`);
  if (report.owner_decision_pointer) lines.push(`owner decision: ${report.owner_decision_pointer}`);
  if (report.cancellation_pointer) lines.push(`cancellation: ${report.cancellation_pointer}`);
  if (report.execution_pointer) lines.push(`execution: ${report.execution_pointer}`);
  if (report.progress_pointer) lines.push(`progress: ${report.progress_pointer}`);
  if (report.status_guidance?.state) {
    lines.push(`guidance state: ${report.status_guidance.state}`);
    if (report.status_guidance.reason) lines.push(`guidance reason: ${report.status_guidance.reason}`);
  }
  if (report.execution_summary) {
    lines.push(`execution summary: executed=${report.execution_summary.executed}; passed=${report.execution_summary.passed}; failed=${report.execution_summary.failed}; skipped=${report.execution_summary.skipped}; retryable-failed=${report.execution_summary.failed_retryable}; non-retryable-failed=${report.execution_summary.failed_non_retryable}; operator-action-required=${report.execution_summary.operator_action_required ?? 0}`);
  }
  if (report.round_output_summary) {
    const summary = report.round_output_summary;
    lines.push(`round outputs: round=${summary.round}; recorded=${summary.recorded}/${summary.active_peers}; complete=${summary.complete}; passed-execution=${summary.passed_execution}; manual-recorded=${summary.manual_recorded}; failed-execution=${summary.failed_execution}; missing=${summary.missing_peers.join(',') || 'none'}`);
  }
  if (report.policy?.quality_policy) {
    const quality = report.policy.quality_policy;
    lines.push('', 'quality policy:');
    lines.push(`- objective=${quality.objective}`);
    lines.push(`- default-peer-breadth=${quality.default_peer_breadth}; default-companion-peers=${quality.default_companion_peers.join(',')}`);
    lines.push(`- model-effort-default=${quality.model_effort_default}`);
    lines.push(`- review-depth-default=${quality.review_depth_default}`);
  }
  if (report.policy?.round_policy) {
    const roundPolicy = report.policy.round_policy;
    lines.push('', 'round policy:');
    lines.push(`- configured-max-rounds=${roundPolicy.configured_max_rounds}; default=${roundPolicy.default_max_rounds}; hard-cap=${roundPolicy.hard_cap}`);
    lines.push(`- exhaustion-behavior=${roundPolicy.exhaustion_behavior}`);
  }
  if (report.execution_remediation) {
    lines.push(`remediation: ${report.execution_remediation.status}`);
    lines.push(`remediation next action: ${report.execution_remediation.next_action}`);
    if (report.execution_remediation.artifacts?.execution) {
      lines.push(`remediation execution artifact: ${report.execution_remediation.artifacts.execution}`);
    }
    if (report.execution_remediation.artifacts?.progress) {
      lines.push(`remediation progress artifact: ${report.execution_remediation.artifacts.progress}`);
    }
    for (const command of report.execution_remediation.proof_commands ?? []) {
      lines.push(`proof-command: ${command}`);
    }
    for (const command of report.execution_remediation.retry_commands ?? []) {
      lines.push(`retry-command: ${command}`);
    }
  }
  if (report.owner_decision) {
    lines.push('', 'owner decision:');
    lines.push(`- status=${report.owner_decision.status}; decided-by=${report.owner_decision.decided_by}; previous-convergence-state=${report.owner_decision.previous_convergence_state}`);
    lines.push(`- decision=${report.owner_decision.decision_pointer}; bytes=${report.owner_decision.decision_bytes}; sha256=${report.owner_decision.decision_sha256}`);
  }
  if (report.cancellation) {
    lines.push('', 'cancellation:');
    lines.push(`- status=${report.cancellation.status}; cancelled-by=${report.cancellation.cancelled_by}; previous-status=${report.cancellation.previous_status}`);
    lines.push(`- reason=${report.cancellation.reason_pointer}; bytes=${report.cancellation.reason_bytes}; sha256=${report.cancellation.reason_sha256}`);
    lines.push(`- operator-confirmed-no-active-process=${report.cancellation.operator_confirmed_no_active_process}`);
  }
  if (report.executions?.length) {
    lines.push('', 'executions:');
    for (const execution of report.executions) {
      lines.push(`- ${execution.peer}: status=${execution.status}; prompt=${execution.prompt_pointer ?? '<none>'}; raw=${execution.raw_output.pointer}; bytes=${execution.raw_output.bytes}; sha256=${execution.raw_output.sha256}`);
      if (execution.failure_type) {
        lines.push(`  failure=${execution.failure_type}; operator-action-required=${Boolean(execution.operator_action_required)}; retryable=${execution.retryable}; retry-after=${execution.retry_after ?? '<none>'}`);
        if (execution.retry_command) lines.push(`  retry-command=${execution.retry_command}`);
      }
    }
  }
  if (report.peer_lanes?.length) {
    lines.push('', 'peer lanes:');
    for (const lane of report.peer_lanes) {
      lines.push(`- ${lane.peer}: role=${lane.role}; lane=${lane.lane}; peer-execution=${lane.peer_execution}; command=${lane.command_template}`);
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
  if (report.contradictions?.length) {
    lines.push('', 'contradictions:');
    for (const contradiction of report.contradictions) {
      lines.push(`- ${contradiction.summary ?? contradiction}`);
      if (contradiction.evidence_standard) lines.push(`  evidence-standard: ${contradiction.evidence_standard}`);
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
  runtime:consensus synthesize --run-id <id> --summary-file <path> [--disagreements-file <path>] [--convergence-state aligned|complementary|contradiction|insufficient-evidence|owner-decision-required|non-consensus]
  runtime:consensus decide --run-id <id> --decision-file <path> [--decided-by owner]
  runtime:consensus cancel --run-id <id> --reason <text>|--reason-file <path> [--confirm-no-active-process]
  runtime:consensus next-round --run-id <id> [--disagreements-file <path>]
  runtime:consensus execute --run-id <id> [--round N] [--peers claude,codex] --execute [--timeout-ms N] [--process-budget N]
  runtime:consensus status --run-id <id>
  runtime:consensus status --latest
  runtime:consensus status --latest-open

Planning, synthesis, owner-decision recording, and cancellation never execute peers. Peer dispatch is available only through the explicit execute command plus --execute. Only companion-backed peers (${COMPANION_PEERS.join(', ')}) are executable; other peer labels are manual/subagent lanes that must be collected with record. Contradiction rebuttal rounds default to ${DEFAULT_MAX_ROUNDS} total rounds, --max-rounds is hard-capped at ${MAX_ROUNDS_CAP}, and exhausted contradictions become owner-decision-required instead of creating another loop. Cancellation is artifact-only; if progress is running, use --confirm-no-active-process only after verifying no original execute process is still active. Use status --latest-open to select the newest non-terminal run while preserving cancelled, converged, and owner-decided runs as audit artifacts.`;
}

async function resolveStatusRunSelection({ repoRoot, runId, latest, latestOpen }) {
  if (runId && (latest || latestOpen)) {
    throw new Error('Use either --run-id or --latest/--latest-open, not both');
  }
  if (latest && latestOpen) {
    throw new Error('Use either --latest or --latest-open, not both');
  }
  if (latestOpen) return findLatestConsensusRun(repoRoot, { openOnly: true });
  if (latest) return findLatestConsensusRun(repoRoot);
  const validated = validateRunId(required(runId, '--run-id'));
  return {
    runId: validated,
    lookup: {
      mode: 'run-id',
      latest: false,
      latest_open: false,
      selected_at: null,
      skipped_invalid: 0,
      skipped_terminal: 0,
    },
  };
}

async function findLatestConsensusRun(repoRoot, { openOnly = false } = {}) {
  const root = consensusRoot(repoRoot);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const mode = openOnly ? '--latest-open' : '--latest';
      throw new Error(`status ${mode} requires at least one consensus run; no consensus run artifacts found`);
    }
    throw error;
  }

  let selected = null;
  let skippedInvalid = 0;
  let skippedTerminal = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !RUN_ID_RE.test(entry.name)) continue;
    try {
      const manifest = await readJson(manifestFile(repoRoot, entry.name));
      if (manifest.run_id !== entry.name) {
        skippedInvalid += 1;
        continue;
      }
      if (openOnly && !isOpenConsensusManifest(manifest)) {
        skippedTerminal += 1;
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
    const mode = openOnly ? '--latest-open' : '--latest';
    throw new Error(`status ${mode} found no readable${openOnly ? ' open' : ''} consensus manifest artifacts`);
  }
  return {
    runId: selected.runId,
    lookup: {
      mode: openOnly ? 'latest-open' : 'latest',
      latest: true,
      latest_open: openOnly,
      selected_at: selected.selectedAt,
      skipped_invalid: skippedInvalid,
      skipped_terminal: skippedTerminal,
    },
  };
}

function isOpenConsensusManifest(manifest) {
  if (manifest.cancellation_pointer || manifest.owner_decision_pointer) return false;
  return !TERMINAL_MANIFEST_STATUSES.has(manifest.status);
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

async function resolveDecision(options, runId) {
  if (options.decision && options.decisionFile) {
    throw new Error('Use either --decision or --decision-file, not both');
  }
  if (options.decision) {
    if (!options.decision.trim()) throw new Error('--decision must not be empty');
    return options.decision;
  }
  if (options.decisionFile) {
    const text = await readFile(resolve(options.decisionFile), 'utf8');
    if (!text.trim()) throw new Error('--decision-file must not be empty');
    return text;
  }
  throw new Error(`decide requires --decision or --decision-file; retry: runtime:consensus decide --run-id ${runId} --decision-file <owner-decision.md>`);
}

async function resolveCancellationReason(options, runId) {
  if (options.reason && options.reasonFile) {
    throw new Error('Use either --reason or --reason-file, not both');
  }
  if (options.reason) {
    if (!options.reason.trim()) throw new Error('--reason must not be empty');
    return options.reason;
  }
  if (options.reasonFile) {
    const text = await readFile(resolve(options.reasonFile), 'utf8');
    if (!text.trim()) throw new Error('--reason-file must not be empty');
    return text;
  }
  throw new Error(`cancel requires --reason or --reason-file; retry: runtime:consensus cancel --run-id ${runId} --reason-file <cancellation-reason.md>`);
}

async function resolveDisagreements(options) {
  if (!options.disagreementsFile) return [];
  const text = await readFile(resolve(options.disagreementsFile), 'utf8');
  return parseDisagreements(text);
}

async function resolveContradictions(options, durableDisagreements, convergenceState) {
  if (options.contradictionsFile) {
    return parseDisagreements(await readFile(resolve(options.contradictionsFile), 'utf8')).map(toContradictionSummary);
  }
  if (['contradiction', 'owner-decision-required', 'non-consensus'].includes(convergenceState)) {
    return durableDisagreements.map(toContradictionSummary);
  }
  return [];
}

async function resolveNextRoundInput(options, repoRoot, manifest) {
  if (options.disagreementsFile) {
    return {
      disagreements: parseDisagreements(await readFile(resolve(options.disagreementsFile), 'utf8')),
      convergenceState: 'contradiction',
    };
  }
  if (!manifest.consensus_pointer) {
    throw new Error(`next-round requires consensus.json or --disagreements-file; run runtime:consensus synthesize --run-id ${manifest.run_id} --summary-file <summary.md> [--disagreements-file <disagreements.md>] first. No next-round prompt was written and no peers were executed`);
  }
  const result = await readJson(resolve(repoRoot, manifest.consensus_pointer));
  return {
    disagreements: result.durable_disagreements ?? [],
    convergenceState: convergenceStateFromArtifact(result),
  };
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
    return { summary: value, status: 'durable', kind: null };
  }
  if (!value || typeof value !== 'object') {
    throw new Error('Disagreements must be strings or objects');
  }
  if (!value.summary || typeof value.summary !== 'string') {
    throw new Error('Disagreement objects require a string summary');
  }
  const kind = value.kind ?? value.type ?? null;
  return {
    summary: value.summary,
    status: value.status ?? 'durable',
    kind: kind ? validateDisagreementKind(kind) : null,
    owner_decision: value.owner_decision ?? null,
    issue_framing: typeof value.issue_framing === 'string' ? value.issue_framing : null,
    opposing_views: Array.isArray(value.opposing_views)
      ? value.opposing_views.filter((item) => typeof item === 'string' && item.trim()).map((item) => item.trim())
      : [],
    evidence_standard: typeof value.evidence_standard === 'string' ? value.evidence_standard : null,
    evidence_pointers: Array.isArray(value.evidence_pointers) ? value.evidence_pointers : [],
  };
}

function toContradictionSummary(value) {
  const normalized = normalizeDisagreement(value);
  return {
    summary: normalized.summary,
    issue_framing: normalized.issue_framing ?? normalized.summary,
    opposing_views: normalized.opposing_views,
    evidence_standard: normalized.evidence_standard ?? 'Resolve with artifact-backed evidence; identify missing evidence explicitly; do not average incompatible recommendations.',
    evidence_pointers: normalized.evidence_pointers,
  };
}

function buildFanoutPrompt({ runId, peer, task, policy, lane }) {
  return `# Runtime Consensus Fanout

Run id: ${runId}
Peer: ${peer}
Lane: ${lane?.lane ?? 'unknown'}
Role: ${lane?.role ?? 'unknown'}

Quality policy:

- objective: ${policy.quality_policy.objective}
- default_peer_breadth: ${policy.quality_policy.default_peer_breadth}
- model_effort_default: ${policy.quality_policy.model_effort_default}
- review_depth_default: ${policy.quality_policy.review_depth_default}

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
- default_max_rounds: ${policy.round_policy.default_max_rounds}
- max_rounds_hard_cap: ${policy.round_policy.hard_cap}
- exhausted_rounds_behavior: ${policy.round_policy.exhaustion_behavior}
- token_budget: ${policy.token_budget ?? 'unspecified'}
- time_budget_ms: ${policy.time_budget_ms ?? 'unspecified'}
- process_budget: ${policy.process_budget}

Lane action:

${lane?.operator_action ?? 'Follow the consensus report lane instructions.'}

Do not assume host parity. Note host-specific limits explicitly.`;
}

function buildRebuttalPrompt({ runId, peer, disagreements, round, lane }) {
  const body = disagreements.length
    ? disagreements.map((item, index) => formatRebuttalIssue(item, index)).join('\n\n')
    : 'No durable disagreements were provided.';
  return `# Runtime Consensus Targeted Rebuttal

Run id: ${runId}
Peer: ${peer}
Round: ${round}
Lane: ${lane?.lane ?? 'unknown'}
Role: ${lane?.role ?? 'unknown'}

Review only these synthesized disagreement summaries:

${body}

Lane action:

${lane?.operator_action ?? 'Follow the consensus report lane instructions.'}

Respond with resolution evidence, remaining disagreement, and owner decision points. Do not quote or depend on raw peer output unless you have a direct artifact pointer.`;
}

function formatRebuttalIssue(item, index) {
  const normalized = normalizeDisagreement(item);
  const opposingViews = normalized.opposing_views.length > 0
    ? normalized.opposing_views.map((view) => `  - ${view}`).join('\n')
    : '  - Use the disagreement summary as the opposing view; do not invent raw claims.';
  const evidenceStandard = normalized.evidence_standard
    ?? 'Resolve with artifact-backed evidence; identify missing evidence explicitly; do not average incompatible recommendations.';
  return `${index + 1}. Issue framing: ${normalized.issue_framing ?? normalized.summary}
   Synthesized disagreement: ${normalized.summary}
   Opposing views:
${opposingViews}
   Requested evidence standard: ${evidenceStandard}`;
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

function unique(values) {
  return [...new Set(values)];
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

function validateConvergenceState(value) {
  if (!VALID_CONVERGENCE_STATES.has(value)) {
    throw new Error('--convergence-state must be aligned, complementary, contradiction, insufficient-evidence, owner-decision-required, or non-consensus');
  }
  return value;
}

function validateDisagreementKind(value) {
  if (!VALID_DISAGREEMENT_KINDS.has(value)) {
    throw new Error('Disagreement kind must be complementary, contradiction, insufficient-evidence, or non-consensus');
  }
  return value;
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

function timestampMs(value) {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
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
    `No automatic unbounded loop is allowed; max_rounds defaults to ${DEFAULT_MAX_ROUNDS}, is hard-capped at ${MAX_ROUNDS_CAP}, and max_peers, process_budget, and timeout caps bound execution.`,
  ];
}

function buildRoundPolicy(configuredMaxRounds) {
  return {
    default_max_rounds: DEFAULT_MAX_ROUNDS,
    configured_max_rounds: configuredMaxRounds,
    hard_cap: MAX_ROUNDS_CAP,
    exhaustion_behavior: 'owner-decision-required; do not run another rebuttal round without an explicit new owner decision',
  };
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
