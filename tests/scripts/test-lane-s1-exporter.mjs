// Acceptance gate for lane S1's committed artifact.
//
// This is NOT the measurement. S3 compares this lane against an independently
// authored oracle, and that comparison is the result; §11.5 forbids repairing
// either side during it. What this file checks is narrower and is the repo's
// own business: that the committed artifact is REPRODUCIBLE from the pinned
// corpus, and that it is still well-formed under the contract on the day
// someone edits the contract, the registry, the schema, or the manifest.
//
// The lane's own files are byte-identical to what its author sealed and are
// never edited here. Reproduction happens in a temporary workspace shaped the
// way the lane expects (`<root>/bundle`, `<root>/out`), because changing the
// lane's code to suit this test would make it no longer the artifact that was
// sealed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, rmSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build as buildBundle } from '../../scripts/evidence-bundle.mjs';
import {
  compare, artifactDigest, policyDigest, bundleDigest, ARTIFACT_SCHEMA_PATH,
  REGISTRY_PATH, MANIFEST_PATH, CONTRACT_VERSION,
} from '../../scripts/evidence-measurement.mjs';
import { validate as validateAgainstSchema } from '../../scripts/json-schema-mini.mjs';

const REPO = new URL('../../', import.meta.url).pathname;
const LANE_DIR = 'docs/assurance/evidence/measurement/lanes/s1-typed-exporter';
const LANE_FILES = ['exporter.mjs', 'tests.mjs', 'artifact.json', 'NOTES.md'];

const ARTIFACT = JSON.parse(readFileSync(join(REPO, LANE_DIR, 'artifact.json'), 'utf8'));
const SCHEMA = JSON.parse(readFileSync(join(REPO, ARTIFACT_SCHEMA_PATH), 'utf8'));
const REGISTRY = JSON.parse(readFileSync(join(REPO, REGISTRY_PATH), 'utf8'));
const MANIFEST = JSON.parse(readFileSync(join(REPO, MANIFEST_PATH), 'utf8'));

/** A workspace shaped the way the lane expects, with a freshly built bundle. */
function withLaneWorkspace(fn) {
  // realpathSync, or the workspace is under `/var/...` while the module resolves
  // to `/private/var/...` on macOS. The lane's entry guard compares
  // `process.argv[1]` with `import.meta.url`, so the two spellings make `main()`
  // silently not run — the exporter exits 0 having done nothing, and a
  // reproducibility test then compares the committed artifact with itself.
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'lane-s1-')));
  try {
    buildBundle(join(d, 'bundle'), { repoRoot: REPO });
    mkdirSync(join(d, 'out'), { recursive: true });
    for (const f of LANE_FILES) copyFileSync(join(REPO, LANE_DIR, f), join(d, 'out', f));
    return fn(d);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

/** Read blobs from a bundle rather than from git — the bytes the lane saw. */
function bundleBlobReader(bundleRoot) {
  const byBlob = new Map();
  for (const v of Object.values(MANIFEST.profiles)) for (const f of v.files) byBlob.set(f.blob, join(bundleRoot, f.path));
  return (id) => (byBlob.has(id) ? readFileSync(byBlob.get(id)) : null);
}

test('the committed artifact validates against the sealed schema', () => {
  assert.deepEqual(validateAgainstSchema(SCHEMA, ARTIFACT), []);
  assert.equal(ARTIFACT.role, 'lane');
  assert.equal(ARTIFACT.contract_version, CONTRACT_VERSION);
});

test('every digest the artifact declares is the one the contract defines', () => {
  assert.equal(ARTIFACT.manifest_digest, MANIFEST.digest);
  assert.equal(ARTIFACT.corpus_commit, MANIFEST.commit);
  assert.equal(ARTIFACT.bundle_digest, bundleDigest(REPO).digest);
  assert.equal(ARTIFACT.attestation.artifact_digest, artifactDigest(ARTIFACT));
  for (const p of ARTIFACT.policies) assert.equal(p.digest, policyDigest(p), `${p.relation} policy digest`);
});

test('§4.3 — exactly one row per anchor, and every anchor is in the inventory', () => {
  const seen = new Set();
  for (const a of ARTIFACT.anchors) {
    const key = `${a.relation} ${a.anchor.path} ${a.anchor.start_byte} ${a.anchor.end_byte}`;
    assert.ok(!seen.has(key), `two rows for ${key}`);
    seen.add(key);
  }
  const required = new Set(REGISTRY.relations.filter((r) => r.required).map((r) => r.id));
  const reported = new Set(ARTIFACT.anchors.map((a) => a.relation));
  for (const id of required) assert.ok(reported.has(id), `no rows at all for required relation ${id}`);

  // Every anchor row's occurrence must be in the inventory, under the family
  // the relation's anchor domain declares.
  const occ = new Set(ARTIFACT.occurrences.map((o) => `${o.path} ${o.start_byte} ${o.end_byte} ${o.family}`));
  for (const a of ARTIFACT.anchors) {
    const rel = REGISTRY.relations.find((r) => r.id === a.relation);
    const key = `${a.anchor.path} ${a.anchor.start_byte} ${a.anchor.end_byte} ${rel.anchor_domain.family}`;
    assert.ok(occ.has(key), `anchor of ${a.relation} at ${a.anchor.path}:${a.anchor.start_byte} is not in the inventory as ${rel.anchor_domain.family}`);
  }

  // AND THE CONVERSE, which is what makes §4.3's totality checkable here at
  // all. The comparator deliberately does not enumerate the anchor domain from
  // the registry's recognition rules (§4.4), so it cannot see a row this
  // artifact simply omitted. But the artifact's OWN inventory names every
  // occurrence it recognised, so an anchor-family occurrence in the anchor
  // profile with no row is a self-contradiction, decidable without a second
  // recogniser. A mutation deleting one row passed until this existed.
  //
  // This does not close §4.4's residual: an occurrence the lane never
  // recognised is invisible to both halves. That gap needs an independent
  // enumerator and is recorded in the contract's costs, not repaired here.
  for (const rel of REGISTRY.relations) {
    const dom = rel.anchor_domain;
    const inDomain = ARTIFACT.occurrences
      .filter((o) => o.family === dom.family && o.profile === dom.profile)
      .map((o) => `${o.path} ${o.start_byte} ${o.end_byte}`);
    assert.ok(inDomain.length > 0, `no ${dom.family} occurrences in ${dom.profile}; this assertion measures nothing for ${rel.id}`);
    const rows = new Set(ARTIFACT.anchors.filter((a) => a.relation === rel.id)
      .map((a) => `${a.anchor.path} ${a.anchor.start_byte} ${a.anchor.end_byte}`));
    const missing = inDomain.filter((k) => !rows.has(k));
    assert.deepEqual(missing.slice(0, 3), [], `${rel.id}: ${missing.length} in-domain anchor(s) have no row (§4.3)`);
    assert.equal(rows.size, inDomain.length, `${rel.id}: ${rows.size} rows for ${inDomain.length} in-domain anchors`);
  }
});

test('§4.5 — each required relation carries a declared, digested policy', () => {
  const byRelation = new Map(ARTIFACT.policies.map((p) => [p.relation, p]));
  for (const rel of REGISTRY.relations.filter((r) => r.required)) {
    const p = byRelation.get(rel.id);
    assert.ok(p, `no policy declaration for ${rel.id}`);
    for (const k of rel.binding.declaration_keys) assert.ok(k in p, `${rel.id} policy omits ${k}`);
    // §4.5 fixes `parameters` FLAT and says an empty object is a claim rather
    // than an omission, so emptiness is contract-legal and is not asserted
    // against here — a mutation emptying it is not a defect. Whether the
    // declaration is HONEST about the implementation's tunables is a claim
    // (§11.4), not something a check can decide from the artifact.
    assert.equal(typeof p.parameters, 'object');
    assert.ok(!Array.isArray(p.parameters));
    for (const v of Object.values(p.parameters)) assert.ok(v === null || typeof v !== 'object', 'a parameter is not a scalar');
  }
});

test('the comparator finds no structural error in the committed artifact', () => {
  withLaneWorkspace((root) => {
    const r = compare({
      artifacts: [ARTIFACT], registry: REGISTRY, manifest: MANIFEST,
      bundleDigest: bundleDigest(REPO).digest,
      readBlob: bundleBlobReader(join(root, 'bundle')),
      artifactSchema: SCHEMA,
    });
    assert.deepEqual(r.structural, [], JSON.stringify(r.structural.slice(0, 5), null, 2));
    assert.deepEqual(r.quote_findings, []);
    // No oracle in this run, so there is no verdict — §8.3 row 2, and the
    // correct outcome rather than a defect.
    assert.equal(r.verdict, 'not-comparable');
    assert.match(r.reason, /no oracle/);
  });
});

test('§3.5 — every span round-trips against the pinned bytes', () => {
  withLaneWorkspace((root) => {
    const bundleRoot = join(root, 'bundle');
    const cache = new Map();
    let checked = 0;
    for (const o of ARTIFACT.occurrences) {
      if (!cache.has(o.path)) cache.set(o.path, readFileSync(join(bundleRoot, o.path)));
      const bytes = cache.get(o.path);
      assert.equal(bytes.subarray(o.start_byte, o.end_byte).toString('utf8'), o.literal,
        `${o.path}:${o.start_byte}-${o.end_byte}`);
      checked += 1;
    }
    assert.ok(checked > 0, 'no occurrences checked; the artifact is empty');

    // CONTROL: shifting one span by a byte must break the check, or the loop
    // above is comparing something to itself.
    const o = ARTIFACT.occurrences[0];
    const bytes = cache.get(o.path);
    assert.notEqual(bytes.subarray(o.start_byte + 1, o.end_byte + 1).toString('utf8'), o.literal);
  });
});

test('the artifact is REPRODUCIBLE from the pinned corpus', () => {
  withLaneWorkspace((root) => {
    execFileSync('node', [join(root, 'out', 'exporter.mjs')], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const rebuilt = JSON.parse(readFileSync(join(root, 'out', 'artifact.json'), 'utf8'));

    // `sealed_at` is a seal TIME and moves on every run by design, so the
    // comparison is over the artifact digest — which §11.4 defines as excluding
    // the attestation, exactly so measured content can be compared across
    // seals. A whole-file diff here would report a defect on every run.
    // The seal time MUST have moved, which is what proves the exporter actually
    // ran. Without this the test passes against the copied artifact when the
    // entry guard does not fire.
    assert.notEqual(rebuilt.attestation.sealed_at, ARTIFACT.attestation.sealed_at,
      'the exporter did not run: out/artifact.json is still the committed copy');
    assert.equal(artifactDigest(rebuilt), artifactDigest(ARTIFACT),
      'the exporter no longer reproduces the committed measurement from the pinned corpus');
  });
});

test("the lane's own tests still pass against the committed artifact", () => {
  withLaneWorkspace((root) => {
    // Run them, but do not treat them as this repository's acceptance: they are
    // the lane author's, and S3 is the independent check.
    // NODE_TEST_CONTEXT must be stripped. A nested `node --test` inherits it
    // from this runner, switches to the subprocess reporter, and writes nothing
    // to stdout — so the child's output arrives EMPTY. The assertion below is
    // deliberately positive (`fail 0` must appear) rather than negative (no
    // `fail N`), which is why an empty read failed loudly instead of passing.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;
    const out = execFileSync('node', ['--test', join(root, 'out', 'tests.mjs')], { cwd: root, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.ok(out.length > 0, 'the lane test run produced no output; a silent harness is not a pass');
    assert.match(out, /pass (\d+)/);
    assert.match(out, /fail 0/);
    const passed = Number(out.match(/pass (\d+)/)[1]);
    assert.ok(passed > 0, `the lane run reported ${passed} passing tests`);
  });
});
