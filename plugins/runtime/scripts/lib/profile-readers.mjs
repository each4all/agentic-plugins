// plugins/runtime/scripts/lib/profile-readers.mjs
//
// USER-GLOBAL-ONLY readers for `runtime:bootstrap`'s Stage 4/5 judges. Reading
// ONLY user-global config, never repository or repo-local config, is a
// correctness rule, not a preference: a machine bootstrap records the
// OPERATOR's default, so a project's policy must never be judged as this
// machine's global posture (machine-bootstrap-contract.md §1.1).
//
// The module is named for the portable machine profile it first fed
// (`profile export`). ADR-0064 Decision 3 removed the profile together with its
// profile-only readers (the Claude/Codex permission projections and the egress
// export reader), and Decision 1 the notify projection with the bootstrap
// notification steps; the readers below are the ones the bootstrap judges use.
//
// Every reader here:
//   * reads exactly one user-global source (never repo, never repo-local);
//   * carries provenance on every value it surfaces (here it is user-global by
//     construction);
//   * reports a source read-status (missing/malformed/unreadable/readable) so a
//     judge can explain a null instead of guessing.
//
// The repo-preferring resolvers stay in their home modules (peer-execution-context
// model/effort, the session loaders); these are the deliberately SEPARATE
// user-global reads, sharing those modules' parsers so there is no second parser
// to drift.

import { join, resolve } from 'node:path';

import { readTextIfExists } from './state-readers.mjs';
import { CONFIG_KEY_FAMILIES, parseRuntimeConfigToml } from './runtime-config.mjs';

const USER_GLOBAL = 'user-global';

// Classify a user-file read exactly as the settings union readers do
// (ENOENT→missing, JSON parse failure→malformed, any other error→unreadable) so a
// source status matches what an operator already sees elsewhere.
function textSourceStatus(read) {
  if (read.ok) return 'readable';
  return read.reason === 'ENOENT' ? 'missing' : 'unreadable';
}

// The shared user-global runtime config path — the SAME file model/effort and
// session both read, never the repo `.agentic-plugins/config.toml`.
function userRuntimeConfigPath(homeDir) {
  return join(homeDir, '.agentic-plugins', 'config.toml');
}

/**
 * The ONE user-global runtime-config snapshot. `model_effort` and `session` are
 * two FAMILIES of the SAME file, and reading it twice let an atomic replacement
 * land between them — two judges then agree about a file neither version of
 * which satisfies them together (cross-host Review peer, MAJOR). This is the
 * same repair the Claude settings snapshot below already carries, applied to the
 * second file that needed it; the projections are pure so a caller cannot
 * accidentally re-read.
 *
 * The per-family readers are kept as thin read-then-project wrappers for a caller
 * that wants ONE family and has no second consumer to share bytes with.
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
// peer-execution-context resolver PREFERS repo config; this read never looks at
// repo, so the model/effort it reports is always the operator's own default.
export function projectModelEffort(snapshot) {
  return projectRuntimeConfigFamily(snapshot, 'model_effort', CONFIG_KEY_FAMILIES.model_effort);
}

// session — the second family of the same user-global file. What this read
// deliberately does NOT see is the point, and the two keys differ in why:
//
//   * `session_capture` resolves repo → user → default at runtime, so a repo value
//     can legitimately be in force on this checkout. This read is still
//     user-global only, because the posture a machine bootstrap records is the
//     OPERATOR's default and never a project's policy.
//   * `entry_brief` / `entry_brief_empty` resolve env → user → default and ignore
//     repo activation entirely (ADR-0045 §7). An env override is per-session
//     state, not a persisted posture; the bootstrap judge reports it separately
//     as a shadow instead of reading it here.
//
// So it reads the PERSISTED user-global posture, never the effective value on this
// machine right now. A consumer that needs the effective value must ask the loader
// that owns it — this projection is not that loader and must not be mistaken for
// one.
export function projectSession(snapshot) {
  return projectRuntimeConfigFamily(snapshot, 'session', CONFIG_KEY_FAMILIES.session);
}

export async function readUserGlobalModelEffort({ homeDir }) {
  return projectModelEffort(await readUserGlobalRuntimeConfig({ homeDir }));
}

export async function readUserGlobalSession({ homeDir }) {
  return projectSession(await readUserGlobalRuntimeConfig({ homeDir }));
}

// The ONE user-global Claude settings snapshot (ADR-0048 statusline slice,
// Plan-verify peer G9): settings.json is parsed ONCE and projected per
// consumer, so two judges can never disagree about the same bytes. Honors
// CLAUDE_CONFIG_DIR — the documented relocation of ~/.claude — which the earlier
// per-consumer read silently ignored. This reads the USER layer only:
// managed/CLI/project layers outrank it at runtime, but a machine-scoped probe
// targets the user layer deliberately.
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
