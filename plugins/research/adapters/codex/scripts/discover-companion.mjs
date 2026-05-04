#!/usr/bin/env node
// adapters/codex/scripts/discover-companion.mjs
//
// Resolves the claude-companion path for the research skill running on
// Codex CLI. The peer host for Codex is Claude, so this script
// discovers the bundled claude-companion.mjs inside the agentic-plugins
// marketplace clone.
//
// Resolution order (per ADR-0008 § (b) Amendment 2026-05-04, verified
// against codex-cli 0.128.0):
//   1. AGENTIC_COMPANIONS_ROOT env override — absolute path treated as
//      <root>/claude-companion.mjs.
//   2. Zero-wildcard cache lookup at
//        ~/.codex/.tmp/marketplaces/agentic-plugins/plugins/companions/
//      The marketplace clone is fully pinned (marketplace + plugin both
//      named); the only verification is the bundled manifest's name.
//   3. Manifest verification: .codex-plugin/plugin.json must declare
//      name == "companions".
//   4. Preflight: companion source must reference --prompt-file and
//      declare a CONTRACT_VERSION whose major matches this script's
//      compatibility expectation (currently 0).
//
// Exit codes:
//   0 — discovered; stdout is the absolute companion path (one line).
//   1 — not found / graceful degradation; stderr summarizes why.
//   2 — misuse (bad arguments).
//
// The discover() function is exported for unit tests; the CLI tail
// only runs when this module is the entrypoint.

import { readFile, stat } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

const PEER_COMPANION = 'claude-companion.mjs';
const ENV_VAR = 'AGENTIC_COMPANIONS_ROOT';
const COMPATIBLE_MAJOR = 0;
const DEFAULT_CACHE_BASE = join(
  homedir(),
  '.codex',
  '.tmp',
  'marketplaces',
  'agentic-plugins',
  'plugins',
  'companions',
);

export async function discover({ env = process.env, cacheBase = DEFAULT_CACHE_BASE } = {}) {
  const envRoot = env[ENV_VAR];
  if (envRoot && envRoot.length > 0) {
    if (!isAbsolute(envRoot)) {
      return { ok: false, reason: `${ENV_VAR} must be an absolute path: ${envRoot}` };
    }
    const candidate = join(envRoot, PEER_COMPANION);
    if (!(await fileExists(candidate))) {
      return { ok: false, reason: `${ENV_VAR}=${envRoot} but ${candidate} not found` };
    }
    if (!(await preflight(candidate))) {
      return {
        ok: false,
        reason: `${candidate} failed preflight (missing --prompt-file or incompatible CONTRACT_VERSION)`,
      };
    }
    return { ok: true, path: candidate, source: 'env' };
  }

  if (!(await dirExists(cacheBase))) {
    return { ok: false, reason: `companions plugin not installed (${cacheBase} not found)` };
  }

  const manifestPath = join(cacheBase, '.codex-plugin', 'plugin.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch (err) {
    return { ok: false, reason: `companions manifest unreadable at ${manifestPath}: ${err.message}` };
  }
  if (manifest.name !== 'companions') {
    return { ok: false, reason: `manifest name "${manifest.name}" != "companions" at ${manifestPath}` };
  }

  const candidate = join(cacheBase, 'scripts', PEER_COMPANION);
  if (!(await fileExists(candidate))) {
    return { ok: false, reason: `${candidate} not found` };
  }
  if (!(await preflight(candidate))) {
    return {
      ok: false,
      reason: `${candidate} failed preflight (missing --prompt-file or incompatible CONTRACT_VERSION)`,
    };
  }
  return {
    ok: true,
    path: candidate,
    source: 'cache',
    version: typeof manifest.version === 'string' ? manifest.version : '?',
  };
}

async function fileExists(path) {
  try {
    const st = await stat(path);
    return st.isFile();
  } catch {
    return false;
  }
}

async function dirExists(path) {
  try {
    const st = await stat(path);
    return st.isDirectory();
  } catch {
    return false;
  }
}

async function preflight(companionPath) {
  let text;
  try {
    text = await readFile(companionPath, 'utf8');
  } catch {
    return false;
  }
  if (!/['"]prompt-file['"]/.test(text)) return false;
  const m = text.match(/CONTRACT_VERSION\s*=\s*['"]([0-9]+)\.([0-9]+)\.([0-9]+)['"]/);
  if (!m) return false;
  const major = Number.parseInt(m[1], 10);
  return major === COMPATIBLE_MAJOR;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  if (args.length !== 0) {
    process.stderr.write('Usage: node discover-companion.mjs\n');
    process.exit(2);
  }
  const result = await discover();
  if (result.ok) {
    process.stdout.write(result.path + '\n');
    process.exit(0);
  }
  process.stderr.write(`discover-companion: ${result.reason}\n`);
  process.exit(1);
}
