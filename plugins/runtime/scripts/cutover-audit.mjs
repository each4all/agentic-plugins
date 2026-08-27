#!/usr/bin/env node

import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runDoctor } from './doctor.mjs';
import { elapsedMsSince } from './lib/clock.mjs';
import { RUNTIME_VERSION } from './version.mjs';
import { isReadyCompatState } from './lib/compat-artifacts.mjs';

const VERSION = RUNTIME_VERSION;
const CUTOVER_EVIDENCE_SCHEMA_VERSION = 'runtime-cutover-evidence-1.0';
const DEFAULT_MAX_ARTIFACT_AGE_HOURS = 24;
const DEFAULT_DOGFOOD_WINDOW_DAYS = 7;
const CHECK_PASS = new Set(['satisfied', 'current', 'fresh', 'not-active']);
// Unready is the COMPLEMENT of pass, not a second list.
//
// It was a second list, and the two had already drifted: doctor reports
// `unparseable` for a malformed host-parity baseline (ADR-0051 §Decision 4)
// and `unparseable` was in neither set — so the audit correctly refused to
// call the cutover ready, and then dropped the one line telling the operator
// what to repair. Reproduced before this change: `next_action` present,
// `next_actions` empty.
//
// `manual` is the one status that is neither: it is a human step the audit
// cannot verify, and `buildCutoverGateDetails` already excluded it with this
// exact predicate. Two copies of one rule, one of them wrong, is the shape
// this merge removes.
function checkUnready(status) {
  return !CHECK_PASS.has(status) && status !== 'manual';
}
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
  // ⚠ TWO ENTRIES ARE GONE (ADR-0056 §Decisions 1 and 4): the human-granted
  // assurance gate and the assurance-capable runtime floor. This list is the
  // audit's own explanation of what it gates on, so a check absent from `checks`
  // must be absent here too — a stale line names a blocker the operator cannot
  // clear, which is the mirror of the "hard check absent from the list" defect
  // this comment originally recorded.
  'the latest compatibility run is intact, current, and describes this machine',
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
  const [scorecardText, legacyPatternText, developmentText, manifest] = await Promise.all([
    readOptionalText(resolve(repoRoot, 'docs/assurance/omcc-cutover-scorecard.md')),
    readOptionalText(resolve(repoRoot, 'docs/assurance/omcc-legacy-pattern-map.md')),
    readOptionalText(resolve(repoRoot, 'docs/DEVELOPMENT.md')),
    readOptionalJson(resolve(repoRoot, '.release-please-manifest.json')),
  ]);

  const checks = [
    checkAdr0012Conditions({ repoRoot, text: developmentText }),
    checkScorecardRequirements({ repoRoot, text: scorecardText }),
    checkLegacyPatternMap({ repoRoot, text: legacyPatternText }),
    checkObservedExperienceParity(doctor),
    checkPluginVersions({ repoRoot, manifest, doctor }),
    checkCompatFreshness({ doctor, now, maxArtifactAgeHours }),
    await checkConsensusAndContext({ repoRoot, doctor, now, maxArtifactAgeHours }),
    checkDogfoodEvidenceWindow({ evidence: cutoverEvidence, now, requiredDays: dogfoodWindowDays, timeZone }),
    checkFooterState({ options, latestEvidence }),
    checkOmccActivity({ options, latestEvidence }),
  ];
  const readyCandidate = checks.every((check) => CHECK_PASS.has(check.status));
  const observations = [observeHostParityBaseline(doctor)];
  const cutoverGate = buildCutoverGateDetails(checks, observations);
  const proofExecutionRequested = Boolean(
    options.executePermissionProof
      || options.executeDeepPeerSmoke
      || options.executeWorkflowContinuationProof
  );
  const report = {
    command: 'cutover-audit',
    version: VERSION,
    status: readyCandidate ? 'cutover-ready-candidate' : 'not-ready',
    ready_candidate: readyCandidate,
    generated_at: now.toISOString(),
    repo_root: repoRoot,
    cutover_gate: cutoverGate,
    operator_verification: buildOperatorVerification({ checks, cutoverGate, readyCandidate, doctor }),
    checks,
    // ⚠ NO SILENT BLOCKER. `checkUnready` being the complement of pass makes every
    // new status unready, which is necessary and NOT sufficient: this list then
    // dropped any entry whose `next_action` was absent, so a blocking check with
    // no remediation still vanished — the audit refusing readiness and printing
    // nothing to fix, which is the exact incident recorded at the top of this
    // file, surviving one layer down.
    //
    // A conservative fallback is used instead of a filter. It is deliberately
    // generic: a specific instruction invented here would be a guess, while
    // naming the check and telling the operator where to look is always true.
    next_actions: checks
      .filter((check) => checkUnready(check.status))
      .map((check) => ({
        id: check.id,
        next_action: check.next_action
          ?? `Resolve "${check.label ?? check.id}" (status ${check.status}) — this check blocks readiness and reported no remediation of its own; inspect its evidence in this report.`,
      })),
    // Exactness travels here rather than in `checks`, because everything in
    // `checks` gates readiness (ADR-0053 §Decision 4 moved the gate off it).
    observations,
    limits: [
      proofExecutionRequested
        ? 'This audit does not install, uninstall, update, authenticate, mutate host config, mutate git state, or delete artifacts; explicit proof flags can invoke bounded peer/workflow commands without relaxing host permissions.'
        : 'This audit is read-only and does not install, uninstall, update, authenticate, mutate host config, mutate git state, invoke peer/workflow executors, or delete artifacts.',
      'cutover-ready-candidate means the evidence gate passed; it is not final cutover because ADR-0007 still requires explicit user declaration.',
      'Dogfood evidence is accepted only from explicit runtime:cutover record artifacts or explicit current-run flags.',
      'Unknown dogfood or omcc-dev usage evidence blocks readiness rather than being inferred.',
    ],
  };
  if (options.completionAudit) {
    report.completion_audit = buildCompletionAudit({ repoRoot, checks, cutoverGate, observations });
  }
  return report;
}

function buildCutoverGateDetails(checks, observations = []) {
  // Observations join the lookup, and only the lookup. They carry the facts the
  // checklist reports — exactness is one — while staying out of `checks`, where
  // every entry gates readiness (ADR-0053 §Decision 4).
  const byId = new Map([...observations, ...checks].map((entry) => [entry.id, entry]));
  return {
    candidate_required: CUTOVER_CANDIDATE_GATE,
    final_required: CUTOVER_FINAL_GATE,
    required: [...CUTOVER_CANDIDATE_GATE, ...CUTOVER_FINAL_GATE],
    note: 'runtime:cutover-audit reports candidate readiness evidence only; final cutover still requires explicit user declaration.',
    details: [
      adrConditionGateDetail(byId.get('adr0012_conditions')),
      scorecardGateDetail(byId.get('omcc_replacement_scorecard')),
      experienceParityGateDetail(byId.get('observed_experience_parity')),
      dogfoodGateDetail(byId.get('dogfood_evidence_window')),
      footerGateDetail(byId.get('latest_completion_footer_state')),
      {
        id: 'final_owner_declaration',
        phase: 'final',
        status: 'manual',
        required: 'explicit user declaration that omcc can be archived or removed per ADR-0007',
        current: 'not machine-verifiable; runtime can only report cutover-ready-candidate',
        blocker: 'owner decision remains required after every candidate evidence gate passes',
      },
    ],
  };
}

function adrConditionGateDetail(check) {
  const statuses = check?.evidence?.statuses ?? [];
  const statusText = statuses.length
    ? statuses.map((row) => `${row.condition}:${row.status}`).join(', ')
    : '<missing>';
  const unresolved = (check?.evidence?.unresolved_conditions ?? [])
    .map((row) => `${row.condition}:${row.status}`);
  const missing = check?.evidence?.missing_conditions ?? [];
  const blockers = [
    ...unresolved,
    ...missing.map((condition) => `${condition}:missing`),
  ];
  return {
    id: 'adr0012_condition_gate',
    phase: 'candidate',
    status: check?.status ?? 'not-verified',
    required: 'ADR-0012 conditions 1-4 satisfied; conditions 2/3 prove bidirectional engineer execution and agentic-plugins-only development sufficiency',
    current: statusText,
    blocker: blockers.length ? blockers.join(', ') : null,
  };
}

function scorecardGateDetail(check) {
  const total = check?.evidence?.total ?? 0;
  const satisfied = check?.evidence?.satisfied ?? 0;
  const unresolved = (check?.evidence?.unresolved ?? []).map((row) => `${row.requirement}:${row.status}`);
  return {
    id: 'scorecard_gate',
    phase: 'candidate',
    status: check?.status ?? 'not-verified',
    required: 'omcc replacement scorecard 100%; no partial or missing requirement rows',
    current: total ? `${satisfied}/${total} satisfied` : '<missing>',
    blocker: unresolved.length ? unresolved.join(', ') : null,
  };
}

function experienceParityGateDetail(check) {
  const evidence = check?.evidence ?? {};
  const current = [
    `status=${evidence.status ?? '<none>'}`,
    `score=${evidence.score_percent ?? '<none>'}%`,
    `manual-followups=${evidence.manual_followup_count ?? '<none>'}`,
  ].join('; ');
  const blockers = [];
  if (evidence.unresolved_criteria?.length) {
    blockers.push(evidence.unresolved_criteria.map((row) => `${row.id}:${row.status}`).join(', '));
  }
  if (evidence.next_actions?.length) {
    blockers.push(`followups=${evidence.next_actions.map((row) => row.id).join(', ')}`);
  }
  return {
    id: 'observed_experience_parity_gate',
    phase: 'candidate',
    status: check?.status ?? 'not-verified',
    required: 'observed runtime experience parity ready, score 100%, and zero manual follow-ups',
    current,
    blocker: blockers.length ? blockers.join('; ') : null,
  };
}

function dogfoodGateDetail(check) {
  const evidence = check?.evidence ?? {};
  const blockers = [];
  if (evidence.missing_dates?.length) blockers.push(`missing=${evidence.missing_dates.join(', ')}`);
  if (evidence.remaining_dates?.length) blockers.push(`remaining=${evidence.remaining_dates.join(', ')}`);
  if (evidence.blocked_dates?.length) blockers.push(`blocked=${evidence.blocked_dates.join(', ')}`);
  return {
    id: 'dogfood_window_gate',
    phase: 'candidate',
    status: check?.status ?? 'not-verified',
    required: 'one forward-looking calendar week of explicit no-omcc-dev dogfood evidence',
    current: `covered=${evidence.covered_days ?? 0}/${evidence.required_days ?? DEFAULT_DOGFOOD_WINDOW_DAYS}; window=${evidence.window_start_date ?? '<none>'}..${evidence.window_end_date ?? '<none>'}`,
    blocker: blockers.length ? blockers.join('; ') : null,
  };
}

function footerGateDetail(check) {
  const state = check?.evidence?.footer_state ?? '<none>';
  return {
    id: 'completion_footer_gate',
    phase: 'candidate',
    status: check?.status ?? 'not-verified',
    required: 'latest completion footer state is closed',
    current: `state=${state}`,
    blocker: state === 'closed' ? null : 'outstanding work remains according to the latest completion footer',
  };
}

// `doctor` is read only to name the bundled hook-bearing plugins the operator
// must actually review. The checklist used to hardcode "engineer and
// orchestrator"; once a fourth hook-bearing plugin joined the runtime inventory
// (founder, then designer), an operator following the literal text would review
// the wrong set and leave the newcomer's hooks untrusted — so the cutover gate
// could never satisfy while the checklist claimed it should. Derive the names.
function buildOperatorVerification({ checks, cutoverGate, readyCandidate, doctor = null }) {
  const byId = new Map(checks.map((check) => [check.id, check]));
  const parity = byId.get('observed_experience_parity');
  const dogfood = byId.get('dogfood_evidence_window');
  const ownerDeclaration = cutoverGate.details?.find((detail) => detail.id === 'final_owner_declaration');
  const items = [];

  const hookFollowups = (parity?.evidence?.next_actions ?? []).filter((action) => (
    action.id === 'codex-hook-review'
      || action.id === 'lifecycle_hook_continuity'
      || action.id === 'plugin_management_followups'
      || action.commands?.includes('/hooks')
  ));
  const hookCriteria = (parity?.evidence?.unresolved_criteria ?? []).filter((criterion) => (
    criterion.id === 'lifecycle_hook_continuity'
      || criterion.id === 'plugin_management_followups'
  ));
  if (hookFollowups.length > 0 || hookCriteria.length > 0) {
    const hookCommands = uniqueStrings(hookFollowups.flatMap((action) => action.commands ?? []));
    // Prefer the explicit review targets; fall back to the bundled set, then to
    // a generic phrase when doctor gave us neither (never a stale hardcoded list).
    const reviewPlugins = uniqueStrings([
      ...(doctor?.codex_plugin_hooks?.review_targets ?? []).map((target) => target.plugin).filter(Boolean),
      ...(doctor?.codex_plugin_hooks?.summary?.bundled_plugins ?? []),
    ]);
    const reviewSubject = reviewPlugins.length
      ? `bundled ${reviewPlugins.join(', ')} hooks`
      : 'every bundled agentic-plugins hook';
    const hookReason = hookFollowups.find((action) => action.reason)?.reason ?? (
      parity?.status === 'satisfied'
        ? 'Codex hook review has no outstanding runtime follow-up.'
        : 'Observed experience parity is not ready; inspect Codex hook review/trust state.'
    );
    items.push({
      id: 'codex-hook-review',
      status: parity?.status === 'satisfied' ? 'satisfied' : 'pending',
      owner: 'operator',
      command: hookCommands.length ? hookCommands.join(', ') : '/hooks',
      verify: `In the active Codex session, review and enable/trust ${reviewSubject}.`,
      pass_condition: 'runtime:doctor reports observed experience parity ready, score 100%, and zero manual follow-ups.',
      fail_condition: 'Any bundled hook remains disabled, untrusted, inactive, or still points at an old cache-version command path.',
      after: 'Run runtime:settings --attest-codex-hook-review, then rerun runtime:doctor and runtime:cutover audit.',
      reason: hookReason,
    });
  }

  if (dogfood?.status !== 'satisfied') {
    const evidence = dogfood?.evidence ?? {};
    const missingDates = evidence.missing_dates ?? [];
    const remainingDates = evidence.remaining_dates ?? [];
    const blockedDates = evidence.blocked_dates ?? [];
    const nextDate = missingDates[0] ?? remainingDates[0] ?? null;
    const dateText = [
      missingDates.length ? `missing=${missingDates.join(', ')}` : null,
      remainingDates.length ? `remaining=${remainingDates.join(', ')}` : null,
      blockedDates.length ? `blocked=${blockedDates.join(', ')}` : null,
    ].filter(Boolean).join('; ');
    items.push({
      id: 'dogfood-window',
      status: dogfood?.status ?? 'not-verified',
      owner: 'operator',
      command: nextDate
        ? `runtime:cutover record --footer-state closed --omcc-dev-active no --dogfood-date ${nextDate}`
        : 'runtime:cutover record --footer-state closed --omcc-dev-active no',
      verify: 'Record each calendar day only after normal agentic-plugins development completed without omcc-dev fallback.',
      pass_condition: `runtime:cutover audit reports dogfood covered=${evidence.required_days ?? DEFAULT_DOGFOOD_WINDOW_DAYS}/${evidence.required_days ?? DEFAULT_DOGFOOD_WINDOW_DAYS}.`,
      fail_condition: 'Any day is missing, future, blocked, or records omcc-dev-active=yes/unknown.',
      after: 'Continue daily records until the forward-looking window is complete.',
      reason: dateText || dogfood?.next_action || null,
    });
  }

  items.push({
    id: 'final-owner-declaration',
    status: readyCandidate ? 'manual' : 'blocked',
    owner: 'owner',
    command: '<explicit owner cutover declaration>',
    verify: 'Declare omcc archival/removal only after runtime reports cutover-ready-candidate.',
    pass_condition: 'Owner explicitly declares final cutover per ADR-0007.',
    fail_condition: 'Any candidate gate remains partial, blocked, stale, missing, or not-verified.',
    after: readyCandidate
      ? 'Proceed with the owner-approved omcc archive/removal runbook.'
      : 'Wait until candidate gates pass; do not ask for final cutover yet.',
    reason: ownerDeclaration?.blocker ?? null,
  });

  return items;
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))];
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

function checkAdr0012Conditions({ repoRoot, text }) {
  const rows = parseMarkdownRows(text).filter((row) => /^[1-4]$/.test(row[0]));
  const statuses = rows.map((row) => ({ condition: row[0], status: normalizeStatus(row[2]) }));
  const missing = [1, 2, 3, 4].filter((condition) => !statuses.some((row) => row.condition === String(condition)));
  const notSatisfied = statuses.filter((row) => row.status !== 'satisfied');
  return {
    id: 'adr0012_conditions',
    label: 'ADR-0012 condition statuses',
    status: missing.length > 0 ? 'missing' : notSatisfied.length === 0 ? 'satisfied' : 'partial',
    evidence: {
      pointer: relativePointer(repoRoot, resolve(repoRoot, 'docs/DEVELOPMENT.md')),
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

function checkScorecardRequirements({ repoRoot, text }) {
  const rows = parseMarkdownRows(text).filter((row) => /^R\d+[a-z]?$/.test(row[0]));
  const statuses = rows.map((row) => ({
    requirement: row[0],
    summary: row[1] ?? null,
    evidence_summary: row[2] ?? null,
    status: normalizeStatus(row[3]),
    gate: row[4] ?? null,
  }));
  const unresolved = statuses.filter((row) => row.status !== 'satisfied');
  return {
    id: 'omcc_replacement_scorecard',
    label: 'omcc replacement requirement scorecard',
    status: rows.length === 0 ? 'missing' : unresolved.length === 0 ? 'satisfied' : 'partial',
    evidence: {
      pointer: relativePointer(repoRoot, resolve(repoRoot, 'docs/assurance/omcc-cutover-scorecard.md')),
      total: rows.length,
      satisfied: statuses.filter((row) => row.status === 'satisfied').length,
      requirements: statuses,
      unresolved,
    },
    next_action: unresolved.length > 0
      ? 'Resolve remaining scorecard rows before declaring cutover readiness.'
      : null,
  };
}

function buildCompletionAudit({ repoRoot, checks, cutoverGate, observations = [] }) {
  // Observations join the lookup for the same reason they do in the gate details:
  // the checklist REPORTS exactness, while `checks` is the set that gates.
  const byId = new Map([...observations, ...checks].map((entry) => [entry.id, entry]));
  const scorecard = byId.get('omcc_replacement_scorecard');
  const adrConditions = byId.get('adr0012_conditions');
  const requirements = (scorecard?.evidence?.requirements ?? []).map((row) => ({
    id: row.requirement,
    status: row.status,
    requirement: compactCell(row.summary, 180),
    evidence: compactCell(row.evidence_summary, 220),
    gate: compactCell(row.gate, 180),
    source: scorecard.evidence.pointer,
  }));
  const conditions = (adrConditions?.evidence?.statuses ?? []).map((row) => ({
    id: `ADR-0012 condition ${row.condition}`,
    condition: row.condition,
    status: row.status,
    source: adrConditions.evidence.pointer,
  }));
  const artifactChecklist = [
    checklistItem({
      id: 'adr0012-condition-matrix',
      kind: 'file',
      status: adrConditions?.status,
      source: adrConditions?.evidence?.pointer ?? 'docs/DEVELOPMENT.md',
      covers: 'ADR-0012 conditions 1-4 and omcc removal precondition bookkeeping',
    }),
    checklistItem({
      id: 'omcc-replacement-scorecard',
      kind: 'file',
      status: scorecard?.status,
      source: scorecard?.evidence?.pointer ?? 'docs/assurance/omcc-cutover-scorecard.md',
      covers: 'User requirements R1-R11, including R7a/R7b split',
    }),
    checklistItem({
      id: 'legacy-omcc-pattern-map',
      kind: 'file',
      status: byId.get('legacy_omcc_pattern_map')?.status,
      source: byId.get('legacy_omcc_pattern_map')?.evidence?.pointer ?? 'docs/assurance/omcc-legacy-pattern-map.md',
      covers: 'D1-D20 legacy omcc-dev pattern disposition and active-dependency blockers',
    }),
    checklistItem({
      id: 'host-parity-baseline',
      kind: 'file',
      status: byId.get('host_parity_baseline')?.status,
      // ADR-0051 §Decision 8 — the status is doctor's, and doctor reads the
      // PACKAGED copy. Naming the repository path here would attribute the
      // verdict to a file doctor no longer opens. Report the path doctor
      // actually resolved, falling back to the packaged-relative form.
      source: byId.get('host_parity_baseline')?.evidence?.provenance?.path
        ?? '<runtime package>/docs/host-parity-baseline.md',
      // REPORTED, not gated (ADR-0053 §Decision 4). The prose says so, because a
      // checklist row that reads like a gate is how an operator learns the wrong
      // thing about what blocks them.
      covers: 'Remembered Claude Code and Codex CLI behavior/version baseline — exactness, reported and not gated since ADR-0053 §Decision 4',
    }),
    checklistItem({
      id: 'runtime-doctor-proof',
      kind: 'command',
      status: byId.get('observed_experience_parity')?.status,
      source: 'runtime:doctor --permission-proof --execute-permission-proof --deep-peer-smoke --execute-deep-peer-smoke --workflow-continuation-proof --execute-workflow-continuation-proof',
      covers: 'Observed Claude/Codex parity, bidirectional peer execution, and engineer workflow continuation',
      evidence: byId.get('observed_experience_parity')?.evidence?.recorded_doctor_proof?.run_id ?? null,
    }),
    checklistItem({
      id: 'runtime-settings-installed-state',
      kind: 'command',
      status: byId.get('installed_plugin_versions')?.status,
      source: 'runtime:settings --execute-plugin-management',
      covers: 'Installed/cache plugin versions match the release manifest',
      evidence: byId.get('installed_plugin_versions')?.evidence?.manifest_pointer ?? null,
    }),
    checklistItem({
      id: 'runtime-compat-freshness',
      kind: 'command',
      status: byId.get('latest_compat_snapshot')?.status,
      source: 'runtime:compat snapshot/check/plan',
      covers: 'Host CLI version drift and release-note coverage freshness',
      evidence: byId.get('latest_compat_snapshot')?.evidence?.run_id ?? null,
    }),
    checklistItem({
      id: 'runtime-consensus-context',
      kind: 'artifact',
      status: byId.get('latest_consensus_context_artifacts')?.status,
      source: '.agentic-plugins/runs/{consensus,context}/',
      covers: 'Latest consensus and context handoff evidence',
      evidence: [
        byId.get('latest_consensus_context_artifacts')?.evidence?.consensus?.run_id,
        byId.get('latest_consensus_context_artifacts')?.evidence?.context?.run_id,
      ].filter(Boolean).join(', ') || null,
    }),
    checklistItem({
      id: 'runtime-cutover-dogfood-records',
      kind: 'artifact',
      status: byId.get('dogfood_evidence_window')?.status,
      source: '.agentic-plugins/runs/cutover/',
      covers: 'Forward-looking no-omcc-dev dogfood window',
      evidence: dogfoodChecklistEvidence(byId.get('dogfood_evidence_window')),
    }),
    checklistItem({
      id: 'completion-footer-state',
      kind: 'artifact',
      status: byId.get('latest_completion_footer_state')?.status,
      source: '.agentic-plugins/runs/cutover/latest.json',
      covers: 'Latest completion footer state and next-action closure',
      evidence: byId.get('latest_completion_footer_state')?.evidence?.source_run_id ?? null,
    }),
    checklistItem({
      id: 'omcc-dev-activity',
      kind: 'artifact',
      status: byId.get('omcc_dev_daily_workflow')?.status,
      source: '.agentic-plugins/runs/cutover/latest.json',
      covers: 'Explicit yes/no/unknown daily omcc-dev activity claim',
      evidence: byId.get('omcc_dev_daily_workflow')?.evidence?.source_run_id ?? null,
    }),
    checklistItem({
      id: 'final-owner-declaration',
      kind: 'manual-gate',
      status: 'manual',
      source: 'ADR-0007 explicit user declaration',
      covers: 'Final omcc archival/removal decision after candidate gates pass',
    }),
  ];
  const gateChecklist = (cutoverGate.details ?? []).map((detail) => ({
    id: detail.id,
    phase: detail.phase,
    status: detail.status,
    required: detail.required,
    current: detail.current,
    blocker: detail.blocker ?? null,
  }));
  const missingOrWeak = [
    ...requirements
      .filter((row) => row.status !== 'satisfied')
      .map((row) => ({ id: row.id, status: row.status, source: row.source, blocker: row.gate })),
    ...conditions
      .filter((row) => row.status !== 'satisfied')
      .map((row) => ({ id: row.id, status: row.status, source: row.source, blocker: 'ADR-0012 condition is not fully satisfied' })),
    ...artifactChecklist
      .filter((item) => checkUnready(item.status))
      .map((item) => ({ id: item.id, status: item.status, source: item.source, blocker: item.covers })),
    ...gateChecklist
      .filter((item) => item.status !== 'satisfied')
      .map((item) => ({ id: item.id, status: item.status, source: item.phase, blocker: item.blocker ?? item.required })),
  ];
  return {
    objective: 'Replace omcc/omcc-dev daily development dependency with superior-compatible agentic-plugins workflows and explicit final cutover evidence.',
    repo_root: repoRoot,
    requirements,
    adr0012_conditions: conditions,
    adr0012_transition_advice: buildAdr0012TransitionAdvice({ byId, conditions }),
    artifact_checklist: artifactChecklist,
    gate_checklist: gateChecklist,
    missing_or_weak: dedupeAuditFindings(missingOrWeak),
  };
}

function buildAdr0012TransitionAdvice({ byId, conditions }) {
  const conditionStatus = new Map(conditions.map((row) => [row.condition, row.status]));
  const dogfood = byId.get('dogfood_evidence_window');
  const parity = byId.get('observed_experience_parity');
  const scorecard = byId.get('omcc_replacement_scorecard');
  const legacyMap = byId.get('legacy_omcc_pattern_map');
  const installedVersions = byId.get('installed_plugin_versions');
  const omccActivity = byId.get('omcc_dev_daily_workflow');
  const footer = byId.get('latest_completion_footer_state');
  return [
    transitionAdviceItem({
      condition: '1',
      status: conditionStatus.get('1') ?? 'missing',
      required: 'engineer reaches omcc-dev parity',
      evidence: ['orchestrator + engineer composition shipped', 'legacy pattern map complete'],
      blockers: conditionStatus.get('1') === 'satisfied' ? [] : ['condition row is not satisfied in docs/DEVELOPMENT.md'],
      next: conditionStatus.get('1') === 'satisfied' ? null : 'Review ADR-0019/ADR-0020 parity evidence, then update the condition row only if still valid.',
    }),
    transitionAdviceItem({
      condition: '2',
      status: conditionStatus.get('2') ?? 'missing',
      required: 'bidirectional engineer companion round-trip proof',
      evidence: [parity?.evidence?.recorded_doctor_proof?.run_id ?? null].filter(Boolean),
      blockers: conditionStatus.get('2') === 'satisfied' ? [] : ['condition row is not satisfied in docs/DEVELOPMENT.md'],
      next: conditionStatus.get('2') === 'satisfied' ? null : 'Run runtime:doctor proof execution and update the condition row only when both directions pass.',
    }),
    transitionAdviceItem({
      condition: '3',
      status: conditionStatus.get('3') ?? 'missing',
      required: 'agentic-plugins-only development sufficiency after sustained no-omcc-dev dogfood',
      evidence: [
        dogfoodChecklistEvidence(dogfood),
        `omcc-dev-active=${omccActivity?.evidence?.omcc_dev_active ?? 'unknown'}`,
        parity?.evidence?.recorded_doctor_proof?.run_id ?? null,
      ].filter(Boolean),
      blockers: conditionStatus.get('3') === 'satisfied'
        ? []
        : condition3Blockers({ dogfood, omccActivity, parity }),
      next: conditionStatus.get('3') === 'satisfied'
        ? null
        : 'Wait for the dogfood window to satisfy, keep omcc-dev inactive, then update docs/DEVELOPMENT.md condition 3 with the cutover evidence pointers.',
    }),
    transitionAdviceItem({
      condition: '4',
      status: conditionStatus.get('4') ?? 'missing',
      required: 'self-contained scaffolding with no remaining load-bearing omcc dependency',
      evidence: [
        `scorecard=${scorecard?.evidence?.satisfied ?? 0}/${scorecard?.evidence?.total ?? 0}`,
        `legacy-map=${legacyMap?.status ?? 'not-verified'}`,
        `installed-versions=${installedVersions?.status ?? 'not-verified'}`,
        `footer=${footer?.evidence?.footer_state ?? 'not-verified'}`,
      ],
      blockers: conditionStatus.get('4') === 'satisfied'
        ? []
        : condition4Blockers({ conditionStatus, scorecard, legacyMap, installedVersions, footer }),
      next: conditionStatus.get('4') === 'satisfied'
        ? null
        : 'After condition 3 is satisfied and final closeout evidence is closed, update condition 4 only if no rejected/deferred omcc pattern remains load-bearing.',
    }),
  ];
}

function transitionAdviceItem({ condition, status, required, evidence, blockers, next }) {
  return {
    condition,
    status,
    required,
    evidence: evidence.filter(Boolean),
    blockers,
    next,
  };
}

function condition3Blockers({ dogfood, omccActivity, parity }) {
  const blockers = [];
  if (dogfood?.status !== 'satisfied') {
    const remaining = dogfood?.evidence?.remaining_dates ?? [];
    const missing = dogfood?.evidence?.missing_dates ?? [];
    const blocked = dogfood?.evidence?.blocked_dates ?? [];
    if (remaining.length) blockers.push(`dogfood remaining dates: ${remaining.join(', ')}`);
    if (missing.length) blockers.push(`dogfood missing dates: ${missing.join(', ')}`);
    if (blocked.length) blockers.push(`dogfood blocked dates: ${blocked.join(', ')}`);
    if (!remaining.length && !missing.length && !blocked.length) blockers.push('dogfood window is not satisfied');
  }
  if (omccActivity?.status !== 'not-active') {
    blockers.push(`omcc-dev activity is ${omccActivity?.evidence?.omcc_dev_active ?? 'unknown'}`);
  }
  if (parity?.status !== 'satisfied') {
    blockers.push(`observed experience parity is ${parity?.status ?? 'not-verified'}`);
  }
  return blockers;
}

function condition4Blockers({ conditionStatus, scorecard, legacyMap, installedVersions, footer }) {
  const blockers = [];
  if (conditionStatus.get('3') !== 'satisfied') blockers.push('ADR-0012 condition 3 is not satisfied yet');
  if (scorecard?.status !== 'satisfied') blockers.push(`scorecard is ${scorecard?.status ?? 'not-verified'}`);
  if (legacyMap?.status !== 'satisfied') blockers.push(`legacy pattern map is ${legacyMap?.status ?? 'not-verified'}`);
  if (installedVersions?.status !== 'satisfied') blockers.push(`installed versions are ${installedVersions?.status ?? 'not-verified'}`);
  if (footer?.status !== 'satisfied') blockers.push(`completion footer is ${footer?.evidence?.footer_state ?? 'not-verified'}`);
  return blockers;
}

function checklistItem({ id, kind, status, source, covers, evidence = null }) {
  return {
    id,
    kind,
    status: status ?? 'not-verified',
    source,
    covers,
    evidence,
  };
}

function dogfoodChecklistEvidence(check) {
  const evidence = check?.evidence ?? {};
  if (!evidence.required_days) return null;
  return `covered=${evidence.covered_days}/${evidence.required_days}; window=${evidence.window_start_date ?? '<none>'}..${evidence.window_end_date ?? '<none>'}`;
}

function dedupeAuditFindings(findings) {
  const seen = new Set();
  const deduped = [];
  for (const finding of findings) {
    const key = `${finding.id}:${finding.status}:${finding.source}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(finding);
  }
  return deduped;
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
        source: item.source ?? null,
        host: item.host ?? null,
        commands: Array.isArray(item.commands)
          ? item.commands.filter((command) => typeof command === 'string' && command.trim().length > 0)
            .map((command) => command.trim())
          : [],
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

/**
 * Exactness, REPORTED and not gated (ADR-0053 §Decision 1 + §Decision 4).
 *
 * It stays in the report because doctor computes it, the completion audit's
 * checklist names it, and an operator comparing a drifted host against the
 * reviewed baseline needs to see it.
 *
 * ⚠ IT STAYS OUT OF `checks`, AND ADR-0056 DOES NOT CHANGE THAT. Removing the
 * assurance gate could look like an invitation to promote exactness back into
 * `checks` — it is the fact that remains, after all — but every entry there
 * gates readiness, and the freshness verdict already reaches readiness through
 * `checkCompatFreshness`'s ready set. Promoting it here would charge the same
 * fact twice, and would do it in the check whose §Decision 4 note says exactness
 * is observation-only.
 */
function observeHostParityBaseline(doctor) {
  return doctor.host_parity_baseline ?? {
    id: 'host_parity_baseline',
    label: 'Host parity baseline freshness (reported, not gated)',
    status: 'missing',
    evidence: {},
    next_action: null,
  };
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
    // ADR-0034 cross-script consumer: compare against the list-authoritative Codex
    // installed version (single-sourced in doctor's resolveCodexInstallState) rather
    // than the filesystem cache, so a stale cache cannot satisfy the version-parity
    // requirement and a list-confirmed install is not blocked by a missing cache.
    // Fall back to the cache only when the list was unavailable (decision 'fallback')
    // or the doctor report predates codex_resolved.
    const codexResolved = plugin.installed?.codex_resolved;
    const codexInstalled = (!codexResolved || codexResolved.decision === 'fallback')
      ? (plugin.cache?.codex?.latest?.manifest_version ?? null)
      : (codexResolved.version ?? null);
    return {
      package: packagePath,
      plugin: pluginName,
      expected,
      source,
      claude_cache: claudeCache,
      codex_installed: codexInstalled,
      status: expected && source === expected && claudeCache === expected && codexInstalled === expected
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

/**
 * READINESS PATH 1c — the recorded compat run: intact, current, and about THIS
 * machine (ADR-0053 §Decision 4 as replaced by ADR-0056 §Decision 6).
 *
 * ⚠ THE FOURTH CLAUSE WAS `liveCovered`, AND DELETING IT WITHOUT A REPLACEMENT
 * IS A MEASURED FAIL-OPEN. The cross-host review of the removal named it: it was
 * the live-coverage clause, not exactness, that stopped a STORED bit from
 * passing on its own, because exactness here is explicitly observation-only. An
 * old `1.1` run whose status was `current` or `assured` still parses, and its
 * recorded host pair can still equal the live one, so the check would pass on a
 * verdict from a layer that no longer exists.
 *
 * The replacement is the ERA (ADR-0056 §Decision 6 rules 1-2), and it is why
 * `isReadyCompatState` takes both halves: a record from the assurance era is
 * readable evidence of the past and is never a current verdict, whatever token
 * it carries.
 *
 * Four things must hold, and each was a way a positive answer could have been
 * wrong rather than a way to be strict:
 *
 *   COLLECTION INTEGRITY. This read only `compat_runs.latest`, while state
 *   readers mark the WHOLE collection blocked when any retained artifact is
 *   malformed. A corrupt historical artifact beside a healthy newest one passed
 *   here and was caught, if at all, by experience parity — a different check,
 *   for a different reason, by accident.
 *
 *   A READY RECORDED STATUS, IN THIS ERA. `current` is the only positive under
 *   `runtime-compat-gap-1.2`, and it means exact-and-no-drift. That does put
 *   exactness back in the gate, which ADR-0056 §Decision 6 item 4 names as one
 *   of three shapes and refuses to let anyone pick by default. It is chosen
 *   here, openly, because the two alternatives are worse: accepting the analyzed
 *   drift states (`gap_analysis_ready`, `release_notes_required`) lets a pair
 *   whose baseline nobody reconciled read healthy, and deleting this check drops
 *   host-pair identity and freshness protection that no other check performs.
 *
 *   IDENTITY BINDING. The recorded run observed SOME host pair; the live probe
 *   describes THIS one. Without binding them, a fresh snapshot of pair A beside
 *   a live observation of pair B passes — two true facts about two machines,
 *   read as one (cross-host review).
 *
 *   A LIVE PAIR TO BIND AGAINST, AND A LIVE BASELINE VERDICT. ⚠ THE SOURCE
 *   MOVED, AND ONE CLAUSE IS NEW. The pair was
 *   `host_parity_assurance.evidence.normalized_observed`; ADR-0056 §Decision 6
 *   item 3 moves it to `host_parity_baseline.evidence.normalized_observed`,
 *   which is the SAME observation without the verdict attached.
 *
 *   The NEW clause is `host_parity_baseline.status === 'current'`, and it is not
 *   the same guard as the recorded status twice over — the two bind different
 *   things, which is why both are here:
 *
 *     the recorded status  is about the run: was it drift-free when taken?
 *     the live baseline    is about NOW: does the INSTALLED packaged baseline
 *                          still describe this machine?
 *
 *   `liveCovered` used to supply the second, because coverage was evaluated
 *   against the installed record. Without a replacement, a recorded `current`
 *   inside the freshness window passes while the packaged baseline it was
 *   compared against has since been replaced — the recorded run's remembered
 *   baseline is frozen in the snapshot and nothing re-binds it. Doctor's
 *   exactness ladder is that re-binding, and it additionally refuses a
 *   TRUNCATED observed token (`1.2.3.4` reads `unknown`, not `current`), which
 *   is the second half of the same fail-open.
 */
function checkCompatFreshness({ doctor, now, maxArtifactAgeHours }) {
  const runs = doctor.compat_runs ?? null;
  const latest = runs?.latest ?? null;
  const ageHours = latest?.selected_at ? ageHoursSince(latest.selected_at, now) : null;
  // "we cannot read this artifact's age" and "this artifact is too old" are both
  // not-fresh and take DIFFERENT operator actions, so they are tracked apart.
  // Cross-host review of the first fix caught the consequence of collapsing
  // them: a run stamped in 2099 stays NEWEST by selection, so telling the
  // operator to take a fresh snapshot names an action that cannot clear the
  // gate — the artifact or the clock has to be repaired first.
  const ageUnreadable = Boolean(latest?.selected_at) && ageHours === null;
  const fresh = ageHours !== null && ageHours <= maxArtifactAgeHours;
  const collectionOk = runs?.status === 'available' && (runs?.malformed ?? 0) === 0;
  // ERA AND TOKEN, never the token alone. See the note above.
  const recordedReady = isReadyCompatState({ status: latest?.status, schemaEra: latest?.schema_era });
  const liveBaselineStatus = doctor.host_parity_baseline?.status ?? null;
  const liveBaselineCurrent = liveBaselineStatus === 'current';
  const liveObserved = doctor.host_parity_baseline?.evidence?.normalized_observed ?? null;

  // The recorded pair, from the host rows the run stored. Exactly one row per
  // host is required: a missing row cannot be compared, and duplicates mean the
  // artifact cannot say which observation it made.
  const rows = Array.isArray(latest?.host_gaps) ? latest.host_gaps : [];
  const rowFor = (host) => rows.filter((row) => row?.host === host);
  const recordedPair = {};
  let identityFault = null;
  for (const host of ['claude', 'codex']) {
    const matched = rowFor(host);
    if (matched.length !== 1) {
      identityFault = identityFault ?? `the recorded run carries ${matched.length} ${host} observations; exactly one is required to bind it to this machine`;
      continue;
    }
    recordedPair[host] = matched[0].observed_version ?? null;
  }
  if (identityFault === null) {
    for (const host of ['claude', 'codex']) {
      const recorded = recordedPair[host];
      const live = liveObserved?.[host] ?? null;
      if (recorded === null || live === null || recorded !== live) {
        identityFault = `the recorded run observed ${host} ${recorded ?? 'nothing'} while this machine reports ${live ?? 'nothing'}; the recorded evidence does not describe this host pair`;
        break;
      }
    }
  }
  const identityBound = identityFault === null;

  const ready = Boolean(latest) && collectionOk && recordedReady && identityBound && liveBaselineCurrent;
  const status = !latest
    ? 'missing'
    : ready && fresh
      ? 'fresh'
      : ready
        ? 'stale'
        : 'blocked';
  const reason = !latest
    ? 'no runtime:compat run has been recorded'
    : !collectionOk
      ? `the recorded compat collection is ${runs?.status ?? 'unreadable'} with ${runs?.malformed ?? 0} malformed artifact(s)`
      : !recordedReady
        ? (latest.schema_era !== null && latest.schema_era !== 'post-assurance'
          ? `the newest recorded run was written by the ${latest.schema_era} compatibility schema era, whose verdicts this runtime does not read as current (ADR-0056 §Decision 5)`
          : `the newest recorded run reports ${latest.status}`)
        : !identityBound
          ? identityFault
          : !liveBaselineCurrent
            ? `the installed host-parity baseline reports ${liveBaselineStatus ?? 'nothing'} against this machine, so the recorded run's remembered baseline is not re-bound to the one installed now`
            : ageUnreadable
              ? `the newest recorded run is stamped ${latest.selected_at}, which is not a readable age from here`
              : !fresh
                ? 'the newest recorded run is older than the freshness window'
                : null;
  return {
    id: 'latest_compat_snapshot',
    label: 'Latest compatibility run is intact, current, and describes this machine',
    status,
    evidence: {
      run_id: latest?.run_id ?? null,
      status: latest?.status ?? null,
      // The era travels into the evidence for the same reason it travels into
      // the predicate: a reader seeing `status: current` alone cannot tell which
      // of two meanings it carried.
      schema_era: latest?.schema_era ?? null,
      drift_class: latest?.drift_class ?? null,
      collection_status: runs?.status ?? null,
      malformed: runs?.malformed ?? null,
      recorded_pair: recordedPair,
      live_pair: liveObserved,
      identity_bound: identityBound,
      live_baseline_status: liveBaselineStatus,
      selected_at: latest?.selected_at ?? null,
      age_hours: ageHours,
      max_age_hours: maxArtifactAgeHours,
      reason,
    },
    next_action: status === 'fresh'
      ? null
      : ageUnreadable
        // A fresh run does NOT clear this one: selection is by recorded
        // timestamp, so the future-dated artifact stays newest.
        ? `${reason}. Repair the machine clock or delete the mis-stamped artifact `
          + `(${latest?.run_id ?? 'the newest compat run'}) — a new snapshot will not clear this, because the newest run is chosen by its recorded timestamp.`
        : `${reason}. Run runtime:compat snapshot and runtime:compat check for the current host pair, repairing any malformed artifacts first.`,
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
  // `null` for unparseable AND for beyond-skew-future, because callers read
  // `null` as "not fresh" and both are "this artifact establishes no age".
  // The clamp this replaced made a postdated artifact read as age 0 — the
  // freshest value there is — so a 2099 timestamp satisfied the freshness
  // gate indefinitely (measured, ST5).
  const elapsed = elapsedMsSince(now.getTime(), Date.parse(iso));
  return elapsed === null ? null : elapsed / 3600000;
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
    if (report.cutover_gate.details?.length) {
      lines.push('gate details:');
      for (const detail of report.cutover_gate.details) lines.push(`  ${formatGateDetail(detail)}`);
    }
  } else if (report.cutover_gate?.required?.length) {
    lines.push(`gate: ${report.cutover_gate.required.join('; ')}`);
  }
  if (report.operator_verification?.length) {
    lines.push('operator verification:');
    for (const item of report.operator_verification) {
      lines.push(`  - ${item.id}: ${item.status}; owner=${item.owner}; command=${compactCell(item.command, 180)}`);
      lines.push(`    verify=${compactCell(item.verify, 220)}`);
      lines.push(`    pass=${compactCell(item.pass_condition, 220)}`);
      lines.push(`    fail=${compactCell(item.fail_condition, 220)}`);
      if (item.after) lines.push(`    after=${compactCell(item.after, 220)}`);
      if (item.reason) lines.push(`    reason=${compactCell(item.reason, 220)}`);
    }
  }
  for (const check of report.checks ?? []) {
    lines.push(`- ${check.id}: ${check.status}; ${check.label}`);
    for (const evidenceLine of formatCheckEvidence(check)) lines.push(`  ${evidenceLine}`);
    if (check.next_action) lines.push(`  next: ${check.next_action}`);
  }
  if (report.completion_audit) {
    lines.push('', 'completion audit:');
    lines.push(`  objective: ${report.completion_audit.objective}`);
    if (report.completion_audit.requirements?.length) {
      lines.push('  requirements:');
      for (const row of report.completion_audit.requirements) {
        lines.push(`    - ${row.id}: ${row.status}; source=${row.source}; requirement=${compactCell(row.requirement, 120)}`);
        const evidence = compactCell(row.evidence, 180);
        if (evidence) lines.push(`      evidence=${evidence}`);
        const gate = compactCell(row.gate, 160);
        if (gate) lines.push(`      gate=${gate}`);
      }
    }
    if (report.completion_audit.adr0012_conditions?.length) {
      lines.push('  adr0012 conditions:');
      for (const row of report.completion_audit.adr0012_conditions) {
        lines.push(`    - ${row.id}: ${row.status}; source=${row.source}`);
      }
    }
    if (report.completion_audit.adr0012_transition_advice?.length) {
      lines.push('  adr0012 transition advice:');
      for (const item of report.completion_audit.adr0012_transition_advice) {
        lines.push(`    - condition ${item.condition}: ${item.status}; required=${compactCell(item.required, 180)}`);
        if (item.evidence?.length) lines.push(`      evidence=${compactCell(item.evidence.join('; '), 220)}`);
        if (item.blockers?.length) lines.push(`      blockers=${compactCell(item.blockers.join('; '), 220)}`);
        if (item.next) lines.push(`      next=${compactCell(item.next, 220)}`);
      }
    }
    if (report.completion_audit.artifact_checklist?.length) {
      lines.push('  artifact checklist:');
      for (const item of report.completion_audit.artifact_checklist) {
        lines.push(`    - ${item.id}: ${item.status}; kind=${item.kind}; source=${item.source}`);
        lines.push(`      covers=${compactCell(item.covers, 180)}`);
        if (item.evidence) lines.push(`      evidence=${compactCell(item.evidence, 180)}`);
      }
    }
    if (report.completion_audit.gate_checklist?.length) {
      lines.push('  gate checklist:');
      for (const gate of report.completion_audit.gate_checklist) {
        lines.push(`    - ${gate.phase}:${gate.id}: ${gate.status}; required=${compactCell(gate.required, 180)}`);
        lines.push(`      current=${compactCell(gate.current, 180)}`);
        if (gate.blocker) lines.push(`      blocker=${compactCell(gate.blocker, 180)}`);
      }
    }
    if (report.completion_audit.missing_or_weak?.length) {
      lines.push('  missing or weak:');
      for (const item of report.completion_audit.missing_or_weak) {
        lines.push(`    - ${item.id}: ${item.status}; source=${item.source}; blocker=${compactCell(item.blocker, 180)}`);
      }
    } else {
      lines.push('  missing or weak: none');
    }
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

function formatGateDetail(detail) {
  const parts = [
    `${detail.phase ?? 'candidate'}:${detail.id ?? '<unknown>'}: ${detail.status ?? '<unknown>'}`,
  ];
  const required = compactCell(detail.required, 180);
  const current = compactCell(detail.current, 180);
  const blocker = compactCell(detail.blocker, 220);
  if (required) parts.push(`required=${required}`);
  if (current) parts.push(`current=${current}`);
  if (blocker) parts.push(`blocker=${blocker}`);
  return `- ${parts.join('; ')}`;
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
      const lines = unresolved.length
        ? [`${summary}; unresolved=${unresolved.map((row) => `${row.requirement}:${row.status}`).join(', ')}`]
        : [summary];
      for (const row of unresolved) lines.push(formatScorecardDetail(row));
      return lines;
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
        for (const action of evidence.next_actions) lines.push(formatNextActionDetail(action));
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
    case 'latest_completion_footer_state': {
      const lines = [`footer: state=${check.evidence?.footer_state ?? '<none>'}; source=${check.evidence?.source_run_id ?? '<explicit-or-none>'}`];
      const reason = compactCell(check.evidence?.reason, 240);
      if (reason) lines.push(`footer reason: ${reason}`);
      return lines;
    }
    case 'omcc_dev_daily_workflow':
      return [`omcc-dev-active: ${check.evidence?.omcc_dev_active ?? 'unknown'}; source=${check.evidence?.source_run_id ?? '<explicit-or-none>'}`];
    default:
      return [];
  }
}

function formatNextActionDetail(action) {
  const parts = [action.id ?? '<unknown>'];
  if (action.host) parts.push(`host=${action.host}`);
  if (action.commands?.length) parts.push(`commands=${action.commands.join(', ')}`);
  if (action.source) parts.push(`source=${action.source}`);
  const hasActionableTarget = Boolean(action.host || action.commands?.length);
  if (action.reason && (!hasActionableTarget || action.reason.length <= 120)) parts.push(`reason=${action.reason}`);
  return `follow-up detail: ${parts.join('; ')}`;
}

function formatScorecardDetail(row) {
  const parts = [`${row.requirement ?? '<unknown>'}:${row.status ?? '<unknown>'}`];
  const requirement = compactCell(row.summary, 220);
  const gate = compactCell(row.gate, 180);
  if (requirement) parts.push(`requirement=${requirement}`);
  if (gate) parts.push(`gate=${gate}`);
  return `unresolved scorecard detail: ${parts.join('; ')}`;
}

function compactCell(value, maxLength) {
  const text = String(value ?? '').replace(/`/g, '').replace(/\s+/g, ' ').trim();
  if (!text) return null;
  if (text.length <= maxLength) return text;
  const slice = text.slice(0, Math.max(0, maxLength - 3));
  const boundary = slice.lastIndexOf(' ');
  const trimmed = boundary > 80 ? slice.slice(0, boundary) : slice;
  return `${trimmed.trimEnd()}...`;
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
      case '--completion-audit':
        options.completionAudit = true;
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
  runtime:cutover-audit [--format text|json] [--max-artifact-age-hours N] [--completion-audit]
    [--permission-proof] [--execute-permission-proof] [--permission-proof-timeout-ms N]
    [--deep-peer-smoke] [--execute-deep-peer-smoke] [--deep-peer-smoke-timeout-ms N]
    [--workflow-continuation-proof] [--execute-workflow-continuation-proof] [--workflow-continuation-proof-timeout-ms N]
  runtime:cutover-audit --footer-state <state> --omcc-dev-active yes|no|unknown
  runtime:cutover-audit record --footer-state <state> --omcc-dev-active yes|no|unknown [--dogfood-date YYYY-MM-DD]

Builds an omcc cutover readiness report. Audit mode is read-only. Record mode
writes only an explicit cutover evidence artifact under .agentic-plugins/runs.
Proof flags are passed through to runtime:doctor and execute peer/workflow
proofs only when the corresponding --execute-* flag is provided.
Use --completion-audit to include the prompt-to-artifact checklist that maps
requirements, ADR conditions, commands, artifacts, gates, and weak/missing
evidence before a cutover decision.
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
