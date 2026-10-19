// scripts/lib/discover-tests.mjs lists the files `npm test` runs. The shards
// in full-tests.yml split that list, so a file it missed would run in no shard
// (ADR-0033, amendment of 2026-10-19). This test holds the list to the one
// authority on what `npm test` runs: a real `node --test` with no file
// argument, executed over a fixture tree that exercises each rule (every name
// pattern, every extension, a `test` directory, hidden files and directories,
// nested `node_modules`, symbolic links, names that only look like tests).
// Each fixture file logs its own path when it runs, so the comparison is of
// files executed, not of files counted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { listTestFiles } from '../../scripts/lib/discover-tests.mjs';

const FIXTURE_FILES = [
  'x.test.mjs', 'a-test.cjs', 'b_test.js', 'test-c.mjs', 'test.mjs', 'test_x.mjs', 'xtest.mjs',
  'e.test.ts', 'f.test.mts', 'g.test.cts', 'test-h.json', 'plain.mjs', '.dot.test.mjs',
  'test/d.mjs', 'test/sub/e.cjs', 'test/notes.md', 'b/test/w.mjs', 'b/tests/test-v.mjs',
  '.hidden/f.test.mjs', 'node_modules/g.test.mjs', 'node_modules/pkg/test-z.mjs',
  'a/node_modules/test-y.mjs', 'target/test-in.mjs',
];

// What each rule must yield, so the comparison below cannot pass on a fixture
// that both sides read as empty or that lost a rule.
const MUST_RUN = [
  'x.test.mjs', 'a-test.cjs', 'b_test.js', 'test-c.mjs', 'test.mjs', 'e.test.ts', 'f.test.mts',
  'g.test.cts', 'test/d.mjs', 'test/sub/e.cjs', 'b/test/w.mjs', 'b/tests/test-v.mjs', 'test-link.mjs',
];
const MUST_NOT_RUN = [
  'test_x.mjs', 'xtest.mjs', 'test-h.json', 'plain.mjs', 'node_modules/g.test.mjs',
  'node_modules/pkg/test-z.mjs', 'a/node_modules/test-y.mjs',
];

// Runs under either module system and either type mode: the fixture's files
// are .js, .cjs, .mjs and TypeScript alike.
const LOGGER = "process.getBuiltinModule('node:fs').appendFileSync(process.env.DISCOVERY_LOG, process.argv[1] + '\\n');\n";

function buildFixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'discover-tests-')));
  for (const rel of FIXTURE_FILES) {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), LOGGER);
  }
  fs.symlinkSync('test-c.mjs', path.join(root, 'test-link.mjs'));
  fs.symlinkSync('target', path.join(root, 'linked-dir'));
  return root;
}

/** The files a real no-argument `node --test` executes in `cwd`. */
function filesNodeRuns(cwd) {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'discover-tests-log-')), 'ran.txt');
  fs.writeFileSync(log, '');
  // A nested runner that inherits NODE_TEST_CONTEXT treats itself as a child
  // and reports success without running anything; NODE_OPTIONS could change
  // what it loads.
  const env = { ...process.env, DISCOVERY_LOG: log };
  for (const name of Object.keys(env)) if (name.startsWith('NODE_TEST')) delete env[name];
  delete env.NODE_OPTIONS;
  const res = spawnSync(process.execPath, ['--test'], {
    cwd, env, encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL',
  });
  assert.equal(res.status, 0, `node --test over the fixture failed:\n${res.stdout}\n${res.stderr}`);
  return fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)
    .map((abs) => path.relative(cwd, abs).split(path.sep).join('/'))
    .sort();
}

test('listTestFiles names exactly the files a real no-argument node --test executes', () => {
  const root = buildFixture();
  try {
    const ran = filesNodeRuns(root);
    for (const rel of MUST_RUN) assert.ok(ran.includes(rel), `the fixture lost a rule: node --test did not run ${rel}`);
    for (const rel of MUST_NOT_RUN) assert.ok(!ran.includes(rel), `the fixture lost a rule: node --test ran ${rel}`);
    assert.deepEqual(listTestFiles(root), ran);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('listTestFiles finds the repository suite', () => {
  const files = listTestFiles(path.resolve(import.meta.dirname, '..', '..'));
  assert.ok(files.includes('tests/scripts/test-discover-tests.mjs'), 'this file is itself discovered');
  assert.ok(files.includes('companions/tests/contract-parity.test.mjs'));
  assert.ok(!files.some((f) => f.startsWith('.') || f.includes('/.')), 'nothing from a hidden directory');
});
