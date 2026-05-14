#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildSourceFreshness, formatSourceFreshness, resolveSourceSnapshot } from './source-snapshot.mjs';
import { RUNTIME_VERSION } from './version.mjs';

const VERSION = RUNTIME_VERSION;
const ARTIFACT_SCHEMA = 'runtime-context-artifact-1.0';
const VALID_COMMANDS = new Set(['capture', 'status', 'check']);
const RISK_LEVELS = new Set(['green', 'yellow', 'red']);
const RUN_ID_RE = /^context-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const ARTIFACT_KIND_RE = /^[A-Za-z0-9._-]+$/;
const REPORT_PREVIEW_LIMIT = 1200;
const CONTEXT_BUDGET_THRESHOLDS = {
  yellowAt: 0.7,
  redAt: 0.9,
};
const DEFAULT_HANDOFF_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export async function runContext(options = {}) {
  const command = options.command ?? 'capture';
  if (!VALID_COMMANDS.has(command)) {
    throw new Error(`Unsupported context command: ${command}`);
  }
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  if (command === 'capture') {
    return captureContext({ ...options, repoRoot });
  }
  if (command === 'status') {
    return readStatus({ ...options, repoRoot });
  }
  return checkContext({ ...options, repoRoot });
}

export async function captureContext(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const now = options.now ?? new Date();
  const createdAt = toIso(now);
  const runId = options.runId ? validateRunId(options.runId) : makeRunId(now);
  const runDir = contextRunDir(repoRoot, runId);
  await assertInside(contextRoot(repoRoot), runDir);
  await mkdir(runDir, { recursive: true });

  const summary = await resolveSummary(options);
  const riskLevel = validateRiskLevel(options.risk ?? 'yellow');
  const riskReason = options.riskReason
    ? requireSingleLine(options.riskReason, '--risk-reason')
    : defaultRiskReason(options.risk);
  const artifactPointers = normalizeArtifacts(repoRoot, options.artifacts ?? []);
  const recommendedAction = options.nextAction
    ? requireSingleLine(options.nextAction, '--next-action')
    : defaultNextAction(riskLevel);

  const contextPointer = pointer(repoRoot, resolve(runDir, 'context.json'));
  const prompt = await resolveNextSessionPrompt({
    ...options,
    summary,
    riskLevel,
    recommendedAction,
    contextPointer,
  });
  const promptPath = resolve(runDir, 'next-session-prompt.md');
  await writeFile(promptPath, ensureTrailingNewline(prompt));

  const summaryPath = resolve(runDir, 'summary.md');
  await writeFile(summaryPath, ensureTrailingNewline(summary));
  const sourceSnapshot = await resolveSourceSnapshot({
    repoRoot,
    snapshot: options.sourceSnapshot,
    observedAt: createdAt,
  });

  const artifact = {
    schema_version: ARTIFACT_SCHEMA,
    runtime_version: VERSION,
    run_id: runId,
    status: 'captured',
    created_at: createdAt,
    updated_at: createdAt,
    repo_root_pointer: '.',
    context: {
      summary: summary.trim(),
      risk_level: riskLevel,
      risk_reason: riskReason,
    },
    artifacts: [
      { kind: 'context-summary', pointer: pointer(repoRoot, summaryPath) },
      ...artifactPointers,
    ],
    next_session: {
      recommended_action: recommendedAction,
      prompt_pointer: pointer(repoRoot, promptPath),
    },
    source_snapshot: sourceSnapshot,
    limits: contextLimits(),
  };

  const contextPath = resolve(runDir, 'context.json');
  await writeJson(contextPath, artifact);

  return buildReport({ command: 'capture', repoRoot, artifact, contextPath, prompt });
}

export async function readStatus(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const latest = options.latest === true;
  if (options.runId && latest) {
    throw new Error('Use either --run-id or --latest, not both');
  }
  if (!options.runId && !latest) {
    throw new Error('status requires --run-id or --latest');
  }
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_HANDOFF_STALE_AFTER_MS;
  const lookup = latest
    ? await findLatestContextArtifact(repoRoot)
    : {
        runId: validateRunId(required(options.runId, '--run-id')),
        contextPath: contextFile(repoRoot, options.runId),
        skippedInvalid: 0,
      };
  const contextPath = lookup.contextPath;
  const artifact = await readJson(contextPath);
  const now = options.now ?? new Date();
  const currentSourceSnapshot = await resolveSourceSnapshot({
    repoRoot,
    snapshot: options.currentSourceSnapshot,
    observedAt: toIso(now),
  });
  const handoff = buildHandoffLookup({
    artifact,
    runId: lookup.runId,
    latest,
    now,
    staleAfterMs,
    skippedInvalid: lookup.skippedInvalid,
    currentSourceSnapshot,
  });
  let prompt = null;
  if (artifact.next_session?.prompt_pointer) {
    prompt = await readFile(resolve(repoRoot, artifact.next_session.prompt_pointer), 'utf8');
  }
  return buildReport({ command: 'status', repoRoot, artifact, contextPath, prompt, handoff });
}

export async function checkContext(options = {}) {
  const budgetCheck = buildBudgetCheck(options);
  const riskReason = options.riskReason
    ? requireSingleLine(options.riskReason, '--risk-reason')
    : budgetCheck.riskReason;
  return {
    command: 'check',
    version: VERSION,
    status: 'checked',
    read_only: true,
    risk_level: budgetCheck.riskLevel,
    risk_reason: riskReason,
    context_budget: budgetCheck.contextBudget,
    artifacts: [],
    next_session: {
      recommended_action: defaultCheckNextAction(budgetCheck.riskLevel),
      prompt_pointer: null,
      prompt_preview: null,
    },
    limits: checkLimits(),
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

  const options = { artifacts: [] };
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
        if (!['text', 'json'].includes(format)) throw new Error('--format must be text or json');
        options.format = format;
        break;
      }
      case '--run-id':
        options.runId = validateRunId(requireValue(args, arg));
        break;
      case '--latest':
        options.latest = true;
        break;
      case '--stale-after-hours':
        options.staleAfterMs = parseNonNegativeInteger(requireValue(args, arg), arg) * 60 * 60 * 1000;
        break;
      case '--summary':
        options.summary = requireValue(args, arg);
        break;
      case '--summary-file':
        options.summaryFile = requireValue(args, arg);
        break;
      case '--risk':
        options.risk = validateRiskLevel(requireValue(args, arg));
        break;
      case '--token-budget':
        options.tokenBudget = parsePositiveInteger(requireValue(args, arg), arg);
        break;
      case '--used-tokens':
        options.usedTokens = parseNonNegativeInteger(requireValue(args, arg), arg);
        break;
      case '--remaining-tokens':
        options.remainingTokens = parseNonNegativeInteger(requireValue(args, arg), arg);
        break;
      case '--risk-reason':
        options.riskReason = requireSingleLine(requireValue(args, arg), arg);
        break;
      case '--artifact':
        options.artifacts.push(requireSingleLine(requireValue(args, arg), arg));
        break;
      case '--next-action':
        options.nextAction = requireSingleLine(requireValue(args, arg), arg);
        break;
      case '--next-session-prompt':
        options.nextSessionPrompt = requireValue(args, arg);
        break;
      case '--next-session-prompt-file':
        options.nextSessionPromptFile = requireValue(args, arg);
        break;
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  options.command = command ?? 'capture';
  return options;
}

export function formatText(report) {
  if (report.help) return helpText();
  const lines = [`runtime:context ${report.version ?? VERSION} (${report.command})`];
  if (report.run_id) lines.push(`run: ${report.run_id}`);
  if (report.risk_level) lines.push(`risk: ${report.risk_level}`);
  if (report.context_pointer) lines.push(`context artifact: ${report.context_pointer}`);
  if (report.next_session?.prompt_pointer) lines.push(`next-session prompt: ${report.next_session.prompt_pointer}`);

  if (report.context_summary) {
    lines.push('', 'context summary:', report.context_summary);
  }
  if (report.risk_reason) {
    lines.push('', `risk reason: ${report.risk_reason}`);
  }
  if (report.context_budget) {
    lines.push('', 'context budget:');
    lines.push(formatContextBudget(report.context_budget));
  }
  if (report.handoff) {
    lines.push('', 'handoff lookup:');
    lines.push(formatHandoffLookup(report.handoff));
  }
  if (report.artifacts?.length) {
    lines.push('', 'artifact pointers:');
    for (const artifact of report.artifacts) {
      lines.push(`- ${artifact.kind}: ${artifact.pointer}`);
    }
  }
  if (report.next_session?.recommended_action) {
    lines.push('', `recommended next action: ${report.next_session.recommended_action}`);
  }
  if (report.next_session?.prompt_preview) {
    lines.push('', 'recommended next-session prompt:', report.next_session.prompt_preview);
  }
  if (report.limits?.length) {
    lines.push('', 'limits:');
    for (const limit of report.limits) lines.push(`- ${limit}`);
  }
  return lines.join('\n');
}

function buildReport({ command, repoRoot, artifact, contextPath, prompt, handoff = null }) {
  const report = {
    command,
    version: VERSION,
    run_id: artifact.run_id,
    status: artifact.status,
    context_pointer: pointer(repoRoot, contextPath),
    context_summary: preview(artifact.context.summary),
    risk_level: artifact.context.risk_level,
    risk_reason: artifact.context.risk_reason,
    artifacts: [
      { kind: 'context-artifact', pointer: pointer(repoRoot, contextPath) },
      ...(artifact.artifacts ?? []),
    ],
    next_session: {
      recommended_action: artifact.next_session.recommended_action,
      prompt_pointer: artifact.next_session.prompt_pointer,
      prompt_preview: prompt ? preview(prompt) : null,
    },
    source_snapshot: artifact.source_snapshot ?? null,
    limits: artifact.limits,
  };
  if (handoff) report.handoff = handoff;
  return report;
}

function buildBudgetCheck(options) {
  const hasRisk = options.risk !== undefined && options.risk !== null;
  const hasBudget = options.tokenBudget !== undefined && options.tokenBudget !== null;
  const hasUsed = options.usedTokens !== undefined && options.usedTokens !== null;
  const hasRemaining = options.remainingTokens !== undefined && options.remainingTokens !== null;
  if (hasRisk && (hasBudget || hasUsed || hasRemaining)) {
    throw new Error('Use budget metrics or --risk, not both');
  }
  if (hasRisk) {
    const riskLevel = validateRiskLevel(options.risk);
    return {
      riskLevel,
      riskReason: 'Risk level was supplied by the caller; no automatic host-context measurement is performed.',
      contextBudget: {
        status: 'not_provided',
        token_budget: null,
        used_tokens: null,
        remaining_tokens: null,
        used_ratio: null,
        used_percent: null,
        thresholds: contextBudgetThresholds(),
      },
    };
  }
  if (!hasBudget || (!hasUsed && !hasRemaining)) {
    throw new Error('check requires --token-budget with either --used-tokens or --remaining-tokens, or --risk');
  }
  if (hasUsed && hasRemaining) {
    throw new Error('Use either --used-tokens or --remaining-tokens, not both');
  }

  const tokenBudget = parsePositiveInteger(options.tokenBudget, '--token-budget');
  const usedTokens = hasUsed
    ? parseNonNegativeInteger(options.usedTokens, '--used-tokens')
    : tokenBudget - parseRemainingTokens(options.remainingTokens, tokenBudget);
  const remainingTokens = hasUsed
    ? Math.max(0, tokenBudget - usedTokens)
    : parseRemainingTokens(options.remainingTokens, tokenBudget);
  const usedRatio = usedTokens / tokenBudget;
  const usedPercent = roundOne(usedRatio * 100);
  const riskLevel = usedRatio >= CONTEXT_BUDGET_THRESHOLDS.redAt
    ? 'red'
    : usedRatio >= CONTEXT_BUDGET_THRESHOLDS.yellowAt
      ? 'yellow'
      : 'green';
  return {
    riskLevel,
    riskReason: `Context budget check used ${usedPercent}% of the supplied token budget.`,
    contextBudget: {
      status: 'observed',
      token_budget: tokenBudget,
      used_tokens: usedTokens,
      remaining_tokens: remainingTokens,
      over_budget_tokens: Math.max(0, usedTokens - tokenBudget),
      used_ratio: roundFour(usedRatio),
      used_percent: usedPercent,
      thresholds: contextBudgetThresholds(),
    },
  };
}

async function resolveSummary(options) {
  if (options.summary && options.summaryFile) {
    throw new Error('Use either --summary or --summary-file, not both');
  }
  if (options.summary) {
    if (!options.summary.trim()) throw new Error('--summary must not be empty');
    return options.summary.trim();
  }
  if (options.summaryFile) {
    const text = await readFile(resolve(options.summaryFile), 'utf8');
    if (!text.trim()) throw new Error('--summary-file must not be empty');
    return text.trim();
  }
  throw new Error('capture requires --summary or --summary-file');
}

async function resolveNextSessionPrompt(options) {
  if (options.nextSessionPrompt && options.nextSessionPromptFile) {
    throw new Error('Use either --next-session-prompt or --next-session-prompt-file, not both');
  }
  if (options.nextSessionPrompt) {
    if (!options.nextSessionPrompt.trim()) throw new Error('--next-session-prompt must not be empty');
    return options.nextSessionPrompt.trim();
  }
  if (options.nextSessionPromptFile) {
    const text = await readFile(resolve(options.nextSessionPromptFile), 'utf8');
    if (!text.trim()) throw new Error('--next-session-prompt-file must not be empty');
    return text.trim();
  }
  return `Continue agentic-plugins work from runtime context artifact ${options.contextPointer}.

Context summary:
${options.summary.trim()}

Risk level: ${options.riskLevel}
Recommended next action: ${options.recommendedAction}`;
}

function normalizeArtifacts(repoRoot, values) {
  const inputs = Array.isArray(values) ? values : [values];
  return inputs.map((value) => {
    const { kind, path } = parseArtifactSpec(value);
    return { kind, pointer: normalizeRepoPointer(repoRoot, path) };
  });
}

function parseArtifactSpec(value) {
  const text = String(value ?? '').trim();
  if (!text) throw new Error('--artifact must not be empty');
  const colon = text.indexOf(':');
  if (colon > 0) {
    const kind = text.slice(0, colon);
    const path = text.slice(colon + 1);
    if (ARTIFACT_KIND_RE.test(kind) && path) return { kind, path };
  }
  return { kind: 'artifact', path: text };
}

function normalizeRepoPointer(repoRoot, value) {
  if (/[\u0000-\u001F]/.test(value)) {
    throw new Error('artifact pointers must not contain control characters');
  }
  const candidate = isAbsolute(value) ? resolve(value) : resolve(repoRoot, value);
  assertInsideSync(repoRoot, candidate, 'Artifact path escapes repo root');
  return pointer(repoRoot, candidate);
}

function validateRiskLevel(value) {
  if (!RISK_LEVELS.has(value)) {
    throw new Error('--risk must be green, yellow, or red');
  }
  return value;
}

function defaultRiskReason(riskProvided) {
  return riskProvided
    ? 'Risk level was supplied by the caller.'
    : 'No automatic host-context measurement is performed; context capture defaults to yellow unless --risk is supplied.';
}

function defaultNextAction(riskLevel) {
  if (riskLevel === 'green') {
    return 'Continue in the current session only for small follow-up work; keep the context artifact pointer available.';
  }
  if (riskLevel === 'red') {
    return 'Start a fresh session with the next-session prompt before continuing substantial work.';
  }
  return 'Prefer a fresh or resumed session with the next-session prompt before substantial follow-up work.';
}

function defaultCheckNextAction(riskLevel) {
  if (riskLevel === 'green') {
    return 'Continue in the current session only for small follow-up work; keep artifact pointers available.';
  }
  if (riskLevel === 'red') {
    return 'Start a fresh or resumed session before continuing substantial work; run runtime:context capture first if no handoff artifact exists.';
  }
  return 'Prefer a fresh or resumed session before substantial follow-up work; run runtime:context capture first if no handoff artifact exists.';
}

function contextLimits() {
  return [
    'This scaffold writes runtime-owned context artifacts only; it does not mutate host session context.',
    'Main-session output is limited to context summary, risk level, artifact pointers, and recommended next-session action/prompt.',
    'Engineer and orchestrator workflow state stays in its existing storage; no migration is performed.',
    'Consensus or peer raw output should be referenced by artifact pointer only, not pasted into the context summary.',
    'Codex manual-hook and permission limits are not represented as host parity.',
  ];
}

function checkLimits() {
  return [
    'Read-only check only; no context artifact is created.',
    'This check does not mutate, compact, trim, or rewrite host session context.',
    'No automatic context capture, host switch, new workflow, or new session is started.',
    'Engineer and orchestrator workflow state stays in its existing storage; no migration is performed.',
    'Codex manual-hook and permission limits are not represented as host parity.',
  ];
}

function helpText() {
  return `runtime:context ${VERSION}

Usage:
  runtime:context capture --summary <text> [--risk green|yellow|red]
  runtime:context capture --summary-file <path> [--artifact kind:<repo-path>] [--next-action <text>]
  runtime:context status (--run-id <id>|--latest) [--stale-after-hours <n>]
  runtime:context check --token-budget <n> (--used-tokens <n>|--remaining-tokens <n>)
  runtime:context check --risk green|yellow|red

This MVP writes repo-local context artifacts under .agentic-plugins/runs/context/ for capture/status, including a read-only git source snapshot when available. Status reports age-based stale metadata plus source-freshness metadata. The check command is read-only and does not create artifacts or mutate host session context.`;
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

function parsePositiveInteger(value, flag) {
  const parsed = parseNonNegativeInteger(value, flag);
  if (parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function parseNonNegativeInteger(value, flag) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) throw new Error(`${flag} must be a non-negative integer`);
  return Number.parseInt(text, 10);
}

function parseRemainingTokens(value, tokenBudget) {
  const remaining = parseNonNegativeInteger(value, '--remaining-tokens');
  if (remaining > tokenBudget) {
    throw new Error('--remaining-tokens must be less than or equal to --token-budget');
  }
  return remaining;
}

async function findLatestContextArtifact(repoRoot) {
  const root = contextRoot(repoRoot);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    throw new Error(`No context artifacts found under ${pointer(repoRoot, root)}: ${error.code ?? error.message}`);
  }

  const candidates = [];
  let skippedInvalid = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !RUN_ID_RE.test(entry.name)) continue;
    const contextPath = contextFile(repoRoot, entry.name);
    try {
      const artifact = await readJson(contextPath);
      const selectedAt = artifactTimestampMs(artifact, entry.name);
      if (selectedAt === null) {
        skippedInvalid++;
        continue;
      }
      candidates.push({
        runId: entry.name,
        contextPath,
        selectedAt,
      });
    } catch {
      skippedInvalid++;
    }
  }

  if (candidates.length === 0) {
    throw new Error(`No readable context artifacts found under ${pointer(repoRoot, root)}`);
  }

  candidates.sort((a, b) => b.selectedAt - a.selectedAt || b.runId.localeCompare(a.runId));
  return { ...candidates[0], skippedInvalid };
}

function buildHandoffLookup({
  artifact,
  runId,
  latest,
  now,
  staleAfterMs,
  skippedInvalid,
  currentSourceSnapshot,
}) {
  const selectedAt = artifactTimestampMs(artifact, runId);
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const ageMs = selectedAt === null ? null : Math.max(0, nowMs - selectedAt);
  return {
    mode: latest ? 'latest' : 'run-id',
    latest,
    selected_at: selectedAt === null ? null : new Date(selectedAt).toISOString(),
    age_ms: ageMs,
    age_minutes: ageMs === null ? null : roundOne(ageMs / 60000),
    stale_after_ms: staleAfterMs,
    stale: ageMs === null ? null : ageMs > staleAfterMs,
    skipped_invalid: skippedInvalid,
    source_freshness: buildSourceFreshness({
      artifactSnapshot: artifact.source_snapshot,
      currentSnapshot: currentSourceSnapshot,
    }),
  };
}

function artifactTimestampMs(artifact, fallbackRunId) {
  for (const value of [artifact.updated_at, artifact.created_at]) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return runIdTimestampMs(fallbackRunId);
}

function runIdTimestampMs(runId) {
  const match = String(runId ?? '').match(/^context-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-[0-9a-f]{6}$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const parsed = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatHandoffLookup(handoff) {
  const selected = handoff.selected_at ?? 'unknown';
  const age = handoff.age_minutes === null ? 'unknown' : `${handoff.age_minutes} minutes`;
  const lines = [
    `- mode: ${handoff.mode}`,
    `- latest: ${handoff.latest}`,
    `- selected_at: ${selected}`,
    `- age: ${age}`,
    `- stale: ${handoff.stale}`,
    `- stale_after_ms: ${handoff.stale_after_ms}`,
    `- skipped_invalid: ${handoff.skipped_invalid}`,
  ];
  if (handoff.source_freshness) {
    lines.push(...formatSourceFreshness(handoff.source_freshness));
  }
  return lines.join('\n');
}

function contextBudgetThresholds() {
  return {
    green_below_percent: CONTEXT_BUDGET_THRESHOLDS.yellowAt * 100,
    yellow_from_percent: CONTEXT_BUDGET_THRESHOLDS.yellowAt * 100,
    red_from_percent: CONTEXT_BUDGET_THRESHOLDS.redAt * 100,
  };
}

function formatContextBudget(budget) {
  if (budget.status !== 'observed') {
    return `- status: ${budget.status}`;
  }
  const overBudget = budget.over_budget_tokens > 0
    ? `, over budget ${budget.over_budget_tokens}`
    : '';
  return `- ${budget.used_percent}% used (${budget.used_tokens}/${budget.token_budget} tokens, remaining ${budget.remaining_tokens}${overBudget})`;
}

function roundOne(value) {
  return Math.round(value * 10) / 10;
}

function roundFour(value) {
  return Math.round(value * 10000) / 10000;
}

function validateRunId(runId) {
  if (!RUN_ID_RE.test(runId)) {
    throw new Error('Invalid --run-id; expected context-YYYYMMDDTHHMMSSZ-abcdef');
  }
  return runId;
}

function makeRunId(now) {
  const stamp = toIso(now).replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `context-${stamp}-${randomBytes(3).toString('hex')}`;
}

function toIso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function contextRoot(repoRoot) {
  return resolve(repoRoot, '.agentic-plugins', 'runs', 'context');
}

function contextRunDir(repoRoot, runId) {
  return resolve(contextRoot(repoRoot), validateRunId(runId));
}

function contextFile(repoRoot, runId) {
  return resolve(contextRunDir(repoRoot, runId), 'context.json');
}

function pointer(repoRoot, path) {
  const rel = relative(repoRoot, path).split(sep).join('/');
  return rel || basename(path);
}

async function assertInside(root, candidate) {
  assertInsideSync(root, candidate, `Artifact path escapes context root: ${candidate}`);
}

function assertInsideSync(root, candidate, message) {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  const rel = relative(rootPath, candidatePath);
  if (rel.startsWith('..') || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(message);
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function ensureTrailingNewline(text) {
  return text.endsWith('\n') ? text : `${text}\n`;
}

function preview(text) {
  const trimmed = text.trim();
  if (trimmed.length <= REPORT_PREVIEW_LIMIT) return trimmed;
  return `${trimmed.slice(0, REPORT_PREVIEW_LIMIT)}...`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(helpText());
    return;
  }
  const report = await runContext(options);
  if (options.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatText(report));
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`runtime:context: ${error.message}`);
    process.exitCode = 1;
  });
}
