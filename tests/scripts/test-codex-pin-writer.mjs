// Gate tests for the ADR-0061 Codex catalog writer —
// scripts/sync-marketplace-versions.mjs (§Implementation manifest S4).
//
// What must hold, by phase:
//   - Before activation the Codex catalog and the floor data file are left
//     byte-for-byte as they are by every run that does not carry the owner's
//     --activate intent. That is what "merging writes no pins" rests on: an
//     ordinary release, or a repair dispatch, runs exactly this.
//   - --activate is all-or-nothing. It pins every entry to the commit its tag
//     peels to and sets the marker in the same write, or it refuses and
//     writes NOTHING — the Claude catalog included.
//   - After activation pins follow the manifest forward only, a package's
//     first tag gives it its first entry, and nothing ever returns to local.
//   - The documented recovery paths (docs/runbooks/codex-pin-activation.md)
//     converge: re-running from any published state is a no-op or a forward
//     advance.
//
// Fixtures are the git-backed repositories of ./fixtures/codex-pins-repo.mjs,
// which carry the validators too, so every successful write here is also
// checked against the S4V gates with the pre-write commit as the baseline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { planCodexPins, syncCatalogs } from '../../scripts/sync-marketplace-versions.mjs';
import { validateMarketplace } from '../../scripts/validate-marketplace.mjs';
import { validateVersions } from '../../scripts/validate-versions.mjs';

import {
  CLAUDE, CODEX, FLOORS,
  activate, addPackage, commit, git, makeRepo, peeled, readJSON, release, runCli, setCodexSource,
  setFloor, setFloors, setVersion, tag, writeJSON,
} from './fixtures/codex-pins-repo.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const text = (dir, rel) => readFileSync(path.join(dir, rel), 'utf8');
const snapshot = (dir) => Object.fromEntries([CLAUDE, CODEX, FLOORS].map((rel) => [rel, text(dir, rel)]));
const head = (dir) => git(dir, ['rev-parse', 'HEAD']).trim();

function assertValid(dir) {
  const market = validateMarketplace(dir, { base: 'HEAD' });
  assert.deepEqual(market.errors, [], 'the written catalogs pass validate-marketplace against the pre-write commit');
  assert.deepEqual(validateVersions(dir).errors, [], 'and validate-versions');
  return market;
}

function assertRefused(r, pattern) {
  assert.equal(r.written, false, 'a refused plan writes nothing');
  assert.ok(r.errors.some((e) => pattern.test(e)), `expected a refusal matching ${pattern}, got:\n  ${r.errors.join('\n  ') || '(none)'}`);
}

/** Activate the fixture through the writer itself, and publish (commit) the result. */
function activateAndPublish(dir) {
  const r = syncCatalogs(dir, { activate: true });
  assert.deepEqual(r.errors, []);
  return commit(dir, 'chore(marketplace): sync catalog versions to release-please-manifest and activate the Codex catalog pins');
}

// ---------------------------------------------------------------------------
// Before activation — nothing touches the Codex catalog without --activate
// ---------------------------------------------------------------------------

test('an ordinary release before activation syncs Claude and leaves the Codex catalog and marker byte-identical', (t) => {
  const dir = makeRepo(t);
  release(dir, 'alpha', '1.1.0');
  // The release commit bumps the manifests; the Claude catalog lags until the sync.
  const claude = readJSON(dir, CLAUDE);
  claude.plugins.find((p) => p.name === 'alpha').version = '1.0.0';
  writeJSON(dir, CLAUDE, claude);
  commit(dir, 'chore: release main');
  const before = snapshot(dir);

  const r = syncCatalogs(dir);
  assert.deepEqual(r.errors, []);
  assert.equal(r.written, true);
  assert.deepEqual(r.claude.diffs, [{ name: 'alpha', from: '1.0.0', to: '1.1.0' }]);
  assert.deepEqual(r.codex.diffs, []);
  assert.equal(text(dir, CODEX), before[CODEX], 'Codex catalog untouched');
  assert.equal(text(dir, FLOORS), before[FLOORS], 'floor data untouched');
  assert.notEqual(text(dir, CLAUDE), before[CLAUDE], 'the Claude catalog did sync — the run was not a no-op');
  assertValid(dir);
});

test('a repair run before activation with nothing to sync writes nothing', (t) => {
  const dir = makeRepo(t);
  const before = snapshot(dir);
  const r = syncCatalogs(dir);
  assert.equal(r.written, false);
  assert.deepEqual(snapshot(dir), before);
  assert.ok(r.codex.notes.some((n) => /pre-activation: the Codex catalog is left as it is/.test(n)));
});

// ---------------------------------------------------------------------------
// Activation — explicit, all or nothing
// ---------------------------------------------------------------------------

test('--activate pins every entry to the commit its tag peels to and sets the marker in the same write', (t) => {
  const dir = makeRepo(t);
  const base = head(dir);
  const r = syncCatalogs(dir, { activate: true });
  assert.deepEqual(r.errors, []);
  assert.equal(r.written, true);
  assert.equal(r.codex.activating, true);
  const codex = readJSON(dir, CODEX);
  for (const name of ['alpha', 'beta']) {
    assert.deepEqual(codex.plugins.find((p) => p.name === name).source, {
      source: 'git-subdir', url: './', path: `plugins/${name}`,
      ref: `plugin-${name}-v1.0.0`, sha: peeled(dir, `plugin-${name}-v1.0.0`),
    });
  }
  // beta's tag is annotated: its object id is NOT what may be pinned.
  assert.notEqual(git(dir, ['rev-parse', 'refs/tags/plugin-beta-v1.0.0']).trim(), peeled(dir, 'plugin-beta-v1.0.0'));
  assert.equal(readJSON(dir, FLOORS).activated, true);
  // policy and category survive activation untouched.
  assert.deepEqual(codex.plugins.find((p) => p.name === 'alpha').policy, { installation: 'AVAILABLE', authentication: 'ON_USE' });
  const market = assertValid(dir);
  assert.equal(market.phase, 'activated');
  assert.equal(market.coverage.baseline, base);
});

test('--activate --check reports the plan and writes nothing', (t) => {
  const dir = makeRepo(t);
  const before = snapshot(dir);
  const r = syncCatalogs(dir, { activate: true, checkOnly: true });
  assert.deepEqual(r.errors, []);
  assert.equal(r.written, false);
  assert.deepEqual(r.codex.diffs.map((d) => `${d.name}:${d.from}->${d.to}`), ['alpha:local->plugin-alpha-v1.0.0', 'beta:local->plugin-beta-v1.0.0']);
  assert.deepEqual(snapshot(dir), before);
});

for (const [label, arrange, pattern] of [
  ['a package below its floor', (dir) => {
    commit(dir, 'chore: nothing');
    tag(dir, 'plugin-alpha-v1.1.0');
    setFloor(dir, 'alpha', '1.1.0');
  }, /alpha@1\.0\.0 is below its migration floor 1\.1\.0/],
  ['a package with no floor', (dir) => setFloor(dir, 'beta', null), /beta has no migration floor/],
  ['a package not released at its manifest version', (dir) => setVersion(dir, 'alpha', '1.1.0'), /alpha is at 1\.1\.0 but plugin-alpha-v1\.1\.0 does not resolve/],
  ['a tag whose tree carries another version', (dir) => {
    commit(dir, 'chore: nothing bumped');
    tag(dir, 'plugin-alpha-v1.1.0');
    setVersion(dir, 'alpha', '1.1.0');
  }, /alpha@1\.1\.0: the tree at [0-9a-f]{7} has plugins\/alpha\/\.codex-plugin\/plugin\.json at version "1\.0\.0", not 1\.1\.0/],
]) {
  test(`--activate refuses with ${label}, and writes nothing — not even the Claude catalog`, (t) => {
    const dir = makeRepo(t);
    arrange(dir);
    // Give the Claude side real drift, so "nothing written" is not vacuous.
    const claude = readJSON(dir, CLAUDE);
    claude.plugins.find((p) => p.name === 'beta').version = '0.9.0';
    writeJSON(dir, CLAUDE, claude);
    const before = snapshot(dir);
    const r = syncCatalogs(dir, { activate: true });
    assert.ok(r.claude.diffs.length > 0, 'the Claude catalog had drift to sync');
    assertRefused(r, pattern);
    assert.deepEqual(snapshot(dir), before);
  });
}

test('activation is idempotent: a second run, with or without --activate, changes nothing', (t) => {
  const dir = makeRepo(t);
  activateAndPublish(dir);
  const before = snapshot(dir);
  for (const activate of [true, false]) {
    const r = syncCatalogs(dir, { activate });
    assert.deepEqual(r.errors, []);
    assert.equal(r.written, false);
    assert.deepEqual(snapshot(dir), before);
  }
  assert.ok(syncCatalogs(dir, { activate: true }).codex.notes.some((n) => /already activated/.test(n)));
});

// ---------------------------------------------------------------------------
// After activation — forward only
// ---------------------------------------------------------------------------

test('after activation a release advances only that package\'s pin, without --activate', (t) => {
  const dir = makeRepo(t);
  activateAndPublish(dir);
  release(dir, 'alpha', '1.1.0', { annotated: true });
  const r = syncCatalogs(dir);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.codex.diffs, [{ name: 'alpha', from: 'plugin-alpha-v1.0.0', to: 'plugin-alpha-v1.1.0' }]);
  const codex = readJSON(dir, CODEX);
  assert.equal(codex.plugins.find((p) => p.name === 'alpha').source.sha, peeled(dir, 'plugin-alpha-v1.1.0'));
  assert.equal(codex.plugins.find((p) => p.name === 'beta').source.ref, 'plugin-beta-v1.0.0');
  assert.equal(readJSON(dir, FLOORS).activated, true);
  assertValid(dir);
});

test('after activation the writer never moves a pin down', (t) => {
  const dir = makeRepo(t);
  release(dir, 'alpha', '1.1.0');
  activateAndPublish(dir);
  setVersion(dir, 'alpha', '1.0.0');
  const before = snapshot(dir);
  assertRefused(syncCatalogs(dir), /alpha: the manifest \(1\.0\.0\) is below the pin \(1\.1\.0\)/);
  assert.deepEqual(snapshot(dir), before);
});

test('after activation a released tag that moved is refused, not re-pinned', (t) => {
  const dir = makeRepo(t);
  activateAndPublish(dir);
  const moved = commit(dir, 'docs: an unreleased edit');
  tag(dir, 'plugin-alpha-v1.0.0', { at: moved, force: true });
  assertRefused(syncCatalogs(dir), /alpha: plugin-alpha-v1\.0\.0 now peels to [0-9a-f]{7}, not the pinned [0-9a-f]{7}/);
});

test('after activation a local entry is refused — the writer never takes part in a revert', (t) => {
  const dir = makeRepo(t);
  activateAndPublish(dir);
  setCodexSource(dir, 'alpha', { source: 'local', path: './plugins/alpha' });
  assertRefused(syncCatalogs(dir), /alpha: the Codex entry is "local" after activation — a pin never goes back to local; re-run with --activate/);
});

test('recovery — with --activate, a hand-reverted local entry is pinned forward to its current release', (t) => {
  const dir = makeRepo(t);
  activateAndPublish(dir);
  release(dir, 'alpha', '1.1.0');
  setCodexSource(dir, 'alpha', { source: 'local', path: './plugins/alpha' });
  commit(dir, 'chore: a hand-made revert');
  const r = syncCatalogs(dir, { activate: true });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.codex.diffs, [{ name: 'alpha', from: 'local', to: 'plugin-alpha-v1.1.0' }]);
  assert.equal(readJSON(dir, FLOORS).activated, true, 'the marker was never cleared');
  assertValid(dir);
});

test('after activation a floor above the released version is an error', (t) => {
  const dir = makeRepo(t);
  activateAndPublish(dir);
  setFloor(dir, 'beta', '2.0.0');
  assertRefused(syncCatalogs(dir), /beta@1\.0\.0 is below its migration floor 2\.0\.0/);
});

// ---------------------------------------------------------------------------
// First publication of a new package: absent -> first tag -> first pin
// ---------------------------------------------------------------------------

test('a new package gets no Codex entry until its first tag, then its first pin', (t) => {
  const dir = makeRepo(t);
  activateAndPublish(dir);
  addPackage(dir, 'gamma');
  commit(dir, 'feat: add gamma');

  const untagged = syncCatalogs(dir);
  assert.deepEqual(untagged.errors, []);
  assert.deepEqual(untagged.codex.diffs, []);
  assert.ok(untagged.codex.notes.some((n) => /gamma: no release tag yet/.test(n)));
  assert.equal(readJSON(dir, CODEX).plugins.some((p) => p.name === 'gamma'), false);

  tag(dir, 'plugin-gamma-v0.1.0');
  const r = syncCatalogs(dir);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.codex.diffs, [{ name: 'gamma', from: 'absent', to: 'plugin-gamma-v0.1.0' }]);
  const codex = readJSON(dir, CODEX);
  assert.deepEqual(codex.plugins.map((p) => p.name), ['alpha', 'beta', 'gamma'], 'inserted in name order');
  assert.deepEqual(codex.plugins.find((p) => p.name === 'gamma'), {
    name: 'gamma',
    source: { source: 'git-subdir', url: './', path: 'plugins/gamma', ref: 'plugin-gamma-v0.1.0', sha: peeled(dir, 'plugin-gamma-v0.1.0') },
    policy: { installation: 'AVAILABLE', authentication: 'ON_USE' },
    category: 'Productivity',
  });
  assertValid(dir);
});

test('a first pin is inserted in name order, not appended', (t) => {
  const dir = makeRepo(t);
  activateAndPublish(dir);
  addPackage(dir, 'ant');
  commit(dir, 'feat: add ant');
  tag(dir, 'plugin-ant-v0.1.0');
  syncCatalogs(dir);
  assert.deepEqual(readJSON(dir, CODEX).plugins.map((p) => p.name), ['alpha', 'ant', 'beta']);
});

test('a first pin takes its category from the RELEASED manifest, not the working tree', (t) => {
  const dir = makeRepo(t);
  activateAndPublish(dir);
  addPackage(dir, 'gamma');
  writeJSON(dir, 'plugins/gamma/.codex-plugin/plugin.json', { name: 'gamma', version: '0.1.0', interface: { category: 'Development' } });
  commit(dir, 'feat: add gamma');
  tag(dir, 'plugin-gamma-v0.1.0');
  writeJSON(dir, 'plugins/gamma/.codex-plugin/plugin.json', { name: 'gamma', version: '0.1.0', interface: { category: 'Productivity' } });
  syncCatalogs(dir);
  assert.equal(readJSON(dir, CODEX).plugins.find((p) => p.name === 'gamma').category, 'Development');
});

test('a first pin whose released manifest declares no category is refused', (t) => {
  const dir = makeRepo(t);
  activateAndPublish(dir);
  addPackage(dir, 'gamma');
  writeJSON(dir, 'plugins/gamma/.codex-plugin/plugin.json', { name: 'gamma', version: '0.1.0' });
  commit(dir, 'feat: add gamma');
  tag(dir, 'plugin-gamma-v0.1.0');
  assertRefused(syncCatalogs(dir), /gamma: its released \.codex-plugin\/plugin\.json declares no interface\.category/);
});

// ---------------------------------------------------------------------------
// Recovery from a partial activation (docs/runbooks/codex-pin-activation.md)
// ---------------------------------------------------------------------------

test('recovery — a catalog pinned without its marker is completed by --activate, and flagged without it', (t) => {
  // The shape a hand-staged or truncated activation commit would leave.
  const dir = makeRepo(t);
  activate(dir);
  setFloors(dir, { activated: false });
  commit(dir, 'chore: a half-published activation');
  assert.ok(validateMarketplace(dir).errors.some((e) => /pinned before activation/.test(e)), 'the gates see the half state');

  const plain = syncCatalogs(dir);
  assert.equal(plain.written, false, 'without the intent the writer does not complete an activation');

  const r = syncCatalogs(dir, { activate: true });
  assert.deepEqual(r.errors, []);
  assert.equal(readJSON(dir, FLOORS).activated, true);
  assertValid(dir);
});

test('recovery — the marker without pins is refused without the input, and pinned forward with it', (t) => {
  const dir = makeRepo(t);
  setFloors(dir, { activated: true });
  commit(dir, 'chore: a hand-set marker');
  assert.ok(validateMarketplace(dir).errors.some((e) => /says activated, but no entry is pinned/.test(e)));
  assertRefused(syncCatalogs(dir), /alpha: the Codex entry is "local" after activation/);
  const r = syncCatalogs(dir, { activate: true });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.codex.diffs.map((d) => `${d.name}:${d.from}`), ['alpha:local', 'beta:local']);
  assert.equal(readJSON(dir, FLOORS).activated, true);
  assertValid(dir);
});

test('recovery — a fresh dispatch after a published activation converges on the current baseline', (t) => {
  // A later step failed after the catalog push: the activation is published.
  // Main then moved (a release). A fresh dispatch — the owner may well pass
  // the activate input again — advances pins and never reverts.
  const dir = makeRepo(t);
  activateAndPublish(dir);
  release(dir, 'beta', '1.1.0');
  const r = syncCatalogs(dir, { activate: true });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.codex.diffs, [{ name: 'beta', from: 'plugin-beta-v1.0.0', to: 'plugin-beta-v1.1.0' }]);
  assert.equal(r.codex.activating, false);
  assertValid(dir);
});

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const WRITER = 'scripts/sync-marketplace-versions.mjs';

test('CLI --activate writes, validates against HEAD, and says so', (t) => {
  const dir = makeRepo(t);
  const out = runCli(dir, WRITER, ['--activate']);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /\.agents\/plugins\/marketplace\.json alpha: local → plugin-alpha-v1\.0\.0/);
  assert.match(out.stdout, /scripts\/data\/codex-pin-floors\.json: activated false → true/);
  assert.match(out.stdout, new RegExp(`validated: phase activated, baseline ${head(dir).slice(0, 7)}`));
});

test('CLI exits 1 without pushing-grade output when the written catalogs fail validation', (t) => {
  const dir = makeRepo(t);
  // A defect the writer does not own — a Claude entry pointing at the wrong
  // package — with real Claude drift, so the writer does write.
  const claude = readJSON(dir, CLAUDE);
  const alpha = claude.plugins.find((p) => p.name === 'alpha');
  alpha.source = './plugins/beta';
  alpha.version = '0.9.0';
  writeJSON(dir, CLAUDE, claude);
  const out = runCli(dir, WRITER);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /the written catalogs FAILED validation — do not push them/);
  assert.match(out.stderr, /source "\.\/plugins\/beta" is not the package directory plugins\/alpha/);
});

test('CLI exits 1 on a refused plan and says nothing was written', (t) => {
  const dir = makeRepo(t);
  setFloor(dir, 'beta', null);
  const out = runCli(dir, WRITER, ['--activate']);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /refused — nothing was written/);
  assert.match(out.stderr, /beta has no migration floor/);
});

test('CLI --check exits 1 on drift and 0 when in sync', (t) => {
  const dir = makeRepo(t);
  assert.equal(runCli(dir, WRITER, ['--check']).status, 0);
  const drift = runCli(dir, WRITER, ['--activate', '--check']);
  assert.equal(drift.status, 1);
  assert.match(drift.stderr, /catalog drift detected/);
});

test('CLI rejects an unknown flag', (t) => {
  const dir = makeRepo(t);
  const out = runCli(dir, WRITER, ['--activated']);
  assert.equal(out.status, 2);
  assert.equal(out.stdout, '');
});

// ---------------------------------------------------------------------------
// The release job wiring — .github/workflows/release-please.yml
// ---------------------------------------------------------------------------

test('release-please.yml passes --activate only on a workflow_dispatch that asked for it, and stages the marker', () => {
  const wf = readFileSync(path.join(REPO_ROOT, '.github/workflows/release-please.yml'), 'utf8');
  assert.match(wf, /workflow_dispatch:\n\s+inputs:\n\s+activate_codex_pins:/, 'the owner-intent input exists');
  assert.match(wf, /\n\s+type: boolean\n\s+default: false\n/, 'and defaults to false');
  // The flag's only source is that input, on that event: every executable
  // line that names it expands the guarded variable, and nothing else sets it.
  assert.match(wf, /ACTIVATE_CODEX_PINS: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.activate_codex_pins && '1' \|\| '' \}\}/);
  const code = wf.split('\n').filter((l) => !/^\s*#/.test(l));
  const flagLines = code.filter((l) => l.includes('--activate'));
  assert.ok(flagLines.length > 0, 'the sync step can pass --activate');
  for (const l of flagLines) assert.ok(l.includes('${ACTIVATE_CODEX_PINS:+--activate}'), `--activate only behind the guarded variable: ${l.trim()}`);
  assert.equal(code.filter((l) => /ACTIVATE_CODEX_PINS:\s/.test(l)).length, 1, 'the variable is assigned in exactly one place');
  // Pins and marker are staged in the same commit, whose subject evidence-store recognizes.
  assert.match(wf, /CATALOGS="\.claude-plugin\/marketplace\.json \.agents\/plugins\/marketplace\.json scripts\/data\/codex-pin-floors\.json"/);
  assert.match(wf, /git add -- \$CATALOGS/);
  assert.match(wf, /SUBJECT="chore\(marketplace\): sync catalog versions to release-please-manifest"/);
});
