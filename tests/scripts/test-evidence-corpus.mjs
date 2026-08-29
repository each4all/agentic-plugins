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
  // What this case does cover: a tree of ordinary blobs pins both profiles.
  // It does NOT cover the `type !== 'blob'` skip — an earlier comment claimed
  // it did via a submodule-style gitlink, but the tree built here contains only
  // trees and blobs, and the pinned repository has no gitlink either, so that
  // branch is unreachable in this suite (cross-host review finding).
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
    // A submodule-style gitlink has objecttype `commit`, not `blob`, and is
    // skipped by design rather than by parse failure — so a tree carrying one
    // must still pin cleanly. This pins the distinction between "skipped
    // because it is not a blob" and "skipped because it did not parse".
    g('add', '-A');
    g('commit', '-q', '-m', 'stubs');
    const built = buildManifest(dir, 'HEAD');
    assert.equal(built.profiles['stage-docs'].files.length, EVIDENCE_DOCS.length);
    assert.ok(built.profiles['discovered-md'].files.length >= EVIDENCE_DOCS.length);
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

test('a path git would C-quote still reaches the discovered profile', () => {
  // The fail-open the cross-host review found. `ls-tree --format=%(path)`
  // C-quotes and octal-escapes a non-ASCII path EVEN UNDER `-z`, so without
  // `core.quotePath=false` the file arrives as a quoted literal, stops ending
  // in `.md`, silently leaves the profile, and `verify` still says "no drift".
  // An earlier version of this suite set `core.quotePath true` on the temp repo
  // but never created a path the setting affects, so it proved nothing.
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
    const NON_ASCII = 'docs/한글-노트.md';
    writeFileSync(join(dir, NON_ASCII), '# note\n');
    g('add', '-A');
    g('commit', '-q', '-m', 'non-ascii path');

    const built = buildManifest(dir, 'HEAD');
    const paths = built.profiles['discovered-md'].files.map((f) => f.path);
    assert.ok(
      paths.includes(NON_ASCII),
      `the non-ASCII path must be pinned verbatim; got ${JSON.stringify(paths)}`,
    );
    for (const p of paths) {
      assert.ok(!p.startsWith('"'), `no path may arrive C-quoted: ${p}`);
      assert.ok(!p.includes('\\3'), `no path may arrive octal-escaped: ${p}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
