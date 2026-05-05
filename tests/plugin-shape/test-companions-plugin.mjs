// plugins/companions plugin-shape conformance test (B.1).
//
// Asserts the companions plugin manifests are well-formed for both hosts,
// the bundled companion scripts ship at scripts/{claude,codex}-companion.mjs
// with executable bits, and the bundled copies stay byte-identical to the
// canonical companions/{claude,codex}-companion.mjs (drift detector).
//
// Run via `node --test tests/plugin-shape/test-companions-plugin.mjs`.

import { describe, it } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const PLUGIN_ROOT = resolve(REPO_ROOT, 'plugins/companions');
const CANONICAL_DIR = resolve(REPO_ROOT, 'companions');

async function readJSON(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

describe('plugins/companions — Claude manifest (.claude-plugin/plugin.json)', () => {
  const path = resolve(PLUGIN_ROOT, '.claude-plugin/plugin.json');

  it('parses as JSON', async () => {
    const json = await readJSON(path);
    strictEqual(typeof json, 'object');
    ok(json !== null);
  });

  it('has required scalar fields', async () => {
    const json = await readJSON(path);
    strictEqual(json.name, 'companions');
    strictEqual(typeof json.version, 'string');
    ok(/^\d+\.\d+\.\d+/.test(json.version), `version "${json.version}" not SemVer-shaped`);
    strictEqual(typeof json.description, 'string');
    ok(json.description.length > 0);
  });

  it('has author block', async () => {
    const json = await readJSON(path);
    ok(json.author, 'author missing');
    strictEqual(typeof json.author, 'object');
    strictEqual(json.author.name, 'each4all');
  });
});

describe('plugins/companions — Codex manifest (.codex-plugin/plugin.json)', () => {
  const path = resolve(PLUGIN_ROOT, '.codex-plugin/plugin.json');

  it('parses as JSON', async () => {
    const json = await readJSON(path);
    strictEqual(typeof json, 'object');
    ok(json !== null);
  });

  it('has required scalar fields per Codex vendored spec', async () => {
    const json = await readJSON(path);
    strictEqual(json.name, 'companions');
    for (const field of ['version', 'description', 'homepage', 'license']) {
      strictEqual(typeof json[field], 'string', `${field} missing or non-string`);
      ok(json[field].length > 0, `${field} empty`);
    }
    ok(/^\d+\.\d+\.\d+/.test(json.version), `version "${json.version}" not SemVer-shaped`);
  });

  it('has author and repository as objects or strings', async () => {
    const json = await readJSON(path);
    ok(json.author, 'author missing');
    ok(json.repository, 'repository missing');
  });

  it('has keywords array', async () => {
    const json = await readJSON(path);
    ok(Array.isArray(json.keywords), 'keywords not an array');
    ok(json.keywords.length > 0, 'keywords empty');
  });

  it('has skills field per Codex vendored spec (REQUIRED)', async () => {
    const json = await readJSON(path);
    strictEqual(json.skills, './skills/');
  });

  it('has interface block with required sub-fields', async () => {
    const json = await readJSON(path);
    const i = json.interface;
    ok(i, 'interface block missing');
    strictEqual(typeof i.displayName, 'string');
    strictEqual(typeof i.shortDescription, 'string');
    strictEqual(typeof i.longDescription, 'string');
    strictEqual(typeof i.developerName, 'string');
    strictEqual(typeof i.category, 'string');
    ok(Array.isArray(i.capabilities), 'capabilities not array');
    ok(i.capabilities.length > 0, 'capabilities empty');
  });

  it('interface.defaultPrompt has at most 3 entries, each ≤128 chars', async () => {
    const json = await readJSON(path);
    const dp = json.interface.defaultPrompt;
    ok(Array.isArray(dp), 'defaultPrompt not array');
    ok(dp.length <= 3, `defaultPrompt has ${dp.length} entries (max 3)`);
    for (const entry of dp) {
      strictEqual(typeof entry, 'string');
      ok(entry.length <= 128, `defaultPrompt entry exceeds 128 chars: ${entry.length}`);
    }
  });
});

describe('plugins/companions — bundled scripts', () => {
  for (const name of ['claude-companion.mjs', 'codex-companion.mjs']) {
    describe(name, () => {
      const path = resolve(PLUGIN_ROOT, 'scripts', name);

      it('exists as a regular file', async () => {
        const st = await stat(path);
        ok(st.isFile(), `${name} is not a regular file`);
      });

      it('has the executable bit set', async () => {
        const st = await stat(path);
        ok((st.mode & 0o111) !== 0, `${name} executable bit not set (mode=${(st.mode & 0o777).toString(8)})`);
      });
    });
  }
});

describe('plugins/companions — drift detector vs canonical companions/', () => {
  for (const name of ['claude-companion.mjs', 'codex-companion.mjs', 'discover-peer.mjs']) {
    it(`${name} bundled copy is byte-identical to canonical`, async () => {
      const canonical = await readFile(resolve(CANONICAL_DIR, name));
      const bundled = await readFile(resolve(PLUGIN_ROOT, 'scripts', name));
      ok(
        canonical.equals(bundled),
        `${name}: bundled copy diverged from canonical (canonical=${canonical.length}B, bundled=${bundled.length}B). Run \`npm run sync:companions -- --write\`.`
      );
    });
  }
});

describe('plugins/companions — discover-peer.mjs library (added v0.3.0)', () => {
  const path = resolve(PLUGIN_ROOT, 'scripts', 'discover-peer.mjs');

  it('exists as a regular file', async () => {
    const st = await stat(path);
    ok(st.isFile(), 'discover-peer.mjs is not a regular file');
  });

  it('has the executable bit set', async () => {
    const st = await stat(path);
    ok((st.mode & 0o111) !== 0, `discover-peer.mjs executable bit not set (mode=${(st.mode & 0o777).toString(8)})`);
  });

  it('exports discoverPeerCompanion', async () => {
    const mod = await import(path);
    strictEqual(typeof mod.discoverPeerCompanion, 'function');
  });

  it('exports helpers (preflight, fileExists, dirExists, semverCompare)', async () => {
    const mod = await import(path);
    for (const helper of ['preflight', 'fileExists', 'dirExists', 'semverCompare']) {
      strictEqual(typeof mod[helper], 'function', `${helper} not exported`);
    }
  });

  it('rejects unknown peer values', async () => {
    const { discoverPeerCompanion } = await import(path);
    const result = await discoverPeerCompanion({ peer: 'invalid' });
    strictEqual(result.ok, false);
    ok(/peer must be/.test(result.reason), `reason: ${result.reason}`);
  });

  it('semverCompare orders versions correctly', async () => {
    const { semverCompare } = await import(path);
    ok(semverCompare('0.3.0', '0.2.0') > 0);
    ok(semverCompare('0.2.0', '0.3.0') < 0);
    strictEqual(semverCompare('0.3.0', '0.3.0'), 0);
    ok(semverCompare('1.0.0', '0.9.9') > 0);
  });
});
