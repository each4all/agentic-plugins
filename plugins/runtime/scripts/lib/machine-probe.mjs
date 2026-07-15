// The machine host probe: the MACHINE-ONLY facts a runtime consumer needs about the
// operator's machine — host CLI presence/version/auth/feature-surface, installed-plugin
// rows per host, plugin cache state, and the OBSERVED Codex hook config — resolved from
// nothing but `$HOME` / `$CODEX_HOME` / the host CLIs.
//
// Extracted verbatim out of doctor.mjs (the `lib/peer-execution-context.mjs` and
// `lib/state-readers.mjs` precedent) so `runtime:bootstrap` can reason about a machine
// WITHOUT invoking `runDoctor` — which unconditionally reads the agentic-plugins source
// tree (`inspectSourcePluginState`, `inspectCatalogs`), repo settings runs, doctor
// proofs, ledgers, consensus/compat runs, and baseline data. `runDoctor` now sources its
// machine half from this ONE implementation, so the two cannot drift
// (machine-bootstrap-contract.md §1.1).
//
// The three normative details the seam pins (§1.1):
//   - `cwd` is NEUTRAL: host CLIs never run inside the caller's repository, so a repo-local
//     plugin scope cannot leak into a machine answer. Default: os.tmpdir().
//   - `codexHome` honors `$CODEX_HOME`: today's cache and hook reads hardcode `~/.codex`.
//   - Output is credential-scrubbed and carries no raw CLI stdout before it reaches an
//     artifact; the runner receives a bounded `timeoutMs`.
//
// This module takes `runner` as an injected dependency (like doctor's `inspectCli` did)
// and therefore imports NO `node:child_process` — it is not a capability importer. The
// ADR-0035 §4 executor registry recognizes its `runner(name, …)` fan-out + inline probe
// argv (tests/plugin-shape/runtime-executor-registry.mjs).

import { readdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { singleLine, redactSecrets, sanitizeValue } from './permission-sanitize.mjs';
import { readJsonIfExists, readTextIfExists, resolveCodexHome } from './state-readers.mjs';
import { semverCompare } from './semver.mjs';

// $CODEX_HOME resolution lives in the host-CLI-free state-readers leaf (so importing it
// does not drag this probe — which NAMES host CLIs — into a spawn-sensitive closure);
// re-exported here because CODEX_HOME is a machine fact this module owns conceptually.
export { resolveCodexHome };

// The agentic-plugins machine plugin inventory — the single source of truth for the
// installed-manifest scans here AND doctor's source-tree scan (doctor re-exports it).
export const PLUGIN_NAMES = ['attention', 'companions', 'designer', 'engineer', 'founder', 'image', 'orchestrator', 'runtime'];

const DEFAULT_PROBE_TIMEOUT_MS = 5000;
const CLAUDE_PLUGIN_SURFACE_UNAVAILABLE_RE = /\/plugin (?:isn't|is not) available in this environment/i;

/**
 * Probe the machine-only host facts. Pure: reads $HOME / $CODEX_HOME / the injected host
 * CLIs, and nothing repo-scoped. Returns a structured object runDoctor maps into the same
 * report fields it builds today, plus the normalized installed rows the bootstrap contract
 * (§1.1) requires.
 */
export async function probeMachineHostState({
  homeDir = homedir(),
  codexHome,
  env = process.env,
  cwd,
  runner,
  timeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
} = {}) {
  if (typeof runner !== 'function') {
    throw new Error('probeMachineHostState requires an injected runner');
  }
  const resolvedHomeDir = resolve(homeDir);
  const resolvedCodexHome = codexHome ? resolve(codexHome) : resolveCodexHome(env, resolvedHomeDir);
  // NEUTRAL cwd: never the caller's repository (§1.1). Default to os.tmpdir().
  const probeCwd = cwd ? resolve(cwd) : tmpdir();

  const [claudeRaw, codexRaw] = await Promise.all([
    inspectCli('claude', {
      versionArgs: ['--version'],
      helpArgs: ['--help'],
      extraHelpArgs: ['plugin', '--help'],
      authArgs: ['auth', 'status'],
      pluginArgs: ['plugin', 'list'],
      pluginSurfaceArgs: ['/plugin', 'list'],
      runner,
      cwd: probeCwd,
      env,
      timeoutMs,
    }),
    inspectCli('codex', {
      versionArgs: ['--version'],
      helpArgs: ['--help'],
      extraHelpArgs: ['exec', '--help'],
      featureArgs: ['features', 'list'],
      authArgs: ['login', 'status'],
      pluginArgs: ['plugin', 'marketplace', '--help'],
      pluginRootHelpArgs: ['plugin', '--help'],
      pluginListArgs: ['plugin', 'list', '--json'],
      runner,
      cwd: probeCwd,
      env,
      timeoutMs,
    }),
  ]);

  // Parse the installed lists from the raw stdout BEFORE it is scrubbed — the raw blobs
  // never leave this module (§1.1, peer #12).
  const claudePluginList = parseClaudePluginList(claudeRaw.plugin?.stdout ?? '');
  const codexPluginList = parseCodexPluginList(codexRaw.plugin_list);

  const [caches, codexHookConfig] = await Promise.all([
    inspectPluginCaches({ homeDir: resolvedHomeDir, codexHome: resolvedCodexHome }),
    readObservedCodexHookConfig({ codexHome: resolvedCodexHome }),
  ]);

  return {
    codexHome: resolvedCodexHome,
    claude: scrubCliRaw(claudeRaw),
    codex: scrubCliRaw(codexRaw),
    caches,
    claudePluginList,
    codexPluginList,
    installed: normalizeInstalledRows({ claudePluginList, codexPluginList }),
    codexHookConfig,
  };
}

// Normalize both hosts' installed rows to the ONE contract shape
// {id, version, scope, enabled} (machine-bootstrap-contract.md §1.1, peer #4). Claude has
// no `plugin list --json` in the executor registry, so its TEXT parse is normalized here
// rather than switching to an unverified --json path; Codex `--json` already carries these.
function normalizeInstalledRows({ claudePluginList, codexPluginList }) {
  const claude = Object.values(claudePluginList).map((row) => ({
    id: row.name,
    version: row.version ?? null,
    scope: row.scope ?? null,
    enabled: row.status === 'enabled' ? true : row.status === 'failed' ? false : null,
  }));
  const codex = Object.values(codexPluginList.entries ?? {}).map((row) => ({
    id: row.name,
    version: row.version ?? null,
    // Codex `plugin list --json` has no per-plugin scope concept (it is a per-plugin
    // install, not a Claude scope); keep the key for shape parity, value null.
    scope: null,
    enabled: typeof row.enabled === 'boolean' ? row.enabled : null,
  }));
  return { claude, codex };
}

// Strip the raw CLI stdout/stderr blobs from the cli facts before they leave the module —
// only normalized statuses/exit codes survive (§1.1, peer #12). Every downstream doctor
// consumer reads .plugin/.plugin_list only via {status, exit_code, error_code}; the raw
// stdout was consumed by the list parsers above.
function scrubCliRaw(cli) {
  const scrubbed = { ...cli };
  if (cli.plugin) {
    scrubbed.plugin = { status: cli.plugin.status, exit_code: cli.plugin.exit_code, error_code: cli.plugin.error_code };
  }
  if (cli.plugin_list) {
    scrubbed.plugin_list = { status: cli.plugin_list.status, exit_code: cli.plugin_list.exit_code, error_code: cli.plugin_list.error_code };
  }
  return scrubbed;
}

// ---------------------------------------------------------------------------
// Host CLI inspection
// ---------------------------------------------------------------------------

async function inspectCli(name, { versionArgs, helpArgs, extraHelpArgs = null, featureArgs = null, authArgs, pluginArgs, pluginSurfaceArgs = null, pluginRootHelpArgs = null, pluginListArgs = null, runner, cwd, env, timeoutMs }) {
  const version = await runner(name, versionArgs, { cwd, env, timeoutMs });
  const available = version.ok || version.exit_code !== null;
  const help = available ? await runner(name, helpArgs, { cwd, env, timeoutMs }) : skipped('cli unavailable');
  const extraHelp = available && extraHelpArgs ? await runner(name, extraHelpArgs, { cwd, env, timeoutMs }) : skipped('not requested');
  const featuresRaw = available && featureArgs ? await runner(name, featureArgs, { cwd, env, timeoutMs }) : skipped('not requested');
  const authRaw = available ? await runner(name, authArgs, { cwd, env, timeoutMs }) : skipped('cli unavailable');
  const pluginRaw = available ? await runner(name, pluginArgs, { cwd, env, timeoutMs }) : skipped('cli unavailable');
  const pluginSurfaceRaw = available && pluginSurfaceArgs ? await runner(name, pluginSurfaceArgs, { cwd, env, timeoutMs }) : skipped('not requested');
  // Codex `plugin --help` is captured separately so the per-plugin add/list/remove
  // subcommands are detected from their own Commands block, not from loose substring
  // matching over the combined help blob (which also carries marketplace add/list/remove).
  const pluginRootHelpRaw = available && pluginRootHelpArgs ? await runner(name, pluginRootHelpArgs, { cwd, env, timeoutMs }) : skipped('not requested');
  const pluginListRaw = available && pluginListArgs ? await runner(name, pluginListArgs, { cwd, env, timeoutMs }) : skipped('not requested');
  const auth = name === 'claude' ? parseClaudeAuth(authRaw, env) : parseCodexAuth(authRaw);
  const featureText = name === 'claude'
    ? `${help.stdout}\n${help.stderr}\n${extraHelp.stdout}\n${extraHelp.stderr}\n${pluginRaw.stdout}\n${pluginRaw.stderr}\n${pluginSurfaceRaw.stdout}\n${pluginSurfaceRaw.stderr}`
    : `${help.stdout}\n${help.stderr}\n${extraHelp.stdout}\n${extraHelp.stderr}\n${pluginRaw.stdout}\n${pluginRaw.stderr}`;
  const pluginRootHelpText = `${pluginRootHelpRaw.stdout}\n${pluginRootHelpRaw.stderr}`;
  const featureSurface = name === 'claude'
    ? inspectClaudeFeatureSurface(featureText)
    : inspectCodexFeatureSurface(featureText, featuresRaw, pluginRootHelpText);

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
    plugin_list: {
      status: commandStatus(pluginListRaw),
      stdout: pluginListRaw.stdout,
      stderr: pluginListRaw.stderr,
      exit_code: pluginListRaw.exit_code,
      error_code: pluginListRaw.error_code,
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

// ---------------------------------------------------------------------------
// Host auth parsers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Host feature-surface parsers
// ---------------------------------------------------------------------------

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

function inspectCodexFeatureSurface(helpText, featuresRaw, pluginRootHelpText = '') {
  const featureList = parseCodexFeatureList(featuresRaw);
  const hooks = featureList.features.hooks ?? null;
  const pluginHooks = featureList.features.plugin_hooks ?? null;
  // Per-plugin surface (Codex >= ~0.137): detect the `codex plugin add/list/remove`
  // subcommands precisely from the `codex plugin --help` Commands block. `^\s+<cmd>\b`
  // matches only an indented subcommand entry, never a description word ("Add," in the
  // marketplace subcommand line), a flag (`--add`), or a longer token ("added").
  const pluginAddCommand = /^\s+add\b/im.test(pluginRootHelpText);
  const pluginListCommand = /^\s+list\b/im.test(pluginRootHelpText);
  const pluginRemoveCommand = /^\s+remove\b/im.test(pluginRootHelpText);
  return {
    exec_command: /\bexec\b[\s\S]*Run Codex non-interactively/i.test(helpText) || /\bexec\b/.test(helpText),
    login_status: /\blogin\b[\s\S]*\bstatus\b/i.test(helpText),
    plugin_marketplace: /\bplugin\b[\s\S]*\bmarketplace\b/i.test(helpText),
    plugin_marketplace_add: /\badd\b/.test(helpText),
    plugin_marketplace_list: /\blist\b/.test(helpText),
    plugin_marketplace_upgrade: /\bupgrade\b/.test(helpText),
    plugin_marketplace_remove: /\bremove\b/.test(helpText),
    // `codex plugin add` is Codex's per-plugin install verb; `list`/`remove` are the
    // per-plugin inventory/uninstall verbs. Absent: update/enable/disable/details/
    // validate/prune (not full Claude plugin parity).
    plugin_install_command: pluginAddCommand,
    plugin_list_command: pluginListCommand,
    plugin_remove_command: pluginRemoveCommand,
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

// ---------------------------------------------------------------------------
// Installed-plugin list parsers
// ---------------------------------------------------------------------------

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

// Parse `codex plugin list --json` into a sanitized, Claude-comparable installed
// map. STDOUT only — Codex 0.137 prints valid JSON on stdout while emitting
// warnings on stderr, so a non-empty stderr must NOT downgrade a successful
// parse. Never throws: a missing/older subcommand, nonzero exit, or malformed
// JSON degrades to a status that callers treat as "list unavailable -> cache
// fallback" (ADR-0034). Raw JSON / source paths are NOT retained — only the
// fields the readiness decision needs.
function parseCodexPluginList(pluginListResult) {
  const degraded = (status) => ({ status, entries: {}, warnings: [] });
  if (!pluginListResult || pluginListResult.error_code === 'skipped') return degraded('unavailable');
  // commandStatus() returns 'available' only when the probe ran successfully
  // (ok). A present-but-older Codex returns a nonzero "unknown subcommand"
  // ('unknown'); a missing CLI returns ENOENT ('unavailable'). Both are
  // non-authoritative -> fallback; the label is reporting-only.
  if (pluginListResult.status !== 'available') {
    return degraded(pluginListResult.error_code === 'ENOENT' ? 'unavailable' : 'unsupported');
  }
  const stdout = (pluginListResult.stdout ?? '').trim();
  if (!stdout) return degraded('empty');
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return degraded('parse_error');
  }
  if (!parsed || !Array.isArray(parsed.installed)) return degraded('malformed');
  const entries = {};
  const warnings = [];
  for (const raw of parsed.installed) {
    if (!raw || typeof raw.name !== 'string' || raw.marketplaceName !== 'agentic-plugins') continue;
    const installed = raw.installed === true;
    const enabled = typeof raw.enabled === 'boolean' ? raw.enabled : null;
    const status = !installed
      ? 'not_installed'
      : enabled === true ? 'enabled' : enabled === false ? 'disabled' : 'installed';
    const candidate = {
      name: raw.name,
      marketplace: 'agentic-plugins',
      version: typeof raw.version === 'string' ? raw.version : null,
      installed,
      enabled,
      status,
      install_policy: typeof raw.installPolicy === 'string' ? raw.installPolicy : null,
      auth_policy: typeof raw.authPolicy === 'string' ? raw.authPolicy : null,
      error: null,
    };
    if (entries[raw.name]) {
      warnings.push(`duplicate agentic-plugins entry for ${raw.name}; kept strongest install state`);
      entries[raw.name] = pickStrongerCodexEntry(entries[raw.name], candidate);
    } else {
      entries[raw.name] = candidate;
    }
  }
  return { status: 'available', entries, warnings };
}

const CODEX_INSTALL_STATUS_RANK = { enabled: 4, installed: 3, disabled: 2, not_installed: 1 };
function pickStrongerCodexEntry(a, b) {
  const ra = CODEX_INSTALL_STATUS_RANK[a.status] ?? 0;
  const rb = CODEX_INSTALL_STATUS_RANK[b.status] ?? 0;
  return rb > ra ? b : a;
}

// Single-source the Codex installed-state decision used across the doctor report
// (plugin matrix status, readiness row, version parity). List-authoritative:
// when the list probe succeeded, the list is the source of truth and a stale
// filesystem cache must NOT claim an install the list omits; only a
// list-unavailable probe (older Codex, nonzero exit, parse error) falls back to
// cache evidence (decision='fallback', caller applies existing cache logic).
// Read-only; never mutates host state (ADR-0024 / ADR-0034).
//
// `name` is the plugin the decision is about. It exists only to render an
// honest evidence string: the not-installed branch used to hardcode "runtime",
// so a not-installed `designer` reported "codex plugin list does not report
// runtime as installed". The founder RT slice (ADR-0036) recorded this as a
// deferred generic-name fix; the designer RT slice closes it, because the
// inventory addition is exactly what surfaces the wrong name to an operator.
export function resolveCodexInstallState({ name, listStatus, entry }) {
  if (listStatus === 'available') {
    if (entry) {
      // Defensive: an `installed:false` entry (only expected under --available,
      // which we never pass) must resolve to not-installed, not the installed
      // fall-through below.
      if (entry.status === 'not_installed') {
        return { decision: 'not_installed', source: 'list', version: null, enabled: false, evidence: 'codex plugin list reports the entry as not installed' };
      }
      if (entry.status === 'disabled') {
        return { decision: 'disabled', source: 'list', version: entry.version ?? null, enabled: false, evidence: 'codex plugin list reports installed but disabled' };
      }
      if (entry.status === 'enabled') {
        return { decision: 'installed', source: 'list', version: entry.version ?? null, enabled: true, evidence: 'codex plugin list reports enabled' };
      }
      return { decision: 'installed', source: 'list', version: entry.version ?? null, enabled: entry.enabled ?? null, evidence: 'codex plugin list reports installed' };
    }
    return { decision: 'not_installed', source: 'list', version: null, enabled: false, evidence: `codex plugin list does not report ${name} as installed` };
  }
  return { decision: 'fallback', source: 'cache', version: null, enabled: null, evidence: null, list_probe_status: listStatus };
}

// ---------------------------------------------------------------------------
// Plugin cache inspection ($HOME / $CODEX_HOME reads)
// ---------------------------------------------------------------------------

async function inspectPluginCaches({ homeDir, codexHome }) {
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
      baseDir: join(codexHome, 'plugins', 'cache', 'agentic-plugins', name),
      manifestRel: join('.codex-plugin', 'plugin.json'),
    });
    result.codex_tmp_marketplace[name] = await readSingleManifest({
      manifestPath: join(
        codexHome,
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

// ---------------------------------------------------------------------------
// Manifest / hooks-file inspection — shared by this module's cache scan AND
// doctor's source-tree scan (doctor imports these), so there is one parser.
// ---------------------------------------------------------------------------

export function summarizeManifestHookField(value) {
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

export async function manifestHooksFileSummary({ pluginRoot, manifestHooks }) {
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

export async function hooksFileSummary(path) {
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

// A private twin of doctor's trivial dedup util (kept local so this pure module
// carries no import for a two-line helper); both are non-consequential.
function uniqueStrings(values) {
  return [...new Set(values.filter((value) => typeof value === 'string' && value.length > 0))];
}

// ---------------------------------------------------------------------------
// Observed Codex hook config — the READ + PARSE half only. The correlation of
// these entries against repo-derived expected review targets STAYS in doctor
// (machine-bootstrap-contract.md §1.1, peer #11): doctor imports the normalize
// helpers below and does its own enrichment.
// ---------------------------------------------------------------------------

async function readObservedCodexHookConfig({ codexHome }) {
  const configPath = join(codexHome, 'config.toml');
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
  return {
    config_path: configPath,
    config_status: currentText.ok ? 'available' : 'missing',
    read_error: currentText.ok ? null : currentText.reason,
    entries,
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

export function normalizeCodexHookStatePath(path, plugin) {
  const text = sanitizeValue(path);
  if (!text) return null;
  const normalized = text.replaceAll('\\', '/').replace(/^\.\//, '');
  if (plugin) {
    const marker = `/plugins/${plugin}/`;
    const markerIndex = normalized.indexOf(marker);
    if (markerIndex >= 0) return normalized.slice(markerIndex + marker.length);
    const bareMarker = `plugins/${plugin}/`;
    if (normalized.startsWith(bareMarker)) return normalized.slice(bareMarker.length);
    // Versioned install-cache layout (`…/cache/agentic-plugins/<plugin>/<version>/…`):
    // Codex writes hooks.state paths RELATIVE to the plugin root regardless of
    // install origin, but cache inspection records the absolute hooks-file
    // path. Without this marker a cache-only consumer repo (no plugins/
    // source) could never match a single hooks.state row — every expected
    // entry read `missing` and every trusted row read unexpected
    // (refine-verify reproduced expected_missing=14 / unexpected=14), which
    // also kept the attestation disabled-gate unreachable.
    const escapedPlugin = plugin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const cacheMarker = new RegExp(`(?:^|/)${escapedPlugin}/\\d+\\.\\d+\\.\\d+[^/]*/`);
    const cacheMatch = normalized.match(cacheMarker);
    if (cacheMatch) return normalized.slice(cacheMatch.index + cacheMatch[0].length);
  }
  return normalized;
}

export function normalizeCodexHookStateEvent(event) {
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
