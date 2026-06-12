// plugins/founder plugin-shape conformance test (ADR-0036 PR1 scaffold).
//
// PR1 ships an intentionally inert scaffold: host manifests + README +
// CHANGELOG + catalog/release wiring only. The "PR1 negative boundary"
// suite asserts that NO functional surface exists yet. Those assertions
// are PR1-ONLY by design: the first PR that lands a functional surface
// (ADR-0036 roadmap PR2+) MUST revise that suite alongside the new
// directories/keys it introduces.
//
// Expected RED causes before the scaffold lands: (1) plugins/founder
// files missing; (2) package.json test:plugin-shape wiring missing.
//
// Run via `node --test tests/plugin-shape/test-founder-plugin.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const PLUGIN_ROOT = resolve(REPO_ROOT, 'plugins/founder');

const INCUBATING_MARKER = /incubating scaffold/i;

async function readJSON(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('plugins/founder — Claude manifest (.claude-plugin/plugin.json)', () => {
  const path = resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json');

  it('parses as JSON with required scalar fields', async () => {
    const json = await readJSON(path);
    strictEqual(json.name, 'founder');
    strictEqual(typeof json.version, 'string');
    ok(/^\d+\.\d+\.\d+/.test(json.version), `version "${json.version}" not SemVer-shaped`);
    strictEqual(typeof json.description, 'string');
    ok(json.description.length > 0);
  });

  it('carries the incubating marker in its description (PR1 honesty contract)', async () => {
    const json = await readJSON(path);
    ok(INCUBATING_MARKER.test(json.description),
      'Claude manifest description must state the scaffold is incubating until ADR-0036 PR3+ land');
  });

  it('carries publishing metadata consistent with sibling plugins', async () => {
    const json = await readJSON(path);
    strictEqual(json.license, 'MIT');
    strictEqual(json.author?.name, 'each4all');
    strictEqual(typeof json.homepage, 'string');
    strictEqual(typeof json.repository, 'string');
    ok(Array.isArray(json.keywords) && json.keywords.length > 0);
  });
});

describe('plugins/founder — Codex manifest (.codex-plugin/plugin.json)', () => {
  const path = resolve(PLUGIN_ROOT, '.codex-plugin/plugin.json');

  it('parses as JSON with required scalar fields matching the Claude manifest', async () => {
    const json = await readJSON(path);
    const claude = await readJSON(resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json'));
    strictEqual(json.name, 'founder');
    strictEqual(json.version, claude.version, 'host manifests must carry the same version');
    strictEqual(typeof json.description, 'string');
    ok(INCUBATING_MARKER.test(json.description),
      'Codex manifest description must state the scaffold is incubating');
  });

  it('declares no functional surface keys in PR1 (negative boundary — PR1-ONLY)', async () => {
    const json = await readJSON(path);
    strictEqual(json.skills, undefined, 'PR1 must not declare a skills path (no skills exist yet)');
    strictEqual(json.hooks, undefined, 'PR1 must not declare hooks (none exist yet)');
    strictEqual(json.interface, undefined, 'PR1 must not declare an interface block');
  });
});

describe('plugins/founder — PR1 negative boundary (no functional surface; PR1-ONLY suite)', () => {
  const ABSENT_DIRS = [
    'commands',
    'skills',
    'scripts',
    'hooks',
    'adapters',
    'personas',
    'mcp-servers',
    'prompt-templates',
  ];

  for (const dir of ABSENT_DIRS) {
    it(`has no ${dir}/ directory in the inert scaffold`, async () => {
      strictEqual(await exists(resolve(PLUGIN_ROOT, dir)), false,
        `plugins/founder/${dir}/ must not exist in PR1 — it lands in ADR-0036 roadmap PR2+ and this suite must be revised then`);
    });
  }

  it('ships README.md with the incubating marker and the ADR-0036 pointer', async () => {
    const readme = await readFile(resolve(PLUGIN_ROOT, 'README.md'), 'utf8');
    ok(INCUBATING_MARKER.test(readme), 'plugin README must call out incubating status');
    ok(readme.includes('ADR-0036'), 'plugin README must point at ADR-0036');
  });

  it('ships CHANGELOG.md with the initial scaffold seed entry', async () => {
    const changelog = await readFile(resolve(PLUGIN_ROOT, 'CHANGELOG.md'), 'utf8');
    ok(changelog.includes('0.1.0 (initial scaffold seed)'),
      'CHANGELOG must record the seed entry without implying a published tag');
  });
});

describe('plugins/founder — Claude marketplace catalog entry', () => {
  const path = resolve(REPO_ROOT, '.claude-plugin/marketplace.json');

  it('exists with source/version/category/description aligned to the plugin', async () => {
    const catalog = await readJSON(path);
    const entry = catalog.plugins.find((p) => p.name === 'founder');
    ok(entry, 'Claude catalog must list founder');
    strictEqual(entry.source, './plugins/founder',
      'validate-marketplace does not check the Claude source path — this test covers that gap');
    const manifest = await readJSON(resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json'));
    strictEqual(entry.version, manifest.version);
    strictEqual(entry.category, 'Productivity');
    ok(INCUBATING_MARKER.test(entry.description),
      'Claude catalog description must carry the incubating marker');
  });
});

describe('plugins/founder — Codex marketplace catalog entry', () => {
  const path = resolve(REPO_ROOT, '.agents/plugins/marketplace.json');

  it('exists with the local-source/policy/category shape (no per-entry description in the Codex schema)', async () => {
    const catalog = await readJSON(path);
    const entry = catalog.plugins.find((p) => p.name === 'founder');
    ok(entry, 'Codex catalog must list founder');
    deepStrictEqual(entry.source, { source: 'local', path: './plugins/founder' });
    deepStrictEqual(entry.policy, { installation: 'AVAILABLE', authentication: 'ON_USE' });
    strictEqual(entry.category, 'Productivity');
    strictEqual(await exists(resolve(REPO_ROOT, entry.source.path)), true,
      'Codex source.path must resolve to the plugin directory');
  });
});

describe('plugins/founder — release-please wiring', () => {
  it('is tracked in .release-please-manifest.json at the manifest version', async () => {
    const manifest = await readJSON(resolve(REPO_ROOT, '.release-please-manifest.json'));
    const plugin = await readJSON(resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json'));
    strictEqual(manifest['plugins/founder'], plugin.version);
  });

  it('has a plugin-founder package block with both manifest extra-files', async () => {
    const config = await readJSON(resolve(REPO_ROOT, 'release-please-config.json'));
    const pkg = config.packages?.['plugins/founder'];
    ok(pkg, 'release-please-config.json must declare the plugins/founder package');
    strictEqual(pkg['package-name'], 'plugin-founder');
    strictEqual(pkg.component, 'plugin-founder');
    strictEqual(pkg['changelog-path'], 'CHANGELOG.md');
    const extraPaths = (pkg['extra-files'] ?? []).map((f) => f.path).sort();
    deepStrictEqual(extraPaths, ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json']);
    for (const f of pkg['extra-files']) {
      strictEqual(f.type, 'json');
      strictEqual(f.jsonpath, '$.version');
    }
  });
});

describe('plugins/founder — repo wiring (self-guard)', () => {
  it('is wired into the explicit package.json test:plugin-shape file list', async () => {
    const pkg = await readJSON(resolve(REPO_ROOT, 'package.json'));
    ok(pkg.scripts['test:plugin-shape'].includes('tests/plugin-shape/test-founder-plugin.mjs'),
      'host CI workflows run the explicit test:plugin-shape list — this file must be wired in');
  });
});
