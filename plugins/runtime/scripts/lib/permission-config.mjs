// plugins/runtime/scripts/lib/permission-config.mjs
//
// READ-ONLY host permission-config parsing + reading (machine-bootstrap-contract.md
// §1.3 extraction 4). Lifted from settings.mjs so both the settings permission
// planner and the §4.4 user-global-only profile readers consume ONE parser — a
// second copy would be a mirror waiting to drift. This module never writes host
// config. Codex config parsing lives here; the Claude/Codex union readers and the
// user-global-only readers compose these primitives.

import { join, resolve } from 'node:path';

import { readTextIfExists } from './state-readers.mjs';

// Read-only JSON read that never throws (missing/unreadable/malformed are data).
// Distinct from state-readers.readJsonIfExists: this reports a malformed file as the
// stable reason 'invalid_json' (not the raw SyntaxError message), which
// readClaudePermissionConfig classifies as 'malformed'.
async function readJsonIfExists(path) {
  const r = await readTextIfExists(path);
  if (!r.ok) return { ok: false, reason: r.reason };
  try {
    return { ok: true, json: JSON.parse(r.text) };
  } catch {
    return { ok: false, reason: 'invalid_json' };
  }
}

// Reverse of tomlString's escaping for a basic-string key/value: "\\"->"\",
// '\"'->'"'. Used to compare a stored [projects."<path>"] key against repoRoot.
export function unescapeTomlBasic(s) {
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

// Read the Claude permissions allowlist READ-ONLY across repo + user settings,
// unioning allow/deny/ask and capturing the first observed defaultMode. Never
// writes; a missing/unreadable/malformed file is reported as a sanitized source
// status (no raw path). This is the host-allowlist cross-reference doctor
// deliberately deferred to settings (ADR-0038 §1). This UNION reader is the
// settings permission planner's gather half; the §4.4 profile export uses the
// separate user-global-only reader in profile-readers.mjs instead.
export async function readClaudePermissionConfig({ repoRoot, homeDir }) {
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

// Read ~/.codex/config.toml READ-ONLY (honoring $CODEX_HOME). Never writes; a
// missing/unreadable file is sanitized source data, not an error. `projectTrusted`
// is repo-keyed (whether THIS repo is in the user's trusted list) — the profile
// export deliberately drops it (§4.4); it is retained here for the settings planner.
export async function readCodexPermissionConfig({ homeDir, env, repoRoot }) {
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
