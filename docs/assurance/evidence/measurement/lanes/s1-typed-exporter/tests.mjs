import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BUNDLE_MEMBERS,
  RELEASE_POLICY_PARAMETERS,
  PROOF_DATE_POLICY_PARAMETERS,
  assertArtifactSemantics,
  buildAnchors,
  canonicalDigest,
  canonicalSerialize,
  computeBundleDigest,
  createPolicies,
  scanBuffer,
  semanticErrors,
  validateJsonSchema,
} from './exporter.mjs';

const OUT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(OUT_DIR);
const BUNDLE_ROOT = path.join(ROOT, 'bundle');
const MEASUREMENT_DIR = path.join(BUNDLE_ROOT, 'docs/assurance/evidence/measurement');
const artifact = JSON.parse(readFileSync(path.join(OUT_DIR, 'artifact.json'), 'utf8'));
const schema = JSON.parse(readFileSync(path.join(MEASUREMENT_DIR, 'artifact-schema.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(path.join(MEASUREMENT_DIR, 'corpus-manifest.json'), 'utf8'));
const registry = JSON.parse(readFileSync(path.join(MEASUREMENT_DIR, 'family-registry.json'), 'utf8'));
const syntheticBlob = '0'.repeat(40);

function clone(value) {
  return structuredClone(value);
}

function withoutAttestation(value) {
  const copy = { ...value };
  delete copy.attestation;
  return copy;
}

function reseal(value) {
  value.attestation.artifact_digest = canonicalDigest(withoutAttestation(value));
  return value;
}

function scan(text, manifestPath = 'fixture.md') {
  const buffer = Buffer.from(text, 'utf8');
  return {
    buffer,
    occurrences: scanBuffer({
      buffer,
      path: manifestPath,
      blob: syntheticBlob,
      profile: 'stage-docs',
    }),
  };
}

function physicalKey(value) {
  return [value.path, value.blob, value.start_byte, value.end_byte].join('\0');
}

function fieldCounts(values, key) {
  const result = {};
  for (const value of values) result[value[key]] = (result[value[key]] ?? 0) + 1;
  return result;
}

test('canonical serializer sorts integer-like keys lexically and retains the final LF', () => {
  const declaration = {
    relation: 'r',
    anchor_domain: { family: 'f', profile: 'p', restriction: null },
    class: 'x',
    parameters: { 2: 'two', 10: 'ten', '01': 'zero-one' },
    ranking: 'none',
    tie_policy: 'ambiguous',
  };
  const encoded = canonicalSerialize(declaration);
  assert.ok(encoded.indexOf('"01"') < encoded.indexOf('"10"'));
  assert.ok(encoded.indexOf('"10"') < encoded.indexOf('"2"'));
  assert.equal(encoded.endsWith('\n'), true);
  assert.equal(
    canonicalDigest(declaration),
    '856a48011b11e7195876f51fa4f649a09447cbaf610320b3670dd1250d69e939',
  );
});

test('bundle seal uses the contract 11.3 order, paths, NULs, lengths, and exact bytes', () => {
  const independent = createHash('sha256');
  for (const member of BUNDLE_MEMBERS) {
    const bytes = readFileSync(path.join(BUNDLE_ROOT, member));
    independent.update(Buffer.from(member));
    independent.update(Buffer.from([0]));
    independent.update(Buffer.from(String(bytes.length), 'ascii'));
    independent.update(Buffer.from([0]));
    independent.update(bytes);
  }
  const expected = 'de28cedddfec3c2aaf60d92e64cde1cea4649ffac8bfe13eb1580d0db7a7d3c5';
  assert.equal(independent.digest('hex'), expected);
  assert.equal(computeBundleDigest(BUNDLE_ROOT), expected);

  const incorrectlyPrefixed = createHash('sha256');
  for (const member of BUNDLE_MEMBERS) {
    const bytes = readFileSync(path.join(BUNDLE_ROOT, member));
    incorrectlyPrefixed.update(Buffer.from(`bundle/${member}\0${bytes.length}\0`));
    incorrectlyPrefixed.update(bytes);
  }
  assert.notEqual(incorrectlyPrefixed.digest('hex'), expected);
});

test('the dependency-free schema checker accepts the artifact and rejects distinct wire defects', () => {
  assert.deepEqual(validateJsonSchema(artifact, schema), []);

  const missingRole = clone(artifact);
  delete missingRole.role;
  assert.match(validateJsonSchema(missingRole, schema).join('\n'), /missing required property role/);

  const nestedParameter = clone(artifact);
  nestedParameter.policies[0].parameters.max_gap_bytes = { nested: 320 };
  assert.match(validateJsonSchema(nestedParameter, schema).join('\n'), /expected type string\|number\|boolean\|null/);

  const unknownProperty = clone(artifact);
  unknownProperty.surprise = true;
  assert.match(validateJsonSchema(unknownProperty, schema).join('\n'), /unexpected property surprise/);

  const fractionalTimestamp = clone(artifact);
  fractionalTimestamp.attestation.sealed_at = '2026-09-02T01:02:03.000Z';
  assert.match(validateJsonSchema(fractionalTimestamp, schema).join('\n'), /does not match pattern/);
});

test('the emitted artifact passes schema plus semantic validation', () => {
  assert.doesNotThrow(() => assertArtifactSemantics(artifact, {
    bundleRoot: BUNDLE_ROOT,
    manifest,
    registry,
    schema,
  }));
  assert.equal(artifact.role, 'lane');
  assert.equal(artifact.manifest_digest, 'b2f1433af69131779bc1b2cc9e69f6a54709714e89145f9498a1c3959e6a7ebc');
  assert.equal(artifact.corpus_commit, 'd49f74e696bf8eb1fd1c934bd588dde305bed23d');
  assert.deepEqual(artifact.attestation.prohibited_inputs_accessed, []);
});

test('all selected files independently match manifest byte counts and Git blob IDs', () => {
  const files = new Map();
  for (const profile of Object.values(manifest.profiles)) {
    for (const file of profile.files) files.set(file.path, file);
  }
  assert.equal(files.size, 77);
  for (const file of files.values()) {
    const bytes = readFileSync(path.join(BUNDLE_ROOT, file.path));
    const blob = createHash('sha1')
      .update(Buffer.from(`blob ${bytes.length}\0`))
      .update(bytes)
      .digest('hex');
    assert.equal(bytes.length, file.bytes, file.path);
    assert.equal(blob, file.blob, file.path);
  }
});

test('every emitted span is an exact fatal-UTF-8 round trip on a verbatim manifest path', () => {
  const fileByPath = new Map();
  for (const profile of Object.values(manifest.profiles)) {
    for (const file of profile.files) fileByPath.set(file.path, file);
  }
  const buffers = new Map();
  const identities = new Set();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (const occurrence of artifact.occurrences) {
    assert.equal(occurrence.path.startsWith('bundle/'), false, occurrence.path);
    const file = fileByPath.get(occurrence.path);
    assert.ok(file, occurrence.path);
    assert.equal(occurrence.blob, file.blob);
    const buffer = buffers.get(occurrence.path) ?? readFileSync(path.join(BUNDLE_ROOT, occurrence.path));
    buffers.set(occurrence.path, buffer);
    assert.ok(Number.isSafeInteger(occurrence.start_byte));
    assert.ok(Number.isSafeInteger(occurrence.end_byte));
    assert.ok(occurrence.start_byte >= 0 && occurrence.start_byte < occurrence.end_byte);
    assert.ok(occurrence.end_byte <= buffer.length);
    assert.equal(
      decoder.decode(buffer.subarray(occurrence.start_byte, occurrence.end_byte)),
      occurrence.literal,
      `${occurrence.path}:${occurrence.start_byte}-${occurrence.end_byte}`,
    );
    const key = `${occurrence.family}\0${physicalKey(occurrence)}`;
    assert.equal(identities.has(key), false, key);
    identities.add(key);
  }
  assert.equal(artifact.occurrences.length, 3416);
});

test('recognition inventory locks every family multiplicity, including dot-delimited tags and shape precedence', () => {
  assert.deepEqual(fieldCounts(artifact.occurrences, 'family'), {
    'bare-semver': 1244,
    'commit-citation': 576,
    'content-digest': 42,
    'iso-date': 557,
    'package-tag': 168,
    'pr-citation': 465,
    'proof-run-id': 364,
  });
  const rangePath = 'docs/adr/0049-evidence-as-data.md';
  const rangeTags = artifact.occurrences.filter((item) => item.path === rangePath
    && ['plugin-runtime-v0.85.0', 'plugin-runtime-v0.86.2'].includes(item.literal));
  assert.deepEqual(rangeTags.map((item) => item.literal).sort(), [
    'plugin-runtime-v0.85.0',
    'plugin-runtime-v0.86.2',
  ]);
  const digestShapes = fieldCounts(
    artifact.occurrences
      .filter((item) => item.family === 'content-digest')
      .map((item) => ({ shape: item.fields.shape.value })),
    'shape',
  );
  assert.deepEqual(digestShapes, { bare: 40, prefixed: 2 });
});

test('overlapping profiles do not duplicate physical occurrences and stage paths retain stage-docs', () => {
  const stagePaths = new Set(manifest.profiles['stage-docs'].files.map((file) => file.path));
  for (const occurrence of artifact.occurrences) {
    assert.equal(occurrence.profile, stagePaths.has(occurrence.path) ? 'stage-docs' : 'discovered-md');
  }
  const physicalAndFamily = artifact.occurrences.map((item) => `${item.family}\0${physicalKey(item)}`);
  assert.equal(new Set(physicalAndFamily).size, physicalAndFamily.length);
});

test('policy declarations expose every implemented control and each digest verifies', () => {
  const generated = createPolicies(registry);
  assert.deepEqual(artifact.policies, generated);
  const release = artifact.policies.find((item) => item.relation === 'release-triple');
  const proof = artifact.policies.find((item) => item.relation === 'proof-date-binding');
  assert.deepEqual(Object.keys(release.parameters).sort(), [
    'disposition_precedence',
    'max_gap_bytes',
    'pr_cue_gap_bytes',
    'pr_cues',
    'record_boundary',
    'reverse_pr_connector_bytes',
    'squash_cue_gap_bytes',
    'squash_cues',
    'sync_cue_gap_bytes',
    'sync_cues',
    'tag_cue_gap_bytes',
    'tag_group_connectors',
    'tag_group_gap_bytes',
  ]);
  assert.deepEqual(release.parameters, RELEASE_POLICY_PARAMETERS);
  assert.deepEqual(Object.keys(proof.parameters).sort(), [
    'construction_order',
    'date_equivalence',
    'disposition_precedence',
    'full_timestamp_fallback',
    'group_child_separators',
    'hard_boundaries',
    'label_nouns',
    'markdown_decorations_removed',
    'max_gap_bytes',
    'scope',
    'whitespace_normalization',
  ]);
  assert.deepEqual(proof.parameters, PROOF_DATE_POLICY_PARAMETERS);
  for (const policy of artifact.policies) {
    const declaration = { ...policy };
    delete declaration.digest;
    assert.equal(policy.digest, canonicalDigest(declaration));
  }
});

test('attestation digest excludes all attestation bytes but covers every measurement byte', () => {
  assert.equal(artifact.attestation.artifact_digest, canonicalDigest(withoutAttestation(artifact)));
  const attestationOnly = clone(artifact);
  attestationOnly.attestation.sealed_at = '2030-01-02T03:04:05Z';
  attestationOnly.attestation.prohibited_inputs_accessed = ['synthetic-test-marker'];
  assert.equal(canonicalDigest(withoutAttestation(attestationOnly)), artifact.attestation.artifact_digest);

  const measurementMutation = clone(artifact);
  measurementMutation.artifact_id += '-changed';
  assert.notEqual(canonicalDigest(withoutAttestation(measurementMutation)), artifact.attestation.artifact_digest);
});

test('exactly one row covers each of the 437 anchors, with locked policy dispositions', () => {
  assert.equal(artifact.anchors.length, 437);
  const counts = {};
  const rowKeys = new Set();
  for (const row of artifact.anchors) {
    const key = `${row.relation}\0${physicalKey(row.anchor)}`;
    assert.equal(rowKeys.has(key), false, key);
    rowKeys.add(key);
    const countKey = `${row.relation}:${row.disposition}`;
    counts[countKey] = (counts[countKey] ?? 0) + 1;
  }
  assert.deepEqual(counts, {
    'proof-date-binding:bound': 125,
    'proof-date-binding:incomplete': 2,
    'proof-date-binding:not-a-claim': 165,
    'release-triple:bound': 117,
    'release-triple:incomplete': 11,
    'release-triple:not-a-claim': 17,
  });
});

test('semantic checker rejects missing and duplicated anchor rows rather than treating silence as pass', () => {
  const missing = clone(artifact);
  missing.anchors.shift();
  reseal(missing);
  assert.match(semanticErrors(missing, { bundleRoot: BUNDLE_ROOT, manifest, registry, schema }).join('\n'), /expected exactly one row/);

  const duplicated = clone(artifact);
  duplicated.anchors.push(clone(duplicated.anchors[0]));
  reseal(duplicated);
  assert.match(semanticErrors(duplicated, { bundleRoot: BUNDLE_ROOT, manifest, registry, schema }).join('\n'), /duplicate rows/);
});

test('semantic checker enforces field states and all disposition/role implications', () => {
  const badField = clone(artifact);
  const unresolvedOccurrence = badField.occurrences.find((item) => item.fields.canonical?.state === 'unresolved');
  unresolvedOccurrence.fields.canonical.value = 'invented';
  reseal(badField);
  assert.match(semanticErrors(badField, { bundleRoot: BUNDLE_ROOT, manifest, registry, schema }).join('\n'), /non-present field carries value/);

  const badBound = clone(artifact);
  const bound = badBound.anchors.find((item) => item.relation === 'release-triple' && item.disposition === 'bound');
  delete bound.roles.release_pr;
  reseal(badBound);
  assert.match(semanticErrors(badBound, { bundleRoot: BUNDLE_ROOT, manifest, registry, schema }).join('\n'), /bound row misses required role/);

  const badIncomplete = clone(artifact);
  const incomplete = badIncomplete.anchors.find((item) => item.relation === 'release-triple' && item.disposition === 'incomplete');
  const stagePr = badIncomplete.occurrences.find((item) => item.family === 'pr-citation'
    && manifest.profiles['stage-docs'].files.some((file) => file.path === item.path));
  incomplete.roles.release_pr = {
    profile: 'stage-docs',
    path: stagePr.path,
    blob: stagePr.blob,
    start_byte: stagePr.start_byte,
    end_byte: stagePr.end_byte,
  };
  reseal(badIncomplete);
  assert.match(semanticErrors(badIncomplete, { bundleRoot: BUNDLE_ROOT, manifest, registry, schema }).join('\n'), /incomplete row fills every required role/);

  const badNegative = clone(artifact);
  const negative = badNegative.anchors.find((item) => item.disposition === 'not-a-claim');
  const relation = registry.relations.find((item) => item.id === negative.relation);
  negative.roles[relation.anchor_role] = clone(negative.anchor);
  reseal(badNegative);
  assert.match(semanticErrors(badNegative, { bundleRoot: BUNDLE_ROOT, manifest, registry, schema }).join('\n'), /not-a-claim row fills roles/);
});

test('byte mapping survives non-ASCII prefixes, CRLF, indentation, hard wraps, and repeated values', () => {
  const text = '한글…\r\n>   abcdef0\r\n> and abcdef0';
  const { buffer, occurrences } = scan(text);
  const commits = occurrences.filter((item) => item.family === 'commit-citation');
  assert.equal(commits.length, 2);
  assert.deepEqual(commits.map((item) => item.start_byte), [buffer.indexOf('abcdef0'), buffer.lastIndexOf('abcdef0')]);
  assert.notEqual(commits[0].start_byte, text.indexOf('abcdef0'));
  for (const occurrence of commits) {
    assert.equal(buffer.subarray(occurrence.start_byte, occurrence.end_byte).toString('utf8'), occurrence.literal);
  }
});

test('recognised spans can begin at byte zero and end at the final blob byte', () => {
  const { buffer, occurrences } = scan('abcdef0 middle 2026-09-02');
  const commit = occurrences.find((item) => item.family === 'commit-citation');
  const date = occurrences.find((item) => item.family === 'iso-date');
  assert.equal(commit.start_byte, 0);
  assert.equal(commit.literal, 'abcdef0');
  assert.equal(date.end_byte, buffer.length);
  assert.equal(date.literal, '2026-09-02');
});

test('delimiters and code fences never leak into tag, PR, or digest spans', () => {
  const digest = 'a'.repeat(64);
  const text = `\`plugin-demo-v1.2.3\` [#42]\n\`\`\`text\nsha256:${digest}\n\`\`\``;
  const { occurrences } = scan(text);
  const tag = occurrences.filter((item) => item.family === 'package-tag');
  const pr = occurrences.filter((item) => item.family === 'pr-citation');
  const digests = occurrences.filter((item) => item.family === 'content-digest');
  assert.deepEqual(tag.map((item) => item.literal), ['plugin-demo-v1.2.3']);
  assert.deepEqual(pr.map((item) => item.literal), ['#42']);
  assert.deepEqual(digests.map((item) => item.literal), [digest]);
  assert.equal(digests[0].fields.shape.value, 'prefixed');
  assert.equal(occurrences.some((item) => item.family === 'bare-semver' && item.literal === '1.2.3'), false);
});

test('proof compact dates are excluded while a separate ISO date retains trailing Z', () => {
  const { occurrences } = scan('on 2026-09-02Z as doctor-20260902T010203Z-abc123');
  const runs = occurrences.filter((item) => item.family === 'proof-run-id');
  const dates = occurrences.filter((item) => item.family === 'iso-date');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].fields.kind.value, 'doctor');
  assert.deepEqual(dates.map((item) => item.literal), ['2026-09-02Z']);
});

test('commit boundaries, overlong hashes, PR termination, and multiline digest precedence are load-bearing', () => {
  const forty = 'a'.repeat(40);
  const fortyOne = 'b'.repeat(41);
  const digest = 'c'.repeat(64);
  const text = `abcdef0… -1234567 ${forty} ${fortyOne} #12]\ncontent_sha256\n\`${digest}\` #34`;
  const { occurrences } = scan(text);
  assert.deepEqual(
    occurrences.filter((item) => item.family === 'commit-citation').map((item) => item.literal),
    [forty],
  );
  assert.deepEqual(
    occurrences.filter((item) => item.family === 'pr-citation').map((item) => item.literal),
    ['#12'],
  );
  const digests = occurrences.filter((item) => item.family === 'content-digest');
  assert.deepEqual(digests.map((item) => item.literal), [fortyOne, digest]);
  assert.deepEqual(digests.map((item) => item.fields.shape.value), ['bare', 'prefixed']);
});

test('release policy binds a cue-delimited record, marks a missing release PR incomplete, and ignores a mention', () => {
  const boundText = 'release PR #12 squash abcdef0, tags plugin-a-v1.2.3 and plugin-b-v2.3.4, marketplace sync 1234567.';
  const boundScan = scan(boundText);
  const boundRows = buildAnchors(
    boundScan.occurrences,
    new Map([['fixture.md', boundScan.buffer]]),
    registry,
  ).filter((item) => item.relation === 'release-triple');
  assert.equal(boundRows.length, 2);
  for (const row of boundRows) {
    assert.equal(row.disposition, 'bound');
    assert.deepEqual(Object.keys(row.roles).sort(), ['marketplace_sync', 'release_pr', 'squash', 'tag']);
  }
  assert.equal(physicalKey(boundRows[0].roles.release_pr), physicalKey(boundRows[1].roles.release_pr));

  const incompleteScan = scan('release tag plugin-a-v1.2.3.');
  const incompleteRow = buildAnchors(
    incompleteScan.occurrences,
    new Map([['fixture.md', incompleteScan.buffer]]),
    registry,
  ).find((item) => item.relation === 'release-triple');
  assert.equal(incompleteRow.disposition, 'incomplete');
  assert.deepEqual(Object.keys(incompleteRow.roles), ['tag']);

  const mentionScan = scan('installed plugin-a-v1.2.3.');
  const mentionRow = buildAnchors(
    mentionScan.occurrences,
    new Map([['fixture.md', mentionScan.buffer]]),
    registry,
  ).find((item) => item.relation === 'release-triple');
  assert.equal(mentionRow.disposition, 'not-a-claim');
  assert.deepEqual(mentionRow.roles, {});
});

test('unranked release-role multiplicity emits ambiguous instead of selecting a repeated candidate', () => {
  const text = 'release PR #12 squash abcdef0 squash 1234567, tag plugin-a-v1.2.3.';
  const scanned = scan(text);
  const row = buildAnchors(
    scanned.occurrences,
    new Map([['fixture.md', scanned.buffer]]),
    registry,
  ).find((item) => item.relation === 'release-triple');
  assert.equal(row.disposition, 'ambiguous');
  assert.equal(Object.hasOwn(row.roles, 'release_pr'), true);
  assert.equal(Object.hasOwn(row.roles, 'squash'), false);
});

test('proof-date policy binds one physical match, refuses two equal matches, and does not invent a missing date', () => {
  const uniqueScan = scan('2026-01-02 as run-20260102T000000Z-a');
  const unique = buildAnchors(
    uniqueScan.occurrences,
    new Map([['fixture.md', uniqueScan.buffer]]),
    registry,
  ).find((item) => item.relation === 'proof-date-binding');
  assert.equal(unique.disposition, 'bound');
  assert.deepEqual(Object.keys(unique.roles).sort(), ['date', 'run_id']);

  const repeatedScan = scan('2026-01-02 run-20260102T000000Z-a 2026-01-02');
  const repeated = buildAnchors(
    repeatedScan.occurrences,
    new Map([['fixture.md', repeatedScan.buffer]]),
    registry,
  ).find((item) => item.relation === 'proof-date-binding');
  assert.equal(repeated.disposition, 'ambiguous');
  assert.deepEqual(Object.keys(repeated.roles), ['run_id']);

  const missingScan = scan('artifact run-20260102T000000Z-a retained');
  const missing = buildAnchors(
    missingScan.occurrences,
    new Map([['fixture.md', missingScan.buffer]]),
    registry,
  ).find((item) => item.relation === 'proof-date-binding');
  assert.equal(missing.disposition, 'not-a-claim');
  assert.deepEqual(missing.roles, {});

  const weakProximityScan = scan('2026-07-25 baseline moved while compat-20260725T020139Z-f0cc72 remained');
  const weakProximity = buildAnchors(
    weakProximityScan.occurrences,
    new Map([['fixture.md', weakProximityScan.buffer]]),
    registry,
  ).find((item) => item.relation === 'proof-date-binding');
  assert.equal(weakProximity.disposition, 'not-a-claim');

  const timestampScan = scan('settings-20260712T015100Z-312fbb (attested 2026-07-12T01:51Z)');
  const timestamp = buildAnchors(
    timestampScan.occurrences,
    new Map([['fixture.md', timestampScan.buffer]]),
    registry,
  ).find((item) => item.relation === 'proof-date-binding');
  assert.equal(timestampScan.occurrences.some((item) => item.family === 'iso-date'), false);
  assert.equal(timestamp.disposition, 'incomplete');
  assert.deepEqual(Object.keys(timestamp.roles), ['run_id']);
});
