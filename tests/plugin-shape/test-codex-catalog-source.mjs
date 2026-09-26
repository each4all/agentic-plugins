// Gate for tests/plugin-shape/codex-catalog-source.mjs.
//
// The five plugin-shape files run that helper against the real catalog, which
// is in one phase at a time, so the real catalog exercises only one of the
// helper's two branches. These cases drive both branches with synthetic
// entries, each rejection paired with a passing control on the same branch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertCodexCatalogSource, codexCatalogActivated, expectedCodexCatalogNames } from './codex-catalog-source.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const SHA = '0123456789abcdef0123456789abcdef01234567';

const pin = (overrides = {}) => ({
  name: 'runtime',
  source: { source: 'git-subdir', url: './', path: 'plugins/runtime', ref: 'plugin-runtime-v1.2.3', sha: SHA, ...overrides },
});
const local = (path = './plugins/runtime') => ({ name: 'runtime', source: { source: 'local', path } });
const check = (entry, opts) => () => assertCodexCatalogSource(entry, 'runtime', { repoRoot: REPO_ROOT, version: '1.2.3', ...opts });

test('the real phase marker is a boolean', () => {
  assert.equal(typeof codexCatalogActivated(REPO_ROOT), 'boolean');
});

test('pre-activation: CONTROL a resolving local entry passes', () => {
  assert.doesNotThrow(check(local(), { activated: false }));
});

test('pre-activation: a pin is rejected', () => {
  assert.throws(check(pin(), { activated: false }), /before activation the runtime Codex entry is local/);
});

test('pre-activation: a correctly spelled local path whose directory is missing is rejected', () => {
  // The spelling matches, so only the existence check can reject it.
  const entry = { name: 'nowhere', source: { source: 'local', path: './plugins/nowhere' } };
  assert.throws(
    () => assertCodexCatalogSource(entry, 'nowhere', { repoRoot: REPO_ROOT, version: '1.0.0', activated: false }),
    /Codex source\.path must resolve to plugins\/nowhere/,
  );
});

test('activated: CONTROL a well-formed pin at the package version passes', () => {
  assert.doesNotThrow(check(pin(), { activated: true }));
});

test('activated: a local entry is rejected', () => {
  assert.throws(check(local(), { activated: true }), /is a pin and nothing else/);
});

for (const [label, overrides, pattern] of [
  ['a network url', { url: 'https://github.com/each4all/agentic-plugins' }, /snapshot/],
  ['a ./-prefixed path', { path: './plugins/runtime' }, /plugins\/runtime/],
  ['an uppercase sha', { sha: SHA.toUpperCase() }, /40 lowercase hex/],
  ['a ref for another plugin', { ref: 'plugin-engineer-v1.2.3' }, /the ref names this plugin/],
  ['a ref without the v', { ref: 'plugin-runtime-1.2.3' }, /ref must be plugin-runtime-v<X\.Y\.Z>/],
  ['a trailing pin', { ref: 'plugin-runtime-v1.2.2' }, /the pinned version is the package version/],
]) {
  test(`activated: ${label} is rejected`, () => {
    assert.throws(check(pin(overrides), { activated: true }), pattern);
  });
}

test('activated: an extra key is rejected', () => {
  const entry = pin();
  entry.source.version = '1.2.3';
  assert.throws(check(entry, { activated: true }), /is a pin and nothing else/);
});

test('activated, release-please PR: CONTROL a trailing pin passes', () => {
  assert.doesNotThrow(check(pin({ ref: 'plugin-runtime-v1.2.2' }), { activated: true, allowLag: true }));
});

test('activated, release-please PR: a leading pin is still rejected', () => {
  assert.throws(check(pin({ ref: 'plugin-runtime-v1.2.4' }), { activated: true, allowLag: true }), /never lead it/);
});

function tagRepo(t, tags) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-catalog-names-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'root');
  for (const tag of tags) git('tag', tag);
  return dir;
}

test('expected Codex names: before activation, every published name', (t) => {
  const dir = tagRepo(t, []);
  assert.deepEqual(expectedCodexCatalogNames(dir, ['gamma', 'alpha'], { activated: false }), ['alpha', 'gamma']);
});

test('expected Codex names: after activation, only released packages — the exemption and where it ends', (t) => {
  const dir = tagRepo(t, ['plugin-alpha-v1.0.0', 'plugin-beta-v0.1.0-rc.1', 'plugin-gamma-extra-v1.0.0']);
  // gamma is unreleased — a release of another package named gamma-extra
  // must not stand in for one — and beta's pre-release counts.
  assert.deepEqual(expectedCodexCatalogNames(dir, ['alpha', 'beta', 'gamma'], { activated: true }), ['alpha', 'beta']);
});

// A checkout without the tags must not read as "nothing is released": that
// turned the activated catalog's eight names into an expected [] on the
// shallow claude-tests / codex-tests checkouts. Each case keeps the other
// precondition satisfied, so each rejection is attributable to its own check.
test('expected Codex names: after activation, a repository with no release tags fails and says so', (t) => {
  const dir = tagRepo(t, []);
  assert.throws(() => expectedCodexCatalogNames(dir, ['alpha'], { activated: true }), /no plugin-\*-v\* tag is present/);
  // Before activation the tags are never read, so the same repository passes.
  assert.deepEqual(expectedCodexCatalogNames(dir, ['alpha'], { activated: false }), ['alpha']);
});

test('expected Codex names: after activation, a shallow clone fails and says so, even with its tags', (t) => {
  const origin = tagRepo(t, []);
  execFileSync('git', ['-C', origin, '-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false',
    'commit', '-q', '--allow-empty', '-m', 'tip']);
  execFileSync('git', ['-C', origin, 'tag', 'plugin-alpha-v1.0.0']);
  const clone = mkdtempSync(join(tmpdir(), 'codex-catalog-shallow-'));
  t.after(() => rmSync(clone, { recursive: true, force: true }));
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${origin}`, clone]);
  const inClone = (...args) => execFileSync('git', ['-C', clone, ...args], { encoding: 'utf8' }).trim();
  assert.equal(inClone('rev-parse', '--is-shallow-repository'), 'true', 'the fixture is shallow');
  assert.equal(inClone('tag', '--list', 'plugin-*-v*'), 'plugin-alpha-v1.0.0', 'the fixture carries its tag');
  assert.throws(() => expectedCodexCatalogNames(clone, ['alpha'], { activated: true }), /shallow clone/);
  // The full-history origin, with the same tag, is answered.
  assert.deepEqual(expectedCodexCatalogNames(origin, ['alpha'], { activated: true }), ['alpha']);
});
