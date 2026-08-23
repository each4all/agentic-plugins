#!/usr/bin/env node

import { readdir, readFile } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runConsensus } from './consensus.mjs';
import { buildHandoffGuidance, evaluateSessionHandoff, loadWorkflowProjection } from './context.mjs';
import {
  isLocalizationHost,
  localizeCommandFields,
  localizeCommandList,
  localizePluginCommands,
} from './lib/host-localization.mjs';
import { buildSourceFreshness, formatSourceFreshness, resolveSourceSnapshot } from './source-snapshot.mjs';
import { RUNTIME_VERSION } from './version.mjs';

const VERSION = RUNTIME_VERSION;
const VALID_CONTEXT_STATES = new Set(['green', 'yellow', 'red']);
// Provenance for the context risk value, reported on TWO independent axes so
// neither one has to answer the other's question. The risk enum above stays
// green|yellow|red — provenance is never an extra enum member, so every
// downstream consumer that switches on the risk keeps working.
//
//   context_state_measurement — the epistemic basis for the value:
//     measured   — the caller ASSERTS a real context-budget measurement backs it.
//                  Runtime cannot verify this; it is caller-attested, not observed.
//     unmeasured — no measurement backs it (a caller's deliberate value, or
//                  runtime's own fallback).
//     unknown    — the value was recorded elsewhere and its basis is not knowable
//                  from what was recorded (a context artifact, see below).
//
//   context_state_origin — where the value physically came from:
//     caller | context-artifact | runtime-default
//
// The two axes are deliberately not collapsed: a context artifact records a
// risk_level but nothing that says whether that level was measured, declared, or
// itself defaulted, so its ORIGIN is knowable while its MEASUREMENT is not.
// Collapsing them would launder a stored default into a measurement claim.
const VALID_CONTEXT_MEASUREMENTS = new Set(['measured', 'unmeasured', 'unknown']);
const VALID_CONTEXT_ORIGINS = new Set(['caller', 'context-artifact', 'runtime-default']);
// Only `measured` and `declared` are caller-selectable. There is deliberately NO
// caller-selectable `default`: the honest way to say "I measured nothing" is to
// pass no value at all, which needs no flag and therefore no version floor. A
// caller-selectable default also created a split-brain — `--context-state red
// --context-state-source default` would have let red drive PR readiness and
// completion while the session handoff re-derived yellow.
const VALID_CONTEXT_STATE_SOURCE_FLAGS = new Set(['measured', 'declared']);
const UNMEASURED_CONTEXT_REPORT = 'unmeasured (no budget sensor)';
// The ONE definition of the conservative fallback. Runtime measures nothing, so
// every path that needs a value without an observation must reach for this
// constant rather than re-deriving `'yellow'` inline — that inline re-derivation
// is how the fabricated value used to enter from several places at once.
const CONSERVATIVE_CONTEXT_STATE = 'yellow';
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
  const consensus = options.consensusRunId || options.consensusLatest || options.consensusLatestOpen
    ? await readConsensusStatus(repoRoot, {
        runId: options.consensusRunId,
        latest: options.consensusLatest === true,
        latestOpen: options.consensusLatestOpen === true,
        host,
      })
    : null;

  // Honesty seam: ONE resolution of the context risk + its provenance, used by
  // every consumer below. Previously this was a `??` chain that collapsed three
  // different provenances into one indistinguishable enum value, and a SECOND
  // copy of the same chain lived in normalizeNextSession() — so a fabricated
  // default could not be told apart from a real measurement anywhere downstream.
  const contextStateResolution = resolveContextState({ options, context });
  const contextState = contextStateResolution.state;
  // ADR-0031 — an optional bounded workflow projection enriches the workflow
  // fields and drives the session-level continue-vs-fresh decision. When no
  // projection file is supplied the footer degrades to the per-field workflow
  // flags and omits session_handoff entirely (rollback-safe, additive).
  const projectionRequested = options.workflowProjectionFile != null;
  const { projection, error: projectionError, unsupportedKind, unsupportedRouting } = projectionRequested
    ? await loadWorkflowProjection(options)
    : { projection: null, error: null };
  // When a projection was requested but rejected, degrade cleanly: do NOT fall
  // back to the legacy --workflow-* flags (the caller opted into the projection
  // model). The per-field flags apply only when no projection was requested.
  const workflow = projectionRequested
    ? (projection ? normalizeWorkflow(repoRoot, options, projection) : { kind: null, id: null, path: null })
    : normalizeWorkflow(repoRoot, options, null);
  const sessionHandoff = projectionRequested
    ? evaluateSessionHandoff({
        // The VALUE always goes through — passing null to signal "unsupplied"
        // would collide with the evaluator's all-inputs-absent early return and
        // drop session_handoff entirely whenever a projection was malformed,
        // which the persona sidecars read as fail-closed (no footer at all).
        // The supplied FACT travels on its own parameter instead, so the
        // decision is unchanged while the claim becomes honest.
        riskLevel: contextState,
        riskSupplied: contextStateResolution.supplied,
        projection,
        // runtime-unsupported-kind: prefer the rejected projection's own routing
        // before any standalone --routing-recommendation, so a fresh handoff on
        // an unmodelable kind still names the resume command.
        routing: unsupportedRouting ?? options.routingRecommendation ?? null,
        unsupportedKind: unsupportedKind ?? null,
      })
    : null;
  const providedArtifacts = normalizeArtifacts(repoRoot, options.artifacts ?? []);
  const artifacts = dedupeArtifacts([
    ...contextArtifacts(context),
    ...consensusArtifacts(consensus),
    ...workflowArtifacts(workflow),
    ...providedArtifacts,
  ]);
  const nextSession = normalizeNextSession({ host, context, consensus, options, contextState });
  const prHandling = shouldIncludePrHandling(options)
    ? buildPrHandlingReadiness({ contextState, contextMeasurement: contextStateResolution.measurement, options })
    : null;
  // Completion-output contract: a whitespace-only completion flag is treated
  // as ABSENT (defaults + provenance fire), never as authored explicit
  // content — a blank marker-free line would be the exact silent degradation
  // the contract exists to expose. CLI enum parsing still rejects invalid
  // non-empty values upstream.
  const completionFlags = {
    completionState: presentFlag(options.completionState),
    completionReason: presentFlag(options.completionReason),
    completionNextAction: presentFlag(options.completionNextAction),
    recommendedNextWork: presentFlag(options.recommendedNextWork),
  };
  const recommendedNextWork = normalizeRecommendedNextWork(completionFlags, consensus);
  const recommendedNextWorkProvenance = completionFlags.recommendedNextWork
    ? 'explicit'
    : consensus?.statusGuidance?.next_action
      ? 'derived'
      : 'generic';
  const completion = buildCompletionState({
    options: completionFlags,
    contextState,
    consensus,
    prHandling,
    recommendedNextWork,
    recommendedNextWorkProvenance,
  });
  const recommendedNextWorkIsDefault = isDefaultRecommendedNextWork({
    options: completionFlags,
    consensus,
    recommendedNextWork,
  });
  const effectiveRecommendedNextWork = recommendedNextWorkIsDefault
    ? completion.next_action
    : recommendedNextWork;
  // When the recommended next work falls back to the completion next action it
  // inherits that field's provenance (an explicit --completion-next-action
  // reads as derived here — the content is caller-authored via another flag).
  const recommendedNextWorkSource = recommendedNextWorkIsDefault
    ? (completion.sources.next_action === 'explicit' ? 'derived' : completion.sources.next_action)
    : recommendedNextWorkProvenance;
  const cutoverRecord = shouldIncludeCutoverRecord(options)
    ? buildCutoverRecordGuidance({ host, completion, options })
    : null;

  // Host-localize the advisory surfaces that can carry plugin colon-commands:
  // the projection's persona routing (session handoff + workflow fields) and
  // the completion next-action / recommended-next-work path. Pointer/path
  // fields stay untouched, and object shapes are preserved (only existing
  // string fields are rewritten).
  const localizedWorkflow = localizeCommandFields(workflow, host, ['next_action', 'routing_recommendation']);
  const localizedSessionHandoff = sessionHandoff
    ? {
        ...localizeCommandFields(sessionHandoff, host, ['routing_recommendation', 'next_command']),
        workflow: localizeCommandFields(sessionHandoff.workflow, host, ['next_action']),
      }
    : sessionHandoff;
  const localizedCompletion = localizeCommandFields(completion, host, ['next_action']);

  const report = {
    command: 'render',
    version: VERSION,
    advisory: true,
    context_state: contextState,
    // Provenance is additive: `context_state` keeps meaning "the risk value the
    // rest of this footer reasoned with", and the fields below report the basis
    // for it and where it came from, on two independent axes.
    context_state_measurement: contextStateResolution.measurement,
    context_state_origin: contextStateResolution.origin,
    context_state_report: contextStateResolution.report,
    completion_state: localizedCompletion.state,
    completion: localizedCompletion,
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
          ratification_pointer: consensus.ratificationPointer,
          cancellation_pointer: consensus.cancellationPointer,
          execution_pointer: consensus.executionPointer,
          progress_pointer: consensus.progressPointer,
          lookup: consensus.lookup,
          status_guidance: consensus.statusGuidance,
        }
      : null,
    workflow: localizedWorkflow,
    artifacts,
    recommended_next_work: localizePluginCommands(effectiveRecommendedNextWork, host),
    recommended_next_work_source: recommendedNextWorkSource,
    next_session: nextSession,
    pr_handling: prHandling,
    cutover_record: cutoverRecord,
    limits: footerLimits(),
  };
  if (localizedSessionHandoff) report.session_handoff = localizedSessionHandoff;
  if (projectionError) report.projection_error = projectionError;
  return report;
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
      case '--workflow-projection-file':
        options.workflowProjectionFile = requireValue(args, arg);
        break;
      case '--routing-recommendation':
        options.routingRecommendation = requireSingleLine(requireValue(args, arg), arg);
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
      case '--consensus-latest-open':
        options.consensusLatestOpen = true;
        break;
      case '--stale-after-hours':
        options.staleAfterMs = parseNonNegativeInteger(requireValue(args, arg), arg) * 60 * 60 * 1000;
        break;
      case '--context-state':
        options.contextState = validateContextState(requireValue(args, arg));
        break;
      case '--context-state-source':
        options.contextStateSource = validateContextStateSource(requireValue(args, arg));
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
  const consensusSelectionCount = [
    options.consensusRunId,
    options.consensusLatest,
    options.consensusLatestOpen,
  ].filter(Boolean).length;
  if (consensusSelectionCount > 1) {
    throw new Error('Use only one of --consensus-run-id, --consensus-latest, or --consensus-latest-open');
  }
  return options;
}

// S9 completion-output contract — a generic runtime fallback must be visible
// in the rendered text (text-format only; JSON values stay unmarked).
function genericMarker(tier) {
  return tier === 'generic' ? ' [generic fallback]' : '';
}

export function formatText(report) {
  if (report.help) return helpText();
  const lines = ['Runtime completion footer (advisory)'];
  // An unmeasured default renders as unmeasured. Older reports (no provenance
  // field) keep the previous rendering, so this stays readable for any consumer
  // that hands an older payload to formatText.
  // The report string is runtime-authored in every branch. Artifact prose is
  // deliberately NOT echoed here: context.json is user-editable and unvalidated,
  // so a multi-line or oversized risk_reason could forge footer lines. The
  // artifact is already surfaced as a pointer, which is the footer's contract.
  lines.push(`context state: ${report.context_state_report ?? report.context_state}`);
  lines.push(`completion state: ${report.completion_state}${genericMarker(report.completion?.sources?.state)}`);
  if (report.completion?.reason) lines.push(`completion reason: ${report.completion.reason}${genericMarker(report.completion?.sources?.reason)}`);
  if (report.completion?.next_action) lines.push(`completion next action: ${report.completion.next_action}${genericMarker(report.completion?.sources?.next_action)}`);
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
    if (report.consensus.ratification_pointer) lines.push(`consensus owner ratification: ${report.consensus.ratification_pointer}`);
    if (report.consensus.cancellation_pointer) lines.push(`consensus cancellation: ${report.consensus.cancellation_pointer}`);
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
  if (report.workflow?.archive_gate) lines.push(`workflow archive gate: ${report.workflow.archive_gate}`);
  if (report.workflow?.checkpoint) {
    // The checkpoint summary is free text from the projection — collapse
    // control characters/newlines so it cannot inject fake footer lines
    // (text render is the trust boundary; the JSON report keeps the raw value).
    lines.push(`workflow checkpoint: ${singleLineText(report.workflow.checkpoint)}`);
  }
  if (report.session_handoff) {
    lines.push('session handoff (continue-vs-fresh):');
    lines.push(`- recommended session: ${report.session_handoff.recommended_session}`);
    lines.push(`- reason: ${report.session_handoff.reason}`);
    if (report.session_handoff.context_risk_supplied === false) {
      lines.push(`- context risk: ${report.session_handoff.context_risk} is runtime's conservative fallback, not a supplied or measured value`);
    }
    lines.push(`- archive gate: ${report.session_handoff.archive_gate} — ${report.session_handoff.archive_gate_report}`);
    if (report.session_handoff.unsupported_workflow_kind) {
      lines.push(`- unsupported workflow kind: ${report.session_handoff.unsupported_workflow_kind} (runtime cannot model it; enablement out of scope)`);
    }
    if (report.session_handoff.routing_recommendation) {
      lines.push(`- routing: ${report.session_handoff.routing_recommendation}`);
    }
    if (report.session_handoff.next_command) {
      lines.push(`- next command: ${report.session_handoff.next_command}`);
    }
  }
  if (report.projection_error) {
    lines.push(`workflow projection rejected (degraded to context-state only): ${report.projection_error}`);
  }
  if (report.artifacts?.length) {
    lines.push('artifacts:');
    for (const artifact of report.artifacts) {
      lines.push(`- ${artifact.kind}: ${artifact.pointer}`);
    }
  }
  lines.push(`recommended next work: ${report.recommended_next_work}${genericMarker(report.recommended_next_work_source)}`);
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
  // An artifact that records NO risk level has not recorded a context state —
  // substituting yellow here would manufacture exactly the fabricated value this
  // contract exists to expose, and would then report it as artifact-recorded.
  // Null propagates to the resolver, which reports it as unmeasured.
  const recordedState = artifact.context?.risk_level == null
    ? null
    : validateContextState(artifact.context.risk_level);
  const state = recordedState ?? CONSERVATIVE_CONTEXT_STATE;
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
    contextState: recordedState,
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

async function readConsensusStatus(repoRoot, { runId, latest, latestOpen, host }) {
  const status = await runConsensus({
    command: 'status',
    repoRoot,
    runId: latest || latestOpen ? undefined : validateConsensusRunId(runId),
    latest: latest === true,
    latestOpen: latestOpen === true,
  });
  return {
    runId: status.run_id,
    status: status.status,
    runPointer: status.run_pointer,
    manifestPointer: status.manifest_pointer,
    consensusPointer: status.consensus_pointer,
    ownerDecisionPointer: status.owner_decision_pointer,
    ratificationPointer: status.ratification_pointer,
    cancellationPointer: status.cancellation_pointer,
    executionPointer: status.execution_pointer,
    progressPointer: status.progress_pointer,
    statusGuidance: localizeStatusGuidanceCommands(status.status_guidance, host ?? 'neutral'),
    lookup: status.lookup,
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
    consensus.ratificationPointer ? { kind: 'consensus-owner-ratification', pointer: consensus.ratificationPointer } : null,
    consensus.cancellationPointer ? { kind: 'consensus-cancellation', pointer: consensus.cancellationPointer } : null,
    consensus.executionPointer ? { kind: 'consensus-execution', pointer: consensus.executionPointer } : null,
    consensus.progressPointer ? { kind: 'consensus-progress', pointer: consensus.progressPointer } : null,
  ].filter(Boolean);
}

function workflowArtifacts(workflow) {
  return workflow?.path ? [{ kind: 'workflow', pointer: workflow.path }] : [];
}

function normalizeWorkflow(repoRoot, options, projection = null) {
  // ADR-0031 — when a bounded projection is supplied it is the source for the
  // workflow fields (the owning plugin computed them from its own state);
  // otherwise degrade to the per-field --workflow-* flags (backward compat).
  if (projection) {
    return {
      kind: projection.workflow_kind,
      id: projection.workflow_id,
      path: projection.workflow_path
        ? normalizeRepoPointer(repoRoot, projection.workflow_path)
        : null,
      phase: projection.phase,
      next_action: projection.next_action,
      checkpoint: projection.checkpoint,
      archive_gate: projection.archive_gate,
      routing_recommendation: projection.routing_recommendation,
    };
  }
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

function normalizeNextSession({ host, context, consensus, options, contextState }) {
  const action = options.nextSessionAction
    ? requireSingleLine(options.nextSessionAction, '--next-session-action')
    : options.completionState === 'closed'
      ? 'No next session is required from this footer evidence.'
      : context?.nextSession.action ?? defaultNextAction(contextState);
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

function buildPrHandlingReadiness({ contextState, contextMeasurement, options }) {
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
    // The decision is unchanged — the conservative fallback still passes, exactly
    // as it did before — but the criterion no longer presents that fallback as
    // observed evidence, so "readiness passed" cannot cite a measurement that
    // never happened.
    {
      ...criterion(
        'context_risk',
        contextState,
        { pass: ['green', 'yellow'], fail: ['red'] },
      ),
      measurement: contextMeasurement,
    },
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

// Completion-output contract: a caller flag counts as PRESENT only when it
// carries non-whitespace content; blank explicit flags fall back to the
// defaults (and their provenance) instead of rendering empty marker-free lines.
function presentFlag(value) {
  if (value === undefined || value === null) return undefined;
  const text = String(value);
  return text.trim() === '' ? undefined : text;
}

// S9 completion-output contract (docs/completion-output-contract.md): every
// completion field carries a per-field provenance tier —
//   explicit — the field's own caller flag supplied the value;
//   derived  — a runtime default consumed completion-specific evidence
//              (another caller flag's value, consensus guidance, PR readiness,
//              red context risk);
//   generic  — a static state-template fallback with no completion-specific
//              evidence. Only `generic` is surfaced with a visible text marker
//              so silent degradation cannot render as authored content.
// `closed` is the documented exception: its static reason/next-action restate
// a definitionally complete assertion, so they classify as derived.
function buildCompletionState({ options, contextState, consensus, prHandling, recommendedNextWork, recommendedNextWorkProvenance }) {
  const inferred = options.completionState
    ? null
    : inferCompletionState({ contextState, consensus, prHandling, recommendedNextWork });
  const state = options.completionState
    ? validateCompletionState(options.completionState)
    : inferred.state;
  const stateTier = options.completionState ? 'explicit' : inferred.tier;
  const defaultReason = options.completionReason
    ? null
    : defaultCompletionReason({ state, contextState, consensus, prHandling, recommendedNextWork });
  const reason = options.completionReason
    ? requireSingleLine(options.completionReason, '--completion-reason')
    : defaultReason.value;
  const defaultNextAction = options.completionNextAction
    ? null
    : defaultCompletionNextAction({ state, consensus, prHandling, recommendedNextWork, recommendedNextWorkProvenance });
  const nextAction = options.completionNextAction
    ? requireSingleLine(options.completionNextAction, '--completion-next-action')
    : defaultNextAction.value;
  return {
    state,
    source: options.completionState ? 'explicit' : 'inferred',
    sources: {
      state: stateTier,
      reason: options.completionReason ? 'explicit' : defaultReason.tier,
      next_action: options.completionNextAction ? 'explicit' : defaultNextAction.tier,
    },
    reason,
    next_action: nextAction,
  };
}

function inferCompletionState({ contextState, consensus, prHandling, recommendedNextWork }) {
  if (prHandling?.recommendation === 'block') return { state: 'blocked', tier: 'derived' };
  if (isBlockingConsensusGuidance(consensus?.statusGuidance?.state)) return { state: 'blocked', tier: 'derived' };
  if (prHandling?.recommendation === 'ask-user') return { state: 'publish-needed', tier: 'derived' };
  if (prHandling?.recommendation === 'defer') return { state: 'review-needed', tier: 'derived' };
  if (contextState === 'red') return { state: 'review-needed', tier: 'derived' };
  if (isActionableConsensusGuidance(consensus?.statusGuidance?.state)) return { state: 'next-work-available', tier: 'derived' };
  if (recommendedNextWork !== defaultRecommendedNextWork()) return { state: 'next-work-available', tier: 'derived' };
  return { state: 'review-needed', tier: 'generic' };
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
    if (prHandling?.recommendation === 'block') return { value: 'PR handling has a failed readiness criterion.', tier: 'derived' };
    // Evidence-consistency rule (completion-output contract): a blocked reason
    // may cite consensus only when the guidance itself is blocking — pairing a
    // blocked state with actionable consensus guidance would assert evidence
    // that contradicts the state.
    if (isBlockingConsensusGuidance(consensus?.statusGuidance?.state)) {
      return { value: `Consensus guidance is ${consensus.statusGuidance.state}.`, tier: 'derived' };
    }
    return { value: 'A required operator, validation, review, permission, or evidence precondition is blocked.', tier: 'generic' };
  }
  if (state === 'publish-needed') {
    // The string asserts readiness PASSED — only an ask-user PR-handling
    // verdict is evidence of that; mere presence of PR data (e.g. defer) is not.
    return {
      value: 'PR handling readiness passed and the user should decide whether to publish.',
      tier: prHandling?.recommendation === 'ask-user' ? 'derived' : 'generic',
    };
  }
  if (state === 'cleanup-needed') return { value: 'Caller reported that cleanup is the next required action.', tier: 'generic' };
  if (state === 'next-work-available') {
    if (consensus?.statusGuidance?.state) return { value: `Consensus guidance is ${consensus.statusGuidance.state}.`, tier: 'derived' };
    if (recommendedNextWork !== defaultRecommendedNextWork()) return { value: 'Caller supplied recommended next work.', tier: 'derived' };
    return { value: 'Follow-up work is available from the current runtime evidence.', tier: 'generic' };
  }
  if (state === 'closed') {
    // closed restates a definitionally complete caller assertion (documented
    // special case) — never a generic-fallback nudge.
    return { value: 'Caller explicitly reported that no repo, PR, release, cleanup, or planned follow-up work remains.', tier: 'derived' };
  }
  if (contextState === 'red') return { value: 'Context risk is red; review or fresh-session handoff is needed before substantial follow-up.', tier: 'derived' };
  if (prHandling?.recommendation === 'defer') return { value: 'PR handling evidence is incomplete.', tier: 'derived' };
  return { value: 'Completion evidence should be reviewed before choosing the next action.', tier: 'generic' };
}

function defaultCompletionNextAction({ state, consensus, prHandling, recommendedNextWork, recommendedNextWorkProvenance }) {
  if (state === 'blocked') {
    // Same evidence-consistency rule as the reason: only blocking consensus
    // guidance may drive a blocked next action.
    if (isBlockingConsensusGuidance(consensus?.statusGuidance?.state) && consensus?.statusGuidance?.next_action) {
      return { value: consensus.statusGuidance.next_action, tier: 'derived' };
    }
    if (prHandling?.recommendation === 'block') return { value: 'Resolve failed PR handling criteria before publishing or closing the slice.', tier: 'derived' };
    return { value: 'Resolve the blocking precondition, then rerun the relevant runtime check.', tier: 'generic' };
  }
  if (state === 'publish-needed') {
    return {
      value: 'Ask the user whether to commit, push, open or update a PR, defer publishing, or continue without PR handling.',
      tier: prHandling?.recommendation === 'ask-user' ? 'derived' : 'generic',
    };
  }
  if (state === 'cleanup-needed') return { value: 'Clean up merged branches, stale worktrees, plugin/cache drift, or release follow-ups before starting the next slice.', tier: 'generic' };
  if (state === 'next-work-available') {
    // The value routes the recommended next work through; its provenance
    // follows that signal (a caller/consensus-fed value is derived, the bare
    // static default stays generic).
    return {
      value: recommendedNextWork,
      tier: recommendedNextWorkProvenance === 'generic' ? 'generic' : 'derived',
    };
  }
  if (state === 'closed') {
    // Documented special case: nothing further remains, so the static text is
    // definitionally complete.
    return { value: 'No further repo, PR, release, cleanup, or planned follow-up action is known from this footer evidence.', tier: 'derived' };
  }
  return { value: 'Review validation, artifacts, context, consensus, and PR readiness evidence before choosing the next command.', tier: 'generic' };
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
    `- latest_open: ${lookup.latest_open ?? false}`,
    `- selected_at: ${selected}`,
    `- skipped_invalid: ${lookup.skipped_invalid}`,
    `- skipped_terminal: ${lookup.skipped_terminal ?? 0}`,
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

// The localization core (PLUGIN_COMMAND_RE, localizePluginCommands,
// localizeCommandList, localizeCommandFields) lives in
// lib/host-localization.mjs so context.mjs can import it without the
// footer→context cycle (ADR-0045 §10). Only the footer-shape wrappers above
// stay here.

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
    'Peer raw output, consensus raw output, owner decision text, and cancellation reason text must stay in runtime artifacts, not in the main session footer.',
    'Codex plugin-hook feature/trust state and permission limits are not represented as host parity.',
  ];
}

function validateHost(value) {
  if (!isLocalizationHost(value)) {
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

function validateContextStateSource(value) {
  if (!VALID_CONTEXT_STATE_SOURCE_FLAGS.has(value)) {
    throw new Error('--context-state-source must be measured or declared (omit --context-state entirely to report an unmeasured default)');
  }
  return value;
}

// The single place the footer decides WHAT the context risk is and WHERE it came
// from. Every consumer (JSON, text, session handoff, PR readiness, next-session
// action) reads this one result, so a fabricated default cannot re-enter through
// a second copy of the fallback.
//
// Value precedence matches the previous behaviour exactly — caller flag, then
// context artifact, then the conservative fallback — so no existing caller
// changes meaning; only the provenance that was previously discarded is now
// carried alongside.
export function resolveContextState({ options = {}, context = null } = {}) {
  const declaredSource = options.contextStateSource
    ? validateContextStateSource(options.contextStateSource)
    : null;
  // `!= null` (not `!== undefined`): a programmatic caller passing an explicit
  // null previously fell through the `??` chain to the fallback, and must keep
  // doing so rather than failing enum validation.
  const callerState = options.contextState != null ? validateContextState(options.contextState) : null;
  if (declaredSource && callerState === null) {
    throw new Error(`--context-state-source ${declaredSource} requires --context-state (a provenance claim needs a value to attach to)`);
  }
  if (callerState !== null) {
    const measurement = declaredSource === 'measured' ? 'measured' : 'unmeasured';
    return {
      state: callerState,
      measurement,
      origin: 'caller',
      supplied: true,
      report: measurement === 'measured' ? callerState : `${callerState} [declared, not measured]`,
    };
  }
  if (context && context.contextState != null) {
    const state = validateContextState(context.contextState);
    return {
      state,
      // A context artifact records a risk level, not the basis for it. Reporting
      // that as `unmeasured` would be as much of a claim as reporting it as
      // `measured`; `unknown` is the only honest answer the record supports.
      measurement: 'unknown',
      origin: 'context-artifact',
      supplied: true,
      report: `${state} [recorded in the context artifact; measurement basis not recorded]`,
    };
  }
  return {
    // The conservative fallback keeps a valid risk enum because every downstream
    // rule still needs a value to reason with; what changes is that the footer no
    // longer presents that value as an observation.
    state: CONSERVATIVE_CONTEXT_STATE,
    measurement: 'unmeasured',
    origin: 'runtime-default',
    supplied: false,
    report: UNMEASURED_CONTEXT_REPORT,
  };
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

// Render-side sanitizer for free text that did not pass requireSingleLine
// (e.g. the projection checkpoint): collapse control characters and newlines
// into single spaces so interpolated text cannot fabricate footer lines.
function singleLineText(value) {
  return String(value).replace(/[\u0000-\u001F\u007F]+/g, ' ').trim();
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
  runtime footer render --consensus-latest-open
  runtime footer render --context-state green|yellow|red --recommended-next-work <text>
  runtime footer render --context-state green|yellow|red --context-state-source measured|declared
  runtime footer render --workflow-projection-file <path>   # ADR-0031 session-level continue-vs-fresh preflight
  runtime footer render --completion-state review-needed|publish-needed|cleanup-needed|next-work-available|blocked|closed
  runtime footer render --pr-handling --pr-completion-boundary reached --pr-validation-state passed --pr-review-state clear --pr-branch-state pushable
  runtime footer render --cutover-record --cutover-omcc-dev-active yes|no|unknown

Renders an advisory, pointer-only completion footer. It reads optional
runtime:context artifacts and runtime:consensus status guidance when available, but
does not mutate host session context, workflow state, git state, or pull
request state. Cutover record guidance renders only a suggested
runtime:cutover record command; it does not write cutover evidence. Completion
state is advisory; closed is emitted only when the caller supplies
--completion-state closed.

Context risk carries its provenance on two axes: context_state_measurement
(measured | unmeasured | unknown) and context_state_origin (caller |
context-artifact | runtime-default). Runtime performs no automatic host-context
measurement, so omitting --context-state renders as "context state: unmeasured
(no budget sensor)" and is reported to the session handoff as an unsupplied
risk — that is the honest default and it requires no flag. Supply
--context-state-source measured alongside --context-state only when a real
context-budget measurement backs the value; runtime records that as a caller
assertion, it cannot verify it.`;
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
