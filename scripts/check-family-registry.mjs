#!/usr/bin/env node
// Gate for the measurement contract's family registry.
//
// The registry fixes what the exporter and the oracle are allowed to measure
// (contract §3.4, §4.1). Nothing read it when it first landed, and a cross-host
// review found three defects that had shipped silently as a result: two roles of
// a `stage-docs` relation bound to a family declared only for `discovered-md`,
// no family declaring the `unit` §3.4 requires, and an `expected_zero` entry the
// corpus falsifies. Each of those is decidable by inspection, which is exactly
// why a check should have been deciding it.
//
// The stakes are asymmetric. Contract §8.2 makes "an occurrence whose family is
// not in the registry" a structural error, so a single typo'd family id turns a
// whole comparison `not-comparable` — a run that never happens rather than a run
// that fails. This file is read-only and asserts nothing about the corpus.
//
// Usage:  node scripts/check-family-registry.mjs [--json]
// Exit:   0 — no findings;  1 — findings

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REGISTRY_PATH = 'docs/assurance/evidence/measurement/family-registry.json';
export const PROFILES = Object.freeze(['stage-docs', 'discovered-md']);

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
    if (!Array.isArray(f.profiles) || f.profiles.length === 0) at(`${q}.profiles`, 'declares no profiles');
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
    if (!PROFILES.includes(r.profile)) { at(`${q}.profile`, `unknown profile ${JSON.stringify(r.profile)}`); continue; }
    if (typeof r.required !== 'boolean') at(`${q}.required`, 'is missing or not a boolean');

    const roles = Array.isArray(r.roles) ? r.roles : [];
    if (roles.length === 0) { at(`${q}.roles`, 'declares no roles'); continue; }
    const roleNames = new Set(roles.map((x) => x?.name));
    if (!roleNames.has(r.anchor_role)) at(`${q}.anchor_role`, `${JSON.stringify(r.anchor_role)} names no role of this relation (§4.1)`);

    for (const role of roles) {
      if (typeof role?.name !== 'string') { at(`${q}.roles`, 'a role has no name'); continue; }
      const rq = `${q}.roles.${role.name}`;
      if (typeof role.required !== 'boolean') at(`${rq}.required`, 'is missing or not a boolean');
      const fam = byId.get(role.family);
      if (!fam) { at(`${rq}.family`, `references unknown family ${JSON.stringify(role.family)}`); continue; }
      // §4.1 — a relation cannot reference an occurrence its profile does not contain.
      if (!Array.isArray(fam.profiles) || !fam.profiles.includes(r.profile)) {
        at(`${rq}.family`, `family ${role.family} is bound to ${JSON.stringify(fam.profiles)} but this relation is ${r.profile} (§4.1 cross-profile role)`);
      }
    }
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
