// The test size tier declaration (scripts/data/test-tiers.json) and its loader
// (scripts/lib/suite-tiers.mjs): the pool and the large pass split the files
// they are given, in order, with nothing lost or repeated; a declaration that
// is malformed, unsorted, repeated, unsafe or names a file discovery does not
// find is refused, naming each problem; the repository's own declaration
// loads, and names only discovered files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { listTestFiles } from '../../scripts/lib/discover-tests.mjs';
import { TIERS_FILE, partitionByTier, readTiers, validateTiers } from '../../scripts/lib/suite-tiers.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('partitionByTier splits the files in the order given: disjoint, together the input', () => {
  const files = ['tests/c.mjs', 'tests/a.mjs', 'tests/large-1.mjs', 'tests/b.mjs', 'tests/large-0.mjs'];
  const { pool, large } = partitionByTier(files, ['tests/large-0.mjs', 'tests/large-1.mjs', 'tests/elsewhere.mjs']);
  assert.deepEqual(pool, ['tests/c.mjs', 'tests/a.mjs', 'tests/b.mjs']);
  assert.deepEqual(large, ['tests/large-1.mjs', 'tests/large-0.mjs'], 'order of the input, not of the declaration');
  assert.deepEqual(partitionByTier(files, []), { pool: files, large: [] });
  assert.deepEqual(partitionByTier([], ['tests/a.mjs']), { pool: [], large: [] });
});

test('partitionByTier matches by the key it is given', () => {
  const files = [{ arg: './tests/a.mjs', key: 'tests/a.mjs' }, { arg: '/abs/tests/b.mjs', key: 'tests/b.mjs' }];
  const { pool, large } = partitionByTier(files, ['tests/b.mjs'], (f) => f.key);
  assert.deepEqual(pool.map((f) => f.arg), ['./tests/a.mjs']);
  assert.deepEqual(large.map((f) => f.arg), ['/abs/tests/b.mjs']);
});

test('validateTiers refuses a malformed declaration, naming each problem', () => {
  const discovered = ['tests/test-a.mjs', 'tests/test-b.mjs', 'tests/test-c.mjs'];
  const cases = [
    [null, /is not an object/],
    [[], /is not an object/],
    [{ schema: 2, large: [] }, /schema is not 1/],
    [{ schema: 1 }, /has no large array/],
    [{ schema: 1, large: 'tests/test-a.mjs' }, /has no large array/],
    [{ schema: 1, large: [], small: [] }, /keys it does not declare: small/],
    [{ schema: 1, large: ['tests/test-b.mjs', 'tests/test-a.mjs'] }, /tests\/test-a\.mjs is out of order/],
    [{ schema: 1, large: ['tests/test-a.mjs', 'tests/test-a.mjs'] }, /tests\/test-a\.mjs is declared twice/],
    [{ schema: 1, large: ['../tests/test-a.mjs'] }, /is not a repository-relative path/],
    [{ schema: 1, large: ['tests/test-*.mjs'] }, /is not a repository-relative path/],
    [{ schema: 1, large: [7] }, /entry 1 \(7\) is not a repository-relative path/],
    [{ schema: 1, large: ['tests/test-gone.mjs'] }, /tests\/test-gone\.mjs is not a test file discovery finds/],
  ];
  for (const [data, message] of cases) assert.throws(() => validateTiers(data, discovered), message, JSON.stringify(data));
  // Every problem at once, not the first alone.
  assert.throws(() => validateTiers({ schema: 1, large: ['tests/test-c.mjs', 'tests/test-a.mjs', 'tests/test-gone.mjs'] }, discovered),
    (err) => /out of order/.test(err.message) && /test-gone\.mjs is not a test file/.test(err.message));
  assert.deepEqual(validateTiers({ schema: 1, large: ['tests/test-a.mjs', 'tests/test-c.mjs'] }, discovered), ['tests/test-a.mjs', 'tests/test-c.mjs']);
});

test('readTiers checks the entries against the whole repository\'s discovery, and refuses a file it cannot parse', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'suite-tiers-')));
  try {
    fs.mkdirSync(path.join(root, 'tests', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tests', 'test-a.mjs'), '');
    fs.writeFileSync(path.join(root, 'tests', 'sub', 'test-b.mjs'), '');
    fs.writeFileSync(path.join(root, 'tests', 'helper.mjs'), '');
    fs.mkdirSync(path.join(root, path.dirname(TIERS_FILE)), { recursive: true });
    const write = (data) => fs.writeFileSync(path.join(root, TIERS_FILE), typeof data === 'string' ? data : JSON.stringify(data));
    write({ schema: 1, large: ['tests/sub/test-b.mjs'] });
    assert.deepEqual(readTiers(root), ['tests/sub/test-b.mjs']);
    write({ schema: 1, large: ['tests/helper.mjs'] });
    assert.throws(() => readTiers(root), /tests\/helper\.mjs is not a test file discovery finds/, 'a file discovery does not run is refused');
    write('{ "schema": 1, ');
    assert.throws(() => readTiers(root), /cannot be read as JSON/);
    fs.rmSync(path.join(root, TIERS_FILE));
    assert.throws(() => readTiers(root), /cannot be read as JSON/, 'a missing declaration is refused, never read as empty');
    const other = path.join(root, 'other.json');
    fs.writeFileSync(other, JSON.stringify({ schema: 1, large: ['tests/test-a.mjs'] }));
    assert.deepEqual(readTiers(root, other), ['tests/test-a.mjs'], 'the declaration\'s path can be given');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the repository\'s declaration loads, and names discovered files that exist', () => {
  const large = readTiers(REPO_ROOT);
  assert.ok(large.length > 0, 'the large tier names files');
  const discovered = new Set(listTestFiles(REPO_ROOT));
  for (const rel of large) {
    assert.ok(discovered.has(rel), `${rel} is discovered`);
    assert.ok(fs.existsSync(path.join(REPO_ROOT, rel)), `${rel} exists`);
  }
  for (const rel of ['tests/orchestrator/test-autopilot-worker-stall-e2e.mjs', 'tests/persona-pipeline/test-peer-snapshot.mjs']) {
    assert.ok(large.includes(rel), `${rel} is large`);
  }
});
