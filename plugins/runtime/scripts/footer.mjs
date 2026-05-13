#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { RUNTIME_VERSION } from './version.mjs';

const VERSION = RUNTIME_VERSION;
const VALID_HOSTS = new Set(['claude', 'codex', 'neutral']);
const VALID_CONTEXT_STATES = new Set(['green', 'yellow', 'red']);
const VALID_PR_COMPLETION_BOUNDARIES = new Set(['reached', 'not-reached', 'unknown']);
const VALID_PR_VALIDATION_STATES = new Set(['passed', 'waived', 'failed', 'not-run', 'unknown']);
const VALID_PR_REVIEW_STATES = new Set(['clear', 'blocking', 'unknown']);
const VALID_PR_BRANCH_STATES = new Set(['pushable', 'not-pushable', 'unknown']);
const RUN_ID_RE = /^context-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const ARTIFACT_KIND_RE = /^[A-Za-z0-9._-]+$/;
const DEFAULT_HANDOFF_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export async function runFooter(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const host = validateHost(options.host ?? 'neutral');
  const context = options.contextRunId || options.contextLatest
    ? await readContextArtifact(repoRoot, {
        runId: options.contextRunId,
        latest: options.contextLatest === true,
        now: options.now ?? new Date(),
        staleAfterMs: options.staleAfterMs ?? DEFAULT_HANDOFF_STALE_AFTER_MS,
      })
    : null;

  const contextState = validateContextState(
    options.contextState ?? context?.contextState ?? 'yellow',
  );
  const workflow = normalizeWorkflow(repoRoot, options);
  const providedArtifacts = normalizeArtifacts(repoRoot, options.artifacts ?? []);
  const artifacts = dedupeArtifacts([
    ...contextArtifacts(context),
    ...workflowArtifacts(workflow),
    ...providedArtifacts,
  ]);
  const nextSession = normalizeNextSession({ host, context, options });
  const prHandling = shouldIncludePrHandling(options)
    ? buildPrHandlingReadiness({ contextState, options })
    : null;

  return {
    command: 'render',
    version: VERSION,
    advisory: true,
    context_state: contextState,
    context: context
      ? {
          run_id: context.runId,
          pointer: context.contextPointer,
          lookup: context.lookup,
        }
      : null,
    workflow,
    artifacts,
    recommended_next_work: options.recommendedNextWork
      ? requireSingleLine(options.recommendedNextWork, '--recommended-next-work')
      : 'Review the completion result and choose the next command explicitly.',
    next_session: nextSession,
    pr_handling: prHandling,
    limits: footerLimits(),
  };
}

export function parseArgs(argv) {
  const args = [...argv];
  if (args[0] && !args[0].startsWith('-')) {
    const command = args.shift();
    if (command !== 'render') {
      throw new Error('Command must be render');
    }
  }

  const options = { artifacts: [] };
  while (args.length > 0) {
    const arg = args.shift();
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
      case '--host':
        options.host = validateHost(requireValue(args, arg));
        break;
      case '--workflow-kind':
        options.workflowKind = requireSingleLine(requireValue(args, arg), arg);
        break;
      case '--workflow-id':
        options.workflowId = requireSingleLine(requireValue(args, arg), arg);
        break;
      case '--workflow-path':
        options.workflowPath = requireSingleLine(requireValue(args, arg), arg);
        break;
      case '--context-run-id':
        options.contextRunId = validateRunId(requireValue(args, arg));
        break;
      case '--context-latest':
        options.contextLatest = true;
        break;
      case '--stale-after-hours':
        options.staleAfterMs = parseNonNegativeInteger(requireValue(args, arg), arg) * 60 * 60 * 1000;
        break;
      case '--context-state':
        options.contextState = validateContextState(requireValue(args, arg));
        break;
      case '--pr-handling':
        options.prHandling = true;
        break;
      case '--pr-completion-boundary':
        options.prCompletionBoundary = validateEnum(
          requireValue(args, arg),
          VALID_PR_COMPLETION_BOUNDARIES,
          `${arg} must be reached, not-reached, or unknown`,
        );
        break;
      case '--pr-validation-state':
        options.prValidationState = validateEnum(
          requireValue(args, arg),
          VALID_PR_VALIDATION_STATES,
          `${arg} must be passed, waived, failed, not-run, or unknown`,
        );
        break;
      case '--pr-review-state':
        options.prReviewState = validateEnum(
          requireValue(args, arg),
          VALID_PR_REVIEW_STATES,
          `${arg} must be clear, blocking, or unknown`,
        );
        break;
      case '--pr-branch-state':
        options.prBranchState = validateEnum(
          requireValue(args, arg),
          VALID_PR_BRANCH_STATES,
          `${arg} must be pushable, not-pushable, or unknown`,
        );
        break;
      case '--artifact':
        options.artifacts.push(requireSingleLine(requireValue(args, arg), arg));
        break;
      case '--recommended-next-work':
        options.recommendedNextWork = requireSingleLine(requireValue(args, arg), arg);
        break;
      case '--next-session-action':
        options.nextSessionAction = requireSingleLine(requireValue(args, arg), arg);
        break;
      case '--next-session-command':
        options.nextSessionCommand = requireSingleLine(requireValue(args, arg), arg);
        break;
      case '--next-session-prompt-pointer':
        options.nextSessionPromptPointer = requireSingleLine(requireValue(args, arg), arg);
        break;
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.contextRunId && options.contextLatest) {
    throw new Error('Use either --context-run-id or --context-latest, not both');
  }
  return options;
}

export function formatText(report) {
  if (report.help) return helpText();
  const lines = ['Runtime completion footer (advisory)'];
  lines.push(`context state: ${report.context_state}`);
  if (report.context?.pointer) lines.push(`context artifact: ${report.context.pointer}`);
  if (report.context?.lookup) {
    lines.push('context lookup:');
    lines.push(formatContextLookup(report.context.lookup));
  }
  if (report.workflow?.kind || report.workflow?.id) {
    lines.push(`workflow: ${[report.workflow.kind, report.workflow.id].filter(Boolean).join(' ')}`);
  }
  if (report.workflow?.path) lines.push(`workflow path: ${report.workflow.path}`);
  if (report.artifacts?.length) {
    lines.push('artifacts:');
    for (const artifact of report.artifacts) {
      lines.push(`- ${artifact.kind}: ${artifact.pointer}`);
    }
  }
  lines.push(`recommended next work: ${report.recommended_next_work}`);
  if (report.next_session?.action) {
    lines.push(`next-session action: ${report.next_session.action}`);
  }
  if (report.next_session?.command) {
    lines.push(`next-session command: ${report.next_session.command}`);
  }
  if (report.next_session?.prompt_pointer) {
    lines.push(`next-session prompt: ${report.next_session.prompt_pointer}`);
  }
  if (report.pr_handling) {
    lines.push('PR handling:');
    lines.push(`- recommendation: ${report.pr_handling.recommendation}`);
    lines.push(`- should_ask_user: ${report.pr_handling.should_ask_user}`);
    if (report.pr_handling.prompt) lines.push(`- prompt: ${report.pr_handling.prompt}`);
    lines.push('- criteria:');
    for (const criterion of report.pr_handling.criteria ?? []) {
      lines.push(`  - ${criterion.name}: ${criterion.status} (${criterion.observed})`);
    }
  }
  lines.push('limits:');
  for (const limit of report.limits ?? []) lines.push(`- ${limit}`);
  return lines.join('\n');
}

async function readContextArtifact(repoRoot, options) {
  const latest = options.latest === true;
  if (options.runId && latest) {
    throw new Error('Use either --context-run-id or --context-latest, not both');
  }
  if (!options.runId && !latest) {
    throw new Error('Context lookup requires --context-run-id or --context-latest');
  }
  const lookup = latest
    ? await findLatestContextArtifact(repoRoot)
    : {
        runId: validateRunId(options.runId),
        contextPath: resolve(contextRoot(repoRoot), validateRunId(options.runId), 'context.json'),
        skippedInvalid: 0,
      };
  const runId = lookup.runId;
  const contextPath = lookup.contextPath;
  assertInsideSync(contextRoot(repoRoot), contextPath, 'Context artifact path escapes context root');
  const artifact = JSON.parse(await readFile(contextPath, 'utf8'));
  const state = validateContextState(artifact.context?.risk_level ?? 'yellow');
  const promptPointer = artifact.next_session?.prompt_pointer
    ? normalizeRepoPointer(repoRoot, artifact.next_session.prompt_pointer)
    : null;
  return {
    runId,
    contextState: state,
    contextPointer: pointer(repoRoot, contextPath),
    artifacts: normalizeContextArtifacts(repoRoot, artifact.artifacts ?? []),
    nextSession: {
      action: artifact.next_session?.recommended_action
        ? requireSingleLine(artifact.next_session.recommended_action, 'context.next_session.recommended_action')
        : defaultNextAction(state),
      promptPointer,
    },
    lookup: buildContextLookup({
      artifact,
      runId,
      latest,
      now: options.now,
      staleAfterMs: options.staleAfterMs,
      skippedInvalid: lookup.skippedInvalid,
    }),
  };
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
    const contextPath = resolve(root, entry.name, 'context.json');
    try {
      const artifact = JSON.parse(await readFile(contextPath, 'utf8'));
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

function buildContextLookup({ artifact, runId, latest, now, staleAfterMs, skippedInvalid }) {
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
  };
}

function contextArtifacts(context) {
  if (!context) return [];
  return [
    { kind: 'context-artifact', pointer: context.contextPointer },
    ...context.artifacts,
  ];
}

function workflowArtifacts(workflow) {
  return workflow?.path ? [{ kind: 'workflow', pointer: workflow.path }] : [];
}

function normalizeWorkflow(repoRoot, options) {
  return {
    kind: options.workflowKind
      ? requireSingleLine(options.workflowKind, '--workflow-kind')
      : null,
    id: options.workflowId
      ? requireSingleLine(options.workflowId, '--workflow-id')
      : null,
    path: options.workflowPath
      ? normalizeRepoPointer(repoRoot, options.workflowPath)
      : null,
  };
}

function normalizeNextSession({ host, context, options }) {
  const action = options.nextSessionAction
    ? requireSingleLine(options.nextSessionAction, '--next-session-action')
    : context?.nextSession.action ?? defaultNextAction(options.contextState ?? context?.contextState ?? 'yellow');
  const command = options.nextSessionCommand
    ? requireSingleLine(options.nextSessionCommand, '--next-session-command')
    : context
      ? contextStatusCommand(host, context.runId)
      : null;
  const promptPointer = options.nextSessionPromptPointer
    ? normalizeRepoPointer(resolve(options.repoRoot ?? process.cwd()), options.nextSessionPromptPointer)
    : context?.nextSession.promptPointer ?? null;
  return {
    action,
    command,
    prompt_pointer: promptPointer,
  };
}

function shouldIncludePrHandling(options) {
  return options.prHandling === true
    || options.prCompletionBoundary !== undefined
    || options.prValidationState !== undefined
    || options.prReviewState !== undefined
    || options.prBranchState !== undefined;
}

function buildPrHandlingReadiness({ contextState, options }) {
  const criteria = [
    criterion(
      'deliverable_boundary',
      options.prCompletionBoundary ?? 'unknown',
      { pass: ['reached'], fail: ['not-reached'] },
    ),
    criterion(
      'validation',
      options.prValidationState ?? 'unknown',
      { pass: ['passed', 'waived'], fail: ['failed', 'not-run'] },
    ),
    criterion(
      'context_risk',
      contextState,
      { pass: ['green', 'yellow'], fail: ['red'] },
    ),
    criterion(
      'blocking_reviews',
      options.prReviewState ?? 'unknown',
      { pass: ['clear'], fail: ['blocking'] },
    ),
    criterion(
      'branch_state',
      options.prBranchState ?? 'unknown',
      { pass: ['pushable'], fail: ['not-pushable'] },
    ),
  ];

  const hasFail = criteria.some((item) => item.status === 'fail');
  const hasUnknown = criteria.some((item) => item.status === 'unknown');
  const shouldAsk = !hasFail && !hasUnknown;
  const recommendation = shouldAsk ? 'ask-user' : hasFail ? 'block' : 'defer';

  return {
    recommendation,
    should_ask_user: shouldAsk,
    prompt: shouldAsk
      ? 'Ask the user whether to commit, push, and open a PR now; continue without PR; or defer PR handling.'
      : null,
    criteria,
  };
}

function criterion(name, observed, rule) {
  const status = rule.pass.includes(observed)
    ? 'pass'
    : rule.fail.includes(observed)
      ? 'fail'
      : 'unknown';
  return { name, status, observed };
}

function normalizeArtifacts(repoRoot, values) {
  const inputs = Array.isArray(values) ? values : [values];
  return inputs.map((value) => {
    const { kind, path } = parseArtifactSpec(value);
    return { kind, pointer: normalizeRepoPointer(repoRoot, path) };
  });
}

function normalizeContextArtifacts(repoRoot, artifacts) {
  return artifacts.map((artifact) => {
    const kind = artifact?.kind && ARTIFACT_KIND_RE.test(artifact.kind)
      ? artifact.kind
      : 'artifact';
    if (!artifact?.pointer) throw new Error('context artifact pointer is required');
    return { kind, pointer: normalizeRepoPointer(repoRoot, artifact.pointer) };
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
  const text = requireSingleLine(String(value ?? '').trim(), 'pointer');
  if (!text) throw new Error('pointer must not be empty');
  if (/[\u0000-\u001F]/.test(text)) {
    throw new Error('artifact pointers must not contain control characters');
  }
  const candidate = isAbsolute(text) ? resolve(text) : resolve(repoRoot, text);
  assertInsideSync(repoRoot, candidate, 'Artifact path escapes repo root');
  return pointer(repoRoot, candidate);
}

function dedupeArtifacts(artifacts) {
  const seen = new Set();
  const out = [];
  for (const artifact of artifacts) {
    const key = `${artifact.kind}\0${artifact.pointer}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(artifact);
  }
  return out;
}

function contextStatusCommand(host, runId) {
  if (host === 'claude') return `/runtime:context status --run-id ${runId}`;
  if (host === 'codex') return `$runtime:context status --run-id ${runId}`;
  return `runtime:context status --run-id ${runId}`;
}

function formatContextLookup(lookup) {
  const selected = lookup.selected_at ?? 'unknown';
  const age = lookup.age_minutes === null ? 'unknown' : `${lookup.age_minutes} minutes`;
  return [
    `- mode: ${lookup.mode}`,
    `- latest: ${lookup.latest}`,
    `- selected_at: ${selected}`,
    `- age: ${age}`,
    `- stale: ${lookup.stale}`,
    `- stale_after_ms: ${lookup.stale_after_ms}`,
    `- skipped_invalid: ${lookup.skipped_invalid}`,
  ].join('\n');
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

function roundOne(value) {
  return Math.round(value * 10) / 10;
}

function defaultNextAction(stateValue) {
  const state = validateContextState(stateValue);
  if (state === 'green') {
    return 'Continue in the current session only for small follow-up work; keep artifact pointers available.';
  }
  if (state === 'red') {
    return 'Start a fresh session with the next-session prompt pointer before substantial follow-up work.';
  }
  return 'Prefer a fresh or resumed session with the next-session prompt pointer before substantial follow-up work.';
}

function footerLimits() {
  return [
    'Advisory only; this footer does not mutate host session context or workflow state.',
    'Artifact and prompt bodies are pointer-only in the footer.',
    'Peer raw output and consensus raw output must stay in runtime artifacts, not in the main session footer.',
    'Codex manual-hook and permission limits are not represented as host parity.',
  ];
}

function validateHost(value) {
  if (!VALID_HOSTS.has(value)) {
    throw new Error('--host must be claude, codex, or neutral');
  }
  return value;
}

function validateContextState(value) {
  if (!VALID_CONTEXT_STATES.has(value)) {
    throw new Error('--context-state must be green, yellow, or red');
  }
  return value;
}

function validateEnum(value, valid, message) {
  if (!valid.has(value)) throw new Error(message);
  return value;
}

function validateRunId(runId) {
  if (!RUN_ID_RE.test(runId)) {
    throw new Error('Invalid --context-run-id; expected context-YYYYMMDDTHHMMSSZ-abcdef');
  }
  return runId;
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

function parseNonNegativeInteger(value, flag) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) throw new Error(`${flag} must be a non-negative integer`);
  return Number.parseInt(text, 10);
}

function contextRoot(repoRoot) {
  return resolve(repoRoot, '.agentic-plugins', 'runs', 'context');
}

function pointer(repoRoot, path) {
  const rel = relative(repoRoot, path).split(sep).join('/');
  return rel || basename(path);
}

function assertInsideSync(root, candidate, message) {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  const rel = relative(rootPath, candidatePath);
  if (rel.startsWith('..') || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(message);
  }
}

function helpText() {
  return `runtime footer ${VERSION}

Usage:
  runtime footer render [--format text|json] [--host claude|codex|neutral]
  runtime footer render --context-run-id <context-run-id> --workflow-id <id>
  runtime footer render --context-latest [--stale-after-hours <n>] --workflow-id <id>
  runtime footer render --context-state green|yellow|red --recommended-next-work <text>
  runtime footer render --pr-handling --pr-completion-boundary reached --pr-validation-state passed --pr-review-state clear --pr-branch-state pushable

Renders an advisory, pointer-only completion footer. It reads optional
runtime:context artifacts but does not mutate host session context, workflow
state, or pull request state.`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(helpText());
    return;
  }
  const report = await runFooter(options);
  if (options.format === 'json') {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatText(report));
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`runtime:footer: ${error.message}`);
    process.exitCode = 1;
  });
}
