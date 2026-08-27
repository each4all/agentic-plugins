// plugins/runtime/scripts/lib/legacy-assurance-reader.mjs
//
// ADR-0056 §Decision 5 — the LEGACY-ONLY decoder for the compatibility-assurance
// result that `runtime-doctor-1.0` reports used to carry.
//
// This is what survives of `lib/assurance-result.mjs`. The matcher-facing half —
// `evaluateAssurance`, `matchAssurance`, `isGrantId` and the producer status
// list — is gone with the grant/cohort layer. Nothing writes an assurance
// section any more.
//
// ⚠ WHY A DECODER SURVIVES A REMOVED PRODUCER. `projectRecordedAssurance` is the
// ONLY reader of a historical doctor assurance section, and doctor scans every
// retained `doctor.json`. Deleting it would not make old artifacts stop existing;
// it would make the newest reader unable to say anything true about ~70 of them.
// ADR-0056 §Decision 5 is explicit: "Historical records are not reinterpreted."
//
// ⚠ A HISTORICAL VALUE IS NEVER MAPPED ONTO A CURRENT STATUS. `covered`,
// `unassured`, `blocked`, `legacy-unassured` and `unreadable` are reported as
// what a past run recorded, carrying `schema_era: 'assurance-era'`. No consumer
// may put any of them in a ready set — that is ADR-0056 §Decision 6 rule 1, and
// the era field exists so rule 1 has something to key on.

import { sanitizeValue } from './permission-sanitize.mjs';

/**
 * The nested result version historical reports carried. PRIVATE now: no producer
 * emits it, and exporting it would invite a new one.
 */
const ASSURANCE_RESULT_SCHEMA_VERSION = 'runtime-host-assurance-result-1.0';

/** The three values a historical PRODUCER could write. */
const HISTORICAL_PRODUCER_STATUSES = Object.freeze(['covered', 'unassured', 'blocked']);

/**
 * The doctor report versions that COULD have carried an assurance section.
 *
 * ⚠ ABSENCE MEANS TWO DIFFERENT THINGS, and collapsing them was a measured
 * mis-statement waiting to happen (cross-host review of the removal). In a
 * `runtime-doctor-1.0` report, a missing section means the report predates the
 * section — `legacy-unassured` is the right answer. In `1.1` and later, absence
 * is NORMAL: no producer writes the section any more, and reporting "it predates
 * the section" about a report written after its removal is simply false.
 */
const ASSURANCE_BEARING_REPORT_SCHEMAS = Object.freeze(['runtime-doctor-1.0']);

/** A report written after the removal carries no assurance answer, and says so. */
const NOT_APPLICABLE_ASSURANCE = Object.freeze({
  status: 'not-applicable',
  schema_era: 'post-assurance',
  grant_id: null,
  direction: null,
  reason: 'this report was written after the compatibility-assurance layer was removed (ADR-0056), so it carries no assurance answer — which is not the same as predating one',
});

/**
 * The complete reader vocabulary — the three historical producer values plus the
 * two a reader alone can reach. Exported because `dashboard` renders it and a
 * private second copy is the failure ADR-0051 §Decision 4 removes.
 */
export const RECORDED_ASSURANCE_STATUSES = Object.freeze([
  ...HISTORICAL_PRODUCER_STATUSES,
  // No recorded run at all — NOT the same as a run that predates the section.
  // The remedies differ: record a proof, versus re-record it.
  'no-recorded-run',
  // A report from AFTER the removal. Distinct from `legacy-unassured` in the
  // one way that matters: nothing is missing from it.
  'not-applicable',
  // A valid historical artifact carrying no assurance section.
  'legacy-unassured',
  // The section is present and this reader cannot read it. Never collapsed into
  // `legacy-unassured`: the two call for opposite actions (upgrade versus
  // re-run).
  'unreadable',
]);

/**
 * The era every value from this module belongs to.
 *
 * ⚠ IT TRAVELS WITH THE STATUS (ADR-0056 §Decision 6 rule 2). A consumer that
 * kept the token and dropped the era would be free to read a historical
 * `covered` as a present-tense verdict, which is precisely the fail-open the
 * ADR names.
 */
export const ASSURANCE_SCHEMA_ERA = 'assurance-era';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A grant id a past review could have written. PRIVATE and decode-only: the
 * shape is still needed to refuse a corrupt historical `covered`, but nothing
 * mints one any more.
 */
const GRANT_ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/;

export const NO_RECORDED_ASSURANCE = Object.freeze({
  status: 'no-recorded-run',
  schema_era: ASSURANCE_SCHEMA_ERA,
  grant_id: null,
  direction: null,
  reason: 'no runtime:doctor artifact has been recorded, so no assurance verdict was ever written down here',
});

/**
 * Read a HISTORICAL assurance answer out of a recorded doctor report.
 * FAIL-CLOSED, and present-tense-free.
 *
 *   no report / no section  → `legacy-unassured` — readable, never malformed.
 *   unknown version/status  → `unreadable` — this reader is too old for it.
 *   a historical status     → carried verbatim, with its grant id and its era.
 *
 * The `covered`-without-a-`grant_id` case is refused rather than trusted: no
 * producer could emit it, so a report carrying it is corrupt.
 */
export function projectRecordedAssurance(report) {
  // ⚠ SECOND GUARD, labelled rather than left to look tested. Mutation-verified
  // when it was written: deleting this line turns no test red, because the
  // reachable site is the caller's fallback. It stays because a future caller
  // reading an artifact whose `report` key is absent would otherwise fall
  // through to `legacy-unassured` and assert something about a document that
  // does not exist.
  if (report === undefined || report === null) return NO_RECORDED_ASSURANCE;
  // The REPORT VERSION decides what absence means, before absence is read. A
  // post-removal report has no section by design; only a report from an era that
  // could have carried one may be called `legacy-unassured`.
  const reportSchema = typeof report?.schema_version === 'string' ? report.schema_version.trim() : null;
  const section = report?.host_parity_assurance;
  if ((section === undefined || section === null)
    && reportSchema !== null
    && !ASSURANCE_BEARING_REPORT_SCHEMAS.includes(reportSchema)) {
    return NOT_APPLICABLE_ASSURANCE;
  }
  if (section === undefined || section === null) {
    return {
      status: 'legacy-unassured',
      schema_era: ASSURANCE_SCHEMA_ERA,
      grant_id: null,
      direction: null,
      reason: 'the recorded report carries no assurance result — it predates the section (or postdates its removal), so it is readable but establishes nothing',
    };
  }
  if (!isPlainObject(section)
    || section.schema_version !== ASSURANCE_RESULT_SCHEMA_VERSION
    || !HISTORICAL_PRODUCER_STATUSES.includes(section.status)
    || (section.status === 'covered' && !GRANT_ID_RE.test(String(section.evidence?.grant_id ?? '')))) {
    return {
      status: 'unreadable',
      schema_era: ASSURANCE_SCHEMA_ERA,
      grant_id: null,
      direction: null,
      reason: 'the recorded report carries an assurance result this runtime does not read',
    };
  }
  return {
    status: section.status,
    schema_era: ASSURANCE_SCHEMA_ERA,
    grant_id: sanitizeValue(section.evidence?.grant_id) ?? null,
    direction: sanitizeValue(section.evidence?.direction?.state) ?? null,
    // Carried, not dropped: a historical `covered` row that hides which
    // installed packages no reviewer bound is the same silence the field was
    // added to break.
    unbound_packages: Object.freeze(
      (Array.isArray(section.evidence?.unbound_packages) ? section.evidence.unbound_packages : [])
        .map((name) => sanitizeValue(name))
        .filter(Boolean),
    ),
    reason: null,
  };
}
