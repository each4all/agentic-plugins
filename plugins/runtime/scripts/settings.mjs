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

import { PLUGIN_NAMES, RUNTIME_VERSION, runCommand, runDoctor, codexPerPluginVerbs, collectUsageRecordSources } from './doctor.mjs';
import { resolvePeerExecutionContext } from './lib/peer-execution-context.mjs';
import { semverCompare } from './lib/semver.mjs';
import {
  CONFIG_KEYS,
  CONFIG_KEY_FAMILIES,
  NOTIFY_KEY_DEFAULTS,
  normalizeConfigKey,
  parseRuntimeConfigToml,
  validateConfigValue,
} from './lib/runtime-config.mjs';
import { sanitizeValue } from './lib/permission-sanitize.mjs';
import { learnFromSources } from './lib/permission-usage-learner.mjs';
import { makeFragmentContract, makeModeRecommendation, worstGrade } from './lib/permission-advisor-core.mjs';
import { recordPermissionAdvisoryArtifact, makePermissionRunId } from './lib/permission-artifacts.mjs';
import { buildCodexNotificationPlan } from './lib/notification-plan.mjs';
import { buildEgressLauncherPlan } from './lib/egress-launcher-plan.mjs';
import { redactEgressCredentialFromEnv } from './lib/egress-config.mjs';

export const SETTINGS_SCHEMA_VERSION = 'runtime-settings-1.17';

// ADR-0038 settings-claude permission plan (M1): how many recent usage records to
// read per host, and a per-file byte cap, when building the dry-run plan.
const DEFAULT_PERMISSION_PLAN_MAX_FILES = 100;
const DEFAULT_PERMISSION_PLAN_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const SETTINGS_EXECUTION_ARTIFACT_SCHEMA_VERSION = 'runtime-settings-execution-artifact-1.1';
// The config-key contract — key families, notify channel/defaults, per-key
// validators, and the TOML read parser — lives in lib/runtime-config.mjs so
// the ADR-0040 §2 notify emitter consumes the OFFICIAL key surface without
// loading this plan pipeline. Re-exported here to keep the public settings
// API unchanged.
export {
  CONFIG_KEY_FAMILIES,
  CONFIG_KEYS,
  NOTIFY_CHANNELS,
  NOTIFY_KEY_DEFAULTS,
  parseRuntimeConfigToml,
} from './lib/runtime-config.mjs';

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
  // The two plugin-management modifiers stay ABSENT (undefined) until after
  // the probe-free conflict gate below — a value-comparison gate would let
  // `--skip-host-cli-probes --plugin-management-host all` through even though
  // the contract rejects the flag itself (settings-report-contract.md §1).
  pluginManagementHost = undefined,
  pluginManagementTimeoutMs = undefined,
  skipHostCliProbes = false,
  permissionPlan = false,
  permissionPlanMaxFiles = DEFAULT_PERMISSION_PLAN_MAX_FILES,
  permissionPlanMaxFileBytes = DEFAULT_PERMISSION_PLAN_MAX_FILE_BYTES,
  notificationPlan = false,
  egressLauncherPlan = false,
  runId = null,
} = {}) {
  if (!TARGETS.has(target)) throw new Error('--target must be repo, user, or both');
  // Probe-free conflict gate (settings-report-contract.md §1-§2) — MUST run
  // inside the exported API, on the RAW options, BEFORE any probe, run-id
  // normalization, config write, or artifact write. A flag is rejected iff
  // its effect consumes host-CLI probe evidence or it exclusively
  // parameterizes a rejected flag; presence (not value) is what conflicts.
  if (skipHostCliProbes) {
    const conflicts = [];
    if (executePluginManagement) conflicts.push('--execute-plugin-management consumes host-CLI probe evidence');
    if (executePluginCleanup) conflicts.push('--execute-plugin-cleanup consumes host-CLI probe evidence');
    if (attestCodexHookReview) conflicts.push('--attest-codex-hook-review consumes host-CLI probe evidence');
    if (pluginManagementHost !== undefined) conflicts.push('--plugin-management-host exclusively parameterizes the rejected plugin-management executor');
    if (pluginManagementTimeoutMs !== undefined) conflicts.push('--plugin-management-timeout-ms exclusively parameterizes the rejected plugin-management executor');
    if (runId !== null && runId !== undefined) conflicts.push('--run-id exclusively parameterizes the rejected settings execution artifact');
    if (conflicts.length > 0) {
      throw new Error(`--skip-host-cli-probes conflicts (plugins/runtime/docs/settings-report-contract.md §1): ${conflicts.join('; ')}`);
    }
  }
  const effectivePluginManagementHost = pluginManagementHost ?? 'all';
  const effectivePluginManagementTimeoutMs = pluginManagementTimeoutMs ?? DEFAULT_PLUGIN_MANAGEMENT_TIMEOUT_MS;
  if (!PLUGIN_MANAGEMENT_HOSTS.has(effectivePluginManagementHost)) throw new Error('--plugin-management-host must be all, claude, or codex');
  const resolvedRepoRoot = resolve(repoRoot);
  const resolvedHomeDir = resolve(homeDir);
  const startedAt = now.toISOString();
  const settingsExecutionRequested = executePluginManagement || executePluginCleanup || attestCodexHookReview;
  const settingsRunId = runId ? validateSettingsRunId(runId) : settingsExecutionRequested ? makeSettingsRunId(now) : null;
  const desiredConfig = normalizeDesiredConfig(desired);
  const commandRunner = runner ?? runCommand;

  // ADR-0041 §2b/§2c (Codex review MAJOR): the egress credential (TELEGRAM_BOT_TOKEN)
  // must NOT ride into subprocess probes. runDoctor spawns host CLIs with `env`, so a
  // retained/echoed child output — or an injected runner — could surface the token in
  // the settings report. Capture the real env for the launcher's in-process, read-only
  // PRESENCE check (it never spawns, never echoes the value), then strip the credential
  // from the `env` every subprocess (doctor, plugin management, cleanup) receives.
  const launcherEnv = env;
  env = redactEgressCredentialFromEnv(env);

  // Evidence-collection axis (settings-report-contract.md §2): probe-free
  // runs resolve model/effort + companion directions from the filesystem-only
  // peer execution context at the SAME pre-apply position runDoctor occupies,
  // so freshly-applied config values can never masquerade as "current".
  let doctor = null;
  let peerModelEffort = null;
  if (skipHostCliProbes) {
    const peerContext = await resolvePeerExecutionContext({
      repoRoot: resolvedRepoRoot,
      homeDir: resolvedHomeDir,
    });
    peerModelEffort = peerContext.model_effort;
  } else {
    doctor = await runDoctor({
      repoRoot: resolvedRepoRoot,
      homeDir: resolvedHomeDir,
      env,
      now,
      runner: commandRunner,
      format: 'json',
      host,
    });
  }

  const configPlans = await buildConfigPlans({
    repoRoot: resolvedRepoRoot,
    homeDir: resolvedHomeDir,
    target,
    desiredConfig,
  });

  if (apply) {
    await applyConfigPlans(configPlans);
  }

  let pluginPlans = null;
  let pluginManagement = null;
  let cliPlans = null;
  let pluginCleanup = null;
  let hookSettings = null;
  let codexHookReview = null;
  if (!skipHostCliProbes) {
    pluginPlans = buildPluginPlans(doctor.plugins, {
      codexPerPluginVerbList: codexPerPluginVerbs(doctor.clis?.codex?.feature_surface ?? {}),
    });
    pluginManagement = await buildPluginManagementPlan({
      plugins: pluginPlans,
      clis: doctor.clis,
      execute: executePluginManagement,
      hostFilter: effectivePluginManagementHost,
      runner: commandRunner,
      cwd: resolvedRepoRoot,
      env,
      timeoutMs: effectivePluginManagementTimeoutMs,
    });
    applyPluginManagementResults(pluginPlans, pluginManagement);
    cliPlans = buildCliPlans(doctor.clis);
    pluginCleanup = await buildPluginCleanupPlans({
      hostParityIssues: doctor.host_parity?.issues ?? [],
      clis: doctor.clis,
      execute: executePluginCleanup,
      runner: commandRunner,
      cwd: resolvedRepoRoot,
      env,
      timeoutMs: effectivePluginManagementTimeoutMs,
    });
  }

  const companionSettings = buildCompanionSettingPlans({
    currentDirections: skipHostCliProbes ? peerModelEffort.directions : doctor.model_effort.directions,
    desiredConfig,
    configTargets: configPlans.targets,
    apply,
  });
  const notifySettings = buildNotifySettingPlans({
    desiredConfig,
    configTargets: configPlans.targets,
    apply,
  });
  if (!skipHostCliProbes) {
    hookSettings = buildHookSettingsPlan({
      codexPluginHooks: doctor.codex_plugin_hooks,
      plugins: pluginPlans,
    });
    codexHookReview = buildCodexHookReviewAttestation({
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
  }

  // The same --permission-plan flag plans BOTH hosts (ADR-0038 §1 cross-host).
  // The orchestrator collects/learns once and writes ONE combined cross-host
  // advisory artifact shared by both sibling report sections.
  let permissionPlanSection = { requested: false, executed: false, status: 'not_requested' };
  let permissionPlanCodexSection = { requested: false, executed: false, status: 'not_requested' };
  if (permissionPlan) {
    const crossHostPlan = await buildCrossHostPermissionPlan({
      repoRoot: resolvedRepoRoot,
      homeDir: resolvedHomeDir,
      env,
      now,
      maxFiles: permissionPlanMaxFiles,
      maxFileBytes: permissionPlanMaxFileBytes,
    });
    permissionPlanSection = crossHostPlan.claude;
    permissionPlanCodexSection = crossHostPlan.codex;
  }

  // ADR-0040 §4 Codex notification-channel M1 plan: fragment render + plan
  // artifact only (its own runs/notification family; never host config).
  let notificationPlanSection = { requested: false, executed: false, status: 'not_requested' };
  if (notificationPlan) {
    notificationPlanSection = await buildCodexNotificationPlan({
      repoRoot: resolvedRepoRoot,
      homeDir: resolvedHomeDir,
      env,
      now,
    });
  }

  // ADR-0041 §12 first-class egress launcher: read-only activation-state +
  // prototype scan → per-machine activation runbook, recorded as an artifact
  // only. NEVER writes host config, ~/.agentic-plugins/config.local.toml, the
  // credential, or ~/.claude/settings.json (§2c: a launcher that wrote
  // activation would itself be the egress-activation vector §2c closed).
  let egressLauncherPlanSection = { requested: false, executed: false, status: 'not_requested' };
  if (egressLauncherPlan) {
    egressLauncherPlanSection = await buildEgressLauncherPlan({
      repoRoot: resolvedRepoRoot,
      homeDir: resolvedHomeDir,
      env: launcherEnv, // the launcher's read-only presence check needs the real env; subprocesses get the scrubbed one
      host,
      now,
    });
  }

  const report = {
    schema_version: SETTINGS_SCHEMA_VERSION,
    runtime_version: RUNTIME_VERSION,
    generated_at: startedAt,
    repo_root: resolvedRepoRoot,
    host,
    output_format: format,
    dry_run: !(apply || executePluginManagement || executePluginCleanup || attestCodexHookReview),
    // Evidence-collection discriminator (settings-report-contract.md §3) —
    // present in BOTH modes so a narrowed report is never distinguishable
    // only by what it lacks.
    report_scope: skipHostCliProbes ? 'local_plan' : 'full',
    host_cli_probes: skipHostCliProbes
      ? { status: 'skipped', flag: '--skip-host-cli-probes' }
      : { status: 'run', flag: null },
    section_presence: buildSectionPresence({ skipHostCliProbes, permissionPlan, notificationPlan, egressLauncherPlan }),
    apply,
    config_apply: apply,
    execute_plugin_management: executePluginManagement,
    execute_plugin_cleanup: executePluginCleanup,
    attest_codex_hook_review: attestCodexHookReview,
    mutation_boundary: {
      writes_allowed: mutationBoundaryWritesAllowed({ apply, executePluginManagement, executePluginCleanup, attestCodexHookReview, permissionPlan, notificationPlan, egressLauncherPlan }),
      allowed_paths: [
        ...configPlans.targets.filter((plan) => plan.selected).map((plan) => plan.path),
      ],
      allowed_plugin_management_actions: executePluginManagement
        ? Array.from(EXECUTABLE_PLUGIN_ACTIONS).sort()
        : [],
      allowed_plugin_cleanup_actions: executePluginCleanup
        ? Array.from(EXECUTABLE_PLUGIN_CLEANUP_ACTIONS).sort()
        : [],
      plugin_management_host_filter: effectivePluginManagementHost,
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
    plugin_command_surface: skipHostCliProbes ? null : doctor.plugin_command_surface,
    plugin_management: pluginManagement,
    hook_settings: hookSettings,
    codex_hook_review: codexHookReview,
    config: {
      resolution_order: skipHostCliProbes ? peerModelEffort.resolution_order : doctor.model_effort.resolution_order,
      key_families: CONFIG_KEY_FAMILIES,
      desired: desiredConfig,
      targets: configPlans.targets,
    },
    companion_settings: companionSettings,
    notify_settings: notifySettings,
    permission_plan: permissionPlanSection,
    permission_plan_codex: permissionPlanCodexSection,
    notification_plan: notificationPlanSection,
    egress_launcher_plan: egressLauncherPlanSection,
    artifacts: buildSettingsArtifactReport({
      repoRoot: resolvedRepoRoot,
      runId: settingsRunId,
      written: false,
      executePluginManagement,
      executePluginCleanup,
      attestCodexHookReview,
    }),
    // In local_plan mode this rebuilds from evaluated inputs only (config
    // hints + companion/notify warnings) — the probe-derived inputs are
    // empty, and section_presence marks the section 'local_only'.
    recommendations: buildTopLevelRecommendations({
      clis: cliPlans ?? {},
      plugins: pluginPlans ?? {},
      pluginCleanup,
      desiredConfig,
      companionSettings,
      notifySettings,
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
      'The permission plan (--permission-plan) reads the Claude allowlist read-only and writes only the agentic-plugins-owned advisory artifact; the .claude/settings.json fragment is emitted for the operator to apply, never written by runtime.',
      'The Codex permission plan (--permission-plan) reads ~/.codex/config.toml read-only and recommends safety-graded postures (approval_policy/sandbox_mode) + bounded project-trust as a config.toml fragment; never danger-full-access, never written by runtime.',
      'The notification plan (--notification-plan) reads the user-layer ~/.codex/config.toml read-only (mandatory notify read-check; wrapper-chaining preserves an existing notifier) and renders notify=/tui.notifications fragments + receiver scripts into an agentic-plugins-owned plan artifact; host config is never written and the receiver install is an explicit user action.',
      'The egress launcher plan (--egress-launcher-plan) reads the current egress activation state and the personal ~/.claude prototype hooks read-only and records a per-machine activation runbook in an agentic-plugins-owned artifact; it NEVER writes host config, ~/.agentic-plugins/config.local.toml, the credential, or ~/.claude/settings.json, and the credential value is never read (only its presence). Applying the plan is an explicit user action (ADR-0041 §2c/§12).',
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
    validateConfigValue(key, result[key]);
  }
  return result;
}

function normalizeConfigValue(value, key) {
  const text = String(value).trim();
  if (!text) throw new Error(`${key} cannot be empty`);
  if (/[\r\n\u0000]/.test(text)) throw new Error(`${key} must be a single-line value`);
  return text;
}

function mutationBoundaryWritesAllowed({ apply, executePluginManagement, executePluginCleanup, attestCodexHookReview, permissionPlan = false, notificationPlan = false, egressLauncherPlan = false }) {
  const allowed = [];
  if (apply) allowed.push('agentic-plugins-owned config files');
  if (executePluginManagement) allowed.push('allowlisted host-native plugin install/update commands');
  if (executePluginCleanup) allowed.push('allowlisted retired/unknown agentic-plugins plugin cleanup commands');
  if (attestCodexHookReview) allowed.push('runtime settings execution artifact with Codex hook review attestation');
  // Plan-artifact honesty (settings-report-contract.md §3, both modes): the
  // M1 plan flags write their own artifact families while dry_run stays
  // true — "dry run" must never render as "no writes" while they do.
  if (permissionPlan) allowed.push('agentic-plugins-owned permission advisory artifact (runs/permission)');
  if (notificationPlan) allowed.push('agentic-plugins-owned notification plan artifact (runs/notification)');
  if (egressLauncherPlan) allowed.push('agentic-plugins-owned egress launcher plan artifact (runs/egress-launcher)');
  return allowed.length > 0 ? allowed.join('; ') : 'none; dry-run only';
}

// settings-report-contract.md §3 — one authoritative map over every
// top-level report section (19 entries). Enum: evaluated | not_evaluated |
// not_requested | local_only. An empty container or zero counter must never
// stand in for "not evaluated"; this map carries the semantics.
function buildSectionPresence({ skipHostCliProbes, permissionPlan, notificationPlan, egressLauncherPlan }) {
  const probeState = skipHostCliProbes ? 'not_evaluated' : 'evaluated';
  return {
    clis: probeState,
    plugins: probeState,
    plugin_command_surface: probeState,
    plugin_management: probeState,
    plugin_cleanup: probeState,
    hook_settings: probeState,
    codex_hook_review: probeState,
    config: 'evaluated',
    companion_settings: 'evaluated',
    notify_settings: 'evaluated',
    mutation_boundary: 'evaluated',
    artifacts: 'evaluated',
    limits: 'evaluated',
    overall: 'evaluated',
    recommendations: skipHostCliProbes ? 'local_only' : 'evaluated',
    permission_plan: permissionPlan ? 'evaluated' : 'not_requested',
    permission_plan_codex: permissionPlan ? 'evaluated' : 'not_requested',
    notification_plan: notificationPlan ? 'evaluated' : 'not_requested',
    egress_launcher_plan: egressLauncherPlan ? 'evaluated' : 'not_requested',
  };
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
      ? 'No config values requested; pass --model/--effort, direction-specific flags, or --notify-* flags to plan config writes.'
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

export function upsertRuntimeConfigToml(text, desired) {
  const normalizedDesired = normalizeDesiredConfig(desired);
  const desiredMap = new Map(Object.entries(normalizedDesired));
  const replaced = new Set();
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
    if (!desiredMap.has(normalizedKey)) {
      output.push(line);
      continue;
    }
    // Rewrite EVERY line of a desired key, not just the first: the read
    // parser (parseRuntimeConfigToml) is last-value-wins, so leaving a later
    // duplicate stale would make apply report an update the emitter never
    // sees (Codex review).
    output.push(`${match[1]}${match[2]}${match[3]}${tomlString(desiredMap.get(normalizedKey))}${match[7]}`);
    replaced.add(normalizedKey);
  }

  const remaining = [...desiredMap].filter(([key]) => !replaced.has(key));
  if (remaining.length > 0) {
    if (output.length > 0 && output.at(-1) !== '') output.push('');
    output.push('# agentic-plugins runtime defaults');
    for (const [key, value] of remaining) {
      output.push(`${key} = ${tomlString(value)}`);
    }
  }
  return `${output.join('\n')}\n`;
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

function resolveProjectedSetting({ keys, projection, field = 'projected_config', defaultSource = 'host-native default' }) {
  for (const targetKind of ['repo', 'user']) {
    const target = projection[targetKind];
    if (!target) continue;
    for (const key of keys) {
      const value = target[field][key];
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
    source: defaultSource,
    key: null,
    target: null,
    path: null,
  };
}

// ADR-0040 §2 notify key-family plan: per-key effective projection over the
// same repo -> user precedence chain as model/effort, falling back to the
// shipped default instead of a host-native default (the emitter, not a host,
// owns unset behavior). Warns on shadowed requests and on existing config
// values that fail the per-key validators — the §2 emitter fail-closes on
// those, so surfacing them here is the operator's only signal.
function buildNotifySettingPlans({ desiredConfig, configTargets, apply }) {
  const projection = buildConfigProjection(configTargets);
  const keys = {};
  const warnings = [];
  for (const key of CONFIG_KEY_FAMILIES.notify) {
    const requested = desiredConfig[key] ?? null;
    const projected = resolveProjectedSetting({ keys: [key], projection, defaultSource: 'shipped default' });
    const current = resolveProjectedSetting({ keys: [key], projection, field: 'current_config', defaultSource: 'shipped default' });
    const status = requested === null
      ? 'unchanged'
      : projected.value === requested
        ? 'effective'
        : 'shadowed';
    const keyWarnings = [];
    if (status === 'shadowed') {
      keyWarnings.push([
        `${key} request ${key}=${requested} is shadowed by ${projected.source}`,
        'choose a higher-precedence target or remove the shadowing config entry',
      ].join('; '));
    }
    if (projected.value !== null) {
      try {
        validateConfigValue(key, projected.value);
      } catch (err) {
        keyWarnings.push(`${key} effective value "${projected.value}" (${projected.source}) is invalid and the notify emitter will fail closed: ${err.message}`);
      }
    }
    // Validate every target's stored value, not just the winning projection:
    // an invalid lower-precedence entry (e.g. user config shadowed by a valid
    // repo value) would otherwise sit silently until the shadowing entry is
    // removed and the emitter starts fail-closing on it.
    for (const targetKind of ['repo', 'user']) {
      const stored = projection[targetKind]?.current_config?.[key];
      if (!stored || (projected.target === targetKind && projected.value === stored)) continue;
      try {
        validateConfigValue(key, stored);
      } catch (err) {
        keyWarnings.push(`${key} ${targetKind} config value "${stored}" is invalid and the notify emitter will fail closed on it if it becomes effective: ${err.message}`);
      }
    }
    const warning = keyWarnings.length > 0 ? keyWarnings.join('; ') : null;
    if (warning) warnings.push(warning);
    keys[key] = {
      value: projected.value,
      effective_value: projected.value ?? NOTIFY_KEY_DEFAULTS[key],
      source: projected.source,
      target: projected.target,
      path: projected.path,
      default: NOTIFY_KEY_DEFAULTS[key],
      status,
      requested_value: requested,
      current_value: current.value,
      current_source: current.value !== null ? current.source : null,
      warning,
    };
  }
  return {
    config_keys: [...CONFIG_KEY_FAMILIES.notify],
    effective_mode: apply ? 'applied' : 'projected',
    resolution_order: [
      'repo-local .agentic-plugins/config.toml',
      'user-global ~/.agentic-plugins/config.toml',
      'shipped default',
    ],
    defaults: { ...NOTIFY_KEY_DEFAULTS },
    keys,
    warnings,
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

function buildTopLevelRecommendations({ clis, plugins, pluginCleanup, desiredConfig, companionSettings, notifySettings, hookSettings }) {
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
      detail: 'No config writes planned. Use --model/--effort, --claude-model/--codex-model, or --notify-* flags with optional --apply.',
    });
  }
  for (const warning of [...collectCompanionSettingWarnings(companionSettings), ...(notifySettings?.warnings ?? [])]) {
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
  const settingWarnings = collectCompanionSettingWarnings(report.companion_settings).length;
  const notifyWarnings = report.notify_settings?.warnings?.length ?? 0;
  if (report.report_scope === 'local_plan') {
    // settings-report-contract.md §3 — status is computed over evaluated
    // sections only, which includes requested plan sections: a blocked or
    // failed requested plan must never yield an unqualified local pass.
    // Probe-derived counters are null (never 0): a zero would read as
    // "evaluated and clean".
    const blockedPlanSections = ['permission_plan', 'permission_plan_codex', 'notification_plan', 'egress_launcher_plan']
      .map((key) => report[key])
      .filter((section) => section?.requested && ['blocked', 'failed'].includes(section.status)).length;
    return {
      scope: 'local_plan',
      status: settingWarnings > 0 || notifyWarnings > 0 || blockedPlanSections > 0 ? 'warning' : 'pass',
      planned_config_writes: writeCount,
      applied_config_targets: appliedCount,
      plugin_recommendations: null,
      setting_warnings: settingWarnings,
      notify_warnings: notifyWarnings,
      hook_warnings: null,
      hook_review_warnings: null,
      auth_warnings: null,
      plugin_cleanup_warnings: null,
      plugin_management_executed: null,
      plugin_management_failed: null,
    };
  }
  const missingCli = Object.values(report.clis).filter((cli) => cli.status !== 'available').length;
  const hookWarnings = (report.hook_settings?.recommendations ?? []).filter((rec) => rec.severity === 'warning').length;
  const authWarnings = Object.values(report.clis).filter((cli) => ['manual_required', 'manual_check'].includes(cli.auth_plan?.status)).length;
  const pluginManagementFailed = report.plugin_management.summary.failed;
  const pluginCleanupWarnings = (report.plugin_cleanup?.summary?.manual_required ?? 0)
    + (report.plugin_cleanup?.summary?.blocked ?? 0)
    + (report.plugin_cleanup?.summary?.failed ?? 0);
  const hookReviewWarnings = report.codex_hook_review?.requested && report.codex_hook_review.status !== 'attested' ? 1 : 0;
  return {
    scope: 'full',
    status: missingCli > 0 || settingWarnings > 0 || notifyWarnings > 0 || hookWarnings > 0 || hookReviewWarnings > 0 || authWarnings > 0 || pluginManagementFailed > 0 || pluginCleanupWarnings > 0 ? 'warning' : 'pass',
    planned_config_writes: writeCount,
    applied_config_targets: appliedCount,
    plugin_recommendations: Object.values(report.plugins).reduce((sum, plugin) => sum + plugin.recommendations.length, 0),
    setting_warnings: settingWarnings,
    notify_warnings: notifyWarnings,
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
  // settings-report-contract.md §4 — full-mode text stays byte-identical
  // (scoped to runs without plan flags); a narrowed report renders the scope
  // in the header, explicit probe/scope lines, a qualified overall line, and
  // one explicit "not evaluated" line per skipped section instead of its
  // normal body. An unqualified `pass` is never printed from a narrowed
  // report (full mode prints no overall line today, so nothing is removed).
  const narrowed = report.report_scope === 'local_plan';
  const NOT_EVALUATED_LINE = `- not evaluated (${report.host_cli_probes?.flag ?? '--skip-host-cli-probes'})`;
  const lines = [];
  lines.push(`runtime:settings ${report.runtime_version} (${formatSettingsMode(report)})`);
  lines.push(`repo: ${report.repo_root}`);
  lines.push(`dry-run: ${report.dry_run}`);
  if (narrowed) {
    lines.push('report scope: local_plan');
    lines.push(`host CLI probes: skipped by ${report.host_cli_probes?.flag ?? '--skip-host-cli-probes'}`);
    lines.push(`local plan: ${report.overall.status}`);
  }
  lines.push('');
  lines.push('Mutation Boundary');
  lines.push(`- writes: ${report.mutation_boundary.writes_allowed}`);
  for (const forbidden of report.mutation_boundary.forbidden) lines.push(`- forbidden: ${forbidden}`);
  lines.push('');
  lines.push('Host CLIs');
  if (narrowed) {
    lines.push(NOT_EVALUATED_LINE);
  } else {
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
  }
  lines.push('');
  lines.push('Plugins');
  if (narrowed) lines.push(NOT_EVALUATED_LINE);
  else for (const name of PLUGIN_NAMES) {
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
  if (narrowed) {
    lines.push(NOT_EVALUATED_LINE);
  } else {
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
  }
  if (narrowed) {
    lines.push('');
    lines.push('Plugin Cleanup');
    lines.push(NOT_EVALUATED_LINE);
  } else if (report.plugin_cleanup?.plans?.length > 0) {
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
  if (narrowed) {
    lines.push(NOT_EVALUATED_LINE);
  } else {
  lines.push(`- status=${report.hook_settings.status}; bundled=${report.hook_settings.packaged_plugins.bundled.join(',') || 'none'}; manifest-exposed=${report.hook_settings.packaged_plugins.manifest_exposed.join(',') || 'none'}; default-file-only=${report.hook_settings.packaged_plugins.default_file_only.join(',') || 'none'}; command-warnings=${report.hook_settings.packaged_plugins.command_warnings.join(',') || 'none'}`);
  if (report.hook_settings.hook_state) {
    const state = report.hook_settings.hook_state;
    lines.push(`- hook-state: config=${state.config_status}; expected=${state.summary.expected}; enabled=${state.summary.expected_enabled}; disabled=${state.summary.expected_disabled}; missing=${state.summary.expected_missing}; untrusted=${state.summary.expected_untrusted}; unexpected-agentic=${state.summary.unexpected_agentic_entries}; unmapped=${state.summary.unmapped_events ?? 0}`);
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
  }
  if (narrowed) {
    lines.push('');
    lines.push('Codex Hook Review');
    lines.push(NOT_EVALUATED_LINE);
  } else if (report.codex_hook_review) {
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
  if (report.notify_settings) {
    lines.push('');
    lines.push(`Notify (ADR-0040 §2, effective-${report.notify_settings.effective_mode})`);
    for (const key of report.notify_settings.config_keys) {
      const entry = report.notify_settings.keys[key];
      const rendered = entry.value !== null
        ? `${entry.value} (${entry.source})`
        : entry.default !== null
          ? `<shipped default: ${entry.default}>`
          : '<unset>';
      lines.push(`- ${key}: ${rendered}`);
      if (entry.warning) lines.push(`  warning: ${entry.warning}`);
    }
  }
  if (report.permission_plan?.requested) {
    const pp = report.permission_plan;
    lines.push('');
    lines.push('Permission Plan (Claude, dry-run)');
    lines.push(`- status: ${pp.status}; recommendations=${pp.recommended?.count ?? 0}; already-governed=${pp.already_allowed_count ?? 0}; baseline-used=${pp.evidence?.baseline_used ?? false}`);
    if (pp.sources_scanned) {
      lines.push(`- records: used=${pp.sources_scanned.used}/${pp.sources_scanned.found}; scan-truncated=${pp.sources_scanned.scan_truncated}; skipped-too-large=${pp.sources_scanned.skipped_too_large}`);
    }
    const rec = pp.recommended || {};
    if (rec.allow?.length) lines.push(`- allow: ${rec.allow.join(', ')}`);
    if (rec.deny?.length) lines.push(`- deny: ${rec.deny.join(', ')}`);
    if (rec.ask?.length) lines.push(`- ask: ${rec.ask.join(', ')}`);
    if (rec.default_mode) lines.push(`- defaultMode: ${rec.default_mode.value} (${rec.default_mode.reason})`);
    for (const conflict of pp.conflicts ?? []) lines.push(`- conflict: ${conflict.item} — ${conflict.reason}`);
    if (pp.artifact?.written) lines.push(`- artifact: ${pp.artifact.report_pointer} (latest: ${pp.artifact.latest_pointer})`);
    if (pp.fragment_text) {
      lines.push('- fragment (merge into .claude/settings.json, runtime never writes it):');
      for (const fragmentLine of pp.fragment_text.split('\n')) lines.push(`    ${fragmentLine}`);
    }
    for (const limit of pp.limits ?? []) lines.push(`- limit: ${limit}`);
  }
  if (report.permission_plan_codex?.requested) {
    const cp = report.permission_plan_codex;
    lines.push('');
    lines.push('Permission Plan (Codex, dry-run)');
    lines.push(`- status: ${cp.status}; recommendations=${cp.recommended?.count ?? 0}; baseline-used=${cp.evidence?.baseline_used ?? false}`);
    if (cp.sources_scanned) {
      lines.push(`- records: used=${cp.sources_scanned.used}/${cp.sources_scanned.found}; scan-truncated=${cp.sources_scanned.scan_truncated}; skipped-too-large=${cp.sources_scanned.skipped_too_large}`);
    }
    const hc = cp.host_config || {};
    lines.push(`- current: approval_policy=${hc.approval_policy ?? '<unset>'}; sandbox_mode=${hc.sandbox_mode ?? '<unset>'}; project-trusted=${hc.project_trusted ?? false}`);
    const rec = cp.recommended || {};
    if (rec.approval_policy) lines.push(`- approval_policy: ${rec.approval_policy.value} (${rec.approval_policy.reason})`);
    if (rec.sandbox_mode) lines.push(`- sandbox_mode: ${rec.sandbox_mode.value} (${rec.sandbox_mode.reason})`);
    if (rec.project_trust) lines.push(`- project-trust: ${rec.project_trust.path_pointer} trust_level=${rec.project_trust.trust_level} (${rec.project_trust.reason})`);
    for (const note of cp.isolated_environment_notes ?? []) lines.push(`- isolated-env: ${note}`);
    if (cp.artifact?.written) lines.push(`- artifact: ${cp.artifact.report_pointer} (latest: ${cp.artifact.latest_pointer})`);
    if (cp.fragment_text) {
      lines.push('- fragment (merge into ~/.codex/config.toml, runtime never writes it):');
      for (const fragmentLine of cp.fragment_text.split('\n')) lines.push(`    ${fragmentLine}`);
    }
    for (const limit of cp.limits ?? []) lines.push(`- limit: ${limit}`);
  }
  if (report.notification_plan?.requested) {
    const np = report.notification_plan;
    lines.push('');
    lines.push('Notification Plan (Codex, dry-run — ADR-0040 §4)');
    if (np.status === 'blocked') {
      lines.push(`- status: blocked; ${np.error}`);
    } else {
      lines.push(`- status: ${np.status}; mode=${np.recommended.mode}; codex-home=${np.host_config.codex_home_source}`);
      lines.push(`- read-check: notify present=${np.read_check.notify_present}; parseable=${np.read_check.notify_parseable}; tui-notifications present=${np.read_check.tui_notifications_present}`);
      if (np.warning) lines.push(`- warning: ${np.warning}`);
      if (np.tui_warning) lines.push(`- warning: ${np.tui_warning}`);
      lines.push(`- receiver shuttle (user-installed, recorded in the artifact): ${np.recommended.shuttle_install_path}`);
      if (np.recommended.chain_install_path) {
        lines.push(`- wrapper chain (preserves the existing notifier): ${np.recommended.chain_install_path}`);
      }
      lines.push('- fragment (merge into the USER-layer ~/.codex/config.toml, runtime never writes it):');
      for (const fragmentLine of np.fragments.notify_toml.trimEnd().split('\n')) lines.push(`    ${fragmentLine}`);
      lines.push('- fragment (tui approval attention, same file):');
      for (const fragmentLine of np.fragments.tui_notifications_toml.trimEnd().split('\n')) lines.push(`    ${fragmentLine}`);
      lines.push(`- receiver contract: payload=${np.receiver_contract.payload_position}; format=${np.receiver_contract.payload_format}; node=${np.receiver_contract.node_requirement}`);
    }
    if (np.artifact?.written) lines.push(`- artifact: ${np.artifact.report_pointer} (latest: ${np.artifact.latest_pointer})`);
    for (const limit of np.limits ?? []) lines.push(`- limit: ${limit}`);
  }
  if (report.egress_launcher_plan?.requested) {
    const el = report.egress_launcher_plan;
    const as = el.activation_state || {};
    const proto = el.prototype || {};
    lines.push('');
    lines.push('Egress Launcher Plan (dry-run — ADR-0041 §12; artifact-only, runtime writes no host/activation state)');
    lines.push(`- mode: ${el.mode}`);
    lines.push(`- activation: active=${as.active} reason=${as.reason} channel=${as.channel ?? 'none'} source=${as.source ?? 'n/a'} credential-present=${as.credential_present} headline-opt-in=${as.headline_opt_in}`);
    lines.push(`- prototype (~/.claude personal hook): settings-present=${proto.settings_present} match-count=${proto.match_count} script-present=${proto.script_file_present}`);
    for (const step of el.steps || []) {
      if (!step.applicable) continue;
      lines.push(`- step [${step.id}]: ${step.title}`);
      if (step.detail) lines.push(`    ${step.detail}`);
      if (step.recommended_layout?.config_local_toml) {
        lines.push('    recommended layout — you create ~/.agentic-plugins/config.local.toml (runtime never writes it):');
        for (const l of step.recommended_layout.config_local_toml.trimEnd().split('\n')) lines.push(`      ${l}`);
        lines.push(`    token (env-only): ${step.recommended_layout.token_env_line}`);
        lines.push('    alternative layout — env-all:');
        for (const l of step.alternative_layout.env_block.trimEnd().split('\n')) lines.push(`      ${l}`);
      }
      for (const h of step.hooks_to_remove ?? []) lines.push(`    remove hook [${h.event}]: ${h.command_pointer}`);
    }
    if (el.artifact?.written) lines.push(`- artifact: ${el.artifact.report_pointer} (latest: ${el.artifact.latest_pointer})`);
    for (const limit of el.limits ?? []) lines.push(`- limit: ${limit}`);
  }
  lines.push('');
  lines.push('Limits');
  for (const limit of report.limits) lines.push(`- ${limit}`);
  return `${lines.join('\n')}\n`;
}

function formatSettingsMode(report) {
  const modes = [];
  if (report.report_scope === 'local_plan') modes.push('local-plan');
  if (report.config_apply) modes.push('config-apply');
  if (report.execute_plugin_management) modes.push('plugin-management');
  if (report.execute_plugin_cleanup) modes.push('plugin-cleanup');
  if (report.attest_codex_hook_review) modes.push('codex-hook-review');
  return modes.length > 0 ? modes.join('+') : 'dry-run';
}

async function readTextIfExists(path) {
  try {
    const text = await readFile(path, 'utf8');
    return { ok: true, path, text };
  } catch (err) {
    return { ok: false, path, reason: err.code ?? err.message };
  }
}

// Read-only JSON read that never throws (missing/unreadable/malformed are data).
async function readJsonIfExists(path) {
  const r = await readTextIfExists(path);
  if (!r.ok) return { ok: false, reason: r.reason };
  try {
    return { ok: true, json: JSON.parse(r.text) };
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
}

// Read the Claude permissions allowlist READ-ONLY across repo + user settings,
// unioning allow/deny/ask and capturing the first observed defaultMode. Never
// writes; a missing/unreadable/malformed file is reported as a sanitized source
// status (no raw path). This is the host-allowlist cross-reference doctor
// deliberately deferred to settings (ADR-0038 §1).
async function readClaudePermissionConfig({ repoRoot, homeDir }) {
  const candidates = [
    { scope: 'repo', path: join(repoRoot, '.claude', 'settings.json') },
    { scope: 'repo-local', path: join(repoRoot, '.claude', 'settings.local.json') },
    { scope: 'user', path: join(homeDir, '.claude', 'settings.json') },
  ];
  const allow = new Set();
  const deny = new Set();
  const ask = new Set();
  const modeByScope = {};
  const sources = [];
  for (const candidate of candidates) {
    const r = await readJsonIfExists(candidate.path);
    if (!r.ok) {
      const status = r.reason === 'ENOENT' ? 'missing' : r.reason === 'invalid_json' ? 'malformed' : 'unreadable';
      sources.push({ scope: candidate.scope, status });
      continue;
    }
    sources.push({ scope: candidate.scope, status: 'readable' });
    const perms = r.json && typeof r.json === 'object' ? r.json.permissions : null;
    if (perms && typeof perms === 'object') {
      for (const a of Array.isArray(perms.allow) ? perms.allow : []) if (typeof a === 'string') allow.add(a);
      for (const d of Array.isArray(perms.deny) ? perms.deny : []) if (typeof d === 'string') deny.add(d);
      for (const k of Array.isArray(perms.ask) ? perms.ask : []) if (typeof k === 'string') ask.add(k);
      // Claude docs place the scalar at permissions.defaultMode (NOT top-level),
      // resolved local > project > user (Plan-verify peer MAJOR, verified vs docs).
      if (typeof perms.defaultMode === 'string') modeByScope[candidate.scope] = perms.defaultMode;
    }
  }
  const defaultMode = modeByScope['repo-local'] ?? modeByScope.repo ?? modeByScope.user ?? null;
  return { allow, deny, ask, defaultMode, sources };
}

// Render an advisor-core rule into the exact Claude settings.json permission
// item string, keyed by cause. file-modification has no per-pattern item — it
// maps to a defaultMode recommendation instead. The rendering lives here (the
// settings-claude slice), never in advisor-core (host-neutral by contract).
function renderClaudePermissionItem(rule) {
  switch (rule.cause) {
    case 'claude.bash-not-allowlisted':
      return `Bash(${rule.pattern})`;
    case 'claude.webfetch-domain':
      return `WebFetch(domain:${rule.pattern})`;
    case 'claude.mcp-not-allowed':
      return rule.pattern;
    default:
      return null;
  }
}

// Parse a Claude permission item into { tool, spec }; spec is null for a bare
// tool (e.g. "Bash" governs all Bash).
function parseClaudePermissionItem(item) {
  const m = String(item).match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\((.*)\))?$/);
  if (!m) return null;
  return { tool: m[1], spec: m[2] === undefined ? null : m[2] };
}

// Normalize a Bash specifier to its prefix by stripping a trailing wildcard.
// Claude documents ":*" as equivalent to a trailing " *". "npm run *" /
// "npm run:*" -> "npm run"; "npm:*" -> "npm"; "*" -> "" (matches everything).
function bashSpecPrefix(spec) {
  if (spec === '*') return '';
  return spec.replace(/:\*$/, '').replace(/\s*\*$/, '').trim();
}

// Does an existing Claude rule GOVERN a recommended item (making the
// recommendation redundant)? Same tool required. A bare tool or "*"/empty
// Bash spec governs all of that tool. For Bash, an existing prefix governs a
// recommended item whose prefix starts with it on a token boundary ("npm"
// governs "npm run"; "npm test" does not). Non-Bash tools use normalized exact
// match. (Plan-verify peer MAJOR: ":*"≡" *", bare tool, and broader prefixes.)
function claudePermissionGoverns(existing, recommended) {
  const e = parseClaudePermissionItem(existing);
  const r = parseClaudePermissionItem(recommended);
  if (!e || !r || e.tool !== r.tool) return false;
  if (e.spec === null) return true;
  if (e.tool === 'Bash') {
    const ep = bashSpecPrefix(e.spec);
    if (ep === '') return true;
    const rp = bashSpecPrefix(r.spec ?? '');
    return rp === ep || rp.startsWith(`${ep} `);
  }
  const normalize = (s) => (s ?? '').replace(/:\*$/, '').replace(/\s*\*$/, '').trim();
  return normalize(e.spec) === normalize(r.spec);
}

function governedByClaudeRules(ruleSet, recommended) {
  for (const existing of ruleSet) {
    if (claudePermissionGoverns(existing, recommended)) return true;
  }
  return false;
}

// Which bucket of the operator's OWN .claude/settings already governs this
// pattern, in the host's precedence order (deny beats ask beats allow) — or null
// if none does.
function claudeGoverningBucket(hostConfig, item) {
  if (governedByClaudeRules(hostConfig.deny, item)) return 'deny';
  if (governedByClaudeRules(hostConfig.ask, item)) return 'ask';
  if (governedByClaudeRules(hostConfig.allow, item)) return 'allow';
  return null;
}

function permissionPlanLimits(capNote) {
  const limits = [
    'runtime:settings permission plan is a dry-run (M1): it emits the recommended .claude/settings.json fragment and writes plan+evidence to an agentic-plugins-owned artifact, but NEVER writes host config — apply it yourself by merging the fragment.',
    'Recommendations are safety-graded (allow for known-safe families; deny/ask retained for dangerous shapes) and never recommend bypassPermissions as a default.',
    'The operator\'s standing rules outrank an observation: a pattern already governed by an equal-or-STRICTER host rule (same bucket, or a standing deny/ask over a safer-looking observation) is never re-recommended — the plan never emits a rule WEAKER than one already set. Where the advisor is STRICTER than the existing rule (a dangerous pattern sitting in allow), it surfaces the conflict AND still recommends the corrective rule. The host allow/deny/ask sets are read read-only and never added to apply targets.',
    'Evidence retains only generalized patterns + counts (ADR-0038 §5); raw commands, arguments, and source paths are never surfaced.',
  ];
  if (capNote) limits.push(capNote);
  return limits;
}

// ADR-0038 settings-claude — the M1 Claude permission plan. Learns prompt-cause
// evidence from Claude usage records (read-only, via doctor's hardened
// enumeration), reads the host allowlist read-only, builds an advisor-core
// fragment contract of the NOT-yet-governed recommendations (safety-graded),
// renders the exact settings.json fragment, and persists plan+evidence to the
// permission-advisory artifact (surface=settings). Host config is never written.
// Builds the Claude SECTION + its fragment contract from the shared cross-host
// learner. It does NOT collect/learn (the orchestrator does that once) and does
// NOT write the artifact (the orchestrator writes ONE combined cross-host
// artifact — Plan-verify peer MAJOR: per-host artifacts clobbered the shared
// latest.json). Status is per-host (claude evidence), not the combined learner.
async function buildPermissionPlan({ repoRoot, homeDir, learner, scan, maxFiles }) {
  const claudeRules = learner.rules.filter((rule) => rule.host === 'claude');
  const claudeHasEvidence = claudeRules.length > 0 || learner.modeEvidence.some((m) => m.host === 'claude');

  const hostConfig = await readClaudePermissionConfig({ repoRoot, homeDir });

  const allow = [];
  const deny = [];
  const ask = [];
  const conflicts = [];
  const fragmentRules = [];
  let alreadyGoverned = 0;
  // The operator's own .claude/settings outranks an observation. That is ONE
  // strictness comparison (deny > ask > allow), not a per-grade branch — and
  // writing it as per-grade branches is exactly what left cells of the matrix
  // unhandled, twice:
  //
  //   observed | in allow[]        | in ask[]          | in deny[]
  //   ---------+-------------------+-------------------+------------------
  //   allow    | governed, skip    | operator stricter | operator stricter
  //   ask      | WE are stricter   | governed, skip    | operator stricter
  //   deny     | WE are stricter   | WE are stricter   | governed, skip
  //
  //   same bucket        -> already governed: recommend nothing, no conflict.
  //   operator stricter  -> their standing decision stands: surface the conflict
  //                         and recommend NOTHING. Never emit a rule WEAKER than
  //                         what the operator already set — that is the advisor
  //                         arguing with its own operator.
  //   we are stricter    -> safety escalation: surface the conflict AND still
  //                         recommend the corrective rule, so a dangerous pattern
  //                         sitting in allow[] is never silently suppressed.
  //
  // An earlier Plan-verify closed `deny`/`ask` observed against allow[]. The
  // commit before this one closed the `allow` row. The `ask`-observed-against-an
  // explicit-`deny` cell was still open: it recommended the pattern straight back
  // into ask[], with conflicts=[] and already_allowed_count=0 — silently relaxing
  // a standing deny into a prompt. Host deny-precedence contained the blast, but
  // the plan still contradicted the operator and the shipped limits text still
  // claimed allow/deny/ask were all excluded. Same defect, mirror cell. State the
  // invariant once so there is no third mirror to find.
  for (const rule of claudeRules) {
    const item = renderClaudePermissionItem(rule);
    if (!item) continue; // file-modification → defaultMode, handled below
    const bucket = claudeGoverningBucket(hostConfig, item);
    if (bucket === rule.grade) {
      alreadyGoverned += 1;
      continue;
    }
    if (bucket && worstGrade(bucket, rule.grade) === bucket) {
      conflicts.push({
        item,
        grade: rule.grade,
        reason: `observed as ${rule.grade} but already governed by permissions.${bucket} in .claude/settings; the operator's ${bucket} stands — not recommended for ${rule.grade}`,
      });
      alreadyGoverned += 1;
      continue;
    }
    if (bucket) {
      conflicts.push({
        item,
        grade: rule.grade,
        reason: `currently ${bucket === 'allow' ? 'allowed' : bucket} in .claude/settings but graded ${rule.grade}; move it to permissions.${rule.grade}`,
      });
    }
    if (rule.grade === 'deny') deny.push(item);
    else if (rule.grade === 'ask') ask.push(item);
    else allow.push(item);
    fragmentRules.push(rule);
  }

  let modeRecommendation = null;
  const hasFileMod = learner.modeEvidence.some((m) => m.host === 'claude' && m.cause === 'claude.file-modification');
  const modeAlreadySet = hostConfig.defaultMode === 'acceptEdits' || hostConfig.defaultMode === 'bypassPermissions';
  if (hasFileMod && !modeAlreadySet) {
    modeRecommendation = makeModeRecommendation({
      setting: 'defaultMode',
      value: 'acceptEdits',
      reason: 'clear repeated file-modification prompts (Edit/Write)',
    });
  }

  const fragment = makeFragmentContract({
    host: 'claude',
    rules: fragmentRules,
    modeRecommendation,
    notes: ['merge into .claude/settings.json permissions; runtime never writes host config'],
  });

  const fragmentJson = { permissions: {} };
  if (allow.length) fragmentJson.permissions.allow = allow;
  if (deny.length) fragmentJson.permissions.deny = deny;
  if (ask.length) fragmentJson.permissions.ask = ask;
  // Claude places the scalar at permissions.defaultMode, not top-level
  // (Plan-verify peer MAJOR, verified vs Claude docs).
  if (modeRecommendation) fragmentJson.permissions.defaultMode = modeRecommendation.value;

  const capNotes = [];
  // Per-host cap note reflects the CLAUDE scan only (Plan-verify peer MINOR).
  if (scan.found > scan.used) capNotes.push(`per-host file cap (${maxFiles}) reached`);
  if (scan.scan_truncated) capNotes.push('directory scan hit the safety budget');
  if (scan.skipped_too_large) capNotes.push(`skipped ${scan.skipped_too_large} oversized record(s) above the per-file byte cap`);
  const capNote = capNotes.length ? `${capNotes.join('; ')}.` : null;

  return {
    section: {
      requested: true,
      executed: true,
      status: claudeHasEvidence ? 'analyzed' : 'baseline',
      host: 'claude',
      sources_scanned: {
        found: scan.found,
        used: scan.used,
        scan_truncated: scan.scan_truncated,
        skipped_too_large: scan.skipped_too_large,
      },
      host_config: { read_only: true, sources: hostConfig.sources, default_mode: hostConfig.defaultMode },
      recommended: {
        allow,
        deny,
        ask,
        default_mode: modeRecommendation ? { value: modeRecommendation.value, reason: modeRecommendation.reason } : null,
        count: allow.length + deny.length + ask.length + (modeRecommendation ? 1 : 0),
      },
      conflicts,
      already_allowed_count: alreadyGoverned,
      fragment: fragmentJson,
      fragment_text: JSON.stringify(fragmentJson, null, 2),
      evidence: {
        rule_count: claudeRules.length,
        total_seen: claudeRules.reduce((sum, rule) => sum + rule.evidence.count, 0),
        baseline_used: !claudeHasEvidence,
      },
      limits: permissionPlanLimits(capNote),
    },
    fragmentContract: fragment,
    artifactNotes: [],
  };
}

// Reverse of tomlString's escaping for a basic-string key/value: "\\"->"\",
// '\"'->'"'. Used to compare a stored [projects."<path>"] key against repoRoot.
function unescapeTomlBasic(s) {
  return String(s).replace(/\\(["\\])/g, '$1');
}

// Minimal READ-ONLY scan of ~/.codex/config.toml for exactly the keys the Codex
// plan needs: top-level approval_policy / sandbox_mode, and the set of
// [projects."<path>"] sections whose trust_level = "trusted". Section-scoped
// line parser mirroring doctor's parseCodexHookStateConfigToml; every other
// section/key is ignored. Top-level keys are only honored before the first
// section (TOML requires that ordering).
export function parseCodexPermissionConfigToml(text) {
  let approvalPolicy = null;
  let sandboxMode = null;
  const trustedProjects = new Set();
  let currentProject = null;
  let inTopLevel = true;
  for (const raw of String(text ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const projectSection = raw.match(/^\s*\[projects\."((?:[^"\\]|\\.)*)"\]\s*(?:#.*)?$/);
    if (projectSection) {
      currentProject = unescapeTomlBasic(projectSection[1]);
      inTopLevel = false;
      continue;
    }
    const line = raw.replace(/#.*/, '').trim();
    if (line.startsWith('[')) {
      // Any other section header — including [[array-tables]] and unsupported
      // shapes — leaves top-level so a later key is never mis-read as a top-level
      // approval_policy/sandbox_mode (Plan-verify peer MINOR).
      currentProject = null;
      inTopLevel = false;
      continue;
    }
    if (!line) continue;
    if (inTopLevel) {
      const ap = line.match(/^approval_policy\s*=\s*"([^"]*)"\s*$/);
      if (ap) { approvalPolicy = ap[1]; continue; }
      const sm = line.match(/^sandbox_mode\s*=\s*"([^"]*)"\s*$/);
      if (sm) { sandboxMode = sm[1]; continue; }
    } else if (currentProject) {
      const tl = line.match(/^trust_level\s*=\s*"([^"]*)"\s*$/);
      if (tl && tl[1] === 'trusted') trustedProjects.add(currentProject);
    }
  }
  return { approvalPolicy, sandboxMode, trustedProjects };
}

// Read ~/.codex/config.toml READ-ONLY (honoring $CODEX_HOME). Never writes; a
// missing/unreadable file is sanitized source data, not an error.
async function readCodexPermissionConfig({ homeDir, env, repoRoot }) {
  const codexHome = env && env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(homeDir, '.codex');
  const r = await readTextIfExists(join(codexHome, 'config.toml'));
  if (!r.ok) {
    const status = r.reason === 'ENOENT' ? 'missing' : 'unreadable';
    return { approvalPolicy: null, sandboxMode: null, projectTrusted: false, sources: [{ scope: 'user', status }] };
  }
  const parsed = parseCodexPermissionConfigToml(r.text);
  return {
    approvalPolicy: parsed.approvalPolicy,
    sandboxMode: parsed.sandboxMode,
    projectTrusted: parsed.trustedProjects.has(repoRoot),
    sources: [{ scope: 'user', status: 'readable' }],
  };
}

// Render the recommended ~/.codex/config.toml fragment TEXT. Reuses tomlString
// for value + quoted-path-key escaping (\\ and ") — the topic's flagged TOML
// escaping concern (a Windows path's backslashes become \\ in the section key).
// Full TOML basic-string escape: backslash, quote, the named control escapes
// (\b\t\n\f\r), and any other C0 control / DEL as \uXXXX. Unlike tomlString
// (which only handles \ and "), this is safe for a project path key that could
// theoretically contain a control char on POSIX (Plan-verify peer MAJOR — a
// newline would otherwise corrupt the [projects."..."] header).
function tomlBasicString(value) {
  let out = '';
  for (const ch of String(value)) {
    const code = ch.codePointAt(0);
    if (ch === '\\') out += '\\\\';
    else if (ch === '"') out += '\\"';
    else if (ch === '\b') out += '\\b';
    else if (ch === '\t') out += '\\t';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\f') out += '\\f';
    else if (ch === '\r') out += '\\r';
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `"${out}"`;
}

export function renderCodexConfigToml({ approvalPolicy, sandboxMode, projectTrust }) {
  const lines = [];
  if (approvalPolicy) lines.push(`approval_policy = ${tomlBasicString(approvalPolicy)}`);
  if (sandboxMode) lines.push(`sandbox_mode = ${tomlBasicString(sandboxMode)}`);
  if (projectTrust) {
    if (lines.length) lines.push('');
    lines.push(`[projects.${tomlBasicString(projectTrust.path)}]`);
    lines.push(`trust_level = ${tomlBasicString(projectTrust.trust_level)}`);
  }
  return lines.length ? `${lines.join('\n')}\n` : '';
}

function codexPermissionPlanLimits(capNote) {
  const limits = [
    'runtime:settings Codex permission plan is a dry-run (M1): it emits the recommended ~/.codex/config.toml fragment and writes plan+evidence to an agentic-plugins-owned artifact, but NEVER writes host config — apply it yourself.',
    'Recommendations are safety-graded postures (approval_policy=on-request, sandbox_mode=workspace-write) and NEVER recommend danger-full-access (or approval_policy=never) as a default; those appear only as explicitly-labeled isolated-environment notes.',
    'The host ~/.codex/config.toml is read read-only and never added to apply targets; only a posture that is currently prompting is recommended (one already at/looser than the recommendation is left unchanged).',
    'Evidence retains only generalized patterns + counts (ADR-0038 §5); raw commands, arguments, and source paths are never surfaced.',
  ];
  if (capNote) limits.push(capNote);
  return limits;
}

// ADR-0038 settings-codex — the M1 Codex permission plan. Codex governs by
// POSTURE (approval_policy / sandbox_mode), not a per-command allowlist, so the
// plan recommends safety-graded postures grounded in usage evidence
// (approval-requested → approval_policy; sandbox-blocked → sandbox_mode), plus a
// bounded [projects."<repo>"] trust_level entry, rendered as a config.toml
// fragment. Reads host config read-only; never writes it; never danger-full-access.
// Builds the Codex SECTION + its fragment contracts from the shared cross-host
// learner. Like the Claude builder it does NOT collect/learn or write the
// artifact — the orchestrator writes one combined cross-host artifact. Status is
// per-host (codex evidence).
async function buildCodexPermissionPlan({ repoRoot, homeDir, env, learner, scan, maxFiles }) {
  const codexRules = learner.rules.filter((rule) => rule.host === 'codex');
  const modeEvidence = learner.modeEvidence.filter((m) => m.host === 'codex');
  const codexHasEvidence = codexRules.length > 0 || modeEvidence.length > 0;
  const hostConfig = await readCodexPermissionConfig({ homeDir, env, repoRoot });

  const fragments = [];
  const recommended = { approval_policy: null, sandbox_mode: null, project_trust: null, count: 0 };
  const isolatedNotes = [];
  const artifactNotes = [];

  const approvalSeen = modeEvidence.find((m) => m.cause === 'codex.approval-requested');
  if (approvalSeen) {
    if (hostConfig.approvalPolicy !== 'on-request' && hostConfig.approvalPolicy !== 'never') {
      const mode = makeModeRecommendation({
        setting: 'approval_policy',
        value: 'on-request',
        reason: `approval requested ${approvalSeen.count}x; on-request prompts only on escalation/failure`,
      });
      fragments.push(makeFragmentContract({ host: 'codex', rules: [], modeRecommendation: mode, notes: [] }));
      recommended.approval_policy = { value: 'on-request', reason: mode.reason };
      recommended.count += 1;
    }
    isolatedNotes.push('approval_policy="never" removes approval prompts entirely — isolated-environment only, never a recommended default.');
  }

  const sandboxSeen = modeEvidence.find((m) => m.cause === 'codex.sandbox-blocked');
  if (sandboxSeen) {
    if (hostConfig.sandboxMode !== 'workspace-write' && hostConfig.sandboxMode !== 'danger-full-access') {
      const mode = makeModeRecommendation({
        setting: 'sandbox_mode',
        value: 'workspace-write',
        reason: `sandbox blocked ${sandboxSeen.count}x; workspace-write permits writes within the workspace`,
      });
      fragments.push(makeFragmentContract({ host: 'codex', rules: [], modeRecommendation: mode, notes: [] }));
      recommended.sandbox_mode = { value: 'workspace-write', reason: mode.reason };
      recommended.count += 1;
    }
    isolatedNotes.push('sandbox_mode="danger-full-access" removes the sandbox entirely — isolated-environment only, never a recommended default.');
  }

  if ((approvalSeen || sandboxSeen) && !hostConfig.projectTrusted) {
    recommended.project_trust = { path_pointer: '.', trust_level: 'trusted', reason: 'first-use project trust reduces repeated prompts for this workspace' };
    recommended.count += 1;
    // Persist the project-trust intent in the combined artifact too (pointer-only;
    // Plan-verify peer MINOR — it was in the live report but not the artifact).
    artifactNotes.push('codex project-trust recommendation: [projects."."] trust_level=trusted');
  }

  const fragmentText = renderCodexConfigToml({
    approvalPolicy: recommended.approval_policy ? recommended.approval_policy.value : null,
    sandboxMode: recommended.sandbox_mode ? recommended.sandbox_mode.value : null,
    projectTrust: recommended.project_trust ? { path: repoRoot, trust_level: 'trusted' } : null,
  });
  const fragmentStruct = {
    config_toml: {
      approval_policy: recommended.approval_policy ? recommended.approval_policy.value : null,
      sandbox_mode: recommended.sandbox_mode ? recommended.sandbox_mode.value : null,
    },
    project_trust: recommended.project_trust ? { path_pointer: '.', trust_level: 'trusted' } : null,
  };

  const capNotes = [];
  if (scan.found > scan.used) capNotes.push(`per-host file cap (${maxFiles}) reached`);
  if (scan.scan_truncated) capNotes.push('directory scan hit the safety budget');
  if (scan.skipped_too_large) capNotes.push(`skipped ${scan.skipped_too_large} oversized record(s) above the per-file byte cap`);
  const capNote = capNotes.length ? `${capNotes.join('; ')}.` : null;

  return {
    section: {
      requested: true,
      executed: true,
      status: codexHasEvidence ? 'analyzed' : 'baseline',
      host: 'codex',
      sources_scanned: {
        found: scan.found,
        used: scan.used,
        scan_truncated: scan.scan_truncated,
        skipped_too_large: scan.skipped_too_large,
      },
      host_config: {
        read_only: true,
        sources: hostConfig.sources,
        approval_policy: hostConfig.approvalPolicy,
        sandbox_mode: hostConfig.sandboxMode,
        project_trusted: hostConfig.projectTrusted,
      },
      recommended,
      isolated_environment_notes: isolatedNotes,
      evidence: {
        rule_count: codexRules.length,
        total_seen: codexRules.reduce((sum, rule) => sum + rule.evidence.count, 0),
        baseline_used: !codexHasEvidence,
      },
      fragment: fragmentStruct,
      fragment_text: fragmentText,
      limits: codexPermissionPlanLimits(capNote),
    },
    fragmentContracts: fragments,
    artifactNotes,
  };
}

// Orchestrate the cross-host M1 permission plan: collect usage records once,
// learn once (combined evidence), build both host sections, and write ONE
// cross-host advisory artifact (hosts: ['claude','codex']) so both sections
// share a single run id + latest pointer (Plan-verify peer MAJOR — per-host
// artifacts clobbered the single shared latest.json).
async function buildCrossHostPermissionPlan({ repoRoot, homeDir, env, now, maxFiles, maxFileBytes }) {
  let collected;
  try {
    collected = await collectUsageRecordSources({ homeDir, env, maxFiles, maxFileBytes });
  } catch (err) {
    const reason = err.code ?? err.message;
    const blocked = (host, extra) => ({
      requested: true,
      executed: true,
      status: 'blocked',
      host,
      error: reason,
      sources_scanned: { found: 0, used: 0, scan_truncated: false, skipped_too_large: 0 },
      ...extra,
      artifact: { written: false, reason: 'usage-record enumeration failed' },
    });
    return {
      claude: blocked('claude', {
        host_config: { read_only: true, sources: [], default_mode: null },
        recommended: { allow: [], deny: [], ask: [], default_mode: null, count: 0 },
        conflicts: [],
        already_allowed_count: 0,
        fragment: null,
        fragment_text: null,
        evidence: { rule_count: 0, total_seen: 0, baseline_used: true },
        limits: permissionPlanLimits(null),
      }),
      codex: blocked('codex', {
        host_config: { read_only: true, sources: [], approval_policy: null, sandbox_mode: null, project_trusted: false },
        recommended: { approval_policy: null, sandbox_mode: null, project_trust: null, count: 0 },
        isolated_environment_notes: [],
        fragment: null,
        fragment_text: null,
        evidence: { rule_count: 0, total_seen: 0, baseline_used: true },
        limits: codexPermissionPlanLimits(null),
      }),
    };
  }

  const learner = learnFromSources(collected.sources);
  const claudeBuilt = await buildPermissionPlan({
    repoRoot,
    homeDir,
    learner,
    scan: collected.scanned.claude,
    maxFiles,
  });
  const codexBuilt = await buildCodexPermissionPlan({
    repoRoot,
    homeDir,
    env,
    learner,
    scan: collected.scanned.codex,
    maxFiles,
  });

  const fragments = [];
  if (claudeBuilt.fragmentContract) fragments.push(claudeBuilt.fragmentContract);
  fragments.push(...codexBuilt.fragmentContracts);
  const artifactNotes = [...claudeBuilt.artifactNotes, ...codexBuilt.artifactNotes];

  const runId = makePermissionRunId(now);
  const { pointers } = await recordPermissionAdvisoryArtifact({
    repoRoot,
    runId,
    surface: 'settings',
    hosts: ['claude', 'codex'],
    plan: fragments,
    evidence: learner,
    notes: artifactNotes,
    createdAt: now.toISOString(),
  });
  const artifact = {
    written: true,
    run_id: runId,
    run_pointer: pointers.run_pointer,
    report_pointer: pointers.report_pointer,
    latest_pointer: pointers.latest_pointer,
  };

  return {
    claude: { ...claudeBuilt.section, artifact },
    codex: { ...codexBuilt.section, artifact },
  };
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
    '  [--notify-channel none|macos-osascript|file-log] [--notify-quiet-hours HH:MM-HH:MM] [--notify-quiet-hours-tz <iana-tz>]',
    '  [--notify-dedupe-ttl-seconds <n>] [--notify-urgent-bypass-quiet-hours true|false] [--notify-kinds <csv>]',
    '  [--apply] [--attest-codex-hook-review] [--execute-plugin-management] [--execute-plugin-cleanup] [--plugin-management-host all|claude|codex] [--plugin-management-timeout-ms <n>]',
    '  [--permission-plan] [--permission-plan-max-files <n>] [--permission-plan-max-file-bytes <n>] [--notification-plan] [--egress-launcher-plan] [--run-id <settings-run-id>]',
    '  [--skip-host-cli-probes]  (probe-free local plan: no runDoctor / host-CLI subprocess probes; rejects --execute-*, --attest-codex-hook-review, --plugin-management-*, --run-id; --apply and the plan flags stay allowed)',
    '',
  ].join('\n');
}

// Every config key maps to a CLI flag by the same kebab-case rule
// (claude_model -> --claude-model, notify_kinds -> --notify-kinds), so the
// flag surface derives from CONFIG_KEYS instead of re-enumerating one
// else-if branch per key.
const CONFIG_FLAG_TO_KEY = Object.fromEntries(
  CONFIG_KEYS.map((key) => [`--${key.replace(/_/g, '-')}`, key]),
);

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
    // Absent (undefined) until the flag is actually passed — runSettings'
    // probe-free conflict gate keys on presence, and value-comparison would
    // erase `--plugin-management-host all` (settings-report-contract.md §1).
    pluginManagementHost: undefined,
    pluginManagementTimeoutMs: undefined,
    skipHostCliProbes: false,
    permissionPlan: false,
    permissionPlanMaxFiles: DEFAULT_PERMISSION_PLAN_MAX_FILES,
    permissionPlanMaxFileBytes: DEFAULT_PERMISSION_PLAN_MAX_FILE_BYTES,
    notificationPlan: false,
    egressLauncherPlan: false,
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
    } else if (arg === '--skip-host-cli-probes') {
      opts.skipHostCliProbes = true;
    } else if (arg === '--permission-plan') {
      opts.permissionPlan = true;
    } else if (arg === '--notification-plan') {
      opts.notificationPlan = true;
    } else if (arg === '--egress-launcher-plan') {
      opts.egressLauncherPlan = true;
    } else if (arg === '--permission-plan-max-files') {
      opts.permissionPlanMaxFiles = parsePositiveInt(requireValue(argv, ++i, arg), arg);
    } else if (arg === '--permission-plan-max-file-bytes') {
      opts.permissionPlanMaxFileBytes = parsePositiveInt(requireValue(argv, ++i, arg), arg);
    } else if (arg === '--run-id') {
      opts.runId = validateSettingsRunId(requireValue(argv, ++i, arg));
    } else if (CONFIG_FLAG_TO_KEY[arg]) {
      opts.desired[CONFIG_FLAG_TO_KEY[arg]] = requireValue(argv, ++i, arg);
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
