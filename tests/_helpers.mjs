// Shared helpers for the cross-package gates under `tests/`.
//
// `resolveSkillsRoot` exists because four gates spelled a plugin's skills root
// as a hardcoded `skills` path segment, while ADR-0006's 2026-09-18 Amendment
// moves each plugin's CORE content under `core/`. During the relocation the two
// spellings coexist — image moves first, the personas later — so a gate that
// assumes either one is wrong for half the tree. Each plugin already states
// where its skills live, in `.codex-plugin/plugin.json`'s `skills` key (all
// eight currently declare a spelling of `./skills/`), and that declaration is
// what Codex itself resolves. Reading it is the only spelling that stays true
// on both sides of a partial move.
//
// Not discovered by `node --test`: the stem `_helpers` matches none of Node's
// test-file patterns (`*.test`, `*-test`, `*_test`, `test-*`, `test`). It
// mirrors the co-location precedent of `tests/cross-host/_helpers.mjs` and
// `tests/acceptance/_helpers.mjs`, and is gated by
// `tests/test-skills-root-resolver.mjs`.
//
// THREE API DECISIONS, each settled before the four consumers were touched,
// because changing any of them afterwards means rewriting all four again:
//
//   1. SYNCHRONOUS. `tests/scripts/test-set-terminal-archive-timing.mjs` is
//      synchronous end to end (`readdirSync` / `existsSync`) and builds path
//      constants at module scope; an async resolver would force a top-level
//      await or lazy initialization there for no gain. The other three
//      consumers are async, and calling a sync function from async code is
//      free. One implementation also means one set of failure semantics —
//      a sync/async pair is two code paths that can drift apart.
//
//   2. THROWS, and returns a plain absolute path string. These are gates: the
//      failure this helper most has to avoid is a caller that quietly treats
//      "no root" as "no files" and passes vacuously. A result object invites
//      exactly the `catch {}` this work exists to delete. Provenance
//      (manifest vs convention) is deliberately NOT returned — no consumer
//      needs it, and an unused field invites a caller to branch on it.
//
//   3. NO CACHE. Each call re-reads a sub-2 KB manifest. A path-keyed cache
//      would be safe even under the mutation harness (it rewrites manifests in
//      a disposable `git archive HEAD` copy, i.e. at different paths), but it
//      buys nothing measurable and adds a staleness failure mode to a helper
//      whose whole job is to be trustworthy.
//
// FALLBACK IS ONE CASE, NOT A CATCH-ALL. The conventional `<plugin>/skills`
// path is used if and only if a well-formed manifest object has no `skills`
// key at all. Every other shape — an unreadable or unparseable manifest, a
// non-object manifest, `skills` set to null / "" / a number / an array / an
// object / a boolean, a root that escapes the plugin, a root that does not
// exist, a root that is not a directory — is a named failure. `null` gets its
// own code rather than folding into "not a string" precisely because it is
// the shape someone writes when they mean "absent", and the two must not
// behave alike.
//
// KNOWN LIMIT, stated rather than papered over: a symlinked root that stays
// inside the plugin is accepted (containment is checked lexically and again
// through `realpath`, so only an ESCAPING link is refused). The owner's
// no-symlink rule is about the CONVENTIONAL path of a relocated plugin —
// a per-skill link there re-registers the skill in Claude (measured 6 → 7
// skills, ~232 → ~389 always-on tok) — and that rule is enforced where it was
// measured, in `kit/lint/check-plugin-shape.mjs`, not restated here.

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

const CODEX_MANIFEST_REL = '.codex-plugin/plugin.json';
const CONVENTIONAL_SKILLS_DIR = 'skills';

/**
 * A named failure from `resolveSkillsRoot`. `code` is the stable identity —
 * tests assert on it; `message` is what a gate failure prints.
 */
export class SkillsRootError extends Error {
  constructor(code, message, { pluginDir, declared } = {}) {
    super(message);
    this.name = 'SkillsRootError';
    this.code = code;
    this.pluginDir = pluginDir;
    this.declared = declared;
  }
}

/** Render an offending value for a diagnostic without throwing on undefined. */
function describeValue(value) {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array (${JSON.stringify(value)})`;
  if (typeof value === 'object') return `an object (${JSON.stringify(value)})`;
  return `${typeof value} ${JSON.stringify(value)}`;
}

// Lexical containment, identical in semantics to
// `kit/lint/check-plugin-shape.mjs`'s `escapesDir`: `relative()` handles `..`
// traversal and absolute escapes and works for paths that do not exist yet.
// An empty relative path — the target IS the base — counts as escaping, so
// `"skills": "."` is refused here exactly as kit/lint refuses it: the skills
// root must be a strict descendant of the plugin.
function escapesDir(baseDir, absTarget) {
  const rel = relative(baseDir, absTarget);
  return rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/**
 * Resolve the directory that holds `pluginDir`'s skills, from that plugin's
 * own Codex manifest.
 *
 * @param {string} pluginDir Absolute (or cwd-relative) path to a plugin root.
 * @returns {string} Absolute path to the skills root. Guaranteed to exist, to
 *   be a directory, and to sit strictly inside the plugin.
 * @throws {SkillsRootError} On every other outcome. See the header.
 */
export function resolveSkillsRoot(pluginDir) {
  if (typeof pluginDir !== 'string' || pluginDir.length === 0) {
    throw new SkillsRootError(
      'invalid-plugin-dir',
      `resolveSkillsRoot(pluginDir): expected a non-empty string, got ${describeValue(pluginDir)}`,
      { pluginDir },
    );
  }

  const base = resolve(pluginDir);
  const manifestPath = join(base, CODEX_MANIFEST_REL);

  let raw;
  try {
    raw = readFileSync(manifestPath, 'utf8');
  } catch (err) {
    // A plugin with no Codex manifest is not a plugin whose skills root is
    // merely undeclared — kit/lint reports `.codex-plugin/plugin.json: missing`
    // for it. Falling back here would let a sweep keep passing over a plugin
    // that no longer packages for Codex at all.
    throw new SkillsRootError(
      err?.code === 'ENOENT' ? 'manifest-missing' : 'manifest-unreadable',
      err?.code === 'ENOENT'
        ? `${manifestPath} is missing — every plugin must carry a Codex manifest; `
          + 'the conventional skills path is NOT assumed for a plugin that declares nothing'
        : `${manifestPath} could not be read: ${err.message}`,
      { pluginDir: base },
    );
  }

  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (err) {
    throw new SkillsRootError(
      'manifest-invalid-json',
      `${manifestPath} is not valid JSON: ${err.message}`,
      { pluginDir: base },
    );
  }

  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new SkillsRootError(
      'manifest-not-object',
      `${manifestPath}: top level must be a JSON object, got ${describeValue(manifest)}`,
      { pluginDir: base },
    );
  }

  const declared = manifest.skills;
  let candidate;

  if (declared === undefined) {
    // THE ONLY FALLBACK. A well-formed manifest that says nothing about its
    // skills root gets the convention — which is what Codex itself does.
    candidate = resolve(base, CONVENTIONAL_SKILLS_DIR);
  } else if (declared === null) {
    throw new SkillsRootError(
      'skills-null',
      `${manifestPath} declares "skills": null. Only an ABSENT key falls back to the `
        + `conventional ${CONVENTIONAL_SKILLS_DIR}/ root; null declares nothing and is refused, `
        + 'because the two must not behave alike',
      { pluginDir: base, declared },
    );
  } else if (typeof declared !== 'string') {
    throw new SkillsRootError(
      'skills-not-string',
      `${manifestPath} declares "skills" as ${describeValue(declared)} — it must be a string path `
        + 'relative to the plugin directory',
      { pluginDir: base, declared },
    );
  } else if (declared.trim().length === 0) {
    throw new SkillsRootError(
      'skills-empty',
      `${manifestPath} declares "skills": ${JSON.stringify(declared)} — an empty declaration is `
        + `refused; omit the key to accept the conventional ${CONVENTIONAL_SKILLS_DIR}/ root`,
      { pluginDir: base, declared },
    );
  } else {
    candidate = resolve(base, declared);
  }

  // Lexical containment first: no I/O, and it keeps a hostile declaration such
  // as "../../etc" from being stat'd at all.
  if (escapesDir(base, candidate)) {
    throw new SkillsRootError(
      'skills-outside-plugin',
      `${manifestPath}: skills root ${JSON.stringify(declared ?? CONVENTIONAL_SKILLS_DIR)} resolves `
        + `to ${candidate}, which is not strictly inside ${base}`,
      { pluginDir: base, declared },
    );
  }

  let stats;
  try {
    stats = statSync(candidate);
  } catch (err) {
    throw new SkillsRootError(
      err?.code === 'ENOENT' ? 'skills-missing' : 'skills-stat-failed',
      err?.code === 'ENOENT'
        ? `${manifestPath}: skills root ${JSON.stringify(declared ?? CONVENTIONAL_SKILLS_DIR)} resolves `
          + `to ${candidate}, which does not exist`
        : `${manifestPath}: skills root ${candidate} could not be stat'd: ${err.message}`,
      { pluginDir: base, declared },
    );
  }

  if (!stats.isDirectory()) {
    throw new SkillsRootError(
      'skills-not-directory',
      `${manifestPath}: skills root ${JSON.stringify(declared ?? CONVENTIONAL_SKILLS_DIR)} resolves `
        + `to ${candidate}, which exists but is not a directory`,
      { pluginDir: base, declared },
    );
  }

  // Physical containment, mirroring kit/lint's two-gate idiom: a symlinked root
  // pointing outside the plugin is outside the plugin. Both sides go through
  // `realpath` so a symlinked base — every macOS `mkdtemp` under /tmp, which is
  // /private/tmp — is not itself read as an escape.
  let realBase;
  let realRoot;
  try {
    realBase = realpathSync(base);
    realRoot = realpathSync(candidate);
  } catch (err) {
    throw new SkillsRootError(
      'skills-realpath-failed',
      `${manifestPath}: skills root ${candidate} could not be resolved through realpath: ${err.message}`,
      { pluginDir: base, declared },
    );
  }
  if (escapesDir(realBase, realRoot)) {
    throw new SkillsRootError(
      'skills-outside-plugin-symlink',
      `${manifestPath}: skills root ${JSON.stringify(declared ?? CONVENTIONAL_SKILLS_DIR)} resolves `
        + `through a link to ${realRoot}, which is outside ${realBase}`,
      { pluginDir: base, declared },
    );
  }

  // The lexical path, not the realpath: callers print it in diagnostics, and a
  // realpath would render a macOS tmp fixture as /private/tmp/… for no benefit.
  return candidate;
}

/**
 * `join(resolveSkillsRoot(pluginDir), ...segments)`. Sugar for the call sites
 * that want a file under the root rather than the root itself; it propagates
 * `SkillsRootError` unchanged.
 *
 * @param {string} pluginDir Absolute (or cwd-relative) path to a plugin root.
 * @param {...string} segments Path segments beneath the skills root.
 * @returns {string} Absolute path.
 */
export function skillsPath(pluginDir, ...segments) {
  return join(resolveSkillsRoot(pluginDir), ...segments);
}
