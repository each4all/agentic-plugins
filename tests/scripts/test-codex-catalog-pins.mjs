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
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateMarketplace } from '../../scripts/validate-marketplace.mjs';
import { validateVersions } from '../../scripts/validate-versions.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Copied into every fixture so the CLI cases run the real entry points with
// the fixture as the root they derive from `import.meta.url`.
const SCRIPTS = [
  'scripts/validate-marketplace.mjs',
  'scripts/validate-versions.mjs',
  'scripts/lib/codex-catalog-pins.mjs',
];

const CODEX = '.agents/plugins/marketplace.json';
const CLAUDE = '.claude-plugin/marketplace.json';
const FLOORS = 'scripts/data/codex-pin-floors.json';
const MANIFEST = '.release-please-manifest.json';

const git = (dir, args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });

function write(dir, rel, text) {
  mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  writeFileSync(path.join(dir, rel), text);
}
const writeJSON = (dir, rel, value) => write(dir, rel, `${JSON.stringify(value, null, 2)}\n`);
const readJSON = (dir, rel) => JSON.parse(readFileSync(path.join(dir, rel), 'utf8'));

function commit(dir, message) {
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-q', '--allow-empty', '-m', message]);
  return git(dir, ['rev-parse', 'HEAD']).trim();
}

const peeled = (dir, tag) => git(dir, ['rev-parse', `refs/tags/${tag}^{commit}`]).trim();
const tagObject = (dir, tag) => git(dir, ['rev-parse', `refs/tags/${tag}`]).trim();

function tag(dir, name, { annotated = false, at = 'HEAD', force = false } = {}) {
  const args = ['tag'];
  if (force) args.push('-f');
  if (annotated) args.push('-a', '-m', name);
  git(dir, [...args, name, at]);
}

/** Set a package's version everywhere release-please and the catalog sync would. */
function setVersion(dir, name, version) {
  writeJSON(dir, `plugins/${name}/.claude-plugin/plugin.json`, { name, version });
  writeJSON(dir, `plugins/${name}/.codex-plugin/plugin.json`, { name, version });
  const manifest = readJSON(dir, MANIFEST);
  manifest[`plugins/${name}`] = version;
  writeJSON(dir, MANIFEST, manifest);
  const claude = readJSON(dir, CLAUDE);
  const entry = claude.plugins.find((p) => p.name === name);
  if (entry) entry.version = version;
  writeJSON(dir, CLAUDE, claude);
}

const localSource = (name) => ({ source: 'local', path: `./plugins/${name}` });

function pinSource(dir, name, version, overrides = {}) {
  return {
    source: 'git-subdir',
    url: './',
    path: `plugins/${name}`,
    ref: `plugin-${name}-v${version}`,
    sha: peeled(dir, `plugin-${name}-v${version}`),
    ...overrides,
  };
}

function codexEntry(name, source) {
  return { name, source, policy: { installation: 'AVAILABLE', authentication: 'ON_USE' }, category: 'Productivity' };
}

function setCodexSource(dir, name, source) {
  const codex = readJSON(dir, CODEX);
  const entry = codex.plugins.find((p) => p.name === name);
  if (source === null) codex.plugins = codex.plugins.filter((p) => p.name !== name);
  else if (entry) entry.source = source;
  else codex.plugins.push(codexEntry(name, source));
  writeJSON(dir, CODEX, codex);
}

function setFloors(dir, patch) {
  writeJSON(dir, FLOORS, { ...readJSON(dir, FLOORS), ...patch });
}

function setFloor(dir, name, version) {
  const floors = readJSON(dir, FLOORS);
  if (version === null) delete floors.floors[name];
  else floors.floors[name] = version;
  writeJSON(dir, FLOORS, floors);
}

/**
 * Two packages at 1.0.0, released: `alpha` with a lightweight tag, `beta`
 * with an annotated one. The Codex catalog is all-local and not activated —
 * the pre-activation state this repository is in today.
 */
function makeRepo(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'codex-pins-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  git(dir, ['config', 'tag.gpgsign', 'false']);
  const top = { name: 'fx', description: 'fixture marketplace' };
  writeJSON(dir, MANIFEST, {});
  writeJSON(dir, CLAUDE, {
    ...top,
    plugins: ['alpha', 'beta'].map((name) => ({ name, source: `./plugins/${name}`, version: '1.0.0' })),
  });
  writeJSON(dir, CODEX, { ...top, plugins: ['alpha', 'beta'].map((name) => codexEntry(name, localSource(name))) });
  writeJSON(dir, FLOORS, {
    schema: 'codex-pin-floors-1.0',
    activated: false,
    floors: { alpha: '1.0.0', beta: '1.0.0' },
  });
  setVersion(dir, 'alpha', '1.0.0');
  setVersion(dir, 'beta', '1.0.0');
  for (const rel of SCRIPTS) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    cpSync(path.join(REPO_ROOT, rel), path.join(dir, rel));
  }
  commit(dir, 'chore: scaffold');
  tag(dir, 'plugin-alpha-v1.0.0');
  tag(dir, 'plugin-beta-v1.0.0', { annotated: true });
  return dir;
}

/** Activate: every entry pinned to its current release, marker set. */
function activate(dir, versions = { alpha: '1.0.0', beta: '1.0.0' }) {
  for (const [name, version] of Object.entries(versions)) setCodexSource(dir, name, pinSource(dir, name, version));
  setFloors(dir, { activated: true });
}

/** Cut a release of one package: bump, commit, tag. */
function release(dir, name, version, { annotated = false } = {}) {
  setVersion(dir, name, version);
  const sha = commit(dir, `chore: release ${name} ${version}`);
  tag(dir, `plugin-${name}-v${version}`, { annotated });
  return sha;
}

/** Add a third package the way a new plugin lands: both catalogs' Claude side, manifest, dirs. */
function addPackage(dir, name) {
  const claude = readJSON(dir, CLAUDE);
  claude.plugins.push({ name, source: `./plugins/${name}`, version: '0.1.0' });
  writeJSON(dir, CLAUDE, claude);
  setVersion(dir, name, '0.1.0');
}

function assertOk(r) {
  assert.deepEqual(r.errors, [], 'expected no errors');
}

function assertError(r, pattern) {
  assert.ok(
    r.errors.some((e) => pattern.test(e)),
    `expected an error matching ${pattern}, got:\n  ${r.errors.join('\n  ') || '(none)'}`,
  );
}

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

test('a pinned entry must name a release-please package', (t) => {
  const dir = makeRepo(t);
  activate(dir);
  const manifest = readJSON(dir, MANIFEST);
  delete manifest['plugins/alpha'];
  writeJSON(dir, MANIFEST, manifest);
  setFloor(dir, 'alpha', null);
  assertError(validateMarketplace(dir), /\(alpha\): pinned, but plugins\/alpha is not a release-please package/);
});

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

test('a sha absent from the repository is invalid', (t) => {
  const dir = makeRepo(t);
  activate(dir);
  setCodexSource(dir, 'alpha', pinSource(dir, 'alpha', '1.0.0', { sha: 'a'.repeat(40) }));
  assertError(validateMarketplace(dir), new RegExp(`${'a'.repeat(40)} is a missing object, not a commit`));
});

// ---------------------------------------------------------------------------
// Release-PR lag, and post-tag equality
// ---------------------------------------------------------------------------

function releasePrState(t) {
  // The release PR has advanced alpha's manifests to 1.1.0; the tag is not cut.
  const dir = makeRepo(t);
  activate(dir);
  setVersion(dir, 'alpha', '1.1.0');
  return dir;
}

test('a valid pin trailing the package version is drift outside the release-PR window', (t) => {
  const dir = releasePrState(t);
  assertError(validateMarketplace(dir), /\(alpha\): pinned version 1\.0\.0 != package version 1\.1\.0/);
});

test('CONTROL — the release-PR allowance lets a valid pin trail, as a warning', (t) => {
  const dir = releasePrState(t);
  const r = validateMarketplace(dir, { allowVersionLag: true });
  assertOk(r);
  assert.ok(r.warnings.some((w) => /\(alpha\): pinned version 1\.0\.0 != package version 1\.1\.0 \(allowed release-please PR lag\)/.test(w)));
});

test('the release-PR allowance never excuses a malformed pin', (t) => {
  const dir = releasePrState(t);
  setCodexSource(dir, 'alpha', pinSource(dir, 'alpha', '1.0.0', { sha: peeled(dir, 'plugin-alpha-v1.0.0').toUpperCase() }));
  assertError(validateMarketplace(dir, { allowVersionLag: true }), /source\.sha must be 40 lowercase hex/);
});

test('the release-PR allowance never excuses a mismatched pin', (t) => {
  const dir = releasePrState(t);
  setCodexSource(dir, 'beta', pinSource(dir, 'beta', '1.0.0', { sha: tagObject(dir, 'plugin-beta-v1.0.0') }));
  assertError(validateMarketplace(dir, { allowVersionLag: true }), /annotated tag object/);
});

test('a pin ahead of the package version is invalid even inside the release-PR window', (t) => {
  const dir = makeRepo(t);
  release(dir, 'alpha', '1.1.0');
  activate(dir, { alpha: '1.1.0', beta: '1.0.0' });
  setVersion(dir, 'alpha', '1.0.0');
  assertError(validateMarketplace(dir, { allowVersionLag: true }), /\(alpha\): pinned version 1\.1\.0 is ahead of package version 1\.0\.0/);
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
  const r = validateMarketplace(dir, { allowVersionLag: true });
  assertError(r, /\(alpha\): pinned version 1\.0\.0 is below its migration floor 1\.1\.0/);
});

test('a floor must name a plugins/* release-please package', (t) => {
  const dir = makeRepo(t);
  setFloor(dir, 'zeta', '1.0.0');
  assertError(validateMarketplace(dir), /floor for "zeta" names no plugins\/\* release-please package/);
});

test('a floor must be a released version of its package', (t) => {
  const dir = makeRepo(t);
  setFloor(dir, 'alpha', '1.5.0');
  assertError(validateMarketplace(dir), /floor alpha@1\.5\.0: tag plugin-alpha-v1\.5\.0 does not resolve/);
});

test('before activation every released package needs a floor', (t) => {
  const dir = makeRepo(t);
  setFloor(dir, 'alpha', null);
  assertError(validateMarketplace(dir), /alpha is released but has no migration floor/);
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

test('before activation there is no exemption: every package has a local entry', (t) => {
  const dir = makeRepo(t);
  addPackage(dir, 'gamma');
  assertError(validateMarketplace(dir), /plugins only in \.claude-plugin\/marketplace\.json: gamma/);
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
  const r = validateMarketplace(dir, { base, allowVersionLag: true });
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

test('a baseline that does not resolve fails closed', (t) => {
  const dir = makeRepo(t);
  const r = validateMarketplace(dir, { base: 'no-such-rev' });
  assertError(r, /baseline no-such-rev does not resolve to a commit/);
  assert.equal(r.coverage.baseline, null);
});

// ---------------------------------------------------------------------------
// No history — fails closed, never a structural-only pass
// ---------------------------------------------------------------------------

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

test('validate-versions reports a trailing pin as Codex catalog drift', (t) => {
  const dir = releasePrState(t);
  assertError(validateVersions(dir), /\.agents\/plugins\/marketplace\.json entry "alpha": pinned version "1\.0\.0" != release-please-manifest "1\.1\.0"/);
});

test('CONTROL — validate-versions allows a trailing pin in the release-PR window', (t) => {
  const dir = releasePrState(t);
  const r = validateVersions(dir, { allowMarketplaceLag: true });
  assertOk(r);
  assert.ok(r.warnings.some((w) => /entry "alpha": pinned version "1\.0\.0" != release-please-manifest "1\.1\.0" \(allowed release-please PR lag\)/.test(w)));
});

test('validate-versions rejects a pin ahead of the manifest even in the release-PR window', (t) => {
  const dir = makeRepo(t);
  release(dir, 'alpha', '1.1.0');
  activate(dir, { alpha: '1.1.0', beta: '1.0.0' });
  setVersion(dir, 'alpha', '1.0.0');
  assertError(validateVersions(dir, { allowMarketplaceLag: true }), /entry "alpha": pinned version "1\.1\.0" is ahead of release-please-manifest "1\.0\.0"/);
});

test('validate-versions never lets the release-PR window excuse a malformed pin', (t) => {
  const dir = releasePrState(t);
  setCodexSource(dir, 'alpha', pinSource(dir, 'alpha', '1.0.0', { ref: 'plugin-alpha-1.0.0' }));
  assertError(validateVersions(dir, { allowMarketplaceLag: true }), /entry "alpha": source\.ref must be plugin-alpha-v<X\.Y\.Z>/);
});

// ---------------------------------------------------------------------------
// CLI — the entry points run, including through a linked path
// ---------------------------------------------------------------------------

function runCli(root, script, args = []) {
  return spawnSync(process.execPath, [path.join(root, script), ...args], { cwd: root, encoding: 'utf8' });
}

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
