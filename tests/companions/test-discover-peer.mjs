// companions/discover-peer.mjs — the canonical companion discovery library.
//
// ADR-0061 §Decision 3 replaced the Codex candidate of ADR-0008 § (b): a
// caller on Codex resolves `claude-companion.mjs` from Codex's versioned
// install cache, `<CODEX_HOME or ~/.codex>/plugins/cache/agentic-plugins/
// companions/<version>/`, never from the marketplace clone at
// `~/.codex/.tmp/marketplaces/…`, which tracks `main` rather than a release.
//
// Every fixture lives under a scratch HOME, and CODEX_HOME is set explicitly
// where the test is about it, so nothing here reads the real ~/.claude or
// ~/.codex.

import { describe, it, before, after } from 'node:test';
import { strictEqual, ok, deepStrictEqual } from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const CANONICAL = join(REPO_ROOT, 'companions', 'discover-peer.mjs');
const BUNDLED = join(REPO_ROOT, 'plugins', 'companions', 'scripts', 'discover-peer.mjs');

const COMPANION_BODY = "const CONTRACT_VERSION = '0.1.1';\nconst FLAGS = ['prompt-file'];\n";
const INCOMPATIBLE_BODY = "const CONTRACT_VERSION = '1.0.0';\nconst FLAGS = ['prompt-file'];\n";

async function plantCompanions(base, version, {
  manifestRel,
  name = 'companions',
  body = COMPANION_BODY,
  files = ['claude-companion.mjs', 'codex-companion.mjs'],
} = {}) {
  const root = join(base, version);
  await mkdir(join(root, 'scripts'), { recursive: true });
  await mkdir(join(root, manifestRel, '..'), { recursive: true });
  await writeFile(join(root, manifestRel), JSON.stringify({ name, version }));
  for (const file of files) await writeFile(join(root, 'scripts', file), body);
  return root;
}

const codexCache = (codexHome) => join(codexHome, 'plugins', 'cache', 'agentic-plugins', 'companions');
const claudeCache = (home) => join(home, '.claude', 'plugins', 'cache', 'agentic-plugins', 'companions');
const snapshot = (codexHome) => join(codexHome, '.tmp', 'marketplaces', 'agentic-plugins', 'plugins', 'companions');
const CODEX_MANIFEST = join('.codex-plugin', 'plugin.json');
const CLAUDE_MANIFEST = join('.claude-plugin', 'plugin.json');

describe('discover-peer.mjs — the canonical copy and its bundle are the same library', () => {
  it('byte-identical (scripts/sync-companion-bundles.mjs owns the copy)', async () => {
    strictEqual(await readFile(BUNDLED, 'utf8'), await readFile(CANONICAL, 'utf8'));
  });
});

describe('discover-peer.mjs — default candidates (ADR-0061 §Decision 3)', () => {
  let scratch;
  let discoverPeerCompanion;
  before(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'discover-peer-'));
    ({ discoverPeerCompanion } = await import(CANONICAL));
  });
  after(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  it('peer=claude resolves from the Codex install cache under a custom CODEX_HOME', async () => {
    const home = join(scratch, 'custom-home');
    const codexHome = join(scratch, 'elsewhere', 'codex-home');
    const root = await plantCompanions(codexCache(codexHome), '0.5.0', { manifestRel: CODEX_MANIFEST });
    const result = await discoverPeerCompanion({ peer: 'claude', env: { CODEX_HOME: codexHome }, home });
    strictEqual(result.ok, true, result.reason);
    strictEqual(result.path, join(root, 'scripts', 'claude-companion.mjs'));
    strictEqual(result.version, '0.5.0');
  });

  it('peer=claude never resolves the marketplace clone, even when it is the only copy', async () => {
    const home = join(scratch, 'snapshot-only-home');
    const codexHome = join(home, '.codex');
    const clone = snapshot(codexHome);
    await mkdir(join(clone, 'scripts'), { recursive: true });
    await mkdir(join(clone, '.codex-plugin'), { recursive: true });
    await writeFile(join(clone, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'companions', version: '9.9.9' }));
    await writeFile(join(clone, 'scripts', 'claude-companion.mjs'), COMPANION_BODY);
    const result = await discoverPeerCompanion({ peer: 'claude', env: {}, home });
    strictEqual(result.ok, false);
    ok(!String(result.reason).includes('.tmp'), `reason names the clone: ${result.reason}`);
  });

  it('peer=claude defaults CODEX_HOME to ~/.codex when unset', async () => {
    const home = join(scratch, 'default-codex-home');
    const root = await plantCompanions(codexCache(join(home, '.codex')), '0.4.2', { manifestRel: CODEX_MANIFEST });
    const result = await discoverPeerCompanion({ peer: 'claude', env: {}, home });
    strictEqual(result.path, join(root, 'scripts', 'claude-companion.mjs'));
  });

  it('peer=claude verifies the Codex manifest name and takes the newest compatible version', async () => {
    const home = join(scratch, 'retained-home');
    const base = codexCache(join(home, '.codex'));
    await plantCompanions(base, '0.4.0', { manifestRel: CODEX_MANIFEST });
    const newestCompatible = await plantCompanions(base, '0.4.3', { manifestRel: CODEX_MANIFEST });
    await plantCompanions(base, '0.6.0', { manifestRel: CODEX_MANIFEST, body: INCOMPATIBLE_BODY });
    await plantCompanions(base, '0.9.0', { manifestRel: CODEX_MANIFEST, name: 'engineer' });
    // A version directory carrying only the Claude manifest is not a Codex install.
    await plantCompanions(base, '0.8.0', { manifestRel: CLAUDE_MANIFEST });
    const result = await discoverPeerCompanion({ peer: 'claude', env: {}, home });
    strictEqual(result.path, join(newestCompatible, 'scripts', 'claude-companion.mjs'));
    strictEqual(result.version, '0.4.3');
  });

  it('peer=codex resolves from the Claude install cache', async () => {
    const home = join(scratch, 'claude-home');
    const root = await plantCompanions(claudeCache(home), '0.4.1', { manifestRel: CLAUDE_MANIFEST });
    await plantCompanions(codexCache(join(home, '.codex')), '0.9.0', { manifestRel: CODEX_MANIFEST });
    const result = await discoverPeerCompanion({ peer: 'codex', env: {}, home });
    strictEqual(result.path, join(root, 'scripts', 'codex-companion.mjs'));
  });

  it('an explicit cacheBase/manifestPath overrides the host default (consumer bootstraps pass one)', async () => {
    const home = join(scratch, 'explicit-home');
    const base = join(scratch, 'explicit-base');
    const root = await plantCompanions(base, '1.0.0', { manifestRel: CLAUDE_MANIFEST });
    const result = await discoverPeerCompanion({
      peer: 'claude',
      env: {},
      home,
      cacheBase: base,
      layout: 'multi-version',
      manifestPath: CLAUDE_MANIFEST,
    });
    strictEqual(result.path, join(root, 'scripts', 'claude-companion.mjs'));
  });

  it("the retired 'single' (marketplace-clone) layout is refused", async () => {
    const base = join(scratch, 'single-layout');
    await mkdir(base, { recursive: true });
    const result = await discoverPeerCompanion({ peer: 'claude', env: {}, cacheBase: base, layout: 'single' });
    deepStrictEqual(result, { ok: false, reason: 'unknown layout: single' });
  });

  it('the CLI honors CODEX_HOME from its environment', async () => {
    const home = join(scratch, 'cli-home');
    const codexHome = join(scratch, 'cli-codex-home');
    const root = await plantCompanions(codexCache(codexHome), '0.5.1', { manifestRel: CODEX_MANIFEST });
    const run = spawnSync(process.execPath, [CANONICAL, '--peer', 'claude'], {
      env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: codexHome },
      encoding: 'utf8',
    });
    strictEqual(run.status, 0, run.stderr);
    strictEqual(run.stdout.trim(), join(root, 'scripts', 'claude-companion.mjs'));
  });
});
