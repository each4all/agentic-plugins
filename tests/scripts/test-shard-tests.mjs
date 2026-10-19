// scripts/shard-tests.mjs splits `npm test`'s files over the shards of
// full-tests.yml (ADR-0033, amendment of 2026-10-19). What must hold: the
// shards together run every discovered file exactly once, the split is
// deterministic, a broken partition stops the shard, `run` hands npm exactly
// its shard's files and returns npm's status, and `record` refuses a recording
// that did not finish.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { listTestFiles } from '../../scripts/lib/discover-tests.mjs';
import {
  MAX_SHARDS, MIN_SHARDS, OVERHEAD_SECONDS, UNRECORDED_SECONDS, WEIGHTS_FILE,
  assignShards, isSafeTestPath, parseShardSpec, partitionProblems, planShards, validateWeights,
} from '../../scripts/shard-tests.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const CLI = path.join(REPO_ROOT, 'scripts', 'shard-tests.mjs');

const sortedUnion = (shards) => shards.flat().sort();

test('the shards of the real suite run every discovered file exactly once, for every shard count', () => {
  const files = listTestFiles(REPO_ROOT);
  assert.ok(files.includes('tests/scripts/test-shard-tests.mjs'), 'discovery found the real suite');
  for (let total = MIN_SHARDS; total <= MAX_SHARDS; total += 1) {
    const { shards } = planShards(REPO_ROOT, total);
    assert.equal(shards.length, total);
    for (const shard of shards) assert.ok(shard.length > 0, `${total} shards: none is empty`);
    // Union and multiplicity, independently of partitionProblems.
    assert.deepEqual(sortedUnion(shards), files, `${total} shards: the union is the discovered list, each once`);
  }
});

test('the assignment is deterministic and independent of the order files are listed in', () => {
  const files = listTestFiles(REPO_ROOT);
  const seconds = new Map(files.map((rel, i) => [rel, (i * 7) % 13]));
  const first = assignShards(files, seconds, 3);
  const reversed = assignShards([...files].reverse(), seconds, 3);
  assert.deepEqual(reversed, first);
  assert.deepEqual(assignShards(files, seconds, 3), first);
});

test('heaviest file first, each to the least-loaded shard, ties to the lowest index', () => {
  const seconds = new Map([['a.test.mjs', 10], ['b.test.mjs', 8], ['c.test.mjs', 6], ['d.test.mjs', 4], ['e.test.mjs', 2]]);
  const { shards, loads } = assignShards([...seconds.keys()], seconds, 2);
  assert.deepEqual(shards, [['a.test.mjs', 'd.test.mjs', 'e.test.mjs'], ['b.test.mjs', 'c.test.mjs']]);
  assert.deepEqual(loads, [16 + 3 * OVERHEAD_SECONDS, 14 + 2 * OVERHEAD_SECONDS]);
});

test('a file with no recording weighs the fixed estimate', () => {
  const seconds = new Map([['a.test.mjs', UNRECORDED_SECONDS + 1]]);
  const { loads } = assignShards(['a.test.mjs', 'new.test.mjs'], seconds, 2);
  assert.deepEqual(loads, [UNRECORDED_SECONDS + 1 + OVERHEAD_SECONDS, UNRECORDED_SECONDS + OVERHEAD_SECONDS]);
});

test('partitionProblems names a dropped, duplicated or undiscovered file, an empty shard and an unsafe path', () => {
  const files = ['a.test.mjs', 'b.test.mjs', 'c d.test.mjs'];
  assert.deepEqual(partitionProblems(files, [['a.test.mjs'], ['b.test.mjs', 'c d.test.mjs']]),
    ['c d.test.mjs is not a path the runner receives unchanged (letters, digits, . _ - /)']);
  const problems = partitionProblems(files, [['a.test.mjs', 'b.test.mjs', 'x.test.mjs'], ['a.test.mjs'], []]);
  assert.deepEqual(problems.sort(), [
    'a.test.mjs is in shards 1, 2',
    'c d.test.mjs is in no shard',
    'c d.test.mjs is not a path the runner receives unchanged (letters, digits, . _ - /)',
    'shard 3 of 3 is empty',
    'x.test.mjs is in a shard but was not discovered',
  ]);
  assert.deepEqual(partitionProblems(['a.test.mjs', 'b.test.mjs'], [['a.test.mjs'], ['b.test.mjs']]), []);
});

test('a shard spec is i/N with N from 2 to 4 and i from 1 to N', () => {
  assert.deepEqual(parseShardSpec('2/3'), { index: 2, total: 3 });
  assert.deepEqual(parseShardSpec('4/4'), { index: 4, total: 4 });
  for (const bad of ['', '3', '0/3', '4/3', '1/1', '1/5', '01/3', '1/3/2', ' 1/3', 'a/b', undefined]) {
    assert.throws(() => parseShardSpec(bad), Error, `refuses ${JSON.stringify(bad)}`);
  }
});

test('only a path the runner receives unchanged is safe', () => {
  for (const ok of ['tests/x/test-a.mjs', 'companions/tests/contract-parity.test.mjs', 'a_b-c.test.cjs']) {
    assert.ok(isSafeTestPath(ok), ok);
  }
  for (const bad of ['a b.test.mjs', '-x.test.mjs', '../test-a.mjs', 'a/../test-a.mjs', './test-a.mjs',
    '/abs/test-a.mjs', 'a//test-a.mjs', 'a/*.test.mjs', 'test-[a].mjs', 'test-{a}.mjs', "test-'a.mjs", 'test-$a.mjs', '']) {
    assert.ok(!isSafeTestPath(bad), bad);
  }
});

test('a weights file must be schema 1 with safe paths and finite, non-negative seconds', () => {
  assert.deepEqual(validateWeights({ schema: 1, seconds: { 'a.test.mjs': 1.5 } }), new Map([['a.test.mjs', 1.5]]));
  for (const bad of [null, [], { seconds: {} }, { schema: 2, seconds: {} }, { schema: 1 }, { schema: 1, seconds: [] },
    { schema: 1, seconds: { 'a.test.mjs': -1 } }, { schema: 1, seconds: { 'a.test.mjs': '1' } },
    { schema: 1, seconds: { 'a.test.mjs': null } }, { schema: 1, seconds: { '../a.test.mjs': 1 } }]) {
    assert.throws(() => validateWeights(bad), Error, JSON.stringify(bad));
  }
  assert.doesNotThrow(() => validateWeights(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, WEIGHTS_FILE), 'utf8'))),
    'the committed weights file is valid');
});

// ---- the CLI, over a fixture repository ------------------------------------

const FIXTURE_TESTS = ['tests/test-a.mjs', 'tests/test-b.mjs', 'tests/c.test.mjs', 'kit/d-test.cjs', 'tests/test-e.mjs'];

function fixtureRepo(seconds = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shard-tests-')));
  for (const rel of FIXTURE_TESTS) {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), '');
  }
  fs.mkdirSync(path.join(root, path.dirname(WEIGHTS_FILE)), { recursive: true });
  fs.writeFileSync(path.join(root, WEIGHTS_FILE), JSON.stringify({ schema: 1, recorded: 'x', source: 'x', seconds }));
  return root;
}

/** A fake `npm` first on PATH that records its arguments and exits with FAKE_NPM_STATUS. */
function fakeNpm() {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'shard-tests-bin-'));
  fs.writeFileSync(path.join(bin, 'npm'), [
    `#!${process.execPath}`,
    "const fs = require('fs');",
    'fs.writeFileSync(process.env.FAKE_NPM_LOG, JSON.stringify({',
    '  argv: process.argv.slice(2), cwd: process.cwd(),',
    "  testEnv: Object.keys(process.env).filter((name) => name.startsWith('NODE_TEST_')),",
    '}));',
    'process.exit(Number(process.env.FAKE_NPM_STATUS));',
    '',
  ].join('\n'), { mode: 0o755 });
  return bin;
}

function cli(args, { bin, status = 0, env: extra = {} } = {}) {
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shard-tests-log-')), 'npm.json');
  const env = { ...process.env, ...extra, FAKE_NPM_LOG: log, FAKE_NPM_STATUS: String(status) };
  if (bin) env.PATH = `${bin}${path.delimiter}${env.PATH}`;
  const res = spawnSync(process.execPath, [CLI, ...args], { env, encoding: 'utf8', timeout: 60_000 });
  const npm = fs.existsSync(log) ? JSON.parse(fs.readFileSync(log, 'utf8')) : null;
  return { ...res, npm };
}

test('run hands npm test exactly its shard\'s files, with no shell, and returns npm\'s status', () => {
  const root = fixtureRepo({ 'tests/test-a.mjs': 9, 'tests/test-b.mjs': 1 });
  const bin = fakeNpm();
  const ran = [];
  for (const [i, status] of [[1, 0], [2, 7]]) {
    const listed = cli(['list', `${i}/2`, '--repo-root', root]).stdout.split('\n').filter(Boolean);
    // An inherited runner context would make node --test run nothing and pass.
    const res = cli(['run', `${i}/2`, '--repo-root', root], { bin, status, env: { NODE_TEST_CONTEXT: 'child-v8' } });
    assert.equal(res.status, status, `shard ${i} exits with npm's status\n${res.stderr}`);
    assert.ok(res.npm, 'npm was started');
    assert.deepEqual(res.npm.argv, ['test', '--', ...listed]);
    assert.equal(fs.realpathSync(res.npm.cwd), root, 'npm runs at the repository root');
    assert.deepEqual(res.npm.testEnv, [], 'npm inherits no NODE_TEST_* variable');
    for (const rel of listed) assert.match(res.stdout, new RegExp(`^  ${rel.replaceAll('.', '\\.')}$`, 'm'), 'the shard prints its list');
    ran.push(...listed);
  }
  assert.deepEqual(ran.sort(), [...FIXTURE_TESTS].sort(), 'the two shards ran every file once');
});

test('run refuses a shard that names a file that does not exist, before npm starts', () => {
  const root = fixtureRepo();
  fs.symlinkSync('gone.mjs', path.join(root, 'tests', 'test-gone.mjs'));
  const bin = fakeNpm();
  const statuses = [1, 2].map((i) => cli(['run', `${i}/2`, '--repo-root', root], { bin }));
  const refused = statuses.filter((r) => r.status === 1);
  assert.equal(refused.length, 1, 'the shard holding the dangling file refuses');
  assert.match(refused[0].stderr, /tests\/test-gone\.mjs/);
  assert.equal(refused[0].npm, null, 'npm never started');
});

test('run refuses a shard of a tree with an unsafe test path, naming it', () => {
  const root = fixtureRepo();
  fs.writeFileSync(path.join(root, 'tests', 'test-a b.mjs'), '');
  const res = cli(['run', '1/2', '--repo-root', root], { bin: fakeNpm() });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /tests\/test-a b\.mjs is not a path the runner receives unchanged/);
  assert.equal(res.npm, null);
});

test('a backslash in a file name stays part of the name, so the file is refused, not swapped for another', { skip: path.sep !== '/' }, () => {
  // On Linux and macOS `tests/test-\victim.mjs` is one file in tests/; read
  // as `tests/test-/victim.mjs` it would name a different one, which exists.
  const root = fixtureRepo();
  fs.writeFileSync(path.join(root, 'tests', 'test-\\victim.mjs'), '');
  fs.mkdirSync(path.join(root, 'tests', 'test-'));
  fs.writeFileSync(path.join(root, 'tests', 'test-', 'victim.mjs'), '');
  assert.ok(listTestFiles(root).includes('tests/test-\\victim.mjs'));
  const res = cli(['run', '1/2', '--repo-root', root], { bin: fakeNpm() });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /tests\/test-\\victim\.mjs is not a path the runner receives unchanged/);
  assert.equal(res.npm, null);
});

test('run refuses a package.json with a pretest hook, which could change the files after they were checked', () => {
  const root = fixtureRepo();
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', pretest: 'true' } }));
  const res = cli(['run', '1/2', '--repo-root', root], { bin: fakeNpm() });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /pretest/);
  assert.equal(res.npm, null);
});

test('the repository has no pretest hook', () => {
  const { scripts } = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(Object.hasOwn(scripts, 'pretest'), false);
});

// A file that logs the path it ran as, for counting what node --test executed.
const LOGGER = "process.getBuiltinModule('node:fs').appendFileSync(process.env.SHARD_RUN_LOG, process.argv[1] + '\\n');\n";

test('with the real npm, the shards execute every discovered file exactly once, and a failing file fails its shard', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shard-tests-npm-')));
  const files = ['tests/test-a.mjs', 'tests/test-b.mjs', 'tests/c.test.mjs', 'kit/test/d.mjs', 'tests/test-e.cjs', 'tests/test-sentinel.mjs'];
  for (const rel of files) {
    fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), rel.endsWith('sentinel.mjs') ? `${LOGGER}throw new Error('sentinel');\n` : LOGGER);
  }
  fs.mkdirSync(path.join(root, path.dirname(WEIGHTS_FILE)), { recursive: true });
  fs.writeFileSync(path.join(root, WEIGHTS_FILE), JSON.stringify({ schema: 1, seconds: {} }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ private: true, scripts: { test: 'node --test' } }));
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shard-tests-npm-log-')), 'ran.txt');
  fs.writeFileSync(log, '');
  const statuses = new Map();
  for (const i of [1, 2]) {
    const listed = cli(['list', `${i}/2`, '--repo-root', root]).stdout.split('\n').filter(Boolean);
    // This test runs under node --test, so the CLI inherits NODE_TEST_CONTEXT
    // here: the shard must clear it, or npm's node --test would run nothing.
    const res = cli(['run', `${i}/2`, '--repo-root', root], { env: { SHARD_RUN_LOG: log } });
    statuses.set(listed.includes('tests/test-sentinel.mjs') ? 'sentinel' : 'clean', res.status);
  }
  const ran = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)
    .map((abs) => path.relative(root, abs).split(path.sep).join('/'))
    .sort();
  assert.deepEqual(ran, listTestFiles(root), 'each discovered file executed once across the shards');
  assert.deepEqual(ran, [...files].sort());
  assert.equal(statuses.get('clean'), 0, 'the shard without the failing file passes');
  assert.notEqual(statuses.get('sentinel'), 0, 'the shard with the failing file fails');
});

test('the CLI refuses a bad shard spec, an unknown command and a malformed weights file', () => {
  const root = fixtureRepo();
  assert.equal(cli(['run', '3/2', '--repo-root', root]).status, 1);
  assert.equal(cli(['run', '1/5', '--repo-root', root]).status, 1);
  assert.equal(cli(['frobnicate', '--repo-root', root]).status, 2);
  assert.equal(cli(['run', '--repo-root']).status, 2);
  fs.writeFileSync(path.join(root, WEIGHTS_FILE), '{"schema":1,"seconds":{"tests/test-a.mjs":-3}}');
  const res = cli(['list', '1/2', '--repo-root', root]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /tests\/test-a\.mjs: -3/);
});

const PASSED = { summary: true, success: true, duration_ms: 1, counts: { cancelled: 0 } };

function recording(root, files, { summary = PASSED, first = null } = {}) {
  const lines = files.map((rel, i) => JSON.stringify({ file: path.join(root, rel), duration_ms: 1000 * (i + 1) + 234 }));
  if (first) lines.unshift(JSON.stringify(first));
  if (summary) lines.push(JSON.stringify(summary));
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shard-tests-rec-')), 'run.jsonl');
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  return file;
}

test('record rewrites the weights from a complete recording', () => {
  const root = fixtureRepo();
  const files = listTestFiles(root);
  const res = cli(['record', '--from', recording(root, files), '--repo-root', root]);
  assert.equal(res.status, 0, res.stderr);
  const written = JSON.parse(fs.readFileSync(path.join(root, WEIGHTS_FILE), 'utf8'));
  assert.equal(written.schema, 1);
  assert.deepEqual(written.seconds, Object.fromEntries(files.map((rel, i) => [rel, Math.round((i + 1.234) * 10) / 10])));
  assert.doesNotThrow(() => validateWeights(written));
});

test('record refuses a run that did not finish, missed a file or recorded one twice, and writes nothing', () => {
  const root = fixtureRepo({ 'tests/test-a.mjs': 3 });
  const before = fs.readFileSync(path.join(root, WEIGHTS_FILE), 'utf8');
  const files = listTestFiles(root);
  const cases = [
    [recording(root, files, { summary: null }), /did not finish/],
    [recording(root, files, { summary: null, first: PASSED }), /line 1 is a run summary before the end/],
    [recording(root, files, { summary: { ...PASSED, success: false } }), /the run did not pass/],
    [recording(root, files, { summary: { ...PASSED, counts: { cancelled: 2 } } }), /the run did not pass/],
    [recording(root, files, { summary: { summary: true } }), /the run did not pass/],
    [recording(root, files.slice(1)), new RegExp(`${files[0].replaceAll('.', '\\.')} has no recorded duration`)],
    [recording(root, [...files, files[0]]), /is recorded twice/],
    [recording(root, [...files, 'elsewhere/x.mjs']), /elsewhere\/x\.mjs was recorded but is not discovered/],
  ];
  for (const [from, message] of cases) {
    const res = cli(['record', '--from', from, '--repo-root', root]);
    assert.equal(res.status, 1, `refused: ${message}`);
    assert.match(res.stderr, message);
    assert.equal(fs.readFileSync(path.join(root, WEIGHTS_FILE), 'utf8'), before, 'the weights file is unchanged');
  }
  assert.equal(cli(['record', '--repo-root', root]).status, 2, 'record needs --from');
});

test('record takes the reporter\'s output of a real run: a file without node:test and a linked file count under their own names', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shard-tests-rec-real-')));
  fs.mkdirSync(path.join(root, 'tests'));
  fs.writeFileSync(path.join(root, 'tests', 'test-a.mjs'), "import { test } from 'node:test';\ntest('a', () => {});\n");
  fs.writeFileSync(path.join(root, 'tests', 'test-plain.mjs'), 'void 0;\n');
  fs.symlinkSync('test-a.mjs', path.join(root, 'tests', 'test-link.mjs'));
  fs.mkdirSync(path.join(root, path.dirname(WEIGHTS_FILE)), { recursive: true });
  fs.writeFileSync(path.join(root, WEIGHTS_FILE), JSON.stringify({ schema: 1, seconds: {} }));
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'shard-tests-rec-real-out-')), 'run.jsonl');
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('NODE_TEST')) delete env[name];
  const reporter = path.join(REPO_ROOT, 'scripts', 'lib', 'duration-reporter.mjs');
  const run = spawnSync(process.execPath, ['--test', `--test-reporter=${reporter}`, `--test-reporter-destination=${out}`], {
    cwd: root, env, encoding: 'utf8', timeout: 60_000,
  });
  assert.equal(run.status, 0, run.stderr);
  const res = cli(['record', '--from', out, '--repo-root', root]);
  assert.equal(res.status, 0, res.stderr);
  const { seconds } = JSON.parse(fs.readFileSync(path.join(root, WEIGHTS_FILE), 'utf8'));
  assert.deepEqual(Object.keys(seconds), ['tests/test-a.mjs', 'tests/test-link.mjs', 'tests/test-plain.mjs']);
});
