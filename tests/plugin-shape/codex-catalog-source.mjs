// Phase-aware assertion for one plugin's Codex catalog source — ADR-0061
// Decision 1 (the pinned shape) and Decision 2 (the phase, read from the
// `activated` marker in scripts/data/codex-pin-floors.json).
//
// Before activation every entry is the `local` source this repository has
// always published, and the path must resolve. After it, every entry is a pin
// at the package's own version. The five plugin-shape files that used to
// assert `source: "local"` call this instead, so activation flips them all in
// the same commit that flips the catalog rather than turning them red.
//
// Written against the ADR text rather than by importing
// scripts/lib/codex-catalog-pins.mjs: a bug shared with the validator would
// otherwise pass both. The history half (tag resolves, peels to sha) is the
// validator's alone — these tests read the working tree only, except that the
// activated catalog's expected names need the release tags (see
// expectedCodexCatalogNames).
//
// Not discovered by `node --test`: the stem matches none of Node's test-file
// patterns. Its own gate is tests/plugin-shape/test-codex-catalog-source.mjs,
// which drives the activated branch before the real catalog reaches it.

import { deepStrictEqual, ok, strictEqual } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const FLOORS_REL = 'scripts/data/codex-pin-floors.json';

/** The Decision 2 phase marker. Absent or non-boolean is a failure, never "not activated". */
export function codexCatalogActivated(repoRoot) {
  const data = JSON.parse(readFileSync(resolve(repoRoot, FLOORS_REL), 'utf8'));
  strictEqual(typeof data.activated, 'boolean', `${FLOORS_REL} must carry a boolean "activated" marker`);
  return data.activated;
}

function compare(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/**
 * @param {object} entry            the plugin's `.agents/plugins/marketplace.json` entry
 * @param {string} name             the plugin name
 * @param {object} options
 * @param {string} options.repoRoot
 * @param {string} options.version  the package version (its `.codex-plugin/plugin.json`)
 * @param {boolean} [options.allowLag]  release-please PR: a pin may trail, never lead
 * @param {boolean} [options.activated] override for the helper's own gate
 */
export function assertCodexCatalogSource(entry, name, { repoRoot, version, allowLag = false, activated }) {
  const phaseActivated = activated ?? codexCatalogActivated(repoRoot);
  if (!phaseActivated) {
    deepStrictEqual(entry.source, { source: 'local', path: `./plugins/${name}` },
      `before activation the ${name} Codex entry is local (ADR-0061 Decision 2)`);
    ok(existsSync(resolve(repoRoot, entry.source.path)), `Codex source.path must resolve to plugins/${name}`);
    return;
  }
  const source = entry.source;
  deepStrictEqual(Object.keys(source).sort(), ['path', 'ref', 'sha', 'source', 'url'],
    `after activation the ${name} Codex entry is a pin and nothing else (ADR-0061 Decision 1)`);
  strictEqual(source.source, 'git-subdir');
  strictEqual(source.url, './', 'a pin materializes from the marketplace snapshot, never the network');
  strictEqual(source.path, `plugins/${name}`);
  ok(/^[0-9a-f]{40}$/.test(source.sha), `sha must be 40 lowercase hex, got ${JSON.stringify(source.sha)}`);
  const m = /^plugin-(.+)-v(\d+\.\d+\.\d+)$/.exec(source.ref);
  ok(m, `ref must be plugin-${name}-v<X.Y.Z>, got ${JSON.stringify(source.ref)}`);
  strictEqual(m[1], name, 'the ref names this plugin');
  const delta = compare(m[2], version);
  if (allowLag) ok(delta <= 0, `pin ${m[2]} may trail package ${version} in a release-please PR, never lead it`);
  else strictEqual(m[2], version, 'the pinned version is the package version');
}

/**
 * The plugin names the Codex catalog lists, given the names every other
 * surface lists (the Claude catalog, runtime's plugin set, PLUGIN_NAMES).
 * Before activation they are the same set. After it, Decision 2 exempts a
 * package with no release tag yet — it has no Codex entry until the writer
 * adds its first pin — and the exemption ends at its first release. Git is
 * read only once activated, and then the answer depends on the release tags,
 * so a checkout without them fails here and says so (Decision 2's "no
 * history" rule). Without that, a shallow checkout reads as "nothing is
 * released" and the assertion reports a catalog/expectation diff instead of
 * the missing history.
 */
export function expectedCodexCatalogNames(repoRoot, names, { activated } = {}) {
  const phaseActivated = activated ?? codexCatalogActivated(repoRoot);
  if (!phaseActivated) return [...names].sort();
  const git = (...args) => execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
  if (git('rev-parse', '--is-shallow-repository').trim() === 'true') {
    throw new Error('the activated Codex catalog names are decided by release tags, and this is a shallow clone (check out with fetch-depth: 0)');
  }
  const tags = git('tag', '--list', 'plugin-*-v*').split('\n').filter(Boolean);
  if (tags.length === 0) {
    throw new Error('the activated Codex catalog names are decided by release tags, and no plugin-*-v* tag is present (fetch the tags)');
  }
  const released = (name) => tags.some((t) => t.startsWith(`plugin-${name}-v`) && /^\d+\.\d+\.\d+/.test(t.slice(`plugin-${name}-v`.length)));
  return names.filter(released).sort();
}
