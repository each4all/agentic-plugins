// The peer execution context: the FILESYSTEM-ONLY inputs a cross-host peer dispatch
// needs — which companion script to spawn, and which model/effort to hand it.
//
// Moved verbatim out of doctor.mjs (the `lib/state-readers.mjs` precedent) so
// `consensus.mjs` can resolve those two values without invoking `runDoctor`. It used
// to call runDoctor for exactly `companions.directions[k].selected.path` and
// `model_effort.directions[k].{model,effort}.value`, paying ~3.1s of host-CLI probing
// it never read — 14 `claude`/`codex` processes, each of which received the ambient
// egress credential that `settings.mjs` deliberately strips before its own runDoctor
// call (settings.mjs, ADR-0041 §2b/§2c).
//
// This module takes NO `env`, NO `runner` and NO `now`, and its import allowlist is pinned
// by `tests/runtime/test-peer-execution-context.mjs` (a `child_process` scan alone would
// not catch an import of doctor's `runCommand`). Together those make probing through this
// seam impossible by accident — not impossible in principle: a future author could still
// import a spawner here, and the allowlist test is what would stop them at review time.
//
// Doctor behavior is unchanged: doctor.mjs re-imports these and re-exports
// CONTRACT_COMPATIBLE_MAJOR, so its public surface is identical.
// Runtime-internal import only — the ADR-0010 §5 import ban is cross-plugin.

import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { readJsonIfExists, readTextIfExists } from './state-readers.mjs';
import { semverCompare } from './semver.mjs';

export const CONTRACT_COMPATIBLE_MAJOR = 0;

/**
 * Resolve everything a peer dispatch needs, from the filesystem alone.
 * Returns the same two sections doctor embeds as `report.companions` and
 * `report.model_effort`.
 *
 * `codexHome` honors `$CODEX_HOME` (machine-bootstrap-contract.md §2/§10.2); it is passed
 * as an already-resolved path so this env-free seam never reads `env` itself. It defaults
 * to `~/.codex` for callers that do not thread it.
 */
export async function resolvePeerExecutionContext({
  repoRoot,
  homeDir,
  codexHome = join(homeDir, '.codex'),
  explicitModel = null,
  explicitEffort = null,
}) {
  const [companions, modelEffort] = await Promise.all([
    inspectCompanionContract({ repoRoot, homeDir, codexHome }),
    inspectModelEffort({ repoRoot, homeDir, explicitModel, explicitEffort }),
  ]);
  return { companions, model_effort: modelEffort };
}

async function inspectCompanionContract({ repoRoot, homeDir, codexHome }) {
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
          baseDir: join(codexHome, 'plugins', 'cache', 'agentic-plugins', 'companions'),
          scriptRel: join('scripts', 'claude-companion.mjs'),
          manifestRel: join('.codex-plugin', 'plugin.json'),
        })),
        join(codexHome, '.tmp', 'marketplaces', 'agentic-plugins', 'plugins', 'companions', 'scripts', 'claude-companion.mjs'),
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

// A DELIBERATE private twin of `lib/runtime-config.mjs`'s exported parser: the two have
// different semantics and must not be merged. It was private in doctor.mjs and stays
// private here.
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
