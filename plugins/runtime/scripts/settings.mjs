#!/usr/bin/env node
// plugins/runtime/scripts/settings.mjs
//
// ADR-0024 settings surface. Dry-run is the default. Apply mode writes only
// agentic-plugins-owned config files and never mutates host-native config,
// authentication, plugin installation, or sandbox/permission settings.

import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { PLUGIN_NAMES, RUNTIME_VERSION, runDoctor } from './doctor.mjs';

export const SETTINGS_SCHEMA_VERSION = 'runtime-settings-1.1';
export const CONFIG_KEYS = [
  'model',
  'effort',
  'claude_model',
  'claude_effort',
  'codex_model',
  'codex_effort',
];

const TARGETS = new Set(['repo', 'user', 'both']);
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
} = {}) {
  if (!TARGETS.has(target)) throw new Error('--target must be repo, user, or both');
  const resolvedRepoRoot = resolve(repoRoot);
  const resolvedHomeDir = resolve(homeDir);
  const startedAt = now.toISOString();
  const desiredConfig = normalizeDesiredConfig(desired);

  const doctor = await runDoctor({
    repoRoot: resolvedRepoRoot,
    homeDir: resolvedHomeDir,
    env,
    now,
    runner,
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

  const companionSettings = buildCompanionSettingPlans({
    currentDirections: doctor.model_effort.directions,
    desiredConfig,
    configTargets: configPlans.targets,
    apply,
  });

  const report = {
    schema_version: SETTINGS_SCHEMA_VERSION,
    runtime_version: RUNTIME_VERSION,
    generated_at: startedAt,
    repo_root: resolvedRepoRoot,
    host,
    output_format: format,
    dry_run: !apply,
    apply,
    mutation_boundary: {
      writes_allowed: apply
        ? 'agentic-plugins-owned config files only'
        : 'none; dry-run only',
      allowed_paths: configPlans.targets.filter((plan) => plan.selected).map((plan) => plan.path),
      forbidden: [
        'host-native Claude Code or Codex CLI config',
        'authentication state or secrets',
        'sandbox or permission relaxation',
        'plugin install, update, or uninstall execution',
      ],
    },
    clis: buildCliPlans(doctor.clis),
    plugins: buildPluginPlans(doctor.plugins),
    config: {
      resolution_order: doctor.model_effort.resolution_order,
      desired: desiredConfig,
      targets: configPlans.targets,
    },
    companion_settings: companionSettings,
    recommendations: buildTopLevelRecommendations({
      clis: doctor.clis,
      plugins: doctor.plugins,
      desiredConfig,
      companionSettings,
    }),
    limits: [
      'Plugin install/update is recommendation-only in this PR; no host command is executed.',
      'Host-native config, auth, secrets, and sandbox/permission settings are not written.',
      'Companion invocation still uses companions/contract.md --model and --effort.',
      'Codex plugin-local automatic hooks are not assumed; settings reports manual paths honestly.',
      'Dynamic peer consensus, context hygiene mutation, completion footer mutation, deep peer smoke, and automatic plugin install/update apply mode are deferred.',
    ],
  };
  report.overall = summarizeSettings(report);
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
    result[name] = {
      status: cli.status,
      version: cli.version,
      recommendation: cli.status === 'available' ? null : DEFAULT_HOST_INSTALL_COMMANDS[name],
    };
  }
  return result;
}

function buildPluginPlans(plugins) {
  const result = {};
  for (const name of PLUGIN_NAMES) {
    const plugin = plugins[name];
    const sourceVersion = plugin.source?.claude_manifest?.version ?? plugin.source?.codex_manifest?.version ?? null;
    const claudeInstalled = plugin.installed?.claude_plugin_list ?? null;
    const claudeCacheLatest = plugin.cache?.claude?.latest ?? null;
    const codexCacheLatest = plugin.cache?.codex?.latest ?? null;
    result[name] = {
      status: plugin.status,
      source_version: sourceVersion,
      marketplace: plugin.marketplace,
      installed: {
        claude_plugin_list: claudeInstalled,
        claude_cache: summarizeCacheInstall(claudeCacheLatest),
        codex_cache: summarizeCacheInstall(codexCacheLatest),
      },
      recommendations: pluginRecommendations({
        name,
        sourceVersion,
        marketplace: plugin.marketplace,
        claudeInstalled,
        claudeCacheLatest,
        codexCacheLatest,
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

function pluginRecommendations({ name, sourceVersion, marketplace, claudeInstalled, claudeCacheLatest, codexCacheLatest }) {
  const recommendations = [];
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
    recommendations.push({
      host: 'claude',
      action: 'install-plugin',
      executed: false,
      command: `claude /plugin install ${name}@agentic-plugins`,
      detail: 'Recommendation only; this PR does not execute plugin install/update.',
    });
  } else if (sourceVersion && claudeVersion && semverCompare(String(claudeVersion), String(sourceVersion)) < 0) {
    recommendations.push({
      host: 'claude',
      action: 'update-plugin',
      executed: false,
      command: `claude /plugin update ${name}@agentic-plugins`,
      detail: `Installed ${claudeVersion}; source/catalog ${sourceVersion}.`,
    });
  }

  const codexVersion = codexCacheLatest?.manifest_version ?? null;
  if (!codexCacheLatest) {
    recommendations.push({
      host: 'codex',
      action: 'add-marketplace',
      executed: false,
      command: 'codex plugin marketplace add each4all/agentic-plugins',
      detail: `Codex exposes marketplace add/upgrade/remove, not per-plugin install; add the marketplace catalog to make ${name} available.`,
    });
  } else if (sourceVersion && codexVersion && semverCompare(String(codexVersion), String(sourceVersion)) < 0) {
    recommendations.push({
      host: 'codex',
      action: 'upgrade-marketplace',
      executed: false,
      command: 'codex plugin marketplace upgrade agentic-plugins',
      detail: `Cached ${codexVersion}; source/catalog ${sourceVersion}. Codex upgrades the marketplace, not an individual plugin install.`,
    });
  }
  return recommendations;
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

function buildTopLevelRecommendations({ clis, plugins, desiredConfig, companionSettings }) {
  const recommendations = [];
  for (const [name, cli] of Object.entries(clis)) {
    if (cli.status !== 'available') {
      recommendations.push({
        area: 'cli',
        host: name,
        executed: false,
        detail: DEFAULT_HOST_INSTALL_COMMANDS[name],
      });
    }
  }
  for (const plugin of Object.values(buildPluginPlans(plugins))) {
    for (const recommendation of plugin.recommendations) {
      recommendations.push({ area: 'plugin', ...recommendation });
    }
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
  return recommendations;
}

function summarizeSettings(report) {
  const writeCount = report.config.targets.reduce((sum, target) => sum + target.planned_writes.length, 0);
  const appliedCount = report.config.targets.filter((target) => target.applied).length;
  const missingCli = Object.values(report.clis).filter((cli) => cli.status !== 'available').length;
  const settingWarnings = collectCompanionSettingWarnings(report.companion_settings).length;
  return {
    status: missingCli > 0 || settingWarnings > 0 ? 'warning' : 'pass',
    planned_config_writes: writeCount,
    applied_config_targets: appliedCount,
    plugin_recommendations: Object.values(report.plugins).reduce((sum, plugin) => sum + plugin.recommendations.length, 0),
    setting_warnings: settingWarnings,
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
  lines.push(`runtime:settings ${report.runtime_version} (${report.dry_run ? 'dry-run' : 'apply'})`);
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
    lines.push(`- ${name}: ${cli.status}; version=${cli.version.text || cli.version.status}`);
    if (cli.recommendation) lines.push(`  recommendation: ${cli.recommendation}`);
  }
  lines.push('');
  lines.push('Plugins');
  for (const name of PLUGIN_NAMES) {
    const plugin = report.plugins[name];
    lines.push(`- ${name}: ${plugin.status}; source=${plugin.source_version ?? 'n/a'}; recommendations=${plugin.recommendations.length}`);
    for (const recommendation of plugin.recommendations) {
      const command = recommendation.command ? ` command=${recommendation.command}` : '';
      lines.push(`  ${recommendation.host}: ${recommendation.action}; executed=false;${command}`);
    }
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

function usage() {
  return [
    'Usage: settings.mjs [--repo-root <path>] [--format text|json] [--host auto|claude|codex]',
    '  [--target repo|user|both] [--model <id>] [--effort <level>]',
    '  [--claude-model <id>] [--claude-effort <level>] [--codex-model <id>] [--codex-effort <level>]',
    '  [--apply]',
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
