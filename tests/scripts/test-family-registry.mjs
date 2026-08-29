// Tests for the family registry gate (scripts/check-family-registry.mjs).
//
// Every mutation below reproduces a defect that actually shipped: the registry
// landed with no validator at all, and a cross-host review found three real
// faults in it by inspection. Each case therefore has a known-failing ancestor.

import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { REGISTRY_PATH, PROFILES, checkRegistry } from '../../scripts/check-family-registry.mjs';

const REPO_ROOT = resolve(fileURLToPath(import.meta.url), '../../..');
const base = () => JSON.parse(readFileSync(resolve(REPO_ROOT, REGISTRY_PATH), 'utf8'));

function withRegistry(mutate) {
  const dir = mkdtempSync(join(tmpdir(), 'family-registry-'));
  try {
    const reg = base();
    mutate(reg);
    const target = join(dir, REGISTRY_PATH);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `${JSON.stringify(reg, null, 2)}\n`);
    return checkRegistry(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the committed registry passes', () => {
  const r = checkRegistry(REPO_ROOT);
  assert.equal(r.ran, true, r.reason ?? '');
  assert.deepEqual(r.findings, [], 'the committed registry must be clean');
  // Non-vacuity: a registry that declared nothing would satisfy every mutation
  // test below against a validator that rejected everything.
  assert.ok(r.families > 0 && r.relations > 0, 'the registry must declare families and relations');
});

test('an unreadable registry fails closed rather than passing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'family-registry-'));
  try {
    const r = checkRegistry(dir);
    assert.equal(r.ran, false, 'a missing registry must not report a clean run');
    assert.deepEqual(r.findings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const MUTATIONS = [
  // The three faults the cross-host review found in the shipped registry.
  ['a relation role bound outside its own profile',
    (r) => { r.families.find((f) => f.id === 'commit-citation').profiles = ['discovered-md']; },
    /cross-profile role/],
  ['a family with no unit',
    (r) => { for (const f of r.families) delete f.unit; },
    /unit/],
  ['an expected zero for a pair the family is not bound to',
    (r) => {
      r.families.find((f) => f.id === 'content-digest').profiles = ['discovered-md'];
      r.expected_zero = [{ family: 'content-digest', profile: 'stage-docs', reason: 'a reason long enough to pass the length rule' }];
    },
    /not bound to that profile/],

  // Structural faults that would turn a whole run not-comparable under §8.2.
  ['a role naming an unknown family', (r) => { r.relations[0].roles[0].family = 'packge-tag'; }, /unknown family/],
  ['a duplicate family id', (r) => { r.families.push({ ...r.families[0] }); }, /duplicate family id/],
  ['a duplicate relation id', (r) => { r.relations.push({ ...r.relations[0] }); }, /duplicate relation id/],
  ['an anchor_role naming no role', (r) => { r.relations[0].anchor_role = 'nope'; }, /names no role/],
  ['a field state outside field_states', (r) => { r.families[0].fields[0].states = ['bogus']; }, /outside field_states/],
  ['a family with no recognition rule', (r) => { delete r.families[0].recognition; }, /lexical observable/],
  ['a family with no fields', (r) => { r.families[0].fields = []; }, /declares no fields/],
  ['an unknown profile on a family', (r) => { r.families[0].profiles = ['nope']; }, /unknown profile/],
  ['a relation with no roles', (r) => { r.relations[0].roles = []; }, /declares no roles/],
  ['a missing schema id', (r) => { delete r.schema; }, /evidence-measurement-families/],
  ['a non-boolean required flag', (r) => { r.families[0].required = 'yes'; }, /not a boolean/],
];

for (const [label, mutate, pattern] of MUTATIONS) {
  test(`registry gate rejects: ${label}`, () => {
    const r = withRegistry(mutate);
    assert.equal(r.ran, true);
    assert.ok(
      r.findings.some((f) => pattern.test(f.detail)),
      `${label}: no finding matched ${pattern}; got ${JSON.stringify(r.findings)}`,
    );
  });
}

test('every relation role resolves to a family bound to that relation profile', () => {
  // The invariant contract §4.1 states, asserted directly against the real
  // registry rather than only through a mutation.
  const reg = base();
  const profilesOf = new Map(reg.families.map((f) => [f.id, f.profiles]));
  for (const rel of reg.relations) {
    assert.ok(PROFILES.includes(rel.profile), `${rel.id} declares an unknown profile`);
    for (const role of rel.roles) {
      const p = profilesOf.get(role.family);
      assert.ok(p, `${rel.id}.${role.name} names unknown family ${role.family}`);
      assert.ok(p.includes(rel.profile), `${rel.id}.${role.name} is bound to ${JSON.stringify(p)} but the relation is ${rel.profile}`);
    }
  }
});
