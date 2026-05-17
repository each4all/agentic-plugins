#!/usr/bin/env node
// Cross-checks plugin versions across release-please-manifest, plugin manifests,
// and the Claude marketplace catalog. Run via `npm run validate:versions`.
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
//
// Release-please PRs are a special intermediate state: package manifests
// intentionally move ahead first, and the root marketplace catalog is synced
// after the release merge by .github/workflows/release-please.yml. Use
// --allow-marketplace-lag only in that release-please PR context.
//
// Codex marketplace catalog has no per-entry version field, so it is
// intentionally not checked. Canonical "companions" (the non-plugin entry)
// is also skipped — it has no plugin.json or marketplace presence.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const MANIFEST_PATH = '.release-please-manifest.json';
const CLAUDE_MARKETPLACE_PATH = '.claude-plugin/marketplace.json';
const allowMarketplaceLag = process.argv.includes('--allow-marketplace-lag');

const errors = [];
const warnings = [];

function loadJSON(relPath, label) {
  try {
    return JSON.parse(readFileSync(resolve(REPO_ROOT, relPath), 'utf8'));
  } catch (err) {
    errors.push(`${label}: ${err.message}`);
    return null;
  }
}

const manifest = loadJSON(MANIFEST_PATH, MANIFEST_PATH);
if (!manifest) {
  console.error('Version validation aborted: cannot load release-please manifest');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

const claudeMarketplace = loadJSON(CLAUDE_MARKETPLACE_PATH, CLAUDE_MARKETPLACE_PATH);
const claudeEntries = claudeMarketplace?.plugins ?? [];

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
    const message = `${CLAUDE_MARKETPLACE_PATH} entry "${pluginName}": version "${entry.version}" != release-please-manifest "${expectedVersion}"`;
    if (allowMarketplaceLag) {
      warnings.push(`${message} (allowed release-please PR lag)`);
    } else {
      errors.push(message);
    }
  }
}

if (errors.length > 0) {
  console.error('Version validation failed:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(warnings.length > 0
  ? 'OK — plugin manifests match release-please-manifest; marketplace lag allowed for release-please PR'
  : 'OK — versions in sync across release-please-manifest, plugin manifests, and Claude marketplace');
if (warnings.length > 0) {
  console.log('Warnings:');
  for (const w of warnings) console.log(`  - ${w}`);
}
for (const [pkg, ver] of Object.entries(manifest)) {
  console.log(`  ${pkg}: ${ver}`);
}
