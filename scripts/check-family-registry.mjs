#!/usr/bin/env node
// Gate for the measurement contract's family registry.
//
// The registry fixes what the exporter and the pairing oracle are allowed to
// measure and, since contract 2.0.0, WHICH ANCHOR POPULATION they measure it
// over (§4.1). Nothing read it when it first landed, and a cross-host review
// found three defects that had shipped silently as a result: two roles of a
// `stage-docs` relation bound to a family declared only for `discovered-md`,
// no family declaring the `unit` §3.4 requires, and an `expected_zero` entry
// the corpus falsifies. Each of those is decidable by inspection, which is
// exactly why a check should have been deciding it.
//
// The stakes are asymmetric. Contract §8.2 makes "an occurrence whose family is
// not in the registry" a structural error, so a single typo'd family id turns a
// whole comparison `not-comparable` — a run that never happens rather than a run
// that fails. This file is read-only and asserts nothing about the corpus.
//
// WHAT THIS CHECK DELIBERATELY DOES NOT DO, and why it is worth a paragraph:
// contract 2.0.0 removed the normative association rule (§4.2). A 1.x registry
// carried `"binding": "minimal-span"` on each relation, and the obvious shape
// for a gate is an allow-list of rule names. That would restore the fixed
// vocabulary §4.2 removed, by the back door and without a version bump. So the
// binding block is validated for SHAPE ONLY — that it declares a lane
// obligation and names the keys the lane's declaration must carry — and no
// `class`, `ranking` or `parameters` value is ever checked against a list.
//
// Usage:  node scripts/check-family-registry.mjs [--json]
// Exit:   0 — no findings;  1 — findings

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REGISTRY_PATH = 'docs/assurance/evidence/measurement/family-registry.json';
export const PROFILES = Object.freeze(['stage-docs', 'discovered-md']);

/** Contract §4.3 — the four dispositions, total and mutually exclusive. */
export const CONTRACT_DISPOSITIONS = Object.freeze(['bound', 'not-a-claim', 'ambiguous', 'incomplete']);

/**
 * Contract §4.5 — the FLOOR of keys a lane's policy declaration must carry.
 *
 * The registry names the actual key list per relation, and the comparator reads
 * it from there rather than from here, so there is one authoritative list per
 * role: the contract's minimum lives in this gate, the operative list lives in
 * the registry. A registry may add keys; it may not drop one of these.
 */
export const CONTRACT_POLICY_KEYS = Object.freeze([
  'relation', 'anchor_domain', 'class', 'parameters', 'ranking', 'tie_policy', 'digest',
]);

export function checkRegistry(repoRoot) {
  const findings = [];
  const at = (path, detail) => findings.push({ check: 'registry', path, detail });

  let reg;
  try {
    reg = JSON.parse(readFileSync(resolve(repoRoot, REGISTRY_PATH), 'utf8'));
  } catch (err) {
    return { ran: false, reason: `${REGISTRY_PATH} is unreadable: ${err.message}`, findings: [], families: 0, relations: 0 };
  }

  if (typeof reg.schema !== 'string' || !reg.schema.startsWith('evidence-measurement-families-')) {
    at('schema', `is ${JSON.stringify(reg.schema)}, expected an evidence-measurement-families-* id`);
  }
  if (typeof reg.contract_version !== 'string' || !/^\d+\.\d+\.\d+$/.test(reg.contract_version)) {
    at('contract_version', 'is missing or is not a semver string');
  }

  const states = Array.isArray(reg.field_states) ? reg.field_states : [];
  if (states.length === 0) at('field_states', 'is missing; §6 field states must be enumerated');
  const units = Array.isArray(reg.units) ? reg.units : [];
  if (units.length === 0) at('units', 'is missing; §3.4 requires each family to declare a unit from a closed set');

  // §4.3 — the disposition vocabulary is total and closed. Unlike `class`, this
  // one IS gated against a list: the four are fixed by the contract, and a
  // registry that renamed or dropped one would make the comparator's status
  // table (§7.2) non-total without any file disagreeing with another.
  const dispositions = Array.isArray(reg.dispositions) ? reg.dispositions : null;
  if (!dispositions) {
    at('dispositions', 'is missing; §4.3 requires the four dispositions to be declared');
  } else {
    const got = [...dispositions].sort().join(',');
    const want = [...CONTRACT_DISPOSITIONS].sort().join(',');
    if (got !== want) at('dispositions', `is ${JSON.stringify(dispositions)}, expected exactly ${JSON.stringify(CONTRACT_DISPOSITIONS)} (§4.3)`);
  }

  const families = Array.isArray(reg.families) ? reg.families : [];
  const relations = Array.isArray(reg.relations) ? reg.relations : [];
  if (families.length === 0) at('families', 'is empty; a registry that declares nothing makes every comparison vacuous');

  const byId = new Map();
  for (const [i, f] of families.entries()) {
    const p = `families[${i}]`;
    if (typeof f.id !== 'string' || !f.id) { at(p, 'has no id'); continue; }
    if (byId.has(f.id)) at(`${p}.id`, `duplicate family id ${f.id}`);
    byId.set(f.id, f);
    const q = `families.${f.id}`;

    // §3.4 enumerates unit alongside cardinality, so cardinality is not a stand-in.
    if (!units.includes(f.unit)) at(`${q}.unit`, `unit ${JSON.stringify(f.unit)} is not one of ${JSON.stringify(units)} (§3.4)`);
    // §2.2 half one — a FAMILY takes one or more profiles.
    if (!Array.isArray(f.profiles) || f.profiles.length === 0) at(`${q}.profiles`, 'declares no profiles (§2.2 binds a family to one or more)');
    else for (const prof of f.profiles) if (!PROFILES.includes(prof)) at(`${q}.profiles`, `unknown profile ${JSON.stringify(prof)}`);
    if (typeof f.required !== 'boolean') at(`${q}.required`, 'is missing or not a boolean (§8.1 reads it)');
    if (typeof f.cardinality !== 'string') at(`${q}.cardinality`, 'is missing');
    if (typeof f.recognition !== 'string' || f.recognition.length < 20) {
      at(`${q}.recognition`, 'is missing or too short to be a lexical observable (§3.4)');
    }
    const fields = Array.isArray(f.fields) ? f.fields : [];
    if (fields.length === 0) at(`${q}.fields`, 'declares no fields');
    const seenField = new Set();
    for (const fld of fields) {
      if (typeof fld?.name !== 'string') { at(`${q}.fields`, 'a field has no name'); continue; }
      if (seenField.has(fld.name)) at(`${q}.fields.${fld.name}`, 'duplicate field name');
      seenField.add(fld.name);
      const st = Array.isArray(fld.states) ? fld.states : [];
      if (st.length === 0) at(`${q}.fields.${fld.name}.states`, 'declares no states');
      for (const one of st) if (!states.includes(one)) at(`${q}.fields.${fld.name}.states`, `state ${JSON.stringify(one)} is outside field_states`);
    }
  }

  const relIds = new Set();
  for (const [i, r] of relations.entries()) {
    const p = `relations[${i}]`;
    if (typeof r.id !== 'string' || !r.id) { at(p, 'has no id'); continue; }
    if (relIds.has(r.id)) at(`${p}.id`, `duplicate relation id ${r.id}`);
    relIds.add(r.id);
    const q = `relations.${r.id}`;

    if (!units.includes(r.unit)) at(`${q}.unit`, `unit ${JSON.stringify(r.unit)} is not one of ${JSON.stringify(units)}`);
    // §2.2 half two — a RELATION takes exactly one profile. A registry that
    // handed a relation an array would make membership ambiguous, which is the
    // disagreement §2.2 exists to prevent.
    if (typeof r.profile !== 'string' || !PROFILES.includes(r.profile)) {
      at(`${q}.profile`, `must be exactly one known profile (§2.2), got ${JSON.stringify(r.profile)}`);
      continue;
    }
    if (typeof r.required !== 'boolean') at(`${q}.required`, 'is missing or not a boolean');

    const roles = Array.isArray(r.roles) ? r.roles : [];
    if (roles.length === 0) { at(`${q}.roles`, 'declares no roles'); continue; }
    const roleNames = new Set(roles.map((x) => x?.name));
    if (!roleNames.has(r.anchor_role)) at(`${q}.anchor_role`, `${JSON.stringify(r.anchor_role)} names no role of this relation (§4.1)`);

    const familyToRoles = new Map();
    for (const role of roles) {
      if (typeof role?.name !== 'string') { at(`${q}.roles`, 'a role has no name'); continue; }
      const rq = `${q}.roles.${role.name}`;
      if (typeof role.required !== 'boolean') at(`${rq}.required`, 'is missing or not a boolean');
      const fam = byId.get(role.family);
      if (!fam) { at(`${rq}.family`, `references unknown family ${JSON.stringify(role.family)}`); continue; }
      if (!familyToRoles.has(role.family)) familyToRoles.set(role.family, []);
      familyToRoles.get(role.family).push(role.name);
      // §4.1 — a relation cannot reference an occurrence its profile does not contain.
      if (!Array.isArray(fam.profiles) || !fam.profiles.includes(r.profile)) {
        at(`${rq}.family`, `family ${role.family} is bound to ${JSON.stringify(fam.profiles)} but this relation is ${r.profile} (§4.1 cross-profile role)`);
      }
    }

    checkAnchorDomain(r, q, byId, at);
    checkBinding(r, q, at);
    checkRoleFamilyCollisions(r, q, familyToRoles, at);
  }

  for (const [i, z] of (Array.isArray(reg.expected_zero) ? reg.expected_zero : []).entries()) {
    const q = `expected_zero[${i}]`;
    const fam = byId.get(z?.family);
    if (!fam) { at(`${q}.family`, `references unknown family ${JSON.stringify(z?.family)}`); continue; }
    if (!PROFILES.includes(z.profile)) { at(`${q}.profile`, `unknown profile ${JSON.stringify(z.profile)}`); continue; }
    // Declaring a zero for a pair the family is not even bound to is not a
    // statement about the corpus; it is a statement about nothing.
    if (!fam.profiles.includes(z.profile)) {
      at(`${q}`, `declares an expected zero for (${z.family}, ${z.profile}) but that family is not bound to that profile`);
    }
    if (typeof z.reason !== 'string' || z.reason.length < 20) at(`${q}.reason`, 'an expected zero must carry a reason (§3.4)');
  }

  return { ran: true, reason: null, findings, families: families.length, relations: relations.length };
}

/**
 * Contract §4.1 — the anchor domain is declared, not inferred.
 *
 * The failure this catches is not a typo. A relation whose domain is left to
 * inference lets one author measure a whole family and another a single token
 * kind inside it, and every recall ratio computed from the two is about a
 * different denominator while looking comparable.
 */
function checkAnchorDomain(r, q, byId, at) {
  const dom = r.anchor_domain;
  if (!dom || typeof dom !== 'object' || Array.isArray(dom)) {
    at(`${q}.anchor_domain`, 'is missing; §4.1 requires each relation to declare the anchor population it is measured over');
    return;
  }
  const fam = byId.get(dom.family);
  if (!fam) {
    at(`${q}.anchor_domain.family`, `references unknown family ${JSON.stringify(dom.family)}`);
  } else {
    const anchorRole = (Array.isArray(r.roles) ? r.roles : []).find((x) => x?.name === r.anchor_role);
    if (anchorRole && anchorRole.family !== dom.family) {
      at(`${q}.anchor_domain.family`, `is ${JSON.stringify(dom.family)} but the anchor role ${JSON.stringify(r.anchor_role)} is family ${JSON.stringify(anchorRole.family)} (§4.1)`);
    }
    if (Array.isArray(fam.profiles) && !fam.profiles.includes(dom.profile)) {
      at(`${q}.anchor_domain.profile`, `is ${JSON.stringify(dom.profile)} but family ${dom.family} is bound to ${JSON.stringify(fam.profiles)}`);
    }
  }
  if (dom.profile !== r.profile) {
    at(`${q}.anchor_domain.profile`, `is ${JSON.stringify(dom.profile)} but the relation's profile is ${JSON.stringify(r.profile)} (§2.2)`);
  }
  // `null` is the whole family and must be written, not omitted: an absent key
  // and a deliberate "no restriction" are the same bytes to a reader and
  // different intents to an author.
  if (!('restriction' in dom)) {
    at(`${q}.anchor_domain.restriction`, 'is absent; write null for the whole family (§4.1 — a domain left to inference is the failure the clause prevents)');
  } else if (dom.restriction !== null && (typeof dom.restriction !== 'string' || dom.restriction.length < 20)) {
    at(`${q}.anchor_domain.restriction`, 'must be null or a lexical observable stated in full (§4.1)');
  }
}

/**
 * Contract §4.5 — validate the SHAPE of the lane's policy obligation.
 *
 * Shape only. See this file's header for why an allow-list of `class` values is
 * the one thing this check must never grow.
 */
function checkBinding(r, q, at) {
  const b = r.binding;
  if (typeof b === 'string') {
    at(`${q}.binding`, `is the string ${JSON.stringify(b)} — the 1.x shape, which named one association rule for both lanes. Contract 2.0.0 §4.2 fixes no rule; replace it with a declaration-shape object (§4.5).`);
    return;
  }
  if (!b || typeof b !== 'object' || Array.isArray(b)) {
    at(`${q}.binding`, 'is missing; §4.5 requires each relation to declare the shape of the policy declaration its lanes must emit');
    return;
  }
  if (b.declared_by !== 'lane') {
    at(`${q}.binding.declared_by`, `is ${JSON.stringify(b.declared_by)}, expected "lane" — §4.2 leaves association to the lane and §4.5 makes it declare what it did`);
  }
  const keys = Array.isArray(b.declaration_keys) ? b.declaration_keys : null;
  if (!keys || keys.length === 0) {
    at(`${q}.binding.declaration_keys`, 'is missing or empty; §4.5 fixes the declaration shape');
    return;
  }
  if (keys.some((k) => typeof k !== 'string')) {
    at(`${q}.binding.declaration_keys`, 'must be an array of strings');
    return;
  }
  const missing = CONTRACT_POLICY_KEYS.filter((k) => !keys.includes(k));
  if (missing.length > 0) {
    at(`${q}.binding.declaration_keys`, `omits contract-required key(s) ${JSON.stringify(missing)} (§4.5). A registry may add keys; it may not drop one of ${JSON.stringify(CONTRACT_POLICY_KEYS)}.`);
  }
  const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
  if (dupes.length > 0) at(`${q}.binding.declaration_keys`, `contains duplicate key(s) ${JSON.stringify([...new Set(dupes)])}`);

  // The back door this gate exists to close is not only an allow-list of
  // `class` values — it is ANY key here that names a rule for both lanes. A
  // shape check that ignores unknown properties leaves `binding.rule:
  // "minimal-span"` and `binding.allowed_classes: [...]` green, which restores
  // the fixed vocabulary §4.2 removed without a version bump. So the block's
  // own key set is closed, even though the lane's `class` value is not.
  const allowed = new Set(['declared_by', 'declaration_keys', 'note']);
  const unknown = Object.keys(b).filter((k) => !allowed.has(k));
  if (unknown.length > 0) {
    at(`${q}.binding`, `carries unknown propert(ies) ${JSON.stringify(unknown)}; §4.5 fixes this block's shape and §4.2 forbids it naming a rule. Allowed: ${JSON.stringify([...allowed])}.`);
  }
}

/**
 * Two roles of one relation sharing a family is legal and unremarkable to a
 * schema check — and it is exactly the condition under which a lane that
 * assigns roles by family assigns both to the same occurrence. Requiring the
 * registry to acknowledge it turns a silent property into a written one.
 */
function checkRoleFamilyCollisions(r, q, familyToRoles, at) {
  const acked = new Map();
  const raw = r.role_family_collisions;
  if (!Array.isArray(raw)) {
    at(`${q}.role_family_collisions`, 'is missing; write [] when no two roles share a family (§4.1)');
    return;
  }
  for (const [i, c] of raw.entries()) {
    if (!c || typeof c !== 'object' || typeof c.family !== 'string' || !Array.isArray(c.roles)) {
      at(`${q}.role_family_collisions[${i}]`, 'must be an object with a family and a roles array');
      continue;
    }
    acked.set(c.family, c.roles);
    if (typeof c.note !== 'string' || c.note.length < 20) {
      at(`${q}.role_family_collisions[${i}].note`, 'must state the consequence for a lane that assigns roles by family');
    }
  }
  for (const [family, roleNames] of familyToRoles) {
    if (roleNames.length < 2) continue;
    const ack = acked.get(family);
    if (!ack) {
      at(`${q}.role_family_collisions`, `roles ${JSON.stringify(roleNames)} all use family ${JSON.stringify(family)}, which is unacknowledged. Family membership alone cannot assign these roles.`);
      continue;
    }
    const missing = roleNames.filter((n) => !ack.includes(n));
    if (missing.length > 0) {
      at(`${q}.role_family_collisions`, `the acknowledgement for family ${JSON.stringify(family)} omits role(s) ${JSON.stringify(missing)}`);
    }
  }
  for (const [family, roleNames] of acked) {
    const actual = familyToRoles.get(family) ?? [];
    if (actual.length < 2) {
      at(`${q}.role_family_collisions`, `acknowledges a collision on family ${JSON.stringify(family)} that does not exist (roles using it: ${JSON.stringify(actual)})`);
      continue;
    }
    const spurious = roleNames.filter((n) => !actual.includes(n));
    if (spurious.length > 0) {
      at(`${q}.role_family_collisions`, `acknowledgement for family ${JSON.stringify(family)} names role(s) ${JSON.stringify(spurious)} that do not use it`);
    }
  }
}

function main(argv, repoRoot = process.cwd()) {
  const result = checkRegistry(repoRoot);
  if (argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return result.ran && result.findings.length === 0 ? 0 : 1;
  }
  if (!result.ran) {
    console.error(`familyRegistry: NOT RUN — ${result.reason}`);
    console.error('  A registry check that silently no-ops reads as coverage. Failing instead.');
    return 1;
  }
  console.log(`familyRegistry: ${result.families} family(ies), ${result.relations} relation(s) — ${result.findings.length} finding(s)`);
  for (const f of result.findings) console.error(`  ${f.path}: ${f.detail}`);
  return result.findings.length === 0 ? 0 : 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  (async () => { process.exitCode = main(process.argv.slice(2)); })();
}
