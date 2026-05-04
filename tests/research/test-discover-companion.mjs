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
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { discover as discoverClaude } from '../../plugins/research/adapters/claude/scripts/discover-companion.mjs';
import { discover as discoverCodex } from '../../plugins/research/adapters/codex/scripts/discover-companion.mjs';

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

async function makeEnvRoot(label, companionName, body = FAUX_VALID_COMPANION) {
  const root = join(TMP, label);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, companionName), body);
  return root;
}

async function makeClaudeCachedVersion(base, version, opts = {}) {
  const {
    manifestName = 'companions',
    companionBody = FAUX_VALID_COMPANION,
    companionName = 'codex-companion.mjs',
    includeCompanion = true,
  } = opts;
  const versionDir = join(base, version);
  const claudePluginDir = join(versionDir, '.claude-plugin');
  await mkdir(claudePluginDir, { recursive: true });
  await writeFile(
    join(claudePluginDir, 'plugin.json'),
    JSON.stringify({ name: manifestName, version }),
  );
  if (includeCompanion) {
    const scriptsDir = join(versionDir, 'scripts');
    await mkdir(scriptsDir, { recursive: true });
    await writeFile(join(scriptsDir, companionName), companionBody);
  }
}

async function makeCodexCache(base, opts = {}) {
  const {
    manifestName = 'companions',
    companionBody = FAUX_VALID_COMPANION,
    companionName = 'claude-companion.mjs',
    includeCompanion = true,
    manifestVersion = '0.1.0',
    manifestText, // raw override
  } = opts;
  const codexPluginDir = join(base, '.codex-plugin');
  await mkdir(codexPluginDir, { recursive: true });
  await writeFile(
    join(codexPluginDir, 'plugin.json'),
    manifestText ?? JSON.stringify({ name: manifestName, version: manifestVersion }),
  );
  if (includeCompanion) {
    const scriptsDir = join(base, 'scripts');
    await mkdir(scriptsDir, { recursive: true });
    await writeFile(join(scriptsDir, companionName), companionBody);
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

  it('reports no-manifest when cache contains version dirs without plugin.json', async () => {
    const base = join(TMP, 'claude-no-manifests');
    await mkdir(join(base, '0.1.0'), { recursive: true });
    const result = await discoverClaude({ env: {}, cacheBase: base });
    ok(!result.ok);
    ok(/no manifest-verified/.test(result.reason));
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

  it('reports manifest unreadable when plugin.json is malformed JSON', async () => {
    const base = join(TMP, 'codex-cache-bad-json');
    await makeCodexCache(base, { manifestText: '{not valid json' });
    const result = await discoverCodex({ env: {}, cacheBase: base });
    ok(!result.ok);
    ok(/unreadable/.test(result.reason));
  });

  it('reports manifest mismatch when name != "companions"', async () => {
    const base = join(TMP, 'codex-cache-wrong-name');
    await makeCodexCache(base, { manifestName: 'imposter' });
    const result = await discoverCodex({ env: {}, cacheBase: base });
    ok(!result.ok);
    ok(/!=.*companions|"imposter"/.test(result.reason));
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
