// plugins/runtime/scripts/lib/profile-readers.mjs
//
// USER-GLOBAL-ONLY readers for `profile export` (machine-bootstrap-contract.md
// §4.4). This is a CORRECTNESS rule, not a preference: a portable machine profile
// must read ONLY user-global config and NEVER repository or repo-local config, so a
// project's policy is never silently exported as another machine's global default.
//
// Every reader here:
//   * reads exactly one user-global source (never repo, never repo-local);
//   * carries provenance on every value it surfaces (a value whose provenance is
//     not user-global is not exportable — here it is user-global by construction);
//   * reports a source read-status (missing/malformed/unreadable/readable) so the
//     profile engine (C5) can explain a null instead of guessing.
//
// The repo-preferring resolvers stay in their home modules (peer-execution-context
// model/effort, notify.loadNotifyConfig, the settings permission planner); these are
// the deliberately SEPARATE user-global reads §4.4 mandates, sharing those modules'
// parsers so there is no second parser to drift.

import { join, resolve } from 'node:path';

import { readTextIfExists } from './state-readers.mjs';
import { CONFIG_KEY_FAMILIES, parseRuntimeConfigToml } from './runtime-config.mjs';
import { parseCodexPermissionConfigToml } from './permission-config.mjs';
import { loadEgressExportConfig } from './egress-config.mjs';

const USER_GLOBAL = 'user-global';

// Classify a user-file read exactly as the settings union readers do
// (ENOENT→missing, JSON parse failure→malformed, any other error→unreadable) so a
// profile source status matches what an operator already sees elsewhere.
function textSourceStatus(read) {
  if (read.ok) return 'readable';
  return read.reason === 'ENOENT' ? 'missing' : 'unreadable';
}

// The shared user-global runtime config path — the SAME file model/effort and
// notify both read, never the repo `.agentic-plugins/config.toml`.
function userRuntimeConfigPath(homeDir) {
  return join(homeDir, '.agentic-plugins', 'config.toml');
}

async function readUserRuntimeConfigFamily(homeDir, familyKeys) {
  const read = await readTextIfExists(userRuntimeConfigPath(homeDir));
  const parsed = read.ok ? parseRuntimeConfigToml(read.text) : {};
  const keys = {};
  for (const key of familyKeys) {
    keys[key] = key in parsed
      ? { value: parsed[key], provenance: USER_GLOBAL }
      : { value: null, provenance: null };
  }
  return { keys, source: { scope: 'user', status: textSourceStatus(read) } };
}

// model/effort — user-global `~/.agentic-plugins/config.toml` only. The
// peer-execution-context resolver PREFERS repo config (§4.4 leak); this read never
// looks at repo, so an exported model/effort is always the operator's own default.
export async function readUserGlobalModelEffort({ homeDir }) {
  const { keys, source } = await readUserRuntimeConfigFamily(homeDir, CONFIG_KEY_FAMILIES.model_effort);
  return { family: 'model_effort', keys, source };
}

// notify — the SAME user-global file, notify family only. loadNotifyConfig prefers
// repo over user (`repoConfig[key] ?? userConfig[key]`); this read is user-only.
export async function readUserGlobalNotify({ homeDir }) {
  const { keys, source } = await readUserRuntimeConfigFamily(homeDir, CONFIG_KEY_FAMILIES.notify);
  return { family: 'notify', keys, source };
}

// The ONE user-global Claude settings snapshot (ADR-0048 statusline slice,
// Plan-verify peer G9): settings.json is parsed ONCE and projected per
// consumer (permission, statusLine), so two judges can never disagree about
// the same bytes. Honors CLAUDE_CONFIG_DIR — the documented relocation of
// ~/.claude — which the earlier per-consumer read silently ignored. This
// reads the USER layer only (§4.4): managed/CLI/project layers outrank it at
// runtime, but a portable profile and a machine-scoped probe both target the
// user layer deliberately.
export function resolveClaudeConfigDir(env = {}, homeDir) {
  return env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : join(homeDir, '.claude');
}

export async function readUserGlobalClaudeSettings({ homeDir, env = {} }) {
  const read = await readTextIfExists(join(resolveClaudeConfigDir(env, homeDir), 'settings.json'));
  let status = textSourceStatus(read);
  let json = null;
  if (read.ok) {
    try { json = JSON.parse(read.text); }
    catch { status = 'malformed'; }
  }
  return { json: json && typeof json === 'object' ? json : null, source: { scope: 'user', status } };
}

/**
 * The statusLine projection of the shared snapshot. The raw foreign command is
 * surfaced to the CALLER for exact comparison but must never be persisted or
 * echoed into artifacts/observations (it may carry secrets or private paths —
 * peer G9); consumers summarize shape, compare, and drop it.
 */
export function projectClaudeStatusline(snapshot) {
  const status = snapshot?.source?.status;
  if (status !== 'readable' && status !== 'missing') {
    return { readable: false, present: false, type: null, command: null };
  }
  const entry = snapshot?.json?.statusLine;
  if (entry === undefined || entry === null) return { readable: true, present: false, type: null, command: null };
  if (typeof entry !== 'object' || Array.isArray(entry)) return { readable: true, present: true, type: null, command: null };
  return {
    readable: true,
    present: true,
    type: typeof entry.type === 'string' ? entry.type : null,
    command: typeof entry.command === 'string' ? entry.command : null,
  };
}

// Claude permission — the permission projection of the SAME snapshot. The
// settings union reader unions repo ∪ repo-local ∪ user (losing provenance)
// and resolves defaultMode repo-local>repo>user; this projects exclusively
// the user layer, so allow/deny/ask carry a single, honest user-global
// provenance.
export async function readUserGlobalClaudePermission({ homeDir, env = {} }) {
  const snapshot = await readUserGlobalClaudeSettings({ homeDir, env });
  const status = snapshot.source.status;
  const json = snapshot.json;
  const perms = json && typeof json === 'object' ? json.permissions : null;
  const pick = (bucket) => (perms && Array.isArray(perms[bucket])
    ? perms[bucket].filter((item) => typeof item === 'string')
    : []);
  const defaultMode = perms && typeof perms.defaultMode === 'string' ? perms.defaultMode : null;
  return {
    allow: pick('allow'),
    deny: pick('deny'),
    ask: pick('ask'),
    default_mode: defaultMode,
    provenance: USER_GLOBAL,
    source: { scope: 'user', status },
  };
}

// Codex permission — `~/.codex/config.toml` ($CODEX_HOME honored) ONLY, and NEVER
// `projectTrusted`: that boolean is keyed on repoRoot, so it is per-repo, not
// machine-invariant, and must not enter a portable profile (§4.4).
export async function readUserGlobalCodexPermission({ homeDir, env = {} }) {
  const usingOverride = Boolean(env && env.CODEX_HOME);
  const codexHome = usingOverride ? resolve(env.CODEX_HOME) : join(homeDir, '.codex');
  const read = await readTextIfExists(join(codexHome, 'config.toml'));
  const parsed = read.ok
    ? parseCodexPermissionConfigToml(read.text)
    : { approvalPolicy: null, sandboxMode: null };
  return {
    approval_policy: parsed.approvalPolicy ?? null,
    sandbox_mode: parsed.sandboxMode ?? null,
    provenance: USER_GLOBAL,
    source: {
      scope: 'user',
      status: textSourceStatus(read),
      codex_home_source: usingOverride ? 'CODEX_HOME env override' : 'default ~/.codex',
    },
  };
}

// Egress — thin alias over the egress-config export reader (the single egress
// resolution authority). Surfaces channel/recipient/headline INDEPENDENT of
// credential presence, secrets-free, invalid-recipient→null, with per-field
// provenance. repoRoot (when known) is passed only to REJECT a config.local.toml
// that lives inside the repo — never to read repo config.
export function readUserGlobalEgress({ repoRoot = null, homeDir, env = {}, getuid } = {}) {
  return loadEgressExportConfig({ repoRoot, homeDir, env, getuid });
}
