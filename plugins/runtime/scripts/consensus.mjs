#!/usr/bin/env node

import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '0.1.0';
const MANIFEST_SCHEMA = 'runtime-consensus-run-1.0';
const RESULT_SCHEMA = 'runtime-consensus-result-1.0';
const VALID_COMMANDS = new Set(['plan', 'record', 'synthesize', 'next-round', 'status']);
const DEFAULT_PEERS = ['claude', 'codex'];
const RUN_ID_RE = /^consensus-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const PEER_ID_RE = /^[A-Za-z0-9._-]+$/;

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
  return readStatus({ ...options, repoRoot });
}

export async function createPlan(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const now = options.now ?? new Date();
  const createdAt = toIso(now);
  const task = await resolveTask(options);
  const peers = normalizePeers(options.peers ?? DEFAULT_PEERS);
  const maxPeers = positiveInt(options.maxPeers ?? peers.length, '--max-peers');
  const activePeers = peers.slice(0, maxPeers);
  const skippedPeers = peers.slice(maxPeers);
  const maxRounds = positiveInt(options.maxRounds ?? 2, '--max-rounds');
  const policy = {
    max_rounds: maxRounds,
    max_peers: maxPeers,
    token_budget: optionalPositiveInt(options.tokenBudget, '--token-budget'),
    time_budget_ms: optionalPositiveInt(options.timeBudgetMs, '--time-budget-ms'),
    process_budget: optionalPositiveInt(options.processBudget, '--process-budget') ?? activePeers.length,
    peer_selection: 'explicit-or-default-host-peers',
    raw_output_policy: 'artifact-pointer-only',
    main_session_output: 'synthesized-summary-disagreements-evidence-pointers-only',
  };

  const runId = options.runId ? validateRunId(options.runId) : makeRunId(now);
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
    const promptPath = resolve(runDir, 'rounds', 'round-1', 'prompts', `${peer}.md`);
    await mkdir(dirname(promptPath), { recursive: true });
    await writeFile(promptPath, buildFanoutPrompt({ runId, peer, task, policy }));
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
      skipped: skippedPeers,
    },
    rounds: [round],
    consensus_pointer: null,
    limits: [
      'This scaffold never executes peer agents directly.',
      'Raw peer output is stored only as run artifacts and is not printed into the main session.',
      'Consensus output is limited to synthesized summary, durable disagreements, and evidence pointers.',
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
    artifacts: [
      { kind: 'manifest', pointer: pointer(repoRoot, manifestPath) },
      { kind: 'task', pointer: pointer(repoRoot, taskPath) },
      ...round.prompts.map((prompt) => ({ kind: 'peer-prompt', ...prompt, round: 1 })),
    ],
    next_steps: [
      'Run the peer prompts manually through the appropriate host/companion boundary.',
      `Record each raw peer output with runtime:consensus record --run-id ${runId} --peer <peer> --input-file <path>.`,
      `Synthesize with runtime:consensus synthesize --run-id ${runId} --summary-file <path> [--disagreements-file <path>].`,
    ],
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
  const summary = await resolveSummary(options);
  const durableDisagreements = await resolveDisagreements(options, repoRoot, manifest);
  const evidencePointers = collectEvidencePointers(manifest);
  const converged = options.converged === true;
  const result = {
    schema_version: RESULT_SCHEMA,
    run_id: runId,
    status: converged ? 'converged' : 'durable-disagreement',
    created_at: toIso(now),
    synthesized_summary: summary.trim(),
    durable_disagreements: durableDisagreements,
    evidence_pointers: evidencePointers,
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
    throw new Error(`Round ${nextRound} exceeds policy max_rounds ${manifest.policy.max_rounds}`);
  }
  if (manifest.rounds.some((round) => round.round === nextRound)) {
    throw new Error(`Round ${nextRound} already exists`);
  }
  const disagreements = await resolveNextRoundDisagreements(options, repoRoot, manifest);
  const round = {
    round: nextRound,
    kind: 'targeted-rebuttal',
    status: 'planned',
    prompts: [],
    raw_outputs: [],
    created_at: toIso(now),
  };
  for (const peer of manifest.peers.active) {
    const promptPath = resolve(consensusRunDir(repoRoot, runId), 'rounds', `round-${nextRound}`, 'prompts', `${peer}.md`);
    await mkdir(dirname(promptPath), { recursive: true });
    await writeFile(promptPath, buildRebuttalPrompt({ runId, peer, disagreements, round: nextRound }));
    round.prompts.push({ peer, pointer: pointer(repoRoot, promptPath) });
  }
  manifest.rounds.push(round);
  manifest.status = 'planned-rebuttal';
  manifest.updated_at = toIso(now);
  await writeJson(manifestPath, manifest);

  return {
    command: 'next-round',
    version: VERSION,
    run_id: runId,
    status: manifest.status,
    round: nextRound,
    artifacts: [
      { kind: 'manifest', pointer: pointer(repoRoot, manifestPath) },
      ...round.prompts.map((prompt) => ({ kind: 'peer-prompt', ...prompt, round: nextRound })),
    ],
    durable_disagreements: disagreements,
    limits: [
      'Next-round prompts contain synthesized disagreement summaries, not raw peer output.',
      'Peer execution remains manual/host-native in this MVP.',
    ],
  };
}

export async function readStatus(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const runId = validateRunId(required(options.runId, '--run-id'));
  const manifestPath = manifestFile(repoRoot, runId);
  const manifest = await readJson(manifestPath);
  const evidencePointers = collectEvidencePointers(manifest);
  return {
    command: 'status',
    version: VERSION,
    run_id: runId,
    status: manifest.status,
    run_pointer: pointer(repoRoot, consensusRunDir(repoRoot, runId)),
    manifest_pointer: pointer(repoRoot, manifestPath),
    consensus_pointer: manifest.consensus_pointer,
    rounds: manifest.rounds.map((round) => ({
      round: round.round,
      kind: round.kind,
      status: round.status,
      prompt_count: round.prompts.length,
      raw_output_count: round.raw_outputs.length,
    })),
    evidence_pointers: evidencePointers,
    limits: manifest.limits,
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
      case '--run-id':
        options.runId = validateRunId(requireValue(args, arg));
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
  if (report.limits?.length) {
    lines.push('', 'limits:');
    for (const limit of report.limits) lines.push(`- ${limit}`);
  }
  return lines.join('\n');
}

function helpText() {
  return `runtime:consensus ${VERSION}

Usage:
  runtime:consensus plan --task <text> [--peers claude,codex] [--max-rounds N]
  runtime:consensus record --run-id <id> --peer <peer> --input-file <path>
  runtime:consensus synthesize --run-id <id> --summary-file <path> [--disagreements-file <path>]
  runtime:consensus next-round --run-id <id> [--disagreements-file <path>]
  runtime:consensus status --run-id <id>

This MVP creates and updates runtime-owned consensus artifacts. It does not execute peer agents.`;
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

async function resolveSummary(options) {
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
  throw new Error('synthesize requires --summary or --summary-file');
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
    throw new Error('next-round requires --disagreements-file until consensus.json exists');
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

function buildFanoutPrompt({ runId, peer, task, policy }) {
  return `# Runtime Consensus Fanout

Run id: ${runId}
Peer: ${peer}

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

Do not assume host parity. Note host-specific limits explicitly.`;
}

function buildRebuttalPrompt({ runId, peer, disagreements, round }) {
  const body = disagreements.length
    ? disagreements.map((item, index) => `${index + 1}. ${item.summary ?? item}`).join('\n')
    : 'No durable disagreements were provided.';
  return `# Runtime Consensus Targeted Rebuttal

Run id: ${runId}
Peer: ${peer}
Round: ${round}

Review only these synthesized disagreement summaries:

${body}

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

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
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
