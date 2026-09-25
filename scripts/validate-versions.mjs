#!/usr/bin/env node
// Cross-checks plugin versions across release-please-manifest, plugin manifests,
// and both marketplace catalogs. Run via `npm run validate:versions`.
//
// Why: release-please-config.json's `extra-files` is the automation that keeps
// these in sync on every release cycle. This script is the inspection that
// fails CI when drift slips through (e.g., manual edits, partial release,
// release-please-manifest cycles that pre-date the extra-files config).
//
// Source of truth: .release-please-manifest.json (release-please's anchor).
// Targets verified for each "plugins/<name>" entry:
//   - plugins/<name>/.claude-plugin/plugin.json $.version
//   - plugins/<name>/.codex-plugin/plugin.json  $.version
//   - .claude-plugin/marketplace.json plugins[name=<name>].version
//   - .agents/plugins/marketplace.json plugins[name=<name>].source.ref, when
//     the entry is pinned (ADR-0061 Decision 2: the pinned version equals the
//     manifest version post-tag). A `local` entry carries no version, which is
//     the whole pre-activation catalog, so it is not checked.
//
// Release-please PRs are a special intermediate state: package manifests
// intentionally move ahead first, and both root catalogs are synced after
// the release merge by .github/workflows/release-please.yml. Use
// --allow-marketplace-lag only in that release-please PR context. It lets a
// catalog trail the manifest; it never excuses a malformed pin, and never a
// pin AHEAD of the manifest, since no release can have tagged that version.
//
// The pin's history (its tag resolves and peels to its sha) is
// validate-marketplace.mjs's to check; this script needs no history.
// Canonical "companions" (the non-plugin entry) is skipped — it has no
// plugin.json or marketplace presence.

import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { CODEX_CATALOG_PATH, checkPinShape, compareSemver, sourceKind } from './lib/codex-catalog-pins.mjs';

const MANIFEST_PATH = '.release-please-manifest.json';
const CLAUDE_MARKETPLACE_PATH = '.claude-plugin/marketplace.json';

/**
 * @param {string} repoRoot
 * @param {{allowMarketplaceLag?: boolean}} [options]
 * @returns {{errors: string[], warnings: string[], manifest: object|null, codexPinsChecked: number}}
 */
export function validateVersions(repoRoot, { allowMarketplaceLag = false } = {}) {
  const errors = [];
  const warnings = [];
  let codexPinsChecked = 0;

  function loadJSON(relPath, label) {
    try {
      return JSON.parse(readFileSync(resolve(repoRoot, relPath), 'utf8'));
    } catch (err) {
      errors.push(`${label}: ${err.message}`);
      return null;
    }
  }

  const manifest = loadJSON(MANIFEST_PATH, MANIFEST_PATH);
  if (!manifest) return { errors, warnings, manifest, codexPinsChecked };

  const claudeEntries = loadJSON(CLAUDE_MARKETPLACE_PATH, CLAUDE_MARKETPLACE_PATH)?.plugins ?? [];
  const codexEntries = loadJSON(CODEX_CATALOG_PATH, CODEX_CATALOG_PATH)?.plugins ?? [];

  function catalogDrift(message) {
    if (allowMarketplaceLag) warnings.push(`${message} (allowed release-please PR lag)`);
    else errors.push(message);
  }

  for (const [pkgPath, expectedVersion] of Object.entries(manifest)) {
    if (!pkgPath.startsWith('plugins/')) continue;

    const pluginName = pkgPath.replace(/^plugins\//, '');

    const claudeManifest = loadJSON(
      `${pkgPath}/.claude-plugin/plugin.json`,
      `${pkgPath}/.claude-plugin/plugin.json`,
    );
    if (claudeManifest && claudeManifest.version !== expectedVersion) {
      errors.push(
        `${pkgPath}/.claude-plugin/plugin.json: version "${claudeManifest.version}" != release-please-manifest "${expectedVersion}"`,
      );
    }

    const codexManifest = loadJSON(
      `${pkgPath}/.codex-plugin/plugin.json`,
      `${pkgPath}/.codex-plugin/plugin.json`,
    );
    if (codexManifest && codexManifest.version !== expectedVersion) {
      errors.push(
        `${pkgPath}/.codex-plugin/plugin.json: version "${codexManifest.version}" != release-please-manifest "${expectedVersion}"`,
      );
    }

    const entry = claudeEntries.find((p) => p.name === pluginName);
    if (entry && entry.version !== expectedVersion) {
      catalogDrift(`${CLAUDE_MARKETPLACE_PATH} entry "${pluginName}": version "${entry.version}" != release-please-manifest "${expectedVersion}"`);
    }

    const codexEntry = codexEntries.find((p) => p.name === pluginName);
    if (codexEntry && sourceKind(codexEntry) === 'pinned') {
      codexPinsChecked += 1;
      const at = `${CODEX_CATALOG_PATH} entry "${pluginName}"`;
      const { errors: shapeErrors, version } = checkPinShape(codexEntry);
      for (const e of shapeErrors) errors.push(`${at}: ${e}`);
      if (version !== null) {
        const delta = compareSemver(version, expectedVersion);
        if (delta > 0) {
          errors.push(`${at}: pinned version "${version}" is ahead of release-please-manifest "${expectedVersion}"`);
        } else if (delta < 0) {
          catalogDrift(`${at}: pinned version "${version}" != release-please-manifest "${expectedVersion}"`);
        }
      }
    }
  }

  return { errors, warnings, manifest, codexPinsChecked };
}

// CLI entry — realpath on both sides, as in validate-marketplace.mjs.
function invokedAsCLI() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedAsCLI()) {
  let values;
  try {
    ({ values } = parseArgs({ options: { 'allow-marketplace-lag': { type: 'boolean' } }, strict: true }));
  } catch (err) {
    console.error(`validate-versions: ${err.message}`);
    console.error('usage: validate-versions.mjs [--allow-marketplace-lag]');
    process.exit(2);
  }
  const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../..');
  const { errors, warnings, manifest, codexPinsChecked } = validateVersions(REPO_ROOT, {
    allowMarketplaceLag: values['allow-marketplace-lag'] === true,
  });

  if (errors.length > 0) {
    console.error(manifest ? 'Version validation failed:' : 'Version validation aborted: cannot load release-please manifest');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  console.log(warnings.length > 0
    ? 'OK — plugin manifests match release-please-manifest; marketplace lag allowed for release-please PR'
    : 'OK — versions in sync across release-please-manifest, plugin manifests, and both marketplace catalogs');
  console.log(codexPinsChecked > 0
    ? `  Codex catalog: ${codexPinsChecked} pinned entr${codexPinsChecked === 1 ? 'y' : 'ies'} checked`
    : '  Codex catalog: no pinned entries (pre-activation — a local entry carries no version)');
  if (warnings.length > 0) {
    console.log('Warnings:');
    for (const w of warnings) console.log(`  - ${w}`);
  }
  for (const [pkg, ver] of Object.entries(manifest)) {
    console.log(`  ${pkg}: ${ver}`);
  }
}
