// Qualitative-to-score mapping + weighted aggregation + advisory-only
// recommendation for /engineer:decide (ADR-0027 §1.3 invariant + PR4 Task 4).
//
// ADR §1.3 INVARIANT (peer G2 resolution Option A):
//   The §1.3 recommendation rule ("decisive axes win, supporting axes
//   don't downgrade alone") is the source of truth for picking a winner.
//   `recommendByAggregate()` here is ADVISORY ONLY — it computes a
//   weighted-aggregate top option but every result carries `advisory: true`
//   so callers cannot accidentally treat it as the §1.3 winner.
//
// Library mode only — pure functions, no I/O. Consumers (Task 5
// sensitivity module + Task 6 SKILL.md surfaces via the runtime context)
// pass grades + weights + axes.
//
// API:
//   GRADE_MARKERS                                  -> ["◎","○","△","×"]
//   gradeToScore(grade)                            -> {score, diagnostic}
//   aggregateOption({grades, weights, axes})       -> {score, missing, diagnostic}
//   recommendByAggregate({options, axes, weights}) -> {letter, aggregate?, advisory:true, diagnostic?}

// HIGH → LOW order. SKILL.md prose + Task 6 lint reference this order.
export const GRADE_MARKERS = Object.freeze(["◎", "○", "△", "×"]);

const GRADE_TO_SCORE = Object.freeze({
  "◎": 3,
  "○": 2,
  "△": 1,
  "×": 0,
});

// gradeToScore: object-return API per peer (d) fix — distinguishes "absent"
// (returns score:null, diagnostic:null) from "invalid" (returns score:null,
// diagnostic:'unrecognized grade'). The empty string is treated as absent
// because markdown comparison-table cells render empty as "no grade given".
export function gradeToScore(grade) {
  if (grade === null || grade === undefined || grade === "") {
    return { score: null, diagnostic: null };
  }
  if (typeof grade !== "string") {
    return { score: null, diagnostic: `unrecognized grade type ${typeof grade}` };
  }
  if (Object.hasOwn(GRADE_TO_SCORE, grade)) {
    return { score: GRADE_TO_SCORE[grade], diagnostic: null };
  }
  return { score: null, diagnostic: `unrecognized grade "${grade}"` };
}

// Uniform-sentinel-aware weight lookup. Empty `{}` is the ADR §5.6 sentinel
// for "no --weights flag was passed", treated here as uniform 1.0. Explicit
// maps look up by axis-id with 1.0 fallback for unmentioned axes (matches
// normalizeWeights downstream contract — they MAY both fill or both rely
// on this lookup; behaviorally identical for the all-axes-present case).
//
// Exported so decide-sensitivity.mjs can reuse the same lookup without
// byte-for-byte duplication (PR4 refine M5: drift risk if the two copies
// diverge on a future edit).
export function effectiveWeight(weights, axisId) {
  if (!weights || Object.keys(weights).length === 0) return 1.0;
  return Object.hasOwn(weights, axisId) ? weights[axisId] : 1.0;
}

// aggregateOption: Σ(grade × weight) / Σ(weight) over scored axes only.
// Missing-grade axes are excluded from both numerator and denominator and
// reported in `missing[]`. Invalid grades are also excluded from the math
// (treated like missing for aggregation purposes) but surface via
// `diagnostic` so the LLM mistyping a grade is not silently dropped.
// Zero-weight axes contribute 0 to the denominator (the axis is essentially
// turned off for aggregate purposes).
export function aggregateOption({ grades = {}, weights = {}, axes = [] } = {}) {
  const missing = [];
  const invalidNotes = [];
  let numerator = 0;
  let denominator = 0;

  for (const axis of axes) {
    const w = effectiveWeight(weights, axis.id);
    const gRaw = grades[axis.id];
    const { score: gScore, diagnostic: gDiag } = gradeToScore(gRaw);
    if (gScore === null) {
      missing.push(axis.id);
      if (gDiag) invalidNotes.push(`${axis.id}: ${gDiag}`);
      continue;
    }
    if (w === 0) continue; // zero-weight axes excluded from aggregate
    numerator += gScore * w;
    denominator += w;
  }

  if (denominator === 0) {
    // Per peer G7: distinguish "all axes missing grades" from "all scored
    // axes have zero weight". Both produce a null aggregate but the
    // remediation differs.
    //
    // PR4 refine P-MIN1: when all grades were INVALID (typos rather than
    // missing), the invalidNotes collected above carry the per-axis
    // unrecognized-grade messages. Append them to the baseline diagnostic
    // so the LLM mistyping a grade sees the specific axis-level reason
    // instead of just "no grades supplied".
    const baseDiag = missing.length === axes.length
      ? "no grades supplied"
      : "all scored axes zero-weight";
    const diagnostic = invalidNotes.length > 0
      ? `${baseDiag}; ${invalidNotes.join("; ")}`
      : baseDiag;
    return { score: null, missing, diagnostic };
  }

  return {
    score: numerator / denominator,
    missing,
    diagnostic: invalidNotes.length > 0 ? invalidNotes.join("; ") : null,
  };
}

// Tie-break ladder for recommendByAggregate (called only when 2+ options
// have the same top aggregate). Order: practical-fit raw grade (if weight
// > 0) → remaining axes in preset document order (only those with weight
// > 0) → option-letter ASCII as the final fallback.
function tiebreakOptions(options, axes, weights) {
  if (options.length <= 1) return options[0] ?? null;

  const tieAxesOrder = [];
  // practical-fit gets first priority when it's in the preset AND has weight
  const pf = axes.find((a) => a.id === "practical-fit");
  if (pf && effectiveWeight(weights, "practical-fit") > 0) {
    tieAxesOrder.push("practical-fit");
  }
  for (const a of axes) {
    if (a.id === "practical-fit") continue;
    if (effectiveWeight(weights, a.id) > 0) tieAxesOrder.push(a.id);
  }

  let remaining = options.slice();
  for (const axisId of tieAxesOrder) {
    if (remaining.length <= 1) break;
    const scored = remaining.map((opt) => {
      const { score } = gradeToScore(opt.grades?.[axisId]);
      return { opt, s: score ?? -Infinity };
    });
    const best = scored.reduce((m, x) => (x.s > m ? x.s : m), -Infinity);
    const filtered = scored.filter(({ s }) => s === best).map(({ opt }) => opt);
    if (filtered.length < remaining.length) remaining = filtered;
  }

  if (remaining.length === 1) return remaining[0];
  // Final tie → option-letter ASCII order. PR4 refine Co1: use direct
  // string comparison rather than `localeCompare` to guarantee ASCII
  // semantics across locales (Turkish/etc. can perturb localeCompare
  // outcomes; for single-letter A-Z option ids this is theoretical
  // but pinning ASCII costs nothing).
  return remaining.slice().sort((a, b) =>
    a.letter < b.letter ? -1 : a.letter > b.letter ? 1 : 0,
  )[0];
}

// recommendByAggregate: ADVISORY ONLY. Every non-null result carries
// `advisory: true` so callers cannot treat it as the §1.3 decisive-axis
// winner. The §1.3 rule lives in SKILL.md prose (Task 6 surface).
//
// Input precondition (peer M6 refine): every entry in `options` MUST
// carry a pre-computed `aggregate: number | null` field (the option's
// weighted-aggregate score). `recommendByAggregate` does NOT call
// `aggregateOption` itself — it only ranks pre-computed aggregates.
// Callers (decide-sensitivity.mjs analyzeSensitivity + future skill-body
// rendering layer) are responsible for mapping
//   options[i] = { letter, grades, aggregate: aggregateOption(...).score }
// before passing the list in. Naive callers that pass raw grades-only
// options will see {letter:null, diagnostic:"no options have a
// scoreable aggregate"} because the filter at line 148 drops every entry
// whose `aggregate` is missing.
export function recommendByAggregate({ options = [], axes = [], weights = {} } = {}) {
  if (!Array.isArray(options) || options.length === 0) {
    return { letter: null, advisory: true, diagnostic: "no options supplied" };
  }
  const scoreable = options.filter(
    (o) => o && o.aggregate !== null && o.aggregate !== undefined && Number.isFinite(o.aggregate),
  );
  if (scoreable.length === 0) {
    return { letter: null, advisory: true, diagnostic: "no options have a scoreable aggregate" };
  }
  const top = Math.max(...scoreable.map((o) => o.aggregate));
  const tied = scoreable.filter((o) => o.aggregate === top);
  const winner = tied.length === 1 ? tied[0] : tiebreakOptions(tied, axes, weights);
  return {
    letter: winner.letter,
    aggregate: winner.aggregate,
    advisory: true,
    diagnostic: null,
  };
}
