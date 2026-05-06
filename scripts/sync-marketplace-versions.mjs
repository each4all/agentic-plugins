#!/usr/bin/env node
// Syncs Claude marketplace catalog plugin versions to match
// .release-please-manifest.json. Idempotent — safe to run any number of
// times; exit 0 with no changes when already in sync.
//
// Why: release-please's per-package extra-files mechanism cannot safely
// own the root marketplace.json without inadvertently coupling all
// plugin packages to commits that touch the root catalog (e.g., a
// chore commit that removes one plugin's entry would otherwise version-
// bump every other plugin via the shared extra-file). The trade-off
// chosen in this repo: release-please owns each plugin's per-package
// manifests (.claude-plugin/plugin.json + .codex-plugin/plugin.json),
// and this script syncs the root catalog separately, post-release.
//
// Source of truth: .release-please-manifest.json
// Targets:
//   - .claude-plugin/marketplace.json $.plugins[?(name)] .version
// Codex catalog (.agents/plugins/marketplace.json) has no per-entry
// version field, so it is intentionally not synced here.
//
// Usage:
//   node scripts/sync-marketplace-versions.mjs            # apply
//   node scripts/sync-marketplace-versions.mjs --check    # dry-run
//
// Exit codes:
//   0 — sync succeeded (no diffs OR diffs applied)
//   1 — read/parse error, or --check found diffs

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MANIFEST_PATH = '.release-please-manifest.json';
const CLAUDE_MARKETPLACE_PATH = '.claude-plugin/marketplace.json';

/**
 * Sync the Claude marketplace catalog plugin versions to the
 * release-please manifest. Pure function over the filesystem rooted at
 * `repoRoot` so tests can drive it against a temp directory.
 *
 * @param {string} repoRoot — Absolute path to the repository root.
 * @param {{checkOnly?: boolean}} [options]
 * @returns {{diffs: Array<{name: string, from: string, to: string}>, written: boolean}}
 */
export function syncCatalogToManifest(repoRoot, { checkOnly = false } = {}) {
  const manifestPath = resolve(repoRoot, MANIFEST_PATH);
  const catalogPath = resolve(repoRoot, CLAUDE_MARKETPLACE_PATH);

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const entries = catalog.plugins ?? [];
  const diffs = [];

  for (const [pkgPath, expectedVersion] of Object.entries(manifest)) {
    if (!pkgPath.startsWith('plugins/')) continue;
    const pluginName = pkgPath.replace(/^plugins\//, '');
    const entry = entries.find((p) => p.name === pluginName);
    if (!entry) continue;
    if (entry.version !== expectedVersion) {
      diffs.push({ name: pluginName, from: entry.version, to: expectedVersion });
      entry.version = expectedVersion;
    }
  }

  const written = diffs.length > 0 && !checkOnly;
  if (written) {
    writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n');
  }
  return { diffs, written };
}

// CLI entry — only runs when invoked as `node scripts/sync-marketplace-versions.mjs`.
const invokedAsCLI = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (invokedAsCLI) {
  const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../..');
  const checkOnly = process.argv.includes('--check');

  try {
    const { diffs } = syncCatalogToManifest(REPO_ROOT, { checkOnly });

    if (diffs.length === 0) {
      console.log('OK — marketplace catalog versions already in sync with release-please-manifest');
      process.exit(0);
    }

    if (checkOnly) {
      console.error('sync-marketplace-versions: catalog drift detected');
      for (const d of diffs) console.error(`  - ${d.name}: ${d.from} → ${d.to}`);
      process.exit(1);
    }

    console.log(`Synced ${diffs.length} marketplace catalog version(s):`);
    for (const d of diffs) console.log(`  - ${d.name}: ${d.from} → ${d.to}`);
  } catch (err) {
    console.error(`sync-marketplace-versions: ${err.message}`);
    process.exit(1);
  }
}
