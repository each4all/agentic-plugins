// plugins/runtime/scripts/lib/compat-artifacts.mjs
//
// ADR-0053 §Decision 4 — the compat artifact vocabulary, owned in ONE place.
//
// WHY A MODULE AND NOT A CONSTANT IN `compat.mjs`. The producer (`compat.mjs`)
// and the consumer (`lib/state-readers.mjs`) both need this vocabulary, and the
// direct import is not available: `state-readers` -> `compat` -> `doctor` ->
// `state-readers` closes a cycle, measured rather than feared (`compat.mjs`
// imports `runCommand` from `doctor.mjs`, and `doctor.mjs` imports this
// reader). So the choice was never "one copy or a shared module" — it was
// "a shared module or a second private copy", and ADR-0051 §Decision 4 already
// decided that one.
//
// WHY THE FAMILY CHECK EXISTS AT ALL, measured before it was written: the reader
// validates no artifact family today. A gap artifact declaring
// `runtime-compat-gap-9.9` — a schema from a runtime that does not exist yet —
// currently reads as `available / current`, because `readOptionalJson` only
// parses JSON and every branch below it switches on the persisted `overall.status`
// string. Bumping the producer's constant therefore changes nothing anyone
// reads. THE VALIDATION IS THE MIGRATION; the bump is only its label.
//
// The reader's direction is already fail-CLOSED for an unknown STATUS — a
// made-up `overall.status` measures `unrecognized` per run and `blocked` for the
// collection — so the risk this module guards is not silent acceptance of new
// states. It is the opposite pair: silent acceptance of an unknown FAMILY, and
// unjust over-blocking of states a lockstep change forgot to teach.

/**
 * The families this runtime WRITES.
 *
 * `1.1` adds `overall.assurance`, the frozen result described in
 * ADR-0053 §Decision 4. The snapshot bumps alongside it because it now carries
 * the host/package facts that result was computed from — a snapshot and a gap
 * that disagreed about which schema era they belong to would be the exact
 * ambiguity this pair exists to remove.
 */
export const COMPAT_SNAPSHOT_SCHEMA = 'runtime-compat-snapshot-1.1';
export const COMPAT_GAP_SCHEMA = 'runtime-compat-gap-1.1';

/**
 * The gap schemas this runtime READS, EXACTLY.
 *
 * ⚠ EXACT, NOT "any 1.x". An earlier draft of this module accepted any readable
 * MAJOR, and cross-host review named the hole: a future MINOR may add a
 * NARROWING field — a condition that restricts what a recorded verdict covers —
 * and a reader that skips the field it has never heard of turns a restricted
 * verdict into an unrestricted one. That is precisely how absence of evidence
 * becomes coverage. `projectRecordedAssurance` already answers this question the
 * same way for the nested result (`section.schema_version !== ASSURANCE_RESULT_SCHEMA_VERSION`),
 * and two readers of one plane must not disagree about forward compatibility.
 *
 * `1.0` is listed because it is REAL history — 34 artifacts on disk at the time
 * of writing — and it is readable precisely because it carries no assurance
 * section to misread.
 */
export const READABLE_GAP_SCHEMAS = Object.freeze([
  'runtime-compat-gap-1.0',
  'runtime-compat-gap-1.1',
]);

/** The gap schemas that REQUIRE `overall.assurance`. */
const ASSURANCE_BEARING_GAP_SCHEMAS = Object.freeze(['runtime-compat-gap-1.1']);

/**
 * The complete producer status vocabulary for `gap.overall.status`.
 *
 * Exported for the same reason `ASSURANCE_RESULT_STATUSES` is exported: so the
 * consumer switches on this list instead of enumerating a private copy that
 * forgets the next entry. Four of these are new in `1.1`; the other four are
 * carried forward unchanged so a legacy artifact keeps meaning what it meant.
 */
export const COMPAT_GAP_STATUSES = Object.freeze([
  // Integrity, ordered above every readiness answer (ADR-0053 §Decision 3).
  'baseline_unusable',
  'assurance_blocked',
  // Readable but never coverage — a snapshot that predates the decision
  // (§Decision 4: remembered snapshots are never retroactively granted).
  'legacy_unassured',
  'release_notes_required',
  // Readiness. Only `current` and `assured` are positive, and both require a
  // human grant that named this host pair.
  'current',
  'assured',
  'unassured',
  'gap_analysis_ready',
]);

/** The subset a consumer may treat as a healthy compat state. */
export const READY_COMPAT_STATUSES = Object.freeze(['current', 'assured']);

/**
 * FAIL-CLOSED family projection for a persisted gap artifact.
 *
 * Three outcomes, and collapsing any pair of them loses an operator action:
 *
 *   `unrecognized` — this runtime cannot read the artifact. UPGRADE; re-running
 *                    `check` writes the same bytes again.
 *   `legacy`       — readable, predates the assurance section, establishes no
 *                    coverage. Take a FRESH snapshot; the old one can never be
 *                    re-evaluated into coverage.
 *   `readable`     — the assurance section is present and may be projected.
 *
 * @param {object?} gapJson the parsed `gap-analysis.json`, or null/undefined.
 */
export function projectGapFamily(gapJson) {
  const schema = typeof gapJson?.schema_version === 'string' ? gapJson.schema_version.trim() : null;
  if (schema === null || !READABLE_GAP_SCHEMAS.includes(schema)) {
    return {
      kind: 'unrecognized',
      schema,
      reason: 'the recorded gap analysis declares a compatibility schema this runtime does not read — '
        + 'upgrade the runtime plugin rather than re-running check, because an unread narrowing field '
        + 'is how a restricted verdict becomes an unrestricted one',
    };
  }
  // The SCHEMA decides whether a section may be read, never the section's own
  // presence. Asking "is there a section?" first was measured wrong: a `1.0`
  // artifact carrying a hand-added assurance block read as `readable`, so an
  // edited legacy file could inject a `covered` verdict into a plane whose whole
  // purpose is that only a human grant produces one. A `1.0` artifact is history;
  // history is `legacy` regardless of what has been written into it.
  if (!ASSURANCE_BEARING_GAP_SCHEMAS.includes(schema)) {
    return {
      kind: 'legacy',
      schema,
      reason: 'the recorded gap analysis predates the assurance section, so it is readable but establishes '
        + 'no coverage, and any assurance-shaped content in it is not read (ADR-0053 §Decision 4: remembered '
        + 'snapshots are never retroactively granted assurance)',
    };
  }
  const section = gapJson?.overall?.assurance;
  if (section === undefined || section === null) {
    // The section is REQUIRED from `1.1` on, so its absence THERE is an
    // incomplete write rather than history. Collapsing the two would let a
    // truncated `1.1` artifact read as "predates the section" — asserting a
    // history for a document that does not have one, which is the same
    // mis-statement `NO_RECORDED_ASSURANCE` exists to prevent one plane up.
    return {
      kind: 'unrecognized',
      schema,
      reason: 'the recorded gap analysis declares a schema that requires an assurance result and carries none — '
        + 're-run runtime:compat check; the artifact is incomplete, not historical',
    };
  }
  return { kind: 'readable', schema, reason: null };
}
