// ADR-0061 §Decision 4 — for each Codex plugin, three facts kept apart: the catalog
// target (the pin's ref version and sha), the observed installed version, and whether
// the installed bytes were verified against the pinned tree.
//
// The fixtures are REAL: a git repository stands in for the registered marketplace
// clone, and each "installed" cache is extracted from that repository with
// `git archive`, the way a successful materialization produces it. The two failure
// shapes the ADR names are then made by hand from a correct install:
//   - across a version change: the catalog pins C2 (0.2.0), the cache still holds C1
//     (0.1.0) — target and installed disagree;
//   - same version, divergent bytes: the catalog pins C1 (0.1.0), the cache holds
//     0.1.0 with one file changed — target and installed AGREE, and only the content
//     check can say the install is not the release. Never reported current.
// A correct install is the control for both: it must read `current`, or the failure
// assertions prove nothing about the check.

import { describe, it } from 'node:test';
import { deepStrictEqual, doesNotMatch, match, ok, strictEqual } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assessCodexCurrentness,
  compareInstalledToPinnedTree,
  hashInstalledTree,
  hashInstalledTreeStable,
  parseCodexCatalogTarget,
  summarizeCodexCatalogTargets,
} from '../../plugins/runtime/scripts/lib/codex-install-identity.mjs';
import { probeMachineHostState, readRegisteredMarketplaceCatalog } from '../../plugins/runtime/scripts/lib/machine-probe.mjs';
import { judgeSteps, serializeProbe } from '../../plugins/runtime/scripts/bootstrap.mjs';
import { recomputeHookAttestation } from '../../plugins/runtime/scripts/lib/completion-reducer.mjs';
import { formatText, runDoctor } from '../../plugins/runtime/scripts/doctor.mjs';
import {
  SHA,
  buildClone,
  enoent,
  installFromClone as install,
  mixedRunner,
  okResult,
  pinned,
  writeCatalog,
} from './_codex-pinned-fixture.mjs';

function probeMap(clone, { listVersion = null, listRows = null } = {}) {
  const map = {
    'codex --version': okResult('codex-cli 0.156.1\n'),
    'codex plugin --help': okResult('Commands:\n  add\n  list\n  remove\n'),
    'codex plugin marketplace list --json': okResult(JSON.stringify([
      { name: 'agentic-plugins', marketplaceSource: { sourceType: 'git', source: 'https://github.com/each4all/agentic-plugins.git' }, installLocation: clone },
    ])),
  };
  const rows = listRows ?? (listVersion ? [{ name: 'runtime', marketplaceName: 'agentic-plugins', version: listVersion, installed: true, enabled: true }] : null);
  if (rows) map['codex plugin list --json'] = okResult(JSON.stringify({ installed: rows }));
  return map;
}

async function probe({ clone, codexHome, env = {}, map, gitCalls }) {
  const home = await mkdtemp(join(tmpdir(), 'codex-identity-home-'));
  const result = await probeMachineHostState({ homeDir: home, codexHome, env, runner: mixedRunner(map, gitCalls) });
  return result.codexInstallIdentity.plugins.runtime;
}

describe('ADR-0061 §Decision 4 — the catalog target', () => {
  it('parses a pin into its version, and a local entry into an unpinned target with no version', () => {
    const pin = parseCodexCatalogTarget(pinned('runtime', '0.97.4'));
    strictEqual(pin.status, 'pinned');
    strictEqual(pin.version, '0.97.4');
    strictEqual(pin.sha, SHA);
    strictEqual(pin.path, 'plugins/runtime');
    const local = parseCodexCatalogTarget({ name: 'runtime', source: { source: 'local', path: './plugins/runtime' } });
    strictEqual(local.status, 'unpinned');
    strictEqual(local.version, null, 'a local entry names no release, and none is invented for it');
  });

  it('reads a version that itself contains -v (round 6, Codex review)', () => {
    for (const version of ['1.0.0-rc-v2', '1.0.0+build-v2']) {
      const target = parseCodexCatalogTarget({ name: 'runtime', source: { ...pinned('runtime', version).source } });
      strictEqual(target.status, 'pinned', `${version}: ${target.reason}`);
      strictEqual(target.version, version);
    }
    // And a plugin whose NAME contains -v is not split inside the name.
    const named = parseCodexCatalogTarget(pinned('dev-vault', '2.0.0'));
    strictEqual(named.version, '2.0.0');
  });

  it('rejects a malformed pin as invalid, never as a version', () => {
    for (const [label, entry, reason] of [
      ['short sha', pinned('runtime', '1.0.0', 'abc123'), /sha/],
      ['uppercase sha', pinned('runtime', '1.0.0', 'A'.repeat(40)), /sha/],
      ['ref for another plugin', { name: 'runtime', source: { ...pinned('engineer', '1.0.0').source, path: 'plugins/runtime' } }, /ref/],
      ['ref with no semver', { name: 'runtime', source: { ...pinned('runtime', '1.0.0').source, ref: 'plugin-runtime-vnext' } }, /ref/],
      ['path for another plugin', { name: 'runtime', source: { ...pinned('runtime', '1.0.0').source, path: 'plugins/engineer' } }, /path/],
      ['unknown source kind', { name: 'runtime', source: { ...pinned('runtime', '1.0.0').source, source: 'npm' } }, /source kind/],
      ['no source object', { name: 'runtime', source: './plugins/runtime' }, /no source object/],
    ]) {
      const target = parseCodexCatalogTarget(entry);
      strictEqual(target.status, 'invalid', label);
      strictEqual(target.version, null, `${label}: an invalid pin carries no version`);
      match(target.reason, reason, label);
    }
  });

  it('classifies a catalog as unpinned, pinned, mixed or empty', () => {
    const local = { name: 'engineer', source: { source: 'local', path: './plugins/engineer' } };
    strictEqual(summarizeCodexCatalogTargets([local]).pin_phase, 'unpinned');
    strictEqual(summarizeCodexCatalogTargets([pinned('runtime', '1.0.0')]).pin_phase, 'pinned');
    strictEqual(summarizeCodexCatalogTargets([pinned('runtime', '1.0.0'), local]).pin_phase, 'mixed');
    // A malformed pin still states pin intent: it cannot make a mixed catalog read as unpinned.
    strictEqual(summarizeCodexCatalogTargets([pinned('runtime', '1.0.0', 'bad'), local]).pin_phase, 'mixed');
    strictEqual(summarizeCodexCatalogTargets([]).pin_phase, 'empty');
  });

  it('the registered-catalog reader reports pinned versions and keeps local catalogs versionless', async () => {
    const pinnedCatalog = await readRegisteredMarketplaceCatalog({
      host: 'codex',
      installLocation: '/x',
      readJson: async () => ({ ok: true, json: { plugins: [pinned('runtime', '0.97.4'), pinned('engineer', '1.0.0', 'nope')] } }),
    });
    strictEqual(pinnedCatalog.read_status, 'read');
    strictEqual(pinnedCatalog.pin_phase, 'pinned');
    deepStrictEqual(pinnedCatalog.versions, { runtime: '0.97.4', engineer: null });
    strictEqual(pinnedCatalog.targets.engineer.status, 'invalid');
    const localCatalog = await readRegisteredMarketplaceCatalog({
      host: 'codex',
      installLocation: '/x',
      readJson: async () => ({ ok: true, json: { plugins: [{ name: 'runtime', source: { source: 'local', path: './plugins/runtime' } }] } }),
    });
    strictEqual(localCatalog.read_status, 'versionless');
    strictEqual(localCatalog.pin_phase, 'unpinned');
  });
});

describe('ADR-0061 §Decision 4 — currentness from the three facts', () => {
  it('ranks prerelease pins, and never calls a version match without verified bytes current', () => {
    const target = { status: 'pinned', version: '1.0.0-rc.2' };
    strictEqual(assessCodexCurrentness({ target, installed: { status: 'installed', version: '1.0.0-rc.1' } }), 'behind');
    strictEqual(assessCodexCurrentness({ target, installed: { status: 'installed', version: '1.0.0-rc.2' }, identity: { status: 'unverified' } }), 'content-unverified');
    strictEqual(assessCodexCurrentness({ target, installed: { status: 'installed', version: '1.0.0-rc.2' }, identity: { status: 'verified' } }), 'current');
    strictEqual(assessCodexCurrentness({ target, installed: { status: 'installed', version: 'not-semver' } }), 'unknown');
    strictEqual(assessCodexCurrentness({ target: { status: 'unpinned', version: null }, installed: { status: 'installed', version: '1.0.0' } }), 'unknown');
  });

  it('compares modes as well as contents and paths', () => {
    const pinnedTree = new Map([['a', { mode: '100755', type: 'blob', oid: 'x' }]]);
    strictEqual(compareInstalledToPinnedTree(pinnedTree, new Map([['a', { mode: '100755', oid: 'x' }]])).status, 'verified');
    const lostBit = compareInstalledToPinnedTree(pinnedTree, new Map([['a', { mode: '100644', oid: 'x' }]]));
    strictEqual(lostBit.status, 'mismatch');
    deepStrictEqual(lostBit.mode_differing_sample, ['a']);
    strictEqual(compareInstalledToPinnedTree(new Map([['s', { mode: '160000', type: 'commit', oid: 'x' }]]), new Map()).status, 'unverified');
  });

  it('hashes a symlink target by its bytes, so targets that decode alike do not collide (round 6)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'codex-identity-link-'));
    // The installed link points at the single byte 0xff; the pinned tree's link at the
    // three bytes of U+FFFD. Decoded, both read '\uFFFD'.
    await symlink(Buffer.from([0xff]), join(dir, 'link'));
    const installedTree = await hashInstalledTree(dir);
    const replacementBytes = Buffer.from([0xef, 0xbf, 0xbd]);
    const pinnedOid = createHash('sha1').update(`blob ${replacementBytes.length}\0`).update(replacementBytes).digest('hex');
    const result = compareInstalledToPinnedTree(new Map([['link', { mode: '120000', type: 'blob', oid: pinnedOid }]]), installedTree);
    strictEqual(result.status, 'mismatch');
    deepStrictEqual(result.differing_sample, ['link']);
  });

  it('never matches a path that decoded lossily (round 5, Codex review)', () => {
    // git names the file with byte 0xff; the install names it U+FFFD. Decoded, both
    // read as '\uFFFD' and would compare equal with identical contents and mode.
    const lossy = '\uFFFD.mjs';
    const entry = { mode: '100644', type: 'blob', oid: 'x' };
    const result = compareInstalledToPinnedTree(new Map([[lossy, entry]]), new Map([[lossy, { mode: '100644', oid: 'x' }]]));
    strictEqual(result.status, 'unverified');
    match(result.reason, /decoded losslessly/);
  });
});

describe('ADR-0061 §Decision 4 — content identity against a real pinned tree', () => {
  it('CONTROL: a correct materialization of the pin is verified and current', async () => {
    const { clone, c1 } = await buildClone();
    await writeCatalog(clone, [pinned('runtime', '0.1.0', c1)]);
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-identity-codex-'));
    await install(clone, c1, codexHome, '0.1.0');
    const fact = await probe({ clone, codexHome, map: probeMap(clone, { listVersion: '0.1.0' }) });
    strictEqual(fact.catalog_target.version, '0.1.0');
    strictEqual(fact.catalog_target.sha, c1);
    strictEqual(fact.installed.version, '0.1.0');
    strictEqual(fact.installed.source, 'plugin-list');
    strictEqual(fact.content_identity.status, 'verified', JSON.stringify(fact.content_identity));
    strictEqual(fact.content_identity.compared_files, 3);
    strictEqual(fact.currentness, 'current');
  });

  it('failure across a version change: target and installed disagree, and the bytes are not claimed', async () => {
    const { clone, c1, c2 } = await buildClone();
    await writeCatalog(clone, [pinned('runtime', '0.2.0', c2)]);
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-identity-codex-'));
    await install(clone, c1, codexHome, '0.1.0'); // the older cache stays
    const fact = await probe({ clone, codexHome, map: probeMap(clone, { listVersion: '0.1.0' }) });
    strictEqual(fact.catalog_target.version, '0.2.0');
    strictEqual(fact.installed.version, '0.1.0');
    strictEqual(fact.currentness, 'behind');
    strictEqual(fact.content_identity.verified, false);
    match(fact.content_identity.reason, /0\.1\.0 is not the pinned 0\.2\.0/);
  });

  it('failure in a same-version repair: versions agree, the bytes differ, and it is never current', async () => {
    const { clone, c1 } = await buildClone();
    await writeCatalog(clone, [pinned('runtime', '0.1.0', c1)]);
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-identity-codex-'));
    const dest = await install(clone, c1, codexHome, '0.1.0');
    await writeFile(join(dest, 'scripts', 'a.mjs'), 'export const v = "main";\n'); // divergent bytes, same version
    const fact = await probe({ clone, codexHome, map: probeMap(clone, { listVersion: '0.1.0' }) });
    strictEqual(fact.catalog_target.version, fact.installed.version, 'the premise: version agreement');
    strictEqual(fact.content_identity.verified, false);
    strictEqual(fact.content_identity.status, 'mismatch');
    deepStrictEqual(fact.content_identity.differing_sample, ['scripts/a.mjs']);
    strictEqual(fact.currentness, 'content-mismatch');
  });

  it('a lost executable bit and an extra file are divergence too', async () => {
    const { clone, c1 } = await buildClone();
    await writeCatalog(clone, [pinned('runtime', '0.1.0', c1)]);
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-identity-codex-'));
    const dest = await install(clone, c1, codexHome, '0.1.0');
    // 0654: group and other may execute, the owner may not — git calls that 100644, and
    // so must this check (any-execute-bit would read it as 100755).
    await chmod(join(dest, 'scripts', 'run.sh'), 0o654);
    await writeFile(join(dest, 'scripts', 'unreleased.mjs'), '// only on main\n');
    const fact = await probe({ clone, codexHome, map: probeMap(clone, { listVersion: '0.1.0' }) });
    strictEqual(fact.currentness, 'content-mismatch');
    deepStrictEqual(fact.content_identity.mode_differing_sample, ['scripts/run.sh']);
    deepStrictEqual(fact.content_identity.extra_sample, ['scripts/unreleased.mjs']);
  });

  it('with the list unavailable, the newest retained PRERELEASE is the installed fact (round 7)', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-identity-codex-'));
    for (const version of ['1.0.0-rc.2', '1.0.0-rc.10', '1.0.0-rc.1']) {
      const dir = join(codexHome, 'plugins', 'cache', 'agentic-plugins', 'runtime', version, '.codex-plugin');
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'plugin.json'), JSON.stringify({ name: 'runtime', version }));
    }
    const home = await mkdtemp(join(tmpdir(), 'codex-identity-home-'));
    const result = await probeMachineHostState({ homeDir: home, codexHome, env: {}, runner: async (command) => enoent(command) });
    strictEqual(result.caches.codex.runtime.latest.manifest_version, '1.0.0-rc.10', 'rc.10 > rc.2 > rc.1');
    strictEqual(result.codexInstallIdentity.plugins.runtime.installed.version, '1.0.0-rc.10');
  });

  it('with the list unavailable, the manifest-verified cache is the installed fact', async () => {
    const { clone, c1 } = await buildClone();
    await writeCatalog(clone, [pinned('runtime', '0.1.0', c1)]);
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-identity-codex-'));
    await install(clone, c1, codexHome, '0.1.0');
    const fact = await probe({ clone, codexHome, map: probeMap(clone) });
    strictEqual(fact.installed.source, 'cache');
    strictEqual(fact.currentness, 'current');
  });

  it('with two retained directories declaring the pinned version, hashes the one NAMED by it, and refuses a tie', async () => {
    const { clone, c1 } = await buildClone();
    await writeCatalog(clone, [pinned('runtime', '0.1.0', c1)]);
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-identity-codex-'));
    // 0.1.0/ is what Codex serves, with divergent bytes; 0.0.9/ holds pristine release
    // bytes but ALSO declares 0.1.0. Picking the first match would certify the wrong one.
    const served = await install(clone, c1, codexHome, '0.1.0');
    await writeFile(join(served, 'scripts', 'a.mjs'), 'export const v = "main";\n');
    await install(clone, c1, codexHome, '0.0.9');
    const fact = await probe({ clone, codexHome, map: probeMap(clone, { listVersion: '0.1.0' }) });
    strictEqual(fact.currentness, 'content-mismatch', JSON.stringify(fact.content_identity));

    // No directory NAMED by the version: another name declaring it is never borrowed.
    const tieHome = await mkdtemp(join(tmpdir(), 'codex-identity-codex-'));
    await install(clone, c1, tieHome, '0.0.8');
    await install(clone, c1, tieHome, '0.0.9');
    const tie = await probe({ clone, codexHome: tieHome, map: probeMap(clone, { listVersion: '0.1.0' }) });
    strictEqual(tie.currentness, 'content-unverified');
    match(tie.content_identity.reason, /no install cache directory is named 0\.1\.0/);
  });

  it('a directory named by the version whose manifest declares another is never verified, and nothing else is borrowed', async () => {
    // Round 2 (Codex review): 0.1.0/ holds divergent bytes whose manifest says 0.2.0; a
    // retained 0.0.9/ holds pristine release bytes declaring 0.1.0. Filtering by manifest
    // alone would have certified 0.0.9/.
    const { clone, c1, c2 } = await buildClone();
    await writeCatalog(clone, [pinned('runtime', '0.1.0', c1)]);
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-identity-codex-'));
    await install(clone, c2, codexHome, '0.1.0');
    await install(clone, c1, codexHome, '0.0.9');
    const fact = await probe({ clone, codexHome, map: probeMap(clone, { listVersion: '0.1.0' }) });
    strictEqual(fact.currentness, 'content-unverified');
    match(fact.content_identity.reason, /the install cache directory 0\.1\.0\/ declares 0\.2\.0/);
  });

  it('a tree that changes while it is hashed is not one install: unverified, even with the manifest unchanged', async () => {
    const { clone, c1 } = await buildClone();
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-identity-codex-'));
    const dest = await install(clone, c1, codexHome, '0.1.0');
    const manifest = await readFile(join(dest, '.codex-plugin', 'plugin.json'), 'utf8');
    const still = await hashInstalledTreeStable(dest);
    strictEqual(still.stable, true, 'CONTROL: an untouched tree holds still');
    // Same-version replacement: the whole directory swapped in place, manifest byte-identical.
    const moved = await hashInstalledTreeStable(dest, {
      beforeRecheck: async () => {
        const staged = `${dest}.staged`;
        await cp(dest, staged, { recursive: true });
        await writeFile(join(staged, 'scripts', 'a.mjs'), 'export const v = "main";\n');
        await rm(dest, { recursive: true, force: true });
        await cp(staged, dest, { recursive: true });
      },
    });
    strictEqual(await readFile(join(dest, '.codex-plugin', 'plugin.json'), 'utf8'), manifest, 'the premise: the manifest is unchanged');
    strictEqual(moved.stable, false);
    // An in-place edit of one file is caught too.
    const edited = await hashInstalledTreeStable(dest, {
      beforeRecheck: async () => { await writeFile(join(dest, 'scripts', 'run.sh'), '#!/bin/sh\necho changed\n'); },
    });
    strictEqual(edited.stable, false);
  });

  it('a pinned commit the clone does not hold leaves identity unverified, never current', async () => {
    const { clone, c1 } = await buildClone();
    await writeCatalog(clone, [pinned('runtime', '0.1.0', 'b'.repeat(40))]);
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-identity-codex-'));
    await install(clone, c1, codexHome, '0.1.0');
    const fact = await probe({ clone, codexHome, map: probeMap(clone, { listVersion: '0.1.0' }) });
    strictEqual(fact.currentness, 'content-unverified');
    match(fact.content_identity.reason, /could not be read from the marketplace clone/);
  });

  it('git that cannot run leaves identity unverified', async () => {
    const { clone, c1 } = await buildClone();
    await writeCatalog(clone, [pinned('runtime', '0.1.0', c1)]);
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-identity-codex-'));
    await install(clone, c1, codexHome, '0.1.0');
    const home = await mkdtemp(join(tmpdir(), 'codex-identity-home-'));
    const map = probeMap(clone, { listVersion: '0.1.0' });
    const result = await probeMachineHostState({ homeDir: home, codexHome, env: {}, runner: async (command, args) => map[`${command} ${args.join(' ')}`] ?? enoent(command) });
    const fact = result.codexInstallIdentity.plugins.runtime;
    strictEqual(fact.currentness, 'content-unverified');
    match(fact.content_identity.reason, /git could not run/);
  });

  it('conflicting list rows leave identity unverified', async () => {
    const { clone, c1 } = await buildClone();
    await writeCatalog(clone, [pinned('runtime', '0.1.0', c1)]);
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-identity-codex-'));
    await install(clone, c1, codexHome, '0.1.0');
    const rows = [
      { name: 'runtime', marketplaceName: 'agentic-plugins', version: '0.1.0', installed: true, enabled: true },
      { name: 'runtime', marketplaceName: 'agentic-plugins', version: '0.0.9', installed: true, enabled: true },
    ];
    const fact = await probe({ clone, codexHome, map: probeMap(clone, { listRows: rows }) });
    strictEqual(fact.content_identity.verified, false);
    match(fact.content_identity.reason, /conflicting rows/);
  });

  it('an unpinned catalog leaves currentness unknown and reads no repository or clone manifest version', async () => {
    const { clone, c1 } = await buildClone();
    await writeCatalog(clone, [{ name: 'runtime', source: { source: 'local', path: './plugins/runtime' } }]);
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-identity-codex-'));
    await install(clone, c1, codexHome, '0.1.0');
    const gitCalls = [];
    // The clone's working tree says 0.2.0 — newer than the install. Unpinned, that is not a target.
    const fact = await probe({ clone, codexHome, map: probeMap(clone, { listVersion: '0.1.0' }), gitCalls });
    strictEqual(fact.catalog_target.status, 'unpinned');
    strictEqual(fact.catalog_target.version, null);
    strictEqual(fact.currentness, 'unknown');
    strictEqual(gitCalls.length, 0, 'nothing to verify against, so git is not read');
  });

  it('the git read ignores a caller GIT_DIR and runs immutable and offline', async () => {
    const { clone, c1 } = await buildClone();
    await writeCatalog(clone, [pinned('runtime', '0.1.0', c1)]);
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-identity-codex-'));
    await install(clone, c1, codexHome, '0.1.0');
    // A different repository the caller's environment points at.
    const decoy = await buildClone();
    const gitCalls = [];
    const fact = await probe({
      clone,
      codexHome,
      env: { ...process.env, GIT_DIR: join(decoy.clone, '.git'), GIT_WORK_TREE: decoy.clone },
      map: probeMap(clone, { listVersion: '0.1.0' }),
      gitCalls,
    });
    strictEqual(fact.currentness, 'current', 'the pinned commit was read from the registered clone');
    strictEqual(gitCalls.length, 1);
    strictEqual(gitCalls[0].env.GIT_DIR, undefined);
    strictEqual(gitCalls[0].env.GIT_WORK_TREE, undefined);
    strictEqual(gitCalls[0].env.GIT_NO_REPLACE_OBJECTS, '1');
    strictEqual(gitCalls[0].env.GIT_NO_LAZY_FETCH, '1');
    deepStrictEqual(gitCalls[0].args.slice(0, 4), ['--no-optional-locks', '-C', clone, 'ls-tree']);
  });
});

describe('ADR-0061 S3 — bootstrap credits nothing to an install it cannot read', () => {
  // Round 3 (Codex review): Codex listed engineer installed at 1.0.0 with no install-cache
  // directory named 1.0.0. Doctor already refuses to call an attestation current there;
  // bootstrap's probe and reducer must agree.
  function raw({ cachePath }) {
    return {
      installed: { claude: [], codex: [{ id: 'engineer', version: '1.0.0', enabled: true }] },
      claude: { plugin: { status: 'available' } },
      codex: { plugin_list: { status: 'available' }, version: { text: 'codex-cli 0.137.0' } },
      codexInstallIdentity: { plugins: { engineer: { installed: { status: 'installed', version: '1.0.0', source: 'plugin-list', cache_path: cachePath } } } },
      codexHookConfig: { config_status: 'available', entries: [] },
    };
  }
  const record = {
    status: 'attested',
    attested_plugins: ['engineer'],
    bound_versions: { codex: '0.137.0', plugins: { codex: { engineer: '1.0.0' } } },
    attested_at: '2026-09-25T00:00:00Z',
  };
  const current = { codex: '0.137.0', plugins: { codex: { engineer: '1.0.0' } } };

  it('reads an installed plugin with no cache directory for its version as unknown, and does not attest it', () => {
    const unreadable = serializeProbe({ raw: raw({ cachePath: null }), now: '2026-09-25T00:00:00Z' });
    strictEqual(unreadable.hosts.codex.plugins.engineer.state, 'unknown');
    const verdict = recomputeHookAttestation(record, { current, expectedPlugins: ['engineer'], probe: unreadable, applicable: true });
    strictEqual(verdict.status, 'stale');
    match(verdict.reasons.join(' '), /engineer is unknown on Codex/);
  });

  it('CONTROL: the same install with its cache directory is installed and attests', () => {
    const readable = serializeProbe({ raw: raw({ cachePath: '/codex/plugins/cache/agentic-plugins/engineer/1.0.0' }), now: '2026-09-25T00:00:00Z' });
    strictEqual(readable.hosts.codex.plugins.engineer.state, 'installed');
    const verdict = recomputeHookAttestation(record, { current, expectedPlugins: ['engineer'], probe: readable, applicable: true });
    strictEqual(verdict.status, 'attested', verdict.reasons.join('; '));
  });
});

describe('ADR-0061 S3 — bootstrap names the manual Codex remedy', () => {
  // Round 4 (Codex review): the probe reads an unreadable install `unknown`; the step
  // must say what to do, and a Codex install below its floor must not be sent to a
  // per-plugin update Codex does not have.
  function judgeCodex(entry, { floor = null } = {}) {
    const [installed, enabled] = judgeSteps({
      expected: [
        { id: 'plugin.engineer.codex.installed', stage: 2, applicable: true, declinable: false, blocked_by: [] },
        { id: 'plugin.engineer.codex.enabled', stage: 2, applicable: true, declinable: false, blocked_by: [] },
      ],
      probe: { hosts: { claude: { plugins: {} }, codex: { plugins: { engineer: entry } } } },
      raw: {},
      pluginSet: { plugins: { engineer: { minimum_version: floor } } },
      readers: {},
      hookVerdict: null,
      now: new Date('2026-09-25T00:00:00Z'),
    });
    return { installed, enabled };
  }

  it('an unreadable Codex install is unknown on both steps, with the reinstall named', () => {
    const { installed, enabled } = judgeCodex({ version: '1.0.0', state: 'unknown' });
    for (const step of [installed, enabled]) {
      strictEqual(step.status, 'unknown');
      match(step.recovery, /no install-cache directory holds that version/);
      match(step.recovery, /codex plugin remove engineer@agentic-plugins/);
    }
  });

  it('CONTROL: an unknown with no version (the list could not be read) carries no reinstall advice', () => {
    const { installed } = judgeCodex({ version: null, state: 'unknown' });
    strictEqual(installed.status, 'unknown');
    strictEqual(installed.recovery ?? null, null);
  });

  it('a Codex install below its floor whose catalog already pins the floor is a reinstall, not a refresh (round 5)', () => {
    const [installed] = judgeSteps({
      expected: [{ id: 'plugin.engineer.codex.installed', stage: 2, applicable: true, declinable: false, blocked_by: [] }],
      probe: { hosts: { claude: { plugins: {} }, codex: { plugins: { engineer: { version: '0.1.0', state: 'installed' } } } } },
      raw: { codexInstallIdentity: { plugins: { engineer: { currentness: 'behind', catalog_target: { status: 'pinned', version: '0.2.0', ref: 'plugin-engineer-v0.2.0' } } } } },
      pluginSet: { plugins: { engineer: { minimum_version: '0.2.0' } } },
      readers: {},
      hookVerdict: null,
      now: new Date('2026-09-25T00:00:00Z'),
    });
    strictEqual(installed.status, 'pending');
    match(installed.recovery, /the catalog already pins plugin-engineer-v0\.2\.0/);
    match(installed.recovery, /codex plugin remove engineer@agentic-plugins/);
    doesNotMatch(installed.recovery, /marketplace upgrade/);
  });

  it('a Codex install below its floor is sent to a marketplace refresh, not a per-plugin update', () => {
    const { installed } = judgeCodex({ version: '0.6.0', state: 'installed' }, { floor: '0.7.0' });
    strictEqual(installed.status, 'pending');
    match(installed.recovery, /Codex has no per-plugin update/);
    match(installed.recovery, /codex plugin marketplace upgrade agentic-plugins/);
  });
});

describe('ADR-0061 §Decision 4 — doctor reports the three facts', () => {
  async function doctorFor({ clone, codexHome, listVersion }) {
    const root = await mkdtemp(join(tmpdir(), 'codex-identity-repo-'));
    const home = await mkdtemp(join(tmpdir(), 'codex-identity-doctor-home-'));
    return runDoctor({
      repoRoot: root,
      homeDir: home,
      env: { CODEX_HOME: codexHome },
      runner: mixedRunner(probeMap(clone, { listVersion })),
    });
  }

  it('names both failure shapes in host parity and text, and neither as current', async () => {
    const behind = await buildClone();
    await writeCatalog(behind.clone, [pinned('runtime', '0.2.0', behind.c2)]);
    const behindHome = await mkdtemp(join(tmpdir(), 'codex-identity-codex-'));
    await install(behind.clone, behind.c1, behindHome, '0.1.0');
    const behindReport = await doctorFor({ clone: behind.clone, codexHome: behindHome, listVersion: '0.1.0' });
    strictEqual(behindReport.plugins.runtime.codex_install.currentness, 'behind');
    ok(behindReport.host_parity.issues.some((issue) => issue.id === 'codex_install_behind_catalog_target' && issue.plugin === 'runtime'));
    match(formatText(behindReport), /- runtime: behind; target=plugin-runtime-v0\.2\.0@/);

    const divergent = await buildClone();
    await writeCatalog(divergent.clone, [pinned('runtime', '0.1.0', divergent.c1)]);
    const divergentHome = await mkdtemp(join(tmpdir(), 'codex-identity-codex-'));
    const dest = await install(divergent.clone, divergent.c1, divergentHome, '0.1.0');
    await writeFile(join(dest, 'scripts', 'a.mjs'), 'export const v = "main";\n');
    const divergentReport = await doctorFor({ clone: divergent.clone, codexHome: divergentHome, listVersion: '0.1.0' });
    strictEqual(divergentReport.plugins.runtime.codex_install.currentness, 'content-mismatch');
    const issue = divergentReport.host_parity.issues.find((entry) => entry.id === 'codex_install_content_mismatch');
    ok(issue, 'the same-version failure is a parity warning');
    strictEqual(issue.severity, 'warning');
    match(issue.evidence, /differing=1/);
  });

  it('CONTROL: a verified pinned install raises no identity issue, and an unpinned catalog raises none either', async () => {
    const good = await buildClone();
    await writeCatalog(good.clone, [pinned('runtime', '0.1.0', good.c1)]);
    const goodHome = await mkdtemp(join(tmpdir(), 'codex-identity-codex-'));
    await install(good.clone, good.c1, goodHome, '0.1.0');
    const report = await doctorFor({ clone: good.clone, codexHome: goodHome, listVersion: '0.1.0' });
    strictEqual(report.plugins.runtime.codex_install.currentness, 'current');
    ok(!report.host_parity.issues.some((issue) => issue.id.startsWith('codex_install_') || issue.id.startsWith('codex_catalog_pin_')));

    const unpinned = await buildClone();
    await writeCatalog(unpinned.clone, [{ name: 'runtime', source: { source: 'local', path: './plugins/runtime' } }]);
    const unpinnedHome = await mkdtemp(join(tmpdir(), 'codex-identity-codex-'));
    await install(unpinned.clone, unpinned.c1, unpinnedHome, '0.1.0');
    const unpinnedReport = await doctorFor({ clone: unpinned.clone, codexHome: unpinnedHome, listVersion: '0.1.0' });
    strictEqual(unpinnedReport.codex_install_identity.pin_phase, 'unpinned');
    ok(!unpinnedReport.host_parity.issues.some((issue) => issue.id.startsWith('codex_install_') || issue.id.startsWith('codex_catalog_pin_')));
    match(formatText(unpinnedReport), /pin-phase=unpinned \(before activation: currentness unknown, not stale\)/);
  });

  it('reports a malformed pin and a mixed catalog as errors, not as a fallback', async () => {
    const { clone, c1 } = await buildClone();
    await writeCatalog(clone, [
      pinned('runtime', '0.1.0', 'not-a-sha'),
      { name: 'engineer', source: { source: 'local', path: './plugins/engineer' } },
    ]);
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-identity-codex-'));
    await install(clone, c1, codexHome, '0.1.0');
    const report = await doctorFor({ clone, codexHome, listVersion: '0.1.0' });
    strictEqual(report.codex_install_identity.pin_phase, 'mixed');
    ok(report.host_parity.issues.some((issue) => issue.id === 'codex_catalog_pin_mixed'));
    ok(report.host_parity.issues.some((issue) => issue.id === 'codex_catalog_pin_invalid' && issue.plugin === 'runtime'));
    strictEqual(report.plugins.runtime.codex_install.currentness, 'unknown');
  });
});
