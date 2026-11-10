// The temporary-file leak guard of `npm test` (docket C175): the helper
// tests/_tmp.mjs, the guard tests/_tmp-guard.mjs, its declaration and summary
// (scripts/lib/tmp-leaks.mjs) and its wiring in scripts/run-tests.mjs.
//
// The helper: removeTree removes only what is strictly inside the base it is
// given, as holdBase took it when the caller allocated (every refusal decided
// from the two strings is tried on a fake file system that records its calls,
// none of which may be made: no such input ever reaches the real one; the
// refusals that need a look at the file system are tried on the fake too,
// and two of them, a link that leads out of the base and a base replaced
// since it was held, once each on the real one as well, on directories the
// test made in its own temporary directory),
// removes a read-only tree (its root repaired first, then retried once,
// through the same seam so it holds as root too) and never follows a link
// (named with a trailing separator included, or among the path's
// directories); tmpDir and fileTmpDirs remove their directories when a test
// fails, checked from an outer process after the fixture's process ended.
//
// The guard, on fixture files run by a real `node --test` with it preloaded:
// each file gets a TMPDIR of its own in the run directory; an undeclared file
// that leaves an entry fails and a clean one beside it passes; an entry left
// by a child process (mktemp -d) is charged to its file; a declared file
// passes; a file that removes its fixture in an exit listener leaves nothing;
// a file that ends its process inside a test is still counted; an entry made
// after the guard's count (a later exit listener) is charged by the runner,
// which fails the run for it; the guard
// changes nothing without its variable or under an enclosing guarded file.
//
// The runner: the guard's preload goes first in every pass,
// `--test-isolation=none` is refused, a count that is not whole fails the run
// whatever the declaration says, and `npm test` on a fixture repository
// whose package.json carries the real preloads (tests/_hermetic-env.mjs among
// them, which removes AGENTIC_*_ROOT variables) fails an undeclared leaker,
// prints the summary, charges a killed file what its directory holds and
// leaves no run directory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { tmpDir } from '../_tmp.mjs';
import { containedPath, holdBase, ownPath, removeTree } from '../../scripts/lib/remove-tree.mjs';
import { TMP_GUARD_URL, buildPasses, childEnv, guardEnv, guardedStatus, refuseUnguarded, runsPartially, withTmpGuard } from '../../scripts/run-tests.mjs';
import {
  GUARD_DIR_VAR, GUARD_OWNER_VAR, LEAKS_FILE, collectRun, fileKey, guardFailures, readLeaks, startRun, summarize, validateLeaks,
} from '../../scripts/lib/tmp-leaks.mjs';
import { listTestFiles } from '../../scripts/lib/discover-tests.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RUNNER = path.join(REPO_ROOT, 'scripts', 'run-tests.mjs');
const TMP_URL = pathToFileURL(path.join(REPO_ROOT, 'tests', '_tmp.mjs')).href;
const PKG_ARGV = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).scripts.test.split(' ').slice(2);

// ---- removeTree --------------------------------------------------------------

test('removeTree removes a tree whose directories were made read-only, and a missing path is fine', (t) => {
  const base = holdBase(tmpDir(t, 'tg-ro-'));
  const tree = path.join(base.path, 'tree');
  fs.mkdirSync(path.join(tree, 'a', 'b'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'a', 'b', 'f'), 'x');
  fs.chmodSync(path.join(tree, 'a', 'b'), 0o500);
  fs.chmodSync(path.join(tree, 'a'), 0o500);
  fs.chmodSync(tree, 0o000);
  removeTree(base, tree);
  assert.equal(fs.existsSync(tree), false);
  removeTree(base, tree);
});

test('removeTree never follows a link: the link goes, its target stays; a dangling link goes', (t) => {
  const base = holdBase(tmpDir(t, 'tg-link-'));
  const outside = path.join(base.path, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep'), 'k');
  const tree = path.join(base.path, 'tree');
  fs.mkdirSync(tree);
  fs.symlinkSync(outside, path.join(tree, 'to-outside'));
  removeTree(base, tree);
  assert.equal(fs.existsSync(tree), false);
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'k', 'the target is untouched');
  const top = path.join(base.path, 'top-link');
  fs.symlinkSync(outside, top);
  removeTree(base, top);
  assert.equal(fs.existsSync(top), false);
  assert.ok(fs.existsSync(path.join(outside, 'keep')), 'a top-level link is removed, never its target');
  const dangling = path.join(base.path, 'dangling');
  fs.symlinkSync(path.join(base.path, 'nothing'), dangling);
  removeTree(base, dangling);
  assert.throws(() => fs.lstatSync(dangling), { code: 'ENOENT' });
});

test('removeTree removes a link named with a trailing separator, never its target', (t) => {
  const base = holdBase(tmpDir(t, 'tg-slash-'));
  const outside = path.join(base.path, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep'), 'k');
  const link = path.join(base.path, 'link');
  fs.symlinkSync(outside, link);
  // lstat of `link/` answers for the target, a directory: taken as given, the
  // target would be emptied.
  assert.ok(fs.lstatSync(link + path.sep).isDirectory(), 'the spelling under test resolves the link');
  removeTree(base, link + path.sep);
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'k', 'the target is untouched');
  assert.throws(() => fs.lstatSync(link), { code: 'ENOENT' }, 'the link is removed');
  const dot = path.join(base.path, 'dot');
  fs.symlinkSync(outside, dot);
  removeTree(base, `${dot}${path.sep}.${path.sep}`);
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'k', 'nor through a trailing /.');
  assert.throws(() => fs.lstatSync(dot), { code: 'ENOENT' });
});

// A file system that records every call and touches nothing: it holds
// whoever runs the test, root included. Every path is a directory; `real`
// maps a path to what it resolves to (itself when not named); the first
// `failFirst` removals are refused as a read-only tree's would be.
function fakeFs({ failFirst = 0, real = {} } = {}) {
  const calls = [];
  let rmCalls = 0;
  const dirStat = { isDirectory: () => true };
  return {
    calls,
    lstatSync(p) { calls.push(['lstat', p]); return dirStat; },
    realpathSync(p) { calls.push(['realpath', p]); return real[p] ?? p; },
    chmodSync(p, mode) { calls.push(['chmod', p, mode]); },
    readdirSync(p) { calls.push(['readdir', p]); return []; },
    unlinkSync(p) { calls.push(['unlink', p]); },
    rmSync(p) {
      calls.push(['rm', p]);
      rmCalls += 1;
      if (rmCalls <= failFirst) throw Object.assign(new Error(`EACCES: ${p}`), { code: 'EACCES' });
    },
  };
}

// A base as holdBase returns it, written by hand for the fake file system:
// the name, and what it resolved to when it was held (itself by default).
const held = (dir, real = dir) => ({ path: dir, real });

// The refusals below never reach a real file system: each is tried on the
// fake one, which must record no call at all.
const REFUSED = [
  ['/t', '', 'an empty path'],
  ['/t', undefined, 'no path'],
  ['/t', 'rel/x', 'a relative path'],
  ['/t', '.', 'the working directory'],
  ['/t', '/', 'the root'],
  ['/t', '/t', 'the base itself'],
  ['/t', '/t/', 'the base itself, with a separator'],
  ['/t', '/t/.', 'the base itself, with a dot'],
  ['/t', '/tt/x', 'a sibling whose name starts as the base does'],
  ['/t', '/u/x', 'a path elsewhere'],
  ['/t', '/t/../u', 'a path that leaves the base through ..'],
  ['/t', '/t/a/../../u', 'a deeper path that leaves it through ..'],
  ['/t', '/t/a/../b', 'a path with .. that stays inside: not written plainly'],
  ['/t', '/t/./a', 'a path with a dot component'],
  ['/t', '/t//a', 'a path with a doubled separator'],
  ['/', '/x', 'a root as the base'],
  ['', '/x', 'an empty base'],
  [undefined, '/x', 'no base'],
  ['t', 't/x', 'a relative base'],
  ['/a/../t', '/t/x', 'a base with ..'],
];

test('removeTree refuses whatever is not strictly inside its base, before any file system call', () => {
  for (const [base, given, what] of REFUSED) {
    const fsx = fakeFs();
    assert.throws(() => removeTree(held(base), given, fsx), (err) => err instanceof RangeError || err instanceof TypeError, what);
    assert.deepEqual(fsx.calls, [], `${what}: no file system call`);
    assert.throws(() => containedPath(base, given), undefined, what);
  }
  // A base that is not what holdBase returned, a bare string included, is
  // refused whatever the path, before any file system call.
  for (const base of ['/t', undefined, null, {}, { path: '/t' }, { path: '/t', real: '' }, { real: '/t' }]) {
    const fsx = fakeFs();
    assert.throws(() => removeTree(base, '/t/a', fsx), TypeError, `base ${JSON.stringify(base)}`);
    assert.deepEqual(fsx.calls, [], `base ${JSON.stringify(base)}: no file system call`);
  }
  assert.equal(containedPath('/t', '/t/a'), '/t/a');
  assert.equal(containedPath('/t/', '/t/a/b/'), '/t/a/b', 'trailing separators are dropped, of the base too');
  assert.equal(containedPath('/t', '/t/a/.'), '/t/a');
  const fsx = fakeFs();
  removeTree(held('/t'), '/t/a/', fsx);
  assert.deepEqual(fsx.calls.filter(([op]) => op === 'rm'), [['rm', '/t/a']], 'a path inside its base is removed');
});

test('holdBase keeps the directory and what it resolves to, and refuses what removeTree would as a base', () => {
  const linked = fakeFs({ real: { '/t': '/private/t' } });
  const base = holdBase('/t/', linked);
  assert.deepEqual({ ...base }, { path: '/t', real: '/private/t' });
  assert.ok(Object.isFrozen(base));
  for (const dir of ['', undefined, 't', '/', '/a/../t', '/t//u', '/t/./u']) {
    const fsx = fakeFs();
    assert.throws(() => holdBase(dir, fsx), (err) => err instanceof RangeError || err instanceof TypeError, `${JSON.stringify(dir)}`);
    assert.deepEqual(fsx.calls, [], `${JSON.stringify(dir)}: no file system call`);
  }
  assert.throws(() => holdBase('/t/root-link', fakeFs({ real: { '/t/root-link': '/' } })), RangeError, 'a link to the root');
});

const changes = (fsx) => fsx.calls.map(([op]) => op).filter((op) => op !== 'lstat' && op !== 'realpath');

test('removeTree refuses when its base no longer resolves to what holdBase saw', (t) => {
  // Held while /t was a directory; by the removal /t is a link to /elsewhere,
  // so /t/x is /elsewhere/x. No process need still be running for that.
  const base = holdBase('/t', fakeFs());
  const replaced = fakeFs({ real: { '/t': '/elsewhere' } });
  assert.throws(() => removeTree(base, '/t/x', replaced), /no longer resolves/);
  assert.deepEqual(changes(replaced), [], 'nothing is removed or changed');
  // Read-only repair is a change too: refused before the first removal call.
  const repairing = fakeFs({ real: { '/t': '/elsewhere' }, failFirst: 1 });
  assert.throws(() => removeTree(base, '/t/x', repairing), RangeError);
  assert.deepEqual(changes(repairing), [], 'no chmod either');
  // Held through a link (macOS: /var is one), unchanged since: removed.
  const linked = fakeFs({ real: { '/t': '/private/t' } });
  const same = holdBase('/t', linked);
  removeTree(same, '/t/x', linked);
  assert.deepEqual(linked.calls.filter(([op]) => op === 'rm'), [['rm', '/t/x']]);
  // On the real file system, in this test's own temporary directory: the
  // base is moved aside and a link to a sibling made here takes its name.
  const root = tmpDir(t, 'tg-swap-');
  const dir = path.join(root, 'base');
  const other = path.join(root, 'other');
  fs.mkdirSync(dir);
  fs.mkdirSync(path.join(other, 'child'), { recursive: true });
  fs.writeFileSync(path.join(other, 'child', 'keep'), 'k');
  const real = holdBase(dir);
  fs.mkdirSync(path.join(dir, 'child'));
  fs.renameSync(dir, path.join(root, 'base-moved'));
  fs.symlinkSync(other, dir);
  assert.throws(() => removeTree(real, path.join(dir, 'child')), /no longer resolves/);
  assert.equal(fs.readFileSync(path.join(other, 'child', 'keep'), 'utf8'), 'k', 'what the base now leads to is untouched');
});

test('removeTree refuses a path a link among its directories leads out of its base', (t) => {
  const fsx = fakeFs({ real: { '/t/link': '/elsewhere' } });
  assert.throws(() => removeTree(held('/t'), '/t/link/x', fsx), /leads out of its base/);
  assert.deepEqual(fsx.calls.map(([op]) => op).filter((op) => op !== 'lstat' && op !== 'realpath'), [], 'nothing is removed or changed');
  // A base held by hand as resolving to the root (holdBase itself refuses
  // one): still refused at the removal.
  const toRoot = fakeFs({ real: { '/t/root-link': '/', '/t': '/' } });
  assert.throws(() => removeTree(held('/t/root-link', '/'), '/t/root-link/home', toRoot), /file system root/, 'a base that is a link to the root');
  assert.deepEqual(toRoot.calls.map(([op]) => op).filter((op) => op !== 'lstat' && op !== 'realpath'), [], 'nothing is removed or changed');
  const inside = fakeFs({ real: { '/t': '/private/t', '/t/a': '/private/t/a' } });
  removeTree(held('/t', '/private/t'), '/t/a/x', inside);
  assert.deepEqual(inside.calls.filter(([op]) => op === 'rm'), [['rm', '/t/a/x']], 'a base reached through a link holds its own entries');
  // On the real file system, in this test's own temporary directory: the
  // link's target is a sibling of the base, made here.
  const root = tmpDir(t, 'tg-out-');
  const dir = path.join(root, 'base');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(dir);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep'), 'k');
  const base = holdBase(dir);
  fs.symlinkSync(outside, path.join(dir, 'link'));
  assert.throws(() => removeTree(base, path.join(dir, 'link', 'keep')), /leads out of its base/);
  assert.equal(fs.readFileSync(path.join(outside, 'keep'), 'utf8'), 'k', 'what the link leads to is untouched');
  removeTree(base, path.join(dir, 'link'));
  assert.throws(() => fs.lstatSync(path.join(dir, 'link')), { code: 'ENOENT' }, 'the link itself, inside the base, is removed');
  assert.ok(fs.existsSync(path.join(outside, 'keep')));
});

test('ownPath drops only what follows the last component', () => {
  assert.throws(() => ownPath(''), TypeError);
  assert.throws(() => ownPath(undefined), TypeError);
  assert.equal(ownPath('/'), '/');
  assert.equal(ownPath('a/b//'), 'a/b');
  assert.equal(ownPath('a/b/./.'), 'a/b');
  assert.equal(ownPath('a/../b'), 'a/../b');
  assert.equal(ownPath('.'), '.');
  assert.equal(ownPath('a/..'), 'a/..');
});

test('removeTree repairs the root before listing it, then removes again once', () => {
  const fsx = fakeFs({ failFirst: 1 });
  removeTree(held('/b'), '/b/x', fsx);
  const ops = fsx.calls.map(([op]) => op);
  assert.deepEqual(ops.filter((op) => op === 'rm'), ['rm', 'rm'], 'one retry');
  const chmod = ops.indexOf('chmod');
  assert.ok(chmod !== -1 && chmod < ops.indexOf('readdir'), `the root is repaired before it is listed: ${ops.join(' ')}`);
  assert.deepEqual(fsx.calls.find(([op]) => op === 'chmod'), ['chmod', '/b/x', 0o700]);
  assert.throws(() => removeTree(held('/b'), '/b/y', fakeFs({ failFirst: 2 })), { code: 'EACCES' }, 'a tree still there after the retry throws');
});

test('a file\'s directory that is there and cannot be listed counts as an entry', (t) => {
  const runDir = startRun({ repoRoot: '/r', leaks: [], tmp: tmpDir(t, 'tg-unread-') });
  // A file where the directory would be: listing it fails with ENOTDIR, for
  // root too, as a mode-000 directory does for any other user.
  for (const [base, result] of [['f-aaaaaa', { file: 'tests/test-a.mjs', count: 0, names: [] }], ['f-bbbbbb', null]]) {
    fs.writeFileSync(path.join(runDir, base), '');
    fs.writeFileSync(path.join(runDir, `${base}.owner.json`), JSON.stringify({ file: result ? 'tests/test-a.mjs' : 'tests/test-b.mjs', pid: 1 }));
    if (result) fs.writeFileSync(path.join(runDir, `${base}.result.json`), JSON.stringify(result));
  }
  const { files } = collectRun(runDir, []);
  assert.deepEqual(files.get('tests/test-a.mjs'), { count: 1, names: ['(unreadable: ENOTDIR)'], complete: true, late: 1, unreadable: true, kept: false });
  assert.deepEqual(files.get('tests/test-b.mjs'), { count: 1, names: ['(unreadable: ENOTDIR)'], complete: false, late: 0, unreadable: true, kept: false });
  assert.equal(summarize({ files, missing: [] }, []).unlisted, 2, 'both fail the run');
  const declared = summarize({ files, missing: [] }, ['tests/test-a.mjs', 'tests/test-b.mjs']);
  assert.equal(declared.unlisted, 0);
  assert.deepEqual(declared.unreadable, ['tests/test-a.mjs', 'tests/test-b.mjs']);
  assert.match(guardFailures({ summary: declared }).join('\n'), /temporary directory of 2 files could not be listed: tests\/test-a\.mjs tests\/test-b\.mjs/, 'declared or not');
  assert.throws(() => collectRun(path.join(runDir, 'absent'), []), { code: 'ENOENT' }, 'a run directory that cannot be listed is no empty run');
});

// ---- the helper, from an outer process --------------------------------------

/**
 * This process's environment with no NODE_TEST_* variable and none of the
 * guard's: under npm test this file is itself guarded, and a fixture run
 * inheriting its owner variable would run unguarded.
 */
function cleanEnv() {
  const env = childEnv();
  delete env[GUARD_OWNER_VAR];
  delete env[GUARD_DIR_VAR];
  return env;
}

/** A `node --test` run of `files` in `cwd`, in a clean environment. */
function nodeTest(cwd, files, { env = {}, guard = false, args = [] } = {}) {
  return spawnSync(process.execPath, ['--test', ...(guard ? [`--import=${TMP_GUARD_URL}`] : []), ...args, ...files], {
    cwd, encoding: 'utf8', timeout: 60_000, env: { ...cleanEnv(), ...env },
  });
}

test('tmpDir and fileTmpDirs remove their directories when a test fails', (t) => {
  const dir = tmpDir(t, 'tg-helper-');
  const report = path.join(dir, 'made');
  const tmp = path.join(dir, 'tmp');
  fs.mkdirSync(tmp);
  fs.writeFileSync(path.join(dir, 'test-fixture.mjs'), [
    "import { test } from 'node:test';",
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    `import { tmpDir, fileTmpDirs } from ${JSON.stringify(TMP_URL)};`,
    'const shared = fileTmpDirs();',
    "const top = shared('shared-');",
    `fs.appendFileSync(${JSON.stringify(report)}, top + '\\n');`,
    "test('fails after making a directory', (t) => {",
    "  const d = tmpDir(t, 'own-');",
    "  fs.mkdirSync(path.join(d, 'sub'));",
    "  fs.writeFileSync(path.join(d, 'sub', 'f'), 'x');",
    "  fs.chmodSync(path.join(d, 'sub'), 0o500);",
    `  fs.appendFileSync(${JSON.stringify(report)}, d + '\\n');`,
    "  throw new Error('boom');",
    '});',
    '',
  ].join('\n'));
  const r = nodeTest(dir, ['test-fixture.mjs'], { env: { TMPDIR: tmp } });
  assert.notEqual(r.status, 0, 'the fixture\'s test failed');
  const made = fs.readFileSync(report, 'utf8').trim().split('\n');
  assert.equal(made.length, 2, made.join('\n'));
  for (const p of made) {
    assert.ok(p.startsWith(tmp + path.sep), `made under the TMPDIR given: ${p}`);
    assert.equal(fs.existsSync(p), false, `${p} was removed after the failure`);
  }
  assert.deepEqual(fs.readdirSync(tmp), []);
});

test('tmpDir refuses a prefix that would make its directory outside the base, before making anything', (t) => {
  const made = [];
  const fakeT = { after: (fn) => made.push(fn) };
  for (const prefix of ['', '../x-', 'a/b-', '..', null, 7]) {
    assert.throws(() => tmpDir(fakeT, prefix), TypeError, JSON.stringify(prefix));
  }
  assert.deepEqual(made, [], 'nothing was made, so nothing is registered');
  assert.ok(fs.existsSync(tmpDir(t, 'tg-ok-')));
});

// ---- the guard, on fixture files ---------------------------------------------

/** A fixture repository of test files, with a run directory for the guard. */
function guardFixture(t, files, { leaks = [] } = {}) {
  const root = fs.realpathSync(tmpDir(t, 'tg-fix-'));
  const report = path.join(root, 'report.jsonl');
  fs.mkdirSync(path.join(root, 'tests'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(root, 'tests', name), body);
  const runDir = startRun({ repoRoot: root, leaks, tmp: root });
  const reports = () => (fs.existsSync(report) ? fs.readFileSync(report, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const run = (names, extra = {}) => nodeTest(root, names.map((n) => `tests/${n}`), { guard: true, env: { ...guardEnv(runDir, {}), TG_REPORT: report, ...extra } });
  return { root, runDir, reports, run };
}

const body = (lines) => [
  "import { test } from 'node:test';",
  "import fs from 'node:fs';",
  "import os from 'node:os';",
  "import path from 'node:path';",
  "import { execFileSync } from 'node:child_process';",
  "const note = () => fs.appendFileSync(process.env.TG_REPORT, JSON.stringify({ file: path.basename(process.argv[1]), tmp: os.tmpdir() }) + '\\n');",
  ...lines,
  '',
].join('\n');

const FILES = {
  'test-leak.mjs': body(["test('leaks', () => { note(); fs.mkdtempSync(path.join(os.tmpdir(), 'left-')); });"]),
  'test-clean.mjs': body(["test('clean', () => { note(); fs.rmSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gone-')), { recursive: true }); });"]),
  'test-child.mjs': body(["test('a child leaks', () => { note(); execFileSync('mktemp', ['-d']); });"]),
  'test-exit-hook.mjs': body([
    "const d = fs.mkdtempSync(path.join(os.tmpdir(), 'exit-'));",
    "process.on('exit', () => fs.rmSync(d, { recursive: true, force: true }));",
    "test('removed at exit', () => { note(); });",
  ]),
  'test-exits.mjs': body(["test('ends its process', () => { note(); fs.mkdtempSync(path.join(os.tmpdir(), 'left-')); process.exit(0); });"]),
};

test('each file gets a TMPDIR of its own in the run directory, recorded with its owner', (t) => {
  const { runDir, reports, run } = guardFixture(t, FILES);
  const r = run(['test-clean.mjs', 'test-exit-hook.mjs']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const seen = reports();
  assert.deepEqual(seen.map((s) => s.file).sort(), ['test-clean.mjs', 'test-exit-hook.mjs']);
  assert.notEqual(seen[0].tmp, seen[1].tmp, 'two directories');
  for (const s of seen) assert.equal(path.dirname(s.tmp), runDir, `under the run directory: ${s.tmp}`);
  const { files, missing } = collectRun(runDir, ['tests/test-clean.mjs', 'tests/test-exit-hook.mjs']);
  assert.deepEqual([...files.keys()].sort(), ['tests/test-clean.mjs', 'tests/test-exit-hook.mjs'], 'each owner record names its file');
  assert.deepEqual(missing, []);
  assert.deepEqual([...files.values()].map((e) => e.count), [0, 0], 'the exit listener ran before the count');
  assert.deepEqual(fs.readdirSync(runDir).filter((n) => !n.endsWith('.json')), [], 'each file\'s directory is removed');
});

test('an undeclared file that leaves an entry fails, and is charged it; a clean one beside it is charged nothing', (t) => {
  const { runDir, run } = guardFixture(t, FILES);
  const both = run(['test-leak.mjs', 'test-clean.mjs']);
  assert.notEqual(both.status, 0);
  assert.match(both.stdout + both.stderr, /tests\/test-leak\.mjs left 1 entries in its temporary directory \(left-/);
  const { files } = collectRun(runDir, []);
  assert.equal(files.get('tests/test-leak.mjs').count, 1);
  assert.equal(files.get('tests/test-clean.mjs').count, 0);
  assert.equal(run(['test-clean.mjs']).status, 0, 'the clean file alone passes');
});

test('an entry a child process leaves is charged to its file', (t) => {
  const { runDir, run } = guardFixture(t, FILES);
  const r = run(['test-child.mjs', 'test-clean.mjs']);
  assert.notEqual(r.status, 0);
  const { files } = collectRun(runDir, []);
  assert.equal(files.get('tests/test-child.mjs').count, 1);
  assert.match(files.get('tests/test-child.mjs').names[0], /^tmp\./);
  assert.equal(files.get('tests/test-clean.mjs').count, 0);
});

test('a declared file that leaves an entry passes', (t) => {
  const { runDir, run } = guardFixture(t, FILES, { leaks: ['tests/test-leak.mjs'] });
  const r = run(['test-leak.mjs']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(collectRun(runDir, []).files.get('tests/test-leak.mjs').count, 1, 'still counted');
});

test('a file that ends its process inside a test is still counted', (t) => {
  const { runDir, run } = guardFixture(t, FILES);
  const r = run(['test-exits.mjs']);
  assert.notEqual(r.status, 0);
  assert.equal(collectRun(runDir, []).files.get('tests/test-exits.mjs').count, 1);
});

test('a file whose result cannot be written keeps its directory, which the runner counts as incomplete', (t) => {
  const { runDir, run } = guardFixture(t, {
    'test-noresult.mjs': body([
      "test('blocks its result', () => { fs.mkdtempSync(path.join(os.tmpdir(), 'left-')); fs.mkdirSync(process.env.TMPDIR + '.result.json'); });",
    ]),
  });
  run(['test-noresult.mjs']);
  const e = collectRun(runDir, []).files.get('tests/test-noresult.mjs');
  assert.deepEqual({ count: e.count, complete: e.complete }, { count: 1, complete: false });
  assert.match(e.names[0], /^left-/);
});

// A file whose exit listener, registered from its own root after() hook and
// so run after the guard's count, makes an entry in the removed directory.
const LATE = body([
  "import { after } from 'node:test';",
  "after(() => process.on('exit', () => { fs.mkdirSync(path.join(os.tmpdir(), 'late-entry'), { recursive: true }); }));",
  "test('clean while it runs', () => { note(); });",
]);

test('an entry made after the guard\'s count is charged to its file by the runner', (t) => {
  const { runDir, run } = guardFixture(t, { 'test-late.mjs': LATE, 'test-clean.mjs': FILES['test-clean.mjs'] });
  run(['test-late.mjs', 'test-clean.mjs']);
  const { files } = collectRun(runDir, []);
  const e = files.get('tests/test-late.mjs');
  assert.deepEqual({ count: e.count, late: e.late, complete: e.complete, names: e.names }, { count: 1, late: 1, complete: true, names: ['late-entry'] });
  assert.deepEqual({ count: files.get('tests/test-clean.mjs').count, late: files.get('tests/test-clean.mjs').late }, { count: 0, late: 0 });
  const s = summarize({ files, missing: [] }, []);
  assert.equal(s.unlisted, 1);
  assert.match(s.lines[1], /^ {2}1\ttests\/test-late\.mjs \(not declared: fails\) \(1 made after its count\)\tlate-entry/);
});

test('a directory the guard could not remove is counted once, not again as made later', (t) => {
  const runDir = startRun({ repoRoot: '/r', leaks: [], tmp: tmpDir(t, 'tg-kept-') });
  const dir = path.join(runDir, 'f-aaaaaa');
  fs.mkdirSync(path.join(dir, 'left-1'), { recursive: true });
  fs.writeFileSync(`${dir}.owner.json`, JSON.stringify({ file: 'tests/test-kept.mjs', pid: 1 }));
  fs.writeFileSync(`${dir}.result.json`, JSON.stringify({ file: 'tests/test-kept.mjs', count: 1, names: ['left-1'], kept: ['left-1'] }));
  const kept = collectRun(runDir, []).files.get('tests/test-kept.mjs');
  assert.deepEqual({ count: kept.count, late: kept.late, kept: kept.kept }, { count: 1, late: 0, kept: true });
  const s = summarize(collectRun(runDir, []), ['tests/test-kept.mjs']);
  assert.match(guardFailures({ summary: s }).join('\n'), /temporary directory of 1 files could not be removed: tests\/test-kept\.mjs/, 'a declared file too');
  fs.mkdirSync(path.join(dir, 'late-2'));
  const more = collectRun(runDir, []).files.get('tests/test-kept.mjs');
  assert.deepEqual({ count: more.count, late: more.late, names: more.names }, { count: 2, late: 1, names: ['left-1', 'late-2'] }, 'an entry the kept list does not name was made after the count');
  fs.rmdirSync(path.join(dir, 'late-2'));
  // A result that is not its owner's, or whose count cannot be one, is no result.
  for (const bad of [{ file: 'tests/test-other.mjs', count: 0, names: [] }, { file: 'tests/test-kept.mjs', count: -1, names: [] }]) {
    fs.writeFileSync(`${dir}.result.json`, JSON.stringify(bad));
    const e = collectRun(runDir, []).files.get('tests/test-kept.mjs');
    assert.deepEqual({ count: e.count, complete: e.complete }, { count: 1, complete: false }, JSON.stringify(bad));
  }
  // A count the guard could not take stays unreadable after its directory went.
  fs.writeFileSync(`${dir}.result.json`, JSON.stringify({ file: 'tests/test-kept.mjs', count: 1, names: ['(unreadable: EACCES)'], unreadable: true, kept: ['left-1'] }));
  assert.equal(collectRun(runDir, []).files.get('tests/test-kept.mjs').unreadable, true);
  fs.writeFileSync(`${dir}.result.json`, JSON.stringify({ file: 'tests/test-kept.mjs', count: 1, names: ['gone-0'] }));
  const again = collectRun(runDir, []).files.get('tests/test-kept.mjs');
  assert.deepEqual({ count: again.count, late: again.late, names: again.names }, { count: 2, late: 1, names: ['gone-0', 'left-1'] }, 'without the mark, what the directory holds was made after the count');
});

test('the guard changes nothing without its variable, or under an enclosing guarded file', (t) => {
  const { root, runDir, reports, run } = guardFixture(t, FILES);
  const tmp = path.join(root, 'plain');
  fs.mkdirSync(tmp);
  const plain = nodeTest(root, ['tests/test-leak.mjs'], { guard: true, env: { TMPDIR: tmp, TG_REPORT: path.join(root, 'report.jsonl') } });
  assert.equal(plain.status, 0, plain.stdout + plain.stderr);
  assert.equal(reports()[0].tmp, tmp, 'TMPDIR as given');
  const nested = run(['test-leak.mjs'], { [GUARD_OWNER_VAR]: '/somewhere', TMPDIR: tmp });
  assert.equal(nested.status, 0, nested.stdout + nested.stderr);
  assert.equal(reports()[1].tmp, tmp);
  assert.deepEqual(fs.readdirSync(runDir), ['run.json']);
});

test('a test file is keyed by its path as given, a link\'s own path included', (t) => {
  const root = fs.realpathSync(tmpDir(t, 'tg-key-'));
  fs.mkdirSync(path.join(root, 'tests'));
  fs.writeFileSync(path.join(root, 'tests', 'body.mjs'), '');
  fs.symlinkSync('body.mjs', path.join(root, 'tests', 'test-link.mjs'));
  assert.equal(fileKey(root, path.join(root, 'tests', 'test-link.mjs')), 'tests/test-link.mjs');
  assert.equal(fileKey(root, path.join(root, 'tests', 'body.mjs')), 'tests/body.mjs');
  const alias = path.join(tmpDir(t, 'tg-alias-'), 'repo');
  fs.symlinkSync(root, alias);
  assert.equal(fileKey(root, path.join(alias, 'tests', 'body.mjs')), 'tests/body.mjs', 'a file reached through another spelling of the repository');
  // The runner's key of a file named through that spelling is the same file.
  const runDir = startRun({ repoRoot: root, leaks: [], tmp: tmpDir(t, 'tg-alias-run-') });
  fs.writeFileSync(path.join(runDir, 'f-aaaaaa.owner.json'), JSON.stringify({ file: 'tests/body.mjs', pid: 1 }));
  fs.writeFileSync(path.join(runDir, 'f-aaaaaa.result.json'), JSON.stringify({ file: 'tests/body.mjs', count: 0, names: [] }));
  const viaAlias = path.relative(root, path.join(alias, 'tests', 'body.mjs')).split(path.sep).join('/');
  assert.deepEqual(collectRun(runDir, [viaAlias, 'tests/absent.mjs']).missing, ['tests/absent.mjs']);
});

test('a run directory whose run.json cannot be written is removed', (t) => {
  const tmp = tmpDir(t, 'tg-start-');
  assert.throws(() => startRun({ repoRoot: '/r', leaks: [1n], tmp }), TypeError);
  assert.deepEqual(fs.readdirSync(tmp), []);
});

// ---- the declaration ---------------------------------------------------------

test('the declaration is sorted, unique, and names only discovered files', () => {
  const discovered = listTestFiles(REPO_ROOT);
  const leaks = readLeaks(REPO_ROOT, discovered);
  assert.ok(Array.isArray(leaks));
  const ok = { schema: 1, leaks: ['tests/a.mjs', 'tests/b.mjs'] };
  assert.deepEqual(validateLeaks(ok, ['tests/a.mjs', 'tests/b.mjs']), ok.leaks);
  assert.throws(() => validateLeaks({ schema: 1, leaks: ['tests/b.mjs', 'tests/a.mjs'] }, ['tests/a.mjs', 'tests/b.mjs']), /out of order/);
  assert.throws(() => validateLeaks({ schema: 1, leaks: ['tests/a.mjs', 'tests/a.mjs'] }, ['tests/a.mjs']), /declared twice/);
  assert.throws(() => validateLeaks({ schema: 1, leaks: ['tests/gone.mjs'] }, ['tests/a.mjs']), /not a test file discovery finds/);
  assert.throws(() => validateLeaks({ schema: 2, leaks: [] }, []), /schema/);
  assert.throws(() => validateLeaks({ schema: 1, leaks: [], extra: 1 }, []), /keys it does not declare/);
});

test('the summary counts each leaking file, the undeclared, the stale and the incomplete', () => {
  const files = new Map([
    ['tests/a.mjs', { count: 3, names: ['x', 'y', 'z'], complete: true }],
    ['tests/b.mjs', { count: 1, names: ['w'], complete: false }],
    ['tests/c.mjs', { count: 0, names: [], complete: true }],
    ['tests/d.mjs', { count: 0, names: [], complete: true }],
  ]);
  const s = summarize({ files, missing: ['tests/e.mjs'] }, ['tests/a.mjs', 'tests/c.mjs']);
  assert.equal(s.total, 4);
  assert.equal(s.leakers, 2);
  assert.equal(s.unlisted, 1);
  assert.deepEqual(s.stale, ['tests/c.mjs']);
  assert.match(s.lines[0], /left: 4 by 2 of 4 files \(1 not declared/);
  assert.match(s.lines[1], /^ {2}3\ttests\/a\.mjs\t/);
  assert.match(s.lines[2], /tests\/b\.mjs \(not declared: fails\) \(incomplete\)/);
  assert.match(s.lines.at(-1), /incomplete: tests\/b\.mjs \(ended before its result\), tests\/e\.mjs \(no record\)/);
});

test('the summary names every declared file that left nothing, however many', () => {
  const keys = Array.from({ length: 40 }, (_, i) => `tests/s${String(i).padStart(2, '0')}.mjs`);
  const files = new Map(keys.map((k) => [k, { count: 0, names: [], complete: true }]));
  const s = summarize({ files, missing: [] }, keys);
  assert.deepEqual(s.stale, keys);
  const line = s.lines.find((l) => l.includes('declared files left nothing'));
  assert.ok(line, s.lines.join('\n'));
  for (const k of keys) assert.ok(line.includes(k), `${k} named: ${line}`);
});

// ---- the runner --------------------------------------------------------------

test('the guard\'s preload goes first in every pass, after --test', () => {
  const passes = buildPasses({
    argv: PKG_ARGV, repoRoot: '/repo', discovered: ['tests/test-a.mjs', 'tests/test-b.mjs'], large: ['tests/test-b.mjs'],
    fsx: { kind: () => null, glob: () => [] }, tmpFile: () => '/tmp/x',
  });
  const guarded = withTmpGuard(passes, 'file:///g.mjs');
  assert.equal(guarded.length, 2);
  for (const [i, p] of guarded.entries()) {
    assert.deepEqual(p.args.slice(0, 2), ['--test', '--import=file:///g.mjs']);
    assert.deepEqual(p.args.slice(2), passes[i].args.slice(1));
  }
  assert.equal(TMP_GUARD_URL, pathToFileURL(path.join(REPO_ROOT, 'tests', '_tmp-guard.mjs')).href);
  assert.deepEqual(guardEnv('/run', { [GUARD_OWNER_VAR]: '/outer', KEEP: '1' }), { TEST_TMP_GUARD_DIR: '/run', KEEP: '1' });
});

test('a run whose passes passed fails when an undeclared file left entries, or the count is not whole', () => {
  const whole = { unlisted: 0, incomplete: [], unreadable: [], kept: [], missing: [], stale: [] };
  const quiet = () => {};
  const logged = [];
  assert.equal(guardedStatus(0, { summary: { ...whole, unlisted: 2 }, removed: true }, (m) => logged.push(m)), 1);
  assert.match(logged[0], /2 files not declared/);
  assert.equal(guardedStatus(0, { summary: whole, removed: true }, quiet), 0);
  assert.equal(guardedStatus(3, { summary: { ...whole, unlisted: 1 }, removed: true }, quiet), 3, 'a failed run keeps its status');
  // Each of these fails whatever the declaration says.
  assert.equal(guardedStatus(0, { summary: null, removed: true }, quiet), 1, 'a run directory that could not be read');
  assert.equal(guardedStatus(0, { summary: whole, removed: false }, quiet), 1, 'a run directory that could not be removed');
  assert.equal(guardedStatus(0, { summary: { ...whole, incomplete: ['tests/a.mjs'] }, removed: true, partial: true }, quiet), 1, 'a file that ended before its result');
  assert.equal(guardedStatus(0, { summary: { ...whole, unreadable: ['tests/a.mjs'] }, removed: true }, quiet), 1);
  assert.equal(guardedStatus(0, { summary: { ...whole, kept: ['tests/a.mjs'] }, removed: true }, quiet), 1);
  const missing = { summary: { ...whole, missing: ['tests/a.mjs'] }, removed: true };
  assert.deepEqual(guardFailures(missing), ['1 files ran with no record: tests/a.mjs']);
  assert.equal(guardedStatus(0, missing, quiet), 1, 'a file that ran with no record');
  assert.equal(guardedStatus(0, { ...missing, partial: true }, quiet), 0, 'reported only when Node leaves named files unrun');
});

test('a run is partial with Node\'s own shard or watch option, as an argument or in NODE_OPTIONS', () => {
  assert.equal(runsPartially(['--test-shard=1/2', 'tests/x.mjs']), true);
  assert.equal(runsPartially(['--test-shard', '1/2']), true);
  assert.equal(runsPartially([], '--test_shard=1/2'), true);
  assert.equal(runsPartially(['--watch']), true);
  assert.equal(runsPartially(['--no-watch'], '--watch'), false, 'the last of the two decides');
  assert.equal(runsPartially(['--test-timeout=5', 'tests/x.mjs']), false);
});

test('a declared file is named stale only from a whole record', () => {
  const entry = (over) => ({ count: 0, names: [], complete: true, late: 0, unreadable: false, kept: false, ...over });
  const files = new Map([
    ['tests/a.mjs', entry({})],
    ['tests/b.mjs', entry({ complete: false })],
    ['tests/c.mjs', entry({ kept: true })],
    ['tests/d.mjs', entry({ unreadable: true })],
  ]);
  const s = summarize({ files, missing: ['tests/e.mjs'] }, ['tests/a.mjs', 'tests/b.mjs', 'tests/c.mjs', 'tests/d.mjs', 'tests/e.mjs']);
  assert.deepEqual(s.stale, ['tests/a.mjs']);
});

test('--test-isolation=none is refused, as an argument, spelled apart, or in NODE_OPTIONS', () => {
  assert.throws(() => refuseUnguarded(['--test-isolation=none']), /leak guard/);
  assert.throws(() => refuseUnguarded(['--test-isolation', 'none', 'tests/x.mjs']), /leak guard/);
  assert.throws(() => refuseUnguarded([], '--experimental-test-isolation=none'), /leak guard/);
  assert.throws(() => refuseUnguarded([], '--test_isolation=none'), /leak guard/);
  assert.doesNotThrow(() => refuseUnguarded(['--test-isolation=process']));
  assert.doesNotThrow(() => refuseUnguarded(['--test-isolation=process'], '--test-isolation=none'), 'the argument, read after NODE_OPTIONS, decides');
});

/** A fixture repository whose npm test runs this runner with the real preloads. */
function chainFixture(t, files, leaks = []) {
  const root = fs.realpathSync(tmpDir(t, 'tg-chain-'));
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(tmp);
  fs.mkdirSync(path.join(root, 'tests'));
  fs.mkdirSync(path.join(root, 'scripts', 'data'), { recursive: true });
  const preloads = PKG_ARGV.filter((a) => a.startsWith('--import=')).map((a) => `--import=${pathToFileURL(path.resolve(REPO_ROOT, a.slice('--import='.length))).href}`);
  assert.equal(preloads.length, 2, PKG_ARGV.join(' '));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: 'fixture', private: true, type: 'module',
    scripts: { test: `node ${JSON.stringify(RUNNER)} --test-timeout=60000 ${preloads.join(' ')}` },
  }));
  fs.writeFileSync(path.join(root, 'scripts', 'data', 'test-tiers.json'), JSON.stringify({ schema: 1, large: [] }));
  fs.writeFileSync(path.join(root, LEAKS_FILE), JSON.stringify({ schema: 1, leaks }));
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(root, 'tests', name), text);
  const npmTest = (args = []) => spawnSync('npm', ['test', ...(args.length > 0 ? ['--', ...args] : [])], {
    cwd: root, encoding: 'utf8', timeout: 120_000,
    env: { ...cleanEnv(), [GUARD_OWNER_VAR]: '/an-enclosing-guarded-file', TMPDIR: tmp, TG_REPORT: path.join(root, 'report.jsonl'), AGENTIC_ENGINEER_ROOT: '/x' },
  });
  return { root, tmp, npmTest };
}

test('npm test with the real preloads fails an undeclared leaker, prints the summary, and leaves no run directory', (t) => {
  const { tmp, npmTest } = chainFixture(t, { 'test-leak.mjs': FILES['test-leak.mjs'], 'test-clean.mjs': FILES['test-clean.mjs'] });
  const r = npmTest();
  assert.notEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout + r.stderr, /tests\/test-leak\.mjs left 1 entries/);
  assert.match(r.stderr, /run-tests: temporary entries left: 1 by 1 of 2 files \(1 not declared in scripts\/data\/test-tmp-leaks\.json\)/);
  assert.match(r.stderr, / {2}1\ttests\/test-leak\.mjs \(not declared: fails\)\tleft-/);
  assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.startsWith('tg-')), [], 'the run directory is removed');
});

test('npm test passes a declared leaker and names a declared clean file stale', (t) => {
  const { npmTest } = chainFixture(t, { 'test-leak.mjs': FILES['test-leak.mjs'], 'test-clean.mjs': FILES['test-clean.mjs'] }, ['tests/test-clean.mjs', 'tests/test-leak.mjs']);
  const r = npmTest();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stderr, /left: 1 by 1 of 2 files \(0 not declared/);
  assert.match(r.stderr, /1 declared files left nothing \(remove them from scripts\/data\/test-tmp-leaks\.json\): tests\/test-clean\.mjs/);
});

test('npm test charges a killed file what its directory holds, marks the count incomplete, and removes it all', (t) => {
  const { tmp, npmTest } = chainFixture(t, {
    'test-killed.mjs': body([
      "test('killed', () => {",
      "  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'left-'));",
      "  fs.mkdirSync(path.join(d, 'ro'));",
      "  fs.writeFileSync(path.join(d, 'ro', 'f'), 'x');",
      "  fs.chmodSync(path.join(d, 'ro'), 0o000);",
      "  process.kill(process.pid, 'SIGKILL');",
      '});',
    ]),
    'test-clean.mjs': FILES['test-clean.mjs'],
  });
  const r = npmTest();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, / {2}1\ttests\/test-killed\.mjs \(not declared: fails\) \(incomplete\)\tleft-/);
  assert.match(r.stderr, /the count is incomplete: tests\/test-killed\.mjs \(ended before its result\)/);
  assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.startsWith('tg-')), [], 'removed, the read-only tree the killed file left included');
});

test('npm test fails an undeclared file whose entry was made after the guard\'s count', (t) => {
  const { tmp, npmTest } = chainFixture(t, { 'test-late.mjs': LATE });
  const r = npmTest();
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, / {2}1\ttests\/test-late\.mjs \(not declared: fails\) \(1 made after its count\)\tlate-entry/);
  assert.match(r.stderr, /run-tests: 1 files not declared in scripts\/data\/test-tmp-leaks\.json left temporary entries/);
  assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.startsWith('tg-')), [], 'the run directory is removed');
});

test('npm test fails an undeclared leaker whose own exit listener reset its exit code', (t) => {
  const { npmTest } = chainFixture(t, {
    'test-reset.mjs': body([
      "import { after } from 'node:test';",
      "after(() => process.on('exit', () => { process.exitCode = 0; }));",
      "test('leaks', () => { fs.mkdtempSync(path.join(os.tmpdir(), 'left-')); });",
    ]),
  });
  const r = npmTest();
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /run-tests: 1 files not declared in scripts\/data\/test-tmp-leaks\.json left temporary entries/);
});

// A file that removes its own owner record: it ran, and the run holds no
// record of it.
const NO_RECORD = body(["test('drops its owner record', () => { fs.rmSync(process.env.TMPDIR + '.owner.json'); });"]);

test('npm test fails a run in which a file left no record, and only reports it under Node\'s own shard option', (t) => {
  const { tmp, npmTest } = chainFixture(t, { 'test-norecord.mjs': NO_RECORD, 'test-clean.mjs': FILES['test-clean.mjs'] });
  const r = npmTest();
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /the count is incomplete: tests\/test-norecord\.mjs \(no record\)/);
  assert.match(r.stderr, /✗ run-tests: 1 files ran with no record: tests\/test-norecord\.mjs/);
  const shard = npmTest(['--test-shard=1/1']);
  assert.equal(shard.status, 0, shard.stdout + shard.stderr);
  assert.match(shard.stderr, /the count is incomplete: tests\/test-norecord\.mjs \(no record\)/, 'still reported');
  assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.startsWith('tg-')), [], 'the run directory is removed');
});
