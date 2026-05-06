// Tests for scripts/sync-marketplace-versions.mjs.
//
// The sync function is a pure operation over a filesystem rooted at
// `repoRoot`, so each test sets up a temp directory with a manifest +
// catalog fixture, calls syncCatalogToManifest, and asserts on the
// returned diffs / written flag and the resulting catalog file.
//
// Run via `node --test tests/scripts/test-sync-marketplace.mjs`.

import { describe, it, beforeEach, afterEach } from 'node:test';
import { strictEqual, deepStrictEqual } from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';

import { syncCatalogToManifest } from '../../scripts/sync-marketplace-versions.mjs';

let repoRoot;

function writeManifest(versions) {
  writeFileSync(
    resolve(repoRoot, '.release-please-manifest.json'),
    JSON.stringify(versions, null, 2) + '\n',
  );
}

function writeCatalog(catalog) {
  mkdirSync(resolve(repoRoot, '.claude-plugin'), { recursive: true });
  writeFileSync(
    resolve(repoRoot, '.claude-plugin/marketplace.json'),
    JSON.stringify(catalog, null, 2) + '\n',
  );
}

function readCatalog() {
  return JSON.parse(
    readFileSync(resolve(repoRoot, '.claude-plugin/marketplace.json'), 'utf8'),
  );
}

describe('sync-marketplace-versions', () => {
  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'sync-marketplace-test-'));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('is a no-op when manifest and catalog already match', () => {
    writeManifest({
      companions: '0.3.0',
      'plugins/companions': '0.3.1',
      'plugins/engineer': '0.3.0',
    });
    writeCatalog({
      schemaVersion: 1,
      name: 'agentic-plugins',
      plugins: [
        { name: 'companions', version: '0.3.1', description: 'A', category: 'X' },
        { name: 'engineer', version: '0.3.0', description: 'B', category: 'Y' },
      ],
    });

    const before = readCatalog();
    const { diffs, written } = syncCatalogToManifest(repoRoot);

    strictEqual(diffs.length, 0, 'expected no diffs');
    strictEqual(written, false, 'expected no write');
    deepStrictEqual(readCatalog(), before, 'catalog should be untouched');
  });

  it('updates entries when manifest version is ahead', () => {
    writeManifest({
      companions: '0.3.0',
      'plugins/companions': '0.3.1',
      'plugins/engineer': '0.4.0',
    });
    writeCatalog({
      schemaVersion: 1,
      name: 'agentic-plugins',
      plugins: [
        { name: 'companions', version: '0.3.1', description: 'A', category: 'X' },
        { name: 'engineer', version: '0.3.0', description: 'B', category: 'Y' },
      ],
    });

    const { diffs, written } = syncCatalogToManifest(repoRoot);

    strictEqual(diffs.length, 1, 'expected 1 diff');
    strictEqual(written, true, 'expected write');
    deepStrictEqual(diffs[0], { name: 'engineer', from: '0.3.0', to: '0.4.0' });

    const after = readCatalog();
    strictEqual(after.plugins[0].version, '0.3.1', 'companions should be unchanged');
    strictEqual(after.plugins[1].version, '0.4.0', 'engineer should be bumped');
  });

  it('preserves all non-version fields on the affected entry', () => {
    writeManifest({ 'plugins/engineer': '0.4.0' });
    writeCatalog({
      $schema: 'https://anthropic.com/claude-code/marketplace.schema.json',
      schemaVersion: 1,
      name: 'agentic-plugins',
      description: 'Catalog desc',
      owner: { name: 'each4all' },
      plugins: [
        {
          name: 'engineer',
          source: './plugins/engineer',
          version: '0.3.0',
          description: 'Engineer plugin desc',
          category: 'Development',
        },
      ],
    });

    syncCatalogToManifest(repoRoot);
    const after = readCatalog();

    // Top-level fields untouched.
    strictEqual(after.$schema, 'https://anthropic.com/claude-code/marketplace.schema.json');
    strictEqual(after.schemaVersion, 1);
    strictEqual(after.name, 'agentic-plugins');
    strictEqual(after.description, 'Catalog desc');
    deepStrictEqual(after.owner, { name: 'each4all' });

    // Plugin entry: only version mutated.
    const entry = after.plugins[0];
    strictEqual(entry.name, 'engineer');
    strictEqual(entry.source, './plugins/engineer');
    strictEqual(entry.description, 'Engineer plugin desc');
    strictEqual(entry.category, 'Development');
    strictEqual(entry.version, '0.4.0');
  });

  it('checkOnly mode reports diffs without writing', () => {
    writeManifest({ 'plugins/engineer': '0.4.0' });
    writeCatalog({
      schemaVersion: 1,
      name: 'agentic-plugins',
      plugins: [{ name: 'engineer', version: '0.3.0' }],
    });

    const before = readCatalog();
    const { diffs, written } = syncCatalogToManifest(repoRoot, { checkOnly: true });

    strictEqual(diffs.length, 1, 'expected 1 diff');
    strictEqual(written, false, 'checkOnly should not write');
    deepStrictEqual(readCatalog(), before, 'catalog should be untouched in checkOnly');
  });

  it('skips manifest entries with no matching catalog plugin', () => {
    writeManifest({
      companions: '0.3.0', // root entry — not a plugins/<name> path
      'plugins/missing': '0.5.0', // no matching catalog entry
      'plugins/engineer': '0.4.0',
    });
    writeCatalog({
      schemaVersion: 1,
      name: 'agentic-plugins',
      plugins: [{ name: 'engineer', version: '0.3.0' }],
    });

    const { diffs } = syncCatalogToManifest(repoRoot);
    strictEqual(diffs.length, 1, 'should only diff entries that exist in both');
    strictEqual(diffs[0].name, 'engineer');
  });
});
