#!/usr/bin/env node
// plugins/runtime/scripts/doctor.mjs
//
// ADR-0024 first implementation: read-only runtime/operator diagnosis.
// This script deliberately observes and reports. It does not install plugins,
// authenticate hosts, mutate config, sweep ledgers, or execute peer agents
// unless a named, explicit executor flag is supplied.

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, link, mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_VERSION } from './version.mjs';
import { sanitizeValue } from './lib/permission-sanitize.mjs';
import { learnFromSources } from './lib/permission-usage-learner.mjs';
import { getPromptCause } from './lib/permission-advisor-core.mjs';
import { runEmit } from './notify.mjs';
import { buildEventId, deriveRepoIdent } from './lib/notify-schema.mjs';
import { EGRESS_ENV_KEYS, loadEgressActivation } from './lib/egress-config.mjs';
import { sameDirectory } from './lib/path-containment.mjs';
import { egressIntentDir, safeRecordName } from './lib/egress-intent-wal.mjs';
import { EGRESS_ATTEMPT_HASH_DOMAIN, deriveActivationFingerprint } from './lib/evidence-contract.mjs';
import { EGRESS_CREDENTIAL_ENV_VAR } from './lib/machine-profile.mjs';
import { makePermissionAdvisoryArtifact, makePermissionRunId } from './lib/permission-artifacts.mjs';
import {
  PERMISSION_DIAGNOSIS_MAX_SCAN,
  collectUsageRecordSources,
} from './lib/permission-usage-sources.mjs';
import {
  artifactTimestampMs,
  inspectCompatRuns,
  inspectConsensusRuns,
  inspectRuntimeArtifactInventory,
  inspectWorkflowNamespace,
  machinePointer,
  pointer,
  readJsonIfExists,
  readTextIfExists,
  runIdTimestampMs,
  safeCount,
} from './lib/state-readers.mjs';
import { resolvePeerExecutionContext } from './lib/peer-execution-context.mjs';
import {
  planRetention,
  projectRetentionAttention,
  reconcileRetentionAttention,
} from './lib/retention-planner.mjs';
import { assessEntryBriefReadiness, assessSessionCaptureReadiness, claudePluginListEnablement } from './lib/session-readiness.mjs';
// The single version authority shared with the settings producer (S8a4 §SCOPE-2): the
// currency mirror MUST parse the Codex CLI version and resolve plugin versions through the
// same leaf, or a freshly recorded attestation reads stale on the machine that wrote it.
import { parseCodexCliVersion, resolveCodexInstalledVersionFromMatrix } from './lib/codex-attestation-versions.mjs';
import {
  PLUGIN_NAMES,
  probeMachineHostState,
  resolveCodexHome,
  resolveCodexInstallState,
  summarizeManifestHookField,
  manifestHooksFileSummary,
  hooksFileSummary,
  normalizeCodexHookStatePath,
  normalizeCodexHookStateEvent,
  parseCodexHookStateConfigToml,
} from './lib/machine-probe.mjs';
import { semverCompare } from './lib/semver.mjs';
import { redactEgressCredentialFromEnv } from './lib/egress-config.mjs';

export { RUNTIME_VERSION };

export { CONTRACT_COMPATIBLE_MAJOR } from './lib/peer-execution-context.mjs';
// PLUGIN_NAMES and the pure Codex hook-config parser now live in the machine probe
// (their single source of truth); re-exported here to preserve doctor's public surface
// (settings.mjs / tests import PLUGIN_NAMES from doctor).
export { PLUGIN_NAMES, parseCodexHookStateConfigToml };
// The usage-record enumerator moved to lib/permission-usage-sources.mjs
// (machine-bootstrap-contract.md §1.3) so a planner can reach the scan without
// importing this host-CLI diagnostic module. Re-exported to preserve doctor's public
// surface for existing importers.
export { collectUsageRecordSources };
export { TERMINAL_PEER_RUN_STATUSES, VALID_PEER_RUN_STATUSES } from './lib/state-readers.mjs';

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_STALE_GRACE_MS = 60000;
const DEFAULT_DEEP_PEER_SMOKE_TIMEOUT_MS = 120000;
const DEFAULT_PERMISSION_PROOF_TIMEOUT_MS = 120000;
const DEFAULT_WORKFLOW_CONTINUATION_PROOF_TIMEOUT_MS = 120000;
const DEFAULT_ARTIFACT_RETENTION_CAP = 20;
const DEFAULT_ARTIFACT_RETENTION_MAX_BYTES = 50 * 1024 * 1024;
// ADR-0038 §1/§7 permission diagnosis (R0): per-host file cap so an opt-in
// diagnosis bounds how many recent usage records it reads, plus a hard
// directory-scan budget so a pathological tree can't stall doctor.
const DEFAULT_PERMISSION_DIAGNOSIS_MAX_FILES = 100;
const DEFAULT_PERMISSION_DIAGNOSIS_MAX_FILE_BYTES = 8 * 1024 * 1024;
const PERMISSION_DIAGNOSIS_TOP_PATTERNS = 15;
const SETTINGS_RUN_ID_RE = /^settings-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
// Nonterminal write-ahead settings-execution statuses (machine-bootstrap-contract.md
// §1.5). Defined locally, not imported from settings.mjs, because settings.mjs
// imports FROM doctor.mjs — the dependency runs one way only.
const SETTINGS_EXECUTION_NONTERMINAL_STATUSES = new Set(['planned', 'in-progress']);
const DOCTOR_RUN_ID_RE = /^doctor-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const DOCTOR_ARTIFACT_SCHEMA_VERSION = 'runtime-doctor-artifact-1.0';
const DOCTOR_LATEST_SCHEMA_VERSION = 'runtime-doctor-latest-1.0';

export async function runDoctor({
  repoRoot = process.cwd(),
  homeDir = homedir(),
  env = process.env,
  now = new Date(),
  runner = runCommand,
  format = 'text',
  host = 'auto',
  explicitModel = null,
  explicitEffort = null,
  deepPeerSmoke = false,
  executeDeepPeerSmoke = false,
  deepPeerSmokeTimeoutMs = DEFAULT_DEEP_PEER_SMOKE_TIMEOUT_MS,
  sandboxPermissionProbe = false,
  permissionProof = false,
  executePermissionProof = false,
  permissionProofTimeoutMs = DEFAULT_PERMISSION_PROOF_TIMEOUT_MS,
  egressAckProof = false,
  executeEgressAckProof = false,
  // Test seam ONLY: production always uses the real in-process runEmit (no
  // fetch double — real transport is the point, acceptance-(K) precedent).
  egressEmitImpl = null,
  // Test-only seam for the legacy-WAL identity re-check (see
  // buildEgressAckProofSection). Defaults to the real predicate.
  egressSameDirectoryImpl = sameDirectory,
  workflowContinuationProof = false,
  executeWorkflowContinuationProof = false,
  workflowContinuationProofTimeoutMs = DEFAULT_WORKFLOW_CONTINUATION_PROOF_TIMEOUT_MS,
  artifactInventory = false,
  artifactRetentionCap = DEFAULT_ARTIFACT_RETENTION_CAP,
  artifactMaxBytes = DEFAULT_ARTIFACT_RETENTION_MAX_BYTES,
  permissionDiagnosis = false,
  permissionDiagnosisMaxFiles = DEFAULT_PERMISSION_DIAGNOSIS_MAX_FILES,
  permissionDiagnosisMaxFileBytes = DEFAULT_PERMISSION_DIAGNOSIS_MAX_FILE_BYTES,
  recordArtifact = false,
  runId = null,
} = {}) {
  if (executeDeepPeerSmoke && !deepPeerSmoke) {
    throw new Error('--execute-deep-peer-smoke requires --deep-peer-smoke');
  }
  if (executeEgressAckProof && !egressAckProof) {
    throw new Error('--execute-egress-ack-proof requires --egress-ack-proof');
  }
  if (executePermissionProof && !permissionProof) {
    throw new Error('--execute-permission-proof requires --permission-proof');
  }
  if (executeWorkflowContinuationProof && !workflowContinuationProof) {
    throw new Error('--execute-workflow-continuation-proof requires --workflow-continuation-proof');
  }
  const resolvedRepoRoot = resolve(repoRoot);
  const resolvedHomeDir = resolve(homeDir);
  const startedAt = now.toISOString();

  // ADR-0041 §2b/§2c: the egress credential must not ride into CONTROL-PLANE probes.
  // Every caller used to be responsible for this and only `settings.mjs` did it, so a
  // direct `runtime:doctor` run and `cutover-audit.mjs` handed the token to all 14
  // `claude`/`codex` probe processes. Scrub it here, at the point of use.
  // The raw `env` is deliberately retained for the explicitly-executed proofs below:
  // they spawn companions/workflows whose own attention hooks need the credential to
  // egress notifications (ADR-0041 §3).
  const probeEnv = redactEgressCredentialFromEnv(env);
  const resolvedCodexHome = resolveCodexHome(env, resolvedHomeDir);

  // The MACHINE half — host CLI presence/auth/feature-surface, installed rows, plugin
  // cache, observed Codex hook config — comes from the ONE machine probe so a machine
  // answer never depends on the repo (machine-bootstrap-contract.md §1.1). The probe runs
  // host CLIs in a NEUTRAL cwd (never resolvedRepoRoot), honors $CODEX_HOME, keeps raw
  // stdout internal, and bounds each probe by the doctor timeout.
  const machine = await probeMachineHostState({
    homeDir: resolvedHomeDir,
    codexHome: resolvedCodexHome,
    env: probeEnv,
    cwd: tmpdir(),
    runner,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });
  const { claude, codex, caches, claudePluginList, codexPluginList, marketplaceRegistration } = machine;

  // The REPO half stays here: source manifests + catalogs enrich the machine facts into
  // the plugin matrix.
  const source = await inspectSourcePluginState(resolvedRepoRoot);
  const catalogs = await inspectCatalogs(resolvedRepoRoot);
  const plugins = buildPluginMatrix({ source, catalogs, caches, claudePluginList, codexPluginList });
  const codexPluginHooks = await buildCodexPluginHookReport({
    codex,
    plugins,
    observedCodexHookConfig: machine.codexHookConfig,
  });
  const hostParity = buildHostParity({ claude, codex, plugins, claudePluginList, codexPluginList, codexPluginHooks });
  const hostParityBaseline = await buildHostParityBaseline({ repoRoot, claude, codex });
  const settingsRuns = await inspectSettingsRuns({
    repoRoot: resolvedRepoRoot,
    // The currency mirror needs the SAME inputs the producer bound against: the strictly
    // parsed Codex CLI version and the plugin matrix (§SCOPE-2/§SCOPE-3, S8a4).
    codexPluginHooks,
    plugins,
    codexCliVersion: parseCodexCliVersion(codex.version?.text ?? null),
  });
  const pluginCommandSurface = buildPluginCommandSurface({ claude, codex, plugins, hostParity, codexPluginHooks, settingsRuns });
  // The same two filesystem-only inspectors as before, now behind the seam that
  // consensus.mjs shares. They hold no mutable state and write nothing, so resolving
  // them together is safe; `report.companions` / `report.model_effort` are unchanged.
  const { companions: companion, model_effort: modelEffort } = await resolvePeerExecutionContext({
    repoRoot: resolvedRepoRoot,
    homeDir: resolvedHomeDir,
    codexHome: resolvedCodexHome,
    explicitModel,
    explicitEffort,
  });
  const ledgers = await inspectWorkflowLedgers({
    repoRoot: resolvedRepoRoot,
    now,
    staleGraceMs: parseNonNegativeInt(env.PEER_RUN_STALE_GRACE_MS, DEFAULT_STALE_GRACE_MS),
  });
  const consensusRuns = await inspectConsensusRuns({
    repoRoot: resolvedRepoRoot,
  });
  const compatRuns = await inspectCompatRuns({
    repoRoot: resolvedRepoRoot,
  });
  // ADR-0044 S4 — session-capture readiness via the shared assessment
  // (session-capture-contract.md §13): filesystem+env reads only, plus the
  // Claude plugin-list row the machine probe already collected, mapped
  // through the shared status→enablement adapter (the row carries a status
  // string, not an enabled boolean). The publisher floor is read
  // dynamically from the installed attention build's declaration — never a
  // hardcoded constant.
  const sessionCaptureReadiness = await assessSessionCaptureReadiness({
    repoRoot: resolvedRepoRoot,
    homeDir: resolvedHomeDir,
    env,
    runtimeVersion: RUNTIME_VERSION,
    attentionEnablement: claudePluginListEnablement(claudePluginList?.attention ?? null),
  });
  // ADR-0045 S8 — the entry-side mirror (session-capture-contract.md §18):
  // same shared assessment module, same injected enablement evidence, plus
  // the executor-existence probe against the cached runtime build (floors
  // prove version, not capability presence — ADR-0045 §10).
  const entryBriefReadiness = await assessEntryBriefReadiness({
    repoRoot: resolvedRepoRoot,
    homeDir: resolvedHomeDir,
    env,
    runtimeVersion: RUNTIME_VERSION,
    attentionEnablement: claudePluginListEnablement(claudePluginList?.attention ?? null),
  });
  const inspectedDoctorRuns = await inspectDoctorRuns({
    repoRoot: resolvedRepoRoot,
  });
  const { internal_runs: recordedDoctorRuns, ...doctorRuns } = inspectedDoctorRuns;
  const artifactInventorySection = artifactInventory
    ? await inspectRuntimeArtifactInventory({
        repoRoot: resolvedRepoRoot,
        now,
        retentionCap: artifactRetentionCap,
        maxBytes: artifactMaxBytes,
        // ADR-0046 §4 — the machine-global bootstrap home MUST be inventoried too.
        // Passing doctor's already-injected homeDir keeps this read hermetic in
        // tests; the inventory itself never reaches for os.homedir().
        homeDir: resolvedHomeDir,
      })
    : {
        requested: false,
        executed: false,
        status: 'not_requested',
      };
  // ADR-0047 §7 — the read-only retention projection. Computed alongside the
  // inventory (same flag, same read-only artifact concern) and reconciled with
  // the raw inventory attention so a registry family over cap ONLY because its
  // runs are pinned reads as informational, not a fault. Deletes nothing.
  const retentionSection = artifactInventory && artifactInventorySection.executed
    ? await buildRetentionSection({ repoRoot: resolvedRepoRoot, now, artifactRetentionCap, artifactMaxBytes, inventory: artifactInventorySection })
    : { requested: Boolean(artifactInventory), executed: false, status: 'not_requested' };
  const permissionDiagnosisSection = permissionDiagnosis
    ? await inspectPermissionDiagnosis({
        homeDir: resolvedHomeDir,
        env,
        now,
        maxFiles: permissionDiagnosisMaxFiles,
        maxFileBytes: permissionDiagnosisMaxFileBytes,
      })
    : {
        requested: false,
        executed: false,
        status: 'not_requested',
      };
  const recordedDoctorProof = buildRecordedDoctorProof({
    runs: recordedDoctorRuns,
    latest: doctorRuns.latest,
    plugins,
    claude,
    codex,
  });

  const readiness = buildReadiness({
    claude,
    codex,
    companion,
    deepPeerSmoke,
    executeDeepPeerSmoke,
    sandboxPermissionProbe,
    permissionProof,
    executePermissionProof,
    workflowContinuationProof,
    executeWorkflowContinuationProof,
  });
  const sandboxPermissionProbeSection = buildSandboxPermissionProbeSection({
    requested: sandboxPermissionProbe,
    readiness,
  });
  const permissionProofSection = await buildPermissionProofSection({
    requested: permissionProof,
    execute: executePermissionProof,
    readiness,
    claude,
    codex,
    companion,
    modelEffort,
    repoRoot: resolvedRepoRoot,
    env,
    runner,
    timeoutMs: permissionProofTimeoutMs,
  });
  const egressAckProofSection = await buildEgressAckProofSection({
    requested: egressAckProof,
    execute: executeEgressAckProof,
    repoRoot: resolvedRepoRoot,
    homeDir: resolvedHomeDir,
    env,
    now,
    emitImpl: egressEmitImpl,
    sameDirectoryImpl: egressSameDirectoryImpl,
  });
  const deepPeerSmokeSection = await buildDeepPeerSmokeSection({
    requested: deepPeerSmoke,
    execute: executeDeepPeerSmoke,
    readiness,
    companion,
    modelEffort,
    repoRoot: resolvedRepoRoot,
    env,
    runner,
    timeoutMs: deepPeerSmokeTimeoutMs,
  });
  const workflowContinuationProofSection = await buildWorkflowContinuationProofSection({
    requested: workflowContinuationProof,
    execute: executeWorkflowContinuationProof,
    readiness,
    modelEffort,
    repoRoot: resolvedRepoRoot,
    homeDir: resolvedHomeDir,
    env,
    runner,
    timeoutMs: workflowContinuationProofTimeoutMs,
  });
  const readinessMatrix = buildReadinessMatrix({
    claude,
    codex,
    plugins,
    codexPluginHooks,
    companion,
    modelEffort,
    readiness,
    permissionProof: permissionProofSection,
    deepPeerSmoke: deepPeerSmokeSection,
    workflowContinuationProof: workflowContinuationProofSection,
  });
  const experienceParity = buildExperienceParity({
    readinessMatrix,
    pluginCommandSurface,
    codexPluginHooks,
    companion,
    readiness,
    ledgers,
    settingsRuns,
    consensusRuns,
    compatRuns,
    permissionProof: permissionProofSection,
    deepPeerSmoke: deepPeerSmokeSection,
    workflowContinuationProof: workflowContinuationProofSection,
    recordedDoctorProof,
  });

  const report = {
    schema_version: 'runtime-doctor-1.0',
    runtime_version: RUNTIME_VERSION,
    generated_at: startedAt,
    repo_root: resolvedRepoRoot,
    host,
    read_only: true,
    // Precise effect claims (Plan-verify peer): `read_only` keeps its
    // host-state meaning (no host trust/auth/config/permission mutation —
    // still true), while the egress ack executor MAY perform ONE pinned
    // network request through the E1 emitter. The fact is taken from the
    // section — a blocked execute, or an attempt suppressed before dispatch
    // (kinds-filter, quiet-hours, body-cap), sent nothing, and claiming
    // otherwise here would overstate the run's blast radius.
    effects: {
      host_config_mutated: false,
      network_request_performed: egressAckProofSection.network_request_performed === true,
    },
    sandbox_permission_probe: sandboxPermissionProbeSection,
    permission_proof: permissionProofSection,
    egress_ack_proof: egressAckProofSection,
    deep_peer_smoke: deepPeerSmokeSection,
    workflow_continuation_proof: workflowContinuationProofSection,
    clis: {
      claude: redactCommandDetails(claude),
      codex: redactCommandDetails(codex),
    },
    // §1.2 host-native marketplace-registration + §1.4.1 registered-catalog currentness,
    // from the machine probe (lib/machine-probe.mjs). Read-only machine fact; settings' C3
    // repair sources its currentness target from here rather than a repo checkout.
    marketplace_registration: marketplaceRegistration,
    plugins,
    plugin_command_surface: pluginCommandSurface,
    codex_plugin_hooks: codexPluginHooks,
    host_parity: hostParity,
    host_parity_baseline: hostParityBaseline,
    companions: companion,
    model_effort: modelEffort,
    settings_runs: settingsRuns,
    consensus_runs: consensusRuns,
    compat_runs: compatRuns,
    session_capture: sessionCaptureReadiness,
    entry_brief: entryBriefReadiness,
    doctor_runs: doctorRuns,
    recorded_doctor_proof: recordedDoctorProof,
    artifact_inventory: artifactInventorySection,
    retention: retentionSection,
    permission_diagnosis: permissionDiagnosisSection,
    readiness_matrix: readinessMatrix,
    experience_parity: experienceParity,
    readiness,
    ledgers,
    limits: [
      'Codex bundled plugin hooks require manifest exposure plus an enabled hook gate: [features].plugin_hooks on Codex < ~0.134, or generic [features].hooks once plugin_hooks is removed; doctor reports the stage-appropriate gate separately from packaging.',
      'Codex hook review/trust is an active-session /hooks UI check; /hooks Installed counts are packaging evidence only, and Active=0 output is not enough to attest.',
      'The observed Codex CLI does not expose a non-interactive hook trust query, so doctor requires a current runtime:settings operator attestation to clear that follow-up.',
      'Readiness sandbox/permission status remains unknown unless --sandbox-permission-probe is requested; --permission-proof records separate preflight/execution evidence.',
      'Settings mutation belongs to runtime:settings; dynamic consensus, context hygiene, and completion footer mutation are deferred.',
      'Artifact inventory is read-only; runtime:doctor never deletes or compacts generated artifacts.',
      'Permission diagnosis is read-only (R0): it classifies prompt causes from usage records and recommends/writes nothing; runtime:settings emits the host-config plan (M1).',
    ],
  };
  report.overall = summarizeOverall(report);
  report.output_format = format;
  report.doctor_artifact = recordArtifact
    ? await writeDoctorArtifact({
        repoRoot: resolvedRepoRoot,
        now,
        runId,
        report,
      })
    : {
        written: false,
        requested: false,
        status: 'not_requested',
      };
  return report;
}

export async function runCommand(command, args = [], { cwd = process.cwd(), env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      resolvePromise({
        ok: false,
        exit_code: null,
        stdout,
        stderr,
        error_code: 'ETIMEDOUT',
        timed_out: true,
      });
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        ok: false,
        exit_code: null,
        stdout,
        stderr,
        error_code: err.code ?? 'spawn_error',
        error_message: err.message,
        timed_out: false,
      });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        ok: code === 0,
        exit_code: code,
        stdout,
        stderr,
        error_code: null,
        timed_out: false,
      });
    });
  });
}

async function inspectSourcePluginState(repoRoot) {
  const result = {};
  for (const name of PLUGIN_NAMES) {
    const pluginRoot = join(repoRoot, 'plugins', name);
    const claudeManifest = await readJsonIfExists(join(pluginRoot, '.claude-plugin', 'plugin.json'));
    const codexManifest = await readJsonIfExists(join(pluginRoot, '.codex-plugin', 'plugin.json'));
    result[name] = {
      path: pluginRoot,
      present: Boolean(claudeManifest.ok || codexManifest.ok),
      claude_manifest: manifestSummary(claudeManifest),
      codex_manifest: manifestSummary(codexManifest),
      codex_manifest_hooks_file: await manifestHooksFileSummary({
        pluginRoot,
        manifestHooks: summarizeManifestHookField(codexManifest.ok ? codexManifest.json.hooks : undefined),
      }),
      codex_default_hooks_file: await hooksFileSummary(join(pluginRoot, 'hooks', 'hooks.json')),
    };
  }
  return result;
}

async function inspectCatalogs(repoRoot) {
  const claude = await readJsonIfExists(join(repoRoot, '.claude-plugin', 'marketplace.json'));
  const codex = await readJsonIfExists(join(repoRoot, '.agents', 'plugins', 'marketplace.json'));
  return {
    claude: catalogSummary(claude, 'claude'),
    codex: catalogSummary(codex, 'codex'),
  };
}

function catalogSummary(readResult, host) {
  if (!readResult.ok) return { status: 'missing', entries: {}, error: readResult.reason };
  const entries = {};
  const plugins = Array.isArray(readResult.json.plugins) ? readResult.json.plugins : [];
  for (const entry of plugins) {
    if (typeof entry?.name !== 'string') continue;
    entries[entry.name] = host === 'claude'
      ? {
          source: entry.source ?? null,
          version: entry.version ?? null,
          category: entry.category ?? null,
        }
      : {
          source: entry.source?.path ?? null,
          installation: entry.policy?.installation ?? null,
          authentication: entry.policy?.authentication ?? null,
          category: entry.category ?? null,
        };
  }
  return { status: 'available', entries };
}

function buildPluginMatrix({ source, catalogs, caches, claudePluginList, codexPluginList = { status: 'unavailable', entries: {} } }) {
  const result = {};
  for (const name of PLUGIN_NAMES) {
    // Resolve the Codex install decision once, here, so every downstream
    // consumer (status, readiness row, version parity) reads the same
    // list-authoritative-then-cache decision rather than re-deriving it.
    const codexResolved = resolveCodexInstallState({
      name,
      listStatus: codexPluginList.status,
      entry: codexPluginList.entries?.[name] ?? null,
    });
    result[name] = {
      source: source[name],
      marketplace: {
        claude: catalogs.claude.entries?.[name] ?? null,
        codex: catalogs.codex.entries?.[name] ?? null,
      },
      installed: {
        claude_plugin_list: claudePluginList[name] ?? null,
        codex_plugin_list: codexPluginList.entries?.[name] ?? null,
        codex_resolved: codexResolved,
      },
      cache: {
        claude: caches.claude[name],
        codex: caches.codex[name],
        codex_tmp_marketplace: caches.codex_tmp_marketplace[name],
      },
      status: summarizePluginStatus({
        source: source[name],
        claudeEntry: catalogs.claude.entries?.[name],
        codexEntry: catalogs.codex.entries?.[name],
        claudeCache: caches.claude[name],
        codexCache: caches.codex[name],
        claudeInstalled: claudePluginList[name],
        codexResolved,
      }),
    };
  }
  return result;
}

function summarizePluginStatus({ source, claudeEntry, codexEntry, claudeCache, codexCache, claudeInstalled, codexResolved }) {
  if (claudeInstalled?.status === 'failed') return 'blocked';
  // Codex list is authoritative when it succeeded: a present install (enabled or
  // disabled) counts as available; a list-confirmed absence must NOT let a stale
  // codex cache claim availability. Only on list-unavailable (decision=fallback)
  // does the codex cache count toward availability (ADR-0034).
  const codexListInstalled = codexResolved?.decision === 'installed' || codexResolved?.decision === 'disabled';
  const codexCacheCounts = codexResolved?.decision === 'fallback' && codexCache?.status === 'available';
  if (claudeCache?.status === 'available' || codexListInstalled || codexCacheCounts) {
    return 'available';
  }
  if (claudeInstalled?.status === 'enabled') return 'available';
  if (!source?.present) return 'not_installed';
  if (!claudeEntry || !codexEntry) return 'source_available';
  return 'source_available';
}

async function buildCodexPluginHookReport({ codex, plugins, observedCodexHookConfig }) {
  const plugin_entries = {};
  const summary = {
    bundled_plugins: [],
    manifest_exposed_plugins: [],
    default_file_only_plugins: [],
    claude_adapter_only_plugins: [],
    missing_hooks_file_plugins: [],
    command_warning_plugins: [],
    claude_root_command_plugins: [],
    claude_adapter_command_plugins: [],
    bare_node_command_plugins: [],
  };

  for (const [name, plugin] of Object.entries(plugins)) {
    const source = buildCodexHookLocation({
      manifestHooks: plugin.source?.codex_manifest?.hooks,
      manifestHooksFile: plugin.source?.codex_manifest_hooks_file,
      defaultHooksFile: plugin.source?.codex_default_hooks_file,
      origin: 'source',
    });
    const cache = buildCodexHookLocation({
      manifestHooks: plugin.cache?.codex?.latest?.manifest_hooks,
      manifestHooksFile: plugin.cache?.codex?.latest?.manifest_hooks_file,
      defaultHooksFile: plugin.cache?.codex?.latest?.default_hooks_file,
      origin: 'codex_cache',
    });
    const marketplaceCache = buildCodexHookLocation({
      manifestHooks: plugin.cache?.codex_tmp_marketplace?.manifest_hooks,
      manifestHooksFile: plugin.cache?.codex_tmp_marketplace?.manifest_hooks_file,
      defaultHooksFile: plugin.cache?.codex_tmp_marketplace?.default_hooks_file,
      origin: 'codex_tmp_marketplace',
    });
    const effective = source.status !== 'not_packaged' ? source : cache.status !== 'not_packaged' ? cache : marketplaceCache;
    plugin_entries[name] = {
      source,
      codex_cache: cache,
      codex_tmp_marketplace: marketplaceCache,
      effective,
    };
    const claudeOnly = effective.status === 'claude_adapter_only';
    // claude_adapter_only remains a DIAGNOSIS (all-Claude-adapter command
    // shape) but is no longer an exclusion from the Codex bundled/review/
    // expected sets. The old exclusion assumed Codex ignores such hooks;
    // host truth disproved it: Codex's default-file discovery is
    // command-shape-blind. Observed on codex-cli 0.144.1 — it loaded
    // attention's then-root hooks/hooks.json, surfaced stop/subagent_stop
    // in /hooks, and the operator trusted them ([hooks.state] carries
    // trusted_hash entries). The exclusion made doctor misread those
    // trusted entries as unexpected_agentic_entries and hid a genuine
    // review/trust surface from attestation. ADR-0040 §3's "avoid the
    // Codex /hooks burden" intent is not achievable by mere non-declaration
    // on current Codex — the attention package resolved its posture
    // (2026-07-11, restructure: a manifest-declared adapters/claude path
    // with no root default; history + pending install proof tracked in
    // plugins/runtime/docs/follow-ups.md), and this inclusion logic stays
    // for any plugin that ships a default-location hooks file.
    // Command-portability warnings apply to such plugins like any other
    // bundler — Codex surfaces the hooks, so their command shape is host
    // truth, not noise.
    // A temporary marketplace snapshot is a browsable catalog, NOT an
    // installation (pinned by the existing not-installation contract test):
    // a plugin whose hooks are visible ONLY there must not become a bundled/
    // review/expected hook surface, and its command shape must not gate
    // parity (refine-verify finding — the effective fallthrough above exists
    // for file inspection, not for installation semantics).
    const tmpMarketplaceOnly = effective.origin === 'codex_tmp_marketplace';
    if (effective.bundled && !tmpMarketplaceOnly) summary.bundled_plugins.push(name);
    if (effective.manifest_declared) summary.manifest_exposed_plugins.push(name);
    if (effective.status === 'default_file_only') summary.default_file_only_plugins.push(name);
    if (claudeOnly) summary.claude_adapter_only_plugins.push(name);
    if (effective.status === 'manifest_declared_missing_file') summary.missing_hooks_file_plugins.push(name);
    if (!tmpMarketplaceOnly && (effective.hooks_file?.command_analysis?.warnings ?? []).length > 0) summary.command_warning_plugins.push(name);
    if ((effective.hooks_file?.command_analysis?.claude_plugin_root_references ?? 0) > 0) summary.claude_root_command_plugins.push(name);
    if ((effective.hooks_file?.command_analysis?.claude_adapter_references ?? 0) > 0) summary.claude_adapter_command_plugins.push(name);
    if ((effective.hooks_file?.command_analysis?.bare_node_command_references ?? 0) > 0) summary.bare_node_command_plugins.push(name);
  }

  for (const value of Object.values(summary)) value.sort();
  const reviewTargets = buildCodexHookReviewTargets({ summary, plugin_entries, plugins });
  const hookState = buildCodexHookStateReport({ observedConfig: observedCodexHookConfig, reviewTargets });
  const recommendations = [];
  if (summary.default_file_only_plugins.length > 0) {
    recommendations.push({
      host: 'codex',
      area: 'hooks',
      action: 'expose-bundled-hooks-in-manifest',
      executable: false,
      detail: `Add a host-appropriate "hooks" path to .codex-plugin/plugin.json for: ${summary.default_file_only_plugins.join(', ')}.`,
    });
  }
  if (summary.missing_hooks_file_plugins.length > 0) {
    recommendations.push({
      host: 'codex',
      area: 'hooks',
      action: 'restore-bundled-hooks-file',
      executable: false,
      detail: `Codex manifests declare hooks but the referenced hook file is missing for: ${summary.missing_hooks_file_plugins.join(', ')}.`,
    });
  }
  if (summary.command_warning_plugins.length > 0) {
    recommendations.push({
      host: 'codex',
      area: 'hooks',
      action: 'verify-codex-hook-command-portability',
      executable: false,
      detail: `Codex-exposed hooks have command portability warnings for: ${summary.command_warning_plugins.join(', ')}.`,
      next_step: 'Verify Codex /hooks active execution in-session, or route hook commands through a host-appropriate wrapper before accepting automatic lifecycle hook parity.',
    });
  }
  if (summary.bundled_plugins.length > 0) {
    if (codex.feature_surface.codex_plugin_hooks_stage === 'removed') {
      // Codex >= ~0.134 removed the plugin_hooks flag; plugin-bundled hooks
      // now load through generic [features].hooks (default on) + /hooks trust.
      if (codex.feature_surface.codex_global_hooks !== true) {
        recommendations.push({
          host: 'codex',
          area: 'hooks',
          action: 'enable-codex-hooks',
          executable: false,
          command: 'codex --enable hooks',
          config_snippet: '[features]\nhooks = true\n',
          detail: 'Codex plugin_hooks is removed; plugin-bundled hooks now load through generic [features].hooks, which is not enabled in the observed feature surface.',
          next_step: 'Enable generic Codex hooks for a test session or in Codex config, then review/trust the bundled hooks with /hooks and rerun runtime:doctor.',
        });
      }
    }
    // Legacy Codex < ~0.134 (plugin_hooks stage not 'removed'): the disabled
    // plugin_hooks gate is reported via host-parity diagnosis only. The former
    // enable-codex-plugin-hooks recommendation fed the runtime:settings
    // --apply-codex-plugin-hooks host-config write, which was removed per
    // ADR-0035 §6; enablement on legacy hosts is a manual config edit.
  }
  // Keyed on the PER-HANDLER count (S8a5), not the group-state count: a handler
  // explicitly disabled beside an enabled sibling leaves `expected_disabled` at 0
  // while the hook is genuinely not firing.
  if (hookState.summary.disabled_handlers > 0) {
    recommendations.push({
      host: 'codex',
      area: 'hooks',
      action: 'enable-codex-hook-state',
      executable: false,
      detail: `Codex user config has ${hookState.summary.disabled_handlers} explicitly disabled hook handler(s) across ${hookState.summary.expected} expected bundled hook entries (${hookState.summary.expected_disabled} fully disabled).`,
      next_step: 'Open /hooks, enable and trust the listed agentic-plugins hooks. If /hooks still shows old cache-version node commands, restart Codex so the latest plugin registry is loaded, then review again.',
    });
  }

  // Stage-aware gate: when Codex removed the plugin_hooks flag (>= ~0.134),
  // readiness keys on generic [features].hooks; otherwise on plugin_hooks.
  const pluginHooksRemoved = codex.feature_surface.codex_plugin_hooks_stage === 'removed';
  const hookGateEnabled = pluginHooksRemoved
    ? codex.feature_surface.codex_global_hooks
    : codex.feature_surface.codex_plugin_hooks;
  const status = summary.default_file_only_plugins.length > 0 || summary.missing_hooks_file_plugins.length > 0
    ? 'packaging_gap'
    : summary.bundled_plugins.length === 0
      ? 'no_bundled_hooks'
      : hookGateEnabled === true
        ? 'ready'
        : hookGateEnabled === false
          ? 'feature_disabled'
          : 'feature_unknown';

  return {
    schema_version: 'runtime-codex-plugin-hooks-1.0',
    status,
    feature_flags: {
      hooks: codex.feature_surface.codex_global_hooks,
      hooks_stage: codex.feature_surface.codex_global_hooks_stage,
      plugin_hooks: codex.feature_surface.codex_plugin_hooks,
      plugin_hooks_stage: codex.feature_surface.codex_plugin_hooks_stage,
      automatic_plugin_hooks: Boolean(codex.feature_surface.automatic_plugin_hooks),
    },
    summary,
    hook_state: hookState,
    plugin_entries,
    review_targets: reviewTargets,
    recommendations,
  };
}

// Version resolution for the hook review/attestation surfaces: source
// manifest (dev checkout) → list-authoritative installed version (ADR-0034)
// → Codex install-cache manifest. Cache-only consumer repos previously
// resolved to null here, so a cache upgrade could never flip a recorded
// /hooks attestation to plugin_version_changed (refine-verify finding).
function resolveHookPluginVersion(plugin) {
  return plugin?.source?.claude_manifest?.version
    ?? plugin?.source?.codex_manifest?.version
    ?? plugin?.installed?.codex_resolved?.version
    ?? plugin?.cache?.codex?.latest?.manifest_version
    ?? null;
}

function buildCodexHookReviewTargets({ summary, plugin_entries, plugins }) {
  const targets = [];
  for (const pluginName of summary?.bundled_plugins ?? []) {
    const effective = plugin_entries?.[pluginName]?.effective ?? {};
    const hooksFile = effective.hooks_file ?? {};
    const commandAnalysis = hooksFile.command_analysis ?? {};
    const plugin = plugins?.[pluginName];
    targets.push({
      plugin: pluginName,
      version: resolveHookPluginVersion(plugin),
      origin: effective.origin ?? null,
      manifest_exposed: effective.manifest_declared === true,
      hooks_path: sanitizeValue(hooksFile.path),
      events: Array.isArray(hooksFile.events) ? hooksFile.events.map((event) => sanitizeValue(event)).filter(Boolean).sort() : [],
      handler_count: Number.isFinite(hooksFile.handler_count) ? hooksFile.handler_count : 0,
      command_count: Number.isFinite(commandAnalysis.command_count) ? commandAnalysis.command_count : 0,
      commands: Array.isArray(commandAnalysis.commands) ? commandAnalysis.commands.map((command) => sanitizeValue(command)).filter(Boolean).sort() : [],
      command_warnings: Array.isArray(commandAnalysis.warnings) ? commandAnalysis.warnings.map((warning) => sanitizeValue(warning)).filter(Boolean).sort() : [],
      expected_review: 'Open /hooks, review this plugin hook set, trust it if the listed commands match expectations, then record runtime:settings --attest-codex-hook-review.',
    });
  }
  return targets.sort((a, b) => a.plugin.localeCompare(b.plugin));
}

// Codex hook-state event vocabulary observed on codex-cli 0.144.1 (see
// plugins/runtime/docs/codex-capability-baseline.md § Hooks): the events
// Codex actually materializes as `[hooks.state]` entries. A hooks-file event
// outside this set that has never been observed on this machine (e.g.
// Claude's `Notification`, which current Codex does not recognize) must not
// produce an expected entry — the host can never satisfy it, so it would
// read as a permanently-`missing` false alarm. Observed entries are always
// expected regardless of this set, so a future Codex that starts
// materializing a new event self-heals without a code change.
const CODEX_HOOK_STATE_EVENTS = new Set(['pre_compact', 'session_start', 'stop', 'subagent_stop']);

// The OBSERVED Codex hook config (read + parse) is produced by the machine probe; this
// function keeps the repo-derived correlation — expected review targets → observed
// entries — in doctor (machine-bootstrap-contract.md §1.1, peer #11). It receives the
// observed config rather than reading the file itself.
function buildCodexHookStateReport({ observedConfig, reviewTargets }) {
  const { config_path: configPath, config_status: configStatus, read_error: readError, entries } = observedConfig;
  const expected = [];
  const unmappedEvents = [];
  const disabledHandlers = [];
  for (const target of reviewTargets ?? []) {
    const hooksPath = normalizeCodexHookStatePath(target.hooks_path, target.plugin);
    for (const event of target.events ?? []) {
      const normalizedEvent = normalizeCodexHookStateEvent(event);
      if (!target.plugin || !hooksPath || !normalizedEvent) continue;
      const matches = entries.filter((entry) => (
        entry.plugin === target.plugin
        && entry.marketplace === 'agentic-plugins'
        && entry.hooks_path === hooksPath
        && entry.event === normalizedEvent
      ));
      // Vocabulary gate: an event Codex does not materialize (not in the
      // observed vocabulary AND absent from hooks.state) is surfaced as
      // unmapped, never counted as an expected-but-missing entry.
      if (matches.length === 0 && !CODEX_HOOK_STATE_EVENTS.has(normalizedEvent)) {
        unmappedEvents.push({
          plugin: target.plugin,
          hooks_path: hooksPath,
          event: sanitizeValue(event),
          normalized_event: normalizedEvent,
        });
        continue;
      }
      // Codex omits `enabled` from a `[hooks.state."…"]` entry it considers
      // enabled — the key is written only to record an explicit `false`. An
      // absent key therefore means ENABLED, not unknown and not disabled.
      //
      // Reading absence as `disabled` is fail-closed in the wrong direction:
      // it made every hook trusted by a current Codex (which writes only
      // `trusted_hash`) look disabled, and `runtime:settings
      // --attest-codex-hook-review` blocks while any expected entry is
      // disabled — so no newly-trusted hook-bearing plugin could ever be
      // attested. The `enabled = true` lines on the older plugin entries are
      // residue from an earlier Codex; `/hooks` exposes no enable toggle to
      // reproduce them. Verified empirically on codex-cli 0.142.5: designer's
      // Stop hook, whose entry carries `trusted_hash` and no `enabled` key,
      // executed and archived a terminal designer workflow during a
      // `codex exec` turn.
      const disabledMatches = matches.filter((entry) => entry.enabled === false);
      const enabledMatches = matches.filter((entry) => entry.enabled !== false);
      const trustedMatches = matches.filter((entry) => entry.trusted === true);
      const state = matches.length === 0
        ? 'missing'
        : enabledMatches.length > 0
          ? trustedMatches.length > 0 ? 'enabled_trusted' : 'enabled_untrusted'
          : 'disabled';
      expected.push({
        plugin: target.plugin,
        hooks_path: hooksPath,
        event: normalizedEvent,
        state,
        configured: matches.length,
        enabled: enabledMatches.length,
        disabled: disabledMatches.length,
        trusted: trustedMatches.length,
        ids: matches.map((entry) => entry.id).sort(),
      });
      // PER-HANDLER disabled evidence (S8a5). The group `state` above is derived
      // enabled-wins: ANY sibling with enabled!==false makes the group enabled_*, so
      // an entry explicitly disabled beside an enabled sibling never reaches
      // `disabled_expected` — the exact false-pass that let doctor call an
      // attestation current while a handler was off. Disabled evidence is therefore
      // ALSO derived at the individual-handler grain, without changing the group
      // taxonomy: an expected (plugin,path,event) with ANY handler enabled===false
      // surfaces that handler here, absent-key=enabled preserved (only an explicit
      // `false` lands in disabledMatches).
      for (const entry of disabledMatches) {
        disabledHandlers.push({
          plugin: target.plugin,
          hooks_path: hooksPath,
          event: normalizedEvent,
          group_index: entry.group_index ?? null,
          hook_index: entry.hook_index ?? null,
          id: entry.id,
          group_state: state,
        });
      }
    }
  }
  const expectedKey = new Set(expected.map((entry) => `${entry.plugin}:${entry.hooks_path}:${entry.event}`));
  const unexpectedAgenticEntries = entries.filter((entry) => (
    entry.marketplace === 'agentic-plugins'
    && !expectedKey.has(`${entry.plugin}:${entry.hooks_path}:${entry.event}`)
  ));
  const disabledExpected = expected.filter((entry) => entry.state === 'disabled');
  const enabledExpected = expected.filter((entry) => entry.state === 'enabled_trusted' || entry.state === 'enabled_untrusted');
  const untrustedExpected = expected.filter((entry) => entry.state === 'enabled_untrusted');
  const missingExpected = expected.filter((entry) => entry.state === 'missing');
  // Code-unit compare, NOT localeCompare: these are machine ids, and ICU collation is
  // locale-dependent — the same hook state must serialize in the same order on every
  // machine (the order flows into the persisted probe via the projection).
  disabledHandlers.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    // 1.2: adds the per-handler `disabled_handlers` rows + summary count (S8a5).
    schema_version: 'runtime-codex-hook-state-1.2',
    config_path: configPath,
    config_status: configStatus,
    read_error: readError,
    summary: {
      total_entries: entries.length,
      agentic_entries: entries.filter((entry) => entry.marketplace === 'agentic-plugins').length,
      expected: expected.length,
      expected_configured: expected.filter((entry) => entry.configured > 0).length,
      expected_enabled: enabledExpected.length,
      expected_disabled: disabledExpected.length,
      expected_untrusted: untrustedExpected.length,
      expected_missing: missingExpected.length,
      // Individual handlers explicitly `enabled = false` across ALL expected groups —
      // a strict superset of the handlers behind `expected_disabled` (a fully disabled
      // group's handlers all count here). This, not `expected_disabled`, is the
      // disabled-gate signal: the group count misses a disabled handler whose sibling
      // is enabled.
      disabled_handlers: disabledHandlers.length,
      unexpected_agentic_entries: unexpectedAgenticEntries.length,
      unmapped_events: unmappedEvents.length,
    },
    unmapped_events: unmappedEvents,
    expected,
    // TWO grains, ONE authority: `disabled_handlers` (every explicitly disabled
    // handler, sibling-masked included) is what every gate keys on —
    // evaluateCodexHookStateGate, the attest hint, the enable recommendation, and the
    // persisted-probe projection all read it. `disabled_expected` (groups whose EVERY
    // handler is disabled) is retained as display taxonomy for external report
    // consumers; keying a gate on it is the S8a5 false-pass — do not.
    disabled_expected: disabledExpected,
    disabled_handlers: disabledHandlers,
    untrusted_expected: untrustedExpected,
    unexpected_agentic_entries: unexpectedAgenticEntries,
  };
}

// Project the observed hook-state report onto the bootstrap-run probe shape
// (`probe.hosts.codex.hook_state`, runtime-bootstrap-run-1.1, S8a5): the OBSERVATION
// verdict plus the per-handler disabled coordinates, nothing else. The correlation
// itself stays in buildCodexHookStateReport (machine-bootstrap-contract.md §1.1);
// this is the S8b writer's seam, exported so the persisted evidence and the live
// report can never be assembled from two different derivations.
//
// `observation` IS the report's `config_status` — the three-way read verdict is
// classified once, at the read site (machine-probe.mjs readObservedCodexHookConfig),
// so the live report text and the persisted evidence cannot disagree about the same
// read (refine-verify: an earlier draft re-split the errno here and called an EACCES
// machine `unreadable` while the live report said `missing`). An unknown legacy
// status maps to `unreadable` — the conservative "state unknown" verdict.
//
// A NULL report returns NULL: there is no observation to persist, and fabricating an
// `unreadable` row would tell the operator a read failed when nothing was ever read.
// A writer receiving null omits the optional field, which the completion reducer
// reads as "no observation — re-probe" (its own distinct stale reason).
export function projectCodexHookStateForProbe(hookState) {
  if (!hookState) return null;
  const observation = ['available', 'missing', 'unreadable'].includes(hookState.config_status)
    ? hookState.config_status
    : 'unreadable';
  return {
    observation,
    disabled_expected: (hookState.disabled_handlers ?? []).map((row) => ({
      plugin: row.plugin,
      hooks_path: row.hooks_path,
      event: row.event,
      group_index: row.group_index,
      hook_index: row.hook_index,
    })),
  };
}

// The ONE attestation-blocking predicate over live hook-state evidence (S8a5
// refine-verify). It existed as three hand-edited copies — doctor's currency mirror,
// settings' attest gate, and the reducer's persisted twin — and the settings copy
// missed the observation dimension IN THE SAME DIFF that added it to the other two:
// a machine with no config.toml attested cleanly and the very next doctor called the
// fresh artifact stale. Producer and mirror now consult this single predicate; the
// completion reducer stays the persisted-evidence twin (it reads the probe shape and
// speaks in reasons[], but its verdicts must match this one — pinned by tests).
//
//   - absent report / config_status !== 'available'  → hook_state_unavailable
//     (trust is RECORDED in config.toml; a claim with no observable trust store
//     behind it is not evidence, whatever the handler counts say — entries are
//     necessarily empty exactly when the store is unobservable)
//   - any explicitly disabled handler (per-handler grain) → disabled_hook_state
export function evaluateCodexHookStateGate(hookState) {
  const summary = hookState?.summary ?? {};
  if (!hookState || hookState.config_status !== 'available') {
    return {
      blocked: true,
      reason: 'hook_state_unavailable',
      observation: hookState?.config_status ?? 'unobserved',
      disabled_handlers: 0,
      expected: summary.expected ?? 0,
    };
  }
  const disabledHandlers = summary.disabled_handlers ?? 0;
  if (disabledHandlers > 0) {
    return { blocked: true, reason: 'disabled_hook_state', observation: 'available', disabled_handlers: disabledHandlers, expected: summary.expected ?? 0 };
  }
  return { blocked: false, reason: null, observation: 'available', disabled_handlers: 0, expected: summary.expected ?? 0 };
}

// The pre-attest operator hint derived from the SAME gate — one sentence, one home,
// after this diff had to edit the identical string in doctor and settings in lockstep.
export function codexHookStateAttestHint(hookState) {
  const gate = evaluateCodexHookStateGate(hookState);
  if (gate.reason === 'disabled_hook_state') {
    return ` Current Codex config reports ${gate.disabled_handlers} explicitly disabled hook handler(s) across ${gate.expected} expected bundled hook entries; enable them in /hooks before attesting.`;
  }
  if (gate.reason === 'hook_state_unavailable') {
    return ` The Codex hook-state config (where /hooks records trust) is ${gate.observation}; review/trust the bundled hooks in /hooks so trust is recorded before attesting.`;
  }
  return '';
}

// The hook-state text block, shared by doctor's and settings' formatText renderers —
// previously a char-identical copy in each (both edited in lockstep by this diff).
export function formatCodexHookStateLines(state) {
  if (!state) return [];
  const lines = [];
  lines.push(`- hook-state: config=${state.config_status}; expected=${state.summary.expected}; enabled=${state.summary.expected_enabled}; disabled=${state.summary.expected_disabled}; disabled-handlers=${state.summary.disabled_handlers ?? 0}; missing=${state.summary.expected_missing}; untrusted=${state.summary.expected_untrusted}; unexpected-agentic=${state.summary.unexpected_agentic_entries}; unmapped=${state.summary.unmapped_events ?? 0}`);
  // Per-handler rows (S8a5): each explicitly disabled handler renders individually —
  // including one whose group reads enabled because a sibling is on.
  for (const handler of state.disabled_handlers ?? []) {
    lines.push(`  disabled-hook-handler: ${handler.plugin}; event=${handler.event}; path=${handler.hooks_path}; group=${handler.group_index ?? '?'}; hook=${handler.hook_index ?? '?'}; group-state=${handler.group_state}`);
  }
  return lines;
}

function buildCodexHookLocation({ manifestHooks, manifestHooksFile, defaultHooksFile, origin }) {
  const declared = Boolean(manifestHooks?.declared);
  const declaredFile = manifestHooksFile ?? { status: 'missing' };
  const bundled = declared
    ? declaredFile.status === 'available'
    : defaultHooksFile?.status === 'available';
  // A plugin that bundles hooks ONLY as Claude-adapter commands
  // (every command targets adapters/claude/hooks/…) and declares no Codex
  // hooks is a DELIBERATELY Claude-hook-only plugin (historically ADR-0040
  // §3 attention, pre-relocation). The classification is kept as a
  // diagnosis of that command shape — and to keep such a plugin out of
  // default_file_only (its missing manifest declaration is a deliberate
  // posture, not a forgotten exposure) — but it is NOT an exclusion from
  // the bundled/review/expected sets: Codex's default-file discovery is
  // command-shape-blind (observed on codex-cli 0.144.1, which loaded
  // attention's then-root hooks/hooks.json and let the operator trust
  // stop/subagent_stop), so the host review/trust surface exists regardless
  // of the design intent. That observation drove the posture resolution
  // (2026-07-11): attention relocated its Claude registration to a
  // manifest-declared adapters/claude path with no root default, so its
  // shipped source no longer reaches this classification — an installed
  // pre-relocation cache legitimately still does until upgraded.
  const defaultAnalysis = defaultHooksFile?.command_analysis;
  const claudeAdapterOnly = !declared && bundled
    && Boolean(defaultAnalysis)
    && defaultAnalysis.command_count > 0
    && defaultAnalysis.claude_adapter_references === defaultAnalysis.command_count;
  const status = declared && bundled
    ? 'exposed'
    : declared
      ? 'manifest_declared_missing_file'
      : bundled
        ? (claudeAdapterOnly ? 'claude_adapter_only' : 'default_file_only')
        : 'not_packaged';
  return {
    origin,
    status,
    manifest_declared: declared,
    manifest_type: manifestHooks?.type ?? null,
    manifest_paths: manifestHooks?.paths ?? [],
    bundled,
    hooks_file: declared ? declaredFile : defaultHooksFile ?? { status: 'missing' },
    default_hooks_file: defaultHooksFile ?? { status: 'missing' },
  };
}

function normalizeHostVersion(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const match = text.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
  return match?.[0] ?? text;
}

// Baseline freshness lives in doctor (frequently run) so host-version drift
// surfaces without a manual runtime:compat run. cutover-audit reuses this
// result rather than re-parsing the baseline (single source of truth).
async function buildHostParityBaseline({ repoRoot, claude, codex }) {
  const path = join(repoRoot, 'plugins', 'runtime', 'docs', 'host-parity-baseline.md');
  let text = '';
  try {
    text = await readFile(path, 'utf8');
  } catch {
    text = '';
  }
  const match = text.match(/Observed on ([0-9-]+) with Claude Code `([^`]+)`, Codex CLI\s*`([^`]+)`/m);
  // Gate freshness on a successful version probe. version.text carries
  // stderr/error_message when the probe failed (inspectCli), so a failed
  // claude/codex --version must not be normalized into a false current/stale
  // verdict — without a real observed version, freshness is 'unknown', not a
  // baseline-staleness signal.
  const claudeProbe = claude?.version?.status ?? null;
  const codexProbe = codex?.version?.status ?? null;
  const probesOk = claudeProbe === 'available' && codexProbe === 'available';
  const observedClaude = probesOk ? observedVersionText(claude?.version) : null;
  const observedCodex = probesOk ? observedVersionText(codex?.version) : null;
  const normalizedObserved = {
    claude: normalizeHostVersion(observedClaude),
    codex: normalizeHostVersion(observedCodex),
  };
  const baseline = match ? { date: match[1], claude: match[2], codex: match[3] } : null;
  const current = Boolean(probesOk && baseline
    && normalizedObserved.claude === normalizeHostVersion(baseline.claude)
    && normalizedObserved.codex === normalizeHostVersion(baseline.codex));
  let status;
  let nextAction;
  if (!probesOk) {
    status = 'unknown';
    nextAction = 'Probe host CLIs first — claude/codex --version did not return a usable version (one or both unavailable); cannot assess baseline freshness.';
  } else if (!baseline) {
    status = 'missing';
    nextAction = 'Restore plugins/runtime/docs/host-parity-baseline.md.';
  } else if (current) {
    status = 'current';
    nextAction = null;
  } else {
    status = 'stale';
    nextAction = 'Refresh plugins/runtime/docs/host-parity-baseline.md via runtime:compat snapshot→check→ingest-release-notes→plan for the current host versions.';
  }
  return {
    id: 'host_parity_baseline',
    label: 'Host parity baseline freshness',
    status,
    evidence: {
      baseline,
      observed: { claude: observedClaude, codex: observedCodex },
      normalized_observed: normalizedObserved,
      probes: { claude: claudeProbe, codex: codexProbe },
    },
    next_action: nextAction,
  };
}

function buildHostParity({ claude, codex, plugins, claudePluginList, codexPluginList = { status: 'unavailable', entries: {} }, codexPluginHooks }) {
  const issues = [];
  const differences = [];

  if (codexPluginHooks.summary.default_file_only_plugins.length > 0 || codexPluginHooks.summary.missing_hooks_file_plugins.length > 0) {
    differences.push(parityEntry({
      id: 'codex_plugin_hooks_packaging_gap',
      severity: 'warning',
      host: 'codex',
      area: 'hooks',
      summary: 'Codex bundled hooks exist but are not cleanly exposed as plugin metadata for all hook-bearing agentic-plugins.',
      evidence: `default-file-only=${codexPluginHooks.summary.default_file_only_plugins.join(',') || 'none'}, missing-file=${codexPluginHooks.summary.missing_hooks_file_plugins.join(',') || 'none'}`,
      next_step: 'Expose hooks through each hook-bearing .codex-plugin/plugin.json and keep hooks/hooks.json in the installed package.',
    }));
  }

  if (codexPluginHooks.summary.bundled_plugins.length > 0) {
    const pluginHooksRemoved = codex.feature_surface.codex_plugin_hooks_stage === 'removed';
    if (pluginHooksRemoved && codex.feature_surface.codex_global_hooks !== true) {
      differences.push(parityEntry({
        id: 'codex_generic_hooks_disabled',
        severity: 'warning',
        host: 'codex',
        area: 'hooks',
        summary: 'Codex plugin_hooks is removed and generic [features].hooks is not enabled, so bundled plugin hooks cannot run automatically until generic hooks is on and the hooks are trusted with /hooks.',
        evidence: `bundled=${codexPluginHooks.summary.bundled_plugins.join(',')}, codex global_hooks=${featureFlagEvidence(codex.feature_surface.codex_global_hooks, codex.feature_surface.codex_global_hooks_stage)}, codex plugin_hooks=${featureFlagEvidence(codex.feature_surface.codex_plugin_hooks, codex.feature_surface.codex_plugin_hooks_stage)}`,
        next_step: 'Enable generic Codex hooks, then review/trust the bundled hooks in Codex with /hooks.',
      }));
    } else if (!pluginHooksRemoved && codex.feature_surface.codex_plugin_hooks !== true) {
      differences.push(parityEntry({
        id: 'codex_plugin_hooks_feature_disabled',
        severity: 'warning',
        host: 'codex',
        area: 'hooks',
        summary: codex.feature_surface.codex_global_hooks === true
          ? 'Codex global hooks are enabled, but bundled plugin hooks require [features].plugin_hooks=true before hook-bearing agentic-plugins can run lifecycle hooks automatically.'
          : 'Codex bundled plugin hooks are packaged, but generic hooks and/or plugin_hooks are not enabled in the observed feature surface.',
        evidence: `bundled=${codexPluginHooks.summary.bundled_plugins.join(',')}, codex global_hooks=${featureFlagEvidence(codex.feature_surface.codex_global_hooks, codex.feature_surface.codex_global_hooks_stage)}, codex plugin_hooks=${featureFlagEvidence(codex.feature_surface.codex_plugin_hooks, codex.feature_surface.codex_plugin_hooks_stage)}, codex automatic_plugin_hooks=false`,
        next_step: 'Enable [features].plugin_hooks manually in Codex config (legacy Codex < ~0.134; runtime does not write Codex host config per ADR-0035 §6), then review/trust the bundled hooks in Codex with /hooks.',
      }));
    }
  }

  if (codexPluginHooks.summary.command_warning_plugins?.length > 0) {
    differences.push(parityEntry({
      id: 'codex_plugin_hooks_command_portability_unverified',
      severity: 'warning',
      host: 'codex',
      area: 'hooks',
      summary: 'Codex-exposed hook commands have portability warnings.',
      evidence: `plugins=${codexPluginHooks.summary.command_warning_plugins.join(',')}; claude-root=${codexPluginHooks.summary.claude_root_command_plugins.join(',') || 'none'}; claude-adapter=${codexPluginHooks.summary.claude_adapter_command_plugins.join(',') || 'none'}; bare-node=${codexPluginHooks.summary.bare_node_command_plugins.join(',') || 'none'}`,
      next_step: 'Verify Codex /hooks active execution in-session, or route hook commands through a host-appropriate wrapper before accepting automatic lifecycle hook parity.',
    }));
  }

  if (codex.feature_surface.plugin_install_command === true) {
    // Codex >= ~0.137: per-plugin install (add) exists but is not full Claude parity.
    // Enumerate only the per-plugin verbs actually observed so we never overclaim.
    const codexPerPluginVerbList = codexPerPluginVerbs(codex.feature_surface);
    differences.push(parityEntry({
      id: 'codex_plugin_command_partial_parity',
      severity: 'info',
      host: 'codex',
      area: 'plugin-install',
      summary: `Codex exposes per-plugin ${codexPerPluginVerbList.join('/')} plus marketplace add/list/upgrade/remove, but not full Claude plugin parity (no per-plugin update/enable/disable/details/validate/prune).`,
      evidence: `codex plugin add=${Boolean(codex.feature_surface.plugin_install_command)}, list=${Boolean(codex.feature_surface.plugin_list_command)}, remove=${Boolean(codex.feature_surface.plugin_remove_command)}; marketplace add=${Boolean(codex.feature_surface.plugin_marketplace_add)}, list=${Boolean(codex.feature_surface.plugin_marketplace_list)}, upgrade=${Boolean(codex.feature_surface.plugin_marketplace_upgrade)}, remove=${Boolean(codex.feature_surface.plugin_marketplace_remove)}`,
      next_step: `Use per-plugin ${codexPerPluginVerbList.join('/')} where applicable; do not assume update/enable/disable/details/validate/prune exist on Codex.`,
    }));
  } else if (codex.feature_surface.plugin_marketplace === true) {
    // Codex 0.130-0.136: marketplace-only, no per-plugin install/list surface.
    differences.push(parityEntry({
      id: 'codex_marketplace_command_shape',
      severity: 'warning',
      host: 'codex',
      area: 'plugin-install',
      summary: 'Codex exposes marketplace add/upgrade/remove semantics rather than the Claude-style plugin install/list surface.',
      evidence: `codex marketplace add=${Boolean(codex.feature_surface.plugin_marketplace_add)}, upgrade=${Boolean(codex.feature_surface.plugin_marketplace_upgrade)}, remove=${Boolean(codex.feature_surface.plugin_marketplace_remove)}, install=${Boolean(codex.feature_surface.plugin_install_command)}`,
      next_step: 'Render host-specific install/update recommendations instead of a shared install command.',
    }));
  }

  const runtimePlugin = plugins.runtime;
  if (runtimePlugin?.cache?.codex?.status !== 'available' && runtimePlugin?.cache?.codex_tmp_marketplace?.status === 'available') {
    differences.push(parityEntry({
      id: 'codex_plugin_cache_materialization_manual',
      severity: 'warning',
      host: 'codex',
      area: 'plugin-install',
      plugin: 'runtime',
      summary: 'Codex has a marketplace cache for runtime but no per-plugin install cache; this materialization is a host lifecycle step, not a runtime:settings executable action.',
      evidence: `codex-cache=${runtimePlugin.cache.codex.status}, codex-marketplace-cache=${runtimePlugin.cache.codex_tmp_marketplace.status}/${runtimePlugin.cache.codex_tmp_marketplace.manifest_version ?? 'unknown'}, source-present=${Boolean(runtimePlugin.source?.present)}`,
      next_step: 'Do not repeat marketplace add when the marketplace cache is current; start a fresh Codex session or invoke the plugin surface, then re-run runtime:doctor.',
    }));
  }

  if (claude.feature_surface.permission_mode === true || codex.feature_surface.sandbox_flag === true || codex.feature_surface.approval_flag === true) {
    differences.push(parityEntry({
      id: 'host_permission_model_differs',
      severity: 'info',
      host: 'both',
      area: 'permissions',
      summary: 'Claude and Codex expose different permission controls; runtime can preflight them but must not normalize them into one hidden setting.',
      evidence: `claude permission_mode=${Boolean(claude.feature_surface.permission_mode)}, codex sandbox=${Boolean(codex.feature_surface.sandbox_flag)}, codex approval=${Boolean(codex.feature_surface.approval_flag)}`,
      next_step: 'Keep permission proof explicit and direction-aware.',
    }));
  }

  for (const [name, plugin] of Object.entries(plugins)) {
    issues.push(...inspectPluginVersionParity(name, plugin));
  }

  for (const installed of Object.values(claudePluginList)) {
    if (!PLUGIN_NAMES.includes(installed.name)) {
      issues.push(parityEntry({
        id: 'claude_retired_or_unknown_plugin',
        severity: installed.status === 'failed' ? 'warning' : 'info',
        host: 'claude',
        area: 'plugin-install',
        plugin: installed.name,
        summary: `Claude has an agentic-plugins entry that is not in the current runtime plugin set: ${installed.name}.`,
        evidence: `status=${installed.status ?? 'unknown'}, version=${installed.version ?? 'unknown'}, error=${installed.error ?? 'none'}`,
        next_step: 'If this is the retired research plugin, uninstall it from the Claude host cache.',
      }));
    }
  }

  // Mirror the Claude retired/unknown-plugin parity for Codex, but only when the
  // `codex plugin list --json` probe was authoritative (status==='available') —
  // an unavailable list must not manufacture parity claims (ADR-0034).
  if (codexPluginList.status === 'available') {
    for (const installed of Object.values(codexPluginList.entries)) {
      // Only flag entries the host actually has installed — a defensive
      // installed:false entry is not a retired install.
      if (installed.status === 'not_installed') continue;
      if (!PLUGIN_NAMES.includes(installed.name)) {
        issues.push(parityEntry({
          id: 'codex_retired_or_unknown_plugin',
          severity: 'info',
          host: 'codex',
          area: 'plugin-install',
          plugin: installed.name,
          summary: `Codex has an agentic-plugins entry that is not in the current runtime plugin set: ${installed.name}.`,
          evidence: `status=${installed.status ?? 'unknown'}, version=${installed.version ?? 'unknown'}, enabled=${installed.enabled ?? 'unknown'}`,
          next_step: 'If this is a retired plugin, remove it with `codex plugin remove` from the Codex host.',
        }));
      }
    }
  }

  const all = [...issues, ...differences];
  return {
    status: summarizeParityStatus(all),
    issue_count: issues.length,
    difference_count: differences.length,
    issues,
    differences,
  };
}

function inspectPluginVersionParity(name, plugin) {
  const issues = [];
  const claudeSourceVersion = plugin.source?.claude_manifest?.version ?? null;
  const codexSourceVersion = plugin.source?.codex_manifest?.version ?? null;
  const sourceVersion = claudeSourceVersion ?? codexSourceVersion;

  if (claudeSourceVersion && codexSourceVersion && claudeSourceVersion !== codexSourceVersion) {
    issues.push(parityEntry({
      id: 'source_manifest_version_mismatch',
      severity: 'blocked',
      host: 'both',
      area: 'version',
      plugin: name,
      summary: `${name} source manifests disagree between Claude and Codex.`,
      evidence: `claude=${claudeSourceVersion}, codex=${codexSourceVersion}`,
      next_step: 'Align .claude-plugin/plugin.json and .codex-plugin/plugin.json before publishing.',
    }));
  }

  if (plugin.marketplace.claude?.version && sourceVersion && plugin.marketplace.claude.version !== sourceVersion) {
    issues.push(parityEntry({
      id: 'claude_marketplace_version_drift',
      severity: 'warning',
      host: 'claude',
      area: 'version',
      plugin: name,
      summary: `${name} Claude marketplace version differs from source manifest.`,
      evidence: `marketplace=${plugin.marketplace.claude.version}, source=${sourceVersion}`,
      next_step: 'Run sync/validate version tooling before release.',
    }));
  }

  if (plugin.installed.claude_plugin_list?.status === 'failed') {
    issues.push(parityEntry({
      id: 'claude_plugin_failed_to_load',
      severity: 'blocked',
      host: 'claude',
      area: 'plugin-install',
      plugin: name,
      summary: `${name} is present in Claude plugin list but failed to load.`,
      evidence: plugin.installed.claude_plugin_list.error ?? 'Claude plugin list reported failed status',
      next_step: 'Fix or uninstall the failed Claude plugin entry before relying on Claude-side parity.',
    }));
  }

  const claudeInstalledVersion = plugin.installed.claude_plugin_list?.version ?? plugin.cache.claude?.latest?.manifest_version ?? null;
  // List-authoritative installed version (ADR-0034): when the list probe was
  // authoritative, use the resolver's version (installed/disabled -> entry
  // version; not_installed -> null, so a stale cache cannot manufacture a false
  // version-drift parity issue after the list omitted the plugin). Fall back to
  // the filesystem cache version ONLY when the list was unavailable.
  const codexResolved = plugin.installed.codex_resolved;
  const codexFromCache = codexResolved?.decision === 'fallback';
  const codexInstalledVersion = codexFromCache
    ? (plugin.cache.codex?.latest?.manifest_version ?? null)
    : (codexResolved?.version ?? null);
  issues.push(...compareInstalledVersion({
    plugin: name,
    host: 'claude',
    actual: claudeInstalledVersion,
    expected: sourceVersion,
    source: 'Claude installed/cache version',
  }));
  issues.push(...compareInstalledVersion({
    plugin: name,
    host: 'codex',
    actual: codexInstalledVersion,
    expected: sourceVersion,
    source: codexFromCache ? 'Codex cache version' : 'Codex plugin list version',
  }));

  return issues;
}

// The per-plugin verbs Codex actually exposes, in declared order. Used so output
// enumerates only detected subcommands and never overclaims (e.g. summarizing
// "add/list/remove" when only `add` was observed). Exported so settings reuses the
// same single source of truth instead of re-enumerating the verbs inline.
export function codexPerPluginVerbs(featureSurface) {
  return [
    featureSurface.plugin_install_command && 'add',
    featureSurface.plugin_list_command && 'list',
    featureSurface.plugin_remove_command && 'remove',
  ].filter(Boolean);
}

function buildPluginCommandSurface({ claude, codex, plugins, hostParity, codexPluginHooks, settingsRuns }) {
  const claudeSurfaceStatus = buildClaudePluginCliSurfaceStatus(claude);
  const claudeSurfaceAvailable = claudeSurfaceStatus === 'available';
  // Codex >= ~0.137 exposes per-plugin `codex plugin add` (install); older hosts are
  // marketplace-only. Recognition is keyed on the observed command surface, not version.
  const codexHasPerPlugin = Boolean(codex.feature_surface.plugin_install_command);
  const codexPerPluginVerbList = codexPerPluginVerbs(codex.feature_surface);
  const codexPerPluginVerbText = codexPerPluginVerbList.join('/') || 'install';
  return {
    schema_version: 'runtime-plugin-command-surface-1.4',
    claude: {
      status: claudeSurfaceStatus,
      mode: claudeSurfaceStatus === 'unavailable'
        ? 'unavailable'
        : claude.feature_surface.plugin_install_command || claude.feature_surface.plugin_list_command
        ? 'per-plugin-command'
        : 'unknown',
      supports: {
        install_plugin: claudeSurfaceAvailable && Boolean(claude.feature_surface.plugin_install_command),
        update_plugin: claudeSurfaceAvailable && Boolean(claude.feature_surface.plugin_update_command),
        uninstall_plugin: claudeSurfaceAvailable && Boolean(claude.feature_surface.plugin_uninstall_command),
        list_plugin: claudeSurfaceAvailable && Boolean(claude.feature_surface.plugin_list_command),
        marketplace_add: false,
        marketplace_upgrade: false,
        marketplace_remove: false,
      },
      observed_surfaces: {
        cli_plugin: claude.plugin.status,
        slash_plugin: claude.plugin_surface?.status ?? 'unknown',
      },
      materialization: claudeSurfaceAvailable
        ? {
            status: 'host-native-plugin-command',
            executable_by_settings: true,
            reason: 'Claude exposes plugin install/update/list CLI commands that can materialize the host plugin cache.',
          }
        : {
            status: 'blocked',
            executable_by_settings: false,
            reason: claude.plugin?.reason ?? claude.plugin_surface?.reason ?? 'Claude plugin CLI command surface could not be verified.',
            next_step: 'Retry plugin management from a Claude Code environment that supports claude plugin commands.',
          },
    },
    codex: {
      status: codex.plugin.status,
      mode: codexHasPerPlugin
        ? 'per-plugin-and-marketplace'
        : codex.feature_surface.plugin_marketplace
        ? 'marketplace-only'
        : 'unknown',
      supports: {
        install_plugin: Boolean(codex.feature_surface.plugin_install_command),
        list_plugin: Boolean(codex.feature_surface.plugin_list_command),
        remove_plugin: Boolean(codex.feature_surface.plugin_remove_command),
        // Codex has no per-plugin update verb (marketplace upgrade only); kept explicit
        // so the non-parity with Claude is visible in the data, not just in `limits`.
        update_plugin: false,
        marketplace_add: Boolean(codex.feature_surface.plugin_marketplace_add),
        marketplace_list: Boolean(codex.feature_surface.plugin_marketplace_list),
        marketplace_upgrade: Boolean(codex.feature_surface.plugin_marketplace_upgrade),
        marketplace_remove: Boolean(codex.feature_surface.plugin_marketplace_remove),
      },
      materialization: buildCodexCacheMaterialization(plugins.runtime, { perPluginSurface: codexHasPerPlugin }),
      limits: codexHasPerPlugin
        ? [
            `Codex exposes per-plugin ${codexPerPluginVerbText} plus marketplace add/list/upgrade/remove; it does not expose per-plugin update/enable/disable/details/validate/prune, so this is not full Claude plugin parity.`,
            'runtime:settings recognizes the per-plugin surface but does not auto-execute codex plugin add; Codex cache materialization stays a manual or fresh-session step (execution wiring is a deferred follow-up).',
          ]
        : [
            'Codex marketplace add/upgrade updates marketplace cache evidence, not a per-plugin install cache by itself.',
            'runtime:settings intentionally keeps Codex cache materialization manual unless the host exposes an explicit per-plugin install/update command.',
          ],
    },
    manual_followups: buildPluginCommandSurfaceManualFollowups({
      claudeSurfaceAvailable,
      plugins,
      hostParity,
      codexPluginHooks,
      settingsRuns,
    }),
  };
}

function buildClaudePluginCliSurfaceStatus(claude) {
  if (claude.status !== 'available') return claude.status;
  if (claude.plugin.status !== 'available') return claude.plugin.status;
  if (claude.feature_surface.plugin_install_command || claude.feature_surface.plugin_list_command) return 'available';
  if (claude.plugin_surface?.status === 'available') return 'available';
  return 'unknown';
}

function buildPluginCommandSurfaceManualFollowups({ claudeSurfaceAvailable, plugins, hostParity, codexPluginHooks, settingsRuns }) {
  const followups = [];
  const pluginCommands = claudeSurfaceAvailable ? [] : buildClaudePluginSurfaceCommands(plugins);
  if (pluginCommands.length > 0) {
    followups.push({
      id: 'claude-plugin-surface-unavailable',
      host: 'claude',
      status: 'manual_required',
      reason: 'Claude plugin CLI command surface is unavailable to runtime:doctor in this environment.',
      environment: 'Open a Claude Code environment that supports claude plugin commands.',
      commands: pluginCommands,
      verify: 'Re-run runtime:doctor or runtime:settings after completing the commands.',
    });
  }
  const cleanupCommands = buildClaudeRetiredPluginCleanupCommands(hostParity?.issues ?? []);
  if (cleanupCommands.length > 0) {
    followups.push({
      id: 'claude-retired-plugin-cleanup',
      host: 'claude',
      status: 'manual_required',
      reason: 'Claude has retired or unknown agentic-plugins entries that runtime:doctor will not uninstall automatically.',
      environment: 'Open a Claude Code environment that supports claude plugin commands.',
      commands: cleanupCommands,
      verify: 'Re-run runtime:doctor or runtime:settings after completing the commands.',
    });
  }
  const hookFollowup = buildCodexHookReviewManualFollowup(codexPluginHooks, 'runtime:doctor', settingsRuns, plugins);
  if (hookFollowup) followups.push(hookFollowup);
  return followups;
}

function buildClaudePluginSurfaceCommands(plugins) {
  const commands = [];
  for (const name of PLUGIN_NAMES) {
    const plugin = plugins[name];
    const sourceVersion = plugin?.source?.claude_manifest?.version ?? plugin?.source?.codex_manifest?.version ?? null;
    const claudeInstalled = plugin?.installed?.claude_plugin_list ?? null;
    const claudeCacheLatest = plugin?.cache?.claude?.latest ?? null;
    const claudeVersion = claudeInstalled?.version ?? claudeCacheLatest?.manifest_version ?? null;
    if (!claudeInstalled && !claudeCacheLatest) {
      commands.push(`claude plugin install ${name}@agentic-plugins`);
    } else if (sourceVersion && claudeVersion && semverCompare(String(claudeVersion), String(sourceVersion)) < 0) {
      commands.push(`claude plugin update ${name}@agentic-plugins`);
    }
  }
  return uniqueStrings(commands);
}

function buildClaudeRetiredPluginCleanupCommands(issues) {
  const commands = [];
  for (const issue of issues) {
    if (issue.id !== 'claude_retired_or_unknown_plugin') continue;
    if (issue.host !== 'claude') continue;
    if (!issue.plugin) continue;
    commands.push(`claude plugin uninstall ${issue.plugin}@agentic-plugins`);
  }
  return uniqueStrings(commands);
}

function buildCodexHookReviewManualFollowup(codexPluginHooks, surface, settingsRuns = null, plugins = null) {
  const bundled = codexPluginHooks?.summary?.bundled_plugins ?? [];
  if (bundled.length === 0 || codexPluginHooks?.status !== 'ready') return null;
  // Read the SINGLE currency verdict computed in inspectSettingsRuns rather than recomputing
  // it here: the two must never disagree (a doctor that says `attested` in one surface and
  // "re-review required" in another is exactly the inconsistency S8a4 §SCOPE-3 closes).
  if (settingsRuns?.codex_hook_review?.current === true) return null;
  const reviewTargets = codexPluginHooks?.review_targets ?? [];
  // One shared hint derived from the ONE gate predicate (S8a5) — the per-handler
  // grain, plus the unavailable-trust-store case, phrased once for both surfaces.
  const hookStateHint = codexHookStateAttestHint(codexPluginHooks?.hook_state ?? null);
  return {
    id: 'codex-hook-review',
    host: 'codex',
    status: 'manual_check',
    reason: `Codex plugin hooks are packaged and the stage-appropriate hook gate is enabled, but ${surface} cannot verify active-session hook review/trust state.`,
    environment: 'Open the active Codex session for this repository.',
    commands: ['/hooks'],
    verify: `Review/trust bundled hooks for ${bundled.join(', ')} (${reviewTargets.length} review target(s)); if /hooks shows "New hook - review required", review each new hook first. Do not attest from /hooks Installed counts alone, including Active=0 output.${hookStateHint} Then run runtime:settings --attest-codex-hook-review and rerun runtime:doctor.`,
    review_targets: reviewTargets,
  };
}

// The Codex /hooks attestation currency mirror (machine-bootstrap-contract.md §8.2, S8a4).
// It must reach the SAME verdict the completion reducer's recomputeHookAttestation reaches,
// on the SAME evidence: an attestation is an operator claim bound to specific versions, and
// hook trust is version-bound (ADR-0030). `codexCliVersion` is the STRICTLY parsed current
// Codex CLI version — the same value the producer bound — so the mirror and producer agree.
function getCurrentCodexHookReviewAttestation(settingsRuns, codexPluginHooks, plugins, codexCliVersion = null) {
  const attestation = settingsRuns?.codex_hook_review?.latest ?? null;
  if (!attestation || attestation.attested !== true || attestation.status !== 'attested') {
    return { current: false, reason: 'missing', attestation: null };
  }
  // Hook-state evidence gate (S8a5) — the ONE shared predicate (see
  // evaluateCodexHookStateGate) settings' producer gate also consults, so a machine
  // that can be attested is exactly a machine whose attestation reads current. It
  // blocks on an unobservable trust store (absent report or config_status !==
  // 'available' — an ABSENT report must not skip the gate: zero evidence reading as
  // current is the opposite of the reducer's verdict on the same machine) and on any
  // explicitly disabled handler at the per-handler grain (`disabled_handlers` is a
  // strict superset of the group-state `expected_disabled` count, which missed a
  // handler disabled beside an enabled sibling).
  const hookStateGate = evaluateCodexHookStateGate(codexPluginHooks?.hook_state ?? null);
  if (hookStateGate.blocked) {
    return { current: false, reason: hookStateGate.reason, attestation };
  }
  const expectedPlugins = codexPluginHooks?.summary?.bundled_plugins ?? [];
  // Prefer the canonical attested_plugins set; fall back to legacy bundled_plugins so a
  // pre-S8a4 attestation still resolves its covered set during the compat window.
  const attestedPlugins = attestation.attested_plugins ?? attestation.bundled_plugins ?? [];
  if (!sameStringSet(expectedPlugins, attestedPlugins)) {
    return { current: false, reason: 'plugin_set_changed', attestation };
  }
  // Codex CLI version binding — the dead-pipe repair's core. A legacy attestation with no
  // bound codex version, or a machine whose Codex version cannot be resolved, is NEVER
  // current: an attestation that cannot name the Codex it was made against is not proof,
  // and a null-vs-null match is two unknowns agreeing, not evidence nothing changed.
  const boundCodex = attestation.bound_versions?.codex ?? null;
  if (boundCodex === null || codexCliVersion === null || boundCodex !== codexCliVersion) {
    return { current: false, reason: 'codex_cli_version_changed', attestation };
  }
  // Per-plugin versions resolved through the SAME list authority the producer bound with
  // (§SCOPE-2), preferring the canonical bound map and falling back to the legacy flat map.
  const boundPlugins = attestation.bound_versions?.plugins?.codex ?? null;
  for (const pluginName of expectedPlugins) {
    const attested = (boundPlugins?.[pluginName] ?? attestation.plugin_versions?.[pluginName]) ?? null;
    const resolvedActual = resolveCodexInstalledVersionFromMatrix(plugins?.[pluginName]);
    // The authority's attestable verdict is CONSUMED, not just its version (S8a5
    // refine-verify, peer finding): a plugin the Codex list reports disabled resolves
    // to its version with attestable:false — reading only `.version` let a disabled
    // plugin with a matching version stay `current` here while the completion reducer
    // staled the same machine on plugin state ("a disabled plugin loads no hooks").
    if (!resolvedActual.attestable) {
      return { current: false, reason: 'plugin_not_attestable', attestation };
    }
    const actual = resolvedActual.version;
    if (attested === null || actual === null || attested !== actual) {
      return { current: false, reason: 'plugin_version_changed', attestation };
    }
  }
  return { current: true, reason: null, attestation };
}

// The ONE place doctor decides an attestation's currency, so every doctor surface reads the
// same verdict (§SCOPE-3). Consumers get an operator-facing `status` (attested only when the
// claim still holds, else stale), the boolean `current`, and the machine `currency_reason`.
function buildCodexHookReviewCurrency({ latestCodexHookReview, codexPluginHooks, plugins, codexCliVersion }) {
  if (!latestCodexHookReview) {
    return { status: 'missing', current: false, currency_reason: 'missing', latest: null };
  }
  const verdict = getCurrentCodexHookReviewAttestation(
    { codex_hook_review: { latest: latestCodexHookReview } },
    codexPluginHooks,
    plugins,
    codexCliVersion,
  );
  return {
    status: verdict.current ? 'attested' : 'stale',
    current: verdict.current,
    currency_reason: verdict.reason,
    latest: latestCodexHookReview,
  };
}

function compareInstalledVersion({ plugin, host, actual, expected, source }) {
  if (!actual || !expected || actual === expected) return [];
  const cmp = semverCompare(actual, expected);
  const stale = cmp < 0;
  return [parityEntry({
    id: stale ? 'installed_plugin_stale' : 'installed_plugin_version_ahead',
    severity: stale ? 'warning' : 'info',
    host,
    area: 'version',
    plugin,
    summary: `${plugin} ${host} ${stale ? 'installed/cache version is older than' : 'installed/cache version is newer than'} source manifest.`,
    evidence: `${source}=${actual}, source=${expected}`,
    next_step: stale
      ? 'Upgrade or reinstall the plugin in that host before expecting source behavior.'
      : 'Confirm the host cache was intentionally updated ahead of this checkout.',
  })];
}

function parityEntry({ id, severity, host, area, plugin = null, summary, evidence, next_step }) {
  return {
    id,
    severity,
    host,
    area,
    plugin,
    summary,
    evidence: sanitizeValue(evidence),
    next_step,
  };
}

function summarizeParityStatus(entries) {
  if (entries.some((entry) => entry.severity === 'blocked')) return 'blocked';
  if (entries.some((entry) => entry.severity === 'warning')) return 'warning';
  return 'pass';
}

async function inspectWorkflowLedgers({ repoRoot, now, staleGraceMs }) {
  return {
    engineer: await inspectWorkflowNamespace({
      repoRoot,
      plugin: 'engineer',
      legacyNamespace: 'agentic-engineer',
      expectedPlugin: 'engineer',
      now,
      staleGraceMs,
    }),
    orchestrator: await inspectWorkflowNamespace({
      repoRoot,
      plugin: 'orchestrator',
      legacyNamespace: 'agentic-orchestrator',
      expectedPlugin: 'orchestrator',
      now,
      staleGraceMs,
    }),
  };
}

async function inspectSettingsRuns({ repoRoot, codexPluginHooks = null, plugins = null, codexCliVersion = null }) {
  const root = join(repoRoot, '.agentic-plugins', 'runs', 'settings');
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    return {
      status: 'missing',
      root,
      count: 0,
      malformed: 0,
      latest: null,
      codex_hook_review: { status: 'missing', current: false, currency_reason: 'missing', latest: null },
      error: err.code ?? err.message,
    };
  }

  const runs = [];
  let malformed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !SETTINGS_RUN_ID_RE.test(entry.name)) continue;
    const artifactPath = join(root, entry.name, 'settings.json');
    const artifact = await readJsonIfExists(artifactPath);
    if (!artifact.ok) {
      malformed++;
      runs.push({
        run_id: entry.name,
        status: 'blocked',
        artifact_pointer: pointer(repoRoot, artifactPath),
        selected_at: null,
        selected_at_ms: runIdTimestampMs(entry.name) ?? 0,
        plugin_management: emptySettingsPluginManagement(),
        plugin_cleanup: emptySettingsPluginCleanup(),
        codex_hook_review: emptySettingsCodexHookReview(),
        reason: artifact.reason,
      });
      continue;
    }
    const summary = await summarizeSettingsArtifact({
      repoRoot,
      runId: entry.name,
      artifactPath,
      artifact: artifact.json,
    });
    if (summary.status === 'blocked') malformed++;
    runs.push(summary);
  }

  if (runs.length === 0) {
    return {
      status: malformed > 0 ? 'blocked' : 'empty',
      root,
      count: 0,
      malformed,
      latest: null,
      codex_hook_review: { status: 'missing', current: false, currency_reason: 'missing', latest: null },
    };
  }

  runs.sort((a, b) => b.selected_at_ms - a.selected_at_ms || b.run_id.localeCompare(a.run_id));
  const latest = runs[0];
  const latestCodexHookReview = runs.find((run) => run.codex_hook_review?.attested === true && run.codex_hook_review?.status === 'attested')?.codex_hook_review ?? null;
  // machine-bootstrap-contract.md §1.5 part 3 — the load-bearing reader migration.
  // An interrupted write-ahead run (planned / in-progress) has zero failures and
  // MUST NOT read as available; a plan-hash `refused` run and a plugin-management
  // `blocked` action likewise need operator attention.
  const latestInterrupted = latest.terminal === false || SETTINGS_EXECUTION_NONTERMINAL_STATUSES.has(latest.status);
  const latestRefused = latest.status === 'refused';
  const status = malformed > 0
    ? 'blocked'
    : latestInterrupted
      || latestRefused
      || latest.plugin_management.failed > 0
      || latest.plugin_management.blocked > 0
      || latest.plugin_cleanup.failed > 0
      || latest.plugin_cleanup.blocked > 0
      || (latest.codex_hook_review.requested && latest.codex_hook_review.status !== 'attested')
      ? 'needs_attention'
      : 'available';
  return {
    status,
    root,
    count: runs.length,
    malformed,
    latest,
    interrupted: latestInterrupted,
    recovery: latestInterrupted
      ? 'Latest settings execution is a nonterminal write-ahead record (interrupted run). Its journal names what landed; re-run runtime:settings to re-probe and re-plan the remaining actions — nothing is auto-rolled-back (machine-bootstrap-contract.md §1.5).'
      : null,
    codex_hook_review: buildCodexHookReviewCurrency({
      latestCodexHookReview,
      codexPluginHooks,
      plugins,
      codexCliVersion,
    }),
  };
}

async function inspectDoctorRuns({ repoRoot }) {
  const root = join(repoRoot, '.agentic-plugins', 'runs', 'doctor');
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    return {
      status: 'missing',
      root,
      count: 0,
      malformed: 0,
      latest: null,
      latest_report: null,
      error: err.code ?? err.message,
    };
  }

  const runs = [];
  let malformed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !DOCTOR_RUN_ID_RE.test(entry.name)) continue;
    const artifactPath = join(root, entry.name, 'doctor.json');
    const artifact = await readJsonIfExists(artifactPath);
    if (!artifact.ok || !isDoctorArtifact(artifact.json)) {
      malformed++;
      runs.push({
        run_id: entry.name,
        status: 'blocked',
        artifact_pointer: pointer(repoRoot, artifactPath),
        selected_at: null,
        selected_at_ms: runIdTimestampMs(entry.name) ?? 0,
        reason: artifact.ok ? 'invalid doctor artifact schema' : artifact.reason,
      });
      continue;
    }
    const selectedAt = artifactTimestampMs(artifact.json, entry.name);
    runs.push({
      run_id: sanitizeValue(artifact.json.run_id) ?? entry.name,
      status: sanitizeValue(artifact.json.status) ?? 'recorded',
      artifact_pointer: pointer(repoRoot, artifactPath),
      selected_at: selectedAt === null ? null : new Date(selectedAt).toISOString(),
      selected_at_ms: selectedAt ?? 0,
      runtime_version: sanitizeValue(artifact.json.runtime_version),
      report: artifact.json.report,
    });
  }

  if (runs.length === 0) {
    return {
      status: malformed > 0 ? 'blocked' : 'empty',
      root,
      count: 0,
      malformed,
      latest: null,
      latest_report: null,
    };
  }

  runs.sort((a, b) => b.selected_at_ms - a.selected_at_ms || b.run_id.localeCompare(a.run_id));
  const latest = runs[0];
  return {
    status: malformed > 0 ? 'blocked' : 'available',
    root,
    count: runs.length,
    malformed,
      latest: summarizeDoctorRun(latest),
      internal_runs: runs.filter((run) => run.report),
    };
}

function summarizeDoctorRun(run) {
  if (!run) return null;
  return {
    run_id: run.run_id,
    status: run.status,
    artifact_pointer: run.artifact_pointer,
    selected_at: run.selected_at,
    selected_at_ms: run.selected_at_ms,
    runtime_version: run.runtime_version,
  };
}

function isDoctorArtifact(value) {
  return value
    && typeof value === 'object'
    && value.schema_version === DOCTOR_ARTIFACT_SCHEMA_VERSION
    && DOCTOR_RUN_ID_RE.test(value.run_id ?? '')
    && value.report
    && value.report.schema_version === 'runtime-doctor-1.0';
}

function buildRecordedDoctorProof({ runs = [], latest = null, plugins, claude, codex }) {
  if (!Array.isArray(runs) || runs.length === 0) {
    return {
      status: 'missing',
      reusable: false,
      run_id: null,
      artifact_pointer: null,
      reasons: ['no recorded runtime:doctor artifact'],
    };
  }
  const evaluated = runs.map((run) => evaluateRecordedDoctorProofRun({ run, plugins, claude, codex }));
  const reusable = evaluated.find((entry) => entry.reusable);
  if (reusable) return reusable;
  const latestRunId = latest?.run_id ?? runs[0]?.run_id;
  return evaluated.find((entry) => entry.run_id === latestRunId) ?? evaluated[0];
}

function evaluateRecordedDoctorProofRun({ run, plugins, claude, codex }) {
  const latestReport = run.report;
  const reasons = [];
  if (latestReport.runtime_version !== RUNTIME_VERSION) {
    reasons.push(`runtime version mismatch: recorded=${latestReport.runtime_version ?? '<unknown>'}, current=${RUNTIME_VERSION}`);
  }

  for (const name of PLUGIN_NAMES) {
    const current = summarizePluginVersions(plugins?.[name]);
    const recorded = summarizePluginVersions(latestReport.plugins?.[name]);
    for (const key of ['source', 'claude_cache', 'codex_installed']) {
      if (current[key] !== recorded[key]) {
        reasons.push(`${name} ${key} mismatch: recorded=${recorded[key] ?? '<unknown>'}, current=${current[key] ?? '<unknown>'}`);
      }
    }
  }

  const currentCliVersions = {
    claude: observedVersionText(claude.version),
    codex: observedVersionText(codex.version),
  };
  const recordedCliVersions = {
    claude: observedVersionText(latestReport.clis?.claude?.version),
    codex: observedVersionText(latestReport.clis?.codex?.version),
  };
  for (const name of ['claude', 'codex']) {
    if (currentCliVersions[name] !== recordedCliVersions[name]) {
      reasons.push(`${name} version mismatch: recorded=${recordedCliVersions[name] ?? '<unknown>'}, current=${currentCliVersions[name] ?? '<unknown>'}`);
    }
  }

  const permission = reusableProofSection(latestReport.permission_proof, run);
  const smoke = reusableProofSection(latestReport.deep_peer_smoke, run);
  const workflow = reusableProofSection(latestReport.workflow_continuation_proof, run);
  if (!permission) reasons.push('recorded permission proof is not passed');
  if (!smoke) reasons.push('recorded deep peer smoke is not passed');
  if (!workflow) reasons.push('recorded workflow continuation proof is not passed');

  const reusable = reasons.length === 0;
  return {
    status: reusable ? 'reusable' : 'not_reusable',
    reusable,
    run_id: run.run_id,
    artifact_pointer: run.artifact_pointer,
    selected_at: run.selected_at,
    reasons,
    permission_proof: reusable ? permission : null,
    deep_peer_smoke: reusable ? smoke : null,
    workflow_continuation_proof: reusable ? workflow : null,
  };
}

function summarizePluginVersions(plugin) {
  // ADR-0034 cross-script consumer (proof-reuse): derive the Codex installed
  // version from the list-authoritative resolver decision (single-sourced in
  // buildPluginMatrix) so a recorded proof's reusability tracks the authoritative
  // installed version, not a stale filesystem cache. Fall back to the cache only
  // when the list was unavailable (decision 'fallback') or the report predates
  // codex_resolved (legacy report). The derivation is symmetric — applied to both
  // the current and the recorded report at the call sites below — so a still-valid
  // recorded proof is not spuriously invalidated, while a real installed-version
  // change still invalidates it.
  const codexResolved = plugin?.installed?.codex_resolved;
  const codexInstalled = (!codexResolved || codexResolved.decision === 'fallback')
    ? (plugin?.cache?.codex?.latest?.manifest_version ?? null)
    : (codexResolved.version ?? null);
  return {
    source: plugin?.source?.claude_manifest?.version ?? null,
    claude_cache: plugin?.cache?.claude?.latest?.manifest_version ?? null,
    codex_installed: codexInstalled,
  };
}

function observedVersionText(version) {
  if (typeof version === 'string') return version;
  if (typeof version?.text === 'string' && version.text.length > 0) return version.text;
  return null;
}

function reusableProofSection(section, latest) {
  if (!section?.executed || section.status !== 'passed') return null;
  return {
    ...section,
    recorded: true,
    recorded_run_id: latest.run_id,
    recorded_artifact_pointer: latest.artifact_pointer,
  };
}

function emptySettingsPluginManagement() {
  return {
    mode: null,
    requested: false,
    executed: false,
    host_filter: null,
    summary: {
      executed: 0,
      failed: 0,
      failed_retryable: 0,
      failed_non_retryable: 0,
    },
    failed: 0,
    failures: [],
  };
}

function emptySettingsPluginCleanup() {
  return {
    mode: null,
    requested: false,
    executed: false,
    summary: {
      executed: 0,
      failed: 0,
      blocked: 0,
      failed_retryable: 0,
      failed_non_retryable: 0,
    },
    failed: 0,
    blocked: 0,
    failures: [],
  };
}

function emptySettingsCodexHookReview() {
  return {
    mode: null,
    requested: false,
    attested: false,
    status: 'not_recorded',
    host: 'codex',
    command: '/hooks',
    attested_at: null,
    bundled_plugins: [],
    plugin_versions: {},
    attested_plugins: [],
    bound_versions: { codex: null, plugins: { codex: {} } },
    artifact_hash: null,
  };
}

async function summarizeSettingsArtifact({ repoRoot, runId, artifactPath, artifact }) {
  // artifact_hash binds the attestation to the EXACT settings.json bytes on disk (owner
  // decision 2026-07-18): read the file, never re-serialize `artifact` — a reconstructed
  // summary can differ from the written bytes (key order, whitespace, escaping) and would
  // certify a file that never existed. The producer cannot self-hash (the attestation lives
  // inside these bytes), so the hash is computed here, read-time (§8.2).
  const rawArtifact = await readTextIfExists(artifactPath);
  const artifactHash = rawArtifact.ok ? sha256(rawArtifact.text) : null;
  const pluginManagement = artifact.plugin_management ?? {};
  const pluginManagementSummary = pluginManagement.summary ?? {};
  const pluginCleanup = artifact.plugin_cleanup ?? {};
  const pluginCleanupSummary = pluginCleanup.summary ?? {};
  const codexHookReview = artifact.codex_hook_review ?? {};
  const failures = Array.isArray(artifact.failures)
    ? artifact.failures.map((failure) => ({
        id: sanitizeValue(failure.id),
        area: sanitizeValue(failure.area),
        plugin: sanitizeValue(failure.plugin),
        host: sanitizeValue(failure.host),
        action: sanitizeValue(failure.action),
        failure_type: sanitizeValue(failure.failure_type),
        retryable: failure.retryable === true,
        retry_after: sanitizeValue(failure.retry_after),
        doctor_hint: sanitizeValue(failure.doctor_hint),
      }))
    : [];
  const pluginManagementFailures = failures.filter((failure) => failure.area !== 'plugin-cleanup');
  const pluginCleanupFailures = failures.filter((failure) => failure.area === 'plugin-cleanup');
  const selectedAt = artifactTimestampMs(artifact, runId);
  const runStatus = typeof artifact.status === 'string' ? artifact.status : 'blocked';
  return {
    run_id: sanitizeValue(artifact.run_id) ?? runId,
    status: runStatus,
    // A write-ahead record is nonterminal (planned / in-progress) precisely because
    // it has zero failures and HAS NOT FINISHED — the reader must never read it as a
    // clean run (machine-bootstrap-contract.md §1.5 part 3). `terminal` carries the
    // artifact's own flag when present, else derives it from the status.
    terminal: typeof artifact.terminal === 'boolean'
      ? artifact.terminal
      : !SETTINGS_EXECUTION_NONTERMINAL_STATUSES.has(runStatus),
    artifact_pointer: pointer(repoRoot, artifactPath),
    selected_at: selectedAt === null ? null : new Date(selectedAt).toISOString(),
    selected_at_ms: selectedAt ?? 0,
    plugin_management: {
      mode: sanitizeValue(pluginManagement.mode),
      requested: pluginManagement.requested === true,
      executed: pluginManagement.executed === true,
      host_filter: sanitizeValue(pluginManagement.host_filter),
      summary: {
        executed: safeCount(pluginManagementSummary.executed),
        failed: safeCount(pluginManagementSummary.failed),
        blocked: safeCount(pluginManagementSummary.blocked),
        failed_retryable: safeCount(pluginManagementSummary.failed_retryable),
        failed_non_retryable: safeCount(pluginManagementSummary.failed_non_retryable),
      },
      failed: safeCount(pluginManagementSummary.failed),
      blocked: safeCount(pluginManagementSummary.blocked),
      failures: pluginManagementFailures,
    },
    plugin_cleanup: {
      mode: sanitizeValue(pluginCleanup.mode),
      requested: pluginCleanup.requested === true,
      executed: pluginCleanup.executed === true,
      summary: {
        executed: safeCount(pluginCleanupSummary.executed),
        failed: safeCount(pluginCleanupSummary.failed),
        blocked: safeCount(pluginCleanupSummary.blocked),
        failed_retryable: safeCount(pluginCleanupSummary.failed_retryable),
        failed_non_retryable: safeCount(pluginCleanupSummary.failed_non_retryable),
      },
      failed: safeCount(pluginCleanupSummary.failed),
      blocked: safeCount(pluginCleanupSummary.blocked),
      failures: pluginCleanupFailures,
    },
    codex_hook_review: {
      run_id: sanitizeValue(artifact.run_id) ?? runId,
      mode: sanitizeValue(codexHookReview.mode),
      requested: codexHookReview.requested === true,
      attested: codexHookReview.attested === true,
      status: sanitizeValue(codexHookReview.status) ?? 'not_recorded',
      host: sanitizeValue(codexHookReview.host) ?? 'codex',
      command: sanitizeValue(codexHookReview.command) ?? '/hooks',
      attested_at: sanitizeValue(codexHookReview.attested_at),
      bundled_plugins: Array.isArray(codexHookReview.bundled_plugins) ? uniqueStrings(codexHookReview.bundled_plugins.map((value) => sanitizeValue(value)).filter(Boolean)).sort() : [],
      manifest_exposed_plugins: Array.isArray(codexHookReview.manifest_exposed_plugins) ? uniqueStrings(codexHookReview.manifest_exposed_plugins.map((value) => sanitizeValue(value)).filter(Boolean)).sort() : [],
      plugin_versions: sanitizeStringMap(codexHookReview.plugin_versions),
      // Canonical fields (§8.2, S8a4) — carried so the currency mirror can read the same
      // shape the completion reducer re-validates. A pre-S8a4 artifact has neither, which the
      // mirror correctly reads as a legacy attestation that can only be stale until re-recorded.
      // The set this attestation covers. A pre-S8a4 artifact has no attested_plugins, so
      // fall back to bundled_plugins — the set legacy recorded — rather than an empty set,
      // which would make the mirror read a version drift as a plugin-SET change instead.
      attested_plugins: Array.isArray(codexHookReview.attested_plugins)
        ? uniqueStrings(codexHookReview.attested_plugins.map((value) => sanitizeValue(value)).filter(Boolean)).sort()
        : (Array.isArray(codexHookReview.bundled_plugins)
            ? uniqueStrings(codexHookReview.bundled_plugins.map((value) => sanitizeValue(value)).filter(Boolean)).sort()
            : []),
      bound_versions: {
        codex: typeof codexHookReview.bound_versions?.codex === 'string' ? sanitizeValue(codexHookReview.bound_versions.codex) : null,
        plugins: { codex: sanitizeStringMap(codexHookReview.bound_versions?.plugins?.codex) },
      },
      plugin_hooks_enabled: codexHookReview.plugin_hooks_enabled === true,
      plugin_hooks_stage: sanitizeValue(codexHookReview.plugin_hooks_stage),
      artifact_pointer: pointer(repoRoot, artifactPath),
      artifact_hash: artifactHash,
    },
  };
}

function permissionDiagnosisLimits(capNote) {
  const limits = [
    'runtime:doctor permission diagnosis is read-only (R0): it classifies prompt-shaped tool calls observed in usage records and recommends/writes no host config — runtime:settings emits the host-config plan (M1).',
    'Reported counts are prompt-SHAPED candidates, not a claim each one prompted: user-rejected calls (Claude interrupt / Codex approval) are the definite "this prompted" signal, and runtime:settings cross-references the host allowlist (which doctor does not read here) to recommend only not-yet-allowed rules.',
    'Diagnosis reads usage-record bodies but retains only generalized command patterns and counts (ADR-0038 §5); raw commands, arguments, and source paths are never surfaced.',
    'With --record, the sanitized diagnosis is included in the doctor proof snapshot under .agentic-plugins/runs/doctor (ADR-0038 §5 owned artifact, explicit opt-in); the permission-family artifact under .agentic-plugins/runs/permission is written only by runtime:settings (M1).',
  ];
  if (capNote) limits.push(capNote);
  return limits;
}

// User-rejected count parsed from the learner's evidence note ("seen Nx,
// M user-rejected") — the definite "this prompted" signal surfaced structurally
// so the section reports candidates vs confirmed prompts honestly (Plan-verify
// peer MAJOR — avoid over-claiming without re-reading the host allowlist here).
function rejectedFromNote(note) {
  if (typeof note !== 'string') return 0;
  const m = note.match(/(\d+)\s+user-rejected/);
  return m ? Number(m[1]) : 0;
}

// R0 permission diagnosis: enumerate usage records, learn prompt-cause evidence,
// and report it classified by host x mechanism — sanitized, pointer-only,
// mutating nothing (ADR-0038 §1/§7). Evidence is shaped through an in-memory
// permission-advisory artifact (surface=doctor) purely to reuse the slice's
// sanitization (drops source paths, host-scopes, strict shape); nothing is
// written to disk — the M1 artifact write belongs to runtime:settings.
async function inspectPermissionDiagnosis({ homeDir, env, now, maxFiles, maxFileBytes }) {
  const emptyHost = { found: 0, used: 0, scan_truncated: false, skipped_too_large: 0 };
  let collected;
  try {
    collected = await collectUsageRecordSources({ homeDir, env, maxFiles, maxFileBytes });
  } catch (err) {
    return {
      requested: true,
      executed: true,
      status: 'blocked',
      error: err.code ?? err.message,
      hosts: [],
      sources_scanned: { claude: { ...emptyHost }, codex: { ...emptyHost }, capped: false },
      by_cause: [],
      top_patterns: [],
      mode_postures: [],
      baseline_used: true,
      limits: permissionDiagnosisLimits(null),
    };
  }

  const { sources, scanned, capped } = collected;
  const hosts = [...new Set(sources.map((s) => s.host))];
  const notes = [];
  if (capped) notes.push(`per-host file cap (${maxFiles}) reached — only the most-recent records were analyzed`);
  if (scanned.claude.scan_truncated || scanned.codex.scan_truncated) {
    notes.push(`directory scan hit the ${PERMISSION_DIAGNOSIS_MAX_SCAN}-entry per-host safety budget — results may be partial`);
  }
  if (scanned.claude.skipped_too_large || scanned.codex.skipped_too_large) {
    notes.push(`skipped oversized records above the per-file byte cap (claude ${scanned.claude.skipped_too_large}, codex ${scanned.codex.skipped_too_large})`);
  }
  const capNote = notes.length ? `${notes.join('; ')}.` : null;
  const sourcesScanned = { ...scanned, capped };

  if (hosts.length === 0) {
    return {
      requested: true,
      executed: true,
      status: 'no_records',
      hosts: [],
      sources_scanned: sourcesScanned,
      by_cause: [],
      top_patterns: [],
      mode_postures: [],
      baseline_used: true,
      limits: permissionDiagnosisLimits(capNote),
    };
  }

  const learner = learnFromSources(sources);
  const artifact = makePermissionAdvisoryArtifact({
    runId: makePermissionRunId(now),
    surface: 'doctor',
    hosts,
    evidence: learner,
    createdAt: now.toISOString(),
  });
  const ev = artifact.evidence;

  const byCauseMap = new Map();
  for (const rule of ev.rules) {
    const key = `${rule.host}|${rule.cause}`;
    const cur = byCauseMap.get(key) || { host: rule.host, cause: rule.cause, rule_count: 0, seen_total: 0, rejected_total: 0 };
    cur.rule_count += 1;
    cur.seen_total += rule.evidence.count;
    cur.rejected_total += rejectedFromNote(rule.evidence.note);
    byCauseMap.set(key, cur);
  }
  const byCause = [...byCauseMap.values()]
    .map((c) => {
      const cause = getPromptCause(c.cause);
      return { ...c, mechanism: cause ? cause.mechanism : null, title: cause ? cause.title : null };
    })
    // Definite prompts (user-rejected) first, then most-seen — surfaces the
    // strongest signal at the top without re-reading the host allowlist.
    .sort((a, b) => b.rejected_total - a.rejected_total || b.seen_total - a.seen_total || a.host.localeCompare(b.host));

  const topPatterns = ev.rules
    .slice()
    .sort((a, b) => b.evidence.count - a.evidence.count || a.id.localeCompare(b.id))
    .slice(0, PERMISSION_DIAGNOSIS_TOP_PATTERNS)
    .map((r) => ({ host: r.host, cause: r.cause, pattern: r.pattern, grade: r.grade, count: r.evidence.count, rejected: rejectedFromNote(r.evidence.note), note: r.evidence.note }));

  const modePostures = ev.mode_evidence.map((m) => {
    const cause = getPromptCause(m.cause);
    return { host: m.host, cause: m.cause, title: cause ? cause.title : null, count: m.count };
  });

  return {
    requested: true,
    executed: true,
    status: artifact.status,
    hosts,
    sources_scanned: sourcesScanned,
    by_cause: byCause,
    top_patterns: topPatterns,
    mode_postures: modePostures,
    baseline_used: ev.baseline_used,
    limits: permissionDiagnosisLimits(capNote),
  };
}

function buildReadiness({
  claude,
  codex,
  companion,
  deepPeerSmoke,
  executeDeepPeerSmoke,
  sandboxPermissionProbe,
  permissionProof,
  executePermissionProof,
  workflowContinuationProof,
  executeWorkflowContinuationProof,
}) {
  return {
    claude_to_codex: buildDirectionReadiness({
      direction: 'Claude -> Codex',
      caller: claude,
      peer: codex,
      companion: companion.directions.claude_to_codex,
      requiredPeerFeatures: ['exec_command', 'model_flag', 'config_flag', 'cd_flag'],
      requiredPermissionFeatures: ['sandbox_flag', 'approval_flag'],
      deepPeerSmoke,
      executeDeepPeerSmoke,
      sandboxPermissionProbe,
      permissionProof,
      executePermissionProof,
      workflowContinuationProof,
      executeWorkflowContinuationProof,
    }),
    codex_to_claude: buildDirectionReadiness({
      direction: 'Codex -> Claude',
      caller: codex,
      peer: claude,
      companion: companion.directions.codex_to_claude,
      requiredPeerFeatures: ['print_mode', 'no_session_persistence', 'model_flag', 'effort_flag'],
      requiredPermissionFeatures: ['permission_mode'],
      deepPeerSmoke,
      executeDeepPeerSmoke,
      sandboxPermissionProbe,
      permissionProof,
      executePermissionProof,
      workflowContinuationProof,
      executeWorkflowContinuationProof,
    }),
  };
}

function buildReadinessMatrix({
  claude,
  codex,
  plugins,
  codexPluginHooks,
  companion,
  modelEffort,
  readiness,
  permissionProof,
  deepPeerSmoke,
  workflowContinuationProof,
}) {
  const runtimePlugin = plugins.runtime;
  return {
    schema_version: 'runtime-readiness-matrix-1.0',
    hosts: {
      claude: buildHostReadinessRow({
        host: 'claude',
        cli: claude,
        plugin: runtimePlugin,
        modelEffort: modelEffort.directions.codex_to_claude,
        hooks: {
          automatic_plugin_hooks: Boolean(claude.feature_surface.automatic_plugin_hooks),
          plugin_local_hooks: Boolean(claude.feature_surface.automatic_plugin_hooks),
          evidence: 'Claude plugin hooks are a host-native plugin surface',
        },
      }),
      codex: buildHostReadinessRow({
        host: 'codex',
        cli: codex,
        plugin: runtimePlugin,
        modelEffort: modelEffort.directions.claude_to_codex,
        hooks: {
          global_hooks: codex.feature_surface.codex_global_hooks,
          global_hooks_stage: codex.feature_surface.codex_global_hooks_stage,
          plugin_local_hooks: codex.feature_surface.codex_plugin_hooks,
          plugin_local_hooks_stage: codex.feature_surface.codex_plugin_hooks_stage,
          automatic_plugin_hooks: Boolean(codex.feature_surface.automatic_plugin_hooks),
          packaging_status: codexPluginHooks.status,
          bundled_plugins: codexPluginHooks.summary.bundled_plugins,
          manifest_exposed_plugins: codexPluginHooks.summary.manifest_exposed_plugins,
          default_file_only_plugins: codexPluginHooks.summary.default_file_only_plugins,
          evidence: 'Codex generic hooks, plugin_hooks feature flag, and plugin hook packaging are reported separately',
        },
      }),
    },
    directions: {
      claude_to_codex: buildDirectionReadinessRow({
        key: 'claude_to_codex',
        caller: 'claude',
        peer: 'codex',
        readiness: readiness.claude_to_codex,
        companion: companion.directions.claude_to_codex,
        modelEffort: modelEffort.directions.claude_to_codex,
        permissionProof,
        deepPeerSmoke,
        workflowContinuationProof,
      }),
      codex_to_claude: buildDirectionReadinessRow({
        key: 'codex_to_claude',
        caller: 'codex',
        peer: 'claude',
        readiness: readiness.codex_to_claude,
        companion: companion.directions.codex_to_claude,
        modelEffort: modelEffort.directions.codex_to_claude,
        permissionProof,
        deepPeerSmoke,
        workflowContinuationProof,
      }),
    },
    limits: [
      'installed distinguishes host plugin/cache evidence from repo source availability',
      'model and effort are direction-specific peer invocation inputs, not proof of host-native defaults',
      'Codex generic hooks, plugin_hooks enablement, hook trust, and manifest hook packaging are separate readiness questions',
      'execution_readiness is explicit companion executor evidence and is separate from host auth status',
    ],
  };
}

function buildExperienceParity({
  readinessMatrix,
  pluginCommandSurface,
  codexPluginHooks,
  companion,
  readiness,
  ledgers,
  settingsRuns,
  consensusRuns,
  compatRuns,
  permissionProof,
  deepPeerSmoke,
  workflowContinuationProof,
  recordedDoctorProof,
}) {
  const criteria = [
    buildHostPluginExperienceCriterion(readinessMatrix),
    buildPluginCommandExperienceCriterion(pluginCommandSurface),
    buildCompanionExperienceCriterion(companion),
    buildPeerExecutionExperienceCriterion({ readiness, permissionProof, deepPeerSmoke, recordedDoctorProof }),
    buildEngineerWorkflowExecutionExperienceCriterion({ readiness, workflowContinuationProof, recordedDoctorProof }),
    buildWorkflowContinuityExperienceCriterion(ledgers),
    buildLifecycleHookExperienceCriterion({ codexPluginHooks, pluginCommandSurface }),
    buildRuntimeArtifactExperienceCriterion({ settingsRuns, consensusRuns, compatRuns }),
  ];
  const totalWeight = criteria.reduce((sum, item) => sum + item.weight, 0);
  const earnedWeight = criteria.reduce((sum, item) => sum + item.earned_weight, 0);
  const counts = {
    satisfied: criteria.filter((item) => item.status === 'satisfied').length,
    partial: criteria.filter((item) => item.status === 'partial').length,
    not_verified: criteria.filter((item) => item.status === 'not_verified').length,
    blocked: criteria.filter((item) => item.status === 'blocked').length,
  };
  const nextActions = buildExperienceParityNextActions(criteria, pluginCommandSurface.manual_followups);
  return {
    schema_version: 'runtime-experience-parity-1.0',
    status: counts.blocked > 0
      ? 'blocked'
      : counts.partial > 0 || counts.not_verified > 0
        ? 'partial'
        : 'ready',
    score_percent: totalWeight === 0 ? 0 : Math.round((earnedWeight / totalWeight) * 100),
    weight: {
      earned: earnedWeight,
      total: totalWeight,
    },
    counts,
    criteria,
    manual_followup_count: pluginCommandSurface.manual_followups?.length ?? 0,
    next_actions: nextActions,
    limits: [
      'This score is an observed runtime experience-readiness summary, not a declaration that the overall project goal is complete.',
      'Manual follow-ups and not-requested peer executors deliberately reduce the score until verified in the active host session.',
      'Codex hook review/trust state is not host-verifiable here; /hooks remains an explicit operator check unless a current runtime:settings operator attestation artifact is present.',
    ],
  };
}

function buildHostPluginExperienceCriterion(readinessMatrix) {
  const claude = readinessMatrix.hosts.claude.installed;
  const codex = readinessMatrix.hosts.codex.installed;
  const statuses = [claude.status, codex.status];
  if (statuses.every((status) => status === 'installed')) {
    return parityCriterion({
      id: 'host_plugin_availability',
      label: 'Runtime plugin available in both hosts',
      status: 'satisfied',
      weight: 15,
      evidence: `claude=${claude.status}/${claude.version ?? 'unknown'}, codex=${codex.status}/${codex.version ?? 'unknown'}`,
      next_step: null,
    });
  }
  const blocked = statuses.some((status) => ['blocked', 'not_installed'].includes(status));
  return parityCriterion({
    id: 'host_plugin_availability',
    label: 'Runtime plugin available in both hosts',
    status: blocked ? 'blocked' : 'partial',
    weight: 15,
    evidence: `claude=${claude.status}/${claude.version ?? 'unknown'}, codex=${codex.status}/${codex.version ?? 'unknown'}`,
    next_step: 'Install/update runtime in the host that lacks installed cache evidence, then rerun runtime:doctor.',
  });
}

function buildPluginCommandExperienceCriterion(pluginCommandSurface) {
  const followups = pluginCommandSurface.manual_followups ?? [];
  const commandModes = `claude=${pluginCommandSurface.claude.mode}, codex=${pluginCommandSurface.codex.mode}`;
  if (followups.length === 0) {
    return parityCriterion({
      id: 'plugin_management_followups',
      label: 'Host plugin management gaps are either resolved or not required',
      status: 'satisfied',
      weight: 10,
      evidence: `${commandModes}; manual-followups=0`,
      next_step: null,
    });
  }
  const hookReviewFollowup = followups.find((item) => item.id === 'codex-hook-review');
  return parityCriterion({
    id: 'plugin_management_followups',
    label: 'Host plugin management gaps are visible as operator follow-ups',
    status: 'partial',
    weight: 10,
    evidence: `${commandModes}; manual-followups=${followups.map((item) => `${item.host}:${item.id}`).join(',')}`,
    next_step: hookReviewFollowup
      ? hookReviewFollowup.verify
      : 'Complete the listed Manual Follow-ups in the relevant host session and rerun runtime:doctor.',
  });
}

function buildCompanionExperienceCriterion(companion) {
  const directions = [companion.directions.claude_to_codex, companion.directions.codex_to_claude];
  const unavailable = directions.filter((direction) => direction.status !== 'available');
  return parityCriterion({
    id: 'bidirectional_companion_contract',
    label: 'Opposite-host companion contract is available both directions',
    status: unavailable.length === 0 ? 'satisfied' : 'blocked',
    weight: 15,
    evidence: directions.map((direction) => `${direction.label}=${direction.status}/contract=${direction.selected?.contract_version ?? 'unknown'}`).join(', '),
    next_step: unavailable.length === 0 ? null : 'Repair companion script discovery or contract compatibility before relying on cross-host handoff.',
  });
}

function buildPeerExecutionExperienceCriterion({ readiness, permissionProof, deepPeerSmoke, recordedDoctorProof }) {
  const blocked = Object.values(readiness).some((direction) => !['available', 'available_with_warnings'].includes(direction.status));
  if (blocked) {
    return parityCriterion({
      id: 'bidirectional_peer_execution',
      label: 'Bidirectional peer execution has no readiness blockers',
      status: 'blocked',
      weight: 15,
      evidence: Object.values(readiness).map((direction) => `${direction.direction}=${direction.status}`).join(', '),
      next_step: 'Resolve readiness blockers, then rerun runtime:doctor with explicit peer execution proof.',
    });
  }
  const effectivePermissionProof = permissionProof?.executed ? permissionProof : recordedDoctorProof?.permission_proof;
  const effectiveDeepPeerSmoke = deepPeerSmoke?.executed ? deepPeerSmoke : recordedDoctorProof?.deep_peer_smoke;
  const proofPassed = effectivePermissionProof?.executed && effectivePermissionProof.status === 'passed';
  const smokePassed = effectiveDeepPeerSmoke?.executed && effectiveDeepPeerSmoke.status === 'passed';
  if (proofPassed && smokePassed) {
    const source = effectivePermissionProof?.recorded || effectiveDeepPeerSmoke?.recorded
      ? `recorded-doctor=${recordedDoctorProof.run_id}`
      : 'current-run';
    return parityCriterion({
      id: 'bidirectional_peer_execution',
      label: 'Bidirectional peer execution is explicitly verified',
      status: 'satisfied',
      weight: 15,
      evidence: `permission-proof=${effectivePermissionProof.status}, deep-peer-smoke=${effectiveDeepPeerSmoke.status}; source=${source}`,
      next_step: null,
    });
  }
  const operatorAction = [permissionProof, deepPeerSmoke].some((section) => section?.executed && section.status === 'operator_action_required');
  return parityCriterion({
    id: 'bidirectional_peer_execution',
    label: 'Bidirectional peer execution is ready but not fully verified',
    status: operatorAction ? 'partial' : 'not_verified',
    weight: 15,
    evidence: `permission-proof=${permissionProof?.status ?? 'not_requested'}/${permissionProof?.executed ?? false}, deep-peer-smoke=${deepPeerSmoke?.status ?? 'not_requested'}/${deepPeerSmoke?.executed ?? false}; recorded-doctor=${recordedDoctorProof?.status ?? 'missing'}`,
    next_step: 'Run runtime:doctor with --permission-proof --execute-permission-proof --deep-peer-smoke --execute-deep-peer-smoke --record to refresh reusable execution evidence.',
  });
}

function buildEngineerWorkflowExecutionExperienceCriterion({ readiness, workflowContinuationProof, recordedDoctorProof }) {
  const blocked = Object.values(readiness).some((direction) => !['available', 'available_with_warnings'].includes(direction.status));
  if (blocked) {
    return parityCriterion({
      id: 'engineer_workflow_continuation_execution',
      label: 'Engineer workflow continuation is verified through dispatch and state',
      status: 'blocked',
      weight: 15,
      evidence: Object.values(readiness).map((direction) => `${direction.direction}=${direction.status}`).join(', '),
      next_step: 'Resolve readiness blockers, then rerun runtime:doctor with explicit workflow continuation proof.',
    });
  }
  const effectiveWorkflowProof = workflowContinuationProof?.executed
    ? workflowContinuationProof
    : recordedDoctorProof?.workflow_continuation_proof;
  const passed = effectiveWorkflowProof?.executed && effectiveWorkflowProof.status === 'passed';
  if (passed) {
    const source = effectiveWorkflowProof?.recorded ? `recorded-doctor=${recordedDoctorProof.run_id}` : 'current-run';
    return parityCriterion({
      id: 'engineer_workflow_continuation_execution',
      label: 'Engineer workflow continuation is verified through dispatch and state',
      status: 'satisfied',
      weight: 15,
      evidence: `workflow-continuation-proof=${effectiveWorkflowProof.status}; source=${source}`,
      next_step: null,
    });
  }
  const operatorAction = workflowContinuationProof?.executed && workflowContinuationProof.status === 'operator_action_required';
  return parityCriterion({
    id: 'engineer_workflow_continuation_execution',
    label: 'Engineer workflow continuation is ready but not verified',
    status: operatorAction ? 'partial' : 'not_verified',
    weight: 15,
    evidence: `workflow-continuation-proof=${workflowContinuationProof?.status ?? 'not_requested'}/${workflowContinuationProof?.executed ?? false}; recorded-doctor=${recordedDoctorProof?.status ?? 'missing'}`,
    next_step: 'Run runtime:doctor with --workflow-continuation-proof --execute-workflow-continuation-proof --record to prove engineer state and dispatch continuation from current hosts.',
  });
}

function buildWorkflowContinuityExperienceCriterion(ledgers) {
  const entries = Object.entries(ledgers);
  const blocked = entries.filter(([, ledger]) => (
    ['blocked', 'ambiguous', 'migration_blocked'].includes(ledger.storage.status) ||
    ledger.workflows.status === 'blocked' ||
    ledger.peer_runs.status === 'blocked'
  ));
  if (blocked.length > 0) {
    return parityCriterion({
      id: 'workflow_continuity_storage',
      label: 'Shared workflow continuity storage is safe to read',
      status: 'blocked',
      weight: 15,
      evidence: entries.map(([name, ledger]) => `${name}=storage:${ledger.storage.status}/workflows:${ledger.workflows.status}/peer-runs:${ledger.peer_runs.status}`).join(', '),
      next_step: 'Resolve malformed or ambiguous workflow/peer-run state before relying on cross-host continuation.',
    });
  }
  const legacy = entries.filter(([, ledger]) => ledger.storage.status === 'legacy');
  return parityCriterion({
    id: 'workflow_continuity_storage',
    label: 'Shared workflow continuity storage is safe to read',
    status: legacy.length > 0 ? 'partial' : 'satisfied',
    weight: 15,
    evidence: entries.map(([name, ledger]) => `${name}=storage:${ledger.storage.status}/workflows:${ledger.workflows.status}/peer-runs:${ledger.peer_runs.status}`).join(', '),
    next_step: legacy.length > 0 ? 'Migrate legacy workflow state into .agentic-plugins/state when ready.' : null,
  });
}

function buildLifecycleHookExperienceCriterion({ codexPluginHooks, pluginCommandSurface }) {
  const hookFollowup = (pluginCommandSurface.manual_followups ?? []).find((item) => item.id === 'codex-hook-review');
  if (codexPluginHooks.status === 'packaging_gap') {
    return parityCriterion({
      id: 'lifecycle_hook_continuity',
      label: 'Lifecycle hooks are packaged for cross-host continuity',
      status: 'blocked',
      weight: 15,
      evidence: `codex-plugin-hooks=${codexPluginHooks.status}; default-file-only=${codexPluginHooks.summary.default_file_only_plugins.join(',') || 'none'}; missing-file=${codexPluginHooks.summary.missing_hooks_file_plugins.join(',') || 'none'}`,
      next_step: 'Expose bundled hooks in each hook-bearing Codex plugin manifest and package hooks/hooks.json.',
    });
  }
  // Command-portability warnings gate this criterion (refine-verify
  // finding): a bundled hook whose commands are Claude-adapter-shaped or
  // rely on a bare `node` is surfaced by Codex but may not RUN there, so
  // "continuity" cannot be scored satisfied on packaging + trust alone —
  // otherwise a fresh attestation would silently launder the warning into
  // a 100% parity score.
  const commandWarningPlugins = codexPluginHooks.summary.command_warning_plugins ?? [];
  if (codexPluginHooks.status === 'ready' && !hookFollowup && commandWarningPlugins.length === 0) {
    return parityCriterion({
      id: 'lifecycle_hook_continuity',
      label: 'Lifecycle hooks are packaged and enabled',
      status: 'satisfied',
      weight: 15,
      evidence: `codex-plugin-hooks=${codexPluginHooks.status}; bundled=${codexPluginHooks.summary.bundled_plugins.join(',') || 'none'}`,
      next_step: null,
    });
  }
  return parityCriterion({
    id: 'lifecycle_hook_continuity',
    label: 'Lifecycle hooks are packaged but still require host-specific confirmation',
    status: 'partial',
    weight: 15,
    evidence: `codex-plugin-hooks=${codexPluginHooks.status}; bundled=${codexPluginHooks.summary.bundled_plugins.join(',') || 'none'}; manual-hook-review=${Boolean(hookFollowup)}; command-warnings=${commandWarningPlugins.join(',') || 'none'}`,
    next_step: hookFollowup
      ? hookFollowup.verify
      : commandWarningPlugins.length > 0
        ? `Hook commands for ${commandWarningPlugins.join(', ')} carry portability warnings (Claude-adapter paths / bare node) — ship portable command wrappers (or resolve the package posture per plugins/runtime/docs/follow-ups.md) before scoring lifecycle continuity satisfied.`
        : 'Enable the stage-appropriate Codex hook gate manually (generic [features].hooks on current Codex; [features].plugin_hooks on legacy Codex < ~0.134 — runtime does not write Codex host config per ADR-0035 §6) or restore hook packaging, then rerun runtime:doctor.',
  });
}

function buildRuntimeArtifactExperienceCriterion({ settingsRuns, consensusRuns, compatRuns }) {
  const status = `settings=${settingsRuns.status}, consensus=${consensusRuns.status}, compat=${compatRuns.status}`;
  if (settingsRuns.status === 'blocked' || consensusRuns.status === 'blocked' || ['blocked', 'release_notes_required'].includes(compatRuns.status)) {
    return parityCriterion({
      id: 'runtime_handoff_artifacts',
      label: 'Runtime execution and compatibility artifacts are readable for handoff and comparison',
      status: 'blocked',
      weight: 15,
      evidence: status,
      next_step: compatRuns.status === 'release_notes_required'
        ? compatRuns.latest?.next_steps?.[0] ?? 'Ingest content-backed release notes for the latest runtime:compat run before relying on host compatibility.'
        : 'Repair malformed runtime artifacts before relying on handoff, consensus, and compatibility history.',
    });
  }
  const missing = [settingsRuns.status, consensusRuns.status, compatRuns.status].some((value) => value === 'missing');
  const needsAttention = ['empty', 'needs_attention'].includes(compatRuns.status);
  return parityCriterion({
    id: 'runtime_handoff_artifacts',
    label: 'Runtime execution and compatibility artifacts are readable for handoff and comparison',
    status: missing || needsAttention ? 'partial' : 'satisfied',
    weight: 15,
    evidence: `${status}; latest-settings=${settingsRuns.latest?.run_id ?? 'none'}; latest-consensus=${consensusRuns.latest?.run_id ?? 'none'}; latest-compat=${compatRuns.latest?.run_id ?? 'none'}`,
    next_step: missing || needsAttention
      ? compatRuns.latest?.next_steps?.[0] ?? 'Run settings/consensus/compat flows when needed so future host handoffs have artifact evidence.'
      : null,
  });
}

function parityCriterion({ id, label, status, weight, evidence, next_step }) {
  return {
    id,
    label,
    status,
    weight,
    earned_weight: earnedParityWeight(status, weight),
    evidence,
    next_step,
  };
}

function earnedParityWeight(status, weight) {
  if (status === 'satisfied') return weight;
  if (status === 'partial') return Math.ceil(weight * 0.6);
  if (status === 'not_verified') return Math.ceil(weight * 0.4);
  return 0;
}

function buildExperienceParityNextActions(criteria, manualFollowups = []) {
  const actions = [];
  for (const followup of manualFollowups) {
    actions.push({
      source: 'manual_followup',
      id: followup.id,
      host: followup.host,
      commands: followup.commands ?? [],
      reason: followup.verify ?? followup.reason,
    });
  }
  for (const item of criteria) {
    if (item.status === 'satisfied' || !item.next_step) continue;
    actions.push({
      source: 'criterion',
      id: item.id,
      host: 'both',
      commands: [],
      reason: item.next_step,
    });
  }
  return actions;
}

function buildHostReadinessRow({ host, cli, plugin, modelEffort, hooks }) {
  return {
    host,
    available: {
      status: cli.status,
      version: cli.version.text || null,
      command_status: cli.version.status,
    },
    installed: summarizeRuntimeInstallForHost(host, plugin, {
      perPluginSurface: host === 'codex' && Boolean(cli.feature_surface?.plugin_install_command),
    }),
    authenticated: {
      status: cli.auth.status,
      method: cli.auth.method ?? null,
      provider: cli.auth.provider ?? null,
      subscription: cli.auth.subscription ?? null,
    },
    model_when_peer: {
      value: modelEffort.model.value,
      source: modelEffort.model.source,
    },
    effort_when_peer: {
      value: modelEffort.effort.value,
      source: modelEffort.effort.source,
    },
    hooks,
  };
}

function summarizeRuntimeInstallForHost(host, plugin, { perPluginSurface = false } = {}) {
  const sourceVersion = plugin.source?.claude_manifest?.version ?? plugin.source?.codex_manifest?.version ?? null;
  if (host === 'claude') {
    const installed = plugin.installed.claude_plugin_list;
    if (installed?.status === 'enabled') {
      return {
        status: 'installed',
        evidence: 'claude plugin list reports enabled',
        version: installed.version ?? plugin.cache.claude.latest?.manifest_version ?? sourceVersion,
      };
    }
    if (installed?.status === 'failed') {
      return {
        status: 'blocked',
        evidence: 'claude plugin list reports failed',
        version: installed.version ?? plugin.cache.claude.latest?.manifest_version ?? sourceVersion,
        error: installed.error ?? null,
      };
    }
    if (plugin.cache.claude.status === 'available') {
      return {
        status: 'installed',
        evidence: 'claude plugin cache contains runtime',
        version: plugin.cache.claude.latest?.manifest_version ?? sourceVersion,
      };
    }
    if (plugin.source?.present) {
      return {
        status: 'source_available',
        evidence: 'repo source tree contains runtime; host install not proven',
        version: sourceVersion,
      };
    }
    return { status: 'not_installed', evidence: 'no claude plugin list, cache, or source evidence', version: null };
  }

  // Codex: list-authoritative (ADR-0034). When `codex plugin list --json`
  // succeeded, trust it over the filesystem cache; only fall through to
  // cache evidence when the list was unavailable (older Codex / nonzero exit /
  // parse error). Materialization stays cache-derived — "installed per list but
  // cache not yet materialized" is a coherent, non-contradictory sub-state.
  const codexResolved = plugin.installed.codex_resolved;
  if (codexResolved?.decision === 'installed') {
    return {
      status: 'installed',
      evidence: codexResolved.evidence,
      version: codexResolved.version ?? plugin.cache.codex.latest?.manifest_version ?? sourceVersion,
      materialization: buildCodexCacheMaterialization(plugin, { perPluginSurface }),
    };
  }
  if (codexResolved?.decision === 'disabled') {
    return {
      status: 'blocked',
      evidence: codexResolved.evidence,
      version: codexResolved.version ?? plugin.cache.codex.latest?.manifest_version ?? sourceVersion,
      materialization: buildCodexCacheMaterialization(plugin, { perPluginSurface }),
    };
  }
  if (codexResolved?.decision === 'not_installed') {
    return {
      status: 'not_installed',
      evidence: codexResolved.evidence,
      version: null,
      materialization: buildCodexCacheMaterialization(plugin, { perPluginSurface }),
    };
  }

  if (plugin.cache.codex.status === 'available') {
    return {
      status: 'installed',
      evidence: 'codex plugin cache contains runtime',
      version: plugin.cache.codex.latest?.manifest_version ?? sourceVersion,
      materialization: buildCodexCacheMaterialization(plugin, { perPluginSurface }),
    };
  }
  if (plugin.source?.present) {
    return {
      status: 'source_available',
      evidence: 'repo source tree contains runtime; host install not proven',
      version: sourceVersion,
      materialization: buildCodexCacheMaterialization(plugin, { perPluginSurface }),
    };
  }
  if (plugin.cache.codex_tmp_marketplace.status === 'available') {
    return {
      status: 'marketplace_cache_only',
      evidence: 'codex temporary marketplace cache is not installation evidence',
      version: plugin.cache.codex_tmp_marketplace.manifest_version ?? null,
      materialization: buildCodexCacheMaterialization(plugin, { perPluginSurface }),
    };
  }
  return {
    status: 'not_installed',
    evidence: 'no codex install cache or source evidence',
    version: null,
    materialization: buildCodexCacheMaterialization(plugin),
  };
}

function buildCodexCacheMaterialization(plugin, { perPluginSurface = false } = {}) {
  const installCache = plugin?.cache?.codex ?? {};
  const marketplaceCache = plugin?.cache?.codex_tmp_marketplace ?? {};
  const installVersion = installCache.latest?.manifest_version ?? null;
  const marketplaceVersion = marketplaceCache.manifest_version ?? null;
  if (installCache.status === 'available') {
    return {
      status: 'materialized',
      executable_by_settings: false,
      install_cache_status: installCache.status,
      install_cache_version: installVersion,
      marketplace_cache_status: marketplaceCache.status ?? 'unknown',
      marketplace_cache_version: marketplaceVersion,
      source_available: Boolean(plugin?.source?.present),
      reason: 'Codex per-plugin install cache exists for runtime.',
      next_step: null,
    };
  }
  if (marketplaceCache.status === 'available') {
    return {
      status: 'manual_session_refresh',
      executable_by_settings: false,
      install_cache_status: installCache.status ?? 'unknown',
      install_cache_version: installVersion,
      marketplace_cache_status: marketplaceCache.status,
      marketplace_cache_version: marketplaceVersion,
      source_available: Boolean(plugin?.source?.present),
      reason: 'Codex marketplace cache is present, but no per-plugin install cache exists yet.',
      next_step: perPluginSurface
        ? 'Run `codex plugin add runtime@agentic-plugins` (runtime recognizes but does not auto-execute it) or start a fresh Codex session, then re-run runtime:doctor to verify cache materialization.'
        : 'Start a fresh Codex session or invoke the plugin surface after marketplace refresh, then re-run runtime:doctor to verify cache materialization.',
    };
  }
  return {
    status: 'not_available',
    executable_by_settings: false,
    install_cache_status: installCache.status ?? 'unknown',
    install_cache_version: installVersion,
    marketplace_cache_status: marketplaceCache.status ?? 'unknown',
    marketplace_cache_version: marketplaceVersion,
    source_available: Boolean(plugin?.source?.present),
    reason: 'Codex has neither per-plugin install cache nor temporary marketplace cache evidence for runtime.',
    next_step: 'Use runtime:settings to add or upgrade the Codex marketplace before expecting plugin cache materialization.',
  };
}

function buildDirectionReadinessRow({ key, caller, peer, readiness, companion, modelEffort, permissionProof, deepPeerSmoke, workflowContinuationProof }) {
  return {
    key,
    direction: readiness.direction,
    caller,
    peer,
    status: readiness.status,
    companion: {
      status: companion.status,
      contract_version: companion.selected?.contract_version ?? null,
    },
    model: {
      value: modelEffort.model.value,
      source: modelEffort.model.source,
    },
    effort: {
      value: modelEffort.effort.value,
      source: modelEffort.effort.source,
    },
    sandbox_permission: readiness.sandbox_permission.status,
    execution_readiness: buildDirectionExecutionReadiness({ key, permissionProof, deepPeerSmoke, workflowContinuationProof }),
    blocker_count: readiness.blockers.length,
    warning_count: readiness.warnings.length,
  };
}

function buildDirectionExecutionReadiness({ key, permissionProof, deepPeerSmoke, workflowContinuationProof }) {
  const permission = summarizeExecutorEvidence(permissionProof, key);
  const smoke = summarizeExecutorEvidence(deepPeerSmoke, key);
  const workflow = summarizeExecutorEvidence(workflowContinuationProof, key);
  const executed = [permission, smoke, workflow].filter((entry) => entry.executed);
  const requested = [permission, smoke, workflow].filter((entry) => entry.requested);
  let status = 'not_requested';
  if (executed.length > 0) {
    status = summarizeExecutorEvidenceStatus(executed);
  } else if (requested.length > 0) {
    status = 'plan_only';
  }
  return {
    status,
    permission_proof: permission,
    deep_peer_smoke: smoke,
    workflow_continuation_proof: workflow,
    evidence: executed.length > 0
      ? 'explicit peer/workflow executor evidence recorded in runtime:doctor output'
      : requested.length > 0
        ? 'plan-only preflight evidence; no companion executor ran'
        : 'no explicit companion executor evidence requested',
  };
}

function summarizeExecutorEvidence(section, key) {
  const direction = section?.directions?.[key] ?? null;
  const result = direction?.result ?? null;
  return {
    requested: section?.requested === true,
    executed: direction?.execution === 'executed',
    status: result?.status ?? direction?.status ?? section?.status ?? 'not_requested',
    operator_action_required: result?.operator_action_required === true,
    operator_action_kind: result?.operator_action_kind ?? null,
    peer_execution: section?.peer_execution === true,
  };
}

function summarizeExecutorEvidenceStatus(entries) {
  const statuses = entries.map((entry) => entry.status);
  if (statuses.every((status) => status === 'passed')) return 'passed';
  if (entries.some((entry) => entry.operator_action_required || entry.status === 'operator_action_required')) {
    return 'operator_action_required';
  }
  if (statuses.some((status) => status === 'timed_out')) return 'timed_out';
  if (statuses.some((status) => ['skipped', 'blocked', 'unavailable', 'unauthenticated', 'not_installed'].includes(status))) return 'blocked';
  return 'failed';
}

function buildSandboxPermissionProbeSection({ requested, readiness }) {
  const directions = {
    claude_to_codex: readiness.claude_to_codex.sandbox_permission,
    codex_to_claude: readiness.codex_to_claude.sandbox_permission,
  };
  return {
    requested,
    executed: requested,
    peer_execution: false,
    mode: requested ? 'read_only_preflight' : 'not_requested',
    status: summarizeSandboxPermissionProbeStatus({ requested, directions }),
    reason: requested
      ? 'runtime:doctor evaluated read-only CLI, auth, feature-surface, and companion-script preflight evidence without executing peers'
      : 'not requested',
    directions,
    limits: [
      'Read-only probe; runtime:doctor does not execute peer agents.',
      'No host-native config, auth, secrets, sandbox, or permission state is mutated.',
      'A passed probe proves the observed preflight surface only; a future explicit executor is still required to prove live peer execution.',
    ],
  };
}

function summarizeSandboxPermissionProbeStatus({ requested, directions }) {
  if (!requested) return 'not_requested';
  const statuses = Object.values(directions).map((direction) => direction.status);
  if (statuses.every((status) => status === 'read_only_probe_passed')) return 'read_only_probe_passed';
  if (statuses.some((status) => status === 'read_only_probe_passed')) return 'partially_blocked';
  return 'blocked';
}

async function buildPermissionProofSection({
  requested,
  execute,
  readiness,
  claude,
  codex,
  companion,
  modelEffort,
  repoRoot,
  env,
  runner,
  timeoutMs,
}) {
  const directionSpecs = {
    claude_to_codex: {
      caller: claude,
      peer: codex,
      requiredPermissionFeatures: ['sandbox_flag', 'approval_flag'],
    },
    codex_to_claude: {
      caller: codex,
      peer: claude,
      requiredPermissionFeatures: ['permission_mode'],
    },
  };
  const directions = {};
  for (const key of ['claude_to_codex', 'codex_to_claude']) {
    const directionReadiness = readiness[key];
    const companionDirection = companion.directions[key];
    const directionSettings = modelEffort.directions[key];
    const spec = directionSpecs[key];
    const preflight = buildDirectionSandboxPermissionProbe({
      requested,
      direction: directionReadiness.direction,
      caller: spec.caller,
      peer: spec.peer,
      companion: companionDirection,
      requiredPermissionFeatures: spec.requiredPermissionFeatures,
      peerExecutionEvidence: execute
        ? 'preflight did not execute a peer; explicit permission proof executor is handled separately'
        : 'no companion command or peer agent was executed',
    });
    const preflightBlockers = preflight.status === 'blocked'
      ? preflight.blockers.map((blocker) => `permission preflight ${blocker}`)
      : [];
    const blockers = uniqueStrings([...directionReadiness.blockers, ...preflightBlockers]);
    const warnings = uniqueStrings([
      ...directionReadiness.warnings,
      execute
        ? 'permission proof executor requested; companion runs under host-native permission defaults'
        : 'permission proof is plan-only until --execute-permission-proof is supplied',
      'runtime:doctor does not add sandbox, approval, permission-mode, or host-native policy relaxation flags',
    ]);
    const blocked = blockers.length > 0;
    const direction = {
      direction: directionReadiness.direction,
      requested,
      execution: execute && requested && !blocked ? 'pending' : 'not_executed',
      status: !requested ? 'not_requested' : blocked ? 'blocked' : 'ready_with_warnings',
      plan: requested
        ? execute
          ? 'explicit permission proof executor requested; peer agent is invoked through the companion contract when readiness is not blocked'
          : 'plan-only permission preflight; no peer agent is executed by runtime:doctor'
        : 'not requested',
      model: directionSettings.model,
      effort: directionSettings.effort,
      permission_policy: {
        host_native_default: true,
        relaxed_by_doctor: false,
        injected_flags: [],
      },
      preflight,
      blockers,
      warnings,
      result: null,
      next_step: requested
        ? blocked
          ? 'resolve blockers before executing the permission proof'
          : execute
            ? 'inspect the sanitized permission proof metadata; raw peer output is intentionally omitted'
            : 'rerun with --permission-proof --execute-permission-proof to prove companion execution under current host permission defaults'
        : 'rerun with --permission-proof to include this permission preflight',
    };
    if (requested && execute && blocked) {
      direction.execution = 'skipped';
      direction.result = {
        status: 'skipped',
        reason: 'readiness or permission preflight blockers prevent live permission proof execution',
      };
    } else if (requested && execute) {
      direction.result = await executePermissionProofDirection({
        key,
        repoRoot,
        companionDirection,
        directionSettings,
        runner,
        env,
        timeoutMs,
      });
      direction.execution = 'executed';
      direction.status = direction.result.status;
      if (direction.result.operator_action_required) {
        direction.next_step = 'operator must satisfy host permission or auth preconditions outside runtime:doctor, then rerun the explicit proof';
      }
    }
    directions[key] = direction;
  }
  return {
    requested,
    executed: Boolean(requested && execute),
    peer_execution: Boolean(requested && execute),
    mode: !requested ? 'not_requested' : execute ? 'explicit_permission_executor' : 'plan_only_preflight',
    status: execute
      ? summarizePermissionProofExecutionStatus({ requested, directions })
      : summarizePermissionProofPlanStatus({ requested, directions }),
    reason: requested
      ? execute
        ? 'runtime:doctor executed a permission proof through the companion contract behind an explicit executor flag'
        : 'runtime:doctor plans the permission proof preflight but does not execute peer agents'
      : 'not requested',
    directions,
    limits: [
      execute
        ? 'Explicit executor; peer agents are invoked only when --permission-proof and --execute-permission-proof are both supplied.'
        : 'Plan-only preflight; runtime:doctor does not execute peer agents.',
      'The executor proves companion invocation under current host permission defaults; it does not authorize future writes or broader tool use.',
      'runtime:doctor does not pass sandbox, approval, permission-mode, or host-native policy relaxation flags to the companion command.',
      'Raw peer stdout is not included in doctor output; only status, exit code, byte count, SHA-256, timing metadata, and sanitized error class are reported.',
      'No host-native config, auth, secrets, sandbox, or permission state is mutated.',
    ],
  };
}

function summarizePermissionProofPlanStatus({ requested, directions }) {
  if (!requested) return 'not_requested';
  const statuses = Object.values(directions).map((direction) => direction.status);
  if (statuses.every((status) => !['ready_with_warnings', 'available'].includes(status))) return 'blocked';
  if (statuses.some((status) => !['ready_with_warnings', 'available'].includes(status))) return 'partially_blocked';
  return 'ready_with_warnings';
}

function summarizePermissionProofExecutionStatus({ requested, directions }) {
  if (!requested) return 'not_requested';
  const statuses = Object.values(directions).map((direction) => direction.status);
  if (statuses.every((status) => status === 'passed')) return 'passed';
  if (statuses.some((status) => status === 'operator_action_required')) return 'operator_action_required';
  if (statuses.some((status) => status === 'timed_out')) return 'timed_out';
  if (statuses.some((status) => ['skipped', 'blocked', 'unavailable', 'unauthenticated', 'not_installed'].includes(status))) return 'blocked';
  return 'failed';
}

async function executePermissionProofDirection({
  key,
  repoRoot,
  companionDirection,
  directionSettings,
  runner,
  env,
  timeoutMs,
}) {
  const companionPath = companionDirection.selected?.path;
  if (!companionPath) {
    return {
      status: 'blocked',
      reason: `companion ${companionDirection.filename} is not available`,
    };
  }
  const expectedToken = `RUNTIME_DOCTOR_PERMISSION_OK ${companionDirection.peer}`;
  const prompt = buildPermissionProofPrompt({ key, peer: companionDirection.peer, expectedToken });
  const args = [
    companionPath,
    'task',
    '--cwd',
    repoRoot,
    '--output-format',
    'json',
  ];
  if (directionSettings.model.value) args.push('--model', directionSettings.model.value);
  if (directionSettings.effort.value) args.push('--effort', directionSettings.effort.value);
  args.push(prompt);

  const result = await runner(process.execPath, args, {
    cwd: repoRoot,
    env,
    timeoutMs,
  });
  return summarizeCompanionPermissionProofResult({ result, companionPath, expectedToken });
}

function buildPermissionProofPrompt({ key, peer, expectedToken }) {
  return [
    '<task>',
    `Runtime doctor permission proof for ${key} targeting ${peer}. Reply with exactly one short line: ${expectedToken}.`,
    '</task>',
    '',
    '<permission_boundary>',
    '<rule>Use the current host permission policy; do not request elevation or change settings.</rule>',
    '<rule>Do not inspect, create, delete, or modify repository files.</rule>',
    '<rule>Do not include secrets, account details, environment values, or prompt text.</rule>',
    '<rule>If the host blocks execution or asks for approval, let the companion return the failure rather than bypassing it.</rule>',
    '</permission_boundary>',
    '',
    '<expected_output>',
    expectedToken,
    '</expected_output>',
  ].join('\n');
}

function summarizeCompanionPermissionProofResult({ result, companionPath, expectedToken }) {
  const summary = summarizeCompanionSmokeResult({ result, companionPath, expectedToken });
  const operatorActionKind = summary.status === 'passed' ? null : classifyOperatorActionKind(summary);
  return {
    ...summary,
    status: operatorActionKind ? 'operator_action_required' : summary.status,
    operator_action_required: Boolean(operatorActionKind),
    operator_action_kind: operatorActionKind,
    permission_failure: Boolean(operatorActionKind),
    permission_failure_kind: operatorActionKind,
    permission_policy: {
      host_native_default: true,
      relaxed_by_doctor: false,
      injected_flags: [],
    },
  };
}

function classifyOperatorActionKind(summary) {
  const text = [
    summary.companion_error_code,
    summary.envelope_status,
    summary.stderr_summary,
    summary.error?.kind,
    summary.error?.message,
  ].filter(Boolean).join(' ');
  const textKind = classifyOperatorActionText(text);
  if (textKind) return textKind;
  if (summary.peer_stdout_operator_action_kind) return summary.peer_stdout_operator_action_kind;
  if (summary.error?.detail_kind) return summary.error.detail_kind;
  return null;
}

function classifyOperatorActionText(text) {
  if (!text) return null;
  if (/\b(peer_unauthenticated|not logged in|login required|auth required|authentication required|unauthorized|forbidden|401|403)\b/i.test(text)) {
    return 'auth_required';
  }
  if (/\b(approval|consent|permission prompt|requires permission|requires approval|approval required)\b/i.test(text)) {
    return 'permission_required';
  }
  if (/\b(sandbox|read-only|read only|not allowed|operation not permitted|permission denied|EACCES|EPERM|denied)\b/i.test(text)) {
    return 'sandbox_blocked';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Egress provider-ack proof (ADR-0048 §3, macro egress-proof-executor slice)
// ---------------------------------------------------------------------------
//
// The ONE explicitly-executed networked proof: doctor delegates a single
// synthetic notification to the E1 emitter (in-process runEmit — the pinned
// api.telegram.org call site stays inside notify.mjs, per the executor
// guard), against an EPHEMERAL temp repo (operational notify state — mirror
// log, dedupe claims, throttle — untouched; the consumer repo's notify
// config is DELIBERATELY not consulted: the proof exercises user-global +
// default policy, documented in the contract).
//
// TRIPLE consent to reach the network: the --egress-ack-proof plan flag, the
// --execute-egress-ack-proof execute flag, AND AGENTIC_EGRESS_REAL_SMOKE=1 in
// the environment (the production realization of the subtask's REAL_SMOKE
// gate — the same switch that gates the live acceptance suite governs every
// real send).
//
// AMBIGUOUS-ATTEMPT rule (Plan-verify peer BLOCKER): an intent record is
// written BEFORE the send and resolved after. A crash between them leaves a
// pending intent; the next execute REFUSES to auto-resend (the phone may
// already have the message) until the operator removes the named intent file
// after checking their phone. Telegram has no idempotency key — this is the
// honest recovery.
export const EGRESS_ACK_OUTCOME_REASONS = Object.freeze([
  'dispatched', 'kinds-filter', 'quiet-hours', 'dedupe-duplicate', 'throttled',
  'missing-token', 'missing-recipient', 'invalid-local-activation', 'provider-error',
  'provider-rejected', 'timeout', 'redirect-error', 'body-cap', 'channel-none',
  'emit-error', 'mirror-missing', 'mirror-ambiguous',
]);

// The pre-wire outcome reasons: the attempt provably stopped before any network
// I/O (pipeline suppression, activation/config failure, or body-cap). Nothing
// reached the phone; a terminal intent carrying one of these is safe to clear.
const EGRESS_NO_WIRE_REASONS = Object.freeze([
  'kinds-filter', 'quiet-hours', 'dedupe-duplicate', 'throttled',
  'missing-token', 'missing-recipient', 'invalid-local-activation',
  'body-cap', 'channel-none',
]);

// The outcome reasons that mean the pinned request reached the wire even when
// the emitter returned a non-dispatched status (a failure AT/AFTER the socket),
// plus the dispatched-mirror variants (which only arise when dispatched=true).
const EGRESS_WIRE_REASONS = Object.freeze([
  'dispatched', 'provider-error', 'provider-rejected', 'timeout',
  'redirect-error', 'mirror-missing', 'mirror-ambiguous',
]);

// Classify whether an egress attempt touched the network. THREE states so the
// re-send gate can fence the ambiguous case without the effects claim
// overstating it - the gate-block key and the honesty claim are DIFFERENT
// predicates:
//   - 'no-wire'  provably pre-wire (whitelisted above); safe to clear.
//   - 'wire'     the request was issued. effects.network_request_performed is
//                exactly this.
//   - 'unknown'  emit-error (a runEmit no-throw-contract breach that could be
//                post-wire) OR ANY UNRECOGNIZED reason. Defaulting to unknown is
//                deliberate fail-closed (Codex review MAJOR): a new or drifted
//                outcome reason must fence a resend, never silently permit one.
//                test-doctor.mjs pins the full-enum partition so drift is caught.
export function classifyWireDisposition(dispatched, outcomeReason) {
  if (dispatched || EGRESS_WIRE_REASONS.includes(outcomeReason)) return 'wire';
  if (EGRESS_NO_WIRE_REASONS.includes(outcomeReason)) return 'no-wire';
  return 'unknown';
}

// `egressIntentDir` is imported from ./lib/egress-intent-wal.mjs. Passed
// homedir() it is the machine-global WAL (NOT repo-scoped, so a bootstrap run
// resumed from a different repo checkout still sees a prior attempt's fence,
// gap ②); passed repoRoot it is the pre-upgrade legacy one. The doctor --record
// artifact stays repo-scoped; only this side-effect WAL is machine-global.
// It moved out of this file because `runtime:migrate legacy-egress-intents`
// needs the same path shape, and this file had already grown a second inline
// copy of it for the legacy directory.

// The two names one attempt publishes, and the ONLY two the WAL protocol knows.
//
//   claim     <fingerprint>.json                     — one per activation; the fence
//   terminal  <fingerprint>.<owner_token>.terminal.json — one per ATTEMPT; its outcome
//
// The claim's name is the activation, so creating it is the exclusion. The
// terminal's name additionally carries the owner token, so it belongs to exactly
// one attempt and no attempt can ever land on another's name. That is what makes
// the protocol append-only: there is no name two writers contend for after the
// claim, so no write ever has to decide whether what is already there is its own.
//
// The suffix is what the scan reads to tell the two roles apart, so it is a
// constant rather than three inlined string literals that could drift apart.
const EGRESS_TERMINAL_SUFFIX = '.terminal.json';
const egressClaimName = (fingerprint) => `${fingerprint}.json`;
const egressTerminalName = (fingerprint, ownerToken) => `${fingerprint}.${ownerToken}${EGRESS_TERMINAL_SUFFIX}`;

// An owner token is 12 random bytes (24 lowercase hex). The scan validates the
// shape before it pairs on it: a token is a JOIN KEY here, and a malformed one
// must fail closed rather than silently match nothing (which would read as
// "no terminal" — i.e. as a pending attempt — and then be judged by pid).
const EGRESS_OWNER_TOKEN_RE = /^[0-9a-f]{24}$/;
const EGRESS_FINGERPRINT_RE = /^[0-9a-f]{64}$/;

// The activation a record's NAME scopes it to, or null when the name carries
// none (a legacy claim named by the correlation suffix rather than the
// fingerprint). Both record names begin with the fingerprint, so one parse
// serves both roles.
//
// This exists because scope was decided from the BODY alone, and that was
// fail-open in exactly one direction: a file NAMED for this activation whose
// body named a DIFFERENT valid activation was dropped by the scope filter
// before the name/body agreement check could fence it. Measured — the scan
// returned no findings at all for a `wire` terminal record sitting at this
// activation's own name, and with a `no-wire` record beside it the operator was
// told deleting was safe while the wire record was never mentioned. The
// mismatch check was already there; it was simply unreachable from one side.
function egressNameFingerprint(name) {
  const base = name.endsWith(EGRESS_TERMINAL_SUFFIX)
    ? name.slice(0, -EGRESS_TERMINAL_SUFFIX.length)
    : name.slice(0, -'.json'.length);
  const head = base.split('.')[0];
  return EGRESS_FINGERPRINT_RE.test(head) ? head : null;
}

// How long a pending claim can still be read as "in flight". Past it, the
// blocker reverts to the check-the-phone-then-delete wording — NOT to any
// automatic action.
//
// This MUST stay comfortably above the send budget, or a legitimately running
// attempt would be advertised as deletable and an operator could free the fence
// under a live send. The whole dispatch is bounded by notify.mjs
// TELEGRAM_API_TIMEOUT_MS (8s at the time of writing), so this is ~100x the
// window it has to cover. If that budget ever grows, this bound grows with it.
const EGRESS_CLAIM_IN_FLIGHT_MS = 15 * 60 * 1000;

// Is a pending claim's holder still running? This predicate exists for exactly
// ONE purpose: choosing which blocker text a later contender sees. It NEVER
// authorizes breaking, reclaiming, or overwriting a claim — the operator is the
// only reclaim authority, which is what ADR-0048 residual (a)'s "no unsafe
// stale-lock takeover" asks for, taken to its end. If a future reader is
// tempted to add an automatic takeover here because the liveness answer is
// already available: that is the door residual (a) closed on purpose.
//
// Both legs are required. The age bound is here because pid REUSE can make an
// unrelated live process read as the holder; the bound limits how long that
// misreading can block an operator. It does not make the reading true.
// Classify a pending claim's holder. THREE states, not a boolean, because the
// two inputs answer different questions and collapsing them loses the one that
// matters most.
//
//   'live'       the pid is alive and the claim is recent — an attempt is running
//   'live-stale' the pid is alive but the claim is unusually old — something is
//                there, and we cannot tell whether it is still working
//   'gone'       no usable holder identity, or the pid is provably gone
//
// Peer MAJOR (resolved as a design conflict): age must NEVER downgrade a
// CONFIRMED live pid to 'gone'. The earlier version returned on the age gate
// before probing at all, so a paused, suspended or debugged holder was
// advertised as deletable — and an operator who follows that advice frees the
// fence for a second message to their phone. But the age bound cannot simply be
// dropped either: it is what stops a REUSED pid from blocking an activation
// forever. So age qualifies the wording instead of overriding the evidence.
//
// AGE AUTHORITY IS THE FILE MTIME MEASURED AGAINST A REAL WALL CLOCK — not the
// body's `acquired_at`, and not `runDoctor`'s injected `now`. Both halves of the
// comparison have to come from the same world or the result means nothing, and
// an earlier cut got this half-right: it read the kernel's mtime and then
// compared it against the caller's LOGICAL report clock, under a comment that
// cited the injected clock as a reason to prefer the mtime. Measured: the same
// fresh claim held by a live pid reads `in flight` on a wall clock and flips to
// `live-stale` — which offers the deletion — with `now` an hour ahead, so a
// report timestamp could decide safety advice about someone else's running
// send. `Date.now()` is used directly and NO test seam is offered, because the
// tests that need an old claim age the FILE with `utimes`, which is the real
// thing (the same reason bootstrap-artifacts.mjs gives for its own seam being a
// last resort). The forged-`acquired_at` reason below is unchanged.
// `link(2)` publishes the claim preserving the temp file's mtime, set
// microseconds earlier, so the mtime is an honest creation time. An UNKNOWN age
// (the stat failed) is treated as recent rather than as old, because "I could
// not tell" must not become the deletable answer. NOT covered by a regression:
// provoking a stat failure on a file we just read successfully is a race, not a
// fixture.
function classifyClaimHolder(intent, mtimeMs, wallNowMs) {
  const pid = Number.isInteger(intent?.pid) && intent.pid > 0 ? intent.pid : null;
  // No usable holder identity is UNKNOWN, never proof of death. This mattered
  // immediately: the previous release's pending record carries no `pid` at all,
  // so reading absence as `gone` advertises a STILL-RUNNING older sender as
  // crashed and hands the operator the flat delete instruction — which frees the
  // fence for a second message to the same phone. That is the rollback path the
  // original request named, arrived at from the other direction (peer round-3
  // MAJOR). Age deliberately does NOT resolve it: an old record with no identity
  // is still an unknown, not a corpse.
  if (pid === null) return 'unidentified';
  let alive;
  try {
    // Liveness READ only (ADR-0035 §4): signal 0 asks whether the process
    // exists and delivers nothing. ESRCH ⇒ gone. EPERM ⇒ it exists under
    // another uid, which counts as alive — "I could not tell" must never read
    // as "safe to proceed past someone else's fence".
    process.kill(pid, 0);
    alive = true;
  } catch (err) {
    alive = err?.code !== 'ESRCH';
  }
  if (!alive) return 'gone';
  const aged = Number.isFinite(mtimeMs) && wallNowMs - mtimeMs >= EGRESS_CLAIM_IN_FLIGHT_MS;
  return aged ? 'live-stale' : 'live';
}

// Fence severities, WORST FIRST. The order is not decoration — it is the
// precedence rule, and getting it wrong is a defect that has now been found
// three times, at three levels, in the same shape: a guard that answers for SOME
// of the cases and silently takes the permissive branch for the rest.
//
//   round 4  `clearable && unresolved.length === 0` named ONE of four dangerous
//            states, so `clearable` won over the other three — including
//            `unidentified`, i.e. a possibly-live sender.
//   round 5  the table replaced that guard, and the UNLISTED case then fell
//            through `find()` to whatever listed severity happened to be
//            present. Paired with `clearable` that produced the safe-to-delete
//            sentence AND dropped the unclassifiable record from the message.
//
// `clearable` is last because its message is the only one here that tells an
// operator a deletion is SAFE. `unclassified` is FIRST for the mirror reason: a
// record this runtime cannot interpret is the most severe thing in the WAL,
// because "I do not know what this is" must never resolve to "go ahead".
const EGRESS_FENCE_SEVERITIES = Object.freeze(['unclassified', 'in-flight', 'live-stale', 'unidentified', 'unresolved', 'clearable']);

// The severities that must NEVER be accompanied by an instruction to remove
// anything: something may be running, or may be beyond this runtime's
// understanding, and an operator acting on a removal instruction in either state
// can free a fence under a live send.
const EGRESS_NO_REMOVAL_ADVICE = Object.freeze(['unclassified', 'in-flight']);

// Judge a record that carries an OUTCOME (a terminal record, or a claim-shaped
// record left by a runtime whose protocol this is not) on its own disposition.
// Fail-closed: only the explicit 'no-wire' is clearable, and everything else —
// including an absent disposition — is treated as possibly on the phone.
// Record names and outcome reasons reach OPERATOR TEXT, and both come out of an
// untrusted place: a name is whatever bytes are in the directory, and a reason is
// whatever bytes are in the body. Peer-measured, both were forgeable — a filename
// carrying a newline and an ANSI escape rendered a fake instruction line, and a
// reason that merely LOOKED enum-shaped (`delete-all-records-now` passes
// `[a-z-]{1,40}`) was echoed verbatim. A shape test is not a membership test.
//
// The reason is therefore checked against the closed enum, and the name against
// the alphabet this WAL actually writes (hex and dots). A name outside it is
// rendered defused AND SAID to be: silently mangling it would leave an operator
// unable to copy the name they need to remove, which is worse than telling them
// the name is not one of ours.
// `safeRecordName` is imported from ./lib/egress-intent-wal.mjs — the same
// defusing the discovery scanner applies, so a hazard class learned by either
// reader is known to both.
const safeOutcomeReason = (reason) => (EGRESS_ACK_OUTCOME_REASONS.includes(reason) ? reason : 'unknown');

function judgeEgressOutcomeRecord(add, record, files, validFp) {
  const scopeNote = validFp ? '' : ', unscopable fingerprint';
  const disposition = record.intent?.wire_disposition;
  const safeReason = safeOutcomeReason(record.intent?.outcome_reason);
  const shown = safeRecordName(record.name);
  if (disposition === 'no-wire') {
    add('clearable', `${shown}: a previous attempt stopped before sending (${safeReason}${scopeNote})`, files);
  } else if (disposition === 'unknown') {
    add('unresolved', `${shown}: wire disposition unknown (emit invariant breach${scopeNote})`, files);
  } else {
    add('unresolved', `${shown}: network request performed (${safeReason}${scopeNote})`, files);
  }
}

/**
 * Read the WAL and pair every claim to its terminal record by owner token.
 *
 * The pairing is what the append-only protocol buys. A claim names an
 * ACTIVATION and a terminal record names an ATTEMPT, so the two together say
 * what happened without either one having to be overwritten:
 *
 *   claim + its terminal  → resolved; the terminal's disposition decides fencing
 *   claim, no terminal    → pending; the holder's liveness decides the wording
 *   terminal, no claim    → orphaned; judged on its own disposition
 *
 * An orphaned terminal is not a curiosity — it is precisely the state that used
 * to be a duplicate-send bug. When an operator deletes a live claim and a
 * successor claims the freed name, the first attempt's terminal record lands at
 * its OWN name and the successor's claim is untouched; the scan then reports the
 * successor as pending and the orphan separately, instead of reading the
 * overwritten record and announcing that deletion is safe while the successor's
 * message is on the phone.
 *
 * Returns a flat findings list. Composition is a separate pure function so the
 * precedence rule can be tested without a filesystem.
 */
export async function scanEgressIntents({ intentEntries, intentDir, activationFingerprint }) {
  const findings = [];
  const add = (severity, label, files) => findings.push({ severity, label, files });
  const claims = [];
  const terminals = [];

  for (const name of intentEntries) {
    if (!name.endsWith('.json')) continue;
    let intent = null;
    try {
      intent = JSON.parse(await readFile(join(intentDir, name), 'utf8'));
    } catch {
      add('unresolved', `${safeRecordName(name)}: unparseable (fail-closed)`, [name]);
      continue;
    }
    // Every operator-facing rendering of this name goes through the defused
    // form; `name` itself stays exact, because it is what the filesystem calls
    // are made with and what an operator must copy to remove the record.
    const shownName = safeRecordName(name);
    const fp = intent?.activation_fingerprint;
    const validFp = typeof fp === 'string' && EGRESS_FINGERPRINT_RE.test(fp);
    const nameFp = egressNameFingerprint(name);
    // IN SCOPE when the NAME says this activation, or the BODY does, or the body
    // cannot be scoped at all. Only a record that BOTH halves place elsewhere is
    // genuinely another phone's business.
    //
    // Reading the body alone was the fail-open half: a record occupying a name
    // that scopes it to THIS activation was skipped whenever its body named a
    // different valid one, so the disagreement check below never ran. An absent
    // or malformed body fingerprint remains unscopable and stays in scope,
    // fail-closed (Codex review MINOR, unchanged).
    if (nameFp !== activationFingerprint && validFp && fp !== activationFingerprint) continue;
    const token = typeof intent?.owner_token === 'string' && EGRESS_OWNER_TOKEN_RE.test(intent.owner_token) ? intent.owner_token : null;
    if (name.endsWith(EGRESS_TERMINAL_SUFFIX)) {
      // A terminal record's NAME encodes the attempt it belongs to, so the name
      // and the body are two statements of the same fact and must agree. If they
      // do not — or either half is unusable — the record cannot be attributed to
      // an attempt, and an unattributable record is fenced rather than paired or
      // dismissed. Reconstructing the expected name from the BODY is one
      // comparison that covers both halves at once.
      if (!validFp || token === null || name !== egressTerminalName(fp, token)) {
        add('unresolved', `${shownName}: a terminal record whose name does not match the attempt its body describes (fail-closed)`, [name]);
        continue;
      }
      terminals.push({ name, intent, token });
    } else {
      // The same disagreement for a claim, but NOT the same handling — and the
      // difference is the whole lesson of this round.
      //
      // The first cut answered a mismatched claim with a flat `unresolved`,
      // which reads as "crashed before resolve" and carries "check the phone,
      // then delete". Peer-measured: a claim whose recorded pid was ALIVE was
      // then advertised as deletable, and following that instruction frees the
      // exclusive name for a successor to claim and send — the exact
      // duplicate-delivery path this slice exists to close, reintroduced by the
      // fix for a different fail-open. A mismatch may make a record more
      // suspicious; it must never make a LIVE sender look deletable.
      //
      // So the mismatch travels with the claim as an ANNOTATION, and liveness
      // still decides the severity. A LEGACY claim carries no fingerprint in its
      // name (nameFp === null) and is exempt — there is nothing to disagree with.
      const mismatched = nameFp !== null && (!validFp || nameFp !== fp);
      claims.push({ name, shownName, intent, token, validFp, mismatched });
    }
  }

  const terminalByToken = new Map(terminals.map((terminal) => [terminal.token, terminal]));
  const paired = new Set();

  for (const claim of claims) {
    // A mismatched claim never PAIRS. Pairing resolves a claim — it hands the
    // verdict to a terminal record matched on a token the claim may not own —
    // and a record we cannot attribute must not be resolved that way.
    const terminal = (claim.token === null || claim.mismatched) ? undefined : terminalByToken.get(claim.token);
    if (terminal) {
      paired.add(terminal.name);
      // BOTH files are the operator's unit of work: the claim occupies the name
      // the next attempt needs, so clearing only the terminal would leave the
      // activation fenced and the next run reporting a pending claim instead.
      judgeEgressOutcomeRecord(add, terminal, [claim.name, terminal.name], claim.validFp);
      continue;
    }
    if (claim.intent?.status !== 'pending') {
      // Claim-shaped, not pending, no terminal: written by a runtime that
      // resolved records in place (the pre-append-only format) or edited by
      // hand. There is no liveness question for a record that says it finished,
      // so a mismatch here IS fail-closed on its own; otherwise its disposition
      // is the only thing that can say whether anything reached the phone.
      if (claim.mismatched) {
        add('unresolved', `${claim.shownName}: a finished record whose name and body name different activations (fail-closed)`, [claim.name]);
        continue;
      }
      judgeEgressOutcomeRecord(add, claim, [claim.name], claim.validFp);
      continue;
    }
    // G1: a pending claim whose holder is still ALIVE is an attempt in flight,
    // not a crash. The distinction exists ONLY to choose the wording — never to
    // authorize breaking the claim — because the two states have opposite
    // remedies and this repo already carries both instructions in different
    // places ("delete the intent file(s)" here, "do not delete the lock by hand"
    // for the bootstrap family lock). An operator told to delete while a send is
    // in flight can free the name for a third sender, so the live case must not
    // mention deletion at all. The mtime is read from the SAME name we just
    // parsed; a stat failure passes NaN through, and the predicate treats an
    // unknown age as "do not judge by age" rather than as "not live".
    const claimMtimeMs = await stat(join(intentDir, claim.name)).then((st) => st.mtimeMs).catch(() => Number.NaN);
    const holder = classifyClaimHolder(claim.intent, claimMtimeMs, Date.now());
    // The annotation, never a severity of its own. A mismatch is reported so an
    // operator knows the record is not trustworthy; the SEVERITY still comes
    // from whether somebody is sending right now.
    const scopeNote = claim.mismatched
      ? ', and its name and body name different activations'
      : claim.validFp ? '' : ', unscopable fingerprint';
    const shown = claim.shownName;
    if (holder === 'live') add('in-flight', `${shown}: an attempt is running${scopeNote}`, [claim.name]);
    else if (holder === 'live-stale') add('live-stale', `${shown}: its process is alive but the claim is unusually old${scopeNote}`, [claim.name]);
    else if (holder === 'unidentified') add('unidentified', `${shown}: pending with no recorded process identity${scopeNote}`, [claim.name]);
    else add('unresolved', `${shown}: pending (crashed before resolve${scopeNote})`, [claim.name]);
  }

  for (const terminal of terminals) {
    if (paired.has(terminal.name)) continue;
    judgeEgressOutcomeRecord(add, terminal, [terminal.name], true);
  }
  return findings;
}

const egressFileList = (findings) => [...new Set(findings.flatMap((finding) => finding.files))].sort().map(safeRecordName).join(', ');
const egressLabels = (findings) => findings.map((finding) => finding.label).join('; ');

/**
 * Turn the findings into ONE operator message, or null when the WAL is clear.
 *
 * Two rules, and they are the whole point of this being a separate function:
 *
 *  1. The MOST CAUTIOUS finding decides the wording. A live attempt outranks
 *     everything, and no message may advise deleting anything while one is
 *     running.
 *  2. Every other finding is still NAMED. Reporting only the winner is how a
 *     WAL holding a no-wire record and a possibly-live pending record came to
 *     report just "nothing reached the phone" — true of one record, fatally
 *     wrong as advice about the directory.
 */
export function composeEgressFenceBlocker(findings, dirPointer) {
  if (!Array.isArray(findings) || findings.length === 0) return null;
  // RANK FIRST, and rank an unrecognized severity as the WORST rather than
  // skipping past it. `find()` over the table used to answer "is any listed
  // severity present", which is a different question: with an unlisted finding
  // beside a `clearable` one it answered `clearable`, produced the
  // safe-to-delete sentence, and dropped the unclassifiable record from the
  // message entirely (measured). Normalizing into a real top-ranked severity is
  // what makes the table TOTAL over its input instead of over its own list.
  const ranked = findings.map((finding) => (EGRESS_FENCE_SEVERITIES.includes(finding.severity)
    ? finding
    : { ...finding, severity: 'unclassified' }));
  const top = EGRESS_FENCE_SEVERITIES.find((severity) => ranked.some((finding) => finding.severity === severity));
  const winners = ranked.filter((finding) => finding.severity === top);
  const rest = ranked.filter((finding) => finding.severity !== top);
  const labels = egressLabels(winners);
  const files = egressFileList(winners);
  // Two shapes for the tail, and which one is used follows the SAME rule as the
  // main wording: a message that must not advise removal must not advise it for
  // the other records either.
  const alsoHolds = rest.length === 0
    ? ''
    : EGRESS_NO_REMOVAL_ADVICE.includes(top)
      ? ` This activation also has other records here (${egressLabels(rest)}); leave them alone until the state above is resolved, then re-run to get the right instruction for them.`
      : ` This is not the whole WAL for this activation: it also holds ${egressLabels(rest)}. A fresh send needs every one of these records gone (${egressFileList(ranked)}), and the most cautious instruction above governs all of them.`;

  if (top === 'unclassified') {
    return `the egress intent WAL under ${dirPointer} holds records this runtime cannot classify (${labels}); refusing a send that cannot be fenced against them. Do NOT remove anything on the strength of this message — an unclassifiable record may be a completed send, a running attempt, or neither, and this runtime cannot tell which. Check the phone, and resolve these records with a runtime that understands them.${alsoHolds}`;
  }
  if (top === 'in-flight') {
    return `another egress proof attempt for this activation is in flight under ${dirPointer} (${labels}); wait for it to finish and re-run. Do NOT delete any record for this activation while an attempt is running — that would free the fence for a second send to the same phone.${alsoHolds}`;
  }
  if (top === 'live-stale') {
    return `the egress proof attempt recorded for this activation is still running (its process is alive) but its claim under ${dirPointer} is unusually old (${labels}) — a send is bounded to seconds, so it is either stuck or the recorded pid has been reused by an unrelated process. Prefer waiting. Only if you are certain no proof is running: check the phone, then delete ${files} to consent to a fresh send.${alsoHolds}`;
  }
  if (top === 'unidentified') {
    return `a previous egress proof record for this activation under ${dirPointer} (${labels}) carries no process identity — it was written by a runtime that did not record one — so whether its sender is still running cannot be determined here. Treat it as possibly in flight: check the phone, and delete ${files} only if you are certain no proof is running. Automatic resend is prohibited.${alsoHolds}`;
  }
  if (top === 'unresolved') {
    return `a previous egress attempt for this activation is unresolved and may already be on the phone (${labels}) under ${dirPointer}; check the phone, then delete ${files} to consent to a fresh send. Automatic resend is prohibited.${alsoHolds}`;
  }
  // 'clearable' — the ONLY sentence in this file that calls a deletion safe.
  // `rest` is necessarily empty here: clearable is LAST in the severity order,
  // so anything else in the WAL would have taken the top and this branch would
  // be unreachable. That is the precedence property expressed as structure
  // rather than as a guard someone has to remember to widen.
  return `a previous egress attempt for this activation stopped BEFORE any message was sent (${labels}) under ${dirPointer}. Nothing reached the phone, so deleting ${files} is safe and is all that is needed to retry. Nothing is removed automatically: this code never mutates or removes a published record — each one is written once, at a name only its own attempt can produce — which is what keeps a concurrent attempt's fence intact.`;
}

// `sameDirectoryImpl` is an INJECTED SEAM, not a convenience. The property it
// exists for — that a legacy WAL which changes identity while it is being read
// is refused rather than described — is a race, and a race that only a real
// filesystem can produce is a property no test can pin. The seam is how the
// swap becomes deterministic.
async function buildEgressAckProofSection({ requested, execute, repoRoot, homeDir, env, now, emitImpl, sameDirectoryImpl = sameDirectory }) {
  if (!requested) {
    return { requested: false, executed: false, mode: 'not_requested', status: 'not_requested', provider_ack: null, outcome_reason: null, mirror_correlated: false, network_request_performed: false, blockers: [], limits: [] };
  }

  const limits = [
    'The proof exercises user-global + default notify policy against an ephemeral temp repo; the consumer repo\u2019s repo-layer notify config is deliberately not consulted.',
    'The mirror row is not provider evidence \u2014 the provider ack is the HTTP 2xx + ok:true classification \u2014 but a missing/ambiguous mirror makes the attempt unverifiable and the proof fails closed.',
    'Credential rotation is invisible to the activation fingerprint by design (contract \u00a78.1); a rotated token surfaces as this executor\u2019s next real attempt failing.',
  ];

  // Activation preflight. The resolved channel/recipient are later PINNED into
  // the env overlay handed to the emitter, so what this preflight observed is
  // what the send uses.
  //
  // This used to read "the SAME env object is later handed to the emitter, so
  // TOCTOU is closed by sharing the snapshot". That was true only for
  // env-sourced activation: `runEmit` resolves activation independently, and
  // resolveEgressScalars falls back to a MUTABLE verified-local TOML file that
  // sharing an env object has no bearing on. See the pin at the emit call.
  const activation = loadEgressActivation({ repoRoot, homeDir, env });
  const blockers = [];
  if (!activation.active) {
    blockers.push(`egress activation is not active (${activation.reason}) \u2014 channel+recipient+credential must all resolve (token alone and channel alone are both inert; unknown-egress-channel and credential-collision also land here)`);
  }
  const consent = env?.AGENTIC_EGRESS_REAL_SMOKE === '1';
  if (execute && !consent) {
    blockers.push('AGENTIC_EGRESS_REAL_SMOKE=1 is not set \u2014 the real-network send needs this third consent alongside the two flags (export it in the shell that runs the executor)');
  }

  if (!execute) {
    return {
      requested: true,
      executed: false,
      mode: 'plan_only_preflight',
      status: blockers.length > 0 ? 'blocked' : 'ready',
      provider_ack: null,
      outcome_reason: null,
      mirror_correlated: false,
      network_request_performed: false,
      blockers,
      limits,
    };
  }
  if (blockers.length > 0) {
    return { requested: true, executed: false, mode: 'explicit_egress_executor', status: 'blocked', provider_ack: null, outcome_reason: null, mirror_correlated: false, network_request_performed: false, blockers, limits };
  }

  // Re-send fence (gap 1 + gap 2): before a new send, refuse if THIS activation
  // has an unresolved prior attempt. "Unresolved" = crashed before resolve
  // (pending) OR an attempt that touched / may have touched the wire
  // (wire_disposition is not 'no-wire'); the phone may already carry that
  // message, and only an explicit operator `rm` consents to a fresh send. Scope
  // is the machine-global WAL keyed by activation_fingerprint (recipients can
  // differ between shells, so "one phone per machine" is false); an unparseable
  // OR fingerprint-less record cannot be scoped and blocks globally, fail-closed.
  const intentDir = egressIntentDir(homeDir);
  const activationFingerprint = deriveActivationFingerprint({ channel: activation.channel, recipient: activation.recipient, credentialEnvVar: EGRESS_CREDENTIAL_ENV_VAR });
  const blockedSection = (blockerList) => ({
    requested: true, executed: false, mode: 'explicit_egress_executor', status: 'blocked',
    provider_ack: null, outcome_reason: null, mirror_correlated: false, network_request_performed: false,
    blockers: blockerList, limits,
  });
  let intentEntries = null;
  try {
    intentEntries = await readdir(intentDir);
  } catch (err) {
    // ENOENT (no WAL yet) is the ONLY clear-to-proceed error; any other readdir
    // failure (EACCES, ENOTDIR, I/O) leaves the fence unscannable, so fail closed.
    if (err?.code !== 'ENOENT') {
      return blockedSection([`the egress intent WAL at ${machinePointer(homeDir, intentDir)} is unscannable (${err?.code ?? 'error'}); refusing a send that cannot be fenced against a prior attempt. Resolve the directory, then retry.`]);
    }
  }
  if (intentEntries) {
    const scan = await scanEgressIntents({ intentEntries, intentDir, activationFingerprint });
    const blocker = composeEgressFenceBlocker(scan, machinePointer(homeDir, intentDir));
    if (blocker) return blockedSection([blocker]);
  }

  // Upgrade compatibility (Codex review CRITICAL): the WAL moved from the
  // repo-scoped path to the machine-global home. A pre-upgrade intent under the
  // OLD repo path is invisible to the home scan above, so a crashed pending or a
  // dispatched-mirror-lost 'failed' recorded by the prior version could permit a
  // resend. Scan the legacy dir too and refuse until it is cleared; the old
  // format carries no wire_disposition to classify, so every legacy record is
  // treated fail-closed.
  const legacyIntentDir = egressIntentDir(repoRoot);
  // IDENTITY, not spelling. This was `resolve(a) !== resolve(b)`, and the two
  // paths are derived from different roots (repoRoot vs homeDir), so nothing
  // guarantees they spell a shared directory the same way — a symlinked checkout
  // or a case-variant on a case-folding volume reaches one directory by two
  // names. The string compare then said "different", the LIVE WAL was re-read as
  // clearable legacy state, and the message below told the operator to remove it.
  // Freeing that fence is the duplicate send this whole WAL exists to prevent.
  //
  // `unknown` is neither branch: a filesystem that will not answer must not be
  // resolved by guessing. Guessing "different" re-opens the resend path;
  // guessing "same" silently drops a legitimate legacy fence.
  const legacyIsLive = await sameDirectoryImpl(legacyIntentDir, intentDir);
  if (legacyIsLive.unknown) {
    // The reason embeds a raw path (path-containment.mjs builds it that way).
    // `safeRecordName` is the wrong tool for a path, so the message carries the
    // pointer it already renders safely and the CODE only — the scanner defuses
    // this same reason and this branch did not (cross-host review).
    return blockedSection([`the legacy egress intent WAL at ${pointer(repoRoot, legacyIntentDir)} cannot be told apart from the machine-global one at ${machinePointer(homeDir, intentDir)} (${safeRecordName(String(legacyIsLive.code ?? 'error'))}); refusing a send that cannot be fenced against a pre-upgrade attempt.`]);
  }
  if (!legacyIsLive.same) {
    // BIND THE LISTING TO THE DIRECTORY THAT WAS JUDGED.
    //
    // `sameDirectory` decided "not the live WAL" by observing the path; the
    // `readdir` below re-opens the same PATHNAME. A component swapped in between
    // means the names listed belong to a different directory than the one that
    // was cleared — possibly the live fence, whose records would then be printed
    // with review-and-remove wording. This is the identity-window defect that
    // was fixed in the discovery scanner and left standing here; a second copy
    // is how the first survives (cross-host review CRITICAL).
    //
    // The binding is by DETECTION: re-check identity after the listing and
    // refuse to report anything if it moved.
    //
    // STATED LIMIT, because the discovery scanner's residual list says the same
    // thing about its own copy and this one is weaker. The question asked here is
    // RELATIONAL — "is the legacy directory still a different directory from the
    // live one?" — not "is it still the SAME directory I classified?". So a
    // replacement of legacy with some THIRD directory is invisible: it answers
    // `same: false` before and after, and the names below then belong to the
    // replacement. The harmful direction is a replacement that is EMPTY, which
    // drops the block entirely while the real pre-upgrade records live on
    // wherever the original was moved to.
    //
    // Not closed here on purpose (owner decision, option (a) on this slice): it
    // needs write access inside the operator's own checkout to provoke, and an
    // adversary with that could delete the legacy records outright for the same
    // effect. Closing it means capturing the legacy directory's OWN identity
    // before the listing and comparing that identity afterwards — what
    // `legacy-egress-discovery.mjs` does — which is a different seam than
    // `sameDirectoryImpl` and is deferred rather than done silently.
    let legacyNames = [];
    try {
      legacyNames = (await readdir(legacyIntentDir)).filter((n) => n.endsWith('.json'));
    } catch (err) {
      if (err?.code !== 'ENOENT') {
        return blockedSection([`the legacy egress intent WAL at ${pointer(repoRoot, legacyIntentDir)} is unscannable (${err?.code ?? 'error'}); refusing a send that cannot be fenced against a pre-upgrade attempt.`]);
      }
    }
    const stillDistinct = await sameDirectoryImpl(legacyIntentDir, intentDir);
    if (stillDistinct.unknown || stillDistinct.same) {
      return blockedSection([`the legacy egress intent WAL at ${pointer(repoRoot, legacyIntentDir)} changed identity while it was being read; refusing a send that cannot be fenced against a pre-upgrade attempt.`]);
    }
    if (legacyNames.length > 0) {
      // Names go through the same defusing rule the modern scan uses. They were
      // interpolated raw here, which is the injection the WAL scan already
      // fences: a filename carrying a newline and an ANSI escape forges an
      // instruction line in an operator-facing message.
      const shown = legacyNames.map(safeRecordName).join(', ');
      // The advice is NOT "delete that directory", and the difference is a
      // safety property rather than wording. The legacy format carries no
      // wire_disposition and a pre-upgrade pending record may carry no pid — and
      // this runtime deliberately reads a missing process identity as UNKNOWN
      // rather than dead (see classifyClaimHolder). So an old sender may still be
      // running, and a flat delete instruction can free the name for a second
      // delivery to the same phone. Directory-level removal is worse again: it
      // takes records this runtime never examined.
      // The last sentence names the command that closes this scan's own blind
      // spot. Saying "other checkouts need the same review" without saying HOW
      // left the operator to invent a search — and the obvious invention is a
      // `find` plus a bulk delete, which is precisely the unsafe shape the
      // wording above exists to avoid.
      return blockedSection([`legacy egress intents predating the machine-global WAL move are present at ${pointer(repoRoot, legacyIntentDir)} (${shown}); an attempt recorded by the older runtime may already have reached the phone, and — because that format records no process identity — one may still be in flight. Make sure no older proof is running, check the phone, then remove the specific records you reviewed; the WAL now lives at ${machinePointer(homeDir, intentDir)}. This scan only sees the CURRENT checkout: run \`runtime:migrate legacy-egress-intents\` for the read-only machine-scoped inventory of the other checkouts, and apply the same review to whatever it reports.`]);
    }
  }

  // Synthetic event: closed-vocab kind response-needed (urgency NORMAL by
  // contract — approval is the only urgent-by-contract kind, and a proof that
  // bypassed quiet hours would prove the wrong thing), unique subject →
  // unique event_id (structurally bypasses dedupe and inherits a fresh
  // throttle key), 12-hex correlation token carried in the ENUMERATED topic
  // field so the operator can match the phone message (event_id/title/body
  // never reach the provider payload).
  // The random suffix is the PHONE CORRELATION token (it rides in the subject
  // and is surfaced as `subject_suffix`). It is deliberately no longer the WAL
  // filename: the intent is named by the activation fingerprint so that creating
  // it is an exclusive claim per activation (G1). The two roles were only ever
  // sharing a value by accident.
  const suffix = randomBytes(6).toString('hex');
  const ownerToken = randomBytes(12).toString('hex');
  // Self-review finding: this sat outside every try, so an unwritable or missing
  // temp dir escaped as an exception and crashed runDoctor rather than reporting
  // `blocked` — the same defect class the durable-publish rewiring closed on the
  // WAL writes. Nothing has been created yet at this point, so there is nothing
  // to clean up on the failure path.
  let tempRepo;
  try {
    tempRepo = await mkdtemp(join(tmpdir(), 'agentic-egress-proof-'));
  } catch (err) {
    return blockedSection([`the ephemeral temp repo for the proof could not be created (${err?.code ?? 'error'}); no send was attempted.`]);
  }
  let section;
  try {
    const repoIdent = deriveRepoIdent(tempRepo);
    const subject = `egress-proof-${suffix}`;
    const eventId = buildEventId({ repoIdent, kind: 'response-needed', subject });
    const ranAt = now.toISOString();
    const attemptHash = createHash('sha256').update([EGRESS_ATTEMPT_HASH_DOMAIN, eventId, ranAt].join('\u0000')).digest('hex');
    // activationFingerprint is computed once at the re-send gate above and reused
    // here for the WAL writes + provider_ack (the gate scopes the fence by it).
    const event = {
      event_id: eventId,
      source: 'runtime:doctor',
      title: 'agentic-plugins egress proof (synthetic)',
      kind: 'response-needed',
      urgency: 'normal',
      topic: subject,
    };

    // WRITE-AHEAD intent, then send, then resolve — but the write-ahead is a
    // CLAIM, not a plain write (G1, ADR-0048 residuals (a)+(b)). The record is
    // named by the activation fingerprint and published with link(2), so the act
    // that establishes the fence is the same act that excludes a concurrent
    // sender: there is no separate lock, and therefore no stale-takeover policy
    // to get wrong. `owner_token`/`pid`/`acquired_at` ride along for exactly two
    // purposes — choosing the blocker wording a later contender sees, and NAMING
    // this attempt's terminal record so it can never land on another attempt's.
    // They are NEVER takeover authority: nothing in this file breaks, replaces or
    // removes a record, whether or not it made it.
    const intentPath = join(intentDir, egressClaimName(activationFingerprint));
    const claim = await publishJsonExclusive(intentPath, {
      status: 'pending',
      subject,
      attempt_hash: attemptHash,
      ran_at: ranAt,
      activation_fingerprint: activationFingerprint,
      owner_token: ownerToken,
      pid: process.pid,
      acquired_at: ranAt,
      // The machine home is the anchor: everything below it on the way to the
      // intent dir is created by this code and must be proven durable, and the
      // home itself is the caller's precondition rather than its own artifact.
    }, { ancestorAnchor: homeDir });
    if (!claim.ok) {
      // No durable claim ⇒ no send. Every path here returns rather than throws:
      // a read-only or full home used to escape this function as an exception
      // and crash `runDoctor` instead of reporting `blocked`.
      if (claim.reason === 'name-taken') {
        // The scan found nothing to fence yet the name is taken, so another
        // attempt claimed it between the two. This is the ONLY way that can
        // happen: a claim is never removed by this code, so the name cannot have
        // been re-occupied by anything but a genuinely concurrent attempt (or an
        // operator putting something there by hand, which reads the same).
        return blockedSection([`another egress proof attempt claimed this activation concurrently under ${machinePointer(homeDir, intentDir)}; re-run once it completes. Automatic resend is prohibited.`]);
      }
      return blockedSection([`the egress intent could not be recorded durably before the send (${claim.reason}: ${claim.diagnostic}); refusing to send without a fence that would survive a crash.`]);
    }
    if (claim.limit) limits.push(claim.limit);

    // PIN the activation (G1 / T1). The fence, the WAL fingerprint and the
    // recipient actually sent to must describe ONE activation, and until now
    // they only did so by luck: doctor resolves activation at preflight, and
    // `runEmit` resolves it AGAIN, independently, from a loader whose
    // channel/recipient fall back to a MUTABLE verified-local TOML file
    // (egress-config.mjs resolveEgressScalars). An edit between the two reads
    // would let this process hold a claim keyed on activation A while the send
    // went to B — and a second process could legitimately hold B's claim and
    // send to B too. Neither the claim nor a lock closes that; only pinning does.
    //
    // The pin rides in an env OVERLAY rather than a new emitter parameter,
    // because resolveEgressScalars is env-FIRST: setting the two scalars makes
    // what doctor resolved authoritative for the emitter's own resolve, without
    // touching the ADR-0041 §2c override rule or every other runEmit caller.
    // The overlay is a COPY — mutating the shared `env` would leak the pin into
    // the control-plane probe environment. The credential is env-only by
    // contract (it has no file source, so it cannot drift) and is copied through
    // untouched; its value is never read here.
    const emitEnv = {
      ...env,
      [EGRESS_ENV_KEYS.channel]: activation.channel,
      [EGRESS_ENV_KEYS.recipient]: activation.recipient,
    };
    const emit = emitImpl ?? runEmit;
    let emitResult;
    try {
      emitResult = await emit({ eventText: JSON.stringify(event), repoRoot: tempRepo, homeDir, env: emitEnv });
    } catch (err) {
      emitResult = { status: 'failed', stage: 'egress', reason: `emit-error:${err?.code ?? 'exception'}` };
    }

    // Correlated mirror: EXACTLY one well-formed dispatched row for this
    // event id in the temp repo\u2019s log. The mirror is best-effort inside the
    // emitter, so its absence after a dispatched return is fail-closed \u2014 the
    // attempt is unverifiable, not passed.
    let mirrorCorrelated = false;
    let mirrorReason = 'mirror-missing';
    try {
      const logText = await readFile(join(tempRepo, '.agentic-plugins', 'state', 'runtime', 'notify', 'log.ndjson'), 'utf8');
      const rows = logText.split('\n').filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } });
      const matches = rows.filter((row) => row && row.event_id === eventId && row.egress_channel === 'telegram' && row.egress_phase === 'outcome');
      if (matches.length === 1 && matches[0].egress_status === 'dispatched' && matches[0].egress_outcome === 'dispatched') {
        mirrorCorrelated = true;
        mirrorReason = 'dispatched';
      } else if (matches.length > 1) {
        mirrorReason = 'mirror-ambiguous';
      }
    } catch { /* mirror-missing */ }

    const dispatched = emitResult?.status === 'dispatched';
    const acked = dispatched && mirrorCorrelated;
    // Closed-enum reason projection — never the raw emitter reason string
    // (full-report sanitization: the artifact records enums and hashes only).
    // runEmit's egress-path reasons carry an `egress-` prefix
    // (`egress-missing-token`, `egress-throttled`); its pipeline-suppression
    // reasons do not (`kinds-filter`, `dedupe-duplicate`, `channel-none`).
    // Strip the prefix before matching so both families project onto the enum
    // instead of collapsing to emit-error.
    const rawReason = String(emitResult?.reason ?? '');
    const strippedReason = rawReason.startsWith('egress-') ? rawReason.slice('egress-'.length) : rawReason;
    const projected = EGRESS_ACK_OUTCOME_REASONS.find((candidate) => strippedReason === candidate || strippedReason.startsWith(`${candidate}`))
      ?? (dispatched ? 'mirror-missing' : 'emit-error');
    const outcomeReason = acked ? 'dispatched' : dispatched ? mirrorReason : projected;

    // Wire disposition is the SINGLE source that separates the effects honesty
    // claim (network_request_performed = provably 'wire') from the re-send gate
    // block key ('wire' OR 'unknown' both fence a resend). Computed BEFORE the
    // terminal write so the WAL records it (gap 1: the gate blocks on the
    // disposition, not only on a crash-pending), scoped by activation_fingerprint
    // (gap 2). A dispatched return (mirror questions notwithstanding, a lost
    // mirror still sent the message) or a failure at/after the wire
    // (provider-error/rejected, timeout, redirect-error) is 'wire'; an emit-error
    // is 'unknown' (runEmit no-throw breach, could be post-wire); everything else
    // stopped before any network I/O.
    const wireDisposition = classifyWireDisposition(dispatched, outcomeReason);
    const networkPerformed = wireDisposition === 'wire';

    // Terminal write: an APPEND, at this attempt's own name. Not a replace of
    // the claim, not a removal of it — a second exclusive create, at
    // `<fingerprint>.<owner_token>.terminal.json`, a name no other attempt can
    // produce. Nothing published is ever mutated, so there is no ownership
    // question to answer and no window in which the answer could go stale.
    //
    // That is the end of a four-round argument, and the shape of the argument is
    // worth more than the conclusion. Each round kept the goal ("do not let a
    // second message reach the phone") and changed HOW the record at the
    // canonical name was updated: remove it, take it aside and verify, replace
    // it in place. Each was refuted by the same impossibility from a new angle —
    // deciding that the record at a pathname is still yours cannot be atomic. The
    // last one is the instructive one, because it looked airtight: rename(2)
    // never leaves the name absent, so the fence was continuously OCCUPIED. It
    // was still wrong, because occupancy was never the guarantee — CONTENT is. An
    // operator deletion plus a successor's claim, and a stale terminal record
    // would overwrite that successor's live claim with a `no-wire` outcome; the
    // next scan would then read `no-wire` and tell the operator deletion was
    // safe, while the successor's message was already on the phone.
    //
    // Writing to a name only this attempt can produce removes the question
    // instead of answering it faster.
    //
    // The cost is stated rather than hidden: the claim is never cleared either,
    // so after ANY completed attempt — including a pre-wire one that sent
    // nothing — the activation stays fenced until an operator removes both
    // records. The scan tells them which files and whether it is safe.
    //
    // D1(α): a terminal-write failure here does NOT change the proof verdict.
    // The provider ack + mirror correlation are independently true facts, and
    // ADR-0048 §3 defines `passed` as exactly those; folding WAL bookkeeping
    // into the verb would also trip bootstrap's acked-consistency matrix and
    // refuse the import, forcing a SECOND message to the phone to record a proof
    // for one that already arrived. It surfaces as a limit + an overall warning.
    const terminalName = egressTerminalName(activationFingerprint, ownerToken);
    const terminal = await publishJsonExclusive(join(intentDir, terminalName), {
        status: acked ? 'acked' : 'failed',
        subject,
        attempt_hash: attemptHash,
        ran_at: ranAt,
        outcome_reason: outcomeReason,
        wire_disposition: wireDisposition,
        network_request_performed: networkPerformed,
        activation_fingerprint: activationFingerprint,
        owner_token: ownerToken,
      }, { ancestorAnchor: homeDir });
    const walDurability = aggregateWalDurability(claim, terminal);
    if (terminal.limit) limits.push(terminal.limit);
    if (!terminal.ok) {
      // What still fences is no longer a question the primitive has to answer:
      // the claim was never touched, so it stands in every failure case. Only
      // the terminal record's own fate varies, and the primitive's diagnostic
      // says which (staged-but-not-published, or published-but-not-durable).
      limits.push(terminal.reason === 'name-taken'
        ? `the terminal WAL record for this attempt could not be written because its name was already occupied (${terminal.diagnostic}) — that name carries this attempt's own owner token, so nothing legitimate can have produced it. The provider outcome above stands; the pending claim still fences this activation, and the WAL does not record how this attempt ended.`
        : `the intent WAL could not record this attempt's outcome durably (${terminal.reason}: ${terminal.diagnostic}). The provider outcome above stands; the pending claim still fences this activation${terminal.published ? '' : ', so the next attempt is blocked until an operator resolves it'}.`);
    }
    if (wireDisposition === 'no-wire') {
      // The mandatory-cleanup instruction, on the FIRST result rather than the
      // next scan. This attempt stopped before the wire, so its records now fence
      // an activation that nothing was ever sent for — and under an append-only
      // protocol no code will clear them. Saying so here is what makes the
      // friction a stated cost instead of a surprise met one run later.
      //
      // Gated on PUBLICATION, not on `ok`. A post-link directory-fsync failure
      // returns ok:false with published:true — the record IS at its name, only
      // its durability claim failed — and withholding the instruction there
      // would reintroduce the very lateness this branch exists to remove, in
      // exactly one branch.
      //
      // COVERAGE, STATED: no test separates the two gates. Mutation-measured —
      // changing `terminal.published` back to `terminal.ok` here fails nothing.
      // Reaching the difference needs a publish that links and then fails its
      // directory fsync, and `runDoctor` exposes no seam for the WAL's ops
      // (deliberately: the injectable-ops surface is the primitive's, not the
      // verb's). The measured darwin behaviour makes it unreachable with real
      // ops too — `open(dir,'r')+sync()` succeeds even against a mode-0500
      // directory, which is why EACCES here is treated as a fault rather than a
      // platform limit. What differs between the two gates is one operator
      // sentence in an already-degraded branch, not the fence.
      limits.push(terminal.published
        ? `this attempt stopped BEFORE any message was sent (${outcomeReason}), and its two WAL records (${egressClaimName(activationFingerprint)}, ${terminalName}) under ${machinePointer(homeDir, intentDir)} now fence this activation. Nothing reached the phone, so deleting BOTH is safe and is all that is needed to retry. They are not removed automatically: this code never removes a published record, which is what keeps a concurrent attempt's fence intact.`
        // Nothing was published, so this message may NOT name a file to remove.
        // The fact is about this ATTEMPT; a removal instruction would be about a
        // NAME, and by the time an operator acted on it the claim could belong
        // to a different attempt — check-then-act moved into their hands, which
        // is the same mistake this whole slice exists to stop making in code.
        : `this attempt stopped BEFORE any message was sent (${outcomeReason}), but its outcome could not be recorded, so the WAL cannot say so on its own: the next run will read the pending claim and report it as unresolved. Nothing reached the phone from THIS attempt. Re-run to get an instruction computed from the WAL's actual state rather than from this message.`);
    }

    section = {
      requested: true,
      executed: true,
      mode: 'explicit_egress_executor',
      status: acked ? 'passed' : 'failed',
      // Every COMPLETED attempt carries provider_ack (a failed attempt is
      // evidence too — omitting it would degrade an executed failure to
      // \u201cabsent\u201d at the reducer).
      // `provider_ack.result` records the PROVIDER FACT only — the schema's
      // providerAck $def pins it as "proves exactly that the pinned provider
      // request returned HTTP 2xx + {ok:true}", and the limits above say the
      // mirror is not provider evidence. A dispatched return with a lost
      // mirror is therefore result=acked inside a FAILED proof (status +
      // outcome_reason carry the mirror fail-close); folding the mirror into
      // `result` would overwrite an independent true fact.
      provider_ack: {
        result: dispatched ? 'acked' : 'failed',
        attempt_hash: attemptHash,
        activation_fingerprint: activationFingerprint,
        ran_at: ranAt,
      },
      outcome_reason: outcomeReason,
      mirror_correlated: mirrorCorrelated,
      network_request_performed: networkPerformed,
      // D1(α) — the WAL's own health, reported ALONGSIDE the verdict rather than
      // folded into it. `durable` = claim and terminal record both reached disk;
      // `degraded` = published but the directory entry could not be fsynced on
      // this platform; `failed` = the terminal record was not written.
      wal_durability: walDurability,
      // Reported SEPARATELY from durability, because it is a different fact: the
      // record reached disk and the fence stands, but a temp file this code
      // created could not be removed and now sits in a directory retention is
      // forbidden to sweep. Folding it into `wal_durability` would have made the
      // existing warning ("the fence for a future attempt may not [stand]")
      // false. Peer round-6 MINOR: without a field of its own it reached only
      // `limits`, and `bootstrap resume` forwards overall warnings — so the one
      // consumer that would act on it never saw it.
      wal_debris: Boolean(claim.debris || terminal.debris),
      // Phone correlation: the operator matches this token against the
      // message\u2019s topic line; the raw event id stays in ephemeral/local
      // state only, never in durable artifacts.
      subject_suffix: suffix,
      blockers: [],
      limits,
    };
  } finally {
    await rm(tempRepo, { recursive: true, force: true }).catch(() => {});
  }
  return section;
}

async function buildDeepPeerSmokeSection({
  requested,
  execute,
  readiness,
  companion,
  modelEffort,
  repoRoot,
  env,
  runner,
  timeoutMs,
}) {
  const directions = {};
  for (const key of ['claude_to_codex', 'codex_to_claude']) {
    const directionReadiness = readiness[key];
    const companionDirection = companion.directions[key];
    const directionSettings = modelEffort.directions[key];
    const blocked = directionReadiness.blockers.length > 0;
    const direction = {
      direction: directionReadiness.direction,
      requested,
      execution: execute && requested && !blocked ? 'pending' : 'not_executed',
      status: !requested ? 'not_requested' : blocked ? directionReadiness.status : 'ready_with_warnings',
      plan: requested
        ? execute
          ? 'explicit executor requested; peer agent is invoked through the companion contract when readiness is not blocked'
          : 'plan-only preflight; no peer agent is executed by runtime:doctor'
        : 'not requested',
      model: directionSettings.model,
      effort: directionSettings.effort,
      blockers: directionReadiness.blockers,
      warnings: directionReadiness.warnings,
      result: null,
      next_step: requested
        ? blocked
          ? 'resolve blockers before a future explicit peer smoke executor is attempted'
          : execute
            ? 'inspect the sanitized smoke result metadata; raw peer output is intentionally omitted'
            : 'future executor work may use this preflight to run a manual or explicitly approved peer smoke'
        : 'rerun with --deep-peer-smoke to include this plan-only preflight',
    };
    if (requested && execute && blocked) {
      direction.execution = 'skipped';
      direction.result = {
        status: 'skipped',
        reason: 'readiness blockers prevent live peer execution',
      };
    } else if (requested && execute) {
      direction.result = await executeDeepPeerSmokeDirection({
        key,
        repoRoot,
        companionDirection,
        directionSettings,
        runner,
        env,
        timeoutMs,
      });
      direction.execution = 'executed';
      direction.status = direction.result.status;
      if (direction.result.operator_action_required) {
        direction.next_step = 'operator must satisfy host permission or auth preconditions outside runtime:doctor, then rerun the explicit smoke';
      }
    }
    directions[key] = direction;
  }
  return {
    requested,
    executed: Boolean(requested && execute),
    peer_execution: Boolean(requested && execute),
    mode: execute ? 'explicit_executor' : 'plan_only_preflight',
    status: execute
      ? summarizeDeepPeerSmokeExecutionStatus({ requested, directions })
      : summarizeDeepPeerSmokePlanStatus({ requested, directions }),
    reason: requested
      ? execute
        ? 'runtime:doctor executed the deep peer smoke through the companion contract behind an explicit executor flag'
        : 'runtime:doctor plans the explicit deep peer smoke preflight but does not execute peer agents'
      : 'not requested',
    directions,
    limits: [
      execute
        ? 'Explicit executor; peer agents are invoked only when --deep-peer-smoke and --execute-deep-peer-smoke are both supplied.'
        : 'Plan-only preflight; runtime:doctor does not execute peer agents.',
      'Raw peer stdout is not included in doctor output; only status, exit code, byte count, SHA-256, and timing metadata are reported.',
      'No host-native config, auth, secrets, sandbox, or permission state is mutated.',
      'Codex plugin-hook feature/trust state and permission limits remain visible; no host parity claim is made.',
    ],
  };
}

function summarizeDeepPeerSmokePlanStatus({ requested, directions }) {
  if (!requested) return 'not_requested';
  const statuses = Object.values(directions).map((direction) => direction.status);
  if (statuses.every((status) => !['ready_with_warnings', 'available'].includes(status))) return 'blocked';
  if (statuses.some((status) => !['ready_with_warnings', 'available'].includes(status))) return 'partially_blocked';
  return 'ready_with_warnings';
}

function summarizeDeepPeerSmokeExecutionStatus({ requested, directions }) {
  if (!requested) return 'not_requested';
  const statuses = Object.values(directions).map((direction) => direction.status);
  if (statuses.every((status) => status === 'passed')) return 'passed';
  if (statuses.some((status) => status === 'operator_action_required')) return 'operator_action_required';
  if (statuses.some((status) => ['skipped', 'blocked', 'unavailable', 'unauthenticated', 'not_installed'].includes(status))) return 'blocked';
  return 'failed';
}

async function executeDeepPeerSmokeDirection({
  key,
  repoRoot,
  companionDirection,
  directionSettings,
  runner,
  env,
  timeoutMs,
}) {
  const companionPath = companionDirection.selected?.path;
  if (!companionPath) {
    return {
      status: 'blocked',
      reason: `companion ${companionDirection.filename} is not available`,
    };
  }
  const expectedToken = `RUNTIME_DOCTOR_SMOKE_OK ${companionDirection.peer}`;
  const prompt = buildDeepPeerSmokePrompt({ key, peer: companionDirection.peer, expectedToken });
  const args = [
    companionPath,
    'task',
    '--cwd',
    repoRoot,
    '--output-format',
    'json',
  ];
  if (directionSettings.model.value) args.push('--model', directionSettings.model.value);
  if (directionSettings.effort.value) args.push('--effort', directionSettings.effort.value);
  args.push(prompt);

  const result = await runner(process.execPath, args, {
    cwd: repoRoot,
    env,
    timeoutMs,
  });
  return summarizeCompanionSmokeResult({ result, companionPath, expectedToken });
}

function buildDeepPeerSmokePrompt({ key, peer, expectedToken }) {
  return [
    '<task>',
    `Runtime doctor deep peer smoke for ${key}. Reply with exactly one short line: ${expectedToken}.`,
    '</task>',
    '',
    '<grounding_rules>',
    '<rule>Do not inspect or modify repository files.</rule>',
    '<rule>Do not include secrets, account details, or environment values.</rule>',
    '<rule>This is a liveness smoke only; do not perform broader analysis.</rule>',
    '</grounding_rules>',
    '',
    '<expected_output>',
    expectedToken,
    '</expected_output>',
  ].join('\n');
}

async function buildWorkflowContinuationProofSection({
  requested,
  execute,
  readiness,
  modelEffort,
  repoRoot,
  homeDir,
  env,
  runner,
  timeoutMs,
  selfUrl = import.meta.url,
}) {
  const directionSpecs = {
    claude_to_codex: {
      host: 'claude',
      peer: 'codex',
      branch: 'runtime-workflow-proof-claude-to-codex',
      expectedToken: 'RUNTIME_WORKFLOW_CONTINUATION_OK codex',
    },
    codex_to_claude: {
      host: 'codex',
      peer: 'claude',
      branch: 'runtime-workflow-proof-codex-to-claude',
      expectedToken: 'RUNTIME_WORKFLOW_CONTINUATION_OK claude',
    },
  };
  const directions = {};
  for (const key of ['claude_to_codex', 'codex_to_claude']) {
    const directionReadiness = readiness[key];
    const directionSettings = modelEffort.directions[key];
    const spec = directionSpecs[key];
    const blocked = directionReadiness.blockers.length > 0;
    const direction = {
      direction: directionReadiness.direction,
      requested,
      execution: execute && requested && !blocked ? 'pending' : 'not_executed',
      status: !requested ? 'not_requested' : blocked ? directionReadiness.status : 'ready_with_warnings',
      plan: requested
        ? execute
          ? 'explicit workflow continuation executor requested; runtime creates temporary engineer state, dispatches a peer through engineer dispatch-peer, then commits the ensemble result'
          : 'plan-only workflow continuation preflight; no peer agent or workflow state mutation is executed by runtime:doctor'
        : 'not requested',
      model: directionSettings.model,
      effort: directionSettings.effort,
      workflow: {
        host: spec.host,
        peer: spec.peer,
        branch: spec.branch,
        temp_repo: execute && requested && !blocked ? 'ephemeral_tmpdir' : null,
      },
      blockers: directionReadiness.blockers,
      warnings: [
        ...directionReadiness.warnings,
        execute
          ? 'workflow continuation executor requested; engineer state writes are confined to an ephemeral temp repo'
          : 'workflow continuation proof is plan-only until --execute-workflow-continuation-proof is supplied',
      ],
      result: null,
      next_step: requested
        ? blocked
          ? 'resolve blockers before executing workflow continuation proof'
          : execute
            ? 'inspect sanitized workflow continuation metadata; raw peer output and prompt text are intentionally omitted'
            : 'rerun with --workflow-continuation-proof --execute-workflow-continuation-proof to prove engineer workflow state and dispatch'
        : 'rerun with --workflow-continuation-proof to include this workflow continuation preflight',
    };
    if (requested && execute && blocked) {
      direction.execution = 'skipped';
      direction.result = {
        status: 'skipped',
        reason: 'readiness blockers prevent workflow continuation proof execution',
      };
    } else if (requested && execute) {
      direction.result = await executeWorkflowContinuationProofDirection({
        key,
        spec,
        repoRoot,
        homeDir,
        selfUrl,
        directionSettings,
        runner,
        env,
        timeoutMs,
      });
      direction.execution = 'executed';
      direction.status = direction.result.status;
      if (direction.result.operator_action_required) {
        direction.next_step = 'operator must satisfy host permission or auth preconditions outside runtime:doctor, then rerun workflow continuation proof';
      }
    }
    directions[key] = direction;
  }
  return {
    requested,
    executed: Boolean(requested && execute),
    peer_execution: Boolean(requested && execute),
    workflow_state: requested && execute ? 'ephemeral_temp_repo' : 'none',
    mode: !requested ? 'not_requested' : execute ? 'explicit_engineer_workflow_executor' : 'plan_only_preflight',
    status: execute
      ? summarizeWorkflowContinuationProofExecutionStatus({ requested, directions })
      : summarizeWorkflowContinuationProofPlanStatus({ requested, directions }),
    reason: requested
      ? execute
        ? 'runtime:doctor executed an engineer workflow continuation proof behind an explicit executor flag'
        : 'runtime:doctor plans the workflow continuation preflight but does not execute peer agents or mutate workflow state'
      : 'not requested',
    directions,
    limits: [
      execute
        ? 'Explicit executor; peer agents are invoked only when --workflow-continuation-proof and --execute-workflow-continuation-proof are both supplied.'
        : 'Plan-only preflight; runtime:doctor does not execute peer agents or mutate workflow state.',
      'The executor creates workflow files only inside an ephemeral temp repo, then removes that temp repo best-effort.',
      'The executor uses engineer state.mjs create/read/ensemble-commit and engineer dispatch-peer.mjs; direct companion smoke alone is insufficient for this proof.',
      'Raw peer stdout and prompt text are not included in doctor output; only status, exit codes, byte count, SHA-256, timing metadata, and state-check booleans are reported.',
      'No host-native config, auth, secrets, sandbox, permission, or repository source state is mutated.',
    ],
  };
}

function summarizeWorkflowContinuationProofPlanStatus({ requested, directions }) {
  if (!requested) return 'not_requested';
  const statuses = Object.values(directions).map((direction) => direction.status);
  if (statuses.every((status) => !['ready_with_warnings', 'available'].includes(status))) return 'blocked';
  if (statuses.some((status) => !['ready_with_warnings', 'available'].includes(status))) return 'partially_blocked';
  return 'ready_with_warnings';
}

function summarizeWorkflowContinuationProofExecutionStatus({ requested, directions }) {
  if (!requested) return 'not_requested';
  const statuses = Object.values(directions).map((direction) => direction.status);
  if (statuses.every((status) => status === 'passed')) return 'passed';
  if (statuses.some((status) => status === 'operator_action_required')) return 'operator_action_required';
  if (statuses.some((status) => status === 'timed_out')) return 'timed_out';
  if (statuses.some((status) => ['skipped', 'blocked', 'unavailable', 'unauthenticated', 'not_installed'].includes(status))) return 'blocked';
  return 'failed';
}

const ENGINEER_ROOT_ENV_OVERRIDE = 'AGENTIC_ENGINEER_ROOT';

function engineerCacheBases(home) {
  return {
    claude: join(home, '.claude', 'plugins', 'cache', 'agentic-plugins', 'engineer'),
    codex: join(home, '.codex', '.tmp', 'marketplaces', 'agentic-plugins', 'plugins', 'engineer'),
  };
}

async function isReadableFile(path) {
  try {
    await access(path, fsConstants.R_OK);
    const st = await stat(path);
    return st.isFile();
  } catch {
    return false;
  }
}

// Claude cache is multi-version; pick the SemVer-max install whose manifest name is
// engineer and whose scripts/state.mjs exists.
async function resolveClaudeEngineerCacheRoot(claudeBase) {
  let entries;
  try {
    entries = await readdir(claudeBase, { withFileTypes: true });
  } catch {
    return null;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const versionRoot = join(claudeBase, entry.name);
    let manifest;
    try {
      manifest = JSON.parse(await readFile(join(versionRoot, '.claude-plugin', 'plugin.json'), 'utf8'));
    } catch {
      continue;
    }
    if (manifest?.name !== 'engineer') continue;
    if (!(await isReadableFile(join(versionRoot, 'scripts', 'state.mjs')))) continue;
    candidates.push({ version: typeof manifest.version === 'string' ? manifest.version : '0.0.0', root: versionRoot });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => semverCompare(String(b.version), String(a.version)));
  return candidates[0].root;
}

// Runtime-OWNED resolver for the INSTALLED engineer plugin root
// (machine-bootstrap-contract.md §8.2). The workflow-continuation proof needs the
// engineer tool where it actually lives — the host plugin cache — NOT
// `repoRoot/plugins/engineer`, which is absent on a consumer machine or in the
// ephemeral scratch repo a machine bootstrap points doctor at. Mirrors the
// orchestrator discover-engineer.mjs ladder (env override → Claude cache SemVer-max
// → Codex fixed cache → sibling monorepo) but is a PRIVATE runtime copy: ADR-0010 §5
// forbids importing across plugins. Deliberately does NOT consult repoRoot — that is
// the proof workspace's concern, and conflating the two is the §8.2 defect. Returns
// `{ root, source }` or `null`.
export async function resolveInstalledEngineerRoot({ env = process.env, home = homedir(), selfUrl = import.meta.url } = {}) {
  const override = env[ENGINEER_ROOT_ENV_OVERRIDE];
  if (typeof override === 'string' && override.length > 0) {
    if (isAbsolute(override) && await isReadableFile(join(override, 'scripts', 'state.mjs'))) {
      return { root: override, source: 'env-override' };
    }
    return null;
  }
  const { claude: claudeBase, codex: codexBase } = engineerCacheBases(home);
  const claudeRoot = await resolveClaudeEngineerCacheRoot(claudeBase);
  if (claudeRoot) return { root: claudeRoot, source: 'claude-cache' };
  if (await isReadableFile(join(codexBase, 'scripts', 'state.mjs'))) {
    return { root: codexBase, source: 'codex-cache' };
  }
  // Sibling monorepo — derive runtime's own root from selfUrl (doctor.mjs lives at
  // <runtime-root>/scripts/doctor.mjs), then look for the sibling engineer checkout.
  if (typeof selfUrl === 'string' && selfUrl.length > 0) {
    let here = null;
    try {
      here = fileURLToPath(selfUrl);
    } catch {
      here = null;
    }
    if (here) {
      const sibling = resolve(dirname(here), '..', '..', 'engineer');
      if (await isReadableFile(join(sibling, 'scripts', 'state.mjs'))) {
        return { root: sibling, source: 'sibling-monorepo' };
      }
    }
  }
  return null;
}

async function executeWorkflowContinuationProofDirection({
  key,
  spec,
  repoRoot,
  homeDir,
  selfUrl,
  directionSettings,
  runner,
  env,
  timeoutMs,
}) {
  // §8.2 — the installed-tool root (host plugin cache), resolved SEPARATELY from the
  // ephemeral proof workspace (tempRepo below). repoRoot is the caller's repo, which
  // on a consumer machine or a bootstrap scratch dir has no plugins/engineer.
  const engineer = await resolveInstalledEngineerRoot({ env, home: homeDir, selfUrl });
  if (!engineer) {
    return {
      status: 'blocked',
      reason: 'engineer plugin not found — install engineer, or set AGENTIC_ENGINEER_ROOT to a plugin checkout (resolver ladder: env override → Claude cache → Codex cache → sibling monorepo)',
      installed_tool_root: null,
      tool_root_source: 'none',
    };
  }
  const statePath = join(engineer.root, 'scripts', 'state.mjs');
  const dispatchPath = join(engineer.root, 'scripts', 'dispatch-peer.mjs');
  const missingScript = await firstMissingReadablePath([
    { label: 'engineer state script', path: statePath },
    { label: 'engineer dispatch script', path: dispatchPath },
  ]);
  if (missingScript) {
    return {
      status: 'blocked',
      reason: `${missingScript.label} is not readable`,
      missing_path: missingScript.path,
      installed_tool_root: engineer.root,
      tool_root_source: engineer.source,
    };
  }

  const tempRepo = await mkdtemp(join(tmpdir(), 'runtime-workflow-proof-'));
  const runId = `workflow-proof-${key}`;
  const stateChecks = {
    workflow_created: false,
    pending_recorded: false,
    commit_recorded: false,
    pending_cleared: false,
  };
  let workflowId = null;
  try {
    const gitInit = await runner('git', ['init', '-q', '-b', spec.branch], {
      cwd: tempRepo,
      env,
      timeoutMs,
    });
    if (!gitInit.ok) {
      return summarizeWorkflowContinuationCommandFailure({
        command: 'git init',
        result: gitInit,
        status: gitInit.timed_out ? 'timed_out' : 'blocked',
        reason: 'temporary proof repo could not be initialized',
        stateChecks,
      });
    }

    const createResult = await runner(process.execPath, [
      statePath,
      'create',
      '--repo-root',
      tempRepo,
      '--verb',
      'compose',
      '--host',
      spec.host,
      '--git-baseline-branch',
      spec.branch,
      '--git-baseline-head',
      'workflow-continuation-proof',
      '--original-request',
      'runtime doctor workflow continuation proof',
      '--current-phase',
      'compose',
      '--next-action',
      'dispatch workflow continuation proof',
    ], {
      cwd: tempRepo,
      env,
      timeoutMs,
    });
    if (!createResult.ok) {
      return summarizeWorkflowContinuationCommandFailure({
        command: 'state create',
        result: createResult,
        status: createResult.timed_out ? 'timed_out' : 'failed',
        reason: 'engineer state create failed',
        stateChecks,
      });
    }
    const workflowPath = extractWorkflowPath(createResult.stdout);
    workflowId = workflowPath ? basename(workflowPath).replace(/\.md$/, '') : null;
    stateChecks.workflow_created = Boolean(workflowPath);
    if (!workflowPath) {
      return summarizeWorkflowContinuationCommandFailure({
        command: 'state create',
        result: createResult,
        status: 'failed',
        reason: 'engineer state create did not return a workflow path',
        stateChecks,
      });
    }

    const expectedToken = spec.expectedToken;
    const dispatchArgs = [
      dispatchPath,
      '--peer',
      spec.peer,
      '--prompt-text',
      buildWorkflowContinuationProofPrompt({ key, peer: spec.peer, expectedToken }),
      '--output-format',
      'json',
      '--cwd',
      tempRepo,
      '--workflow-path',
      workflowPath,
      '--phase',
      'compose',
      '--ensemble-type',
      'workflow-continuation-proof',
      '--run-id',
      runId,
    ];
    if (directionSettings.model.value) dispatchArgs.push('--model', directionSettings.model.value);
    if (directionSettings.effort.value) dispatchArgs.push('--effort', directionSettings.effort.value);
    const dispatchResult = await runner(process.execPath, dispatchArgs, {
      cwd: tempRepo,
      env,
      timeoutMs,
    });
    const dispatchSummary = summarizeCompanionSmokeResult({
      result: dispatchResult,
      companionPath: relative(repoRoot, dispatchPath),
      expectedToken,
    });

    const pendingRead = await readWorkflowFrontmatterWithRunner({
      runner,
      statePath,
      workflowPath,
      cwd: tempRepo,
      env,
      timeoutMs,
      stateChecks,
      command: 'state read after dispatch',
    });
    if (!pendingRead.ok) {
      return {
        ...dispatchSummary,
        ...pendingRead.failure,
        status: pendingRead.failure.status,
        workflow: workflowProofWorkflowSummary({ spec, runId, workflowId }),
      };
    }
    stateChecks.pending_recorded = hasWorkflowPendingRun(pendingRead.frontmatter, runId);

    if (dispatchSummary.status !== 'passed') {
      return {
        ...dispatchSummary,
        status: dispatchSummary.status,
        workflow: workflowProofWorkflowSummary({ spec, runId, workflowId }),
        state_checks: stateChecks,
      };
    }

    const commitResult = await runner(process.execPath, [
      statePath,
      'ensemble-commit',
      '--workflow-path',
      workflowPath,
      '--run-id',
      runId,
      '--phase',
      'compose',
      '--ensemble-type',
      'workflow-continuation-proof',
      '--verdict',
      'passed',
      '--summary',
      'runtime doctor workflow continuation proof passed',
    ], {
      cwd: tempRepo,
      env,
      timeoutMs,
    });
    if (!commitResult.ok) {
      return summarizeWorkflowContinuationCommandFailure({
        command: 'state ensemble-commit',
        result: commitResult,
        status: commitResult.timed_out ? 'timed_out' : 'failed',
        reason: 'engineer ensemble commit failed',
        workflow: workflowProofWorkflowSummary({ spec, runId, workflowId }),
        stateChecks,
      });
    }

    const committedRead = await readWorkflowFrontmatterWithRunner({
      runner,
      statePath,
      workflowPath,
      cwd: tempRepo,
      env,
      timeoutMs,
      stateChecks,
      command: 'state read after commit',
    });
    if (!committedRead.ok) {
      return {
        ...dispatchSummary,
        ...committedRead.failure,
        status: committedRead.failure.status,
        workflow: workflowProofWorkflowSummary({ spec, runId, workflowId }),
      };
    }
    stateChecks.pending_cleared = !hasWorkflowPendingRun(committedRead.frontmatter, runId);
    stateChecks.commit_recorded = hasWorkflowEnsembleResult(committedRead.frontmatter, runId);
    const passed = stateChecks.workflow_created &&
      stateChecks.pending_recorded &&
      stateChecks.pending_cleared &&
      stateChecks.commit_recorded;
    return {
      ...dispatchSummary,
      status: passed ? 'passed' : 'failed',
      // §8.2 — the two roots are distinct: the installed tool (host cache / env / sibling)
      // and the ephemeral proof workspace the run happened IN.
      installed_tool_root: engineer.root,
      tool_root_source: engineer.source,
      workflow: workflowProofWorkflowSummary({ spec, runId, workflowId }),
      state_checks: stateChecks,
      state_failure: passed ? null : 'engineer state did not record pending and committed ensemble continuation as expected',
    };
  } finally {
    try {
      await rm(tempRepo, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup; temp proof state is explicitly non-authoritative.
    }
  }
}

function buildWorkflowContinuationProofPrompt({ key, peer, expectedToken }) {
  return [
    '<task>',
    `Runtime doctor workflow continuation proof for ${key}. Reply with exactly one short line: ${expectedToken}.`,
    '</task>',
    '',
    '<grounding_rules>',
    '<rule>Do not inspect or modify repository source files.</rule>',
    '<rule>Do not include secrets, account details, environment values, or prompt text.</rule>',
    '<rule>This proves the engineer workflow dispatch path only; do not perform broader analysis.</rule>',
    '</grounding_rules>',
    '',
    '<expected_output>',
    expectedToken,
    '</expected_output>',
  ].join('\n');
}

async function firstMissingReadablePath(entries) {
  for (const entry of entries) {
    try {
      await access(entry.path, fsConstants.R_OK);
    } catch {
      return entry;
    }
  }
  return null;
}

function extractWorkflowPath(stdout) {
  const line = String(stdout ?? '').trim().split(/\r?\n/).filter(Boolean).at(-1);
  return line || null;
}

async function readWorkflowFrontmatterWithRunner({
  runner,
  statePath,
  workflowPath,
  cwd,
  env,
  timeoutMs,
  stateChecks,
  command,
}) {
  const result = await runner(process.execPath, [
    statePath,
    'read',
    '--workflow-path',
    workflowPath,
  ], {
    cwd,
    env,
    timeoutMs,
  });
  if (!result.ok) {
    return {
      ok: false,
      failure: summarizeWorkflowContinuationCommandFailure({
        command,
        result,
        status: result.timed_out ? 'timed_out' : 'failed',
        reason: 'engineer state read failed',
        stateChecks,
      }),
    };
  }
  const frontmatter = parseJsonObject(result.stdout);
  if (!frontmatter) {
    return {
      ok: false,
      failure: summarizeWorkflowContinuationCommandFailure({
        command,
        result,
        status: 'failed',
        reason: 'engineer state read did not return frontmatter JSON',
        stateChecks,
      }),
    };
  }
  return { ok: true, frontmatter };
}

function summarizeWorkflowContinuationCommandFailure({
  command,
  result,
  status,
  reason,
  workflow = null,
  stateChecks,
}) {
  const summary = {
    status,
    command,
    reason,
    companion_exit_code: result.exit_code,
    companion_error_code: result.error_code,
    timed_out: Boolean(result.timed_out),
    stderr_summary: result.stderr ? truncate(sanitizeValue(result.stderr), 200) : null,
    error: {
      kind: sanitizeValue(result.error_code ?? `${command.replace(/\s+/g, '_')}_failed`),
      message: sanitizeValue(result.error_message ?? result.stderr ?? reason),
    },
    workflow,
    state_checks: stateChecks,
  };
  const operatorActionKind = classifyOperatorActionKind(summary);
  return {
    ...summary,
    status: operatorActionKind ? 'operator_action_required' : summary.status,
    operator_action_required: Boolean(operatorActionKind),
    operator_action_kind: operatorActionKind,
  };
}

function workflowProofWorkflowSummary({ spec, runId, workflowId }) {
  return {
    host: spec.host,
    peer: spec.peer,
    branch: spec.branch,
    run_id: runId,
    workflow_id: workflowId,
    temp_repo: 'ephemeral_tmpdir',
  };
}

function hasWorkflowPendingRun(frontmatter, runId) {
  return Array.isArray(frontmatter?.pending_ensemble) &&
    frontmatter.pending_ensemble.some((entry) => entry?.run_id === runId);
}

function hasWorkflowEnsembleResult(frontmatter, runId) {
  return Array.isArray(frontmatter?.ensemble_results) &&
    frontmatter.ensemble_results.some((entry) => entry?.run_id === runId);
}

function summarizeCompanionSmokeResult({ result, companionPath, expectedToken }) {
  const parsed = parseJsonObject(result.stdout);
  const peerStdout = typeof parsed?.stdout === 'string' ? parsed.stdout : '';
  const expectedTokenPresent = peerStdout.includes(expectedToken);
  const passed = result.ok && parsed?.status === 'success' && parsed?.exit_code === 0 && expectedTokenPresent;
  const summary = {
    status: passed ? 'passed' : result.timed_out ? 'timed_out' : 'failed',
    companion_path: companionPath,
    companion_exit_code: result.exit_code,
    companion_error_code: result.error_code,
    timed_out: Boolean(result.timed_out),
    envelope_status: parsed?.status ?? null,
    peer_host: parsed?.peer_host ?? null,
    peer_model: parsed?.peer_model ?? null,
    peer_exit_code: parsed?.exit_code ?? null,
    expected_token_present: expectedTokenPresent,
    stdout_bytes: Buffer.byteLength(peerStdout, 'utf8'),
    stdout_sha256: peerStdout ? sha256(peerStdout) : null,
    peer_stdout_operator_action_kind: passed ? null : classifyOperatorActionText(peerStdout),
    metadata: normalizeSmokeMetadata(parsed?.metadata),
    stderr_summary: result.stderr ? truncate(sanitizeValue(result.stderr), 200) : null,
    error: normalizeSmokeError({ parsed, result }),
  };
  const operatorActionKind = summary.status === 'passed' ? null : classifyOperatorActionKind(summary);
  return {
    ...summary,
    status: operatorActionKind ? 'operator_action_required' : summary.status,
    operator_action_required: Boolean(operatorActionKind),
    operator_action_kind: operatorActionKind,
  };
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeSmokeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  return {
    duration_ms: Number.isFinite(metadata.duration_ms) ? metadata.duration_ms : null,
    started_at: sanitizeValue(metadata.started_at),
    completed_at: sanitizeValue(metadata.completed_at),
  };
}

function normalizeSmokeError({ parsed, result }) {
  if (parsed?.error && typeof parsed.error === 'object') {
    const detailKind = classifyOperatorActionText(parsed.error.detail);
    const error = {
      kind: sanitizeValue(parsed.error.kind),
      message: sanitizeValue(parsed.error.message),
    };
    if (detailKind) error.detail_kind = detailKind;
    return error;
  }
  if (result.ok && parsed) return null;
  return {
    kind: sanitizeValue(result.error_code ?? 'companion_execution_error'),
    message: sanitizeValue(result.error_message ?? result.stderr ?? 'companion did not return a successful JSON envelope'),
  };
}

function buildDirectionReadiness({
  direction,
  caller,
  peer,
  companion,
  requiredPeerFeatures,
  requiredPermissionFeatures,
  deepPeerSmoke,
  executeDeepPeerSmoke,
  sandboxPermissionProbe,
  permissionProof,
  executePermissionProof,
  workflowContinuationProof,
  executeWorkflowContinuationProof,
}) {
  const blockers = [];
  const warnings = [];
  if (caller.status !== 'available') blockers.push(`${caller.name} CLI unavailable`);
  if (peer.status !== 'available') blockers.push(`${peer.name} CLI unavailable`);
  if (peer.auth.status === 'unauthenticated') blockers.push(`${peer.name} unauthenticated`);
  if (peer.auth.status === 'sandbox_limited') blockers.push(`${peer.name} auth probe sandbox-limited`);
  if (peer.auth.status === 'blocked') blockers.push(`${peer.name} auth probe blocked`);
  if (companion.status !== 'available') blockers.push(`companion ${companion.filename} ${companion.status}`);
  for (const feature of requiredPeerFeatures) {
    if (peer.feature_surface[feature] !== true) warnings.push(`${peer.name} feature not observed: ${feature}`);
  }
  if (caller.name === 'codex') {
    // Stage-aware gate (ADR-0030): Codex removed the plugin_hooks flag
    // (>= ~0.134), so on current Codex the bundled-hook gate is generic
    // [features].hooks; only legacy Codex 0.130-0.133 keys readiness on
    // plugin_hooks. Mirror the canonical pluginHooksRemoved/hookGateEnabled
    // gate (see buildCodexPluginHooks) so this readiness warning never tells
    // a current-Codex operator to set the removed [features].plugin_hooks flag.
    const pluginHooksRemoved = caller.feature_surface.codex_plugin_hooks_stage === 'removed';
    const hookGateEnabled = pluginHooksRemoved
      ? caller.feature_surface.codex_global_hooks
      : caller.feature_surface.codex_plugin_hooks;
    warnings.push(hookGateEnabled === true
      ? 'Codex plugin hooks are enabled; bundled lifecycle hooks still require hook review/trust in the active host session'
      : caller.feature_surface.codex_global_hooks === true
        // Reachable only on legacy (non-removed) Codex, where plugin_hooks IS
        // the correct gate; on the removed stage a true global gate takes the
        // branch above, so the legacy flag advice never shows on current Codex.
        ? 'Codex global hooks are available, but bundled plugin hooks require [features].plugin_hooks=true before automatic plugin lifecycle hooks run'
        : 'Codex hooks are not fully enabled in the observed feature surface; bundled plugin lifecycle hooks will not run automatically');
  }
  const sandboxPermission = buildDirectionSandboxPermissionProbe({
    requested: sandboxPermissionProbe,
    direction,
    caller,
    peer,
    companion,
    requiredPermissionFeatures,
  });
  if (sandboxPermission.status !== 'unknown' && sandboxPermission.status !== 'read_only_probe_passed') {
    blockers.push(`sandbox permission probe ${sandboxPermission.status}`);
  }
  if (sandboxPermissionProbe) {
    warnings.push('sandbox/permission probe is read-only; live peer-agent execution remains unverified');
  } else if (permissionProof) {
    warnings.push(executePermissionProof
      ? 'permission proof executor requested; sanitized execution evidence appears under permission_proof'
      : 'permission proof requested but not executed by runtime:doctor');
  } else {
    warnings.push('sandbox/permission readiness is unknown until --sandbox-permission-probe is requested');
  }
  if (!deepPeerSmoke) {
    warnings.push('read-only inference only; no peer-agent smoke executed');
  } else if (executeDeepPeerSmoke) {
    warnings.push('deep peer smoke executor requested; sanitized execution evidence appears under deep_peer_smoke');
  } else {
    warnings.push('deep peer smoke requested but not executed by runtime:doctor v0.1');
  }
  if (!workflowContinuationProof) {
    warnings.push('engineer workflow continuation proof not requested');
  } else if (executeWorkflowContinuationProof) {
    warnings.push('workflow continuation proof executor requested; sanitized execution evidence appears under workflow_continuation_proof');
  } else {
    warnings.push('workflow continuation proof requested but not executed by runtime:doctor');
  }
  return {
    direction,
    status: blockers.length > 0 ? classifyPrimaryBlocker(blockers) : warnings.length > 0 ? 'available_with_warnings' : 'available',
    blockers,
    warnings,
    sandbox_permission: sandboxPermission,
  };
}

function buildDirectionSandboxPermissionProbe({
  requested,
  direction,
  caller,
  peer,
  companion,
  requiredPermissionFeatures,
  peerExecutionEvidence = 'no companion command or peer agent was executed',
}) {
  if (!requested) {
    return {
      direction,
      requested: false,
      executed: false,
      peer_execution: false,
      status: 'unknown',
      reason: 'read-only doctor does not inspect sandbox or permission readiness unless --sandbox-permission-probe is requested',
      probes: [],
    };
  }

  const probes = [
    probeResult({
      name: 'caller_cli_spawn',
      status: caller.status === 'available' ? 'passed' : 'unavailable',
      evidence: `${caller.name} version probe ${caller.version.status}`,
    }),
    probeResult({
      name: 'peer_cli_spawn',
      status: peer.status === 'available' ? 'passed' : 'unavailable',
      evidence: `${peer.name} version probe ${peer.version.status}`,
    }),
    probeResult({
      name: 'peer_auth_status',
      status: peer.auth.status === 'available' ? 'passed' : peer.auth.status,
      evidence: `${peer.name} auth ${peer.auth.status}`,
    }),
    probeResult({
      name: 'companion_script_preflight',
      status: companion.status === 'available' ? 'passed' : companion.status,
      evidence: companion.selected
        ? `${companion.filename} contract ${companion.selected.contract_version ?? 'unknown'}`
        : `${companion.filename} ${companion.status}`,
    }),
    buildPermissionSurfaceProbe(peer, requiredPermissionFeatures),
    probeResult({
      name: 'peer_execution_boundary',
      status: 'passed',
      evidence: peerExecutionEvidence,
    }),
  ];

  const blockers = probes.filter((probe) => probe.status !== 'passed');
  return {
    direction,
    requested: true,
    executed: true,
    peer_execution: false,
    status: blockers.length > 0 ? 'blocked' : 'read_only_probe_passed',
    reason: blockers.length > 0
      ? 'one or more read-only sandbox/permission preflight probes failed'
      : 'read-only sandbox/permission preflight probes passed without executing peers',
    probes,
    blockers: blockers.map((probe) => `${probe.name}: ${probe.status}`),
  };
}

function buildPermissionSurfaceProbe(peer, requiredPermissionFeatures) {
  const missing = requiredPermissionFeatures.filter((feature) => peer.feature_surface[feature] !== true);
  return probeResult({
    name: 'peer_permission_surface',
    status: missing.length === 0 ? 'passed' : 'blocked',
    evidence: missing.length === 0
      ? `${peer.name} exposes ${requiredPermissionFeatures.join(', ')}`
      : `${peer.name} missing ${missing.join(', ')}`,
  });
}

function probeResult({ name, status, evidence }) {
  return {
    name,
    status,
    evidence: sanitizeValue(evidence),
  };
}

function classifyPrimaryBlocker(blockers) {
  if (blockers.some((b) => /unavailable/.test(b))) return 'unavailable';
  if (blockers.some((b) => /unauthenticated/.test(b))) return 'unauthenticated';
  if (blockers.some((b) => /blocked|sandbox-limited/.test(b))) return 'blocked';
  return 'not_installed';
}

function summarizeOverall(report) {
  const hardFailures = [];
  for (const [name, cli] of Object.entries(report.clis)) {
    if (cli.status !== 'available') hardFailures.push(`${name} cli ${cli.status}`);
    if (cli.auth.status === 'unauthenticated') hardFailures.push(`${name} auth unauthenticated`);
    if (cli.auth.status === 'sandbox_limited') hardFailures.push(`${name} auth sandbox_limited`);
  }
  for (const [direction, readiness] of Object.entries(report.readiness)) {
    if (!['available', 'available_with_warnings'].includes(readiness.status)) hardFailures.push(`${direction} ${readiness.status}`);
  }
  if (report.deep_peer_smoke.executed && !['passed', 'operator_action_required'].includes(report.deep_peer_smoke.status)) {
    hardFailures.push(`deep peer smoke ${report.deep_peer_smoke.status}`);
  }
  if (report.permission_proof.executed && !['passed', 'operator_action_required'].includes(report.permission_proof.status)) {
    hardFailures.push(`permission proof ${report.permission_proof.status}`);
  }
  // Egress ack proof: an EXECUTED attempt that did not ack is a hard failure —
  // a real network send happened and the evidence says it did not land as
  // dispatched+mirrored (the failed provider_ack is still recorded evidence).
  if (report.egress_ack_proof.executed && report.egress_ack_proof.status !== 'passed') {
    hardFailures.push(`egress ack proof ${report.egress_ack_proof.status} (${report.egress_ack_proof.outcome_reason ?? 'no-outcome'})`);
  }
  if (report.workflow_continuation_proof.executed && !['passed', 'operator_action_required'].includes(report.workflow_continuation_proof.status)) {
    hardFailures.push(`workflow continuation proof ${report.workflow_continuation_proof.status}`);
  }
  const warnings = [];
  for (const [name, plugin] of Object.entries(report.plugins)) {
    if (!['available', 'source_available'].includes(plugin.status)) warnings.push(`${name} plugin ${plugin.status}`);
  }
  for (const [name, ledger] of Object.entries(report.ledgers)) {
    if (ledger.workflows.status === 'blocked') warnings.push(`${name} workflow files malformed`);
    if (ledger.peer_runs.status === 'blocked') warnings.push(`${name} peer-run ledger needs attention`);
  }
  if (report.settings_runs.status === 'blocked') {
    warnings.push('settings execution artifact health blocked');
  } else {
    // An interrupted write-ahead run (planned / in-progress) is the load-bearing
    // signal (machine-bootstrap-contract.md §1.5) — surface it even though it has
    // zero failures, else the reader migration would be invisible to the operator.
    if (report.settings_runs.interrupted || report.settings_runs.latest?.status === 'refused') {
      warnings.push('latest settings execution is a nonterminal/refused write-ahead record (interrupted run)');
    }
    if (report.settings_runs.latest?.plugin_management?.failed > 0) {
      warnings.push('latest settings plugin-management execution has failures');
    }
    if ((report.settings_runs.latest?.plugin_management?.blocked ?? 0) > 0) {
      warnings.push('latest settings plugin-management execution has blocked actions');
    }
    if ((report.settings_runs.latest?.plugin_cleanup?.failed ?? 0) > 0 || (report.settings_runs.latest?.plugin_cleanup?.blocked ?? 0) > 0) {
      warnings.push('latest settings plugin-cleanup execution has failures');
    }
    if (report.settings_runs.latest?.codex_hook_review?.requested && report.settings_runs.latest.codex_hook_review.status !== 'attested') {
      warnings.push('latest settings Codex hook review attestation was not accepted');
    }
  }
  if (report.consensus_runs.status === 'blocked') {
    warnings.push('consensus execution artifact health blocked');
  } else if (report.consensus_runs.latest?.summary?.failed > 0) {
    const timeoutCount = report.consensus_runs.latest.failure_summary?.timeout ?? 0;
    if (timeoutCount > 0) {
      warnings.push(`latest consensus execution timed out for ${timeoutCount} peer(s); retryable-failed=${report.consensus_runs.latest.summary.failed_retryable}`);
    } else {
      warnings.push('latest consensus execution has failures');
    }
  }
  if (report.compat_runs.status === 'blocked') {
    warnings.push('compatibility artifact health blocked');
  } else if (report.compat_runs.status === 'release_notes_required') {
    warnings.push('latest compatibility check requires release notes');
  } else if (report.compat_runs.status === 'needs_attention') {
    warnings.push('latest compatibility check needs follow-up');
  }
  // ADR-0044 S4 — a half-enabled capture chain is exactly the state the
  // readiness diagnosis exists to surface; `off` and `ready` stay silent.
  // Advisory infrastructure: warnings, never hard failures.
  if (report.session_capture.status === 'blocked') {
    warnings.push(`session capture blocked (${report.session_capture.states.join(', ')})`);
  } else if (report.session_capture.status === 'config-fail-closed') {
    warnings.push('session capture config fail-closed (session config unreadable or invalid)');
  }
  // ADR-0045 S8 — the entry-side hook-chain mirror; same advisory posture.
  if (report.entry_brief.status === 'blocked') {
    warnings.push(`entry brief hook chain blocked (${report.entry_brief.states.join(', ')})`);
  } else if (report.entry_brief.status === 'config-fail-closed') {
    warnings.push('entry brief config fail-closed (entry-brief config unreadable or invalid)');
  }
  if (report.artifact_inventory?.executed && report.artifact_inventory.status === 'blocked') {
    warnings.push('runtime artifact inventory blocked');
  } else if (report.artifact_inventory?.executed && report.artifact_inventory.status === 'needs_attention') {
    // ADR-0047 §7 — a registry family (doctor/compat/settings) over cap ONLY
    // because its runs are pinned (cited / live / latest) is informational, not
    // a fault. Consult the retention reconciliation: warn only when genuine
    // (non-demoted) attention remains, and always warn if the pin scan itself
    // could not complete. Non-registry families keep their raw over-cap fault.
    const reconciled = report.retention?.executed ? report.retention.reconciled : null;
    const stillFaulted = reconciled ? reconciled.attention.length > 0 : true;
    if (stillFaulted) warnings.push('runtime artifact inventory exceeds retention guidance');
  } else if (report.retention?.executed && report.retention.scan_complete === false) {
    // Inventory itself was within caps, but a pin source could not be fully
    // evaluated — surface the fail-closed state so the operator knows deletion
    // is withheld (an unscannable source is treated as citing everything).
    warnings.push('runtime retention pin scan incomplete (deletion withheld)');
  }
  // A retention section that FAILED to compute (planner exception) must not
  // headline as pass on an otherwise-clean inventory (Codex review MINOR).
  if (report.retention?.requested && report.retention.executed === false && report.retention.status === 'blocked') {
    warnings.push('runtime retention plan blocked (planner failed)');
  }
  // The machine scope has its OWN status; the top-level status is repo-only by
  // design (backward compatibility). Without this, an unreadable machine home or a
  // bootstrap family over its cap would headline `pass` — doctor reporting healthy on
  // an inventory ADR-0046 §4 makes mandatory.
  if (report.artifact_inventory?.executed && report.artifact_inventory.machine?.status === 'blocked') {
    warnings.push('machine-global artifact inventory blocked');
  } else if (report.artifact_inventory?.executed && report.artifact_inventory.machine?.status === 'needs_attention') {
    warnings.push('machine-global artifact inventory exceeds retention guidance');
  }
  if (report.permission_diagnosis?.executed && report.permission_diagnosis.status === 'blocked') {
    warnings.push('permission diagnosis blocked');
  }
  if (report.host_parity.status !== 'pass') {
    warnings.push(`host parity ${report.host_parity.status}`);
  }
  if (report.deep_peer_smoke.executed && report.deep_peer_smoke.status === 'operator_action_required') {
    warnings.push('deep peer smoke requires operator action outside runtime:doctor');
  }
  if (report.permission_proof.executed && report.permission_proof.status === 'operator_action_required') {
    warnings.push('permission proof requires operator action outside runtime:doctor');
  }
  // A blocked egress executor is a warning, not a hard failure: no network
  // request happened. The blockers themselves say what the operator must do
  // (set AGENTIC_EGRESS_REAL_SMOKE=1, resolve a pending intent, fix
  // activation) — plan-only `ready` stays silent.
  if (report.egress_ack_proof.requested && !report.egress_ack_proof.executed && report.egress_ack_proof.status === 'blocked') {
    warnings.push(report.egress_ack_proof.mode === 'explicit_egress_executor'
      ? 'egress ack proof execute was requested but blocked before any send (see egress_ack_proof.blockers)'
      : 'egress ack proof preflight is blocked (see egress_ack_proof.blockers)');
  }
  // G1 / D1(α) — WAL durability is reported ALONGSIDE the verdict, never folded
  // into it: `passed` means the provider acked and the mirror correlated
  // (ADR-0048 §3), both still true when the bookkeeping write failed. A warning
  // is how a passed proof with a shaky fence stays visible; making it a hard
  // failure would contradict the evidence vocabulary, and making it silent
  // would hide the one condition under which a future execute is unfenced.
  if (report.egress_ack_proof.executed && report.egress_ack_proof.wal_durability
      && report.egress_ack_proof.wal_durability !== 'durable') {
    warnings.push(`egress intent WAL ${report.egress_ack_proof.wal_durability} — the provider outcome stands, but the fence for a future attempt may not (see egress_ack_proof.limits)`);
  }
  // A separate condition, not an extra clause on the one above: debris leaves a
  // DURABLE fence and a dirty directory, so it must not borrow a sentence that
  // says the fence may not stand.
  if (report.egress_ack_proof.executed && report.egress_ack_proof.wal_debris) {
    warnings.push('egress intent WAL left a temp file behind — the fence itself is intact, but the leftover sits in a directory retention must never sweep (see egress_ack_proof.limits)');
  }
  if (report.workflow_continuation_proof.executed && report.workflow_continuation_proof.status === 'operator_action_required') {
    warnings.push('workflow continuation proof requires operator action outside runtime:doctor');
  }
  return {
    status: hardFailures.length > 0 ? 'fail' : warnings.length > 0 ? 'warning' : 'pass',
    hard_failures: hardFailures,
    warnings,
  };
}

export function formatText(report) {
  const lines = [];
  lines.push(`runtime:doctor ${report.runtime_version} (${report.overall.status})`);
  lines.push(`repo: ${report.repo_root}`);
  lines.push('read-only: true');
  if (report.doctor_artifact?.written) {
    lines.push(`doctor-artifact: ${report.doctor_artifact.artifact_pointer}; latest=${report.doctor_artifact.latest_pointer}`);
  }
  lines.push('');
  lines.push('Readiness Matrix');
  for (const name of ['claude', 'codex']) {
    const host = report.readiness_matrix.hosts[name];
    const hookText = name === 'codex'
      ? `hooks=global:${featureFlagEvidence(host.hooks.global_hooks, host.hooks.global_hooks_stage)}, plugin-local:${featureFlagEvidence(host.hooks.plugin_local_hooks, host.hooks.plugin_local_hooks_stage)}, automatic-plugin-hooks=${host.hooks.automatic_plugin_hooks}, packaging=${host.hooks.packaging_status}`
      : `hooks=automatic-plugin-hooks:${host.hooks.automatic_plugin_hooks}`;
    lines.push(`- ${name}: available=${host.available.status}; installed=${host.installed.status}; authenticated=${host.authenticated.status}; peer-model=${host.model_when_peer.value ?? '<host-default>'} (${host.model_when_peer.source}); peer-effort=${host.effort_when_peer.value ?? '<host-default>'} (${host.effort_when_peer.source}); ${hookText}`);
    lines.push(`  install-evidence: ${host.installed.evidence}`);
  }
  for (const key of ['claude_to_codex', 'codex_to_claude']) {
    const direction = report.readiness_matrix.directions[key];
    lines.push(`- ${direction.direction}: readiness=${direction.status}; companion=${direction.companion.status}; execution-readiness=${direction.execution_readiness.status}; model=${direction.model.value ?? '<host-default>'}; effort=${direction.effort.value ?? '<host-default>'}; sandbox-permission=${direction.sandbox_permission}; blockers=${direction.blocker_count}; warnings=${direction.warning_count}`);
  }
  lines.push('');
  lines.push('Experience Parity');
  const experience = report.experience_parity;
  lines.push(`- status: ${experience.status}; score=${experience.score_percent}%; satisfied=${experience.counts.satisfied}; partial=${experience.counts.partial}; not-verified=${experience.counts.not_verified}; blocked=${experience.counts.blocked}; manual-followups=${experience.manual_followup_count}`);
  for (const criterion of experience.criteria) {
    lines.push(`- ${criterion.status}: ${criterion.id}; weight=${criterion.earned_weight}/${criterion.weight}; ${criterion.label}`);
    lines.push(`  evidence: ${criterion.evidence}`);
    if (criterion.next_step) lines.push(`  next: ${criterion.next_step}`);
  }
  if (experience.next_actions.length > 0) {
    lines.push('- next-actions:');
    for (const action of experience.next_actions.slice(0, 8)) {
      const commandText = action.commands?.length > 0 ? `; commands=${action.commands.join(' | ')}` : '';
      lines.push(`  - ${action.source}:${action.id}; host=${action.host}${commandText}; reason=${action.reason}`);
    }
  }
  for (const limit of experience.limits) lines.push(`- limit: ${limit}`);
  if (report.recorded_doctor_proof?.status && report.recorded_doctor_proof.status !== 'missing') {
    lines.push(`- recorded-doctor-proof: ${report.recorded_doctor_proof.status}; run=${report.recorded_doctor_proof.run_id}; artifact=${report.recorded_doctor_proof.artifact_pointer}`);
    for (const reason of report.recorded_doctor_proof.reasons ?? []) {
      lines.push(`  reason: ${reason}`);
    }
  }
  lines.push('');
  lines.push('Host CLIs');
  for (const name of ['claude', 'codex']) {
    const cli = report.clis[name];
    lines.push(`- ${name}: ${cli.status}; version=${cli.version.text || cli.version.status}; auth=${cli.auth.status}`);
    if (name === 'codex') {
      lines.push(`  hooks: global=${featureFlagEvidence(cli.feature_surface.codex_global_hooks, cli.feature_surface.codex_global_hooks_stage)}; plugin-local=${featureFlagEvidence(cli.feature_surface.codex_plugin_hooks, cli.feature_surface.codex_plugin_hooks_stage)}; automatic-plugin-hooks=${Boolean(cli.feature_surface.automatic_plugin_hooks)}`);
    }
  }
  lines.push('');
  lines.push('Codex Plugin Hooks');
  const codexHooks = report.codex_plugin_hooks;
  lines.push(`- status=${codexHooks.status}; bundled=${codexHooks.summary.bundled_plugins.join(',') || 'none'}; manifest-exposed=${codexHooks.summary.manifest_exposed_plugins.join(',') || 'none'}; default-file-only=${codexHooks.summary.default_file_only_plugins.join(',') || 'none'}; command-warnings=${(codexHooks.summary.command_warning_plugins ?? []).join(',') || 'none'}`);
  // Shared with settings' renderer (S8a5) — one template, so the two surfaces cannot
  // describe the same machine differently.
  lines.push(...formatCodexHookStateLines(codexHooks.hook_state));
  for (const target of codexHooks.review_targets ?? []) {
    lines.push(`  review-target: ${target.plugin}@${target.version ?? 'unknown'}; origin=${target.origin ?? '<unknown>'}; manifest-exposed=${target.manifest_exposed}; path=${target.hooks_path ?? '<unknown>'}; events=${target.events.join(',') || 'none'}; handlers=${target.handler_count}; commands=${target.command_count}; warnings=${target.command_warnings.join(',') || 'none'}`);
    for (const command of target.commands ?? []) {
      lines.push(`    hook-command: ${command}`);
    }
    lines.push(`    expected: ${target.expected_review}`);
  }
  for (const recommendation of codexHooks.recommendations) {
    lines.push(`  ${recommendation.action}: ${recommendation.detail}`);
    if (recommendation.next_step) lines.push(`  next: ${recommendation.next_step}`);
  }
  lines.push('');
  lines.push('Plugin Command Surface');
  const claudeSurface = report.plugin_command_surface.claude;
  lines.push(`- claude: mode=${claudeSurface.mode}; install=${Boolean(claudeSurface.supports.install_plugin)}; update=${Boolean(claudeSurface.supports.update_plugin)}; uninstall=${Boolean(claudeSurface.supports.uninstall_plugin)}; list=${Boolean(claudeSurface.supports.list_plugin)}; materialization=${claudeSurface.materialization.status}`);
  if (claudeSurface.observed_surfaces) {
    lines.push(`  observed: cli-plugin=${claudeSurface.observed_surfaces.cli_plugin}; slash-plugin=${claudeSurface.observed_surfaces.slash_plugin}`);
  }
  if (claudeSurface.materialization.next_step) lines.push(`  next: ${claudeSurface.materialization.next_step}`);
  const codexSurface = report.plugin_command_surface.codex;
  lines.push(`- codex: mode=${codexSurface.mode}; plugin-add=${Boolean(codexSurface.supports.install_plugin)}; plugin-list=${Boolean(codexSurface.supports.list_plugin)}; plugin-remove=${Boolean(codexSurface.supports.remove_plugin)}; marketplace-add=${Boolean(codexSurface.supports.marketplace_add)}; marketplace-list=${Boolean(codexSurface.supports.marketplace_list)}; marketplace-upgrade=${Boolean(codexSurface.supports.marketplace_upgrade)}; marketplace-remove=${Boolean(codexSurface.supports.marketplace_remove)}; materialization=${codexSurface.materialization.status}`);
  if (codexSurface.materialization.next_step) lines.push(`  next: ${codexSurface.materialization.next_step}`);
  if (report.plugin_command_surface.manual_followups?.length > 0) {
    lines.push('');
    lines.push('Manual Follow-ups');
    for (const followup of report.plugin_command_surface.manual_followups) {
      lines.push(`- ${followup.id}: host=${followup.host}; status=${followup.status}`);
      lines.push(`  reason: ${followup.reason}`);
      lines.push(`  environment: ${followup.environment}`);
      for (const command of followup.commands ?? []) lines.push(`  command: ${command}`);
      lines.push(`  verify: ${followup.verify}`);
      for (const target of followup.review_targets ?? []) {
        lines.push(`  review-target: ${target.plugin}@${target.version ?? 'unknown'}; events=${target.events.join(',') || 'none'}; commands=${target.command_count}; warnings=${target.command_warnings.join(',') || 'none'}`);
      }
    }
  }
  lines.push('');
  lines.push('Plugins');
  for (const name of PLUGIN_NAMES) {
    const plugin = report.plugins[name];
    const sourceVersion = plugin.source?.claude_manifest?.version ?? plugin.source?.codex_manifest?.version ?? 'n/a';
    lines.push(`- ${name}: ${plugin.status}; source=${sourceVersion}; claude-cache=${plugin.cache.claude.status}; codex-cache=${plugin.cache.codex.status}`);
  }
  lines.push('');
  lines.push('Companions');
  for (const key of ['claude_to_codex', 'codex_to_claude']) {
    const direction = report.companions.directions[key];
    lines.push(`- ${direction.label}: ${direction.status}; contract=${direction.selected?.contract_version ?? 'n/a'}`);
  }
  lines.push('');
  lines.push('Host Parity');
  lines.push(`- status: ${report.host_parity.status}; issues=${report.host_parity.issue_count}; differences=${report.host_parity.difference_count}`);
  for (const entry of [...report.host_parity.issues, ...report.host_parity.differences]) {
    lines.push(`- ${entry.severity}: ${entry.id}${entry.plugin ? ` (${entry.plugin})` : ''}; host=${entry.host}; ${entry.summary}`);
    lines.push(`  evidence: ${entry.evidence}`);
    lines.push(`  next: ${entry.next_step}`);
  }
  lines.push(`- baseline-freshness: ${report.host_parity_baseline.status}${report.host_parity_baseline.status === 'current' ? '' : ` (observed claude=${report.host_parity_baseline.evidence.observed.claude ?? 'unknown'}, codex=${report.host_parity_baseline.evidence.observed.codex ?? 'unknown'}; baseline=${report.host_parity_baseline.evidence.baseline ? `${report.host_parity_baseline.evidence.baseline.claude}/${report.host_parity_baseline.evidence.baseline.codex} @ ${report.host_parity_baseline.evidence.baseline.date}` : 'missing'})`}`);
  if (report.host_parity_baseline.next_action) {
    lines.push(`  next: ${report.host_parity_baseline.next_action}`);
  }
  lines.push('');
  lines.push('Model / Effort');
  for (const key of ['claude_to_codex', 'codex_to_claude']) {
    const direction = report.model_effort.directions[key];
    lines.push(`- ${key}: model=${direction.model.value ?? '<host-default>'} (${direction.model.source}); effort=${direction.effort.value ?? '<host-default>'} (${direction.effort.source})`);
  }
  lines.push('');
  lines.push('Readiness');
  for (const key of ['claude_to_codex', 'codex_to_claude']) {
    const readiness = report.readiness[key];
    lines.push(`- ${readiness.direction}: ${readiness.status}`);
    lines.push(`  sandbox-permission: ${readiness.sandbox_permission.status}`);
    for (const blocker of readiness.blockers) lines.push(`  blocker: ${blocker}`);
    for (const warning of readiness.warnings) lines.push(`  warning: ${warning}`);
  }
  lines.push('');
  if (report.sandbox_permission_probe.requested) {
    lines.push('Sandbox Permission Probe');
    lines.push(`- mode: ${report.sandbox_permission_probe.mode}; requested=${report.sandbox_permission_probe.requested}; executed=${report.sandbox_permission_probe.executed}; peer-execution=${report.sandbox_permission_probe.peer_execution}; status=${report.sandbox_permission_probe.status}`);
    for (const key of ['claude_to_codex', 'codex_to_claude']) {
      const direction = report.sandbox_permission_probe.directions[key];
      lines.push(`- ${direction.direction}: ${direction.status}`);
      for (const probe of direction.probes) lines.push(`  probe ${probe.name}: ${probe.status}; ${probe.evidence}`);
    }
    for (const limit of report.sandbox_permission_probe.limits) lines.push(`- limit: ${limit}`);
    lines.push('');
  }
  if (report.permission_proof.requested) {
    lines.push('Permission Proof');
    lines.push(`- mode: ${report.permission_proof.mode}; requested=${report.permission_proof.requested}; executed=${report.permission_proof.executed}; peer-execution=${report.permission_proof.peer_execution}; status=${report.permission_proof.status}`);
    for (const key of ['claude_to_codex', 'codex_to_claude']) {
      const direction = report.permission_proof.directions[key];
      lines.push(`- ${direction.direction}: ${direction.status}; execution=${direction.execution}; model=${direction.model.value ?? '<host-default>'}; effort=${direction.effort.value ?? '<host-default>'}`);
      lines.push(`  plan: ${direction.plan}`);
      lines.push(`  permission-policy: host-default=${direction.permission_policy.host_native_default}; relaxed-by-doctor=${direction.permission_policy.relaxed_by_doctor}; injected-flags=${direction.permission_policy.injected_flags.length}`);
      if (direction.preflight?.probes) {
        for (const probe of direction.preflight.probes) lines.push(`  probe ${probe.name}: ${probe.status}; ${probe.evidence}`);
      }
      if (direction.result && direction.execution === 'executed') {
        lines.push(`  result: peer=${direction.result.peer_host ?? '<unknown>'}; envelope=${direction.result.envelope_status ?? '<none>'}; exit=${direction.result.peer_exit_code ?? direction.result.companion_exit_code ?? '<none>'}; expected-token=${direction.result.expected_token_present}; stdout-bytes=${direction.result.stdout_bytes}; stdout-sha256=${direction.result.stdout_sha256 ?? '<empty>'}; operator-action-required=${Boolean(direction.result.operator_action_required)}`);
        if (direction.result.operator_action_kind) lines.push(`  operator-action-kind: ${direction.result.operator_action_kind}`);
        if (direction.result.metadata?.duration_ms !== null && direction.result.metadata?.duration_ms !== undefined) {
          lines.push(`  duration-ms: ${direction.result.metadata.duration_ms}`);
        }
        if (direction.result.error?.message) lines.push(`  error: ${direction.result.error.message}`);
      } else if (direction.result?.reason) {
        lines.push(`  result: ${direction.result.reason}`);
      }
      if (direction.blockers.length > 0) {
        for (const blocker of direction.blockers) lines.push(`  blocker: ${blocker}`);
      }
      lines.push(`  next: ${direction.next_step}`);
    }
    for (const limit of report.permission_proof.limits) lines.push(`- limit: ${limit}`);
    lines.push('');
  }
  if (report.egress_ack_proof.requested) {
    lines.push('Egress Ack Proof');
    lines.push(`- mode: ${report.egress_ack_proof.mode}; requested=${report.egress_ack_proof.requested}; executed=${report.egress_ack_proof.executed}; status=${report.egress_ack_proof.status}; outcome=${report.egress_ack_proof.outcome_reason ?? '<none>'}; mirror-correlated=${report.egress_ack_proof.mirror_correlated}`);
    if (report.egress_ack_proof.provider_ack) {
      const ack = report.egress_ack_proof.provider_ack;
      lines.push(`- provider-ack: result=${ack.result}; attempt-hash=${ack.attempt_hash}; activation-fingerprint=${ack.activation_fingerprint}; ran-at=${ack.ran_at}`);
    }
    if (report.egress_ack_proof.subject_suffix) {
      lines.push(`- correlation-token: ${report.egress_ack_proof.subject_suffix} (match this against the topic line of the phone message; the raw event id never leaves local state)`);
    }
    for (const blocker of report.egress_ack_proof.blockers) lines.push(`  blocker: ${blocker}`);
    for (const limit of report.egress_ack_proof.limits) lines.push(`- limit: ${limit}`);
    lines.push('');
  }
  if (report.deep_peer_smoke.requested) {
    lines.push('Deep Peer Smoke');
    lines.push(`- mode: ${report.deep_peer_smoke.mode}; requested=${report.deep_peer_smoke.requested}; executed=${report.deep_peer_smoke.executed}; peer-execution=${report.deep_peer_smoke.peer_execution}; status=${report.deep_peer_smoke.status}`);
    for (const key of ['claude_to_codex', 'codex_to_claude']) {
      const direction = report.deep_peer_smoke.directions[key];
      lines.push(`- ${direction.direction}: ${direction.status}; execution=${direction.execution}; model=${direction.model.value ?? '<host-default>'}; effort=${direction.effort.value ?? '<host-default>'}`);
      lines.push(`  plan: ${direction.plan}`);
      if (direction.result && direction.execution === 'executed') {
        lines.push(`  result: peer=${direction.result.peer_host ?? '<unknown>'}; envelope=${direction.result.envelope_status ?? '<none>'}; exit=${direction.result.peer_exit_code ?? direction.result.companion_exit_code ?? '<none>'}; expected-token=${direction.result.expected_token_present}; stdout-bytes=${direction.result.stdout_bytes}; stdout-sha256=${direction.result.stdout_sha256 ?? '<empty>'}`);
        lines.push(`  operator-action-required=${Boolean(direction.result.operator_action_required)}`);
        if (direction.result.operator_action_kind) lines.push(`  operator-action-kind: ${direction.result.operator_action_kind}`);
        if (direction.result.metadata?.duration_ms !== null && direction.result.metadata?.duration_ms !== undefined) {
          lines.push(`  duration-ms: ${direction.result.metadata.duration_ms}`);
        }
        if (direction.result.error?.message) lines.push(`  error: ${direction.result.error.message}`);
      } else if (direction.result?.reason) {
        lines.push(`  result: ${direction.result.reason}`);
      }
      if (direction.blockers.length > 0) {
        for (const blocker of direction.blockers) lines.push(`  blocker: ${blocker}`);
      }
      lines.push(`  next: ${direction.next_step}`);
    }
    for (const limit of report.deep_peer_smoke.limits) lines.push(`- limit: ${limit}`);
    lines.push('');
  }
  if (report.workflow_continuation_proof.requested) {
    lines.push('Workflow Continuation Proof');
    lines.push(`- mode: ${report.workflow_continuation_proof.mode}; requested=${report.workflow_continuation_proof.requested}; executed=${report.workflow_continuation_proof.executed}; peer-execution=${report.workflow_continuation_proof.peer_execution}; workflow-state=${report.workflow_continuation_proof.workflow_state}; status=${report.workflow_continuation_proof.status}`);
    for (const key of ['claude_to_codex', 'codex_to_claude']) {
      const direction = report.workflow_continuation_proof.directions[key];
      lines.push(`- ${direction.direction}: ${direction.status}; execution=${direction.execution}; model=${direction.model.value ?? '<host-default>'}; effort=${direction.effort.value ?? '<host-default>'}`);
      lines.push(`  plan: ${direction.plan}`);
      lines.push(`  workflow: host=${direction.workflow.host}; peer=${direction.workflow.peer}; branch=${direction.workflow.branch}; temp-repo=${direction.workflow.temp_repo ?? 'none'}`);
      if (direction.result && direction.execution === 'executed') {
        lines.push(`  result: peer=${direction.result.peer_host ?? '<unknown>'}; envelope=${direction.result.envelope_status ?? '<none>'}; exit=${direction.result.peer_exit_code ?? direction.result.companion_exit_code ?? '<none>'}; expected-token=${direction.result.expected_token_present}; stdout-bytes=${direction.result.stdout_bytes ?? '<none>'}; stdout-sha256=${direction.result.stdout_sha256 ?? '<empty>'}; operator-action-required=${Boolean(direction.result.operator_action_required)}`);
        if (direction.result.installed_tool_root) {
          lines.push(`  installed-tool-root: ${direction.result.installed_tool_root} (source=${direction.result.tool_root_source}); proof-workspace=ephemeral (§8.2 — the two roots are distinct)`);
        }
        if (direction.result.workflow) {
          lines.push(`  state-workflow: id=${direction.result.workflow.workflow_id ?? '<unknown>'}; run-id=${direction.result.workflow.run_id}; temp-repo=${direction.result.workflow.temp_repo}`);
        }
        if (direction.result.state_checks) {
          lines.push(`  state-checks: workflow-created=${Boolean(direction.result.state_checks.workflow_created)}; pending-recorded=${Boolean(direction.result.state_checks.pending_recorded)}; pending-cleared=${Boolean(direction.result.state_checks.pending_cleared)}; commit-recorded=${Boolean(direction.result.state_checks.commit_recorded)}`);
        }
        if (direction.result.operator_action_kind) lines.push(`  operator-action-kind: ${direction.result.operator_action_kind}`);
        if (direction.result.metadata?.duration_ms !== null && direction.result.metadata?.duration_ms !== undefined) {
          lines.push(`  duration-ms: ${direction.result.metadata.duration_ms}`);
        }
        if (direction.result.error?.message) lines.push(`  error: ${direction.result.error.message}`);
        if (direction.result.state_failure) lines.push(`  state-failure: ${direction.result.state_failure}`);
      } else if (direction.result?.reason) {
        lines.push(`  result: ${direction.result.reason}`);
      }
      if (direction.blockers.length > 0) {
        for (const blocker of direction.blockers) lines.push(`  blocker: ${blocker}`);
      }
      lines.push(`  next: ${direction.next_step}`);
    }
    for (const limit of report.workflow_continuation_proof.limits) lines.push(`- limit: ${limit}`);
    lines.push('');
  }
  lines.push('Settings Execution Artifacts');
  lines.push(`- status: ${report.settings_runs.status}; count=${report.settings_runs.count}; malformed=${report.settings_runs.malformed}`);
  if (report.settings_runs.latest) {
    const latest = report.settings_runs.latest;
    lines.push(`- latest: ${latest.run_id}; status=${latest.status}; terminal=${latest.terminal !== false}; artifact=${latest.artifact_pointer}`);
    if (report.settings_runs.interrupted) {
      lines.push(`  ⚠ interrupted: ${report.settings_runs.recovery}`);
    }
    lines.push(`  plugin-management: mode=${latest.plugin_management.mode ?? '<unknown>'}; executed=${latest.plugin_management.summary.executed}; failed=${latest.plugin_management.summary.failed}; blocked=${latest.plugin_management.summary.blocked ?? 0}; retryable-failed=${latest.plugin_management.summary.failed_retryable}; non-retryable-failed=${latest.plugin_management.summary.failed_non_retryable}`);
    lines.push(`  plugin-cleanup: mode=${latest.plugin_cleanup.mode ?? '<unknown>'}; executed=${latest.plugin_cleanup.summary.executed}; failed=${latest.plugin_cleanup.summary.failed}; blocked=${latest.plugin_cleanup.summary.blocked}; retryable-failed=${latest.plugin_cleanup.summary.failed_retryable}; non-retryable-failed=${latest.plugin_cleanup.summary.failed_non_retryable}`);
    lines.push(`  codex-hook-review: status=${latest.codex_hook_review.status}; attested=${latest.codex_hook_review.attested}; bundled=${latest.codex_hook_review.bundled_plugins.join(',') || 'none'}`);
    for (const failure of latest.plugin_management.failures) {
      lines.push(`  failure: ${failure.plugin}/${failure.host} ${failure.action}; type=${failure.failure_type}; retryable=${failure.retryable}`);
      if (failure.retry_after) lines.push(`    retry-after: ${failure.retry_after}`);
      if (failure.doctor_hint) lines.push(`    doctor: ${failure.doctor_hint}`);
    }
    for (const failure of latest.plugin_cleanup.failures) {
      lines.push(`  cleanup-failure: ${failure.plugin}/${failure.host} ${failure.action}; type=${failure.failure_type}; retryable=${failure.retryable}`);
      if (failure.retry_after) lines.push(`    retry-after: ${failure.retry_after}`);
      if (failure.doctor_hint) lines.push(`    doctor: ${failure.doctor_hint}`);
    }
  }
  if (report.settings_runs.codex_hook_review?.latest) {
    // Render the CURRENCY status, not the recorded one — a stale attestation must never read
    // as `attested` here while doctor's own mirror asks the operator to re-review (§SCOPE-3).
    const currency = report.settings_runs.codex_hook_review;
    const review = currency.latest;
    const reasonSuffix = currency.current ? '' : `; currency-reason=${currency.currency_reason ?? 'unknown'}`;
    lines.push(`  latest-codex-hook-review: status=${currency.status}${reasonSuffix}; attested-at=${review.attested_at ?? '<unknown>'}; codex-cli=${review.bound_versions?.codex ?? '<unbound>'}; plugins=${Object.entries(review.plugin_versions ?? {}).map(([name, version]) => `${name}@${version ?? 'unknown'}`).join(',') || 'none'}`);
  }
  lines.push('');
  lines.push('Consensus Execution Artifacts');
  lines.push(`- status: ${report.consensus_runs.status}; count=${report.consensus_runs.count}; malformed=${report.consensus_runs.malformed}`);
  if (report.consensus_runs.latest) {
    const latest = report.consensus_runs.latest;
    lines.push(`- latest: ${latest.run_id}; status=${latest.status}; artifact=${latest.artifact_pointer}; progress=${latest.progress_pointer ?? '<none>'}; round=${latest.round}`);
    lines.push(`  execution: peer-execution=${latest.peer_execution}; executed=${latest.summary.executed}; passed=${latest.summary.passed}; failed=${latest.summary.failed}; skipped=${latest.summary.skipped}; retryable-failed=${latest.summary.failed_retryable}; non-retryable-failed=${latest.summary.failed_non_retryable}`);
    lines.push(`  failure-summary: timeout=${latest.failure_summary.timeout}; operator-action-required=${latest.failure_summary.operator_action_required}; retryable=${latest.failure_summary.retryable}; non-retryable=${latest.failure_summary.non_retryable}`);
    if (latest.failure_summary.timeout > 0) {
      lines.push(`  warning: latest consensus execution timed out for ${latest.failure_summary.timeout} peer(s); retryable-failed=${latest.summary.failed_retryable}`);
    }
    for (const failure of latest.failures) {
      lines.push(`  failure: ${failure.peer}; status=${failure.status}; type=${failure.failure_type}; operator-action-required=${failure.operator_action_required}; retryable=${failure.retryable}; raw=${failure.raw_output.pointer}; bytes=${failure.raw_output.bytes}; sha256=${failure.raw_output.sha256}`);
      if (failure.retry_after) lines.push(`    retry-after: ${failure.retry_after}`);
      if (failure.retry_command) lines.push(`    retry-command: ${failure.retry_command}`);
    }
  }
  lines.push('');
  lines.push('Compatibility Artifacts');
  lines.push(`- status: ${report.compat_runs.status}; count=${report.compat_runs.count}; malformed=${report.compat_runs.malformed}`);
  if (report.compat_runs.latest) {
    const latest = report.compat_runs.latest;
    lines.push(`- latest: ${latest.run_id}; status=${latest.status}; snapshot=${latest.artifact_pointer}; gap=${latest.gap_pointer ?? '<none>'}; plan=${latest.plan_pointer ?? '<none>'}`);
    lines.push(`  drift=${latest.drift_class}; release-notes-required=${latest.release_notes_required}; notes=${latest.release_notes.count}; content-backed=${latest.release_notes.content_backed}; urls=${latest.release_notes.url_pointers}`);
    for (const gap of latest.host_gaps) {
      lines.push(`  host-gap: ${gap.host}; status=${gap.status}; observed=${gap.observed_version ?? 'unknown'}; baseline=${gap.baseline_version ?? 'unknown'}`);
    }
    for (const malformed of latest.malformed_artifacts ?? []) {
      lines.push(`  malformed-artifact: ${malformed}`);
    }
    for (const step of latest.next_steps ?? []) {
      lines.push(`  next: ${step}`);
    }
  }
  lines.push('');
  lines.push(`Session Capture Readiness (${report.session_capture.status})`);
  lines.push(`- gate: session_capture=${report.session_capture.gate.value ?? '<fail-closed>'}; safe-mode=${report.session_capture.safe_mode.active}`);
  if (!['off', 'config-fail-closed'].includes(report.session_capture.status)) {
    lines.push(`- attention: installed=${report.session_capture.attention.installed}; version=${report.session_capture.attention.version ?? '<none>'}; enablement=${report.session_capture.attention.enablement}`);
    lines.push(`- publisher-floor: declared=${report.session_capture.publisher_floor.declared}; floor=${report.session_capture.publisher_floor.floor ?? '<none>'}; runtime=${report.session_capture.publisher_floor.runtime_version ?? '<unknown>'}; satisfied=${report.session_capture.publisher_floor.satisfied ?? '<n/a>'}`);
  }
  for (const recommendation of report.session_capture.recommendations) {
    lines.push(`- ${recommendation.state}: ${recommendation.detail}`);
    lines.push(`  next: ${recommendation.next_step}`);
  }
  lines.push('');
  // ADR-0045 S8 — entry-side hook-chain readiness (contract §18). The gate
  // diagnoses the SessionStart hook emission chain only; the cli/dashboard
  // entry-brief surfaces always compute regardless.
  lines.push(`Entry Brief Readiness (${report.entry_brief.status})`);
  lines.push(`- gate: entry_brief=${report.entry_brief.gate.value ?? '<fail-closed>'}; entry_brief_empty=${report.entry_brief.gate.empty_value ?? '<fail-closed>'}; safe-mode=${report.entry_brief.safe_mode.active}${report.entry_brief.gate.ignored_repo_keys.length > 0 ? `; ignored-repo-keys=${report.entry_brief.gate.ignored_repo_keys.join(',')}` : ''}`);
  if (!['off', 'config-fail-closed'].includes(report.entry_brief.status)) {
    lines.push(`- attention: installed=${report.entry_brief.attention.installed}; version=${report.entry_brief.attention.version ?? '<none>'}; enablement=${report.entry_brief.attention.enablement}`);
    lines.push(`- entry-floor: declared=${report.entry_brief.entry_floor.declared}; floor=${report.entry_brief.entry_floor.floor ?? '<none>'}; runtime=${report.entry_brief.entry_floor.runtime_version ?? '<unknown>'}; satisfied=${report.entry_brief.entry_floor.satisfied ?? '<n/a>'}`);
    lines.push(`- entry-executor: probed=${report.entry_brief.entry_executor.probed}; present=${report.entry_brief.entry_executor.present ?? '<unverified>'}; cached-runtime=${report.entry_brief.entry_executor.runtime_version ?? '<none>'}`);
  }
  for (const recommendation of report.entry_brief.recommendations) {
    lines.push(`- ${recommendation.state}: ${recommendation.detail}`);
    lines.push(`  next: ${recommendation.next_step}`);
  }
  lines.push('');
  if (report.artifact_inventory?.requested) {
    lines.push('Runtime Artifact Inventory');
    lines.push(`- status: ${report.artifact_inventory.status}; total-runs=${report.artifact_inventory.total.run_count}; total-files=${report.artifact_inventory.total.file_count}; total-bytes=${report.artifact_inventory.total.bytes}; unreadable=${report.artifact_inventory.total.unreadable}`);
    lines.push(`- policy: run-count-cap=${report.artifact_inventory.policy.run_count_cap}; byte-cap=${report.artifact_inventory.policy.byte_cap}`);
    for (const family of Object.values(report.artifact_inventory.families ?? {})) {
      lines.push(`- ${family.family}: status=${family.status}; runs=${family.run_count}; files=${family.file_count}; bytes=${family.bytes}; oldest-age-minutes=${family.oldest_age_minutes ?? '<unknown>'}`);
    }
    // ADR-0047 §7 (Codex review MAJOR) — do NOT render an over-cap item as a
    // fault-with-removal-recommendation when the retention reconciliation
    // demoted it to informational pinned overage; that would tell the operator
    // to "remove obsolete artifacts" for runs that are pinned evidence, directly
    // contradicting the softened status. The retention block below renders those
    // as informational.
    const demotedKeys = new Set(
      (report.retention?.executed ? report.retention.reconciled?.demoted ?? [] : []).map((d) => `${d.family}/${d.observed}/${d.limit}`),
    );
    const overageKinds = new Set(['run_count_exceeds_cap', 'bytes_exceed_cap']);
    for (const attention of report.artifact_inventory.attention ?? []) {
      if (overageKinds.has(attention.kind) && demotedKeys.has(`${attention.family}/${attention.observed}/${attention.limit}`)) continue;
      lines.push(`  retention-attention: ${attention.family}/${attention.kind}; observed=${attention.observed}; limit=${attention.limit}`);
      lines.push(`    next: ${attention.recommendation}`);
    }
    for (const limit of report.artifact_inventory.limits ?? []) lines.push(`- limit: ${limit}`);
    lines.push('');
    // The machine-global scope renders SEPARATELY (ADR-0046 §4, artifact-policy.md
    // §Inventory). Folding its families into the block above would put two roots and
    // two retention caps behind one set of numbers, so `bootstrap: runs=12` would
    // read against the repo cap of 20 and look fine while it is over its own cap
    // of 10.
    const machine = report.artifact_inventory.machine;
    if (machine) {
      lines.push('Machine-Global Artifact Inventory (~/.agentic-plugins)');
      lines.push(`- status: ${machine.status}; total-runs=${machine.total.run_count}; total-files=${machine.total.file_count}; total-bytes=${machine.total.bytes}; unreadable=${machine.total.unreadable}`);
      lines.push(`- policy: run-count-cap=${machine.policy.run_count_cap}; byte-cap=${machine.policy.byte_cap}; retention-exempt=${(machine.policy.retention_exempt ?? []).join(',') || '<none>'}`);
      for (const family of Object.values(machine.families ?? {})) {
        lines.push(`- ${family.family}: status=${family.status}; runs=${family.run_count}; files=${family.file_count}; bytes=${family.bytes}; pointer=${family.pointer}`);
      }
      for (const attention of machine.attention ?? []) {
        lines.push(`  retention-attention: ${attention.family}/${attention.kind}; observed=${attention.observed}; limit=${attention.limit}`);
        lines.push(`    next: ${attention.recommendation}`);
      }
      for (const limit of machine.limits ?? []) lines.push(`- limit: ${limit}`);
      lines.push('');
    }
  }
  if (report.retention?.executed) {
    const r = report.retention;
    lines.push('Runtime Retention Plan (ADR-0047 §7 — read-only; deletes nothing)');
    lines.push(`- status: ${r.status}; scan-complete=${r.scan_complete}; plan-hash=${r.plan_hash}`);
    for (const [family, f] of Object.entries(r.projection ?? {})) {
      lines.push(`- ${family}: runs=${f.run_count}; pinned=${f.pinned_count}; over-cap=${f.over_cap}; actionable=${f.actionable}; pinned-overage=${f.pinned_overage}`);
    }
    for (const item of r.reconciled?.demoted ?? []) {
      lines.push(`  retention-informational: ${item.family}/${item.kind}; observed=${item.observed}; limit=${item.limit} — ${item.note}`);
    }
    for (const item of r.reconciled?.attention ?? []) {
      lines.push(`  retention-attention: ${item.family}/${item.kind}; observed=${item.observed}; limit=${item.limit}`);
    }
    for (const reason of r.scan_incomplete_reasons ?? []) {
      lines.push(`  scan-incomplete: ${reason.source}${reason.family ? `/${reason.family}` : ''} — ${reason.reason}`);
    }
    lines.push('- limit: The retention plan is read-only; the separate retention-apply executor deletes only unpinned, over-cap, age-cleared runs under a reviewed plan hash.');
    lines.push('');
  } else if (report.retention?.requested && report.retention.status === 'blocked') {
    // Never silently hide a failed planner (Codex review MINOR).
    lines.push('Runtime Retention Plan (ADR-0047 §7 — read-only; deletes nothing)');
    lines.push(`- status: blocked — the retention planner failed: ${report.retention.error ?? 'unknown'}`);
    lines.push('');
  }
  if (report.permission_diagnosis?.requested) {
    const pd = report.permission_diagnosis;
    lines.push('Permission Diagnosis');
    lines.push(`- status: ${pd.status}; hosts=${(pd.hosts ?? []).join(',') || '<none>'}; baseline-used=${pd.baseline_used}`);
    const sc = pd.sources_scanned ?? {};
    lines.push(`- records: claude=${sc.claude?.used ?? 0}/${sc.claude?.found ?? 0}; codex=${sc.codex?.used ?? 0}/${sc.codex?.found ?? 0}; capped=${sc.capped ?? false}`);
    for (const c of pd.by_cause ?? []) {
      lines.push(`- ${c.host}/${c.mechanism} (${c.cause}): rules=${c.rule_count}; seen=${c.seen_total}; user-rejected=${c.rejected_total ?? 0}`);
    }
    for (const p of pd.top_patterns ?? []) {
      lines.push(`  pattern: ${p.host} ${p.pattern} [${p.grade}] seen ${p.count}${p.note ? ` (${p.note})` : ''}`);
    }
    for (const m of pd.mode_postures ?? []) {
      lines.push(`  posture: ${m.host}/${m.cause} (${m.title}) seen ${m.count}`);
    }
    for (const limit of pd.limits ?? []) lines.push(`- limit: ${limit}`);
    lines.push('');
  }
  lines.push('Ledgers');
  for (const key of ['engineer', 'orchestrator']) {
    const ledger = report.ledgers[key];
    lines.push(`- ${key}: storage=${ledger.storage.status}; selected=${ledger.storage.selected_home}; workflows=${ledger.workflows.count}/${ledger.workflows.status}; peer-runs=${ledger.peer_runs.count}/${ledger.peer_runs.status}; stale=${ledger.peer_runs.stale_non_terminal}`);
    if (ledger.storage.status !== 'empty') {
      lines.push(`  storage-next: ${ledger.storage.recommendation}`);
    }
  }
  lines.push('');
  lines.push('Limits');
  for (const limit of report.limits) lines.push(`- ${limit}`);
  return `${lines.join('\n')}\n`;
}

function redactCommandDetails(cli) {
  return {
    name: cli.name,
    status: cli.status,
    version: cli.version,
    auth: cli.auth,
    feature_surface: cli.feature_surface,
    feature_command_status: cli.features,
    plugin_command_status: {
      status: cli.plugin.status,
      exit_code: cli.plugin.exit_code,
      error_code: cli.plugin.error_code,
    },
    // Status only — never persist the raw `codex plugin list --json` stdout
    // (it carries source filesystem paths); writeDoctorArtifact copies the
    // report wholesale, so the redaction boundary lives here (ADR-0034).
    ...(cli.plugin_list
      ? {
        plugin_list_command_status: {
          status: cli.plugin_list.status,
          exit_code: cli.plugin_list.exit_code,
          error_code: cli.plugin_list.error_code,
        },
      }
      : {}),
    plugin_surface: cli.plugin_surface,
  };
}

function featureFlagEvidence(enabled, stage) {
  if (enabled === true) return stage ? `true/${stage}` : 'true';
  if (enabled === false) return stage ? `false/${stage}` : 'false';
  return 'unknown';
}

// ADR-0047 §7 — the read-only retention section: run the pure planner, project
// the per-registry-family actionable/pinned split, and reconcile the raw
// artifact-inventory attention so pinned-only overage stops reading as a fault.
// Fail-closed and never throwing: any planner failure degrades to a blocked
// section rather than aborting doctor (advisory infrastructure).
async function buildRetentionSection({ repoRoot, now, artifactRetentionCap, artifactMaxBytes, inventory }) {
  try {
    const plan = await planRetention({
      repoRoot,
      now,
      caps: { runCap: artifactRetentionCap, maxBytes: artifactMaxBytes },
    });
    const projection = projectRetentionAttention(plan);
    const reconciled = reconcileRetentionAttention(inventory?.attention ?? [], projection);
    return {
      requested: true,
      executed: true,
      status: plan.scan_complete ? (reconciled.attention.length > 0 ? 'needs_attention' : 'available') : 'scan-incomplete',
      scan_complete: plan.scan_complete,
      scan_incomplete_reasons: plan.scan_incomplete_reasons,
      scan_stats: plan.scan_stats,
      plan_hash: plan.plan_hash,
      caps: plan.caps,
      projection: projection.families,
      reconciled,
    };
  } catch (err) {
    return {
      requested: true,
      executed: false,
      status: 'blocked',
      error: err?.message ?? String(err),
    };
  }
}

function manifestSummary(readResult) {
  if (!readResult.ok) return { status: 'missing', error: readResult.reason };
  return {
    status: 'available',
    name: readResult.json.name ?? null,
    version: readResult.json.version ?? null,
    hooks: summarizeManifestHookField(readResult.json.hooks),
  };
}

async function writeDoctorArtifact({ repoRoot, now, runId, report }) {
  const id = runId ? validateDoctorRunId(runId) : makeDoctorRunId(now);
  const root = join(repoRoot, '.agentic-plugins', 'runs', 'doctor');
  const runDir = resolve(root, id);
  await assertInside(root, runDir);
  await mkdir(runDir, { recursive: true });
  const reportForArtifact = JSON.parse(JSON.stringify(report));
  if (reportForArtifact.doctor_runs) delete reportForArtifact.doctor_runs.latest_report;
  reportForArtifact.doctor_artifact = {
    written: false,
    requested: false,
    status: 'not_written_inside_artifact_snapshot',
  };
  const artifact = {
    schema_version: DOCTOR_ARTIFACT_SCHEMA_VERSION,
    runtime_version: RUNTIME_VERSION,
    run_id: id,
    status: 'recorded',
    created_at: now.toISOString(),
    repo_root_pointer: '.',
    report: reportForArtifact,
    limits: [
      'This artifact is sanitized runtime:doctor output; raw peer stdout/stderr and prompt text are not stored here.',
      'The artifact records observed proof evidence only; it does not mutate host trust, auth, sandbox, permission, or config state.',
      'Consumers must reject this artifact when runtime, host, or plugin versions no longer match the current report.',
    ],
  };
  const artifactPath = join(runDir, 'doctor.json');
  const latestPath = join(root, 'latest.json');
  // ADR-0048 §3 — the artifact bytes are EVIDENCE another artifact links by
  // hash (bootstrap proof records import artifact_sha256 as artifact_hash), so
  // the write must be atomic (temp+rename; a torn doctor.json would break the
  // hash link) and the sha256 must be over the EXACT bytes on disk — computed
  // from the serialized buffer that is written, never a re-serialization.
  const artifactBytes = `${JSON.stringify(artifact, null, 2)}\n`;
  const artifactSha256 = createHash('sha256').update(artifactBytes).digest('hex');
  await writeFileAtomic(artifactPath, artifactBytes);
  await writeFileAtomic(latestPath, `${JSON.stringify({
    schema_version: DOCTOR_LATEST_SCHEMA_VERSION,
    runtime_version: RUNTIME_VERSION,
    run_id: id,
    artifact_pointer: pointer(repoRoot, artifactPath),
    updated_at: now.toISOString(),
  }, null, 2)}\n`);
  return {
    written: true,
    requested: true,
    status: 'recorded',
    run_id: id,
    run_pointer: pointer(repoRoot, runDir),
    artifact_pointer: pointer(repoRoot, artifactPath),
    artifact_sha256: artifactSha256,
    latest_pointer: pointer(repoRoot, latestPath),
  };
}

// Atomic same-directory temp+rename write. The temp name is random-suffixed so
// concurrent doctor runs cannot collide on it; rename within one directory is
// atomic on POSIX, so readers observe either the old bytes or the new — never
// a torn file whose sha256 matches nothing.
async function writeFileAtomic(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = join(dirname(path), `.${basename(path)}.${randomBytes(4).toString('hex')}.tmp`);
  await writeFile(tempPath, data);
  try {
    await rename(tempPath, path);
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
}

function makeDoctorRunId(now) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `doctor-${stamp}-${randomBytes(3).toString('hex')}`;
}

function validateDoctorRunId(value) {
  if (!DOCTOR_RUN_ID_RE.test(String(value ?? ''))) throw new Error(`Invalid doctor run id: ${value}`);
  return value;
}

// ---------------------------------------------------------------------------
// Durable WAL publication (ADR-0048 residual (b) + (a), G1)
// ---------------------------------------------------------------------------
//
// ONE primitive, used twice. Every record this WAL publishes — the claim before
// the send and the terminal record after it — is created by `link(2)` at a name
// no other attempt can produce, and NOTHING here ever renames over, replaces, or
// removes a published record. That is the whole protocol, and it is append-only
// for a reason that four review rounds each rediscovered from a different angle:
//
//   deciding that the record at a pathname is still the one YOU published cannot
//   be made atomic on a pathname.
//
// Round 1 removed the record (compare-and-unlink) — a contender past its own scan
// claimed the freed name and sent a second message. Round 2 took the record aside
// first and verified afterwards (rename-to-a-token-unique-name, then restore) —
// the fence was absent for the width of the verify, twice over. Round 3 kept the
// canonical name occupied at all times but still REPLACED what stood there
// (read-then-rename) — measured: after an operator deleted a live claim, a stale
// terminal overwrote a successor's claim, and the next scan then told the operator
// that deleting it was safe while the successor's message was already on the
// phone. Occupancy was never the guarantee; CONTENT is. So the operation is not
// performed at all: two names, two exclusive creates, no mutation.
//
// A record is therefore removed only by an OPERATOR, told by a blocker exactly
// which files to remove and what is true about them. `buildEgressAckProofSection`
// carries the scan that decides that wording.
//
// The publication performs the ordering residual (b) names: same-directory temp
// file, write, fsync, close, atomic publish by link(2), directory fsync (plus the
// ancestor chain the caller did not create). It is named for what it does rather
// than given a generic `writeJson`-shaped name, because a durable write costs an
// fsync per call and the next caller should opt into that knowingly instead of
// inheriting it from a name that does not say so. (The plain `writeJson` helper
// that used to live here had exactly two callers, both of them this WAL, and was
// removed with them rather than left as a dead general-purpose write nobody had
// reviewed for a new use.)

// Directory-fsync failures that mean the PLATFORM cannot do it, as opposed to
// this machine refusing to. Measured on darwin/APFS (node 24, this repo's
// probe): `open(dir, 'r')` + `sync()` succeeds even against a mode-0500
// directory — so EACCES/EPERM here are NOT capability limits, they are real
// permission or I/O faults and MUST fail closed. Swallowing them would void the
// exact guarantee this step exists to establish (and would hide ENOSPC/EIO).
// Windows cannot open a directory handle this way at all; Node surfaces that as
// EISDIR. That Windows behaviour is UNMEASURED here (no Windows machine was
// available) and is recorded as a limit rather than claimed as tested.
const DIR_FSYNC_UNSUPPORTED_CODES = Object.freeze(['EISDIR', 'ENOTSUP', 'EOPNOTSUPP', 'EINVAL', 'ENOSYS']);

// link(2) failures that mean hard links are unavailable on this filesystem.
// POSIX gives EPERM for "the filesystem does not support links", which is a
// CAPABILITY answer; the directory-permission answer measured by the probe is
// EACCES, and that stays a write failure. Everything not listed is a write
// failure too — a claim that cannot be made is never downgraded to a replace.
const LINK_UNSUPPORTED_CODES = Object.freeze(['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EXDEV', 'EMLINK']);

// The two `open` shapes are named separately rather than passed a flags
// argument. That is not decoration: the runtime executor registry validates
// every open SITE for a literal read-only or exclusive-create flag, and a
// generic passthrough would hand it a bare parameter it must fail closed on.
// Splitting them makes the two intents explicit at the call site too.
//
// The bag holds exactly the five operations the publication performs. `rename`
// and `readFile` used to sit here for the replace-shaped terminal write; they
// left with it rather than staying as capabilities the primitive no longer uses.
// An ops bag is a capability grant, and an unused grant is how a mutation nobody
// reviewed gets reintroduced later without touching this comment.
const DEFAULT_PUBLISH_OPS = Object.freeze({
  mkdir,
  openDirForSync: (dirPath) => open(dirPath, 'r'),
  createExclusive: (filePath, mode) => open(filePath, 'wx', mode),
  link,
  unlink,
});

async function fsyncDirectory(dirPath, ops) {
  let handle;
  try {
    handle = await ops.openDirForSync(dirPath);
  } catch (err) {
    if (DIR_FSYNC_UNSUPPORTED_CODES.includes(err?.code)) return { ok: true, degraded: true, code: err?.code };
    return { ok: false, degraded: false, code: err?.code ?? 'error' };
  }
  try {
    await handle.sync();
    return { ok: true, degraded: false, code: null };
  } catch (err) {
    if (DIR_FSYNC_UNSUPPORTED_CODES.includes(err?.code)) return { ok: true, degraded: true, code: err?.code };
    return { ok: false, degraded: false, code: err?.code ?? 'error' };
  } finally {
    await handle.close().catch(() => {});
  }
}

// Stage the payload as a fully-written, fsynced, closed temp file NEXT TO the
// target. Same-directory is not a style choice: link(2)/rename(2) are only
// atomic within one filesystem. O_EXCL on the temp defeats stale-temp reuse and
// a crafted-symlink redirect through a predictable `.tmp` slot.
async function writeDurableTemp(targetPath, value, ops) {
  let text;
  try {
    text = `${JSON.stringify(value, null, 2)}\n`;
  } catch {
    return { ok: false, reason: 'unserializable', code: null, tmpPath: null, debris: null };
  }
  const tmpPath = join(dirname(targetPath), `.tmp-${randomBytes(6).toString('hex')}`);
  let handle;
  try {
    handle = await ops.createExclusive(tmpPath, 0o600);
  } catch (err) {
    return { ok: false, reason: 'write-failed', code: err?.code ?? 'error', tmpPath: null, debris: null };
  }
  try {
    await handle.writeFile(text, { encoding: 'utf8' });
    await handle.sync();
    // close() is part of the ordering, not cleanup. Some filesystems (NFS
    // notably) surface a delayed writeback error only here, so swallowing it
    // and publishing anyway would report `durable` for bytes that never landed
    // — the exact claim this primitive exists to make honest.
    await handle.close();
  } catch (err) {
    await handle.close().catch(() => {});          // best-effort on the failure path only
    // The staged file's own removal, reported rather than swallowed — the same
    // shape, in its third location. Fixing the post-publish copy and leaving
    // this one is precisely how one swallow survived three review rounds.
    let debris = null;
    try {
      await ops.unlink(tmpPath);
    } catch (cleanupErr) {
      debris = `the abandoned staged file ${basename(tmpPath)} could not be removed (${cleanupErr?.code ?? 'error'})`;
    }
    return { ok: false, reason: 'write-failed', code: err?.code ?? 'error', tmpPath: null, debris };
  }
  return { ok: true, reason: 'ok', code: null, tmpPath, debris: null };
}

// Persist the directory ENTRIES of the bounded chain between an anchor the
// caller did NOT create and the leaf directory it did.
//
// Peer MAJOR: fsyncing only the leaf leaves every ancestor's entry unpersisted,
// so on a cold home a power loss can lose the very directory the claim was
// reported durable in. A directory's entry lives in ITS parent, so the chain to
// sync is every directory from the anchor down to the leaf's PARENT; the leaf
// itself is synced by the caller after the record is published, which is the
// fsync that persists the record's own entry.
//
// Deliberately UNCONDITIONAL rather than keyed on what `mkdir` reports creating.
// `mkdir(..., {recursive:true})` resolves to the first path it created and to
// `undefined` when everything already existed, which is exactly backwards for a
// RETRY: a run whose chain sync failed leaves the directories in place but not
// durable, so the next run sees nothing created, skips the sync, and the gap
// survives precisely the retry meant to close it. Existence is not proof of
// durability — only the fsync is, and it is cheap enough to repeat.
//
// Degradation composes the same way a single directory fsync does — one
// unsupported link in the chain degrades the whole claim rather than being
// silently dropped, and a permission or I/O fault anywhere fails closed.
async function fsyncAncestorChain(leafDir, anchorDir, ops) {
  const rel = relative(resolve(anchorDir), resolve(leafDir));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    // Without a real anchor the walk has no bound, and syncing every directory
    // up to the filesystem root is not a decision this primitive may take on
    // its own. Fail closed rather than guess at the caller's intent.
    return { ok: false, degraded: false, code: 'anchor-not-ancestor' };
  }
  let degraded = false;
  let degradedCode = null;
  let cur = resolve(anchorDir);
  for (const segment of rel.split(sep).filter(Boolean)) {   // shallowest first
    const res = await fsyncDirectory(cur, ops);
    if (!res.ok) return res;
    if (res.degraded) { degraded = true; degradedCode = res.code; }
    cur = join(cur, segment);
  }
  return { ok: true, degraded, code: degradedCode };
}

function degradedLimit(what, code) {
  return `the directory entry for ${what} could not be fsynced on this platform (${code}); the record is written but its directory entry is not proven durable across a power loss`;
}

/**
 * Publish a JSON record durably at a name NOTHING may already occupy — the
 * publication succeeds only if the name is free, and the record is never
 * mutated afterwards.
 *
 * Both egress WAL publications go through this one function. For the claim, the
 * EEXIST failure IS the per-activation mutual exclusion residual (a) asks for:
 * the write that establishes the fence is the same act that excludes a
 * concurrent sender, so there is no separate lock and therefore no
 * stale-takeover policy to get wrong. For the terminal record, whose name
 * carries the attempt's own owner token, EEXIST cannot arise from an honest
 * concurrent attempt at all — so it is an anomaly the caller reports rather than
 * a race it recovers from.
 *
 * link(2), not rename(2), for the reason bootstrap-artifacts.mjs already states
 * for the family lock: rename silently REPLACES, which would hand two processes
 * the same activation, while link fails EEXIST — "claim it only if unclaimed".
 * link also publishes a fully-populated file (content exists before the name),
 * so a concurrent reader can never observe a created-but-empty record.
 *
 * `ancestorAnchor` is REQUIRED: it is the deepest directory the caller does not
 * create, and it bounds the chain whose entries this publication proves durable.
 * There is no default, because every default is a silent answer to a question
 * only the caller can answer — and an absent anchor would quietly shrink the
 * durability claim to the leaf, which is the defect the chain sync exists to
 * close. Making it explicit also means a call site that stops passing it FAILS
 * rather than degrades.
 *
 * The diagnostics are deliberately ROLE-NEUTRAL. One primitive serving two roles
 * must not assert which one it is serving — the caller knows whether a failure
 * means "no fence, do not send" or "the send happened but the WAL is one record
 * short", and it is the caller that words the operator-facing consequence.
 *
 * @returns {Promise<{ok: boolean, reason: string, published: boolean, durable: boolean, limit: string|null, diagnostic: string|null}>}
 */
export async function publishJsonExclusive(targetPath, value, { ops = DEFAULT_PUBLISH_OPS, ancestorAnchor = null } = {}) {
  const dir = dirname(targetPath);
  const name = basename(targetPath);
  const fail = (reason, diagnostic, published = false) => ({ ok: false, reason, published, durable: false, limit: null, diagnostic, debris: null });
  if (typeof ancestorAnchor !== 'string' || ancestorAnchor.length === 0) {
    return fail('anchor-missing', `no ancestor anchor was given for ${name}, so the directory chain holding it cannot be proven durable; refusing to publish a record whose durability is unstated`);
  }
  try {
    await ops.mkdir(dir, { recursive: true });
  } catch (err) {
    return fail('write-failed', `could not create the directory for ${name} (${err?.code ?? 'error'})`);
  }
  const chainSync = await fsyncAncestorChain(dir, ancestorAnchor, ops);
  if (!chainSync.ok) {
    return fail('dir-fsync-failed', `the directory chain holding ${name} was created but could not be fsynced (${chainSync.code}); refusing to treat the record as durable`);
  }
  const staged = await writeDurableTemp(targetPath, value, ops);
  if (!staged.ok) {
    const res = fail(staged.reason, `could not stage a durable record for ${name} (${staged.code ?? staged.reason})${staged.debris ? `; additionally, ${staged.debris}` : ''}`);
    return { ...res, debris: staged.debris };
  }
  // Dropping our own staged temp is the one removal this function performs, and
  // it is safe because the name is one this call invented. But a FAILED drop is
  // reported, not swallowed: the leftover `.tmp-*` is invisible to the scan (it
  // does not end in `.json`), so silence turns it into debris that accumulates
  // in a directory retention is forbidden to sweep. This is the same swallow the
  // family lock's restore carried — fixing one copy and leaving the other is how
  // that bug survived three rounds in the first place.
  const dropStagedTemp = async () => {
    try {
      await ops.unlink(staged.tmpPath);
      return null;
    } catch (err) {
      return `the staged temp file ${basename(staged.tmpPath)} could not be removed (${err?.code ?? 'error'})`;
    }
  };
  try {
    await ops.link(staged.tmpPath, targetPath);
  } catch (err) {
    const debris = await dropStagedTemp();
    const tail = debris ? `; additionally, ${debris}` : '';
    if (err?.code === 'EEXIST') {
      return { ...fail('name-taken', `${name} is already occupied${tail}`), debris };
    }
    if (LINK_UNSUPPORTED_CODES.includes(err?.code)) {
      // Never fall back to a replace-shaped publish. An exclusive create that
      // only looks exclusive is worse than an honest refusal to proceed.
      return { ...fail('link-unsupported', `this filesystem cannot create hard links (${err?.code}), so ${name} cannot be published exclusively${tail}`), debris };
    }
    return { ...fail('write-failed', `could not publish ${name} (${err?.code ?? 'error'})${tail}`), debris };
  }
  const debris = await dropStagedTemp();
  const dirSync = await fsyncDirectory(dir, ops);
  if (!dirSync.ok) {
    // `published: true` — the record IS at its name; only the durability claim
    // failed. The caller needs that distinction: a record on disk still fences,
    // and telling an operator it was not written would be false.
    return { ...fail('dir-fsync-failed', `${name} was published but its directory could not be fsynced (${dirSync.code}); the record is in place but is not proven durable across a power loss${debris ? `; additionally, ${debris}` : ''}`, true), debris };
  }
  const degraded = dirSync.degraded || chainSync.degraded;
  const limits = [];
  if (degraded) limits.push(degradedLimit(name, dirSync.code ?? chainSync.code));
  if (debris) limits.push(`${debris}; ${name} itself is correct, but the leftover sidecar stays in a directory retention is forbidden to sweep`);
  return { ok: true, reason: 'ok', published: true, durable: !degraded, limit: limits.length > 0 ? limits.join('; ') : null, diagnostic: null, debris };
}

// Worst-wins across BOTH publication phases: failed > degraded > durable.
//
// Peer MINOR: computing this from the terminal result alone reported `durable`
// when the CLAIM had degraded and only the terminal was clean, which also
// suppressed the overall warning that exists to surface exactly that state.
// Exported because it is otherwise reachable only through paths that cannot
// inject a degraded claim, and an untestable aggregation is one nobody checks.
export function aggregateWalDurability(claim, terminal) {
  if (!terminal?.ok) return 'failed';
  return (terminal.durable && claim?.durable) ? 'durable' : 'degraded';
}

async function assertInside(root, target) {
  const rel = relative(resolve(root), resolve(target));
  if (rel === '..' || rel.startsWith(`..${sep}`) || rel === '') {
    if (rel !== '') throw new Error(`Refusing to write outside doctor artifact root: ${target}`);
  }
}

function parseNonNegativeInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function sanitizeStringMap(value) {
  const result = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [key, mapValue] of Object.entries(value)) {
    const safeKey = sanitizeValue(key);
    if (!safeKey) continue;
    result[safeKey] = sanitizeValue(mapValue);
  }
  return result;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function truncate(value, maxLength) {
  const text = String(value ?? '');
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`;
}

function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))];
}

function sameStringSet(left, right) {
  const a = uniqueStrings(left ?? []).sort();
  const b = uniqueStrings(right ?? []).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function usage() {
  return `Usage: doctor.mjs [--repo-root <path>] [--format text|json] [--host auto|claude|codex] [--model <id>] [--effort <level>] [--sandbox-permission-probe] [--permission-proof] [--execute-permission-proof] [--permission-proof-timeout-ms <n>] [--egress-ack-proof] [--execute-egress-ack-proof] [--deep-peer-smoke] [--execute-deep-peer-smoke] [--deep-peer-smoke-timeout-ms <n>] [--workflow-continuation-proof] [--execute-workflow-continuation-proof] [--workflow-continuation-proof-timeout-ms <n>] [--artifact-inventory] [--artifact-retention-cap <n>] [--artifact-max-bytes <n>] [--permission-diagnosis] [--permission-diagnosis-max-files <n>] [--permission-diagnosis-max-file-bytes <n>] [--record] [--run-id <doctor-run-id>]\n`;
}

export function parseArgs(argv) {
  const opts = {
    repoRoot: process.cwd(),
    format: 'text',
    host: 'auto',
    explicitModel: null,
    explicitEffort: null,
    deepPeerSmoke: false,
    executeDeepPeerSmoke: false,
    deepPeerSmokeTimeoutMs: DEFAULT_DEEP_PEER_SMOKE_TIMEOUT_MS,
    sandboxPermissionProbe: false,
    permissionProof: false,
    executePermissionProof: false,
    permissionProofTimeoutMs: DEFAULT_PERMISSION_PROOF_TIMEOUT_MS,
    egressAckProof: false,
    executeEgressAckProof: false,
    workflowContinuationProof: false,
    executeWorkflowContinuationProof: false,
    workflowContinuationProofTimeoutMs: DEFAULT_WORKFLOW_CONTINUATION_PROOF_TIMEOUT_MS,
    artifactInventory: false,
    artifactRetentionCap: DEFAULT_ARTIFACT_RETENTION_CAP,
    artifactMaxBytes: DEFAULT_ARTIFACT_RETENTION_MAX_BYTES,
    permissionDiagnosis: false,
    permissionDiagnosisMaxFiles: DEFAULT_PERMISSION_DIAGNOSIS_MAX_FILES,
    permissionDiagnosisMaxFileBytes: DEFAULT_PERMISSION_DIAGNOSIS_MAX_FILE_BYTES,
    recordArtifact: false,
    runId: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--repo-root') {
      opts.repoRoot = requireValue(argv, ++i, arg);
    } else if (arg === '--format') {
      opts.format = requireValue(argv, ++i, arg);
      if (!['text', 'json'].includes(opts.format)) throw new Error('--format must be text or json');
    } else if (arg === '--host') {
      opts.host = requireValue(argv, ++i, arg);
      if (!['auto', 'claude', 'codex'].includes(opts.host)) throw new Error('--host must be auto, claude, or codex');
    } else if (arg === '--model') {
      opts.explicitModel = requireValue(argv, ++i, arg);
    } else if (arg === '--effort') {
      opts.explicitEffort = requireValue(argv, ++i, arg);
    } else if (arg === '--deep-peer-smoke') {
      opts.deepPeerSmoke = true;
    } else if (arg === '--execute-deep-peer-smoke') {
      opts.executeDeepPeerSmoke = true;
    } else if (arg === '--deep-peer-smoke-timeout-ms') {
      opts.deepPeerSmokeTimeoutMs = parsePositiveIntArg(requireValue(argv, ++i, arg), arg);
    } else if (arg === '--sandbox-permission-probe') {
      opts.sandboxPermissionProbe = true;
    } else if (arg === '--permission-proof') {
      opts.permissionProof = true;
    } else if (arg === '--execute-permission-proof') {
      opts.executePermissionProof = true;
    } else if (arg === '--permission-proof-timeout-ms') {
      opts.permissionProofTimeoutMs = parsePositiveIntArg(requireValue(argv, ++i, arg), arg);
    } else if (arg === '--egress-ack-proof') {
      opts.egressAckProof = true;
    } else if (arg === '--execute-egress-ack-proof') {
      opts.executeEgressAckProof = true;
      // Deliberately NO --egress-ack-proof-timeout-ms (Plan-verify peer): the
      // send is already time-bounded inside the pinned emitter
      // (AbortSignal.timeout on the one node:https request); a second outer
      // timeout could abandon a request whose body reached the wire — exactly
      // the ambiguous attempt the intent WAL exists to prevent.
    } else if (arg === '--workflow-continuation-proof') {
      opts.workflowContinuationProof = true;
    } else if (arg === '--execute-workflow-continuation-proof') {
      opts.executeWorkflowContinuationProof = true;
    } else if (arg === '--workflow-continuation-proof-timeout-ms') {
      opts.workflowContinuationProofTimeoutMs = parsePositiveIntArg(requireValue(argv, ++i, arg), arg);
    } else if (arg === '--artifact-inventory') {
      opts.artifactInventory = true;
    } else if (arg === '--artifact-retention-cap') {
      opts.artifactRetentionCap = parsePositiveIntArg(requireValue(argv, ++i, arg), arg);
    } else if (arg === '--artifact-max-bytes') {
      opts.artifactMaxBytes = parsePositiveIntArg(requireValue(argv, ++i, arg), arg);
    } else if (arg === '--permission-diagnosis') {
      opts.permissionDiagnosis = true;
    } else if (arg === '--permission-diagnosis-max-files') {
      opts.permissionDiagnosisMaxFiles = parsePositiveIntArg(requireValue(argv, ++i, arg), arg);
    } else if (arg === '--permission-diagnosis-max-file-bytes') {
      opts.permissionDiagnosisMaxFileBytes = parsePositiveIntArg(requireValue(argv, ++i, arg), arg);
    } else if (arg === '--record') {
      opts.recordArtifact = true;
    } else if (arg === '--run-id') {
      opts.runId = validateDoctorRunId(requireValue(argv, ++i, arg));
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (opts.runId && !opts.recordArtifact) {
    throw new Error('--run-id requires --record');
  }
  if (opts.executeDeepPeerSmoke && !opts.deepPeerSmoke) {
    throw new Error('--execute-deep-peer-smoke requires --deep-peer-smoke');
  }
  if (opts.executePermissionProof && !opts.permissionProof) {
    throw new Error('--execute-permission-proof requires --permission-proof');
  }
  if (opts.executeEgressAckProof && !opts.egressAckProof) {
    throw new Error('--execute-egress-ack-proof requires --egress-ack-proof');
  }
  if (opts.executeWorkflowContinuationProof && !opts.workflowContinuationProof) {
    throw new Error('--execute-workflow-continuation-proof requires --workflow-continuation-proof');
  }
  return opts;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parsePositiveIntArg(value, flag) {
  if (!/^[1-9][0-9]*$/.test(String(value ?? ''))) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return Number.parseInt(value, 10);
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n${usage()}`);
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(usage());
    process.exit(0);
  }
  try {
    await access(opts.repoRoot, fsConstants.R_OK);
  } catch (err) {
    process.stderr.write(`repo root is not readable: ${err.message}\n`);
    process.exit(2);
  }
  const report = await runDoctor(opts);
  if (opts.format === 'json') {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatText(report));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`runtime:doctor failed: ${err.stack ?? err.message}\n`);
    process.exit(1);
  });
}
