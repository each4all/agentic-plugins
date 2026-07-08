// plugins/designer plugin-shape conformance test (ADR-0042).
//
// Boundary history (this test EVOLVES with the implementation ladder,
// following the plugins/founder precedent — see test-founder-plugin.mjs):
//   - PR1 (this revision) ships the fully-INERT atomic scaffold: dual host
//     manifests + README + CHANGELOG + both marketplace catalog entries +
//     release-please wiring + package.json test-suite wiring. Every
//     functional directory is ABSENT, and the manifests + README carry the
//     `incubating scaffold` marker. The assertions below are written for
//     that state — the incubating-marker checks assert PRESENCE (they flip
//     to ABSENCE at PR7 when ADR-0042 is Accepted), and the
//     forbidden-surface suite asserts every functional dir is absent.
//   - PR2 will land scripts/ + hooks/ + adapters/ (machinery), exposing the
//     Codex manifest hooks key; the forbidden-dir list shrinks accordingly.
//   - PR3–PR6 land commands/ + skills/ (the six verb surfaces + start macro
//     + meta skills) and the Codex manifest skills + interface keys.
//   - PR7 de-incubates: the incubating marker is removed from the manifests
//     + README, and these PRESENCE assertions flip to ABSENCE.
//
// Run via `node --test tests/plugin-shape/test-designer-plugin.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const PLUGIN_ROOT = resolve(REPO_ROOT, 'plugins/designer');

// ADR-0042 is Proposed; the persona is incubating until the PR7 dogfood
// flips it to Accepted. Until then the user-facing surfaces MUST carry
// this marker so the scaffold never reads as a shipped persona. At PR7
// these assertions flip from "must carry" to "must NOT carry" (founder
// precedent).
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

describe('plugins/designer — Claude manifest (.claude-plugin/plugin.json)', () => {
  const path = resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json');

  it('parses as JSON with required scalar fields', async () => {
    const json = await readJSON(path);
    strictEqual(json.name, 'designer');
    strictEqual(typeof json.version, 'string');
    ok(/^\d+\.\d+\.\d+/.test(json.version), `version "${json.version}" not SemVer-shaped`);
    strictEqual(typeof json.description, 'string');
    ok(json.description.length > 0);
  });

  it('carries the incubating marker (ADR-0042 Proposed — removed at PR7)', async () => {
    const json = await readJSON(path);
    ok(INCUBATING_MARKER.test(json.description),
      'Claude manifest description must carry the incubating marker until ADR-0042 is Accepted at PR7');
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

describe('plugins/designer — Codex manifest (.codex-plugin/plugin.json)', () => {
  const path = resolve(PLUGIN_ROOT, '.codex-plugin/plugin.json');

  it('parses as JSON with required scalar fields matching the Claude manifest', async () => {
    const json = await readJSON(path);
    const claude = await readJSON(resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json'));
    strictEqual(json.name, 'designer');
    strictEqual(json.version, claude.version, 'host manifests must carry the same version');
    strictEqual(typeof json.description, 'string');
    ok(INCUBATING_MARKER.test(json.description),
      'Codex manifest description must carry the incubating marker until ADR-0042 is Accepted at PR7');
  });

  it('does NOT yet declare hooks / skills / interface (PR1 inert scaffold — they land at PR2/PR3)', async () => {
    const json = await readJSON(path);
    ok(!('hooks' in json), 'PR1 scaffold has no machinery — the Codex manifest hooks key lands at PR2');
    ok(!('skills' in json), 'PR1 scaffold has no verb surfaces — the Codex manifest skills key lands at PR3');
    ok(!('interface' in json), 'PR1 scaffold has no verb surfaces — the Codex manifest interface block lands at PR3');
  });
});

describe('plugins/designer — inert scaffold (PR1: every functional directory absent)', () => {
  // The PR1 scaffold is deliberately inert — no machinery, no verb surfaces.
  // Each of these becomes REQUIRED (and drops from this list) at the PR that
  // lands it, per the boundary history at the top of this file.
  const FORBIDDEN_DIRS = [
    'scripts',
    'hooks',
    'adapters',
    'commands',
    'skills',
    'personas',
    'mcp-servers',
    'prompt-templates',
  ];

  for (const dir of FORBIDDEN_DIRS) {
    it(`has no ${dir}/ directory (inert scaffold — lands in a later PR)`, async () => {
      strictEqual(await exists(resolve(PLUGIN_ROOT, dir)), false,
        `plugins/designer/${dir}/ must not exist in the PR1 inert scaffold`);
    });
  }

  it('ships README.md carrying the incubating marker AND the ADR-0042 pointer', async () => {
    const readme = await readFile(resolve(PLUGIN_ROOT, 'README.md'), 'utf8');
    ok(INCUBATING_MARKER.test(readme),
      'plugin README must carry the incubating marker until ADR-0042 is Accepted at PR7');
    ok(/ADR-0042/.test(readme), 'plugin README must point at ADR-0042');
  });

  it('ships CHANGELOG.md with the initial scaffold seed entry', async () => {
    const changelog = await readFile(resolve(PLUGIN_ROOT, 'CHANGELOG.md'), 'utf8');
    ok(/scaffold seed/i.test(changelog), 'CHANGELOG.md must carry the initial scaffold seed entry');
  });
});

describe('plugins/designer — marketplace catalog wiring (both hosts)', () => {
  it('the Claude catalog carries a designer entry resolving to the plugin dir at version 0.1.0', async () => {
    const catalog = await readJSON(resolve(REPO_ROOT, '.claude-plugin/marketplace.json'));
    const entry = catalog.plugins.find((p) => p.name === 'designer');
    ok(entry, 'designer must appear in .claude-plugin/marketplace.json');
    strictEqual(entry.source, './plugins/designer');
    const manifest = await readJSON(resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json'));
    strictEqual(entry.version, manifest.version,
      'Claude catalog entry version must match the manifest version');
  });

  it('the Codex catalog carries a designer entry resolving to the plugin dir', async () => {
    const catalog = await readJSON(resolve(REPO_ROOT, '.agents/plugins/marketplace.json'));
    const entry = catalog.plugins.find((p) => p.name === 'designer');
    ok(entry, 'designer must appear in .agents/plugins/marketplace.json');
    strictEqual(entry.source?.path, './plugins/designer');
  });
});

describe('plugins/designer — release-please + test-suite wiring', () => {
  it('release-please-config.json declares the plugins/designer package with both-manifest extra-files', async () => {
    const config = await readJSON(resolve(REPO_ROOT, 'release-please-config.json'));
    const pkg = config.packages['plugins/designer'];
    ok(pkg, 'release-please-config.json must declare the plugins/designer package');
    strictEqual(pkg['package-name'], 'plugin-designer');
    const paths = (pkg['extra-files'] || []).map((f) => f.path);
    ok(paths.includes('.claude-plugin/plugin.json'), 'extra-files must bump the Claude manifest version');
    ok(paths.includes('.codex-plugin/plugin.json'), 'extra-files must bump the Codex manifest version');
  });

  it('.release-please-manifest.json seeds plugins/designer at 0.1.0', async () => {
    const manifest = await readJSON(resolve(REPO_ROOT, '.release-please-manifest.json'));
    strictEqual(manifest['plugins/designer'], '0.1.0');
  });

  it('package.json wires the designer shape test into test:plugin-shape', async () => {
    const pkg = await readJSON(resolve(REPO_ROOT, 'package.json'));
    ok(/tests\/plugin-shape\/test-designer-plugin\.mjs/.test(pkg.scripts['test:plugin-shape']),
      'test:plugin-shape must run tests/plugin-shape/test-designer-plugin.mjs');
  });
});
