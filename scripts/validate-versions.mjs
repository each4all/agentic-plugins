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
// The release commit is the one commit whose catalogs trail the manifest:
// release-please moves the manifests first, and the release job
// (.github/workflows/release-please.yml) syncs both root catalogs after the
// merge. The CLI therefore lets a catalog stand at the version the manifest
// held before, but only for a package whose manifest version the checked-out
// commit itself changes, and only at exactly that version (ADR-0065 Decision
// 8, keyed on content). Every other commit is checked strictly, on every
// branch. The allowance never excuses a malformed pin, and never a pin AHEAD
// of the manifest, since no release can have tagged that version. The library
// default is strict, which is what the catalog writer validates with.
//
// The pin's history (its tag resolves and peels to its sha) is
// validate-marketplace.mjs's to check; this script reads history only to find
// the commit's first parent.
// Canonical "companions" (the non-plugin entry) is skipped — it has no
// plugin.json or marketplace presence.

import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import {
  CODEX_CATALOG_PATH, checkPinShape, compareSemver, mayTrail, releaseLag, sourceKind,
} from './lib/codex-catalog-pins.mjs';

const MANIFEST_PATH = '.release-please-manifest.json';
const CLAUDE_MARKETPLACE_PATH = '.claude-plugin/marketplace.json';

/**
 * @param {string} repoRoot
 * @param {{allowReleaseLag?: boolean}} [options]  allowReleaseLag: let a
 *   catalog trail exactly the versions HEAD's own manifest change moved
 *   (ADR-0065 Decision 8); off by default, which is strict
 * @returns {{errors: string[], warnings: string[], manifest: object|null, codexPinsChecked: number}}
 */
export function validateVersions(repoRoot, { allowReleaseLag = false } = {}) {
  const errors = [];
  const warnings = [];
  let codexPinsChecked = 0;
  const lag = allowReleaseLag ? releaseLag(repoRoot) : null;

  function loadJSON(relPath, label) {
    let value;
    try {
      value = JSON.parse(readFileSync(resolve(repoRoot, relPath), 'utf8'));
    } catch (err) {
      errors.push(`${label}: ${err.message}`);
      return null;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      errors.push(`${label}: must be a JSON object`);
      return null;
    }
    return value;
  }
  const pluginsOf = (catalog) => (Array.isArray(catalog?.plugins) ? catalog.plugins : []);

  const manifest = loadJSON(MANIFEST_PATH, MANIFEST_PATH);
  if (!manifest) return { errors, warnings, manifest, codexPinsChecked };

  const claudeEntries = pluginsOf(loadJSON(CLAUDE_MARKETPLACE_PATH, CLAUDE_MARKETPLACE_PATH));
  const codexEntries = pluginsOf(loadJSON(CODEX_CATALOG_PATH, CODEX_CATALOG_PATH));

  function catalogDrift(message, name, catalogVersion, packageVersion) {
    if (mayTrail(lag, name, catalogVersion, packageVersion)) {
      warnings.push(`${message} (the release commit's own lag, ADR-0065 Decision 8)`);
    } else {
      errors.push(message);
    }
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

    const entry = claudeEntries.find((p) => p?.name === pluginName);
    if (entry && entry.version !== expectedVersion) {
      catalogDrift(
        `${CLAUDE_MARKETPLACE_PATH} entry "${pluginName}": version "${entry.version}" != release-please-manifest "${expectedVersion}"`,
        pluginName, entry.version, expectedVersion,
      );
    }

    const codexEntry = codexEntries.find((p) => p?.name === pluginName);
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
          catalogDrift(`${at}: pinned version "${version}" != release-please-manifest "${expectedVersion}"`, pluginName, version, expectedVersion);
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
  try {
    parseArgs({ options: {}, strict: true });
  } catch (err) {
    console.error(`validate-versions: ${err.message}`);
    console.error('usage: validate-versions.mjs');
    process.exit(2);
  }
  const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../..');
  // The commit under test is HEAD, whatever the branch or the event that ran
  // this: the allowance is decided by what HEAD itself changes.
  const { errors, warnings, manifest, codexPinsChecked } = validateVersions(REPO_ROOT, { allowReleaseLag: true });

  if (errors.length > 0) {
    console.error(manifest ? 'Version validation failed:' : 'Version validation aborted: cannot load release-please manifest');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  console.log(warnings.length > 0
    ? 'OK — plugin manifests match release-please-manifest; the catalogs trail only what this release commit moved'
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
