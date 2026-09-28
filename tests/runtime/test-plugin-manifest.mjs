// The plugin-package version reader — lib/plugin-manifest.mjs.
//
// These cases lived in test-host-parity-baseline.mjs, where they were reached
// through the baseline resolver's `provenance.manifest`. ADR-0060 deleted that
// resolver; the reader survives (`version.mjs` stamps every artifact with it),
// so its cases are anchored on the reader itself rather than lost with the file
// that used to carry them.
//
// Each case names the failure it pins:
//
//   - two manifests that disagree are REPORTED, not silently resolved;
//   - a malformed half is named instead of falling through to the other half;
//   - a manifest version that is not SemVer is refused, with the raw text kept;
//   - the synchronous reader goes through the shared containment predicate.

import { describe, it } from 'node:test';
import { notStrictEqual, strictEqual } from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readPluginManifestVersions, readPluginManifestVersionsSync } from '../../plugins/runtime/scripts/lib/plugin-manifest.mjs';
import { isSemVer } from '../../plugins/runtime/scripts/lib/semver.mjs';

async function fixturePackage({ version = '0.89.0', codexVersion, claudeRaw } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'manifest-pkg-'));
  await mkdir(join(root, '.claude-plugin'), { recursive: true });
  if (claudeRaw !== undefined) {
    await writeFile(join(root, '.claude-plugin', 'plugin.json'), claudeRaw);
  } else if (version !== null) {
    await writeFile(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'runtime', version }));
  }
  if (codexVersion !== undefined) {
    await mkdir(join(root, '.codex-plugin'), { recursive: true });
    await writeFile(join(root, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'runtime', version: codexVersion }));
  }
  return root;
}

describe('plugin manifest reader (lib/plugin-manifest.mjs)', () => {
  it('reports a manifest DISAGREEMENT instead of silently picking a side', async () => {
    // Measured before the reader was unified: one surface read `.claude-plugin`
    // first and `version.mjs` read `.codex-plugin` first, so one corrupt install
    // reported two different versions on two surfaces and neither said so.
    const read = await readPluginManifestVersions(await fixturePackage({ version: '1.1.1', codexVersion: '2.2.2' }));

    strictEqual(read.status, 'disagreement');
    strictEqual(read.manifests.claude.version, '1.1.1');
    strictEqual(read.manifests.codex.version, '2.2.2');
    // The tiebreak is Codex-first and arbitrary on the merits; the disagreement
    // is the reportable fact.
    strictEqual(read.version, '2.2.2');
  });

  it('names a malformed manifest instead of falling through to the other one', async () => {
    const read = await readPluginManifestVersions(await fixturePackage({ claudeRaw: '{ not json', codexVersion: '3.3.3' }));

    strictEqual(read.version, '3.3.3', 'the usable half still supplies a version');
    strictEqual(read.status, 'partial');
    strictEqual(read.manifests.claude.status, 'malformed', 'and the broken half is REPORTED');
  });

  it('rejects a manifest version that is not a version, keeping the raw text as evidence', async () => {
    // A package that disagrees with itself about what a version is cannot
    // report installed state honestly.
    const read = await readPluginManifestVersions(await fixturePackage({ version: 'banana' }));

    strictEqual(read.version, null);
    strictEqual(read.status, 'unusable');
    strictEqual(read.manifests.claude.status, 'invalid');
    strictEqual(read.manifests.claude.raw, 'banana');
  });

  it('the manifest shape predicate is SemVer, not a loose approximation', async () => {
    // `01.2.3` and `1.2.3-01` are not SemVer, and a private regex accepted
    // both — a manifest saying `01.2.3` was classified `ok` and stamped onto
    // artifacts (cross-host review).
    strictEqual(isSemVer('01.2.3'), false);
    strictEqual(isSemVer('1.2.3-01'), false);
    strictEqual(isSemVer('1.2.3'), true);
    strictEqual(isSemVer('0.90.1-beta.1+build.5'), true);

    const read = await readPluginManifestVersions(await fixturePackage({ version: '01.2.3' }));
    strictEqual(read.manifests.claude.status, 'invalid');
    strictEqual(read.manifests.claude.raw, '01.2.3');
  });

  it('the SYNC manifest reader goes through the shared predicate', async () => {
    // `version.mjs` is this function's only caller, and nothing exercised it
    // against a fixture package — so a mutation replacing the shared predicate
    // with a hand-rolled `${root}/${relative}` (the exact shape whose
    // hard-coded separator made every Windows manifest `escaped`) survived the
    // suite. The verdict, not the wiring, is what this pins: an escaped
    // manifest must be reported as escaped by BOTH readers.
    const outside = await mkdtemp(join(tmpdir(), 'manifest-sync-out-'));
    await writeFile(join(outside, 'plugin.json'), JSON.stringify({ version: '99.99.99' }));
    const root = await fixturePackage({ version: null, codexVersion: '0.90.1' });
    await symlink(join(outside, 'plugin.json'), join(root, '.claude-plugin', 'plugin.json'));

    const sync = readPluginManifestVersionsSync(root);
    strictEqual(sync.manifests.claude.status, 'escaped');
    strictEqual(sync.version, '0.90.1', 'the contained half still supplies a version');
    notStrictEqual(sync.version, '99.99.99');

    // And the two readers must agree — a second implementation is what made
    // them able to disagree in the first place.
    const asyncResult = await readPluginManifestVersions(root);
    strictEqual(sync.status, asyncResult.status);
    strictEqual(sync.version, asyncResult.version);
    strictEqual(sync.manifests.claude.status, asyncResult.manifests.claude.status);
    strictEqual(sync.manifests.codex.status, asyncResult.manifests.codex.status);

    // CONTROL: an ordinary package still reads through cleanly.
    const healthy = readPluginManifestVersionsSync(await fixturePackage({ version: '0.90.1', codexVersion: '0.90.1' }));
    strictEqual(healthy.status, 'ok');
    strictEqual(healthy.version, '0.90.1');
  });
});
