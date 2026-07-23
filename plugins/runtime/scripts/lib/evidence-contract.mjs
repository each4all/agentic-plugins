// plugins/runtime/scripts/lib/evidence-contract.mjs
//
// ADR-0048 §3 — the NEUTRAL evidence contract for bootstrap proof/attestation
// records: the one table every importer, writer, and reader consults so the
// kind-discriminated shape rules cannot drift between them. This module owns:
//
//   1. the evidence FAMILY table — for each kind: which run-schema $def
//      validates its structure, whether the record carries an embedded `kind`
//      member (directional/provider proofs do; hook/receipt attestations do
//      not — their $defs have no kind key, the FILENAME is the only carrier),
//      and which evidence member the kind REQUIRES vs FORBIDS;
//   2. the kind DISCRIMINATOR — run schema 1.2 deliberately leaves both
//      `directions` and `provider_ack` optional because the local validator
//      has no oneOf (schema-validate.mjs §4.1 closed subset); this module is
//      the fail-closed code half: directional kinds require `directions` and
//      forbid `provider_ack`, `egress-provider-ack` requires `provider_ack`
//      and forbids `directions`, and unknown kind / both members / neither
//      member is rejected at every boundary;
//   3. the SEMANTIC rules a structural validator cannot express — an `acked`
//      provider result with a null `ran_at` is a claim with no time, not
//      evidence;
//   4. the domain-separated ACTIVATION FINGERPRINT (§3 freshness binding) —
//      a full SHA-256 over the SANITIZED activation identity (channel,
//      recipient, credential env var NAME), compared by EQUALITY against the
//      current activation on every read. Distinct from egress-semantics.mjs'
//      16-hex throttle fingerprint, which folds the token VALUE in — that one
//      is a transient local throttle key; this one is PERSISTED inside proof
//      records, so nothing credential-value-derived may enter it. Credential
//      ROTATION is therefore invisible to this fingerprint by design — a
//      documented limit (contract §8.1), surfaced instead by the executor's
//      next real attempt failing.
//
// Deliberately NOT here: file I/O (bootstrap-artifacts.mjs owns the proof/
// directory), aggregate recomputation (completion-reducer.mjs), and the
// attempt-hash GENERATION (the egress-proof-executor leaf owns producing it;
// only the domain constant lives here so record and executor agree).
// Imports schema-validate.mjs only — reducer and artifacts both import THIS,
// never each other through it, so the writer/reducer dependency stays acyclic.

import { createHash } from 'node:crypto';

import { makeDefValidator } from './schema-validate.mjs';

// ---------------------------------------------------------------------------
// Kind tables
// ---------------------------------------------------------------------------

export const DIRECTIONAL_PROOF_KINDS = Object.freeze(['deep-peer-smoke', 'workflow-continuation', 'permission']);

// The Stage-8 proof-step kinds (§6.1/§8.1) — the reducer's step_id↔kind
// derivation (`proof.<kind>`) depends on these strings verbatim, which is why
// ADR-0048 §3 pins the egress kind as `egress-provider-ack` and explicitly
// rejects a "dispatch"/"delivery" name: the id must say exactly what is proven.
export const PROOF_KINDS = Object.freeze([...DIRECTIONAL_PROOF_KINDS, 'egress-provider-ack']);

// Evidence families beyond the proof steps: operator CLAIMS carried beside the
// machine proofs in the same proof/ directory.
export const ATTESTATION_KINDS = Object.freeze(['hook-attestation', 'egress-receipt-attestation']);

export const EVIDENCE_KINDS = Object.freeze([...PROOF_KINDS, ...ATTESTATION_KINDS]);

/**
 * The family descriptor table. `defName` names the runtime-bootstrap-run $def
 * that structurally validates the record; `embeddedKind` says whether the
 * record itself carries a `kind` member that MUST equal the filename kind
 * (attestation $defs are sealed with additionalProperties and no kind key, so
 * demanding an embedded kind there would reject every valid record);
 * `requires`/`forbids` are the discriminated evidence members.
 *
 * `postTerminalWritable` is the D0.1 receipt-lifecycle exception: the owner
 * normally cannot attest phone receipt until AFTER the final proof send has
 * terminalized the run, so the receipt attestation — and ONLY it — may be
 * written into a run whose status is complete/configured-not-verified. Every
 * other evidence write into a terminal run is refused: terminal evidence is
 * immutable history (§7), and this flag is how the writer knows the one
 * append the contract allows.
 */
export const EVIDENCE_FAMILIES = Object.freeze({
  'deep-peer-smoke': Object.freeze({ defName: 'proof', embeddedKind: true, requires: 'directions', forbids: 'provider_ack', postTerminalWritable: false }),
  'workflow-continuation': Object.freeze({ defName: 'proof', embeddedKind: true, requires: 'directions', forbids: 'provider_ack', postTerminalWritable: false }),
  'permission': Object.freeze({ defName: 'proof', embeddedKind: true, requires: 'directions', forbids: 'provider_ack', postTerminalWritable: false }),
  'egress-provider-ack': Object.freeze({ defName: 'proof', embeddedKind: true, requires: 'provider_ack', forbids: 'directions', postTerminalWritable: false }),
  'hook-attestation': Object.freeze({ defName: 'hookAttestation', embeddedKind: false, requires: null, forbids: null, postTerminalWritable: false }),
  'egress-receipt-attestation': Object.freeze({ defName: 'egressReceiptAttestation', embeddedKind: false, requires: null, forbids: null, postTerminalWritable: true }),
});

// ---------------------------------------------------------------------------
// Discriminator + semantic rules (the no-oneOf code half)
// ---------------------------------------------------------------------------

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The kind-discriminated shape issues for one evidence record. Returns a list
 * of human-readable violations (empty = clean). Fail-closed by construction:
 * an unknown kind is itself a violation, so a typo'd kind can never select a
 * lenient branch.
 *
 * Structural validation (the $def) runs SEPARATELY via validateEvidenceRecord
 * — these rules are exactly the ones the schema cannot express (§4.1 closed
 * subset has no oneOf and no cross-field implication).
 */
export function evidenceKindIssues(kind, record) {
  const family = EVIDENCE_FAMILIES[kind];
  if (!family) return [`unknown evidence kind "${String(kind)}" — known kinds: ${EVIDENCE_KINDS.join(', ')}`];
  if (!isPlainObject(record)) return ['evidence record is not an object'];

  const issues = [];
  if (family.embeddedKind && record.kind !== kind) {
    issues.push(`embedded kind "${String(record.kind)}" does not match the evidence kind "${kind}" — the filename and the record must agree`);
  }
  if (family.requires && !isPlainObject(record[family.requires])) {
    issues.push(`kind "${kind}" requires the \`${family.requires}\` evidence member`);
  }
  if (family.forbids && record[family.forbids] !== undefined) {
    issues.push(`kind "${kind}" forbids the \`${family.forbids}\` member — a record carrying both evidence shapes is not one kind of evidence`);
  }
  // Semantic: a positive claim with no time is not evidence. The schema keeps
  // ran_at nullable (a FAILED attempt may legitimately have no completion
  // time), so the acked case is enforced here.
  if (kind === 'egress-provider-ack' && isPlainObject(record.provider_ack)) {
    if (record.provider_ack.result === 'acked' && !record.provider_ack.ran_at) {
      issues.push('provider_ack.result is "acked" but ran_at is null — an acked request with no time is a claim, not evidence');
    }
  }
  // `mirror_correlated` is the egress kind's independent verification fact
  // (schema 1.2 sibling seat). Directional kinds must not carry it — a
  // direction matrix with a mirror flag is two evidence shapes in one record.
  // Presence with a non-boolean value is a malformed claim on any kind.
  // ABSENCE on egress is allowed (legacy records) and reduces fail-closed as
  // not-verified in the completion reducer, never as passed.
  if (record.mirror_correlated !== undefined) {
    if (kind !== 'egress-provider-ack') {
      issues.push(`kind "${kind}" forbids the \`mirror_correlated\` member — the mirror fact belongs to the egress single-delivery evidence shape only`);
    } else if (typeof record.mirror_correlated !== 'boolean') {
      issues.push('mirror_correlated must be a boolean when present — a non-boolean mirror claim is not evidence');
    }
  }
  return issues;
}

/**
 * Full evidence-record validation: structural ($def via makeDefValidator, which
 * is structure-only) THEN the discriminator/semantic rules above. Every
 * importer, writer, and reader boundary calls THIS — never the $def alone —
 * so a structurally-valid record of the wrong kind shape cannot slip through
 * one path that forgot the second half.
 */
export async function validateEvidenceRecord({ kind, record, pluginRoot }) {
  const family = EVIDENCE_FAMILIES[kind];
  if (!family) return { ok: false, errors: [`unknown evidence kind "${String(kind)}"`] };
  const structural = (await makeDefValidator('runtime-bootstrap-run', family.defName, { pluginRoot }))(record);
  if (!structural.ok) return { ok: false, errors: structural.errors };
  const issues = evidenceKindIssues(kind, record);
  return issues.length > 0 ? { ok: false, errors: issues } : { ok: true, errors: [] };
}

// ---------------------------------------------------------------------------
// §3 freshness binding — domain-separated identity hashes
// ---------------------------------------------------------------------------

export const EGRESS_ACTIVATION_FINGERPRINT_DOMAIN = 'egress-activation-v1';
// The synthetic-attempt identity domain. GENERATION belongs to the
// egress-proof-executor leaf (it owns the closed-vocab synthetic event); the
// constant lives here so the record vocabulary and the executor cannot drift.
export const EGRESS_ATTEMPT_HASH_DOMAIN = 'egress-attempt-v1';

/**
 * The PERSISTED activation fingerprint (§3): full SHA-256 over the sanitized
 * activation identity. Inputs are the channel, the recipient, and the
 * credential env var NAME — never the credential value (see the module header
 * for why rotation-invisibility is accepted). NUL separators prevent
 * concatenation ambiguity; the domain prefix prevents a value collision with
 * any other sha256 in the artifact family.
 */
export function deriveActivationFingerprint({ channel = '', recipient = '', credentialEnvVar = '' } = {}) {
  return createHash('sha256')
    .update([EGRESS_ACTIVATION_FINGERPRINT_DOMAIN, String(channel), String(recipient), String(credentialEnvVar)].join('\u0000'))
    .digest('hex');
}
