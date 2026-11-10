// ADR-0068 Decision 5, amendment of 2026-11-10 (C178) — an intermediate
// verification batch leaves the large tests to the final run
// (verify-select.mjs selectChecks `deferLarge`). The large tier is the list
// scripts/data/test-tiers.json declares at the selection's base. Small: memory
// readers only, so it runs in a step.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import * as vs from '../../plugins/orchestrator/adapters/claude/autopilot/verify-select.mjs';

const DECL = Object.freeze({
  schema: 'agentic-verify-checks-1.0',
  kinds: {
    'test-suite': { argv: ['npm', 'test'], slots: [], timeout_s: 7200, locks_itself: false, adds_on: [] },
    test: {
      argv: ['npm', 'test', '--', '{files}'],
      slots: [{ name: 'files', type: 'path', repeat: 'many', join: 'words', under: ['tests/'], suffix: '.mjs' }],
      timeout_s: 3600, locks_itself: false, adds_on: [],
    },
  },
  mappings: [{ paths: ['docs/mapped.md'], tests: ['tests/test-big.mjs', 'tests/test-quick.mjs'] }],
});

const PKG = JSON.stringify({ scripts: { test: 'node --test' } });
const tiers = (large, schema = 1) => JSON.stringify({ schema, large });
const FILES = Object.freeze({
  'package.json': PKG,
  'src/a.mjs': 'export const a = 1;\n',
  'src/only-big.mjs': 'export const b = 1;\n',
  'docs/mapped.md': 'x\n',
  'tests/test-quick.mjs': "import '../src/a.mjs';\n",
  'tests/test-big.mjs': "import '../src/a.mjs';\nimport '../src/only-big.mjs';\n",
});

function run({ changed, large = ['tests/test-big.mjs'], tierText, deferLarge = true, requested = [], treeFiles = FILES }) {
  const base = { ...FILES, [vs.TIERS_FILE]: tierText === undefined ? tiers(large) : tierText };
  if (tierText === null) delete base[vs.TIERS_FILE];
  return vs.selectChecks({
    tree: vs.memoryReader({ ...treeFiles, [vs.TIERS_FILE]: tiers(large) }), base: vs.memoryReader(base),
    changes: changed.map((p) => ({ path: p, status: 'M' })), requested, declaration: DECL, deferLarge,
  });
}

describe('selectChecks deferLarge (C178)', () => {
  it('leaves a large test out of the additions and lists it', () => {
    const r = run({ changed: ['src/a.mjs'] });
    assert.deepEqual(r.tests, { files: ['tests/test-quick.mjs'] });
    assert.deepEqual(r.additions, [{ kind: 'test', args: { files: ['tests/test-quick.mjs'] } }]);
    assert.deepEqual(r.deferred, ['tests/test-big.mjs']);
  });

  it('defers nothing by default: every caller that does not ask is unchanged', () => {
    const r = run({ changed: ['src/a.mjs'], deferLarge: false });
    assert.deepEqual(r.tests, { files: ['tests/test-big.mjs', 'tests/test-quick.mjs'] });
    assert.deepEqual(r.deferred, []);
  });

  it('a change only a deferred test matches is matched: no suite, and no test check', () => {
    const r = run({ changed: ['src/only-big.mjs'] });
    assert.deepEqual(r.tests, { files: [] });
    assert.deepEqual(r.additions, []);
    assert.deepEqual(r.deferred, ['tests/test-big.mjs']);
  });

  it('a change nothing matches still selects the suite, and defers nothing', () => {
    const r = run({ changed: ['src/unknown.txt'], treeFiles: { ...FILES, 'src/unknown.txt': 'x' } });
    assert.deepEqual(r.tests, { suite: true });
    assert.deepEqual(r.additions, [{ kind: 'test-suite', args: {} }]);
    assert.deepEqual(r.deferred, []);
  });

  it('keeps a large test that itself changed', () => {
    const r = run({ changed: ['tests/test-big.mjs'] });
    assert.deepEqual(r.tests, { files: ['tests/test-big.mjs'] });
    assert.deepEqual(r.deferred, []);
  });

  it('defers a large test a mapping adds', () => {
    const r = run({ changed: ['docs/mapped.md'] });
    assert.deepEqual(r.tests, { files: ['tests/test-quick.mjs'] });
    assert.deepEqual(r.deferred, ['tests/test-big.mjs']);
  });

  it('never drops the worker\'s own check of a large test', () => {
    const requested = [{ kind: 'test', args: { files: ['tests/test-big.mjs'] } }];
    const r = run({ changed: ['src/a.mjs'], requested });
    assert.deepEqual(r.requested, requested);
    assert.deepEqual(r.additions, [{ kind: 'test', args: { files: ['tests/test-quick.mjs'] } }]);
  });

  it('reads the tiers from the base, never the lane\'s tree', () => {
    // The lane's tree declares the test large; the base does not.
    const r = run({ changed: ['src/a.mjs'], tierText: tiers([]) });
    assert.deepEqual(r.tests, { files: ['tests/test-big.mjs', 'tests/test-quick.mjs'] });
    assert.deepEqual(r.deferred, []);
  });

  for (const [name, text] of [
    ['missing', null], ['unparseable', '{'], ['another schema', tiers(['tests/test-big.mjs'], 2)],
    ['no list', JSON.stringify({ schema: 1, large: 'tests/test-big.mjs' })],
    ['an undeclared key', JSON.stringify({ schema: 1, large: ['tests/test-big.mjs'], medium: [] })],
    ['an entry that is no path', JSON.stringify({ schema: 1, large: ['tests/test-big.mjs', 7] })],
  ]) {
    it(`defers nothing when the base's declaration is ${name}`, () => {
      const r = run({ changed: ['src/a.mjs'], tierText: text });
      assert.deepEqual(r.tests, { files: ['tests/test-big.mjs', 'tests/test-quick.mjs'] });
      assert.deepEqual(r.deferred, []);
    });
  }
});
