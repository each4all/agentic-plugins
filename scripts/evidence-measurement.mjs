#!/usr/bin/env node
// The executable half of the evidence measurement contract.
//
// The contract's predicates were prose in every revision before 2.0.0: the
// status table, the reducer and the non-vacuity rule were written normatively
// and implemented nowhere. A predicate that nothing executes is a predicate
// nobody has run, and this repository's own record is that such clauses ship
// wrong — three successive revisions fixed an association rule that no tool
// ever applied to the corpus it governed. This file makes §7 and §8 runnable,
// which is what lets them be falsified.
//
// It also owns the harness the plan left unowned. A review of the track noted
// that "run the exporter against the oracle" hides structural validation, span
// pairing, relation comparison, authority evaluation, reducer execution and
// report serialisation, and that no subtask claimed them. They are claimed
// here, with the contract, because the alternative is that each lane builds
// half of a comparator against its own artifact.
//
// WHAT IS DELIBERATELY NOT HERE: an implementation of the family recognition
// rules. The comparator does not enumerate the anchor domain from the registry;
// it requires the artifacts to agree on it (§8.2) and reports a disagreement
// rather than adjudicating one. A third recogniser would be a third reading of
// rules the registry states once, and the residual hole — a blind spot BOTH
// artifacts share — is recorded in the contract's costs rather than papered
// over here.
//
// Usage:
//   node scripts/evidence-measurement.mjs seal [--verify] [--out <path>]
//   node scripts/evidence-measurement.mjs authority build [--out <path>] [--ref <ref>]
//   node scripts/evidence-measurement.mjs authority drift --baseline <p> --run <p>
//   node scripts/evidence-measurement.mjs compare --artifact <p> [--artifact <p>...]
//                                                 [--baseline <p>] [--run-authority <p>] [--json]
//
// Exit codes:
//   0 — pass, or a seal/build that succeeded
//   1 — fail, blocked, not-comparable, or a verification mismatch
//   2 — usage error

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..');

export const MEASUREMENT_DIR = 'docs/assurance/evidence/measurement';
export const CONTRACT_PATH = `${MEASUREMENT_DIR}/measurement-contract.md`;
export const REGISTRY_PATH = `${MEASUREMENT_DIR}/family-registry.json`;
export const MANIFEST_PATH = `${MEASUREMENT_DIR}/corpus-manifest.json`;
export const SEAL_PATH = `${MEASUREMENT_DIR}/bundle-seal.json`;
export const AUTHORITY_BASELINE_PATH = `${MEASUREMENT_DIR}/authority-baseline.json`;

export const ARTIFACT_SCHEMA = 'evidence-measurement-artifact-1.0';
export const SEAL_SCHEMA = 'evidence-measurement-bundle-1.0';
export const AUTHORITY_SCHEMA = 'evidence-measurement-authority-1.0';
export const CONTRACT_VERSION = '2.0.0';

/** Contract §4.3 — the four dispositions. */
export const DISPOSITIONS = Object.freeze(['bound', 'not-a-claim', 'ambiguous', 'incomplete']);
/** Contract §7.2 — the six comparison statuses. */
export const STATUSES = Object.freeze(['agreeing', 'mispaired', 'missed', 'unexpected', 'unresolved', 'not-adjudicated']);
/** Contract §8.3 — the four verdicts. */
export const VERDICTS = Object.freeze(['pass', 'fail', 'blocked', 'not-comparable']);

// ---------------------------------------------------------------------------
// §2.1 serialisation — the one canonical JSON form this contract uses.
// ---------------------------------------------------------------------------

/**
 * Serialise for digesting: object keys in lexicographic order, two-space
 * indentation, trailing newline.
 *
 * Key order comes from `JSON.stringify`'s ARRAY REPLACER rather than from
 * rebuilding the object with sorted keys, because a JS object always enumerates
 * integer-like keys first and in ascending NUMERIC order whatever order they
 * were inserted in — "2" before "10" where the contract says "10" before "2".
 * The replacer list is the sorted union of every key in the document and acts
 * as a global allow-list applied in list order.
 */
export function canonicalSerialise(value) {
  const keys = new Set();
  const collect = (v) => {
    if (Array.isArray(v)) { v.forEach(collect); return; }
    if (v && typeof v === 'object') { for (const k of Object.keys(v)) { keys.add(k); collect(v[k]); } }
  };
  collect(value);
  return `${JSON.stringify(value, [...keys].sort(), 2)}\n`;
}

export function canonicalDigest(value) {
  return createHash('sha256').update(canonicalSerialise(value), 'utf8').digest('hex');
}

/** Contract §4.5 — a policy declaration's digest is over the declaration minus `digest`. */
export function policyDigest(policy) {
  const { digest: _omit, ...rest } = policy ?? {};
  return canonicalDigest(rest);
}

// ---------------------------------------------------------------------------
// §11.3 — the sealed bundle
// ---------------------------------------------------------------------------

export const BUNDLE_FILES = Object.freeze([CONTRACT_PATH, REGISTRY_PATH, MANIFEST_PATH]);

/**
 * Digest the three shared inputs as one bundle, over BYTES.
 *
 * The path and byte length precede each blob so that concatenation cannot be
 * ambiguous: without a length prefix, moving a byte from the end of one file to
 * the start of the next leaves the digest unchanged.
 */
export function bundleDigest(repoRoot, files = BUNDLE_FILES) {
  const h = createHash('sha256');
  const members = [];
  for (const rel of files) {
    const bytes = readFileSync(resolve(repoRoot, rel));
    h.update(`${rel}\0${bytes.length}\0`, 'utf8');
    h.update(bytes);
    members.push({ path: rel, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  return { digest: h.digest('hex'), members };
}

export function buildSeal(repoRoot) {
  const { digest, members } = bundleDigest(repoRoot);
  return { schema: SEAL_SCHEMA, contract_version: CONTRACT_VERSION, files: members, digest };
}

export function verifySeal(repoRoot, sealPath = SEAL_PATH) {
  let recorded;
  try {
    recorded = JSON.parse(readFileSync(resolve(repoRoot, sealPath), 'utf8'));
  } catch (err) {
    return { ok: false, reason: `${sealPath} is unreadable: ${err.message}`, expected: null, actual: null, drifted: [] };
  }
  const actual = buildSeal(repoRoot);
  const drifted = [];
  const byPath = new Map((recorded.files ?? []).map((f) => [f.path, f]));
  for (const f of actual.files) {
    const was = byPath.get(f.path);
    if (!was) drifted.push({ path: f.path, detail: 'not in the recorded seal' });
    else if (was.sha256 !== f.sha256) drifted.push({ path: f.path, detail: `bytes changed (${was.bytes} -> ${f.bytes})` });
  }
  for (const p of byPath.keys()) if (!actual.files.some((f) => f.path === p)) drifted.push({ path: p, detail: 'recorded but no longer in the bundle' });
  const ok = recorded.digest === actual.digest && drifted.length === 0;
  return { ok, reason: ok ? null : 'bundle bytes differ from the recorded seal', expected: recorded.digest ?? null, actual: actual.digest, drifted };
}

// ---------------------------------------------------------------------------
// §9 — the authority snapshot
// ---------------------------------------------------------------------------

function git(repoRoot, args) {
  return execFileSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
}

/**
 * Build an ENUMERATED authority snapshot (§9).
 *
 * Enumerated rather than sampled on purpose: a selection rule is a second place
 * the baseline and the run snapshot can differ — in what they chose to include
 * rather than in what moved — and drift detection over two differently-selected
 * sets reports noise as movement and movement as nothing.
 */
export function buildAuthoritySnapshot(repoRoot, { ref = 'main', now = new Date() } = {}) {
  const commits = {};
  const raw = git(repoRoot, ['rev-list', '--format=%H%x00%s', '--no-commit-header', ref]);
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const [sha, subject] = line.split('\0');
    if (sha) commits[sha] = subject ?? '';
  }
  const tags = {};
  const tagRaw = git(repoRoot, ['for-each-ref', '--format=%(refname:short)%00%(objectname)%00%(*objectname)%00%(contents:subject)', 'refs/tags/']);
  for (const line of tagRaw.split('\n')) {
    if (!line) continue;
    const [name, objectname, peeled, subject] = line.split('\0');
    if (!name) continue;
    tags[name] = { object: objectname ?? '', target: peeled || objectname || '', subject: subject ?? '' };
  }
  return {
    schema: AUTHORITY_SCHEMA,
    contract_version: CONTRACT_VERSION,
    integration_ref: ref,
    integration_head: git(repoRoot, ['rev-parse', ref]).trim(),
    captured_at: now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    commit_count: Object.keys(commits).length,
    tag_count: Object.keys(tags).length,
    commits,
    tags,
  };
}

/**
 * Contract §9 — drift is the difference between the baseline and the run
 * snapshot. Any drift yields `not-comparable` (§8.3 row 3), never `fail`.
 *
 * DRIFT IS MOVEMENT, NOT GROWTH, and the distinction is load-bearing rather
 * than pedantic. A first cut of this function treated an advanced integration
 * head as `baseline-stale`, which on an active repository is true within hours
 * of every pin: every comparison would have ended `not-comparable` and the
 * reducer's `pass` and `fail` rows would have been unreachable in practice
 * while remaining reachable in the unit tests. That is the same
 * verdict-unreachability that retired contract 1.0, arriving by a different
 * door. New commits and new tags change no authority a comparison consulted;
 * a retargeted tag, a rewritten subject, and a commit that has stopped being
 * reachable all do.
 *
 * `head_advanced` is reported as information so an operator can see the window,
 * and is deliberately not a condition.
 */
export function authorityDrift(baseline, run) {
  const conditions = [];
  const info = [];
  if (!baseline || !run) return { drifted: false, conditions: [], info: [], reason: 'one or both snapshots absent' };
  if (baseline.integration_ref !== run.integration_ref) {
    conditions.push({ kind: 'integration-ref-changed', detail: `${baseline.integration_ref} -> ${run.integration_ref}` });
  } else if (baseline.integration_head !== run.integration_head) {
    info.push({ kind: 'head_advanced', detail: `${baseline.integration_head} -> ${run.integration_head}` });
  }
  for (const [name, was] of Object.entries(baseline.tags ?? {})) {
    const now = run.tags?.[name];
    if (!now) conditions.push({ kind: 'tag-removed', detail: name });
    else if (now.target !== was.target) conditions.push({ kind: 'tag-retargeted', detail: `${name}: ${was.target} -> ${now.target}` });
  }
  for (const [sha, was] of Object.entries(baseline.commits ?? {})) {
    const now = run.commits?.[sha];
    if (now === undefined) conditions.push({ kind: 'commit-unreachable', detail: sha });
    else if (now !== was) conditions.push({ kind: 'subject-changed', detail: sha });
  }
  return { drifted: conditions.length > 0, conditions, info, reason: null };
}

// ---------------------------------------------------------------------------
// §3.2 — physical identity
// ---------------------------------------------------------------------------

export function identityKey(id) {
  if (!id || typeof id !== 'object') return null;
  const { profile, path, blob, start_byte: s, end_byte: e } = id;
  if (typeof profile !== 'string' || typeof path !== 'string' || typeof blob !== 'string') return null;
  if (!Number.isInteger(s) || !Number.isInteger(e)) return null;
  return `${profile}\0${path}\0${blob}\0${s}\0${e}`;
}

// ---------------------------------------------------------------------------
// §8.2 — structural validation
// ---------------------------------------------------------------------------

/**
 * `readBlob` is injected so the comparator can be exercised without a git
 * object store. Production passes a git-backed reader; tests pass fixtures.
 * Returning `null` means "cannot read", which is itself a structural error —
 * a span that cannot be checked has not been checked.
 */
export function gitBlobReader(repoRoot) {
  const cache = new Map();
  return (blob) => {
    if (cache.has(blob)) return cache.get(blob);
    let bytes = null;
    try { bytes = execFileSync('git', ['-C', repoRoot, 'cat-file', 'blob', blob], { maxBuffer: 1 << 28 }); } catch { bytes = null; }
    cache.set(blob, bytes);
    return bytes;
  };
}

export function validateArtifact(artifact, ctx) {
  const errors = [];
  const at = (path, detail) => errors.push({ artifact: artifact?.artifact_id ?? '<unnamed>', path, detail });

  if (!artifact || typeof artifact !== 'object') return [{ artifact: '<unreadable>', path: '', detail: 'artifact is not an object' }];
  if (artifact.schema !== ARTIFACT_SCHEMA) at('schema', `is ${JSON.stringify(artifact.schema)}, expected ${ARTIFACT_SCHEMA}`);
  if (artifact.contract_version !== ctx.contractVersion) {
    at('contract_version', `is ${JSON.stringify(artifact.contract_version)}, expected ${ctx.contractVersion} (§10.1)`);
  }
  if (artifact.role !== 'lane' && artifact.role !== 'oracle') at('role', `is ${JSON.stringify(artifact.role)}, expected "lane" or "oracle"`);
  if (ctx.bundleDigest && artifact.bundle_digest !== ctx.bundleDigest) {
    at('bundle_digest', `is ${JSON.stringify(artifact.bundle_digest)}, the sealed bundle is ${ctx.bundleDigest} (§11.3)`);
  }
  if (ctx.manifestDigest && artifact.manifest_digest !== ctx.manifestDigest) {
    at('manifest_digest', `is ${JSON.stringify(artifact.manifest_digest)}, the pinned manifest is ${ctx.manifestDigest} (§2.1)`);
  }

  const relationsReported = new Set((artifact.anchors ?? []).map((a) => a.relation));
  const declared = new Map();
  for (const [i, p] of (artifact.policies ?? []).entries()) {
    if (!p || typeof p !== 'object') { at(`policies[${i}]`, 'is not an object'); continue; }
    const keys = ctx.declarationKeys.get(p.relation) ?? [];
    for (const k of keys) if (!(k in p)) at(`policies[${i}]`, `omits declaration key ${JSON.stringify(k)} (§4.5)`);
    if (p.digest !== policyDigest(p)) at(`policies[${i}].digest`, 'does not match the declaration it seals (§4.5)');
    declared.set(p.relation, p);
  }
  for (const rel of relationsReported) {
    if (!declared.has(rel)) at('policies', `no policy declaration for relation ${JSON.stringify(rel)} it reports (§4.5, §8.2)`);
  }

  const occByKey = new Map();
  for (const [i, o] of (artifact.occurrences ?? []).entries()) {
    const key = identityKey(o);
    if (!key) { at(`occurrences[${i}]`, 'has no well-formed physical identity (§3.2)'); continue; }
    if (!ctx.families.has(o.family)) at(`occurrences[${i}].family`, `family ${JSON.stringify(o.family)} is not in the registry (§8.2)`);
    if (o.end_byte <= o.start_byte) { at(`occurrences[${i}]`, `span is not a valid half-open range (${o.start_byte}, ${o.end_byte}) (§3.2)`); continue; }
    if (occByKey.has(key) && occByKey.get(key).family === o.family) {
      at(`occurrences[${i}]`, 'two occurrences of the same family share a physical identity (§3.2)');
    }
    occByKey.set(key, o);
    const bytes = ctx.readBlob(o.blob);
    if (bytes === null || bytes === undefined) { at(`occurrences[${i}].blob`, `blob ${o.blob} could not be read; an unchecked span is not a checked one (§8.2)`); continue; }
    if (o.end_byte > bytes.length) { at(`occurrences[${i}]`, `span end ${o.end_byte} is past the blob's ${bytes.length} bytes (§3.2)`); continue; }
    const decoded = bytes.subarray(o.start_byte, o.end_byte).toString('utf8');
    if (decoded !== o.literal) {
      at(`occurrences[${i}].literal`, `does not equal the UTF-8 decoding of its own span (§3.5): ${JSON.stringify(decoded)} vs ${JSON.stringify(o.literal)}`);
    }
  }

  const seenAnchor = new Set();
  for (const [i, a] of (artifact.anchors ?? []).entries()) {
    const key = identityKey(a?.anchor);
    if (!key) { at(`anchors[${i}].anchor`, 'has no well-formed physical identity (§3.2)'); continue; }
    const rowKey = `${a.relation}\0${key}`;
    if (seenAnchor.has(rowKey)) at(`anchors[${i}]`, `a second row for the same anchor of relation ${JSON.stringify(a.relation)} (§4.3 says exactly one)`);
    seenAnchor.add(rowKey);
    if (!DISPOSITIONS.includes(a.disposition)) {
      at(`anchors[${i}].disposition`, `is ${JSON.stringify(a.disposition)}, not one of ${JSON.stringify(DISPOSITIONS)} (§4.3)`);
    }
    if (!ctx.relations.has(a.relation)) at(`anchors[${i}].relation`, `relation ${JSON.stringify(a.relation)} is not in the registry`);
  }

  return { errors, occByKey, anchorKeys: seenAnchor, policies: declared };
}

// ---------------------------------------------------------------------------
// §5 + §9 — canonical resolution against the frozen authority snapshot
// ---------------------------------------------------------------------------

/**
 * Resolve an occurrence's authority-derived field, per §5 and §9.
 *
 * §5 puts this on the comparator rather than the producer, and the reason is
 * §11.2: an authority both lanes may consult is a third oracle, and one they
 * may consult DIFFERENTLY is a silent divergence. So a lane emits a literal and
 * the comparator resolves it — once, from a frozen snapshot, for every lane.
 *
 * An abbreviation that matches no snapshot entry, or more than one, is
 * `unresolved` (§9's last bullet) and never a guess. `unresolved` on a required
 * family blocks the run (§8.3 row 8): a comparison that could not resolve half
 * its identifiers has not compared them, and reporting that as agreement is the
 * failure §5's last paragraph describes.
 */
export function resolveCanonical(literal, authority, snapshot) {
  if (!snapshot) return { state: 'unresolved', reason: 'no authority snapshot available (§9)' };
  if (authority === 'object-name') {
    if (!/^[0-9a-f]{7,40}$/.test(literal)) return { state: 'unresolved', reason: 'literal is not an object-name abbreviation' };
    if (snapshot.commits?.[literal]) return { state: 'present', value: literal, entry: `commits/${literal}` };
    const matches = Object.keys(snapshot.commits ?? {}).filter((sha) => sha.startsWith(literal));
    if (matches.length === 1) return { state: 'present', value: matches[0], entry: `commits/${matches[0]}` };
    return { state: 'unresolved', reason: matches.length === 0 ? 'no reachable commit carries this prefix' : `${matches.length} reachable commits carry this prefix` };
  }
  if (authority === 'tag-ref') {
    const tag = snapshot.tags?.[literal];
    if (tag?.target) return { state: 'present', value: tag.target, entry: `tags/${literal}` };
    return { state: 'unresolved', reason: 'no such tag in the snapshot' };
  }
  // `run-artifact` is untracked (§2.3) and never lives in the snapshot; it is
  // carried by the artifact's own artifact_only_findings and qualified
  // `artifact-only` (§7.5), so it is deliberately not resolved here.
  return { state: 'not-applicable', reason: `authority ${JSON.stringify(authority)} is not snapshot-resolvable` };
}

/**
 * Resolve every authority-derived field the registry declares, on every
 * artifact, and report the ones that could not be resolved.
 */
export function resolveAuthorityFields({ artifacts, registry, snapshot }) {
  const authorityByFamily = new Map();
  for (const f of registry.families ?? []) {
    for (const fld of f.fields ?? []) {
      if (fld.authority) authorityByFamily.set(`${f.id}\0${fld.name}`, { authority: fld.authority, required: f.required === true, qualifier: fld.qualifier ?? null });
    }
  }
  const unresolved = [];
  const resolved = [];
  for (const a of artifacts) {
    for (const o of a.occurrences ?? []) {
      for (const [key, decl] of authorityByFamily) {
        const [famId, fieldName] = key.split('\0');
        if (o.family !== famId) continue;
        if (decl.qualifier === 'artifact-only') continue;
        const r = resolveCanonical(o.literal, decl.authority, snapshot);
        if (r.state === 'unresolved') {
          unresolved.push({ artifact: a.artifact_id, family: famId, field: fieldName, literal: o.literal, required: decl.required, reason: r.reason });
        } else if (r.state === 'present') {
          resolved.push({ artifact: a.artifact_id, family: famId, field: fieldName, literal: o.literal, canonical: r.value, entry: r.entry });
        }
      }
    }
  }
  return { resolved, unresolved };
}

// ---------------------------------------------------------------------------
// §7.2 — the anchor disposition table
// ---------------------------------------------------------------------------

/**
 * Twelve rows, first match wins, total over the sixteen disposition pairs.
 *
 * `rolesAgree` is only consulted on the two rows where both sides decided the
 * same way and the question is which occurrence filled which role.
 */
export function compareDisposition(oracle, lane, rolesAgree) {
  if (oracle === 'ambiguous') return 'not-adjudicated';                       // 1
  if (lane === 'ambiguous') return 'unresolved';                              // 2
  if (oracle === 'bound') {
    if (lane === 'bound') return rolesAgree ? 'agreeing' : 'mispaired';       // 3, 4
    if (lane === 'not-a-claim') return 'missed';                              // 5
    return 'missed';                                                          // 6  (lane incomplete)
  }
  if (oracle === 'incomplete') {
    if (lane === 'incomplete') return rolesAgree ? 'agreeing' : 'mispaired';  // 7, 8
    if (lane === 'bound') return 'unexpected';                                // 9
    return 'missed';                                                          // 10 (lane not-a-claim)
  }
  // oracle === 'not-a-claim'
  if (lane === 'not-a-claim') return 'agreeing';                              // 11
  return 'unexpected';                                                        // 12
}

/** §7.3 — bindings agree when every declared role names the same identity, or neither does. */
export function roleBindingsAgree(relationRoles, oracleRoles = {}, laneRoles = {}) {
  const differing = [];
  for (const role of relationRoles) {
    const o = identityKey(oracleRoles?.[role] ?? null);
    const l = identityKey(laneRoles?.[role] ?? null);
    if (o !== l) differing.push(role);
  }
  return { agree: differing.length === 0, differing };
}

// ---------------------------------------------------------------------------
// The comparison
// ---------------------------------------------------------------------------

export function compare({ artifacts, registry, manifest, bundleDigest: bundle, baseline = null, runAuthority = null, readBlob }) {
  const families = new Set((registry.families ?? []).map((f) => f.id));
  const relations = new Map((registry.relations ?? []).map((r) => [r.id, r]));
  const declarationKeys = new Map((registry.relations ?? []).map((r) => [r.id, r.binding?.declaration_keys ?? []]));
  const ctx = {
    families, relations, declarationKeys, readBlob,
    contractVersion: registry.contract_version,
    bundleDigest: bundle,
    manifestDigest: manifest?.digest ?? null,
  };

  const structural = [];
  const validated = [];
  for (const a of artifacts) {
    const v = validateArtifact(a, ctx);
    if (Array.isArray(v)) { structural.push(...v); continue; }
    structural.push(...v.errors);
    validated.push({ artifact: a, ...v });
  }

  // §8.2 — artifacts must agree on the pin and the bundle before anything else.
  const seals = new Set(artifacts.map((a) => a?.bundle_digest));
  if (seals.size > 1) structural.push({ artifact: '<run>', path: 'bundle_digest', detail: `artifacts declare ${seals.size} different bundle digests (§8.2)` });
  const pins = new Set(artifacts.map((a) => a?.corpus_commit));
  if (pins.size > 1) structural.push({ artifact: '<run>', path: 'corpus_commit', detail: `artifacts declare ${pins.size} different corpus pins (§8.2)` });

  const oracles = validated.filter((v) => v.artifact.role === 'oracle');
  const lanes = validated.filter((v) => v.artifact.role === 'lane');
  if (oracles.length > 1) structural.push({ artifact: '<run>', path: 'role', detail: 'more than one oracle in one run (§4.4)' });

  // §8.2 last item — the anchor domains must match across artifacts. The
  // comparator does not enumerate the domain itself (see the file header), so
  // this reports a disagreement rather than adjudicating one.
  if (oracles.length === 1) {
    for (const lane of lanes) {
      for (const key of oracles[0].anchorKeys) {
        if (!lane.anchorKeys.has(key)) {
          const [rel] = key.split('\0');
          structural.push({ artifact: lane.artifact.artifact_id, path: 'anchors', detail: `no row for an in-scope anchor of relation ${rel} that the oracle carries (§4.3, §8.2 missing anchor row)` });
        }
      }
      for (const key of lane.anchorKeys) {
        if (!oracles[0].anchorKeys.has(key)) {
          const [rel] = key.split('\0');
          structural.push({ artifact: lane.artifact.artifact_id, path: 'anchors', detail: `carries a row for an anchor of relation ${rel} that is outside the oracle's domain (§4.4)` });
        }
      }
    }
  }

  // §7.4 — policy declarations, compared by digest.
  const policyFindings = [];
  for (const rel of relations.keys()) {
    const digests = new Map();
    for (const v of validated) {
      const p = v.policies.get(rel);
      if (p) digests.set(v.artifact.artifact_id, p);
    }
    if (digests.size < 2) continue;
    const distinct = new Set([...digests.values()].map((p) => p.digest));
    if (distinct.size > 1) {
      const domainDiffers = new Set([...digests.values()].map((p) => canonicalDigest(p.anchor_domain ?? null))).size > 1;
      policyFindings.push({
        relation: rel,
        kind: domainDiffers ? 'anchor-domain-mismatch' : 'policy-mismatch',
        declarations: Object.fromEntries([...digests].map(([id, p]) => [id, { class: p.class, ranking: p.ranking, tie_policy: p.tie_policy, digest: p.digest }])),
        detail: domainDiffers
          ? 'the artifacts measured different anchor populations, so every ratio below is a ratio of something different (§7.4)'
          : 'declared policies differ; row disagreements below may be explained by that difference rather than by an error (§7.4)',
      });
    }
  }

  const drift = baseline && runAuthority ? authorityDrift(baseline, runAuthority) : { drifted: false, conditions: [] };

  // §5 + §9 — resolve authority-derived fields once, for every lane, from the
  // run snapshot. A lane that resolved them itself would be consulting a third
  // oracle (§11.2).
  const authorityFields = resolveAuthorityFields({ artifacts, registry, snapshot: runAuthority });

  const rows = [];
  const containment = [];
  if (oracles.length === 1) {
    const oracle = oracles[0];
    const oracleAnchors = new Map((oracle.artifact.anchors ?? []).map((a) => [`${a.relation}\0${identityKey(a.anchor)}`, a]));
    for (const lane of lanes) {
      const laneAnchors = new Map((lane.artifact.anchors ?? []).map((a) => [`${a.relation}\0${identityKey(a.anchor)}`, a]));

      // §7.1 — occurrence containment, one-directional by construction.
      for (const a of oracle.artifact.anchors ?? []) {
        const named = [a.anchor, ...Object.values(a.roles ?? {})].filter(Boolean);
        for (const id of named) {
          const key = identityKey(id);
          if (!key) continue;
          const oracleOcc = oracle.occByKey.get(key);
          const laneOcc = lane.occByKey.get(key);
          if (!laneOcc) {
            containment.push({ lane: lane.artifact.artifact_id, relation: a.relation, identity: id, kind: 'absent-occurrence', detail: 'the oracle names this occurrence and the lane does not carry it (§7.1)' });
          } else if (oracleOcc && (laneOcc.family !== oracleOcc.family || laneOcc.literal !== oracleOcc.literal)) {
            containment.push({ lane: lane.artifact.artifact_id, relation: a.relation, identity: id, kind: 'divergent-occurrence', detail: `family/literal disagree: ${JSON.stringify([oracleOcc.family, oracleOcc.literal])} vs ${JSON.stringify([laneOcc.family, laneOcc.literal])} (§7.1)` });
          }
        }
      }

      for (const [key, oa] of oracleAnchors) {
        const la = laneAnchors.get(key);
        if (!la) continue; // already structural
        const rel = relations.get(oa.relation);
        const roleNames = (rel?.roles ?? []).map((x) => x.name);
        const { agree, differing } = roleBindingsAgree(roleNames, oa.roles, la.roles);
        const status = compareDisposition(oa.disposition, la.disposition, agree);
        rows.push({
          lane: lane.artifact.artifact_id,
          relation: oa.relation,
          anchor: oa.anchor,
          oracle_disposition: oa.disposition,
          lane_disposition: la.disposition,
          status,
          differing_roles: status === 'mispaired' ? differing : [],
          required: rel?.required === true,
          qualifiers: [...new Set([...(oa.qualifiers ?? []), ...(la.qualifiers ?? [])])],
        });
      }
    }
  }

  const verdict = reduce({ structural, oracles: oracles.length, drift, rows, containment, relations, artifacts, authorityFields });
  const counts = Object.fromEntries(STATUSES.map((s) => [s, rows.filter((r) => r.status === s).length]));
  return { verdict: verdict.verdict, reason: verdict.reason, structural, policy_findings: policyFindings, drift, containment, rows, counts, authority_fields: authorityFields };
}

// ---------------------------------------------------------------------------
// §8.3 — the reducer
// ---------------------------------------------------------------------------

export function reduce({ structural, oracles, drift, rows, containment, relations, artifacts, authorityFields = null }) {
  if (structural.length > 0) return { verdict: 'not-comparable', reason: `structural error (§8.2): ${structural[0].path} — ${structural[0].detail}` };
  if (oracles !== 1) return { verdict: 'not-comparable', reason: 'the run has no oracle; correctness has an authority or it has no verdict (§8.3 row 2, §4.4)' };
  if (drift?.drifted) return { verdict: 'not-comparable', reason: `authority drift (§9): ${drift.conditions[0].kind} — ${drift.conditions[0].detail}` };

  const req = (r) => r.required === true;
  const bad = rows.find((r) => req(r) && ['mispaired', 'missed', 'unexpected'].includes(r.status));
  if (bad) return { verdict: 'fail', reason: `${bad.status} on required relation ${bad.relation} (§8.3 row 4)` };

  const requiredRelations = new Set([...relations.values()].filter((r) => r.required === true).map((r) => r.id));
  const cont = (containment ?? []).find((c) => requiredRelations.has(c.relation));
  if (cont) return { verdict: 'fail', reason: `${cont.kind} on required relation ${cont.relation} (§8.3 row 5)` };

  const artifactOnlyDisagrees = (artifacts ?? []).some((a) => (a?.artifact_only_findings ?? []).some((f) => f.present === true && f.agrees === false));
  if (artifactOnlyDisagrees) return { verdict: 'fail', reason: 'an artifact-only authority is present and disagrees (§8.3 row 6)' };

  const unresolved = rows.find((r) => req(r) && r.status === 'unresolved');
  if (unresolved) return { verdict: 'blocked', reason: `unresolved on required relation ${unresolved.relation} (§8.3 row 7)` };

  // §8.3 row 8 — a required family whose authority-derived field could not be
  // resolved. §5 makes this the comparator's own failure to resolve, not a
  // lane's error, which is why it blocks rather than fails.
  const unresolvedField = (authorityFields?.unresolved ?? []).find((u) => u.required);
  if (unresolvedField) {
    return { verdict: 'blocked', reason: `required field ${unresolvedField.family}.${unresolvedField.field} is unresolved for ${JSON.stringify(unresolvedField.literal)}: ${unresolvedField.reason} (§8.3 row 8, §9)` };
  }

  const artifactOnlyAbsent = (artifacts ?? []).some((a) => (a?.artifact_only_findings ?? []).some((f) => f.present === false));
  if (artifactOnlyAbsent) return { verdict: 'blocked', reason: 'an artifact-only authority is absent (§8.3 row 9)' };

  // §8.4 — a `pass` requires an adjudicated row on every required relation.
  for (const id of requiredRelations) {
    const adjudicated = rows.some((r) => r.relation === id && r.status !== 'not-adjudicated');
    if (!adjudicated) {
      return { verdict: 'blocked', reason: `required relation ${id} produced no adjudicated row; a pass here would be vacuous (§8.4)` };
    }
  }
  return { verdict: 'pass', reason: null };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function flagValue(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}
function flagValues(argv, name) {
  const out = [];
  argv.forEach((a, i) => { if (a === name && i + 1 < argv.length) out.push(argv[i + 1]); });
  return out;
}

export function main(argv, repoRoot = REPO_ROOT) {
  const [command, sub] = argv;
  const json = argv.includes('--json');

  if (command === 'seal') {
    if (argv.includes('--verify')) {
      const r = verifySeal(repoRoot, flagValue(argv, '--seal') ?? SEAL_PATH);
      if (json) { console.log(JSON.stringify(r, null, 2)); return r.ok ? 0 : 1; }
      if (r.ok) { console.log(`bundle seal: ok — ${r.actual}`); return 0; }
      console.error(`bundle seal: MISMATCH — ${r.reason}`);
      console.error(`  recorded ${r.expected}\n  actual   ${r.actual}`);
      for (const d of r.drifted) console.error(`  ${d.path}: ${d.detail}`);
      console.error('  §11.3 — a version string can be true of two different texts; the digest cannot.');
      return 1;
    }
    const seal = buildSeal(repoRoot);
    const out = flagValue(argv, '--out') ?? SEAL_PATH;
    writeFileSync(resolve(repoRoot, out), canonicalSerialise(seal), 'utf8');
    console.log(`bundle seal: wrote ${out} — ${seal.digest}`);
    return 0;
  }

  if (command === 'authority') {
    if (sub === 'build') {
      const snap = buildAuthoritySnapshot(repoRoot, { ref: flagValue(argv, '--ref') ?? 'main' });
      const out = flagValue(argv, '--out') ?? AUTHORITY_BASELINE_PATH;
      writeFileSync(resolve(repoRoot, out), canonicalSerialise(snap), 'utf8');
      console.log(`authority: wrote ${out} — ${snap.commit_count} commit(s), ${snap.tag_count} tag(s) at ${snap.integration_head}`);
      return 0;
    }
    if (sub === 'drift') {
      const b = JSON.parse(readFileSync(resolve(repoRoot, flagValue(argv, '--baseline') ?? AUTHORITY_BASELINE_PATH), 'utf8'));
      const runPath = flagValue(argv, '--run');
      const r = runPath ? JSON.parse(readFileSync(resolve(repoRoot, runPath), 'utf8')) : buildAuthoritySnapshot(repoRoot, { ref: b.integration_ref });
      const d = authorityDrift(b, r);
      if (json) { console.log(JSON.stringify(d, null, 2)); return d.drifted ? 1 : 0; }
      console.log(`authority drift: ${d.drifted ? `${d.conditions.length} condition(s)` : 'none'}`);
      for (const i of d.info ?? []) console.log(`  info ${i.kind}: ${i.detail}`);
      for (const c of d.conditions.slice(0, 20)) console.error(`  ${c.kind}: ${c.detail}`);
      if (d.conditions.length > 20) console.error(`  … ${d.conditions.length - 20} more`);
      return d.drifted ? 1 : 0;
    }
    console.error('usage: evidence-measurement.mjs authority build|drift');
    return 2;
  }

  if (command === 'compare') {
    const paths = flagValues(argv, '--artifact');
    if (paths.length === 0) { console.error('usage: evidence-measurement.mjs compare --artifact <path> [--artifact <path>…]'); return 2; }
    const registry = JSON.parse(readFileSync(resolve(repoRoot, REGISTRY_PATH), 'utf8'));
    const manifest = JSON.parse(readFileSync(resolve(repoRoot, MANIFEST_PATH), 'utf8'));
    const seal = verifySeal(repoRoot);
    const artifacts = paths.map((p) => JSON.parse(readFileSync(resolve(repoRoot, p), 'utf8')));
    const baselinePath = flagValue(argv, '--baseline');
    const runPath = flagValue(argv, '--run-authority');
    const baseline = baselinePath ? JSON.parse(readFileSync(resolve(repoRoot, baselinePath), 'utf8')) : null;
    const runAuthority = runPath ? JSON.parse(readFileSync(resolve(repoRoot, runPath), 'utf8')) : (baseline ? buildAuthoritySnapshot(repoRoot, { ref: baseline.integration_ref }) : null);
    const result = compare({ artifacts, registry, manifest, bundleDigest: seal.actual, baseline, runAuthority, readBlob: gitBlobReader(repoRoot) });
    if (json) { console.log(JSON.stringify(result, null, 2)); return result.verdict === 'pass' ? 0 : 1; }
    console.log(`verdict: ${result.verdict}${result.reason ? ` — ${result.reason}` : ''}`);
    console.log(`rows: ${JSON.stringify(result.counts)}`);
    for (const s of result.structural.slice(0, 20)) console.error(`  structural ${s.artifact} ${s.path}: ${s.detail}`);
    for (const p of result.policy_findings) console.error(`  ${p.kind} on ${p.relation}: ${p.detail}`);
    for (const c of result.containment.slice(0, 20)) console.error(`  ${c.kind} ${c.relation}: ${c.detail}`);
    for (const u of (result.authority_fields?.unresolved ?? []).slice(0, 20)) console.error(`  unresolved ${u.family}.${u.field} ${JSON.stringify(u.literal)}: ${u.reason}`);
    return result.verdict === 'pass' ? 0 : 1;
  }

  console.error('usage: evidence-measurement.mjs seal|authority|compare');
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  (async () => { process.exitCode = main(process.argv.slice(2)); })();
}
