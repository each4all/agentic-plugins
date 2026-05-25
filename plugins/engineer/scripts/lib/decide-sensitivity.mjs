// Per-axis ±20% sensitivity analysis for /engineer:decide (ADR-0027 PR4 Task 5
// + refine M3).
//
// Library mode only — pure function, no I/O. Consumes the score module
// (decide-scores.mjs) for aggregate re-computation under each perturbation.
//
// API:
//   analyzeSensitivity({options, axes, weights, weightsExplicit, size})
//     -> { applied: boolean, flipped: boolean, flips: Flip[],
//          unperturbed_top: string|null, diagnostic: string|null }
//
//   Flip = { axis: string, direction: "+20%" | "-20%", newRecommendation: string }
//
// Peer M3 refine: the unperturbed aggregate top is computed INTERNALLY by
// running `recommendByAggregate` on the baseline weights (uniform-expanded
// when `weights === {}`). Flip detection then compares each perturbed top
// against this internal unperturbed top. The previous caller-supplied
// `baseline` parameter conflated "§1.3-vs-aggregate divergence" with
// "perturbation flip" — callers that pass the §1.3 winner would have
// reported every perturbation as a flip in pure divergence cases.
// `unperturbed_top` is now exposed on the result so a caller comparing
// against §1.3 (the divergence detector) reads it from the result rather
// than supplying it as input.
//
// Opt-in gate (peer G3 fix — explicit boolean, NOT object identity):
//   applied=true   when weightsExplicit === true OR size === "major"
//   applied=false  otherwise
//
// Per-axis perturbation: each axis weight independently multiplied by 1.20
// and 0.80. The recommendation is re-computed via decide-scores;
// `newRecommendation !== baseline` is a flip entry. Combined perturbation
// (multiple axes simultaneously) is NOT explored — it explodes
// exponentially and provides less diagnostic value than per-axis traces.
//
// Sentinel handling: `weights === {}` is the ADR §5.6 uniform sentinel.
// `effectiveWeight` (imported from decide-scores) returns 1.0 for any
// axis when the map is empty, so the spread `{ ...weights, [id]: w*f }`
// produces a single-entry map that aggregateOption interprets correctly
// (unmentioned axes fall back to 1.0 via the same effectiveWeight).
// PR4 refine M8: the previous `uniformExpand` helper was dead defensive
// code — its claim that "{}[axis] * 1.20 = NaN" was incorrect because
// `baseW` is always computed via `effectiveWeight`, which never returns
// undefined. The helper has been removed.
//
// Two-option single-differentiator guard (peer (f)): when options.length=2
// and exactly one axis differs between them, positive-weight perturbation
// is mathematically guaranteed not to reverse order. Return applied:true
// + empty flips + a clear diagnostic so the user knows the analysis
// completed with a definitive "no flips possible" finding rather than
// silently producing empty flips.

// PR4 refine: `effectiveWeight` is imported from decide-scores.mjs to
// eliminate the byte-duplicate copy that previously lived here (Co3 finding —
// future-divergence risk between sibling modules).
import { aggregateOption, recommendByAggregate, effectiveWeight } from "./decide-scores.mjs";

const PERTURBATION_FACTORS = Object.freeze([
  Object.freeze({ factor: 1.20, label: "+20%" }),
  Object.freeze({ factor: 0.80, label: "-20%" }),
]);

export function analyzeSensitivity({
  options = [],
  axes = [],
  weights = {},
  weightsExplicit = false,
  size = "standard",
  // `baseline` is accepted for backward compatibility with Task 5 test
  // signatures but is IGNORED — peer M3 refine: unperturbed top is computed
  // internally to avoid §1.3-vs-aggregate divergence being misread as a
  // perturbation flip.
  baseline: _ignoredBaseline = undefined,
} = {}) {
  // Opt-in gate
  if (!weightsExplicit && size !== "major") {
    return { applied: false, flipped: false, flips: [], unperturbed_top: null, diagnostic: null };
  }
  if (!Array.isArray(options) || options.length < 2) {
    return {
      applied: false,
      flipped: false,
      flips: [],
      unperturbed_top: null,
      diagnostic: "sensitivity requires at least 2 options",
    };
  }

  // Peer M3 refine: compute the unperturbed aggregate top INTERNALLY.
  // This is the reference against which each perturbation's top is
  // compared — a flip means "perturbation changes the aggregate winner",
  // distinct from "aggregate winner ≠ §1.3 decisive-axis winner"
  // (the divergence case, which is a separate check the caller performs).
  //
  // PR4 refine M8: pass `weights` directly — effectiveWeight handles
  // the empty-sentinel case uniformly so there is no need to pre-expand.
  const baselineOptions = options.map((opt) => ({
    letter: opt.letter,
    grades: opt.grades,
    aggregate: aggregateOption({
      grades: opt.grades ?? {},
      weights,
      axes,
    }).score,
  }));
  const baselineRec = recommendByAggregate({
    options: baselineOptions,
    axes,
    weights,
  });
  const unperturbedTop = baselineRec.letter;

  // PR4 refine peer M-final — short-circuit when no option has a scoreable
  // aggregate. Two root causes both produce `unperturbedTop === null`:
  //   (a) all axes have zero weight → aggregateOption denominator=0
  //   (b) every option has all-missing/invalid grades → aggregate=null
  // Without this guard the per-axis loop below would silently return
  // `{flipped:false, flips:[], unperturbed_top:null, diagnostic:null}` —
  // readable as "stable under perturbation" when the truth is "no analysis
  // was possible". Diagnostic text covers both roots so the P-MIN2
  // all-zero-weight case (existing test pattern `/zero weight|no perturbation/`)
  // and the all-null-grade case are both surfaced.
  if (unperturbedTop === null) {
    return {
      applied: true,
      flipped: false,
      flips: [],
      unperturbed_top: null,
      diagnostic: `no perturbation analysis possible — ${baselineRec.diagnostic ?? "no scoreable baseline aggregate"} (likely all axes zero-weight or all grades missing)`,
    };
  }

  // Two-option single-differentiator guard (peer (f))
  if (options.length === 2) {
    const [a, b] = options;
    const differentiators = axes.filter((ax) => {
      const gA = a.grades?.[ax.id] ?? null;
      const gB = b.grades?.[ax.id] ?? null;
      return gA !== gB;
    });
    if (differentiators.length === 1) {
      return {
        applied: true,
        flipped: false,
        flips: [],
        unperturbed_top: unperturbedTop,
        diagnostic:
          "two-option scenario — perturbation cannot flip when one axis is the only differentiator",
      };
    }
  }

  const flips = [];
  let nonZeroAxesCount = 0;
  for (const axis of axes) {
    const baseW = effectiveWeight(weights, axis.id);
    if (baseW === 0) continue; // perturbing 0 is 0 — no-op axis
    nonZeroAxesCount++;
    for (const { factor, label } of PERTURBATION_FACTORS) {
      const perturbedWeights = { ...weights, [axis.id]: baseW * factor };
      const perturbedOptions = options.map((opt) => ({
        letter: opt.letter,
        grades: opt.grades,
        aggregate: aggregateOption({
          grades: opt.grades ?? {},
          weights: perturbedWeights,
          axes,
        }).score,
      }));
      const newRec = recommendByAggregate({
        options: perturbedOptions,
        axes,
        weights: perturbedWeights,
      });
      // Peer M3 refine: compare against internal unperturbed top
      if (newRec.letter && newRec.letter !== unperturbedTop) {
        flips.push({
          axis: axis.id,
          direction: label,
          newRecommendation: newRec.letter,
        });
      }
    }
  }

  // PR4 refine P-MIN2: if every axis has zero weight, no perturbation
  // actually ran. The result `{flipped:false, flips:[]}` would otherwise
  // read like "stable under perturbation" — but the analysis was a no-op.
  // Surface this explicitly so the LLM does not present zero-weight
  // sensitivity output as a stability claim.
  const diagnostic = nonZeroAxesCount === 0
    ? "all axes have zero weight — no perturbation analysis possible"
    : null;

  return {
    applied: true,
    flipped: flips.length > 0,
    flips,
    unperturbed_top: unperturbedTop,
    diagnostic,
  };
}
