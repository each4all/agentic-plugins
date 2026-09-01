// Tests for the selected-blob bundle — contract §11.1's isolation.
//
// The property under test is an ABSENCE, which is the hardest kind to test
// honestly: "no forbidden file is here" passes trivially against an empty
// directory, against a broken builder, and against a probe that looks for the
// wrong thing. Every absence assertion below therefore carries a CONTROL that
// shows the probe finds the thing where it does exist.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { build, verify, bundleMembers, gitBlobId, BUNDLE_MANIFEST, SHARED_INPUTS, NEVER_IN_BUNDLE } from '../../scripts/evidence-bundle.mjs';
import { manifestDigest } from '../../scripts/evidence-corpus.mjs';

const REPO = new URL('../../', import.meta.url).pathname;
const MANIFEST = JSON.parse(readFileSync(join(REPO, 'docs/assurance/evidence/measurement/corpus-manifest.json'), 'utf8'));

function walk(dir, base = dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, base, acc);
    else acc.push(relative(base, full).split(sep).join('/'));
  }
  return acc;
}

function withBundle(fn) {
  const d = mkdtempSync(join(tmpdir(), 'evbundle-'));
  const out = join(d, 'bundle');
  try {
    const r = build(out, { repoRoot: REPO });
    return fn(out, r);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

test('a built bundle verifies clean', () => {
  withBundle((out) => {
    const v = verify(out);
    assert.equal(v.ran, true, v.reason ?? '');
    assert.deepEqual(v.findings, [], JSON.stringify(v.findings.slice(0, 5), null, 2));
  });
});

test('the bundle contains exactly the manifest files, the shared inputs, and its own manifest', () => {
  withBundle((out) => {
    const present = new Set(walk(out));
    const members = bundleMembers(MANIFEST);
    assert.ok(members.length > 0);
    for (const m of members) assert.ok(present.delete(m.path), `${m.path} missing from the bundle`);
    for (const s of SHARED_INPUTS) assert.ok(present.delete(s), `${s} missing from the bundle`);
    assert.ok(present.delete(BUNDLE_MANIFEST));
    assert.deepEqual([...present], [], 'the bundle carries a file nothing accounts for');
  });
});

test('every delivered file hashes to the blob the manifest names', () => {
  withBundle((out) => {
    for (const m of bundleMembers(MANIFEST)) {
      const bytes = readFileSync(join(out, m.path));
      assert.equal(bytes.length, m.bytes, `${m.path} byte length`);
      assert.equal(gitBlobId(bytes), m.blob, `${m.path} blob id`);
    }
  });
});

// --- the absence properties, each with a control -----------------------------

test('§11.2 — no forbidden file reaches the bundle, and the probe finds them in the repo', () => {
  withBundle((out) => {
    const present = walk(out);
    for (const forbidden of NEVER_IN_BUNDLE) {
      // CONTROL first: the probe must find it where it does exist, or the
      // assertion below is about a path that never existed.
      assert.ok(existsSync(join(REPO, forbidden)), `control failed: ${forbidden} is not in the repository, so its absence from the bundle proves nothing`);
      assert.ok(!present.includes(forbidden), `${forbidden} leaked into the bundle`);
    }
  });
});

test('§11.1 — the incumbent detector\'s construction inventory is not in the bundle', () => {
  // §11.1 names this case: "a lane with ordinary repository access at the
  // pinned commit can read the incumbent detector". The detector's closed
  // construction set is the shape of a correct answer, so its absence is the
  // point of the whole bundle.
  const NEEDLE = 'DATE_CITATION_PHRASES';
  const inRepo = readFileSync(join(REPO, 'scripts/check-doc-evidence.mjs'), 'utf8');
  assert.ok(inRepo.includes(NEEDLE), 'control failed: the needle is not in the repository any more; pick a live one');

  withBundle((out) => {
    const hits = walk(out).filter((p) => readFileSync(join(out, p), 'utf8').includes(NEEDLE));
    assert.deepEqual(hits, [], `the construction inventory reached the bundle via ${JSON.stringify(hits)}`);
  });
});

test('§11.1 — no repository history reaches the bundle', () => {
  assert.ok(existsSync(join(REPO, '.git')), 'control failed: the repository has no .git to exclude');
  withBundle((out) => {
    assert.ok(!existsSync(join(out, '.git')));
    assert.deepEqual(walk(out).filter((p) => p.startsWith('.git')), []);
  });
});

// --- verify catches what build must never produce ----------------------------

test('verify catches an extra file — the half that matters for isolation', () => {
  withBundle((out) => {
    assert.deepEqual(verify(out).findings, [], 'control: clean before the edit');
    writeFileSync(join(out, 'docs/leaked.md'), 'anything at all');
    const v = verify(out);
    assert.ok(v.findings.some((f) => f.path === 'docs/leaked.md' && /neither the corpus manifest nor the shared inputs/.test(f.detail)));
  });
});

test('verify catches a missing file, a truncated file, and an edited file', () => {
  withBundle((out) => {
    const m = bundleMembers(MANIFEST)[0];
    const original = readFileSync(join(out, m.path));

    rmSync(join(out, m.path));
    assert.ok(verify(out).findings.some((f) => f.path === m.path && /not present/.test(f.detail)));

    writeFileSync(join(out, m.path), original.subarray(0, original.length - 1));
    assert.ok(verify(out).findings.some((f) => f.path === m.path && /bytes, manifest says/.test(f.detail)));

    // Same length, different bytes — only the hash catches this one.
    const edited = Buffer.from(original);
    edited[0] = edited[0] === 0x41 ? 0x42 : 0x41;
    writeFileSync(join(out, m.path), edited);
    assert.ok(verify(out).findings.some((f) => f.path === m.path && /hashes to/.test(f.detail)));
  });
});

test('verify catches a tampered shared input', () => {
  withBundle((out) => {
    const target = SHARED_INPUTS[0];
    writeFileSync(join(out, target), `${readFileSync(join(out, target), 'utf8')}\n`);
    assert.ok(verify(out).findings.some((f) => f.path === target && /hashes to/.test(f.detail)));
  });
});

test('verify catches repository history planted after the build', () => {
  withBundle((out) => {
    mkdirSync(join(out, '.git'), { recursive: true });
    writeFileSync(join(out, '.git/HEAD'), 'ref: refs/heads/main\n');
    const v = verify(out);
    // The DEDICATED finding, not just any finding mentioning .git. The
    // extra-file check already reports `.git/HEAD`, so an `||` over both
    // accepted that one and the history guard could be deleted with the test
    // still green. Both are asserted, because the history guard is a backstop
    // for a future change that loosens the extra-file check.
    assert.ok(v.findings.some((f) => f.path === '.git' && /repository history/.test(f.detail)),
      `no dedicated history finding: ${JSON.stringify(v.findings)}`);
    assert.ok(v.findings.some((f) => f.path === '.git/HEAD'), 'the extra-file check should also see it');
  });
});

test('verify does not silently pass when the bundle manifest is unreadable', () => {
  withBundle((out) => {
    rmSync(join(out, BUNDLE_MANIFEST));
    const v = verify(out);
    assert.equal(v.ran, false);
    assert.match(v.reason, /unreadable/);
  });
});

test('the bundle manifest survives serialisation with its nested keys intact', () => {
  // Regression: the first builder passed the TOP-LEVEL key list as
  // JSON.stringify's replacer, which is a global allow-list applied at every
  // nesting level, so every entry of `corpus_files` serialised as `{}`.
  withBundle((out) => {
    const bm = JSON.parse(readFileSync(join(out, BUNDLE_MANIFEST), 'utf8'));
    assert.ok(bm.corpus_files.length > 0);
    for (const f of bm.corpus_files.slice(0, 5)) {
      assert.equal(typeof f.path, 'string');
      assert.equal(typeof f.blob, 'string');
      assert.equal(typeof f.bytes, 'number');
      assert.ok(Array.isArray(f.profiles) && f.profiles.length > 0);
    }
    for (const s of bm.shared_inputs) assert.equal(typeof s.path, 'string');
    assert.match(bm.bundle_digest, /^[0-9a-f]{64}$/);
    assert.equal(bm.corpus_commit, MANIFEST.commit);
  });
});

// --- build refuses rather than producing a bundle that is not one ------------

test('build refuses a non-empty directory without --force', () => {
  const d = mkdtempSync(join(tmpdir(), 'evbundle-'));
  try {
    const out = join(d, 'bundle');
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'stale.md'), 'left over from an earlier lane');
    assert.throws(() => build(out, { repoRoot: REPO }), /not empty/);
    // --force replaces rather than merges, so the stale file is gone.
    build(out, { repoRoot: REPO, force: true });
    assert.ok(!existsSync(join(out, 'stale.md')));
    assert.deepEqual(verify(out).findings, []);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('build refuses to write into the repository itself', () => {
  assert.throws(() => build(REPO, { repoRoot: REPO }), /refusing to build a bundle into the repository itself/);
});

test('build refuses a manifest whose digest does not verify', () => {
  const d = mkdtempSync(join(tmpdir(), 'evbundle-'));
  try {
    const rel = 'docs/assurance/evidence/measurement/corpus-manifest.json';
    const fakeRepo = join(d, 'repo');
    mkdirSync(join(fakeRepo, 'docs/assurance/evidence/measurement'), { recursive: true });

    // The §2.1 digest is checked by `validateManifestShape`, which is the
    // single place that rule lives; the builder had a second copy until a
    // mutation exercise showed disabling it changed nothing.
    const tampered = { ...MANIFEST, digest: 'a'.repeat(64) };
    writeFileSync(join(fakeRepo, rel), JSON.stringify(tampered, null, 2));
    assert.throws(() => build(join(d, 'out'), { repoRoot: fakeRepo, manifestPath: rel }), /digest does not match the manifest it accompanies/);

    // Control: the untampered manifest gets past this check and fails later,
    // on the blobs, which proves the refusal above was about the digest.
    writeFileSync(join(fakeRepo, rel), JSON.stringify(MANIFEST, null, 2));
    // The message matters: with `git` reading the MODULE's root instead of the
    // parameter, the blobs are found and the failure moves to a missing shared
    // input (ENOENT). Accepting either message let that bug pass.
    assert.throws(() => build(join(d, 'out'), { repoRoot: fakeRepo, manifestPath: rel }), /is not in this repository/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('bundleMembers unions the profiles and keeps one entry per path', () => {
  const members = bundleMembers(MANIFEST);
  const paths = members.map((m) => m.path);
  assert.equal(new Set(paths).size, paths.length, 'a path appears twice');
  const shared = members.filter((m) => m.profiles.length > 1);
  assert.ok(shared.length > 0, 'the profiles no longer overlap; this assertion measures nothing');
  for (const m of shared) assert.deepEqual([...m.profiles].sort(), m.profiles);
  // One blob per path, or the bundle could not deliver both.
  assert.throws(() => bundleMembers({
    profiles: { a: { files: [{ path: 'x', blob: 'aa', bytes: 1 }] }, b: { files: [{ path: 'x', blob: 'bb', bytes: 1 }] } },
  }), /two different blobs/);
});


test('the NEVER_IN_BUNDLE backstop REFUSES rather than letting verify catch it later', () => {
  // The allow-list is the mechanism; this list is the backstop, and a backstop
  // is only worth its lines if it fires before the damage. Its claim is that a
  // widened allow-list fails loudly AT BUILD TIME, not that a forbidden file is
  // absent — the allow-list already gives that, which is why dropping this
  // check alone changed nothing in a mutation run.
  const d = mkdtempSync(join(tmpdir(), 'evbundle-'));
  try {
    const forbidden = NEVER_IN_BUNDLE[0];
    assert.ok(existsSync(join(REPO, forbidden)), 'control: the file must exist to be refused');

    // An ABSOLUTE manifest path, so `resolve(repoRoot, path)` uses this file
    // and not the real one, while blobs still resolve against the real repo.
    // A relative path here silently read the untampered manifest.
    const planted = JSON.parse(JSON.stringify(MANIFEST));
    const bytes = readFileSync(join(REPO, forbidden));
    planted.profiles['stage-docs'].files.push({ path: forbidden, blob: gitBlobId(bytes), bytes: bytes.length });
    planted.digest = manifestDigest(planted);   // or shape validation refuses first
    const manifestPath = join(d, 'planted-manifest.json');
    writeFileSync(manifestPath, JSON.stringify(planted, null, 2));

    assert.throws(
      () => build(join(d, 'out'), { repoRoot: REPO, manifestPath }),
      /the contract excludes it from every lane/,
      'a manifest naming an excluded file must be refused at build time, not delivered',
    );
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('build rejects a manifest whose byte length disagrees with the object', () => {
  const d = mkdtempSync(join(tmpdir(), 'evbundle-'));
  try {
    const lying = JSON.parse(JSON.stringify(MANIFEST));
    lying.profiles['stage-docs'].files[0].bytes += 1;
    lying.digest = manifestDigest(lying);
    const manifestPath = join(d, 'lying-manifest.json');
    writeFileSync(manifestPath, JSON.stringify(lying, null, 2));
    assert.throws(() => build(join(d, 'out'), { repoRoot: REPO, manifestPath }), /bytes, the manifest says/);

    // Control: the same call with the honest manifest builds cleanly, so the
    // refusal above is about the length and not about the fixture.
    const honest = join(d, 'honest-manifest.json');
    writeFileSync(honest, JSON.stringify(MANIFEST, null, 2));
    const r = build(join(d, 'ok'), { repoRoot: REPO, manifestPath: honest });
    assert.ok(r.corpusFiles > 0);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('§2.3 — none of the ratified decision\'s prose reaches the bundle', () => {
  // The decision is rationale-class: it contains readings of the frozen corpus,
  // and §11.2 forbids a lane from seeing them. Checking for the FILENAME is not
  // enough — the contract names the file in order to exclude it, so a filename
  // probe reports a hit on a correct bundle. This compares CONTENT, and it
  // derives the needles from the document rather than copying its numbers into
  // a test, so it keeps working when the decision is edited.
  const decision = readFileSync(join(REPO, 'docs/assurance/evidence/measurement/association-policy.md'), 'utf8');
  const needles = decision.split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length >= 60 && !l.startsWith('#') && !l.startsWith('|'));
  assert.ok(needles.length > 20, `only ${needles.length} needles derived; the decision's shape has changed`);

  withBundle((out) => {
    const files = walk(out);
    const corpus = files.map((p) => readFileSync(join(out, p), 'utf8'));
    const leaked = needles.filter((n) => corpus.some((text) => text.includes(n)));
    assert.deepEqual(leaked, [], `decision prose reached the bundle: ${JSON.stringify(leaked.slice(0, 3))}`);

    // CONTROL: the same needles ARE findable in the repository, so a zero above
    // is a property of the bundle and not of a probe that matches nothing.
    const repoText = readFileSync(join(REPO, 'docs/assurance/evidence/measurement/association-policy.md'), 'utf8');
    const found = needles.filter((n) => repoText.includes(n));
    assert.equal(found.length, needles.length, 'control: every needle must be findable where the document lives');
  });
});
