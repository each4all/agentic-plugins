// End-to-end integration tests for /engineer:decide PR4 weighting + sensitivity
// (ADR-0027 Task 7).
//
// Drives `scripts/decide-registry.mjs resolve` as a subprocess across the
// full Phase 0.5 matrix to verify that all PR4 surfaces compose correctly
// — argument parser → registry resolver → ResolvedDecisionContext JSON.
//
// HONEST scope (peer G9 + M5 refine): subprocess tests prove
// `context.weights` JSON shape ONLY. Final markdown rendering (the LLM
// emitting `[grade: ◎]` suffixes, the weighted aggregate row, the
// sensitivity flip summary, AND the §1.3 advisory-only invariant
// preservation) is LLM-mediated and not deterministically testable
// from a subprocess.
//
// PR4 output invariants NOT covered here (LLM-prose contract only):
//
//   1. Default no-flag invocation MUST NOT emit grades, the weighted
//      aggregate row, or the sensitivity summary — `weights:{}` +
//      `weights_explicit:false` + `size:"standard"` is the trigger that
//      suppresses the entire `@decide:weighting-sensitivity-output` region.
//   2. §1.3 winner stability: when the weighted aggregate top option
//      diverges from the §1.3 decisive-axis winner, OR when sensitivity
//      reports `flipped:true`, the recommendation block adds advisory
//      lines and downgrades Confidence by ONE tier (capped) but the
//      recommended OPTION LETTER MUST NOT change. The §1.3 rule remains
//      the sole winner-picker.
//
// These invariants are enforced by the SKILL.md prose contract
// (`skills/decide/SKILL.md` `@decide:weighting-sensitivity-output` +
// `@decide:recommendation-rule`) and lint-checked by
// `tests/plugin-shape/test-engineer-plugin.mjs` (invariant-phrase lint
// added in PR4 refine M5). The smoke trace in the compose Phase 2
// workflow phase note documents the expected rendered output as
// authoritative reference.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SCRIPT = resolve(REPO_ROOT, "plugins", "engineer", "scripts", "decide-registry.mjs");

function run(args) {
  return spawnSync(process.execPath, [SCRIPT, "resolve", ...args], { encoding: "utf8" });
}

// =====================
// Matrix row 1 — no flags (backward-compat invariant)
// =====================

test("[matrix] no flags → context.weights === {} (uniform sentinel preserved)", () => {
  const r = run([]);
  assert.equal(r.status, 0);
  assert.equal(r.stderr, "");
  const ctx = JSON.parse(r.stdout);
  assert.equal(ctx.preset_id, "default");
  assert.equal(ctx.size, "standard");
  assert.equal(ctx.size_explicit, false);
  assert.deepEqual(ctx.weights, {}, "weights MUST stay {} when no --weights flag — backward-compat invariant");
  assert.equal(ctx.axes.length, 5);
});

// =====================
// Matrix row 2 — --weights only (standard ritual + weights populated)
// =====================

test("[matrix] --weights=essence:3 only → context.weights filled, size=standard preserved", () => {
  const r = run(["--weights=essence:3"]);
  assert.equal(r.status, 0);
  const ctx = JSON.parse(r.stdout);
  assert.equal(ctx.preset_id, "default");
  assert.equal(ctx.size, "standard");
  assert.equal(ctx.weights.essence, 3);
  assert.equal(ctx.weights.foundation, 1);
  assert.equal(Object.keys(ctx.weights).length, 5);
});

// =====================
// Matrix row 3 — --size=major only (sensitivity auto-enable threshold, weights {} sentinel)
// =====================

test("[matrix] --size=major only → preset=nine-axis, weights={}, size_explicit=true", () => {
  const r = run(["--size=major"]);
  assert.equal(r.status, 0);
  const ctx = JSON.parse(r.stdout);
  assert.equal(ctx.preset_id, "nine-axis");
  assert.equal(ctx.size, "major");
  assert.equal(ctx.size_explicit, true);
  // No --weights flag → sentinel preserved (sensitivity module will
  // expand to uniform 1.0 internally during perturbation)
  assert.deepEqual(ctx.weights, {});
  assert.equal(ctx.axes.length, 9);
});

// =====================
// Matrix row 4 — both --weights + --size=major (full opt-in path)
// =====================

test("[matrix] --weights + --size=major → all PR4 fields populated", () => {
  const r = run(["--size=major", "--weights=essence:3,foundation:2"]);
  assert.equal(r.status, 0);
  const ctx = JSON.parse(r.stdout);
  assert.equal(ctx.preset_id, "nine-axis");
  assert.equal(ctx.size, "major");
  assert.equal(ctx.size_explicit, true);
  assert.equal(Object.keys(ctx.weights).length, 9);
  assert.equal(ctx.weights.essence, 3);
  assert.equal(ctx.weights.foundation, 2);
  // Other 7 axes filled with uniform 1.0
  assert.equal(ctx.weights.standards, 1);
  assert.equal(ctx.weights.recommendation, 1);
});

// =====================
// Matrix row 5 — --weights + fallback path (peer G5 invariant)
// =====================

test("[matrix peer G5] --weights + unknown --preset → fallback default + weights normalized over fallback axes", () => {
  const r = run(["--preset=nonexistent", "--weights=essence:5"]);
  assert.equal(r.status, 0);
  // stderr carries the unknown-preset diagnostic
  assert.ok(/unknown preset id "nonexistent"/.test(r.stderr),
    `expected fallback diagnostic; got: ${r.stderr}`);
  const ctx = JSON.parse(r.stdout);
  assert.equal(ctx.preset_id, "default", "fallback to in-code default per ADR §1.6");
  // Weights still normalized — peer G5 invariant
  assert.equal(ctx.weights.essence, 5);
  assert.equal(ctx.weights.foundation, 1);
  assert.equal(Object.keys(ctx.weights).length, 5);
});

// =====================
// Matrix row 6 — malformed --weights → exit 2 (halt)
// =====================

test("[matrix] --weights=essence:NaN → exit 2 (parser halt, no stdout context)", () => {
  const r = run(["--weights=essence:NaN"]);
  assert.equal(r.status, 2);
  // Stderr carries the parser error
  assert.ok(/--weights/.test(r.stderr) || /invalid/i.test(r.stderr),
    `expected --weights validation error; got: ${r.stderr}`);
});

test("[matrix] --weights=essence:1,essence:2 (duplicate axis) → exit 2", () => {
  const r = run(["--weights=essence:1,essence:2"]);
  assert.equal(r.status, 2);
  assert.ok(/duplicate|dup/i.test(r.stderr),
    `expected duplicate-axis error; got: ${r.stderr}`);
});

// =====================
// Matrix row 7 — --weights + body propagation through -- separator
// =====================

test("[matrix] --weights=essence:2 -- 'compare X and Y' → body threaded into context.body", () => {
  const r = run(["--weights=essence:2", "--", "compare", "X", "and", "Y"]);
  assert.equal(r.status, 0);
  const ctx = JSON.parse(r.stdout);
  assert.equal(ctx.body, "compare X and Y");
  assert.equal(ctx.weights.essence, 2);
  assert.equal(ctx.weights.foundation, 1);
});

// =====================
// Backward-compat regression assertions (peer (h) gate)
// =====================

test("[backward-compat] default invocation produces structurally identical context to pre-PR4 (modulo weights={} + weights_explicit + registry_fallback)", () => {
  // The pre-PR4 baseline emitted context.weights = {} (reserved slot).
  // PR4 must preserve this for the no-flags case so any pre-PR4 consumer
  // continues to parse the JSON without change. PR4 refine M1 also adds
  // `weights_explicit` (additive) which the LLM gate consumes; this is an
  // ADR §5.6 amendment, not a removal of any pre-PR4 field. PR5 adds
  // `registry_fallback` (additive) per the §5.6 PR5 amendment so the
  // §4.3 axis_awareness presence rule can be enforced. The 9-field exact
  // schema lock-down lives in tests/engineer/test-decide-registry.mjs at
  // the test labeled `PR5 §5.6 schema: registry_fallback is exactly the
  // 9th canonical field` — extend that test if the field set evolves.
  const r = run([]);
  assert.equal(r.status, 0);
  const ctx = JSON.parse(r.stdout);
  // ADR-0027 §5.6 invariant fields all present (plus PR4 refine M1's weights_explicit + PR5 amendment's registry_fallback)
  const requiredFields = ["body", "preset_id", "axes", "size", "size_explicit", "weights", "weights_explicit", "resolved_at", "registry_fallback"];
  for (const f of requiredFields) {
    assert.ok(f in ctx, `pre-PR4 baseline field "${f}" must remain in context`);
  }
  // Backward-compat: weights stays the empty sentinel
  assert.deepEqual(ctx.weights, {});
  // PR4 refine M1: weights_explicit=false on the no-flags path (mirrors size_explicit=false default)
  assert.equal(ctx.weights_explicit, false);
  // PR5 amendment: registry_fallback=false on a healthy registry load (no §1.6 fallback)
  assert.equal(ctx.registry_fallback, false);
  // Backward-compat: size defaults to standard with size_explicit=false
  assert.equal(ctx.size, "standard");
  assert.equal(ctx.size_explicit, false);
});

test("[backward-compat] --preset=nine-axis without --weights → weights={} preserved", () => {
  // Pre-PR4 callers that pass --preset only must NOT see weights populated.
  // Only explicit --weights= triggers normalization.
  const r = run(["--preset=nine-axis"]);
  assert.equal(r.status, 0);
  const ctx = JSON.parse(r.stdout);
  assert.equal(ctx.preset_id, "nine-axis");
  assert.deepEqual(ctx.weights, {});
});

test("[backward-compat] --size=standard explicit → weights={} preserved (no implicit expansion)", () => {
  // --size=standard does not auto-enable sensitivity; weights stays sentinel.
  const r = run(["--size=standard"]);
  assert.equal(r.status, 0);
  const ctx = JSON.parse(r.stdout);
  assert.equal(ctx.size, "standard");
  assert.equal(ctx.size_explicit, true);
  assert.deepEqual(ctx.weights, {});
});

// =====================
// Integration cross-check — all 3 PR4 modules wire together
// =====================

test("[integration] full pipeline: args parser → registry resolver → normalized context", () => {
  // Single invocation exercising decide-args (parser), decide-weights
  // (normalizer), decide-registry (resolver) end-to-end. If any module
  // wiring breaks, this test fails before the matrix tests above.
  const r = run([
    "--preset=nine-axis",
    "--size=major",
    "--weights=essence:3,foundation:2,practical-fit:0.5",
    "--",
    "test",
    "body",
  ]);
  assert.equal(r.status, 0);
  const ctx = JSON.parse(r.stdout);
  assert.equal(ctx.preset_id, "nine-axis");
  assert.equal(ctx.size, "major");
  assert.equal(ctx.size_explicit, true);
  assert.equal(ctx.body, "test body");
  assert.equal(ctx.weights.essence, 3);
  assert.equal(ctx.weights.foundation, 2);
  assert.equal(ctx.weights["practical-fit"], 0.5);
  // All 9 axes present + document order preserved
  assert.deepEqual(Object.keys(ctx.weights), [
    "standards", "recommendation", "canonical-precedent",
    "essence", "foundation",
    "extensibility", "maintainability", "maturation", "practical-fit",
  ]);
});
