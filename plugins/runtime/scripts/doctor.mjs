#!/usr/bin/env node
// plugins/runtime/scripts/doctor.mjs
//
// ADR-0024 first implementation: read-only runtime/operator diagnosis.
// This script deliberately observes and reports. It does not install plugins,
// authenticate hosts, mutate config, sweep ledgers, or execute peer agents.

import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const RUNTIME_VERSION = '0.1.0';
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
} = {}) {
  const resolvedRepoRoot = resolve(repoRoot);
  const resolvedHomeDir = resolve(homeDir);
  const startedAt = now.toISOString();

  const [claude, codex] = await Promise.all([
    inspectCli('claude', {
      versionArgs: ['--version'],
      helpArgs: ['--help'],
      authArgs: ['auth', 'status'],
      pluginArgs: ['plugin', 'list'],
      runner,
      cwd: resolvedRepoRoot,
      env,
    }),
    inspectCli('codex', {
      versionArgs: ['--version'],
      helpArgs: ['--help'],
      extraHelpArgs: ['exec', '--help'],
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

  const readiness = buildReadiness({
    claude,
    codex,
    companion,
    deepPeerSmoke,
  });
  const deepPeerSmokeSection = buildDeepPeerSmokeSection({
    requested: deepPeerSmoke,
    readiness,
    modelEffort,
  });

  const report = {
    schema_version: 'runtime-doctor-1.0',
    runtime_version: RUNTIME_VERSION,
    generated_at: startedAt,
    repo_root: resolvedRepoRoot,
    host,
    read_only: true,
    deep_peer_smoke: deepPeerSmokeSection,
    clis: {
      claude: redactCommandDetails(claude),
      codex: redactCommandDetails(codex),
    },
    plugins,
    companions: companion,
    model_effort: modelEffort,
    readiness,
    ledgers,
    limits: [
      'Codex plugin-local automatic hooks are not assumed; doctor reports manual-hook limits.',
      'Sandbox/permission readiness is inferred from read-only probes unless a future deep smoke implementation runs.',
      'Settings mutation belongs to runtime:settings; dynamic consensus, context hygiene, and completion footer mutation are deferred.',
    ],
  };
  report.overall = summarizeOverall(report);
  report.output_format = format;
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

async function inspectCli(name, { versionArgs, helpArgs, extraHelpArgs = null, authArgs, pluginArgs, runner, cwd, env }) {
  const version = await runner(name, versionArgs, { cwd, env });
  const available = version.ok || version.exit_code !== null;
  const help = available ? await runner(name, helpArgs, { cwd, env }) : skipped('cli unavailable');
  const extraHelp = available && extraHelpArgs ? await runner(name, extraHelpArgs, { cwd, env }) : skipped('not requested');
  const authRaw = available ? await runner(name, authArgs, { cwd, env }) : skipped('cli unavailable');
  const pluginRaw = available ? await runner(name, pluginArgs, { cwd, env }) : skipped('cli unavailable');
  const auth = name === 'claude' ? parseClaudeAuth(authRaw) : parseCodexAuth(authRaw);
  const featureSurface = name === 'claude'
    ? inspectClaudeFeatureSurface(`${help.stdout}\n${help.stderr}`)
    : inspectCodexFeatureSurface(`${help.stdout}\n${help.stderr}\n${extraHelp.stdout}\n${extraHelp.stderr}`);

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
    plugin: {
      status: commandStatus(pluginRaw),
      stdout: pluginRaw.stdout,
      stderr: pluginRaw.stderr,
      exit_code: pluginRaw.exit_code,
      error_code: pluginRaw.error_code,
    },
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

function parseClaudeAuth(result) {
  if (!result.ok) {
    return classifyAuthFailure(result);
  }
  try {
    const json = JSON.parse(result.stdout);
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
    return { status: 'unauthenticated', logged_in: false, sensitive_fields_redacted: [] };
  } catch {
    const text = singleLine(`${result.stdout} ${result.stderr}`);
    if (/not logged in|login required|unauth/i.test(text)) {
      return { status: 'unauthenticated', logged_in: false, sensitive_fields_redacted: [] };
    }
    return { status: 'unknown', logged_in: null, detail: redactSecrets(text), sensitive_fields_redacted: [] };
  }
}

function parseCodexAuth(result) {
  if (!result.ok) {
    return classifyAuthFailure(result);
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

function classifyAuthFailure(result) {
  const text = singleLine(`${result.stdout} ${result.stderr} ${result.error_message ?? ''}`);
  if (result.error_code === 'ENOENT') return { status: 'unavailable', logged_in: null, detail: 'cli unavailable' };
  if (result.error_code === 'ETIMEDOUT') return { status: 'blocked', logged_in: null, detail: 'auth status probe timed out' };
  if (/not logged in|login required|unauth/i.test(text)) return { status: 'unauthenticated', logged_in: false };
  return { status: 'unknown', logged_in: null, detail: redactSecrets(text) };
}

function inspectClaudeFeatureSurface(helpText) {
  return {
    plugin_command: /\bplugin\|plugins\b|\bplugins?\s+Manage Claude Code plugins/i.test(helpText),
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

function inspectCodexFeatureSurface(helpText) {
  return {
    exec_command: /\bexec\b[\s\S]*Run Codex non-interactively/i.test(helpText) || /\bexec\b/.test(helpText),
    login_status: /\blogin\b[\s\S]*\bstatus\b/i.test(helpText),
    plugin_marketplace: /\bplugin\b[\s\S]*\bmarketplace\b/i.test(helpText),
    model_flag: /--model\b|-m,\s*--model/.test(helpText),
    config_flag: /--config\b|-c,\s*--config/.test(helpText),
    cd_flag: /--cd\b|-C,\s*--cd/.test(helpText),
    sandbox_flag: /--sandbox\b/.test(helpText),
    approval_flag: /--ask-for-approval\b/.test(helpText),
    automatic_plugin_hooks: false,
  };
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
    versions.push({
      version_dir: entry.name,
      manifest_version: manifest.json.version ?? null,
      manifest_name: manifest.json.name ?? null,
      path: dirname(dirname(manifestPath)),
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
      namespace: 'agentic-engineer',
      expectedPlugin: 'engineer',
      now,
      staleGraceMs,
    }),
    orchestrator: await inspectWorkflowNamespace({
      repoRoot,
      namespace: 'agentic-orchestrator',
      expectedPlugin: 'orchestrator',
      now,
      staleGraceMs,
    }),
  };
}

async function inspectWorkflowNamespace({ repoRoot, namespace, expectedPlugin, now, staleGraceMs }) {
  const root = join(repoRoot, '.claude', namespace);
  const workflowsDir = join(root, 'workflows');
  const peerRunsDir = join(root, 'peer-runs');
  const workflows = await scanWorkflowFiles(workflowsDir);
  const peerRuns = await scanPeerRuns(peerRunsDir, expectedPlugin, now, staleGraceMs);
  return {
    root,
    workflows,
    peer_runs: peerRuns,
  };
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

function buildReadiness({ claude, codex, companion, deepPeerSmoke }) {
  return {
    claude_to_codex: buildDirectionReadiness({
      direction: 'Claude -> Codex',
      caller: claude,
      peer: codex,
      companion: companion.directions.claude_to_codex,
      requiredPeerFeatures: ['exec_command', 'model_flag', 'config_flag', 'cd_flag'],
      deepPeerSmoke,
    }),
    codex_to_claude: buildDirectionReadiness({
      direction: 'Codex -> Claude',
      caller: codex,
      peer: claude,
      companion: companion.directions.codex_to_claude,
      requiredPeerFeatures: ['print_mode', 'no_session_persistence', 'model_flag', 'effort_flag'],
      deepPeerSmoke,
    }),
  };
}

function buildDeepPeerSmokeSection({ requested, readiness, modelEffort }) {
  const directions = {};
  for (const key of ['claude_to_codex', 'codex_to_claude']) {
    const directionReadiness = readiness[key];
    const directionSettings = modelEffort.directions[key];
    const blocked = directionReadiness.blockers.length > 0;
    directions[key] = {
      direction: directionReadiness.direction,
      requested,
      execution: 'not_executed',
      status: !requested ? 'not_requested' : blocked ? directionReadiness.status : 'ready_with_warnings',
      plan: requested
        ? 'plan-only preflight; no peer agent is executed by runtime:doctor'
        : 'not requested',
      model: directionSettings.model,
      effort: directionSettings.effort,
      blockers: directionReadiness.blockers,
      warnings: directionReadiness.warnings,
      next_step: requested
        ? blocked
          ? 'resolve blockers before a future explicit peer smoke executor is attempted'
          : 'future executor work may use this preflight to run a manual or explicitly approved peer smoke'
        : 'rerun with --deep-peer-smoke to include this plan-only preflight',
    };
  }
  return {
    requested,
    executed: false,
    mode: 'plan_only_preflight',
    status: summarizeDeepPeerSmokePlanStatus({ requested, directions }),
    reason: requested
      ? 'runtime:doctor plans the explicit deep peer smoke preflight but does not execute peer agents'
      : 'not requested',
    directions,
    limits: [
      'Plan-only preflight; runtime:doctor does not execute peer agents.',
      'No host-native config, auth, secrets, sandbox, or permission state is mutated.',
      'Codex manual-hook and permission limits remain visible; no host parity claim is made.',
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

function buildDirectionReadiness({ direction, caller, peer, companion, requiredPeerFeatures, deepPeerSmoke }) {
  const blockers = [];
  const warnings = [];
  if (caller.status !== 'available') blockers.push(`${caller.name} CLI unavailable`);
  if (peer.status !== 'available') blockers.push(`${peer.name} CLI unavailable`);
  if (peer.auth.status === 'unauthenticated') blockers.push(`${peer.name} unauthenticated`);
  if (peer.auth.status === 'blocked') blockers.push(`${peer.name} auth probe blocked`);
  if (companion.status !== 'available') blockers.push(`companion ${companion.filename} ${companion.status}`);
  for (const feature of requiredPeerFeatures) {
    if (peer.feature_surface[feature] !== true) warnings.push(`${peer.name} feature not observed: ${feature}`);
  }
  if (caller.name === 'codex') {
    warnings.push('Codex plugin-local automatic hooks are not assumed; manual skill invocation is the supported path');
  }
  warnings.push('sandbox/permission readiness is not verified by read-only doctor v0.1; blocked states require a future explicit smoke or host permission probe');
  if (!deepPeerSmoke) {
    warnings.push('read-only inference only; no peer-agent smoke executed');
  } else {
    warnings.push('deep peer smoke requested but not executed by runtime:doctor v0.1');
  }
  return {
    direction,
    status: blockers.length > 0 ? classifyPrimaryBlocker(blockers) : warnings.length > 0 ? 'available_with_warnings' : 'available',
    blockers,
    warnings,
    sandbox_permission: {
      status: 'unknown',
      reason: 'read-only doctor v0.1 does not execute peer agents or inspect host permission state',
    },
  };
}

function classifyPrimaryBlocker(blockers) {
  if (blockers.some((b) => /unavailable/.test(b))) return 'unavailable';
  if (blockers.some((b) => /unauthenticated/.test(b))) return 'unauthenticated';
  if (blockers.some((b) => /blocked/.test(b))) return 'blocked';
  return 'not_installed';
}

function summarizeOverall(report) {
  const hardFailures = [];
  for (const [name, cli] of Object.entries(report.clis)) {
    if (cli.status !== 'available') hardFailures.push(`${name} cli ${cli.status}`);
    if (cli.auth.status === 'unauthenticated') hardFailures.push(`${name} auth unauthenticated`);
  }
  for (const [direction, readiness] of Object.entries(report.readiness)) {
    if (!['available', 'available_with_warnings'].includes(readiness.status)) hardFailures.push(`${direction} ${readiness.status}`);
  }
  const warnings = [];
  for (const [name, plugin] of Object.entries(report.plugins)) {
    if (!['available', 'source_available'].includes(plugin.status)) warnings.push(`${name} plugin ${plugin.status}`);
  }
  for (const [name, ledger] of Object.entries(report.ledgers)) {
    if (ledger.workflows.status === 'blocked') warnings.push(`${name} workflow files malformed`);
    if (ledger.peer_runs.status === 'blocked') warnings.push(`${name} peer-run ledger needs attention`);
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
  lines.push('');
  lines.push('Host CLIs');
  for (const name of ['claude', 'codex']) {
    const cli = report.clis[name];
    lines.push(`- ${name}: ${cli.status}; version=${cli.version.text || cli.version.status}; auth=${cli.auth.status}`);
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
    for (const blocker of readiness.blockers) lines.push(`  blocker: ${blocker}`);
    for (const warning of readiness.warnings) lines.push(`  warning: ${warning}`);
  }
  lines.push('');
  if (report.deep_peer_smoke.requested) {
    lines.push('Deep Peer Smoke');
    lines.push(`- mode: ${report.deep_peer_smoke.mode}; requested=${report.deep_peer_smoke.requested}; executed=${report.deep_peer_smoke.executed}; status=${report.deep_peer_smoke.status}`);
    for (const key of ['claude_to_codex', 'codex_to_claude']) {
      const direction = report.deep_peer_smoke.directions[key];
      lines.push(`- ${direction.direction}: ${direction.status}; execution=${direction.execution}; model=${direction.model.value ?? '<host-default>'}; effort=${direction.effort.value ?? '<host-default>'}`);
      lines.push(`  plan: ${direction.plan}`);
      if (direction.blockers.length > 0) {
        for (const blocker of direction.blockers) lines.push(`  blocker: ${blocker}`);
      }
      lines.push(`  next: ${direction.next_step}`);
    }
    for (const limit of report.deep_peer_smoke.limits) lines.push(`- limit: ${limit}`);
    lines.push('');
  }
  lines.push('Ledgers');
  for (const key of ['engineer', 'orchestrator']) {
    const ledger = report.ledgers[key];
    lines.push(`- ${key}: workflows=${ledger.workflows.count}/${ledger.workflows.status}; peer-runs=${ledger.peer_runs.count}/${ledger.peer_runs.status}; stale=${ledger.peer_runs.stale_non_terminal}`);
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
    plugin_command_status: {
      status: cli.plugin.status,
      exit_code: cli.plugin.exit_code,
      error_code: cli.plugin.error_code,
    },
  };
}

async function readJsonIfExists(path) {
  try {
    const text = await readFile(path, 'utf8');
    return { ok: true, path, json: JSON.parse(text) };
  } catch (err) {
    return { ok: false, path, reason: err.code ?? err.message };
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

function parseNonNegativeInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function sanitizeValue(value) {
  if (value === null || value === undefined) return null;
  return redactSecrets(singleLine(String(value)));
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
  return `Usage: doctor.mjs [--repo-root <path>] [--format text|json] [--host auto|claude|codex] [--model <id>] [--effort <level>] [--deep-peer-smoke]\n`;
}

export function parseArgs(argv) {
  const opts = {
    repoRoot: process.cwd(),
    format: 'text',
    host: 'auto',
    explicitModel: null,
    explicitEffort: null,
    deepPeerSmoke: false,
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
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
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
