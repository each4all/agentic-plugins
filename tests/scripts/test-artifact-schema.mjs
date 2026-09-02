// Tests for the artifact wire schema (contract §3.8) and the subset validator.
//
// The validator's defining property is that it REFUSES what it cannot enforce.
// A subset validator that ignores unknown keywords is worse than no validator:
// a constraint written in the schema is enforced nowhere, and the schema reads
// as if it were. That property gets the first and longest test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compile, validate, SUPPORTED } from '../../scripts/json-schema-mini.mjs';
import { ARTIFACT_SCHEMA_PATH, BUNDLE_FILES, CONTRACT_VERSION } from '../../scripts/evidence-measurement.mjs';

const REPO = new URL('../../', import.meta.url).pathname;
const SCHEMA = JSON.parse(readFileSync(join(REPO, ARTIFACT_SCHEMA_PATH), 'utf8'));

const sha256 = (c) => c.repeat(64);
const sha1 = (c) => c.repeat(40);
const identity = (over = {}) => ({ path: 'docs/x.md', blob: sha1('b'), start_byte: 0, end_byte: 4, ...over });
const occurrence = (over = {}) => ({ profile: 'stage-docs', ...identity(), family: 'pr-citation', literal: '#100', ...over });
const policy = (over = {}) => ({
  relation: 'release-triple',
  anchor_domain: { family: 'package-tag', profile: 'stage-docs', restriction: null },
  class: 'annotation', parameters: {}, ranking: 'none', tie_policy: 'ambiguous', digest: sha256('a'), ...over,
});
const artifact = (over = {}) => ({
  schema: 'evidence-measurement-artifact-1.0',
  contract_version: CONTRACT_VERSION,
  role: 'lane',
  artifact_id: 'lane-1',
  bundle_digest: sha256('e'),
  manifest_digest: sha256('d'),
  corpus_commit: sha1('c'),
  policies: [policy()],
  occurrences: [occurrence()],
  anchors: [{ relation: 'release-triple', anchor: identity(), disposition: 'not-a-claim', roles: {} }],
  attestation: {
    contract_version: CONTRACT_VERSION, bundle_digest: sha256('e'), manifest_digest: sha256('d'),
    artifact_digest: sha256('f'), sealed_at: '2026-09-02T00:00:00Z', prohibited_inputs_accessed: [],
  },
  ...over,
});

const bad = (over) => validate(SCHEMA, artifact(over));
/** Actually REMOVE a key. `{k: undefined}` leaves the key present, so a missing-key
 *  case written that way is caught by `type`, not by `required` — which made a
 *  mutation disabling `required` pass. */
const without = (obj, ...keys) => { const c = { ...obj }; for (const k of keys) delete c[k]; return c; };

// --- the fail-closed property --------------------------------------------------

test('the validator REFUSES a keyword it cannot enforce, wherever it appears', () => {
  // The whole argument for a hand-rolled subset rests on this. Each location is
  // checked separately: a compile that recursed into `properties` but not into
  // `$defs` would pass a schema whose real constraints live in `$defs`.
  const places = [
    ['top level', { type: 'object', oneOf: [{ type: 'string' }] }],
    ['a property', { type: 'object', properties: { x: { anyOf: [{ type: 'string' }] } } }],
    ['a $def', { type: 'object', $defs: { d: { not: { type: 'string' } } } }],
    ['items', { type: 'array', items: { maxLength: 3 } } ],
    ['additionalProperties', { type: 'object', additionalProperties: { multipleOf: 2 } }],
  ];
  for (const [where, schema] of places) {
    assert.throws(() => compile(schema), /is not supported by this validator/, `unknown keyword in ${where} was accepted`);
  }
  // Control: the same shapes with SUPPORTED keywords compile.
  assert.doesNotThrow(() => compile({ type: 'object', properties: { x: { type: 'string' } }, $defs: { d: { type: 'string' } } }));
});

test('the refusal names the keyword and where it was found', () => {
  try {
    compile({ type: 'object', $defs: { role: { oneOf: [] } } });
    assert.fail('expected a refusal');
  } catch (err) {
    assert.match(err.message, /"oneOf"/);
    assert.match(err.message, /\$defs\/role/);
    assert.match(err.message, /enforced nowhere/);
  }
});

test('a $ref with siblings is refused rather than half-applied', () => {
  const schema = { $defs: { id: { type: 'object' } }, type: 'object', properties: { a: { $ref: '#/$defs/id', minLength: 3 } } };
  assert.throws(() => validate(schema, { a: {} }), /sibling keyword/);
});

test('only local $defs references are supported', () => {
  assert.throws(() => compile({ $ref: 'https://example.invalid/x.json' }), /only local/);
  assert.throws(() => compile({ $ref: '#/definitions/x' }), /only local/);
});

test('the shipped schema is inside the supported vocabulary', () => {
  assert.doesNotThrow(() => compile(SCHEMA));
  const used = new Set();
  (function walk(node, inSchema) {
    if (Array.isArray(node)) return;
    if (!node || typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (inSchema) used.add(k);
      if (k === 'properties' || k === '$defs') for (const sub of Object.values(v)) walk(sub, true);
      else if (k === 'items' || k === 'additionalProperties') { if (typeof v === 'object') walk(v, true); }
    }
  })(SCHEMA, true);
  assert.ok(used.size > 8, `only ${used.size} keywords seen; the walker has drifted`);
  for (const k of used) assert.ok(SUPPORTED.has(k), `the schema uses ${k}, which the validator does not implement`);
});

// --- the validator's assertions actually assert ------------------------------

test('each supported assertion rejects and accepts', () => {
  const cases = [
    [{ type: 'integer' }, 3, 3.5],
    [{ type: ['string', 'null'] }, null, 7],
    [{ type: 'number' }, 3, 'x'],
    [{ enum: ['a', 'b'] }, 'a', 'c'],
    [{ const: 5 }, 5, 6],
    [{ type: 'string', pattern: '^[0-9]+$' }, '12', '1a'],
    [{ type: 'string', minLength: 2 }, 'ab', 'a'],
    [{ type: 'integer', minimum: 1 }, 1, 0],
  ];
  for (const [schema, ok, no] of cases) {
    assert.deepEqual(validate(schema, ok), [], `${JSON.stringify(schema)} rejected a valid value`);
    assert.equal(validate(schema, no).length > 0, true, `${JSON.stringify(schema)} accepted ${JSON.stringify(no)}`);
  }
  // `integer` is a `number`; nothing else widens.
  assert.deepEqual(validate({ type: 'number' }, 4), []);
  assert.ok(validate({ type: 'integer' }, 4.5).length > 0);
});

test('additionalProperties works as both a boolean and a schema', () => {
  assert.ok(validate({ type: 'object', properties: {}, additionalProperties: false }, { x: 1 }).length > 0);
  assert.deepEqual(validate({ type: 'object', additionalProperties: { type: 'string' } }, { x: 'a', y: 'b' }), []);
  assert.ok(validate({ type: 'object', additionalProperties: { type: 'string' } }, { x: 1 }).length > 0);
});

test('a type mismatch does not cascade into unrelated assertions', () => {
  // The assertions have to be ones that WOULD fire on the wrong value, or the
  // test passes whether or not the early return exists: `pattern` and
  // `minLength` are already guarded by `typeof value === 'string'`, so pairing
  // them with a number proves nothing. `minimum` on a number and `required` on
  // an object do fire, and are what this pins.
  const numeric = validate({ type: 'string', minimum: 5 }, 3);
  assert.equal(numeric.length, 1, JSON.stringify(numeric));
  assert.match(numeric[0].detail, /is integer, expected string/);

  const objectish = validate({ type: 'string', required: ['a'], properties: {}, additionalProperties: false }, { b: 1 });
  assert.equal(objectish.length, 1, JSON.stringify(objectish));
  assert.match(objectish[0].detail, /is object, expected string/);

  // Control: with the type SATISFIED, the same assertions do fire.
  assert.equal(validate({ type: 'number', minimum: 5 }, 3).length, 1);
  assert.ok(validate({ type: 'object', required: ['a'], properties: {}, additionalProperties: false }, { b: 1 }).length >= 2);
});

// --- the artifact schema says what the contract says --------------------------

test('a well-formed artifact validates', () => {
  assert.deepEqual(validate(SCHEMA, artifact()), []);
});

test('the schema rejects each malformation the contract names', () => {
  const rejects = [
    ['a role outside the vocabulary', { role: 'auditor' }],
    ['a digest that is not sha-256', { bundle_digest: 'abc' }],
    ['a corpus commit that is not an object name', { corpus_commit: 'c0ffee' }],
    ['an attestation key that is present but empty', { attestation: {} }],
    ['an unknown top-level property', { surprise: 1 }],
    ['a disposition outside §4.3', { anchors: [{ relation: 'r', anchor: identity(), disposition: 'maybe', roles: {} }] }],
    ['a null role binding (§3.8: absent, never null)', { anchors: [{ relation: 'r', anchor: identity(), disposition: 'bound', roles: { tag: null } }] }],
    ['a non-scalar policy parameter', { policies: [policy({ parameters: { nested: { a: 1 } } })] }],
    ['a tie_policy outside §4.5', { policies: [policy({ tie_policy: 'sometimes' })] }],
    ['a field value that is not a {state} object', { occurrences: [occurrence({ fields: { kind: 'doctor' } })] }],
    ['a field state outside §6', { occurrences: [occurrence({ fields: { kind: { state: 'maybe' } } })] }],
    ['an identity carrying an unknown key', { anchors: [{ relation: 'r', anchor: identity({ nickname: 'x' }), disposition: 'not-a-claim', roles: {} }] }],
    ['a non-integer span', { occurrences: [occurrence({ start_byte: 1.5 })] }],
    ['a negative span', { occurrences: [occurrence({ start_byte: -1 })] }],
    ['a sealed_at that is not an instant', { attestation: { ...artifact().attestation, sealed_at: '2026-09-02' } }],
    ['an attestation with no prohibited-inputs list', { attestation: without(artifact().attestation, 'prohibited_inputs_accessed') }],
  ];
  for (const [label, over] of rejects) {
    const findings = bad(over);
    assert.ok(findings.length > 0, `the schema accepted: ${label}`);
  }
});

test('§8.2 — a genuinely ABSENT required key is a finding, not a silence', () => {
  // Each of these deletes the key rather than setting it to undefined, so the
  // `required` assertion is what has to catch it.
  for (const key of SCHEMA.required) {
    const findings = validate(SCHEMA, without(artifact(), key));
    assert.ok(findings.some((f) => f.path === `$.${key}` && /required and missing/.test(f.detail)),
      `deleting ${key} produced ${JSON.stringify(findings)}`);
  }
  // Nested, too: the attestation's own required set.
  for (const key of SCHEMA.$defs.attestation.required) {
    const a = artifact();
    const findings = validate(SCHEMA, { ...a, attestation: without(a.attestation, key) });
    assert.ok(findings.some((f) => /required and missing/.test(f.detail)), `deleting attestation.${key} produced nothing`);
  }
});

test('the schema accepts what the contract permits as optional', () => {
  assert.deepEqual(validate(SCHEMA, artifact({ occurrences: [occurrence({ quoted_context: 'sha aaaaaaa then', line: 3, column: 9 })] })), []);
  assert.deepEqual(validate(SCHEMA, artifact({ occurrences: [occurrence({ fields: { kind: { state: 'present', value: 'doctor' } } })] })), []);
  assert.deepEqual(validate(SCHEMA, artifact({ occurrences: [occurrence({ fields: { x: { state: 'not-applicable' } } })] })), []);
  assert.deepEqual(validate(SCHEMA, artifact({ anchors: [{ relation: 'r', anchor: identity(), disposition: 'bound', roles: { tag: identity() }, qualifiers: ['artifact-only'], provenance: 'annotated by hand, adjudicated' }] })), []);
  // §4.2 — `class` is free text. An enum here would restore the removed vocabulary.
  for (const cls of ['annotation', 'construction-grammar', 'proximity', 'something-nobody-has-named-yet']) {
    assert.deepEqual(validate(SCHEMA, artifact({ policies: [policy({ class: cls })] })), [], `class ${cls} was rejected`);
  }
});

test('§3.8/§11.3 — the schema is a sealed bundle member', () => {
  assert.ok(BUNDLE_FILES.includes(ARTIFACT_SCHEMA_PATH), 'the schema must be sealed with the other shared inputs');
  assert.equal(BUNDLE_FILES.length, 4);
});
