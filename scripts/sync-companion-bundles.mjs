#!/usr/bin/env node
// Sync the canonical companions/{claude,codex}-companion.mjs scripts into
// plugins/companions/scripts/ as byte-identical copies (ADR-0008 § (d)).
//
//   node scripts/sync-companion-bundles.mjs            # drift-detector mode
//   node scripts/sync-companion-bundles.mjs --write    # write mode
//
// Drift-detector mode (default): compares canonical vs bundled and exits 1
// if any pair differs or any bundled copy is missing. Used by CI guards
// and as the default invocation for contributors verifying state before
// commit.
//
// Write mode (--write): copies canonical content into the bundle, creating
// the destination directory if needed. Preserves the executable bit.
//
// This script is referenced by ADR-0008 § (d) decision (1) and powers the
// drift detector test in tests/plugin-shape/test-companions-plugin.mjs.

import { readFile, writeFile, mkdir, chmod, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../..');
const CANONICAL_DIR = resolve(REPO_ROOT, 'companions');
const BUNDLE_DIR = resolve(REPO_ROOT, 'plugins/companions/scripts');
const SCRIPTS = ['claude-companion.mjs', 'codex-companion.mjs'];

const args = process.argv.slice(2);
const writeMode = args.includes('--write');
const unknown = args.filter((a) => a !== '--write');
if (unknown.length > 0) {
  console.error(`Unknown argument(s): ${unknown.join(', ')}`);
  console.error('Usage: node scripts/sync-companion-bundles.mjs [--write]');
  process.exit(2);
}

let driftCount = 0;
const results = [];

for (const name of SCRIPTS) {
  const canonicalPath = resolve(CANONICAL_DIR, name);
  const bundlePath = resolve(BUNDLE_DIR, name);

  let canonicalBytes;
  try {
    canonicalBytes = await readFile(canonicalPath);
  } catch (err) {
    console.error(`✗ canonical missing: ${canonicalPath} (${err.code})`);
    process.exit(1);
  }

  let bundleBytes = null;
  try {
    bundleBytes = await readFile(bundlePath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`✗ failed to read ${bundlePath}: ${err.message}`);
      process.exit(1);
    }
  }

  const matches = bundleBytes !== null && canonicalBytes.equals(bundleBytes);

  if (matches) {
    results.push({ name, status: 'ok' });
    continue;
  }

  driftCount += 1;

  if (!writeMode) {
    if (bundleBytes === null) {
      results.push({ name, status: 'missing' });
    } else {
      results.push({
        name,
        status: 'drift',
        canonicalLen: canonicalBytes.length,
        bundleLen: bundleBytes.length,
      });
    }
    continue;
  }

  await mkdir(dirname(bundlePath), { recursive: true });
  await writeFile(bundlePath, canonicalBytes);

  const canonicalStat = await stat(canonicalPath);
  await chmod(bundlePath, canonicalStat.mode & 0o777);

  results.push({ name, status: 'written' });
}

for (const r of results) {
  switch (r.status) {
    case 'ok':
      console.log(`✓ ${r.name}: identical`);
      break;
    case 'written':
      console.log(`✓ ${r.name}: synced from canonical`);
      break;
    case 'missing':
      console.error(`✗ ${r.name}: bundle copy missing at plugins/companions/scripts/`);
      break;
    case 'drift':
      console.error(
        `✗ ${r.name}: drift detected (canonical=${r.canonicalLen}B, bundle=${r.bundleLen}B)`
      );
      break;
  }
}

if (writeMode) {
  process.exit(0);
}

if (driftCount > 0) {
  console.error('');
  console.error(
    `Drift detected in ${driftCount} script(s). Run \`npm run sync:companions -- --write\` to sync.`
  );
  process.exit(1);
}

console.log('OK — all bundle copies match canonical');
