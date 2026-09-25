// Gate for tests/plugin-shape/codex-catalog-source.mjs.
//
// The five plugin-shape files run that helper against the real catalog, which
// stays pre-activation until ADR-0061 §Implementation manifest S5. Its
// activated branch would therefore run for the first time on the activation
// commit itself — the worst moment to learn it is wrong. These cases drive
// both branches with synthetic entries now, each rejection paired with a
// passing control on the same branch.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { assertCodexCatalogSource, codexCatalogActivated } from './codex-catalog-source.mjs';

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

test('pre-activation: a local path that does not resolve is rejected', () => {
  assert.throws(check(local('./plugins/nowhere'), { activated: false }));
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
