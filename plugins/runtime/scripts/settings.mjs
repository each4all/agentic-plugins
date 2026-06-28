#!/usr/bin/env node
// plugins/runtime/scripts/settings.mjs
//
// ADR-0024 settings surface. Dry-run is the default. Config apply mode writes
// only agentic-plugins-owned config files. Plugin management execution requires
// a separate explicit executor flag. Runtime does not write Codex host config:
// the former --apply-codex-plugin-hooks [features].plugin_hooks write was
// removed per ADR-0035 §6 (plugin hooks gate via generic [features].hooks on
// current Codex, or a manual plugin_hooks edit on legacy Codex < ~0.134).
// Codex hook review/trust is host-session UI state, so runtime can only record
// an explicit operator attestation artifact after the user reviews /hooks.

import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import { PLUGIN_NAMES, RUNTIME_VERSION, runCommand, runDoctor, codexPerPluginVerbs } from './doctor.mjs';
import { sanitizeValue } from './lib/permission-sanitize.mjs';

export const SETTINGS_SCHEMA_VERSION = 'runtime-settings-1.11';
export const SETTINGS_EXECUTION_ARTIFACT_SCHEMA_VERSION = 'runtime-settings-execution-artifact-1.1';
export const CONFIG_KEYS = [
  'model',
  'effort',
  'claude_model',
  'claude_effort',
  'codex_model',
  'codex_effort',
];

const TARGETS = new Set(['repo', 'user', 'both']);
const PLUGIN_MANAGEMENT_HOSTS = new Set(['all', 'claude', 'codex']);
const EXECUTABLE_PLUGIN_ACTIONS = new Set(['install-plugin', 'update-plugin', 'add-marketplace', 'upgrade-marketplace']);
const EXECUTABLE_PLUGIN_CLEANUP_ACTIONS = new Set(['uninstall-retired-plugin']);
const DEFAULT_PLUGIN_MANAGEMENT_TIMEOUT_MS = 120000;
const SETTINGS_RUN_ID_RE = /^settings-\d{8}T\d{6}Z-[0-9a-f]{6}$/;
const DEFAULT_HOST_INSTALL_COMMANDS = {
  claude: 'install Claude Code with the host-native installer, then run `claude --version`',
  codex: 'install Codex CLI with the host-native installer, then run `codex --version`',
};

export async function runSettings({
  repoRoot = process.cwd(),
  homeDir = homedir(),
  env = process.env,
  now = new Date(),
  runner = undefined,
  format = 'text',
  host = 'auto',
  apply = false,
  target = 'both',
  desired = {},
  executePluginManagement = false,
  executePluginCleanup = false,
  attestCodexHookReview = false,
  pluginManagementHost = 'all',
  pluginManagementTimeoutMs = DEFAULT_PLUGIN_MANAGEMENT_TIMEOUT_MS,
  runId = null,
} = {}) {
  if (!TARGETS.has(target)) throw new Error('--target must be repo, user, or both');
  if (!PLUGIN_MANAGEMENT_HOSTS.has(pluginManagementHost)) throw new Error('--plugin-management-host must be all, claude, or codex');
  const resolvedRepoRoot = resolve(repoRoot);
  const resolvedHomeDir = resolve(homeDir);
  const startedAt = now.toISOString();
  const settingsExecutionRequested = executePluginManagement || executePluginCleanup || attestCodexHookReview;
  const settingsRunId = runId ? validateSettingsRunId(runId) : settingsExecutionRequested ? makeSettingsRunId(now) : null;
  const desiredConfig = normalizeDesiredConfig(desired);
  const commandRunner = runner ?? runCommand;

  const doctor = await runDoctor({
    repoRoot: resolvedRepoRoot,
    homeDir: resolvedHomeDir,
    env,
    now,
    runner: commandRunner,
    format: 'json',
    host,
  });

  const configPlans = await buildConfigPlans({
    repoRoot: resolvedRepoRoot,
    homeDir: resolvedHomeDir,
    target,
    desiredConfig,
  });

  if (apply) {
    await applyConfigPlans(configPlans);
  }

  const pluginPlans = buildPluginPlans(doctor.plugins, {
    codexPerPluginVerbList: codexPerPluginVerbs(doctor.clis?.codex?.feature_surface ?? {}),
  });
  const pluginManagement = await buildPluginManagementPlan({
    plugins: pluginPlans,
    clis: doctor.clis,
    execute: executePluginManagement,
    hostFilter: pluginManagementHost,
    runner: commandRunner,
    cwd: resolvedRepoRoot,
    env,
    timeoutMs: pluginManagementTimeoutMs,
  });
  applyPluginManagementResults(pluginPlans, pluginManagement);
  const cliPlans = buildCliPlans(doctor.clis);
  const pluginCleanup = await buildPluginCleanupPlans({
    hostParityIssues: doctor.host_parity?.issues ?? [],
    clis: doctor.clis,
    execute: executePluginCleanup,
    runner: commandRunner,
    cwd: resolvedRepoRoot,
    env,
    timeoutMs: pluginManagementTimeoutMs,
  });

  const companionSettings = buildCompanionSettingPlans({
    currentDirections: doctor.model_effort.directions,
    desiredConfig,
    configTargets: configPlans.targets,
    apply,
  });
  const hookSettings = buildHookSettingsPlan({
    codexPluginHooks: doctor.codex_plugin_hooks,
    plugins: pluginPlans,
  });
  const codexHookReview = buildCodexHookReviewAttestation({
    codexPluginHooks: doctor.codex_plugin_hooks,
    hookSettings,
    plugins: pluginPlans,
    requested: attestCodexHookReview,
    attestedAt: startedAt,
  });
  pluginManagement.manual_followups = mergeManualFollowups(
    pluginManagement.manual_followups,
    buildPluginCleanupManualFollowups(pluginCleanup.plans),
    buildCodexHookReviewManualFollowups(doctor.codex_plugin_hooks, hookSettings, codexHookReview),
  );

  const report = {
    schema_version: SETTINGS_SCHEMA_VERSION,
    runtime_version: RUNTIME_VERSION,
    generated_at: startedAt,
    repo_root: resolvedRepoRoot,
    host,
    output_format: format,
    dry_run: !(apply || executePluginManagement || executePluginCleanup || attestCodexHookReview),
    apply,
    config_apply: apply,
    execute_plugin_management: executePluginManagement,
    execute_plugin_cleanup: executePluginCleanup,
    attest_codex_hook_review: attestCodexHookReview,
    mutation_boundary: {
      writes_allowed: mutationBoundaryWritesAllowed({ apply, executePluginManagement, executePluginCleanup, attestCodexHookReview }),
      allowed_paths: [
        ...configPlans.targets.filter((plan) => plan.selected).map((plan) => plan.path),
      ],
      allowed_plugin_management_actions: executePluginManagement
        ? Array.from(EXECUTABLE_PLUGIN_ACTIONS).sort()
        : [],
      allowed_plugin_cleanup_actions: executePluginCleanup
        ? Array.from(EXECUTABLE_PLUGIN_CLEANUP_ACTIONS).sort()
        : [],
      plugin_management_host_filter: pluginManagementHost,
      forbidden: [
        'host-native Claude Code config',
        'host-native Codex CLI config',
        'authentication state or secrets',
        'sandbox or permission relaxation',
        ...(attestCodexHookReview ? ['Codex hook trust state mutation'] : []),
        ...(executePluginManagement ? [] : ['plugin install/update execution']),
        ...(executePluginCleanup
          ? ['general plugin uninstall execution outside retired/unknown agentic-plugins cleanup']
          : ['plugin uninstall execution']),
      ],
    },
    clis: cliPlans,
    plugins: pluginPlans,
    plugin_cleanup: pluginCleanup,
    plugin_command_surface: doctor.plugin_command_surface,
    plugin_management: pluginManagement,
    hook_settings: hookSettings,
    codex_hook_review: codexHookReview,
    config: {
      resolution_order: doctor.model_effort.resolution_order,
      desired: desiredConfig,
      targets: configPlans.targets,
    },
    companion_settings: companionSettings,
    artifacts: buildSettingsArtifactReport({
      repoRoot: resolvedRepoRoot,
      runId: settingsRunId,
      written: false,
      executePluginManagement,
      executePluginCleanup,
      attestCodexHookReview,
    }),
    recommendations: buildTopLevelRecommendations({
      clis: cliPlans,
      plugins: pluginPlans,
      pluginCleanup,
      desiredConfig,
      companionSettings,
      hookSettings,
    }),
    limits: [
      'Plugin install/update execution is dry-run unless --execute-plugin-management is supplied.',
      'Plugin management execution runs only allowlisted host-native plugin commands without shell interpolation.',
      'Plugin management output omits raw stdout/stderr and records only status, exit code, byte counts, timing, and sanitized error metadata.',
      'Retired/unknown plugin cleanup execution is dry-run unless --execute-plugin-cleanup is supplied.',
      'Plugin cleanup execution is limited to doctor-detected retired/unknown agentic-plugins Claude plugin uninstall commands.',
      'runtime:settings does not write Codex host config; the former --apply-codex-plugin-hooks [features].plugin_hooks write was removed per ADR-0035 §6. Plugin hooks load via generic [features].hooks (default on) plus /hooks review/trust on current Codex; legacy Codex < ~0.134 requires a manual [features].plugin_hooks edit.',
      'Codex hook review/trust attestation records an operator claim only; runtime cannot mutate or independently prove active-session /hooks trust state.',
      'Claude host-native config, auth, secrets, and sandbox/permission settings are not written.',
      'Companion invocation still uses companions/contract.md --model and --effort.',
      'Dynamic peer consensus, context hygiene mutation, completion footer mutation, deep peer smoke, and host-native config apply modes are deferred.',
    ],
  };
  report.overall = summarizeSettings(report);
  if (settingsExecutionRequested) {
    report.artifacts = await writeSettingsExecutionArtifact({
      repoRoot: resolvedRepoRoot,
      runId: settingsRunId,
      report,
      now,
    });
  }
  return report;
}

function normalizeDesiredConfig(desired) {
  const result = {};
  for (const key of CONFIG_KEYS) {
    const value = desired[key];
    if (value === null || value === undefined || value === '') continue;
    result[key] = normalizeConfigValue(value, key);
  }
  return result;
}

function normalizeConfigValue(value, key) {
  const text = String(value).trim();
  if (!text) throw new Error(`${key} cannot be empty`);
  if (/[\r\n\u0000]/.test(text)) throw new Error(`${key} must be a single-line value`);
  return text;
}

function mutationBoundaryWritesAllowed({ apply, executePluginManagement, executePluginCleanup, attestCodexHookReview }) {
  const allowed = [];
  if (apply) allowed.push('agentic-plugins-owned config files');
  if (executePluginManagement) allowed.push('allowlisted host-native plugin install/update commands');
  if (executePluginCleanup) allowed.push('allowlisted retired/unknown agentic-plugins plugin cleanup commands');
  if (attestCodexHookReview) allowed.push('runtime settings execution artifact with Codex hook review attestation');
  return allowed.length > 0 ? allowed.join('; ') : 'none; dry-run only';
}

async function buildConfigPlans({ repoRoot, homeDir, target, desiredConfig }) {
  const selectedTargets = target === 'both' ? new Set(['repo', 'user']) : new Set([target]);
  const targets = [
    await buildOneConfigPlan({
      kind: 'repo',
      path: join(repoRoot, '.agentic-plugins', 'config.toml'),
      selected: selectedTargets.has('repo'),
      desiredConfig,
    }),
    await buildOneConfigPlan({
      kind: 'user',
      path: join(homeDir, '.agentic-plugins', 'config.toml'),
      selected: selectedTargets.has('user'),
      desiredConfig,
    }),
  ];
  return { targets };
}

async function buildOneConfigPlan({ kind, path, selected, desiredConfig }) {
  const currentText = await readTextIfExists(path);
  const current = currentText.ok ? parseRuntimeConfigToml(currentText.text) : {};
  const actions = [];
  for (const [key, after] of Object.entries(desiredConfig)) {
    const before = current[key] ?? null;
    actions.push({
      op: before === after ? 'keep' : before === null ? 'add' : 'update',
      key,
      before,
      after,
    });
  }
  return {
    kind,
    path,
    status: currentText.ok ? 'available' : 'missing',
    selected,
    current_config: sortConfig(current),
    projected_config: sortConfig(selected ? { ...current, ...desiredConfig } : current),
    current_keys: Object.keys(current).sort(),
    planned_writes: actions.filter((action) => action.op !== 'keep'),
    unchanged: actions.filter((action) => action.op === 'keep'),
    applied: false,
    message: Object.keys(desiredConfig).length === 0
      ? 'No model/effort values requested; pass --model/--effort or direction-specific flags to plan config writes.'
      : selected
        ? 'Selected for apply when --apply is present.'
        : 'Not selected by --target.',
  };
}

async function applyConfigPlans(configPlans) {
  for (const plan of configPlans.targets) {
    if (!plan.selected || plan.planned_writes.length === 0) continue;
    const currentText = await readTextIfExists(plan.path);
    const desired = Object.fromEntries(plan.planned_writes.map((action) => [action.key, action.after]));
    const nextText = upsertRuntimeConfigToml(currentText.ok ? currentText.text : '', desired);
    await mkdir(dirname(plan.path), { recursive: true });
    await writeFile(plan.path, nextText, 'utf8');
    plan.applied = true;
    plan.status = 'available';
  }
}

export function parseRuntimeConfigToml(text) {
  const result = {};
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const withoutComment = raw.replace(/#.*/, '').trim();
    if (!withoutComment || withoutComment.startsWith('[')) continue;
    const match = withoutComment.match(/^([A-Za-z0-9_.-]+)\s*=\s*("?)(.*?)\2\s*$/);
    if (!match) continue;
    const key = normalizeConfigKey(match[1]);
    const value = match[3].trim();
    if (CONFIG_KEYS.includes(key) && value) result[key] = value;
  }
  return result;
}

export function upsertRuntimeConfigToml(text, desired) {
  const normalizedDesired = normalizeDesiredConfig(desired);
  const remaining = new Map(Object.entries(normalizedDesired));
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 0 && lines.at(-1) === '') lines.pop();
  const output = [];

  for (const line of lines) {
    const match = line.match(/^(\s*)([A-Za-z0-9_.-]+)(\s*=\s*)("?)(.*?)(\4)(\s*(?:#.*)?)$/);
    if (!match) {
      output.push(line);
      continue;
    }
    const normalizedKey = normalizeConfigKey(match[2]);
    if (!remaining.has(normalizedKey)) {
      output.push(line);
      continue;
    }
    output.push(`${match[1]}${match[2]}${match[3]}${tomlString(remaining.get(normalizedKey))}${match[7]}`);
    remaining.delete(normalizedKey);
  }

  if (remaining.size > 0) {
    if (output.length > 0 && output.at(-1) !== '') output.push('');
    output.push('# agentic-plugins runtime defaults');
    for (const [key, value] of remaining) {
      output.push(`${key} = ${tomlString(value)}`);
    }
  }
  return `${output.join('\n')}\n`;
}

function normalizeConfigKey(key) {
  return String(key).replace(/[.-]/g, '_');
}

function tomlString(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function sortConfig(config) {
  return Object.fromEntries(Object.entries(config).sort(([a], [b]) => a.localeCompare(b)));
}

function buildCliPlans(clis) {
  const result = {};
  for (const name of ['claude', 'codex']) {
    const cli = clis[name];
    const installPlan = buildCliInstallPlan(name, cli);
    const authPlan = buildCliAuthPlan(name, cli);
    result[name] = {
      status: cli.status,
      version: cli.version,
      auth: cli.auth,
      recommendation: installPlan.recommendation,
      install_plan: installPlan,
      auth_plan: authPlan,
    };
  }
  return result;
}

function buildCliInstallPlan(name, cli) {
  const available = cli.status === 'available';
  return {
    status: available ? 'not_needed' : 'manual_required',
    host: name,
    executable: false,
    command: null,
    recommendation: available ? null : DEFAULT_HOST_INSTALL_COMMANDS[name],
    next_step: available
      ? 'No host CLI installation action is required.'
      : DEFAULT_HOST_INSTALL_COMMANDS[name],
    evidence: {
      cli_status: cli.status,
      version_status: cli.version?.status ?? 'unknown',
      version_error_code: cli.version?.error_code ?? null,
    },
    limits: [
      'runtime:settings does not install Claude Code or Codex CLI.',
      'Install host CLIs with their host-native installer, then rerun runtime:doctor or runtime:settings.',
    ],
  };
}

function buildCliAuthPlan(name, cli) {
  if (cli.status !== 'available') {
    return {
      status: 'not_applicable',
      host: name,
      executable: false,
      command: null,
      next_step: 'Install the host CLI before checking authentication.',
      evidence: {
        cli_status: cli.status,
        auth_status: cli.auth?.status ?? 'unknown',
      },
      limits: ['runtime:settings does not authenticate host CLIs or mutate credentials.'],
    };
  }
  const authStatus = cli.auth?.status ?? 'unknown';
  if (authStatus === 'available') {
    return {
      status: 'not_needed',
      host: name,
      executable: false,
      command: null,
      next_step: 'No host authentication action is required.',
      evidence: {
        cli_status: cli.status,
        auth_status: authStatus,
      },
      limits: ['runtime:settings does not authenticate host CLIs or mutate credentials.'],
    };
  }
  const loginCommand = name === 'claude' ? 'claude auth login' : 'codex login';
  const statusCommand = name === 'claude' ? 'claude auth status' : 'codex login status';
  const status = authStatus === 'unauthenticated' ? 'manual_required' : 'manual_check';
  const command = status === 'manual_required' ? loginCommand : statusCommand;
  return {
    status,
    host: name,
    executable: false,
    command,
    next_step: authStatus === 'unauthenticated'
      ? `Run ${command} outside runtime:settings, then rerun runtime:doctor.`
      : authStatus === 'sandbox_limited'
        ? `Run or approve ${statusCommand} outside the current sandbox. Only run ${loginCommand} if that direct probe is also unauthenticated.`
        : `Verify host auth with ${statusCommand}, then rerun runtime:doctor.`,
    evidence: {
      cli_status: cli.status,
      auth_status: authStatus,
      logged_in: cli.auth?.logged_in ?? null,
    },
    limits: ['runtime:settings does not authenticate host CLIs or mutate credentials.'],
  };
}

async function buildPluginCleanupPlans({ hostParityIssues, clis, execute, runner, cwd, env, timeoutMs }) {
  const plans = [];
  for (const issue of hostParityIssues) {
    if (issue.id !== 'claude_retired_or_unknown_plugin') continue;
    const host = issue.host ?? 'claude';
    const plugin = issue.plugin;
    const command = buildPluginCleanupCommand({ host, plugin });
    const planStatus = classifyPluginCleanupPlan({
      host,
      action: 'uninstall-retired-plugin',
      argv: command?.argv ?? null,
      clis,
      execute,
    });
    plans.push({
      host,
      plugin,
      action: 'uninstall-retired-plugin',
      status: planStatus.status,
      severity: issue.severity ?? 'warning',
      executable: planStatus.executable,
      executed: false,
      command: command?.display ?? null,
      argv: command?.argv ?? null,
      detail: issue.summary,
      evidence: issue.evidence,
      next_step: execute
        ? planStatus.next_step ?? issue.next_step
        : 'Add --execute-plugin-cleanup to run this narrow cleanup executor, or run the host-native command manually.',
      reason: planStatus.reason,
      result: null,
      limits: [
        execute
          ? 'runtime:settings executes only doctor-detected retired/unknown agentic-plugins cleanup commands.'
          : 'runtime:settings does not execute plugin cleanup unless --execute-plugin-cleanup is supplied.',
        'Uninstall retired or unknown plugins only after confirming they are no longer expected in the marketplace.',
      ],
    });
  }
  if (execute) {
    for (const plan of plans) {
      if (plan.status !== 'planned') continue;
      const startedAt = new Date();
      const result = await runner(plan.argv.command, plan.argv.args, { cwd, env, timeoutMs });
      const completedAt = new Date();
      const semanticFailure = classifyPluginManagementSemanticFailure({ plan, result });
      const effectiveResult = semanticFailure
        ? {
            ...result,
            ok: false,
            error_code: semanticFailure.error_code,
            error_message: semanticFailure.error_message,
          }
        : result;
      plan.executed = true;
      plan.status = effectiveResult.ok ? 'executed' : 'failed';
      plan.result = sanitizeCommandResult({ result: effectiveResult, startedAt, completedAt });
    }
  }
  const summary = summarizePluginCleanupPlans(plans);
  return {
    requested: execute,
    executed: execute,
    mode: execute ? 'explicit-plugin-cleanup-executor' : 'dry-run-plan',
    timeout_ms: timeoutMs,
    allowlist: Array.from(EXECUTABLE_PLUGIN_CLEANUP_ACTIONS).sort(),
    status: summarizePluginCleanupStatus(plans, summary),
    summary,
    plans,
    limits: [
      'No shell interpolation is used; cleanup commands are invoked as argv arrays.',
      'Only retired/unknown agentic-plugins Claude plugin uninstall commands surfaced by runtime:doctor are executable.',
      'Raw stdout and stderr are omitted from settings output.',
    ],
  };
}

function buildPluginCleanupCommand({ host, plugin }) {
  if (host !== 'claude' || typeof plugin !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(plugin)) return null;
  return commandSpec('claude', ['plugin', 'uninstall', `${plugin}@agentic-plugins`]);
}

function classifyPluginCleanupPlan({ host, action, argv, clis, execute }) {
  if (!execute) {
    return {
      status: 'manual_required',
      executable: false,
      reason: 'dry-run; cleanup executor requires --execute-plugin-cleanup',
    };
  }
  if (!EXECUTABLE_PLUGIN_CLEANUP_ACTIONS.has(action)) {
    return {
      status: 'blocked',
      executable: false,
      reason: 'action is not in the plugin-cleanup executor allowlist',
      next_step: 'Run the host-native cleanup command manually only after confirming it is expected.',
    };
  }
  if (!argv?.command || !Array.isArray(argv?.args)) {
    return {
      status: 'blocked',
      executable: false,
      reason: 'cleanup recommendation has no argv command spec',
      next_step: 'Run the host-native cleanup command manually only after confirming it is expected.',
    };
  }
  if (host !== 'claude') {
    return {
      status: 'blocked',
      executable: false,
      reason: 'only Claude retired plugin cleanup is supported',
      next_step: 'Use that host-native plugin manager manually.',
    };
  }
  const cli = clis[host];
  if (cli?.status !== 'available') {
    return {
      status: 'blocked',
      executable: false,
      reason: `${host} CLI is not available`,
      next_step: 'Install or open the host CLI before retrying cleanup.',
    };
  }
  if (['unavailable', 'blocked'].includes(cli.plugin?.status)) {
    return {
      status: 'blocked',
      executable: false,
      reason: `claude plugin CLI is ${cli.plugin.status}`,
      next_step: 'Retry cleanup from a Claude Code environment that supports claude plugin commands.',
    };
  }
  if (!cli.feature_surface?.plugin_uninstall_command) {
    return {
      status: 'blocked',
      executable: false,
      reason: 'claude plugin CLI uninstall surface is not available',
      next_step: 'Run cleanup manually in a Claude Code environment that supports claude plugin uninstall.',
    };
  }
  return {
    status: 'planned',
    executable: true,
    reason: 'allowlisted retired/unknown agentic-plugins cleanup command',
  };
}

function summarizePluginCleanupPlans(plans) {
  return {
    planned: plans.length,
    executable: plans.filter((plan) => plan.executable).length,
    executed: plans.filter((plan) => plan.status === 'executed').length,
    failed: plans.filter((plan) => plan.status === 'failed').length,
    blocked: plans.filter((plan) => plan.status === 'blocked').length,
    manual_required: plans.filter((plan) => plan.status === 'manual_required').length,
    failed_retryable: plans.filter((plan) => plan.status === 'failed' && plan.result?.retryable === true).length,
    failed_non_retryable: plans.filter((plan) => plan.status === 'failed' && plan.result?.retryable !== true).length,
  };
}

function summarizePluginCleanupStatus(plans, summary) {
  if (plans.length === 0) return 'not_needed';
  if (summary.failed > 0) return 'failed';
  if (summary.blocked > 0) return 'blocked';
  if (summary.manual_required > 0) return 'manual_required';
  if (summary.executed > 0) return 'executed';
  return 'planned';
}

function buildPluginPlans(plugins, { codexPerPluginVerbList = [] } = {}) {
  const result = {};
  for (const name of PLUGIN_NAMES) {
    const plugin = plugins[name];
    const sourceVersion = plugin.source?.claude_manifest?.version ?? plugin.source?.codex_manifest?.version ?? null;
    const claudeInstalled = plugin.installed?.claude_plugin_list ?? null;
    const claudeCacheLatest = plugin.cache?.claude?.latest ?? null;
    const codexCacheLatest = plugin.cache?.codex?.latest ?? null;
    const codexTmpMarketplace = plugin.cache?.codex_tmp_marketplace ?? null;
    const codexResolved = plugin.installed?.codex_resolved ?? null;
    result[name] = {
      status: plugin.status,
      source_version: sourceVersion,
      marketplace: plugin.marketplace,
      installed: {
        claude_plugin_list: claudeInstalled,
        claude_cache: summarizeCacheInstall(claudeCacheLatest),
        codex_cache: summarizeCacheInstall(codexCacheLatest),
      },
      marketplace_cache: {
        codex_tmp_marketplace: summarizeSingleManifest(codexTmpMarketplace),
      },
      recommendations: pluginRecommendations({
        name,
        sourceVersion,
        marketplace: plugin.marketplace,
        claudeInstalled,
        claudeCacheLatest,
        codexCacheLatest,
        codexTmpMarketplace,
        codexResolved,
        codexPerPluginVerbList,
      }),
    };
  }
  return result;
}

function summarizeCacheInstall(latest) {
  if (!latest) return null;
  return {
    version: latest.manifest_version ?? null,
    path: latest.path ?? null,
  };
}

function summarizeSingleManifest(manifest) {
  if (manifest?.status !== 'available') return null;
  return {
    version: manifest.manifest_version ?? null,
    path: manifest.path ?? null,
    manifest_path: manifest.manifest_path ?? null,
  };
}

function pluginRecommendations({ name, sourceVersion, marketplace, claudeInstalled, claudeCacheLatest, codexCacheLatest, codexTmpMarketplace, codexResolved = null, codexPerPluginVerbList = [] }) {
  const recommendations = [];
  // `add` is the per-plugin install verb and the threshold for recognizing the
  // surface; enumerate only the observed verbs so strings never overclaim.
  const codexPerPluginSurface = codexPerPluginVerbList.includes('add');
  const codexPerPluginVerbText = codexPerPluginVerbList.join('/') || 'add';
  if (!marketplace?.claude) {
    recommendations.push({
      host: 'claude',
      action: 'register-marketplace-entry',
      executed: false,
      command: null,
      detail: `Add ${name} to .claude-plugin/marketplace.json with source ./plugins/${name}.`,
    });
  }
  if (!marketplace?.codex) {
    recommendations.push({
      host: 'codex',
      action: 'register-marketplace-entry',
      executed: false,
      command: null,
      detail: `Add ${name} to .agents/plugins/marketplace.json with source ./plugins/${name}.`,
    });
  }

  const claudeVersion = claudeInstalled?.version ?? claudeCacheLatest?.manifest_version ?? null;
  if (!claudeInstalled && !claudeCacheLatest) {
    const command = buildPluginCommand({ host: 'claude', action: 'install-plugin', name });
    recommendations.push({
      id: `${name}:claude:install-plugin`,
      host: 'claude',
      action: 'install-plugin',
      executed: false,
      command: command.display,
      argv: command.argv,
      executable: true,
      detail: 'Dry-run by default; add --execute-plugin-management to run this allowlisted host-native plugin command.',
    });
  } else if (sourceVersion && claudeVersion && semverCompare(String(claudeVersion), String(sourceVersion)) < 0) {
    const command = buildPluginCommand({ host: 'claude', action: 'update-plugin', name });
    recommendations.push({
      id: `${name}:claude:update-plugin`,
      host: 'claude',
      action: 'update-plugin',
      executed: false,
      command: command.display,
      argv: command.argv,
      executable: true,
      detail: `Installed ${claudeVersion}; source/catalog ${sourceVersion}.`,
    });
  }

  const codexVersion = codexCacheLatest?.manifest_version ?? null;
  const codexTmpVersion = codexTmpMarketplace?.status === 'available' ? codexTmpMarketplace.manifest_version ?? null : null;
  // ADR-0034 cross-script consumer: when `codex plugin list` was authoritative,
  // it — not the filesystem cache — decides the install state, so the cache-driven
  // recommendations in the trailing `else if` chain must not contradict it. Only
  // fall through to that legacy logic when the list was unavailable (decision
  // 'fallback') or the doctor report predates codex_resolved.
  const codexDecision = codexResolved?.decision ?? null;
  const codexListVersion = codexResolved?.version ?? null;
  const codexInstallCacheStatus = codexCacheLatest ? 'present' : 'missing';
  const codexListAuthoritative = Boolean(codexResolved) && codexDecision !== 'fallback';
  if (codexListAuthoritative && codexDecision === 'installed') {
    if (sourceVersion && codexListVersion && semverCompare(String(codexListVersion), String(sourceVersion)) < 0) {
      const command = buildPluginCommand({ host: 'codex', action: 'upgrade-marketplace', name });
      recommendations.push({
        id: `${name}:codex:upgrade-marketplace`,
        host: 'codex',
        action: 'upgrade-marketplace',
        executed: false,
        command: command.display,
        argv: command.argv,
        executable: true,
        detail: `Codex \`plugin list\` reports ${name} ${codexListVersion} installed; source/catalog ${sourceVersion}. Codex upgrades via the marketplace, not a per-plugin update command.`,
        evidence: { list_decision: codexDecision, list_version: codexListVersion, install_cache_status: codexInstallCacheStatus },
      });
    } else if (!codexCacheLatest) {
      recommendations.push({
        id: `${name}:codex:materialize-plugin-cache`,
        host: 'codex',
        action: 'materialize-plugin-cache',
        executed: false,
        command: null,
        argv: null,
        executable: false,
        detail: codexPerPluginSurface
          ? `Codex \`plugin list\` reports ${name}${codexListVersion ? ` ${codexListVersion}` : ''} installed, but runtime did not find a materialized per-plugin install cache. Codex exposes per-plugin ${codexPerPluginVerbText}; runtime recognizes this surface but does not auto-execute codex plugin add (execution wiring is a deferred follow-up), so cache materialization stays manual.`
          : `Codex \`plugin list\` reports ${name}${codexListVersion ? ` ${codexListVersion}` : ''} installed, but runtime did not find a materialized per-plugin install cache; the current Codex CLI exposes marketplace add/upgrade/remove rather than per-plugin install/list, so runtime cannot execute cache materialization directly.`,
        next_step: codexPerPluginSurface
          ? `Start a fresh Codex session (or re-run \`codex plugin add ${name}@agentic-plugins\`) so the host materializes the install cache, then verify with runtime:doctor.`
          : 'Start a fresh Codex session after a marketplace refresh so the host materializes the install cache, then verify with runtime:doctor.',
        evidence: {
          command_surface: codexPerPluginSurface ? 'per-plugin-and-marketplace' : 'marketplace-only',
          list_decision: codexDecision,
          list_version: codexListVersion,
          install_cache_status: codexInstallCacheStatus,
        },
      });
    }
    // installed per list, current version, cache materialized → no recommendation.
  } else if (codexListAuthoritative && codexDecision === 'disabled') {
    recommendations.push({
      id: `${name}:codex:enable-plugin`,
      host: 'codex',
      action: 'enable-plugin',
      executed: false,
      command: null,
      argv: null,
      executable: false,
      detail: `Codex \`plugin list\` reports ${name}${codexListVersion ? ` ${codexListVersion}` : ''} installed but disabled. Cache materialization is not the issue — enable it in the host before relying on Codex-side parity.`,
      next_step: `Enable ${name} in Codex (host plugin settings), then verify with runtime:doctor.`,
      evidence: { list_decision: codexDecision, list_version: codexListVersion, install_cache_status: codexInstallCacheStatus },
    });
  } else if (codexListAuthoritative && codexDecision === 'not_installed') {
    // The list authoritatively reports not installed: recommend making it
    // available based on the marketplace cache state, ignoring any stale install
    // cache (which the list overrides).
    if (sourceVersion && codexTmpVersion && semverCompare(String(codexTmpVersion), String(sourceVersion)) < 0) {
      const command = buildPluginCommand({ host: 'codex', action: 'upgrade-marketplace', name });
      recommendations.push({
        id: `${name}:codex:upgrade-marketplace`,
        host: 'codex',
        action: 'upgrade-marketplace',
        executed: false,
        command: command.display,
        argv: command.argv,
        executable: true,
        detail: `Codex \`plugin list\` does not report ${name} installed; marketplace cache has ${codexTmpVersion}, source/catalog ${sourceVersion}. Refresh the marketplace before installing.`,
        evidence: { list_decision: codexDecision, list_version: null, install_cache_status: codexInstallCacheStatus },
      });
    } else if (codexTmpVersion && codexPerPluginSurface) {
      // The list says not installed; the marketplace cache has it; Codex exposes
      // the per-plugin `add` verb. This is an EXECUTABLE `codex plugin add`
      // (ADR-0035 §5/§6, C) — an H2 install behind --execute-plugin-management.
      // The actual installPolicy/authPolicy gate happens at execute time via a
      // `codex plugin list --available --json` pre-flight (the plain list does not
      // report not-installed plugins' policy), then a `codex plugin list --json`
      // post-verify. It never mutates Codex trust state (enabled ≠ trusted).
      const command = buildPluginCommand({ host: 'codex', action: 'install-plugin', name });
      recommendations.push({
        id: `${name}:codex:install-plugin`,
        host: 'codex',
        action: 'install-plugin',
        executed: false,
        command: command.display,
        argv: command.argv,
        executable: true,
        detail: `Codex \`plugin list\` does not report ${name} installed; the marketplace cache has ${codexTmpVersion}. Codex exposes per-plugin ${codexPerPluginVerbText}; runtime can install it with \`codex plugin add ${name}@agentic-plugins\` (ADR-0035 §5/§6 H2 executor). Execution is policy-gated (pre-flight installPolicy=AVAILABLE + non-ON_INSTALL authPolicy via \`codex plugin list --available --json\`), runs only under --execute-plugin-management, and post-verifies installation. It never trusts hooks (enabled ≠ trusted; /hooks review is separate).`,
        next_step: `Run \`runtime:settings --execute-plugin-management\` to install ${name} from the marketplace cache (or \`codex plugin add ${name}@agentic-plugins\` manually), then verify with runtime:doctor.`,
        evidence: {
          command_surface: 'per-plugin-and-marketplace',
          list_decision: codexDecision,
          list_version: null,
          install_cache_status: codexInstallCacheStatus,
        },
      });
    } else if (codexTmpVersion) {
      // Not installed, marketplace cache present, but the current Codex CLI exposes
      // only marketplace add/upgrade/remove (no per-plugin install) — stays manual.
      recommendations.push({
        id: `${name}:codex:install-plugin-manual`,
        host: 'codex',
        action: 'install-plugin-manual',
        executed: false,
        command: null,
        argv: null,
        executable: false,
        detail: `Codex \`plugin list\` does not report ${name} installed; the marketplace cache has ${codexTmpVersion}, but the current Codex CLI exposes marketplace add/upgrade/remove rather than per-plugin install/list, so runtime cannot install it directly.`,
        next_step: `Install ${name} through the Codex host plugin surface (the current CLI exposes no per-plugin install verb), then verify with runtime:doctor. A fresh session alone does not install it.`,
        evidence: {
          command_surface: 'marketplace-only',
          list_decision: codexDecision,
          list_version: null,
          install_cache_status: codexInstallCacheStatus,
        },
      });
    } else {
      const command = buildPluginCommand({ host: 'codex', action: 'add-marketplace', name });
      recommendations.push({
        id: `${name}:codex:add-marketplace`,
        host: 'codex',
        action: 'add-marketplace',
        executed: false,
        command: command.display,
        argv: command.argv,
        executable: true,
        detail: codexPerPluginSurface
          ? `Codex \`plugin list\` does not report ${name} installed and no marketplace catalog is configured. Codex exposes per-plugin ${codexPerPluginVerbText} plus marketplace add/list/upgrade/remove; add the marketplace catalog first.`
          : `Codex \`plugin list\` does not report ${name} installed and no marketplace catalog is configured. Add the marketplace catalog to make ${name} available.`,
        evidence: { list_decision: codexDecision, list_version: null, install_cache_status: codexInstallCacheStatus },
      });
    }
  } else if (!codexCacheLatest) {
    if (sourceVersion && codexTmpVersion && semverCompare(String(codexTmpVersion), String(sourceVersion)) < 0) {
      const command = buildPluginCommand({ host: 'codex', action: 'upgrade-marketplace', name });
      recommendations.push({
        id: `${name}:codex:upgrade-marketplace`,
        host: 'codex',
        action: 'upgrade-marketplace',
        executed: false,
        command: command.display,
        argv: command.argv,
        executable: true,
        detail: `Codex marketplace cache has ${codexTmpVersion}; source/catalog ${sourceVersion}. Codex upgrades via the marketplace, not a per-plugin update command.`,
      });
    } else if (codexTmpVersion) {
      recommendations.push({
        id: `${name}:codex:materialize-plugin-cache`,
        host: 'codex',
        action: 'materialize-plugin-cache',
        executed: false,
        command: null,
        argv: null,
        executable: false,
        detail: codexPerPluginSurface
          ? `Codex marketplace cache already has ${name} ${codexTmpVersion}, but no per-plugin install cache was found. Codex exposes per-plugin ${codexPerPluginVerbText}; runtime recognizes this surface but does not auto-execute codex plugin add (execution wiring is a deferred follow-up), so cache materialization stays manual.`
          : `Codex marketplace cache already has ${name} ${codexTmpVersion}, but no per-plugin install cache was found. Current Codex CLI exposes marketplace add/upgrade/remove rather than per-plugin install/list, so runtime cannot execute cache materialization directly.`,
        next_step: codexPerPluginSurface
          ? `Run \`codex plugin add ${name}@agentic-plugins\` manually or start a fresh Codex session, then verify host cache materialization with runtime:doctor. Do not repeat marketplace add unless the marketplace cache is missing or stale.`
          : 'Start a fresh Codex session or invoke the plugin surface after marketplace refresh, then verify host cache materialization with runtime:doctor. Do not repeat marketplace add unless the marketplace cache is missing or stale.',
        evidence: {
          command_surface: codexPerPluginSurface ? 'per-plugin-and-marketplace' : 'marketplace-only',
          marketplace_cache_version: codexTmpVersion,
          install_cache_status: 'missing',
        },
      });
    } else {
      const command = buildPluginCommand({ host: 'codex', action: 'add-marketplace', name });
      recommendations.push({
        id: `${name}:codex:add-marketplace`,
        host: 'codex',
        action: 'add-marketplace',
        executed: false,
        command: command.display,
        argv: command.argv,
        executable: true,
        detail: codexPerPluginSurface
          ? `Codex exposes per-plugin ${codexPerPluginVerbText} plus marketplace add/list/upgrade/remove; add the marketplace catalog first so ${name} can be installed.`
          : `Codex exposes marketplace add/upgrade/remove, not per-plugin install; add the marketplace catalog to make ${name} available.`,
      });
    }
  } else if (sourceVersion && codexVersion && semverCompare(String(codexVersion), String(sourceVersion)) < 0) {
    const command = buildPluginCommand({ host: 'codex', action: 'upgrade-marketplace', name });
    recommendations.push({
      id: `${name}:codex:upgrade-marketplace`,
      host: 'codex',
      action: 'upgrade-marketplace',
      executed: false,
      command: command.display,
      argv: command.argv,
      executable: true,
      detail: `Cached ${codexVersion}; source/catalog ${sourceVersion}. Codex upgrades via the marketplace, not a per-plugin update command.`,
    });
  }
  return recommendations;
}

function buildPluginCommand({ host, action, name }) {
  if (host === 'claude' && action === 'install-plugin') {
    return commandSpec('claude', ['plugin', 'install', `${name}@agentic-plugins`]);
  }
  if (host === 'claude' && action === 'update-plugin') {
    return commandSpec('claude', ['plugin', 'update', `${name}@agentic-plugins`]);
  }
  if (host === 'codex' && action === 'install-plugin') {
    // ADR-0035 §5/§6 (C): H2 per-plugin install. Fixed argv — NO -c/--config,
    // --enable, or --disable (config-injection / feature-toggle escalation).
    // Execution is policy-gated at run time (pre-flight installPolicy/authPolicy).
    return commandSpec('codex', ['plugin', 'add', `${name}@agentic-plugins`]);
  }
  if (host === 'codex' && action === 'add-marketplace') {
    return commandSpec('codex', ['plugin', 'marketplace', 'add', 'each4all/agentic-plugins']);
  }
  if (host === 'codex' && action === 'upgrade-marketplace') {
    return commandSpec('codex', ['plugin', 'marketplace', 'upgrade', 'agentic-plugins']);
  }
  return null;
}

function commandSpec(command, args) {
  return {
    display: [command, ...args].join(' '),
    argv: { command, args },
  };
}

// ADR-0035 §6 (C) — codex install policy pre-flight + post-verify helpers.
// The plugin name is the argv install target's local part (`<name>@agentic-plugins`).
function codexInstallTargetName(plan) {
  const args = plan?.argv?.args ?? [];
  const target = args[args.length - 1] ?? '';
  return String(target).split('@')[0];
}

// Parse `codex plugin list [--available] --json` stdout and return the
// agentic-plugins entry for `name` from `installed` or `available`, or null.
function parseCodexPluginListEntry(stdout, name) {
  let parsed;
  try {
    parsed = JSON.parse(stdout ?? '');
  } catch {
    return { parseError: true, entry: null };
  }
  const rows = [];
  if (Array.isArray(parsed?.installed)) rows.push(...parsed.installed);
  if (Array.isArray(parsed?.available)) rows.push(...parsed.available);
  const entry = rows.find((e) => e && e.name === name && e.marketplaceName === 'agentic-plugins') ?? null;
  return { parseError: false, entry };
}

// Pre-flight: install only when the plugin is marketplace-available with
// installPolicy=AVAILABLE and an authPolicy that neither requires auth at install
// (ON_INSTALL) nor is unknown (null). Read-only `codex plugin list --available --json`.
async function codexInstallPreflight({ plan, runner, cwd, env, timeoutMs }) {
  const name = codexInstallTargetName(plan);
  const probe = await runner('codex', ['plugin', 'list', '--available', '--json'], { cwd, env, timeoutMs });
  const base = { probed: true, found: false, install_policy: null, auth_policy: null };
  if (!probe.ok) return { ok: false, reason: 'preflight-list-unavailable', evidence: base };
  const { parseError, entry } = parseCodexPluginListEntry(probe.stdout, name);
  if (parseError) return { ok: false, reason: 'preflight-list-unparseable', evidence: base };
  if (!entry) return { ok: false, reason: 'plugin-not-available-in-marketplace', evidence: base };
  const installPolicy = typeof entry.installPolicy === 'string' ? entry.installPolicy : null;
  const authPolicy = typeof entry.authPolicy === 'string' ? entry.authPolicy : null;
  const evidence = { probed: true, found: true, install_policy: installPolicy, auth_policy: authPolicy };
  if (installPolicy !== 'AVAILABLE') return { ok: false, reason: 'install-policy-not-available', evidence };
  if (authPolicy === null) return { ok: false, reason: 'auth-policy-unknown', evidence };
  if (authPolicy === 'ON_INSTALL') return { ok: false, reason: 'auth-required-on-install', evidence };
  return { ok: true, reason: null, evidence };
}

// Post-verify: confirm the plugin now appears installed via the read-only list.
async function codexInstallPostverify({ plan, runner, cwd, env, timeoutMs }) {
  const name = codexInstallTargetName(plan);
  const probe = await runner('codex', ['plugin', 'list', '--json'], { cwd, env, timeoutMs });
  if (!probe.ok) return { installed: false, evidence: { probed: true, installed: null, version: null, enabled: null } };
  const { entry } = parseCodexPluginListEntry(probe.stdout, name);
  const installed = entry?.installed === true;
  return { installed, evidence: { probed: true, installed, version: entry?.version ?? null, enabled: entry?.enabled ?? null } };
}

async function buildPluginManagementPlan({ plugins, clis, execute, hostFilter, runner, cwd, env, timeoutMs }) {
  const plans = buildPluginManagementCandidates({ plugins, clis, hostFilter });
  if (execute) {
    for (const plan of plans) {
      if (plan.status !== 'planned') continue;
      const isCodexInstall = plan.host === 'codex' && plan.action === 'install-plugin';
      // ADR-0035 §6 pre-flight: gate the codex install on installPolicy/authPolicy
      // read from `codex plugin list --available --json` (the plain list omits
      // not-installed plugins). If not safe, BLOCK — never run `codex plugin add`.
      if (isCodexInstall) {
        const preflight = await codexInstallPreflight({ plan, runner, cwd, env, timeoutMs });
        plan.preflight = preflight.evidence;
        if (!preflight.ok) {
          plan.executed = false;
          plan.status = 'blocked';
          plan.block_reason = preflight.reason;
          continue;
        }
      }
      const startedAt = new Date();
      const result = await runner(plan.argv.command, plan.argv.args, { cwd, env, timeoutMs });
      const completedAt = new Date();
      // ADR-0035 §6 post-verify: confirm the install landed via a read-only list.
      let postVerify = null;
      if (isCodexInstall && result.ok) {
        postVerify = await codexInstallPostverify({ plan, runner, cwd, env, timeoutMs });
        plan.post_verify = postVerify.evidence;
      }
      const semanticFailure = classifyPluginManagementSemanticFailure({ plan, result, postVerify });
      const effectiveResult = semanticFailure
        ? {
            ...result,
            ok: false,
            error_code: semanticFailure.error_code,
            error_message: semanticFailure.error_message,
          }
        : result;
      plan.executed = true;
      plan.status = effectiveResult.ok ? 'executed' : 'failed';
      plan.result = sanitizeCommandResult({ result: effectiveResult, startedAt, completedAt });
    }
  }
  return {
    requested: execute,
    executed: execute,
    mode: execute ? 'explicit-plugin-management-executor' : 'dry-run-plan',
    host_filter: hostFilter,
    timeout_ms: timeoutMs,
    allowlist: Array.from(EXECUTABLE_PLUGIN_ACTIONS).sort(),
    plans,
    summary: summarizePluginManagementPlans(plans),
    manual_followups: buildPluginManagementManualFollowups(plans),
    limits: [
      'No shell interpolation is used; executable commands are invoked as argv arrays.',
      'Only install/update/add/upgrade plugin-management actions are executable.',
      'Marketplace catalog file registration remains manual because it is a repository edit, not a host plugin command.',
      'Raw stdout and stderr are omitted from settings output.',
    ],
  };
}

function buildPluginManagementCandidates({ plugins, clis, hostFilter }) {
  const plans = [];
  const seenExecutableCommands = new Map();
  for (const [pluginName, plugin] of Object.entries(plugins)) {
    for (const recommendation of plugin.recommendations) {
      const basePlan = {
        id: recommendation.id ?? `${pluginName}:${recommendation.host}:${recommendation.action}`,
        plugin: pluginName,
        host: recommendation.host,
        action: recommendation.action,
        command: recommendation.command,
        argv: recommendation.argv ?? null,
        executed: false,
        result: null,
        detail: recommendation.detail,
        next_step: recommendation.next_step ?? null,
        evidence: recommendation.evidence ?? null,
      };
      const status = classifyPluginManagementPlan({ recommendation, hostFilter, clis });
      plans.push({ ...basePlan, ...status });
      const plan = plans.at(-1);
      if (plan.status !== 'planned') continue;
      const commandKey = `${plan.argv.command}\0${plan.argv.args.join('\0')}`;
      const duplicateOf = seenExecutableCommands.get(commandKey);
      if (duplicateOf) {
        plan.status = 'deduplicated';
        plan.executable = false;
        plan.reason = `same host command already planned by ${duplicateOf}`;
        plan.duplicate_of = duplicateOf;
      } else {
        seenExecutableCommands.set(commandKey, plan.id);
      }
    }
  }
  return plans;
}

function buildPluginManagementManualFollowups(plans) {
  const followups = [];
  const claudeSurfaceBlocked = plans.filter((plan) => (
    plan.host === 'claude'
      && plan.status === 'blocked'
      && /claude plugin CLI (?:is unavailable|install\/update surface is not available)|plugin command surface is (?:unavailable|blocked)/i.test(plan.reason ?? '')
  ));
  if (claudeSurfaceBlocked.length > 0) {
    followups.push({
      id: 'claude-plugin-surface-unavailable',
      host: 'claude',
      status: 'manual_required',
      reason: 'Claude plugin CLI command surface is unavailable to runtime:settings in this environment.',
      environment: 'Open a Claude Code environment that supports claude plugin commands.',
      commands: uniqueStrings(claudeSurfaceBlocked
        .map((plan) => claudePluginCommand(plan.argv?.args))
        .filter(Boolean)),
      verify: 'Re-run runtime:settings or runtime:doctor after completing the commands.',
    });
  }
  // ADR-0035 §6 (C) — a codex install blocked by the installPolicy/authPolicy
  // pre-flight gets explicit manual recovery guidance (§3 invariant 8), with the
  // exact `codex plugin add` the operator can run themselves after resolving the
  // policy condition. Runtime will not run it because the host reported it unsafe
  // to install non-interactively.
  const codexInstallBlocked = plans.filter((plan) => (
    plan.host === 'codex' && plan.action === 'install-plugin' && plan.status === 'blocked'
  ));
  if (codexInstallBlocked.length > 0) {
    followups.push({
      id: 'codex-install-policy-blocked',
      host: 'codex',
      status: 'manual_required',
      reason: 'Codex reported one or more plugins as unsafe to install non-interactively (installPolicy/authPolicy pre-flight blocked them).',
      reasons: uniqueStrings(codexInstallBlocked.map((plan) => plan.block_reason).filter(Boolean)),
      commands: uniqueStrings(codexInstallBlocked.map((plan) => plan.command).filter(Boolean)),
      verify: 'Resolve the policy condition (e.g. authenticate when authPolicy is ON_INSTALL), run the command manually, then re-run runtime:doctor.',
    });
  }
  return followups;
}

function buildPluginCleanupManualFollowups(plans) {
  const cleanupPlans = plans.filter((plan) => (
    plan.host === 'claude'
      && ['manual_required', 'blocked', 'failed'].includes(plan.status)
      && plan.action === 'uninstall-retired-plugin'
  ));
  if (cleanupPlans.length === 0) return [];
  const commands = uniqueStrings(cleanupPlans
    .map((plan) => claudeCommandDisplay(plan.command))
    .filter(Boolean));
  if (commands.length === 0) return [];
  return [{
    id: 'claude-retired-plugin-cleanup',
    host: 'claude',
    status: cleanupPlans.some((plan) => plan.status === 'failed') ? 'manual_required' : cleanupPlans.some((plan) => plan.status === 'blocked') ? 'manual_check' : 'manual_required',
    reason: cleanupPlans.some((plan) => ['blocked', 'failed'].includes(plan.status))
      ? 'Claude retired or unknown agentic-plugins cleanup could not be completed by runtime:settings.'
      : 'Claude has retired or unknown agentic-plugins entries that require explicit cleanup execution or a manual host-native uninstall.',
    environment: 'Open a Claude Code environment that supports claude plugin commands.',
    commands,
    verify: 'Re-run runtime:settings or runtime:doctor after completing the commands.',
  }];
}

function buildCodexHookReviewManualFollowups(codexPluginHooks, hookSettings, codexHookReview = null) {
  if (codexHookReview?.attested === true && codexHookReview.status === 'attested') return [];
  const bundled = hookSettings?.packaged_plugins?.bundled ?? codexPluginHooks?.summary?.bundled_plugins ?? [];
  const status = hookSettings?.status ?? codexPluginHooks?.status;
  const targets = hookSettings?.review_targets ?? [];
  if (bundled.length === 0 || status !== 'ready') return [];
  const hookState = hookSettings?.hook_state?.summary ?? codexPluginHooks?.hook_state?.summary ?? {};
  const hookStateHint = hookState.expected_disabled > 0
    ? ` Current Codex config reports ${hookState.expected_disabled}/${hookState.expected} expected bundled hook entries disabled; enable them in /hooks before attesting.`
    : '';
  return [{
    id: 'codex-hook-review',
    host: 'codex',
    status: 'manual_check',
    reason: codexPluginHooks?.feature_flags?.plugin_hooks_stage === 'removed'
      ? 'Codex plugin hooks are packaged and generic [features].hooks is enabled (plugin_hooks removed), but runtime:settings cannot verify active-session hook review/trust state.'
      : 'Codex plugin hooks are packaged and plugin_hooks is enabled, but runtime:settings cannot verify active-session hook review/trust state.',
    environment: 'Open the active Codex session for this repository.',
    commands: ['/hooks'],
    verify: `Review/trust bundled hooks for ${bundled.join(', ')} (${targets.length} review target(s)); if /hooks shows "New hook - review required", review each new hook first. Do not attest from /hooks Installed counts alone, including Active=0 output.${hookStateHint} Then run runtime:settings --attest-codex-hook-review and rerun runtime:doctor.`,
    review_targets: targets,
  }];
}

function buildCodexHookReviewAttestation({ codexPluginHooks, hookSettings, plugins, requested, attestedAt }) {
  const bundled = hookSettings?.packaged_plugins?.bundled ?? codexPluginHooks?.summary?.bundled_plugins ?? [];
  const manifestExposed = hookSettings?.packaged_plugins?.manifest_exposed ?? codexPluginHooks?.summary?.manifest_exposed_plugins ?? [];
  const status = hookSettings?.status ?? codexPluginHooks?.status ?? 'unknown';
  const pluginVersions = {};
  for (const pluginName of bundled) {
    const plugin = plugins?.[pluginName];
    pluginVersions[pluginName] = plugin?.source_version ?? null;
  }
  const base = {
    mode: requested ? 'operator-attestation' : 'not_recorded',
    requested: Boolean(requested),
    attested: false,
    status: requested ? 'blocked' : 'not_recorded',
    host: 'codex',
    command: '/hooks',
    attested_at: requested ? attestedAt : null,
    bundled_plugins: bundled,
    manifest_exposed_plugins: manifestExposed,
    plugin_versions: pluginVersions,
    review_targets: hookSettings?.review_targets ?? [],
    plugin_hooks_enabled: codexPluginHooks?.feature_flags?.plugin_hooks === true,
    plugin_hooks_stage: codexPluginHooks?.feature_flags?.plugin_hooks_stage ?? null,
    assertion: requested
      ? 'operator confirms /hooks was opened in the active Codex session and all listed bundled agentic-plugins hook review targets were reviewed/trusted'
      : null,
    reason: requested
      ? null
      : 'run runtime:settings --attest-codex-hook-review after reviewing/trusting bundled hooks with /hooks in the active Codex session',
    limits: [
      'This is an operator attestation artifact, not host-native proof of Codex trust state.',
      '/hooks Installed counts are packaging evidence only; Active=0 output or no trusted-active indication is not enough to attest.',
      'The attestation is considered current only while the hook-bearing plugin set and source versions match the observed checkout.',
      'Re-run /hooks and refresh this attestation after hook-bearing plugin upgrades or hook packaging changes.',
    ],
  };
  if (!requested) return base;
  if (status !== 'ready') {
    return {
      ...base,
      status: 'blocked',
      reason: `Codex plugin hooks are not ready for attestation (status=${status}).`,
    };
  }
  if (bundled.length === 0) {
    return {
      ...base,
      status: 'blocked',
      reason: 'No bundled Codex plugin hooks were observed for attestation.',
    };
  }
  const disabledExpected = hookSettings?.hook_state?.summary?.expected_disabled ?? codexPluginHooks?.hook_state?.summary?.expected_disabled ?? 0;
  const expected = hookSettings?.hook_state?.summary?.expected ?? codexPluginHooks?.hook_state?.summary?.expected ?? 0;
  if (disabledExpected > 0) {
    return {
      ...base,
      status: 'blocked',
      reason: `Codex hook review cannot be attested while ${disabledExpected}/${expected} expected bundled hook entries are disabled in Codex hook state. Open /hooks, enable/trust them, then rerun attestation.`,
    };
  }
  return {
    ...base,
    attested: true,
    status: 'attested',
    reason: null,
  };
}

function mergeManualFollowups(...groups) {
  const byId = new Map();
  for (const group of groups) {
    for (const followup of group ?? []) {
      const existing = byId.get(followup.id);
      if (!existing) {
        byId.set(followup.id, {
          ...followup,
          commands: uniqueStrings(followup.commands ?? []),
        });
      } else {
        existing.commands = uniqueStrings([...(existing.commands ?? []), ...(followup.commands ?? [])]);
      }
    }
  }
  return Array.from(byId.values());
}

function claudePluginCommand(args) {
  if (!Array.isArray(args) || args[0] !== 'plugin') return null;
  return ['claude', ...args].join(' ');
}

function claudeCommandDisplay(command) {
  if (typeof command !== 'string') return null;
  const match = command.match(/^(claude\s+plugin\s+.+)$/);
  return match ? match[1] : null;
}

function uniqueStrings(values) {
  return Array.from(new Set(values));
}

function classifyPluginManagementPlan({ recommendation, hostFilter, clis }) {
  if (hostFilter !== 'all' && recommendation.host !== hostFilter) {
    return {
      status: 'skipped',
      executable: false,
      reason: `filtered by --plugin-management-host=${hostFilter}`,
    };
  }
  if (!EXECUTABLE_PLUGIN_ACTIONS.has(recommendation.action)) {
    return {
      status: 'manual',
      executable: false,
      reason: 'action is not in the plugin-management executor allowlist',
    };
  }
  if (!recommendation.argv?.command || !Array.isArray(recommendation.argv?.args)) {
    return {
      status: 'manual',
      executable: false,
      reason: 'recommendation has no argv command spec',
    };
  }
  const cli = clis[recommendation.host];
  if (cli?.status !== 'available') {
    return {
      status: 'blocked',
      executable: false,
      reason: `${recommendation.host} CLI is not available`,
    };
  }
  if (recommendation.host === 'claude' && ['unavailable', 'blocked'].includes(cli.plugin?.status)) {
    return {
      status: 'blocked',
      executable: false,
      reason: `claude plugin CLI is ${cli.plugin.status}`,
    };
  }
  if (
    recommendation.host === 'claude'
      && ['install-plugin', 'update-plugin'].includes(recommendation.action)
      && !cli.feature_surface?.plugin_install_command
  ) {
    return {
      status: 'blocked',
      executable: false,
      reason: 'claude plugin CLI install/update surface is not available',
    };
  }
  return {
    status: 'planned',
    executable: true,
    reason: 'allowlisted host-native plugin command',
  };
}

function classifyPluginManagementSemanticFailure({ plan, result, postVerify = null }) {
  if (!result.ok) return null;
  const text = `${result.error_code ?? ''}\n${result.error_message ?? ''}\n${result.stderr ?? ''}\n${result.stdout ?? ''}`.toLowerCase();
  if (plan.host === 'claude' && /(?:\/plugin|plugin) (?:isn't|is not) available in this environment/.test(text)) {
    return {
      error_code: 'HOST_PLUGIN_SURFACE_UNAVAILABLE',
      error_message: 'Claude plugin command is not available in this environment',
    };
  }
  // ADR-0035 §6 (C): a codex install that exited 0 but the read-only post-verify
  // list does not report it installed is a semantic failure, not a success.
  if (plan.host === 'codex' && plan.action === 'install-plugin' && postVerify && postVerify.installed !== true) {
    return {
      error_code: 'CODEX_INSTALL_NOT_VERIFIED',
      error_message: 'codex plugin add returned success but the plugin is not reported installed by codex plugin list',
    };
  }
  return null;
}

function sanitizeCommandResult({ result, startedAt, completedAt }) {
  const failure = result.ok ? null : classifyPluginManagementFailure(result);
  return {
    ok: Boolean(result.ok),
    exit_code: result.exit_code ?? null,
    error_code: result.error_code ?? null,
    timed_out: Boolean(result.timed_out),
    stdout_bytes: Buffer.byteLength(result.stdout ?? '', 'utf8'),
    stderr_bytes: Buffer.byteLength(result.stderr ?? '', 'utf8'),
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    duration_ms: Math.max(0, completedAt.getTime() - startedAt.getTime()),
    failure_type: failure?.type ?? null,
    retryable: failure?.retryable ?? false,
    retry_after: failure?.retry_after ?? null,
    doctor_hint: failure?.doctor_hint ?? null,
  };
}

function summarizePluginManagementPlans(plans) {
  const summary = {
    planned: 0,
    executed: 0,
    failed: 0,
    skipped: 0,
    blocked: 0,
    manual: 0,
    deduplicated: 0,
    failed_retryable: 0,
    failed_non_retryable: 0,
  };
  for (const plan of plans) {
    if (Object.hasOwn(summary, plan.status)) summary[plan.status] += 1;
    if (plan.status === 'failed' && plan.result?.retryable === true) summary.failed_retryable += 1;
    if (plan.status === 'failed' && plan.result?.retryable !== true) summary.failed_non_retryable += 1;
  }
  return summary;
}

function classifyPluginManagementFailure(result) {
  const errorCode = String(result.error_code ?? '').toUpperCase();
  const text = `${errorCode}\n${result.error_message ?? ''}\n${result.stderr ?? ''}\n${result.stdout ?? ''}`.toLowerCase();
  if (result.timed_out || errorCode === 'ETIMEDOUT') {
    return failureClass({
      type: 'timeout',
      retryable: true,
      retry_after: 'retry with a larger --plugin-management-timeout-ms or after host command load drops',
      doctor_hint: 'runtime:doctor can verify CLI availability before retrying plugin management',
    });
  }
  if (['ENOENT', 'ENOTDIR'].includes(errorCode)) {
    return failureClass({
      type: 'cli_unavailable',
      retryable: false,
      retry_after: 'install the missing host CLI before retrying',
      doctor_hint: 'runtime:doctor reports host CLI availability',
    });
  }
  if (errorCode === 'HOST_PLUGIN_SURFACE_UNAVAILABLE' || /(?:\/plugin|plugin) (?:isn't|is not) available in this environment/.test(text)) {
    return failureClass({
      type: 'host_plugin_surface_unavailable',
      retryable: false,
      retry_after: 'retry only from a Claude Code environment that supports claude plugin commands',
      doctor_hint: 'runtime:doctor reports host plugin cache state after settings execution',
    });
  }
  if (['EACCES', 'EPERM'].includes(errorCode) || /\b(permission denied|not permitted|operation not permitted|approval required|sandbox)\b/.test(text)) {
    return failureClass({
      type: 'permission_denied',
      retryable: false,
      retry_after: 'retry only after resolving host permission or sandbox policy outside runtime:settings',
      doctor_hint: 'runtime:doctor --sandbox-permission-probe reports read-only permission surface evidence',
    });
  }
  if (/\b(not logged in|login required|auth required|authentication required|unauthorized|forbidden|401|403)\b/.test(text)) {
    return failureClass({
      type: 'authentication_required',
      retryable: false,
      retry_after: 'authenticate the host CLI before retrying',
      doctor_hint: 'runtime:doctor reports host authentication state',
    });
  }
  if (/\b(enotfound|econnreset|econnrefused|ehostunreach|network|networkerror|dns|tls|socket|temporary failure)\b/.test(text)) {
    return failureClass({
      type: 'network',
      retryable: true,
      retry_after: 'retry after network or registry connectivity recovers',
      doctor_hint: 'runtime:doctor can re-check host CLI and plugin surface availability',
    });
  }
  if (/\b(rate limit|too many requests|429|temporarily unavailable|try again|busy)\b/.test(text)) {
    return failureClass({
      type: 'transient_host_failure',
      retryable: true,
      retry_after: 'retry after the host-imposed backoff or transient failure clears',
      doctor_hint: 'runtime:doctor can confirm the host CLI still responds before retrying',
    });
  }
  return failureClass({
    type: 'host_command_failed',
    retryable: false,
    retry_after: 'inspect the host-native plugin command outside runtime:settings before retrying',
    doctor_hint: 'runtime:doctor reads the latest settings artifact and reports this failure class',
  });
}

function failureClass({ type, retryable, retry_after, doctor_hint }) {
  return { type, retryable, retry_after, doctor_hint };
}

function applyPluginManagementResults(plugins, pluginManagement) {
  const byId = new Map(pluginManagement.plans.map((plan) => [plan.id, plan]));
  for (const plugin of Object.values(plugins)) {
    for (const recommendation of plugin.recommendations) {
      const plan = byId.get(recommendation.id);
      if (!plan) continue;
      recommendation.executable = plan.executable;
      recommendation.execution_status = plan.status;
      recommendation.executed = plan.executed;
      recommendation.result = plan.result;
    }
  }
}

function buildSettingsArtifactReport({ repoRoot, runId, written, executePluginManagement, executePluginCleanup, attestCodexHookReview }) {
  const settingsRoot = settingsArtifactRoot(repoRoot);
  const reportPath = runId ? settingsArtifactFile(repoRoot, runId) : null;
  const latestPath = resolve(settingsRoot, 'latest.json');
  const writesArtifact = executePluginManagement || executePluginCleanup || attestCodexHookReview;
  return {
    settings_execution: {
      schema_version: SETTINGS_EXECUTION_ARTIFACT_SCHEMA_VERSION,
      written,
      run_id: runId,
      run_pointer: reportPath ? pointer(repoRoot, dirname(reportPath)) : null,
      report_pointer: reportPath ? pointer(repoRoot, reportPath) : null,
      latest_pointer: writesArtifact ? pointer(repoRoot, latestPath) : null,
      reason: writesArtifact
        ? 'settings execution artifact is written for explicit settings execution or operator attestation'
        : 'no settings execution artifact is written unless an explicit settings executor flag is supplied',
    },
  };
}

async function writeSettingsExecutionArtifact({ repoRoot, runId, report, now }) {
  const validRunId = validateSettingsRunId(runId);
  const runDir = settingsRunDir(repoRoot, validRunId);
  await assertInside(settingsArtifactRoot(repoRoot), runDir);
  await mkdir(runDir, { recursive: true });
  const reportPath = settingsArtifactFile(repoRoot, validRunId);
  const latestPath = resolve(settingsArtifactRoot(repoRoot), 'latest.json');
  const failedCount = report.plugin_management.summary.failed
    + report.plugin_cleanup.summary.failed
    + report.plugin_cleanup.summary.blocked
    + (report.codex_hook_review.requested && report.codex_hook_review.status !== 'attested' ? 1 : 0);
  const status = failedCount > 0 ? 'failed' : 'completed';
  const artifact = {
    schema_version: SETTINGS_EXECUTION_ARTIFACT_SCHEMA_VERSION,
    runtime_version: RUNTIME_VERSION,
    run_id: validRunId,
    status,
    created_at: report.generated_at,
    updated_at: toIso(now),
    repo_root_pointer: '.',
    command: {
      execute_plugin_management: report.execute_plugin_management,
      execute_plugin_cleanup: report.execute_plugin_cleanup,
      plugin_management_host: report.plugin_management.host_filter,
      plugin_management_timeout_ms: report.plugin_management.timeout_ms,
      attest_codex_hook_review: report.attest_codex_hook_review,
      apply: report.apply,
      target: report.config.targets.filter((target) => target.selected).map((target) => target.kind),
    },
    plugin_management: report.plugin_management,
    plugin_cleanup: report.plugin_cleanup,
    codex_hook_review: report.codex_hook_review,
    summary: {
      overall_status: report.overall.status,
      executed: report.plugin_management.summary.executed,
      failed: report.plugin_management.summary.failed,
      failed_retryable: report.plugin_management.summary.failed_retryable,
      failed_non_retryable: report.plugin_management.summary.failed_non_retryable,
      plugin_cleanup_executed: report.plugin_cleanup.summary.executed,
      plugin_cleanup_failed: report.plugin_cleanup.summary.failed,
      plugin_cleanup_blocked: report.plugin_cleanup.summary.blocked,
      codex_hook_review_attested: Boolean(report.codex_hook_review?.attested),
    },
    failures: [
      ...extractPluginManagementFailures(report.plugin_management.plans),
      ...extractPluginCleanupFailures(report.plugin_cleanup.plans),
    ],
    doctor_integration: {
      status: 'readable_by_runtime_doctor',
      command: 'runtime:doctor --format json',
      detail: 'runtime:doctor reads the latest settings execution artifact and surfaces failed plugin-management retry classification.',
    },
    limits: [
      'Raw stdout and stderr are not stored in settings execution artifacts.',
      'Artifacts record command status, exit code, byte counts, timing, failure type, retryability, and doctor hints only.',
      'Artifacts do not authorize automatic retry, install, update, general uninstall, auth, sandbox, or permission mutation.',
    ],
  };
  await writeJson(reportPath, artifact);
  await writeJson(latestPath, {
    schema_version: `${SETTINGS_EXECUTION_ARTIFACT_SCHEMA_VERSION}-latest`,
    runtime_version: RUNTIME_VERSION,
    run_id: validRunId,
    status,
    updated_at: artifact.updated_at,
    report_pointer: pointer(repoRoot, reportPath),
    summary: artifact.summary,
  });
  return buildSettingsArtifactReport({
    repoRoot,
    runId: validRunId,
    written: true,
    executePluginManagement: report.execute_plugin_management,
    executePluginCleanup: report.execute_plugin_cleanup,
    attestCodexHookReview: report.attest_codex_hook_review,
  });
}

function extractPluginManagementFailures(plans) {
  return plans
    .filter((plan) => plan.status === 'failed')
    .map((plan) => ({
      id: plan.id,
      area: 'plugin-management',
      plugin: plan.plugin,
      host: plan.host,
      action: plan.action,
      command: plan.command,
      failure_type: plan.result?.failure_type ?? 'host_command_failed',
      retryable: plan.result?.retryable === true,
      retry_after: plan.result?.retry_after ?? null,
      doctor_hint: plan.result?.doctor_hint ?? null,
    }));
}

function extractPluginCleanupFailures(plans) {
  return plans
    .filter((plan) => ['failed', 'blocked'].includes(plan.status))
    .map((plan) => ({
      id: `${plan.plugin}:${plan.host}:${plan.action}`,
      area: 'plugin-cleanup',
      plugin: plan.plugin,
      host: plan.host,
      action: plan.action,
      command: plan.command,
      failure_type: plan.status === 'blocked' ? 'blocked' : plan.result?.failure_type ?? 'host_command_failed',
      retryable: plan.result?.retryable === true,
      retry_after: plan.result?.retry_after ?? plan.next_step ?? null,
      doctor_hint: plan.result?.doctor_hint ?? 'runtime:doctor reports retired or unknown plugin cleanup follow-ups',
    }));
}

function buildCompanionSettingPlans({ currentDirections, desiredConfig, configTargets, apply }) {
  const projection = buildConfigProjection(configTargets);
  return {
    contract_path: 'companions/contract.md --model / --effort',
    effective_mode: apply ? 'applied' : 'projected',
    resolution_order: [
      'repo-local .agentic-plugins/config.toml',
      'user-global ~/.agentic-plugins/config.toml',
      'host-native default',
    ],
    directions: {
      claude_to_codex: buildDirectionSettingPlan({
        label: 'Claude -> Codex',
        peer: 'codex',
        current: currentDirections.claude_to_codex,
        desiredConfig,
        projection,
        apply,
      }),
      codex_to_claude: buildDirectionSettingPlan({
        label: 'Codex -> Claude',
        peer: 'claude',
        current: currentDirections.codex_to_claude,
        desiredConfig,
        projection,
        apply,
      }),
    },
  };
}

function buildConfigProjection(configTargets) {
  const projection = {};
  for (const target of configTargets) {
    projection[target.kind] = {
      kind: target.kind,
      path: target.path,
      selected: target.selected,
      current_config: target.current_config,
      projected_config: target.projected_config,
    };
  }
  return projection;
}

function buildDirectionSettingPlan({ label, peer, current, desiredConfig, projection, apply }) {
  const modelKey = `${peer}_model`;
  const effortKey = `${peer}_effort`;
  const proposedModel = desiredConfig[modelKey] ?? desiredConfig.model ?? null;
  const proposedEffort = desiredConfig[effortKey] ?? desiredConfig.effort ?? null;
  const effectiveModel = buildEffectiveSetting({
    peer,
    kind: 'model',
    requestedKey: desiredConfig[modelKey] !== undefined ? modelKey : desiredConfig.model !== undefined ? 'model' : null,
    proposedValue: proposedModel,
    currentValue: current.model,
    projection,
  });
  const effectiveEffort = buildEffectiveSetting({
    peer,
    kind: 'effort',
    requestedKey: desiredConfig[effortKey] !== undefined ? effortKey : desiredConfig.effort !== undefined ? 'effort' : null,
    proposedValue: proposedEffort,
    currentValue: current.effort,
    projection,
  });
  const warnings = [effectiveModel.warning, effectiveEffort.warning].filter(Boolean);
  return {
    label,
    peer,
    config_keys: {
      model: modelKey,
      effort: effortKey,
      shared_model_fallback: 'model',
      shared_effort_fallback: 'effort',
    },
    current,
    proposed: {
      model: proposedModel,
      effort: proposedEffort,
    },
    effective: {
      mode: apply ? 'applied' : 'projected',
      model: effectiveModel,
      effort: effectiveEffort,
      warnings,
    },
    recommendation: proposedModel || proposedEffort
      ? `Write ${[proposedModel ? modelKey : null, proposedEffort ? effortKey : null].filter(Boolean).join(' and ')} or shared model/effort defaults to agentic-plugins config.`
      : `No value requested; pass --${peer}-model/--${peer}-effort or shared --model/--effort to propose ${modelKey}/${effortKey}.`,
  };
}

function buildEffectiveSetting({ peer, kind, requestedKey, proposedValue, currentValue, projection }) {
  const projected = resolveProjectedSetting({
    keys: [`${peer}_${kind}`, kind],
    projection,
  });
  const status = proposedValue === null
    ? 'unchanged'
    : projected.value === proposedValue
      ? 'effective'
      : 'shadowed';
  const warning = status === 'shadowed'
    ? [
      `${peer}_${kind} request ${requestedKey}=${proposedValue} is shadowed by ${projected.source}`,
      'choose a higher-precedence target/key or remove the shadowing config entry',
    ].join('; ')
    : null;
  return {
    value: projected.value,
    source: projected.source,
    key: projected.key,
    target: projected.target,
    path: projected.path,
    status,
    requested_key: requestedKey,
    requested_value: proposedValue,
    current_value: currentValue?.value ?? null,
    current_source: currentValue?.source ?? null,
    warning,
  };
}

function resolveProjectedSetting({ keys, projection }) {
  for (const targetKind of ['repo', 'user']) {
    const target = projection[targetKind];
    if (!target) continue;
    for (const key of keys) {
      const value = target.projected_config[key];
      if (value) {
        return {
          value,
          source: `${targetKind} config ${key}`,
          key,
          target: targetKind,
          path: target.path,
        };
      }
    }
  }
  return {
    value: null,
    source: 'host-native default',
    key: null,
    target: null,
    path: null,
  };
}

function buildHookSettingsPlan({ codexPluginHooks, plugins = {} }) {
  const hookReport = codexPluginHooks ?? {
    status: 'unknown',
    feature_flags: {},
    summary: { bundled_plugins: [], manifest_exposed_plugins: [], default_file_only_plugins: [] },
    recommendations: [],
  };
  // Read/diagnosis surface only: runtime:settings does not write Codex host
  // config (the former --apply-codex-plugin-hooks executor was removed per
  // ADR-0035 §6). Doctor recommendations pass through as non-executable advice.
  const recommendations = (hookReport.recommendations ?? []).map((recommendation) => ({
    area: 'hooks',
    host: recommendation.host ?? 'codex',
    action: recommendation.action,
    severity: 'warning',
    executable: false,
    executed: false,
    detail: recommendation.detail,
    next_step: recommendation.next_step ?? null,
  }));
  return {
    status: hookReport.status,
    feature_flags: hookReport.feature_flags,
    packaged_plugins: {
      bundled: hookReport.summary?.bundled_plugins ?? [],
      manifest_exposed: hookReport.summary?.manifest_exposed_plugins ?? [],
      default_file_only: hookReport.summary?.default_file_only_plugins ?? [],
      command_warnings: hookReport.summary?.command_warning_plugins ?? [],
    },
    hook_state: hookReport.hook_state ?? null,
    review_targets: buildCodexHookReviewTargets({ codexPluginHooks: hookReport, plugins }),
    recommendations,
  };
}

function buildCodexHookReviewTargets({ codexPluginHooks, plugins }) {
  const targets = [];
  for (const pluginName of codexPluginHooks?.summary?.bundled_plugins ?? []) {
    const effective = codexPluginHooks?.plugin_entries?.[pluginName]?.effective ?? {};
    const hooksFile = effective.hooks_file ?? {};
    const commandAnalysis = hooksFile.command_analysis ?? {};
    targets.push({
      plugin: pluginName,
      version: plugins?.[pluginName]?.source_version ?? null,
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

function buildTopLevelRecommendations({ clis, plugins, pluginCleanup, desiredConfig, companionSettings, hookSettings }) {
  const recommendations = [];
  for (const [name, cli] of Object.entries(clis)) {
    if (cli.status !== 'available') {
      recommendations.push({
        area: 'cli',
        host: name,
        action: 'install-host-cli',
        executable: false,
        executed: false,
        detail: cli.install_plan?.next_step ?? DEFAULT_HOST_INSTALL_COMMANDS[name],
      });
    }
    if (['manual_required', 'manual_check'].includes(cli.auth_plan?.status)) {
      recommendations.push({
        area: 'auth',
        host: name,
        action: cli.auth_plan.status === 'manual_required' ? 'authenticate-host-cli' : 'verify-host-auth',
        severity: 'warning',
        executable: false,
        executed: false,
        command: cli.auth_plan.command,
        detail: cli.auth_plan.next_step,
      });
    }
  }
  for (const plugin of Object.values(plugins)) {
    for (const recommendation of plugin.recommendations) {
      recommendations.push({ area: 'plugin', ...recommendation });
    }
  }
  for (const plan of pluginCleanup?.plans ?? []) {
    recommendations.push({
      area: 'plugin-cleanup',
      host: plan.host,
      plugin: plan.plugin,
      action: plan.action,
      severity: plan.severity,
      executable: plan.executable,
      executed: plan.executed,
      command: plan.command,
      detail: plan.detail,
      next_step: plan.next_step,
    });
  }
  if (Object.keys(desiredConfig).length === 0) {
    recommendations.push({
      area: 'config',
      executed: false,
      detail: 'No config writes planned. Use --model/--effort or --claude-model/--codex-model with optional --apply.',
    });
  }
  for (const warning of collectCompanionSettingWarnings(companionSettings)) {
    recommendations.push({
      area: 'config',
      executed: false,
      detail: warning,
    });
  }
  for (const recommendation of hookSettings?.recommendations ?? []) {
    recommendations.push(recommendation);
  }
  return recommendations;
}

function summarizeSettings(report) {
  const writeCount = report.config.targets.reduce((sum, target) => sum + target.planned_writes.length, 0);
  const appliedCount = report.config.targets.filter((target) => target.applied).length;
  const missingCli = Object.values(report.clis).filter((cli) => cli.status !== 'available').length;
  const settingWarnings = collectCompanionSettingWarnings(report.companion_settings).length;
  const hookWarnings = (report.hook_settings?.recommendations ?? []).filter((rec) => rec.severity === 'warning').length;
  const authWarnings = Object.values(report.clis).filter((cli) => ['manual_required', 'manual_check'].includes(cli.auth_plan?.status)).length;
  const pluginManagementFailed = report.plugin_management.summary.failed;
  const pluginCleanupWarnings = (report.plugin_cleanup?.summary?.manual_required ?? 0)
    + (report.plugin_cleanup?.summary?.blocked ?? 0)
    + (report.plugin_cleanup?.summary?.failed ?? 0);
  const hookReviewWarnings = report.codex_hook_review?.requested && report.codex_hook_review.status !== 'attested' ? 1 : 0;
  return {
    status: missingCli > 0 || settingWarnings > 0 || hookWarnings > 0 || hookReviewWarnings > 0 || authWarnings > 0 || pluginManagementFailed > 0 || pluginCleanupWarnings > 0 ? 'warning' : 'pass',
    planned_config_writes: writeCount,
    applied_config_targets: appliedCount,
    plugin_recommendations: Object.values(report.plugins).reduce((sum, plugin) => sum + plugin.recommendations.length, 0),
    setting_warnings: settingWarnings,
    hook_warnings: hookWarnings,
    hook_review_warnings: hookReviewWarnings,
    auth_warnings: authWarnings,
    plugin_cleanup_warnings: pluginCleanupWarnings,
    plugin_management_executed: report.plugin_management.summary.executed,
    plugin_management_failed: pluginManagementFailed,
  };
}

function collectCompanionSettingWarnings(companionSettings) {
  const warnings = [];
  for (const direction of Object.values(companionSettings.directions)) {
    warnings.push(...direction.effective.warnings);
  }
  return warnings;
}

export function formatText(report) {
  const lines = [];
  lines.push(`runtime:settings ${report.runtime_version} (${formatSettingsMode(report)})`);
  lines.push(`repo: ${report.repo_root}`);
  lines.push(`dry-run: ${report.dry_run}`);
  lines.push('');
  lines.push('Mutation Boundary');
  lines.push(`- writes: ${report.mutation_boundary.writes_allowed}`);
  for (const forbidden of report.mutation_boundary.forbidden) lines.push(`- forbidden: ${forbidden}`);
  lines.push('');
  lines.push('Host CLIs');
  for (const name of ['claude', 'codex']) {
    const cli = report.clis[name];
    lines.push(`- ${name}: ${cli.status}; version=${cli.version.text || cli.version.status}; auth=${cli.auth?.status ?? 'unknown'}`);
    if (cli.recommendation) lines.push(`  recommendation: ${cli.recommendation}`);
    if (cli.install_plan?.status === 'manual_required') {
      lines.push(`  install-plan: ${cli.install_plan.status}; executable=${cli.install_plan.executable}; next-step=${cli.install_plan.next_step}`);
    }
    if (['manual_required', 'manual_check'].includes(cli.auth_plan?.status)) {
      lines.push(`  auth-plan: ${cli.auth_plan.status}; executable=${cli.auth_plan.executable}; command=${cli.auth_plan.command ?? 'n/a'}; next-step=${cli.auth_plan.next_step}`);
    }
  }
  lines.push('');
  lines.push('Plugins');
  for (const name of PLUGIN_NAMES) {
    const plugin = report.plugins[name];
    const codexTmp = plugin.marketplace_cache?.codex_tmp_marketplace;
    lines.push(`- ${name}: ${plugin.status}; source=${plugin.source_version ?? 'n/a'}; codex-marketplace-cache=${codexTmp?.version ?? 'n/a'}; recommendations=${plugin.recommendations.length}`);
    for (const recommendation of plugin.recommendations) {
      const command = recommendation.command ? ` command=${recommendation.command}` : '';
      const executionStatus = recommendation.execution_status ? ` status=${recommendation.execution_status};` : '';
      lines.push(`  ${recommendation.host}: ${recommendation.action};${executionStatus} executed=${recommendation.executed};${command}`);
    }
  }
  lines.push('');
  lines.push('Plugin Management');
  lines.push(`- mode: ${report.plugin_management.mode}; requested=${report.plugin_management.requested}; host-filter=${report.plugin_management.host_filter}; timeout-ms=${report.plugin_management.timeout_ms}`);
  if (report.plugin_command_surface?.claude) {
    const surface = report.plugin_command_surface.claude;
    lines.push(`- claude command surface: mode=${surface.mode}; install=${Boolean(surface.supports.install_plugin)}; update=${Boolean(surface.supports.update_plugin)}; uninstall=${Boolean(surface.supports.uninstall_plugin)}; list=${Boolean(surface.supports.list_plugin)}; materialization=${surface.materialization.status}`);
    if (surface.observed_surfaces) {
      lines.push(`  observed: cli-plugin=${surface.observed_surfaces.cli_plugin}; slash-plugin=${surface.observed_surfaces.slash_plugin}`);
    }
  }
  if (report.plugin_command_surface?.codex) {
    const surface = report.plugin_command_surface.codex;
    lines.push(`- codex command surface: mode=${surface.mode}; plugin-add=${Boolean(surface.supports.install_plugin)}; plugin-list=${Boolean(surface.supports.list_plugin)}; plugin-remove=${Boolean(surface.supports.remove_plugin)}; marketplace-add=${Boolean(surface.supports.marketplace_add)}; marketplace-list=${Boolean(surface.supports.marketplace_list)}; marketplace-upgrade=${Boolean(surface.supports.marketplace_upgrade)}; marketplace-remove=${Boolean(surface.supports.marketplace_remove)}; materialization=${surface.materialization.status}`);
  }
  lines.push(`- summary: planned=${report.plugin_management.summary.planned}; executed=${report.plugin_management.summary.executed}; failed=${report.plugin_management.summary.failed}; retryable-failed=${report.plugin_management.summary.failed_retryable}; non-retryable-failed=${report.plugin_management.summary.failed_non_retryable}; blocked=${report.plugin_management.summary.blocked}; manual=${report.plugin_management.summary.manual}; deduplicated=${report.plugin_management.summary.deduplicated}; skipped=${report.plugin_management.summary.skipped}`);
  for (const plan of report.plugin_management.plans) {
    const command = plan.command ? ` command=${plan.command}` : '';
    lines.push(`- ${plan.plugin}/${plan.host}: ${plan.action}; status=${plan.status}; executable=${plan.executable}; executed=${plan.executed};${command}`);
    if (plan.reason) lines.push(`  reason: ${plan.reason}`);
    if (plan.next_step) lines.push(`  next: ${plan.next_step}`);
    if (plan.result) {
      lines.push(`  result: ok=${plan.result.ok}; exit=${plan.result.exit_code ?? '<none>'}; stdout-bytes=${plan.result.stdout_bytes}; stderr-bytes=${plan.result.stderr_bytes}; timed-out=${plan.result.timed_out}; failure-type=${plan.result.failure_type ?? '<none>'}; retryable=${plan.result.retryable}`);
      if (plan.result.retry_after) lines.push(`  retry-after: ${plan.result.retry_after}`);
      if (plan.result.doctor_hint) lines.push(`  doctor: ${plan.result.doctor_hint}`);
    }
  }
  if (report.plugin_management.manual_followups?.length > 0) {
    lines.push('');
    lines.push('Manual Follow-ups');
    for (const followup of report.plugin_management.manual_followups) {
      lines.push(`- ${followup.id}: host=${followup.host}; status=${followup.status}`);
      lines.push(`  reason: ${followup.reason}`);
      lines.push(`  environment: ${followup.environment}`);
      for (const command of followup.commands ?? []) {
        lines.push(`  command: ${command}`);
      }
      lines.push(`  verify: ${followup.verify}`);
    }
  }
  if (report.plugin_cleanup?.plans?.length > 0) {
    lines.push('');
    lines.push('Plugin Cleanup');
    lines.push(`- mode: ${report.plugin_cleanup.mode}; requested=${report.plugin_cleanup.requested}; timeout-ms=${report.plugin_cleanup.timeout_ms}`);
    lines.push(`- summary: planned=${report.plugin_cleanup.summary.planned}; executable=${report.plugin_cleanup.summary.executable}; executed=${report.plugin_cleanup.summary.executed}; failed=${report.plugin_cleanup.summary.failed}; blocked=${report.plugin_cleanup.summary.blocked}; manual-required=${report.plugin_cleanup.summary.manual_required}`);
    for (const plan of report.plugin_cleanup.plans) {
      lines.push(`- ${plan.plugin}/${plan.host}: ${plan.action}; status=${plan.status}; executable=${plan.executable}; executed=${plan.executed}; command=${plan.command}`);
      if (plan.reason) lines.push(`  reason: ${plan.reason}`);
      lines.push(`  next: ${plan.next_step}`);
      if (plan.result) {
        lines.push(`  result: ok=${plan.result.ok}; exit=${plan.result.exit_code ?? '<none>'}; stdout-bytes=${plan.result.stdout_bytes}; stderr-bytes=${plan.result.stderr_bytes}; timed-out=${plan.result.timed_out}; failure-type=${plan.result.failure_type ?? '<none>'}; retryable=${plan.result.retryable}`);
        if (plan.result.retry_after) lines.push(`  retry-after: ${plan.result.retry_after}`);
        if (plan.result.doctor_hint) lines.push(`  doctor: ${plan.result.doctor_hint}`);
      }
    }
  }
  lines.push('');
  lines.push('Codex Plugin Hooks');
  lines.push(`- status=${report.hook_settings.status}; bundled=${report.hook_settings.packaged_plugins.bundled.join(',') || 'none'}; manifest-exposed=${report.hook_settings.packaged_plugins.manifest_exposed.join(',') || 'none'}; default-file-only=${report.hook_settings.packaged_plugins.default_file_only.join(',') || 'none'}; command-warnings=${report.hook_settings.packaged_plugins.command_warnings.join(',') || 'none'}`);
  if (report.hook_settings.hook_state) {
    const state = report.hook_settings.hook_state;
    lines.push(`- hook-state: config=${state.config_status}; expected=${state.summary.expected}; enabled=${state.summary.expected_enabled}; disabled=${state.summary.expected_disabled}; missing=${state.summary.expected_missing}; untrusted=${state.summary.expected_untrusted}; unexpected-agentic=${state.summary.unexpected_agentic_entries}`);
    for (const entry of state.disabled_expected ?? []) {
      lines.push(`  disabled-hook-state: ${entry.plugin}; event=${entry.event}; path=${entry.hooks_path}; ids=${entry.ids.join(',') || 'none'}`);
    }
  }
  const hookFlags = report.hook_settings.feature_flags ?? {};
  if (hookFlags.plugin_hooks_stage === 'removed') {
    lines.push('- plugin-hooks: removed on this Codex; plugin hooks load via generic [features].hooks (default on) + /hooks trust');
  } else {
    lines.push(`- plugin-hooks: legacy gate [features].plugin_hooks=${hookFlags.plugin_hooks ?? '<unknown>'}; runtime:settings does not write Codex host config (ADR-0035 §6) — enable it manually in ~/.codex/config.toml if needed, then review/trust with /hooks`);
  }
  for (const recommendation of report.hook_settings.recommendations) {
    const command = recommendation.command ? ` command=${recommendation.command}` : '';
    lines.push(`- ${recommendation.host}: ${recommendation.action}; executable=${recommendation.executable}; executed=${recommendation.executed};${command}`);
    lines.push(`  detail: ${recommendation.detail}`);
    if (recommendation.next_step) lines.push(`  next: ${recommendation.next_step}`);
  }
  if (report.codex_hook_review) {
    const review = report.codex_hook_review;
    lines.push('');
    lines.push('Codex Hook Review');
    lines.push(`- mode=${review.mode}; requested=${review.requested}; status=${review.status}; attested=${review.attested}; command=${review.command}`);
    lines.push(`- bundled=${review.bundled_plugins.join(',') || 'none'}; plugin-hooks-enabled=${review.plugin_hooks_enabled}${review.plugin_hooks_stage === 'removed' ? ' (removed; generic [features].hooks gates plugin hooks)' : ''}; attested-at=${review.attested_at ?? '<none>'}`);
    if (Object.keys(review.plugin_versions ?? {}).length > 0) {
      lines.push(`- plugin-versions: ${Object.entries(review.plugin_versions).map(([name, version]) => `${name}@${version ?? 'unknown'}`).join(', ')}`);
    }
    for (const target of review.review_targets ?? []) {
      lines.push(`- review-target: ${target.plugin}@${target.version ?? 'unknown'}; origin=${target.origin ?? '<unknown>'}; manifest-exposed=${target.manifest_exposed}; path=${target.hooks_path ?? '<unknown>'}; events=${target.events.join(',') || 'none'}; handlers=${target.handler_count}; commands=${target.command_count}; warnings=${target.command_warnings.join(',') || 'none'}`);
      for (const command of target.commands ?? []) {
        lines.push(`  hook-command: ${command}`);
      }
      lines.push(`  expected: ${target.expected_review}`);
    }
    if (review.requested && review.assertion) lines.push(`- assertion: ${review.assertion}`);
    if (review.requested && Array.isArray(review.limits)) {
      for (const limit of review.limits) lines.push(`- limit: ${limit}`);
    }
    if (review.reason) lines.push(`- next: ${review.reason}`);
  }
  if (report.artifacts?.settings_execution) {
    const artifact = report.artifacts.settings_execution;
    lines.push('');
    lines.push('Execution Artifact');
    lines.push(`- written: ${artifact.written}; run-id=${artifact.run_id ?? '<none>'}`);
    if (artifact.report_pointer) lines.push(`- report: ${artifact.report_pointer}`);
    if (artifact.latest_pointer) lines.push(`- latest: ${artifact.latest_pointer}`);
  }
  lines.push('');
  lines.push('Config Proposals');
  for (const target of report.config.targets) {
    lines.push(`- ${target.kind}: ${target.path}; ${target.status}; selected=${target.selected}; writes=${target.planned_writes.length}; applied=${target.applied}`);
    for (const write of target.planned_writes) {
      lines.push(`  ${write.op}: ${write.key} ${write.before ?? '<unset>'} -> ${write.after}`);
    }
    if (target.planned_writes.length === 0) lines.push(`  note: ${target.message}`);
  }
  lines.push('');
  lines.push('Companion Model / Effort');
  for (const key of ['claude_to_codex', 'codex_to_claude']) {
    const direction = report.companion_settings.directions[key];
    lines.push(`- ${direction.label}: ${direction.config_keys.model}/${direction.config_keys.effort}; proposed model=${direction.proposed.model ?? '<none>'}; effort=${direction.proposed.effort ?? '<none>'}`);
    lines.push(`  effective-${direction.effective.mode}: model=${direction.effective.model.value ?? '<host-default>'} (${direction.effective.model.source}); effort=${direction.effective.effort.value ?? '<host-default>'} (${direction.effective.effort.source})`);
    for (const warning of direction.effective.warnings) lines.push(`  warning: ${warning}`);
  }
  lines.push('');
  lines.push('Limits');
  for (const limit of report.limits) lines.push(`- ${limit}`);
  return `${lines.join('\n')}\n`;
}

function formatSettingsMode(report) {
  const modes = [];
  if (report.config_apply) modes.push('config-apply');
  if (report.execute_plugin_management) modes.push('plugin-management');
  if (report.execute_plugin_cleanup) modes.push('plugin-cleanup');
  if (report.attest_codex_hook_review) modes.push('codex-hook-review');
  return modes.length > 0 ? modes.join('+') : 'dry-run';
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

async function readTextIfExists(path) {
  try {
    const text = await readFile(path, 'utf8');
    return { ok: true, path, text };
  } catch (err) {
    return { ok: false, path, reason: err.code ?? err.message };
  }
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function validateSettingsRunId(runId) {
  if (!SETTINGS_RUN_ID_RE.test(runId)) {
    throw new Error('Invalid --run-id; expected settings-YYYYMMDDTHHMMSSZ-abcdef');
  }
  return runId;
}

function makeSettingsRunId(now) {
  const stamp = toIso(now).replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `settings-${stamp}-${randomBytes(3).toString('hex')}`;
}

function toIso(value) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function settingsArtifactRoot(repoRoot) {
  return resolve(repoRoot, '.agentic-plugins', 'runs', 'settings');
}

function settingsRunDir(repoRoot, runId) {
  return resolve(settingsArtifactRoot(repoRoot), validateSettingsRunId(runId));
}

function settingsArtifactFile(repoRoot, runId) {
  return resolve(settingsRunDir(repoRoot, runId), 'settings.json');
}

async function assertInside(root, candidate) {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  const rel = relative(rootPath, candidatePath);
  if (rel.startsWith('..') || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`Artifact path escapes settings root: ${candidate}`);
  }
}

function pointer(repoRoot, path) {
  const rel = relative(repoRoot, path).split(sep).join('/');
  return rel || basename(path);
}

function usage() {
  return [
    'Usage: settings.mjs [--repo-root <path>] [--format text|json] [--host auto|claude|codex]',
    '  [--target repo|user|both] [--model <id>] [--effort <level>]',
    '  [--claude-model <id>] [--claude-effort <level>] [--codex-model <id>] [--codex-effort <level>]',
    '  [--apply] [--attest-codex-hook-review] [--execute-plugin-management] [--execute-plugin-cleanup] [--plugin-management-host all|claude|codex] [--plugin-management-timeout-ms <n>] [--run-id <settings-run-id>]',
    '',
  ].join('\n');
}

export function parseArgs(argv) {
  const opts = {
    repoRoot: process.cwd(),
    format: 'text',
    host: 'auto',
    target: 'both',
    apply: false,
    executePluginManagement: false,
    executePluginCleanup: false,
    attestCodexHookReview: false,
    pluginManagementHost: 'all',
    pluginManagementTimeoutMs: DEFAULT_PLUGIN_MANAGEMENT_TIMEOUT_MS,
    runId: null,
    desired: {},
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
    } else if (arg === '--target') {
      opts.target = requireValue(argv, ++i, arg);
      if (!TARGETS.has(opts.target)) throw new Error('--target must be repo, user, or both');
    } else if (arg === '--apply') {
      opts.apply = true;
    } else if (arg === '--attest-codex-hook-review') {
      opts.attestCodexHookReview = true;
    } else if (arg === '--execute-plugin-management') {
      opts.executePluginManagement = true;
    } else if (arg === '--execute-plugin-cleanup') {
      opts.executePluginCleanup = true;
    } else if (arg === '--plugin-management-host') {
      opts.pluginManagementHost = requireValue(argv, ++i, arg);
      if (!PLUGIN_MANAGEMENT_HOSTS.has(opts.pluginManagementHost)) throw new Error('--plugin-management-host must be all, claude, or codex');
    } else if (arg === '--plugin-management-timeout-ms') {
      opts.pluginManagementTimeoutMs = parsePositiveInt(requireValue(argv, ++i, arg), arg);
    } else if (arg === '--run-id') {
      opts.runId = validateSettingsRunId(requireValue(argv, ++i, arg));
    } else if (arg === '--model') {
      opts.desired.model = requireValue(argv, ++i, arg);
    } else if (arg === '--effort') {
      opts.desired.effort = requireValue(argv, ++i, arg);
    } else if (arg === '--claude-model') {
      opts.desired.claude_model = requireValue(argv, ++i, arg);
    } else if (arg === '--claude-effort') {
      opts.desired.claude_effort = requireValue(argv, ++i, arg);
    } else if (arg === '--codex-model') {
      opts.desired.codex_model = requireValue(argv, ++i, arg);
    } else if (arg === '--codex-effort') {
      opts.desired.codex_effort = requireValue(argv, ++i, arg);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  opts.desired = normalizeDesiredConfig(opts.desired);
  return opts;
}

function parsePositiveInt(value, flag) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
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
  const report = await runSettings(opts);
  if (opts.format === 'json') {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(formatText(report));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`runtime:settings failed: ${err.stack ?? err.message}\n`);
    process.exit(1);
  });
}
