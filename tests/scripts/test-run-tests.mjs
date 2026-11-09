// npm test's runner (scripts/run-tests.mjs): the suite in two passes by test
// size tier, the parallel pool and then the large tier at low concurrency.
//
// buildPasses on literal argument lists: package.json's own command reaches
// discovery with both preloads intact, an option's value is never a file, a
// directory and a glob expand to discovered files, a named file matches the
// declaration by its repository path, a name that matches nothing is refused,
// the large pass's concurrency is at most LARGE_CONCURRENCY, an empty pass is
// left out, pass 2's file reporter destinations are its own and removed after,
// and a mode two passes cannot honour (a reporter that writes one document,
// watch mode, a file destination in NODE_OPTIONS), given as an argument, with
// Node's underscore spelling or in NODE_OPTIONS, is refused when both passes
// would run.
//
// Then the chain on a fixture repository whose package.json runs this runner:
// `npm test` runs both passes in two `node --test` processes, a failing large
// file fails the run, a failing pool file still runs the large pass, an
// inherited NODE_TEST_CONTEXT is removed, a duration recording of both passes
// is one shard-tests `record` takes and leaves no temporary directory, and
// SIGTERM during the pool starts no large pass and exits 143.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LARGE_CONCURRENCY, buildPasses, childEnv, parseArgs, removeTmp, splitNodeOptions } from '../../scripts/run-tests.mjs';
import { weightsFromRecording } from '../../scripts/shard-tests.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNNER = path.join(REPO_ROOT, 'scripts', 'run-tests.mjs');
const REPORTER = path.join(REPO_ROOT, 'scripts', 'lib', 'duration-reporter.mjs');
const PKG_ARGV = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).scripts.test.split(' ').slice(2);

const ROOT = '/repo';
const DISCOVERED = ['tests/a/test-1.mjs', 'tests/a/test-2.mjs', 'tests/b/test-3.mjs', 'tests/test-big.mjs'];
const LARGE = ['tests/a/test-2.mjs', 'tests/test-big.mjs'];
// A file system with the discovered files, their directories and a probe
// outside discovery.
const FSX = {
  kind(abs) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    if ([...DISCOVERED, 'tests/fixtures/probe.mjs'].includes(rel)) return 'file';
    if (['', 'tests', 'tests/a', 'tests/b', 'tests/fixtures', 'empty'].includes(rel)) return 'dir';
    return null;
  },
  glob(pattern) {
    // As fs.globSync answers: an absolute pattern matches absolute paths.
    const abs = pattern.startsWith('/');
    const re = new RegExp(`^${pattern.replaceAll('.', '\\.').replaceAll('*', '[^/]*')}$`);
    return DISCOVERED.map((rel) => (abs ? `${ROOT}/${rel}` : rel)).filter((p) => re.test(p));
  },
};
let tmpN = 0;
const passes = (argv, nodeOptions = '') => buildPasses({ argv, repoRoot: ROOT, discovered: DISCOVERED, large: LARGE, nodeOptions, fsx: FSX, tmpFile: () => `/tmp/pass2-${++tmpN}.out` });

test('package.json\'s command: discovery split in two, both preloads and the timeout in each pass', () => {
  const [pool, large] = passes(PKG_ARGV);
  const opts = PKG_ARGV;
  assert.ok(opts.some((a) => a.startsWith('--import=') && a.endsWith('_hermetic-env.mjs')), opts.join(' '));
  assert.ok(opts.some((a) => a.startsWith('--import=') && a.endsWith('_signal-guard.mjs')), opts.join(' '));
  assert.deepEqual(pool, { tier: 'pool', args: ['--test', ...opts, 'tests/a/test-1.mjs', 'tests/b/test-3.mjs'], files: ['tests/a/test-1.mjs', 'tests/b/test-3.mjs'], destinations: [] });
  assert.deepEqual(large.args, ['--test', ...opts, `--test-concurrency=${LARGE_CONCURRENCY}`, 'tests/a/test-2.mjs', 'tests/test-big.mjs']);
  assert.deepEqual(large.files, LARGE);
});

test('an option written apart from its value takes it, never as a file; a flag takes none; -- ends the options', () => {
  assert.deepEqual(parseArgs(['--import', './x.mjs', '--test-only', '--test-name-pattern', 'tests/a/test-1.mjs', '-r', 'y', 'tests/b/test-3.mjs']), {
    options: [
      { name: '--import', value: './x.mjs', raw: ['--import', './x.mjs'] },
      { name: '--test-only', value: null, raw: ['--test-only'] },
      { name: '--test-name-pattern', value: 'tests/a/test-1.mjs', raw: ['--test-name-pattern', 'tests/a/test-1.mjs'] },
      { name: '-r', value: 'y', raw: ['-r', 'y'] },
    ],
    files: ['tests/b/test-3.mjs'],
  });
  assert.deepEqual(parseArgs(['--test-reporter=spec', '--', '--odd.mjs']).files, ['--odd.mjs']);
  assert.throws(() => parseArgs(['--import']), /--import needs a value/);
  const [pool] = passes(['--import', './tests/_hermetic-env.mjs', 'tests/b/test-3.mjs']);
  assert.deepEqual(pool.args, ['--test', '--import', './tests/_hermetic-env.mjs', 'tests/b/test-3.mjs'], 'the preload stays an option');
});

test('named files: a large one goes to pass 2 however it is spelled; a directory and a glob expand; a probe outside discovery joins the pool', () => {
  const [pool, large] = passes(['./tests/test-big.mjs', `${ROOT}/tests/a/test-1.mjs`, 'tests/fixtures/probe.mjs']);
  assert.deepEqual(pool.args.slice(1), [`${ROOT}/tests/a/test-1.mjs`, 'tests/fixtures/probe.mjs'], 'passed as given');
  assert.deepEqual(large.args.slice(-1), ['./tests/test-big.mjs']);
  const [dirPool, dirLarge] = passes(['tests/a']);
  assert.deepEqual(dirPool.files, ['tests/a/test-1.mjs']);
  assert.deepEqual(dirLarge.files, ['tests/a/test-2.mjs']);
  const [globPool, globLarge] = passes(['tests/a/test-*.mjs']);
  assert.deepEqual([globPool.files, globLarge.files], [['tests/a/test-1.mjs'], ['tests/a/test-2.mjs']]);
  assert.deepEqual(passes(['tests/b/test-3.mjs', './tests/b/test-3.mjs'])[0].files, ['tests/b/test-3.mjs'], 'one file named twice runs once');
  // An absolute glob: each match keyed by its repository path.
  const [absPool, absLarge] = passes([`${ROOT}/tests/a/test-*.mjs`, 'tests/a/test-1.mjs']);
  assert.deepEqual([absPool.args.slice(1), absLarge.args.slice(-1)], [[`${ROOT}/tests/a/test-1.mjs`], [`${ROOT}/tests/a/test-2.mjs`]]);
  assert.deepEqual([absPool.files, absLarge.files], [['tests/a/test-1.mjs'], ['tests/a/test-2.mjs']], 'the large match goes to pass 2, the file named again runs once');
});

test('a name that matches nothing is refused, naming each', () => {
  assert.throws(() => passes(['tests/a/test-1.mjs', 'tests/gone.mjs', 'tests/z-*.mjs', 'empty']),
    (err) => /tests\/gone\.mjs does not exist/.test(err.message) && /tests\/z-\*\.mjs matches no file/.test(err.message)
      && /empty is a directory with no test file/.test(err.message));
  // An option Node takes a value for, unknown to the table and written apart,
  // leaves its value as a name: refused, with the cure.
  assert.throws(() => passes(['--test-coverage-lines', '80']), /80 does not exist[\s\S]*--option=value/);
});

test('an empty pass is left out; the large pass runs at the lower of the caller\'s concurrency and LARGE_CONCURRENCY', () => {
  assert.deepEqual(passes(['tests/b/test-3.mjs']).map((p) => p.tier), ['pool']);
  assert.deepEqual(passes(['tests/test-big.mjs']).map((p) => p.tier), ['large']);
  const conc = (argv) => passes(argv).at(-1).args.filter((a) => a.startsWith('--test-concurrency'));
  assert.deepEqual(conc(['--test-concurrency=8']), [`--test-concurrency=${LARGE_CONCURRENCY}`]);
  assert.deepEqual(conc(['--test-concurrency', '1']), ['--test-concurrency=1']);
  assert.deepEqual(conc(['--test-concurrency=0']), ['--test-concurrency=0'], 'a value that is no count is passed as given, for Node to refuse');
  assert.deepEqual(passes(['--test-concurrency', '-1', 'tests/test-big.mjs'])[0].args.slice(0, 3), ['--test', '--test-concurrency', '-1'], 'in a large-only run too');
  assert.deepEqual(passes(['--test-concurrency=8'])[0].args.slice(0, 2), ['--test', '--test-concurrency=8'], 'pass 1 takes the caller\'s as given');
});

test('pass 2 writes each file reporter destination to its own file, appended after; stdout and stderr stay', () => {
  const argv = ['--test-reporter=./r.mjs', '--test-reporter-destination=out/rec.jsonl', '--test-reporter=spec', '--test-reporter-destination', 'stdout'];
  const [pool, large] = passes(argv);
  assert.deepEqual(pool.args.slice(1, 1 + argv.length), argv);
  assert.equal(large.destinations.length, 1);
  const { tmp, target } = large.destinations[0];
  assert.equal(target, path.join(ROOT, 'out/rec.jsonl'));
  assert.ok(large.args.includes(`--test-reporter-destination=${tmp}`), large.args.join(' '));
  assert.ok(!large.args.includes('--test-reporter-destination=out/rec.jsonl'));
  assert.ok(large.args.includes('stdout'), 'stdout stays');
  const [alone] = passes([...argv, 'tests/test-big.mjs']);
  assert.deepEqual(alone.destinations, [], 'with no pass 1 to overwrite, pass 2 writes the caller\'s destination');
});

test('each file destination of pass 2 gets its own temporary file, in a directory removeTmp removes', () => {
  const [, large] = buildPasses({
    argv: ['--test-reporter=spec', '--test-reporter-destination=a.out', '--test-reporter=dot', '--test-reporter-destination=b.out'],
    repoRoot: ROOT, discovered: DISCOVERED, large: LARGE, fsx: FSX,
  });
  const tmps = large.destinations.map((d) => d.tmp);
  assert.equal(tmps.length, 2);
  assert.notEqual(tmps[0], tmps[1], 'two reporters never share one file');
  assert.deepEqual(large.destinations.map((d) => d.target), [path.join(ROOT, 'a.out'), path.join(ROOT, 'b.out')]);
  const dir = path.dirname(tmps[0]);
  assert.ok(fs.statSync(dir).isDirectory(), 'the allocator made its directory');
  removeTmp();
  assert.equal(fs.existsSync(dir), false, 'removed');
});

test('a reporter that writes one document per run (tap, junit) is refused wherever both passes write', () => {
  for (const r of ['tap', 'junit']) {
    for (const argv of [
      ['--test-reporter=spec', '--test-reporter-destination=stdout', `--test-reporter=${r}`, '--test-reporter-destination=out.txt'],
      [`--test-reporter=${r}`, '--test-reporter-destination=stdout'],
      ['--test-reporter', r, '--test-reporter-destination', 'stderr'],
    ]) {
      const where = argv.at(-1).replace('--test-reporter-destination=', '');
      assert.throws(() => passes(argv), (err) => err.message.includes(`the ${r} reporter writes one document per run`)
        && err.message.includes(`two in ${where}`) && /two npm test runs/.test(err.message), argv.join(' '));
      assert.equal(passes([...argv, 'tests/test-big.mjs']).length, 1, `one pass writes one document: ${argv.join(' ')}`);
      assert.equal(passes([...argv, 'tests/b/test-3.mjs']).length, 1, `pool alone: ${argv.join(' ')}`);
    }
    // One reporter and no destination writes to stdout.
    assert.throws(() => passes([`--test-reporter=${r}`]), new RegExp(`the ${r} reporter[\\s\\S]*two in stdout`));
  }
  assert.equal(passes(['--test-reporter=spec', '--test-reporter=dot', '--test-reporter-destination=stdout', '--test-reporter-destination=d.out']).length, 2,
    'line reporters run in both passes');
});

test('watch mode is refused when both passes run: the pool would never end, nor the large tier start', () => {
  for (const argv of [['--watch'], ['--watch=false'], ['--no-watch', '--watch']]) {
    assert.throws(() => passes(argv), /keeps the pool running[\s\S]*large tier would never run[\s\S]*two npm test runs/, argv.join(' '));
    assert.equal(passes([...argv, 'tests/b/test-3.mjs']).length, 1, `one tier's files watch: ${argv.join(' ')}`);
  }
  assert.equal(passes(['--watch', '--no-watch']).length, 2, 'the last of --watch and --no-watch decides, as in Node');
  // --watch-path is Node's to refuse beside --test, in each pass.
  assert.equal(passes(['--watch-path', 'tests']).length, 2);
  assert.deepEqual(parseArgs(['--watch-path', 'tests', 'tests/b/test-3.mjs']).files, ['tests/b/test-3.mjs'], 'the watched path is no file');
});

test('an option spelled with underscores is read as Node reads it', () => {
  assert.deepEqual(parseArgs(['--test_reporter', 'tap', '--test_reporter_destination=x.out']).options.map((o) => [o.name, o.value]),
    [['--test-reporter', 'tap'], ['--test-reporter-destination', 'x.out']]);
  assert.throws(() => passes(['--test_reporter=tap']), /the tap reporter writes one document per run/);
  assert.throws(() => passes(['--test_reporter', 'junit', '--test_reporter_destination', 'j.xml']), /junit[\s\S]*two in j\.xml/);
  const [, large] = passes(['--test_reporter=spec', '--test_reporter_destination=x.out']);
  assert.deepEqual(large.destinations.map((d) => d.target), [path.join(ROOT, 'x.out')], 'the underscore destination is redirected for pass 2');
});

test('NODE_OPTIONS\' reporter and watch options are judged with the arguments, read first', () => {
  assert.deepEqual(splitNodeOptions(' --a=1  "--b=x y" --c '), ['--a=1', '--b=x y', '--c']);
  assert.throws(() => passes([], '--test-reporter=tap'), /the tap reporter[\s\S]*two in stdout/);
  assert.throws(() => passes([], '--test_reporter=junit --test-reporter-destination=stderr'), /junit[\s\S]*two in stderr/);
  assert.throws(() => passes([], '--watch'), /--watch \(in NODE_OPTIONS\) keeps the pool running/);
  assert.equal(passes(['--no-watch'], '--watch').length, 2, 'the argument, read after, decides');
  assert.throws(() => passes([], '--test-reporter=spec --test-reporter-destination=out.txt'), /NODE_OPTIONS names the reporter destination out\.txt[\s\S]*npm test arguments/);
  // NODE_OPTIONS' reporter takes the first destination, an argument's the next.
  assert.throws(() => passes(['--test-reporter=dot', '--test-reporter-destination=d.out'], '--test-reporter=tap --test-reporter-destination=stdout'), /tap[\s\S]*two in stdout/);
  assert.equal(passes([], '--test-reporter=spec --max-old-space-size=4096').length, 2, 'a line reporter on stdout and other options run');
  for (const opts of ['--test-reporter=tap', '--watch', '--test-reporter=spec --test-reporter-destination=o.txt']) {
    assert.equal(passes(['tests/test-big.mjs'], opts).length, 1, `one tier: ${opts}`);
  }
});

test('the children\'s environment has no NODE_TEST_* variable', () => {
  assert.deepEqual(childEnv({ NODE_TEST_CONTEXT: 'child', NODE_TEST_X: '1', KEEP: 'k' }), { KEEP: 'k' });
});

// ---- the chain, on a fixture repository -------------------------------------

function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'run-tests-chain-')));
  const log = path.join(root, 'log');
  fs.mkdirSync(path.join(root, 'tests'));
  fs.mkdirSync(path.join(root, 'scripts', 'data'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'fixture', private: true, type: 'module',
    scripts: { test: `node ${JSON.stringify(RUNNER)} --test-timeout=60000` },
  }));
  fs.writeFileSync(path.join(root, 'scripts', 'data', 'test-tiers.json'), JSON.stringify({ schema: 1, large: ['tests/test-large.mjs'] }));
  const body = (name, failVar) => [
    "import { test } from 'node:test';",
    "import { appendFileSync, existsSync } from 'node:fs';",
    `test(${JSON.stringify(name)}, async () => {`,
    `  appendFileSync(process.env.CHAIN_LOG, ${JSON.stringify(name)} + ' ' + process.ppid + '\\n');`,
    "  if (process.env.CHAIN_HOLD) {",
    "    const until = Date.now() + 20000;",
    "    while (!existsSync(process.env.CHAIN_HOLD) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));",
    '  }',
    `  if (process.env.${failVar}) throw new Error(${JSON.stringify(`${name} fails`)});`,
    '});',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(root, 'tests', 'test-pool.mjs'), body('pool', 'FAIL_POOL'));
  fs.writeFileSync(path.join(root, 'tests', 'test-large.mjs'), body('large', 'FAIL_LARGE'));
  return { root, log, entries: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => l.split(' ')) : []) };
}

const npmTest = (root, log, extra = {}, args = []) => spawnSync('npm', ['test', ...(args.length ? ['--', ...args] : [])], {
  cwd: root, encoding: 'utf8', timeout: 120_000, env: { ...childEnv(), CHAIN_LOG: log, ...extra },
});

test('npm test runs the pool, then the large tier, each in its own node --test', () => {
  const { root, log, entries } = fixture();
  try {
    const r = npmTest(root, log);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const e = entries();
    assert.deepEqual(e.map(([n]) => n), ['pool', 'large'], 'the large file ran after the pool');
    assert.notEqual(e[0][1], e[1][1], 'two node --test processes');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a failing large file fails the run; a failing pool file fails it and the large pass still runs', () => {
  const { root, log, entries } = fixture();
  try {
    const large = npmTest(root, log, { FAIL_LARGE: '1' });
    assert.notEqual(large.status, 0, 'the large pass failed the run');
    fs.rmSync(log, { force: true });
    const pool = npmTest(root, log, { FAIL_POOL: '1' });
    assert.notEqual(pool.status, 0, 'the pool failed the run');
    assert.deepEqual(entries().map(([n]) => n), ['pool', 'large'], 'the large pass ran after the failed pool');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('an inherited NODE_TEST_CONTEXT is removed: the files run', () => {
  const { root, log, entries } = fixture();
  try {
    const r = npmTest(root, log, { NODE_TEST_CONTEXT: 'child-v8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(entries().map(([n]) => n), ['pool', 'large']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a duration recording of both passes is one shard-tests record takes, and no temporary directory is left', () => {
  const { root, log } = fixture();
  try {
    const out = path.join(root, 'rec.jsonl');
    const tmp = path.join(root, 'tmp');
    fs.mkdirSync(tmp);
    const r = npmTest(root, log, { TMPDIR: tmp }, [`--test-reporter=${REPORTER}`, `--test-reporter-destination=${out}`, '--test-reporter=spec', '--test-reporter-destination=stdout']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const text = fs.readFileSync(out, 'utf8');
    assert.equal(text.trim().split('\n').filter((l) => JSON.parse(l).summary === true).length, 2, `one summary per pass:\n${text}`);
    assert.deepEqual(Object.keys(weightsFromRecording(root, text).seconds), ['tests/test-large.mjs', 'tests/test-pool.mjs']);
    assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.startsWith('run-tests-')), [], 'the large pass\'s private directory is removed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('npm test with a document reporter in NODE_OPTIONS refuses before any pass', () => {
  const { root, log, entries } = fixture();
  try {
    const r = npmTest(root, log, { NODE_OPTIONS: '--test-reporter=tap' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /the tap reporter writes one document per run/);
    assert.deepEqual(entries(), [], 'no test ran');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('SIGTERM during the pool starts no large pass, and the run exits 143', async () => {
  const { root, log, entries } = fixture();
  const hold = path.join(root, 'go');
  try {
    const child = spawn(process.execPath, [RUNNER, '--test-timeout=60000'], {
      cwd: root, stdio: 'ignore', env: { ...childEnv(), CHAIN_LOG: log, CHAIN_HOLD: hold },
    });
    const exited = new Promise((done) => { child.once('exit', (code, signal) => done({ code, signal })); });
    const until = Date.now() + 30_000;
    while (entries().length === 0 && Date.now() < until) await new Promise((r) => { setTimeout(r, 20); });
    assert.deepEqual(entries().map(([n]) => n), ['pool'], 'the pool started');
    child.kill('SIGTERM');
    const { code, signal } = await exited;
    fs.writeFileSync(hold, '');
    assert.deepEqual({ code, signal }, { code: 143, signal: null });
    await new Promise((r) => { setTimeout(r, 300); });
    assert.deepEqual(entries().map(([n]) => n), ['pool'], 'no large pass started');
  } finally {
    fs.writeFileSync(hold, '');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
