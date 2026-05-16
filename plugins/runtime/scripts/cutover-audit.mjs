#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runDoctor } from './doctor.mjs';
import { RUNTIME_VERSION } from './version.mjs';

const VERSION = RUNTIME_VERSION;
const CUTOVER_EVIDENCE_SCHEMA_VERSION = 'runtime-cutover-evidence-1.0';
const DEFAULT_MAX_ARTIFACT_AGE_HOURS = 24;
const DEFAULT_DOGFOOD_WINDOW_DAYS = 7;
const CHECK_PASS = new Set(['satisfied', 'current', 'fresh', 'not-active']);
const CHECK_UNREADY = new Set(['partial', 'blocked', 'stale', 'not-verified', 'missing']);
const OMCC_ACTIVITY = new Set(['yes', 'no', 'unknown']);
const FOOTER_STATES = new Set([
  'review-needed',
  'publish-needed',
  'cleanup-needed',
  'next-work-available',
  'blocked',
  'closed',
]);
const CUTOVER_CANDIDATE_GATE = [
  'ADR-0012 conditions 1-4 satisfied',
  'omcc replacement scorecard has no partial/missing rows',
  'observed runtime experience parity is ready and 100%',
  'at least one week of omcc-dev-free dogfood evidence',
  'latest completion footer is closed',
];
const CUTOVER_FINAL_GATE = [
  'explicit user cutover declaration per ADR-0007',
];
const REQUIRED_LEGACY_PATTERN_IDS = Array.from({ length: 20 }, (_, index) => `D${index + 1}`);
const LEGACY_PATTERN_STATUSES = new Set(['improved', 'retained', 'rejected', 'deferred']);
const CUTOVER_RUN_ID_RE = /^cutover-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const ARTIFACT_KIND_RE = /^[A-Za-z0-9._-]+$/;

export async function runCutoverAudit(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const now = options.now ?? new Date();
  const timeZone = options.timeZone;
  const maxArtifactAgeHours = options.maxArtifactAgeHours ?? DEFAULT_MAX_ARTIFACT_AGE_HOURS;
  const dogfoodWindowDays = options.dogfoodWindowDays
    ? positiveInteger(options.dogfoodWindowDays, '--dogfood-window-days')
    : DEFAULT_DOGFOOD_WINDOW_DAYS;
  const doctor = options.doctorReport ?? await runDoctor({
    repoRoot,
    homeDir: resolve(options.homeDir ?? homedir()),
    env: options.env ?? process.env,
    now,
    format: 'json',
    permissionProof: options.permissionProof,
    executePermissionProof: options.executePermissionProof,
    permissionProofTimeoutMs: options.permissionProofTimeoutMs,
    deepPeerSmoke: options.deepPeerSmoke,
    executeDeepPeerSmoke: options.executeDeepPeerSmoke,
    deepPeerSmokeTimeoutMs: options.deepPeerSmokeTimeoutMs,
    workflowContinuationProof: options.workflowContinuationProof,
    executeWorkflowContinuationProof: options.executeWorkflowContinuationProof,
    workflowContinuationProofTimeoutMs: options.workflowContinuationProofTimeoutMs,
  });
  const storedCutoverEvidence = await readCutoverEvidence(repoRoot);
  const inlineEvidence = buildInlineCutoverEvidence({ options, now, timeZone });
  const cutoverEvidence = {
    ...storedCutoverEvidence,
    records: inlineEvidence
      ? [...storedCutoverEvidence.records, inlineEvidence]
      : storedCutoverEvidence.records,
    latest: inlineEvidence ?? storedCutoverEvidence.latest,
  };
  const latestEvidence = cutoverEvidence.latest;
  const [scorecardText, legacyPatternText, developmentText, hostParityText, manifest] = await Promise.all([
    readOptionalText(resolve(repoRoot, 'docs/assurance/omcc-cutover-scorecard.md')),
    readOptionalText(resolve(repoRoot, 'docs/assurance/omcc-legacy-pattern-map.md')),
    readOptionalText(resolve(repoRoot, 'docs/DEVELOPMENT.md')),
    readOptionalText(resolve(repoRoot, 'plugins/runtime/docs/host-parity-baseline.md')),
    readOptionalJson(resolve(repoRoot, '.release-please-manifest.json')),
  ]);

  const checks = [
    checkAdr0012Conditions(developmentText),
    checkScorecardRequirements(scorecardText),
    checkLegacyPatternMap({ repoRoot, text: legacyPatternText }),
    checkObservedExperienceParity(doctor),
    checkHostParityBaseline(hostParityText, doctor),
    checkPluginVersions({ repoRoot, manifest, doctor }),
    checkCompatFreshness({ doctor, now, maxArtifactAgeHours }),
    await checkConsensusAndContext({ repoRoot, doctor, now, maxArtifactAgeHours }),
    checkDogfoodEvidenceWindow({ evidence: cutoverEvidence, now, requiredDays: dogfoodWindowDays, timeZone }),
    checkFooterState({ options, latestEvidence }),
    checkOmccActivity({ options, latestEvidence }),
  ];
  const readyCandidate = checks.every((check) => CHECK_PASS.has(check.status));
  const proofExecutionRequested = Boolean(
    options.executePermissionProof
      || options.executeDeepPeerSmoke
      || options.executeWorkflowContinuationProof
  );
  return {
    command: 'cutover-audit',
    version: VERSION,
    status: readyCandidate ? 'cutover-ready-candidate' : 'not-ready',
    ready_candidate: readyCandidate,
    generated_at: now.toISOString(),
    repo_root: repoRoot,
    cutover_gate: {
      candidate_required: CUTOVER_CANDIDATE_GATE,
      final_required: CUTOVER_FINAL_GATE,
      required: [...CUTOVER_CANDIDATE_GATE, ...CUTOVER_FINAL_GATE],
      note: 'runtime:cutover-audit reports candidate readiness evidence only; final cutover still requires explicit user declaration.',
    },
    checks,
    next_actions: checks
      .filter((check) => CHECK_UNREADY.has(check.status))
      .map((check) => ({ id: check.id, next_action: check.next_action }))
      .filter((entry) => entry.next_action),
    limits: [
      proofExecutionRequested
        ? 'This audit does not install, uninstall, update, authenticate, mutate host config, mutate git state, or delete artifacts; explicit proof flags can invoke bounded peer/workflow commands without relaxing host permissions.'
        : 'This audit is read-only and does not install, uninstall, update, authenticate, mutate host config, mutate git state, invoke peer/workflow executors, or delete artifacts.',
      'cutover-ready-candidate means the evidence gate passed; it is not final cutover because ADR-0007 still requires explicit user declaration.',
      'Dogfood evidence is accepted only from explicit runtime:cutover record artifacts or explicit current-run flags.',
      'Unknown dogfood or omcc-dev usage evidence blocks readiness rather than being inferred.',
    ],
  };
}

export async function recordCutoverEvidence(options = {}) {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const now = options.now ?? new Date();
  const timeZone = options.timeZone;
  const createdAt = now.toISOString();
  const runId = options.runId ? validateCutoverRunId(options.runId) : makeCutoverRunId(now);
  const footerState = options.footerState;
  const omccDevActive = options.omccDevActive;
  if (!FOOTER_STATES.has(footerState)) throw new Error('record requires --footer-state');
  if (!OMCC_ACTIVITY.has(omccDevActive)) throw new Error('record requires --omcc-dev-active yes|no|unknown');
  const dogfoodDate = validateDate(options.dogfoodDate ?? localDateString(now, timeZone), '--dogfood-date');
  const runDir = resolve(cutoverEvidenceRoot(repoRoot), runId);
  await assertInside(cutoverEvidenceRoot(repoRoot), runDir);
  await mkdir(runDir, { recursive: true });
  const artifact = {
    schema_version: CUTOVER_EVIDENCE_SCHEMA_VERSION,
    runtime_version: VERSION,
    run_id: runId,
    status: 'recorded',
    created_at: createdAt,
    repo_root_pointer: '.',
    dogfood: {
      date: dogfoodDate,
      omcc_dev_active: omccDevActive,
      note: options.omccDevNote ?? null,
    },
    footer: {
      state: footerState,
      reason: options.footerReason ?? null,
    },
    summary: options.summary ?? null,
    artifacts: normalizeArtifactPointers(repoRoot, options.artifacts ?? []),
    limits: [
      'This artifact records operator-provided cutover evidence; it does not declare final cutover.',
      'Codex hook trust state is not mutated or independently verified by this artifact.',
      'A no-omcc-dev dogfood claim is evidence for the recorded date only; runtime:cutover audit evaluates the full window separately.',
    ],
  };
  const evidencePath = resolve(runDir, 'evidence.json');
  await writeJson(evidencePath, artifact);
  const latestPath = resolve(cutoverEvidenceRoot(repoRoot), 'latest.json');
  await writeJson(latestPath, {
    schema_version: 'runtime-cutover-latest-1.0',
    runtime_version: VERSION,
    run_id: runId,
    evidence_pointer: relativePointer(repoRoot, evidencePath),
    updated_at: createdAt,
  });
  return {
    command: 'record',
    version: VERSION,
    status: 'recorded',
    repo_root: repoRoot,
    run_id: runId,
    dogfood_date: dogfoodDate,
    evidence_pointer: relativePointer(repoRoot, evidencePath),
    latest_pointer: relativePointer(repoRoot, latestPath),
    artifact,
  };
}

function checkLegacyPatternMap({ repoRoot, text }) {
  const rows = parseMarkdownRows(text).filter((row) => /^D\d+$/.test(row[0]));
  const entries = rows.map((row) => {
    const id = row[0];
    const status = normalizeLegacyPatternStatus(row[5]);
    const impact = row[6] ?? '';
    return {
      id,
      status,
      active_daily_dependency: /active daily dependency/i.test(impact)
        && !/no active daily dependency/i.test(impact),
    };
  });
  const present = new Set(entries.map((entry) => entry.id));
  const missing = REQUIRED_LEGACY_PATTERN_IDS.filter((id) => !present.has(id));
  const invalidStatuses = entries.filter((entry) => !LEGACY_PATTERN_STATUSES.has(entry.status));
  const activeDependencyBlockers = entries.filter((entry) => (
    (entry.status === 'rejected' || entry.status === 'deferred')
      && entry.active_daily_dependency
  ));
  const counts = Object.fromEntries([...LEGACY_PATTERN_STATUSES].map((status) => [
    status,
    entries.filter((entry) => entry.status === status).length,
  ]));
  const satisfied = text
    && missing.length === 0
    && invalidStatuses.length === 0
    && activeDependencyBlockers.length === 0;
  return {
    id: 'legacy_omcc_pattern_map',
    label: 'legacy omcc-dev pattern disposition map',
    status: text ? satisfied ? 'satisfied' : 'partial' : 'missing',
    evidence: {
      pointer: relativePointer(repoRoot, resolve(repoRoot, 'docs/assurance/omcc-legacy-pattern-map.md')),
      total: entries.length,
      counts,
      missing_patterns: missing,
      invalid_statuses: invalidStatuses,
      active_dependency_blockers: activeDependencyBlockers,
    },
    next_action: text
      ? satisfied
        ? null
        : 'Complete docs/assurance/omcc-legacy-pattern-map.md with D1-D20 statuses and no active dependency on rejected/deferred rows.'
      : 'Create docs/assurance/omcc-legacy-pattern-map.md before declaring cutover readiness.',
  };
}

function checkAdr0012Conditions(text) {
  const rows = parseMarkdownRows(text).filter((row) => /^[1-4]$/.test(row[0]));
  const statuses = rows.map((row) => ({ condition: row[0], status: normalizeStatus(row[2]) }));
  const missing = [1, 2, 3, 4].filter((condition) => !statuses.some((row) => row.condition === String(condition)));
  const notSatisfied = statuses.filter((row) => row.status !== 'satisfied');
  return {
    id: 'adr0012_conditions',
    label: 'ADR-0012 condition statuses',
    status: missing.length > 0 ? 'missing' : notSatisfied.length === 0 ? 'satisfied' : 'partial',
    evidence: {
      statuses,
      unresolved_conditions: notSatisfied,
      missing_conditions: missing,
    },
    next_action: missing.length > 0
      ? 'Restore the ADR-0012 condition matrix in docs/DEVELOPMENT.md.'
      : notSatisfied.length > 0
        ? 'Continue dogfood and verification until all four ADR-0012 conditions are fully satisfied.'
        : null,
  };
}

function checkScorecardRequirements(text) {
  const rows = parseMarkdownRows(text).filter((row) => /^R\d+[a-z]?$/.test(row[0]));
  const statuses = rows.map((row) => ({ requirement: row[0], status: normalizeStatus(row[3]) }));
  const unresolved = statuses.filter((row) => row.status !== 'satisfied');
  return {
    id: 'omcc_replacement_scorecard',
    label: 'omcc replacement requirement scorecard',
    status: rows.length === 0 ? 'missing' : unresolved.length === 0 ? 'satisfied' : 'partial',
    evidence: {
      total: rows.length,
      satisfied: statuses.filter((row) => row.status === 'satisfied').length,
      unresolved,
    },
    next_action: unresolved.length > 0
      ? 'Resolve remaining scorecard rows before declaring cutover readiness.'
      : null,
  };
}

function checkObservedExperienceParity(doctor) {
  const { experience, appliedRecordedProofCriteria } = applyReusableDoctorProofToExperienceParity({
    experience: doctor.experience_parity ?? null,
    recordedProof: doctor.recorded_doctor_proof ?? null,
  });
  const score = Number.isFinite(experience?.score_percent) ? experience.score_percent : null;
  const manualFollowups = Number.isFinite(experience?.manual_followup_count)
    ? experience.manual_followup_count
    : null;
  const status = experience?.status ?? null;
  const ready = status === 'ready' && score === 100 && manualFollowups === 0;
  const blocked = status === 'blocked' || (experience?.counts?.blocked ?? 0) > 0;
  return {
    id: 'observed_experience_parity',
    label: 'Observed Claude/Codex runtime experience parity',
    status: experience ? ready ? 'satisfied' : blocked ? 'blocked' : 'partial' : 'not-verified',
    evidence: {
      status,
      score_percent: score,
      manual_followup_count: manualFollowups,
      counts: experience?.counts ?? null,
      recorded_doctor_proof: doctor.recorded_doctor_proof
        ? {
            status: doctor.recorded_doctor_proof.status ?? null,
            run_id: doctor.recorded_doctor_proof.run_id ?? null,
            artifact_pointer: doctor.recorded_doctor_proof.artifact_pointer ?? null,
            applied_criteria: appliedRecordedProofCriteria,
          }
        : null,
      unresolved_criteria: (experience?.criteria ?? [])
        .filter((item) => item.status !== 'satisfied')
        .map((item) => ({ id: item.id, status: item.status })),
      next_actions: (experience?.next_actions ?? []).map((item) => ({
        id: item.id ?? item.criterion ?? item.type ?? '<unknown>',
        reason: item.reason ?? item.next_step ?? null,
      })),
    },
    next_action: experience
      ? ready
        ? null
        : 'Clear observed experience parity follow-ups with runtime:settings/runtime:doctor before declaring cutover readiness.'
      : 'Run runtime:doctor and provide experience_parity evidence before declaring cutover readiness.',
  };
}

function applyReusableDoctorProofToExperienceParity({ experience, recordedProof }) {
  if (!experience || recordedProof?.status !== 'reusable' || recordedProof?.reusable !== true) {
    return { experience, appliedRecordedProofCriteria: [] };
  }
  const appliedCriteria = [];
  const criteria = (experience.criteria ?? []).map((criterion) => {
    if (
      criterion.id === 'bidirectional_peer_execution'
      && recordedProof.permission_proof?.status === 'passed'
      && recordedProof.deep_peer_smoke?.status === 'passed'
    ) {
      appliedCriteria.push(criterion.id);
      return {
        ...criterion,
        status: 'satisfied',
        earned_weight: criterion.weight,
        evidence: `permission-proof=passed, deep-peer-smoke=passed; source=recorded-doctor-proof:${recordedProof.run_id}`,
        next_step: null,
      };
    }
    if (
      criterion.id === 'engineer_workflow_continuation_execution'
      && recordedProof.workflow_continuation_proof?.status === 'passed'
    ) {
      appliedCriteria.push(criterion.id);
      return {
        ...criterion,
        status: 'satisfied',
        earned_weight: criterion.weight,
        evidence: `workflow-continuation-proof=passed; source=recorded-doctor-proof:${recordedProof.run_id}`,
        next_step: null,
      };
    }
    return criterion;
  });
  if (appliedCriteria.length === 0) return { experience, appliedRecordedProofCriteria: [] };

  const weightTotal = criteria.reduce((sum, criterion) => (
    sum + (Number.isFinite(criterion.weight) ? criterion.weight : 0)
  ), 0);
  const weightEarned = criteria.reduce((sum, criterion) => {
    const weight = Number.isFinite(criterion.weight) ? criterion.weight : 0;
    const earned = Number.isFinite(criterion.earned_weight)
      ? criterion.earned_weight
      : criterion.status === 'satisfied'
        ? weight
        : 0;
    return sum + earned;
  }, 0);
  const counts = {
    satisfied: criteria.filter((criterion) => criterion.status === 'satisfied').length,
    partial: criteria.filter((criterion) => criterion.status === 'partial').length,
    not_verified: criteria.filter((criterion) => (
      criterion.status === 'not-verified' || criterion.status === 'not_verified'
    )).length,
    blocked: criteria.filter((criterion) => criterion.status === 'blocked').length,
  };
  const adjustedStatus = counts.blocked > 0
    ? 'blocked'
    : counts.partial > 0 || counts.not_verified > 0
      ? 'partial'
      : 'ready';
  const applied = new Set(appliedCriteria);
  return {
    experience: {
      ...experience,
      status: adjustedStatus,
      score_percent: weightTotal > 0
        ? Math.round((weightEarned / weightTotal) * 100)
        : experience.score_percent,
      weight: weightTotal > 0
        ? { earned: weightEarned, total: weightTotal }
        : experience.weight,
      counts,
      criteria,
      next_actions: (experience.next_actions ?? []).filter((action) => !applied.has(
        action.id ?? action.criterion ?? action.type
      )),
    },
    appliedRecordedProofCriteria: appliedCriteria,
  };
}

function checkHostParityBaseline(text, doctor) {
  const match = text.match(/Observed on ([0-9-]+) with Claude Code `([^`]+)`, Codex CLI\s*`([^`]+)`/m);
  const observedClaude = observedVersionText(doctor.clis?.claude?.version);
  const observedCodex = observedVersionText(doctor.clis?.codex?.version);
  const normalizedObserved = {
    claude: normalizeHostVersion(observedClaude),
    codex: normalizeHostVersion(observedCodex),
  };
  const baseline = match
    ? { date: match[1], claude: match[2], codex: match[3] }
    : null;
  const current = baseline
    && normalizedObserved.claude === baseline.claude
    && normalizedObserved.codex === baseline.codex;
  return {
    id: 'host_parity_baseline',
    label: 'Host parity baseline freshness',
    status: baseline ? current ? 'current' : 'stale' : 'missing',
    evidence: {
      baseline,
      observed: { claude: observedClaude, codex: observedCodex },
      normalized_observed: normalizedObserved,
    },
    next_action: baseline
      ? current ? null : 'Refresh host parity baseline and runtime:compat evidence for the current host versions.'
      : 'Restore plugins/runtime/docs/host-parity-baseline.md.',
  };
}

function observedVersionText(value) {
  if (value && typeof value === 'object' && 'text' in value) return value.text;
  return value ?? null;
}

function normalizeHostVersion(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const match = text.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
  return match?.[0] ?? text;
}

function checkPluginVersions({ repoRoot, manifest, doctor }) {
  const packages = {
    'plugins/companions': 'companions',
    'plugins/engineer': 'engineer',
    'plugins/orchestrator': 'orchestrator',
    'plugins/runtime': 'runtime',
  };
  const entries = Object.entries(packages).map(([packagePath, pluginName]) => {
    const expected = manifest?.[packagePath] ?? null;
    const plugin = doctor.plugins?.[pluginName] ?? {};
    const source = plugin.source?.claude_manifest?.version ?? null;
    const claudeCache = plugin.cache?.claude?.latest?.manifest_version ?? null;
    const codexCache = plugin.cache?.codex?.latest?.manifest_version ?? null;
    return {
      package: packagePath,
      plugin: pluginName,
      expected,
      source,
      claude_cache: claudeCache,
      codex_cache: codexCache,
      status: expected && source === expected && claudeCache === expected && codexCache === expected
        ? 'satisfied'
        : 'blocked',
    };
  });
  const blocked = entries.filter((entry) => entry.status !== 'satisfied');
  return {
    id: 'installed_plugin_versions',
    label: 'Installed/cache plugin versions match release manifest',
    status: blocked.length === 0 ? 'satisfied' : 'blocked',
    evidence: {
      manifest_pointer: relativePointer(repoRoot, resolve(repoRoot, '.release-please-manifest.json')),
      entries,
    },
    next_action: blocked.length > 0
      ? 'Run runtime:settings --execute-plugin-management, then rerun this audit.'
      : null,
  };
}

function checkCompatFreshness({ doctor, now, maxArtifactAgeHours }) {
  const latest = doctor.compat_runs?.latest ?? null;
  const ageHours = latest?.selected_at ? ageHoursSince(latest.selected_at, now) : null;
  const fresh = ageHours !== null && ageHours <= maxArtifactAgeHours;
  const current = latest?.status === 'current' && latest?.drift_class === 'none';
  return {
    id: 'latest_compat_snapshot',
    label: 'Latest compatibility snapshot freshness',
    status: latest ? current && fresh ? 'fresh' : current ? 'stale' : 'blocked' : 'missing',
    evidence: {
      run_id: latest?.run_id ?? null,
      status: latest?.status ?? null,
      drift_class: latest?.drift_class ?? null,
      selected_at: latest?.selected_at ?? null,
      age_hours: ageHours,
      max_age_hours: maxArtifactAgeHours,
    },
    next_action: latest && current && fresh
      ? null
      : 'Run runtime:compat snapshot and runtime:compat check, ingest release notes if drift appears.',
  };
}

async function checkConsensusAndContext({ repoRoot, doctor, now, maxArtifactAgeHours }) {
  const consensus = doctor.consensus_runs?.latest ?? null;
  const context = await findLatestContext(repoRoot);
  const contextAge = context?.selected_at ? ageHoursSince(context.selected_at, now) : null;
  const consensusOk = consensus?.status === 'passed' || consensus?.status === 'synthesized';
  const contextFresh = contextAge !== null && contextAge <= maxArtifactAgeHours;
  return {
    id: 'latest_consensus_context_artifacts',
    label: 'Latest consensus and context artifact state',
    status: consensusOk && contextFresh ? 'fresh' : consensus && context ? 'stale' : 'not-verified',
    evidence: {
      consensus: consensus ? {
        run_id: consensus.run_id,
        status: consensus.status,
        selected_at: consensus.selected_at,
        pointer: consensus.artifact_pointer,
      } : null,
      context: context ? {
        run_id: context.run_id,
        selected_at: context.selected_at,
        age_hours: contextAge,
        pointer: context.pointer,
      } : null,
      max_age_hours: maxArtifactAgeHours,
    },
    next_action: consensusOk && contextFresh
      ? null
      : 'Refresh consensus/context evidence before cutover evaluation.',
  };
}

function checkDogfoodEvidenceWindow({ evidence, now, requiredDays, timeZone }) {
  const window = buildDogfoodWindow({ records: evidence.records, now, requiredDays, timeZone });
  return {
    id: 'dogfood_evidence_window',
    label: 'One-week omcc-dev-free dogfood evidence',
    status: window.status,
    evidence: window,
    next_action: window.status === 'satisfied'
      ? null
      : window.status === 'blocked'
        ? 'Restart or extend the dogfood window after recording omcc-dev-free evidence.'
        : 'Record daily runtime:cutover record artifacts until the dogfood window reaches one calendar week.',
  };
}

function checkFooterState({ options, latestEvidence }) {
  const footerState = options.footerState ?? latestEvidence?.footer?.state ?? null;
  const footerReason = options.footerReason ?? latestEvidence?.footer?.reason ?? null;
  return {
    id: 'latest_completion_footer_state',
    label: 'Latest completion footer state',
    status: footerState ? footerState === 'closed' ? 'satisfied' : 'partial' : 'not-verified',
    evidence: {
      footer_state: footerState,
      reason: footerReason,
      source_run_id: footerState ? latestEvidence?.run_id ?? null : null,
    },
    next_action: footerState
      ? footerState === 'closed'
        ? null
        : 'Close or continue the outstanding completion footer action before declaring cutover readiness.'
      : 'Provide explicit --footer-state evidence from the latest completion surface.',
  };
}

function checkOmccActivity({ options, latestEvidence }) {
  const active = options.omccDevActive ?? latestEvidence?.dogfood?.omcc_dev_active ?? 'unknown';
  return {
    id: 'omcc_dev_daily_workflow',
    label: 'Daily workflow still depends on omcc-dev',
    status: active === 'no' ? 'not-active' : active === 'yes' ? 'blocked' : 'not-verified',
    evidence: {
      omcc_dev_active: active,
      note: options.omccDevNote ?? latestEvidence?.dogfood?.note ?? null,
      source_run_id: active !== 'unknown' ? latestEvidence?.run_id ?? null : null,
    },
    next_action: active === 'no'
      ? null
      : active === 'yes'
        ? 'Continue agentic-plugins dogfood until daily workflow no longer depends on omcc-dev.'
        : 'Record explicit --omcc-dev-active yes|no evidence for the current dogfood period.',
  };
}

function buildDogfoodWindow({ records, now, requiredDays, timeZone }) {
  const today = localDateString(now, timeZone);
  const usable = records
    .map((record) => ({
      run_id: record.run_id,
      date: record.dogfood?.date ?? null,
      omcc_dev_active: record.dogfood?.omcc_dev_active ?? 'unknown',
      created_at: record.created_at ?? null,
    }))
    .filter((record) => record.date && record.date <= today);
  if (usable.length === 0) {
    return {
      status: 'not-verified',
      required_days: requiredDays,
      covered_days: 0,
      latest_date: null,
      missing_dates: [],
      blocked_dates: [],
      accepted_dates: [],
      total_records: records.length,
    };
  }

  const byDate = new Map();
  for (const record of usable) {
    if (!byDate.has(record.date)) byDate.set(record.date, []);
    byDate.get(record.date).push(record);
  }
  const sortedDates = [...byDate.keys()].sort();
  const latestDate = sortedDates.at(-1);
  const latestBlockedDate = sortedDates
    .filter((date) => (byDate.get(date) ?? []).some((entry) => entry.omcc_dev_active === 'yes'))
    .at(-1) ?? null;
  const startDate = sortedDates.find((date) => {
    if (latestBlockedDate && date <= latestBlockedDate) return false;
    return (byDate.get(date) ?? []).some((entry) => entry.omcc_dev_active === 'no');
  }) ?? null;

  if (!startDate) {
    return {
      status: latestBlockedDate ? 'blocked' : 'not-verified',
      required_days: requiredDays,
      covered_days: 0,
      window_start_date: latestBlockedDate ? addUtcDays(latestBlockedDate, 1) : null,
      window_end_date: latestBlockedDate ? addUtcDays(addUtcDays(latestBlockedDate, 1), requiredDays - 1) : null,
      latest_date: latestDate,
      latest_blocked_date: latestBlockedDate,
      missing_dates: [],
      remaining_dates: [],
      blocked_dates: latestBlockedDate ? [latestBlockedDate] : [],
      accepted_dates: [],
      total_records: records.length,
    };
  }

  const endDate = addUtcDays(startDate, requiredDays - 1);
  const acceptedDates = [];
  const missingDates = [];
  const remainingDates = [];
  const blockedDates = [];
  for (let offset = 0; offset < requiredDays; offset += 1) {
    const date = addUtcDays(startDate, offset);
    if (date > today) {
      remainingDates.push(date);
      continue;
    }
    const entries = byDate.get(date) ?? [];
    if (entries.some((entry) => entry.omcc_dev_active === 'yes')) {
      blockedDates.push(date);
      continue;
    }
    if (entries.some((entry) => entry.omcc_dev_active === 'no')) {
      acceptedDates.push(date);
      continue;
    }
    missingDates.push(date);
  }
  acceptedDates.sort();
  missingDates.sort();
  remainingDates.sort();
  blockedDates.sort();
  return {
    status: blockedDates.length > 0
      ? 'blocked'
      : acceptedDates.length >= requiredDays && missingDates.length === 0 && remainingDates.length === 0
        ? 'satisfied'
        : 'partial',
    required_days: requiredDays,
    covered_days: acceptedDates.length,
    window_start_date: startDate,
    window_end_date: endDate,
    latest_date: latestDate,
    latest_blocked_date: latestBlockedDate,
    missing_dates: missingDates,
    remaining_dates: remainingDates,
    blocked_dates: blockedDates,
    accepted_dates: acceptedDates,
    total_records: records.length,
  };
}

function buildInlineCutoverEvidence({ options, now, timeZone }) {
  const hasFooter = options.footerState || options.footerReason;
  const hasDogfood = options.omccDevActive || options.omccDevNote || options.dogfoodDate;
  if (!hasFooter && !hasDogfood) return null;
  return {
    schema_version: CUTOVER_EVIDENCE_SCHEMA_VERSION,
    runtime_version: VERSION,
    run_id: 'current-run',
    status: 'inline',
    created_at: now.toISOString(),
    dogfood: {
      date: validateDate(options.dogfoodDate ?? localDateString(now, timeZone), '--dogfood-date'),
      omcc_dev_active: OMCC_ACTIVITY.has(options.omccDevActive) ? options.omccDevActive : 'unknown',
      note: options.omccDevNote ?? null,
    },
    footer: {
      state: FOOTER_STATES.has(options.footerState) ? options.footerState : null,
      reason: options.footerReason ?? null,
    },
  };
}

async function findLatestContext(repoRoot) {
  const root = resolve(repoRoot, '.agentic-plugins/runs/context');
  try {
    await access(root, fsConstants.R_OK);
  } catch {
    return null;
  }
  const entries = await readdir(root, { withFileTypes: true });
  const contexts = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('context-')) continue;
    const contextPath = resolve(root, entry.name, 'context.json');
    const context = await readOptionalJson(contextPath);
    if (!context) continue;
    contexts.push({
      run_id: context.run_id ?? entry.name,
      selected_at: context.created_at ?? null,
      selected_at_ms: Date.parse(context.created_at ?? ''),
      pointer: relativePointer(repoRoot, contextPath),
    });
  }
  return contexts
    .filter((entry) => Number.isFinite(entry.selected_at_ms))
    .sort((a, b) => b.selected_at_ms - a.selected_at_ms)[0] ?? null;
}

function parseMarkdownRows(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && line.endsWith('|'))
    .map((line) => line.slice(1, -1).split('|').map((cell) => cell.trim()))
    .filter((row) => row.length >= 3 && !row.every((cell) => /^-+$/.test(cell)));
}

function normalizeStatus(value) {
  const normalized = String(value ?? '').toLowerCase().replace(/`/g, '').trim();
  if (normalized === 'satisfied') return 'satisfied';
  if (normalized.includes('functional satisfied')) return 'partial';
  if (normalized.includes('partial')) return 'partial';
  if (normalized.includes('missing')) return 'missing';
  if (normalized.includes('blocked')) return 'blocked';
  return normalized || 'not-verified';
}

function normalizeLegacyPatternStatus(value) {
  const normalized = String(value ?? '').toLowerCase().replace(/[`*_]/g, '').trim();
  for (const status of LEGACY_PATTERN_STATUSES) {
    if (normalized === status || normalized.includes(status)) return status;
  }
  return normalized || 'missing';
}

function ageHoursSince(iso, now) {
  const timestamp = Date.parse(iso);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, (now.getTime() - timestamp) / 3600000);
}

function relativePointer(repoRoot, path) {
  const relative = path.startsWith(repoRoot) ? path.slice(repoRoot.length).replace(/^\/+/, '') : path;
  return relative || '.';
}

async function readOptionalText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

async function readOptionalJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function readCutoverEvidence(repoRoot) {
  const root = cutoverEvidenceRoot(repoRoot);
  const records = [];
  let skippedInvalid = 0;
  try {
    await access(root, fsConstants.R_OK);
  } catch {
    return { records, latest: null, skipped_invalid: 0 };
  }
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !CUTOVER_RUN_ID_RE.test(entry.name)) continue;
    const evidencePath = resolve(root, entry.name, 'evidence.json');
    const artifact = await readOptionalJson(evidencePath);
    if (!isCutoverEvidenceArtifact(artifact)) {
      skippedInvalid += 1;
      continue;
    }
    records.push({
      ...artifact,
      evidence_pointer: relativePointer(repoRoot, evidencePath),
      selected_at_ms: Date.parse(artifact.created_at ?? ''),
    });
  }
  const sorted = records
    .filter((entry) => Number.isFinite(entry.selected_at_ms))
    .sort((a, b) => a.selected_at_ms - b.selected_at_ms);
  return {
    records: sorted,
    latest: sorted.at(-1) ?? null,
    skipped_invalid: skippedInvalid,
  };
}

function isCutoverEvidenceArtifact(value) {
  return value
    && typeof value === 'object'
    && value.schema_version === CUTOVER_EVIDENCE_SCHEMA_VERSION
    && CUTOVER_RUN_ID_RE.test(value.run_id ?? '')
    && FOOTER_STATES.has(value.footer?.state)
    && OMCC_ACTIVITY.has(value.dogfood?.omcc_dev_active)
    && /^\d{4}-\d{2}-\d{2}$/.test(value.dogfood?.date ?? '');
}

function cutoverEvidenceRoot(repoRoot) {
  return resolve(repoRoot, '.agentic-plugins/runs/cutover');
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function assertInside(root, target) {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  if (normalizedTarget !== normalizedRoot && !normalizedTarget.startsWith(`${normalizedRoot}/`)) {
    throw new Error(`Refusing to write outside cutover evidence root: ${target}`);
  }
}

function normalizeArtifactPointers(repoRoot, values) {
  return values.map((value) => {
    const [kind, rawPointer] = String(value).split('=', 2);
    const pointer = rawPointer ?? kind;
    const normalizedKind = rawPointer ? kind : 'artifact';
    if (!ARTIFACT_KIND_RE.test(normalizedKind)) throw new Error(`Invalid artifact kind: ${normalizedKind}`);
    if (/[\r\n\u0000]/.test(pointer)) throw new Error('Artifact pointer must be a single line');
    return {
      kind: normalizedKind,
      pointer: pointer.startsWith('/') ? relativePointer(repoRoot, resolve(pointer)) : pointer,
    };
  });
}

function makeCutoverRunId(now) {
  return `cutover-${timestampForRunId(now)}-${randomBytes(3).toString('hex')}`;
}

function validateCutoverRunId(value) {
  const text = String(value ?? '').trim();
  if (!CUTOVER_RUN_ID_RE.test(text)) throw new Error('--run-id is invalid');
  return text;
}

function timestampForRunId(now) {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function validateDate(value, label) {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00.000Z`))) {
    throw new Error(`${label} must be YYYY-MM-DD`);
  }
  return text;
}

function localDateString(now, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function addUtcDays(date, offset) {
  const timestamp = Date.parse(`${date}T00:00:00.000Z`);
  return new Date(timestamp + offset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function formatText(report) {
  if (report.help) return helpText();
  if (report.command === 'record') {
    return [
      `runtime:cutover record ${report.version} (${report.status})`,
      `repo: ${report.repo_root}`,
      `run-id: ${report.run_id}`,
      `dogfood-date: ${report.dogfood_date}`,
      `evidence: ${report.evidence_pointer}`,
      `latest: ${report.latest_pointer}`,
    ].join('\n');
  }
  const lines = [
    `runtime:cutover-audit ${report.version} (${report.status})`,
    `repo: ${report.repo_root}`,
    `ready-candidate: ${report.ready_candidate}`,
  ];
  if (report.cutover_gate?.candidate_required?.length) {
    lines.push(`candidate gate: ${report.cutover_gate.candidate_required.join('; ')}`);
    if (report.cutover_gate.final_required?.length) {
      lines.push(`final gate: ${report.cutover_gate.final_required.join('; ')}`);
    }
  } else if (report.cutover_gate?.required?.length) {
    lines.push(`gate: ${report.cutover_gate.required.join('; ')}`);
  }
  for (const check of report.checks ?? []) {
    lines.push(`- ${check.id}: ${check.status}; ${check.label}`);
    for (const evidenceLine of formatCheckEvidence(check)) lines.push(`  ${evidenceLine}`);
    if (check.next_action) lines.push(`  next: ${check.next_action}`);
  }
  if (report.next_actions?.length) {
    lines.push('', 'next actions:');
    for (const action of report.next_actions) lines.push(`- ${action.id}: ${action.next_action}`);
  }
  if (report.limits?.length) {
    lines.push('', 'limits:');
    for (const limit of report.limits) lines.push(`- ${limit}`);
  }
  return lines.join('\n');
}

function formatCheckEvidence(check) {
  switch (check.id) {
    case 'adr0012_conditions': {
      const statuses = check.evidence?.statuses ?? [];
      const unresolved = check.evidence?.unresolved_conditions ?? [];
      const missing = check.evidence?.missing_conditions ?? [];
      const lines = [];
      if (statuses.length) lines.push(`conditions: ${statuses.map((row) => `${row.condition}:${row.status}`).join(', ')}`);
      if (unresolved.length) lines.push(`unresolved: ${unresolved.map((row) => `${row.condition}:${row.status}`).join(', ')}`);
      if (missing.length) lines.push(`missing: ${missing.join(', ')}`);
      return lines;
    }
    case 'omcc_replacement_scorecard': {
      const total = check.evidence?.total ?? 0;
      const satisfied = check.evidence?.satisfied ?? 0;
      const unresolved = check.evidence?.unresolved ?? [];
      const summary = `scorecard: satisfied=${satisfied}/${total}`;
      return unresolved.length
        ? [`${summary}; unresolved=${unresolved.map((row) => `${row.requirement}:${row.status}`).join(', ')}`]
        : [summary];
    }
    case 'legacy_omcc_pattern_map': {
      const evidence = check.evidence ?? {};
      const counts = evidence.counts ?? {};
      const lines = [
        `legacy map: patterns=${evidence.total ?? 0}; improved=${counts.improved ?? 0}; retained=${counts.retained ?? 0}; rejected=${counts.rejected ?? 0}; deferred=${counts.deferred ?? 0}`,
      ];
      if (evidence.missing_patterns?.length) lines.push(`missing patterns: ${evidence.missing_patterns.join(', ')}`);
      if (evidence.invalid_statuses?.length) lines.push(`invalid statuses: ${evidence.invalid_statuses.map((row) => `${row.id}:${row.status}`).join(', ')}`);
      if (evidence.active_dependency_blockers?.length) lines.push(`active dependency blockers: ${evidence.active_dependency_blockers.map((row) => row.id).join(', ')}`);
      return lines;
    }
    case 'observed_experience_parity': {
      const evidence = check.evidence ?? {};
      const lines = [
        `experience parity: status=${evidence.status ?? '<none>'}; score=${evidence.score_percent ?? '<none>'}%; manual-followups=${evidence.manual_followup_count ?? '<none>'}`,
      ];
      if (evidence.unresolved_criteria?.length) {
        lines.push(`unresolved criteria: ${evidence.unresolved_criteria.map((row) => `${row.id}:${row.status}`).join(', ')}`);
      }
      if (evidence.next_actions?.length) {
        lines.push(`manual next actions: ${evidence.next_actions.map((row) => row.id).join(', ')}`);
      }
      if (evidence.recorded_doctor_proof?.applied_criteria?.length) {
        lines.push(`recorded proof applied: ${evidence.recorded_doctor_proof.applied_criteria.join(', ')}; run=${evidence.recorded_doctor_proof.run_id}`);
      }
      return lines;
    }
    case 'dogfood_evidence_window': {
      const evidence = check.evidence ?? {};
      const lines = [
        `dogfood window: covered=${evidence.covered_days ?? 0}/${evidence.required_days ?? 0}; latest=${evidence.latest_date ?? '<none>'}; records=${evidence.total_records ?? 0}`,
      ];
      if (evidence.window_start_date || evidence.window_end_date) {
        lines.push(`window: ${evidence.window_start_date ?? '<none>'}..${evidence.window_end_date ?? '<none>'}`);
      }
      if (evidence.missing_dates?.length) lines.push(`missing dates: ${evidence.missing_dates.join(', ')}`);
      if (evidence.remaining_dates?.length) lines.push(`remaining dates: ${evidence.remaining_dates.join(', ')}`);
      if (evidence.blocked_dates?.length) lines.push(`blocked dates: ${evidence.blocked_dates.join(', ')}`);
      return lines;
    }
    case 'latest_completion_footer_state':
      return [`footer: state=${check.evidence?.footer_state ?? '<none>'}; source=${check.evidence?.source_run_id ?? '<explicit-or-none>'}`];
    case 'omcc_dev_daily_workflow':
      return [`omcc-dev-active: ${check.evidence?.omcc_dev_active ?? 'unknown'}; source=${check.evidence?.source_run_id ?? '<explicit-or-none>'}`];
    default:
      return [];
  }
}

export function parseArgs(argv) {
  const args = [...argv];
  const options = {};
  if (args[0] === 'audit' || args[0] === 'cutover-audit') {
    options.command = 'audit';
    args.shift();
  } else if (args[0] === 'record') {
    options.command = 'record';
    args.shift();
  } else {
    options.command = 'audit';
  }
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === 'record') {
      options.command = 'record';
      continue;
    }
    if (arg === 'audit' || arg === 'cutover-audit') {
      options.command = 'audit';
      continue;
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
      case '--max-artifact-age-hours':
        options.maxArtifactAgeHours = positiveNumber(requireValue(args, arg), arg);
        break;
      case '--dogfood-window-days':
        options.dogfoodWindowDays = positiveInteger(requireValue(args, arg), arg);
        break;
      case '--permission-proof':
        options.permissionProof = true;
        break;
      case '--execute-permission-proof':
        options.executePermissionProof = true;
        break;
      case '--permission-proof-timeout-ms':
        options.permissionProofTimeoutMs = positiveInteger(requireValue(args, arg), arg);
        break;
      case '--deep-peer-smoke':
        options.deepPeerSmoke = true;
        break;
      case '--execute-deep-peer-smoke':
        options.executeDeepPeerSmoke = true;
        break;
      case '--deep-peer-smoke-timeout-ms':
        options.deepPeerSmokeTimeoutMs = positiveInteger(requireValue(args, arg), arg);
        break;
      case '--workflow-continuation-proof':
        options.workflowContinuationProof = true;
        break;
      case '--execute-workflow-continuation-proof':
        options.executeWorkflowContinuationProof = true;
        break;
      case '--workflow-continuation-proof-timeout-ms':
        options.workflowContinuationProofTimeoutMs = positiveInteger(requireValue(args, arg), arg);
        break;
      case '--dogfood-date':
        options.dogfoodDate = validateDate(requireValue(args, arg), arg);
        break;
      case '--footer-state': {
        const value = requireValue(args, arg);
        if (!FOOTER_STATES.has(value)) throw new Error('--footer-state is invalid');
        options.footerState = value;
        break;
      }
      case '--footer-reason':
        options.footerReason = requireValue(args, arg);
        break;
      case '--omcc-dev-active': {
        const value = requireValue(args, arg);
        if (!OMCC_ACTIVITY.has(value)) throw new Error('--omcc-dev-active must be yes, no, or unknown');
        options.omccDevActive = value;
        break;
      }
      case '--omcc-dev-note':
        options.omccDevNote = requireValue(args, arg);
        break;
      case '--summary':
        options.summary = requireValue(args, arg);
        break;
      case '--artifact':
        if (!options.artifacts) options.artifacts = [];
        options.artifacts.push(requireValue(args, arg));
        break;
      case '--run-id':
        options.runId = validateCutoverRunId(requireValue(args, arg));
        break;
      case '--help':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (options.executePermissionProof && !options.permissionProof) options.permissionProof = true;
  if (options.executeDeepPeerSmoke && !options.deepPeerSmoke) options.deepPeerSmoke = true;
  if (options.executeWorkflowContinuationProof && !options.workflowContinuationProof) {
    options.workflowContinuationProof = true;
  }
  return options;
}

function requireValue(args, flag) {
  if (args.length === 0 || args[0].startsWith('-')) throw new Error(`${flag} requires a value`);
  return args.shift();
}

function positiveNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label} must be a non-negative number`);
  return number;
}

function positiveInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${label} must be a positive integer`);
  return number;
}

function helpText() {
  return `runtime:cutover-audit ${VERSION}

Usage:
  runtime:cutover-audit [--format text|json] [--max-artifact-age-hours N]
    [--permission-proof] [--execute-permission-proof] [--permission-proof-timeout-ms N]
    [--deep-peer-smoke] [--execute-deep-peer-smoke] [--deep-peer-smoke-timeout-ms N]
    [--workflow-continuation-proof] [--execute-workflow-continuation-proof] [--workflow-continuation-proof-timeout-ms N]
  runtime:cutover-audit --footer-state <state> --omcc-dev-active yes|no|unknown
  runtime:cutover-audit record --footer-state <state> --omcc-dev-active yes|no|unknown [--dogfood-date YYYY-MM-DD]

Builds an omcc cutover readiness report. Audit mode is read-only. Record mode
writes only an explicit cutover evidence artifact under .agentic-plugins/runs.
Proof flags are passed through to runtime:doctor and execute peer/workflow
proofs only when the corresponding --execute-* flag is provided.
The report can only emit cutover-ready-candidate for the evidence gate; final
cutover still requires explicit user declaration.`;
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = options.help
      ? { help: true, version: VERSION }
      : options.command === 'record'
        ? await recordCutoverEvidence(options)
        : await runCutoverAudit(options);
    const format = options.format ?? 'text';
    process.stdout.write(format === 'json' ? `${JSON.stringify(report, null, 2)}\n` : `${formatText(report)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main();
}
