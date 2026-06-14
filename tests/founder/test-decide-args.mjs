// Tests for plugins/founder/scripts/lib/decide-args.mjs —
// argument-parser skeleton (ADR-0027 §2.3 + §2.7).

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { parseArgs } from "../../plugins/founder/scripts/lib/decide-args.mjs";

test("happy: no flags, body only", () => {
  const r = parseArgs(["which", "approach", "for", "auth"]);
  assert.deepEqual(r.flags, {});
  assert.equal(r.body, "which approach for auth");
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
});

test("§2.3(1): flags must precede body", () => {
  const r = parseArgs(["--preset=nine-axis", "should", "we", "use", "X?"]);
  assert.equal(r.flags.preset, "nine-axis");
  assert.equal(r.body, "should we use X?");
  assert.deepEqual(r.errors, []);
});

test("§2.3(1): tokens after body — even flag-looking — are body content", () => {
  const r = parseArgs(["--preset=default", "compare", "--foo=bar", "and", "--baz=qux"]);
  assert.equal(r.flags.preset, "default");
  assert.equal(r.body, "compare --foo=bar and --baz=qux");
  assert.deepEqual(r.errors, []);
});

test("§2.3(2): --key value (space-separated) is NOT supported — value goes into body", () => {
  // Per §2.3(2), only --key=value. `--preset value` tokenizes as two
  // tokens; the second is unrecognized as a flag (no `=`).
  const r = parseArgs(["--preset", "default"]);
  // "--preset" without `=` is malformed; error + halt.
  assert.notEqual(r.errors.length, 0);
  assert.ok(r.errors[0].includes("--key=value form"));
});

test("§2.3(3): unknown flag → error + halt", () => {
  const r = parseArgs(["--bogus=value", "rest", "of", "body"]);
  assert.notEqual(r.errors.length, 0);
  assert.ok(r.errors[0].includes("unknown flag"));
  // halt → body not populated
  assert.equal(r.body, "");
});

test("§2.3(4) shape: --size=invalid → error + halt (whitelist enforced)", () => {
  const r = parseArgs(["--size=huge", "body"]);
  assert.notEqual(r.errors.length, 0);
  assert.ok(r.errors[0].includes("not in {minor, standard, major}"));
});

test("§2.3(4): --preset=<id> shape passes; reader does semantic validation", () => {
  // Even "weird-but-shape-valid" preset names go through; the registry
  // reader handles unknown ids with graceful-degradation fallback.
  const r = parseArgs(["--preset=experimental-1", "body"]);
  assert.equal(r.flags.preset, "experimental-1");
  assert.deepEqual(r.errors, []);
});

test("§2.3(5): repeated flag last-wins + warning", () => {
  const r = parseArgs(["--preset=default", "--preset=nine-axis", "body"]);
  assert.equal(r.flags.preset, "nine-axis");
  assert.equal(r.warnings.length >= 1, true);
  assert.ok(r.warnings.some((w) => /--preset appeared 2 times/.test(w)));
});

test("§2.3(6): -- hard separator — body begins after --", () => {
  const r = parseArgs(["--preset=default", "--", "--size=major", "in", "CSS?"]);
  assert.equal(r.flags.preset, "default");
  // size flag after -- is body content, NOT a flag
  assert.equal(r.flags.size, undefined);
  assert.equal(r.body, "--size=major in CSS?");
});

test("§1.5(2) + ADR-0027 PR3: --size is fully active — accepted without a deferred-to-PR3 warning", () => {
  const r = parseArgs(["--size=major", "body"]);
  assert.equal(r.flags.size, "major");
  // PR3 wires ritual sizing in SKILL.md; the parser no longer needs to
  // warn that ritual sizing is deferred. The only --size warnings that
  // may fire now are repeat-flag last-wins, which is not the case here.
  assert.ok(
    !r.warnings.some((w) => /deferred to PR3|ritual-sizing.*deferred/.test(w)),
    `expected no 'deferred to PR3' warning; got: ${r.warnings.join(" | ")}`,
  );
  // No error — accepted gracefully.
  assert.deepEqual(r.errors, []);
});

test("§2.3(5) [peer ADR-0027 PR3 edge case #4]: repeated --size last-wins + warning", () => {
  const r = parseArgs(["--size=minor", "--size=major", "body"]);
  assert.equal(r.flags.size, "major");
  assert.ok(
    r.warnings.some((w) => /--size appeared 2 times/.test(w)),
    `expected repeat-flag warning; got: ${r.warnings.join(" | ")}`,
  );
  assert.deepEqual(r.errors, []);
});

// ─── ADR-0027 PR4 weights parser (active, no longer stub) ──────────

test("PR4 GREEN: --weights=essence:2,foundation:1 accepted; flags.weightsExplicit=true; no deferred warning", () => {
  const r = parseArgs(["--weights=essence:2,foundation:1", "body"]);
  assert.equal(r.flags.weights, "essence:2,foundation:1");
  assert.equal(r.weightsExplicit, true);
  assert.ok(
    !r.warnings.some((w) => /deferred to PR4/.test(w)),
    `expected no deferred-to-PR4 warning; got: ${r.warnings.join(" | ")}`,
  );
  assert.deepEqual(r.errors, []);
});

test("PR4 GREEN: --weights absent → weightsExplicit is false (top-level result field)", () => {
  const r = parseArgs(["compare", "X", "and", "Y"]);
  // explicit-flag presence — peer G3 fix (avoid `weights !== {}` object-identity bug)
  // weightsExplicit is a top-level result field so flags.deepEqual({}) tests stay clean.
  assert.equal(r.weightsExplicit, false);
  assert.equal(r.flags.weights, undefined);
});

test("PR4 GREEN: --weights=essence:2.5,foundation:1 decimal accepted", () => {
  const r = parseArgs(["--weights=essence:2.5,foundation:1", "body"]);
  assert.equal(r.flags.weights, "essence:2.5,foundation:1");
  assert.equal(r.weightsExplicit, true);
  assert.deepEqual(r.errors, []);
});

test("PR4 GREEN: --weights=essence:0 zero weight allowed", () => {
  const r = parseArgs(["--weights=essence:0", "body"]);
  assert.equal(r.flags.weights, "essence:0");
  assert.deepEqual(r.errors, []);
});

test("PR4 GREEN: --weights=essence:3 single pair accepted", () => {
  const r = parseArgs(["--weights=essence:3"]);
  assert.equal(r.flags.weights, "essence:3");
  assert.deepEqual(r.errors, []);
});

test("PR4 RED: --weights= (empty spec) → halt", () => {
  const r = parseArgs(["--weights="]);
  assert.notEqual(r.errors.length, 0, "expected error for empty --weights=");
  assert.ok(/--weights/.test(r.errors[0]), `unexpected diagnostic: ${r.errors[0]}`);
});

test("PR4 RED: --weights=essence (missing colon) → halt", () => {
  const r = parseArgs(["--weights=essence"]);
  assert.notEqual(r.errors.length, 0);
  assert.ok(/--weights/.test(r.errors[0]));
});

test("PR4 RED: --weights=essence:abc (non-numeric weight) → halt", () => {
  const r = parseArgs(["--weights=essence:abc"]);
  assert.notEqual(r.errors.length, 0);
});

test("PR4 RED: --weights=essence:-1 (negative weight) → halt", () => {
  const r = parseArgs(["--weights=essence:-1"]);
  assert.notEqual(r.errors.length, 0);
});

test("PR4 RED: --weights=essence:NaN → halt", () => {
  const r = parseArgs(["--weights=essence:NaN"]);
  assert.notEqual(r.errors.length, 0);
});

test("PR4 RED: --weights=essence:Infinity → halt", () => {
  const r = parseArgs(["--weights=essence:Infinity"]);
  assert.notEqual(r.errors.length, 0);
});

test("PR4 RED: --weights=essence:1e3 (exponent notation) → halt — finite decimal only per peer G6", () => {
  const r = parseArgs(["--weights=essence:1e3"]);
  assert.notEqual(r.errors.length, 0);
});

test("PR4 RED: --weights=Essence:1 (uppercase axis-id) → halt — registry axis-id shape [a-z][a-z0-9-]*", () => {
  const r = parseArgs(["--weights=Essence:1"]);
  assert.notEqual(r.errors.length, 0);
});

test("PR4 RED: --weights= essence:1 (leading whitespace in value) → halt per peer G6", () => {
  // Single token whose value begins with a space — token shape valid;
  // value content has whitespace, which the strict grammar rejects.
  const r = parseArgs(["--weights= essence:1"]);
  assert.notEqual(r.errors.length, 0);
});

test("PR4 RED: --weights=essence:1,essence:2 (duplicate axis within spec) → halt per peer (b)", () => {
  const r = parseArgs(["--weights=essence:1,essence:2"]);
  assert.notEqual(r.errors.length, 0);
  assert.ok(/duplicate|dup/i.test(r.errors[0]), `expected duplicate diagnostic; got: ${r.errors[0]}`);
});

test("PR4 RED: --weights=,essence:1 (leading comma) → halt", () => {
  const r = parseArgs(["--weights=,essence:1"]);
  assert.notEqual(r.errors.length, 0);
});

test("PR4 RED: --weights=essence:1, (trailing comma) → halt", () => {
  const r = parseArgs(["--weights=essence:1,"]);
  assert.notEqual(r.errors.length, 0);
});

test("PR4 edge (a): -- --weights=bad → body, NOT parsed as flag", () => {
  const r = parseArgs(["--", "--weights=bad"]);
  // After `--` separator, everything is body — even bogus weights syntax
  assert.deepEqual(r.errors, [], `expected no errors; got: ${r.errors.join(" | ")}`);
  assert.equal(r.body, "--weights=bad");
  assert.equal(r.flags.weights, undefined);
  assert.equal(r.weightsExplicit, false);
});

test("PR4 edge (a): compare --weights=bad → body, NOT parsed as flag (first non-flag starts body)", () => {
  const r = parseArgs(["compare", "--weights=bad"]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.body, "compare --weights=bad");
  assert.equal(r.flags.weights, undefined);
  assert.equal(r.weightsExplicit, false);
});

test("PR4 edge (b): --weights=a:1 --weights=b:2 → last-wins + warning per :83-87", () => {
  const r = parseArgs(["--weights=essence:1", "--weights=foundation:2", "body"]);
  assert.equal(r.flags.weights, "foundation:2");
  assert.equal(r.weightsExplicit, true);
  assert.ok(
    r.warnings.some((w) => /--weights appeared 2 times/.test(w)),
    `expected repeat warning; got: ${r.warnings.join(" | ")}`,
  );
  assert.deepEqual(r.errors, []);
});

test("PR4 combined: --preset + --size + --weights + body — all active, NO deferred warning", () => {
  const r = parseArgs([
    "--preset=nine-axis",
    "--size=major",
    "--weights=essence:2",
    "compare", "options", "for", "X",
  ]);
  assert.equal(r.flags.preset, "nine-axis");
  assert.equal(r.flags.size, "major");
  assert.equal(r.flags.weights, "essence:2");
  assert.equal(r.weightsExplicit, true);
  assert.equal(r.body, "compare options for X");
  // Both --size and --weights are now active; no deferred warnings expected.
  assert.equal(
    r.warnings.filter((w) => /deferred to (PR3|PR4)/.test(w)).length,
    0,
    `expected zero deferred warnings; got: ${r.warnings.join(" | ")}`,
  );
});

test("malformed flag (--= or --key with no value) → error", () => {
  const r1 = parseArgs(["--=value"]);
  assert.notEqual(r1.errors.length, 0);
  const r2 = parseArgs(["--preset"]);
  assert.notEqual(r2.errors.length, 0);
});

test("empty argv → empty result", () => {
  const r = parseArgs([]);
  assert.deepEqual(r.flags, {});
  assert.equal(r.body, "");
  assert.deepEqual(r.errors, []);
});

test("type guard: non-array argv throws", () => {
  assert.throws(() => parseArgs("string"), /expects an array/);
  assert.throws(() => parseArgs(null), /expects an array/);
});
