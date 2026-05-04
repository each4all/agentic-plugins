#!/usr/bin/env node
// adapters/claude/scripts/discover-companion.mjs
//
// Resolves the codex-companion path for the research skill running on
// Claude Code. The peer host for Claude is Codex, so this script
// discovers ~/.claude/plugins/cache/agentic-plugins/companions/*/scripts/codex-companion.mjs.
//
// Resolution order (per ADR-0008):
//   1. AGENTIC_COMPANIONS_ROOT env override — absolute path treated as
//      <root>/codex-companion.mjs.
//   2. Cache-glob with manifest verification:
//        ~/.claude/plugins/cache/agentic-plugins/companions/*/scripts/codex-companion.mjs
//      Each candidate's .claude-plugin/plugin.json must declare
//      name == "companions"; SemVer-descending selection of valid
//      manifest matches.
//   3. Preflight: companion source must reference --prompt-file and
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

import { readFile, stat, readdir } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

const PEER_COMPANION = 'codex-companion.mjs';
const ENV_VAR = 'AGENTIC_COMPANIONS_ROOT';
const COMPATIBLE_MAJOR = 0;
const DEFAULT_CACHE_BASE = join(homedir(), '.claude', 'plugins', 'cache', 'agentic-plugins', 'companions');

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

  let entries = [];
  try {
    entries = await readdir(cacheBase, { withFileTypes: true });
  } catch (err) {
    return { ok: false, reason: `failed to scan ${cacheBase}: ${err.message}` };
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const versionDir = join(cacheBase, entry.name);
    const manifestPath = join(versionDir, '.claude-plugin', 'plugin.json');
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch {
      continue;
    }
    if (manifest.name !== 'companions') continue;
    const companionPath = join(versionDir, 'scripts', PEER_COMPANION);
    if (!(await fileExists(companionPath))) continue;
    candidates.push({ version: typeof manifest.version === 'string' ? manifest.version : '0.0.0', path: companionPath });
  }

  if (candidates.length === 0) {
    return { ok: false, reason: `no manifest-verified companions plugin in ${cacheBase}` };
  }

  candidates.sort((a, b) => semverCompare(b.version, a.version));

  for (const c of candidates) {
    if (await preflight(c.path)) {
      return { ok: true, path: c.path, source: 'cache-glob', version: c.version };
    }
  }

  return { ok: false, reason: `no companions plugin in ${cacheBase} passed preflight (${PEER_COMPANION})` };
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

function semverCompare(a, b) {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
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
