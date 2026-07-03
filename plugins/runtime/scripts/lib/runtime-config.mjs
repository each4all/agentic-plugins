// Runtime-internal contract lib for the .agentic-plugins/config.toml flat-key
// surface: key families, shipped notify defaults, per-key semantic validators,
// and the line-oriented TOML read parser.
//
// Extracted from settings.mjs (which re-exports the public names unchanged) so
// the ADR-0040 §2 notify emitter can consume the OFFICIAL key contract without
// loading the settings/doctor plan pipeline — settings.mjs and notify.mjs must
// agree on keys, defaults, and validity byte-for-byte, and this module is that
// single source. Deliberately dependency-light: only the §1 notify-schema
// contract lib (for the notify_kinds CSV parser) — no doctor/plan machinery.
//
// Known remaining duplicate: doctor.mjs carries a private line-parser twin
// (doctor.mjs inspectModelEffort) with deliberately different semantics — it
// reports ALL keys for diagnosis, not just CONFIG_KEYS. Unifying it onto this
// module (e.g. a knownOnly option) belongs to the ADR-0040 doctor-reader
// extraction slice, which restructures doctor's read layer anyway.

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
  ]),
  notify: Object.freeze([
    'notify_channel',
    'notify_quiet_hours',
    'notify_quiet_hours_tz',
    'notify_dedupe_ttl_seconds',
    'notify_urgent_bypass_quiet_hours',
    'notify_kinds',
  ]),
});
export const CONFIG_KEYS = Object.freeze(Object.values(CONFIG_KEY_FAMILIES).flat());

export const NOTIFY_CHANNELS = Object.freeze(['none', 'macos-osascript', 'file-log']);

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
};

export function validateConfigValue(key, value) {
  CONFIG_KEY_VALIDATORS[key]?.(value, key);
}

export function normalizeConfigKey(key) {
  return String(key).replace(/[.-]/g, '_');
}

export function parseRuntimeConfigToml(text) {
  const result = {};
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const withoutComment = raw.replace(/#.*/, '').trim();
    if (!withoutComment || withoutComment.startsWith('[')) continue;
    const match = withoutComment.match(/^([A-Za-z0-9_.-]+)\s*=\s*("?)(.*?)\2\s*$/);
    if (!match) continue;
    const key = normalizeConfigKey(match[1]);
    const value = match[3].trim();
    if (CONFIG_KEYS.includes(key) && value) result[key] = value;
  }
  return result;
}
