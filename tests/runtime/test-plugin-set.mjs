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
  it('carries the two verified floors and null elsewhere — runtime\'s included', async () => {
    const set = await loadPluginSet();
    assert.equal(set.plugins.companions.minimum_version, '0.3.0');
    assert.equal(set.plugins.engineer.minimum_version, '0.7.0');
    // ⚠ RUNTIME'S FLOOR RETURNED TO `null` (ADR-0056 §Decision 4), and this
    // assertion moved BACK rather than being deleted. ADR-0054 §Decision 5 had
    // set it to `0.91.0` — the first version able to read the compatibility
    // assurance record — with the message "no documented incompatibility" no
    // longer true. With no record to read, that floor guards nothing, and
    // leaving it would assert an incompatibility that does not exist.
    //
    // ⚠ THE ST5 LOWER-BOUND ASSERTION IS GONE WITH IT. A separate test pinned
    // "the packaged floor may never fall below `0.91.0`, the first released
    // reader"; that rule was about irreversibility of an assurance policy value,
    // and applying it to a `null` floor would have made this removal
    // unimplementable by a test rather than by a decision.
    assert.equal(set.plugins.runtime.minimum_version, null);
    const floored = new Set(['companions', 'engineer']);
    for (const name of Object.keys(set.plugins)) {
      if (floored.has(name)) continue;
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

// The other half of §11.1's "assert the prose tables in §9 and §6 agree with
// plugin-set.json and the step registry". §6 is pinned in test-step-registry.mjs;
// §9's table said "§11 pins that the two agree" while nothing did — so the bundle
// membership a reader sees could drift from the membership the code resolves, with CI
// green the whole way. Added in S8a2 C4.
describe('plugin set — the §9 bundle table agrees with the packaged data (§11.1)', () => {
  const CONTRACT = resolve(REPO_ROOT, 'plugins/runtime/docs/machine-bootstrap-contract.md');
  const NUMBER_WORDS = { five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10 };

  async function parseBundleTable() {
    const doc = await readFile(CONTRACT, 'utf8');
    const start = doc.indexOf('## 9. Bundle membership');
    const end = doc.indexOf('### 9.1 Dependency closure');
    if (start < 0 || end < 0 || end <= start) throw new Error('could not locate the §9 bundle table');
    const rows = [...doc.slice(start, end).matchAll(/^\|\s*`([a-z]+)`\s*\|\s*(.+?)\s*\|$/gm)]
      .map(([, bundle, members]) => ({ bundle, members: members.trim() }))
      .filter((r) => r.bundle !== 'Bundle');
    // A parse that silently matched nothing would pass every assertion below.
    if (rows.length < 6) throw new Error(`§9 table parsed only ${rows.length} rows — the parser has drifted from the table`);
    return rows;
  }

  it('every named bundle resolves to exactly the plugins the table lists', async () => {
    const pluginSet = await loadPluginSet();
    const rows = await parseBundleTable();
    const all = Object.keys(pluginSet.plugins).sort();
    let checked = 0;

    for (const row of rows) {
      if (row.bundle === 'custom') {
        assert.ok(/operator-enumerated/.test(row.members), 'custom is operator-enumerated, not a fixed membership');
        assert.ok(!BUNDLE_NAMES.includes('custom'), 'and so it is not a plugin-set bundle');
        continue;
      }
      assert.ok(BUNDLE_NAMES.includes(row.bundle), `${row.bundle} is a known bundle`);

      // "all eight" — the COUNT WORD is load-bearing: adding a ninth plugin without
      // touching the prose leaves the document saying something false.
      let expected;
      const allMatch = /^all (\w+)$/.exec(row.members);
      if (allMatch) {
        const stated = NUMBER_WORDS[allMatch[1]];
        assert.ok(stated !== undefined, `the table's count word "${allMatch[1]}" is one this test knows`);
        assert.equal(stated, all.length, `§9 says "all ${allMatch[1]}" but the plugin-set carries ${all.length} plugins`);
        expected = all;
      } else {
        const names = [...row.members.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]);
        // "`base` + `engineer`, `orchestrator`" — a bundle name inside the cell means
        // that bundle's membership, unioned with the rest.
        const expanded = names.flatMap((n) => (BUNDLE_NAMES.includes(n) ? resolveBundle(pluginSet, n) : [n]));
        expected = [...new Set(expanded)].sort();
      }

      assert.deepEqual(resolveBundle(pluginSet, row.bundle), expected, `§9's ${row.bundle} row disagrees with plugin-set.json`);
      checked += 1;
    }
    assert.ok(checked >= 5, `compared ${checked} documented bundles against the data`);
  });

  it('the table names every bundle the data defines, and vice versa', async () => {
    const rows = await parseBundleTable();
    const documented = rows.map((r) => r.bundle).filter((b) => b !== 'custom').sort();
    assert.deepEqual(documented, [...BUNDLE_NAMES].sort(), 'the §9 table and BUNDLE_NAMES enumerate the same bundles');
  });
});
