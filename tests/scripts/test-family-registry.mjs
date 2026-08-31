// Tests for the measurement contract's family-registry gate.
//
// Every negative case below is a MUTATION of the shipped registry: the shipped
// bytes are read, one field is broken, and the check must produce a finding
// naming that field. A test that asserted only "the shipped registry passes"
// would stay green if every check were deleted, which is the shape of vacuous
// coverage this repository has shipped before.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { checkRegistry, REGISTRY_PATH, CONTRACT_POLICY_KEYS, CONTRACT_DISPOSITIONS } from '../../scripts/check-family-registry.mjs';

const REPO = new URL('../../', import.meta.url).pathname;
const SHIPPED = JSON.parse(readFileSync(join(REPO, REGISTRY_PATH), 'utf8'));

/** Write a mutated registry into a scratch repo root and check it there. */
function checkMutated(mutate) {
  const root = mkdtempSync(join(tmpdir(), 'family-registry-'));
  try {
    const reg = JSON.parse(JSON.stringify(SHIPPED));
    mutate(reg);
    const dest = join(root, REGISTRY_PATH);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, JSON.stringify(reg, null, 2), 'utf8');
    return checkRegistry(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const paths = (r) => r.findings.map((f) => f.path);
const hits = (r, needle) => r.findings.filter((f) => f.path.includes(needle) || f.detail.includes(needle));

test('the shipped registry passes', () => {
  const r = checkRegistry(REPO);
  assert.equal(r.ran, true);
  assert.deepEqual(r.findings, [], `unexpected findings: ${JSON.stringify(r.findings, null, 2)}`);
  assert.ok(r.families > 0 && r.relations > 0);
});

test('an unreadable registry is NOT RUN, not a silent pass', () => {
  const root = mkdtempSync(join(tmpdir(), 'family-registry-'));
  try {
    const r = checkRegistry(root);
    assert.equal(r.ran, false);
    assert.match(r.reason, /unreadable/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// --- §4.5 the binding block is validated for SHAPE ---------------------------

test('binding as a 1.x rule-name string is rejected and names the shape change', () => {
  const r = checkMutated((reg) => { reg.relations[0].binding = 'minimal-span'; });
  const f = hits(r, 'binding');
  assert.ok(f.length > 0, `expected a binding finding, got ${JSON.stringify(paths(r))}`);
  assert.match(f[0].detail, /1\.x shape/);
  assert.match(f[0].detail, /fixes no rule/);
});

test('a missing binding block is a finding', () => {
  const r = checkMutated((reg) => { delete reg.relations[0].binding; });
  assert.ok(hits(r, 'binding').length > 0);
});

test('declared_by must name the lane', () => {
  const r = checkMutated((reg) => { reg.relations[0].binding.declared_by = 'contract'; });
  assert.ok(hits(r, 'declared_by').length > 0);
});

test('dropping any contract-required declaration key is a finding', () => {
  for (const key of CONTRACT_POLICY_KEYS) {
    const r = checkMutated((reg) => {
      reg.relations[0].binding.declaration_keys = reg.relations[0].binding.declaration_keys.filter((k) => k !== key);
    });
    const f = hits(r, 'declaration_keys');
    assert.ok(f.length > 0, `dropping ${key} produced no finding`);
    assert.match(f[0].detail, new RegExp(key));
  }
});

test('duplicate declaration keys are a finding', () => {
  const r = checkMutated((reg) => { reg.relations[0].binding.declaration_keys.push('class'); });
  assert.ok(hits(r, 'duplicate').length > 0);
});

test('the gate holds NO allow-list: extra declaration keys and exotic values pass', () => {
  // This is the property §4.2 depends on. An allow-list here would restore the
  // fixed association vocabulary the contract removed, without a version bump.
  const r = checkMutated((reg) => {
    reg.relations[0].binding.declaration_keys.push('window_bytes', 'grammar_digest');
    reg.relations[0].binding.note = `${reg.relations[0].binding.note} Extra keys are permitted.`;
  });
  assert.deepEqual(r.findings, [], JSON.stringify(r.findings, null, 2));
});

// --- §4.1 the anchor domain is declared, not inferred ------------------------

test('a missing anchor_domain is a finding', () => {
  const r = checkMutated((reg) => { delete reg.relations[0].anchor_domain; });
  assert.ok(hits(r, 'anchor_domain').length > 0);
});

test('an omitted restriction is a finding — null must be written', () => {
  const r = checkMutated((reg) => { delete reg.relations[0].anchor_domain.restriction; });
  const f = hits(r, 'restriction');
  assert.ok(f.length > 0);
  assert.match(f[0].detail, /write null/);
});

test('an anchor_domain family that is not the anchor role\'s family is a finding', () => {
  const r = checkMutated((reg) => { reg.relations[0].anchor_domain.family = 'pr-citation'; });
  assert.ok(hits(r, 'anchor_domain.family').length > 0);
});

test('an anchor_domain profile that differs from the relation profile is a finding', () => {
  const r = checkMutated((reg) => { reg.relations[0].anchor_domain.profile = 'discovered-md'; });
  assert.ok(hits(r, 'anchor_domain.profile').length > 0);
});

test('a non-null restriction must be stated in full, not as a token', () => {
  const r = checkMutated((reg) => { reg.relations[0].anchor_domain.restriction = 'runtime'; });
  assert.ok(hits(r, 'restriction').length > 0);
});

// --- §4.1 role/family collisions must be acknowledged ------------------------

test('an unacknowledged role-family collision is a finding', () => {
  const r = checkMutated((reg) => { reg.relations[0].role_family_collisions = []; });
  const f = hits(r, 'role_family_collisions');
  assert.ok(f.length > 0);
  assert.match(f[0].detail, /unacknowledged/);
});

test('an acknowledgement that omits a colliding role is a finding', () => {
  const r = checkMutated((reg) => { reg.relations[0].role_family_collisions[0].roles = ['squash']; });
  assert.ok(hits(r, 'omits role').length > 0);
});

test('an acknowledgement of a collision that does not exist is a finding', () => {
  const r = checkMutated((reg) => {
    reg.relations[1].role_family_collisions = [{ family: 'iso-date', roles: ['date'], note: 'a collision that is not real at all' }];
  });
  assert.ok(hits(r, 'does not exist').length > 0);
});

test('a missing role_family_collisions array is a finding — [] must be written', () => {
  const r = checkMutated((reg) => { delete reg.relations[1].role_family_collisions; });
  assert.ok(hits(r, 'role_family_collisions').length > 0);
});

// --- §2.2 the two halves of the profile rule ---------------------------------

test('a family bound to more than one profile is legal (§2.2 half one)', () => {
  const r = checkRegistry(REPO);
  const multi = SHIPPED.families.filter((f) => f.profiles.length > 1);
  assert.ok(multi.length > 0, 'fixture no longer exercises the multi-profile family case');
  assert.deepEqual(r.findings, []);
});

test('a relation given an array of profiles is a finding (§2.2 half two)', () => {
  const r = checkMutated((reg) => { reg.relations[0].profile = ['stage-docs', 'discovered-md']; });
  const f = hits(r, 'profile');
  assert.ok(f.length > 0);
  assert.match(f[0].detail, /exactly one/);
});

test('a role whose family is not bound to the relation profile is a finding (§4.1)', () => {
  const r = checkMutated((reg) => {
    const fam = reg.families.find((f) => f.id === 'pr-citation');
    fam.profiles = ['discovered-md'];
  });
  assert.ok(hits(r, 'cross-profile').length > 0);
});

// --- §4.3 the disposition vocabulary is closed -------------------------------

test('the four dispositions are gated against the contract list', () => {
  for (const d of CONTRACT_DISPOSITIONS) {
    const r = checkMutated((reg) => { reg.dispositions = reg.dispositions.filter((x) => x !== d); });
    assert.ok(hits(r, 'dispositions').length > 0, `dropping ${d} produced no finding`);
  }
  const renamed = checkMutated((reg) => { reg.dispositions = ['bound', 'no-claim', 'ambiguous', 'incomplete']; });
  assert.ok(hits(renamed, 'dispositions').length > 0);
});

test('a missing dispositions list is a finding', () => {
  const r = checkMutated((reg) => { delete reg.dispositions; });
  assert.ok(hits(r, 'dispositions').length > 0);
});

// --- carried-over checks still bite -----------------------------------------

test('a family without a unit is a finding', () => {
  const r = checkMutated((reg) => { delete reg.families[0].unit; });
  assert.ok(hits(r, '.unit').length > 0);
});

test('a duplicate family id is a finding', () => {
  const r = checkMutated((reg) => { reg.families.push(JSON.parse(JSON.stringify(reg.families[0]))); });
  assert.ok(hits(r, 'duplicate family id').length > 0);
});

test('an expected_zero for a pair the family is not bound to is a finding', () => {
  const r = checkMutated((reg) => {
    const fam = reg.families.find((f) => f.id === 'bare-semver');
    fam.profiles = ['discovered-md'];
    reg.expected_zero = [{ family: 'bare-semver', profile: 'stage-docs', reason: 'a reason long enough to pass the length floor' }];
  });
  assert.ok(hits(r, 'expected zero').length > 0);
});

test('a field state outside field_states is a finding', () => {
  const r = checkMutated((reg) => { reg.families[0].fields[0].states = ['invented']; });
  assert.ok(hits(r, 'outside field_states').length > 0);
});
