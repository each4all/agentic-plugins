#!/usr/bin/env node
// Validates both marketplace catalogs are well-formed and stay consistent
// across the two host-specific schemas. Run via `npm run validate:marketplace`
// or directly with `node scripts/validate-marketplace.mjs`.
//
// What this checks:
//   - both catalog files parse as JSON
//   - cross-catalog `name` and `description` match (single source of truth
//     intent — the two catalogs surface the same project under each host's
//     marketplace conventions)
//   - both `plugins` arrays exist and have the same length
//
// What this does NOT check:
//   - schema-by-host beyond the shared minimal subset (each host validates
//     its own marketplace.json independently)
//   - the `$schema` URL in the Claude catalog (Claude's own tooling does this)

import { readFileSync } from 'node:fs';

const CLAUDE_PATH = '.claude-plugin/marketplace.json';
const CODEX_PATH = '.agents/plugins/marketplace.json';

function loadCatalog(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.error(`✗ ${path}: ${err.message}`);
    process.exit(1);
  }
}

const claude = loadCatalog(CLAUDE_PATH);
const codex = loadCatalog(CODEX_PATH);

const errors = [];

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
if (Array.isArray(claude.plugins) && Array.isArray(codex.plugins) && claude.plugins.length !== codex.plugins.length) {
  errors.push(`plugin count mismatch — claude=${claude.plugins.length} vs codex=${codex.plugins.length}`);
}

if (errors.length > 0) {
  console.error('Marketplace validation failed:');
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(`OK — ${claude.plugins.length} plugin(s) in both catalogs`);
console.log(`  name:        ${claude.name}`);
console.log(`  description: ${claude.description}`);
