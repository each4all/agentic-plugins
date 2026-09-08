import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import {
  artifactDigest,
  buildArtifact,
  canonicalJson,
  computeBundleDigest,
  declarationDigest,
  makeAnchors,
  POLICY_PARAMETERS,
  recognizeDocument,
  validateAgainstSchema,
  validateArtifactSemantics,
} from './exporter.mjs';

const run = promisify(execFile);
const workspace = new URL('../', import.meta.url);
const bundle = new URL('../bundle/', import.meta.url);
const registryUrl = new URL(
  'docs/assurance/evidence/measurement/family-registry.json',
  bundle,
);
const schemaUrl = new URL(
  'docs/assurance/evidence/measurement/artifact-schema.json',
  bundle,
);
const manifestUrl = new URL(
  'docs/assurance/evidence/measurement/corpus-manifest.json',
  bundle,
);
const sharedPaths = [
  'docs/assurance/evidence/measurement/measurement-contract.md',
  'docs/assurance/evidence/measurement/family-registry.json',
  'docs/assurance/evidence/measurement/corpus-manifest.json',
  'docs/assurance/evidence/measurement/artifact-schema.json',
];

const [registry, schema, manifest] = await Promise.all(
  [registryUrl, schemaUrl, manifestUrl].map(async (url) =>
    JSON.parse(await readFile(url, 'utf8')),
  ),
);

const builtPromise = buildArtifact({ sealedAt: new Date('2026-09-03T00:00:00Z') });
const fakeBlob = '0'.repeat(40);

function synthetic(text, path = 'synthetic.md') {
  return recognizeDocument({
    path,
    blob: fakeBlob,
    profile: 'stage-docs',
    bytes: Buffer.from(text, 'utf8'),
  });
}

function deepClone(value) {
  return structuredClone(value);
}

test('canonical JSON sorts integer-like keys lexically at every level and ends in one newline', () => {
  const value = { 2: 'outer-two', 10: { 2: 'inner-two', 10: 'inner-ten' } };
  assert.equal(
    canonicalJson(value),
    '{\n' +
      '  "10": {\n' +
      '    "10": "inner-ten",\n' +
      '    "2": "inner-two"\n' +
      '  },\n' +
      '  "2": "outer-two"\n' +
      '}\n',
  );
  assert.ok(!canonicalJson(value).endsWith('\n\n'));
});

test('manifest, policy, artifact, and byte-framed bundle digests use their distinct rules', async () => {
  const { digest, ...withoutDigest } = manifest;
  const manifestHash = createHash('sha256')
    .update(canonicalJson(withoutDigest), 'utf8')
    .digest('hex');
  assert.equal(manifestHash, digest);

  const members = new Map(
    await Promise.all(
      sharedPaths.map(async (path) => [path, await readFile(new URL(path, bundle))]),
    ),
  );
  const delivery = JSON.parse(await readFile(new URL('bundle-manifest.json', bundle), 'utf8'));
  assert.equal(computeBundleDigest(members), delivery.bundle_digest);

  const { artifact } = await builtPromise;
  assert.equal(artifact.attestation.artifact_digest, artifactDigest(artifact));
  const attestationOnlyMutation = deepClone(artifact);
  attestationOnlyMutation.attestation.sealed_at = '2099-01-01T00:00:00Z';
  assert.equal(artifactDigest(attestationOnlyMutation), artifactDigest(artifact));
  const materialMutation = deepClone(artifact);
  materialMutation.artifact_id += '-changed';
  assert.notEqual(artifactDigest(materialMutation), artifactDigest(artifact));

  const policy = artifact.policies[0];
  assert.equal(policy.digest, declarationDigest(policy));
  const changedPolicy = deepClone(policy);
  changedPolicy.parameters.label_gap_code_units += 1;
  assert.notEqual(declarationDigest(changedPolicy), policy.digest);
});

test('maximal hex rules enforce long-run separation, hyphen and ellipsis boundaries, and EOF', () => {
  const long = 'a'.repeat(41);
  const document = synthetic(`abcdef0 ${long} -bcdef12 …cdef123 ddddddd- eeeeeee`);
  const commits = document.occurrences.filter((item) => item.family === 'commit-citation');
  const digests = document.occurrences.filter((item) => item.family === 'content-digest');
  assert.deepEqual(commits.map((item) => item.literal), ['abcdef0', 'ddddddd', 'eeeeeee']);
  assert.equal(commits.at(-1).end_byte, document.bytes.length);
  assert.deepEqual(digests.map((item) => item.literal), [long]);
});

test('package tags and PR links exclude wrappers, reject contained semver, and honor PR termination', () => {
  const document = synthetic('`plugin-any-package-v12.3.4` [#123](x) #12345 #99');
  const tags = document.occurrences.filter((item) => item.family === 'package-tag');
  const prs = document.occurrences.filter((item) => item.family === 'pr-citation');
  const semvers = document.occurrences.filter((item) => item.family === 'bare-semver');
  assert.equal(tags.length, 1);
  assert.equal(tags[0].literal, 'plugin-any-package-v12.3.4');
  assert.equal(tags[0].fields.package.value, 'any-package');
  assert.equal(tags[0].fields.version.value, '12.3.4');
  assert.deepEqual(prs.map((item) => item.literal), ['#123']);
  assert.equal(semvers.length, 0);
  assert.ok(!prs.some((item) => item.literal === '#99'), 'a PR token at EOF is not terminated');
});

test('ISO dates include trailing Z and suppress ISO-shaped text inside proof-run IDs', () => {
  const text = '2026-09-03Z x-2026-09-04-20260904T010203Z-abc123 2026-09-05';
  const document = synthetic(text);
  const runs = document.occurrences.filter((item) => item.family === 'proof-run-id');
  const dates = document.occurrences.filter((item) => item.family === 'iso-date');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].fields.kind.value, 'x-2026-09-04');
  assert.deepEqual(dates.map((item) => item.literal), ['2026-09-03Z', '2026-09-05']);
});

test('content-digest precedence classifies both introducer forms as prefixed', () => {
  const first = 'a'.repeat(64);
  const second = 'b'.repeat(64);
  const third = 'c'.repeat(64);
  const document = synthetic(`"content_sha256": "${first}"\nsha256:${second}\n${third}`);
  const digests = document.occurrences.filter((item) => item.family === 'content-digest');
  assert.deepEqual(
    digests.map((item) => item.fields.shape.value),
    ['prefixed', 'prefixed', 'bare'],
  );
  assert.deepEqual(digests.map((item) => item.literal), [first, second, third]);
});

test('byte coordinates survive non-ASCII prefixes and CRLF, including first/final-byte tokens', () => {
  const text = 'plugin-alpha-v1.2.3 é\r\nabcdef0';
  const document = synthetic(text);
  const tag = document.occurrences.find((item) => item.family === 'package-tag');
  const commit = document.occurrences.find((item) => item.family === 'commit-citation');
  assert.equal(tag.start_byte, 0);
  assert.equal(commit.end_byte, Buffer.byteLength(text));
  assert.notEqual(commit.start_byte, text.indexOf('abcdef0'));
  for (const occurrence of document.occurrences) {
    assert.equal(
      document.bytes.subarray(occurrence.start_byte, occurrence.end_byte).toString('utf8'),
      occurrence.literal,
    );
  }
  assert.throws(
    () => recognizeDocument({ path: 'bad.md', blob: fakeBlob, profile: 'stage-docs', bytes: Buffer.from([0xff]) }),
    /encoded data|encoding|UTF-8/iu,
  );
});

test('word boundaries use the declared ECMAScript ASCII judgment before Korean text', () => {
  const text = '0.128.0이';
  const document = synthetic(text);
  const semver = document.occurrences.find((item) => item.family === 'bare-semver');
  assert.equal(semver.literal, '0.128.0');
  assert.equal(semver.start_byte, 0);
  assert.equal(semver.end_byte, Buffer.byteLength('0.128.0'));
  assert.equal(
    document.bytes.subarray(semver.start_byte, semver.end_byte).toString('utf8'),
    semver.literal,
  );
});

test('wrapped and indented release construction binds exact labeled roles', () => {
  const document = synthetic(
    '- Published release PR [#123](https://invalid) squash `abcdef0`,\n' +
      '  tag `plugin-alpha-v1.2.3`, marketplace sync `bcdef12`.\n',
  );
  const rows = makeAnchors(registry, new Map([[document.path, document]]));
  const row = rows.find((item) => item.relation === 'release-triple');
  assert.equal(row.disposition, 'bound');
  assert.deepEqual(Object.keys(row.roles).sort(), ['marketplace_sync', 'release_pr', 'squash']);
  const literals = Object.fromEntries(
    Object.entries(row.roles).map(([name, role]) => {
      const occurrence = document.occurrences.find(
        (item) =>
          item.path === role.path &&
          item.start_byte === role.start_byte &&
          item.end_byte === role.end_byte,
      );
      return [name, occurrence.literal];
    }),
  );
  assert.deepEqual(literals, {
    marketplace_sync: 'bcdef12',
    release_pr: '#123',
    squash: 'abcdef0',
  });
});

test('unranked duplicate release candidates yield one ambiguous anchor row', () => {
  const document = synthetic(
    '- release PR #123 and release PR #124, tag plugin-alpha-v1.2.3.\n',
  );
  const rows = makeAnchors(registry, new Map([[document.path, document]]));
  const releaseRows = rows.filter((item) => item.relation === 'release-triple');
  assert.equal(releaseRows.length, 1);
  assert.equal(releaseRows[0].disposition, 'ambiguous');
  assert.deepEqual(releaseRows[0].roles, {});
});

test('an explicit plural tag list binds every listed anchor to the shared release PR', () => {
  const document = synthetic(
    '- release PR #123 squash abcdef0, tags plugin-alpha-v1.2.3 and ' +
      'plugin-beta-v2.3.4, marketplace sync bcdef12.\n',
  );
  const rows = makeAnchors(registry, new Map([[document.path, document]]))
    .filter((item) => item.relation === 'release-triple');
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.disposition === 'bound'));
  assert.equal(new Set(rows.map((row) => row.roles.release_pr.start_byte)).size, 1);
});

test('claim cues without a required candidate are incomplete, while bare mentions are not claims', () => {
  const releaseClaim = synthetic('Shipped with plugin-alpha-v1.2.3.\n', 'release-claim.md');
  const releaseMention = synthetic('Token plugin-beta-v2.3.4.\n', 'release-mention.md');
  const proofClaim = synthetic(
    'Evidence run doctor-20260903T010203Z-abc123.\n',
    'proof-claim.md',
  );
  const proofMention = synthetic(
    'doctor-20260903T010203Z-abc123\n',
    'proof-mention.md',
  );
  const documents = new Map(
    [releaseClaim, releaseMention, proofClaim, proofMention].map((document) => [
      document.path,
      document,
    ]),
  );
  const rows = makeAnchors(registry, documents);
  const byPath = new Map(rows.map((row) => [row.anchor.path, row]));
  assert.equal(byPath.get('release-claim.md').disposition, 'incomplete');
  assert.equal(byPath.get('release-mention.md').disposition, 'not-a-claim');
  assert.equal(byPath.get('proof-claim.md').disposition, 'incomplete');
  assert.equal(byPath.get('proof-mention.md').disposition, 'not-a-claim');
});

test('wrapped proof-date connector binds, while a two-date cell remains ambiguous', () => {
  const boundDocument = synthetic(
    '- Proof recorded on 2026-09-03Z as\n' +
      '  `doctor-20260903T010203Z-abc123`.\n',
    'bound.md',
  );
  const boundRows = makeAnchors(registry, new Map([[boundDocument.path, boundDocument]]));
  const bound = boundRows.find((item) => item.relation === 'proof-date-binding');
  assert.equal(bound.disposition, 'bound');
  assert.ok(bound.roles.date);

  const ambiguousDocument = synthetic(
    '| proof 2026-09-03 and 2026-09-04 doctor-20260903T010203Z-abc123 |\n',
    'ambiguous.md',
  );
  const ambiguousRows = makeAnchors(
    registry,
    new Map([[ambiguousDocument.path, ambiguousDocument]]),
  );
  const ambiguous = ambiguousRows.find((item) => item.relation === 'proof-date-binding');
  assert.equal(ambiguous.disposition, 'ambiguous');
  assert.deepEqual(ambiguous.roles, {});
});

test('proof-date policy declaration names every implemented directional joiner', () => {
  const parameters = POLICY_PARAMETERS['proof-date-binding'];
  assert.equal(
    parameters.date_before_anchor_joiners,
    'as|for|by; optional only when a left cue is present',
  );
  assert.equal(
    parameters.clause_boundaries,
    'semicolon unconditionally; .?! only before whitespace or clause end',
  );
  const document = synthetic(
    '2026-09-03 for doctor-20260903T010203Z-abc123.\n',
    'directional.md',
  );
  const row = makeAnchors(registry, new Map([[document.path, document]]))
    .find((item) => item.relation === 'proof-date-binding');
  assert.equal(row.disposition, 'bound');
});

test('code-fenced relation-looking text is inventoried but is not asserted as a claim', () => {
  const document = synthetic(
    '```text\nrelease PR #123 tag plugin-alpha-v1.2.3\n' +
      'doctor-20260903T010203Z-abc123 on 2026-09-03\n```\n',
  );
  const rows = makeAnchors(registry, new Map([[document.path, document]]));
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.disposition === 'not-a-claim'));
});

test('equal lexemes at distinct source spans remain distinct physical occurrences', async () => {
  const { artifact } = await builtPromise;
  const repeated = artifact.occurrences.filter(
    (item) =>
      item.path === 'docs/assurance/omcc-cutover-scorecard.md' &&
      item.family === 'package-tag' &&
      item.literal === 'plugin-runtime-v0.97.1',
  );
  assert.ok(repeated.length >= 2, 'the pinned corpus control must exercise repeated lexemes');
  assert.equal(
    new Set(repeated.map((item) => `${item.start_byte}:${item.end_byte}`)).size,
    repeated.length,
  );
});

test('artifact passes the sealed schema and schema mutations fail for behavior-specific reasons', async () => {
  const { artifact } = await builtPromise;
  assert.deepEqual(validateAgainstSchema(artifact, schema), []);

  const missingRoot = deepClone(artifact);
  delete missingRoot.role;
  assert.ok(validateAgainstSchema(missingRoot, schema).some((error) => /missing required key role/u.test(error)));

  const extraRoot = deepClone(artifact);
  extraRoot.surprise = true;
  assert.ok(validateAgainstSchema(extraRoot, schema).some((error) => /additional property/u.test(error)));

  const nullRole = deepClone(artifact);
  const bound = nullRole.anchors.find((row) => row.disposition === 'bound');
  const roleName = Object.keys(bound.roles)[0];
  bound.roles[roleName] = null;
  assert.ok(validateAgainstSchema(nullRole, schema).some((error) => /expected type object/u.test(error)));

  const nestedParameter = deepClone(artifact);
  nestedParameter.policies[0].parameters.nested = { forbidden: true };
  assert.ok(validateAgainstSchema(nestedParameter, schema).some((error) => /expected type/u.test(error)));
});

test('every corpus span round-trips, every emitted path is verbatim, and every anchor is total exactly once', async () => {
  const { artifact, documents } = await builtPromise;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (const occurrence of artifact.occurrences) {
    assert.ok(!occurrence.path.startsWith('bundle/'));
    const bytes = documents.get(occurrence.path).bytes;
    assert.equal(
      decoder.decode(bytes.subarray(occurrence.start_byte, occurrence.end_byte)),
      occurrence.literal,
    );
  }

  for (const relation of registry.relations) {
    const expected = artifact.occurrences.filter(
      (item) =>
        item.profile === relation.anchor_domain.profile &&
        item.family === relation.anchor_domain.family,
    );
    const rows = artifact.anchors.filter((item) => item.relation === relation.id);
    assert.equal(rows.length, expected.length);
    assert.equal(
      new Set(rows.map((row) => `${row.anchor.path}:${row.anchor.start_byte}:${row.anchor.end_byte}`)).size,
      rows.length,
    );
  }
});

test('semantic validator rejects deleted coverage and each disposition/role contradiction', async () => {
  const built = await builtPromise;
  const context = {
    manifest: built.manifest,
    registry: built.registry,
    documents: built.documents,
    bundleDigest: built.bundleDigest,
  };
  assert.doesNotThrow(() => validateArtifactSemantics(built.artifact, context));

  const missingAnchor = deepClone(built.artifact);
  missingAnchor.anchors.pop();
  missingAnchor.attestation.artifact_digest = artifactDigest(missingAnchor);
  assert.throws(() => validateArtifactSemantics(missingAnchor, context), /missing anchor row|anchor total mismatch/u);

  const boundMissingRole = deepClone(built.artifact);
  const boundRow = boundMissingRole.anchors.find(
    (row) => row.relation === 'release-triple' && row.disposition === 'bound',
  );
  delete boundRow.roles.release_pr;
  boundMissingRole.attestation.artifact_digest = artifactDigest(boundMissingRole);
  assert.throws(() => validateArtifactSemantics(boundMissingRole, context), /bound row missing required role/u);

  const incompleteFilled = deepClone(built.artifact);
  const incompleteRow = incompleteFilled.anchors.find(
    (row) => row.relation === 'release-triple' && row.disposition === 'incomplete',
  );
  const pr = incompleteFilled.occurrences.find((item) => item.family === 'pr-citation');
  incompleteRow.roles.release_pr = {
    path: pr.path,
    blob: pr.blob,
    start_byte: pr.start_byte,
    end_byte: pr.end_byte,
  };
  incompleteFilled.attestation.artifact_digest = artifactDigest(incompleteFilled);
  assert.throws(() => validateArtifactSemantics(incompleteFilled, context), /incomplete row fills every required role/u);

  const falseNotClaim = deepClone(built.artifact);
  const notClaimRow = falseNotClaim.anchors.find(
    (row) => row.relation === 'release-triple' && row.disposition === 'not-a-claim',
  );
  notClaimRow.roles.release_pr = {
    path: pr.path,
    blob: pr.blob,
    start_byte: pr.start_byte,
    end_byte: pr.end_byte,
  };
  falseNotClaim.attestation.artifact_digest = artifactDigest(falseNotClaim);
  assert.throws(() => validateArtifactSemantics(falseNotClaim, context), /not-a-claim row fills a role/u);

  const repeatedAnchorRole = deepClone(built.artifact);
  const releaseRow = repeatedAnchorRole.anchors.find((row) => row.relation === 'release-triple');
  releaseRow.roles.tag = { ...releaseRow.anchor };
  repeatedAnchorRole.attestation.artifact_digest = artifactDigest(repeatedAnchorRole);
  assert.throws(() => validateArtifactSemantics(repeatedAnchorRole, context), /anchor role repeated/u);
});

test('the runnable exporter rewrites artifact.json and the written artifact validates', async () => {
  await run(process.execPath, ['out/exporter.mjs'], { cwd: fileURLToPath(workspace) });
  const written = JSON.parse(await readFile(new URL('artifact.json', import.meta.url), 'utf8'));
  assert.deepEqual(validateAgainstSchema(written, schema), []);
  assert.equal(written.role, 'lane');
  assert.equal(written.attestation.artifact_digest, artifactDigest(written));
});
