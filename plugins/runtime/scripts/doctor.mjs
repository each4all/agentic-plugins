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
import { access, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUNTIME_VERSION } from './version.mjs';

export { RUNTIME_VERSION };

export const CONTRACT_COMPATIBLE_MAJOR = 0;
export const PLUGIN_NAMES = ['companions', 'engineer', 'orchestrator', 'runtime'];
export const TERMINAL_PEER_RUN_STATUSES = new Set(['completed', 'failed', 'cancelled', 'orphaned', 'pruned']);
export const VALID_PEER_RUN_STATUSES = new Set([
  'queued',
  'spawning',
  'running',
  'completed',
  'failed',
  'cancel_requested',
  'cancelled',
  'orphaned',
  'pruned',
]);

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_STALE_GRACE_MS = 60000;
const DEFAULT_DEEP_PEER_SMOKE_TIMEOUT_MS = 120000;
const DEFAULT_PERMISSION_PROOF_TIMEOUT_MS = 120000;
const DEFAULT_WORKFLOW_CONTINUATION_PROOF_TIMEOUT_MS = 120000;
const DEFAULT_ARTIFACT_RETENTION_CAP = 20;
const DEFAULT_ARTIFACT_RETENTION_MAX_BYTES = 50 * 1024 * 1024;
const SETTINGS_RUN_ID_RE = /^settings-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const CONSENSUS_RUN_ID_RE = /^consensus-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const COMPAT_RUN_ID_RE = /^compat-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const DOCTOR_RUN_ID_RE = /^doctor-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const DOCTOR_ARTIFACT_SCHEMA_VERSION = 'runtime-doctor-artifact-1.0';
const DOCTOR_LATEST_SCHEMA_VERSION = 'runtime-doctor-latest-1.0';
const RUNTIME_ARTIFACT_FAMILIES = ['compat', 'consensus', 'context', 'settings', 'doctor'];
const CLAUDE_PLUGIN_SURFACE_UNAVAILABLE_RE = /\/plugin (?:isn't|is not) available in this environment/i;

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
  workflowContinuationProof = false,
  executeWorkflowContinuationProof = false,
  workflowContinuationProofTimeoutMs = DEFAULT_WORKFLOW_CONTINUATION_PROOF_TIMEOUT_MS,
  artifactInventory = false,
  artifactRetentionCap = DEFAULT_ARTIFACT_RETENTION_CAP,
  artifactMaxBytes = DEFAULT_ARTIFACT_RETENTION_MAX_BYTES,
  recordArtifact = false,
  runId = null,
} = {}) {
  if (executeDeepPeerSmoke && !deepPeerSmoke) {
    throw new Error('--execute-deep-peer-smoke requires --deep-peer-smoke');
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

  const [claude, codex] = await Promise.all([
    inspectCli('claude', {
      versionArgs: ['--version'],
      helpArgs: ['--help'],
      extraHelpArgs: ['plugin', '--help'],
      authArgs: ['auth', 'status'],
      pluginArgs: ['plugin', 'list'],
      pluginSurfaceArgs: ['/plugin', 'list'],
      runner,
      cwd: resolvedRepoRoot,
      env,
    }),
    inspectCli('codex', {
      versionArgs: ['--version'],
      helpArgs: ['--help'],
      extraHelpArgs: ['exec', '--help'],
      featureArgs: ['features', 'list'],
      authArgs: ['login', 'status'],
      pluginArgs: ['plugin', 'marketplace', '--help'],
      runner,
      cwd: resolvedRepoRoot,
      env,
    }),
  ]);

  const source = await inspectSourcePluginState(resolvedRepoRoot);
  const catalogs = await inspectCatalogs(resolvedRepoRoot);
  const caches = await inspectPluginCaches(resolvedHomeDir);
  const claudePluginList = parseClaudePluginList(claude.plugin?.stdout ?? '');
  const plugins = buildPluginMatrix({ source, catalogs, caches, claudePluginList });
  const codexPluginHooks = await buildCodexPluginHookReport({
    codex,
    plugins,
    homeDir: resolvedHomeDir,
  });
  const hostParity = buildHostParity({ claude, codex, plugins, claudePluginList, codexPluginHooks });
  const settingsRuns = await inspectSettingsRuns({
    repoRoot: resolvedRepoRoot,
  });
  const pluginCommandSurface = buildPluginCommandSurface({ claude, codex, plugins, hostParity, codexPluginHooks, settingsRuns });
  const companion = await inspectCompanionContract({
    repoRoot: resolvedRepoRoot,
    homeDir: resolvedHomeDir,
  });
  const modelEffort = await inspectModelEffort({
    repoRoot: resolvedRepoRoot,
    homeDir: resolvedHomeDir,
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
    sandbox_permission_probe: sandboxPermissionProbeSection,
    permission_proof: permissionProofSection,
    deep_peer_smoke: deepPeerSmokeSection,
    workflow_continuation_proof: workflowContinuationProofSection,
    clis: {
      claude: redactCommandDetails(claude),
      codex: redactCommandDetails(codex),
    },
    plugins,
    plugin_command_surface: pluginCommandSurface,
    codex_plugin_hooks: codexPluginHooks,
    host_parity: hostParity,
    companions: companion,
    model_effort: modelEffort,
    settings_runs: settingsRuns,
    consensus_runs: consensusRuns,
    compat_runs: compatRuns,
    doctor_runs: doctorRuns,
    recorded_doctor_proof: recordedDoctorProof,
    artifact_inventory: artifactInventorySection,
    readiness_matrix: readinessMatrix,
    experience_parity: experienceParity,
    readiness,
    ledgers,
    limits: [
      'Codex bundled plugin hooks require both manifest exposure and [features].plugin_hooks=true; doctor reports those separately from generic hooks.',
      'Codex hook review/trust is an active-session /hooks UI check; /hooks Installed counts are packaging evidence only, and Active=0 output is not enough to attest.',
      'The observed Codex CLI does not expose a non-interactive hook trust query, so doctor requires a current runtime:settings operator attestation to clear that follow-up.',
      'Readiness sandbox/permission status remains unknown unless --sandbox-permission-probe is requested; --permission-proof records separate preflight/execution evidence.',
      'Settings mutation belongs to runtime:settings; dynamic consensus, context hygiene, and completion footer mutation are deferred.',
      'Artifact inventory is read-only; runtime:doctor never deletes or compacts generated artifacts.',
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

async function inspectCli(name, { versionArgs, helpArgs, extraHelpArgs = null, featureArgs = null, authArgs, pluginArgs, pluginSurfaceArgs = null, runner, cwd, env }) {
  const version = await runner(name, versionArgs, { cwd, env });
  const available = version.ok || version.exit_code !== null;
  const help = available ? await runner(name, helpArgs, { cwd, env }) : skipped('cli unavailable');
  const extraHelp = available && extraHelpArgs ? await runner(name, extraHelpArgs, { cwd, env }) : skipped('not requested');
  const featuresRaw = available && featureArgs ? await runner(name, featureArgs, { cwd, env }) : skipped('not requested');
  const authRaw = available ? await runner(name, authArgs, { cwd, env }) : skipped('cli unavailable');
  const pluginRaw = available ? await runner(name, pluginArgs, { cwd, env }) : skipped('cli unavailable');
  const pluginSurfaceRaw = available && pluginSurfaceArgs ? await runner(name, pluginSurfaceArgs, { cwd, env }) : skipped('not requested');
  const auth = name === 'claude' ? parseClaudeAuth(authRaw, env) : parseCodexAuth(authRaw);
  const featureText = name === 'claude'
    ? `${help.stdout}\n${help.stderr}\n${extraHelp.stdout}\n${extraHelp.stderr}\n${pluginRaw.stdout}\n${pluginRaw.stderr}\n${pluginSurfaceRaw.stdout}\n${pluginSurfaceRaw.stderr}`
    : `${help.stdout}\n${help.stderr}\n${extraHelp.stdout}\n${extraHelp.stderr}\n${pluginRaw.stdout}\n${pluginRaw.stderr}`;
  const featureSurface = name === 'claude'
    ? inspectClaudeFeatureSurface(featureText)
    : inspectCodexFeatureSurface(featureText, featuresRaw);

  return {
    name,
    status: available ? 'available' : 'unavailable',
    version: {
      status: commandStatus(version),
      text: singleLine(version.ok ? version.stdout || version.stderr : version.stderr || version.error_message || ''),
      exit_code: version.exit_code,
      error_code: version.error_code,
    },
    auth,
    feature_surface: featureSurface,
    features: {
      status: commandStatus(featuresRaw),
      exit_code: featuresRaw.exit_code,
      error_code: featuresRaw.error_code,
    },
    plugin: {
      status: commandStatus(pluginRaw),
      stdout: pluginRaw.stdout,
      stderr: pluginRaw.stderr,
      exit_code: pluginRaw.exit_code,
      error_code: pluginRaw.error_code,
    },
    plugin_surface: inspectHostPluginSurface({ host: name, result: pluginSurfaceRaw }),
  };
}

function inspectHostPluginSurface({ host, result }) {
  if (result.error_code === 'skipped') {
    return {
      status: 'unknown',
      exit_code: null,
      error_code: 'skipped',
      reason: 'not requested',
    };
  }
  const text = singleLine(`${result.stdout} ${result.stderr} ${result.error_message ?? ''}`);
  if (host === 'claude' && CLAUDE_PLUGIN_SURFACE_UNAVAILABLE_RE.test(text)) {
    return {
      status: 'unavailable',
      exit_code: result.exit_code,
      error_code: 'HOST_PLUGIN_SURFACE_UNAVAILABLE',
      reason: 'host plugin command surface is unavailable in this environment',
    };
  }
  return {
    status: commandStatus(result),
    exit_code: result.exit_code,
    error_code: result.error_code,
    reason: result.ok ? null : redactSecrets(text),
  };
}

function skipped(reason) {
  return { ok: false, exit_code: null, stdout: '', stderr: reason, error_code: 'skipped', timed_out: false };
}

function commandStatus(result) {
  if (result.ok) return 'available';
  if (result.error_code === 'ENOENT') return 'unavailable';
  if (result.error_code === 'ETIMEDOUT') return 'blocked';
  if (result.error_code === 'skipped') return 'unknown';
  return 'unknown';
}

function parseClaudeAuth(result, env = {}) {
  const jsonAuth = parseClaudeAuthJson(result.stdout, env) ?? parseClaudeAuthJson(result.stderr, env);
  if (jsonAuth) return jsonAuth;
  if (!result.ok) return classifyAuthFailure(result, { host: 'claude', env });

  const text = singleLine(`${result.stdout} ${result.stderr}`);
  if (/not logged in|login required|unauth/i.test(text)) {
    if (isCodexSandboxEnv(env)) return sandboxLimitedAuth({ sensitiveFields: [] });
    return { status: 'unauthenticated', logged_in: false, sensitive_fields_redacted: [] };
  }
  return { status: 'unknown', logged_in: null, detail: redactSecrets(text), sensitive_fields_redacted: [] };
}

function parseClaudeAuthJson(text, env = {}) {
  if (!text || !text.trim()) return null;
  try {
    const json = JSON.parse(text);
    if (json.loggedIn === true) {
      return {
        status: 'available',
        logged_in: true,
        method: sanitizeValue(json.authMethod),
        provider: sanitizeValue(json.apiProvider),
        subscription: sanitizeValue(json.subscriptionType),
        sensitive_fields_redacted: ['email', 'orgId', 'orgName'],
      };
    }
    if (json.loggedIn === false) {
      if (isCodexSandboxEnv(env)) {
        return sandboxLimitedAuth({ sensitiveFields: ['email', 'orgId', 'orgName'] });
      }
      return { status: 'unauthenticated', logged_in: false, sensitive_fields_redacted: ['email', 'orgId', 'orgName'] };
    }
  } catch {
    return null;
  }
  return null;
}

function isCodexSandboxEnv(env = {}) {
  return Boolean(env.CODEX_SANDBOX);
}

function sandboxLimitedAuth({ sensitiveFields }) {
  return {
    status: 'sandbox_limited',
    logged_in: null,
    observed_logged_in: false,
    detail: 'auth status returned loggedIn=false inside the current Codex sandbox; host credentials may be inaccessible to this probe',
    next_step: 'Verify with an approved direct host auth command or rerun runtime:doctor outside the current sandbox before deciding to login.',
    sensitive_fields_redacted: sensitiveFields,
  };
}

function parseCodexAuth(result) {
  if (!result.ok) {
    return classifyAuthFailure(result, { host: 'codex' });
  }
  const text = singleLine(`${result.stdout} ${result.stderr}`);
  if (/logged in/i.test(text) && !/not logged in/i.test(text)) {
    const method = text.replace(/^Logged in using\s+/i, '').trim();
    return {
      status: 'available',
      logged_in: true,
      method: sanitizeValue(method),
      sensitive_fields_redacted: [],
    };
  }
  if (/not logged in|login required|unauth/i.test(text)) {
    return { status: 'unauthenticated', logged_in: false, sensitive_fields_redacted: [] };
  }
  return { status: 'unknown', logged_in: null, detail: redactSecrets(text), sensitive_fields_redacted: [] };
}

function classifyAuthFailure(result, { host = 'unknown', env = {} } = {}) {
  const text = singleLine(`${result.stdout} ${result.stderr} ${result.error_message ?? ''}`);
  if (result.error_code === 'ENOENT') return { status: 'unavailable', logged_in: null, detail: 'cli unavailable' };
  if (result.error_code === 'ETIMEDOUT') return { status: 'blocked', logged_in: null, detail: 'auth status probe timed out' };
  if (/not logged in|login required|unauth/i.test(text)) {
    if (host === 'claude' && isCodexSandboxEnv(env)) return sandboxLimitedAuth({ sensitiveFields: [] });
    return { status: 'unauthenticated', logged_in: false };
  }
  return { status: 'unknown', logged_in: null, detail: redactSecrets(text) };
}

function inspectClaudeFeatureSurface(helpText) {
  return {
    plugin_command: /\bplugin\|plugins\b|\bplugins?\s+Manage Claude Code plugins/i.test(helpText),
    plugin_list_command: /\bplugin\s+list\b|\bplugin list\b|Installed plugins/i.test(helpText),
    plugin_install_command: /\bplugin\s+install\b|\binstall\b/i.test(helpText),
    plugin_update_command: /\bplugin\s+update\b|\bupdate\b/i.test(helpText),
    plugin_uninstall_command: /\bplugin\s+uninstall\b|\buninstall\b/i.test(helpText),
    auth_status: /\bauth\b[\s\S]*\bstatus\b/i.test(helpText),
    print_mode: /--print|-p,\s*--print/.test(helpText),
    no_session_persistence: /--no-session-persistence/.test(helpText),
    model_flag: /--model\b/.test(helpText),
    effort_flag: /--effort\b/.test(helpText),
    permission_mode: /--permission-mode/.test(helpText),
    plugin_dir: /--plugin-dir/.test(helpText),
    automatic_plugin_hooks: true,
  };
}

function inspectCodexFeatureSurface(helpText, featuresRaw) {
  const featureList = parseCodexFeatureList(featuresRaw);
  const hooks = featureList.features.hooks ?? null;
  const pluginHooks = featureList.features.plugin_hooks ?? null;
  return {
    exec_command: /\bexec\b[\s\S]*Run Codex non-interactively/i.test(helpText) || /\bexec\b/.test(helpText),
    login_status: /\blogin\b[\s\S]*\bstatus\b/i.test(helpText),
    plugin_marketplace: /\bplugin\b[\s\S]*\bmarketplace\b/i.test(helpText),
    plugin_marketplace_add: /\badd\b/.test(helpText),
    plugin_marketplace_upgrade: /\bupgrade\b/.test(helpText),
    plugin_marketplace_remove: /\bremove\b/.test(helpText),
    plugin_install_command: /\binstall\b/.test(helpText),
    plugin_list_command: /\blist\b/.test(helpText),
    model_flag: /--model\b|-m,\s*--model/.test(helpText),
    config_flag: /--config\b|-c,\s*--config/.test(helpText),
    cd_flag: /--cd\b|-C,\s*--cd/.test(helpText),
    sandbox_flag: /--sandbox\b/.test(helpText),
    approval_flag: /--ask-for-approval\b/.test(helpText),
    feature_list_command: featureList.status,
    codex_global_hooks: hooks?.enabled ?? null,
    codex_global_hooks_stage: hooks?.stage ?? null,
    codex_plugin_hooks: pluginHooks?.enabled ?? null,
    codex_plugin_hooks_stage: pluginHooks?.stage ?? null,
    automatic_plugin_hooks: pluginHooks?.enabled === true,
  };
}

function parseCodexFeatureList(result) {
  const status = commandStatus(result);
  const features = {};
  if (!result.ok) return { status, features };
  for (const rawLine of String(result.stdout ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^([A-Za-z0-9_]+)\s+(.+?)\s+(true|false)$/);
    if (!match) continue;
    features[match[1]] = {
      stage: match[2].trim(),
      enabled: match[3] === 'true',
    };
  }
  return { status: 'available', features };
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

async function inspectPluginCaches(homeDir) {
  const result = {
    claude: {},
    codex: {},
    codex_tmp_marketplace: {},
  };
  for (const name of PLUGIN_NAMES) {
    result.claude[name] = await scanVersionedManifestDir({
      baseDir: join(homeDir, '.claude', 'plugins', 'cache', 'agentic-plugins', name),
      manifestRel: join('.claude-plugin', 'plugin.json'),
    });
    result.codex[name] = await scanVersionedManifestDir({
      baseDir: join(homeDir, '.codex', 'plugins', 'cache', 'agentic-plugins', name),
      manifestRel: join('.codex-plugin', 'plugin.json'),
    });
    result.codex_tmp_marketplace[name] = await readSingleManifest({
      manifestPath: join(
        homeDir,
        '.codex',
        '.tmp',
        'marketplaces',
        'agentic-plugins',
        'plugins',
        name,
        '.codex-plugin',
        'plugin.json',
      ),
    });
  }
  return result;
}

async function scanVersionedManifestDir({ baseDir, manifestRel }) {
  let entries;
  try {
    entries = await readdir(baseDir, { withFileTypes: true });
  } catch (err) {
    return { status: 'missing', base_dir: baseDir, versions: [], error: err.code ?? err.message };
  }
  const versions = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(baseDir, entry.name, manifestRel);
    const manifest = await readJsonIfExists(manifestPath);
    if (!manifest.ok) continue;
    const pluginRoot = dirname(dirname(manifestPath));
    versions.push({
      version_dir: entry.name,
      manifest_version: manifest.json.version ?? null,
      manifest_name: manifest.json.name ?? null,
      path: pluginRoot,
      manifest_hooks: summarizeManifestHookField(manifest.json.hooks),
      manifest_hooks_file: await manifestHooksFileSummary({
        pluginRoot,
        manifestHooks: summarizeManifestHookField(manifest.json.hooks),
      }),
      default_hooks_file: await hooksFileSummary(join(pluginRoot, 'hooks', 'hooks.json')),
    });
  }
  versions.sort((a, b) => semverCompare(String(b.manifest_version ?? b.version_dir), String(a.manifest_version ?? a.version_dir)));
  return {
    status: versions.length > 0 ? 'available' : 'not_installed',
    base_dir: baseDir,
    latest: versions[0] ?? null,
    versions,
  };
}

async function readSingleManifest({ manifestPath }) {
  const manifest = await readJsonIfExists(manifestPath);
  if (!manifest.ok) return { status: 'missing', manifest_path: manifestPath, error: manifest.reason };
  return {
    status: 'available',
    manifest_path: manifestPath,
    manifest_name: manifest.json.name ?? null,
    manifest_version: manifest.json.version ?? null,
    path: dirname(dirname(manifestPath)),
    manifest_hooks: summarizeManifestHookField(manifest.json.hooks),
    manifest_hooks_file: await manifestHooksFileSummary({
      pluginRoot: dirname(dirname(manifestPath)),
      manifestHooks: summarizeManifestHookField(manifest.json.hooks),
    }),
    default_hooks_file: await hooksFileSummary(join(dirname(dirname(manifestPath)), 'hooks', 'hooks.json')),
  };
}

function buildPluginMatrix({ source, catalogs, caches, claudePluginList }) {
  const result = {};
  for (const name of PLUGIN_NAMES) {
    result[name] = {
      source: source[name],
      marketplace: {
        claude: catalogs.claude.entries?.[name] ?? null,
        codex: catalogs.codex.entries?.[name] ?? null,
      },
      installed: {
        claude_plugin_list: claudePluginList[name] ?? null,
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
      }),
    };
  }
  return result;
}

function summarizePluginStatus({ source, claudeEntry, codexEntry, claudeCache, codexCache, claudeInstalled }) {
  if (claudeInstalled?.status === 'failed') return 'blocked';
  if (claudeCache?.status === 'available' || codexCache?.status === 'available') {
    return 'available';
  }
  if (claudeInstalled?.status === 'enabled') return 'available';
  if (!source?.present) return 'not_installed';
  if (!claudeEntry || !codexEntry) return 'source_available';
  return 'source_available';
}

function parseClaudePluginList(stdout) {
  const result = {};
  const lines = stdout.split(/\r?\n/);
  let current = null;
  for (const raw of lines) {
    const line = raw.trim();
    const start = line.match(/^\S?\s*([A-Za-z0-9._-]+)@([A-Za-z0-9._-]+)/);
    if (start) {
      current = {
        name: start[1],
        marketplace: start[2],
        version: null,
        scope: null,
        status: null,
        error: null,
      };
      if (current.marketplace === 'agentic-plugins') {
        result[current.name] = current;
      }
      continue;
    }
    if (!current || current.marketplace !== 'agentic-plugins') continue;
    if (/^Version:/i.test(line)) current.version = line.replace(/^Version:\s*/i, '');
    if (/^Scope:/i.test(line)) current.scope = line.replace(/^Scope:\s*/i, '');
    if (/^Status:/i.test(line)) {
      const statusText = line.replace(/^Status:\s*/i, '');
      current.status = /failed/i.test(statusText) ? 'failed' : /enabled/i.test(statusText) ? 'enabled' : redactSecrets(statusText);
    }
    if (/^Error:/i.test(line)) current.error = redactSecrets(line.replace(/^Error:\s*/i, ''));
  }
  return result;
}

async function buildCodexPluginHookReport({ codex, plugins, homeDir }) {
  const plugin_entries = {};
  const summary = {
    bundled_plugins: [],
    manifest_exposed_plugins: [],
    default_file_only_plugins: [],
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
    if (effective.bundled) summary.bundled_plugins.push(name);
    if (effective.manifest_declared) summary.manifest_exposed_plugins.push(name);
    if (effective.status === 'default_file_only') summary.default_file_only_plugins.push(name);
    if (effective.status === 'manifest_declared_missing_file') summary.missing_hooks_file_plugins.push(name);
    if ((effective.hooks_file?.command_analysis?.warnings ?? []).length > 0) summary.command_warning_plugins.push(name);
    if ((effective.hooks_file?.command_analysis?.claude_plugin_root_references ?? 0) > 0) summary.claude_root_command_plugins.push(name);
    if ((effective.hooks_file?.command_analysis?.claude_adapter_references ?? 0) > 0) summary.claude_adapter_command_plugins.push(name);
    if ((effective.hooks_file?.command_analysis?.bare_node_command_references ?? 0) > 0) summary.bare_node_command_plugins.push(name);
  }

  for (const value of Object.values(summary)) value.sort();
  const reviewTargets = buildCodexHookReviewTargets({ summary, plugin_entries, plugins });
  const hookState = await buildCodexHookStateReport({ homeDir, reviewTargets });
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
  if (summary.bundled_plugins.length > 0 && codex.feature_surface.codex_plugin_hooks !== true) {
    recommendations.push({
      host: 'codex',
      area: 'hooks',
      action: 'enable-codex-plugin-hooks',
      executable: false,
      command: 'codex --enable plugin_hooks',
      config_snippet: '[features]\nplugin_hooks = true\n',
      detail: 'Codex bundled plugin hooks are packaged, but plugin_hooks is not enabled in the observed feature surface.',
      next_step: 'Enable plugin_hooks for a test session or in Codex config, then review/trust hooks with /hooks and rerun runtime:doctor.',
    });
  }
  if (hookState.summary.expected_disabled > 0) {
    recommendations.push({
      host: 'codex',
      area: 'hooks',
      action: 'enable-codex-hook-state',
      executable: false,
      detail: `Codex user config has disabled hook state for ${hookState.summary.expected_disabled}/${hookState.summary.expected} expected bundled hook entries.`,
      next_step: 'Open /hooks, enable and trust the listed agentic-plugins hooks. If /hooks still shows old cache-version node commands, restart Codex so the latest plugin registry is loaded, then review again.',
    });
  }

  const status = summary.default_file_only_plugins.length > 0 || summary.missing_hooks_file_plugins.length > 0
    ? 'packaging_gap'
    : summary.bundled_plugins.length === 0
      ? 'no_bundled_hooks'
      : codex.feature_surface.codex_plugin_hooks === true
        ? 'ready'
        : codex.feature_surface.codex_plugin_hooks === false
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

function buildCodexHookReviewTargets({ summary, plugin_entries, plugins }) {
  const targets = [];
  for (const pluginName of summary?.bundled_plugins ?? []) {
    const effective = plugin_entries?.[pluginName]?.effective ?? {};
    const hooksFile = effective.hooks_file ?? {};
    const commandAnalysis = hooksFile.command_analysis ?? {};
    const plugin = plugins?.[pluginName];
    targets.push({
      plugin: pluginName,
      version: plugin?.source?.claude_manifest?.version ?? plugin?.source?.codex_manifest?.version ?? null,
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

async function buildCodexHookStateReport({ homeDir, reviewTargets }) {
  const configPath = join(homeDir, '.codex', 'config.toml');
  const currentText = await readTextIfExists(configPath);
  const parsed = currentText.ok
    ? parseCodexHookStateConfigToml(currentText.text)
    : { entries: [] };
  const entries = parsed.entries.map((entry) => ({
    id: entry.id,
    plugin_id: entry.plugin_id,
    plugin: entry.plugin,
    marketplace: entry.marketplace,
    hooks_path: entry.hooks_path,
    event: entry.event,
    enabled: entry.enabled,
    trusted: Boolean(entry.trusted_hash),
  }));
  const expected = [];
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
      const enabledMatches = matches.filter((entry) => entry.enabled === true);
      const disabledMatches = matches.filter((entry) => entry.enabled === false);
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
  return {
    schema_version: 'runtime-codex-hook-state-1.0',
    config_path: configPath,
    config_status: currentText.ok ? 'available' : 'missing',
    read_error: currentText.ok ? null : currentText.reason,
    summary: {
      total_entries: entries.length,
      agentic_entries: entries.filter((entry) => entry.marketplace === 'agentic-plugins').length,
      expected: expected.length,
      expected_configured: expected.filter((entry) => entry.configured > 0).length,
      expected_enabled: enabledExpected.length,
      expected_disabled: disabledExpected.length,
      expected_untrusted: untrustedExpected.length,
      expected_missing: missingExpected.length,
      unexpected_agentic_entries: unexpectedAgenticEntries.length,
    },
    expected,
    disabled_expected: disabledExpected,
    untrusted_expected: untrustedExpected,
    unexpected_agentic_entries: unexpectedAgenticEntries,
  };
}

export function parseCodexHookStateConfigToml(text) {
  const entries = [];
  let current = null;
  const commit = () => {
    if (current) entries.push(current);
  };
  for (const raw of String(text ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const section = raw.match(/^\s*\[hooks\.state\."([^"]+)"]\s*(?:#.*)?$/);
    if (section) {
      commit();
      current = parseCodexHookStateId(section[1]);
      continue;
    }
    if (/^\s*\[[^\]]+]\s*(?:#.*)?$/.test(raw)) {
      commit();
      current = null;
      continue;
    }
    if (!current) continue;
    const withoutComment = raw.replace(/#.*/, '').trim();
    const enabled = withoutComment.match(/^enabled\s*=\s*(true|false)\s*$/);
    if (enabled) {
      current.enabled = enabled[1] === 'true';
      continue;
    }
    const trustedHash = withoutComment.match(/^trusted_hash\s*=\s*"([^"]+)"\s*$/);
    if (trustedHash) current.trusted_hash = trustedHash[1];
  }
  commit();
  return { entries };
}

function parseCodexHookStateId(id) {
  const parts = String(id ?? '').split(':');
  const pluginId = parts[0] ?? null;
  const pluginMatch = pluginId?.match(/^([^@]+)@(.+)$/);
  return {
    id,
    plugin_id: pluginId,
    plugin: pluginMatch?.[1] ?? null,
    marketplace: pluginMatch?.[2] ?? null,
    hooks_path: normalizeCodexHookStatePath(parts[1] ?? null, pluginMatch?.[1] ?? null),
    event: normalizeCodexHookStateEvent(parts[2] ?? null),
    group_index: parts[3] ?? null,
    hook_index: parts[4] ?? null,
    enabled: null,
    trusted_hash: null,
  };
}

function normalizeCodexHookStatePath(path, plugin) {
  const text = sanitizeValue(path);
  if (!text) return null;
  const normalized = text.replaceAll('\\', '/').replace(/^\.\//, '');
  if (plugin) {
    const marker = `/plugins/${plugin}/`;
    const markerIndex = normalized.indexOf(marker);
    if (markerIndex >= 0) return normalized.slice(markerIndex + marker.length);
    const bareMarker = `plugins/${plugin}/`;
    if (normalized.startsWith(bareMarker)) return normalized.slice(bareMarker.length);
  }
  return normalized;
}

function normalizeCodexHookStateEvent(event) {
  const text = sanitizeValue(event);
  if (!text) return null;
  if (text === 'PreCompact') return 'pre_compact';
  if (text === 'SessionStart') return 'session_start';
  if (text === 'Stop') return 'stop';
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}

function buildCodexHookLocation({ manifestHooks, manifestHooksFile, defaultHooksFile, origin }) {
  const declared = Boolean(manifestHooks?.declared);
  const declaredFile = manifestHooksFile ?? { status: 'missing' };
  const bundled = declared
    ? declaredFile.status === 'available'
    : defaultHooksFile?.status === 'available';
  const status = declared && bundled
    ? 'exposed'
    : declared
      ? 'manifest_declared_missing_file'
      : bundled
        ? 'default_file_only'
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

function buildHostParity({ claude, codex, plugins, claudePluginList, codexPluginHooks }) {
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

  if (codexPluginHooks.summary.bundled_plugins.length > 0 && codex.feature_surface.codex_plugin_hooks !== true) {
    differences.push(parityEntry({
      id: 'codex_plugin_hooks_feature_disabled',
      severity: 'warning',
      host: 'codex',
      area: 'hooks',
      summary: codex.feature_surface.codex_global_hooks === true
        ? 'Codex global hooks are enabled, but bundled plugin hooks require [features].plugin_hooks=true before hook-bearing agentic-plugins can run lifecycle hooks automatically.'
        : 'Codex bundled plugin hooks are packaged, but generic hooks and/or plugin_hooks are not enabled in the observed feature surface.',
      evidence: `bundled=${codexPluginHooks.summary.bundled_plugins.join(',')}, codex global_hooks=${featureFlagEvidence(codex.feature_surface.codex_global_hooks, codex.feature_surface.codex_global_hooks_stage)}, codex plugin_hooks=${featureFlagEvidence(codex.feature_surface.codex_plugin_hooks, codex.feature_surface.codex_plugin_hooks_stage)}, codex automatic_plugin_hooks=false`,
      next_step: 'Use runtime:settings to plan plugin_hooks enablement, then review/trust the bundled hooks in Codex with /hooks.',
    }));
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

  if (codex.feature_surface.plugin_marketplace === true && codex.feature_surface.plugin_install_command !== true) {
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
  const codexInstalledVersion = plugin.cache.codex?.latest?.manifest_version ?? null;
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
    source: 'Codex cache version',
  }));

  return issues;
}

function buildPluginCommandSurface({ claude, codex, plugins, hostParity, codexPluginHooks, settingsRuns }) {
  const claudeSurfaceStatus = buildClaudePluginCliSurfaceStatus(claude);
  const claudeSurfaceAvailable = claudeSurfaceStatus === 'available';
  return {
    schema_version: 'runtime-plugin-command-surface-1.3',
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
      mode: codex.feature_surface.plugin_marketplace ? 'marketplace-only' : 'unknown',
      supports: {
        install_plugin: Boolean(codex.feature_surface.plugin_install_command),
        list_plugin: Boolean(codex.feature_surface.plugin_list_command),
        marketplace_add: Boolean(codex.feature_surface.plugin_marketplace_add),
        marketplace_upgrade: Boolean(codex.feature_surface.plugin_marketplace_upgrade),
        marketplace_remove: Boolean(codex.feature_surface.plugin_marketplace_remove),
      },
      materialization: buildCodexCacheMaterialization(plugins.runtime),
      limits: [
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
  const attestation = getCurrentCodexHookReviewAttestation(settingsRuns, codexPluginHooks, plugins);
  if (attestation.current) return null;
  const reviewTargets = codexPluginHooks?.review_targets ?? [];
  const hookState = codexPluginHooks?.hook_state?.summary ?? {};
  const hookStateHint = hookState.expected_disabled > 0
    ? ` Current Codex config reports ${hookState.expected_disabled}/${hookState.expected} expected bundled hook entries disabled; enable them in /hooks before attesting.`
    : '';
  return {
    id: 'codex-hook-review',
    host: 'codex',
    status: 'manual_check',
    reason: `Codex plugin hooks are packaged and plugin_hooks is enabled, but ${surface} cannot verify active-session hook review/trust state.`,
    environment: 'Open the active Codex session for this repository.',
    commands: ['/hooks'],
    verify: `Review/trust bundled hooks for ${bundled.join(', ')} (${reviewTargets.length} review target(s)); if /hooks shows "New hook - review required", review each new hook first. Do not attest from /hooks Installed counts alone, including Active=0 output.${hookStateHint} Then run runtime:settings --attest-codex-hook-review and rerun runtime:doctor.`,
    review_targets: reviewTargets,
  };
}

function getCurrentCodexHookReviewAttestation(settingsRuns, codexPluginHooks, plugins) {
  const attestation = settingsRuns?.codex_hook_review?.latest ?? null;
  if (!attestation || attestation.attested !== true || attestation.status !== 'attested') {
    return { current: false, reason: 'missing' };
  }
  if ((codexPluginHooks?.hook_state?.summary?.expected_disabled ?? 0) > 0) {
    return { current: false, reason: 'disabled_hook_state', attestation };
  }
  const expectedPlugins = codexPluginHooks?.summary?.bundled_plugins ?? [];
  const attestedPlugins = attestation.bundled_plugins ?? [];
  if (!sameStringSet(expectedPlugins, attestedPlugins)) {
    return { current: false, reason: 'plugin_set_changed', attestation };
  }
  const expectedVersions = {};
  for (const pluginName of expectedPlugins) {
    const plugin = plugins?.[pluginName];
    expectedVersions[pluginName] = plugin?.source?.claude_manifest?.version ?? plugin?.source?.codex_manifest?.version ?? null;
  }
  for (const pluginName of expectedPlugins) {
    const expected = expectedVersions[pluginName] ?? null;
    const actual = attestation.plugin_versions?.[pluginName] ?? null;
    if (expected !== actual) {
      return { current: false, reason: 'plugin_version_changed', attestation };
    }
  }
  return { current: true, reason: null, attestation };
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

async function inspectCompanionContract({ repoRoot, homeDir }) {
  const contractPath = join(repoRoot, 'companions', 'contract.md');
  const contractText = await readTextIfExists(contractPath);
  const contractVersion = contractText.ok ? parseContractDocVersion(contractText.text) : null;
  const localRoot = join(repoRoot, 'plugins', 'companions');
  const sourceRoot = join(repoRoot, 'companions');
  const directions = {
    claude_to_codex: await inspectCompanionDirection({
      label: 'Claude -> Codex',
      peer: 'codex',
      filename: 'codex-companion.mjs',
      candidates: [
        join(sourceRoot, 'codex-companion.mjs'),
        join(localRoot, 'scripts', 'codex-companion.mjs'),
        ...(await latestVersionedScriptCandidates({
          baseDir: join(homeDir, '.claude', 'plugins', 'cache', 'agentic-plugins', 'companions'),
          scriptRel: join('scripts', 'codex-companion.mjs'),
          manifestRel: join('.claude-plugin', 'plugin.json'),
        })),
      ],
      contractVersion,
    }),
    codex_to_claude: await inspectCompanionDirection({
      label: 'Codex -> Claude',
      peer: 'claude',
      filename: 'claude-companion.mjs',
      candidates: [
        join(sourceRoot, 'claude-companion.mjs'),
        join(localRoot, 'scripts', 'claude-companion.mjs'),
        ...(await latestVersionedScriptCandidates({
          baseDir: join(homeDir, '.codex', 'plugins', 'cache', 'agentic-plugins', 'companions'),
          scriptRel: join('scripts', 'claude-companion.mjs'),
          manifestRel: join('.codex-plugin', 'plugin.json'),
        })),
        join(homeDir, '.codex', '.tmp', 'marketplaces', 'agentic-plugins', 'plugins', 'companions', 'scripts', 'claude-companion.mjs'),
      ],
      contractVersion,
    }),
  };
  return {
    contract_path: contractText.ok ? contractPath : null,
    contract_version: contractVersion,
    compatible_major: CONTRACT_COMPATIBLE_MAJOR,
    directions,
  };
}

async function latestVersionedScriptCandidates({ baseDir, scriptRel, manifestRel }) {
  let entries;
  try {
    entries = await readdir(baseDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = await readJsonIfExists(join(baseDir, entry.name, manifestRel));
    if (!manifest.ok) continue;
    candidates.push({
      version: manifest.json.version ?? entry.name,
      path: join(baseDir, entry.name, scriptRel),
    });
  }
  candidates.sort((a, b) => semverCompare(String(b.version), String(a.version)));
  return candidates.map((c) => c.path);
}

async function inspectCompanionDirection({ label, peer, filename, candidates, contractVersion }) {
  const seen = new Set();
  const inspected = [];
  for (const candidate of candidates) {
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    const preflight = await preflightCompanionScript(candidate, contractVersion);
    inspected.push({ path: candidate, ...preflight });
  }
  const selected = inspected.find((c) => c.status === 'available') ?? null;
  return {
    label,
    peer,
    filename,
    status: selected ? 'available' : inspected.some((c) => c.status === 'blocked') ? 'blocked' : 'not_installed',
    selected,
    candidates: inspected,
  };
}

async function preflightCompanionScript(path, contractVersion) {
  const text = await readTextIfExists(path);
  if (!text.ok) return { status: 'missing', reason: text.reason };
  const scriptVersion = parseScriptContractVersion(text.text);
  const hasPromptFile = /['"]prompt-file['"]|--prompt-file/.test(text.text);
  const scriptMajor = scriptVersion ? Number.parseInt(scriptVersion.split('.')[0], 10) : null;
  const contractMajor = contractVersion ? Number.parseInt(contractVersion.split('.')[0], 10) : CONTRACT_COMPATIBLE_MAJOR;
  const compatible = hasPromptFile && scriptMajor === contractMajor && scriptMajor === CONTRACT_COMPATIBLE_MAJOR;
  return {
    status: compatible ? 'available' : 'blocked',
    contract_version: scriptVersion,
    has_prompt_file: hasPromptFile,
    compatible,
    reason: compatible ? null : 'missing --prompt-file support or incompatible CONTRACT_VERSION major',
  };
}

function parseContractDocVersion(text) {
  const match = text.match(/Version\*\*:\s*`?v?([0-9]+\.[0-9]+\.[0-9]+)/i);
  return match?.[1] ?? null;
}

function parseScriptContractVersion(text) {
  const match = text.match(/CONTRACT_VERSION\s*=\s*['"]([0-9]+\.[0-9]+\.[0-9]+)['"]/);
  return match?.[1] ?? null;
}

async function inspectModelEffort({ repoRoot, homeDir, explicitModel, explicitEffort }) {
  const repoConfigPath = join(repoRoot, '.agentic-plugins', 'config.toml');
  const userConfigPath = join(homeDir, '.agentic-plugins', 'config.toml');
  const repoConfig = await readTextIfExists(repoConfigPath);
  const userConfig = await readTextIfExists(userConfigPath);
  const repoDefaults = repoConfig.ok ? parseRuntimeConfigToml(repoConfig.text) : {};
  const userDefaults = userConfig.ok ? parseRuntimeConfigToml(userConfig.text) : {};
  const directions = {
    claude_to_codex: resolveModelEffortForPeer({
      peer: 'codex',
      explicitModel,
      explicitEffort,
      repoDefaults,
      userDefaults,
    }),
    codex_to_claude: resolveModelEffortForPeer({
      peer: 'claude',
      explicitModel,
      explicitEffort,
      repoDefaults,
      userDefaults,
    }),
  };
  return {
    resolution_order: [
      'explicit command flags',
      'workflow/subtask override',
      'repo-local .agentic-plugins/config.toml',
      'user-global ~/.agentic-plugins/config.toml',
      'host-native default',
    ],
    explicit: {
      model: explicitModel,
      effort: explicitEffort,
    },
    workflow_override: {
      status: 'not_observed',
      reason: 'doctor v0.1 reads current files and ledgers but does not infer a workflow/subtask override unless a future runtime field records one',
    },
    repo_config: {
      path: repoConfigPath,
      status: repoConfig.ok ? 'available' : 'missing',
      keys: Object.keys(repoDefaults).sort(),
    },
    user_config: {
      path: userConfigPath,
      status: userConfig.ok ? 'available' : 'missing',
      keys: Object.keys(userDefaults).sort(),
    },
    directions,
  };
}

function parseRuntimeConfigToml(text) {
  const result = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line || line.startsWith('[')) continue;
    const match = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*("?)(.*?)\2\s*$/);
    if (!match) continue;
    const key = match[1].replace(/[.-]/g, '_');
    const value = match[3].trim();
    if (value) result[key] = value;
  }
  return result;
}

function resolveModelEffortForPeer({ peer, explicitModel, explicitEffort, repoDefaults, userDefaults }) {
  return {
    model: resolveOneSetting({
      explicit: explicitModel,
      repoDefaults,
      userDefaults,
      keys: [`${peer}_model`, 'model'],
    }),
    effort: resolveOneSetting({
      explicit: explicitEffort,
      repoDefaults,
      userDefaults,
      keys: [`${peer}_effort`, 'effort'],
    }),
  };
}

function resolveOneSetting({ explicit, repoDefaults, userDefaults, keys }) {
  if (explicit) return { value: explicit, source: 'explicit command flags' };
  for (const key of keys) {
    if (repoDefaults[key]) return { value: repoDefaults[key], source: `repo config ${key}` };
  }
  for (const key of keys) {
    if (userDefaults[key]) return { value: userDefaults[key], source: `user config ${key}` };
  }
  return { value: null, source: 'host-native default' };
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

async function inspectSettingsRuns({ repoRoot }) {
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
      codex_hook_review: { status: 'missing', latest: null },
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
    const summary = summarizeSettingsArtifact({
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
      codex_hook_review: { status: 'missing', latest: null },
    };
  }

  runs.sort((a, b) => b.selected_at_ms - a.selected_at_ms || b.run_id.localeCompare(a.run_id));
  const latest = runs[0];
  const latestCodexHookReview = runs.find((run) => run.codex_hook_review?.attested === true && run.codex_hook_review?.status === 'attested')?.codex_hook_review ?? null;
  const status = malformed > 0
    ? 'blocked'
    : latest.plugin_management.failed > 0
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
    codex_hook_review: {
      status: latestCodexHookReview ? 'attested' : 'missing',
      latest: latestCodexHookReview,
    },
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
    for (const key of ['source', 'claude_cache', 'codex_cache']) {
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
  return {
    source: plugin?.source?.claude_manifest?.version ?? null,
    claude_cache: plugin?.cache?.claude?.latest?.manifest_version ?? null,
    codex_cache: plugin?.cache?.codex?.latest?.manifest_version ?? null,
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
  };
}

function summarizeSettingsArtifact({ repoRoot, runId, artifactPath, artifact }) {
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
  return {
    run_id: sanitizeValue(artifact.run_id) ?? runId,
    status: typeof artifact.status === 'string' ? artifact.status : 'blocked',
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
        failed_retryable: safeCount(pluginManagementSummary.failed_retryable),
        failed_non_retryable: safeCount(pluginManagementSummary.failed_non_retryable),
      },
      failed: safeCount(pluginManagementSummary.failed),
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
      plugin_hooks_enabled: codexHookReview.plugin_hooks_enabled === true,
      plugin_hooks_stage: sanitizeValue(codexHookReview.plugin_hooks_stage),
      artifact_pointer: pointer(repoRoot, artifactPath),
    },
  };
}

async function inspectConsensusRuns({ repoRoot }) {
  const root = join(repoRoot, '.agentic-plugins', 'runs', 'consensus');
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
      error: err.code ?? err.message,
    };
  }

  const runs = [];
  let malformed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !CONSENSUS_RUN_ID_RE.test(entry.name)) continue;
    const artifactPath = join(root, entry.name, 'execution.json');
    const artifact = await readJsonIfExists(artifactPath);
    if (!artifact.ok) {
      continue;
    }
    const summary = summarizeConsensusArtifact({
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
    };
  }

  runs.sort((a, b) => b.selected_at_ms - a.selected_at_ms || b.run_id.localeCompare(a.run_id));
  const latest = runs[0];
  const status = malformed > 0
    ? 'blocked'
    : latest.summary.failed > 0
      ? 'needs_attention'
      : 'available';
  return {
    status,
    root,
    count: runs.length,
    malformed,
    latest,
  };
}

async function inspectCompatRuns({ repoRoot }) {
  const root = join(repoRoot, '.agentic-plugins', 'runs', 'compat');
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
      error: err.code ?? err.message,
    };
  }

  const runs = [];
  let malformed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !COMPAT_RUN_ID_RE.test(entry.name)) continue;
    const snapshotPath = join(root, entry.name, 'snapshot.json');
    const snapshot = await readJsonIfExists(snapshotPath);
    if (!snapshot.ok) {
      malformed++;
      runs.push({
        run_id: entry.name,
        status: 'blocked',
        artifact_pointer: pointer(repoRoot, snapshotPath),
        selected_at: null,
        selected_at_ms: runIdTimestampMs(entry.name) ?? 0,
        drift_class: 'unknown',
        release_notes_required: false,
        host_gaps: [],
        release_notes: emptyCompatReleaseNotes(repoRoot, entry.name),
        reason: snapshot.reason,
        next_steps: ['Repair malformed runtime:compat snapshot artifacts before relying on compatibility drift checks.'],
      });
      continue;
    }
    const summary = await summarizeCompatArtifact({
      repoRoot,
      runId: entry.name,
      snapshotPath,
      snapshot: snapshot.json,
    });
    if (summary.status === 'blocked') malformed++;
    runs.push(summary);
  }

  if (runs.length === 0) {
    return {
      status: 'empty',
      root,
      count: 0,
      malformed,
      latest: null,
    };
  }

  runs.sort((a, b) => b.selected_at_ms - a.selected_at_ms || b.run_id.localeCompare(a.run_id));
  const latest = runs[0];
  const status = malformed > 0
    ? 'blocked'
    : latest.status === 'release_notes_required'
      ? 'release_notes_required'
      : ['snapshot_only', 'gap_analysis_ready', 'plan_ready'].includes(latest.status)
        ? 'needs_attention'
        : 'available';
  return {
    status,
    root,
    count: runs.length,
    malformed,
    latest,
  };
}

async function summarizeCompatArtifact({ repoRoot, runId, snapshotPath, snapshot }) {
  const gapPath = join(dirname(snapshotPath), 'gap-analysis.json');
  const planPath = join(dirname(snapshotPath), 'plan.json');
  const releaseNotesPath = join(dirname(snapshotPath), 'release-notes', 'index.json');
  const [gap, plan, releaseNotes] = await Promise.all([
    readOptionalJson(gapPath),
    readOptionalJson(planPath),
    readOptionalJson(releaseNotesPath),
  ]);
  const selectedAt = artifactTimestampMs(snapshot, runId);
  const malformed = [gap, plan, releaseNotes].filter((item) => item.status === 'malformed');
  const gapOverall = gap.json?.overall ?? {};
  const planStatus = sanitizeValue(plan.json?.status);
  const releaseNotesSummary = summarizeCompatReleaseNotes({
    repoRoot,
    runId,
    releaseNotesPath,
    releaseNotes,
  });
  const status = malformed.length > 0
    ? 'blocked'
    : plan.status === 'available'
      ? planStatus === 'blocked_release_notes_required'
        ? 'release_notes_required'
        : 'plan_ready'
      : gap.status === 'available'
        ? gapOverall.status === 'release_notes_required' || gapOverall.release_notes_required === true
          ? 'release_notes_required'
          : gapOverall.status === 'current'
            ? 'current'
            : 'gap_analysis_ready'
        : 'snapshot_only';
  return {
    run_id: sanitizeValue(snapshot.run_id) ?? runId,
    status,
    artifact_pointer: pointer(repoRoot, snapshotPath),
    gap_pointer: gap.status === 'available' || gap.status === 'malformed' ? pointer(repoRoot, gapPath) : null,
    plan_pointer: plan.status === 'available' || plan.status === 'malformed' ? pointer(repoRoot, planPath) : null,
    selected_at: selectedAt === null ? null : new Date(selectedAt).toISOString(),
    selected_at_ms: selectedAt ?? 0,
    drift_class: sanitizeValue(gapOverall.drift_class) ?? 'unchecked',
    release_notes_required: gapOverall.release_notes_required === true || status === 'release_notes_required',
    host_gaps: Array.isArray(gap.json?.host_gaps)
      ? gap.json.host_gaps.map((item) => ({
          host: sanitizeValue(item.host),
          status: sanitizeValue(item.status),
          observed_version: sanitizeValue(item.observed_version),
          baseline_version: sanitizeValue(item.baseline_version),
        }))
      : [],
    release_notes: releaseNotesSummary,
    malformed_artifacts: malformed.map((item) => pointer(repoRoot, item.path)),
    next_steps: compatNextSteps({ runId, status, gap, plan }),
  };
}

function summarizeCompatReleaseNotes({ repoRoot, runId, releaseNotesPath, releaseNotes }) {
  if (releaseNotes.status === 'missing') return emptyCompatReleaseNotes(repoRoot, runId);
  if (releaseNotes.status === 'malformed') {
    return {
      pointer: pointer(repoRoot, releaseNotesPath),
      status: 'malformed',
      count: 0,
      content_backed: 0,
      url_pointers: 0,
      stored: 0,
      not_fetched: 0,
    };
  }
  const notes = Array.isArray(releaseNotes.json?.notes) ? releaseNotes.json.notes : [];
  return {
    pointer: pointer(repoRoot, releaseNotesPath),
    status: 'available',
    count: notes.length,
    content_backed: notes.filter((note) => isContentBackedCompatReleaseNote(note)).length,
    url_pointers: notes.filter((note) => note.kind === 'url').length,
    stored: notes.filter((note) => note.status === 'stored').length,
    not_fetched: notes.filter((note) => note.status === 'not_fetched').length,
  };
}

function isContentBackedCompatReleaseNote(note) {
  if (!note || note.status !== 'stored') return false;
  if (note.kind === 'file') return Boolean(note.pointer);
  if (note.kind === 'url') return Boolean(note.content_pointer);
  return false;
}

function emptyCompatReleaseNotes(repoRoot, runId) {
  return {
    pointer: pointer(repoRoot, join(repoRoot, '.agentic-plugins', 'runs', 'compat', runId, 'release-notes', 'index.json')),
    status: 'missing',
    count: 0,
    content_backed: 0,
    url_pointers: 0,
    stored: 0,
    not_fetched: 0,
  };
}

function compatNextSteps({ runId, status, gap, plan }) {
  if (status === 'blocked') return ['Repair malformed runtime:compat artifacts, then rerun runtime:compat check.'];
  if (status === 'snapshot_only') return [`runtime:compat check --run-id ${runId}`];
  if (status === 'release_notes_required') {
    const steps = Array.isArray(gap.json?.next_steps) ? gap.json.next_steps : [];
    return steps.length > 0 ? steps.map((step) => sanitizeValue(step)).filter(Boolean) : [`runtime:compat ingest-release-notes --run-id ${runId} --release-notes-file <path>`];
  }
  if (status === 'gap_analysis_ready') return [`runtime:compat plan --run-id ${runId}`];
  if (status === 'plan_ready') {
    const steps = Array.isArray(plan.json?.recommended_sequence)
      ? plan.json.recommended_sequence.map((item) => sanitizeValue(item.step)).filter(Boolean)
      : [];
    return steps.length > 0 ? steps : ['Review the runtime:compat update plan before changing compatibility-sensitive surfaces.'];
  }
  return [];
}

function summarizeConsensusArtifact({ repoRoot, runId, artifactPath, artifact }) {
  const summary = artifact.summary ?? {};
  const failures = Array.isArray(artifact.failures)
    ? artifact.failures.map((failure) => ({
        peer: sanitizeValue(failure.peer),
        status: sanitizeValue(failure.status),
        failure_type: sanitizeValue(failure.failure_type),
        operator_action_required: failure.operator_action_required === true,
        retryable: failure.retryable === true,
        retry_after: sanitizeValue(failure.retry_after),
        retry_command: sanitizeValue(failure.retry_command),
        raw_output: {
          pointer: sanitizeValue(failure.raw_output?.pointer),
          bytes: safeCount(failure.raw_output?.bytes),
          sha256: sanitizeValue(failure.raw_output?.sha256),
        },
      }))
    : [];
  const selectedAt = artifactTimestampMs(artifact, runId);
  return {
    run_id: sanitizeValue(artifact.run_id) ?? runId,
    status: typeof artifact.status === 'string' ? artifact.status : 'blocked',
    artifact_pointer: pointer(repoRoot, artifactPath),
    progress_pointer: sanitizeValue(artifact.progress_pointer),
    selected_at: selectedAt === null ? null : new Date(selectedAt).toISOString(),
    selected_at_ms: selectedAt ?? 0,
    round: safeCount(artifact.round),
    peer_execution: artifact.peer_execution === true,
    summary: {
      executed: safeCount(summary.executed),
      passed: safeCount(summary.passed),
      failed: safeCount(summary.failed),
      skipped: safeCount(summary.skipped),
      failed_retryable: safeCount(summary.failed_retryable),
      failed_non_retryable: safeCount(summary.failed_non_retryable),
    },
    failure_summary: summarizeConsensusFailures(failures),
    failures,
  };
}

function summarizeConsensusFailures(failures) {
  const result = {
    timeout: 0,
    retryable: 0,
    non_retryable: 0,
    operator_action_required: 0,
    by_type: {},
  };
  for (const failure of failures) {
    const type = failure.failure_type || 'unknown';
    result.by_type[type] = (result.by_type[type] ?? 0) + 1;
    if (type === 'timeout') result.timeout += 1;
    if (failure.operator_action_required) result.operator_action_required += 1;
    if (failure.retryable) result.retryable += 1;
    else result.non_retryable += 1;
  }
  return result;
}

async function inspectRuntimeArtifactInventory({ repoRoot, now, retentionCap, maxBytes }) {
  const root = join(repoRoot, '.agentic-plugins', 'runs');
  const policy = {
    run_count_cap: retentionCap,
    byte_cap: maxBytes,
  };
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    const missing = String(err.code ?? '') === 'ENOENT';
    return {
      requested: true,
      executed: true,
      status: missing ? 'missing' : 'blocked',
      root,
      policy,
      total: emptyArtifactTotals(),
      families: Object.fromEntries(RUNTIME_ARTIFACT_FAMILIES.map((family) => [family, missingArtifactFamily(root, family)])),
      attention: [],
      error: err.code ?? err.message,
      limits: artifactInventoryLimits(),
    };
  }

  const familyNames = new Set(RUNTIME_ARTIFACT_FAMILIES);
  for (const entry of entries) {
    if (entry.isDirectory()) familyNames.add(entry.name);
  }

  const families = {};
  const attention = [];
  for (const family of [...familyNames].sort()) {
    const summary = await inspectArtifactFamily({
      repoRoot,
      root: join(root, family),
      family,
      nowMs: now.getTime(),
      retentionCap,
      maxBytes,
    });
    families[family] = summary;
    for (const reason of summary.attention) attention.push(reason);
  }

  const total = Object.values(families).reduce((acc, family) => ({
    run_count: acc.run_count + family.run_count,
    file_count: acc.file_count + family.file_count,
    directory_count: acc.directory_count + family.directory_count,
    symlink_count: acc.symlink_count + family.symlink_count,
    unreadable: acc.unreadable + family.unreadable,
    bytes: acc.bytes + family.bytes,
  }), emptyArtifactTotals());
  const statuses = Object.values(families).map((family) => family.status);
  const status = statuses.includes('blocked')
    ? 'blocked'
    : attention.length > 0
      ? 'needs_attention'
      : statuses.includes('available')
        ? 'available'
        : statuses.includes('empty')
          ? 'empty'
          : 'missing';

  return {
    requested: true,
    executed: true,
    status,
    root,
    policy,
    total,
    families,
    attention,
    limits: artifactInventoryLimits(),
  };
}

async function inspectArtifactFamily({ repoRoot, root, family, nowMs, retentionCap, maxBytes }) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (err) {
    const missing = String(err.code ?? '') === 'ENOENT';
    return {
      ...missingArtifactFamily(dirname(root), family),
      status: missing ? 'missing' : 'blocked',
      error: err.code ?? err.message,
    };
  }

  const runCount = entries.filter((entry) => entry.isDirectory()).length;
  const totals = await summarizeArtifactPath(root);
  const attention = [];
  if (runCount > retentionCap) {
    attention.push({
      family,
      kind: 'run_count_exceeds_cap',
      observed: runCount,
      limit: retentionCap,
      recommendation: `Review ${pointer(repoRoot, root)} and remove obsolete generated artifacts manually; runtime:doctor does not delete artifacts.`,
    });
  }
  if (totals.bytes > maxBytes) {
    attention.push({
      family,
      kind: 'bytes_exceed_cap',
      observed: totals.bytes,
      limit: maxBytes,
      recommendation: `Review ${pointer(repoRoot, root)} and remove obsolete generated artifacts manually; runtime:doctor does not delete artifacts.`,
    });
  }
  const status = totals.unreadable > 0
    ? 'blocked'
    : attention.length > 0
      ? 'needs_attention'
      : runCount > 0 || totals.file_count > 0
        ? 'available'
        : 'empty';

  return {
    family,
    status,
    root,
    pointer: pointer(repoRoot, root),
    run_count: runCount,
    file_count: totals.file_count,
    directory_count: totals.directory_count,
    symlink_count: totals.symlink_count,
    unreadable: totals.unreadable,
    bytes: totals.bytes,
    oldest_mtime: totals.oldest_mtime_ms === null ? null : new Date(totals.oldest_mtime_ms).toISOString(),
    newest_mtime: totals.newest_mtime_ms === null ? null : new Date(totals.newest_mtime_ms).toISOString(),
    oldest_age_minutes: totals.oldest_mtime_ms === null ? null : Math.max(0, Math.floor((nowMs - totals.oldest_mtime_ms) / 60000)),
    attention,
  };
}

async function summarizeArtifactPath(path) {
  const totals = {
    file_count: 0,
    directory_count: 0,
    symlink_count: 0,
    unreadable: 0,
    bytes: 0,
    oldest_mtime_ms: null,
    newest_mtime_ms: null,
  };
  await walkArtifactPath(path, totals);
  return totals;
}

async function walkArtifactPath(path, totals) {
  let info;
  try {
    info = await lstat(path);
  } catch {
    totals.unreadable += 1;
    return;
  }

  if (info.isSymbolicLink()) {
    totals.symlink_count += 1;
    totals.bytes += safeCount(info.size);
    updateArtifactMtime(totals, info.mtimeMs);
    return;
  }
  if (info.isDirectory()) {
    totals.directory_count += 1;
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      totals.unreadable += 1;
      return;
    }
    for (const entry of entries) {
      await walkArtifactPath(join(path, entry.name), totals);
    }
    return;
  }
  if (info.isFile()) {
    totals.file_count += 1;
    totals.bytes += safeCount(info.size);
    updateArtifactMtime(totals, info.mtimeMs);
  }
}

function updateArtifactMtime(totals, mtimeMs) {
  if (!Number.isFinite(mtimeMs)) return;
  totals.oldest_mtime_ms = totals.oldest_mtime_ms === null ? mtimeMs : Math.min(totals.oldest_mtime_ms, mtimeMs);
  totals.newest_mtime_ms = totals.newest_mtime_ms === null ? mtimeMs : Math.max(totals.newest_mtime_ms, mtimeMs);
}

function missingArtifactFamily(root, family) {
  return {
    family,
    status: 'missing',
    root: join(root, family),
    pointer: `.agentic-plugins/runs/${family}`,
    run_count: 0,
    file_count: 0,
    directory_count: 0,
    symlink_count: 0,
    unreadable: 0,
    bytes: 0,
    oldest_mtime: null,
    newest_mtime: null,
    oldest_age_minutes: null,
    attention: [],
  };
}

function emptyArtifactTotals() {
  return {
    run_count: 0,
    file_count: 0,
    directory_count: 0,
    symlink_count: 0,
    unreadable: 0,
    bytes: 0,
  };
}

function artifactInventoryLimits() {
  return [
    'Inventory uses filesystem metadata only and does not read raw artifact bodies.',
    'Inventory is advisory and read-only; no retention, cleanup, deletion, or compaction happens in runtime:doctor.',
    'Generated artifacts remain under .agentic-plugins/runs/ and stay gitignored by artifact policy.',
  ];
}

async function inspectWorkflowNamespace({ repoRoot, plugin, legacyNamespace, expectedPlugin, now, staleGraceMs }) {
  const canonicalRoot = join(repoRoot, '.agentic-plugins', 'state', plugin);
  const legacyRoot = join(repoRoot, '.claude', legacyNamespace);
  const canonical = await scanOneWorkflowHome({
    root: canonicalRoot,
    home: 'canonical',
    expectedPlugin,
    now,
    staleGraceMs,
  });
  const legacy = await scanOneWorkflowHome({
    root: legacyRoot,
    home: 'legacy',
    expectedPlugin,
    now,
    staleGraceMs,
  });
  const storage = summarizeWorkflowStorage({ canonical, legacy, plugin });
  const selected = storage.selected_home === 'canonical' ? canonical : legacy;
  return {
    root: selected.root,
    workflows: selected.workflows,
    peer_runs: selected.peer_runs,
    storage,
    homes: {
      canonical,
      legacy,
    },
  };
}

async function scanOneWorkflowHome({ root, home, expectedPlugin, now, staleGraceMs }) {
  const workflowsDir = join(root, 'workflows');
  const peerRunsDir = join(root, 'peer-runs');
  const workflows = await scanWorkflowFiles(workflowsDir);
  const peerRuns = await scanPeerRuns(peerRunsDir, expectedPlugin, now, staleGraceMs);
  return {
    home,
    root,
    workflows,
    peer_runs: peerRuns,
    has_state: workflows.count > 0 || peerRuns.count > 0,
  };
}

function summarizeWorkflowStorage({ canonical, legacy, plugin }) {
  const canonicalHas = canonical.has_state;
  const legacyHas = legacy.has_state;
  const canonicalBranches = branchSet(canonical.workflows.files);
  const legacyBranches = branchSet(legacy.workflows.files);
  const overlappingBranches = [...canonicalBranches].filter((branch) => legacyBranches.has(branch)).sort();

  let status = 'empty';
  let selectedHome = 'canonical';
  let recommendation = 'No workflow state found; new state should use the canonical .agentic-plugins/state home.';
  if (canonicalHas && !legacyHas) {
    status = 'canonical';
    selectedHome = 'canonical';
    recommendation = 'Workflow state is already under the canonical .agentic-plugins/state home.';
  } else if (!canonicalHas && legacyHas) {
    status = 'legacy';
    selectedHome = 'legacy';
    recommendation = 'Legacy .claude workflow state is present; migrate explicitly before switching writes to .agentic-plugins/state.';
  } else if (canonicalHas && legacyHas) {
    status = overlappingBranches.length > 0 ? 'ambiguous' : 'migration_blocked';
    selectedHome = 'canonical';
    recommendation = overlappingBranches.length > 0
      ? 'Both canonical and legacy homes contain workflow state for the same branch; reconcile before migration.'
      : 'Both canonical and legacy homes contain state; inspect and migrate explicitly before ordinary workflow writes.';
  }

  if (
    (canonical.peer_runs.status === 'blocked' || legacy.peer_runs.status === 'blocked') &&
    status !== 'ambiguous'
  ) {
    status = 'migration_blocked';
    recommendation = 'Peer-run ledger health blocks safe migration; resolve non-terminal stale or malformed handles first.';
  }

  return {
    status,
    plugin,
    selected_home: selectedHome,
    canonical_root: canonical.root,
    legacy_root: legacy.root,
    canonical_has_state: canonicalHas,
    legacy_has_state: legacyHas,
    overlapping_branches: overlappingBranches,
    recommendation,
  };
}

function branchSet(files) {
  const result = new Set();
  for (const file of files ?? []) {
    if (typeof file.branch === 'string' && file.branch.length > 0) result.add(file.branch);
  }
  return result;
}

async function scanWorkflowFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    return { status: 'missing', dir, count: 0, malformed: 0, files: [], error: err.code ?? err.message };
  }
  const files = [];
  let malformed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const path = join(dir, entry.name);
    const text = await readTextIfExists(path);
    const summary = { file: entry.name, status: 'unknown', workflow_id: null, current_phase: null, branch: null };
    if (!text.ok) {
      summary.status = 'blocked';
      summary.reason = text.reason;
      malformed++;
      files.push(summary);
      continue;
    }
    const fm = parseFrontmatterBlock(text.text);
    if (!fm) {
      summary.status = 'blocked';
      summary.reason = 'missing frontmatter block';
      malformed++;
      files.push(summary);
      continue;
    }
    summary.status = 'available';
    summary.workflow_id = extractYamlScalar(fm, 'workflow_id');
    summary.current_phase = extractYamlScalar(fm, 'current_phase');
    summary.branch = extractNestedBranch(fm);
    files.push(summary);
  }
  return {
    status: malformed > 0 ? 'blocked' : 'available',
    dir,
    count: files.length,
    malformed,
    files,
  };
}

async function scanPeerRuns(dir, expectedPlugin, now, staleGraceMs) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    return {
      status: 'missing',
      dir,
      count: 0,
      non_terminal: 0,
      stale_non_terminal: 0,
      malformed: 0,
      error: err.code ?? err.message,
      runs: [],
    };
  }
  const runs = [];
  let malformed = 0;
  let nonTerminal = 0;
  let staleNonTerminal = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const handlePath = join(dir, entry.name, 'handle.json');
    const handle = await readJsonIfExists(handlePath);
    if (!handle.ok) {
      malformed++;
      runs.push({ run_id: entry.name, status: 'blocked', reason: handle.reason });
      continue;
    }
    const status = typeof handle.json.status === 'string' ? handle.json.status : 'unknown';
    const terminal = TERMINAL_PEER_RUN_STATUSES.has(status);
    const updatedAt = parseDateMs(handle.json.updated_at);
    const stale = !terminal && updatedAt !== null && now.getTime() - updatedAt > staleGraceMs;
    const issues = validatePeerRunHandle(handle.json, {
      expectedPlugin,
      status,
      updatedAt,
      terminal,
    });
    if (!terminal) nonTerminal++;
    if (stale) staleNonTerminal++;
    if (issues.length > 0) malformed++;
    runs.push({
      run_id: handle.json.run_id ?? entry.name,
      status,
      terminal,
      stale,
      plugin: sanitizeValue(handle.json.plugin),
      plugin_matches_namespace: handle.json.plugin === expectedPlugin,
      kind: sanitizeValue(handle.json.kind),
      peer_host: sanitizeValue(handle.json.peer_host),
      model: sanitizeValue(handle.json.model),
      effort: sanitizeValue(handle.json.effort),
      updated_at: sanitizeValue(handle.json.updated_at),
      issues,
    });
  }
  return {
    status: malformed > 0 || staleNonTerminal > 0 ? 'blocked' : 'available',
    dir,
    count: runs.length,
    non_terminal: nonTerminal,
    stale_non_terminal: staleNonTerminal,
    malformed,
    runs,
  };
}

function validatePeerRunHandle(handle, { expectedPlugin, status, updatedAt, terminal }) {
  const issues = [];
  if (typeof handle.run_id !== 'string' || handle.run_id.length === 0) {
    issues.push('missing run_id');
  }
  if (handle.plugin !== expectedPlugin) {
    issues.push(`plugin mismatch: expected ${expectedPlugin}`);
  }
  if (!VALID_PEER_RUN_STATUSES.has(status)) {
    issues.push(`invalid status: ${status}`);
  }
  if (!terminal && updatedAt === null) {
    issues.push('non-terminal run missing valid updated_at');
  }
  if (handle.kind !== undefined && typeof handle.kind !== 'string') {
    issues.push('kind must be a string when present');
  }
  if (handle.peer_host !== undefined && typeof handle.peer_host !== 'string') {
    issues.push('peer_host must be a string when present');
  }
  return issues;
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
  if (codexPluginHooks.status === 'ready' && !hookFollowup) {
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
    evidence: `codex-plugin-hooks=${codexPluginHooks.status}; bundled=${codexPluginHooks.summary.bundled_plugins.join(',') || 'none'}; manual-hook-review=${Boolean(hookFollowup)}`,
    next_step: hookFollowup
      ? hookFollowup.verify
      : 'Use runtime:settings to enable plugin_hooks or restore hook packaging, then rerun runtime:doctor.',
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
    installed: summarizeRuntimeInstallForHost(host, plugin),
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

function summarizeRuntimeInstallForHost(host, plugin) {
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

  if (plugin.cache.codex.status === 'available') {
    return {
      status: 'installed',
      evidence: 'codex plugin cache contains runtime',
      version: plugin.cache.codex.latest?.manifest_version ?? sourceVersion,
      materialization: buildCodexCacheMaterialization(plugin),
    };
  }
  if (plugin.source?.present) {
    return {
      status: 'source_available',
      evidence: 'repo source tree contains runtime; host install not proven',
      version: sourceVersion,
      materialization: buildCodexCacheMaterialization(plugin),
    };
  }
  if (plugin.cache.codex_tmp_marketplace.status === 'available') {
    return {
      status: 'marketplace_cache_only',
      evidence: 'codex temporary marketplace cache is not installation evidence',
      version: plugin.cache.codex_tmp_marketplace.manifest_version ?? null,
      materialization: buildCodexCacheMaterialization(plugin),
    };
  }
  return {
    status: 'not_installed',
    evidence: 'no codex install cache or source evidence',
    version: null,
    materialization: buildCodexCacheMaterialization(plugin),
  };
}

function buildCodexCacheMaterialization(plugin) {
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
      reason: 'Codex marketplace cache is present, but no per-plugin install cache exists and current Codex CLI exposes marketplace add/upgrade/remove rather than per-plugin install/list.',
      next_step: 'Start a fresh Codex session or invoke the plugin surface after marketplace refresh, then re-run runtime:doctor to verify cache materialization.',
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
  env,
  runner,
  timeoutMs,
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

async function executeWorkflowContinuationProofDirection({
  key,
  spec,
  repoRoot,
  directionSettings,
  runner,
  env,
  timeoutMs,
}) {
  const statePath = resolve(repoRoot, 'plugins/engineer/scripts/state.mjs');
  const dispatchPath = resolve(repoRoot, 'plugins/engineer/scripts/dispatch-peer.mjs');
  const missingScript = await firstMissingReadablePath([
    { label: 'engineer state script', path: statePath },
    { label: 'engineer dispatch script', path: dispatchPath },
  ]);
  if (missingScript) {
    return {
      status: 'blocked',
      reason: `${missingScript.label} is not readable`,
      missing_path: relative(repoRoot, missingScript.path),
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
    warnings.push(caller.feature_surface.codex_plugin_hooks === true
      ? 'Codex plugin hooks are enabled; bundled lifecycle hooks still require hook review/trust in the active host session'
      : caller.feature_surface.codex_global_hooks === true
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
    if (report.settings_runs.latest?.plugin_management?.failed > 0) {
      warnings.push('latest settings plugin-management execution has failures');
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
  if (report.artifact_inventory?.executed && report.artifact_inventory.status === 'blocked') {
    warnings.push('runtime artifact inventory blocked');
  } else if (report.artifact_inventory?.executed && report.artifact_inventory.status === 'needs_attention') {
    warnings.push('runtime artifact inventory exceeds retention guidance');
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
  if (codexHooks.hook_state) {
    const state = codexHooks.hook_state;
    lines.push(`- hook-state: config=${state.config_status}; expected=${state.summary.expected}; enabled=${state.summary.expected_enabled}; disabled=${state.summary.expected_disabled}; missing=${state.summary.expected_missing}; untrusted=${state.summary.expected_untrusted}; unexpected-agentic=${state.summary.unexpected_agentic_entries}`);
    for (const entry of state.disabled_expected ?? []) {
      lines.push(`  disabled-hook-state: ${entry.plugin}; event=${entry.event}; path=${entry.hooks_path}; ids=${entry.ids.join(',') || 'none'}`);
    }
  }
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
  lines.push(`- codex: mode=${codexSurface.mode}; marketplace-add=${Boolean(codexSurface.supports.marketplace_add)}; marketplace-upgrade=${Boolean(codexSurface.supports.marketplace_upgrade)}; install=${Boolean(codexSurface.supports.install_plugin)}; list=${Boolean(codexSurface.supports.list_plugin)}; materialization=${codexSurface.materialization.status}`);
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
    lines.push(`- latest: ${latest.run_id}; status=${latest.status}; artifact=${latest.artifact_pointer}`);
    lines.push(`  plugin-management: mode=${latest.plugin_management.mode ?? '<unknown>'}; executed=${latest.plugin_management.summary.executed}; failed=${latest.plugin_management.summary.failed}; retryable-failed=${latest.plugin_management.summary.failed_retryable}; non-retryable-failed=${latest.plugin_management.summary.failed_non_retryable}`);
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
    const review = report.settings_runs.codex_hook_review.latest;
    lines.push(`  latest-codex-hook-review: status=${review.status}; attested-at=${review.attested_at ?? '<unknown>'}; plugins=${Object.entries(review.plugin_versions ?? {}).map(([name, version]) => `${name}@${version ?? 'unknown'}`).join(',') || 'none'}`);
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
  if (report.artifact_inventory?.requested) {
    lines.push('Runtime Artifact Inventory');
    lines.push(`- status: ${report.artifact_inventory.status}; total-runs=${report.artifact_inventory.total.run_count}; total-files=${report.artifact_inventory.total.file_count}; total-bytes=${report.artifact_inventory.total.bytes}; unreadable=${report.artifact_inventory.total.unreadable}`);
    lines.push(`- policy: run-count-cap=${report.artifact_inventory.policy.run_count_cap}; byte-cap=${report.artifact_inventory.policy.byte_cap}`);
    for (const family of Object.values(report.artifact_inventory.families ?? {})) {
      lines.push(`- ${family.family}: status=${family.status}; runs=${family.run_count}; files=${family.file_count}; bytes=${family.bytes}; oldest-age-minutes=${family.oldest_age_minutes ?? '<unknown>'}`);
    }
    for (const attention of report.artifact_inventory.attention ?? []) {
      lines.push(`  retention-attention: ${attention.family}/${attention.kind}; observed=${attention.observed}; limit=${attention.limit}`);
      lines.push(`    next: ${attention.recommendation}`);
    }
    for (const limit of report.artifact_inventory.limits ?? []) lines.push(`- limit: ${limit}`);
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
    plugin_surface: cli.plugin_surface,
  };
}

function featureFlagEvidence(enabled, stage) {
  if (enabled === true) return stage ? `true/${stage}` : 'true';
  if (enabled === false) return stage ? `false/${stage}` : 'false';
  return 'unknown';
}

async function readJsonIfExists(path) {
  try {
    const text = await readFile(path, 'utf8');
    return { ok: true, path, json: JSON.parse(text) };
  } catch (err) {
    return { ok: false, path, reason: err.code ?? err.message };
  }
}

async function readOptionalJson(path) {
  try {
    const text = await readFile(path, 'utf8');
    return { status: 'available', path, json: JSON.parse(text) };
  } catch (err) {
    if (err.code === 'ENOENT') return { status: 'missing', path, reason: err.code };
    return { status: 'malformed', path, reason: err.code ?? err.message };
  }
}

async function readTextIfExists(path) {
  try {
    const text = await readFile(path, 'utf8');
    return { ok: true, path, text };
  } catch (err) {
    return { ok: false, path, reason: err.code ?? err.message };
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

function summarizeManifestHookField(value) {
  if (value === undefined || value === null) {
    return {
      declared: false,
      type: null,
      paths: [],
    };
  }
  if (typeof value === 'string') {
    return {
      declared: true,
      type: 'path',
      paths: [value],
    };
  }
  if (Array.isArray(value)) {
    const paths = value.filter((item) => typeof item === 'string');
    return {
      declared: true,
      type: paths.length === value.length ? 'path-array' : 'mixed-array',
      paths,
    };
  }
  if (typeof value === 'object') {
    return {
      declared: true,
      type: 'inline',
      paths: [],
    };
  }
  return {
    declared: true,
    type: typeof value,
    paths: [],
  };
}

async function manifestHooksFileSummary({ pluginRoot, manifestHooks }) {
  if (!manifestHooks?.declared) {
    return {
      status: 'not_declared',
      path: null,
      events: [],
      handler_count: 0,
    };
  }
  if (!Array.isArray(manifestHooks.paths) || manifestHooks.paths.length === 0) {
    return {
      status: 'missing',
      path: null,
      error: `manifest hooks field is ${manifestHooks.type ?? 'declared'}; no file path is available`,
      events: [],
      handler_count: 0,
    };
  }
  const summaries = [];
  for (const path of manifestHooks.paths) {
    const resolved = resolve(pluginRoot, path);
    const rel = relative(pluginRoot, resolved);
    if (rel.startsWith('..') || rel === '..' || rel.startsWith(`..${sep}`)) {
      summaries.push({
        status: 'missing',
        path: resolved,
        error: 'manifest hooks path escapes plugin root',
        events: [],
        handler_count: 0,
      });
      continue;
    }
    summaries.push(await hooksFileSummary(resolved));
  }
  if (summaries.length === 1) return summaries[0];

  const available = summaries.filter((entry) => entry.status === 'available');
  if (available.length === 0) {
    return {
      ...summaries[0],
      paths: summaries.map((entry) => entry.path).filter(Boolean),
      summaries,
    };
  }
  const commands = available.flatMap((entry) => entry.command_analysis?.commands ?? []);
  return {
    status: 'available',
    path: available[0].path,
    paths: available.map((entry) => entry.path).filter(Boolean),
    events: uniqueStrings(available.flatMap((entry) => entry.events ?? [])).sort(),
    handler_count: available.reduce((sum, entry) => sum + (entry.handler_count ?? 0), 0),
    command_analysis: analyzeHookCommands(commands),
    summaries,
  };
}

async function hooksFileSummary(path) {
  const readResult = await readJsonIfExists(path);
  if (!readResult.ok) {
    return {
      status: 'missing',
      path,
      error: readResult.reason,
      events: [],
      handler_count: 0,
    };
  }
  const hooks = readResult.json?.hooks && typeof readResult.json.hooks === 'object'
    ? readResult.json.hooks
    : {};
  const events = Object.keys(hooks).sort();
  let handlerCount = 0;
  const commands = [];
  for (const groups of Object.values(hooks)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!Array.isArray(group?.hooks)) continue;
      handlerCount += group.hooks.length;
      for (const hook of group.hooks) {
        if (hook?.type === 'command' && typeof hook.command === 'string') commands.push(hook.command);
      }
    }
  }
  return {
    status: 'available',
    path,
    events,
    handler_count: handlerCount,
    command_analysis: analyzeHookCommands(commands),
  };
}

function analyzeHookCommands(commands) {
  const uniqueCommands = uniqueStrings(commands);
  const claudePluginRootReferences = uniqueCommands.filter((command) => command.includes('${CLAUDE_PLUGIN_ROOT}') || command.includes('$CLAUDE_PLUGIN_ROOT')).length;
  const claudeAdapterReferences = uniqueCommands.filter((command) => /\/adapters\/claude\/hooks\//.test(command)).length;
  const bareNodeCommandReferences = uniqueCommands.filter((command) => /^node(?:\s|$)/.test(command.trim())).length;
  const warnings = [];
  if (claudeAdapterReferences > 0) warnings.push('claude-adapter-hook-command');
  if (bareNodeCommandReferences > 0) warnings.push('bare-node-hook-command');
  return {
    commands: uniqueCommands,
    command_count: uniqueCommands.length,
    claude_plugin_root_references: claudePluginRootReferences,
    claude_adapter_references: claudeAdapterReferences,
    bare_node_command_references: bareNodeCommandReferences,
    warnings,
  };
}

function parseFrontmatterBlock(text) {
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---\n', 4);
  if (end < 0) return null;
  return text.slice(4, end);
}

function extractYamlScalar(frontmatter, key) {
  const re = new RegExp(`^${escapeRegExp(key)}:\\s*['"]?([^'"\\n]+)['"]?\\s*$`, 'm');
  return sanitizeValue(frontmatter.match(re)?.[1]?.trim() ?? null);
}

function extractNestedBranch(frontmatter) {
  const match = frontmatter.match(/git_baseline:\s*\n(?:\s{2,}.+\n)*?\s{2,}branch:\s*['"]?([^'"\n]+)['"]?/m);
  return sanitizeValue(match?.[1]?.trim() ?? null);
}

function parseDateMs(value) {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function artifactTimestampMs(artifact, fallbackRunId) {
  for (const value of [artifact.updated_at, artifact.created_at, artifact.generated_at]) {
    const parsed = parseDateMs(value);
    if (parsed !== null) return parsed;
  }
  return runIdTimestampMs(fallbackRunId);
}

function runIdTimestampMs(runId) {
  const match = String(runId ?? '').match(/^(?:settings|consensus|compat|doctor)-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-[0-9a-f]{6}$/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second] = match;
  const parsed = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}Z`);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeCount(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function pointer(repoRoot, path) {
  const rel = relative(repoRoot, path).split(sep).join('/');
  return rel || basename(path);
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
  await writeJson(artifactPath, artifact);
  await writeJson(latestPath, {
    schema_version: DOCTOR_LATEST_SCHEMA_VERSION,
    runtime_version: RUNTIME_VERSION,
    run_id: id,
    artifact_pointer: pointer(repoRoot, artifactPath),
    updated_at: now.toISOString(),
  });
  return {
    written: true,
    requested: true,
    status: 'recorded',
    run_id: id,
    run_pointer: pointer(repoRoot, runDir),
    artifact_pointer: pointer(repoRoot, artifactPath),
    latest_pointer: pointer(repoRoot, latestPath),
  };
}

function makeDoctorRunId(now) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `doctor-${stamp}-${randomBytes(3).toString('hex')}`;
}

function validateDoctorRunId(value) {
  if (!DOCTOR_RUN_ID_RE.test(String(value ?? ''))) throw new Error(`Invalid doctor run id: ${value}`);
  return value;
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
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

function sanitizeValue(value) {
  if (value === null || value === undefined) return null;
  return redactSecrets(singleLine(String(value)));
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

function singleLine(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function redactSecrets(value) {
  return String(value ?? '')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '<redacted-email>')
    .replace(/\b(?:ghp|github_pat|xox[baprs])_[A-Za-z0-9_=-]{12,}\b/g, '<redacted-token>')
    .replace(/\b(?:sk|sk-proj|sk-ant)-[A-Za-z0-9_-]{12,}\b/g, '<redacted-token>')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '<redacted-aws-key>')
    .replace(/\b[0-9a-f]{32,}\b/gi, '<redacted-hex>');
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

function semverCompare(a, b) {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function usage() {
  return `Usage: doctor.mjs [--repo-root <path>] [--format text|json] [--host auto|claude|codex] [--model <id>] [--effort <level>] [--sandbox-permission-probe] [--permission-proof] [--execute-permission-proof] [--permission-proof-timeout-ms <n>] [--deep-peer-smoke] [--execute-deep-peer-smoke] [--deep-peer-smoke-timeout-ms <n>] [--workflow-continuation-proof] [--execute-workflow-continuation-proof] [--workflow-continuation-proof-timeout-ms <n>] [--artifact-inventory] [--artifact-retention-cap <n>] [--artifact-max-bytes <n>] [--record] [--run-id <doctor-run-id>]\n`;
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
    workflowContinuationProof: false,
    executeWorkflowContinuationProof: false,
    workflowContinuationProofTimeoutMs: DEFAULT_WORKFLOW_CONTINUATION_PROOF_TIMEOUT_MS,
    artifactInventory: false,
    artifactRetentionCap: DEFAULT_ARTIFACT_RETENTION_CAP,
    artifactMaxBytes: DEFAULT_ARTIFACT_RETENTION_MAX_BYTES,
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
