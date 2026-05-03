#!/usr/bin/env node
// Validates both marketplace catalogs are well-formed and stay consistent
// across the two host-specific schemas. Run via `npm run validate:marketplace`
// or directly with `node scripts/validate-marketplace.mjs`.
//
// What this checks:
//   - both catalog files parse as JSON
//   - cross-catalog top-level `name` and `description` match (single source
//     of truth — the two catalogs surface the same project under each host's
//     marketplace conventions)
//   - both `plugins` arrays exist and have the same length
//   - per-entry: each plugin name is unique within its catalog
//   - per-entry: the same plugin-name set appears in both catalogs
//   - per-entry (Codex): `source.path` resolves to an existing directory
//     containing a parsable `.codex-plugin/plugin.json` whose `name` matches
//     the marketplace entry's `name`
//   - per-entry (Claude): `plugins/<entry.name>/.claude-plugin/plugin.json`
//     exists and parses, with `name` matching the marketplace entry's `name`
//
// What this does NOT check:
//   - schema-by-host beyond the shared minimal subset (each host validates
//     its own marketplace.json independently)
//   - the `$schema` URL in the Claude catalog (Claude's own tooling does this)

import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const CLAUDE_PATH = '.claude-plugin/marketplace.json';
const CODEX_PATH = '.agents/plugins/marketplace.json';

const errors = [];

function loadCatalog(path) {
  try {
    return JSON.parse(readFileSync(resolve(REPO_ROOT, path), 'utf8'));
  } catch (err) {
    console.error(`✗ ${path}: ${err.message}`);
    process.exit(1);
  }
}

function loadJSON(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    errors.push(`${label}: ${err.message}`);
    return null;
  }
}

function dirExists(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

const claude = loadCatalog(CLAUDE_PATH);
const codex = loadCatalog(CODEX_PATH);

if (typeof claude.name !== 'string') errors.push(`${CLAUDE_PATH}: name must be string`);
if (typeof codex.name !== 'string')  errors.push(`${CODEX_PATH}: name must be string`);
if (typeof claude.name === 'string' && typeof codex.name === 'string' && claude.name !== codex.name) {
  errors.push(`name mismatch — claude="${claude.name}" vs codex="${codex.name}"`);
}

if (typeof claude.description !== 'string') errors.push(`${CLAUDE_PATH}: description must be string`);
if (typeof codex.description !== 'string')  errors.push(`${CODEX_PATH}: description must be string`);
if (typeof claude.description === 'string' && typeof codex.description === 'string' && claude.description !== codex.description) {
  errors.push(`description mismatch — claude="${claude.description}" vs codex="${codex.description}"`);
}

if (!Array.isArray(claude.plugins)) errors.push(`${CLAUDE_PATH}: plugins must be array`);
if (!Array.isArray(codex.plugins))  errors.push(`${CODEX_PATH}: plugins must be array`);

if (Array.isArray(claude.plugins) && Array.isArray(codex.plugins)) {
  if (claude.plugins.length !== codex.plugins.length) {
    errors.push(`plugin count mismatch — claude=${claude.plugins.length} vs codex=${codex.plugins.length}`);
  }

  const claudeNames = new Set();
  const codexNames = new Set();

  // Per-entry Claude validation
  for (const [i, entry] of claude.plugins.entries()) {
    if (typeof entry?.name !== 'string') {
      errors.push(`${CLAUDE_PATH}.plugins[${i}]: name must be string`);
      continue;
    }
    if (claudeNames.has(entry.name)) {
      errors.push(`${CLAUDE_PATH}: duplicate plugin name "${entry.name}"`);
    }
    claudeNames.add(entry.name);

    const pluginDir = resolve(REPO_ROOT, 'plugins', entry.name);
    if (!dirExists(pluginDir)) {
      errors.push(`${CLAUDE_PATH}.plugins[${i}] (${entry.name}): plugins/${entry.name}/ directory missing`);
      continue;
    }
    const manifestPath = resolve(pluginDir, '.claude-plugin/plugin.json');
    const manifest = loadJSON(manifestPath, `${CLAUDE_PATH}.plugins[${i}] (${entry.name}): .claude-plugin/plugin.json`);
    if (manifest && manifest.name !== entry.name) {
      errors.push(`${CLAUDE_PATH}.plugins[${i}]: catalog name "${entry.name}" != manifest name "${manifest.name}"`);
    }
  }

  // Per-entry Codex validation
  for (const [i, entry] of codex.plugins.entries()) {
    if (typeof entry?.name !== 'string') {
      errors.push(`${CODEX_PATH}.plugins[${i}]: name must be string`);
      continue;
    }
    if (codexNames.has(entry.name)) {
      errors.push(`${CODEX_PATH}: duplicate plugin name "${entry.name}"`);
    }
    codexNames.add(entry.name);

    const sourcePath = entry?.source?.path;
    if (typeof sourcePath !== 'string') {
      errors.push(`${CODEX_PATH}.plugins[${i}] (${entry.name}): source.path must be string`);
      continue;
    }
    const pluginDir = resolve(REPO_ROOT, sourcePath);
    if (!dirExists(pluginDir)) {
      errors.push(`${CODEX_PATH}.plugins[${i}] (${entry.name}): source.path "${sourcePath}" not a directory`);
      continue;
    }
    const manifestPath = resolve(pluginDir, '.codex-plugin/plugin.json');
    const manifest = loadJSON(manifestPath, `${CODEX_PATH}.plugins[${i}] (${entry.name}): .codex-plugin/plugin.json`);
    if (manifest && manifest.name !== entry.name) {
      errors.push(`${CODEX_PATH}.plugins[${i}]: catalog name "${entry.name}" != manifest name "${manifest.name}"`);
    }
  }

  // Cross-catalog name-set match
  if (claudeNames.size === claude.plugins.length && codexNames.size === codex.plugins.length) {
    const onlyInClaude = [...claudeNames].filter((n) => !codexNames.has(n));
    const onlyInCodex = [...codexNames].filter((n) => !claudeNames.has(n));
    if (onlyInClaude.length > 0) {
      errors.push(`plugins only in ${CLAUDE_PATH}: ${onlyInClaude.join(', ')}`);
    }
    if (onlyInCodex.length > 0) {
      errors.push(`plugins only in ${CODEX_PATH}: ${onlyInCodex.join(', ')}`);
    }
  }
}

if (errors.length > 0) {
  console.error('Marketplace validation failed:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(`OK — ${claude.plugins.length} plugin(s) in both catalogs`);
console.log(`  name:        ${claude.name}`);
console.log(`  description: ${claude.description}`);
if (claude.plugins.length > 0) {
  console.log(`  plugins:     ${claude.plugins.map((p) => p.name).join(', ')}`);
}
