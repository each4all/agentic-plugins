// Tests for plugins/engineer/scripts/lib/decide-args.mjs —
// argument-parser skeleton (ADR-0027 §2.3 + §2.7).

import { test } from "node:test";
import { strict as assert } from "node:assert";

import { parseArgs } from "../../plugins/engineer/scripts/lib/decide-args.mjs";

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

test("§2.5/§2.6 partial: --size warning distinguishes active preset implication (PR2) from deferred ritual sizing (PR3)", () => {
  const r = parseArgs(["--size=major", "body"]);
  assert.equal(r.flags.size, "major");
  assert.ok(r.warnings.some((w) => /preset implication.*active.*ritual-sizing.*deferred to PR3/.test(w)),
    `unexpected warning text: ${r.warnings.join(" | ")}`);
  // No error — accepted gracefully.
  assert.deepEqual(r.errors, []);
});

test("§2.5/§2.6 stub: --weights deferred to PR4", () => {
  const r = parseArgs(["--weights=essence:2,foundation:1", "body"]);
  assert.equal(r.flags.weights, "essence:2,foundation:1");
  assert.ok(r.warnings.some((w) => /--weights .*deferred to PR4/.test(w)));
  assert.deepEqual(r.errors, []);
});

test("combined: --preset + --size + --weights + body", () => {
  const r = parseArgs([
    "--preset=nine-axis",
    "--size=major",
    "--weights=essence:2",
    "compare", "options", "for", "X",
  ]);
  assert.equal(r.flags.preset, "nine-axis");
  assert.equal(r.flags.size, "major");
  assert.equal(r.flags.weights, "essence:2");
  assert.equal(r.body, "compare options for X");
  // Two warnings expected (size + weights).
  assert.equal(r.warnings.filter((w) => /deferred to PR[34]|active in PR2/.test(w)).length, 2);
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
