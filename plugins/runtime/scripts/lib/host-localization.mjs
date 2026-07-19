// Host-localization of plugin colon-commands, runtime-internal.
//
// Moved out of footer.mjs so context.mjs (ADR-0045 entry-brief command
// synthesis) can use it without importing footer.mjs — footer.mjs imports
// context.mjs, so the reverse import would form a cycle. footer.mjs
// re-imports from here rather than keeping a private copy.
// Runtime-internal import only — the ADR-0010 §5 import ban is cross-plugin.
//
// Every entry point threads an explicit trusted host (ADR-0045 §10): the
// caller names the render host it trusts (`claude` fixed from a sensor, the
// invoking wrapper's host for CLI/dashboard). An unknown or absent host is a
// wiring bug and throws instead of silently rendering the codex `$` prefix.

// Colon-commands of every plugin with a command surface (companions is
// script-only, attention hook-only — both deliberately absent). An optional
// leading `/` or `$` is absorbed and rewritten to the render host's prefix, so
// a command reaches the user host-correct whether the source produced it bare
// (consensus/context guidance), Claude-shaped (persona projection routing like
// /engineer:resume), or Codex-shaped (a projection consumed cross-host). The
// leading-boundary guard keeps path-like text (plugins/runtime, a/engineer:x)
// unmatched. designer joined via ADR-0043 §1 (a latent omission before that —
// same "persona projection routing" contract surface as the seam expansion).
export const LOCALIZABLE_PLUGIN_NAMES = Object.freeze([
  'runtime',
  'engineer',
  'orchestrator',
  'founder',
  'designer',
  'image',
]);

const PLUGIN_COMMAND_RE = new RegExp(
  `(^|[\\s\`"'([])([/$])?((?:${LOCALIZABLE_PLUGIN_NAMES.join('|')}):[A-Za-z0-9:_-]+)`,
  'g',
);

// Frozen array + private Set: Object.freeze(new Set(...)) would NOT freeze
// the Set's entries — any importer could add()/delete() hosts and mutate the
// trusted vocabulary process-wide (footer.mjs relies on this for --host
// validation). The exported array is genuinely immutable; membership checks
// go through the unexported Set via isLocalizationHost().
export const LOCALIZATION_HOSTS = Object.freeze(['claude', 'codex', 'neutral']);
const LOCALIZATION_HOST_SET = new Set(LOCALIZATION_HOSTS);

export function isLocalizationHost(host) {
  return LOCALIZATION_HOST_SET.has(host);
}

function assertLocalizationHost(host) {
  if (!isLocalizationHost(host)) {
    throw new TypeError(
      `host-localization requires an explicit trusted host (claude|codex|neutral), got: ${String(host)}`,
    );
  }
  return host;
}

export function localizePluginCommands(value, host) {
  assertLocalizationHost(host);
  if (!value || host === 'neutral') return value;
  const prefix = host === 'claude' ? '/' : '$';
  return String(value).replace(
    PLUGIN_COMMAND_RE,
    (_match, leading, _hostPrefix, command) => `${leading}${prefix}${command}`,
  );
}

export function localizeCommandList(values, host) {
  assertLocalizationHost(host);
  return (values ?? []).map((value) => localizePluginCommands(value, host));
}

// Rewrite only the named string fields; absent fields are not introduced and
// non-string values pass through, so callers asserting object shape (e.g.
// `'archive_gate' in report.workflow`) are unaffected.
export function localizeCommandFields(target, host, fields) {
  assertLocalizationHost(host);
  if (!target) return target;
  const out = { ...target };
  for (const field of fields) {
    if (typeof out[field] === 'string') out[field] = localizePluginCommands(out[field], host);
  }
  return out;
}
