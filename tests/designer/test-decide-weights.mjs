// Tests for plugins/designer/scripts/lib/decide-weights.mjs —
// weights normalization module (ADR-0027 §5.6 + PR4 Task 2).
//
// Contract:
//   normalizeWeights({rawSpec, axes, weightsExplicit}) → {weights, diagnostics}
//
//   - `weightsExplicit === false` → `{weights: {}, diagnostics: []}` (uniform
//     sentinel per ADR-0027 §5.6 — empty `{}` means "no --weights flag was
//     passed", treated downstream as uniform 1.0). `rawSpec` is ignored when
//     `weightsExplicit` is false.
//   - `weightsExplicit === true` → per-axis map. Every axis in `axes` is
//     present; weights mentioned in `rawSpec` get the parsed value, missing
//     axes are filled with 1.0. Unknown axis-ids (in `rawSpec` but not in
//     `axes`) are dropped with a diagnostic.
//   - Output `Object.keys(weights)` preserves `axes[].id` document order
//     (ADR-0027 §1.4 — reader honors document order).
//   - Fallback-axis-aware (peer G5): caller passes the actually-resolved
//     axes (registry preset OR in-code DEFAULT_FALLBACK); normalization
//     operates uniformly over both.

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { normalizeWeights } from "../../plugins/designer/scripts/lib/decide-weights.mjs";

// Minimal mock axes — matches the {id, …} shape decide-registry.mjs emits.
// The normalize module only reads `id`; other fields are not load-bearing.
const DEFAULT_AXES_5 = [
  { id: "essence" },
  { id: "foundation" },
  { id: "standards" },
  { id: "best-practice" },
  { id: "practical-fit" },
];

const NINE_AXES = [
  { id: "standards" },
  { id: "recommendation" },
  { id: "canonical-precedent" },
  { id: "essence" },
  { id: "foundation" },
  { id: "extensibility" },
  { id: "maintainability" },
  { id: "maturation" },
  { id: "practical-fit" },
];

test("uniform sentinel: weightsExplicit=false + rawSpec=undefined → {weights:{}, diagnostics:[]}", () => {
  const r = normalizeWeights({ rawSpec: undefined, axes: DEFAULT_AXES_5, weightsExplicit: false });
  assert.deepEqual(r.weights, {});
  assert.deepEqual(r.diagnostics, []);
});

test("uniform sentinel ignores rawSpec when weightsExplicit=false (defensive)", () => {
  // Parser will never emit rawSpec without weightsExplicit=true, but the
  // normalizer must be defensive — explicit-flag-presence is the source of
  // truth (peer G3).
  const r = normalizeWeights({ rawSpec: "essence:3", axes: DEFAULT_AXES_5, weightsExplicit: false });
  assert.deepEqual(r.weights, {});
});

test("explicit single pair on 5-axis default: missing axes filled with 1.0", () => {
  const r = normalizeWeights({ rawSpec: "essence:3", axes: DEFAULT_AXES_5, weightsExplicit: true });
  assert.deepEqual(r.weights, {
    essence: 3,
    foundation: 1,
    standards: 1,
    "best-practice": 1,
    "practical-fit": 1,
  });
  assert.deepEqual(r.diagnostics, []);
});

test("explicit multi-pair on 9-axis preset: all 9 axes present, mentioned ones get parsed weight", () => {
  const r = normalizeWeights({
    rawSpec: "essence:3,foundation:2,practical-fit:0.5",
    axes: NINE_AXES,
    weightsExplicit: true,
  });
  assert.equal(r.weights.essence, 3);
  assert.equal(r.weights.foundation, 2);
  assert.equal(r.weights["practical-fit"], 0.5);
  // Filled with 1.0
  assert.equal(r.weights.standards, 1);
  assert.equal(r.weights.recommendation, 1);
  assert.equal(r.weights["canonical-precedent"], 1);
  assert.equal(r.weights.extensibility, 1);
  assert.equal(r.weights.maintainability, 1);
  assert.equal(r.weights.maturation, 1);
  assert.equal(Object.keys(r.weights).length, 9);
  assert.deepEqual(r.diagnostics, []);
});

test("zero weight preserved (peer (c)): essence:0 → weights.essence === 0", () => {
  const r = normalizeWeights({ rawSpec: "essence:0", axes: DEFAULT_AXES_5, weightsExplicit: true });
  assert.equal(r.weights.essence, 0);
  assert.equal(r.weights.foundation, 1);
});

test("decimal weight preserved: essence:2.5 → weights.essence === 2.5", () => {
  const r = normalizeWeights({ rawSpec: "essence:2.5", axes: DEFAULT_AXES_5, weightsExplicit: true });
  assert.equal(r.weights.essence, 2.5);
});

test("axis document order preserved: Object.keys matches axes[].id order", () => {
  const r = normalizeWeights({ rawSpec: "practical-fit:5", axes: DEFAULT_AXES_5, weightsExplicit: true });
  assert.deepEqual(Object.keys(r.weights), ["essence", "foundation", "standards", "best-practice", "practical-fit"]);
});

test("9-axis preset preserves nine-axis-specific document order (standards first, not essence)", () => {
  const r = normalizeWeights({ rawSpec: "essence:3", axes: NINE_AXES, weightsExplicit: true });
  assert.deepEqual(Object.keys(r.weights), [
    "standards", "recommendation", "canonical-precedent",
    "essence", "foundation",
    "extensibility", "maintainability", "maturation", "practical-fit",
  ]);
});

test("unknown axis-id dropped with diagnostic (peer G2/G5): ghost:2 → ghost not in weights + diagnostic emitted", () => {
  const r = normalizeWeights({ rawSpec: "ghost:2", axes: DEFAULT_AXES_5, weightsExplicit: true });
  assert.equal(r.weights.ghost, undefined, "ghost must be dropped");
  // Known axes still present with 1.0 default
  assert.equal(r.weights.essence, 1);
  assert.equal(r.weights.foundation, 1);
  assert.equal(Object.keys(r.weights).length, 5);
  assert.equal(r.diagnostics.length, 1);
  assert.ok(/ghost/.test(r.diagnostics[0]), `expected diagnostic mentioning 'ghost'; got: ${r.diagnostics[0]}`);
});

test("mixed known + unknown: essence:3,ghost:2 → essence kept, ghost dropped + one diagnostic", () => {
  const r = normalizeWeights({ rawSpec: "essence:3,ghost:2", axes: DEFAULT_AXES_5, weightsExplicit: true });
  assert.equal(r.weights.essence, 3);
  assert.equal(r.weights.ghost, undefined);
  assert.equal(r.diagnostics.length, 1);
});

test("fallback-axis path (peer G5): same 5-axis result whether registry or DEFAULT_FALLBACK supplied", () => {
  // Caller passes whatever axes were resolved — registry preset OR fallback.
  // The normalizer is path-agnostic; result depends only on axes[].id set.
  const r = normalizeWeights({ rawSpec: "essence:3", axes: DEFAULT_AXES_5, weightsExplicit: true });
  assert.equal(r.weights.essence, 3);
  assert.equal(Object.keys(r.weights).length, 5);
  assert.deepEqual(r.diagnostics, []);
});

test("empty axes array (defensive edge — should never happen but normalizer doesn't crash)", () => {
  const r = normalizeWeights({ rawSpec: "essence:3", axes: [], weightsExplicit: true });
  // No axes to fill; spec axes are all unknown.
  assert.deepEqual(r.weights, {});
  assert.equal(r.diagnostics.length, 1);
});

test("explicit with no spec content (weightsExplicit=true, rawSpec=undefined) — defensive: empty map, no diagnostic", () => {
  // Parser would never emit this — it always sets rawSpec when weightsExplicit
  // is true. But the normalizer must not throw.
  const r = normalizeWeights({ rawSpec: undefined, axes: DEFAULT_AXES_5, weightsExplicit: true });
  // Treat as "explicit but no overrides" — all axes uniform 1.0
  assert.equal(r.weights.essence, 1);
  assert.equal(r.weights.foundation, 1);
  assert.equal(Object.keys(r.weights).length, 5);
  assert.deepEqual(r.diagnostics, []);
});

test("weight values are numbers, not strings (Number coercion)", () => {
  const r = normalizeWeights({ rawSpec: "essence:3", axes: DEFAULT_AXES_5, weightsExplicit: true });
  assert.equal(typeof r.weights.essence, "number");
  assert.equal(typeof r.weights.foundation, "number");
});

test("[peer M2 refine] unbounded decimal → Infinity → dropped with diagnostic, falls back to 1.0", () => {
  // WEIGHT_SPEC_RE accepts arbitrarily long digit strings (the `[1-9][0-9]*`
  // group is unbounded), so `essence:<400-digit>` passes parser shape check
  // but `Number()` returns Infinity. normalizeWeights MUST drop the
  // magnitude-rejected value with a diagnostic — NOT silently propagate
  // Infinity downstream where Σ math would explode.
  const hugeDigits = "9".repeat(400);
  const r = normalizeWeights({
    rawSpec: `essence:${hugeDigits}.5`,
    axes: DEFAULT_AXES_5,
    weightsExplicit: true,
  });
  // Filled with default 1.0 after the drop
  assert.equal(r.weights.essence, 1.0);
  assert.ok(r.diagnostics.some((d) => /finite|overflow/.test(d) && /essence/.test(d)),
    `expected finite/overflow diagnostic for essence; got: ${r.diagnostics.join(" | ")}`);
});

test("[peer M2 refine] finite decimal still accepted normally", () => {
  // Regression guard — finite values still go through unchanged.
  const r = normalizeWeights({ rawSpec: "essence:2.5", axes: DEFAULT_AXES_5, weightsExplicit: true });
  assert.equal(r.weights.essence, 2.5);
  assert.deepEqual(r.diagnostics, []);
});
