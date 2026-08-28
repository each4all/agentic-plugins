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
// model/effort, notify.loadNotifyConfig); these are
// the deliberately SEPARATE user-global reads §4.4 mandates, sharing those modules'
// parsers so there is no second parser to drift.

import { join, resolve } from 'node:path';

import { readTextIfExists } from './state-readers.mjs';
import { CONFIG_KEY_FAMILIES, parseRuntimeConfigToml } from './runtime-config.mjs';
import { parseCodexPermissionConfigToml } from './codex-config.mjs';
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

/**
 * The ONE user-global runtime-config snapshot. `model_effort` and `notify` are
 * two FAMILIES of the SAME file, and reading it twice let an atomic replacement
 * land between them — two judges then agree about a file neither version of
 * which satisfies them together (cross-host Review peer, MAJOR). This is the
 * same repair the Claude settings snapshot below already carries, applied to the
 * second file that needed it; the projections are pure so a caller cannot
 * accidentally re-read.
 *
 * The per-family readers are kept as thin read-then-project wrappers, because
 * profile export legitimately wants ONE family and has no second consumer to
 * share bytes with.
 */
export async function readUserGlobalRuntimeConfig({ homeDir }) {
  const read = await readTextIfExists(userRuntimeConfigPath(homeDir));
  return { parsed: read.ok ? parseRuntimeConfigToml(read.text) : {}, source: { scope: 'user', status: textSourceStatus(read) } };
}

function projectRuntimeConfigFamily(snapshot, family, familyKeys) {
  const keys = {};
  for (const key of familyKeys) {
    keys[key] = key in snapshot.parsed
      ? { value: snapshot.parsed[key], provenance: USER_GLOBAL }
      : { value: null, provenance: null };
  }
  return { family, keys, source: snapshot.source };
}

// model/effort — user-global `~/.agentic-plugins/config.toml` only. The
// peer-execution-context resolver PREFERS repo config (§4.4 leak); this read never
// looks at repo, so an exported model/effort is always the operator's own default.
export function projectModelEffort(snapshot) {
  return projectRuntimeConfigFamily(snapshot, 'model_effort', CONFIG_KEY_FAMILIES.model_effort);
}

// notify — the SAME user-global file, notify family only. loadNotifyConfig prefers
// repo over user (`repoConfig[key] ?? userConfig[key]`); this read is user-only.
export function projectNotify(snapshot) {
  return projectRuntimeConfigFamily(snapshot, 'notify', CONFIG_KEY_FAMILIES.notify);
}

// session — the THIRD family of the same user-global file (profile 1.2). What this
// read deliberately does NOT see is the point, and the two keys differ in why:
//
//   * `session_capture` resolves repo → user → default at runtime, so a repo value
//     can legitimately be in force on this checkout. The profile still reads
//     user-global only, because §4.4's rule is that a portable artifact carries the
//     OPERATOR's default and never a project's policy — exporting the repo value
//     would seed another machine with this checkout's opinion.
//   * `entry_brief` / `entry_brief_empty` resolve env → user → default and ignore
//     repo activation entirely (ADR-0045 §7). An env override is per-machine
//     operator state that is not portable by construction, so it is excluded here
//     for the same reason a repository path is: it describes this machine, not the
//     posture worth carrying to the next one.
//
// So a profile records the PERSISTED user-global posture, never the effective value
// on this machine right now. A consumer that needs the effective value must ask the
// loader that owns it — this projection is not that loader and must not be mistaken
// for one.
export function projectSession(snapshot) {
  return projectRuntimeConfigFamily(snapshot, 'session', CONFIG_KEY_FAMILIES.session);
}

export async function readUserGlobalModelEffort({ homeDir }) {
  return projectModelEffort(await readUserGlobalRuntimeConfig({ homeDir }));
}

export async function readUserGlobalNotify({ homeDir }) {
  return projectNotify(await readUserGlobalRuntimeConfig({ homeDir }));
}

export async function readUserGlobalSession({ homeDir }) {
  return projectSession(await readUserGlobalRuntimeConfig({ homeDir }));
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
export function projectClaudePermission(snapshot) {
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

// Back-compat wrapper: one read + the permission projection (bootstrap's
// reader assembly projects BOTH consumers from a single snapshot instead —
// Review peer M11).
export async function readUserGlobalClaudePermission({ homeDir, env = {} }) {
  return projectClaudePermission(await readUserGlobalClaudeSettings({ homeDir, env }));
}

// Codex permission — `~/.codex/config.toml` ($CODEX_HOME honored) ONLY, and NEVER
// `projectTrusted`: that boolean is keyed on repoRoot, so it is per-repo, not
// machine-invariant, and must not enter a portable profile (§4.4).
/**
 * PROJECTION from an already-read `$CODEX_HOME/config.toml`. The notification
 * gather reads the same file for the Codex notify + statusline judges, and two
 * independent reads could observe an atomic replacement between them — the same
 * race the Claude settings snapshot exists to prevent. `read` is a
 * `readTextIfExists` result; `usingOverride` must be derived from the SAME env
 * the caller resolved `$CODEX_HOME` with, or the reported provenance would
 * describe a different file than the bytes.
 */
export function projectCodexPermission(read, { usingOverride = false, codexHomeSource = null } = {}) {
  const parsed = read?.ok
    ? parseCodexPermissionConfigToml(read.text)
    : { approvalPolicy: null, sandboxMode: null };
  return {
    approval_policy: parsed.approvalPolicy ?? null,
    sandbox_mode: parsed.sandboxMode ?? null,
    provenance: USER_GLOBAL,
    source: {
      scope: 'user',
      status: textSourceStatus(read),
      // Provenance follows the resolution that produced these BYTES: callers
      // that share a gather's read pass its `codexHomeSource`, and only the
      // standalone wrapper below — which resolves the path itself — falls back
      // to `usingOverride`. Re-deriving it from a caller-supplied `env` could
      // label an override-path read as the default one (Refine-verify peer).
      codex_home_source: codexHomeSource ?? (usingOverride ? 'CODEX_HOME env override' : 'default ~/.codex'),
    },
  };
}

export async function readUserGlobalCodexPermission({ homeDir, env = {} }) {
  const usingOverride = Boolean(env && env.CODEX_HOME);
  const codexHome = usingOverride ? resolve(env.CODEX_HOME) : join(homeDir, '.codex');
  return projectCodexPermission(await readTextIfExists(join(codexHome, 'config.toml')), { usingOverride });
}

// Egress — thin alias over the egress-config export reader (the single egress
// resolution authority). Surfaces channel/recipient/headline INDEPENDENT of
// credential presence, secrets-free, invalid-recipient→null, with per-field
// provenance. repoRoot (when known) is passed only to REJECT a config.local.toml
// that lives inside the repo — never to read repo config.
export function readUserGlobalEgress({ repoRoot = null, homeDir, env = {}, getuid } = {}) {
  return loadEgressExportConfig({ repoRoot, homeDir, env, getuid });
}
