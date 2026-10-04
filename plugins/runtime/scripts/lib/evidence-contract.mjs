// plugins/runtime/scripts/lib/evidence-contract.mjs
//
// ADR-0048 §3 — the NEUTRAL evidence contract for bootstrap proof/attestation
// records: the one table every importer, writer, and reader consults so the
// kind-discriminated shape rules cannot drift between them. This module owns:
//
//   1. the evidence FAMILY table — for each kind: which run-schema $def
//      validates its structure, whether the record carries an embedded `kind`
//      member (directional proofs do; the hook attestation does not — its $def
//      has no kind key, the FILENAME is the only carrier), and which evidence
//      member the kind REQUIRES vs FORBIDS;
//   2. the kind DISCRIMINATOR — the run schema leaves `directions` and the
//      retired `provider_ack` both optional because the local validator has no
//      oneOf (schema-validate.mjs §4.1 closed subset); this module is the
//      fail-closed code half: a directional kind requires `directions` and
//      forbids `provider_ack` and `mirror_correlated`, and an unknown kind is
//      rejected at every boundary;
//   3. the RETIRED kinds (ADR-0064) — the egress delivery proof and the owner
//      receipt attestation. Their files stay in retained runs as history; the
//      proof/ reader skips them by name and nothing validates or credits them.
//
// The domain-separated egress ACTIVATION FINGERPRINT and its two domain
// constants went with doctor's egress ack proof, their last consumer
// (ADR-0064 Decision 1, slice R4n2).
//
// Deliberately NOT here: file I/O (bootstrap-artifacts.mjs owns the proof/
// directory) and aggregate recomputation (completion-reducer.mjs).
// Imports schema-validate.mjs only — reducer and artifacts both import THIS,
// never each other through it, so the writer/reducer dependency stays acyclic.

import { makeDefValidator } from './schema-validate.mjs';

// ---------------------------------------------------------------------------
// Kind tables
// ---------------------------------------------------------------------------

export const DIRECTIONAL_PROOF_KINDS = Object.freeze(['deep-peer-smoke', 'workflow-continuation', 'permission']);

// The Stage-8 proof-step kinds (§6.1/§8.1) — the reducer's step_id↔kind
// derivation (`proof.<kind>`) depends on these strings verbatim.
export const PROOF_KINDS = Object.freeze([...DIRECTIONAL_PROOF_KINDS]);

// Evidence families beyond the proof steps: operator CLAIMS carried beside the
// machine proofs in the same proof/ directory.
export const ATTESTATION_KINDS = Object.freeze(['hook-attestation']);

export const EVIDENCE_KINDS = Object.freeze([...PROOF_KINDS, ...ATTESTATION_KINDS]);

/**
 * The evidence kinds ADR-0064 retired with egress: the egress delivery proof
 * (`egress-provider-ack`) and the owner's receipt attestation. A run's proof/
 * directory may still hold `<kind>.json` for either. The reader SKIPS those
 * files rather than refusing the directory: refusing would strand an open run
 * that recorded one, because `resume` reads proof/ on every pass, and the files
 * are evidence about a send nothing judges any more. They stay on disk as
 * history; nothing validates, credits or writes them.
 */
export const RETIRED_EVIDENCE_KINDS = Object.freeze(['egress-provider-ack', 'egress-receipt-attestation']);

/**
 * The family descriptor table. `defName` names the runtime-bootstrap-run $def
 * that structurally validates the record; `embeddedKind` says whether the
 * record itself carries a `kind` member that MUST equal the filename kind
 * (the attestation $def is sealed with additionalProperties and no kind key,
 * so demanding an embedded kind there would reject every valid record);
 * `requires`/`forbids` are the discriminated evidence members.
 */
export const EVIDENCE_FAMILIES = Object.freeze({
  'deep-peer-smoke': Object.freeze({ defName: 'proof', embeddedKind: true, requires: 'directions', forbids: 'provider_ack' }),
  'workflow-continuation': Object.freeze({ defName: 'proof', embeddedKind: true, requires: 'directions', forbids: 'provider_ack' }),
  'permission': Object.freeze({ defName: 'proof', embeddedKind: true, requires: 'directions', forbids: 'provider_ack' }),
  'hook-attestation': Object.freeze({ defName: 'hookAttestation', embeddedKind: false, requires: null, forbids: null }),
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
  // `mirror_correlated` was the retired egress kind's verification fact. The
  // schema still accepts the seat so retained records stay valid, which is why
  // the refusal for a live kind is spelled here: a direction matrix with a
  // mirror flag is two evidence shapes in one record.
  if (record.mirror_correlated !== undefined) {
    issues.push(`kind "${kind}" forbids the \`mirror_correlated\` member — the mirror fact belonged to the retired egress delivery proof only`);
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
