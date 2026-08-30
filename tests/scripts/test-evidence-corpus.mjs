// Tests for the frozen measurement corpus (scripts/evidence-corpus.mjs).
//
// Every drift assertion below is written so that removing the code it covers
// makes it fail. The two "no drift" style assertions are the dangerous kind —
// a check that reports nothing wrong passes just as well when it inspected
// nothing — so each one is paired with a mutated input that must produce a
// finding, and the empty-tree case exercises the guard that exists precisely
// because a silent zero would otherwise read as agreement.

import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  MANIFEST_PATH,
  MANIFEST_SCHEMA,
  PROFILES,
  buildManifest,
  commitAvailable,
  main,
  manifestDigest,
  validateManifestShape,
  verifyManifest,
} from '../../scripts/evidence-corpus.mjs';
import { EVIDENCE_DOCS, isShaCorpusFile } from '../../scripts/check-doc-evidence.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const manifest = () => JSON.parse(readFileSync(resolve(REPO_ROOT, MANIFEST_PATH), 'utf8'));
const clone = (o) => JSON.parse(JSON.stringify(o));

/**
 * A manifest mutated to stand in for TREE drift, kept self-consistent.
 *
 * `verifyManifest` validates shape before comparing, and the shape gate now
 * includes the self-digest (contract §2.1), so editing a manifest in place also
 * invalidates its digest and the run stops with a digest finding before any
 * comparison happens. That ordering is correct — an inconsistent manifest is not
 * a trustworthy baseline — but it means a test that edits the manifest to
 * simulate the TREE moving must re-derive the digest, or it tests tampering
 * instead of drift. These two situations are genuinely different and the suite
 * covers both: `drifted()` for tree drift, the shape block for tampering.
 */
const drifted = (mutate) => {
  const m = clone(manifest());
  mutate(m);
  delete m.digest;
  return { ...m, digest: manifestDigest(m) };
};

function gitHistoryUsable() {
  try {
    return execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', '--is-shallow-repository'], { encoding: 'utf8' }).trim() !== 'true';
  } catch { return false; }
}

test('the committed manifest declares the expected schema and both profiles', () => {
  const m = manifest();
  assert.equal(m.schema, MANIFEST_SCHEMA);
  assert.deepEqual(Object.keys(m.profiles).sort(), Object.keys(PROFILES).sort());
  assert.match(m.commit, /^[0-9a-f]{40}$/);
  // Non-vacuity: a manifest that pinned nothing would satisfy every drift
  // assertion below, so the counts are asserted before they are relied on.
  for (const [id, p] of Object.entries(m.profiles)) {
    assert.ok(p.files.length > 0, `profile ${id} pins no files`);
    for (const f of p.files) {
      assert.match(f.blob, /^[0-9a-f]{40}$/, `${id}/${f.path} has no blob digest`);
      assert.ok(Number.isInteger(f.bytes) && f.bytes >= 0, `${id}/${f.path} has no byte count`);
    }
  }
});

test('verify reports no drift against the commit the manifest pins', { skip: !gitHistoryUsable() && 'shallow clone' }, () => {
  const result = verifyManifest(REPO_ROOT, manifest());
  assert.equal(result.ran, true, result.reason ?? '');
  assert.deepEqual(result.findings, [], 'the committed manifest should match its own pin');
});

test('a changed blob digest is reported as content drift', { skip: !gitHistoryUsable() && 'shallow clone' }, () => {
  let original;
  const m = drifted((x) => { const t = x.profiles['stage-docs'].files[0]; original = t.blob; t.blob = 'f'.repeat(40); });
  const target = m.profiles['stage-docs'].files[0];
  const result = verifyManifest(REPO_ROOT, m);
  assert.equal(result.ran, true);
  const hit = result.findings.find((f) => f.kind === 'content' && f.path === target.path);
  assert.ok(hit, `expected content drift for ${target.path}, got ${JSON.stringify(result.findings)}`);
  assert.match(hit.detail, new RegExp(original.slice(0, 12)), 'the finding should name the tree digest');
});

test('a changed byte count is reported even when the digest is untouched', { skip: !gitHistoryUsable() && 'shallow clone' }, () => {
  const m = drifted((x) => { x.profiles['stage-docs'].files[0].bytes += 1; });
  const target = m.profiles['stage-docs'].files[0];
  const result = verifyManifest(REPO_ROOT, m);
  assert.ok(
    result.findings.some((f) => f.kind === 'content' && f.path === target.path),
    'a byte-count-only change must still be drift',
  );
});

test('a file dropped from the manifest is reported as membership drift', { skip: !gitHistoryUsable() && 'shallow clone' }, () => {
  let dropped;
  const m = drifted((x) => { dropped = x.profiles['discovered-md'].files.pop(); });
  const result = verifyManifest(REPO_ROOT, m);
  const hit = result.findings.find((f) => f.kind === 'membership' && f.path === dropped.path);
  assert.ok(hit, 'dropping a file from the manifest must be membership drift');
  assert.match(hit.detail, /not in the manifest/);
});

test('a file invented in the manifest is reported as membership drift', { skip: !gitHistoryUsable() && 'shallow clone' }, () => {
  const m = drifted((x) => { x.profiles['discovered-md'].files.push({ path: 'docs/this-file-does-not-exist.md', blob: 'a'.repeat(40), bytes: 1 }); });
  const result = verifyManifest(REPO_ROOT, m);
  const hit = result.findings.find((f) => f.kind === 'membership' && f.path === 'docs/this-file-does-not-exist.md');
  assert.ok(hit, 'a manifest entry with no counterpart in the tree must be membership drift');
  assert.match(hit.detail, /not in the corpus/);
});

test('an unreadable pin fails closed rather than reporting no drift', () => {
  const m = drifted((x) => { x.commit = '0'.repeat(40); });
  const result = verifyManifest(REPO_ROOT, m);
  assert.equal(result.ran, false, 'an unresolvable pin must not report a clean run');
  assert.match(result.reason, /not readable/);
  // The distinction that matters: `ran: false` is not `findings: []`. A caller
  // that only looked at findings would read this as success.
  assert.deepEqual(result.findings, []);
});

test('commitAvailable rejects a commit that does not exist', () => {
  assert.equal(commitAvailable(REPO_ROOT, '0'.repeat(40)).ok, false);
  assert.equal(commitAvailable(REPO_ROOT, 'HEAD').ok, true);
});

test('an empty tree throws instead of pinning an empty corpus', () => {
  // This is the guard's whole reason for existing. Without it a tree listing
  // that parsed to nothing would produce a manifest with an empty discovered
  // profile, every later comparison would run against no files, and the run
  // would agree perfectly with any oracle.
  const dir = mkdtempSync(join(tmpdir(), 'evidence-corpus-'));
  try {
    const g = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 'test@example.invalid');
    g('config', 'user.name', 'test');
    // A contributor with global commit signing on has no key for this address,
    // so the commit below would throw an opaque execFileSync error. Four sibling
    // test files in this repo already set this for the same reason.
    g('config', 'commit.gpgsign', 'false');
    g('commit', '-q', '--allow-empty', '-m', 'empty');
    assert.throws(() => buildManifest(dir, 'HEAD'), /no blob entries parsed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an enumerated path missing from the tree throws rather than pinning a short profile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-corpus-'));
  try {
    const g = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 'test@example.invalid');
    g('config', 'user.name', 'test');
    // A contributor with global commit signing on has no key for this address,
    // so the commit below would throw an opaque execFileSync error. Four sibling
    // test files in this repo already set this for the same reason.
    g('config', 'commit.gpgsign', 'false');
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'unrelated.md'), '# unrelated\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'one file');
    // The tree is non-empty, so the entries guard passes; the enumerated
    // profile's absence check is what must fire.
    assert.throws(() => buildManifest(dir, 'HEAD'), /enumerated path\(s\) absent/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the enumerated profile is a subset of the discovered rule, which is why one guard is dormant', () => {
  // Pinned deliberately. `buildManifest` also guards against a profile that
  // selects zero files, but that guard cannot fire for `discovered-md` while
  // this subset relation holds: if the three enumerated documents are present,
  // the discovered profile has at least those three. The guard is live defence
  // only for a future profile that does not overlap the enumerated one.
  //
  // If this assertion ever fails, that reasoning has to be re-read — not the
  // assertion relaxed.
  for (const doc of EVIDENCE_DOCS) {
    assert.ok(isShaCorpusFile(doc), `${doc} is enumerated but outside the discovered rule`);
  }
});

// --- shape validation ------------------------------------------------------
//
// Five of these were accepted as "no drift" before the shape gate existed; the
// other four were already caught by the content comparison and are kept as
// belt-and-braces. An earlier version of this comment claimed all nine had a
// known-failing ancestor, which measurement disproved: reconstructing the
// pre-gate `verifyManifest` showed the symbolic-ref, unknown-profile,
// short-blob and non-integer-bytes cases already produced findings, the last
// two structurally and independent of what HEAD points at (cross-host review
// finding). Keeping them is cheap; claiming they closed a hole was wrong.

const SHAPE_MUTATIONS = [
  ['a symbolic ref is not a pin', (m) => { m.commit = 'HEAD'; }, /not a full 40-character object name/],
  ['an abbreviated commit is not a pin', (m) => { m.commit = m.commit.slice(0, 7); }, /not a full 40-character object name/],
  ['a wrong schema is rejected', (m) => { m.schema = 'nonsense'; }, /schema is/],
  ['a missing schema is rejected', (m) => { delete m.schema; }, /schema is/],
  ['a duplicated path is rejected', (m) => { m.profiles['stage-docs'].files.push({ ...m.profiles['stage-docs'].files[0] }); }, /more than once/],
  ['an unknown profile is rejected', (m) => { m.profiles.bogus = { membership: 'x', rule: 'y', files: [] }; }, /expected exactly/],
  ['a tampered rule is rejected', (m) => { m.profiles['discovered-md'].rule = 'anything'; }, /no longer matches/],
  ['a short blob digest is rejected', (m) => { m.profiles['stage-docs'].files[0].blob = 'abc'; }, /not a full object name/],
  ['a non-integer byte count is rejected', (m) => { m.profiles['stage-docs'].files[0].bytes = '12'; }, /non-negative integer/],
];

for (const [label, mutate, pattern] of SHAPE_MUTATIONS) {
  test(`shape validation: ${label}`, () => {
    const m = clone(manifest());
    mutate(m);
    const findings = validateManifestShape(m);
    assert.ok(findings.length > 0, `${label}: validateManifestShape accepted it`);
    assert.ok(
      findings.some((f) => pattern.test(f.detail)),
      `${label}: no finding matched ${pattern}; got ${JSON.stringify(findings)}`,
    );
  });
}

test('the committed manifest passes shape validation unchanged', () => {
  // The control for the block above. Without it every mutation test would
  // still pass against a validator that rejected everything.
  assert.deepEqual(validateManifestShape(manifest()), []);
});

test('verify refuses a structurally invalid manifest before touching git', () => {
  // Deliberately NOT re-digested: this is the tampering case, and the shape
  // gate must stop it before any comparison.
  const m = clone(manifest());
  m.commit = 'HEAD';
  const result = verifyManifest(REPO_ROOT, m);
  assert.equal(result.ran, true);
  assert.ok(result.findings.some((f) => f.kind === 'manifest'), 'shape findings must surface through verify');
});

test('a tree of only the enumerated documents pins both profiles cleanly', () => {
  // Named for what it actually asserts. An earlier name claimed this covered
  // the PARTIAL-parse guard; it does not. That guard rejects a listing where
  // some rows fail to match while others succeed, and no tree git can be made
  // to emit will trigger it — the only way in is to break the pattern itself.
  // It was instead verified by injecting a single forced parse failure into
  // `treeEntries`, which produced
  // "1 of 790 tree row(s) ... did not parse; refusing to pin a partial corpus"
  // and refused the pin. That injection is recorded here rather than left as
  // an assertion, because a test that cannot reach a branch must say so.
  //
  // What this case covers: a tree of ordinary blobs pins both profiles, AND
  // the `type !== 'blob'` skip, which is now genuinely exercised.
  //
  // The previous revision corrected the comment here to admit the gitlink
  // branch was unreachable, and left the SAME false claim standing at its
  // twin below the setup — so the fix covered one of two copies and the
  // uncovered branch kept its coverage claim. Rather than delete the second
  // comment too, this creates a real gitlink so the claim becomes true.
  const dir = mkdtempSync(join(tmpdir(), 'evidence-corpus-'));
  try {
    const g = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 'test@example.invalid');
    g('config', 'user.name', 'test');
    // A contributor with global commit signing on has no key for this address,
    // so the commit below would throw an opaque execFileSync error. Four sibling
    // test files in this repo already set this for the same reason.
    g('config', 'commit.gpgsign', 'false');
    g('config', 'core.quotePath', 'true');
    mkdirSync(join(dir, 'docs'), { recursive: true });
    for (const doc of EVIDENCE_DOCS) {
      mkdirSync(join(dir, doc.split('/').slice(0, -1).join('/')), { recursive: true });
      writeFileSync(join(dir, doc), '# stub\n');
    }
    g('add', '-A');
    // A submodule-style gitlink has objecttype `commit`, not `blob`, and is
    // skipped by design rather than by parse failure — so a tree carrying one
    // must still pin cleanly. This pins the distinction between "skipped
    // because it is not a blob" and "skipped because it did not parse".
    //
    // Created via `update-index --cacheinfo` rather than a real submodule so
    // the case needs no second repository and no network. The path is given a
    // `.md` suffix deliberately: `isShaCorpusFile` would admit it on name
    // alone, so if the non-blob skip regressed, the gitlink would land in
    // `discovered-md` and the assertion below would catch it.
    g('update-index', '--add', '--cacheinfo', `160000,${'0'.repeat(39)}1,docs/vendored-notes.md`);
    g('commit', '-q', '-m', 'stubs');
    const rows = execFileSync('git', ['-C', dir, 'ls-tree', '-r', 'HEAD'], { encoding: 'utf8' });
    assert.match(rows, /^160000 commit /m, 'setup must actually produce a gitlink row');

    const built = buildManifest(dir, 'HEAD');
    assert.equal(built.profiles['stage-docs'].files.length, EVIDENCE_DOCS.length);
    assert.ok(built.profiles['discovered-md'].files.length >= EVIDENCE_DOCS.length);
    const discovered = built.profiles['discovered-md'].files.map((f) => f.path);
    assert.ok(
      !discovered.includes('docs/vendored-notes.md'),
      `a gitlink is not a blob and must not be pinned; got ${JSON.stringify(discovered)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the digest, and the path-quoting fail-open -----------------------------

test('the manifest carries a self-consistent digest', () => {
  const m = manifest();
  assert.match(m.digest, /^[0-9a-f]{64}$/);
  assert.equal(m.digest, manifestDigest(m), 'the committed digest must match its own manifest');
});

test('manifestDigest ignores the digest field and key order but not content', () => {
  const m = manifest();
  const reordered = JSON.parse(JSON.stringify({ profiles: m.profiles, commit: m.commit, schema: m.schema, generated_by: m.generated_by }));
  assert.equal(manifestDigest(reordered), manifestDigest(m), 'key order must not change the digest');
  const changed = clone(m);
  changed.profiles['stage-docs'].files[0].bytes += 1;
  assert.notEqual(manifestDigest(changed), m.digest, 'a content change must change the digest');
});

test('manifestDigest normalises NESTED key order, not just the top level', () => {
  // The previous revision permuted only the four top-level keys, so the
  // recursive descent was never exercised: a digest that sorted the top level
  // and left every nested object in insertion order would have passed it.
  const m = manifest();
  const deep = clone(m);
  deep.profiles = Object.fromEntries(
    Object.entries(deep.profiles).reverse().map(([id, p]) => [
      id,
      // Rebuild each profile and each file record with their keys inserted in
      // reverse order. JSON.parse/stringify preserves insertion order for
      // non-integer-like keys, so this really does reach the digest reversed.
      { files: p.files.map((f) => ({ bytes: f.bytes, blob: f.blob, path: f.path })), rule: p.rule, membership: p.membership },
    ]),
  );
  assert.notEqual(
    JSON.stringify(deep.profiles), JSON.stringify(m.profiles),
    'the fixture must actually differ in key order, or this proves nothing',
  );
  assert.equal(manifestDigest(deep), manifestDigest(m), 'nested key order must not change the digest');
});

test('manifestDigest orders integer-like keys LEXICOGRAPHICALLY, as §2.1 requires', () => {
  // The order §2.1 fixes is lexicographic, so "10" sorts before "2". A JS
  // object cannot hold that order: integer-like keys always enumerate first
  // and numerically, whichever way they were inserted. A digest built by
  // rebuilding a sorted object therefore emitted "2" before "10" — no key in
  // the real manifest is integer-like, so it changed no digest this tool ever
  // produced, which is exactly why it needed a test rather than a bug report.
  //
  // Pinned against a literal expected string rather than a self-comparison:
  // comparing two manifestDigest calls would agree with itself under either
  // ordering and prove nothing.
  const numeric = { schema: 'x', profiles: { 10: 'a', 2: 'b' } };
  const expected = createHash('sha256')
    .update(`${JSON.stringify({ profiles: { 10: 'a', 2: 'b' }, schema: 'x' }, ['10', '2', 'profiles', 'schema'], 2)}\n`, 'utf8')
    .digest('hex');
  assert.equal(manifestDigest(numeric), expected);

  // And state the property directly, so the expectation above cannot drift
  // into agreeing with a numerically-ordered implementation.
  const serialised = JSON.stringify({ profiles: { 10: 'a', 2: 'b' }, schema: 'x' }, ['10', '2', 'profiles', 'schema'], 2);
  assert.ok(
    serialised.indexOf('"10"') < serialised.indexOf('"2"'),
    `lexicographic order puts "10" before "2"; got ${serialised}`,
  );
});

for (const [label, mutate, pattern] of [
  ['a missing digest is rejected', (m) => { delete m.digest; }, /digest is missing/],
  ['a malformed digest is rejected', (m) => { m.digest = 'nope'; }, /digest is missing/],
  ['a digest that does not match its manifest is rejected', (m) => { m.digest = 'a'.repeat(64); }, /does not match/],
  ['a profile pinning zero files is rejected on the read path', (m) => { m.profiles['stage-docs'].files = []; }, /pins no files/],
]) {
  test(`shape validation: ${label}`, () => {
    const m = clone(manifest());
    mutate(m);
    const findings = validateManifestShape(m);
    assert.ok(findings.some((f) => pattern.test(f.detail)), `${label}: got ${JSON.stringify(findings)}`);
  });
}

// Every path shape git is willing to C-quote, not just the one that was
// measured first. Under `--format` with `-z`, `core.quotePath=false` unquotes
// ONLY the non-ASCII class — the other four stayed fail-open while a comment
// claimed all of them were handled — so the previous single-case test could
// not have caught the regression it was written to prevent.
const HOSTILE_PATHS = Object.freeze({
  'non-ASCII': 'docs/한글-노트.md',
  backslash: 'docs/back\\slash.md',
  'double quote': 'docs/quote".md',
  tab: 'docs/tab\there.md',
  newline: 'docs/new\nline.md',
});

test('every path shape git would C-quote still reaches the discovered profile', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-corpus-'));
  try {
    const g = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 'test@example.invalid');
    g('config', 'user.name', 'test');
    g('config', 'commit.gpgsign', 'false');
    // Force the hostile setting on, so the test fails if the fix is reverted.
    g('config', 'core.quotePath', 'true');
    mkdirSync(join(dir, 'docs'), { recursive: true });
    for (const doc of EVIDENCE_DOCS) {
      mkdirSync(join(dir, doc.split('/').slice(0, -1).join('/')), { recursive: true });
      writeFileSync(join(dir, doc), '# stub\n');
    }
    for (const path of Object.values(HOSTILE_PATHS)) writeFileSync(join(dir, path), '# note\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'hostile paths');

    // Control: the setup must actually produce paths this git WOULD quote,
    // otherwise the assertions below hold vacuously on a git that never quotes.
    const quoted = execFileSync(
      'git',
      ['-C', dir, 'ls-tree', '-r', '-z', '--format=%(objectmode) %(objectname) %(path)', 'HEAD'],
      { encoding: 'utf8' },
    ).split('\0').filter((l) => l.includes('"'));
    assert.equal(
      quoted.length, Object.keys(HOSTILE_PATHS).length,
      `setup must produce ${Object.keys(HOSTILE_PATHS).length} quotable paths under --format, or this test proves nothing; got ${quoted.length}`,
    );

    const built = buildManifest(dir, 'HEAD');
    const paths = built.profiles['discovered-md'].files.map((f) => f.path);
    for (const [label, path] of Object.entries(HOSTILE_PATHS)) {
      assert.ok(
        paths.includes(path),
        `the ${label} path must be pinned verbatim; got ${JSON.stringify(paths)}`,
      );
    }
    for (const p of paths) {
      assert.ok(!p.startsWith('"'), `no path may arrive C-quoted: ${JSON.stringify(p)}`);
      assert.ok(!p.includes('\\3'), `no path may arrive octal-escaped: ${JSON.stringify(p)}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the CLI routes, exercised through main() ------------------------------
//
// The shape checks above call `validateManifestShape` directly, which is the
// right unit for the predicate and the wrong one for the question "does the
// command that renders a manifest refuse a meaningless one?". A round-2
// finding — `show` rendered a zero-file manifest as valid and exited 0 — was
// repaired in the command and pinned only at the predicate, so the route
// itself stayed untested. These go through `main`.

/** Run main() with its console output captured, so the suite stays readable. */
function runMain(argv, repoRoot) {
  const out = [];
  const { log, error } = console;
  console.log = (...a) => out.push(a.join(' '));
  console.error = (...a) => out.push(a.join(' '));
  try {
    return { code: main(argv, repoRoot), output: out.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
  }
}

test('show refuses a manifest pinning zero files, through the CLI route', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-corpus-cli-'));
  try {
    const broken = clone(manifest());
    broken.profiles['stage-docs'].files = [];
    broken.digest = manifestDigest(broken);
    const path = join(dir, 'manifest.json');
    writeFileSync(path, `${JSON.stringify(broken, null, 2)}\n`);

    // Control: the same manifest with its files intact must render, so a
    // failure below is the zero-file rule and not a broken fixture or route.
    const okPath = join(dir, 'ok.json');
    writeFileSync(okPath, `${JSON.stringify(manifest(), null, 2)}\n`);
    const good = runMain(['show', '--manifest', okPath], dir);
    assert.equal(good.code, 0, `control manifest must render; got ${good.output}`);

    const bad = runMain(['show', '--manifest', path], dir);
    assert.equal(bad.code, 1, `show must reject a zero-file profile; got ${bad.output}`);
    assert.match(bad.output, /pins no files/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pin refuses to overwrite an existing pin without --rebaseline', () => {
  // The corpus is a fixed historical freeze: the exporter, the oracle and
  // their comparison are authored days apart and must measure one corpus, and
  // re-pinning after the normative contract lands would pull that document
  // into the corpus it describes. So overwriting is an owner decision and has
  // to be spelled at the command line.
  const dir = mkdtempSync(join(tmpdir(), 'evidence-corpus-pin-'));
  try {
    const out = join(dir, 'pinned.json');
    const commit = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    // A DIFFERENT commit for the second attempt. Re-pinning the same commit
    // could not distinguish "refused" from "overwrote with identical bytes",
    // so a write-before-refusal defect would pass (cross-host review finding).
    const other = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD~1'], { encoding: 'utf8' }).trim();
    assert.notEqual(commit, other, 'the two commits must differ, or this proves nothing');

    const first = runMain(['pin', '--commit', commit, '--out', out], REPO_ROOT);
    assert.equal(first.code, 0, `the first pin must succeed; got ${first.output}`);
    const frozen = readFileSync(out, 'utf8');
    assert.match(frozen, new RegExp(commit), 'the first pin must record its own commit');

    const second = runMain(['pin', '--commit', other, '--out', out], REPO_ROOT);
    assert.equal(second.code, 1, `a bare re-pin must be refused; got ${second.output}`);
    assert.match(second.output, /already pins a corpus/);
    assert.equal(readFileSync(out, 'utf8'), frozen, 'a refused re-pin must leave the pinned bytes untouched');

    const forced = runMain(['pin', '--commit', other, '--out', out, '--rebaseline'], REPO_ROOT);
    assert.equal(forced.code, 0, `an explicit rebaseline must succeed; got ${forced.output}`);
    assert.notEqual(readFileSync(out, 'utf8'), frozen, 'an explicit rebaseline must actually replace the pin');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- byte safety -----------------------------------------------------------
//
// Unquoting is not byte safety. A git path is a byte string; decoding the tree
// listing as UTF-8 with the default lossy replacement records a path that is
// not the one in the tree, and both the shape gate and `verify` then agree
// about that fiction because the re-read repeats the same lossy decode.
// Cross-host review finding, reproduced in both shapes below.

/** A repo whose tree carries `paths` verbatim, bypassing the filesystem. */
function repoWithRawPaths(paths) {
  const dir = mkdtempSync(join(tmpdir(), 'evidence-corpus-bytes-'));
  const g = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 'test@example.invalid');
  g('config', 'user.name', 'test');
  g('config', 'commit.gpgsign', 'false');
  for (const doc of EVIDENCE_DOCS) {
    mkdirSync(join(dir, doc.split('/').slice(0, -1).join('/')), { recursive: true });
    writeFileSync(join(dir, doc), '# stub\n');
  }
  g('add', '-A');
  const blob = execFileSync('git', ['-C', dir, 'hash-object', '-w', '--stdin'], { input: 'x', encoding: 'utf8' }).trim();
  for (const raw of paths) {
    // `update-index --index-info` takes the path as raw bytes, so the working
    // tree never has to accept a name the filesystem would reject.
    execFileSync('git', ['-C', dir, 'update-index', '--add', '--index-info'], {
      input: Buffer.concat([Buffer.from(`100644 ${blob}\t`), raw, Buffer.from([0])]),
    });
  }
  g('commit', '-q', '-m', 'raw paths');
  return dir;
}

test('a tree path that is not valid UTF-8 is refused, not silently replaced', () => {
  const dir = repoWithRawPaths([Buffer.concat([Buffer.from('docs/bad-'), Buffer.from([0xfe]), Buffer.from('.md')])]);
  try {
    // Control first: without the invalid byte the same construction pins fine,
    // so the refusal below is the byte rule and not the fixture.
    const ok = repoWithRawPaths([Buffer.from('docs/fine-name.md')]);
    try {
      const built = buildManifest(ok, 'HEAD');
      assert.ok(built.profiles['discovered-md'].files.some((f) => f.path === 'docs/fine-name.md'));
    } finally {
      rmSync(ok, { recursive: true, force: true });
    }

    assert.throws(() => buildManifest(dir, 'HEAD'), /not valid UTF-8/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two paths differing only in an invalid byte do not collapse onto one entry', () => {
  // Left lossy, these two become the same string and the profile silently
  // pins one path twice — membership drift that no later comparison can see
  // because both lanes make the same substitution.
  const dir = repoWithRawPaths([
    Buffer.concat([Buffer.from('docs/bad-'), Buffer.from([0xfe]), Buffer.from('.md')]),
    Buffer.concat([Buffer.from('docs/bad-'), Buffer.from([0xff]), Buffer.from('.md')]),
  ]);
  try {
    assert.throws(() => buildManifest(dir, 'HEAD'), /not valid UTF-8/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('manifestDigest is sensitive to the ORDER of a files array', () => {
  // The replacer sorts object keys; array element order must survive it. A
  // canonicaliser that also sorted arrays would make two different corpora
  // digest identically.
  const m = manifest();
  const swapped = clone(m);
  const files = swapped.profiles['discovered-md'].files;
  [files[0], files[1]] = [files[1], files[0]];
  assert.notEqual(manifestDigest(swapped), manifestDigest(m), 'array order must reach the digest');
});

test('a manifest pin cannot produce a shape-invalid manifest, which is why one guard is dormant', () => {
  // Pinned deliberately, in the same spirit as the subset-relation case above.
  // `pin` validates the manifest it is about to write, but that guard cannot
  // fire while the builder throws first on every way of reaching it:
  //   - an enumerated profile missing its documents throws on the absent
  //     paths, and a discovered profile selecting nothing throws on the empty
  //     tree — so neither can reach the shape check as a zero-file profile;
  //   - a duplicate path was only reachable through the lossy UTF-8 decode,
  //     which now refuses;
  //   - every other field is constructed, never parsed.
  //
  // If either assertion below ever fails, that reasoning has to be re-read —
  // and the dormant guard in `pin` becomes live coverage rather than defence.
  const dir = mkdtempSync(join(tmpdir(), 'evidence-corpus-dormant-'));
  try {
    const g = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 'test@example.invalid');
    g('config', 'user.name', 'test');
    g('config', 'commit.gpgsign', 'false');
    // A tree with markdown, but none of the three enumerated stage documents:
    // `discovered-md` is non-empty while `stage-docs` selects nothing.
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'unrelated.md'), '# note\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'no stage docs');
    assert.throws(
      () => buildManifest(dir, 'HEAD'),
      /enumerated path\(s\) absent/,
      'an enumerated profile with no documents must throw in the builder, before any shape check sees it',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  // And the manifest the real repository produces is shape-clean, so the guard
  // has nothing to report on the live path either.
  assert.deepEqual(validateManifestShape(buildManifest(REPO_ROOT, 'HEAD')), []);
});
