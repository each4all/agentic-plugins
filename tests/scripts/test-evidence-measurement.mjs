// Tests for the executable half of the measurement contract (§7, §8, §9, §11.3).
//
// Two of these carry the whole design and are marked where they sit:
//
//   E1 VERDICT REACHABILITY — `pass` and `fail` must both be reachable, and
//      reachable WITHOUT any run artifact being present. Contract 1.0 was
//      retired because its association clause pinned every verdict at
//      `blocked` on its own corpus, and a reducer whose good outcomes are
//      unreachable is not a reducer.
//
//   E3 PAIRING CORRECTNESS — a binding that attached the RIGHT VALUE to the
//      WRONG OCCURRENCE must be a finding. Every value-level check in this
//      repository is blind to it, because the values agree. If this test can
//      be made to pass by comparing literals, the oracle is not doing its job.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  compare, reduce, compareDisposition, roleBindingsAgree, identityKey,
  policyDigest, canonicalDigest, canonicalSerialise, bundleDigest, verifySeal,
  authorityDrift, buildAuthoritySnapshot, buildSeal, resolveCanonical, BUNDLE_FILES,
  ARTIFACT_SCHEMA_PATH,
  resolveAuthorityFields, resolveQuote, artifactDigest, expectedZeroCovers,
  evaluateArtifactOnly, occurrenceKey, resolveIntegrationRef, logicalIntegrationRef,
  CONTRACT_VERSION, DISPOSITIONS, STATUSES, VERDICTS,
} from '../../scripts/evidence-measurement.mjs';

const REPO = new URL('../../', import.meta.url).pathname;

// --- fixture corpus ----------------------------------------------------------
//
// One blob carrying the SAME commit citation twice, which is what makes the
// pairing test meaningful: the two occurrences are distinguishable only by span.
//                0         1         2         3         4         5         6
//                0123456789012345678901234567890123456789012345678901234567890
const BLOB_TEXT = 'tag plugin-runtime-v0.1.0 pr #100 sha aaaaaaa then again aaaaaaa end';
const BLOB_ID = 'b'.repeat(40);      // schema-valid: an object name, not a nickname
const BLOBS = { [BLOB_ID]: Buffer.from(BLOB_TEXT, 'utf8') };
const readBlob = (id) => BLOBS[id] ?? null;

const at = (start, end) => ({ profile: 'stage-docs', path: 'docs/x.md', blob: BLOB_ID, start_byte: start, end_byte: end });
const lit = (span) => BLOB_TEXT.slice(span.start_byte, span.end_byte);

const TAG = at(4, 25);        // plugin-runtime-v0.1.0
const PR = at(29, 33);        // #100
const SHA_FIRST = at(38, 45); // aaaaaaa  (first)
const SHA_SECOND = at(57, 64);// aaaaaaa  (second — same literal, different span)

const occ = (span, family) => ({ ...span, family, literal: lit(span) });

const REGISTRY = {
  // Derived, not literal: a hardcoded version turns every fixture red on a
  // contract bump for a reason that has nothing to do with what it tests.
  contract_version: CONTRACT_VERSION,
  families: [
    { id: 'package-tag' }, { id: 'pr-citation' }, { id: 'commit-citation' },
  ],
  relations: [{
    id: 'release-triple',
    profile: 'stage-docs',
    required: true,
    anchor_role: 'tag',
    roles: [
      { name: 'tag', family: 'package-tag', required: true },
      { name: 'release_pr', family: 'pr-citation', required: true },
      { name: 'squash', family: 'commit-citation', required: false },
    ],
    binding: { declared_by: 'lane', declaration_keys: ['relation', 'anchor_domain', 'class', 'parameters', 'ranking', 'tie_policy', 'digest'] },
  }],
};
const MANIFEST = { digest: 'd'.repeat(64) };
const BUNDLE = 'e'.repeat(64);
const CORPUS_COMMIT = 'c'.repeat(40);
const ARTIFACT_SCHEMA_JSON = JSON.parse(readFileSync(join(REPO, ARTIFACT_SCHEMA_PATH), 'utf8'));

function policy(overrides = {}) {
  const p = {
    relation: 'release-triple',
    anchor_domain: { family: 'package-tag', profile: 'stage-docs', restriction: null },
    class: 'annotation',
    parameters: {},
    ranking: 'none',
    tie_policy: 'ambiguous',
    ...overrides,
  };
  return { ...p, digest: policyDigest(p) };
}

function artifact({ id, role, anchors, occurrences, policies = [policy()], ...rest }) {
  const base = {
    schema: 'evidence-measurement-artifact-1.0',
    contract_version: CONTRACT_VERSION,
    role,
    artifact_id: id,
    bundle_digest: BUNDLE,
    manifest_digest: MANIFEST.digest,
    corpus_commit: CORPUS_COMMIT,
    policies,
    occurrences,
    anchors,
    ...rest,
  };
  // §11.4 — the attestation is derived from the (possibly overridden) artifact
  // rather than from fixture defaults, and its artifact_digest is COMPUTED.
  // A constant here would have made every fixture fail the seal check, which is
  // how the check announced itself when it landed.
  return {
    ...base,
    attestation: {
      contract_version: base.contract_version,
      bundle_digest: base.bundle_digest,
      manifest_digest: base.manifest_digest,
      artifact_digest: artifactDigest(base),
      sealed_at: '2026-08-31T00:00:00Z',
      prohibited_inputs_accessed: [],
    },
  };
}

/** Re-seal after a test mutates an artifact, so the seal check is not what fires. */
function reseal(a) {
  const { attestation: att, ...rest } = a;
  return { ...rest, attestation: { ...att, artifact_digest: artifactDigest(rest) } };
}

const BASE_OCCS = [occ(TAG, 'package-tag'), occ(PR, 'pr-citation'), occ(SHA_FIRST, 'commit-citation'), occ(SHA_SECOND, 'commit-citation')];

const boundRow = (squashSpan) => ({
  relation: 'release-triple', anchor: TAG, disposition: 'bound',
  roles: { tag: TAG, release_pr: PR, squash: squashSpan },
});

function run(artifacts, extra = {}) {
  // The schema is passed in, so every fixture below is also a conformance case.
  // Omitting it would ship a schema that nothing in this suite ever applied.
  return compare({ artifacts, registry: REGISTRY, manifest: MANIFEST, bundleDigest: BUNDLE, readBlob, artifactSchema: ARTIFACT_SCHEMA_JSON, ...extra });
}

// --- §7.2 the table is total -------------------------------------------------

test('compareDisposition returns a vocabulary status for every input, and is not constant', () => {
  // NOTE: this is the WEAK check. `seen.size === 16` would be determined by the
  // loops rather than by the function — a comparator returning `agreeing` for
  // everything would satisfy it — so that assertion is gone. The authoritative
  // test is the one further down that replays the contract's own §7.2 table.
  const produced = new Set();
  for (const o of DISPOSITIONS) {
    for (const l of DISPOSITIONS) {
      for (const agree of [true, false]) {
        const got = compareDisposition(o, l, agree);
        assert.ok(STATUSES.includes(got), `(${o}, ${l}, ${agree}) -> ${got}, outside the status vocabulary`);
        produced.add(got);
      }
    }
  }
  assert.ok(produced.size >= 5, `only ${produced.size} distinct statuses reachable: ${JSON.stringify([...produced])}`);
});

test('the decision\'s two mandated cells: bound/not-a-claim is missed, the reverse is unexpected', () => {
  assert.equal(compareDisposition('bound', 'not-a-claim', false), 'missed');
  assert.equal(compareDisposition('not-a-claim', 'bound', false), 'unexpected');
});

test('an oracle that declined never charges the lane', () => {
  for (const l of DISPOSITIONS) assert.equal(compareDisposition('ambiguous', l, false), 'not-adjudicated');
});

test('a lane that declined is unresolved, not failed', () => {
  for (const o of DISPOSITIONS.filter((d) => d !== 'ambiguous')) {
    assert.equal(compareDisposition(o, 'ambiguous', false), 'unresolved');
  }
});

// --- E3: PAIRING CORRECTNESS -------------------------------------------------

test('E3 — same value, wrong occurrence is `mispaired` (a value check cannot see this)', () => {
  const oracle = artifact({ id: 'oracle', role: 'oracle', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  const lane = artifact({ id: 'lane', role: 'lane', occurrences: BASE_OCCS, anchors: [boundRow(SHA_SECOND)] });

  // The premise: the two candidate occurrences are literally identical.
  assert.equal(lit(SHA_FIRST), lit(SHA_SECOND));
  assert.notEqual(identityKey(SHA_FIRST), identityKey(SHA_SECOND));

  const r = run([oracle, lane]);
  assert.deepEqual(r.structural, [], JSON.stringify(r.structural, null, 2));
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0].status, 'mispaired');
  assert.deepEqual(r.rows[0].differing_roles, ['squash']);
  assert.equal(r.verdict, 'fail');

  // The control: binding the SAME occurrence agrees, so the fixture is not
  // failing for some incidental reason.
  const agreeing = run([oracle, artifact({ id: 'lane', role: 'lane', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] })]);
  assert.equal(agreeing.rows[0].status, 'agreeing');
  assert.equal(agreeing.verdict, 'pass');
});

test('roleBindingsAgree keys on identity, not on value', () => {
  const roles = ['tag', 'release_pr', 'squash'];
  const a = { tag: TAG, release_pr: PR, squash: SHA_FIRST };
  const b = { tag: TAG, release_pr: PR, squash: SHA_SECOND };
  assert.equal(roleBindingsAgree(roles, a, a).agree, true);
  const differ = roleBindingsAgree(roles, a, b);
  assert.equal(differ.agree, false);
  assert.deepEqual(differ.differing, ['squash']);
});

// --- E1: VERDICT REACHABILITY ------------------------------------------------

test('E1 — `pass` is reachable with no artifact-only field anywhere', () => {
  const oracle = artifact({ id: 'oracle', role: 'oracle', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  const lane = artifact({ id: 'lane', role: 'lane', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  for (const a of [oracle, lane]) assert.equal(a.artifact_only_findings, undefined);
  const r = run([oracle, lane]);
  assert.equal(r.verdict, 'pass', r.reason ?? '');
});

test('E1 — `fail` is reachable with no artifact-only field anywhere', () => {
  const oracle = artifact({ id: 'oracle', role: 'oracle', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  const lane = artifact({
    id: 'lane', role: 'lane', occurrences: BASE_OCCS,
    anchors: [{ relation: 'release-triple', anchor: TAG, disposition: 'not-a-claim', roles: {} }],
  });
  const r = run([oracle, lane]);
  assert.equal(r.verdict, 'fail');
  assert.equal(r.rows[0].status, 'missed');
});

test('E1 — reachability is separable from artifact availability', () => {
  // Rows 6 and 9 are the artifact-only rows. Both verdicts above were reached
  // with no artifact-only field in scope, so the reducer's good outcomes do not
  // depend on run artifacts. Here the SAME inputs move only because an
  // artifact-only authority is absent or disagrees — which is what separability
  // means, and it is checked through the derived shape rather than through an
  // array an artifact could simply omit.
  const relations = new Map(REGISTRY.relations.map((r) => [r.id, r]));
  const rows = [{ relation: 'release-triple', status: 'agreeing', required: true }];
  const base = { structural: [], oracles: 1, drift: { drifted: false }, rows, containment: [], relations, artifacts: [] };
  assert.equal(reduce(base).verdict, 'pass');
  assert.equal(reduce({ ...base, artifactOnly: { absent: [{ family: 'proof-run-id', field: 'artifact_present' }], disagreeing: [] } }).verdict, 'blocked');
  assert.equal(reduce({ ...base, artifactOnly: { absent: [], disagreeing: [{ family: 'proof-run-id', field: 'artifact_present' }] } }).verdict, 'fail');
});

// --- E1 on the SHIPPED registry, not a reduced one ---------------------------

test('E1 — pass, fail and blocked are all reachable on the SHIPPED registry', () => {
  // The reduced fixture registry above omits the shipped registry's
  // `artifact-only` family, so on its own it demonstrates reachability for a
  // contract nobody ships. Cross-host review named that: reachability recreated
  // by dropping the condition rather than by satisfying it. This runs the real
  // registry, whose `proof-run-id.artifact_present` IS artifact-only and whose
  // `proof-date-binding` IS required.
  const shipped = JSON.parse(readFileSync(join(REPO, 'docs/assurance/evidence/measurement/family-registry.json'), 'utf8'));
  const artifactOnlyFamilies = shipped.families.filter((f) => (f.fields ?? []).some((x) => x.qualifier === 'artifact-only'));
  assert.ok(artifactOnlyFamilies.length > 0, 'the shipped registry no longer exercises the artifact-only case; this test measures nothing');

  const RUN_LITERAL = 'doctor-20260101T000000Z-abc';
  const DATE_LITERAL = '2026-01-01';
  const TAG_LITERAL = 'plugin-runtime-v0.1.0';
  const PR_LITERAL = '#100';
  const SHA_LITERAL = 'aaaaaaa';
  // BOTH required relations must be exercised, or §8.4's non-vacuity rule
  // blocks the run — which is what it did on the first version of this fixture,
  // correctly.
  const proofText = `proof ${RUN_LITERAL} on ${DATE_LITERAL} recorded; release PR ${PR_LITERAL} squash ${SHA_LITERAL} cut tag ${TAG_LITERAL} .`;
  const blobs = { pb: Buffer.from(proofText, 'utf8') };
  const readProof = (id) => blobs[id] ?? null;
  // Offsets are COMPUTED, not counted. A hand-counted span in a fixture is a
  // second place for an off-by-one to hide, and §3.5 makes exactly that a
  // structural error — so a miscounted fixture fails for the wrong reason.
  const spanOf = (needle) => {
    const at = proofText.indexOf(needle);
    assert.notEqual(at, -1, `fixture does not contain ${needle}`);
    assert.equal(proofText.indexOf(needle, at + 1), -1, `${needle} is not unique in the fixture`);
    return { profile: 'stage-docs', path: 'docs/ARCHITECTURE.md', blob: 'pb', start_byte: at, end_byte: at + Buffer.byteLength(needle, 'utf8') };
  };
  const RUN_ID_SPAN = spanOf(RUN_LITERAL);
  const DATE = spanOf(DATE_LITERAL);
  const TAG = spanOf(TAG_LITERAL);
  const PR = spanOf(PR_LITERAL);
  const SHA = spanOf(SHA_LITERAL);

  const manifest = { digest: 'm', profiles: { 'stage-docs': { files: [{ path: 'docs/ARCHITECTURE.md', blob: 'pb', bytes: proofText.length }] } } };
  const pol = (relation, family) => { const b = { relation, anchor_domain: { family, profile: 'stage-docs', restriction: null }, class: 'annotation', parameters: {}, ranking: 'none', tie_policy: 'ambiguous' }; return { ...b, digest: policyDigest(b) }; };

  const mk = (id, role, artifactState, disposition) => {
    const base = {
      schema: 'evidence-measurement-artifact-1.0', contract_version: shipped.contract_version, role, artifact_id: id,
      bundle_digest: 'B', manifest_digest: 'm', corpus_commit: 'c',
      policies: [pol('proof-date-binding', 'proof-run-id'), pol('release-triple', 'package-tag')],
      occurrences: [
        { ...RUN_ID_SPAN, family: 'proof-run-id', literal: RUN_LITERAL, fields: { kind: { state: 'present', value: 'doctor' }, artifact_present: artifactState } },
        { ...DATE, family: 'iso-date', literal: DATE_LITERAL },
        { ...TAG, family: 'package-tag', literal: TAG_LITERAL, fields: { package: { state: 'present', value: 'runtime' }, version: { state: 'present', value: '0.1.0' } } },
        { ...PR, family: 'pr-citation', literal: PR_LITERAL },
        { ...SHA, family: 'commit-citation', literal: SHA_LITERAL },
      ],
      anchors: [
        { relation: 'proof-date-binding', anchor: RUN_ID_SPAN, disposition, roles: disposition === 'not-a-claim' ? {} : { run_id: RUN_ID_SPAN, date: DATE } },
        { relation: 'release-triple', anchor: TAG, disposition: 'bound', roles: { tag: TAG, release_pr: PR, squash: SHA } },
      ],
    };
    return { ...base, attestation: { contract_version: base.contract_version, bundle_digest: 'B', manifest_digest: 'm', artifact_digest: artifactDigest(base), sealed_at: '2026-01-01T00:00:00Z', prohibited_inputs_accessed: [] } };
  };
  const run2 = (o, l) => compare({ artifacts: [o, l], registry: shipped, manifest, bundleDigest: 'B', readBlob: readProof, baseline: SNAPSHOT, runAuthority: SNAPSHOT });

  // PASS — artifact present and agreeing on both sides.
  const present = { state: 'present', value: true };
  const passing = run2(mk('oracle', 'oracle', present, 'bound'), mk('lane', 'lane', present, 'bound'));
  assert.deepEqual(passing.structural, [], JSON.stringify(passing.structural, null, 2));
  assert.equal(passing.verdict, 'pass', passing.reason ?? '');

  // FAIL — the lane misses a claim the oracle bound. Reached WITHOUT depending
  // on the artifact rows, because row 4 precedes rows 6 and 9.
  const failing = run2(mk('oracle', 'oracle', present, 'bound'), mk('lane', 'lane', present, 'not-a-claim'));
  assert.equal(failing.verdict, 'fail', failing.reason ?? '');

  // BLOCKED — the artifact is absent on this machine. This is the honest
  // answer for the shipped registry on a machine without the run artifacts,
  // not a defect: §2.3 says artifact-only fields are machine-dependent.
  const absent = { state: 'not-applicable', value: null };
  const blocked = run2(mk('oracle', 'oracle', absent, 'bound'), mk('lane', 'lane', absent, 'bound'));
  assert.equal(blocked.verdict, 'blocked', blocked.reason ?? '');
  assert.match(blocked.reason, /artifact-only/);
  assert.ok(blocked.artifact_only.absent.length > 0);

  // And omitting the field entirely must NOT read as present — that was the
  // route by which a lane reached `pass` by saying nothing.
  const silent = run2(mk('oracle', 'oracle', undefined, 'bound'), mk('lane', 'lane', undefined, 'bound'));
  assert.equal(silent.verdict, 'blocked', silent.reason ?? '');
});

// --- §8.4 non-vacuity --------------------------------------------------------

test('§8.4 — two empty artifacts do not reach `pass`', () => {
  const oracle = artifact({ id: 'oracle', role: 'oracle', occurrences: [], anchors: [] });
  const lane = artifact({ id: 'lane', role: 'lane', occurrences: [], anchors: [] });
  const r = run([oracle, lane]);
  assert.notEqual(r.verdict, 'pass');
  assert.equal(r.verdict, 'blocked');
  assert.match(r.reason, /vacuous/);
});

test('§8.4 — an oracle that declined every anchor does not reach `pass`', () => {
  const declined = { relation: 'release-triple', anchor: TAG, disposition: 'ambiguous', roles: {} };
  const oracle = artifact({ id: 'oracle', role: 'oracle', occurrences: BASE_OCCS, anchors: [declined] });
  const lane = artifact({ id: 'lane', role: 'lane', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  const r = run([oracle, lane]);
  assert.equal(r.rows[0].status, 'not-adjudicated');
  assert.equal(r.verdict, 'blocked');
  assert.match(r.reason, /vacuous/);
});

// --- §8.3 not-comparable rows ------------------------------------------------

test('§8.3 row 2 — a run with no oracle has no verdict', () => {
  const a = artifact({ id: 'l1', role: 'lane', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  const b = artifact({ id: 'l2', role: 'lane', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  const r = run([a, b]);
  assert.equal(r.verdict, 'not-comparable');
  assert.match(r.reason, /no oracle/);
});

test('§8.2 — a missing anchor row is structural, not a silent pass', () => {
  const oracle = artifact({ id: 'oracle', role: 'oracle', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  const lane = artifact({ id: 'lane', role: 'lane', occurrences: BASE_OCCS, anchors: [] });
  const r = run([oracle, lane]);
  assert.equal(r.verdict, 'not-comparable');
  assert.ok(r.structural.some((s) => /missing anchor row/.test(s.detail)));
});

test('§8.2 — a lane anchor outside the oracle domain is structural', () => {
  const other = at(0, 3); // "tag"
  const oracle = artifact({ id: 'oracle', role: 'oracle', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  const lane = artifact({
    id: 'lane', role: 'lane',
    occurrences: [...BASE_OCCS, occ(other, 'package-tag')],
    anchors: [boundRow(SHA_FIRST), { relation: 'release-triple', anchor: other, disposition: 'not-a-claim', roles: {} }],
  });
  const r = run([oracle, lane]);
  assert.equal(r.verdict, 'not-comparable');
  assert.ok(r.structural.some((s) => /outside the oracle's domain/.test(s.detail)));
});

test('§8.2/§3.5 — a literal that is not its own span decodes structural', () => {
  const bad = [...BASE_OCCS.slice(1), { ...TAG, family: 'package-tag', literal: 'plugin-runtime-v9.9.9' }];
  const oracle = artifact({ id: 'oracle', role: 'oracle', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  const lane = artifact({ id: 'lane', role: 'lane', occurrences: bad, anchors: [boundRow(SHA_FIRST)] });
  const r = run([oracle, lane]);
  assert.equal(r.verdict, 'not-comparable');
  assert.ok(r.structural.some((s) => /UTF-8 decoding of its own span/.test(s.detail)));
});

test('§8.2 — a span past the end of its blob is structural', () => {
  const past = { profile: 'stage-docs', path: 'docs/x.md', blob: BLOB_ID, start_byte: 10, end_byte: 10_000 };
  const oracle = artifact({ id: 'oracle', role: 'oracle', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  const lane = artifact({
    id: 'lane', role: 'lane',
    occurrences: [...BASE_OCCS, { ...past, family: 'commit-citation', literal: 'x' }],
    anchors: [boundRow(SHA_FIRST)],
  });
  const r = run([oracle, lane]);
  assert.ok(r.structural.some((s) => /past the blob/.test(s.detail)));
});

test('§8.2 — an unreadable blob is structural; an unchecked span is not a checked one', () => {
  const ghost = { profile: 'stage-docs', path: 'docs/x.md', blob: 'nope', start_byte: 0, end_byte: 3 };
  const oracle = artifact({ id: 'oracle', role: 'oracle', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  const lane = artifact({
    id: 'lane', role: 'lane',
    occurrences: [...BASE_OCCS, { ...ghost, family: 'commit-citation', literal: 'tag' }],
    anchors: [boundRow(SHA_FIRST)],
  });
  const r = run([oracle, lane]);
  assert.ok(r.structural.some((s) => /could not be read/.test(s.detail)));
});

test('§8.2 — a family outside the registry is structural', () => {
  const oracle = artifact({ id: 'oracle', role: 'oracle', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  const lane = artifact({
    id: 'lane', role: 'lane',
    occurrences: BASE_OCCS.map((o, i) => (i === 0 ? { ...o, family: 'invented' } : o)),
    anchors: [boundRow(SHA_FIRST)],
  });
  const r = run([oracle, lane]);
  assert.ok(r.structural.some((s) => /not in the registry/.test(s.detail)));
});

test('§8.2 — two rows for one anchor violate §4.3\'s exactly-one', () => {
  const oracle = artifact({ id: 'oracle', role: 'oracle', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  const lane = artifact({ id: 'lane', role: 'lane', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST), boundRow(SHA_SECOND)] });
  const r = run([oracle, lane]);
  assert.ok(r.structural.some((s) => /exactly one/.test(s.detail)));
});

test('§8.2 — artifacts disagreeing on the bundle digest or the pin is structural', () => {
  const oracle = artifact({ id: 'oracle', role: 'oracle', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  const wrongBundle = artifact({ id: 'lane', role: 'lane', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)], bundle_digest: 'other' });
  const r1 = run([oracle, wrongBundle]);
  assert.ok(r1.structural.some((s) => s.path === 'bundle_digest'));
  const wrongPin = artifact({ id: 'lane', role: 'lane', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)], corpus_commit: 'deadbee' });
  const r2 = run([oracle, wrongPin]);
  assert.ok(r2.structural.some((s) => s.path === 'corpus_commit'));
});

// --- §4.5 / §7.4 policy declarations -----------------------------------------

test('§4.5 — a policy declaration whose digest does not seal it is structural', () => {
  const tampered = { ...policy(), class: 'construction-grammar' }; // digest now stale
  const oracle = artifact({ id: 'oracle', role: 'oracle', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  const lane = artifact({ id: 'lane', role: 'lane', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)], policies: [tampered] });
  const r = run([oracle, lane]);
  assert.ok(r.structural.some((s) => /does not match the declaration it seals/.test(s.detail)));
});

test('§4.5 — reporting a relation with no policy declaration is structural', () => {
  const oracle = artifact({ id: 'oracle', role: 'oracle', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  const lane = artifact({ id: 'lane', role: 'lane', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)], policies: [] });
  const r = run([oracle, lane]);
  assert.ok(r.structural.some((s) => /no policy declaration/.test(s.detail)));
});

test('§7.4 — differing policies are a run-level finding and do not change the verdict', () => {
  const oracle = artifact({ id: 'oracle', role: 'oracle', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  const lane = artifact({
    id: 'lane', role: 'lane', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)],
    policies: [policy({ class: 'construction-grammar', parameters: { forms: 7 }, ranking: 'last-wins' })],
  });
  const r = run([oracle, lane]);
  assert.equal(r.policy_findings.length, 1);
  assert.equal(r.policy_findings[0].kind, 'policy-mismatch');
  assert.equal(r.verdict, 'pass', 'a declared difference is a diagnostic; the oracle decides');
});

test('§7.4 — an anchor-domain difference is reported as its own kind', () => {
  const oracle = artifact({ id: 'oracle', role: 'oracle', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  const lane = artifact({
    id: 'lane', role: 'lane', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)],
    policies: [policy({ anchor_domain: { family: 'package-tag', profile: 'stage-docs', restriction: 'the package segment is runtime' } })],
  });
  const r = run([oracle, lane]);
  assert.equal(r.policy_findings[0].kind, 'anchor-domain-mismatch');
  assert.match(r.policy_findings[0].detail, /different anchor populations/);
});

test('two policies that share a class but differ in parameters do not read as agreement', () => {
  const a = policy({ class: 'proximity', parameters: { window: 200 } });
  const b = policy({ class: 'proximity', parameters: { window: 2000 } });
  assert.notEqual(a.digest, b.digest);
});

// --- §7.1 occurrence containment ---------------------------------------------

test('§7.1 — an occurrence the oracle names and the lane lacks is a containment finding', () => {
  const oracle = artifact({ id: 'oracle', role: 'oracle', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  const lane = artifact({
    id: 'lane', role: 'lane',
    occurrences: BASE_OCCS.filter((o) => o.start_byte !== SHA_FIRST.start_byte),
    anchors: [boundRow(SHA_FIRST)],
  });
  const r = run([oracle, lane]);
  assert.ok(r.containment.some((c) => c.kind === 'absent-occurrence'));
  assert.equal(r.verdict, 'fail');
});

test('§7.1 — the same span under a different family is a divergent-occurrence', () => {
  const oracle = artifact({ id: 'oracle', role: 'oracle', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  const lane = artifact({
    id: 'lane', role: 'lane',
    occurrences: BASE_OCCS.map((o) => (o.start_byte === SHA_FIRST.start_byte ? { ...o, family: 'package-tag' } : o)),
    anchors: [boundRow(SHA_FIRST)],
  });
  const r = run([oracle, lane]);
  assert.ok(r.containment.some((c) => c.kind === 'divergent-occurrence'));
});

// --- §11.3 the sealed bundle -------------------------------------------------

test('§11.3 — the bundle digest is over bytes: stable across runs, moved by one byte', () => {
  const a = bundleDigest(REPO).digest;
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(bundleDigest(REPO).digest, a, 'the digest must be stable across runs');

  // The claim in the title, actually exercised: copy the bundle, change one
  // byte of the contract prose, and require the digest to move. A version
  // string would not have moved — which is the whole argument for §11.3.
  const d = mkdtempSync(join(tmpdir(), 'bundle-byte-'));
  try {
    // Derived from BUNDLE_FILES, not listed. A hardcoded list silently stops
    // covering the bundle the moment a member is added — which happened when
    // the artifact schema became the fourth.
    const files = [...BUNDLE_FILES];
    for (const f of files) {
      mkdirSync(join(d, f.slice(0, f.lastIndexOf('/'))), { recursive: true });
      writeFileSync(join(d, f), readFileSync(join(REPO, f)));
    }
    assert.equal(bundleDigest(d, files).digest, a, 'a byte-identical copy must digest identically');
    const target = join(d, files[0]);
    const text = readFileSync(target, 'utf8');
    writeFileSync(target, `${text} `);
    assert.notEqual(bundleDigest(d, files).digest, a);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test('§11.3 — the length prefix makes concatenation unambiguous', () => {
  // Moving a byte across a member boundary must change the digest. Without the
  // length prefix these two bundles would hash identically.
  const d1 = mkdtempSync(join(tmpdir(), 'bundle-a-'));
  const d2 = mkdtempSync(join(tmpdir(), 'bundle-b-'));
  try {
    for (const [d, x, y] of [[d1, 'abc', 'de'], [d2, 'ab', 'cde']]) {
      mkdirSync(join(d, 'p'), { recursive: true });
      writeFileSync(join(d, 'p/one'), x);
      writeFileSync(join(d, 'p/two'), y);
    }
    const h1 = bundleDigest(d1, ['p/one', 'p/two']).digest;
    const h2 = bundleDigest(d2, ['p/one', 'p/two']).digest;
    assert.notEqual(h1, h2);
  } finally {
    rmSync(d1, { recursive: true, force: true });
    rmSync(d2, { recursive: true, force: true });
  }
});

test('§11.3 — the shipped seal matches the shipped bundle bytes', () => {
  const v = verifySeal(REPO);
  assert.equal(v.ok, true, `${v.reason ?? ''} ${JSON.stringify(v.drifted)}`);
});

// --- §9 authority drift ------------------------------------------------------

test('§9 — growth is not drift, movement is', () => {
  const base = {
    integration_ref: 'main', integration_head: 'aaa',
    commits: { c1: 'first', c2: 'second' },
    tags: { 'plugin-x-v1.0.0': { object: 't1', target: 'c1', subject: 'x' } },
  };
  const grown = {
    integration_ref: 'main', integration_head: 'bbb',
    commits: { c1: 'first', c2: 'second', c3: 'third' },
    tags: { ...base.tags, 'plugin-x-v1.1.0': { object: 't2', target: 'c3', subject: 'y' } },
  };
  const g = authorityDrift(base, grown);
  assert.equal(g.drifted, false, JSON.stringify(g.conditions));
  assert.deepEqual(g.info.map((i) => i.kind), ['head_advanced']);

  const retargeted = { ...grown, tags: { ...grown.tags, 'plugin-x-v1.0.0': { object: 't1', target: 'c9', subject: 'x' } } };
  assert.equal(authorityDrift(base, retargeted).drifted, true);

  const rewritten = { ...grown, commits: { c1: 'FIRST', c2: 'second', c3: 'third' } };
  assert.ok(authorityDrift(base, rewritten).conditions.some((c) => c.kind === 'subject-changed'));

  const dropped = { ...grown, commits: { c2: 'second', c3: 'third' } };
  assert.ok(authorityDrift(base, dropped).conditions.some((c) => c.kind === 'commit-unreachable'));
});

test('§8.3 row 3 — drift makes the run not-comparable, never fail', () => {
  const relations = new Map(REGISTRY.relations.map((r) => [r.id, r]));
  const rows = [{ relation: 'release-triple', status: 'missed', required: true }];
  const r = reduce({
    structural: [], oracles: 1,
    drift: { drifted: true, conditions: [{ kind: 'tag-retargeted', detail: 'x' }] },
    rows, containment: [], relations, artifacts: [],
  });
  assert.equal(r.verdict, 'not-comparable');
});

test('§9 — the shipped baseline is enumerated and self-consistent', () => {
  const snap = JSON.parse(readFileSync(join(REPO, 'docs/assurance/evidence/measurement/authority-baseline.json'), 'utf8'));
  assert.equal(snap.commit_count, Object.keys(snap.commits).length);
  assert.equal(snap.tag_count, Object.keys(snap.tags).length);
  assert.ok(snap.commit_count > 0 && snap.tag_count > 0);
  assert.match(snap.integration_head, /^[0-9a-f]{40}$/);
  // Live git must still agree with it, or the committed baseline is a fiction.
  assert.equal(snap.integration_ref, 'main', 'the recorded name must be the logical one, or it is not portable');
  // Rebuilding through the RECORDED name must work in both checkout shapes —
  // this line threw in a detached clone before `main` became a logical alias.
  const live = buildAuthoritySnapshot(REPO, { ref: snap.integration_ref });
  assert.equal(live.integration_ref, snap.integration_ref);
  assert.equal(authorityDrift(snap, live).drifted, false);
});

// --- canonical serialisation -------------------------------------------------

test('§2.1 serialisation orders integer-like keys lexicographically', () => {
  const a = canonicalDigest({ '10': 'x', '2': 'y' });
  const b = canonicalDigest({ '2': 'y', '10': 'x' });
  assert.equal(a, b, 'insertion order must not change the digest');
  // The order itself, not merely its stability: "10" must precede "2", which
  // is what a JS object's own enumeration would NOT do.
  const text = canonicalSerialise({ '2': 'y', '10': 'x' });
  assert.ok(text.indexOf('"10"') < text.indexOf('"2"'), text);
  assert.ok(text.endsWith('\n'));
});

test('§11.3 — buildSeal records every bundle member with its own byte digest', () => {
  const seal = buildSeal(REPO);
  assert.equal(seal.files.length, BUNDLE_FILES.length);
  assert.ok(BUNDLE_FILES.length >= 4, 'the schema must be a sealed member (§3.8, §11.3)');
  for (const f of seal.files) {
    assert.match(f.sha256, /^[0-9a-f]{64}$/);
    assert.equal(f.bytes, readFileSync(join(REPO, f.path)).length);
  }
});

// --- §5 + §9 canonical resolution (§8.3 row 8) --------------------------------

const SNAPSHOT = {
  integration_ref: 'main', integration_head: 'a'.repeat(40),
  commits: { ['a'.repeat(40)]: 'feat: one', ['b'.repeat(40)]: 'feat: two', ['ab' + 'c'.repeat(38)]: 'feat: three' },
  tags: { 'plugin-runtime-v0.1.0': { object: 't1', target: 'b'.repeat(40), subject: 'release' } },
};

test('§5/§9 — an abbreviation resolves to the full object name and names its entry', () => {
  const r = resolveCanonical('aaaaaaa', 'object-name', SNAPSHOT);
  assert.equal(r.state, 'present');
  assert.equal(r.value, 'a'.repeat(40));
  assert.equal(r.entry, `commits/${'a'.repeat(40)}`);
});

test('§9 — an ambiguous abbreviation is unresolved, never a guess', () => {
  const ambiguous = { ...SNAPSHOT, commits: { ...SNAPSHOT.commits, ['a'.repeat(39) + 'f']: 'feat: collide' } };
  const r = resolveCanonical('aaaaaaa', 'object-name', ambiguous);
  assert.equal(r.state, 'unresolved');
  assert.match(r.reason, /2 reachable commits/);
});

test('§9 — an abbreviation matching nothing is unresolved', () => {
  assert.equal(resolveCanonical('fedcba9', 'object-name', SNAPSHOT).state, 'unresolved');
});

test('§9 — a tag resolves through the snapshot, not through live git', () => {
  const r = resolveCanonical('plugin-runtime-v0.1.0', 'tag-ref', SNAPSHOT);
  assert.equal(r.state, 'present');
  assert.equal(r.value, 'b'.repeat(40));
  assert.equal(resolveCanonical('plugin-runtime-v9.9.9', 'tag-ref', SNAPSHOT).state, 'unresolved');
});

test('§9 — with no snapshot at all, nothing resolves', () => {
  assert.equal(resolveCanonical('aaaaaaa', 'object-name', null).state, 'unresolved');
});

test('§7.5 — an artifact-only field is skipped even when it WOULD resolve', () => {
  // The obvious version of this test — a `run-artifact` authority, which is not
  // snapshot-resolvable anyway — passes whether or not the qualifier skip
  // exists, because the fallback already returns not-applicable. It measures
  // the fallback, not the guard. This one gives the field an authority the
  // snapshot CAN resolve, so only the qualifier can keep it out.
  const registry = {
    families: [{
      id: 'proof-run-id',
      required: true,
      fields: [{ name: 'artifact_present', authority: 'object-name', qualifier: 'artifact-only' }],
    }],
  };
  const artifacts = [{ artifact_id: 'lane', occurrences: [{ family: 'proof-run-id', literal: 'aaaaaaa' }] }];

  // Control: the same literal and authority WITHOUT the qualifier does resolve.
  const unqualified = { families: [{ ...registry.families[0], fields: [{ name: 'artifact_present', authority: 'object-name' }] }] };
  const control = resolveAuthorityFields({ artifacts, registry: unqualified, snapshot: SNAPSHOT });
  assert.equal(control.resolved.length, 1, 'the control must resolve, or this test proves nothing');

  const out = resolveAuthorityFields({ artifacts, registry, snapshot: SNAPSHOT });
  assert.deepEqual(out.unresolved, []);
  assert.deepEqual(out.resolved, [], 'an artifact-only field must not be resolved from the snapshot (§7.5, §2.3)');
});

test('§8.3 row 8 — a required family with an unresolvable authority field blocks', () => {
  const relations = new Map(REGISTRY.relations.map((r) => [r.id, r]));
  const rows = [{ relation: 'release-triple', status: 'agreeing', required: true }];
  const base = { structural: [], oracles: 1, drift: { drifted: false }, rows, containment: [], relations, artifacts: [] };
  assert.equal(reduce(base).verdict, 'pass');
  const blocked = reduce({
    ...base,
    authorityFields: { resolved: [], unresolved: [{ artifact: 'lane', family: 'commit-citation', field: 'canonical', literal: 'deadbee', required: true, reason: 'no reachable commit carries this prefix' }] },
  });
  assert.equal(blocked.verdict, 'blocked');
  assert.match(blocked.reason, /row 8/);
});

test('§8.3 row 8 — a NOT-required family that is unresolvable does not block', () => {
  const relations = new Map(REGISTRY.relations.map((r) => [r.id, r]));
  const rows = [{ relation: 'release-triple', status: 'agreeing', required: true }];
  const r = reduce({
    structural: [], oracles: 1, drift: { drifted: false }, rows, containment: [], relations, artifacts: [],
    authorityFields: { resolved: [], unresolved: [{ artifact: 'lane', family: 'bare-semver', field: 'canonical', literal: '1.2.3', required: false, reason: 'x' }] },
  });
  assert.equal(r.verdict, 'pass');
});

test('§8.3 row 8 fires end-to-end through compare()', () => {
  const registry = JSON.parse(JSON.stringify(REGISTRY));
  registry.families = [
    { id: 'package-tag', required: true, fields: [{ name: 'canonical', authority: 'tag-ref' }] },
    { id: 'pr-citation', required: true, fields: [] },
    { id: 'commit-citation', required: true, fields: [{ name: 'canonical', authority: 'object-name' }] },
  ];
  const oracle = artifact({ id: 'oracle', role: 'oracle', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  const lane = artifact({ id: 'lane', role: 'lane', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });

  // `aaaaaaa` is in the snapshot; the package tag is deliberately removed from
  // this one, so the tag-ref field is what blocks.
  const withoutTag = { ...SNAPSHOT, tags: {} };
  const r = compare({ artifacts: [oracle, lane], registry, manifest: MANIFEST, bundleDigest: BUNDLE, readBlob, baseline: withoutTag, runAuthority: withoutTag });
  assert.equal(r.verdict, 'blocked', r.reason ?? '');
  assert.match(r.reason, /package-tag\.canonical/);
  assert.ok(r.authority_fields.resolved.some((x) => x.canonical === 'a'.repeat(40)),
    'the commit-citation field must still have resolved, or the block is not attributable to the tag');

  // Control: restore the tag and the same run reaches `pass`, which is what
  // makes the block above attributable to that one missing authority entry.
  const ok = compare({ artifacts: [oracle, lane], registry, manifest: MANIFEST, bundleDigest: BUNDLE, readBlob, baseline: SNAPSHOT, runAuthority: SNAPSHOT });
  assert.equal(ok.verdict, 'pass', ok.reason ?? '');
});


// --- §11.4 the attestation record --------------------------------------------

test('§11.4 — an artifact with no attestation is structural', () => {
  const oracle = artifact({ id: 'oracle', role: 'oracle', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  const lane = artifact({ id: 'lane', role: 'lane', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  delete lane.attestation;
  const r = run([oracle, lane]);
  assert.equal(r.verdict, 'not-comparable');
  assert.ok(r.structural.some((s) => s.path === 'attestation'));
});

test('§11.4 — an attestation that names a different bundle than its artifact is structural', () => {
  const oracle = artifact({ id: 'oracle', role: 'oracle', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  const lane = artifact({ id: 'lane', role: 'lane', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  lane.attestation = { ...lane.attestation, bundle_digest: 'some-other-bundle' };
  const r = run([oracle, lane]);
  assert.ok(r.structural.some((s) => s.path === 'attestation.bundle_digest'));
});

test('§11.4 — an artifact edited after sealing is structural', () => {
  // This is the post-disclosure edit §11.4 says invalidates a comparison. The
  // artifact stays perfectly well-formed; only its seal stops matching.
  const oracle = artifact({ id: 'oracle', role: 'oracle', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  const lane = artifact({ id: 'lane', role: 'lane', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  const edited = { ...lane, anchors: [boundRow(SHA_SECOND)] };   // seal not recomputed
  const r = run([oracle, edited]);
  assert.ok(r.structural.some((s) => s.path === 'attestation.artifact_digest'),
    JSON.stringify(r.structural.map((x) => x.path)));

  // Control: the same edit WITH a fresh seal passes the seal check, and the
  // comparison then reports the pairing difference instead.
  const ok = run([oracle, reseal(edited)]);
  assert.deepEqual(ok.structural, []);
  assert.equal(ok.rows[0].status, 'mispaired');
});

test('§11.4 — artifactDigest excludes the attestation it is carried by', () => {
  const a = artifact({ id: 'lane', role: 'lane', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  const { attestation: att, ...rest } = a;
  assert.equal(att.artifact_digest, artifactDigest(rest));
  assert.equal(artifactDigest(a), artifactDigest(rest), 'the attestation must not feed its own digest');
});

// --- §3.4 / §8.4 expected_zero ------------------------------------------------

test('§8.4 — a declared expected_zero excuses a required relation with no rows', () => {
  const rel = REGISTRY.relations[0];
  const relations = new Map([[rel.id, { ...rel, anchor_domain: { family: 'package-tag', profile: 'stage-docs', restriction: null } }]]);
  const base = { structural: [], oracles: 1, drift: { drifted: false }, rows: [], containment: [], relations, artifacts: [] };

  // Undeclared: blocked, because a relation that produced nothing and said
  // nothing about why is indistinguishable from an omission (§3.4).
  assert.equal(reduce(base).verdict, 'blocked');

  // Declared for the anchor family in this relation's profile: excused.
  const excused = reduce({ ...base, expectedZero: [{ family: 'package-tag', profile: 'stage-docs', reason: 'declared for this test' }] });
  assert.equal(excused.verdict, 'pass', excused.reason ?? '');

  // Declared for the WRONG profile: not excused.
  const wrong = reduce({ ...base, expectedZero: [{ family: 'package-tag', profile: 'discovered-md', reason: 'wrong profile' }] });
  assert.equal(wrong.verdict, 'blocked');

  // Declared for a family that is not this relation's anchor: not excused.
  const otherFamily = reduce({ ...base, expectedZero: [{ family: 'pr-citation', profile: 'stage-docs', reason: 'not the anchor' }] });
  assert.equal(otherFamily.verdict, 'blocked');
});

test('expectedZeroCovers keys on the anchor family and the relation profile', () => {
  const rel = { id: 'r', profile: 'stage-docs', anchor_role: 'tag', roles: [{ name: 'tag', family: 'package-tag' }], anchor_domain: { family: 'package-tag', profile: 'stage-docs' } };
  assert.equal(expectedZeroCovers(rel, [{ family: 'package-tag', profile: 'stage-docs' }]), true);
  assert.equal(expectedZeroCovers(rel, [{ family: 'package-tag', profile: 'discovered-md' }]), false);
  assert.equal(expectedZeroCovers(rel, []), false);
  // Falls back to the anchor ROLE's family when no anchor_domain is declared,
  // so a registry mid-migration is not silently excused by the absence of a key.
  const noDomain = { ...rel, anchor_domain: undefined };
  assert.equal(expectedZeroCovers(noDomain, [{ family: 'package-tag', profile: 'stage-docs' }]), true);
});

test('§11.4 — an absent prohibited-inputs list is a silence, not an empty claim', () => {
  const oracle = artifact({ id: 'oracle', role: 'oracle', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  const lane = artifact({ id: 'lane', role: 'lane', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  delete lane.attestation.prohibited_inputs_accessed;
  const r = run([oracle, lane]);
  assert.ok(r.structural.some((s) => s.path === 'attestation.prohibited_inputs_accessed'));

  // Control: the empty array is accepted, so the finding above is about absence.
  const ok = run([oracle, artifact({ id: 'lane', role: 'lane', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] })]);
  assert.deepEqual(ok.structural, []);
});

// --- §3.6 quoted context is resolved, never guessed --------------------------

test('§3.6 — a quote that resolves to exactly one span containing the occurrence is fine', () => {
  const r = resolveQuote(BLOBS[BLOB_ID], 'sha aaaaaaa then', SHA_FIRST);
  assert.equal(r.state, 'present');
  assert.ok(r.start_byte <= SHA_FIRST.start_byte && r.end_byte >= SHA_FIRST.end_byte);
});

test('§3.6 — a quote occurring more than once is unresolved, never ranked', () => {
  const r = resolveQuote(BLOBS[BLOB_ID], 'aaaaaaa', SHA_FIRST);
  assert.equal(r.state, 'unresolved');
  assert.match(r.reason, /occurs 2 times/);
});

test('§3.6 — a quote occurring nowhere is unresolved', () => {
  assert.equal(resolveQuote(BLOBS[BLOB_ID], 'not in this blob at all', SHA_FIRST).state, 'unresolved');
});

test('§3.6 — a quote that resolves away from its own occurrence is unresolved', () => {
  const r = resolveQuote(BLOBS[BLOB_ID], 'tag plugin', SHA_FIRST);
  assert.equal(r.state, 'unresolved');
  assert.match(r.reason, /does not contain the occurrence span/);
});

test('§3.6 — an unresolvable quote is reported and decides no verdict', () => {
  const withQuote = BASE_OCCS.map((o) => (o.start_byte === SHA_FIRST.start_byte ? { ...o, quoted_context: 'aaaaaaa' } : o));
  const oracle = artifact({ id: 'oracle', role: 'oracle', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  const lane = artifact({ id: 'lane', role: 'lane', occurrences: withQuote, anchors: [boundRow(SHA_FIRST)] });
  const r = run([oracle, lane]);
  assert.equal(r.quote_findings.length, 1);
  assert.equal(r.quote_findings[0].state, 'unresolved');
  assert.equal(r.verdict, 'pass', 'a rebaseline aid decides no verdict (§3.6)');
});

// --- the contract prose and the code are the same object ---------------------
//
// Three separate defects were found during this contract's authoring where a
// clause asserted a property the shipped code did not have. Each was found by
// reading, which does not scale and did not catch all of them the first time.
// These tests make the two provably the same where that is decidable.

const CONTRACT_TEXT = readFileSync(join(REPO, 'docs/assurance/evidence/measurement/measurement-contract.md'), 'utf8');

test('§7.2 — the contract table and compareDisposition are the same function', () => {
  const table = CONTRACT_TEXT.match(/\| # \| Oracle \| Lane \| Status \|\n\|[-|]+\|\n((?:\|.*\|\n)+)/);
  assert.ok(table, 'the §7.2 table could not be located; this test measures nothing without it');
  const rows = table[1].trim().split('\n').map((line) => {
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    const ticked = (c) => [...c.matchAll(/`([a-z-]+)`/g)].map((m) => m[1]);
    const col = (c) => (c === 'any' ? [...DISPOSITIONS] : ticked(c));
    const agrees = /identical/.test(cells[2]) ? [true] : /differ/.test(cells[2]) ? [false] : [true, false];
    return { n: Number(cells[0]), oracle: col(cells[1]), lane: col(cells[2]), agrees, status: ticked(cells[3])[0] };
  });
  assert.equal(rows.length, 12, 'the prose says twelve rows');

  // First match wins, exactly as the prose says.
  const claimed = new Map();
  for (const row of rows) {
    assert.ok(STATUSES.includes(row.status), `row ${row.n} names a status outside the vocabulary`);
    assert.ok(row.oracle.length > 0 && row.lane.length > 0, `row ${row.n} parsed to an empty column`);
    for (const o of row.oracle) {
      for (const l of row.lane) {
        for (const a of row.agrees) {
          const key = `${o}|${l}|${a}`;
          if (!claimed.has(key)) claimed.set(key, { status: row.status, n: row.n });
        }
      }
    }
  }

  // Totality: every (oracle, lane, rolesAgree) triple is claimed by some row.
  const missing = [];
  for (const o of DISPOSITIONS) for (const l of DISPOSITIONS) for (const a of [true, false]) {
    if (!claimed.has(`${o}|${l}|${a}`)) missing.push(`${o}|${l}|${a}`);
  }
  assert.deepEqual(missing, [], 'the §7.2 table is not total over the disposition pairs');
  assert.equal(claimed.size, 32);

  // Agreement: the code returns exactly what the table's first match says.
  const disagreements = [];
  for (const [key, { status, n }] of claimed) {
    const [o, l, a] = key.split('|');
    const got = compareDisposition(o, l, a === 'true');
    if (got !== status) disagreements.push(`row ${n} (${o} x ${l}, agree=${a}) says ${status}, code says ${got}`);
  }
  assert.deepEqual(disagreements, [], disagreements.join('; '));
});

test('§8.3 — the reducer table verdicts and row references are consistent with the code', () => {
  const table = CONTRACT_TEXT.match(/\| # \| Condition \| Verdict \|\n\|[-|]+\|\n((?:\|.*\|\n)+)/);
  assert.ok(table, 'the §8.3 table could not be located');
  const rows = table[1].trim().split('\n').map((line) => {
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    return { n: Number(cells[0]), verdict: (cells[2].match(/`([a-z-]+)`/) ?? [])[1] };
  });
  assert.ok(rows.length > 0);
  for (const r of rows) assert.ok(VERDICTS.includes(r.verdict), `row ${r.n} names verdict ${r.verdict}`);
  assert.equal(rows[rows.length - 1].verdict, 'pass', 'the last row must be the fall-through');
  assert.deepEqual(rows.map((r) => r.n), rows.map((_, i) => i + 1), 'rows must be numbered consecutively from 1');

  // Every row number the prose cites must exist in the table. A stale "rows
  // 1–9" survived one revision of this document precisely because nothing
  // checked it.
  const cited = [...CONTRACT_TEXT.matchAll(/[Rr]ows? (\d+)(?:\s*(?:and|–|-)\s*(\d+))?/g)]
    .flatMap((m) => (m[2] ? [Number(m[1]), Number(m[2])] : [Number(m[1])]));
  assert.ok(cited.length > 0, 'no row citations found; this assertion measures nothing');
  const outOfRange = cited.filter((n) => n < 1 || n > Math.max(rows.length, 12));
  assert.deepEqual(outOfRange, [], `row citations outside every table: ${JSON.stringify(outOfRange)}`);
});

test('every § cross-reference in the contract resolves to a section it defines', () => {
  const defined = new Set();
  // `## 4. Relations…` and `### 4.1 Relation identity…` differ by that full
  // stop; an earlier version of this pattern required both a stop AND a space
  // and so parsed only the fourteen top-level headings. The size guard below
  // is what caught it — a dangling-reference check over a mis-parsed section
  // set reports whatever the parse happened to miss.
  for (const m of CONTRACT_TEXT.matchAll(/^#{2,3} (\d+(?:\.\d+)?)\.? /gm)) defined.add(m[1]);
  assert.ok(defined.size > 20, `only ${defined.size} sections parsed; the heading pattern has drifted`);
  const refs = new Set([...CONTRACT_TEXT.matchAll(/§(\d+(?:\.\d+)?)/g)].map((m) => m[1]));
  assert.ok(refs.size > 20, `only ${refs.size} references parsed; the reference pattern has drifted`);
  const dangling = [...refs].filter((r) => !defined.has(r));
  assert.deepEqual(dangling, [], `dangling §references: ${JSON.stringify(dangling)}`);
});

test('the contract declares the same version the registry and the code do', () => {
  const declared = CONTRACT_TEXT.match(/^Contract version: \*\*(\d+\.\d+\.\d+)\*\*$/m);
  assert.ok(declared, 'the contract does not declare a version in the expected form');
  const registry = JSON.parse(readFileSync(join(REPO, 'docs/assurance/evidence/measurement/family-registry.json'), 'utf8'));
  assert.equal(declared[1], registry.contract_version);
  assert.equal(declared[1], CONTRACT_VERSION);
});

test('every § citation in the measurement scripts resolves too', () => {
  // The scripts cite clauses rather than restating them, which is the right
  // shape and creates exactly one hazard: a renumbered contract turns every
  // citation into a pointer to something else, silently. evidence-corpus.mjs
  // landed BEFORE the contract existed and carried forward references; when the
  // contract arrived its header still said the contract was not in the tree.
  const defined = new Set();
  for (const m of CONTRACT_TEXT.matchAll(/^#{2,3} (\d+(?:\.\d+)?)\.? /gm)) defined.add(m[1]);
  assert.ok(defined.size > 20, `only ${defined.size} sections parsed; the heading pattern has drifted`);

  const sources = ['scripts/evidence-corpus.mjs', 'scripts/evidence-measurement.mjs', 'scripts/check-family-registry.mjs'];
  const dangling = [];
  let total = 0;
  for (const rel of sources) {
    const src = readFileSync(join(REPO, rel), 'utf8');
    for (const r of new Set([...src.matchAll(/§(\d+(?:\.\d+)?)/g)].map((m) => m[1]))) {
      total += 1;
      if (!defined.has(r)) dangling.push(`${rel}: §${r}`);
    }
  }
  assert.ok(total > 10, `only ${total} citations found across ${sources.length} files; the pattern has drifted`);
  assert.deepEqual(dangling, [], `dangling citations: ${JSON.stringify(dangling)}`);
});

test('no measurement script still claims the contract is absent from the tree', () => {
  // A one-line guard against the specific staleness above. It is narrow on
  // purpose: the general problem (prose going out of date) is not decidable,
  // and a wider phrase list would be the closed-vocabulary guard this
  // repository has watched fail before.
  for (const rel of ['scripts/evidence-corpus.mjs', 'scripts/evidence-measurement.mjs', 'scripts/check-family-registry.mjs']) {
    const src = readFileSync(join(REPO, rel), 'utf8');
    assert.ok(!/NOT IN THE TREE YET/.test(src), `${rel} still says the contract is not in the tree`);
  }
  // The premise: the contract IS in the tree, and is a bundle member.
  assert.ok(readFileSync(join(REPO, 'docs/assurance/evidence/measurement/measurement-contract.md'), 'utf8').length > 0);
});


// --- defects found by cross-host review of the first commit -------------------

test('§3.2 — identity excludes profile, so overlapping profiles do not double it', () => {
  const a = { profile: 'stage-docs', path: 'docs/x.md', blob: 'b1', start_byte: 1, end_byte: 5 };
  const b = { profile: 'discovered-md', path: 'docs/x.md', blob: 'b1', start_byte: 1, end_byte: 5 };
  assert.equal(identityKey(a), identityKey(b), 'the same bytes must be one occurrence, whichever profile names them');
  assert.ok(!identityKey(a).includes('stage-docs'));

  // The premise, measured on the shipped manifest rather than assumed: the two
  // profiles overlap, so this is a live condition and not a hypothetical.
  const m = JSON.parse(readFileSync(join(REPO, 'docs/assurance/evidence/measurement/corpus-manifest.json'), 'utf8'));
  const sd = new Set(m.profiles['stage-docs'].files.map((f) => f.path));
  const overlap = m.profiles['discovered-md'].files.filter((f) => sd.has(f.path));
  assert.ok(overlap.length > 0, 'the profiles no longer overlap; this test measures nothing');
});

test('§3.3 — two families at one extent are two occurrences, in either array order', () => {
  const shared = at(38, 45);
  const twoFamilies = (order) => {
    const list = [occ(TAG, 'package-tag'), occ(PR, 'pr-citation'),
      { ...shared, family: 'commit-citation', literal: lit(shared) },
      { ...shared, family: 'bare-semver', literal: lit(shared) },
      occ(SHA_SECOND, 'commit-citation')];
    return order === 'reversed' ? [...list].reverse() : list;
  };
  const reg = { ...REGISTRY, families: [...REGISTRY.families, { id: 'bare-semver' }] };
  const mk = (id, role, order) => artifact({ id, role, occurrences: twoFamilies(order), anchors: [boundRow(shared)] });
  const forward = compare({ artifacts: [mk('oracle', 'oracle', 'forward'), mk('lane', 'lane', 'forward')], registry: reg, manifest: MANIFEST, bundleDigest: BUNDLE, readBlob });
  const mixed = compare({ artifacts: [mk('oracle', 'oracle', 'forward'), mk('lane', 'lane', 'reversed')], registry: reg, manifest: MANIFEST, bundleDigest: BUNDLE, readBlob });
  // Both `structural` and `containment` matter here. Keyed by identity alone,
  // the two same-extent occurrences collide and produce a FALSE "two
  // occurrences of the same family share a physical identity" — in both orders,
  // so an order-comparison alone would have called that agreement.
  assert.deepEqual(forward.structural, [], JSON.stringify(forward.structural));
  assert.deepEqual(mixed.structural, [], JSON.stringify(mixed.structural));
  assert.deepEqual(forward.containment, []);
  assert.deepEqual(mixed.containment, [], 'array order must not manufacture containment findings');
  assert.equal(forward.verdict, mixed.verdict);
});

test('§2.1 — an occurrence outside the pinned profile is structural', () => {
  const manifest = { digest: MANIFEST.digest, profiles: { 'stage-docs': { files: [{ path: 'docs/x.md', blob: BLOB_ID, bytes: BLOB_TEXT.length }] } } };
  const oracle = artifact({ id: 'oracle', role: 'oracle', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  const inside = compare({ artifacts: [oracle, artifact({ id: 'lane', role: 'lane', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] })], registry: REGISTRY, manifest, bundleDigest: BUNDLE, readBlob });
  assert.deepEqual(inside.structural, [], 'the control must be clean, or the finding below is not about membership');

  const foreign = BASE_OCCS.map((o, i) => (i === 0 ? { ...o, path: 'docs/not-in-the-corpus.md' } : o));
  const outside = compare({ artifacts: [oracle, artifact({ id: 'lane', role: 'lane', occurrences: foreign, anchors: [boundRow(SHA_FIRST)] })], registry: REGISTRY, manifest, bundleDigest: BUNDLE, readBlob });
  assert.ok(outside.structural.some((x) => /not in the pinned/.test(x.detail)), JSON.stringify(outside.structural));
  assert.equal(outside.verdict, 'not-comparable');
});

test('§2.1 — a blob the manifest does not record for that path is structural', () => {
  const manifest = { digest: MANIFEST.digest, profiles: { 'stage-docs': { files: [{ path: 'docs/x.md', blob: 'a-different-blob', bytes: 9 }] } } };
  const oracle = artifact({ id: 'oracle', role: 'oracle', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  const r = compare({ artifacts: [oracle, artifact({ id: 'lane', role: 'lane', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] })], registry: REGISTRY, manifest, bundleDigest: BUNDLE, readBlob });
  assert.ok(r.structural.some((x) => /the manifest records/.test(x.detail)));
});

test('§4.3 — a disposition that contradicts its own roles is structural', () => {
  const oracle = artifact({ id: 'oracle', role: 'oracle', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  const bad = (anchors) => run([oracle, artifact({ id: 'lane', role: 'lane', occurrences: BASE_OCCS, anchors })]);

  // The exact false pass cross-host review reproduced: two `bound` rows with no
  // roles compared equal and reached `agreeing`.
  const emptyBound = bad([{ relation: 'release-triple', anchor: TAG, disposition: 'bound', roles: {} }]);
  assert.ok(emptyBound.structural.some((x) => /leaves required role/.test(x.detail)), JSON.stringify(emptyBound.structural));
  assert.equal(emptyBound.verdict, 'not-comparable');

  const fullIncomplete = bad([{ relation: 'release-triple', anchor: TAG, disposition: 'incomplete', roles: { tag: TAG, release_pr: PR } }]);
  assert.ok(fullIncomplete.structural.some((x) => /every required role is filled/.test(x.detail)));

  const claimingNoClaim = bad([{ relation: 'release-triple', anchor: TAG, disposition: 'not-a-claim', roles: { tag: TAG, release_pr: PR } }]);
  assert.ok(claimingNoClaim.structural.some((x) => /but fills role/.test(x.detail)));

  const wrongAnchor = bad([{ relation: 'release-triple', anchor: TAG, disposition: 'bound', roles: { tag: PR, release_pr: PR } }]);
  assert.ok(wrongAnchor.structural.some((x) => /does not name the anchor occurrence/.test(x.detail)));

  const unknownRole = bad([{ relation: 'release-triple', anchor: TAG, disposition: 'bound', roles: { tag: TAG, release_pr: PR, invented: SHA_FIRST } }]);
  assert.ok(unknownRole.structural.some((x) => /names no role of relation/.test(x.detail)));
});

test('§11.3 — a comparator given no sealed bundle digest fails closed', () => {
  const oracle = artifact({ id: 'oracle', role: 'oracle', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  const lane = artifact({ id: 'lane', role: 'lane', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  const r = compare({ artifacts: [oracle, lane], registry: REGISTRY, manifest: MANIFEST, bundleDigest: null, readBlob });
  assert.ok(r.structural.some((x) => /no sealed bundle digest/.test(x.detail)));
  assert.equal(r.verdict, 'not-comparable', 'a skipped seal check is not a passed one');
});

test('§9 — one snapshot is a check that could not run, not an absence of drift', () => {
  const snap = { integration_ref: 'main', integration_head: 'a', commits: {}, tags: {} };
  assert.equal(authorityDrift(snap, null).drifted, true);
  assert.equal(authorityDrift(null, snap).drifted, true);
  assert.equal(authorityDrift(null, null).drifted, true);
  assert.equal(authorityDrift(snap, snap).drifted, false);
  assert.equal(authorityDrift(null, snap).conditions[0].kind, 'baseline-absent');
});

test('§9 — every recorded tag field is compared, not just the target', () => {
  const base = { integration_ref: 'main', integration_head: 'h', commits: {}, tags: { t: { object: 'o1', target: 'c1', subject: 's1' } } };
  const sameTarget = (tag) => ({ ...base, tags: { t: { ...base.tags.t, ...tag } } });
  assert.equal(authorityDrift(base, base).drifted, false, 'the control must be clean');
  assert.ok(authorityDrift(base, sameTarget({ object: 'o2' })).conditions.some((c) => c.kind === 'tag-object-changed'));
  assert.ok(authorityDrift(base, sameTarget({ subject: 's2' })).conditions.some((c) => c.kind === 'tag-subject-changed'));
  assert.ok(authorityDrift(base, sameTarget({ target: 'c2' })).conditions.some((c) => c.kind === 'tag-retargeted'));
});

test('§4.5 — the declaration shape is checked, not merely its key set', () => {
  const oracle = artifact({ id: 'oracle', role: 'oracle', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  const withPolicy = (over) => run([oracle, artifact({ id: 'lane', role: 'lane', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)], policies: [policy(over)] })]);
  // A finding is located by its `path` and explained by its `detail`; match on
  // either, or an assertion passes or fails on which half carried the word.
  const hit = (r, re) => r.structural.some((x) => re.test(x.detail) || re.test(x.path));
  assert.ok(hit(withPolicy({ parameters: 'whatever' }), /flat object of scalars/));
  assert.ok(hit(withPolicy({ parameters: { nested: { a: 1 } } }), /not a scalar/));
  assert.ok(hit(withPolicy({ tie_policy: 'sometimes' }), /tie_policy/));
  assert.ok(hit(withPolicy({ class: '' }), /non-empty mechanism name/));
  assert.ok(hit(withPolicy({ ranking: '' }), /stated rule/));
  assert.ok(hit(withPolicy({ anchor_domain: { family: 'package-tag' } }), /anchor_domain/));
  // Control: all seven keys present AND well-shaped is clean.
  assert.deepEqual(withPolicy({ parameters: { window: 200 } }).structural, []);
});

test('§7.4 — the mismatch finding names the differing keys and parameters', () => {
  const oracle = artifact({ id: 'oracle', role: 'oracle', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  const lane = artifact({
    id: 'lane', role: 'lane', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)],
    policies: [policy({ class: 'proximity', parameters: { window: 2000, order: 'last' }, ranking: 'last-wins' })],
  });
  const r = run([oracle, lane]);
  const f = r.policy_findings[0];
  assert.deepEqual(f.differing_keys, ['class', 'parameters', 'ranking']);
  assert.deepEqual(f.differing_parameters, ['order', 'window']);
  assert.ok('parameters' in f.declarations.lane, 'the reported declarations must carry what differs');
});

test('§3.3 — a declared field that disagrees is a finding, not silence', () => {
  const reg = JSON.parse(JSON.stringify(REGISTRY));
  reg.families = [
    { id: 'package-tag', required: true, fields: [{ name: 'version' }] },
    { id: 'pr-citation', required: true, fields: [] },
    { id: 'commit-citation', required: true, fields: [] },
  ];
  const withVersion = (v) => BASE_OCCS.map((o) => (o.family === 'package-tag' ? { ...o, fields: { version: { state: 'present', value: v } } } : o));
  const mk = (id, role, v) => artifact({ id, role, occurrences: withVersion(v), anchors: [boundRow(SHA_FIRST)] });
  const go = (ov, lv) => compare({ artifacts: [mk('oracle', 'oracle', ov), mk('lane', 'lane', lv)], registry: reg, manifest: MANIFEST, bundleDigest: BUNDLE, readBlob });

  assert.equal(go('0.1.0', '0.1.0').verdict, 'pass', 'the control must pass');
  const bad = go('0.1.0', '9.9.9');
  assert.ok(bad.containment.some((c) => c.kind === 'divergent-field' && c.field === 'version'), JSON.stringify(bad.containment));
  assert.equal(bad.verdict, 'fail');
});

test('§9 — the integration ref prefers origin/main, which is what a detached CI checkout has', () => {
  // A bare `main` exists on a developer clone and NOT in the detached checkout
  // a pull-request build uses. Resolving only `main` is green locally and red
  // in CI — reproduced against this file by cross-host review.
  //
  // Asserting that the answer is one of {origin/main, main} would pass whether
  // or not the preference exists. This builds a repository carrying BOTH and
  // requires the answer to be origin/main, then removes it and requires main —
  // hermetic, so it holds on a machine with no remote and in CI alike.
  const d = mkdtempSync(join(tmpdir(), 'ref-pref-'));
  const git = (...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  // A hermetic repo: no local `main` once detached, exactly the CI shape.
  try {
    git('init', '-q', '-b', 'main');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'one');
    const head = git('rev-parse', 'HEAD').trim();
    git('update-ref', 'refs/remotes/origin/main', head);
    assert.equal(resolveIntegrationRef(d), 'origin/main');
    // A REQUESTED 'main' is a logical branch name and must fall through the same
    // aliases. This is the mirror of the defect above: fixing only the default
    // left the committed baseline recording `integration_ref: "main"`, which a
    // rebuild resolved literally — green on a clone with a local `main`, and a
    // hard throw in the detached checkout CI uses. Reproduced in a detached
    // clone before this assertion existed.
    git('checkout', '-q', '--detach', head);
    git('branch', '-q', '-D', 'main');
    git('update-ref', 'refs/remotes/origin/main', head);
    assert.equal(resolveIntegrationRef(d, 'main'), 'origin/main', 'a requested logical name must fall through');
    assert.equal(resolveIntegrationRef(d, null), 'origin/main');
    // The recorded name is the logical one, so two checkout shapes compare equal.
    assert.equal(logicalIntegrationRef('origin/main'), 'main');
    assert.equal(logicalIntegrationRef('main'), 'main');
    assert.equal(logicalIntegrationRef('refs/heads/other'), 'refs/heads/other');
    const snap = buildAuthoritySnapshot(d, { ref: 'main' });
    assert.equal(snap.integration_ref, 'main');
    assert.equal(snap.resolved_ref, 'origin/main');

    git('update-ref', '-d', 'refs/remotes/origin/main');
    assert.throws(() => resolveIntegrationRef(d), /no integration ref available/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
  assert.throws(() => resolveIntegrationRef(REPO, 'refs/heads/no-such-ref-here'), /no integration ref available/);
});

test('evaluateArtifactOnly reads the field state, and an omitted field is absent', () => {
  const registry = { families: [{ id: 'proof-run-id', required: true, fields: [{ name: 'artifact_present', authority: 'run-artifact', qualifier: 'artifact-only' }] }] };
  const occAt = (state) => ({ path: 'p', blob: 'b', start_byte: 0, end_byte: 3, family: 'proof-run-id', literal: 'abc', ...(state ? { fields: { artifact_present: state } } : {}) });
  const mk = (role, state, value) => ({ artifact_id: role, role, occurrences: [occAt(state ? { state, value } : null)] });

  assert.equal(evaluateArtifactOnly({ artifacts: [mk('oracle', 'present', 1), mk('lane', 'present', 1)], registry }).absent.length, 0);
  assert.equal(evaluateArtifactOnly({ artifacts: [mk('oracle', 'not-applicable', null), mk('lane', 'not-applicable', null)], registry }).absent.length, 1);
  assert.equal(evaluateArtifactOnly({ artifacts: [mk('oracle', null), mk('lane', null)], registry }).absent.length, 1, 'saying nothing is not saying present');
  assert.equal(evaluateArtifactOnly({ artifacts: [mk('oracle', 'present', 1), mk('lane', 'present', 2)], registry }).disagreeing.length, 1);
  // A registry declaring no artifact-only field produces nothing at all.
  assert.deepEqual(evaluateArtifactOnly({ artifacts: [mk('lane', 'present', 1)], registry: { families: [{ id: 'proof-run-id', fields: [{ name: 'x' }] }] } }).qualified, []);
});


test('§8.2/§3.8 — the schema catches what no other comparator check looks at', () => {
  // These three are well-formed as far as every hand-written check in the
  // comparator is concerned: the bundle digests match, the pins match, the
  // spans decode, the families are registered. Only the schema sees them — so
  // if schema validation were skipped, the run would reach a verdict on an
  // artifact nothing had validated.
  const oracle = artifact({ id: 'oracle', role: 'oracle', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] });
  const onlySchema = [
    ['an unknown top-level property', (a) => ({ ...a, surprise: 'a field no clause defines' })],
    ['a sealed_at that is not an instant', (a) => ({ ...a, attestation: { ...a.attestation, sealed_at: '2026-09-02' } })],
    ['a qualifier outside §7.5', (a) => ({ ...a, anchors: a.anchors.map((x) => ({ ...x, qualifiers: ['invented'] })) })],
  ];
  for (const [label, mutate] of onlySchema) {
    // Reseal AFTER mutating, or §11.4's artifact_digest fires first and the
    // control below reports not-comparable for a reason that is not the schema.
    const lane = reseal(mutate(artifact({ id: 'lane', role: 'lane', occurrences: BASE_OCCS, anchors: [boundRow(SHA_FIRST)] })));
    const withSchema = run([oracle, lane]);
    assert.ok(withSchema.structural.length > 0, `the schema missed: ${label}`);
    assert.equal(withSchema.verdict, 'not-comparable');

    // CONTROL: the same artifact with NO schema supplied reaches a verdict,
    // which is exactly what makes the schema load-bearing here.
    const without = compare({ artifacts: [oracle, lane], registry: REGISTRY, manifest: MANIFEST, bundleDigest: BUNDLE, readBlob });
    assert.equal(without.verdict, 'pass', `${label}: expected the non-schema path to be blind to this`);
  }
});
