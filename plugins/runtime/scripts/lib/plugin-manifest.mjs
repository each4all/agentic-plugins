// plugins/runtime/scripts/lib/plugin-manifest.mjs
//
// The ONE reader for a plugin package's version, and the evidence behind it.
//
// A runtime plugin package carries TWO manifests — `.claude-plugin/plugin.json`
// and `.codex-plugin/plugin.json` — because release-please writes both from one
// `extra-files` mapping. Two readers had grown around that, and they disagreed
// in a way nothing reported:
//
//   - `version.mjs` reads `.codex-plugin` first;
//   - the host-parity baseline resolver read `.claude-plugin` first.
//
// Measured, not assumed: given a package whose manifests say `1.1.1` and
// `2.2.2`, the artifact stamp and the baseline provenance name DIFFERENT
// versions for the SAME install, and neither says so. Both readers also
// swallowed a malformed manifest silently and fell through to the other, and
// both accepted `"banana"` as a version while the module next door rejects it.
//
// So this module reports STATE, not just a value:
//
//   per manifest: 'ok' | 'absent' | 'unreadable' | 'malformed' | 'invalid'
//   overall:      'ok' | 'partial' | 'disagreement' | 'absent' | 'unusable'
//
// `version` is still produced when one is usable, because a runtime command
// that cannot stamp an artifact is worse than one that stamps it with the only
// version available — but `status` travels with it so a surface can say the
// install is corrupt instead of quietly picking a side.
//
// The tiebreak on `disagreement` is Codex-first. That is arbitrary on the
// merits — neither manifest is more authoritative — and it is chosen only
// because it is what `version.mjs` already did, so unifying the two readers
// does not silently restamp every artifact in the repository. The disagreement
// itself is the reportable fact, not which half won.
//
// Manifests are resolved through `resolveContained`, like every other packaged
// asset: a symlinked `.claude-plugin/plugin.json` pointing outside the package
// reported `runtime_version: 99.99.99` before this, with `source: 'package'`
// still attached to it.

import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { resolveContained, resolveContainedSync } from './path-containment.mjs';
import { isSemVer } from './semver.mjs';

export const CLAUDE_MANIFEST_RELATIVE_PATH = '.claude-plugin/plugin.json';
export const CODEX_MANIFEST_RELATIVE_PATH = '.codex-plugin/plugin.json';

// Codex first — see the tiebreak note above.
const MANIFESTS = Object.freeze([
  Object.freeze({ host: 'codex', relative: CODEX_MANIFEST_RELATIVE_PATH }),
  Object.freeze({ host: 'claude', relative: CLAUDE_MANIFEST_RELATIVE_PATH }),
]);

// A manifest version must BE a version. `typeof === 'string' && length` let
// `"banana"` through as `runtime_version`, while `normalizeVersion` one module
// over rejects exactly that string — the package disagreeing with itself about
// what a version is. The shape predicate is `semver.mjs`'s, shared with the
// plugin-set validator: the first version of this file carried a loose private
// copy that accepted `01.2.3` and `1.2.3-01`, neither of which is SemVer.
function classify(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 'malformed', version: null };
  }
  const version = parsed?.version;
  if (typeof version !== 'string' || !version.trim()) return { status: 'invalid', version: null, raw: null };
  const trimmed = version.trim();
  // The raw value travels on rejection: an operator debugging a corrupt
  // install needs to see WHAT the manifest says, not just that it is wrong.
  if (!isSemVer(trimmed)) return { status: 'invalid', version: null, raw: trimmed };
  return { status: 'ok', version: trimmed };
}

function summarize(entries) {
  const usable = entries.filter((entry) => entry.status === 'ok');
  const distinct = new Set(usable.map((entry) => entry.version));
  if (usable.length === 0) {
    const status = entries.every((entry) => entry.status === 'absent') ? 'absent' : 'unusable';
    return { version: null, status, manifests: Object.fromEntries(entries.map((e) => [e.host, e])) };
  }
  const status = usable.length < entries.length
    ? 'partial'
    : distinct.size > 1 ? 'disagreement' : 'ok';
  return {
    version: usable[0].version,
    status,
    manifests: Object.fromEntries(entries.map((e) => [e.host, e])),
  };
}

/** Async form — for commands that already run in an async resolver. */
export async function readPluginManifestVersions(pluginRoot, { read = readFile } = {}) {
  const entries = [];
  for (const { host, relative } of MANIFESTS) {
    const located = await resolveContained(pluginRoot, relative);
    if (located.status !== 'ok') {
      entries.push({ host, status: located.status === 'missing' ? 'absent' : located.status, version: null, path: located.path });
      continue;
    }
    let raw;
    try {
      raw = await read(located.canonicalPath, 'utf8');
    } catch (err) {
      entries.push({ host, status: err?.code === 'ENOENT' ? 'absent' : 'unreadable', version: null, path: located.path });
      continue;
    }
    entries.push({ host, ...classify(raw), path: located.path });
  }
  return summarize(entries);
}

/**
 * Sync form — `version.mjs` computes `RUNTIME_VERSION` at module load, before
 * any async context exists, and every runtime command imports it.
 *
 * Containment is asked here too, through the SHARED synchronous predicate.
 * That is four extra syscalls per process against a stamp that lands in every
 * artifact; the measured escape (a symlinked manifest reporting `99.99.99`) is
 * the thing being prevented. A private copy of the comparison lived here first
 * and compared with a hard-coded `/`, which made every Windows manifest
 * `escaped` — the reason there is now one implementation instead of two.
 */
export function readPluginManifestVersionsSync(pluginRoot, { read = readFileSync, ...locateOptions } = {}) {
  const entries = [];
  for (const { host, relative } of MANIFESTS) {
    const located = resolveContainedSync(pluginRoot, relative, locateOptions);
    if (located.status !== 'ok') {
      entries.push({ host, status: located.status === 'missing' ? 'absent' : located.status, version: null, path: located.path });
      continue;
    }
    let raw;
    try {
      raw = read(located.canonicalPath, 'utf8');
    } catch (err) {
      entries.push({ host, status: err?.code === 'ENOENT' ? 'absent' : 'unreadable', version: null, path: located.path });
      continue;
    }
    entries.push({ host, ...classify(raw), path: located.path });
  }
  return summarize(entries);
}
