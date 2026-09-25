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
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  ['a floor that is not itself a release', (dir) => {
    release(dir, 'alpha', '1.2.0');
    setFloor(dir, 'alpha', '1.1.0');
  }, /alpha's migration floor 1\.1\.0 is not a release \(plugin-alpha-v1\.1\.0 does not resolve\)/],
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

test('after activation a release that tagged only some packages blocks the whole sync until it is completed', (t) => {
  const dir = makeRepo(t);
  activateAndPublish(dir);
  setVersion(dir, 'alpha', '1.1.0');
  setVersion(dir, 'beta', '1.1.0');
  commit(dir, 'chore: release main');
  tag(dir, 'plugin-alpha-v1.1.0');
  const before = snapshot(dir);
  assertRefused(syncCatalogs(dir), /beta is at 1\.1\.0 but plugin-beta-v1\.1\.0 does not resolve/);
  assert.deepEqual(snapshot(dir), before, 'alpha is not advanced alone');
  tag(dir, 'plugin-beta-v1.1.0');
  const r = syncCatalogs(dir);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.codex.diffs.map((d) => d.name), ['alpha', 'beta']);
  assertValid(dir);
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

test('recovery — repairing the marker without pins still needs every floor', (t) => {
  const dir = makeRepo(t);
  setFloor(dir, 'beta', null);
  setFloors(dir, { activated: true });
  commit(dir, 'chore: a hand-set marker, beta without a floor');
  assertRefused(syncCatalogs(dir, { activate: true }), /beta has no migration floor .* — pinning a local entry needs one, as activation does/);
});

test('recovery — a hand-staged pin written wrong can only be corrected by a forward release', (t) => {
  // Pins without the marker, and beta pinned to its annotated tag's OBJECT id.
  const dir = makeRepo(t);
  activate(dir);
  setCodexSource(dir, 'beta', { ...readJSON(dir, CODEX).plugins.find((p) => p.name === 'beta').source, sha: git(dir, ['rev-parse', 'refs/tags/plugin-beta-v1.0.0']).trim() });
  setFloors(dir, { activated: false });
  commit(dir, 'chore: a hand-staged, mis-peeled activation');
  // Completing it re-derives beta's pin from its tag — a same-version sha
  // change, which the gates refuse (Decision 2) whoever makes it.
  const refused = runCli(dir, WRITER, ['--activate']);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /\(beta\): version 1\.0\.0 re-pinned from [0-9a-f]{7} to [0-9a-f]{7}/);
  git(dir, ['checkout', '-q', '--', '.']);
  // The forward path the runbook names: release beta, then complete.
  release(dir, 'beta', '1.1.0');
  const r = runCli(dir, WRITER, ['--activate']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readJSON(dir, CODEX).plugins.find((p) => p.name === 'beta').source.ref, 'plugin-beta-v1.1.0');
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

test('CLI validates even when there is nothing to write, so a repair run on a broken catalog is not green', (t) => {
  const dir = makeRepo(t);
  activate(dir);
  setFloors(dir, { activated: false });
  commit(dir, 'chore: pins committed without the marker');
  const out = runCli(dir, WRITER);
  assert.equal(out.status, 1);
  assert.match(out.stdout, /already in sync/);
  assert.match(out.stderr, /nothing to write, but the catalogs as they stand FAILED validation/);
  assert.match(out.stderr, /pinned before activation/);
  const check = runCli(dir, WRITER, ['--check']);
  assert.equal(check.status, 1, '--check with no drift validates too');
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
  assert.match(wf, /if \[ -n "\$\(git status --porcelain -- \$CATALOGS\)" \]; then/,
    'the commit gate looks at all three files — a Claude-only gate drops an activation that has no Claude drift');
  assert.match(wf, /git add -- \$CATALOGS/);
  assert.match(wf, /SUBJECT="chore\(marketplace\): sync catalog versions to release-please-manifest"/);
});

// ---------------------------------------------------------------------------
// Recovery through a real remote — the push, not just the plan
// ---------------------------------------------------------------------------

/** A bare "origin" seeded from a fresh fixture, and a way to take fresh checkouts of it. */
function remote(t) {
  const seed = makeRepo(t);
  const root = mkdtempSync(path.join(tmpdir(), 'codex-pins-remote-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin.git');
  execFileSync('git', ['clone', '-q', '--bare', seed, origin]);
  let n = 0;
  const checkout = () => {
    const dir = path.join(root, `job-${n += 1}`);
    execFileSync('git', ['clone', '-q', origin, dir]);
    for (const [k, v] of [['user.email', 'bot@example.com'], ['user.name', 'bot'], ['commit.gpgsign', 'false'], ['tag.gpgsign', 'false']]) {
      git(dir, ['config', k, v]);
    }
    return dir;
  };
  return { origin, checkout };
}

const push = (dir) => {
  try {
    execFileSync('git', ['-C', dir, 'push', '-q', '--tags', 'origin', 'HEAD:main'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
};

test('recovery through a remote — a rejected (non-fast-forward) activation push is re-dispatched from a fresh checkout', (t) => {
  const { origin, checkout } = remote(t);
  const a = checkout();
  const b = checkout();
  for (const job of [a, b]) {
    assert.equal(runCli(job, WRITER, ['--activate']).status, 0);
    commit(job, 'chore(marketplace): sync catalog versions to release-please-manifest and activate the Codex catalog pins');
  }
  assert.equal(push(a), true, 'the first job publishes');
  assert.equal(push(b), false, 'the second is rejected as non-fast-forward — and must not be forced');
  // The remote already carries a complete activation from the other job;
  // inspecting it first is what tells case 2 from case 3.
  assert.equal(JSON.parse(git(origin, ['show', 'main:scripts/data/codex-pin-floors.json'])).activated, true);
  const fresh = checkout();
  const out = runCli(fresh, WRITER, ['--activate']);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /already in sync/);
  assert.equal(git(fresh, ['status', '--porcelain']).trim(), '', 'nothing left to push');
});

test('recovery through a remote — after a later step failed, a fresh dispatch converges, and advances once main moves', (t) => {
  const { checkout } = remote(t);
  const job = checkout();
  assert.equal(runCli(job, WRITER, ['--activate']).status, 0);
  commit(job, 'chore(marketplace): sync catalog versions to release-please-manifest and activate the Codex catalog pins');
  assert.equal(push(job), true);
  // ...the stage-doc step fails here. The activation is published.
  const again = checkout();
  assert.equal(runCli(again, WRITER, ['--activate']).status, 0);
  assert.equal(git(again, ['status', '--porcelain']).trim(), '');
  // A release lands on main before the next dispatch.
  release(again, 'beta', '1.1.0');
  assert.equal(push(again), true);
  const next = checkout();
  const out = runCli(next, WRITER);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /\.agents\/plugins\/marketplace\.json beta: plugin-beta-v1\.0\.0 → plugin-beta-v1\.1\.0/);
  assert.equal(readJSON(next, FLOORS).activated, true, 'never reverted');
});
