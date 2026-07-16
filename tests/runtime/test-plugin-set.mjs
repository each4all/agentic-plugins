// tests/runtime/test-plugin-set.mjs — S8a2 C1.
//
// Executable agreement (machine-bootstrap-contract §11.1): the packaged
// plugin-set is validated as real data AND asserted against the other
// authorities it must not silently drift from — PLUGIN_NAMES, the canonical
// marketplace, both marketplace catalogs, and the plugins' own hook manifests.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import {
  loadPluginSet,
  validatePluginSet,
  resolveBundle,
  hardClosureViolations,
  assertPluginSetAuthority,
  BUNDLE_NAMES,
  MANDATORY_PLUGINS,
} from '../../plugins/runtime/scripts/lib/plugin-set.mjs';
import { PLUGIN_NAMES, CANONICAL_MARKETPLACE } from '../../plugins/runtime/scripts/lib/machine-probe.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

// Effective host hook registration (contract §1.4 dual-source rule, mirrored
// from kit/lint + doctor bundled_plugins): a manifest-declared `hooks` path OR
// the host's default-discovery of the root hooks/hooks.json.
async function effectiveHookBearing(name) {
  const root = join(REPO_ROOT, 'plugins', name);
  const claudeManifest = existsSync(join(root, '.claude-plugin', 'plugin.json'))
    ? await readJson(join(root, '.claude-plugin', 'plugin.json')) : {};
  const codexManifest = existsSync(join(root, '.codex-plugin', 'plugin.json'))
    ? await readJson(join(root, '.codex-plugin', 'plugin.json')) : {};
  const rootHooks = existsSync(join(root, 'hooks', 'hooks.json'));
  return {
    claude: (claudeManifest.hooks != null) || rootHooks,
    codex: (codexManifest.hooks != null) || rootHooks,
  };
}

describe('plugin-set — packaged definition', () => {
  it('loads and passes semantic validation', async () => {
    const set = await loadPluginSet();
    const { ok, errors } = validatePluginSet(set);
    assert.equal(ok, true, `validation errors: ${errors.join(' | ')}`);
  });

  it('names and canonical marketplace equal the probe authority (no third source)', async () => {
    const set = await loadPluginSet();
    const { ok, errors } = assertPluginSetAuthority(set, {
      pluginNames: PLUGIN_NAMES,
      canonicalMarketplace: CANONICAL_MARKETPLACE,
    });
    assert.equal(ok, true, errors.join(' | '));
  });
});

describe('plugin-set — bundle membership', () => {
  it('`full` equals every plugin; base is a subset of every higher bundle', async () => {
    const set = await loadPluginSet();
    assert.deepEqual(resolveBundle(set, 'full'), [...PLUGIN_NAMES].sort());
    const base = new Set(resolveBundle(set, 'base'));
    for (const bundle of ['engineering', 'business', 'design', 'full']) {
      const members = new Set(resolveBundle(set, bundle));
      for (const b of base) assert.ok(members.has(b), `base plugin ${b} missing from ${bundle}`);
    }
  });

  it('runtime + companions are in every named bundle (mandatory)', async () => {
    const set = await loadPluginSet();
    for (const bundle of BUNDLE_NAMES) {
      const members = new Set(resolveBundle(set, bundle));
      for (const m of MANDATORY_PLUGINS) assert.ok(members.has(m), `${m} missing from ${bundle}`);
    }
  });

  it('matches the §9 bundle table exactly', async () => {
    const set = await loadPluginSet();
    assert.deepEqual(resolveBundle(set, 'base'), ['attention', 'companions', 'runtime']);
    assert.deepEqual(resolveBundle(set, 'engineering'), ['attention', 'companions', 'engineer', 'orchestrator', 'runtime']);
    assert.deepEqual(resolveBundle(set, 'business'), ['attention', 'companions', 'founder', 'runtime']);
    assert.deepEqual(resolveBundle(set, 'design'), ['attention', 'companions', 'designer', 'image', 'runtime']);
  });

  it('every named bundle is hard-closed (engineering carries engineer for orchestrator)', async () => {
    const set = await loadPluginSet();
    for (const bundle of BUNDLE_NAMES) {
      const members = resolveBundle(set, bundle);
      assert.deepEqual(hardClosureViolations(set, members), [], `bundle ${bundle} not hard-closed`);
    }
    // orchestrator's hard edge is visible in the engineering bundle.
    assert.ok(resolveBundle(set, 'engineering').includes('engineer'));
  });
});

describe('plugin-set — catalog consistency (#20)', () => {
  it('plugin names match BOTH marketplace catalogs (source membership, not Codex versions)', async () => {
    const set = await loadPluginSet();
    const setNames = Object.keys(set.plugins).sort();

    const claudeCatalog = await readJson(join(REPO_ROOT, '.claude-plugin', 'marketplace.json'));
    const codexCatalog = await readJson(join(REPO_ROOT, '.agents', 'plugins', 'marketplace.json'));
    const claudeNames = (claudeCatalog.plugins ?? []).map((p) => p.name).sort();
    const codexNames = (codexCatalog.plugins ?? []).map((p) => p.name).sort();

    assert.deepEqual(setNames, claudeNames, 'plugin-set vs Claude catalog names');
    assert.deepEqual(setNames, codexNames, 'plugin-set vs Codex catalog names');
    assert.deepEqual(setNames, [...PLUGIN_NAMES].sort(), 'plugin-set vs PLUGIN_NAMES');
  });
});

describe('plugin-set — hook_bearing equals effective registration (TESTED mandate)', () => {
  it('every plugin hook_bearing matches its manifests + root hooks.json', async () => {
    const set = await loadPluginSet();
    for (const name of Object.keys(set.plugins)) {
      const effective = await effectiveHookBearing(name);
      assert.deepEqual(
        set.plugins[name].hook_bearing,
        effective,
        `${name} hook_bearing drift: declared ${JSON.stringify(set.plugins[name].hook_bearing)} vs effective ${JSON.stringify(effective)}`,
      );
    }
  });

  it('the contract correction holds: personas are Codex-hook-bearing, attention is Claude-only', async () => {
    const set = await loadPluginSet();
    for (const persona of ['engineer', 'orchestrator', 'founder', 'designer']) {
      assert.equal(set.plugins[persona].hook_bearing.codex, true, `${persona} must be Codex-hook-bearing`);
      assert.equal(set.plugins[persona].hook_bearing.claude, true, `${persona} must be Claude-hook-bearing (root hooks.json)`);
    }
    assert.equal(set.plugins.attention.hook_bearing.claude, true);
    assert.equal(set.plugins.attention.hook_bearing.codex, false);
    for (const none of ['runtime', 'companions', 'image']) {
      assert.deepEqual(set.plugins[none].hook_bearing, { claude: false, codex: false });
    }
  });
});

describe('plugin-set — floors + edges', () => {
  it('carries the two verified floors and null elsewhere', async () => {
    const set = await loadPluginSet();
    assert.equal(set.plugins.companions.minimum_version, '0.3.0');
    assert.equal(set.plugins.engineer.minimum_version, '0.7.0');
    for (const name of Object.keys(set.plugins)) {
      if (name === 'companions' || name === 'engineer') continue;
      assert.equal(set.plugins[name].minimum_version, null, `${name} floor should be null (no documented incompatibility)`);
    }
  });

  it('image -> companions is hard on Claude only; orchestrator -> engineer is hard on both', async () => {
    const set = await loadPluginSet();
    assert.deepEqual(set.plugins.image.hard_requires, [{ name: 'companions', hosts: ['claude'] }]);
    assert.deepEqual(set.plugins.orchestrator.hard_requires, [{ name: 'engineer', hosts: ['claude', 'codex'] }]);
  });
});

describe('plugin-set — hard closure of custom selections (§9.1)', () => {
  it('flags a custom selection that omits a hard dependency', async () => {
    const set = await loadPluginSet();
    // orchestrator without engineer — hard on both hosts.
    const v1 = hardClosureViolations(set, ['runtime', 'companions', 'orchestrator']);
    assert.ok(v1.some((v) => v.plugin === 'orchestrator' && v.requires === 'engineer'), JSON.stringify(v1));
    // image (Claude) without companions — hard on Claude only.
    const v2 = hardClosureViolations(set, ['runtime', 'companions', 'image']);
    assert.deepEqual(v2, [], 'image + companions is closed');
    const v3 = hardClosureViolations(set, ['runtime', 'image']);
    assert.ok(v3.some((v) => v.plugin === 'image' && v.requires === 'companions' && v.host === 'claude'), JSON.stringify(v3));
  });
});

describe('plugin-set — validator rejects malformed definitions', () => {
  // A VALID minimal fixture (3 plugins in all 5 bundles) so injecting one fault
  // isolates it rather than tripping the missing-bundle checks.
  const ALL_BUNDLES = ['base', 'engineering', 'business', 'design', 'full'];
  const base = () => ({
    schema: 'runtime-plugin-set-1.0',
    canonical_marketplace: { source: 'github', repo: 'each4all/agentic-plugins' },
    plugins: {
      runtime: { bundles: [...ALL_BUNDLES], hosts: ['claude', 'codex'], hard_requires: [], soft_requires: [], hook_bearing: { claude: false, codex: false }, minimum_version: null },
      companions: { bundles: [...ALL_BUNDLES], hosts: ['claude', 'codex'], hard_requires: [], soft_requires: [], hook_bearing: { claude: false, codex: false }, minimum_version: null },
      attention: { bundles: [...ALL_BUNDLES], hosts: ['claude', 'codex'], hard_requires: [], soft_requires: [], hook_bearing: { claude: true, codex: false }, minimum_version: null },
    },
  });

  it('the base fixture itself is valid (so fault injection is isolated)', () => {
    assert.equal(validatePluginSet(base()).ok, true);
  });

  it('rejects an unknown edge target', () => {
    const set = base();
    set.plugins.attention.hard_requires = [{ name: 'ghost', hosts: ['claude'] }];
    assert.equal(validatePluginSet(set).ok, false);
  });

  it('rejects an edge requiring on a host the plugin does not target', () => {
    const set = base();
    set.plugins.attention.hosts = ['claude'];
    set.plugins.attention.hard_requires = [{ name: 'runtime', hosts: ['codex'] }];
    assert.equal(validatePluginSet(set).ok, false);
  });

  it('rejects a hard-edge cycle', () => {
    const set = base();
    set.plugins.attention.hard_requires = [{ name: 'runtime', hosts: ['claude'] }];
    set.plugins.runtime.hard_requires = [{ name: 'attention', hosts: ['claude'] }];
    const { ok, errors } = validatePluginSet(set);
    assert.equal(ok, false);
    assert.ok(errors.some((e) => /cycle/i.test(e)), errors.join(' | '));
  });

  it('rejects a bundle missing a mandatory plugin', () => {
    const set = base();
    set.plugins.companions.bundles = []; // companions no longer in base
    const { ok, errors } = validatePluginSet(set);
    assert.equal(ok, false);
    assert.ok(errors.some((e) => /mandatory/i.test(e)), errors.join(' | '));
  });

  it('rejects a non-semver floor', () => {
    const set = base();
    set.plugins.runtime.minimum_version = 'latest';
    assert.equal(validatePluginSet(set).ok, false);
  });

  it('rejects a bad canonical marketplace', () => {
    const set = base();
    set.canonical_marketplace = { source: 'github', repo: 'each4all/agentic-plugins-fork' };
    assert.equal(validatePluginSet(set).ok, false);
  });
});
