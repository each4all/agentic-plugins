// plugins/founder plugin-shape conformance test (ADR-0036 — revised at
// PR2, the workflow-machinery copy-trim).
//
// Boundary history: PR1 shipped the fully-inert scaffold (manifests +
// README + CHANGELOG + wiring only, every functional directory absent).
// PR2 lands scripts/ + hooks/ + adapters/ (now REQUIRED below, with the
// Codex manifest hooks key exposed at the same time) while commands/ and
// skills/ remain forbidden. The next surface PR (ADR-0036 PR3:
// investigate + frame) MUST revise the boundary suite again.
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

  it('declares hooks but no skills/interface keys (PR2 boundary — revise in PR3 when skills land)', async () => {
    const json = await readJSON(path);
    strictEqual(json.hooks, './adapters/codex/hooks/hooks.json',
      'PR2 ships the workflow machinery hooks and must expose them in the Codex manifest at the same time (drift defense)');
    strictEqual(json.skills, undefined, 'no skills path until ADR-0036 PR3 lands the first SKILL.md');
    strictEqual(json.interface, undefined, 'no interface block until a skill surface exists');
  });
});

// Negative-boundary suite — REVISED FOR PR2 (machinery landed: scripts/,
// hooks/, adapters/ now REQUIRED; commands/ and skills/ remain forbidden
// until ADR-0036 PR3). The next surface PR (PR3: investigate + frame)
// MUST revise this suite again.
describe('plugins/founder — PR2 boundary (machinery present, no verb surface)', () => {
  const ABSENT_DIRS = [
    'commands',
    'skills',
    'personas',
    'mcp-servers',
    'prompt-templates',
  ];

  for (const dir of ABSENT_DIRS) {
    it(`has no ${dir}/ directory before the verb surface lands`, async () => {
      strictEqual(await exists(resolve(PLUGIN_ROOT, dir)), false,
        `plugins/founder/${dir}/ must not exist until ADR-0036 PR3+ lands it — revise this suite in that PR`);
    });
  }

  const REQUIRED_MACHINERY = [
    'scripts/state.mjs',
    'scripts/stop-archive.mjs',
    'scripts/validate-commit.mjs',
    'scripts/dispatch-peer.mjs',
    'scripts/peer-runner.mjs',
    'scripts/session-handoff.mjs',
    'hooks/hooks.json',
    'adapters/claude/hooks/_shared.mjs',
    'adapters/claude/hooks/session-start.mjs',
    'adapters/claude/hooks/pre-compact.mjs',
    'adapters/claude/hooks/stop.mjs',
    'adapters/codex/hooks/hooks.json',
    'adapters/codex/hooks/session-start.mjs',
    'adapters/codex/hooks/pre-compact.mjs',
    'adapters/codex/hooks/stop.mjs',
    'adapters/codex/hooks/run-node-hook.sh',
  ];

  for (const rel of REQUIRED_MACHINERY) {
    it(`ships ${rel} (PR2 machinery)`, async () => {
      strictEqual(await exists(resolve(PLUGIN_ROOT, rel)), true,
        `plugins/founder/${rel} is part of the PR2 machinery copy-trim and must exist`);
    });
  }

  it('hook entrypoints carry the executable bit', async () => {
    const HOOK_EXECUTABLES = [
      'adapters/claude/hooks/session-start.mjs',
      'adapters/claude/hooks/pre-compact.mjs',
      'adapters/claude/hooks/stop.mjs',
      'adapters/codex/hooks/session-start.mjs',
      'adapters/codex/hooks/pre-compact.mjs',
      'adapters/codex/hooks/stop.mjs',
      'adapters/codex/hooks/run-node-hook.sh',
    ];
    for (const rel of HOOK_EXECUTABLES) {
      const st = await stat(resolve(PLUGIN_ROOT, rel));
      ok(st.mode & 0o100, `${rel} must be executable (owner x bit)`);
    }
  });

  it('guards the no-parent-linkage contract: machinery never references parent-writeback (ADR-0036 Non-Goal 3)', async () => {
    const SOURCES = [
      'scripts/state.mjs',
      'scripts/stop-archive.mjs',
      'adapters/claude/hooks/_shared.mjs',
      'adapters/claude/hooks/stop.mjs',
      'adapters/codex/hooks/stop.mjs',
    ];
    for (const rel of SOURCES) {
      const text = await readFile(resolve(PLUGIN_ROOT, rel), 'utf8');
      ok(!text.includes("from './parent-writeback.mjs'"),
        `${rel} must not import parent-writeback machinery`);
      ok(!/writebackParent\s*\(/.test(text),
        `${rel} must not invoke writebackParent`);
    }
    strictEqual(await exists(resolve(PLUGIN_ROOT, 'scripts/parent-writeback.mjs')), false,
      'plugins/founder must not ship a parent-writeback module at all');
  });

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
