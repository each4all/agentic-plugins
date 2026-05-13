// plugins/runtime/scripts/version.mjs
//
// Runtime script version follows the plugin manifest so release-please can keep
// one source of truth. Scripts may run from source or from a host cache; both
// layouts keep manifests beside the scripts directory.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = dirname(SCRIPT_DIR);

export const RUNTIME_VERSION = loadRuntimeVersion();

function loadRuntimeVersion() {
  for (const relPath of [
    join('.codex-plugin', 'plugin.json'),
    join('.claude-plugin', 'plugin.json'),
  ]) {
    try {
      const manifest = JSON.parse(readFileSync(join(PLUGIN_ROOT, relPath), 'utf8'));
      if (typeof manifest.version === 'string' && manifest.version.trim()) {
        return manifest.version.trim();
      }
    } catch {
      // Keep looking; source checkouts and host caches should have at least
      // one manifest, but tests and ad-hoc script copies may not.
    }
  }
  return '0.0.0-dev';
}
