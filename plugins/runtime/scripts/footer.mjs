#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runConsensus } from './consensus.mjs';
import { buildHandoffGuidance } from './context.mjs';
import { buildSourceFreshness, formatSourceFreshness, resolveSourceSnapshot } from './source-snapshot.mjs';
import { RUNTIME_VERSION } from './version.mjs';

const VERSION = RUNTIME_VERSION;
const VALID_HOSTS = new Set(['claude', 'codex', 'neutral']);
const VALID_CONTEXT_STATES = new Set(['green', 'yellow', 'red']);
const VALID_COMPLETION_STATES = new Set([
  'review-needed',
  'publish-needed',
  'cleanup-needed',
  'next-work-available',
  'blocked',
  'closed',
]);
const VALID_PR_COMPLETION_BOUNDARIES = new Set(['reached', 'not-reached', 'unknown']);
const VALID_PR_VALIDATION_STATES = new Set(['passed', 'waived', 'failed', 'not-run', 'unknown']);
const VALID_PR_REVIEW_STATES = new Set(['clear', 'blocking', 'unknown']);
const VALID_PR_BRANCH_STATES = new Set(['pushable', 'not-pushable', 'unknown']);
const VALID_OMCC_ACTIVITY = new Set(['yes', 'no', 'unknown']);
const CONTEXT_RUN_ID_RE = /^context-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const CONSENSUS_RUN_ID_RE = /^consensus-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const ARTIFACT_KIND_RE = /^[A-Za-z0-9._-]+$/;
const DEFAULT_HANDOFF_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export async function runFooter(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const host = validateHost(options.host ?? 'neutral');
  const context = options.contextRunId || options.contextLatest
    ? await readContextArtifact(repoRoot, {
        runId: options.contextRunId,
        latest: options.contextLatest === true,
        host,
        now: options.now ?? new Date(),
        staleAfterMs: options.staleAfterMs ?? DEFAULT_HANDOFF_STALE_AFTER_MS,
        currentSourceSnapshot: options.currentSourceSnapshot,
      })
    : null;
  const consensus = options.consensusRunId || options.consensusLatest
    ? await readConsensusStatus(repoRoot, {
        runId: options.consensusRunId,
        latest: options.consensusLatest === true,
        host,
      })
    : null;

  const contextState = validateContextState(
    options.contextState ?? context?.contextState ?? 'yellow',
  );
  const workflow = normalizeWorkflow(repoRoot, options);
  const providedArtifacts = normalizeArtifacts(repoRoot, options.artifacts ?? []);
  const artifacts = dedupeArtifacts([
    ...contextArtifacts(context),
    ...consensusArtifacts(consensus),
    ...workflowArtifacts(workflow),
    ...providedArtifacts,
  ]);
  const nextSession = normalizeNextSession({ host, context, consensus, options });
  const prHandling = shouldIncludePrHandling(options)
    ? buildPrHandlingReadiness({ contextState, options })
    : null;
  const recommendedNextWork = normalizeRecommendedNextWork(options, consensus);
  const completion = buildCompletionState({
    options,
    contextState,
    consensus,
    prHandling,
    recommendedNextWork,
  });
  const effectiveRecommendedNextWork = isDefaultRecommendedNextWork({
    options,
    consensus,
    recommendedNextWork,
  })
    ? completion.next_action
    : recommendedNextWork;
  const cutoverRecord = shouldIncludeCutoverRecord(options)
    ? buildCutoverRecordGuidance({ host, completion, options })
    : null;

  return {
    command: 'render',
    version: VERSION,
    advisory: true,
    context_state: contextState,
    completion_state: completion.state,
    completion,
    context: context
      ? {
          run_id: context.runId,
          pointer: context.contextPointer,
          lookup: context.lookup,
        }
      : null,
    consensus: consensus
      ? {
          run_id: consensus.runId,
          status: consensus.status,
          run_pointer: consensus.runPointer,
          manifest_pointer: consensus.manifestPointer,
          consensus_pointer: consensus.consensusPointer,
          owner_decision_pointer: consensus.ownerDecisionPointer,
          execution_pointer: consensus.executionPointer,
          progress_pointer: consensus.progressPointer,
          lookup: consensus.lookup,
          status_guidance: consensus.statusGuidance,
        }
      : null,
    workflow,
    artifacts,
    recommended_next_work: effectiveRecommendedNextWork,
    next_session: nextSession,
    pr_handling: prHandling,
    cutover_record: cutoverRecord,
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
      case '--consensus-run-id':
        options.consensusRunId = validateConsensusRunId(requireValue(args, arg));
        break;
      case '--consensus-latest':
        options.consensusLatest = true;
        break;
      case '--stale-after-hours':
        options.staleAfterMs = parseNonNegativeInteger(requireValue(args, arg), arg) * 60 * 60 * 1000;
        break;
      case '--context-state':
        options.contextState = validateContextState(requireValue(args, arg));
        break;
      case '--completion-state':
        options.completionState = validateCompletionState(requireValue(args, arg));
        break;
      case '--completion-reason':
        options.completionReason = requireSingleLine(requireValue(args, arg), arg);
        break;
      case '--completion-next-action':
        options.completionNextAction = requireSingleLine(requireValue(args, arg), arg);
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
      case '--cutover-record':
        options.cutoverRecord = true;
        break;
      case '--cutover-omcc-dev-active':
        options.cutoverOmccDevActive = validateEnum(
          requireValue(args, arg),
          VALID_OMCC_ACTIVITY,
          `${arg} must be yes, no, or unknown`,
        );
        break;
      case '--cutover-omcc-dev-note':
        options.cutoverOmccDevNote = requireSingleLine(requireValue(args, arg), arg);
        break;
      case '--cutover-dogfood-date':
        options.cutoverDogfoodDate = validateDate(requireValue(args, arg), arg);
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
  if (options.consensusRunId && options.consensusLatest) {
    throw new Error('Use either --consensus-run-id or --consensus-latest, not both');
  }
  return options;
}

export function formatText(report) {
  if (report.help) return helpText();
  const lines = ['Runtime completion footer (advisory)'];
  lines.push(`context state: ${report.context_state}`);
  lines.push(`completion state: ${report.completion_state}`);
  if (report.completion?.reason) lines.push(`completion reason: ${report.completion.reason}`);
  if (report.completion?.next_action) lines.push(`completion next action: ${report.completion.next_action}`);
  if (report.context?.pointer) lines.push(`context artifact: ${report.context.pointer}`);
  if (report.context?.lookup) {
    lines.push('context lookup:');
    lines.push(formatContextLookup(report.context.lookup));
  }
  if (report.consensus) {
    lines.push(`consensus: ${report.consensus.run_id}; status=${report.consensus.status}`);
    if (report.consensus.lookup) {
      lines.push('consensus lookup:');
      lines.push(formatConsensusLookup(report.consensus.lookup));
    }
    if (report.consensus.run_pointer) lines.push(`consensus run: ${report.consensus.run_pointer}`);
    if (report.consensus.manifest_pointer) lines.push(`consensus manifest: ${report.consensus.manifest_pointer}`);
    if (report.consensus.consensus_pointer) lines.push(`consensus result: ${report.consensus.consensus_pointer}`);
    if (report.consensus.owner_decision_pointer) lines.push(`consensus owner decision: ${report.consensus.owner_decision_pointer}`);
    if (report.consensus.execution_pointer) lines.push(`consensus execution: ${report.consensus.execution_pointer}`);
    if (report.consensus.progress_pointer) lines.push(`consensus progress: ${report.consensus.progress_pointer}`);
    if (report.consensus.status_guidance) {
      lines.push(`consensus guidance: ${report.consensus.status_guidance.state}`);
      if (report.consensus.status_guidance.reason) {
        lines.push(`consensus reason: ${report.consensus.status_guidance.reason}`);
      }
      if (report.consensus.status_guidance.next_action) {
        lines.push(`consensus next action: ${report.consensus.status_guidance.next_action}`);
      }
      if (report.consensus.status_guidance.next_steps?.length) {
        lines.push('consensus next steps:');
        for (const step of report.consensus.status_guidance.next_steps) lines.push(`- ${step}`);
      }
    }
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
  if (report.cutover_record) {
    lines.push('cutover record:');
    lines.push(`- status: ${report.cutover_record.status}`);
    lines.push(`- recommended: ${report.cutover_record.recommended}`);
    lines.push(`- footer_state: ${report.cutover_record.footer_state}`);
    lines.push(`- omcc_dev_active: ${report.cutover_record.omcc_dev_active ?? '<missing>'}`);
    if (report.cutover_record.dogfood_date) lines.push(`- dogfood_date: ${report.cutover_record.dogfood_date}`);
    if (report.cutover_record.command) lines.push(`- command: ${report.cutover_record.command}`);
    if (report.cutover_record.next_action) lines.push(`- next_action: ${report.cutover_record.next_action}`);
    for (const limit of report.cutover_record.limits ?? []) lines.push(`- limit: ${limit}`);
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
  const selection = latest
    ? await findLatestContextArtifact(repoRoot)
    : {
        runId: validateRunId(options.runId),
        contextPath: resolve(contextRoot(repoRoot), validateRunId(options.runId), 'context.json'),
        skippedInvalid: 0,
      };
  const runId = selection.runId;
  const contextPath = selection.contextPath;
  assertInsideSync(contextRoot(repoRoot), contextPath, 'Context artifact path escapes context root');
  const artifact = JSON.parse(await readFile(contextPath, 'utf8'));
  const currentSourceSnapshot = await resolveSourceSnapshot({
    repoRoot,
    snapshot: options.currentSourceSnapshot,
    observedAt: toIso(options.now),
  });
  const state = validateContextState(artifact.context?.risk_level ?? 'yellow');
  const promptPointer = artifact.next_session?.prompt_pointer
    ? normalizeRepoPointer(repoRoot, artifact.next_session.prompt_pointer)
    : null;
  const lookup = buildContextLookup({
    artifact,
    runId,
    latest,
    now: options.now,
    staleAfterMs: options.staleAfterMs,
    skippedInvalid: selection.skippedInvalid,
    currentSourceSnapshot,
  });
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
    lookup: localizeContextLookupCommands(lookup, options.host ?? 'neutral'),
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
    if (!entry.isDirectory() || !CONTEXT_RUN_ID_RE.test(entry.name)) continue;
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

async function selectLatestConsensusRun(repoRoot) {
  const root = consensusRoot(repoRoot);
  const entries = await readdir(root, { withFileTypes: true });
  const candidates = [];
  let skippedInvalid = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !CONSENSUS_RUN_ID_RE.test(entry.name)) continue;
    const manifestPath = resolve(root, entry.name, 'manifest.json');
    try {
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      const selectedAt = consensusTimestampMs(manifest, entry.name);
      if (selectedAt === null) {
        skippedInvalid++;
        continue;
      }
      candidates.push({
        runId: entry.name,
        manifestPath,
        selectedAt,
      });
    } catch {
      skippedInvalid++;
    }
  }

  if (candidates.length === 0) {
    throw new Error(`No readable consensus runs found under ${pointer(repoRoot, root)}`);
  }

  candidates.sort((a, b) => b.selectedAt - a.selectedAt || b.runId.localeCompare(a.runId));
  return { ...candidates[0], skippedInvalid };
}

async function readConsensusStatus(repoRoot, { runId, latest, host }) {
  const selected = latest
    ? await selectLatestConsensusRun(repoRoot)
    : { runId: validateConsensusRunId(runId), selectedAt: null, skippedInvalid: 0 };
  const status = await runConsensus({
    command: 'status',
    repoRoot,
    runId: selected.runId,
  });
  return {
    runId: status.run_id,
    status: status.status,
    runPointer: status.run_pointer,
    manifestPointer: status.manifest_pointer,
    consensusPointer: status.consensus_pointer,
    ownerDecisionPointer: status.owner_decision_pointer,
    executionPointer: status.execution_pointer,
    progressPointer: status.progress_pointer,
    statusGuidance: localizeStatusGuidanceCommands(status.status_guidance, host ?? 'neutral'),
    lookup: buildConsensusLookup({
      latest,
      selectedAt: selected.selectedAt,
      skippedInvalid: selected.skippedInvalid,
    }),
  };
}

function buildContextLookup({
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
  const stale = ageMs === null ? null : ageMs > staleAfterMs;
  const sourceFreshness = buildSourceFreshness({
    artifactSnapshot: artifact.source_snapshot,
    currentSnapshot: currentSourceSnapshot,
  });
  return {
    mode: latest ? 'latest' : 'run-id',
    latest,
    selected_at: selectedAt === null ? null : new Date(selectedAt).toISOString(),
    age_ms: ageMs,
    age_minutes: ageMs === null ? null : roundOne(ageMs / 60000),
    stale_after_ms: staleAfterMs,
    stale,
    skipped_invalid: skippedInvalid,
    source_freshness: sourceFreshness,
    guidance: buildHandoffGuidance({ runId, stale, sourceFreshness }),
  };
}

function buildConsensusLookup({ latest, selectedAt, skippedInvalid }) {
  return {
    mode: latest ? 'latest' : 'run-id',
    latest,
    selected_at: selectedAt === null ? null : new Date(selectedAt).toISOString(),
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

function consensusArtifacts(consensus) {
  if (!consensus) return [];
  return [
    { kind: 'consensus-run', pointer: consensus.runPointer },
    { kind: 'consensus-manifest', pointer: consensus.manifestPointer },
    consensus.consensusPointer ? { kind: 'consensus-result', pointer: consensus.consensusPointer } : null,
    consensus.ownerDecisionPointer ? { kind: 'consensus-owner-decision', pointer: consensus.ownerDecisionPointer } : null,
    consensus.executionPointer ? { kind: 'consensus-execution', pointer: consensus.executionPointer } : null,
    consensus.progressPointer ? { kind: 'consensus-progress', pointer: consensus.progressPointer } : null,
  ].filter(Boolean);
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

function normalizeRecommendedNextWork(options, consensus) {
  if (options.recommendedNextWork) {
    return requireSingleLine(options.recommendedNextWork, '--recommended-next-work');
  }
  if (consensus?.statusGuidance?.next_action) {
    return requireSingleLine(consensus.statusGuidance.next_action, 'consensus next action');
  }
  return defaultRecommendedNextWork();
}

function isDefaultRecommendedNextWork({ options, consensus, recommendedNextWork }) {
  return !options.recommendedNextWork
    && !consensus?.statusGuidance?.next_action
    && recommendedNextWork === defaultRecommendedNextWork();
}

function defaultRecommendedNextWork() {
  return 'Review the completion result and choose the next command explicitly.';
}

function normalizeNextSession({ host, context, consensus, options }) {
  const action = options.nextSessionAction
    ? requireSingleLine(options.nextSessionAction, '--next-session-action')
    : options.completionState === 'closed'
      ? 'No next session is required from this footer evidence.'
      : context?.nextSession.action ?? defaultNextAction(options.contextState ?? context?.contextState ?? 'yellow');
  const command = options.nextSessionCommand
    ? requireSingleLine(options.nextSessionCommand, '--next-session-command')
    : context
      ? contextStatusCommand(host, context.runId)
      : consensus
        ? consensusStatusCommand(host, consensus.runId)
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

function shouldIncludeCutoverRecord(options) {
  return options.cutoverRecord === true
    || options.cutoverOmccDevActive !== undefined
    || options.cutoverOmccDevNote !== undefined
    || options.cutoverDogfoodDate !== undefined;
}

function buildCutoverRecordGuidance({ host, completion, options }) {
  const omccDevActive = options.cutoverOmccDevActive ?? null;
  const dogfoodDate = options.cutoverDogfoodDate ?? null;
  const note = options.cutoverOmccDevNote ?? null;
  const status = omccDevActive ? 'ready' : 'needs-operator-evidence';
  const command = omccDevActive
    ? cutoverRecordCommand(host, {
        footerState: completion.state,
        footerReason: completion.reason,
        omccDevActive,
        omccDevNote: note,
        dogfoodDate,
      })
    : null;
  return {
    status,
    recommended: Boolean(command),
    footer_state: completion.state,
    footer_reason: completion.reason,
    omcc_dev_active: omccDevActive,
    omcc_dev_note: note,
    dogfood_date: dogfoodDate,
    command,
    next_action: command
      ? 'Run the cutover record command only if the footer state and omcc-dev activity statement are accurate for this work session.'
      : 'Provide --cutover-omcc-dev-active yes|no|unknown before using footer guidance to record dogfood evidence.',
    limits: [
      'The footer only renders a suggested runtime:cutover record command; it does not write cutover evidence.',
      'Do not record omcc-dev-active=no unless the current work session actually avoided omcc-dev.',
    ],
  };
}

function cutoverRecordCommand(host, { footerState, footerReason, omccDevActive, omccDevNote, dogfoodDate }) {
  const command = runtimeCommand(host, 'cutover record');
  const parts = [
    command,
    '--footer-state',
    quoteCommandArg(footerState),
    '--footer-reason',
    quoteCommandArg(footerReason),
    '--omcc-dev-active',
    quoteCommandArg(omccDevActive),
  ];
  if (omccDevNote) {
    parts.push('--omcc-dev-note', quoteCommandArg(omccDevNote));
  }
  if (dogfoodDate) {
    parts.push('--dogfood-date', quoteCommandArg(dogfoodDate));
  }
  return parts.join(' ');
}

function runtimeCommand(host, command) {
  if (host === 'claude') return `/runtime:${command}`;
  if (host === 'codex') return `$runtime:${command}`;
  return `runtime:${command}`;
}

function quoteCommandArg(value) {
  const text = requireSingleLine(String(value ?? ''), 'command argument');
  if (/^[A-Za-z0-9._:@%+=,/-]+$/.test(text)) return text;
  return `"${text.replace(/(["\\$`])/g, '\\$&')}"`;
}

function buildCompletionState({ options, contextState, consensus, prHandling, recommendedNextWork }) {
  const state = options.completionState
    ? validateCompletionState(options.completionState)
    : inferCompletionState({ contextState, consensus, prHandling, recommendedNextWork });
  const reason = options.completionReason
    ? requireSingleLine(options.completionReason, '--completion-reason')
    : defaultCompletionReason({ state, contextState, consensus, prHandling, recommendedNextWork });
  const nextAction = options.completionNextAction
    ? requireSingleLine(options.completionNextAction, '--completion-next-action')
    : defaultCompletionNextAction({ state, consensus, prHandling, recommendedNextWork });
  return {
    state,
    source: options.completionState ? 'explicit' : 'inferred',
    reason,
    next_action: nextAction,
  };
}

function inferCompletionState({ contextState, consensus, prHandling, recommendedNextWork }) {
  if (prHandling?.recommendation === 'block') return 'blocked';
  if (isBlockingConsensusGuidance(consensus?.statusGuidance?.state)) return 'blocked';
  if (prHandling?.recommendation === 'ask-user') return 'publish-needed';
  if (prHandling?.recommendation === 'defer') return 'review-needed';
  if (contextState === 'red') return 'review-needed';
  if (isActionableConsensusGuidance(consensus?.statusGuidance?.state)) return 'next-work-available';
  if (recommendedNextWork !== defaultRecommendedNextWork()) return 'next-work-available';
  return 'review-needed';
}

function isBlockingConsensusGuidance(state) {
  return [
    'blocked',
    'evidence_required',
    'execution_stalled',
    'inspect_failure',
    'non_consensus',
    'operator_action_required',
    'owner_decision_required',
  ].includes(state);
}

function isActionableConsensusGuidance(state) {
  return [
    'complete',
    'execute_or_record',
    'execution_running',
    'next_round_available',
    'owner_decided',
    'record_manual_peers',
    'retry_failed_peers',
    'synthesize',
  ].includes(state);
}

function defaultCompletionReason({ state, contextState, consensus, prHandling, recommendedNextWork }) {
  if (state === 'blocked') {
    if (prHandling?.recommendation === 'block') return 'PR handling has a failed readiness criterion.';
    if (consensus?.statusGuidance?.state) return `Consensus guidance is ${consensus.statusGuidance.state}.`;
    return 'A required operator, validation, review, permission, or evidence precondition is blocked.';
  }
  if (state === 'publish-needed') return 'PR handling readiness passed and the user should decide whether to publish.';
  if (state === 'cleanup-needed') return 'Caller reported that cleanup is the next required action.';
  if (state === 'next-work-available') {
    if (consensus?.statusGuidance?.state) return `Consensus guidance is ${consensus.statusGuidance.state}.`;
    if (recommendedNextWork !== defaultRecommendedNextWork()) return 'Caller supplied recommended next work.';
    return 'Follow-up work is available from the current runtime evidence.';
  }
  if (state === 'closed') return 'Caller explicitly reported that no repo, PR, release, cleanup, or planned follow-up work remains.';
  if (contextState === 'red') return 'Context risk is red; review or fresh-session handoff is needed before substantial follow-up.';
  if (prHandling?.recommendation === 'defer') return 'PR handling evidence is incomplete.';
  return 'Completion evidence should be reviewed before choosing the next action.';
}

function defaultCompletionNextAction({ state, consensus, prHandling, recommendedNextWork }) {
  if (state === 'blocked') {
    if (consensus?.statusGuidance?.next_action) return consensus.statusGuidance.next_action;
    if (prHandling?.recommendation === 'block') return 'Resolve failed PR handling criteria before publishing or closing the slice.';
    return 'Resolve the blocking precondition, then rerun the relevant runtime check.';
  }
  if (state === 'publish-needed') return 'Ask the user whether to commit, push, open or update a PR, defer publishing, or continue without PR handling.';
  if (state === 'cleanup-needed') return 'Clean up merged branches, stale worktrees, plugin/cache drift, or release follow-ups before starting the next slice.';
  if (state === 'next-work-available') return recommendedNextWork;
  if (state === 'closed') return 'No further repo, PR, release, cleanup, or planned follow-up action is known from this footer evidence.';
  return 'Review validation, artifacts, context, consensus, and PR readiness evidence before choosing the next command.';
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

function consensusStatusCommand(host, runId) {
  if (host === 'claude') return `/runtime:consensus status --run-id ${runId}`;
  if (host === 'codex') return `$runtime:consensus status --run-id ${runId}`;
  return `runtime:consensus status --run-id ${runId}`;
}

function formatContextLookup(lookup) {
  const selected = lookup.selected_at ?? 'unknown';
  const age = lookup.age_minutes === null ? 'unknown' : `${lookup.age_minutes} minutes`;
  const lines = [
    `- mode: ${lookup.mode}`,
    `- latest: ${lookup.latest}`,
    `- selected_at: ${selected}`,
    `- age: ${age}`,
    `- stale: ${lookup.stale}`,
    `- stale_after_ms: ${lookup.stale_after_ms}`,
    `- skipped_invalid: ${lookup.skipped_invalid}`,
  ];
  if (lookup.source_freshness) {
    lines.push(...formatSourceFreshness(lookup.source_freshness));
  }
  if (lookup.guidance) {
    lines.push(
      `context handoff guidance: ${lookup.guidance.state}`,
      `- recommended_session: ${lookup.guidance.recommended_session}`,
      `- reason: ${lookup.guidance.reason}`,
      `- recommended_action: ${lookup.guidance.recommended_action}`,
    );
    for (const command of lookup.guidance.commands ?? []) {
      lines.push(`context handoff command: ${command}`);
    }
  }
  return lines.join('\n');
}

function formatConsensusLookup(lookup) {
  const selected = lookup.selected_at ?? 'unknown';
  return [
    `- mode: ${lookup.mode}`,
    `- latest: ${lookup.latest}`,
    `- selected_at: ${selected}`,
    `- skipped_invalid: ${lookup.skipped_invalid}`,
  ].join('\n');
}

function localizeContextLookupCommands(lookup, host) {
  if (!lookup?.guidance) return lookup;
  return {
    ...lookup,
    guidance: {
      ...lookup.guidance,
      commands: localizeCommandList(lookup.guidance.commands, host),
    },
  };
}

function localizeStatusGuidanceCommands(guidance, host) {
  if (!guidance) return guidance;
  return {
    ...guidance,
    next_steps: localizeCommandList(guidance.next_steps, host),
    commands: localizeCommandList(guidance.commands, host),
  };
}

function localizeCommandList(values, host) {
  return (values ?? []).map((value) => localizeRuntimeCommands(value, host));
}

function localizeRuntimeCommands(value, host) {
  if (!value || host === 'neutral') return value;
  const prefix = host === 'claude' ? '/' : '$';
  return String(value).replace(
    /(^|[\s`"'([])(runtime:[A-Za-z0-9:_-]+)/g,
    (_match, leading, command) => `${leading}${prefix}${command}`,
  );
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
    'Codex plugin-hook feature/trust state and permission limits are not represented as host parity.',
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

function validateCompletionState(value) {
  if (!VALID_COMPLETION_STATES.has(value)) {
    throw new Error('--completion-state must be review-needed, publish-needed, cleanup-needed, next-work-available, blocked, or closed');
  }
  return value;
}

function validateEnum(value, valid, message) {
  if (!valid.has(value)) throw new Error(message);
  return value;
}

function validateRunId(runId) {
  if (!CONTEXT_RUN_ID_RE.test(runId)) {
    throw new Error('Invalid --context-run-id; expected context-YYYYMMDDTHHMMSSZ-abcdef');
  }
  return runId;
}

function validateConsensusRunId(runId) {
  if (!CONSENSUS_RUN_ID_RE.test(runId)) {
    throw new Error('Invalid --consensus-run-id; expected consensus-YYYYMMDDTHHMMSSZ-abcdef');
  }
  return runId;
}

function validateDate(value, flag) {
  const text = String(value ?? '').trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error(`${flag} must be YYYY-MM-DD`);
  const [, year, month, day] = match;
  const date = new Date(`${text}T00:00:00.000Z`);
  if (
    !Number.isFinite(date.getTime())
    || date.getUTCFullYear() !== Number.parseInt(year, 10)
    || date.getUTCMonth() + 1 !== Number.parseInt(month, 10)
    || date.getUTCDate() !== Number.parseInt(day, 10)
  ) {
    throw new Error(`${flag} must be a valid calendar date`);
  }
  return text;
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

function consensusRoot(repoRoot) {
  return resolve(repoRoot, '.agentic-plugins', 'runs', 'consensus');
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

function toIso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value ?? Date.now()).toISOString();
}

function helpText() {
  return `runtime footer ${VERSION}

Usage:
  runtime footer render [--format text|json] [--host claude|codex|neutral]
  runtime footer render --context-run-id <context-run-id> --workflow-id <id>
  runtime footer render --context-latest [--stale-after-hours <n>] --workflow-id <id>
  runtime footer render --consensus-run-id <consensus-run-id>
  runtime footer render --consensus-latest
  runtime footer render --context-state green|yellow|red --recommended-next-work <text>
  runtime footer render --completion-state review-needed|publish-needed|cleanup-needed|next-work-available|blocked|closed
  runtime footer render --pr-handling --pr-completion-boundary reached --pr-validation-state passed --pr-review-state clear --pr-branch-state pushable
  runtime footer render --cutover-record --cutover-omcc-dev-active yes|no|unknown

Renders an advisory, pointer-only completion footer. It reads optional
runtime:context artifacts and runtime:consensus status guidance when available, but
does not mutate host session context, workflow state, git state, or pull
request state. Cutover record guidance renders only a suggested
runtime:cutover record command; it does not write cutover evidence. Completion
state is advisory; closed is emitted only when the caller supplies
--completion-state closed.`;
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
