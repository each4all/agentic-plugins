// Tests for plugins/designer/scripts/lib/decide-scores.mjs —
// qualitative-to-score mapping + weighted aggregation + advisory-only
// recommendation (ADR-0027 §1.3 invariant + PR4 Task 4).
//
// CRITICAL CONTRACT (ADR-0027 §1.3 — peer G2 resolution Option A):
//   recommendByAggregate() is ADVISORY only. It returns the option with
//   the highest weighted aggregate score. It does NOT replace the
//   decisive-axis recommendation rule from SKILL.md @decide:recommendation-rule
//   (which lives in SKILL.md prose and engine-side §1.3 invariant guards).
//   Callers (skill body + Task 6 SKILL.md surfaces) must NOT use the
//   recommendByAggregate result as the winner — only as a comparison-table
//   advisory row + sensitivity-aggregate divergence signal.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import {
  GRADE_MARKERS,
  gradeToScore,
  aggregateOption,
  recommendByAggregate,
} from "../../plugins/designer/scripts/lib/decide-scores.mjs";

// Minimal default 5-axis mock (matches decide-registry.mjs default preset shape).
const DEFAULT_AXES_5 = [
  { id: "essence" },
  { id: "foundation" },
  { id: "standards" },
  { id: "best-practice" },
  { id: "practical-fit" },
];

// =====================
// GRADE_MARKERS constant — single source of truth
// =====================

test("GRADE_MARKERS: exports the canonical 4-marker set in HIGH→LOW order", () => {
  // Order matters — SKILL.md prose references the marker set in this order,
  // and Task 6 lint patterns will follow it.
  assert.deepEqual(GRADE_MARKERS, ["◎", "○", "△", "×"]);
});

// =====================
// gradeToScore — object-return API (peer (d) fix)
// =====================

test("gradeToScore: ◎ → {score:3, diagnostic:null}", () => {
  assert.deepEqual(gradeToScore("◎"), { score: 3, diagnostic: null });
});

test("gradeToScore: ○ → {score:2, diagnostic:null}", () => {
  assert.deepEqual(gradeToScore("○"), { score: 2, diagnostic: null });
});

test("gradeToScore: △ → {score:1, diagnostic:null}", () => {
  assert.deepEqual(gradeToScore("△"), { score: 1, diagnostic: null });
});

test("gradeToScore: × → {score:0, diagnostic:null}", () => {
  assert.deepEqual(gradeToScore("×"), { score: 0, diagnostic: null });
});

test("gradeToScore: null → {score:null, diagnostic:null} — absent grade is not an error", () => {
  // Absent grade is the default (LLM did not score this axis); not an
  // error condition. Diagnostic stays null.
  assert.deepEqual(gradeToScore(null), { score: null, diagnostic: null });
});

test("gradeToScore: undefined → {score:null, diagnostic:null}", () => {
  assert.deepEqual(gradeToScore(undefined), { score: null, diagnostic: null });
});

test("gradeToScore: unknown string → {score:null, diagnostic:'unrecognized grade'}", () => {
  // Peer (d) fix: distinguish "absent" from "invalid". Invalid carries a
  // diagnostic so the LLM mistyping a grade is surfaced, not silently
  // dropped as if it were missing.
  const r = gradeToScore("@");
  assert.equal(r.score, null);
  assert.ok(/unrecognized/i.test(r.diagnostic), `expected unrecognized diagnostic; got: ${r.diagnostic}`);
});

test("gradeToScore: empty string → {score:null, diagnostic:null} — equivalent to absent", () => {
  // Empty string represents "no grade given" in markdown (e.g., empty
  // cell in comparison table). Treat as absent, not invalid.
  assert.deepEqual(gradeToScore(""), { score: null, diagnostic: null });
});

// =====================
// aggregateOption — Σ(grade × weight) / Σ(weight) over scored axes
// =====================

test("aggregateOption: uniform weights + uniform grades → score equals grade value", () => {
  const grades = { essence: "◎", foundation: "◎", standards: "◎", "best-practice": "◎", "practical-fit": "◎" };
  const weights = { essence: 1, foundation: 1, standards: 1, "best-practice": 1, "practical-fit": 1 };
  const r = aggregateOption({ grades, weights, axes: DEFAULT_AXES_5 });
  assert.equal(r.score, 3);
  assert.deepEqual(r.missing, []);
  assert.equal(r.diagnostic, null);
});

test("aggregateOption: weighted favors heaviest axis", () => {
  // essence weight=10 with grade ◎ (3); others weight=1 with grade × (0)
  // → score = (3*10 + 0*4) / (10 + 4) = 30/14 ≈ 2.143
  const grades = { essence: "◎", foundation: "×", standards: "×", "best-practice": "×", "practical-fit": "×" };
  const weights = { essence: 10, foundation: 1, standards: 1, "best-practice": 1, "practical-fit": 1 };
  const r = aggregateOption({ grades, weights, axes: DEFAULT_AXES_5 });
  // ≈ 2.1428…
  assert.ok(r.score > 2.0 && r.score < 2.5, `expected ~2.143; got: ${r.score}`);
  assert.deepEqual(r.missing, []);
});

test("aggregateOption: missing grade axis excluded from denominator + reported in missing[]", () => {
  // foundation grade is null → exclude from both numerator and denominator
  const grades = { essence: "◎", foundation: null, standards: "○", "best-practice": "○", "practical-fit": "○" };
  const weights = { essence: 1, foundation: 1, standards: 1, "best-practice": 1, "practical-fit": 1 };
  const r = aggregateOption({ grades, weights, axes: DEFAULT_AXES_5 });
  // score = (3 + 2 + 2 + 2) / 4 = 9/4 = 2.25
  assert.equal(r.score, 2.25);
  assert.deepEqual(r.missing, ["foundation"]);
});

test("aggregateOption: all axes zero-weight → {score:null, diagnostic} per peer G7", () => {
  const grades = { essence: "◎", foundation: "○" };
  const weights = { essence: 0, foundation: 0 };
  const axes = [{ id: "essence" }, { id: "foundation" }];
  const r = aggregateOption({ grades, weights, axes });
  assert.equal(r.score, null);
  assert.ok(/zero.weight|all.*zero/i.test(r.diagnostic), `expected zero-weight diagnostic; got: ${r.diagnostic}`);
});

test("aggregateOption: mixed zero + non-zero weights → only non-zero axes contribute", () => {
  // essence weight=2 grade ◎ (3); foundation weight=0 grade × (0) excluded;
  // score = (3*2)/(2) = 3
  const grades = { essence: "◎", foundation: "×" };
  const weights = { essence: 2, foundation: 0 };
  const axes = [{ id: "essence" }, { id: "foundation" }];
  const r = aggregateOption({ grades, weights, axes });
  assert.equal(r.score, 3);
});

test("aggregateOption: invalid grade dropped from numerator + reported in missing[]", () => {
  // Invalid grade is treated like missing for aggregation (excluded), but
  // surfaces via diagnostic field.
  const grades = { essence: "◎", foundation: "@INVALID@", standards: "○", "best-practice": "○", "practical-fit": "○" };
  const weights = { essence: 1, foundation: 1, standards: 1, "best-practice": 1, "practical-fit": 1 };
  const r = aggregateOption({ grades, weights, axes: DEFAULT_AXES_5 });
  // foundation excluded → score = (3+2+2+2)/4 = 2.25
  assert.equal(r.score, 2.25);
  assert.ok(r.missing.includes("foundation"));
  // diagnostic should mention the invalid grade
  assert.ok(/foundation|unrecognized/i.test(r.diagnostic ?? ""), `expected invalid-grade diagnostic; got: ${r.diagnostic}`);
});

test("aggregateOption: uniform sentinel weights {} treated as uniform 1.0 per ADR §5.6", () => {
  // The score module accepts the {} sentinel directly — caller does not
  // need to pre-expand. This matches normalizeWeights downstream contract.
  const grades = { essence: "◎", foundation: "○", standards: "○", "best-practice": "○", "practical-fit": "○" };
  const r = aggregateOption({ grades, weights: {}, axes: DEFAULT_AXES_5 });
  // (3 + 2 + 2 + 2 + 2) / 5 = 11/5 = 2.2
  assert.equal(r.score, 2.2);
});

test("[L4.7 refine] sentinel {} equivalence: aggregateOption({}) === aggregateOption({all axes: 1.0}) for the same grades", () => {
  // The semantic foundation of the uniform-sentinel pattern: an empty `{}`
  // weight map must produce a numerically identical aggregate to an
  // explicit map filled with 1.0 for every axis. Without this invariant,
  // the SKILL.md gate that distinguishes "no --weights flag" (sentinel)
  // from "explicit uniform --weights=essence:1,..." (filled) would
  // produce different aggregates, breaking the backward-compat
  // expectation. Pin it directly here so refactors of effectiveWeight
  // cannot drift the two paths apart.
  const grades = { essence: "◎", foundation: "○", standards: "△", "best-practice": "○", "practical-fit": "△" };
  const sentinel = aggregateOption({ grades, weights: {}, axes: DEFAULT_AXES_5 });
  const explicitUniform = aggregateOption({
    grades,
    weights: { essence: 1, foundation: 1, standards: 1, "best-practice": 1, "practical-fit": 1 },
    axes: DEFAULT_AXES_5,
  });
  assert.equal(sentinel.score, explicitUniform.score, "sentinel and explicit-uniform must produce identical aggregates");
  assert.deepEqual(sentinel.missing, explicitUniform.missing);
});

test("aggregateOption: all grades missing → {score:null, missing: all axes}", () => {
  const grades = {};
  const r = aggregateOption({ grades, weights: {}, axes: DEFAULT_AXES_5 });
  assert.equal(r.score, null);
  assert.deepEqual(r.missing.sort(), ["best-practice", "essence", "foundation", "practical-fit", "standards"]);
});

// =====================
// recommendByAggregate — ADVISORY ONLY (does NOT replace §1.3 decisive rule)
// =====================

test("recommendByAggregate: clear winner — highest aggregate returned", () => {
  const options = [
    { letter: "A", aggregate: 2.8, grades: { essence: "◎", "practical-fit": "○" }, missing: [] },
    { letter: "B", aggregate: 1.5, grades: { essence: "△", "practical-fit": "○" }, missing: [] },
    { letter: "C", aggregate: 2.2, grades: { essence: "○", "practical-fit": "○" }, missing: [] },
  ];
  const r = recommendByAggregate({ options, axes: DEFAULT_AXES_5 });
  assert.equal(r.letter, "A");
  assert.equal(r.advisory, true, "result MUST carry advisory=true marker per ADR §1.3");
});

test("recommendByAggregate: tie-break by practical-fit raw grade (when weight > 0)", () => {
  // A and B tie on aggregate (2.0); A has practical-fit=◎, B has practical-fit=△
  // → A wins on tie-break.
  const options = [
    { letter: "A", aggregate: 2.0, grades: { essence: "○", "practical-fit": "◎" }, missing: [] },
    { letter: "B", aggregate: 2.0, grades: { essence: "○", "practical-fit": "△" }, missing: [] },
  ];
  const r = recommendByAggregate({ options, axes: DEFAULT_AXES_5, weights: { essence: 1, "practical-fit": 1 } });
  assert.equal(r.letter, "A");
});

test("recommendByAggregate: nested tie (same practical-fit) → option-letter ASCII order", () => {
  // Both A and B have aggregate=2.0 AND practical-fit=◎ → ASCII order picks A
  const options = [
    { letter: "A", aggregate: 2.0, grades: { "practical-fit": "◎" }, missing: [] },
    { letter: "B", aggregate: 2.0, grades: { "practical-fit": "◎" }, missing: [] },
  ];
  const r = recommendByAggregate({ options, axes: DEFAULT_AXES_5, weights: {} });
  assert.equal(r.letter, "A");
});

test("recommendByAggregate: tie-break practical-fit zero-weight → next axis in preset order", () => {
  // A and B tie on aggregate; practical-fit weight=0 → skip; fall through
  // to next axis (essence first per axes[] order) which has weight>0.
  // A.essence=◎, B.essence=○ → A wins.
  const options = [
    { letter: "A", aggregate: 2.0, grades: { essence: "◎", "practical-fit": "△" }, missing: [] },
    { letter: "B", aggregate: 2.0, grades: { essence: "○", "practical-fit": "◎" }, missing: [] },
  ];
  const r = recommendByAggregate({
    options,
    axes: DEFAULT_AXES_5,
    weights: { essence: 1, foundation: 1, standards: 1, "best-practice": 1, "practical-fit": 0 },
  });
  assert.equal(r.letter, "A");
});

test("recommendByAggregate: all options have null aggregate → {letter:null, diagnostic}", () => {
  const options = [
    { letter: "A", aggregate: null, grades: {}, missing: [] },
    { letter: "B", aggregate: null, grades: {}, missing: [] },
  ];
  const r = recommendByAggregate({ options, axes: DEFAULT_AXES_5 });
  assert.equal(r.letter, null);
  assert.ok(r.diagnostic, "expected diagnostic when no scoreable options");
});

test("recommendByAggregate: single option → returns that option (no tie-break needed)", () => {
  const options = [{ letter: "A", aggregate: 1.5, grades: {}, missing: [] }];
  const r = recommendByAggregate({ options, axes: DEFAULT_AXES_5 });
  assert.equal(r.letter, "A");
});

test("recommendByAggregate: empty options → {letter:null, diagnostic} — defensive", () => {
  const r = recommendByAggregate({ options: [], axes: DEFAULT_AXES_5 });
  assert.equal(r.letter, null);
  assert.ok(r.diagnostic);
});

test("recommendByAggregate: advisory=true marker present on EVERY non-null result (ADR §1.3 invariant)", () => {
  // Every recommendation result MUST carry advisory=true so callers can't
  // accidentally treat it as the §1.3 winner. This is the load-bearing
  // peer G2 resolution Option A guard.
  const cases = [
    { options: [{ letter: "A", aggregate: 2.0, grades: {}, missing: [] }] },
    { options: [{ letter: "A", aggregate: 3.0, grades: {}, missing: [] }, { letter: "B", aggregate: 1.0, grades: {}, missing: [] }] },
    { options: [{ letter: "A", aggregate: 2.0, grades: { "practical-fit": "◎" }, missing: [] }, { letter: "B", aggregate: 2.0, grades: { "practical-fit": "△" }, missing: [] }] },
  ];
  for (const c of cases) {
    const r = recommendByAggregate({ ...c, axes: DEFAULT_AXES_5, weights: {} });
    assert.equal(r.advisory, true, `advisory marker missing from result: ${JSON.stringify(r)}`);
  }
});

// =====================
// Two-option scenario (peer (f)) — sanity check, NOT a flip case
// =====================

test("aggregateOption two-option scenario (peer (f) sanity): perturbing the single differentiator axis cannot reverse order", () => {
  // A and B differ only on essence (A=◎, B=○). Both have practical-fit=○.
  // Whatever weight essence gets, A's aggregate ≥ B's aggregate as long as
  // essence weight ≥ 0. This is mathematical — perturbation cannot flip.
  // Task 5 sensitivity module's two-option guard is the policy layer;
  // this test pins the math invariant the policy rests on.
  const gradesA = { essence: "◎", "practical-fit": "○" };
  const gradesB = { essence: "○", "practical-fit": "○" };
  const axes = [{ id: "essence" }, { id: "practical-fit" }];
  for (const essenceWeight of [0.01, 1, 5, 100]) {
    const weights = { essence: essenceWeight, "practical-fit": 1 };
    const a = aggregateOption({ grades: gradesA, weights, axes });
    const b = aggregateOption({ grades: gradesB, weights, axes });
    assert.ok(a.score >= b.score, `essence weight=${essenceWeight}: expected A(${a.score}) >= B(${b.score})`);
  }
});

test("[PR4 refine Co4] two-option monotonicity — symmetric direction (B-favored) also cannot flip", () => {
  // Mirror of the above test. Swap which option has the higher grade on
  // the single differentiator axis (now B has ◎, A has ○). Mathematically
  // symmetric — perturbation cannot reverse order regardless of which
  // option is the high-grade one. Without this assertion the monotonicity
  // invariant was only pinned in one direction.
  const gradesA = { essence: "○", "practical-fit": "○" };
  const gradesB = { essence: "◎", "practical-fit": "○" };
  const axes = [{ id: "essence" }, { id: "practical-fit" }];
  for (const essenceWeight of [0.01, 1, 5, 100]) {
    const weights = { essence: essenceWeight, "practical-fit": 1 };
    const a = aggregateOption({ grades: gradesA, weights, axes });
    const b = aggregateOption({ grades: gradesB, weights, axes });
    assert.ok(b.score >= a.score, `essence weight=${essenceWeight}: expected B(${b.score}) >= A(${a.score})`);
  }
});

test("[PR4 refine P-MIN1] aggregateOption denominator-zero PRESERVES invalid-grade diagnostics", () => {
  // When all grades are typos (invalid), denominator=0 → no score, but the
  // invalidNotes accumulated above must surface in the diagnostic so the
  // LLM sees the per-axis "unrecognized grade" detail rather than only
  // "no grades supplied".
  const grades = { essence: "@bad@", foundation: "#typo#" };
  const weights = { essence: 1, foundation: 1 };
  const axes = [{ id: "essence" }, { id: "foundation" }];
  const r = aggregateOption({ grades, weights, axes });
  assert.equal(r.score, null);
  assert.ok(/essence/.test(r.diagnostic), `diagnostic must reference essence; got: ${r.diagnostic}`);
  assert.ok(/foundation/.test(r.diagnostic), `diagnostic must reference foundation; got: ${r.diagnostic}`);
  assert.ok(/unrecognized/i.test(r.diagnostic), `diagnostic must surface 'unrecognized' grade typo signal`);
});
