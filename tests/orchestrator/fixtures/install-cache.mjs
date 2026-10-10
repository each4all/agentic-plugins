// tests/orchestrator/fixtures/install-cache.mjs
//
// A Claude Code install cache laid out as a real install is: each version
// directory holds the plugin's manifest and, under scripts/, an empty file
// for every top-level file this repository's plugins/<plugin>/scripts/ has.
// A lookup that checks a file the plugin does not ship (runtime has no
// scripts/state.mjs) then finds nothing here, as on a real machine; a fixture
// that plants the file the code looks for would hide that (ADR-0067 WP, C1).

import { mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../../..');

/** The top-level files of this repository's plugins/<plugin>/scripts/. */
export function releaseScripts(plugin) {
  return readdirSync(join(REPO_ROOT, 'plugins', plugin, 'scripts'), { withFileTypes: true })
    .filter((e) => e.isFile()).map((e) => e.name).sort();
}

/**
 * Install `plugin` `version` under `home`'s Claude Code cache, laid out as a
 * release; `scripts` names the files instead (an empty list: a release with
 * no scripts), and `name` the manifest's plugin name. Returns the canonical
 * version directory.
 */
export function installLikeRelease(home, plugin, version, { name = plugin, scripts = releaseScripts(plugin) } = {}) {
  const root = join(home, '.claude', 'plugins', 'cache', 'agentic-plugins', plugin, version);
  mkdirSync(join(root, '.claude-plugin'), { recursive: true });
  writeFileSync(join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, version }));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  for (const file of scripts) writeFileSync(join(root, 'scripts', file), '');
  return realpathSync(root);
}
