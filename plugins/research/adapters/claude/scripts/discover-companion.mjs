#!/usr/bin/env node
// adapters/claude/scripts/discover-companion.mjs
//
// Resolves the codex-companion path for the research skill running on
// Claude Code. The peer host for Claude is Codex.
//
// Implementation: bootstraps the companions plugin cache root (multi-version
// SemVer scan), then imports plugins/companions/scripts/discover-peer.mjs
// for the canonical discovery algorithm. See plugins/companions/scripts/
// discover-peer.mjs for the resolution order, env override, manifest
// verification, and preflight contract.
//
// Per ADR-0010 §6 trigger evaluation, the discovery algorithm lives inside
// the companions plugin (high cohesion with companion invocation; not spun
// out as a separate framework primitive).
//
// Exit codes:
//   0 — discovered; stdout is the absolute companion path (one line).
//   1 — not found / graceful degradation; stderr summarizes why.
//   2 — misuse (bad arguments).

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

const PEER = 'codex';
const ENV_VAR = 'AGENTIC_COMPANIONS_ROOT';
const COMPANIONS_BASE = join(homedir(), '.claude', 'plugins', 'cache', 'agentic-plugins', 'companions');

async function bootstrapCompanionsRoot(cacheBase = COMPANIONS_BASE) {
  // Cache-glob bootstrap (env-override is handled separately in discover()
  // because env-override layout is script-pair root, not plugin root).

  if (!(await dirExists(cacheBase))) return null;

  let entries = [];
  try {
    entries = await readdir(cacheBase, { withFileTypes: true });
  } catch {
    return null;
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const versionDir = join(cacheBase, entry.name);
    const manifestFile = join(versionDir, '.claude-plugin', 'plugin.json');
    let manifest;
    try {
      manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
    } catch {
      continue;
    }
    if (manifest.name !== 'companions') continue;
    const discoverPath = join(versionDir, 'scripts', 'discover-peer.mjs');
    if (!(await fileExists(discoverPath))) continue;
    candidates.push({
      version: typeof manifest.version === 'string' ? manifest.version : '0.0.0',
      versionDir,
    });
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => semverCompare(b.version, a.version));
  return candidates[0].versionDir;
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

export async function discover({ env = process.env, cacheBase } = {}) {
  // Env-override: AGENTIC_COMPANIONS_ROOT points to a script-pair directory
  // that MUST contain both companion .mjs files AND discover-peer.mjs
  // (companions v0.3.0+ contract — the discovery library lives alongside
  // the script pair). If discover-peer.mjs is missing, fail with a clear
  // diagnostic rather than silently falling back to cache-glob (which
  // would surprise users who set the env override expecting cache to be
  // bypassed).
  const envRoot = env[ENV_VAR];
  if (envRoot && envRoot.length > 0) {
    if (!isAbsolute(envRoot)) {
      return { ok: false, reason: `${ENV_VAR} must be an absolute path: ${envRoot}` };
    }
    const bundled = join(envRoot, 'discover-peer.mjs');
    if (!(await fileExists(bundled))) {
      return {
        ok: false,
        reason: `${ENV_VAR}=${envRoot} but discover-peer.mjs not found in that directory (companions v0.3.0+ requires the discovery library alongside the script pair). Install plugins/companions or update ${ENV_VAR} to a directory containing both companion scripts and discover-peer.mjs.`,
      };
    }
    const { discoverPeerCompanion } = await import(bundled);
    return discoverPeerCompanion({ peer: PEER, env, cacheBase });
  }

  // Cache-glob: bootstrap the companions plugin root, then import.
  const companionsRoot = await bootstrapCompanionsRoot(cacheBase);
  if (!companionsRoot) {
    const usedBase = cacheBase ?? COMPANIONS_BASE;
    return {
      ok: false,
      reason: `companions plugin not installed (${usedBase} not found or empty)`,
    };
  }
  const discoverPeerPath = join(companionsRoot, 'scripts', 'discover-peer.mjs');
  const { discoverPeerCompanion } = await import(discoverPeerPath);
  return discoverPeerCompanion({ peer: PEER, env, cacheBase });
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
