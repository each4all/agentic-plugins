// plugins/research adapter discover-companion unit tests.
//
// Covers both Claude side (~/.claude/plugins/cache layout, SemVer-descending
// among multiple versions) and Codex side (zero-wildcard
// ~/.codex/.tmp/marketplaces layout per ADR-0008 § (b) Amendment
// 2026-05-04). Each test uses a hermetic per-test temporary directory
// passed through the discover() function's injectable `cacheBase` param —
// no real ~/.claude or ~/.codex paths are touched.
//
// Run via `node --test tests/research/test-discover-companion.mjs`.

import { describe, it, before, after } from 'node:test';
import { strictEqual, ok } from 'node:assert/strict';
import { mkdir, writeFile, rm, copyFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { discover as discoverClaude } from '../../plugins/research/adapters/claude/scripts/discover-companion.mjs';
import { discover as discoverCodex } from '../../plugins/research/adapters/codex/scripts/discover-companion.mjs';

// Real discover-peer.mjs source path — copied into env-roots and cache
// version dirs so the wrappers can import it (companions v0.3.0+ contract:
// the discovery library lives alongside the script pair).
const REAL_DISCOVER_PEER = resolve(
  fileURLToPath(import.meta.url),
  '../../../plugins/companions/scripts/discover-peer.mjs',
);

const FAUX_VALID_COMPANION = `#!/usr/bin/env node
// faux companion for tests
const CONTRACT_VERSION = "0.1.0";
const opts = ["prompt-file", "model"];
process.exit(0);
`;

const FAUX_NO_PROMPT_FILE = `#!/usr/bin/env node
// faux companion missing --prompt-file marker
const CONTRACT_VERSION = "0.1.0";
process.exit(0);
`;

const FAUX_INCOMPATIBLE_VERSION = `#!/usr/bin/env node
const CONTRACT_VERSION = "1.0.0";
const opts = ["prompt-file"];
process.exit(0);
`;

let TMP;

before(async () => {
  TMP = join(tmpdir(), `discover-companion-test-${process.pid}-${Date.now()}`);
  await mkdir(TMP, { recursive: true });
});

after(async () => {
  await rm(TMP, { recursive: true, force: true });
});

async function makeEnvRoot(label, companionName, body = FAUX_VALID_COMPANION, opts = {}) {
  const { includeDiscoverPeer = true } = opts;
  const root = join(TMP, label);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, companionName), body);
  if (includeDiscoverPeer) {
    await copyFile(REAL_DISCOVER_PEER, join(root, 'discover-peer.mjs'));
  }
  return root;
}

async function makeClaudeCachedVersion(base, version, opts = {}) {
  const {
    manifestName = 'companions',
    companionBody = FAUX_VALID_COMPANION,
    companionName = 'codex-companion.mjs',
    includeCompanion = true,
    includeDiscoverPeer = true,
  } = opts;
  const versionDir = join(base, version);
  const claudePluginDir = join(versionDir, '.claude-plugin');
  await mkdir(claudePluginDir, { recursive: true });
  await writeFile(
    join(claudePluginDir, 'plugin.json'),
    JSON.stringify({ name: manifestName, version }),
  );
  const scriptsDir = join(versionDir, 'scripts');
  if (includeCompanion || includeDiscoverPeer) {
    await mkdir(scriptsDir, { recursive: true });
  }
  if (includeCompanion) {
    await writeFile(join(scriptsDir, companionName), companionBody);
  }
  if (includeDiscoverPeer) {
    await copyFile(REAL_DISCOVER_PEER, join(scriptsDir, 'discover-peer.mjs'));
  }
}

async function makeCodexCache(base, opts = {}) {
  const {
    manifestName = 'companions',
    companionBody = FAUX_VALID_COMPANION,
    companionName = 'claude-companion.mjs',
    includeCompanion = true,
    includeDiscoverPeer = true,
    manifestVersion = '0.1.0',
    manifestText, // raw override
  } = opts;
  const codexPluginDir = join(base, '.codex-plugin');
  await mkdir(codexPluginDir, { recursive: true });
  await writeFile(
    join(codexPluginDir, 'plugin.json'),
    manifestText ?? JSON.stringify({ name: manifestName, version: manifestVersion }),
  );
  const scriptsDir = join(base, 'scripts');
  if (includeCompanion || includeDiscoverPeer) {
    await mkdir(scriptsDir, { recursive: true });
  }
  if (includeCompanion) {
    await writeFile(join(scriptsDir, companionName), companionBody);
  }
  if (includeDiscoverPeer) {
    await copyFile(REAL_DISCOVER_PEER, join(scriptsDir, 'discover-peer.mjs'));
  }
}

describe('claude/discover-companion — env override (AGENTIC_COMPANIONS_ROOT)', () => {
  it('discovers companion when env path holds a valid script', async () => {
    const root = await makeEnvRoot('claude-env-valid', 'codex-companion.mjs');
    const result = await discoverClaude({
      env: { AGENTIC_COMPANIONS_ROOT: root },
      cacheBase: '/nonexistent',
    });
    ok(result.ok, `expected ok=true, got ${JSON.stringify(result)}`);
    strictEqual(result.source, 'env');
  });

  it('rejects a relative env path', async () => {
    const result = await discoverClaude({
      env: { AGENTIC_COMPANIONS_ROOT: 'relative/path' },
      cacheBase: '/nonexistent',
    });
    ok(!result.ok);
    ok(/absolute path/.test(result.reason), `expected "absolute path" hint, got: ${result.reason}`);
  });

  it('reports not-found when env path lacks the companion', async () => {
    const root = join(TMP, 'claude-env-empty');
    await mkdir(root, { recursive: true });
    const result = await discoverClaude({
      env: { AGENTIC_COMPANIONS_ROOT: root },
      cacheBase: '/nonexistent',
    });
    ok(!result.ok);
    ok(/not found/.test(result.reason), `expected "not found" hint, got: ${result.reason}`);
  });

  it('fails preflight when companion lacks the --prompt-file marker', async () => {
    const root = await makeEnvRoot('claude-env-no-pf', 'codex-companion.mjs', FAUX_NO_PROMPT_FILE);
    const result = await discoverClaude({
      env: { AGENTIC_COMPANIONS_ROOT: root },
      cacheBase: '/nonexistent',
    });
    ok(!result.ok);
    ok(/preflight/.test(result.reason), `expected "preflight" hint, got: ${result.reason}`);
  });

  it('fails preflight when CONTRACT_VERSION major mismatches', async () => {
    const root = await makeEnvRoot('claude-env-incompat', 'codex-companion.mjs', FAUX_INCOMPATIBLE_VERSION);
    const result = await discoverClaude({
      env: { AGENTIC_COMPANIONS_ROOT: root },
      cacheBase: '/nonexistent',
    });
    ok(!result.ok);
    ok(/preflight/.test(result.reason), `expected "preflight" hint, got: ${result.reason}`);
  });

  it('falls through to cache-glob when env var is empty string', async () => {
    const base = join(TMP, 'claude-env-empty-fallthrough');
    await makeClaudeCachedVersion(base, '0.1.0');
    const result = await discoverClaude({
      env: { AGENTIC_COMPANIONS_ROOT: '' },
      cacheBase: base,
    });
    ok(result.ok);
    strictEqual(result.source, 'cache-glob');
  });

  it('fails with clear diagnostic when env root has companion but lacks discover-peer.mjs (v0.3.0+ contract)', async () => {
    const root = await makeEnvRoot(
      'claude-env-no-discover-peer',
      'codex-companion.mjs',
      FAUX_VALID_COMPANION,
      { includeDiscoverPeer: false },
    );
    const result = await discoverClaude({
      env: { AGENTIC_COMPANIONS_ROOT: root },
      cacheBase: '/nonexistent',
    });
    ok(!result.ok);
    ok(/discover-peer\.mjs not found/.test(result.reason), `expected "discover-peer.mjs not found" hint, got: ${result.reason}`);
    ok(/companions v0\.3\.0\+/.test(result.reason), `expected "companions v0.3.0+" hint, got: ${result.reason}`);
  });
});

describe('claude/discover-companion — cache-glob fallback', () => {
  it('reports not-installed when cache base directory is missing', async () => {
    const result = await discoverClaude({
      env: {},
      cacheBase: join(TMP, 'claude-cache-never-existed'),
    });
    ok(!result.ok);
    ok(/not installed/.test(result.reason));
  });

  it('reports not-installed when cache contains version dirs without plugin.json', async () => {
    // The wrapper's bootstrap requires a manifest-verified version dir
    // with discover-peer.mjs; missing manifest → no candidates → bootstrap
    // returns null → unified "not installed" reason.
    const base = join(TMP, 'claude-no-manifests');
    await mkdir(join(base, '0.1.0'), { recursive: true });
    const result = await discoverClaude({ env: {}, cacheBase: base });
    ok(!result.ok);
    ok(/not installed/.test(result.reason));
  });

  it('discovers a single valid version', async () => {
    const base = join(TMP, 'claude-single-version');
    await makeClaudeCachedVersion(base, '0.1.0');
    const result = await discoverClaude({ env: {}, cacheBase: base });
    ok(result.ok);
    strictEqual(result.source, 'cache-glob');
    strictEqual(result.version, '0.1.0');
  });

  it('selects the highest SemVer when multiple valid versions exist', async () => {
    const base = join(TMP, 'claude-multi-version');
    await makeClaudeCachedVersion(base, '0.1.0');
    await makeClaudeCachedVersion(base, '0.2.0');
    await makeClaudeCachedVersion(base, '0.1.5');
    const result = await discoverClaude({ env: {}, cacheBase: base });
    ok(result.ok);
    strictEqual(result.version, '0.2.0');
  });

  it('skips manifests whose name is not "companions"', async () => {
    const base = join(TMP, 'claude-wrong-manifest-name');
    await makeClaudeCachedVersion(base, '0.5.0', { manifestName: 'imposter' });
    await makeClaudeCachedVersion(base, '0.2.0');
    const result = await discoverClaude({ env: {}, cacheBase: base });
    ok(result.ok);
    strictEqual(result.version, '0.2.0');
  });

  it('falls through to next valid version when newest fails preflight', async () => {
    const base = join(TMP, 'claude-newest-bad-preflight');
    await makeClaudeCachedVersion(base, '0.1.0');
    await makeClaudeCachedVersion(base, '0.2.0', { companionBody: FAUX_NO_PROMPT_FILE });
    const result = await discoverClaude({ env: {}, cacheBase: base });
    ok(result.ok);
    strictEqual(result.version, '0.1.0');
  });

  it('reports no-preflight-pass when every candidate fails preflight', async () => {
    const base = join(TMP, 'claude-all-bad-preflight');
    await makeClaudeCachedVersion(base, '0.1.0', { companionBody: FAUX_NO_PROMPT_FILE });
    await makeClaudeCachedVersion(base, '0.2.0', { companionBody: FAUX_INCOMPATIBLE_VERSION });
    const result = await discoverClaude({ env: {}, cacheBase: base });
    ok(!result.ok);
    ok(/preflight/.test(result.reason));
  });
});

describe('codex/discover-companion — env override (AGENTIC_COMPANIONS_ROOT)', () => {
  it('discovers companion when env path holds a valid script', async () => {
    const root = await makeEnvRoot('codex-env-valid', 'claude-companion.mjs');
    const result = await discoverCodex({
      env: { AGENTIC_COMPANIONS_ROOT: root },
      cacheBase: '/nonexistent',
    });
    ok(result.ok);
    strictEqual(result.source, 'env');
  });

  it('rejects a relative env path', async () => {
    const result = await discoverCodex({
      env: { AGENTIC_COMPANIONS_ROOT: 'relative/path' },
      cacheBase: '/nonexistent',
    });
    ok(!result.ok);
    ok(/absolute path/.test(result.reason));
  });

  it('reports not-found when env path lacks the companion', async () => {
    const root = join(TMP, 'codex-env-empty');
    await mkdir(root, { recursive: true });
    const result = await discoverCodex({
      env: { AGENTIC_COMPANIONS_ROOT: root },
      cacheBase: '/nonexistent',
    });
    ok(!result.ok);
    ok(/not found/.test(result.reason));
  });

  it('fails preflight when companion lacks the --prompt-file marker', async () => {
    const root = await makeEnvRoot('codex-env-no-pf', 'claude-companion.mjs', FAUX_NO_PROMPT_FILE);
    const result = await discoverCodex({
      env: { AGENTIC_COMPANIONS_ROOT: root },
      cacheBase: '/nonexistent',
    });
    ok(!result.ok);
    ok(/preflight/.test(result.reason));
  });

  it('fails with clear diagnostic when env root has companion but lacks discover-peer.mjs (v0.3.0+ contract)', async () => {
    const root = await makeEnvRoot(
      'codex-env-no-discover-peer',
      'claude-companion.mjs',
      FAUX_VALID_COMPANION,
      { includeDiscoverPeer: false },
    );
    const result = await discoverCodex({
      env: { AGENTIC_COMPANIONS_ROOT: root },
      cacheBase: '/nonexistent',
    });
    ok(!result.ok);
    ok(/discover-peer\.mjs not found/.test(result.reason), `expected "discover-peer.mjs not found" hint, got: ${result.reason}`);
    ok(/companions v0\.3\.0\+/.test(result.reason), `expected "companions v0.3.0+" hint, got: ${result.reason}`);
  });
});

describe('codex/discover-companion — zero-wildcard cache', () => {
  it('reports not-installed when cache base directory is missing', async () => {
    const result = await discoverCodex({
      env: {},
      cacheBase: join(TMP, 'codex-cache-never-existed'),
    });
    ok(!result.ok);
    ok(/not installed/.test(result.reason));
  });

  it('discovers a valid cached plugin', async () => {
    const base = join(TMP, 'codex-cache-valid');
    await makeCodexCache(base);
    const result = await discoverCodex({ env: {}, cacheBase: base });
    ok(result.ok);
    strictEqual(result.source, 'cache');
    strictEqual(result.version, '0.1.0');
  });

  it('reports not-installed when plugin.json is malformed JSON', async () => {
    // Wrapper bootstrap silently treats unparseable manifest as missing →
    // unified "not installed or discover-peer.mjs missing" reason.
    const base = join(TMP, 'codex-cache-bad-json');
    await makeCodexCache(base, { manifestText: '{not valid json' });
    const result = await discoverCodex({ env: {}, cacheBase: base });
    ok(!result.ok);
    ok(/not installed|discover-peer\.mjs missing/.test(result.reason));
  });

  it('reports not-installed when manifest name != "companions"', async () => {
    const base = join(TMP, 'codex-cache-wrong-name');
    await makeCodexCache(base, { manifestName: 'imposter' });
    const result = await discoverCodex({ env: {}, cacheBase: base });
    ok(!result.ok);
    ok(/not installed|discover-peer\.mjs missing/.test(result.reason));
  });

  it('reports companion-file missing when only the manifest is present', async () => {
    const base = join(TMP, 'codex-cache-no-companion');
    await makeCodexCache(base, { includeCompanion: false });
    const result = await discoverCodex({ env: {}, cacheBase: base });
    ok(!result.ok);
    ok(/not found/.test(result.reason));
  });

  it('fails preflight when companion lacks the --prompt-file marker', async () => {
    const base = join(TMP, 'codex-cache-no-pf');
    await makeCodexCache(base, { companionBody: FAUX_NO_PROMPT_FILE });
    const result = await discoverCodex({ env: {}, cacheBase: base });
    ok(!result.ok);
    ok(/preflight/.test(result.reason));
  });
});
