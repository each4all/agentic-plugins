#!/usr/bin/env node
// kit/lint/check-plugin-shape.mjs — generic plugin-shape validator
//
// Validates that a directory has the canonical agentic-plugins plugin
// shape: a Claude manifest, a Codex manifest, consistent names, any
// shipped script files have the executable bit set, the Codex
// manifest's `skills` path (if declared) resolves to a real directory,
// and a Claude hook registration (if shipped) is structurally valid
// with every plugin-rooted command target present.
//
// Script-bearing directories scanned for executable bit:
//   <plugin-dir>/scripts/                            (script-only library plugins)
//   <plugin-dir>/adapters/<host>/scripts/            (per-host adapter scripts)
//   <plugin-dir>/adapters/<host>/hooks/              (per-host hook entry scripts)
//
// Hook-bearing plugins (ADR-0040 §3 formalized the hook-only category —
// hooks + sensor scripts only, the hook-bearing sibling of the ADR-0008
// script-only shape): when <plugin-dir>/hooks/hooks.json exists it must
//   - parse as JSON with a top-level `hooks` object mapping event names
//     to arrays of matcher groups,
//   - carry `type: "command"` entries with non-empty command strings,
//   - reference only existing files inside the plugin for every
//     `${CLAUDE_PLUGIN_ROOT}/…` command target (a hooks.json pointing at
//     a missing sensor script is the hook-only shape's core failure mode).
//
//   node kit/lint/check-plugin-shape.mjs <plugin-dir>
//
// Exit codes:
//   0 — plugin shape OK
//   1 — plugin-shape errors found
//   2 — misuse (bad arguments, plugin-dir not a directory)
//
// This is the "minimal" Stage 1 lint per Deliverable B.10, generalized
// in C.2 to handle adapter-bearing plugins (e.g., plugins/engineer/)
// and extended for ADR-0040's hook-only category. Additional checks
// (drift detection, SemVer cross-version constraints, marketplace
// registration coverage) remain in their own scripts/tests and may be
// folded in here as the kit/lint surface matures.

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
    const hostHooks = resolve(adaptersDir, host.name, 'hooks');
    await checkScriptsDir(`adapters/${host.name}/hooks`, hostHooks);
  }
}

// Claude hook registration (hooks/hooks.json) — structural validation plus
// command-target existence for every `${CLAUDE_PLUGIN_ROOT}/…` reference.
// Optional: plugins without hooks skip this entirely (hook absence is
// non-fatal per ADR-0011 §4; hook-only plugins per ADR-0040 §3 hinge on it).
const HOOK_COMMAND_ROOT_RE = /\$\{CLAUDE_PLUGIN_ROOT\}\/([^"']+)/g;

async function checkHooksJson(path) {
  if (!(await exists(path))) return;
  let json;
  try {
    json = await readJSON(path);
  } catch (err) {
    errors.push(`hooks/hooks.json: ${err.message}`);
    return;
  }
  const hooks = json?.hooks;
  if (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks)) {
    errors.push('hooks/hooks.json: top-level "hooks" must be an object mapping event names to matcher-group arrays');
    return;
  }
  for (const [eventName, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups) || groups.length === 0) {
      errors.push(`hooks/hooks.json: "${eventName}" must be a non-empty array of matcher groups`);
      continue;
    }
    for (const [gi, group] of groups.entries()) {
      const groupLabel = `hooks/hooks.json: "${eventName}"[${gi}]`;
      if (typeof group !== 'object' || group === null || Array.isArray(group)) {
        errors.push(`${groupLabel}: matcher group must be an object`);
        continue;
      }
      if (group.matcher !== undefined && (typeof group.matcher !== 'string' || group.matcher.length === 0)) {
        errors.push(`${groupLabel}: matcher must be a non-empty string when present`);
      }
      if (!Array.isArray(group.hooks) || group.hooks.length === 0) {
        errors.push(`${groupLabel}: hooks must be a non-empty array`);
        continue;
      }
      for (const [hi, hook] of group.hooks.entries()) {
        const hookLabel = `${groupLabel}.hooks[${hi}]`;
        if (typeof hook !== 'object' || hook === null || Array.isArray(hook)) {
          errors.push(`${hookLabel}: hook entry must be an object`);
          continue;
        }
        if (hook.type !== 'command') {
          errors.push(`${hookLabel}: type must be "command"`);
        }
        if (typeof hook.command !== 'string' || hook.command.length === 0) {
          errors.push(`${hookLabel}: command must be a non-empty string`);
          continue;
        }
        const rootMatches = [...hook.command.matchAll(HOOK_COMMAND_ROOT_RE)];
        // A plugin hook command that references no ${CLAUDE_PLUGIN_ROOT}
        // target ships no plugin-owned behavior and dodges the existence
        // check entirely — reject rather than silently pass.
        if (rootMatches.length === 0) {
          errors.push(`${hookLabel}: command must reference at least one \${CLAUDE_PLUGIN_ROOT}/… target`);
          continue;
        }
        for (const match of rootMatches) {
          const target = resolve(PLUGIN_DIR, match[1]);
          if (!target.startsWith(`${PLUGIN_DIR}/`)) {
            errors.push(`${hookLabel}: command target "${match[1]}" escapes the plugin directory`);
            continue;
          }
          let targetStat;
          try {
            targetStat = await stat(target);
          } catch {
            errors.push(`${hookLabel}: command target "${match[1]}" does not exist`);
            continue;
          }
          if (!targetStat.isFile()) {
            errors.push(`${hookLabel}: command target "${match[1]}" is not a regular file`);
          }
        }
      }
    }
  }
}

await checkHooksJson(resolve(PLUGIN_DIR, 'hooks/hooks.json'));

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
