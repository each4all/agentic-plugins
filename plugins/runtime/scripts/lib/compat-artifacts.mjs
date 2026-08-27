// plugins/runtime/scripts/lib/compat-artifacts.mjs
//
// ADR-0053 §Decision 4, as amended by ADR-0056 §Decision 5 — the compat artifact
// vocabulary, owned in ONE place.
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
// validated no artifact family. A gap artifact declaring `runtime-compat-gap-9.9`
// — a schema from a runtime that does not exist yet — read as `available /
// current`, because `readOptionalJson` only parses JSON and every branch below it
// switches on the persisted `overall.status` string.

/**
 * The families this runtime WRITES.
 *
 * `1.1` added `overall.assurance`; `1.2` removes it (ADR-0056 §Decision 5). The
 * snapshot moves in lockstep because it carried the host/package facts that
 * result was computed from — a snapshot and a gap that disagreed about which
 * schema era they belong to would be the exact ambiguity this pair exists to
 * remove.
 */
export const COMPAT_SNAPSHOT_SCHEMA = 'runtime-compat-snapshot-1.2';
export const COMPAT_GAP_SCHEMA = 'runtime-compat-gap-1.2';
export const COMPAT_PLAN_SCHEMA = 'runtime-compat-plan-1.2';

/**
 * The gap schemas this runtime READS, EXACTLY.
 *
 * ⚠ EXACT, NOT "any 1.x". An earlier draft accepted any readable MAJOR, and
 * cross-host review named the hole: a future MINOR may add a NARROWING field — a
 * condition that restricts what a recorded verdict covers — and a reader that
 * skips the field it has never heard of turns a restricted verdict into an
 * unrestricted one.
 *
 * All three eras are listed because all three are REAL history on disk.
 */
export const READABLE_GAP_SCHEMAS = Object.freeze([
  'runtime-compat-gap-1.0',
  'runtime-compat-gap-1.1',
  'runtime-compat-gap-1.2',
]);

/**
 * THREE eras, not two, and the third is the reason this shape changed.
 *
 * ⚠ MEASURED FAILURE OF THE TWO-ERA SHAPE (ADR-0056 §Decision 5). `projectGapFamily`
 * used to distinguish pre-assurance `1.0` from assurance-era `1.1` by asking
 * whether the schema was in an `ASSURANCE_BEARING` list — so every family NOT in
 * that list took the legacy branch. Merely adding `1.2` to the readable list
 * would therefore have classified a *post*-assurance artifact, written by this
 * very runtime, as `legacy`: readable but establishing nothing, with a next step
 * telling the operator to take a fresh snapshot that would produce the same
 * verdict again.
 *
 * The eras are named explicitly instead, and every readable family belongs to
 * exactly one. A family absent from this map is `unrecognized`, which is the
 * fail-closed direction and the reason the map is total rather than a default.
 */
export const GAP_SCHEMA_ERAS = Object.freeze({
  'runtime-compat-gap-1.0': 'pre-assurance',
  'runtime-compat-gap-1.1': 'assurance-era',
  'runtime-compat-gap-1.2': 'post-assurance',
});

/** The same three eras for the SNAPSHOT half of a run. */
export const SNAPSHOT_SCHEMA_ERAS = Object.freeze({
  'runtime-compat-snapshot-1.0': 'pre-assurance',
  'runtime-compat-snapshot-1.1': 'assurance-era',
  'runtime-compat-snapshot-1.2': 'post-assurance',
});

/**
 * The PLAN families this runtime reads, and their eras.
 *
 * ⚠ THE PLAN NEEDED ITS OWN READER, and the reason is a measured override.
 * `lib/state-readers.mjs` lets a `plan.json` outrank the gap's status, and it
 * switched on the persisted `plan.status` string with no family check at all —
 * so an assurance-era plan carrying `blocked_assurance` or
 * `blocked_legacy_unassured` matched neither of the two statuses that branch
 * names and fell through to `plan_ready`. A verdict from the removed layer would
 * have presented itself as this era's "there is a plan to act on"
 * (cross-host review of the removal).
 */
export const PLAN_SCHEMA_ERAS = Object.freeze({
  'runtime-compat-plan-1.0': 'pre-assurance',
  'runtime-compat-plan-1.1': 'assurance-era',
  'runtime-compat-plan-1.2': 'post-assurance',
});

/**
 * FAIL-CLOSED family projection for a persisted plan artifact.
 *
 * Same three outcomes as the gap's, for the same reasons. `legacy` here means
 * the plan may be POINTED AT but may not decide a status: its vocabulary was
 * written against a readiness ladder this runtime no longer implements.
 */
export function projectPlanFamily(planJson) {
  const schema = typeof planJson?.schema_version === 'string' ? planJson.schema_version.trim() : null;
  const era = schema === null ? null : PLAN_SCHEMA_ERAS[schema] ?? null;
  if (era === null) {
    return { kind: 'unrecognized', schema, era: null };
  }
  return { kind: era === 'post-assurance' ? 'readable' : 'legacy', schema, era };
}

/**
 * The complete producer status vocabulary for `gap.overall.status` in `1.2`.
 *
 * FOUR values. The `1.1` additions — `assurance_blocked`, `legacy_unassured`,
 * `assured`, `unassured` — are gone with the layer that produced them. What
 * remains is the pre-assurance ladder, which is what removing §Decision 4's
 * classification returns compat to.
 */
export const COMPAT_GAP_STATUSES = Object.freeze([
  // Integrity, ordered above every readiness answer (ADR-0053 §Decision 3).
  'baseline_unusable',
  // ⚠ THE SNAPSHOT FAMILY GUARD, KEPT UNDER A NEW NAME. Under `1.1` an unknown
  // snapshot family reached `assurance_blocked`, so deleting the assurance
  // statuses without a replacement would have deleted a fail-closed guard the
  // removal never asked for: a snapshot written by a FUTURE runtime may carry a
  // narrowing field this one does not read, and re-checking it must not mint a
  // fresh, current-looking gap. Its own token, because the failure is neither
  // the baseline's nor a readiness answer.
  'snapshot_unreadable',
  // A host printed a version this reader cannot carry faithfully (more than
  // three components, or trailing residue). Its own token because the repair is
  // the HOST, not the package and not the artifact.
  'host_version_unreadable',
  'release_notes_required',
  'current',
  'gap_analysis_ready',
]);

/**
 * The statuses a HISTORICAL artifact may carry, read but never re-interpreted
 * (ADR-0056 §Decision 5: "Historical records are not reinterpreted").
 *
 * ⚠ `current` APPEARS IN BOTH LISTS AND MEANS TWO DIFFERENT THINGS. Under `1.1`
 * it required `covered` — a human grant naming this host pair — as well as no
 * drift. Under `1.2` it means no drift alone. That is why no consumer may read
 * an era's status without its era, and why `READY_COMPAT_STATUSES` below is
 * scoped to one era rather than to a token.
 */
export const HISTORICAL_GAP_STATUSES = Object.freeze([
  'baseline_unusable',
  'assurance_blocked',
  'legacy_unassured',
  'release_notes_required',
  'current',
  'assured',
  'unassured',
  'gap_analysis_ready',
]);

/**
 * The subset a consumer may treat as a healthy compat state — AND the era it
 * must belong to.
 *
 * ⚠ THE ERA IS PART OF THE RULE, not context around it (ADR-0056 §Decision 6
 * rules 1 and 2). The cross-host review of the removal measured the fail-open
 * that follows from dropping it: cutover's freshness check computed
 * `recordedReady` from the stored status AND a separate live-coverage clause,
 * and it was the live clause — not exactness — that stopped a stored bit from
 * passing alone. Delete the live clause without replacing it and an old `1.1`
 * run whose status was `current` or `assured` satisfies current readiness,
 * because both tokens still parse. Requiring `post-assurance` is the
 * replacement: a record from the assurance era is readable evidence of the past
 * and is never a current verdict, whatever token it carries.
 */
export const READY_COMPAT_STATUSES = Object.freeze(['current']);
export const READY_COMPAT_ERA = 'post-assurance';

/** Is this projection a CURRENT healthy compat state? Era first, then token. */
export function isReadyCompatState({ status, schemaEra } = {}) {
  return schemaEra === READY_COMPAT_ERA && READY_COMPAT_STATUSES.includes(status);
}

/**
 * FAIL-CLOSED family projection for a persisted gap artifact.
 *
 * Four outcomes, and collapsing any pair of them loses an operator action:
 *
 *   `unrecognized` — this runtime cannot read the artifact. UPGRADE; re-running
 *                    `check` writes the same bytes again.
 *   `legacy`       — readable, from an earlier era, establishes no CURRENT
 *                    verdict. Take a FRESH snapshot.
 *   `readable`     — written by this era's producer and may be read as current.
 *
 * The `era` travels out with every outcome, because ADR-0056 §Decision 6 rule 2
 * makes it the thing rule 1 keys on.
 *
 * @param {object?} gapJson the parsed `gap-analysis.json`, or null/undefined.
 */
/**
 * The OLDER of two era names. Ordered explicitly rather than by array index, so
 * an era added in the middle cannot silently reorder the comparison.
 *
 * An UNKNOWN era name is the oldest of all: a value this runtime does not
 * recognise is not evidence that the artifact belongs to the current contract,
 * which is the fail-closed direction.
 */
const ERA_ORDER = Object.freeze(['pre-assurance', 'assurance-era', 'post-assurance']);
function oldestEra(a, b) {
  const rank = (era) => {
    const index = ERA_ORDER.indexOf(era);
    return index === -1 ? -1 : index;
  };
  return rank(a) <= rank(b) ? a : b;
}

export function projectGapFamily(gapJson) {
  const schema = typeof gapJson?.schema_version === 'string' ? gapJson.schema_version.trim() : null;
  if (schema === null || !READABLE_GAP_SCHEMAS.includes(schema)) {
    return {
      kind: 'unrecognized',
      schema,
      era: null,
      reason: 'the recorded gap analysis declares a compatibility schema this runtime does not read — '
        + 'upgrade the runtime plugin rather than re-running check, because an unread narrowing field '
        + 'is how a restricted verdict becomes an unrestricted one',
    };
  }
  // ⚠ THE OLDER OF THE TWO ERAS WINS, and this closes a measured laundering
  // path (cross-host review of the removal). `check` re-reads ANY selected
  // snapshot and writes a gap in THIS runtime's family, so checking a `1.0` or
  // `1.1` snapshot produces a `runtime-compat-gap-1.2` artifact. Reading only
  // the gap's own schema would then label that artifact `post-assurance` and
  // admit it to the ready set — an observation taken under the old contract
  // promoted into the current one by nothing more than being re-read. The gap
  // records where it came from (`overall.snapshot_schema_era`); a gap that does
  // not name a source is treated as its own era, which is correct for every
  // artifact written before the field existed and for the pre-`1.2` families
  // that are legacy on their own account anyway.
  const gapEra = GAP_SCHEMA_ERAS[schema] ?? null;
  const sourceEra = typeof gapJson?.overall?.snapshot_schema_era === 'string'
    ? gapJson.overall.snapshot_schema_era.trim()
    : null;
  const era = sourceEra !== null && sourceEra !== gapEra ? oldestEra(gapEra, sourceEra) : gapEra;
  // The SCHEMA decides which era an artifact belongs to, never its content.
  // Asking "is there an assurance section?" was measured wrong: a `1.0` artifact
  // carrying a hand-added assurance block read as `readable`, so an edited legacy
  // file could inject a verdict into a plane whose whole purpose was that only a
  // human grant produced one. The same rule now keeps a hand-edited `1.1` from
  // presenting itself as this era's work.
  if (era !== 'post-assurance') {
    return {
      kind: 'legacy',
      schema,
      era,
      reason: sourceEra !== null && sourceEra !== gapEra
        ? `the recorded gap analysis was written by this runtime but computed from a ${sourceEra} snapshot, so it is an observation taken under an earlier contract rather than a current verdict. Take a fresh snapshot, then runtime:compat check.`
        : era === 'assurance-era'
        ? 'the recorded gap analysis was written by the compatibility-assurance era, whose readiness statuses required a human grant that no longer exists (ADR-0056 §Decision 5). It is readable history and never a current verdict. Take a fresh snapshot, then runtime:compat check.'
        : 'the recorded gap analysis predates the compatibility-assurance era, so it is readable but establishes no current verdict. Take a fresh snapshot, then runtime:compat check.',
    };
  }
  return { kind: 'readable', schema, era, reason: null };
}
