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
import { readFile, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';

import { loadEntryBriefConfig, loadSessionConfig } from './runtime-config.mjs';
import { resolveContained } from './path-containment.mjs';
import { semverCompare } from './semver.mjs';

// Contract §13 — the declaration file attention ships relative to its
// plugin root, and the schema-id family the consumer accepts. Unlike the
// slot/entry/note schemas (same-runtime producer and consumer, exact-pin),
// this file crosses plugin versions by design, so any 1.x minor is read.
export const ATTENTION_RUNTIME_FLOORS_REL_PATH = join('data', 'runtime-floors.json');
export const ATTENTION_RUNTIME_FLOORS_SCHEMA_RE = /^attention-runtime-floors-1\.\d+$/;

// The v1 firing points are Claude hooks (ADR-0044 §8 Stop, ADR-0045 §10
// SessionStart), so the Claude plugin cache is the load-bearing install
// location — a Codex-only install cannot fire either sensor and does not
// count as ready.
const CLAUDE_PLUGIN_CACHE_SEGMENTS = ['.claude', 'plugins', 'cache', 'agentic-plugins'];

// ADR-0045 §10 — the entry executor the SessionStart dispatcher probes for:
// version floors prove version, not capability presence, so the readiness
// diagnosis mirrors the dispatcher's existence probe against the installed
// runtime build (contract §18).
export const RUNTIME_ENTRY_EXECUTOR_REL_PATH = join('scripts', 'context.mjs');

// Contract §13: the declared floor is a plain released X.Y.Z — the
// ADR-0043 released-floor rule means a prerelease/build-suffixed floor is
// never a valid declaration, so it is malformed (fail-closed), which also
// keeps the shared semverCompare (numeric core + prerelease tie-break)
// sufficient for the comparison.
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

// Entry-side half-enabled states (ADR-0045 §10; contract §18). The first
// three are shared vocabulary with the exit side — same condition, same
// name — so a composed diagnosis never renders one hook-chain fact under
// two labels.
export const ENTRY_BRIEF_READINESS_STATES = Object.freeze([
  'safe-mode-hooks-disabled',
  'attention-missing',
  'attention-disabled',
  'entry-sensor-not-shipped',
  'floor-declaration-malformed',
  'runtime-below-entry-floor',
  'entry-executor-missing',
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

// Installed plugin build under the Claude cache. When the caller's
// plugin-list evidence names a version (`preferredVersion`) and that build
// is present in the cache, it is the one the host actually activates — read
// the declaration from it. Otherwise fall back to the newest manifest
// version (semver, descending — the machine-probe cache-scan selection
// rule). Filesystem-only; ENOENT-class absence is "not installed", any
// other readdir failure degrades the same way (a cache we cannot enumerate
// cannot prove an install). A version dir whose manifest is unreadable or
// names a different plugin is not an install of that plugin.
async function discoverClaudePluginInstall(homeDir, pluginName, { preferredVersion = null } = {}) {
  const baseDir = join(homeDir, ...CLAUDE_PLUGIN_CACHE_SEGMENTS, pluginName);
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
      if (manifest?.name !== pluginName) continue;
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

// The floors document itself: absent (ENOENT-class) vs malformed (any other
// read failure, bad JSON, wrong schema family, non-object floors) vs ok.
async function readRuntimeFloorsDocument(attentionRoot) {
  // Canonical containment, like every other packaged asset. This document sets
  // the version FLOORS a readiness verdict is measured against, so a floors
  // file resolving outside the attention package lets content the package does
  // not own decide `ready` — reproduced by cross-host review with an outside
  // floor of `0.1.0`. An escape is reported as `malformed` rather than a new
  // status: from this reader's side the effect is the same (the document
  // cannot be trusted), and the caller's vocabulary stays two-valued.
  const located = await resolveContained(attentionRoot, ATTENTION_RUNTIME_FLOORS_REL_PATH);
  if (located.status === 'missing') return { status: 'absent', floors: null };
  if (located.status !== 'ok') return { status: 'malformed', floors: null };
  const path = located.canonicalPath;
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return { status: 'absent', floors: null };
    }
    return { status: 'malformed', floors: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: 'malformed', floors: null };
  }
  if (
    !parsed
    || typeof parsed !== 'object'
    || Array.isArray(parsed)
    || !ATTENTION_RUNTIME_FLOORS_SCHEMA_RE.test(String(parsed.schema ?? ''))
    || !parsed.floors
    || typeof parsed.floors !== 'object'
    || Array.isArray(parsed.floors)
  ) {
    return { status: 'malformed', floors: null };
  }
  // The founding key is required by the 1.x family (§13): a present
  // document without a clean released publish_session floor is malformed
  // as a DOCUMENT — every per-key reader inherits this, so an additive
  // sibling key can never validate out of a corrupt file (review peer).
  const founding = parsed.floors.publish_session;
  if (typeof founding !== 'string' || !CLEAN_RELEASE_SEMVER_RE.test(founding.trim())) {
    return { status: 'malformed', floors: null };
  }
  return { status: 'ok', floors: parsed.floors };
}

// Contract §13 — read the publisher-floor declaration from the installed
// attention build. Absence of the FILE (ENOENT-class) is the honest pre-S5
// state (`declared: false`); any other failure — unreadable, bad JSON, wrong
// schema family, missing/non-semver `publish_session` (the file's founding
// key, required by the 1.x family) — is `malformed: true` and fail-closed
// (never treated as satisfied).
async function readPublisherFloorDeclaration(attentionRoot) {
  const document = await readRuntimeFloorsDocument(attentionRoot);
  if (document.status === 'absent') return { declared: false, malformed: false, floor: null };
  if (document.status === 'malformed') return { declared: true, malformed: true, floor: null };
  const floor = document.floors.publish_session;
  if (typeof floor !== 'string' || !CLEAN_RELEASE_SEMVER_RE.test(floor.trim())) {
    return { declared: true, malformed: true, floor: null };
  }
  return { declared: true, malformed: false, floor: floor.trim() };
}

// Contract §18 — the entry-brief floor. Unlike `publish_session`,
// `entry_brief` is an ADDITIVE sibling key (§13 sibling-key rule): a
// present, well-formed floors file without it is the honest pre-entry-
// sensor state (`declared: false`), not corruption. A present key that is
// not a clean released X.Y.Z is malformed and fail-closed.
async function readEntryFloorDeclaration(attentionRoot) {
  const document = await readRuntimeFloorsDocument(attentionRoot);
  if (document.status === 'absent') return { declared: false, malformed: false, floor: null };
  if (document.status === 'malformed') return { declared: true, malformed: true, floor: null };
  const floor = document.floors.entry_brief;
  if (floor === undefined) return { declared: false, malformed: false, floor: null };
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

  const install = await discoverClaudePluginInstall(homeDir, 'attention', {
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

// ADR-0045 §10 — the entry executor existence probe the readiness diagnosis
// mirrors from the SessionStart dispatcher: the newest installed runtime
// build under the Claude cache (the dispatcher's primary discovery rung)
// either carries scripts/context.mjs or it does not. No cached runtime
// build ⇒ `present: null` — unverifiable, not blocking (the sensor's
// ladder may resolve an env-override or sibling root the advisory
// diagnosis does not re-implement, the §13 stated-limit shape).
async function probeEntryExecutor(homeDir) {
  const install = await discoverClaudePluginInstall(homeDir, 'runtime');
  if (!install.installed) {
    return { probed: true, present: null, runtime_version: null };
  }
  try {
    const stats = await stat(join(install.root, RUNTIME_ENTRY_EXECUTOR_REL_PATH));
    return { probed: true, present: stats.isFile(), runtime_version: install.version };
  } catch {
    return { probed: true, present: false, runtime_version: install.version };
  }
}

// The entry-side readiness assessment (ADR-0045 §10; contract §18) —
// doctor and settings both consume THIS function, mirroring the exit-side
// shape above. Returns
//   {
//     status: 'off' | 'ready' | 'blocked' | 'config-fail-closed',
//     gate: { value, empty_value, errors, ignored_repo_keys, repo_layer },
//     safe_mode: { active, source },
//     attention: { installed, version, enablement },
//     entry_floor: { declared, floor, runtime_version, satisfied },
//     entry_executor: { probed, present, runtime_version },
//     states: [...],
//     recommendations: [...],
//   }
// The gate reads the SAME user-scope-only loader the entry-brief executor
// gates on (`loadEntryBriefConfig`: env > user-global > default; a tracked
// repo value is ignored and reported) — one authority for what "on" means.
// `off` is informational, never a warning: the cli/dashboard surfaces
// always compute regardless (contract §17); this diagnosis covers the
// hook emission chain only.
export async function assessEntryBriefReadiness({
  repoRoot,
  homeDir = os.homedir(),
  env = process.env,
  runtimeVersion,
  attentionEnablement = null,
} = {}) {
  const result = {
    status: 'off',
    gate: { value: null, empty_value: null, errors: [], ignored_repo_keys: [], repo_layer: 'unknown' },
    safe_mode: { active: false, source: null },
    attention: { installed: false, version: null, enablement: 'unverified' },
    entry_floor: { declared: false, floor: null, runtime_version: runtimeVersion ?? null, satisfied: null },
    entry_executor: { probed: false, present: null, runtime_version: null },
    states: [],
    recommendations: [],
  };

  const gate = loadEntryBriefConfig({ repoRoot, homeDir, env });
  if (!gate.ok) {
    // The same fail-closed refusal the executor's hook surface makes
    // (contract §17): a broken config never turns the injected line on —
    // and never reads as clean. The repo-layer observations survive the
    // refusal (review peer): an ignored tracked-repo activation attempt
    // stays visible even while the user layer fail-closes.
    result.status = 'config-fail-closed';
    result.gate.errors = gate.errors;
    result.gate.ignored_repo_keys = gate.ignoredRepoKeys ?? [];
    result.gate.repo_layer = gate.repoLayer ?? 'unknown';
    result.recommendations.push({
      state: 'config-fail-closed',
      detail: `entry-brief config unreadable or invalid (fail-closed, hook emission off): ${gate.errors.join('; ')}`,
      next_step: 'Fix the user-global ~/.agentic-plugins/config.toml or the AGENTIC_ENTRY_BRIEF / AGENTIC_ENTRY_BRIEF_EMPTY env values so entry_brief resolves to off or startup, then re-run the diagnosis.',
    });
    return result;
  }
  result.gate.value = gate.config.entryBrief;
  result.gate.empty_value = gate.config.entryBriefEmpty;
  result.gate.ignored_repo_keys = gate.ignoredRepoKeys ?? [];
  result.gate.repo_layer = gate.repoLayer ?? 'unknown';
  if (gate.config.entryBrief !== 'startup') {
    // Shipped default. Informational, never a warning: off is a chosen
    // state, not a half-enabled one (contract §18).
    return result;
  }

  if (safeModeActive(env)) {
    result.safe_mode = { active: true, source: 'CLAUDE_CODE_SAFE_MODE' };
    result.states.push('safe-mode-hooks-disabled');
    result.recommendations.push({
      state: 'safe-mode-hooks-disabled',
      detail: 'Claude safe mode disables plugins and hooks entirely (host-parity-baseline.md hooks row), so the SessionStart entry sensor cannot run in this session.',
      next_step: 'Leave safe mode (unset CLAUDE_CODE_SAFE_MODE / drop --safe-mode) to restore the hook chain, or set entry_brief=off while troubleshooting.',
    });
  }

  const install = await discoverClaudePluginInstall(homeDir, 'attention', {
    preferredVersion: attentionEnablement?.version ?? null,
  });
  result.attention.installed = install.installed;
  result.attention.version = install.version;
  if (!install.installed) {
    result.states.push('attention-missing');
    result.recommendations.push({
      state: 'attention-missing',
      detail: 'entry_brief=startup but the attention plugin is not installed in the Claude plugin cache — nothing fires the entry arbiter (the hook surface is attention\'s Claude SessionStart sensor, ADR-0045 §7).',
      next_step: 'Install attention@agentic-plugins for Claude (claude plugin install attention@agentic-plugins), or set entry_brief=off.',
    });
  } else {
    if (attentionEnablement && attentionEnablement.enabled === false) {
      result.attention.enablement = 'disabled';
      result.states.push('attention-disabled');
      result.recommendations.push({
        state: 'attention-disabled',
        detail: 'attention is installed but the Claude plugin list reports it disabled — its SessionStart sensor will not fire the entry arbiter.',
        next_step: 'Enable the attention plugin (claude plugin enable attention@agentic-plugins), or set entry_brief=off.',
      });
    } else if (attentionEnablement && attentionEnablement.enabled === true) {
      result.attention.enablement = 'enabled';
    } else {
      result.attention.enablement = 'unverified';
    }

    const declaration = await readEntryFloorDeclaration(install.root);
    result.entry_floor.declared = declaration.declared;
    result.entry_floor.floor = declaration.floor;
    if (!declaration.declared) {
      result.states.push('entry-sensor-not-shipped');
      result.recommendations.push({
        state: 'entry-sensor-not-shipped',
        detail: `installed attention ${install.version ?? '<unknown>'} declares no floors.entry_brief in ${ATTENTION_RUNTIME_FLOORS_REL_PATH} — it predates the entry sensor, so no SessionStart hook spawns entry-brief (session-capture-contract.md §18).`,
        next_step: 'Update attention@agentic-plugins to a release that ships the SessionStart entry sensor and its entry-brief floor declaration.',
      });
    } else if (declaration.malformed) {
      result.states.push('floor-declaration-malformed');
      result.recommendations.push({
        state: 'floor-declaration-malformed',
        detail: `installed attention ${install.version ?? '<unknown>'} ships an unreadable or malformed ${ATTENTION_RUNTIME_FLOORS_REL_PATH} — the entry-brief floor cannot be verified (fail-closed, session-capture-contract.md §18).`,
        next_step: 'Reinstall or update attention@agentic-plugins so the declaration parses, then re-run the diagnosis.',
      });
    } else if (typeof runtimeVersion === 'string' && semverCompare(runtimeVersion, declaration.floor) < 0) {
      result.entry_floor.satisfied = false;
      result.states.push('runtime-below-entry-floor');
      result.recommendations.push({
        state: 'runtime-below-entry-floor',
        detail: `attention declares entry-brief floor ${declaration.floor} but the installed runtime is ${runtimeVersion} — the sensor skips the entry-brief spawn below its floor (ADR-0045 §12).`,
        next_step: 'Update runtime@agentic-plugins to at least the declared floor, or set entry_brief=off until then.',
      });
    } else {
      result.entry_floor.satisfied = true;
      // ADR-0045 §10: a passing floor proves version, not capability
      // presence — mirror the dispatcher's executor-existence probe.
      result.entry_executor = await probeEntryExecutor(homeDir);
      if (result.entry_executor.present === false) {
        result.states.push('entry-executor-missing');
        result.recommendations.push({
          state: 'entry-executor-missing',
          detail: `the entry-brief floor passes but the installed runtime build (${result.entry_executor.runtime_version ?? '<unknown>'}) is missing ${RUNTIME_ENTRY_EXECUTOR_REL_PATH} — the dispatcher no-ops on executor absence at a passing floor (ADR-0045 §10), so no line is ever injected.`,
          next_step: 'Reinstall runtime@agentic-plugins so the cached build ships scripts/context.mjs, then re-run the diagnosis.',
        });
      }
    }
  }

  result.status = result.states.length > 0 ? 'blocked' : 'ready';
  return result;
}
