// Shared session-capture readiness assessment (ADR-0044 §3, S4;
// session-capture-contract.md §13). The doctor and settings surfaces both
// consume THIS module so the operator diagnosis can never disagree with
// itself across surfaces, and both read the same `loadSessionConfig` loader
// the publish-session executor gates on — one authority for what "on" means.
//
// The assessment is strictly read-only (filesystem + env reads, no
// subprocess): it must be runnable from the settings `local_plan` scope,
// whose contract forbids host-CLI probes. Host-CLI evidence that only a
// probe can supply (Claude plugin-list enablement) is therefore INJECTED by
// probe-owning callers via `attentionEnablement` and reported honestly as
// `unverified` when absent — never guessed from the filesystem.
//
// The publisher floor is detected DYNAMICALLY from the installed attention
// build's declaration file (contract §13). Runtime never hardcodes an
// attention floor constant: before attention ships the capture sensor (S5)
// the declaration does not exist anywhere, and pinning a planned-but-
// unreleased version would violate the ADR-0043 released-floor rule.

import { readFileSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import { loadSessionConfig } from './runtime-config.mjs';
import { semverCompare } from './semver.mjs';

// Contract §13 — the declaration file attention ships relative to its
// plugin root, and the schema-id family the consumer accepts. Unlike the
// slot/entry/note schemas (same-runtime producer and consumer, exact-pin),
// this file crosses plugin versions by design, so any 1.x minor is read.
export const ATTENTION_RUNTIME_FLOORS_REL_PATH = join('data', 'runtime-floors.json');
export const ATTENTION_RUNTIME_FLOORS_SCHEMA_RE = /^attention-runtime-floors-1\.\d+$/;

// The v1 firing point is the Claude Stop sensor (ADR-0044 §8), so the
// Claude plugin cache is the load-bearing install location — a Codex-only
// attention install cannot fire the publisher and does not count as ready.
const ATTENTION_CLAUDE_CACHE_SEGMENTS = ['.claude', 'plugins', 'cache', 'agentic-plugins', 'attention'];

// Contract §13: the declared floor is a plain released X.Y.Z — the
// ADR-0043 released-floor rule means a prerelease/build-suffixed floor is
// never a valid declaration, so it is malformed (fail-closed), which also
// keeps the numeric semverCompare sufficient for the comparison.
const CLEAN_RELEASE_SEMVER_RE = /^\d+\.\d+\.\d+$/;

// Half-enabled / blocking states (contract §13). Composable: a machine can
// be in safe mode AND below floor; every applicable state is reported.
export const SESSION_READINESS_STATES = Object.freeze([
  'safe-mode-hooks-disabled',
  'attention-missing',
  'attention-disabled',
  'publisher-sensor-not-shipped',
  'floor-declaration-malformed',
  'runtime-below-publisher-floor',
]);

function safeModeActive(env) {
  const raw = env?.CLAUDE_CODE_SAFE_MODE;
  if (raw === undefined || raw === null) return false;
  const value = String(raw).trim().toLowerCase();
  return value !== '' && value !== '0' && value !== 'false';
}

// Map a Claude `plugin list` row (machine-probe parseClaudePluginList shape:
// { version, scope, status, error }) to the injected enablement evidence.
// The row carries a STATUS STRING, not an enabled boolean (peer finding):
// 'enabled' → true; 'failed' (plugin failed to load) and a literal
// 'disabled' → false; anything else — unknown status text, absent row —
// is null, which the assessment reports as `unverified`, never guessed.
// One mapping for every probe-owning caller (doctor AND settings) so the
// two surfaces can never classify the same row differently.
export function claudePluginListEnablement(row) {
  if (!row || typeof row !== 'object') return null;
  const status = String(row.status ?? '').trim().toLowerCase();
  const version = typeof row.version === 'string' && row.version.trim() ? row.version.trim() : null;
  if (status === 'enabled') return { enabled: true, version };
  if (status === 'failed' || status === 'disabled') return { enabled: false, version };
  return { enabled: null, version };
}

// Installed attention build under the Claude cache. When the caller's
// plugin-list evidence names a version (`preferredVersion`) and that build
// is present in the cache, it is the one the host actually activates — read
// the declaration from it. Otherwise fall back to the newest manifest
// version (semver, descending — the machine-probe cache-scan selection
// rule). Filesystem-only; ENOENT-class absence is "not installed", any
// other readdir failure degrades the same way (a cache we cannot enumerate
// cannot prove an install). A version dir whose manifest is unreadable or
// names a different plugin is not an attention install.
async function discoverClaudeAttentionInstall(homeDir, { preferredVersion = null } = {}) {
  const baseDir = join(homeDir, ...ATTENTION_CLAUDE_CACHE_SEGMENTS);
  let entries;
  try {
    entries = await readdir(baseDir, { withFileTypes: true });
  } catch {
    return { installed: false, version: null, root: null };
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const root = join(baseDir, entry.name);
    try {
      const manifest = JSON.parse(readFileSync(join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
      if (manifest?.name !== 'attention') continue;
      const version = typeof manifest.version === 'string' && manifest.version.trim()
        ? manifest.version.trim()
        : entry.name;
      candidates.push({ version, root });
    } catch {
      // A version dir without a readable Claude manifest is not an install.
    }
  }
  if (candidates.length === 0) return { installed: false, version: null, root: null };
  if (preferredVersion) {
    const preferred = candidates.find((candidate) => candidate.version === preferredVersion);
    if (preferred) return { installed: true, version: preferred.version, root: preferred.root };
  }
  candidates.sort((a, b) => semverCompare(String(b.version), String(a.version)));
  return { installed: true, version: candidates[0].version, root: candidates[0].root };
}

// Contract §13 — read the publisher-floor declaration from the installed
// attention build. Absence (ENOENT-class) is the honest pre-S5 state
// (`declared: false`); any other failure — unreadable, bad JSON, wrong
// schema family, missing/non-semver floor — is `malformed: true` and
// fail-closed (never treated as satisfied).
async function readPublisherFloorDeclaration(attentionRoot) {
  const path = join(attentionRoot, ATTENTION_RUNTIME_FLOORS_REL_PATH);
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return { declared: false, malformed: false, floor: null };
    }
    return { declared: true, malformed: true, floor: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { declared: true, malformed: true, floor: null };
  }
  if (
    !parsed
    || typeof parsed !== 'object'
    || !ATTENTION_RUNTIME_FLOORS_SCHEMA_RE.test(String(parsed.schema ?? ''))
    || !parsed.floors
    || typeof parsed.floors !== 'object'
  ) {
    return { declared: true, malformed: true, floor: null };
  }
  const floor = parsed.floors.publish_session;
  if (typeof floor !== 'string' || !CLEAN_RELEASE_SEMVER_RE.test(floor.trim())) {
    return { declared: true, malformed: true, floor: null };
  }
  return { declared: true, malformed: false, floor: floor.trim() };
}

// The single readiness assessment (contract §13). Returns
//   {
//     status: 'off' | 'ready' | 'blocked' | 'config-fail-closed',
//     gate: { value, errors },
//     safe_mode: { active, source },
//     attention: { installed, version, enablement },
//     publisher_floor: { declared, floor, runtime_version, satisfied },
//     states: [...],            // blocking states, empty for off/ready
//     recommendations: [...],   // { state, detail, next_step } per state
//   }
// `attentionEnablement` is `{ enabled: true | false | null, version? }`
// from a host-CLI plugin-list probe (build it with
// `claudePluginListEnablement(row)`), or null/absent from filesystem-only
// callers. A supplied `version` binds the declaration read to the build
// the host actually activates when that build exists in the cache.
export async function assessSessionCaptureReadiness({
  repoRoot,
  homeDir = os.homedir(),
  env = process.env,
  runtimeVersion,
  attentionEnablement = null,
} = {}) {
  const result = {
    status: 'off',
    gate: { value: null, errors: [] },
    safe_mode: { active: false, source: null },
    attention: { installed: false, version: null, enablement: 'unverified' },
    publisher_floor: { declared: false, floor: null, runtime_version: runtimeVersion ?? null, satisfied: null },
    states: [],
    recommendations: [],
  };

  const gate = loadSessionConfig({ repoRoot, homeDir });
  if (!gate.ok) {
    // The same fail-closed refusal the publisher makes (contract §1): a
    // broken config never turns capture on — and never reads as clean.
    result.status = 'config-fail-closed';
    result.gate.errors = gate.errors;
    result.recommendations.push({
      state: 'config-fail-closed',
      detail: `session config unreadable or invalid (fail-closed, capture off): ${gate.errors.join('; ')}`,
      next_step: 'Fix .agentic-plugins/config.toml (repo or user layer) so session_capture resolves to off or stop-hook, then re-run the diagnosis.',
    });
    return result;
  }
  result.gate.value = gate.config.sessionCapture;
  if (gate.config.sessionCapture !== 'stop-hook') {
    // Shipped default. Informational, never a warning: off is a chosen
    // state, not a half-enabled one (contract §13).
    return result;
  }

  if (safeModeActive(env)) {
    result.safe_mode = { active: true, source: 'CLAUDE_CODE_SAFE_MODE' };
    result.states.push('safe-mode-hooks-disabled');
    result.recommendations.push({
      state: 'safe-mode-hooks-disabled',
      detail: 'Claude safe mode disables plugins and hooks entirely (host-parity-baseline.md hooks row), so the Stop-fired publisher cannot run in this session.',
      next_step: 'Leave safe mode (unset CLAUDE_CODE_SAFE_MODE / drop --safe-mode) to restore the hook chain, or set session_capture=off while troubleshooting.',
    });
  }

  const install = await discoverClaudeAttentionInstall(homeDir, {
    preferredVersion: attentionEnablement?.version ?? null,
  });
  result.attention.installed = install.installed;
  result.attention.version = install.version;
  if (!install.installed) {
    result.states.push('attention-missing');
    result.recommendations.push({
      state: 'attention-missing',
      detail: 'session_capture=stop-hook but the attention plugin is not installed in the Claude plugin cache — nothing fires the publisher (the v1 firing point is attention\'s Claude Stop sensor, ADR-0044 §2/§8).',
      next_step: 'Install attention@agentic-plugins for Claude (claude plugin install attention@agentic-plugins), or set session_capture=off.',
    });
  } else {
    if (attentionEnablement && attentionEnablement.enabled === false) {
      result.attention.enablement = 'disabled';
      result.states.push('attention-disabled');
      result.recommendations.push({
        state: 'attention-disabled',
        detail: 'attention is installed but the Claude plugin list reports it disabled — its Stop sensor will not fire the publisher.',
        next_step: 'Enable the attention plugin (claude plugin enable attention@agentic-plugins), or set session_capture=off.',
      });
    } else if (attentionEnablement && attentionEnablement.enabled === true) {
      result.attention.enablement = 'enabled';
    } else {
      result.attention.enablement = 'unverified';
    }

    const declaration = await readPublisherFloorDeclaration(install.root);
    result.publisher_floor.declared = declaration.declared;
    result.publisher_floor.floor = declaration.floor;
    if (!declaration.declared) {
      result.states.push('publisher-sensor-not-shipped');
      result.recommendations.push({
        state: 'publisher-sensor-not-shipped',
        detail: `installed attention ${install.version ?? '<unknown>'} ships no ${ATTENTION_RUNTIME_FLOORS_REL_PATH} declaration — it predates the capture sensor, so the Stop hook never spawns publish-session (session-capture-contract.md §13).`,
        next_step: 'Update attention@agentic-plugins to a release that ships the capture sensor and its publisher-floor declaration.',
      });
    } else if (declaration.malformed) {
      result.states.push('floor-declaration-malformed');
      result.recommendations.push({
        state: 'floor-declaration-malformed',
        detail: `installed attention ${install.version ?? '<unknown>'} ships an unreadable or malformed ${ATTENTION_RUNTIME_FLOORS_REL_PATH} — the publisher floor cannot be verified (fail-closed, session-capture-contract.md §13).`,
        next_step: 'Reinstall or update attention@agentic-plugins so the declaration parses, then re-run the diagnosis.',
      });
    } else if (typeof runtimeVersion === 'string' && semverCompare(runtimeVersion, declaration.floor) < 0) {
      result.publisher_floor.satisfied = false;
      result.states.push('runtime-below-publisher-floor');
      result.recommendations.push({
        state: 'runtime-below-publisher-floor',
        detail: `attention declares publisher floor ${declaration.floor} but the installed runtime is ${runtimeVersion} — the sensor skips the capture spawn below its floor (ADR-0044 §2).`,
        next_step: 'Update runtime@agentic-plugins to at least the declared floor, or set session_capture=off until then.',
      });
    } else {
      result.publisher_floor.satisfied = true;
    }
  }

  result.status = result.states.length > 0 ? 'blocked' : 'ready';
  return result;
}
