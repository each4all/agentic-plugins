// Tests for plugins/founder/scripts/decide-registry.mjs — the founder:decide
// registry reader (ADR-0036 SD3 business decision axes on the ADR-0027
// portable registry schema, copied + adapted from engineer per ADR-0029).
//
// Scope: this suite exercises the founder-LOCAL divergences — the real
// business registry (default + compact presets, the two decisive axes,
// the gate-style veto axes), the founder size→preset map (no nine-axis
// tier), the in-code DEFAULT_FALLBACK business axes, and the `gate` flag's
// yaml-mini string-coercion handling + validation. The shared §1.6
// graceful-degradation resolver logic itself is exercised in depth by the
// engineer suite this reader was copied from; here we confirm a
// representative slice still holds against founder's real file + axis set.
//
// Run via `node --test tests/founder/test-decide-registry.mjs`.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import { loadRegistry, resolvePreset } from "../../plugins/founder/scripts/decide-registry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const SCRIPT = resolve(REPO_ROOT, "plugins", "founder", "scripts", "decide-registry.mjs");

const DECISIVE = ["market-attractiveness", "unit-economics"];
const GATES = ["regulatory-exposure", "safety-risk"];

function writeRegistry(body) {
  const dir = mkdtempSync(join(tmpdir(), "founder-decide-registry-"));
  const path = join(dir, "decision-axes.yml");
  writeFileSync(path, body, "utf8");
  return { dir, path };
}

// ---------- Real founder registry (business axes) ----------

test("loadRegistry: real founder registry loads cleanly with default + compact presets", () => {
  const { registry, diagnostics, fallbackTriggered } = loadRegistry({});
  assert.equal(fallbackTriggered, false);
  assert.deepEqual(diagnostics, []);
  assert.ok(registry);
  assert.deepEqual(Object.keys(registry.presets).sort(), ["compact", "default"]);
});

test("default preset is the 6-axis business matrix in document order", () => {
  const { registry } = loadRegistry({});
  const ids = registry.presets.default.axes.map((a) => a.id);
  assert.deepEqual(ids, [
    "market-attractiveness", "unit-economics",
    "willingness-to-pay", "competitive-intensity",
    "regulatory-exposure", "safety-risk",
  ]);
});

test("default preset carries ko labels for every business axis", () => {
  const { registry } = loadRegistry({});
  const ko = Object.fromEntries(registry.presets.default.axes.map((a) => [a.id, a.labels.ko]));
  assert.equal(ko["market-attractiveness"], "시장성");
  assert.equal(ko["unit-economics"], "단위경제");
  assert.equal(ko["willingness-to-pay"], "지불의사");
  assert.equal(ko["competitive-intensity"], "경쟁강도");
  assert.equal(ko["regulatory-exposure"], "규제노출");
  assert.equal(ko["safety-risk"], "안전리스크");
});

// decisive 불변식 (ADR-0036 SD3 / ADR-0027 §1.3)
test("§1.3 invariant: every founder preset declares exactly the two decisive business axes", () => {
  const { registry } = loadRegistry({});
  for (const pid of Object.keys(registry.presets)) {
    const decisive = registry.presets[pid].axes.filter((a) => a.role === "decisive").map((a) => a.id).sort();
    assert.ok(decisive.length >= 2, `preset ${pid} must declare >= 2 decisive axes`);
    assert.deepEqual(decisive, DECISIVE, `preset ${pid} decisive axes must be the two business decisive axes`);
  }
});

// gate field — founder-new, with yaml-mini string-coercion handled
test("gate-style axes carry gate:true as a real boolean; non-gate axes gate:false", () => {
  const { registry } = loadRegistry({});
  for (const pid of Object.keys(registry.presets)) {
    for (const a of registry.presets[pid].axes) {
      assert.equal(typeof a.gate, "boolean", `${pid}.${a.id} gate must be a real boolean (yaml-mini coerces scalars to strings)`);
      const expected = GATES.includes(a.id);
      assert.equal(a.gate, expected, `${pid}.${a.id} gate=${a.gate}, expected ${expected}`);
    }
  }
});

test("compact preset is the 4-axis quick set: two decisive + the two gates (no soft supporting axes)", () => {
  const { registry } = loadRegistry({});
  const ids = registry.presets.compact.axes.map((a) => a.id);
  assert.deepEqual(ids, ["market-attractiveness", "unit-economics", "regulatory-exposure", "safety-risk"]);
  const gates = registry.presets.compact.axes.filter((a) => a.gate).map((a) => a.id);
  assert.deepEqual(gates, GATES, "a minor decision must still clear regulatory + safety gates");
});

// ---------- size → preset map (founder has no nine-axis tier) ----------

test("size map: minor→compact, standard→default, major→default (no nine-axis tier)", () => {
  assert.equal(resolvePreset({ sizeExplicit: true, sizeValue: "minor" }).context.preset_id, "compact");
  assert.equal(resolvePreset({ sizeExplicit: true, sizeValue: "standard" }).context.preset_id, "default");
  const major = resolvePreset({ sizeExplicit: true, sizeValue: "major" });
  assert.equal(major.context.preset_id, "default");
  assert.equal(major.context.registry_fallback, false);
  assert.ok(
    !major.diagnostics.some((d) => /nine-axis/.test(d)),
    `major must not emit a nine-axis-missing diagnostic for founder; got: ${JSON.stringify(major.diagnostics)}`,
  );
});

test("explicit --preset wins over --size; gate flag survives onto the resolved context", () => {
  const { context } = resolvePreset({ presetId: "compact", sizeExplicit: true, sizeValue: "standard" });
  assert.equal(context.preset_id, "compact");
  assert.equal(context.size, "standard"); // size retained on context even though preset won
  const reg = context.axes.find((a) => a.id === "regulatory-exposure");
  assert.equal(reg.gate, true);
});

// ---------- in-code DEFAULT_FALLBACK is the business default ----------

test("ENOENT registry → in-code fallback is the founder business default (not engineer software axes)", () => {
  const { context, fallbackTriggered } = resolvePreset({ path: "/nonexistent/decision-axes.yml" });
  assert.equal(fallbackTriggered, true);
  assert.equal(context.preset_id, "default");
  const ids = context.axes.map((a) => a.id);
  assert.deepEqual(ids, [
    "market-attractiveness", "unit-economics",
    "willingness-to-pay", "competitive-intensity",
    "regulatory-exposure", "safety-risk",
  ]);
  const decisive = context.axes.filter((a) => a.role === "decisive").map((a) => a.id).sort();
  assert.deepEqual(decisive, DECISIVE);
  // fallback axes also carry real-boolean gate flags so context shape matches the registry path
  assert.equal(context.axes.find((a) => a.id === "regulatory-exposure").gate, true);
  assert.equal(context.axes.find((a) => a.id === "safety-risk").gate, true);
  assert.equal(context.axes.find((a) => a.id === "market-attractiveness").gate, false);
});

// ---------- gate validation + representative §1.6 failure modes ----------

const MIN_VALID = `schema: "1.0"
presets:
  default:
    axes:
      - id: "market-attractiveness"
        labels:
          en: "Market Attractiveness"
          ko: "시장성"
        question: "Is there a market?"
        role: "decisive"
      - id: "unit-economics"
        labels:
          en: "Unit Economics"
          ko: "단위경제"
        question: "Do the unit economics work?"
        role: "decisive"
      - id: "regulatory-exposure"
        labels:
          en: "Regulatory Exposure"
          ko: "규제노출"
        question: "Does it clear regulation?"
        role: "supporting"
        gate: true
`;

test("a synthetic registry with gate: true (string-coerced by yaml-mini) maps to boolean true", () => {
  const { path, dir } = writeRegistry(MIN_VALID);
  try {
    const { registry, fallbackTriggered } = loadRegistry({ path });
    assert.equal(fallbackTriggered, false);
    const reg = registry.presets.default.axes.find((a) => a.id === "regulatory-exposure");
    assert.equal(reg.gate, true);
    assert.equal(typeof reg.gate, "boolean");
    const market = registry.presets.default.axes.find((a) => a.id === "market-attractiveness");
    assert.equal(market.gate, false, "axes without an explicit gate default to false");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("malformed gate value (not true/false) skips the preset and falls back", () => {
  const body = MIN_VALID.replace("gate: true", 'gate: "maybe"');
  const { path, dir } = writeRegistry(body);
  try {
    const { registry, diagnostics, fallbackTriggered } = loadRegistry({ path });
    assert.equal(fallbackTriggered, true);
    assert.equal(registry, null);
    assert.ok(
      diagnostics.some((d) => /gate must be true or false/.test(d)),
      `expected a gate-validation diagnostic; got: ${JSON.stringify(diagnostics)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a preset with fewer than 2 decisive axes is skipped (§1.3 invariant)", () => {
  const body = MIN_VALID.replace('role: "decisive"\n      - id: "unit-economics"', 'role: "supporting"\n      - id: "unit-economics"')
    .replace('question: "Do the unit economics work?"\n        role: "decisive"', 'question: "Do the unit economics work?"\n        role: "supporting"');
  const { path, dir } = writeRegistry(body);
  try {
    const { diagnostics, fallbackTriggered } = loadRegistry({ path });
    assert.equal(fallbackTriggered, true);
    assert.ok(
      diagnostics.some((d) => /decisive-axis count|must be >= 2/.test(d)),
      `expected a decisive-count diagnostic; got: ${JSON.stringify(diagnostics)}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("unknown --preset id falls back to default with a diagnostic (graceful degradation)", () => {
  const { context, diagnostics, fallbackTriggered } = resolvePreset({ presetId: "made-up-preset" });
  assert.equal(fallbackTriggered, true);
  assert.equal(context.preset_id, "default");
  assert.ok(diagnostics.some((d) => /unknown preset id "made-up-preset"/.test(d)));
});

test("schema !== \"1.0\" falls back", () => {
  const { path, dir } = writeRegistry(MIN_VALID.replace('schema: "1.0"', 'schema: "9.9"'));
  try {
    const { fallbackTriggered, diagnostics } = loadRegistry({ path });
    assert.equal(fallbackTriggered, true);
    assert.ok(diagnostics.some((d) => /schema is "9.9"/.test(d)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- weights threading over business axes ----------

test("--weights threads normalized per-axis weights over the business axes; unmentioned axes fill to 1.0", () => {
  const { context } = resolvePreset({ weights: "market-attractiveness:3", weightsExplicit: true });
  assert.equal(context.weights["market-attractiveness"], 3);
  assert.equal(context.weights["unit-economics"], 1);
  assert.equal(context.weights["safety-risk"], 1);
  assert.equal(context.weights_explicit, true);
});

test("--weights over the compact preset normalizes across exactly the 4 compact axes (founder weight ordering)", () => {
  const { context } = resolvePreset({
    presetId: "compact",
    weights: "unit-economics:2,regulatory-exposure:0",
    weightsExplicit: true,
  });
  assert.equal(context.preset_id, "compact");
  assert.deepEqual(
    Object.keys(context.weights).sort(),
    ["market-attractiveness", "regulatory-exposure", "safety-risk", "unit-economics"],
    "compact weights map covers exactly the 4 compact axes, not the 6-axis default",
  );
  assert.equal(context.weights["unit-economics"], 2);
  assert.equal(context.weights["regulatory-exposure"], 0); // a zero-weight gate axis is allowed
  assert.equal(context.weights["market-attractiveness"], 1); // unmentioned → 1.0
});

test("--weights naming an axis absent from the compact preset drops it with a diagnostic", () => {
  const { context, diagnostics } = resolvePreset({
    presetId: "compact",
    weights: "willingness-to-pay:3", // present in default, ABSENT in compact
    weightsExplicit: true,
  });
  assert.equal(context.preset_id, "compact");
  assert.ok(
    !Object.hasOwn(context.weights, "willingness-to-pay"),
    "willingness-to-pay is not a compact axis → must be dropped",
  );
  assert.ok(
    diagnostics.some((d) => /willingness-to-pay.*not in resolved preset|dropped/.test(d)),
    `expected a drop diagnostic; got ${JSON.stringify(diagnostics)}`,
  );
});

test("no --weights → empty sentinel map + weights_explicit false (backward-compat)", () => {
  const { context } = resolvePreset({ body: "x" });
  assert.deepEqual(context.weights, {});
  assert.equal(context.weights_explicit, false);
});

// ---------- CLI surface ----------

test("CLI: resolve (default) → 6 business axes JSON on stdout, exit 0", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "resolve", "--", "subscription pet-supply box"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.preset_id, "default");
  assert.equal(parsed.axes.length, 6);
  assert.equal(parsed.body, "subscription pet-supply box");
});

test("CLI: resolve --size=minor → compact (4 axes)", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "resolve", "--size=minor", "--", "x"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.preset_id, "compact");
  assert.equal(parsed.axes.length, 4);
});

test("CLI: invalid flag → exit 2 (parser halt)", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "resolve", "--bogus=1"], { encoding: "utf8" });
  assert.equal(r.status, 2);
});
