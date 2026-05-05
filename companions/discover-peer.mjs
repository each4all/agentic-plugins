#!/usr/bin/env node
// plugins/companions/scripts/discover-peer.mjs
//
// Canonical companion discovery library — the single source of truth for
// resolving the path to a peer-host companion script. Bundled inside the
// `companions` plugin (per ADR-0010 §6 trigger evaluation: discovery has
// high cohesion with companion invocation; absorbed into the same plugin
// rather than spun out as a separate framework primitive).
//
// Resolution order (per ADR-0008 §b.1):
//   1. AGENTIC_COMPANIONS_ROOT env override — absolute path treated as
//      <root>/<peer>-companion.mjs.
//   2. Cache-glob (host-specific layout) with manifest verification.
//   3. Preflight: companion source must reference --prompt-file and
//      declare a CONTRACT_VERSION whose major matches this script's
//      compatibility expectation (currently 0).
//
// Usage as a library (preferred — consumer plugins bootstrap to find the
// companions plugin cache root, then import discover-peer.mjs):
//
//   const { discoverPeerCompanion } = await import(
//     join(companionsRoot, 'scripts/discover-peer.mjs')
//   );
//   const result = await discoverPeerCompanion({ peer: 'codex' });
//   // result.ok ? result.path : result.reason
//
// Usage as a CLI (testing/debugging):
//
//   node discover-peer.mjs --peer codex
//   # stdout: companion path on success, exit code 0
//   # stderr: failure reason on miss, exit code 1
//   # exit code 2 on misuse
//
// The peer argument selects the host pair:
//   peer === 'codex' → caller is on Claude, looks for codex-companion.mjs
//                       (Claude cache layout: multi-version SemVer scan)
//   peer === 'claude' → caller is on Codex, looks for claude-companion.mjs
//                        (Codex cache layout: single fixed marketplace path)

import { readFile, stat, readdir } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

const ENV_VAR = 'AGENTIC_COMPANIONS_ROOT';
const COMPATIBLE_MAJOR = 0;

const PEER_FILENAME = {
  codex: 'codex-companion.mjs',
  claude: 'claude-companion.mjs',
};

// Per-peer default cache layout — Claude cache supports multi-version
// SemVer scan; Codex cache is zero-wildcard fully-pinned marketplace.
const DEFAULTS = {
  codex: {
    cacheBase: join(homedir(), '.claude', 'plugins', 'cache', 'agentic-plugins', 'companions'),
    layout: 'multi-version',
    manifestPath: '.claude-plugin/plugin.json',
  },
  claude: {
    cacheBase: join(
      homedir(),
      '.codex',
      '.tmp',
      'marketplaces',
      'agentic-plugins',
      'plugins',
      'companions',
    ),
    layout: 'single',
    manifestPath: '.codex-plugin/plugin.json',
  },
};

export async function discoverPeerCompanion({ peer, env = process.env, cacheBase, layout, manifestPath } = {}) {
  if (peer !== 'codex' && peer !== 'claude') {
    return { ok: false, reason: `peer must be 'codex' or 'claude', got: ${peer}` };
  }
  const peerFilename = PEER_FILENAME[peer];
  const defaults = DEFAULTS[peer];
  cacheBase ??= defaults.cacheBase;
  layout ??= defaults.layout;
  manifestPath ??= defaults.manifestPath;

  // 1. Env override
  const envRoot = env[ENV_VAR];
  if (envRoot && envRoot.length > 0) {
    if (!isAbsolute(envRoot)) {
      return { ok: false, reason: `${ENV_VAR} must be an absolute path: ${envRoot}` };
    }
    const candidate = join(envRoot, peerFilename);
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

  // 2. Cache-glob per layout
  if (!(await dirExists(cacheBase))) {
    return { ok: false, reason: `companions plugin not installed (${cacheBase} not found)` };
  }

  if (layout === 'multi-version') {
    return discoverMultiVersion({ cacheBase, peerFilename, manifestPath });
  }
  if (layout === 'single') {
    return discoverSingle({ cacheBase, peerFilename, manifestPath });
  }
  return { ok: false, reason: `unknown layout: ${layout}` };
}

async function discoverMultiVersion({ cacheBase, peerFilename, manifestPath }) {
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
    const manifestFile = join(versionDir, manifestPath);
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    } catch {
      continue;
    }
    if (manifest.name !== 'companions') continue;
    const companionPath = join(versionDir, 'scripts', peerFilename);
    if (!(await fileExists(companionPath))) continue;
    candidates.push({
      version: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
      path: companionPath,
    });
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

  return { ok: false, reason: `no companions plugin in ${cacheBase} passed preflight (${peerFilename})` };
}

async function discoverSingle({ cacheBase, peerFilename, manifestPath }) {
  const manifestFile = join(cacheBase, manifestPath);
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  } catch (err) {
    return { ok: false, reason: `companions manifest unreadable at ${manifestFile}: ${err.message}` };
  }
  if (manifest.name !== 'companions') {
    return { ok: false, reason: `manifest name "${manifest.name}" != "companions" at ${manifestFile}` };
  }

  const candidate = join(cacheBase, 'scripts', peerFilename);
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

export async function fileExists(path) {
  try {
    const st = await stat(path);
    return st.isFile();
  } catch {
    return false;
  }
}

export async function dirExists(path) {
  try {
    const st = await stat(path);
    return st.isDirectory();
  } catch {
    return false;
  }
}

export async function preflight(companionPath) {
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

export function semverCompare(a, b) {
  const pa = a.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const av = pa[i] ?? 0;
    const bv = pb[i] ?? 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

// CLI tail — used for testing/debugging discover-peer.mjs in isolation.
// Production usage: imported as a library by consumer plugin adapter scripts.
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  let peer;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--peer' && i + 1 < args.length) {
      peer = args[++i];
    } else {
      process.stderr.write(`Unknown argument: ${args[i]}\n`);
      process.stderr.write('Usage: node discover-peer.mjs --peer <codex|claude>\n');
      process.exit(2);
    }
  }
  if (!peer) {
    process.stderr.write('Missing --peer argument\n');
    process.stderr.write('Usage: node discover-peer.mjs --peer <codex|claude>\n');
    process.exit(2);
  }
  const result = await discoverPeerCompanion({ peer });
  if (result.ok) {
    process.stdout.write(result.path + '\n');
    process.exit(0);
  }
  process.stderr.write(`discover-peer: ${result.reason}\n`);
  process.exit(1);
}
