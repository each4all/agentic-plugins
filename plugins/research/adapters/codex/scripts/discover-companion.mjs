#!/usr/bin/env node
// adapters/codex/scripts/discover-companion.mjs
//
// Resolves the claude-companion path for the research skill running on
// Codex CLI. The peer host for Codex is Claude.
//
// Implementation: bootstraps the companions plugin cache root (single
// fixed marketplace path per codex-cli 0.128.0), then imports
// plugins/companions/scripts/discover-peer.mjs for the canonical
// discovery algorithm. See plugins/companions/scripts/discover-peer.mjs
// for the resolution order, env override, manifest verification, and
// preflight contract.
//
// Per ADR-0010 §6 trigger evaluation, the discovery algorithm lives inside
// the companions plugin (high cohesion with companion invocation; not spun
// out as a separate framework primitive).
//
// Exit codes:
//   0 — discovered; stdout is the absolute companion path (one line).
//   1 — not found / graceful degradation; stderr summarizes why.
//   2 — misuse (bad arguments).

import { readFile, stat } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';

const PEER = 'claude';
const ENV_VAR = 'AGENTIC_COMPANIONS_ROOT';
const COMPANIONS_ROOT = join(
  homedir(),
  '.codex',
  '.tmp',
  'marketplaces',
  'agentic-plugins',
  'plugins',
  'companions',
);

async function bootstrapCompanionsRoot(cacheBase = COMPANIONS_ROOT) {
  // Cache-only bootstrap (env-override handled separately in discover()).

  if (!(await dirExists(cacheBase))) return null;

  const manifestFile = join(cacheBase, '.codex-plugin', 'plugin.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  } catch {
    return null;
  }
  if (manifest.name !== 'companions') return null;

  const discoverPath = join(cacheBase, 'scripts', 'discover-peer.mjs');
  if (!(await fileExists(discoverPath))) return null;

  return cacheBase;
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

export async function discover({ env = process.env, cacheBase } = {}) {
  // Env-override: AGENTIC_COMPANIONS_ROOT points to a script-pair directory
  // that MUST contain both companion .mjs files AND discover-peer.mjs
  // (companions v0.3.0+ contract). Missing discover-peer.mjs → explicit fail.
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

  const companionsRoot = await bootstrapCompanionsRoot(cacheBase);
  if (!companionsRoot) {
    const usedBase = cacheBase ?? COMPANIONS_ROOT;
    return {
      ok: false,
      reason: `companions plugin not installed at ${usedBase} or discover-peer.mjs missing`,
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
