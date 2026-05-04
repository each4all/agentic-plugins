#!/usr/bin/env node
// kit/lint/check-plugin-shape.mjs — generic plugin-shape validator
//
// Validates that a directory has the canonical agentic-plugins plugin
// shape: a Claude manifest, a Codex manifest, consistent names, any
// shipped script files have the executable bit set, and the Codex
// manifest's `skills` path (if declared) resolves to a real directory.
//
// Script-bearing directories scanned for executable bit:
//   <plugin-dir>/scripts/                            (script-only library plugins)
//   <plugin-dir>/adapters/<host>/scripts/            (per-host adapter scripts)
//
//   node kit/lint/check-plugin-shape.mjs <plugin-dir>
//
// Exit codes:
//   0 — plugin shape OK
//   1 — plugin-shape errors found
//   2 — misuse (bad arguments, plugin-dir not a directory)
//
// This is the "minimal" Stage 1 lint per Deliverable B.10, generalized
// in C.2 to handle adapter-bearing plugins (e.g., plugins/research/).
// Additional checks (drift detection, SemVer cross-version constraints,
// marketplace registration coverage) remain in their own scripts/tests
// and may be folded in here as the kit/lint surface matures.

import { readFile, stat, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
if (args.length !== 1) {
  console.error('Usage: node kit/lint/check-plugin-shape.mjs <plugin-dir>');
  process.exit(2);
}

const PLUGIN_DIR = resolve(args[0]);

let pluginStat;
try {
  pluginStat = await stat(PLUGIN_DIR);
} catch (err) {
  console.error(`✗ ${PLUGIN_DIR}: ${err.message}`);
  process.exit(2);
}
if (!pluginStat.isDirectory()) {
  console.error(`✗ ${PLUGIN_DIR}: not a directory`);
  process.exit(2);
}

const errors = [];

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

async function checkManifest(label, path, requiredScalarFields) {
  if (!(await exists(path))) {
    errors.push(`${label}: missing`);
    return null;
  }
  let json;
  try {
    json = await readJSON(path);
  } catch (err) {
    errors.push(`${label}: ${err.message}`);
    return null;
  }
  for (const field of requiredScalarFields) {
    if (typeof json[field] !== 'string' || json[field].length === 0) {
      errors.push(`${label}: ${field} must be non-empty string`);
    }
  }
  return json;
}

const claudePath = resolve(PLUGIN_DIR, '.claude-plugin/plugin.json');
const codexPath = resolve(PLUGIN_DIR, '.codex-plugin/plugin.json');

const claudeManifest = await checkManifest('.claude-plugin/plugin.json', claudePath, [
  'name',
  'version',
  'description',
]);
const codexManifest = await checkManifest('.codex-plugin/plugin.json', codexPath, [
  'name',
  'version',
  'description',
]);

if (codexManifest && codexManifest.interface !== undefined) {
  if (typeof codexManifest.interface !== 'object' || codexManifest.interface === null || Array.isArray(codexManifest.interface)) {
    errors.push('.codex-plugin/plugin.json: interface must be object when present');
  }
}

if (claudeManifest && codexManifest && claudeManifest.name !== codexManifest.name) {
  errors.push(`manifest name mismatch — claude="${claudeManifest.name}" vs codex="${codexManifest.name}"`);
}

async function checkScriptsDir(label, dir) {
  if (!(await exists(dir))) return;
  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    errors.push(`${label}: ${err.message}`);
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith('.mjs') && !entry.name.endsWith('.js') && !entry.name.endsWith('.sh')) continue;
    const filePath = resolve(dir, entry.name);
    try {
      const st = await stat(filePath);
      if ((st.mode & 0o111) === 0) {
        errors.push(`${label}/${entry.name}: executable bit not set`);
      }
    } catch (err) {
      errors.push(`${label}/${entry.name}: ${err.message}`);
    }
  }
}

await checkScriptsDir('scripts', resolve(PLUGIN_DIR, 'scripts'));

const adaptersDir = resolve(PLUGIN_DIR, 'adapters');
if (await exists(adaptersDir)) {
  let hostEntries = [];
  try {
    hostEntries = await readdir(adaptersDir, { withFileTypes: true });
  } catch (err) {
    errors.push(`adapters/: ${err.message}`);
  }
  for (const host of hostEntries) {
    if (!host.isDirectory()) continue;
    const hostScripts = resolve(adaptersDir, host.name, 'scripts');
    await checkScriptsDir(`adapters/${host.name}/scripts`, hostScripts);
  }
}

if (codexManifest && typeof codexManifest.skills === 'string' && codexManifest.skills.length > 0) {
  const skillsPath = resolve(PLUGIN_DIR, codexManifest.skills);
  if (!(await exists(skillsPath))) {
    errors.push(`.codex-plugin/plugin.json: skills path "${codexManifest.skills}" does not resolve to an existing directory`);
  } else {
    try {
      const st = await stat(skillsPath);
      if (!st.isDirectory()) {
        errors.push(`.codex-plugin/plugin.json: skills path "${codexManifest.skills}" is not a directory`);
      }
    } catch (err) {
      errors.push(`.codex-plugin/plugin.json: skills path "${codexManifest.skills}" stat failed: ${err.message}`);
    }
  }
}

if (errors.length > 0) {
  console.error(`✗ ${PLUGIN_DIR}:`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

const name = claudeManifest?.name ?? codexManifest?.name ?? '<unknown>';
console.log(`✓ ${PLUGIN_DIR}: plugin "${name}" shape OK`);
