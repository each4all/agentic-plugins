// Runtime-internal contract lib for the .agentic-plugins/config.toml flat-key
// surface: key families, shipped notify/session defaults, per-key semantic
// validators, the line-oriented TOML read parser, and the shared effective
// config loader (repo → user → shipped default) the per-family loaders build on.
//
// Extracted from settings.mjs (which re-exports the public names unchanged) so
// the ADR-0040 §2 notify emitter can consume the OFFICIAL key contract without
// loading the settings/doctor plan pipeline — settings.mjs and notify.mjs must
// agree on keys, defaults, and validity byte-for-byte, and this module is that
// single source. The ADR-0044 §3 `session` family lives here for the same
// reason: the future publish-session executor and the settings/doctor
// diagnosis surfaces must agree on the key, its default, and its validity.
// Deliberately dependency-light: only the §1 notify-schema contract lib (for
// the notify_kinds CSV parser) plus node builtins for the config-layer reads —
// no doctor/plan machinery.
//
// Known remaining duplicate: lib/peer-execution-context.mjs carries a private line-parser twin
// (its private inspectModelEffort) with deliberately different semantics — it
// reports ALL keys for diagnosis, not just CONFIG_KEYS. It travelled with
// inspectModelEffort when that moved out of doctor.mjs; unifying it onto this module
// (e.g. a knownOnly option) is still open and still a behavior change.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseKindsFilter } from './notify-schema.mjs';

// Config keys are grouped into families so the plan/apply pipeline stays a
// generic key-family differ: the differ, TOML parser/upsert, and CLI flag
// mapping all derive from this table instead of hardcoding one family's
// shape (ADR-0040 §2 generalized the former model/effort-only list).
export const CONFIG_KEY_FAMILIES = Object.freeze({
  model_effort: Object.freeze([
    'model',
    'effort',
    'claude_model',
    'claude_effort',
    'codex_model',
    'codex_effort',
    // The machine's model/effort POSTURE, not a coordinate (§6.1 Stage 4). It
    // declares that leaving a coordinate unset is deliberate — the last step of
    // the documented resolution order is literally `host-native default`, and
    // `resolveOneSetting` already returns `{value: null, source: 'host-native
    // default'}` there, so "no key" is a RESOLVED posture in the consuming code
    // and the only thing missing was a way to say it was chosen.
    //
    // It is POLICY METADATA and is never a model identifier: the peer resolver
    // reads a closed key list (`[<peer>_model, model]` / `[<peer>_effort,
    // effort]`), so this key cannot reach a companion as an argument. That is
    // the whole reason it is a separate key rather than a sentinel VALUE in
    // `model` — a sentinel would be handed to the companion verbatim.
    'model_effort_fallback',
  ]),
  notify: Object.freeze([
    'notify_channel',
    'notify_quiet_hours',
    'notify_quiet_hours_tz',
    'notify_dedupe_ttl_seconds',
    'notify_urgent_bypass_quiet_hours',
    'notify_kinds',
  ]),
  // ADR-0044 §3 — the session-capture opt-in. An enum (not a boolean) so a
  // future origin can join without a schema break, mirroring notify_channel.
  // The shipped default "off" is what makes the hook-auto-invoked publisher
  // mutate nothing until the operator opts in (the narrow ADR-0035 §3
  // invariant-1 amendment scoped to publish-session).
  // ADR-0045 §7 adds the entry-brief pair to the same family. Being listed
  // here is what auto-generates their settings CLI flags — which is why the
  // §7 scope asymmetry (user-scope-only activation) must land in the same
  // change: without USER_SCOPE_ONLY_CONFIG_KEYS below, --target both (the
  // settings default) would write them repo-side the moment they exist.
  session: Object.freeze([
    'session_capture',
    'entry_brief',
    'entry_brief_empty',
  ]),
});
export const CONFIG_KEYS = Object.freeze(Object.values(CONFIG_KEY_FAMILIES).flat());

export const NOTIFY_CHANNELS = Object.freeze(['none', 'macos-osascript', 'file-log']);

// The declarable model/effort postures. An enum rather than a boolean so a
// future posture can join without a schema break (the notify_channel
// precedent), and deliberately NOT named "default": `host-native` says which
// authority chooses, which is the fact being recorded. It governs only the
// coordinates nothing else set — explicit command flags, a workflow override,
// repo config and user-global keys all still win for their own coordinate.
export const MODEL_EFFORT_FALLBACK_POSTURES = Object.freeze(['host-native']);

export const SESSION_CAPTURE_MODES = Object.freeze(['off', 'stop-hook']);

export const ENTRY_BRIEF_MODES = Object.freeze(['off', 'startup']);

export const ENTRY_BRIEF_EMPTY_MODES = Object.freeze(['silent', 'report']);

export const SESSION_KEY_DEFAULTS = Object.freeze({
  session_capture: 'off',
  entry_brief: 'off',
  entry_brief_empty: 'silent',
});

// Keys the settings plan/apply path refuses to write repo-side. Two distinct
// reasons live here, and both end at the same rule:
//
//   * ADR-0045 §7 — the deliberate deviation from repo → user precedence:
//     `entry_brief*` activate a session-shaping injected line, so a tracked repo
//     value can NEVER enable them (a cloned repository could otherwise flip the
//     key against the operator's global off). They are read from user-global
//     config and env only; a repo value is detected and reported as ignored.
//   * §6.1 Stage 4 — `model_effort_fallback` declares a MACHINE posture, and the
//     only reader that judges it (bootstrap's Stage-4 step) reads user-global
//     config exclusively, while the peer resolver never reads it at all. A
//     repo-side copy would therefore be a key nothing consults: dead
//     configuration that looks live. Repo-local model/effort COORDINATES stay
//     perfectly legitimate — it is the posture declaration that has one home.
export const USER_SCOPE_ONLY_CONFIG_KEYS = Object.freeze(['entry_brief', 'entry_brief_empty', 'model_effort_fallback']);

// Env overrides sit ABOVE user-global config for the user-scope-only keys —
// env is per-machine operator state, never repo-trackable, so it keeps the
// same trust class as the user layer while allowing per-session overrides.
export const ENTRY_BRIEF_ENV_KEYS = Object.freeze({
  entry_brief: 'AGENTIC_ENTRY_BRIEF',
  entry_brief_empty: 'AGENTIC_ENTRY_BRIEF_EMPTY',
});

// Shipped defaults the emitter uses when a key is unset (ADR-0040 §2).
// null = "unset is meaningful": quiet hours off, host-local timezone,
// no kinds filter (all kinds enabled).
export const NOTIFY_KEY_DEFAULTS = Object.freeze({
  notify_channel: 'none',
  notify_quiet_hours: null,
  notify_quiet_hours_tz: null,
  notify_dedupe_ttl_seconds: '300',
  notify_urgent_bypass_quiet_hours: 'true',
  notify_kinds: null,
});

export const QUIET_HOURS_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]-([01][0-9]|2[0-3]):[0-5][0-9]$/;

// Per-key semantic validators, applied by settings' normalizeDesiredConfig
// after the generic single-line normalization — every desired-config entry
// path (CLI parseArgs, programmatic runSettings, upsertRuntimeConfigToml)
// funnels through that gate, and the notify emitter applies the same
// validators to every effective value it resolves (fail-closed on invalid).
// Keys without an entry accept any single-line value (model/effort stay
// free-form host identifiers).
export const CONFIG_KEY_VALIDATORS = {
  notify_channel: (value, key) => {
    if (!NOTIFY_CHANNELS.includes(value)) {
      throw new Error(`${key} must be one of ${NOTIFY_CHANNELS.join(', ')}`);
    }
  },
  notify_quiet_hours: (value, key) => {
    if (!QUIET_HOURS_RE.test(value)) {
      throw new Error(`${key} must match HH:MM-HH:MM (24h, cross-midnight allowed), e.g. 22:00-08:00`);
    }
  },
  notify_quiet_hours_tz: (value, key) => {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: value });
    } catch {
      throw new Error(`${key} must be a valid IANA timezone identifier, e.g. Asia/Seoul`);
    }
  },
  notify_dedupe_ttl_seconds: (value, key) => {
    if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(Number.parseInt(value, 10)) || Number.parseInt(value, 10) <= 0) {
      throw new Error(`${key} must be a positive integer of seconds`);
    }
  },
  notify_urgent_bypass_quiet_hours: (value, key) => {
    if (value !== 'true' && value !== 'false') {
      throw new Error(`${key} must be "true" or "false"`);
    }
  },
  notify_kinds: (value, key) => {
    // Single source of truth for the kind enum: the ADR-0040 §1 contract
    // lib's own CSV parser — never re-enumerate kinds here.
    const parsed = parseKindsFilter(value);
    if (!parsed.ok) {
      throw new Error(`${key} is invalid: ${parsed.errors.join('; ')}`);
    }
  },
  model_effort_fallback: (value, key) => {
    if (!MODEL_EFFORT_FALLBACK_POSTURES.includes(value)) {
      throw new Error(`${key} must be one of ${MODEL_EFFORT_FALLBACK_POSTURES.join(', ')}`);
    }
  },
  session_capture: (value, key) => {
    if (!SESSION_CAPTURE_MODES.includes(value)) {
      throw new Error(`${key} must be one of ${SESSION_CAPTURE_MODES.join(', ')}`);
    }
  },
  entry_brief: (value, key) => {
    if (!ENTRY_BRIEF_MODES.includes(value)) {
      throw new Error(`${key} must be one of ${ENTRY_BRIEF_MODES.join(', ')}`);
    }
  },
  entry_brief_empty: (value, key) => {
    if (!ENTRY_BRIEF_EMPTY_MODES.includes(value)) {
      throw new Error(`${key} must be one of ${ENTRY_BRIEF_EMPTY_MODES.join(', ')}`);
    }
  },
};

export function validateConfigValue(key, value) {
  CONFIG_KEY_VALIDATORS[key]?.(value, key);
}

export function normalizeConfigKey(key) {
  return String(key).replace(/[.-]/g, '_');
}

export function parseRuntimeConfigToml(text) {
  const result = {};
  let insideTable = false;
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const withoutComment = raw.replace(/#.*/, '').trim();
    if (!withoutComment) continue;
    // The config surface is FLAT-KEY by contract. A `[section]` header opens a
    // table scope this parser does not model — keys under it must NOT be read
    // as if they were top-level authorization keys (S2 plan-verify finding: a
    // `session_capture` under `[some.table]` was silently treated as the
    // global gate key). Once a table opens, everything after it is ignored.
    if (withoutComment.startsWith('[')) { insideTable = true; continue; }
    if (insideTable) continue;
    const match = withoutComment.match(/^([A-Za-z0-9_.-]+)\s*=\s*("?)(.*?)\2\s*$/);
    if (!match) continue;
    const key = normalizeConfigKey(match[1]);
    const value = match[3].trim();
    // Presence of a KNOWN key is preserved even for an empty value: dropping
    // `session_capture = ""` would let a lower-precedence layer win the
    // precedence chain and flip a gate the higher layer explicitly set — the
    // empty value must instead reach the per-key validator and fail closed
    // (S2 plan-verify finding).
    if (CONFIG_KEYS.includes(key)) result[key] = value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Shared effective-config loading (repo → user → shipped default)
// ---------------------------------------------------------------------------

// ONLY a genuinely absent layer reads as empty (ENOENT; ENOTDIR = a parent
// path component is a file). Any other failure (EACCES, EISDIR, EIO) is NOT
// "absent" and fail-closes the whole load (Codex review MAJOR on the notify
// loader, promoted here as the one shared rule): treating an unreadable
// HIGHER-precedence layer as missing would let a lower-precedence layer flip
// a gate on against the operator's recorded intent.
export function readTomlIfExists(filePath) {
  try {
    return { ok: true, text: fs.readFileSync(filePath, 'utf8') };
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) {
      return { ok: true, text: '' };
    }
    return { ok: false, error: `${filePath}: ${error?.code ?? error?.message ?? 'unreadable'}` };
  }
}

// The single effective-config core every family loader builds on: two-layer
// read (repo-local .agentic-plugins/config.toml over user-global
// ~/.agentic-plugins/config.toml), repo → user → shipped-default precedence
// per key, each non-null effective value validated by the OFFICIAL per-key
// validators (fail-closed on invalid). Family loaders add only their own
// post-processing (e.g. notify's kinds parse / type coercion) — never a
// second copy of layering or validation, so a precedence or fail-closed fix
// lands once here instead of per-family (the mirror-fix rule).
export function loadEffectiveConfig({ repoRoot, homeDir = os.homedir(), keys, defaults = {} } = {}) {
  const repoRead = readTomlIfExists(path.join(repoRoot, '.agentic-plugins', 'config.toml'));
  const userRead = readTomlIfExists(path.join(homeDir, '.agentic-plugins', 'config.toml'));
  const readErrors = [repoRead, userRead]
    .filter((layer) => !layer.ok)
    .map((layer) => `config layer unreadable (fail-closed): ${layer.error}`);
  if (readErrors.length > 0) return { ok: false, effective: null, errors: readErrors };
  const repoConfig = parseRuntimeConfigToml(repoRead.text);
  const userConfig = parseRuntimeConfigToml(userRead.text);
  const errors = [];
  const effective = {};
  for (const key of keys) {
    const value = repoConfig[key] ?? userConfig[key] ?? defaults[key] ?? null;
    if (value !== null) {
      try {
        validateConfigValue(key, value);
      } catch (error) {
        errors.push(error.message);
        continue;
      }
    }
    effective[key] = value;
  }
  if (errors.length > 0) return { ok: false, effective: null, errors };
  return { ok: true, effective, errors: [] };
}

// Effective `session_capture` config (ADR-0044 §3). Consumed by the
// publish-session executor's config gate and by the settings/doctor
// readiness surfaces — one loader so the gate and the diagnosis can never
// disagree about what "on" means. Fail-closed on unreadable layers or an
// invalid effective value: a broken config never turns capture on.
//
// Deliberately loads ONLY session_capture, not the whole session family: the
// ADR-0045 entry-brief keys share the family (settings surface + CLI flags)
// but have their own user-scope-only loader below — an invalid entry_brief
// value in some layer must not fail-close the capture gate, and vice versa
// (independent gates, independent failure domains).
const SESSION_CAPTURE_KEYS = Object.freeze(['session_capture']);

export function loadSessionConfig({ repoRoot, homeDir = os.homedir() } = {}) {
  const loaded = loadEffectiveConfig({
    repoRoot,
    homeDir,
    keys: SESSION_CAPTURE_KEYS,
    defaults: SESSION_KEY_DEFAULTS,
  });
  if (!loaded.ok) return { ok: false, config: null, errors: loaded.errors };
  return {
    ok: true,
    errors: [],
    config: { sessionCapture: loaded.effective.session_capture },
  };
}

// Effective entry-brief config (ADR-0045 §7) — the deliberate precedence
// deviation: env (per-machine operator state) > user-global config > shipped
// default, with the REPO layer never effective. The repo file is still read
// (best-effort) so callers can report a tracked value as ignored; an
// unreadable repo layer cannot affect the gate (this key has no repo
// precedence to protect) and degrades to `repo_layer: 'unreadable'` instead
// of fail-closing. The USER layer keeps the shared fail-closed rule: an
// unreadable user config or an invalid effective value never turns the
// injected line on.
export function loadEntryBriefConfig({ repoRoot = null, homeDir = os.homedir(), env = process.env } = {}) {
  const userPath = path.join(homeDir, '.agentic-plugins', 'config.toml');
  const userRead = readTomlIfExists(userPath);
  if (!userRead.ok) {
    return {
      ok: false,
      config: null,
      errors: [`config layer unreadable (fail-closed): ${userRead.error}`],
      ignoredRepoKeys: [],
      repoLayer: 'unknown',
    };
  }
  let userConfig = parseRuntimeConfigToml(userRead.text);

  let repoLayer = 'absent';
  const ignoredRepoKeys = [];
  if (repoRoot) {
    const repoPath = path.join(repoRoot, '.agentic-plugins', 'config.toml');
    const repoRead = readTomlIfExists(repoPath);
    if (!repoRead.ok) {
      repoLayer = 'unreadable';
    } else {
      const repoConfig = parseRuntimeConfigToml(repoRead.text);
      repoLayer = repoRead.text === '' ? 'absent' : 'read';
      for (const key of USER_SCOPE_ONLY_CONFIG_KEYS) {
        if (Object.hasOwn(repoConfig, key)) ignoredRepoKeys.push(key);
      }
    }
    // Path-alias defense (codex review MAJOR, reproduced with
    // repoRoot === homeDir): when the "user" file IS the repo file, its
    // values are repo-trackable and must not become user-effective — the
    // user layer is stripped of the user-scope-only keys and the aliasing
    // is reported. realpath collapses symlink aliases; a vanished file
    // falls back to the resolved-path comparison.
    if (repoLayer !== 'absent' || Object.keys(userConfig).length > 0) {
      if (sameConfigFile(repoPath, userPath)) {
        const stripped = { ...userConfig };
        for (const key of USER_SCOPE_ONLY_CONFIG_KEYS) {
          if (Object.hasOwn(stripped, key)) {
            delete stripped[key];
            if (!ignoredRepoKeys.includes(key)) ignoredRepoKeys.push(key);
          }
        }
        userConfig = stripped;
        repoLayer = 'aliased-to-user';
      }
    }
  }

  const errors = [];
  const effective = {};
  for (const key of USER_SCOPE_ONLY_CONFIG_KEYS) {
    const envName = ENTRY_BRIEF_ENV_KEYS[key];
    const envRaw = envName ? env?.[envName] : undefined;
    // Presence semantics mirror the TOML parser's security rule (plan-verify
    // peer): an env var that EXISTS with an empty/whitespace value reaches
    // the validator and fails closed — it never falls through to the user
    // layer as if absent.
    const envValue = typeof envRaw === 'string' ? envRaw.trim() : null;
    const userValue = userConfig[key] ?? null;
    // BOTH layers validate, not just the winner (codex review MAJOR): a
    // valid env over an invalid stored user value must still fail-close —
    // contract §17 binds any invalid env or user value for either key.
    for (const [candidate, label] of [[envValue, envName], [userValue, null]]) {
      if (candidate === null) continue;
      try {
        validateConfigValue(key, candidate);
      } catch (error) {
        errors.push(label !== null ? `${label}: ${error.message}` : error.message);
      }
    }
    effective[key] = envValue ?? userValue ?? SESSION_KEY_DEFAULTS[key] ?? null;
  }
  if (errors.length > 0) {
    return { ok: false, config: null, errors, ignoredRepoKeys, repoLayer };
  }
  return {
    ok: true,
    errors: [],
    config: {
      entryBrief: effective.entry_brief,
      entryBriefEmpty: effective.entry_brief_empty,
    },
    ignoredRepoKeys,
    repoLayer,
  };
}

function sameConfigFile(aPath, bPath) {
  const canonical = (candidate) => {
    try {
      return fs.realpathSync(candidate);
    } catch {
      return path.resolve(candidate);
    }
  };
  return canonical(aPath) === canonical(bPath);
}
