// Gate tests for ADR-0061 Decision 2 — the states the Codex catalog may be in,
// as scripts/validate-marketplace.mjs and scripts/validate-versions.mjs check
// them through scripts/lib/codex-catalog-pins.mjs.
//
// Every fixture is a real git repository with real tags, because half of
// Decision 2 is about history: a tag that resolves, a sha that is the tag's
// peeled commit, the tree at that sha. A history-less temp directory can only
// exercise the structural half, and the structural half passing is exactly
// what Decision 2 says must never be reported as full validation.
//
// Both tag kinds are present from the scaffold on: `alpha` is released with a
// lightweight tag and `beta` with an annotated one. An annotated tag is where
// a check that forgets to peel goes wrong — the tag OBJECT id is 40 lowercase
// hex too, so only the peel tells it apart from the commit Codex compares.
//
// Every failing case is paired with a CONTROL that takes the same branch and
// must pass, so a check that rejects everything cannot read as a working one.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { validateMarketplace } from '../../scripts/validate-marketplace.mjs';
import { validateVersions } from '../../scripts/validate-versions.mjs';

import { releaseLag } from '../../scripts/lib/codex-catalog-pins.mjs';

import {
  CLAUDE, CODEX, FLOORS, MANIFEST,
  activate, addPackage, assertError, assertOk, bump, commit, git, localSource, makeRepo, peeled, pinSource,
  readJSON, release, releaseCommit, runCli, setCodexSource, setConfigPackage, setFloor, setFloors, setVersion,
  tag, tagObject, write, writeJSON,
} from './fixtures/codex-pins-repo.mjs';

// ---------------------------------------------------------------------------
// Phase — Decision 2 "Validation states"
// ---------------------------------------------------------------------------

test('CONTROL — the pre-activation scaffold passes with history checked and no baseline', (t) => {
  const dir = makeRepo(t);
  const r = validateMarketplace(dir);
  assertOk(r);
  assert.equal(r.phase, 'pre-activation');
  assert.deepEqual(r.coverage, { structural: true, history: true, baseline: null });
});

test('CONTROL — an activated, fully pinned catalog passes (lightweight and annotated tags)', (t) => {
  const dir = makeRepo(t);
  activate(dir);
  const r = validateMarketplace(dir);
  assertOk(r);
  assert.equal(r.phase, 'activated');
  // The annotated tag's pin carries the PEELED commit, which differs from the
  // tag object — the case a missing peel gets wrong.
  assert.notEqual(tagObject(dir, 'plugin-beta-v1.0.0'), peeled(dir, 'plugin-beta-v1.0.0'));
  assert.equal(readJSON(dir, CODEX).plugins.find((p) => p.name === 'beta').source.sha, peeled(dir, 'plugin-beta-v1.0.0'));
});

test('a mix of local and pinned entries is invalid before activation', (t) => {
  const dir = makeRepo(t);
  setCodexSource(dir, 'alpha', pinSource(dir, 'alpha', '1.0.0'));
  const r = validateMarketplace(dir);
  assertError(r, /mixes local \(beta\) and pinned \(alpha\) entries/);
});

test('a mix of local and pinned entries is invalid after activation too', (t) => {
  const dir = makeRepo(t);
  activate(dir);
  setCodexSource(dir, 'beta', localSource('beta'));
  const r = validateMarketplace(dir);
  assertError(r, /mixes local \(beta\) and pinned \(alpha\) entries/);
});

test('pins without the activated marker are invalid', (t) => {
  const dir = makeRepo(t);
  activate(dir);
  setFloors(dir, { activated: false });
  const r = validateMarketplace(dir);
  assertError(r, /pinned before activation/);
});

test('the activated marker without pins is invalid', (t) => {
  const dir = makeRepo(t);
  setFloors(dir, { activated: true });
  const r = validateMarketplace(dir);
  assertError(r, /activated, but no entry is pinned/);
});

test('a source that is neither local nor git-subdir is invalid', (t) => {
  const dir = makeRepo(t);
  setCodexSource(dir, 'alpha', { source: 'url', url: 'https://example.com/x.git' });
  const r = validateMarketplace(dir);
  assertError(r, /\(alpha\): source\.source must be "local" or "git-subdir"/);
});

// ---------------------------------------------------------------------------
// Always, for a pinned entry — shape, grammar, identity
// ---------------------------------------------------------------------------

const SHAPE_CASES = [
  ['an uppercase sha', (dir) => ({ sha: peeled(dir, 'plugin-alpha-v1.0.0').toUpperCase() }), /source\.sha must be 40 lowercase hex/],
  ['an abbreviated sha', (dir) => ({ sha: peeled(dir, 'plugin-alpha-v1.0.0').slice(0, 12) }), /source\.sha must be 40 lowercase hex/],
  ['a ref naming another plugin', () => ({ ref: 'plugin-beta-v1.0.0' }), /source\.ref names plugin "beta", not "alpha"/],
  ['a ref without the v', () => ({ ref: 'plugin-alpha-1.0.0' }), /source\.ref must be plugin-alpha-v<X\.Y\.Z>/],
  ['a ref with a two-part version', () => ({ ref: 'plugin-alpha-v1.0' }), /source\.ref must be plugin-alpha-v<X\.Y\.Z>/],
  ['a network url', () => ({ url: 'https://github.com/each4all/agentic-plugins' }), /source\.url must be "\.\/"/],
  ['a ./-prefixed path', () => ({ path: './plugins/alpha' }), /source\.path must be "plugins\/alpha"/],
  ['another package\'s path', () => ({ path: 'plugins/beta' }), /source\.path must be "plugins\/alpha"/],
  ['an extra key', () => ({ version: '1.0.0' }), /source keys must be exactly/],
];

for (const [label, override, pattern] of SHAPE_CASES) {
  test(`a pinned entry with ${label} is invalid`, (t) => {
    const dir = makeRepo(t);
    activate(dir);
    setCodexSource(dir, 'alpha', pinSource(dir, 'alpha', '1.0.0', override(dir)));
    assertError(validateMarketplace(dir), pattern);
  });
}

test('a pinned entry must name a package whose Codex manifest carries that name', (t) => {
  const dir = makeRepo(t);
  activate(dir);
  writeJSON(dir, 'plugins/alpha/.codex-plugin/plugin.json', { name: 'alpha-renamed', version: '1.0.0' });
  assertError(validateMarketplace(dir), /\(alpha\): catalog name "alpha" != manifest name "alpha-renamed"/);
});

test('a pinned entry must name a package registered in release-please-config.json', (t) => {
  // The version ledger still lists alpha — only the registry dropped it.
  const dir = makeRepo(t);
  activate(dir);
  setConfigPackage(dir, 'alpha', null);
  setFloor(dir, 'alpha', null);
  assert.equal(readJSON(dir, MANIFEST)['plugins/alpha'], '1.0.0');
  assertError(validateMarketplace(dir), /\(alpha\): pinned, but plugins\/alpha is not a release-please package/);
});

test('a package must tag as plugin-<name>, the prefix a pin ref names', (t) => {
  const dir = makeRepo(t);
  setConfigPackage(dir, 'alpha', 'alpha-plugin');
  assertError(validateMarketplace(dir), /plugins\/alpha must tag as plugin-alpha \(its component\), got "alpha-plugin"/);
});

test('a Claude entry must point at its own package directory', (t) => {
  const dir = makeRepo(t);
  activate(dir);
  const claude = readJSON(dir, CLAUDE);
  claude.plugins.find((p) => p.name === 'alpha').source = './plugins/beta';
  writeJSON(dir, CLAUDE, claude);
  assertError(validateMarketplace(dir), /\.claude-plugin\/marketplace\.json\.plugins\[0\] \(alpha\): source "\.\/plugins\/beta" is not the package directory plugins\/alpha/);
});

test('a published package must declare interface.category, which its first Codex pin copies', (t) => {
  const dir = makeRepo(t);
  writeJSON(dir, 'plugins/beta/.codex-plugin/plugin.json', { name: 'beta', version: '1.0.0' });
  assertError(validateMarketplace(dir), /plugins\/beta\/\.codex-plugin\/plugin\.json: interface\.category must be a string/);
});

test('a local Codex entry must point at its own package directory', (t) => {
  const dir = makeRepo(t);
  setCodexSource(dir, 'alpha', { source: 'local', path: './plugins/beta' });
  assertError(validateMarketplace(dir), /\(alpha\): source\.path "\.\/plugins\/beta" is not the package directory plugins\/alpha/);
});

// Another spelling of the right directory resolves on the publisher's machine
// only. The plugin-shape helper that pinned the exact form is gone (ADR-0065
// Decision 8 rule 6), so the validator holds it.
for (const [label, source, pattern] of [
  ['an absolute path', (dir) => ({ source: 'local', path: path.join(dir, 'plugins', 'alpha') }), /\(alpha\): source\.path ".+" is not the package directory plugins\/alpha \(spelled \.\/plugins\/alpha\)/],
  ['a path without ./', () => ({ source: 'local', path: 'plugins/alpha' }), /\(alpha\): source\.path "plugins\/alpha" is not the package directory plugins\/alpha/],
  ['an extra key', () => ({ source: 'local', path: './plugins/alpha', ref: 'main' }), /\(alpha\): a local source is exactly \{path, source\}, got \{path, ref, source\}/],
]) {
  test(`a local Codex entry with ${label} is invalid, though it resolves to the package`, (t) => {
    const dir = makeRepo(t);
    assertOk(validateMarketplace(dir));
    setCodexSource(dir, 'alpha', source(dir));
    assertError(validateMarketplace(dir), pattern);
  });
}

// ---------------------------------------------------------------------------
// With history and tags
// ---------------------------------------------------------------------------

test('a ref that resolves to no tag is invalid', (t) => {
  const dir = makeRepo(t);
  activate(dir);
  setCodexSource(dir, 'alpha', pinSource(dir, 'alpha', '1.0.0', { ref: 'plugin-alpha-v1.5.0' }));
  assertError(validateMarketplace(dir), /tag plugin-alpha-v1\.5\.0 does not resolve/);
});

test('a sha that is not the commit its tag peels to is invalid', (t) => {
  const dir = makeRepo(t);
  const later = commit(dir, 'docs: an unreleased change');
  activate(dir);
  setCodexSource(dir, 'alpha', pinSource(dir, 'alpha', '1.0.0', { sha: later }));
  assertError(validateMarketplace(dir), /is not the commit plugin-alpha-v1\.0\.0 peels to/);
});

test('an annotated tag\'s object id in place of its commit is invalid, and says why', (t) => {
  const dir = makeRepo(t);
  activate(dir);
  setCodexSource(dir, 'beta', pinSource(dir, 'beta', '1.0.0', { sha: tagObject(dir, 'plugin-beta-v1.0.0') }));
  const r = validateMarketplace(dir);
  assertError(r, /is the annotated tag object of plugin-beta-v1\.0\.0, not its commit/);
});

test('a tag on a tree that carries a different package version is invalid', (t) => {
  const dir = makeRepo(t);
  // A mis-tag: plugin-alpha-v1.1.0 on a commit whose alpha is still 1.0.0.
  commit(dir, 'chore: nothing bumped');
  tag(dir, 'plugin-alpha-v1.1.0');
  setVersion(dir, 'alpha', '1.1.0');
  activate(dir, { alpha: '1.1.0', beta: '1.0.0' });
  assertError(validateMarketplace(dir), /the tree at [0-9a-f]{7} has plugins\/alpha\/\.codex-plugin\/plugin\.json at version "1\.0\.0", not 1\.1\.0/);
});

test('a tag on a tree without the package is invalid', (t) => {
  const dir = makeRepo(t);
  const emptyTree = execFileSync('git', ['-C', dir, 'mktree'], { input: '', encoding: 'utf8' }).trim();
  const bare = git(dir, ['commit-tree', emptyTree, '-m', 'chore: an empty tree']).trim();
  tag(dir, 'plugin-alpha-v1.2.0', { at: bare });
  setVersion(dir, 'alpha', '1.2.0');
  activate(dir, { alpha: '1.2.0', beta: '1.0.0' });
  assertError(validateMarketplace(dir), /the tree at [0-9a-f]{7} has no plugins\/alpha\/\.codex-plugin\/plugin\.json/);
});

test('a tag on a tree whose Codex manifest names another plugin is invalid', (t) => {
  // Only the RELEASED tree is wrong; the working tree is correct, so only the
  // history check can see it.
  const dir = makeRepo(t);
  writeJSON(dir, 'plugins/alpha/.codex-plugin/plugin.json', { name: 'alpha-renamed', version: '1.1.0' });
  commit(dir, 'chore: a mis-named release');
  tag(dir, 'plugin-alpha-v1.1.0');
  setVersion(dir, 'alpha', '1.1.0');
  activate(dir, { alpha: '1.1.0', beta: '1.0.0' });
  assert.equal(readJSON(dir, 'plugins/alpha/.codex-plugin/plugin.json').name, 'alpha');
  assertError(validateMarketplace(dir), /the tree at [0-9a-f]{7} has plugins\/alpha\/\.codex-plugin\/plugin\.json named "alpha-renamed", not "alpha"/);
});

test('a pre-release ref is rejected — the pin grammar is plain X.Y.Z, failing closed', (t) => {
  const dir = makeRepo(t);
  activate(dir);
  setCodexSource(dir, 'alpha', pinSource(dir, 'alpha', '1.0.0', { ref: 'plugin-alpha-v1.1.0-rc.1' }));
  assertError(validateMarketplace(dir), /source\.ref must be plugin-alpha-v<X\.Y\.Z>/);
});

test('a sha absent from the repository is invalid', (t) => {
  const dir = makeRepo(t);
  activate(dir);
  setCodexSource(dir, 'alpha', pinSource(dir, 'alpha', '1.0.0', { sha: 'a'.repeat(40) }));
  assertError(validateMarketplace(dir), new RegExp(`${'a'.repeat(40)} is a missing object, not a commit`));
});

// ---------------------------------------------------------------------------
// The release commit's lag, and post-tag equality — ADR-0065 Decision 8
// ---------------------------------------------------------------------------
//
// The allowance is keyed on content: only the commit that itself changes a
// package's .release-please-manifest.json version (from v0 to v1) may show that
// package's catalogs at v0. The CLIs always pass `allowReleaseLag`; the library
// default is strict, which is what the writer validates with.

const LAG = { allowReleaseLag: true };
const LAG_NOTE = /\(the release commit's own lag, ADR-0065 Decision 8\)$/;

function releasedAndActivated(t) {
  const dir = makeRepo(t);
  activate(dir);
  commit(dir, 'chore: activate');
  return dir;
}

function releasePrState(t) {
  // alpha's manifests advanced to 1.1.0 in the working tree only: HEAD is not
  // a release commit, so nothing excuses the catalogs.
  const dir = releasedAndActivated(t);
  setVersion(dir, 'alpha', '1.1.0');
  return dir;
}

test('a valid pin trailing the package version is drift outside a release commit', (t) => {
  const dir = releasePrState(t);
  assertError(validateMarketplace(dir, LAG), /\(alpha\): pinned version 1\.0\.0 != package version 1\.1\.0$/);
});

for (const tagged of [false, true]) {
  test(`CONTROL — in the commit that moves a package from v0 to v1, both catalogs may stand at v0 (tag ${tagged ? 'cut' : 'not cut yet'})`, (t) => {
    const dir = releasedAndActivated(t);
    releaseCommit(dir, { alpha: '1.1.0' }, { tagged });
    const r = validateMarketplace(dir, LAG);
    assertOk(r);
    assert.ok(r.warnings.some((w) => /\(alpha\): catalog version "1\.0\.0" != manifest version "1\.1\.0"/.test(w) && LAG_NOTE.test(w)), r.warnings.join('\n'));
    assert.ok(r.warnings.some((w) => /\(alpha\): pinned version 1\.0\.0 != package version 1\.1\.0/.test(w) && LAG_NOTE.test(w)), r.warnings.join('\n'));
    const v = validateVersions(dir, LAG);
    assertOk(v);
    assert.equal(v.warnings.filter((w) => LAG_NOTE.test(w)).length, 2, 'the Claude version and the Codex pin');
  });
}

test('the library default is strict: the same release commit fails without the allowance', (t) => {
  const dir = releasedAndActivated(t);
  releaseCommit(dir, { alpha: '1.1.0' }, { tagged: true });
  assertError(validateMarketplace(dir), /\(alpha\): catalog version "1\.0\.0" != manifest version "1\.1\.0"$/);
  assertError(validateMarketplace(dir), /\(alpha\): pinned version 1\.0\.0 != package version 1\.1\.0$/);
  assertError(validateVersions(dir), /entry "alpha": pinned version "1\.0\.0" != release-please-manifest "1\.1\.0"$/);
});

test('a commit after the release commit is strict: the lag is the release commit\'s alone', (t) => {
  // The commit that lands on main while the release job runs, or one pushed
  // onto the release-PR branch beyond release-please's own.
  const dir = releasedAndActivated(t);
  releaseCommit(dir, { alpha: '1.1.0' }, { tagged: true });
  write(dir, 'docs/note.md', 'unrelated\n');
  commit(dir, 'docs: an unrelated change');
  assertError(validateMarketplace(dir, LAG), /\(alpha\): catalog version "1\.0\.0" != manifest version "1\.1\.0"$/);
  assertError(validateMarketplace(dir, LAG), /\(alpha\): pinned version 1\.0\.0 != package version 1\.1\.0$/);
  assertError(validateVersions(dir, LAG), /\.claude-plugin\/marketplace\.json entry "alpha": version "1\.0\.0" != release-please-manifest "1\.1\.0"$/);
});

test('only the release commit\'s own packages are excused', (t) => {
  // beta trails too, but an earlier commit moved it, not this one.
  const dir = releasedAndActivated(t);
  bump(dir, 'beta', '1.1.0');
  commit(dir, 'chore: beta moved and was never synced');
  releaseCommit(dir, { alpha: '1.1.0' });
  const r = validateMarketplace(dir, LAG);
  assertError(r, /\(beta\): pinned version 1\.0\.0 != package version 1\.1\.0$/);
  assert.ok(r.warnings.some((w) => /\(alpha\): pinned version 1\.0\.0/.test(w)), 'alpha is excused in the same run');
});

test('only v0 is excused: a catalog at any other trailing version is drift, even in the release commit', (t) => {
  const dir = makeRepo(t);
  release(dir, 'alpha', '1.1.0');
  activate(dir, { alpha: '1.1.0', beta: '1.0.0' });
  commit(dir, 'chore: activate at alpha 1.1.0');
  // The release commit moves alpha 1.1.0 -> 1.2.0 with its catalogs at 1.0.0.
  const claude = readJSON(dir, CLAUDE);
  claude.plugins.find((p) => p.name === 'alpha').version = '1.0.0';
  writeJSON(dir, CLAUDE, claude);
  setCodexSource(dir, 'alpha', pinSource(dir, 'alpha', '1.0.0'));
  releaseCommit(dir, { alpha: '1.2.0' });
  assert.deepEqual([...releaseLag(dir).bumps], [['alpha', { from: '1.1.0', to: '1.2.0' }]]);
  const r = validateMarketplace(dir, LAG);
  assertError(r, /\(alpha\): catalog version "1\.0\.0" != manifest version "1\.2\.0"$/);
  assertError(r, /\(alpha\): pinned version 1\.0\.0 != package version 1\.2\.0$/);
  assertError(validateVersions(dir, LAG), /entry "alpha": pinned version "1\.0\.0" != release-please-manifest "1\.2\.0"$/);
});

test('the allowance holds only while the package stands where the commit moved it', (t) => {
  // HEAD moved alpha to 1.1.0; the working tree has since moved it on to
  // 1.2.0. The catalogs at 1.0.0 trail that, and nothing excuses it.
  const dir = releasedAndActivated(t);
  releaseCommit(dir, { alpha: '1.1.0' });
  bump(dir, 'alpha', '1.2.0');
  assertError(validateMarketplace(dir, LAG), /\(alpha\): catalog version "1\.0\.0" != manifest version "1\.2\.0"$/);
  assertError(validateVersions(dir, LAG), /entry "alpha": pinned version "1\.0\.0" != release-please-manifest "1\.2\.0"$/);
});

test('a release commit that moves a version backwards excuses nothing', (t) => {
  // The catalogs would then be ahead of the manifest.
  const dir = makeRepo(t);
  release(dir, 'alpha', '1.1.0');
  commit(dir, 'chore: nothing');
  releaseCommit(dir, { alpha: '1.0.0' });
  assertError(validateMarketplace(dir, LAG), /\(alpha\): catalog version "1\.1\.0" != manifest version "1\.0\.0"$/);
  assertError(validateVersions(dir, LAG), /\.claude-plugin\/marketplace\.json entry "alpha": version "1\.1\.0" != release-please-manifest "1\.0\.0"$/);
});

test('the release-commit allowance never excuses a malformed pin', (t) => {
  const dir = releasedAndActivated(t);
  setCodexSource(dir, 'alpha', pinSource(dir, 'alpha', '1.0.0', { sha: peeled(dir, 'plugin-alpha-v1.0.0').toUpperCase() }));
  releaseCommit(dir, { alpha: '1.1.0' });
  assertError(validateMarketplace(dir, LAG), /source\.sha must be 40 lowercase hex/);
});

test('the release-commit allowance never excuses a mismatched pin', (t) => {
  // alpha is the entry the allowance applies to (it trails 1.1.0), so the
  // mismatch goes on alpha: a check skipped for trailing pins would miss it.
  const dir = releasedAndActivated(t);
  const later = commit(dir, 'docs: an unreleased change');
  setCodexSource(dir, 'alpha', pinSource(dir, 'alpha', '1.0.0', { sha: later }));
  releaseCommit(dir, { alpha: '1.1.0' });
  const r = validateMarketplace(dir, LAG);
  assertError(r, /\(alpha\): sha [0-9a-f]{40} is not the commit plugin-alpha-v1\.0\.0 peels to/);
  assert.ok(r.warnings.some((w) => /\(alpha\): pinned version 1\.0\.0 != package version 1\.1\.0/.test(w)),
    'the allowance did apply to this entry');
});

test('a pin ahead of the package version is invalid even in its release commit', (t) => {
  const dir = makeRepo(t);
  release(dir, 'alpha', '1.1.0');
  activate(dir, { alpha: '1.1.0', beta: '1.0.0' });
  commit(dir, 'chore: activate at alpha 1.1.0');
  releaseCommit(dir, { alpha: '1.0.0' });
  assertError(validateMarketplace(dir, LAG), /\(alpha\): pinned version 1\.1\.0 is ahead of package version 1\.0\.0/);
});

test('a Claude catalog ahead of the manifest is invalid even in its release commit', (t) => {
  const dir = releasedAndActivated(t);
  const claude = readJSON(dir, CLAUDE);
  claude.plugins.find((p) => p.name === 'alpha').version = '1.2.0';
  writeJSON(dir, CLAUDE, claude);
  releaseCommit(dir, { alpha: '1.1.0' });
  assertError(validateMarketplace(dir, LAG), /\(alpha\): catalog version "1\.2\.0" != manifest version "1\.1\.0"$/);
  assertError(validateVersions(dir, LAG), /entry "alpha": version "1\.2\.0" != release-please-manifest "1\.1\.0"$/);
});

// ---------------------------------------------------------------------------
// releaseLag — what the commit under test changes
// ---------------------------------------------------------------------------

test('releaseLag reads the bumps of HEAD against its first parent, and nothing from the working tree', (t) => {
  const dir = makeRepo(t);
  assert.deepEqual([...releaseLag(dir).bumps], [], 'the scaffold is a root commit: no parent, no bumps');
  const c = releaseCommit(dir, { alpha: '1.1.0' });
  const lag = releaseLag(dir);
  assert.equal(lag.commit, c);
  assert.equal(lag.parent, git(dir, ['rev-parse', `${c}^1`]).trim());
  assert.deepEqual([...lag.bumps], [['alpha', { from: '1.0.0', to: '1.1.0' }]]);
  bump(dir, 'beta', '1.1.0');
  assert.deepEqual([...releaseLag(dir).bumps], [['alpha', { from: '1.0.0', to: '1.1.0' }]], 'an uncommitted bump is not the commit\'s');
});

test('releaseLag counts a package new to the manifest, from null', (t) => {
  const dir = makeRepo(t);
  addPackage(dir, 'gamma');
  commit(dir, 'feat: add gamma');
  assert.deepEqual([...releaseLag(dir).bumps], [['gamma', { from: null, to: '0.1.0' }]]);
});

test('releaseLag yields no bumps, the strict verdict, when a manifest cannot be read', (t) => {
  const dir = makeRepo(t);
  const manifest = readJSON(dir, MANIFEST);
  write(dir, MANIFEST, '{ not json\n');
  commit(dir, 'chore: break the manifest');
  writeJSON(dir, MANIFEST, { ...manifest, 'plugins/alpha': '1.1.0' });
  commit(dir, 'chore: release alpha over a broken parent');
  assert.deepEqual([...releaseLag(dir).bumps], [], 'the parent\'s manifest is unparsable');
  write(dir, MANIFEST, 'null\n');
  commit(dir, 'chore: a null manifest');
  assert.deepEqual([...releaseLag(dir).bumps], [], 'HEAD\'s manifest is not an object');
  rmSync(path.join(dir, MANIFEST));
  commit(dir, 'chore: no manifest');
  assert.deepEqual([...releaseLag(dir).bumps], [], 'HEAD has no manifest');
  writeJSON(dir, MANIFEST, manifest);
  commit(dir, 'chore: the manifest returns');
  // A parent without the file has no versions, so every package is new to
  // HEAD's: a bump from null, which excuses no trailing version (rule 1).
  assert.deepEqual([...releaseLag(dir).bumps], [['alpha', { from: null, to: '1.0.0' }], ['beta', { from: null, to: '1.0.0' }]]);
});

test('releaseLag judges a merge commit against its first parent', (t) => {
  const dir = makeRepo(t);
  git(dir, ['switch', '-q', '-c', 'topic']);
  releaseCommit(dir, { alpha: '1.1.0' });
  git(dir, ['switch', '-q', 'main']);
  write(dir, 'docs/note.md', 'main moves on\n');
  commit(dir, 'docs: main moves on');
  git(dir, ['merge', '-q', '--no-ff', '-m', 'merge topic', 'topic']);
  assert.deepEqual([...releaseLag(dir).bumps], [['alpha', { from: '1.0.0', to: '1.1.0' }]],
    'against the second parent (topic) nothing changed');
});

// ---------------------------------------------------------------------------
// Migration floors — Decision 5 (a)
// ---------------------------------------------------------------------------

test('after activation a pin below its floor is invalid', (t) => {
  const dir = makeRepo(t);
  release(dir, 'alpha', '1.1.0');
  setFloor(dir, 'alpha', '1.1.0');
  setVersion(dir, 'alpha', '1.1.0');
  activate(dir);
  const r = validateMarketplace(dir);
  assertError(r, /\(alpha\): pinned version 1\.0\.0 is below its migration floor 1\.1\.0/);
});

test('a floor must name a plugins/* release-please package', (t) => {
  const dir = makeRepo(t);
  setFloor(dir, 'zeta', '1.0.0');
  assertError(validateMarketplace(dir), /floor for "zeta" names no plugins\/\* release-please package/);
});

test('after activation a floor must be a released version of its package', (t) => {
  const dir = makeRepo(t);
  activate(dir);
  setFloor(dir, 'alpha', '1.5.0');
  assertError(validateMarketplace(dir), /floor alpha@1\.5\.0: tag plugin-alpha-v1\.5\.0 does not resolve — after activation every floor is a release/);
});

test('CONTROL — before activation a floor may be declared ahead of its release, as a warning', (t) => {
  const dir = makeRepo(t);
  setFloor(dir, 'alpha', '1.5.0');
  const r = validateMarketplace(dir);
  assertOk(r);
  assert.ok(r.warnings.some((w) => /floor alpha@1\.5\.0 is not a release yet \(no plugin-alpha-v1\.5\.0\); the writer refuses to activate until it is/.test(w)));
});

test('a released floor must carry its version in the released tree, in either phase', (t) => {
  const dir = makeRepo(t);
  commit(dir, 'chore: nothing bumped');
  tag(dir, 'plugin-alpha-v1.1.0');
  setFloor(dir, 'alpha', '1.1.0');
  assertError(validateMarketplace(dir), /floor alpha@1\.1\.0: the tree at [0-9a-f]{7} has plugins\/alpha\/\.codex-plugin\/plugin\.json at version "1\.0\.0", not 1\.1\.0/);
});

test('CONTROL — before activation a released package without a floor is a warning, not an error', (t) => {
  const dir = makeRepo(t);
  setFloor(dir, 'alpha', null);
  const r = validateMarketplace(dir);
  assertOk(r);
  assert.ok(r.warnings.some((w) => /alpha is released but has no migration floor; activation will need one/.test(w)));
});

test('CONTROL — an unreleased package needs no floor before activation', (t) => {
  const dir = makeRepo(t);
  addPackage(dir, 'gamma');
  setCodexSource(dir, 'gamma', localSource('gamma'));
  assertOk(validateMarketplace(dir));
});

for (const [label, patch, pattern] of [
  ['a non-boolean marker', { activated: 'yes' }, /activated must be a boolean/],
  ['a foreign schema', { schema: 'codex-pin-floors-2.0' }, /schema must be "codex-pin-floors-1\.0"/],
  ['an unknown key', { floor: {} }, /unknown key "floor"/],
  ['a non-X.Y.Z floor', { floors: { alpha: '1.0', beta: '1.0.0' } }, /floor for "alpha" must be X\.Y\.Z/],
]) {
  test(`a floor file with ${label} is invalid`, (t) => {
    const dir = makeRepo(t);
    setFloors(dir, patch);
    assertError(validateMarketplace(dir), pattern);
  });
}

test('a missing floor file is invalid rather than read as pre-activation', (t) => {
  const dir = makeRepo(t);
  rmSync(path.join(dir, FLOORS));
  assertError(validateMarketplace(dir), /scripts\/data\/codex-pin-floors\.json: /);
});

// ---------------------------------------------------------------------------
// A package with no release tag yet — the exemption, and where it ends
// ---------------------------------------------------------------------------

test('CONTROL — after activation an untagged package may lack a Codex entry', (t) => {
  const dir = makeRepo(t);
  activate(dir);
  addPackage(dir, 'gamma');
  const r = validateMarketplace(dir);
  assertOk(r);
  assert.ok(r.warnings.some((w) => /gamma has no Codex entry until its first release is pinned/.test(w)));
});

test('the exemption ends at the package\'s first release', (t) => {
  const dir = makeRepo(t);
  activate(dir);
  addPackage(dir, 'gamma');
  commit(dir, 'feat: add gamma');
  tag(dir, 'plugin-gamma-v0.1.0');
  assertError(validateMarketplace(dir), /plugins only in \.claude-plugin\/marketplace\.json: gamma/);
});

test('a pre-release tag ends the exemption too', (t) => {
  const dir = makeRepo(t);
  activate(dir);
  addPackage(dir, 'gamma');
  commit(dir, 'feat: add gamma');
  tag(dir, 'plugin-gamma-v0.1.0-rc.1');
  assertError(validateMarketplace(dir), /plugins only in \.claude-plugin\/marketplace\.json: gamma/);
});

test('before activation there is no exemption: every package has a local entry', (t) => {
  const dir = makeRepo(t);
  addPackage(dir, 'gamma');
  assertError(validateMarketplace(dir), /plugins only in \.claude-plugin\/marketplace\.json: gamma/);
});

// ADR-0065 Decision 8 rule 2: the release job cuts a first release's tag on the
// release commit itself, before its sync adds the first pin, so in that commit
// the package's release is read from the first parent.
function firstReleaseState(t, { tagged }) {
  const dir = makeRepo(t);
  activate(dir);
  addPackage(dir, 'gamma');
  commit(dir, 'feat: add gamma');
  releaseCommit(dir, { gamma: '0.2.0' }, { tagged });
  return dir;
}

for (const tagged of [false, true]) {
  test(`CONTROL — in the commit of its first release a package may lack its Codex entry (tag ${tagged ? 'cut' : 'not cut yet'})`, (t) => {
    const dir = firstReleaseState(t, { tagged });
    const r = validateMarketplace(dir, LAG);
    assertOk(r);
    const entry = tagged
      ? /gamma has no Codex entry in the commit its first release tags; the release job's sync adds its first pin/
      : /gamma has no Codex entry until its first release is pinned \(no plugin-gamma-v\* tag reachable from HEAD\)/;
    assert.ok(r.warnings.some((w) => entry.test(w)), r.warnings.join('\n'));
    assert.ok(r.warnings.some((w) => /\(gamma\): catalog version "0\.1\.0" != manifest version "0\.2\.0"/.test(w) && LAG_NOTE.test(w)),
      'its Claude version trails by rule 1');
    assertOk(validateVersions(dir, LAG));
  });
}

test('strictly, a first release whose tag is cut needs its Codex entry — the writer\'s verdict', (t) => {
  const dir = firstReleaseState(t, { tagged: true });
  assertError(validateMarketplace(dir), /plugins only in \.claude-plugin\/marketplace\.json: gamma/);
});

test('a commit after a first release\'s tagged commit needs the Codex entry', (t) => {
  const dir = firstReleaseState(t, { tagged: true });
  write(dir, 'docs/note.md', 'unrelated\n');
  commit(dir, 'docs: lands while the release job runs');
  assertError(validateMarketplace(dir, LAG), /plugins only in \.claude-plugin\/marketplace\.json: gamma/);
});

test('a package already released by the first parent needs its Codex entry, even in a commit that bumps it again', (t) => {
  const dir = firstReleaseState(t, { tagged: true });
  releaseCommit(dir, { gamma: '0.3.0' });
  assertError(validateMarketplace(dir, LAG), /plugins only in \.claude-plugin\/marketplace\.json: gamma/);
});

test('a first release that leaves the manifest unchanged is judged strictly', (t) => {
  const dir = makeRepo(t);
  activate(dir);
  addPackage(dir, 'gamma');
  commit(dir, 'feat: add gamma');
  commit(dir, 'chore: release gamma 0.1.0 as it stands');
  tag(dir, 'plugin-gamma-v0.1.0');
  assertError(validateMarketplace(dir, LAG), /plugins only in \.claude-plugin\/marketplace\.json: gamma/);
});

// ADR-0065 Decision 8 rule 3.
test('release history is read from the commit: a release cut later on another line leaves a branch commit\'s verdict alone', (t) => {
  const dir = makeRepo(t);
  activate(dir);
  addPackage(dir, 'gamma');
  commit(dir, 'feat: add gamma');
  git(dir, ['switch', '-q', '-c', 'topic']);
  write(dir, 'docs/note.md', 'branch work\n');
  commit(dir, 'docs: branch work');
  git(dir, ['switch', '-q', 'main']);
  releaseCommit(dir, { gamma: '0.2.0' }, { tagged: true });
  write(dir, 'docs/other.md', 'main moves on\n');
  commit(dir, 'docs: main moves on');
  assertError(validateMarketplace(dir, LAG), /plugins only in \.claude-plugin\/marketplace\.json: gamma/,
    'CONTROL: on main the release is reachable, and the entry is due');
  git(dir, ['switch', '-q', 'topic']);
  for (const opts of [{}, LAG]) {
    const r = validateMarketplace(dir, opts);
    assertOk(r);
    assert.ok(r.warnings.some((w) => /gamma has no Codex entry until its first release is pinned/.test(w)));
  }
});

// ---------------------------------------------------------------------------
// Monotonic pin against the target-branch baseline
// ---------------------------------------------------------------------------

test('a pin moving to a lower version than the baseline is invalid', (t) => {
  const dir = makeRepo(t);
  release(dir, 'alpha', '1.1.0');
  activate(dir, { alpha: '1.1.0', beta: '1.0.0' });
  const base = commit(dir, 'chore: activate');
  setCodexSource(dir, 'alpha', pinSource(dir, 'alpha', '1.0.0'));
  const r = validateMarketplace(dir, { base });
  assertError(r, /\(alpha\): pin moves from 1\.1\.0 to 1\.0\.0 — a pin never moves to a lower version/);
});

test('an unchanged version must keep its sha', (t) => {
  const dir = makeRepo(t);
  activate(dir);
  const base = commit(dir, 'chore: activate');
  // plugin-alpha-v1.0.0 force-moved onto a later commit that did not bump the
  // version. The new pin is internally consistent — only the baseline sees it.
  const moved = commit(dir, 'docs: unreleased edit');
  tag(dir, 'plugin-alpha-v1.0.0', { at: moved, force: true });
  setCodexSource(dir, 'alpha', pinSource(dir, 'alpha', '1.0.0'));
  const r = validateMarketplace(dir, { base });
  assertError(r, /\(alpha\): version 1\.0\.0 re-pinned from [0-9a-f]{7} to [0-9a-f]{7}/);
});

test('CONTROL — a local baseline imposes no bound (first activation)', (t) => {
  const dir = makeRepo(t);
  const base = git(dir, ['rev-parse', 'HEAD']).trim();
  activate(dir);
  const r = validateMarketplace(dir, { base });
  assertOk(r);
  assert.equal(r.coverage.baseline, base);
});

test('CONTROL — a pin advancing past the baseline passes', (t) => {
  const dir = makeRepo(t);
  activate(dir);
  const base = commit(dir, 'chore: activate');
  release(dir, 'alpha', '1.1.0');
  setCodexSource(dir, 'alpha', pinSource(dir, 'alpha', '1.1.0'));
  assertOk(validateMarketplace(dir, { base }));
});

test('activation is one-way: clearing the marker against an activated baseline is invalid', (t) => {
  const dir = makeRepo(t);
  activate(dir);
  const base = commit(dir, 'chore: activate');
  for (const name of ['alpha', 'beta']) setCodexSource(dir, name, localSource(name));
  setFloors(dir, { activated: false });
  const r = validateMarketplace(dir, { base });
  assertError(r, /activation is one-way/);
  assertError(r, /\(alpha\): reverted from a pin to local/);
});

test('the activating change cannot shed the floors it was gated on', (t) => {
  const dir = makeRepo(t);
  const base = git(dir, ['rev-parse', 'HEAD']).trim();
  activate(dir);
  setFloors(dir, { floors: {} });
  const r = validateMarketplace(dir, { base });
  assertError(r, /floor for alpha removed against the baseline [0-9a-f]{7} — a floor stays while its package exists/);
  assertError(r, /\(alpha\): the activating change pins alpha without a migration floor/);
});

test('a floor is never lowered against the baseline', (t) => {
  const dir = makeRepo(t);
  release(dir, 'alpha', '1.1.0');
  setFloor(dir, 'alpha', '1.1.0');
  const base = commit(dir, 'chore: raise the floor');
  setFloor(dir, 'alpha', '1.0.0');
  assertError(validateMarketplace(dir, { base }), /floor for alpha lowered from 1\.1\.0 to 1\.0\.0/);
});

test('the activating change pins no package that has no floor', (t) => {
  const dir = makeRepo(t);
  setFloor(dir, 'beta', null);
  const base = commit(dir, 'chore: beta has no floor yet');
  activate(dir);
  assertError(validateMarketplace(dir, { base }), /\(beta\): the activating change pins beta without a migration floor/);
});

test('CONTROL — after activation a new package is pinned without a floor', (t) => {
  const dir = makeRepo(t);
  activate(dir);
  const base = commit(dir, 'chore: activate');
  addPackage(dir, 'gamma');
  commit(dir, 'feat: add gamma');
  tag(dir, 'plugin-gamma-v0.1.0');
  setCodexSource(dir, 'gamma', pinSource(dir, 'gamma', '0.1.0'));
  assertOk(validateMarketplace(dir, { base }));
});

test('a published package\'s pin cannot be dropped, even where its tags are missing', (t) => {
  const dir = makeRepo(t);
  activate(dir);
  addPackage(dir, 'gamma');
  commit(dir, 'feat: add gamma');
  tag(dir, 'plugin-gamma-v0.1.0');
  setCodexSource(dir, 'gamma', pinSource(dir, 'gamma', '0.1.0'));
  const base = commit(dir, 'chore: pin gamma');
  // A checkout without gamma's tag would call gamma unreleased again.
  git(dir, ['tag', '-d', 'plugin-gamma-v0.1.0']);
  setCodexSource(dir, 'gamma', null);
  const r = validateMarketplace(dir, { base });
  assertError(r, /\(gamma\): pin dropped against the baseline [0-9a-f]{7} while the package is still published/);
});

test('CONTROL — before activation a PR that restores an all-local catalog passes against a mis-pinned baseline', (t) => {
  // main carries a pin without the marker — invalid, but reachable because
  // nothing validates a GITHUB_TOKEN push before it lands. The repair must not
  // be blocked.
  const dir = makeRepo(t);
  setCodexSource(dir, 'alpha', pinSource(dir, 'alpha', '1.0.0'));
  const base = commit(dir, 'chore: a bad bot push');
  setCodexSource(dir, 'alpha', localSource('alpha'));
  const r = validateMarketplace(dir, { base });
  assertOk(r);
  assert.equal(r.coverage.baseline, base);
});

test('an unreadable baseline is reported and not compared, so it cannot block its own repair', (t) => {
  const dir = makeRepo(t);
  write(dir, CODEX, '{ not json');
  const base = commit(dir, 'chore: a corrupt catalog');
  git(dir, ['checkout', '-q', 'HEAD~1', '--', CODEX]);
  const r = validateMarketplace(dir, { base });
  assertOk(r);
  assert.equal(r.coverage.baseline, null);
  assert.ok(r.warnings.some((w) => /baseline [0-9a-f]{7}: \.agents\/plugins\/marketplace\.json .* — the baseline was not compared/.test(w)));
});

test('a baseline whose floor file is JSON null does not crash the comparison', (t) => {
  const dir = makeRepo(t);
  write(dir, FLOORS, 'null\n');
  const base = commit(dir, 'chore: a null floor file');
  git(dir, ['checkout', '-q', 'HEAD~1', '--', FLOORS]);
  const r = validateMarketplace(dir, { base });
  assertOk(r);
  assert.ok(r.warnings.some((w) => /codex-pin-floors\.json is not a JSON object — the baseline was not compared/.test(w)));
});

test('a baseline that does not resolve fails closed', (t) => {
  const dir = makeRepo(t);
  const r = validateMarketplace(dir, { base: 'no-such-rev' });
  assertError(r, /baseline no-such-rev does not resolve to a commit/);
  assert.equal(r.coverage.baseline, null);
});

// ---------------------------------------------------------------------------
// No history — fails closed, never a structural-only pass
// ---------------------------------------------------------------------------

test('a catalog that is JSON null is an error, not a pass', (t) => {
  const dir = makeRepo(t);
  write(dir, CODEX, 'null\n');
  assertError(validateMarketplace(dir), /\.agents\/plugins\/marketplace\.json: must be a JSON object/);
});

test('a shallow clone fails closed', (t) => {
  const dir = makeRepo(t);
  const shallow = mkdtempSync(path.join(tmpdir(), 'codex-pins-shallow-'));
  t.after(() => rmSync(shallow, { recursive: true, force: true }));
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${dir}`, shallow]);
  const r = validateMarketplace(shallow);
  assertError(r, /history checks could not run: the repository is a shallow clone/);
  assert.equal(r.coverage.history, false);
});

test('a repository without release tags fails closed', (t) => {
  const dir = makeRepo(t);
  git(dir, ['tag', '-d', 'plugin-alpha-v1.0.0', 'plugin-beta-v1.0.0']);
  assertError(validateMarketplace(dir), /history checks could not run: no plugin-\*-v\* release tags are present/);
});

test('a directory that is not a git repository fails closed', (t) => {
  const dir = makeRepo(t);
  rmSync(path.join(dir, '.git'), { recursive: true, force: true });
  const r = validateMarketplace(dir);
  assertError(r, /history checks could not run: git history is not readable here/);
  assert.equal(r.coverage.history, false);
});

// ---------------------------------------------------------------------------
// validate-versions — post-tag equality, reported like Claude catalog drift
// ---------------------------------------------------------------------------

test('CONTROL — validate-versions passes a pre-activation catalog and says it checked no pins', (t) => {
  const dir = makeRepo(t);
  const r = validateVersions(dir);
  assertOk(r);
  assert.equal(r.codexPinsChecked, 0);
});

test('CONTROL — validate-versions passes pins equal to the manifest', (t) => {
  const dir = makeRepo(t);
  activate(dir);
  const r = validateVersions(dir);
  assertOk(r);
  assert.equal(r.codexPinsChecked, 2);
});

test('validate-versions reports a trailing pin as Codex catalog drift outside a release commit', (t) => {
  const dir = releasePrState(t);
  assertError(validateVersions(dir, LAG), /\.agents\/plugins\/marketplace\.json entry "alpha": pinned version "1\.0\.0" != release-please-manifest "1\.1\.0"$/);
});

test('validate-versions rejects a pin ahead of the manifest even in its release commit', (t) => {
  const dir = makeRepo(t);
  release(dir, 'alpha', '1.1.0');
  activate(dir, { alpha: '1.1.0', beta: '1.0.0' });
  commit(dir, 'chore: activate at alpha 1.1.0');
  releaseCommit(dir, { alpha: '1.0.0' });
  assertError(validateVersions(dir, LAG), /entry "alpha": pinned version "1\.1\.0" is ahead of release-please-manifest "1\.0\.0"/);
});

test('validate-versions reports malformed catalogs instead of crashing', (t) => {
  const dir = makeRepo(t);
  const codex = readJSON(dir, CODEX);
  codex.plugins.push(null);
  writeJSON(dir, CODEX, codex);
  assertOk(validateVersions(dir));
  write(dir, MANIFEST, 'null\n');
  assertError(validateVersions(dir), /\.release-please-manifest\.json: must be a JSON object/);
});

test('validate-versions never lets the release commit excuse a malformed pin', (t) => {
  const dir = releasedAndActivated(t);
  setCodexSource(dir, 'alpha', pinSource(dir, 'alpha', '1.0.0', { ref: 'plugin-alpha-1.0.0' }));
  releaseCommit(dir, { alpha: '1.1.0' });
  assertError(validateVersions(dir, LAG), /entry "alpha": source\.ref must be plugin-alpha-v<X\.Y\.Z>/);
});

// ---------------------------------------------------------------------------
// CLI — the entry points run, including through a linked path
// ---------------------------------------------------------------------------


test('validate-marketplace CLI passes, states its phase, and says the baseline was not compared', (t) => {
  const dir = makeRepo(t);
  const out = runCli(dir, 'scripts/validate-marketplace.mjs');
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /phase:\s+pre-activation/);
  assert.match(out.stdout, /checks:\s+structural, history; baseline not compared \(pass --base <rev>\)/);
});

test('validate-marketplace CLI compares a baseline when given one', (t) => {
  const dir = makeRepo(t);
  const base = git(dir, ['rev-parse', 'HEAD']).trim();
  const out = runCli(dir, 'scripts/validate-marketplace.mjs', ['--base', base]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, new RegExp(`checks:\\s+structural, history, baseline ${base.slice(0, 7)}`));
});

test('validate-marketplace CLI exits 1 and lists the errors', (t) => {
  const dir = makeRepo(t);
  setFloors(dir, { activated: true });
  const out = runCli(dir, 'scripts/validate-marketplace.mjs');
  assert.equal(out.status, 1);
  assert.match(out.stderr, /activated, but no entry is pinned/);
});

test('validate-marketplace CLI rejects an unknown flag instead of ignoring it', (t) => {
  const dir = makeRepo(t);
  const out = runCli(dir, 'scripts/validate-marketplace.mjs', ['--allow-versions-lag']);
  assert.notEqual(out.status, 0);
  assert.equal(out.stdout, '');
});

// The branch-keyed lag flags are gone (ADR-0065 Decision 8). A workflow still
// passing one fails loudly instead of being excused or ignored.
for (const [script, flag] of [
  ['scripts/validate-marketplace.mjs', '--allow-version-lag'],
  ['scripts/validate-versions.mjs', '--allow-marketplace-lag'],
]) {
  test(`${path.basename(script)} rejects the retired ${flag} as a usage error`, (t) => {
    const dir = makeRepo(t);
    const out = runCli(dir, script, [flag]);
    assert.equal(out.status, 2, out.stderr);
    assert.equal(out.stdout, '');
  });
}

test('both CLIs run when invoked through a symlinked root', (t) => {
  const dir = makeRepo(t);
  const link = path.join(mkdtempSync(path.join(tmpdir(), 'codex-pins-link-')), 'linked root');
  t.after(() => rmSync(path.dirname(link), { recursive: true, force: true }));
  symlinkSync(dir, link);
  // A path-equality entry guard does nothing here and exits 0 silently, so
  // the assertion is on the OUTPUT, not the status.
  const market = runCli(link, 'scripts/validate-marketplace.mjs');
  assert.equal(market.status, 0, market.stderr);
  assert.match(market.stdout, /^OK — /);
  const versions = runCli(link, 'scripts/validate-versions.mjs');
  assert.equal(versions.status, 0, versions.stderr);
  assert.match(versions.stdout, /^OK — /);
});

test('validate-versions CLI exits 1 on Codex pin drift', (t) => {
  const dir = releasePrState(t);
  const out = runCli(dir, 'scripts/validate-versions.mjs');
  assert.equal(out.status, 1);
  assert.match(out.stderr, /entry "alpha": pinned version "1\.0\.0" != release-please-manifest "1\.1\.0"/);
});
